//! Grand piano physical modeling engine managing the 88-key harp,
//! felt hammers, spruce soundboard, pedals, and sympathetic resonance.
//!
//! ### Architecture
//! * **Compass**: 88 keys (A0 to C8) with stretched Railsback tuning.
//! * **Unisons**: Bass singlets (1 string), tenor bichords (2 strings), treble trichords (3 strings).
//! * **Oversampling**: 2x oversampling with half-band decimation for anti-aliased hammer dynamics.
//! * **Soundboard & Bridge Coupling**: Soundboard modal bank driven by summed bridge forces,
//!   with bridge velocity feedback mediating full-harp sympathetic resonance.
//! * **Pedals**: Sustain pedal (lifts all 88 dampers), una corda (soft hammer felt shift), sostenuto.
//! * **Quality Tiers**: Draft, Live, Render.

use crate::audio::physmod::dsp::Decimator2;
use crate::audio::quality::Quality;
use super::hammer::{Hammer, HammerSpec};
use super::pedal::PedalState;
use super::soundboard::Soundboard;
use super::string::PianoUnison;

pub const KEY_COUNT: usize = 88;
const SLEEP_THRESHOLD: f32 = 1.0e-7;

/// Grand piano voicing presets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PianoPreset {
    ConcertGrand,
    StudioGrand,
    BrightGrand,
    WarmGrand,
}

impl PianoPreset {
    pub fn from_name(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "concert" | "concertgrand" | "concert_grand" => Some(Self::ConcertGrand),
            "studio" | "studiogrand" | "studio_grand" => Some(Self::StudioGrand),
            "bright" | "brightgrand" | "bright_grand" => Some(Self::BrightGrand),
            "warm" | "warmgrand" | "warm_grand" => Some(Self::WarmGrand),
            _ => None,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::ConcertGrand => "Concert Grand",
            Self::StudioGrand => "Studio Grand",
            Self::BrightGrand => "Bright Grand",
            Self::WarmGrand => "Warm Grand",
        }
    }
}

/// Grand piano physical and acoustic parameters.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PianoParams {
    /// Note frequency if triggering a specific pitch (Hz).
    pub freq: f32,
    /// Note strike velocity 0.0..1.0.
    pub velocity: f32,
    /// Master gain 0.0..4.0.
    pub gain: f32,
    /// Note duration (s).
    pub duration: f32,
    /// Sustain pedal (0.0 = released, 1.0 = fully depressed).
    pub sustain_pedal: f32,
    /// Una corda pedal (0.0 = normal, 1.0 = soft pedal).
    pub una_corda: f32,
    /// Preset voicing.
    pub preset: PianoPreset,
    /// Soundboard resonance scaling 0.0..2.0.
    pub soundboard_resonance: f32,
    /// Sympathetic resonance coupling 0.0..2.0.
    pub sympathetic_coupling: f32,
    /// Hammer felt hardness modifier 0.5..1.5.
    pub hammer_hardness: f32,
    /// String inharmonicity modifier 0.0..2.0.
    pub inharmonicity_scale: f32,
    /// Quality tier.
    pub quality: Quality,
}

impl Default for PianoParams {
    fn default() -> Self {
        Self {
            freq: 440.0,
            velocity: 0.75,
            gain: 1.0,
            duration: 2.0,
            sustain_pedal: 0.0,
            una_corda: 0.0,
            preset: PianoPreset::ConcertGrand,
            soundboard_resonance: 1.0,
            sympathetic_coupling: 1.0,
            hammer_hardness: 1.0,
            inharmonicity_scale: 1.0,
            quality: Quality::Live,
        }
    }
}

/// Calculates stretched Railsback tuning for key index 0..87 (A0 to C8).
pub fn railsback_frequency(key: usize) -> f32 {
    let k = key.min(87) as f32;
    // Semitones relative to A4 (key 48 = 440 Hz)
    let semitones = k - 48.0;
    // Cubic stretch curve matching acoustic grand piano measurements:
    // ~ -28 cents at A0, 0 at A4, ~ +32 cents at C8.
    let stretch_cents = if semitones < 0.0 { 28.0 * (semitones / 48.0).powi(3) } else { 32.0 * (semitones / 39.0).powi(3) };
    440.0 * 2.0f32.powf((semitones + stretch_cents / 100.0) / 12.0)
}

