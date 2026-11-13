//! Native `_fops` module: the primitives the Python runtime
//! (python/fops/_runtime.py) is built on.

use std::cell::Cell;
use std::fs::File;
use std::io::Write;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyDict, PyFloat, PyInt, PyList, PyString, PyTuple};
use rustc_hash::FxHashMap;
use serde_json::{Value, json};

use super::tracer::{self, Wake, tracer};
use crate::protocol::{CallRecord, CommandRecord, Event, now_iso};
use crate::yamcs::{Ack, Yamcs, qualify};

pub struct Lang {
    yamcs: Option<Yamcs>,
    journal: Mutex<Option<File>>,
    cmd_seq: AtomicU64,
    prompt_seq: AtomicU64,
    /// Per-line counters for telemetry reads, which obey the trace limit.
    tm_reports: Mutex<FxHashMap<u32, u64>>,
    pub commands: AtomicU64,
    /// Commands still followed: seq -> (name, Yamcs id, line).
    outstanding: Mutex<FxHashMap<u64, (String, String, u32)>>,
    /// Final stage of each command, once known.
    outcomes: Mutex<FxHashMap<u64, Outcome>>,
    /// Acknowledgements seen of each command (kept once it ended, for a later wait).
    acks: Mutex<FxHashMap<u64, Vec<Ack>>>,
    /// Open prompts, to validate answers.
    prompts: Mutex<FxHashMap<u64, PromptSpec>>,
    /// The server starts sub-procedures (--sub-procedures).
    sub_procedures: bool,
    call_seq: AtomicU64,
    calls: Mutex<FxHashMap<u64, Call>>,
}

/// A sub-procedure, from its "starting" until it ends.
struct Call {
    procedure: String,
    line: u32,
    /// The answer to "starting": Ok(execution id) or why it was not started.
    started: Option<Result<u64, String>>,
    ended: Option<CallOutcome>,
    /// "aborting" has been journaled.
    stopped: bool,
}

#[derive(Clone)]
struct CallOutcome {
    status: String,
    confirmation: Option<String>,
    message: String,
}

struct PromptSpec {
    kind: String,
    options: Vec<String>,
    default: Option<String>,
}

#[derive(Clone)]
struct Outcome {
    ok: bool,
    stage: String,
    id: Option<String>,
    detail: Option<String>,
}

static LANG: OnceLock<Lang> = OnceLock::new();

thread_local! {
    /// Version of the parameter cache at this thread's last `get_values`:
    /// `wait_change` waits for updates after it.
    static SEEN: Cell<u64> = const { Cell::new(0) };
}

pub fn lang() -> &'static Lang {
    LANG.get().expect("lang not initialised")
}

pub fn init(yamcs: Option<Yamcs>, journal: Option<File>, sub_procedures: bool) {
    if let Some(y) = &yamcs {
        y.live().on_change(|| {
            if let Some(t) = tracer::try_tracer() {
                t.ctl.notify();
            }
        });
    }
    let _ = LANG.set(Lang {
        yamcs,
        journal: Mutex::new(journal),
        cmd_seq: AtomicU64::new(0),
        prompt_seq: AtomicU64::new(0),
        tm_reports: Mutex::new(FxHashMap::default()),
        commands: AtomicU64::new(0),
        outstanding: Mutex::new(FxHashMap::default()),
        outcomes: Mutex::new(FxHashMap::default()),
        acks: Mutex::new(FxHashMap::default()),
        prompts: Mutex::new(FxHashMap::default()),
        sub_procedures,
        call_seq: AtomicU64::new(0),
        calls: Mutex::new(FxHashMap::default()),
    });
}

/// A message of the worker itself: on stderr (the execution's log file) and,
/// once the procedure runs, journaled as an `output` event.
pub fn worker_message(msg: &str) {
    eprintln!("[worker] {msg}");
    if LANG.get().is_some() && tracer::try_tracer().is_some() {
        let ev = json!({ "type": "output", "stream": "worker", "text": msg, "line": 0 });
        record(Event::Py(ev.to_string()), false);
    }
}

/// Appends to the as-run journal and forwards to the server. With `sync`
/// the journal entry is on disk before this returns.
pub fn record(ev: Event, sync: bool) {
    if let Some(l) = LANG.get() {
        if let Some(f) = l.journal.lock().as_mut() {
            let mut line = ev.to_json();
            // every as-run entry gets a time, unless the event has one
            if line.first() == Some(&b'{') && !line.windows(6).any(|w| w == b"\"time\"") {
                let stamp = format!("{{\"time\": \"{}\", ", now_iso());
                line.splice(0..1, stamp.into_bytes());
                if line.ends_with(b", }") {
                    line.truncate(line.len() - 3);
                    line.push(b'}');
                }
            }
            line.push(b'\n');
            let _ = f.write_all(&line);
            if sync {
                let _ = f.sync_data();
            }
        }
    }
    tracer().emit(ev);
}

