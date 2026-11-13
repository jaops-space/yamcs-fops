//! `fops runner`: runs the workers of a Yamcs plugin in another container or
//! host (docs/remote-workers.md).
//!
//! It connects to the plugin (`<yamcs>/fops-runner/connect`, a WebSocket of
//! JSON messages), and for each `start` runs `fops run` as the plugin would:
//! from a snapshot of the instance's procedures (files fetched by content from
//! `<yamcs>/fops-runner/blobs/...`), its stdout relayed as numbered events,
//! its as-run journal and stderr as byte ranges. The plugin can resume both
//! after a reconnection. Cut off from the plugin for longer than the grace
//! period, it closes its workers' stdin: they abort, as a local worker does
//! when Yamcs goes.
//!
//! Threads: main (the connection), one tailer for the files, a janitor
//! (supervision loss, cleanup), and per worker one stdout reader that also
//! waits for its end. Starts and inspections get a thread each.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use crossbeam_channel::{Receiver, Sender, TryRecvError};
use parking_lot::Mutex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::worker::parse_size;

const READ_TIMEOUT: Duration = Duration::from_millis(50);
const PING_EVERY: Duration = Duration::from_secs(10);
const SILENCE: Duration = Duration::from_secs(30);
/// Events kept for a resend after a reconnection.
const RING: usize = 50_000;
/// A longer event line is replaced by an error log event.
const MAX_LINE: usize = 1 << 20;
/// Bytes of a file per message.
const CHUNK: u64 = 256 << 10;
const INSPECT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, clap::Args)]
pub struct RunnerArgs {
    /// The Yamcs server of the plugin, e.g. http://yamcs:8090 (with its context path, if any).
    #[arg(long = "yamcs", env = "FOPS_YAMCS_URL")]
    pub url: String,
    /// The Yamcs URL the workers use; default: --yamcs.
    #[arg(long)]
    pub worker_yamcs: Option<String>,
    /// This runner's name; default: the host name.
    #[arg(long)]
    pub name: Option<String>,
    /// Workers running at most at once.
    #[arg(long, default_value_t = 4)]
    pub capacity: usize,
    /// --memory-limit of each worker, e.g. 512M.
    #[arg(long, value_parser = parse_size)]
    pub worker_memory: Option<u64>,
    /// Working directory: blob cache, snapshots, journals.
    #[arg(long, default_value = "fops-runner")]
    pub data: PathBuf,
    /// Seconds without the plugin before the workers are aborted.
    #[arg(long, default_value_t = 30)]
    pub grace: u64,
    /// The fops binary of the workers; default: this one.
    #[arg(long)]
    pub executable: Option<PathBuf>,
    /// Yamcs service account (client credentials).
    #[arg(long, env = "FOPS_RUNNER_CLIENT_ID")]
    pub client_id: Option<String>,
    #[arg(long, requires = "client_id")]
    pub client_secret_file: Option<PathBuf>,
    /// Yamcs user (password login), instead of a service account.
    #[arg(long, env = "FOPS_RUNNER_USER", conflicts_with = "client_id")]
    pub user: Option<String>,
    #[arg(long, requires = "user")]
    pub password_file: Option<PathBuf>,
}

struct Runner {
    args: RunnerArgs,
    base: String,
    name: String,
    exe: PathBuf,
    http: reqwest::blocking::Client,
    token: Mutex<Option<String>>,
    /// The current connection's outgoing messages; None while disconnected.
    out: Mutex<Option<Sender<String>>>,
    execs: Mutex<HashMap<String, Arc<Exec>>>,
    /// Snapshot directories, and how many workers use them.
    snapshots: Mutex<HashMap<PathBuf, (usize, Instant)>>,
    building: Mutex<()>,
    draining: AtomicBool,
    /// The cgroup's oom_kill count last seen.
    oom_kills: AtomicU64,
}

struct Exec {
    x: String,
    dir: PathBuf,
    snapshot: PathBuf,
    pid: i32,
    st: Mutex<ExecState>,
}

struct ExecState {
    stdin: Option<ChildStdin>,
    /// The latest events, (n, line).
    ring: VecDeque<(u64, String)>,
    n: u64,
    /// The plugin has everything up to here and gets the rest as it comes.
    live: bool,
    /// Bytes of the journal and log sent (or resent from) to the plugin.
    sent: [u64; 2],
    exited: Option<(i32, Option<String>)>,
    /** The procedure has ended; the worker may linger. */
    finished: bool,
    killed: bool,
    orphaned: bool,
}

