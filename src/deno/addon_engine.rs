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

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AddonMetadata {
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: Vec<String>,
    pub capabilities: HashMap<String, bool>,
}

use crate::core::addon_pipeline::create_addon_pipeline;
use wgpu::RenderPipeline;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PipelineConfig {
    pub name: String,
    pub vertex_shader: String,
    pub fragment_shader: String,
    // Add more fields as needed: layout, blend state, etc.
}

pub struct AddonContext {
    pub registered_addons: HashMap<String, AddonMetadata>,
    pub gpu_resources: Option<Arc<GpuResources>>,
    pub pipelines: HashMap<String, RenderPipeline>,
    pub bind_group_layouts: Vec<Arc<wgpu::BindGroupLayout>>, // 0: model, 1: global/camera?
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
#[string]
fn op_pipeline_create(state: &mut OpState, #[serde] config: PipelineConfig) -> Result<String, deno_error::JsErrorBox> {
    println!("Creating pipeline: {:?}", config);
    
    // We need to borrow context mutably to insert the pipeline, but we also need to access gpu_resources
    // Splitting borrows is tricky with OpState.
    // We can extract what we need first? No, ctx owns it.
    
    // Let's rely on internal mutability if needed, or just borrow mut.
    let ctx = state.borrow_mut::<AddonContext>();
    
    if let Some(gpu) = &ctx.gpu_resources {
        let device = &gpu.device;
        let layouts: Vec<&wgpu::BindGroupLayout> = ctx.bind_group_layouts.iter().map(|l| l.as_ref()).collect();
        
        // TODO: Pass correct output format. For now hardcoded to likely SwapChain or GBuffer format.
        let format = wgpu::TextureFormat::Bgra8UnormSrgb; // Common surface format
        let depth = Some(wgpu::TextureFormat::Depth32Float);

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
        op_pipeline_create,
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
        };
        runtime.op_state().borrow_mut().put(context);

        AddonEngine {
            runtime,
            project_id,
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