fn yamcs() -> PyResult<&'static Yamcs> {
    lang().yamcs.as_ref().ok_or_else(|| PyRuntimeError::new_err("no Yamcs connection configured (--yamcs)"))
}

fn interrupt(py: Python<'_>) -> PyErr {
    tracer().interrupt_error(py)
}

/// Enables line tracing on a compiled procedure (and its nested code).
#[pyfunction]
fn instrument(py: Python<'_>, code: &Bound<'_, PyAny>) -> PyResult<()> {
    tracer::instrument(py, tracer(), code)
}

/// Emits an event built in Python (a JSON object with a "type").
#[pyfunction]
#[pyo3(signature = (event, journal=true, sync=false))]
fn emit(event: String, journal: bool, sync: bool) {
    let ev = Event::Py(event);
    if journal { record(ev, sync) } else { tracer().emit(ev) }
}

/// The answer to give the procedure, or why `value` does not answer prompt `id`.
/// Called on the control thread: a rejected answer leaves the prompt open.
pub fn validate_answer(id: u64, value: &str) -> Result<String, String> {
    let Some(l) = LANG.get() else { return Err("no procedure running".into()) };
    let prompts = l.prompts.lock();
    let Some(p) = prompts.get(&id) else { return Err(format!("no open prompt {id}")) };
    let value = match (&p.default, value.trim().is_empty()) {
        (Some(d), true) => d.clone(),
        _ => value.to_string(),
    };
    match p.kind.as_str() {
        "number" => match value.trim().parse::<f64>() {
            Ok(x) if x.is_finite() => Ok(value.trim().to_string()),
            _ => Err(format!("prompt {id}: {value:?} is not a number")),
        },
        "options" | "command" if !p.options.contains(&value) => {
            Err(format!("prompt {id}: {value:?} is not one of {}", p.options.join(", ")))
        }
        _ => Ok(value),
    }
}

/// Asks the operator; blocks until a client answers. `kind` is "options",
/// "text", "number" or "command" (the runtime checks it).
#[pyfunction]
#[pyo3(signature = (message, options, line, kind="options".to_string(), hint=None, default=None, command=None))]
fn prompt(
    py: Python<'_>,
    message: String,
    options: Vec<String>,
    line: u32,
    kind: String,
    hint: Option<String>,
    default: Option<String>,
    command: Option<String>,
) -> PyResult<String> {
    let l = lang();
    let id = l.prompt_seq.fetch_add(1, Relaxed) + 1;
    let command = command.map(|c| serde_json::from_str::<Value>(&c)).transpose().map_err(|e| PyValueError::new_err(e.to_string()))?;
    l.prompts.lock().insert(id, PromptSpec { kind: kind.clone(), options: options.clone(), default: default.clone() });
    record(Event::Prompt { id, message, options, line, kind, hint, default, command }, true);
    let t = tracer();
    let r = loop {
        t.ctl.set_parked(tracer::PARKED_PROMPT);
        let ctl = t.ctl.clone();
        let answer = py.detach(move || ctl.wait_answer(id));
        if let Some(answer) = answer {
            record(Event::PromptAnswered { id, answer: answer.clone() }, true);
            break Ok(answer);
        }
        t.serve_requests(py);
        // A watchdog handler may run while the operator thinks; the prompt
        // stays open unless that raises.
        if !t.ctl.interrupted() && !t.ctl.service_pending() {
            continue;
        }
        t.unpark();
        let r = if t.ctl.interrupted() { Err(interrupt(py)) } else { t.service(py) };
        if let Err(e) = r {
            record(Event::PromptCancelled { id, reason: e.value(py).to_string() }, true);
            break Err(e);
        }
    };
    t.unpark();
    l.prompts.lock().remove(&id);
    r
}

/// (base URL, instance, processor) of the worker's Yamcs.
#[pyfunction]
fn yamcs_connection() -> PyResult<(String, String, String)> {
    let (base, instance, processor) = yamcs()?.connection();
    Ok((base.into(), instance.into(), processor.into()))
}

