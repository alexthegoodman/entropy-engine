//! `Entropy.Matter` ops: JSON-in/JSON-out wrappers over `crate::audio::matter`, and the hit ops on
//! `Entropy.Audio` that play a kit. Like the physmod and brass ops, every failure is
//! `{ ok: false, error }` rather than a throw.
//!
//! A kit is named by an id the addon chooses (the DAW uses the track's id). Its tunings travel with
//! each hit, so the widget, these ops and the live kit publish to and read the same `MatterShared`
//! by that id.

use crate::audio::matter::kit::{self, Piece, PIECES};
use crate::audio::matter::{live, KitHit, KitSpec};
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

/// A kit's tunings and settings as an addon describes them. Anything left out keeps
/// `KitSpec::default`.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatterKitConfig {
    pub kick: Option<f32>,
    pub snare: Option<f32>,
    pub rack_tom: Option<f32>,
    pub floor_tom: Option<f32>,
    pub kick_muffling: Option<f32>,
    pub snares: Option<bool>,
    pub snare_tension: Option<f32>,
    pub sympathetic: Option<bool>,
}

impl MatterKitConfig {
    pub fn to_spec(&self) -> KitSpec {
        let d = KitSpec::default();
        KitSpec {
            kick: self.kick.unwrap_or(d.kick),
            snare: self.snare.unwrap_or(d.snare),
            rack_tom: self.rack_tom.unwrap_or(d.rack_tom),
            floor_tom: self.floor_tom.unwrap_or(d.floor_tom),
            kick_muffling: self.kick_muffling.unwrap_or(d.kick_muffling),
            snares: self.snares.unwrap_or(d.snares),
            snare_tension: self.snare_tension.unwrap_or(d.snare_tension),
            sympathetic: self.sympathetic.unwrap_or(d.sympathetic),
        }
        .clamped()
    }
}

/// One hit as an addon describes it.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatterHitConfig {
    pub track_id: Option<String>,
    /// Names the `MatterShared` a widget reads. Defaults to `track_id`.
    pub kit_id: Option<String>,
    #[serde(default)]
    pub kit: MatterKitConfig,
    /// Each piece's level in the kit's mix, by piece name (1 as it radiates).
    pub mix: Option<HashMap<String, f32>>,
    /// "kick", "snare", "rack-tom", "floor-tom", "crash", "ride" or "splash".
    pub piece: Option<String>,
    /// Speed of the stick at impact, m/s (a ghost note ~0.5, a loud backbeat 4-6).
    pub speed: Option<f32>,
    /// 0 the centre, 1 the edge; around the head, radians.
    pub position: Option<f32>,
    pub angle: Option<f32>,
    /// "stick", "shoulder", "felt", "plastic", "mallet", "hard-mallet" or "yarn"; omitted, what
    /// usually plays the piece.
    pub striker: Option<String>,
    /// Offline events only: seconds from the start of the render.
    pub start_time: Option<f64>,
}

impl MatterHitConfig {
    pub fn hit(&self) -> Result<KitHit, String> {
        let name = self.piece.as_deref().unwrap_or("snare");
        let piece = Piece::from_name(name).ok_or_else(|| format!("unknown piece \"{name}\""))?;
        let striker = match self.striker.as_deref() {
            Some(s) => kit::striker_named(s).ok_or_else(|| format!("unknown striker \"{s}\""))?,
            None => piece.default_striker(),
        };
        let position = self.position.unwrap_or(if piece.is_cymbal() { 0.85 } else { 0.35 });
        Ok(KitHit { piece, strike: live::strike(self.speed.unwrap_or(3.0), position, self.angle.unwrap_or(0.0), striker) })
    }

    pub fn mix(&self) -> [f32; PIECES] {
        let mut m = [1.0; PIECES];
        if let Some(map) = &self.mix {
            for p in Piece::ALL {
                if let Some(v) = map.get(p.name()) {
                    m[p.index()] = v.clamp(0.0, 8.0);
                }
            }
        }
        m
    }

    fn kit_id(&self) -> String {
        self.kit_id.clone().or_else(|| self.track_id.clone()).unwrap_or_default()
    }

    /// The `MatterEvent` an offline render plays.
    pub fn to_event(&self) -> Result<crate::audio::MatterEvent, String> {
        Ok(crate::audio::MatterEvent { start_time: self.start_time.unwrap_or(0.0), kit: self.kit_id(), spec: self.kit.to_spec(), mix: self.mix(), hit: self.hit()? })
    }
}

