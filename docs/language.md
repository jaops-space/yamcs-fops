# The fops procedure language

A fops procedure is a Python 3.12 file. It imports telemetry parameters and
telecommands from the package generated from the Yamcs MDB, declares one
`procedure()`, and defines its steps as decorated functions. All of Python
is available; the `fops` package adds conditions, commanding, verification,
operator prompts and the procedure/step structure of ECSS-E-ST-70-32C (see
`ecss-e-st-70-32c-compliance.md` for how fops maps to the standard).

This document is the reference. The README has a shorter overview.

```python
"""Battery check: switches battery 1 off, then on again."""
from fops import procedure, send, wait
from fops.units import V, percent
from mdb.SIMULATOR.tc import SWITCH_VOLTAGE_OFF, SWITCH_VOLTAGE_ON
from mdb.SIMULATOR.tm import BatteryCapacity1, BatteryVoltage1, BusVoltage

proc = procedure("Battery check", version="1.0", requires=BatteryCapacity1 > 40 * percent)

@proc.step("Battery 1 off", goal=BatteryVoltage1 == 0)
def off():
    send(SWITCH_VOLTAGE_OFF(voltage_num=1))

@proc.step("Bus without battery 1", ensures=BusVoltage > 25 * V)
def bus():
    wait(10)

@proc.step("Battery 1 on", goal=BatteryVoltage1 > 20 * V, cleanup=True)
def on():
    send(SWITCH_VOLTAGE_ON(voltage_num=1))
```

## 1. Files

A procedure file:

- calls `procedure(...)` exactly once, at the top level, and keeps the
  result in a variable (by convention `proc`);
- defines at least one step with `@proc.step(...)`;
- may define watchdogs with `proc.watch(...)`;
- has a module docstring, which becomes the procedure's description unless
  `procedure(description=...)` gives one;
- may set `__author__`, used unless `procedure(author=...)` gives one.

The top level is run when the procedure is loaded: by `fops run` before the
first step, and also by `fops check` and `fops inspect`, which never run
steps. Keep the top level free of side effects: no `send()`, `ask()` or
`wait()` there. A mistake found while loading (a syntax error, a
misspelled MDB name, a condition that does not fit the MDB) ends the
execution in error before the first step, with `line N: message`; the
web interface marks that line.

A file that never calls `procedure()` is a **plain script**: the whole file
runs as one step named "Script", with no conditions. Commands are still
tracked and journaled. Scripts take no arguments. `fops check` warns about
them. They are meant for emergencies (see `procedures/battery_off.py`).

## 2. The MDB package

`fops mdb-gen` writes one Python package per Yamcs space system, under
`mdb/`, each with a `tm` module (its parameters) and a `tc` module (its
commands):

| Yamcs                          | Python                                              |
|--------------------------------|-----------------------------------------------------|
| `/SIMULATOR/BusVoltage`        | `from mdb.SIMULATOR.tm import BusVoltage`           |
| `/SIMULATOR/SWITCH_VOLTAGE_ON` | `from mdb.SIMULATOR.tc import SWITCH_VOLTAGE_ON`    |
| the space system               | `from mdb import SIMULATOR` → `SIMULATOR.tm.BusVoltage` |

A parameter and a command may have the same name, since they live in
different modules. Names that are not Python identifiers are sanitized
(`/PUS/tc-ack-start-failure-code` → `tc_ack_start_failure_code`, `from` →
`from_`); a space system named `tm` or `tc` becomes `tm_` / `tc_`.
Import with `as` to rename (`from mdb.PUS19.tm import status_report as event_actions`).
A misspelled name is an `ImportError` at load time, so `fops check` reports
it, with a suggestion.

`fops.param("/SIMULATOR/BusVoltage")` looks a parameter up by its qualified name.
It is meant for the shell, not for procedures.

### 2.1 Parameters

A `Parameter` has a `qualified_name`, a `kind` (`float`, `integer`,
`enumeration`, `boolean`, `string`, `time`, or an array `kind[]`), the
enumeration `labels`, the MDB `units`, a `description`, and `writable`
(a local parameter, which procedures can set). It is typed for
the editor: an enumeration is `Parameter[Literal["EVENT_1", "EVENT_2"]]`.

Reading the current value:

