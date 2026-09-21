//! State the audio thread publishes and the UI reads (spec DIA-2). Every field is an atomic, so the
//! audio thread never waits on the UI. A reader can see fields from two adjacent callbacks mixed
//! together; for a display that refreshes 60 times a second that is invisible, and it is what buys
//! the wait-free write.

use crate::guitar::tracker::TrackerStats;
use crate::guitar::{Diagnostics, TrackerState};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

pub struct AtomicF32(AtomicU32);

impl AtomicF32 {
    pub fn new(v: f32) -> Self {
        AtomicF32(AtomicU32::new(v.to_bits()))
    }

    pub fn load(&self) -> f32 {
        f32::from_bits(self.0.load(Ordering::Relaxed))
    }

    pub fn store(&self, v: f32) {
        self.0.store(v.to_bits(), Ordering::Relaxed);
    }

    /// Raises the stored value to `v` if `v` is larger. Wait-free for one writer.
    pub fn fetch_max(&self, v: f32) {
        let mut cur = self.0.load(Ordering::Relaxed);
        while v > f32::from_bits(cur) {
            match self.0.compare_exchange_weak(cur, v.to_bits(), Ordering::Relaxed, Ordering::Relaxed) {
                Ok(_) => break,
                Err(actual) => cur = actual,
            }
        }
    }

    pub fn take(&self) -> f32 {
        f32::from_bits(self.0.swap(0.0f32.to_bits(), Ordering::Relaxed))
    }
}

/// No note sounding.
const NO_NOTE: u32 = 255;

pub struct Shared {
    pub level_db: AtomicF32,
    pub freq_hz: AtomicF32,
    pub confidence: AtomicF32,
    pub cents: AtomicF32,
    pub tier: AtomicU32,
    pub note: AtomicU32,
    pub state: AtomicU32,
    pub velocity: AtomicU32,
    pub bend: AtomicU32,
    pub last_latency_samples: AtomicU64,
    pub notes: AtomicU64,
    pub noise_rejects: AtomicU64,
    pub octave_rejects: AtomicU64,
    pub octave_corrections: AtomicU64,
    pub slides: AtomicU64,
    pub repicks: AtomicU64,
    /// Largest absolute input sample since the UI last took it.
    pub input_peak: AtomicF32,
    /// Latched when the input reached -1 dBFS; cleared by the UI.
    pub clipped: AtomicBool,
    pub callbacks: AtomicU64,
    /// Callbacks whose DSP took longer than the audio it covered.
    pub overruns: AtomicU64,
    /// Errors the audio backend reported (xruns among them).
    pub stream_errors: AtomicU64,
    pub max_callback_us: AtomicU32,
    pub mean_callback_us: AtomicF32,
    pub dropped_bends: AtomicU64,
    /// Note events that did not fit the queue. Must stay 0.
    pub dropped_events: AtomicU64,
    pub buffer_frames: AtomicU32,
    pub sample_rate: AtomicU32,
    pub position: AtomicU64,
    pub device_lost: AtomicBool,
    pub running: AtomicBool,
    /// Calibration progress, written by the audio thread and read by the UI: see `CalState`.
    pub cal_state: AtomicU32,
    pub cal_a: AtomicF32,
    pub cal_b: AtomicF32,
}

/// What calibration is doing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CalState {
    Idle = 0,
    ListeningToSilence = 1,
    ListeningToPlaying = 2,
    /// The gate is measured; `cal_a` is open, `cal_b` is close.
    SilenceDone = 3,
    /// The velocity range is measured; `cal_a` is the floor, `cal_b` the ceiling.
    PlayingDone = 4,
    /// Nothing usable was heard.
    Failed = 5,
}

impl CalState {
    pub fn from_u32(v: u32) -> CalState {
        match v {
            1 => CalState::ListeningToSilence,
            2 => CalState::ListeningToPlaying,
            3 => CalState::SilenceDone,
            4 => CalState::PlayingDone,
            5 => CalState::Failed,
            _ => CalState::Idle,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            CalState::Idle => "idle",
            CalState::ListeningToSilence => "listening to the room",
            CalState::ListeningToPlaying => "listening to you play",
            CalState::SilenceDone => "room measured",
            CalState::PlayingDone => "playing measured",
            CalState::Failed => "nothing usable heard",
        }
    }
}

