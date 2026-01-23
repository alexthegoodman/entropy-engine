use std::sync::Arc;
use uuid::Uuid;
use std::collections::HashMap;
use crate::core::editor::{Point, WindowSize, Editor};
use crate::shape_primitives::polygon::{Polygon, Stroke};
use crate::core::SimpleCamera::SimpleCamera as Camera;
use nalgebra::Vector3;
use crate::model_components::NPC::NPC;
use crate::model_components::Collectable::Collectable;
use rapier3d::prelude::RigidBodySet;

pub struct MiniMap {
    pub background: Polygon,
    pub player_marker: Polygon,
    
    // Markers for other entities
    pub npc_markers: HashMap<String, Polygon>,
    pub collectable_markers: HashMap<String, Polygon>,
    
    pub width: f32,
    pub height: f32,
    pub zoom: f32,
    pub visible: bool,
    // Store original position to handle relative updates
    screen_position: Point,
    
    // Resources needed for creating new polygons
    device: Arc<wgpu::Device>,
    queue: Arc<wgpu::Queue>,
    model_bind_group_layout: Arc<wgpu::BindGroupLayout>,
    group_bind_group_layout: Arc<wgpu::BindGroupLayout>,
    window_size: WindowSize,
    // Storing camera config for polygon creation, but ideally should be passed or updated
    // For 2D UI polygons, the camera passed to ::new is mostly for screen size reference in some implementations
    // but Polygon uses it. We'll store a reference or just use the current camera passed in update?
    // Polygon::new takes &Camera. We'll need access to a camera.
}

