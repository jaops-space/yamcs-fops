//! Messages exchanged between the server and an executor worker.
//! Both directions are newline-delimited JSON over the worker's stdio.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Worker -> server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Started { procedure: String, trace_mode: String, trace_limit: Option<u64> },
    /// First time a traced code object is seen; later events refer to it by id.
    Code { code_id: u32, file: String, name: String, main: bool },
    /// A traced line executed. `n` is the hit count for this location.
    Line { code_id: u32, line: u32, n: u64 },
    /// The location reached the trace limit; it will not be reported again
    /// (and costs nothing) until the operator pauses or sets a breakpoint.
    Suppressed { code_id: u32, line: u32, n: u64 },
    Paused { code_id: u32, line: u32, reason: String },
    Resumed { how: String },
    Prompt {
        id: u64,
        message: String,
        options: Vec<String>,
        line: u32,
        kind: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hint: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default: Option<String>,
        /// The command to confirm (kind "command"): {name, args, significance}.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        command: Option<Value>,
    },
    PromptAnswered { id: u64, answer: String },
    /// The prompt was withdrawn unanswered (abort, jump, violated invariant).
    PromptCancelled { id: u64, reason: String },
    /// Commanding is never subject to trace limits: every stage is reported
    /// and journaled synchronously.
    Command(CommandRecord),
    /// A sub-procedure: every stage is journaled. The server acts on two:
    /// "starting" (start the execution, answer with `CallStarted`) and
    /// "aborting" (abort it).
    Call(CallRecord),
    Telemetry { name: String, value: Value, valid: bool, line: u32 },
    /// After `set_options` (and at start when options were given on the command line).
    Options { by_step: bool, confirm_commands: bool },
    Finished {
        status: String,
        message: String,
        elapsed_ms: f64,
        stats: Stats,
        /// The line of the procedure file an error comes from (a mistake found while loading it).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        line: Option<u32>,
    },
    /// A `token` control for another user is in use: the server revokes the
    /// earlier user's tokens on this (also journaled: who the procedure acts as).
    TokenApplied { user: String },
    /// An event built by the Python runtime (procedure, step, log, verify,
    /// watch...), already serialised as a JSON object with a "type".
    #[serde(skip)]
    Py(String),
}

impl Event {
    /// One JSON line, without the newline.
    pub fn to_json(&self) -> Vec<u8> {
        match self {
            Event::Py(s) => s.as_bytes().to_vec(),
            ev => serde_json::to_vec(ev).unwrap(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandRecord {
    pub seq: u64,
    pub stage: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub args: Value,
    /// Extra command options (`cop1Bypass`...), on the "issuing" record.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub options: Value,
    pub line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yamcs_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub time: String,
}

/// Stages: starting, started, rejected, waiting, ended, aborting.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CallRecord {
    pub seq: u64,
    pub stage: String,
    pub procedure: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub args: Value,
    /// With "starting": {by_step, confirm_commands}, the caller's.
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub options: Value,
    pub line: u32,
    /// The execution, once started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    /// With "ended": how it ended (as its `finished` and last `outcome` events).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub time: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Stats {
    pub line_callbacks: u64,
    pub line_events: u64,
    pub suppressed_locations: u64,
    pub commands: u64,
}

/// Server -> worker.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Control {
    Pause,
    Resume,
    Step,
    StepOver,
    /// `reason` replaces "Aborted by operator" (a sub-procedure aborted by its caller).
    Abort {
        #[serde(default)]
        reason: Option<String>,
    },
    Breakpoint { line: u32, enabled: bool },
    SetTraceLimit { limit: Option<u64> },
    Answer { id: u64, value: String },
    /// Interrupt the current step and continue at step `index` (0-based).
    GotoStep { index: u32 },
    /// Skip the current line (paused only), pause at the next.
    Skip,
    /// Move to another line of the same function (paused only), stay paused.
    GotoLine { line: u32 },
    /// Temporary breakpoint, then resume.
    RunTo { line: u32 },
    SetOptions {
        #[serde(default)]
        by_step: Option<bool>,
        #[serde(default)]
        confirm_commands: Option<bool>,
    },
    /// The following three are served while paused, at a prompt, or ended.
    GetVariables { request_id: u64 },
    SetVariable { request_id: u64, name: String, expr: String },
    Eval { request_id: u64, expr: String },
    /// The sub-procedure of call `seq` was started as execution `id`, or
    /// could not be (`error`).
    CallStarted {
        seq: u64,
        #[serde(default)]
        id: Option<u64>,
        #[serde(default)]
        error: Option<String>,
    },
    /// The worker's Yamcs access token, held in memory only: the first line
    /// with `--yamcs-token-stdin`, then renewals. `user` is who it is for: the
    /// starter, then whoever takes control.
    Token {
        token: String,
        #[serde(default)]
        user: Option<String>,
    },
    /// The sub-procedure of call `seq` has ended.
    CallEnded {
        seq: u64,
        status: String,
        #[serde(default)]
        confirmation: Option<String>,
        #[serde(default)]
        message: String,
    },
}

pub fn now_iso() -> String {
    // RFC3339 UTC with millisecond precision, without pulling in chrono.
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
    let secs = d.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    let (y, m, dd) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{dd:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        d.subsec_millis()
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}
