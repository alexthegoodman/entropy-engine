//! `Entropy.Wavetable` ops: JSON-in/JSON-out wrappers over `crate::audio::wavetable`, and the note
//! ops on `Entropy.Audio` that play a table. Like the VST3 and guitar ops, every failure is
//! `{ ok: false, error }` rather than a throw.
//!
//! A table is named by an id the addon chooses (the DAW uses the track's id). The editor widget
//! (`Widget.wavetable`), these ops and the voices all reach the same table through that id, so a
//! stroke in the widget, an AI tool's stamp and a playing note are all looking at one thing.

use crate::audio::analysis::{to_db, Levels, SpectrumAnalyzer, ENGINE_SAMPLE_RATE};
use crate::audio::wavetable::{self, BrushTool, Stamp, WavetableParams};
use crate::deno::addon_ops::AddonContext;
use deno_core::{op2, OpState};
use serde::Deserialize;
use serde_json::json;

type Json = serde_json::Value;

fn err(message: impl Into<String>) -> Json {
    json!({ "ok": false, "error": message.into() })
}

fn described(id: &str, table: &wavetable::Wavetable) -> Json {
    json!({
        "ok": true,
        "id": id,
        "frames": table.frames(),
        "tableSize": wavetable::TABLE_SIZE,
        "revision": table.revision(),
        "version": table.shared().version(),
        "canUndo": table.can_undo(),
        "canRedo": table.can_redo(),
    })
}

/// Creates the table `id` if there is none (a stack of sines), optionally starting it from a preset,
/// and describes it. Asking for a preset on a table that exists replaces its contents (one undo step).
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnsureConfig {
    pub preset: Option<String>,
    /// Only used when the table is created here.
    pub frames: Option<u32>,
}

#[op2]
#[serde]
pub fn op_wavetable_ensure(#[string] id: String, #[serde] options: EnsureConfig) -> Json {
    let handle = match wavetable::get_table(&id) {
        Some(h) => h,
        None => {
            let handle = std::sync::Arc::new(std::sync::Mutex::new(wavetable::Wavetable::new(options.frames.map(|f| f as usize).unwrap_or(wavetable::DEFAULT_FRAMES))));
            wavetable::insert_table(&id, handle.clone());
            handle
        }
    };
    let mut table = wavetable::lock_table(&handle);
    if let Some(name) = options.preset {
        if !table.load_preset(&name) {
            return err(format!("no preset called {name}; presets are {}", wavetable::PRESET_NAMES.join(", ")));
        }
    }
    described(&id, &table)
}

#[op2(fast)]
pub fn op_wavetable_remove(#[string] id: String) -> bool {
    wavetable::remove_table(&id)
}

#[op2]
#[serde]
pub fn op_wavetable_info(#[string] id: String) -> Json {
    let Some(handle) = wavetable::get_table(&id) else { return err(format!("no wavetable called {id}")) };
    let table = wavetable::lock_table(&handle);
    let mut out = described(&id, &table);
    out["activity"] = match table.shared().activity() {
        Some((position, energy)) => json!({ "position": position, "energy": energy }),
        None => Json::Null,
    };
    out["activeVoices"] = json!(table.shared().active_voices());
    out
}

