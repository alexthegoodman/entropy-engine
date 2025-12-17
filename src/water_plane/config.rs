use bytemuck::{Pod, Zeroable};
use serde::{Deserialize, Serialize};

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable, Serialize, Deserialize)]
pub struct WaterConfig {
    pub shallow_color: [f32; 4],
    pub medium_color: [f32; 4],
    pub deep_color: [f32; 4],
}

impl Default for WaterConfig {
    fn default() -> Self {
        Self {
            shallow_color: [0.2, 0.85, 0.95, 1.0],
            medium_color: [0.0, 0.55, 0.75, 1.0],
            deep_color: [0.0, 0.25, 0.45, 1.0],
        }
    }
}
