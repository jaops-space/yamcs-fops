"""The procedure runtime: steps, commanding, verification, operator interaction.

Procedures and steps go through the execution states of ECSS-E-ST-70-32C:

  preconditions -> executing -> confirmation -> completed

and end with a confirmation status: confirmed, not confirmed, aborted (the
body raised) or not available (nothing could be checked, e.g. skipped by the
operator). What happens next is the continuation:

  confirmed       continue
  not confirmed   on_unconfirmed= (default "ask": RESTART STEP, CONTINUE, ABORT)
  aborted         on_aborted=     (default "abort")

with "continue", "ask", "abort" or "restart" (at most `restarts` times, then ask).

Each operation (send, verify, wait_until) either succeeds or fails. On
failure, `on_failure` decides:

  "ask"    (default) the operator chooses: retry (RESEND / RECHECK), SKIP
           (continue as if it had succeeded; journaled as skipped),
           FAIL STEP (the step is not confirmed) or ABORT
  "raise"  raise CommandFailed / VerificationFailed for the procedure to handle
  "skip"   log a warning and continue

Commands, verifications, snapshots, prompts and answers are always journaled.
"""
from __future__ import annotations

import ast
import builtins
import contextlib
import datetime as _dt
import difflib
import dis
import importlib
import io
import json
import os
import reprlib
import sys
import threading
import time
import traceback
import types
import warnings
from typing import Any, Callable, Iterable, Optional, Sequence, Union

import _fops

from fops.items import Command, CommandRequest, Condition, MdbError, Parameter
from fops.units import seconds as _seconds


class ProcedureAborted(BaseException):
    """The procedure stops: operator abort, failed precondition, abort()."""


class ProcedureFinished(BaseException):
    """finish() was called: the procedure ends successfully."""


class StepJump(BaseException):
    """The operator moved execution to another step (internal)."""


class OperationFailed(Exception):
    """A command or verification failed."""


class CommandFailed(OperationFailed):
    pass


class VerificationFailed(OperationFailed):
    pass


class SetFailed(OperationFailed):
    """Yamcs refused to set a parameter."""


class ProcedureFailed(OperationFailed):
    """A sub-procedure did not end confirmed."""


class InvariantViolated(OperationFailed):
    """A step's invariant stopped holding while the step ran."""


class ArgumentError(Exception):
    """The procedure's arguments are missing or do not fit their declaration."""


_MAIN_FILE: Optional[str] = None
# Line reported by events raised outside the procedure's own code (the
# runtime checking a step's conditions): the step's, or the procedure()'s.
_CONTEXT_LINE = 0
_SIGNIFICANT = ("SEVERE", "CRITICAL")
_CONTINUATIONS = ("continue", "ask", "abort", "restart")

Conditions = Union[Condition, Sequence[Condition], None]


def _line() -> int:
    """Line of the innermost frame of the procedure file."""
    f: Any = sys._getframe(1)
    while f is not None:
        if f.f_code.co_filename == _MAIN_FILE:
            return f.f_lineno
        f = f.f_back
    return _CONTEXT_LINE


def _main_frame(f: Any) -> Any:
    """The innermost frame of the procedure file, from `f` outwards."""
    while f is not None and f.f_code.co_filename != _MAIN_FILE:
        f = f.f_back
    return f


def _emit(type: str, sync: bool = False, **fields: Any) -> None:
    fields.setdefault("line", _line())
    _fops.emit(json.dumps({"type": type, **fields}, default=str), True, sync)


class _Output(io.TextIOBase):
    """sys.stdout / sys.stderr while a procedure runs: each line is journaled
    as an `output` event (the worker's stdout is the event stream, and its
    stderr the log file). A line without its newline waits for it, or for
    flush()."""

    def __init__(self, stream: str):
        self.stream = stream
        self._buf = ""
        self._buf_line = 0  # where the line in _buf was started
        self._lock = threading.RLock()
        self._busy = False

    def writable(self) -> bool:
        return True

    def write(self, s: str) -> int:
        with self._lock:
            if self._busy:  # written while emitting: would loop
                sys.__stderr__.write(s)
                return len(s)
            if not self._buf:
                self._buf_line = _line()
            self._buf += s
            *lines, self._buf = self._buf.split("\n")
            self._send(lines, self._buf_line)
            if lines:
                self._buf_line = _line()
        return len(s)

    def flush(self) -> None:
        with self._lock:
            if self._buf and not self._busy:
                lines, self._buf = [self._buf], ""
                self._send(lines, self._buf_line)

    def _send(self, lines: list[str], line: int) -> None:
        self._busy = True
        try:
            for text in lines:
                _emit("output", stream=self.stream, text=text, line=line)
        finally:
            self._busy = False


def _emit_live(type: str, **fields: Any) -> None:
    """An event for the operator only, not journaled."""
    fields.setdefault("line", _line())
    _fops.emit(json.dumps({"type": type, **fields}, default=str), False)


# --- reading telemetry ------------------------------------------------------------
def _fetch(params: Iterable[Parameter]) -> dict[str, tuple[Any, bool]]:
    names = sorted({p.qualified_name for p in params})
    if not names:
        return {}
    return _fops.get_values(names)


def read(param: Parameter, wait: bool = False, timeout: float = 5.0, raw: bool = False) -> Any:
    vals = _fops.get_values([param.qualified_name], wait, timeout, raw, _line(), True)
    if param.qualified_name not in vals:
        raise VerificationFailed("no value for %s%s" % (param.qualified_name, " within %ss" % timeout if wait else ""))
    return vals[param.qualified_name][0]


