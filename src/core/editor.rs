use std::fs;
use std::path::Path;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cgmath::{Point3, Vector3, Vector4};
// use nalgebra::{Point3, Vector3, Vector4};
use crate::core::SimpleCamera::SimpleCamera as Camera;
use crate::core::camera::CameraBinding;
use crate::core::gpu_resources::GpuResources;
use crate::helpers::timelines::SavedTimelineStateConfig;
use crate::renderer_text::fonts::FontManager;
use crate::vector_animations::animations::{AnimationProperty, EasingType, KeyType, KeyframeValue, ObjectType, Sequence, UIKeyframe};

use cgmath::SquareMatrix;

use rand::Rng;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use strum::IntoEnumIterator;
use strum_macros::EnumIter;

const NUM_INFERENCE_FEATURES: usize = 7;
pub const CANVAS_HORIZ_OFFSET: f32 = 0.0;
pub const CANVAS_VERT_OFFSET: f32 = 0.0;

enum ResizableObject {
    // Polygon(Polygon),
    // Video(StVideo),
    // Image(StImage),
    // Text(TextRenderer),
}

#[derive(Debug, Clone, Copy)]
pub struct WindowSize {
    pub width: u32,
    pub height: u32,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct WindowSizeShader {
    pub width: f32,
    pub height: f32,
}

// Basic 2D point structure
#[derive(Clone, Copy, Debug)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

pub struct BoundingBox {
    pub min: Point,
    pub max: Point,
}

// Basic shape traits
pub trait Shape {
    fn bounding_box(&self) -> BoundingBox;
    fn contains_point(&self, point: &Point, camera: &Camera) -> bool;
    fn contains_point_with_tolerance(&self, point: &Point, camera: &Camera, tolerance_percent: f32) -> bool {
        // Default implementation - subclasses should override for proper enhanced detection
        self.contains_point(point, camera)
    }
}

#[derive(Eq, PartialEq, Clone, Copy, EnumIter, Debug)]
pub enum ToolCategory {
    Shape,
    Brush,
}

#[derive(Clone, Copy)]
pub struct Viewport {
    pub width: f32,
    pub height: f32,
}

impl Viewport {
    pub fn new(width: f32, height: f32) -> Self {
        Viewport { width, height }
    }

