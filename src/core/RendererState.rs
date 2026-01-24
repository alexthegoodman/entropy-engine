use gltf::json::camera;
use mint::ColumnMatrix4;
use nalgebra::{Isometry3, Point3, UnitQuaternion, Vector3};
use rapier3d::math::Point as RapierPoint;
use rapier3d::prelude::*;
use rapier3d::prelude::{ColliderSet, QueryPipeline, RigidBodySet};
use transform_gizmo::config::TransformPivotPoint;
use uuid::Uuid;
use wgpu::BindGroupLayout;

use crate::art_assets::ScatteredModel::ScatteredModel;
use crate::core::AnimationState::AnimationState;
use crate::core::animation_system;
use crate::core::SimpleCamera::to_row_major_f64;
use crate::core::camera::CameraBinding;
use crate::core::editor::{PointLight, PointLightsUniform, Viewport, WindowSize};
use crate::game_behaviors::stateful::BehaviorState;
use crate::handlers::EntropyPosition;
use crate::helpers::saved_data::{GameSettings, ScatterSettings};
use crate::heightfield_landscapes::QuadNode::QuadNode;
use crate::heightfield_landscapes::TerrainManager::TerrainManager;
use crate::model_components::Collectable::Collectable;
use crate::shape_primitives::Sphere::Sphere;
use crate::core::skinned_pipeline::SkinnedPipeline;
use crate::{
    core::Texture::Texture,
    helpers::saved_data::{ComponentData, ComponentKind},
};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use wgpu::util::DeviceExt;
use std::str::FromStr;

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

#[cfg(target_arch = "wasm32")]
use std::time::Duration;

use transform_gizmo::{enum_set, Gizmo, GizmoConfig, GizmoMode, GizmoOrientation, GizmoVisuals, Rect};
use transform_gizmo::mint::RowMatrix4;


use crate::procedural_models::House::{House, HouseConfig};
use crate::{
    helpers::{landscapes::LandscapePixelData, saved_data::LandscapeTextureKinds},
    heightfield_landscapes::Landscape::Landscape,
    art_assets::Model::Model,
    shape_primitives::{Cube::Cube, Pyramid::Pyramid},
    procedural_grass::grass::Grass,
    procedural_particles::particle_system::ParticleSystem,
    procedural_trees::trees::ProceduralTrees,
    water_plane::water::WaterPlane,
};

use super::Grid::GridConfig;
use crate::model_components::{PlayerCharacter::{PlayerCharacter, MovementState}, NPC::NPC};
use crate::game_ui::quest_state::QuestState;
use super::{
    Grid::Grid,
    Rays::{cast_ray_at_components, create_ray_from_mouse},
    SimpleCamera::SimpleCamera,
};

#[derive(Debug, Clone)]
pub struct MouseState {
    pub is_first_mouse: bool,
    pub last_mouse_x: f64,
    pub last_mouse_y: f64,
    pub right_mouse_pressed: bool,
    pub drag_started: bool,
    pub is_dragging: bool,
    pub hovered_gizmo: bool,
}

// #[derive(Debug, Clone, Copy)]
// pub struct WindowSize {
//     pub width: u32,
//     pub height: u32,
// }

#[derive(Clone, Copy, Debug)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

// Define all possible edit operations
#[derive(Debug)]
pub enum ObjectProperty {
    Width(f32),
}

#[derive(Debug)]
pub struct ObjectEditConfig {
    pub object_id: Uuid,
    pub field_name: String,
    pub old_value: ObjectProperty,
    pub new_value: ObjectProperty,
    // pub signal: RwSignal<String>,
}

#[derive(Clone, Debug)]
pub struct ObjectConfig {
    pub id: Uuid,
    pub name: String,
    pub position: (f32, f32, f32),
}

pub struct DebugRay {
    pub cube: Cube,
    pub expires_at: Instant,
}

// #[derive(std::ops::DerefMut)]
pub struct RendererState {
    pub cubes: Vec<Cube>,
    pub spheres: Vec<Sphere>,
    pub debug_rays: Vec<DebugRay>,
    pub pyramids: Vec<Pyramid>,
    pub grids: Vec<Grid>,
    pub models: Vec<Model>, // must add a Model in order to add an NPC
    pub procedural_houses: Vec<House>,
    pub scattered_models: Vec<crate::art_assets::ScatteredModel::ScatteredModel>,
    // pub skeleton_parts: Vec<SkeletonRenderPart>, // will contain buffers and the like
    pub terrain_managers: Vec<TerrainManager>,
    pub landscapes: Vec<Landscape>,
    pub grasses: Vec<Grass>,
    pub particle_systems: Vec<ParticleSystem>,
    pub procedural_trees: Vec<ProceduralTrees>,
    pub water_planes: Vec<WaterPlane>,
    pub point_lights: Vec<PointLight>,

    // animations
    // pub active_animations: Vec<AnimationPlayback>,

    // wgpu
    pub model_bind_group_layout: Arc<wgpu::BindGroupLayout>,
    pub group_bind_group_layout: Arc<wgpu::BindGroupLayout>,
    pub texture_render_mode_buffer: Arc<wgpu::Buffer>,
    pub regular_texture_render_mode_buffer: Arc<wgpu::Buffer>,
    pub color_render_mode_buffer: Arc<wgpu::Buffer>,
    pub skinned_pipeline: Option<SkinnedPipeline>,
    pub scattered_model_pipeline: Option<crate::core::scattered_model_pipeline::ScatteredModelPipeline>,

    // state
    pub project_selected: Option<Uuid>,
    pub current_view: String,
    pub object_selected: Option<Uuid>,
    pub object_selected_kind: Option<ComponentKind>,
    pub object_selected_data: Option<ComponentData>,
    pub selected_entity_id: Option<String>,  // The model/house/entity ID (for rendering)
    pub selected_component_id: Option<String>,  // The component ID (for saving)

    // physics
    pub gravity: Vector<f32>,
    pub integration_parameters: IntegrationParameters,
    pub physics_pipeline: PhysicsPipeline,
    pub island_manager: IslandManager,
    pub broad_phase: BroadPhaseMultiSap,
    pub narrow_phase: NarrowPhase,
    pub impulse_joint_set: ImpulseJointSet,
    pub multibody_joint_set: MultibodyJointSet,
    pub ccd_solver: CCDSolver,
    pub query_pipeline: QueryPipeline,
    pub rigid_body_set: RigidBodySet,
    pub collider_set: ColliderSet,

    // model components
    pub player_character: Option<PlayerCharacter>,
    pub npcs: Vec<NPC>,
    pub collectables: Vec<Collectable>,

    // pub current_modifiers: ModifiersState,
    pub mouse_state: MouseState,
    pub last_ray: Option<Ray>,
    pub ray_intersecting: bool,
    pub ray_intersection: Option<RapierPoint<f32>>,
    pub ray_component_id: Option<Uuid>,

    pub last_movement_time: Option<Instant>,
    pub last_frame_time: Option<Instant>,

    pub current_mouse_position: Option<EntropyPosition>,
    pub last_mouse_position: Option<EntropyPosition>,
    pub last_mouse_delta: (f32, f32),

    pub navigation_speed: f32,
    pub game_mode: bool,
    pub game_settings: GameSettings,

    // Angles stored in radians (in theory, better controlled here in state)
    pub camera_pitch: f32, // Up/Down rotation
    pub camera_yaw: f32,   // Left/Right rotation
    pub last_mouse_position_time: Instant,
    pub gizmo: Gizmo,

    pub display_debug_spheres: bool,

    pub quest_state: QuestState,
}

