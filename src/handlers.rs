use nalgebra::{Isometry3, Matrix3, Matrix4, Point3, Vector3};
use serde::{Deserialize, Serialize};
use tokio::spawn;
use wgpu::util::DeviceExt;

use bytemuck::{Pod, Zeroable};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::{cell::RefCell, collections::HashMap};

use crate::core::editor::Editor;
use crate::core::gpu_resources;
use crate::shape_primitives::Cube::Cube;
use crate::{
    kinematic_animations::skeleton::{AttachPoint, Joint, KinematicChain, PartConnection},
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

// pub fn get_camera() -> &'static mut SimpleCamera {
//     CAMERA_INIT.with(|init| {
//         if !init.get() {
//             unsafe {
//                 CAMERA = Some(SimpleCamera::new(
//                     Point3::new(0.0, 1.0, 5.0),
//                     Vector3::new(0.0, 0.0, -1.0),
//                     Vector3::new(0.0, 1.0, 0.0),
//                     45.0f32.to_radians(),
//                     0.1,
//                     100000.0,
//                     1024.0, 768.0
//                 ));
//             }
//             init.set(true);
//         }
//     });

//     unsafe { CAMERA.as_mut().unwrap() }
// }

pub fn handle_key_press(state: &mut Editor, key_code: &str, is_pressed: bool) {
    // let camera = get_camera();
    let camera = state.camera.as_mut().expect("Couldn't get camera");
    let camera_binding = state.camera_binding.as_mut().expect("Couldn't get camera binding");
    let gpu_resources = state.gpu_resources.as_ref().expect("Couldn't get gpu resources");
    // let mut state_guard = state.lock().unwrap();
    let speed_multiplier = state.navigation_speed;

    let mut diff = Vector3::identity();

    match key_code {
        "w" => {
            if is_pressed {
                // println!("w pressed");
                diff = camera.direction * 0.1;
                diff = diff * speed_multiplier;
                camera.position += diff;
            }
        }
        "s" => {
            if is_pressed {
                diff = camera.direction * 0.1;
                diff = diff * speed_multiplier;
                camera.position -= diff;
            }
        }
        "a" => {
            if is_pressed {
                let right = camera.direction.cross(&camera.up).normalize();
                diff = right * 0.1;
                diff = diff * speed_multiplier;
                camera.position -= diff;
            }
        }
        "d" => {
            if is_pressed {
                let right = camera.direction.cross(&camera.up).normalize();
                diff = right * 0.1;
                diff = diff * speed_multiplier;
                camera.position += diff;
            }
        }
        _ => {
            // Handle any other keys if necessary
        }
    }

    // // Calculate delta time
    // let now = std::time::Instant::now();
    // let dt = (now - state_guard.last_movement_time).as_secs_f32();
    // state_guard.last_movement_time = now;

    // // // Use dt to scale movement
    // let base_speed = 5.0; // units per second
    // let movement_delta = base_speed * dt; // This gives frame-rate independent movement
    // let desired_movement = camera.direction * movement_delta; // or use diff? I don't think this accounts for which key is pressed

    // state_guard.update_player_collider_position([
    //     camera.position.x,
    //     camera.position.y,
    //     camera.position.z,
    // ]);
    // state_guard.update_player_character_position(diff, 0.1);

    // drop(state_guard);

    camera.update();
    camera_binding.update_3d(&gpu_resources.queue, &camera);
}

// pub fn handle_key_press(state: Arc<Mutex<RendererState>>, key_code: &str, is_pressed: bool) {
//     println!("key press");
//     let mut camera = get_camera();
//     let mut state_guard = state.lock().unwrap();

//     // Calculate direction based on key
//     let movement_direction = if is_pressed {
//         match key_code {
//             "w" => Some(camera.direction),
//             "s" => Some(-camera.direction),
//             "a" => Some(-camera.direction.cross(&camera.up).normalize()),
//             "d" => Some(camera.direction.cross(&camera.up).normalize()),
//             _ => None,
//         }
//     } else {
//         None
//     };

//     // Calculate delta time
//     let now = std::time::Instant::now();
//     let dt = if state_guard.last_movement_time.is_some() {
//         (now - state_guard.last_movement_time.expect("Couldn't get time")).as_secs_f32()
//     } else {
//         0.0
//     };
//     state_guard.last_movement_time = Some(now);

//     // Apply movement if a key was pressed
//     if let Some(direction) = movement_direction {
//         let base_speed = 5.0; // units per second
//         let movement_delta = direction * base_speed * dt;
//         println!("continuing {:?}", movement_delta);
//         println!("Position before: {:?}", camera.position); // Debug log
//                                                             // Update camera position
//         camera.position = camera.position + movement_delta;

//         // Update physics
//         println!("physics {:?}", camera.position);
//         state_guard.update_player_rigidbody_position([
//             camera.position.x,
//             camera.position.y,
//             camera.position.z,
//         ]);
//         state_guard.update_player_character_position(movement_delta, dt);
//     }

//     camera.update();
// }

pub fn handle_mouse_move(dx: f32, dy: f32, state: &mut Editor) {
    let camera = state.camera.as_mut().expect("Couldn't get camera");
    let camera_binding = state.camera_binding.as_mut().expect("Couldn't get camera binding");
    let gpu_resources = state.gpu_resources.as_ref().expect("Couldn't get gpu resources");

    // let camera = get_camera();
    let sensitivity = 0.005;

    let dx = -dx * sensitivity;
    let dy = dy * sensitivity;

    // println!("cursor moved {:?} {:?}", dx, dy);

    camera.rotate(dx, dy);

    camera.update();
    camera_binding.update_3d(&gpu_resources.queue, &camera);
}

pub fn handle_add_model(
    state: Arc<Mutex<RendererState>>,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    projectId: String,
    landscapeAssetId: String,
    landscapeComponentId: String,
    modelFilename: String,
    isometry: Isometry3<f32>,
) {
    pause_rendering();

    // let state = get_renderer_state();

    // ideally would spawn because adding model could be expensive
    // not sure how to pass wgpu items across threads

    // spawn(async move {
    // let mut state_guard = get_renderer_state_write_lock();

    let mut state_guard = state.lock().unwrap();

    // let params = to_value(&ReadModelParams {
    //     projectId,
    //     modelFilename,
    // })
    // .unwrap();
    // // let bytes = crate::app::invoke("read_model", params).await;
    // let bytes = invoke("read_model", params).await;
    // let bytes = bytes
    //     .into_serde()
    //     .expect("Failed to transform byte string to value");

    let bytes = read_model(projectId, modelFilename).expect("Couldn't get model bytes");

    state_guard.add_model(device, queue, &landscapeComponentId, &bytes, isometry);

    drop(state_guard);

    resume_rendering();
    // });
}

#[derive(Serialize, Deserialize)]
pub struct LandscapeData {
    // pub width: usize,
    // pub height: usize,
    pub width: usize,
    pub height: usize,
    // pub data: Vec<u8>,
    pub pixel_data: Vec<Vec<PixelData>>,
}

#[derive(Serialize, Deserialize)]
pub struct PixelData {
    pub height_value: f32,
    pub position: [f32; 3],
    pub tex_coords: [f32; 2],
}

pub fn handle_add_landscape(
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
    // pause_rendering();

    // let mut state_guard = state.lock().unwrap();

    // let data = get_landscape_pixels(projectId, landscapeAssetId, landscapeFilename);

    // state_guard.add_landscape(device, queue, &landscapeComponentId, &data, position);

    state.add_terrain_manager(
        device,
        queue,
        projectId,
        landscapeAssetId,
        landscapeComponentId,
        landscapeFilename,
        position,
        camera
    );

    // drop(state_guard);

    // resume_rendering();
}

pub fn handle_add_skeleton_part(
    state: Arc<Mutex<RendererState>>,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    partComponentId: String,
    position: [f32; 3],
    joints: Vec<Joint>,
    k_chains: Vec<KinematicChain>,
    attach_points: Vec<AttachPoint>,
    joint_positions: &HashMap<String, Point3<f32>>,
    // joint_rotations: &HashMap<String, Vector3<f32>>,
    connection: Option<PartConnection>,
) {
    pause_rendering();

    let mut state_guard = state.lock().unwrap();

    state_guard.add_skeleton_part(
        device,
        queue,
        &partComponentId,
        position,
        joints,
        k_chains,
        attach_points,
        joint_positions,
        // joint_rotations,
        connection,
    );

    drop(state_guard);

    resume_rendering();
}

pub fn handle_add_landscape_texture(
    state: Arc<Mutex<RendererState>>,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    project_id: String,
    landscape_component_id: String,
    landscape_asset_id: String,
    texture_filename: String,
    texture_kind: String,
    mask_filename: String,
) {
    pause_rendering();

    println!(
        "Adding texture and mask {:?} {:?}",
        texture_filename, mask_filename
    );

    // let state = get_renderer_state();

    // Clone the values that need to be moved into the closure
    let landscape_component_id_clone = landscape_component_id.clone();
    let texture_kind_clone = texture_kind.clone();

    // spawn(async move {
    let mut state_guard = state.lock().unwrap();

    let texture = fetch_texture_data(
        project_id.clone(),
        landscape_asset_id.clone(),
        texture_filename,
        texture_kind.clone(),
    );
    let mask = fetch_mask_data(
        project_id.clone(),
        landscape_asset_id.clone(),
        mask_filename,
        texture_kind.clone(),
    );

    // if let Some(texture) = texture {
    let kind = match texture_kind_clone.as_str() {
        "Primary" => LandscapeTextureKinds::Primary,
        "Rockmap" => LandscapeTextureKinds::Rockmap,
        "Soil" => LandscapeTextureKinds::Soil,
        _ => {
            // web_sys::console::error_1(
            //     &format!("Invalid texture kind: {}", texture_kind_clone).into(),
            // );
            return;
        }
    };

    let maskKind = match texture_kind_clone.as_str() {
        "Primary" => LandscapeTextureKinds::PrimaryMask,
        "Rockmap" => LandscapeTextureKinds::RockmapMask,
        "Soil" => LandscapeTextureKinds::SoilMask,
        _ => {
            // web_sys::console::error_1(
            //     &format!("Invalid texture kind: {}", texture_kind_clone).into(),
            // );
            return;
        }
    };

    state_guard.update_landscape_texture(
        device,
        queue,
        landscape_component_id_clone,
        kind,
        texture,
        maskKind,
        mask,
    );

    // drop(state_guard);

    // resume_rendering();
    // });
}

#[derive(Deserialize)]
pub struct TextureData {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
}

pub fn fetch_texture_data(
    project_id: String,
    landscape_id: String,
    texture_filename: String,
    texture_kind: String,
) -> Texture {
    // let params = to_value(&GetTextureParams {
    //     projectId: project_id,
    //     landscapeId: landscape_id,
    //     textureFilename: texture_filename,
    //     textureKind: texture_kind,
    // })
    // .unwrap();
    // let js_data = invoke("read_landscape_texture", params).await;
    // let texture_data: TextureData = js_data
    //     .into_serde()
    //     .ok()
    //     .expect("Couldn't transform texture data serde");

    let texture_data =
        read_landscape_texture(project_id, landscape_id, texture_filename, texture_kind)
            .expect("Couldn't get texture data");

    // Some((texture_data.data, texture_data.width, texture_data.height))
    Texture::new(texture_data.bytes, texture_data.width, texture_data.height)
}

pub fn fetch_mask_data(
    project_id: String,
    landscape_id: String,
    mask_filename: String,
    mask_kind: String,
) -> Texture {
    // let params = to_value(&GetMaskParams {
    //     projectId: project_id,
    //     landscapeId: landscape_id,
    //     maskFilename: mask_filename,
    //     maskKind: mask_kind,
    // })
    // .unwrap();
    // let js_data = invoke("read_landscape_mask", params).await;
    let mask_data = read_landscape_mask(project_id, landscape_id, mask_filename, mask_kind)
        .expect("Couldn't get mask data");
    // let mask_data: TextureData = js_data
    //     .into_serde()
    //     .ok()
    //     .expect("Couldn't transform texture data serde");

    // Some((texture_data.data, texture_data.width, texture_data.height))
    Texture::new(mask_data.bytes, mask_data.width, mask_data.height)
}
