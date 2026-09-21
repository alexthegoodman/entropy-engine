//! The guitar playing a wavetable. Like `GuitarVoice` this is one long-lived source on a track's bus:
//! the router writes a handful of atomics (trigger, gate, pitch, bend, velocity, position) and the
//! audio thread reads them, so a pick reaches the sound with no allocation and no lock, and a note that
//! is already sounding follows a bend continuously.
//!
//! What it borrows from `WavetableVoice` is the sound: the same table read (cubic, band-limited to the
//! pitch, blended between frames), the same position rule (rest position + LFO + decaying sweep +
//! velocity), unison with detune and spread, the same lowpass and ADSR. What it adds is what a string
//! needs and a timed note does not: it holds until the gate drops, retriggers without restarting the
//! envelope, and bends.

use super::voice::{VoiceControl, GLIDE_S};
use crate::audio::analysis::ENGINE_SAMPLE_RATE;
use crate::audio::wavetable::{filter_coefficients, level_for, Svf, WavetableParams, WavetableShared, WavetableVoice, MAX_UNISON};
use rodio::Source;
use std::f32::consts::PI;
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// How often the band limit is looked up again, in frames. The lookup walks the levels, and the pitch
/// moves slowly compared with this.
const LEVEL_EVERY: u32 = 32;
/// How often the editor's glow is updated, in frames (the same as `WavetableVoice`).
const PUBLISH_EVERY: u32 = 256;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

pub struct WavetableGuitarVoice {
    ctl: Arc<VoiceControl>,
    table: Arc<WavetableShared>,
    p: WavetableParams,
    unison: usize,
    /// Each unison voice's pitch as a ratio of the note's, and its share of the left and right channel.
    ratios: [f32; MAX_UNISON],
    top_ratio: f32,
    gl: [f32; MAX_UNISON],
    gr: [f32; MAX_UNISON],
    phases: [f32; MAX_UNISON],
    last_trigger: u32,
    stage: Stage,
    env: f32,
    release_step: f32,
    freq: f32,
    target_hz: f32,
    /// 0..1, from the pick.
    velocity: f32,
    glide_coef: f32,
    lfo_phase: f32,
    /// Frames since the pick, for the sweep.
    samples: u64,
    level: usize,
    level_left: u32,
    filter: [Svf; 2],
    coef: Option<(f32, f32, f32)>,
    block_frames: u32,
    block_energy: f32,
    smoothed: f32,
    buf: [f32; 2],
    idx: u8,
}

fn start_phases() -> [f32; MAX_UNISON] {
    // Spread out so the unison voices do not begin as one loud comb.
    let mut phases = [0.0; MAX_UNISON];
    for (u, p) in phases.iter_mut().enumerate().skip(1) {
        *p = (u as f32 * 0.381_966) % 1.0;
    }
    phases
}

impl WavetableGuitarVoice {
    /// `params` gives the sound (its `freq`, `velocity` and `duration` are ignored: the pick decides
    /// the first two and the gate the last). The table is read live, so sculpting it is heard.
    pub fn new(ctl: Arc<VoiceControl>, table: Arc<WavetableShared>, params: WavetableParams) -> Self {
        let sr = ENGINE_SAMPLE_RATE as f32;
        let unison = (params.unison as usize).clamp(1, MAX_UNISON);
        let detune = params.detune_cents.clamp(0.0, 100.0);
        let norm = 1.0 / (unison as f32).sqrt();
        let (mut ratios, mut gl, mut gr) = ([1.0; MAX_UNISON], [0.0; MAX_UNISON], [0.0; MAX_UNISON]);
        let mut top_ratio = 1.0f32;
        for u in 0..unison {
            let x = if unison == 1 { 0.0 } else { u as f32 / (unison - 1) as f32 * 2.0 - 1.0 };
            ratios[u] = 2f32.powf(x * detune / 1200.0);
            top_ratio = top_ratio.max(ratios[u]);
            let angle = (x * params.spread.clamp(0.0, 1.0) + 1.0) * PI / 4.0;
            gl[u] = angle.cos() * norm;
            gr[u] = angle.sin() * norm;
        }
        ctl.set_position(params.position);
        Self {
            last_trigger: ctl.trigger.load(Ordering::Acquire),
            ctl,
            table,
            p: params,
            unison,
            ratios,
            top_ratio,
            gl,
            gr,
            phases: start_phases(),
            stage: Stage::Idle,
            env: 0.0,
            release_step: 0.0,
            freq: 440.0,
            target_hz: 440.0,
            velocity: 0.8,
            glide_coef: 1.0 - (-1.0 / (GLIDE_S * sr)).exp(),
            lfo_phase: 0.0,
            samples: 0,
            level: 0,
            level_left: 0,
            filter: [Svf::default(); 2],
            coef: filter_coefficients(params.cutoff, params.resonance, sr),
            block_frames: 0,
            block_energy: 0.0,
            smoothed: 0.0,
            buf: [0.0; 2],
            idx: 0,
        }
    }

