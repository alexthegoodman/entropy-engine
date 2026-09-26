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
//! * [`drum`] - heads, the air between them, strikers: kick, toms, timpani, snare.
//! * [`plate`] - a free-edge circular plate or shallow dome: bending modes, the dome's stiffness,
//!   radiation, and the von Karman couplings.
//! * [`vonkarman`] - those couplings run on the modes with an energy-conserving scheme.
//! * [`cymbal`] - crash, ride, splash.
//! * [`friction`] - friction between any two surfaces (the bow's law, generalized), and surface
//!   roughness.
//! * [`surface`] - a face's mode shapes and slopes at any point, for contacts that move.
//! * [`rub`] - a tool pressed and dragged: brushes, fingers, rubber, rods; strokes and live holds.
//! * [`sheet`] - a flat free plate of glass, steel or wood, to rub.
//! * [`kit`] - the drums and cymbals set up together, hearing each other through the air.
//! * [`live`] - the kit on a track: what it publishes for the view, the live voice, offline
//!   rendering of a track's hits.
//!
//! As with the strings and the brass, every behaviour is measured from rendered audio in the tests,
//! not tuned by ear.

pub mod bessel;
pub mod bubble;
pub mod cavity;
pub mod contact;
pub mod drop;
pub mod cymbal;
pub mod drum;
pub mod friction;
pub mod kit;
pub mod live;
pub mod membrane;
pub mod modal;
pub mod plate;
pub mod rain;
pub mod rub;
pub mod sheet;
pub mod surface;
pub mod vessel;
pub mod vonkarman;
pub mod water;
pub mod water_voice;
pub mod waves;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod cymbal_tests;
#[cfg(test)]
mod kit_tests;
#[cfg(test)]
mod rub_tests;
#[cfg(test)]
mod water_tests;

pub use contact::{Contact, ContactLaw, Material, Striker, Tip};
pub use cymbal::{Cymbal, CymbalKind, CymbalSpec};
pub use drum::{Drum, DrumKind, DrumSpec, Strike, StrikerSpec};
pub use kit::{Kit, KitHit, KitSpec, Piece};
pub use live::{render_performance, KitCommand, KitHandle, KitVoice, MatterShared};
pub use membrane::{HeadSpec, Membrane};
pub use modal::{ModalBody, ModeSpec};
pub use plate::{Plate, PlateOptions, PlateSpec};
pub use rub::{Path, Rub, RubReport, Stroke, SurfaceKind, ToolSpec};
pub use sheet::{Sheet, SheetSpec};

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

/// Renders a sequence of strikes `(seconds from the start, strike)` on one cymbal. Mono.
pub fn render_cymbal(spec: &CymbalSpec, hits: &[(f32, Strike)], sr: f32, tail: f32) -> Vec<f32> {
    let mut c = Cymbal::new(*spec, sr);
    let mut order: Vec<&(f32, Strike)> = hits.iter().collect();
    order.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    let end = order.last().map(|h| h.0).unwrap_or(0.0) + tail;
    let mut next = 0;
    (0..(end * sr) as usize)
        .map(|i| {
            while next < order.len() && (order[next].0 * sr) as usize <= i {
                c.strike(order[next].1);
                next += 1;
            }
            c.next_sample()
        })
        .collect()
}

/// Renders a stroke on one drum offline, mono (the drum ringing from nothing before it).
pub fn render_drum_stroke(spec: &DrumSpec, stroke: Stroke, sr: f32, tail: f32) -> Vec<f32> {
    let mut drum = Drum::new(*spec, sr);
    drum.rub(stroke);
    (0..((stroke.duration + tail) * sr) as usize).map(|_| drum.next_sample()).collect()
}

/// Renders a stroke on a sheet offline, mono.
pub fn render_sheet_stroke(spec: &SheetSpec, stroke: Stroke, sr: f32, tail: f32) -> Vec<f32> {
    let mut sheet = Sheet::new(*spec, stroke.tool, sr);
    sheet.rub(stroke);
    (0..((stroke.duration + tail) * sr) as usize).map(|_| sheet.next_sample()).collect()
}
