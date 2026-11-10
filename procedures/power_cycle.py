"""Power cycle of battery 1: wait for charged batteries, switch battery 1
off, keep the bus on batteries 2 and 3 for a while, switch battery 1 back
on.

Written for the Yamcs PUS simulator: its batteries read 27 to 31 V when on
and 0 V when off, and their capacity runs down from 100 % to 0 % in about
8 minutes, then starts again.
"""
from fops import Arg, log, procedure, send, snapshot, wait
from fops.units import V, minute, percent
from mdb.SIMULATOR.tc import SWITCH_VOLTAGE_OFF, SWITCH_VOLTAGE_ON, SWITCH_VOLTAGE_ON_ENUM
from mdb.SIMULATOR.tm import (BatteryTemperature1, BatteryVoltage1, BatteryVoltage2,
                              BatteryVoltage3, BusCurrent, BusVoltage)
from mdb.SIMULATOR.tm import AllowCriticalTC1, BatteryCapacity2

BAT1_ON = BatteryVoltage1 > 20 * V
BAT1_OFF = BatteryVoltage1 == 0
# BatteryVoltage2 has no unit in the MDB, and a calibration (1 + 2 * raw):
# a plain number, in its calibrated values.
OTHERS_ON = (BatteryVoltage2 > 40) & (BatteryVoltage3 > 20 * V)

proc = procedure(
    "Battery 1 power cycle",
    version="1.0",
    description=__doc__,
    args={"off_time": Arg(float, default=20.0, min=1, max=120, unit="s",
                          description="how long battery 1 stays off")},
    requires=[BAT1_ON, OTHERS_ON],
    # Checked on every update from the first step on; violated, the
    # procedure aborts and the cleanup step switches battery 1 back on.
    invariant=BusVoltage > 20 * V,
)

proc.watch(BAT1_OFF & (BatteryCapacity2 < 20 * percent), then="abort",
           message="batteries 2 and 3 below 20 % with battery 1 off")


@proc.step("Batteries charged")
def charged():
    """Skipped when batteries 2 and 3 are above 50 %, otherwise awaited
    for up to 10 minutes (the simulator's capacity starts again at 100 %)."""
    log("waiting for batteries 2 and 3 to be above 50 %", level="warning")
    AllowCriticalTC1.set(False)


@proc.step("Battery 1 off", goal=BAT1_OFF)
def off():
    p = snapshot(BatteryVoltage1, BatteryTemperature1, BusVoltage, BusCurrent)
    log("battery 1 at %d V, %d C; bus at %d V, %d A"
        % (p[BatteryVoltage1], p[BatteryTemperature1], p[BusVoltage], p[BusCurrent]))
    send(SWITCH_VOLTAGE_OFF(voltage_num=1), confirm=BAT1_OFF)
    


@proc.step("Bus on batteries 2 and 3", invariant=OTHERS_ON, ensures=BusVoltage > 25 * V)
def bus_without_battery_1():
    """Battery 1 stays off for `off_time` seconds; batteries 2 and 3 must
    stay on meanwhile."""
    wait(proc.args.off_time)


@proc.step("Battery 1 on", goal=BAT1_ON, cleanup=True)
def on():
    """Also runs when the procedure aborts; skipped when battery 1 is on."""
    send(SWITCH_VOLTAGE_ON(voltage_num=1), confirm=BAT1_ON)