/// The worker's current Yamcs access token, if any: renewed by the server,
/// and another user's after another operator takes control.
#[pyfunction]
fn yamcs_token() -> PyResult<Option<String>> {
    Ok(yamcs()?.token())
}

/// A `token` control. For another user, the worker says when it is in use.
pub fn set_token(token: String, user: Option<String>) {
    let Some(y) = LANG.get().and_then(|l| l.yamcs.as_ref()) else { return };
    let applied = user.clone().filter(|_| y.set_token(token, user));
    if let (Some(user), Some(_)) = (applied, tracer::try_tracer()) {
        record(Event::TokenApplied { user }, false);
    }
}

/// (by_step, confirm_commands)
#[pyfunction]
fn options() -> (bool, bool) {
    let c = &tracer().ctl;
    (c.by_step.load(Relaxed), c.confirm_commands.load(Relaxed))
}

/// Pauses at the next traced line of the procedure, reporting `reason`.
#[pyfunction]
fn pause_next(reason: String) {
    tracer().ctl.pause_with(&reason);
    tracer().restart_events();
}

/// Sleeps for `d`, doing pending service work meanwhile. Err if interrupted.
fn sleep_for(py: Python<'_>, d: Duration) -> PyResult<()> {
    let deadline = Instant::now() + d;
    loop {
        let ctl = tracer().ctl.clone();
        let left = deadline.saturating_duration_since(Instant::now());
        match py.detach(move || ctl.sleep(left)) {
            Wake::Elapsed => return Ok(()),
            Wake::Interrupted => return Err(interrupt(py)),
            Wake::Service => tracer().service(py)?,
            Wake::Ready => return Ok(()),
        }
    }
}

/// Waits up to `timeout` seconds for one of the parameters to be updated
/// after this thread's last `get_values`; True if one was. Interruptible
/// like `sleep`. Without a subscription (no Yamcs WebSocket), just sleeps.
#[pyfunction]
fn wait_change(py: Python<'_>, names: Vec<String>, timeout: f64) -> PyResult<bool> {
    let Some(live) = lang().yamcs.as_ref().map(Yamcs::live) else {
        sleep_for(py, Duration::from_secs_f64(timeout.max(0.0)))?;
        return Ok(false);
    };
    let names: Vec<String> = names.iter().map(|n| qualify(n)).collect();
    let since = SEEN.get();
    let deadline = Instant::now() + Duration::from_secs_f64(timeout.max(0.0));
    loop {
        let ctl = tracer().ctl.clone();
        let left = deadline.saturating_duration_since(Instant::now());
        match py.detach(|| ctl.sleep_until(left, || live.changed_since(&names, since))) {
            Wake::Elapsed => return Ok(false),
            Wake::Ready => return Ok(true),
            Wake::Interrupted => return Err(interrupt(py)),
            Wake::Service => tracer().service(py)?,
        }
    }
}

/// `wait_change` for a background thread: not interruptible, does no
/// service work.
#[pyfunction]
fn wait_update(py: Python<'_>, names: Vec<String>, timeout: f64) -> bool {
    let d = Duration::from_secs_f64(timeout.max(0.0));
    let Some(live) = LANG.get().and_then(|l| l.yamcs.as_ref()).map(Yamcs::live) else {
        py.detach(|| std::thread::sleep(d));
        return false;
    };
    let names: Vec<String> = names.iter().map(|n| qualify(n)).collect();
    let since = SEEN.get();
    py.detach(|| live.wait_changed(&names, since, d))
}

#[pyfunction]
fn sleep(py: Python<'_>, seconds: f64) -> PyResult<()> {
    sleep_for(py, Duration::from_secs_f64(seconds.max(0.0)))
}

/// Registers the runtime's service callable (see `Tracer::service`).
#[pyfunction]
fn set_service(hook: Py<PyAny>) {
    tracer().set_service_hook(hook);
}

/// Called from any thread: the runtime needs the procedure's thread.
#[pyfunction]
fn request_service() {
    tracer().request_service();
}

/// Leaves a pending abort so the cleanup steps can run.
#[pyfunction]
fn clear_abort() {
    tracer().ctl.clear_abort();
}

/// Raises the pending interruption, if any (for loops that do not sleep).
#[pyfunction]
fn check_interrupt(py: Python<'_>) -> PyResult<()> {
    if tracer().ctl.interrupted() { Err(interrupt(py)) } else { Ok(()) }
}

#[pyfunction]
fn pause_point(py: Python<'_>, line: u32) -> PyResult<()> {
    tracer().pause_point(py, line)
}

