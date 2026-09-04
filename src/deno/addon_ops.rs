use deno_core::{
    error::AnyError,
    op2,
    extension,
    JsRuntime,
    RuntimeOptions,
    serde_v8,
    v8,
    OpState,
    Extension,
    ModuleSpecifier,
    ascii_str,
    FsModuleLoader,
    ModuleId,
};
use mint::ColumnMatrix4;
use nalgebra::{Isometry3, Matrix4, Translation3, UnitQuaternion, Vector3};
use rapier3d::prelude::{ColliderBuilder, LockedAxes, RigidBodyBuilder};
use uuid::Uuid;
use std::rc::Rc;
use std::cell::RefCell;
use std::path::Path;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use crate::art_assets::Model::read_model;
use crate::core::Texture::Texture;
use crate::core::camera::CameraBinding;
use crate::core::editor::{Editor, Point};
use crate::core::gpu_resources::GpuResources;
use crate::core::addon_pipeline::{GBUFFER_FORMATS, create_addon_pipeline};
use crate::deno::addon_engine::AddonEngine;
use crate::game_behaviors::stateful::BehaviorConfig;
use crate::heightfield_landscapes::QuadScape::QuadScape;
use crate::heightfield_landscapes::QuadTree::Terrain;
use crate::helpers::saved_data::{ComponentKind, LandscapeTextureKinds, NPCProperties, PhysicsConfig, VisualType};
use crate::model_components::NPC::NPC;
use crate::procedural_grass::grass::Grass;
use crate::renderer_text::fonts::FontManager;
use crate::yumon::system::Action;
use wgpu::{RenderPipeline, TextureView};
use crate::shape_primitives::Cube::Cube;
use crate::core::RendererState::RendererState;
use crate::core::SimpleCamera::SimpleCamera;
use crate::core::custom_mesh::CustomMesh;
use crate::shape_primitives::polygon::{Polygon, Stroke};
use crate::renderer_text::text_due::{TextRenderer, TextRendererConfig};
use crate::audio::AudioEngine;
use crate::helpers::utilities::get_project_dir;
use crate::yumon::legacy::{OrganismSim, MyBackend};
use crate::egui;
use wgpu::util::DeviceExt;
use crate::egui_wgpu;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct YumonState {
    pub pos: f32,
    pub battery: f32,
    pub health: f32,
    pub stamina: f32,
    pub boredom: f32,
    pub storage: f32,
    pub last_action: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct YumonBrainState {
    pub archetype: String,
    pub training_mode: String,
    pub state: String,
    pub total_moments: u64,
    pub last_reward: f32,
    pub last_loss: Option<f32>,
    pub last_action: String,
    pub last_rotation: f32,
    pub sleep_count: u32,
    pub is_training: bool,
    pub training_epoch: usize,
    pub total_training_epochs: usize,
    pub training_loss: f32,
}

#[derive(Debug, Clone, Copy)]
pub struct YumonActionState {
    pub action: crate::yumon::system::Action,
    pub absolute_rotation: f32,
    pub last_infer_time: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AddonMetadata {
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: Vec<String>,
    pub capabilities: HashMap<String, bool>,
    pub is_atom: Option<bool>,
    #[serde(default)]
    pub category: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BindGroupLayoutEntryDef {
    pub binding: u32,
    pub visibility: Vec<String>, // ["Vertex", "Fragment"]
    pub resource_type: String, // "Uniform", "Texture", "Sampler"
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BindGroupDef {
    pub entries: Vec<BindGroupLayoutEntryDef>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]

#[serde(rename_all = "camelCase")]

pub struct PipelineConfig {

    pub name: String,

    pub vertex_shader: Option<String>,

    pub fragment_shader: Option<String>,

    pub use_default: Option<bool>,

    pub pbr: Option<bool>,

    pub lighting_shader: Option<String>,

    pub layout: Option<String>, // e.g. "hair"
    
    pub extra_bind_groups: Option<Vec<BindGroupDef>>,

    pub lighting_bindings: Option<Vec<BindingConfig>>,

    pub form: Option<String>,

}



#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MeshConfig {
    pub id: Option<String>,
    pub position: [f32; 3],
    pub rotation: Option<[f32; 3]>,
    pub scale: Option<[f32; 3]>,
    pub vertex_data: Vec<f32>,
    pub index_data: Vec<u32>,
    pub pipeline_id: String,
    pub render_role: Option<String>,
    pub instance_count: Option<u32>,
    pub bindings: Option<Vec<BindingConfig>>,
    pub physics: Option<PhysicsConfig>,
    pub behavior_id: Option<String>,
    pub yumon_id: Option<String>,
    pub is_npc: Option<bool>,
    pub player: Option<crate::helpers::saved_data::PlayerProperties>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BindingConfig {
    pub group: u32,
    pub binding: u32,
    pub resource: ResourceType,
}


#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", content = "value")]
pub enum ResourceType {
    Uniform { data: Vec<f32> },
    Texture { id: Option<String> }, // "Landscape" is special
    Sampler,
    Time, // Smart default for time buffer
    Buffer { id: String },
    Storage { id: String },
    StorageTexture { id: String },
    StorageTextureRgba16 { id: String },
    TextureNonFilterable { id: String },
    DepthTexture,
}



#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CubeConfig {
    pub position: [f32; 3],
    pub scale: [f32; 3],
    pub pipeline_id: Option<String>,
    pub render_role: Option<String>,
}



#[derive(Serialize, Deserialize, Debug, Clone)]

#[serde(rename_all = "camelCase")]

pub struct UiWindowConfig {

    pub title: String,

    pub resizable: bool,

    pub default_size: UiSize,

}



#[derive(Serialize, Deserialize, Debug, Clone)]

#[serde(rename_all = "camelCase")]

pub struct UiTabConfig {

    pub title: String,

}



#[derive(Serialize, Deserialize, Debug, Clone)]

pub struct UiSize {

    pub width: f32,

    pub height: f32,

}



#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MiniMapMarker {
    pub position: [f32; 2], // 0-1 range
    pub color: Option<[f32; 4]>,
    pub label: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MiniMapPolyline {
    pub points: Vec<[f32; 2]>, // 0-1 range
    pub color: Option<[f32; 4]>,
    pub width: Option<f32>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PianoRollCell {
    pub row: u32,
    pub step: u32,
    pub length: u32,
    pub velocity: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum UiWidget {
    Label { text: String, bold: Option<bool> },
    Button { text: String, id: String, label: String },
    ColorInput { id: String, label: String, color: [f32; 4] },
    Slider { id: String, label: String, value: f32, min: f32, max: f32 },
    NumericInput { id: String, label: String, value: f32 },
    Dropdown { id: String, label: String, options: Vec<String>, selected_index: usize },
    Checkbox { id: String, label: String, value: bool },
    CodeEditor { id: String, label: String, content: String, language: String },
    MiniMap { 
        id: String, 
        landscape_id: Option<String>, 
        brush_size: f32, 
        markers: Vec<MiniMapMarker>,
        polylines: Option<Vec<MiniMapPolyline>>,
    },
    Snarl {
        id: String,
        graph: BehaviorGraph,
    },
    PianoRoll {
        id: String,
        rows: u32,
        steps: u32,
        steps_per_beat: u32,
        row_labels: Option<Vec<String>>,
        cells: Vec<PianoRollCell>,
        playhead: f32,
    },
    CollapsingHeader { title: String, id: String },
    EndCollapsingHeader,
    StartHorizontal,
    EndHorizontal,
    Separator,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorGraph {
    pub nodes: Vec<BehaviorNode>,
    pub connections: Vec<BehaviorConnection>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorNode {
    pub id: String,
    pub name: String,
    pub node_type: String,
    pub position: [f32; 2],
    pub inputs: Vec<BehaviorPin>,
    pub outputs: Vec<BehaviorPin>,
    pub properties: serde_json::Value,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorPin {
    pub id: String,
    pub name: String,
    pub pin_type: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorConnection {
    pub from_node: String,
    pub from_pin: String,
    pub to_node: String,
    pub to_pin: String,
}

pub struct NpcMotionState {
    pub entity_id:      String,
    pub current_move:   f32,   // -1.0, 0.0, or 1.0
    pub current_yaw:    f32,
    pub pending_actions: Vec<PendingAction>,
}

pub struct PendingAction {
    pub entity_id:  String,
    pub action:     Action,
    pub origin:     [f32; 3],
    pub direction:  [f32; 3],
}

use crate::heightfield_landscapes::Landscape::Landscape;
use crate::heightfield_landscapes::Landscape3D::Landscape3D;
use crate::core::vertex::Vertex;

use crate::helpers::landscapes::{self, LandscapePixelData, read_landscape_heightmap_as_texture};



use noise::{NoiseFn, Fbm, Perlin, MultiFractal};



#[derive(Serialize, Deserialize, Debug, Clone)]

#[serde(rename_all = "camelCase")]

pub struct NoiseConfig {

    pub noise_type: String, // e.g. "fbm"

    pub source: String,     // e.g. "perlin"

    pub seed: u32,

    pub octaves: usize,

    pub frequency: f64,

    pub persistence: f64,

    pub lacunarity: f64,

}



#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LandscapeConfig {
    pub id: Option<String>,
    pub scale: usize, // scale (y)
    pub size: usize, // actual size
    pub width: usize, // resolution (x)
    pub height: usize, // resolution (z)
    pub heights: Option<Vec<f32>>, // raw unscaled heights (y)
    pub noise_id: Option<String>,
    pub position: [f32; 3],
    pub pipeline_id: Option<String>,
    pub render_role: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Landscape3DConfig {
    pub id: Option<String>,
    pub vertices: Vec<f32>, // Flat array of Vertex data (pos, normal, uv, color)
    pub indices: Vec<u32>,
    pub position: [f32; 3],
    pub pipeline_id: Option<String>,
    pub render_role: Option<String>,
}


#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AddonGrassConfig {
    pub id: Option<String>,
    pub grid_size: Option<f32>,
    pub render_distance: Option<f32>,
    pub wind_strength: Option<f32>,
    pub wind_speed: Option<f32>,
    pub blade_height: Option<f32>,
    pub blade_width: Option<f32>,
    pub brownian_strength: Option<f32>,
    pub blade_density: Option<f32>,
    pub landscape_size: Option<f32>,
    pub landscape_height: Option<f32>,
    pub landscape_y_offset: Option<f32>,
    pub base_color: Option<[f32; 4]>,
    pub tip_color: Option<[f32; 4]>,
    pub pipeline_id: Option<String>,
    pub render_role: Option<String>,
    pub bindings: Option<Vec<BindingConfig>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PointLightConfig {
    pub position: [f32; 3],
    pub color: [f32; 3],
    pub intensity: f32,
    pub max_distance: f32,
}


#[derive(Clone, PartialEq, Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProceduralSkyConfigCC {
    pub horizon_color: [f32; 3],
    pub zenith_color: [f32; 3],
    pub sun_direction: [f32; 3], // Normalized direction vector
    pub sun_color: [f32; 3],
    pub sun_intensity: f32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SynthConfig {
    pub freq: f64,
    pub waveform: String,
    pub duration: f64,
    pub cutoff: f64,
    pub gain: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteConfig {
    pub freq: f64,
    pub waveform: String,
    pub duration: f64,
    pub cutoff: f64,
    pub resonance: f64,
    pub gain: f64,
    pub attack: f64,
    pub decay: f64,
    pub sustain: f64,
    pub release: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub id: Option<String>,
    pub path: Option<String>,
    pub visual_type: Option<crate::helpers::saved_data::VisualType>,
    pub position: [f32; 3],
    pub rotation: Option<[f32; 3]>,
    pub scale: Option<[f32; 3]>,
    pub pipeline_id: Option<String>,
    pub render_role: Option<String>,
    pub physics: Option<PhysicsConfig>,
    pub player: Option<crate::helpers::saved_data::PlayerProperties>,
    pub is_npc: Option<bool>,
    pub npc: Option<crate::helpers::saved_data::NPCProperties>,
    pub behavior_id: Option<String>,
    pub yumon_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VisualConfig {
    pub id: Option<String>,
    pub visual_name: String,
    pub template_id: String, // meshId or modelId
    pub position: [f32; 3],
    pub rotation: Option<[f32; 3]>,
    pub scale: Option<[f32; 3]>,
    pub pipeline_id: Option<String>,
    pub render_role: Option<String>,
    pub physics: Option<PhysicsConfig>,
    pub player: Option<crate::helpers::saved_data::PlayerProperties>,
    pub is_npc: Option<bool>,
    pub behavior_id: Option<String>,
    pub yumon_id: Option<String>,
}

#[op2]
pub fn op_visual_load(state: &mut OpState, #[string] addon_name: String, #[serde] config: VisualConfig) {
    if !AddonEngine::is_render_allowed(&addon_name) { return; }
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_visuals.push((addon_name, config));
    }
}

#[derive(Clone)]
pub struct BehaviorHooks {
    pub on_update: Option<v8::Global<v8::Function>>,
    pub on_interact: Option<v8::Global<v8::Function>>,
    pub on_attack: Option<v8::Global<v8::Function>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DialogueWrapper {
    pub text: String,
    pub options: Vec<crate::game_ui::dialogue_state::DialogueOption>,
    pub changed: bool,
    pub is_open: bool,
    pub npc_name: String,
    pub current_node: String,
    pub started_quest: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ScriptParticleConfig {
    pub emission_rate: f32,
    pub life_time: f32,
    pub radius: f32,
    pub gravity: [f32; 3],
    pub initial_speed_min: f32,
    pub initial_speed_max: f32,
    pub start_color: [f32; 4],
    pub end_color: [f32; 4],
    pub size: f32,
    pub mode: f32,
    pub position: [f32; 3],
}

pub struct EngineContext {
    pub particle_spawns: Vec<ScriptParticleConfig>,
    pub dialogue_wrapper: Option<DialogueWrapper>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UiRectConfig {
    pub position: [f32; 2],
    pub size: [f32; 2],
    pub color: [f32; 4],
    pub stroke_thickness: f32,
    pub stroke_color: [f32; 4],
    pub layer: i32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UiTextConfig {
    pub text: String,
    pub font_family: String,
    pub font_size: u32,
    pub position: [f32; 2],
    pub dimensions: [f32; 2],
    pub color: [f32; 4],
    pub background_fill: [f32; 4],
    pub layer: i32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BoneTransformConfig {
    pub model_id: String,
    pub bone_name: String,
    pub position: Option<[f32; 3]>,
    pub rotation: Option<[f32; 4]>, // Quaternion [x, y, z, w]
    pub scale: Option<[f32; 3]>,
}

// `BehaviorNodeState`/`BehaviorViewer`/the egui-snarl `SnarlViewer` impl that used to live
// here were removed along with `egui-snarl`: the node-graph editor is now a read-only
// fallback view (`entropy_gui::widgets_node_graph::node_graph_view`, driven directly from
// `BehaviorGraph` in `addon_engine.rs`) rather than a real pin-dragging editor — see the
// entropy_gui migration plan's decision on deferred widgets. This is an accepted, documented
// product regression (addons can no longer let users draw new connections via this UI) until
// a real graph editor is built as a follow-up.

pub struct AddonContext {
    pub registered_addons: Vec<(String, AddonMetadata)>,
    pub behaviors: HashMap<String, BehaviorHooks>,
    pub npc_motion_states: HashMap<String, NpcMotionState>,
    pub on_action_callbacks: Vec<(String, v8::Global<v8::Function>)>,
    pub gpu_resources: Option<Arc<GpuResources>>,
    pub audio_engine: Arc<AudioEngine>,
    pub pipelines: HashMap<String, Arc<RenderPipeline>>,
    pub compute_pipelines: HashMap<String, Arc<wgpu::ComputePipeline>>,
    pub pipeline_configs: HashMap<String, PipelineConfig>,
    pub lighting_pipelines: HashMap<String, Arc<RenderPipeline>>,
    pub lighting_bind_groups: HashMap<String, Vec<wgpu::BindGroup>>,
    pub bind_group_layouts: Vec<Arc<wgpu::BindGroupLayout>>, // 0: model, 1: group, 2: camera
    pub lighting_bind_group_layouts: Vec<Arc<wgpu::BindGroupLayout>>,
    pub surface_format: Option<wgpu::TextureFormat>,
    pub grass_uniform_layout: Option<Arc<wgpu::BindGroupLayout>>,
    pub landscape_particle_layout: Option<Arc<wgpu::BindGroupLayout>>,
    pub composite_layout: Option<Arc<wgpu::BindGroupLayout>>,
    pub skinned_layout: Option<Arc<wgpu::BindGroupLayout>>,
    pub pending_cubes: Vec<(String, CubeConfig)>, // (addon_name, config)
    pub pending_models: Vec<(String, ModelConfig)>, // (addon_name, config)
    pub pending_visuals: Vec<(String, VisualConfig)>, // (addon_name, config)
    pub pending_meshes: Vec<(String, MeshConfig)>, // (addon_name, config)
    pub pending_clears: Vec<String>, // addon_names to clear meshes for
    pub pending_mesh_clears: Vec<(String, String)>, // (addon_name, mesh_id)
    pub pending_landscapes: Vec<(String, LandscapeConfig)>, // (addon_name, config)
    pub pending_quadscapes: Vec<(String, LandscapeConfig)>, // (addon_name, config)
    pub pending_landscape3ds: Vec<(String, Landscape3DConfig)>, // (addon_name, config)
    pub pending_grasses: Vec<(String, AddonGrassConfig)>, // (addon_name, config)
    pub pending_point_lights: Vec<(String, PointLightConfig)>,
    pub pending_composites: Vec<(String, CompositeConfig)>,
    pub pending_mesh_updates: Vec<(String, Vec<u32>, Vec<f32>)>, // (mesh_id, indices, positions)
    pub pending_sun_config: Option<ProceduralSkyConfigCC>,
    pub pending_game_mode: Option<bool>,
    pub pending_entity_impulses: Vec<(String, [f32; 3])>,
    pub pending_entity_velocities: Vec<(String, [f32; 3])>,
    pub pending_entity_xz_velocities: Vec<(String, [f32; 2])>,
    pub pending_entity_rotations: Vec<(String, [f32; 3])>,
    pub pending_animation_plays: Vec<(String, String)>,
    pub pending_stat_updates: Vec<(String, crate::helpers::saved_data::CharacterStats)>,
    pub pending_bone_transforms: Vec<BoneTransformConfig>,
    pub pending_ui_rects: Vec<(String, UiRectConfig)>,
    pub pending_ui_texts: Vec<(String, UiTextConfig)>,
    pub pending_ui_clear: bool,
    pub active_gizmo: Option<GizmoState>,
    pub noise_generators: HashMap<String, NoiseConfig>,
    pub on_init_callbacks: Vec<(String, v8::Global<v8::Function>)>,
    pub on_all_addons_initialized_callbacks: Vec<v8::Global<v8::Function>>,
    pub on_cleanup_callbacks: Vec<(String, v8::Global<v8::Function>)>,
    pub on_update_callbacks: Vec<(String, v8::Global<v8::Function>)>,
    pub on_project_changed_callbacks: Vec<(String, v8::Global<v8::Function>)>,
    pub op_addon_on_all_projects_loaded_callbacks: Vec<(String, v8::Global<v8::Function>)>,
    pub ui_windows: HashMap<String, (UiWindowConfig, v8::Global<v8::Function>)>,
    pub ui_tabs: HashMap<String, (UiTabConfig, v8::Global<v8::Function>, String)>, // (config, callback, addon_name)
    pub ui_widgets: HashMap<String, Vec<UiWidget>>,
    pub ui_events: Arc<Mutex<Vec<String>>>, // triggered events (e.g. button clicks)
    pub new_tabs: Vec<(String, String, String)>, // (id, title, addon_name)
    pub render_roles: HashMap<String, String>, // role_name -> pipeline_id
    pub project_id: Option<String>,
    pub textures: HashMap<String, Arc<wgpu::TextureView>>,
    pub raw_textures: HashMap<String, Arc<wgpu::Texture>>,
    pub landscape_texture_view: Option<Arc<wgpu::TextureView>>,
    pub landscape_heights: Option<Arc<nalgebra::DMatrix<f32>>>,
    pub landscape_position: [f32; 3],
    pub landscape_config: Option<[f32; 3]>,
    pub addon_textures: HashMap<String, crate::core::Texture::Texture>,
    pub pending_landscape_texture_updates: Vec<(String, LandscapeTextureUpdate)>,
    pub hidden_addons: HashSet<String>,
    pub buffers: HashMap<String, Arc<wgpu::Buffer>>,
    pub compute_encoder: Option<wgpu::CommandEncoder>,
    pub current_time: f64,
    pub camera_position: [f32; 3],
    pub camera_direction: [f32; 3],
    pub camera_view: mint::ColumnMatrix4<f32>,
    pub camera_proj: mint::ColumnMatrix4<f32>,
    pub composite_pipelines: HashMap<String, Arc<wgpu::RenderPipeline>>,
    pub composites: Vec<CompositeInstance>,
    pub model_cache: HashMap<String, Vec<u8>>,
    pub pending_alpha_models: Vec<(String, AlphaModelConfig)>,
    pub registered_tools: HashMap<String, (ToolDefinition, v8::Global<v8::Function>)>,
    pub egui_textures: HashMap<String, egui::TextureId>,
    pub input_events: Vec<InputEvent>,
    pub pressed_keys: HashSet<String>,
    pub mouse_position: [f32; 2],
    pub modifiers: Modifiers,
    pub window_size: [u32; 2],
    pub selected_entity_id: Option<String>,
    pub pending_camera_position: Option<[f32; 3]>,
    pub pending_camera_target: Option<[f32; 3]>,
    pub yumon_sims: HashMap<String, OrganismSim<MyBackend>>,
    pub yumon_brains: HashMap<String, crate::yumon::system::YumonBrain<crate::yumon::system::MyBackend>>,
    pub yumon_instances: HashMap<String, crate::yumon::system::YumonBrain<crate::yumon::system::MyBackend>>,
    pub yumon_runtime_actions: HashMap<String, YumonActionState>,
    pub yumon_trainers: HashMap<String, crate::yumon::system::BackgroundTrainer>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum InputEvent {
    MouseDown { button: u32, x: f32, y: f32 },
    MouseMove { x: f32, y: f32 },
    MouseUp { button: u32 },
    KeyDown { key: String },
    KeyUp { key: String },
    GamepadButton { button: String, pressed: bool },
    GamepadAxis { leftStick: [f32; 2], rightStick: [f32; 2] },
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct Modifiers {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
}

pub struct CompositeInstance {
    pub name: String,
    pub texture_view: Arc<wgpu::TextureView>,
    pub pipeline: Arc<wgpu::RenderPipeline>,
    pub bind_groups: Vec<wgpu::BindGroup>,
    pub uniform_buffers: Vec<wgpu::Buffer>,
    pub samplers: Vec<wgpu::Sampler>,
    pub time_buffer: Option<wgpu::Buffer>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompositeConfig {
    pub name: String,
    pub texture_id: String,
    pub pipeline_id: String,
    pub bindings: Option<Vec<BindingConfig>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComputePipelineConfig {
    pub name: String,
    pub shader_source: String,
    pub bind_groups: Vec<BindGroupDef>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GizmoState {
    pub position: [f32; 3],
    pub mode: String, // "translate", "rotate", "scale"
    pub space: String, // "world", "local"
    pub id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BufferConfig {
    pub size: u64,
    pub usage: String, // "Uniform", "Storage", "Vertex", "Index"
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComputeDispatchConfig {
    pub pipeline_id: String,
    pub groups: [u32; 3],
    pub bindings: Vec<BindingConfig>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub enum LandscapeTextureUpdate {
    Regular { texture_id: String, kind: crate::helpers::saved_data::LandscapeTextureKinds },
    Pbr { texture_id: String, kind: crate::heightfield_landscapes::Landscape::PBRTextureKind, material_type: crate::heightfield_landscapes::Landscape::PBRMaterialType },
}

#[op2]
pub fn op_landscape_update_texture(
    state: &mut OpState,
    #[string] addon_name: String,
    #[string] texture_id: String,
    #[serde] kind: crate::helpers::saved_data::LandscapeTextureKinds,
) {
    if !AddonEngine::is_render_allowed(&addon_name) { return; }
    // println!("op_landscape_update_texture");
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_landscape_texture_updates.push((addon_name, LandscapeTextureUpdate::Regular { texture_id, kind }));
    }
}

#[op2]
pub fn op_landscape_update_pbr_texture(
    state: &mut OpState,
    #[string] addon_name: String,
    #[string] texture_id: String,
    #[serde] kind: crate::heightfield_landscapes::Landscape::PBRTextureKind,
    #[serde] material_type: crate::heightfield_landscapes::Landscape::PBRMaterialType,
) {
    if !AddonEngine::is_render_allowed(&addon_name) { return; }
    // println!("op_landscape_update_pbr_texture");
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_landscape_texture_updates.push((addon_name, LandscapeTextureUpdate::Pbr { texture_id, kind, material_type }));
    }
}

#[op2]
pub fn op_entity_apply_impulse(state: &mut OpState, #[string] id: String, #[serde] impulse: Vec<f32>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        if impulse.len() >= 3 {
            ctx.pending_entity_impulses.push((id, [impulse[0], impulse[1], impulse[2]]));
        }
    }
}

#[op2]
pub fn op_entity_set_velocity(state: &mut OpState, #[string] id: String, #[serde] velocity: Vec<f32>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        if velocity.len() >= 3 {
            ctx.pending_entity_velocities.push((id, [velocity[0], velocity[1], velocity[2]]));
        }
    }
}

#[op2]
pub fn op_entity_set_xz_velocity(state: &mut OpState, #[string] id: String, #[serde] velocity: Vec<f32>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        if velocity.len() >= 2 {
            ctx.pending_entity_xz_velocities.push((id, [velocity[0], velocity[1]]));
        }
    }
}

#[op2]
pub fn op_entity_set_rotation(state: &mut OpState, #[string] id: String, #[serde] rotation: Vec<f32>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        if rotation.len() >= 3 {
            ctx.pending_entity_rotations.push((id, [rotation[0], rotation[1], rotation[2]]));
        }
    }
}

#[op2(fast)]
pub fn op_entity_play_animation(state: &mut OpState, #[string] id: String, #[string] anim_name: String) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_animation_plays.push((id, anim_name));
    }
}

#[op2]
pub fn op_entity_set_stats(state: &mut OpState, #[string] id: String, #[serde] stats: crate::helpers::saved_data::CharacterStats) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_stat_updates.push((id, stats));
    }
}

#[op2]
#[serde]
pub fn op_entity_get_stats(state: &mut OpState, #[string] id: String) -> Option<crate::helpers::saved_data::CharacterStats> {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        // We need to find the entity in the renderer state
        // This is a bit complex as renderer_state is not directly in AddonContext
        // But we might be able to find it in the OpState if we are in a behavior execution
        // However, op_entity_get_stats is called from JS normally.
        
        // Actually, we can look into the editor's renderer_state
        // But AddonContext doesn't have a direct link to Editor.
        // Wait, EngineContext is used during behavior execution.
        
        // Let's look at how other ops get data from the world.
        // op_landscape_get_height uses AddonContext.landscape_heights.
        
        // We might need to sync stats to AddonContext as well.
        None // Placeholder for now, I'll need to check where stats are stored
    } else {
        None
    }
}

#[op2]
pub fn op_model_set_bone_transform(state: &mut OpState, #[serde] config: BoneTransformConfig) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_bone_transforms.push(config);
    }
}

#[op2]
#[serde]
pub fn op_script_list(state: &mut OpState) -> Result<Vec<String>, deno_error::JsErrorBox> {
        let mut script_files = Vec::new();

    let ctx = state.borrow::<AddonContext>();
    if let Some(project_id) = ctx.project_id.clone() {
        let scripts_dir = crate::helpers::utilities::get_scripts_dir(&project_id)
            .ok_or_else(|| deno_error::JsErrorBox::generic("Could not resolve scripts directory"))?;

        if let Ok(entries) = std::fs::read_dir(scripts_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(ext) = path.extension() {
                        if ext == "js" {
                            if let Some(name) = path.file_name() {
                                script_files.push(name.to_string_lossy().into_owned());
                            }
                        }
                    }
                }
            }
        }
    }
    
    Ok(script_files)
}

#[op2]
#[string]
pub fn op_script_read(state: &mut OpState, #[string] filename: String) -> Result<String, deno_error::JsErrorBox> {
    let ctx = state.borrow::<AddonContext>();
    if let Some(project_id) = ctx.project_id.clone() {
    
    let scripts_dir = crate::helpers::utilities::get_scripts_dir(&project_id)
        .ok_or_else(|| deno_error::JsErrorBox::generic("Could not resolve scripts directory"))?;

    let file_path = scripts_dir.join(filename);
    if !file_path.exists() {
        return Err(deno_error::JsErrorBox::generic("Script file not found"));
    }

    std::fs::read_to_string(file_path)
        .map_err(|e| deno_error::JsErrorBox::generic(format!("Failed to read script: {}", e)))

    } else {
        Err(deno_error::JsErrorBox::generic("Script file not found"))
    }
}

#[op2(fast)]
pub fn op_script_write(state: &mut OpState, #[string] filename: String, #[string] content: String) -> Result<(), deno_error::JsErrorBox> {
    let ctx = state.borrow::<AddonContext>();
    if let Some(project_id) = ctx.project_id.clone() {
    
    let scripts_dir = crate::helpers::utilities::get_scripts_dir(&project_id)
        .ok_or_else(|| deno_error::JsErrorBox::generic("Could not resolve scripts directory"))?;

    let file_path = scripts_dir.join(filename);
    
    std::fs::write(file_path, content)
        .map_err(|e| deno_error::JsErrorBox::generic(format!("Failed to write script: {}", e)))

    } else {
        Err(deno_error::JsErrorBox::generic("Script file not found"))
    }
}

#[op2]
pub fn op_ui_rect_create(state: &mut OpState, #[string] addon_name: String, #[serde] config: UiRectConfig) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_ui_rects.push((addon_name, config));
    }
}

#[op2]
pub fn op_ui_text_create(state: &mut OpState, #[string] addon_name: String, #[serde] config: UiTextConfig) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_ui_texts.push((addon_name, config));
    }
}

#[op2(fast)]
pub fn op_ui_clear(state: &mut OpState) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_ui_clear = true;
    }
}

#[op2(fast)]
pub fn op_ui_widget_code_editor(
    state: &mut OpState,
    #[string] window_id: String,
    #[string] label: String,
    #[string] content: String,
    #[string] language: String,
    #[string] id: String,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::CodeEditor { id, label, content, language });
    }
}

#[op2(fast)]
pub fn op_addon_save_data(state: &mut OpState, #[string] addon_name: String, #[string] data: String) -> Result<(), deno_error::JsErrorBox> {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        if let Some(project_id) = ctx.project_id.clone() {
        
        let project_dir = get_project_dir(&project_id)
            .ok_or_else(|| deno_error::JsErrorBox::generic("Could not resolve project directory"))?;
            
        let addons_dir = project_dir.join("addons");
        
        if let Err(e) = std::fs::create_dir_all(&addons_dir) {
            return Err(deno_error::JsErrorBox::generic(format!("Failed to create addons directory: {}", e)));
        }
        
        let file_path = addons_dir.join(format!("{}.json", addon_name));
        
        if let Err(e) = std::fs::write(&file_path, data) {
            return Err(deno_error::JsErrorBox::generic(format!("Failed to write file: {}", e)));
        }
    }
        Ok(())
    } else {
        Err(deno_error::JsErrorBox::generic("Context not available"))
    }
}

