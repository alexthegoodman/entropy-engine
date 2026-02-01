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
use uuid::Uuid;
use std::rc::Rc;
use std::cell::RefCell;
use std::path::Path;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use crate::core::gpu_resources::GpuResources;
use crate::core::addon_pipeline::{GBUFFER_FORMATS, create_addon_pipeline};
use crate::procedural_grass::grass::Grass;
use wgpu::{RenderPipeline, TextureView};
use crate::shape_primitives::Cube::Cube;
use crate::core::RendererState::RendererState;
use crate::core::SimpleCamera::SimpleCamera;
use crate::core::custom_mesh::CustomMesh;
use egui;
use wgpu::util::DeviceExt;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AddonMetadata {
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: Vec<String>,
    pub capabilities: HashMap<String, bool>,
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

}



#[derive(Serialize, Deserialize, Debug, Clone)]



#[serde(rename_all = "camelCase")]



pub struct MeshConfig {



    pub position: [f32; 3],



    pub vertex_data: Vec<f32>,



    pub index_data: Vec<u32>,



    pub pipeline_id: String,



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



}







#[derive(Serialize, Deserialize, Debug, Clone)]



#[serde(rename_all = "camelCase")]



pub struct CubeConfig {

    pub position: [f32; 3],

    pub scale: [f32; 3],

    pub pipeline_id: Option<String>,

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

#[serde(tag = "type")]

pub enum UiWidget {

        Label { text: String, bold: Option<bool> },

        Button { text: String, id: String, label: String },

        ColorInput { id: String, label: String, color: [f32; 4] },

        Slider { id: String, label: String, value: f32, min: f32, max: f32 },

        NumericInput { id: String, label: String, value: f32 },

    }



use crate::heightfield_landscapes::Landscape::Landscape;

use crate::helpers::landscapes::{LandscapePixelData};



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

    pub width: usize,

    pub height: usize,

    pub heights: Option<Vec<f32>>,

    pub noise_id: Option<String>,

    pub position: [f32; 3],

    pub pipeline_id: Option<String>,

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



}







#[derive(Serialize, Deserialize, Debug, Clone)]



#[serde(rename_all = "camelCase")]



pub struct PointLightConfig {



    pub position: [f32; 3],



    pub color: [f32; 3],



    pub intensity: f32,



    pub max_distance: f32,



}

pub struct AddonContext {
    pub registered_addons: HashMap<String, AddonMetadata>,
    pub gpu_resources: Option<Arc<GpuResources>>,
    pub pipelines: HashMap<String, Arc<RenderPipeline>>,
    pub pipeline_configs: HashMap<String, PipelineConfig>,
    pub lighting_pipelines: HashMap<String, Arc<RenderPipeline>>,
    pub bind_group_layouts: Vec<Arc<wgpu::BindGroupLayout>>, // 0: model, 1: group, 2: camera
    pub lighting_bind_group_layouts: Vec<Arc<wgpu::BindGroupLayout>>,
    pub surface_format: Option<wgpu::TextureFormat>,
    pub grass_uniform_layout: Option<Arc<wgpu::BindGroupLayout>>,
    pub landscape_particle_layout: Option<Arc<wgpu::BindGroupLayout>>,
    pub pending_cubes: Vec<(String, CubeConfig)>, // (addon_name, config)
    pub pending_meshes: Vec<(String, MeshConfig)>, // (addon_name, config)
    pub pending_landscapes: Vec<(String, LandscapeConfig)>, // (addon_name, config)
    pub pending_grasses: Vec<(String, AddonGrassConfig)>, // (addon_name, config)
    pub pending_point_lights: Vec<(String, PointLightConfig)>,
    pub noise_generators: HashMap<String, NoiseConfig>,
    pub on_init_callbacks: HashMap<String, Vec<v8::Global<v8::Function>>>,
    pub on_cleanup_callbacks: HashMap<String, Vec<v8::Global<v8::Function>>>,
    pub ui_windows: HashMap<String, (UiWindowConfig, v8::Global<v8::Function>)>,
    pub ui_tabs: HashMap<String, (UiTabConfig, v8::Global<v8::Function>, String)>, // (config, callback, addon_name)
    pub ui_widgets: HashMap<String, Vec<UiWidget>>,
    pub ui_events: Arc<Mutex<Vec<String>>>, // triggered events (e.g. button clicks)
    pub new_tabs: Vec<(String, String, String)>, // (id, title, addon_name)
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



fn op_grass_create(state: &mut OpState, #[string] addon_name: String, #[serde] config: AddonGrassConfig) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
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
#[serde]
fn op_addon_register(state: &mut OpState, #[serde] metadata: AddonMetadata) {
    println!("Registering addon: {:?}", metadata);
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.registered_addons.insert(metadata.name.clone(), metadata);
    }
}

#[op2]
fn op_addon_on_init(state: &mut OpState, #[string] addon_name: String, #[global] callback: v8::Global<v8::Function>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.on_init_callbacks.entry(addon_name).or_default().push(callback);
    }
}

