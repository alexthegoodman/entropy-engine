use nalgebra::{Isometry3, Matrix3, Matrix4, Point3, UnitQuaternion, Vector3};
use mint::{Quaternion, Vector3 as MintVector3};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use crate::core::RendererState::DebugRay;
use crate::model_components::Collectable::Collectable;
use crate::procedural_models::House::HouseConfig;
// use tokio::spawn;
use transform_gizmo::math::Transform;
use transform_gizmo::{GizmoConfig, GizmoInteraction};
use wgpu::util::DeviceExt;

use bytemuck::{Pod, Zeroable};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::{cell::RefCell, collections::HashMap};
use noise::{Fbm, NoiseFn, Perlin, Worley};
use noise::MultiFractal;

use crate::model_components::{PlayerCharacter::PlayerCharacter, NPC::NPC};
use crate::core::SimpleCamera::to_row_major_f64;
use crate::core::editor::{self, Editor};
use crate::core::gpu_resources;
use crate::helpers::utilities;
use crate::helpers::landscapes::{TextureData, read_landscape_heightmap_as_texture};
use crate::helpers::saved_data::{CollectableProperties, CollectableType, ComponentData, ComponentKind, StatData};
#[cfg(target_arch = "wasm32")]
use crate::helpers::wasm_loaders::{get_landscape_pixels_wasm, read_landscape_mask_wasm, read_landscape_texture_wasm, read_model_wasm};
use crate::procedural_trees::trees::{ProceduralTrees, TreeInstance};
use crate::procedural_particles::particle_system::{ParticleSystem, ParticleUniforms};
use crate::rhai_engine::{ComponentChanges, RhaiEngine, ScriptParticleConfig};
use crate::shape_primitives::Cube::Cube;
use crate::procedural_grass::grass::{Grass};
use crate::water_plane::water::WaterPlane;
use crate::water_plane::config::WaterConfig;
use rand::{Rng, random};
use crate::{
    core::SimpleCamera::SimpleCamera,
    helpers::landscapes::read_landscape_texture,
};
use crate::{
    core::{Grid::Grid, RendererState::RendererState},
    helpers::landscapes::read_landscape_mask,
};
use crate::{
    core::{
        RendererState::{pause_rendering, resume_rendering},
        Texture::Texture,
    },
    helpers::saved_data::LandscapeTextureKinds,
};
use crate::{helpers::landscapes::get_landscape_pixels, heightfield_landscapes::Landscape::Landscape};
use crate::{
    helpers::landscapes::LandscapePixelData,
    art_assets::Model::{Mesh, Model},
};
use crate::{art_assets::Model::read_model, shape_primitives::Pyramid::Pyramid};

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

