//! `Entropy.PhysMod` ops: JSON-in/JSON-out wrappers over `crate::audio::physmod`, and the note ops on
//! `Entropy.Audio` that play a bowed string. Like the wavetable and VST3 ops, every failure is
//! `{ ok: false, error }` rather than a throw.
//!
//! An instrument is named by an id the addon chooses (the DAW uses the track's id). There is no
//! editable object to fetch here the way a wavetable has a sculptable table: the instrument's
//! construction (strings, body, rosin...) travels with each note, so `Widget.physModString`, these
//! ops and the live instrument all just publish to and read the same `PhysModShared` by that id.

use crate::audio::physmod::{self, PhysModParams};
use crate::deno::addon_ops::AddonContext;
use deno_core::{op2, OpState};
use serde::Deserialize;
use serde_json::json;

type Json = serde_json::Value;

fn err(message: impl Into<String>) -> Json {
    json!({ "ok": false, "error": message.into() })
}

fn regime_name(r: physmod::BowRegime) -> &'static str {
    match r {
        physmod::BowRegime::Free => "free",
        physmod::BowRegime::Helmholtz => "helmholtz",
        physmod::BowRegime::SurfaceSound => "surfaceSound",
        physmod::BowRegime::Raucous => "raucous",
    }
}

fn described(id: &str, shared: &physmod::PhysModShared) -> Json {
    let strings: Vec<Json> = (0..shared.string_count())
        .map(|i| {
            let s = shared.string_info(i);
            json!({
                "openHz": s.open_freq, "hz": s.freq, "finger": s.finger, "bowPosition": s.beta,
                "level": s.level, "bowForceN": s.bow_force, "bowSpeed": s.bow_velocity,
                "forceMinN": s.force_min, "forceMaxN": s.force_max,
                "stickFraction": s.stick_fraction, "slipsPerPeriod": s.slips_per_period,
                "regime": regime_name(s.regime()), "sympathetic": s.sympathetic, "playing": s.playing,
            })
        })
        .collect();
    let modes: Vec<Json> = (0..shared.body_mode_count()).map(|i| { let (f, l) = shared.body_mode(i); json!({ "hz": f, "level": l }) }).collect();
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
        "activeString": shared.active_string(),
        "strings": strings,
        "bodyModes": modes,
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
    /// "arco" (default), "pizzicato" or "colLegno".
    pub articulation: Option<String>,
    pub vibrato_delay: Option<f32>,
    pub ring: Option<f32>,
    pub slide: Option<f32>,
    pub attack_skill: Option<f32>,
    /// Open-string pitches, low to high (up to 4). Omitted: a violin.
    pub strings: Option<Vec<f32>>,
    /// Sympathetic (unbowed) string pitches (up to 6).
    pub sympathetic: Option<Vec<f32>>,
    pub string_mass: Option<f32>,
    pub stiffness: Option<f32>,
    pub rosin: Option<f32>,
    pub bow_noise: Option<f32>,
    pub coupling: Option<f32>,
    pub body_resonance: Option<f32>,
    pub body_seed: Option<u32>,
    /// Offline events only: seconds from the start of the render.
    pub start_time: Option<f64>,
}

