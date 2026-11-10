"""Telemetry parameters, commands and conditions.

Instances are created by the modules that `fops mdb-gen` generates from the
Yamcs MDB; procedures import them from there, e.g.

    from mdb.SIMULATOR.tm import BusVoltage
    from mdb.SIMULATOR.tc import SWITCH_VOLTAGE_ON

Comparing a parameter builds a `Condition` (it does not read telemetry):
`BusVoltage > 25` is evaluated by verify(), wait_until(), watch() and the
conditions of procedures and steps. Use `BusVoltage.value` for the current
value. `OrbitNumber.rises_by(3)` holds once the parameter has risen by 3
since the condition's baseline: the start of the verify(), wait_until() or
send(), or the start of the step for a step's conditions.
"""
from __future__ import annotations

import datetime as _dt
import functools
import math
import operator
from typing import Any, Callable, Generic, Iterable, Mapping, Optional, Sequence, TypeVar

from fops import units as _units

T = TypeVar("T")
F = TypeVar("F", bound=Callable[..., "CommandRequest"])


class MdbError(Exception):
    """A reference that does not match the MDB (bad enum label, type, argument)."""


Values = Mapping[str, "tuple[Any, bool]"]  # qualified name -> (value, valid)

_NUMERIC = ("float", "integer")
_SETTABLE = ("float", "integer", "boolean", "enumeration", "string", "time")


def _type_problem(kind: str, labels: Sequence[str], value: Any) -> Optional[str]:
    """Why `value` does not fit a parameter/argument of `kind`, or None."""
    if kind.endswith("[]"):
        if not isinstance(value, (list, tuple)):
            return "expected a list, got %r" % (value,)
        for v in value:
            p = _type_problem(kind[:-2], labels, v)
            if p:
                return p
        return None
    if kind == "enumeration":
        if not isinstance(value, str):
            return "expected one of %s, got %r" % (", ".join(map(repr, labels)), value)
        if value not in labels:
            import difflib
            close = difflib.get_close_matches(value, labels, n=1)
            hint = " (did you mean %r?)" % close[0] if close else ""
            return "%r is not one of %s%s" % (value, ", ".join(map(repr, labels)), hint)
    elif kind == "boolean":
        if not isinstance(value, bool):
            return "expected True or False, got %r" % (value,)
    elif kind in _NUMERIC:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return "expected a number, got %r" % (value,)
        if kind == "integer" and isinstance(value, float) and not value.is_integer():
            return "expected an integer, got %r" % (value,)
    elif kind == "string":
        if not isinstance(value, str):
            return "expected a string, got %r" % (value,)
    elif kind == "time":
        if not isinstance(value, (str, _dt.datetime)):
            return "expected a datetime or ISO string, got %r" % (value,)
    return None


