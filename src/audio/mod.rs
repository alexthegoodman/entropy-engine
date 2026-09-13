use std::path::Path;
use std::sync::{Arc, Mutex};
use fundsp::prelude::*;
use rodio::{OutputStream, OutputStreamBuilder, Sink, Source};

// A wrapper to make a type-erased fundsp graph compatible with rodio::Source. The graph is
// always exactly stereo (2 outputs) - see `build_note_node` - so this no longer needs to be
// generic over the node type the way it was before the FX chain was added; every voice now
// ends in `pan(...)` plus the delay/reverb stage, which forces a fixed U2 output shape anyway.
struct FundspSource {
    node: Box<dyn AudioUnit>,
    sample_rate: f32,
    buf: [f32; 2],
    buf_idx: u8,
}

impl Iterator for FundspSource {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if self.buf_idx == 0 {
            let mut output = [0.0f32; 2];
            self.node.tick(&[], &mut output);
            self.buf = output;
        }
        let sample = self.buf[self.buf_idx as usize];
        self.buf_idx = (self.buf_idx + 1) % 2;
        Some(sample)
    }
}

impl Source for FundspSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> u16 {
        2
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
    // --- Effects chain (always present in the graph - see `build_note_node`'s doc comment
    // for why mix=0 rather than an absent node is the "off" state). ---
    /// Echo delay time in seconds. 0 is a legal (zero-length) delay line.
    pub delay_time: f64,
    /// Feedback gain fed back into the delay line each repeat, 0..0.95.
    pub delay_feedback: f64,
    /// Wet/dry mix of the delayed signal, 0 (off)..1.
    pub delay_mix: f64,
    /// fundsp `reverb_stereo` room size in meters, clamped to fundsp's own 10..30 range.
    pub reverb_room_size: f64,
    /// Reverberation time in seconds to -60dB.
    pub reverb_time: f64,
    /// Damping filter amount, 0..1.
    pub reverb_damping: f64,
    /// Wet/dry mix of the reverberated signal, 0 (off)..1.
    pub reverb_mix: f64,
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
            delay_time: 0.0,
            delay_feedback: 0.0,
            delay_mix: 0.0,
            reverb_room_size: 10.0,
            reverb_time: 1.0,
            reverb_damping: 0.5,
            reverb_mix: 0.0,
        }
    }
}

/// How long (seconds) a note's own graph needs to run to let its envelope, plus any audible
/// delay/reverb tail, decay to silence. Only extended past the raw note duration when the
/// relevant mix is actually non-zero, since `reverb_stereo` in particular is expensive enough
/// (32 delay lines - see `build_note_node`) that a silent tail isn't free to tick through.
fn note_total_duration(params: &NoteParams) -> f64 {
    let dur = params.duration.max(0.02);
    let delay_tail = if params.delay_mix > 0.001 {
        params.delay_time.max(0.0) * 4.0 + 0.3
    } else {
        0.0
    };
    let reverb_tail = if params.reverb_mix > 0.001 {
        params.reverb_time.max(0.05) * 1.2
    } else {
        0.0
    };
    (dur + delay_tail + reverb_tail).min(12.0)
}

