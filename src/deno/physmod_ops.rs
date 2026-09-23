//! `Entropy.PhysMod` ops: JSON-in/JSON-out wrappers over `crate::audio::physmod`, and the note ops on
//! `Entropy.Audio` that play a bowed string. Like the wavetable and VST3 ops, every failure is
//! `{ ok: false, error }` rather than a throw.
//!
//! An instrument is named by an id the addon chooses (the DAW uses the track's id). There is no
//! editable object to fetch here the way a wavetable has a sculptable table: a bowed string carries
//! no persistent state beyond what a note is played with, so `Widget.physModString`, these ops and
//! the voices all just publish to and read the same `PhysModShared` by that id.

use crate::audio::analysis::{to_db, Levels, SpectrumAnalyzer, ENGINE_SAMPLE_RATE};
use crate::audio::physmod::{self, PhysModParams};
use crate::deno::addon_ops::AddonContext;
use deno_core::{op2, OpState};
use serde::Deserialize;
use serde_json::json;

type Json = serde_json::Value;

fn err(message: impl Into<String>) -> Json {
    json!({ "ok": false, "error": message.into() })
}

fn described(id: &str, shared: &physmod::PhysModShared) -> Json {
    json!({
        "ok": true,
        "id": id,
        "activeVoices": shared.active_voices(),
        "activity": match shared.activity() {
            Some((bow_position, bow_force, bow_velocity, energy)) => json!({
                "bowPosition": bow_position, "bowForce": bow_force, "bowVelocity": bow_velocity, "energy": energy,
            }),
            None => Json::Null,
        },
    })
}

#[op2]
#[serde]
pub fn op_physmod_info(#[string] id: String) -> Json {
    described(&id, &physmod::shared_for(&id))
}

/// The loop's current cycle, `physmod::SHAPE_POINTS` points, exaggerated by the caller for display.
/// `None` (an empty array) when nothing is sounding.
#[op2]
#[serde]
pub fn op_physmod_shape(#[string] id: String) -> Json {
    let Some(shared) = physmod::get_shared(&id) else { return json!({ "ok": true, "version": 0, "points": [] }) };
    let points: Vec<f32> = (0..physmod::SHAPE_POINTS).map(|i| shared.shape_at(i)).collect();
    json!({ "ok": true, "version": shared.shape_version(), "points": points })
}

#[op2(fast)]
pub fn op_physmod_remove(#[string] id: String) -> bool {
    physmod::remove_shared(&id)
}

/// A bowed-string note as an addon describes it. Anything left out keeps `PhysModParams::default`.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PhysModNoteConfig {
    pub track_id: Option<String>,
    /// Names the `PhysModShared` a widget or another note-on shares this instrument's state
    /// through. Defaults to `track_id` when omitted, matching how a wavetable note defaults its
    /// table id.
    pub instrument: Option<String>,
    pub freq: Option<f32>,
    pub velocity: Option<f32>,
    pub gain: Option<f32>,
    pub bow_force: Option<f32>,
    pub bow_velocity: Option<f32>,
    pub bow_position: Option<f32>,
    pub vibrato_rate: Option<f32>,
    pub vibrato_depth: Option<f32>,
    pub damping: Option<f32>,
    pub brightness: Option<f32>,
    pub body_size: Option<f32>,
    pub body_mix: Option<f32>,
    pub attack: Option<f32>,
    pub release: Option<f32>,
    pub duration: Option<f32>,
    /// Offline events only: seconds from the start of the render.
    pub start_time: Option<f64>,
}