fn described(id: &str, shared: &live::MatterShared) -> Json {
    let spec = shared.spec();
    let pieces: Vec<Json> = Piece::ALL
        .iter()
        .map(|&p| {
            let v = shared.piece(p);
            let mut o = json!({
                "piece": p.name(),
                "awake": v.awake,
                "energyJ": v.energy,
                "level": v.level,
                "strikes": v.strikes,
                "position": v.position,
                "speedIn": v.speed_in,
                "speedOut": v.speed_out,
                "contactMs": v.contact_ms,
                "peakForceN": v.peak_force,
                "mix": v.mix,
            });
            if p.is_cymbal() {
                o["nonlinear"] = json!(v.nonlinear);
            } else {
                o["glideCents"] = json!(v.glide_cents);
            }
            if p == Piece::Snare {
                o["wiresLifted"] = json!(v.wires_lifted);
                o["wireLandings"] = json!(v.wire_landings);
            }
            o
        })
        .collect();
    json!({
        "ok": true,
        "id": id,
        "activeKits": shared.active_voices(),
        "workers": shared.workers(),
        "focus": shared.focus().name(),
        "kit": {
            "kick": spec.kick, "snare": spec.snare, "rackTom": spec.rack_tom, "floorTom": spec.floor_tom,
            "kickMuffling": spec.kick_muffling, "snares": spec.snares, "snareTension": spec.snare_tension,
            "sympathetic": spec.sympathetic,
        },
        "pieces": pieces,
    })
}

#[op2]
#[serde]
pub fn op_matter_info(#[string] id: String) -> Json {
    described(&id, &live::shared_for(&id))
}

#[op2(fast)]
pub fn op_matter_remove(#[string] id: String) -> bool {
    live::remove_shared(&id)
}

/// Builds (off the audio thread) or checks the track's kit: `{ ok, status: "ready" | "building" |
/// "rebuilding" }`. Hits sent while a kit is first being built are dropped, so an addon prepares a
/// kit ahead of playing it.
#[op2]
#[serde]
pub fn op_audio_matter_prepare(state: &mut OpState, #[serde] config: MatterHitConfig) -> Json {
    let Some(ctx) = state.try_borrow::<AddonContext>() else { return err("Context not available") };
    let Some(track) = config.track_id.clone() else { return err("a kit needs a trackId") };
    match ctx.audio_engine.matter_prepare(&track, &config.kit_id(), config.kit.to_spec()) {
        Ok(s) => json!({ "ok": true, "status": s.name() }),
        Err(e) => err(e),
    }
}

/// Strikes a piece of the track's kit now. `{ ok, played }`: `played` is false while the kit is
/// still being built.
#[op2]
#[serde]
pub fn op_audio_play_matter_on_track(state: &mut OpState, #[serde] config: MatterHitConfig) -> Json {
    let Some(ctx) = state.try_borrow::<AddonContext>() else { return err("Context not available") };
    let Some(track) = config.track_id.clone() else { return err("a hit needs a trackId") };
    let hit = match config.hit() {
        Ok(h) => h,
        Err(e) => return err(e),
    };
    match ctx.audio_engine.play_matter_on_track(&track, &config.kit_id(), config.kit.to_spec(), config.mix(), hit) {
        Ok(played) => json!({ "ok": true, "played": played }),
        Err(e) => err(e),
    }
}

/// Stops the track's kit.
#[op2(fast)]
pub fn op_audio_matter_remove(state: &mut OpState, #[string] track_id: String, #[string] kit_id: String) {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.audio_engine.matter_remove(&track_id, &kit_id);
    }
}

/// Renders one hit on its piece alone, offline (no audio device, no bus), and measures it: level,
/// brightness, the strongest partial, how long it rings, what the contact did, the glide of a
/// drum's pitch and the snare wires' landings.
#[op2]
#[serde]
pub fn op_matter_render_analyze(#[serde] config: MatterHitConfig, seconds: f64) -> Json {
    analyze_hit(&config, seconds)
}