#[pyfunction]
#[pyo3(signature = (line, n=None))]
fn at_line(line: u32, n: Option<u64>) {
    tracer().at_line(line, n);
}

#[pyfunction]
fn request_pause() {
    tracer().request_pause();
}

#[pyfunction]
#[pyo3(signature = (reason=None))]
fn request_abort(reason: Option<String>) {
    match reason {
        Some(r) => tracer().ctl.abort_with(r),
        None => tracer().ctl.set_mode(tracer::ABORT),
    }
    tracer().restart_events();
}

/// The step to continue at, if the operator asked for a jump.
#[pyfunction]
fn take_jump() -> Option<u32> {
    tracer().ctl.take_jump()
}

/// Latest values: {name: (value, valid)}. Missing parameters are absent.
/// From the subscription cache, except with `wait` (the next value, over REST).
#[pyfunction]
#[pyo3(signature = (names, wait=false, timeout=5.0, raw=false, line=0, report=false))]
fn get_values<'py>(
    py: Python<'py>,
    names: Vec<String>,
    wait: bool,
    timeout: f64,
    raw: bool,
    line: u32,
    report: bool,
) -> PyResult<Bound<'py, PyDict>> {
    let y = yamcs()?;
    let t = Duration::from_secs_f64(timeout.max(0.0));
    let values = py
        .detach(|| match wait {
            true => y.get_parameters(&names, true, t),
            false => y.live().get(y, &names).map(|(values, version)| {
                SEEN.set(version);
                values
            }),
        })
        .map_err(|e| PyRuntimeError::new_err(format!("{e:#}")))?;
    if tracer().ctl.interrupted() {
        return Err(interrupt(py));
    }
    // Plain reads can sit in hot polling loops: report the first `limit` per line.
    let emit = report && {
        let mut m = lang().tm_reports.lock();
        let c = m.entry(line).or_default();
        *c += 1;
        *c <= tracer().ctl_limit()
    };
    let out = PyDict::new(py);
    for (name, pv) in values {
        let v = if raw { pv.raw } else { pv.eng };
        out.set_item(&name, (json_to_py(py, &v)?, pv.valid))?;
        if emit {
            tracer().emit(Event::Telemetry { name, value: v, valid: pv.valid, line });
        }
    }
    Ok(out)
}

/// Sets a local parameter in Yamcs; returns why it failed, or None.
#[pyfunction]
fn set_value(py: Python<'_>, name: String, kind: String, value: &Bound<'_, PyAny>) -> PyResult<Option<String>> {
    let y = yamcs()?;
    if tracer().ctl.interrupted() {
        return Err(interrupt(py));
    }
    let value = py_to_json(value)?;
    Ok(py.detach(|| y.set_parameter(&name, &kind, &value)).err().map(|e| format!("{e:#}")))
}

fn command_dict<'py>(py: Python<'py>, seq: u64, o: &Outcome) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("ok", o.ok)?;
    d.set_item("stage", &o.stage)?;
    d.set_item("id", &o.id)?;
    d.set_item("detail", &o.detail)?;
    d.set_item("seq", seq)?;
    Ok(d)
}

fn record_command(seq: u64, stage: &str, name: &str, args: Value, line: u32, id: Option<&str>, detail: Option<String>) {
    record_command_with(seq, stage, name, args, Value::Null, line, id, detail)
}

#[allow(clippy::too_many_arguments)]
fn record_command_with(seq: u64, stage: &str, name: &str, args: Value, options: Value, line: u32, id: Option<&str>,
                       detail: Option<String>) {
    record(
        Event::Command(CommandRecord {
            seq,
            stage: stage.into(),
            name: name.into(),
            args,
            options,
            line,
            yamcs_id: id.map(str::to_string),
            detail,
            time: now_iso(),
        }),
        true,
    )
}