/// A whole-table operation: normalize, smooth, invert, reverse, flip_frames, randomize, undo, redo.
#[op2]
#[serde]
pub fn op_wavetable_op(#[string] id: String, #[string] name: String, arg: f64) -> Json {
    // 0 means "the default" for the operations that take an argument.
    let arg = if arg > 0.0 { Some(arg) } else { None };
    let Some(handle) = wavetable::get_table(&id) else { return err(format!("no wavetable called {id}")) };
    let mut table = wavetable::lock_table(&handle);
    match name.as_str() {
        "normalize" => table.normalize(arg.unwrap_or(0.9) as f32),
        "smooth" => table.smooth_all(arg.unwrap_or(1.0).max(1.0) as usize),
        "invert" => table.invert(),
        "reverse" => table.reverse(),
        "flip_frames" => table.flip_frames(),
        "randomize" => table.randomize(arg.unwrap_or(1.0) as u32),
        "undo" => {
            if !table.undo() {
                return err("nothing to undo");
            }
        }
        "redo" => {
            if !table.redo() {
                return err("nothing to redo");
            }
        }
        other => return err(format!("no operation called {other}")),
    }
    described(&id, &table)
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct StampConfig {
    /// "raise", "lower", "smooth" or "level".
    pub tool: String,
    /// Fractional frame, 0 to frames - 1.
    pub frame: f32,
    /// Phase in cycles, 0..1 (wraps).
    pub phase: f32,
    pub radius: Option<f32>,
    pub aspect: Option<f32>,
    pub angle: Option<f32>,
    /// How much this dab changes the surface. 0.3 is a firm dab; 1 or more flattens or saturates.
    pub amount: Option<f32>,
    pub target: Option<f32>,
}

/// Applies brush dabs, all as one undo step, and publishes the result to the audio thread. The same
/// brush the editor uses, so an AI tool sculpts exactly what a pen would.
#[op2]
#[serde]
pub fn op_wavetable_stamp(#[string] id: String, #[serde] stamps: Vec<StampConfig>) -> Json {
    let Some(handle) = wavetable::get_table(&id) else { return err(format!("no wavetable called {id}")) };
    let mut table = wavetable::lock_table(&handle);
    let mut range: Option<(usize, usize)> = None;
    table.begin_edit();
    for s in &stamps {
        let Some(tool) = BrushTool::from_name(&s.tool) else {
            table.end_edit();
            return err(format!("no brush called {}; brushes are raise, lower, smooth, level", s.tool));
        };
        let mut stamp = Stamp::new(tool, s.frame, s.phase);
        stamp.radius = s.radius.unwrap_or(0.16).clamp(0.02, 1.0);
        stamp.aspect = s.aspect.unwrap_or(1.0).clamp(1.0, 6.0);
        stamp.angle = s.angle.unwrap_or(0.0);
        stamp.amount = s.amount.unwrap_or(0.3).clamp(0.0, 4.0);
        stamp.target = s.target.unwrap_or(0.0).clamp(-1.0, 1.0);
        if let Some((a, b)) = table.stamp(&stamp) {
            range = Some(range.map_or((a, b), |(x, y)| (x.min(a), y.max(b))));
        }
    }
    table.end_edit();
    if let Some((a, b)) = range {
        table.commit(a, b);
    }
    let mut out = described(&id, &table);
    out["touchedFrames"] = match range {
        Some((a, b)) => json!([a, b]),
        None => Json::Null,
    };
    out
}

/// Sets one frame from samples (any length; resampled to a cycle).
#[op2]
#[serde]
pub fn op_wavetable_set_frame(#[string] id: String, #[smi] frame: u32, #[serde] samples: Vec<f32>) -> Json {
    let Some(handle) = wavetable::get_table(&id) else { return err(format!("no wavetable called {id}")) };
    if samples.len() < 2 {
        return err("a frame needs at least two samples");
    }
    let mut table = wavetable::lock_table(&handle);
    table.begin_edit();
    table.set_frame(frame as usize, &samples);
    table.end_edit();
    described(&id, &table)
}

#[op2]
#[serde]
pub fn op_wavetable_export(#[string] id: String) -> Json {
    match wavetable::get_table(&id) {
        Some(h) => json!({ "ok": true, "data": wavetable::lock_table(&h).export() }),
        None => err(format!("no wavetable called {id}")),
    }
}

#[op2]
#[serde]
pub fn op_wavetable_import(#[string] id: String, #[string] data: String) -> Json {
    let handle = wavetable::ensure_table(&id);
    let mut table = wavetable::lock_table(&handle);
    match table.import(&data) {
        Ok(()) => described(&id, &table),
        Err(e) => err(e),
    }
}

/// The first `count` harmonic amplitudes of a frame (a unit sine reads 1), and the frame's peak and RMS.
#[op2]
#[serde]
pub fn op_wavetable_harmonics(#[string] id: String, #[smi] frame: u32, #[smi] count: u32) -> Json {
    let Some(handle) = wavetable::get_table(&id) else { return err(format!("no wavetable called {id}")) };
    let table = wavetable::lock_table(&handle);
    let f = table.frame(frame as usize);
    let peak = f.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    let rms = (f.iter().map(|v| v * v).sum::<f32>() / f.len() as f32).sqrt();
    json!({
        "ok": true,
        "frame": (frame as usize).min(table.frames() - 1),
        "harmonics": crate::entropy_gui::widgets_wavetable::harmonic_amplitudes(f, count.clamp(1, 128) as usize),
        "peak": peak,
        "rms": rms,
    })
}

/// A wavetable note as an addon describes it. Anything left out keeps `WavetableParams::default`.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WavetableNoteConfig {
    pub track_id: Option<String>,
    pub table: String,
    pub freq: Option<f32>,
    pub velocity: Option<f32>,
    pub gain: Option<f32>,
    pub position: Option<f32>,
    pub lfo_rate: Option<f32>,
    pub lfo_depth: Option<f32>,
    pub sweep: Option<f32>,
    pub sweep_time: Option<f32>,
    pub vel_to_position: Option<f32>,
    pub unison: Option<u32>,
    pub detune_cents: Option<f32>,
    pub spread: Option<f32>,
    pub cutoff: Option<f32>,
    pub resonance: Option<f32>,
    pub attack: Option<f32>,
    pub decay: Option<f32>,
    pub sustain: Option<f32>,
    pub release: Option<f32>,
    pub duration: Option<f32>,
    /// Offline events only: seconds from the start of the render.
    pub start_time: Option<f64>,
}