    pub fn to_ndc(&self, x: f32, y: f32) -> (f32, f32) {
        let ndc_x = (x / self.width) * 2.0 - 1.0;
        let ndc_y = -((y / self.height) * 2.0 - 1.0); // Flip Y-axis
        (ndc_x, ndc_y)
    }
}

pub fn size_to_normal(window_size: &WindowSize, x: f32, y: f32) -> (f32, f32) {
    let ndc_x = x / window_size.width as f32;
    let ndc_y = y / window_size.height as f32;

    (ndc_x, ndc_y)
}

pub fn point_to_ndc(point: Point, window_size: &WindowSize) -> Point {
    let aspect_ratio = window_size.width as f32 / window_size.height as f32;

    Point {
        x: ((point.x / window_size.width as f32) * 2.0 - 1.0),
        y: 1.0 - (point.y / window_size.height as f32) * 2.0,
    }
}

pub fn rgb_to_wgpu(r: u8, g: u8, b: u8, a: f32) -> [f32; 4] {
    [
        r as f32 / 255.0,
        g as f32 / 255.0,
        b as f32 / 255.0,
        // a.clamp(0.0, 1.0),
        a / 255.0,
    ]
}

pub fn color_to_wgpu(c: f32) -> f32 {
    c / 255.0
}

pub fn wgpu_to_human(c: f32) -> f32 {
    c * 255.0
}

pub fn string_to_f32(s: &str) -> Result<f32, std::num::ParseFloatError> {
    let trimmed = s.trim();

    if trimmed.is_empty() {
        return Ok(0.0);
    }

    // Check if there's at least one digit in the string
    if !trimmed.chars().any(|c| c.is_ascii_digit()) {
        return Ok(0.0);
    }

    // At this point, we know there's at least one digit, so let's try to parse
    match trimmed.parse::<f32>() {
        Ok(num) => Ok(num),
        Err(e) => {
            // If parsing failed, check if it's because of a misplaced dash
            if trimmed.contains('-') && trimmed != "-" {
                // Remove all dashes and try parsing again
                let without_dashes = trimmed.replace('-', "");
                without_dashes.parse::<f32>().map(|num| -num.abs())
            } else {
                Err(e)
            }
        }
    }
}

pub fn string_to_u32(s: &str) -> Result<u32, std::num::ParseIntError> {
    let trimmed = s.trim();

    if trimmed.is_empty() {
        return Ok(0);
    }

    // Check if there's at least one digit in the string
    if !trimmed.chars().any(|c| c.is_ascii_digit()) {
        return Ok(0);
    }

    // At this point, we know there's at least one digit, so let's try to parse
    match trimmed.parse::<u32>() {
        Ok(num) => Ok(num),
        Err(e) => Err(e),
    }
}

// pub struct GuideLine {
//     pub start: Point,
//     pub end: Point,
// }

// Define all possible edit operations
#[derive(Debug)]
pub enum ObjectProperty {
    Width(f32),
    Height(f32),
    Red(f32),
    Green(f32),
    Blue(f32),
    FillRed(f32),
    FillGreen(f32),
    FillBlue(f32),
    BorderRadius(f32),
    StrokeThickness(f32),
    StrokeRed(f32),
    StrokeGreen(f32),
    StrokeBlue(f32),
    FontFamily(String),
    FontSize(f32),
    Text(String),
    // Points(Vec<Point>),
}

#[derive(Debug)]
pub struct ObjectEditConfig {
    pub object_id: Uuid,
    pub object_type: ObjectType,
    pub field_name: String,
    pub old_value: ObjectProperty,
    pub new_value: ObjectProperty,
    // pub signal: RwSignal<String>,
}

// pub type PolygonClickHandler = dyn Fn() -> Option<Box<dyn FnMut(Uuid, PolygonConfig)>>;

// pub type TextItemClickHandler = dyn Fn() -> Option<Box<dyn FnMut(Uuid, TextRendererConfig)>>;

// pub type ImageItemClickHandler = dyn Fn() -> Option<Box<dyn FnMut(Uuid, StImageConfig)>>;

// pub type VideoItemClickHandler = dyn Fn() -> Option<Box<dyn FnMut(Uuid, StVideoConfig)>>;

// pub type OnMouseUp = dyn Fn() -> Option<Box<dyn FnMut(Uuid, Point) -> (Sequence, Vec<UIKeyframe>)>>;

// pub type OnHandleMouseUp =
//     dyn Fn() -> Option<Box<dyn FnMut(Uuid, Uuid, Point) -> (Sequence, Vec<UIKeyframe>)>>;

// pub type OnPathMouseUp =
//     dyn Fn() -> Option<Box<dyn FnMut(Uuid, Point) -> (Sequence, Vec<UIKeyframe>)>>;

#[derive(Eq, PartialEq, Clone, Copy, EnumIter, Debug)]
pub enum ControlMode {
    Select,
    Pan,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandlePosition {
    TopLeft,
    Top,
    TopRight,
    Right,
    BottomRight,
    Bottom,
    BottomLeft,
    Left,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SelectedObject {
    pub object_id: Uuid,
    pub object_type: ObjectType,
}

// pub struct ResizeHandle {
//     pub id: Uuid,
//     pub position: HandlePosition,
//     pub polygon: Polygon,
//     pub object_id: Uuid,
// }

pub struct Editor {
    // visual
    // pub st_capture: StCapture,
    // pub exporter: Option<Exporter>,
    // pub selected_polygon_id: Uuid,
    // pub polygons: Vec<Polygon>,
    // pub dragging_polygon: Option<Uuid>,
    // pub static_polygons: Vec<Polygon>,
    // pub project_selected: Option<Uuid>,
    // pub text_items: Vec<TextRenderer>,
    // pub dragging_text: Option<Uuid>,
    // pub image_items: Vec<StImage>,
    // pub dragging_image: Option<Uuid>,
    // pub font_manager: FontManager,
    // pub dragging_path: Option<Uuid>,
    // pub dragging_path_handle: Option<Uuid>,
    // pub dragging_path_object: Option<Uuid>,
    // pub dragging_path_keyframe: Option<Uuid>,
    // pub dragging_path_assoc_path: Option<Uuid>,
    // pub cursor_dot: Option<RingDot>,
    // pub video_items: Vec<StVideo>,
    // pub dragging_video: Option<Uuid>,
    // pub saved_state: Option<SavedState>,
    
    // resize handles system
    pub selected_object: Option<SelectedObject>,
    // pub resize_handles: Vec<ResizeHandle>,
    pub dragging_handle: Option<(Uuid, HandlePosition)>,
    
    // pub motion_paths: Vec<MotionPath>,
    // pub motion_arrows: Vec<MotionArrow>,
    // pub canvas_hidden: bool,
    // pub motion_arrow_just_placed: bool,
    // pub last_motion_arrow_object_id: Uuid,
    // pub last_motion_arrow_object_type: ObjectType,
    // pub last_motion_arrow_object_dimensions: Option<(f32, f32)>,
    // pub last_motion_arrow_end_positions: Option<(Point, Point)>,

    // viewport
    pub viewport: Arc<Mutex<Viewport>>,
    // pub handle_polygon_click: Option<Arc<PolygonClickHandler>>,
    // pub handle_text_click: Option<Arc<TextItemClickHandler>>,
    // pub handle_image_click: Option<Arc<ImageItemClickHandler>>,
    // pub handle_video_click: Option<Arc<VideoItemClickHandler>>,
    pub gpu_resources: Option<Arc<GpuResources>>,
    pub camera: Option<Camera>,
    pub camera_binding: Option<CameraBinding>,
    pub model_bind_group_layout: Option<Arc<wgpu::BindGroupLayout>>,
    pub group_bind_group_layout: Option<Arc<wgpu::BindGroupLayout>>,
    pub window_size_bind_group_layout: Option<Arc<wgpu::BindGroupLayout>>,
    pub window_size_bind_group: Option<wgpu::BindGroup>,
    pub window_size_buffer: Option<Arc<wgpu::Buffer>>,
    pub render_pipeline: Option<Arc<wgpu::RenderPipeline>>,
    // pub on_mouse_up: Option<Arc<OnMouseUp>>,
    // pub on_handle_mouse_up: Option<Arc<OnHandleMouseUp>>,
    // pub on_path_mouse_up: Option<Arc<OnPathMouseUp>>,
    pub current_view: String,
    pub interactive_bounds: BoundingBox,
    pub depth_view: Option<wgpu::TextureView>,

    // state
    pub is_playing: bool,
    pub current_sequence_data: Option<Sequence>,
    pub last_frame_time: Option<Instant>,
    pub start_playing_time: Option<Instant>,
    pub video_is_playing: bool,
    pub video_start_playing_time: Option<Instant>,
    pub video_current_sequence_timeline: Option<SavedTimelineStateConfig>,
    pub video_current_sequences_data: Option<Vec<Sequence>>,
    pub control_mode: ControlMode,
    pub is_panning: bool,
    pub motion_mode: bool,

    // points
    pub last_mouse_pos: Option<Point>,
    pub drag_start: Option<Point>,
    pub last_screen: Point, // last mouse position from input event top-left origin
    pub last_world: Point,
    pub last_top_left: Point,   // for inside the editor zone
    pub global_top_left: Point, // for when recording mouse positions outside the editor zone
    pub ds_ndc_pos: Point,      // double-width sized ndc-style positioning (screen-oriented)
    pub ndc: Point,
    pub previous_top_left: Point,

    // ai
    // pub inference: Option<CommonMotionInference<Wgpu>>,
    pub generation_count: u32,
    pub generation_curved: bool,
    pub generation_choreographed: bool,
    pub generation_fade: bool,
}


#[cfg(target_os = "windows")]
pub fn init_editor_with_model(viewport: Arc<Mutex<Viewport>>, project_id: String) -> Editor {
    // let inference = load_common_motion_2d();

    let editor = Editor::new(viewport, project_id.clone());

    editor
}

#[cfg(target_arch = "wasm32")]
pub fn init_editor_with_model(viewport: Arc<Mutex<Viewport>>, project_id: String) -> Editor {
    let editor = Editor::new(viewport, project_id.clone());

    editor
}

pub enum InputValue {
    Text(String),
    Number(f32),
    // Points(Vec<Point>),
}

impl Editor {
    pub fn new(
        viewport: Arc<Mutex<Viewport>>,
        project_id: String
    ) -> Self {
        let viewport_unwrapped = viewport.lock().unwrap();
        let window_size = WindowSize {
            width: viewport_unwrapped.width as u32,
            height: viewport_unwrapped.height as u32,
        };

        let font_manager = FontManager::new();

        // Create capture directory for this project
        let project_path = std::env::current_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
            .join("captures")
            .join(project_id);

        if let Err(e) = std::fs::create_dir_all(&project_path) {
            println!("Failed to create capture directory: {}", e);
            // return Ok(());,
        }

        // Initialize StCapture - this handles the non-Send+Sync Windows capture types
        // let st_capture = StCapture::new(project_path);

        Editor {
            // st_capture,
            // exporter: None,
            // font_manager,
            // // inference,
            // selected_polygon_id: Uuid::nil(),
            // last_motion_arrow_object_id: Uuid::nil(),
            // last_motion_arrow_object_type: ObjectType::Polygon,
            // polygons: Vec::new(),
            // dragging_polygon: None,
            // dragging_path_assoc_path: None,
            drag_start: None,
            viewport: viewport.clone(),
            // handle_polygon_click: None,
            // handle_text_click: None,
            // handle_image_click: None,
            // handle_video_click: None,
            gpu_resources: None,
            camera: None,
            camera_binding: None,
            last_mouse_pos: None,
            last_screen: Point { x: 0.0, y: 0.0 },
            last_world: Point { x: 0.0, y: 0.0 },
            ds_ndc_pos: Point { x: 0.0, y: 0.0 },
            last_top_left: Point { x: 0.0, y: 0.0 },
            global_top_left: Point { x: 0.0, y: 0.0 },
            ndc: Point { x: 0.0, y: 0.0 },
            previous_top_left: Point { x: 0.0, y: 0.0 },
            is_playing: false,
            current_sequence_data: None,
            last_frame_time: None,
            start_playing_time: None,
            model_bind_group_layout: None,
            group_bind_group_layout: None,
            window_size_bind_group_layout: None,
            window_size_bind_group: None,
            window_size_buffer: None,
            render_pipeline: None,
            // static_polygons: Vec::new(),
            // on_mouse_up: None,
            current_view: "manage_projects".to_string(),
            // project_selected: None,
            // text_items: Vec::new(),
            // dragging_text: None,
            // image_items: Vec::new(),
            // dragging_image: None,
            video_is_playing: false,
            video_start_playing_time: None,
            video_current_sequence_timeline: None,
            video_current_sequences_data: None,
            // dragging_path: None,
            // dragging_path_handle: None,
            // on_handle_mouse_up: None,
            // on_path_mouse_up: None,
            // dragging_path_object: None,
            // dragging_path_keyframe: None,
            // cursor_dot: None,
            control_mode: ControlMode::Select,
            is_panning: false,
            motion_mode: false,
            // video_items: Vec::new(),
            // dragging_video: None,
            // saved_state: None,
            
            // resize handles system  
            selected_object: None,
            // resize_handles: Vec::new(),
            dragging_handle: None,
            
            // motion_paths: Vec::new(),
            // motion_arrows: Vec::new(),
            // canvas_hidden: false,
            // motion_arrow_just_placed: false,
            // last_motion_arrow_object_dimensions: None,
            generation_count: 4,
            generation_curved: false,
            generation_choreographed: true,
            generation_fade: true,
            depth_view: None,
            // last_motion_arrow_end_positions: None,
            // TODO: update interactive bounds on window resize?
            interactive_bounds: BoundingBox {
                min: Point { x: 50.0, y: 50.0 }, // account for aside width, allow for some off-canvas positioning
                max: Point {
                    x: window_size.width as f32,
                    // y: window_size.height as f32 - 350.0, // 350.0 for timeline space
                    y: 750.0, // allow for 50.0 padding below and above the canvas
                },
            },
        }
    }
}

// Helper function to create default properties with constant values
fn create_default_property(
    name: &str,
    path: &str,
    value: KeyframeValue,
    timestamps: &[i32],
) -> AnimationProperty {
    let keyframes = timestamps
        .iter()
        .map(|&time| UIKeyframe {
            id: Uuid::new_v4().to_string(),
            time: Duration::from_millis(time as u64),
            value: value.clone(),
            easing: EasingType::EaseInOut,
            path_type: PathType::Linear,
            key_type: KeyType::Frame,
        })
        .collect();

    AnimationProperty {
        name: name.to_string(),
        property_path: path.to_string(),
        children: Vec::new(),
        keyframes,
        depth: 0,
    }
}

// /// Get interpolated position at a specific time
// fn interpolate_position(start: &UIKeyframe, end: &UIKeyframe, time: Duration) -> [i32; 2] {
//     if let (KeyframeValue::Position(start_pos), KeyframeValue::Position(end_pos)) =
//         (&start.value, &end.value)
//     {
//         let progress = match start.easing {
//             EasingType::Linear => {
//                 let total_time = (end.time - start.time).as_secs_f32();
//                 let current_time = (time - start.time).as_secs_f32();
//                 current_time / total_time
//             }
//             // Add more sophisticated easing calculations here
//             _ => {
//                 let total_time = (end.time - start.time).as_secs_f32();
//                 let current_time = (time - start.time).as_secs_f32();
//                 current_time / total_time
//             }
//         };

//         [
//             (start_pos[0] as f32 + (end_pos[0] - start_pos[0]) as f32 * progress) as i32,
//             (start_pos[1] as f32 + (end_pos[1] - start_pos[1]) as f32 * progress) as i32,
//         ]
//     } else {
//         panic!("Expected position keyframes")
//     }
// }

// curves attempt
#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub struct ControlPoint {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub struct CurveData {
    pub control_point1: Option<ControlPoint>,
    pub control_point2: Option<ControlPoint>,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub enum PathType {
    Linear,
    Bezier(CurveData),
}

// impl Default for PathType {
//     fn default() -> Self {
//         PathType::Linear
//     }
// }

/// Creates curves in between keyframes, on the same path, rather than sharing a curve with another
/// but it's better this way, as using a keyframe as a middle point on a curve leads to various problems
pub fn interpolate_position(start: &UIKeyframe, end: &UIKeyframe, time: f32) -> [i32; 2] {
    if let (KeyframeValue::Position(start_pos), KeyframeValue::Position(end_pos)) =
        (&start.value, &end.value)
    {
        let progress = {
            let total_time = (end.time - start.time).as_secs_f32();
            let current_time = time - (start.time).as_secs_f32();
            let t = current_time / total_time;

            match start.easing {
                EasingType::Linear => t,
                EasingType::EaseIn => t * t,
                EasingType::EaseOut => 1.0 - (1.0 - t) * (1.0 - t),
                EasingType::EaseInOut => {
                    if t < 0.5 {
                        2.0 * t * t
                    } else {
                        1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
                    }
                }
            }
        };

        // Get curve data from the keyframe
        let path_type = start.path_type.clone();
        // let path_type = PathType::Bezier(CurveData {
        //     control_point1: None,
        //     control_point2: None,
        // });
        // let test_offset = 50.0;
        // let path_type = PathType::Bezier(CurveData {
        //     control_point1: Some(ControlPoint {
        //         x: (start_pos[0] as f32 + (end_pos[0] - start_pos[0]) as f32 * 0.2) + test_offset,
        //         y: (start_pos[1] as f32 + (end_pos[1] - start_pos[1]) as f32 * 0.2) + test_offset,
        //     }),
        //     control_point2: Some(ControlPoint {
        //         x: (start_pos[0] as f32 + (end_pos[0] - start_pos[0]) as f32 * 0.8) + test_offset,
        //         y: (start_pos[1] as f32 + (end_pos[1] - start_pos[1]) as f32 * 0.8) + test_offset,
        //     }),
        // });
        // let path_type = PathType::Bezier(CurveData {
        //     control_point1: Some(ControlPoint { x: 500.0, y: 300.0 }),
        //     control_point2: Some(ControlPoint { x: 700.0, y: 400.0 }),
        // });

        match path_type {
            PathType::Linear => [
                (start_pos[0] as f32 + (end_pos[0] - start_pos[0]) as f32 * progress) as i32,
                (start_pos[1] as f32 + (end_pos[1] - start_pos[1]) as f32 * progress) as i32,
            ],
            PathType::Bezier(curve_data) => {
                let p0 = (start_pos[0] as f32, start_pos[1] as f32);
                let p3 = (end_pos[0] as f32, end_pos[1] as f32);

                // Use control points if available, otherwise generate default ones
                let p1 = curve_data.control_point1.as_ref().map_or_else(
                    || (p0.0 + (p3.0 - p0.0) * 0.33, p0.1 + (p3.1 - p0.1) * 0.33),
                    |cp| (cp.x as f32, cp.y as f32),
                );

                let p2 = curve_data.control_point2.as_ref().map_or_else(
                    || (p0.0 + (p3.0 - p0.0) * 0.66, p0.1 + (p3.1 - p0.1) * 0.66),
                    |cp| (cp.x as f32, cp.y as f32),
                );

                // Cubic Bezier curve formula
                let t = progress;
                let t2 = t * t;
                let t3 = t2 * t;
                let mt = 1.0 - t;
                let mt2 = mt * mt;
                let mt3 = mt2 * mt;

                let x = p0.0 * mt3 + 3.0 * p1.0 * mt2 * t + 3.0 * p2.0 * mt * t2 + p3.0 * t3;
                let y = p0.1 * mt3 + 3.0 * p1.1 * mt2 * t + 3.0 * p2.1 * mt * t2 + p3.1 * t3;

                // println!(
                //     "Bezier {:?} and {:?} vs ({:?}, {:?}) at {:?} and {:?}",
                //     p0, p3, x, y, progress, time
                // );

                [x as i32, y as i32]
            }
        }
    } else {
        panic!("Expected position keyframes")
    }
}


#[derive(Debug)]
pub struct Ray {
    // pub origin: Point3<f32>,
    // pub direction: Vector3<f32>,
    // pub ndc: Point,
    pub top_left: Point,
}

impl Ray {
    pub fn new(origin: Point3<f32>, direction: Vector3<f32>) -> Self {
        Ray {
            // origin,
            // direction: direction.normalize(),
            // ndc: Point { x: 0.0, y: 0.0 },
            top_left: Point { x: 0.0, y: 0.0 },
        }
    }
}

pub fn visualize_ray_intersection(
    window_size: &WindowSize,
    screen_x: f32,
    screen_y: f32,
    camera: &Camera,
) -> Ray {
    // let scale_factor = camera.zoom;
    let scale_factor = 1.0;
    
    // let wgpu_viewport_width = window_size.width as f32 - 180.0;
    // let wgpu_viewport_height = window_size.height as f32 - 120.0;
    let wgpu_viewport_width = window_size.width as f32;
    let wgpu_viewport_height = window_size.height as f32;
    let aspect = wgpu_viewport_width as f32 / wgpu_viewport_height as f32;

    let zoom_center_x = wgpu_viewport_width / 2.0;
    let zoom_center_y = wgpu_viewport_height / 2.0;

    // 1. Translate screen coordinates to zoom center
    let translated_screen_x = screen_x - zoom_center_x;
    let translated_screen_y = screen_y - zoom_center_y;

    // 2. Apply zoom
    let zoomed_screen_x = translated_screen_x / scale_factor;
    let zoomed_screen_y = translated_screen_y / scale_factor;

    // 3. Translate back to original screen space
    let scaled_screen_x = zoomed_screen_x + zoom_center_x;
    let scaled_screen_y = zoomed_screen_y + zoom_center_y;

    let pan_offset_x = camera.position.x * 0.5;
    let pan_offset_y = camera.position.y * 0.5;

    // let top_left: Point = Point {
    //     x: scaled_screen_x + pan_offset_x - 90.0, //  account for wgpu viewport
    //     y: scaled_screen_y - pan_offset_y - 60.0,
    // };

    let top_left: Point = Point {
        x: scaled_screen_x + pan_offset_x,
        y: scaled_screen_y - pan_offset_y,
    };

    Ray { top_left }
}

// fn screen_to_world_perspective_correct(
//     mouse_x: f32,
//     mouse_y: f32,
//     window_size: &WindowSize,
//     camera: &Camera
//     // viewport_width: f32,
//     // viewport_height: f32,
//     // view_matrix: &Matrix4<f32>,
//     // projection_matrix: &Matrix4<f32>,
//     // target_z: f32  // World Z where you want the cursor
// ) -> Vector3<f32> {
//     let target_z = 0.0;
//     let projection_matrix = camera.get_projection();
//     let view_matrix = camera.get_view();

//     let viewport_width = window_size.width as f32;
//     let viewport_height = window_size.height as f32;

//     // Convert to NDC (this IS needed for proper perspective correction)
//     let ndc_x = (mouse_x / viewport_width) * 2.0 - 1.0;
//     let ndc_y = 1.0 - (mouse_y / viewport_height) * 2.0;
    
//     // Create ray from near to far plane
//     let near_point = Vector4::new(ndc_x, ndc_y, -1.0, 1.0);
//     let far_point = Vector4::new(ndc_x, ndc_y, 1.0, 1.0);
    
//     let inv_view_proj = (projection_matrix * view_matrix).invert().unwrap();
    
//     let near_world = inv_view_proj * near_point;
//     let far_world = inv_view_proj * far_point;
    
//     let near_world = Vector3::new(
//         near_world.x / near_world.w,
//         near_world.y / near_world.w,
//         near_world.z / near_world.w,
//     );
//     let far_world = Vector3::new(
//         far_world.x / far_world.w,
//         far_world.y / far_world.w,
//         far_world.z / far_world.w,
//     );
    
//     // Intersect ray with plane at target_z
//     let ray_dir = far_world - near_world;
//     let t = (target_z - near_world.z) / ray_dir.z;
    
//     near_world + ray_dir * t
// }

// pub fn visualize_ray_intersection(
//     window_size: &WindowSize,
//     screen_x: f32,
//     screen_y: f32,
//     camera: &Camera,
// ) -> Ray {
//     // let scale_factor = camera.zoom;
//     let scale_factor = 1.0;
//     let aspect = window_size.width as f32 / window_size.height as f32;

//     let top_left: Point = Point {
//         x: screen_x * aspect,
//         y: screen_y * aspect,
//     };

//     Ray { top_left }
// }

// Usage:
// let (ray_origin, ray_direction) = screen_to_world_ray(mouse_x, mouse_y, width, height, &view_matrix, &projection_matrix);
// let cursor_position = intersect_ray_with_plane(ray_origin, ray_direction, 0.0); // Intersect with Z=0 plane

// Define an enum to represent interaction targets
pub enum InteractionTarget {
    Polygon(usize),
    Text(usize),
    Image(usize),
    Video(usize),
}

pub fn get_color(color_index: u32) -> u32 {
    // Normalize the color_index to be within 0-29 range
    let normalized_index = color_index % 30;

    // Calculate which shade we're on (0-9)
    let shade_index = normalized_index / 3;

    // Calculate the shade intensity (0-255)
    // Using a range of 25-255 to avoid completely black colors
    155 + (shade_index * 10) // (255 - 25) / 10 ≈ 23 steps
}

// TODO: create an LayerColor struct for caching colors and reusing, rather than storing that color somewhere on the object?
pub fn get_full_color(index: u32) -> (u32, u32, u32) {
    // Normalize the index
    let normalized_index = index % 30;

    // Determine which color gets the intensity (0=red, 1=green, 2=blue)
    match normalized_index % 3 {
        0 => (get_color(index), 10, 10), // Red
        1 => (10, get_color(index), 10), // Green
        2 => (10, 10, get_color(index)), // Blue
        _ => unreachable!(),
    }
}

use munkres::{solve_assignment, Error, Position, WeightMatrix};

pub fn assign_motion_paths_to_objects(
    cost_matrix: Vec<Vec<f64>>,
) -> Result<Vec<(usize, usize)>, Error> {
    // Flatten the 2D cost matrix into a 1D vector
    let n = cost_matrix.len();
    let flat_matrix: Vec<f64> = cost_matrix.into_iter().flatten().collect();

    // Create a WeightMatrix from the flattened vector
    let mut weights = WeightMatrix::from_row_vec(n, flat_matrix);

    // Solve the assignment problem
    let result = solve_assignment(&mut weights)?;

    // Process the result into (object_index, path_index) pairs
    let assignments = result
        .into_iter()
        .map(|Position { row, column }| (row, column))
        .collect();

    Ok(assignments)
}
