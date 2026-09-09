mod input;
mod physics;
mod spawn;
mod terrain;
mod visuals;

use gltf::json::camera;
use mint::ColumnMatrix4;
use nalgebra::{Isometry3, Matrix4, Point3, UnitQuaternion, Vector3};
use rapier3d::math::Point as RapierPoint;
use rapier3d::prelude::*;
use rapier3d::prelude::{ColliderSet, QueryPipeline, RigidBodySet};
use transform_gizmo::config::TransformPivotPoint;
use uuid::Uuid;
use wgpu::{BindGroupLayout, TextureView};

use crate::art_assets::ScatteredModel::ScatteredModel;
use crate::core::AnimationState::AnimationState;
use crate::core::Transform_2::{Transform, matrix4_to_raw_array};
use crate::core::animation_system;
use crate::core::SimpleCamera::to_row_major_f64;
use crate::core::camera::CameraBinding;
use crate::core::editor::{PointLight, PointLightsUniform, Viewport, WindowSize};
use crate::deno::addon_ops::VisualConfig;
use crate::game_behaviors::stateful::BehaviorState;
use crate::handlers::EntropyPosition;
use crate::heightfield_landscapes::QuadScape::QuadScape;
use crate::helpers::saved_data::{GameSettings, PhysicsConfig, ScatterSettings, VisualType};
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
    heightfield_landscapes::Landscape3D::Landscape3D,
    art_assets::Model::Model,
    shape_primitives::{Cube::Cube, Pyramid::Pyramid},
    procedural_grass::grass::Grass,
    procedural_particles::particle_system::ParticleSystem,
    procedural_trees::trees::ProceduralTrees,
    water_plane::water::WaterPlane,
    core::custom_mesh::CustomMesh,
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

pub struct RendererState {
    pub cubes: Vec<Cube>,
    pub addon_cubes: HashMap<String, Vec<Cube>>,
    pub addon_meshes: HashMap<String, Vec<CustomMesh>>,
    pub spheres: Vec<Sphere>,
    pub debug_rays: Vec<DebugRay>,
    pub pyramids: Vec<Pyramid>,
    pub grids: Vec<Grid>,
    pub models: Vec<Model>, // must add a Model in order to add an NPC
    pub addon_models: HashMap<String, Vec<Model>>,
    pub procedural_houses: Vec<House>,
    pub scattered_models: Vec<crate::art_assets::ScatteredModel::ScatteredModel>,
    pub landscapes: Vec<Landscape>,
    pub addon_landscapes: HashMap<String, Vec<Landscape>>,
    pub addon_landscape3ds: HashMap<String, Vec<Landscape3D>>,
    pub addon_quadscapes: HashMap<String, Vec<QuadScape>>,
    pub grasses: Vec<Grass>,
    pub addon_grasses: HashMap<String, Vec<Grass>>,
    pub addon_point_lights: HashMap<String, Vec<(String, PointLight)>>, // (light_id, light) - keyed by id so re-rendering a light (e.g. a live UI preview) updates it in place instead of leaking a new entry every call
    pub particle_systems: Vec<ParticleSystem>,
    pub procedural_trees: Vec<ProceduralTrees>,
    pub water_planes: Vec<WaterPlane>,
    pub point_lights: Vec<PointLight>,

    // wgpu
    pub model_bind_group_layout: Arc<wgpu::BindGroupLayout>,
    pub group_bind_group_layout: Arc<wgpu::BindGroupLayout>,
    pub ui_model_bind_group_layout: Arc<wgpu::BindGroupLayout>,
    pub texture_render_mode_buffer: Arc<wgpu::Buffer>,
    pub regular_texture_render_mode_buffer: Arc<wgpu::Buffer>,
    pub color_render_mode_buffer: Arc<wgpu::Buffer>,
    pub gpu_resources: Option<Arc<crate::core::gpu_resources::GpuResources>>,
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

    pub mouse_state: MouseState,
    pub last_ray: Option<Ray>,
    pub ray_intersecting: bool,
    pub ray_intersection: Option<RapierPoint<f32>>,
    pub ray_component_id: Option<Uuid>,

