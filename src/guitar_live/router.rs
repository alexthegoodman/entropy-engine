//! Delivers the engine's note events to where they are played, and records them (spec OUT-1, OUT-2,
//! OUT-4). A thread of its own, woken by the input callback the moment events are queued, so a note
//! reaches the instrument as soon as it is decided rather than at the next poll.

use super::shared::Shared;
use super::voice::VoiceControl;
use crate::audio::vst3::Vst3Sender;
use crate::guitar::events::{bend_cents, midi_to_hz, GuitarEvent, GuitarEventKind, BEND_CENTER};
use rtrb::Consumer;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{JoinHandle, Thread};
use std::time::Duration;

/// Where notes go. Both can be set: the built-in voice and a VST3 instrument sound together.
#[derive(Clone, Default)]
pub struct Targets {
    pub voice: Option<Arc<VoiceControl>>,
    /// A hosted VST3 instrument's note queue, and the MIDI channel (0-15) to play it on.
    pub vst3: Option<(Vst3Sender, u8)>,
    /// Must match the receiving instrument's bend range (BND-5). The built-in voice is kept in sync
    /// by construction; a VST3 instrument has its own setting.
    pub bend_range: f32,
    pub reference_pitch: f32,
}

impl Targets {
    pub fn new() -> Self {
        Targets { voice: None, vst3: None, bend_range: 2.0, reference_pitch: 440.0 }
    }

    fn dispatch(&self, e: &GuitarEvent) {
        match e.kind {
            GuitarEventKind::NoteOn { note, velocity } => {
                if let Some(v) = &self.voice {
                    v.note_on(midi_to_hz(note as f32, self.reference_pitch), velocity);
                }
                if let Some((plugin, ch)) = &self.vst3 {
                    plugin.note_on_held(*ch, note, velocity);
                }
            }
            GuitarEventKind::NoteOff { note } => {
                if let Some(v) = &self.voice {
                    v.note_off();
                }
                if let Some((plugin, ch)) = &self.vst3 {
                    plugin.note_off(*ch, note);
                }
            }
            GuitarEventKind::PitchBend { value } => {
                if let Some(v) = &self.voice {
                    v.set_bend_cents(bend_cents(value, self.bend_range));
                }
                if let Some((plugin, ch)) = &self.vst3 {
                    plugin.pitch_bend(*ch, value);
                }
            }
        }
    }

    /// Silences everything this router may have started and centers the bend (EVT-6).
    pub fn release_all(&self) {
        if let Some(v) = &self.voice {
            v.note_off();
            v.set_bend_cents(0.0);
        }
        if let Some((plugin, ch)) = &self.vst3 {
            plugin.pitch_bend(*ch, BEND_CENTER);
            plugin.all_notes_off();
        }
    }
}

/// One recorded note, on the input's own clock.
#[derive(Clone, Debug, PartialEq)]
pub struct RecordedNote {
    pub note: u8,
    pub velocity: u8,
    /// Seconds from when recording was armed to the pick, and to the release. Taken from the events'
    /// source times, so detection latency is already compensated (spec 3.4).
    pub start_s: f32,
    pub end_s: f32,
    /// `(seconds since arming, cents from the note)` for every bend message while it sounded.
    pub bends: Vec<(f32, f32)>,
}

#[derive(Default)]
pub struct Recorder {
    armed: bool,
    origin: u64,
    sample_rate: f32,
    bend_range: f32,
    notes: Vec<RecordedNote>,
    open: Option<RecordedNote>,
}

impl Recorder {
    /// Starts a take. `now_sample` is the input position at this moment; every time in the take is
    /// measured from it.
    pub fn arm(&mut self, now_sample: u64, sample_rate: f32, bend_range: f32) {
        self.armed = true;
        self.origin = now_sample;
        self.sample_rate = sample_rate;
        self.bend_range = bend_range;
        self.notes.clear();
        self.open = None;
    }

    pub fn is_armed(&self) -> bool {
        self.armed
    }

    fn seconds(&self, sample: u64) -> f32 {
        sample.saturating_sub(self.origin) as f32 / self.sample_rate
    }

    fn on_event(&mut self, e: &GuitarEvent) {
        if !self.armed {
            return;
        }
        let t = self.seconds(e.source_sample);
        match e.kind {
            GuitarEventKind::NoteOn { note, velocity } => {
                self.close(t);
                self.open = Some(RecordedNote { note, velocity, start_s: t, end_s: t, bends: Vec::new() });
            }
            GuitarEventKind::NoteOff { .. } => self.close(t),
            GuitarEventKind::PitchBend { value } => {
                if let Some(n) = self.open.as_mut() {
                    n.bends.push((t, bend_cents(value, self.bend_range)));
                }
            }
        }
    }

    fn close(&mut self, t: f32) {
        if let Some(mut n) = self.open.take() {
            n.end_s = t.max(n.start_s);
            self.notes.push(n);
        }
    }

    /// Ends the take and returns its notes. A note still sounding ends now.
    pub fn stop(&mut self, now_sample: u64) -> Vec<RecordedNote> {
        let t = self.seconds(now_sample);
        self.close(t);
        self.armed = false;
        std::mem::take(&mut self.notes)
    }
}

pub struct RouterStats {
    pub routed: AtomicU64,
}

pub struct Router {
    handle: Option<JoinHandle<()>>,
    running: Arc<AtomicBool>,
    thread: Thread,
}

impl Router {
    pub fn spawn(mut events: Consumer<GuitarEvent>, targets: Arc<Mutex<Targets>>, recorder: Arc<Mutex<Recorder>>, shared: Arc<Shared>, stats: Arc<RouterStats>) -> Router {
        let running = Arc::new(AtomicBool::new(true));
        let flag = running.clone();
        let handle = std::thread::Builder::new()
            .name("guitar-router".into())
            .spawn(move || {
                let mut released_for_loss = false;
                while flag.load(Ordering::Acquire) {
                    while let Ok(e) = events.pop() {
                        let t = targets.lock().unwrap().clone();
                        t.dispatch(&e);
                        recorder.lock().unwrap().on_event(&e);
                        stats.routed.fetch_add(1, Ordering::Relaxed);
                    }
                    // The device went away: no callback will ever end the note, so end it here (spec 3.6).
                    if shared.device_lost.load(Ordering::Relaxed) {
                        if !released_for_loss {
                            targets.lock().unwrap().release_all();
                            released_for_loss = true;
                        }
                    } else {
                        released_for_loss = false;
                    }
                    std::thread::park_timeout(Duration::from_millis(20));
                }
                // Anything queued at the moment of stopping still gets delivered, then everything ends.
                while let Ok(e) = events.pop() {
                    let t = targets.lock().unwrap().clone();
                    t.dispatch(&e);
                    recorder.lock().unwrap().on_event(&e);
                }
                targets.lock().unwrap().release_all();
            })
            .expect("spawn the guitar router thread");
        let thread = handle.thread().clone();
        Router { handle: Some(handle), running, thread }
    }

    /// The handle the input callback unparks after queueing events.
    pub fn wake_handle(&self) -> Thread {
        self.thread.clone()
    }

    pub fn stop(&mut self) {
        self.running.store(false, Ordering::Release);
        self.thread.unpark();
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for Router {
    fn drop(&mut self) {
        self.stop();
    }
}