    fn bend_ratio(&self) -> f32 {
        (f32::from_bits(self.ctl.bend_cents_bits.load(Ordering::Relaxed)) / 1200.0).exp2()
    }

    fn advance_envelope(&mut self, sr: f32) {
        let a = self.p.attack.max(0.001);
        let d = self.p.decay.max(0.001);
        let s = self.p.sustain.clamp(0.0, 1.0);
        match self.stage {
            Stage::Idle | Stage::Sustain => {}
            Stage::Attack => {
                self.env += 1.0 / (a * sr);
                if self.env >= 1.0 {
                    self.env = 1.0;
                    self.stage = Stage::Decay;
                }
            }
            Stage::Decay => {
                self.env -= (1.0 - s) / (d * sr);
                if self.env <= s {
                    self.env = s;
                    self.stage = Stage::Sustain;
                }
            }
            Stage::Release => {
                self.env -= self.release_step;
                if self.env <= 0.0 {
                    self.env = 0.0;
                    self.stage = Stage::Idle;
                    self.table.voice_ended();
                }
            }
        }
    }

    fn frame(&mut self) -> [f32; 2] {
        let sr = ENGINE_SAMPLE_RATE as f32;
        let trigger = self.ctl.trigger.load(Ordering::Acquire);
        if trigger != self.last_trigger {
            self.last_trigger = trigger;
            self.target_hz = f32::from_bits(self.ctl.hz_bits.load(Ordering::Relaxed)).clamp(16.0, 8000.0);
            self.velocity = self.ctl.velocity.load(Ordering::Relaxed).clamp(1, 127) as f32 / 127.0;
            if self.stage == Stage::Idle {
                // Nothing to glide from: start on pitch, from the start of the cycle.
                self.freq = self.target_hz * self.bend_ratio();
                self.phases = start_phases();
                self.lfo_phase = 0.0;
                self.level_left = 0;
                self.table.voice_started();
            }
            self.samples = 0;
            self.stage = Stage::Attack;
        }
        let gate = self.ctl.gate.load(Ordering::Acquire);
        if !gate && matches!(self.stage, Stage::Attack | Stage::Decay | Stage::Sustain) {
            self.stage = Stage::Release;
            self.release_step = self.env / (self.p.release.max(0.005) * sr);
        }
        if self.stage == Stage::Idle {
            return [0.0, 0.0];
        }
        self.advance_envelope(sr);

        let goal = self.target_hz * self.bend_ratio();
        self.freq += (goal - self.freq) * self.glide_coef;
        if self.level_left == 0 {
            self.level = level_for(self.freq * self.top_ratio, sr);
            self.level_left = LEVEL_EVERY;
        }
        self.level_left -= 1;

        let mut p = self.p;
        p.position = f32::from_bits(self.ctl.position_bits.load(Ordering::Relaxed));
        p.velocity = self.velocity;
        let pos = WavetableVoice::position_at(&p, self.samples as f32 / sr, self.lfo_phase);
        self.lfo_phase = (self.lfo_phase + p.lfo_rate.max(0.0) / sr).fract();

        let (mut l, mut r) = (0.0f32, 0.0f32);
        for u in 0..self.unison {
            let s = self.table.read(self.level, pos, self.phases[u]);
            l += s * self.gl[u];
            r += s * self.gr[u];
            self.phases[u] += self.freq * self.ratios[u] / sr;
            if self.phases[u] >= 1.0 {
                self.phases[u] -= 1.0;
            }
        }
        if let Some((a1, a2, a3)) = self.coef {
            l = self.filter[0].lowpass(l, a1, a2, a3);
            r = self.filter[1].lowpass(r, a1, a2, a3);
        }
        let amp = self.env * self.p.gain * (0.25 + 0.75 * self.velocity);
        let out = [l * amp, r * amp];

        self.samples += 1;
        self.block_energy += out[0] * out[0] + out[1] * out[1];
        self.block_frames += 1;
        if self.block_frames >= PUBLISH_EVERY {
            let rms = (self.block_energy / (2.0 * self.block_frames as f32)).sqrt();
            self.smoothed += (rms - self.smoothed) * 0.5;
            self.table.publish_activity(pos, self.smoothed);
            self.block_frames = 0;
            self.block_energy = 0.0;
        }
        out
    }
}

