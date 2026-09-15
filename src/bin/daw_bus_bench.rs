// Headless benchmark for the DAW's new persistent mixing bus / Entropy.AudioEffect registry
// (src/audio/mod.rs's TrackBus/EffectHandle), specifically isolating the exact cost the
// 2026-09-13 daw-fx-bench post already flagged: `reverb_stereo` allocates a fresh 32-channel FDN
// on every call, and the old per-note architecture called `build_note_node` (which builds one)
// on every single triggered note. This benchmark doesn't touch that old path at all - it
// compares building N independent reverb effect instances (what the old per-note path paid,
// once per note) against building one reverb instance and pushing N live mix updates into it
// (what a track bus now does: reverb is built once per track, and only mix/gain/mute/solo change
// per note-trigger or slider tweak).
//
// Uses `AudioEngine::create_effect`/`set_effect_params` directly - no rodio Sink/OutputStream
// playback is triggered, so nothing is audible; `AudioEngine::new()` still opens a real default
// output device (required to construct one at all), so this needs to run somewhere with working
// audio hardware, same as the app itself.
//
// Run: cargo run --release --bin daw_bus_bench

use entropy_engine::audio::{AudioEngine, EffectParams, ReverbEffectParams};
use std::time::Instant;

fn main() {
    let engine = AudioEngine::new();
    let n: usize = 500;

    let reverb_params = |mix: f64| {
        EffectParams::Reverb(ReverbEffectParams { room_size: 14.0, time: 1.6, damping: 0.5, mix })
    };

    // Old-per-note-equivalent: build N independent reverb effect instances, each paying for its
    // own reverb_stereo(...) construction - exactly what build_note_node did on every trigger.
    let start = Instant::now();
    let mut ids = Vec::with_capacity(n);
    for _ in 0..n {
        ids.push(engine.create_effect(reverb_params(0.35)));
    }
    let rebuild_every_time = start.elapsed();
    for id in &ids {
        engine.destroy_effect(id);
    }

    // New track-bus path: build the reverb once, then push N live mix updates - what actually
    // happens as notes trigger or a slider's mix knob moves, with room/time/damping unchanged.
    let id = engine.create_effect(reverb_params(0.35));
    let start = Instant::now();
    for i in 0..n {
        let mix = (i % 100) as f64 / 100.0;
        engine.set_effect_params(&id, reverb_params(mix));
    }
    let reuse_live_mix = start.elapsed();
    engine.destroy_effect(&id);

    let per_rebuild = rebuild_every_time / n as u32;
    let per_update = reuse_live_mix / n as u32;
    let speedup = rebuild_every_time.as_secs_f64() / reuse_live_mix.as_secs_f64().max(1e-12);

    println!("N = {n}");
    println!("Building {n} independent reverb instances (old per-note-equivalent): {rebuild_every_time:?} total, {per_rebuild:?}/instance");
    println!("1 reverb instance, {n} live mix updates (new per-track-bus path):    {reuse_live_mix:?} total, {per_update:?}/update");
    println!("Speedup: {speedup:.1}x");
}
