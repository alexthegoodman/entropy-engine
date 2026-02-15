use nalgebra::{Isometry3, Matrix3, Matrix4, Point3, UnitQuaternion, Vector3};
use mint::{Quaternion, Vector3 as MintVector3};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use crate::core::RendererState::DebugRay;
use crate::game_behaviors::stateful::BehaviorConfig;
use crate::model_components::Collectable::Collectable;
use crate::model_components::PlayerCharacter::MovementState;
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
use std::str::FromStr;

use crate::model_components::{PlayerCharacter::PlayerCharacter, NPC::NPC};
use crate::core::SimpleCamera::to_row_major_f64;
use crate::core::editor::{self, Editor, SelectedObject, Shape, WindowSize};
use crate::vector_animations::animations::ObjectType;
use crate::core::gpu_resources;
use crate::helpers::utilities;
use crate::helpers::landscapes::{TextureData, read_landscape_heightmap_as_texture};
use crate::helpers::saved_data::{CollectableProperties, CollectableType, ComponentData, ComponentKind, ProceduralGrassProperties, ProceduralParticleProperties, ProceduralTreeProperties, ScatterSettings, StatData, VisualType};
#[cfg(target_arch = "wasm32")]
use crate::helpers::wasm_loaders::{get_landscape_pixels_wasm, read_landscape_mask_wasm, read_landscape_texture_wasm, read_model_wasm};
use crate::procedural_trees::trees::{ProceduralTrees, TreeInstance};
use crate::procedural_particles::particle_system::{ParticleSystem, ParticleUniforms};
// use crate::deno::script_engine::{ComponentChanges, DenoEngine, ScriptParticleConfig};
use crate::shape_primitives::Cube::Cube;
use crate::procedural_grass::grass::{Grass};
use crate::water_plane::water::WaterPlane;
use crate::water_plane::config::WaterConfig;
use rand::{Rng, random, SeedableRng};
use rand::rngs::StdRng;
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

#[cfg(target_arch = "wasm32")]
use std::time::Duration;

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
    behavior_id: Option<String>
) {
    #[cfg(target_os = "windows")]
    let bytes = read_model(projectId, modelFilename).expect("Couldn't get model bytes");

    #[cfg(target_arch = "wasm32")]
    let bytes = read_model_wasm(projectId, modelFilename).await.expect("Couldn't get model bytes");

    state.add_model(device, queue, &modelComponentId, &bytes, isometry, scale, camera, false, script_state, None, behavior_id);

    state.add_collider(modelComponentId.clone(), ComponentKind::PlayerCharacter, None);

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
        default_weapon,
        VisualType::Model
    );

    player_character.model_id = Some(modelComponentId); // may want to be an optional model later

    state.player_character = Some(player_character);
}

