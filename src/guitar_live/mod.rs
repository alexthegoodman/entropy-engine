//! Live guitar-to-MIDI: the parts of `GUITAR_TO_MIDI.md` that touch a device, a thread or the
//! DAW's audio. The engine itself lives in `crate::guitar` and knows none of this.
//!
//! ```text
//! device callback -> GuitarPipeline -> [lock-free queue] -> Router -> built-in voice / VST3 / recorder
//!     (audio thread)   engine.process                        (own thread)
//! ```
//!
//! Everything on the left of the queue runs on the audio thread and neither allocates nor locks.
//! `GuitarSession` owns the whole chain and is what the addon ops drive.

pub mod input;
pub mod pipeline;
pub mod router;
pub mod shared;
pub mod voice;

pub use input::{list_input_devices, InputDevice, InputRequest, OpenedInput};
pub use pipeline::{Control, GuitarPipeline, PipelineParts};
pub use router::{RecordedNote, Recorder, Router, Targets};
pub use shared::{CalState, LiveDiagnostics, Shared};
pub use voice::{GuitarVoice, VoiceControl, Waveform};

use crate::audio::AudioEngine;
use crate::guitar::{GuitarConfig, GuitarEvent, Tunables};
use router::RouterStats;
use rtrb::RingBuffer;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

pub struct GuitarSession {
    shared: Arc<Shared>,
    targets: Arc<Mutex<Targets>>,
    recorder: Arc<Mutex<Recorder>>,
    controls: Mutex<rtrb::Producer<Control>>,
    router: Router,
    stats: Arc<RouterStats>,
    input: Option<input::InputHandle>,
    cfg: GuitarConfig,
    voice: Option<Arc<VoiceControl>>,
}

/// Feeds a session from code instead of a device: a test, or a "play this file through it" tool.
/// It is the same `GuitarPipeline` the device callback drives.
pub struct SyntheticInput {
    pipeline: GuitarPipeline,
}

impl SyntheticInput {
    pub fn feed(&mut self, mono: &[f32]) {
        self.pipeline.process_mono(mono);
    }
}

impl GuitarSession {
    fn build(cfg: GuitarConfig, channel: usize) -> (GuitarSession, PipelineParts) {
        let shared = Arc::new(Shared::new());
        let (event_tx, event_rx) = RingBuffer::<GuitarEvent>::new(pipeline::EVENT_QUEUE);
        let (control_tx, control_rx) = RingBuffer::<Control>::new(pipeline::CONTROL_QUEUE);
        let mut targets = Targets::new();
        targets.bend_range = cfg.bend_range_clamped();
        targets.reference_pitch = cfg.reference_pitch;
        let targets = Arc::new(Mutex::new(targets));
        let recorder = Arc::new(Mutex::new(Recorder::default()));
        let stats = Arc::new(RouterStats { routed: Default::default() });
        let router = Router::spawn(event_rx, targets.clone(), recorder.clone(), shared.clone(), stats.clone());
        let parts = PipelineParts { cfg: cfg.clone(), channel, events: event_tx, controls: control_rx, shared: shared.clone(), wake: router.wake_handle() };
        (
            GuitarSession { shared, targets, recorder, controls: Mutex::new(control_tx), router, stats, input: None, cfg, voice: None },
            parts,
        )
    }

    /// Opens the device and starts listening. The engine is built for the sample rate the device
    /// actually runs at, which may differ from the one asked for (see `OpenedInput::notes`).
    pub fn start(cfg: GuitarConfig, req: InputRequest) -> Result<(GuitarSession, OpenedInput), String> {
        let (mut session, parts) = GuitarSession::build(cfg, req.channel);
        let shared = session.shared.clone();
        // The engine is built inside the stream thread at the rate the device really runs at.
        let handle = input::open_input(req, shared, move |rate| parts.build(rate as f32))?;
        let opened = handle.opened.clone();
        session.input = Some(handle);
        session.cfg.sample_rate = opened.sample_rate as f32;
        Ok((session, opened))
    }

    /// A session with no device. Feed it with the returned `SyntheticInput`.
    pub fn synthetic(cfg: GuitarConfig) -> (GuitarSession, SyntheticInput) {
        let rate = cfg.sample_rate;
        let (session, parts) = GuitarSession::build(cfg, 0);
        session.shared.running.store(true, Ordering::Release);
        (session, SyntheticInput { pipeline: parts.build(rate) })
    }

    pub fn diagnostics(&self) -> LiveDiagnostics {
        self.shared.snapshot()
    }

    /// Takes the input peak since the last call (for the level meter) and clears the clip latch when
    /// `clear_clip` is set.
    pub fn take_peak(&self, clear_clip: bool) -> f32 {
        if clear_clip {
            self.shared.clipped.store(false, Ordering::Relaxed);
        }
        self.shared.input_peak.take()
    }

    pub fn config(&self) -> &GuitarConfig {
        &self.cfg
    }

    /// Changes a setting while playing. Takes effect within the next input buffer.
    pub fn set_tunables(&mut self, t: Tunables) {
        self.cfg.apply_tunables(&t);
        if let Ok(mut c) = self.controls.lock() {
            let _ = c.push(Control::Tunables(t));
        }
        let mut targets = self.targets.lock().unwrap();
        targets.bend_range = self.cfg.bend_range_clamped();
        targets.reference_pitch = self.cfg.reference_pitch;
    }

