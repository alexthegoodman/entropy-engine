//! `Entropy.Guitar` ops: thin JSON-in/JSON-out wrappers over `crate::guitar_live`. Like the VST3 ops,
//! every failure is `{ ok: false, error }` rather than a throw: an interface that is unplugged or a
//! driver that will not open is an ordinary runtime condition for the addon's UI to show.
//!
//! The session lives in a `thread_local!` on the JS thread. That is the thread the VST3 instruments
//! live on too, and `GuitarSession::play_vst3` needs it: the plugin registry is thread-affine.

use crate::deno::addon_ops::AddonContext;
use crate::guitar::{GuitarConfig, Mode, Tunables};
use crate::guitar_live::{list_input_devices, CalState, GuitarSession, InputRequest, OpenedInput, Waveform};
use deno_core::{op2, OpState};
use serde::Deserialize;
use serde_json::json;
use std::cell::RefCell;

type Json = serde_json::Value;

struct Live {
    session: GuitarSession,
    opened: OpenedInput,
}

thread_local! {
    static LIVE: RefCell<Option<Live>> = const { RefCell::new(None) };
}

fn err(message: impl Into<String>) -> Json {
    json!({ "ok": false, "error": message.into() })
}

#[op2]
#[serde]
pub fn op_guitar_list_inputs() -> Json {
    let devices: Vec<Json> = list_input_devices()
        .into_iter()
        .map(|d| json!({ "host": d.host, "name": d.name, "channels": d.channels, "defaultSampleRate": d.default_sample_rate, "isDefault": d.is_default }))
        .collect();
    let hosts: Vec<String> = cpal::available_hosts().iter().map(|h| h.name().to_string()).collect();
    json!({ "devices": devices, "hosts": hosts })
}

/// Settings that can change while playing. Anything left out keeps its value.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GuitarTunables {
    pub mode: Option<String>,
    pub sensitivity: Option<f32>,
    pub gate_open_db: Option<f32>,
    pub gate_close_db: Option<f32>,
    pub bend_range: Option<f32>,
    pub reference_pitch: Option<f32>,
    pub input_gain_db: Option<f32>,
    pub onset_db: Option<f32>,
    pub velocity_floor_db: Option<f32>,
    pub velocity_ceil_db: Option<f32>,
    pub velocity_gamma: Option<f32>,
}

