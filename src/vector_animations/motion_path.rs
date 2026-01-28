// use cgmath::SquareMatrix;
// use cgmath::{Matrix4, Vector2};
use image::GenericImageView;
use nalgebra::{Matrix4, Vector3};
use std::str::FromStr;
use std::sync::Arc;
use uuid::Uuid;
use wgpu::util::DeviceExt;
use wgpu::{Device, Queue};

use crate::core::SimpleCamera::SimpleCamera;
use crate::core::Transform_2::{Transform, matrix4_to_raw_array};
use crate::core::editor::{Point, WindowSize, get_full_color, rgb_to_wgpu};
use crate::shape_primitives::polygon::{Polygon, Stroke};
use crate::vector_animations::animations::{EasingType, KeyType, KeyframeValue, UIKeyframe};
use crate::vector_animations::motion::interpolate_position;

// maybe unnecessary for MotionPath
#[derive(Clone)]
pub struct MotionPathConfig {
    pub id: String,
    pub dimensions: (u32, u32),
    pub position: Point,
}

pub struct MotionPath {
    pub id: Uuid,
    pub transform: Transform,
    // pub dimensions: (u32, u32),
    pub bind_group: wgpu::BindGroup,
    pub static_polygons: Vec<Polygon>,
    pub source_polygon_id: Uuid,
}

