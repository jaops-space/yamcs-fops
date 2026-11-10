//! Yamcs WebSocket subscriptions: the latest values of the parameters the
//! procedure has read, and the command history of its commands.
//!
//! One connection per worker, on its own thread, to `/api/websocket`
//! (JSON). A parameter is subscribed the first time it is read; its first
//! value comes over REST (`parameters:batchGet`), so a read never waits for
//! the subscription. Command history is one `commands` subscription for the
//! processor; entries of commands with origin `fops` are kept until the
//! command is no longer followed.
//!
//! While the connection is down, reads go to REST as without it, and
//! commands are followed by polling the archive. The connection is retried
//! with a backoff, and everything is subscribed again.

use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use parking_lot::{Condvar, Mutex};
use rustc_hash::{FxHashMap, FxHashSet};
use serde_json::{Value, json};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use super::{Ack, ParamValue, Yamcs, YamcsConfig, acks, id_name, param_value, qualify, read_token, string_attrs};
use crate::worker::lang::worker_message;

/// Origin of the commands fops issues (and of the history entries it keeps).
pub const ORIGIN: &str = "fops";

/// Also how long a subscription for new names can wait to be sent.
const READ_TIMEOUT: Duration = Duration::from_millis(20);
const PING_EVERY: Duration = Duration::from_secs(10);
/// No message at all for this long (pongs included): the connection is dead.
const SILENCE: Duration = Duration::from_secs(30);
const MAX_BACKOFF: Duration = Duration::from_secs(10);
/// History entries nobody follows are dropped after this long.
const UNCLAIMED: Duration = Duration::from_secs(60);

pub struct Live {
    state: Mutex<State>,
    changed: Condvar,
    /// Names to subscribe, for the connection thread.
    subscribe: Mutex<Sender<Vec<String>>>,
    on_change: OnceLock<fn()>,
}

#[derive(Default)]
struct State {
    connected: bool,
    /// Bumped by every parameter update received.
    version: u64,
    /// By qualified name: every parameter read so far.
    params: FxHashMap<String, Entry>,
    /// Bumped each time the commands subscription is (re)established; None
    /// while it is not active.
    commands_epoch: Option<u64>,
    epochs: u64,
    /// By Yamcs command id.
    commands: FxHashMap<String, Cmd>,
}

#[derive(Default)]
struct Entry {
    value: Option<ParamValue>,
    /// Yamcs confirmed the subscription, on the current connection.
    subscribed: bool,
    /// `value` is the processor's (none: it has no value), on the current
    /// connection: reads can be answered from here.
    known: bool,
    /// `State::version` of the last update.
    updated: u64,
}

struct Cmd {
    attrs: Vec<(String, String)>,
    seen: Instant,
    /// A `follow` wants it.
    claimed: bool,
}

struct Conn {
    url: String,
    instance: String,
    processor: String,
    token_file: Option<std::path::PathBuf>,
}

enum Pending {
    Params(Vec<String>),
    Commands,
}

impl Live {
    pub fn start(base: &str, cfg: &YamcsConfig) -> Arc<Live> {
        let (tx, rx) = mpsc::channel();
        let live = Arc::new(Live {
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            subscribe: Mutex::new(tx),
            on_change: OnceLock::new(),
        });
        let base = base.trim_end_matches('/');
        let url = match base.split_once("://") {
            Some(("https", rest)) => format!("wss://{rest}/api/websocket"),
            Some((_, rest)) => format!("ws://{rest}/api/websocket"),
            None => format!("ws://{base}/api/websocket"),
        };
        let conn = Conn {
            url,
            instance: cfg.instance.clone(),
            processor: cfg.processor.clone(),
            token_file: cfg.yamcs_token_file.clone(),
        };
        let l = live.clone();
        let _ = std::thread::Builder::new().name("yamcs-ws".into()).spawn(move || l.run(conn, rx));
        live
    }

    /// Also called after every update (from the connection thread, no lock held).
    pub fn on_change(&self, f: fn()) {
        let _ = self.on_change.set(f);
    }

    fn notify(&self) {
        self.changed.notify_all();
        if let Some(f) = self.on_change.get() {
            f();
        }
    }