def write(param: Parameter, value: Any, on_failure: str = "ask") -> bool:
    """Parameter.set(): sets a local parameter in Yamcs. The outcome is
    journaled (fsynced); on failure the operator chooses RETRY, SKIP,
    FAIL STEP or ABORT."""
    if _SERVING:
        raise RuntimeError("parameters cannot be set from the shell")
    v = param.set_value(value)
    _fops.pause_point(_line())
    if isinstance(v, _dt.datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=_dt.timezone.utc)
        v = v.astimezone(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    while True:
        error = _fops.set_value(param.qualified_name, param.kind, v)
        _emit("set", sync=True, name=param.qualified_name, value=v, units=param.units, ok=error is None, detail=error)
        if error is None:
            return True
        msg = "Cannot set %s to %r: %s" % (param.qualified_name, v, error)
        if _failure(msg, ["RETRY", "SKIP", "FAIL STEP", "ABORT"], on_failure, SetFailed(msg)) != "RETRY":
            return False


def _conditions(c: Conditions, what: str) -> tuple[Condition, ...]:
    """A condition or a list of them, checked."""
    if c is None:
        return ()
    items = (c,) if isinstance(c, Condition) else tuple(c)
    for x in items:
        if not isinstance(x, Condition):
            raise TypeError("%s: expected a telemetry condition (like BusVoltage > 25), got %r" % (what, x))
    return items


def _set_baselines(conditions: Sequence[Condition]) -> None:
    """Sets the baseline of rises_by()/falls_by()/changes() to the current values."""
    leaves = [x for c in conditions for x in c.leaves() if hasattr(x, "set_baseline")]
    if leaves:
        values = _fetch(p for x in leaves for p in x.params())
        for x in leaves:
            x.set_baseline(values)


def _evaluate(conditions: Sequence[Condition], within: float, poll: float = 0.5) -> tuple[bool, list[dict]]:
    """Tests the conditions until every one holds or `within` seconds have
    passed: again on each update of their parameters, and at least every
    `poll` seconds. While waiting, the values are shown to the operator
    (an "evaluating" event when they change, at most every second)."""
    params = [p for c in conditions for p in c.params()]
    names = sorted({p.qualified_name for p in params})
    deadline = time.monotonic() + within
    shown, shown_at = None, 0.0
    while True:
        values = _fetch(params)
        oks = [c.test(values) for c in conditions]
        now = time.monotonic()
        left = deadline - now
        if all(oks) or left <= 0:
            return all(oks), [{"condition": c.explain(values), "ok": ok} for c, ok in zip(conditions, oks)]
        if now - shown_at >= 1.0:
            results = [{"condition": c.explain(values), "ok": ok} for c, ok in zip(conditions, oks)]
            # again every few seconds: a line run meanwhile (a watch handler) clears it
            if results != shown or now - shown_at >= 5.0:
                _emit_live("evaluating", results=results, left=round(left, 1))
                shown, shown_at = results, now
        _fops.wait_change(names, min(poll, left))


def _failure(message: str, options: Sequence[str], on_failure: str, exc: Exception) -> str:
    if on_failure == "raise":
        raise exc
    if on_failure == "skip":
        log("%s (skipped: on_failure='skip')" % message, level="warning")
        return "SKIP"
    answer = ask(message, list(options))
    if answer == "ABORT":
        raise ProcedureAborted(message)
    if answer == "FAIL STEP":
        raise exc
    return answer


# --- the procedure API -------------------------------------------------------------
def log(message: Any, level: str = "info") -> None:
    """A message for the operator, journaled."""
    _emit("log", message=str(message), level=level)


_KINDS = ("options", "text", "number", "command")


def ask(question: str, options: Optional[Sequence[str]] = None, *, kind: Optional[str] = None,
        hint: Optional[str] = None, default: Any = None) -> Any:
    """Asks the operator and returns the answer.

    kind="options" (the default with options): one of the options
    kind="text" (the default without options): free text
    kind="number": a number, returned as a float
    `hint` is shown with the question, `default` is proposed as the answer."""
    if kind is None:
        kind = "options" if options else "text"
    if kind not in _KINDS or kind == "command":
        raise ValueError("ask(kind=...) must be 'options', 'text' or 'number', not %r" % (kind,))
    opts = [str(o) for o in options or []]
    if kind == "options" and not opts:
        raise TypeError("ask(kind='options') needs options")
    if kind != "options" and opts:
        raise TypeError("ask(kind=%r) takes no options" % kind)
    if default is not None:
        if kind == "number" and (isinstance(default, bool) or not isinstance(default, (int, float))):
            raise TypeError("ask(kind='number'): default must be a number, not %r" % (default,))
        if kind == "options" and str(default) not in opts:
            raise ValueError("ask(): default %r is not one of the options" % (default,))
    answer = _prompt(str(question), opts, kind, hint, default)
    return float(answer) if kind == "number" else answer


def _prompt(question: str, options: list[str], kind: str, hint: Optional[str] = None, default: Any = None,
            command: Optional[dict] = None) -> str:
    if _SERVING:
        raise RuntimeError("prompts are not available from the shell")
    return _fops.prompt(question, options, _line(), kind, None if hint is None else str(hint),
                        None if default is None else str(default),
                        None if command is None else json.dumps(command, default=str))


def wait(seconds: Any = None, *, until: Union[_dt.datetime, str, None] = None) -> None:
    """Waits `seconds` (a number or a time quantity), or until a UTC time
    (a datetime or an ISO 8601 string). The operator can still abort or jump."""
    if (seconds is None) == (until is None):
        raise TypeError("wait() takes a duration or until=, not both")
    if until is not None:
        t = _dt.datetime.fromisoformat(until.replace("Z", "+00:00")) if isinstance(until, str) else until
        if t.tzinfo is None:
            t = t.replace(tzinfo=_dt.timezone.utc)
        secs = (t - _dt.datetime.now(_dt.timezone.utc)).total_seconds()
        _emit("wait", seconds=max(secs, 0.0), until=t.isoformat())
        _sleep(max(secs, 0.0))
        return
    secs = _seconds(seconds)
    _emit("wait", seconds=secs)
    _sleep(secs)


def _sleep(secs: float) -> None:
    """Sleeps, showing the operator the time left and the values of the
    invariants checked meanwhile ("evaluating" events, as _evaluate)."""
    w = _WATCHER
    conditions = list(w.invariant) + (list(w.step.invariant) if w.step else [])
    params = [p for c in conditions for p in c.params()]
    end = time.monotonic() + secs
    shown, shown_at = None, 0.0
    while True:
        now = time.monotonic()
        left = end - now
        if left <= 0:
            return
        values = _fetch(params) if params else {}
        results = [{"condition": c.explain(values), "ok": c.test(values)} for c in conditions]
        # again every few seconds: a line run meanwhile (a watch handler) clears it
        if results != shown or now - shown_at >= 5.0:
            _emit_live("evaluating", results=results, left=round(left, 1), wait=secs)
            shown, shown_at = results, now
        _fops.sleep(min(1.0, left))


def verify(*conditions: Condition, within: Any = 0.0, on_failure: str = "ask") -> bool:
    """Checks telemetry conditions, now or (with `within`) until they hold.
    Returns True, or False if the operator chose SKIP."""
    conditions = _conditions(list(conditions), "verify()")
    within = _seconds(within)
    _set_baselines(conditions)
    while True:
        ok, results = _evaluate(conditions, within)
        _emit("verify", sync=True, ok=ok, results=results)
        if ok:
            return True
        failed = "; ".join(r["condition"] for r in results if not r["ok"])
        answer = _failure("Verification failed: " + failed, ["RECHECK", "SKIP", "FAIL STEP", "ABORT"],
                          on_failure, VerificationFailed(failed))
        if answer != "RECHECK":
            return False


def wait_until(condition: Condition, *, within: Any, poll: float = 0.5, on_failure: str = "ask") -> bool:
    """Waits until the condition holds, at most `within` seconds."""
    _conditions(condition, "wait_until()")
    within = _seconds(within)
    _set_baselines([condition])
    while True:
        _emit("waiting", condition=condition.describe(), within=within)
        ok, results = _evaluate([condition], within, poll)
        _emit("verify", sync=True, ok=ok, results=results, waited=within)
        if ok:
            return True
        msg = "Not reached within %ss: %s" % (within, results[0]["condition"])
        answer = _failure(msg, ["RECHECK", "SKIP", "FAIL STEP", "ABORT"], on_failure, VerificationFailed(msg))
        if answer != "RECHECK":
            return False


def holds(condition: Condition) -> bool:
    """Whether the condition holds now: for branching (`if holds(BAT1_ON):`).
    The values it was decided on are journaled."""
    _conditions(condition, "holds()")
    ok, results = _evaluate([condition], 0.0)
    _emit("check", ok=ok, results=results)
    return ok


class Snapshot:
    """Values of several parameters sampled together: decisions taken on a
    snapshot see one consistent state, and the snapshot is journaled."""

    def __init__(self, params: Sequence[Parameter], values: dict[str, tuple[Any, bool]]):
        self.params = tuple(params)
        self._values = values
        self.time = _dt.datetime.now(_dt.timezone.utc)

    def _get(self, p: Parameter) -> tuple[Any, bool]:
        if not isinstance(p, Parameter) or p.qualified_name not in {x.qualified_name for x in self.params}:
            raise KeyError("%r is not in this snapshot" % (p,))
        return self._values.get(p.qualified_name, (None, False))

    def __getitem__(self, p: Parameter) -> Any:
        return self._get(p)[0]

    def valid(self, p: Parameter) -> bool:
        return self._get(p)[1]

    def holds(self, condition: Condition) -> bool:
        """The condition evaluated on the snapshot (its parameters must be in it)."""
        for p in condition.params():
            self._get(p)
        return condition.test(self._values)

    def explain(self, condition: Condition) -> str:
        return condition.explain(self._values)

    def __repr__(self) -> str:
        return "<snapshot %s>" % ", ".join("%s=%r" % (p.qualified_name, self[p]) for p in self.params)


def snapshot(*params: Parameter) -> Snapshot:
    """Samples the parameters together (one request to Yamcs)."""
    for p in params:
        if not isinstance(p, Parameter):
            raise TypeError("snapshot() takes telemetry parameters, got %r" % (p,))
    values = _fetch(params)
    s = Snapshot(params, values)
    _emit("sample", sync=True, time=s.time.isoformat(),
          values={p.qualified_name: {"value": values.get(p.qualified_name, (None, False))[0],
                                     "valid": values.get(p.qualified_name, (None, False))[1],
                                     "units": p.units} for p in params})
    return s


# --- commanding ---------------------------------------------------------------------
class CommandResult:
    """How a command ended. `confirmation` is "confirmed" (completed, and its
    effect seen if a confirm= was given), "not confirmed", or "not available"
    when the operator skipped the failure."""

    def __init__(self, name: str, ok: bool, stage: str, id: Optional[str], detail: Optional[str],
                 duration: float, skipped: bool = False):
        self.name, self.ok, self.stage, self.id = name, ok, stage, id
        self.detail, self.duration, self.skipped = detail, duration, skipped
        self.confirmation = "confirmed" if ok else "not available" if skipped else "not confirmed"

    def __repr__(self) -> str:
        return "<%s %s, %s in %.1fs>" % (self.name, self.stage, self.confirmation, self.duration)


_ACKNOWLEDGEMENTS = {"queued": "Acknowledge_Queued", "released": "Acknowledge_Released", "sent": "Acknowledge_Sent"}


def _until(until: str) -> Optional[str]:
    """The acknowledgement send(until=) waits for: None for completion, ""
    for issued, else its Yamcs name ("Verifier_Started" for "Started")."""
    if not isinstance(until, str) or not until:
        raise TypeError("send(until=) takes a stage name, e.g. 'complete', 'sent' or 'Started', not %r" % (until,))
    if until == "complete":
        return None
    if until == "issued":
        return ""
    if until in _ACKNOWLEDGEMENTS:
        return _ACKNOWLEDGEMENTS[until]
    if until.startswith(("Acknowledge_", "Verifier_")) or until == "CommandComplete":
        return until
    return "Verifier_" + until


def _stage_problem(command: Command, until: str) -> Optional[str]:
    """Why send(command, until=) names a verifier the command does not have
    in the MDB, or None. Acknowledgements depend on the links: not checked."""
    ack = _until(until)
    if not ack or not ack.startswith("Verifier_") or command.verifiers is None:
        return None
    stage = ack[len("Verifier_"):]
    if stage in command.verifiers:
        return None
    close = difflib.get_close_matches(stage, command.verifiers, n=1) or [
        v for v in command.verifiers if v.lower() == stage.lower()]
    return "%s has no verifier %r%s (its verifiers: %s)" % (
        command.qualified_name, stage, " (did you mean %r?)" % close[0] if close else "",
        ", ".join(command.verifiers) or "none")


def _command_options(options: Optional[dict]) -> dict:
    """send(options=) as JSON values; a datetime (naive: UTC) becomes an RFC 3339 string."""
    out = {}
    for k, v in (options or {}).items():
        if not isinstance(k, str):
            raise TypeError("send(options=): option ids are strings, e.g. {\"cop1Bypass\": True}, not %r" % (k,))
        if isinstance(v, _dt.datetime):
            if v.tzinfo is None:
                v = v.replace(tzinfo=_dt.timezone.utc)
            v = v.astimezone(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        elif not isinstance(v, (bool, int, float, str)):
            raise TypeError("send(options=): %s=%r is not a bool, number, string or datetime" % (k, v))
        out[k] = v
    return out


class Sent:
    """A command issued by send(..., wait=False). Yamcs acknowledgements are
    followed and journaled in the background; `wait()` blocks until it
    completes (or reaches `until`), then checks its confirm= condition."""

    def __init__(self, request: CommandRequest, confirm: Optional[Condition], within: float, timeout: float,
                 on_failure: str, comment: Optional[str], line: int, until: str = "complete",
                 options: Optional[dict] = None):
        self.request, self.confirm, self.within, self.timeout = request, confirm, within, timeout
        self.on_failure, self.comment, self.line = on_failure, comment, line
        self.options = options or {}
        self.until, self._ack = until, _until(until)
        problem = _stage_problem(request.command, until)
        if problem:
            raise ValueError("send(until=%r): %s" % (until, problem))
        self.result: Optional[CommandResult] = None
        self._issue()

    @property
    def name(self) -> str:
        return self.request.command.qualified_name

    def _issue(self) -> None:
        if _SERVING:
            raise RuntimeError("commands cannot be sent from the shell")
        _fops.pause_point(self.line)
        cmd = self.request.command
        if cmd.significance in _SIGNIFICANT or _fops.options()[1]:
            if cmd.significance in _SIGNIFICANT:
                reason = " (%s)" % cmd.reason if cmd.reason else ""
                question = "%s is a %s command%s. Send it?" % (cmd.qualified_name, cmd.significance, reason)
            else:
                question = "Send %r?" % (self.request,)
            info = {"name": cmd.qualified_name, "args": self.request.args, "significance": cmd.significance}
            if self.options:
                info["options"] = self.options
            if _prompt(question, ["SEND", "CANCEL"], "command", command=info) != "SEND":
                raise CommandFailed("%s cancelled by the operator" % cmd.qualified_name)
        if self.confirm is not None:
            _set_baselines([self.confirm])
        self.t0 = time.monotonic()
        self._r = _fops.issue_command(self.name, self.request.args, self.line, self.timeout, self.comment,
                                      self.options)

    def _done(self, ok: bool, r: dict, stage: Optional[str] = None, detail: Optional[str] = None) -> CommandResult:
        self.result = CommandResult(self.name, ok, stage or r["stage"], r["id"], detail or r["detail"],
                                    time.monotonic() - self.t0, skipped=not ok)
        return self.result

    def wait(self) -> CommandResult:
        if self.result is not None:
            return self.result
        while True:
            if self._r["stage"] == "rejected" or self._ack == "":
                r = self._r
            else:
                r = _fops.wait_command(self._r["seq"], self._ack)
            if not r["ok"]:
                msg = "%s %s: %s" % (self.name, r["stage"], r["detail"])
                answer = _failure(msg, ["RESEND", "SKIP", "FAIL STEP", "ABORT"], self.on_failure, CommandFailed(msg))
                if answer == "RESEND":
                    self._issue()
                    continue
                return self._done(False, r)
            if self.confirm is None:
                return self._done(True, r)
            while True:
                ok, results = _evaluate([self.confirm], self.within)
                _emit("verify", sync=True, ok=ok, results=results, after=self.name, waited=self.within, line=self.line)
                if ok:
                    return self._done(True, r)
                msg = "%s %s but its effect was not seen within %ss: %s" % (
                    self.name, "completed" if self._ack is None else r["stage"], self.within, results[0]["condition"])
                answer = _failure(msg, ["RECHECK", "RESEND", "SKIP", "FAIL STEP", "ABORT"], self.on_failure,
                                  VerificationFailed(msg))
                if answer == "SKIP":
                    return self._done(False, r, stage="unconfirmed", detail=msg)
                if answer == "RESEND":
                    self._issue()
                    break

    def __repr__(self) -> str:
        return "<sent %s%s>" % (self.name, ": %s" % self.result.stage if self.result else "")


def send(request: CommandRequest, *, confirm: Optional[Condition] = None, within: Any = 10.0,
         timeout: Any = 120.0, wait: bool = True, until: str = "complete", on_failure: str = "ask",
         comment: Optional[str] = None, options: Optional[dict] = None) -> Any:
    """Sends a command and waits for Yamcs to report it complete (its MDB
    verifiers, at most `timeout` s); then, with `confirm`, waits up to `within`
    seconds for its effect on telemetry. Returns a CommandResult.

    `until` stops the waiting at an earlier stage: "issued", an
    acknowledgement ("queued", "released", "sent"), or a verifier stage of
    the command in the MDB ("Accepted", "Started"...); the command is still
    followed to completion and journaled. A command that ends without
    reporting that stage fails.

    With wait=False it returns as soon as the command is issued, with a Sent
    whose wait() does the rest; the command is followed and journaled anyway.

    `options` are Yamcs extra command options by id, e.g.
    {"cop1Bypass": True}: bool, number, string or datetime values."""
    if not isinstance(request, CommandRequest):
        raise TypeError("send() takes a command with its arguments, e.g. send(SWITCH_VOLTAGE_ON(voltage_num=1)), not %r" % (request,))
    if confirm is not None:
        _conditions(confirm, "send(confirm=)")
    sent = Sent(request, confirm, _seconds(within), _seconds(timeout), on_failure, comment, _line(), until,
                _command_options(options))
    return sent.wait() if wait else sent


def finish(message: str = "Completed") -> None:
    """Ends the procedure successfully."""
    raise ProcedureFinished(message)


def abort(message: str = "Aborted by the procedure") -> None:
    raise ProcedureAborted(message)


# --- sub-procedures ------------------------------------------------------------------
class ProcedureResult:
    """How a sub-procedure ended. `status` is its execution's: finished,
    aborted, error, crashed, killed, or rejected (never started).
    `confirmation` is its own ("confirmed", "not confirmed", "not available"
    after finish()), "aborted" if it did not finish, or "not available" when
    the operator skipped the failure. `ok`: finished and confirmed."""

    def __init__(self, procedure: str, id: Optional[int], status: str, confirmation: Optional[str], message: str,
                 duration: float, skipped: bool = False):
        self.procedure, self.id, self.status, self.message = procedure, id, status, message
        self.duration, self.skipped = duration, skipped
        self.ok = status == "finished" and confirmation == "confirmed"
        if skipped:
            confirmation = "not available"
        elif status != "finished":
            confirmation = "aborted"
        self.confirmation = confirmation or "not confirmed"

    def __repr__(self) -> str:
        return "<%s (execution %s) %s, %s in %.1fs>" % (self.procedure, self.id, self.status, self.confirmation,
                                                         self.duration)


class Running:
    """A sub-procedure started by run(..., wait=False). It runs as its own
    execution (`id`); `wait()` blocks until it ends, `abort()` aborts it.
    It is aborted when the calling procedure ends."""

    def __init__(self, procedure: str, args: dict, on_failure: str, line: int):
        self.procedure, self.args, self.on_failure, self.line = procedure, args, on_failure, line
        self.result: Optional[ProcedureResult] = None
        self._start()

    def _start(self) -> None:
        if _SERVING:
            raise RuntimeError("procedures cannot be started from the shell")
        _fops.pause_point(self.line)
        self.t0 = time.monotonic()
        r = _fops.start_procedure(self.procedure, self.args, self.line)
        self.seq, self.id, self._error = r["seq"], r.get("id"), r.get("error")

    def abort(self, reason: str = "aborted by the calling procedure") -> None:
        if self._error is None:
            _fops.abort_procedure(self.seq, reason)

    def wait(self) -> ProcedureResult:
        if self.result is not None:
            return self.result
        while True:
            if self._error is None:
                r = _fops.wait_procedure(self.seq)
                result = ProcedureResult(self.procedure, self.id, r["status"], r["confirmation"], r["message"],
                                         time.monotonic() - self.t0)
            else:
                result = ProcedureResult(self.procedure, None, "rejected", None, self._error, time.monotonic() - self.t0)
            if result.ok:
                self.result = result
                return result
            msg = "%s %s: %s" % (self.procedure, result.status if result.status != "finished"
                                 else result.confirmation, result.message)
            answer = _failure(msg, ["RESTART", "SKIP", "FAIL STEP", "ABORT"], self.on_failure, ProcedureFailed(msg))
            if answer == "RESTART":
                self._start()
                continue
            self.result = ProcedureResult(self.procedure, result.id, result.status, result.confirmation,
                                          result.message, result.duration, skipped=True)
            return self.result

    def __repr__(self) -> str:
        return "<running %s (execution %s)%s>" % (self.procedure, self.id,
                                                  ": %s" % self.result.status if self.result else "")


def run(procedure: str, *, args: Optional[dict] = None, wait: bool = True, on_failure: str = "ask") -> Any:
    """Runs another procedure (a path in the procedures directory, like
    "battery_off.py") with `args`, as its own execution, and waits for it to
    end. Returns a ProcedureResult. If it does not end confirmed, the
    operator chooses RESTART, SKIP, FAIL STEP or ABORT (see `on_failure`).
    The caller's options (by step, confirm commands) and controller are
    passed on. An abort, a jump or a violated invariant while waiting
    aborts it.

    With wait=False it returns once the procedure has started, with a
    Running whose wait() does the rest."""
    if not isinstance(procedure, str) or not procedure:
        raise TypeError("run() takes the path of a procedure, e.g. run(\"battery_off.py\"), not %r" % (procedure,))
    if not procedure.endswith(".py"):
        procedure += ".py"
    if args is not None and not isinstance(args, dict):
        raise TypeError("run(args=) must be a dict, not %r" % (args,))
    if on_failure not in ("ask", "raise", "skip"):
        raise ValueError("on_failure must be 'ask', 'raise' or 'skip', not %r" % (on_failure,))
    r = Running(procedure, dict(args or {}), on_failure, _line())
    return r.wait() if wait else r


# --- procedures and steps ----------------------------------------------------------
def _continuation(value: str, what: str) -> str:
    if value not in _CONTINUATIONS:
        raise ValueError("%s must be one of %s, not %r" % (what, ", ".join(map(repr, _CONTINUATIONS)), value))
    return value


def _check_body(fn: Callable[..., Any], what: str) -> None:
    """Refuses a function that assigns to the name of an MDB parameter or
    command: Python makes that a local variable hiding it, so
    `AllowCriticalTC1 = False` would silently set nothing."""
    codes = [fn.__code__]
    while codes:
        code = codes.pop()
        codes.extend(c for c in code.co_consts if isinstance(c, type(code)))
        for ins in dis.get_instructions(code):
            if ins.opname not in ("STORE_FAST", "STORE_DEREF", "STORE_GLOBAL"):
                continue
            item = fn.__globals__.get(ins.argval)
            if isinstance(item, Parameter):
                problem = ("`%s = ...` hides the parameter %s (a Python assignment sets nothing in Yamcs): "
                           "use %s.set(...), or another variable name" % (ins.argval, item.qualified_name, ins.argval))
            elif isinstance(item, Command):
                problem = "`%s = ...` hides the command %s: use another variable name" % (ins.argval, item.qualified_name)
            else:
                continue
            e = MdbError("%s: %s" % (what, problem))
            e.line, e.problem = ins.positions.lineno, problem   # the line, and the problem alone for fops check
            raise e


class _Step:
    def __init__(self, index: int, name: str, fn: Callable[[], Any], *, line: Optional[int] = None,
                 description: Optional[str] = None, requires: Conditions = None, goal: Conditions = None,
                 ensures: Conditions = None, invariant: Conditions = None, within: Any = 10.0,
                 cleanup: bool = False, on_unconfirmed: str = "ask", on_aborted: str = "abort",
                 restarts: int = 1):
        _check_body(fn, "step %r" % name)
        self.index, self.name, self.fn = index, name, fn
        self.line = line if line is not None else fn.__code__.co_firstlineno
        self.description = description if description is not None else (fn.__doc__ or "").strip()
        self.requires = _conditions(requires, "step %r requires=" % name)
        self.goal = _conditions(goal, "step %r goal=" % name)
        self.ensures = _conditions(ensures, "step %r ensures=" % name)
        self.invariant = _conditions(invariant, "step %r invariant=" % name)
        self.within = _seconds(within)
        self.cleanup = cleanup
        self.on_unconfirmed = _continuation(on_unconfirmed, "on_unconfirmed")
        self.on_aborted = _continuation(on_aborted, "on_aborted")
        self.restarts = restarts

    def info(self) -> dict:
        d: dict[str, Any] = {"index": self.index, "name": self.name, "description": self.description, "line": self.line}
        for k in ("requires", "goal", "ensures", "invariant"):
            if getattr(self, k):
                d[k] = [c.describe() for c in getattr(self, k)]
        if self.cleanup:
            d["cleanup"] = True
        return d


class _Watch:
    """A condition watched for the whole run. Without a handler, `then` is
    "pause" (default), "abort" or "log". With a handler (the decorated
    function, run on the procedure's thread, interrupting whatever it was
    doing), `then` says what follows it: "resume" (default), "pause" or "abort"."""

    def __init__(self, condition: Condition, then: Optional[str], message: Optional[str]):
        if then not in (None, "pause", "abort", "log", "resume"):
            raise ValueError("watch(then=...) must be 'pause', 'abort', 'log' or 'resume'")
        self.condition, self._then = condition, then
        self.message = message or condition.describe()
        self.reason = "watch: " + self.message   # when it aborts the procedure
        self.handler: Optional[Callable[[], Any]] = None
        self.active = False
        self.line = _line()      # of the watch() call (or of procedure() for an invariant)
        self.internal = False    # made for a procedure invariant

    @property
    def then(self) -> str:
        return self._then or ("resume" if self.handler else "pause")

    def __call__(self, fn: Callable[[], Any]) -> Callable[[], Any]:
        """Used as a decorator: `fn` handles the condition."""
        _check_body(fn, "watch handler %s()" % fn.__name__)
        self.handler = fn
        if self.message == self.condition.describe() and fn.__doc__:
            self.message = fn.__doc__.strip().splitlines()[0]
        return fn


# --- arguments ----------------------------------------------------------------------
_MISSING: Any = type("_Missing", (), {"__repr__": lambda self: "<required>"})()
_ARG_TYPES = {int: "int", float: "float", str: "str", bool: "bool"}
# Values given to this run (`fops run --args`), and whether they are enforced
# (not when `fops check` / `fops inspect` load the top level).
_ARG_VALUES: Optional[dict] = None
_STRICT_ARGS = False


class Arg:
    """A procedure argument: `procedure(..., args={"tag": Arg(int, default=1)})`,
    read as `proc.args.tag`. Without a default the argument is required."""

    def __init__(self, type: Any, *, default: Any = _MISSING, description: Optional[str] = None,
                 choices: Optional[Sequence[Any]] = None, min: Any = None, max: Any = None,
                 unit: Optional[str] = None):
        if isinstance(type, str):
            type = {v: k for k, v in _ARG_TYPES.items()}.get(type, type)
        if type not in _ARG_TYPES:
            raise TypeError("Arg(type): int, float, str or bool, not %r" % (type,))
        self.type, self.description, self.unit = type, description, unit
        self.choices = list(choices) if choices is not None else None
        self.min, self.max = min, max
        if (min is not None or max is not None) and type not in (int, float):
            raise TypeError("Arg(min=, max=) are for int and float arguments")
        self.name = "?"
        self.default = default

    def _declare(self, name: str) -> None:
        """Named by procedure(args=): the choices and default are checked."""
        self.name = name
        default, self.default = self.default, _MISSING
        try:
            if self.choices is not None:
                self.choices = [self.convert(c) for c in self.choices]
            if default is not _MISSING and default is not None:
                default = self.convert(default)
        except ArgumentError as e:
            raise TypeError("procedure(args=): %s" % e) from None
        self.default = default

    @property
    def required(self) -> bool:
        return self.default is _MISSING

    def convert(self, value: Any) -> Any:
        """The value as the argument's type; ArgumentError if it does not fit.
        Strings are parsed (values typed in a form)."""
        t, what = self.type, "argument %r" % self.name
        v = value
        if isinstance(v, str) and t is not str:
            text = v.strip()
            try:
                if t is bool:
                    if text.lower() not in ("true", "false"):
                        raise ValueError(text)
                    v = text.lower() == "true"
                else:
                    v = t(text)
            except ValueError:
                raise ArgumentError("%s: %r is not %s" % (what, value, _ARG_TYPES[t])) from None
        if t is bool:
            if not isinstance(v, bool):
                raise ArgumentError("%s: expected true or false, got %r" % (what, value))
        elif t is int:
            if isinstance(v, float) and v.is_integer():
                v = int(v)
            if isinstance(v, bool) or not isinstance(v, int):
                raise ArgumentError("%s: expected an integer, got %r" % (what, value))
        elif t is float:
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise ArgumentError("%s: expected a number, got %r" % (what, value))
            v = float(v)
        elif not isinstance(v, str):
            raise ArgumentError("%s: expected a string, got %r" % (what, value))
        if self.choices is not None and v not in self.choices:
            raise ArgumentError("%s: %r is not one of %s" % (what, v, ", ".join(map(repr, self.choices))))
        if self.min is not None and v < self.min:
            raise ArgumentError("%s: %r is below the minimum %r" % (what, v, self.min))
        if self.max is not None and v > self.max:
            raise ArgumentError("%s: %r is above the maximum %r" % (what, v, self.max))
        return v

    def spec(self) -> dict:
        d: dict[str, Any] = {"name": self.name, "type": _ARG_TYPES[self.type]}
        if not self.required:
            d["default"] = self.default
        d["required"] = self.required
        for k in ("description", "choices", "min", "max", "unit"):
            if getattr(self, k) is not None:
                d[k] = getattr(self, k)
        return d

    def __repr__(self) -> str:
        return "Arg(%s)" % ", ".join("%s=%r" % kv for kv in self.spec().items() if kv[0] != "name")


class Args:
    """The values of a procedure's arguments, as attributes (`proc.args.tag`)."""

    def __init__(self, values: dict[str, Any]):
        self.__dict__["_values"] = dict(values)

    def __getattr__(self, name: str) -> Any:
        values = self.__dict__["_values"]
        if name not in values:
            raise AttributeError("the procedure has no argument %r (declared: %s)"
                                 % (name, ", ".join(values) or "none"))
        return values[name]

    def __setattr__(self, name: str, value: Any) -> None:
        raise AttributeError("procedure arguments are read-only")

    def __iter__(self):
        return iter(self._values.items())

    def __repr__(self) -> str:
        return "Args(%s)" % ", ".join("%s=%r" % kv for kv in self._values.items())


def _bind_args(specs: dict[str, Arg]) -> dict[str, Any]:
    given = dict(_ARG_VALUES or {})
    values: dict[str, Any] = {}
    errors = []
    for name in given:
        if name not in specs:
            errors.append("unknown argument %r%s" % (name, " (declared: %s)" % ", ".join(specs) if specs else ""))
    for name, a in specs.items():
        try:
            if name in given and given[name] is not None:
                values[name] = a.convert(given[name])
            elif not a.required:
                values[name] = a.default
            else:
                if _STRICT_ARGS:
                    errors.append("argument %r is required" % name)
                values[name] = None
        except ArgumentError as e:
            errors.append(str(e))
            values[name] = None
    if errors and _STRICT_ARGS:
        raise ArgumentError("; ".join(errors))
    return values


class Procedure:
    def __init__(self, name: str, *, version: str = "0", description: Optional[str] = None, requires: Conditions = None,
                 ensures: Conditions = None, invariant: Conditions = None, within: Any = 10.0,
                 author: Optional[str] = None, args: Optional[dict[str, Arg]] = None, duration: Any = None):
        self.name, self.version = name, version
        # how long a run usually takes (seconds), for planning: the timeline's duration
        self.duration = _seconds(duration) if duration is not None else None
        if self.duration is not None and self.duration <= 0:
            raise ValueError("procedure(duration=) must be positive, not %r" % (duration,))
        self.description, self.author = description, author
        self.line = _line()
        self.arg_specs: dict[str, Arg] = {}
        for k, a in (args or {}).items():
            if not isinstance(a, Arg):
                raise TypeError("procedure(args=): %r must be an Arg(...), not %r" % (k, a))
            if not str(k).isidentifier():
                raise TypeError("procedure(args=): %r is not a valid argument name" % (k,))
            a._declare(k)
            self.arg_specs[k] = a
        self.args = Args(_bind_args(self.arg_specs))
        # --paused: hold before the preconditions until the operator runs or steps (SPELL's LOADED)
        self.paused = False
        self.script = False
        # names in the source that are MDB parameters: {"tm.BusVoltage": {...}} (see _parameter_names)
        self.parameters: dict[str, dict] = {}
        self.requires = _conditions(requires, "procedure requires=")
        self.ensures = _conditions(ensures, "procedure ensures=")
        self.invariant = _conditions(invariant, "procedure invariant=")
        self.within = _seconds(within)
        self.steps: list[_Step] = []
        self.watches: list[_Watch] = []
        self._confirmations: dict[int, str] = {}
        self._attempts: dict[int, int] = {}  # by step index, restarts and jumps back included
        self._current = 0
        for c in self.invariant:
            w = _Watch(~c, "abort", "invariant violated: " + c.describe())
            w.reason = w.message
            w.internal = True
            self.watches.append(w)

    def __repr__(self) -> str:
        return "<procedure %r %s>" % (self.name, self.version)

    def step(self, name: str, **conditions: Any) -> Callable[[Callable[[], Any]], Callable[[], Any]]:
        """Decorator: the function is the next step. Steps run in order.

        requires=   must hold before the step starts (else the operator decides)
        goal=       the step's purpose: if it already holds the step is skipped,
                    and it must hold once the body has run
        ensures=    must hold once the body has run
        invariant=  must hold while the body runs (checked on each update, at least every second)
        within=     seconds for goal and ensures to hold after the body (10)
        cleanup=    also run when the procedure aborts or finishes early
        on_unconfirmed=, on_aborted=, restarts=: the continuation (see module doc)
        """
        def deco(fn: Callable[[], Any]) -> Callable[[], Any]:
            self.steps.append(_Step(len(self.steps), name, fn, **conditions))
            return fn
        return deco

    def watch(self, condition: Condition, *, then: Optional[str] = None, message: Optional[str] = None) -> _Watch:
        """While the procedure runs, when `condition` becomes true: pause the
        procedure, abort it, or only log. Used as a decorator, the function
        is a handler that runs when the condition becomes true."""
        _conditions(condition, "watch()")
        w = _Watch(condition, then, message)
        self.watches.append(w)
        return w

    # --- execution --------------------------------------------------------------
    def _run(self) -> tuple[str, str]:
        global _CONTEXT_LINE
        _CONTEXT_LINE = self.line
        _emit("procedure", sync=True, name=self.name, version=self.version, description=self.description, author=self.author,
              args=[a.spec() for a in self.arg_specs.values()], arg_values=self.args._values,
              steps=[s.info() for s in self.steps],
              requires=[c.describe() for c in self.requires], ensures=[c.describe() for c in self.ensures],
              invariant=[c.describe() for c in self.invariant],
              parameters=self.parameters,
              watches=[{"message": w.message, "condition": w.condition.describe(), "then": w.then,
                        "handler": w.handler.__name__ if w.handler else None, "line": w.line}
                       for w in self.watches])
        if not self.steps:
            raise RuntimeError("the procedure has no steps")
        i = self._hold_at_start()
        self._outcome("preconditions")
        self._check_requires()
        global _WATCHER
        _WATCHER = _Watcher(self.watches)
        _WATCHER.invariant = self.invariant
        _WATCHER.start()
        try:
            self._outcome("executing")
            while i < len(self.steps):
                self._current = i
                i = self._run_step(i)
        except (ProcedureAborted, ProcedureFinished) as e:
            try:
                self._cleanup(self._current, e)
            finally:
                aborted = not isinstance(e, ProcedureFinished)
                self._outcome("completed", "aborted" if aborted else "not available", message=str(e))
            raise
        finally:
            _WATCHER.stop()
        _CONTEXT_LINE = self.line
        self._outcome("confirmation")
        if self.ensures:
            ok, results = _evaluate(self.ensures, self.within)
            _emit("verify", sync=True, ok=ok, results=results, procedure=True)
            confirmation = "confirmed" if ok else "not confirmed"
        else:
            confirmation = "confirmed" if all(r == "confirmed" for r in self._confirmations.values()) else "not confirmed"
        self._outcome("completed", confirmation)
        return "finished", "Completed (%s)" % confirmation

    def _hold_at_start(self) -> int:
        """With --paused, waits for the operator before anything runs; returns the first step (goto step)."""
        if not self.paused:
            return 0
        if self.script:
            # the whole file is the step: hold at its first line, where goto line works
            _fops.pause_next("start")
            return 0
        try:
            _fops.pause_next("start")
            _fops.pause_point(self.line)
        except StepJump:
            target = _fops.take_jump()
            if target is None or not 0 <= target < len(self.steps):
                raise ProcedureAborted("jump to an unknown step: %r" % (target,))
            _emit("jump", sync=True, source=None, target=target)
            return target
        return 0

    def _outcome(self, execution: str, confirmation: Optional[str] = None, **extra: Any) -> None:
        _emit("outcome", sync=execution == "completed", execution=execution, confirmation=confirmation, **extra)

    def _cleanup(self, current: int, why: BaseException) -> None:
        """Runs the cleanup steps after `current`, once, after an abort or finish()."""
        todo = [s for s in self.steps if s.cleanup and s.index > current]
        if not todo:
            return
        aborted = isinstance(why, ProcedureAborted)
        if aborted:
            _fops.clear_abort()
        _emit("cleanup", sync=True, reason=str(why), steps=[s.index for s in todo])
        try:
            for s in todo:
                self._run_step(s.index, in_cleanup=True)
        except ProcedureAborted as e:
            raise ProcedureAborted("%s; cleanup interrupted: %s" % (why, e)) from None
        except StepJump:
            _fops.take_jump()
            log("jump ignored: the procedure is cleaning up", level="warning")
        except ProcedureFinished:
            pass
        _WATCHER.clear_step()

    def _check_requires(self) -> None:
        if not self.requires:
            return
        while True:
            ok, results = _evaluate(self.requires, 0.0)
            _emit("precondition", sync=True, ok=ok, results=results)
            if ok:
                return
            failed = "\n".join("- " + r["condition"] for r in results if not r["ok"])
            answer = ask("Preconditions not met:\n" + failed, ["RECHECK", "OVERRIDE", "ABORT"])
            if answer == "OVERRIDE":
                log("preconditions overridden by the operator", level="warning")
                return
            if answer != "RECHECK":
                raise ProcedureAborted("preconditions not met")

    def _step_event(self, s: _Step, execution: str, confirmation: Optional[str] = None, **extra: Any) -> None:
        if confirmation is not None:
            self._confirmations[s.index] = confirmation
        _emit("step", sync=execution in ("completed",), index=s.index, name=s.name, execution=execution,
              confirmation=confirmation, status=confirmation or execution, line=s.line, **extra)

    def _run_step(self, i: int, in_cleanup: bool = False) -> int:
        s = self.steps[i]
        restarts = 0
        while True:
            t0 = time.monotonic()
            try:
                confirmation, extra = self._execute(s)
            except StepJump:
                if in_cleanup:
                    raise
                return self._jumped(s, t0)
            except ProcedureFinished as e:
                self._step_event(s, "completed", "confirmed", duration=time.monotonic() - t0, note=str(e))
                raise
            except ProcedureAborted as e:
                self._step_event(s, "completed", "aborted", duration=time.monotonic() - t0, error=str(e))
                raise
            self._step_event(s, "completed", confirmation, duration=time.monotonic() - t0, **extra)
            if confirmation in ("confirmed", "not available"):
                return i + 1
            how = s.on_aborted if confirmation == "aborted" else s.on_unconfirmed
            if how == "restart" and restarts < s.restarts:
                restarts += 1
                log("step %d not %s: restart %d of %d" % (i + 1, "completed" if confirmation == "aborted"
                                                           else "confirmed", restarts, s.restarts), level="warning")
                continue
            if how == "continue":
                return i + 1
            if how == "abort":
                raise ProcedureAborted("step %d '%s': %s%s" % (i + 1, s.name, confirmation,
                                                              ": " + extra["error"] if extra.get("error") else ""))
            # ask
            why = extra.get("error") or "; ".join(r["condition"] for r in extra.get("results", []) if not r["ok"])
            try:
                answer = ask("Step %d '%s' %s: %s" % (i + 1, s.name, confirmation, why),
                             ["RESTART STEP", "CONTINUE", "ABORT"])
            except StepJump:
                return self._jumped(s, t0, already_ended=True)
            if answer == "RESTART STEP":
                continue
            if answer == "CONTINUE":
                log("step %d %s, continued by the operator" % (i + 1, confirmation), level="warning")
                return i + 1
            raise ProcedureAborted("step %d '%s' %s" % (i + 1, s.name, confirmation))

    def _execute(self, s: _Step) -> tuple[str, dict]:
        """One attempt at a step: preconditions, body, confirmation."""
        global _CONTEXT_LINE, _ERROR_FRAME
        _CONTEXT_LINE = s.line
        # the step's line counts its attempts: its items' EX in the console
        self._attempts[s.index] = self._attempts.get(s.index, 0) + 1
        _fops.at_line(s.line, self._attempts[s.index])
        self._step_event(s, "preconditions")
        if s.goal:
            ok, results = _evaluate(s.goal, 0.0)
            if ok:
                _emit("verify", sync=True, ok=True, results=results, step=s.index)
                return "confirmed", {"note": "goal already holds: skipped", "results": results}
            # journaled too: the values the step was run on
            _emit("check", sync=True, ok=False, results=results, step=s.index, goal=True)
        while s.requires:
            ok, results = _evaluate(s.requires, 0.0)
            _emit("precondition", sync=True, ok=ok, results=results, step=s.index)
            if ok:
                break
            failed = "\n".join("- " + r["condition"] for r in results if not r["ok"])
            answer = ask("Step %d '%s': preconditions not met:\n%s" % (s.index + 1, s.name, failed),
                         ["RECHECK", "OVERRIDE", "SKIP STEP", "ABORT"])
            if answer == "OVERRIDE":
                log("step %d preconditions overridden by the operator" % (s.index + 1), level="warning")
                break
            if answer == "SKIP STEP":
                return "not available", {"note": "skipped by the operator", "results": results}
            if answer == "ABORT":
                raise ProcedureAborted("step %d '%s': preconditions not met" % (s.index + 1, s.name))
        _set_baselines(s.goal + s.ensures + s.invariant)
        self._step_event(s, "executing")
        _WATCHER.set_step(s)
        try:
            if _fops.options()[0]:
                _fops.pause_next("step")
            s.fn()
        except OperationFailed as e:
            return "not confirmed", {"error": str(e)}
        except (StepJump, ProcedureAborted, ProcedureFinished):
            raise
        except Exception as e:
            tb = e.__traceback__
            for frame, _ in traceback.walk_tb(tb):
                if frame.f_code.co_filename == _MAIN_FILE:
                    _ERROR_FRAME = frame
            return "aborted", {"error": "%s: %s" % (type(e).__name__, e), "traceback": traceback.format_exc()}
        finally:
            _WATCHER.clear_step()
        checks = s.goal + s.ensures
        if not checks:
            return "confirmed", {}
        self._step_event(s, "confirmation")
        ok, results = _evaluate(checks, s.within)
        _emit("verify", sync=True, ok=ok, results=results, step=s.index)
        return ("confirmed" if ok else "not confirmed"), {"results": results}

    def _jumped(self, s: _Step, t0: float, already_ended: bool = False) -> int:
        target = _fops.take_jump()
        if not already_ended:
            self._step_event(s, "completed", "not available", duration=time.monotonic() - t0,
                             note="interrupted by a jump")
        if target is None or not 0 <= target < len(self.steps):
            raise ProcedureAborted("jump to an unknown step: %r" % (target,))
        _emit("jump", sync=True, source=s.index, target=target)
        return target


def procedure(name: str, **kwargs: Any) -> Procedure:
    """Declares the procedure of this file (exactly one per file)."""
    return Procedure(name, **kwargs)


class _Watcher(threading.Thread):
    """Evaluates the watches and the current step's invariant in the
    background, on each update of their parameters and at least every second. Handlers and invariant violations are queued
    for the procedure's thread (see `_service`)."""

    def __init__(self, watches: Sequence[_Watch]):
        super().__init__(name="fops-watch", daemon=True)
        self.watches = watches
        self.stopped = threading.Event()
        self.lock = threading.Lock()
        self.step: Optional[_Step] = None
        self.invariant: Sequence[Condition] = ()   # the procedure's
        self.pending: list[Any] = []   # _Watch with a handler, or (step, results) for an invariant

    def stop(self) -> None:
        self.stopped.set()

    def set_step(self, s: _Step) -> None:
        with self.lock:
            self.step = s if s.invariant else None

    def clear_step(self) -> None:
        with self.lock:
            self.step = None
            self.pending = [p for p in self.pending if not isinstance(p, tuple)]

    def take(self) -> list[Any]:
        with self.lock:
            out, self.pending = self.pending, []
            return out

    def run(self) -> None:
        watched = [p for w in self.watches for p in w.condition.params()]
        params: list[Parameter] = []
        while True:
            if params:
                _fops.wait_update(sorted({p.qualified_name for p in params}), 1.0)
            else:
                self.stopped.wait(1.0)
            if self.stopped.is_set():
                return
            with self.lock:
                step = self.step
            params = watched + ([p for c in step.invariant for p in c.params()] if step else [])
            if not params:
                continue
            try:
                values = _fetch(params)
            except BaseException:
                continue
            for w in self.watches:
                hit = w.condition.test(values)
                if hit and not w.active:
                    _fops.emit(json.dumps({"type": "watch", "message": w.message, "action": w.then,
                                           "handler": w.handler.__name__ if w.handler else None,
                                           "condition": w.condition.explain(values), "line": w.line}), True, True)
                    if w.handler is not None:
                        with self.lock:
                            self.pending.append(w)
                        _fops.request_service()
                    elif w.then == "pause":
                        _fops.request_pause()
                    elif w.then == "abort":
                        _fops.request_abort(w.reason)
                w.active = hit
            if step is not None:
                oks = [c.test(values) for c in step.invariant]
                if not all(oks):
                    results = [{"condition": c.explain(values), "ok": ok} for c, ok in zip(step.invariant, oks)]
                    with self.lock:
                        if self.step is step:
                            self.pending.append((step, results))
                            self.step = None
                    _fops.request_service()


_WATCHER = _Watcher(())
_SERVICING = False


def _service() -> None:
    """Called by the native layer on the procedure's thread when the watcher
    queued work: runs watchdog handlers, raises for violated invariants."""
    global _SERVICING
    if _SERVICING:
        _fops.request_service()  # after the handler that is running
        return
    _SERVICING = True
    try:
        for item in _WATCHER.take():
            if isinstance(item, tuple):
                step, results = item
                _emit("verify", sync=True, ok=False, results=results, step=step.index, invariant=True)
                raise InvariantViolated("invariant violated: " + "; ".join(r["condition"] for r in results if not r["ok"]))
            _run_handler(item)
    finally:
        _SERVICING = False


def _run_handler(w: _Watch) -> None:
    _emit("watch", sync=True, message=w.message, action="handler started", handler=w.handler.__name__, line=w.line)
    try:
        w.handler()
    except (ProcedureAborted, ProcedureFinished, StepJump):
        raise
    except Exception as e:
        error = "%s: %s" % (type(e).__name__, e)
        _emit("watch", sync=True, message=w.message, action="handler failed", error=error,
              traceback=traceback.format_exc(), line=w.line)
        if ask("Watchdog '%s' handler failed: %s" % (w.message, error), ["RESUME", "ABORT"]) != "RESUME":
            raise ProcedureAborted("watchdog handler failed: " + error)
        return
    _emit("watch", sync=True, message=w.message, action="handler done, " + w.then, line=w.line)
    if w.then == "abort":
        raise ProcedureAborted(w.reason)
    if w.then == "pause":
        _fops.request_pause()


# --- MDB lookup by name ---------------------------------------------------------------
def param(qualified_name: str) -> Parameter:
    """The MDB parameter with this qualified name ("/SIMULATOR/BusVoltage"), from the
    generated `mdb` package."""
    qn = "/" + qualified_name.strip("/")
    path, _, name = qn[1:].rpartition("/")
    try:
        importlib.import_module("mdb")
    except ImportError:
        return Parameter(qn, "unknown")   # no generated package: not checked
    module = "mdb.%s.tm" % path.replace("/", ".") if path else "mdb.tm"
    try:
        m = importlib.import_module(module)
    except ImportError:
        raise MdbError("no space system /%s in the MDB (for %s)" % (path, qn)) from None
    params = [v for v in vars(m).values() if isinstance(v, Parameter)]
    for p in params:
        if p.qualified_name == qn:
            return p
    import difflib
    close = difflib.get_close_matches(name, [p.qualified_name.rpartition("/")[2] for p in params], n=1)
    raise MdbError("no parameter %s in the MDB%s" % (qn, " (did you mean %s?)" % close[0] if close else ""))


# --- the Yamcs Python client ---------------------------------------------------------
_client: Any = None


def yamcs_client() -> Any:
    """A `yamcs.client.YamcsClient` (the yamcs-client package) connected to the
    procedure's Yamcs as the operator running it. `client.instance` and
    `client.processor` name the procedure's instance and processor.

    Its calls are not journaled, and an abort waits for the one in progress."""
    global _client
    if _client is None:
        try:
            from yamcs.client import Credentials, YamcsClient
        except ImportError:
            raise ImportError("yamcs_client() needs the yamcs-client package in the worker's Python "
                              "(pip install yamcs-client)") from None

        url, instance, processor, token_file = _fops.yamcs_connection()

        class WorkerToken(Credentials):
            """The worker's token, read again before each request: the server renews it."""
            def login(self, *args: Any, **kwargs: Any) -> Any:
                return self

            def before_request(self, session: Any, auth_url: str) -> None:
                if token_file:
                    with open(token_file) as f:
                        session.headers["Authorization"] = "Bearer " + f.read().strip()

        client = YamcsClient(url, credentials=WorkerToken() if token_file else None,
                             user_agent="fops procedure")
        client.instance, client.processor = instance, processor
        _client = client
    return _client


# --- the operator's view of the paused procedure (variables, shell, line jumps) ------
_SERVING = False
_ENDED = False
_GLOBALS: dict[str, Any] = {}
# Innermost procedure frame of the last step that raised: inspected once ended.
_ERROR_FRAME: Any = None
_REPR = reprlib.Repr(maxlevel=4, maxdict=100, maxlist=100, maxtuple=100, maxset=100, maxfrozenset=100,
                     maxdeque=100, maxarray=100, maxlong=400, maxstring=2000, maxother=2000)
_REPR_MAX = 2000


def _value(v: Any) -> dict:
    try:
        r = _REPR.repr(v)
    except BaseException as e:
        r = "<repr failed: %s: %s>" % (type(e).__name__, e)
    if len(r) > _REPR_MAX:
        r = r[:_REPR_MAX] + "…"
    return {"type": type(v).__name__, "repr": r}


def _shown(name: str, v: Any) -> bool:
    if name.startswith("__") and name.endswith("__"):
        return False
    if isinstance(v, (types.ModuleType, types.FunctionType, types.BuiltinFunctionType, types.MethodType,
                      type, Parameter, Command, Condition, _Watch)):
        return False
    return not (type(v).__module__ == "typing" or callable(v) and getattr(v, "__module__", None) == "typing")


def _scope() -> tuple[Any, dict, Any]:
    """(frame or None, globals, locals or None) the operator's requests run in."""
    if _ENDED:
        frame = _ERROR_FRAME
    else:
        frame = _main_frame(sys._getframe(2))
    if frame is None:
        return None, _GLOBALS, None
    if frame.f_code.co_name == "<module>":
        return frame, frame.f_globals, None
    return frame, frame.f_globals, frame.f_locals


def _serve(kind: str, request_id: int, name: str, expr: str) -> None:
    """A get_variables / set_variable / eval request, on the procedure's
    thread while it is paused, at a prompt, or ended."""
    global _SERVING
    frame, g, loc = _scope()
    where = {"function": frame.f_code.co_qualname if frame else "<module>",
             "line": frame.f_lineno if frame else _CONTEXT_LINE}
    if kind == "variables":
        _fops.emit(json.dumps({"type": "variables", "request_id": request_id, "frame": where,
                               "locals": {k: _value(v) for k, v in (loc or {}).items() if _shown(k, v)},
                               "globals": {k: _value(v) for k, v in g.items() if _shown(k, v)}},
                              default=str), False, False)
        return
    result: dict[str, Any] = {"type": "eval_result", "request_id": request_id}
    out = io.StringIO()
    _SERVING = True
    try:
        with contextlib.redirect_stdout(out):
            if kind == "set_variable":
                result["expr"] = "%s = %s" % (name, expr)
                if not name.isidentifier():
                    raise NameError("%r is not a variable name" % name)
                value = eval(compile(expr, "<shell>", "eval"), g, loc)
                code = frame.f_code if frame is not None else None
                if loc is not None and name in code.co_varnames + code.co_cellvars + code.co_freevars:
                    loc[name] = value
                else:
                    g[name] = value
                print(_value(value)["repr"], end="")
            else:
                result["expr"] = expr
                # Statements are run; the value of a last expression is shown.
                tree = ast.parse(expr, "<shell>", "exec")
                last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
                if tree.body:
                    exec(compile(tree, "<shell>", "exec"), g, loc)
                if last is not None:
                    v = eval(compile(ast.Expression(last.value), "<shell>", "eval"), g, loc)
                    if v is not None:
                        print(_value(v)["repr"], end="")
        result["ok"] = True
    except BaseException as e:
        result["ok"] = False
        result["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        _SERVING = False
    output = out.getvalue()
    result["output"] = output[:_REPR_MAX] + "…" if len(output) > _REPR_MAX else output
    _fops.emit(json.dumps({**result, "frame": where}, default=str), True, True)


_TREES: dict[str, ast.Module] = {}


def _parents(tree: ast.AST) -> dict[ast.AST, tuple[ast.AST, list]]:
    """Statement -> (its parent node, the statement list it is in)."""
    out: dict[ast.AST, tuple[ast.AST, list]] = {}
    for node in ast.walk(tree):
        for field in ("body", "orelse", "finalbody", "handlers"):
            body = getattr(node, field, None)
            if isinstance(body, list):
                for child in body:
                    if isinstance(child, (ast.stmt, ast.excepthandler)):
                        out[child] = (node, body)
    return out


def _skip_target(frame: Any) -> int:
    """The line after the statement at the frame's current line."""
    tree = _TREES.get(_MAIN_FILE or "")
    if tree is None:
        with open(_MAIN_FILE or "") as f:
            tree = _TREES[_MAIN_FILE or ""] = ast.parse(f.read())
    parents = _parents(tree)
    line = frame.f_lineno
    here = [n for n in parents if isinstance(n, ast.stmt) and n.lineno == line]
    if not here:
        raise ValueError("no statement starts at line %d" % line)
    node: ast.AST = max(here, key=lambda n: n.end_lineno or n.lineno)
    while True:
        parent, body = parents[node]
        i = body.index(node)
        if i + 1 < len(body):
            return body[i + 1].lineno
        if isinstance(parent, (ast.For, ast.AsyncFor, ast.While)) and body is parent.body:
            return parent.lineno
        if isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Module)) or parent not in parents:
            raise ValueError("line %d is the last of %s: nothing to skip to" % (line, frame.f_code.co_qualname))
        node = parent


def _line_jump(kind: str, target: int) -> int:
    """Moves the paused frame (skip: to the next statement; goto: to `target`,
    in the same function). Called from the line callback. Returns the new line."""
    frame = _main_frame(sys._getframe(1))
    if frame is None:
        raise ValueError("not paused in the procedure")
    lines = {l for _, _, l in frame.f_code.co_lines() if l is not None}
    if kind == "skip":
        target = _skip_target(frame)
        target = min((l for l in lines if l >= target), default=target)
    elif target not in lines:  # goto_line
        raise ValueError("line %d is not a statement of %s (only lines of the same function)"
                         % (target, "the top level" if frame.f_code.co_name == "<module>" else frame.f_code.co_qualname))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)   # "assigning None to unbound locals"
        frame.f_lineno = target
    return frame.f_lineno


