"""Generates a Python package from the MDB of a Yamcs instance.

Each XTCE space system becomes a package with two modules: `tm` for its
telemetry parameters and `tc` for its commands. /SIMULATOR/BusVoltage is
`BusVoltage` in `<package>.SIMULATOR.tm`, /SIMULATOR/SWITCH_VOLTAGE_ON is
`SWITCH_VOLTAGE_ON` in `<package>.SIMULATOR.tc`; a parameter and a command may share a name. A
space system itself named tm or tc becomes `tm_` / `tc_` (with a warning).
Names that are not Python identifiers are adjusted (`-` and other characters
to `_`, a leading digit or a keyword gets `_`); the exact Yamcs name is kept
in the object. Two names that end up the same stop the generation.

Units come from the MDB unit sets; a parameter without one whose short
description is exactly a unit symbol fops knows ("deg", "%", "W"...) gets
that as its units.

The fingerprint is a hash of the MDB entries the package is generated from:
the Yamcs plugin regenerates the package when it changes (docs/plugin-api.md).

Usage: fops mdb-gen --yamcs http://localhost:8090 --instance simulator --out procedures

or, from the listings in a file ({"parameters": [...], "commands": [...]},
as the Yamcs plugin writes them): fops mdb-gen --mdb FILE --instance ...
"""
from __future__ import annotations

import datetime
import hashlib
import json
import keyword
import os
import re
import shutil
import sys
import urllib.parse
import urllib.request
from typing import Any, Optional

from fops import units as _units

_KINDS = ("tm", "tc")

# Parameters from these sources are not spacecraft telemetry.
_SKIP_SOURCES = {"SYSTEM", "COMMAND", "COMMAND_HISTORY", "EXTERNAL1", "EXTERNAL2", "EXTERNAL3"}

_PY_TYPES = {
    "float": "float", "integer": "int", "boolean": "bool", "string": "str",
    "binary": "bytes", "time": "str", "aggregate": "dict", "array": "list",
}


def _get(base: str, path: str, token_file: Optional[str], **query: Any) -> Any:
    url = base.rstrip("/") + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    req = urllib.request.Request(url)
    if token_file:
        with open(token_file) as f:
            req.add_header("Authorization", "Bearer " + f.read().strip())
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _list(base: str, path: str, key: str, token_file: Optional[str]) -> list[dict]:
    out: list[dict] = []
    token = None
    while True:
        q: dict[str, Any] = {"limit": 500, "details": "true"}
        if token:
            q["next"] = token
        page = _get(base, path, token_file, **q)
        out.extend(page.get(key, []))
        token = page.get("continuationToken")
        if not token:
            return out


def ident(name: str) -> str:
    s = re.sub(r"\W", "_", name)
    if not s or s[0].isdigit():
        s = "_" + s
    if keyword.iskeyword(s) or keyword.issoftkeyword(s):
        s += "_"
    return s


def _kind(t: dict) -> str:
    eng = (t or {}).get("engType", "")
    return eng or "unknown"


def _labels(t: dict) -> list[str]:
    return [e["label"] for e in (t or {}).get("enumValue", [])]


def _annotation(kind: str, labels: list[str]) -> str:
    if kind.endswith("[]"):
        return "list[%s]" % _annotation(kind[:-2], labels)
    if kind == "enumeration" and labels:
        return "_Literal[%s]" % ", ".join(json.dumps(l) for l in labels)
    return _PY_TYPES.get(kind, "_Any")


def _unit_of(t: dict, desc: Optional[str]) -> Optional[str]:
    units = [u.get("unit") for u in (t or {}).get("unitSet", []) if u.get("unit")]
    if units:
        return " ".join(units)
    return desc.strip() if desc and _units.lookup(desc) else None


def _dir(name: str) -> str:
    """Python name of a space system's package."""
    py = ident(name)
    return py + "_" if py in _KINDS else py


def _default(kind: str, v: Optional[str]) -> Any:
    if v is None:
        return None
    try:
        if kind == "integer":
            return int(v)
        if kind == "float":
            return float(v)
        if kind == "boolean":
            return v.lower() == "true"
    except ValueError:
        pass
    return v


class _System:
    def __init__(self, path: tuple[str, ...]):
        self.path = path
        self.params: list[dict] = []
        self.commands: list[dict] = []
        self.children: set[str] = set()


def _effective_args(cmd: dict, by_name: dict[str, dict]) -> list[dict]:
    """Arguments the operator sets: own and inherited, minus those assigned
    anywhere along the inheritance chain."""
    chain = []
    c: Optional[dict] = cmd
    while c is not None:
        chain.append(c)
        base = c.get("baseCommand")
        c = by_name.get(base["qualifiedName"]) if base else None
    assigned = {a["name"] for c in chain for a in c.get("argumentAssignment", [])}
    out, seen = [], set()
    for c in chain:
        for a in c.get("argument", []):
            if a["name"] not in assigned and a["name"] not in seen:
                seen.add(a["name"])
                out.append(a)
    return out