#[op2(fast)]
pub fn op_addon_save_image(
    state: &mut OpState,
    #[string] _addon_name: String,
    #[string] filename: String,
    width: u32,
    height: u32,
    #[buffer] rgba_data: &[u8]
) -> Result<(), deno_error::JsErrorBox> {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        if let Some(project_id) = ctx.project_id.clone() {
        
        let textures_dir = crate::helpers::utilities::get_textures_dir(&project_id)
            .ok_or_else(|| deno_error::JsErrorBox::generic("Could not resolve textures directory"))?;
            
        let file_path = textures_dir.join(filename);
        
        if rgba_data.len() != (width * height * 4) as usize {
            return Err(deno_error::JsErrorBox::generic(format!(
                "Invalid image data length. Expected {}, got {}",
                width * height * 4,
                rgba_data.len()
            )));
        }

        image::save_buffer(
            &file_path,
            &rgba_data,
            width,
            height,
            image::ExtendedColorType::Rgba8,
        ).map_err(|e| deno_error::JsErrorBox::generic(format!("Failed to save image: {}", e)))?;
    }

        Ok(())
    } else {
        Err(deno_error::JsErrorBox::generic("Context not available"))
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TextureConfig {
    pub width: u32,
    pub height: u32,
    pub format: String, // "Rgba8Unorm", "Rgba32Float", etc.
    pub usage: Vec<String>, // ["Texture", "Storage", "CopyDst", "CopySrc"]
}

#[op2]
#[string]
pub fn op_texture_create_ex(
    state: &mut OpState,
    #[serde] config: TextureConfig,
    #[buffer] rgba_data: Option<&[u8]>
) -> Result<String, deno_error::JsErrorBox> {
    let mut ctx = state.borrow_mut::<AddonContext>();
    if let Some(gpu) = &ctx.gpu_resources {
        let texture_id = format!("tex_{}", Uuid::new_v4());
        
        let texture_size = wgpu::Extent3d {
            width: config.width,
            height: config.height,
            depth_or_array_layers: 1,
        };

        let format = match config.format.as_str() {
            "Rgba8Unorm" => wgpu::TextureFormat::Rgba8Unorm,
            "Rgba16Float" => wgpu::TextureFormat::Rgba16Float,
            "Rgba32Float" => wgpu::TextureFormat::Rgba32Float,
            _ => wgpu::TextureFormat::Rgba8Unorm,
        };

        let mut usage = wgpu::TextureUsages::empty();
        for u in config.usage {
            match u.as_str() {
                "Texture" => usage |= wgpu::TextureUsages::TEXTURE_BINDING,
                "Storage" => usage |= wgpu::TextureUsages::STORAGE_BINDING,
                "CopyDst" => usage |= wgpu::TextureUsages::COPY_DST,
                "CopySrc" => usage |= wgpu::TextureUsages::COPY_SRC,
                _ => {}
            }
        }

        if usage.is_empty() {
            usage = wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST;
        }

        let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(&format!("Addon Texture Ex {}", texture_id)),
            size: texture_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        });

        if let Some(data) = rgba_data {
            let bytes_per_pixel = match format {
                wgpu::TextureFormat::Rgba8Unorm => 4,
                wgpu::TextureFormat::Rgba16Float => 8,
                wgpu::TextureFormat::Rgba32Float => 16,
                _ => 4,
            };

            if data.len() as u32 == config.width * config.height * bytes_per_pixel {
                gpu.queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    data,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(bytes_per_pixel * config.width),
                        rows_per_image: None,
                    },
                    texture_size,
                );
            }
        }

        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        ctx.textures.insert(texture_id.clone(), Arc::new(view));
        ctx.raw_textures.insert(texture_id.clone(), Arc::new(texture));
        
        Ok(texture_id)
    } else {
        Err(deno_error::JsErrorBox::generic("GPU resources not available"))
    }
}

