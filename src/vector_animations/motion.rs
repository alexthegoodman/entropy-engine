use std::fs;
use std::path::Path;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

use cgmath::{Point3, Vector3, Vector4};
use wgpu::BindGroupLayout;
use crate::core::Grid::Grid;
use crate::core::RendererState::RendererState;
// use nalgebra::{Point3, Vector3, Vector4};
use crate::core::SimpleCamera::SimpleCamera as Camera;
use crate::core::camera::CameraBinding;
use crate::core::editor::{self, BoundingBox, CANVAS_HORIZ_OFFSET, CANVAS_VERT_OFFSET, Editor, HandlePosition, NUM_INFERENCE_FEATURES, PathType, Point, WindowSize, rgb_to_wgpu};
use crate::core::gpu_resources::{self, GpuResources};
use crate::helpers::saved_data::{SavedState, AppExperience};
use crate::helpers::timelines::{SavedTimelineStateConfig, TrackType};
use crate::renderer_images::st_image::StImage;
use crate::renderer_text::fonts::FontManager;
use crate::renderer_text::text_due::TextRenderer;
use crate::core::HealthBar::HealthBar;
use crate::renderer_videos::st_video::StVideo;
use crate::screen_capture::capture::{MousePosition, SourceData};
// use crate::renderer_videos::st_video::StVideo;
use crate::shape_primitives::polygon::{Polygon, Stroke};
use crate::vector_animations::animations::{AnimationData, AnimationProperty, BackgroundFill, EasingType, KeyType, KeyframeValue, ObjectType, RangeData, Sequence, UIKeyframe};
use crate::shape_primitives::Cube::Cube;
use crate::deno_engine::DenoEngine;
use crate::game_ui::dialogue_state::DialogueState;
use crate::game_ui::hud::{Crosshair, AmmoDisplay};
use crate::vector_animations::motion_arrow::MotionArrow;
use crate::vector_animations::motion_path::MotionPath;

use cgmath::SquareMatrix;

use rand::Rng;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use strum::IntoEnumIterator;
use strum_macros::EnumIter;

pub struct Motion {
    pub motion_paths: Vec<MotionPath>,
    pub motion_arrows: Vec<MotionArrow>,
    pub canvas_hidden: bool,
    pub motion_arrow_just_placed: bool,
    pub last_motion_arrow_object_id: Uuid,
    pub last_motion_arrow_object_type: ObjectType,
    pub last_motion_arrow_object_dimensions: Option<(f32, f32)>,
    pub last_motion_arrow_end_positions: Option<(Point, Point)>,

    // ai
    // pub inference: Option<CommonMotionInference<Wgpu>>,
    pub generation_count: u32,
    pub generation_curved: bool,
    pub generation_choreographed: bool,
    pub generation_fade: bool,
}

pub enum InputValue {
    Text(String),
    Number(f32),
    // Points(Vec<Point>),
}

impl Motion {
    pub fn new() -> Self {
        Motion {
            last_motion_arrow_object_id: Uuid::nil(),
            last_motion_arrow_object_type: ObjectType::Polygon,
            motion_paths: Vec::new(),
            motion_arrows: Vec::new(),
            canvas_hidden: false,
            motion_arrow_just_placed: false,
            last_motion_arrow_object_dimensions: None,
            generation_count: 4,
            generation_curved: false,
            generation_choreographed: true,
            generation_fade: true,
            last_motion_arrow_end_positions: None,
        }
    }

    fn get_object_bounding_box(&self, editor: Editor, object_id: Uuid, object_type: &ObjectType) -> Option<BoundingBox> {
        match object_type {
            ObjectType::Polygon => {
                editor.stunts_polygons
                    .iter()
                    .find(|p| p.id == object_id)
                    // .map(|p| p.world_bounding_box())
                    .map(|t| {
                        let pos = t.transform.position; // This is center position
                        let dims = t.dimensions;
                        let half_width = dims.0 as f32 / 2.0;
                        let half_height = dims.1 as f32 / 2.0;
                        BoundingBox {
                            min: Point { x: pos.x - half_width, y: pos.y - half_height },
                            max: Point { x: pos.x + half_width, y: pos.y + half_height },
                        }
                    })
            }
            ObjectType::TextItem => {
                editor.stunts_textboxes
                    .iter()
                    .find(|t| t.id == object_id)
                    // .map(|t| {
                    //     let pos = t.transform.position;
                    //     let dims = t.dimensions;
                    //     BoundingBox {
                    //         min: Point { x: pos.x, y: pos.y },
                    //         max: Point { x: pos.x + dims.0 as f32, y: pos.y + dims.1 as f32 },
                    //     }
                    // })
                    .map(|t| {
                        let pos = t.transform.position; // This is center position
                        let dims = t.dimensions;
                        let half_width = dims.0 as f32 / 2.0;
                        let half_height = dims.1 as f32 / 2.0;
                        BoundingBox {
                            min: Point { x: pos.x - half_width, y: pos.y - half_height },
                            max: Point { x: pos.x + half_width, y: pos.y + half_height },
                        }
                    })
            }
            ObjectType::ImageItem => {
                editor.stunts_images
                    .iter()
                    .find(|i| i.id == object_id.to_string())
                    .map(|i| {
                        let pos = i.transform.position; // This is center position
                        let dims = i.dimensions;
                        let half_width = dims.0 as f32 / 2.0;
                        let half_height = dims.1 as f32 / 2.0;
                        BoundingBox {
                            min: Point { x: pos.x - half_width, y: pos.y - half_height },
                            max: Point { x: pos.x + half_width, y: pos.y + half_height },
                        }
                    })
            }
            ObjectType::VideoItem => {
                editor.stunts_videos
                    .iter()
                    .find(|v| v.id == object_id.to_string())
                    .map(|v| {
                        let pos = v.transform.position; // This is center position
                        let dims = v.dimensions;
                        let half_width = dims.0 as f32 / 2.0;
                        let half_height = dims.1 as f32 / 2.0;
                        BoundingBox {
                            min: Point { x: pos.x - half_width, y: pos.y - half_height },
                            max: Point { x: pos.x + half_width, y: pos.y + half_height },
                        }
                    })
            }
        }
    }

