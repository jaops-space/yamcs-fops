# fops as a Yamcs plugin: contract between the parts

Three parts are built in parallel against this document:

| part | directory | owner |
|---|---|---|
| Yamcs plugin (Java): HTTP API, executions, control model, packaging | `plugin/` | plugin session |
| Worker and runtime (Rust `fops run`, Python `fops`): new controls, events, `fops inspect` | `src/`, `python/` | worker session |
| Web UI (Angular custom elements for Yamcs-web) | `web/` | UI session |

A change to this contract is made here first, and the other parts are told.
Target: the latest Yamcs release only (5.14.0 today).

## Packaging and configuration

The plugin jar (`yamcs-fops`) contains the built web UI under `fops-web/` and
extracts it at startup to `<dataDir>/fops/web/`, then calls
`WebPlugin.addExtension("yamcs-fops", Map.of(), dir)`. The UI build produces plain
`.js`/`.css` files without `index.html`, so Yamcs-web includes them all.

The plugin's name (Yamcs plugin metadata, from the jar manifest / artifactId)
is `yamcs-fops`: Yamcs-web creates `<yamcs-fops>` at startup, which adds the
sidebar entries. The pages are the element `<fops-procedures>`, routed at
`/ext/fops-procedures/<subroute>?c=<instance>`.

The `fops` binary is not in the jar. `yamcs.yaml`:

```yaml
fops:
  executable: fops            # name on PATH, or path (relative: to the Yamcs working directory)
  python: /opt/fops/python    # optional: FOPS_PYTHON for the workers
  dataDir: fops               # relative to the Yamcs dataDir: working files
  promptWarningDelay: 60      # s, default for new executions; 0 = off
  controllerGracePeriod: 10   # s without the controller's poll -> pause
  serviceUser: fops-timeline  # optional: the user of the timeline's procedures
  workers: local              # local: child processes of Yamcs; remote: on runners (docs/remote-workers.md)
  workerMemory: 512M          # optional, local workers: --memory-limit (a MemoryError beyond)
  runnerGrace: 30             # s, remote: a runner away longer has lost its executions
  runnerStartTimeout: 20      # s, remote: for a runner to start a worker
  instances:
    simulator:
      procedureBucket: fops-procedures-simulator   # the default
      asrunBucket: fops-asrun-simulator            # the default
      processor: realtime
      traceLimit: 100
      serviceUser: fops-timeline                   # the default: the one above
      mdbPackage: mdb                              # the default; "": not regenerated
```

Instances without an entry have no fops.

### Persistence

- **Procedures** are the objects of the instance's procedure bucket (a Yamcs
  bucket, created if missing; upload with Yamcs-web's Buckets page or the
  storage API). The workers run from a copy at `<dataDir>/fops/procedures/<instance>/`,
  brought up to date (at most every 2 s) when procedures are listed, read or
  started, so procedures can import the bucket's packages. Names starting with
  `_` or `.`, and folders with an `__init__.py`, are not listed.
- **The MDB package** (`mdbPackage`, `mdb/` by default) of the procedure
  bucket is regenerated when Yamcs has started, and when the instance is
  restarted: the plugin reads the instance's MDB in Yamcs (all of it, as the
  `/api/mdb` listings give it to a user who may see everything), has
  `fops mdb-gen --mdb` generate the package from it, and replaces the
  bucket's package if the MDB fingerprint in its `__init__.py` differs. Then
  all procedures are inspected again. Not done with remote workers (`fops`
  is not on the Yamcs host): run `fops mdb-gen` and upload the package.
- **Executions** are rows of the table `fops_executions` in the instance's
  Yamcs database (written through the stream `fops_executions_in`): id,
  procedure, status, started, ended, startedBy, origin, asrun, and as JSON the
  start request, the Summary and, once ended, the State. A row is written at
  the start, when the Summary changes (at most once a second) and at the end.
  Ids are per instance and continue after a restart. After a restart the
  executions are read back as ended ones; those that had not ended become
  `crashed` with the message "Yamcs stopped while it ran" (their workers exit
  with Yamcs). Restart works on them.