def _verifier_stages(cmd: dict, by_name: dict[str, dict]) -> list[str]:
    """Stages of the command's verifiers, inherited ones first; a command
    overrides the verifier of a stage its base command has."""
    chain = []
    c: Optional[dict] = cmd
    while c is not None:
        chain.append(c)
        base = c.get("baseCommand")
        c = by_name.get(base["qualifiedName"]) if base else None
    out: list[str] = []
    for c in reversed(chain):
        for v in c.get("verifier", []):
            if v.get("stage") and v["stage"] not in out:
                out.append(v["stage"])
    return out


def fetch(base: str, instance: str, token_file: Optional[str] = None) -> tuple[list[dict], list[dict]]:
    """The parameters and commands of the instance's MDB, with details."""
    return (_list(base, "/api/mdb/%s/parameters" % instance, "parameters", token_file),
            _list(base, "/api/mdb/%s/commands" % instance, "commands", token_file))


def generate(params: list[dict], commands: list[dict], instance: str, out_dir: str,
             package: str) -> tuple[list[str], int, int]:
    """Writes the package; returns (warnings, parameters, commands)."""
    cmd_by_name = {c["qualifiedName"]: c for c in commands}

    systems: dict[tuple[str, ...], _System] = {(): _System(())}

    def system(path: tuple[str, ...]) -> _System:
        if path not in systems:
            systems[path] = _System(path)
            system(path[:-1]).children.add(path[-1])
        return systems[path]

    params = [p for p in params
              if not p["qualifiedName"].startswith("/yamcs/") and p.get("dataSource") not in _SKIP_SOURCES]
    for p in params:
        system(tuple(p["qualifiedName"].strip("/").split("/")[:-1])).params.append(p)
    for c in commands:
        if c.get("abstract"):
            continue
        system(tuple(c["qualifiedName"].strip("/").split("/")[:-1])).commands.append(c)

    warnings: list[str] = []
    root = os.path.join(out_dir, package)
    if os.path.isdir(root):
        shutil.rmtree(root)
    # of what the package is made of (abstract commands as bases), not of the Yamcs-internal parameters
    by_qn = lambda x: x["qualifiedName"]
    fingerprint = hashlib.sha256(json.dumps([sorted(params, key=by_qn), sorted(commands, key=by_qn)],
                                            sort_keys=True).encode()).hexdigest()[:16]
    for path, s in sorted(systems.items()):
        _write_system(root, instance, fingerprint, s, cmd_by_name, warnings)
    n_params = sum(len(s.params) for s in systems.values())
    n_cmds = sum(len(s.commands) for s in systems.values())
    return warnings, n_params, n_cmds


def _write_system(root: str, instance: str, fingerprint: str, s: _System,
                  cmd_by_name: dict[str, dict], warnings: list[str]) -> None:
    pkg_dir = os.path.join(root, *[_dir(x) for x in s.path])
    os.makedirs(pkg_dir, exist_ok=True)
    title = "/" + "/".join(s.path) if s.path else "(root)"
    if s.path and ident(s.path[-1]) in _KINDS:
        warnings.append("space system %s is %s in Python: tm and tc name the telemetry and command modules"
                        % (title, _dir(s.path[-1])))

    def claimer(kind: str) -> Any:
        taken: dict[str, str] = {}

        def claim(name: str, qn: str) -> str:
            py = ident(name)
            if py in taken:
                raise SystemExit("name clash in %s.%s: %s and %s are both %s in Python" % (title, kind, taken[py], qn, py))
            taken[py] = qn
            return py
        return claim

    head = [
        "",
        "Generated by `fops mdb-gen` (MDB fingerprint %s). Do not edit." % fingerprint,
        '"""',
        "from __future__ import annotations",
        "",
    ]
    kinds = [k for k, items in (("tm", s.params), ("tc", s.commands)) if items]
    init = ['"""Space system %s of Yamcs instance %s.' % (title, instance)] + head
    if kinds:
        init += ["from . import %s" % ", ".join(kinds), ""]
    if not s.path:
        init += ["INSTANCE = %r" % instance, "FINGERPRINT = %r" % fingerprint,
                 "GENERATED = %r" % datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), ""]
    _write(os.path.join(pkg_dir, "__init__.py"), "\n".join(init).rstrip() + "\n")
    if s.params:
        _write(os.path.join(pkg_dir, "tm.py"), _tm_source(title, instance, head, s, claimer("tm")))
    if s.commands:
        _write(os.path.join(pkg_dir, "tc.py"), _tc_source(title, instance, head, s, claimer("tc"), cmd_by_name))