impl Shared {
    pub fn new() -> Self {
        Shared {
            level_db: AtomicF32::new(-120.0),
            freq_hz: AtomicF32::new(0.0),
            confidence: AtomicF32::new(0.0),
            cents: AtomicF32::new(0.0),
            tier: AtomicU32::new(0),
            note: AtomicU32::new(NO_NOTE),
            state: AtomicU32::new(0),
            velocity: AtomicU32::new(0),
            bend: AtomicU32::new(8192),
            last_latency_samples: AtomicU64::new(0),
            notes: AtomicU64::new(0),
            noise_rejects: AtomicU64::new(0),
            octave_rejects: AtomicU64::new(0),
            octave_corrections: AtomicU64::new(0),
            slides: AtomicU64::new(0),
            repicks: AtomicU64::new(0),
            input_peak: AtomicF32::new(0.0),
            clipped: AtomicBool::new(false),
            callbacks: AtomicU64::new(0),
            overruns: AtomicU64::new(0),
            stream_errors: AtomicU64::new(0),
            max_callback_us: AtomicU32::new(0),
            mean_callback_us: AtomicF32::new(0.0),
            dropped_bends: AtomicU64::new(0),
            dropped_events: AtomicU64::new(0),
            buffer_frames: AtomicU32::new(0),
            sample_rate: AtomicU32::new(0),
            position: AtomicU64::new(0),
            device_lost: AtomicBool::new(false),
            running: AtomicBool::new(false),
            cal_state: AtomicU32::new(0),
            cal_a: AtomicF32::new(0.0),
            cal_b: AtomicF32::new(0.0),
        }
    }

    /// Called from the audio thread once per callback.
    pub fn publish(&self, d: &Diagnostics, position: u64) {
        let r = Ordering::Relaxed;
        self.level_db.store(d.level_db);
        self.freq_hz.store(d.freq_hz);
        self.confidence.store(d.confidence);
        self.cents.store(d.cents);
        self.tier.store(d.tier as u32, r);
        self.note.store(d.note.map_or(NO_NOTE, |n| n as u32), r);
        self.state.store(d.state as u32, r);
        self.velocity.store(d.velocity as u32, r);
        self.bend.store(d.bend as u32, r);
        self.last_latency_samples.store(d.last_latency_samples, r);
        self.notes.store(d.stats.notes, r);
        self.noise_rejects.store(d.stats.noise_rejects, r);
        self.octave_rejects.store(d.stats.octave_rejects, r);
        self.octave_corrections.store(d.stats.octave_corrections, r);
        self.slides.store(d.stats.slides, r);
        self.repicks.store(d.stats.repicks, r);
        self.position.store(position, r);
    }

    pub fn snapshot(&self) -> LiveDiagnostics {
        let r = Ordering::Relaxed;
        let rate = self.sample_rate.load(r).max(1) as f32;
        let note = self.note.load(r);
        LiveDiagnostics {
            level_db: self.level_db.load(),
            input_peak: self.input_peak.load(),
            clipped: self.clipped.load(r),
            freq_hz: self.freq_hz.load(),
            confidence: self.confidence.load(),
            tier: self.tier.load(r) as u8,
            note: (note != NO_NOTE).then_some(note as u8),
            cents: self.cents.load(),
            state: match self.state.load(r) {
                1 => TrackerState::Attack,
                2 => TrackerState::Playing,
                3 => TrackerState::Release,
                _ => TrackerState::Silent,
            },
            velocity: self.velocity.load(r) as u8,
            bend: self.bend.load(r) as u16,
            pipeline_latency_ms: self.last_latency_samples.load(r) as f32 / rate * 1000.0,
            stats: TrackerStats {
                notes: self.notes.load(r),
                noise_rejects: self.noise_rejects.load(r),
                octave_rejects: self.octave_rejects.load(r),
                octave_corrections: self.octave_corrections.load(r),
                slides: self.slides.load(r),
                repicks: self.repicks.load(r),
            },
            callbacks: self.callbacks.load(r),
            overruns: self.overruns.load(r),
            stream_errors: self.stream_errors.load(r),
            max_callback_us: self.max_callback_us.load(r),
            mean_callback_us: self.mean_callback_us.load(),
            dropped_bends: self.dropped_bends.load(r),
            dropped_events: self.dropped_events.load(r),
            buffer_frames: self.buffer_frames.load(r),
            sample_rate: self.sample_rate.load(r),
            buffer_ms: self.buffer_frames.load(r) as f32 / rate * 1000.0,
            device_lost: self.device_lost.load(r),
            running: self.running.load(r),
        }
    }
}

/// What the diagnostics panel shows (DIA-1).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LiveDiagnostics {
    pub level_db: f32,
    /// Peak since the previous snapshot was taken with `take_peak`.
    pub input_peak: f32,
    pub clipped: bool,
    pub freq_hz: f32,
    pub confidence: f32,
    pub tier: u8,
    pub note: Option<u8>,
    pub cents: f32,
    pub state: TrackerState,
    pub velocity: u8,
    pub bend: u16,
    /// Pick to Note On inside the engine, for the last note. Does not include the device buffer.
    pub pipeline_latency_ms: f32,
    pub stats: TrackerStats,
    pub callbacks: u64,
    pub overruns: u64,
    pub stream_errors: u64,
    pub max_callback_us: u32,
    pub mean_callback_us: f32,
    pub dropped_bends: u64,
    pub dropped_events: u64,
    pub buffer_frames: u32,
    pub sample_rate: u32,
    /// One input buffer, in milliseconds. Device and driver add their own on top.
    pub buffer_ms: f32,
    pub device_lost: bool,
    pub running: bool,
}