- **As-run journals and worker logs** are written by the worker to
  `<dataDir>/fops/asrun|logs/<instance>/`, copied to the as-run bucket when the
  execution ends and moved there when the worker exits (after `--linger`), as
  `<YYYY-MM-DD>/<started>-<procedure>-<id>.jsonl` and `.log`. A file that could
  not be stored stays on disk and is retried at the next start. The worker gets the Yamcs URL of
this server (loopback, HTTP port, context path), the instance and processor.

### Worker authentication

If Yamcs security is on, the plugin starts each worker with
`--yamcs-token-file <file>` and keeps a valid access token for the user who
started the execution in that file (rewriting it before expiry). The worker
sends `Authorization: Bearer <contents>` and re-reads the file on 401. So
commands appear in Yamcs command history under the operator's name.

The timeline starts its activities as the System user. With security on, a
procedure it starts runs as the instance's **service user** (`serviceUser`)
instead, which needs `fops.Start` and the privileges of what the procedures
do: at least the object privileges `Command` (the commands sent),
`CommandHistory` (their acknowledgements; without it a procedure waits for
them) and `ReadParameter`. Without a service user such a start fails. The
plugin logs the service user in at each such start, without a password, so it
gets its current roles and privileges as for an interactive login (users.yaml,
LDAP groups, the Yamcs directory); a user unknown to the directory is created
there (inactive with `blockUnknownUsers`, and then refused). With security
off, the procedures of the timeline run as System, as everything runs as the
guest user.

## Privileges

The plugin registers these Yamcs system privileges. Superusers have all.

| privilege | allows |
|---|---|
| `fops.Monitor` | list procedures and executions, watch them (also implied by any other) |
| `fops.Start` | start, restart executions |
| `fops.Control` | take control; every control while in control; answer prompts |
| `fops.Shell` | `eval` and `set_variable` |
| `fops.Kill` | kill an execution (any controller) |
| `fops.Runner` | connect as a runner, fetch the procedures' files (`/fops-runner/`; [remote-workers.md](remote-workers.md)) |

Answering a `command` prompt (SEVERE/CRITICAL confirmation) also needs the
Yamcs `Command` object privilege for that command.

## HTTP API

Base: `<contextPath>/fops/api/{instance}`. JSON in and out, errors as Yamcs
does (`{"code", "type", "msg"}` with the HTTP status). Authentication as for
the Yamcs API (`Authorization: Bearer`), so the UI uses `yamcsClient.doFetch`.

Every client tab makes a random **session id** and sends it as the
`session` query parameter on `events` and in the body of control-related
requests.

```
GET  /info
     -> {fopsVersion, privileges: {monitor, start, control, shell, kill},
         promptWarningDelay, controllerGracePeriod, traceLimit, processor}

GET  /procedures
     -> [{path: "power_cycle.py", name?, version?}]        (sorted; folders = "/" in path)

GET  /procedures/{path}
     -> {path, source, modified, inspect: <fops inspect output>}

POST /executions
     {procedure, args?: {name: value}, traceLimit?: n|null, background?: bool,
      breakpoints?: [line], options?: {byStep?, confirmCommands?},
      session}
     -> {id}                         (the caller becomes the controller unless background)

fops starts executions now. To start one later, put a `PROCEDURE` activity
on the Yamcs timeline (see Yamcs activities below); a `schedule` field is
refused (400).

A start with a controller (not background, not a
sub-procedure; also `:restart`) is held before anything runs, as SPELL
loads a procedure: the worker runs with `--paused` and reports a `paused`
event with `reason: "start"` (activity `loaded`) until the controller runs,
steps or goes to a step. Breakpoints and options are set in that state.

GET  /executions                     -> [Summary]  (newest first, also finished ones)
GET  /executions/{id}                -> State

GET  /executions/{id}/events?after=SEQ&session=SID&timeout=25
     -> {seq, events: [Event...]}           events with seq > SEQ, in order
     -> {seq, snapshot: State}              if SEQ is 0, or older than the buffer
     Long poll: returns at once if there are events, otherwise after the first
     event or `timeout` seconds (then `events: []`). Line events are coalesced:
     only the latest `line` event since the last poll is returned (plus
     `suppressed`). A poll with `session` counts as presence of that session
     (controller liveness, monitor list).

POST /executions/{id}/control        {session, ...Control}       204; 403 unless controller
POST /executions/{id}:takeControl    {session}    403 if someone else controls it
POST /executions/{id}:releaseControl {session}    -> background (no controller)
POST /executions/{id}:monitor        {session}    adds to monitors (also implied by polling)
POST /executions/{id}:kill           {session}    SIGKILL the worker; status "killed"
POST /executions/{id}:restart        {session}    -> {id}: new execution, same procedure, args,
                                                  breakpoints, options; old one must be ended
GET  /executions/{id}/asrun          as-run journal, application/x-ndjson
GET  /executions/{id}/procedure      {path, source, inspect?}: the procedure as it started
                                     (kept in the as-run bucket as <asrun>.procedure.json);
                                     404 for executions started before it was kept
```