    pub fn run_motion_inference(&self, editor: Editor) -> Vec<AnimationData> {
        let mut prompt = "".to_string();
        let mut total = 0;
        for (i, polygon) in editor.stunts_polygons.iter().enumerate() {
            if !polygon.hidden {
                let x = polygon.transform.position.x - CANVAS_HORIZ_OFFSET;
                let x = (x / 800.0) * 100.0; // testing percentage based training
                let y = polygon.transform.position.y - CANVAS_VERT_OFFSET;
                let y = (y / 450.0) * 100.0;

                prompt.push_str(&total.to_string());
                prompt.push_str(", ");
                prompt.push_str("5");
                prompt.push_str(", ");
                prompt.push_str(&polygon.dimensions.0.to_string());
                prompt.push_str(", ");
                prompt.push_str(&polygon.dimensions.1.to_string());
                prompt.push_str(", ");
                prompt.push_str(&(x.round() as i32).to_string());
                prompt.push_str(", ");
                prompt.push_str(&(y.round() as i32).to_string());
                prompt.push_str(", ");
                prompt.push_str("0.000"); // direction
                prompt.push_str(", ");
                prompt.push_str("\n");
                total = total + 1;
            }

            if total > 6 {
                break;
            }
        }

        for (i, text) in editor.stunts_textboxes.iter().enumerate() {
            if !text.hidden {
                let x = text.transform.position.x - CANVAS_HORIZ_OFFSET;
                let x = (x / 800.0) * 100.0; // testing percentage based training
                let y = text.transform.position.y - CANVAS_VERT_OFFSET;
                let y = (y / 450.0) * 100.0;

                prompt.push_str(&total.to_string());
                prompt.push_str(", ");
                prompt.push_str("5");
                prompt.push_str(", ");
                prompt.push_str(&text.dimensions.0.to_string());
                prompt.push_str(", ");
                prompt.push_str(&text.dimensions.1.to_string());
                prompt.push_str(", ");
                prompt.push_str(&(x.round() as i32).to_string());
                prompt.push_str(", ");
                prompt.push_str(&(y.round() as i32).to_string());
                prompt.push_str(", ");
                prompt.push_str("0.000"); // direction
                prompt.push_str(", ");
                prompt.push_str("\n");
                total = total + 1;
            }
            if total > 6 {
                break;
            }
        }

        for (i, image) in editor.stunts_images.iter().enumerate() {
            if !image.hidden {
                let x = image.transform.position.x - CANVAS_HORIZ_OFFSET;
                let x = (x / 800.0) * 100.0; // testing percentage based training
                let y = image.transform.position.y - CANVAS_VERT_OFFSET;
                let y = (y / 450.0) * 100.0;

                prompt.push_str(&total.to_string());
                prompt.push_str(", ");
                prompt.push_str("5");
                prompt.push_str(", ");
                prompt.push_str(&image.dimensions.0.to_string());
                prompt.push_str(", ");
                prompt.push_str(&image.dimensions.1.to_string());
                prompt.push_str(", ");
                prompt.push_str(&(x.round() as i32).to_string());
                prompt.push_str(", ");
                prompt.push_str(&(y.round() as i32).to_string());
                prompt.push_str(", ");
                prompt.push_str("0.000"); // direction
                prompt.push_str(", ");
                prompt.push_str("\n");
                total = total + 1;
            }

            if total > 6 {
                break;
            }
        }

        for (i, video) in editor.stunts_videos.iter().enumerate() {
            if !video.hidden {
                let x = video.transform.position.x - CANVAS_HORIZ_OFFSET;
                let x = (x / 800.0) * 100.0; // testing percentage based training
                let y = video.transform.position.y - CANVAS_VERT_OFFSET;
                let y = (y / 450.0) * 100.0;

                prompt.push_str(&total.to_string());
                prompt.push_str(", ");
                prompt.push_str("5");
                prompt.push_str(", ");
                prompt.push_str(&video.dimensions.0.to_string());
                prompt.push_str(", ");
                prompt.push_str(&video.dimensions.1.to_string());
                prompt.push_str(", ");
                prompt.push_str(&(x.round() as i32).to_string());
                prompt.push_str(", ");
                prompt.push_str(&(y.round() as i32).to_string());
                prompt.push_str(", ");
                prompt.push_str("0.000"); // direction
                prompt.push_str(", ");
                prompt.push_str("\n");
                total = total + 1;
            }

            if total > 6 {
                break;
            }
        }

        println!("prompt {:?}", prompt);

        // let inference = self.inference.as_ref().expect("Couldn't get inference");
        // let predictions: Vec<f32> = inference
        //     // .infer("0, 5, 354, 154, 239, 91, \n1, 5, 544, 244, 106, 240, ".to_string());
        //     .infer(prompt);

        // // predictions are 6 rows per line in the prompt, with each row containing: `object_index, time, width, height, x, y`
        // for (i, predicted) in predictions.clone().into_iter().enumerate() {
        //     if i % NUM_INFERENCE_FEATURES == 0 {
        //         println!();
        //     }
        //     print!("{}, ", predicted);
        // }

        // // create motion paths from predictions, each prediction must be rounded
        // let motion_path_keyframes = self.create_motion_paths_from_predictions(predictions);

        // motion_path_keyframes

        Vec::new()
    }

