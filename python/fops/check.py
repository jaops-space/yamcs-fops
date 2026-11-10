"""Checks procedures against the generated MDB without running them.

Loading a procedure runs only its top level (imports, definitions,
procedure(), requires= and watch() conditions), never its steps; that
already rejects unknown parameters and commands. On top of that the source
is scanned for:

- comparisons of a parameter with a literal that can never match
  (an enumeration label that does not exist, a string for a number...)
- command calls with unknown or missing arguments, or bad literal values
- conditions used as booleans (`if event_id == "EVENT_1":`), which are always
  errors at run time: read `.value` instead
- run("other.py", args={...}) of a procedure that does not exist, or with
  arguments it does not declare, lacks, or would refuse
- send(CMD(...), until="Stage") with a verifier stage the command does not have
- p.set(value) of a parameter that is not local, or with a literal that does not fit it
- assignments to an imported parameter or command name, or to p.value

A file without procedure() is a plain script: only its imports are loaded
(running the rest would send its commands), and a warning says so.
"""
from __future__ import annotations

import ast
import difflib
import importlib
import importlib.util
import os
import sys
import traceback
from typing import Any, Optional

from fops.items import Command, MdbError, Parameter


class _Problems:
    def __init__(self, path: str):
        self.path = path
        self.items: list[tuple[int, str]] = []

    def add(self, line: int, msg: str) -> None:
        self.items.append((line, msg))


def _line_in(tb: Any, path: str) -> int:
    for frame, line in traceback.walk_tb(tb):
        if frame.f_code.co_filename == path:
            return line
    return 0


def _import_hint(e: ImportError) -> str:
    """Close matches for a misspelled MDB name."""
    name, mod = getattr(e, "name_from", None), e.name
    if mod and name is None:
        # `cannot import name X from Y`
        msg = str(e)
        if "cannot import name" in msg:
            name = msg.split("'")[1]
    try:
        module = importlib.import_module(mod) if mod else None
    except ImportError:
        parent, _, last = (mod or "").rpartition(".")
        try:
            names = [n for n in dir(importlib.import_module(parent))] if parent else []
        except ImportError:
            names = []
        close = difflib.get_close_matches(last, names, n=1)
        return " (did you mean %s.%s?)" % (parent, close[0]) if close else ""
    if module is not None and name:
        for kind in ("tm", "tc"):
            if hasattr(getattr(module, kind, None), name):
                return " (it is in %s.%s: telemetry is in .tm, commands in .tc)" % (mod, kind)
        close = difflib.get_close_matches(name, [n for n in dir(module) if not n.startswith("_")], n=1)
        return " (did you mean %s?)" % close[0] if close else ""
    return ""


def _procedures_root(path: str) -> str:
    """Where run() looks procedures up: the folder of the generated `mdb`
    package (the procedures directory), else the procedure's own folder."""
    try:
        spec = importlib.util.find_spec("mdb")
    except (ImportError, ValueError):
        spec = None
    if spec is not None and spec.submodule_search_locations:
        return os.path.dirname(list(spec.submodule_search_locations)[0])
    return os.path.dirname(os.path.abspath(path))


