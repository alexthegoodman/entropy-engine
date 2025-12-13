use serde::{Deserialize, Serialize};

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

use crate::{
    core::editor::{ControlPoint, CurveData, PathType}, renderer_images::st_image::SavedStImageConfig, renderer_text::text_due::SavedTextRendererConfig, shape_primitives::polygon::{SavedPoint, SavedPolygonConfig}
};

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub enum ObjectType {
    Polygon,
    TextItem,
    ImageItem,
    VideoItem,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub struct SavedStVideoConfig {
    pub id: String,
    pub name: String,
    pub dimensions: (u32, u32),
    pub path: String,
    pub position: SavedPoint,
    pub layer: i32,
    pub mouse_path: Option<String>,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub struct Sequence {
    pub id: String,
    pub name: String,
    pub background_fill: Option<BackgroundFill>,
    pub duration_ms: i32,                         // in milliseconds
    pub active_polygons: Vec<SavedPolygonConfig>, // used for dimensions, etc
    pub polygon_motion_paths: Vec<AnimationData>,
    pub active_text_items: Vec<SavedTextRendererConfig>,
    pub active_image_items: Vec<SavedStImageConfig>,
    pub active_video_items: Vec<SavedStVideoConfig>,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
#[serde(default)]
pub struct AnimationData {
    pub id: String,
    /// whether a polygon, image, text, or other
    pub object_type: ObjectType,
    /// id of the associated polygon
    pub polygon_id: String,
    /// Total duration of the animation
    // pub duration: Duration,
    /// Start time within sequence
    pub start_time_ms: i32,
    /// Hierarchical property structure for UI
    pub properties: Vec<AnimationProperty>,
    /// Relative position
    pub position: [i32; 2],
}

impl Default for AnimationData {
    fn default() -> Self {
        Self {
            id: String::new(),
            object_type: ObjectType::Polygon,
            polygon_id: String::new(),
            // duration: Duration::from_secs(1),
            start_time_ms: 0,
            properties: Vec::new(),
            position: [0, 0],
        }
    }
}

/// Represents a property that can be animated in the UI
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
#[serde(default)]
pub struct AnimationProperty {
    /// Name of the property (e.g., "Position.X", "Rotation.Z")
    pub name: String,
    /// Path to this property in the data (for linking to MotionPath data)
    pub property_path: String,
    /// Nested properties (if any)
    pub children: Vec<AnimationProperty>,
    /// Direct keyframes for this property
    pub keyframes: Vec<UIKeyframe>,
    /// Visual depth in the property tree
    pub depth: u32,
}

impl Default for AnimationProperty {
    fn default() -> Self {
        Self {
            name: String::new(),
            property_path: String::new(),
            children: Vec::new(),
            keyframes: Vec::new(),
            depth: 0,
        }
    }
}

/// Types of easing functions available for interpolation
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub enum EasingType {
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
}

/// Represents a keyframe in the UI
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
#[serde(default)]
pub struct UIKeyframe {
    /// Used to associate with this speciifc UI Keyframe
    pub id: String,
    /// Time of the keyframe
    // pub time: Duration,
    /// Value at this keyframe (could be position, rotation, etc)
    pub value: KeyframeValue,
    /// Type of interpolation to next keyframe
    pub easing: EasingType,
    // Whether a curve (bezier) or straight (linear) path
    pub path_type: PathType,
    /// Type of keyframe (frame or range)
    pub key_type: KeyType,
}

impl Default for UIKeyframe {
    fn default() -> Self {
        Self {
            id: String::new(),
            // time: Duration::from_secs(0),
            value: KeyframeValue::Position([0, 0]),
            easing: EasingType::Linear,
            path_type: PathType::Linear,
            key_type: KeyType::Frame,
        }
    }
}

/// Possible values for keyframes
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub enum KeyframeValue {
    Position([i32; 2]),
    Rotation(i32), // stored as degrees
    Scale(i32),    // this will be 100 for default size to work with i32 and Eq
    PerspectiveX(i32),
    PerspectiveY(i32),
    Opacity(i32), // also out of 100
    Zoom(i32),    // 100 is minimum, needs precision
    Custom(Vec<i32>),
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub enum BackgroundFill {
    Color([i32; 4]),
    Gradient(), // for later
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
#[serde(default)]
pub struct RangeData {
    // pub end_time: Duration,
}

impl Default for RangeData {
    fn default() -> Self {
        Self {
            // end_time: Duration::from_secs(1),
        }
    }
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub enum KeyType {
    Frame,
    Range(RangeData),
}

impl UIKeyframe {
    pub fn calculate_default_curve(&self, next_keyframe: &UIKeyframe) -> PathType {
        match (&self.value, &next_keyframe.value) {
            (KeyframeValue::Position(current_pos), KeyframeValue::Position(next_pos)) => {
                // Calculate distance between points
                let dx = next_pos[0] - current_pos[0];
                let dy = next_pos[1] - current_pos[1];
                let distance = ((dx.pow(2) + dy.pow(2)) as f64).sqrt();

                // Calculate time difference
                // let time_diff =
                //     next_keyframe.time.as_millis() as f64 - self.time.as_millis() as f64;

                // Calculate velocity (pixels per millisecond)
                // let velocity = distance / time_diff;

                // If the movement is very small, use Linear
                if distance < 10.0 {
                    return PathType::Linear;
                }

                // Calculate control points with perpendicular offset
                let control_points = calculate_natural_control_points(
                    current_pos,
                    next_pos,
                    // time_diff as f64,
                    // velocity,
                    0.0, 0.0
                );

                PathType::Bezier(CurveData {
                    control_point1: Some(control_points.0),
                    control_point2: Some(control_points.1),
                })
            }
            _ => PathType::Linear,
        }
    }
}

fn calculate_natural_control_points(
    current: &[i32; 2],
    next: &[i32; 2],
    time_diff: f64,
    velocity: f64,
) -> (ControlPoint, ControlPoint) {
    // Calculate the primary direction vector
    let dx = (next[0] - current[0]) as f64;
    let dy = (next[1] - current[1]) as f64;
    let distance = (dx * dx + dy * dy).sqrt();

    // Normalize the direction vector
    let dir_x = dx / distance;
    let dir_y = dy / distance;

    // Calculate perpendicular vector (rotate 90 degrees)
    let perp_x = -dir_y;
    let perp_y = dir_x;

    // Calculate the distance for control points based on velocity and time
    let forward_distance = (velocity * time_diff * 0.25).min(100.0);

    // Calculate perpendicular offset based on distance
    // Longer distances get more pronounced curves
    let perpendicular_offset = (distance * 0.2).min(50.0);

    // First control point:
    // - Move forward along the path
    // - Offset perpendicular to create an arc
    let cp1 = ControlPoint {
        x: current[0] + (forward_distance * dir_x + perpendicular_offset * perp_x) as i32,
        y: current[1] + (forward_distance * dir_y + perpendicular_offset * perp_y) as i32,
    };

    // Second control point:
    // - Move backward from the end point
    // - Offset perpendicular in the same direction for symmetry
    let cp2 = ControlPoint {
        x: next[0] - (forward_distance * dir_x - perpendicular_offset * perp_x) as i32,
        y: next[1] - (forward_distance * dir_y - perpendicular_offset * perp_y) as i32,
    };

    (cp1, cp2)
}

// Helper function to detect if we should flip the curve direction
fn should_flip_curve(current: &[i32; 2], next: &[i32; 2]) -> bool {
    // Calculate angle relative to horizontal
    let angle = ((next[1] - current[1]) as f64).atan2((next[0] - current[0]) as f64);

    // Flip the curve if the angle is in the lower half of the circle
    // This creates more natural arcs for different movement directions
    angle < 0.0
}