impl GuitarTunables {
    fn apply_to(&self, base: Tunables) -> Result<Tunables, String> {
        let mut t = base;
        if let Some(name) = &self.mode {
            t.mode = Mode::from_name(name).ok_or_else(|| format!("no responsiveness mode '{name}' (fast, balanced, accurate)"))?;
        }
        macro_rules! set {
            ($field:ident) => {
                if let Some(v) = self.$field {
                    t.$field = v;
                }
            };
        }
        set!(sensitivity);
        set!(gate_open_db);
        set!(gate_close_db);
        set!(bend_range);
        set!(reference_pitch);
        set!(input_gain_db);
        set!(onset_db);
        set!(velocity_floor_db);
        set!(velocity_ceil_db);
        set!(velocity_gamma);
        Ok(t)
    }
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GuitarStartConfig {
    pub host: Option<String>,
    pub device: Option<String>,
    /// Zero-based input channel.
    pub channel: Option<usize>,
    pub sample_rate: Option<u32>,
    pub buffer_frames: Option<u32>,
    #[serde(flatten)]
    pub tunables: GuitarTunables,
    /// Play the built-in voice on this track's bus.
    pub track_id: Option<String>,
    pub waveform: Option<String>,
    /// Play the VST3 instrument hosted on this track, on `vst3_channel` (0-15).
    pub vst3_track: Option<String>,
    pub vst3_channel: Option<u8>,
}

fn point_output(live: &mut Live, audio: &crate::audio::AudioEngine, track: Option<&str>, waveform: Option<&str>, vst3_track: Option<&str>, vst3_channel: u8) -> Result<(), String> {
    match track.filter(|t| !t.is_empty()) {
        Some(t) => {
            let w = match waveform {
                Some(name) => Waveform::from_name(name).ok_or_else(|| format!("no waveform '{name}' (sine, triangle, saw, square)"))?,
                None => Waveform::Saw,
            };
            live.session.play_built_in(audio, t, w)?;
        }
        None => live.session.silence_built_in(),
    }
    match vst3_track.filter(|t| !t.is_empty()) {
        Some(t) => live.session.play_vst3(t, vst3_channel)?,
        None => live.session.stop_vst3(),
    }
    Ok(())
}

fn opened_json(o: &OpenedInput) -> Json {
    json!({
        "host": o.host, "device": o.device, "sampleRate": o.sample_rate, "channels": o.channels,
        "bufferFrames": o.buffer_frames, "sampleFormat": o.sample_format, "notes": o.notes,
    })
}

/// Opens the input and starts turning it into notes. Stops a running session first.
#[op2]
#[serde]
pub fn op_guitar_start(state: &mut OpState, #[serde] config: GuitarStartConfig) -> Json {
    let Some(ctx) = state.try_borrow::<AddonContext>() else { return err("Context not available") };
    let audio = ctx.audio_engine.clone();

    LIVE.with(|cell| {
        if let Some(mut old) = cell.borrow_mut().take() {
            old.session.stop();
        }
    });

    let mut cfg = GuitarConfig::default();
    match config.tunables.apply_to(cfg.tunables()) {
        Ok(t) => cfg.apply_tunables(&t),
        Err(e) => return err(e),
    }
    let req = InputRequest {
        host: config.host.clone().filter(|h| !h.is_empty()),
        device: config.device.clone().filter(|d| !d.is_empty()),
        channel: config.channel.unwrap_or(0),
        sample_rate: config.sample_rate.unwrap_or(48_000),
        buffer_frames: config.buffer_frames.unwrap_or(128),
    };
    let (session, opened) = match GuitarSession::start(cfg, req) {
        Ok(pair) => pair,
        Err(e) => return err(e),
    };
    let mut live = Live { session, opened };
    if let Err(e) = point_output(&mut live, &audio, config.track_id.as_deref(), config.waveform.as_deref(), config.vst3_track.as_deref(), config.vst3_channel.unwrap_or(0)) {
        live.session.stop();
        return err(e);
    }
    let out = json!({ "ok": true, "opened": opened_json(&live.opened) });
    LIVE.with(|cell| *cell.borrow_mut() = Some(live));
    out
}

#[op2]
#[serde]
pub fn op_guitar_stop() -> Json {
    LIVE.with(|cell| {
        if let Some(mut live) = cell.borrow_mut().take() {
            live.session.stop();
        }
    });
    json!({ "ok": true })
}

/// Changes a setting while playing: mode, gate, sensitivity, bend range, reference pitch, gain.
#[op2]
#[serde]
pub fn op_guitar_set(#[serde] config: GuitarTunables) -> Json {
    LIVE.with(|cell| {
        let mut guard = cell.borrow_mut();
        let Some(live) = guard.as_mut() else { return err("the guitar input is not running") };
        match config.apply_to(live.session.config().tunables()) {
            Ok(t) => {
                live.session.set_tunables(t);
                json!({ "ok": true })
            }
            Err(e) => err(e),
        }
    })
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct GuitarTarget {
    pub track_id: Option<String>,
    pub waveform: Option<String>,
    pub vst3_track: Option<String>,
    pub vst3_channel: Option<u8>,
}

/// Points the notes somewhere else while playing. An empty or missing `trackId` stops the built-in
/// voice; an empty or missing `vst3Track` stops the plugin.
#[op2]
#[serde]
pub fn op_guitar_target(state: &mut OpState, #[serde] target: GuitarTarget) -> Json {
    let Some(ctx) = state.try_borrow::<AddonContext>() else { return err("Context not available") };
    let audio = ctx.audio_engine.clone();
    LIVE.with(|cell| {
        let mut guard = cell.borrow_mut();
        let Some(live) = guard.as_mut() else { return err("the guitar input is not running") };
        match point_output(live, &audio, target.track_id.as_deref(), target.waveform.as_deref(), target.vst3_track.as_deref(), target.vst3_channel.unwrap_or(0)) {
            Ok(()) => json!({ "ok": true }),
            Err(e) => err(e),
        }
    })
}

/// Everything the panel shows, in one call: input level, the engine's reading, the tracker, timing
/// and errors. Also finishes a calibration that has completed, and reports it once.
#[op2]
#[serde]
pub fn op_guitar_status() -> Json {
    LIVE.with(|cell| {
        let mut guard = cell.borrow_mut();
        let Some(live) = guard.as_mut() else { return json!({ "running": false }) };
        let finished = live.session.apply_calibration();
        let peak = live.session.take_peak(false);
        let d = live.session.diagnostics();
        let (cal, _, _) = live.session.calibration();
        let c = live.session.config();
        // What the driver really delivers can differ from what it accepted: WASAPI shared mode takes any
        // fixed buffer size and then runs on its own 10 ms period. Only a measured callback shows it.
        let buffer_note = match live.opened.buffer_frames {
            Some(asked) if d.buffer_frames > 0 && d.buffer_frames != asked => Some(format!(
                "Asked for {asked} frames, the driver gives {} ({:.1} ms): its own period.",
                d.buffer_frames, d.buffer_ms
            )),
            _ => None,
        };
        json!({
            "running": d.running && !d.device_lost,
            "deviceLost": d.device_lost,
            "opened": opened_json(&live.opened),
            "recording": live.session.is_recording(),
            "bufferNote": buffer_note,
            "calibration": {
                "state": cal.name(),
                "busy": matches!(cal, CalState::ListeningToSilence | CalState::ListeningToPlaying),
                "finished": finished.map(|f| match f { CalState::SilenceDone => "room", CalState::PlayingDone => "playing", _ => "failed" }),
            },
            "settings": {
                "mode": c.mode.name(), "sensitivity": c.sensitivity, "gateOpenDb": c.gate_open_db, "gateCloseDb": c.gate_close_db,
                "bendRange": c.bend_range, "referencePitch": c.reference_pitch, "inputGainDb": c.input_gain_db,
                "velocityFloorDb": c.velocity_floor_db, "velocityCeilDb": c.velocity_ceil_db,
            },
            "diagnostics": {
                "levelDb": d.level_db,
                "inputPeakDb": 20.0 * peak.max(1e-6).log10(),
                "clipped": d.clipped,
                "freqHz": d.freq_hz,
                "confidence": d.confidence,
                "note": d.note,
                "cents": d.cents,
                "state": d.state.name(),
                "velocity": d.velocity,
                "bend": d.bend,
                "pipelineLatencyMs": d.pipeline_latency_ms,
                "bufferMs": d.buffer_ms,
                "bufferFrames": d.buffer_frames,
                "sampleRate": d.sample_rate,
                "callbacks": d.callbacks,
                "overruns": d.overruns,
                "streamErrors": d.stream_errors,
                "maxCallbackUs": d.max_callback_us,
                "meanCallbackUs": d.mean_callback_us,
                "droppedBends": d.dropped_bends,
                "droppedEvents": d.dropped_events,
                "notes": d.stats.notes,
                "noiseRejects": d.stats.noise_rejects,
                "octaveRejects": d.stats.octave_rejects,
                "octaveCorrections": d.stats.octave_corrections,
                "slides": d.stats.slides,
                "repicks": d.stats.repicks,
            }
        })
    })
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GuitarCalibrate {
    /// `false` listens to the room, `true` to soft and hard notes.
    pub playing: bool,
    pub seconds: Option<f32>,
}

#[op2]
#[serde]
pub fn op_guitar_calibrate(#[serde] config: GuitarCalibrate) -> Json {
    LIVE.with(|cell| {
        let guard = cell.borrow();
        let Some(live) = guard.as_ref() else { return err("the guitar input is not running") };
        let default = if config.playing { 5.0 } else { 3.0 };
        live.session.calibrate(config.playing, config.seconds.unwrap_or(default));
        json!({ "ok": true })
    })
}

/// `"start"` begins a take, `"stop"` ends it and returns the notes with pick times already corrected for
/// detection latency: `{ note, velocity, startS, endS, bends: [[seconds, cents], ...] }`.
#[op2]
#[serde]
pub fn op_guitar_record(#[string] action: String) -> Json {
    LIVE.with(|cell| {
        let guard = cell.borrow();
        let Some(live) = guard.as_ref() else { return err("the guitar input is not running") };
        match action.as_str() {
            "start" => {
                live.session.arm_recording();
                json!({ "ok": true })
            }
            "stop" => {
                let notes: Vec<Json> = live
                    .session
                    .stop_recording()
                    .into_iter()
                    .map(|n| json!({ "note": n.note, "velocity": n.velocity, "startS": n.start_s, "endS": n.end_s, "bends": n.bends }))
                    .collect();
                json!({ "ok": true, "notes": notes })
            }
            other => err(format!("record action must be 'start' or 'stop', not '{other}'")),
        }
    })
}

#[op2]
#[serde]
pub fn op_guitar_release_all() -> Json {
    LIVE.with(|cell| {
        if let Some(live) = cell.borrow().as_ref() {
            live.session.release_all();
        }
    });
    json!({ "ok": true })
}

/// Ends the session when the app shuts down, so no note is left held on a plugin.
pub fn shutdown() {
    LIVE.with(|cell| {
        if let Some(mut live) = cell.borrow_mut().take() {
            live.session.stop();
        }
    });
}
