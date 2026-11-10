//! Line tracing for procedures.
//!
//! Two strategies are implemented so they can be compared:
//!
//! * `monitor` (default): PEP 669 `sys.monitoring`. LINE events are enabled
//!   only on the procedure's own code objects (library code is never
//!   instrumented). Each location reports its first `limit` hits; after that
//!   the callback returns `sys.monitoring.DISABLE` and CPython stops calling
//!   us for that location, so a hot loop runs at full interpreter speed.
//!   Whenever the operator needs to see execution again (pause, step,
//!   breakpoint, abort, limit change) we call `sys.monitoring.restart_events()`
//!   which re-arms every disabled location.
//!
//! * `legacy`: a C-level `PyEval_SetTrace` hook, which is how the C++ SPELL
//!   executor works. It is called for every line of every frame and cannot be
//!   switched off per location. Kept for benchmarking only.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::os::raw::c_int;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, AtomicUsize, Ordering::*};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use crossbeam_channel::Sender;
use parking_lot::{Condvar, Mutex};
use pyo3::prelude::*;
use pyo3::{ffi, intern};
use rustc_hash::{FxHashMap, FxHashSet};

use crate::protocol::Event;

pub const RUN: u8 = 0;
pub const PAUSE: u8 = 1;
pub const STEP: u8 = 2;
pub const STEP_OVER: u8 = 3;
pub const ABORT: u8 = 4;
/// The operator asked to continue at another step: the current one is
/// interrupted at its next line, wait or prompt.
pub const JUMP: u8 = 5;

/// Where the procedure's thread is waiting for the operator: requests that
/// need its state (variables, eval) are only served there.
pub const RUNNING: u8 = 0;
pub const PARKED_PAUSE: u8 = 1;
pub const PARKED_PROMPT: u8 = 2;
pub const PARKED_ENDED: u8 = 3;

/// A request served on the procedure's thread while it is parked.
#[derive(Debug, Clone)]
pub enum Request {
    Variables { request_id: u64 },
    SetVariable { request_id: u64, name: String, expr: String },
    Eval { request_id: u64, expr: String },
}

impl Request {
    fn what(&self) -> &'static str {
        match self {
            Request::Variables { .. } => "get_variables",
            Request::SetVariable { .. } => "set_variable",
            Request::Eval { .. } => "eval",
        }
    }
}

/// Moves the paused frame to another line (paused at a traced line only).
#[derive(Debug, Clone, Copy)]
pub enum LineJump {
    Skip,
    Goto(u32),
}

/// What woke the paused procedure's thread.
enum Woken {
    Mode(u8),
    Work,
}

/// Why `Control::sleep` returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wake {
    Elapsed,
    Interrupted,
    Service,
    /// What `sleep_until` waited for happened.
    Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum TraceMode {
    /// No line tracing at all (baseline).
    Off,
    /// PyEval_SetTrace on every line, like the C++ SPELL executor.
    Legacy,
    /// sys.monitoring with per-location trace limits.
    Monitor,
}

/// Execution control shared between the Python thread and the control thread.
pub struct Control {
    mode: AtomicU8,
    step_depth: AtomicUsize,
    jump_target: AtomicU32,
    /// Max reported hits per location; u64::MAX means unlimited.
    limit: AtomicU64,
    has_bps: AtomicBool,
    bps: Mutex<FxHashSet<u32>>,
    /// Temporary breakpoint (run_to), 0 when none.
    run_to: AtomicU32,
    /// Reason reported by the next pause, when not a plain "pause" (by step).
    pause_reason: Mutex<Option<String>>,
    line_jump: Mutex<Option<LineJump>>,
    requests: Mutex<VecDeque<Request>>,
    parked: AtomicU8,
    pub by_step: AtomicBool,
    pub confirm_commands: AtomicBool,
    /// The control channel is closed (ends a lingering worker).
    closed: AtomicBool,
    answers: Mutex<FxHashMap<u64, String>>,
    /// Why the procedure is aborting, when not by the operator.
    abort_reason: Mutex<Option<String>>,
    /// The runtime has work for the procedure's thread (a watchdog handler,
    /// a violated invariant): it is done at the next line, wait or prompt.
    service: AtomicBool,
    wake_lock: Mutex<()>,
    wake: Condvar,
}