// impl<'a> RendererState<'a> {
impl RendererState {
    pub fn new(
        // device: Arc<wgpu::Device>,
        // queue: Arc<wgpu::Queue>,
        // viewport: Arc<Mutex<Viewport>>,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        model_bind_group_layout: Arc<wgpu::BindGroupLayout>,
        group_bind_group_layout: Arc<wgpu::BindGroupLayout>,
        camera: &SimpleCamera,
        // texture_bind_group_layout: Arc<wgpu::BindGroupLayout>,
        // reg_texture_render_mode_buffer: Arc<wgpu::Buffer>,
        texture_render_mode_buffer: Arc<wgpu::Buffer>,
        color_render_mode_buffer: Arc<wgpu::Buffer>,
        regular_texture_render_mode_buffer: Arc<wgpu::Buffer>,
        // camera_uniform_buffer: Arc<wgpu::Buffer>,
        // camera_bind_group: Arc<wgpu::BindGroup>,
        // camera: &SimpleCamera,
        // window_width: u32,
        // window_height: u32,
        // camera_bind_group_layout: Arc<wgpu::BindGroupLayout>,
        // light_bind_group_layout: Arc<wgpu::BindGroupLayout>,
        game_mode: bool,
        skinned_pipeline: SkinnedPipeline,
        scattered_model_pipeline: crate::core::scattered_model_pipeline::ScatteredModelPipeline,
    ) -> Self {
        // create the utility grid(s)
        let mut grids = Vec::new();

        let mut cubes = Vec::new();
        let mut spheres = Vec::new();
        // cubes.push(Cube::new(&device, &queue, &model_bind_group_layout, &group_bind_group_layout, &texture_render_mode_buffer, camera));

        let mut pyramids = Vec::new();

        let mut models = Vec::new();
        let mut procedural_houses = Vec::new();

        let mut landscapes = Vec::new();
        let mut grasses = Vec::new();
        let mut particle_systems = Vec::new();
        let mut water_planes = Vec::new();
        let mut procedural_trees = Vec::new();

        let mut terrain_managers = Vec::new();

        let integration_parameters = IntegrationParameters::default();
        let physics_pipeline = PhysicsPipeline::new();
        let island_manager = IslandManager::new();
        let broad_phase = DefaultBroadPhase::new();
        let narrow_phase = NarrowPhase::new();
        let impulse_joint_set = ImpulseJointSet::new();
        let multibody_joint_set = MultibodyJointSet::new();
        let ccd_solver = CCDSolver::new();
        let query_pipeline = QueryPipeline::new();
        let mut rigid_body_set = RigidBodySet::new();
        let mut collider_set = ColliderSet::new();

        let window_size = camera.viewport.window_size;
        let viewport = Rect {
            min: (0.0, 0.0).into(),
            max: (window_size.width as f32, window_size.height as f32).into(),
        };

        let view_matrix = to_row_major_f64(&camera.get_view());
        let proj_matrix = to_row_major_f64(&camera.get_projection());

        let gizmo = Gizmo::new(GizmoConfig {
            view_matrix,
            projection_matrix: proj_matrix,
            viewport,
            // orientation: GizmoOrientation::Local,
            // pivot_point: TransformPivotPoint::MedianPoint,
            // snapping: false,
            // snap_angle: 15.0,
            // snap_distance: 1.0,
            // snap_scale: 0.1,
            // visuals: GizmoVisuals::default(),
            // pixels_per_point: 1.0,
            ..Default::default()
        });

        // let rigid_body_handle = rigid_body_set.insert(player_character.movement_rigid_body);
        // player_character.movement_rigid_body_handle = Some(rigid_body_handle);

        // // now associate rigidbody with collider
        // let collider_handle = collider_set.insert_with_parent(
        //     player_character.movement_collider,
        //     rigid_body_handle,
        //     &mut rigid_body_set,
        // );
        // player_character.collider_handle = Some(collider_handle);

        Self {
            cubes,
            spheres,
            debug_rays: Vec::new(),
            pyramids,
            grids,
            models,
            scattered_models: Vec::new(),
            procedural_houses,
            landscapes,
            grasses,
            particle_systems,
            water_planes,
            procedural_trees,
            // skeleton_parts,
            terrain_managers,
            // active_animations: Vec::new(),
            point_lights: Vec::new(),
            // light_state,
            collectables: Vec::new(),

            // device,
            // queue,
            // viewport,
            model_bind_group_layout,
            group_bind_group_layout,
            // texture_bind_group_layout,
            // reg_texture_render_mode_buffer,
            regular_texture_render_mode_buffer,
            texture_render_mode_buffer,
            color_render_mode_buffer,
            skinned_pipeline: Some(skinned_pipeline),
            scattered_model_pipeline: Some(scattered_model_pipeline),
            // camera_uniform_buffer,
            // camera_bind_group,
            // light_bind_group_layout,

            project_selected: None,
            current_view: "welcome".to_string(),
            object_selected: None,
            object_selected_kind: None,
            object_selected_data: None,
            selected_entity_id: None,
            selected_component_id: None,

            // translation_gizmo,
            // rotation_gizmo,
            // scale_gizmo,
            // active_gizmo: "translate".to_string(),

            gravity: vector![0.0, -9.81, 0.0],
            integration_parameters,
            physics_pipeline,
            island_manager,
            broad_phase,
            narrow_phase,
            impulse_joint_set,
            multibody_joint_set,
            ccd_solver,
            query_pipeline,
            rigid_body_set,
            collider_set,
            player_character: None,

            // current_modifiers: ModifiersState::empty(),
            mouse_state: MouseState {
                last_mouse_x: 0.0,
                last_mouse_y: 0.0,
                is_first_mouse: true,
                right_mouse_pressed: false,
                drag_started: false,
                is_dragging: false,
                hovered_gizmo: false,
            },
            last_ray: None,
            ray_intersecting: false,
            ray_component_id: None,
            ray_intersection: None,
            // dragging_translation_gizmo: false,
            last_movement_time: None,
            last_frame_time: None,
            current_mouse_position: None,
            last_mouse_position: None,
            npcs: Vec::new(),
            // gizmo_drag_axis: None,
            navigation_speed: 5.0,
            game_mode,
            game_settings: GameSettings {
                third_person: false,
                show_hitscan_line: true,
                ui_theme: None,
            },
            camera_pitch: 0.0,
            camera_yaw: 0.0,
            last_mouse_position_time: Instant::now(),
            gizmo,
            display_debug_spheres: true,
            quest_state: QuestState::new(),
            last_mouse_delta: (0.0, 0.0)
        }
    }

    pub fn alert_nearby_npcs(&mut self, position: Vector3<f32>, radius: f32) {
        let mut alerted_count = 0;
        for npc in &mut self.npcs {
            if npc.is_dead { continue; }
            
            if let Some(rb) = self.rigid_body_set.get(npc.rigid_body_handle) {
                let npc_pos = rb.translation();
                let npc_pos = Vector3::new(npc_pos.x, npc_pos.y, npc_pos.z);

                let dist = (npc_pos - position).magnitude();
                
                if dist <= radius {
                    // Alert the NPC
                    if let crate::model_components::NPC::NPCBehavior::Stateful(behavior) = &mut npc.test_behavior {
                        // If it was wandering, make it aggressive
                        if let crate::game_behaviors::stateful::BehaviorState::Wander = behavior.current_state {
                             // Force state change to combat if aggressiveness allows
                             if behavior.config.aggressiveness > 0.1 {
                                 match behavior.config.combat_type {
                                     crate::game_behaviors::stateful::CombatType::Melee => {
                                         if behavior.melee_behavior.is_some() {
                                             behavior.current_state = crate::game_behaviors::stateful::BehaviorState::Melee;
                                             alerted_count += 1;
                                         }
                                     },
                                     crate::game_behaviors::stateful::CombatType::Ranged => {
                                         if behavior.ranged_behavior.is_some() {
                                             behavior.current_state = crate::game_behaviors::stateful::BehaviorState::Ranged;
                                             alerted_count += 1;
                                         }
                                     }
                                 }
                             }
                        }
                    }
                }
            }
        }
        if alerted_count > 0 {
            println!("Swarm Alert: {} NPCs alerted!", alerted_count);
        }
    }

    pub fn set_mouse_position(&mut self, new_position: EntropyPosition) {
        self.last_mouse_position = self.current_mouse_position;
        self.current_mouse_position = Some(new_position);
        self.last_mouse_position_time = Instant::now();
    }

    pub fn set_mouse_delta(&mut self, delta: (f64, f64)) {
        self.last_mouse_delta = (delta.0 as f32, delta.1 as f32);
        // self.last_mouse_position_time = Instant::now();
    }

    pub fn is_player_grounded(
        // renderer_state: &MutexGuard<RendererState>,
        &self,
        player_handle: RigidBodyHandle,
    ) -> bool {
        const GROUND_CHECK_DISTANCE: f32 = 10.0; // Small distance to check below the player

        // Get player position
        let player_rb = match self.rigid_body_set.get(player_handle) {
            Some(rb) => rb,
            None => return false,
        };

        let player_pos = player_rb.translation();

        // Create a ray from the player's position downward
        let ray_origin = point![player_pos.x, player_pos.y, player_pos.z];
        let ray_direction = vector![0.0, -1.0, 0.0];

        // Create the ray
        let ray = Ray::new(ray_origin, ray_direction);

        // Set up query pipeline if it's not already part of your system
        // This is a simplified version; you might need to adapt to your architecture
        let rigidbody_set = &self.rigid_body_set;
        let collider_set = &self.collider_set;
        let query_pipeline = &self.query_pipeline;

        // Perform the raycast
        if let Some((handle, intersection)) = query_pipeline.cast_ray(
            rigidbody_set,
            collider_set,
            &ray,
            GROUND_CHECK_DISTANCE,
            true,
            QueryFilter::default().exclude_rigid_body(player_handle),
        ) {
            // Ray hit something, player is grounded
            return true;
        }

        // No hit, player is not grounded
        false
    }

