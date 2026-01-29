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
use std::rc::Rc;
use std::cell::RefCell;
use std::path::Path;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use crate::core::gpu_resources::GpuResources;
use crate::core::addon_pipeline::create_addon_pipeline;
use wgpu::RenderPipeline;
use crate::shape_primitives::Cube::Cube;
use crate::core::RendererState::RendererState;
use crate::core::SimpleCamera::SimpleCamera;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AddonMetadata {
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: Vec<String>,
    pub capabilities: HashMap<String, bool>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PipelineConfig {
    pub name: String,
    pub vertex_shader: String,
    pub fragment_shader: String,
    // Add more fields as needed: layout, blend state, etc.
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CubeConfig {
    pub position: [f32; 3],
    pub scale: [f32; 3],
}

pub struct AddonContext {
    pub registered_addons: HashMap<String, AddonMetadata>,
    pub gpu_resources: Option<Arc<GpuResources>>,
    pub pipelines: HashMap<String, RenderPipeline>,
    pub bind_group_layouts: Vec<Arc<wgpu::BindGroupLayout>>, // 0: model, 1: group, 2: camera
    pub pending_cubes: Vec<CubeConfig>,
    pub on_init_callbacks: Vec<v8::Global<v8::Function>>,
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
fn op_pipeline_create(state: &mut OpState, #[serde] config: PipelineConfig) -> Result<String, deno_error::JsErrorBox> {
    println!("Creating pipeline: {:?}", config);
    
    let ctx = state.borrow_mut::<AddonContext>();
    
    if let Some(gpu) = &ctx.gpu_resources {
        let device = &gpu.device;
        let layouts: Vec<&wgpu::BindGroupLayout> = ctx.bind_group_layouts.iter().map(|l| l.as_ref()).collect();
        
        let format = wgpu::TextureFormat::Bgra8UnormSrgb; 
        let depth = Some(wgpu::TextureFormat::Depth24Plus);

        let pipeline = create_addon_pipeline(
            device,
            &config,
            &layouts,
            format,
            depth
        );
        
        let id = format!("pipeline_{}", uuid::Uuid::new_v4());
        ctx.pipelines.insert(id.clone(), pipeline);
        
        Ok(id)
    } else {
        Err(deno_error::JsErrorBox::generic("GPU resources not available"))
    }
}

#[op2]
fn op_cube_spawn(state: &mut OpState, #[serde] config: CubeConfig) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.pending_cubes.push(config);
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
        op_println,
    ],
    esm_entry_point = "ext:entropy_addons/addon_setup.js",
    esm = [ dir "src/deno", "addon_setup.js" ],
);

pub struct AddonEngine {
    runtime: JsRuntime,
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
            bind_group_layouts: Vec::new(),
            pending_cubes: Vec::new(),
            on_init_callbacks: Vec::new(),
        };
        runtime.op_state().borrow_mut().put(context);

        AddonEngine {
            runtime,
            project_id,
        }
    }

    pub fn update(&mut self, renderer_state: &mut RendererState, camera: &SimpleCamera) {
        let pending = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                std::mem::take(&mut ctx.pending_cubes)
            } else {
                Vec::new()
            }
        };

        if !pending.is_empty() {
            if let Some(gpu) = &renderer_state.gpu_resources {
                for config in pending {
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
                    renderer_state.cubes.push(cube);
                }
            }
        }
    }

    pub fn set_resources(&mut self, gpu_resources: Arc<GpuResources>, bind_group_layouts: Vec<Arc<wgpu::BindGroupLayout>>) {
        let mut op_state = self.runtime.op_state();
        let mut op_state = op_state.borrow_mut();
        if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
            ctx.gpu_resources = Some(gpu_resources);
            ctx.bind_group_layouts = bind_group_layouts;
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
}