### Summary

```
{id, instance, procedure, name, version, started, ended?, status,
 activity,                       // see below
 step: {index, name, execution, confirmation} | null,
 message,                        // latest log message text
 commands,                       // number of command records
 controller: {user, session} | null, monitors: [user], background,
 origin: "user" | "api", startedBy: user,
 activityId?}                    // its Yamcs activity, see below
```

### Status and activity

`status` (from the worker, plus the plugin's): `starting`,
`running`, `paused`, `finished`, `aborted`, `error`, `crashed`, `killed`.

`activity` is derived by the plugin for display, SPELL-style:
`prompt` (an open prompt), `waiting` (inside `wait`/`wait_until`,
cleared by the next `line`), `loaded` (paused with reason `start`), `paused`,
`running`, or the final status.

### Yamcs activities

Every execution is a Yamcs activity of type `PROCEDURE` (executor
`ProcedureExecutor`, registered by ServiceLoader), listed in Yamcs-web's
Activities with the procedure and execution id as its detail.

- **Started by fops** (`POST /executions`, `:restart`): the activity is
  created once the worker runs, by the same user.
- **Started by Yamcs** (`POST /api/activities/{instance}/activities:start`,
  or a timeline item, which is how fops schedules: the UI's Schedule…
  creates one, which can be moved or cancelled on the timeline until it
  starts): the arguments are
  `{procedure, args?: {...}, options?: {byStep, confirmCommands}}`; the
  execution runs in the background (origin `api`), as the activity's user,
  who also needs `fops.Start`; for the timeline, whose activities are the
  System user's, as the service user (Worker authentication). Integral numbers in `args` (protobuf Structs
  carry doubles) are passed as integers.
- The activity log gets the procedure's `log` messages, the steps'
  outcomes, the prompts, the watchdogs and a lost controller.
- The activity is **successful** if the execution `finished` with the
  procedure confirmed (a plain script: if it finished), **failed** otherwise
  (not confirmed, finished early with `finish()`, aborted, error, crashed,
  killed), with the final message as the reason.
- **Cancelling** the activity aborts the execution (cleanup steps still
  run; Yamcs shows the activity cancelled at once).
- After a Yamcs restart, Yamcs cancels the activities that had not ended,
  and fops restores their executions as `crashed`.

### State

The snapshot is `ExecState` (plugin/…/ExecState.java) plus Summary fields:

```
{...Summary, seq, traceLimit, args, options: {byStep, confirmCommands},
 codes: [code events], procedureInfo: <procedure event>|null,
 steps: {index: step event}, current: <line|paused event>|null,
 evaluating: <evaluating event>|null,
 hits: {"code_id:line": n}, suppressed: ["code_id:line"], breakpoints: [line],
 log: [events] (last 2000), commands: [command events] (all),
 prompts: {id: prompt event}, finished: <finished event>|null,
 variables: <variables event>|null}
```

