//! Runs a procedure under each tracing strategy (each in a fresh worker
//! process, events serialised but discarded) and prints a comparison.

use std::path::PathBuf;
use std::process::Command;

use anyhow::{Context, Result, bail};
use serde_json::Value;

#[derive(clap::Args)]
pub struct BenchArgs {
    pub procedure: PathBuf,
    /// Repetitions per configuration (best time is reported).
    #[arg(long, default_value_t = 3)]
    pub repeat: usize,
    /// Trace limits to try in monitor mode.
    #[arg(long, value_delimiter = ',', default_value = "100,0")]
    pub limits: Vec<u64>,
}

pub fn run(a: BenchArgs) -> Result<()> {
    let exe = crate::self_exe()?;
    let mut configs: Vec<(String, Vec<String>)> = vec![
        ("off (no tracing)".into(), vec!["--trace-mode".into(), "off".into()]),
        ("legacy settrace (SPELL-style)".into(), vec!["--trace-mode".into(), "legacy".into()]),
        ("monitor, unlimited".into(), vec!["--unlimited".into()]),
    ];
    for l in &a.limits {
        configs.push((format!("monitor, limit {l}"), vec!["--trace-limit".into(), l.to_string()]));
    }

    println!("{:<36} {:>10} {:>12} {:>12} {:>8}", "configuration", "best ms", "callbacks", "events", "vs off");
    let mut baseline = None;
    for (name, args) in configs {
        let mut best: Option<(f64, Value)> = None;
        for _ in 0..a.repeat {
            let out = Command::new(&exe).arg("run").arg(&a.procedure).args(["--events", "null"]).args(&args).output()?;
            let stderr = String::from_utf8_lossy(&out.stderr);
            let last = stderr.lines().last().context("no output from worker")?;
            let v: Value = serde_json::from_str(last).with_context(|| format!("worker said: {stderr}"))?;
            if v["status"] != "finished" {
                bail!("{name}: procedure ended with {}: {stderr}", v["status"]);
            }
            let ms = v["elapsed_ms"].as_f64().unwrap_or(0.0);
            if best.as_ref().is_none_or(|(b, _)| ms < *b) {
                best = Some((ms, v));
            }
        }
        let (ms, v) = best.unwrap();
        let base = *baseline.get_or_insert(ms);
        println!(
            "{:<36} {:>10.1} {:>12} {:>12} {:>7.2}x",
            name,
            ms,
            v["stats"]["line_callbacks"].as_u64().unwrap_or(0),
            v["events"].as_u64().unwrap_or(0),
            ms / base
        );
    }
    Ok(())
}
