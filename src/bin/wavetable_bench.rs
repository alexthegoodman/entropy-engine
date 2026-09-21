//! What the wavetable synth costs: one voice per output sample, a brush stroke's rebuild, the
//! editor widget's frame, and the size of a table.
//!
//!     cargo run --release --bin wavetable_bench
//!
//! Prints its build profile first: debug numbers are meaningless for DSP. Every timing is the median
//! of several runs on the machine it runs on, and says so.

use entropy_engine::audio::analysis::ENGINE_SAMPLE_RATE;
use entropy_engine::audio::wavetable::{BrushTool, Stamp, Wavetable, WavetableParams, WavetableVoice, MIP_LEVELS, TABLE_SIZE};
use entropy_engine::entropy_gui::geometry::{pos2, vec2, Rect};
use entropy_engine::entropy_gui::{CentralPanel, Context, RawInput, WavetableOptions, WavetableView};
use std::time::Instant;

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn time_ms(runs: usize, mut f: impl FnMut()) -> f64 {
    f();
    median((0..runs).map(|_| {
        let t = Instant::now();
        f();
        t.elapsed().as_secs_f64() * 1000.0
    }).collect())
}

fn main() {
    println!("wavetable_bench, build profile: {}", if cfg!(debug_assertions) { "DEBUG (numbers below are not representative)" } else { "release" });
    println!("machine: {} ({})", std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_else(|_| "unknown CPU".into()), std::env::consts::OS);
    println!();

    // ---- one voice, per output frame ----
    let mut table = Wavetable::new(32);
    table.load_preset("terrain");
    let budget_ns = 1.0e9 / ENGINE_SAMPLE_RATE as f64;
    println!("voice cost (a 44.1 kHz frame is {budget_ns:.0} ns; median of 5 runs of 5 s of audio each)");
    println!("  {:<38} {:>10} {:>12} {:>16}", "voice", "ns/frame", "% of real time", "voices at 50% CPU");
    for (label, unison, filtered, lfo) in [
        ("1 unison, no filter", 1u8, false, false),
        ("1 unison, filter, LFO", 1, true, true),
        ("3 unison, filter, LFO", 3, true, true),
        ("7 unison, filter, LFO", 7, true, true),
    ] {
        let mut p = WavetableParams::default();
        p.freq = 220.0;
        p.position = 0.5;
        p.unison = unison;
        p.cutoff = if filtered { 2400.0 } else { 20_000.0 };
        p.lfo_rate = if lfo { 3.0 } else { 0.0 };
        p.lfo_depth = if lfo { 0.5 } else { 0.0 };
        p.duration = 20.0;
        let frames = ENGINE_SAMPLE_RATE as usize * 5;
        let ms = time_ms(5, || {
            let mut v = WavetableVoice::new(table.shared(), p, None);
            let mut acc = 0.0f32;
            for _ in 0..frames * 2 {
                acc += v.next().unwrap_or(0.0);
            }
            std::hint::black_box(acc);
        });
        let ns = ms * 1.0e6 / frames as f64;
        println!("  {label:<38} {ns:>10.1} {:>11.2}% {:>16.0}", ns / budget_ns * 100.0, 0.5 * budget_ns / ns);
    }

    // ---- editing ----
    println!();
    println!("editing (median of 15 runs)");
    let mut t = Wavetable::new(32);
    t.load_preset("vowels");
    let mut raise = Stamp::new(BrushTool::Raise, 16.0, 0.4);
    raise.radius = 0.16;
    raise.amount = 0.05;
    let mut smooth = raise;
    smooth.tool = BrushTool::Smooth;
    let stamp_ms = time_ms(15, || {
        t.stamp(&raise);
    });
    let smooth_ms = time_ms(15, || {
        t.stamp(&smooth);
    });
    let (lo, hi) = t.stamp(&raise).unwrap();
    let commit_ms = time_ms(15, || t.commit(lo, hi));
    println!("  one raise dab, radius 0.16:              {stamp_ms:.3} ms");
    println!("  one smooth dab, radius 0.16:             {smooth_ms:.3} ms");
    println!("  publishing that dab's {} frames:           {commit_ms:.3} ms  (a stroke frame is about a dab and a publish)", hi - lo + 1);
    println!("  publishing the whole table (32 frames):  {:.3} ms", time_ms(15, || t.commit_all()));
    println!("  loading a preset (synthesise + publish): {:.3} ms", time_ms(15, || {
        t.load_preset("vowels");
    }));
    let saved = t.export();
    println!("  saving to base64:                        {:.3} ms, {} characters", time_ms(15, || {
        std::hint::black_box(t.export());
    }), saved.len());
    let mut other = Wavetable::new(32);
    println!("  loading it back:                         {:.3} ms", time_ms(15, || {
        other.import(&saved).unwrap();
    }));

    // ---- the widget ----
    println!();
    println!("editor widget, one 960 x 700 frame through a headless context (build + tessellate; no rasterizing, no GPU)");
    let ctx = Context::default();
    let mut opts = WavetableOptions::default();
    opts.width = Some(960.0);
    opts.height = 700.0;
    let mut vertices = 0usize;
    let mut triangles = 0usize;
    let ms = time_ms(15, || {
        let raw = RawInput { screen_rect: Rect::from_min_size(pos2(0.0, 0.0), vec2(1000.0, 760.0)), pixels_per_point: 1.0, dt: 1.0 / 60.0, ..Default::default() };
        let o = opts.clone();
        ctx.run(raw, |c| {
            CentralPanel::default().show(c, |ui| {
                WavetableView::new("bench").options(o).show(ui, &mut t);
            });
        });
        let cmds = ctx.tessellate((), 1.0);
        vertices = cmds.iter().map(|c| c.vertices.len()).sum();
        triangles = cmds.iter().map(|c| c.indices.len() / 3).sum();
    });
    println!("  {ms:.3} ms per frame, {vertices} vertices, {triangles} triangles ({:.1}% of a 60 Hz frame)", ms / (1000.0 / 60.0) * 100.0);

    // ---- size ----
    println!();
    let mips = MIP_LEVELS * 32 * TABLE_SIZE * 4;
    println!("memory: a 32-frame table is {} KiB of edit data plus {:.1} MiB of band-limited copies ({MIP_LEVELS} levels)", 32 * TABLE_SIZE * 4 / 1024, mips as f64 / (1024.0 * 1024.0));
}