def _tm_source(title: str, instance: str, head: list[str], s: _System, claim: Any) -> str:
    lines = ['"""Telemetry parameters of space system %s (Yamcs instance %s).' % (title, instance)] + head + [
        "from typing import Any as _Any, Literal as _Literal",
        "",
        "from fops.items import Parameter as _Parameter",
        "",
    ]
    for p in sorted(s.params, key=lambda p: p["name"]):
        qn = p["qualifiedName"]
        py = claim(p["name"], qn)
        t = p.get("type", {})
        kind, labels = _kind(t), _labels(t)
        desc = p.get("shortDescription") or p.get("longDescription")
        units = _unit_of(t, desc)
        kw = ["%r" % qn, "%r" % kind]
        if labels:
            kw.append("labels=(%s)" % ", ".join(map(repr, labels)) + ("," if len(labels) == 1 else ""))
        if units:
            kw.append("units=%r" % units)
        if desc and desc != units:
            kw.append("description=%r" % desc)
        if p.get("dataSource") == "LOCAL":
            kw.append("writable=True")
        lines.append("%s: _Parameter[%s] = _Parameter(%s)" % (py, _annotation(kind, labels), ", ".join(kw)))
        doc = " ".join(x for x in [desc if desc != units else None, "[%s]" % units if units else None] if x)
        if doc:
            lines.append('"""%s"""' % doc.replace('"""', "'''"))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _tc_source(title: str, instance: str, head: list[str], s: _System, claim: Any,
               cmd_by_name: dict[str, dict]) -> str:
    lines = ['"""Commands of space system %s (Yamcs instance %s).' % (title, instance)] + head + [
        "from typing import Any as _Any, Literal as _Literal",
        "",
        "from fops.items import Arg as _Arg, CommandRequest as _CommandRequest, command as _command",
        "",
    ]
    for c in sorted(s.commands, key=lambda c: c["name"]):
        qn = c["qualifiedName"]
        py = claim(c["name"], qn)
        sig = c.get("effectiveSignificance") or c.get("significance") or {}
        lines += _command_source(py, qn, c, sig, cmd_by_name)
    return "\n".join(lines).rstrip() + "\n"


def _command_source(py: str, qn: str, c: dict, sig: dict, cmd_by_name: dict[str, dict]) -> list[str]:
    args = _effective_args(c, cmd_by_name)
    specs, params = [], []
    used: set[str] = set()
    # required arguments first, so the signature stays valid Python
    ordered = sorted(args, key=lambda a: a.get("initialValue") is not None)
    for a in ordered:
        t = a.get("type", {})
        kind, labels = _kind(t), _labels(t)
        name = ident(a["name"])
        if name in used:
            raise SystemExit("name clash in %s: two arguments are %s in Python" % (qn, name))
        used.add(name)
        default = _default(kind, a.get("initialValue"))
        kw = ["%r" % name, "%r" % kind]
        if labels:
            kw.append("labels=(%s)" % ", ".join(map(repr, labels)) + ("," if len(labels) == 1 else ""))
        if a.get("initialValue") is not None:
            kw.append("default=%r" % default)
        if name != a["name"]:
            kw.append("yamcs_name=%r" % a["name"])
        arg_units = _unit_of(t, None)
        if arg_units:
            kw.append("units=%r" % arg_units)
        for bound in ("rangeMin", "rangeMax"):
            if t.get(bound) is not None:
                kw.append("%s=%r" % (bound[5:].lower(), t[bound]))
        specs.append("_Arg(%s)" % ", ".join(kw))
        ann = _annotation(kind, labels)
        params.append("%s: %s = %r" % (name, ann, default) if a.get("initialValue") is not None else "%s: %s" % (name, ann))
    deco = ["%r" % qn]
    if specs:
        deco.append("args=(%s,)" % ", ".join(specs))
    level = sig.get("consequenceLevel")
    if level and level != "NONE":
        deco.append("significance=%r" % level)
        if sig.get("reasonForWarning"):
            deco.append("reason=%r" % sig["reasonForWarning"])
    stages = _verifier_stages(c, cmd_by_name)
    deco.append("verifiers=(%s)" % ", ".join(map(repr, stages)) + ("," if len(stages) == 1 else ""))
    desc = c.get("shortDescription") or c.get("longDescription") or ""
    signature = "*, " + ", ".join(params) if params else ""
    return [
        "@_command(%s)" % ", ".join(deco),
        "def %s(%s) -> _CommandRequest:" % (py, signature),
        '    """%s"""' % desc.replace('"""', "'''") if desc else '    """%s"""' % qn,
        "    ...",
        "",
        "",
    ]


def _write(path: str, text: str) -> None:
    with open(path, "w") as f:
        f.write(text)


def main(argv: list[str]) -> int:
    base, instance, out_dir, package, token_file, mdb_file = (argv + ["", ""])[:6]
    if mdb_file:
        with open(mdb_file) as f:
            mdb = json.load(f)
        params, commands = mdb.get("parameters", []), mdb.get("commands", [])
    else:
        params, commands = fetch(base, instance, token_file or None)
    warnings, n_params, n_cmds = generate(params, commands, instance, out_dir, package)
    for w in warnings:
        print("warning:", w, file=sys.stderr)
    print("generated %s/%s: %d parameters, %d commands from Yamcs instance %s"
          % (out_dir, package, n_params, n_cmds, instance))
    return 0
