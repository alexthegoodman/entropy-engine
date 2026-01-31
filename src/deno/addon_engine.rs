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
use wgpu::RenderPipeline;
use crate::shape_primitives::Cube::Cube;
use crate::core::RendererState::RendererState;
use crate::core::SimpleCamera::SimpleCamera;
use egui;

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
pub struct PipelineConfig {
    pub name: String,
    pub vertex_shader: Option<String>,
    pub fragment_shader: Option<String>,
    pub use_default: Option<bool>,
    pub pbr: Option<bool>,
    pub lighting_shader: Option<String>,
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
}

pub struct AddonContext {
    pub registered_addons: HashMap<String, AddonMetadata>,
    pub gpu_resources: Option<Arc<GpuResources>>,
    pub pipelines: HashMap<String, RenderPipeline>,
    pub pipeline_configs: HashMap<String, PipelineConfig>,
    pub lighting_pipelines: HashMap<String, RenderPipeline>,
    pub bind_group_layouts: Vec<Arc<wgpu::BindGroupLayout>>, // 0: model, 1: group, 2: camera
    pub lighting_bind_group_layouts: Vec<Arc<wgpu::BindGroupLayout>>,
    pub surface_format: Option<wgpu::TextureFormat>,
    pub pending_cubes: Vec<(String, CubeConfig)>, // (addon_name, config)
    pub pending_landscapes: Vec<(String, LandscapeConfig)>, // (addon_name, config)
    pub noise_generators: HashMap<String, NoiseConfig>,
    pub on_init_callbacks: Vec<v8::Global<v8::Function>>,
    pub ui_windows: HashMap<String, (UiWindowConfig, v8::Global<v8::Function>)>,
    pub ui_tabs: HashMap<String, (UiTabConfig, v8::Global<v8::Function>)>,
    pub ui_widgets: HashMap<String, Vec<UiWidget>>,
    pub ui_events: Arc<Mutex<Vec<String>>>, // triggered events (e.g. button clicks)
    pub new_tabs: Vec<String>,
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
fn op_addon_on_init(state: &mut OpState, #[global] callback: v8::Global<v8::Function>) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.on_init_callbacks.push(callback);
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
fn op_ui_create_tab(state: &mut OpState, #[serde] config: UiTabConfig, #[global] on_render: v8::Global<v8::Function>) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.ui_tabs.insert(id.clone(), (config, on_render));
        ctx.new_tabs.push(id.clone());
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

#[op2]
#[string]
fn op_pipeline_create(state: &mut OpState, #[serde] config: PipelineConfig) -> Result<String, deno_error::JsErrorBox> {
    println!("Creating pipeline: {:?}", config);
    
    if config.use_default.unwrap_or(false) {
        return Ok("default".to_string());
    }

    let id = format!("pipeline_{}", uuid::Uuid::new_v4());
    let mut ctx = state.borrow_mut::<AddonContext>();
    
    if let Some(gpu) = &ctx.gpu_resources {
        let device = &gpu.device;
        let layouts: Vec<&wgpu::BindGroupLayout> = ctx.bind_group_layouts.iter().map(|l| l.as_ref()).collect();
         
        let is_pbr = config.pbr.unwrap_or(true); // Default to PBR for backward compatibility or as engine default
        let formats = if is_pbr {
            GBUFFER_FORMATS.as_slice()
        } else {
            std::slice::from_ref(ctx.surface_format.as_ref().unwrap_or(&wgpu::TextureFormat::Rgba8Unorm))
        };

        let pipeline = create_addon_pipeline(
            device,
            &config,
            &layouts,
            formats,
            Some(wgpu::TextureFormat::Depth24Plus)
        );
        
        ctx.pipelines.insert(id.clone(), pipeline);

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

            ctx.lighting_pipelines.insert(id.clone(), lighting_pipeline);
        }
        
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
        op_pipeline_create,
        op_cube_spawn,
        op_landscape_create,
        op_noise_create,
        op_println,
        op_ui_create_window,
        op_ui_create_tab,
        op_ui_widget_label,
        op_ui_widget_button,
    ],
    esm_entry_point = "ext:entropy_addons/addon_setup.js",
    esm = [ dir "src/deno", "addon_setup.js" ],
);

pub struct AddonEngine {
    pub runtime: JsRuntime,
    pub project_id: String,
}

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
            pending_cubes: Vec::new(),
            pending_landscapes: Vec::new(),
            noise_generators: HashMap::new(),
            on_init_callbacks: Vec::new(),
            ui_windows: HashMap::new(),
            ui_tabs: HashMap::new(),
            ui_widgets: HashMap::new(),
            ui_events: Arc::new(Mutex::new(Vec::new())),
            new_tabs: Vec::new(),
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
        let (pending_cubes, pending_landscapes) = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                (
                    std::mem::take(&mut ctx.pending_cubes),
                    std::mem::take(&mut ctx.pending_landscapes)
                )
            } else {
                (Vec::new(), Vec::new())
            }
        };

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
                            camera
                        );

                        renderer_state.addon_landscapes
                            .entry(addon_name)
                            .or_insert_with(Vec::new)
                            .push(landscape);
                    }
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
            for callback in callbacks {
                let func = v8::Local::new(scope, callback);
                let receiver = v8::undefined(scope);
                let _ = func.call(scope, receiver.into(), &[]);
            }
        }

        Ok(module_id)
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

    pub fn consume_new_tabs(&mut self) -> Vec<String> {
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
            for (_id, cb) in callbacks {
                let func = v8::Local::new(scope, cb);
                let receiver = v8::undefined(scope);
                let _ = func.call(scope, receiver.into(), &[]); 
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
                context.ui_tabs.get(tab_id).map(|(_, cb)| cb.clone())
            } else {
                None
            }
        };

        if let Some(cb) = callback {
            let scope = &mut self.runtime.handle_scope();
            let func = v8::Local::new(scope, cb);
            let receiver = v8::undefined(scope);
            let _ = func.call(scope, receiver.into(), &[]); 
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