#[op2]
#[string]
pub fn op_texture_create(
    state: &mut OpState,
    width: u32,
    height: u32,
    #[buffer] rgba_data: &[u8]
) -> Result<String, deno_error::JsErrorBox> {
    let mut ctx = state.borrow_mut::<AddonContext>();
    if let Some(gpu) = &ctx.gpu_resources {
        let texture_id = format!("tex_{}", Uuid::new_v4());
        
        let texture_size = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };

        let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(&format!("Addon Texture {}", texture_id)),
            size: texture_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            rgba_data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4 * width),
                rows_per_image: None,
            },
            texture_size,
        );

        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let shared_texture = Arc::new(texture);
        ctx.textures.insert(texture_id.clone(), Arc::new(view));
        ctx.raw_textures.insert(texture_id.clone(), shared_texture);
        
        let core_texture = crate::core::Texture::Texture {
            data: rgba_data.to_vec(),
            width,
            height,
            format: wgpu::TextureFormat::Rgba8Unorm,
        };
        ctx.addon_textures.insert(texture_id.clone(), core_texture);
        
        Ok(texture_id)
    } else {
        Err(deno_error::JsErrorBox::generic("GPU resources not available"))
    }
}

#[op2]
#[string]
pub fn op_texture_load(
    state: &mut OpState,
    #[string] filename: String
) -> Result<String, deno_error::JsErrorBox> {
    let mut ctx = state.borrow_mut::<AddonContext>();
    if let Some(project_id) = ctx.project_id.clone() {
    
    let textures_dir = crate::helpers::utilities::get_textures_dir(&project_id)
        .ok_or_else(|| deno_error::JsErrorBox::generic("Could not resolve textures directory"))?;
            
    let file_path = textures_dir.join(filename);

    println!("Texture load: {:?}", file_path);
    
    if let Some(gpu) = &ctx.gpu_resources {
        let texture_id = format!("tex_{}", Uuid::new_v4());
        
        let img = image::open(&file_path)
            .map_err(|e| deno_error::JsErrorBox::generic(format!("Failed to open image: {}", e)))?;
        let img = img.to_rgba8();
        let (width, height) = img.dimensions();
        let rgba_data = img.into_raw();

        let texture_size = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };

        let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(&format!("Addon Loaded Texture {}", texture_id)),
            size: texture_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &rgba_data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4 * width),
                rows_per_image: None,
            },
            texture_size,
        );

        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let shared_texture = Arc::new(texture);
        ctx.textures.insert(texture_id.clone(), Arc::new(view));
        ctx.raw_textures.insert(texture_id.clone(), shared_texture.clone());

        let core_texture = crate::core::Texture::Texture {
            data: rgba_data,
            width,
            height,
            format: wgpu::TextureFormat::Rgba8Unorm,
        };
        ctx.addon_textures.insert(texture_id.clone(), core_texture);
        
        Ok(texture_id)
    } else {
        Err(deno_error::JsErrorBox::generic("GPU resources not available"))
    }
}else {
        Err(deno_error::JsErrorBox::generic("Project id not set"))
    }
}

