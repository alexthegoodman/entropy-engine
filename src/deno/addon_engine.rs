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
use noise::MultiFractal;
use noise::NoiseFn;
use mint::ColumnMatrix4;
use nalgebra::{Isometry3, Matrix4, Translation3, UnitQuaternion, Vector3};
use noise::{Fbm, Perlin};
use rapier3d::prelude::{ColliderBuilder, LockedAxes, RigidBodyBuilder};
use uuid::Uuid;
// use wgpu::wgc::resource::ResourceType;
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
use crate::core::vertex::Vertex;
use crate::deno::addon_ops::op_yumon_brain_test_infer;
use crate::deno::addon_ops::{
    AddonContext, 
    AddonMetadata, 
    BehaviorNodeState, 
    BehaviorViewer, 
    BindingConfig, 
    CompositeInstance, 
    DialogueWrapper, 
    EngineContext, 
    LandscapeTextureUpdate,
    Modifiers, 
    NpcMotionState, 
    PendingAction, 
    ResourceType, 
    ToolDefinition, 
    UiWidget, 
    VisualConfig, 
    YumonActionState, 
    op_addon_load_data, 
    op_addon_on_action, 
    op_addon_on_all_addons_initialized, 
    op_addon_on_all_projects_loaded, 
    op_addon_on_cleanup, 
    op_addon_on_init, 
    op_addon_on_project_changed, op_addon_on_update, op_addon_register,
    op_addon_register_tool, op_addon_save_data, op_addon_save_image, op_addon_set_visibility, 
    op_alpha_model_load, op_audio_play_synth, op_audio_play_test, op_behavior_register, op_buffer_create, 
    op_buffer_write, op_camera_get_transform, op_camera_screen_to_world, op_camera_set_transform, op_composer_set_role_pipeline, 
    op_compute_dispatch, op_compute_pipeline_create, op_cube_spawn, op_dialogue_add_option, op_dialogue_close, op_dialogue_get_node, 
    op_dialogue_select_option, op_dialogue_show, op_dialogue_start_quest, op_entity_apply_impulse, op_entity_get_stats, op_entity_play_animation, 
    op_entity_set_rotation, op_entity_set_stats, op_entity_set_velocity, op_entity_set_xz_velocity, op_generate_uuid, op_gizmo_hide, op_gizmo_show, 
    op_gizmo_update, op_grass_create, op_input_get_state, op_io_list_models, op_io_pick_and_import_model, op_landscape_create, op_landscape_get_height,
    op_landscape_update_pbr_texture, op_landscape_update_texture, op_landscape3d_create, op_lighting_update_sun, op_mesh_clear, op_mesh_create, 
    op_mesh_get_data, op_meshes_clear, op_model_load, op_model_set_bone_transform, op_noise_create, op_pipeline_create, op_point_light_create, 
    op_println, op_quadscape_create, op_register_composite_texture, op_script_list, op_script_read, op_script_write, op_selection_get_selected, 
    op_set_game_mode, op_system_spawn_particles, op_texture_create, op_texture_create_ex, op_texture_load, op_texture_update, op_ui_clear, 
    op_ui_create_tab, op_ui_create_window, op_ui_rect_create, op_ui_text_create, op_ui_widget_button, op_ui_widget_checkbox, op_ui_widget_code_editor, 
    op_ui_widget_collapsing_header, op_ui_widget_color_input, op_ui_widget_dropdown, op_ui_widget_end_collapsing_header, op_ui_widget_end_horizontal, 
    op_ui_widget_label, op_ui_widget_mini_map, op_ui_widget_numeric_input, op_ui_widget_separator, op_ui_widget_slider, op_ui_widget_snarl, 
    op_ui_widget_start_horizontal, op_visual_load, op_window_get_size, op_yumon_brain_augment, op_yumon_brain_create, op_yumon_brain_get_state, 
    op_yumon_brain_infer, op_yumon_brain_load, op_yumon_brain_observe, op_yumon_brain_save, op_yumon_brain_sleep, op_yumon_create, op_yumon_sleep, op_yumon_tick
};
use crate::game_behaviors::stateful::BehaviorConfig;
use crate::heightfield_landscapes::Landscape::Landscape;
use crate::heightfield_landscapes::Landscape3D::Landscape3D;
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
use egui;
use wgpu::util::DeviceExt;
use egui_wgpu;

