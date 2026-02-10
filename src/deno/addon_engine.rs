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
use nalgebra::{Isometry3, UnitQuaternion, Vector3};
use uuid::Uuid;
use std::rc::Rc;
use std::cell::RefCell;
use std::path::Path;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use crate::art_assets::Model::read_model;
use crate::core::Texture::Texture;
use crate::core::gpu_resources::GpuResources;
use crate::core::addon_pipeline::{GBUFFER_FORMATS, create_addon_pipeline};
use crate::helpers::saved_data::{ComponentKind, LandscapeTextureKinds, PhysicsConfig};
use crate::procedural_grass::grass::Grass;
use wgpu::{RenderPipeline, TextureView};
use crate::shape_primitives::Cube::Cube;
use crate::core::RendererState::RendererState;
use crate::core::SimpleCamera::SimpleCamera;
use crate::core::custom_mesh::CustomMesh;
use crate::audio::AudioEngine;
use crate::helpers::utilities::get_project_dir;
use egui;
use wgpu::util::DeviceExt;
use egui_wgpu;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AddonMetadata {
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: Vec<String>,
    pub capabilities: HashMap<String, bool>,
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
    MiniMap { id: String, landscape_id: Option<String>, brush_size: f32, markers: Vec<MiniMapMarker> },
    Separator,
}



use crate::heightfield_landscapes::Landscape::Landscape;

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
    pub width: usize,
    pub height: usize,
    pub heights: Option<Vec<f32>>,
    pub noise_id: Option<String>,
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
pub struct ModelConfig {
    pub id: Option<String>,
    pub path: String,
    pub position: [f32; 3],
    pub rotation: Option<[f32; 3]>,
    pub scale: Option<[f32; 3]>,
    pub pipeline_id: Option<String>,
    pub render_role: Option<String>,
    pub physics: Option<PhysicsConfig>,
    pub player: Option<crate::helpers::saved_data::PlayerProperties>,
    pub npc: Option<crate::helpers::saved_data::NPCProperties>,
    pub behavior_id: Option<String>,
}

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

pub struct AddonContext {
    pub registered_addons: HashMap<String, AddonMetadata>,
    pub behaviors: HashMap<String, BehaviorHooks>,
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
    pub pending_cubes: Vec<(String, CubeConfig)>, // (addon_name, config)
    pub pending_models: Vec<(String, ModelConfig)>, // (addon_name, config)
    pub pending_meshes: Vec<(String, MeshConfig)>, // (addon_name, config)
    pub pending_clears: Vec<String>, // addon_names to clear meshes for
    pub pending_mesh_clears: Vec<(String, String)>, // (addon_name, mesh_id)
    pub pending_landscapes: Vec<(String, LandscapeConfig)>, // (addon_name, config)
    pub pending_grasses: Vec<(String, AddonGrassConfig)>, // (addon_name, config)
    pub pending_point_lights: Vec<(String, PointLightConfig)>,
    pub pending_composites: Vec<(String, CompositeConfig)>,
    pub pending_mesh_updates: Vec<(String, Vec<u32>, Vec<f32>)>, // (mesh_id, indices, positions)
    pub pending_sun_config: Option<ProceduralSkyConfigCC>,
    pub pending_game_mode: Option<bool>,
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
    pub registered_tools: HashMap<String, (ToolDefinition, v8::Global<v8::Function>)>,
    pub egui_textures: HashMap<String, egui::TextureId>,
    pub input_events: Vec<InputEvent>,
    pub pressed_keys: HashSet<String>,
    pub mouse_position: [f32; 2],
    pub modifiers: Modifiers,
    pub window_size: [u32; 2],
    pub selected_entity_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type")]
pub enum InputEvent {
    MouseDown { button: u32, x: f32, y: f32 },
    MouseMove { x: f32, y: f32 },
    MouseUp { button: u32 },
    KeyDown { key: String },
    KeyUp { key: String },
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
fn op_landscape_update_texture(
    state: &mut OpState,
    #[string] addon_name: String,
    #[string] texture_id: String,
    #[serde] kind: crate::helpers::saved_data::LandscapeTextureKinds,
) {
    // println!("op_landscape_update_texture");
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_landscape_texture_updates.push((addon_name, LandscapeTextureUpdate::Regular { texture_id, kind }));
    }
}

#[op2]
fn op_landscape_update_pbr_texture(
    state: &mut OpState,
    #[string] addon_name: String,
    #[string] texture_id: String,
    #[serde] kind: crate::heightfield_landscapes::Landscape::PBRTextureKind,
    #[serde] material_type: crate::heightfield_landscapes::Landscape::PBRMaterialType,
) {
    // println!("op_landscape_update_pbr_texture");
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_landscape_texture_updates.push((addon_name, LandscapeTextureUpdate::Pbr { texture_id, kind, material_type }));
    }
}

#[op2]
#[serde]
fn op_script_list(state: &mut OpState) -> Result<Vec<String>, deno_error::JsErrorBox> {
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
fn op_script_read(state: &mut OpState, #[string] filename: String) -> Result<String, deno_error::JsErrorBox> {
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
fn op_script_write(state: &mut OpState, #[string] filename: String, #[string] content: String) -> Result<(), deno_error::JsErrorBox> {
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

#[op2(fast)]
fn op_ui_widget_code_editor(
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
fn op_addon_save_data(state: &mut OpState, #[string] addon_name: String, #[string] data: String) -> Result<(), deno_error::JsErrorBox> {
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
fn op_addon_save_image(
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
fn op_texture_create_ex(
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
fn op_texture_create(
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
fn op_texture_load(
    state: &mut OpState,
    #[string] filename: String
) -> Result<String, deno_error::JsErrorBox> {
    let mut ctx = state.borrow_mut::<AddonContext>();
    if let Some(project_id) = ctx.project_id.clone() {
    
    let textures_dir = crate::helpers::utilities::get_textures_dir(&project_id)
        .ok_or_else(|| deno_error::JsErrorBox::generic("Could not resolve textures directory"))?;
            
    let file_path = textures_dir.join(filename);
    
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
fn op_texture_update(
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
fn op_addon_load_data(state: &mut OpState, #[string] addon_name: String) -> Result<String, deno_error::JsErrorBox> {
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
fn op_io_list_models(state: &mut OpState) -> Result<Vec<String>, deno_error::JsErrorBox> {
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
fn op_io_pick_and_import_model(state: &mut OpState) -> Result<String, deno_error::JsErrorBox> {
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
fn op_generate_uuid(state: &mut OpState) -> Result<String, deno_error::JsErrorBox> {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        let id = Uuid::new_v4().to_string();
        Ok(id)
    } else {
        Err(deno_error::JsErrorBox::generic("Context not available"))
    }
}

#[op2]
fn op_audio_play_synth(state: &mut OpState, #[serde] config: SynthConfig) {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.audio_engine.play_synth(config.freq, &config.waveform, config.duration, config.cutoff, config.gain);
    }
}

#[op2(fast)]
fn op_audio_play_test(state: &mut OpState) {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.audio_engine.play_test_tone();
    }
}

#[op2]
#[string]
fn op_noise_create(state: &mut OpState, #[serde] config: NoiseConfig) -> String {



    let id = format!("noise_{}", uuid::Uuid::new_v4());



    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {



        ctx.noise_generators.insert(id.clone(), config);



    }



    id



}

#[op2]
fn op_point_light_create(state: &mut OpState, #[string] addon_name: String, #[serde] config: PointLightConfig) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_point_lights.push((addon_name, config));
    }
}

#[op2]
fn op_lighting_update_sun(state: &mut OpState, #[serde] config: ProceduralSkyConfigCC) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_sun_config = Some(config);
    }
}


#[op2(fast)]
fn op_set_game_mode(state: &mut OpState, enabled: bool) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_game_mode = Some(enabled);
    }
}

#[op2]
fn op_gizmo_show(state: &mut OpState, #[serde] config: GizmoState) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.active_gizmo = Some(config);
    }
}

#[op2(fast)]
fn op_gizmo_hide(state: &mut OpState) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.active_gizmo = None;
    }
}

#[op2(fast)]
fn op_gizmo_update(state: &mut OpState, x: f32, y: f32, z: f32) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        if let Some(gizmo) = &mut ctx.active_gizmo {
            gizmo.position = [x, y, z];
        }
    }
}

#[op2]
#[serde]
fn op_input_get_state(state: &mut OpState) -> Result<AddonInputState, deno_error::JsErrorBox> {
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
pub struct AddonInputState {
    pub pressed_keys: Vec<String>,
    pub mouse_position: [f32; 2],
    pub modifiers: Modifiers,
}

#[op2]
#[serde]
fn op_camera_screen_to_world(
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
fn op_window_get_size(state: &mut OpState) -> Result<(u32, u32), deno_error::JsErrorBox> {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        Ok((ctx.window_size[0], ctx.window_size[1]))
    } else {
        Err(deno_error::JsErrorBox::generic("Context not available"))
    }
}

#[op2]
#[string]
fn op_selection_get_selected(state: &mut OpState) -> String {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        ctx.selected_entity_id.clone().unwrap_or_default()
    } else {
        String::new()
    }
}

#[op2]
#[serde]
fn op_mesh_get_data(state: &mut OpState, #[string] _mesh_id: String) -> MeshData {
    MeshData {
        vertices: Vec::new(),
        indices: Vec::new(),
        vertex_stride: 13,
    }
}

#[op2]
fn op_mesh_update_vertices(
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
fn op_grass_create(state: &mut OpState, #[string] addon_name: String, #[serde] config: AddonGrassConfig) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        // println!("Create grass xyz");
        ctx.pending_grasses.push((addon_name, config));
    }
}

#[op2]
fn op_landscape_create(state: &mut OpState, #[string] addon_name: String, #[serde] config: LandscapeConfig) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_landscapes.push((addon_name, config));
    }
}

#[op2]
fn op_system_spawn_particles(state: &mut OpState, #[serde] pos: [f32; 3], #[serde] color: [f32; 4], #[serde] gravity: [f32; 3]) {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
        let start_color = [color[0], color[1], color[2], color[3]];
        let end_color = [color[0], color[1], color[2], 0.0];
        
        let config = ScriptParticleConfig {
            emission_rate: 100.0,
            life_time: 3.0,
            radius: 0.6,
            gravity,
            initial_speed_min: 2.0,
            initial_speed_max: 5.0,
            start_color,
            end_color,
            size: 0.02,
            mode: 0.0,
            position: pos,
        };
        ctx.particle_spawns.push(config);
    }
}

#[op2(fast)]
fn op_dialogue_show(state: &mut OpState, #[string] text: String) {
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
fn op_dialogue_add_option(state: &mut OpState, #[string] text: String, #[string] next_node: String) {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
         if let Some(d) = &mut ctx.dialogue_wrapper {
            d.options.push(crate::game_ui::dialogue_state::DialogueOption { text, next_node });
            d.changed = true;
        }
    }
}

#[op2(fast)]
fn op_dialogue_start_quest(state: &mut OpState, #[string] quest_id: String) {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
         if let Some(d) = &mut ctx.dialogue_wrapper {
            d.started_quest = Some(quest_id);
        }
    }
}

#[op2(fast)]
fn op_dialogue_close(state: &mut OpState) {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
         if let Some(d) = &mut ctx.dialogue_wrapper {
            d.is_open = false;
            d.changed = true;
        }
    }
}

#[op2]
#[string]
fn op_dialogue_get_node(state: &mut OpState) -> String {
    if let Some(ctx) = state.try_borrow_mut::<EngineContext>() {
         if let Some(d) = &ctx.dialogue_wrapper {
            return d.current_node.clone();
        }
    }
    "".to_string()
}

#[op2]
fn op_behavior_register(
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
fn op_addon_register(state: &mut OpState, #[serde] metadata: AddonMetadata) {
    // println!("Registering addon: {:?}", metadata);
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.registered_addons.insert(metadata.name.clone(), metadata);
    }
}

#[op2]
fn op_addon_on_init(state: &mut OpState, #[string] addon_name: String, #[global] callback: v8::Global<v8::Function>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.on_init_callbacks.push((addon_name, callback));
    }
}

#[op2]
fn op_addon_on_all_addons_initialized(state: &mut OpState, #[global] callback: v8::Global<v8::Function>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.on_all_addons_initialized_callbacks.push(callback);
    }
}

#[op2]
fn op_addon_on_update(state: &mut OpState, #[string] addon_name: String, #[global] callback: v8::Global<v8::Function>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.on_update_callbacks.push((addon_name, callback));
    }
}

