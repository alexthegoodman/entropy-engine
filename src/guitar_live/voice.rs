//! A monophonic synth voice for playing the DAW's built-in sound from the guitar. The existing note
//! path (`AudioEngine::play_note_on_track`) renders a note of a fixed length, decided when it is
//! triggered. A guitar note has no length until the string stops, and it bends, so this is a
//! long-lived source that holds a note until told to release it and follows a pitch bend
//! continuously.
//!
//! The router writes a handful of atomics; the audio thread reads them. Nothing here locks.

use crate::audio::analysis::ENGINE_SAMPLE_RATE;
use rodio::Source;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Waveform {
    Sine,
    Triangle,
    #[default]
    Saw,
    Square,
}

impl Waveform {
    pub fn from_name(name: &str) -> Option<Waveform> {
        match name.to_ascii_lowercase().as_str() {
            "sine" => Some(Waveform::Sine),
            "triangle" => Some(Waveform::Triangle),
            "saw" => Some(Waveform::Saw),
            "square" => Some(Waveform::Square),
            _ => None,
        }
    }

    fn index(self) -> u32 {
        self as u32
    }

    fn from_index(i: u32) -> Waveform {
        match i {
            0 => Waveform::Sine,
            1 => Waveform::Triangle,
            2 => Waveform::Saw,
            _ => Waveform::Square,
        }
    }
}

/// Control surface shared between the router (writer) and the audio thread (reader).
pub struct VoiceControl {
    /// Bumped on every Note On, so a quick Off and On that the audio thread never saw between two
    /// blocks still restarts the note.
    trigger: AtomicU32,
    gate: AtomicBool,
    hz_bits: AtomicU32,
    bend_cents_bits: AtomicU32,
    velocity: AtomicU32,
    waveform: AtomicU32,
    gain_bits: AtomicU32,
    alive: AtomicBool,
    /// Frames rendered, so a test can tell the voice is really being pulled by an output.
    rendered: AtomicU64,
}

impl VoiceControl {
    pub fn new() -> Arc<VoiceControl> {
        Arc::new(VoiceControl {
            trigger: AtomicU32::new(0),
            gate: AtomicBool::new(false),
            hz_bits: AtomicU32::new(440.0f32.to_bits()),
            bend_cents_bits: AtomicU32::new(0.0f32.to_bits()),
            velocity: AtomicU32::new(100),
            waveform: AtomicU32::new(Waveform::Saw.index()),
            gain_bits: AtomicU32::new(0.3f32.to_bits()),
            alive: AtomicBool::new(true),
            rendered: AtomicU64::new(0),
        })
    }

    pub fn note_on(&self, hz: f32, velocity: u8) {
        self.hz_bits.store(hz.to_bits(), Ordering::Relaxed);
        self.velocity.store(velocity as u32, Ordering::Relaxed);
        self.gate.store(true, Ordering::Relaxed);
        self.trigger.fetch_add(1, Ordering::Release);
    }

    pub fn note_off(&self) {
        self.gate.store(false, Ordering::Release);
    }

    pub fn set_bend_cents(&self, cents: f32) {
        self.bend_cents_bits.store(cents.to_bits(), Ordering::Relaxed);
    }

    pub fn set_waveform(&self, w: Waveform) {
        self.waveform.store(w.index(), Ordering::Relaxed);
    }