/// Issues a command through Yamcs. Every stage is journaled with fsync
/// before the next action is taken. Once issued, a thread follows its
/// acknowledgements until CommandComplete (or `timeout`), whether or not the
/// procedure waits for it (`wait_command`). Returns {ok, stage, id, detail, seq}
/// with stage "issued" or "rejected". `options` are Yamcs extra command
/// options by id (`cop1Bypass`...).
#[pyfunction]
#[pyo3(signature = (name, args, line, timeout, comment=None, options=None))]
fn issue_command<'py>(
    py: Python<'py>,
    name: String,
    args: &Bound<'py, PyDict>,
    line: u32,
    timeout: f64,
    comment: Option<String>,
    options: Option<&Bound<'py, PyDict>>,
) -> PyResult<Bound<'py, PyDict>> {
    let y = yamcs()?;
    let l = lang();
    if tracer().ctl.interrupted() {
        return Err(interrupt(py));
    }
    l.commands.fetch_add(1, Relaxed);
    let seq = l.cmd_seq.fetch_add(1, Relaxed) + 1;
    let args = py_to_json(args.as_any())?;
    let options = match options {
        Some(o) if !o.is_empty() => py_to_json(o.as_any())?,
        _ => Value::Null,
    };
    record_command_with(seq, "issuing", &name, args.clone(), options.clone(), line, None, None);
    let epoch = y.live().commands_epoch();
    let id = match py.detach(|| y.issue_command(&name, &args, &options, comment.as_deref())) {
        Ok(id) => id,
        Err(e) => {
            let o = Outcome { ok: false, stage: "rejected".into(), id: None, detail: Some(format!("{e:#}")) };
            record_command(seq, "rejected", &name, Value::Null, line, None, o.detail.clone());
            l.outcomes.lock().insert(seq, o.clone());
            return command_dict(py, seq, &o);
        }
    };
    record_command(seq, "issued", &name, Value::Null, line, Some(&id), None);
    l.outstanding.lock().insert(seq, (name.clone(), id.clone(), line));
    let timeout = Duration::from_secs_f64(timeout.max(0.0));
    let follow_id = id.clone();
    std::thread::Builder::new()
        .name(format!("cmd-{seq}"))
        .spawn(move || follow(y, seq, name, follow_id, line, timeout, epoch))
        .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
    command_dict(py, seq, &Outcome { ok: true, stage: "issued".into(), id: Some(id), detail: None })
}

/// Journals the acknowledgements of command `seq` until it completes.
/// They come from the command history subscription when it was active
/// before the command was issued (`epoch`) and has stayed so; otherwise
/// (and from the first time it is not) from polling the archive.
fn follow(y: &'static Yamcs, seq: u64, name: String, id: String, line: u32, timeout: Duration, epoch: Option<u64>) {
    let l = lang();
    let live = y.live();
    let mut subscribed = epoch.is_some();
    let deadline = Instant::now() + timeout;
    let mut seen: Vec<Ack> = Vec::new();
    let outcome = loop {
        subscribed &= live.commands_epoch() == epoch;
        let acks = match subscribed {
            true => Ok(Some(live.command_acks(&id))),
            false => y.command_acks(&id),
        };
        match acks {
            Ok(Some(acks)) => {
                for a in acks.iter().filter(|a| !seen.contains(a)) {
                    let d = match &a.message {
                        Some(m) => format!("{}={} ({m})", a.name, a.status),
                        None => format!("{}={}", a.name, a.status),
                    };
                    record_command(seq, "ack", &name, Value::Null, line, Some(&id), Some(d));
                }
                seen = acks;
                l.acks.lock().insert(seq, seen.clone());
                if let Some(c) = seen.iter().find(|a| a.name == "CommandComplete" && a.status != "PENDING") {
                    let ok = c.status == "OK";
                    let detail = c.message.clone().unwrap_or_else(|| c.status.clone());
                    break Outcome { ok, stage: if ok { "completed" } else { "failed" }.into(), id: None, detail: Some(detail) };
                }
            }
            Ok(None) => {}
            Err(e) => worker_message(&format!("command history for {id}: {e:#}")),
        }
        let now = Instant::now();
        if now >= deadline {
            let d = format!("no completion after {}s", timeout.as_secs_f64());
            break Outcome { ok: false, stage: "timeout".into(), id: None, detail: Some(d) };
        }
        match subscribed {
            true => live.wait((deadline - now).min(Duration::from_secs(1))),
            false => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    live.forget_command(&id);
    let outcome = Outcome { id: Some(id.clone()), ..outcome };
    // Recorded under the lock, so finish_commands never reports it untracked.
    let mut out = l.outstanding.lock();
    if out.remove(&seq).is_some() {
        record_command(seq, &outcome.stage, &name, Value::Null, line, Some(&id), outcome.detail.clone());
        l.outcomes.lock().insert(seq, outcome);
    }
}

/// Waits for command `seq` to complete, or with `ack`, for that
/// acknowledgement (`Acknowledge_Sent`, `Verifier_Started`...) to be
/// reported: its stage is then the ack's name. A command that ends without
/// it fails. An interruption stops the waiting, never the command, which
/// goes on being followed and journaled.
#[pyfunction]
#[pyo3(signature = (seq, ack=None))]
fn wait_command<'py>(py: Python<'py>, seq: u64, ack: Option<String>) -> PyResult<Bound<'py, PyDict>> {
    let l = lang();
    loop {
        if let Some(name) = &ack {
            let found = l.acks.lock().get(&seq).and_then(|acks| acks.iter().find(|a| &a.name == name && a.status != "PENDING").cloned());
            if let Some(a) = found {
                let id = l.outstanding.lock().get(&seq).map(|o| o.1.clone()).or_else(|| l.outcomes.lock().get(&seq).and_then(|o| o.id.clone()));
                let detail = match &a.message {
                    Some(m) => format!("{}={} ({m})", a.name, a.status),
                    None => format!("{}={}", a.name, a.status),
                };
                return command_dict(py, seq, &Outcome { ok: a.status == "OK", stage: a.name, id, detail: Some(detail) });
            }
        }
        if let Some(o) = l.outcomes.lock().get(&seq) {
            return match &ack {
                Some(name) => {
                    let detail = match (o.ok, &o.detail) {
                        (false, Some(d)) => format!("{name} was not reported; {d}"),
                        _ => format!("{name} was not reported"),
                    };
                    command_dict(py, seq, &Outcome { ok: false, detail: Some(detail), ..o.clone() })
                }
                None => command_dict(py, seq, o),
            };
        }
        let r = sleep_for(py, Duration::from_millis(100));
        if let Err(e) = r {
            if let Some((name, id, line)) = l.outstanding.lock().get(&seq).cloned() {
                let why = format!("stopped waiting ({}); still followed", e.value(py));
                record_command(seq, "abandoned", &name, Value::Null, line, Some(&id), Some(why));
            }
            return Err(e);
        }
    }
}

