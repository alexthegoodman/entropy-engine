//! Scores and times the DAW's next-step brain (src/prediction/brain.rs, a written WIR program)
//! on simulated sessions: at the start of every session and after every step, the brain ranks
//! the actions and the next step's action is looked up in the ranking. Also reports how often
//! the parameters the brain predicts match the step's when the action is right, and how long a
//! plan takes.
//!
//!   cargo run --release --bin bench_prediction -- [--sessions 1000] [--seed 42] [--split eval] [--reps 200]

use clap::Parser;
use entropy_engine::prediction::{
    brain::brain,
    daw_actions::{DawAction, NUM_DAW_ACTIONS},
    daw_sim::{generate_sessions, Split},
};
use std::time::Instant;

#[derive(Parser)]
struct Cli {
    /// Sessions to score.
    #[arg(long, default_value_t = 1000)]
    sessions: usize,
    #[arg(long, default_value_t = 42)]
    seed: u64,
    /// eval (held-out genre/instrument pairs), train or all.
    #[arg(long, default_value = "eval")]
    split: String,
    /// Timed plans per history length.
    #[arg(long, default_value_t = 200)]
    reps: usize,
}

fn summary(mut us: Vec<f64>) -> String {
    us.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let at = |q: f64| us[((us.len() - 1) as f64 * q).round() as usize];
    format!("median {:7.1} us  p95 {:7.1} us  max {:7.1} us", at(0.5), at(0.95), us[us.len() - 1])
}

fn main() -> Result<(), String> {
    let cli = Cli::parse();
    let profile = if cfg!(debug_assertions) { "debug" } else { "release" };
    let split = match cli.split.as_str() {
        "eval" => Split::Eval,
        "train" => Split::Train,
        "all" => Split::All,
        other => return Err(format!("unknown split {other}")),
    };
    let t = Instant::now();
    let b = brain()?;
    let load_ms = t.elapsed().as_secs_f64() * 1000.0;
    let (worst, vectors) = b.check_vectors();
    println!(
        "profile: {profile}; brain: hidden {:?}, {} non-zero weights, parsed in {load_ms:.1} ms; {vectors} test vectors, worst |diff| {worst:e}",
        b.hidden, b.weights
    );

    let sessions = generate_sessions(cli.sessions, cli.seed, split);
    let (mut n, mut top1, mut top3, mut log_lik) = (0usize, 0usize, 0usize, 0f64);
    let mut per = vec![(0usize, 0usize); NUM_DAW_ACTIONS];
    // Parameter hits when the top action is right: (checked, exact) per kind.
    let (mut rows, mut steps, mut clips, mut mix) = ((0, 0), (0, 0), (0, 0), (0, 0));
    let mut times = Vec::new();
    for s in &sessions {
        for k in 0..s.steps.len() {
            let history = &s.steps[..k];
            let now = history.last().map_or(s.start, |h| h.context);
            let started = Instant::now();
            let ranking = b.rank(history, now);
            times.push(started.elapsed().as_secs_f64() * 1e6);
            let target = s.steps[k].action().unwrap();
            let pos = ranking.ranked.iter().position(|(a, _)| *a == target).unwrap();
            n += 1;
            top1 += (pos == 0) as usize;
            top3 += (pos < 3) as usize;
            log_lik += (ranking.ranked[pos].1.max(1e-12) as f64).ln();
            per[target.id() as usize].0 += 1;
            per[target.id() as usize].1 += (pos == 0) as usize;
            if pos == 0 {
                let p = b.params(&ranking, target, history);
                let want = &s.steps[k].params;
                let same = |idx: &[usize]| idx.iter().all(|&i| p[i] == want[i]);
                let tally = |t: &mut (usize, usize), ok: bool| { t.0 += 1; t.1 += ok as usize; };
                match target {
                    DawAction::AddNote => {
                        tally(&mut rows, same(&[0]));
                        tally(&mut steps, same(&[1]));
                    }
                    DawAction::CreateClip => tally(&mut clips, same(&[0, 1, 2])),
                    DawAction::SetVolume | DawAction::SoloTrack => tally(&mut mix, same(&[0])),
                    _ => {}
                }
            }
        }
    }
    let pct = |a: usize, b: usize| a as f64 / b.max(1) as f64 * 100.0;
    println!(
        "\n{} {} sessions (seed {}), {n} next steps: top-1 {:.1}%, top-3 {:.1}%, mean ln p {:.3}",
        sessions.len(), cli.split, cli.seed, pct(top1, n), pct(top3, n), log_lik / n.max(1) as f64
    );
    println!(
        "parameters when the action is right: note row {:.1}% and step {:.1}% of {}, clip lane+bar+length {:.1}% of {}, mixer track {:.1}% of {}",
        pct(rows.1, rows.0), pct(steps.1, steps.0), rows.0, pct(clips.1, clips.0), clips.0, pct(mix.1, mix.0), mix.0
    );
    let mut rows: Vec<(DawAction, (usize, usize))> = DawAction::ALL.iter().map(|&a| (a, per[a.id() as usize])).filter(|r| r.1 .0 > 0).collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r.1 .0));
    for (a, (count, hit)) in rows.iter().take(15) {
        println!("  {:24} {count:6}  top-1 {:5.1}%", a.name(), pct(*hit, *count));
    }

    println!("\none ranking (features + network + softmax), every query above: {}", summary(times));
    for len in [0usize, 8, 24, 64] {
        let mut us = Vec::with_capacity(cli.reps);
        for r in 0..cli.reps {
            let s = &sessions[r % sessions.len()];
            let h = &s.steps[..len.min(s.steps.len())];
            let started = Instant::now();
            let plan = b.plan(h, None, 3, 0);
            us.push(started.elapsed().as_secs_f64() * 1e6);
            assert_eq!(plan.len(), 3);
        }
        println!("3-step plan, history {len:>2}: {}", summary(us));
    }
    Ok(())
}
