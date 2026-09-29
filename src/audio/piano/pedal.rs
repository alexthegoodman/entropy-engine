//! Grand piano pedal mechanics: sustain (damper lift), una corda (soft pedal),
//! and sostenuto.
//!
//! ### Physics
//! * **Sustain Pedal (Damper Pedal)**: Lifts all felt dampers off all strings simultaneously.
//!   This not only allows played notes to ring indefinitely, but also frees all 88 string sets to
//!   vibrate in sympathy through the soundboard bridge, producing the lush, singing reverberant wash
//!   characteristic of a concert grand piano.
//! * **Una Corda (Soft Pedal)**: Shifts the action sideways so hammers strike fewer strings
//!   in each unison and contact with softer, ungrooved felt.
//! * **Sostenuto Pedal**: Sustains only the notes that were held down when the pedal was pressed.

/// State of all three grand piano pedals.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PedalState {
    /// Sustain (damper) pedal: 0.0 = fully released (dampers active), 1.0 = fully depressed (dampers lifted).
    pub sustain: f32,
    /// Una corda (soft) pedal: 0.0 = normal, 1.0 = shifted action / softer felt.
    pub una_corda: f32,
    /// Sostenuto pedal: 0.0 = inactive, 1.0 = engaged.
    pub sostenuto: f32,
}

impl Default for PedalState {
    fn default() -> Self {
        Self {
            sustain: 0.0,
            una_corda: 0.0,
            sostenuto: 0.0,
        }
    }
}

impl PedalState {
    /// Whether dampers should be lifted across the entire harp due to the sustain pedal.
    pub fn is_sustain_active(&self) -> bool {
        self.sustain >= 0.5
    }

    /// Continuous damping efficiency factor (1.0 = full damping, 0.0 = completely lifted).
    /// Supports half-pedaling.
    pub fn damper_engagement(&self) -> f32 {
        (1.0 - self.sustain).clamp(0.0, 1.0)
    }

    /// Una corda strike softness modifier (0.0 to 1.0).
    pub fn soft_pedal_depth(&self) -> f32 {
        self.una_corda.clamp(0.0, 1.0)
    }
}
