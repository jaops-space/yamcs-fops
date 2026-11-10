"""Test of the PUS request verification (ST[1]) of the simulator's battery
switch-on command. The simulator answers SWITCH_VOLTAGE_ON according to the
battery number:

- 1: acceptance, start and completion reports;
- 2: no start report, then a successful completion;
- 3: a failed completion, with a random error code;
- 4: a failed start, INVALID_VOLTAGE_NUM.

The failures are what is tested: a step confirms when its command fails as
expected, and its `ensures=` checks the telemetry afterwards.
"""
from fops import CommandFailed, log, procedure, send
from fops.units import V
from mdb.PUS.tm import tc_ack_completion_failure_code, tc_ack_start_failure_code
from mdb.PUS17.tc import ARE_YOU_ALIVE
from mdb.SIMULATOR.tc import SWITCH_VOLTAGE_ON
from mdb.SIMULATOR.tm import BatteryVoltage1, BatteryVoltage2, BatteryVoltage3

proc = procedure("Command verification test", version="1.0", description=__doc__,
                 requires=BatteryVoltage3 > 20 * V)


def expect_failure(request):
    """Sends the request, which must fail; returns the failure."""
    try:
        r = send(request, on_failure="raise")
    except CommandFailed as e:
        log("failed as expected: %s" % e)
        return e
    raise CommandFailed("%s completed, a failure was expected" % r.name)


@proc.step("Connection test")
def connection():
    send(ARE_YOU_ALIVE())


@proc.step("All reports", ensures=BatteryVoltage1 > 20 * V)
def all_reports():
    send(SWITCH_VOLTAGE_ON(voltage_num=1))


@proc.step("No start report", ensures=BatteryVoltage2 > 40)
def no_start_report():
    """The simulator sends no start report; the command still completes."""
    r = send(SWITCH_VOLTAGE_ON(voltage_num=2))
    log("completed in %.1f s without a start report" % r.duration)


@proc.step("Failed completion", ensures=BatteryVoltage3 > 20 * V)
def failed_completion():
    """The failure leaves battery 3 as it was: on."""
    expect_failure(SWITCH_VOLTAGE_ON(voltage_num=3))
    log("completion failure code: %s" % tc_ack_completion_failure_code.value)


@proc.step("Failed start", ensures=tc_ack_start_failure_code == "INVALID_VOLTAGE_NUM")
def failed_start():
    expect_failure(SWITCH_VOLTAGE_ON(voltage_num=4))
