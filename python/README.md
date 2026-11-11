# yamcs-fops

Flight (and test) operations procedures for [Yamcs](https://yamcs.org): procedures
written in Python against a package generated from the Yamcs MDB, run one traced
line at a time and monitored and controlled from Yamcs-web.

This package is the worker: the `fops` command (`fops run`, `fops check`,
`fops mdb-gen`, ...) and the `fops` Python package that procedures import. It
works with the Yamcs plugin `com.jaops.yamcs:yamcs-fops` of the same version,
on Maven Central.

```bash
pip install yamcs-fops
```

Installation, configuration and the procedure language:
<https://github.com/jaops-space/yamcs-fops>.