| expression                             | gives |
|----------------------------------------|-------|
| `BusVoltage.value`                     | the latest value (from Yamcs's cache) |
| `BusVoltage.get()`                     | the same |
| `BusVoltage.get(wait=True, timeout=5)` | the next sample to arrive; `VerificationFailed` if none comes within `timeout` s |
| `BusVoltage.get(raw=True)`             | the raw (uncalibrated) value |

Setting a value: `p.set(value)` (§ 5.9).

A parameter is not a value: `if BusVoltage:` raises `TypeError`. For decisions on
several parameters, prefer `snapshot()` (§ 5.4), which samples them together
and journals the sample.

### 2.2 Commands

A command is a function with keyword-only, typed arguments; calling it
builds a `CommandRequest` and sends nothing:

```python
SWITCH_VOLTAGE_ON(voltage_num=1)            # a request
send(SWITCH_VOLTAGE_ON(voltage_num=1))
send(SWITCH_VOLTAGE_ON_ENUM(voltage_num="PRIMARY"))   # an enumerated argument
```

The arguments are checked when the request is built: unknown or missing
arguments, values of the wrong type, enumeration labels that do not exist,
values outside the MDB range. Each problem is an `MdbError`. Arguments with
an MDB default may be left out. A quantity (§ 4) is converted to the
argument's MDB units; a `datetime` to an ISO 8601 UTC string.

The command's MDB `significance` (`SEVERE`, `CRITICAL`) makes `send()` ask
the operator before issuing it (§ 5.1).

## 3. Conditions

Comparing a parameter does not read telemetry: it builds a **condition**,
which the runtime evaluates later against fresh values.

```python
LOW = BatteryCapacity1 < 30 * percent
ALL_ON = (BatteryVoltage1 > 20 * V) & (BatteryVoltage3 > 20 * V)
```

| form                          | holds when |
|-------------------------------|------------|
| `p == x`, `!=`, `<`, `<=`, `>`, `>=` | the comparison holds; `x` is a literal, a quantity or another parameter |
| `p.between(low, high)`        | `low <= p <= high` |
| `p.is_in(a, b, ...)`          | `p` is one of the values |
| `p.rises_by(n)`               | `p` has risen by at least `n` since the baseline |
| `p.falls_by(n)`               | `p` has fallen by at least `n` since the baseline |
| `p.changes()`                 | `p` differs from its baseline value |
| `a & b`, `a \| b`, `~a`       | and, or, not |

Python's `and`, `or`, `not` do not work on conditions: use `&`, `|`, `~`,
and parenthesize the comparisons (`(a == 1) & (b == 2)`), since `&` binds
tighter than `==`.

The operand is checked against the parameter when the condition is built:
`event_id == "EVENT_3"` is an `MdbError` if `EVENT_3` is not a label of
`event_id`, and so is `BusVoltage > "high"`. `rises_by`, `falls_by` take a positive amount and
only apply to numeric parameters.

**Evaluation.** A condition is evaluated on one batch read of all its
parameters. A comparison is false when a parameter has no value, its value
is invalid, or it is NaN. So `~(BusVoltage > 25)` is *true* when
`BusVoltage` has no value: write the condition you want to hold, not the negation of the one
you fear.

**Baselines.** `rises_by`, `falls_by` and `changes` compare with a baseline
taken:

- for a step's `goal=`, `ensures=`, `invariant=`: when the step's body
  starts (after its preconditions);
- for `verify(...)` and `wait_until(...)`: when the call starts;
- for `send(..., confirm=...)`: just before the command is issued;
- elsewhere (e.g. `holds()`, a watchdog): the first value seen.

**A condition is not a boolean.** `if event_id == "EVENT_1":` raises `TypeError`
(and `fops check` reports it). To branch on telemetry, test the condition
with `holds(cond)`, which journals the values it decided on, or compare
values (`if event_id.value == "EVENT_1":`).

Conditions are ordinary Python objects: name them at the top level and
reuse them in steps, watchdogs and calls. Wherever a condition is expected
by a declaration (`requires=`, `goal=`, `ensures=`, `invariant=`), a list
of conditions is also accepted; all must hold, and each is reported
separately.

## 4. Units

`fops.units` defines units; a number times a unit is a quantity:

```python
from fops.units import V, mV, minute
BusVoltage > 25 * V          # same as BusVoltage > 25000 * mV
send(SWITCH_VOLTAGE_ON(voltage_num=1), timeout=5 * minute)
```

In a comparison or a command argument, a quantity is converted to the MDB
units of the parameter or argument. A unit of another kind (`BusVoltage <
5 * A`) is an `MdbError`, and so is a quantity compared with a parameter
without known units. A plain number always means the MDB units.

Every duration (`within=`, `timeout=`, `wait()`) is a number of seconds or
a time quantity.

fops knows the SI units, the units accepted for use with the SI, and a few
more. The MDB unit of a parameter or argument is matched exactly against
these symbols. A parameter whose unit is not among them is compared with
plain numbers only: a quantity against it is an `MdbError`, like a parameter
without units.

| kind | units |
|------|-------|
| SI base | `m`, `kg`, `s`, `A`, `K`, `mol`, `cd` |
| SI derived | `rad`, `sr`, `Hz`, `N`, `Pa`, `J`, `W`, `coulomb`, `V`, `F`, `Ohm` (`Ω`), `S`, `Wb`, `T`, `H`, `degC` (`°C`, `C`), `lm`, `lx`, `Bq`, `Gy`, `Sv`, `kat` |
| composite | `m/s`, `m/s2` (`m/s^2`, `m/s²`), `rad/s`, `Nm` (`N·m`), `Nms` (`N·m·s`) |
| accepted with the SI | `deg` (`°`), `arcmin`, `arcsec`, `deg/s`, `rpm`, `minute` (`min`), `hour` (`h`), `day`, `t`, `bar`, `Wh`, `Ah` |
| data | `B`, `bit`, `bps` |
| ratio, level | `percent` (`%`), `dB`, `dBW`, `dBm` |

The usual SI prefixes apply (`G`, `M`, `k`, `h`, `c`, `m`, `u` or `µ`, `n`,
`p`), where they make sense: `mV`, `kPa`, `nT`, `mAh`, `kbps`, `mNm`. `C` is
degrees Celsius, so the coulomb is spelled out. `dBm` and `dBW` convert
into each other; `dB` is a ratio and converts to nothing else.

`fops.units` has a Python name for each common unit (`V`, `mV`, `kPa`,
`nT`, `degC`, `rpm`, `percent`, ...). The variants in parentheses, and
symbols such as `m/s` or `deg/s`, are only matched in the MDB.

`q.to(unit)` gives the magnitude of a quantity in another unit of the same
kind. A quantity is not a number: `if 5 * s:` raises `TypeError`.

## 5. Operations

These are the calls made in step bodies. Each one is journaled in the
as-run log.

### 5.1 `send`

```python
send(request, *, confirm=None, within=10, timeout=120, wait=True,
     until="complete", on_failure="ask", comment=None, options=None) -> CommandResult | Sent
```

Sends a command and follows it through Yamcs: issuing, issued, each
acknowledgement, then completed, failed or timeout. Every stage is journaled
and fsynced.

1. If the command is `SEVERE` or `CRITICAL`, or the execution runs with the
   `confirm_commands` option, the operator is asked first (a `command`
   prompt showing the command, its arguments and significance). CANCEL
   raises `CommandFailed`.
2. The command is issued.
3. `send` waits until Yamcs reports it complete (its MDB verifiers), at
   most `timeout` seconds, or until the stage given by `until`.
4. With `confirm=`, it then waits up to `within` seconds for the condition,
   the command's effect on telemetry, to hold.

It returns a `CommandResult`: `name`, `ok`, `stage`, `id` (the Yamcs
command id), `detail`, `duration` (s), and `confirmation` (`"confirmed"`,
`"not confirmed"`, or `"not available"` when the operator skipped a
failure).

**Command options.** `options` sets the Yamcs extra command options, by
their Yamcs id: those the links and services of the Yamcs instance
register, such as `cop1Bypass` for a COP-1 link. Values are bools,
numbers, strings or datetimes (naive: UTC). Yamcs rejects an option it does
not know, and the command fails with stage `rejected`; issuing options
needs the `CommandOptions` system privilege. The options are journaled with
the command and shown in its confirmation prompt.

```python
send(SWITCH_VOLTAGE_ON(voltage_num=1), options={"cop1Bypass": True})
```

**Waiting for a stage.** `until` stops the waiting at an earlier stage of
the command; it is still followed to completion and journaled:

| `until` | waits for |
|---|---|
| `"complete"` (default) | `CommandComplete`: every verifier of the command |
| `"issued"` | nothing: Yamcs accepted the command |
| `"queued"`, `"released"`, `"sent"` | the acknowledgement `Acknowledge_Queued`, `Acknowledge_Released`, `Acknowledge_Sent` |
| a verifier stage of the command in the MDB: `"Accepted"`, `"Started"`... | `Verifier_Accepted`, `Verifier_Started`... |
| a full Yamcs name: `"Verifier_Started"`, `"Acknowledge_Sent"`, or any other acknowledgement | that one |

The `CommandResult`'s `stage` is then that acknowledgement's name. An
acknowledgement reported NOK fails the command, as does one never reported
by the time the command ends. `confirm=` is checked once the stage is
reached.

The generated MDB knows each command's verifier stages (inherited ones
included): `send()` refuses a stage the command does not have before
issuing it, and `fops check` (so VS Code too) reports it, with the closest
stage. VS Code completes `until="` with the stages of the command. The
acknowledgements (`queued`, `sent`...) depend on the links, and are not
checked.