class Parameter(Generic[T]):
    """A telemetry parameter of the MDB."""

    __slots__ = ("qualified_name", "kind", "labels", "units", "description", "writable")

    def __init__(self, qualified_name: str, kind: str, *, labels: Sequence[str] = (),
                 units: Optional[str] = None, description: Optional[str] = None, writable: bool = False):
        self.qualified_name = qualified_name
        self.kind = kind
        self.labels = tuple(labels)
        self.units = units
        self.description = description
        self.writable = writable

    def __repr__(self) -> str:
        return "<parameter %s>" % self.qualified_name

    __hash__ = object.__hash__

    def __bool__(self) -> bool:
        raise TypeError("%s is a telemetry parameter, not a value: use .value to read it, "
                        "or verify()/wait_until() with a condition" % self.qualified_name)

    # --- reading --------------------------------------------------------------
    @property
    def value(self) -> T:
        """The latest value (from Yamcs's cache)."""
        return self.get()

    @value.setter
    def value(self, value: Any) -> None:
        raise AttributeError("%s.value is read-only: set a local parameter with .set(value)" % self.qualified_name)

    def get(self, wait: bool = False, timeout: float = 5.0, raw: bool = False) -> T:
        """The latest value; with wait=True, the next sample to arrive."""
        from fops import _runtime
        return _runtime.read(self, wait=wait, timeout=timeout, raw=raw)

    # --- writing --------------------------------------------------------------
    def set(self, value: Any, *, on_failure: str = "ask") -> bool:
        """Sets the value of a local parameter in Yamcs, journaled.
        Returns True, or False if the operator chose SKIP."""
        from fops import _runtime
        return _runtime.write(self, value, on_failure=on_failure)

    def set_value(self, value: Any) -> Any:
        """`value` ready to be set: a quantity converted to the parameter's
        units. Raises MdbError if the parameter cannot be set to it."""
        if not self.writable:
            raise MdbError("%s is not a local parameter: only those can be set" % self.qualified_name)
        if self.kind not in _SETTABLE:
            raise MdbError("%s is %s: fops sets only %s parameters (use yamcs_client())"
                           % (self.qualified_name, self.kind, ", ".join(_SETTABLE)))
        if isinstance(value, Parameter):
            raise MdbError("%s: set it to a value, not to %s (read .value)" % (self.qualified_name, value.qualified_name))
        return self.operand(value)

    # --- conditions -------------------------------------------------------------
    def operand(self, value: Any) -> Any:
        """`value` ready to compare with this parameter: a quantity converted
        to the parameter's units. Raises MdbError if it can never match."""
        if isinstance(value, Parameter):
            return value
        if isinstance(value, _units.Quantity):
            value = _convert(value, self.units, self.qualified_name)
        problem = _type_problem(self.kind, self.labels, value)
        if problem:
            raise MdbError("%s: %s" % (self.qualified_name, problem))
        return value

    def check_operand(self, value: Any) -> None:
        self.operand(value)

    def _cmp(self, op: str, other: Any) -> "Condition":
        return Compare(self, op, self.operand(other))

    def __eq__(self, other: Any) -> "Condition":  # type: ignore[override]
        return self._cmp("==", other)

    def __ne__(self, other: Any) -> "Condition":  # type: ignore[override]
        return self._cmp("!=", other)

    def __lt__(self, other: Any) -> "Condition":
        return self._cmp("<", other)

    def __le__(self, other: Any) -> "Condition":
        return self._cmp("<=", other)

    def __gt__(self, other: Any) -> "Condition":
        return self._cmp(">", other)

    def __ge__(self, other: Any) -> "Condition":
        return self._cmp(">=", other)

    def between(self, low: Any, high: Any) -> "Condition":
        """low <= value <= high"""
        return Between(self, self.operand(low), self.operand(high))

    def is_in(self, *values: Any) -> "Condition":
        return In(self, [self.operand(v) for v in values])

    def rises_by(self, amount: Any) -> "Condition":
        """The value has risen by at least `amount` since the baseline."""
        return Change(self, "rises by", self._amount(amount))

    def falls_by(self, amount: Any) -> "Condition":
        """The value has fallen by at least `amount` since the baseline."""
        return Change(self, "falls by", self._amount(amount))

    def changes(self) -> "Condition":
        """The value differs from the baseline."""
        return Change(self, "changes", None)

    def _amount(self, amount: Any) -> float:
        if self.kind not in _NUMERIC:
            raise MdbError("%s is %s: only numbers rise or fall" % (self.qualified_name, self.kind))
        if isinstance(amount, _units.Quantity):
            amount = _convert(amount, self.units, self.qualified_name, offset=False)
        if isinstance(amount, bool) or not isinstance(amount, (int, float)) or amount < 0:
            raise MdbError("%s: expected a positive amount, got %r" % (self.qualified_name, amount))
        return amount


def _convert(q: "_units.Quantity", units: Optional[str], what: str, offset: bool = True) -> float:
    """A quantity in the MDB units `units` (offset=False for a difference)."""
    target = _units.lookup(units)
    if target is None:
        raise MdbError("%s has %s: compare it with a plain number, not %r"
                       % (what, "units %r, which fops does not know" % units if units else "no units in the MDB", q))
    if target.dimension != q.unit.dimension:
        raise MdbError("%s is in %s (%s), not comparable with %r" % (what, units, target.dimension, q))
    if not offset:
        return q.magnitude * q.unit.factor / target.factor
    return q.to(target)