/// Called when the procedure has ended: gives outstanding commands up to
/// `grace` to complete, then journals the rest as untracked.
pub fn finish_commands(grace: Duration) {
    let Some(l) = LANG.get() else { return };
    let deadline = Instant::now() + grace;
    while !l.outstanding.lock().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    for (seq, (name, id, line)) in l.outstanding.lock().drain() {
        let d = "the procedure ended before the command completed: check Yamcs command history".to_string();
        record_command(seq, "untracked", &name, Value::Null, line, Some(&id), Some(d));
    }
}

fn record_call(seq: u64, stage: &str, c: &Call, fill: impl FnOnce(&mut CallRecord)) {
    let mut r = CallRecord {
        seq,
        stage: stage.into(),
        procedure: c.procedure.clone(),
        line: c.line,
        id: c.started.as_ref().and_then(|s| s.as_ref().ok().copied()),
        time: now_iso(),
        ..Default::default()
    };
    fill(&mut r);
    record(Event::Call(r), true);
}

/// Waits on the procedure's thread until `ready` holds for call `seq`,
/// doing service work meanwhile. Err if interrupted.
fn wait_call(py: Python<'_>, seq: u64, ready: fn(&Call) -> bool) -> PyResult<()> {
    let l = lang();
    let ready = || l.calls.lock().get(&seq).is_none_or(&ready);
    loop {
        let ctl = tracer().ctl.clone();
        match py.detach(|| ctl.sleep_until(Duration::from_secs(3600), ready)) {
            Wake::Ready => return Ok(()),
            Wake::Elapsed => {}
            Wake::Interrupted => return Err(interrupt(py)),
            Wake::Service => tracer().service(py)?,
        }
    }
}

/// Asks the server to start `procedure` (a path in the procedures
/// directory) with `args`, and waits for its answer. Returns
/// {seq, id, error}: the call's number and the execution, or why the
/// server did not start it. An interruption meanwhile aborts it.
#[pyfunction]
fn start_procedure<'py>(py: Python<'py>, procedure: String, args: &Bound<'py, PyDict>, line: u32) -> PyResult<Bound<'py, PyDict>> {
    let l = lang();
    if !l.sub_procedures {
        return Err(PyRuntimeError::new_err(
            "sub-procedures are started by the fops Yamcs plugin: this worker runs without it",
        ));
    }
    if tracer().ctl.interrupted() {
        return Err(interrupt(py));
    }
    let args = py_to_json(args.as_any())?;
    let c = &tracer().ctl;
    let options = json!({"by_step": c.by_step.load(Relaxed), "confirm_commands": c.confirm_commands.load(Relaxed)});
    let seq = l.call_seq.fetch_add(1, Relaxed) + 1;
    {
        // registered first: the answer can come before `record` returns
        let mut calls = l.calls.lock();
        let call = calls.entry(seq).or_insert(Call { procedure, line, started: None, ended: None, stopped: false });
        record_call(seq, "starting", call, |r| {
            r.args = args;
            r.options = options;
        });
    }
    if let Err(e) = wait_call(py, seq, |c| c.started.is_some()) {
        stop(seq, &e.value(py).to_string());
        return Err(e);
    }
    let started = l.calls.lock().get(&seq).and_then(|c| c.started.clone());
    let d = PyDict::new(py);
    d.set_item("seq", seq)?;
    match started {
        Some(Ok(id)) => d.set_item("id", id)?,
        Some(Err(e)) => {
            l.calls.lock().remove(&seq);
            d.set_item("error", e)?
        }
        None => d.set_item("error", "no answer from the server")?,
    }
    Ok(d)
}

