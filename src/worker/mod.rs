//! Executor worker: one process per running procedure.
//!
//! Threads:
//!   * main: the Python interpreter running the procedure
//!   * control: reads `Control` messages (stdin) and drives `tracer::Control`
//!   * writer: serialises `Event`s as JSON lines to the output

pub mod lang;
pub mod tracer;

use std::io::{BufRead, BufWriter, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering::Relaxed;
use std::time::Instant;

use anyhow::{Context, Result};
use pyo3::prelude::*;

use crate::protocol::{Control, Event, Stats};
use crate::yamcs::{Yamcs, YamcsConfig};
use tracer::{Control as Ctl, TraceMode, Tracer};

#[derive(Debug, clap::Args)]
pub struct WorkerArgs {
    /// Procedure file to execute.
    pub procedure: PathBuf,
    #[arg(long, value_enum, default_value = "monitor")]
    pub trace_mode: TraceMode,
    /// Report at most N hits per source location (monitor mode).
    #[arg(long, default_value_t = 100, conflicts_with = "unlimited")]
    pub trace_limit: u64,
    /// Report every hit of every location.
    #[arg(long)]
    pub unlimited: bool,
    /// As-run journal (JSON lines). Commands are fsynced to it.
    #[arg(long)]
    pub asrun: Option<PathBuf>,
    /// Read control messages from stdin.
    #[arg(long)]
    pub control: bool,
    /// Where to write events: "-" for stdout, a path, or "null" to only
    /// serialise them (for benchmarking).
    #[arg(long, default_value = "-")]
    pub events: String,
    /// Procedure arguments, a JSON object: '{"tag": 3, "mode": "STRIP"}'.
    #[arg(long)]
    pub args: Option<String>,
    /// Hold before the preconditions until resumed or stepped (SPELL's
    /// LOADED).
    #[arg(long)]
    pub paused: bool,
    /// Pause before the body of each step.
    #[arg(long)]
    pub by_step: bool,
    /// Ask the operator before every command.
    #[arg(long)]
    pub confirm_commands: bool,
    /// Breakpoint on this line of the procedure file (repeatable).
    #[arg(long = "breakpoint", value_name = "LINE")]
    pub breakpoints: Vec<u32>,
    /// The server starts sub-procedures for this one (the Yamcs plugin):
    /// it answers the "starting" stage of a `call` event with `call_started`,
    /// then reports `call_ended`.
    #[arg(long)]
    pub sub_procedures: bool,
    /// Once ended, keep serving get_variables / eval until stdin closes
    /// (with --control).
    #[arg(long)]
    pub linger: bool,
    /// Limit of the worker's data memory (RLIMIT_DATA), e.g. 512M or 2G: a
    /// procedure going over it gets a MemoryError.
    #[arg(long, value_parser = parse_size)]
    pub memory_limit: Option<u64>,
    #[command(flatten)]
    pub yamcs: YamcsConfig,
}

/// Directory of the `fops` Python package: `FOPS_PYTHON`, else this
/// repository's `python/`, except in the Python package, where it is installed.
pub fn python_dir() -> Option<PathBuf> {
    match std::env::var_os("FOPS_PYTHON") {
        Some(d) => Some(PathBuf::from(d)),
        None if crate::is_extension() => None,
        None => Some(PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/python"))),
    }
}

/// Puts `dirs`, then the working directory, first on `sys.path`. The server
/// starts workers in the procedures root, so a procedure in a subdirectory
/// still imports `mdb` and the root's shared modules.
fn prepend_sys_path(py: Python<'_>, dirs: &[PathBuf]) -> PyResult<()> {
    let path = py.import("sys")?.getattr("path")?;
    let mut dirs = dirs.to_vec();
    if let Ok(cwd) = std::env::current_dir() {
        if !dirs.contains(&cwd) {
            dirs.push(cwd);
        }
    }
    for d in dirs.iter().rev() {
        path.call_method1("insert", (0, d.to_string_lossy().to_string()))?;
    }
    Ok(())
}

/// "512M", "2G", "1048576": bytes (K, M, G are powers of 1024).
pub fn parse_size(s: &str) -> std::result::Result<u64, String> {
    let s = s.trim();
    let (num, mul) = match s.char_indices().last() {
        Some((i, c)) if c.is_ascii_alphabetic() => (
            &s[..i],
            match c.to_ascii_uppercase() {
                'K' => 1u64 << 10,
                'M' => 1 << 20,
                'G' => 1 << 30,
                _ => return Err(format!("unknown unit in {s:?} (K, M or G)")),
            },
        ),
        _ => (s, 1),
    };
    num.trim().parse::<u64>().map(|n| n * mul).map_err(|e| format!("{s:?}: {e}"))
}

/// Keeps a procedure from taking its server down: memory over `limit` fails
/// in the worker, and if the machine (or container) runs out of memory all
/// the same, the kernel kills a worker first.
fn limit_resources(limit: Option<u64>, served: bool) {
    if served {
        // Raising one's own score needs no privilege.
        if let Err(e) = std::fs::write("/proc/self/oom_score_adj", "1000") {
            lang::worker_message(&format!("cannot set oom_score_adj: {e}"));
        }
    }
    if let Some(bytes) = limit {
        let r = libc::rlimit { rlim_cur: bytes as libc::rlim_t, rlim_max: bytes as libc::rlim_t };
        // SAFETY: setrlimit only reads the struct.
        if unsafe { libc::setrlimit(libc::RLIMIT_DATA, &r) } != 0 {
            lang::worker_message(&format!("cannot limit memory to {bytes} bytes: {}", std::io::Error::last_os_error()));
        }
    }
}

pub fn run(args: WorkerArgs) -> Result<i32> {
    limit_resources(args.memory_limit, args.control);
    let procedure = std::fs::canonicalize(&args.procedure).with_context(|| format!("{}", args.procedure.display()))?;
    let main_file = procedure.to_string_lossy().to_string();
    let limit = if args.unlimited || args.trace_mode == TraceMode::Legacy { None } else { Some(args.trace_limit) };

    let journal = match &args.asrun {
        Some(p) => Some(std::fs::OpenOptions::new().create(true).append(true).open(p)?),
        None => None,
    };
    lang::init(Yamcs::new(&args.yamcs), journal, args.sub_procedures && args.control);

    let out: Box<dyn Write + Send> = match args.events.as_str() {
        "-" => Box::new(std::io::stdout()),
        "null" => Box::new(std::io::sink()),
        p => Box::new(std::fs::File::create(p)?),
    };
    let linger = args.linger && args.control;
    let (tx, rx) = crossbeam_channel::unbounded::<Event>();
    let writer = std::thread::Builder::new().name("events".into()).spawn(move || {
        let mut w = BufWriter::with_capacity(1 << 16, out);
        let mut n = 0u64;
        while let Ok(ev) = rx.recv() {
            // An empty Py event ends a lingering worker's output.
            if matches!(&ev, Event::Py(s) if s.is_empty()) {
                break;
            }
            let done = matches!(ev, Event::Finished { .. }) && !linger;
            let _ = w.write_all(&ev.to_json());
            let _ = w.write_all(b"\n");
            n += 1;
            if done {
                break;
            }
            if rx.is_empty() {
                let _ = w.flush();
            }
        }
        let _ = w.flush();
        n
    })?;

    let ctl = Arc::new(Ctl::new(limit));
    ctl.by_step.store(args.by_step, Relaxed);
    ctl.confirm_commands.store(args.confirm_commands, Relaxed);
    for &l in &args.breakpoints {
        ctl.set_breakpoint(l, true);
    }
    // Bad --args end the run with status "error", like arguments that do not fit.
    let (proc_args, args_error) = match args.args.as_deref().map(serde_json::from_str::<serde_json::Value>) {
        Some(Ok(v)) => (v, None),
        Some(Err(e)) => (serde_json::Value::Null, Some(format!("--args is not valid JSON: {e}"))),
        None => (serde_json::Value::Null, None),
    };
    let config = serde_json::json!({
        "args": proc_args,
        "args_error": args_error,
        "paused": args.paused,
    })
    .to_string();
    if args.control {
        let ctl = ctl.clone();
        std::thread::Builder::new().name("control".into()).spawn(move || control_loop(ctl))?;
    }

    Python::initialize();
    let (status, message, line, elapsed) = Python::attach(|py| -> PyResult<(String, String, Option<u32>, f64)> {
        py.import("sys")?.getattr("modules")?.set_item("_fops", lang::module(py)?)?;
        let mut dirs: Vec<PathBuf> = python_dir().into_iter().collect();
        if let Some(dir) = procedure.parent() {
            dirs.push(dir.to_path_buf());
        }
        prepend_sys_path(py, &dirs)?;

        let runtime = py.import("fops._runtime")?;
        let t = Tracer::install(
            py,
            ctl.clone(),
            args.trace_mode,
            tx.clone(),
            main_file.clone(),
            runtime.getattr("ProcedureAborted")?.unbind(),
            runtime.getattr("StepJump")?.unbind(),
            runtime.clone().into_any().unbind(),
        )?;
        let callback = py.import("_fops")?.getattr("_line")?;
        tracer::start(py, t, &callback)?;
        t.emit(Event::Started {
            procedure: main_file.clone(),
            trace_mode: format!("{:?}", args.trace_mode).to_lowercase(),
            trace_limit: limit,
        });
        if args.by_step || args.confirm_commands {
            t.emit(Event::Options { by_step: args.by_step, confirm_commands: args.confirm_commands });
        }

        let started = Instant::now();
        let r = runtime.getattr("main")?.call1((&main_file, &config));
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        tracer::stop(py, t);
        py.detach(|| lang::finish_commands(std::time::Duration::from_secs(2)));
        lang::finish_calls();
        let r = r?;
        let (status, message, line) = match r.extract::<(String, String)>() {
            Ok((s, m)) => (s, m, None),
            Err(_) => r.extract::<(String, String, u32)>().map(|(s, m, l)| (s, m, Some(l)))?,
        };
        Ok((status, message, line, elapsed))
    })
    .unwrap_or_else(|e| ("error".into(), format!("worker: {e}"), None, 0.0));

    let t = tracer::try_tracer();
    let stats = Stats {
        line_callbacks: t.map_or(0, |t| t.line_callbacks.load(Relaxed)),
        line_events: t.map_or(0, |t| t.line_events.load(Relaxed)),
        suppressed_locations: t.map_or(0, |t| t.suppressed.load(Relaxed)),
        commands: lang::lang().commands.load(Relaxed),
    };
    let finished =
        Event::Finished { status: status.clone(), message: message.clone(), elapsed_ms: elapsed, stats: stats.clone(), line };
    match t {
        Some(_) => lang::record(finished, true),
        None => {
            let _ = tx.send(finished);
        }
    }
    let summary = |events: u64| {
        serde_json::json!({ "status": status, "message": message, "elapsed_ms": elapsed, "events": events, "stats": stats })
    };
    if let (true, Some(t)) = (linger, t) {
        // The procedure's final state stays inspectable until stdin closes.
        t.ctl.set_parked(tracer::PARKED_ENDED);
        Python::attach(|py| {
            loop {
                let ctl = t.ctl.clone();
                let Some(r) = py.detach(move || ctl.wait_request()) else { break };
                t.serve(py, r);
            }
        });
        t.emit(Event::Py(String::new()));
        eprintln!("{}", summary(writer.join().unwrap_or(0)));
    } else {
        eprintln!("{}", summary(writer.join().unwrap_or(0)));
    }
    Ok(if status == "error" { 1 } else { 0 })
}

/// Runs `fops.<module>.main(argv)` in the embedded interpreter (no tracer,
/// no Yamcs primitives): the `check` and `mdb-gen` subcommands.
pub fn run_tool(module: &str, argv: Vec<String>, extra_path: Option<PathBuf>) -> Result<i32> {
    Python::initialize();
    Python::attach(|py| -> PyResult<i32> {
        let mut dirs: Vec<PathBuf> = python_dir().into_iter().collect();
        dirs.extend(extra_path);
        prepend_sys_path(py, &dirs)?;
        // Procedure operations are only available in a running worker.
        py.run(
            c"import sys, types
m = types.ModuleType('_fops')
def _missing(name):
    raise RuntimeError('_fops.%s is only available while a procedure runs' % name)
m.__getattr__ = _missing
sys.modules['_fops'] = m",
            None,
            None,
        )?;
        let code = py.import(format!("fops.{module}"))?.getattr("main")?.call1((argv,))?.extract();
        let sys = py.import("sys")?;
        sys.getattr("stdout")?.call_method0("flush")?;
        sys.getattr("stderr")?.call_method0("flush")?;
        code
    })
    .map_err(|e| Python::attach(|py| anyhow::anyhow!("{}", e.value(py))))
}

fn control_loop(ctl: Arc<Ctl>) {
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let c: Control = match serde_json::from_str(&line) {
            Ok(c) => c,
            Err(e) => {
                lang::worker_message(&format!("bad control message {line:?}: {e}"));
                continue;
            }
        };
        apply(&ctl, c);
    }
    // The server went away: nobody can supervise this procedure any more.
    if ctl.parked() != tracer::PARKED_ENDED {
        lang::worker_message("control channel closed, aborting");
    }
    apply(&ctl, Control::Abort { reason: None });
    ctl.close();
}

fn request(ctl: &Ctl, r: tracer::Request) -> bool {
    if let Err(e) = ctl.push_request(r) {
        error_log(&e);
    }
    false
}

fn error_log(msg: &str) {
    match tracer::try_tracer() {
        Some(t) => t.error_log(msg),
        None => eprintln!("[worker] {msg}"),
    }
}

fn apply(ctl: &Ctl, c: Control) {
    let restart = match c {
        Control::Pause => {
            ctl.set_mode(tracer::PAUSE);
            true
        }
        Control::Resume => {
            ctl.set_mode(tracer::RUN);
            false
        }
        Control::Step => {
            ctl.set_mode(tracer::STEP);
            true
        }
        Control::StepOver => {
            ctl.set_mode(tracer::STEP_OVER);
            true
        }
        Control::Abort { reason } => {
            match reason {
                Some(r) => ctl.abort_with(r),
                None => ctl.set_mode(tracer::ABORT),
            }
            true
        }
        Control::GotoStep { index } => {
            ctl.request_jump(index);
            true
        }
        Control::Breakpoint { line, enabled } => {
            ctl.set_breakpoint(line, enabled);
            enabled
        }
        Control::SetTraceLimit { limit } => {
            ctl.set_limit(limit);
            true
        }
        Control::Answer { id, value } => {
            match lang::validate_answer(id, &value) {
                Ok(v) => ctl.answer(id, v),
                Err(e) => error_log(&e),
            }
            false
        }
        Control::Skip => {
            if let Err(e) = ctl.request_line_jump(tracer::LineJump::Skip) {
                error_log(&format!("skip: {e}"));
            }
            false
        }
        Control::GotoLine { line } => {
            if let Err(e) = ctl.request_line_jump(tracer::LineJump::Goto(line)) {
                error_log(&format!("goto_line: {e}"));
            }
            false
        }
        Control::RunTo { line } => {
            ctl.set_run_to(line);
            ctl.set_mode(tracer::RUN);
            true
        }
        Control::SetOptions { by_step, confirm_commands } => {
            if let Some(b) = by_step {
                ctl.by_step.store(b, Relaxed);
            }
            if let Some(b) = confirm_commands {
                ctl.confirm_commands.store(b, Relaxed);
            }
            if tracer::try_tracer().is_some() {
                let (by_step, confirm_commands) = (ctl.by_step.load(Relaxed), ctl.confirm_commands.load(Relaxed));
                lang::record(Event::Options { by_step, confirm_commands }, false);
            }
            false
        }
        Control::GetVariables { request_id } => request(ctl, tracer::Request::Variables { request_id }),
        Control::SetVariable { request_id, name, expr } => {
            request(ctl, tracer::Request::SetVariable { request_id, name, expr })
        }
        Control::Eval { request_id, expr } => request(ctl, tracer::Request::Eval { request_id, expr }),
        Control::CallStarted { seq, id, error } => {
            lang::call_started(seq, id, error);
            false
        }
        Control::CallEnded { seq, status, confirmation, message } => {
            lang::call_ended(seq, status, confirmation, message);
            false
        }
    };
    if restart {
        if let Some(t) = tracer::try_tracer() {
            t.restart_events();
        }
    }
}