    pub fn step_physics_pipeline(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, camera_binding: &mut CameraBinding, camera: &mut SimpleCamera) {
        // Cleanup debug rays
        self.debug_rays.retain(|ray| ray.expires_at > Instant::now());

        // Calculate delta time
        let now = Instant::now();
        let dt = if let Some(last_time) = self.last_frame_time {
            (now - last_time).as_secs_f32()
        } else {
            0.0
        };

        #[cfg(target_os = "windows")]
        let near_future = self.last_mouse_position_time.checked_add(Duration::from_millis(100));

        #[cfg(target_os = "windows")]
        if let Some(future) = near_future {
            if future < now {
                self.last_mouse_position = None;
                self.current_mouse_position =  None;
            }
        }

        #[cfg(target_arch = "wasm32")]
        let near_future = self.last_mouse_position_time.elapsed().as_secs_f64();

        #[cfg(target_arch = "wasm32")]
        if near_future < js_sys::Date::now() {
            self.last_mouse_position = None;
            self.current_mouse_position =  None;
        }
        
        self.last_frame_time = Some(now);

        self.update_terrain_managers(device, dt, camera);

        // Update player state (stamina, eye height, etc.)
        self.update_player_state(dt);

        let step_time = Instant::now();

        // Step the physics pipeline
        let physics_hooks = ();
        let event_handler = ();

        self.physics_pipeline.step(
            &self.gravity,
            &self.integration_parameters,
            &mut self.island_manager,
            &mut self.broad_phase,
            &mut self.narrow_phase,
            &mut self.rigid_body_set,
            &mut self.collider_set,
            &mut self.impulse_joint_set,
            &mut self.multibody_joint_set,
            &mut self.ccd_solver,
            Some(&mut self.query_pipeline),
            &physics_hooks,
            &event_handler,
        );

        let step_duration = step_time.elapsed();
        // println!("  step_duration: {:?}", step_duration);

        let physics_update_time = Instant::now();

        // Collect all the necessary data first
        let physics_updates: Vec<(Uuid, nalgebra::Vector3<f32>, (f32, f32, f32))> = self
            .rigid_body_set
            .iter()
            .map(|(_, rigid_body)| {
                let physics_position = rigid_body.position();
                let position = physics_position.translation.vector;
                let rotation = physics_position.rotation;
                let euler = rotation.euler_angles();
                let component_id = Uuid::from_u128(rigid_body.user_data);
                (component_id, position, euler)
            })
            .collect();

        let physics_update_duration = physics_update_time.elapsed();

        let physics_update_time = Instant::now();

        // Update camera position if needed
        if self.game_mode {
            if let Some(player_character) = &self.player_character {
                if let Some(rb_handle) = player_character.movement_rigid_body_handle {
                    if let Some(rb) = self.rigid_body_set.get(rb_handle) {
                        if self.game_settings.third_person {
                            // // third-person / 3rd person camera
                            // Retrieve player position
                            let pos = rb.translation(); // nalgebra::Vector3<f32>

                            // --- Mouse Input and Angle Update ---
                            let delta = if let (Some(current), Some(last)) = (
                                self.current_mouse_position,
                                self.last_mouse_position
                            ) {
                                let mouse_sensitivity: f32 = 0.005; 
                                
                                // Calculate difference (delta) in screen coordinates
                                let delta_x = current.x - last.x;
                                let delta_y = current.y - last.y;

                                (delta_x, delta_y)
                            } else if let del = self.last_mouse_delta {
                                del
                            } else {
                                (0.0, 0.0)
                            };

                            let mouse_sensitivity: f32 = 0.005; 
                            
                            // Calculate difference (delta) in screen coordinates
                            let delta_x = delta.0;
                            let delta_y = delta.1;
                            
                            // 1. Update Yaw (Left/Right rotation)
                            // Positive delta_x (mouse moved right) should typically decrease yaw 
                            // to swing the camera left (assuming a right-hand coordinate system)
                            // self.camera_yaw -= (delta_x as f32) * mouse_sensitivity; // inverted
                            self.camera_yaw += (delta_x as f32) * mouse_sensitivity;

                            // 2. Update Pitch (Up/Down rotation)
                            // Positive delta_y (mouse moved down) should increase pitch
                            self.camera_pitch += (delta_y as f32) * mouse_sensitivity; 
                            // self.camera_pitch -= (delta_y as f32) * mouse_sensitivity; // inverted
                            
                            // 3. Clamp Pitch to prevent the camera from flipping over
                            // 1.55 radians is approximately 89 degrees
                            self.camera_pitch = self.camera_pitch.clamp(-1.55, 1.55);
                            
                            // You should update self.last_mouse_position *after* calculating delta, 
                            // typically in your event loop, but often set here for simplicity if needed.
                            // self.last_mouse_position = self.current_mouse_position; // Or handle this in the input handler

                            // --- Camera Variables ---
                            let radius: f32 = 25.0; // The fixed distance from the player

                            // --- Calculate New Camera Position using Spherical Coordinates ---

                            // Calculate horizontal component of the offset (projection onto XZ plane)
                            let horizontal_distance = radius * self.camera_pitch.cos();

                            // Calculate the offsets
                            // Note: Assuming your Y-axis is UP (standard for many game engines)
                            let x_offset = horizontal_distance * self.camera_yaw.sin();
                            let y_offset = radius * self.camera_pitch.sin();
                            let z_offset = horizontal_distance * self.camera_yaw.cos(); 

                            // Create the new camera position (Point3 from nalgebra)
                            // The offsets are added to the player's position
                            let comfort_elevation = 2.0;
                            let camera_pos = Point3::new(
                                pos.x + x_offset,
                                pos.y + y_offset + comfort_elevation, 
                                pos.z - z_offset // Subtract for Z-axis typically pointing forward/into the screen
                            );
                            camera.position = camera_pos;

                            // Set direction to look back at the player's center
                            // The .coords property converts Point3 to Vector3 for the subtraction
                            let direction = (pos - camera_pos.coords).normalize(); 
                            camera.direction = direction;

                            camera.update();
                            camera_binding.update_3d(&queue, &camera);

                        } else {
                            // first / 1st person camera with lookaround
                            // Retrieve player position
                            let pos = rb.translation();

                            // // --- Mouse Input and Angle Update ---
                            // if let (Some(current), Some(last)) = (
                            //     self.current_mouse_position,
                            //     self.last_mouse_position
                            // ) {
                            //     let mouse_sensitivity: f32 = 0.005; 
                                
                            //     // Calculate difference (delta) in screen coordinates
                            //     let delta_x = current.x - last.x;
                            //     let delta_y = current.y - last.y;
                                
                            //     // Update Yaw (Left/Right rotation)
                            //     self.camera_yaw += (delta_x as f32) * mouse_sensitivity;

                            //     // Update Pitch (Up/Down rotation)
                            //     self.camera_pitch -= (delta_y as f32) * mouse_sensitivity; 
                                
                            //     // Clamp Pitch to prevent camera flipping
                            //     self.camera_pitch = self.camera_pitch.clamp(-1.55, 1.55);
                            // }

                            // --- Mouse Input and Angle Update ---
                            let delta = if let (Some(current), Some(last)) = (
                                self.current_mouse_position,
                                self.last_mouse_position
                            ) {
                                let mouse_sensitivity: f32 = 0.005; 
                                
                                // Calculate difference (delta) in screen coordinates
                                let delta_x = current.x - last.x;
                                let delta_y = current.y - last.y;

                                (delta_x, delta_y)
                            } else if let del = self.last_mouse_delta {
                                del
                            } else {
                                (0.0, 0.0)
                            };

                            let mouse_sensitivity: f32 = 0.005; 
                            
                            // Calculate difference (delta) in screen coordinates
                            let delta_x = delta.0;
                            let delta_y = delta.1;

                            // Update Yaw (Left/Right rotation)
                            self.camera_yaw += (delta_x as f32) * mouse_sensitivity;

                            // Update Pitch (Up/Down rotation)
                            self.camera_pitch -= (delta_y as f32) * mouse_sensitivity; 
                            
                            // Clamp Pitch to prevent camera flipping
                            self.camera_pitch = self.camera_pitch.clamp(-1.55, 1.55);

                            // --- Calculate look direction from yaw and pitch ---
                            // Convert spherical angles to a direction vector
                            let direction = Vector3::new(
                                self.camera_yaw.cos() * self.camera_pitch.cos(),
                                self.camera_pitch.sin(),
                                self.camera_yaw.sin() * self.camera_pitch.cos()
                            ).normalize();

                            // let in_front = direction * 0.25;

                            // --- Position camera at player's eye level ---
                            // Use calculated eye height and camera bob from PlayerCharacter state
                            let eye_height = player_character.current_eye_height;
                            let bob_offset = player_character.camera_bob_amount;

                            let camera_pos = Point3::new(
                                pos.x,
                                pos.y + eye_height + bob_offset,
                                pos.z
                            );
                            camera.position = camera_pos;

                            camera.direction = direction;

                            camera.update();
                            camera_binding.update_3d(&queue, &camera);
                        }
                    }
                }
            } 
        }
        else {
            // if let Some(player_character) = &self.player_character {
            //     if let Some(rb_handle) = player_character.movement_rigid_body_handle {
            //         if let Some(rb) = self.rigid_body_set.get(rb_handle) {
            //             let pos = rb.translation();
            //             camera.position = Point3::new(pos.x, pos.y + 0.9, pos.z);

            //             camera.update();
            //             camera_binding.update_3d(&queue, &camera);
            //         }
            //     }
            // }
        }

        // Now process all updates without borrowing rigid_body_set
        let mut alert_positions = Vec::new();
        for (component_id, position, euler) in physics_updates {
            // Update models
            if let Some(instance_model_data) = self
                .models
                .iter_mut()
                .find(|m| m.id == component_id.to_string())
            {
                if let Some(character) = &mut self.player_character {
                    if let Some(model_id) = character.model_id.clone() { // character.model_id is the component id of the PlayerCharacter
                        if model_id == component_id.to_string() {
                            // Update is_moving based on velocity
                            if let Some(rb_handle) = character.movement_rigid_body_handle {
                                if let Some(rb) = self.rigid_body_set.get(rb_handle) {
                                    let velocity = rb.linvel();
                                    let horizontal_speed = (velocity.x * velocity.x + velocity.z * velocity.z).sqrt();
                                    character.is_moving = horizontal_speed > 0.1;
                                }
                            }

                            instance_model_data.meshes.iter_mut().for_each(|mesh| {
                                mesh.transform
                                    .update_position([position.x, position.y, position.z]);
                                
                                if self.game_mode && !self.game_settings.third_person {
                                    // In first-person mode, the player model should face the camera direction.
                                    // We use -self.camera_yaw to align the model with the camera's horizontal rotation.
                                    mesh.transform.update_rotation([0.0, -self.camera_yaw, 0.0]);
                                } else {
                                    // mesh.transform.update_rotation([euler.0, euler.1, euler.2]); // TODO: update rotation based on direction of travel instead
                                }
                            });
                        }
                    }
                }

                // Handle NPC updates
                if let Some(instance_npc_data) = self
                    .npcs
                    .iter_mut()
                    .find(|m| m.model_id == component_id.to_string())
                {
                    instance_model_data.meshes.iter_mut().for_each(|mesh| {
                        if (mesh.transform.initial_position.is_none()) {
                            println!("Set initial position {:?}", position);
                            mesh.transform.initial_position = Some(Vector3::from([position.x, position.y, position.z]));
                        }

                        mesh.transform
                            .update_position([position.x, position.y, position.z]);
                    });

                    if let Some(player_character) = &mut self.player_character {
                        if let Some(first_mesh) = instance_model_data.meshes.get_mut(0) {

                            // Debug Spheres Logic
                            if self.display_debug_spheres {
                                if let Some(debug_sphere) = &instance_npc_data.debug_sphere {}
                                let mut radius = 0.0;
                                let mut debug_moving = false;
                                let mut color = [0.0, 1.0, 0.0]; // Default Green
                                let debug_sphere_position = if let Some(debug_sphere) = &instance_npc_data.debug_sphere {
                                    debug_sphere.transform.position
                                } else {
                                    Vector3::identity()
                                };

                                let distance_to_player = nalgebra::distance(&Point3::from(position), &Point3::from(debug_sphere_position));

                                match &instance_npc_data.test_behavior {
                                    crate::model_components::NPC::NPCBehavior::Wander(w) => radius = w.radius,
                                    crate::model_components::NPC::NPCBehavior::Melee(m) => {
                                        debug_moving = true;
                                        radius = m.chase.detection_radius;
                                        if distance_to_player <= radius {
                                            color = [1.0, 0.0, 0.0]; // Red
                                        } else {
                                            color = [1.0, 1.0, 0.0]; // Yellow
                                        }
                                    },
                                    crate::model_components::NPC::NPCBehavior::Ranged(r) => {
                                        debug_moving = true;
                                        radius = r.chase.detection_radius;
                                        if distance_to_player <= radius {
                                            color = [1.0, 0.0, 0.0]; // Red
                                        } else {
                                            color = [1.0, 1.0, 0.0]; // Yellow
                                        }
                                    },
                                    crate::model_components::NPC::NPCBehavior::Stateful(r) => {
                                        debug_moving = true;

                                        if let Some(melee) = &r.melee_behavior {
                                            radius = melee.chase.detection_radius
                                        }

                                        if let Some(ranged) = &r.ranged_behavior {
                                            radius = ranged.chase.detection_radius
                                        }

                                        if r.config.aggressiveness <= 0.1 {
                                            color = [0.0, 1.0, 0.0]; // Green (Friendly)
                                        } else {
                                            match r.current_state {
                                                BehaviorState::Wander => {
                                                    // if distance_to_player <= radius {
                                                    //     color = [1.0, 0.0, 0.0]; // Red (Should be engaging)
                                                    // } else {
                                                    //     color = [1.0, 1.0, 0.0]; // Yellow (Dangerous but far)
                                                    // }
                                                    color = [0.0, 1.0, 0.0]; // Green
                                                },
                                                BehaviorState::Melee | BehaviorState::Ranged => {
                                                    if distance_to_player <= radius {
                                                        color = [1.0, 0.0, 0.0]; // Red (Should be engaging)
                                                    } else {
                                                        color = [1.0, 1.0, 0.0]; // Yellow (Dangerous but far)
                                                    }
                                                }
                                                _ => {
                                                    color = [0.0, 1.0, 0.0]; // Green
                                                }
                                            }
                                        }
                                    },
                                }
        
                                if radius > 0.0 {
                                    if instance_npc_data.debug_sphere.is_none() {

                                        println!("ADD DEBUG SPHERE");

                                        // Create sphere
                                        instance_npc_data.debug_sphere = Some(Sphere::new_wireframe(
                                            device,
                                            queue,
                                            &self.model_bind_group_layout,
                                            &self.group_bind_group_layout,
                                            &self.texture_render_mode_buffer,
                                            camera,
                                            1.0, // Unit sphere
                                            16,
                                            16,
                                            color,
                                            debug_moving
                                        ));

                                        if let Some(sphere) = &mut instance_npc_data.debug_sphere {
                                            if let Some(pos) = first_mesh.transform.initial_position {
                                                println!("Setting sphere pos {:?}", pos);
                                                sphere.transform.update_position([pos.x, pos.y, pos.z]);
                                            }
                                        }
                                    }
        
                                    if let Some(sphere) = &mut instance_npc_data.debug_sphere {
                                        sphere.transform.update_scale([radius, radius, radius]);

                                        if debug_moving {
                                            sphere.transform.update_position([position.x, position.y, position.z]);
                                        }

                                        // Update color
                                        sphere.update_color(queue, 1.0, 16, 16, color);
                                    }
                                }
                            }

                            // Check for death
                            if instance_npc_data.stats.health <= 0.0 && !instance_npc_data.is_dead {
                                instance_npc_data.is_dead = true;
                                println!("NPC {:?} has died!", instance_npc_data.id);
                                
                                // Disable collision with player but keep it for ground/interaction?
                                // For now, just let it be.
                            }

                            // Stealth and Suspicion Logic
                            if !instance_npc_data.is_dead {
                                if let crate::model_components::NPC::NPCBehavior::Stateful(behavior) = &mut instance_npc_data.test_behavior {
                                    if let crate::game_behaviors::stateful::BehaviorState::Wander = behavior.current_state {
                                        let player_handle = player_character.movement_rigid_body_handle.expect("No player handle");
                                        let player_rb = self.rigid_body_set.get(player_handle).expect("No player rb");
                                        let player_translation = player_rb.translation();
                                        let player_translation = Vector3::new(player_translation.x, player_translation.y, player_translation.z);

                                        let npc_pos = position; // current NPC position from physics (Vector3)
                                        let dist = nalgebra::distance(&Point3::from(npc_pos), &Point3::from(player_translation));

                                        if dist <= behavior.config.detection_radius {
                                            // Check Line of Sight
                                            let ray_dir = (player_translation - npc_pos).normalize();
                                            let ray = Ray::new(Point3::from(npc_pos + ray_dir * 1.0), ray_dir);
                                            
                                            let mut filter = QueryFilter::default().exclude_rigid_body(first_mesh.rigid_body_handle.unwrap());
                                            
                                            let mut has_los = false;
                                            if let Some((handle, toi)) = self.query_pipeline.cast_ray(
                                                &self.rigid_body_set,
                                                &self.collider_set,
                                                &ray,
                                                dist,
                                                true,
                                                filter
                                            ) {
                                                if let Some(collider) = self.collider_set.get(handle) {
                                                    if collider.parent() == Some(player_handle) {
                                                        has_los = true;
                                                    }
                                                }
                                            }

                                            if has_los {
                                                // Increase suspicion based on distance (closer = faster)
                                                let suspicion_gain = (1.0 - (dist / behavior.config.detection_radius)) * dt * 2.0;
                                                instance_npc_data.suspicion = (instance_npc_data.suspicion + suspicion_gain).min(1.0);
                                                
                                                if instance_npc_data.suspicion >= 1.0 {
                                                    // Spotted!
                                                    match behavior.config.combat_type {
                                                        crate::game_behaviors::stateful::CombatType::Melee => {
                                                            if behavior.melee_behavior.is_some() {
                                                                behavior.current_state = crate::game_behaviors::stateful::BehaviorState::Melee;
                                                                alert_positions.push((npc_pos, 30.0));
                                                            }
                                                        },
                                                        crate::game_behaviors::stateful::CombatType::Ranged => {
                                                            if behavior.ranged_behavior.is_some() {
                                                                behavior.current_state = crate::game_behaviors::stateful::BehaviorState::Ranged;
                                                                alert_positions.push((npc_pos, 30.0));
                                                            }
                                                        }
                                                    }
                                                }
                                            } else {
                                                // Decay suspicion if out of sight
                                                instance_npc_data.suspicion = (instance_npc_data.suspicion - dt * 0.5).max(0.0);
                                            }
                                        } else {
                                             // Decay suspicion if out of range
                                             instance_npc_data.suspicion = (instance_npc_data.suspicion - dt * 0.2).max(0.0);
                                        }
                                    } else {
                                        // In combat, suspicion is effectively 1.0
                                        instance_npc_data.suspicion = 1.0;
                                    }
                                }
                            }

                            if !instance_npc_data.is_talking && !instance_npc_data.is_dead {
                                let (result, just_spotted) = instance_npc_data.test_behavior.update(
                                    &mut self.rigid_body_set,
                                    &self.collider_set,
                                    &self.query_pipeline,
                                    first_mesh
                                        .rigid_body_handle
                                        .expect("Couldn't get rigid body handle"),
                                    player_character
                                        .movement_rigid_body_handle
                                        .expect("Couldn't get rigid body handle"),
                                    &first_mesh.rapier_collider,
                                    &mut first_mesh.transform,
                                    instance_npc_data.stats.stamina, // Use NPC's actual stamina
                                    dt,
                                    instance_npc_data.forward_axis,
                                );

                                if just_spotted {
                                    let npc_pos = Vector3::new(position.x, position.y, position.z);
                                    // Alert nearby NPCs within 30 units
                                    alert_positions.push((npc_pos, 30.0));
                                }

                                if let Some((damage, debug_line)) = result {
                                    if damage > 0.0 {
                                        player_character.handle_incoming_damage(damage);
                                    }

                                    if self.game_settings.show_hitscan_line {
                                        if let Some((start, end)) = debug_line {
                                            let mut debug_cube = Cube::new(
                                                &device,
                                                &queue,
                                                &self.model_bind_group_layout,
                                                &self.group_bind_group_layout,
                                                &self.texture_render_mode_buffer,
                                                camera,
                                            );

                                            let dir = (end - start).normalize();
                                            let length = nalgebra::distance(&start, &end);
                                            
                                            debug_cube.transform.update_position([start.x, start.y, start.z]);
                                            debug_cube.transform.update_scale([0.02, 0.02, length]);
                                            
                                            let rotation = UnitQuaternion::rotation_between(&Vector3::z(), &dir).unwrap_or_default();
                                            debug_cube.transform.update_rotation_quat([
                                                rotation.coords.x,
                                                rotation.coords.y,
                                                rotation.coords.z,
                                                rotation.coords.w,
                                            ]);
                                            
                                            debug_cube.transform.update_uniform_buffer(&queue);
                                            
                                            self.debug_rays.push(DebugRay {
                                                cube: debug_cube,
                                                expires_at: Instant::now() + Duration::from_millis(500),
                                            });
                                        }
                                    }
                                }
                            }

                            let desired_animation_name = if instance_npc_data.is_dead {
                                "Death"
                            } else {
                                instance_npc_data.test_behavior.get_animation_name()
                            };

                            // Find the animation index in the model
                            if let Some(animation_index) = instance_model_data.animations.iter().position(|anim| anim.name.to_lowercase().contains(&desired_animation_name.to_lowercase())) {
                                // If the animation is not already playing, switch to it
                                if instance_npc_data.animation_state.animation_index != animation_index {
                                    instance_npc_data.animation_state.animation_index = animation_index;
                                    instance_npc_data.animation_state.current_time = 0.0; // Reset time
                                }
                            }

                            // Update debug spheres with suspicion color
                            if let Some(sphere) = &mut instance_npc_data.debug_sphere {
                                let color = if instance_npc_data.is_dead {
                                    [0.2, 0.2, 0.2] // Grey for dead
                                } else {
                                    // Interpolate Green -> Yellow -> Red
                                    if instance_npc_data.suspicion < 0.5 {
                                        let t = instance_npc_data.suspicion * 2.0;
                                        [t, 1.0, 0.0] // Green to Yellow
                                    } else {
                                        let t = (instance_npc_data.suspicion - 0.5) * 2.0;
                                        [1.0, 1.0 - t, 0.0] // Yellow to Red
                                    }
                                };
                                sphere.update_color(queue, 1.0, 16, 16, color);
                            }
                        }
                    }
                } else {
                    // have a dynamic models vector?
                    // instance_model_data.meshes.iter_mut().for_each(|mesh| {
                    //     mesh.transform
                    //         .update_position([position.x, position.y, position.z]);
                    //     // rotation for interactive models (non NPC)
                    //     mesh.transform.update_rotation([euler.0, euler.1, euler.2]);
                    // });
                }
            }

            // Update landscapes
            // just helps knowing terrain is where the physics are
            // this may break setting physics up where terrain is when we try to do the reverse
            // if let Some(terrain_manager) = self
            //     .terrain_managers
            //     .iter_mut()
            //     .find(|m| m.id == component_id.to_string())
            // {
            //     terrain_manager
            //         .transform
            //         .update_position([position.x, position.y, position.z]);
            //     terrain_manager
            //         .transform
            //         .update_rotation([euler.0, euler.1, euler.2]);
            // }
        }

        // Process deferred alerts
        for (alert_pos, radius) in alert_positions {
            self.alert_nearby_npcs(alert_pos, radius);
        }

        // Collect matching indices only
        let mut matching_pairs: Vec<(usize, usize)> = Vec::new();
        for (model_idx, model) in self.models.iter().enumerate() {
            if let Some(npc_idx) = self.npcs.iter().position(|n| n.model_id == model.id) {
                matching_pairs.push((model_idx, npc_idx));
            }
        }

        // Pass the whole collections and indices to the animation system
        crate::core::animation_system::update_animations(
            &mut self.models,
            &mut self.npcs,
            &mut self.collectables,
            &mut self.player_character,
            &matching_pairs,
            dt,
            queue,
        );
    }