```python
send(SWITCH_VOLTAGE_ON(voltage_num=1), until="Started")   # the spacecraft started executing it
send(SWITCH_VOLTAGE_ON(voltage_num=2), until="sent")      # on its way: the link sent it
```

**Failures.** On a failed or timed-out command, the operator chooses RESEND,
SKIP, FAIL STEP or ABORT; on a completed command whose `confirm=` does not
hold, RECHECK, RESEND, SKIP, FAIL STEP or ABORT (see § 5.6).

**Not waiting.** `send(..., wait=False)` returns a `Sent` handle as soon as
the command is issued. `.wait()` does steps 3 and 4 and returns the
`CommandResult` (later calls return the same result). Acknowledgements are
followed in the background either way: a command whose wait was interrupted
(by a jump, say) is journaled `abandoned`, then still `completed`.

```python
a = send(SWITCH_VOLTAGE_ON(voltage_num=1), wait=False)
send(SWITCH_VOLTAGE_ON(voltage_num=2))   # both issued before waiting
a.wait()
```

`comment=` is stored with the command in the Yamcs command history.

### 5.2 `verify`

```python
verify(*conditions, within=0, on_failure="ask") -> bool
```

Checks the conditions now, or on each update of their parameters (and at
least every 0.5 s) until all hold, at most
`within` seconds. Returns `True`; on failure the operator chooses RECHECK,
SKIP, FAIL STEP or ABORT, and SKIP returns `False`.