/// Builds one voice's complete signal graph: oscillator/noise source -> ADSR envelope/gain
/// -> centered mono-to-stereo pan -> delay stage -> reverb stage, type-erased to `Box<dyn
/// AudioUnit>` so `play_note` (realtime, one detached rodio Sink per note) and
/// `render_pattern_to_wav` (offline, ticked directly into a PCM buffer) can share one
/// definition instead of two copies of the same match arms drifting apart.
///
/// The delay and reverb stages are always spliced into the graph, mixed via fundsp's `&`
/// (bus) combinator against a dry `multipass::<U2>()`, and multiplied by their own mix
/// parameter rather than being conditionally present - this repo's existing per-note
/// architecture (one fire-and-forget Sink per note, no persistent mixing bus - see the
/// module doc comment on `play_note`) means there's no shared effect state to attach or
/// detach at note-trigger time, so "off" has to mean "wet gain is zero," not "the effect
/// isn't in the graph." That's a real cost: `reverb_stereo` allocates a 32-channel FDN
/// (32 delay lines) on every single call to this function even when `reverb_mix` is 0 -
/// see the failure-notes benchmark for what that costs in practice.
fn build_note_node(voice: &str, params: &NoteParams, sample_rate: f32) -> Box<dyn AudioUnit> {
    let freq = params.freq.max(1.0) as f32;
    let cutoff = params.cutoff.max(20.0) as f32;
    let q = params.resonance.max(0.1) as f32;
    let gain = params.gain as f32;
    let dur = params.duration.max(0.02) as f32;
    let a = params.attack.max(0.0) as f32;
    let d = params.decay.max(0.0) as f32;
    let s = params.sustain.clamp(0.0, 1.0) as f32;
    let r = params.release.max(0.0) as f32;

    let delay_time = params.delay_time.max(0.0).min(2.0);
    let delay_fb = params.delay_feedback.clamp(0.0, 0.95) as f32;
    let delay_mix = params.delay_mix.clamp(0.0, 1.0) as f32;
    let room_size = params.reverb_room_size.clamp(10.0, 30.0);
    let reverb_time = params.reverb_time.max(0.05);
    let reverb_damping = params.reverb_damping.clamp(0.0, 1.0);
    let reverb_mix = params.reverb_mix.clamp(0.0, 1.0) as f32;

    macro_rules! env {
        () => {
            lfo(move |t: f32| adsr_amp(t, a, d, s, r, dur))
        };
    }

    macro_rules! wrap {
        ($node:expr) => {{
            let stereo = ($node) >> pan(0.0);
            let delay_stage = multipass::<U2>()
                & (feedback((delay(delay_time) | delay(delay_time)) * delay_fb) * delay_mix);
            let reverb_stage = multipass::<U2>()
                & (reverb_stereo(room_size, reverb_time, reverb_damping) * reverb_mix);

            let mut node = stereo >> delay_stage >> reverb_stage;
            node.set_sample_rate(sample_rate as f64);
            node.reset();
            Box::new(node) as Box<dyn AudioUnit>
        }};
    }

    match voice {
        "square" => wrap!((square_hz(freq) >> lowpass_hz(cutoff, q)) * env!() * gain),
        "saw" => wrap!((saw_hz(freq) >> lowpass_hz(cutoff, q)) * env!() * gain),
        "triangle" => wrap!((triangle_hz(freq) >> lowpass_hz(cutoff, q)) * env!() * gain),
        "noise" => wrap!((noise() >> lowpass_hz(cutoff, q)) * env!() * gain),

        // --- Drum voices: `freq` tunes the pitch/body, `cutoff`/`resonance` shape the
        // filtered-noise timbre, and attack/decay/sustain/release shape the amplitude. ---
        "kick" => {
            let start_f = freq * 3.0 + 40.0;
            let end_f = freq.max(30.0);
            let pitch_env = lfo(move |t: f32| end_f + (start_f - end_f) * (-t / 0.045).exp());
            wrap!((pitch_env >> sine::<f32>()) * env!() * gain)
        }
        "tom" => {
            let start_f = freq * 1.6 + 20.0;
            let end_f = freq.max(40.0);
            let pitch_env = lfo(move |t: f32| end_f + (start_f - end_f) * (-t / 0.08).exp());
            wrap!((pitch_env >> sine::<f32>()) * env!() * gain)
        }
        "snare" => {
            wrap!(((noise() >> bandpass_hz(cutoff, q)) + sine_hz::<f32>(freq) * 0.25) * env!() * gain)
        }
        "clap" => wrap!((noise() >> bandpass_hz(cutoff, q)) * env!() * gain),
        "hihat" => wrap!((noise() >> highpass_hz(cutoff, q)) * env!() * gain),

        _ => wrap!((sine_hz::<f32>(freq) >> lowpass_hz(cutoff, q)) * env!() * gain),
    }
}

/// One scheduled note in an offline pattern render - see `render_pattern_to_wav`.
#[derive(Clone, Debug)]
pub struct NoteEvent {
    pub start_time: f64,
    pub voice: String,
    pub params: NoteParams,
}

