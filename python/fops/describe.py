"""`fops inspect FILE`: what a procedure declares, as one JSON object, for
user interfaces. The top level is loaded as by `fops check` (never the
steps); functions are the file's top-level ones that are not steps or
watch handlers."""
from __future__ import annotations

import ast
import json
import os
from typing import Any, Optional

from fops.check import check_file, load


def _conds(cs: Any) -> Optional[str]:
    return " & ".join(c.describe() for c in cs) if cs else None


def _functions(tree: ast.Module, path: str, listed: list) -> list[dict]:
    """The file's top-level functions, but those already in the outline as
    steps or watch handlers (`listed`)."""
    path = os.path.abspath(path)
    shown = {f.__code__.co_firstlineno for f in listed
             if os.path.abspath(f.__code__.co_filename) == path}
    return [{"name": n.name, "line": n.lineno, "endLine": n.end_lineno} for n in tree.body
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
            and min([n.lineno] + [d.lineno for d in n.decorator_list]) not in shown]


# Seconds a run spends beyond its waits, for the estimate: per step, per command sent
_STEP_S = 1.0
_SEND_S = 2.0


def _sub_seconds(path: str, args: dict, depth: int) -> Optional[float]:
    """A sub-procedure's declared duration, else its estimate with these arguments."""
    from fops import _runtime
    from fops._runtime import Args, Procedure
    if depth > 3 or not os.path.isfile(path):
        return None
    saved = _runtime._MAIN_FILE
    try:
        ld = load(path)
        procs = [v for v in ld.g.values() if isinstance(v, Procedure)]
        if ld.error or ld.tree is None:
            return None
        if len(procs) == 1:
            if procs[0].duration is not None:
                return procs[0].duration
            _runtime._ARG_VALUES = args
            procs[0].args = Args(_runtime._bind_args(procs[0].arg_specs))
        est = _estimate(ld.tree, ld.g, depth + 1)
        return est["seconds"] if est else None
    except Exception:
        return None
    finally:
        _runtime._MAIN_FILE, _runtime._ARG_VALUES = saved, None


def _estimate(tree: ast.AST, g: dict, depth: int = 0) -> Optional[dict]:
    """How long a run takes, from the source: its waits whose duration can be
    worked out at load time (literals, units, the arguments' defaults, local
    variables assigned from those, an ask() taken as its default), times the
    counts of the `for ... in range(...)` loops around them, plus a little per
    step and per command, and the sub-procedures run() waits for (their
    declared duration or their own estimate; paths from the procedures root,
    the working directory). Goals, wait_until and prompts are not counted.
    None if there is nothing to count."""
    waits = sends = subs = 0.0
    steps = 0
    base = dict(g, ask=lambda *a, default=None, **k: default)
    scope: dict[str, Any] = {}   # the local variables known so far in the current function

    def value(node: ast.AST) -> Any:
        return eval(compile(ast.Expression(node), "<estimate>", "eval"), dict(base, **scope))

    def visit(node: ast.AST, times: float) -> None:
        nonlocal waits, sends, subs, steps, scope
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if any(isinstance(d, ast.Call) and isinstance(d.func, ast.Attribute) and d.func.attr == "step"
                   for d in node.decorator_list):
                steps += 1
            outer, scope = scope, {}
            for child in node.body:
                visit(child, times)
            scope = outer
            return
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            try:
                scope[node.targets[0].id] = value(node.value)
            except Exception:
                scope.pop(node.targets[0].id, None)
        if isinstance(node, ast.For) and isinstance(node.iter, ast.Call) \
                and isinstance(node.iter.func, ast.Name) and node.iter.func.id == "range":
            try:
                n = len(value(node.iter))
            except Exception:
                n = 1
            for child in node.body:
                visit(child, times * n)
            for child in node.orelse:
                visit(child, times)
            return
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id == "wait" and node.args:
                try:
                    waits += times * max(_seconds(value(node.args[0])), 0.0)
                except Exception:
                    pass
            elif node.func.id == "send":
                sends += times
            elif node.func.id == "run" and node.args and isinstance(node.args[0], ast.Constant) \
                    and isinstance(node.args[0].value, str) \
                    and not any(k.arg == "wait" for k in node.keywords):
                path = node.args[0].value if node.args[0].value.endswith(".py") else node.args[0].value + ".py"
                try:
                    args = next((value(k.value) for k in node.keywords if k.arg == "args"), None) or {}
                except Exception:
                    args = {}
                sub = _sub_seconds(path, args, depth)
                if sub is not None:
                    subs += times * sub
        for child in ast.iter_child_nodes(node):
            visit(child, times)

    from fops.units import seconds as _seconds
    visit(tree, 1.0)
    if not (waits or sends or subs or steps):
        return None
    total = waits + sends * _SEND_S + steps * _STEP_S + subs
    return {"seconds": round(total), "waits": round(waits), "commands": round(sends), "steps": steps,
            "procedures": round(subs)}


def inspect_file(path: str) -> dict:
    from fops._runtime import Procedure
    ld = load(path)
    problems = check_file(path, ld)
    d: dict[str, Any] = {
        "path": path, "declaresProcedure": not ld.script and ld.tree is not None,
        "name": os.path.splitext(os.path.basename(path))[0], "version": None,
        "description": ast.get_docstring(ld.tree) if ld.tree is not None else None,
        "author": ld.g.get("__author__"), "args": [], "requires": None, "invariant": None,
        "steps": [], "watches": [], "functions": [],
        "check": [{"line": line, "message": msg} for line, msg in sorted(set(problems.items))],
        "error": ld.error, "duration": None,
        "estimate": _estimate(ld.tree, ld.g) if ld.tree is not None and not ld.error else None,
    }
    procs = [v for v in ld.g.values() if isinstance(v, Procedure)]
    if ld.script and ld.tree is not None:
        d["steps"] = [{"index": 0, "name": "Script", "line": 1, "cleanup": False, "goal": None,
                       "requires": None, "invariant": None, "ensures": None}]
    elif len(procs) == 1:
        p = procs[0]
        d.update(name=p.name, version=p.version, duration=p.duration,
                 args=[a.spec() for a in p.arg_specs.values()],
                 requires=_conds(p.requires), invariant=_conds(p.invariant))
        if p.description is not None:
            d["description"] = p.description
        if p.author is not None:
            d["author"] = p.author
        d["steps"] = [{"index": s.index, "name": s.name, "line": s.line, "cleanup": s.cleanup,
                       "goal": _conds(s.goal), "requires": _conds(s.requires),
                       "invariant": _conds(s.invariant), "ensures": _conds(s.ensures)} for s in p.steps]
        d["watches"] = [{"line": w.line, "condition": w.condition.describe(), "then": w.then,
                         "handler": w.handler.__name__ if w.handler else None}
                        for w in p.watches if not w.internal]
    if ld.tree is not None:
        listed = [s.fn for p in procs for s in p.steps] + [w.handler for p in procs for w in p.watches if w.handler]
        d["functions"] = _functions(ld.tree, path, listed)
    if d["author"] is not None:
        d["author"] = str(d["author"])
    return d


def main(argv: list[str]) -> int:
    for path in argv:
        print(json.dumps(inspect_file(path), default=str))
    return 0
