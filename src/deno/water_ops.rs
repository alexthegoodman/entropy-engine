//! `Entropy.Water` ops and the water calls on `Entropy.Audio`: JSON-in/JSON-out wrappers over
//! `crate::audio::matter::water_voice`, like the kit's (`matter_ops`). Every failure is
//! `{ ok: false, error }` rather than a throw.
//!
//! A track's water is named by an id the addon chooses (the DAW uses the track's id). A note is an
//! action - "drip", "glass", "fill", "rain", "brook", "surf" or "slosh" - with its physical
//! parameters; what makes it play a pitch (the drop whose bubble rings at it, the glass whose water
//! tunes it, the bottle whose air column rises to it) is solved here, on the caller's thread.

use crate::audio::analysis::ENGINE_SAMPLE_RATE;
use crate::audio::matter::rain::RainTarget;
use crate::audio::matter::vessel::air_modes;
use crate::audio::matter::water_voice::{self as wv, Source, VesselKind, WaterAction, WaterCommand, WaterSpec, SOURCES};
use crate::audio::physmod::analysis::spectrum;
use crate::deno::addon_ops::AddonContext;
use deno_core::{op2, OpState};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

type Json = serde_json::Value;

fn err(message: impl Into<String>) -> Json {
    json!({ "ok": false, "error": message.into() })
}

/// What a water track is built with. Anything left out keeps the default (rain on a lake, fills
/// into a bottle).
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WaterSpecConfig {
    /// "lake", "window", "roof", "tent", "cymbal" or "drum".
    pub rain: Option<String>,
    /// "bottle", "vase" or "jug".
    pub vessel: Option<String>,
}

impl WaterSpecConfig {
    pub fn to_spec(&self) -> Result<WaterSpec, String> {
        let d = WaterSpec::default();
        let rain = match self.rain.as_deref() {
            Some(n) => RainTarget::from_name(n).ok_or_else(|| format!("unknown rain surface \"{n}\""))?,
            None => d.rain,
        };
        let vessel = match self.vessel.as_deref() {
            Some(n) => VesselKind::from_name(n).ok_or_else(|| format!("unknown vessel \"{n}\""))?,
            None => d.vessel,
        };
        Ok(WaterSpec { rain, vessel })
    }
}

/// One water note as an addon describes it.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WaterNoteConfig {
    pub track_id: Option<String>,
    /// Names the `WaterShared` the ops read. Defaults to `track_id`.
    pub water_id: Option<String>,
    #[serde(default)]
    pub water: WaterSpecConfig,
    /// Each source's level in the track's mix, by name (1 as heard at its listening distance).
    pub mix: Option<HashMap<String, f32>>,
    /// "drip", "glass", "fill", "rain", "brook", "surf" or "slosh".
    pub action: Option<String>,
    /// The note, Hz (drip, glass, fill). A drip with no pitch is a tap's own drip.
    pub pitch: Option<f32>,
    /// Glass: the striker's speed, m/s. Brook: the water's speed, m/s.
    pub speed: Option<f32>,
    /// Glass: struck with a spoon instead of a soft mallet.
    pub spoon: Option<bool>,
    /// Drip: where across the basin, -1 (left) .. 1 (right).
    pub x: Option<f32>,
    /// Rain: mm/h.
    pub rate: Option<f32>,
    /// Surf: the waves' height, m.
    pub height: Option<f32>,
    /// Slosh: how hard the tub is shaken, 0..1 (1 about as hard as it takes to slop over).
    pub strength: Option<f32>,
    /// How long it lasts, s (fill: the pour; rain, brook, surf, slosh: how long it is held).
    pub duration: Option<f32>,
    /// Offline events only: seconds from the start of the render.
    pub start_time: Option<f64>,
}

impl WaterNoteConfig {
    pub fn action(&self) -> Result<WaterAction, String> {
        let f = |v: Option<f32>, d: f32| v.filter(|x| x.is_finite()).unwrap_or(d);
        let duration = f(self.duration, 1.0);
        let name = self.action.as_deref().unwrap_or("drip");
        let source = Source::from_name(name).ok_or_else(|| format!("unknown water action \"{name}\""))?;
        Ok(match source {
            Source::Drip => WaterAction::Drip { pitch: f(self.pitch, 0.0), x: f(self.x, 0.0) },
            Source::Glass => WaterAction::Glass { pitch: f(self.pitch, 523.25), speed: f(self.speed, 0.4), spoon: self.spoon.unwrap_or(false) },
            Source::Fill => WaterAction::Fill { pitch: f(self.pitch, 330.0), duration },
            Source::Rain => WaterAction::Rain { rate: f(self.rate, 5.0), duration },
            Source::Brook => WaterAction::Brook { speed: f(self.speed, 0.5), duration },
            Source::Surf => WaterAction::Surf { height: f(self.height, 1.0), duration },
            Source::Slosh => WaterAction::Slosh { strength: f(self.strength, 1.0), duration },
        })
    }

