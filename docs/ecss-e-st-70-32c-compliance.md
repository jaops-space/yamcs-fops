# fops against ECSS-E-ST-70-32C

This matrix maps the fops prototype onto the requirements of ECSS-E-ST-70-32C
(31 July 2008), *Test and operations procedure language*
[Reference](https://ecss.nl/standard/ecss-e-st-70-32c-test-and-operations-procedure-language/).


fops does not aim for formal compliance. The goal is the best procedure
language for Yamcs operations. We adopt the standard's ideas where we judge
them sound and depart from it where we don't. The **Verdict** section at the
end records those decisions; the matrix shows where fops stands today.

The normative requirements are in clause 5 and apply to any procedure
language. PLUTO, in Annex A, is an informative reference language: clause
5.3b says it *should* be used, not that it *shall*. fops does not implement
PLUTO syntax.

The requirements are paraphrased below; the standard has the exact wording.
The assessment was made on 2026-11-05.

| Mark | Meaning |
|---|---|
| ✅ Met | Implemented and tested. |
| ◐ Partial | Part of the requirement is covered; the gap is named. |
| ◇ Designed | Agreed design, not implemented yet. |
| ✗ Not met | Not implemented and not designed. |
| T Out of scope | A deliberate departure from the standard. |

## Summary

| Clause | ✅ | ◐ | ◇ | ✗ | T |
|---|---|---|---|---|---|
| 5.1 Procedure structure (18) | 14 | 4 | 0 | 0 | 0 |
| 5.2 Language constructs (36) | 23 | 6 | 0 | 4 | 3 |
| 5.3 Language specification (2) | 0 | 0 | 0 | 0 | 2 |
| **Total (56)** | **37** | **10** | **0** | **4** | **5** |

Clause 5.2 is counted with each item of e and i separately. The "should"
requirements (5.1o, 5.1p, 5.2n, 5.3b) are included.

The remaining gaps are:
- parallel steps (5.1g);
- Yamcs events as triggers and wait conditions (5.1l, 5.1n, 5.2e.7, 5.2i.7);
- monitoring status, validity and sampling time as calls (5.2e.4–6);
- wait-type items in `requires=` / `ensures=` (5.2x);
- replacing missing functions beyond local parameter values (5.2f).

## 5.1 Procedure structure

| Req | Requirement (paraphrased) | Status | fops |
|---|---|---|---|
| 5.1a | Build a goal-oriented procedure from telecommands and operating-system calls. | ✅ | `procedure()` holds the steps. Telecommands are sent with `send()`. Any Python call (files, subprocesses, HTTP) is an operating-system call. |
| 5.1b | A procedure may call other procedures. | ✅ | `run("other.py", args={...})` starts it as its own execution (and Yamcs activity), waits for it and returns its execution and confirmation status; `wait=False` starts it in the background. |
| 5.1c | Define self-contained sub-goals. | ✅ | `@proc.step(...)`. |
| 5.1d | A sub-goal is reached by one activity or a sequence of them. | ✅ | A step body holds any number of `send()` calls. |
| 5.1e | Activities take arguments given at initiation. | ✅ | Command arguments are typed keywords generated from the MDB. Defaults, enumerations and ranges are checked by `fops check` and again when the command is built. |
| 5.1f | A step construct encapsulates complex logic (waits, conditions, branching). | ✅ | A step body is Python, with `wait`, `wait_until`, `verify` and `ask`. |
| 5.1g | Sub-goals run in series or in parallel. | ◐ | Series only. Parallel needs a construct with "until one completes" and "until all complete" (A.1.4). |
| 5.1h | A procedure may have preconditions. | ✅ | `procedure(requires=[...])`, checked before the first step. The operator may override them. The kinds of condition allowed are covered under 5.2x. |
| 5.1i | A procedure may have confirmation conditions. | ✅ | `procedure(ensures=)` is checked after the last step. The procedure ends with an execution and a confirmation status (an `outcome` event). |
| 5.1j | Steps may have preconditions and confirmation conditions. | ✅ | Step `requires=` (preconditions), `goal=` and `ensures=` (confirmation), plus `invariant=` while the body runs. |
| 5.1k | Contingency actions may be defined besides the nominal path. | ✅ | Watchdogs with a body: a function decorated with `@proc.watch(cond)` runs when the condition becomes true. Steps marked `cleanup=True` run after an abort or `finish()`. |
| 5.1l | Procedure contingencies can be triggered by an anomaly, a nominal-path failure, or other events or conditions. | ◐ | Anomalies: by condition, through `watch`. Failures: an operator prompt. Events: not supported. |
| 5.1m | Steps may have contingency actions. | ✅ | Step `invariant=` interrupts the step when violated. The continuation (`on_unconfirmed=`, `on_aborted=`, `restarts=`) decides what follows. |
| 5.1n | Step contingencies can be triggered by a failure, or other events or conditions. | ◐ | As 5.1m. Events are not supported. |
| 5.1o | A contingency is handled at the level where the failure occurs. *(should)* | ✅ | The command-level choices (RESEND, RECHECK, SKIP) come first. The step's continuation comes only after FAIL STEP, or when the step's own conditions fail. |
| 5.1p | A contingency rectifies the anomaly, or reports it and returns to the nominal path. *(should)* | ✅ | A watchdog handler rectifies the anomaly automatically, then resumes, pauses or aborts. A step that is not confirmed is restarted (bounded) or handed to the operator. |
| 5.1q | If an anomaly cannot be rectified: raise an event to a higher level, reach the goal another way and terminate, or abort. | ◐ | Abort: supported. An alternative path: only by the operator jumping or skipping. Raising an event and the "terminate" action are not supported. |
| 5.1r | The body is suspended while a contingency action runs. | ✅ | The body is suspended at a line boundary, or inside a wait, command or prompt, while a watchdog handler runs; it then resumes where it was. |

## 5.2 Language constructs

| Req | Requirement (paraphrased) | Status | fops |
|---|---|---|---|
| 5.2a | Request any space-system activity. | ✅ | Any non-abstract MDB command, through the generated `mdb` package. |
| 5.2b | Initiate an activity and continue at once. | ✅ | `send(..., wait=False)` returns a `Sent` handle once the command is issued; `.wait()` completes and confirms it later. Acknowledgements are followed and journaled meanwhile, whether or not the procedure waits. |
| 5.2c | Initiate an activity and wait for its confirmation. | ✅ | `send()` waits for Yamcs `CommandComplete`, then for an optional `confirm=` condition. |
| 5.2d | Test the result of the activity to decide what to do next. | ✅ | Returns a `CommandResult` (ok, stage, confirmation, detail). `on_failure="ask"\|"raise"\|"skip"` sets the response; with "ask" the operator chooses RESEND, RECHECK, SKIP, FAIL STEP or ABORT. |
| 5.2e.1 | Get an activity's execution and confirmation status. | ✅ | `CommandResult.confirmation` (confirmed, not confirmed, not available) and `.stage`; a `Sent` handle for a command still in progress. |
| 5.2e.2 | Get an activity's initiation, start, termination and completion times. | ◐ | Every stage is time-stamped in the as-run journal. The times are not exposed to the procedure; `CommandResult` has only a duration. |
| 5.2e.3 | Get the value of reporting data. | ✅ | `param.value`, or `param.get(wait=, timeout=, raw=)` for engineering or raw values. |
| 5.2e.4 | Get a parameter's validity status. | ◐ | Conditions treat an invalid value as unknown, so they fail. There is no call that returns validity. |
| 5.2e.5 | Get a parameter's monitoring status, overall and per check. | ✗ | Not exposed. Yamcs provides it (`monitoringResult`, `alarmRange`). |
| 5.2e.6 | Get the sampling time of reporting data. | ✗ | Not exposed. Yamcs provides it (`generationTime`, `acquisitionTime`). |
| 5.2e.7 | Get the time of an event's last occurrence. | ✗ | Events are not supported. |
| 5.2f | Replace a missing function by setting a confirmation status, value, validity, monitoring status or sampling time. | ◐ | Values of local parameters: `p.set(value)`. Not telemetered parameters, validity, monitoring status, sampling time or confirmation status. This is mainly for integration testing (AIV); the processor could inject values. To be decided whether to tailor the rest out for operations. |
| 5.2g | Make a local copy of reporting data, so that properties are read from one sample. | ✅ | `snapshot(*params)` reads the parameters in one request and journals the sample; `s[param]`, `s.valid(param)`, `s.holds(cond)`. |
| 5.2h | Request any operation, and get any property, of any space-system object. | ◐ | Commands and parameters are typed. Other Yamcs objects (links, events, files, alarms) are reachable from Python, but through no fops API. |
| 5.2i.1 | Simple branching (if … then … else). | ✅ | Python `if`/`else`. |
| 5.2i.2 | Branching on the value of a parameter or variable. | ✅ | `if`/`elif` or `match` on `param.value`. |
| 5.2i.3 | Repeat a fixed number of times, while a condition holds, or until it becomes true. | ✅ | `for` and `while`. A loop has no timeout of its own; use `wait_until(within=)`. |
| 5.2i.4 | Wait until an absolute time. | ✅ | `wait(until=datetime or ISO string)`. |
| 5.2i.5 | Wait for a time interval. | ✅ | `wait(seconds)`. Abort and jumps still work while it waits. |
| 5.2i.6 | Wait until a condition becomes true. | ✅ | `wait_until(cond, within=, poll=)`. |
| 5.2i.7 | Wait until an event occurs. | ✗ | Events are not supported. Yamcs events could serve, through the archive or a WebSocket subscription. |
| 5.2j | Local variables are declared with an explicit type. | T | Out of scope: Python is dynamically typed, and the MDB already types every parameter and argument. See the Verdict section. |
| 5.2k | Assign a value to a local variable. | ✅ | Python assignment. |
| 5.2l | Raise a local event, e.g. to trigger a contingency. | T | Rejected, see the Verdict section. A step that cannot recover raises; watchdogs trigger on conditions. |
| 5.2m | Declare local events in the procedure or step declarations. | T | Rejected with 5.2l. |
| 5.2n | Support the mathematical, time and string functions of Annex C. *(should)* | ✅ | The Python standard library (`math`, `datetime`, `str`) is a superset. Not checked function by function. |
| 5.2o | Expressions over constants, parameters, activity arguments and local variables. | ✅ | Python expressions. Parameter comparisons build conditions. Procedure arguments are `proc.args`. |
| 5.2p | Support engineering units. | ✅ | Parameter and argument units come from the MDB (or a short description that is exactly a unit symbol). They are shown with every value. |
| 5.2q | Assign engineering units to constants. | ✅ | `fops.units`: `20 * V`, `90 * s`, `5 * minute`. Durations (`within=`, `timeout=`, `wait()`) take time quantities. |
| 5.2r | Mix compatible units freely in an expression. | ◐ | A quantity is converted when compared with a parameter or passed as an argument. Arithmetic between quantities is not supported. |
| 5.2s | Convert automatically between compatible units. | ✅ | Automatic conversion to the MDB units: `BusVoltage > 25000 * mV` is `BusVoltage > 25` for a parameter in volts. Incompatible units are an `MdbError`, which `fops check` reports. |
| 5.2t | Comments in a procedure. | ✅ | Python comments and docstrings. Step docstrings are shown in the UI. |
| 5.2u | A message the user must acknowledge. | ✅ | `ask(message, ["OK"])`. |
| 5.2v | A message in the execution log. | ✅ | `log(message, level=)`, written to the as-run journal. |
| 5.2w | Get input from the user. | ✅ | `ask(question)` for free text, `ask(question, options)` for a choice. |
| 5.2x | Pre- and confirmation conditions may be: an absolute time, an interval, a condition becoming true, an event, a condition test, or the user's decision. | ◐ | `requires=` covers the condition test, plus the user's decision through the override prompt; `goal=` / `ensures=` with `within=` cover a condition becoming true. The plan is for `requires=` / `ensures=` to accept wait-type items such as `at(t)`, `after(s)`, `until(cond, within=)`, `ask(...)` and events. |

## 5.3 Language specification

| Req | Requirement (paraphrased) | Status | fops |
|---|---|---|---|
| 5.3a | A compliant language is formally specified in ISO EBNF (ISO/IEC 14977). | T | Out of scope. fops does not seek formal compliance. The Python Language Reference defines the syntax; the fops API reference and `fops check` define what a procedure may use. |
| 5.3b | Use PLUTO for procedures in development and operations. *(should)* | T | A deliberate deviation. The reasons are wide operator familiarity, the library ecosystem and reliable AI generation and review. fops adopts the PLUTO procedure model (Annex A) so that procedure knowledge still carries over. |

## Alignment with the Annex A model (informative)

These points are not requirements, but conformance to them makes fops
procedures familiar to PLUTO users.

| Annex A concept | fops | Status |
|---|---|---|
| Procedure bodies: declaration, preconditions, main, watchdog, confirmation (A.1.1) | `procedure(requires=, ensures=, invariant=)`, steps, `@proc.watch` | ✅. |
| A step has the same structure as a procedure, and steps nest (A.1.7) | `@proc.step(requires=, goal=, ensures=, invariant=)` | ◐. Steps do not nest; sub-procedures (`run`) serve instead. |
| Execution status: preconditions, executing, confirmation, completed (A.2.1) | `execution` in the `step` and `outcome` events | ✅. |
| Confirmation status: confirmed, not confirmed, aborted, not available (A.2.1) | `confirmation` in the `step` and `outcome` events, `CommandResult.confirmation` | ✅. A step skipped because its goal already held is confirmed; one skipped by the operator or interrupted by a jump is not available. |
| Continuation tests (A.2.5) | Step `on_unconfirmed=` / `on_aborted=`: continue, ask, abort, restart; `on_failure=` per operation | ✅. RECHECK (repeat only the confirmation) is an addition of ours. "Terminate" is `finish()`. "Raise event" is rejected. |
| Default continuation actions (Figure A‐5): confirmed → continue, not confirmed → ask user, aborted → abort | The step defaults | ✅. A step whose body raises an unexpected error is aborted; a failed command or verification makes it not confirmed. |
| Restart is bounded by a timeout or a maximum number of iterations (A.2.5) | `restarts=` (default 1), then the operator is asked | ✅. Operator restarts (RESEND, RESTART STEP) stay unbounded. |
| Watchdog steps: a trigger (preconditions) plus a body; the main body is suspended; the watchdog ends with resume, terminate, raise event or abort (A.1.5, A.2.1c) | `@proc.watch(cond, then="resume"\|"pause"\|"abort")` | ✅. The handler runs on the procedure's thread, interrupting even a pure-Python loop. Raise event is rejected. |
| Initiate in parallel, until one or all complete (A.2.4) | — | ✗. |
| Execution states of an activity: preconditions, routing, executing, confirmation (A.2.3) | Command stages: issuing, issued, ack…, completed, failed, timeout, abandoned | ✅. The stages are finer-grained and map onto these states. |

## Verdict: which ideas we take

Implemented on 2026-11-05: everything under Adopt except sub-procedures,
monitoring status and sampling time. Sub-procedures followed on 2026-11-08.

### Adopt

- **Preconditions and confirmation, for procedures and for steps**
  (5.1h–j). Stating the goal of each step makes procedures re-runnable
  (`goal=` skips work that is already done), easier to review and checkable
  without running them.
- **Execution status and confirmation status** (A.2.1). Two orthogonal
  statuses, shared by commands, steps and procedures, give one vocabulary
  for the journal, the UI and post-pass review.
- **Continuation tests with sensible defaults** (A.2.5, Figure A‐5):
  confirmed → continue, not confirmed → ask the user, aborted → abort, plus
  a bound on restarts. This is better than asking on every failure.
- **Contingency at the level of the failure** (5.1o). This is already how
  fops works.
- **Watchdogs with a body** (A.1.5). A trigger runs corrective code while
  the main body is suspended at a statement boundary, then resumes,
  terminates or aborts. It is the most useful construct fops lacks.
- **Local copy of reporting data** (5.2g). This fixes a real consistency
  bug.
- **Engineering units on constants, with conversion** (5.2p–s). The MDB
  already has the units, and unit mistakes are a classic operations error.
- **Send without waiting** (5.2b), monitoring status and sampling time
  (5.2e), waiting until an absolute time (5.2i.4). These are small and
  clearly useful.
- **Sub-procedures with arguments** (5.1b, A.1.2), and a confirmation
  status returned to the caller.

### Adopt with care

- **Parallel execution** (5.1g, A.2.4). Use it only with "until all
  complete". "Until one completes" leaves the other branches running,
  sending commands and possibly asking the operator, while the main body
  moves on. That is hard to follow live and hard to reconstruct from the
  journal. Add it only when a real case needs it.
- **Events** (5.1l, 5.2i.7). Waiting for a Yamcs event (an on-board event
  report, an alarm) is sound. Local events used as control flow are not
  (see below).
- **Replacing missing functions** (5.2f). This is useful for dry runs
  against a partial system. It belongs in a simulation or dry-run mode of
  the runtime, not in the procedure language.

### Reject

- **Formal EBNF specification** (5.3a). It adds process cost and nothing
  for operators. Python's grammar and the fops API reference are the
  specification.
- **Declared, typed local variables** (5.2j). The safety the standard wants
  comes from typing telemetry and commands, which the generated MDB does
  and `fops check` enforces. Declaring local variables adds ceremony and
  works against plain Python and AI generation.
- **Declared local events to trigger watchdogs** (5.2l–m, the "raise event"
  continuation). These are non-local jumps between handlers and are hard
  to reason about. A failure that a step cannot handle propagates to the
  caller as an exception, and watchdogs trigger on conditions.
- **The PLUTO syntax** (5.3b). We keep its procedure model, not its
  English-like surface.