The `procedure` event has `parameters`: the names and dotted names of the
source that are MDB parameters, `{"tm.BusVoltage": {name, units,
description}}` (`name` the qualified name). The console marks them in the
code and subscribes to them (over Yamcs-web's WebSocket, on the instance's
`processor`) to show their live value on hover.

The `log` and `commands` events with a `line` carry `ex`: the hits of that
line (of the main file) when the event arrived, i.e. which execution of the
line it belongs to (the EX column of the item information dialog).. A step's line
counts its attempts (restarts and jumps back included), not the hits of its
decorator: the `line` event a step attempt starts with has `n` = the attempt.

`evaluating` is the latest `evaluating` event of the worker: while a step
goal, `ensures` with `within`, `verify(within=)` or `wait_until` is waited
for, the current values, `{"type":"evaluating", "results": [{condition, ok}],
"left": s}`; during `wait`, the invariants checked meanwhile (the
procedure's and the step's), with `"wait": s`. Sent when the values change
(at most every second) and every 5 s, not journaled. Cleared by the next
`line`, `verify`, `precondition`, `step`, `jump` or end.

A sub-procedure's Summary also has `parentId` and `parentCall` (the
execution that started it, and the call's number there); the State of an
execution that started some has `calls: {call_seq: latest call event}`.

