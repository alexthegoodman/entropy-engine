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
        // Center it in the minimap
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
        camera: &Camera, // Needed for new polygon creation if any
    ) {
        if !self.visible {
            return;
        }

        // Update Player Marker (always center, rotates)
        // With "North Up" map, player arrow rotates.
        // With "Player Up" map (centered on player arrow), the map rotates.
        
        // Request: "remained centered on the player arrow"
        // Interpretation: Player arrow is fixed in center pointing UP. The world rotates around it.
        
        // let center_screen_x = self.screen_position.x + (self.width / 2.0);
        // let center_screen_y = self.screen_position.y + (self.height / 2.0);

        // // Player marker fixed at center, pointing UP
        // let marker_half_size = self.player_marker.dimensions.0 / 2.0;
        // self.player_marker.transform.update_position([
        //     center_screen_x - marker_half_size, 
        //     center_screen_y - marker_half_size, 
        //     0.0
        // ]);

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

        self.player_marker.transform.update_rotation([0.0, 0.0, player_rotation_y + std::f32::consts::PI]); // Fixed UP
        self.player_marker.transform.update_uniform_buffer(queue);

        // Scale factor: pixels per world unit
        // Assuming landscape_size fits in map width when fully zoomed out?
        // Let's use a fixed zoom for now, e.g., 1.0 world unit = 1.0 pixel (too small?)
        // Or map width covers `landscape_size` / zoom.
        let scale = (self.width / landscape_size) * 5.0; // 5x Zoom

        // Update NPCs
        let mut active_npc_ids = Vec::new();
        for npc in npcs {
            active_npc_ids.push(npc.id.clone());
            
            if let Some(rb) = rigid_body_set.get(npc.rigid_body_handle) {
                let npc_pos = rb.translation();
                let relative_pos = npc_pos - player_position;

                // Rotate relative position by -player_rotation_y to align with "Player Up" view
                // Rotation around Y axis in world space corresponds to 2D rotation.
                // If player rotates Y (Yaw), the world should rotate -Y.
                
                let angle = -player_rotation_y;
                let rotated_x = relative_pos.x * angle.cos() - relative_pos.z * angle.sin();
                let rotated_z = relative_pos.x * angle.sin() + relative_pos.z * angle.cos();

                // Map to screen
                // In world Z is forward/-forward. In screen -Y is up.
                // World +Z is usually "South" or "Back". World -Z is "North" or "Forward".
                // Screen +Y is Down. Screen -Y is Up.
                // If Player faces -Z (standard forward), and that is "Up" on screen (-Y).
                // relative_pos.z (forward dist) should map to -screen_y.
                
                // Let's assume standard math: 
                // x -> x
                // z -> y
                let screen_offset_x = rotated_x * scale;
                let screen_offset_y = rotated_z * scale; // Inverted Z for screen Y? Depends on coord system.
                // Usually Forward (-Z) -> Up (-Y). 
                // If rotated_z is positive (behind player), it should go Down (+Y).
                // So +Z -> +Y. Yes.

                let target_x = map_x + screen_offset_x;
                let target_y = map_y + screen_offset_y;

                // Check bounds (circle or box)
                // Simple box check
                let half_width = self.width / 2.0;
                let half_height = self.height / 2.0;
                
                let in_bounds = screen_offset_x.abs() < half_width && screen_offset_y.abs() < half_height;

                // Create marker if missing
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
                }

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
        
        // Clean up stale NPC markers
        self.npc_markers.retain(|id, _| active_npc_ids.contains(id));


        // Update Collectables
        let mut active_col_ids = Vec::new();
        for col in collectables {
            active_col_ids.push(col.id.clone());
            
            if let Some(rb) = rigid_body_set.get(col.rigid_body_handle) {
                let col_pos = rb.translation();
                let relative_pos = col_pos - player_position;
                
                let angle = -player_rotation_y;
                let rotated_x = relative_pos.x * angle.cos() - relative_pos.z * angle.sin();
                let rotated_z = relative_pos.x * angle.sin() + relative_pos.z * angle.cos();

                let screen_offset_x = rotated_x * scale;
                let screen_offset_y = rotated_z * scale;

                let target_x = map_x + screen_offset_x;
                let target_y = map_y + screen_offset_y;

                let half_width = self.width / 2.0;
                let half_height = self.height / 2.0;
                let in_bounds = screen_offset_x.abs() < half_width && screen_offset_y.abs() < half_height;

                // Create marker if missing
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
        
        // Clean up stale Collectable markers
        self.collectable_markers.retain(|id, _| active_col_ids.contains(id));
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
