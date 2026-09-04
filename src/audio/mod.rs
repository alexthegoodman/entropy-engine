use std::sync::{Arc, Mutex};
use fundsp::prelude::*;
use rodio::{OutputStream, OutputStreamBuilder, Sink, Source};

// A wrapper to make fundsp nodes compatible with rodio::Source
struct FundspSource<N>
where
    N: AudioUnit,
{
    node: N,
    sample_rate: f32,
}

impl<N> Iterator for FundspSource<N>
where
    N: AudioUnit,
{
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        let mut output = [0.0f32; 1];
        self.node.tick(&[], &mut output);
        Some(output[0])
    }
}

impl<N> Source for FundspSource<N>
where
    N: AudioUnit,
{
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> u16 {
        1
    }

    fn sample_rate(&self) -> u32 {
        self.sample_rate as u32
    }

    fn total_duration(&self) -> Option<std::time::Duration> {
        None
    }
}

/// Amplitude curve for a simple 4-stage envelope, evaluated at time `t` (seconds)
/// for a note of total length `dur` seconds (release tail included in `dur`).
fn adsr_amp(t: f32, attack: f32, decay: f32, sustain: f32, release: f32, dur: f32) -> f32 {
    let a = attack.max(0.001);
    let d = decay.max(0.001);
    let r = release.max(0.001);
    let s = sustain.clamp(0.0, 1.0);
    let release_start = (dur - r).max(a + d).max(a);

    if t < a {
        (t / a).clamp(0.0, 1.0)
    } else if t < a + d {
        1.0 - (1.0 - s) * ((t - a) / d).clamp(0.0, 1.0)
    } else if t < release_start {
        s
    } else {
        let rt = ((t - release_start) / r).clamp(0.0, 1.0);
        s * (1.0 - rt)
    }
}

/// Parameters for a single triggered note / drum hit.
#[derive(Clone, Copy, Debug)]
pub struct NoteParams {
    pub freq: f64,
    pub duration: f64,
    pub cutoff: f64,
    pub resonance: f64,
    pub gain: f64,
    pub attack: f64,
    pub decay: f64,
    pub sustain: f64,
    pub release: f64,
}

impl Default for NoteParams {
    fn default() -> Self {
        NoteParams {
            freq: 440.0,
            duration: 0.5,
            cutoff: 5000.0,
            resonance: 1.0,
            gain: 0.2,
            attack: 0.005,
            decay: 0.05,
            sustain: 0.85,
            release: 0.05,
        }
    }
}

pub struct AudioEngine {
    stream_handle: OutputStream,
}

impl AudioEngine {
    pub fn new() -> Self {
        let stream_handle = OutputStreamBuilder::open_default_stream().expect("Failed to create audio stream");

        AudioEngine {
            stream_handle,
        }
    }

    pub fn play_test_tone(&self) {
        let source = rodio::source::SineWave::new(440.0)
            .take_duration(std::time::Duration::from_secs_f32(0.5))
            .amplify(0.20);

        let sink = Sink::connect_new(self.stream_handle.mixer());
        sink.append(source);
        sink.detach();
    }

    /// Legacy entry point kept for existing callers; forwards into `play_note`
    /// with a short click-free envelope wrapped around the previous flat-gain behavior.
    pub fn play_synth(&self, freq: f64, waveform: &str, duration: f64, cutoff: f64, gain: f64) {
        self.play_note(waveform, NoteParams {
            freq,
            duration,
            cutoff,
            gain,
            ..Default::default()
        });
    }

    /// Triggers one polyphonic voice (tonal or drum) that mixes independently with
    /// anything else currently playing, enabling multi-track / multi-note playback.
    pub fn play_note(&self, voice: &str, params: NoteParams) {
        let sample_rate = 44100.0f32;
        let freq = params.freq.max(1.0) as f32;
        let cutoff = params.cutoff.max(20.0) as f32;
        let q = params.resonance.max(0.1) as f32;
        let gain = params.gain as f32;
        let dur = params.duration.max(0.02) as f32;
        let a = params.attack.max(0.0) as f32;
        let d = params.decay.max(0.0) as f32;
        let s = params.sustain.clamp(0.0, 1.0) as f32;
        let r = params.release.max(0.0) as f32;

        let mixer = self.stream_handle.mixer();

        macro_rules! env {
            () => {
                lfo(move |t: f32| adsr_amp(t, a, d, s, r, dur))
            };
        }

        macro_rules! play {
            ($node:expr) => {{
                let mut node = $node;
                node.set_sample_rate(sample_rate as f64);
                node.reset();

                let source = FundspSource { node, sample_rate };
                let finite_source = source.take_duration(std::time::Duration::from_secs_f32(dur));

                let sink = Sink::connect_new(mixer);
                sink.append(finite_source);
                sink.detach();
            }};
        }

        match voice {
            "square" => play!((square_hz(freq) >> lowpass_hz(cutoff, q)) * env!() * gain),
            "saw" => play!((saw_hz(freq) >> lowpass_hz(cutoff, q)) * env!() * gain),
            "triangle" => play!((triangle_hz(freq) >> lowpass_hz(cutoff, q)) * env!() * gain),
            "noise" => play!((noise() >> lowpass_hz(cutoff, q)) * env!() * gain),

            // --- Drum voices: `freq` tunes the pitch/body, `cutoff`/`resonance` shape the
            // filtered-noise timbre, and attack/decay/sustain/release shape the amplitude. ---
            "kick" => {
                let start_f = freq * 3.0 + 40.0;
                let end_f = freq.max(30.0);
                let pitch_env = lfo(move |t: f32| end_f + (start_f - end_f) * (-t / 0.045).exp());
                play!((pitch_env >> sine::<f32>()) * env!() * gain)
            }
            "tom" => {
                let start_f = freq * 1.6 + 20.0;
                let end_f = freq.max(40.0);
                let pitch_env = lfo(move |t: f32| end_f + (start_f - end_f) * (-t / 0.08).exp());
                play!((pitch_env >> sine::<f32>()) * env!() * gain)
            }
            "snare" => {
                play!(((noise() >> bandpass_hz(cutoff, q)) + sine_hz::<f32>(freq) * 0.25) * env!() * gain)
            }
            "clap" => play!((noise() >> bandpass_hz(cutoff, q)) * env!() * gain),
            "hihat" => play!((noise() >> highpass_hz(cutoff, q)) * env!() * gain),

            _ => play!((sine_hz::<f32>(freq) >> lowpass_hz(cutoff, q)) * env!() * gain),
        }
    }
}
