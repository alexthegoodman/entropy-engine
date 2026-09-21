//! What the engine emits. Deliberately not `crate::audio::NoteEvent` (an offline-render note with a
//! duration): a guitar note has no length until the string stops.

/// Center value of a 14-bit pitch-bend (BND-1).
pub const BEND_CENTER: u16 = 8192;
pub const BEND_MAX: u16 = 16383;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuitarEventKind {
    NoteOn { note: u8, velocity: u8 },
    NoteOff { note: u8 },
    /// 14-bit, 8192 is center. Full deflection is the configured bend range.
    PitchBend { value: u16 },
}

/// One event with the two timestamps EVT-7 asks for, both in input samples since the engine
/// started.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GuitarEvent {
    pub kind: GuitarEventKind,
    /// The input sample at which the engine decided to emit this. A live player schedules from here.
    pub sample: u64,
    /// The input sample the event describes: the pick for a Note On, the moment the string went
    /// quiet for a Note Off. A recorder places the event here, which compensates for detection
    /// latency (spec 3.4).
    pub source_sample: u64,
}

/// Where events go. `Vec<GuitarEvent>` for tests and the replay harness, a lock-free queue producer
/// on the audio thread.
pub trait EventSink {
    fn push(&mut self, event: GuitarEvent);
}

impl EventSink for Vec<GuitarEvent> {
    fn push(&mut self, event: GuitarEvent) {
        Vec::push(self, event);
    }
}

impl<F: FnMut(GuitarEvent)> EventSink for F {
    fn push(&mut self, event: GuitarEvent) {
        self(event)
    }
}

/// Frequency to a fractional MIDI note number (69 = A4 at `reference`).
pub fn hz_to_midi(hz: f32, reference: f32) -> f32 {
    69.0 + 12.0 * (hz / reference).log2()
}

pub fn midi_to_hz(note: f32, reference: f32) -> f32 {
    reference * ((note - 69.0) / 12.0).exp2()
}

/// Pitch-bend value for a deviation in cents from the note center, for a bend range in semitones.
pub fn bend_value(cents: f32, range_semitones: f32) -> u16 {
    let unit = cents / (range_semitones * 100.0);
    let v = BEND_CENTER as f32 + unit * BEND_CENTER as f32;
    v.round().clamp(0.0, BEND_MAX as f32) as u16
}

/// The inverse of `bend_value`, for a receiving instrument.
pub fn bend_cents(value: u16, range_semitones: f32) -> f32 {
    (value as f32 - BEND_CENTER as f32) / BEND_CENTER as f32 * range_semitones * 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a4_is_69_and_octaves_are_12() {
        assert!((hz_to_midi(440.0, 440.0) - 69.0).abs() < 1e-4);
        assert!((hz_to_midi(880.0, 440.0) - 81.0).abs() < 1e-4);
        assert!((hz_to_midi(82.4069, 440.0) - 40.0).abs() < 1e-3);
        assert!((midi_to_hz(40.0, 440.0) - 82.4069).abs() < 1e-3);
    }

    #[test]
    fn a_different_reference_moves_every_note() {
        let n = hz_to_midi(440.0, 432.0);
        assert!((n - 69.0 - 12.0 * (440.0f32 / 432.0).log2()).abs() < 1e-4);
    }

    #[test]
    fn bend_is_center_at_zero_and_full_scale_at_the_range() {
        assert_eq!(bend_value(0.0, 2.0), BEND_CENTER);
        assert_eq!(bend_value(200.0, 2.0), BEND_MAX);
        assert_eq!(bend_value(-200.0, 2.0), 0);
        assert_eq!(bend_value(100.0, 2.0), BEND_CENTER + 4096);
        // Out of range clamps rather than wrapping.
        assert_eq!(bend_value(900.0, 2.0), BEND_MAX);
    }

    #[test]
    fn bend_round_trips_within_one_step() {
        for cents in [-150.0f32, -33.3, 0.0, 12.5, 99.0] {
            let back = bend_cents(bend_value(cents, 2.0), 2.0);
            assert!((back - cents).abs() < 0.03, "{cents} -> {back}");
        }
    }
}
