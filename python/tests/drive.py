"""Drives `fops run --control` from a scenario (python3 -u drive.py ...).
drive.py PROC 'ARGS-JSON' SCRIPT.json [extra flags...]
SCRIPT: list of [match, control] : when an event matches (dict subset), send control (dict or list)."""
import json, subprocess, sys, threading, time
import os
B = os.environ.get("FOPS", os.path.join(os.path.dirname(__file__), "../../target/release/fops"))
proc, args, script = sys.argv[1], sys.argv[2], json.loads(open(sys.argv[3]).read())
extra = sys.argv[4:]
cmd = [B, "run", proc, "--control"] + (["--args", args] if args else []) + extra
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
def send(c, ev):
    for x in (c if isinstance(c, list) else [c]):
        x = {k: (ev.get("id") if v == "$id" else v) for k, v in x.items()}
        if "sleep" in x: time.sleep(x["sleep"]); continue
        print("   >>", json.dumps(x)); p.stdin.write(json.dumps(x) + "\n"); p.stdin.flush()
SKIP = {"code", "outcome", "started"}
i = 0
for line in p.stdout:
    ev = json.loads(line)
    if ev["type"] not in SKIP and not (ev["type"] == "line"):
        e = {k: v for k, v in ev.items() if k not in ("stats", "steps", "time")}
        print(json.dumps(e)[:400])
    while i < len(script) and all(ev.get(k) == v for k, v in script[i][0].items()):
        send(script[i][1], ev); i += 1
        break
    if ev["type"] == "finished" and "--linger" not in extra:
        break
    if ev["type"] == "finished" and "--linger" in extra and i >= len(script):
        p.stdin.close()
        for rest in p.stdout: print("after close:", rest.strip()[:300])
        break
p.wait(10)
err = p.stderr.read().strip().splitlines()
print("EXIT", p.returncode, "| stderr:", err[-3:])