/// What `op_matter_render_analyze` answers.
pub fn analyze_hit(config: &MatterHitConfig, seconds: f64) -> Json {
    let hit = match config.hit() {
        Ok(h) => h,
        Err(e) => return err(e),
    };
    let secs = if seconds > 0.0 { seconds as f32 } else if hit.piece.is_cymbal() { 3.0 } else { 1.5 }.clamp(0.2, 10.0);
    let spec = config.kit.to_spec();
    let sr = crate::audio::analysis::ENGINE_SAMPLE_RATE as f32;
    let mut body = kit::Body::build(&spec, hit.piece, sr);
    body.strike(hit.strike);
    let mut x = Vec::with_capacity((secs * sr) as usize);
    let mut glide: f32 = 0.0;
    for _ in 0..(secs * sr) as usize {
        x.push(body.next_sample() * kit::KIT_GAIN);
        if let kit::Body::Drum(d) = &body {
            glide = glide.max(1200.0 * d.head_body(0).map_or(1.0, |b| b.scale()).log2());
        }
    }
    let peak = x.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    if peak < 1.0e-7 {
        return err("the hit did not sound");
    }
    let db = |v: f32| 20.0 * v.max(1.0e-9).log10();
    let rms = (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt();
    // The first 150 ms: the attack and the body of the sound.
    let head = &x[..((0.15 * sr) as usize).min(x.len())];
    let (mags, bin) = spectrum(head, sr);
    let power: f32 = mags.iter().map(|m| m * m).sum::<f32>().max(1.0e-30);
    let centroid = mags.iter().enumerate().map(|(i, m)| i as f32 * bin * m * m).sum::<f32>() / power;
    // The crack: how much of the attack's energy is above 4 kHz, dB.
    let above = mags.iter().enumerate().filter(|(i, _)| *i as f32 * bin >= 4000.0).map(|(_, m)| m * m).sum::<f32>();
    let strongest = mags.iter().enumerate().skip((30.0 / bin) as usize).max_by(|a, b| a.1.total_cmp(b.1)).map(|(i, _)| i as f32 * bin).unwrap_or(0.0);
    // How long it takes to fall 40 dB below its peak (10 ms windows).
    let win = (0.01 * sr) as usize;
    let env: Vec<f32> = x.chunks(win).map(|c| c.iter().fold(0.0f32, |m, v| m.max(v.abs()))).collect();
    let decay = env.iter().rposition(|e| *e > peak * 0.01).map(|i| (i + 1) as f32 * 0.01).unwrap_or(0.0);
    let r = body.report();
    let mut out = json!({
        "ok": true,
        "piece": hit.piece.name(),
        "striker": kit::striker_name(&hit.strike.striker),
        "speed": hit.strike.velocity,
        "position": hit.strike.position,
        "seconds": secs,
        "peakDb": db(peak),
        "rmsDb": db(rms),
        "centroidHz": centroid,
        "above4kDb": 10.0 * (above / power).max(1.0e-12).log10(),
        "strongestHz": strongest,
        "decaySeconds": decay,
        "contactMs": r.contact_samples as f32 / sr * 1000.0,
        "peakForceN": r.peak_force,
        "reboundSpeed": r.speed_out,
    });
    match &body {
        kit::Body::Drum(d) => {
            out["glideCents"] = json!(glide);
            if hit.piece == Piece::Snare {
                out["wireLandings"] = json!(d.wire_landings());
            }
        }
        kit::Body::Cymbal(_) => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hear(piece: &str, speed: f32, extra: impl FnOnce(&mut MatterHitConfig)) -> Json {
        let mut c = MatterHitConfig { piece: Some(piece.into()), speed: Some(speed), ..Default::default() };
        extra(&mut c);
        analyze_hit(&c, 0.0)
    }

    #[test]
    fn hearing_a_hit_measures_what_the_model_does() {
        let soft = hear("snare", 1.0, |_| {});
        let hard = hear("snare", 5.0, |_| {});
        assert_eq!(hard["ok"], true, "{hard}");
        assert!(hard["peakDb"].as_f64().unwrap() > soft["peakDb"].as_f64().unwrap() + 6.0, "{soft} {hard}");
        // Felt stiffens as it is squeezed: a felt beater brightens when played harder (a stick's
        // contact on a head is set by the head's give, and barely changes).
        let (felt_soft, felt_hard) = (hear("kick", 1.0, |_| {}), hear("kick", 5.0, |_| {}));
        assert!(felt_hard["centroidHz"].as_f64().unwrap() > felt_soft["centroidHz"].as_f64().unwrap(), "{felt_soft} {felt_hard}");
        assert!(hard["wireLandings"].as_u64().unwrap() > 0);
        assert!(hard["contactMs"].as_f64().unwrap() > 0.5);
        let off = hear("snare", 5.0, |c| c.kit.snares = Some(false));
        assert_eq!(off["wireLandings"].as_u64(), Some(0));
        // A slack floor tom hit hard glides.
        let tom = hear("floor-tom", 7.0, |c| c.kit.floor_tom = Some(65.0));
        assert!(tom["glideCents"].as_f64().unwrap() > 20.0, "{tom}");
        // A felt beater is darker than plastic.
        let felt = hear("kick", 4.0, |c| c.striker = Some("felt".into()));
        let plastic = hear("kick", 4.0, |c| c.striker = Some("plastic".into()));
        assert!(plastic["above4kDb"].as_f64().unwrap() > felt["above4kDb"].as_f64().unwrap() + 6.0, "{felt} {plastic}");
        assert_eq!(plastic["striker"], "plastic");
        let crash = hear("crash", 4.0, |_| {});
        assert!(crash["decaySeconds"].as_f64().unwrap() > 1.0, "{crash}");
        assert_eq!(hear("cowbell", 1.0, |_| {})["ok"], false);
        assert_eq!(hear("snare", 1.0, |c| c.striker = Some("spoon".into()))["ok"], false);
    }

    #[test]
    fn a_hit_config_is_clamped_and_becomes_an_offline_event() {
        let c = MatterHitConfig { track_id: Some("t".into()), piece: Some("ride".into()), speed: Some(99.0), position: Some(3.0), kit: MatterKitConfig { snare: Some(1.0e6), ..Default::default() }, mix: Some([("kick".to_string(), 50.0)].into_iter().collect()), start_time: Some(1.5), ..Default::default() };
        let e = c.to_event().unwrap();
        assert_eq!(e.kit, "t");
        assert_eq!(e.start_time, 1.5);
        assert_eq!(e.hit.piece, Piece::Ride);
        assert!(e.hit.strike.velocity <= 25.0 && e.hit.strike.position <= 1.0);
        assert_eq!(e.spec.snare, 360.0);
        assert_eq!(e.mix[Piece::Kick.index()], 8.0);
        assert_eq!(e.mix[Piece::Snare.index()], 1.0);
    }
}
