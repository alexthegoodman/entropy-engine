//! `Entropy.Piano` ops: JSON-in/JSON-out wrappers over `crate::audio::piano`, and note/pedal
//! operations on `Entropy.Audio` for playing a physically modelled grand piano.
//!
//! Every failure returns `{ ok: false, error }` rather than throwing.

use crate::audio::piano::{self, PianoParams, PianoPreset};
use crate::audio::quality::Quality;
use crate::deno::addon_ops::AddonContext;
use deno_core::{op2, OpState};
use serde::Deserialize;
use serde_json::json;

type Json = serde_json::Value;

fn err(message: impl Into<String>) -> Json {
    json!({ "ok": false, "error": message.into() })
}

/// A piano note / hit configuration as described by TypeScript / Deno.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PianoNoteConfig {
    pub track_id: Option<String>,
    pub instrument: Option<String>,
    pub freq: Option<f32>,
    pub velocity: Option<f32>,
    pub gain: Option<f32>,
    pub duration: Option<f32>,
    pub sustain_pedal: Option<f32>,
    pub una_corda: Option<f32>,
    pub preset: Option<String>,
    pub soundboard_resonance: Option<f32>,
    pub sympathetic_coupling: Option<f32>,
    pub hammer_hardness: Option<f32>,
    pub inharmonicity_scale: Option<f32>,
    pub quality: Option<String>,
    pub start_time: Option<f64>,
}

impl PianoNoteConfig {
    pub fn to_params(&self) -> PianoParams {
        let d = PianoParams::default();
        PianoParams {
            freq: self.freq.unwrap_or(d.freq).clamp(20.0, 5000.0),
            velocity: self.velocity.unwrap_or(d.velocity).clamp(0.0, 1.0),
            gain: self.gain.unwrap_or(d.gain).clamp(0.0, 4.0),
            duration: self.duration.unwrap_or(d.duration).clamp(0.0, 60.0),
            sustain_pedal: self.sustain_pedal.unwrap_or(d.sustain_pedal).clamp(0.0, 1.0),
            una_corda: self.una_corda.unwrap_or(d.una_corda).clamp(0.0, 1.0),
            preset: self.preset.as_deref().and_then(PianoPreset::from_name).unwrap_or(d.preset),
            soundboard_resonance: self.soundboard_resonance.unwrap_or(d.soundboard_resonance).clamp(0.0, 2.0),
            sympathetic_coupling: self.sympathetic_coupling.unwrap_or(d.sympathetic_coupling).clamp(0.0, 2.0),
            hammer_hardness: self.hammer_hardness.unwrap_or(d.hammer_hardness).clamp(0.5, 2.0),
            inharmonicity_scale: self.inharmonicity_scale.unwrap_or(d.inharmonicity_scale).clamp(0.0, 3.0),
            quality: self.quality.as_deref().and_then(Quality::from_name).unwrap_or(d.quality),
        }
    }

    pub fn instrument_id(&self) -> String {
        self.instrument.clone().or_else(|| self.track_id.clone()).unwrap_or_default()
    }

    pub fn to_event(&self) -> crate::audio::PianoEvent {
        crate::audio::PianoEvent {
            start_time: self.start_time.unwrap_or(0.0),
            instrument: self.instrument_id(),
            params: self.to_params(),
        }
    }
}

/// Returns real-time state of the grand piano instrument for inspection or UI display.
#[op2]
#[serde]
pub fn op_piano_info(#[string] id: String) -> Json {
    let shared = piano::shared_for(&id);
    let mut keys = Vec::with_capacity(piano::KEY_COUNT);

    for i in 0..piano::KEY_COUNT {
        let k = &shared.keys[i];
        keys.push(json!({
            "key": i,
            "down": k.key_down.load(std::sync::atomic::Ordering::Relaxed),
            "damperDown": k.damper_down.load(std::sync::atomic::Ordering::Relaxed),
            "energy": f32::from_bits(k.energy.load(std::sync::atomic::Ordering::Relaxed)),
            "hammerPos": f32::from_bits(k.hammer_pos.load(std::sync::atomic::Ordering::Relaxed)),
        }));
    }

    json!({
        "ok": true,
        "id": id,
        "activeVoices": shared.active_voices.load(std::sync::atomic::Ordering::Relaxed),
        "sustainPedal": f32::from_bits(shared.sustain_pedal.load(std::sync::atomic::Ordering::Relaxed)),
        "unaCorda": f32::from_bits(shared.una_corda.load(std::sync::atomic::Ordering::Relaxed)),
        "soundboardEnergy": f32::from_bits(shared.soundboard_energy.load(std::sync::atomic::Ordering::Relaxed)),
        "bridgeVelocity": f32::from_bits(shared.bridge_velocity.load(std::sync::atomic::Ordering::Relaxed)),
        "latestContactTimeMs": f32::from_bits(shared.latest_contact_time.load(std::sync::atomic::Ordering::Relaxed)),
        "latestPeakForceN": f32::from_bits(shared.latest_peak_force.load(std::sync::atomic::Ordering::Relaxed)),
        "keys": keys,
    })
}

