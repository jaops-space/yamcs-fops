"""Battery campaign: the functional test of battery 1, then its power
cycle. Each runs as its own execution (a sub-procedure), with its own
as-run journal; this procedure waits for each and gets its confirmation.
"""
from fops import Arg, log, procedure, run

proc = procedure("Battery campaign", version="1.0", description=__doc__,
                 args={"cycles": Arg(int, default=1, min=1, max=10, description="off/on cycles of the test"),
                       "off_time": Arg(float, default=10.0, min=1, max=120, unit="s",
                                       description="how long battery 1 stays off in the power cycle")})


@proc.step("Functional test")
def functional():
    """Not confirmed (the operator decides) unless the test is."""
    r = run("battery_test.py", args={"cycles": proc.args.cycles, "settle": 2.0})
    log("battery test: %s in %.0f s" % (r.confirmation, r.duration))


@proc.step("Power cycle")
def power_cycle():
    run("power_cycle.py", args={"off_time": proc.args.off_time})
