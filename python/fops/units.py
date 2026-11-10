"""Engineering units.

A number times a unit is a quantity: `1.5 * deg`, `90 * s`, `2 * minute`.
Compared with a parameter, a quantity is converted to the parameter's MDB
units, so `BusVoltage > 25000 * mV` is `BusVoltage > 25` when BusVoltage is
in volts. A unit of another kind (`BusVoltage < 5 * A`) is an MdbError,
and so is a quantity compared with a parameter that has no known units.
A plain number always means the parameter's own units.

Durations (`within=`, `timeout=`, `wait()`) take seconds or a time quantity.
"""
from __future__ import annotations

import math
from typing import Any, Optional


class Unit:
    __slots__ = ("symbol", "dimension", "factor", "offset")

    def __init__(self, symbol: str, dimension: str, factor: float, offset: float = 0.0):
        self.symbol, self.dimension, self.factor, self.offset = symbol, dimension, factor, offset

    def __rmul__(self, value: Any) -> "Quantity":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return NotImplemented
        return Quantity(value, self)

    def __repr__(self) -> str:
        return self.symbol


class Quantity:
    __slots__ = ("magnitude", "unit")

    def __init__(self, magnitude: float, unit: Unit):
        self.magnitude, self.unit = magnitude, unit

    def to(self, unit: Unit) -> float:
        """The magnitude in `unit`; ValueError for another kind of unit."""
        if unit.dimension != self.unit.dimension:
            raise ValueError("%s is a %s, not a %s" % (self, self.unit.dimension, unit.dimension))
        si = self.magnitude * self.unit.factor + self.unit.offset
        return (si - unit.offset) / unit.factor

    def __repr__(self) -> str:
        return "%g %s" % (self.magnitude, self.unit.symbol)

    def __bool__(self) -> bool:
        raise TypeError("%r is a quantity: compare it with a parameter, or convert it with .to()" % self)


_PREFIXES = {"G": 1e9, "M": 1e6, "k": 1e3, "h": 1e2, "c": 1e-2, "m": 1e-3, "u": 1e-6, "µ": 1e-6, "n": 1e-9, "p": 1e-12}

# symbol, dimension, factor to the SI unit, the prefixes it takes (u and µ
# both mean micro). Spelling variants share a row.
_DEFS = [
    # SI base units
    (("m",), "length", 1.0, "kcmuµn"),
    (("g",), "mass", 1e-3, "kmuµ"),
    (("s", "sec"), "time", 1.0, "mnuµ"),
    (("A",), "current", 1.0, "kmuµn"),
    (("K",), "temperature", 1.0, "m"),
    (("mol",), "amount", 1.0, "mu"),
    (("cd",), "luminous intensity", 1.0, ""),
    # SI derived units
    (("rad",), "angle", 1.0, "muµ"),
    (("sr",), "solid angle", 1.0, ""),
    (("Hz",), "frequency", 1.0, "GMk"),
    (("N",), "force", 1.0, "kmuµ"),
    (("Pa",), "pressure", 1.0, "Mkh"),
    (("J",), "energy", 1.0, "Mkm"),
    (("W",), "power", 1.0, "Mkmuµ"),
    (("coulomb",), "charge", 1.0, ""),
    (("V",), "voltage", 1.0, "kmuµ"),
    (("F",), "capacitance", 1.0, "muµnp"),
    (("Ohm", "ohm", "Ω"), "resistance", 1.0, "Mkm"),
    (("S",), "conductance", 1.0, "muµ"),
    (("Wb",), "magnetic flux", 1.0, "m"),
    (("T",), "magnetic flux density", 1.0, "muµn"),
    (("H",), "inductance", 1.0, "muµn"),
    (("lm",), "luminous flux", 1.0, ""),
    (("lx",), "illuminance", 1.0, ""),
    (("Bq",), "radioactivity", 1.0, "kM"),
    (("Gy",), "absorbed dose", 1.0, "m"),
    (("Sv",), "equivalent dose", 1.0, "muµ"),
    (("kat",), "catalytic activity", 1.0, ""),
    # composite SI units
    (("m/s",), "speed", 1.0, "k"),
    (("m/s2", "m/s^2", "m/s²"), "acceleration", 1.0, ""),
    (("rad/s",), "angular rate", 1.0, "m"),
    (("Nm", "N m", "N.m", "N·m"), "torque", 1.0, "m"),
    (("Nms", "N m s", "N.m.s", "N·m·s"), "angular momentum", 1.0, "m"),
    # units accepted for use with the SI
    (("deg", "°"), "angle", math.pi / 180, ""),
    (("arcmin",), "angle", math.pi / 10800, ""),
    (("arcsec",), "angle", math.pi / 648000, "m"),
    (("deg/s", "°/s"), "angular rate", math.pi / 180, ""),
    (("rpm",), "angular rate", math.pi / 30, ""),
    (("min", "minute"), "time", 60.0, ""),
    (("h", "hour"), "time", 3600.0, ""),
    (("day",), "time", 86400.0, ""),
    (("bar",), "pressure", 1e5, "m"),
    (("Wh",), "energy", 3600.0, "k"),
    (("Ah",), "charge", 3600.0, "m"),
    (("t",), "mass", 1e3, ""),
    # data
    (("B",), "data", 1.0, "kMG"),
    (("bit",), "data", 0.125, "kMG"),
    (("bps",), "data rate", 0.125, "kMG"),
    # ratios and levels
    (("%", "percent"), "ratio", 0.01, ""),
    (("dB",), "gain", 1.0, ""),
]