class _Scanner(ast.NodeVisitor):
    def __init__(self, g: dict[str, Any], problems: _Problems, tree: ast.Module):
        self.g = g
        self.problems = problems
        # names bound by the imports of the file
        self.imported = {a.asname or a.name.split(".")[0] for n in ast.walk(tree)
                         if isinstance(n, (ast.Import, ast.ImportFrom)) for a in n.names}

    def resolve(self, node: ast.AST) -> Any:
        """The module-level object an expression names, if any."""
        if isinstance(node, ast.Name):
            return self.g.get(node.id)
        if isinstance(node, ast.Attribute):
            base = self.resolve(node.value)
            if base is not None and not isinstance(base, (Parameter, Command)):
                return getattr(base, node.attr, None)
        return None

    def literal(self, node: ast.AST) -> tuple[bool, Any]:
        try:
            return True, ast.literal_eval(node)
        except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
            return False, None

    def check_operand(self, param: Parameter, node: ast.AST) -> None:
        ok, value = self.literal(node)
        if ok:
            try:
                param.check_operand(value)
            except MdbError as e:
                self.problems.add(node.lineno, str(e))

    def visit_Compare(self, node: ast.Compare) -> None:
        operands = [node.left] + list(node.comparators)
        for a, b in zip(operands, operands[1:]):
            for x, y in ((a, b), (b, a)):
                p = self.resolve(x)
                if isinstance(p, Parameter):
                    self.check_operand(p, y)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        target = self.resolve(node.func)
        if isinstance(target, Command):
            if node.args:
                self.problems.add(node.lineno, "%s: pass arguments by name (e.g. %s(%s=...))"
                                  % (target.qualified_name, node.func.id if isinstance(node.func, ast.Name) else "CMD",
                                     target.args[0].name if target.args else "arg"))
            given = {}
            unknown_values = set()
            for kw in node.keywords:
                if kw.arg is None:  # **kwargs: cannot check statically
                    unknown_values = {"**"}
                    continue
                ok, value = self.literal(kw.value)
                if ok:
                    given[kw.arg] = value
                else:
                    unknown_values.add(kw.arg)
            for p in target.problems(given, partial=True):
                self.problems.add(node.lineno, p)
            names = {a.name for a in target.args}
            for k in unknown_values - {"**"}:
                if k not in names:
                    self.problems.add(node.lineno, "%s has no argument %r" % (target.qualified_name, k))
            if "**" not in unknown_values:
                for a in target.args:
                    if a.required and a.name not in given and a.name not in unknown_values:
                        self.problems.add(node.lineno, "%s: argument %r is required" % (target.qualified_name, a.name))
        elif target is not None and target is _run_function():
            self.check_run(node)
        elif target is not None and target is _send_function():
            self.check_send(node)
        elif isinstance(node.func, ast.Attribute) and node.func.attr in ("between", "is_in"):
            p = self.resolve(node.func.value)
            if isinstance(p, Parameter):
                for arg in node.args:
                    self.check_operand(p, arg)
        elif isinstance(node.func, ast.Attribute) and node.func.attr == "set":
            p = self.resolve(node.func.value)
            if isinstance(p, Parameter):
                self.check_set(p, node)
        self.generic_visit(node)

    def check_set(self, param: Parameter, node: ast.Call) -> None:
        """p.set(value): p is a local parameter, and a literal value fits it."""
        ok, value = self.literal(node.args[0]) if node.args else (False, None)
        try:
            if ok:
                param.set_value(value)
            elif not param.writable:
                raise MdbError("%s is not a local parameter: only those can be set" % param.qualified_name)
        except MdbError as e:
            self.problems.add(node.lineno, str(e))

    def check_send(self, node: ast.Call) -> None:
        """send(CMD(...), until="Stage"): the command has that verifier."""
        from fops._runtime import _stage_problem
        until = next((k.value for k in node.keywords if k.arg == "until"), None)
        if until is None or not node.args or not isinstance(node.args[0], ast.Call):
            return
        cmd = self.resolve(node.args[0].func)
        ok, value = self.literal(until)
        if not ok:
            return
        try:
            problem = _stage_problem(cmd, value) if isinstance(cmd, Command) else None
        except TypeError as e:
            problem = str(e)
        if problem:
            self.problems.add(node.lineno, "send(until=%r): %s" % (value, problem) if "until=" not in problem else problem)

    def check_run(self, node: ast.Call) -> None:
        """run("other.py", args={...}): the procedure exists and takes these arguments."""
        from fops._runtime import ArgumentError, Procedure
        ok, name = self.literal(node.args[0]) if node.args else (False, None)
        if not ok or not isinstance(name, str):
            return
        if not name.endswith(".py"):
            name += ".py"
        path = os.path.join(_procedures_root(self.problems.path), name)
        if not os.path.isfile(path):
            self.problems.add(node.lineno, "run(): no procedure %r in %s" % (name, _procedures_root(self.problems.path)))
            return
        if os.path.abspath(path) == os.path.abspath(self.problems.path):
            self.problems.add(node.lineno, "warning: run(%r): the procedure runs itself" % name)
            return
        kw = {k.arg: k.value for k in node.keywords}
        given: Optional[dict] = {}
        if "args" in kw:
            ok, given = self.literal(kw["args"])
            if not ok or not isinstance(given, dict):
                given = None  # not a literal: only the procedure's existence is checked
        target = _loaded(path)
        if target.error is not None:
            self.problems.add(node.lineno, "run(%r): it does not load: %s" % (name, target.error))
            return
        if given is None:
            return
        procs = [v for v in target.g.values() if isinstance(v, Procedure)]
        specs = procs[0].arg_specs if len(procs) == 1 else {}
        for k, v in given.items():
            if k not in specs:
                close = difflib.get_close_matches(str(k), list(specs), n=1)
                self.problems.add(node.lineno, "run(%r) has no argument %r%s" % (
                    name, k, " (did you mean %s?)" % close[0] if close else ""))
                continue
            try:
                specs[k].convert(v)
            except ArgumentError as e:
                self.problems.add(node.lineno, "run(%r): %s" % (name, e))
        for k, a in specs.items():
            if a.required and k not in given:
                self.problems.add(node.lineno, "run(%r): argument %r is required" % (name, k))

    def _boolean_use(self, test: ast.AST) -> None:
        nodes = [test]
        if isinstance(test, ast.BoolOp):
            nodes = list(test.values)
        elif isinstance(test, ast.UnaryOp) and isinstance(test.op, ast.Not):
            nodes = [test.operand]
        for n in nodes:
            hit: Optional[Parameter] = None
            if isinstance(self.resolve(n), Parameter):
                hit = self.resolve(n)
            elif isinstance(n, ast.Compare):
                for x in [n.left] + list(n.comparators):
                    if isinstance(self.resolve(x), Parameter):
                        hit = self.resolve(x)
            if hit is not None:
                self.problems.add(n.lineno, "%s is telemetry, not a value: a comparison builds a condition "
                                  "(use holds(...) to test it now, or %s.value)" % (hit.qualified_name, ast.unparse(
                                      n.left if isinstance(n, ast.Compare) else n)))

    def visit_Name(self, node: ast.Name) -> None:
        """An assignment to an imported MDB name hides it (in a function, a
        local variable): `AllowCriticalTC1 = False` sets nothing in Yamcs."""
        if isinstance(node.ctx, ast.Store) and node.id in self.imported:
            item = self.g.get(node.id)
            if isinstance(item, Parameter):
                self.problems.add(node.lineno, "`%s = ...` hides the parameter %s (a Python assignment sets nothing "
                                  "in Yamcs): use %s.set(...), or another variable name"
                                  % (node.id, item.qualified_name, node.id))
            elif isinstance(item, Command):
                self.problems.add(node.lineno, "`%s = ...` hides the command %s: use another variable name"
                                  % (node.id, item.qualified_name))

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if isinstance(node.ctx, ast.Store) and node.attr == "value":
            p = self.resolve(node.value)
            if isinstance(p, Parameter):
                self.problems.add(node.lineno, "%s.value is read-only: set a local parameter with %s.set(...)"
                                  % (p.qualified_name, ast.unparse(node.value)))
        self.generic_visit(node)

    def visit_If(self, node: ast.If) -> None:
        self._boolean_use(node.test)
        self.generic_visit(node)

    def visit_While(self, node: ast.While) -> None:
        self._boolean_use(node.test)
        self.generic_visit(node)

    def visit_Assert(self, node: ast.Assert) -> None:
        self._boolean_use(node.test)
        self.generic_visit(node)