#[derive(Debug, Clone, Copy)]
pub struct EntropyPosition {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct EntropySize {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EntropyElementState {
    Pressed,
    Released,
}

#[derive(Debug, Clone, Copy)]
pub enum EntropyMouseButton {
    Left,
    Right,
    Middle,
    Back,
    Forward,
    Other(u16),
}

#[derive(Serialize)]
pub struct ReadModelParams {
    pub projectId: String,
    pub modelFilename: String,
}

#[derive(Serialize)]
pub struct GetLandscapeParams {
    pub projectId: String,
    pub landscapeAssetId: String,
    pub landscapeFilename: String,
}

#[derive(Serialize)]
pub struct GetTextureParams {
    pub projectId: String,
    pub landscapeId: String,
    pub textureFilename: String,
    pub textureKind: String,
}

#[derive(Serialize)]
pub struct GetMaskParams {
    pub projectId: String,
    pub landscapeId: String,
    pub maskFilename: String,
    pub maskKind: String,
}

static mut CAMERA: Option<SimpleCamera> = None;

thread_local! {
    static CAMERA_INIT: std::cell::Cell<bool> = std::cell::Cell::new(false);
}

pub async fn handle_add_player(
    state: &mut RendererState,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    projectId: String,
    modelAssetId: String, // model is added to stored library as an asset
    modelComponentId: String, // model is added from library to scene as an active component
    modelFilename: String,
    isometry: Isometry3<f32>,
    scale: Vector3<f32>,
    camera: &SimpleCamera,
    default_weapon: Option<ComponentData>,
    script_state: Option<HashMap<String, String>>,
) {
    #[cfg(target_os = "windows")]
    let bytes = read_model(projectId, modelFilename).expect("Couldn't get model bytes");

    #[cfg(target_arch = "wasm32")]
    let bytes = read_model_wasm(projectId, modelFilename).await.expect("Couldn't get model bytes");

    state.add_model(device, queue, &modelComponentId, &bytes, isometry, scale, camera, false, script_state);

    state.add_collider(modelComponentId.clone(), ComponentKind::PlayerCharacter);

    // TODO: provide model info for Player model and isometry for player position
    let mut player_character = PlayerCharacter::new(
        modelComponentId.clone(),
        &mut state.rigid_body_set,
        &mut state.collider_set,
        &device,
        &queue,
        &state.model_bind_group_layout,
        &state.group_bind_group_layout,
        &state.texture_render_mode_buffer,
        camera,
        isometry,
        scale,
        default_weapon
    );

    player_character.model_id = Some(modelComponentId); // may want to be an optional model later

    state.player_character = Some(player_character);
}

pub fn handle_key_press(state: &mut Editor, key_code: &str, is_pressed: bool) {
    if key_code == "i" {
        if is_pressed {
            let game_mode = state.renderer_state.as_ref().map(|r| r.game_mode).unwrap_or(false);
            if game_mode {
                let gpu_resources = state.gpu_resources.clone();
                if let Some(gpu_resources) = gpu_resources {
                    crate::game_behaviors::inventory_ui::toggle_inventory_menu(state, &gpu_resources.device, &gpu_resources.queue);
                }
            }
        }
        return;
    } else if key_code == "e" {
        if is_pressed {
            let game_mode = state.renderer_state.as_ref().map(|r| r.game_mode).unwrap_or(false);
            if game_mode {
                // Interaction
                handle_npc_interaction(state);
            }
        }
    }

    let camera = state.camera.as_mut().expect("Couldn't get camera");
    let renderer_state = state.renderer_state.as_mut().expect("Couldn't get renderer state");
    let camera_binding = state.camera_binding.as_mut().expect("Couldn't get camera binding");
    let gpu_resources = state.gpu_resources.as_ref().expect("Couldn't get gpu resources");
    let speed_multiplier = state.navigation_speed;

    let mut movement_direction = Vector3::zeros();

    // Dialogue Navigation
    if state.dialogue_state.is_open && is_pressed {
        match key_code {
            "w" => {
                if state.dialogue_state.selected_option_index > 0 {
                    state.dialogue_state.selected_option_index -= 1;
                    state.dialogue_state.ui_dirty = true;
                }
                return;
            },
            "s" => {
                if state.dialogue_state.selected_option_index < state.dialogue_state.options.len().saturating_sub(1) {
                    state.dialogue_state.selected_option_index += 1;
                    state.dialogue_state.ui_dirty = true;
                }
                return;
            },
            "Enter" => {
                 // Trigger option
                 if !state.dialogue_state.options.is_empty() {
                     let next_node = state.dialogue_state.options[state.dialogue_state.selected_option_index].next_node.clone();
                     state.dialogue_state.current_node = next_node;
                     
                     // Find script again - TODO: cache script path in dialogue_state
                     let mut script_path = String::new();
                     if let Some(saved_state) = &state.saved_state {
                         if let Some(levels) = &saved_state.levels {
                             if let Some(level) = levels.get(0) {
                                 if let Some(components) = &level.components {
                                     for comp in components {
                                         if comp.id == state.dialogue_state.current_npc_id {
                                             if let Some(script) = &comp.rhai_script_path {
                                                 script_path = script.clone();
                                             }
                                         }
                                     }
                                 }
                             }
                         }
                     }
                     
                     if !script_path.is_empty() {
                        if let Some(renderer_state) = state.renderer_state.as_mut() {
                            state.rhai_engine.execute_interaction_script(
                                renderer_state,
                                &mut state.dialogue_state,
                                &script_path,
                                "interact"
                            );
                        }
                     } else {
                         // Close if no script found? or just close
                         state.dialogue_state.is_open = false;
                         state.dialogue_state.ui_dirty = true;
                         // Handle cleanup of is_talking manually if script fails? 
                         // Ideally execute_interaction_script handles it, but if we don't call it...
                         if let Some(renderer_state) = state.renderer_state.as_mut() {
                             if let Some(npc) = renderer_state.npcs.iter_mut().find(|n| n.model_id == state.dialogue_state.current_npc_id) {
                                 npc.is_talking = false;
                             }
                         }
                     }
                 } else {
                     // No options, just close on enter
                     state.dialogue_state.is_open = false;
                     state.dialogue_state.ui_dirty = true;
                     if let Some(renderer_state) = state.renderer_state.as_mut() {
                         if let Some(npc) = renderer_state.npcs.iter_mut().find(|n| n.model_id == state.dialogue_state.current_npc_id) {
                             npc.is_talking = false;
                         }
                     }
                 }
                 return;
            }
            _ => {}
        }

        return;
    }

    match key_code {
        "w" => {
            if is_pressed {
                // In game mode, move horizontally. In free camera, move in full 3D direction
                let forward = if renderer_state.game_mode {
                    Vector3::new(camera.direction.x, 0.0, camera.direction.z).normalize()
                } else {
                    camera.direction
                };
                movement_direction += forward * speed_multiplier;
            }
        }
        "s" => {
            if is_pressed {
                let forward = if renderer_state.game_mode {
                    Vector3::new(camera.direction.x, 0.0, camera.direction.z).normalize()
                } else {
                    camera.direction
                };
                movement_direction -= forward * speed_multiplier;
            }
        }
        "a" => {
            if is_pressed {
                let right = camera.direction.cross(&camera.up).normalize();
                let right_horizontal = if renderer_state.game_mode {
                    Vector3::new(right.x, 0.0, right.z).normalize()
                } else {
                    right
                };
                movement_direction -= right_horizontal * speed_multiplier;
            }
        }
        "d" => {
            if is_pressed {
                let right = camera.direction.cross(&camera.up).normalize();
                let right_horizontal = if renderer_state.game_mode {
                    Vector3::new(right.x, 0.0, right.z).normalize()
                } else {
                    right
                };
                movement_direction += right_horizontal * speed_multiplier;
            }
        }
        " " => { // Space bar for jumping
            if is_pressed && renderer_state.game_mode {
                renderer_state.apply_jump_impulse();
            }
        }
        _ => {}
    }

    if movement_direction.magnitude() > 0.0 {
        if renderer_state.game_mode {
            renderer_state.apply_player_movement(movement_direction);
        } else {
            // Free camera mode - directly update position with full 3D movement
            let diff = movement_direction * 0.5;
            camera.position += diff;
            camera.update();
            camera_binding.update_3d(&gpu_resources.queue, &camera);

            let mut config = renderer_state.gizmo.config().clone();
            config.view_matrix = to_row_major_f64(&camera.get_view());
            config.projection_matrix = to_row_major_f64(&camera.get_projection());
            renderer_state.gizmo.update_config(config);
        }
    }
}

pub fn handle_mouse_input(state: &mut Editor, button: EntropyMouseButton, element_state: EntropyElementState) {
    let renderer_state = state.renderer_state.as_mut().expect("Couldn't get renderer state");
    let camera = state.camera.as_ref().expect("Couldn't get camera");
    let window_size = camera.viewport.window_size;

    if !renderer_state.game_mode && element_state == EntropyElementState::Pressed {
        // ... (existing code for selection)
        match button {
            EntropyMouseButton::Left => {
                if let Some(mouse_pos) = renderer_state.current_mouse_position {
                    println!("Check ray");

                    // DEBUG
                            let start_color = [1.0, 0.0, 0.0, 1.0];
                            let pos = [0.0, 0.0, 0.0];
                            let grav = [1.0, -10.0, 0.0];
                            let config = ParticleUniforms {
                                emission_rate: 100.0,
                                life_time: 2.0,
                                radius: 2.0,
                                gravity: grav,
                                initial_speed_min: 2.0,
                                initial_speed_max: 5.0,
                                start_color: start_color,
                                end_color: [start_color[0], start_color[1], start_color[2], 0.0],
                                size: 0.2,
                                mode: 0.0,
                                position: pos,
                                time: 0.0,
                                _pad2: [0.0; 6]
                            };
                            let gpu_resources = state.gpu_resources.as_ref().expect("GPU resources missing");
                            let system = ParticleSystem::new(
                                &gpu_resources.device,
                                &state.camera_binding.as_ref().unwrap().bind_group_layout,
                                config,
                                1000,
                                wgpu::TextureFormat::Rgba8Unorm, // Hardcoded swapchain format
                            );
                    // end debug
                    
                    renderer_state.particle_systems.push(system);

                    // Perform raycast
                    renderer_state.update_rays((mouse_pos.x, mouse_pos.y), &camera, window_size.width, window_size.height);

                    if renderer_state.ray_intersecting {
                        if let Some(ray_component_id) = renderer_state.ray_component_id {
                            let mut found_selectable = false;
                            let hit_uuid = ray_component_id.to_string();

                            println!("hit {:?}", hit_uuid);

                            // Check if a selectable model was hit
                            for model in &renderer_state.models {
                                if model.id == hit_uuid {
                                    // Don't select the player character for now
                                    if let Some(pc) = &renderer_state.player_character {
                                        if pc.model_id.as_ref() == Some(&model.id) {
                                            continue;
                                        }
                                    }
                                    renderer_state.selected_entity_id = Some(model.id.clone());

                                    // NOW FIND THE MATCHING COMPONENT ID
                                    if let Some(saved_state) = &state.saved_state {
                                        if let Some(levels) = &saved_state.levels {
                                            if let Some(level) = levels.get(0) {
                                                if let Some(components) = &level.components {
                                                    // Find component where asset_id matches the model id
                                                    if let Some(component) = components.iter().find(|c| c.asset_id == model.id) {
                                                        renderer_state.selected_component_id = Some(component.id.clone());
                                                        println!("Selected model: {:?}, component: {:?}", model.id, component.id);
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    found_selectable = true;
                                    break;
                                }
                            }

                            // other things

                        } else {
                            // Ray intersected but no component id? Clear selection.
                            // renderer_state.selected_entity_id = None;
                            // println!("Deselected, no component id");
                        }
                    } else {
                        // Do nothing, we want the currently selected object to remain selected
                    }
                }
            }
            EntropyMouseButton::Right => {}
            _ => {}
        }
        
    } else if renderer_state.game_mode && element_state == EntropyElementState::Pressed {
        match button {
            EntropyMouseButton::Left => {
                if let Some(player_character) = &mut renderer_state.player_character {
                    if let Some(camera) = &state.camera {
                        let (attacked_npc_id, debug_line) = player_character.attack(
                            &renderer_state.rigid_body_set,
                            &renderer_state.collider_set,
                            &mut renderer_state.query_pipeline,
                            &mut renderer_state.npcs,
                            camera,
                        );
                        
                        if let Some(id) = attacked_npc_id {
                            state.current_enemy_target = Some(id.clone());
                            println!("Updated enemy target: {:?}", id);
                        }

                        // Execute Rhai on_attack scripts for the player
                        let mut script_changes = Vec::new();
                        if let Some(saved_state) = &state.saved_state {
                            if let Some(levels) = &saved_state.levels {
                                if let Some(components) = levels.get(0).and_then(|l| l.components.as_ref()) {
                                    for component in components.iter() {
                                        if component.kind == Some(ComponentKind::PlayerCharacter) {
                                            if let Some(script_path) = &component.rhai_script_path {
                                                println!("execute_component_script on_attack");
                                                if let Some(change) = state.rhai_engine.execute_component_script(
                                                    renderer_state,
                                                    component,
                                                    script_path,
                                                    "on_attack",
                                                ) {
                                                    script_changes.push(change);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        println!("script_changes {:?}", script_changes.len());

                        // Handle particle spawns from on_attack
                        for change in script_changes {
                            if let Some(spawns) = change.particle_spawns {
                                let gpu_resources = state.gpu_resources.as_ref().expect("GPU resources missing");
                                for spawn in spawns {
                                    let uniforms = ParticleUniforms {
                                        position: [spawn.position.x, spawn.position.y, spawn.position.z],
                                        // _pad0: 0.0,
                                        time: 0.0,
                                        emission_rate: spawn.emission_rate,
                                        life_time: spawn.life_time,
                                        radius: spawn.radius,
                                        gravity: [spawn.gravity.x, spawn.gravity.y, spawn.gravity.z],
                                        // _pad1: 0.0,
                                        initial_speed_min: spawn.initial_speed_min,
                                        initial_speed_max: spawn.initial_speed_max,
                                        start_color: spawn.start_color,
                                        end_color: spawn.end_color,
                                        size: spawn.size,
                                        mode: spawn.mode,
                                        _pad2: [0.0; 6],
                                    };

                                    println!("inserting particles {:?}", uniforms);
                                    
                                    let system = ParticleSystem::new(
                                        &gpu_resources.device,
                                        &state.camera_binding.as_ref().unwrap().bind_group_layout,
                                        uniforms,
                                        1000,
                                        wgpu::TextureFormat::Rgba8Unorm, // Hardcoded swapchain format
                                    );
                                    
                                    renderer_state.particle_systems.push(system);
                                }
                            }
                        }

                        println!("particle_systems {:?}", renderer_state.particle_systems.len());

                        // Handle debug hitscan line
                        if renderer_state.game_settings.show_hitscan_line {
                            println!("Aiming at enemy... {:?}", debug_line);
                            if let Some((start, end)) = debug_line {
                                let gpu_resources = state.gpu_resources.as_ref().expect("GPU resources missing");
                                let mut debug_cube = Cube::new(
                                    &gpu_resources.device,
                                    &gpu_resources.queue,
                                    &renderer_state.model_bind_group_layout,
                                    &renderer_state.group_bind_group_layout,
                                    &renderer_state.texture_render_mode_buffer,
                                    camera,
                                );

                                let dir = (end - start).normalize();
                                // Start a bit in front of the camera to avoid near plane clipping
                                let offset_start = start + dir * 0.5;
                                let length = nalgebra::distance(&offset_start, &end);
                                
                                // Check if target is behind the offset start (too close)
                                if length > 0.0 && (end - start).dot(&dir) > 0.5 {
                                    let scale = 0.02;

                                    let rotation = UnitQuaternion::rotation_between(&Vector3::z(), &dir).unwrap_or_default();
                                    
                                    // Center the cube on the ray (cube is 0..1 in X/Y, we want -0.5..0.5)
                                    // We rotate the offset vector
                                    let center_offset = rotation * Vector3::new(scale * 0.5, scale * 0.5, 0.0);
                                    let draw_pos = offset_start - center_offset;

                                    debug_cube.transform.update_position([draw_pos.x, draw_pos.y, draw_pos.z]);
                                    debug_cube.transform.update_scale([scale, scale, length]);
                                    
                                    debug_cube.transform.update_rotation_quat([
                                        rotation.coords.x,
                                        rotation.coords.y,
                                        rotation.coords.z,
                                        rotation.coords.w,
                                    ]);
                                    
                                    debug_cube.transform.update_uniform_buffer(&gpu_resources.queue);
                                    
                                    renderer_state.debug_rays.push(DebugRay {
                                        cube: debug_cube,
                                        expires_at: Instant::now() + Duration::from_millis(500),
                                    });
                                }
                            }
                        }

                        println!("Left mouse button pressed - Player Attack!");
                    }
                }
            }
            EntropyMouseButton::Right => {
                if let Some(player_character) = &mut renderer_state.player_character {
                    player_character.defend();
                    println!("Right mouse button pressed - Player Defend!");
                }
            }
            _ => {}
        }
    }
}



pub fn handle_mouse_move(mousePressed: bool, currentPosition: EntropyPosition, dx: f32, dy: f32, state: &mut Editor) {
    let renderer_state = state.renderer_state.as_mut().expect("Couldn't get renderer state");
    let gpu_resources = state.gpu_resources.as_ref().expect("Couldn't get gpu resources");

    let current_is_dragging = mousePressed;
    let drag_ended = !current_is_dragging && renderer_state.mouse_state.is_dragging;
    let drag_started = current_is_dragging && !renderer_state.mouse_state.is_dragging;

    renderer_state.mouse_state.is_dragging = current_is_dragging;
    renderer_state.mouse_state.drag_started = drag_started;

    if let Some(component_id) = &renderer_state.selected_component_id {
        if let Some(selected_id) = renderer_state.selected_entity_id.clone() {
            let mut found_and_updated = false;

            // Try to find and update a model
            if let Some(model) = renderer_state.models.iter_mut().find(|m| m.id == selected_id) {
                if let Some(mesh) = model.meshes.get_mut(0) {
                    
                    let mut transforms = vec![
                        Transform::from_scale_rotation_translation(
                            MintVector3::from([mesh.transform.scale.x as f64, mesh.transform.scale.y as f64, mesh.transform.scale.z as f64]),
                            Quaternion::from([
                                mesh.transform.rotation.quaternion().coords.x as f64,
                                mesh.transform.rotation.quaternion().coords.y as f64,
                                mesh.transform.rotation.quaternion().coords.z as f64,
                                mesh.transform.rotation.quaternion().coords.w as f64
                            ]),
                            MintVector3::from([mesh.transform.position.x as f64, mesh.transform.position.y as f64, mesh.transform.position.z as f64])
                        )
                    ];

                    let interaction = GizmoInteraction {
                        cursor_pos: (currentPosition.x as f32, currentPosition.y as f32),
                        dragging: current_is_dragging,
                        drag_started: drag_started,
                        hovered: true, // This will be determined by the gizmo's update call
                        ..Default::default()
                    };

                    if let Some((_gizmo_result, new_transforms)) = renderer_state.gizmo.update(interaction, &mut transforms) {
                        renderer_state.mouse_state.hovered_gizmo = true;

                        // Update transforms
                        for (new_transform, _transform) in new_transforms.iter().zip(&mut transforms) {
                            mesh.transform.update_position([new_transform.translation.x as f32, new_transform.translation.y as f32, new_transform.translation.z as f32]);
                            mesh.transform.update_rotation_quat([new_transform.rotation.v.x as f32, new_transform.rotation.v.y as f32, new_transform.rotation.v.z as f32, new_transform.rotation.s as f32]);
                            mesh.transform.update_scale([new_transform.scale.x as f32, new_transform.scale.y as f32, new_transform.scale.z as f32]);
                            mesh.transform.update_uniform_buffer(&gpu_resources.queue);

                            // also update rigidbody position
                            if let Some(rb_handle) = mesh.rigid_body_handle {
                                if let Some(rb) = renderer_state.rigid_body_set.get_mut(rb_handle) {
                                    let new_iso = Isometry3::from_parts(
                                        nalgebra::Translation3::new(new_transform.translation.x as f32, new_transform.translation.y as f32, new_transform.translation.z as f32),
                                        nalgebra::UnitQuaternion::from_quaternion(nalgebra::Quaternion::new(new_transform.rotation.s as f32, new_transform.rotation.v.x as f32, new_transform.rotation.v.y as f32, new_transform.rotation.v.z as f32))
                                    );
                                    rb.set_position(new_iso, true);
                                }
                            }

                        }
                    } else {
                        renderer_state.mouse_state.hovered_gizmo = false;
                    }

                    if drag_ended {
                        if let Some(saved_state) = state.saved_state.as_mut() {
                            if let Some(project_id) = &saved_state.id {
                                let mut component_updated = false;
                                if let Some(levels) = saved_state.levels.as_mut() {
                                    if let Some(level) = levels.get_mut(0) {
                                        if let Some(components) = level.components.as_mut() {
                                            // if let Some(component) = components.iter_mut().find(|c| c.id == selected_id) {
                                            if let Some(component) = components.iter_mut().find(|c| c.id == component_id.clone()) {
                                                let new_pos = [mesh.transform.position.x as f32, mesh.transform.position.y as f32, mesh.transform.position.z as f32];
                                                
                                                let new_rot_quat = mesh.transform.rotation;
                                                let euler_angles = new_rot_quat.euler_angles();
                                                let new_rot = [euler_angles.0.to_degrees(), euler_angles.1.to_degrees(), euler_angles.2.to_degrees()];
                                                
                                                let new_scale = [mesh.transform.scale.x as f32, mesh.transform.scale.y as f32, mesh.transform.scale.z as f32];

                                                component.generic_properties.position = new_pos;
                                                component.generic_properties.rotation = new_rot;
                                                component.generic_properties.scale = new_scale;
                                                component_updated = true;
                                            }
                                        }
                                    }
                                }

                                if component_updated {
                                    // TODO: WASM version
                                    if let Err(e) = utilities::update_project_state(project_id, saved_state) {
                                        println!("Failed to save project state: {}", e);
                                    } else {
                                        println!("Project state saved successfully after gizmo drag.");
                                    }
                                }
                            }
                        }
                    } 

                    found_and_updated = true;
                }
            }

            // If not found in models, try to find and update a procedural house
            if !found_and_updated {
                if let Some(house) = renderer_state.procedural_houses.iter_mut().find(|h| h.id == selected_id) {
                    // Similar logic for houses, assuming they have a transform
                    // For now, let's just log it
                    println!("Gizmo trying to move a house... (not implemented yet)");
                }
            }

        } else {
            // Nothing is selected, ensure gizmo is not considered hovered
            renderer_state.mouse_state.hovered_gizmo = false;
        }
    } else {
        // Nothing is selected, ensure gizmo is not considered hovered
        renderer_state.mouse_state.hovered_gizmo = false;
    }
}

pub fn handle_mouse_move_on_shift(dx: f32, dy: f32, state: &mut Editor) {
    let camera = state.camera.as_mut().expect("Couldn't get camera");
    let camera_binding = state.camera_binding.as_mut().expect("Couldn't get camera binding");
    let gpu_resources = state.gpu_resources.as_ref().expect("Couldn't get gpu resources");
    let renderer_state = state.renderer_state.as_mut().expect("Couldn't get renderer state");

    let sensitivity = 0.005;

    let dx = -dx * sensitivity;
    let dy = dy * sensitivity;

    // game_mode is handled in renderer_state step_physics_pipeline
    if !renderer_state.game_mode {
        camera.rotate(dx, dy);
    }

    camera.update();
    camera_binding.update_3d(&gpu_resources.queue, &camera);

    let mut config = renderer_state.gizmo.config().clone();
    config.view_matrix = to_row_major_f64(&camera.get_view());
    config.projection_matrix = to_row_major_f64(&camera.get_projection());
    renderer_state.gizmo.update_config(config.clone());
}

pub async fn handle_add_house(
    state: &mut RendererState,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    house_component_id: String,
    config: &HouseConfig,
    isometry: Isometry3<f32>,
) {
    state.add_house(device, queue, &house_component_id, config, isometry);
    // Houses are static and don't have their own colliders added in the same way as dynamic models.
    // The collider is created and managed within the House::new function.
}

pub async fn handle_add_model(
    state: &mut RendererState,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    projectId: String,
    modelAssetId: String, // model is added to stored library as an asset
    modelComponentId: String, // model is added from library to scene as an active component
    modelFilename: String,
    isometry: Isometry3<f32>,
    scale: Vector3<f32>,
    camera: &SimpleCamera,
    script_state: Option<HashMap<String, String>>,
) {
    #[cfg(target_os = "windows")]
    let bytes = read_model(projectId, modelFilename).expect("Couldn't get model bytes");

    #[cfg(target_arch = "wasm32")]
    let bytes = read_model_wasm(projectId, modelFilename).await.expect("Couldn't get model bytes");

    state.add_model(device, queue, &modelComponentId, &bytes, isometry, scale, camera, false, script_state);
    state.add_collider(modelComponentId, ComponentKind::Model);
}

pub async fn handle_add_npc(
    state: &mut RendererState,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    projectId: String,
    modelAssetId: String, // model is added to stored library as an asset
    npcComponentId: String, // model is added from library to scene as an active component
    modelFilename: String,
    isometry: Isometry3<f32>,
    scale: Vector3<f32>,
    camera: &SimpleCamera,
    script_state: Option<HashMap<String, String>>,
) {
    #[cfg(target_os = "windows")]
    let bytes = read_model(projectId, modelFilename).expect("Couldn't get model bytes");

    #[cfg(target_arch = "wasm32")]
    let bytes = read_model_wasm(projectId, modelFilename).await.expect("Couldn't get model bytes");

    state.add_model(device, queue, &npcComponentId, &bytes, isometry, scale, camera, false, script_state);

    state.add_collider(npcComponentId.clone(), ComponentKind::NPC);

    // Retrieve the rigid_body_handle after the collider has been added
    let npc_rigid_body_handle = state
        .models
        .iter()
        .find(|m| m.id == npcComponentId)
        .and_then(|m| m.meshes.get(0))
        .and_then(|mesh| mesh.rigid_body_handle)
        .expect("Couldn't retrieve rigid body handle for NPC after adding collider");

    state.npcs.push(NPC::new(npcComponentId.clone(), npcComponentId.clone(), npc_rigid_body_handle));
}

pub async fn handle_add_collectable(
    state: &mut RendererState,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    projectId: String,
    modelAssetId: String, // model is added to stored library as an asset
    modelComponentId: String, // model is added from library to scene as an active component
    modelFilename: String,
    isometry: Isometry3<f32>,
    scale: Vector3<f32>,
    camera: &SimpleCamera,
    collectable_properties: &CollectableProperties,
    related_stat: &StatData,
    hide_in_world: bool,
    script_state: Option<HashMap<String, String>>,
) {
    #[cfg(target_os = "windows")]
    let bytes = read_model(projectId, modelFilename).expect("Couldn't get model bytes");

    #[cfg(target_arch = "wasm32")]
    let bytes = read_model_wasm(projectId, modelFilename).await.expect("Couldn't get model bytes");

    state.add_model(device, queue, &modelAssetId, &bytes, isometry, scale, camera, hide_in_world, script_state);

    state.add_collider(modelAssetId.clone(), ComponentKind::Collectable);

    // Retrieve the rigid_body_handle after the collider has been added
    let npc_rigid_body_handle = state
        .models
        .iter()
        .find(|m| m.id == modelAssetId)
        .and_then(|m| m.meshes.get(0))
        .and_then(|mesh| mesh.rigid_body_handle)
        .expect("Couldn't retrieve rigid body handle for NPC after adding collider");

    let collectable_type = collectable_properties.collectable_type.as_ref().expect("Couldn't get collectable type");

    state.collectables.push(Collectable::new(modelComponentId.clone(), modelAssetId.clone(), collectable_type.clone(), related_stat.clone(), npc_rigid_body_handle));
}

#[derive(Serialize, Deserialize)]
pub struct LandscapeData {
    pub width: usize,
    pub height: usize,
    pub pixel_data: Vec<Vec<PixelData>>,
}

#[derive(Serialize, Deserialize)]
pub struct PixelData {
    pub height_value: f32,
    pub position: [f32; 3],
    pub tex_coords: [f32; 2],
}

pub async fn handle_add_landscape(
    state: &mut RendererState,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    projectId: String,
    landscapeAssetId: String,
    landscapeComponentId: String,
    landscapeFilename: String,
    position: [f32; 3],
    camera: &mut SimpleCamera
) {
    // w/o quadtree
    #[cfg(target_os = "windows")]
    let data = get_landscape_pixels(projectId, landscapeAssetId, landscapeFilename);

    #[cfg(target_arch = "wasm32")]
    let data = get_landscape_pixels_wasm(projectId, landscapeAssetId, landscapeFilename).await;

    state.add_landscape(device, queue, &landscapeComponentId, &data, position, camera);
    state.add_collider(landscapeComponentId, ComponentKind::Landscape);

    // with quadtree
    // state.add_terrain_manager(
    //     device,
    //     queue,
    //     projectId,
    //     landscapeAssetId,
    //     landscapeComponentId,
    //     landscapeFilename,
    //     position,
    //     camera
    // );
}

pub async fn handle_add_landscape_texture(
    state: &mut RendererState,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    project_id: String,
    landscape_component_id: String,
    landscape_asset_id: String,
    texture_filename: String,
    texture_kind: LandscapeTextureKinds,
    mask_filename: String,
) {
    println!(
        "Adding texture and mask {:?} {:?}",
        texture_filename, mask_filename
    );

    // Clone the values that need to be moved into the closure
    let landscape_component_id_clone = landscape_component_id.clone();
    let texture_kind_clone = texture_kind.clone();

    let texture = fetch_texture_data(
        project_id.clone(),
        landscape_asset_id.clone(),
        texture_filename,
        // texture_kind.clone(),
    ).await;
    let mask = fetch_mask_data(
        project_id.clone(),
        landscape_asset_id.clone(),
        mask_filename,
        texture_kind.clone(),
    ).await;

    let maskKind = match texture_kind_clone {
        LandscapeTextureKinds::Primary => LandscapeTextureKinds::PrimaryMask,
        LandscapeTextureKinds::Rockmap => LandscapeTextureKinds::RockmapMask,
        LandscapeTextureKinds::Soil => LandscapeTextureKinds::SoilMask,
        _ => {
            return;
        }
    };

    state.update_landscape_texture(
        device,
        queue,
        landscape_component_id_clone,
        texture_kind_clone,
        texture,
        maskKind,
        mask,
    );
}

pub async fn fetch_texture_data(
    project_id: String,
    landscape_id: String,
    texture_filename: String,
) -> Texture {
    #[cfg(target_os = "windows")]
    let texture_data =
            read_landscape_texture(project_id, landscape_id, texture_filename)
                .expect("Couldn't get texture data");

    #[cfg(target_arch = "wasm32")]
    let texture_data =
        read_landscape_texture_wasm(project_id, landscape_id, texture_filename).await
            .expect("Couldn't get texture data");

    Texture::new(texture_data.bytes, texture_data.width, texture_data.height)
}

pub async fn fetch_mask_data(
    project_id: String,
    landscape_id: String,
    mask_filename: String,
    mask_kind: LandscapeTextureKinds,
) -> Texture {
    #[cfg(target_os = "windows")]
    let mask_data = read_landscape_mask(project_id, landscape_id, mask_filename, mask_kind)
        .expect("Couldn't get mask data");

    #[cfg(target_arch = "wasm32")]
    let mask_data = read_landscape_mask_wasm(project_id, landscape_id, mask_filename, mask_kind).await
        .expect("Couldn't get mask data");

    Texture::new(mask_data.bytes, mask_data.width, mask_data.height)
}

pub fn handle_add_grass(
    state: &mut RendererState,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    camera_bind_group_layout: &wgpu::BindGroupLayout,
    model_bind_group_layout: &wgpu::BindGroupLayout,
    landscape_id: &str,
    texture_data: TextureData
) {
    if let Some(landscape) = state.landscapes.iter_mut().find(|l| l.id == landscape_id) {
        println!("Adding grass to landscape: {}", landscape.id);

        let texture = Texture::new(texture_data.bytes, texture_data.width, texture_data.height);

        landscape.update_particle_texture(
            device,
            queue,
            &model_bind_group_layout,
            &state.texture_render_mode_buffer,
            &state.color_render_mode_buffer,
            LandscapeTextureKinds::Primary,
            &texture,
        );

        let grass = Grass::new(&device, &camera_bind_group_layout, landscape);

        state.grasses.push(grass);
        println!("Added grass");
    } else {
        println!("Could not find landscape with id: {}", landscape_id);
    }
}

pub fn handle_add_water_plane(
    state: &mut RendererState,
    device: &wgpu::Device,
    camera_bind_group_layout: &wgpu::BindGroupLayout,
    texture_format: wgpu::TextureFormat,
    component_id: String
) {
    if let Some(mut landscape_obj) = state.landscapes.iter_mut().find(|l| l.id == component_id) {
        let config = WaterConfig::default();
        let water_plane = WaterPlane::new(device, camera_bind_group_layout, texture_format, landscape_obj, config);
        state.water_planes.push(water_plane);
    }
}

pub fn handle_add_trees(
    renderer_state: &mut RendererState,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    camera_bind_group_layout: &wgpu::BindGroupLayout,
) {
    if let Some(landscape) = renderer_state.landscapes.get_mut(0) {
        let mut trees = ProceduralTrees::new(device, camera_bind_group_layout, landscape);

        let mut rng = rand::thread_rng();
        let num_trees = 50;

        for _ in 0..num_trees {
            let x = rng.gen_range(-50.0..50.0);
            let z = rng.gen_range(-50.0..50.0);

            if let Some(y) = landscape.get_height_at(x, z) {
                trees.instances.push(TreeInstance {
                    position: [x, y, z],
                    scale: rng.gen_range(0.8..1.5),
                    rotation: [0.0, rng.gen_range(0.0..std::f32::consts::PI * 2.0), 0.0],
                });
            }
        }
        
        queue.write_buffer(
            &trees.instance_buffer,
            0,
            bytemuck::cast_slice(&trees.instances),
        );

        renderer_state.procedural_trees.push(trees);
    }
}

pub fn handle_configure_water_plane(
    state: &mut RendererState,
    queue: &wgpu::Queue,
    config: WaterConfig,
) {
    if let Some(water_plane) = state.water_planes.get_mut(0) {
        water_plane.update_config(queue, config);
    }
}

use crate::game_behaviors::dialogue_state::DialogueState;

fn handle_npc_interaction(state: &mut Editor) {
    // println!("Checking interact...");

    let renderer_state = match state.renderer_state.as_mut() {
        Some(rs) => rs,
        None => return,
    };
    
    let player = match &renderer_state.player_character {
        Some(p) => p,
        None => return,
    };
    
    let player_handle = player.movement_rigid_body_handle.as_ref().expect("Couldn't get player rigidbody");
    let player_pos = if let Some(rb) = renderer_state.rigid_body_set.get(*player_handle) {
        rb.translation().clone()
    } else {
        return;
    };

    let mut target_id = String::new();
    
    for npc in &renderer_state.npcs {
        if let Some(rb) = renderer_state.rigid_body_set.get(npc.rigid_body_handle) {
            let npc_pos = rb.translation();
            let dist = (npc_pos - player_pos).magnitude();
            // Using 50.0 as interaction range
            if dist < 10.0 {
                target_id = npc.id.to_string().clone();
                break;
            }
        }
    }
    
    if target_id.is_empty() {
        return;
    }

    // println!("Running interact... {:?}", target_id);
    
    let mut target_script_path = None;
    let mut target_npc_name = String::new();
    
    if let Some(saved_state) = &state.saved_state {
        if let Some(levels) = &saved_state.levels {
             if let Some(level) = levels.get(0) {
                 if let Some(components) = &level.components {
                     for comp in components {
                         if let Some(kind) = &comp.kind {
                             if let ComponentKind::NPC = kind {
                                //  if let Some(props) = &comp.npc_properties {
                                     if comp.id == target_id {
                                         if let Some(script) = &comp.rhai_script_path {
                                             target_script_path = Some(script.clone());
                                             target_npc_name = comp.generic_properties.name.clone();
                                         }
                                     }
                                //  }
                             }
                         }
                     }
                 }
             }
        }
    }

    println!("target_npc_name... {:?} {:?} {:?}", target_id, target_npc_name, target_script_path);
    
    if let Some(script) = target_script_path {
        state.dialogue_state.npc_name = target_npc_name;
        state.dialogue_state.current_npc_id = target_id;
        state.rhai_engine.execute_interaction_script(
            state.renderer_state.as_mut().unwrap(), // Need to pass renderer_state
            &mut state.dialogue_state,
            &script,
            "interact"
        );
    }
}