impl Control {
    pub fn new(limit: Option<u64>) -> Self {
        Control {
            mode: AtomicU8::new(RUN),
            step_depth: AtomicUsize::new(0),
            jump_target: AtomicU32::new(0),
            limit: AtomicU64::new(limit.unwrap_or(u64::MAX)),
            has_bps: AtomicBool::new(false),
            bps: Mutex::new(FxHashSet::default()),
            run_to: AtomicU32::new(0),
            pause_reason: Mutex::new(None),
            line_jump: Mutex::new(None),
            requests: Mutex::new(VecDeque::new()),
            parked: AtomicU8::new(RUNNING),
            by_step: AtomicBool::new(false),
            confirm_commands: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            answers: Mutex::new(FxHashMap::default()),
            abort_reason: Mutex::new(None),
            service: AtomicBool::new(false),
            wake_lock: Mutex::new(()),
            wake: Condvar::new(),
        }
    }

    /// Aborts on behalf of the procedure itself (a watch), not the operator.
    pub fn abort_with(&self, reason: String) {
        *self.abort_reason.lock() = Some(reason);
        self.set_mode(ABORT);
    }

    /// Leaves ABORT once, so the procedure's cleanup steps can run. Another
    /// abort during the cleanup is final.
    pub fn clear_abort(&self) {
        let _g = self.wake_lock.lock();
        *self.abort_reason.lock() = None;
        self.mode.store(RUN, Release);
    }

    pub fn request_service(&self) {
        let _g = self.wake_lock.lock();
        self.service.store(true, Release);
        self.wake.notify_all();
    }

    pub fn service_pending(&self) -> bool {
        self.service.load(Acquire)
    }

    pub fn mode(&self) -> u8 {
        self.mode.load(Acquire)
    }

    /// Aborted, or a jump to another step is pending.
    pub fn interrupted(&self) -> bool {
        matches!(self.mode(), ABORT | JUMP)
    }

    pub fn request_jump(&self, index: u32) {
        self.jump_target.store(index, Release);
        self.set_mode(JUMP);
    }

    /// Consumes a pending jump: back to RUN, returns the target step.
    pub fn take_jump(&self) -> Option<u32> {
        let _g = self.wake_lock.lock();
        self.mode.compare_exchange(JUMP, RUN, AcqRel, Acquire).ok()?;
        Some(self.jump_target.load(Acquire))
    }

    pub fn set_mode(&self, m: u8) {
        let _g = self.wake_lock.lock();
        // Abort is final.
        if self.mode.load(Acquire) != ABORT {
            self.mode.store(m, Release);
        }
        self.wake.notify_all();
    }

    pub fn set_limit(&self, limit: Option<u64>) {
        self.limit.store(limit.unwrap_or(u64::MAX), Release);
    }

    pub fn set_breakpoint(&self, line: u32, enabled: bool) {
        let mut bps = self.bps.lock();
        if enabled {
            bps.insert(line);
        } else {
            bps.remove(&line);
        }
        self.has_bps.store(!bps.is_empty() || self.run_to.load(Acquire) != 0, Release);
    }

    /// Sets (line > 0) or clears (0) the temporary breakpoint.
    pub fn set_run_to(&self, line: u32) {
        let bps = self.bps.lock();
        self.run_to.store(line, Release);
        self.has_bps.store(!bps.is_empty() || line != 0, Release);
    }

    /// Pauses at the next traced line, reporting `reason`.
    pub fn pause_with(&self, reason: &str) {
        *self.pause_reason.lock() = Some(reason.to_string());
        self.set_mode(PAUSE);
    }

    fn take_pause_reason(&self) -> String {
        self.pause_reason.lock().take().unwrap_or_else(|| "pause".into())
    }

    pub fn parked(&self) -> u8 {
        self.parked.load(Acquire)
    }

    pub fn set_parked(&self, p: u8) {
        self.parked.store(p, Release);
    }