impl MotionPath {
    pub fn new(
        device: &Device,
        queue: &Queue,
        model_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        new_id: Uuid,
        window_size: &WindowSize,
        keyframes: Vec<UIKeyframe>,
        camera: &SimpleCamera,
        // sequence: &Sequence,
        color_index: u32,
        associated_polygon_id: &str,
        initial_position: [i32; 2],
    ) -> MotionPath {
        let (fill_r, fill_g, fill_b) = get_full_color(color_index);
        let path_fill = rgb_to_wgpu(fill_r as u8, fill_g as u8, fill_b as u8, 255.0);

        let polygon_id =
            Uuid::from_str(associated_polygon_id).expect("Couldn't convert string to uuid");

        let mut static_polygons = Vec::new();

        // Create path segments between consecutive keyframes
        let mut pairs_done = 0;
        for window in keyframes.windows(2) {
            let start_kf = &window[0];
            let end_kf = &window[1];

            let start_kf_id =
                Uuid::from_str(&start_kf.id).expect("Couldn't convert string to uuid");
            let end_kf_id = Uuid::from_str(&end_kf.id).expect("Couldn't convert string to uuid");

            if let (KeyframeValue::Position(start_pos), KeyframeValue::Position(end_pos)) =
                (&start_kf.value, &end_kf.value)
            {
                let start_point = Point {
                    x: start_pos[0] as f32,
                    y: start_pos[1] as f32,
                };
                let end_point = Point {
                    x: end_pos[0] as f32,
                    y: end_pos[1] as f32,
                };

                // Create intermediate points for curved paths if using non-linear easing
                let num_segments = match start_kf.easing {
                    EasingType::Linear => 1,
                    _ => 9, // More segments for smooth curves
                };

                if pairs_done == 0 {
                    // handle for first keyframe in path
                    let mut handle = create_path_handle(
                        &window_size,
                        &device,
                        &queue,
                        &model_bind_group_layout,
                        &group_bind_group_layout,
                        &camera,
                        start_point,
                        12.0, // width and height
                        String::new(),
                        path_fill,
                        0.0,
                    );

                    handle.source_polygon_id = Some(polygon_id);
                    handle.source_keyframe_id = Some(start_kf_id);
                    handle.source_path_id = Some(new_id);

                    handle.update_group_position(initial_position);

                    static_polygons.push(handle);
                }

                // handles for remaining keyframes

                let mut handle = match &end_kf.key_type {
                    KeyType::Frame => create_path_handle(
                        &window_size,
                        &device,
                        &queue,
                        &model_bind_group_layout,
                        &group_bind_group_layout,
                        &camera,
                        end_point,
                        12.0, // width and height
                        String::new(),
                        path_fill,
                        0.0,
                    ),
                    KeyType::Range(range_data) => create_path_handle(
                        &window_size,
                        &device,
                        &queue,
                        &model_bind_group_layout,
                        &group_bind_group_layout,
                        &camera,
                        end_point,
                        12.0, // width and height
                        String::new(),
                        path_fill,
                        45.0,
                    ),
                };

                handle.source_polygon_id = Some(polygon_id);
                handle.source_keyframe_id = Some(end_kf_id);
                handle.source_path_id = Some(new_id);

                handle.update_group_position(initial_position);

                static_polygons.push(handle);

                let segment_duration =
                    (end_kf.time.as_secs_f32() - start_kf.time.as_secs_f32()) / num_segments as f32;

                let mut odd = false;
                for i in 0..num_segments {
                    let t1 = start_kf.time.as_secs_f32() + segment_duration * i as f32;
                    let t2 = start_kf.time.as_secs_f32() + segment_duration * (i + 1) as f32;

                    // println!("pos1");
                    let pos1 = interpolate_position(start_kf, end_kf, t1);
                    // println!("pos2");
                    let pos2 = interpolate_position(start_kf, end_kf, t2);

                    let path_start = Point {
                        x: pos1[0] as f32,
                        y: pos1[1] as f32,
                    };

                    let path_end = Point {
                        x: pos2[0] as f32,
                        y: pos2[1] as f32,
                    };

                    // Calculate rotation angle from start to end point
                    let dx = path_end.x - path_start.x;
                    let dy = path_end.y - path_start.y;
                    let rotation = dy.atan2(dx);

                    // Calculate length of the segment
                    let length = (dx * dx + dy * dy).sqrt();

                    // println!("length {:?}", length);

                    let mut segment = create_path_segment(
                        &window_size,
                        &device,
                        &queue,
                        &model_bind_group_layout,
                        &group_bind_group_layout,
                        &camera,
                        path_start,
                        path_end,
                        2.0, // thickness of the path
                        String::new(),
                        path_fill,
                        rotation,
                        length,
                    );

                    segment.source_path_id = Some(new_id);
                    segment.source_polygon_id = Some(polygon_id);

                    segment.update_group_position(initial_position);

                    static_polygons.push(segment);

                    // arrow for indicating direction of motion
                    if odd {
                        let arrow_orientation_offset = -std::f32::consts::FRAC_PI_2; // for upward-facing arrow
                        let mut arrow = create_path_arrow(
                            &window_size,
                            &device,
                            &queue,
                            &model_bind_group_layout,
                            &group_bind_group_layout,
                            &camera,
                            path_end,
                            15.0, // width and height
                            String::new(),
                            path_fill,
                            rotation + arrow_orientation_offset,
                        );

                        arrow.update_group_position(initial_position);

                        static_polygons.push(arrow);
                    }

                    odd = !odd;
                }

                pairs_done = pairs_done + 1;
            }
        }

        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Image Uniform Buffer"),
            contents: bytemuck::cast_slice(&raw_matrix),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        // Now create your bind group with these defaults
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &group_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
            label: None,
        });

        let group_transform = Transform::new(
            Vector3::new(initial_position[0] as f32, initial_position[1] as f32, 0.0), // everything can move relative to this
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(1.0, 1.0, 1.0),
            uniform_buffer,
            // window_size,
        );

        // group_transform.layer = 100.0;
        group_transform.update_uniform_buffer(&queue);

        Self {
            id: new_id,
            transform: group_transform,
            // dimensions: dynamic_dimensions,
            bind_group,
            static_polygons,
            source_polygon_id: polygon_id,
        }
    }

    pub fn update_data_from_position(
        &mut self,
        window_size: &WindowSize,
        device: &wgpu::Device,
        bind_group_layout: &wgpu::BindGroupLayout,
        position: Point,
        camera: &SimpleCamera,
    ) {
        self.transform
            .update_position([position.x, position.y, 0.0]);

        self.static_polygons.iter_mut().for_each(|p| {
            p.update_group_position([position.x as i32, position.y as i32]);
        });
    }

    // pub fn contains_point(&self, point: &Point, camera: &Camera) -> bool {
    //     let untranslated = Point {
    //         x: point.x - (self.transform.position.x),
    //         y: point.y - self.transform.position.y,
    //     };

    //     // Check if the point is within -0.5 to 0.5 range
    //     untranslated.x >= -0.5 * self.dimensions.0 as f32
    //         && untranslated.x <= 0.5 * self.dimensions.0 as f32
    //         && untranslated.y >= -0.5 * self.dimensions.1 as f32
    //         && untranslated.y <= 0.5 * self.dimensions.1 as f32
    // }

    // pub fn to_local_space(&self, world_point: Point, camera: &Camera) -> Point {
    //     let untranslated = Point {
    //         x: world_point.x - (self.transform.position.x),
    //         y: world_point.y - self.transform.position.y,
    //     };

    //     let local_point = Point {
    //         x: untranslated.x / (self.dimensions.0 as f32),
    //         y: untranslated.y / (self.dimensions.1 as f32),
    //     };

    //     local_point
    // }
}

