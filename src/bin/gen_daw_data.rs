#![allow(warnings)]

//! Procedural DAW workflow data generator.
//!
//! Runs the session simulator in `brain::daw_sim` (genres, personas, chained
//! goals, a modelled DAW state) and writes the sessions as JSON for
//! train_prediction. With `--eval-count` it also writes a held-out evaluation
//! set next to the training file: sessions built around genre and instrument
//! pairings the training split never contains.
//!
//! Usage:
//!   cargo run --release --bin gen_daw_data -- \
//!       --out data/daw_sequences.json \
//!       --count 20000 \
//!       --eval-count 1000 \
//!       --seed 42

use anyhow::Result;
use clap::Parser;
use std::collections::BTreeMap;
use std::io::Write;
use entropy_engine::prediction::daw_actions::*;
use entropy_engine::prediction::daw_sim::{generate_sessions, Split};

#[derive(Parser)]
#[command(name = "gen_daw_data", about = "Generate synthetic DAW action sessions")]
struct Cli {
    /// Training output file (JSON).
    #[arg(long, default_value = "data/daw_sequences.json")]
    out: String,

    /// Number of training sessions.
    #[arg(long, default_value_t = 20_000)]
    count: usize,

    /// Number of held-out evaluation sessions, written to <out stem>.eval.json (0 to skip).
    #[arg(long, default_value_t = 1_000)]
    eval_count: usize,

    /// RNG seed for reproducibility.
    #[arg(long, default_value_t = 42)]
    seed: u64,
}

fn eval_path(out: &str) -> String {
    let p = std::path::Path::new(out);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("daw_sequences");
    p.with_file_name(format!("{stem}.eval.json")).to_string_lossy().into_owned()
}

fn write(path: &str, sessions: &[Trajectory]) -> Result<()> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::io::BufWriter::new(std::fs::File::create(path)?);
    serde_json::to_writer(&mut file, sessions)?;
    file.flush()?;
    let size = std::fs::metadata(path)?.len();
    println!("Wrote {} sessions to {path} ({:.1} MB)", sessions.len(), size as f64 / 1_048_576.0);
    Ok(())
}

fn report(label: &str, sessions: &[Trajectory]) {
    let total: usize = sessions.iter().map(|t| t.steps.len()).sum();
    println!("\n{label}: {} sessions, {} steps, {:.1} steps per session",
        sessions.len(), total, total as f64 / sessions.len().max(1) as f64);

    let mut genres: BTreeMap<&str, usize> = BTreeMap::new();
    for t in sessions { *genres.entry(t.genre.as_str()).or_default() += 1; }
    println!("  genres: {}", genres.iter().map(|(g, n)| format!("{g} {n}")).collect::<Vec<_>>().join(", "));

    let mut tasks = vec![0usize; NUM_DAW_TASKS];
    for t in sessions { for &id in &t.tasks { tasks[id as usize] += 1; } }
    println!("  goals: {}", DawTask::ALL.iter().map(|t| format!("{:?} {}", t, tasks[t.id() as usize])).collect::<Vec<_>>().join(", "));

    let mut actions = vec![0usize; NUM_DAW_ACTIONS];
    for t in sessions {
        for s in &t.steps { if let Some(a) = s.action() { actions[a.id() as usize] += 1; } }
    }
    let mut ranked: Vec<_> = DawAction::ALL.iter().map(|a| (a.name(), actions[a.id() as usize])).collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1));
    println!("  most common: {}", ranked.iter().take(12).map(|(n, c)| format!("{n} {c}")).collect::<Vec<_>>().join(", "));
    let unused: Vec<_> = ranked.iter().filter(|r| r.1 == 0).map(|r| r.0).collect();
    if !unused.is_empty() { println!("  never generated: {}", unused.join(", ")); }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    println!("Generating DAW sessions (vocabulary v{DAW_VOCAB_VERSION}, {NUM_DAW_ACTIONS} actions, seed {})", cli.seed);

    let train = generate_sessions(cli.count, cli.seed, Split::Train);
    report("Training split", &train);
    write(&cli.out, &train)?;

    if cli.eval_count > 0 {
        let eval = generate_sessions(cli.eval_count, cli.seed, Split::Eval);
        report("Held-out eval split", &eval);
        write(&eval_path(&cli.out), &eval)?;
    }
    Ok(())
}