impl Drop for WavetableGuitarVoice {
    fn drop(&mut self) {
        if self.stage != Stage::Idle {
            self.table.voice_ended();
        }
    }
}

impl Iterator for WavetableGuitarVoice {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if !self.ctl.alive.load(Ordering::Relaxed) {
            return None;
        }
        if self.idx == 0 {
            self.buf = self.frame();
            self.ctl.rendered.fetch_add(1, Ordering::Relaxed);
        }
        let v = self.buf[self.idx as usize];
        self.idx = (self.idx + 1) % 2;
        Some(v)
    }
}

impl Source for WavetableGuitarVoice {
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
    use crate::audio::wavetable::Wavetable;
    use crate::guitar::config::Algorithm;
    use crate::guitar::pitch::{PitchDetector, TierDetector};
    use realfft::RealFftPlanner;

    const SR: usize = ENGINE_SAMPLE_RATE as usize;

    fn table(preset: &str) -> (Wavetable, Arc<WavetableShared>) {
        let mut t = Wavetable::new(8);
        assert!(t.load_preset(preset));
        let shared = t.shared();
        (t, shared)
    }

    /// A voice with the envelope out of the way, so a level or a pitch reads cleanly.
    fn params() -> WavetableParams {
        WavetableParams { attack: 0.002, decay: 0.01, sustain: 1.0, release: 0.05, gain: 1.0, ..WavetableParams::default() }
    }

    /// `frames` stereo frames, as (left, right).
    fn render(v: &mut WavetableGuitarVoice, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let mut out = (Vec::with_capacity(frames), Vec::with_capacity(frames));
        for _ in 0..frames {
            out.0.push(v.next().unwrap());
            out.1.push(v.next().unwrap());
        }
        out
    }

    fn read_hz(x: &[f32]) -> f32 {
        let mut d = TierDetector::new(&mut RealFftPlanner::new(), Algorithm::Yin, ENGINE_SAMPLE_RATE as f32, 70.0, 1400.0, 1.0, 0);
        d.estimate(x).expect("a pitch").freq_hz
    }

    fn cents(a: f32, b: f32) -> f32 {
        1200.0 * (a / b).log2()
    }

    /// How much high-frequency detail the wave has: the RMS of its second difference over its RMS.
    /// A sine barely bends between samples; a saw or a square has an edge every cycle.
    fn roughness(x: &[f32]) -> f32 {
        let rms = |it: &mut dyn Iterator<Item = f32>| {
            let (sum, n) = it.fold((0.0f32, 0usize), |(s, n), v| (s + v * v, n + 1));
            (sum / n.max(1) as f32).sqrt()
        };
        let curve = rms(&mut x.windows(3).map(|w| w[2] - 2.0 * w[1] + w[0]));
        curve / rms(&mut x.iter().copied()).max(1e-9)
    }