    pub fn create_motion_paths_from_predictions(
        &self,
        editor: &Editor,
        predictions: Vec<f32>,
        // is_choreographed: bool,
    ) -> Vec<AnimationData> {
        let mut animation_data_vec = Vec::new();
        let values_per_prediction = NUM_INFERENCE_FEATURES;
        let keyframes_per_object = 6;
        // let timestamp_percs = vec![
        //     0.0,
        //     2500.0 / 20000.0,
        //     5000.0 / 20000.0,
        //     15000.0 / 20000.0,
        //     17500.0 / 20000.0,
        //     20000.0 / 20000.0,
        // ];

        let timestamp_diffs = vec![
            // from start
            0.0, 2500.0, 5000.0, // from end
            -5000.0, -2500.0, 0.0,
        ];

        // Calculate total number of objects from predictions
        let total_predictions = predictions.len();
        let num_objects = total_predictions / (values_per_prediction * keyframes_per_object);

        // Get current positions of all objects
        let mut current_positions = Vec::new();
        let mut total = 0;
        for (i, polygon) in editor.stunts_polygons.iter().enumerate() {
            if !polygon.hidden {
                current_positions.push((
                    total,
                    20000,
                    polygon.transform.position.x - CANVAS_HORIZ_OFFSET,
                    polygon.transform.position.y - CANVAS_VERT_OFFSET,
                ));
                total = total + 1;
            }
        }
        for (i, text) in editor.stunts_textboxes.iter().enumerate() {
            if !text.hidden {
                current_positions.push((
                    total,
                    20000,
                    text.transform.position.x - CANVAS_HORIZ_OFFSET,
                    text.transform.position.y - CANVAS_VERT_OFFSET,
                ));
                total = total + 1;
            }
        }
        for (i, image) in editor.stunts_images.iter().enumerate() {
            if !image.hidden {
                current_positions.push((
                    total,
                    20000,
                    image.transform.position.x - CANVAS_HORIZ_OFFSET,
                    image.transform.position.y - CANVAS_VERT_OFFSET,
                ));
                total = total + 1;
            }
        }
        for (i, video) in editor.stunts_videos.iter().enumerate() {
            if !video.hidden {
                current_positions.push((
                    total,
                    video.source_duration_ms,
                    video.transform.position.x - CANVAS_HORIZ_OFFSET,
                    video.transform.position.y - CANVAS_VERT_OFFSET,
                ));
                total = total + 1;
            }
        }

        // If choreographed, find the longest path
        let mut longest_path = None;
        if self.generation_choreographed {
            let mut max_distance = 0.0;
            for object_idx in 0..num_objects {
                let mut path_length = 0.0;
                let mut prev_x = None;
                let mut prev_y = None;

                for keyframe_idx in 0..keyframes_per_object {
                    let base_idx = object_idx * (values_per_prediction * keyframes_per_object)
                        + keyframe_idx * values_per_prediction;

                    if base_idx + 5 >= predictions.len() {
                        continue;
                    }

                    let x = ((predictions[base_idx + 4] * 0.01) * 800.0).round() as i32;
                    let y = ((predictions[base_idx + 5] * 0.01) * 450.0).round() as i32;

                    if let (Some(px), Some(py)) = (prev_x, prev_y) {
                        let dx = (x - px) as f32;
                        let dy = (y - py) as f32;
                        path_length += (dx * dx + dy * dy).sqrt();
                    }

                    prev_x = Some(x);
                    prev_y = Some(y);
                }

                if path_length > max_distance {
                    max_distance = path_length;
                    longest_path = Some(object_idx);
                }
            }
        }

        // Process each object
        for object_idx in 0..current_positions.len() {
            let item_id = self.get_item_id(editor, object_idx);
            let object_type = self.get_object_type(editor, object_idx);

            let total_duration = match object_type.clone().expect("Couldn't get object type") {
                ObjectType::VideoItem => {
                    editor.stunts_videos
                        .iter()
                        .find(|v| v.id == item_id.clone().expect("Couldn't get item id"))
                        .expect("Couldn't get video")
                        .source_duration_ms as f32
                }
                _ => 20000.0,
            };

            let timestamps = vec![
                // from start
                0.0,
                2500.0,
                5000.0,
                // from end
                total_duration - 5000.0,
                total_duration - 2500.0,
                total_duration,
            ];

            // Determine which path to use
            let path_source_idx = if self.generation_choreographed {
                longest_path.unwrap_or(object_idx)
            } else {
                object_idx
            };

            let mut position_keyframes = Vec::new();

            // Get the object's current position
            let (_, _, current_x, current_y) = current_positions[object_idx];

            // Calculate center point for the range period
            // let range_center_time =
            //     (timestamp_percs[2] + timestamp_percs[3]) / 2.0 * total_duration;
            let range_center_idx = path_source_idx * (values_per_prediction * keyframes_per_object)
                + 2 * values_per_prediction;
            let center_x = ((predictions[range_center_idx + 4] * 0.01) * 800.0).round() as i32;
            let center_y = ((predictions[range_center_idx + 5] * 0.01) * 450.0).round() as i32;

            // Calculate offset to center the path on the object
            let offset_x = current_x as i32 - center_x;
            let offset_y = current_y as i32 - center_y;

            // Create keyframes with the offset applied
            for keyframe_time_idx in 0..keyframes_per_object {
                if self.generation_count == 4 && (keyframe_time_idx == 1 || keyframe_time_idx == 4)
                {
                    continue;
                }

                let base_idx = path_source_idx * (values_per_prediction * keyframes_per_object)
                    + keyframe_time_idx * values_per_prediction;

                if base_idx + 5 >= predictions.len() {
                    continue;
                }

                let predicted_x =
                    ((predictions[base_idx + 4] * 0.01) * 800.0).round() as i32 + offset_x;
                let predicted_y =
                    ((predictions[base_idx + 5] * 0.01) * 450.0).round() as i32 + offset_y;

                // Calculate timestamp based on whether it's relative to start or end
                let timestamp = if keyframe_time_idx < 3 {
                    // First three timestamps are relative to start
                    timestamp_diffs[keyframe_time_idx]
                } else {
                    // Last three timestamps are relative to end
                    total_duration + timestamp_diffs[keyframe_time_idx]
                };

                let keyframe = UIKeyframe {
                    id: Uuid::new_v4().to_string(),
                    time: Duration::from_millis(timestamp as u64),
                    value: KeyframeValue::Position([predicted_x, predicted_y]),
                    easing: EasingType::EaseInOut,
                    path_type: PathType::Linear,
                    key_type: KeyType::Frame,
                };

                position_keyframes.push(keyframe);
            }

            // Handle Range keyframes
            if position_keyframes.len() == 6 {
                let forth_keyframe = &position_keyframes.clone()[3];
                let third_keyframe = &mut position_keyframes[2];
                third_keyframe.key_type = KeyType::Range(RangeData {
                    end_time: forth_keyframe.time,
                });
                position_keyframes.remove(3);
            }

            if position_keyframes.len() == 4 {
                let mid2_keyframe = &position_keyframes.clone()[2];
                let mid_keyframe = &mut position_keyframes[1];
                mid_keyframe.key_type = KeyType::Range(RangeData {
                    end_time: mid2_keyframe.time,
                });
                position_keyframes.remove(2);
            }

            // Create final keyframes with curves if needed
            let mut final_position_keyframes: Vec<UIKeyframe> = Vec::new();
            if self.generation_curved {
                for keyframe in position_keyframes.iter() {
                    if let Some(prev_keyframe) = final_position_keyframes.last_mut() {
                        prev_keyframe.path_type = prev_keyframe.calculate_default_curve(&keyframe);
                    }
                    final_position_keyframes.push(keyframe.clone());
                }
            } else {
                final_position_keyframes = position_keyframes;
            }

            // Create animation data (keep existing code for creating properties)
            if !final_position_keyframes.is_empty() && item_id.is_some() {
                let mut properties = vec![
                    // Position property with predicted values
                    AnimationProperty {
                        name: "Position".to_string(),
                        property_path: "position".to_string(),
                        children: Vec::new(),
                        keyframes: final_position_keyframes,
                        depth: 0,
                    },
                    // Default properties for rotation, scale, opacity
                    AnimationProperty {
                        name: "Rotation".to_string(),
                        property_path: "rotation".to_string(),
                        children: Vec::new(),
                        keyframes: timestamps
                            .iter()
                            .map(|&t| UIKeyframe {
                                id: Uuid::new_v4().to_string(),
                                time: Duration::from_millis(t as u64),
                                value: KeyframeValue::Rotation(0),
                                easing: EasingType::EaseInOut,
                                path_type: PathType::Linear,
                                // should be same as position? or safe to be independent?
                                key_type: KeyType::Frame,
                            })
                            .collect(),
                        depth: 0,
                    },
                    AnimationProperty {
                        name: "Scale".to_string(),
                        property_path: "scale".to_string(),
                        children: Vec::new(),
                        keyframes: timestamps
                            .iter()
                            .map(|&t| UIKeyframe {
                                id: Uuid::new_v4().to_string(),
                                time: Duration::from_millis(t as u64),
                                value: KeyframeValue::Scale(100),
                                easing: EasingType::EaseInOut,
                                path_type: PathType::Linear,
                                // should be same as position? or safe to be independent?
                                key_type: KeyType::Frame,
                            })
                            .collect(),
                        depth: 0,
                    },
                    AnimationProperty {
                        name: "Opacity".to_string(),
                        property_path: "opacity".to_string(),
                        children: Vec::new(),
                        keyframes: timestamps
                            .iter()
                            .enumerate()
                            .map(|(i, &t)| {
                                let mut opacity = 100;
                                if self.generation_fade {
                                    if i == 0 || i == timestamps.len() - 1 {
                                        opacity = 0;
                                    }
                                }

                                UIKeyframe {
                                    id: Uuid::new_v4().to_string(),
                                    time: Duration::from_millis(t as u64),
                                    value: KeyframeValue::Opacity(opacity),
                                    easing: EasingType::EaseInOut,
                                    path_type: PathType::Linear,
                                    // should be same as position? or safe to be independent?
                                    key_type: KeyType::Frame,
                                }
                            })
                            .collect(),
                        depth: 0,
                    },
                ];

                if object_type.as_ref().unwrap_or(&ObjectType::Polygon) == &ObjectType::VideoItem {
                    properties.push(AnimationProperty {
                        name: "Zoom / Popout".to_string(),
                        property_path: "zoom".to_string(),
                        children: Vec::new(),
                        keyframes: timestamps
                            .iter()
                            .map(|&t| UIKeyframe {
                                id: Uuid::new_v4().to_string(),
                                time: Duration::from_millis(t as u64),
                                value: KeyframeValue::Zoom(100),
                                easing: EasingType::EaseInOut,
                                path_type: PathType::Linear,
                                // should be same as position? or safe to be independent?
                                key_type: KeyType::Frame,
                            })
                            .collect(),
                        depth: 0,
                    });
                }

                animation_data_vec.push(AnimationData {
                    id: Uuid::new_v4().to_string(),
                    object_type: object_type.unwrap_or(ObjectType::Polygon),
                    polygon_id: item_id.unwrap(),
                    duration: Duration::from_millis(total_duration as u64),
                    start_time_ms: 0,
                    position: [0, 0],
                    properties,
                });
            }
        }

        animation_data_vec
    }