const FILES: [&str; 2] = ["asrun", "log"];

static RUNNER: OnceLock<Runner> = OnceLock::new();

fn r() -> &'static Runner {
    RUNNER.get().expect("runner")
}

pub fn run(args: RunnerArgs) -> Result<()> {
    let name = args.name.clone().unwrap_or_else(|| {
        std::fs::read_to_string("/proc/sys/kernel/hostname").map(|s| s.trim().to_string()).unwrap_or("runner".into())
    });
    let exe = match &args.executable {
        Some(e) => e.clone(),
        None => crate::self_exe()?,
    };
    for d in ["blobs", "snapshots", "execs"] {
        std::fs::create_dir_all(args.data.join(d))?;
    }
    // A runner starting again has no workers: what is left is stale.
    for d in ["snapshots", "execs"] {
        let _ = std::fs::remove_dir_all(args.data.join(d));
        std::fs::create_dir_all(args.data.join(d))?;
    }
    let base = args.url.trim_end_matches('/').to_string();
    let runner = Runner {
        base,
        name,
        exe,
        http: reqwest::blocking::Client::builder().timeout(Duration::from_secs(60)).build()?,
        token: Mutex::new(None),
        out: Mutex::new(None),
        execs: Mutex::new(HashMap::new()),
        snapshots: Mutex::new(HashMap::new()),
        building: Mutex::new(()),
        draining: AtomicBool::new(false),
        oom_kills: AtomicU64::new(oom_kills()),
        args,
    };
    let _ = RUNNER.set(runner);
    on_sigterm();
    eprintln!("[runner] {} for {}, capacity {}", r().name, r().base, r().args.capacity);
    std::thread::Builder::new().name("tailer".into()).spawn(tailer)?;
    std::thread::Builder::new().name("janitor".into()).spawn(janitor)?;

    let mut backoff = Duration::from_secs(1);
    loop {
        let started = Instant::now();
        match session() {
            Ok(()) => {}
            Err(e) => eprintln!("[runner] connection: {e:#}"),
        }
        disconnected();
        if started.elapsed() > Duration::from_secs(30) {
            backoff = Duration::from_secs(1);
        }
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(Duration::from_secs(10));
    }
}

// --- the plugin -------------------------------------------------------------------------------------------------

fn send(m: Value) {
    if let Some(tx) = r().out.lock().as_ref() {
        let _ = tx.send(m.to_string());
    }
}

fn login() -> Result<Option<String>> {
    let a = &r().args;
    let form: Vec<(&str, String)> = if let Some(id) = &a.client_id {
        let secret = match &a.client_secret_file {
            Some(f) => std::fs::read_to_string(f).with_context(|| format!("{}", f.display()))?.trim().to_string(),
            None => std::env::var("FOPS_RUNNER_CLIENT_SECRET").context("no client secret")?,
        };
        vec![("grant_type", "client_credentials".into()), ("client_id", id.clone()), ("client_secret", secret)]
    } else if let Some(user) = &a.user {
        let password = match &a.password_file {
            Some(f) => std::fs::read_to_string(f).with_context(|| format!("{}", f.display()))?.trim().to_string(),
            None => std::env::var("FOPS_RUNNER_PASSWORD").context("no password")?,
        };
        vec![("grant_type", "password".into()), ("username", user.clone()), ("password", password)]
    } else {
        return Ok(None); // Yamcs without security
    };
    let body: String = form_urlencoded::Serializer::new(String::new()).extend_pairs(form).finish();
    let resp = r()
        .http
        .post(format!("{}/auth/token", r().base))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()?;
    if !resp.status().is_success() {
        bail!("login refused: {} {}", resp.status(), resp.text().unwrap_or_default());
    }
    let v: Value = resp.json()?;
    let t = v["access_token"].as_str().context("no access_token in the login answer")?.to_string();
    *r().token.lock() = Some(t.clone());
    Ok(Some(t))
}