/// Converts frequency (Hz) to the closest 88-key piano key index (0..87).
pub fn freq_to_key(freq: f32) -> usize {
    if freq <= 27.5 {
        return 0;
    }
    if freq >= 4186.0 {
        return 87;
    }
    let semitones_from_a4 = 12.0 * (freq / 440.0).log2();
    let key = (48.0 + semitones_from_a4).round() as isize;
    key.clamp(0, 87) as usize
}

/// A single key on the grand piano keyboard.
pub struct PianoKey {
    pub key_index: usize,
    pub nominal_freq: f32,
    pub hammer: Hammer,
    pub unison: PianoUnison,
    pub key_down: bool,
    pub sostenuto_held: bool,
    /// Pan coordinate on the soundboard (-0.5 = bass, +0.5 = treble).
    pub pan: f32,
}

impl PianoKey {
    pub fn new(key: usize, quality: Quality, sr: f32) -> Self {
        let nominal_freq = railsback_frequency(key);
        let hammer_spec = HammerSpec::for_key(key);
        let hammer = Hammer::new(hammer_spec);

        // Unison count based on register and quality tier
        let unisons = match quality {
            Quality::Draft => 1,
            Quality::Live | Quality::Render => {
                if key < 15 {
                    1 // Bass singlets (wound)
                } else if key < 31 {
                    2 // Tenor bichords
                } else {
                    3 // Treble trichords
                }
            }
        };

        let unison = PianoUnison::new(key, nominal_freq, unisons, hammer_spec.strike_ratio, sr);
        let pan = (key as f32 / 87.0) - 0.5;

        Self {
            key_index: key,
            nominal_freq,
            hammer,
            unison,
            key_down: false,
            sostenuto_held: false,
            pan,
        }
    }

    pub fn strike(&mut self, velocity: f32, una_corda: f32) {
        self.key_down = true;
        self.hammer.strike(velocity, una_corda);
        self.unison.set_damper(false);
    }

    pub fn release(&mut self, sustain_active: bool) {
        self.key_down = false;
        if !sustain_active && !self.sostenuto_held {
            self.unison.set_damper(true);
        }
    }

    pub fn update_damper(&mut self, sustain_active: bool) {
        if self.key_down || sustain_active || self.sostenuto_held {
            self.unison.set_damper(false);
        } else {
            self.unison.set_damper(true);
        }
    }

    pub fn is_active(&self) -> bool {
        self.key_down
            || self.hammer.state == super::hammer::HammerState::InContact
            || self.unison.energy > SLEEP_THRESHOLD
    }
}

/// The complete grand piano physical simulation engine.
pub struct PianoEngine {
    pub keys: Vec<PianoKey>,
    pub soundboard: Soundboard,
    pub pedals: PedalState,
    pub params: PianoParams,
    /// 2x oversampling sample rate.
    sim_sr: f32,
    /// Engine sample rate (44.1 kHz).
    out_sr: f32,
    decimator_l: Decimator2,
    decimator_r: Decimator2,
    /// Active key tracking for efficient rendering.
    active_keys: Vec<usize>,
}

impl PianoEngine {
    pub fn new(sr: f32, params: &PianoParams) -> Self {
        // Run physics simulation at 2x oversampling for clean, non-aliasing hammer collision
        let sim_sr = sr * 2.0;
        let mut keys = Vec::with_capacity(KEY_COUNT);
        for k in 0..KEY_COUNT {
            let mut key = PianoKey::new(k, params.quality, sim_sr);
            let (hardness, decay) = match params.preset {
                PianoPreset::ConcertGrand => (1.0,1.0), PianoPreset::StudioGrand => (1.1,0.75),
                PianoPreset::BrightGrand => (1.35,0.9), PianoPreset::WarmGrand => (0.75,1.15),
            };
            key.hammer.spec.stiffness *= hardness * params.hammer_hardness;
            key.unison = PianoUnison::configured(k,key.nominal_freq,key.unison.strings.len(),key.hammer.spec.strike_ratio,sim_sr,params.inharmonicity_scale,decay);
            key.unison.set_damper_amount(1.0-params.sustain_pedal);
            keys.push(key);
        }

        let mut soundboard = Soundboard::new(params.quality, sim_sr);
        soundboard.resonance_scale = params.soundboard_resonance * (1.0 + 0.15 * params.sustain_pedal);

        Self {
            keys,
            soundboard,
            pedals: PedalState {
                sustain: params.sustain_pedal,
                una_corda: params.una_corda,
                sostenuto: 0.0,
            },
            params: *params,
            sim_sr,
            out_sr: sr,
            decimator_l: Decimator2::new(),
            decimator_r: Decimator2::new(),
            active_keys: Vec::with_capacity(KEY_COUNT),
        }
    }