    pub fn mix(&self) -> [f32; SOURCES] {
        let mut m = wv::DEFAULT_MIX;
        if let Some(map) = &self.mix {
            for s in Source::ALL {
                if let Some(v) = map.get(s.name()) {
                    m[s.index()] = v.clamp(0.0, 64.0);
                }
            }
        }
        m
    }

    fn water_id(&self) -> String {
        self.water_id.clone().or_else(|| self.track_id.clone()).unwrap_or_default()
    }

    /// The `WaterEvent` an offline render plays.
    pub fn to_event(&self) -> Result<crate::audio::WaterEvent, String> {
        let spec = self.water.to_spec()?;
        Ok(crate::audio::WaterEvent { start_time: self.start_time.unwrap_or(0.0), id: self.water_id(), spec, mix: self.mix(), command: self.action()?.command(&spec) })
    }
}

fn described(id: &str, shared: &wv::WaterShared) -> Json {
    let s = shared.state();
    let levels: serde_json::Map<String, Json> = Source::ALL.iter().map(|src| (src.name().to_string(), json!(s.levels[src.index()]))).collect();
    let glasses: Vec<Json> = (0..wv::GLASSES)
        .filter(|&k| s.glass_pitch[k] > 0.0)
        .map(|k| json!({ "pitchHz": s.glass_pitch[k], "energyJ": s.glass_energy[k], "levelMm": s.glass_level[k] * 1000.0, "heightMm": s.glass_height[k] * 1000.0 }))
        .collect();
    let fills: Vec<Json> = (0..wv::FILLS).map(|k| json!({ "level": s.fill_level[k], "airHz": s.fill_pitch[k], "pouring": s.filling[k] })).collect();
    json!({
        "ok": true,
        "id": id,
        "active": shared.active_voices(),
        "levels": levels,
        "drip": { "lastHz": s.last_drip, "drops": s.drips, "bubbles": s.bubbles },
        "glasses": glasses,
        "fills": fills,
        "rain": { "rateMmH": s.rain_rate, "drops": s.raindrops },
        "brook": { "speed": s.brook_speed, "dissipationW": s.brook_dissipation },
        "surf": { "heightM": s.surf_height, "breakers": s.surf_breakers },
        "slosh": { "strength": s.slosh, "bores": s.slosh_bores },
    })
}

#[op2]
#[serde]
pub fn op_water_info(#[string] id: String) -> Json {
    described(&id, &wv::shared_for(&id))
}

#[op2(fast)]
pub fn op_water_remove(#[string] id: String) -> bool {
    wv::remove_shared(&id)
}

/// Builds (off the audio thread) or checks the track's water: `{ ok, status: "ready" | "building" |
/// "rebuilding" }`. Notes sent while it is first being built are dropped.
#[op2]
#[serde]
pub fn op_audio_water_prepare(state: &mut OpState, #[serde] config: WaterNoteConfig) -> Json {
    let Some(ctx) = state.try_borrow::<AddonContext>() else { return err("Context not available") };
    let Some(track) = config.track_id.clone() else { return err("water needs a trackId") };
    let spec = match config.water.to_spec() {
        Ok(s) => s,
        Err(e) => return err(e),
    };
    match ctx.audio_engine.water_prepare(&track, &config.water_id(), spec) {
        Ok(s) => json!({ "ok": true, "status": s.name() }),
        Err(e) => err(e),
    }
}

/// Plays a note on the track's water now. `{ ok, played }`: `played` is false while it is still
/// being built.
#[op2]
#[serde]
pub fn op_audio_play_water_on_track(state: &mut OpState, #[serde] config: WaterNoteConfig) -> Json {
    let Some(ctx) = state.try_borrow::<AddonContext>() else { return err("Context not available") };
    let Some(track) = config.track_id.clone() else { return err("a note needs a trackId") };
    let (spec, action) = match (config.water.to_spec(), config.action()) {
        (Ok(s), Ok(a)) => (s, a),
        (Err(e), _) | (_, Err(e)) => return err(e),
    };
    match ctx.audio_engine.play_water_on_track(&track, &config.water_id(), spec, config.mix(), action.command(&spec)) {
        Ok(played) => json!({ "ok": true, "played": played }),
        Err(e) => err(e),
    }
}

