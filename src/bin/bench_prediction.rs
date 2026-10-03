#![recursion_limit = "256"]

//! Times the DAW prediction model's plan inference on each backend (NdArray on the CPU, Wgpu on
//! the GPU) against a real checkpoint, over held-out simulated sessions cut at several history
//! lengths, and then times the worker path the DAW uses (`request_plan` + `poll_plan`).
//!
//!   cargo run --release --bin bench_prediction -- [--reps 30] [--steps 5]

use clap::Parser;
use entropy_engine::prediction::{
    daw_sim::{generate_sessions, Split},
    model::{InferenceBackend, LoadedPredictor, BACKEND_ENV},
    poll_plan, request_plan, resolve_prediction_checkpoint_dir, ActionStep, PlanState,
};
use std::time::Instant;

#[derive(Parser)]
struct Cli {
    /// Timed plans per history length and backend (after one untimed warm-up).
    #[arg(long, default_value_t = 30)]
    reps: usize,
    /// Steps per plan (the DAW asks for 5).
    #[arg(long, default_value_t = 5)]
    steps: usize,
}

fn summary(mut ms: Vec<f64>) -> String {
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let at = |q: f64| ms[((ms.len() - 1) as f64 * q).round() as usize];
    format!("median {:7.2} ms  p95 {:7.2} ms  max {:7.2} ms", at(0.5), at(0.95), ms[ms.len() - 1])
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let profile = if cfg!(debug_assertions) { "debug" } else { "release" };
    let dir = resolve_prediction_checkpoint_dir()?;
    println!("profile: {profile}, checkpoint: {}, {} reps, {}-step plans", dir.display(), cli.reps, cli.steps);

    let sessions = generate_sessions(cli.reps, 7, Split::Eval);
    let lengths = [0usize, 8, 24, 48, 64];
    let history = |s: usize, len: usize| -> Vec<ActionStep> {
        let steps = &sessions[s % sessions.len()].steps;
        steps[..len.min(steps.len())].to_vec()
    };

    for backend in [InferenceBackend::Cpu, InferenceBackend::Gpu] {
        let t = Instant::now();
        let predictor = match LoadedPredictor::load(&dir.to_string_lossy(), backend) {
            Ok(p) => p,
            Err(e) => {
                println!("{}: could not load: {e}", backend.name());
                continue;
            }
        };
        println!("\n{}: load {:.1} ms", backend.name(), t.elapsed().as_secs_f64() * 1000.0);
        let t = Instant::now();
        predictor.predict_plan(&history(0, 8), None, cli.steps, 0);
        println!("  first plan (cold) {:.1} ms", t.elapsed().as_secs_f64() * 1000.0);
        for &len in &lengths {
            let mut ms = Vec::with_capacity(cli.reps);
            for r in 0..cli.reps {
                let h = history(r, len);
                let t = Instant::now();
                let plan = predictor.predict_plan(&h, None, cli.steps, 0);
                ms.push(t.elapsed().as_secs_f64() * 1000.0);
                assert_eq!(plan.len(), cli.steps);
            }
            println!("  history {len:>2}: {}", summary(ms));
        }
    }

    // The DAW's path: queue on the worker thread, poll from this one. The poll is what the UI
    // thread pays per frame; the round trip is how long the panel waits for a plan.
    unsafe { std::env::set_var(BACKEND_ENV, "cpu") };
    let warm = request_plan(None, history(0, 8), None, cli.steps, 0);
    while poll_plan(warm).state == PlanState::Pending {
        std::thread::yield_now();
    }
    let (mut polls, mut trips, mut worker) = (Vec::new(), Vec::new(), Vec::new());
    for r in 0..cli.reps {
        let start = Instant::now();
        let ticket = request_plan(None, history(r, 24), None, cli.steps, 0);
        let queued = start.elapsed().as_secs_f64() * 1000.0;
        loop {
            let t = Instant::now();
            let poll = poll_plan(ticket);
            polls.push(t.elapsed().as_secs_f64() * 1000.0);
            if poll.state != PlanState::Pending {
                assert_eq!(poll.state, PlanState::Done, "{:?}", poll.error);
                worker.push(poll.elapsed_ms as f64);
                break;
            }
            std::thread::sleep(std::time::Duration::from_micros(200));
        }
        trips.push(start.elapsed().as_secs_f64() * 1000.0);
        polls.push(queued);
    }
    println!("\nworker (cpu, history 24):");
    println!("  request_plan + poll_plan calls: {}", summary(polls));
    println!("  worker inference:               {}", summary(worker));
    println!("  request to result:              {}", summary(trips));

    // A burst: ten requests back to back, as a knob drag would make without the DAW's settle delay.
    let tickets: Vec<u64> = (0..10).map(|r| request_plan(None, history(r, 24), None, cli.steps, 0)).collect();
    let last = *tickets.last().unwrap();
    while poll_plan(last).state == PlanState::Pending {
        std::thread::sleep(std::time::Duration::from_micros(200));
    }
    let ran = tickets.iter().filter(|&&t| poll_plan(t).state == PlanState::Done).count();
    println!("  burst of 10 requests: {ran} ran, {} superseded", tickets.len() - ran);
    Ok(())
}