    /// Queues a request for the parked procedure's thread. Err if it is not
    /// parked (it is running).
    pub fn push_request(&self, r: Request) -> Result<(), String> {
        let _g = self.wake_lock.lock();
        if self.parked() == RUNNING {
            return Err(format!("{}: only while paused, at a prompt or ended", r.what()));
        }
        self.requests.lock().push_back(r);
        self.wake.notify_all();
        Ok(())
    }

    pub fn take_request(&self) -> Option<Request> {
        self.requests.lock().pop_front()
    }

    pub fn requests_pending(&self) -> bool {
        !self.requests.lock().is_empty()
    }

    /// Skip or goto_line: only while paused.
    pub fn request_line_jump(&self, j: LineJump) -> Result<(), String> {
        let _g = self.wake_lock.lock();
        if self.parked() != PARKED_PAUSE || self.mode() != PAUSE {
            return Err("only while paused".into());
        }
        *self.line_jump.lock() = Some(j);
        self.wake.notify_all();
        Ok(())
    }

    pub fn close(&self) {
        let _g = self.wake_lock.lock();
        self.closed.store(true, Release);
        self.wake.notify_all();
    }

    /// Ended and lingering: waits for a request. None once the control
    /// channel is closed.
    pub fn wait_request(&self) -> Option<Request> {
        let mut g = self.wake_lock.lock();
        loop {
            if let Some(r) = self.take_request() {
                return Some(r);
            }
            if self.closed.load(Acquire) {
                return None;
            }
            self.wake.wait(&mut g);
        }
    }

    pub fn answer(&self, id: u64, value: String) {
        let _g = self.wake_lock.lock();
        self.answers.lock().insert(id, value);
        self.wake.notify_all();
    }

    /// Blocks until the operator answers prompt `id`. None if interrupted
    /// or if the runtime needs the thread first (see `service`).
    pub fn wait_answer(&self, id: u64) -> Option<String> {
        let mut g = self.wake_lock.lock();
        loop {
            // Requests sent before the answer are served first.
            if self.requests_pending() {
                return None;
            }
            if let Some(a) = self.answers.lock().remove(&id) {
                return Some(a);
            }
            if self.interrupted() || self.service_pending() {
                return None;
            }
            self.wake.wait(&mut g);
        }
    }

    /// Sleeps for `d` unless interrupted, or the runtime needs the thread.
    pub fn sleep(&self, d: Duration) -> Wake {
        self.sleep_until(d, || false)
    }

    /// Wakes `sleep_until` to check its condition again.
    pub fn notify(&self) {
        let _g = self.wake_lock.lock();
        self.wake.notify_all();
    }

    /// Like `sleep`, but returns `Wake::Ready` once `ready()`, which is
    /// checked again on each `notify`.
    pub fn sleep_until(&self, d: Duration, ready: impl Fn() -> bool) -> Wake {
        let deadline = Instant::now() + d;
        let mut g = self.wake_lock.lock();
        loop {
            if self.interrupted() {
                return Wake::Interrupted;
            }
            if self.service_pending() {
                return Wake::Service;
            }
            if ready() {
                return Wake::Ready;
            }
            if self.wake.wait_until(&mut g, deadline).timed_out() {
                return if self.interrupted() { Wake::Interrupted } else { Wake::Elapsed };
            }
        }
    }

    fn wait_while_paused(&self) -> Woken {
        let mut g = self.wake_lock.lock();
        loop {
            // Requests and line jumps sent before a resume are done first.
            if self.requests_pending() || self.line_jump.lock().is_some() {
                return Woken::Work;
            }
            let m = self.mode();
            if m != PAUSE {
                return Woken::Mode(m);
            }
            self.wake.wait(&mut g);
        }
    }
}

pub struct Tracer {
    pub ctl: Arc<Control>,
    pub mode: TraceMode,
    events: Sender<Event>,
    main_file: String,
    disable: Py<PyAny>,
    abort_cls: Py<PyAny>,
    jump_cls: Py<PyAny>,
    /// The runtime module: `_serve` (variables, eval) and `_line_jump`.
    runtime: Py<PyAny>,
    /// Python callable that does the pending service work.
    service_hook: OnceLock<Py<PyAny>>,
    next_code_id: AtomicU32,
    /// Code id of the procedure's module code (u32::MAX until seen).
    main_code: AtomicU32,
    codes: Mutex<FxHashMap<usize, (u32, bool)>>,
    /// Code objects belonging to the procedure (used by legacy mode to filter).
    traced: Mutex<FxHashSet<usize>>,
    pub line_callbacks: AtomicU64,
    pub line_events: AtomicU64,
    pub suppressed: AtomicU64,
}