def _fmt(v: Any) -> str:
    if isinstance(v, float):
        return "%.6g" % v
    return repr(v)


class Condition:
    """A predicate on telemetry, evaluated by the runtime against fresh values."""

    def params(self) -> list[Parameter]:
        raise NotImplementedError

    def leaves(self) -> list["Condition"]:
        return [self]

    def test(self, values: Values) -> bool:
        raise NotImplementedError

    def describe(self) -> str:
        raise NotImplementedError

    def explain(self, values: Values) -> str:
        """The condition with the values it was evaluated against."""
        raise NotImplementedError

    def __and__(self, other: "Condition") -> "Condition":
        return All((self, other))

    def __or__(self, other: "Condition") -> "Condition":
        return Any_((self, other))

    def __invert__(self) -> "Condition":
        return Not(self)

    def __bool__(self) -> bool:
        raise TypeError("%s is a condition, not a boolean: use holds(...) to test it now, or pass it "
                        "to verify(), wait_until(), watch() or a step's conditions" % self.describe())

    def __repr__(self) -> str:
        return "<condition %s>" % self.describe()


def _value_of(x: Any, values: Values) -> tuple[Any, bool]:
    """(value, known) of an operand."""
    if isinstance(x, Parameter):
        v = values.get(x.qualified_name)
        if v is None or not v[1]:
            return None, False
        return v[0], True
    return x, True


def _short(p: Parameter) -> str:
    return p.qualified_name


def _operand_text(x: Any) -> str:
    return _short(x) if isinstance(x, Parameter) else _fmt(x)


def _actual(p: Parameter, values: Values) -> str:
    v = values.get(p.qualified_name)
    if v is None:
        return "no value"
    text = _fmt(v[0]) + (" " + p.units if p.units else "")
    return text if v[1] else text + ", invalid"


_OPS: dict[str, Callable[[Any, Any], bool]] = {
    "==": operator.eq, "!=": operator.ne, "<": operator.lt,
    "<=": operator.le, ">": operator.gt, ">=": operator.ge,
}


class Compare(Condition):
    def __init__(self, param: Parameter, op: str, operand: Any):
        self.param, self.op, self.operand = param, op, operand

    def params(self) -> list[Parameter]:
        return [self.param] + ([self.operand] if isinstance(self.operand, Parameter) else [])

    def test(self, values: Values) -> bool:
        a, ka = _value_of(self.param, values)
        b, kb = _value_of(self.operand, values)
        if not (ka and kb):
            return False
        if isinstance(a, float) and math.isnan(a):
            return False
        try:
            return bool(_OPS[self.op](a, b))
        except TypeError:
            return False

    def describe(self) -> str:
        return "%s %s %s" % (_short(self.param), self.op, _operand_text(self.operand))

    def explain(self, values: Values) -> str:
        return "%s (is %s)" % (self.describe(), _actual(self.param, values))


class Between(Condition):
    def __init__(self, param: Parameter, low: Any, high: Any):
        self.param, self.low, self.high = param, low, high

    def params(self) -> list[Parameter]:
        return [self.param] + [x for x in (self.low, self.high) if isinstance(x, Parameter)]

    def test(self, values: Values) -> bool:
        vals = [_value_of(x, values) for x in (self.low, self.param, self.high)]
        if not all(k for _, k in vals):
            return False
        try:
            return bool(vals[0][0] <= vals[1][0] <= vals[2][0])
        except TypeError:
            return False

    def describe(self) -> str:
        return "%s <= %s <= %s" % (_operand_text(self.low), _short(self.param), _operand_text(self.high))

    def explain(self, values: Values) -> str:
        return "%s (is %s)" % (self.describe(), _actual(self.param, values))