/// Waits for the sub-procedure of call `seq` to end: {status,
/// confirmation, message}. An interruption aborts it.
#[pyfunction]
fn wait_procedure<'py>(py: Python<'py>, seq: u64) -> PyResult<Bound<'py, PyDict>> {
    let l = lang();
    {
        let calls = l.calls.lock();
        let Some(c) = calls.get(&seq) else { return Err(PyValueError::new_err(format!("no sub-procedure {seq}"))) };
        if c.ended.is_none() {
            record_call(seq, "waiting", c, |_| {});
        }
    }
    if let Err(e) = wait_call(py, seq, |c| c.ended.is_some()) {
        stop(seq, &e.value(py).to_string());
        return Err(e);
    }
    let o = l.calls.lock().get(&seq).and_then(|c| c.ended.clone());
    let o = o.unwrap_or(CallOutcome { status: "crashed".into(), confirmation: None, message: "lost".into() });
    let d = PyDict::new(py);
    d.set_item("status", o.status)?;
    d.set_item("confirmation", o.confirmation)?;
    d.set_item("message", o.message)?;
    Ok(d)
}

/// Asks the server to abort the sub-procedure of call `seq`, unless it
/// has ended.
#[pyfunction]
fn abort_procedure(seq: u64, reason: String) {
    stop(seq, &reason);
}

fn stop(seq: u64, reason: &str) {
    let mut calls = lang().calls.lock();
    let Some(c) = calls.get_mut(&seq) else { return };
    if c.ended.is_some() || c.stopped || matches!(c.started, Some(Err(_))) {
        return;
    }
    c.stopped = true;
    record_call(seq, "aborting", c, |r| r.detail = Some(reason.to_string()));
}

/// Control thread: the server's answer to "starting".
pub fn call_started(seq: u64, id: Option<u64>, error: Option<String>) {
    let Some(l) = LANG.get() else { return };
    {
        let mut calls = l.calls.lock();
        let Some(c) = calls.get_mut(&seq) else { return };
        c.started = Some(match (id, error) {
            (Some(id), None) => Ok(id),
            (_, e) => Err(e.unwrap_or_else(|| "not started".into())),
        });
        match &c.started {
            Some(Err(e)) => record_call(seq, "rejected", c, |r| r.detail = Some(e.clone())),
            _ => record_call(seq, "started", c, |_| {}),
        }
    }
    tracer().ctl.notify();
}

/// Control thread: the sub-procedure of call `seq` has ended.
pub fn call_ended(seq: u64, status: String, confirmation: Option<String>, message: String) {
    let Some(l) = LANG.get() else { return };
    {
        let mut calls = l.calls.lock();
        let Some(c) = calls.get_mut(&seq) else { return };
        if c.ended.is_some() {
            return;
        }
        record_call(seq, "ended", c, |r| {
            r.status = Some(status.clone());
            r.confirmation = confirmation.clone();
            r.detail = Some(message.clone());
        });
        c.ended = Some(CallOutcome { status, confirmation, message });
    }
    tracer().ctl.notify();
}

/// Called when the procedure has ended: its sub-procedures still running
/// are aborted.
pub fn finish_calls() {
    let Some(l) = LANG.get() else { return };
    let seqs: Vec<u64> = l.calls.lock().iter().filter(|(_, c)| c.ended.is_none()).map(|(s, _)| *s).collect();
    for seq in seqs {
        stop(seq, "the calling procedure ended");
    }
}