/// Creates a path segment using a rotated square
fn create_path_segment(
    window_size: &WindowSize,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    model_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
    group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
    camera: &SimpleCamera,
    start: Point,
    end: Point,
    thickness: f32,
    selected_sequence_id: String,
    fill: [f32; 4],
    rotation: f32,
    length: f32,
) -> Polygon {
    // Calculate segment midpoint for position
    let position = Point {
        x: (start.x + end.x) / 2.0,
        y: (start.y + end.y) / 2.0,
    };

    // Create polygon using default square points
    let polygon = Polygon::new(
        window_size,
        device,
        queue,
        model_bind_group_layout,
        group_bind_group_layout,
        camera,
        vec![
            Point { x: 0.0, y: 0.0 },
            Point { x: 1.0, y: 0.0 },
            Point { x: 1.0, y: 1.0 },
            Point { x: 0.0, y: 1.0 },
        ],
        (length, thickness), // width = length of segment, height = thickness
        position,
        (rotation, 0.0, 0.0),
        0.0,
        // [0.5, 0.8, 1.0, 1.0], // light blue with some transparency
        fill,
        Stroke {
            thickness: 0.0,
            fill: rgb_to_wgpu(0, 0, 0, 255.0),
        },
        // 0.0,
        // 2550, // break out z index function and other layers?
        5,
        String::from("motion_path_segment"),
        Uuid::new_v4(),
        Uuid::from_str(&selected_sequence_id).expect("Couldn't convert string to uuid"),
    );

    // polygon.transform.layer = 17.0;
    // polygon.transform.update_uniform_buffer(queue, window_size);

    polygon
}

/// Creates a path handle for dragging and showing direction
fn create_path_handle(
    window_size: &WindowSize,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    model_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
    group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
    camera: &SimpleCamera,
    end: Point,
    size: f32,
    selected_sequence_id: String,
    fill: [f32; 4],
    rotation: f32,
) -> Polygon {
    // println!("make handle");

    let polygon = Polygon::new(
        window_size,
        device,
        queue,
        model_bind_group_layout,
        group_bind_group_layout,
        camera,
        vec![
            Point { x: 0.0, y: 0.0 },
            Point { x: 1.0, y: 0.0 },
            Point { x: 1.0, y: 1.0 },
            Point { x: 0.0, y: 1.0 },
        ],
        (size, size), // width = length of segment, height = thickness
        end,
        (rotation, 0.0, 0.0),
        0.0,
        // [0.5, 0.8, 1.0, 1.0], // light blue with some transparency
        fill,
        Stroke {
            thickness: 0.0,
            fill: rgb_to_wgpu(0, 0, 0, 255.0),
        },
        // 0.0,
        // 2550, // break out z index function and other layers?
         5,
        String::from("motion_path_handle"),
        Uuid::new_v4(),
        Uuid::from_str(&selected_sequence_id).expect("Couldn't convert string to uuid"),
    );

    // polygon.transform.layer = -100.05;
    // polygon.transform.update_uniform_buffer(queue, window_size);

    polygon
}

/// Creates arrow for showing direction
fn create_path_arrow(
    window_size: &WindowSize,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    model_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
    group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
    camera: &SimpleCamera,
    end: Point,
    size: f32,
    selected_sequence_id: String,
    fill: [f32; 4],
    rotation: f32,
) -> Polygon {
    Polygon::new(
        window_size,
        device,
        queue,
        model_bind_group_layout,
        group_bind_group_layout,
        camera,
        vec![
            // rightside up
            Point { x: 0.0, y: 0.0 },
            Point { x: 0.5, y: 0.6 },
            Point { x: 1.0, y: 0.0 },
            Point { x: 0.5, y: 1.0 },
            // upside down
            // Point { x: 1.0, y: 1.0 },
            // Point { x: 0.5, y: 0.4 },
            // Point { x: 0.0, y: 1.0 },
            // Point { x: 0.5, y: 0.0 },
        ],
        (size, size), // width = length of segment, height = thickness
        end,
        (rotation, 0.0, 0.0),
        0.0,
        // [0.5, 0.8, 1.0, 1.0], // light blue with some transparency
        fill,
        Stroke {
            thickness: 0.0,
            fill: rgb_to_wgpu(0, 0, 0, 255.0),
        },
        // 0.0,
        // 2550, // break out z index function and other layers?
         5,
        String::from("motion_path_arrow"),
        Uuid::new_v4(),
        Uuid::from_str(&selected_sequence_id).expect("Couldn't convert string to uuid"),
    )
}