    // Helper function to get item ID based on object index
    fn get_item_id(&self, editor: &Editor, object_idx: usize) -> Option<String> {
        // let polygon_count = editor.stunts_polygons.len();
        // let text_count = editor.stunts_textboxes.len();
        let visible_polygons: Vec<&Polygon> = editor.stunts_polygons.iter().filter(|p| !p.hidden).collect();
        let visible_texts: Vec<&TextRenderer> =
            editor.stunts_textboxes.iter().filter(|t| !t.hidden).collect();
        let visible_images: Vec<&StImage> = editor.stunts_images.iter().filter(|i| !i.hidden).collect();
        let visible_videos: Vec<&StVideo> = editor.stunts_videos.iter().filter(|v| !v.hidden).collect();

        let polygon_count = editor.stunts_polygons.iter().filter(|p| !p.hidden).count();
        let text_count = editor.stunts_textboxes.iter().filter(|t| !t.hidden).count();
        let image_count = editor.stunts_images.iter().filter(|i| !i.hidden).count();

        match object_idx {
            idx if idx < polygon_count => Some(visible_polygons[idx].id.clone().to_string()),
            idx if idx < polygon_count + text_count => {
                Some(visible_texts[idx - polygon_count].id.clone().to_string())
            }
            idx if idx < polygon_count + text_count + visible_images.len() => Some(
                visible_images[idx - (polygon_count + text_count)]
                    .id
                    .clone(),
            ),
            idx if idx
                < polygon_count + text_count + visible_images.len() + visible_videos.len() =>
            {
                Some(
                    visible_videos[idx - (polygon_count + text_count + visible_images.len())]
                        .id
                        .clone(),
                )
            }
            _ => None,
        }
    }

    // Helper function to get object type based on object index
    fn get_object_type(&self, editor: &Editor, object_idx: usize) -> Option<ObjectType> {
        // let polygon_count = editor.stunts_polygons.len();
        // let text_count = editor.stunts_textboxes.len();

        let polygon_count = editor.stunts_polygons.iter().filter(|p| !p.hidden).count();
        let text_count = editor.stunts_textboxes.iter().filter(|t| !t.hidden).count();
        let image_count = editor.stunts_images.iter().filter(|i| !i.hidden).count();
        let video_count = editor.stunts_videos.iter().filter(|i| !i.hidden).count();

        match object_idx {
            idx if idx < polygon_count => Some(ObjectType::Polygon),
            idx if idx < polygon_count + text_count => Some(ObjectType::TextItem),
            idx if idx < polygon_count + text_count + image_count => Some(ObjectType::ImageItem),
            idx if idx < polygon_count + text_count + image_count + video_count => {
                Some(ObjectType::VideoItem)
            }
            _ => None,
        }
    }