Field names are camelCase in the plugin's own objects; worker events are
passed through unchanged (snake_case), with two fields added by the plugin
to every event: `seq` (event sequence number, per execution, from 1) and
`time` (ISO UTC, when missing). Command records already carry `seq` (the
procedure's command number): the plugin moves it to `command_seq` first;
likewise the `seq` of call records goes to `call_seq`. The
`seq` of the events endpoint and of the State is the event sequence number.

The plugin also emits its own events into the stream:
`{"type":"control", "controller": {user, session}|null, "monitors": [...], "background"}`,
`{"type":"controller_lost", "user", "action": "paused"}`,
`{"type":"killed"}`.

## Worker: controls (stdin) and events (stdout)

Today's controls (`src/protocol.rs`) stay. New ones:

```
{"cmd": "skip"}                        skip the current line (paused only), pause at the next
{"cmd": "goto_line", "line": n}        same function scope only; else an "error" log event
{"cmd": "run_to", "line": n}           temporary breakpoint, then resume
{"cmd": "set_options", "by_step": b?, "confirm_commands": b?}
{"cmd": "get_variables", "request_id": n}           paused/prompt/ended only
{"cmd": "set_variable", "request_id": n, "name": s, "expr": s}
{"cmd": "eval", "request_id": n, "expr": s}         Python, in the paused frame
```

`step` pauses at the next traced line, inside a called function too;
`step_over` pauses at the next line of the same function or its caller.

New and changed events (all Python events also get `line` where there is a
source line, i.e. `log`, `verify`, `waiting`, `wait`, `check`, `sample`,
`precondition`, `watch`, `step` (the decorator's line), `telemetry`, `command`,
`prompt`):

```
procedure  + description (module docstring), author?, args: [ArgSpec]
prompt     + kind: "options"|"text"|"number"|"command", hint?, default?,
             command?: {name, args, significance}     (kind "command")
options    {by_step, confirm_commands}                after set_options
variables  {request_id, frame: {function, line}, locals: {name: {type, repr}},
            globals: {name: {type, repr}}}
eval_result {request_id, expr, ok, output, error?}
output     {stream: "stdout"|"stderr"|"worker", text}  one line, journaled
```

`output`: a line the procedure wrote to `sys.stdout` or `sys.stderr`, or a
message of the worker itself (`stream: "worker"`, `line` 0: Yamcs connection
lost and back, control channel closed...), which also goes to the worker's
stderr. The stderr file (`.log`) keeps what cannot be journaled: messages
before the journal is open, panics, native writes to file descriptor 2, the
final statistics.

Prompts: `ask(question, options=None, *, kind=None, hint=None, default=None)`
returns `str`, or `float` for `kind="number"`; the worker rejects an answer
that does not fit (a `log` event with level `error`, prompt stays open).
With `confirm_commands` on, every `send` asks a `command` prompt; SEVERE and
CRITICAL commands always do.

By step: with `by_step` on, the worker pauses before the body of each step
(a `paused` event with `reason: "step"`).

Start: with `--paused`, the worker loads the procedure (its module runs:
imports and declarations), reports the `procedure` event, then pauses at the
`procedure()` line with `reason: "start"`, before the
preconditions and the first step. A plain script pauses at its first line.

### Arguments

```python
from fops import Arg, procedure
proc = procedure("Battery test", version="2.1",
                 args={"cycles": Arg(int, default=2, description="off/on cycles", min=1, max=10),
                       "battery": Arg(str, choices=["PRIMARY", "SECONDARY"], default="PRIMARY"),
                       "settle": Arg(float, unit="s")})
...  proc.args.cycles ...
```

`fops run --args '<json>'`; missing required args or wrong types end the
run with status `error` before any step. ArgSpec:
`{name, type: "int"|"float"|"str"|"bool", default?, required, description?, choices?, min?, max?, unit?}`.

### Sub-procedures

The plugin starts every worker with `--sub-procedures`; without it,
`run()` raises in the procedure. A call is journaled as `call` events, one
per stage:

```
{"type": "call", "seq": n, "stage": s, "procedure": path, "line": n,
 "args"?: {...}, "options"?: {by_step, confirm_commands},   (starting)
 "id"?: execution, "status"?: s, "confirmation"?: s, "detail"?: s, "time"}
```

Stages: `starting` → `started` (with `id`) or `rejected` (with `detail`),
`waiting` (the caller waits), `aborting` (the caller asks to abort it:
interrupted wait, `.abort()`, its own end), `ended` (`status`,
`confirmation`, `detail` = the final message).

The plugin acts on two stages:

- **starting**: starts an execution of `procedure` with `args` and
  `options`, in the same instance, as the caller's user (who needs
  `fops.Start`), with the caller's controller (none: background). It is an
  activity like any other. Parent and child share their sessions, so
  polling either is presence on both. The worker is answered with
  `{"cmd": "call_started", "seq": n, "id": n}` or
  `{"cmd": "call_started", "seq": n, "error": s}`.
- **aborting**: aborts the child, with the reason
  `{"cmd": "abort", "reason": s}` (the procedure ends with that message
  instead of "Aborted by operator").

When a child ends, its caller's worker gets
`{"cmd": "call_ended", "seq": n, "status": s, "confirmation": s?, "message": s}`.
When a caller ends (any status, crashed included), its children still
running are aborted.

### `fops inspect FILE`

Loads the top level like `fops check` (never the steps) and prints one JSON
object:

```
{path, declaresProcedure, name, version, description, author,
 args: [ArgSpec], requires: s|null, invariant: s|null,
 steps: [{index, name, line, cleanup, goal, requires, invariant, ensures}],
 watches: [{line, condition, then, handler}],
 functions: [{name, line, endLine}],
 check: [{line, message}],
 error: s|null,
 duration: seconds|null,                       // procedure(duration=)
 estimate: {seconds, waits, commands, steps, procedures}|null}
```

`estimate` is how long a run takes, from the source: the `wait()`s whose
duration can be worked out at load time (literals, units, the arguments'
defaults, local variables assigned from those, an `ask()` taken as its
default), times the counts of the `for ... in range()` loops around them;
1 s per step and 2 s per `send`; and the sub-procedures `run()` waits for
(their `duration=`, else their own estimate with the arguments passed; paths
from the working directory, the procedures root). Goals, `wait_until` and
prompts are not counted.

Conditions are their `describe()` text. Exit code 0 even with check
findings; `error` set (and the rest best effort) if the top level fails.
