//! A physically modeled brass instrument: a player's lips, blown open by the breath, driving an air
//! column built from the instrument's real bore profile, radiating through its bell. See
//! `docs/PHYS_MOD_BRASS.md` for the plan this follows.
//!
//! The pieces, from the bottom up:
//!
//! * [`bore`] - the air column's shape: mouthpiece, leadpipe, cylinder (slide), bell. One
//!   description drives the acoustics and (later) the drawn instrument.
//! * [`impedance`] - the reference acoustics: the bore's input impedance by the transfer-matrix
//!   method, with wall losses and the mouth's radiation load. Where the resonances are, and how well
//!   they line up. Build time only.
//! * [`airbore`] - the same bore at audio rate: scattering cells for the mouthpiece and bell,
//!   fractional delay lines for the slide, lumped wall losses, the radiation load, and
//!   pressure-dependent propagation in the cylinder - the steepening wavefront that makes loud brass
//!   *brassy*.
//! * [`lips`] - the outward-striking lip valve and its Bernoulli flow, solved against the mouthpiece
//!   each sample.
//! * [`engine`] - the instrument and its player: partial and slide choice, lip setting, breath,
//!   tonguing, slurs, slide vibrato, intonation by ear, attack skill (and cracked notes).
//!
//! As with the strings, nothing here was tuned by listening: every behaviour is measured from
//! rendered audio in [`tests`](self), and the laws the player uses (`engine::lip_center`,
//! `engine::lip_mass`) were fitted from sweeps of the model itself.

pub mod airbore;
pub mod bore;
pub mod engine;
pub mod impedance;
pub mod lips;

#[cfg(test)]
mod tests;

pub use engine::{breath_pressure, lip_center, lip_mass, Articulation, BrassInstrument, BrassParams, BrassReport, Engine, Fingering};

/// Renders one note offline at `sr` Hz for `seconds` (held for the note's `duration`, then
/// released), mono. Also returns a report of the note taken just before its release.
pub fn render_note(p: &BrassParams, sr: f32, seconds: f32) -> (Vec<f32>, BrassReport) {
    let mut engine = Engine::new(sr, p);
    engine.note_on(1, *p, false);
    let n = (seconds * sr) as usize;
    let report_at = ((p.duration * sr) as usize).saturating_sub(64).min(n.saturating_sub(1));
    let mut report = BrassReport::default();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        out.push(engine.next_frame()[0]);
        if i == report_at {
            report = engine.report();
        }
    }
    (out, report)
}

/// A sequence of notes played by one player (so they can slur), for offline rendering.
#[derive(Clone, Copy, Debug)]
pub struct PerformedNote {
    /// Seconds from the start.
    pub start: f32,
    pub params: BrassParams,
}

/// Renders a phrase through one instrument, mono. Notes that overlap the previous one are slurred
/// into (or re-tongued, for `Articulation::Tongued`).
pub fn render_phrase(notes: &[PerformedNote], sr: f32, tail: f32) -> Vec<f32> {
    let Some(first) = notes.first() else { return Vec::new() };
    let mut engine = Engine::new(sr, &first.params);
    let end = notes.iter().map(|n| n.start + n.params.duration).fold(0.0f32, f32::max) + tail;
    let n = (end * sr) as usize;
    let mut out = Vec::with_capacity(n);
    let mut next = 0;
    let mut offs: Vec<(usize, u64)> = notes.iter().enumerate().map(|(i, n)| (((n.start + n.params.duration) * sr) as usize, i as u64 + 1)).collect();
    offs.sort_by_key(|o| o.0);
    let mut next_off = 0;
    for i in 0..n {
        while next < notes.len() && (notes[next].start * sr) as usize <= i {
            engine.note_on(next as u64 + 1, notes[next].params, true);
            next += 1;
        }
        while next_off < offs.len() && offs[next_off].0 <= i {
            engine.note_off(offs[next_off].1);
            next_off += 1;
        }
        out.push(engine.next_frame()[0]);
    }
    out
}