#[op2]
fn op_addon_on_cleanup(state: &mut OpState, #[string] addon_name: String, #[global] callback: v8::Global<v8::Function>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.on_cleanup_callbacks.push((addon_name, callback));
    }
}

#[op2]
#[string]
fn op_ui_create_window(state: &mut OpState, #[serde] config: UiWindowConfig, #[global] on_render: v8::Global<v8::Function>) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_windows.insert(id.clone(), (config, on_render));
    }
    id
}

#[op2]
#[string]
fn op_ui_create_tab(state: &mut OpState, #[string] addon_name: String, #[serde] config: UiTabConfig, #[global] on_render: v8::Global<v8::Function>) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let title = config.title.clone();
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_tabs.insert(id.clone(), (config, on_render, addon_name.clone()));
        ctx.new_tabs.push((id.clone(), title, addon_name));
    }
    id
}

#[op2(fast)]
fn op_ui_widget_label(state: &mut OpState, #[string] window_id: String, #[string] text: String, bold: bool) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::Label { text, bold: Some(bold) });
    }
}

#[op2(fast)]
fn op_ui_widget_button(state: &mut OpState, #[string] window_id: String, #[string] text: String, #[string] id: String) {
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
// fn op_ui_widget_color_input(state: &mut OpState, #[string] window_id: String, #[string] label: String, #[serde] color: Color, #[string] id: String) {
//     if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
//         ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::ColorInput { id, label, color: [color.r, color.g, color.b, color.a] });
//     }
// }

#[op2]
fn op_ui_widget_color_input(
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
fn op_ui_widget_slider(
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
fn op_ui_widget_numeric_input(
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
fn op_ui_widget_dropdown(
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
fn op_ui_widget_checkbox(
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
fn op_ui_widget_mini_map(
    state: &mut OpState,
    #[string] window_id: String,
    #[string] landscape_id: String,
    brush_size: f32,
    #[serde] markers: Vec<MiniMapMarker>,
    #[string] id: String,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::MiniMap { 
            id, 
            landscape_id: Some(landscape_id), 
            brush_size, 
            markers 
        });
    }
}

#[op2(fast)]
fn op_ui_widget_separator(state: &mut OpState, #[string] window_id: String) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::Separator);
    }
}

#[op2(fast)]
fn op_composer_set_role_pipeline(state: &mut OpState, #[string] role: String, #[string] pipeline_id: String) {
    let mut ctx = state.borrow_mut::<AddonContext>();
    ctx.render_roles.insert(role, pipeline_id);
}

#[op2]
#[string]
fn op_pipeline_create(state: &mut OpState, #[serde] config: PipelineConfig) -> Result<String, deno_error::JsErrorBox> {
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
fn op_buffer_create(state: &mut OpState, #[serde] config: BufferConfig) -> Result<String, deno_error::JsErrorBox> {
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
fn op_buffer_write(
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
fn op_compute_pipeline_create(state: &mut OpState, #[serde] config: ComputePipelineConfig) -> Result<String, deno_error::JsErrorBox> {
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
fn op_compute_dispatch(state: &mut OpState, #[serde] config: ComputeDispatchConfig) -> Result<(), deno_error::JsErrorBox> {
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
fn op_cube_spawn(state: &mut OpState, #[string] addon_name: String, #[serde] config: CubeConfig) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_cubes.push((addon_name, config));
    }
}

#[op2]
fn op_mesh_create(state: &mut OpState, #[string] addon_name: String, #[serde] config: MeshConfig) {
    // println!("Adding mesh?");
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_meshes.push((addon_name, config));
    }
}

#[op2]
fn op_model_load(state: &mut OpState, #[string] addon_name: String, #[serde] config: ModelConfig) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_models.push((addon_name, config));
    }
}

#[op2(fast)]
fn op_meshes_clear(state: &mut OpState, #[string] addon_name: String) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_meshes.retain(|(name, _)| name != &addon_name);
        ctx.pending_cubes.retain(|(name, _)| name != &addon_name);
        ctx.pending_models.retain(|(name, _)| name != &addon_name);
        ctx.pending_clears.push(addon_name);
    }
}

#[op2(fast)]
fn op_mesh_clear(state: &mut OpState, #[string] addon_name: String, #[string] mesh_id: String) {
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
fn op_addon_on_project_changed(
    state: &mut OpState,
    #[string] addon_name: String,
    #[global] callback: v8::Global<v8::Function>,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.on_project_changed_callbacks.push((addon_name, callback));
    }
}

#[op2]
fn op_addon_on_all_projects_loaded(
    state: &mut OpState,
    #[string] addon_name: String,
    #[global] callback: v8::Global<v8::Function>,
) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.op_addon_on_all_projects_loaded_callbacks.push((addon_name, callback));
    }
}

#[op2(fast)]
fn op_println(
    state: &mut OpState,
    #[string] msg: String
) -> Result<(), deno_error::JsErrorBox> {
    println!("[ADDON] {}", msg);
    Ok(())
}

#[op2]
#[serde]
fn op_camera_get_transform(state: &mut OpState) -> Result<([f32; 3], [f32; 3]), deno_error::JsErrorBox> {
    if let Some(ctx) = state.try_borrow::<AddonContext>() {
        Ok((ctx.camera_position, ctx.camera_direction))
    } else {
        Err(deno_error::JsErrorBox::generic("Context not available"))
    }
}

#[op2(fast)]
fn op_addon_set_visibility(state: &mut OpState, #[string] addon_name: String, visible: bool) {
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

extension!(
    entropy_addons,
    ops = [
        op_addon_register,
        op_addon_on_init,
        op_addon_on_all_addons_initialized,
        op_addon_on_update,
        op_addon_on_cleanup,
        op_pipeline_create,
        op_compute_pipeline_create,
        op_compute_dispatch,
        op_buffer_create,
        op_buffer_write,
        op_cube_spawn,
        op_model_load,
        op_mesh_create,
        op_mesh_clear,
        op_meshes_clear,
        op_landscape_create,
        op_landscape_update_texture,
        op_landscape_update_pbr_texture,
        op_grass_create,
        op_noise_create,
        op_point_light_create,
        op_composer_set_role_pipeline,
        op_lighting_update_sun,
        op_println,
        op_ui_create_window,
        op_ui_create_tab,
        op_ui_widget_label,
        op_ui_widget_button,
        op_ui_widget_color_input,
        op_ui_widget_slider,
        op_ui_widget_numeric_input,
        op_ui_widget_dropdown,
        op_ui_widget_checkbox,
        op_ui_widget_code_editor,
        op_ui_widget_mini_map,
        op_ui_widget_separator,
        op_addon_save_data,
        op_addon_save_image,
        op_io_list_models,
        op_io_pick_and_import_model,
        op_script_list,
        op_script_read,
        op_script_write,
        op_texture_create,
        op_texture_create_ex,
        op_texture_load,
        op_texture_update,
        op_addon_load_data,
        op_audio_play_synth,
        op_audio_play_test,
        op_addon_on_project_changed,
        op_addon_set_visibility,
        op_camera_get_transform,
        op_generate_uuid,
        op_register_composite_texture,
        op_addon_register_tool,
        op_addon_on_all_projects_loaded,
        op_set_game_mode,
        op_gizmo_show,
        op_gizmo_hide,
        op_gizmo_update,
        op_input_get_state,
        op_camera_screen_to_world,
        op_window_get_size,
        op_selection_get_selected,
        op_mesh_get_data,
        op_behavior_register,
        op_system_spawn_particles,
        op_dialogue_show,
        op_dialogue_add_option,
        op_dialogue_start_quest,
        op_dialogue_close,
        op_dialogue_get_node
    ],
    esm_entry_point = "ext:entropy_addons/addon_setup.js",
    esm = [ dir "src/deno", "addon_setup.js" ],
);

pub struct AddonEngine {
    pub runtime: JsRuntime,
    pub project_id: Option<String>,
    pub dummy_views: Vec<(u32, TextureView)>,  
}

const DEFAULT_ADDON_BUNDLE: &str = include_str!("../../scripts/addons/studio-bundle/dist/bundle.js");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityWrapper {
    pub id: String,
    pub position: [f32; 3],
    pub health: f32,
    pub stamina: f32,
    pub is_dead: bool,
}

impl AddonEngine {
    pub fn execute_behavior(
        &mut self,
        renderer_state: &mut RendererState,
        behavior_id: &str,
        entity_wrapper: EntityWrapper,
        hook_name: &str,
    ) {
        let behavior = {
            let state = self.runtime.op_state();
            let state = state.borrow();
            let context = state.borrow::<AddonContext>();
            context.behaviors.get(behavior_id).cloned()
        };

        if let Some(behavior) = behavior {
            let callback = match hook_name {
                "on_update" => behavior.on_update,
                "on_interact" => behavior.on_interact,
                "on_attack" => behavior.on_attack,
                _ => None,
            };

            if let Some(callback) = callback {
                // Prepare context for ops
                let context = EngineContext {
                    particle_spawns: Vec::new(),
                    dialogue_wrapper: None, // TODO: set if interact
                };
                self.runtime.op_state().borrow_mut().put(context);

                {
                    let scope = &mut self.runtime.handle_scope();
                    let local_callback = v8::Local::new(scope, callback);
                    let this = v8::undefined(scope);
                    let global = scope.get_current_context().global(scope);

                    // 1. Entity Arg
                    let entity_v8 = serde_v8::to_v8(scope, entity_wrapper).unwrap();

                    // 2. System Arg
                    let create_system_key = v8::String::new(scope, "_createSystem").unwrap();
                    let create_system_val = global.get(scope, create_system_key.into()).unwrap();
                    let create_system_func = v8::Local::<v8::Function>::try_from(create_system_val)
                        .expect("addon_setup.js should define _createSystem");
                    let system_arg = create_system_func.call(scope, global.into(), &[]).unwrap();

                    // 3. State Arg (for now just empty map or component script state)
                    let state_arg = serde_v8::to_v8(scope, HashMap::<String, String>::new()).unwrap();

                    let args = [entity_v8, system_arg, state_arg];
                    
                    let tc = &mut v8::TryCatch::new(scope);
                    local_callback.call(tc, this.into(), &args);

                    if tc.has_caught() {
                        if let Some(exception) = tc.exception() {
                            let msg = exception.to_rust_string_lossy(tc);
                            println!("[BEHAVIOR ERROR in {}] {}", behavior_id, msg);
                        }
                    }
                }

                // Process results (particles, etc.)
                let particle_spawns = {
                    let mut op_state = self.runtime.op_state();
                    let mut op_state = op_state.borrow_mut();
                    if let Some(ctx) = op_state.try_borrow_mut::<EngineContext>() {
                        std::mem::take(&mut ctx.particle_spawns)
                    } else {
                        Vec::new()
                    }
                };

                for spawn in particle_spawns {
                    let gpu_resources = self.runtime.op_state().borrow().borrow::<AddonContext>().gpu_resources.as_ref().unwrap().clone();
                    
                    let uniforms = crate::procedural_particles::particle_system::ParticleUniforms {
                        position: [spawn.position[0], spawn.position[1], spawn.position[2], 0.0],
                        time: 0.0,
                        emission_rate: spawn.emission_rate,
                        life_time: spawn.life_time,
                        radius: spawn.radius,
                        gravity: [spawn.gravity[0], spawn.gravity[1], spawn.gravity[2], 0.0],
                        initial_speed_min: spawn.initial_speed_min,
                        initial_speed_max: spawn.initial_speed_max,
                        start_color: spawn.start_color,
                        end_color: spawn.end_color,
                        size: spawn.size,
                        mode: spawn.mode,
                        target_position: [0.0, 0.0, 0.0, 0.0],
                        _pad2: [0.0; 4],
                    };
                    
                    let system = crate::procedural_particles::particle_system::ParticleSystem::new(
                        &gpu_resources.device,
                        &renderer_state.model_bind_group_layout, // Assuming model layout is compatible or use camera layout
                        uniforms,
                        500,
                        wgpu::TextureFormat::Rgba8Unorm,
                    );
                    
                    renderer_state.particle_systems.push(system);
                }
            }
        }
    }

    pub fn new(project_id: Option<String>) -> Self {
        let loader = Rc::new(FsModuleLoader);
        let ext = entropy_addons::init_ops_and_esm();
        
        let mut runtime = JsRuntime::new(RuntimeOptions {
            module_loader: Some(loader),
            extensions: vec![
                ext,
            ],
            ..Default::default()
        });

        let audio_engine = Arc::new(AudioEngine::new());

        let context = AddonContext {
            registered_addons: HashMap::new(),
            behaviors: HashMap::new(),
            gpu_resources: None,
            audio_engine,
            pipelines: HashMap::new(),
            compute_pipelines: HashMap::new(),
            pipeline_configs: HashMap::new(),
            lighting_pipelines: HashMap::new(),
            lighting_bind_groups: HashMap::new(),
            bind_group_layouts: Vec::new(),
            lighting_bind_group_layouts: Vec::new(),
            surface_format: None,
            grass_uniform_layout: None,
            landscape_particle_layout: None,
            composite_layout: None,
            pending_cubes: Vec::new(),
            pending_models: Vec::new(),
            pending_meshes: Vec::new(),
            pending_clears: Vec::new(),
            pending_mesh_clears: Vec::new(),
            pending_landscapes: Vec::new(),
            pending_grasses: Vec::new(),
                                        pending_point_lights: Vec::new(),
                                        pending_composites: Vec::new(),
                                        pending_mesh_updates: Vec::new(),
                                        pending_sun_config: None,                                                    pending_game_mode: None,
                                                    active_gizmo: None,
                                                    noise_generators: HashMap::new(),            on_init_callbacks: Vec::new(),
            on_all_addons_initialized_callbacks: Vec::new(),
            on_cleanup_callbacks: Vec::new(),
            on_update_callbacks: Vec::new(),
            on_project_changed_callbacks: Vec::new(),
            ui_windows: HashMap::new(),
            ui_tabs: HashMap::new(),
            ui_widgets: HashMap::new(),
            ui_events: Arc::new(Mutex::new(Vec::new())),
            new_tabs: Vec::new(),
            render_roles: HashMap::new(),
            project_id: project_id.clone(),
            textures: HashMap::new(),
            raw_textures: HashMap::new(),
            landscape_texture_view: None,
            addon_textures: HashMap::new(),
            pending_landscape_texture_updates: Vec::new(),
            hidden_addons: HashSet::new(),
            buffers: HashMap::new(),
            compute_encoder: None,
            current_time: 0.0,
            camera_position: [0.0, 0.0, 0.0],
            camera_direction: [0.0, 0.0, -1.0],
            camera_view: ColumnMatrix4::from([1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]),
            camera_proj: ColumnMatrix4::from([1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]),
            composite_pipelines: HashMap::new(),
            composites: Vec::new(),
            registered_tools: HashMap::new(),
            op_addon_on_all_projects_loaded_callbacks: Vec::new(),
            egui_textures: HashMap::new(),
            input_events: Vec::new(),
            pressed_keys: HashSet::new(),
            mouse_position: [0.0, 0.0],
            modifiers: Modifiers::default(),
            window_size: [1920, 1080],
            selected_entity_id: None,
        };
        runtime.op_state().borrow_mut().put(context);

        AddonEngine {
            runtime,
            project_id,
            dummy_views: Vec::new()
        }
    }

    pub fn set_project_id(&mut self, renderer_state: &RendererState, project_id: String) {
        self.project_id = Some(project_id.clone());
        
        // Update context
        {
            let mut state = self.runtime.op_state();
            let mut state = state.borrow_mut();
            let context = state.borrow_mut::<AddonContext>();
            context.project_id = Some(project_id.clone());
        }
        
        // Notify all registered callbacks
        self.notify_project_changed(renderer_state, &project_id);
    }
    
    fn notify_project_changed(&mut self, renderer_state: &RendererState,  new_project_id: &str) {
        let callbacks = {
            let state = self.runtime.op_state();
            let state = state.borrow();
            let context = state.borrow::<AddonContext>();
            context.on_project_changed_callbacks.clone()
        };
        
        for (_addon_name, callback) in callbacks {
            let scope = &mut self.runtime.handle_scope();
            let local_callback = v8::Local::new(scope, callback);
            let this = v8::undefined(scope);
            let project_id_str = v8::String::new(scope, new_project_id).unwrap();
            let args = &[project_id_str.into()];
            
            local_callback.call(scope, this.into(), args);
        }

        // Update context
        {
            let mut state = self.runtime.op_state();
            let mut state = state.borrow_mut();
            let context = state.borrow_mut::<AddonContext>();

            let mut landscape_view = renderer_state.addon_landscapes
                                                                .get("Game Composer")
                                                                .and_then(|al| al.first().and_then(|l| l.particle_texture_view.clone()));

            // maybe later
            // context.current_time = current_time;
            // context.camera_position = [camera.position.x, camera.position.y, camera.position.z];
            // context.camera_direction = [camera.direction.x, camera.direction.y, camera.direction.z];
            context.landscape_texture_view = landscape_view.clone();

            println!("---- [landscape] landscape_view {:?} {:?}", renderer_state.addon_landscapes.len(), landscape_view.is_some());
        }

        self.notify_all_projects_loaded(&new_project_id);
    }

    fn notify_all_projects_loaded(&mut self, new_project_id: &str) {
        let callbacks = {
            let state = self.runtime.op_state();
            let state = state.borrow();
            let context = state.borrow::<AddonContext>();
            context.op_addon_on_all_projects_loaded_callbacks.clone()
        };
        
        for (_addon_name, callback) in callbacks {
            let scope = &mut self.runtime.handle_scope();
            let local_callback = v8::Local::new(scope, callback);
            let this = v8::undefined(scope);
            let project_id_str = v8::String::new(scope, new_project_id).unwrap();
            let args = &[project_id_str.into()];
            
            local_callback.call(scope, this.into(), args);
        }
    }

    fn create_bindings_from_config(
        &mut self,
        gpu: &GpuResources,
        landscape_view: Option<Arc<wgpu::TextureView>>,
        pipeline: &wgpu::RenderPipeline,
        bindings: Vec<BindingConfig>,
        id: Option<String>,
        current_addon_name: String,
    ) -> (Vec<wgpu::BindGroup>, Vec<wgpu::Buffer>, Vec<wgpu::Sampler>, Option<wgpu::Buffer>) {
        let mut bind_groups = Vec::new();
        let mut uniform_buffers = Vec::new();
        let mut samplers = Vec::new();
        let mut time_buffer = None;

        let mut groups: HashMap<u32, Vec<BindingConfig>> = HashMap::new();
        for b in bindings {
            groups.entry(b.group).or_default().push(b);
        }

        let mut sorted_groups: Vec<_> = groups.into_iter().collect();
        sorted_groups.sort_by_key(|(group_num, _)| *group_num);

        for (_, group_bindings) in &mut sorted_groups {
            group_bindings.sort_by_key(|b| b.binding);
        }

        for (group_idx, binding_configs) in sorted_groups {
            // println!("get_bind_group_layout {:?} {:?} {:?}", id, group_idx, binding_configs);
            let layout = pipeline.get_bind_group_layout(group_idx);
            // println!("got it! {:?}", id);
            
            let mut created_buffers: Vec<(u32, Arc<wgpu::Buffer>)> = Vec::new();
            let mut created_samplers = Vec::new();
            let mut addon_texture_views = HashMap::new();

            // 1. Pre-fetch addon textures
            {
                let op_state = self.runtime.op_state();
                let op_state = op_state.borrow();
                if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                    for b in &binding_configs {
                        let id_str = match &b.resource {
                            ResourceType::Texture { id: Some(id) } => Some(id.clone()),
                            ResourceType::StorageTexture { id } => Some(id.clone()),
                            ResourceType::StorageTextureRgba16 { id } => Some(id.clone()),
                            ResourceType::TextureNonFilterable { id } => Some(id.clone()),
                            _ => None,
                        };
                        if let Some(id) = id_str {
                            if id != "Landscape" {
                                if let Some(view) = ctx.textures.get(&id) {
                                    addon_texture_views.insert(id, Arc::clone(view));
                                }
                            }
                        }
                    }
                }
            }

            // 2. Create buffers
            for b in &binding_configs {
                match &b.resource {
                    ResourceType::Uniform { data } => {
                        let buffer = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                            label: Some(&format!("Uniform Buffer {}:{}", group_idx, b.binding)),
                            contents: bytemuck::cast_slice(data),
                            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                        });
                        created_buffers.push((b.binding, Arc::new(buffer)));
                    },
                    ResourceType::Time => {
                        let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
                            label: Some("Time Buffer"),
                            size: std::mem::size_of::<f32>() as u64,
                            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                            mapped_at_creation: false,
                        });
                        time_buffer = Some(buffer.clone());
                        created_buffers.push((b.binding, Arc::new(buffer)));
                    },
                    ResourceType::Buffer { id } | ResourceType::Storage { id } => {
                        let op_state = self.runtime.op_state();
                        let op_state = op_state.borrow();
                        if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                            if let Some(buffer) = ctx.buffers.get(id) {
                                created_buffers.push((b.binding, Arc::clone(buffer)));
                            }
                        }
                    },
                    _ => {}
                }
            }

            let mut wgpu_entries = Vec::new();
            
            // 3. Add buffers to entries
            for (binding, buffer) in &created_buffers {
                wgpu_entries.push(wgpu::BindGroupEntry {
                    binding: *binding,
                    resource: buffer.as_entire_binding(),
                });
                
                // Keep uniform buffers alive by returning them to the caller (CustomMesh)
                uniform_buffers.push((**buffer).clone());
            }
            
            // 4. Create samplers and add textures/samplers to entries
            for b in &binding_configs {
                let id_str = match &b.resource {
                    ResourceType::Texture { id: Some(id) } => Some(id.clone()),
                    ResourceType::StorageTexture { id } => Some(id.clone()),
                    ResourceType::StorageTextureRgba16 { id } => Some(id.clone()),
                    ResourceType::TextureNonFilterable { id } => Some(id.clone()),
                    _ => None,
                };

                if let Some(id_s) = id_str {
                    if id_s == "Landscape" {
                        if let Some(texture_view) = &landscape_view {
                            // println!("----------BIND.... the good view {:?} {:?} {:?}", current_addon_name, id.clone(), id_s.clone());
                            wgpu_entries.push(wgpu::BindGroupEntry {
                                binding: b.binding,
                                resource: wgpu::BindingResource::TextureView(texture_view),
                            });
                        } else {
                            // println!("----------BIND.... the dummy view {:?}", id.clone());
                            // Fallback to dummy
                            let dummy_texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
                                label: Some("Dummy Landscape Texture"),
                                size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                                mip_level_count: 1,
                                sample_count: 1,
                                dimension: wgpu::TextureDimension::D2,
                                format: wgpu::TextureFormat::Rgba8Unorm,
                                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                                view_formats: &[],
                            });
                            gpu.queue.write_texture(
                                wgpu::TexelCopyTextureInfo {
                                    texture: &dummy_texture,
                                    mip_level: 0,
                                    origin: wgpu::Origin3d::ZERO,
                                    aspect: wgpu::TextureAspect::All,
                                },
                                &[255, 255, 255, 255],
                                wgpu::TexelCopyBufferLayout {
                                    offset: 0,
                                    bytes_per_row: Some(4),
                                    rows_per_image: None,
                                },
                                wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                            );
                            let dummy_view = dummy_texture.create_view(&wgpu::TextureViewDescriptor::default());
                            self.dummy_views.push((b.binding, dummy_view));
                            // We'll add this entry in a separate loop
                        }
                    } else {
                        // println!("----------BIND.... the bad view {:?} {:?} {:?}", current_addon_name, id.clone(), id_s.clone());
                        if let Some(view) = addon_texture_views.get(&id_s) {
                            wgpu_entries.push(wgpu::BindGroupEntry {
                                binding: b.binding,
                                resource: wgpu::BindingResource::TextureView(view.as_ref()),
                            });
                        }
                    }
                } else if let ResourceType::Sampler = &b.resource {
                    let sampler = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
                        address_mode_u: wgpu::AddressMode::ClampToEdge,
                        address_mode_v: wgpu::AddressMode::ClampToEdge,
                        address_mode_w: wgpu::AddressMode::ClampToEdge,
                        mag_filter: wgpu::FilterMode::Linear,
                        min_filter: wgpu::FilterMode::Linear,
                        mipmap_filter: wgpu::FilterMode::Nearest,
                        ..Default::default()
                    });
                    created_samplers.push((b.binding, sampler));
                }
            }

            // 5. Add dummy views
            for (binding, view) in &self.dummy_views {
                if !wgpu_entries.iter().any(|e| e.binding == *binding) {
                    wgpu_entries.push(wgpu::BindGroupEntry {
                        binding: *binding,
                        resource: wgpu::BindingResource::TextureView(view),
                    });
                }
            }
            
            // 6. Add samplers
            for (binding, sampler) in &created_samplers {
                wgpu_entries.push(wgpu::BindGroupEntry {
                    binding: *binding,
                    resource: wgpu::BindingResource::Sampler(sampler),
                });
                samplers.push(sampler.clone());
            }

            let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                layout: &layout,
                entries: &wgpu_entries,
                label: Some(&format!("Custom BindGroup {}", group_idx)),
            });
            bind_groups.push(bind_group);
            
            // Add to return uniform_buffers
            for (_, buf) in created_buffers {
                // We try to convert back to wgpu::Buffer if possible, but we might need to change return type to Arc<wgpu::Buffer>
                // For now, let's see if we can get away with this.
                // uniform_buffers.push((*buf).clone()); // Still problematic
            }
        }

        (bind_groups, uniform_buffers, samplers, time_buffer)
    }

    pub fn update(&mut self, renderer_state: &mut RendererState, camera: &SimpleCamera, current_time: f64, gpu_resources: &Arc<GpuResources>, current_addon_name: String) {
        // let landscape_view = renderer_state.landscapes.first().and_then(|l| l.particle_texture_view.clone());
        let mut landscape_view = renderer_state.addon_landscapes
                                                                .get(&current_addon_name)
                                                                .and_then(|al| al.first().and_then(|l| l.particle_texture_view.clone()));

        // Update current time in context
        {
            let mut state = self.runtime.op_state();
            let mut state = state.borrow_mut();
            let context = state.borrow_mut::<AddonContext>();
            context.current_time = current_time;
            context.camera_position = [camera.position.x, camera.position.y, camera.position.z];
            context.camera_direction = [camera.direction.x, camera.direction.y, camera.direction.z];
            context.camera_view = camera.get_view().into();
            context.camera_proj = camera.get_projection().into();
            context.landscape_texture_view = landscape_view.clone();

            // Update Input State
            if let Some(mouse_pos) = renderer_state.current_mouse_position {
                context.mouse_position = [mouse_pos.x, mouse_pos.y];
            }
            context.modifiers = Modifiers {
                shift: renderer_state.shift_active,
                ctrl: renderer_state.ctrl_active,
                alt: renderer_state.alt_active,
            };
            context.window_size = [camera.viewport.window_size.width, camera.viewport.window_size.height];
            context.selected_entity_id = renderer_state.selected_entity_id.clone();
        }

        // 0. Execute Entity Behaviors
        let mut entity_behaviors = Vec::new();
        let mut processed_ids = std::collections::HashSet::new();

        // 0.1 NPCs
        for npc in &renderer_state.npcs {
            if let Some(bid) = &npc.behavior_id {
                let pos = if let Some(rb) = renderer_state.rigid_body_set.get(npc.rigid_body_handle) {
                    let p = rb.translation();
                    [p.x, p.y, p.z]
                } else {
                    [0.0, 0.0, 0.0]
                };

                entity_behaviors.push((
                    bid.clone(),
                    EntityWrapper {
                        id: npc.id.clone(),
                        position: pos,
                        health: npc.stats.health,
                        stamina: npc.stats.stamina,
                        is_dead: npc.is_dead,
                    }
                ));
                processed_ids.insert(npc.model_id.clone());
            }
        }

        // 0.2 Models (standalone or generic)
        for model in &renderer_state.models {
            if processed_ids.contains(&model.id) { continue; }
            if let Some(bid) = &model.behavior_id {
                let pos = if let Some(mesh) = model.meshes.first() {
                    if let Some(rb_handle) = mesh.rigid_body_handle {
                        if let Some(rb) = renderer_state.rigid_body_set.get(rb_handle) {
                            let p = rb.translation();
                            [p.x, p.y, p.z]
                        } else {
                            [mesh.transform.position.x, mesh.transform.position.y, mesh.transform.position.z]
                        }
                    } else {
                        [mesh.transform.position.x, mesh.transform.position.y, mesh.transform.position.z]
                    }
                } else {
                    [0.0, 0.0, 0.0]
                };

                entity_behaviors.push((
                    bid.clone(),
                    EntityWrapper {
                        id: model.id.clone(),
                        position: pos,
                        health: 100.0,
                        stamina: 100.0,
                        is_dead: false,
                    }
                ));
                processed_ids.insert(model.id.clone());
            }
        }

        // 0.3 Collectables
        for coll in &renderer_state.collectables {
            if processed_ids.contains(&coll.id) { continue; }
            if let Some(bid) = &coll.behavior_id {
                let pos = if let Some(rb) = renderer_state.rigid_body_set.get(coll.rigid_body_handle) {
                    let p = rb.translation();
                    [p.x, p.y, p.z]
                } else {
                    [0.0, 0.0, 0.0]
                };

                entity_behaviors.push((
                    bid.clone(),
                    EntityWrapper {
                        id: coll.id.clone(),
                        position: pos,
                        health: 100.0,
                        stamina: 100.0,
                        is_dead: false,
                    }
                ));
            }
        }

        for (bid, wrapper) in entity_behaviors {
            self.execute_behavior(renderer_state, &bid, wrapper, "on_update");
        }

        // 0. Run onUpdate callbacks
        // let callbacks = {
        //     let state = self.runtime.op_state();
        //     let state = state.borrow();
        //     let context = state.borrow::<AddonContext>();
        //     context.on_update_callbacks.clone()
        // };

        // make sure to only update the current addon
        let callbacks = {
            let state = self.runtime.op_state();
            let state = state.borrow();
            let context = state.borrow::<AddonContext>();
            context
                .on_update_callbacks
                .iter()
                .filter(|(name, _)| name == &current_addon_name)
                .cloned()
                .collect::<Vec<_>>()
        };

        for (addon_name, callback) in callbacks {
            let scope = &mut self.runtime.handle_scope();
            let local_callback = v8::Local::new(scope, callback);
            let this = v8::undefined(scope);
            let time_v8 = v8::Number::new(scope, current_time);
            let pos_v8 = serde_v8::to_v8(scope, [camera.position.x, camera.position.y, camera.position.z]).unwrap();
            let dir_v8 = serde_v8::to_v8(scope, [camera.direction.x, camera.direction.y, camera.direction.z]).unwrap();
            let args = &[time_v8.into(), pos_v8, dir_v8];
            
            // Use TryCatch to avoid one addon crashing the whole loop
            let tc = &mut v8::TryCatch::new(scope);
            local_callback.call(tc, this.into(), args);
            
            if tc.has_caught() {
                if let Some(exception) = tc.exception() {
                    let msg = exception.to_rust_string_lossy(tc);
                    println!("[ADDON UPDATE ERROR in {}] {}", addon_name, msg);
                }
            }
        }

        // 1. Process UI Events
        let events = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                
                // update project id as needed
                ctx.project_id = self.project_id.clone();

                if let Ok(mut evs) = ctx.ui_events.lock() {
                    std::mem::take(&mut *evs)
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            }
        };

        if !events.is_empty() {
            let scope = &mut self.runtime.handle_scope();
            let global = scope.get_current_context().global(scope);
            let entropy_key = v8::String::new(scope, "Entropy").unwrap();
            if let Some(entropy_val) = global.get(scope, entropy_key.into()) {
                if entropy_val.is_object() {
                    let entropy_obj = entropy_val.to_object(scope).unwrap();
                    let process_key = v8::String::new(scope, "_process_events").unwrap();
                    if let Some(process_val) = entropy_obj.get(scope, process_key.into()) {
                        if process_val.is_function() {
                            let process_func = v8::Local::<v8::Function>::try_from(process_val).unwrap();
                            let args_v8 = serde_v8::to_v8(scope, events).unwrap();
                            let _ = process_func.call(scope, entropy_obj.into(), &[args_v8]);
                        }
                    }
                }
            }
        }

        // 1.5 Process Input Events
        let input_events = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                std::mem::take(&mut ctx.input_events)
            } else {
                Vec::new()
            }
        };

        if !input_events.is_empty() {
            let scope = &mut self.runtime.handle_scope();
            let global = scope.get_current_context().global(scope);
            let entropy_key = v8::String::new(scope, "Entropy").unwrap();
            if let Some(entropy_val) = global.get(scope, entropy_key.into()) {
                if entropy_val.is_object() {
                    let entropy_obj = entropy_val.to_object(scope).unwrap();
                    let process_key = v8::String::new(scope, "_process_input_events").unwrap();
                    if let Some(process_val) = entropy_obj.get(scope, process_key.into()) {
                        if process_val.is_function() {
                            let process_func = v8::Local::<v8::Function>::try_from(process_val).unwrap();
                            let args_v8 = serde_v8::to_v8(scope, input_events).unwrap();
                            let _ = process_func.call(scope, entropy_obj.into(), &[args_v8]);
                        }
                    }
                }
            }
        }

        // 2. Process pending resources
        let (pending_cubes, pending_models, pending_meshes, pending_clears, pending_mesh_clears, pending_landscapes, pending_grasses, pending_point_lights, pending_composites, pending_landscape_texture_updates, pending_game_mode) = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                (
                    std::mem::take(&mut ctx.pending_cubes),
                    std::mem::take(&mut ctx.pending_models),
                    std::mem::take(&mut ctx.pending_meshes),
                    std::mem::take(&mut ctx.pending_clears),
                    std::mem::take(&mut ctx.pending_mesh_clears),
                    std::mem::take(&mut ctx.pending_landscapes),
                    std::mem::take(&mut ctx.pending_grasses),
                    std::mem::take(&mut ctx.pending_point_lights),
                    std::mem::take(&mut ctx.pending_composites),
                    std::mem::take(&mut ctx.pending_landscape_texture_updates),
                    ctx.pending_game_mode.take()
                )
            } else {
                (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), None)
            }
        };

        if let Some(enabled) = pending_game_mode {
            renderer_state.game_mode = enabled;
        }

        // 2.1 Process Gizmo
        let gizmo_state = {
            let op_state = self.runtime.op_state();
            let op_state = op_state.borrow();
            let ctx = op_state.try_borrow::<AddonContext>();
            ctx.and_then(|c| c.active_gizmo.clone())
        };

        if let Some(gs) = gizmo_state {
            // Update internal gizmo config
            let mut config = renderer_state.gizmo.config().clone();
            config.view_matrix = crate::core::SimpleCamera::to_row_major_f64(&camera.get_view());
            config.projection_matrix = crate::core::SimpleCamera::to_row_major_f64(&camera.get_projection());
            config.viewport = transform_gizmo::Rect {
                min: (0.0, 0.0).into(),
                max: (camera.viewport.window_size.width as f32, camera.viewport.window_size.height as f32).into(),
            };
            
            config.modes = match gs.mode.as_str() {
                "translate" => transform_gizmo::GizmoMode::all_translate(),
                "rotate" => transform_gizmo::GizmoMode::all_rotate(),
                "scale" => transform_gizmo::GizmoMode::all_scale(),
                _ => transform_gizmo::GizmoMode::all_translate(),
            };

            config.orientation = match gs.space.as_str() {
                "local" => transform_gizmo::GizmoOrientation::Local,
                _ => transform_gizmo::GizmoOrientation::Global,
            };

            renderer_state.gizmo.update_config(config);

            // Create target transform for gizmo
            use transform_gizmo::math::Transform;
            use transform_gizmo::mint::{Vector3 as MintVector3, Quaternion as MintQuaternion};
            
            // For now, we only support single position from addon
            // Rotation/Scale are identity unless we expand GizmoState
            let mut transforms = vec![
                Transform::from_scale_rotation_translation(
                    MintVector3::from([1.0, 1.0, 1.0]),
                    MintQuaternion::from([0.0, 0.0, 0.0, 1.0]),
                    MintVector3::from([gs.position[0] as f64, gs.position[1] as f64, gs.position[2] as f64])
                )
            ];

            let interaction = transform_gizmo::GizmoInteraction {
                cursor_pos: (renderer_state.current_mouse_position.map(|p| p.x).unwrap_or(0.0), renderer_state.current_mouse_position.map(|p| p.y).unwrap_or(0.0)),
                dragging: renderer_state.mouse_state.is_dragging,
                drag_started: renderer_state.mouse_state.drag_started,
                ..Default::default()
            };

            if let Some((gizmo_result, new_transforms)) = renderer_state.gizmo.update(interaction, &mut transforms) {
                renderer_state.mouse_state.hovered_gizmo = true;
                
                // If it changed, trigger JS callbacks
                if let Some(new_transform) = new_transforms.first() {
                    let delta = [
                        (new_transform.translation.x as f32 - gs.position[0]),
                        (new_transform.translation.y as f32 - gs.position[1]),
                        (new_transform.translation.z as f32 - gs.position[2]),
                    ];

                    if delta[0].abs() > 0.0001 || delta[1].abs() > 0.0001 || delta[2].abs() > 0.0001 {
                        // Call JS onTransform
                        let scope = &mut self.runtime.handle_scope();
                        let global = scope.get_current_context().global(scope);
                        let entropy_key = v8::String::new(scope, "Entropy").unwrap();
                        if let Some(entropy_val) = global.get(scope, entropy_key.into()) {
                            let entropy_obj = entropy_val.to_object(scope).unwrap();
                            let gizmo_callbacks_key = v8::String::new(scope, "_entropy_gizmo_callbacks").unwrap();
                            if let Some(callbacks_val) = global.get(scope, gizmo_callbacks_key.into()) {
                                if callbacks_val.is_object() {
                                    let callbacks_obj = callbacks_val.to_object(scope).unwrap();
                                    let gizmo_id_key = v8::String::new(scope, &gs.id).unwrap();
                                    if let Some(callback_entry_val) = callbacks_obj.get(scope, gizmo_id_key.into()) {
                                        if callback_entry_val.is_object() {
                                            let callback_entry = callback_entry_val.to_object(scope).unwrap();
                                            let on_transform_key = v8::String::new(scope, "onTransform").unwrap();
                                            if let Some(on_transform_val) = callback_entry.get(scope, on_transform_key.into()) {
                                                if on_transform_val.is_function() {
                                                    let on_transform_func = v8::Local::<v8::Function>::try_from(on_transform_val).unwrap();
                                                    let delta_v8 = serde_v8::to_v8(scope, delta).unwrap();
                                                    let _ = on_transform_func.call(scope, entropy_obj.into(), &[delta_v8]);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // If drag ended, call onComplete
                if !renderer_state.mouse_state.is_dragging && renderer_state.last_frame_time.is_some() {
                    // We need a better way to detect drag end here, renderer_state might not have enough info
                    // but we can check if it WAS dragging in previous frame.
                    // Actually transform_gizmo result might have it.
                }
            } else {
                renderer_state.mouse_state.hovered_gizmo = false;
            }
        }

        if !pending_clears.is_empty() {
            for addon_name in pending_clears {
                renderer_state.addon_meshes.remove(&addon_name);
                renderer_state.addon_cubes.remove(&addon_name);
                renderer_state.addon_models.remove(&addon_name);
                // Also clear models belonging to this addon
                renderer_state.models.retain(|m| !m.id.starts_with(&format!("{}_", addon_name)));
            }
        }

        if !pending_mesh_clears.is_empty() {
            for (addon_name, mesh_id) in pending_mesh_clears {
                if let Some(meshes) = renderer_state.addon_meshes.get_mut(&addon_name) {
                    meshes.retain(|m| m.id != mesh_id);
                }
                if let Some(models) = renderer_state.addon_models.get_mut(&addon_name) {
                    models.retain(|m| m.id != mesh_id);
                }
                // Also clear models
                renderer_state.models.retain(|m| m.id != mesh_id);
            }
        }

        if !pending_point_lights.is_empty() {
            for (addon_name, config) in pending_point_lights {
                let pl = crate::core::editor::PointLight {
                    position: config.position,
                    _padding1: 0,
                    color: config.color,
                    _padding2: 0,
                    intensity: config.intensity,
                    max_distance: config.max_distance,
                    _padding3: [0; 2],
                };
                renderer_state.addon_point_lights
                    .entry(addon_name)
                    .or_insert_with(Vec::new)
                    .push(pl);
            }
        }

        if !pending_composites.is_empty() {
            if let Some(gpu) = &renderer_state.gpu_resources {
                for (_addon_name, config) in pending_composites {
                    let (pipeline, texture_view) = {
                        let op_state = self.runtime.op_state();
                        let op_state = op_state.borrow();
                        if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                            let p = ctx.composite_pipelines.get(&config.pipeline_id).or_else(|| ctx.pipelines.get(&config.pipeline_id)).cloned();
                            let t = ctx.textures.get(&config.texture_id).cloned();
                            (p, t)
                        } else {
                            (None, None)
                        }
                    };

                    // println!("Pending Composites... {:?} {:?} {:?}", pipeline.is_some(), texture_view.is_some(), config);

                    if let (Some(pipeline), Some(texture_view)) = (pipeline, texture_view) {
                         let (bind_groups, uniform_buffers, samplers, time_buffer) = if let Some(bindings) = config.bindings {
                             self.create_bindings_from_config(gpu, landscape_view.clone(), &pipeline, bindings, Some(config.name.clone()), current_addon_name.clone())
                         } else {
                             (Vec::new(), Vec::new(), Vec::new(), None)
                         };
                         

                         let mut op_state = self.runtime.op_state();
                         let mut op_state = op_state.borrow_mut();
                         if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                             ctx.composites.push(CompositeInstance {
                                 name: config.name,
                                 texture_view,
                                 pipeline,
                                 bind_groups,
                                 uniform_buffers,
                                 samplers,
                                 time_buffer,
                             });
                         }
                    }
                }
            }
        }

        if !pending_cubes.is_empty() {
            if let Some(gpu) = &renderer_state.gpu_resources {
                for (addon_name, config) in pending_cubes {
                    let mut cube = Cube::new(
                        &gpu.device,
                        &gpu.queue,
                        &renderer_state.model_bind_group_layout,
                        &renderer_state.group_bind_group_layout,
                        &renderer_state.texture_render_mode_buffer,
                        camera
                    );
                    cube.transform.update_position(config.position);
                    cube.transform.update_scale(config.scale);
                    cube.pipeline_id = config.pipeline_id;
                    cube.render_role = config.render_role;
                    
                    renderer_state.addon_cubes
                        .entry(addon_name)
                        .or_insert_with(Vec::new)
                        .push(cube);
                }
            }
        }

        if !pending_models.is_empty() {
            if let gpu= &gpu_resources {
                for (addon_name, config) in pending_models {
                    if let Some(project_id) = self.project_id.clone() {
                    let id = config.id.unwrap_or_else(|| format!("{}_{}", addon_name, uuid::Uuid::new_v4()));
                    
                    let pos = Vector3::new(config.position[0], config.position[1], config.position[2]);
                    let rot = config.rotation.unwrap_or([0.0, 0.0, 0.0]);
                    let rot_quat = UnitQuaternion::from_euler_angles(rot[0], rot[1], rot[2]);
                    let isometry = Isometry3::from_parts(pos.into(), rot_quat);
                    let scale_val = config.scale.unwrap_or([1.0, 1.0, 1.0]);
                    let scale = Vector3::new(scale_val[0], scale_val[1], scale_val[2]);

                    let bytes = crate::art_assets::Model::read_model(project_id, config.path).expect("Couldn't get model bytes");

                    renderer_state.add_addon_model(
                        &addon_name,
                        &gpu.device,
                        &gpu.queue,
                        &id,
                        &bytes,
                        isometry,
                        scale,
                        camera,
                        false,
                        None,
                        config.physics,
                        config.behavior_id.clone()
                    );

                    if let Some(player_props) = config.player {
                        renderer_state.add_player_character(
                            &gpu.device,
                            &gpu.queue,
                            id.clone(),
                            isometry,
                            scale,
                            camera,
                            player_props
                        );
                    } else if let Some(npc_props) = config.npc {
                        renderer_state.add_npc(
                            id.clone(),
                            npc_props,
                            config.behavior_id
                        );
                    } else {
                        renderer_state.add_collider(id.clone(), crate::helpers::saved_data::ComponentKind::Model);
                    }

                    if let Some(models) = renderer_state.addon_models.get_mut(&addon_name) {
                        if let Some(model) = models.iter_mut().find(|m| m.id == id) {
                            for mesh in &mut model.meshes {
                                mesh.render_role = config.render_role.clone();
                            }
                        }
                    }
                }
                }
            }
        }

        if !pending_meshes.is_empty() {
            if let Some(gpu) = &renderer_state.gpu_resources {
                for (addon_name, config) in pending_meshes {
                     let pipeline = {
                         let op_state = self.runtime.op_state();
                         let op_state = op_state.borrow();
                         if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                                 ctx.pipelines.get(&config.pipeline_id).cloned()
                         } else {
                             None
                         }
                     };
                     
                     if let Some(pipeline) = pipeline {
                         let (bind_groups, uniform_buffers, samplers, time_buffer) = if let Some(bindings) = config.bindings {
                             self.create_bindings_from_config(gpu, landscape_view.clone(), &pipeline, bindings, config.id.clone(), current_addon_name.clone())
                         } else {
                             (Vec::new(), Vec::new(), Vec::new(), None)
                         };
                         
                         // Create Mesh
                         let vertex_bytes: &[u8] = bytemuck::cast_slice(&config.vertex_data);
                         let index_bytes: &[u8] = bytemuck::cast_slice(&config.index_data);

                         let id = config.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

                         let mut mesh = CustomMesh::new(
                             &gpu.device,
                             &gpu.queue,
                             vertex_bytes,
                             index_bytes,
                             pipeline,
                             config.pipeline_id.clone(),
                             bind_groups,
                             config.position,
                             id.clone(),
                             uniform_buffers,
                             samplers,
                             config.instance_count.unwrap_or(1),
                             time_buffer,

                             &renderer_state.model_bind_group_layout,
                             &renderer_state.texture_render_mode_buffer,
                             &renderer_state.group_bind_group_layout,
                             camera
                         );
                         
                         if let Some(rotation) = config.rotation {
                             mesh.transform.update_rotation(rotation);
                         }
                         if let Some(scale) = config.scale {
                             mesh.transform.update_scale(scale);
                         }
                         
                         mesh.render_role = config.render_role;

                         let meshes = renderer_state.addon_meshes.entry(addon_name).or_insert_with(Vec::new);
                         if let Some(pos) = meshes.iter().position(|m| m.id == id) {
                             meshes[pos] = mesh;
                         } else {
                             meshes.push(mesh);
                         }
                     }
                }
            }
        }

        if !pending_landscapes.is_empty() {
            if let Some(gpu) = &renderer_state.gpu_resources {
                for (addon_name, config) in pending_landscapes {
                    let mut heights = config.heights;

                    // If noise_id is provided, generate heights on the Rust side
                    if heights.is_none() {
                        if let Some(noise_id) = &config.noise_id {
                            let mut op_state = self.runtime.op_state();
                            let op_state = op_state.borrow();
                            if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                                if let Some(noise_config) = ctx.noise_generators.get(noise_id) {
                                    // Instantiate noise
                                    let fbm = Fbm::<Perlin>::new(noise_config.seed)
                                        .set_frequency(noise_config.frequency)
                                        .set_octaves(noise_config.octaves)
                                        .set_persistence(noise_config.persistence)
                                        .set_lacunarity(noise_config.lacunarity);
                                    
                                    let mut generated_heights = Vec::with_capacity(config.width * config.height);
                                    for y in 0..config.height {
                                        for x in 0..config.width {
                                            let val = fbm.get([x as f64, y as f64]);
                                            generated_heights.push(((val + 1.0) / 2.0) as f32);
                                        }
                                    }
                                    heights = Some(generated_heights);
                                }
                            }
                        }
                    }

                    if let Some(heights) = heights {
                        let mut scaled_like_image = Vec::new();
                        // 1. Find the current range
                        if !heights.is_empty() {
                            let mut min_h = heights[0];
                            let mut max_h = heights[0];
                            
                            for &h in &heights {
                                if h < min_h { min_h = h; }
                                if h > max_h { max_h = h; }
                            }

                            let range = max_h - min_h;

                            // 2. Scale the values
                            if range > 0.0 {
                                for h in heights.iter() {
                                    scaled_like_image.push((*h - min_h) / range);
                                }
                            } else {
                                // If all heights are the same (range == 0), 
                                // set them all to 0.0 (a flat plain)
                                scaled_like_image.fill(0.0);
                            }
                        }

                        let data = crate::helpers::landscapes::generate_landscape_data(
                            config.width,
                            config.height,
                            // heights,
                            scaled_like_image,
                            1024.0 * 4.0, // square_size
                            1024.0 * 4.0, // square_size
                            150.0 * 4.0,  // square_height
                        );

                        let id = config.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());

                        let landscape = Landscape::new(
                            &id,
                            &data,
                            &gpu.device,
                            &gpu.queue,
                            &renderer_state.model_bind_group_layout,
                            &renderer_state.group_bind_group_layout,
                            &renderer_state.texture_render_mode_buffer,
                            &renderer_state.color_render_mode_buffer,
                            config.position,
                            camera,
                            config.pipeline_id
                        );
                        let mut landscape = landscape;
                        landscape.render_role = config.render_role;

                        // let landscapes = renderer_state.addon_landscapes.entry(addon_name).or_insert_with(Vec::new);
                        // if let Some(pos) = landscapes.iter().position(|l| l.id == id) {
                        //     landscapes[pos] = landscape;
                        // } else {
                        //     landscapes.push(landscape);
                        // }

                        // let mut landscape_bind_group = None;
                        
                            // println!("read heightmap {:?} {:?} {:?}", self.project_id.to_string(), land.id.clone(), land.heightmap_filename.clone());
                            // not good for dynamic texture
                                // let heightmap_texture = read_landscape_heightmap_as_texture(self.project_id.to_string(), land.id.clone(), land.heightmap_filename.clone());
                                    
                                if let Some(texture) = landscape.heightmap_texture.clone() { // possibly an expensive clone, although infrequent
                                    // let texture = Texture::new(texture_data.bytes, texture_data.width, texture_data.height);
                                    // println!("LANDSCAPPPPE update_particle_texture");

                                    landscape.update_particle_texture(
                                        &gpu.device,
                                        &gpu.queue,
                                        &renderer_state.model_bind_group_layout,
                                        &renderer_state.texture_render_mode_buffer,
                                        &renderer_state.color_render_mode_buffer,
                                        LandscapeTextureKinds::Primary,
                                        &texture,
                                    );

                                    // landscape.create_layout_for_particles(&gpu.device);
                                    // landscape_bind_group = Some(land.create_particle_bind_group(&gpu.device));

                                } else {
                                    println!("error Loading heightmap");
                                }
                            

                        // we only want 1 landscape to render at any given time
                        renderer_state.addon_landscapes
                            .insert(addon_name, vec![landscape]);
                    }
                }
            }
        }

        if !pending_landscape_texture_updates.is_empty() {
            

            if let Some(gpu) = &renderer_state.gpu_resources {
                // println!("renderer_state landscapes... {:?}", renderer_state.addon_landscapes.keys());

                for (addon_name, update) in pending_landscape_texture_updates {
                    if let Some(landscapes) = renderer_state.addon_landscapes.get_mut(&addon_name) {
                        for landscape in landscapes {
                            // Find texture data
                            let texture_data = {
                                let op_state = self.runtime.op_state();
                                let op_state = op_state.borrow();
                                let ctx = op_state.borrow::<AddonContext>();
                                match update {
                                    LandscapeTextureUpdate::Regular { ref texture_id, .. } => ctx.addon_textures.get(texture_id).cloned(),
                                    LandscapeTextureUpdate::Pbr { ref texture_id, .. } => ctx.addon_textures.get(texture_id).cloned(),
                                }
                            };

                            // println!("renderer_state.addon_landscapes {:?}", addon_name);

                            if let Some(texture) = texture_data {
                                match update {
                                    LandscapeTextureUpdate::Regular { kind, .. } => {
                                        landscape.update_texture(
                                            &gpu.device,
                                            &gpu.queue,
                                            &renderer_state.model_bind_group_layout, // Wait, is this the right layout? Landscape.rs says texture_bind_group_layout
                                            &renderer_state.texture_render_mode_buffer,
                                            &renderer_state.color_render_mode_buffer,
                                            kind,
                                            &texture
                                        );
                                    },
                                    LandscapeTextureUpdate::Pbr { kind, material_type, .. } => {
                                        landscape.update_pbr_texture(
                                            &gpu.device,
                                            &gpu.queue,
                                            &renderer_state.model_bind_group_layout,
                                            &renderer_state.texture_render_mode_buffer,
                                            &renderer_state.color_render_mode_buffer,
                                            kind,
                                            material_type,
                                            &texture
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if !pending_grasses.is_empty() {
            if let Some(gpu) = &renderer_state.gpu_resources {
                for (addon_name, config) in pending_grasses {
                    let mut updated = false;

                    let landscape = renderer_state.addon_landscapes
                                                                .get_mut(&current_addon_name);


                    // let mut landscape_bind_group = None;
                    if let Some(terrain) = landscape {
                        // println!("LANDSCAPPPPE COOOUNNNTTT {:?}", terrain.len());

                       if let Some(land)  = terrain.first_mut() {
                        // println!("read heightmap {:?} {:?} {:?}", self.project_id.to_string(), land.id.clone(), land.heightmap_filename.clone());
                        // not good for dynamic texture
                            // let heightmap_texture = read_landscape_heightmap_as_texture(self.project_id.to_string(), land.id.clone(), land.heightmap_filename.clone());
                                
                            if let Some(texture) = land.heightmap_texture.clone() { // possibly an expensive clone, although infrequent
                                // let texture = Texture::new(texture_data.bytes, texture_data.width, texture_data.height);
                                // println!("LANDSCAPPPPE update_particle_texture");

                                land.update_particle_texture(
                                    &gpu.device,
                                    &gpu.queue,
                                    &renderer_state.model_bind_group_layout,
                                    &renderer_state.texture_render_mode_buffer,
                                    &renderer_state.color_render_mode_buffer,
                                    LandscapeTextureKinds::Primary,
                                    &texture,
                                );

                                // land.create_layout_for_particles(&gpu.device);
                                // landscape_bind_group = Some(land.create_particle_bind_group(&gpu.device));

                            } else {
                                println!("error Loading heightmap");
                            }
                        }
                    }

                    // println!("LANDSCAPPPPE landscape_view {:?}", landscape_view.is_some());                
                    
                    // 1. Try to find and update existing instance
                    if let Some(id) = &config.id {
                        if let Some(grasses) = renderer_state.addon_grasses.get_mut(&addon_name) {
                            if let Some(grass) = grasses.iter_mut().find(|g| g.id.as_ref() == Some(id)) {
                                // Update existing instance
                                if let Some(grid_size) = config.grid_size { grass.config.grid_size = grid_size; }
                                if let Some(render_distance) = config.render_distance { grass.config.render_distance = render_distance; }
                                if let Some(wind_strength) = config.wind_strength { grass.config.wind_strength = wind_strength; }
                                if let Some(wind_speed) = config.wind_speed { grass.config.wind_speed = wind_speed; }
                                if let Some(blade_height) = config.blade_height { grass.config.blade_height = blade_height; }
                                if let Some(blade_width) = config.blade_width { grass.config.blade_width = blade_width; }
                                if let Some(brownian_strength) = config.brownian_strength { grass.config.brownian_strength = brownian_strength; }
                                if let Some(blade_density) = config.blade_density { grass.config.blade_density = blade_density; }
                                if let Some(landscape_size) = config.landscape_size { grass.config.landscape_size = landscape_size; }
                                if let Some(landscape_height) = config.landscape_height { grass.config.landscape_height = landscape_height; }
                                if let Some(landscape_y_offset) = config.landscape_y_offset { grass.config.landscape_y_offset = landscape_y_offset; }
                                if let Some(base_color) = config.base_color { grass.config.base_color = base_color; }
                                if let Some(tip_color) = config.tip_color { grass.config.tip_color = tip_color; }
                                if config.render_role.is_some() { grass.render_role = config.render_role.clone(); }

                                // Update bindings if provided
                                if let Some(bindings) = config.bindings.clone() {
                                    let (new_bind_groups, new_uniform_buffers, new_samplers, time_buffer) = self.create_bindings_from_config(gpu, landscape_view.clone(), &grass.render_pipeline, bindings, Some(id.clone()), current_addon_name.clone());
                                    grass.bind_groups = new_bind_groups;
                                    grass.uniform_buffers = new_uniform_buffers;
                                    grass.samplers = new_samplers;
                                }

                                // Update pipeline if requested
                                if let Some(pid) = &config.pipeline_id {
                                    let mut op_state = self.runtime.op_state();
                                    let op_state = op_state.borrow();
                                    if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                                        if let Some(p) = ctx.pipelines.get(pid) {
                                            grass.render_pipeline = Arc::clone(p);
                                        }
                                    }
                                }

                                // println!("update hair {:?} {:?}", grass.config.base_color, grass.config.tip_color);

                                grass.update_config(&gpu.queue, grass.config);
                                updated = true;
                            }
                        }
                    }

                    if updated { continue; }

                    // 2. Create new instance if not found
                    let (custom_pipeline, camera_layout) = {
                        let mut op_state = self.runtime.op_state();
                        let op_state = op_state.borrow();
                        if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                            let cp = config.pipeline_id.as_ref()
                                .and_then(|id| ctx.pipelines.get(id))
                                .map(|p| Arc::clone(p));
                            let cl = Arc::clone(&ctx.bind_group_layouts[0]);
                            (cp, cl)
                        } else {
                            (None, renderer_state.group_bind_group_layout.clone()) // fallback
                        }
                    };

                    let mut grass = Grass::new_without_landscape(
                        &gpu.device,
                        &gpu.queue,
                        &camera_layout,
                        custom_pipeline.clone()
                    );  

                    // if let Some(bg) = landscape_bind_group {
                    //     println!("binding grass to landscape");
                    //     grass.landscape_bind_group = bg;
                    // }

                    // since its a dynamic texture, we dont want it to autoload from file here
                    if let Some(landscape) = renderer_state.addon_landscapes
                                                                .get_mut(&current_addon_name) {
                        if let Some(landscape) = landscape.first_mut() {
                            // println!("binding grass to landscape landscape_view!!! {:?}", current_addon_name.clone());

                            grass = Grass::new(&gpu.device, &camera_layout, landscape, custom_pipeline);
                        }
                    }

                    landscape_view = renderer_state.addon_landscapes
                                        .get(&current_addon_name)
                                        .and_then(|al| al.first().and_then(|l| l.particle_texture_view.clone()));


                    grass.id = config.id.clone();
                    grass.addon_name = Some(addon_name.clone());
                    grass.pipeline_id = config.pipeline_id.clone();
                    grass.render_role = config.render_role.clone();

                    // Apply config overrides
                    if let Some(grid_size) = config.grid_size { grass.config.grid_size = grid_size; }
                    if let Some(render_distance) = config.render_distance { grass.config.render_distance = render_distance; }
                    if let Some(wind_strength) = config.wind_strength { grass.config.wind_strength = wind_strength; }
                    if let Some(wind_speed) = config.wind_speed { grass.config.wind_speed = wind_speed; }
                    if let Some(blade_height) = config.blade_height { grass.config.blade_height = blade_height; }
                    if let Some(blade_width) = config.blade_width { grass.config.blade_width = blade_width; }
                    if let Some(brownian_strength) = config.brownian_strength { grass.config.brownian_strength = brownian_strength; }
                    if let Some(blade_density) = config.blade_density { grass.config.blade_density = blade_density; }
                    if let Some(landscape_size) = config.landscape_size { grass.config.landscape_size = landscape_size; }
                    if let Some(landscape_height) = config.landscape_height { grass.config.landscape_height = landscape_height; }
                    if let Some(landscape_y_offset) = config.landscape_y_offset { grass.config.landscape_y_offset = landscape_y_offset; }
                    if let Some(base_color) = config.base_color { grass.config.base_color = base_color; }
                    if let Some(tip_color) = config.tip_color { grass.config.tip_color = tip_color; }

                    if let Some(bindings) = config.bindings {
                        let (new_bind_groups, new_uniform_buffers, new_samplers, time_buffer) = self.create_bindings_from_config(gpu, landscape_view.clone(), &grass.render_pipeline, bindings, config.id, current_addon_name.clone());
                        grass.bind_groups = new_bind_groups;
                        grass.uniform_buffers = new_uniform_buffers;
                        grass.samplers = new_samplers;
                    }

                    grass.update_config(&gpu.queue, grass.config);

                    renderer_state.addon_grasses
                        .entry(addon_name)
                        .or_insert_with(Vec::new)
                        .push(grass);
                }
            }
        }    
    }

    pub fn set_resources(
        &mut self, 
        gpu_resources: Arc<GpuResources>, 
        bind_group_layouts: Vec<Arc<wgpu::BindGroupLayout>>,
        lighting_bind_group_layouts: Vec<Arc<wgpu::BindGroupLayout>>,
        surface_format: wgpu::TextureFormat,
    ) {
        let mut op_state = self.runtime.op_state();
        let mut op_state = op_state.borrow_mut();
        if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
            ctx.gpu_resources = Some(gpu_resources);
            ctx.bind_group_layouts = bind_group_layouts;
            ctx.lighting_bind_group_layouts = lighting_bind_group_layouts;
            ctx.surface_format = Some(surface_format);
        }
    }

    pub async fn load_addon(&mut self, addon_path: &Path) -> Result<ModuleId, AnyError> {
        let addon_url = format!("file:///{}", addon_path.to_string_lossy().replace("\"", "/"));
        let module_specifier = ModuleSpecifier::parse(&addon_url)?;
        let module_id = self.runtime.load_main_es_module(&module_specifier).await?;
        let _ = self.runtime.mod_evaluate(module_id).await?;

        self.run_on_init();
        self.run_on_all_addons_initialized();

        Ok(module_id)
    }

    pub fn load_default_bundle(&mut self) {
        if let Err(e) = self.load_bundle_sync("Default Bundle", DEFAULT_ADDON_BUNDLE) {
            println!("Failed to load default bundle: {}", e);
        }
    }

    pub fn load_bundle_sync(&mut self, name: &'static str, source: &str) -> Result<(), AnyError> {
        self.runtime.execute_script(name, source.to_string())?;
        self.run_on_init();
        println!("ALL ADDONS INITIALIZED - RUN CALLBACKS");
        self.run_on_all_addons_initialized();
        Ok(())
    }

    fn run_on_init(&mut self) {
        // Execute onInit callbacks
        let callbacks = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                std::mem::take(&mut ctx.on_init_callbacks)
            } else {
                Vec::new()
            }
        };

        if !callbacks.is_empty() {
            let scope = &mut self.runtime.handle_scope();
            for (_addon_name, callback) in callbacks {
                let func = v8::Local::new(scope, callback);
                let receiver = v8::undefined(scope);
                let _ = func.call(scope, receiver.into(), &[]);
            }
        }
    }

    fn run_on_all_addons_initialized(&mut self) {
        let callbacks = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                std::mem::take(&mut ctx.on_all_addons_initialized_callbacks)
            } else {
                Vec::new()
            }
        };

        if !callbacks.is_empty() {
            let scope = &mut self.runtime.handle_scope();
            for callback in callbacks {
                let func = v8::Local::new(scope, callback);
                let receiver = v8::undefined(scope);
                let _ = func.call(scope, receiver.into(), &[]);
            }
        }
    }

    // fn run_on_all_addons_initialized(&mut self) {
    //     let callbacks = {
    //         let mut op_state = self.runtime.op_state();
    //         let mut op_state = op_state.borrow_mut();
    //         if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
    //             std::mem::take(&mut ctx.on_all_addons_initialized_callbacks)
    //         } else {
    //             Vec::new()
    //         }
    //     };

    //     if !callbacks.is_empty() {
    //         let scope = &mut self.runtime.handle_scope();
    //         for callback in callbacks {
    //             let func = v8::Local::new(scope, callback);
    //             let receiver = v8::undefined(scope);
    //             let _ = func.call(scope, receiver.into(), &[]);
    //         }
    //     }
    // }

    pub fn get_registered_addons(&mut self) -> Vec<AddonMetadata> {
        let op_state = self.runtime.op_state();
        let op_state = op_state.borrow();
        if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
            ctx.registered_addons.values().cloned().collect()
        } else {
            Vec::new()
        }
    }

    pub fn get_registered_tools(&mut self) -> Vec<ToolDefinition> {
        let op_state = self.runtime.op_state();
        let op_state = op_state.borrow();
        if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
            ctx.registered_tools.values().map(|(def, _)| def.clone()).collect()
        } else {
            Vec::new()
        }
    }

    pub fn call_tool(&mut self, name: &str, arguments: &str) -> Option<String> {
        let callback = {
            let op_state = self.runtime.op_state();
            let op_state = op_state.borrow();
            if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                ctx.registered_tools.get(name).map(|(_, cb)| cb.clone())
            } else {
                None
            }
        };

        if let Some(callback) = callback {
            let scope = &mut self.runtime.handle_scope();
            let tc = &mut v8::TryCatch::new(scope);
            let func = v8::Local::new(tc, callback);
            let receiver = v8::undefined(tc);

            // Log raw arguments for debugging
            println!("[TOOL CALL: {}] Raw arguments: {}", name, arguments);
            
            let args_json: serde_json::Value = serde_json::from_str(arguments).unwrap_or(serde_json::Value::Null);
            let args_v8 = serde_v8::to_v8(tc, args_json).unwrap();
            
            let result = func.call(tc, receiver.into(), &[args_v8]);
            
            if tc.has_caught() {
                if let Some(exception) = tc.exception() {
                    let msg = exception.to_rust_string_lossy(tc);
                    println!("[TOOL ERROR: {}] {}", name, msg);
                    return Some(format!("Error: {}", msg));
                }
            }

            if let Some(res) = result {
                if res.is_string() {
                    return Some(res.to_rust_string_lossy(tc));
                } else if res.is_object() || res.is_array() {
                    // Try to stringify
                    let json_key = v8::String::new(tc, "JSON").unwrap();
                    let json_obj = tc.get_current_context().global(tc).get(tc, json_key.into()).unwrap().to_object(tc).unwrap();
                    let stringify_key = v8::String::new(tc, "stringify").unwrap();
                    let stringify_func = v8::Local::<v8::Function>::try_from(json_obj.get(tc, stringify_key.into()).unwrap()).unwrap();
                    let json_str = stringify_func.call(tc, json_obj.into(), &[res]).unwrap();
                    return Some(json_str.to_rust_string_lossy(tc));
                } else {
                    return Some(res.to_rust_string_lossy(tc));
                }
            }
        }
        
        None
    }

    pub fn consume_new_tabs(&mut self) -> Vec<(String, String, String)> {
        let mut op_state = self.runtime.op_state();
        let mut op_state = op_state.borrow_mut();
        if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
            std::mem::take(&mut ctx.new_tabs)
        } else {
            Vec::new()
        }
    }

    pub fn render_ui(&mut self, ctx: &egui::Context, egui_renderer: &mut egui_wgpu::Renderer) {
        // 0. Reset widget counter in JS
        {
            let scope = &mut self.runtime.handle_scope();
            let global = scope.get_current_context().global(scope);
            let entropy_key = v8::String::new(scope, "Entropy").unwrap();
            if let Some(entropy_val) = global.get(scope, entropy_key.into()) {
                if entropy_val.is_object() {
                    let entropy_obj = entropy_val.to_object(scope).unwrap();
                    let reset_key = v8::String::new(scope, "_reset_widget_counter").unwrap();
                    if let Some(reset_val) = entropy_obj.get(scope, reset_key.into()) {
                        if reset_val.is_function() {
                            let reset_func = v8::Local::<v8::Function>::try_from(reset_val).unwrap();
                            let _ = reset_func.call(scope, entropy_obj.into(), &[]);
                        }
                    }
                }
            }
        }

        // 1. Prepare: Clear widgets
        {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                 context.ui_widgets.clear();
            }
        }
    
        {
            // 2. Execute JS callbacks to populate widgets
            let callbacks = {
                let mut op_state = self.runtime.op_state();
                let mut op_state = op_state.borrow_mut();
                if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                    let mut windows: Vec<_> = context.ui_windows.iter().map(|(id, (_, cb))| (id.clone(), cb.clone())).collect();
                    windows.sort_by(|a, b| a.0.cmp(&b.0));
                    windows
                } else {
                    Vec::new()
                }
            };
        
            let scope = &mut self.runtime.handle_scope();
            let tc = &mut v8::TryCatch::new(scope);
            for (_id, cb) in callbacks {
                // Reset widget counter for each window
                {
                    let global = tc.get_current_context().global(tc);
                    let entropy_key = v8::String::new(tc, "Entropy").unwrap();
                    if let Some(entropy_val) = global.get(tc, entropy_key.into()) {
                        if entropy_val.is_object() {
                            let entropy_obj = entropy_val.to_object(tc).unwrap();
                            let reset_key = v8::String::new(tc, "_reset_widget_counter").unwrap();
                            if let Some(reset_val) = entropy_obj.get(tc, reset_key.into()) {
                                if reset_val.is_function() {
                                    let reset_func = v8::Local::<v8::Function>::try_from(reset_val).unwrap();
                                    let _ = reset_func.call(tc, entropy_obj.into(), &[]);
                                }
                            }
                        }
                    }
                }

                let func = v8::Local::new(tc, cb);
                let receiver = v8::undefined(tc);
                let _ = func.call(tc, receiver.into(), &[]); 
                
                if tc.has_caught() {
                    if let Some(exception) = tc.exception() {
                        let msg = exception.to_rust_string_lossy(tc);
                        println!("[ADDON UI ERROR] {}", msg);
                    }
                    tc.reset();
                }
            }
        }
        
        // 3. Render
        let mut events_to_push = Vec::new();
        {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                let mut sorted_windows: Vec<_> = context.ui_windows.iter().collect();
                sorted_windows.sort_by(|a, b| a.0.cmp(b.0));

                for (id, (config, _)) in sorted_windows {
                    let mut open = true;
                    egui::Window::new(&config.title)
                        .id(egui::Id::new(id))
                        .resizable(config.resizable)
                        .default_size([config.default_size.width, config.default_size.height])
                        .open(&mut open)
                        .show(ctx, |ui| {
                             if let Some(widgets) = context.ui_widgets.get(id) {
                                 for widget in widgets {
                                     match widget {
                                         UiWidget::Label { text, bold } => {
                                             let mut txt = egui::RichText::new(text);
                                             if bold.unwrap_or(false) { txt = txt.strong(); }
                                             ui.label(txt);
                                         }
                                         UiWidget::Button { text, id: btn_id, label: _ } => {
                                             if ui.button(text).clicked() {
                                                 events_to_push.push(btn_id.clone());
                                             }
                                         }
                                         UiWidget::ColorInput { id: color_id, label, color } => {
                                             ui.horizontal(|ui| {
                                                 ui.label(label);
                                                 let mut current_color = *color;
                                                 if ui.color_edit_button_rgba_unmultiplied(&mut current_color).changed() {
                                                     let payload = format!("{}|{},{},{},{}", color_id, current_color[0], current_color[1], current_color[2], current_color[3]);
                                                     events_to_push.push(payload);
                                                 }
                                             });
                                         }
                                         UiWidget::Slider { id: slider_id, label, value, min, max } => {
                                             ui.horizontal(|ui| {
                                                 ui.label(label);
                                                 let mut current_value = *value;
                                                 if ui.add(egui::Slider::new(&mut current_value, *min..=*max)).changed() {
                                                     let payload = format!("{}|{}", slider_id, current_value);
                                                     events_to_push.push(payload);
                                                 }
                                             });
                                         }
                                         UiWidget::NumericInput { id: num_id, label, value } => {
                                             ui.horizontal(|ui| {
                                                 ui.label(label);
                                                 let mut current_value = *value;
                                                 if ui.add(egui::DragValue::new(&mut current_value)).changed() {
                                                     let payload = format!("{}|{}", num_id, current_value);
                                                     events_to_push.push(payload);
                                                 }
                                             });
                                         }
                                         UiWidget::Dropdown { id: drop_id, label, options, selected_index } => {
                                             ui.horizontal(|ui| {
                                                 ui.label(label);
                                                 let mut current_selected = *selected_index;
                                                 let mut changed = false;
                                                 egui::ComboBox::from_id_source(drop_id)
                                                     .selected_text(&options[current_selected])
                                                     .show_ui(ui, |ui| {
                                                         for (i, option) in options.iter().enumerate() {
                                                             if ui.selectable_value(&mut current_selected, i, option).clicked() {
                                                                 changed = true;
                                                             }
                                                         }
                                                     });
                                                 
                                                 if changed {
                                                     let payload = format!("{}|{}", drop_id, current_selected);
                                                     events_to_push.push(payload);
                                                 }
                                             });
                                         }
                                         UiWidget::Checkbox { id: check_id, label, value } => {
                                            let mut current_value = *value;
                                            if ui.checkbox(&mut current_value, label).changed() {
                                                let payload = format!("{}|{}", check_id, current_value);
                                                events_to_push.push(payload);
                                            }
                                        }
                                        UiWidget::CodeEditor { id: editor_id, label, content, language } => {
                                            ui.label(label);
                                            let syntax = if language == "javascript" || language == "js" {
                                                egui_code_editor::Syntax::lua()
                                            } else {
                                                egui_code_editor::Syntax::rust()
                                            };
           
                                            let mut current_content = content.clone();
                                            let response = egui_code_editor::CodeEditor::default()
                                                .id_source(editor_id)
                                                .with_syntax(syntax)
                                                .with_theme(egui_code_editor::ColorTheme::AYU_DARK)
                                                .with_numlines(true)
                                                .show(ui, &mut current_content);
           
                                            if response.response.changed() {
                                                let payload = format!("{}|{}", editor_id, current_content);
                                                events_to_push.push(payload);
                                            }
                                        }
                                        UiWidget::MiniMap { id: mm_id, landscape_id, brush_size, markers } => {
                                            let texture_id = if let Some(view) = &context.landscape_texture_view {
                                                let key = format!("landscape_{}", mm_id);
                                                if let Some(tid) = context.egui_textures.get(&key) {
                                                    *tid
                                                } else {
                                                    let tid = egui_renderer.register_native_texture(&context.gpu_resources.as_ref().unwrap().device, view, wgpu::FilterMode::Linear);
                                                    context.egui_textures.insert(key, tid);
                                                    tid
                                                }
                                            } else {
                                                ui.label("Waiting for landscape texture...");
                                                continue;
                                            };
           
                                            let mm_size = ui.available_size();
                                            let mm_size = mm_size.x.min(mm_size.y);
                                            let (rect, response) = ui.allocate_exact_size(egui::vec2(mm_size, mm_size), egui::Sense::click_and_drag());
                                            
                                            // Draw the landscape texture
                                            ui.painter().image(texture_id, rect, egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)), egui::Color32::WHITE);
           
                                            // Interaction: Drawing
                                            if response.dragged() || response.clicked() {
                                                if let Some(pointer_pos) = response.interact_pointer_pos() {
                                                    let local_pos = pointer_pos - rect.min;
                                                    let x = local_pos.x / rect.width();
                                                    let y = local_pos.y / rect.height();
                                                    let payload = format!("{}|{},{},{}", mm_id, x, y, brush_size);
                                                    events_to_push.push(payload);
                                                }
                                            }
           
                                            // Draw markers
                                            for marker in markers {
                                                let m_pos = rect.min + egui::vec2(marker.position[0] * rect.width(), marker.position[1] * rect.height());
                                                let m_color = marker.color.map(|c| egui::Color32::from_rgba_unmultiplied((c[0]*255.0) as u8, (c[1]*255.0) as u8, (c[2]*255.0) as u8, (c[3]*255.0) as u8)).unwrap_or(egui::Color32::RED);
                                                
                                                ui.painter().circle_filled(m_pos, 5.0, m_color);
                                                if let Some(label) = &marker.label {
                                                    ui.painter().text(m_pos + egui::vec2(7.0, 0.0), egui::Align2::LEFT_CENTER, label, egui::FontId::proportional(12.0), egui::Color32::WHITE);
                                                }
                                            }
                                        }
                                        UiWidget::Separator => {
                                            ui.separator();
                                        }
                                    }
                                 }
                             }
                        });
                }
            }
        }
        
        // Push events
        if !events_to_push.is_empty() {
            let op_state = self.runtime.op_state();
            let op_state = op_state.borrow();
            if let Some(context) = op_state.try_borrow::<AddonContext>() {
                if let Ok(mut events) = context.ui_events.lock() {
                    events.extend(events_to_push);
                }
            }
        }
    }

    pub fn render_tab(&mut self, ui: &mut egui::Ui, tab_id: &str, egui_renderer: &mut egui_wgpu::Renderer) {
        // 0. Reset widget counter in JS
        {
            let scope = &mut self.runtime.handle_scope();
            let global = scope.get_current_context().global(scope);
            let entropy_key = v8::String::new(scope, "Entropy").unwrap();
            if let Some(entropy_val) = global.get(scope, entropy_key.into()) {
                if entropy_val.is_object() {
                    let entropy_obj = entropy_val.to_object(scope).unwrap();
                    let reset_key = v8::String::new(scope, "_reset_widget_counter").unwrap();
                    if let Some(reset_val) = entropy_obj.get(scope, reset_key.into()) {
                        if reset_val.is_function() {
                            let reset_func = v8::Local::<v8::Function>::try_from(reset_val).unwrap();
                            let _ = reset_func.call(scope, entropy_obj.into(), &[]);
                        }
                    }
                }
            }
        }

        // 1. Clear widgets for this tab
        {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                 context.ui_widgets.remove(tab_id);
            }
        }

        // 2. Execute JS callback for this tab
        let callback_opt = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                context.ui_tabs.get(tab_id).map(|(_, cb, _)| cb.clone())
            } else {
                None
            }
        };

        if let Some(callback) = callback_opt {
            let scope = &mut self.runtime.handle_scope();
            let tc = &mut v8::TryCatch::new(scope);
            let func = v8::Local::new(tc, callback);
            let receiver = v8::undefined(tc);
            let _ = func.call(tc, receiver.into(), &[]); 
            
            if tc.has_caught() {
                if let Some(exception) = tc.exception() {
                    let msg = exception.to_rust_string_lossy(tc);
                    println!("[ADDON TAB ERROR] {}", msg);
                }
            }
        }

        // 3. Render
        let mut events_to_push = Vec::new();
        {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                 if let Some(widgets) = context.ui_widgets.get(tab_id) {
                     for widget in widgets {
                         match widget {
                             UiWidget::Label { text, bold } => {
                                 let mut txt = egui::RichText::new(text);
                                 if bold.unwrap_or(false) { txt = txt.strong(); }
                                 ui.label(txt);
                             }
                             UiWidget::Button { text, id: btn_id, label: _ } => {
                                 if ui.button(text).clicked() {
                                     events_to_push.push(btn_id.clone());
                                 }
                             }
                             UiWidget::ColorInput { id: color_id, label, color } => {
                                 ui.horizontal(|ui| {
                                     ui.label(label);
                                     let mut current_color = *color;
                                     if ui.color_edit_button_rgba_unmultiplied(&mut current_color).changed() {
                                         let payload = format!("{}|{},{},{},{}", color_id, current_color[0], current_color[1], current_color[2], current_color[3]);
                                         events_to_push.push(payload);
                                     }
                                 });
                             }
                             UiWidget::Slider { id: slider_id, label, value, min, max } => {
                                 ui.horizontal(|ui| {
                                     ui.label(label);
                                     let mut current_value = *value;
                                     if ui.add(egui::Slider::new(&mut current_value, *min..=*max)).changed() {
                                         let payload = format!("{}|{}", slider_id, current_value);
                                         events_to_push.push(payload);
                                     }
                                 });
                             }
                             UiWidget::NumericInput { id: num_id, label, value } => {
                                 ui.horizontal(|ui| {
                                     ui.label(label);
                                     let mut current_value = *value;
                                     if ui.add(egui::DragValue::new(&mut current_value)).changed() {
                                         let payload = format!("{}|{}", num_id, current_value);
                                         events_to_push.push(payload);
                                     }
                                 });
                             }
                             UiWidget::Dropdown { id: drop_id, label, options, selected_index } => {
                                 ui.horizontal(|ui| {
                                     ui.label(label);
                                     let mut current_selected = *selected_index;
                                     let mut changed = false;
                                     egui::ComboBox::from_id_source(drop_id)
                                         .selected_text(&options[current_selected])
                                         .show_ui(ui, |ui| {
                                             for (i, option) in options.iter().enumerate() {
                                                 if ui.selectable_value(&mut current_selected, i, option).clicked() {
                                                     changed = true;
                                                 }
                                             }
                                         });
                                     
                                     if changed {
                                         let payload = format!("{}|{}", drop_id, current_selected);
                                         events_to_push.push(payload);
                                     }
                                 });
                             }
                             UiWidget::Checkbox { id: check_id, label, value } => {
                                 let mut current_value = *value;
                                 if ui.checkbox(&mut current_value, label).changed() {
                                     let payload = format!("{}|{}", check_id, current_value);
                                     events_to_push.push(payload);
                                 }
                             }
                             UiWidget::CodeEditor { id: editor_id, label, content, language } => {
                                 ui.label(label);
                                 let syntax = if language == "javascript" || language == "js" {
                                     egui_code_editor::Syntax::lua()
                                 } else {
                                     egui_code_editor::Syntax::rust()
                                 };

                                 let mut current_content = content.clone();
                                 let response = egui_code_editor::CodeEditor::default()
                                     .id_source(editor_id)
                                     .with_syntax(syntax)
                                     .with_theme(egui_code_editor::ColorTheme::AYU_DARK)
                                     .with_numlines(true)
                                     .show(ui, &mut current_content);

                                 if response.response.changed() {
                                     let payload = format!("{}|{}", editor_id, current_content);
                                     events_to_push.push(payload);
                                 }
                             }
                             UiWidget::MiniMap { id: mm_id, landscape_id, brush_size, markers } => {
                                 let texture_id = if let Some(view) = &context.landscape_texture_view {
                                     let key = format!("landscape_{}", mm_id);
                                     if let Some(tid) = context.egui_textures.get(&key) {
                                         *tid
                                     } else {
                                         let tid = egui_renderer.register_native_texture(&context.gpu_resources.as_ref().unwrap().device, view, wgpu::FilterMode::Linear);
                                         context.egui_textures.insert(key, tid);
                                         tid
                                     }
                                 } else {
                                     ui.label("Waiting for landscape texture...");
                                     continue;
                                 };

                                 let mm_size = ui.available_size();
                                 let mm_size = mm_size.x.min(mm_size.y);
                                 let (rect, response) = ui.allocate_exact_size(egui::vec2(mm_size, mm_size), egui::Sense::click_and_drag());
                                 
                                 // Draw the landscape texture
                                 ui.painter().image(texture_id, rect, egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)), egui::Color32::WHITE);

                                 // Interaction: Drawing
                                 if response.dragged() || response.clicked() {
                                     if let Some(pointer_pos) = response.interact_pointer_pos() {
                                         let local_pos = pointer_pos - rect.min;
                                         let x = local_pos.x / rect.width();
                                         let y = local_pos.y / rect.height();
                                         let payload = format!("{}|{},{},{}", mm_id, x, y, brush_size);
                                         events_to_push.push(payload);
                                     }
                                 } else if response.hovered() {
                                    if let Some(pointer_pos) = ui.input(|i| i.pointer.hover_pos()) {
                                        if rect.contains(pointer_pos) {
                                            let local_pos = pointer_pos - rect.min;
                                            let x = local_pos.x / rect.width();
                                            let y = local_pos.y / rect.height();
                                            let payload = format!("HOVER|{}|{},{},{}", mm_id, x, y, brush_size);
                                            events_to_push.push(payload);
                                        }
                                    }
                                 }

                                 // Draw markers
                                 for marker in markers {
                                     let m_pos = rect.min + egui::vec2(marker.position[0] * rect.width(), marker.position[1] * rect.height());
                                     let m_color = marker.color.map(|c| egui::Color32::from_rgba_unmultiplied((c[0]*255.0) as u8, (c[1]*255.0) as u8, (c[2]*255.0) as u8, (c[3]*255.0) as u8)).unwrap_or(egui::Color32::RED);
                                     
                                     ui.painter().circle_filled(m_pos, 5.0, m_color);
                                     if let Some(label) = &marker.label {
                                         ui.painter().text(m_pos + egui::vec2(7.0, 0.0), egui::Align2::LEFT_CENTER, label, egui::FontId::proportional(12.0), egui::Color32::WHITE);
                                     }
                                 }
                             }
                             UiWidget::Separator => {
                                 ui.separator();
                             }
                         }
                     }
                 }
            }
        }

        // Push events
        if !events_to_push.is_empty() {
            let op_state = self.runtime.op_state();
            let op_state = op_state.borrow();
            if let Some(context) = op_state.try_borrow::<AddonContext>() {
                if let Ok(mut events) = context.ui_events.lock() {
                    events.extend(events_to_push);
                }
            }
        }
    }
}