fn json_to_py<'py>(py: Python<'py>, v: &Value) -> PyResult<Bound<'py, PyAny>> {
    Ok(match v {
        Value::Null => py.None().into_bound(py),
        Value::Bool(b) => PyBool::new(py, *b).to_owned().into_any(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.into_pyobject(py)?.into_any()
            } else if let Some(u) = n.as_u64() {
                u.into_pyobject(py)?.into_any()
            } else {
                n.as_f64().unwrap_or(f64::NAN).into_pyobject(py)?.into_any()
            }
        }
        Value::String(s) => PyString::new(py, s).into_any(),
        Value::Array(a) => {
            let items = a.iter().map(|x| json_to_py(py, x)).collect::<PyResult<Vec<_>>>()?;
            PyList::new(py, items)?.into_any()
        }
        Value::Object(o) => {
            let d = PyDict::new(py);
            for (k, x) in o {
                d.set_item(k, json_to_py(py, x)?)?;
            }
            d.into_any()
        }
    })
}

fn py_to_json(o: &Bound<'_, PyAny>) -> PyResult<Value> {
    if o.is_none() {
        Ok(Value::Null)
    } else if o.is_instance_of::<PyBool>() {
        Ok(json!(o.extract::<bool>()?))
    } else if o.is_instance_of::<PyInt>() {
        match o.extract::<i64>() {
            Ok(i) => Ok(json!(i)),
            Err(_) => Ok(json!(o.extract::<u64>()?)),
        }
    } else if o.is_instance_of::<PyFloat>() {
        Ok(json!(o.extract::<f64>()?))
    } else if o.is_instance_of::<PyString>() {
        Ok(json!(o.extract::<String>()?))
    } else if let Ok(d) = o.cast::<PyDict>() {
        let mut m = serde_json::Map::new();
        for (k, v) in d.iter() {
            m.insert(k.str()?.to_string(), py_to_json(&v)?);
        }
        Ok(Value::Object(m))
    } else if o.is_instance_of::<PyList>() || o.is_instance_of::<PyTuple>() {
        o.try_iter()?.map(|x| py_to_json(&x?)).collect::<PyResult<Vec<_>>>().map(Value::Array)
    } else {
        Err(PyValueError::new_err(format!("cannot convert {} to a Yamcs value", o.get_type().name()?)))
    }
}

pub fn module(py: Python<'_>) -> PyResult<Bound<'_, PyModule>> {
    let m = PyModule::new(py, "_fops")?;
    m.add_function(wrap_pyfunction!(tracer::_line, &m)?)?;
    m.add_function(wrap_pyfunction!(instrument, &m)?)?;
    m.add_function(wrap_pyfunction!(emit, &m)?)?;
    m.add_function(wrap_pyfunction!(prompt, &m)?)?;
    m.add_function(wrap_pyfunction!(sleep, &m)?)?;
    m.add_function(wrap_pyfunction!(check_interrupt, &m)?)?;
    m.add_function(wrap_pyfunction!(pause_point, &m)?)?;
    m.add_function(wrap_pyfunction!(at_line, &m)?)?;
    m.add_function(wrap_pyfunction!(request_pause, &m)?)?;
    m.add_function(wrap_pyfunction!(request_abort, &m)?)?;
    m.add_function(wrap_pyfunction!(take_jump, &m)?)?;
    m.add_function(wrap_pyfunction!(get_values, &m)?)?;
    m.add_function(wrap_pyfunction!(wait_change, &m)?)?;
    m.add_function(wrap_pyfunction!(wait_update, &m)?)?;
    m.add_function(wrap_pyfunction!(set_value, &m)?)?;
    m.add_function(wrap_pyfunction!(issue_command, &m)?)?;
    m.add_function(wrap_pyfunction!(wait_command, &m)?)?;
    m.add_function(wrap_pyfunction!(start_procedure, &m)?)?;
    m.add_function(wrap_pyfunction!(wait_procedure, &m)?)?;
    m.add_function(wrap_pyfunction!(abort_procedure, &m)?)?;
    m.add_function(wrap_pyfunction!(set_service, &m)?)?;
    m.add_function(wrap_pyfunction!(request_service, &m)?)?;
    m.add_function(wrap_pyfunction!(clear_abort, &m)?)?;
    m.add_function(wrap_pyfunction!(options, &m)?)?;
    m.add_function(wrap_pyfunction!(pause_next, &m)?)?;
    m.add_function(wrap_pyfunction!(yamcs_connection, &m)?)?;
    m.add_function(wrap_pyfunction!(yamcs_token, &m)?)?;
    Ok(m)
}
