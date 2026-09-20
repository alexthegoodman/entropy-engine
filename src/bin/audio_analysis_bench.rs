// Headless benchmark for the audio analysis stack (src/audio/analysis.rs, src/entropy_gui/widgets_analysis.rs).
//
// It answers four questions with measurements rather than estimates:
//
//   1. What does a tap cost the audio thread, per frame? (`AudioTap::push`, the only thing the
//      audio thread does for analysis.)
//   2. What does the UI thread pay per frame to read it? (a snapshot copy, then windowing plus the
//      two real FFTs a stereo spectrum needs, at each size the widgets offer.)
//   3. What does drawing cost? Each widget is run through a headless `entropy_gui::Context` at the
//      size the DAW uses, and the time to build its draw list (tessellation included, GPU excluded)
//      is measured with the number of vertices it produced.
//   4. What does the whole analysis path add to a real track bus? Not measured here: the bus types
//      are private to `audio`; question 1 is that path's only addition.
//
// No audio device is opened and nothing is audible. Timings are the median of many repeats after a
// warm-up, with the minimum shown to expose noise. Run: cargo run --release --bin audio_analysis_bench

use entropy_engine::audio::analysis::{AudioTap, SpectrumAnalyzer, ENGINE_SAMPLE_RATE, FFT_SIZES};
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::geometry::{pos2, vec2, Rect};
use entropy_engine::entropy_gui::{
    CentralPanel, Context, LevelMeter, MeterOptions, MeterReading, Oscilloscope, RawInput, ScopeMode, ScopeOptions, SpectrumOptions,
    SpectrumStyle, SpectrumView,
};
use std::hint::black_box;
use std::time::Instant;

fn stats(mut ns: Vec<f64>) -> (f64, f64) {
    ns.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (ns[ns.len() / 2], ns[0])
}

fn time_repeated(reps: usize, mut f: impl FnMut()) -> (f64, f64) {
    for _ in 0..(reps / 10).max(3) {
        f();
    }
    let samples = (0..reps)
        .map(|_| {
            let t = Instant::now();
            f();
            t.elapsed().as_nanos() as f64
        })
        .collect();
    stats(samples)
}

fn sine(hz: f32, frames: usize, amp: f32) -> Vec<f32> {
    (0..frames).map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / ENGINE_SAMPLE_RATE as f32).sin()).collect()
}

/// Runs `draw` for `frames` frames through a headless context and returns (median us, min us, vertices in the last frame).
fn widget_frames(frames: usize, mut draw: impl FnMut(&mut entropy_engine::entropy_gui::Ui)) -> (f64, f64, usize) {
    let ctx = Context::default();
    let mut times = Vec::with_capacity(frames);
    let mut vertices = 0;
    for _ in 0..frames {
        let raw = RawInput {
            screen_rect: Rect::from_min_size(pos2(0.0, 0.0), vec2(1000.0, 400.0)),
            pixels_per_point: 1.0,
            pointer: PointerState::default(),
            dt: 1.0 / 60.0,
            ..Default::default()
        };
        let t = Instant::now();
        ctx.run(raw, |c| {
            CentralPanel::default().show(c, |ui| draw(ui));
        });
        let cmds = ctx.tessellate((), 1.0);
        times.push(t.elapsed().as_nanos() as f64);
        vertices = cmds.iter().map(|c| c.vertices.len()).sum();
    }
    times.drain(..frames / 5);
    let (median, min) = stats(times);
    (median / 1000.0, min / 1000.0, vertices)
}

