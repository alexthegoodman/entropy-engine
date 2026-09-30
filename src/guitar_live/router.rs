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

/// Voices in the built-in pool: one per string. The monophonic engine only ever uses one at a time.
pub const POOL: usize = 6;

/// Where notes go. Both can be set: the built-in voices and a VST3 instrument sound together.
#[derive(Clone, Default)]
pub struct Targets {
    /// The built-in voices, one per string, and the note each holds (if its gate is open).
    pub voices: Vec<Arc<VoiceControl>>,
    held: [Option<u8>; POOL],
    /// Which voice was given a note most recently, per voice, to steal the oldest when all are busy.
    age: [u64; POOL],
    clock: u64,
    /// A hosted VST3 instrument's note queue, and the MIDI channel (0-15) to play it on.
    pub vst3: Option<(Vst3Sender, u8)>,
    /// Must match the receiving instrument's bend range (BND-5). The built-in voice is kept in sync
    /// by construction; a VST3 instrument has its own setting.
    pub bend_range: f32,
    pub reference_pitch: f32,
}

impl Targets {
    pub fn new() -> Self {
        Targets { bend_range: 2.0, reference_pitch: 440.0, ..Default::default() }
    }

    /// Replaces the built-in voices (an empty list silences them).
    pub fn set_voices(&mut self, voices: Vec<Arc<VoiceControl>>) {
        self.voices = voices;
        self.held = [None; POOL];
    }

    /// The voice to play `note` on: the one already holding it, else a free one (the one freed
    /// longest ago, so a release tail is not cut), else the one that started longest ago.
    fn pick_voice(&self, note: u8) -> Option<usize> {
        let n = self.voices.len().min(POOL);
        if n == 0 {
            return None;
        }
        if let Some(i) = (0..n).find(|&i| self.held[i] == Some(note)) {
            return Some(i);
        }
        (0..n).filter(|&i| self.held[i].is_none()).min_by_key(|&i| self.age[i]).or_else(|| (0..n).min_by_key(|&i| self.age[i]))
    }

    fn dispatch(&mut self, e: &GuitarEvent) {
        match e.kind {
            GuitarEventKind::NoteOn { note, velocity } => {
                if let Some(i) = self.pick_voice(note) {
                    self.clock += 1;
                    self.age[i] = self.clock;
                    self.held[i] = Some(note);
                    self.voices[i].note_on(midi_to_hz(note as f32, self.reference_pitch), velocity);
                }
                if let Some((plugin, ch)) = &self.vst3 {
                    plugin.note_on_held(*ch, note, velocity);
                }
            }
            GuitarEventKind::NoteOff { note } => {
                for i in 0..self.voices.len().min(POOL) {
                    if self.held[i] == Some(note) {
                        self.held[i] = None;
                        self.clock += 1;
                        self.age[i] = self.clock;
                        self.voices[i].note_off();
                    }
                }
                if let Some((plugin, ch)) = &self.vst3 {
                    plugin.note_off(*ch, note);
                }
            }
            GuitarEventKind::PitchBend { value } => {
                // Only the monophonic engine bends, and it holds one note at a time.
                for v in &self.voices {
                    v.set_bend_cents(bend_cents(value, self.bend_range));
                }
                if let Some((plugin, ch)) = &self.vst3 {
                    plugin.pitch_bend(*ch, value);
                }
            }
        }
    }

    /// Silences everything this router may have started and centers the bend (EVT-6).
    pub fn release_all(&mut self) {
        for v in &self.voices {
            v.note_off();
            v.set_bend_cents(0.0);
        }
        self.held = [None; POOL];
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
    /// Notes sounding now: one for the monophonic engine, up to a string each for the chord detector.
    open: Vec<RecordedNote>,
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
        self.open.clear();
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
                self.close(Some(note), t);
                self.open.push(RecordedNote { note, velocity, start_s: t, end_s: t, bends: Vec::new() });
            }
            GuitarEventKind::NoteOff { note } => self.close(Some(note), t),
            GuitarEventKind::PitchBend { value } => {
                for n in self.open.iter_mut() {
                    n.bends.push((t, bend_cents(value, self.bend_range)));
                }
            }
        }
    }

    /// Ends `note` (every open note when `None`) at `t`. Notes are kept in the order they started.
    fn close(&mut self, note: Option<u8>, t: f32) {
        let mut i = 0;
        while i < self.open.len() {
            if note.map_or(true, |n| self.open[i].note == n) {
                let mut n = self.open.remove(i);
                n.end_s = t.max(n.start_s);
                self.notes.push(n);
            } else {
                i += 1;
            }
        }
        self.notes.sort_by(|a, b| a.start_s.total_cmp(&b.start_s));
    }

    /// Ends the take and returns its notes. A note still sounding ends now.
    pub fn stop(&mut self, now_sample: u64) -> Vec<RecordedNote> {
        let t = self.seconds(now_sample);
        self.close(None, t);
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
                        targets.lock().unwrap().dispatch(&e);
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
                    targets.lock().unwrap().dispatch(&e);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: GuitarEventKind, sample: u64) -> GuitarEvent {
        GuitarEvent { kind, sample, source_sample: sample }
    }

    #[test]
    fn a_chord_takes_a_voice_per_note_and_a_note_off_frees_only_its_own() {
        let mut t = Targets::new();
        let voices: Vec<_> = (0..POOL).map(|_| VoiceControl::new()).collect();
        t.set_voices(voices.clone());
        for n in [40u8, 47, 52] {
            t.dispatch(&ev(GuitarEventKind::NoteOn { note: n, velocity: 100 }, 0));
        }
        assert_eq!(voices.iter().filter(|v| v.is_gated()).count(), 3);
        t.dispatch(&ev(GuitarEventKind::NoteOff { note: 47 }, 10));
        assert_eq!(voices.iter().filter(|v| v.is_gated()).count(), 2);
        // The freed voice is not the first one reused while an older free one exists.
        t.release_all();
        assert!(voices.iter().all(|v| !v.is_gated()));
    }

    #[test]
    fn more_notes_than_voices_steal_the_oldest() {
        let mut t = Targets::new();
        let voices: Vec<_> = (0..2).map(|_| VoiceControl::new()).collect();
        t.set_voices(voices.clone());
        for n in [40u8, 47, 52] {
            t.dispatch(&ev(GuitarEventKind::NoteOn { note: n, velocity: 100 }, 0));
        }
        assert_eq!(t.held[..2].iter().flatten().copied().collect::<Vec<_>>().len(), 2);
        assert!(!t.held.contains(&Some(40)), "the oldest note should have been stolen: {:?}", t.held);
    }

    #[test]
    fn the_recorder_keeps_overlapping_notes() {
        let mut r = Recorder::default();
        r.arm(0, 1000.0, 2.0);
        r.on_event(&ev(GuitarEventKind::NoteOn { note: 40, velocity: 90 }, 0));
        r.on_event(&ev(GuitarEventKind::NoteOn { note: 47, velocity: 80 }, 100));
        r.on_event(&ev(GuitarEventKind::NoteOff { note: 40 }, 500));
        let notes = r.stop(1000);
        assert_eq!(notes.len(), 2);
        assert_eq!((notes[0].note, notes[0].start_s, notes[0].end_s), (40, 0.0, 0.5));
        assert_eq!((notes[1].note, notes[1].start_s, notes[1].end_s), (47, 0.1, 1.0));
    }
}