#[op2(fast)]
pub fn op_piano_remove(#[string] id: String) -> bool {
    piano::remove_shared(&id)
}

/// Prepares the grand piano instrument on the track's bus ahead of the first note.
#[op2]
#[serde]
pub fn op_audio_piano_prepare(state: &mut OpState, #[serde] config: PianoNoteConfig) -> Json {
    let Some(ctx) = state.try_borrow::<AddonContext>() else { return err("Context not available") };
    let Some(track) = config.track_id.clone() else { return err("a grand piano needs a trackId") };
    match ctx.audio_engine.piano_prepare(&track, &config.instrument_id(), config.to_params()) {
        Ok(s) => json!({ "ok": true, "status": s.name() }),
        Err(e) => err(e),
    }
}

/// Plays one timed piano note on a track's bus.
#[op2]
#[serde]
pub fn op_audio_play_piano_on_track(state: &mut OpState, #[serde] config: PianoNoteConfig) -> Json {
    let Some(ctx) = state.try_borrow::<AddonContext>() else { return err("Context not available") };
    let Some(track) = config.track_id.clone() else { return err("a piano note needs a trackId") };
    match ctx.audio_engine.play_piano_on_track(&track, &config.instrument_id(), config.to_params()) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => err(e),
    }
}

/// Starts a piano note that sounds until `op_audio_piano_note_off`.
#[op2]
#[serde]
pub fn op_audio_piano_note_on(state: &mut OpState, #[serde] config: PianoNoteConfig) -> Json {
    let Some(ctx) = state.try_borrow::<AddonContext>() else { return err("Context not available") };
    let Some(track) = config.track_id.clone() else { return err("a piano note needs a trackId") };
    match ctx.audio_engine.piano_note_on(&track, &config.instrument_id(), config.to_params()) {
        Ok(voice) => json!({ "ok": true, "voice": voice as f64 }),
        Err(e) => err(e),
    }
}

/// Releases a piano key (dropping the damper onto the string).
#[op2(fast)]
pub fn op_audio_piano_note_off(state: &mut OpState, #[string] track_id: String, #[string] instrument: String, freq: f64) {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.audio_engine.piano_note_off(&track_id, &instrument, freq as f32);
    }
}

/// Sets piano pedals: sustain (0.0..1.0) and una corda (0.0..1.0).
#[op2(fast)]
pub fn op_audio_piano_set_pedal(state: &mut OpState, #[string] track_id: String, #[string] instrument: String, sustain: f64, una_corda: f64) {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.audio_engine.piano_set_pedal(&track_id, &instrument, sustain as f32, una_corda as f32);
    }
}

/// Renders a piano note offline and returns comprehensive acoustic descriptors.
#[op2]
#[serde]
pub fn op_piano_render_analyze(#[serde] config: PianoNoteConfig, seconds: f64) -> Json {
    let params = config.to_params();
    let secs = if seconds > 0.0 { seconds as f32 } else { params.duration.max(0.5) + 0.5 }.clamp(0.1, 15.0);
    let a = piano::analysis::analyze_note(&params, secs);

    json!({
        "ok": true,
        "seconds": secs,
        "peakDb": a.peak_db,
        "rmsDb": a.rms_db,
        "pitchHz": a.f0,
        "centsOff": a.cents,
        "centroidHz": a.centroid_hz,
        "harmonicsDb": a.harmonics_db.to_vec(),
        "attackSeconds": a.attack_secs,
        "contactTimeMs": a.contact_time_ms,
        "peakForceN": a.peak_force_n,
        "promptDecayDbPerSec": a.prompt_decay_db_per_sec,
        "aftersoundDecayDbPerSec": a.aftersound_decay_db_per_sec,
        "twoStageRatio": a.two_stage_ratio,
        "inharmonicityB": a.inharmonicity_b,
    })
}

#[op2(fast)]
pub fn op_audio_piano_all_notes_off(state: &mut OpState, #[string] track_id: String) {
    if let Some(ctx)=state.try_borrow::<AddonContext>() {ctx.audio_engine.piano_all_notes_off(&track_id);}
}
