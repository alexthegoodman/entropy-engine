//! `Entropy.Brass` ops: JSON-in/JSON-out wrappers over `crate::audio::brass`, and the note ops on
//! `Entropy.Audio` that play it. Like the physmod ops, every failure is `{ ok: false, error }`
//! rather than a throw.
//!
//! A player is named by an id the addon chooses (the DAW uses the track's id). Its instrument and
//! settings travel with each note, so the widget, these ops and the live player all publish to and
//! read the same `BrassShared` by that id.

use crate::audio::brass::{self, Articulation, BrassInstrument, BrassParams};
use crate::deno::addon_ops::AddonContext;
use deno_core::{op2, OpState};
use serde::Deserialize;
use serde_json::json;

type Json = serde_json::Value;

fn err(message: impl Into<String>) -> Json {
    json!({ "ok": false, "error": message.into() })
}

fn described(id: &str, shared: &brass::BrassShared) -> Json {
    let s = shared.state();
    let ladder: Vec<Json> = (1..=brass::LADDER_POINTS).map(|n| { let (hz, mag) = shared.resonance(n); json!({ "partial": n, "hz": hz, "impedance": mag }) }).collect();
    json!({
        "ok": true,
        "id": id,
        "instrument": brass::BrassInstrument::from_index(s.instrument).name(),
        "activeVoices": shared.active_voices(),
        "playing": s.playing,
        "partial": s.partial,
        "position": s.position,
        "slideExtension": s.extension,
        "mouthPressurePa": s.mouth_pressure,
        "breath": s.breath,
        "lipTension": s.lip_tension,
        "lipHz": s.lip_freq,
        "lipOpeningMm": s.lip_opening * 1000.0,
        "targetHz": s.target,
        "resonanceHz": s.resonance,
        "soundingHz": s.sounding,
        "waveSteepness": s.wave_steepness,
        "mouthpieceLevelPa": s.mouthpiece_level,
        "resonances": ladder,
    })
}

#[op2]
#[serde]
pub fn op_brass_info(#[string] id: String) -> Json {
    described(&id, &brass::shared_for(&id))
}

#[op2(fast)]
pub fn op_brass_remove(#[string] id: String) -> bool {
    brass::remove_shared(&id)
}

/// A brass note as an addon describes it. Anything left out keeps `BrassParams::default`.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BrassNoteConfig {
    pub track_id: Option<String>,
    /// Names the `BrassShared` a widget reads. Defaults to `track_id`.
    pub instrument_id: Option<String>,
    /// "trombone" (default).
    pub instrument: Option<String>,
    pub freq: Option<f32>,
    pub velocity: Option<f32>,
    pub gain: Option<f32>,
    pub breath: Option<f32>,
    pub lip_tension: Option<f32>,
    pub aperture: Option<f32>,
    pub vibrato_rate: Option<f32>,
    pub vibrato_depth: Option<f32>,
    pub vibrato_delay: Option<f32>,
    pub attack: Option<f32>,
    pub release: Option<f32>,
    pub duration: Option<f32>,
    /// "tongued" (default), "legato" or "glissando".
    pub articulation: Option<String>,
    pub attack_skill: Option<f32>,
    pub breath_noise: Option<f32>,
    pub slide_time: Option<f32>,
    pub brassiness: Option<f32>,
    /// Offline events only: seconds from the start of the render.
    pub start_time: Option<f64>,
}