pub fn handle_key_press(state: &mut Editor, key_code: &str, is_pressed: bool) {
    // Push event to Addons
    {
        let mut op_state = state.addon_engine.runtime.op_state();
        let mut op_state = op_state.borrow_mut();
        if let Some(ctx) = op_state.try_borrow_mut::<crate::deno::addon_engine::AddonContext>() {
            let key = key_code.to_string();
            if is_pressed {
                ctx.pressed_keys.insert(key.clone());
                ctx.input_events.push(crate::deno::addon_engine::InputEvent::KeyDown { key });
            } else {
                ctx.pressed_keys.remove(&key);
                ctx.input_events.push(crate::deno::addon_engine::InputEvent::KeyUp { key });
            }
        }
    }

    if key_code == "e" {
        if state.dialogue_state.options.is_empty() {
            if is_pressed {
                handle_npc_interaction(state);
                handle_collectable_interaction(state);
            }
        }
    } else if key_code == "i" {
        // Now handled JS-side
        // if is_pressed {
        //     let game_mode = state.renderer_state.as_ref().map(|r| r.game_mode).unwrap_or(false);
        //     if game_mode {
        //         let gpu_resources = state.gpu_resources.clone();
        //         if let Some(gpu_resources) = gpu_resources {
        //             crate::game_ui::inventory_ui::toggle_inventory_menu(state, &gpu_resources.device, &gpu_resources.queue);
        //         }
        //     }
        // }
        return;
    } else if key_code == "Delete" {
        if is_pressed {
            if let Some(selected) = state.selected_object.clone() {
                if let Some(stunts_state) = state.stunts_state.as_mut() {
                    match selected.object_type {
                        ObjectType::Polygon => {
                            if let Some(polys) = &mut stunts_state.active_polygons {
                                polys.retain(|p| p.id != selected.object_id.to_string());
                            }
                        }
                        ObjectType::TextItem => {
                            if let Some(texts) = &mut stunts_state.active_text_items {
                                texts.retain(|t| t.id != selected.object_id.to_string());
                            }
                        }
                        ObjectType::ImageItem => {
                            if let Some(imgs) = &mut stunts_state.active_image_items {
                                imgs.retain(|i| i.id != selected.object_id.to_string());
                            }
                        }
                        ObjectType::VideoItem => {
                            if let Some(vids) = &mut stunts_state.active_video_items {
                                vids.retain(|v| v.id != selected.object_id.to_string());
                            }
                        }
                    }
                    if let Some(project_id) = &stunts_state.id {
                        let _ = utilities::update_project_state(project_id, stunts_state);
                    }
                    state.selected_object = None;
                    state.sync_stunts_objects();
                }
            }
        }
        return;
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
            "r" => {
            if is_pressed {
                if let Some(player) = &mut renderer_state.player_character {
                    player.reload();
                }
            }
        },
        "w" | "ArrowUp" => {
                if state.dialogue_state.selected_option_index > 0 {
                    state.dialogue_state.selected_option_index -= 1;
                    state.dialogue_state.ui_dirty = true;
                }
                return;
            },
            "s" | "ArrowDown" => {
                if state.dialogue_state.selected_option_index < state.dialogue_state.options.len().saturating_sub(1) {
                    state.dialogue_state.selected_option_index += 1;
                    state.dialogue_state.ui_dirty = true;
                }
                return;
            },
            "e" | "Enter" => {
                 // Trigger option
                 if !state.dialogue_state.options.is_empty() {
                     let next_node = state.dialogue_state.options[state.dialogue_state.selected_option_index].next_node.clone();
                     state.dialogue_state.current_node = next_node.clone();
                     
                     if next_node == "exit" {
                         state.dialogue_state.is_open = false;
                         state.dialogue_state.ui_dirty = true;
                         if let Some(renderer_state) = state.renderer_state.as_mut() {
                             if let Some(npc) = renderer_state.npcs.iter_mut().find(|n| n.id == state.dialogue_state.current_npc_id) {
                                 npc.is_talking = false;
                             }
                         }
                     } else {
                        if let Some(renderer_state) = state.renderer_state.as_mut() {
                            let target_id = state.dialogue_state.current_npc_id.clone();
                            let mut target_script_path = None;
                            
                            if let Some(world_state) = &state.world_state {
                                if let Some(levels) = &world_state.levels {
                                    if let Some(level) = levels.get(0) {
                                        if let Some(components) = &level.components {
                                            if let Some(comp) = components.iter().find(|c| c.id == target_id) {
                                                target_script_path = comp.js_script_path.clone();
                                            }
                                        }
                                    }
                                }
                            }

                            if let Some(script) = target_script_path {
                                if let Some(npc) = renderer_state.npcs.iter().find(|n| n.id == target_id) {
                                    if let Some(rb) = renderer_state.rigid_body_set.get(*npc.rigid_body_handle.as_ref().expect("Couldnt get handle")) {
                                        let pos = rb.translation();
                                        let wrapper = crate::deno::addon_engine::EntityWrapper {
                                            id: npc.id.clone(),
                                            position: [pos.x, pos.y, pos.z],
                                            health: npc.stats.health,
                                            stamina: npc.stats.stamina,
                                            is_dead: npc.is_dead,
                                        };
                                        let dialogue_res = state.addon_engine.execute_behavior(renderer_state, &script, wrapper, "on_interact", Some(state.dialogue_state.current_node.clone()));
                                        if let Some(d) = dialogue_res {
                                            if d.is_open {
                                                state.dialogue_state.current_text = d.text;
                                                state.dialogue_state.options = d.options;
                                                state.dialogue_state.current_node = d.current_node;
                                                state.dialogue_state.ui_dirty = true;
                                            } else {
                                                state.dialogue_state.is_open = false;
                                                state.dialogue_state.ui_dirty = true;
                                            }
                                        }
                                    }
                                }
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
        "Shift" => {
             if let Some(player) = &mut renderer_state.player_character {
                 if is_pressed {
                     if player.movement_state != MovementState::Crouching 
                        && player.movement_state != MovementState::Prone 
                     {
                         player.movement_state = MovementState::Sprinting;
                     }
                 } else {
                     if player.movement_state == MovementState::Sprinting {
                         player.movement_state = MovementState::Walking;
                     }
                 }
            }
        },
        "c" => {
            if is_pressed {
                if let Some(player) = &mut renderer_state.player_character {
                    if player.movement_state == MovementState::Crouching {
                        player.movement_state = MovementState::Walking;
                    } else {
                        player.movement_state = MovementState::Crouching;
                    }
                }
            }
        },
        "z" => {
            if is_pressed {
                if let Some(player) = &mut renderer_state.player_character {
                    if player.movement_state == MovementState::Prone {
                        player.movement_state = MovementState::Walking;
                    } else {
                        player.movement_state = MovementState::Prone;
                    }
                }
            }
        },
        "r" => {
            if is_pressed {
                if let Some(player) = &mut renderer_state.player_character {
                    player.reload();
                }
            }
        },
        "w" | "ArrowUp" => {
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
        "s" | "ArrowDown" => {
            if is_pressed {
                let forward = if renderer_state.game_mode {
                    Vector3::new(camera.direction.x, 0.0, camera.direction.z).normalize()
                } else {
                    camera.direction
                };
                movement_direction -= forward * speed_multiplier;
            }
        }
        "a" | "ArrowLeft" => {
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
        "d" | "ArrowRight" => {
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
        "Space" | " " => { // Space bar for jumping
            if is_pressed && renderer_state.game_mode {
                renderer_state.apply_jump_impulse();
            }
        }
        
        _ => {}
    }

    if movement_direction.magnitude() > 0.0 {
        if renderer_state.game_mode {
            renderer_state.apply_player_movement(movement_direction, 0.016);
            // renderer_state.update_player_character_position(movement_direction, 0.16, camera);
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

    // Push event to Addons
    {
        let mut op_state = state.addon_engine.runtime.op_state();
        let mut op_state = op_state.borrow_mut();
        if let Some(ctx) = op_state.try_borrow_mut::<crate::deno::addon_engine::AddonContext>() {
            let btn_idx = match button {
                EntropyMouseButton::Left => 0,
                EntropyMouseButton::Right => 1,
                EntropyMouseButton::Middle => 2,
                _ => 0,
            };
            if element_state == EntropyElementState::Pressed {
                if let Some(mouse_pos) = renderer_state.current_mouse_position {
                    ctx.input_events.push(crate::deno::addon_engine::InputEvent::MouseDown { 
                        button: btn_idx, 
                        x: mouse_pos.x, 
                        y: mouse_pos.y 
                    });
                }
            } else {
                ctx.input_events.push(crate::deno::addon_engine::InputEvent::MouseUp { 
                    button: btn_idx 
                });
            }
        }
    }

    if !renderer_state.game_mode && element_state == EntropyElementState::Pressed {
        // ... (existing code for selection)
        match button {
            EntropyMouseButton::Left => {
                if let Some(mouse_pos) = renderer_state.current_mouse_position {
                    // println!("Check for Stunts objects");

                    let camera = state.camera.as_ref().unwrap();
                    let window_size_struct = WindowSize { width: window_size.width, height: window_size.height };
                    let ray = crate::core::editor::visualize_ray_intersection(&window_size_struct, mouse_pos.x, mouse_pos.y, camera);
                    let hit_point = ray.top_left;

                    let mut hit_stunts_obj = None;

                    // Check polygons
                    for poly in state.stunts_polygons.iter().rev() {
                        if poly.contains_point(&hit_point, camera) {
                            hit_stunts_obj = Some(SelectedObject {
                                object_id: poly.id,
                                object_type: ObjectType::Polygon,
                            });
                            break;
                        }
                    }

                    if hit_stunts_obj.is_none() {
                        // Check textboxes
                        for text in state.stunts_textboxes.iter().rev() {
                            if text.contains_point(&hit_point, camera) {
                                hit_stunts_obj = Some(SelectedObject {
                                    object_id: text.id,
                                    object_type: ObjectType::TextItem,
                                });
                                break;
                            }
                        }
                    }

                    if hit_stunts_obj.is_none() {
                        // Check images
                        for img in state.stunts_images.iter().rev() {
                            if img.contains_point(&hit_point) {
                                if let Ok(id) = Uuid::from_str(&img.id) {
                                    hit_stunts_obj = Some(SelectedObject {
                                        object_id: id,
                                        object_type: ObjectType::ImageItem,
                                    });
                                }
                                break;
                            }
                        }
                    }

                    if hit_stunts_obj.is_none() {
                        // Check videos
                        for vid in state.stunts_videos.iter().rev() {
                            if vid.contains_point(&hit_point, camera) {
                                if let Ok(id) = Uuid::from_str(&vid.id) {
                                    hit_stunts_obj = Some(SelectedObject {
                                        object_id: id,
                                        object_type: ObjectType::VideoItem,
                                    });
                                }
                                break;
                            }
                        }
                    }

                    if let Some(obj) = hit_stunts_obj {
                        state.selected_object = Some(obj);
                        renderer_state.selected_entity_id = None;
                        renderer_state.selected_component_id = None;
                        // println!("Selected Stunts object: {:?}", state.selected_object);
                        return;
                    }

                    // println!("Check ray");

                    // Perform raycast
                    renderer_state.update_rays((mouse_pos.x, mouse_pos.y), &camera, window_size.width, window_size.height);

                    if renderer_state.ray_intersecting {
                        if let Some(ray_component_id) = renderer_state.ray_component_id {
                            let mut found_selectable = false;
                            let hit_uuid = ray_component_id.to_string();

                            // println!("hit {:?}", hit_uuid);

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
                                    if let Some(world_state) = &state.world_state {
                                        if let Some(levels) = &world_state.levels {
                                            if let Some(level) = levels.get(0) {
                                                if let Some(components) = &level.components {
                                                    // Find component where asset_id matches the model id
                                                    if let Some(component) = components.iter().find(|c| c.id == model.id) {
                                                        renderer_state.selected_component_id = Some(component.id.clone());
                                                        // println!("Selected model: {:?}, component: {:?}", model.id, component.id);
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
                    player_character.is_firing = true;
                    // println!("Left mouse button pressed - Player Firing Start");
                }
            }
            EntropyMouseButton::Right => {
                if let Some(player_character) = &mut renderer_state.player_character {
                    // TODO: use defend when holding melee weapon
                    // player_character.defend();
                    // println!("Right mouse button pressed - Player Defend!");
                    let is_pressed = element_state == EntropyElementState::Pressed;
                    player_character.set_aiming(is_pressed);
                }
            }
            _ => {}
        }
    } else if renderer_state.game_mode && element_state == EntropyElementState::Released {
         match button {
            EntropyMouseButton::Left => {
                if let Some(player_character) = &mut renderer_state.player_character {
                    player_character.is_firing = false;
                    // println!("Left mouse button released - Player Firing Stop");
                }
            }
            EntropyMouseButton::Right => {
                if let Some(player_character) = &mut renderer_state.player_character {
                    // release defend if needed for melee weapon
                    let is_pressed = element_state == EntropyElementState::Pressed;
                    player_character.set_aiming(is_pressed);
                }
            }
            _ => {}
        }
    }
}



pub fn handle_mouse_move(mousePressed: bool, currentPosition: Option<EntropyPosition>, dx: f32, dy: f32, state: &mut Editor) {
    let renderer_state = state.renderer_state.as_mut().expect("Couldn't get renderer state");
    let gpu_resources = state.gpu_resources.as_ref().expect("Couldn't get gpu resources");

    // Push event to Addons
    {
        let mut op_state = state.addon_engine.runtime.op_state();
        let mut op_state = op_state.borrow_mut();
        if let Some(ctx) = op_state.try_borrow_mut::<crate::deno::addon_engine::AddonContext>() {
            if let Some(mouse_pos) = currentPosition {
                ctx.input_events.push(crate::deno::addon_engine::InputEvent::MouseMove { 
                    x: mouse_pos.x, 
                    y: mouse_pos.y 
                });
            }
        }
    }

    let current_is_dragging = mousePressed;
    let drag_ended = !current_is_dragging && renderer_state.mouse_state.is_dragging;
    let drag_started = current_is_dragging && !renderer_state.mouse_state.is_dragging;

    renderer_state.mouse_state.is_dragging = current_is_dragging;
    renderer_state.mouse_state.drag_started = drag_started;

    if current_is_dragging {
        if let Some(selected) = &state.selected_object {
            match selected.object_type {
                ObjectType::Polygon => {
                    if let Some(poly) = state.stunts_polygons.iter_mut().find(|p| p.id == selected.object_id) {
                        poly.transform.position.x += dx;
                        poly.transform.position.y += dy;
                        poly.transform.update_uniform_buffer(&gpu_resources.queue);
                    }
                }
                ObjectType::TextItem => {
                    if let Some(text) = state.stunts_textboxes.iter_mut().find(|t| t.id == selected.object_id) {
                        text.transform.position.x += dx;
                        text.transform.position.y += dy;
                        text.transform.update_uniform_buffer(&gpu_resources.queue);
                        
                        // Also update background polygon
                        text.background_polygon.transform.position.x += dx;
                        text.background_polygon.transform.position.y += dy;
                        text.background_polygon.transform.update_uniform_buffer(&gpu_resources.queue);
                    }
                }
                ObjectType::ImageItem => {
                    if let Some(img) = state.stunts_images.iter_mut().find(|i| i.id == selected.object_id.to_string()) {
                        img.transform.position.x += dx;
                        img.transform.position.y += dy;
                        img.transform.update_uniform_buffer(&gpu_resources.queue);
                    }
                }
                ObjectType::VideoItem => {
                    if let Some(vid) = state.stunts_videos.iter_mut().find(|v| v.id == selected.object_id.to_string()) {
                        vid.transform.position.x += dx;
                        vid.transform.position.y += dy;
                        vid.transform.update_uniform_buffer(&gpu_resources.queue);
                    }
                }
            }
        }
    }

    if drag_ended {
        if let Some(selected) = &state.selected_object {
            if let Some(stunts_state) = state.stunts_state.as_mut() {
                let mut updated = false;
                match selected.object_type {
                    ObjectType::Polygon => {
                        if let Some(poly) = state.stunts_polygons.iter().find(|p| p.id == selected.object_id) {
                            if let Some(saved_polys) = &mut stunts_state.active_polygons {
                                if let Some(saved) = saved_polys.iter_mut().find(|p| p.id == poly.id.to_string()) {
                                    saved.position.x = poly.transform.position.x as i32;
                                    saved.position.y = poly.transform.position.y as i32;
                                    updated = true;
                                }
                            }
                        }
                    }
                    ObjectType::TextItem => {
                        if let Some(text) = state.stunts_textboxes.iter().find(|t| t.id == selected.object_id) {
                            if let Some(saved_texts) = &mut stunts_state.active_text_items {
                                if let Some(saved) = saved_texts.iter_mut().find(|t| t.id == text.id.to_string()) {
                                    saved.position.x = text.transform.position.x as i32;
                                    saved.position.y = text.transform.position.y as i32;
                                    updated = true;
                                }
                            }
                        }
                    }
                    ObjectType::ImageItem => {
                        if let Some(img) = state.stunts_images.iter().find(|i| i.id == selected.object_id.to_string()) {
                            if let Some(saved_imgs) = &mut stunts_state.active_image_items {
                                if let Some(saved) = saved_imgs.iter_mut().find(|i| i.id == img.id) {
                                    saved.position.x = img.transform.position.x as i32;
                                    saved.position.y = img.transform.position.y as i32;
                                    updated = true;
                                }
                            }
                        }
                    }
                    ObjectType::VideoItem => {
                        if let Some(vid) = state.stunts_videos.iter().find(|v| v.id == selected.object_id.to_string()) {
                            if let Some(saved_vids) = &mut stunts_state.active_video_items {
                                if let Some(saved) = saved_vids.iter_mut().find(|v| v.id == vid.id) {
                                    saved.position.x = vid.transform.position.x as i32;
                                    saved.position.y = vid.transform.position.y as i32;
                                    updated = true;
                                }
                            }
                        }
                    }
                }

                if updated {
                    if let Some(project_id) = &stunts_state.id {
                        if let Err(e) = utilities::update_project_state(project_id, stunts_state) {
                            println!("Failed to save stunts state: {}", e);
                        } else {
                            println!("Stunts state saved successfully after drag.");
                        }
                    }
                }
            }
        }
    }

    if let Some(currentPosition) = currentPosition {
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
                            if let Some(world_state) = state.world_state.as_mut() {
                                if let Some(project_id) = &world_state.id {
                                    let mut component_updated = false;
                                    if let Some(levels) = world_state.levels.as_mut() {
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
                                        if let Err(e) = utilities::update_project_state(project_id, world_state) {
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
                        // println!("Gizmo trying to move a house... (not implemented yet)");
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
        // println!("rotate cam");
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
    behavior_id: Option<String>
) {
    #[cfg(target_os = "windows")]
    let bytes = read_model(projectId, modelFilename).expect("Couldn't get model bytes");

    #[cfg(target_arch = "wasm32")]
    let bytes = read_model_wasm(projectId, modelFilename).await.expect("Couldn't get model bytes");

    state.add_model(device, queue, &modelComponentId, &bytes, isometry, scale, camera, false, script_state, None, behavior_id);
    state.add_collider(modelComponentId, ComponentKind::Model, None);
}

pub async fn handle_add_scattered_model(
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
    scatter_options: ScatterSettings
) {
    #[cfg(target_os = "windows")]
    let bytes = read_model(projectId, modelFilename).expect("Couldn't get model bytes");

    #[cfg(target_arch = "wasm32")]
    let bytes = read_model_wasm(projectId, modelFilename).await.expect("Couldn't get model bytes");

    let mut model = Model::from_glb(
        &modelComponentId,
        &bytes,
        device,
        queue,
        &state.model_bind_group_layout,
        &state.group_bind_group_layout,
        &state.regular_texture_render_mode_buffer,
        &state.color_render_mode_buffer,
        isometry,
        scale,
        camera,
        None
    );

    state.add_scattered_model(device, model, scatter_options);
    // state.add_collider(modelComponentId, ComponentKind::Model);
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
    npc_properties: &crate::helpers::saved_data::NPCProperties,
    behavior_id: Option<String>
) {
    #[cfg(target_os = "windows")]
    let bytes = read_model(projectId, modelFilename).expect("Couldn't get model bytes");

    #[cfg(target_arch = "wasm32")]
    let bytes = read_model_wasm(projectId, modelFilename).await.expect("Couldn't get model bytes");

    state.add_model(device, queue, &npcComponentId, &bytes, isometry, scale, camera, false, script_state, None, behavior_id.clone());

    state.add_collider(npcComponentId.clone(), ComponentKind::NPC, None);

    // Retrieve the rigid_body_handle after the collider has been added
    let npc_rigid_body_handle = state
        .models
        .iter()
        .find(|m| m.id == npcComponentId)
        .and_then(|m| m.meshes.get(0))
        .and_then(|mesh| mesh.rigid_body_handle)
        .expect("Couldn't retrieve rigid body handle for NPC after adding collider");

    let squad_id = npc_properties.squad_id.clone();

    let mut npc = NPC::new(
        device,
        queue,
        npcComponentId.clone(), 
        npcComponentId.clone(), 
        VisualType::Model, 
        Some(npc_rigid_body_handle), 
        npc_properties.behavior.clone(), 
        squad_id,
        None
    );
    npc.behavior_id = behavior_id;
    state.npcs.push(npc);
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
    behavior_id: Option<String>
) {
    #[cfg(target_os = "windows")]
    let bytes = read_model(projectId, modelFilename).expect("Couldn't get model bytes");

    #[cfg(target_arch = "wasm32")]
    let bytes = read_model_wasm(projectId, modelFilename).await.expect("Couldn't get model bytes");

    state.add_model(device, queue, &modelAssetId, &bytes, isometry, scale, camera, hide_in_world, script_state, None, behavior_id.clone());

    state.add_collider(modelAssetId.clone(), ComponentKind::Collectable, None);

    // Retrieve the rigid_body_handle after the collider has been added
    let npc_rigid_body_handle = state
        .models
        .iter()
        .find(|m| m.id == modelAssetId)
        .and_then(|m| m.meshes.get(0))
        .and_then(|mesh| mesh.rigid_body_handle)
        .expect("Couldn't retrieve rigid body handle for NPC after adding collider");

    let collectable_type = collectable_properties.collectable_type.as_ref().expect("Couldn't get collectable type");

    let mut collectable = Collectable::new(modelComponentId.clone(), modelAssetId.clone(), collectable_type.clone(), related_stat.clone(), npc_rigid_body_handle);
    collectable.behavior_id = behavior_id;
    state.collectables.push(collectable);
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
    state.add_collider(landscapeComponentId, ComponentKind::Landscape, None);

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
    // println!(
    //     "Adding texture and mask {:?} {:?}",
    //     texture_filename, mask_filename
    // );

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
    texture_data: TextureData,
    grass_properties: Option<ProceduralGrassProperties>
) {
    if let Some(landscape) = state.landscapes.iter_mut().find(|l| l.id == landscape_id) {
        // println!("Adding grass to landscape: {}", landscape.id);

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

        let mut grass = Grass::new(&device, &camera_bind_group_layout, landscape, None);

        if let Some(props) = grass_properties {
            grass.config.grid_size = props.grid_size;
            grass.config.render_distance = props.render_distance;
            grass.config.blade_density = props.blade_density as f32;
            // Note: wind settings are currently uniforms, will need to be passed during update_uniforms
            // storing them in grass struct might be needed if they aren't there already
        }

        state.grasses.push(grass);
        // println!("Added grass");
    } else {
        println!("Could not find landscape with id: {}", landscape_id);
    }
}

pub fn handle_add_water_plane(
    state: &mut RendererState,
    device: &wgpu::Device,
    camera_bind_group_layout: &wgpu::BindGroupLayout,
    texture_format: wgpu::TextureFormat,
    component_id: String,
    water_properties: Option<WaterConfig>,
    landscape_id: Option<String>
) {
    if let Some(config) = water_properties {
        if let Some(landscape_id) = landscape_id {
            if let Some(mut landscape_obj) = state.landscapes.iter_mut().find(|l| l.id == landscape_id) {
                // let config = WaterConfig::default();
                let water_plane = WaterPlane::new(device, camera_bind_group_layout, texture_format, landscape_obj, config);
                state.water_planes.push(water_plane);
            }
        }
    }
}

pub fn handle_add_trees(
    renderer_state: &mut RendererState,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    camera_bind_group_layout: &wgpu::BindGroupLayout,
    tree_properties: Option<ProceduralTreeProperties>,
    scatter_settings: Option<ScatterSettings>,
    position: [f32; 3]
) {
    if let Some(landscape) = renderer_state.landscapes.get_mut(0) {
        
        let config = tree_properties.unwrap_or(ProceduralTreeProperties {
            seed: 0,
            trunk_height: 3.5,
            trunk_radius: 0.25,
            branch_levels: 4,
            foliage_radius: 0.5,
        });

        let mut trees = ProceduralTrees::new(device, camera_bind_group_layout, landscape, config);

        let mut rng = if let Some(scatter) = &scatter_settings {
             StdRng::seed_from_u64(scatter.seed as u64)
        } else {
             StdRng::seed_from_u64(0)
        };
        
        let num_trees = if let Some(scatter) = &scatter_settings {
            (scatter.density * 100.0) as i32
        } else {
            50
        };

        let radius = if let Some(scatter) = &scatter_settings {
            scatter.radius
        } else {
            250.0
        };

        for _ in 0..num_trees {
            let x = rng.gen_range(-radius..radius) + position[0];
            let z = rng.gen_range(-radius..radius) + position[2];

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

pub fn handle_add_particle_system(
    state: &mut RendererState,
    device: &wgpu::Device,
    camera_bind_group_layout: &wgpu::BindGroupLayout,
    component_id: String,
    generic_properties: crate::helpers::saved_data::GenericProperties,
    properties: ProceduralParticleProperties
) {
    let uniforms = ParticleUniforms {
        position: [generic_properties.position[0], generic_properties.position[1], generic_properties.position[2], 0.0],
        target_position: [0.0; 4], // Optional target
        gravity: properties.gravity,
        start_color: properties.start_color,
        end_color: properties.end_color,
        time: 0.0,
        emission_rate: properties.emission_rate,
        life_time: properties.life_time,
        radius: properties.radius,
        initial_speed_min: properties.initial_speed_min,
        initial_speed_max: properties.initial_speed_max,
        size: properties.size,
        mode: properties.mode,
        _pad2: [0.0; 4],
    };

    let system = ParticleSystem::new(
        device,
        camera_bind_group_layout,
        uniforms,
        1000, // Max particles, could be configurable
        wgpu::TextureFormat::Rgba8Unorm, // Should match swapchain format or render target
    );

    state.particle_systems.push(system);
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

use crate::game_ui::dialogue_state::DialogueState;

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
        if let Some(rb) = renderer_state.rigid_body_set.get(*npc.rigid_body_handle.as_ref().expect("Couldnt get handle")) {
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

    // Check if NPC is dead for looting
    let mut loot_collected = false;
    if let Some(npc) = renderer_state.npcs.iter_mut().find(|n| n.id == target_id) {
        if npc.is_dead {
            if let Some(player) = &mut renderer_state.player_character {
                // Transfer all items from NPC inventory to player
                let items_to_transfer: Vec<_> = npc.inventory.items.drain(..).collect();
                if !items_to_transfer.is_empty() {
                    for item in items_to_transfer {
                        // println!("Looted item: {:?}", item.generic_properties.name);
                        player.inventory.add_item(&item);
                    }
                    loot_collected = true;
                } else {
                    println!("NPC has no loot.");
                }

                // Also transfer equipped items if any
                if let Some(weapon) = npc.inventory.equipped_weapon.take() {
                    // println!("Looted equipped weapon: {:?}", weapon.generic_properties.name);
                    player.inventory.add_item(&weapon);
                    loot_collected = true;
                }
                if let Some(armor) = npc.inventory.equipped_armor.take() {
                    // println!("Looted equipped armor: {:?}", armor.generic_properties.name);
                    player.inventory.add_item(&armor);
                    loot_collected = true;
                }
            }
            if loot_collected {
                // println!("Looted NPC {:?}.", target_id);
            }
            return; // Don't start dialogue with dead NPC
        }
    }

    // println!("Running interact... {:?}", target_id);
    
    let mut target_script_path = None;
    let mut target_npc_name = String::new();
    
    if let Some(world_state) = &state.world_state {
        if let Some(levels) = &world_state.levels {
             if let Some(level) = levels.get(0) {
                 if let Some(components) = &level.components {
                     for comp in components {
                         if let Some(kind) = &comp.kind {
                             if let ComponentKind::NPC = kind {
                                //  if let Some(props) = &comp.npc_properties {
                                     if comp.id == target_id {
                                         if let Some(script) = &comp.js_script_path {
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

    // println!("target_npc_name... {:?} {:?} {:?}", target_id, target_npc_name, target_script_path);
    
    if let Some(script) = target_script_path {
        state.dialogue_state.npc_name = target_npc_name;
        state.dialogue_state.current_npc_id = target_id.clone();
        
        if let Some(renderer_state) = state.renderer_state.as_mut() {
            if let Some(npc) = renderer_state.npcs.iter().find(|n| n.id == target_id) {
                if let Some(rb) = renderer_state.rigid_body_set.get(*npc.rigid_body_handle.as_ref().expect("Couldnt get handle")) {
                    let pos = rb.translation();
                    let wrapper = crate::deno::addon_engine::EntityWrapper {
                        id: npc.id.clone(),
                        position: [pos.x, pos.y, pos.z],
                        health: npc.stats.health,
                        stamina: npc.stats.stamina,
                        is_dead: npc.is_dead,
                    };
                    let dialogue_res = state.addon_engine.execute_behavior(renderer_state, &script, wrapper, "on_interact", Some(state.dialogue_state.current_node.clone()));
                    if let Some(d) = dialogue_res {
                        if d.is_open {
                            state.dialogue_state.is_open = true;
                            state.dialogue_state.current_text = d.text;
                            state.dialogue_state.options = d.options;
                            state.dialogue_state.current_node = d.current_node;
                            state.dialogue_state.ui_dirty = true;
                        }
                    }
                }
            }
        }
    }
}

fn handle_collectable_interaction(state: &mut Editor) {
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

    let mut pickup_id = None;
    let mut collectable_index = None;

    for (i, col) in renderer_state.collectables.iter().enumerate() {
        if let Some(rb) = renderer_state.rigid_body_set.get(col.rigid_body_handle) {
            let col_pos = rb.translation();
            let dist = (col_pos - player_pos).magnitude();
            if dist < 5.0 {
                pickup_id = Some(col.id.clone());
                collectable_index = Some(i);
                break;
            }
        }
    }

    if let (Some(id), Some(index)) = (pickup_id, collectable_index) {
        // println!("Picking up collectable: {:?}", id);
        
        // Find ComponentData in world_state
        let mut component_data = None;
        if let Some(world_state) = &state.world_state {
            if let Some(levels) = &world_state.levels {
                if let Some(level) = levels.get(0) {
                    if let Some(components) = &level.components {
                        if let Some(comp) = components.iter().find(|c| c.id == id) {
                            component_data = Some(comp.clone());
                        }
                    }
                }
            }
        }

        if let Some(comp) = component_data {
            if let Some(player) = &mut renderer_state.player_character {
                player.inventory.add_item(&comp);
                // println!("Added {:?} to inventory.", comp.generic_properties.name);
                
                // Remove from world
                let col = renderer_state.collectables.remove(index);
                
                // Remove physics
                // renderer_state.collider_set.remove(col.rigid_body_handle, &mut renderer_state.rigid_body_set, &mut renderer_state.island_manager, &mut renderer_state.impulse_joint_set, &mut renderer_state.multibody_joint_set, true);
                // Wait, collider_set.remove takes ColliderHandle. rigid_body_handle is RigidBodyHandle.
                
                // Remove rigidbody (and its colliders)
                renderer_state.rigid_body_set.remove(col.rigid_body_handle, &mut renderer_state.island_manager, &mut renderer_state.collider_set, &mut renderer_state.impulse_joint_set, &mut renderer_state.multibody_joint_set, true);

                // Remove model
                renderer_state.models.retain(|m| m.id != col.model_id);
            }
        }
    }
}

pub fn handle_gamepad_input(state: &mut Editor, left_stick: (f32, f32), right_stick: (f32, f32)) {
    // Push event to Addons
    {
        let mut op_state = state.addon_engine.runtime.op_state();
        let mut op_state = op_state.borrow_mut();
        if let Some(ctx) = op_state.try_borrow_mut::<crate::deno::addon_engine::AddonContext>() {
            ctx.input_events.push(crate::deno::addon_engine::InputEvent::GamepadAxis { 
                left_stick: [left_stick.0, left_stick.1], 
                right_stick: [right_stick.0, right_stick.1] 
            });
        }
    }

    let renderer_state = match state.renderer_state.as_mut() {
        Some(rs) => rs,
        None => return,
    };
    let camera = match state.camera.as_mut() {
        Some(c) => c,
        None => return,
    };
    let camera_binding = match state.camera_binding.as_mut() {
        Some(cb) => cb,
        None => return,
    };
    let gpu_resources = match state.gpu_resources.as_ref() {
        Some(gr) => gr,
        None => return,
    };

    let speed_multiplier = state.navigation_speed;
    let deadzone = 0.1;

    // --- Movement (Left Stick) ---
    let (lx, ly) = left_stick;
    let mut movement_direction = Vector3::zeros();

    if lx.abs() > deadzone || ly.abs() > deadzone {
        let forward = if renderer_state.game_mode {
            Vector3::new(camera.direction.x, 0.0, camera.direction.z).normalize()
        } else {
            camera.direction
        };
        
        let right = camera.direction.cross(&camera.up).normalize();
        let right_horizontal = if renderer_state.game_mode {
            Vector3::new(right.x, 0.0, right.z).normalize()
        } else {
            right
        };

        // Note: ly is usually positive up/forward. If gamepad returns positive up, we add forward.
        // If gamepad returns positive down, we subtract forward.
        // Usually Y is up on stick.
        movement_direction += forward * ly * speed_multiplier;
        movement_direction += right_horizontal * lx * speed_multiplier;
    }

    if movement_direction.magnitude() > 0.0 {
         if renderer_state.game_mode {
            renderer_state.apply_player_movement(movement_direction, 0.016);
        } else {
            // Free camera mode
             let diff = movement_direction * 0.5;
            camera.position += diff;
            camera.update();
            camera_binding.update_3d(&gpu_resources.queue, &camera);
        }
    }

    // --- Camera/Look (Right Stick) ---
    let (rx, ry) = right_stick;
    
    if renderer_state.game_mode {
        if rx.abs() > deadzone || ry.abs() > deadzone {
            // Feed input to renderer_state for step_physics_pipeline
            // Scale factor might need tuning to match mouse feel
            renderer_state.set_mouse_delta((rx as f64 * 15.0, -ry as f64 * 15.0));
        } else {
            // Reset delta to stop rotation when stick is released
            renderer_state.set_mouse_delta((0.0, 0.0));
        }
    } else {
        // Free Camera Mode - Direct Control
        if rx.abs() > deadzone || ry.abs() > deadzone {
            let sensitivity = 0.05;
            let look_dx = -rx * sensitivity; 
            let look_dy = ry * sensitivity;

            camera.rotate(look_dx, look_dy);
            camera.update();
            camera_binding.update_3d(&gpu_resources.queue, &camera);
        }
    }
}

pub fn handle_gamepad_button(state: &mut Editor, button: &str, pressed: bool) {
    // Push event to Addons
    {
        let mut op_state = state.addon_engine.runtime.op_state();
        let mut op_state = op_state.borrow_mut();
        if let Some(ctx) = op_state.try_borrow_mut::<crate::deno::addon_engine::AddonContext>() {
            ctx.input_events.push(crate::deno::addon_engine::InputEvent::GamepadButton { 
                button: button.to_string(), 
                pressed 
            });
        }
    }

    // Map gamepad buttons to existing key handlers
    match button {
        "South" => {
             // Context sensitive: Enter (Dialogue) vs Jump (Space)
             if state.dialogue_state.is_open {
                 handle_key_press(state, "Enter", pressed);
             } else {
                 handle_key_press(state, " ", pressed);
             }
        }, 
        "East" => handle_key_press(state, "c", pressed), // B -> Crouch
        "North" => handle_key_press(state, "i", pressed), // Y -> Inventory
        "West" => {
            handle_key_press(state, "e", pressed); // X -> Interact
            handle_key_press(state, "r", pressed); // X -> Reload
        },
        "DPadUp" => handle_key_press(state, "w", pressed),
        "DPadDown" => handle_key_press(state, "s", pressed),
        "DPadLeft" => handle_key_press(state, "a", pressed),
        "DPadRight" => handle_key_press(state, "d", pressed),
        "Start" => handle_key_press(state, "Escape", pressed), // Start -> Menu/Escape
        "LeftThumb" => handle_key_press(state, "Shift", pressed), // L3 -> Sprint
        "RightTrigger2" => {
            let element_state = if pressed { EntropyElementState::Pressed } else { EntropyElementState::Released };
            handle_mouse_input(state, EntropyMouseButton::Left, element_state);
        },
        "LeftTrigger2" => {
            let element_state = if pressed { EntropyElementState::Pressed } else { EntropyElementState::Released };
            handle_mouse_input(state, EntropyMouseButton::Right, element_state);
        },
        _ => {}
    }
}