impl PhysModNoteConfig {
    pub fn to_params(&self) -> PhysModParams {
        let d = PhysModParams::default();
        PhysModParams {
            freq: self.freq.unwrap_or(d.freq).clamp(1.0, 20_000.0),
            velocity: self.velocity.unwrap_or(d.velocity).clamp(0.0, 1.0),
            gain: self.gain.unwrap_or(d.gain).clamp(0.0, 4.0),
            bow_force: self.bow_force.unwrap_or(d.bow_force).clamp(0.0, 1.0),
            bow_velocity: self.bow_velocity.unwrap_or(d.bow_velocity).clamp(0.0, 1.0),
            bow_position: self.bow_position.unwrap_or(d.bow_position).clamp(0.02, 0.5),
            vibrato_rate: self.vibrato_rate.unwrap_or(d.vibrato_rate).clamp(0.0, 12.0),
            vibrato_depth: self.vibrato_depth.unwrap_or(d.vibrato_depth).clamp(0.0, 100.0),
            damping: self.damping.unwrap_or(d.damping).clamp(0.0, 1.0),
            brightness: self.brightness.unwrap_or(d.brightness).clamp(0.0, 1.0),
            body_size: self.body_size.unwrap_or(d.body_size).clamp(0.0, 1.0),
            body_mix: self.body_mix.unwrap_or(d.body_mix).clamp(0.0, 1.0),
            attack: self.attack.unwrap_or(d.attack).clamp(0.001, 3.0),
            release: self.release.unwrap_or(d.release).clamp(0.005, 5.0),
            duration: self.duration.unwrap_or(d.duration).clamp(0.0, 60.0),
        }
    }

    fn instrument_id(&self) -> String {
        self.instrument.clone().or_else(|| self.track_id.clone()).unwrap_or_default()
    }

    /// The `PhysModEvent` an offline render plays.
    pub fn to_event(&self) -> crate::audio::PhysModEvent {
        crate::audio::PhysModEvent { start_time: self.start_time.unwrap_or(0.0), instrument: self.instrument_id(), params: self.to_params() }
    }
}

/// Plays one timed bowed-string note on a track's bus.
#[op2]
#[serde]
pub fn op_audio_play_physmod_on_track(state: &mut OpState, #[serde] config: PhysModNoteConfig) -> Json {
    let Some(ctx) = state.try_borrow::<AddonContext>() else { return err("Context not available") };
    let Some(track) = config.track_id.clone() else { return err("a bowed-string note needs a trackId") };
    match ctx.audio_engine.play_physmod_on_track(&track, &config.instrument_id(), config.to_params()) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => err(e),
    }
}

/// Starts a note that sounds until `op_audio_physmod_note_off` (a key held, or a note latched).
#[op2]
#[serde]
pub fn op_audio_physmod_note_on(state: &mut OpState, #[serde] config: PhysModNoteConfig) -> Json {
    let Some(ctx) = state.try_borrow::<AddonContext>() else { return err("Context not available") };
    let Some(track) = config.track_id.clone() else { return err("a bowed-string note needs a trackId") };
    match ctx.audio_engine.physmod_note_on(&track, &config.instrument_id(), config.to_params()) {
        Ok(voice) => json!({ "ok": true, "voice": voice as f64 }),
        Err(e) => err(e),
    }
}

#[op2(fast)]
pub fn op_audio_physmod_note_off(state: &mut OpState, voice: f64) {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.audio_engine.physmod_note_off(voice as u64);
    }
}

/// Moves a held note's bow. `which` is "force", "velocity", "position" or "vibratoDepth".
#[op2(fast)]
pub fn op_audio_physmod_set_bow(state: &mut OpState, voice: f64, #[string] which: String, value: f64) {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.audio_engine.physmod_set_bow(voice as u64, &which, value as f32);
    }
}

/// Renders one note offline (no audio device, no bus) and reads it back: how loud it is and where
/// its energy is. The way to hear an instrument as numbers, for an AI tool or a test.
#[op2]
#[serde]
pub fn op_physmod_render_analyze(#[serde] config: PhysModNoteConfig, seconds: f64) -> Json {
    let shared = physmod::shared_for(&config.instrument_id());
    let params = config.to_params();
    let limit = if seconds > 0.0 { seconds as f32 } else { params.duration + params.release + 0.3 }.clamp(0.05, 12.0);
    let samples = physmod::render_note(shared, params, limit);
    let (left, right): (Vec<f32>, Vec<f32>) = samples.chunks_exact(2).map(|c| (c[0], c[1])).unzip();
    if left.len() < 1024 {
        return err("the note is too short to analyze");
    }
    let n = if left.len() >= 4096 { 4096 } else { 1usize << (usize::BITS - 1 - left.len().leading_zeros()) };
    let start = left.len().saturating_sub(n);
    let (l, r) = (&left[start..start + n], &right[start..start + n]);
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