    pub fn set_gain(&self, gain: f32) {
        self.gain_bits.store(gain.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    /// Ends the source, which lets the mixer drop it.
    pub fn stop(&self) {
        self.gate.store(false, Ordering::Relaxed);
        self.alive.store(false, Ordering::Release);
    }

    pub fn is_gated(&self) -> bool {
        self.gate.load(Ordering::Relaxed)
    }

    pub fn frames_rendered(&self) -> u64 {
        self.rendered.load(Ordering::Relaxed)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Idle,
    Attack,
    Hold,
    Release,
}

/// Attack time, seconds. Short enough not to blunt a pick, long enough not to click.
const ATTACK_S: f32 = 0.003;
/// Release time constant, seconds.
const RELEASE_S: f32 = 0.06;
/// Pitch follows the target with this time constant, seconds, so a bend is smooth and a step is not a click.
const GLIDE_S: f32 = 0.0015;

pub struct GuitarVoice {
    ctl: Arc<VoiceControl>,
    sample_rate: f32,
    last_trigger: u32,
    stage: Stage,
    env: f32,
    phase: f32,
    freq: f32,
    target_hz: f32,
    amp: f32,
    lp: f32,
    lp_coef: f32,
    attack_step: f32,
    release_coef: f32,
    glide_coef: f32,
    buf: f32,
    idx: u8,
}

impl GuitarVoice {
    pub fn new(ctl: Arc<VoiceControl>) -> Self {
        let sr = ENGINE_SAMPLE_RATE as f32;
        GuitarVoice {
            last_trigger: ctl.trigger.load(Ordering::Acquire),
            ctl,
            sample_rate: sr,
            stage: Stage::Idle,
            env: 0.0,
            phase: 0.0,
            freq: 440.0,
            target_hz: 440.0,
            amp: 0.0,
            lp: 0.0,
            lp_coef: 1.0,
            attack_step: 1.0 / (ATTACK_S * sr),
            release_coef: (-1.0 / (RELEASE_S * sr)).exp(),
            glide_coef: 1.0 - (-1.0 / (GLIDE_S * sr)).exp(),
            buf: 0.0,
            idx: 0,
        }
    }

    /// Band-limited step for saw and square (PolyBLEP), so a high note does not alias into a wrong pitch.
    fn poly_blep(t: f32, dt: f32) -> f32 {
        if t < dt {
            let x = t / dt;
            x + x - x * x - 1.0
        } else if t > 1.0 - dt {
            let x = (t - 1.0) / dt;
            x * x + x + x + 1.0
        } else {
            0.0
        }
    }

    fn oscillator(&self, wave: Waveform, dt: f32) -> f32 {
        let t = self.phase;
        match wave {
            Waveform::Sine => (t * std::f32::consts::TAU).sin(),
            Waveform::Triangle => 4.0 * (t - 0.5).abs() - 1.0,
            Waveform::Saw => 2.0 * t - 1.0 - Self::poly_blep(t, dt),
            Waveform::Square => {
                let naive = if t < 0.5 { 1.0 } else { -1.0 };
                naive + Self::poly_blep(t, dt) - Self::poly_blep((t + 0.5).fract(), dt)
            }
        }
    }

    fn frame(&mut self) -> f32 {
        let trigger = self.ctl.trigger.load(Ordering::Acquire);
        if trigger != self.last_trigger {
            self.last_trigger = trigger;
            self.target_hz = f32::from_bits(self.ctl.hz_bits.load(Ordering::Relaxed)).clamp(16.0, 8000.0);
            let vel = self.ctl.velocity.load(Ordering::Relaxed).clamp(1, 127) as f32 / 127.0;
            self.amp = 0.12 + 0.88 * vel.powf(1.4);
            // Brighter when picked harder: the cutoff, as a one-pole coefficient.
            let cutoff = 500.0 + 9000.0 * vel * vel;
            self.lp_coef = 1.0 - (-std::f32::consts::TAU * cutoff / self.sample_rate).exp();
            if self.stage == Stage::Idle {
                // Nothing to glide from: start on pitch.
                self.freq = self.target_hz * self.bend_ratio();
                self.phase = 0.0;
            }
            self.stage = Stage::Attack;
        }
        let gate = self.ctl.gate.load(Ordering::Acquire);
        if !gate && matches!(self.stage, Stage::Attack | Stage::Hold) {
            self.stage = Stage::Release;
        }

        match self.stage {
            Stage::Idle => return 0.0,
            Stage::Attack => {
                self.env += self.attack_step;
                if self.env >= 1.0 {
                    self.env = 1.0;
                    self.stage = Stage::Hold;
                }
            }
            Stage::Hold => {}
            Stage::Release => {
                self.env *= self.release_coef;
                if self.env < 1e-4 {
                    self.env = 0.0;
                    self.stage = Stage::Idle;
                    return 0.0;
                }
            }
        }

        let goal = self.target_hz * self.bend_ratio();
        self.freq += (goal - self.freq) * self.glide_coef;
        let dt = (self.freq / self.sample_rate).min(0.45);
        let wave = Waveform::from_index(self.ctl.waveform.load(Ordering::Relaxed));
        let raw = self.oscillator(wave, dt);
        self.phase += dt;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
        let filtered = if wave == Waveform::Sine {
            raw
        } else {
            self.lp += self.lp_coef * (raw - self.lp);
            self.lp
        };
        let gain = f32::from_bits(self.ctl.gain_bits.load(Ordering::Relaxed));
        filtered * self.env * self.amp * gain
    }

    fn bend_ratio(&self) -> f32 {
        (f32::from_bits(self.ctl.bend_cents_bits.load(Ordering::Relaxed)) / 1200.0).exp2()
    }
}

impl Iterator for GuitarVoice {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if !self.ctl.alive.load(Ordering::Relaxed) {
            return None;
        }
        // Two interleaved channels, the same sample.
        if self.idx == 0 {
            self.buf = self.frame();
            self.ctl.rendered.fetch_add(1, Ordering::Relaxed);
        }
        self.idx = (self.idx + 1) % 2;
        Some(self.buf)
    }
}

impl Source for GuitarVoice {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> u16 {
        2
    }
    fn sample_rate(&self) -> u32 {
        ENGINE_SAMPLE_RATE
    }
    fn total_duration(&self) -> Option<std::time::Duration> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guitar::config::Algorithm;
    use crate::guitar::pitch::{PitchDetector, TierDetector};
    use realfft::RealFftPlanner;

    /// Renders `frames` mono frames from the voice.
    fn render(v: &mut GuitarVoice, frames: usize) -> Vec<f32> {
        (0..frames).map(|_| {
            let l = v.next().unwrap();
            let _ = v.next();
            l
        }).collect()
    }

    fn read_hz(x: &[f32]) -> f32 {
        let mut d = TierDetector::new(&mut RealFftPlanner::new(), Algorithm::Yin, ENGINE_SAMPLE_RATE as f32, 70.0, 1400.0, 1.0, 0);
        d.estimate(x).expect("a pitch").freq_hz
    }

    fn cents(a: f32, b: f32) -> f32 {
        1200.0 * (a / b).log2()
    }

    #[test]
    fn it_plays_the_pitch_it_is_told_in_every_waveform() {
        for wave in [Waveform::Sine, Waveform::Triangle, Waveform::Saw, Waveform::Square] {
            let ctl = VoiceControl::new();
            ctl.set_waveform(wave);
            let mut v = GuitarVoice::new(ctl.clone());
            ctl.note_on(220.0, 100);
            let x = render(&mut v, 12_000);
            let hz = read_hz(&x[6000..]);
            assert!(cents(hz, 220.0).abs() < 3.0, "{wave:?} read {hz} Hz");
        }
    }

    #[test]
    fn a_bend_moves_the_pitch_smoothly_and_settles_on_the_target() {
        let ctl = VoiceControl::new();
        ctl.set_waveform(Waveform::Sine);
        let mut v = GuitarVoice::new(ctl.clone());
        ctl.note_on(220.0, 100);
        render(&mut v, 6000);
        ctl.set_bend_cents(200.0);
        let x = render(&mut v, 8000);
        let hz = read_hz(&x[4000..]);
        let want = 220.0 * 2f32.powf(200.0 / 1200.0);
        assert!(cents(hz, want).abs() < 5.0, "settled at {hz} Hz, wanted {want}");
    }

    #[test]
    fn a_note_off_releases_to_silence_and_the_voice_goes_idle() {
        let ctl = VoiceControl::new();
        let mut v = GuitarVoice::new(ctl.clone());
        ctl.note_on(330.0, 100);
        render(&mut v, 4000);
        ctl.note_off();
        let x = render(&mut v, ENGINE_SAMPLE_RATE as usize / 2);
        let tail = x[x.len() - 2000..].iter().fold(0.0f32, |a, &b| a.max(b.abs()));
        assert!(tail < 1e-3, "still sounding after release: {tail}");
        assert!(x[..200].iter().any(|s| s.abs() > 0.001), "released instantly instead of decaying");
    }

    #[test]
    fn harder_notes_are_louder() {
        let level = |vel: u8| {
            let ctl = VoiceControl::new();
            let mut v = GuitarVoice::new(ctl.clone());
            ctl.note_on(220.0, vel);
            let x = render(&mut v, 6000);
            x[3000..].iter().fold(0.0f32, |a, &b| a.max(b.abs()))
        };
        let (soft, hard) = (level(20), level(120));
        assert!(hard > soft * 2.0, "soft {soft} hard {hard}");
    }

    #[test]
    fn an_off_and_on_between_two_reads_still_restarts_the_note() {
        let ctl = VoiceControl::new();
        let mut v = GuitarVoice::new(ctl.clone());
        ctl.note_on(220.0, 100);
        render(&mut v, 4000);
        // The audio thread never sees the gate low: both happen between two blocks.
        ctl.note_off();
        ctl.note_on(330.0, 100);
        let x = render(&mut v, 8000);
        let hz = read_hz(&x[4000..]);
        assert!(cents(hz, 330.0).abs() < 4.0, "read {hz} Hz, the new note was lost");
    }

    #[test]
    fn a_stopped_control_ends_the_source() {
        let ctl = VoiceControl::new();
        let mut v = GuitarVoice::new(ctl.clone());
        assert!(v.next().is_some());
        ctl.stop();
        assert!(v.next().is_none());
    }

    #[test]
    fn an_idle_voice_is_silent() {
        let mut v = GuitarVoice::new(VoiceControl::new());
        assert!(render(&mut v, 1000).iter().all(|&s| s == 0.0));
    }
}