    /// Latest values, as `Yamcs::get_parameters` from the cache gives them,
    /// keyed by the names asked for, and the version they were read at (for
    /// `changed_since`). Subscribes to the names not seen before.
    pub fn get(&self, rest: &Yamcs, names: &[String]) -> Result<(Vec<(String, ParamValue)>, u64)> {
        let q: Vec<String> = names.iter().map(|n| qualify(n)).collect();
        let missing: Vec<String> = {
            let st = self.state.lock();
            let mut seen = FxHashSet::default();
            q.iter()
                .filter(|n| !st.params.get(*n).is_some_and(|e| e.subscribed && e.known) && seen.insert(*n))
                .cloned()
                .collect()
        };
        let fetched: FxHashMap<String, ParamValue> = match missing.is_empty() {
            true => FxHashMap::default(),
            false => rest.get_parameters(&missing, false, Duration::ZERO)?.into_iter().collect(),
        };
        let mut st = self.state.lock();
        let mut new = Vec::new();
        for n in &missing {
            match st.params.get_mut(n) {
                // An update that came meanwhile is at least as recent.
                Some(e) if e.subscribed && !e.known => {
                    e.value = fetched.get(n).cloned();
                    e.known = true;
                }
                Some(_) => {}
                None => {
                    st.params.insert(n.clone(), Entry::default());
                    new.push(n.clone());
                }
            }
        }
        let missing: FxHashSet<&String> = missing.iter().collect();
        let out = names
            .iter()
            .zip(&q)
            .filter_map(|(name, n)| {
                let v = match missing.contains(n) {
                    true => fetched.get(n).cloned(),
                    false => st.params.get(n).and_then(|e| e.value.clone()),
                };
                Some((name.clone(), v?))
            })
            .collect();
        let version = st.version;
        drop(st);
        if !new.is_empty() {
            let _ = self.subscribe.lock().send(new);
        }
        Ok((out, version))
    }

    /// Whether one of the parameters (qualified names) was updated after `version`.
    pub fn changed_since(&self, names: &[String], version: u64) -> bool {
        let st = self.state.lock();
        st.version > version && names.iter().any(|n| st.params.get(n).is_some_and(|e| e.updated > version))
    }

    /// Waits up to `timeout` for `changed_since`.
    pub fn wait_changed(&self, names: &[String], version: u64, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut st = self.state.lock();
        loop {
            if st.version > version && names.iter().any(|n| st.params.get(n).is_some_and(|e| e.updated > version)) {
                return true;
            }
            if self.changed.wait_until(&mut st, deadline).timed_out() {
                return false;
            }
        }
    }

    /// The current commands subscription, if active: a command issued now
    /// has its whole history here as long as the epoch stays the same.
    pub fn commands_epoch(&self) -> Option<u64> {
        self.state.lock().commands_epoch
    }

    /// The acknowledgements received so far for command `id` (claimed: kept
    /// until `forget_command`).
    pub fn command_acks(&self, id: &str) -> Vec<Ack> {
        let mut st = self.state.lock();
        let c = st.commands.entry(id.to_string()).or_insert_with(|| Cmd { attrs: Vec::new(), seen: Instant::now(), claimed: true });
        c.claimed = true;
        acks(&c.attrs)
    }

    pub fn forget_command(&self, id: &str) {
        self.state.lock().commands.remove(id);
    }

    /// Waits up to `timeout` for any update.
    pub fn wait(&self, timeout: Duration) {
        let mut st = self.state.lock();
        self.changed.wait_for(&mut st, timeout);
    }

