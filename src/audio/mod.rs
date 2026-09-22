pub mod analysis;
pub mod samples;
pub mod vst3;
pub mod vst3_capture;
pub mod wavetable;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use fundsp::prelude::*;
use rodio::{OutputStream, OutputStreamBuilder, Sink, Source};
use analysis::{to_db, AudioSummary, AudioTap, Levels, Spectrum, SpectrumAnalyzer, TapSnapshot, ENGINE_SAMPLE_RATE};
use samples::{SampleEvent, SampleParams, SampleVoice};
use wavetable::{WavetableParams, WavetableVoice};

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

/// Builds just a voice's oscillator/noise source -> ADSR envelope/gain -> centered
/// mono-to-stereo pan, with no delay/reverb spliced in - used by `AudioEngine::play_note_on_track`
/// (the persistent per-track mixing bus path, see `TrackBus`), where FX now lives once on the
/// track's bus via `Entropy.AudioEffect`/`ensure_track_bus` instead of being baked into every
/// note. Deliberately a near-duplicate of `build_note_node`'s oscillator match arms rather than
/// a shared helper: each arm's `$node` has a different concrete fundsp type before it's erased
/// to `Box<dyn AudioUnit>`, and unifying that with `build_note_node`'s differing tail (delay/
/// reverb combinators vs. nothing) would need real macro-of-macros plumbing that isn't worth it
/// for two call sites - see the entropy-daw-mixing-bus post's decision log.
fn build_voice_node(voice: &str, params: &NoteParams, sample_rate: f32) -> Box<dyn AudioUnit> {
    let freq = params.freq.max(1.0) as f32;
    let cutoff = params.cutoff.max(20.0) as f32;
    let q = params.resonance.max(0.1) as f32;
    let gain = params.gain as f32;
    let dur = params.duration.max(0.02) as f32;
    let a = params.attack.max(0.0) as f32;
    let d = params.decay.max(0.0) as f32;
    let s = params.sustain.clamp(0.0, 1.0) as f32;
    let r = params.release.max(0.0) as f32;

    macro_rules! env {
        () => {
            lfo(move |t: f32| adsr_amp(t, a, d, s, r, dur))
        };
    }

    macro_rules! voice_node {
        ($node:expr) => {{
            let mut node = ($node) >> pan(0.0);
            node.set_sample_rate(sample_rate as f64);
            node.reset();
            Box::new(node) as Box<dyn AudioUnit>
        }};
    }

    match voice {
        "square" => voice_node!((square_hz(freq) >> lowpass_hz(cutoff, q)) * env!() * gain),
        "saw" => voice_node!((saw_hz(freq) >> lowpass_hz(cutoff, q)) * env!() * gain),
        "triangle" => voice_node!((triangle_hz(freq) >> lowpass_hz(cutoff, q)) * env!() * gain),
        "noise" => voice_node!((noise() >> lowpass_hz(cutoff, q)) * env!() * gain),

        "kick" => {
            let start_f = freq * 3.0 + 40.0;
            let end_f = freq.max(30.0);
            let pitch_env = lfo(move |t: f32| end_f + (start_f - end_f) * (-t / 0.045).exp());
            voice_node!((pitch_env >> sine::<f32>()) * env!() * gain)
        }
        "tom" => {
            let start_f = freq * 1.6 + 20.0;
            let end_f = freq.max(40.0);
            let pitch_env = lfo(move |t: f32| end_f + (start_f - end_f) * (-t / 0.08).exp());
            voice_node!((pitch_env >> sine::<f32>()) * env!() * gain)
        }
        "snare" => {
            voice_node!(((noise() >> bandpass_hz(cutoff, q)) + sine_hz::<f32>(freq) * 0.25) * env!() * gain)
        }
        "clap" => voice_node!((noise() >> bandpass_hz(cutoff, q)) * env!() * gain),
        "hihat" => voice_node!((noise() >> highpass_hz(cutoff, q)) * env!() * gain),

        _ => voice_node!((sine_hz::<f32>(freq) >> lowpass_hz(cutoff, q)) * env!() * gain),
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
    render_events_to_wav(events, &[], sample_rate, output_path)
}

/// `render_pattern_to_wav` plus sample hits (a drum rack's pads). A sample is rendered by the same
/// `SampleVoice` the live path plays, at the engine rate, and is resampled by linear interpolation
/// if `sample_rate` differs. Like the synth events it carries no bus effects: a sample's gain is
/// whatever the caller folded in.
pub fn render_events_to_wav(
    events: &[NoteEvent],
    sample_events: &[SampleEvent],
    sample_rate: u32,
    output_path: &Path,
) -> Result<f64, String> {
    render_events_full_to_wav(events, sample_events, &[], &[], sample_rate, output_path).map(|(seconds, _)| seconds)
}

/// One scheduled note of a wavetable track in an offline render: the table it reads, and the note.
#[derive(Clone, Debug)]
pub struct WavetableEvent {
    pub start_time: f64,
    pub table: String,
    pub params: WavetableParams,
}

/// `render_events_to_wav` plus wavetable notes and VST3 instrument tracks. A wavetable note is
/// rendered by the same `WavetableVoice` the live path plays, from the table's current contents, so
/// a bounce sounds like what was sculpted. A note whose table no longer exists is skipped, like a
/// pad whose file is gone. Each `Vst3RenderTrack` is rendered through its own fresh plugin instance
/// (see `vst3::render_offline_track`); a track whose plugin fails to load or start is left out of
/// the mix and reported back in the second element of the returned tuple, rather than failing the
/// whole export.
pub fn render_events_full_to_wav(
    events: &[NoteEvent],
    sample_events: &[SampleEvent],
    wavetable_events: &[WavetableEvent],
    vst3_tracks: &[vst3::Vst3RenderTrack],
    sample_rate: u32,
    output_path: &Path,
) -> Result<(f64, Vec<String>), String> {
    let sr = sample_rate as f32;

    let mut voice_bufs: Vec<(usize, Vec<f32>)> = Vec::with_capacity(events.len() + sample_events.len());
    let mut total_frames: usize = 0;

    for hit in sample_events {
        // A pad whose file has gone missing is skipped rather than failing the whole export.
        let Ok(sample) = samples::load(&hit.path) else { continue };
        let voice = SampleVoice::new(sample, hit.params, None);
        let mut buf: Vec<f32> = voice.collect();
        if sample_rate != ENGINE_SAMPLE_RATE && !buf.is_empty() {
            let stereo: Vec<[f32; 2]> = buf.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
            buf = samples::resample(stereo, ENGINE_SAMPLE_RATE, sample_rate).into_iter().flatten().collect();
        }
        let n_frames = buf.len() / 2;
        let start_sample = (hit.start_time.max(0.0) * sr as f64).round() as usize;
        total_frames = std::cmp::Ord::max(total_frames, start_sample + n_frames);
        voice_bufs.push((start_sample, buf));
    }

    for hit in wavetable_events {
        let Some(shared) = wavetable::shared_for(&hit.table) else { continue };
        let limit = hit.params.duration.max(0.0) + hit.params.release.max(0.005) + 0.5;
        let mut buf = wavetable::render_note(shared, hit.params, limit);
        if sample_rate != ENGINE_SAMPLE_RATE && !buf.is_empty() {
            let stereo: Vec<[f32; 2]> = buf.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
            buf = samples::resample(stereo, ENGINE_SAMPLE_RATE, sample_rate).into_iter().flatten().collect();
        }
        let n_frames = buf.len() / 2;
        let start_sample = (hit.start_time.max(0.0) * sr as f64).round() as usize;
        total_frames = std::cmp::Ord::max(total_frames, start_sample + n_frames);
        voice_bufs.push((start_sample, buf));
    }

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

    for track in vst3_tracks {
        let end_frames = (track.end_seconds() * sr as f64).ceil() as usize;
        total_frames = std::cmp::Ord::max(total_frames, end_frames);
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

    let mut vst3_warnings = Vec::new();
    for track in vst3_tracks {
        match vst3::render_offline_track(track, total_frames) {
            Ok(mut buf) => {
                if sample_rate != vst3::SAMPLE_RATE && !buf.is_empty() {
                    let stereo: Vec<[f32; 2]> = buf.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
                    buf = samples::resample(stereo, vst3::SAMPLE_RATE, sample_rate).into_iter().flatten().collect();
                }
                let frames = std::cmp::Ord::min(buf.len() / 2, total_frames);
                for i in 0..frames {
                    master[i * 2] += buf[i * 2];
                    master[i * 2 + 1] += buf[i * 2 + 1];
                }
            }
            Err(e) => vst3_warnings.push(format!("{}: {e}", track.plugin_path.display())),
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

    Ok((total_frames as f64 / sample_rate as f64, vst3_warnings))
}

// --- Generic, shareable audio effects (Entropy.AudioEffect) -----------------------------------
//
// Before this, delay/reverb were flat fields (delayTime, reverbRoomSize, ...) baked directly
// into every note/track config - simple, but it meant every effect kind had to be a hardcoded
// field on every call site, and (see `build_note_node`'s doc comment / the daw-fx-bench numbers)
// every triggered note allocated its own fresh 32-channel reverb FDN even at mix=0. An effect is
// now a standalone object created once via `AudioEngine::create_effect`, referenced by id, and
// attached to a track's mixing bus (`ensure_track_bus`'s `effect_ids`) - so it's built once and
// its (potentially expensive) internal state is shared across every note that passes through
// that bus, and adding a new effect kind later doesn't mean touching every note-trigger call
// site's parameter list.
//
// This is deliberately bus-only, not attachable straight to an individual one-shot note: a
// stateful streaming effect (a delay line, an FDN reverb) has to see one continuous, already-
// summed signal to process correctly. Sharing one live effect instance across several
// *simultaneously* triggered, independently-clocked notes would mean multiple unsynchronized
// callers ticking the same internal buffer - which is exactly what a mixing bus exists to
// prevent, by summing a track's notes into one stream before anything downstream (gain, mute,
// solo, effects) ever sees them. A single note that wants its own private, non-shared FX still
// has the old baked-in path (`build_note_node`/`play_note`/`render_pattern_to_wav`), unchanged.

/// A simple stereo echo, hand-rolled as a ring buffer rather than fundsp's `delay()` combinator.
/// fundsp's `delay(t)` fixes its buffer length at graph-construction time - fine for the old
/// per-note bake (a new graph every trigger anyway), but wrong for a persistent effect meant to
/// have its delay time/feedback dragged live on a slider without rebuilding anything. The ring
/// buffer is sized once to `max_seconds` and `process` just moves its read offset, so time and
/// feedback are ordinary atomics read every sample - no rebuild, ever, for this effect kind.
struct StereoDelayLine {
    buffer: Vec<[f32; 2]>,
    write_pos: usize,
    sample_rate: f32,
}

impl StereoDelayLine {
    fn new(sample_rate: f32, max_seconds: f32) -> Self {
        let capacity = std::cmp::Ord::max((sample_rate * max_seconds).ceil() as usize, 1) + 1;
        StereoDelayLine { buffer: vec![[0.0; 2]; capacity], write_pos: 0, sample_rate }
    }

    /// Returns the delayed (wet, pre-mix) sample and writes `input + feedback*delayed` back into
    /// the ring buffer, matching a standard feedback-delay/echo topology.
    fn process(&mut self, input: [f32; 2], delay_time: f32, feedback: f32) -> [f32; 2] {
        let cap = self.buffer.len();
        let delay_samples = ((delay_time.max(0.0)) * self.sample_rate) as usize;
        let delay_samples = std::cmp::Ord::min(delay_samples, cap - 1);
        let read_pos = (self.write_pos + cap - delay_samples) % cap;
        let delayed = self.buffer[read_pos];
        let fb = feedback.clamp(0.0, 0.95);
        self.buffer[self.write_pos] = [input[0] + delayed[0] * fb, input[1] + delayed[1] * fb];
        self.write_pos = (self.write_pos + 1) % cap;
        delayed
    }
}

/// Params for creating or updating a delay effect - see `Entropy.AudioEffect.createDelay`.
#[derive(Clone, Copy, Debug)]
pub struct DelayEffectParams {
    pub time: f64,
    pub feedback: f64,
    pub mix: f64,
}

/// Params for creating or updating a reverb effect - see `Entropy.AudioEffect.createReverb`.
#[derive(Clone, Copy, Debug)]
pub struct ReverbEffectParams {
    pub room_size: f64,
    pub time: f64,
    pub damping: f64,
    pub mix: f64,
}

#[derive(Clone, Copy, Debug)]
pub enum EffectParams {
    Delay(DelayEffectParams),
    Reverb(ReverbEffectParams),
}

enum EffectState {
    Delay { line: StereoDelayLine, time: f32, feedback: f32 },
    /// `room_size`/`time`/`damping` are kept alongside the built node purely so `set_params` can
    /// tell whether they actually changed before paying for a rebuild (`reverb_stereo` allocates
    /// 32 delay lines - see `build_note_node`'s doc comment for what that costs per call).
    Reverb { node: Box<dyn AudioUnit>, room_size: f64, time: f64, damping: f64 },
}

impl EffectState {
    fn process(&mut self, input: [f32; 2]) -> [f32; 2] {
        match self {
            EffectState::Delay { line, time, feedback } => line.process(input, *time, *feedback),
            EffectState::Reverb { node, .. } => {
                let mut out = [0.0f32; 2];
                node.tick(&input, &mut out);
                out
            }
        }
    }
}

fn build_reverb_node(room_size: f64, time: f64, damping: f64, sample_rate: f32) -> Box<dyn AudioUnit> {
    let mut node = reverb_stereo(room_size.clamp(10.0, 30.0), time.max(0.05), damping.clamp(0.0, 1.0));
    node.set_sample_rate(sample_rate as f64);
    node.reset();
    Box::new(node)
}

/// A shared, live-adjustable effect instance, created via `AudioEngine::create_effect` and
/// attached to one or more track buses by id. `mix` (the wet/dry blend applied by whichever bus
/// is calling `process_and_mix`) is a lock-free atomic since it's read on the audio thread every
/// sample; the effect's own internal processing state sits behind a `Mutex` instead, since a
/// delay ring buffer or reverb FDN needs `&mut` access to tick - locked once per sample, which
/// is a real but small cost, and one this project accepts here the same way the reverb-rebuild
/// path already does elsewhere (see the entropy-daw-mixing-bus post's decision log).
pub struct EffectHandle {
    state: Mutex<EffectState>,
    mix: AtomicU32,
    sample_rate: f32,
}

impl EffectHandle {
    fn new(sample_rate: f32, params: EffectParams) -> Self {
        let (state, mix) = match params {
            EffectParams::Delay(p) => (
                EffectState::Delay {
                    line: StereoDelayLine::new(sample_rate, 2.0),
                    time: p.time.max(0.0) as f32,
                    feedback: p.feedback.clamp(0.0, 0.95) as f32,
                },
                p.mix,
            ),
            EffectParams::Reverb(p) => (
                EffectState::Reverb {
                    node: build_reverb_node(p.room_size, p.time, p.damping, sample_rate),
                    room_size: p.room_size,
                    time: p.time,
                    damping: p.damping,
                },
                p.mix,
            ),
        };
        EffectHandle { state: Mutex::new(state), mix: AtomicU32::new((mix.clamp(0.0, 1.0) as f32).to_bits()), sample_rate: sample_rate }
    }

    /// Updates this effect's params in place. Delay time/feedback/mix are always live (no
    /// rebuild - see `StereoDelayLine`); reverb's room/time/damping only trigger a rebuild of
    /// the internal fundsp node when one of them actually changed, and reverb's mix is always
    /// live regardless. Silently does nothing if `params`'s kind doesn't match this handle's
    /// existing kind (an addon shouldn't call `setDelayParams` on a reverb id, but a stale id
    /// reused across a hot-reload shouldn't panic the audio thread either).
    fn set_params(&self, params: EffectParams) {
        match params {
            EffectParams::Delay(p) => {
                self.mix.store((p.mix.clamp(0.0, 1.0) as f32).to_bits(), Ordering::Relaxed);
                if let EffectState::Delay { time, feedback, .. } = &mut *self.state.lock().unwrap() {
                    *time = p.time.max(0.0) as f32;
                    *feedback = p.feedback.clamp(0.0, 0.95) as f32;
                }
            }
            EffectParams::Reverb(p) => {
                self.mix.store((p.mix.clamp(0.0, 1.0) as f32).to_bits(), Ordering::Relaxed);
                let mut state = self.state.lock().unwrap();
                if let EffectState::Reverb { node, room_size, time, damping } = &mut *state {
                    if *room_size != p.room_size || *time != p.time || *damping != p.damping {
                        *node = build_reverb_node(p.room_size, p.time, p.damping, self.sample_rate);
                        *room_size = p.room_size;
                        *time = p.time;
                        *damping = p.damping;
                    }
                }
            }
        }
    }

    /// Processes one dry stereo frame through this effect and adds the result back in at its
    /// live mix level - `dry + wet*mix`, an insert-style send matching the additive dry+wet
    /// blend the old per-note delay/reverb combinators already used, so chaining several of
    /// these (see `TrackBusSource`) reproduces the same "each stage adds onto what came before"
    /// signal flow as the original per-note `wrap!` macro's `multipass::<U2>() & (... * mix)`.
    fn process_and_mix(&self, dry: [f32; 2]) -> [f32; 2] {
        let wet = self.state.lock().unwrap().process(dry);
        let mix = f32::from_bits(self.mix.load(Ordering::Relaxed));
        [dry[0] + wet[0] * mix, dry[1] + wet[1] * mix]
    }
}

/// The persistent, continuously-running signal source behind one track's mixing bus. Wraps a
/// `rodio::mixer::MixerSource` (which sums every note currently playing on this track) rather
/// than being appended straight to a `Sink` - a bare `MixerSource` reports itself finished
/// (`next()` returns `None`) whenever it has no current notes, which would let a `Sink` drop it
/// the instant a track goes quiet between notes. This wrapper never signals completion: an empty
/// mixer just reads as silence, so the bus - and anything live-adjusted on it (gain/mute/solo/
/// effects) - keeps running for the track's entire lifetime, exactly like a real mixing console
/// channel.
struct TrackBusSource {
    mixer_source: rodio::mixer::MixerSource,
    effects: Arc<Mutex<Vec<Arc<EffectHandle>>>>,
    gain: Arc<AtomicU32>,
    muted: Arc<AtomicBool>,
    solo: Arc<AtomicBool>,
    any_solo: Arc<AtomicBool>,
    /// What this track sounds like after its effects, gain, mute and solo: the same frames the
    /// master bus sums, so a scope on a muted track goes flat rather than showing a signal you
    /// cannot hear. See `analysis::AudioTap`.
    tap: Arc<AudioTap>,
    /// Cleared when the track is removed. The bus now lives inside the master mixer rather than
    /// owning a `Sink`, so ending the source is how a deleted track stops making sound.
    alive: Arc<AtomicBool>,
    sample_rate: f32,
    buf: [f32; 2],
    buf_idx: u8,
}

impl Iterator for TrackBusSource {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if self.buf_idx == 0 {
            if !self.alive.load(Ordering::Relaxed) {
                return None;
            }
            let dry = [
                self.mixer_source.next().unwrap_or(0.0),
                self.mixer_source.next().unwrap_or(0.0),
            ];

            let mut x = dry;
            for effect in self.effects.lock().unwrap().iter() {
                x = effect.process_and_mix(x);
            }

            // Real-time mute/solo: read every sample, not just at note-trigger time, so toggling
            // either one takes effect immediately on notes already ringing - the actual point of
            // a persistent bus instead of the old fire-and-forget per-note sinks.
            let active = if self.any_solo.load(Ordering::Relaxed) {
                self.solo.load(Ordering::Relaxed)
            } else {
                !self.muted.load(Ordering::Relaxed)
            };
            let gain = if active { f32::from_bits(self.gain.load(Ordering::Relaxed)) } else { 0.0 };

            self.buf = [x[0] * gain, x[1] * gain];
            self.tap.push(self.buf[0], self.buf[1]);
        }
        let sample = self.buf[self.buf_idx as usize];
        self.buf_idx = (self.buf_idx + 1) % 2;
        Some(sample)
    }
}

impl Source for TrackBusSource {
    fn current_span_len(&self) -> Option<usize> { None }
    fn channels(&self) -> u16 { 2 }
    fn sample_rate(&self) -> u32 { self.sample_rate as u32 }
    fn total_duration(&self) -> Option<std::time::Duration> { None }
}

/// The main-thread-facing handle for one track's persistent mixing bus - see `TrackBusSource`
/// for the audio-thread side sharing these same `Arc`s. Dropping this `TrackBus` (on
/// `remove_track_bus`) clears `alive`, which ends the bus's source and lets the master mixer drop
/// it: a never-ending source can't be stopped any other way now that the bus is no longer wrapped
/// in a `Sink` of its own.
struct TrackBus {
    note_mixer: rodio::mixer::Mixer,
    alive: Arc<AtomicBool>,
    gain: Arc<AtomicU32>,
    muted: Arc<AtomicBool>,
    solo: Arc<AtomicBool>,
    effects: Arc<Mutex<Vec<Arc<EffectHandle>>>>,
    tap: Arc<AudioTap>,
}

impl Drop for TrackBus {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
    }
}

/// The master bus: sums every track bus and is the one thing appended to the output stream. It
/// exists so there is a single place that hears the whole mix (an analyzer on "master" needs the
/// real sum, and summing per-track taps after the fact would only line up to within a callback
/// buffer), and it is where a future master effect chain or limiter would go. Like
/// `TrackBusSource` it never ends: an empty `MixerSource` reads as silence.
struct MasterBusSource {
    mixer_source: rodio::mixer::MixerSource,
    tap: Arc<AudioTap>,
    buf: [f32; 2],
    buf_idx: u8,
}

impl Iterator for MasterBusSource {
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        if self.buf_idx == 0 {
            self.buf = [
                self.mixer_source.next().unwrap_or(0.0),
                self.mixer_source.next().unwrap_or(0.0),
            ];
            self.tap.push(self.buf[0], self.buf[1]);
        }
        let sample = self.buf[self.buf_idx as usize];
        self.buf_idx = (self.buf_idx + 1) % 2;
        Some(sample)
    }
}

impl Source for MasterBusSource {
    fn current_span_len(&self) -> Option<usize> { None }
    fn channels(&self) -> u16 { 2 }
    fn sample_rate(&self) -> u32 { ENGINE_SAMPLE_RATE }
    fn total_duration(&self) -> Option<std::time::Duration> { None }
}

/// Name of the tap that hears the whole mix, as `Entropy.Audio` and the analyzer widgets spell it.
pub const MASTER_SOURCE: &str = "master";

pub struct AudioEngine {
    stream_handle: OutputStream,
    effects: Mutex<HashMap<String, Arc<EffectHandle>>>,
    track_buses: Mutex<HashMap<String, TrackBus>>,
    any_solo: Arc<AtomicBool>,
    master_mixer: rodio::mixer::Mixer,
    _master_sink: Sink,
    master_tap: Arc<AudioTap>,
    /// FFT plans and window tables, reused across frames. Only the UI thread calls into it.
    analyzer: Mutex<SpectrumAnalyzer>,
    /// Where each meter widget last read up to, so a peak is measured since the last frame
    /// rather than over a fixed trailing window. Keyed by the reader's own id.
    meter_cursors: Mutex<HashMap<String, u64>>,
    /// Stops the sample the browser is auditioning when the next one starts.
    preview_cancel: Mutex<Option<Arc<AtomicBool>>>,
    /// The wavetable notes being held (see `wavetable_note_on`), by voice id.
    wavetable_gates: Mutex<HashMap<u64, WavetableHandle>>,
    next_wavetable_voice: AtomicU64,
}

/// What the main thread keeps of a held wavetable note: the gate that releases it and the position
/// its voice reads (see `WavetableVoice::with_live_position`).
struct WavetableHandle {
    gate: Arc<AtomicBool>,
    position: Arc<AtomicU32>,
}

/// The bus the sample browser auditions through. It feeds the master (so you hear it and the
/// analyzer sees it) and has its own tap, so `analyze(PREVIEW_BUS)` reads what is being auditioned.
pub const PREVIEW_BUS: &str = "sample-preview";

impl AudioEngine {
    pub fn new() -> Self {
        let stream_handle = OutputStreamBuilder::open_default_stream().expect("Failed to create audio stream");

        let (master_mixer, mixer_source) = rodio::mixer::mixer(2, ENGINE_SAMPLE_RATE);
        let master_tap = Arc::new(AudioTap::new());
        let master_sink = Sink::connect_new(stream_handle.mixer());
        master_sink.append(MasterBusSource { mixer_source, tap: master_tap.clone(), buf: [0.0; 2], buf_idx: 0 });

        AudioEngine {
            stream_handle,
            effects: Mutex::new(HashMap::new()),
            track_buses: Mutex::new(HashMap::new()),
            any_solo: Arc::new(AtomicBool::new(false)),
            master_mixer,
            _master_sink: master_sink,
            master_tap,
            analyzer: Mutex::new(SpectrumAnalyzer::new()),
            meter_cursors: Mutex::new(HashMap::new()),
            preview_cancel: Mutex::new(None),
            wavetable_gates: Mutex::new(HashMap::new()),
            next_wavetable_voice: AtomicU64::new(1),
        }
    }

    // --- Entropy.AudioEffect: a shared, reusable effect registry (see the module doc comment
    // above `StereoDelayLine`) ---

    pub fn create_effect(&self, params: EffectParams) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let handle = Arc::new(EffectHandle::new(44100.0, params));
        self.effects.lock().unwrap().insert(id.clone(), handle);
        id
    }

    pub fn set_effect_params(&self, effect_id: &str, params: EffectParams) {
        if let Some(handle) = self.effects.lock().unwrap().get(effect_id) {
            handle.set_params(params);
        }
    }

    pub fn destroy_effect(&self, effect_id: &str) {
        self.effects.lock().unwrap().remove(effect_id);
    }

    // --- Entropy.Audio track buses: persistent per-track mixer + gain/mute/solo + effect chain ---

    /// Creates a track's bus on first call, or updates its gain/mute/solo/effect chain on every
    /// call after that - the DAW addon calls this once per track every time it persists project
    /// state, so there's no separate create-vs-update entry point to keep in sync.
    pub fn ensure_track_bus(&self, track_id: &str, gain: f64, muted: bool, solo: bool, effect_ids: &[String]) {
        let resolved: Vec<Arc<EffectHandle>> = {
            let effects = self.effects.lock().unwrap();
            effect_ids.iter().filter_map(|id| effects.get(id).cloned()).collect()
        };

        let mut buses = self.track_buses.lock().unwrap();
        if let Some(bus) = buses.get(track_id) {
            bus.gain.store((gain as f32).to_bits(), Ordering::Relaxed);
            bus.muted.store(muted, Ordering::Relaxed);
            bus.solo.store(solo, Ordering::Relaxed);
            *bus.effects.lock().unwrap() = resolved;
        } else {
            let sample_rate = 44100.0f32;
            let (note_mixer, mixer_source) = rodio::mixer::mixer(2, sample_rate as u32);

            let gain_a = Arc::new(AtomicU32::new((gain as f32).to_bits()));
            let muted_a = Arc::new(AtomicBool::new(muted));
            let solo_a = Arc::new(AtomicBool::new(solo));
            let effects_a = Arc::new(Mutex::new(resolved));
            let tap = Arc::new(AudioTap::new());
            let alive = Arc::new(AtomicBool::new(true));

            let source = TrackBusSource {
                mixer_source,
                effects: effects_a.clone(),
                gain: gain_a.clone(),
                muted: muted_a.clone(),
                solo: solo_a.clone(),
                any_solo: self.any_solo.clone(),
                tap: tap.clone(),
                alive: alive.clone(),
                sample_rate,
                buf: [0.0; 2],
                buf_idx: 0,
            };

            self.master_mixer.add(source);

            buses.insert(track_id.to_string(), TrackBus {
                note_mixer,
                alive,
                gain: gain_a,
                muted: muted_a,
                solo: solo_a,
                effects: effects_a,
                tap,
            });
        }

        let any = buses.values().any(|b| b.solo.load(Ordering::Relaxed));
        self.any_solo.store(any, Ordering::Relaxed);
    }

    pub fn remove_track_bus(&self, track_id: &str) {
        let mut buses = self.track_buses.lock().unwrap();
        buses.remove(track_id);
        let any = buses.values().any(|b| b.solo.load(Ordering::Relaxed));
        self.any_solo.store(any, Ordering::Relaxed);
    }

    /// Triggers one note on an already-created track bus (see `ensure_track_bus`) - the note
    /// gets only its own oscillator/envelope graph (`build_voice_node`, no FX baked in); delay/
    /// reverb now live once on the bus and are shared by every note passing through it. Silently
    /// does nothing if the track bus doesn't exist yet (the addon always calls `ensure_track_bus`
    /// before this, but a stale/deleted track id shouldn't panic the audio thread).
    pub fn play_note_on_track(&self, track_id: &str, voice: &str, params: NoteParams) {
        let buses = self.track_buses.lock().unwrap();
        let Some(bus) = buses.get(track_id) else { return; };

        let sample_rate = 44100.0f32;
        let node = build_voice_node(voice, &params, sample_rate);
        let dur = params.duration.max(0.02) as f32;

        let source = FundspSource { node, sample_rate, buf: [0.0; 2], buf_idx: 0 }
            .take_duration(std::time::Duration::from_secs_f32(dur));

        bus.note_mixer.add(source);
    }

    /// Plays a sample file on a track's bus: a drum-rack pad hit. The bus gives it the track's gain,
    /// mute, solo, effects, meter and analyzer tap. The sample is decoded on first use (see
    /// `samples::load`); callers load it when a pad is assigned so a hit never waits on a decode.
    /// Errors if the file cannot be read or the track has no bus.
    pub fn play_sample_on_track(&self, track_id: &str, path: &str, params: SampleParams) -> Result<(), String> {
        let sample = samples::load(path)?;
        let buses = self.track_buses.lock().unwrap();
        let bus = buses.get(track_id).ok_or_else(|| format!("track {track_id} has no bus"))?;
        bus.note_mixer.add(SampleVoice::new(sample, params, None));
        Ok(())
    }

    /// Plays one timed wavetable note on a track's bus. The note reads the table called `table_id`
    /// as it is at every sample, so sculpting the table changes a note that is already sounding.
    pub fn play_wavetable_on_track(&self, track_id: &str, table_id: &str, params: WavetableParams) -> Result<(), String> {
        let shared = wavetable::shared_for(table_id).ok_or_else(|| format!("no wavetable called {table_id}"))?;
        let buses = self.track_buses.lock().unwrap();
        let bus = buses.get(track_id).ok_or_else(|| format!("track {track_id} has no bus"))?;
        bus.note_mixer.add(WavetableVoice::new(shared, params, None));
        Ok(())
    }

    /// Starts a wavetable note that sounds until `wavetable_note_off` (a key held down, or a note
    /// latched while sculpting). Returns the id to release it with.
    pub fn wavetable_note_on(&self, track_id: &str, table_id: &str, params: WavetableParams) -> Result<u64, String> {
        let shared = wavetable::shared_for(table_id).ok_or_else(|| format!("no wavetable called {table_id}"))?;
        let buses = self.track_buses.lock().unwrap();
        let bus = buses.get(track_id).ok_or_else(|| format!("track {track_id} has no bus"))?;
        let gate = Arc::new(AtomicBool::new(true));
        let position = Arc::new(AtomicU32::new(params.position.to_bits()));
        let id = self.next_wavetable_voice.fetch_add(1, Ordering::Relaxed);
        bus.note_mixer.add(WavetableVoice::new(shared, params, Some(gate.clone())).with_live_position(position.clone()));
        let mut gates = self.wavetable_gates.lock().unwrap();
        // A voice that has finished has dropped its clone of the gate, leaving only ours.
        gates.retain(|_, h| Arc::strong_count(&h.gate) > 1);
        gates.insert(id, WavetableHandle { gate, position });
        Ok(id)
    }

    /// Releases a note started by `wavetable_note_on`. Unknown or already-finished ids are ignored.
    pub fn wavetable_note_off(&self, voice_id: u64) {
        if let Some(h) = self.wavetable_gates.lock().unwrap().remove(&voice_id) {
            h.gate.store(false, Ordering::Relaxed);
        }
    }

    /// Moves a held note through its table: `position` is 0..1 across the frames.
    pub fn wavetable_set_position(&self, voice_id: u64, position: f32) {
        if let Some(h) = self.wavetable_gates.lock().unwrap().get(&voice_id) {
            h.position.store(position.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
        }
    }

    /// Auditions a sample through `PREVIEW_BUS`, cutting off the one still playing from the last
    /// call.
    pub fn preview_sample(&self, path: &str, params: SampleParams) -> Result<(), String> {
        let sample = samples::load(path)?;
        if !self.track_buses.lock().unwrap().contains_key(PREVIEW_BUS) {
            self.ensure_track_bus(PREVIEW_BUS, 1.0, false, false, &[]);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        if let Some(previous) = self.preview_cancel.lock().unwrap().replace(cancel.clone()) {
            previous.store(true, Ordering::Relaxed);
        }
        let buses = self.track_buses.lock().unwrap();
        let bus = buses.get(PREVIEW_BUS).ok_or("the preview bus was removed")?;
        bus.note_mixer.add(SampleVoice::new(sample, params, Some(cancel)));
        Ok(())
    }

    pub fn stop_preview(&self) {
        if let Some(cancel) = self.preview_cancel.lock().unwrap().take() {
            cancel.store(true, Ordering::Relaxed);
        }
    }

    /// Adds a long-lived source (a hosted VST3 instrument - see `vst3::Vst3Source`) to an existing
    /// track bus's note mixer, so it inherits that bus's gain/mute/solo and effect chain. Returns
    /// false if the track has no bus yet.
    pub fn add_track_source<S>(&self, track_id: &str, source: S) -> bool
    where
        S: Source<Item = f32> + Send + 'static,
    {
        let buses = self.track_buses.lock().unwrap();
        match buses.get(track_id) {
            Some(bus) => {
                bus.note_mixer.add(source);
                true
            }
            None => false,
        }
    }

    // --- Analysis (oscilloscope, spectrum and level meters) ---

    /// The tap for `source`: `"master"` for the whole mix, or a track id for that track's bus.
    pub fn tap(&self, source: &str) -> Option<Arc<AudioTap>> {
        if source == MASTER_SOURCE {
            return Some(self.master_tap.clone());
        }
        self.track_buses.lock().unwrap().get(source).map(|b| b.tap.clone())
    }

    /// The last `frames` frames `source` produced, oldest first. `None` when there is no such
    /// source (a deleted track, a stale id): a widget draws an empty trace for that.
    pub fn snapshot(&self, source: &str, frames: usize) -> Option<TapSnapshot> {
        self.tap(source).map(|t| t.snapshot(frames))
    }

    /// Spectrum of the last `fft_size` frames of `source`.
    pub fn spectrum(&self, source: &str, fft_size: usize) -> Option<Spectrum> {
        let snap = self.snapshot(source, fft_size)?;
        Some(self.analyzer.lock().unwrap().analyze(&snap.left, &snap.right, fft_size, ENGINE_SAMPLE_RATE as f32))
    }

    /// Levels and spectrum headline numbers for the last `fft_size` frames of `source`, with no
    /// widget involved: for tests, AI tools and addons that want to read the mix back.
    pub fn analyze(&self, source: &str, fft_size: usize) -> Option<AudioSummary> {
        let tap = self.tap(source)?;
        let snap = tap.snapshot(fft_size);
        let levels = Levels::of(&snap.left, &snap.right);
        let spec = self.analyzer.lock().unwrap().analyze(&snap.left, &snap.right, fft_size, ENGINE_SAMPLE_RATE as f32);
        Some(AudioSummary {
            peak_l: to_db(levels.peak[0]),
            peak_r: to_db(levels.peak[1]),
            rms_l: to_db(levels.rms[0]),
            rms_r: to_db(levels.rms[1]),
            peak_hz: spec.peak_hz,
            peak_db: spec.peak_db,
            centroid_hz: spec.centroid_hz,
            frames_written: tap.frames_written(),
            window_frames: snap.len(),
        })
    }

    /// Peak and RMS of `source` since the last call with the same `reader` key. The key is the
    /// calling widget's own id, so two meters on one source do not steal each other's peaks.
    pub fn levels(&self, source: &str, reader: &str) -> Option<Levels> {
        let tap = self.tap(source)?;
        let key = format!("{reader}|{source}");
        let mut cursors = self.meter_cursors.lock().unwrap();
        let cursor = cursors.get(&key).copied();
        // A first read looks back one 60 Hz UI frame; after that it is exactly "since last time".
        let (levels, next) = tap.levels_since(cursor, ENGINE_SAMPLE_RATE as usize / 60);
        cursors.insert(key, next);
        Some(levels)
    }

    /// Ids of every track that currently has a bus, for a source picker.
    pub fn track_ids(&self) -> Vec<String> {
        self.track_buses.lock().unwrap().keys().cloned().collect()
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