#[op2(fast)]
pub fn op_texture_update(
    state: &mut OpState,
    #[string] texture_id: String,
    #[buffer] data: &[u8]
) -> Result<(), deno_error::JsErrorBox> {
    let ctx = state.borrow::<AddonContext>();
    let gpu = ctx.gpu_resources.as_ref().ok_or_else(|| deno_error::JsErrorBox::generic("GPU resources not available"))?;

    if let Some(texture) = ctx.raw_textures.get(&texture_id) {
        let size = texture.size();
        let format = texture.format();
        
        let bytes_per_pixel = match format {
            wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Rgba8UnormSrgb => 4,
            wgpu::TextureFormat::Rgba16Float => 8,
            wgpu::TextureFormat::Rgba32Float => 16,
            _ => 4,
        };

        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_pixel * size.width),
                rows_per_image: None,
            },
            size,
        );
        Ok(())
    } else {
        Err(deno_error::JsErrorBox::generic(format!("Texture not found: {}", texture_id)))
    }
}

#[op2]
#[string]
pub fn op_addon_load_data(state: &mut OpState, #[string] addon_name: String) -> Result<String, deno_error::JsErrorBox> {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
            if let Some(project_id) = ctx.project_id.clone() {

        
        let project_dir = get_project_dir(&project_id)
            .ok_or_else(|| deno_error::JsErrorBox::generic("Could not resolve project directory"))?;
            
        let file_path = project_dir.join("addons").join(format!("{}.json", addon_name));
        
        if !file_path.exists() {
            return Ok("".to_string()); // Return empty string if not found
        }

        match std::fs::read_to_string(&file_path) {
            Ok(content) => Ok(content),
            Err(e) => Err(deno_error::JsErrorBox::generic(format!("Failed to read file: {}", e)))
        }
    }else {
        Err(deno_error::JsErrorBox::generic("Project id not available"))
    }
    } else {
        Err(deno_error::JsErrorBox::generic("Context not available"))
    }
}

#[op2]
#[serde]
pub fn op_io_list_models(state: &mut OpState) -> Result<Vec<String>, deno_error::JsErrorBox> {
     let mut model_files = Vec::new();

    let ctx = state.borrow::<AddonContext>();
    if let Some(project_id) = ctx.project_id.clone() {
    
    let models_dir = crate::helpers::utilities::get_models_dir(&project_id)
        .ok_or_else(|| deno_error::JsErrorBox::generic("Could not resolve models directory"))?;

   
    if let Ok(entries) = std::fs::read_dir(models_dir) {
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.is_file() {
                    if let Some(ext) = path.extension() {
                        if ext == "glb" || ext == "gltf" {
                            if let Some(name) = path.file_name() {
                                model_files.push(name.to_string_lossy().into_owned());
                            }
                        }
                    }
                }
            }
        }
    }
}
    
    Ok(model_files)
}

#[op2]
#[string]
pub fn op_io_pick_and_import_model(state: &mut OpState) -> Result<String, deno_error::JsErrorBox> {
    let ctx = state.borrow::<AddonContext>();
    if let Some(project_id) = ctx.project_id.clone() {
    
    let models_dir = crate::helpers::utilities::get_models_dir(&project_id)
        .ok_or_else(|| deno_error::JsErrorBox::generic("Could not resolve models directory"))?;

    // Open file dialog
    let file_path = rfd::FileDialog::new()
        .add_filter("GLTF/GLB Models", &["gltf", "glb"])
        .pick_file();

    if let Some(src_path) = file_path {
        let file_name = src_path.file_name()
            .ok_or_else(|| deno_error::JsErrorBox::generic("Invalid file name"))?
            .to_string_lossy()
            .into_owned();
        
        let dest_path = models_dir.join(&file_name);
        
        // Copy file
        std::fs::copy(&src_path, &dest_path)
            .map_err(|e| deno_error::JsErrorBox::generic(format!("Failed to copy model file: {}", e)))?;
        
        Ok(file_name)
    } else {
        Ok("".to_string())
    }
} else {
        Ok("".to_string())
    }
}

#[op2]
#[string]
pub fn op_generate_uuid(state: &mut OpState) -> Result<String, deno_error::JsErrorBox> {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        let id = Uuid::new_v4().to_string();
        Ok(id)
    } else {
        Err(deno_error::JsErrorBox::generic("Context not available"))
    }
}

#[op2]
pub fn op_audio_play_synth(state: &mut OpState, #[serde] config: SynthConfig) {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.audio_engine.play_synth(config.freq, &config.waveform, config.duration, config.cutoff, config.gain);
    }
}

#[op2]
pub fn op_audio_play_note(state: &mut OpState, #[serde] config: NoteConfig) {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.audio_engine.play_note(&config.waveform, crate::audio::NoteParams {
            freq: config.freq,
            duration: config.duration,
            cutoff: config.cutoff,
            resonance: config.resonance,
            gain: config.gain,
            attack: config.attack,
            decay: config.decay,
            sustain: config.sustain,
            release: config.release,
        });
    }
}

#[op2(fast)]
pub fn op_audio_play_test(state: &mut OpState) {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.audio_engine.play_test_tone();
    }
}

#[op2]
#[string]
pub fn op_noise_create(state: &mut OpState, #[serde] config: NoiseConfig) -> String {



    let id = format!("noise_{}", uuid::Uuid::new_v4());



    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {



        ctx.noise_generators.insert(id.clone(), config);



    }



    id



}

#[op2]
pub fn op_point_light_create(state: &mut OpState, #[string] addon_name: String, #[serde] config: PointLightConfig) {
    if !AddonEngine::is_render_allowed(&addon_name) { return; }
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        println!("new point light: {:?} {:?}", addon_name, config);
        ctx.pending_point_lights.push((addon_name, config));
    }
}

#[op2]
pub fn op_lighting_update_sun(state: &mut OpState, #[serde] config: ProceduralSkyConfigCC) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_sun_config = Some(config);
    }
}


#[op2(fast)]
pub fn op_set_game_mode(state: &mut OpState, enabled: bool) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_game_mode = Some(enabled);
    }
}

#[op2]
pub fn op_gizmo_show(state: &mut OpState, #[serde] config: GizmoState) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.active_gizmo = Some(config);
    }
}

#[op2(fast)]
pub fn op_gizmo_hide(state: &mut OpState) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.active_gizmo = None;
    }
}

#[op2(fast)]
pub fn op_gizmo_update(state: &mut OpState, x: f32, y: f32, z: f32) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        if let Some(gizmo) = &mut ctx.active_gizmo {
            gizmo.position = [x, y, z];
        }
    }
}

#[op2]
#[serde]
pub fn op_input_get_state(state: &mut OpState) -> Result<AddonInputState, deno_error::JsErrorBox> {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        Ok(AddonInputState {
            pressed_keys: ctx.pressed_keys.iter().cloned().collect(),
            mouse_position: ctx.mouse_position,
            modifiers: ctx.modifiers.clone(),
        })
    } else {
        Err(deno_error::JsErrorBox::generic("Context not available"))
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonInputState {
    pub pressed_keys: Vec<String>,
    pub mouse_position: [f32; 2],
    pub modifiers: Modifiers,
}

#[op2]
#[serde]
pub fn op_camera_screen_to_world(
    state: &mut OpState,
    x: f32,
    y: f32,
    width: u32,
    height: u32,
) -> Result<RayData, deno_error::JsErrorBox> {
    use nalgebra::{Matrix4, Vector4};

    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        let view: Matrix4<f32> = ctx.camera_view.into();
        let proj: Matrix4<f32> = ctx.camera_proj.into();

        // Convert screen to NDC
        let ndc_x = (x / width as f32) * 2.0 - 1.0;
        let ndc_y = 1.0 - (y / height as f32) * 2.0;

        let inv_view_proj = (proj * view).try_inverse()
            .ok_or_else(|| deno_error::JsErrorBox::generic("Could not invert view-projection matrix"))?;

        let near_ndc = Vector4::new(ndc_x, ndc_y, 0.0, 1.0);
        let far_ndc = Vector4::new(ndc_x, ndc_y, 1.0, 1.0);

        let near_world_h = inv_view_proj * near_ndc;
        let far_world_h = inv_view_proj * far_ndc;

        let near_world = near_world_h.xyz() / near_world_h.w;
        let far_world = far_world_h.xyz() / far_world_h.w;

        let direction = (far_world - near_world).normalize();

        Ok(RayData {
            origin: [near_world.x, near_world.y, near_world.z],
            direction: [direction.x, direction.y, direction.z],
        })
    } else {
        Err(deno_error::JsErrorBox::generic("Context not available"))
    }
}

#[op2]
#[serde]
pub fn op_window_get_size(state: &mut OpState) -> Result<(u32, u32), deno_error::JsErrorBox> {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        Ok((ctx.window_size[0], ctx.window_size[1]))
    } else {
        Err(deno_error::JsErrorBox::generic("Context not available"))
    }
}

#[op2]
#[string]
pub fn op_selection_get_selected(state: &mut OpState) -> String {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.selected_entity_id.clone().unwrap_or_default()
    } else {
        String::new()
    }
}

#[op2]
#[serde]
pub fn op_mesh_get_data(state: &mut OpState, #[string] _mesh_id: String) -> MeshData {
    MeshData {
        vertices: Vec::new(),
        indices: Vec::new(),
        vertex_stride: 13,
    }
}

#[op2]
pub fn op_mesh_update_vertices(
    state: &mut OpState,
    #[string] mesh_id: String,
    #[serde] indices: Vec<u32>,
    #[serde] new_positions: Vec<f32>,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_mesh_updates.push((mesh_id, indices, new_positions));
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshData {
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
    pub vertex_stride: u32,
}

#[derive(Serialize, Deserialize)]
pub struct RayData {
    pub origin: [f32; 3],
    pub direction: [f32; 3],
}

#[op2]
pub fn op_grass_create(state: &mut OpState, #[string] addon_name: String, #[serde] config: AddonGrassConfig) {
    if !AddonEngine::is_render_allowed(&addon_name) { return; }
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        // println!("Create grass xyz");
        ctx.pending_grasses.push((addon_name, config));
    }
}

#[op2]
pub fn op_quadscape_create(state: &mut OpState, #[string] addon_name: String, #[serde] config: LandscapeConfig) {
    if !AddonEngine::is_render_allowed(&addon_name) { return; }
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_quadscapes.push((addon_name, config));
    }
}

#[op2]
pub fn op_landscape_create(state: &mut OpState, #[string] addon_name: String, #[serde] config: LandscapeConfig) {
    if !AddonEngine::is_render_allowed(&addon_name) { return; }
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_landscapes.push((addon_name, config));
    }
}

#[op2]
pub fn op_landscape3d_create(state: &mut OpState, #[string] addon_name: String, #[serde] config: Landscape3DConfig) {
    if !AddonEngine::is_render_allowed(&addon_name) { return; }
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_landscape3ds.push((addon_name, config));
    }
}

#[op2]
pub fn op_system_spawn_particles(state: &mut OpState, #[serde] pos: Vec<f32>, #[serde] color: Vec<f32>, #[serde] gravity: Vec<f32>) {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
        let start_color = [color[0], color[1], color[2], color[3]];
        let end_color = [color[0], color[1], color[2], 0.0];
        
        let config = ScriptParticleConfig {
            emission_rate: 100.0,
            life_time: 3.0,
            radius: 0.6,
            gravity: [gravity[0], gravity[1], gravity[2]],
            initial_speed_min: 2.0,
            initial_speed_max: 5.0,
            start_color,
            end_color,
            size: 0.02,
            mode: 0.0,
            position: [pos[0], pos[1], pos[2]],
        };
        ctx.particle_spawns.push(config);
    }
}