class Loaded:
    """A procedure file whose top level ran (never its steps)."""

    def __init__(self, path: str):
        self.path = path
        self.problems = _Problems(path)
        self.g: dict[str, Any] = {}
        self.tree: Optional[ast.Module] = None
        self.script = False
        self.error: Optional[str] = None   # the top level failed

    def fail(self, line: int, msg: str) -> "Loaded":
        self.problems.add(line, msg)
        self.error = "line %d: %s" % (line, msg) if line else msg
        return self


def load(path: str) -> Loaded:
    from fops import _runtime
    from fops._runtime import declares_procedure
    ld = Loaded(path)
    with open(path) as f:
        source = f.read()
    try:
        tree = ast.parse(source, path)
        code = compile(tree, path, "exec")
    except SyntaxError as e:
        return ld.fail(e.lineno or 0, "syntax error: %s" % e.msg)
    ld.tree = tree
    ld.g = g = {"__name__": "__fops_check__", "__file__": path}
    ld.script = script = not declares_procedure(tree)
    if script:
        imports = ast.Module(body=[n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))],
                             type_ignores=[])
        code = compile(imports, path, "exec")
    # Lines of watch() and procedure() calls are found in this file; arguments
    # are not enforced (none are given).
    _runtime._MAIN_FILE, _runtime._STRICT_ARGS, _runtime._ARG_VALUES = path, False, None
    try:
        exec(code, g)
    except ImportError as e:
        return ld.fail(_line_in(e.__traceback__, path), "%s%s" % (e, _import_hint(e)))
    except (MdbError, TypeError) as e:
        if hasattr(e, "line"):   # an assignment hiding an MDB name, in a step or handler
            return ld.fail(e.line, e.problem)
        return ld.fail(_line_in(e.__traceback__, path), str(e))
    except Exception as e:
        return ld.fail(_line_in(e.__traceback__, path), "%s: %s" % (type(e).__name__, e))
    return ld


