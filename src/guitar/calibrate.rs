//! Calibration (spec 3.1): stay silent for a few seconds, then play soft and hard notes. The first
//! sets the gate above the room, the second sets the velocity range to what this guitar and interface
//! actually deliver. Pure functions over recorded samples, so the same code runs in the panel and in a
//! test.

use super::config::GuitarConfig;
use super::dsp::amp_to_db;

/// Gate margin above the loudest stretch of room noise, dB.
const GATE_OPEN_MARGIN_DB: f32 = 8.0;
/// Hysteresis between open and close, dB.
const GATE_HYSTERESIS_DB: f32 = 6.0;
/// The gate never sits lower than this, even in a silent room: converter noise and the gate's own
/// resolution make anything under it meaningless.
const GATE_FLOOR_DB: f32 = -70.0;
/// RMS window used to measure, milliseconds. The same as the engine's level window.
const WINDOW_MS: f32 = 15.0;

/// Levels found by calibration.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Calibration {
    pub gate_open_db: f32,
    pub gate_close_db: f32,
    pub velocity_floor_db: f32,
    pub velocity_ceil_db: f32,
}

impl Calibration {
    /// Writes the levels into a config.
    pub fn apply(&self, cfg: &mut GuitarConfig) {
        cfg.gate_open_db = self.gate_open_db;
        cfg.gate_close_db = self.gate_close_db;
        cfg.velocity_floor_db = self.velocity_floor_db;
        cfg.velocity_ceil_db = self.velocity_ceil_db;
    }
}

/// RMS levels (dBFS) of consecutive windows, hopping by half a window.
fn window_levels(samples: &[f32], sample_rate: f32) -> Vec<f32> {
    let win = ((WINDOW_MS * sample_rate / 1000.0) as usize).max(8);
    let hop = win / 2;
    let mut out = Vec::new();
    let mut i = 0;
    while i + win <= samples.len() {
        let e: f32 = samples[i..i + win].iter().map(|v| v * v).sum();
        out.push(amp_to_db((e / win as f32).sqrt()));
        i += hop;
    }
    out
}

/// The gate thresholds for a room: above the loudest window of `noise` by a margin, so that what was
/// recorded never opens it. Fewer than two windows of noise leaves the defaults.
pub fn gate_from_noise(noise: &[f32], sample_rate: f32, defaults: &GuitarConfig) -> (f32, f32) {
    gate_from_levels(&window_levels(noise, sample_rate), defaults)
}

/// Same, from levels (dBFS) already measured, which is what the live input collects: it has no raw
/// samples to keep, only the engine's own level readings.
pub fn gate_from_levels(levels: &[f32], defaults: &GuitarConfig) -> (f32, f32) {
    let Some(loudest) = levels.iter().copied().reduce(f32::max) else {
        return (defaults.gate_open_db, defaults.gate_close_db);
    };
    // Never below the shipped defaults' spirit of a floor, and never above -20 dBFS, which would gate real playing.
    let open = (loudest + GATE_OPEN_MARGIN_DB).clamp(GATE_FLOOR_DB, -20.0);
    (open, (open - GATE_HYSTERESIS_DB).max(GATE_FLOOR_DB - GATE_HYSTERESIS_DB))
}

/// The velocity range from a stretch of playing: the softest note's level to the hardest's. A note is
/// a run of windows above the gate; its level is its loudest window. Returns `None` if fewer than two
/// notes were found or they are indistinguishable in level.
pub fn velocity_range_from_playing(playing: &[f32], sample_rate: f32, gate_open_db: f32) -> Option<(f32, f32)> {
    let win = ((WINDOW_MS * sample_rate / 1000.0) as usize).max(8);
    velocity_range_from_levels(&window_levels(playing, sample_rate), (win / 2) as f32 / sample_rate * 1000.0, gate_open_db)
}

/// The velocity range from levels measured every `step_ms`.
pub fn velocity_range_from_levels(levels: &[f32], step_ms: f32, gate_open_db: f32) -> Option<(f32, f32)> {
    // A note ends after about 60 ms under the gate; a shorter dip is inside the note.
    let quiet_windows = (60.0 / step_ms.max(0.5)).ceil() as usize;
    let mut peaks: Vec<f32> = Vec::new();
    let mut run_peak: Option<f32> = None;
    let mut quiet = 0;
    for &l in levels {
        if l >= gate_open_db {
            run_peak = Some(run_peak.map_or(l, |p| p.max(l)));
            quiet = 0;
        } else {
            quiet += 1;
            if quiet >= quiet_windows {
                if let Some(p) = run_peak.take() {
                    peaks.push(p);
                }
            }
        }
    }
    if let Some(p) = run_peak {
        peaks.push(p);
    }
    if peaks.len() < 2 {
        return None;
    }
    let lo = peaks.iter().copied().fold(f32::MAX, f32::min);
    let hi = peaks.iter().copied().fold(f32::MIN, f32::max);
    // Leave a little room so the softest note is not exactly velocity 1 and the hardest is exactly 127.
    (hi - lo >= 3.0).then_some((lo - 3.0, hi))
}

/// Full calibration from a silent stretch and a stretch of soft and hard playing.
pub fn calibrate(silence: &[f32], playing: &[f32], sample_rate: f32, defaults: &GuitarConfig) -> Calibration {
    let (open, close) = gate_from_noise(silence, sample_rate, defaults);
    let (floor, ceil) = velocity_range_from_playing(playing, sample_rate, open).unwrap_or((defaults.velocity_floor_db, defaults.velocity_ceil_db));
    Calibration { gate_open_db: open, gate_close_db: close, velocity_floor_db: floor, velocity_ceil_db: ceil }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guitar::testsig::{self, Pluck};

    #[test]
    fn the_gate_lands_above_the_room_and_below_playing() {
        let fs = 48_000.0;
        let mut room = vec![0.0f32; (3.0 * fs) as usize];
        testsig::add_hum(&mut room, fs, 60.0, -42.0);
        testsig::add_noise(&mut room, -58.0, 5);
        let (open, close) = gate_from_noise(&room, fs, &GuitarConfig::default());
        assert!(open > -42.0 && open < -25.0, "open {open}");
        assert!(close < open);
    }

    #[test]
    fn a_silent_room_keeps_the_gate_low_but_not_below_the_floor() {
        let (open, _) = gate_from_noise(&vec![0.0; 48_000], 48_000.0, &GuitarConfig::default());
        assert!(open >= GATE_FLOOR_DB + GATE_OPEN_MARGIN_DB - 20.0 && open <= -55.0, "{open}");
    }

    #[test]
    fn velocity_range_spans_the_softest_and_hardest_note_played() {
        let fs = 48_000.0;
        let (x, _) = testsig::mix(fs, 6.0, &[
            Pluck::note(52).starting(0.2).loud(-38.0).ringing(0.6),
            Pluck::note(55).starting(1.5).loud(-26.0).ringing(0.6),
            Pluck::note(59).starting(2.8).loud(-10.0).ringing(0.6),
        ]);
        let (floor, ceil) = velocity_range_from_playing(&x, fs, -55.0).expect("range");
        assert!(ceil - floor > 20.0, "{floor}..{ceil}");
        assert!(ceil > -20.0 && floor < -35.0, "{floor}..{ceil}");
    }

    #[test]
    fn one_note_is_not_a_range() {
        let (x, _) = testsig::mix(48_000.0, 2.0, &[Pluck::note(52).starting(0.2).ringing(0.6)]);
        assert!(velocity_range_from_playing(&x, 48_000.0, -55.0).is_none());
    }
}