    pub last_movement_time: Option<Instant>,
    pub last_frame_time: Option<Instant>,

    pub current_mouse_position: Option<EntropyPosition>,
    pub last_mouse_position: Option<EntropyPosition>,
    // current/last_mouse_position both get force-cleared to None by
    // step_physics_pipeline's 100ms staleness timeout below, which drops
    // handlers.rs's MouseDown push (it's gated on current_mouse_position
    // being Some) for any click preceded by so much as a brief pause to aim -
    // an extremely common real interaction, not just a synthetic-input edge
    // case. This mirrors set_mouse_position's writes but is never cleared, so
    // MouseDown always has a position to report.
    pub last_known_mouse_position: Option<EntropyPosition>,
    pub last_mouse_delta: (f32, f32),

    pub shift_active: bool,
    pub ctrl_active: bool,
    pub alt_active: bool,

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
    pub pending_loot_drops: Vec<(Vector3<f32>, ComponentData)>,
}

impl RendererState {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        model_bind_group_layout: Arc<wgpu::BindGroupLayout>,
        group_bind_group_layout: Arc<wgpu::BindGroupLayout>,
        ui_model_bind_group_layout: Arc<wgpu::BindGroupLayout>,
        camera: &SimpleCamera,
        texture_render_mode_buffer: Arc<wgpu::Buffer>,
        color_render_mode_buffer: Arc<wgpu::Buffer>,
        regular_texture_render_mode_buffer: Arc<wgpu::Buffer>,
        game_mode: bool,
        skinned_pipeline: SkinnedPipeline,
    ) -> Self {
        // create the utility grid(s)
        let mut grids = Vec::new();

        let mut cubes = Vec::new();
        let mut spheres = Vec::new();

        let mut pyramids = Vec::new();

        let mut models = Vec::new();
        let mut procedural_houses = Vec::new();

        let mut landscapes = Vec::new();
        let mut grasses = Vec::new();
        let mut particle_systems = Vec::new();
        let mut water_planes = Vec::new();
        let mut procedural_trees = Vec::new();

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
            ..Default::default()
        });

        Self {
            cubes,
            addon_cubes: HashMap::new(),
            addon_meshes: HashMap::new(),
            spheres,
            debug_rays: Vec::new(),
            pyramids,
            grids,
            models,
            addon_models: HashMap::new(),
            scattered_models: Vec::new(),
            procedural_houses,
            landscapes,
            addon_landscapes: HashMap::new(),
            addon_landscape3ds: HashMap::new(),
            addon_quadscapes: HashMap::new(),
            grasses,
            addon_grasses: HashMap::new(),
            addon_point_lights: HashMap::new(),
            particle_systems,
            water_planes,
            procedural_trees,
            point_lights: Vec::new(),
            collectables: Vec::new(),

            model_bind_group_layout,
            group_bind_group_layout,
            regular_texture_render_mode_buffer,
            texture_render_mode_buffer,
            color_render_mode_buffer,
            gpu_resources: None,
            skinned_pipeline: Some(skinned_pipeline),
            scattered_model_pipeline: None,

            project_selected: None,
            current_view: "welcome".to_string(),
            object_selected: None,
            object_selected_kind: None,
            object_selected_data: None,
            selected_entity_id: None,
            selected_component_id: None,

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
            last_movement_time: None,
            last_frame_time: None,
            current_mouse_position: None,
            last_mouse_position: None,
            last_known_mouse_position: None,
            npcs: Vec::new(),
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
            last_mouse_delta: (0.0, 0.0),
            shift_active: false,
            ctrl_active: false,
            alt_active: false,
            ui_model_bind_group_layout,
            pending_loot_drops: Vec::new(),
        }
    }
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

pub fn find_model_mut<'a>(models: &'a mut Vec<Model>, addon_models: &'a mut HashMap<String, Vec<Model>>, id: &str) -> Option<&'a mut Model> {
    if let Some(model) = models.iter_mut().find(|m| m.id == id) {
        return Some(model);
    }
    for models in addon_models.values_mut() {
        if let Some(model) = models.iter_mut().find(|m| m.id == id) {
            return Some(model);
        }
    }
    None
}