static TRACER: OnceLock<Tracer> = OnceLock::new();

pub fn tracer() -> &'static Tracer {
    TRACER.get().expect("tracer not installed")
}

pub fn try_tracer() -> Option<&'static Tracer> {
    TRACER.get()
}

struct Loc {
    n: u64,
    code_id: u32,
    main: bool,
}

thread_local! {
    static LOCS: RefCell<FxHashMap<(usize, u32), Loc>> = RefCell::new(FxHashMap::default());
}

impl Tracer {
    pub fn install(
        py: Python<'_>,
        ctl: Arc<Control>,
        mode: TraceMode,
        events: Sender<Event>,
        main_file: String,
        abort_cls: Py<PyAny>,
        jump_cls: Py<PyAny>,
        runtime: Py<PyAny>,
    ) -> PyResult<&'static Tracer> {
        let disable = py.import("sys")?.getattr("monitoring")?.getattr("DISABLE")?.unbind();
        let t = Tracer {
            ctl,
            mode,
            events,
            main_file,
            disable,
            abort_cls,
            jump_cls,
            runtime,
            service_hook: OnceLock::new(),
            next_code_id: AtomicU32::new(0),
            main_code: AtomicU32::new(u32::MAX),
            codes: Mutex::new(FxHashMap::default()),
            traced: Mutex::new(FxHashSet::default()),
            line_callbacks: AtomicU64::new(0),
            line_events: AtomicU64::new(0),
            suppressed: AtomicU64::new(0),
        };
        if TRACER.set(t).is_err() {
            panic!("tracer installed twice");
        }
        Ok(tracer())
    }

    pub fn ctl_limit(&self) -> u64 {
        self.ctl.limit.load(Relaxed)
    }

    pub fn emit(&self, ev: Event) {
        let _ = self.events.send(ev);
    }

    /// An error for the operator (a control that cannot be done now).
    pub fn error_log(&self, message: &str) {
        let ev = serde_json::json!({ "type": "log", "level": "error", "message": message, "line": 0 });
        self.emit(Event::Py(ev.to_string()));
    }

    /// Serves one request on the procedure's thread (the runtime emits the
    /// `variables` / `eval_result` event).
    pub fn serve(&self, py: Python<'_>, r: Request) {
        let rt = self.runtime.bind(py);
        let res = match r {
            Request::Variables { request_id } => rt.call_method1("_serve", ("variables", request_id, "", "")),
            Request::SetVariable { request_id, name, expr } => {
                rt.call_method1("_serve", ("set_variable", request_id, name, expr))
            }
            Request::Eval { request_id, expr } => rt.call_method1("_serve", ("eval", request_id, "", expr)),
        };
        if let Err(e) = res {
            self.error_log(&format!("worker: serving a request failed: {}", e.value(py)));
        }
    }

    /// Serves the queued requests (parked at a prompt).
    pub fn serve_requests(&self, py: Python<'_>) {
        while let Some(r) = self.ctl.take_request() {
            self.serve(py, r);
        }
    }

    /// Requests left when the thread leaves its parking place.
    pub fn unpark(&self) {
        let _g = self.ctl.wake_lock.lock();
        self.ctl.set_parked(RUNNING);
        while let Some(r) = self.ctl.take_request() {
            self.error_log(&format!("{}: the procedure is running again", r.what()));
        }
        if self.ctl.line_jump.lock().take().is_some() {
            self.error_log("the procedure is running again: nothing to skip");
        }
    }

    pub fn abort_error(&self, py: Python<'_>, msg: &str) -> PyErr {
        match self.abort_cls.bind(py).call1((msg,)) {
            Ok(v) => PyErr::from_value(v),
            Err(e) => e,
        }
    }

    /// The exception for the current interruption (abort or jump).
    pub fn interrupt_error(&self, py: Python<'_>) -> PyErr {
        if self.ctl.mode() == JUMP {
            match self.jump_cls.bind(py).call1(("Interrupted by a jump to another step",)) {
                Ok(v) => PyErr::from_value(v),
                Err(e) => e,
            }
        } else {
            let reason = self.ctl.abort_reason.lock().clone();
            self.abort_error(py, reason.as_deref().unwrap_or("Aborted by operator"))
        }
    }

    pub fn set_service_hook(&self, hook: Py<PyAny>) {
        let _ = self.service_hook.set(hook);
    }

    /// Runs the pending service work, if any, on the procedure's thread.
    /// Whatever the hook raises (an abort, a violated invariant) propagates.
    pub fn service(&self, py: Python<'_>) -> PyResult<()> {
        if self.ctl.service.swap(false, AcqRel) {
            if let Some(h) = self.service_hook.get() {
                h.call0(py)?;
            }
        }
        Ok(())
    }

    /// Asks for `service` at the next line, wait or prompt.
    pub fn request_service(&self) {
        self.ctl.request_service();
        self.restart_events();
    }

    pub fn mark_traced(&self, code: &Bound<'_, PyAny>) {
        self.traced.lock().insert(code.as_ptr() as usize);
    }

    /// Re-arms all locations disabled by the trace limit so the next executed
    /// line reaches the callback again. Needs the GIL; safe from any thread.
    pub fn restart_events(&self) {
        if self.mode != TraceMode::Monitor {
            return;
        }
        Python::attach(|py| {
            let r = py.import("sys").and_then(|s| s.getattr("monitoring")).and_then(|m| m.call_method0("restart_events"));
            if let Err(e) = r {
                super::lang::worker_message(&format!("restart_events failed: {e}"));
            }
        });
    }

    fn register_code(&self, py: Python<'_>, code: &Bound<'_, PyAny>) -> (u32, bool) {
        let ptr = code.as_ptr() as usize;
        let mut codes = self.codes.lock();
        if let Some(c) = codes.get(&ptr) {
            return *c;
        }
        let file: String = code.getattr(intern!(py, "co_filename")).and_then(|f| f.extract()).unwrap_or_default();
        let name: String = code.getattr(intern!(py, "co_qualname")).and_then(|f| f.extract()).unwrap_or_default();
        let id = self.next_code_id.fetch_add(1, Relaxed);
        let main = file == self.main_file;
        codes.insert(ptr, (id, main));
        if main && name == "<module>" {
            self.main_code.store(id, Relaxed);
        }
        self.emit(Event::Code { code_id: id, file, name, main });
        (id, main)
    }

    fn hit(&self, py: Python<'_>, code: &Bound<'_, PyAny>, line: u32) -> (u64, u32, bool) {
        let key = (code.as_ptr() as usize, line);
        let found = LOCS.with(|l| {
            l.borrow_mut().get_mut(&key).map(|loc| {
                loc.n += 1;
                (loc.n, loc.code_id, loc.main)
            })
        });
        found.unwrap_or_else(|| {
            let (code_id, main) = self.register_code(py, code);
            LOCS.with(|l| l.borrow_mut().insert(key, Loc { n: 1, code_id, main }));
            (1, code_id, main)
        })
    }

    /// Common per-line logic. Returns true if this location may be disabled.
    fn on_line(&self, py: Python<'_>, code_id: u32, main: bool, line: u32, n: u64) -> PyResult<bool> {
        self.line_callbacks.fetch_add(1, Relaxed);
        if self.ctl.service_pending() {
            self.service(py)?;
        }
        let limit = self.ctl.limit.load(Relaxed);
        if n <= limit {
            self.line_events.fetch_add(1, Relaxed);
            self.emit(Event::Line { code_id, line, n });
        } else if n == limit.wrapping_add(1) {
            self.suppressed.fetch_add(1, Relaxed);
            self.emit(Event::Suppressed { code_id, line, n: limit });
        }
        let mut bp = false;
        let mut run_to = false;
        if main && self.ctl.has_bps.load(Relaxed) {
            bp = self.ctl.bps.lock().contains(&line);
            if self.ctl.run_to.load(Relaxed) == line {
                run_to = true;
                self.ctl.set_run_to(0);
            }
        }
        let stop = match self.ctl.mode() {
            RUN if run_to => Some("run_to".to_string()),
            RUN => bp.then(|| "breakpoint".to_string()),
            PAUSE => Some(self.ctl.take_pause_reason()),
            STEP => Some("step".into()),
            STEP_OVER => (frame_depth() <= self.ctl.step_depth.load(Relaxed)).then(|| "step".to_string()),
            _ => return Err(self.interrupt_error(py)),
        };
        if let Some(reason) = stop {
            self.pause_here(py, code_id, line, &reason, true)?;
        }
        Ok(n > limit && !bp && self.ctl.mode() == RUN)
    }

    /// Parks the thread until resumed. `at_line`: called from the line
    /// callback, so the frame can be moved (skip, goto_line).
    fn pause_here(&self, py: Python<'_>, code_id: u32, line: u32, reason: &str, at_line: bool) -> PyResult<()> {
        let depth = frame_depth();
        self.ctl.set_mode(PAUSE);
        self.ctl.set_parked(PARKED_PAUSE);
        self.emit(Event::Paused { code_id, line, reason: reason.into() });
        let m = loop {
            let ctl = self.ctl.clone();
            match py.detach(move || ctl.wait_while_paused()) {
                Woken::Mode(m) => break m,
                Woken::Work => {
                    let jump = self.ctl.line_jump.lock().take();
                    if let Some(j) = jump {
                        self.line_jump(py, code_id, j, at_line);
                    }
                    if let Some(r) = self.ctl.take_request() {
                        self.serve(py, r);
                    }
                }
            }
        };
        self.unpark();
        let how = match m {
            ABORT | JUMP => return Err(self.interrupt_error(py)),
            STEP => "step",
            STEP_OVER => {
                self.ctl.step_depth.store(depth, Relaxed);
                "step_over"
            }
            _ => "resume",
        };
        self.emit(Event::Resumed { how: how.into() });
        Ok(())
    }

    /// Moves the paused frame (the runtime checks and sets `f_lineno`), then
    /// reports the pause at the new line.
    fn line_jump(&self, py: Python<'_>, code_id: u32, j: LineJump, at_line: bool) {
        let (kind, target, reason) = match j {
            LineJump::Skip => ("skip", 0, "skip"),
            LineJump::Goto(l) => ("goto_line", l, "goto"),
        };
        if !at_line {
            self.error_log(&format!("{kind}: not paused at a line of the procedure (paused before a command or step)"));
            return;
        }
        match self.runtime.bind(py).call_method1("_line_jump", (kind, target)).and_then(|r| r.extract::<u32>()) {
            Ok(line) => self.emit(Event::Paused { code_id, line, reason: reason.into() }),
            Err(e) => self.error_log(&format!("{kind}: {}", e.value(py))),
        }
    }

    /// Stops here if a pause is pending. Called by the runtime before each
    /// command, so a pause requested during a wait holds the next command
    /// even when no traced line runs in between.
    pub fn pause_point(&self, py: Python<'_>, line: u32) -> PyResult<()> {
        self.service(py)?;
        match self.ctl.mode() {
            PAUSE => {
                let reason = self.ctl.take_pause_reason();
                self.pause_here(py, self.main_code.load(Relaxed), line, &reason, false)
            }
            ABORT | JUMP => Err(self.interrupt_error(py)),
            _ => Ok(()),
        }
    }

    /// Moves the cursor to `line` of the procedure's module, which does not
    /// run: called when a step starts, as its body may run no traced line
    /// (a docstring alone) before the step is confirmed. `n`, if given, is
    /// the hit count to report (a step's attempt: its decorator line was hit
    /// when the function was defined, not when the step runs).
    pub fn at_line(&self, line: u32, n: Option<u64>) {
        let code_id = self.main_code.load(Relaxed);
        if code_id == u32::MAX {
            return;
        }
        let n = n.unwrap_or_else(|| {
            LOCS.with(|l| {
                l.borrow().iter().find(|((_, ln), loc)| *ln == line && loc.code_id == code_id).map_or(0, |(_, loc)| loc.n)
            })
        });
        self.emit(Event::Line { code_id, line, n });
    }

    /// Pause requested by the procedure itself (Pause()).
    pub fn request_pause(&self) {
        self.ctl.set_mode(PAUSE);
        self.restart_events();
    }
}