    // Usage in your main update/render loop:
    pub fn update_rays(
        &mut self,
        mouse_pos: (f32, f32),
        camera: &SimpleCamera,
        screen_width: u32,
        screen_height: u32,
    ) -> Ray {
        // Create ray from mouse position
        let ray = create_ray_from_mouse(mouse_pos, camera, screen_width, screen_height);

        // println!("collider set {:?}", self.collider_set.len());

        // Cast ray and check for intersection
        if let Some((collider_handle, toi)) = cast_ray_at_components(
            &ray,
            &self.query_pipeline,
            &self.rigid_body_set,
            &self.collider_set,
        ) {
            // println!("Colliding!");
            // Get the collider
            let collider = &self.collider_set[collider_handle];

            // Get intersection point in world space
            let intersection_point = ray.point_at(toi);

            let component_id = Uuid::from_u128(collider.user_data);

            self.ray_intersecting = true;
            self.ray_intersection = Some(intersection_point);
            self.ray_component_id = Some(component_id);
        } else {
            self.ray_intersecting = false;
            // keep stale data for sticky translation
            // self.ray_intersection = None;
            // self.ray_component_id = None;
        }

        ray
    }

    // pub fn update_gizmo_state(&mut self, dragging: bool, axis: u8) {
    //     self.dragging_gizmo = true;
    //     self.gizmo_drag_axis = Some(axis);
    // }