    #[test]
    fn it_plays_the_pitch_it_is_told_from_a_low_string_to_a_high_one() {
        let (_t, shared) = table("saw");
        for hz in [82.41, 110.0, 146.83, 329.63, 659.26] {
            let ctl = VoiceControl::new();
            let mut v = WavetableGuitarVoice::new(ctl.clone(), shared.clone(), params());
            ctl.note_on(hz, 100);
            let (l, _) = render(&mut v, SR / 2);
            let read = read_hz(&l[SR / 4..]);
            assert!(cents(read, hz).abs() < 5.0, "asked for {hz} Hz, read {read} Hz");
        }
    }

    #[test]
    fn an_idle_voice_is_silent_and_takes_no_part_in_the_editors_glow() {
        let (_t, shared) = table("saw");
        let mut v = WavetableGuitarVoice::new(VoiceControl::new(), shared.clone(), params());
        let (l, r) = render(&mut v, 1000);
        assert!(l.iter().chain(r.iter()).all(|&s| s == 0.0));
        assert_eq!(shared.active_voices(), 0);
    }

    #[test]
    fn a_note_shows_in_the_glow_while_it_sounds_and_not_after_it_ends() {
        let (_t, shared) = table("saw");
        let ctl = VoiceControl::new();
        let mut v = WavetableGuitarVoice::new(ctl.clone(), shared.clone(), params());
        ctl.note_on(220.0, 100);
        render(&mut v, 2000);
        assert_eq!(shared.active_voices(), 1);
        assert!(shared.activity().is_some());
        ctl.note_off();
        render(&mut v, SR / 2);
        assert_eq!(shared.active_voices(), 0, "the released note is still counted");
        // A second note counts again, and a voice dropped mid-note gives its count back.
        ctl.note_on(220.0, 100);
        render(&mut v, 500);
        assert_eq!(shared.active_voices(), 1);
        drop(v);
        assert_eq!(shared.active_voices(), 0);
    }

    #[test]
    fn a_bend_moves_the_pitch_and_settles_on_the_target() {
        let (_t, shared) = table("saw");
        let ctl = VoiceControl::new();
        let mut v = WavetableGuitarVoice::new(ctl.clone(), shared, params());
        ctl.note_on(220.0, 100);
        render(&mut v, 6000);
        ctl.set_bend_cents(200.0);
        let (l, _) = render(&mut v, 9000);
        let want = 220.0 * 2f32.powf(200.0 / 1200.0);
        let hz = read_hz(&l[5000..]);
        assert!(cents(hz, want).abs() < 6.0, "settled at {hz} Hz, wanted {want}");
    }

    #[test]
    fn a_note_off_releases_to_silence() {
        let (_t, shared) = table("saw");
        let ctl = VoiceControl::new();
        let mut v = WavetableGuitarVoice::new(ctl.clone(), shared, params());
        ctl.note_on(330.0, 100);
        render(&mut v, 4000);
        ctl.note_off();
        let (l, _) = render(&mut v, SR / 2);
        let tail = l[l.len() - 2000..].iter().fold(0.0f32, |a, &b| a.max(b.abs()));
        assert!(tail == 0.0, "still sounding after release: {tail}");
        assert!(l[..200].iter().any(|s| s.abs() > 0.001), "released instantly instead of decaying");
    }

    #[test]
    fn harder_picks_are_louder() {
        let (_t, shared) = table("saw");
        let level = |vel: u8| {
            let ctl = VoiceControl::new();
            let mut v = WavetableGuitarVoice::new(ctl.clone(), shared.clone(), params());
            ctl.note_on(220.0, vel);
            let (l, _) = render(&mut v, 6000);
            l[3000..].iter().fold(0.0f32, |a, &b| a.max(b.abs()))
        };
        let (soft, hard) = (level(20), level(120));
        assert!(hard > soft * 2.0, "soft {soft} hard {hard}");
    }