fn main() {
    println!("audio analysis benchmark, {} frames/s engine rate", ENGINE_SAMPLE_RATE);
    // Debug builds are several times slower and would make every figure below meaningless, so the
    // build profile is part of the output.
    println!("build: debug_assertions {}, {}", if cfg!(debug_assertions) { "ON (this is a debug build, do not trust the timings)" } else { "off" }, if cfg!(debug_assertions) { "unoptimised" } else { "optimised" });

    // ---- 1. Audio thread: one push per frame ----
    let tap = AudioTap::new();
    let n = 50_000_000usize;
    let mut best = f64::MAX;
    let mut runs = Vec::new();
    for _ in 0..5 {
        let t = Instant::now();
        for i in 0..n {
            tap.push(black_box(i as f32 * 1.0e-6), black_box(-(i as f32) * 1.0e-6));
        }
        let ns = t.elapsed().as_nanos() as f64 / n as f64;
        runs.push(ns);
        best = best.min(ns);
    }
    let (median, min) = stats(runs);
    println!("\n1. AudioTap::push (audio thread), 5 runs of {n} frames");
    println!("   median {median:.2} ns/frame, min {min:.2} ns/frame");
    let per_second = median * ENGINE_SAMPLE_RATE as f64;
    println!("   at {} frames/s that is {:.3} ms of CPU per second of audio ({:.4}% of one core), per tap", ENGINE_SAMPLE_RATE, per_second / 1.0e6, per_second / 1.0e9 * 100.0);

    // ---- 2. UI thread: copy and FFT ----
    println!("\n2. UI thread reads (median / min over 2000 repeats)");
    for _ in 0..20_000 {
        tap.push(0.1, 0.1);
    }
    let (m, lo) = time_repeated(2000, || {
        black_box(tap.snapshot(black_box(8192)));
    });
    println!("   snapshot of 8192 frames         {:8.1} us / {:8.1} us", m / 1000.0, lo / 1000.0);
    let (m, lo) = time_repeated(2000, || {
        black_box(tap.levels_since(black_box(Some(tap.frames_written().saturating_sub(735))), 735));
    });
    println!("   levels since last read (735)    {:8.1} us / {:8.1} us", m / 1000.0, lo / 1000.0);

    let mut analyzer = SpectrumAnalyzer::new();
    for size in FFT_SIZES {
        let l = sine(1000.0, size, 0.5);
        let r = sine(1500.0, size, 0.4);
        let (m, lo) = time_repeated(2000, || {
            black_box(analyzer.analyze(black_box(&l), black_box(&r), size, ENGINE_SAMPLE_RATE as f32));
        });
        println!("   stereo spectrum, FFT {size:5}        {:8.1} us / {:8.1} us", m / 1000.0, lo / 1000.0);
    }
    let per_frame_budget_us = 1.0e6 / 60.0;
    println!("   (a 60 Hz frame is {per_frame_budget_us:.0} us)");

    // ---- 3. Drawing: widget draw-list construction, headless ----
    println!("\n3. Widget frames through a headless entropy_gui::Context (draw-list build, no GPU), 300 frames each");
    let l = sine(440.0, 2048, 0.6);
    let r = sine(660.0, 2048, 0.6);
    let bins = analyzer.analyze(&sine(1000.0, 4096, 0.5), &sine(1500.0, 4096, 0.4), 4096, ENGINE_SAMPLE_RATE as f32).bins_db;
    let sr = ENGINE_SAMPLE_RATE as f32;

    let cases: Vec<(&str, Box<dyn FnMut(&mut entropy_engine::entropy_gui::Ui)>)> = vec![
        ("oscilloscope, mono, 220 px", {
            let (l, r) = (l.clone(), l.clone());
            Box::new(move |ui| { Oscilloscope::new("a").options(ScopeOptions { width: Some(220.0), height: 200.0, ..Default::default() }).show(ui, &l, &r); })
        }),
        ("oscilloscope, stereo, 720 px, afterglow", {
            let (l, r) = (l.clone(), r.clone());
            Box::new(move |ui| { Oscilloscope::new("b").options(ScopeOptions { mode: ScopeMode::Stereo, width: Some(720.0), height: 200.0, ..Default::default() }).show(ui, &l, &r); })
        }),
        ("oscilloscope, stereo, 720 px, no afterglow", {
            let (l, r) = (l.clone(), r.clone());
            Box::new(move |ui| { Oscilloscope::new("c").options(ScopeOptions { mode: ScopeMode::Stereo, persistence: 0.0, width: Some(720.0), height: 200.0, ..Default::default() }).show(ui, &l, &r); })
        }),
        ("goniometer, 210 px", {
            let (l, r) = (l.clone(), r.clone());
            Box::new(move |ui| { Oscilloscope::new("d").options(ScopeOptions { mode: ScopeMode::Xy, width: Some(210.0), height: 200.0, gain: 2.0, ..Default::default() }).show(ui, &l, &r); })
        }),
        ("spectrum, filled, 380 px", {
            let bins = bins.clone();
            Box::new(move |ui| { SpectrumView::new("e").options(SpectrumOptions { width: Some(380.0), height: 200.0, ..Default::default() }).show(ui, &bins, sr); })
        }),
        ("spectrum, filled, 960 px", {
            let bins = bins.clone();
            Box::new(move |ui| { SpectrumView::new("f").options(SpectrumOptions { width: Some(960.0), height: 200.0, ..Default::default() }).show(ui, &bins, sr); })
        }),
        ("spectrum, bars, 380 px", {
            let bins = bins.clone();
            Box::new(move |ui| { SpectrumView::new("g").options(SpectrumOptions { style: SpectrumStyle::Bars, width: Some(380.0), height: 200.0, ..Default::default() }).show(ui, &bins, sr); })
        }),
        ("level meter, 44 px", Box::new(|ui| { LevelMeter::new("h").options(MeterOptions { width: 44.0, height: 200.0, show_scale: true, ..Default::default() }).show(ui, MeterReading { peak: [0.4, 0.3], rms: [0.2, 0.15] }); })),
    ];
    for (name, mut draw) in cases {
        let (median, min, vertices) = widget_frames(300, |ui| draw(ui));
        println!("   {name:44} {median:8.1} us / {min:8.1} us   {vertices:6} vertices");
    }

    // The whole DAW analyzer window as the DAW lays it out, for the headline figure.
    let (median, min, vertices) = {
        let (l, r, bins) = (l.clone(), r.clone(), bins.clone());
        widget_frames(300, move |ui| {
            Oscilloscope::new("w1").options(ScopeOptions { mode: ScopeMode::Stereo, width: Some(220.0), height: 200.0, ..Default::default() }).show(ui, &l, &r);
            SpectrumView::new("w2").options(SpectrumOptions { width: Some(380.0), height: 200.0, ..Default::default() }).show(ui, &bins, sr);
            LevelMeter::new("w3").options(MeterOptions { width: 44.0, height: 200.0, show_scale: true, ..Default::default() }).show(ui, MeterReading { peak: [0.4, 0.3], rms: [0.2, 0.15] });
        })
    };
    println!("   {:44} {median:8.1} us / {min:8.1} us   {vertices:6} vertices", "the DAW analyzer window (3 widgets)");
}
