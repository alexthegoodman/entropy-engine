pub mod analysis;
pub mod brass;
pub mod matter;
pub mod character;
pub mod physmod;
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
use brass::{BrassCommand, BrassHandle, BrassInstrumentVoice, BrassParams};
use physmod::{InstrumentCommand, InstrumentHandle, PhysModInstrumentVoice, PhysModParams};
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
    // --- Filter envelope and drive (the DAW's Acid knob). Both off by default, and a note with
    // both off is built exactly as before - see `build_voice_node`. ---
    /// How far above `cutoff` the filter opens at the start of the note, in octaves (0 = static).
    pub filter_env: f64,
    /// Seconds for the filter envelope to fall back to `cutoff` (a time constant, not a total).
    pub filter_decay: f64,
    /// tanh drive after the filter; 1 is clean.
    pub drive: f64,
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
            filter_env: 0.0,
            filter_decay: 0.2,
            drive: 1.0,
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

/// A note's filter envelope and drive (the DAW's Acid knob), or None when it has neither, in
/// which case the voice is built exactly as it always was.
#[derive(Clone, Copy)]
struct AcidShape {
    /// Octaves above the cutoff the filter starts at.
    env_oct: f32,
    /// Time constant of the filter's fall back to the cutoff, seconds.
    decay: f32,
    drive: f32,
}

fn acid_shape(params: &NoteParams) -> Option<AcidShape> {
    let env_oct = params.filter_env.clamp(0.0, 8.0) as f32;
    let drive = params.drive.clamp(1.0, 20.0) as f32;
    if env_oct <= 0.001 && drive <= 1.001 {
        return None;
    }
    Some(AcidShape { env_oct, decay: params.filter_decay.clamp(0.005, 4.0) as f32, drive })
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

    // The Acid path (see `AcidShape`): the cutoff is a curve over the note's life instead of a
    // constant, and the filter feeds a tanh drive. `tanh(d*x)/sqrt(d)` keeps small signals near
    // unity and pulls full-scale ones down, so more drive is more bite, not simply more level.
    macro_rules! acid {
        ($osc:expr, $sh:expr) => {{
            let AcidShape { env_oct, decay, drive } = $sh;
            let cut = lfo(move |t: f32| (cutoff * (env_oct * (-t / decay).exp()).exp2()).min(18_000.0));
            let makeup = 1.0 / drive.sqrt();
            (($osc) | cut | dc(q)) >> lowpass::<f32>() >> shape_fn(move |x: f32| (x * drive).tanh() * makeup)
        }};
    }

    if let Some(sh) = acid_shape(params) {
        match voice {
            "square" => return wrap!(acid!(square_hz(freq), sh) * env!() * gain),
            "saw" => return wrap!(acid!(saw_hz(freq), sh) * env!() * gain),
            "triangle" => return wrap!(acid!(triangle_hz(freq), sh) * env!() * gain),
            "noise" => return wrap!(acid!(noise(), sh) * env!() * gain),
            "sine" => return wrap!(acid!(sine_hz::<f32>(freq), sh) * env!() * gain),
            // Drum voices have no filter envelope; they play as they always have.
            _ => {}
        }
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

    // The Acid path (see `AcidShape`): the cutoff is a curve over the note's life instead of a
    // constant, and the filter feeds a tanh drive. `tanh(d*x)/sqrt(d)` keeps small signals near
    // unity and pulls full-scale ones down, so more drive is more bite, not simply more level.
    macro_rules! acid {
        ($osc:expr, $sh:expr) => {{
            let AcidShape { env_oct, decay, drive } = $sh;
            let cut = lfo(move |t: f32| (cutoff * (env_oct * (-t / decay).exp()).exp2()).min(18_000.0));
            let makeup = 1.0 / drive.sqrt();
            (($osc) | cut | dc(q)) >> lowpass::<f32>() >> shape_fn(move |x: f32| (x * drive).tanh() * makeup)
        }};
    }

    if let Some(sh) = acid_shape(params) {
        match voice {
            "square" => return voice_node!(acid!(square_hz(freq), sh) * env!() * gain),
            "saw" => return voice_node!(acid!(saw_hz(freq), sh) * env!() * gain),
            "triangle" => return voice_node!(acid!(triangle_hz(freq), sh) * env!() * gain),
            "noise" => return voice_node!(acid!(noise(), sh) * env!() * gain),
            "sine" => return voice_node!(acid!(sine_hz::<f32>(freq), sh) * env!() * gain),
            // Drum voices have no filter envelope; they play as they always have.
            _ => {}
        }
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
    render_events_full_to_wav(events, sample_events, &[], &[], &[], sample_rate, output_path).map(|(seconds, _)| seconds)
}

/// One scheduled note of a wavetable track in an offline render: the table it reads, and the note.
#[derive(Clone, Debug)]
pub struct WavetableEvent {
    pub start_time: f64,
    pub table: String,
    pub params: WavetableParams,
}

/// One scheduled note of a physically-modeled bowed-string track in an offline render.
#[derive(Clone, Debug)]
pub struct PhysModEvent {
    pub start_time: f64,
    /// Names the instrument's `PhysModShared` (see `physmod::shared_for`); offline rendering only
    /// reads this for consistency with the live path, since a bowed-string voice carries no other
    /// per-track state to look up.
    pub instrument: String,
    pub params: PhysModParams,
}

/// One scheduled note of a physically-modeled brass track in an offline render. Notes with the same
/// `instrument` are played by one player, so overlapping ones slur as they do live.
#[derive(Clone, Debug)]
pub struct BrassEvent {
    pub start_time: f64,
    pub instrument: String,
    pub params: BrassParams,
}

/// One hit of a physically-modeled drum-kit track in an offline render. Hits with the same `kit`
/// are played on one kit (the first hit's `spec` and `mix` build it), so the pieces ring on and hear
/// each other as they do live.
#[derive(Clone, Debug)]
pub struct MatterEvent {
    pub start_time: f64,
    pub kit: String,
    pub spec: matter::KitSpec,
    pub mix: [f32; matter::kit::PIECES],
    pub hit: matter::KitHit,
}

/// `render_events_to_wav` plus wavetable notes, physically-modeled bowed-string notes and VST3
/// instrument tracks. A wavetable note is rendered by the same `WavetableVoice` the live path plays,
/// from the table's current contents, so a bounce sounds like what was sculpted. A note whose table
/// no longer exists is skipped, like a pad whose file is gone. Each `Vst3RenderTrack` is rendered
/// through its own fresh plugin instance (see `vst3::render_offline_track`); a track whose plugin
/// fails to load or start is left out of the mix and reported back in the second element of the
/// returned tuple, rather than failing the whole export.
pub fn render_events_full_to_wav(
    events: &[NoteEvent],
    sample_events: &[SampleEvent],
    wavetable_events: &[WavetableEvent],
    physmod_events: &[PhysModEvent],
    vst3_tracks: &[vst3::Vst3RenderTrack],
    sample_rate: u32,
    output_path: &Path,
) -> Result<(f64, Vec<String>), String> {
    render_mix_to_wav(events, sample_events, wavetable_events, physmod_events, &[], &[], vst3_tracks, &MixRouting::default(), sample_rate, output_path)
}

/// Which track bus each event of an offline render plays through (see `render_mix_to_wav`). Each
/// slice runs parallel to the event list of the same name and holds an index into `buses`; an
/// event with `None`, or past the end of its slice, goes straight to the master as it always has.
/// For bowed-string events the first event of an instrument decides that instrument's bus.
#[derive(Default, Clone, Copy)]
pub struct MixRouting<'a> {
    pub buses: &'a [character::TrackBusRender],
    pub notes: &'a [Option<usize>],
    pub samples: &'a [Option<usize>],
    pub wavetable: &'a [Option<usize>],
    pub physmod: &'a [Option<usize>],
    pub brass: &'a [Option<usize>],
    pub matter: &'a [Option<usize>],
    pub vst3: &'a [Option<usize>],
}

impl MixRouting<'_> {
    fn bus(&self, slice: &[Option<usize>], i: usize) -> Option<usize> {
        slice.get(i).copied().flatten().filter(|&b| b < self.buses.len())
    }
}

