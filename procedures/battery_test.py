"""Battery 1 functional test with arguments: check the link with a PUS
connection test, switch battery 1 off and on a few times, then leave it on
(or off, if the operator wants).

Shows procedure arguments (`Arg`, read as `proc.args.<name>`) and the kinds
of operator prompts: options, text, number.
"""
from fops import Arg, ask, holds, log, procedure, send, wait
from fops.units import V
from mdb.PUS17.tc import ARE_YOU_ALIVE
from mdb.SIMULATOR.tc import SWITCH_VOLTAGE_OFF, SWITCH_VOLTAGE_ON
from mdb.SIMULATOR.tm import BatteryVoltage1, BusVoltage

__author__ = "power subsystem"

BAT1_ON = BatteryVoltage1 > 20 * V
BAT1_OFF = BatteryVoltage1 == 0

proc = procedure("Battery test", version="1.0",
                 args={"cycles": Arg(int, default=2, description="off/on cycles", min=1, max=10),
                       "settle": Arg(float, default=2.0, description="time off, then on, per cycle",
                                     min=1, unit="s"),
                       "power_on": Arg(bool, default=True, description="switch battery 1 on at the end")},
                 requires=BusVoltage > 25 * V)


@proc.step("Connection test")
def connection():
    """TC[17,1]: the simulator answers with TM[17,2]."""
    send(ARE_YOU_ALIVE())


@proc.step("Off/on cycles", ensures=BAT1_ON)
def cycles():
    note = ask("Comment for the test log?", hint="journaled with the results", default="routine test")
    settle = ask("Seconds off, then on, per cycle?", kind="number", hint="at least 1",
                 default=proc.args.settle)
    for k in range(proc.args.cycles):
        send(SWITCH_VOLTAGE_OFF(voltage_num=1), confirm=BAT1_OFF)
        wait(max(settle, 1.0))
        send(SWITCH_VOLTAGE_ON(voltage_num=1), confirm=BAT1_ON)
        if k + 1 < proc.args.cycles:
            wait(max(settle, 1.0))
    log("%d off/on cycles of battery 1: %s" % (proc.args.cycles, note))


@proc.step("Battery 1 on", cleanup=True)
def battery_on():
    cycles()
    if holds(BAT1_ON):
        return
    if not proc.args.power_on and ask("Leave battery 1 off?", ["LEAVE OFF", "SWITCH ON"]) == "LEAVE OFF":
        return
    send(SWITCH_VOLTAGE_ON(voltage_num=1), confirm=BAT1_ON)