/// Runs one connection until it fails.
fn session() -> Result<()> {
    let token = login()?;
    let url = format!("{}/fops-runner/connect", r().base.replacen("http", "ws", 1));
    let mut req = url.as_str().into_client_request()?;
    if let Some(t) = &token {
        req.headers_mut().insert("Authorization", HeaderValue::from_str(&format!("Bearer {t}"))?);
    }
    let (mut ws, _) = tungstenite::connect(req).with_context(|| format!("connecting to {url}"))?;
    match ws.get_mut() {
        MaybeTlsStream::Plain(s) => s.set_read_timeout(Some(READ_TIMEOUT))?,
        MaybeTlsStream::Rustls(s) => s.sock.set_read_timeout(Some(READ_TIMEOUT))?,
        _ => {}
    }
    let (tx, rx) = crossbeam_channel::unbounded::<String>();
    let executions: Vec<String> = r().execs.lock().keys().cloned().collect();
    let capacity = if r().draining.load(Relaxed) { 0 } else { r().args.capacity };
    ws.send(Message::text(
        json!({"type": "hello", "runner": r().name, "version": env!("CARGO_PKG_VERSION"),
               "capacity": capacity, "executions": executions})
        .to_string(),
    ))?;
    *r().out.lock() = Some(tx);
    *LOST.lock() = None;
    eprintln!("[runner] connected to {url}");
    let mut last_rx = Instant::now();
    let mut last_ping = Instant::now();
    loop {
        if drain(&mut ws, &rx)? {
            return Ok(());
        }
        if last_ping.elapsed() >= PING_EVERY {
            ws.send(Message::Ping(Default::default()))?;
            last_ping = Instant::now();
        }
        let msg = match ws.read() {
            Ok(m) => m,
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted
                ) =>
            {
                if last_rx.elapsed() > SILENCE {
                    bail!("nothing received for {}s", SILENCE.as_secs());
                }
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        last_rx = Instant::now();
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(f) => bail!("closed by Yamcs{}", f.map(|f| format!(": {}", f.reason)).unwrap_or_default()),
            _ => continue,
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(m) => handle(m),
            Err(e) => eprintln!("[runner] bad message: {e}"),
        }
    }
}

/// Writes the queued messages; true if the channel is gone.
fn drain(ws: &mut WebSocket<MaybeTlsStream<std::net::TcpStream>>, rx: &Receiver<String>) -> Result<bool> {
    let mut wrote = false;
    loop {
        match rx.try_recv() {
            Ok(m) => {
                ws.write(Message::text(m))?;
                wrote = true;
            }
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => return Ok(true),
        }
    }
    if wrote {
        ws.flush()?;
    }
    Ok(false)
}

static LOST: Mutex<Option<Instant>> = Mutex::new(None);

fn disconnected() {
    *r().out.lock() = None;
    for e in r().execs.lock().values() {
        e.st.lock().live = false;
    }
    LOST.lock().get_or_insert_with(Instant::now);
}

fn handle(m: Value) {
    let ty = m["type"].as_str().unwrap_or("");
    let x = m["x"].as_str().unwrap_or("").to_string();
    let exec = || r().execs.lock().get(&x).cloned();
    match ty {
        "start" => {
            let _ = std::thread::Builder::new().name(format!("start-{x}")).spawn(move || {
                if let Err(e) = start(&x, &m) {
                    eprintln!("[runner] {x}: not started: {e:#}");
                    send(json!({"type": "failed", "x": x, "error": format!("{e:#}")}));
                }
            });
        }
        "inspect" => {
            let _ = std::thread::Builder::new().name("inspect".into()).spawn(move || {
                let req = m["req"].clone();
                match inspect(&m) {
                    Ok(result) => send(json!({"type": "inspected", "req": req, "result": result})),
                    Err(e) => send(json!({"type": "inspected", "req": req, "error": format!("{e:#}")})),
                }
            });
        }
        "control" => {
            if let Some(e) = exec() {
                let mut st = e.st.lock();
                if let Some(stdin) = st.stdin.as_mut() {
                    if write_line(stdin, m["line"].as_str().unwrap_or("")).is_err() {
                        st.stdin = None;
                    }
                }
            }
        }
        "close" => {
            if let Some(e) = exec() {
                e.st.lock().stdin = None;
            }
        }
        "kill" => {
            if let Some(e) = exec() {
                kill(&e);
            }
        }
        "token" => {
            if let Some(e) = exec() {
                let mut st = e.st.lock();
                if let Some(stdin) = st.stdin.as_mut() {
                    if write_line(stdin, &token_control(&m)).is_err() {
                        st.stdin = None;
                    }
                }
            }
        }
        "resume" => {
            if let Some(e) = exec() {
                resume(&e, m["n"].as_u64().unwrap_or(0), [m["files"]["asrun"].as_u64().unwrap_or(0), m["files"]["log"].as_u64().unwrap_or(0)]);
            }
        }
        "forget" => {
            let e = r().execs.lock().remove(&x);
            if let Some(e) = e {
                if e.st.lock().exited.is_none() {
                    kill(&e);
                }
                let _ = std::fs::remove_dir_all(&e.dir);
                release(&e.snapshot);
            }
        }
        _ => eprintln!("[runner] unknown message {ty:?}"),
    }
}

