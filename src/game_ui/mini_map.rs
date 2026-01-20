use std::sync::Arc;
use uuid::Uuid;
use crate::core::editor::{Point, WindowSize, Editor};
use crate::shape_primitives::polygon::{Polygon, Stroke};
use crate::core::SimpleCamera::SimpleCamera as Camera;
use nalgebra::Vector3;

pub struct MiniMap {
    pub background: Polygon,
    pub player_marker: Polygon,
    pub width: f32,
    pub height: f32,
    pub zoom: f32,
    pub visible: bool,
    // Store original position to handle relative updates
    screen_position: Point,
}

impl MiniMap {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        model_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        window_size: &WindowSize,
        camera: &Camera,
    ) -> Self {
        let width = 200.0;
        let height = 200.0;
        let padding = 120.0;
        
        // Position in bottom-left corner
        let position = Point {
            x: padding,
            y: window_size.height as f32 - height,
        };

        // Create background (dark semi-transparent rectangle)
        let background = Polygon::new(
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
            (width, height),
            position,
            (0.0, 0.0, 0.0),
            10.0, // border radius
            [0.1, 0.1, 0.1, 0.8], // Dark gray background
            Stroke {
                thickness: 2.0,
                fill: [0.8, 0.8, 0.8, 1.0], // Light gray border
            },
            100, // High layer to be on top
            "MiniMap Background".to_string(),
            Uuid::new_v4(),
            Uuid::nil(),
        );

        // Create player marker (red dot/triangle)
        // Center it in the minimap initially
        let marker_size = 10.0;
        let marker_pos = Point {
            x: position.x + (width / 2.0) - (marker_size / 2.0),
            y: position.y + (height / 2.0) - (marker_size / 2.0),
        };

        let player_marker = Polygon::new(
            window_size,
            device,
            queue,
            model_bind_group_layout,
            group_bind_group_layout,
            camera,
            vec![
                Point { x: 0.5, y: 0.0 }, // Top
                Point { x: 1.0, y: 1.0 }, // Bottom Right
                Point { x: 0.0, y: 1.0 }, // Bottom Left
            ],
            (marker_size, marker_size),
            marker_pos,
            (0.0, 0.0, 0.0),
            1.0,
            [1.0, 0.0, 0.0, 1.0], // Red
            Stroke {
                thickness: 0.0,
                fill: [0.0, 0.0, 0.0, 0.0],
            },
            101, // Above background
            "MiniMap Player Marker".to_string(),
            Uuid::new_v4(),
            Uuid::nil(),
        );

        Self {
            background,
            player_marker,
            width,
            height,
            zoom: 1.0,
            visible: true,
            screen_position: position,
        }
    }

    pub fn update(
        &mut self,
        queue: &wgpu::Queue,
        player_position: Vector3<f32>,
        player_rotation_y: f32, // Yaw
        landscape_center: Vector3<f32>,
        landscape_size: f32, // Assuming square for now
    ) {
        if !self.visible {
            return;
        }
        
        // World Space: -Size/2 to Size/2 -> 0 to 1
        
        let relative_x = (player_position.x - (landscape_center.x - landscape_size / 2.0)) / landscape_size;
        let relative_z = (player_position.z - (landscape_center.z - landscape_size / 2.0)) / landscape_size;

        // Clamp to 0-1 to keep marker inside map
        let clamped_x = relative_x.clamp(0.0, 1.0);
        let clamped_z = relative_z.clamp(0.0, 1.0);

        // Map to screen coordinates within the minimap
        // Z in world is usually Y on 2D map (Top-Down)
        let map_x = self.screen_position.x + (clamped_x * self.width);
        let map_y = self.screen_position.y + (clamped_z * self.height);

        // Centering the marker
        let marker_half_size = self.player_marker.dimensions.0 / 2.0;
        
        self.player_marker.transform.update_position([
            map_x - marker_half_size, 
            map_y - marker_half_size, 
            0.0 // Z-index handled by layer usually
        ]);

        // Rotate marker
        self.player_marker.transform.update_rotation([0.0, 0.0, player_rotation_y + std::f32::consts::PI]); // Adjust offset as needed

        self.player_marker.transform.update_uniform_buffer(queue);
    }
}

pub fn init_mini_map(
    editor: &mut Editor,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
) {
    // We need these resources to be available
    if let (Some(model_bgl), Some(group_bgl), Some(camera), Some(viewport)) = (
        &editor.ui_model_bind_group_layout,
        &editor.group_bind_group_layout,
        &editor.camera,
        editor.viewport.try_lock().ok(), // Use try_lock to avoid deadlocks, though typically safe here
    ) {
        let window_size = WindowSize {
            width: viewport.width as u32,
            height: viewport.height as u32,
        };

        let mini_map = MiniMap::new(
            device,
            queue,
            model_bgl,
            group_bgl,
            &window_size,
            camera,
        );

        editor.mini_map = Some(mini_map);
        println!("MiniMap initialized.");
    } else {
        println!("Failed to initialize MiniMap: Missing resources in Editor.");
    }
}