    pub fn update_rapier(&mut self) {
        self.query_pipeline.update(&self.collider_set);
    }

    pub fn add_arrow_colliders(&mut self) {
        // self.translation_gizmo.arrows.iter_mut().for_each(|arrow| {
        //     println!("adding arrow collider");
        //     let collider_handle = self.collider_set.insert(arrow.rapier_collider.clone());
        //     arrow.collider_handle = Some(collider_handle);
        // });
    }

    pub fn update_arrow_collider_position(
        &mut self,
        //arrows: &[AxisArrow; 3],
        position: [f32; 3],
    ) {
        // self.translation_gizmo.arrows.iter().for_each(|arrow| {
        //     // Create translation vector based on the arrow's axis
        //     let translation = match arrow.axis {
        //         0 => vector![position[0], position[1], position[2]], // X axis
        //         1 => vector![position[0], position[1], position[2]], // Y axis
        //         _ => vector![position[0], position[1], position[2]], // Z axis
        //     };

        //     let isometry =
        //         nalgebra::Isometry3::translation(translation.x, translation.y, translation.z);

        //     if let Some(collider) = self
        //         .collider_set
        //         .get_mut(arrow.collider_handle.expect("Couldn't get collider handle"))
        //     {
        //         collider.set_position(isometry);
        //         // println!(
        //         //     "Updated collider for axis {}: pos={:?}",
        //         //     arrow.axis, translation
        //         // );
        //     }
        // });
    }