    pub fn step_motion_path_animations(
        &mut self,
        editor: &mut Editor,
        provided_current_time_s: Option<f64>,
    ) {
        if !editor.is_playing {
            return;
        }

        // TODO: disable time based dt determination for export only
        let now = std::time::Instant::now();
        // let dt = if let Some(last_time) = self.last_frame_time {
        //     (now - last_time).as_secs_f32()
        // } else {
        //     0.0
        // };
        let total_dt = if let Some(start_playing_time) = editor.start_playing_time {
            (now - start_playing_time).as_secs_f32()
        } else {
            0.0
        };
        let total_dt = if let Some(provided_current_time_s) = provided_current_time_s {
            provided_current_time_s
        } else {
            total_dt as f64
        };
        editor.last_frame_time = Some(now);

        self.step_animate_sequence(editor, total_dt as f32);
    }

    /// Steps the currently selected sequence unless one is provided
    /// TODO: make more efficient
    pub fn step_animate_sequence(&mut self, editor: &mut Editor, total_dt: f32) {
        let gpu_resources = editor
            .gpu_resources
            .as_ref()
            .expect("Couldn't get GPU Resources");
        let state = editor
            .stunts_state
            .as_ref()
            .expect("Couldn't get sequence");
        let paths = state
            .object_motion_paths
            .as_ref()
            .expect("Couldn't get sequence");
        let camera = editor.camera.as_ref().expect("Couldn't get camera");

        // Update each animation path
        for animation in paths {
            // Group transform position
            let path_group_position = animation.position;

            // Get current time within animation duration
            let current_time =
                Duration::from_secs_f32(total_dt as f32);
            let start_time = Duration::from_millis(animation.start_time_ms as u64);

            // Check if the current time is within the animation's active period
            if current_time < start_time || current_time > start_time + animation.duration {
                continue;
            }

            // Find the polygon to update
            let object_idx = match animation.object_type {
                ObjectType::Polygon => editor
                    .stunts_polygons
                    .iter()
                    .position(|p| p.id.to_string() == animation.polygon_id),
                ObjectType::TextItem => editor
                    .stunts_textboxes
                    .iter()
                    .position(|t| t.id.to_string() == animation.polygon_id),
                ObjectType::ImageItem => editor
                    .stunts_images
                    .iter()
                    .position(|i| i.id.to_string() == animation.polygon_id),
                ObjectType::VideoItem => editor
                    .stunts_videos
                    .iter()
                    .position(|i| i.id.to_string() == animation.polygon_id),
            };

            let Some(object_idx) = object_idx else {
                continue;
            };

            // Determine whether to draw the video frame based on the frame rate and current time
            // step rate is throttled to 60FPS
            // if video frame rate is 60FPS, then call draw on each frame
            // if video frame rate is 30FPS, then call draw on every other frame
            let mut animate_properties = false;

            if animation.object_type == ObjectType::VideoItem {
                let frame_rate = editor.stunts_videos[object_idx].source_frame_rate;
                let source_duration_ms = editor.stunts_videos[object_idx].source_duration_ms;
                let frame_interval = Duration::from_secs_f64(1.0 / frame_rate as f64);

                // Calculate the number of frames that should have been displayed by now
                let elapsed_time: Duration = current_time - start_time;
                let current_frame_time = editor.stunts_videos[object_idx].num_frames_drawn as f64
                    * frame_interval.as_secs_f64();
                // let last_frame_time = self.last_frame_time.expect("Couldn't get last frame time");

                // println!(
                //     "current times {:?} frame: {:?}",
                //     current_time.as_secs_f64(),
                //     current_frame_time
                // );

                // Only draw the frame if the current time is within the frame's display interval
                if current_time.as_secs_f64() >= current_frame_time
                    && current_time.as_secs_f64()
                        < current_frame_time + frame_interval.as_secs_f64()
                {
                    if current_time.as_millis() + 1000 < source_duration_ms as u128 {
                        editor.stunts_videos[object_idx]
                            .draw_video_frame(&gpu_resources.device, &gpu_resources.queue)
                            .expect("Couldn't draw video frame");

                        animate_properties = true;
                        editor.stunts_videos[object_idx].num_frames_drawn += 1;
                    }
                } else {
                    // TODO: deteermine distance between current_time and current_frame_time to determine
                    // how many video frames to draw to catch up
                    let difference = current_time.as_secs_f64() - current_frame_time;
                    let catch_up_frames =
                        (difference / frame_interval.as_secs_f64()).floor() as u32;

                    // Only catch up if we're behind and within the video duration
                    if catch_up_frames > 0
                        && current_time.as_millis() + 1000 < source_duration_ms as u128
                    {
                        // Limit the maximum number of frames to catch up to avoid excessive CPU usage
                        let max_catch_up = 5;
                        let frames_to_draw = catch_up_frames.min(max_catch_up);

                        // println!("frames_to_draw {:?}", frames_to_draw);

                        for _ in 0..frames_to_draw {
                            editor.stunts_videos[object_idx]
                                .draw_video_frame(&gpu_resources.device, &gpu_resources.queue)
                                .expect("Couldn't draw catch-up video frame");

                            editor.stunts_videos[object_idx].num_frames_drawn += 1;
                        }

                        animate_properties = true;

                        // println!(
                        //     "Caught up {} frames out of {} needed",
                        //     frames_to_draw, catch_up_frames
                        // );
                    }
                }
            } else {
                animate_properties = true;
            }

            // let mut animate_properties = false;

            // Modified video drawing code
            // if animation.object_type == ObjectType::VideoItem {
            //     let frame_rate = editor.stunts_videos[object_idx].source_frame_rate;
            //     let source_duration_ms = editor.stunts_videos[object_idx].source_duration_ms;

            //     // Initialize frame timer if not exists
            //     if editor.stunts_videos[object_idx].frame_timer.is_none() {
            //         editor.stunts_videos[object_idx].frame_timer = Some(FrameTimer::new());
            //     }

            //     // Get number of frames to draw this step
            //     let frames_to_draw = editor.stunts_videos[object_idx]
            //         .frame_timer
            //         .as_mut()
            //         .expect("Couldn't get frame timer")
            //         .update_and_get_frames_to_draw(current_time, frame_rate as f32);

            //     // Draw the required number of frames
            //     if frames_to_draw > 0
            //         && current_time.as_millis() + 1000 < source_duration_ms as u128
            //     {
            //         println!("frames_to_draw {:?}", frames_to_draw);
            //         // Draw each frame
            //         for _ in 0..frames_to_draw {
            //             editor.stunts_videos[object_idx]
            //                 .draw_video_frame(&gpu_resources.device, &gpu_resources.queue)
            //                 .expect("Couldn't draw video frame");
            //         }

            //         animate_properties = true;
            //     }
            // }

            if !animate_properties {
                return;
            }

            // Go through each property
            for property in &animation.properties {
                if property.keyframes.len() < 2 {
                    continue;
                }

                if start_time > current_time {
                    continue;
                }

                // Find the surrounding keyframes
                let (start_frame, end_frame) = self.get_surrounding_keyframes(
                    &mut property.keyframes.clone(), // do not love clone in loop
                    current_time - start_time,
                );
                let Some((start_frame, end_frame)) = start_frame.zip(end_frame) else {
                    continue;
                };

                // Calculate interpolation progress
                let duration = (end_frame.time - start_frame.time).as_secs_f32(); // duration between keyframes
                let elapsed = (current_time - start_time - start_frame.time).as_secs_f32(); // elapsed since start keyframe
                let mut progress = elapsed / duration;

                // Apply easing (EaseInOut)
                progress = if progress < 0.5 {
                    2.0 * progress * progress
                } else {
                    1.0 - (-2.0 * progress + 2.0).powi(2) / 2.0
                };

                // do not update a property when start and end are the same
                // TODO: make this a setting for zooms so the center_point can continue its interpolation?
                // if start_frame.value == end_frame.value {
                //     continue;
                // }

                // Apply the interpolated value to the object's property
                match (&start_frame.value, &end_frame.value) {
                    (KeyframeValue::Position(start), KeyframeValue::Position(end)) => {
                        let x = self.lerp(start[0], end[0], progress);
                        let y = self.lerp(start[1], end[1], progress);

                        let position = Point {
                            x: CANVAS_HORIZ_OFFSET + x + path_group_position[0] as f32,
                            y: CANVAS_VERT_OFFSET + y + path_group_position[1] as f32,
                        };

                        match animation.object_type {
                            ObjectType::Polygon => {
                                editor.stunts_polygons[object_idx]
                                    .transform
                                    .update_position([position.x, position.y, 0.0]);
                            }
                            ObjectType::TextItem => {
                                editor.stunts_textboxes[object_idx]
                                    .transform
                                    .update_position([position.x, position.y, 0.0]);
                                editor.stunts_textboxes[object_idx]
                                    .background_polygon
                                    .transform
                                    .update_position([position.x, position.y, 0.0]);
                            }
                            ObjectType::ImageItem => {
                                editor.stunts_images[object_idx]
                                    .transform
                                    .update_position([position.x, position.y, 0.0]);
                            }
                            ObjectType::VideoItem => {
                                editor.stunts_videos[object_idx]
                                    .transform
                                    .update_position([position.x, position.y, 0.0]);
                            }
                        }
                    }
                    (KeyframeValue::Rotation(start), KeyframeValue::Rotation(end)) => {
                        // rotation is stored as degrees
                        let new_rotation = self.lerp(*start, *end, progress);

                        let new_rotation_rad = new_rotation.to_radians();

                        match animation.object_type {
                            ObjectType::Polygon => {
                                editor.stunts_polygons[object_idx]
                                    .transform
                                    .update_rotation([new_rotation_rad, 0.0, 0.0]);
                            }
                            ObjectType::TextItem => {
                                editor.stunts_textboxes[object_idx]
                                    .transform
                                    .update_rotation([new_rotation_rad, 0.0, 0.0]);
                                editor.stunts_textboxes[object_idx]
                                    .background_polygon
                                    .transform
                                    .update_rotation([new_rotation_rad, 0.0, 0.0]);
                            }
                            ObjectType::ImageItem => {
                                editor.stunts_images[object_idx]
                                    .transform
                                    .update_rotation([new_rotation_rad, 0.0, 0.0]);
                            }
                            ObjectType::VideoItem => {
                                editor.stunts_videos[object_idx]
                                    .transform
                                    .update_rotation([new_rotation_rad, 0.0, 0.0]);
                            }
                        }
                    }
                    (KeyframeValue::Scale(start), KeyframeValue::Scale(end)) => {
                        // scale is stored out 100 (100 being standard size, ie. 100%)
                        let new_scale = self.lerp(*start, *end, progress) as f32 / 100.0;

                        // TODO: verify scale on all objects as some treat it differently as-is

                        match animation.object_type {
                            ObjectType::Polygon => {
                                editor.stunts_polygons[object_idx]
                                    .transform
                                    .update_scale([new_scale, new_scale, 1.0]);
                            }
                            ObjectType::TextItem => {
                                editor.stunts_textboxes[object_idx]
                                    .transform
                                    .update_scale([new_scale, new_scale, 1.0]);
                                editor.stunts_textboxes[object_idx]
                                    .background_polygon
                                    .transform
                                    .update_scale([new_scale, new_scale, 1.0]);
                            }
                            ObjectType::ImageItem => {
                                let original_scale = editor.stunts_images[object_idx].dimensions;
                                editor.stunts_images[object_idx].transform.update_scale([
                                    original_scale.0 as f32 * new_scale,
                                    original_scale.1 as f32 * new_scale,
                                    1.0
                                ]);
                            }
                            ObjectType::VideoItem => {
                                let original_scale = editor.stunts_videos[object_idx].dimensions;
                                editor.stunts_videos[object_idx].transform.update_scale([
                                    original_scale.0 as f32 * new_scale,
                                    original_scale.1 as f32 * new_scale,
                                    1.0
                                ]);
                            }
                        }
                    }
                    (KeyframeValue::Opacity(start), KeyframeValue::Opacity(end)) => {
                        // opacity is out 100 (100%)
                        let opacity = self.lerp(*start, *end, progress) / 100.0;

                        let gpu_resources = editor
                            .gpu_resources
                            .as_ref()
                            .expect("Couldn't get gpu resources");

                        match animation.object_type {
                            ObjectType::Polygon => {
                                editor.stunts_polygons[object_idx]
                                    .update_opacity(&gpu_resources.queue, opacity);
                            }
                            ObjectType::TextItem => {
                                editor.stunts_textboxes[object_idx]
                                    .update_opacity(&gpu_resources.queue, opacity);
                                editor.stunts_textboxes[object_idx]
                                    .background_polygon
                                    .update_opacity(&gpu_resources.queue, opacity);
                            }
                            ObjectType::ImageItem => {
                                editor.stunts_images[object_idx]
                                    .update_opacity(&gpu_resources.queue, opacity);
                            }
                            ObjectType::VideoItem => {
                                editor.stunts_videos[object_idx]
                                    .update_opacity(&gpu_resources.queue, opacity);
                            }
                        }
                    }
                    (KeyframeValue::Zoom(start), KeyframeValue::Zoom(end)) => {
                        let zoom = self.lerp(*start, *end, progress) / 100.0;

                        let gpu_resources = editor
                            .gpu_resources
                            .as_ref()
                            .expect("Couldn't get gpu resources");

                        match animation.object_type {
                            ObjectType::VideoItem => {
                                let video_item = &mut editor.stunts_videos[object_idx];
                                let elapsed_ms = current_time.as_millis() as u128;

                                let autofollow_delay = 150;

                                if let (Some(mouse_positions), Some(source_data)) = (
                                    video_item.mouse_positions.as_ref(),
                                    video_item.source_data.as_ref(),
                                ) {
                                    // Check if we need to update the shift points
                                    let should_update_shift = match video_item.last_shift_time {
                                        Some(last_shift_time) => {
                                            elapsed_ms - last_shift_time > autofollow_delay
                                        }
                                        None => {
                                            video_item.last_shift_time = Some(elapsed_ms);

                                            if let Some((start_point, end_point)) = mouse_positions
                                                .iter()
                                                .filter(|p| p.timestamp >= elapsed_ms)
                                                .zip(mouse_positions.iter().filter(|p| {
                                                    p.timestamp >= elapsed_ms + autofollow_delay
                                                }))
                                                .next()
                                                .map(|(start, end)| {
                                                    ((*start).clone(), (*end).clone())
                                                })
                                            {
                                                video_item.last_start_point = Some(start_point);
                                                video_item.last_end_point = Some(end_point);
                                            }

                                            false
                                        }
                                    };

                                    let delay_offset = 500; // Potential time offset for a consistent lag
                                    let min_distance = 100.0; // Distance to incur a shift
                                    let base_alpha = 0.01; // Your current default value
                                    let max_alpha = 0.1; // Maximum blending speed
                                    let scaling_factor = 0.01; // Controls how quickly alpha increases with distance

                                    // Update shift points if needed
                                    if should_update_shift {
                                        if let Some((start_point, end_point)) = mouse_positions
                                            .iter()
                                            .filter(|p| {
                                                p.timestamp
                                                    >= (elapsed_ms - autofollow_delay)
                                                        + delay_offset
                                                    && p.timestamp
                                                        < video_item.source_duration_ms as u128
                                            })
                                            .zip(mouse_positions.iter().filter(|p| {
                                                p.timestamp >= elapsed_ms + delay_offset
                                                    && p.timestamp
                                                        < video_item.source_duration_ms as u128
                                            }))
                                            .next()
                                            .map(|(start, end)| ((*start).clone(), (*end).clone()))
                                        {
                                            if let Some(last_start_point) =
                                                video_item.last_start_point
                                            {
                                                if let Some(last_end_point) =
                                                    video_item.last_end_point
                                                {
                                                    let dx = start_point.x - last_start_point.x;
                                                    let dy = start_point.y - last_start_point.y;
                                                    let distance = (dx * dx + dy * dy).sqrt(); // Euclidean distance

                                                    let dx2 = end_point.x - last_end_point.x;
                                                    let dy2 = end_point.y - last_end_point.y;
                                                    let distance2 = (dx2 * dx2 + dy2 * dy2).sqrt(); // Euclidean distance

                                                    if distance >= min_distance
                                                        || distance2 >= min_distance
                                                    {
                                                        video_item.last_shift_time =
                                                            Some(elapsed_ms);

                                                        video_item.last_start_point =
                                                            Some(start_point);
                                                        video_item.last_end_point = Some(end_point);

                                                        // Use the larger of the two distances
                                                        let max_distance = distance.max(distance2);

                                                        // Exponential smoothing that plateaus
                                                        let dynamic_alpha = base_alpha
                                                            + (max_alpha - base_alpha)
                                                                * (1.0
                                                                    - (-scaling_factor
                                                                        * max_distance)
                                                                        .exp());

                                                        video_item.dynamic_alpha = dynamic_alpha;
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    // Always interpolate between the current shift points
                                    if let (Some(start), Some(end)) =
                                        (&video_item.last_start_point, &video_item.last_end_point)
                                    {
                                        let clamped_elapsed_ms =
                                            elapsed_ms.clamp(start.timestamp, end.timestamp);

                                        let time_progress = (clamped_elapsed_ms - start.timestamp)
                                            as f32
                                            / (end.timestamp - start.timestamp) as f32;

                                        let interpolated_x =
                                            start.x + (end.x - start.x) * time_progress;
                                        let interpolated_y =
                                            start.y + (end.y - start.y) * time_progress;

                                        let dimensions = video_item.dimensions;
                                        let source_dimensions = video_item.source_dimensions;

                                        let new_center_point = Point {
                                            x: ((interpolated_x - source_data.x as f32)
                                                / source_dimensions.0 as f32)
                                                * dimensions.0 as f32,
                                            y: ((interpolated_y - source_data.y as f32)
                                                / source_dimensions.1 as f32)
                                                * dimensions.1 as f32,
                                        };

                                        // Smooth transition with existing center point
                                        let blended_center_point = if let Some(last_center_point) =
                                            video_item.last_center_point
                                        {
                                            // need to calculate a dynamic alpha based on distance between start and and end point
                                            // let alpha = 0.01; // this was a close value, but not quite right depending on distance
                                            let alpha = video_item.dynamic_alpha;

                                            Point {
                                                x: last_center_point.x * (1.0 - alpha)
                                                    + new_center_point.x * alpha,
                                                y: last_center_point.y * (1.0 - alpha)
                                                    + new_center_point.y * alpha,
                                            }
                                        } else {
                                            new_center_point
                                        };

                                        video_item.update_zoom(
                                            &gpu_resources.queue,
                                            zoom,
                                            blended_center_point,
                                        );
                                        video_item.last_center_point = Some(blended_center_point);

                                        // video_item.update_popout(
                                        //     &gpu_resources.queue,
                                        //     blended_center_point,
                                        //     1.5,
                                        //     (200.0, 200.0),
                                        // );
                                    }
                                }
                            }
                            _ => {
                                // println!("Zoom not supported here");
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    // pub fn get_surrounding_keyframes<'a>(
    //     &self,
    //     keyframes: &'a [UIKeyframe],
    //     current_time: Duration,
    // ) -> (Option<&'a UIKeyframe>, Option<&'a UIKeyframe>) {
    //     let mut prev_frame = None;
    //     let mut next_frame = None;

    //     for (i, frame) in keyframes.iter().enumerate() {
    //         if frame.time > current_time {
    //             next_frame = Some(frame);
    //             prev_frame = if i > 0 {
    //                 Some(&keyframes[i - 1])
    //             } else {
    //                 Some(&keyframes[keyframes.len() - 1])
    //             };
    //             break;
    //         }
    //     }

    //     // Handle wrap-around case
    //     if next_frame.is_none() {
    //         prev_frame = keyframes.last();
    //         next_frame = keyframes.first();
    //     }

    //     (prev_frame, next_frame)
    // }

    /// Returns a "virtual" keyframe for the end keyframe in case of a Range type
    pub fn get_surrounding_keyframes(
        &self,
        keyframes: &mut [UIKeyframe],
        current_time: Duration,
    ) -> (Option<UIKeyframe>, Option<UIKeyframe>) {
        let mut prev_frame = None;
        let mut next_frame = None;

        // TODO: need to pick prev_frame based on timing not index
        // so just sort the keyframes here
        keyframes.sort_by_key(|k| k.time);

        for (i, frame) in keyframes.iter().enumerate() {
            if frame.time > current_time {
                // Check if the previous frame is a range
                if i > 0 {
                    if let KeyType::Range(range_data) = &keyframes[i - 1].key_type {
                        // Case 1: Current time is within the range
                        if current_time >= keyframes[i - 1].time
                            && current_time < range_data.end_time
                        {
                            // Current time is within a range
                            prev_frame = Some(keyframes[i - 1].clone());
                            next_frame = Some(UIKeyframe {
                                id: "virtual".to_string(),
                                time: range_data.end_time,
                                value: keyframes[i - 1].value.clone(),
                                easing: EasingType::Linear, // Doesn't matter for static ranges
                                path_type: PathType::Linear, // Doesn't matter for static ranges
                                key_type: KeyType::Frame, // Virtual keyframe is treated as a frame
                            });
                            return (prev_frame, next_frame);
                        }

                        // Case 2: Current time is after the range but before the next keyframe
                        if current_time >= range_data.end_time && current_time < frame.time {
                            prev_frame = Some(UIKeyframe {
                                id: "virtual".to_string(),
                                time: range_data.end_time, // End of the range
                                value: keyframes[i - 1].value.clone(), // Same value as start
                                easing: EasingType::Linear, // Doesn't matter for static ranges
                                path_type: PathType::Linear, // Doesn't matter for static ranges
                                key_type: KeyType::Frame,  // Virtual keyframe is treated as a frame
                            });
                            next_frame = Some(frame.clone()); // Next actual keyframe
                            return (prev_frame, next_frame);
                        }
                    }
                }

                // Regular keyframe logic

                next_frame = Some(frame.clone());
                prev_frame = if i > 0 {
                    Some(keyframes[i - 1].clone())
                } else {
                    Some(keyframes[keyframes.len() - 1].clone())
                };
                break;
            }
        }

        // Handle wrap-around case
        // can result in a duration subtraction error
        // if next_frame.is_none() {
        //     prev_frame = keyframes.last().cloned();
        //     next_frame = keyframes.first().cloned();
        // }

        (prev_frame, next_frame)
    }

    pub fn lerp(&self, start: i32, end: i32, progress: f32) -> f32 {
        start as f32 + ((end - start) as f32 * progress)
    }

    /// Create motion path visualization for a polygon
    /// // TODO: make for curves. already creates segments for the purpose
    pub fn create_motion_path_visualization(
        &mut self,
        editor: &Editor,
        sequence: &Sequence,
        polygon_id: &str,
        color_index: u32,
    ) {
        let animation_data = sequence
            .polygon_motion_paths
            .iter()
            .find(|anim| anim.polygon_id == polygon_id)
            .expect("Couldn't find animation data for polygon");

        // Find position property
        let position_property = animation_data
            .properties
            .iter()
            .find(|prop| prop.name.starts_with("Position"))
            .expect("Couldn't find position property");

        // Sort keyframes by time
        let mut keyframes = position_property.keyframes.clone();
        keyframes.sort_by_key(|k| k.time);

        // let new_id = Uuid::new_v4();
        let new_id = Uuid::from_str(&animation_data.id).expect("Couldn't convert string to uuid");
        let initial_position = animation_data.position;
        let camera = editor.camera.as_ref().expect("Couldn't get camera");
        let gpu_resources = editor
            .gpu_resources
            .as_ref()
            .expect("Couldn't get GPU Resources");

        // Create MotionPath
        let motion_path = MotionPath::new(
            &gpu_resources.device,
            &gpu_resources.queue,
            editor.model_bind_group_layout
                .as_ref()
                .expect("Couldn't get model bind group layout"),
            editor.group_bind_group_layout
                .as_ref()
                .expect("Couldn't get model bind group layout"),
            new_id,
            &camera.viewport.window_size,
            keyframes,
            camera,
            // sequence,
            // &mut self.static_polygons,
            color_index,
            polygon_id,
            initial_position,
        );

        self.motion_paths.push(motion_path);
    }

    /// Update the motion path visualization when keyframes change
    pub fn update_motion_paths(&mut self, editor: &Editor, sequence: &Sequence) {
        // Remove existing motion path segments
        // self.static_polygons.retain(|p| {
        //     p.name != "motion_path_segment"
        //         && p.name != "motion_path_handle"
        //         && p.name != "motion_path_arrow"
        // });

        // Remove existing motion paths
        self.motion_paths.clear();

        // Recreate motion paths for all polygons
        let mut color_index = 1;
        for polygon_config in &sequence.active_polygons {
            self.create_motion_path_visualization(editor, sequence, &polygon_config.id, color_index);
            color_index = color_index + 1;
        }
        // Recreate motion paths for all texts
        for text_config in &sequence.active_text_items {
            self.create_motion_path_visualization(editor, sequence, &text_config.id, color_index);
            color_index = color_index + 1;
        }
        // Recreate motion paths for all images
        for image_config in &sequence.active_image_items {
            self.create_motion_path_visualization(editor, sequence, &image_config.id, color_index);
            color_index = color_index + 1;
        }
        // Recreate motion paths for all videos
        for video_config in &sequence.active_video_items {
            self.create_motion_path_visualization(editor, sequence, &video_config.id, color_index);
            color_index = color_index + 1;
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