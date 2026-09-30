//! Guitar-to-MIDI: turns a guitar signal into note events, one note at a time (a pitch tracker with
//! pitch bend) or several (a chord detector).
//! Spec: `GUITAR_TO_MIDI.md`.
//!
//! Nothing in this module knows about the UI, the DAW's audio engine or an audio backend (OUT-5).
//! Samples go into `GuitarEngine::process`, events come out of an `EventSink`. That is what makes the
//! offline replay harness and the synthetic corpus in `testsig` possible.
//!
//! ```text
//! mono: samples -> DC/low-pass -> level + onset -> tiered YIN/MPM -> tracker -> events
//! poly: samples -> DC -> level + spectral-flux onset -> iterative multi-pitch -> chord tracker -> events
//! ```

pub mod calibrate;
pub mod config;
pub mod dsp;
pub mod engine;
pub mod events;
pub mod pitch;
pub mod poly;
pub mod poly_engine;
pub mod replay;
pub mod tab;
pub mod testsig;
pub mod tracker;

pub use calibrate::{calibrate, gate_from_levels, velocity_range_from_levels, Calibration};
pub use config::{Algorithm, GuitarConfig, Mode, ModeParams, Polyphony, Tunables, STANDARD_TUNING};
pub use engine::{Diagnostics, GuitarEngine, MonoEngine};
pub use poly::NoteSet;
pub use poly_engine::PolyEngine;
pub use events::{bend_cents, bend_value, hz_to_midi, midi_to_hz, EventSink, GuitarEvent, GuitarEventKind, BEND_CENTER, BEND_MAX};
pub use pitch::{PitchDetector, PitchEstimate, TierDetector};
pub use tracker::{Tracker, TrackerState, TrackerStats};
