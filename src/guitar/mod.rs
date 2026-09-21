//! Guitar-to-MIDI: a monophonic pitch-tracking engine that turns a guitar signal into note events.
//! Spec: `GUITAR_TO_MIDI.md`.
//!
//! Nothing in this module knows about the UI, the DAW's audio engine or an audio backend (OUT-5).
//! Samples go into `GuitarEngine::process`, events come out of an `EventSink`. That is what makes the
//! offline replay harness and the synthetic corpus in `testsig` possible.
//!
//! ```text
//! samples -> DC/low-pass -> level + onset -> tiered YIN/MPM -> tracker -> events
//! ```

pub mod calibrate;
pub mod config;
pub mod dsp;
pub mod engine;
pub mod events;
pub mod pitch;
pub mod replay;
pub mod testsig;
pub mod tracker;

pub use calibrate::{calibrate, gate_from_levels, velocity_range_from_levels, Calibration};
pub use config::{Algorithm, GuitarConfig, Mode, ModeParams, Tunables};
pub use engine::{Diagnostics, GuitarEngine};
pub use events::{bend_cents, bend_value, hz_to_midi, midi_to_hz, EventSink, GuitarEvent, GuitarEventKind, BEND_CENTER, BEND_MAX};
pub use pitch::{PitchDetector, PitchEstimate, TierDetector};
pub use tracker::{Tracker, TrackerState, TrackerStats};
