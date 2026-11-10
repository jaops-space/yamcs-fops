"""fops: flight operations procedures for Yamcs.

A procedure is a Python file declaring one procedure() with ordered steps:

    from fops import procedure, send
    from mdb.SIMULATOR.tm import BatteryVoltage1, BusVoltage
    from mdb.SIMULATOR.tc import SWITCH_VOLTAGE_ON

    proc = procedure("Battery check", version="1.0", requires=BusVoltage > 25)

    @proc.step("Battery 1 on", goal=BatteryVoltage1 > 20)
    def battery_on():
        send(SWITCH_VOLTAGE_ON(voltage_num=1))

Telemetry parameters (`tm`) and commands (`tc`) come from the package
generated from the Yamcs MDB (`fops mdb-gen`). A file without procedure()
runs as a plain script: one step, no conditions.
"""
from fops.items import Condition, MdbError, Parameter
from fops._runtime import (
    Arg,
    ArgumentError,
    CommandFailed,
    CommandResult,
    InvariantViolated,
    OperationFailed,
    ProcedureAborted,
    ProcedureFailed,
    ProcedureResult,
    Running,
    Sent,
    SetFailed,
    Snapshot,
    VerificationFailed,
    abort,
    ask,
    finish,
    holds,
    log,
    param,
    procedure,
    run,
    send,
    snapshot,
    verify,
    wait,
    wait_until,
    yamcs_client,
)

__all__ = [
    "Arg", "ArgumentError", "param", "Condition", "MdbError", "Parameter", "CommandFailed", "CommandResult", "InvariantViolated",
    "OperationFailed", "ProcedureAborted", "ProcedureFailed", "ProcedureResult", "Running", "Sent", "SetFailed", "Snapshot", "VerificationFailed", "abort", "ask",
    "finish", "holds", "log", "procedure", "run", "send", "snapshot", "verify", "wait", "wait_until",
    "yamcs_client",
]
