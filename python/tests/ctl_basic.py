"""Local test procedure (no Yamcs): variables, eval, skip, goto, run_to."""
from fops import Arg, ask, log, procedure, wait

__author__ = "test"

proc = procedure("Control test", version="1.0",
                 args={"count": Arg(int, default=3, description="loops", min=1, max=10),
                       "mode": Arg(str, choices=["A", "B"], default="A"),
                       "gain": Arg(float, unit="dB")})

TOTAL = 0


def helper(x):
    y = x * 2
    return y


@proc.step("First")
def first():
    global TOTAL
    a = 1
    b = helper(a)
    log("a=%d b=%d" % (a, b))
    c = a + b
    TOTAL += c
    log("c=%d" % c)


@proc.step("Second")
def second():
    for i in range(proc.args.count):
        log("loop %d" % i)
    name = ask("Your name?", hint="any text", default="nobody")
    n = ask("How many?", kind="number", default=2)
    choice = ask("Go?", ["GO", "NOGO"])
    log("%s %r %s gain=%s mode=%s" % (name, n, choice, proc.args.gain, proc.args.mode))
