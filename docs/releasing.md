# Releasing

One version for the three pieces, released together from one machine:

| piece | where | name |
|---|---|---|
| the Yamcs plugin | Maven Central | `com.jaops.yamcs:yamcs-fops` |
| the worker and the procedure language | PyPI | `yamcs-fops` |
| the VS Code extension | the Marketplace | `jaops.fops-vscode` |

```bash
distribution/release.sh
```

releases all three; `distribution/release.sh pypi` (or `maven`, `vscode`, any
of them) only those. The script:

1. checks that the uploads have what they need (below) before changing
   anything;
2. asks for the version (default: the pom's without `-SNAPSHOT`) and sets it
   in `plugin/pom.xml`, `dev/yamcs/pom.xml`, `Cargo.toml` (the Python
   package's version is the crate's) and `Cargo.lock`, `vscode/package.json`
   and its lock file, and the install instructions of `README.md` and
   `vscode/README.md`; commits `Release yamcs-fops-<version>`;
3. builds from a clean clone of that commit, in
   `distribution/target/yamcs-fops-<version>/`: the web UI and the jar
   (profile `jaops-release`: sources, javadoc, GPG signature), the six wheels
   and the sdist, the `.vsix`;
4. tags the commit `v<version>`;
5. asks before each upload: Maven Central, PyPI, the Marketplace;
6. sets the next `-SNAPSHOT` version in the poms, commits it, and asks before
   `git push origin main v<version>`.

What was not done (declined, or failed) is printed with its command, and the
builds are kept for it; otherwise they are deleted. After the Maven upload,
publish the deployment at
<https://central.sonatype.com/publishing/deployments>: it is not published
automatically.

A `-SNAPSHOT` version goes to Maven Central Snapshots only (enabled for the
`com.jaops` namespace in the Central Portal): no tag, no Python package or
extension.

## What it needs

- **Maven Central**: the Jaops signing key `C56E028076F3CCB9` in GPG, and the
  Central Portal token of the Jaops account as the server `central-jaops` in
  `~/.m2/settings.xml` (as for the other `com.jaops.yamcs` plugins); npm, for
  the web UI.
- **PyPI**: an API token of the `yamcs-fops` project, in `~/.pypirc`:

  ```ini
  [pypi]
  username = __token__
  password = pypi-...
  ```

  or as `TWINE_PASSWORD` (with `TWINE_USERNAME=__token__`). And the Rust
  target `aarch64-unknown-linux-gnu` (`rustup target add`). The script makes
  its own virtual environment, `distribution/target/venv`, with maturin, zig
  and twine.
- **The Marketplace**: `npx vsce login jaops` once (in `vscode/`), with an
  Azure DevOps personal access token (all accessible organizations, scope
  Marketplace: Manage).

## The Python package `yamcs-fops`

`pip install yamcs-fops` installs the `fops` command (the worker and the
tools) and the `fops` Python package. It is this repository's Rust crate
built as a Python extension (`fops_cli._native`, by maturin, from
`pyproject.toml`); its `main` runs the same command line as the `fops`
binary of `cargo build`. It needs no libpython: it runs in the Python that
installed it. One wheel per CPython version (3.12 to 3.14) and Linux
architecture (x86_64, aarch64): the worker uses CPython APIs outside the
stable ABI. The script builds all six on one machine with zig, which
cross-compiles to aarch64 and links against glibc 2.28 (`manylinux_2_28`);
the interpreters need not be installed.

The workflow `.github/workflows/python.yml` builds them on every push to
`main`, as a check; it publishes nothing.

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