#[op2]
fn op_addon_on_cleanup(state: &mut OpState, #[string] addon_name: String, #[global] callback: v8::Global<v8::Function>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.on_cleanup_callbacks.entry(addon_name).or_default().push(callback);
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

            if ctx.landscape_particle_layout.is_none() {
                ctx.landscape_particle_layout = Some(Arc::new(device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    entries: &[
                        wgpu::BindGroupLayoutEntry {
                            binding: 0,
                            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                            ty: wgpu::BindingType::Texture {
                                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                                view_dimension: wgpu::TextureViewDimension::D2,
                                multisampled: false,
                            },
                            count: None,
                        },
                        wgpu::BindGroupLayoutEntry {
                            binding: 1,
                            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                            count: None,
                        },
                    ],
                    label: Some("Landscape Particle Bind Group Layout"),
                })));
            }

            println!("Working pipeline (1): {:?} {:?}", config.name, config.pbr);

            layouts = vec![
                ctx.bind_group_layouts[0].as_ref(), // Camera
                ctx.grass_uniform_layout.as_ref().unwrap().as_ref(),
                ctx.landscape_particle_layout.as_ref().unwrap().as_ref(),
            ];
        } else if let Some(extras) = &config.extra_bind_groups {
            // Handle generic extra layouts
             layouts = vec![ctx.bind_group_layouts[0].as_ref()]; // Start with Camera (Group 0)

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
                         "Sampler" => wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
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
        let formats = if is_pbr {
            GBUFFER_FORMATS.as_slice()
        } else {
            std::slice::from_ref(ctx.surface_format.as_ref().unwrap_or(&wgpu::TextureFormat::Rgba8Unorm))
        };

        // println!("Working pipeline (3): {:?} {:?}", config.name, config.pbr);

        let pipeline = create_addon_pipeline(
            device,
            &config,
            &layouts,
            formats,
            Some(wgpu::TextureFormat::Depth24Plus)
        );
        
        ctx.pipelines.insert(id.clone(), Arc::new(pipeline));

        // println!("Prep for lighting shader: {:?}", config.layout);

        // If a lighting shader is provided, create a lighting pipeline
        if let Some(lighting_shader_source) = &config.lighting_shader {
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(&format!("{} Lighting Shader", config.name)),
                source: wgpu::ShaderSource::Wgsl(lighting_shader_source.as_str().into()),
            });

            let lighting_layouts: Vec<&wgpu::BindGroupLayout> = ctx.lighting_bind_group_layouts.iter().map(|l| l.as_ref()).collect();
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
        }

        // println!("Done with lighting shader: {:?}", config.layout);
        
        ctx.pipeline_configs.insert(id.clone(), config);
        
        Ok(id)
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
    println!("Adding mesh?");
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_meshes.push((addon_name, config));
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