# --- entry point (called by the worker) ------------------------------------------
def procedure_calls(tree: ast.AST) -> list[int]:
    """The lines of the source's procedure() calls, in order. Counted in the
    source, not among the loaded globals: a second procedure() assigned to
    the same name would replace the first without a trace."""
    lines = []
    for n in ast.walk(tree):
        if isinstance(n, ast.Call):
            f = n.func
            if (isinstance(f, ast.Name) and f.id == "procedure") or (isinstance(f, ast.Attribute) and f.attr == "procedure"):
                lines.append(n.lineno)
    return sorted(lines)


def declares_procedure(tree: ast.AST) -> bool:
    """Whether the source calls procedure() anywhere (else: script mode)."""
    return bool(procedure_calls(tree))


def _parameter_names(tree: ast.Module, g: dict[str, Any]) -> dict[str, dict]:
    """The names and dotted names (`tm.BusVoltage`, through modules only) of
    the source that are MDB parameters, for the operator's console: shown
    with their live value on hover."""
    out: dict[str, dict] = {}

    def chain(node: ast.AST) -> Optional[list[str]]:
        if isinstance(node, ast.Name):
            return [node.id]
        if isinstance(node, ast.Attribute):
            base = chain(node.value)
            return base + [node.attr] if base else None
        return None

    for node in ast.walk(tree):
        names = chain(node) if isinstance(node, (ast.Name, ast.Attribute)) else None
        if not names:
            continue
        key = ".".join(names)
        if key in out:
            continue
        v: Any = g.get(names[0])
        for attr in names[1:]:
            v = getattr(v, attr, None) if isinstance(v, types.ModuleType) else None
        if isinstance(v, Parameter):
            out[key] = {"name": v.qualified_name, "units": v.units, "description": v.description}
    return out