class In(Condition):
    def __init__(self, param: Parameter, choices: Sequence[Any]):
        self.param, self.choices = param, tuple(choices)

    def params(self) -> list[Parameter]:
        return [self.param]

    def test(self, values: Values) -> bool:
        a, known = _value_of(self.param, values)
        return known and a in self.choices

    def describe(self) -> str:
        return "%s in (%s)" % (_short(self.param), ", ".join(map(_fmt, self.choices)))

    def explain(self, values: Values) -> str:
        return "%s (is %s)" % (self.describe(), _actual(self.param, values))


class All(Condition):
    def leaves(self) -> list[Condition]:
        return [x for c in self.parts for x in c.leaves()]

    def __init__(self, parts: Iterable[Condition]):
        flat: list[Condition] = []
        for p in parts:
            flat.extend(p.parts if isinstance(p, All) else [p])
        self.parts = tuple(flat)

    def params(self) -> list[Parameter]:
        return [p for c in self.parts for p in c.params()]

    def test(self, values: Values) -> bool:
        return all(c.test(values) for c in self.parts)

    def describe(self) -> str:
        return " and ".join("(%s)" % c.describe() for c in self.parts)

    def explain(self, values: Values) -> str:
        return " and ".join("(%s)" % c.explain(values) for c in self.parts)


class Any_(Condition):
    def leaves(self) -> list[Condition]:
        return [x for c in self.parts for x in c.leaves()]

    def __init__(self, parts: Iterable[Condition]):
        self.parts = tuple(parts)

    def params(self) -> list[Parameter]:
        return [p for c in self.parts for p in c.params()]

    def test(self, values: Values) -> bool:
        return any(c.test(values) for c in self.parts)

    def describe(self) -> str:
        return " or ".join("(%s)" % c.describe() for c in self.parts)

    def explain(self, values: Values) -> str:
        return " or ".join("(%s)" % c.explain(values) for c in self.parts)


class Not(Condition):
    def __init__(self, inner: Condition):
        self.inner = inner

    def leaves(self) -> list[Condition]:
        return self.inner.leaves()

    def params(self) -> list[Parameter]:
        return self.inner.params()

    def test(self, values: Values) -> bool:
        return not self.inner.test(values)

    def describe(self) -> str:
        return "not (%s)" % self.inner.describe()

    def explain(self, values: Values) -> str:
        return "not (%s)" % self.inner.explain(values)


class Change(Condition):
    """A change of a parameter since a baseline, set by the runtime with
    `set_baseline` (or the first value seen)."""

    def __init__(self, param: Parameter, how: str, amount: Optional[float]):
        self.param, self.how, self.amount = param, how, amount
        self.base: Any = None

    def params(self) -> list[Parameter]:
        return [self.param]

    def set_baseline(self, values: Values) -> None:
        self.base, _ = _value_of(self.param, values)

    def test(self, values: Values) -> bool:
        v, known = _value_of(self.param, values)
        if not known:
            return False
        if self.base is None:
            self.base = v
        try:
            if self.how == "rises by":
                return v - self.base >= self.amount
            if self.how == "falls by":
                return self.base - v >= self.amount
            return v != self.base
        except TypeError:
            return False

    def describe(self) -> str:
        if self.amount is None:
            return "%s changes" % _short(self.param)
        return "%s %s %s" % (_short(self.param), self.how, _fmt(self.amount))

    def explain(self, values: Values) -> str:
        base = "no baseline" if self.base is None else "from " + _fmt(self.base)
        return "%s (is %s, %s)" % (self.describe(), _actual(self.param, values), base)


# --- commands -------------------------------------------------------------------
_MISSING: Any = object()