/// Stops the track's water.
#[op2(fast)]
pub fn op_audio_water_remove(state: &mut OpState, #[string] track_id: String, #[string] water_id: String) {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.audio_engine.water_remove(&track_id, &water_id);
    }
}

/// Renders one note offline on a fresh water instrument (no audio device, no bus) and measures it.
#[op2]
#[serde]
pub fn op_water_render_analyze(#[serde] config: WaterNoteConfig, seconds: f64) -> Json {
    analyze(&config, seconds)
}

/// What `op_water_render_analyze` answers: level, brightness and the strongest frequency, and what
/// the physics made of the note (the drop, the glass, the vessel, the rain...).
pub fn analyze(config: &WaterNoteConfig, seconds: f64) -> Json {
    let (spec, action) = match (config.water.to_spec(), config.action()) {
        (Ok(s), Ok(a)) => (s, a),
        (Err(e), _) | (_, Err(e)) => return err(e),
    };
    let command = action.command(&spec);
    let held = match command {
        WaterCommand::Fill { pour, .. } => pour.duration,
        WaterCommand::Rain { duration, .. } | WaterCommand::Brook { duration, .. } | WaterCommand::Surf { duration, .. } | WaterCommand::Slosh { duration, .. } => duration,
        _ => 0.0,
    };
    let secs = if seconds > 0.0 { seconds as f32 } else { held + 1.0 }.clamp(0.1, 60.0);
    let sr = ENGINE_SAMPLE_RATE as f32;
    let stereo = wv::render_water_performance(spec, config.mix(), &[(0.0, command)], secs - held.min(secs));
    let x: Vec<f32> = stereo.chunks(2).map(|c| 0.5 * (c[0] + c[1])).take((secs * sr) as usize).collect();
    let peak = x.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    let db = |v: f32| 20.0 * v.max(1.0e-9).log10();
    let mut out = json!({ "ok": true, "action": action.source().name(), "seconds": secs, "peakDb": db(peak) });
    if peak > 1.0e-9 {
        let rms = (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt();
        let (mags, bin) = spectrum(&x, sr);
        let power: f32 = mags.iter().map(|m| m * m).sum::<f32>().max(1.0e-30);
        let centroid = mags.iter().enumerate().map(|(i, m)| i as f32 * bin * m * m).sum::<f32>() / power;
        let strongest = mags.iter().enumerate().skip((30.0 / bin) as usize).max_by(|a, b| a.1.total_cmp(b.1)).map(|(i, _)| i as f32 * bin).unwrap_or(0.0);
        out["rmsDb"] = json!(db(rms));
        out["centroidHz"] = json!(centroid);
        out["strongestHz"] = json!(strongest);
    }
    match command {
        WaterCommand::Drip { drop, .. } => {
            let bubble = crate::audio::matter::drop::REGULAR_BUBBLE * drop.radius;
            let depth = drop.birth_depth(bubble);
            let born = crate::audio::matter::bubble::bubble_mode(bubble, depth).freq * crate::audio::matter::bubble::surface_factor(bubble, depth);
            out["drop"] = json!({ "radiusMm": drop.radius * 1000.0, "speed": drop.speed, "fallCm": drop.fall_height() * 100.0, "regime": format!("{:?}", drop.regime()).to_lowercase() });
            if drop.regime() == crate::audio::matter::drop::Entrainment::Regular {
                out["bubble"] = json!({ "radiusMm": bubble * 1000.0, "bornHz": born, "depthMm": depth * 1000.0 });
            }
        }
        WaterCommand::Glass { vessel, level, speed, .. } => {
            let g = crate::audio::matter::vessel::GlassSpec { vessel };
            let (empty, full) = g.range();
            out["glass"] = json!({ "radiusMm": vessel.radius * 1000.0, "heightMm": vessel.height * 1000.0, "levelMm": level * 1000.0, "emptyHz": empty, "fullHz": full, "pitchHz": g.freq(2, level), "speed": speed });
        }
        WaterCommand::Fill { vessel, from, pour } => {
            let end = (vessel.volume_to(from) + pour.flow * pour.duration).max(0.0);
            // The level the pour ends at (the body's area, or the neck's past it).
            let level_end = {
                let (mut lo, mut hi) = (from, vessel.total_height());
                for _ in 0..50 {
                    let mid = 0.5 * (lo + hi);
                    if vessel.volume_to(mid) < end { lo = mid } else { hi = mid }
                }
                0.5 * (lo + hi)
            };
            let air = |l: f32| {
                let mut m = [crate::audio::matter::vessel::AirMode::default(); 1];
                air_modes(&vessel, l, 1.0e6, &mut m);
                m[0].freq
            };
            out["vessel"] = json!({ "radiusMm": vessel.radius * 1000.0, "heightMm": vessel.height * 1000.0, "neckRadiusMm": vessel.neck_radius * 1000.0, "neckLengthMm": vessel.neck_length * 1000.0, "fromMm": from * 1000.0, "toMm": level_end * 1000.0, "startHz": air(from), "endHz": air(level_end), "flowMlPerS": pour.flow * 1.0e6 });
        }
        WaterCommand::Rain { rate, duration } => {
            out["rain"] = json!({ "surface": spec.rain.name(), "rateMmH": rate, "duration": duration });
        }
        WaterCommand::Brook { speed, duration } => {
            out["brook"] = json!({ "speed": speed, "duration": duration });
        }
        WaterCommand::Surf { height, duration } => {
            out["surf"] = json!({ "heightM": height, "duration": duration });
        }
        WaterCommand::Slosh { strength, duration } => {
            out["slosh"] = json!({ "strength": strength, "duration": duration });
        }
        WaterCommand::Mix(_) => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(action: &str, extra: impl FnOnce(&mut WaterNoteConfig)) -> WaterNoteConfig {
        let mut c = WaterNoteConfig { action: Some(action.into()), ..Default::default() };
        extra(&mut c);
        c
    }

    #[test]
    fn analyzing_notes_measures_what_the_physics_did() {
        // A drip tuned to A5 is a regular drip whose bubble is born at the note.
        let a = analyze(&note("drip", |c| c.pitch = Some(880.0)), 0.3);
        assert_eq!(a["ok"], true, "{a}");
        assert_eq!(a["drop"]["regime"], "regular");
        let born = a["bubble"]["bornHz"].as_f64().unwrap();
        assert!((born / 880.0 - 1.0).abs() < 2.0e-3, "{a}");
        // A glass is tuned to its note by its water; a spoon is brighter than a mallet.
        let mallet = analyze(&note("glass", |c| c.pitch = Some(440.0)), 1.0);
        assert!((mallet["glass"]["pitchHz"].as_f64().unwrap() / 440.0 - 1.0).abs() < 1.0e-3, "{mallet}");
        assert!((mallet["strongestHz"].as_f64().unwrap() / 440.0 - 1.0).abs() < 0.02, "{mallet}");
        let spoon = analyze(&note("glass", |c| {
            c.pitch = Some(440.0);
            c.spoon = Some(true);
            c.speed = Some(0.05);
        }), 1.0);
        assert!(spoon["centroidHz"].as_f64().unwrap() > mallet["centroidHz"].as_f64().unwrap() * 1.5, "{spoon} {mallet}");
        // A fill rises a fifth to its note.
        let fill = analyze(&note("fill", |c| {
            c.pitch = Some(330.0);
            c.duration = Some(1.5);
        }), 2.0);
        let (start, end) = (fill["vessel"]["startHz"].as_f64().unwrap(), fill["vessel"]["endHz"].as_f64().unwrap());
        assert!((end / 330.0 - 1.0).abs() < 0.02, "{fill}");
        assert!((1200.0 * (end / start).log2() - 700.0).abs() < 30.0, "{fill}");
        // Unknown things are errors, not panics.
        assert_eq!(analyze(&note("tsunami", |_| {}), 1.0)["ok"], false);
        assert_eq!(analyze(&note("rain", |c| c.water.rain = Some("ocean liner".into())), 1.0)["ok"], false);
    }

    #[test]
    fn a_note_config_becomes_an_offline_event() {
        let c = note("rain", |c| {
            c.track_id = Some("t1".into());
            c.water.rain = Some("tent".into());
            c.rate = Some(500.0);
            c.duration = Some(4.0);
            c.start_time = Some(2.5);
            c.mix = Some([("rain".to_string(), 99.0)].into_iter().collect());
        });
        let e = c.to_event().unwrap();
        assert_eq!(e.id, "t1");
        assert_eq!(e.start_time, 2.5);
        assert_eq!(e.spec.rain, RainTarget::Tent);
        assert_eq!(e.mix[Source::Rain.index()], 64.0);
        assert_eq!(e.command, WaterCommand::Rain { rate: 150.0, duration: 4.0 });
    }
}