/// `render_events_full_to_wav` with track buses: every event routed to a bus is summed there
/// first, then the bus's character chain (Pump, Gate, Grit, Space), gain and hard cuts run over
/// that sum - the same `character::Character` code the live bus runs - before it joins the
/// master. A bus with Space gets room for its reverb tail at the end of the file.
#[allow(clippy::too_many_arguments)]
pub fn render_mix_to_wav(
    events: &[NoteEvent],
    sample_events: &[SampleEvent],
    wavetable_events: &[WavetableEvent],
    physmod_events: &[PhysModEvent],
    brass_events: &[BrassEvent],
    matter_events: &[MatterEvent],
    vst3_tracks: &[vst3::Vst3RenderTrack],
    routing: &MixRouting,
    sample_rate: u32,
    output_path: &Path,
) -> Result<(f64, Vec<String>), String> {
    let sr = sample_rate as f32;

    let mut voice_bufs: Vec<(usize, Option<usize>, Vec<f32>)> = Vec::with_capacity(events.len() + sample_events.len());
    let mut total_frames: usize = 0;

    for (i, hit) in sample_events.iter().enumerate() {
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
        voice_bufs.push((start_sample, routing.bus(routing.samples, i), buf));
    }

    for (i, hit) in wavetable_events.iter().enumerate() {
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
        voice_bufs.push((start_sample, routing.bus(routing.wavetable, i), buf));
    }

    // Bowed-string notes are rendered per instrument, through one instrument each, so a bounce
    // keeps the slurs, double stops and sympathetic ringing the live instrument has.
    let mut by_instrument: Vec<(&str, Option<usize>, Vec<physmod::PerformedNote>)> = Vec::new();
    for (i, hit) in physmod_events.iter().enumerate() {
        let note = physmod::PerformedNote { start: hit.start_time.max(0.0), params: hit.params };
        match by_instrument.iter_mut().find(|(id, _, _)| *id == hit.instrument.as_str()) {
            Some((_, _, notes)) => notes.push(note),
            None => by_instrument.push((hit.instrument.as_str(), routing.bus(routing.physmod, i), vec![note])),
        }
    }
    // Brass likewise, one player per instrument, so slurs survive the bounce.
    let mut by_player: Vec<(&str, Option<usize>, Vec<(f64, BrassParams)>)> = Vec::new();
    for (i, hit) in brass_events.iter().enumerate() {
        let note = (hit.start_time.max(0.0), hit.params);
        match by_player.iter_mut().find(|(id, _, _)| *id == hit.instrument.as_str()) {
            Some((_, _, notes)) => notes.push(note),
            None => by_player.push((hit.instrument.as_str(), routing.bus(routing.brass, i), vec![note])),
        }
    }
    let brass_bufs = by_player.iter().map(|(_, bus, notes)| (*bus, brass::render_performance(notes, 3.0)));
    let physmod_bufs = by_instrument.iter().map(|(_, bus, notes)| (*bus, physmod::render_performance(notes, 6.0)));
    // Drum kits likewise, one kit per track, so the pieces ring on and hear each other.
    let mut by_kit: Vec<(&str, Option<usize>, matter::KitSpec, [f32; matter::kit::PIECES], Vec<(f64, matter::KitHit)>)> = Vec::new();
    for (i, hit) in matter_events.iter().enumerate() {
        let h = (hit.start_time.max(0.0), hit.hit);
        match by_kit.iter_mut().find(|k| k.0 == hit.kit.as_str()) {
            Some(k) => k.4.push(h),
            None => by_kit.push((hit.kit.as_str(), routing.bus(routing.matter, i), hit.spec, hit.mix, vec![h])),
        }
    }
    let matter_bufs = by_kit.iter().map(|(_, bus, spec, mix, hits)| (*bus, matter::render_performance(*spec, *mix, hits, 20.0)));
    for (bus, buf) in physmod_bufs.chain(brass_bufs).chain(matter_bufs) {
        let mut buf = buf;
        if sample_rate != ENGINE_SAMPLE_RATE && !buf.is_empty() {
            let stereo: Vec<[f32; 2]> = buf.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
            buf = samples::resample(stereo, ENGINE_SAMPLE_RATE, sample_rate).into_iter().flatten().collect();
        }
        let n_frames = buf.len() / 2;
        total_frames = std::cmp::Ord::max(total_frames, n_frames);
        voice_bufs.push((0, bus, buf));
    }

    for (i, event) in events.iter().enumerate() {
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
        voice_bufs.push((start_sample, routing.bus(routing.notes, i), buf));
    }

    for track in vst3_tracks {
        let end_frames = (track.end_seconds() * sr as f64).ceil() as usize;
        total_frames = std::cmp::Ord::max(total_frames, end_frames);
    }

    // Room for a bus effect's own tail (Space's reverb) past the last note.
    let bus_tail = routing.buses.iter().map(|b| b.tail_seconds(sr)).fold(0.0, f64::max);
    if total_frames > 0 {
        total_frames += (bus_tail * sr as f64).ceil() as usize;
    }

    // A pattern with no notes at all still produces a (silent, 1-frame) file rather than
    // erroring - an empty export is a legitimate, if useless, thing to ask for.
    total_frames = std::cmp::Ord::max(total_frames, 1);

    let mut master = vec![0.0f32; total_frames * 2];
    // One buffer per bus that something plays through, allocated on first use.
    let mut bus_bufs: Vec<Option<Vec<f32>>> = vec![None; routing.buses.len()];
    for (start_sample, bus, buf) in &voice_bufs {
        let target = match bus {
            Some(b) => bus_bufs[*b].get_or_insert_with(|| vec![0.0f32; total_frames * 2]),
            None => &mut master,
        };
        let frames = buf.len() / 2;
        for i in 0..frames {
            target[(start_sample + i) * 2] += buf[i * 2];
            target[(start_sample + i) * 2 + 1] += buf[i * 2 + 1];
        }
    }

    let mut vst3_warnings = Vec::new();
    for (t, track) in vst3_tracks.iter().enumerate() {
        let target = match routing.bus(routing.vst3, t) {
            Some(b) => bus_bufs[b].get_or_insert_with(|| vec![0.0f32; total_frames * 2]),
            None => &mut master,
        };
        match vst3::render_offline_track(track, total_frames) {
            Ok(mut buf) => {
                if sample_rate != vst3::SAMPLE_RATE && !buf.is_empty() {
                    let stereo: Vec<[f32; 2]> = buf.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
                    buf = samples::resample(stereo, vst3::SAMPLE_RATE, sample_rate).into_iter().flatten().collect();
                }
                let frames = std::cmp::Ord::min(buf.len() / 2, total_frames);
                for i in 0..frames {
                    target[i * 2] += buf[i * 2];
                    target[i * 2 + 1] += buf[i * 2 + 1];
                }
            }
            Err(e) => vst3_warnings.push(format!("{}: {e}", track.plugin_path.display())),
        }
    }

    for (b, buf) in bus_bufs.iter_mut().enumerate() {
        let Some(buf) = buf else { continue };
        routing.buses[b].process(buf, sr);
        for (m, v) in master.iter_mut().zip(buf.iter()) {
            *m += *v;
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
    /// Pump, Gate, Grit, Space or Fader - see character.rs. Unlike delay and reverb these are
    /// inline: their output replaces the signal instead of being mixed in on top of it.
    Character(character::CharacterParams),
}

enum EffectState {
    Delay { line: StereoDelayLine, time: f32, feedback: f32 },
    /// `room_size`/`time`/`damping` are kept alongside the built node purely so `set_params` can
    /// tell whether they actually changed before paying for a rebuild (`reverb_stereo` allocates
    /// 32 delay lines - see `build_note_node`'s doc comment for what that costs per call).
    Reverb { node: Box<dyn AudioUnit>, room_size: f64, time: f64, damping: f64 },
    Character(Box<character::Character>),
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
            EffectState::Character(c) => c.process(input),
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
    /// Character effects replace the signal rather than adding a wet copy (see `process_and_mix`).
    inline: bool,
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
            EffectParams::Character(p) => (EffectState::Character(Box::new(character::Character::new(p, sample_rate))), 1.0),
        };
        let inline = matches!(params, EffectParams::Character(_));
        EffectHandle { state: Mutex::new(state), mix: AtomicU32::new((mix.clamp(0.0, 1.0) as f32).to_bits()), sample_rate, inline }
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
            EffectParams::Character(p) => {
                if let EffectState::Character(c) = &mut *self.state.lock().unwrap() {
                    c.set(p);
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
        if self.inline {
            return wet;
        }
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
    /// `None` when no output device could be opened (headless machine, no sound card) - the engine
    /// then mixes into `output_mixer` with nothing draining it, so audio calls are silent no-ops
    /// instead of the whole app failing to start.
    _stream_handle: Option<OutputStream>,
    /// The device's mixer, or a detached one when `_stream_handle` is `None`.
    output_mixer: rodio::mixer::Mixer,
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
    /// The bowed-string notes being held (see `physmod_note_on`), by voice id.
    physmod_gates: Mutex<HashMap<u64, PhysModHandle>>,
    next_physmod_voice: AtomicU64,
    /// One live bowed-string instrument per (track, instrument id): every note on it shares its
    /// strings and body (see `physmod::PhysModInstrumentVoice`).
    physmod_instruments: Mutex<HashMap<String, Arc<InstrumentHandle>>>,
    /// The brass notes being held (see `brass_note_on`), by voice id.
    brass_gates: Mutex<HashMap<u64, BrassNoteHandle>>,
    next_brass_voice: AtomicU64,
    /// One live brass player per (track, instrument id): notes on it slur into each other (see
    /// `brass::BrassInstrumentVoice`).
    brass_players: Mutex<HashMap<String, Arc<BrassHandle>>>,
    /// One live drum kit per (track, kit id), or the kit being built for it (see `matter_prepare`).
    matter_kits: Mutex<HashMap<String, MatterKit>>,
}

/// A track's kit: the one playing, and one being built off the audio thread to replace it (a new
/// kit, or new tunings). The playing kit keeps playing until its replacement is ready.
#[derive(Default)]
struct MatterKit {
    playing: Option<Arc<matter::KitHandle>>,
    building: Option<(matter::KitSpec, Arc<Mutex<Option<matter::Kit>>>)>,
    /// What the live kit was last told, so a hit only sends what changed.
    sympathetic: Option<bool>,
    mix: Option<[f32; matter::kit::PIECES]>,
}

/// Whether a track's kit can be played yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatterStatus {
    Ready,
    /// Playing the old kit while the new one is built.
    Rebuilding,
    Building,
}

impl MatterStatus {
    pub fn name(self) -> &'static str {
        match self {
            MatterStatus::Ready => "ready",
            MatterStatus::Rebuilding => "rebuilding",
            MatterStatus::Building => "building",
        }
    }
}

/// What the main thread keeps of a held wavetable note: the gate that releases it and the position
/// its voice reads (see `WavetableVoice::with_live_position`).
struct WavetableHandle {
    gate: Arc<AtomicBool>,
    position: Arc<AtomicU32>,
}

/// What the main thread keeps of a held bowed-string note: the instrument it is sounding on (to
/// release it) and the bow controls it reads (see `physmod::PhysModLive`).
struct PhysModHandle {
    instrument: Arc<InstrumentHandle>,
    live: Arc<physmod::PhysModLive>,
}

/// What the main thread keeps of a held brass note: the player it sounds on (to release it) and the
/// controls it reads live (see `brass::BrassLive`).
struct BrassNoteHandle {
    player: Arc<BrassHandle>,
    live: Arc<brass::BrassLive>,
}

/// The bus the sample browser auditions through. It feeds the master (so you hear it and the
/// analyzer sees it) and has its own tap, so `analyze(PREVIEW_BUS)` reads what is being auditioned.
pub const PREVIEW_BUS: &str = "sample-preview";

impl AudioEngine {
    pub fn new() -> Self {
        let stream_handle = match OutputStreamBuilder::open_default_stream() {
            Ok(stream) => Some(stream),
            Err(error) => {
                eprintln!("No audio output device available ({error:?}); continuing with audio muted");
                None
            }
        };
        let output_mixer = match &stream_handle {
            Some(stream) => stream.mixer().clone(),
            None => rodio::mixer::mixer(2, ENGINE_SAMPLE_RATE).0,
        };

        let (master_mixer, mixer_source) = rodio::mixer::mixer(2, ENGINE_SAMPLE_RATE);
        let master_tap = Arc::new(AudioTap::new());
        let master_sink = Sink::connect_new(&output_mixer);
        master_sink.append(MasterBusSource { mixer_source, tap: master_tap.clone(), buf: [0.0; 2], buf_idx: 0 });

        AudioEngine {
            _stream_handle: stream_handle,
            output_mixer,
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
            physmod_gates: Mutex::new(HashMap::new()),
            next_physmod_voice: AtomicU64::new(1),
            physmod_instruments: Mutex::new(HashMap::new()),
            brass_gates: Mutex::new(HashMap::new()),
            next_brass_voice: AtomicU64::new(1),
            brass_players: Mutex::new(HashMap::new()),
            matter_kits: Mutex::new(HashMap::new()),
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

    /// The live instrument for `instrument` on `track_id`, started on the track's bus if it is not
    /// running (or was built for different strings - a new instrument preset).
    fn physmod_instrument(&self, track_id: &str, instrument: &str, params: &PhysModParams) -> Result<Arc<InstrumentHandle>, String> {
        let key = format!("{track_id}\u{1}{instrument}");
        let mut map = self.physmod_instruments.lock().unwrap();
        if let Some(h) = map.get(&key) {
            if h.is_alive() && h.same_tuning(params) {
                return Ok(h.clone());
            }
            // Different strings: let the old instrument ring out and stop, and build a new one.
            h.retire();
        }
        let shared = physmod::shared_for(instrument);
        let buses = self.track_buses.lock().unwrap();
        let bus = buses.get(track_id).ok_or_else(|| format!("track {track_id} has no bus"))?;
        let (voice, handle) = PhysModInstrumentVoice::new(shared, params);
        bus.note_mixer.add(voice);
        map.insert(key, handle.clone());
        Ok(handle)
    }

    /// Sends a note-on to the track's instrument, restarting the instrument once if it shut itself
    /// down (idle) between the check and the send.
    fn physmod_send_note(&self, track_id: &str, instrument: &str, mut cmd: InstrumentCommand, params: &PhysModParams) -> Result<Arc<InstrumentHandle>, String> {
        for _ in 0..2 {
            let h = self.physmod_instrument(track_id, instrument, params)?;
            match h.send(cmd) {
                Ok(()) => return Ok(h),
                Err(back) => cmd = back,
            }
        }
        Err("the bowed-string instrument could not be started".into())
    }

    /// Plays one timed bowed-string note on a track's bus. `instrument` names the `PhysModShared`
    /// the visualization widget reads (the DAW uses the track's id), created if it does not exist.
    /// The note is played on the track's live instrument, so it can slur into, double-stop with and
    /// ring in sympathy with the other notes on it.
    pub fn play_physmod_on_track(&self, track_id: &str, instrument: &str, params: PhysModParams) -> Result<(), String> {
        let id = self.next_physmod_voice.fetch_add(1, Ordering::Relaxed);
        self.physmod_send_note(track_id, instrument, InstrumentCommand::NoteOn { id, params, gated: false, live: None }, &params).map(|_| ())
    }

    /// Starts a bowed-string note that sounds until `physmod_note_off` (a key held down, or a note
    /// latched while dragging the bow). Returns the id to release and steer it with.
    pub fn physmod_note_on(&self, track_id: &str, instrument: &str, params: PhysModParams) -> Result<u64, String> {
        let live = Arc::new(physmod::PhysModLive::from_params(&params));
        let id = self.next_physmod_voice.fetch_add(1, Ordering::Relaxed);
        let instrument = self.physmod_send_note(track_id, instrument, InstrumentCommand::NoteOn { id, params, gated: true, live: Some(live.clone()) }, &params)?;
        let mut gates = self.physmod_gates.lock().unwrap();
        gates.retain(|_, h| h.instrument.is_alive());
        gates.insert(id, PhysModHandle { instrument, live });
        Ok(id)
    }

    /// Releases a note started by `physmod_note_on`. Unknown or already-finished ids are ignored.
    pub fn physmod_note_off(&self, voice_id: u64) {
        if let Some(h) = self.physmod_gates.lock().unwrap().remove(&voice_id) {
            let _ = h.instrument.send(InstrumentCommand::NoteOff { id: voice_id });
        }
    }

    /// Moves a held note's bow: `which` is "force", "velocity", "position" or "vibratoDepth".
    pub fn physmod_set_bow(&self, voice_id: u64, which: &str, value: f32) {
        if let Some(h) = self.physmod_gates.lock().unwrap().get(&voice_id) {
            let target = match which {
                "force" => &h.live.bow_force,
                "velocity" => &h.live.bow_velocity,
                "position" => &h.live.bow_position,
                "vibratoDepth" => &h.live.vibrato_depth,
                _ => return,
            };
            target.store(value.to_bits(), Ordering::Relaxed);
        }
    }

    /// The live brass player for `instrument` on `track_id`, started on the track's bus if it is not
    /// running (or plays a different instrument).
    fn brass_player(&self, track_id: &str, instrument: &str, params: &BrassParams) -> Result<Arc<BrassHandle>, String> {
        let key = format!("{track_id}\u{1}{instrument}");
        let mut map = self.brass_players.lock().unwrap();
        if let Some(h) = map.get(&key) {
            if h.is_alive() && h.same_instrument(params) {
                return Ok(h.clone());
            }
            h.retire();
        }
        let shared = brass::shared_for(instrument);
        let buses = self.track_buses.lock().unwrap();
        let bus = buses.get(track_id).ok_or_else(|| format!("track {track_id} has no bus"))?;
        // Building a player computes (once per instrument, cached) its resonance table: done here,
        // off the audio thread.
        let (voice, handle) = BrassInstrumentVoice::new(shared, params);
        bus.note_mixer.add(voice);
        map.insert(key, handle.clone());
        Ok(handle)
    }

    /// Sends a note-on to the track's brass player, restarting it once if it shut itself down
    /// (idle) between the check and the send.
    fn brass_send_note(&self, track_id: &str, instrument: &str, mut cmd: BrassCommand, params: &BrassParams) -> Result<Arc<BrassHandle>, String> {
        for _ in 0..2 {
            let h = self.brass_player(track_id, instrument, params)?;
            match h.send(cmd) {
                Ok(()) => return Ok(h),
                Err(back) => cmd = back,
            }
        }
        Err("the brass player could not be started".into())
    }

    /// Plays one timed brass note on a track's bus, on the track's live player (so a note that
    /// starts before the last one ends slurs into it). `instrument` names the `BrassShared` the
    /// view reads (the DAW uses the track's id).
    pub fn play_brass_on_track(&self, track_id: &str, instrument: &str, params: BrassParams) -> Result<(), String> {
        let id = self.next_brass_voice.fetch_add(1, Ordering::Relaxed);
        self.brass_send_note(track_id, instrument, BrassCommand::NoteOn { id, params, gated: false, live: None }, &params).map(|_| ())
    }

    /// Starts a brass note that sounds until `brass_note_off` (a key held down). Returns the id to
    /// release and steer it with.
    pub fn brass_note_on(&self, track_id: &str, instrument: &str, params: BrassParams) -> Result<u64, String> {
        let live = Arc::new(brass::BrassLive::from_params(&params));
        let id = self.next_brass_voice.fetch_add(1, Ordering::Relaxed);
        let player = self.brass_send_note(track_id, instrument, BrassCommand::NoteOn { id, params, gated: true, live: Some(live.clone()) }, &params)?;
        let mut gates = self.brass_gates.lock().unwrap();
        gates.retain(|_, h| h.player.is_alive());
        gates.insert(id, BrassNoteHandle { player, live });
        Ok(id)
    }

    /// Releases a note started by `brass_note_on`. Unknown or already-finished ids are ignored.
    pub fn brass_note_off(&self, voice_id: u64) {
        if let Some(h) = self.brass_gates.lock().unwrap().remove(&voice_id) {
            let _ = h.player.send(BrassCommand::NoteOff { id: voice_id });
        }
    }

    /// Moves a held brass note's live control: `which` is "breath", "lipTension", "vibratoDepth"
    /// or "bend" (cents).
    pub fn brass_set_control(&self, voice_id: u64, which: &str, value: f32) {
        if let Some(h) = self.brass_gates.lock().unwrap().get(&voice_id) {
            h.live.set(which, value);
        }
    }

    /// Makes sure `track_id` has a live kit of `spec` named `kit_id` (the `MatterShared` the view
    /// reads): starts building one off the audio thread if there is none or it is a different kit,
    /// and puts a finished one on the track's bus (retiring the kit it replaces). Cheap to call
    /// every frame. `Building` until the kit can be played.
    pub fn matter_prepare(&self, track_id: &str, kit_id: &str, spec: matter::KitSpec) -> Result<MatterStatus, String> {
        let spec = spec.clamped();
        let key = format!("{track_id}\u{1}{kit_id}");
        let mut map = self.matter_kits.lock().unwrap();
        let entry = map.entry(key).or_default();
        if entry.playing.as_ref().is_some_and(|h| !h.is_alive()) {
            entry.playing = None;
            entry.sympathetic = None;
            entry.mix = None;
        }
        let current = entry.playing.as_ref().is_some_and(|h| h.spec().same_build(&spec));
        // A build under way for another kit is abandoned (it finishes and is dropped).
        if entry.building.as_ref().is_some_and(|(b, _)| !b.same_build(&spec)) || current {
            entry.building = None;
        }
        if !current && entry.building.is_none() {
            let slot = Arc::new(Mutex::new(None));
            let out = slot.clone();
            std::thread::Builder::new()
                .name("matter-kit-build".into())
                .spawn(move || {
                    let kit = matter::Kit::new(spec, ENGINE_SAMPLE_RATE as f32);
                    *out.lock().unwrap_or_else(|p| p.into_inner()) = Some(kit);
                })
                .map_err(|e| format!("could not start building the kit: {e}"))?;
            entry.building = Some((spec, slot));
        }
        if let Some((_, slot)) = &entry.building {
            let built = slot.lock().unwrap_or_else(|p| p.into_inner()).take();
            if let Some(kit) = built {
                let buses = self.track_buses.lock().unwrap();
                let bus = buses.get(track_id).ok_or_else(|| format!("track {track_id} has no bus"))?;
                let (voice, handle) = matter::KitVoice::new(matter::live::shared_for(kit_id), kit);
                bus.note_mixer.add(voice);
                if let Some(old) = entry.playing.replace(handle) {
                    old.retire();
                }
                entry.building = None;
                entry.sympathetic = None;
                entry.mix = None;
            }
        }
        Ok(match (entry.playing.is_some(), entry.building.is_some()) {
            (true, false) => MatterStatus::Ready,
            (true, true) => MatterStatus::Rebuilding,
            (false, _) => MatterStatus::Building,
        })
    }

    /// Strikes a piece of the track's kit. `Ok(false)` while the kit is still being built (the hit
    /// is dropped: a kit is built once, ahead of playing - see `matter_prepare`). A kit being
    /// rebuilt with new tunings plays the hit on the old one meanwhile.
    pub fn play_matter_on_track(&self, track_id: &str, kit_id: &str, spec: matter::KitSpec, mix: [f32; matter::kit::PIECES], hit: matter::KitHit) -> Result<bool, String> {
        if self.matter_prepare(track_id, kit_id, spec)? == MatterStatus::Building {
            return Ok(false);
        }
        let key = format!("{track_id}\u{1}{kit_id}");
        let mut map = self.matter_kits.lock().unwrap();
        let Some(entry) = map.get_mut(&key) else { return Ok(false) };
        let Some(h) = entry.playing.clone() else { return Ok(false) };
        if entry.sympathetic != Some(spec.sympathetic) {
            let _ = h.send(matter::KitCommand::Sympathetic(spec.sympathetic));
            entry.sympathetic = Some(spec.sympathetic);
        }
        if entry.mix != Some(mix) {
            let _ = h.send(matter::KitCommand::Mix(mix));
            entry.mix = Some(mix);
        }
        Ok(h.send(matter::KitCommand::Strike(hit)).is_ok())
    }

    /// Holds a tool on a piece of the track's kit live - a drag in the view: `(x, y)` in metres from
    /// the centre of its face, `pressure` in newtons (0 lifts it). `Ok(false)` while the kit is being
    /// built.
    pub fn hold_matter_on_track(&self, track_id: &str, kit_id: &str, spec: matter::KitSpec, piece: matter::Piece, x: f32, y: f32, pressure: f32) -> Result<bool, String> {
        if self.matter_prepare(track_id, kit_id, spec)? == MatterStatus::Building {
            return Ok(false);
        }
        let key = format!("{track_id}\u{1}{kit_id}");
        let map = self.matter_kits.lock().unwrap();
        let Some(h) = map.get(&key).and_then(|e| e.playing.clone()) else { return Ok(false) };
        Ok(h.send(matter::KitCommand::Hold { piece, x, y, pressure }).is_ok())
    }

    /// Stops the track's kit (a deleted track).
    pub fn matter_remove(&self, track_id: &str, kit_id: &str) {
        if let Some(entry) = self.matter_kits.lock().unwrap().remove(&format!("{track_id}\u{1}{kit_id}")) {
            if let Some(h) = entry.playing {
                h.retire();
            }
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

        let sink = Sink::connect_new(&self.output_mixer);
        sink.append(source);
        sink.detach();
    }

    /// A `Sink` connected to this engine's mixer, kept undetached so the caller can drive
    /// it directly (`play`/`pause`/`set_volume`/`stop`) - used by `media_player::MediaPlayer`
    /// for decoded video audio, unlike the fire-and-forget synth sinks above.
    pub fn new_sink(&self) -> Sink {
        Sink::connect_new(&self.output_mixer)
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

        let sink = Sink::connect_new(&self.output_mixer);
        sink.append(finite_source);
        sink.detach();
    }
}

#[cfg(test)]
mod character_path_tests {
    use super::*;
    use character::{CharacterKind, CharacterParams, TrackBusRender};

    fn render_voice(voice: &str, params: &NoteParams, seconds: f32) -> Vec<f32> {
        let sr = 44_100.0;
        let mut node = build_voice_node(voice, params, sr);
        (0..(seconds * sr) as usize).map(|_| {
            let mut out = [0.0f32; 2];
            node.tick(&[], &mut out);
            out[0]
        }).collect()
    }

    /// Energy in harmonics 10..30 of 110 Hz relative to the fundamental: how open the filter is.
    fn brightness(x: &[f32]) -> f32 {
        let power = |freq: f32| {
            let (mut re, mut im) = (0.0f32, 0.0f32);
            for (i, v) in x.iter().enumerate() {
                let ph = std::f32::consts::TAU * freq * i as f32 / 44_100.0;
                re += v * ph.cos();
                im += v * ph.sin();
            }
            re * re + im * im
        };
        (10..=30).map(|k| power(110.0 * k as f32)).sum::<f32>() / power(110.0).max(1e-12)
    }

    #[test]
    fn acid_opens_the_filter_at_the_start_of_a_note_and_closes_it() {
        let base = NoteParams { freq: 110.0, duration: 0.6, cutoff: 300.0, resonance: 3.0, gain: 0.5, sustain: 1.0, ..Default::default() };
        let acid = NoteParams { filter_env: 4.0, filter_decay: 0.08, drive: 1.0, ..base };
        let plain = render_voice("saw", &base, 0.5);
        let squelch = render_voice("saw", &acid, 0.5);
        let early = 441..2646; // 10..60 ms
        let late = 17_640..22_050; // 400..500 ms
        assert!(brightness(&squelch[early.clone()]) > brightness(&squelch[late.clone()]) * 1.5, "the envelope sweeps down");
        assert!(brightness(&squelch[early.clone()]) > brightness(&plain[early]) * 1.5, "and opens well above the static cutoff");
        // Drive adds harmonics of its own on top.
        let driven = render_voice("saw", &NoteParams { drive: 6.0, ..acid }, 0.5);
        assert!(brightness(&driven[late.clone()]) > brightness(&squelch[late]) * 1.5, "drive adds bite");
        // A note without filter envelope or drive is built exactly as before.
        assert!(acid_shape(&base).is_none());
    }

    #[test]
    fn an_export_runs_a_tracks_bus_chain_over_its_notes_only() {
        let dir = std::env::temp_dir().join(format!("entropy-character-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pump.wav");
        // Two held sines, one per track; only the first track pumps. 120 bpm: beats every 0.5 s.
        let note = |freq: f64| NoteEvent {
            start_time: 0.0,
            voice: "sine".into(),
            params: NoteParams { freq, duration: 2.0, cutoff: 20_000.0, gain: 0.4, attack: 0.001, decay: 0.001, sustain: 1.0, release: 0.01, ..Default::default() },
        };
        let events = [note(220.0), note(5_512.5)];
        let buses = [TrackBusRender { gain: 1.0, effects: vec![CharacterParams { kind: CharacterKind::Pump, amount: 1.0, pattern: 0, bpm: 120.0, beat: None }], silences: vec![] }];
        let routing = MixRouting { buses: &buses, notes: &[Some(0), None], ..Default::default() };
        render_mix_to_wav(&events, &[], &[], &[], &[], &[], &[], &routing, 44_100, &path).unwrap();
        let samples: Vec<f32> = hound::WavReader::open(&path).unwrap().samples::<i16>().step_by(2).map(|s| s.unwrap() as f32 / 32768.0).collect();
        // Level over a 20 ms window at `t`, split by a crude filter: slow part = 220 Hz track.
        let window = |t: f32| {
            let start = (t * 44_100.0) as usize;
            let slice = &samples[start..start + 882];
            let smooth: Vec<f32> = slice.windows(8).map(|w| w.iter().sum::<f32>() / 8.0).collect();
            (smooth.iter().map(|v| v * v).sum::<f32>() / smooth.len() as f32).sqrt()
        };
        let ducked = window(1.01);
        let recovered = window(1.45);
        assert!(ducked < recovered * 0.4, "the pumped track ducks on the beat: {ducked} vs {recovered}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