#[op2(fast)]
pub fn op_dialogue_show(state: &mut OpState, #[string] text: String) {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
        if let Some(d) = &mut ctx.dialogue_wrapper {
            d.text = text;
            d.options.clear();
            d.changed = true;
            d.is_open = true;
        }
    }
}

#[op2(fast)]
pub fn op_dialogue_add_option(state: &mut OpState, #[string] text: String, #[string] next_node: String) {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
         if let Some(d) = &mut ctx.dialogue_wrapper {
            d.options.push(crate::game_ui::dialogue_state::DialogueOption { text, next_node });
            d.changed = true;
        }
    }
}

#[op2(fast)]
pub fn op_dialogue_start_quest(state: &mut OpState, #[string] quest_id: String) {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
         if let Some(d) = &mut ctx.dialogue_wrapper {
            d.started_quest = Some(quest_id);
        }
    }
}

#[op2(fast)]
pub fn op_dialogue_close(state: &mut OpState) {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
         if let Some(d) = &mut ctx.dialogue_wrapper {
            d.is_open = false;
            d.changed = true;
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AlphaModelConfig {
    pub id: String,
    pub path: String,
    pub position: [f32; 3],
    pub rotation: Option<[f32; 3]>,
    pub scale: Option<[f32; 3]>,
}

#[op2]
pub fn op_alpha_model_load(state: &mut OpState, #[string] addon_name: String, #[serde] config: AlphaModelConfig) {
    if !AddonEngine::is_render_allowed(&addon_name) { return; }
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_alpha_models.push((addon_name, config));
    }
}

#[op2]
#[string]
pub fn op_dialogue_get_node(state: &mut OpState) -> String {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
         if let Some(d) = &ctx.dialogue_wrapper {
            return d.current_node.clone();
        }
    }
    "".to_string()
}

#[op2(fast)]
pub fn op_dialogue_select_option(state: &mut OpState, index: u32) {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
        if let Some(d) = &mut ctx.dialogue_wrapper {
            if (index as usize) < d.options.len() {
                let next_node = d.options[index as usize].next_node.clone();
                d.current_node = next_node;
                d.changed = true;
            }
        }
    }
}

#[op2(fast)]
pub fn op_landscape_get_height(state: &mut OpState, x: f32, z: f32) -> f32 {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        if let Some(heights) = &ctx.landscape_heights {
            if let Some(sizing) = &ctx.landscape_config {
                let square_size = sizing[0];
                let num_cols = heights.ncols();  // This is width (x direction)
                let num_rows = heights.nrows();  // This is height (z direction)

                let land_origin_x = ctx.landscape_position[0] - (square_size / 2.0);
                let land_origin_z = ctx.landscape_position[2] - (square_size / 2.0);

                let local_x = x - land_origin_x;
                let local_z = z - land_origin_z;

                let norm_x = local_x / square_size;
                let norm_z = local_z / square_size;

                if norm_x < 0.0 || norm_x > 1.0 || norm_z < 0.0 || norm_z > 1.0 {
                    return ctx.landscape_position[1];
                }

                // Map to grid indices - CRITICAL: make sure these match your generation
                let grid_col = norm_x * (num_cols as f32 - 1.0);  // x maps to columns
                let grid_row = norm_z * (num_rows as f32 - 1.0);  // z maps to rows

                let col0 = grid_col.floor() as usize;
                let row0 = grid_row.floor() as usize;
                let col1 = (col0 + 1).min(num_cols - 1);
                let row1 = (row0 + 1).min(num_rows - 1);

                // Access as heights[(row, col)] to match how you stored them
                let h00 = heights[(row0, col0)];
                let h10 = heights[(row0, col1)];
                let h01 = heights[(row1, col0)];
                let h11 = heights[(row1, col1)];

                let tx = grid_col - col0 as f32;
                let tz = grid_row - row0 as f32;

                let h_top = h00 * (1.0 - tx) + h10 * tx;
                let h_bottom = h01 * (1.0 - tx) + h11 * tx;

                let final_height = h_top * (1.0 - tz) + h_bottom * tz;
                
                return final_height + ctx.landscape_position[1];
            }
        }
    }
    0.0
}

#[op2]
pub fn op_behavior_register(
    state: &mut OpState,
    #[string] id: String,
    #[global] on_update: Option<v8::Global<v8::Function>>,
    #[global] on_interact: Option<v8::Global<v8::Function>>,
    #[global] on_attack: Option<v8::Global<v8::Function>>,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.behaviors.insert(id, BehaviorHooks {
            on_update,
            on_interact,
            on_attack,
        });
    }
}

#[op2]
#[serde]
pub fn op_addon_register(state: &mut OpState, #[serde] metadata: AddonMetadata) {
    // println!("Registering addon: {:?}", metadata);
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        // ctx.registered_addons.insert(metadata.name.clone(), metadata);
        // we want them to load in the same order every time for predictability
        ctx.registered_addons.push((metadata.name.clone(), metadata));
    }
}

#[op2]
pub fn op_addon_on_init(state: &mut OpState, #[string] addon_name: String, #[global] callback: v8::Global<v8::Function>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.on_init_callbacks.push((addon_name, callback));
    }
}

#[op2]
pub fn op_addon_on_all_addons_initialized(state: &mut OpState, #[global] callback: v8::Global<v8::Function>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.on_all_addons_initialized_callbacks.push(callback);
    }
}

#[op2]
pub fn op_addon_on_update(state: &mut OpState, #[string] addon_name: String, #[global] callback: v8::Global<v8::Function>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.on_update_callbacks.push((addon_name, callback));
    }
}

#[op2]
pub fn op_addon_on_cleanup(state: &mut OpState, #[string] addon_name: String, #[global] callback: v8::Global<v8::Function>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.on_cleanup_callbacks.push((addon_name, callback));
    }
}

#[op2]
pub fn op_addon_on_action(state: &mut OpState, #[string] addon_name: String, #[global] callback: v8::Global<v8::Function>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.on_action_callbacks.push((addon_name, callback));
    }
}

#[op2]
#[string]
pub fn op_ui_create_window(state: &mut OpState, #[serde] config: UiWindowConfig, #[global] on_render: v8::Global<v8::Function>) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_windows.insert(id.clone(), (config, on_render));
    }
    id
}

#[op2]
#[string]
pub fn op_ui_create_tab(state: &mut OpState, #[string] addon_name: String, #[serde] config: UiTabConfig, #[global] on_render: v8::Global<v8::Function>) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let title = config.title.clone();
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_tabs.insert(id.clone(), (config, on_render, addon_name.clone()));
        ctx.new_tabs.push((id.clone(), title, addon_name));
    }
    id
}

#[op2(fast)]
pub fn op_ui_widget_label(state: &mut OpState, #[string] window_id: String, #[string] text: String, bold: bool) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::Label { text, bold: Some(bold) });
    }
}

#[op2(fast)]
pub fn op_ui_widget_button(state: &mut OpState, #[string] window_id: String, #[string] text: String, #[string] id: String) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::Button { text: text.clone(), id, label: text });
    }
}

// #[derive(Deserialize)]
// struct Color {
//     r: f32,
//     g: f32,
//     b: f32,
//     a: f32,
// }

// #[op2]
// pub fn op_ui_widget_color_input(state: &mut OpState, #[string] window_id: String, #[string] label: String, #[serde] color: Color, #[string] id: String) {
//     if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
//         ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::ColorInput { id, label, color: [color.r, color.g, color.b, color.a] });
//     }
// }

#[op2]
pub fn op_ui_widget_color_input(
    state: &mut OpState,
    #[string] window_id: String,
    #[string] label: String,
    #[serde] color: Vec<f32>,
    #[string] id: String
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        let color_array: [f32; 4] = color.try_into().unwrap_or([0.0, 0.0, 0.0, 1.0]);
        ctx.ui_widgets
            .entry(window_id)
            .or_default()
            .push(UiWidget::ColorInput { id, label, color: color_array });
    }
}

#[op2(fast)]
pub fn op_ui_widget_slider(
    state: &mut OpState,
    #[string] window_id: String,
    #[string] label: String,
    value: f32,
    min: f32,
    max: f32,
    #[string] id: String
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets
            .entry(window_id)
            .or_default()
            .push(UiWidget::Slider { id, label, value, min, max });
    }
}

#[op2(fast)]
pub fn op_ui_widget_numeric_input(
    state: &mut OpState,
    #[string] window_id: String,
    #[string] label: String,
    value: f32,
    #[string] id: String
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets
            .entry(window_id)
            .or_default()
            .push(UiWidget::NumericInput { id, label, value });
    }
}

#[op2]
pub fn op_ui_widget_dropdown(
    state: &mut OpState,
    #[string] window_id: String,
    #[string] label: String,
    #[serde] options: Vec<String>,
    #[bigint] selected_index: usize,
    #[string] id: String,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets
            .entry(window_id)
            .or_insert_with(Vec::new)
            .push(UiWidget::Dropdown {
                id,
                label,
                options,
                selected_index,
            });
    }
}

#[op2(fast)]
pub fn op_ui_widget_checkbox(
    state: &mut OpState,
    #[string] window_id: String,
    #[string] label: String,
    value: bool,
    #[string] id: String,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets
            .entry(window_id)
            .or_default()
            .push(UiWidget::Checkbox { id, label, value });
    }
}

#[op2]
pub fn op_ui_widget_mini_map(
    state: &mut OpState,
    #[string] window_id: String,
    #[string] landscape_id: String,
    brush_size: f32,
    #[serde] markers: Vec<MiniMapMarker>,
    #[serde] polylines: Vec<MiniMapPolyline>,
    #[string] id: String,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::MiniMap { 
            id, 
            landscape_id: Some(landscape_id), 
            brush_size, 
            markers,
            polylines: Some(polylines),
        });
    }
}

#[op2]
pub fn op_ui_widget_snarl(
    state: &mut OpState,
    #[string] window_id: String,
    #[serde] graph: BehaviorGraph,
    #[string] id: String,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::Snarl { id, graph });
    }
}

#[op2]
pub fn op_ui_widget_piano_roll(
    state: &mut OpState,
    #[string] window_id: String,
    rows: u32,
    steps: u32,
    steps_per_beat: u32,
    #[serde] row_labels: Option<Vec<String>>,
    #[serde] cells: Vec<PianoRollCell>,
    playhead: f32,
    #[string] id: String,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::PianoRoll {
            id,
            rows,
            steps,
            steps_per_beat,
            row_labels,
            cells,
            playhead,
        });
    }
}

#[op2(fast)]
pub fn op_ui_widget_collapsing_header(
    state: &mut OpState,
    #[string] window_id: String,
    #[string] title: String,
    #[string] id: String,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::CollapsingHeader { title, id });
    }
}

#[op2(fast)]
pub fn op_ui_widget_end_collapsing_header(state: &mut OpState, #[string] window_id: String) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::EndCollapsingHeader);
    }
}

#[op2(fast)]
pub fn op_ui_widget_start_horizontal(state: &mut OpState, #[string] window_id: String) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::StartHorizontal);
    }
}

#[op2(fast)]
pub fn op_ui_widget_end_horizontal(state: &mut OpState, #[string] window_id: String) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::EndHorizontal);
    }
}

#[op2(fast)]
pub fn op_ui_widget_separator(state: &mut OpState, #[string] window_id: String) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::Separator);
    }
}

#[op2(fast)]
pub fn op_composer_set_role_pipeline(state: &mut OpState, #[string] role: String, #[string] pipeline_id: String) {
    let mut ctx = state.borrow_mut::<AddonContext>();
    ctx.render_roles.insert(role, pipeline_id);
}