### 5.3 `wait_until`, `wait`

```python
wait_until(condition, *, within, poll=0.5, on_failure="ask") -> bool
wait(seconds)              # or wait(until=datetime | "2026-11-06T12:00:00Z")
```

`wait_until` waits for one condition; `within` is required. It fails like
`verify`. `wait` waits a duration or until a UTC time (a naive `datetime`
is taken as UTC). The operator can pause, abort or jump during any wait,
and watchdogs and invariants interrupt it.

### 5.4 `holds`, `snapshot`

```python
holds(condition) -> bool
snapshot(*params) -> Snapshot
```

`holds` evaluates a condition now, for branching, and journals the values.
It never fails or asks.

`snapshot` reads several parameters in one request, so that decisions see
one consistent state, and journals the sample. A `Snapshot` gives
`s[param]` (the value, `None` if missing), `s.valid(param)`,
`s.holds(condition)` and `s.explain(condition)` (evaluated on the sample,
whose parameters must all be in it), and `s.time`.

```python
p = snapshot(BatteryCapacity1, BatteryTemperature1, BusVoltage)
if p[BatteryCapacity1] < 40 and p[BatteryTemperature1] < 45:
    log("bus at %d V, battery 1 at %.0f %%" % (p[BusVoltage], p[BatteryCapacity1]))
```

### 5.5 Operator interaction and ending

```python
ask(question, options=None, *, kind=None, hint=None, default=None)
log(message, level="info")
finish(message="Completed")
abort(message="Aborted by the procedure")
```

`ask` blocks until the operator answers:

| call                              | returns |
|-----------------------------------|---------|
| `ask("GO?", ["GO", "NO-GO"])`     | one of the options (a `str`) |
| `ask("Target name?")`             | free text |
| `ask("Exposure?", kind="number")` | a `float` |

`hint=` is shown with the question; `default=` is proposed, and an empty
answer takes it (for options, it must be one of them). An answer that does
not fit is refused and the prompt stays open.

`log` writes a message for the operator; `level` is `"info"`, `"warning"`
or `"error"`.

