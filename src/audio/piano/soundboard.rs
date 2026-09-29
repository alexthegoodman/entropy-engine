//! Spruce soundboard plate and bridge admittance model for the grand piano.
//!
//! ### Physics
//! A grand piano soundboard is an anisotropic spruce plate reinforced with ribs and crowned
//! with a curved bridge. Strings have minuscule surface area and cannot radiate sound directly to air;
//! their force drives the bridge, which excites the vibrating modes of the soundboard.
//!
//! 1. **Modal Radiator**: 2D plate modes from low wood cabinet resonances (~55 Hz) up to dense
//!    overlapping high-frequency modes (~8 kHz).
//! 2. **Bridge Velocity Feedback**: The bridge velocity `v_bridge = sum(mode velocities)` pushes back
//!    onto all strings, mediating inter-string sympathetic resonance across the harp.
//! 3. **Spatial Radiation**: Bass strings on the left bridge pan slightly left; treble strings on
//!    the long bridge pan right, creating an immersive, natural concert grand stereo field.

use crate::audio::physmod::dsp::Resonator;
use crate::audio::quality::Quality;

pub const DRAFT_MODES: usize = 16;
pub const LIVE_MODES: usize = 48;
pub const RENDER_MODES: usize = 128;

/// A single mode of the spruce soundboard plate.
#[derive(Clone, Copy, Debug)]
pub struct SoundboardMode {
    pub freq: f32,
    pub q: f32,
    /// Coupling weight from the bridge.
    pub bridge_coupling: f32,
    /// Left channel radiation gain.
    pub pan_l: f32,
    /// Right channel radiation gain.
    pub pan_r: f32,
    /// Current modal energy.
    pub energy: f32,
}

/// The grand piano soundboard with bridge admittance and stereo radiation.
pub struct Soundboard {
    pub quality: Quality,
    pub modes: Vec<SoundboardMode>,
    resonators: Vec<Resonator>,
    /// Running bridge velocity fed back into the strings.
    pub bridge_velocity: f32,
    /// Output sample rate.
    sr: f32,
    /// Overall soundboard resonance / warmth scaling.
    pub resonance_scale: f32,
}

impl Soundboard {
    pub fn new(quality: Quality, sr: f32) -> Self {
        let mode_count = match quality {
            Quality::Draft => DRAFT_MODES,
            Quality::Live => LIVE_MODES,
            Quality::Render => RENDER_MODES,
        };

        let mut modes = Vec::with_capacity(mode_count);
        let mut resonators = Vec::with_capacity(mode_count);

        // Acoustic spruce soundboard modal distribution:
        // Fundamental plate bending modes in the low register:
        // ~55 Hz (deep cabinet breathing), ~95 Hz, ~135 Hz, ~190 Hz, ~260 Hz, ~340 Hz.
        // Followed by modal density that increases quadratically with frequency.
        let low_freqs = [55.0, 92.0, 138.0, 185.0, 245.0, 315.0, 420.0, 560.0];

        for i in 0..mode_count {
            let freq = if i < low_freqs.len() {
                low_freqs[i]
            } else {
                // Higher modes: smoothly spaced with slight modal irregularity
                let norm = (i - low_freqs.len()) as f32 / (mode_count - low_freqs.len()) as f32;
                650.0 + 7200.0 * norm.powf(1.6) + ((i * 37) % 23) as f32 * 5.0
            };

            // Q factor: low modes have moderate Q (~15 - 30); higher modes have lower Q (~8 - 20) due to radiation damping
            let q = (28.0 - 14.0 * (freq / 8000.0).min(1.0)).max(6.0);

            // Spatial stereo distribution: lower modes centered, higher modes spread across the rim
            let pan = ((i as f32 * 1.618).sin() * 0.45).clamp(-0.8, 0.8);
            let pan_l = ((1.0 - pan) * 0.5).sqrt();
            let pan_r = ((1.0 + pan) * 0.5).sqrt();

            // Bridge coupling: falls off gently with frequency
            let coupling = 1.0 / (1.0 + freq / 2500.0);

            let mut res = Resonator::default();
            res.set(freq, q, sr);

            modes.push(SoundboardMode {
                freq,
                q,
                bridge_coupling: coupling,
                pan_l,
                pan_r,
                energy: 0.0,
            });
            resonators.push(res);
        }

        Self {
            quality,
            modes,
            resonators,
            bridge_velocity: 0.0,
            sr,
            resonance_scale: 1.0,
        }
    }

    pub fn total_energy(&self) -> f32 {
        self.modes.iter().map(|m| m.energy).sum()
    }

    pub fn set_quality(&mut self, quality: Quality) {
        if self.quality != quality {
            *self = Self::new(quality, self.sr);
        }
    }

    pub fn clear(&mut self) {
        for r in &mut self.resonators {
            r.clear();
        }
        for m in &mut self.modes {
            m.energy = 0.0;
        }
        self.bridge_velocity = 0.0;
    }

    /// Steps the soundboard with the summed force from all strings at the bridge.
    /// `key_pan` is the horizontal position of the primary active key (-0.5 = bass, +0.5 = treble).
    /// Returns stereo audio frame `[left, right]`.
    pub fn step(&mut self, total_bridge_force: f32, key_pan: f32) -> [f32; 2] {
        let scaled_force = total_bridge_force * 0.008 * self.resonance_scale * (48.0 / self.modes.len() as f32);
        let mut out_l = 0.0;
        let mut out_r = 0.0;
        let mut v_bridge_sum = 0.0;

        // Position-dependent stereo weighting: bass strings sound more on the left, treble on the right
        let string_pan_l = ((1.0 - key_pan) * 0.5).clamp(0.1, 0.9);
        let string_pan_r = ((1.0 + key_pan) * 0.5).clamp(0.1, 0.9);

        for (mode, res) in self.modes.iter_mut().zip(self.resonators.iter_mut()) {
            let mode_drive = scaled_force * mode.bridge_coupling;
            let v_mode = res.process(mode_drive);
            mode.energy = 0.999 * mode.energy + 0.001 * (v_mode * v_mode);

            v_bridge_sum += v_mode * mode.bridge_coupling;

            let amp = v_mode * 0.15;
            out_l += amp * (mode.pan_l * 0.6 + string_pan_l * 0.4);
            out_r += amp * (mode.pan_r * 0.6 + string_pan_r * 0.4);
        }

        // Bridge velocity feedback scaled for stability (admittance scaling)
        self.bridge_velocity = (v_bridge_sum * 0.02).clamp(-1.0, 1.0);

        // Broadband mobility of the overlapping high modes, plus resolved low-mode colour.
        let direct=total_bridge_force * 0.012;
        [out_l + direct * string_pan_l.sqrt(), out_r + direct * string_pan_r.sqrt()]
    }
}