def _run_function() -> Any:
    from fops import _runtime
    return _runtime.run


def _send_function() -> Any:
    from fops import _runtime
    return _runtime.send


_LOADED: dict[str, Loaded] = {}


def _loaded(path: str) -> Loaded:
    """A procedure called with run(), loaded once."""
    from fops import _runtime
    key = os.path.abspath(path)
    if key not in _LOADED:
        saved = _runtime._MAIN_FILE
        try:
            _LOADED[key] = load(path)
        finally:
            _runtime._MAIN_FILE = saved
    return _LOADED[key]


def check_file(path: str, ld: Optional[Loaded] = None) -> _Problems:
    from fops._runtime import Procedure, procedure_calls
    ld = ld or load(path)
    problems = ld.problems
    if ld.script:
        problems.add(0, "warning: no procedure(): runs as a plain script, one step without "
                        "preconditions, confirmation or cleanup")
    if ld.error is not None or ld.tree is None:
        return problems
    procs = [v for v in ld.g.values() if isinstance(v, Procedure)]
    calls = procedure_calls(ld.tree)
    if ld.script:
        pass
    elif len(calls) > 1:
        for line in calls[1:]:
            problems.add(line, "a second procedure(): a file declares exactly one, at line %d" % calls[0])
    elif len(procs) != 1:
        problems.add(0, "a procedure file must declare exactly one procedure(), found %d" % len(procs))
    elif not procs[0].steps:
        problems.add(0, "procedure %r has no steps" % procs[0].name)
    _Scanner(ld.g, problems, ld.tree).visit(ld.tree)
    _undefined_names(ld.g, problems, ld.tree)
    return problems


def _undefined_names(g: dict[str, Any], problems: _Problems, tree: ast.Module) -> None:
    """Names read in the file (in a step body, say) that nothing defines: a
    NameError only once that line runs. A name bound anywhere in the file
    counts as defined, so this never reports a name that may be defined."""
    import builtins
    bound = set(g) | set(dir(builtins))
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and not isinstance(n.ctx, ast.Load):
            bound.add(n.id)
        elif isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(n.name)
        elif isinstance(n, ast.arg):
            bound.add(n.arg)
        elif isinstance(n, (ast.Import, ast.ImportFrom)):
            bound.update(a.asname or a.name.split(".")[0] for a in n.names)
        elif isinstance(n, (ast.Global, ast.Nonlocal)):
            bound.update(n.names)
        elif isinstance(n, ast.ExceptHandler) and n.name:
            bound.add(n.name)
        elif isinstance(n, (ast.MatchAs, ast.MatchStar)) and n.name:
            bound.add(n.name)
        elif isinstance(n, ast.MatchMapping) and n.rest:
            bound.add(n.rest)
    candidates = [k for k in bound if not k.startswith("_")]
    for n in ast.walk(tree):
        if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load) and n.id not in bound \
                and not (n.id.startswith("__") and n.id.endswith("__")):
            close = difflib.get_close_matches(n.id, candidates, n=1)
            problems.add(n.lineno, "undefined name %s%s" % (n.id, " (did you mean %s?)" % close[0] if close else ""))


def main(argv: list[str]) -> int:
    total = 0
    for path in argv:
        problems = check_file(path)
        for line, msg in sorted(set(problems.items)):
            print("%s:%d: %s" % (path, line, msg))
        errors = [m for _, m in problems.items if not m.startswith("warning:")]
        total += len(errors)
        if not problems.items:
            print("%s: ok" % path)
    return 1 if total else 0