// --- workers ----------------------------------------------------------------------------------------------------

fn start(x: &str, m: &Value) -> Result<()> {
    let running = r().execs.lock().values().filter(|e| running(&e.st.lock())).count();
    if r().draining.load(Relaxed) {
        bail!("runner {} is shutting down", r().name);
    }
    if running >= r().args.capacity {
        bail!("runner {} is full ({} workers)", r().name, running);
    }
    let instance = m["instance"].as_str().context("no instance")?;
    let procedure = m["procedure"].as_str().context("no procedure")?;
    let snapshot = snapshot(instance, &m["manifest"])?;
    let file = snapshot.join(procedure);
    if !file.starts_with(&snapshot) || !file.is_file() {
        release(&snapshot);
        bail!("no such procedure: {procedure}");
    }
    let dir = r().args.data.join("execs").join(x.replace('/', "-"));
    std::fs::create_dir_all(&dir)?;
    let asrun = dir.join("asrun.jsonl");
    let mut cmd = Command::new(&r().exe);
    cmd.arg("run").arg(&file);
    for f in m["flags"].as_array().into_iter().flatten() {
        cmd.arg(f.as_str().unwrap_or(""));
    }
    cmd.arg("--asrun").arg(&asrun);
    cmd.arg("--yamcs").arg(r().args.worker_yamcs.as_deref().unwrap_or(&r().base));
    // the token goes to the worker's stdin, never to a file
    let token = m["token"].is_string().then(|| token_control(m));
    if token.is_some() {
        cmd.arg("--yamcs-token-stdin");
    }
    if let Some(b) = r().args.worker_memory {
        cmd.arg("--memory-limit").arg(b.to_string());
    }
    let log = std::fs::File::create(dir.join("log"))?;
    std::fs::File::create(&asrun)?;
    cmd.current_dir(&snapshot).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(log);
    // its own process group: a kill takes the procedure's children too
    cmd.process_group(0);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            release(&snapshot);
            return Err(e).context("spawning the worker");
        }
    };
    let pid = child.id() as i32;
    let mut stdin = child.stdin.take();
    if let (Some(t), Some(i)) = (&token, stdin.as_mut()) {
        if let Err(err) = write_line(i, t) {
            eprintln!("[runner] {x}: token: {err}");
        }
    }
    let e = Arc::new(Exec {
        x: x.to_string(),
        dir,
        snapshot,
        pid,
        st: Mutex::new(ExecState {
            stdin,
            ring: VecDeque::new(),
            n: 0,
            live: true,
            sent: [0, 0],
            exited: None,
            finished: false,
            killed: false,
            orphaned: false,
        }),
    });
    r().execs.lock().insert(x.to_string(), e.clone());
    eprintln!("[runner] {x}: {procedure} (pid {pid})");
    send(json!({"type": "started", "x": x, "pid": pid}));
    std::thread::Builder::new().name(format!("worker-{x}")).spawn(move || relay(e, child))?;
    Ok(())
}

