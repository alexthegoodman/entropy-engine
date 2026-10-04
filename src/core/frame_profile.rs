//! Opt-in per-phase frame timing for the live app. Set `ENTROPY_FRAME_PROFILE=1` and every
//! `ENTROPY_FRAME_PROFILE_EVERY` frames (default 300) a table goes to stderr: for each phase of
//! `render_display_frame`, its average, p50, p95 and max wall time over that window, plus the
//! frame-to-frame interval. With `ENTROPY_FRAME_PROFILE_OUT=<path>` the same windows are also
//! appended there as one JSON object per line, for comparing runs.
//!
//! Unset, `begin_frame`/`record` cost one thread-local bool read. Phases are named by the call
//! sites (`ui.js`, `ui.layout`, `gpu.upload`, ...), and a phase recorded several times in one
//! frame accumulates. Counters (`count`, named with a leading `#`) share the table in their own units. Everything runs on the main thread, where the V8 isolate and winit live.

use std::cell::RefCell;
use std::time::{Duration, Instant};

struct Profiler {
    every: usize,
    out: Option<std::path::PathBuf>,
    frame_start: Option<Instant>,
    /// Phase name -> this frame's accumulated time.
    current: Vec<(&'static str, Duration)>,
    /// Counter name -> this frame's accumulated value.
    counts: Vec<(&'static str, f64)>,
    /// Phase name -> one sample (ms) per frame in this window.
    window: Vec<(&'static str, Vec<f64>)>,
    intervals: Vec<f64>,
    frames: usize,
}

thread_local! {
    static PROFILER: RefCell<Option<Profiler>> = RefCell::new(init());
}

fn init() -> Option<Profiler> {
    let on = std::env::var("ENTROPY_FRAME_PROFILE").map_or(false, |v| !v.is_empty() && v != "0");
    if !on {
        return None;
    }
    let every = std::env::var("ENTROPY_FRAME_PROFILE_EVERY").ok().and_then(|v| v.parse().ok()).unwrap_or(300usize).max(1);
    let out = std::env::var_os("ENTROPY_FRAME_PROFILE_OUT").map(Into::into);
    Some(Profiler { every, out, frame_start: None, current: Vec::new(), counts: Vec::new(), window: Vec::new(), intervals: Vec::new(), frames: 0 })
}

pub fn enabled() -> bool {
    PROFILER.with(|p| p.borrow().is_some())
}

/// Adds `elapsed` to `phase` for the frame in progress.
pub fn record(phase: &'static str, elapsed: Duration) {
    PROFILER.with(|p| {
        if let Some(p) = p.borrow_mut().as_mut() {
            match p.current.iter_mut().find(|(name, _)| *name == phase) {
                Some((_, total)) => *total += elapsed,
                None => p.current.push((phase, elapsed)),
            }
        }
    });
}

/// Adds `value` to the counter `name` for the frame in progress (draw calls, uploaded bytes...).
/// Counters are reported beside the phases with the same statistics, in their own units.
pub fn count(name: &'static str, value: f64) {
    PROFILER.with(|p| {
        if let Some(p) = p.borrow_mut().as_mut() {
            match p.counts.iter_mut().find(|(n, _)| *n == name) {
                Some((_, total)) => *total += value,
                None => p.counts.push((name, value)),
            }
        }
    });
}

/// Times `f` as `phase` when profiling is on; just calls it otherwise.
pub fn time<R>(phase: &'static str, f: impl FnOnce() -> R) -> R {
    if !enabled() {
        return f();
    }
    let t0 = Instant::now();
    let r = f();
    record(phase, t0.elapsed());
    r
}

/// Closes the previous frame (if any) and starts a new one. Call once at the top of a frame.
pub fn begin_frame() {
    PROFILER.with(|p| {
        let mut guard = p.borrow_mut();
        let Some(p) = guard.as_mut() else { return };
        let now = Instant::now();
        if let Some(start) = p.frame_start {
            p.intervals.push((now - start).as_secs_f64() * 1000.0);
            for (phase, elapsed) in p.current.drain(..) {
                let ms = elapsed.as_secs_f64() * 1000.0;
                match p.window.iter_mut().find(|(name, _)| *name == phase) {
                    Some((_, samples)) => samples.push(ms),
                    None => p.window.push((phase, vec![ms])),
                }
            }
            for (name, value) in p.counts.drain(..) {
                match p.window.iter_mut().find(|(n, _)| *n == name) {
                    Some((_, samples)) => samples.push(value),
                    None => p.window.push((name, vec![value])),
                }
            }
            p.frames += 1;
            if p.frames % p.every == 0 {
                report(p);
            }
        }
        p.current.clear();
        p.counts.clear();
        p.frame_start = Some(now);
    });
}

fn summarize(samples: &mut [f64], frames: usize) -> (f64, f64, f64, f64) {
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |q: f64| samples[(((samples.len() - 1) as f64) * q).round() as usize];
    // Averaged over every frame in the window, so a phase that only runs on some frames reads as
    // its real per-frame share.
    (samples.iter().sum::<f64>() / frames.max(1) as f64, pct(0.5), pct(0.95), *samples.last().unwrap())
}

fn report(p: &mut Profiler) {
    let frames = p.intervals.len();
    let mut rows = Vec::new();
    let (avg, p50, p95, max) = summarize(&mut p.intervals, frames);
    rows.push(("frame interval", avg, p50, p95, max));
    for (name, samples) in p.window.iter_mut() {
        let (avg, p50, p95, max) = summarize(samples, frames);
        rows.push((name, avg, p50, p95, max));
    }
    eprintln!("[frame-profile] last {frames} frames (ms)          avg      p50      p95      max");
    for (name, avg, p50, p95, max) in &rows {
        eprintln!("[frame-profile]   {name:<28} {avg:>8.3} {p50:>8.3} {p95:>8.3} {max:>8.3}");
    }
    if let Some(path) = &p.out {
        let phases: serde_json::Map<String, serde_json::Value> = rows
            .iter()
            .map(|(name, avg, p50, p95, max)| (name.to_string(), serde_json::json!({ "avg": avg, "p50": p50, "p95": p95, "max": max })))
            .collect();
        let line = serde_json::json!({ "frames": frames, "phases": phases }).to_string();
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{line}");
        }
    }
    p.intervals.clear();
    p.window.clear();
}