impl WavetableNoteConfig {
    pub fn to_params(&self) -> WavetableParams {
        let d = WavetableParams::default();
        WavetableParams {
            freq: self.freq.unwrap_or(d.freq).clamp(1.0, 20_000.0),
            velocity: self.velocity.unwrap_or(d.velocity).clamp(0.0, 1.0),
            gain: self.gain.unwrap_or(d.gain).clamp(0.0, 4.0),
            position: self.position.unwrap_or(d.position).clamp(0.0, 1.0),
            lfo_rate: self.lfo_rate.unwrap_or(d.lfo_rate).clamp(0.0, 40.0),
            lfo_depth: self.lfo_depth.unwrap_or(d.lfo_depth).clamp(0.0, 1.0),
            sweep: self.sweep.unwrap_or(d.sweep).clamp(-1.0, 1.0),
            sweep_time: self.sweep_time.unwrap_or(d.sweep_time).clamp(0.005, 10.0),
            vel_to_position: self.vel_to_position.unwrap_or(d.vel_to_position).clamp(-2.0, 2.0),
            unison: self.unison.unwrap_or(d.unison as u32).clamp(1, wavetable::MAX_UNISON as u32) as u8,
            detune_cents: self.detune_cents.unwrap_or(d.detune_cents).clamp(0.0, 100.0),
            spread: self.spread.unwrap_or(d.spread).clamp(0.0, 1.0),
            cutoff: self.cutoff.unwrap_or(d.cutoff).clamp(20.0, 20_000.0),
            resonance: self.resonance.unwrap_or(d.resonance).clamp(0.5, 12.0),
            attack: self.attack.unwrap_or(d.attack).clamp(0.0, 10.0),
            decay: self.decay.unwrap_or(d.decay).clamp(0.0, 10.0),
            sustain: self.sustain.unwrap_or(d.sustain).clamp(0.0, 1.0),
            release: self.release.unwrap_or(d.release).clamp(0.0, 10.0),
            duration: self.duration.unwrap_or(d.duration).clamp(0.0, 60.0),
        }
    }