/// Number of Python frames on the current thread's stack.
fn frame_depth() -> usize {
    unsafe {
        let mut f = ffi::PyEval_GetFrame();
        if f.is_null() {
            return 0;
        }
        ffi::Py_INCREF(f.cast());
        let mut d = 0;
        while !f.is_null() {
            d += 1;
            let back = ffi::PyFrame_GetBack(f);
            ffi::Py_DECREF(f.cast());
            f = back;
        }
        d
    }
}

/// sys.monitoring LINE callback.
#[pyfunction]
pub fn _line(py: Python<'_>, code: &Bound<'_, PyAny>, line: u32) -> PyResult<Py<PyAny>> {
    let t = tracer();
    let (n, code_id, main) = t.hit(py, code, line);
    if t.on_line(py, code_id, main, line, n)? {
        Ok(t.disable.clone_ref(py))
    } else {
        Ok(py.None())
    }
}

/// C-level trace function used by legacy mode.
unsafe extern "C" fn legacy_trace(
    _obj: *mut ffi::PyObject,
    frame: *mut ffi::PyFrameObject,
    what: c_int,
    _arg: *mut ffi::PyObject,
) -> c_int {
    if what != ffi::PyTrace_LINE {
        return 0;
    }
    let t = tracer();
    unsafe {
        let code = ffi::PyFrame_GetCode(frame);
        let py = Python::assume_attached();
        let code = Bound::from_owned_ptr(py, code.cast());
        if !t.traced.lock().contains(&(code.as_ptr() as usize)) {
            return 0;
        }
        let line = ffi::PyFrame_GetLineNumber(frame) as u32;
        let (n, code_id, main) = t.hit(py, &code, line);
        match t.on_line(py, code_id, main, line, n) {
            Ok(_) => 0,
            Err(e) => {
                e.restore(py);
                -1
            }
        }
    }
}