class Arg:
    """A command argument. `name` is the Python keyword, `yamcs_name` the MDB name."""

    __slots__ = ("name", "kind", "labels", "default", "yamcs_name", "min", "max", "units")

    def __init__(self, name: str, kind: str, *, labels: Sequence[str] = (), default: Any = _MISSING,
                 yamcs_name: Optional[str] = None, min: Optional[float] = None, max: Optional[float] = None,
                 units: Optional[str] = None):
        self.units = units
        self.name = name
        self.kind = kind
        self.labels = tuple(labels)
        self.default = default
        self.yamcs_name = yamcs_name or name
        self.min, self.max = min, max

    @property
    def required(self) -> bool:
        return self.default is _MISSING

    def convert(self, value: Any) -> Any:
        """A quantity in the argument's MDB units; other values unchanged."""
        if isinstance(value, _units.Quantity):
            return _convert(value, self.units, "argument %r" % self.name)
        return value

    def problem(self, value: Any) -> Optional[str]:
        try:
            value = self.convert(value)
        except MdbError as e:
            return str(e)
        p = _type_problem(self.kind, self.labels, value)
        if p:
            return p
        if self.kind in _NUMERIC:
            if self.min is not None and value < self.min:
                return "%r is below the minimum %r" % (value, self.min)
            if self.max is not None and value > self.max:
                return "%r is above the maximum %r" % (value, self.max)
        return None


class CommandRequest:
    """A command with its arguments, ready for send()."""

    def __init__(self, command: "Command", args: dict[str, Any]):
        self.command = command
        self.args = args

    def __repr__(self) -> str:
        args = ", ".join("%s=%r" % kv for kv in self.args.items())
        return "%s(%s)" % (self.command.qualified_name, args)


class Command:
    """A telecommand of the MDB. Calling it builds a CommandRequest."""

    def __init__(self, qualified_name: str, args: Sequence[Arg] = (), *,
                 significance: Optional[str] = None, reason: Optional[str] = None,
                 description: Optional[str] = None, verifiers: Optional[Sequence[str]] = None):
        self.qualified_name = qualified_name
        self.args = tuple(args)
        self.significance = significance
        self.reason = reason
        # stages of its MDB verifiers, own and inherited; None: not known (an older generated MDB)
        self.verifiers = tuple(verifiers) if verifiers is not None else None
        self.__doc__ = description
        self.description = description

    def __repr__(self) -> str:
        return "<command %s>" % self.qualified_name

    def problems(self, kwargs: Mapping[str, Any], partial: bool = False) -> list[str]:
        """What is wrong with these keyword arguments. With `partial`, only
        the given values are checked (missing arguments are not reported)."""
        by_name = {a.name: a for a in self.args}
        out = []
        for k, v in kwargs.items():
            a = by_name.get(k)
            if a is None:
                import difflib
                close = difflib.get_close_matches(k, list(by_name), n=1)
                hint = " (did you mean %r?)" % close[0] if close else ""
                out.append("%s has no argument %r%s" % (self.qualified_name, k, hint))
                continue
            p = a.problem(v)
            if p:
                out.append("%s %s: %s" % (self.qualified_name, k, p))
        if not partial:
            for a in self.args:
                if a.required and a.name not in kwargs:
                    out.append("%s: argument %r is required" % (self.qualified_name, a.name))
        return out

    def __call__(self, **kwargs: Any) -> CommandRequest:
        problems = self.problems(kwargs)
        if problems:
            raise MdbError("; ".join(problems))
        values: dict[str, Any] = {}
        for a in self.args:
            v = a.convert(kwargs.get(a.name, a.default))
            if isinstance(v, _dt.datetime):
                v = v.astimezone(_dt.timezone.utc).isoformat().replace("+00:00", "Z")
            values[a.yamcs_name] = v
        return CommandRequest(self, values)


def command(qualified_name: str, args: Sequence[Arg] = (), *, significance: Optional[str] = None,
            reason: Optional[str] = None, verifiers: Optional[Sequence[str]] = None) -> Callable[[F], F]:
    """Decorator used by the generated MDB modules: the decorated function
    only declares the typed signature; calls go to the Command."""
    def deco(fn: F) -> F:
        cmd = Command(qualified_name, args, significance=significance, reason=reason, description=fn.__doc__,
                      verifiers=verifiers)
        functools.update_wrapper(cmd, fn)  # type: ignore[arg-type]
        return cmd  # type: ignore[return-value]
    return deco
