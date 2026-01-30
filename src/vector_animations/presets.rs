use crate::vector_animations::animations::{UIKeyframe, KeyframeValue, EasingType};
use crate::core::editor::PathType;
use std::time::Duration;
use uuid::Uuid;

pub enum AnimationPreset {
    Circle { radius: f32, speed: f32, clockwise: bool },
    Bounce { intensity: f32, duration_ms: u64 },
    Fade { start_opacity: i32, end_opacity: i32, duration_ms: u64 },
}

pub fn generate_circle_keyframes(radius: f32, duration_ms: u64, steps: usize) -> Vec<UIKeyframe> {
    let mut keyframes = Vec::new();
    for i in 0..=steps {
        let progress = i as f32 / steps as f32;
        let angle = progress * std::f32::consts::TAU;
        let x = (angle.cos() * radius) as i32;
        let y = (angle.sin() * radius) as i32;
        
        keyframes.push(UIKeyframe {
            id: Uuid::new_v4().to_string(),
            time: Duration::from_millis((progress * duration_ms as f32) as u64),
            value: KeyframeValue::Position([x, y]),
            easing: EasingType::Linear,
            path_type: PathType::Linear,
            ..Default::default()
        });
    }
    keyframes
}

pub fn generate_bounce_keyframes(intensity: f32, duration_ms: u64) -> Vec<UIKeyframe> {
    let mut keyframes = Vec::new();
    // Simple 3-step bounce
    keyframes.push(UIKeyframe {
        id: Uuid::new_v4().to_string(),
        time: Duration::from_millis(0),
        value: KeyframeValue::Position([0, 0]),
        easing: EasingType::EaseOut,
        ..Default::default()
    });
    keyframes.push(UIKeyframe {
        id: Uuid::new_v4().to_string(),
        time: Duration::from_millis(duration_ms / 2),
        value: KeyframeValue::Position([0, -(intensity as i32)]),
        easing: EasingType::EaseIn,
        ..Default::default()
    });
    keyframes.push(UIKeyframe {
        id: Uuid::new_v4().to_string(),
        time: Duration::from_millis(duration_ms),
        value: KeyframeValue::Position([0, 0]),
        easing: EasingType::Linear,
        ..Default::default()
    });
    keyframes
}
