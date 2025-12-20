use nalgebra::{Isometry3, Matrix3, Matrix4, Point3, Vector3};
use mint::{Quaternion, Vector3 as MintVector3};
use serde::{Deserialize, Serialize};
use crate::procedural_models::House::HouseConfig;
// use tokio::spawn;
use transform_gizmo::math::Transform;
use transform_gizmo::{GizmoConfig, GizmoInteraction};
use wgpu::util::DeviceExt;

use bytemuck::{Pod, Zeroable};
// use winit::dpi::PhysicalPosition;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::{cell::RefCell, collections::HashMap};
use noise::{Fbm, NoiseFn, Perlin, Worley};
use noise::MultiFractal;

use crate::core::PlayerCharacter::{NPC, PlayerCharacter};
use crate::core::SimpleCamera::to_row_major_f64;
use crate::core::editor::{self, Editor};
use crate::core::gpu_resources;
use crate::helpers::landscapes::{TextureData, read_landscape_heightmap_as_texture};
use crate::helpers::saved_data::ComponentKind;
#[cfg(target_arch = "wasm32")]
use crate::helpers::wasm_loaders::{get_landscape_pixels_wasm, read_landscape_mask_wasm, read_landscape_texture_wasm, read_model_wasm};
use crate::procedural_trees::trees::{ProceduralTrees, TreeInstance};
use crate::shape_primitives::Cube::Cube;
use crate::procedural_grass::grass::{Grass};
use crate::water_plane::water::WaterPlane;
use crate::water_plane::config::WaterConfig;
use rand::{Rng, random};
use winit::event::{MouseButton, ElementState};
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
    camera: &SimpleCamera
) {
    // TODO: provide model info for Player model and isometry for player position
    let mut player_character = PlayerCharacter::new(
        &mut state.rigid_body_set,
        &mut state.collider_set,
        &device,
        &queue,
        &state.model_bind_group_layout,
        &state.group_bind_group_layout,
        &state.texture_render_mode_buffer,
        camera,
    );

    state.player_character = Some(player_character);
}

pub fn handle_key_press(state: &mut Editor, key_code: &str, is_pressed: bool) {
    let camera = state.camera.as_mut().expect("Couldn't get camera");
    let renderer_state = state.renderer_state.as_mut().expect("Couldn't get renderer state");
    let camera_binding = state.camera_binding.as_mut().expect("Couldn't get camera binding");
    let gpu_resources = state.gpu_resources.as_ref().expect("Couldn't get gpu resources");
    let speed_multiplier = state.navigation_speed;

    let mut movement_direction = Vector3::zeros();

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
            config.projection_matrix = to_row_major_f64(&camera.get_orthographic_projection());
            // config.projection_matrix = to_row_major_f64(&&camera.get_projection());
            renderer_state.gizmo.update_config(config);
        }
    }
}

pub fn handle_mouse_input(state: &mut Editor, button: MouseButton, element_state: ElementState) {
    let renderer_state = state.renderer_state.as_mut().expect("Couldn't get renderer state");

    if renderer_state.game_mode && element_state == ElementState::Pressed {
        match button {
            MouseButton::Left => {
                if let Some(player_character) = &mut renderer_state.player_character {
                    player_character.attack(
                        &renderer_state.rigid_body_set,
                        &renderer_state.collider_set,
                        &mut renderer_state.query_pipeline,
                        &mut renderer_state.npcs,
                    );
                    println!("Left mouse button pressed - Player Attack!");
                }
            }
            MouseButton::Right => {
                if let Some(player_character) = &mut renderer_state.player_character {
                    player_character.defend();
                    println!("Right mouse button pressed - Player Defend!");
                }
            }
            _ => {}
        }
    }
}


pub fn handle_mouse_move(mousePressed: bool, currentPosition: EntropyPosition, lastPosition: Option<EntropyPosition>, state: &mut Editor) {
    let renderer_state = state.renderer_state.as_mut().expect("Couldn't get renderer state");

    if let Some(player_character) = &renderer_state.player_character {

        let test_sphere = player_character.sphere.as_ref().expect("Couldn't get sphere");

        let mut transforms = vec![
            Transform::from_scale_rotation_translation(
                MintVector3::from([test_sphere.transform.scale.x as f64, test_sphere.transform.scale.y as f64, test_sphere.transform.scale.z as f64]), 
                Quaternion::from([test_sphere.transform.rotation.quaternion().coords.x as f64, test_sphere.transform.rotation.quaternion().coords.y as f64, test_sphere.transform.rotation.quaternion().coords.z as f64, test_sphere.transform.rotation.quaternion().coords.w as f64]),
                MintVector3::from([test_sphere.transform.position.x as f64, test_sphere.transform.position.y as f64, test_sphere.transform.position.z as f64])
            )
        ];

        let interaction = GizmoInteraction {
            cursor_pos: (currentPosition.x as f32, currentPosition.y as f32),
            ..Default::default()
            // hovered,
            // drag_started,
            // dragging: mousePressed
        };
        
        //  println!("mouse move");

        if let Some((_result, new_transforms)) = renderer_state.gizmo.update(interaction, &transforms) {
            // println!("subgizmo dragged");

            for (new_transform, transform) in
            // Update transforms
            new_transforms.iter().zip(&mut transforms)
            {    
                *transform = *new_transform;
                
            }
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
        camera.rotate(dx, dy);
    }

    camera.update();
    camera_binding.update_3d(&gpu_resources.queue, &camera);

    let mut config = renderer_state.gizmo.config().clone();
    config.view_matrix = to_row_major_f64(&camera.get_view());
    config.projection_matrix = to_row_major_f64(&camera.get_orthographic_projection());
    // config.projection_matrix = to_row_major_f64(&&camera.get_projection());
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
    camera: &SimpleCamera
) {
    #[cfg(target_os = "windows")]
    let bytes = read_model(projectId, modelFilename).expect("Couldn't get model bytes");

    #[cfg(target_arch = "wasm32")]
    let bytes = read_model_wasm(projectId, modelFilename).await.expect("Couldn't get model bytes");

    state.add_model(device, queue, &modelComponentId, &bytes, isometry, scale, camera);
    state.add_collider(modelComponentId, ComponentKind::Model);
}

pub async fn handle_add_npc(
    state: &mut RendererState,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    projectId: String,
    modelAssetId: String, // model is added to stored library as an asset
    modelComponentId: String, // model is added from library to scene as an active component
    modelFilename: String,
    isometry: Isometry3<f32>,
    scale: Vector3<f32>,
    camera: &SimpleCamera
) {
    #[cfg(target_os = "windows")]
    let bytes = read_model(projectId, modelFilename).expect("Couldn't get model bytes");

    #[cfg(target_arch = "wasm32")]
    let bytes = read_model_wasm(projectId, modelFilename).await.expect("Couldn't get model bytes");

    state.add_model(device, queue, &modelComponentId, &bytes, isometry, scale, camera);

    state.add_collider(modelComponentId.clone(), ComponentKind::NPC);

    // Retrieve the rigid_body_handle after the collider has been added
    let npc_rigid_body_handle = state
        .models
        .iter()
        .find(|m| m.id == modelComponentId)
        .and_then(|m| m.meshes.get(0))
        .and_then(|mesh| mesh.rigid_body_handle)
        .expect("Couldn't retrieve rigid body handle for NPC after adding collider");

    state.npcs.push(NPC::new(modelComponentId.clone(), npc_rigid_body_handle));
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