extension!(
    entropy_addons,
    ops = [
        op_addon_register,
        op_addon_on_init,
        op_addon_on_cleanup,
        op_pipeline_create,
        op_cube_spawn,
        op_mesh_create,
        op_landscape_create,
        op_grass_create,
        op_noise_create,
        op_point_light_create,
        op_println,
        op_ui_create_window,
        op_ui_create_tab,
        op_ui_widget_label,
        op_ui_widget_button,
        op_ui_widget_color_input,
        op_ui_widget_slider,
        op_ui_widget_numeric_input,
    ],
    esm_entry_point = "ext:entropy_addons/addon_setup.js",
    esm = [ dir "src/deno", "addon_setup.js" ],
);

pub struct AddonEngine {
    pub runtime: JsRuntime,
    pub project_id: String,
}

const DEFAULT_ADDON_BUNDLE: &str = include_str!("../../scripts/addons/studio-bundle/dist/bundle.js");

impl AddonEngine {
    pub fn new(project_id: String) -> Self {
        let loader = Rc::new(FsModuleLoader);
        let ext = entropy_addons::init_ops_and_esm();
        
        let mut runtime = JsRuntime::new(RuntimeOptions {
            module_loader: Some(loader),
            extensions: vec![
                ext,
            ],
            ..Default::default()
        });

        let context = AddonContext {
            registered_addons: HashMap::new(),
            gpu_resources: None,
            pipelines: HashMap::new(),
            pipeline_configs: HashMap::new(),
            lighting_pipelines: HashMap::new(),
            bind_group_layouts: Vec::new(),
            lighting_bind_group_layouts: Vec::new(),
            surface_format: None,
            grass_uniform_layout: None,
            landscape_particle_layout: None,
            pending_cubes: Vec::new(),
            pending_meshes: Vec::new(),
            pending_landscapes: Vec::new(),
            pending_grasses: Vec::new(),
            pending_point_lights: Vec::new(),
            noise_generators: HashMap::new(),
            on_init_callbacks: HashMap::new(),
            on_cleanup_callbacks: HashMap::new(),
            ui_windows: HashMap::new(),
            ui_tabs: HashMap::new(),
            ui_widgets: HashMap::new(),
            ui_events: Arc::new(Mutex::new(Vec::new())),
            new_tabs: Vec::new()
        };
        runtime.op_state().borrow_mut().put(context);

        AddonEngine {
            runtime,
            project_id,
        }
    }