    pub fn update_player_character_position(&mut self, translation: Vector3<f32>, delta_time: f32, camera: &mut SimpleCamera) {
        if let Some(player_character) = &mut self.player_character {
            // let mut camera = get_camera();
            // Collision filter (typically you want to collide with everything except other characters)
            let filter = QueryFilter::default()
                .exclude_rigid_body(
                    player_character
                        .movement_rigid_body_handle
                        .expect("Couldn't get rigid body handle"),
                )
                .exclude_collider(
                    player_character
                        .collider_handle
                        .expect("Couldn't get collider handle"),
                )
                .exclude_sensors(); // Typically don't collide with trigger volumes

            // Current character position
            let character_pos = Isometry3::translation(
                camera.position.x,
                camera.position.y - 0.9, // Offset by half height to put camera at top
                camera.position.z,
            );

            let effective_character_movement = player_character.character_controller.move_shape(
                delta_time,
                &self.rigid_body_set,
                &self.collider_set,
                &self.query_pipeline,
                player_character.movement_shape.shape(),
                &character_pos,
                translation,
                filter,
                |collision| { 
                    // println!("Collision detected (a) {:?}", collision.character_pos)
                },
            );

            // effective_character_movement.grounded
            // effective_character_movement.is_sliding_down_slope
            // effective_character_movement.translation

            camera.position = Point3::new(
                camera.position.x + translation.x,
                camera.position.y - 0.9 + translation.y,
                camera.position.z + translation.z,
            );

            // TODO: update rigidbody with handle?
        }
    }

    pub fn update_player_collider_position(
        &mut self,
        //arrows: &[AxisArrow; 3],
        position: [f32; 3],
    ) {
        if let Some(player_character) = &mut self.player_character {

            // Create translation vector based on the arrow's axis
            let translation = vector![position[0], position[1], position[2]];

            let isometry =
                nalgebra::Isometry3::translation(translation.x, translation.y, translation.z);

            if let Some(collider) = self.collider_set.get_mut(
                player_character
                    .collider_handle
                    .expect("Couldn't get mesh collider handle"),
            ) {
                collider.set_position(isometry);
            }
        }
    }

    pub fn update_model_collider_position(
        &mut self,
        //arrows: &[AxisArrow; 3],
        position: [f32; 3],
    ) {
        self.models.iter().for_each(|model| {
            model.meshes.iter().for_each(|mesh| {
                // Create translation vector based on the arrow's axis
                let translation = vector![position[0], position[1], position[2]];

                let isometry =
                    nalgebra::Isometry3::translation(translation.x, translation.y, translation.z);

                if let Some(collider) = self.collider_set.get_mut(
                    mesh.collider_handle
                        .expect("Couldn't get mesh collider handle"),
                ) {
                    collider.set_position(isometry);
                }
            });
        });
    }

    // pub fn apply_player_movement(&mut self, direction: Vector3<f32>) {
    //     if let Some(player_character) = &mut self.player_character {

    //         if let Some(rigidbody) = self.rigid_body_set.get_mut(
    //             player_character
    //                 .movement_rigid_body_handle
    //                 .expect("Couldn't get mesh rigidbody handle"),
    //         ) {
    //             // Get current velocity to preserve Y component (gravity)
    //             let current_velocity = rigidbody.linvel();
                
    //             // Set horizontal velocity while keeping vertical velocity
    //             // let movement_speed = 5.0; // Adjust this to your desired speed
    //             let movement_speed = 3.7;
    //             // let movement_speed = 2.5;
    //             let new_velocity = vector![
    //                 direction.x * movement_speed,
    //                 current_velocity.y, // Preserve gravity/jumping
    //                 direction.z * movement_speed
    //             ];
                
    //             rigidbody.set_linvel(new_velocity, true);
    //         }
    //     }
    // }

    pub fn update_player_state(&mut self, delta_time: f32) {
        if let Some(player_character) = &mut self.player_character {
            // Regenerate stamina if not sprinting
            if player_character.movement_state != MovementState::Sprinting {
                if player_character.stats.stamina < 100.0 {
                    player_character.stats.stamina += 5.0 * delta_time;
                }
            }

            // Decay bob when stopped (or not called by movement)
            // We can't easily know if we "stopped" here without input flag, 
            // but apply_player_movement handles the "moving" case. 
            // Here we just decay if it wasn't updated recently? 
            // Simpler: Just decay. If moving, apply_player_movement will override/add.
            // Actually, apply_player_movement sets it. If we decay here, we might fight.
            // Let's leave bob logic in apply_player_movement for now, as it depends on velocity.
            
            // Interpolate Eye Height (Smooth Crouch)
            let lerp_speed = 10.0;
            player_character.current_eye_height = player_character.current_eye_height + (player_character.target_eye_height - player_character.current_eye_height) * lerp_speed * delta_time;
        }
    }

    pub fn apply_player_movement(&mut self, direction: Vector3<f32>, delta_time: f32) {
        if let Some(player_character) = &mut self.player_character {
            let mut current_position = None;
            let mut current_velocity = None;
            
            if let Some(rigidbody) = self.rigid_body_set.get_mut(
                player_character
                    .movement_rigid_body_handle
                    .expect("Couldn't get mesh rigidbody handle"),
            ) {
                current_position = Some(*rigidbody.translation());
                current_velocity = Some(*rigidbody.linvel());
            }

            let current_position = current_position.expect("Couldn't get position");
            let current_velocity = current_velocity.expect("Couldn't get velocity");

            // Collision filter
            let filter = QueryFilter::default()
                .exclude_rigid_body(
                    player_character
                        .movement_rigid_body_handle
                        .expect("Couldn't get rigid body handle"),
                )
                .exclude_collider(
                    player_character
                        .collider_handle
                        .expect("Couldn't get collider handle"),
                )
                .exclude_sensors();

            // --- Movement Logic ---
            let mut movement_speed = player_character.movement_config.walk_speed;
            
            // Handle Stamina for Sprinting
            if player_character.movement_state == MovementState::Sprinting {
                 if player_character.stats.stamina > 0.0 {
                     movement_speed = player_character.movement_config.sprint_speed;
                     player_character.stats.stamina -= 10.0 * delta_time; // Drain stamina
                 } else {
                     // Out of stamina, force walk
                     player_character.movement_state = MovementState::Walking;
                     movement_speed = player_character.movement_config.walk_speed;
                 }
            } 
            // Note: Regeneration moved to update_player_state

            match player_character.movement_state {
                MovementState::Crouching => movement_speed = player_character.movement_config.crouch_speed,
                MovementState::Prone => movement_speed = player_character.movement_config.prone_speed,
                _ => {}
            }
            
            player_character.movement_speed = movement_speed; // Update stored speed

            // --- Camera Bob ---
            // Bobbing only when moving and grounded
            if player_character.is_grounded && direction.magnitude() > 0.0 {
                 let bob_speed = if player_character.movement_state == MovementState::Sprinting { 15.0 } else { 10.0 };
                 player_character.camera_bob_timer += bob_speed * delta_time;
                 let bob_height = if player_character.movement_state == MovementState::Sprinting { 0.15 } else { 0.08 };
                 player_character.camera_bob_amount = (player_character.camera_bob_timer.sin()) * bob_height;
            } else {
                 // Decay bob when stopped
                 player_character.camera_bob_amount = player_character.camera_bob_amount * 0.9;
                 player_character.camera_bob_timer = 0.0;
            }

            // Target Eye Height
             let standing_height = 3.5;
             match player_character.movement_state {
                MovementState::Crouching => player_character.target_eye_height = standing_height * 0.6,
                MovementState::Prone => player_character.target_eye_height = standing_height * 0.2,
                _ => player_character.target_eye_height = standing_height,
            }
            
            // Interpolation moved to update_player_state

            // IMPORTANT: This should be a movement DELTA, not absolute position
            let desired_translation = vector![
                direction.x * movement_speed * delta_time,
                current_velocity.y * delta_time, // Preserve gravity
                direction.z * movement_speed * delta_time
            ];

            // Create the character position (Isometry)
            let character_pos = Isometry3::translation(
                current_position.x,
                current_position.y,
                current_position.z,
            );

            let effective_character_movement = player_character.character_controller.move_shape(
                delta_time,
                &self.rigid_body_set,
                &self.collider_set,
                &self.query_pipeline,
                player_character.movement_shape.shape(),
                &character_pos,
                desired_translation,
                filter,
                |_collision| {},
            );

            // Store grounded state for jump logic
            player_character.is_grounded = effective_character_movement.grounded;

            if let Some(rigidbody) = self.rigid_body_set.get_mut(
                player_character
                    .movement_rigid_body_handle
                    .expect("Couldn't get mesh rigidbody handle"),
            ) {
                // effective_character_movement.translation is a DELTA, so add it to current position
                let new_position = current_position + effective_character_movement.translation;
                rigidbody.set_translation(new_position, true);
            }
        }
    }

    pub fn apply_jump_impulse(&mut self) {
        if let Some(player_character) = &mut self.player_character {
            // Use the grounded state from character controller
            if player_character.is_grounded {
                if let Some(rigidbody) = self.rigid_body_set.get_mut(
                    player_character
                        .movement_rigid_body_handle
                        .expect("Couldn't get mesh rigidbody handle"),
                ) {
                    println!("Jump!");
                    let jump_force = 8.0;
                    // rigidbody.apply_impulse(vector![0.0, jump_force, 0.0], true);

                    // for kinematic character
                    let mut current_velocity = rigidbody.linvel().clone();
                    
                    // Set the upward velocity
                    current_velocity.y = jump_force;
                    rigidbody.set_linvel(current_velocity, true)
                }
            }
        }
    }

    // pub fn apply_jump_impulse(&mut self) {
    //     if let Some(player_character) = &mut self.player_character {