def main(path: str, config: str = "{}") -> tuple:
    """Runs the procedure. `config` (JSON): args, paused. Returns (status,
    message), or (status, message, line) for an error at a line of the file."""
    global _MAIN_FILE, _ARG_VALUES, _STRICT_ARGS, _GLOBALS, _ENDED
    _MAIN_FILE = path
    _fops.set_service(_service)
    g: dict[str, Any] = {"__name__": "__main__", "__file__": path, "__builtins__": builtins}
    _GLOBALS = g
    sys.stdout, sys.stderr = _Output("stdout"), _Output("stderr")
    try:
        cfg = json.loads(config or "{}")
        if cfg.get("args_error"):
            return "error", cfg["args_error"]
        if cfg.get("args") is not None and not isinstance(cfg["args"], dict):
            return "error", "--args must be a JSON object, not %s" % json.dumps(cfg["args"])
        _ARG_VALUES, _STRICT_ARGS = cfg.get("args") or {}, True
        with open(path) as f:
            source = f.read()
        tree = ast.parse(source, path)
        code = compile(tree, path, "exec")
        _fops.instrument(code)
        if declares_procedure(tree):
            calls = procedure_calls(tree)
            if len(calls) > 1:
                return "error", "a procedure file must declare exactly one procedure(), found %d (lines %s)" % (
                    len(calls), ", ".join(map(str, calls)))
            exec(code, g)
            procs = [v for v in g.values() if isinstance(v, Procedure)]
            if len(procs) != 1:
                raise RuntimeError("a procedure file must declare exactly one procedure(), found %d" % len(procs))
            proc = procs[0]
            if proc.description is None:
                proc.description = ast.get_docstring(tree)
            if proc.author is None and g.get("__author__") is not None:
                proc.author = str(g["__author__"])
        else:
            if _ARG_VALUES:
                raise ArgumentError("a plain script (no procedure()) takes no arguments")
            # Script mode: the whole file is one step, without conditions.
            proc = Procedure(os.path.splitext(os.path.basename(path))[0], description=ast.get_docstring(tree))
            proc.line = 1
            proc.script = True
            # a script's imports run in its step: resolve its names on the imports alone
            names_g = dict(g)
            imports = ast.Module([n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))], [])
            exec(compile(imports, path, "exec"), names_g)
            proc.steps.append(_Step(0, "Script", lambda: exec(code, g), line=1, description="plain script",
                                    on_unconfirmed="ask", on_aborted="abort"))
        proc.paused = bool(cfg.get("paused"))
        proc.parameters = _parameter_names(tree, names_g if proc.script else g)
        return proc._run()
    except ProcedureFinished as e:
        return "finished", str(e)
    except ProcedureAborted as e:
        return "aborted", str(e)
    except StepJump:
        return "aborted", "jump requested outside of a step"
    except ArgumentError as e:
        return "error", "arguments: %s" % e
    except Exception as e:
        line = _error_line(e, path)
        if not line:
            return "error", traceback.format_exc()
        # a mistake in the procedure file: where, not a traceback
        msg = str(e) if isinstance(e, (MdbError, ImportError, SyntaxError)) else "%s: %s" % (type(e).__name__, e)
        if isinstance(e, SyntaxError):
            msg = "syntax error: %s" % e.msg
        elif isinstance(e, ImportError):
            from fops.check import _import_hint
            msg += _import_hint(e)
        _emit("log", message=msg, level="error", line=line)
        return "error", "line %d: %s" % (line, msg), line
    except BaseException:
        return "error", traceback.format_exc()
    finally:
        _ENDED = True
        sys.stdout.flush()
        sys.stderr.flush()


def _error_line(e: BaseException, path: str) -> int:
    """The line of the procedure file an exception comes from, or 0."""
    if getattr(e, "line", None):
        return e.line
    if isinstance(e, SyntaxError) and e.filename == path:
        return e.lineno or 0
    line = 0
    for frame, n in traceback.walk_tb(e.__traceback__):
        if frame.f_code.co_filename == path:
            line = n
    return line
