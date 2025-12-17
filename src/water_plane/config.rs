use bytemuck::{Pod, Zeroable};
use serde::{Deserialize, Serialize};

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable, Serialize, Deserialize, PartialEq)]
pub struct WaterConfig {
    pub shallow_color: [f32; 4],
    pub medium_color: [f32; 4],
    pub deep_color: [f32; 4],
    pub player_pos: [f32; 4],
    pub ripple_amplitude_multiplier: f32,
    pub ripple_freq: f32,
    pub ripple_speed: f32,
    pub shoreline_foam_range: f32,
    pub crest_foam_min: f32,
    pub crest_foam_max: f32,
    pub sparkle_intensity: f32,
    pub sparkle_threshold: f32,
    pub subsurface_multiplier: f32,
    pub fresnel_power: f32,
    pub fresnel_multiplier: f32,
    pub _padding: [f32; 1],
}

impl Default for WaterConfig {
    fn default() -> Self {
        Self {
            shallow_color: [0.2, 0.85, 0.95, 1.0],
            medium_color: [0.0, 0.55, 0.75, 1.0],
            deep_color: [0.0, 0.25, 0.45, 1.0],
            player_pos: [0.0, 0.0, 0.0, 0.0],
            ripple_amplitude_multiplier: 1.5,
            ripple_freq: 0.25,
            ripple_speed: 3.0,
            shoreline_foam_range: 2.5,
            crest_foam_min: 0.45,
            crest_foam_max: 0.75,
            sparkle_intensity: 0.8,
            sparkle_threshold: 0.7,
            subsurface_multiplier: 0.35,
            fresnel_power: 2.5,
            fresnel_multiplier: 0.6,
            _padding: [0.0],
        }
    }
}
