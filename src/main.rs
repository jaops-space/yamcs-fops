mod bench;
mod protocol;
mod runner;
mod worker;
mod yamcs;

use std::path::PathBuf;

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

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Run(a) => std::process::exit(worker::run(a)?),
        Cmd::Check { procedures } => {
            let extra = procedures.first().and_then(|p| std::fs::canonicalize(p).ok()?.parent().map(PathBuf::from));
            let argv = procedures.iter().map(|p| p.to_string_lossy().to_string()).collect();
            std::process::exit(worker::run_tool("check", argv, extra)?)
        }
        Cmd::Inspect { procedure } => {
            let extra = std::fs::canonicalize(&procedure).ok().and_then(|p| p.parent().map(PathBuf::from));
            std::process::exit(worker::run_tool("describe", vec![procedure.to_string_lossy().to_string()], extra)?)
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
            std::process::exit(worker::run_tool("mdbgen", argv, None)?)
        }
        Cmd::Runner(a) => runner::run(a),
        Cmd::Bench(a) => bench::run(a),
    }
}