    /// The `WavetableEvent` an offline render plays.
    pub fn to_event(&self) -> crate::audio::WavetableEvent {
        crate::audio::WavetableEvent { start_time: self.start_time.unwrap_or(0.0), table: self.table.clone(), params: self.to_params() }
    }
}

/// Plays one timed note of a wavetable on a track's bus.
#[op2]
#[serde]
pub fn op_audio_play_wavetable_on_track(state: &mut OpState, #[serde] config: WavetableNoteConfig) -> Json {
    let Some(ctx) = state.try_borrow::<AddonContext>() else { return err("Context not available") };
    let Some(track) = config.track_id.clone() else { return err("a wavetable note needs a trackId") };
    match ctx.audio_engine.play_wavetable_on_track(&track, &config.table, config.to_params()) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => err(e),
    }
}

/// Starts a note that sounds until `op_audio_wavetable_note_off` (a key held, or a note latched).
#[op2]
#[serde]
pub fn op_audio_wavetable_note_on(state: &mut OpState, #[serde] config: WavetableNoteConfig) -> Json {
    let Some(ctx) = state.try_borrow::<AddonContext>() else { return err("Context not available") };
    let Some(track) = config.track_id.clone() else { return err("a wavetable note needs a trackId") };
    match ctx.audio_engine.wavetable_note_on(&track, &config.table, config.to_params()) {
        Ok(voice) => json!({ "ok": true, "voice": voice as f64 }),
        Err(e) => err(e),
    }
}

#[op2(fast)]
pub fn op_audio_wavetable_note_off(state: &mut OpState, voice: f64) {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.audio_engine.wavetable_note_off(voice as u64);
    }
}

#[op2(fast)]
pub fn op_audio_wavetable_set_position(state: &mut OpState, voice: f64, position: f64) {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.audio_engine.wavetable_set_position(voice as u64, position as f32);
    }
}

/// Renders one note offline (no audio device, no bus) and reads it back: how loud it is and where its
/// energy is. The way to hear a table as numbers, for an AI tool or a test.
#[op2]
#[serde]
pub fn op_wavetable_render_analyze(#[serde] config: WavetableNoteConfig, seconds: f64) -> Json {
    let Some(shared) = wavetable::shared_for(&config.table) else { return err(format!("no wavetable called {}", config.table)) };
    let params = config.to_params();
    let limit = if seconds > 0.0 { seconds as f32 } else { params.duration + params.release + 0.25 }.clamp(0.05, 12.0);
    let samples = wavetable::render_note(shared, params, limit);
    let (left, right): (Vec<f32>, Vec<f32>) = samples.chunks_exact(2).map(|c| (c[0], c[1])).unzip();
    if left.len() < 1024 {
        return err("the note is too short to analyze");
    }
    // Analyze the loudest 4096 frames, so an attack that is mostly silence does not hide the note.
    let n = if left.len() >= 4096 { 4096 } else { 1usize << (usize::BITS - 1 - left.len().leading_zeros()) };
    let mut best = (0usize, 0.0f32);
    let mut i = 0;
    while i + n <= left.len() {
        let e: f32 = left[i..i + n].iter().map(|v| v * v).sum();
        if e > best.1 {
            best = (i, e);
        }
        i += n / 2;
    }
    let (l, r) = (&left[best.0..best.0 + n], &right[best.0..best.0 + n]);
    let levels = Levels::of(l, r);
    let spec = SpectrumAnalyzer::new().analyze(l, r, n, ENGINE_SAMPLE_RATE as f32);
    json!({
        "ok": true,
        "seconds": left.len() as f64 / ENGINE_SAMPLE_RATE as f64,
        "peakDb": to_db(levels.peak[0].max(levels.peak[1])),
        "rmsDb": to_db(levels.rms[0].max(levels.rms[1])),
        "peakHz": spec.peak_hz,
        "centroidHz": spec.centroid_hz,
    })
}