impl BrassNoteConfig {
    pub fn to_params(&self) -> BrassParams {
        let d = BrassParams::default();
        BrassParams {
            freq: self.freq.unwrap_or(d.freq).clamp(20.0, 2000.0),
            velocity: self.velocity.unwrap_or(d.velocity).clamp(0.0, 1.0),
            gain: self.gain.unwrap_or(d.gain).clamp(0.0, 4.0),
            breath: self.breath.unwrap_or(d.breath).clamp(0.0, 1.0),
            lip_tension: self.lip_tension.unwrap_or(d.lip_tension).clamp(-1.0, 1.0),
            aperture: self.aperture.unwrap_or(d.aperture).clamp(0.0, 1.0),
            vibrato_rate: self.vibrato_rate.unwrap_or(d.vibrato_rate).clamp(0.0, 12.0),
            vibrato_depth: self.vibrato_depth.unwrap_or(d.vibrato_depth).clamp(0.0, 100.0),
            vibrato_delay: self.vibrato_delay.unwrap_or(d.vibrato_delay).clamp(0.0, 2.0),
            attack: self.attack.unwrap_or(d.attack).clamp(0.001, 0.5),
            release: self.release.unwrap_or(d.release).clamp(0.005, 3.0),
            duration: self.duration.unwrap_or(d.duration).clamp(0.0, 60.0),
            articulation: self.articulation.as_deref().and_then(Articulation::from_name).unwrap_or(d.articulation),
            attack_skill: self.attack_skill.unwrap_or(d.attack_skill).clamp(0.0, 1.0),
            breath_noise: self.breath_noise.unwrap_or(d.breath_noise).clamp(0.0, 1.0),
            slide_time: self.slide_time.unwrap_or(d.slide_time).clamp(0.005, 2.0),
            // The laboratory: 0 is linear air, 1 real air, beyond it more than air can do.
            brassiness: self.brassiness.unwrap_or(d.brassiness).clamp(0.0, 4.0),
            instrument: self.instrument.as_deref().and_then(BrassInstrument::from_name).unwrap_or(d.instrument),
        }
    }

    fn player_id(&self) -> String {
        self.instrument_id.clone().or_else(|| self.track_id.clone()).unwrap_or_default()
    }

    /// The `BrassEvent` an offline render plays.
    pub fn to_event(&self) -> crate::audio::BrassEvent {
        crate::audio::BrassEvent { start_time: self.start_time.unwrap_or(0.0), instrument: self.player_id(), params: self.to_params() }
    }
}

/// Plays one timed brass note on a track's bus.
#[op2]
#[serde]
pub fn op_audio_play_brass_on_track(state: &mut OpState, #[serde] config: BrassNoteConfig) -> Json {
    let Some(ctx) = state.try_borrow::<AddonContext>() else { return err("Context not available") };
    let Some(track) = config.track_id.clone() else { return err("a brass note needs a trackId") };
    match ctx.audio_engine.play_brass_on_track(&track, &config.player_id(), config.to_params()) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => err(e),
    }
}

/// Starts a note that sounds until `op_audio_brass_note_off`.
#[op2]
#[serde]
pub fn op_audio_brass_note_on(state: &mut OpState, #[serde] config: BrassNoteConfig) -> Json {
    let Some(ctx) = state.try_borrow::<AddonContext>() else { return err("Context not available") };
    let Some(track) = config.track_id.clone() else { return err("a brass note needs a trackId") };
    match ctx.audio_engine.brass_note_on(&track, &config.player_id(), config.to_params()) {
        Ok(voice) => json!({ "ok": true, "voice": voice as f64 }),
        Err(e) => err(e),
    }
}

#[op2(fast)]
pub fn op_audio_brass_note_off(state: &mut OpState, voice: f64) {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.audio_engine.brass_note_off(voice as u64);
    }
}

/// Moves a held note's live control: "breath", "lipTension", "vibratoDepth" or "bend" (cents).
#[op2(fast)]
pub fn op_audio_brass_set_control(state: &mut OpState, voice: f64, #[string] which: String, value: f64) {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.audio_engine.brass_set_control(voice as u64, &which, value as f32);
    }
}

/// Renders one note offline (no audio device, no bus) and reads it back: pitch, loudness,
/// brightness, harmonic balance, how fast it spoke, and what the player and air column did.
#[op2]
#[serde]
pub fn op_brass_render_analyze(#[serde] config: BrassNoteConfig, seconds: f64) -> Json {
    let params = config.to_params();
    let secs = if seconds > 0.0 { seconds as f32 } else { params.duration.max(0.4) + 0.2 }.clamp(0.2, 12.0);
    let a = brass::analysis::analyze_note(&params, secs, (secs * 0.5).min(0.5));
    if a.rms_db < -150.0 {
        return err("the note did not sound");
    }
    json!({
        "ok": true,
        "seconds": secs,
        "peakDb": a.peak_db,
        "rmsDb": a.rms_db,
        "pitchHz": a.f0,
        "centsOff": a.cents,
        "centroidHz": a.centroid_hz,
        "harmonicsDb": a.harmonics_db.to_vec(),
        "partial": a.partial,
        "position": a.position,
        "mouthPressurePa": a.mouth_pressure,
        "mouthpieceLevelPa": a.mouthpiece_level,
        "waveSteepness": a.wave_steepness,
        "attackSeconds": a.attack_secs,
    })
}