/// Enables tracing on `code` and every code object nested in it.
pub fn instrument(py: Python<'_>, t: &Tracer, code: &Bound<'_, PyAny>) -> PyResult<()> {
    let mon = py.import("sys")?.getattr("monitoring")?;
    let code_type = code.get_type();
    let mut stack = vec![code.clone()];
    while let Some(c) = stack.pop() {
        t.mark_traced(&c);
        if t.mode == TraceMode::Monitor {
            let line_ev = mon.getattr("events")?.getattr("LINE")?;
            mon.call_method1("set_local_events", (TOOL_ID, &c, line_ev))?;
        }
        for k in c.getattr("co_consts")?.try_iter()? {
            let k = k?;
            if k.is_instance(&code_type)? {
                stack.push(k);
            }
        }
    }
    Ok(())
}

pub const TOOL_ID: u8 = 0; // sys.monitoring.DEBUGGER_ID

pub fn start(py: Python<'_>, t: &Tracer, callback: &Bound<'_, PyAny>) -> PyResult<()> {
    match t.mode {
        TraceMode::Off => {}
        TraceMode::Monitor => {
            let mon = py.import("sys")?.getattr("monitoring")?;
            mon.call_method1("use_tool_id", (TOOL_ID, "fops"))?;
            let line_ev = mon.getattr("events")?.getattr("LINE")?;
            mon.call_method1("register_callback", (TOOL_ID, line_ev, callback))?;
        }
        TraceMode::Legacy => unsafe { ffi::PyEval_SetTrace(Some(legacy_trace), std::ptr::null_mut()) },
    }
    Ok(())
}

pub fn stop(py: Python<'_>, t: &Tracer) {
    match t.mode {
        TraceMode::Off => {}
        TraceMode::Monitor => {
            let _ = py
                .import("sys")
                .and_then(|s| s.getattr("monitoring"))
                .and_then(|m| m.call_method1("free_tool_id", (TOOL_ID,)));
        }
        TraceMode::Legacy => unsafe { ffi::PyEval_SetTrace(None, std::ptr::null_mut()) },
    }
}
