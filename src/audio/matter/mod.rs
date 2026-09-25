//! Physically modeled sounding objects: bodies that ring as sets of modes, and the interactions
//! between them - contact first. See `docs/PHYS_MOD_SOUNDS.md` for the plan this follows.
//!
//! * [`bessel`] - `J_m` and its zeros, for the shapes of circular membranes (and later plates).
//! * [`modal`] - a body as a set of exactly-integrated modes, with the two numbers a contact needs
//!   at any point: where it will be, and how far a newton moves it.
//! * [`contact`] - *Object A <-> contact <-> Object B*: Hertz and felt contact laws with
//!   Hunt-Crossley losses, solved implicitly every sample; strikers.
//! * [`membrane`] - a drumhead: Bessel modes, computed air loading and radiation, tension
//!   modulation.
//! * [`cavity`] - the air inside a drum as acoustic modes, coupling its heads.
//! * [`drum`] - heads, the air between them, strikers: kick, toms, timpani.
//!
//! As with the strings and the brass, every behaviour is measured from rendered audio in the tests,
//! not tuned by ear.

pub mod bessel;
pub mod cavity;
pub mod contact;
pub mod drum;
pub mod membrane;
pub mod modal;

#[cfg(test)]
mod tests;

pub use contact::{Contact, ContactLaw, Material, Striker, Tip};
pub use drum::{Drum, DrumKind, DrumSpec, Strike, StrikerSpec};
pub use membrane::{HeadSpec, Membrane};
pub use modal::{ModalBody, ModeSpec};

/// Renders one strike of `spec` offline at `sr` Hz for `seconds`, mono.
pub fn render_hit(spec: &DrumSpec, strike: Strike, sr: f32, seconds: f32) -> Vec<f32> {
    let mut drum = Drum::new(*spec, sr);
    drum.strike(strike);
    (0..(seconds * sr) as usize).map(|_| drum.next_sample()).collect()
}

/// Renders a sequence of strikes `(seconds from the start, strike)` on one drum, so later hits land
/// on a head that is still ringing (a roll builds up; a flam is two contacts on one head). Mono.
pub fn render_hits(spec: &DrumSpec, hits: &[(f32, Strike)], sr: f32, tail: f32) -> Vec<f32> {
    let mut drum = Drum::new(*spec, sr);
    let mut order: Vec<&(f32, Strike)> = hits.iter().collect();
    order.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let end = order.last().map(|h| h.0).unwrap_or(0.0) + tail;
    let mut next = 0;
    (0..(end * sr) as usize)
        .map(|i| {
            while next < order.len() && (order[next].0 * sr) as usize <= i {
                drum.strike(order[next].1);
                next += 1;
            }
            drum.next_sample()
        })
        .collect()
}
