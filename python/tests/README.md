Worker control scenarios (no Yamcs needed except the last):

```bash
cd python/tests
python3 -u drive.py ctl_basic.py '{"gain": 1.5}' scenarios/controls.json --linger --breakpoint 24
python3 -u drive.py ctl_basic.py '{"gain": 1}' scenarios/by_step.json --paused
python3 -u drive.py ../../bench/long_loop.py '' scenarios/hot_loop.json --trace-limit 5
python3 -u drive.py ../../procedures/battery_test.py '{"cycles": 2}' scenarios/battery_test_yamcs.json \
    --yamcs http://localhost:8090 --instance simulator --confirm-commands
```

A scenario is a list of `[event subset, control or list of controls]`; `"$id"`
is replaced by the matched event's id, `{"sleep": s}` waits.