    //         if let Some(rigidbody) = self.rigid_body_set.get_mut(
    //             player_character
    //                 .movement_rigid_body_handle
    //                 .expect("Couldn't get mesh rigidbody handle"),
    //         ) {
    //             // Only jump if on ground (check if vertical velocity is near zero)
    //             let velocity = rigidbody.linvel();
    //             if velocity.y.abs() < 0.1 {
    //                 println!("Jump!");
    //                 let jump_force = 8.0; // Adjust for desired jump height
    //                 rigidbody.apply_impulse(vector![0.0, jump_force, 0.0], true);
    //             }
    //         }
    //     }
    // }

    pub fn update_player_rigidbody_position(
        &mut self,
        //arrows: &[AxisArrow; 3],
        position: [f32; 3],
    ) {
        if let Some(player_character) = &mut self.player_character {

            // Create translation vector based on the arrow's axis
            let translation = vector![position[0], position[1], position[2]];

            let isometry =
                nalgebra::Isometry3::translation(translation.x, translation.y, translation.z);

            if let Some(rigidbody) = self.rigid_body_set.get_mut(
                player_character
                    .movement_rigid_body_handle
                    .expect("Couldn't get mesh rigidbody handle"),
            ) {
                rigidbody.set_position(isometry, true);
            }
        }
    }

    pub fn update_model_rigidbody_position(
        &mut self,
        //arrows: &[AxisArrow; 3],
        position: [f32; 3],
    ) {
        self.models.iter().for_each(|model| {
            model.meshes.iter().for_each(|mesh| {
                // Create translation vector based on the arrow's axis
                let translation = vector![position[0], position[1], position[2]];

                let isometry =
                    nalgebra::Isometry3::translation(translation.x, translation.y, translation.z);

                if let Some(rigidbody) = self.rigid_body_set.get_mut(
                    mesh.rigid_body_handle
                        .expect("Couldn't get mesh collider handle"),
                ) {
                    rigidbody.set_position(isometry, true);
                }
            });
        });
    }

    pub fn update_landscape_collider_position(
        &mut self,
        //arrows: &[AxisArrow; 3],
        position: [f32; 3],
    ) {
        self.terrain_managers.iter().for_each(|landscape| {
            // Create translation vector based on the arrow's axis
            let translation = vector![position[0], position[1], position[2]];

            let isometry =
                nalgebra::Isometry3::translation(translation.x, translation.y, translation.z);

            // if let Some(collider) = self.collider_set.get_mut(
            //     landscape
            //         .collider_handle
            //         .expect("Couldn't get landscape collider handle"),
            // ) {
            //     collider.set_position(isometry);
            // }

            // TODO: try this:
            // landscape.terrain_position = isometry
        });
    }

    pub fn add_collider(&mut self, component_id: String, component_kind: ComponentKind) {
        match component_kind {
            ComponentKind::Landscape => {
                println!("Adding landscape collider");

                // should be added as part of terrain manager
                let landscape = self
                    .landscapes
                    .iter_mut()
                    .find(|l| l.id == component_id.clone())
                    .expect("Couldn't get Renderer Landscape");

                let rigid_body_handle = self
                    .rigid_body_set
                    .insert(landscape.rapier_rigidbody.clone());
                landscape.rigid_body_handle = Some(rigid_body_handle);

                // now associate rigidbody with collider
                let collider_handle = self.collider_set.insert_with_parent(
                    landscape.rapier_heightfield.clone(),
                    rigid_body_handle,
                    &mut self.rigid_body_set,
                );
                landscape.collider_handle = Some(collider_handle);
            }
            ComponentKind::Model => {
                let renderer_model = self
                    .models
                    .iter_mut()
                    .find(|l| l.id == component_id.clone())
                    .expect("Couldn't get Renderer Model");

                renderer_model.meshes.iter_mut().for_each(|mesh| {
                    let rigid_body_handle =
                        self.rigid_body_set.insert(mesh.rapier_rigidbody.clone());
                    mesh.rigid_body_handle = Some(rigid_body_handle);

                    // now associate rigidbody with collider
                    let collider_handle = self.collider_set.insert_with_parent(
                        mesh.rapier_collider.clone(),
                        rigid_body_handle,
                        &mut self.rigid_body_set,
                    );
                    mesh.collider_handle = Some(collider_handle);
                });
            },
            ComponentKind::Collectable => {
                 let renderer_model = self
                    .models
                    .iter_mut()
                    .find(|l| l.id == component_id.clone())
                    .expect("Couldn't get Renderer Model");

                renderer_model.meshes.iter_mut().for_each(|mesh| {
                    let existing_iso = mesh.rapier_rigidbody.position().clone();

                    let rapier_collider = ColliderBuilder::ball(0.5)
                        // .expect("Couldn't create trimesh")
                        .sensor(true)
                        .friction(0.7)
                        .restitution(0.0)
                        .density(1.0)
                        .user_data(
                            Uuid::from_str(&component_id.clone())
                                .expect("Couldn't extract uuid")
                                .as_u128(),
                        )
                        .build();

                    let dynamic_body = RigidBodyBuilder::fixed()
                        .additional_mass(70.0) // Explicitly set mass (e.g., 70kg for a person)
                        .linear_damping(0.1)
                        .position(existing_iso)
                        .locked_axes(LockedAxes::ROTATION_LOCKED_X | LockedAxes::ROTATION_LOCKED_Z)
                        .user_data(
                            Uuid::from_str(&component_id.clone())
                                .expect("Couldn't extract uuid")
                                .as_u128(),
                        )
                        .build();

                    mesh.rapier_collider = rapier_collider;
                    mesh.rapier_rigidbody = dynamic_body;

                    let rigid_body_handle =
                        self.rigid_body_set.insert(mesh.rapier_rigidbody.clone());
                    mesh.rigid_body_handle = Some(rigid_body_handle);

                    // now associate rigidbody with collider
                    let collider_handle = self.collider_set.insert_with_parent(
                        mesh.rapier_collider.clone(),
                        rigid_body_handle,
                        &mut self.rigid_body_set,
                    );
                    mesh.collider_handle = Some(collider_handle);
                });
            },
            ComponentKind::NPC => {
                let renderer_model = self
                    .models
                    .iter_mut()
                    .find(|l| l.id == component_id.clone())
                    .expect("Couldn't get Renderer Model");

                renderer_model.meshes.iter_mut().for_each(|mesh| {
                    let existing_iso = mesh.rapier_rigidbody.position().clone();

                    let rapier_collider = ColliderBuilder::capsule_y(1.0, 0.5)
                        // .expect("Couldn't create trimesh")
                        .friction(0.7)
                        .restitution(0.0)
                        .density(1.0)
                        .user_data(
                            Uuid::from_str(&component_id.clone())
                                .expect("Couldn't extract uuid")
                                .as_u128(),
                        )
                        .build();

                    let dynamic_body = RigidBodyBuilder::dynamic()
                        .additional_mass(70.0) // Explicitly set mass (e.g., 70kg for a person)
                        .linear_damping(0.1)
                        .position(existing_iso)
                        .locked_axes(LockedAxes::ROTATION_LOCKED_X | LockedAxes::ROTATION_LOCKED_Z)
                        .user_data(
                            Uuid::from_str(&component_id.clone())
                                .expect("Couldn't extract uuid")
                                .as_u128(),
                        )
                        .build();

                    mesh.rapier_collider = rapier_collider;
                    mesh.rapier_rigidbody = dynamic_body;

                    let rigid_body_handle =
                        self.rigid_body_set.insert(mesh.rapier_rigidbody.clone());
                    mesh.rigid_body_handle = Some(rigid_body_handle);

                    // now associate rigidbody with collider
                    let collider_handle = self.collider_set.insert_with_parent(
                        mesh.rapier_collider.clone(),
                        rigid_body_handle,
                        &mut self.rigid_body_set,
                    );
                    mesh.collider_handle = Some(collider_handle);
                });
            },
            ComponentKind::PlayerCharacter => {
                // NOTE: PlayerCharacter already inserted into sets in PlayerCharacter.rs!
            },
            ComponentKind::PointLight => return,
            ComponentKind::WaterPlane => return,
            _ => return,
        }
    }

