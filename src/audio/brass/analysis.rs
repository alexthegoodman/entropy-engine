//! Listening by numbers, for brass: renders a note through the instrument and measures what a
//! musician would hear (pitch in cents, loudness, brightness, harmonic balance, how fast it spoke)
//! and what the player and air column did (partial, slide position, mouth pressure, how steep the
//! wavefront got). The same measurements back the AI tool (`Entropy.Brass.analyzeNote`) and the
//! tests, using the pitch and spectrum code the strings use.

use super::engine::{BrassParams, Engine};
use crate::audio::physmod::analysis::{measure, HARMONICS};

#[derive(Clone, Debug, Default)]
pub struct BrassAnalysis {
    pub f0: f32,
    pub cents: f32,
    pub rms_db: f32,
    pub peak_db: f32,
    pub centroid_hz: f32,
    /// Level of harmonics 1..=HARMONICS relative to the strongest, dB.
    pub harmonics_db: [f32; HARMONICS],
    /// The partial the player chose and the slide position (1..7) it was played in.
    pub partial: usize,
    pub position: f32,
    /// Mouth pressure (Pa) and mouthpiece AC level (Pa rms) while held.
    pub mouth_pressure: f32,
    pub mouthpiece_level: f32,
    /// Steepest slope of the wave arriving at the bell over the analysis window, Pa/s.
    pub wave_steepness: f32,
    /// Seconds from note-on until the sound reached 90% of its settled level, `None` if it never
    /// spoke.
    pub attack_secs: Option<f32>,
}

/// Renders `p` held for `seconds` and analyses the last `window` seconds of the held part.
pub fn analyze_note(p: &BrassParams, seconds: f32, window: f32) -> BrassAnalysis {
    let sr = crate::audio::analysis::ENGINE_SAMPLE_RATE as f32;
    let p = BrassParams { duration: seconds, ..*p };
    let mut engine = Engine::new(sr, &p);
    engine.note_on(1, p, true, None);
    let n = (seconds * sr) as usize;
    let w0 = n.saturating_sub((window * sr) as usize);
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        out.push(engine.next_frame()[0]);
        if i == w0 {
            // Clears the steepness gathered before the window.
            let _ = engine.report();
        }
    }
    let r = engine.report();
    let seg = &out[w0..];
    let m = measure(seg, sr, p.freq);
    let rms = |x: &[f32]| (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt();
    let full = rms(seg);
    let block = (0.005 * sr) as usize;
    let attack_secs = (full > 1.0e-6).then(|| out.chunks(block).position(|c| rms(c) > 0.9 * full)).flatten().map(|b| b as f32 * 0.005);
    BrassAnalysis {
        f0: m.f0,
        cents: m.cents,
        rms_db: m.rms_db,
        peak_db: m.peak_db,
        centroid_hz: m.centroid_hz,
        harmonics_db: m.harmonics_db,
        partial: r.partial,
        position: r.position,
        mouth_pressure: r.mouth_pressure,
        mouthpiece_level: r.mouthpiece_level,
        wave_steepness: r.wave_steepness,
        attack_secs,
    }
}