Whatever the procedure writes to `sys.stdout` or `sys.stderr` (`print()`,
warnings, a library's messages) is journaled too, a line at a time, as
`output` entries: a line without its newline waits for it or the end of
the procedure. Prefer `log` for what the operator should read.

`finish` ends the procedure successfully at once; `abort` aborts it. Both
run the cleanup steps (§ 6.4) first.

### 5.6 Failures: `on_failure`

`send`, `verify`, `wait_until` and `run` either succeed or fail. `on_failure=`
says what a failure does:

| value     | effect |
|-----------|--------|
| `"ask"` (default) | the operator chooses: retry (RESEND / RECHECK), SKIP (go on as if it had succeeded; journaled as skipped), FAIL STEP (the step ends not confirmed) or ABORT |
| `"raise"` | raise `CommandFailed`, `VerificationFailed` or `ProcedureFailed`, for the procedure to catch |
| `"skip"`  | log a warning and go on |

These exceptions derive from `OperationFailed`. Uncaught in a step body, an
`OperationFailed` ends the step **not confirmed**; any other exception ends
it **aborted** (§ 6.2).

```python
try:
    send(SWITCH_VOLTAGE_ON(voltage_num=3), on_failure="raise")
except CommandFailed as e:
    log("battery 3 refused (%s), trying battery 2" % e, level="warning")
    send(SWITCH_VOLTAGE_ON(voltage_num=2))
```

### 5.7 `run`: sub-procedures

```python
run(procedure, *, args=None, wait=True, on_failure="ask") -> ProcedureResult | Running
```

Runs another procedure, a path in the procedures directory
(`"power_cycle.py"`; `.py` may be left out), with `args`, and waits for it
to end. It runs as its own execution: its own worker, as-run journal, page
in the UI and Yamcs activity, started by the same user. Its controller is
the caller's (none if the caller runs in the background), and the two share
their presence: watching either keeps the controller in control of both.
It inherits the caller's options (step by step, confirm commands), not its
breakpoints.

It returns a `ProcedureResult`: `procedure`, `id` (the execution), `status`
(`finished`, `aborted`, `error`, `crashed`, `killed`, or `rejected` when it
could not be started), `confirmation`, `message`, `duration` (s) and `ok`
(finished and confirmed). `confirmation` is the sub-procedure's own
(`"confirmed"`, `"not confirmed"`, `"not available"` after `finish()`),
`"aborted"` if it did not finish, or `"not available"` when the operator
skipped the failure.

**Failures.** A sub-procedure that does not end confirmed is a failure: the
operator chooses RESTART (run it again, as a new execution), SKIP, FAIL STEP
or ABORT, unless `on_failure=` says otherwise (§ 5.6). Bad arguments end it
with status `error` before any step.

**Not waiting.** `run(..., wait=False)` returns a `Running` handle once the
sub-procedure has started: `.id`, `.wait()` (does the rest and returns the
`ProcedureResult`) and `.abort(reason)`.

**Ending.** An abort, a jump or a violated invariant while the caller waits
aborts the sub-procedure (its cleanup steps run). A sub-procedure still
running when its caller ends is aborted too.

```python
@proc.step("Functional test")
def functional():
    r = run("battery_test.py", args={"cycles": 2})
    log("battery test: %s in %.0f s" % (r.confirmation, r.duration))
```

Sub-procedures need the Yamcs plugin: under `fops run` alone or `fops
serve`, `run` raises `RuntimeError`.

### 5.8 `yamcs_client`: the rest of Yamcs

```python
yamcs_client() -> yamcs.client.YamcsClient
```

For what the language does not cover (links, the archive, buckets, the
timeline, events, alarms, file transfers), a client of the
[yamcs-client](https://docs.yamcs.org/python-yamcs-client/) package,
connected to the procedure's Yamcs as the operator running it: it has the
operator's privileges, and its token is renewed with theirs.
`client.instance` and `client.processor` are the procedure's. Every call
returns the same client.

```python
from fops import log, yamcs_client

@proc.step("Enable the uplink")
def uplink():
    client = yamcs_client()
    client.get_link(client.instance, "tc_realtime").enable_link()
    for link in client.list_links(client.instance):
        log("%s: %s" % (link.name, link.status))
```

The package is not part of fops: install it in the workers' Python
(`pip install yamcs-client`; in remote mode, the runners'). Without it,
`yamcs_client()` raises `ImportError`; without a Yamcs connection,
`RuntimeError`.

Use the language where it has the operation: `send` and the parameters
journal, verify and confirm, the client does none of that. Its calls are
not in the as-run journal (`log` what matters), and a pause or an abort
waits for the call in progress to return.

### 5.9 `p.set`: local parameters

```python
p.set(value, *, on_failure="ask") -> bool
```

Sets the value of a **local** parameter in Yamcs: one whose MDB data
source is `local` (`<ParameterProperties dataSource="local"/>`), served by
the processor's `LocalParameterManager`. These are the writable
parameters: flags, setpoints, counters kept on the ground. The generated
MDB marks them (`writable=True`); setting any other parameter is an
`MdbError`, and so is a value that does not fit it (checked like a
comparison operand: an enumeration label, a bool, a number; a quantity is
converted to the MDB units, a naive `datetime` is UTC). Arrays and
aggregates cannot be set: use `yamcs_client()`.

`AllowCriticalTC1 = True` does not set anything: in a function, Python
makes it a local variable hiding the parameter. A step or watch handler
that assigns to the name of a parameter or command is refused when the
procedure is loaded, so the procedure does not start, and `fops check`
reports it. `p.value = x` raises `AttributeError`.

```python
from mdb.SIMULATOR.tm import AllowCriticalTC1

@proc.step("Allow critical commands", goal=AllowCriticalTC1 == True)
def allow():
    AllowCriticalTC1.set(True)
```

Each set is journaled (fsynced) with its outcome, and shown on its line.
If Yamcs refuses it (no `LocalParameterManager`, a value it cannot convert,
missing privileges), the operator chooses RETRY, SKIP, FAIL STEP or ABORT;
SKIP returns `False`, `on_failure="raise"` raises `SetFailed`. Yamcs needs
the `WriteParameter` object privilege on the parameter. Like `send`, `set`
cannot be called from the shell of a paused procedure.

Yamcs processes the new value like any other: the next read, condition or
`verify` sees it, possibly a few milliseconds later.

## 6. Procedures and steps

### 6.1 `procedure`

```python
proc = procedure(name, *, version="0", description=None, author=None,
                 requires=None, ensures=None, invariant=None, within=10,
                 args=None, duration=None)
```

| parameter    | meaning |
|--------------|---------|
| `requires=`  | must hold before the first step. If not, the operator chooses RECHECK, OVERRIDE (journaled) or ABORT. |
| `invariant=` | must hold while the steps run, checked on each update of its parameters (at least every second) from the first step on. A violation aborts the procedure (the cleanup steps then run). |
| `ensures=`   | must hold, within `within` seconds, after the last step. It decides the procedure's confirmation status (§ 6.5). |
| `args=`      | the procedure's arguments (§ 6.6). |
| `duration=`  | how long a run usually takes (seconds or a time quantity, e.g. `5 * minute`), for planning: the duration the Schedule dialog proposes for the timeline. Without it the dialog proposes the median of the last runs, else an estimate from the source (the waits it can work out, a little per step and per command, the sub-procedures). |

### 6.2 `proc.step`

```python
@proc.step(name, *, requires=None, goal=None, ensures=None, invariant=None,
           within=10, cleanup=False, on_unconfirmed="ask", on_aborted="abort",
           restarts=1)
def body():
    """Description of the step, shown to the operator."""
    ...
```

Steps run in the order they are defined. The body takes no arguments; the
docstring is its description.

| parameter    | meaning |
|--------------|---------|
| `goal=`      | the step's purpose. If it already holds when the step starts, the step is skipped (confirmed, "goal already holds"), so a procedure can be re-run after an interruption. Otherwise the values it did not hold on are journaled, and it must hold within `within` s after the body. |
| `requires=`  | must hold before the body. If not, the operator chooses RECHECK, OVERRIDE, SKIP STEP or ABORT. Not checked when the goal already holds. |
| `ensures=`   | must hold within `within` s after the body. |
| `invariant=` | must hold while the body runs, checked on each update of its parameters (at least every second). A violation interrupts the body (whatever it is doing: a wait, a command, a prompt, a loop) with `InvariantViolated`, and the step ends not confirmed. |
| `within=`    | seconds (or a time quantity) for `goal` and `ensures` to hold after the body. |
| `cleanup=`   | a cleanup step (§ 6.4). |
| `on_unconfirmed=`, `on_aborted=`, `restarts=` | the continuation (§ 6.3). |

A step with an empty body and a `goal=` and a long `within=` is a way to
wait for something while saying why:

```python
@proc.step("Battery charged", goal=BatteryCapacity1 >= 40 * percent, within=10 * minute)
def charged():
    """Skipped if the battery is charged, otherwise awaited for 10 minutes."""
```

### 6.3 Step lifecycle and continuation

Each step goes through the execution states of ECSS-E-ST-70-32C:

```mermaid
flowchart LR
    pre["preconditions<br/>(goal, requires)"] --> exe["executing<br/>(the body)"] --> conf["confirmation<br/>(goal, ensures)"] --> done[completed]
```

and ends with a confirmation status:

| status          | when |
|-----------------|------|
| `confirmed`     | the body returned and `goal`/`ensures` held (or there were none), or the goal held from the start, or the body called `finish()` |
| `not confirmed` | `goal`/`ensures` did not hold in time, the invariant was violated, or an operation failed (`OperationFailed`, including FAIL STEP) |
| `aborted`       | the body raised any other exception, or the procedure was aborted during the step |
| `not available` | the operator skipped the step (SKIP STEP), or a jump interrupted it |

What follows is the step's **continuation**:

| status          | continuation |
|-----------------|--------------|
| confirmed, not available | the next step |
| not confirmed   | `on_unconfirmed=` (default `"ask"`) |
| aborted         | `on_aborted=` (default `"abort"`) |

with one of:

| value        | effect |
|--------------|--------|
| `"continue"` | the next step (journaled) |
| `"ask"`      | the operator chooses RESTART STEP, CONTINUE or ABORT |
| `"abort"`    | abort the procedure |
| `"restart"`  | run the step again, at most `restarts` times, then ask |

A restarted step goes through its preconditions again, so a goal reached
in the meantime skips it.

### 6.4 Cleanup steps

A step with `cleanup=True` runs in its place like any other step, and
also when the procedure aborts or calls `finish()` before reaching it: the
cleanup steps after the current one then run, in order, before the
procedure ends. Give them a `goal=` so that they cost nothing when there
is nothing to undo. During the cleanup, jumps are ignored and an abort
stops the cleanup itself.

```python
@proc.step("Battery 1 on", goal=BatteryVoltage1 > 20 * V, cleanup=True)
def on():
    ...
```

### 6.5 How a procedure ends

| outcome    | when |
|------------|------|
| finished, confirmed | the last step completed, and `ensures=` held; without `ensures=`, every step was confirmed |
| finished, not confirmed | `ensures=` did not hold; without it, some step was not confirmed, aborted and continued, or skipped |
| finished   | `finish(message)` was called |
| aborted    | `abort()`, an operator ABORT, a failed precondition, a violated procedure invariant, a watchdog with `then="abort"`, or a step continuation `"abort"` |
| error      | the top level raised, the arguments did not fit, or the file declares no or several procedures |

### 6.6 Arguments

```python
from fops import Arg, procedure

proc = procedure("Battery cycles", args={
    "count": Arg(int, default=3, min=1, max=10, description="off/on cycles"),
    "battery": Arg(str, choices=["PRIMARY", "SECONDARY", "BACKUP"]),
    "off_time": Arg(float, default=0.5, unit="s"),
})

@proc.step("Cycles")
def cycles():
    for k in range(proc.args.count):
        send(SWITCH_VOLTAGE_OFF(voltage_num=1))
        wait(proc.args.off_time)
        send(SWITCH_VOLTAGE_ON_ENUM(voltage_num=proc.args.battery))
```

```python
Arg(type, *, default=<required>, description=None, choices=None,
    min=None, max=None, unit=None)
```

`type` is `int`, `float`, `str` or `bool` (or their names as strings). An
argument without a default is required. `min`/`max` apply to numbers;
`unit` is informative only (shown in the start form), values are not
converted.

Values come from `fops run --args '{"count": 5}'` or the start form of the
web UI; strings are parsed (`"5"`, `"true"`). Missing, unknown or ill-typed
arguments end the run with status `error` before any step. They are read as
`proc.args.count`, at the top level or in steps, and are read-only.
`for name, value in proc.args:` iterates over them.

### 6.7 Watchdogs

```python
proc.watch(condition, *, then=None, message=None)
```

A watchdog reacts when its condition **becomes** true (it fires once, and
again only after the condition has been false). It is checked on each
update of its parameters (at least every second) from the first step to
the end of the cleanup, not during the procedure's preconditions.

Without a handler, `then=` is what happens:

| `then`   | effect |
|----------|--------|
| `"pause"` (default) | pause the procedure, for the operator |
| `"abort"` | abort the procedure (cleanup steps run) |
| `"log"`   | only journal it |

Used as a decorator, the function is a **handler**. It runs on the
procedure's thread, interrupting whatever the procedure was doing (a wait,
a command, a prompt, a pure-Python loop), and may send commands, wait and
ask. Then `then=` says what follows: `"resume"` (default, the interrupted
code goes on), `"pause"` or `"abort"`. A handler that raises asks the
operator to RESUME or ABORT.

```python
@proc.watch(BatteryCapacity1 < 30 * percent, then="abort")
def low_battery():
    """Battery 1 below 30 %: switch it off, abort"""
    send(SWITCH_VOLTAGE_OFF(voltage_num=1), confirm=BatteryVoltage1 == 0)
```

`message=` (or the first line of the handler's docstring, or the
condition) is what the operator sees.

A procedure `invariant=c` is a watchdog on `~c` with `then="abort"`.

## 7. Exceptions

| exception            | raised by | caught by a step body? |
|----------------------|-----------|------------------------|
| `MdbError`           | a condition or command request that does not fit the MDB | yes (`Exception`) |
| `OperationFailed`    | base of the next five | yes |
| `CommandFailed`      | `send(on_failure="raise")`, or a cancelled command confirmation | yes |
| `SetFailed`          | `p.set(on_failure="raise")` refused by Yamcs | yes |
| `VerificationFailed` | `verify`, `wait_until`, `send(confirm=)` with `on_failure="raise"`; `p.get(wait=True)` without a sample | yes |
| `ProcedureFailed`    | `run(on_failure="raise")` of a sub-procedure that did not end confirmed | yes |
| `InvariantViolated`  | a violated step invariant | yes (an `OperationFailed`); once caught, the invariant is no longer checked for the rest of the step |
| `ArgumentError`      | bad procedure arguments | — |
| `ProcedureAborted`   | `abort()`, operator ABORT | no (`BaseException`) |

`ProcedureAborted` derives from `BaseException`, like the internal
exceptions used for `finish()` and jumps, so that `except Exception:` in a
procedure does not swallow an abort. Do not catch `BaseException`.

## 8. Running under operator control

These are not part of the language, but explain why the code is written
the way it is.

- The procedure runs one traced line at a time. The operator can pause,
  step, set breakpoints, skip a line, jump to a line of the same function,
  jump to another step, and abort. A jump to a step interrupts the current
  one (status not available) and continues from the target step.
- Steps make the procedure restartable: the operator jumps back to a step,
  and goals skip what is already done.
- While paused, the operator can inspect and set variables and evaluate
  Python in the paused frame. Commands and prompts are refused from there.
- With the step-by-step option, the procedure pauses at the start of each
  step; with `confirm_commands`, every `send` asks first.
- Scheduling is not part of the language: a procedure is put on the Yamcs
  timeline as a `PROCEDURE` activity.

## 9. Checking: `fops check`

`fops check FILE...` loads each procedure's top level (imports,
`procedure()`, conditions, watchdogs), never its steps, and scans the
source for:

- MDB names that do not exist (with suggestions);
- comparisons with literals that can never match: unknown enumeration
  labels, a string for a number, a quantity of the wrong kind;
- command calls with unknown or missing arguments or bad literal values;
- conditions used as booleans (`if`, `while`, `assert`);
- `p.set(...)` of a parameter that is not local, or with a literal value
  that does not fit it;
- assignments to an imported parameter or command name
  (`AllowCriticalTC1 = False`), and to `p.value`;
- `run("x.py", args={...})` of a procedure that does not exist (looked up
  next to the `mdb` package), or with literal arguments it does not
  declare, lacks or would refuse.

It exits non-zero on errors; warnings (a plain script) do not count. The VS
Code extension runs it as you type.

## 10. Style

- Name conditions that mean something (`BAT1_ON`, `POWER_OK`) at the top
  level, and reuse them.
- Give each step a `goal=` when it has a checkable outcome: it documents
  the step, confirms it, and makes re-runs cheap.
- Prefer `send(..., confirm=...)` to a `send` followed by `verify`: the
  baseline is taken before the command, and RESEND is offered.
- Branch with `holds()` or a `snapshot()`, not `.value`, so the decision
  is journaled.
- Put "undo" steps last, with `cleanup=True` and a `goal=`.
- Leave `on_failure="ask"` unless the code really handles the failure.