impl PhysModNoteConfig {
    pub fn to_params(&self) -> PhysModParams {
        let d = PhysModParams::default();
        let mut strings = [0.0f32; physmod::MAX_STRINGS];
        if let Some(list) = &self.strings {
            for (dst, f) in strings.iter_mut().zip(list.iter().filter(|f| f.is_finite() && **f > 0.0)) {
                *dst = f.clamp(physmod::MIN_FREQ, 5000.0);
            }
            // Low to high, the order a player picks strings in.
            let n = list.len().min(physmod::MAX_STRINGS);
            strings[..n].sort_by(|a, b| a.total_cmp(b));
        }
        let mut sympathetic = [0.0f32; physmod::MAX_SYMPATHETIC];
        if let Some(list) = &self.sympathetic {
            for (dst, f) in sympathetic.iter_mut().zip(list.iter().filter(|f| f.is_finite() && **f > 0.0)) {
                *dst = f.clamp(physmod::MIN_FREQ, 5000.0);
            }
        }
        PhysModParams {
            freq: self.freq.unwrap_or(d.freq).clamp(physmod::MIN_FREQ, 8000.0),
            velocity: self.velocity.unwrap_or(d.velocity).clamp(0.0, 1.0),
            gain: self.gain.unwrap_or(d.gain).clamp(0.0, 4.0),
            bow_force: self.bow_force.unwrap_or(d.bow_force).clamp(0.0, 1.0),
            bow_velocity: self.bow_velocity.unwrap_or(d.bow_velocity).clamp(0.0, 1.0),
            bow_position: self.bow_position.unwrap_or(d.bow_position).clamp(0.02, 0.5),
            vibrato_rate: self.vibrato_rate.unwrap_or(d.vibrato_rate).clamp(0.0, 12.0),
            vibrato_depth: self.vibrato_depth.unwrap_or(d.vibrato_depth).clamp(0.0, 100.0),
            vibrato_delay: self.vibrato_delay.unwrap_or(d.vibrato_delay).clamp(0.0, 2.0),
            damping: self.damping.unwrap_or(d.damping).clamp(0.0, 1.0),
            brightness: self.brightness.unwrap_or(d.brightness).clamp(0.0, 1.0),
            // The instrument laboratory: body size may go past violin (0) and bass (1).
            body_size: self.body_size.unwrap_or(d.body_size).clamp(-1.0, 2.5),
            body_mix: self.body_mix.unwrap_or(d.body_mix).clamp(0.0, 1.0),
            attack: self.attack.unwrap_or(d.attack).clamp(0.003, 3.0),
            release: self.release.unwrap_or(d.release).clamp(0.01, 5.0),
            duration: self.duration.unwrap_or(d.duration).clamp(0.0, 60.0),
            articulation: self.articulation.as_deref().and_then(physmod::Articulation::from_name).unwrap_or(d.articulation),
            ring: self.ring.unwrap_or(d.ring).clamp(0.0, 1.0),
            slide: self.slide.unwrap_or(d.slide).clamp(0.0, 1.0),
            attack_skill: self.attack_skill.unwrap_or(d.attack_skill).clamp(0.0, 1.0),
            strings,
            sympathetic,
            string_mass: self.string_mass.unwrap_or(d.string_mass).clamp(0.0, 1.0),
            stiffness: self.stiffness.unwrap_or(d.stiffness).clamp(0.0, 1.0),
            rosin: self.rosin.unwrap_or(d.rosin).clamp(0.0, 1.0),
            bow_noise: self.bow_noise.unwrap_or(d.bow_noise).clamp(0.0, 1.0),
            coupling: self.coupling.unwrap_or(d.coupling).clamp(0.0, 1.0),
            body_resonance: self.body_resonance.unwrap_or(d.body_resonance).clamp(0.0, 1.0),
            body_seed: self.body_seed.unwrap_or(d.body_seed),
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

/// Renders one note offline (no audio device, no bus) and reads it back: pitch, loudness,
/// brightness, harmonic balance, and what the bow did (see `physmod::analysis`). The way to hear an
/// instrument as numbers, for an AI tool or a test.
#[op2]
#[serde]
pub fn op_physmod_render_analyze(#[serde] config: PhysModNoteConfig, seconds: f64) -> Json {
    let params = config.to_params();
    let secs = if seconds > 0.0 { seconds as f32 } else { params.duration.max(0.4) + 0.2 }.clamp(0.1, 12.0);
    let window = (secs * 0.5).min(0.5);
    let a = physmod::analysis::analyze_note(&params, secs, window);
    if a.rms_db < -150.0 {
        return err("the note is too short to analyze");
    }
    json!({
        "ok": true,
        "seconds": secs,
        "peakDb": a.peak_db,
        "rmsDb": a.rms_db,
        "peakHz": a.f0,
        "pitchHz": a.f0,
        "centsOff": a.cents,
        "centroidHz": a.centroid_hz,
        "harmonicsDb": a.harmonics_db.to_vec(),
        "string": a.string,
        "regime": a.regime.map(regime_name),
        "slipsPerPeriod": a.slips_per_period,
        "stickFraction": a.stick_fraction,
        "attackSeconds": a.attack_secs,
    })
}