/// Relays the worker's stdout, then reports its end.
fn relay(e: Arc<Exec>, mut child: Child) {
    let mut out = BufReader::new(child.stdout.take().expect("stdout"));
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let (n, truncated) = match read_line(&mut out, &mut buf) {
            Ok(r) => r,
            Err(_) => break,
        };
        if n == 0 {
            break;
        }
        let line = if truncated {
            json!({"type": "log", "level": "error",
                   "message": format!("an event of more than {} bytes was dropped", MAX_LINE)})
            .to_string()
        } else {
            String::from_utf8_lossy(buf.strip_suffix(b"\n").unwrap_or(&buf)).into_owned()
        };
        let finished = line.contains("\"finished\"")
            && serde_json::from_str::<Value>(&line).is_ok_and(|v| v["type"] == "finished");
        let mut st = e.st.lock();
        st.finished |= finished;
        st.n += 1;
        let n = st.n;
        st.ring.push_back((n, line.clone()));
        if st.ring.len() > RING {
            st.ring.pop_front();
        }
        if st.live {
            send(json!({"type": "event", "x": e.x, "n": n, "line": line}));
        }
    }
    let status = child.wait();
    let mut st = e.st.lock();
    let (code, reason) = match status {
        Ok(s) => match (s.code(), s.signal()) {
            (Some(c), _) => (c, None),
            (None, Some(sig)) => (128 + sig, Some(if sig == libc::SIGKILL && !st.killed {
                let now = oom_kills();
                if now > r().oom_kills.swap(now, Relaxed) {
                    "worker killed: out of memory".to_string()
                } else {
                    "worker killed (SIGKILL)".to_string()
                }
            } else if sig == libc::SIGKILL {
                "killed".to_string()
            } else {
                format!("worker killed by signal {sig}")
            })),
            _ => (-1, None),
        },
        Err(err) => (-1, Some(format!("worker lost: {err}"))),
    };
    eprintln!("[runner] {}: exited {code}{}", e.x, reason.as_deref().map(|r| format!(" ({r})")).unwrap_or_default());
    flush_files(&e, &mut st, true);
    st.exited = Some((code, if st.killed { None } else { reason }));
    st.stdin = None;
    if st.live {
        let (code, reason) = st.exited.clone().unwrap();
        send(json!({"type": "exited", "x": e.x, "code": code, "reason": reason}));
    }
}

/// A line of at most MAX_LINE bytes kept; (bytes read, whether cut).
fn read_line(r: &mut impl BufRead, buf: &mut Vec<u8>) -> std::io::Result<(usize, bool)> {
    let mut total = 0;
    let mut truncated = false;
    loop {
        let avail = r.fill_buf()?;
        if avail.is_empty() {
            return Ok((total, truncated));
        }
        let (chunk, done) = match avail.iter().position(|&b| b == b'\n') {
            Some(i) => (&avail[..=i], true),
            None => (avail, false),
        };
        let len = chunk.len();
        if buf.len() + len <= MAX_LINE {
            buf.extend_from_slice(chunk);
        } else {
            truncated = true;
        }
        r.consume(len);
        total += len;
        if done {
            return Ok((total, truncated));
        }
    }
}

/// Whether a worker takes a place: its procedure still runs.
fn running(st: &ExecState) -> bool {
    st.exited.is_none() && !st.finished
}

fn kill(e: &Exec) {
    let mut st = e.st.lock();
    if st.exited.is_none() {
        st.killed = true;
        // SAFETY: a signal to the worker's process group.
        unsafe { libc::kill(-e.pid, libc::SIGKILL) };
    }
}

fn write_line(w: &mut impl Write, line: &str) -> std::io::Result<()> {
    w.write_all(line.as_bytes())?;
    w.write_all(b"\n")?;
    w.flush()
}

/// The worker's `token` control for a `start` or `token` message of the plugin.
fn token_control(m: &Value) -> String {
    json!({"cmd": "token", "token": m["token"], "user": m["user"]}).to_string()
}

/// The plugin is back with everything up to event `n` and these file offsets.
fn resume(e: &Exec, n: u64, files: [u64; 2]) {
    let mut st = e.st.lock();
    if let Some(&(first, _)) = st.ring.front() {
        if first > n + 1 {
            eprintln!("[runner] {}: events {} to {} no longer kept", e.x, n + 1, first - 1);
        }
    }
    for (k, line) in st.ring.iter().filter(|(k, _)| *k > n) {
        send(json!({"type": "event", "x": e.x, "n": k, "line": line}));
    }
    st.sent = files;
    st.live = true;
    st.orphaned = false;
    let ended = st.exited.is_some();
    flush_files(e, &mut st, ended);
    if let Some((code, reason)) = st.exited.clone() {
        send(json!({"type": "exited", "x": e.x, "code": code, "reason": reason}));
    }
}

