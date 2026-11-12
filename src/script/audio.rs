//! A small polyphonic synth for `Audio.playNote`: oscillators (sine, triangle, saw, square,
//! noise) with an ADSR envelope and a resonant low-pass, two drums (kick, tom), panning, and two
//! shared effect sends - a stereo delay and a reverb. It plays through cpal, which is the
//! platform's audio API natively and Web Audio in a browser.
//!
//! Browsers only start audio after a user gesture, so in a browser the output is opened (or
//! resumed) on the first key or click; notes asked for before that are dropped, not queued.

use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub struct NoteParams {
    pub freq: f32,
    pub duration: f32,
    pub gain: f32,
    pub attack: f32,
    pub decay: f32,
    pub sustain: f32,
    pub release: f32,
    pub cutoff: f32,
    pub resonance: f32,
    pub delay_time: f32,
    pub delay_feedback: f32,
    pub delay_mix: f32,
    pub reverb_mix: f32,
    pub reverb_room_size: f32,
    pub reverb_time: f32,
    pub muffle: f32,
}

impl Default for NoteParams {
    fn default() -> Self {
        Self {
            freq: 440.0,
            duration: 0.5,
            gain: 0.5,
            attack: 0.01,
            decay: 0.1,
            sustain: 0.7,
            release: 0.2,
            cutoff: 20000.0,
            resonance: 0.0,
            delay_time: 0.0,
            delay_feedback: 0.0,
            delay_mix: 0.0,
            reverb_mix: 0.0,
            reverb_room_size: 20.0,
            reverb_time: 2.0,
            muffle: 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Wave {
    Sine,
    Triangle,
    Saw,
    Square,
    Noise,
    Kick,
    Tom,
}

impl Wave {
    fn parse(name: &str) -> Wave {
        match name {
            "triangle" => Wave::Triangle,
            "saw" | "sawtooth" => Wave::Saw,
            "square" | "pulse" => Wave::Square,
            "noise" => Wave::Noise,
            "kick" => Wave::Kick,
            "tom" | "snare" => Wave::Tom,
            _ => Wave::Sine,
        }
    }
}

struct Voice {
    wave: Wave,
    p: NoteParams,
    pan_l: f32,
    pan_r: f32,
    t: f32,
    phase: f32,
    noise: u32,
    // Two cascaded one-pole low-passes with a little feedback for resonance.
    lp1: f32,
    lp2: f32,
}

impl Voice {
    fn envelope(&self) -> f32 {
        let p = &self.p;
        let t = self.t;
        if matches!(self.wave, Wave::Kick | Wave::Tom) {
            return (-t * 6.0 / p.duration.max(0.05)).exp();
        }
        let gate = p.duration.max(p.attack);
        let level_at = |t: f32| -> f32 {
            if t < p.attack {
                t / p.attack.max(1e-4)
            } else if t < p.attack + p.decay {
                1.0 - (1.0 - p.sustain) * ((t - p.attack) / p.decay.max(1e-4))
            } else {
                p.sustain
            }
        };
        if t < gate {
            level_at(t)
        } else {
            let r = (t - gate) / p.release.max(1e-3);
            level_at(gate) * (1.0 - r).max(0.0)
        }
    }

    fn done(&self) -> bool {
        let p = &self.p;
        if matches!(self.wave, Wave::Kick | Wave::Tom) {
            return self.t > p.duration.max(0.05) * 1.2;
        }
        self.t > p.duration.max(p.attack) + p.release.max(1e-3)
    }

    fn sample(&mut self, dt: f32) -> f32 {
        let freq = match self.wave {
            // A falling pitch: the thump of a drum.
            Wave::Kick => self.p.freq * (1.0 + 2.5 * (-self.t * 30.0).exp()),
            Wave::Tom => self.p.freq * (1.0 + 0.8 * (-self.t * 18.0).exp()),
            _ => self.p.freq,
        };
        self.phase = (self.phase + freq * dt).fract();
        let ph = self.phase;
        let raw = match self.wave {
            Wave::Sine | Wave::Kick => (ph * std::f32::consts::TAU).sin(),
            Wave::Tom => (ph * std::f32::consts::TAU).sin() * 0.85 + self.white() * 0.15,
            Wave::Triangle => 1.0 - 4.0 * (ph - 0.5).abs(),
            Wave::Saw => 2.0 * ph - 1.0,
            Wave::Square => if ph < 0.5 { 1.0 } else { -1.0 },
            Wave::Noise => self.white(),
        };
        // Muffle closes the filter (far away, behind something).
        let cutoff = (self.p.cutoff * (1.0 - 0.9 * self.p.muffle.clamp(0.0, 1.0))).clamp(20.0, 20000.0);
        let k = 1.0 - (-std::f32::consts::TAU * cutoff * dt).exp();
        let fb = self.p.resonance.clamp(0.0, 0.95) * 2.0;
        let input = raw - fb * (self.lp2 - self.lp1);
        self.lp1 += k * (input - self.lp1);
        self.lp2 += k * (self.lp1 - self.lp2);
        let out = self.lp2 * self.envelope() * self.p.gain;
        self.t += dt;
        out
    }

    fn white(&mut self) -> f32 {
        self.noise ^= self.noise << 13;
        self.noise ^= self.noise >> 17;
        self.noise ^= self.noise << 5;
        (self.noise as f32 / u32::MAX as f32) * 2.0 - 1.0
    }
}

/// Freeverb-style: parallel feedback combs into series all-passes, per channel.
struct Reverb {
    combs: Vec<(Vec<f32>, usize, f32)>,
    allpasses: Vec<(Vec<f32>, usize)>,
    feedback: f32,
}

impl Reverb {
    fn new(rate: f32, spread: usize) -> Self {
        let scale = rate / 44100.0;
        let combs = [1116, 1188, 1277, 1356, 1422, 1491]
            .iter()
            .map(|&n| (vec![0.0; ((n + spread) as f32 * scale) as usize + 1], 0, 0.0))
            .collect();
        let allpasses = [556, 441, 341].iter().map(|&n| (vec![0.0; ((n + spread) as f32 * scale) as usize + 1], 0)).collect();
        Self { combs, allpasses, feedback: 0.84 }
    }

    fn process(&mut self, x: f32) -> f32 {
        let mut out = 0.0;
        for (buf, i, damp) in self.combs.iter_mut() {
            let y = buf[*i];
            *damp = y * 0.75 + *damp * 0.25;
            buf[*i] = x + *damp * self.feedback;
            *i = (*i + 1) % buf.len();
            out += y;
        }
        out *= 0.15;
        for (buf, i) in self.allpasses.iter_mut() {
            let b = buf[*i];
            buf[*i] = out + b * 0.5;
            out = b - out;
            *i = (*i + 1) % buf.len();
        }
        out
    }
}

struct Mixer {
    rate: f32,
    voices: Vec<Voice>,
    seed: u32,
    delay: [Vec<f32>; 2],
    delay_pos: usize,
    delay_time: f32,
    delay_feedback: f32,
    reverb: [Reverb; 2],
}

const MAX_VOICES: usize = 96;

impl Mixer {
    fn new(rate: f32) -> Self {
        let len = (rate * 2.0) as usize;
        Self {
            rate,
            voices: Vec::new(),
            seed: 0x9e3779b9,
            delay: [vec![0.0; len], vec![0.0; len]],
            delay_pos: 0,
            delay_time: 0.3,
            delay_feedback: 0.35,
            reverb: [Reverb::new(rate, 0), Reverb::new(rate, 23)],
        }
    }

    fn add(&mut self, wave: &str, p: NoteParams, pan: f32) {
        if self.voices.len() >= MAX_VOICES {
            // The oldest note gives way.
            self.voices.remove(0);
        }
        if p.delay_mix > 0.0 && p.delay_time > 0.0 {
            self.delay_time = p.delay_time.clamp(0.01, 1.9);
            self.delay_feedback = p.delay_feedback.clamp(0.0, 0.9);
        }
        if p.reverb_mix > 0.0 {
            let fb = (0.7 + p.reverb_time.clamp(0.2, 10.0) / 10.0 * 0.27).min(0.97);
            for r in self.reverb.iter_mut() {
                r.feedback = fb;
            }
        }
        let a = (pan.clamp(-1.0, 1.0) + 1.0) * std::f32::consts::FRAC_PI_4;
        self.seed = self.seed.wrapping_mul(1664525).wrapping_add(1013904223);
        self.voices.push(Voice {
            wave: Wave::parse(wave),
            p,
            pan_l: a.cos() * std::f32::consts::SQRT_2,
            pan_r: a.sin() * std::f32::consts::SQRT_2,
            t: 0.0,
            phase: 0.0,
            noise: self.seed | 1,
            lp1: 0.0,
            lp2: 0.0,
        });
    }

    fn render(&mut self, out: &mut [f32], channels: usize) {
        let dt = 1.0 / self.rate;
        let dlen = self.delay[0].len();
        let dsamples = ((self.delay_time * self.rate) as usize).clamp(1, dlen - 1);
        for frame in out.chunks_mut(channels) {
            let (mut l, mut r, mut dl, mut dr, mut rv) = (0.0f32, 0.0f32, 0.0f32, 0.0f32, 0.0f32);
            for v in self.voices.iter_mut() {
                let s = v.sample(dt);
                let (sl, sr) = (s * v.pan_l, s * v.pan_r);
                l += sl;
                r += sr;
                dl += sl * v.p.delay_mix;
                dr += sr * v.p.delay_mix;
                rv += s * v.p.reverb_mix;
            }
            let read = (self.delay_pos + dlen - dsamples) % dlen;
            let (el, er) = (self.delay[0][read], self.delay[1][read]);
            self.delay[0][self.delay_pos] = dl + er * self.delay_feedback;
            self.delay[1][self.delay_pos] = dr + el * self.delay_feedback;
            self.delay_pos = (self.delay_pos + 1) % dlen;
            l += el;
            r += er;
            l += self.reverb[0].process(rv);
            r += self.reverb[1].process(rv);
            // A soft limiter keeps a pile of notes from clipping hard.
            let (l, r) = ((l * 0.8).tanh(), (r * 0.8).tanh());
            if channels == 1 {
                frame[0] = (l + r) * 0.5;
            } else {
                frame[0] = l;
                frame[1] = r;
                for c in frame.iter_mut().skip(2) {
                    *c = 0.0;
                }
            }
        }
        self.voices.retain(|v| !v.done());
    }
}

/// The audio output. Holds no stream until [`Audio::start`] succeeds.
pub struct Audio {
    mixer: Option<Arc<Mutex<Mixer>>>,
    stream: Option<cpal::Stream>,
    failed: bool,
}

impl Audio {
    pub fn new() -> Self {
        Self { mixer: None, stream: None, failed: false }
    }

    /// Opens the default output, or resumes it (a browser suspends audio until a gesture).
    pub fn start(&mut self) {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
        if let Some(stream) = &self.stream {
            let _ = stream.play();
            return;
        }
        if self.failed {
            return;
        }
        let host = cpal::default_host();
        let Some(device) = host.default_output_device() else {
            self.failed = true;
            log::warn!("no audio output device: notes will be silent");
            return;
        };
        let config = match device.default_output_config() {
            Ok(c) => c,
            Err(e) => {
                self.failed = true;
                log::warn!("no audio output config: {e}");
                return;
            }
        };
        let rate = config.sample_rate().0 as f32;
        let channels = config.channels() as usize;
        let mixer = Arc::new(Mutex::new(Mixer::new(rate)));
        let m = mixer.clone();
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_output_stream(
                &config.into(),
                move |data: &mut [f32], _| {
                    if let Ok(mut m) = m.lock() {
                        m.render(data, channels);
                    } else {
                        data.fill(0.0);
                    }
                },
                |e| log::warn!("audio stream error: {e}"),
                None,
            ),
            other => {
                self.failed = true;
                log::warn!("unsupported audio sample format {other:?}");
                return;
            }
        };
        match stream {
            Ok(s) => {
                let _ = s.play();
                self.stream = Some(s);
                self.mixer = Some(mixer);
            }
            Err(e) => {
                self.failed = true;
                log::warn!("could not open audio output: {e}");
            }
        }
    }

    pub fn play(&mut self, wave: &str, params: NoteParams, pan: f32) {
        if let Some(m) = &self.mixer {
            if let Ok(mut m) = m.lock() {
                m.add(wave, params, pan);
            }
        }
    }

    pub fn is_running(&self) -> bool {
        self.stream.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_ring_and_then_end() {
        let mut m = Mixer::new(48000.0);
        m.add("triangle", NoteParams { duration: 0.1, release: 0.05, reverb_mix: 0.5, ..Default::default() }, 0.3);
        m.add("kick", NoteParams { freq: 50.0, duration: 0.2, ..Default::default() }, 0.0);
        let mut buf = vec![0.0; 4800 * 2];
        m.render(&mut buf, 2);
        assert!(buf.iter().any(|s| s.abs() > 0.01), "the notes should be audible");
        assert!(buf.iter().all(|s| s.is_finite() && s.abs() <= 1.0));
        for _ in 0..10 {
            m.render(&mut buf, 2);
        }
        assert!(m.voices.is_empty(), "finished notes are dropped");
    }
}