    #[test]
    fn an_off_and_on_between_two_reads_still_restarts_the_note() {
        let (_t, shared) = table("saw");
        let ctl = VoiceControl::new();
        let mut v = WavetableGuitarVoice::new(ctl.clone(), shared, params());
        ctl.note_on(220.0, 100);
        render(&mut v, 4000);
        ctl.note_off();
        ctl.note_on(330.0, 100);
        let (l, _) = render(&mut v, 8000);
        let hz = read_hz(&l[4000..]);
        assert!(cents(hz, 330.0).abs() < 5.0, "read {hz} Hz, the new note was lost");
    }

    #[test]
    fn the_table_position_picks_the_sound_and_moves_while_the_note_holds() {
        // "saw" runs from a sine in the first frame to a saw in the last.
        let (_t, shared) = table("saw");
        let ctl = VoiceControl::new();
        let mut v = WavetableGuitarVoice::new(ctl.clone(), shared, WavetableParams { position: 0.0, ..params() });
        ctl.note_on(146.83, 100);
        let (start, _) = render(&mut v, 8000);
        let sine = roughness(&start[4000..]);
        ctl.set_position(1.0);
        let (later, _) = render(&mut v, 8000);
        let saw = roughness(&later[4000..]);
        assert!(saw > sine * 2.0, "sine end {sine}, saw end {saw}: moving the position did not change the sound");
    }

    #[test]
    fn sculpting_the_table_is_heard_by_a_note_that_is_already_sounding() {
        let (mut t, shared) = table("sine");
        let ctl = VoiceControl::new();
        let mut v = WavetableGuitarVoice::new(ctl.clone(), shared, params());
        ctl.note_on(146.83, 100);
        let (before, _) = render(&mut v, 8000);
        let smooth = roughness(&before[4000..]);
        // Overwrite every frame with a square-ish cycle.
        let square: Vec<f32> = (0..2048).map(|i| if i < 1024 { 0.8 } else { -0.8 }).collect();
        for f in 0..t.frames() {
            t.set_frame(f, &square);
        }
        let (after, _) = render(&mut v, 8000);
        assert!(roughness(&after[4000..]) > smooth * 1.5, "the edit was not heard: {smooth} then {}", roughness(&after[4000..]));
    }

    #[test]
    fn unison_spreads_the_voices_across_the_stereo_field() {
        let (_t, shared) = table("saw");
        let side = |unison: u8| {
            let ctl = VoiceControl::new();
            let mut v = WavetableGuitarVoice::new(ctl.clone(), shared.clone(), WavetableParams { unison, spread: 1.0, ..params() });
            ctl.note_on(220.0, 100);
            let (l, r) = render(&mut v, 8000);
            l[4000..].iter().zip(&r[4000..]).map(|(a, b)| (a - b).abs()).sum::<f32>() / 4000.0
        };
        // One voice sits in the middle (a copy on both sides); seven do not.
        assert!(side(7) > side(1) + 0.01, "one voice {} seven {}", side(1), side(7));
    }

    #[test]
    fn a_high_pick_keeps_its_pitch_when_the_table_is_full_of_harmonics() {
        // Without the band limit a saw at 2 kHz folds back into wrong pitches.
        let (_t, shared) = table("saw");
        let ctl = VoiceControl::new();
        let mut v = WavetableGuitarVoice::new(ctl.clone(), shared, WavetableParams { position: 1.0, ..params() });
        ctl.note_on(1318.5, 100);
        let (l, _) = render(&mut v, SR / 2);
        let hz = read_hz(&l[SR / 4..]);
        assert!(cents(hz, 1318.5).abs() < 8.0, "read {hz} Hz");
    }

    #[test]
    fn a_stopped_control_ends_the_source() {
        let (_t, shared) = table("saw");
        let ctl = VoiceControl::new();
        let mut v = WavetableGuitarVoice::new(ctl.clone(), shared, params());
        assert!(v.next().is_some());
        ctl.stop();
        assert!(v.next().is_none());
    }
}