/// Renders a whole pattern (a list of pre-scheduled note events, as the DAW addon builds by
/// walking every track's step grid once) to a stereo 16-bit PCM WAV file, entirely offline -
/// no rodio `OutputStream`/`Sink` involved. Each event gets its own `build_note_node` graph
/// ticked sample-by-sample into a local buffer, then additively mixed into a master buffer at
/// its scheduled sample offset; this is sample-accurate and deterministic (no wall-clock
/// jitter the way the realtime `play_note` step-sequencer path has), and it lets a note's
/// delay/reverb tail ring out past the pattern's nominal end instead of getting cut off, which
/// is what most DAWs do for a bounce/export.
///
/// Returns the rendered file's duration in seconds.
pub fn render_pattern_to_wav(
    events: &[NoteEvent],
    sample_rate: u32,
    output_path: &Path,
) -> Result<f64, String> {
    let sr = sample_rate as f32;

    let mut voice_bufs: Vec<(usize, Vec<f32>)> = Vec::with_capacity(events.len());
    let mut total_frames: usize = 0;

    for event in events {
        let mut node = build_note_node(&event.voice, &event.params, sr);
        let total_dur = note_total_duration(&event.params);
        let n_frames = (total_dur * sr as f64).ceil() as usize;

        let mut buf = vec![0.0f32; n_frames * 2];
        for i in 0..n_frames {
            let mut out = [0.0f32; 2];
            node.tick(&[], &mut out);
            buf[i * 2] = out[0];
            buf[i * 2 + 1] = out[1];
        }

        let start_sample = (event.start_time.max(0.0) * sr as f64).round() as usize;
        total_frames = std::cmp::Ord::max(total_frames, start_sample + n_frames);
        voice_bufs.push((start_sample, buf));
    }

    // A pattern with no notes at all still produces a (silent, 1-frame) file rather than
    // erroring - an empty export is a legitimate, if useless, thing to ask for.
    total_frames = std::cmp::Ord::max(total_frames, 1);

    let mut master = vec![0.0f32; total_frames * 2];
    for (start_sample, buf) in &voice_bufs {
        let frames = buf.len() / 2;
        for i in 0..frames {
            master[(start_sample + i) * 2] += buf[i * 2];
            master[(start_sample + i) * 2 + 1] += buf[i * 2 + 1];
        }
    }

    // Peak-normalize only when notes actually stack loud enough to clip - most single-track
    // patterns never hit this, but a busy multi-track pattern easily can, and clamping alone
    // (without scaling down first) would audibly distort rather than just get quieter.
    let peak = master.iter().fold(0.0f32, |m, &v| m.max(v.abs()));
    let scale = if peak > 1.0 { 0.98 / peak } else { 1.0 };

    let spec = hound::WavSpec {
        channels: 2,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(output_path, spec).map_err(|e| e.to_string())?;
    for &sample in &master {
        let v = (sample * scale).clamp(-1.0, 1.0);
        writer
            .write_sample((v * i16::MAX as f32) as i16)
            .map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;

    Ok(total_frames as f64 / sample_rate as f64)
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

    /// A `Sink` connected to this engine's mixer, kept undetached so the caller can drive
    /// it directly (`play`/`pause`/`set_volume`/`stop`) - used by `media_player::MediaPlayer`
    /// for decoded video audio, unlike the fire-and-forget synth sinks above.
    pub fn new_sink(&self) -> Sink {
        Sink::connect_new(self.stream_handle.mixer())
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

    /// Triggers one polyphonic voice (tonal or drum) that mixes independently with anything
    /// else currently playing, enabling multi-track / multi-note playback. Each call is its
    /// own detached rodio `Sink` fed by its own `build_note_node` graph (including its own
    /// delay/reverb instance) - there is no persistent per-track or master bus, so two notes
    /// on the same track never share reverb/delay state, each just gets its own independent
    /// tail. See `build_note_node`'s doc comment for why that's the deliberate tradeoff here.
    pub fn play_note(&self, voice: &str, params: NoteParams) {
        let sample_rate = 44100.0f32;
        let node = build_note_node(voice, &params, sample_rate);
        let total_dur = note_total_duration(&params) as f32;

        let source = FundspSource { node, sample_rate, buf: [0.0; 2], buf_idx: 0 };
        let finite_source = source.take_duration(std::time::Duration::from_secs_f32(total_dur));

        let sink = Sink::connect_new(self.stream_handle.mixer());
        sink.append(finite_source);
        sink.detach();
    }
}