def _build() -> dict[str, Unit]:
    units: dict[str, Unit] = {}

    def add(sym: str, unit: Unit) -> None:
        if sym in units:
            raise AssertionError("unit %r defined twice" % sym)
        units[sym] = unit

    for symbols, dim, factor, prefixes in _DEFS:
        for sym in symbols:
            add(sym, Unit(sym, dim, factor))
            if " " in sym:
                continue
            for p in prefixes:
                add(p + sym, Unit(p + sym, dim, factor * _PREFIXES[p]))
    # with offsets
    for sym in ("degC", "°C", "℃", "C"):
        add(sym, Unit(sym, "temperature", 1.0, 273.15))
    add("dBW", Unit("dBW", "power level", 1.0))
    add("dBm", Unit("dBm", "power level", 1.0, -30.0))
    return units


UNITS: dict[str, Unit] = _build()


def lookup(symbol: Optional[str]) -> Optional[Unit]:
    return UNITS.get(symbol.strip()) if symbol else None


def seconds(x: Any) -> float:
    """A duration in seconds, from a number (seconds) or a time quantity."""
    if isinstance(x, Quantity):
        return x.to(UNITS["s"])
    return float(x)


# SI base
m, km, cm, mm, um, nm = (UNITS[x] for x in ("m", "km", "cm", "mm", "um", "nm"))
kg, g, mg = UNITS["kg"], UNITS["g"], UNITS["mg"]
s, ms, us, ns = UNITS["s"], UNITS["ms"], UNITS["us"], UNITS["ns"]
A, mA, uA = UNITS["A"], UNITS["mA"], UNITS["uA"]
K, mK = UNITS["K"], UNITS["mK"]
mol, cd = UNITS["mol"], UNITS["cd"]
# SI derived
rad, mrad, urad, sr = UNITS["rad"], UNITS["mrad"], UNITS["urad"], UNITS["sr"]
Hz, kHz, MHz, GHz = UNITS["Hz"], UNITS["kHz"], UNITS["MHz"], UNITS["GHz"]
N, mN, kN = UNITS["N"], UNITS["mN"], UNITS["kN"]
Pa, hPa, kPa, MPa = UNITS["Pa"], UNITS["hPa"], UNITS["kPa"], UNITS["MPa"]
J, kJ, MJ = UNITS["J"], UNITS["kJ"], UNITS["MJ"]
W, mW, uW, kW, MW = UNITS["W"], UNITS["mW"], UNITS["uW"], UNITS["kW"], UNITS["MW"]
coulomb = UNITS["coulomb"]
V, mV, uV, kV = UNITS["V"], UNITS["mV"], UNITS["uV"], UNITS["kV"]
F, mF, uF, nF, pF = (UNITS[x] for x in ("F", "mF", "uF", "nF", "pF"))
Ohm, mOhm, kOhm, MOhm = UNITS["Ohm"], UNITS["mOhm"], UNITS["kOhm"], UNITS["MOhm"]
S, mS, uS = UNITS["S"], UNITS["mS"], UNITS["uS"]
Wb, T, mT, uT, nT = UNITS["Wb"], UNITS["T"], UNITS["mT"], UNITS["uT"], UNITS["nT"]
H, mH, uH = UNITS["H"], UNITS["mH"], UNITS["uH"]
lm, lx = UNITS["lm"], UNITS["lx"]
Bq, Gy, mGy, Sv, mSv, uSv = (UNITS[x] for x in ("Bq", "Gy", "mGy", "Sv", "mSv", "uSv"))
kat = UNITS["kat"]
degC = UNITS["degC"]
Nm, mNm, Nms, mNms = UNITS["Nm"], UNITS["mNm"], UNITS["Nms"], UNITS["mNms"]
# accepted for use with the SI
deg, arcmin, arcsec = UNITS["deg"], UNITS["arcmin"], UNITS["arcsec"]
rpm = UNITS["rpm"]
minute, hour, day = UNITS["minute"], UNITS["hour"], UNITS["day"]
bar, mbar = UNITS["bar"], UNITS["mbar"]
Wh, kWh, Ah, mAh = UNITS["Wh"], UNITS["kWh"], UNITS["Ah"], UNITS["mAh"]
# data, ratios, levels
B, kB, MB, GB = UNITS["B"], UNITS["kB"], UNITS["MB"], UNITS["GB"]
bit, kbit, Mbit = UNITS["bit"], UNITS["kbit"], UNITS["Mbit"]
bps, kbps, Mbps = UNITS["bps"], UNITS["kbps"], UNITS["Mbps"]
percent = UNITS["%"]
dB, dBW, dBm = UNITS["dB"], UNITS["dBW"], UNITS["dBm"]
