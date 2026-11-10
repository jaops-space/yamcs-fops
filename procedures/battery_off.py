"""Battery 1 off, as a plain script: no procedure(), so the whole file runs
as one step, without preconditions or confirmation. Commands are still
tracked and journaled."""
from fops import send
from mdb.SIMULATOR.tc import SWITCH_VOLTAGE_OFF
from mdb.SIMULATOR.tm import BatteryVoltage1

send(SWITCH_VOLTAGE_OFF(voltage_num=1), confirm=BatteryVoltage1 == 0)