#[op2]
#[string]
pub fn op_pipeline_create(state: &mut OpState, #[serde] config: PipelineConfig) -> Result<String, deno_error::JsErrorBox> {
    println!("Creating pipeline: {:?} {:?} {:?} {:?}", config.name, config.layout, config.pbr, config.use_default);
    
    if config.use_default.unwrap_or(false) {
        return Ok("default".to_string());
    }

    let id = format!("pipeline_{}", uuid::Uuid::new_v4());
    let mut ctx = state.borrow_mut::<AddonContext>();
    
    if let Some(gpu) = &ctx.gpu_resources {
        let device = &gpu.device;
        
        let mut layouts: Vec<&wgpu::BindGroupLayout> = ctx.bind_group_layouts.iter().map(|l| l.as_ref()).collect();
        let mut created_layouts = Vec::new(); // Keep them alive during this function scope

        if config.layout.as_deref() == Some("hair") {
            // Group 0: Camera
            // Group 1: GrassUniforms
            // Group 2: Landscape
            
            if ctx.grass_uniform_layout.is_none() {
                ctx.grass_uniform_layout = Some(Arc::new(device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    entries: &[wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    }],
                    label: Some("grass_uniform_bind_group_layout"),
                })));
            }

            // if ctx.landscape_particle_layout.is_none() {
            //     ctx.landscape_particle_layout = Some(Arc::new(device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            //         entries: &[
            //             wgpu::BindGroupLayoutEntry {
            //                 binding: 0,
            //                 visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            //                 ty: wgpu::BindingType::Texture {
            //                     sample_type: wgpu::TextureSampleType::Float { filterable: true },
            //                     view_dimension: wgpu::TextureViewDimension::D2,
            //                     multisampled: false,
            //                 },
            //                 count: None,
            //             },
            //             wgpu::BindGroupLayoutEntry {
            //                 binding: 1,
            //                 visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            //                 ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            //                 count: None,
            //             },
            //         ],
            //         label: Some("Landscape Particle Bind Group Layout (from addons)"),
            //     })));
            // }

            // println!("Working pipeline (1): {:?} {:?}", config.name, config.pbr);

            layouts = vec![
                ctx.bind_group_layouts[0].as_ref(), // Camera
                ctx.grass_uniform_layout.as_ref().unwrap().as_ref(),
                // ctx.landscape_particle_layout.as_ref().unwrap().as_ref(), // must provide due in JS via Landscape id on Texture resource cause of architecture
            ];
        } else if config.layout.as_deref() == Some("mesh") {
            // Group 0: Camera
            // Group 1: MeshUniforms (Transform)
            layouts = vec![
                ctx.bind_group_layouts[0].as_ref(), // Camera
                ctx.bind_group_layouts[1].as_ref(), // Model/Mesh Transform
            ];
        } else if config.layout.as_deref() == Some("skinned") {
            if ctx.skinned_layout.is_none() {
                ctx.skinned_layout = Some(Arc::new(device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("Skinned Joint Layout"),
                    entries: &[wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    }],
                })));
            }
            layouts = vec![
                ctx.bind_group_layouts[0].as_ref(), // Camera
                ctx.bind_group_layouts[1].as_ref(), // Model/Mesh Transform
                // ctx.skinned_layout.as_ref().unwrap().as_ref(), // Joint Matrices (can be set in JS side instead)
            ];
        } else if config.form.as_deref() == Some("composite") {
            if ctx.composite_layout.is_none() {
                ctx.composite_layout = Some(Arc::new(device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    entries: &[
                        wgpu::BindGroupLayoutEntry {
                            binding: 0,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 1,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 2,
                            visibility: wgpu::ShaderStages::FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Depth,
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                    ],
                    label: Some("composite_bind_group_layout"),
                })));
            }
            layouts = vec![
                ctx.bind_group_layouts[0].as_ref(), // Camera
                ctx.composite_layout.as_ref().unwrap().as_ref(),
            ];
        } 
        
         if let Some(extras) = &config.extra_bind_groups {
            // Handle generic extra layouts
            if config.layout.as_deref() == Some("hair") {
                layouts = vec![
                    ctx.bind_group_layouts[0].as_ref(), // Camera
                    ctx.grass_uniform_layout.as_ref().unwrap().as_ref(),
                    // ctx.landscape_particle_layout.as_ref().unwrap().as_ref(),
                ];
            } else if config.layout.as_deref() == Some("mesh") {
                layouts = vec![
                    ctx.bind_group_layouts[0].as_ref(), // Camera
                    ctx.bind_group_layouts[1].as_ref(), // Model
                ];
            } else if config.layout.as_deref() == Some("skinned") {
                layouts = vec![
                    ctx.bind_group_layouts[0].as_ref(), // Camera
                    ctx.bind_group_layouts[1].as_ref(), // Model
                    // ctx.skinned_layout.as_ref().unwrap().as_ref(), // Joint Matrices (can be set in JS side instead)
                ];
            } else if config.form.as_deref() == Some("composite") {
                layouts = vec![
                    ctx.bind_group_layouts[0].as_ref(), // Camera
                    ctx.composite_layout.as_ref().unwrap().as_ref(),
                ];
            } else {
                layouts = vec![ctx.bind_group_layouts[0].as_ref()]; // Start with Camera (Group 0)
            }

            //  println!("Create extra bind groups for water {:?}", extras.len());

             for (i, group_def) in extras.iter().enumerate() {
                 let mut entries = Vec::new();
                 for entry_def in &group_def.entries {
                     let mut visibility = wgpu::ShaderStages::NONE;
                     for v in &entry_def.visibility {
                         match v.to_lowercase().as_str() {
                             "vertex" => visibility |= wgpu::ShaderStages::VERTEX,
                             "fragment" => visibility |= wgpu::ShaderStages::FRAGMENT,
                             "compute" => visibility |= wgpu::ShaderStages::COMPUTE,
                             _ => {}
                         }
                     }
                     if visibility == wgpu::ShaderStages::NONE {
                         visibility = wgpu::ShaderStages::VERTEX_FRAGMENT;
                     }

                     let ty = match entry_def.resource_type.as_str() {
                         "Uniform" => wgpu::BindingType::Buffer {
                             ty: wgpu::BufferBindingType::Uniform,
                             has_dynamic_offset: false,
                             min_binding_size: None,
                         },
                         "Texture" => wgpu::BindingType::Texture {
                             sample_type: wgpu::TextureSampleType::Float { filterable: true },
                             view_dimension: wgpu::TextureViewDimension::D2,
                             multisampled: false,
                         },
                         "TextureNonFilterable" => wgpu::BindingType::Texture {
                             sample_type: wgpu::TextureSampleType::Float { filterable: false },
                             view_dimension: wgpu::TextureViewDimension::D2,
                             multisampled: false,
                         },
                         "DepthTexture" => wgpu::BindingType::Texture {
                             sample_type: wgpu::TextureSampleType::Depth,
                             view_dimension: wgpu::TextureViewDimension::D2,
                             multisampled: false,
                         },
                         "Sampler" => wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                         "Storage" => wgpu::BindingType::Buffer { // Default to uniform
                             ty: wgpu::BufferBindingType::Storage { read_only: true },
                             has_dynamic_offset: false,
                             min_binding_size: None,
                         },
                         "StorageReadOnly" => wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: true },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                         "Uniform" => wgpu::BindingType::Buffer { // Default to uniform
                             ty: wgpu::BufferBindingType::Uniform,
                             has_dynamic_offset: false,
                             min_binding_size: None,
                         },
                         _ => wgpu::BindingType::Buffer { // Default to uniform
                             ty: wgpu::BufferBindingType::Uniform,
                             has_dynamic_offset: false,
                             min_binding_size: None,
                         },
                     };

                     entries.push(wgpu::BindGroupLayoutEntry {
                         binding: entry_def.binding,
                         visibility,
                         ty,
                         count: None,
                     });
                 }

                 let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                     label: Some(&format!("Extra Layout {}", i)),
                     entries: &entries,
                 });
                 created_layouts.push(layout);
             }
             
             // Append created layouts
             for l in &created_layouts {
                 layouts.push(l);
             }

            //  println!("Working pipeline (2): {:?}", layouts.len());
        } else {
             // Default: use all default layouts
             // layouts already initialized to defaults
        }

        
         
        let is_pbr = config.pbr.unwrap_or(true); 
        let mut formats = if is_pbr {
            GBUFFER_FORMATS.as_slice()
        } else {
            std::slice::from_ref(ctx.surface_format.as_ref().unwrap_or(&wgpu::TextureFormat::Rgba8Unorm))
        };

        let depth_format = if config.form.as_deref() == Some("composite") {
            None
        } else {
            Some(wgpu::TextureFormat::Depth24Plus)
        };

        if config.form == Some("composite".to_string()) {
            formats = &[wgpu::TextureFormat::Rgba8Unorm];
        }

        // println!("Working pipeline (3): {:?}", layouts.len());

        let pipeline = create_addon_pipeline(
            device,
            &config,
            &layouts,
            formats,
            depth_format
        );
        
        if config.form == Some("composite".to_string()) {
            ctx.composite_pipelines.insert(id.clone(), Arc::new(pipeline));
        } else {
            ctx.pipelines.insert(id.clone(), Arc::new(pipeline));
        }

        // println!("Prep for lighting shader: {:?} {:?}", config.name, config.layout);

        // If a lighting shader is provided, create a lighting pipeline
        if let Some(lighting_shader_source) = &config.lighting_shader {
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(&format!("{} Lighting Shader", config.name)),
                source: wgpu::ShaderSource::Wgsl(lighting_shader_source.as_str().into()),
            });

            let mut lighting_layouts: Vec<&wgpu::BindGroupLayout> = ctx.lighting_bind_group_layouts.iter().map(|l| l.as_ref()).collect();
            
            // Append extra layouts to the lighting pipeline layout
            for l in &created_layouts {
                lighting_layouts.push(l);
            }

            let lighting_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some(&format!("{} Lighting Pipeline Layout", config.name)),
                bind_group_layouts: &lighting_layouts,
                push_constant_ranges: &[],
            });

            let lighting_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some(&format!("{} Lighting Pipeline", config.name)),
                layout: Some(&lighting_pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    buffers: &[],
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs_main"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: ctx.surface_format.unwrap_or(wgpu::TextureFormat::Rgba8Unorm),
                        blend: Some(wgpu::BlendState::REPLACE),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: wgpu::PipelineCompilationOptions::default(),
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            });

            ctx.lighting_pipelines.insert(id.clone(), Arc::new(lighting_pipeline));

            // println!("More for lighting shader: {:?} {:?}", config.name, config.layout);

            // Create lighting bind groups if provided
            if let Some(bindings) = &config.lighting_bindings {
                let mut bind_groups = Vec::new();
                let mut groups: HashMap<u32, Vec<BindingConfig>> = HashMap::new();
                for b in bindings {
                    groups.entry(b.group).or_default().push(b.clone());
                }

                let mut sorted_groups: Vec<_> = groups.into_iter().collect();
                sorted_groups.sort_by_key(|(g, _)| *g);

                for (group_idx, group_bindings) in sorted_groups {
                    let layout = &lighting_layouts[group_idx as usize];
                    let mut wgpu_entries = Vec::new();
                    let mut temp_buffers = Vec::new();
                    let mut temp_samplers = Vec::new();

                    // First pass: Create temporary resources and collect them
                    for b in &group_bindings {
                        match &b.resource {
                            ResourceType::Uniform { data } => {
                                let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                                    label: Some(&format!("Lighting Uniform {}:{}", group_idx, b.binding)),
                                    contents: bytemuck::cast_slice(&data),
                                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                                });
                                temp_buffers.push((b.binding, buffer));
                            },
                            ResourceType::Sampler => {
                                let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                                    address_mode_u: wgpu::AddressMode::ClampToEdge,
                                    address_mode_v: wgpu::AddressMode::ClampToEdge,
                                    address_mode_w: wgpu::AddressMode::ClampToEdge,
                                    mag_filter: wgpu::FilterMode::Linear,
                                    min_filter: wgpu::FilterMode::Linear,
                                    mipmap_filter: wgpu::FilterMode::Nearest,
                                    ..Default::default()
                                });
                                temp_samplers.push((b.binding, sampler));
                            },
                            _ => {}
                        }
                    }

                    // Second pass: Build wgpu_entries
                    for b in group_bindings {
                        match &b.resource {
                            ResourceType::Uniform { .. } => {
                                let buffer = &temp_buffers.iter().find(|(binding, _)| *binding == b.binding).unwrap().1;
                                wgpu_entries.push(wgpu::BindGroupEntry {
                                    binding: b.binding,
                                    resource: buffer.as_entire_binding(),
                                });
                            },
                            ResourceType::Sampler => {
                                let sampler = &temp_samplers.iter().find(|(binding, _)| *binding == b.binding).unwrap().1;
                                wgpu_entries.push(wgpu::BindGroupEntry {
                                    binding: b.binding,
                                    resource: wgpu::BindingResource::Sampler(sampler),
                                });
                            },
                            ResourceType::Buffer { id } | ResourceType::Storage { id } => {
                                if let Some(buffer) = ctx.buffers.get(id.as_str()) {
                                    wgpu_entries.push(wgpu::BindGroupEntry {
                                        binding: b.binding,
                                        resource: buffer.as_entire_binding(),
                                    });
                                }
                            },
                            ResourceType::Texture { id: Some(id) } | ResourceType::TextureNonFilterable { id } => {
                                if let Some(view) = ctx.textures.get(id.as_str()) {
                                    wgpu_entries.push(wgpu::BindGroupEntry {
                                        binding: b.binding,
                                        resource: wgpu::BindingResource::TextureView(view),
                                    });
                                }
                            },
                            _ => {}
                        }
                    }

                    let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                        layout,
                        entries: &wgpu_entries,
                        label: Some(&format!("Lighting BindGroup {}", group_idx)),
                    });
                    bind_groups.push(bg);
                }
                ctx.lighting_bind_groups.insert(id.clone(), bind_groups);
            }
        }

        // println!("Done with lighting shader: {:?}", config.name);
        
        ctx.pipeline_configs.insert(id.clone(), config);
        
        Ok(id)
    } else {
        Err(deno_error::JsErrorBox::generic("GPU resources not available"))
    }
}