    /// Plays notes on a built-in voice added to `track_id`'s bus (which must already exist).
    pub fn play_built_in(&mut self, audio: &AudioEngine, track_id: &str, waveform: Waveform) -> Result<(), String> {
        if let Some(old) = self.voice.take() {
            old.stop();
        }
        let ctl = VoiceControl::new();
        ctl.set_waveform(waveform);
        if !audio.add_track_source(track_id, GuitarVoice::new(ctl.clone())) {
            return Err(format!("track '{track_id}' has no audio bus to play on"));
        }
        self.targets.lock().unwrap().voice = Some(ctl.clone());
        self.voice = Some(ctl);
        Ok(())
    }

    pub fn set_waveform(&self, w: Waveform) {
        if let Some(v) = &self.voice {
            v.set_waveform(w);
        }
    }

    /// Plays notes on the VST3 instrument hosted on `track_id`, as well as (or instead of) the
    /// built-in voice. Must be called on the main thread, where the plugin registry lives; the router
    /// then talks to the plugin's queue from its own thread.
    pub fn play_vst3(&mut self, track_id: &str, channel: u8) -> Result<(), String> {
        let sender = crate::audio::vst3::with_instrument(track_id, |i| i.sender())
            .ok_or_else(|| format!("track '{track_id}' has no VST3 instrument loaded (or this is not the main thread)"))?;
        self.targets.lock().unwrap().vst3 = Some((sender, channel.min(15)));
        Ok(())
    }

    /// Stops sending notes to a VST3 instrument, releasing whatever it holds.
    pub fn stop_vst3(&mut self) {
        let mut targets = self.targets.lock().unwrap();
        if let Some((plugin, ch)) = targets.vst3.take() {
            plugin.pitch_bend(ch, crate::guitar::BEND_CENTER);
            plugin.all_notes_off();
        }
    }

    /// Stops playing on the built-in voice, releasing whatever it holds.
    pub fn silence_built_in(&mut self) {
        if let Some(v) = self.voice.take() {
            v.stop();
        }
        self.targets.lock().unwrap().voice = None;
    }

    pub fn arm_recording(&self) {
        let now = self.shared.position.load(Ordering::Relaxed);
        self.recorder.lock().unwrap().arm(now, self.cfg.sample_rate, self.cfg.bend_range_clamped());
    }

    pub fn stop_recording(&self) -> Vec<RecordedNote> {
        let now = self.shared.position.load(Ordering::Relaxed);
        self.recorder.lock().unwrap().stop(now)
    }

    pub fn is_recording(&self) -> bool {
        self.recorder.lock().unwrap().is_armed()
    }

    /// Events delivered to the instrument so far.
    pub fn routed(&self) -> u64 {
        self.stats.routed.load(Ordering::Relaxed)
    }

    /// Starts measuring. `playing = false` listens to the room for `seconds` and sets the gate above
    /// it; `playing = true` listens to soft and hard notes and sets the velocity range. Poll
    /// `calibration()` for the outcome.
    pub fn calibrate(&self, playing: bool, seconds: f32) {
        if let Ok(mut c) = self.controls.lock() {
            let _ = c.push(Control::Calibrate { playing, seconds });
        }
    }

    /// The calibration state, and its two numbers when it has finished.
    pub fn calibration(&self) -> (CalState, f32, f32) {
        let r = Ordering::Acquire;
        (CalState::from_u32(self.shared.cal_state.load(r)), self.shared.cal_a.load(), self.shared.cal_b.load())
    }

    /// Takes a finished calibration into the running settings and returns to idle. `None` when nothing
    /// has finished yet.
    pub fn apply_calibration(&mut self) -> Option<CalState> {
        let (state, a, b) = self.calibration();
        let mut t = self.cfg.tunables();
        match state {
            CalState::SilenceDone => {
                t.gate_open_db = a;
                t.gate_close_db = b;
            }
            CalState::PlayingDone => {
                t.velocity_floor_db = a;
                t.velocity_ceil_db = b;
            }
            CalState::Failed => {
                self.shared.cal_state.store(CalState::Idle as u32, Ordering::Release);
                return Some(CalState::Failed);
            }
            _ => return None,
        }
        self.set_tunables(t);
        self.shared.cal_state.store(CalState::Idle as u32, Ordering::Release);
        Some(state)
    }

    /// Records that the input device went away. The backend calls this itself when it reports the
    /// device gone; it is public so a test, or a device-change notification, can too. The router ends
    /// every note it started (spec 3.6).
    pub fn mark_device_lost(&self) {
        self.shared.stream_errors.fetch_add(1, Ordering::Relaxed);
        self.shared.device_lost.store(true, Ordering::Release);
    }

    /// Releases every held note and centers the bend, wherever they are playing (EVT-6).
    pub fn release_all(&self) {
        if let Ok(mut c) = self.controls.lock() {
            let _ = c.push(Control::ReleaseAll);
        }
        self.targets.lock().unwrap().release_all();
    }

    /// Stops the device, releases every note and ends the router. Idempotent.
    pub fn stop(&mut self) {
        if let Some(mut input) = self.input.take() {
            input.stop();
        }
        self.router.stop();
        if let Some(v) = self.voice.take() {
            v.stop();
        }
        self.shared.running.store(false, Ordering::Release);
    }
}

impl Drop for GuitarSession {
    fn drop(&mut self) {
        self.stop();
    }
}