/// Sends what the journal and log have past what was sent; the journal up to
/// its last complete line unless the worker has ended.
fn flush_files(e: &Exec, st: &mut ExecState, all: bool) {
    if !st.live {
        return;
    }
    for (i, name) in FILES.iter().enumerate() {
        let path = e.dir.join(if i == 0 { "asrun.jsonl" } else { "log" });
        let Ok(mut f) = std::fs::File::open(&path) else { continue };
        let Ok(len) = f.metadata().map(|m| m.len()) else { continue };
        while st.sent[i] < len {
            let want = (len - st.sent[i]).min(CHUNK);
            let mut buf = vec![0u8; want as usize];
            if f.seek(SeekFrom::Start(st.sent[i])).is_err() || f.read_exact(&mut buf).is_err() {
                break;
            }
            // whole lines (and whole UTF-8 characters) only, unless at the end
            if !all || want == CHUNK {
                match buf.iter().rposition(|&b| b == b'\n') {
                    Some(p) => buf.truncate(p + 1),
                    None if want == CHUNK => {}
                    None => break,
                }
            }
            let offset = st.sent[i];
            let end = offset + buf.len() as u64;
            send(json!({"type": "file", "x": e.x, "name": name, "offset": offset, "end": end,
                        "data": String::from_utf8_lossy(&buf)}));
            st.sent[i] = end;
        }
    }
}

fn tailer() {
    loop {
        std::thread::sleep(Duration::from_millis(100));
        let execs: Vec<Arc<Exec>> = r().execs.lock().values().cloned().collect();
        for e in execs {
            let mut st = e.st.lock();
            if st.exited.is_none() {
                flush_files(&e, &mut st, false);
            }
        }
    }
}

/// Aborts the workers once the plugin has been away for the grace period;
/// removes unused snapshots and blobs.
fn janitor() {
    let grace = Duration::from_secs(r().args.grace);
    let mut last_gc = Instant::now();
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let lost = *LOST.lock();
        if lost.is_some_and(|t| t.elapsed() > grace) {
            for e in r().execs.lock().values() {
                let mut st = e.st.lock();
                if st.exited.is_none() && !st.orphaned {
                    eprintln!("[runner] {}: no plugin for {}s, aborting", e.x, grace.as_secs());
                    st.orphaned = true;
                    st.stdin = None;
                }
            }
            // their ends will never be collected
            r().execs.lock().retain(|_, e| {
                let st = e.st.lock();
                let keep = st.exited.is_none();
                drop(st);
                if !keep {
                    let _ = std::fs::remove_dir_all(&e.dir);
                    release(&e.snapshot);
                }
                keep
            });
        }
        if last_gc.elapsed() > Duration::from_secs(60) {
            last_gc = Instant::now();
            gc();
        }
    }
}

// --- procedures -------------------------------------------------------------------------------------------------

fn sha256(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

fn valid(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('/')
        && !name.contains('\\')
        && name.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
}

/// The directory of a manifest's files (made from the blob cache), in use
/// until `release`d.
fn snapshot(instance: &str, manifest: &Value) -> Result<PathBuf> {
    let files = manifest.as_object().context("no manifest")?;
    if !valid(instance) || instance.contains('/') {
        bail!("bad instance {instance:?}");
    }
    let id = sha256(manifest.to_string().as_bytes());
    let dir = r().args.data.join("snapshots").join(instance).join(&id[..16]);
    let _building = r().building.lock();
    if !dir.is_dir() {
        let tmp = dir.with_extension("tmp");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp)?;
        for (name, sha) in files {
            let sha = sha.as_str().context("bad manifest")?;
            if !valid(name) || sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                bail!("bad manifest entry {name:?}");
            }
            let blob = blob(instance, sha)?;
            let target = tmp.join(name);
            std::fs::create_dir_all(target.parent().unwrap())?;
            std::fs::hard_link(&blob, &target)?;
        }
        std::fs::rename(&tmp, &dir)?;
    }
    let mut s = r().snapshots.lock();
    let entry = s.entry(dir.clone()).or_insert((0, Instant::now()));
    entry.0 += 1;
    entry.1 = Instant::now();
    Ok(dir)
}

fn release(dir: &Path) {
    if let Some(e) = r().snapshots.lock().get_mut(dir) {
        e.0 = e.0.saturating_sub(1);
        e.1 = Instant::now();
    }
}