#[op2]
#[string]
pub fn op_buffer_create(state: &mut OpState, #[serde] config: BufferConfig) -> Result<String, deno_error::JsErrorBox> {
    let mut ctx = state.borrow_mut::<AddonContext>();
    if let Some(gpu) = &ctx.gpu_resources {
        let id = format!("buf_{}", Uuid::new_v4());
        
        let mut usage = wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC;
        match config.usage.as_str() {
            "Uniform" => usage |= wgpu::BufferUsages::UNIFORM,
            "Storage" => usage |= wgpu::BufferUsages::STORAGE,
            "Vertex" => usage |= wgpu::BufferUsages::VERTEX,
            "Index" => usage |= wgpu::BufferUsages::INDEX,
            _ => usage |= wgpu::BufferUsages::STORAGE,
        }

        let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&format!("Addon Buffer {}", id)),
            size: config.size,
            usage,
            mapped_at_creation: false,
        });

        ctx.buffers.insert(id.clone(), Arc::new(buffer));
        Ok(id)
    } else {
        Err(deno_error::JsErrorBox::generic("GPU resources not available"))
    }
}

#[op2(fast)]
pub fn op_buffer_write(
    state: &mut OpState,
    #[string] buffer_id: String,
    #[bigint] offset: u64,
    #[buffer] data: &[u8]
) -> Result<(), deno_error::JsErrorBox> {
    let ctx = state.borrow::<AddonContext>();
    if let Some(gpu) = &ctx.gpu_resources {
        if let Some(buffer) = ctx.buffers.get(&buffer_id) {
            gpu.queue.write_buffer(buffer, offset, data);
            Ok(())
        } else {
            Err(deno_error::JsErrorBox::generic("Buffer not found"))
        }
    } else {
        Err(deno_error::JsErrorBox::generic("GPU resources not available"))
    }
}

#[op2]
#[string]
pub fn op_compute_pipeline_create(state: &mut OpState, #[serde] config: ComputePipelineConfig) -> Result<String, deno_error::JsErrorBox> {
    let mut ctx = state.borrow_mut::<AddonContext>();
    if let Some(gpu) = &ctx.gpu_resources {
        let device = &gpu.device;
        let id = format!("cpipeline_{}", Uuid::new_v4());

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(&format!("{} Compute Shader", config.name)),
            source: wgpu::ShaderSource::Wgsl(config.shader_source.as_str().into()),
        });

        let mut bind_group_layouts = Vec::new();
        for (i, group_def) in config.bind_groups.iter().enumerate() {
            let mut entries = Vec::new();
            for entry_def in &group_def.entries {
                let visibility = wgpu::ShaderStages::COMPUTE;
                
                let ty = match entry_def.resource_type.as_str() {
                    "Uniform" => wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    "Storage" => wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    "StorageReadOnly" => wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    "StorageTexture" => wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba32Float, // Keep 32 for precision, but allow 16 if needed
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    "StorageTextureRgba16" => wgpu::BindingType::StorageTexture {
                        access: wgpu::StorageTextureAccess::WriteOnly,
                        format: wgpu::TextureFormat::Rgba16Float,
                        view_dimension: wgpu::TextureViewDimension::D2,
                    },
                    "Texture" => wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    "TextureNonFilterable" => wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    "Sampler" => wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    _ => wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                };

                entries.push(wgpu::BindGroupLayoutEntry {
                    binding: entry_def.binding,
                    visibility,
                    ty,
                    count: None,
                });
            }

            let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some(&format!("{} Compute Layout {}", config.name, i)),
                entries: &entries,
            });
            bind_group_layouts.push(layout);
        }

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some(&format!("{} Compute Pipeline Layout", config.name)),
            bind_group_layouts: &bind_group_layouts.iter().collect::<Vec<_>>(),
            push_constant_ranges: &[],
        });

        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(&format!("{} Compute Pipeline", config.name)),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });

        ctx.compute_pipelines.insert(id.clone(), Arc::new(pipeline));
        Ok(id)
    } else {
        Err(deno_error::JsErrorBox::generic("GPU resources not available"))
    }
}

#[op2]
pub fn op_compute_dispatch(state: &mut OpState, #[serde] config: ComputeDispatchConfig) -> Result<(), deno_error::JsErrorBox> {
    // println!("op_compute_dispatch {:?}", config);
    let ctx = state.borrow::<AddonContext>();
    if let Some(gpu) = &ctx.gpu_resources {
        if let Some(pipeline) = ctx.compute_pipelines.get(&config.pipeline_id) {
            let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Compute Dispatch Encoder"),
            });

            let mut temp_buffers = Vec::new();
            let mut temp_samplers = Vec::new();

            {
                let mut cpass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("Compute Pass"),
                    timestamp_writes: None,
                });
                cpass.set_pipeline(pipeline);

                // println!("op_compute_dispatch BEGUN");

                let mut groups: HashMap<u32, Vec<BindingConfig>> = HashMap::new();
                for b in &config.bindings {
                    groups.entry(b.group).or_default().push(b.clone());
                }

                let mut sorted_groups: Vec<_> = groups.into_iter().collect();
                sorted_groups.sort_by_key(|(g, _)| *g);

                // println!("op_compute_dispatch GROUPS {:?}", sorted_groups.len());

                for (group_idx, group_bindings) in sorted_groups {
                    let layout = pipeline.get_bind_group_layout(group_idx);
                    let mut current_group_temp_buffers = Vec::new();
                    let mut current_group_temp_samplers = Vec::new();
                    
                    // First pass: create all temporary resources
                    for b in &group_bindings {
                        match &b.resource {
                            ResourceType::Uniform { data } => {
                                let buffer = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                                    label: Some("Temp Compute Uniform"),
                                    contents: bytemuck::cast_slice(data),
                                    usage: wgpu::BufferUsages::UNIFORM,
                                });
                                current_group_temp_buffers.push((b.binding, buffer));
                            },
                            ResourceType::Sampler => {
                                let sampler = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
                                    address_mode_u: wgpu::AddressMode::ClampToEdge,
                                    address_mode_v: wgpu::AddressMode::ClampToEdge,
                                    address_mode_w: wgpu::AddressMode::ClampToEdge,
                                    mag_filter: wgpu::FilterMode::Linear,
                                    min_filter: wgpu::FilterMode::Linear,
                                    mipmap_filter: wgpu::FilterMode::Nearest,
                                    ..Default::default()
                                });
                                current_group_temp_samplers.push((b.binding, sampler));
                            },
                            ResourceType::Time => {
                                let time_val = ctx.current_time as f32; 
                                let buffer = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                                    label: Some("Temp Compute Time"),
                                    contents: bytemuck::cast_slice(&[time_val]),
                                    usage: wgpu::BufferUsages::UNIFORM,
                                });
                                current_group_temp_buffers.push((b.binding, buffer));
                            },
                            _ => {}
                        }
                    }

                    // Second pass: collect all bindings into wgpu_entries
                    let mut wgpu_entries = Vec::new();
                    for b in &group_bindings {
                        match &b.resource {
                            ResourceType::Buffer { id } | ResourceType::Storage { id } => {
                                if let Some(buffer) = ctx.buffers.get(id) {
                                    wgpu_entries.push(wgpu::BindGroupEntry {
                                        binding: b.binding,
                                        resource: buffer.as_entire_binding(),
                                    });
                                } else {
                                    println!("Compute Dispatch: Buffer not found: {}", id);
                                    return Err(deno_error::JsErrorBox::generic(format!("Compute Dispatch: Buffer not found: {}", id)));
                                }
                            },
                            ResourceType::StorageTexture { id } | ResourceType::StorageTextureRgba16 { id } | ResourceType::Texture { id: Some(id) } | ResourceType::TextureNonFilterable { id } => {
                                if id == "Landscape" {
                                    if let Some(view) = &ctx.landscape_texture_view {
                                        wgpu_entries.push(wgpu::BindGroupEntry {
                                            binding: b.binding,
                                            resource: wgpu::BindingResource::TextureView(view),
                                        });
                                    } else {
                                        return Err(deno_error::JsErrorBox::generic("Compute Dispatch: Landscape texture not available yet (wait for first frame update)"));
                                    }
                                } else if let Some(view) = ctx.textures.get(id) {
                                    wgpu_entries.push(wgpu::BindGroupEntry {
                                        binding: b.binding,
                                        resource: wgpu::BindingResource::TextureView(view),
                                    });
                                } else {
                                    return Err(deno_error::JsErrorBox::generic(format!("Compute Dispatch: Texture not found: {}", id)));
                                }
                            },
                            ResourceType::Uniform { .. } | ResourceType::Time => {
                                let buffer = current_group_temp_buffers.iter()
                                    .find(|(binding, _)| *binding == b.binding)
                                    .map(|(_, buf)| buf)
                                    .unwrap();
                                wgpu_entries.push(wgpu::BindGroupEntry {
                                    binding: b.binding,
                                    resource: buffer.as_entire_binding(),
                                });
                            },
                            ResourceType::Sampler => {
                                let sampler = current_group_temp_samplers.iter()
                                    .find(|(binding, _)| *binding == b.binding)
                                    .map(|(_, s)| s)
                                    .unwrap();
                                wgpu_entries.push(wgpu::BindGroupEntry {
                                    binding: b.binding,
                                    resource: wgpu::BindingResource::Sampler(sampler),
                                });
                            },
                            _ => {
                                println!("Compute Dispatch: Unsupported resource type for binding {}", b.binding);
                                return Err(deno_error::JsErrorBox::generic(format!("Compute Dispatch: Unsupported resource type for binding {}", b.binding)));
                            }
                        }
                    }

                    // println!("op_compute_dispatch BIND GROUPS");

                    let bg = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                        layout: &layout,
                        entries: &wgpu_entries,
                        label: Some(&format!("Compute Dispatch BindGroup {}", group_idx)),
                    });
                    cpass.set_bind_group(group_idx, &bg, &[]);
                    
                    temp_buffers.extend(current_group_temp_buffers.into_iter().map(|(_, b)| b));
                    temp_samplers.extend(current_group_temp_samplers.into_iter().map(|(_, s)| s));
                }

                // println!("op_compute_dispatch DISPATCH WORKGROUPS");

                cpass.dispatch_workgroups(config.groups[0], config.groups[1], config.groups[2]);
            }

            // println!("op_compute_dispatch SUBMIT");

            gpu.queue.submit(std::iter::once(encoder.finish()));
            Ok(())
        } else {
            Err(deno_error::JsErrorBox::generic(format!("Compute pipeline not found: {}", config.pipeline_id)))
        }
    } else {
        Err(deno_error::JsErrorBox::generic("GPU resources not available"))
    }
}

#[op2]
pub fn op_cube_spawn(state: &mut OpState, #[string] addon_name: String, #[serde] config: CubeConfig) {
    if !AddonEngine::is_render_allowed(&addon_name) { return; }
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_cubes.push((addon_name, config));
    }
}

#[op2]
pub fn op_mesh_create(state: &mut OpState, #[string] addon_name: String, #[serde] config: MeshConfig) {
    if !AddonEngine::is_render_allowed(&addon_name) { return; }
    // println!("Adding mesh?");
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_meshes.push((addon_name, config));
    }
}

#[op2]
pub fn op_model_load(state: &mut OpState, #[string] addon_name: String, #[serde] config: ModelConfig) {
    if !AddonEngine::is_render_allowed(&addon_name) { return; }
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_models.push((addon_name, config));
    }
}

#[op2(fast)]
pub fn op_meshes_clear(state: &mut OpState, #[string] addon_name: String) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_meshes.retain(|(name, _)| name != &addon_name);
        ctx.pending_cubes.retain(|(name, _)| name != &addon_name);
        ctx.pending_models.retain(|(name, _)| name != &addon_name);
        ctx.pending_clears.push(addon_name);
    }
}

#[op2(fast)]
pub fn op_mesh_clear(state: &mut OpState, #[string] addon_name: String, #[string] mesh_id: String) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_meshes.retain(|(name, config)| {
            !(name == &addon_name && config.id.as_deref() == Some(&mesh_id))
        });
        ctx.pending_models.retain(|(name, config)| {
            !(name == &addon_name && config.id.as_deref() == Some(&mesh_id))
        });
        ctx.pending_mesh_clears.push((addon_name, mesh_id));
    }
}