    fn run(&self, conn: Conn, rx: Receiver<Vec<String>>) {
        let mut backoff = Duration::from_secs(1);
        let mut last_error = String::new();
        let mut first = true;
        loop {
            let started = Instant::now();
            let r = self.session(&conn, &rx, first);
            first &= !self.state.lock().connected;
            let e = match r {
                Ok(()) => return, // the worker is going away
                Err(e) => format!("{e:#}"),
            };
            let was_connected = std::mem::replace(&mut self.state.lock().connected, false);
            self.disconnected();
            if was_connected {
                worker_message(&format!("Yamcs WebSocket lost: {e}; reading over REST until it is back"));
            } else if e != last_error {
                worker_message(&format!("Yamcs WebSocket: {e}; reading over REST"));
            }
            last_error = e;
            if started.elapsed() > 2 * MAX_BACKOFF {
                backoff = Duration::from_secs(1);
            }
            std::thread::sleep(backoff);
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }

    fn disconnected(&self) {
        let mut st = self.state.lock();
        for e in st.params.values_mut() {
            e.subscribed = false;
            e.known = false;
        }
        st.commands_epoch = None;
        drop(st);
        self.notify();
    }

    /// Runs one connection until it fails; Ok when the worker is going away.
    fn session(&self, conn: &Conn, rx: &Receiver<Vec<String>>, first: bool) -> Result<()> {
        let mut req = conn.url.as_str().into_client_request()?;
        req.headers_mut().insert("Sec-WebSocket-Protocol", HeaderValue::from_static("json"));
        if let Some(t) = conn.token_file.as_deref().and_then(read_token) {
            req.headers_mut().insert("Authorization", HeaderValue::from_str(&format!("Bearer {t}"))?);
        }
        let (mut ws, _) = tungstenite::connect(req).with_context(|| format!("connecting to {}", conn.url))?;
        match ws.get_mut() {
            MaybeTlsStream::Plain(s) => s.set_read_timeout(Some(READ_TIMEOUT))?,
            MaybeTlsStream::Rustls(s) => s.sock.set_read_timeout(Some(READ_TIMEOUT))?,
            _ => {}
        }

        // Names asked for until now are all in `params`.
        loop {
            match rx.try_recv() {
                Ok(_) => {}
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return Ok(()),
            }
        }
        let names: Vec<String> = {
            let mut st = self.state.lock();
            st.connected = true;
            st.params.keys().cloned().collect()
        };
        if !first {
            worker_message("Yamcs WebSocket connected again");
        }
        let mut ids = 0u64;
        let mut pending: FxHashMap<u64, Pending> = FxHashMap::default();
        // call -> numeric id -> qualified name
        let mut calls: FxHashMap<u64, FxHashMap<u64, String>> = FxHashMap::default();
        let mut send = |ws: &mut WebSocket<MaybeTlsStream<std::net::TcpStream>>,
                        pending: &mut FxHashMap<u64, Pending>,
                        what: Pending|
         -> Result<()> {
            ids += 1;
            let options = match &what {
                Pending::Params(names) => json!({
                    "instance": conn.instance,
                    "processor": conn.processor,
                    "id": names.iter().map(|n| json!({ "name": n })).collect::<Vec<_>>(),
                    "sendFromCache": true,
                    "updateOnExpiration": true,
                    "abortOnInvalid": false,
                }),
                Pending::Commands => json!({
                    "instance": conn.instance,
                    "processor": conn.processor,
                    "ignorePastCommands": true,
                }),
            };
            let ty = if matches!(what, Pending::Commands) { "commands" } else { "parameters" };
            ws.send(Message::text(json!({ "type": ty, "id": ids, "options": options }).to_string()))?;
            pending.insert(ids, what);
            Ok(())
        };
        send(&mut ws, &mut pending, Pending::Commands)?;
        if !names.is_empty() {
            send(&mut ws, &mut pending, Pending::Params(names))?;
        }

        let mut last_rx = Instant::now();
        let mut last_ping = Instant::now();
        loop {
            match rx.try_recv() {
                Ok(mut names) => {
                    while let Ok(more) = rx.try_recv() {
                        names.extend(more);
                    }
                    send(&mut ws, &mut pending, Pending::Params(names))?;
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => return Ok(()),
            }
            if last_ping.elapsed() >= PING_EVERY {
                ws.send(Message::Ping(Default::default()))?;
                last_ping = Instant::now();
            }
            let msg = match ws.read() {
                Ok(m) => m,
                // Interrupted: a signal arrived during the read, the connection is fine
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
            let Ok(m) = serde_json::from_str::<Value>(&text) else { continue };
            let call = m["call"].as_u64().unwrap_or(0);
            match m["type"].as_str() {
                Some("reply") => {
                    let Some(what) = m["data"]["replyTo"].as_u64().and_then(|id| pending.remove(&id)) else { continue };
                    if let Some(x) = m["data"].get("exception") {
                        worker_message(&format!("Yamcs WebSocket subscription refused: {}", x["msg"].as_str().unwrap_or("?")));
                        continue;
                    }
                    let mut st = self.state.lock();
                    match what {
                        Pending::Params(names) => {
                            calls.insert(call, FxHashMap::default());
                            for n in names {
                                if let Some(e) = st.params.get_mut(&n) {
                                    e.subscribed = true;
                                }
                            }
                        }
                        Pending::Commands => {
                            st.epochs += 1;
                            st.commands_epoch = Some(st.epochs);
                        }
                    }
                }
                Some("parameters") => {
                    let Some(mapping) = calls.get_mut(&call) else { continue };
                    let data = &m["data"];
                    for (k, id) in data["mapping"].as_object().into_iter().flatten() {
                        if let Ok(k) = k.parse() {
                            mapping.insert(k, qualify(&id_name(id)));
                        }
                    }
                    for id in data["invalid"].as_array().into_iter().flatten() {
                        worker_message(&format!("Yamcs WebSocket: no parameter {}", id_name(id)));
                    }
                    let values = data["values"].as_array().map(Vec::as_slice).unwrap_or_default();
                    if values.is_empty() {
                        continue;
                    }
                    let mut st = self.state.lock();
                    st.version += 1;
                    let version = st.version;
                    for v in values {
                        let Some(name) = v["numericId"].as_u64().and_then(|k| mapping.get(&k)) else { continue };
                        if let Some(e) = st.params.get_mut(name) {
                            e.value = Some(param_value(v));
                            e.known = true;
                            e.updated = version;
                        }
                    }
                    drop(st);
                    self.notify();
                }
                Some("commands") => {
                    let data = &m["data"];
                    let Some(id) = data["id"].as_str() else { continue };
                    let mut st = self.state.lock();
                    if data["origin"].as_str() != Some(ORIGIN) && !st.commands.contains_key(id) {
                        continue;
                    }
                    if !st.commands.contains_key(id) && st.commands.len() >= 64 {
                        st.commands.retain(|_, c| c.claimed || c.seen.elapsed() < UNCLAIMED);
                    }
                    let c = st.commands.entry(id.to_string()).or_insert_with(|| Cmd {
                        attrs: Vec::new(),
                        seen: Instant::now(),
                        claimed: false,
                    });
                    for (name, value) in string_attrs(&data["attr"]) {
                        match c.attrs.iter_mut().find(|(n, _)| *n == name) {
                            Some(a) => a.1 = value,
                            None => c.attrs.push((name, value)),
                        }
                    }
                    drop(st);
                    self.notify();
                }
                _ => {}
            }
        }
    }
}
