//! fops: the command line, also the Python extension `fops_cli._native` of
//! the `yamcs-fops` package, whose `fops` command calls its `main`.

mod bench;
mod protocol;
mod runner;
mod worker;
mod yamcs;

use std::path::PathBuf;
use std::sync::OnceLock;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "fops", about = "Flight operations procedures for Yamcs")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Execute one procedure in this process (the Yamcs plugin spawns one per execution).
    Run(worker::WorkerArgs),
    /// Run the workers of a Yamcs plugin elsewhere than in Yamcs (docs/remote-workers.md).
    Runner(runner::RunnerArgs),
    /// Check procedures against the generated MDB without running them.
    Check {
        #[arg(required = true)]
        procedures: Vec<PathBuf>,
    },
    /// Print what a procedure declares (name, args, steps, watches, check findings) as JSON.
    Inspect {
        #[arg(required = true)]
        procedure: PathBuf,
    },
    /// Generate the Python MDB package from a Yamcs instance.
    MdbGen {
        #[command(flatten)]
        yamcs: yamcs::YamcsConfig,
        /// Directory to write the package into (usually the procedures directory).
        #[arg(long, default_value = "procedures")]
        out: PathBuf,
        /// Name of the generated package.
        #[arg(long, default_value = "mdb")]
        package: String,
        /// Read the MDB from this file ({"parameters": [...], "commands": [...]}) instead of --yamcs.
        #[arg(long)]
        mdb: Option<PathBuf>,
    },
    /// Compare tracing strategies on a procedure.
    Bench(bench::BenchArgs),
}

/// The `fops` command line: the exit code.
pub fn cli<I: IntoIterator<Item = T>, T: Into<std::ffi::OsString> + Clone>(args: I) -> anyhow::Result<i32> {
    let cli = Cli::parse_from(args);
    match cli.cmd {
        Cmd::Run(a) => worker::run(a),
        Cmd::Check { procedures } => {
            let extra = procedures.first().and_then(|p| std::fs::canonicalize(p).ok()?.parent().map(PathBuf::from));
            let argv = procedures.iter().map(|p| p.to_string_lossy().to_string()).collect();
            worker::run_tool("check", argv, extra)
        }
        Cmd::Inspect { procedure } => {
            let extra = std::fs::canonicalize(&procedure).ok().and_then(|p| p.parent().map(PathBuf::from));
            worker::run_tool("describe", vec![procedure.to_string_lossy().to_string()], extra)
        }
        Cmd::MdbGen { yamcs, out, package, mdb } => {
            let mdb = mdb.map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
            let url = match yamcs.url {
                Some(u) => u,
                None if !mdb.is_empty() => String::new(),
                None => anyhow::bail!("--yamcs URL or --mdb file is required"),
            };
            let token = yamcs.yamcs_token_file.map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
            let argv = vec![url, yamcs.instance, out.to_string_lossy().to_string(), package, token, mdb];
            worker::run_tool("mdbgen", argv, None)
        }
        Cmd::Runner(a) => runner::run(a).map(|()| 0),
        Cmd::Bench(a) => bench::run(a).map(|()| 0),
    }
}

/// The program to run for `fops ...`: this one, or the `fops` script of the
/// Python package when running as its extension.
static SELF_EXE: OnceLock<PathBuf> = OnceLock::new();

pub fn self_exe() -> std::io::Result<PathBuf> {
    match SELF_EXE.get() {
        Some(p) => Ok(p.clone()),
        None => std::env::current_exe(),
    }
}

/// Running as the extension of the Python package, in its interpreter.
pub fn is_extension() -> bool {
    SELF_EXE.get().is_some()
}

/// `fops_cli._native.main()`, the `fops` script of the Python package: runs the
/// command line of `sys.argv` without the GIL, as the binary does, and exits.
#[pyo3::pyfunction]
fn main(py: pyo3::Python<'_>) -> pyo3::PyResult<()> {
    use pyo3::types::PyAnyMethods;
    let sys = py.import("sys")?;
    let argv: Vec<String> = sys.getattr("argv")?.extract()?;
    if let Some(script) = argv.first() {
        let _ = SELF_EXE.set(std::path::absolute(script).unwrap_or_else(|_| script.into()));
    }
    let code = py.detach(|| match cli(&argv) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Error: {e:?}");
            1
        }
    });
    sys.getattr("stdout")?.call_method0("flush")?;
    sys.getattr("stderr")?.call_method0("flush")?;
    // Worker threads may still hold Python objects: no interpreter finalization.
    std::process::exit(code)
}

#[pyo3::pymodule]
fn _native(m: &pyo3::Bound<'_, pyo3::types::PyModule>) -> pyo3::PyResult<()> {
    use pyo3::types::PyModuleMethods;
    m.add_function(pyo3::wrap_pyfunction!(main, m)?)
}