/// The cached file of a hash, fetched from the plugin if missing.
fn blob(instance: &str, sha: &str) -> Result<PathBuf> {
    let path = r().args.data.join("blobs").join(sha);
    if path.is_file() {
        return Ok(path);
    }
    let url = format!("{}/fops-runner/blobs/{instance}/{sha}", r().base);
    let get = || {
        let mut req = r().http.get(&url);
        if let Some(t) = r().token.lock().as_deref() {
            req = req.bearer_auth(t);
        }
        req.send()
    };
    let mut resp = get()?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        login()?;
        resp = get()?;
    }
    if !resp.status().is_success() {
        bail!("{url}: {}", resp.status());
    }
    let data = resp.bytes()?;
    if sha256(&data) != sha {
        bail!("{url}: content does not match (the procedure changed meanwhile?)");
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &data)?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o444))?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// Snapshots unused for 10 minutes, and blobs in no snapshot.
fn gc() {
    let old: Vec<PathBuf> = {
        let mut s = r().snapshots.lock();
        let old: Vec<PathBuf> = s
            .iter()
            .filter(|(_, (n, t))| *n == 0 && t.elapsed() > Duration::from_secs(600))
            .map(|(d, _)| d.clone())
            .collect();
        for d in &old {
            s.remove(d);
        }
        old
    };
    let _building = r().building.lock();
    for d in old {
        let _ = std::fs::remove_dir_all(d);
    }
    if let Ok(entries) = std::fs::read_dir(r().args.data.join("blobs")) {
        for e in entries.flatten() {
            if e.metadata().is_ok_and(|m| m.nlink() == 1) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

/// `fops inspect` of a procedure, in a snapshot: its JSON output.
fn inspect(m: &Value) -> Result<String> {
    let instance = m["instance"].as_str().context("no instance")?;
    let path = m["path"].as_str().context("no path")?;
    if !valid(path) {
        bail!("bad path {path:?}");
    }
    let snapshot = snapshot(instance, &m["manifest"])?;
    let result = (|| {
        let mut child = Command::new(&r().exe)
            .arg("inspect")
            .arg(path)
            .current_dir(&snapshot)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()?;
        let mut out = child.stdout.take().unwrap();
        let reader = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = out.read_to_string(&mut s);
            s
        });
        let deadline = Instant::now() + INSPECT_TIMEOUT;
        loop {
            if child.try_wait()?.is_some() {
                break;
            }
            if Instant::now() > deadline {
                // SAFETY: a signal to the inspection's process group.
                unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
                let _ = child.wait();
                bail!("timed out");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(reader.join().unwrap_or_default())
    })();
    release(&snapshot);
    result
}

// --- the host ---------------------------------------------------------------------------------------------------

/// The cgroup v2 `oom_kill` count of this container (0 if unknown).
fn oom_kills() -> u64 {
    std::fs::read_to_string("/sys/fs/cgroup/memory.events")
        .ok()
        .and_then(|s| s.lines().find_map(|l| l.strip_prefix("oom_kill ").and_then(|n| n.trim().parse().ok())))
        .unwrap_or(0)
}

/// SIGTERM: no more starts; exits once the workers have ended.
fn on_sigterm() {
    extern "C" fn handler(_: libc::c_int) {
        if let Some(r) = RUNNER.get() {
            r.draining.store(true, Relaxed);
        }
    }
    // SAFETY: the handler only stores an atomic.
    unsafe {
        libc::signal(libc::SIGTERM, handler as *const () as libc::sighandler_t);
    }
    std::thread::spawn(|| {
        let mut told = false;
        loop {
            std::thread::sleep(Duration::from_millis(200));
            if !r().draining.load(Relaxed) {
                continue;
            }
            if !told {
                eprintln!("[runner] SIGTERM: draining");
                send(json!({"type": "load", "capacity": 0}));
                told = true;
            }
            let mut done = true;
            for e in r().execs.lock().values() {
                let mut st = e.st.lock();
                if st.finished {
                    st.stdin = None; // lingering: let it go
                }
                done &= st.exited.is_some();
            }
            if done {
                eprintln!("[runner] drained, exiting");
                std::thread::sleep(Duration::from_millis(500)); // the last messages out
                std::process::exit(0);
            }
        }
    });
}
