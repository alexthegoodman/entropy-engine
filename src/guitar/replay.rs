//! Offline replay harness (spec section 6.1): samples in, events and diagnostics out, no device.
//! Feeds the engine in device-sized blocks so any behavior that depends on where a buffer boundary
//! falls shows up here too.

use super::config::GuitarConfig;
use super::engine::{Diagnostics, GuitarEngine};
use super::events::{GuitarEvent, GuitarEventKind, BEND_CENTER};

pub struct Replay {
    pub events: Vec<GuitarEvent>,
    pub diagnostics: Diagnostics,
    pub samples: u64,
}

/// Runs `samples` through a fresh engine in blocks of `block`, then releases whatever still sounds
/// (as stopping does), so the event stream is closed.
pub fn run(cfg: &GuitarConfig, samples: &[f32], block: usize) -> Replay {
    let mut engine = GuitarEngine::new(cfg.clone());
    let mut events = Vec::new();
    for chunk in samples.chunks(block.max(1)) {
        engine.process(chunk, &mut events);
    }
    let sounding_at_end = engine.diagnostics().note.is_some();
    engine.release_all(&mut events);
    let _ = sounding_at_end;
    Replay { diagnostics: engine.diagnostics(), samples: samples.len() as u64, events }
}

/// One note as the events describe it.
#[derive(Clone, Debug, PartialEq)]
pub struct NoteSpan {
    pub note: u8,
    pub velocity: u8,
    /// When the Note On was emitted, and the pick it describes.
    pub on: u64,
    pub on_source: u64,
    pub off: Option<u64>,
    pub off_source: Option<u64>,
    /// Every bend sent while it sounded: sample and 14-bit value.
    pub bends: Vec<(u64, u16)>,
}

pub fn spans(events: &[GuitarEvent]) -> Vec<NoteSpan> {
    let mut out: Vec<NoteSpan> = Vec::new();
    for e in events {
        match e.kind {
            GuitarEventKind::NoteOn { note, velocity } => out.push(NoteSpan {
                note,
                velocity,
                on: e.sample,
                on_source: e.source_sample,
                off: None,
                off_source: None,
                bends: Vec::new(),
            }),
            GuitarEventKind::NoteOff { .. } => {
                if let Some(s) = out.last_mut() {
                    s.off = Some(e.sample);
                    s.off_source = Some(e.source_sample);
                }
            }
            GuitarEventKind::PitchBend { value } => {
                if let Some(s) = out.last_mut() {
                    if s.off.is_none() {
                        s.bends.push((e.sample, value));
                    }
                }
            }
        }
    }
    out
}

/// The event-stream invariants of spec section 6.4. `Err` names the first one broken.
pub fn check_well_formed(events: &[GuitarEvent]) -> Result<(), String> {
    let mut active: Option<u8> = None;
    let mut bend = BEND_CENTER;
    let mut last_sample = 0u64;
    for (i, e) in events.iter().enumerate() {
        if e.sample < last_sample {
            return Err(format!("event {i} goes back in time: {} after {}", e.sample, last_sample));
        }
        last_sample = e.sample;
        if e.source_sample > e.sample {
            return Err(format!("event {i} describes the future: source {} after emit {}", e.source_sample, e.sample));
        }
        match e.kind {
            GuitarEventKind::NoteOn { note, velocity } => {
                if let Some(n) = active {
                    return Err(format!("event {i}: Note On {note} while {n} is still on"));
                }
                if !(1..=127).contains(&velocity) {
                    return Err(format!("event {i}: velocity {velocity}"));
                }
                if bend != BEND_CENTER {
                    return Err(format!("event {i}: Note On with the bend at {bend}, not centered"));
                }
                active = Some(note);
            }
            GuitarEventKind::NoteOff { note } => match active {
                Some(n) if n == note => active = None,
                Some(n) => return Err(format!("event {i}: Note Off {note} but {n} is on")),
                None => return Err(format!("event {i}: Note Off {note} with nothing on")),
            },
            GuitarEventKind::PitchBend { value } => {
                if value > 16383 {
                    return Err(format!("event {i}: bend {value} is not 14 bit"));
                }
                bend = value;
            }
        }
    }
    if let Some(n) = active {
        return Err(format!("note {n} never got a Note Off"));
    }
    if bend != BEND_CENTER {
        return Err(format!("stream ends with the bend at {bend}"));
    }
    Ok(())
}

/// Outcome of playing one plucked note through a fresh engine.
#[derive(Clone, Debug)]
pub struct NoteTrial {
    pub expected: u8,
    pub note_ons: Vec<(u8, u8)>,
    pub note_offs: usize,
    /// Milliseconds from the true pick to the first Note On.
    pub latency_ms: Option<f32>,
    /// The first Note On's note, if there was one.
    pub first: Option<u8>,
    pub events: Vec<GuitarEvent>,
    pub well_formed: Result<(), String>,
}

impl NoteTrial {
    pub fn correct(&self) -> bool {
        self.first == Some(self.expected)
    }

    /// Wrong by a whole number of octaves.
    pub fn octave_error(&self) -> bool {
        self.first.map_or(false, |n| n != self.expected && (n as i32 - self.expected as i32) % 12 == 0)
    }
}

/// Plays `pluck` alone in `seconds` of recording. The standard trial behind the accuracy and latency tables.
pub fn trial(cfg: &GuitarConfig, pluck: &super::testsig::Pluck, seconds: f32, block: usize) -> NoteTrial {
    let (x, truth) = super::testsig::mix(cfg.sample_rate, seconds, std::slice::from_ref(pluck));
    let r = run(cfg, &x, block);
    let ons: Vec<(u8, u8)> = r.events.iter().filter_map(|e| if let GuitarEventKind::NoteOn { note, velocity } = e.kind { Some((note, velocity)) } else { None }).collect();
    let first_on = r.events.iter().find(|e| matches!(e.kind, GuitarEventKind::NoteOn { .. }));
    NoteTrial {
        expected: truth[0].midi,
        first: ons.first().map(|o| o.0),
        latency_ms: first_on.map(|e| (e.sample as f32 - truth[0].onset as f32) / cfg.sample_rate * 1000.0),
        note_offs: r.events.iter().filter(|e| matches!(e.kind, GuitarEventKind::NoteOff { .. })).count(),
        well_formed: check_well_formed(&r.events),
        note_ons: ons,
        events: r.events,
    }
}

/// Nearest-rank percentile of `values` (0..=100).
pub fn percentile(values: &mut [f32], p: f32) -> f32 {
    if values.is_empty() {
        return f32::NAN;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let rank = ((p / 100.0) * values.len() as f32).ceil() as usize;
    values[rank.clamp(1, values.len()) - 1]
}