impl MiniMap {
    pub fn new(
        device: &Arc<wgpu::Device>,
        queue: &Arc<wgpu::Queue>,
        model_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        window_size: &WindowSize,
        camera: &Camera,
    ) -> Self {
        let width = 200.0;
        let height = 200.0;
        let padding = 120.0;
        
        // Position in bottom-left corner
        // need to update upon window resize
        let position = Point {
            x: padding,
            y: window_size.height as f32 - (height / 2.0) - 20.0,
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
        // Center it in the minimap
        let marker_size = 10.0;
        // let marker_pos = Point {
        //     x: position.x + (width / 2.0) - (marker_size / 2.0),
        //     y: position.y + (height / 2.0) - (marker_size / 2.0),
        // };
        let marker_pos = Point {
            x: 0.0,
            y: 0.0,
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
            npc_markers: HashMap::new(),
            collectable_markers: HashMap::new(),
            width,
            height,
            zoom: 1.0,
            visible: true,
            screen_position: position,
            device: device.clone(),
            queue: queue.clone(),
            model_bind_group_layout: model_bind_group_layout.clone(),
            group_bind_group_layout: group_bind_group_layout.clone(),
            window_size: window_size.clone(),
        }
    }

    pub fn update_all(
        &mut self,
        queue: &wgpu::Queue,
        player_position: Vector3<f32>,
        player_rotation_y: f32, // Yaw
        landscape_center: Vector3<f32>,
        landscape_size: f32,
        npcs: &Vec<NPC>,
        collectables: &Vec<Collectable>,
        rigid_body_set: &RigidBodySet,
        camera: &Camera,
    ) {
        if !self.visible {
            return;
        }

        // Player marker is ALWAYS at the center of the minimap
        // let center_screen_x = self.screen_position.x + (self.width / 2.0);
        // let center_screen_y = self.screen_position.y + (self.height / 2.0);
        let center_screen_x = self.screen_position.x; // since minimap is positioned according to its center, not top-left
        let center_screen_y = self.screen_position.y;
        let marker_half_size = self.player_marker.dimensions.0 / 2.0;
        
        self.player_marker.transform.update_position([
            center_screen_x - marker_half_size, 
            center_screen_y - marker_half_size, 
            0.0
        ]);
        
        // Player arrow points up (north), so rotate to show player's actual facing
        self.player_marker.transform.update_rotation([0.0, 0.0, player_rotation_y + std::f32::consts::PI]);
        self.player_marker.transform.update_uniform_buffer(queue);

        // Scale factor: adjust this to control zoom level
        // Higher value = more zoomed in (shows less area)
        // let scale = 5.0;
        let scale = 1.25;

        // Update NPCs
        let mut active_npc_ids = Vec::new();
        for npc in npcs {
            active_npc_ids.push(npc.id.clone());
            
            if let Some(rb) = rigid_body_set.get(npc.rigid_body_handle) {
                let npc_pos = rb.translation();
                
                // Calculate position RELATIVE to player
                let relative_pos = npc_pos - player_position;

                // Rotate relative position by -player_rotation_y to keep map "north-up"
                // as player rotates
                let angle = -player_rotation_y;
                let rotated_x = relative_pos.x * angle.cos() - relative_pos.z * angle.sin();
                let rotated_z = relative_pos.x * angle.sin() + relative_pos.z * angle.cos();

                // Convert to screen offset from center
                let screen_offset_x = rotated_x * scale;
                let screen_offset_y = rotated_z * scale;

                // Calculate final screen position (offset from player's centered position)
                let target_x = center_screen_x + screen_offset_x;
                let target_y = center_screen_y + screen_offset_y;

                // Check if within minimap bounds
                let half_width = self.width / 2.0;
                let half_height = self.height / 2.0;
                let in_bounds = screen_offset_x.abs() < half_width && screen_offset_y.abs() < half_height;

                // Create marker if it doesn't exist
                if !self.npc_markers.contains_key(&npc.id) {
                    let marker_size = 8.0;
                    let marker = Polygon::new(
                        &self.window_size,
                        &self.device,
                        &self.queue,
                        &self.model_bind_group_layout,
                        &self.group_bind_group_layout,
                        camera,
                        vec![
                            Point { x: 0.0, y: 0.0 },
                            Point { x: 1.0, y: 0.0 },
                            Point { x: 1.0, y: 1.0 },
                            Point { x: 0.0, y: 1.0 },
                        ],
                        (marker_size, marker_size),
                        Point { x: 0.0, y: 0.0 },
                        (0.0, 0.0, 0.0),
                        2.0,
                        [1.0, 1.0, 0.0, 1.0], // Yellow for NPCs
                        Stroke { thickness: 1.0, fill: [0.0, 0.0, 0.0, 1.0] },
                        101,
                        format!("NPC Marker {}", npc.id),
                        Uuid::new_v4(),
                        Uuid::nil(),
                    );
                    self.npc_markers.insert(npc.id.clone(), marker);
                    // println!("Insert NPC marker: {}", npc.id.clone());
                }

                // Update marker position and visibility
                if let Some(marker) = self.npc_markers.get_mut(&npc.id) {
                    if in_bounds {
                        marker.hidden = false;
                        marker.transform.update_position([
                            target_x - (marker.dimensions.0 / 2.0),
                            target_y - (marker.dimensions.1 / 2.0),
                            0.0
                        ]);
                        marker.transform.update_uniform_buffer(queue);
                    } else {
                        marker.hidden = true;
                    }
                }
            }
        }
        
        // Clean up markers for NPCs that no longer exist
        self.npc_markers.retain(|id, _| active_npc_ids.contains(id));

        // println!("Active NPC markers: {}", self.npc_markers.len());

        // Update Collectables (same logic as NPCs)
        let mut active_col_ids = Vec::new();
        for col in collectables {
            active_col_ids.push(col.id.clone());
            
            if let Some(rb) = rigid_body_set.get(col.rigid_body_handle) {
                let col_pos = rb.translation();
                
                // Calculate position RELATIVE to player
                let relative_pos = col_pos - player_position;
                
                // Rotate to maintain orientation
                let angle = -player_rotation_y;
                let rotated_x = relative_pos.x * angle.cos() - relative_pos.z * angle.sin();
                let rotated_z = relative_pos.x * angle.sin() + relative_pos.z * angle.cos();

                // Convert to screen offset
                let screen_offset_x = rotated_x * scale;
                let screen_offset_y = rotated_z * scale;

                // Calculate final position
                let target_x = center_screen_x + screen_offset_x;
                let target_y = center_screen_y + screen_offset_y;

                // Bounds check
                let half_width = self.width / 2.0;
                let half_height = self.height / 2.0;
                let in_bounds = screen_offset_x.abs() < half_width && screen_offset_y.abs() < half_height;

                // Create marker if it doesn't exist
                if !self.collectable_markers.contains_key(&col.id) {
                    let marker_size = 6.0;
                    let marker = Polygon::new(
                        &self.window_size,
                        &self.device,
                        &self.queue,
                        &self.model_bind_group_layout,
                        &self.group_bind_group_layout,
                        camera,
                        vec![
                            Point { x: 0.5, y: 0.0 }, // Diamond shape
                            Point { x: 1.0, y: 0.5 },
                            Point { x: 0.5, y: 1.0 },
                            Point { x: 0.0, y: 0.5 },
                        ],
                        (marker_size, marker_size),
                        Point { x: 0.0, y: 0.0 },
                        (0.0, 0.0, 0.0),
                        0.0,
                        [0.0, 0.5, 1.0, 1.0], // Blue for Collectables
                        Stroke { thickness: 1.0, fill: [1.0, 1.0, 1.0, 1.0] },
                        101,
                        format!("Collectable Marker {}", col.id),
                        Uuid::new_v4(),
                        Uuid::nil(),
                    );
                    self.collectable_markers.insert(col.id.clone(), marker);
                }

                // Update marker position and visibility
                if let Some(marker) = self.collectable_markers.get_mut(&col.id) {
                    if in_bounds {
                        marker.hidden = false;
                        marker.transform.update_position([
                            target_x - (marker.dimensions.0 / 2.0),
                            target_y - (marker.dimensions.1 / 2.0),
                            0.0
                        ]);
                        marker.transform.update_uniform_buffer(queue);
                    } else {
                        marker.hidden = true;
                    }
                }
            }
        }
        
        // Clean up markers for collectables that no longer exist
        self.collectable_markers.retain(|id, _| active_col_ids.contains(id));
    }

    pub fn resize(&mut self, queue: &wgpu::Queue, window_size: &WindowSize) {
        self.window_size = window_size.clone();
        let padding = 120.0;
        let position = Point {
            x: padding,
            y: window_size.height as f32 - (self.height / 2.0) - 20.0,
        };
        self.screen_position = position;

        // Update background position
        self.background.transform.update_position([position.x, position.y, 0.0]);
        self.background.transform.update_uniform_buffer(queue);

        // We don't need to update markers here immediately because update_all is called every frame
        // and it uses self.screen_position.
    }
}

pub fn init_mini_map(
    editor: &mut Editor,
    device: &Arc<wgpu::Device>,
    queue: &Arc<wgpu::Queue>,
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