    pub fn update(&mut self, renderer_state: &mut RendererState, camera: &SimpleCamera) {
        // 1. Process UI Events
        let events = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
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

        // 2. Process pending resources
        let (pending_cubes, pending_meshes, pending_landscapes, pending_grasses, pending_point_lights) = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                (
                    std::mem::take(&mut ctx.pending_cubes),
                    std::mem::take(&mut ctx.pending_meshes),
                    std::mem::take(&mut ctx.pending_landscapes),
                    std::mem::take(&mut ctx.pending_grasses),
                    std::mem::take(&mut ctx.pending_point_lights)
                )
            } else {
                (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new())
            }
        };

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
                    
                    renderer_state.addon_cubes
                        .entry(addon_name)
                        .or_insert_with(Vec::new)
                        .push(cube);
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
                         let mut bind_groups = Vec::new();
                         let mut uniform_buffers = Vec::new();

                         if let Some(bindings) = config.bindings {
                             // Organize bindings by group index
                            //  let mut groups: HashMap<u32, Vec<BindingConfig>> = HashMap::new();
                            //  for b in bindings {
                            //      groups.entry(b.group).or_default().push(b);
                            //  }

                            let mut groups: HashMap<u32, Vec<BindingConfig>> = HashMap::new();
                            for b in bindings {
                                groups.entry(b.group).or_default().push(b);
                            }

                            // Convert to sorted Vec of (group_number, bindings)
                            let mut sorted_groups: Vec<_> = groups.into_iter().collect();
                            sorted_groups.sort_by_key(|(group_num, _)| *group_num);

                            // Also sort bindings within each group
                            for (_, group_bindings) in &mut sorted_groups {
                                group_bindings.sort_by_key(|b| b.binding);
                            }


                             println!("Mesh groups {:?}", sorted_groups);

                             // Sort keys to ensure deterministic order if iterating? 
                             // We probably just iterate through groups we find.
                             
                             // We need to create BindGroup for each group index found.
                             // But wait, the pipeline layout expects specific group indices.
                             // And we need the Layout from the pipeline to create the BindGroup.
                             
                             // wgpu pipelines don't easily expose the bind group layouts by index unless we stored them.
                             // In `op_pipeline_create`, we stored `bind_group_layouts` in AddonContext, but those were mostly default ones.
                             // The pipeline was created with `create_addon_pipeline` which merges default layouts + extra layouts.
                             // The `CustomMesh` likely uses a pipeline created via `op_pipeline_create`.
                             // If `layout: "hair"` or similar was used, we added extra layouts.
                             
                             // However, `wgpu::RenderPipeline` allows `get_bind_group_layout(index)`.
                             
                             for (group_idx, binding_configs) in sorted_groups {
                                 let layout = pipeline.get_bind_group_layout(group_idx);
                                //  let mut entries = Vec::new();
                                 
                                 // We need to keep resources alive for the duration of bind group creation
                                 // So we create them first.
                                 // But we are in a loop.
                                 // We can create temporary vectors to hold the wgpu resources.
                                 
                                 let mut created_buffers = Vec::new();
                                 
                                 for b in &binding_configs {
                                    match &b.resource {
                                        ResourceType::Uniform { data } => {
                                            let buffer = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                                                label: Some(&format!("Uniform Buffer {}:{}", group_idx, b.binding)),
                                                contents: bytemuck::cast_slice(data),
                                                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                                            });
                                            created_buffers.push((b.binding, buffer));
                                        },
                                        ResourceType::Time => {
                                             let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
                                                label: Some("Time Buffer"),
                                                size: std::mem::size_of::<f32>() as u64,
                                                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                                                mapped_at_creation: false,
                                            });
                                            created_buffers.push((b.binding, buffer));
                                        },
                                        ResourceType::Texture { id } => {
                                            // Handle texture logic
                                        },
                                        ResourceType::Sampler => {
                                            // Handle sampler logic
                                        }
                                    }
                                 }

                                 // Now create entries
                                 // Note: we need to handle Texture/Sampler separate from buffers
                                 let mut wgpu_entries = Vec::new();
                                 
                                 // Add buffers
                                 for (binding, buffer) in &created_buffers {
                                     wgpu_entries.push(wgpu::BindGroupEntry {
                                         binding: *binding,
                                         resource: buffer.as_entire_binding(),
                                     });
                                     // Save buffer to keep it alive in CustomMesh
                                     // (We clone the buffer handle, wgpu handles reference counting)
                                     uniform_buffers.push(buffer.clone()); // Error: Buffer not cloneable? wgpu objects usually reference counted/cloneable.
                                     // wgpu::Buffer is a wrapper around Arc/Id, so it is cheap to clone.
                                 }
                                 
                                 // Add Textures/Samplers
                                  for b in &binding_configs {
                                    match &b.resource {
                                        ResourceType::Texture { id } => {
                                            if let Some(id_str) = id {
                                                if id_str == "Landscape" {
                                                     if let Some(l) = renderer_state.landscapes.first() {
                                                        if let Some(texture_view) = &l.particle_texture_view {
                                                            wgpu_entries.push(wgpu::BindGroupEntry {
                                                                binding: b.binding,
                                                                resource: wgpu::BindingResource::TextureView(texture_view),
                                                            });
                                                        } else {
                                                            // TODO: update_particle_texture
                                                        }
                                                     } else {
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

                                                        renderer_state.dummy_views.push((b.binding, dummy_view));

                                                        
                                                     }
                                                }
                                            }
                                        },
                                        ResourceType::Sampler => {
                                             // Default sampler?
                                             // For now create a default linear sampler or reuse one?
                                             // Creating one is fine for now.
                                             // Actually, we can't create it inside this loop easily without managing lifetime if we store reference.
                                             // But BindingResource::Sampler takes a reference.
                                             // So we need to create it before `wgpu_entries`.
                                        },
                                        _ => {}
                                    }
                                  }

                                    for b in &binding_configs {
                                        match &b.resource {
                                            ResourceType::Texture { id } => {
                                                if let Some(id_str) = id {
                                                    if id_str == "Landscape" {
                                                        // TODO: fetch dummy view by addon id or something to avoid cross contam
                                                        // make sure we dont fetch this when a ladnscape does exist too
                                                        // this was just to avoid a borrowing conflict
                                                        let dummy = renderer_state.dummy_views.get(0);
                                                        if let Some(dummy_view) = dummy {
                                                            wgpu_entries.push(wgpu::BindGroupEntry {
                                                                binding: dummy_view.0,
                                                                resource: wgpu::BindingResource::TextureView(&dummy_view.1),
                                                            });
                                                        }
                                                    }
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                            
                                    
                                  // Hack for Sampler lifetime: Create one if needed
                                  let sampler = if binding_configs.iter().any(|b| matches!(b.resource, ResourceType::Sampler)) {
                                       Some(gpu.device.create_sampler(&wgpu::SamplerDescriptor {
                                            address_mode_u: wgpu::AddressMode::ClampToEdge,
                                            address_mode_v: wgpu::AddressMode::ClampToEdge,
                                            address_mode_w: wgpu::AddressMode::ClampToEdge,
                                            mag_filter: wgpu::FilterMode::Linear,
                                            min_filter: wgpu::FilterMode::Linear,
                                            mipmap_filter: wgpu::FilterMode::Nearest,
                                            ..Default::default()
                                        }))
                                  } else {
                                      None
                                  };
                                  
                                  if let Some(s) = &sampler {
                                      for b in &binding_configs {
                                          if matches!(b.resource, ResourceType::Sampler) {
                                              wgpu_entries.push(wgpu::BindGroupEntry {
                                                  binding: b.binding,
                                                  resource: wgpu::BindingResource::Sampler(s),
                                              });
                                          }
                                      }
                                  }

                                 let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
                                     layout: &layout,
                                     entries: &wgpu_entries,
                                     label: Some(&format!("Custom BindGroup {}", group_idx)),
                                 });
                                //  bind_groups.push(Arc::new(bind_group));
                                bind_groups.push(bind_group);
                             }
                         }
                         
                         // Create Mesh
                         let vertex_bytes: &[u8] = bytemuck::cast_slice(&config.vertex_data);
                         let index_bytes: &[u8] = bytemuck::cast_slice(&config.index_data);

                         let mesh = CustomMesh::new(
                             &gpu.device,
                             vertex_bytes,
                             index_bytes,
                             pipeline,
                             config.pipeline_id.clone(),
                             bind_groups,
                             config.position,
                             uuid::Uuid::new_v4().to_string(),
                             uniform_buffers,
                             Vec::new() // can attach samplers to mesh instead?
                         );

                         renderer_state.addon_meshes
                             .entry(addon_name)
                             .or_insert_with(Vec::new)
                             .push(mesh);
                     }
                }
            }
        }

        // if !pending_meshes.is_empty() {
        //     if let Some(gpu) = &renderer_state.gpu_resources {
        //         for (addon_name, config) in pending_meshes {
        //             println!("ADDING ADDON MESH");

        //             let pipeline = {
        //                 let op_state = self.runtime.op_state();
        //                 let op_state = op_state.borrow();
        //                 if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
        //                     ctx.pipelines.get(&config.pipeline_id).cloned()
        //                 } else {
        //                     None
        //                 }
        //             };
                    
        //             if let Some(pipeline) = pipeline {
        //                 let mut bind_groups = Vec::new();
        //                 let mut uniform_buffers = Vec::new();
        //                 let mut samplers = Vec::new(); // Store samplers to keep them alive

        //                 if let Some(bindings) = config.bindings {
        //                     // Organize bindings by group index
        //                     let mut groups: HashMap<u32, Vec<BindingConfig>> = HashMap::new();
        //                     for b in bindings {
        //                         groups.entry(b.group).or_default().push(b);
        //                     }

        //                     // Process each bind group
        //                     for (group_idx, binding_configs) in groups {
        //                         let layout = pipeline.get_bind_group_layout(group_idx);
                                
        //                         // Pre-create all resources that need to persist
        //                         let mut group_buffers = Vec::new();
        //                         let mut group_samplers = Vec::new();
                                
        //                         // Create buffers first
        //                         for b in &binding_configs {
        //                             match &b.resource {
        //                                 ResourceType::Uniform { data } => {
        //                                     let buffer = gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        //                                         label: Some(&format!("Uniform Buffer {}:{}", group_idx, b.binding)),
        //                                         contents: bytemuck::cast_slice(data),
        //                                         usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        //                                     });
        //                                     group_buffers.push((b.binding, buffer));
        //                                 },
        //                                 ResourceType::Time => {
        //                                     let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        //                                         label: Some(&format!("Time Buffer {}:{}", group_idx, b.binding)),
        //                                         size: std::mem::size_of::<f32>() as u64,
        //                                         usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        //                                         mapped_at_creation: false,
        //                                     });
        //                                     group_buffers.push((b.binding, buffer));
        //                                 },
        //                                 ResourceType::Sampler => {
        //                                     let sampler = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
        //                                         label: Some(&format!("Sampler {}:{}", group_idx, b.binding)),
        //                                         address_mode_u: wgpu::AddressMode::ClampToEdge,
        //                                         address_mode_v: wgpu::AddressMode::ClampToEdge,
        //                                         address_mode_w: wgpu::AddressMode::ClampToEdge,
        //                                         mag_filter: wgpu::FilterMode::Linear,
        //                                         min_filter: wgpu::FilterMode::Linear,
        //                                         mipmap_filter: wgpu::FilterMode::Nearest,
        //                                         ..Default::default()
        //                                     });
        //                                     group_samplers.push((b.binding, sampler));
        //                                 },
        //                                 _ => {}
        //                             }
        //                         }
                                
        //                         // Now create bind group entries with proper references
        //                         let mut wgpu_entries = Vec::new();
                                
        //                         for b in &binding_configs {
        //                             match &b.resource {
        //                                 ResourceType::Uniform { .. } | ResourceType::Time => {
        //                                     // Find the corresponding buffer
        //                                     if let Some((_, buffer)) = group_buffers.iter().find(|(binding, _)| *binding == b.binding) {
        //                                         wgpu_entries.push(wgpu::BindGroupEntry {
        //                                             binding: b.binding,
        //                                             resource: buffer.as_entire_binding(),
        //                                         });
        //                                     }
        //                                 },
        //                                 ResourceType::Texture { id } => {
        //                                     if let Some(id_str) = id {
        //                                         if id_str == "Landscape" {
        //                                             if let Some(l) = renderer_state.landscapes.first() {
        //                                                 if let Some(texture_view) = &l.particle_texture_view {
        //                                                     wgpu_entries.push(wgpu::BindGroupEntry {
        //                                                         binding: b.binding,
        //                                                         resource: wgpu::BindingResource::TextureView(texture_view),
        //                                                     });
        //                                                 }
        //                                             }
        //                                         }
        //                                         // Add more texture ID cases as needed
        //                                     }
        //                                 },
        //                                 ResourceType::Sampler => {
        //                                     if let Some((_, sampler)) = group_samplers.iter().find(|(binding, _)| *binding == b.binding) {
        //                                         wgpu_entries.push(wgpu::BindGroupEntry {
        //                                             binding: b.binding,
        //                                             resource: wgpu::BindingResource::Sampler(sampler),
        //                                         });
        //                                     }
        //                                 }
        //                             }
        //                         }

        //                         // Create the bind group
        //                         let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
        //                             layout: &layout,
        //                             entries: &wgpu_entries,
        //                             label: Some(&format!("Custom BindGroup {}", group_idx)),
        //                         });
                                
        //                         bind_groups.push(bind_group);
                                
        //                         // Store buffers and samplers to keep them alive
        //                         uniform_buffers.extend(group_buffers.into_iter().map(|(_, buf)| buf));
        //                         samplers.extend(group_samplers.into_iter().map(|(_, samp)| samp));
        //                     }
        //                 }

        //                 println!("CREATING ADDON MESH");

        //                 // Create Mesh
        //                 let vertex_bytes: &[u8] = bytemuck::cast_slice(&config.vertex_data);
        //                 let index_bytes: &[u8] = bytemuck::cast_slice(&config.index_data);

        //                 let mesh = CustomMesh::new(
        //                     &gpu.device,
        //                     vertex_bytes,
        //                     index_bytes,
        //                     pipeline,
        //                     config.pipeline_id.clone(),
        //                     bind_groups,
        //                     config.position,
        //                     uuid::Uuid::new_v4().to_string(),
        //                     uniform_buffers,
        //                     samplers, // You'll need to add this field to CustomMesh
        //                 );

        //                 println!("CREATED ADDON MESH");

        //                 renderer_state.addon_meshes
        //                     .entry(addon_name)
        //                     .or_insert_with(Vec::new)
        //                     .push(mesh);
        //             }
        //         }
        //     }
        // }

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
                        let data = crate::helpers::landscapes::generate_landscape_data(
                            config.width,
                            config.height,
                            heights,
                            1024.0 * 4.0, // square_size
                            1024.0 * 4.0, // square_size
                            150.0 * 4.0,  // square_height
                        );

                        let landscape = Landscape::new(
                            &Uuid::new_v4().to_string(),
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

                        renderer_state.addon_landscapes
                            .entry(addon_name)
                            .or_insert_with(Vec::new)
                            .push(landscape);
                    }
                }
            }
        }

        if !pending_grasses.is_empty() {
            if let Some(gpu) = &renderer_state.gpu_resources {
                for (addon_name, config) in pending_grasses {
                    let mut updated = false;

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

                                println!("update hair {:?} {:?}", grass.config.base_color, grass.config.tip_color);

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
                        custom_pipeline
                    );

                    grass.id = config.id.clone();
                    grass.addon_name = Some(addon_name.clone());

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
                HashMap::new()
            }
        };

        if !callbacks.is_empty() {
            let scope = &mut self.runtime.handle_scope();
            for (_name, addon_callbacks) in callbacks {
                for callback in addon_callbacks {
                    let func = v8::Local::new(scope, callback);
                    let receiver = v8::undefined(scope);
                    let _ = func.call(scope, receiver.into(), &[]);
                }
            }
        }
    }

    pub fn get_registered_addons(&mut self) -> Vec<AddonMetadata> {
        let op_state = self.runtime.op_state();
        let op_state = op_state.borrow();
        if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
            ctx.registered_addons.values().cloned().collect()
        } else {
            Vec::new()
        }
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

    pub fn render_ui(&mut self, ctx: &egui::Context) {
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
                    context.ui_windows.iter().map(|(id, (_, cb))| (id.clone(), cb.clone())).collect::<Vec<_>>()
                } else {
                    Vec::new()
                }
            };
        
            let scope = &mut self.runtime.handle_scope();
            let tc = &mut v8::TryCatch::new(scope);
            for (_id, cb) in callbacks {
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
            let op_state = self.runtime.op_state();
            let op_state = op_state.borrow();
            if let Some(context) = op_state.try_borrow::<AddonContext>() {
                for (id, (config, _)) in &context.ui_windows {
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

    pub fn render_tab(&mut self, ui: &mut egui::Ui, tab_id: &str) {
        // 1. Clear widgets for this tab
        {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                 context.ui_widgets.remove(tab_id);
            }
        }

        // 2. Execute JS callback for this tab
        let callback = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<AddonContext>() {
                context.ui_tabs.get(tab_id).map(|(_, cb, _)| cb.clone())
            } else {
                None
            }
        };

        if let Some(cb) = callback {
            let scope = &mut self.runtime.handle_scope();
            let tc = &mut v8::TryCatch::new(scope);
            let func = v8::Local::new(tc, cb);
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
            let op_state = self.runtime.op_state();
            let op_state = op_state.borrow();
            if let Some(context) = op_state.try_borrow::<AddonContext>() {
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