extension!(
    entropy_addons,
    ops = [
        op_addon_register,
        op_addon_on_init,
        op_addon_on_all_addons_initialized,
        op_addon_on_update,
        op_addon_on_cleanup,
        op_addon_on_action,
        op_yumon_create,
        op_yumon_tick,
        op_yumon_sleep,
        op_pipeline_create,
        op_compute_pipeline_create,
        op_compute_dispatch,
        op_buffer_create,
        op_buffer_write,
        op_cube_spawn,
        op_model_load,
        op_alpha_model_load,
        op_visual_load,
        op_mesh_create,
        op_mesh_clear,
        op_meshes_clear,
        op_landscape_create,
        op_landscape3d_create,
        op_landscape_get_height,
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
        op_ui_widget_snarl,
        op_ui_widget_collapsing_header,
        op_ui_widget_end_collapsing_header,
        op_ui_widget_start_horizontal,
        op_ui_widget_end_horizontal,
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
        op_camera_set_transform,
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
        op_ui_rect_create,
        op_ui_text_create,
        op_ui_clear,
        op_mesh_get_data,
        op_behavior_register,
        op_system_spawn_particles,
        op_dialogue_show,
        op_dialogue_add_option,
        op_dialogue_start_quest,
        op_dialogue_close,
        op_dialogue_get_node,
        op_dialogue_select_option,
        op_entity_apply_impulse,
        op_entity_set_velocity,
        op_entity_set_xz_velocity,
        op_entity_set_rotation,
        op_entity_play_animation,
        op_entity_set_stats,
        op_entity_get_stats,
        op_model_set_bone_transform,
        op_quadscape_create,
        op_yumon_brain_create,
        op_yumon_brain_observe,
        op_yumon_brain_infer,
        op_yumon_brain_sleep,
        op_yumon_brain_save,
        op_yumon_brain_load,
        op_yumon_brain_get_state,
        op_yumon_brain_augment,
        op_yumon_brain_test_infer
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

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EntityWrapper {
    pub id: String,
    pub name: String,
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
        current_node: Option<String>,
    ) -> Option<DialogueWrapper> {
        let behavior = {
            let state = self.runtime.op_state();
            let state = state.borrow();
            let context = state.borrow::<AddonContext>();
            context.behaviors.get(behavior_id).cloned()
        };

        // println!("Execute behavior: {:?} {:?}", hook_name, entity_wrapper);

        let mut dialogue_result = None;

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
                    dialogue_wrapper: if hook_name == "on_interact" {
                        Some(DialogueWrapper {
                            text: String::new(),
                            options: Vec::new(),
                            changed: false,
                            is_open: false,
                            npc_name: String::new(),
                            current_node: current_node.unwrap_or_else(|| "start".to_string()),
                            started_quest: None,
                        })
                    } else {
                        None
                    },
                };
                self.runtime.op_state().borrow_mut().put(context);

                {
                    let scope = &mut self.runtime.handle_scope();
                    let local_callback = v8::Local::new(scope, callback);
                    let this = v8::undefined(scope);
                    let global = scope.get_current_context().global(scope);

                    // 1. Entity Arg
                    let entity_v8 = serde_v8::to_v8(scope, entity_wrapper).unwrap();

                    let args: Vec<v8::Local<v8::Value>> = if hook_name == "on_interact" {
                        let create_dialogue_key = v8::String::new(scope, "_createDialogue").unwrap();
                        let create_dialogue_val = global.get(scope, create_dialogue_key.into()).unwrap();
                        let create_dialogue_func = v8::Local::<v8::Function>::try_from(create_dialogue_val)
                            .expect("addon_setup.js should define _createDialogue");
                        let dialogue_arg = create_dialogue_func.call(scope, global.into(), &[]).unwrap();
                        vec![entity_v8, dialogue_arg]
                    } else {
                        // 2. System Arg
                        let create_system_key = v8::String::new(scope, "_createSystem").unwrap();
                        let create_system_val = global.get(scope, create_system_key.into()).unwrap();
                        let create_system_func = v8::Local::<v8::Function>::try_from(create_system_val)
                            .expect("addon_setup.js should define _createSystem");
                        let system_arg = create_system_func.call(scope, global.into(), &[]).unwrap();

                        // 3. State Arg (for now just empty map or component script state)
                        let state_arg = serde_v8::to_v8(scope, HashMap::<String, String>::new()).unwrap();

                        vec![entity_v8, system_arg, state_arg]
                    };
                    
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
                let (particle_spawns, d_res) = {
                    let mut op_state = self.runtime.op_state();
                    let mut op_state = op_state.borrow_mut();
                    if let Some(ctx) = op_state.try_borrow_mut::<EngineContext>() {
                        (std::mem::take(&mut ctx.particle_spawns), ctx.dialogue_wrapper.take())
                    } else {
                        (Vec::new(), None)
                    }
                };
                dialogue_result = d_res;

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
        dialogue_result
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
            registered_addons: Vec::new(),
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
            skinned_layout: None,
            pending_cubes: Vec::new(),
            pending_models: Vec::new(),
            pending_visuals: Vec::new(),
            pending_meshes: Vec::new(),
            pending_clears: Vec::new(),
            pending_mesh_clears: Vec::new(),
            pending_landscapes: Vec::new(),
            pending_landscape3ds: Vec::new(),
            pending_grasses: Vec::new(),
            pending_point_lights: Vec::new(),
            pending_composites: Vec::new(),
            pending_mesh_updates: Vec::new(),
            pending_sun_config: None,                                                    
            pending_game_mode: None,
            pending_entity_impulses: Vec::new(),
            pending_animation_plays: Vec::new(),
            pending_stat_updates: Vec::new(),
            pending_entity_velocities: Vec::new(),
            pending_entity_xz_velocities: Vec::new(),
            active_gizmo: None,
            noise_generators: HashMap::new(),            
            on_init_callbacks: Vec::new(),
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
            landscape_heights: None,
            landscape_position: [0.0, 0.0, 0.0],
            landscape_config: None,
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
            model_cache: HashMap::new(),
            registered_tools: HashMap::new(),
            op_addon_on_all_projects_loaded_callbacks: Vec::new(),
            egui_textures: HashMap::new(),
            snarl_states: HashMap::new(),
            input_events: Vec::new(),
            pressed_keys: HashSet::new(),
            mouse_position: [0.0, 0.0],
            modifiers: Modifiers::default(),
            window_size: [1920, 1080],
            selected_entity_id: None,
            pending_camera_position: None,
            pending_camera_target: None,
            pending_bone_transforms: Vec::new(),
            pending_entity_rotations: Vec::new(),
            pending_ui_rects: Vec::new(),
            pending_ui_texts: Vec::new(),
            pending_ui_clear: false,
            pending_alpha_models: Vec::new(),
            pending_quadscapes: Vec::new(),
            yumon_sims: HashMap::new(),
            yumon_brains: HashMap::new(),
            yumon_runtime_actions: HashMap::new(),
            yumon_trainers: HashMap::new(),
            yumon_instances: HashMap::new(),
            npc_motion_states: HashMap::new(),
            on_action_callbacks: Vec::new(),
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

            // Preload existing Yumon brains
            if let Some(yumon_dir) = crate::helpers::utilities::get_yumon_dir(&project_id) {
                if let Ok(entries) = std::fs::read_dir(&yumon_dir) {
                    for entry in entries.flatten() {
                        if entry.path().is_dir() {
                            let archetype_name = entry.file_name().to_string_lossy().to_string();
                            let brain_dir = entry.path();
                            if brain_dir.join("metadata.json").exists() {
                                let device = Default::default();
                                match crate::yumon::system::YumonBrain::<crate::yumon::system::MyBackend>::load(device, &brain_dir) {
                                    Ok(brain) => {
                                        println!("[AddonEngine] ✅ Preloaded Yumon brain: {}", archetype_name);
                                        context.yumon_brains.insert(archetype_name, brain);
                                    }
                                    Err(e) => {
                                        eprintln!("[AddonEngine] ❌ Failed to preload Yumon brain {}: {}", archetype_name, e);
                                    }
                                }
                            }
                        }
                    }
                }
            }
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

    pub fn update(
        &mut self, 
        renderer_state: &mut RendererState, 
        ui_polygons: &mut Vec<Polygon>,
        ui_textboxes: &mut Vec<TextRenderer>,
        font_manager: &FontManager,
        ui_model_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        camera: &mut SimpleCamera, 
        camera_binding: &mut CameraBinding,
        current_time: f64, 
        gpu_resources: &Arc<GpuResources>, 
        current_addon_name: String,
        mut alpha_renderer: Option<&mut crate::alpha::AlphaRenderer>,
    ) {
        // Poll Yumon background trainers
        {
            let mut state = self.runtime.op_state();
            let mut state = state.borrow_mut();
            let context = state.borrow_mut::<AddonContext>();
            
            let mut completed_brains = Vec::new();
            for (id, trainer) in &mut context.yumon_trainers {
                // trainer.poll();
                let update = trainer.recv_update();
                if let Some(update) = &update {
                    if update.done {
                        completed_brains.push(id.clone());
                    }
                }
            }

            for id in completed_brains {
                if let Some(mut trainer) = context.yumon_trainers.remove(&id) {
                    if let Some(brain) = context.yumon_brains.get_mut(&id) {
                        if let Some(weights) = trainer.take_weights() {
                            brain.apply_trained_weights(weights);
                            println!("[AddonEngine] ✅ Background training complete for brain: {}", id);
                        }
                    }
                }
            }
        }

        // let renderer_state = editor.renderer_state.as_mut().expect("Couldn't get renderer state");
        // let landscape_view = renderer_state.landscapes.first().and_then(|l| l.particle_texture_view.clone());
        let mut landscape_view = renderer_state.addon_landscapes
                                                                .get(&current_addon_name)
                                                                .and_then(|al| al.first().and_then(|l| l.particle_texture_view.clone()));

        let mut landscape_data = renderer_state.addon_landscapes
                                                                .get(&current_addon_name)
                                                                .and_then(|al| al.first().map(|l| (l.heights.clone(), [l.transform.position.x, l.transform.position.y, l.transform.position.z])));

        if landscape_data.is_none() {
            landscape_data = renderer_state.addon_landscapes
                                                                    .get("Game Composer")
                                                                    .and_then(|al| al.first().map(|l| (l.heights.clone(), [l.transform.position.x, l.transform.position.y, l.transform.position.z])));
        }

        if landscape_data.is_none() {
            landscape_data = renderer_state.addon_landscapes.values().flatten().next().map(|l| (l.heights.clone(), [l.transform.position.x, l.transform.position.y, l.transform.position.z]));
        }

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
            
            // if context.landscape_heights.is_none() { // ideally would not be setting heights in update()...
                if let Some((heights, pos)) = landscape_data {
                    context.landscape_heights = Some(heights);
                    context.landscape_position = pos;
                } else {
                    context.landscape_heights = None;
                }
            // }

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

            // Apply pending camera changes
            if let Some(pos) = context.pending_camera_position.take() {
                camera.position = nalgebra::Point3::new(pos[0], pos[1], pos[2]);
            }
            if let Some(target) = context.pending_camera_target.take() {
                camera.direction = (nalgebra::Point3::new(target[0], target[1], target[2]) - camera.position).normalize();
            }
            camera.update();
            camera_binding.update_3d(&gpu_resources.queue, camera);
        }

        // 0. Execute Entity Behaviors
        let mut entity_behaviors = Vec::new();
        let mut processed_ids = std::collections::HashSet::new();

        // 0.2 Models
        if let Some(addon_models) = renderer_state.addon_models.get("Game Composer") {
            for model in addon_models {
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
                            name: "Entity".to_string(),
                            position: pos,
                            health: 100.0,
                            stamina: 100.0,
                            is_dead: false,
                        }
                    ));
                    processed_ids.insert(model.id.clone());
                }
            }
        }
        
        // 0.25 Addon Meshes
        for meshes in renderer_state.addon_meshes.values() {
            for mesh in meshes {
                if processed_ids.contains(&mesh.id) { continue; }
                if let Some(bid) = &mesh.behavior_id {
                    let pos = if let Some(rb_handle) = mesh.rigid_body_handle {
                        if let Some(rb) = renderer_state.rigid_body_set.get(rb_handle) {
                            let p = rb.translation();
                            [p.x, p.y, p.z]
                        } else {
                            [mesh.transform.position.x, mesh.transform.position.y, mesh.transform.position.z]
                        }
                    } else {
                        [mesh.transform.position.x, mesh.transform.position.y, mesh.transform.position.z]
                    };

                    entity_behaviors.push((
                        bid.clone(),
                        EntityWrapper {
                            id: mesh.id.clone(),
                            name: "Mesh".to_string(),
                            position: pos,
                            health: 100.0,
                            stamina: 100.0,
                            is_dead: false,
                        }
                    ));
                    processed_ids.insert(mesh.id.clone());
                }
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
                        name: "Collectable".to_string(),
                        position: pos,
                        health: 100.0,
                        stamina: 100.0,
                        is_dead: false,
                    }
                ));
            }
        }

        for (bid, wrapper) in entity_behaviors {
            self.execute_behavior(renderer_state, &bid, wrapper, "on_update", None);
        }

        // 0.35 Execute Yumon runtime control (optional, infer every 500ms and hold in-between).
        {
            const YUMON_INFER_INTERVAL_SECS: f64 = 0.5;
            const YUMON_MOVE_SPEED: f32 = 40.0;
            const YUMON_TURN_SPEED_RAD_PER_SEC: f32 = 2.2;
            const FRAME_DT_SECS: f32 = 1.0 / 60.0;

            #[derive(Clone)]
            struct YumonTarget {
                entity_id: String,
                brain_id: String,
                world: [f32; crate::yumon::system::WORLD_SIZE],
                self_state: [f32; crate::yumon::system::SELF_SIZE],
                yaw: f32,
            }

            struct ActorInfo {
                pos: [f32; 3],
                squad_id: Option<String>,
                is_player: bool,
            }

            let mut actors = Vec::new();
            
            // Gather Player
            if let Some(player) = &renderer_state.player_character {
                let p_pos = if let Some(rb_handle) = player.movement_rigid_body_handle {
                    if let Some(rb) = renderer_state.rigid_body_set.get(rb_handle) {
                        let p = rb.translation();
                        [p.x, p.y, p.z]
                    } else { [camera.position.x, camera.position.y, camera.position.z] }
                } else { [camera.position.x, camera.position.y, camera.position.z] };
                
                actors.push(ActorInfo {
                    pos: p_pos,
                    squad_id: None,
                    is_player: true,
                });
            } else {
                // Fallback to camera if no player character
                actors.push(ActorInfo {
                    pos: [camera.position.x, camera.position.y, camera.position.z],
                    squad_id: None,
                    is_player: true,
                });
            }

            // Gather NPCs
            for npc in &renderer_state.npcs {
                let pos = if let Some(rb_handle) = npc.rigid_body_handle {
                    if let Some(rb) = renderer_state.rigid_body_set.get(rb_handle) {
                        let p = rb.translation();
                        [p.x, p.y, p.z]
                    } else { [0.0, 0.0, 0.0] }
                } else { [0.0, 0.0, 0.0] };
                actors.push(ActorInfo {
                    pos,
                    squad_id: npc.squad_id.clone(),
                    is_player: false,
                });
            }

            let mut targets: Vec<YumonTarget> = Vec::new();
            let mut yumon_processed = std::collections::HashSet::new();

            if renderer_state.game_mode {

            // Process all addon models and meshes
            let all_model_iter = renderer_state.addon_models.values().flatten()
                .map(|m| (m.id.clone(), m.yumon_id.clone(), m.meshes.first().and_then(|sm| sm.rigid_body_handle), m.meshes.first().map(|sm| &sm.transform)));
            
            let all_mesh_iter = renderer_state.addon_meshes.values().flatten()
                .map(|m| (m.id.clone(), m.yumon_id.clone(), m.rigid_body_handle, Some(&m.transform)));

            for (entity_id, yumon_id_opt, rb_handle_opt, transform_opt) in all_model_iter.chain(all_mesh_iter) {
                let Some(yumon_id) = yumon_id_opt else { continue; };
                if yumon_processed.contains(&entity_id) { continue; }

                let mut pos = [0.0f32, 0.0f32, 0.0f32];
                let mut yaw = 0.0f32;
                let mut speed = 0.0f32;

                if let Some(rb_handle) = rb_handle_opt {
                    if let Some(rb) = renderer_state.rigid_body_set.get(rb_handle) {
                        let p = rb.translation();
                        pos = [p.x, p.y, p.z];
                        let (_, y, _) = rb.rotation().euler_angles();
                        yaw = y;
                        speed = rb.linvel().norm();
                    }
                } else if let Some(transform) = transform_opt {
                    pos = [transform.position.x, transform.position.y, transform.position.z];
                    let (_, y, _) = transform.rotation.euler_angles();
                    yaw = y;
                }

                // Get Real Stats
                let mut health_pct = 1.0f32;
                let mut stamina_pct = 1.0f32;
                let mut alert_level = 0.5f32;
                let mut squad_id = None;

                if let Some(npc) = renderer_state.npcs.iter().find(|n| n.id == entity_id) {
                    health_pct = (npc.stats.health / 100.0).clamp(0.0, 1.0);
                    stamina_pct = (npc.stats.stamina / 100.0).clamp(0.0, 1.0);
                    alert_level = npc.suspicion;
                    squad_id = npc.squad_id.clone();
                } else if let Some(player) = &renderer_state.player_character {
                    if player.id == entity_id {
                        health_pct = (player.stats.health / 100.0).clamp(0.0, 1.0);
                        stamina_pct = (player.stats.stamina / 100.0).clamp(0.0, 1.0);
                        alert_level = 1.0;
                    }
                }

                // Compute World State
                let mut world = [0.0f32; crate::yumon::system::WORLD_SIZE];
                let mut nearest_player_dist = 1.0f32;
                let mut nearest_player_angle = 0.0f32;
                let mut nearest_ally_dist = 1.0f32;
                let mut nearest_ally_angle = 0.0f32;
                let mut nearby_enemy_count = 0.0f32;
                let mut nearby_ally_count = 0.0f32;

                for actor in &actors {
                    let dx = actor.pos[0] - pos[0];
                    let dz = actor.pos[2] - pos[2];
                    let dist = (dx * dx + dz * dz).sqrt();
                    let world_angle = dx.atan2(dz);
                    // let relative_angle = (world_angle - yaw) / std::f32::consts::PI;
                    let norm_dist = (dist / 100.0).clamp(0.0, 1.0);

                    if actor.is_player {
                        nearest_player_dist = norm_dist;
                        // nearest_player_angle = relative_angle.clamp(-1.0, 1.0);
                        nearest_player_angle = world_angle / std::f32::consts::PI;  // Absolute, no yaw subtraction
                    } else if actor.squad_id == squad_id {
                        if dist > 0.1 && norm_dist < nearest_ally_dist {
                            nearest_ally_dist = norm_dist;
                            // nearest_ally_angle = relative_angle.clamp(-1.0, 1.0);
                            nearest_ally_angle = world_angle / std::f32::consts::PI;  // Absolute, no yaw subtraction
                        }
                        if dist < 20.0 { nearby_ally_count += 0.1; }
                    } else {
                        if dist < 20.0 { nearby_enemy_count += 0.1; }
                    }
                }

                // println!(
                //     "Entity Update: {:?} {:?} {:?} {:?}", entity_id, pos, yaw / std::f32::consts::PI, nearest_player_angle
                // );

                // NOTE: the nearest player is the primary enemy of these yumon NPCs right now
                world[crate::yumon::system::WorldIdx::NearestThreatDist as usize] = nearest_player_dist;
                world[crate::yumon::system::WorldIdx::NearestThreatAngle as usize] = nearest_player_angle;
                world[crate::yumon::system::WorldIdx::NearestAllyDist as usize] = nearest_ally_dist;
                world[crate::yumon::system::WorldIdx::NearestAllyAngle as usize] = nearest_ally_angle;
                world[crate::yumon::system::WorldIdx::NearbyEnemyCount as usize] = nearby_enemy_count.clamp(0.0, 1.0);
                world[crate::yumon::system::WorldIdx::NearbyAllyCount as usize] = nearby_ally_count.clamp(0.0, 1.0);
                world[crate::yumon::system::WorldIdx::AlertLevel as usize] = alert_level;
                world[crate::yumon::system::WorldIdx::PathClearForward as usize] = 1.0;
                world[crate::yumon::system::WorldIdx::LightLevel as usize] = 0.8;

                let mut self_state = [0.0f32; crate::yumon::system::SELF_SIZE];
                self_state[crate::yumon::system::SelfIdx::HealthPct as usize] = health_pct;
                self_state[crate::yumon::system::SelfIdx::StaminaPct as usize] = stamina_pct;
                self_state[crate::yumon::system::SelfIdx::Ammo as usize] = 1.0;
                self_state[crate::yumon::system::SelfIdx::IsGrounded as usize] = 1.0;
                self_state[crate::yumon::system::SelfIdx::Speed as usize] = (speed / 10.0).clamp(0.0, 1.0);
                self_state[crate::yumon::system::SelfIdx::Clock as usize] = ((current_time as f32) % 100.0) / 100.0;

                targets.push(YumonTarget {
                    entity_id: entity_id.clone(),
                    brain_id: yumon_id,
                    world,
                    self_state,
                    yaw,
                });
                yumon_processed.insert(entity_id);
            }

            }

            let mut commands: Vec<(String, crate::yumon::system::Action, f32)> = Vec::new();
            {
                let mut op_state = self.runtime.op_state();
                let mut op_state = op_state.borrow_mut();
                let ctx = op_state.borrow_mut::<AddonContext>();

                ctx.yumon_runtime_actions
                    .retain(|entity_id, _| yumon_processed.contains(entity_id));
                ctx.yumon_instances
                    .retain(|entity_id, _| yumon_processed.contains(entity_id));

                for target in targets {
                    let runtime = ctx
                        .yumon_runtime_actions
                        .entry(target.entity_id.clone())
                        .or_insert_with(|| {
                            // Hash entity_id for deterministic but staggered start
                            let mut hasher = std::collections::hash_map::DefaultHasher::new();
                            std::hash::Hash::hash(&target.entity_id, &mut hasher);
                            let hash_val = std::hash::Hasher::finish(&hasher);
                            let offset = (hash_val % 100) as f64 / 100.0 * YUMON_INFER_INTERVAL_SECS;
                            
                            YumonActionState {
                                action: crate::yumon::system::Action::Idle,
                                absolute_rotation: 0.0,
                                last_infer_time: current_time - YUMON_INFER_INTERVAL_SECS + offset,
                            }
                        });

                    if current_time - runtime.last_infer_time >= YUMON_INFER_INTERVAL_SECS {
                        // Get or create instance brain
                        let brain = if let Some(instance) = ctx.yumon_instances.get_mut(&target.entity_id) {
                            Some(instance)
                        } else if let Some(archetype) = ctx.yumon_brains.get(&target.brain_id) {
                            let new_instance = archetype.clone_instance();
                            ctx.yumon_instances.insert(target.entity_id.clone(), new_instance);
                            ctx.yumon_instances.get_mut(&target.entity_id)
                        } else {
                            None
                        };

                        if let Some(brain) = brain {
                            // Maintain a rolling context from live runtime state before infer.
                            brain.observe(
                                &target.world,
                                &target.self_state,
                                runtime.action,
                                target.yaw / std::f32::consts::PI, // Pass absolute yaw normalized -1..1
                                0.0,
                            );

                            if let Some(infer) = brain.infer_if_ready() {
                                // println!("inferred {:?} {:?}", target.entity_id, infer);
                                runtime.action = infer.action;
                                runtime.absolute_rotation = infer.absolute_rotation;
                            }
                            runtime.last_infer_time = current_time;
                        }
                    }

                    commands.push((
                        target.entity_id,
                        runtime.action,
                        runtime.absolute_rotation,
                    ));
                }
            }

            let (addon_models, addon_meshes, rigid_body_set) = (
                &mut renderer_state.addon_models,
                &mut renderer_state.addon_meshes,
                &mut renderer_state.rigid_body_set,
            );

            let action_callbacks = {
                let state = self.runtime.op_state();
                let state = state.borrow();
                let context = state.borrow::<AddonContext>();
                if context.project_id.is_some() {
                    context
                        .on_action_callbacks
                        .iter()
                        // .filter(|(name, _)| name == &current_addon_name)
                        .cloned()
                        .collect::<Vec<_>>()
                } else {
                    Vec::new()
                }
            };

            {
                // NOTE: this block may be unneeded
                let mut op_state = self.runtime.op_state();
                let mut op_state = op_state.borrow_mut();
                let ctx = op_state.borrow_mut::<AddonContext>();

                for (entity_id, action, absolute_rotation) in commands.clone() {
                    let state = ctx.npc_motion_states.entry(entity_id.clone()).or_insert_with(|| NpcMotionState {
                        entity_id:      entity_id.clone(),
                        current_move:   0.0,
                        current_yaw:    0.0,
                        pending_actions: Vec::new(),
                    });

                    match action {
                        Action::MoveForward  => { state.current_move = 1.0; }
                        Action::MoveBackward => { state.current_move = -1.0; }
                        Action::Idle         => { state.current_move = 0.0; }
                        Action::ButtonX | Action::ButtonY |
                        Action::LBumper | Action::RBumper |
                        Action::LTrigger | Action::RTrigger => {}
                        _ => {} // everything else leaves motion state alone
                    }
                }
            }

            {
                for (entity_id, action, absolute_rotation) in commands {
                    // Find the entity to get its position and orientation
                    let mut found_pos = None;
                    let mut found_forward = None;

                    for models in addon_models.values() {
                        if let Some(model) = models.iter().find(|m| m.id == entity_id) {
                            if let Some(mesh) = model.meshes.first() {
                                let pos = mesh.transform.position;
                                let (_, yaw, _) = mesh.transform.rotation.euler_angles();
                                let forward = nalgebra::Vector3::new(yaw.sin(), 0.0, yaw.cos());
                                found_pos = Some([pos.x, pos.y, pos.z]);
                                found_forward = Some([forward.x, forward.y, forward.z]);
                                break;
                            }
                        }
                    }

                    if found_pos.is_none() {
                        for meshes in addon_meshes.values() {
                            if let Some(mesh) = meshes.iter().find(|m| m.id == entity_id) {
                                let pos = mesh.transform.position;
                                let (_, yaw, _) = mesh.transform.rotation.euler_angles();
                                let forward = nalgebra::Vector3::new(yaw.sin(), 0.0, yaw.cos());
                                found_pos = Some([pos.x, pos.y, pos.z]);
                                found_forward = Some([forward.x, forward.y, forward.z]);
                                break;
                            }
                        }
                    }

                    if let (Some(pos), Some(forward)) = (found_pos, found_forward) {
                        let pending = PendingAction {
                            entity_id:  entity_id.clone(),
                            action,
                            origin:    pos,
                            direction: forward,
                        };
                        
                        // Trigger callbacks
                        // TODO: function calls within onAction on JS-side also borrow the context
                        // let callbacks = ctx.on_action_callbacks.clone();
                        for (addon_name, callback) in &action_callbacks {
                            let scope = &mut self.runtime.handle_scope();
                            let tc = &mut v8::TryCatch::new(scope);
                            let cb = v8::Local::new(tc, callback);
                            let recv = v8::undefined(tc).into();
                            
                            // Serialize pending action to JS object
                            let entity_id_js = v8::String::new(tc, &pending.entity_id).unwrap().into();
                            let action_js = v8::Integer::new(tc, pending.action as i32).into();

                            let absolute_rotation_js = v8::Number::new(tc, absolute_rotation as f64);
                            
                            let origin_js = v8::Array::new(tc, 3);
                            for i in 0..3 {
                                let val = v8::Number::new(tc, pending.origin[i] as f64).into();
                                origin_js.set_index(tc, i as u32, val);
                            }
                            
                            let direction_js = v8::Array::new(tc, 3);
                            for i in 0..3 {
                                let val = v8::Number::new(tc, pending.direction[i] as f64).into();
                                direction_js.set_index(tc, i as u32, val);
                            }

                            let obj = v8::Object::new(tc);
                            let entity_id_key = v8::String::new(tc, "entityId").unwrap();
                            let action_key = v8::String::new(tc, "action").unwrap();
                            let origin_key = v8::String::new(tc, "origin").unwrap();
                            let direction_key = v8::String::new(tc, "direction").unwrap();
                            let absolute_rotation_key = v8::String::new(tc, "absoluteRotation").unwrap();

                            obj.set(tc, entity_id_key.into(), entity_id_js);
                            obj.set(tc, action_key.into(), action_js);
                            obj.set(tc, origin_key.into(), origin_js.into());
                            obj.set(tc, direction_key.into(), direction_js.into());
                            obj.set(tc, absolute_rotation_key.into(), absolute_rotation_js.into());

                            cb.call(tc, recv, &[obj.into()]);

                            if let Some(exception) = tc.exception() {
                                let msg = exception.to_rust_string_lossy(tc);
                                println!("[ADDON ACTION ERROR in {}] {}", addon_name, msg);
                            }
                        }
                        
                        // state.pending_actions.push(pending); // unused
                    }
                }
            }
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
            if context.project_id.is_some() {
                context
                    .on_update_callbacks
                    .iter()
                    .filter(|(name, _)| name == &current_addon_name)
                    .cloned()
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            }
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
            // println!("Non empty events {:?}", events);

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
            // println!("input_events 1 {:?}", input_events.get(0));
            let scope = &mut self.runtime.handle_scope();
            let global = scope.get_current_context().global(scope);
            let entropy_key = v8::String::new(scope, "Entropy").unwrap();
            if let Some(entropy_val) = global.get(scope, entropy_key.into()) {
                if entropy_val.is_object() {
                    let entropy_obj = entropy_val.to_object(scope).unwrap();
                    let process_key = v8::String::new(scope, "_process_input_events").unwrap();
                    if let Some(process_val) = entropy_obj.get(scope, process_key.into()) {
                        if process_val.is_function() {
                            // println!("input_events 2");
                            let process_func = v8::Local::<v8::Function>::try_from(process_val).unwrap();
                            let args_v8 = serde_v8::to_v8(scope, input_events).unwrap();
                            let _ = process_func.call(scope, entropy_obj.into(), &[args_v8]);
                        }
                    }
                }
            }
        }

        // 2. Process pending resources
        let (pending_cubes, 
            pending_models, 
            pending_meshes, 
            pending_clears, 
            pending_mesh_clears, 
            pending_landscapes, 
            pending_grasses, 
            pending_point_lights, 
            pending_composites, 
            pending_landscape_texture_updates, 
            pending_game_mode, 
            pending_impulses, 
            pending_velocities, 
            pending_xz_velocities,
            pending_entity_rotations,
            pending_animations, 
            pending_stats,
            pending_bone_transforms,
            pending_ui_rects,
            pending_ui_texts,
            pending_ui_clear,
            pending_visuals,
            pending_alpha_models,
            pending_quadscapes
        ) = {
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
                    ctx.pending_game_mode.take(),
                    std::mem::take(&mut ctx.pending_entity_impulses),
                    std::mem::take(&mut ctx.pending_entity_velocities),
                    std::mem::take(&mut ctx.pending_entity_xz_velocities),
                    std::mem::take(&mut ctx.pending_entity_rotations),
                    std::mem::take(&mut ctx.pending_animation_plays),
                    std::mem::take(&mut ctx.pending_stat_updates),
                    std::mem::take(&mut ctx.pending_bone_transforms),
                    std::mem::take(&mut ctx.pending_ui_rects),
                    std::mem::take(&mut ctx.pending_ui_texts),
                    std::mem::replace(&mut ctx.pending_ui_clear, false),
                    std::mem::take(&mut ctx.pending_visuals),
                    std::mem::take(&mut ctx.pending_alpha_models),
                    std::mem::take(&mut ctx.pending_quadscapes)
                )
            } else {
                (
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(), 
                    None, 
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(),
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(), 
                    Vec::new(),
                    Vec::new(),
                    Vec::new(),
                    false,
                    Vec::new(),
                    Vec::new(),
                    Vec::new()
                )
            }
        };

        if let Some(enabled) = pending_game_mode {
            renderer_state.game_mode = enabled;
        }

        for (addon_name, config) in pending_alpha_models {
            if let Some(alpha) = alpha_renderer.as_mut() {
                if let Ok(bytes) = read_model(self.project_id.clone().unwrap_or_default(), config.path.clone()) {
                    let model = crate::alpha::AlphaModel::AlphaModel::from_glb(*alpha, &bytes);
                    
                    let rotation = config.rotation.unwrap_or([0.0, 0.0, 0.0]);
                    let scale = config.scale.unwrap_or([1.0, 1.0, 1.0]);
                    
                    let isometry = Isometry3::from_parts(
                        Translation3::new(config.position[0], config.position[1], config.position[2]),
                        UnitQuaternion::from_euler_angles(rotation[0], rotation[1], rotation[2])
                    );
                    
                    let mut model_matrix = isometry.to_homogeneous();
                    let scale_matrix = Matrix4::new_nonuniform_scaling(&Vector3::new(scale[0], scale[1], scale[2]));
                    model_matrix = model_matrix * scale_matrix;

                    println!("Adding alpha model instance");

                    alpha.add_instance(crate::alpha::AlphaInstanceData {
                        model_matrix: *model_matrix.as_ref(),
                        mesh_index: model.mesh_index as f32,
                        material_index: 0.0,
                        _padding: [0.0, 0.0],
                    });
                }
            }
        }

        for (id, impulse) in pending_impulses {
            // Apply to NPC
            if let Some(npc) = renderer_state.npcs.iter().find(|n| n.id == id) {
                if let Some(rb) = renderer_state.rigid_body_set.get_mut(*npc.rigid_body_handle.as_ref().expect("Couldnt get handle")) {
                    rb.apply_impulse(nalgebra::vector![impulse[0], impulse[1], impulse[2]], true);
                }
            } 
            // Apply to Player
            else if let Some(player) = &renderer_state.player_character {
                if player.id == id {
                    if let Some(rb_handle) = player.movement_rigid_body_handle {
                        if let Some(rb) = renderer_state.rigid_body_set.get_mut(rb_handle) {
                            rb.apply_impulse(nalgebra::vector![impulse[0], impulse[1], impulse[2]], true);
                        }
                    }
                }
            }
        }

        for (id, velocity) in pending_velocities {
            // Apply to NPC
            if let Some(npc) = renderer_state.npcs.iter().find(|n| n.id == id) {
                if let Some(rb) = renderer_state.rigid_body_set.get_mut(*npc.rigid_body_handle.as_ref().expect("Couldnt get handle")) {
                    rb.set_linvel(nalgebra::vector![velocity[0], velocity[1], velocity[2]], true);
                    // rb.add_force(nalgebra::vector![velocity[0], velocity[1], velocity[2]], true);
                }
            } 
            // Apply to Player
            else if let Some(player) = &renderer_state.player_character {
                if player.id == id {
                    if let Some(rb_handle) = player.movement_rigid_body_handle {
                        if let Some(rb) = renderer_state.rigid_body_set.get_mut(rb_handle) {
                            rb.set_linvel(nalgebra::vector![velocity[0], velocity[1], velocity[2]], true);
                            // rb.add_force(nalgebra::vector![velocity[0], velocity[1], velocity[2]], true);
                        }
                    }
                }
            }
        }

        for (id, velocity_xz) in pending_xz_velocities {
            // Apply to NPC
            if let Some(npc) = renderer_state.npcs.iter_mut().find(|n| n.id == id) {
                if let Some(rb) = renderer_state.rigid_body_set.get_mut(*npc.rigid_body_handle.as_ref().expect("Couldnt get handle")) {
                    let current_vel = rb.linvel();
                    rb.set_linvel(nalgebra::vector![velocity_xz[0], current_vel.y, velocity_xz[1]], true);
                }
            } 
            // Apply to Player
            else if let Some(player) = &renderer_state.player_character {
                if player.id == id {
                    if let Some(rb_handle) = player.movement_rigid_body_handle {
                        if let Some(rb) = renderer_state.rigid_body_set.get_mut(rb_handle) {
                            let current_vel = rb.linvel();
                            rb.set_linvel(nalgebra::vector![velocity_xz[0], current_vel.y, velocity_xz[1]], true);
                        }
                    }
                }
            }
        }

        for (id, rotation) in pending_entity_rotations {
            // Apply to NPC
            if let Some(npc) = renderer_state.npcs.iter_mut().find(|n| n.id == id) {
                if let Some(mesh) = renderer_state.addon_meshes.values_mut().flatten().find(|n| n.id == id) {
                    if let Some(transform) = &mut npc.transform {
                        transform.update_rotation(rotation);
                        mesh.transform.update_rotation(rotation);
                    }
                } 
            } 
            // Apply to Player
            else if let Some(player) = &mut renderer_state.player_character {
                if player.id == id {
                    if let Some(transform) = &mut player.transform {
                        transform.update_rotation(rotation);
                    }
                }
            }
        }

        for (id, anim_name) in pending_animations {
            // Find NPC and its associated model
            if let Some(npc) = renderer_state.npcs.iter_mut().find(|n| n.id == id) {
                if let Some(model) = renderer_state.models.iter_mut().find(|m| m.id == npc.model_id) {
                    if let Some(idx) = model.animations.iter().position(|a| a.name.to_lowercase().contains(&anim_name.to_lowercase())) {
                        npc.animation_state.animation_index = idx;
                    }
                }
            }
        }

        for (id, stats) in pending_stats {
            if let Some(npc) = renderer_state.npcs.iter_mut().find(|n| n.id == id) {
                npc.stats = stats;
            } else if let Some(player) = &mut renderer_state.player_character {
                if player.id == id {
                    player.stats = stats;
                }
            }
        }

        for bt in pending_bone_transforms {
            if let Some(model) = renderer_state.models.iter_mut().find(|m| m.id == bt.model_id) {
                if let Some(node_idx) = model.nodes.iter().position(|n| n.name == bt.bone_name) {
                    let node = &mut model.nodes[node_idx];
                    if let Some(pos) = bt.position {
                        node.transform.position = nalgebra::Vector3::new(pos[0], pos[1], pos[2]);
                    }
                    if let Some(rot) = bt.rotation {
                        node.transform.rotation = nalgebra::UnitQuaternion::from_quaternion(nalgebra::Quaternion::new(rot[3], rot[0], rot[1], rot[2]));
                    }
                    if let Some(scale) = bt.scale {
                        node.transform.scale = nalgebra::Vector3::new(scale[0], scale[1], scale[2]);
                    }
                    
                    // Manually trigger matrix updates
                    // Note: Ideally we should call a centralized update_global_transforms(model) here
                    // similar to what animation_system.rs does.
                    
                    // We can reuse the update logic from animation_system if we make it public or duplicate it
                    // For now, let's just mark it as needing update if we had such a flag, 
                    // or just run the update logic right here for this model.
                    
                    fn update_node_recursive(nodes: &mut [crate::art_assets::Model::Node], parent_transform: &nalgebra::Matrix4<f32>, node_idx: usize, queue: &wgpu::Queue) {
                        let (global_transform, children) = {
                            let node = &mut nodes[node_idx];
                            let local_transform = node.transform.update_transform();
                            node.global_transform = parent_transform * local_transform;
                            (node.global_transform, node.children.clone())
                        };

                        let raw_matrix = crate::core::Transform_2::matrix4_to_raw_array(&global_transform);
                        queue.write_buffer(&nodes[node_idx].transform.uniform_buffer, 0, bytemuck::cast_slice(&raw_matrix));

                        for child_idx in children {
                            update_node_recursive(nodes, &global_transform, child_idx, queue);
                        }
                    }

                    if let gpu = &gpu_resources {
                        let root_nodes = model.root_nodes.clone();
                        for root_idx in root_nodes {
                            update_node_recursive(&mut model.nodes, &nalgebra::Matrix4::identity(), root_idx, &gpu.queue);
                        }

                        // Also update skinning buffer if it exists
                        if let Some(joint_matrices_buffer) = model.joint_matrices_buffer.as_ref() {
                            if let Some(skin) = model.skins.first() {
                                let mut joint_transforms: Vec<[f32; 16]> = Vec::with_capacity(skin.joints.len());
                                for (joint_node_index, inverse_bind_matrix) in skin.joints.iter().zip(skin.inverse_bind_matrices.iter()) {
                                    let joint_node = &model.nodes[*joint_node_index];
                                    let skinning_matrix = joint_node.global_transform * inverse_bind_matrix;
                                    joint_transforms.push(skinning_matrix.as_slice().try_into().unwrap());
                                }
                                gpu.queue.write_buffer(joint_matrices_buffer, 0, bytemuck::cast_slice(&joint_transforms));
                            }
                        }
                    }
                }
            }
        }

        if pending_ui_clear {
            ui_polygons.clear();
            ui_textboxes.clear();
        }

        if !pending_ui_rects.is_empty() {
            if let gpu = &gpu_resources {
                let window_size = crate::core::editor::WindowSize {
                    width: camera.viewport.width as u32,
                    height: camera.viewport.height as u32,
                };
                // let ui_model_bind_group_layout = ui_model_bind_group_layout.as_ref().expect("No ui model layout");
                // let group_bind_group_layout = group_bind_group_layout.as_ref().expect("No group layout");

                for (_addon_name, config) in pending_ui_rects {
                    // let poly_bg_pos = Point { 
                    //     x: config.position[0] + (config.size[0] / 2.0), 
                    //     y: config.position[1] + (config.size[1] / 2.0) 
                    // };

                    let poly_bg_pos = Point { 
                        x: config.position[0], 
                        y: config.position[1]
                    };
                    
                    let id = Uuid::new_v4();
                    let rect = Polygon::new(
                        &window_size,
                        &gpu.device,
                        &gpu.queue,
                        ui_model_bind_group_layout,
                        group_bind_group_layout,
                        camera,
                        vec![Point{x:0.0, y:0.0}, Point{x:1.0, y:0.0}, Point{x:1.0, y:1.0}, Point{x:0.0, y:1.0}],
                        (config.size[0], config.size[1]),
                        poly_bg_pos,
                        (0.0, 0.0, 0.0),
                        0.0,
                        config.color,
                        Stroke { thickness: config.stroke_thickness, fill: config.stroke_color },
                        config.layer,
                        "JS UI Rect".to_string(),
                        id,
                        Uuid::nil(),
                    );
                    ui_polygons.push(rect);
                }
            }
        }

        if !pending_ui_texts.is_empty() {
            if let gpu = &gpu_resources {
                let window_size = crate::core::editor::WindowSize {
                    width: camera.viewport.width as u32,
                    height: camera.viewport.height as u32,
                };
                // let ui_model_bind_group_layout = ui_model_bind_group_layout.as_ref().expect("No ui model layout");
                // let group_bind_group_layout = group_bind_group_layout.as_ref().expect("No group layout");

                for (_addon_name, config) in pending_ui_texts {
                    let id = Uuid::new_v4();
                    let font_bytes = font_manager.get_font_by_name(&config.font_family)
                        .unwrap_or_else(|| &font_manager.font_data[0].1);

                    let text_config = TextRendererConfig {
                        id,
                        name: "JS UI Text".to_string(),
                        text: config.text.clone(),
                        font_family: config.font_family,
                        font_size: config.font_size as i32,
                        dimensions: (config.dimensions[0], config.dimensions[1]),
                        position: Point { x: config.position[0], y: config.position[1] },
                        layer: config.layer,
                        color: [
                            (config.color[0] * 255.0) as i32,
                            (config.color[1] * 255.0) as i32,
                            (config.color[2] * 255.0) as i32,
                            (config.color[3] * 255.0) as i32,
                        ],
                        background_fill: [
                            (config.background_fill[0] * 255.0) as i32,
                            (config.background_fill[1] * 255.0) as i32,
                            (config.background_fill[2] * 255.0) as i32,
                            (config.background_fill[3] * 255.0) as i32,
                        ],
                    };
                    
                    let mut text_renderer = TextRenderer::new(
                        &gpu.device,
                        &gpu.queue,
                        ui_model_bind_group_layout,
                        group_bind_group_layout,
                        font_bytes,
                        &window_size,
                        config.text,
                        text_config,
                        id,
                        Uuid::nil(),
                        camera
                    );

                    text_renderer.render_text(&gpu.device, &gpu.queue);
                    ui_textboxes.push(text_renderer);
                }
            }
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
                    let id = config.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                    
                    let pos = Vector3::new(config.position[0], config.position[1], config.position[2]);
                    let rot = config.rotation.unwrap_or([0.0, 0.0, 0.0]);
                    let rot_quat = UnitQuaternion::from_euler_angles(rot[0], rot[1], rot[2]);
                    let isometry = Isometry3::from_parts(pos.into(), rot_quat);
                    let scale_val = config.scale.unwrap_or([1.0, 1.0, 1.0]);
                    let scale = Vector3::new(scale_val[0], scale_val[1], scale_val[2]);

                    let visual_type = config.visual_type.unwrap_or_default();

                    if visual_type == crate::helpers::saved_data::VisualType::Model {
                        let path = config.path.as_ref().expect("Path is required for Model visual type");
                        let bytes = {
                        let mut op_state = self.runtime.op_state();
                        let mut op_state = op_state.borrow_mut();
                        let ctx = op_state.try_borrow_mut::<AddonContext>().expect("Failed to borrow AddonContext");
                        
                        if let Some(cached_bytes) = ctx.model_cache.get(path) {
                            cached_bytes.clone()
                        } else {
                            println!("Reading in model: {:?}", path);
                            let bytes = crate::art_assets::Model::read_model(project_id.clone(), path.clone()).expect("Couldn't get model bytes");
                            ctx.model_cache.insert(path.clone(), bytes.clone());
                            bytes
                        }
                    };

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
                    }

                    if let Some(mut player_props) = config.player {
                        player_props.visual_type = Some(visual_type);
                        renderer_state.add_player_character(
                            &gpu.device,
                            &gpu.queue,
                            id.clone(),
                            isometry,
                            scale,
                            camera,
                            player_props
                        );
                    } else if let Some(is_npc) = config.is_npc {
                        if is_npc {
                            let mut npc_props = config.npc.unwrap_or_default();
                            npc_props.visual_type = Some(visual_type);
                            renderer_state.add_npc(
                                id.clone(),
                                npc_props,
                                config.behavior_id,
                                None, // visual config is supplied on pending_visuals
                            );
                        }
                    } else {
                        renderer_state.add_collider(id.clone(), crate::helpers::saved_data::ComponentKind::Model, None);
                    }

                    if let Some(models) = renderer_state.addon_models.get_mut(&addon_name) {
                        if let Some(model) = models.iter_mut().find(|m| m.id == id) {
                            model.yumon_id = config.yumon_id.clone();
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
            if let gpu = &gpu_resources {
                                for (addon_name, config) in pending_meshes {
                                     let (pipeline, pipeline_id) = {
                                         let op_state = self.runtime.op_state();
                                         let op_state = op_state.borrow();
                                         
                                         let custom_pipeline = if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                                                 ctx.pipelines.get(&config.pipeline_id).cloned()
                                         } else {
                                             None
                                         };

                                         println!("Create mesh {:?} {:?} {:?}", addon_name, config.pipeline_id, custom_pipeline.is_some());
                
                                         if let Some(p) = custom_pipeline {
                                             (Some(p), config.pipeline_id.clone())
                                         } else if config.pipeline_id == "default" {
                                             // "default" is handled in render_addon_frame.rs using the engine's geometry_pipeline
                                             // We just need a placeholder pipeline here to satisfy CustomMesh::new, 
                                             // but it won't be used for rendering if the ID is "default"
                                             let any_pipeline = if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                                                 ctx.pipelines.values().next().cloned()
                                             } else {
                                                 None
                                             };
                                             (any_pipeline, "default".to_string())
                                         } else {
                                             (None, config.pipeline_id.clone())
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
                                             pipeline_id,
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
                         
                         if let Some(phys) = &config.physics {
                             let mass = phys.mass.unwrap_or(70.0);
                             let friction = phys.friction.unwrap_or(0.7);
                             let restitution = phys.restitution.unwrap_or(0.0);
                             
                             let mut rb_builder = match phys.body_type.as_str() {
                                 "dynamic" => RigidBodyBuilder::dynamic(),
                                 "kinematic" => RigidBodyBuilder::kinematic_position_based(),
                                 _ => RigidBodyBuilder::fixed(),
                             };
                             
                             let uuid = uuid::Uuid::parse_str(&id).unwrap_or_else(|_| uuid::Uuid::new_v4());
                             
                             mesh.rapier_rigidbody = rb_builder
                                 .additional_mass(mass)
                                 .linear_damping(0.1)
                                 .position(Isometry3::translation(config.position[0], config.position[1], config.position[2]))
                                 .locked_axes(LockedAxes::ROTATION_LOCKED_X | LockedAxes::ROTATION_LOCKED_Z)
                                 .user_data(uuid.as_u128())
                                 .build();
                                 
                             mesh.rapier_collider = match phys.collider_shape.as_str() {
                                 "capsule" => ColliderBuilder::capsule_y(1.0, 0.5),
                                 "ball" => ColliderBuilder::ball(0.5),
                                 "cuboid" => ColliderBuilder::cuboid(1.0, 1.0, 1.0),
                                 _ => ColliderBuilder::capsule_y(1.0, 0.5),
                             }
                             .friction(friction)
                             .restitution(restitution)
                             .user_data(uuid.as_u128())
                             .build();
                         }

                         mesh.render_role = config.render_role;
                         mesh.behavior_id = config.behavior_id.clone();
                         mesh.yumon_id = config.yumon_id.clone();

                         if config.is_npc == Some(true) {
                             let npc = NPC::new(
                                 &gpu.device,
                                 &gpu.queue,
                                 id.clone(),
                                 id.clone(),
                                 VisualType::CustomMesh,
                                 None,
                                 BehaviorConfig::default(),
                                 None,
                                 Some(VisualConfig {
                                    id: Some(id.clone()),
                                    visual_name: "New NPC".to_string(),
                                    template_id: id.clone(),
                                    position: config.position.clone(),
                                    rotation: config.rotation.clone(),
                                    scale: config.scale.clone(),
                                    pipeline_id: Some(config.pipeline_id),
                                    render_role: None,
                                    physics: None,
                                    player: None,
                                    is_npc: config.is_npc,
                                    behavior_id: config.behavior_id,
                                    yumon_id: config.yumon_id,
                                 })
                             );
                             renderer_state.npcs.push(npc);
                             renderer_state.add_collider(id.clone(), ComponentKind::NPC, Some(VisualType::CustomMesh));
                         }
                         if let Some(mut player_props) = config.player.clone() {
                            player_props.visual_type = Some(VisualType::CustomMesh);
                            renderer_state.add_player_character(
                                &gpu.device,
                                &gpu.queue,
                                id.clone(),
                            Isometry3::translation(config.position[0], config.position[1], config.position[2]),
                            Vector3::from(config.scale.unwrap_or([1.0, 1.0, 1.0])),
                                camera,
                                player_props
                            );
                         }

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
            if let gpu = &gpu_resources {
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

                    {
                        let mut op_state = self.runtime.op_state();
                        let mut op_state = op_state.borrow_mut();
                        if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                            ctx.landscape_config = Some([config.size as f32, config.scale as f32, config.size as f32]);
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
                            config.size as f32, // square_size
                            config.size as f32, // square_size
                            config.scale as f32,  // square_height
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

                        renderer_state.add_collider(id.clone(), ComponentKind::Landscape, None);
                    }
                }
            }
        }

        let pending_landscape3ds = {
            let mut op_state = self.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                std::mem::take(&mut ctx.pending_landscape3ds)
            } else {
                Vec::new()
            }
        };

        if !pending_landscape3ds.is_empty() {
            if let gpu = &gpu_resources {
                for (addon_name, config) in pending_landscape3ds {
                    let mut vertices = Vec::with_capacity(config.vertices.len() / 12);
                    for chunk in config.vertices.chunks(12) {
                        if chunk.len() == 12 {
                            vertices.push(Vertex {
                                position: [chunk[0], chunk[1], chunk[2]],
                                normal: [chunk[3], chunk[4], chunk[5]],
                                tex_coords: [chunk[6], chunk[7]],
                                color: [chunk[8], chunk[9], chunk[10], chunk[11]],
                            });
                        }
                    }

                    let id = config.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());

                    let landscape = Landscape3D::new(
                        &id,
                        vertices,
                        config.indices,
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

                    renderer_state.addon_landscape3ds
                        .entry(addon_name)
                        .or_insert_with(Vec::new)
                        .push(landscape);

                    renderer_state.add_collider(id.clone(), ComponentKind::Landscape3D, None);
                }
            }
        }

        if !pending_quadscapes.is_empty() {
            if let gpu = &gpu_resources {
                for (addon_name, config) in pending_quadscapes {
                    // let mut heights = config.heights;
                    let mut heights = None; // only Rust-side for now (also is only pbr for now)

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
                                            // generated_heights.push(((val + 1.0) / 2.0 * 255.0) as u8); // u8 is choppy, kinda voxel-like
                                            generated_heights.push(((val + 1.0) / 2.0 * 65535.0) as u16);
                                        }
                                    }
                                    heights = Some(generated_heights);
                                }
                            }
                        }
                    }

                    {
                        let mut op_state = self.runtime.op_state();
                        let mut op_state = op_state.borrow_mut();
                        if let Some(ctx) = op_state.try_borrow_mut::<AddonContext>() {
                            ctx.landscape_config = Some([config.size as f32, config.scale as f32, config.size as f32]);
                        }
                    }

                    if let Some(heights) = heights {
                        // let mut scaled_like_image = Vec::new();
                        // // 1. Find the current range
                        // if !heights.is_empty() {
                        //     let mut min_h = heights[0];
                        //     let mut max_h = heights[0];
                            
                        //     for &h in &heights {
                        //         if h < min_h { min_h = h; }
                        //         if h > max_h { max_h = h; }
                        //     }

                        //     let range = max_h - min_h;

                        //     // 2. Scale the values
                        //     if range > 0.0 {
                        //         for h in heights.iter() {
                        //             scaled_like_image.push((*h - min_h) / range);
                        //         }
                        //     } else {
                        //         // If all heights are the same (range == 0), 
                        //         // set them all to 0.0 (a flat plain)
                        //         scaled_like_image.fill(0.0);
                        //     }
                        // }

                        // let data = crate::helpers::landscapes::generate_landscape_data(
                        //     config.width,
                        //     config.height,
                        //     // heights,
                        //     scaled_like_image,
                        //     config.size as f32, // square_size
                        //     config.size as f32, // square_size
                        //     config.scale as f32,  // square_height
                        // );

                        let id = config.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());

                        let terrain = Terrain::new(heights, config.width as u32, config.width as u32, config.scale as f32); // from QuadTree
                        let mut scape = QuadScape::new(terrain);

                        // we only want 1 landscape to render at any given time
                        renderer_state.addon_quadscapes
                            .insert(addon_name, vec![scape]);
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

    pub fn start_game(&mut self, game_name: &str) {
        let script = "const renderer = Entropy.Composer?.getGame('".to_owned() + game_name.clone() + "');
if (renderer) {
renderer(addon, {});
};
globalThis.Entropy._dispatchGameStarted('" + game_name.clone() + "')";
        if let Err(e) = self.runtime.execute_script("start_game", script) {
            println!("Failed to start game {}: {}", game_name, e);
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
            ctx.registered_addons.clone().into_iter().map(|(name, meta)| meta.clone()).collect()
        } else {
            Vec::new()
        }
    }

    pub fn is_render_allowed(addon_name: &str) -> bool {
        addon_name != "__VOID__"
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
                let mut sorted_windows: Vec<_> = context.ui_windows.iter().map(|(id, (config, _))| (id.clone(), config.clone())).collect();
                sorted_windows.sort_by(|a, b| a.0.cmp(&b.0));

                for (id, config) in sorted_windows {
                    let mut open = true;
                    egui::Window::new(&config.title)
                        .id(egui::Id::new(&id))
                        .resizable(config.resizable)
                        .default_size([config.default_size.width, config.default_size.height])
                        .open(&mut open)
                        .show(ctx, |ui| {
                             let widgets = context.ui_widgets.remove(&id);
                             if let Some(widgets) = widgets {
                                 Self::render_widgets(ui, &widgets, &mut events_to_push, context, egui_renderer);
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

    fn render_widgets(
        ui: &mut egui::Ui,
        widgets: &[UiWidget],
        events_to_push: &mut Vec<String>,
        context: &mut AddonContext,
        egui_renderer: &mut egui_wgpu::Renderer,
    ) {
        let mut i = 0;
        while i < widgets.len() {
            match &widgets[i] {
                UiWidget::Label { text, bold } => {
                    let mut txt = egui::RichText::new(text);
                    if bold.unwrap_or(false) {
                        txt = txt.strong();
                    }
                    ui.label(txt);
                }
                UiWidget::Button {
                    text,
                    id: btn_id,
                    label: _,
                } => {
                    if ui.button(text).clicked() {
                        events_to_push.push(btn_id.clone());
                    }
                }
                UiWidget::ColorInput {
                    id: color_id,
                    label,
                    color,
                } => {
                    ui.horizontal(|ui| {
                        ui.label(label);
                        let mut current_color = *color;
                        if ui
                            .color_edit_button_rgba_unmultiplied(&mut current_color)
                            .changed()
                        {
                            let payload = format!(
                                "{}|{},{},{},{}",
                                color_id,
                                current_color[0],
                                current_color[1],
                                current_color[2],
                                current_color[3]
                            );
                            events_to_push.push(payload);
                        }
                    });
                }
                UiWidget::Slider {
                    id: slider_id,
                    label,
                    value,
                    min,
                    max,
                } => {
                    ui.horizontal(|ui| {
                        ui.label(label);
                        let mut current_value = *value;
                        if ui
                            .add(egui::Slider::new(&mut current_value, *min..=*max))
                            .changed()
                        {
                            let payload = format!("{}|{}", slider_id, current_value);
                            events_to_push.push(payload);
                        }
                    });
                }
                UiWidget::NumericInput {
                    id: num_id,
                    label,
                    value,
                } => {
                    ui.horizontal(|ui| {
                        ui.label(label);
                        let mut current_value = *value;
                        if ui.add(egui::DragValue::new(&mut current_value)).changed() {
                            let payload = format!("{}|{}", num_id, current_value);
                            events_to_push.push(payload);
                        }
                    });
                }
                UiWidget::Dropdown {
                    id: drop_id,
                    label,
                    options,
                    selected_index,
                } => {
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
                UiWidget::Checkbox {
                    id: check_id,
                    label,
                    value,
                } => {
                    let mut current_value = *value;
                    if ui.checkbox(&mut current_value, label).changed() {
                        let payload = format!("{}|{}", check_id, current_value);
                        events_to_push.push(payload);
                    }
                }
                UiWidget::CodeEditor {
                    id: editor_id,
                    label,
                    content,
                    language,
                } => {
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
                UiWidget::MiniMap {
                    id: mm_id,
                    landscape_id: _,
                    brush_size,
                    markers,
                    polylines,
                } => {
                    let texture_id = if let Some(view) = &context.landscape_texture_view {
                        let key = format!("landscape_{}", mm_id);
                        if let Some(tid) = context.egui_textures.get(&key) {
                            *tid
                        } else {
                            let tid = egui_renderer.register_native_texture(
                                &context.gpu_resources.as_ref().unwrap().device,
                                view,
                                wgpu::FilterMode::Linear,
                            );
                            context.egui_textures.insert(key, tid);
                            tid
                        }
                    } else {
                        ui.label("Waiting for landscape texture...");
                        i += 1;
                        continue;
                    };

                    let mm_size = ui.available_size();
                    let mm_size = mm_size.x.min(mm_size.y);
                    let (rect, response) = ui.allocate_exact_size(
                        egui::vec2(mm_size, mm_size),
                        egui::Sense::click_and_drag(),
                    );

                    // Draw the landscape texture
                    ui.painter().image(
                        texture_id,
                        rect,
                        egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)),
                        egui::Color32::WHITE,
                    );

                    // Interaction: Drawing
                    if response.dragged() {
                        if let Some(pointer_pos) = response.interact_pointer_pos() {
                            let local_pos = pointer_pos - rect.min;
                            let x = local_pos.x / rect.width();
                            let y = local_pos.y / rect.height();
                            let payload = format!("{}|{},{},{}", mm_id, x, y, brush_size);
                            events_to_push.push(payload);
                        }
                    } else if response.clicked() {
                        if let Some(pointer_pos) = response.interact_pointer_pos() {
                            let local_pos = pointer_pos - rect.min;
                            let x = local_pos.x / rect.width();
                            let y = local_pos.y / rect.height();
                            let payload = format!("CLICK|{}|{},{},{}", mm_id, x, y, brush_size);
                            events_to_push.push(payload);
                        }
                    }

                    // Draw polylines
                    if let Some(polylines) = polylines {
                        for polyline in polylines {
                            if polyline.points.len() >= 2 {
                                let points: Vec<egui::Pos2> = polyline
                                    .points
                                    .iter()
                                    .map(|p| {
                                        rect.min
                                            + egui::vec2(p[0] * rect.width(), p[1] * rect.height())
                                    })
                                    .collect();

                                let color = polyline
                                    .color
                                    .map(|c| {
                                        egui::Color32::from_rgba_unmultiplied(
                                            (c[0] * 255.0) as u8,
                                            (c[1] * 255.0) as u8,
                                            (c[2] * 255.0) as u8,
                                            (c[3] * 255.0) as u8,
                                        )
                                    })
                                    .unwrap_or(egui::Color32::WHITE);
                                let stroke_width = polyline.width.unwrap_or(2.0);

                                for i in 0..points.len() - 1 {
                                    ui.painter().line_segment(
                                        [points[i], points[i + 1]],
                                        egui::Stroke::new(stroke_width, color),
                                    );
                                }
                            }
                        }
                    }

                    // Draw markers
                    for marker in markers {
                        let m_pos = rect.min
                            + egui::vec2(marker.position[0] * rect.width(), marker.position[1] * rect.height());
                        let m_color = marker
                            .color
                            .map(|c| {
                                egui::Color32::from_rgba_unmultiplied(
                                    (c[0] * 255.0) as u8,
                                    (c[1] * 255.0) as u8,
                                    (c[2] * 255.0) as u8,
                                    (c[3] * 255.0) as u8,
                                )
                            })
                            .unwrap_or(egui::Color32::RED);

                        ui.painter().circle_filled(m_pos, 5.0, m_color);
                        if let Some(label) = &marker.label {
                            ui.painter().text(
                                m_pos + egui::vec2(7.0, 0.0),
                                egui::Align2::LEFT_CENTER,
                                label,
                                egui::FontId::proportional(12.0),
                                egui::Color32::WHITE,
                            );
                        }
                    }
                }
                UiWidget::Snarl { id: snarl_id, graph } => {
                    let snarl = context
                        .snarl_states
                        .entry(snarl_id.clone())
                        .or_insert_with(egui_snarl::Snarl::new);

                    if snarl.nodes().next().is_none() && !graph.nodes.is_empty() {
                        for node in &graph.nodes {
                            snarl.insert_node(
                                egui::Pos2::new(node.position[0], node.position[1]),
                                BehaviorNodeState {
                                    id: node.id.clone(),
                                    name: node.name.clone(),
                                    node_type: node.node_type.clone(),
                                    inputs: node.inputs.clone(),
                                    outputs: node.outputs.clone(),
                                    properties: node.properties.clone(),
                                },
                            );
                        }
                    }

                    let mut viewer = BehaviorViewer {
                        snarl_id: snarl_id.clone(),
                        events: context.ui_events.clone(),
                    };

                    snarl.show(
                        &mut viewer,
                        &egui_snarl::ui::SnarlStyle::default(),
                        egui::Id::new(snarl_id),
                        ui,
                    );
                }
                UiWidget::CollapsingHeader { title, id } => {
                    // Find matching EndCollapsingHeader
                    let mut depth = 1;
                    let mut end_idx = i + 1;
                    while end_idx < widgets.len() && depth > 0 {
                        match &widgets[end_idx] {
                            UiWidget::CollapsingHeader { .. } => depth += 1,
                            UiWidget::EndCollapsingHeader => depth -= 1,
                            _ => {}
                        }
                        if depth > 0 {
                            end_idx += 1;
                        }
                    }

                    if end_idx < widgets.len() {
                        let sub_widgets = &widgets[i + 1..end_idx];
                        egui::CollapsingHeader::new(title)
                            .id_source(id)
                            .show(ui, |ui| {
                                Self::render_widgets(ui, sub_widgets, events_to_push, context, egui_renderer);
                            });
                        i = end_idx;
                    }
                }
                UiWidget::EndCollapsingHeader => {}
                UiWidget::StartHorizontal => {
                    // Find matching EndHorizontal
                    let mut depth = 1;
                    let mut end_idx = i + 1;
                    while end_idx < widgets.len() && depth > 0 {
                        match &widgets[end_idx] {
                            UiWidget::StartHorizontal => depth += 1,
                            UiWidget::EndHorizontal => depth -= 1,
                            _ => {}
                        }
                        if depth > 0 {
                            end_idx += 1;
                        }
                    }

                    if end_idx < widgets.len() {
                        let sub_widgets = &widgets[i + 1..end_idx];
                        ui.horizontal(|ui| {
                            Self::render_widgets(ui, sub_widgets, events_to_push, context, egui_renderer);
                        });
                        i = end_idx;
                    }
                }
                UiWidget::EndHorizontal => {}
                UiWidget::Separator => {
                    ui.separator();
                }
            }
            i += 1;
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
                 let widgets = context.ui_widgets.remove(tab_id);
                 if let Some(widgets) = widgets {
                    Self::render_widgets(ui, &widgets, &mut events_to_push, context, egui_renderer);
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