    pub fn add_model(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        model_component_id: &String,
        bytes: &Vec<u8>,
        isometry: Isometry3<f32>,
        scale: Vector3<f32>,
        camera: &SimpleCamera,
        hide_in_world: bool,
        script_state: Option<HashMap<String, String>>,
    ) {
        let mut model = Model::from_glb(
            model_component_id,
            bytes,
            device,
            queue,
            &self.model_bind_group_layout,
            &self.group_bind_group_layout,
            &self.regular_texture_render_mode_buffer,
            &self.color_render_mode_buffer,
            isometry,
            scale,
            camera
        );

        model.hide_from_world = hide_in_world;

        model.script_state = script_state;

        // Check if the model has skins and create the necessary GPU resources
        if !model.skins.is_empty() {
            // MAX_JOINTS should be defined in animation_system.rs and imported or defined globally.
            // For now, defining it locally for self-containment.
            const MAX_JOINTS: usize = 256; 

            if let Some(skinned_pipeline) = &self.skinned_pipeline {
                // let identity_array: [f32; 16] = *nalgebra::Matrix4::<f32>::identity().transpose().as_slice();
                let joint_matrices_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Joint Matrices Buffer"),
                    contents: bytemuck::cast_slice(&[[0.0f32; 16]; MAX_JOINTS]),
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

                let skin_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("Skin Bind Group"),
                    layout: &skinned_pipeline.skin_bind_group_layout,
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: joint_matrices_buffer.as_entire_binding(),
                    }],
                });
                
                model.joint_matrices_buffer = Some(joint_matrices_buffer);
                model.skin_bind_group = Some(skin_bind_group);
            } else {
                eprintln!("Warning: Model has skins but skinned_pipeline is not initialized in RendererState.");
            }
        }
        self.models.push(model);
    }

    pub fn add_house(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        house_component_id: &String,
        config: &HouseConfig,
        isometry: Isometry3<f32>,
    ) {
        let mut house = House::new(
            house_component_id,
            device,
            queue,
            &self.model_bind_group_layout,
            config,
            isometry,
        );

        for mesh in &mut house.meshes {
            let rigid_body_handle = self.rigid_body_set.insert(mesh.rigid_body.clone());
            mesh.rigid_body_handle = Some(rigid_body_handle);

            let collider_handle = self.collider_set.insert_with_parent(
                mesh.collider.clone(),
                rigid_body_handle,
                &mut self.rigid_body_set,
            );
            mesh.collider_handle = Some(collider_handle);
        }

        self.procedural_houses.push(house);
    }

    pub fn add_scattered_model(
        &mut self,
        device: &wgpu::Device,
        model: Model,
        scatter_options: ScatterSettings
    ) {
        if let Some(landscape) = self.landscapes.get_mut(0) {
            if let Some(pipeline) = &self.scattered_model_pipeline {
                let scattered = ScatteredModel::new(
                    device,
                    model,
                    scatter_options,
                    landscape,
                    &pipeline.uniform_bind_group_layout
                );
                self.scattered_models.push(scattered);
            } else {
                println!("Scattered model pipeline not initialized");
            }
        } else {
            println!("Cannot add scattered model: No landscape found!");
        }
    }

    pub fn add_landscape(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        landscapeComponentId: &String,
        data: &LandscapePixelData,
        position: [f32; 3],
        camera: &SimpleCamera
    ) {
        let landscape = Landscape::new(
            landscapeComponentId,
            data,
            device,
            queue,
            &self.model_bind_group_layout,
            &self.group_bind_group_layout,
            // &self.texture_bind_group_layout,
            // &self.texture_render_mode_buffer,
            &self.texture_render_mode_buffer,
            &self.color_render_mode_buffer,
            position,
            camera
        );

        self.landscapes.push(landscape);
    }

    pub fn update_terrain_managers(&mut self, device: &wgpu::Device, dt: f32, camera: &mut SimpleCamera) {
        if self.terrain_managers.len() > 0 {
            // let camera = get_camera();
            let terrain_manager = self
                .terrain_managers
                .get_mut(0)
                .expect("Couldn't get first terrain manager");

            // keep for debugging:
            // if let Some(rb_handle) = self.player_character.movement_rigid_body_handle {
            //     if let Some(rb) = self.rigid_body_set.get(rb_handle) {
            //         let character_pos = rb.position();

            //         // let camera = get_camera();
            //         // let character_pos = camera.position;

            //         // Cast slightly above character's feet
            //         let ray_start = character_pos * Point3::new(0.0, 0.1, 0.0);
            //         let ray_dir = Vector3::new(0.0, -1.0, 0.0);

            //         let collider_handle = find_first_collider_handle(&terrain_manager.root);

            //         println!(
            //             "Check collider handle {:?} {:?}",
            //             character_pos,
            //             collider_handle.is_some()
            //         );

            //         if let Some(handle) = collider_handle {
            //             // Use QueryPipeline for ray casting
            //             let hit = self.query_pipeline.cast_ray(
            //                 &self.rigid_body_set,
            //                 &self.collider_set,
            //                 &Ray::new(ray_start, ray_dir),
            //                 f32::MAX,
            //                 true,
            //                 QueryFilter::default().exclude_rigid_body(rb_handle), // Exclude the character's own collider
            //             );

            //             if let Some((_, intersection)) = hit {
            //                 let hit_point: nalgebra::OPoint<f32, nalgebra::Const<3>> =
            //                     ray_start + ray_dir * intersection;
            //                 println!("Ground intersection at: {:?}", hit_point);
            //                 println!("Character position: {:?}", character_pos);
            //                 println!("Distance to ground: {:?}", intersection);
            //             } else {
            //                 println!("no intersect!");
            //             }
            //         }
            //     }
            // }

            terrain_manager.update(
                [camera.position.x, camera.position.y, camera.position.z],
                device,
                &mut self.rigid_body_set,
                &mut self.collider_set,
                &mut self.island_manager,
                &mut self.impulse_joint_set,
                &mut self.multibody_joint_set, // terrain_manager.terrain_position,
                // terrain_manager.id.clone(),
                dt,
                // &mut self.query_pipeline,
                camera,
                self.game_mode
            );
        }
    }

    pub fn add_terrain_manager(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        projectId: String,
        landscapeAssetId: String,
        landscapeComponentId: String,
        landscapeFilename: String,
        position: [f32; 3],
        camera: &mut SimpleCamera
    ) {
        let terrain_manager = TerrainManager::new(
            projectId,
            landscapeComponentId,
            landscapeAssetId,
            landscapeFilename,
            device,
            queue,
            &self.model_bind_group_layout,
            &self.group_bind_group_layout,
            &self.texture_render_mode_buffer,
            position,
            camera
        );

        self.terrain_managers.push(terrain_manager);
    }

    pub fn update_landscape_texture(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        landscape_id: String,
        kind: LandscapeTextureKinds,
        texture: Texture,
        maskKind: LandscapeTextureKinds,
        mask: Texture,
    ) {
        // w/o quadtree
        if let Some(landscape) = self
            .landscapes
            .iter_mut()
            .find(|l| l.id == landscape_id)
        {
            println!("Updating landscape texture...");
            landscape.update_texture(
                device,
                queue,
                &self.model_bind_group_layout,
                &self.texture_render_mode_buffer,
                &self.color_render_mode_buffer,
                kind,
                &texture,
            );
            landscape.update_texture(
                device,
                queue,
                &self.model_bind_group_layout,
                &self.texture_render_mode_buffer,
                &self.color_render_mode_buffer,
                maskKind,
                &mask,
            );
        }

        // for quadtree
        // if let Some(terrain_manager) = self
        //     .terrain_managers
        //     .iter_mut()
        //     .find(|l| l.id == landscape_id)
        // {
        //     println!("Updating landscape texture...");
        //     terrain_manager.update_texture(
        //         device,
        //         queue,
        //         &self.model_bind_group_layout,
        //         &self.texture_render_mode_buffer,
        //         &self.color_render_mode_buffer,
        //         kind,
        //         &texture,
        //     );
        //     terrain_manager.update_texture(
        //         device,
        //         queue,
        //         &self.model_bind_group_layout,
        //         &self.texture_render_mode_buffer,
        //         &self.color_render_mode_buffer,
        //         maskKind,
        //         &mask,
        //     );
        // }
    }
}

fn find_first_collider_handle(node: &QuadNode) -> Option<ColliderHandle> {
    // Check if current node has a collider
    if let Some(handle) = node.collider_handle {
        return Some(handle);
    }

    // If not, recursively check children
    if let Some(ref children) = node.children {
        for child in children.iter() {
            if let Some(handle) = find_first_collider_handle(child) {
                return Some(handle);
            }
        }
    }

    None
}

static RENDERING_PAUSED: AtomicBool = AtomicBool::new(false);

// Pause rendering
pub fn pause_rendering() {
    RENDERING_PAUSED.store(true, Ordering::SeqCst);
}

// Resume rendering
pub fn resume_rendering() {
    RENDERING_PAUSED.store(false, Ordering::SeqCst);
}

// Check if rendering is paused
pub fn is_rendering_paused() -> bool {
    RENDERING_PAUSED.load(Ordering::SeqCst)
}

// mutex approach

// // Global mutable static variable for RendererState protected by a Mutex
// pub static mut RENDERER_STATE: Option<Mutex<RendererState>> = None;

// thread_local! {
//     pub static RENDERER_STATE_INIT: std::cell::Cell<bool> = std::cell::Cell::new(false);
// }

// // Function to initialize the RendererState
// pub fn initialize_renderer_state(state: RendererState) {
//     unsafe {
//         RENDERER_STATE = Some(Mutex::new(state));
//     }
//     RENDERER_STATE_INIT.with(|init| {
//         init.set(true);
//     });
// }

// // Function to get a mutable reference to the RendererState
// pub fn get_renderer_state() -> Arc<&'static Mutex<RendererState>> {
//     RENDERER_STATE_INIT.with(|init| {
//         if !init.get() {
//             panic!("RendererState not initialized");
//         }
//     });

//     unsafe { Arc::new(RENDERER_STATE.as_ref().unwrap()) }
// }