    pub fn set_quality(&mut self, quality: Quality) {
        if self.params.quality != quality {
            self.params.quality = quality;
            self.soundboard.set_quality(quality);
            for k in 0..KEY_COUNT {
                self.keys[k] = PianoKey::new(k, quality, self.sim_sr);
            }
        }
    }

    pub fn set_sustain_pedal(&mut self, sustain: f32) {
        self.pedals.sustain = sustain.clamp(0.0, 1.0);
        for key in &mut self.keys {
            key.unison.set_damper_amount(if key.key_down {0.0} else {(1.0-self.pedals.sustain).powi(2)});
        }
        self.soundboard.resonance_scale = self.params.soundboard_resonance * (1.0 + 0.15 * self.pedals.sustain);
    }

    pub fn set_una_corda(&mut self, una_corda: f32) {
        self.pedals.una_corda = una_corda.clamp(0.0, 1.0);
    }

    pub fn note_on(&mut self, freq: f32, velocity: f32) {
        if !freq.is_finite() || !velocity.is_finite() || velocity <= 0.0 { return; }
        let key_idx = freq_to_key(freq);
        let key = &mut self.keys[key_idx];
        key.strike(velocity, self.pedals.una_corda);
    }

    pub fn note_off(&mut self, freq: f32) {
        let key_idx = freq_to_key(freq);
        let sustain_active = self.pedals.is_sustain_active();
        self.keys[key_idx].release(sustain_active);
        self.keys[key_idx].unison.set_damper_amount((1.0-self.pedals.sustain).powi(2));
    }

    pub fn all_notes_off(&mut self) {
        let sustain_active = self.pedals.is_sustain_active();
        for key in &mut self.keys {
            key.release(sustain_active);
        }
    }

    pub fn clear(&mut self) {
        for key in &mut self.keys {
            key.hammer.reset();
            key.unison.clear();
            key.key_down = false;
        }
        self.soundboard.clear();
        self.decimator_l = Decimator2::new();
        self.decimator_r = Decimator2::new();
        self.active_keys.clear();
    }

    pub fn is_silent(&self) -> bool {
        !self.keys.iter().any(|k| k.is_active())
    }

    /// Steps one internal simulation sample at 2x sample rate.
    fn step_sim(&mut self) -> [f32; 2] {
        let dt = 1.0 / self.sim_sr;
        let v_bridge = self.soundboard.bridge_velocity * self.params.sympathetic_coupling;
        let mut total_bridge_force = 0.0;
        let mut weighted_pan_num = 0.0;
        let mut weighted_pan_denom = 0.0;

        // Gather active keys
        self.active_keys.clear();
        let sustain_down = self.pedals.is_sustain_active();

        for i in 0..KEY_COUNT {
            let k = &self.keys[i];
            // Step keys that are active, or undamped keys when sustain pedal is down (sympathetic resonance)
            if k.is_active() || (sustain_down && self.params.quality != Quality::Draft) {
                self.active_keys.push(i);
            }
        }

        for &i in &self.active_keys {
            let key = &mut self.keys[i];
            let (free_string, compliance) = if key.hammer.state==super::hammer::HammerState::InContact {key.unison.predict()} else {(0.0,0.0)};
            let hammer_force = key.hammer.step_coupled(free_string, compliance, dt);
            let bridge_force = key.unison.step(hammer_force, v_bridge, dt);

            total_bridge_force += bridge_force;
            let abs_f = bridge_force.abs();
            weighted_pan_num += key.pan * abs_f;
            weighted_pan_denom += abs_f;
        }

        let mean_pan = if weighted_pan_denom > 1.0e-5 {
            weighted_pan_num / weighted_pan_denom
        } else {
            0.0
        };

        self.soundboard.step(total_bridge_force, mean_pan)
    }

    /// Generates the next stereo frame at engine sample rate (44.1 kHz).
    pub fn next_frame(&mut self) -> [f32; 2] {
        // Run two steps of 2x oversampled physics simulation
        let [l0, r0] = self.step_sim();
        let [l1, r1] = self.step_sim();

        // Decimate back to engine sample rate
        let out_l = self.decimator_l.process(l0, l1) * self.params.gain;
        let out_r = self.decimator_r.process(r0, r1) * self.params.gain;

        [out_l, out_r]
    }
}
