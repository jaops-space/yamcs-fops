# fops for VS Code

Help for writing flight operations procedures (see the top-level README of the fops repository).
Procedures are Python files: the Python extension (Pylance) still does the
Python. This extension adds what it knows from fops and the generated MDB
package.

- **`fops check` as you type.** Each change is checked (unsaved text is
  written to a temporary copy, never to the file), so a misspelled
  parameter, an enumeration label that does not exist, an unknown command
  argument or `if event_id == "EVENT_1":` are underlined before saving.
  Quick fixes apply the check's suggestions: *Change to
  'INVALID_VOLTAGE_NUM'*, *Import from mdb.SIMULATOR.tm*, *Test it now with
  holds(...)*.
- **Enumeration labels.** In `event_id == "`, `event_id.is_in("` and
  `SWITCH_VOLTAGE_ON_ENUM(voltage_num="`, the labels of the parameter or
  argument are completed.
- **MDB names with their import.** The parameters and commands of the MDB
  matching what is typed (from two letters, at most 100) are completed,
  with their qualified name; picking one adds
  `from mdb.SIMULATOR.tm import BusVoltage` (into an existing import of the same
  module when there is one). A name already imported from another space
  system gets an alias (`pus22_status_report`). Commands are inserted with
  their required arguments. *fops: Insert MDB Parameter or Command…*
  searches names, qualified names and descriptions.
- **Hovers** give a parameter's qualified name, type, units and labels, and
  a command's significance and arguments (type, default, range, labels).
- **Code lenses** above each step (`step 2/5 · 3 conditions`, the
  conditions in the tooltip) and each watch.
- **Explorer views.** *FOP Procedure*: the active procedure as `fops
  inspect` sees it (requires, invariant, arguments, steps with their
  conditions, watches); click to go to the line. *FOP MDB*: the space
  systems with their telemetry and commands; insert or copy the qualified
  name from the context menu.
- **Snippets**: `fproc`, `fstep`, `fstepfull`, `fcleanup`, `fwatch`,
  `fsend`, `fsendbg`, `fverify`, `fwaituntil`, `fask`, `fsnap`, `farg`.
- **Commands**: *Check All Procedures* (into Problems), *Run Procedure in
  Terminal* (`fops run --control`, after a confirmation, since it sends the
  commands; asks for the arguments), *Regenerate MDB Package from Yamcs*
  (`fops mdb-gen`; the views and checks reload when it is written), and
  *Configure Python Analysis Paths* (adds `python/` and the MDB package's
  directory to `python.analysis.extraPaths`, so Pylance resolves
  `fops` and `mdb`).

A file is a procedure when it imports `fops` or the MDB package. The MDB
package is found in the workspace (a package whose `__init__.py` has
`FINGERPRINT =`, as written by `fops mdb-gen`), or set with
`fops.mdbPackage`.

## Settings

| setting | default | |
|---|---|---|
| `fops.executable` | `target/release/fops` in the workspace, else `fops` | the binary |
| `fops.mdbPackage` | found | e.g. `procedures/mdb` |
| `fops.yamcs.url` | `http://localhost:8090` | for Run and Regenerate |
| `fops.yamcs.instance` | the MDB's instance | |
| `fops.check.onType` | `true` | otherwise on open and save only |
| `fops.check.delay` | `500` | ms after the last change |
| `fops.codeLens` | `true` | |
| `fops.completion.autoImport` | `true` | complete names not imported yet |

## Build

```bash
npm install
```

```bash
npm run package
```

```bash
code --install-extension fops-vscode-0.1.1.vsix
```

Or open `vscode/` in VS Code and press F5. Tests: `npm test` (MDB parsing
and imports, without VS Code), and `npm run test:vscode`, which opens a
VS Code window with a throwaway profile and checks diagnostics, quick
fixes, completion, hovers, code lenses and the views on an unsaved edit
of `procedures/verification_test.py` (reverted at the end; needs
`target/release/fops`).

## License

The extension (this directory) is under the MIT license, see `LICENSE`.
The rest of fops is under the AGPL-3.0.
