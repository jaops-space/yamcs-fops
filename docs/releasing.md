# Releasing

## The Python package `yamcs-fops`

`pip install yamcs-fops` installs the `fops` command (the worker and the
tools) and the `fops` Python package. It is this repository's Rust crate
built as a Python extension (`fops_cli._native`, by maturin, from
`pyproject.toml`); its `main` runs the same command line as the `fops`
binary of `cargo build`. It needs no libpython: it runs in the Python that
installed it. One wheel per CPython version (3.12 to 3.14) and Linux
architecture (x86_64, aarch64): the worker uses CPython APIs outside the
stable ABI.

The workflow `.github/workflows/python.yml` builds the wheels and the sdist on
every push and publishes them to PyPI for a tag `v<version>`, with PyPI's
trusted publishing: no token is stored anywhere.

### Once

1. On <https://pypi.org/manage/account/publishing/>, add a pending
   publisher: project `yamcs-fops`, owner `jaops-space`, repository
   `yamcs-fops`, workflow `python.yml`, environment `pypi`. The first
   release creates the project.
2. In the GitHub repository, Settings → Environments, create the environment
   `pypi` (optionally with required reviewers, so each publication waits for
   an approval).

### Each release

1. Set the version in `Cargo.toml` (the package's version comes from it).
2. Commit, then tag and push:

   ```bash
   git tag v0.1.0
   ```

   ```bash
   git push origin v0.1.0
   ```

The publish job refuses a tag that is not the version of `Cargo.toml`.

### Building locally

In a virtual environment with `pip install maturin`:

```bash
maturin build --release --out dist
```

builds the wheel for that environment's Python, and

```bash
maturin develop --release
```

installs it into the environment, for trying `fops` as users get it.
