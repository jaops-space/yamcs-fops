# Releasing

One version for the three pieces: the tag `v<version>` releases the Python
package, `distribution/release.sh` releases the Yamcs plugin with it, and
the VS Code extension is published with the same version.

## The Yamcs plugin `com.jaops.yamcs:yamcs-fops`

```bash
distribution/release.sh
```

asks for the version (default: the pom's without `-SNAPSHOT`), sets it in
`plugin/pom.xml`, `dev/yamcs/pom.xml`, `Cargo.toml` and `vscode/package.json`,
commits, tags
`v<version>` (unless the tag exists), builds the web UI and the jar from a
clean clone of the commit with the profile `jaops-release` (sources, javadoc,
GPG signature with the Jaops release key `C56E028076F3CCB9`) and, when you
confirm, uploads them to the Central Portal. Then:

1. Publish the deployment at
   <https://central.sonatype.com/publishing/deployments> (it is not
   published automatically).
2. The script has set the next `-SNAPSHOT` version and committed it. Push:

   ```bash
   git push origin main v<version>
   ```

   A new tag publishes the Python package of that version (below).
3. Publish the VS Code extension, which the script has given the same version:

   ```bash
   cd vscode && npx vsce publish
   ```

   It needs `npx vsce login jaops` once, with an Azure DevOps personal
   access token (all accessible organizations, scope Marketplace: Manage).
   Not `vsce publish patch`: it commits and tags `v<version>` itself.

It needs, on the machine that runs it: the Jaops signing key in GPG, and the
Central Portal token of the Jaops account as the server `central-jaops` in
`~/.m2/settings.xml` (as for the other `com.jaops.yamcs` plugins), and npm.

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