#[op2]
pub fn op_addon_on_project_changed(
    state: &mut OpState,
    #[string] addon_name: String,
    #[global] callback: v8::Global<v8::Function>,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.on_project_changed_callbacks.push((addon_name, callback));
    }
}

#[op2]
pub fn op_addon_on_all_projects_loaded(
    state: &mut OpState,
    #[string] addon_name: String,
    #[global] callback: v8::Global<v8::Function>,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.op_addon_on_all_projects_loaded_callbacks.push((addon_name, callback));
    }
}

#[op2(fast)]
pub fn op_println(
    state: &mut OpState,
    #[string] msg: String
) -> Result<(), deno_error::JsErrorBox> {
    println!("[ADDON] {}", msg);
    Ok(())
}

#[op2]
pub fn op_camera_set_transform(state: &mut OpState, #[serde] position: Option<[f32; 3]>, #[serde] target: Option<[f32; 3]>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_camera_position = position;
        ctx.pending_camera_target = target;
    }
}

#[op2]
#[serde]
pub fn op_camera_get_transform(state: &mut OpState) -> Result<([f32; 3], [f32; 3]), deno_error::JsErrorBox> {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        Ok((ctx.camera_position, ctx.camera_direction))
    } else {
        Err(deno_error::JsErrorBox::generic("Context not available"))
    }
}

#[op2(fast)]
pub fn op_addon_set_visibility(state: &mut OpState, #[string] addon_name: String, visible: bool) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        if visible {
            ctx.hidden_addons.remove(&addon_name);
        } else {
            ctx.hidden_addons.insert(addon_name);
        }
    }
}

#[op2]
pub fn op_register_composite_texture(
    state: &mut OpState,
    #[string] addon_name: String,
    #[serde] config: CompositeConfig,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_composites.push((addon_name, config));
    }
}

#[op2]
pub fn op_addon_register_tool(
    state: &mut OpState,
    #[serde] definition: ToolDefinition,
    #[global] callback: v8::Global<v8::Function>,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.registered_tools.insert(definition.name.clone(), (definition, callback));
    }
}

#[op2(fast)]
pub fn op_yumon_create(state: &mut OpState, #[string] name: String) {
    let mut ctx = state.borrow_mut::<AddonContext>();
    let sim = OrganismSim::<MyBackend>::new(Default::default());
    ctx.yumon_sims.insert(name, sim);
}

#[op2(fast)]
pub fn op_yumon_brain_create(state: &mut OpState, #[string] id: String, #[string] archetype: String) {
    let mut ctx = state.borrow_mut::<AddonContext>();
    let weights = match archetype.as_str() {
        "Berserker" => crate::yumon::system::ArchetypeRewardWeights::berserker(),
        "Coward"    => crate::yumon::system::ArchetypeRewardWeights::coward(),
        "Support"   => crate::yumon::system::ArchetypeRewardWeights::support(),
        _           => crate::yumon::system::ArchetypeRewardWeights::balanced(),
    };
    
    let device = Default::default(); // NdArray device is ()
    let brain = crate::yumon::system::YumonBrain::<crate::yumon::system::MyBackend>::new(device, &archetype, weights);
    ctx.yumon_brains.insert(id, brain);
}

#[op2]
pub fn op_yumon_brain_observe(
    state: &mut OpState,
    #[string] id: String,
    #[serde] world: Vec<f32>,
    #[serde] self_state: Vec<f32>,
    #[bigint] action_idx: usize,
    absolute_rotation: f32,
    reward: f32
) -> Result<(), deno_error::JsErrorBox> {
    let mut ctx = state.borrow_mut::<AddonContext>();
    if let Some(brain) = ctx.yumon_brains.get_mut(&id) {
        let mut world_arr = [0.0f32; crate::yumon::system::WORLD_SIZE];
        let mut self_arr  = [0.0f32; crate::yumon::system::SELF_SIZE];
        
        for (i, &v) in world.iter().take(crate::yumon::system::WORLD_SIZE).enumerate() { world_arr[i] = v; }
        for (i, &v) in self_state.iter().take(crate::yumon::system::SELF_SIZE).enumerate() { self_arr[i] = v; }

        let action = crate::yumon::system::Action::from_usize(action_idx);
        brain.observe(&world_arr, &self_arr, action, absolute_rotation, reward);
        Ok(())
    } else {
        Err(deno_error::JsErrorBox::generic("Yumon brain not found"))
    }
}

#[op2]
#[serde]
pub fn op_yumon_brain_infer(
    state: &mut OpState,
    #[string] id: String
) -> Result<YumonBrainInference, deno_error::JsErrorBox> {
    let mut ctx = state.borrow_mut::<AddonContext>();
    if let Some(brain) = ctx.yumon_brains.get_mut(&id) {
        let res = brain
            .infer_if_ready()
            .ok_or_else(|| deno_error::JsErrorBox::generic("Yumon brain not ready for inference"))?;
        Ok(YumonBrainInference {
            action_idx: res.action as usize,
            action_name: res.action_name.to_string(),
            absolute_rotation: res.absolute_rotation,
        })
    } else {
        Err(deno_error::JsErrorBox::generic("Yumon brain not found"))
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct YumonMomentInput {
    pub world: Vec<f32>,
    pub self_state: Vec<f32>,
}

#[op2]
#[serde]
pub fn op_yumon_brain_test_infer(
    state: &mut OpState,
    #[string] id: String,
    #[serde] context: Vec<YumonMomentInput>
) -> Result<YumonBrainInference, deno_error::JsErrorBox> {
    let mut ctx = state.borrow_mut::<AddonContext>();
    if let Some(brain) = ctx.yumon_brains.get_mut(&id) {
        let moments: Vec<crate::yumon::system::Moment> = context.into_iter().map(|m| {
            let mut world_arr = [0.0f32; crate::yumon::system::WORLD_SIZE];
            let mut self_arr  = [0.0f32; crate::yumon::system::SELF_SIZE];
            for (i, &v) in m.world.iter().take(crate::yumon::system::WORLD_SIZE).enumerate() { world_arr[i] = v; }
            for (i, &v) in m.self_state.iter().take(crate::yumon::system::SELF_SIZE).enumerate() { self_arr[i] = v; }
            crate::yumon::system::Moment { world: world_arr, self_: self_arr }
        }).collect();

        let res = brain.infer_with_context(&moments);
        
        Ok(YumonBrainInference {
            action_idx: res.action as usize,
            action_name: res.action_name.to_string(),
            absolute_rotation: res.absolute_rotation,
        })
    } else {
        Err(deno_error::JsErrorBox::generic("Yumon brain not found"))
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YumonBrainInference {
    pub action_idx: usize,
    pub action_name: String,
    pub absolute_rotation: f32,
}

#[op2(fast)]
pub fn op_yumon_brain_augment(state: &mut OpState, #[string] id: String) -> Result<(), deno_error::JsErrorBox> {
    let mut ctx = state.borrow_mut::<AddonContext>();
    if let Some(brain) = ctx.yumon_brains.get_mut(&id) {
        brain.augment_dataset();
        Ok(())
    } else {
        Err(deno_error::JsErrorBox::generic("Yumon brain not found"))
    }
}

#[op2]
#[serde]
pub fn op_yumon_brain_get_state(
    state: &mut OpState,
    #[string] id: String
) -> Result<YumonBrainState, deno_error::JsErrorBox> {
    let ctx = state.borrow::<AddonContext>();
    if let Some(brain) = ctx.yumon_brains.get(&id) {
        let mut is_training = false;
        let mut training_epoch = 0;
        let mut total_training_epochs = 0;
        let mut training_loss = 0.0;

        if let Some(trainer) = ctx.yumon_trainers.get(&id) {
            is_training = true;

            if let Some(last_update) = &trainer.last_update {
                training_epoch = last_update.epoch;
                total_training_epochs = last_update.total_epochs;
                training_loss = last_update.loss;
            }
        }

        Ok(YumonBrainState {
            archetype: brain.archetype_name.clone(),
            training_mode: format!("{:?}", brain.training_mode),
            state: format!("{:?}", brain.state),
            total_moments: brain.total_moments,
            last_reward: brain.last_reward,
            last_loss: brain.last_loss,
            last_action: brain.last_action.to_string(),
            last_rotation: brain.last_rotation,
            sleep_count: brain.sleep_count,
            is_training,
            training_epoch,
            total_training_epochs,
            training_loss,
        })
    } else {
        Err(deno_error::JsErrorBox::generic("Yumon brain not found"))
    }
}

#[op2(fast)]
pub fn op_yumon_brain_sleep(state: &mut OpState, #[string] id: String, #[bigint] epochs: usize) -> Result<(), deno_error::JsErrorBox> {
    let mut ctx = state.borrow_mut::<AddonContext>();
    if let Some(brain) = ctx.yumon_brains.get_mut(&id) {
        if ctx.yumon_trainers.contains_key(&id) {
            return Err(deno_error::JsErrorBox::generic("Training already in progress for this brain"));
        }

        let trainer = crate::yumon::system::BackgroundTrainer::start(brain, epochs);
        ctx.yumon_trainers.insert(id, trainer);
        Ok(())
    } else {
        Err(deno_error::JsErrorBox::generic("Yumon brain not found"))
    }
}

#[op2(fast)]
pub fn op_yumon_brain_save(state: &mut OpState, #[string] id: String) -> Result<(), deno_error::JsErrorBox> {
    let ctx = state.borrow::<AddonContext>();
    let project_id = ctx.project_id.as_ref().ok_or_else(|| deno_error::JsErrorBox::generic("Project not loaded"))?;
    let yumon_dir = crate::helpers::utilities::get_yumon_dir(project_id).ok_or_else(|| deno_error::JsErrorBox::generic("Could not get yumon directory"))?;
    
    if let Some(brain) = ctx.yumon_brains.get(&id) {
        let brain_dir = yumon_dir.join(&brain.archetype_name);
        brain.save(&brain_dir).map_err(|e| deno_error::JsErrorBox::generic(format!("Failed to save brain: {}", e)))?;
        Ok(())
    } else {
        Err(deno_error::JsErrorBox::generic("Yumon brain not found"))
    }
}

#[op2(fast)]
pub fn op_yumon_brain_load(state: &mut OpState, #[string] archetype_name: String) -> Result<(), deno_error::JsErrorBox> {
    let mut ctx = state.borrow_mut::<AddonContext>();
    let project_id = ctx.project_id.as_ref().ok_or_else(|| deno_error::JsErrorBox::generic("Project not loaded"))?;
    let yumon_dir = crate::helpers::utilities::get_yumon_dir(project_id).ok_or_else(|| deno_error::JsErrorBox::generic("Could not get yumon directory"))?;
    
    let brain_dir = yumon_dir.join(&archetype_name);
    let device = Default::default();
    let brain = crate::yumon::system::YumonBrain::<crate::yumon::system::MyBackend>::load(device, &brain_dir)
        .map_err(|e| deno_error::JsErrorBox::generic(format!("Failed to load brain: {}", e)))?;
    
    ctx.yumon_brains.insert(archetype_name, brain);
    Ok(())
}

#[op2(fast)]
pub fn op_yumon_sleep(state: &mut OpState, #[string] name: String) -> Result<(), deno_error::JsErrorBox> {
    let mut ctx = state.borrow_mut::<AddonContext>();
    if let Some(sim) = ctx.yumon_sims.get_mut(&name) {
        sim.trigger_sleep();
        Ok(())
    } else {
        Err(deno_error::JsErrorBox::generic("Yumon simulation not found"))
    }
}

#[op2]
#[serde]
pub fn op_yumon_tick(state: &mut OpState, #[string] name: String) -> Result<YumonState, deno_error::JsErrorBox> {
    let mut ctx = state.borrow_mut::<AddonContext>();
    if let Some(sim) = ctx.yumon_sims.get_mut(&name) {
        sim.tick();
        
        // Auto-sleep every 3600 ticks
        if sim.tick_num > 0 && sim.tick_num % 3600 == 0 {
            println!("[Yumon] Auto-triggering sleep at tick {}", sim.tick_num);
            sim.trigger_sleep();
        }

        Ok(YumonState {
            pos: sim.world.pos,
            battery: sim.world.battery,
            health: sim.world.health,
            stamina: sim.world.stamina,
            boredom: sim.world.boredom,
            storage: sim.world.storage,
            last_action: sim.last_action_name().to_string(),
        })
    } else {
        Err(deno_error::JsErrorBox::generic("Yumon simulation not found"))
    }
}