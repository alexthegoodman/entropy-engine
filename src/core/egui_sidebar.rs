use crate::core::skinned_pipeline::SkinnedPipeline;
use crate::core::chat::{Chat, ChatMessage, ChatSession, ToolCall};
use crate::game_behaviors::stateful::{BehaviorConfig, CombatType};
use crate::handlers::{handle_add_collectable, handle_add_npc, handle_add_water_plane};
use crate::helpers::landscapes::generate_landscape_data;
use crate::helpers::saved_data::{self, AttackStats, CollectableProperties, CollectableType, LightProperties, NPCProperties};
use crate::helpers::utilities::save_heightmap;
use crate::procedural_heightmaps::heightmap_generation::{FalloffType, FeatureType, HeightmapGenerator, TerrainFeature};
use crate::water_plane::config::WaterConfig;
use crate::{
    core::{Grid::{Grid, GridConfig}, RendererState::RendererState, SimpleCamera::SimpleCamera as Camera, Texture::pack_pbr_textures, camera::{self, CameraBinding}, editor::{
        Editor, PointLight, Viewport, WindowSize, WindowSizeShader
    }, gpu_resources::{self, GpuResources}, vertex::Vertex}, handlers::{EntropySize, handle_add_model}, heightfield_landscapes::Landscape::{PBRMaterialType, PBRTextureKind}, helpers::{landscapes::{read_landscape_heightmap_as_texture, read_texture_bytes}, saved_data::{ComponentData, GenericProperties, ComponentKind, LandscapeTextureKinds, LevelData, PBRTextureData, ProceduralSkyConfig, SavedState}, timelines::SavedTimelineStateConfig, utilities}, procedural_trees::trees::DrawTrees, vector_animations::animations::Sequence, video_export::frame_buffer::FrameCaptureBuffer, water_plane::water::DrawWater
};
use crate::core::Texture::Texture;
use crate::core::shadow_pipeline::ShadowPipelineData;
use crate::core::ui_pipeline::UiPipeline;
use crate::core::HealthBar::HealthBar;
use crate::core::editor::Point;
use std::{fs, sync::{Arc, Mutex}};
// use cgmath::{Point3, Vector3};
use nalgebra::{Isometry3, Point3, Translation3, UnitQuaternion, Vector3};
use transform_gizmo::math::{DMat4, DVec3, DVec4};
use uuid::Uuid;
use pollster; // For pollster::block_on
use transform_gizmo::math::Vec4Swizzles;
use serde::{Deserialize, Serialize};
use serde_json;

use crate::shape_primitives::Cube::Cube;
use crate::shape_primitives::Sphere::Sphere;
use crate::helpers::load_project::load_project;
use crate::rhai_engine::{ComponentChanges, RhaiEngine};
use crate::game_ui::dialogue_ui;
use crate::game_ui::quest_ui;
use crate::procedural_particles::particle_system::{ParticleSystem, ParticleUniforms};

#[cfg(target_arch = "wasm32")]
use web_sys::HtmlCanvasElement;
use wgpu::{Limits, RenderPipeline, util::DeviceExt};
use bytemuck::{Pod, Zeroable}; // For procedural sky uniform

#[cfg(target_os = "windows")]
use winit::window::Window;

#[cfg(target_os = "windows")]
use egui;
use egui_dock::{DockArea, DockState, NodeIndex, Style, TabViewer};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tab {
    Projects,
    Components,
    Properties,
    Chat,
    AssetLibrary,
    Controls,
}

#[cfg(target_os = "windows")]
use crate::startup::Gui;

pub struct UiContext<'a> {
    pub export_editor: &'a mut Option<Editor>,
    pub new_project_name: &'a mut String,
    pub projects: &'a mut Vec<String>,
    pub selected_component_id: &'a mut Option<String>,
    pub chat: &'a mut Chat,
    pub gpu_resources: &'a Option<Arc<GpuResources>>,
}

pub struct PipelineTabViewer<'a> {
    pub context: UiContext<'a>,
}

impl<'a> PipelineTabViewer<'a> {
    fn execute_tool_call(&mut self, tool_call: ToolCall) {
        println!("Executing tool call: {}", tool_call.function.name);
    
        #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TransformObjectArgs {
        component_id: String,
        translation: Option<[f32; 3]>,
        rotation: Option<[f32; 3]>,
        scale: Option<[f32; 3]>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    // #[serde(rename_all = "camelCase")]
    struct ConfigureWaterArgs {
        #[serde(rename = "componentId")]
        component_id: Option<String>,
        shallow_color: Option<[f32; 3]>,
        medium_color: Option<[f32; 3]>,
        deep_color: Option<[f32; 3]>,
        ripple_amplitude_multiplier: Option<f32>,
        ripple_freq: Option<f32>,
        ripple_speed: Option<f32>,
        shoreline_foam_range: Option<f32>,
        crest_foam_min: Option<f32>,
        crest_foam_max: Option<f32>,
        sparkle_intensity: Option<f32>,
        sparkle_threshold: Option<f32>,
        subsurface_multiplier: Option<f32>,
        fresnel_power: Option<f32>,
        fresnel_multiplier: Option<f32>,

        // Wave 1 - primary wave
        pub wave1_amplitude: Option<f32>,
        pub wave1_frequency: Option<f32>,
        pub wave1_speed: Option<f32>,
        pub wave1_steepness: Option<f32>,
        pub wave1_direction: Option<[f32; 2]>,

        // Wave 2 - secondary wave
        pub wave2_amplitude: Option<f32>,
        pub wave2_frequency: Option<f32>,
        pub wave2_speed: Option<f32>,
        pub wave2_steepness: Option<f32>,
        pub wave2_direction: Option<[f32; 2]>,

        // Wave 3 - tertiary wave
        pub wave3_amplitude: Option<f32>,
        pub wave3_frequency: Option<f32>,
        pub wave3_speed: Option<f32>,
        pub wave3_steepness: Option<f32>,
        pub wave3_direction: Option<[f32; 2]>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct ConfigureGrassArgs {
        #[serde(rename = "componentId")]
        component_id: Option<String>,
        wind_strength: Option<f32>,
        wind_speed: Option<f32>,
        blade_height: Option<f32>,
        blade_width: Option<f32>,
        blade_density: Option<f32>, // Changing to f32 to match tool definition, will cast to u32
        render_distance: Option<f32>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct SpawnPrimitiveArgs {
        r#type: String,
        position: [f32; 3],
        scale: Option<[f32; 3]>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct ConfigureSkyArgs {
        #[serde(rename = "componentId")]
        component_id: Option<String>,
        horizon_color: Option<[f32; 3]>,
        zenith_color: Option<[f32; 3]>,
        sun_direction: Option<[f32; 3]>,
        sun_color: Option<[f32; 3]>,
        sun_intensity: Option<f32>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct ConfigureTreesArgs {
        #[serde(rename = "componentId")]
        component_id: Option<String>,
        seed: Option<u32>,
        trunk_height: Option<f32>,
        trunk_radius: Option<f32>,
        branch_levels: Option<u32>,
        foliage_radius: Option<f32>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct SpawnModelArgs {
        #[serde(rename = "assetId")]
        asset_id: String,
        position: Option<[f32; 3]>,
        rotation: Option<[f32; 3]>,
        scale: Option<[f32; 3]>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct SpawnPointLightArgs {
        position: [f32; 3],
        color: Option<[f32; 3]>,
        intensity: Option<f32>,
        radius: Option<f32>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct SpawnCollectableArgs {
        #[serde(rename = "assetId")]
        asset_id: String,
        r#type: String, // "Item", "MeleeWeapon", etc.
        position: Option<[f32; 3]>,
        rotation: Option<[f32; 3]>,
        scale: Option<[f32; 3]>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct SpawnNPCArgs {
        #[serde(rename = "assetId")]
        asset_id: String,
        position: Option<[f32; 3]>,
        rotation: Option<[f32; 3]>,
        scale: Option<[f32; 3]>,
        aggressiveness: Option<f32>,
        combat_type: Option<String>,
        wander_radius: Option<f32>,
        wander_speed: Option<f32>,
        detection_radius: Option<f32>,
        damage: Option<f32>,
        health: Option<f32>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct SaveScriptArgs {
        filename: String,
        content: String,
        componentId: Option<String>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct TerrainFeatureArgs {
        r#type: String,
        center: [f64; 2],
        radius: f64,
        intensity: f64,
        falloff: String,
        flat_top: Option<f64>,
        transition: Option<f64>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    struct GenerateHeightmapArgs {
        #[serde(rename = "componentId")]
        component_id: Option<String>,
        seed: Option<u32>,
        scale: Option<f64>,
        persistence: Option<f64>,
        lacunarity: Option<f64>,
        features: Option<Vec<TerrainFeatureArgs>>,
    }

    let mut saved_state_clone = None;

    let mut project_id = None;

    if let Some(editor) = &mut self.context.export_editor {
    let Editor { saved_state, renderer_state, .. } = editor;
        if let Some(saved_data) = &editor.saved_state {
            project_id = Some(saved_data.id.as_ref().expect("Couldn't get id").clone());
        }
    }

    if tool_call.function.name == "transformObject" {
        let args: Result<TransformObjectArgs, _> = serde_json::from_str(&tool_call.function.arguments);
        if let Ok(args) = args {
            // if let Some(pipeline_arc_val) = pipeline_store.get() {
            //     if let Some(pipeline_arc) = pipeline_arc_val.as_ref() {
            //         let mut pipeline = pipeline_arc.borrow_mut();
                    // if let Some(editor) = pipeline.export_editor.as_mut() {
                        // Update SavedState
                        if let Some(editor) = &mut self.context.export_editor {
let Editor { saved_state, renderer_state, .. } = editor;

                        if let Some(saved_state) = editor.saved_state.as_mut() {
                            if let Some(level) = saved_state.levels.as_mut().and_then(|l| l.get_mut(0)) {
                                if let Some(components) = level.components.as_mut() {
                                    if let Some(component) = components.iter_mut().find(|c| c.id == args.component_id) {
                                        if let Some(translation) = args.translation {
                                            component.generic_properties.position = translation;
                                        }
                                        if let Some(rotation) = args.rotation {
                                            component.generic_properties.rotation = rotation;
                                        }
                                        if let Some(scale) = args.scale {
                                            component.generic_properties.scale = scale;
                                        }
                                    }
                                }
                            }
                            saved_state_clone = Some(saved_state.clone());
                        }

                        // Update RendererState
                        if let Some(renderer_state) = editor.renderer_state.as_mut() {
                            if let Some(model) = renderer_state.models.iter_mut().find(|m| m.id == args.component_id) {
                                for mesh in model.meshes.iter_mut() {
                                    if let Some(translation) = args.translation {
                                        mesh.transform.update_position(translation);
                                    }
                                    if let Some(rotation) = args.rotation {
                                        mesh.transform.update_rotation(rotation);
                                    }
                                    if let Some(scale) = args.scale {
                                        mesh.transform.update_scale(scale);
                                    }
                                }
                            }
                        }
                    }
            //         }
            //     }
            // }
        }
    } else if tool_call.function.name == "configureWater" {
        println!("Configuring water plane...");
        let args: Result<ConfigureWaterArgs, _> = serde_json::from_str(&tool_call.function.arguments);
        if let Ok(args) = args {
            // if let Some(pipeline_arc_val) = pipeline_store.get() {
            //     if let Some(pipeline_arc) = pipeline_arc_val.as_ref() {
            //         let mut pipeline = pipeline_arc.borrow_mut();
            //         if let Some(editor) = pipeline.export_editor.as_mut() {
            if let Some(editor) = &mut self.context.export_editor {
let Editor { saved_state, renderer_state, .. } = editor;
                        if let Some(renderer_state) = editor.renderer_state.as_mut() {
                            
                            // Check if we have any water planes
                            if renderer_state.water_planes.is_empty() {
                                // Try to create one if we have a landscape
                                if let Some(landscape) = renderer_state.landscapes.first() {
                                     let landscape_id = landscape.id.clone();
                                     let device = &editor.gpu_resources.as_ref().unwrap().device;
                                     let camera_binding = editor.camera_binding.as_ref().unwrap(); 
                                     let surface_format = wgpu::TextureFormat::Rgba8Unorm; // Matching ProjectCanvas
                                     
                                     handle_add_water_plane(
                                        renderer_state, 
                                        device, 
                                        &camera_binding.bind_group_layout, 
                                        surface_format, 
                                        landscape_id.clone(), 
                                        Some(WaterConfig::default()), 
                                        Some(landscape_id.clone())
                                    );
                                     println!("Water plane created for landscape {}", landscape_id);
                                }
                            }

                            // Now configure the first water plane (assuming single water plane support for now)
                            if let Some(water_plane) = renderer_state.water_planes.get_mut(0) {
                                let mut current_config = water_plane.config; // Get current config

                                println!("Configuring water plane still... {:?}", args);

                                if let Some(color) = args.shallow_color {
                                    current_config.shallow_color = [color[0], color[1], color[2], 1.0];
                                }
                                if let Some(color) = args.medium_color {
                                    current_config.medium_color = [color[0], color[1], color[2], 1.0];
                                }
                                if let Some(color) = args.deep_color {
                                    current_config.deep_color = [color[0], color[1], color[2], 1.0];
                                }
                                if let Some(val) = args.ripple_amplitude_multiplier {
                                    current_config.ripple_amplitude_multiplier = val;
                                }
                                if let Some(val) = args.ripple_freq {
                                    current_config.ripple_freq = val;
                                }
                                if let Some(val) = args.ripple_speed {
                                    current_config.ripple_speed = val;
                                }
                                if let Some(val) = args.shoreline_foam_range {
                                    current_config.shoreline_foam_range = val;
                                }
                                if let Some(val) = args.crest_foam_min {
                                    current_config.crest_foam_min = val;
                                }
                                if let Some(val) = args.crest_foam_max {
                                    current_config.crest_foam_max = val;
                                }
                                if let Some(val) = args.sparkle_intensity {
                                    current_config.sparkle_intensity = val;
                                }
                                if let Some(val) = args.sparkle_threshold {
                                    current_config.sparkle_threshold = val;
                                }
                                if let Some(val) = args.subsurface_multiplier {
                                    current_config.subsurface_multiplier = val;
                                }
                                if let Some(val) = args.fresnel_power {
                                    current_config.fresnel_power = val;
                                }
                                if let Some(val) = args.fresnel_multiplier {
                                    current_config.fresnel_multiplier = val;
                                }

                                if let Some(val) = args.wave1_amplitude {
                                    current_config.wave1_amplitude = val;
                                }
                                if let Some(val) = args.wave1_frequency {
                                    current_config.wave1_frequency = val;
                                }
                                if let Some(val) = args.wave1_speed {
                                    current_config.wave1_speed = val;
                                }
                                if let Some(val) = args.wave1_steepness {
                                    current_config.wave1_steepness = val;
                                }
                                if let Some(val) = args.wave1_direction {
                                    current_config.wave1_direction = val;
                                }
                                
                                if let Some(val) = args.wave2_amplitude {
                                    current_config.wave2_amplitude = val;
                                }
                                if let Some(val) = args.wave2_frequency {
                                    current_config.wave2_frequency = val;
                                }
                                if let Some(val) = args.wave2_speed {
                                    current_config.wave2_speed = val;
                                }
                                if let Some(val) = args.wave2_steepness {
                                    current_config.wave2_steepness = val;
                                }
                                if let Some(val) = args.wave2_direction {
                                    current_config.wave2_direction = val;
                                }

                                if let Some(val) = args.wave3_amplitude {
                                    current_config.wave3_amplitude = val;
                                }
                                if let Some(val) = args.wave3_frequency {
                                    current_config.wave3_frequency = val;
                                }
                                if let Some(val) = args.wave3_speed {
                                    current_config.wave3_speed = val;
                                }
                                if let Some(val) = args.wave3_steepness {
                                    current_config.wave3_steepness = val;
                                }
                                if let Some(val) = args.wave3_direction {
                                    current_config.wave3_direction = val;
                                }

                                // water_plane.config = current_config;
                                water_plane.update_config(&editor.gpu_resources.as_ref().expect("Couldn't get gpu resources").queue, current_config);

                                println!("Water plane configured {:?}", water_plane.config);

                                if let Some(saved_state) = editor.saved_state.as_mut() {
                                    saved_state_clone = Some(saved_state.clone());
                                }
                            }
                        }
                    }
            //     }
            // }
        }
    } else if tool_call.function.name == "configureSky" {
        println!("Configuring sky...");
        let args: Result<ConfigureSkyArgs, _> = serde_json::from_str(&tool_call.function.arguments);
        if let Ok(args) = args {
            // if let Some(pipeline_arc_val) = pipeline_store.get() {
            //     if let Some(pipeline_arc) = pipeline_arc_val.as_ref() {
            //         let mut pipeline = pipeline_arc.borrow_mut();
            //         if let Some(editor) = pipeline.export_editor.as_mut() {
            if let Some(editor) = &mut self.context.export_editor {
let Editor { saved_state, renderer_state, .. } = editor;
                        if let Some(saved_state) = editor.saved_state.as_mut() {
                            if let Some(level) = saved_state.levels.as_mut().and_then(|l| l.get_mut(0)) {
                                if level.procedural_sky.is_none() {
                                    level.procedural_sky = Some(saved_data::ProceduralSkyConfig::default());
                                }
                                if let Some(sky) = level.procedural_sky.as_mut() {
                                    if let Some(color) = args.horizon_color { sky.horizon_color = color; }
                                    if let Some(color) = args.zenith_color { sky.zenith_color = color; }
                                    if let Some(dir) = args.sun_direction { sky.sun_direction = dir; }
                                    if let Some(color) = args.sun_color { sky.sun_color = color; }
                                    if let Some(intensity) = args.sun_intensity { sky.sun_intensity = intensity; }
                                }
                            }
                            saved_state_clone = Some(saved_state.clone());
                        }
                    }
            //     }
            // }
        }
    } else if tool_call.function.name == "configureTrees" {
        println!("Configuring trees...");
        let args: Result<ConfigureTreesArgs, _> = serde_json::from_str(&tool_call.function.arguments);
        if let Ok(args) = args {
            // if let Some(pipeline_arc_val) = pipeline_store.get() {
            //     if let Some(pipeline_arc) = pipeline_arc_val.as_ref() {
            //         let mut pipeline = pipeline_arc.borrow_mut();
            //         if let Some(editor) = pipeline.export_editor.as_mut() {
            if let Some(editor) = &mut self.context.export_editor {
let Editor { saved_state, renderer_state, .. } = editor;
                        let mut new_tree_props = None;
                        
                        // Update SavedState
                        if let Some(saved_state) = editor.saved_state.as_mut() {
                            if let Some(level) = saved_state.levels.as_mut().and_then(|l| l.get_mut(0)) {
                                if let Some(components) = level.components.as_mut() {
                                    
                                    let mut found = false;
                                    for component in components.iter_mut() {
                                        if component.kind == Some(saved_data::ComponentKind::ProceduralTree) {
                                            if let Some(target_id) = &args.component_id {
                                                if &component.id != target_id {
                                                    continue;
                                                }
                                            }
                                            
                                            if component.procedural_tree_properties.is_none() {
                                                component.procedural_tree_properties = Some(saved_data::ProceduralTreeProperties::default());
                                            }
                                            if let Some(props) = component.procedural_tree_properties.as_mut() {
                                                if let Some(val) = args.seed { props.seed = val; }
                                                if let Some(val) = args.trunk_height { props.trunk_height = val; }
                                                if let Some(val) = args.trunk_radius { props.trunk_radius = val; }
                                                if let Some(val) = args.branch_levels { props.branch_levels = val; }
                                                if let Some(val) = args.foliage_radius { props.foliage_radius = val; }
                                                new_tree_props = Some(props.clone());
                                            }
                                            found = true;
                                            break; 
                                        }
                                    }
                                    
                                    if !found && args.component_id.is_none() {
                                        let props = saved_data::ProceduralTreeProperties {
                                            seed: args.seed.unwrap_or(0),
                                            trunk_height: args.trunk_height.unwrap_or(3.5),
                                            trunk_radius: args.trunk_radius.unwrap_or(0.25),
                                            branch_levels: args.branch_levels.unwrap_or(4),
                                            foliage_radius: args.foliage_radius.unwrap_or(0.5),
                                        };
                                        
                                        let new_component = ComponentData {
                                            id: Uuid::new_v4().to_string(),
                                            kind: Some(saved_data::ComponentKind::ProceduralTree),
                                            asset_id: "".to_string(),
                                            procedural_tree_properties: Some(props.clone()),
                                            ..Default::default()
                                        };
                                        components.push(new_component);
                                        new_tree_props = Some(props);
                                        println!("Created new tree component in saved state.");
                                    }
                                }
                            }
                            saved_state_clone = Some(saved_state.clone());
                        }

                        // Update RendererState (live update)
                        if let Some(renderer_state) = editor.renderer_state.as_mut() {
                            if let Some(new_props) = new_tree_props {
                                // For now, update ALL trees since we don't have ID mapping easily accessible in renderer_state yet
                                // Or assume single tree system per level
                                for trees in &mut renderer_state.procedural_trees {
                                    let device = &editor.gpu_resources.as_ref().unwrap().device;
                                    trees.regenerate(device, new_props.clone());
                                }
                            }
                        }
                    }
            //     }
            // }
        }
    } else if tool_call.function.name == "spawnModel" {
        println!("Spawning model...");
        let args: Result<SpawnModelArgs, _> = serde_json::from_str(&tool_call.function.arguments);
        if let Ok(args) = args {
            // if let Some(pipeline_arc_val) = pipeline_store.get() {
            //     if let Some(pipeline_arc) = pipeline_arc_val.as_ref() {
            //         let mut pipeline = pipeline_arc.borrow_mut();
            //         if let Some(editor) = pipeline.export_editor.as_mut() {
            if let Some(editor) = &mut self.context.export_editor {
let Editor { saved_state, renderer_state, .. } = editor;
                        // let project_id = editor.project_id.clone();
                        let project_id = project_id.as_ref().expect("Couldn't get project id");
                        let mut asset_file_name = String::new();
                        
                        // Find asset filename in SavedState
                        if let Some(saved_state) = editor.saved_state.as_ref() {
                            if let Some(model) = saved_state.models.iter().find(|m| m.id == args.asset_id) {
                                asset_file_name = model.fileName.clone();
                            }
                        }

                        if !asset_file_name.is_empty() {
                            let component_id = Uuid::new_v4().to_string();
                            let pos = args.position.unwrap_or([0.0, 0.0, 0.0]);
                            let rot = args.rotation.unwrap_or([0.0, 0.0, 0.0]);
                            let scale = args.scale.unwrap_or([1.0, 1.0, 1.0]);

                            let model_position = Translation3::new(pos[0], pos[1], pos[2]);
                            let model_rotation = UnitQuaternion::from_euler_angles(
                                rot[0].to_radians(), rot[1].to_radians(), rot[2].to_radians()
                            );
                            let model_iso = Isometry3::from_parts(model_position, model_rotation);
                            let model_scale = Vector3::new(scale[0], scale[1], scale[2]);

                            let renderer_state = editor.renderer_state.as_mut().unwrap();
                            let gpu_resources = editor.gpu_resources.as_ref().unwrap();
                            let camera = editor.camera.as_ref().unwrap();

                            pollster::block_on(handle_add_model(
                                renderer_state,
                                &gpu_resources.device,
                                &gpu_resources.queue,
                                project_id.clone(),
                                args.asset_id.clone(),
                                component_id.clone(),
                                asset_file_name,
                                model_iso,
                                model_scale,
                                camera,
                                None // Script state
                            ));

                            // Update SavedState
                            if let Some(saved_state) = editor.saved_state.as_mut() {
                                if let Some(level) = saved_state.levels.as_mut().and_then(|l| l.get_mut(0)) {
                                    let new_component = ComponentData {
                                        id: component_id,
                                        kind: Some(ComponentKind::Model),
                                        asset_id: args.asset_id,
                                        generic_properties: GenericProperties {
                                            name: "New Model".to_string(),
                                            position: pos,
                                            rotation: rot,
                                            scale: scale,
                                        },
                                        ..Default::default()
                                    };
                                    
                                    if let Some(components) = level.components.as_mut() {
                                        components.push(new_component);
                                    } else {
                                        level.components = Some(vec![new_component]);
                                    }
                                }
                                saved_state_clone = Some(saved_state.clone());
                            }
                        } else {
                            println!("Asset not found: {}", args.asset_id);
                        }
                    }
            //     }
            // }
        }
    } else if tool_call.function.name == "spawnPointLight" {
        println!("Spawning point light...");
        let args: Result<SpawnPointLightArgs, _> = serde_json::from_str(&tool_call.function.arguments);
        if let Ok(args) = args {
            // if let Some(pipeline_arc_val) = pipeline_store.get() {
            //     if let Some(pipeline_arc) = pipeline_arc_val.as_ref() {
            //         let mut pipeline = pipeline_arc.borrow_mut();
            //         if let Some(editor) = pipeline.export_editor.as_mut() {
            if let Some(editor) = &mut self.context.export_editor {
let Editor { saved_state, renderer_state, .. } = editor;
                        let component_id = Uuid::new_v4().to_string();
                        let color = args.color.unwrap_or([1.0, 1.0, 1.0]);
                        let intensity = args.intensity.unwrap_or(1.0);
                        let radius = args.radius.unwrap_or(200.0);

                        // Update RendererState
                        if let Some(renderer_state) = editor.renderer_state.as_mut() {
                            renderer_state.point_lights.push(PointLight {
                                position: args.position,
                                _padding1: 0,
                                color,
                                _padding2: 0,
                                intensity,
                                max_distance: radius, // Using radius as max_distance
                                _padding3: [0; 2],
                            });
                        }

                        // Update SavedState
                        if let Some(saved_state) = editor.saved_state.as_mut() {
                            if let Some(level) = saved_state.levels.as_mut().and_then(|l| l.get_mut(0)) {
                                let new_component = ComponentData {
                                    id: component_id,
                                    kind: Some(ComponentKind::PointLight),
                                    asset_id: "".to_string(),
                                    generic_properties: GenericProperties {
                                        name: "New Light".to_string(),
                                        position: args.position,
                                        ..Default::default()
                                    },
                                    light_properties: Some(LightProperties {
                                        color: [color[0], color[1], color[2], 1.0],
                                        intensity,
                                        max_distance: radius
                                    }),
                                    ..Default::default()
                                };
                                
                                if let Some(components) = level.components.as_mut() {
                                    components.push(new_component);
                                } else {
                                    level.components = Some(vec![new_component]);
                                }
                            }
                            saved_state_clone = Some(saved_state.clone());
                        }
                    }
            //     }
            // }
        }
    } else if tool_call.function.name == "spawnCollectable" {
        println!("Spawning collectable...");
        let args: Result<SpawnCollectableArgs, _> = serde_json::from_str(&tool_call.function.arguments);
        if let Ok(args) = args {
            // if let Some(pipeline_arc_val) = pipeline_store.get() {
            //     if let Some(pipeline_arc) = pipeline_arc_val.as_ref() {
            //         let mut pipeline = pipeline_arc.borrow_mut();
            //         if let Some(editor) = pipeline.export_editor.as_mut() {
            if let Some(editor) = &mut self.context.export_editor {
let Editor { saved_state, renderer_state, .. } = editor;
                        // let project_id = editor.project_id.clone();
                        let project_id = project_id.as_ref().expect("Couldn't get project id");
                        let mut asset_file_name = String::new();
                        let mut stat_data = None;

                        // Find asset and default stat in SavedState
                        if let Some(saved_state) = editor.saved_state.as_ref() {
                            if let Some(model) = saved_state.models.iter().find(|m| m.id == args.asset_id) {
                                asset_file_name = model.fileName.clone();
                            }
                            if let Some(stats) = &saved_state.stats {
                                if !stats.is_empty() {
                                    stat_data = Some(stats[0].clone()); // Pick first stat for now
                                }
                            }
                        }

                        if !asset_file_name.is_empty() && stat_data.is_some() {
                            let component_id = Uuid::new_v4().to_string();
                            let pos = args.position.unwrap_or([0.0, 0.0, 0.0]);
                            let rot = args.rotation.unwrap_or([0.0, 0.0, 0.0]);
                            let scale = args.scale.unwrap_or([1.0, 1.0, 1.0]);

                            let model_position = Translation3::new(pos[0], pos[1], pos[2]);
                            let model_rotation = UnitQuaternion::from_euler_angles(
                                rot[0].to_radians(), rot[1].to_radians(), rot[2].to_radians()
                            );
                            let model_iso = Isometry3::from_parts(model_position, model_rotation);
                            let model_scale = Vector3::new(scale[0], scale[1], scale[2]);

                            let collectable_type = match args.r#type.as_str() {
                                "MeleeWeapon" => CollectableType::MeleeWeapon,
                                "RangedWeapon" => CollectableType::RangedWeapon,
                                "Armor" => CollectableType::Armor,
                                _ => CollectableType::Item,
                            };

                            let related_stat = stat_data.unwrap(); // Verified safe above

                            let collectable_properties = CollectableProperties {
                                model_id: Some(component_id.clone()), // Use same ID for model part
                                collectable_type: Some(collectable_type.clone()),
                                stat_id: Some(related_stat.id.clone()),
                            };

                            let renderer_state = editor.renderer_state.as_mut().unwrap();
                            let gpu_resources = editor.gpu_resources.as_ref().unwrap();
                            let camera = editor.camera.as_ref().unwrap();

                            pollster::block_on(handle_add_collectable(
                                renderer_state,
                                &gpu_resources.device,
                                &gpu_resources.queue,
                                project_id.clone(),
                                args.asset_id.clone(),
                                component_id.clone(),
                                asset_file_name,
                                model_iso,
                                model_scale,
                                camera,
                                &collectable_properties,
                                &related_stat,
                                false, // Don't hide
                                None // Script state
                            ));

                            // Update SavedState
                            if let Some(saved_state) = editor.saved_state.as_mut() {
                                if let Some(level) = saved_state.levels.as_mut().and_then(|l| l.get_mut(0)) {
                                    let new_component = ComponentData {
                                        id: component_id,
                                        kind: Some(ComponentKind::Collectable),
                                        asset_id: args.asset_id,
                                        generic_properties: GenericProperties {
                                            name: "New Collectable".to_string(),
                                            position: pos,
                                            rotation: rot,
                                            scale: scale,
                                        },
                                        collectable_properties: Some(collectable_properties),
                                        ..Default::default()
                                    };
                                    
                                    if let Some(components) = level.components.as_mut() {
                                        components.push(new_component);
                                    } else {
                                        level.components = Some(vec![new_component]);
                                    }
                                }
                                saved_state_clone = Some(saved_state.clone());
                            }
                        } else {
                            println!("Asset or Stats not found for collectable. AssetId: {}", args.asset_id);
                        }
                    }
            //     }
            // }
        }
    } else if tool_call.function.name == "configureGrass" {
        println!("Configuring grass...");
        let args: Result<ConfigureGrassArgs, _> = serde_json::from_str(&tool_call.function.arguments);
        if let Ok(args) = args {
            //  if let Some(pipeline_arc_val) = pipeline_store.get() {
            //     if let Some(pipeline_arc) = pipeline_arc_val.as_ref() {
            //         let mut pipeline = pipeline_arc.borrow_mut();
            //         if let Some(editor) = pipeline.export_editor.as_mut() {
            if let Some(editor) = &mut self.context.export_editor {
let Editor { saved_state, renderer_state, .. } = editor;
                        
                        // Update RendererState (Live)
                        if let Some(renderer_state) = editor.renderer_state.as_mut() {
                             for grass in renderer_state.grasses.iter_mut() {
                                 if let Some(val) = args.wind_strength { grass.config.wind_strength = val; }
                                 if let Some(val) = args.wind_speed { grass.config.wind_speed = val; }
                                 if let Some(val) = args.blade_height { grass.config.blade_height = val; }
                                 if let Some(val) = args.blade_width { grass.config.blade_width = val; }
                                 if let Some(val) = args.blade_density { grass.config.blade_density = val; }
                                 if let Some(val) = args.render_distance { grass.config.render_distance = val; }
                             }
                        }

                        // Update SavedState
                        if let Some(saved_state) = editor.saved_state.as_mut() {
                            if let Some(level) = saved_state.levels.as_mut().and_then(|l| l.get_mut(0)) {
                                if let Some(components) = level.components.as_mut() {
                                    // Find existing grass
                                    let mut found = false;
                                    for component in components.iter_mut() {
                                        if component.kind == Some(saved_data::ComponentKind::ProceduralGrass) {
                                            if let Some(target_id) = &args.component_id {
                                                if &component.id != target_id {
                                                    continue;
                                                }
                                            }
                                            
                                            if component.procedural_grass_properties.is_none() {
                                                component.procedural_grass_properties = Some(saved_data::ProceduralGrassProperties::default());
                                            }
                                            if let Some(props) = component.procedural_grass_properties.as_mut() {
                                                if let Some(val) = args.wind_strength { props.wind_strength = val; }
                                                if let Some(val) = args.wind_speed { props.wind_speed = val; }
                                                if let Some(val) = args.blade_height { props.blade_height = val; }
                                                if let Some(val) = args.blade_width { props.blade_width = val; }
                                                if let Some(val) = args.blade_density { props.blade_density = val as u32; }
                                                if let Some(val) = args.render_distance { props.render_distance = val; }
                                            }
                                            found = true;
                                        }
                                    }
                                    
                                    if !found && args.component_id.is_none() {
                                        let new_grass_props = saved_data::ProceduralGrassProperties {
                                            wind_strength: args.wind_strength.unwrap_or(2.5),
                                            wind_speed: args.wind_speed.unwrap_or(0.3),
                                            blade_height: args.blade_height.unwrap_or(2.75),
                                            blade_width: args.blade_width.unwrap_or(0.03),
                                            blade_density: args.blade_density.unwrap_or(15.0) as u32,
                                            render_distance: args.render_distance.unwrap_or(150.0),
                                            grid_size: 10.0,
                                            brownian_strength: 0.5,
                                        };
                                        
                                        let new_component = ComponentData {
                                            id: Uuid::new_v4().to_string(),
                                            kind: Some(saved_data::ComponentKind::ProceduralGrass),
                                            asset_id: "".to_string(),
                                            procedural_grass_properties: Some(new_grass_props),
                                            ..Default::default()
                                        };
                                        components.push(new_component);
                                        println!("Created new grass component in saved state.");
                                    }
                                }
                            }
                            saved_state_clone = Some(saved_state.clone());
                        }
                    }
            //     }
            // }
        }
    } else if tool_call.function.name == "spawnPrimitive" {
        println!("Spawning primitive...");
        let args: Result<SpawnPrimitiveArgs, _> = serde_json::from_str(&tool_call.function.arguments);
        if let Ok(args) = args {
            // if let Some(pipeline_arc_val) = pipeline_store.get() {
            //     if let Some(pipeline_arc) = pipeline_arc_val.as_ref() {
            //         let mut pipeline = pipeline_arc.borrow_mut();
            //         if let Some(editor) = pipeline.export_editor.as_mut() {
            if let Some(editor) = &mut self.context.export_editor {
let Editor { saved_state, renderer_state, .. } = editor;
                        let device = &editor.gpu_resources.as_ref().unwrap().device;
                        let queue = &editor.gpu_resources.as_ref().unwrap().queue;
                        let model_layout = editor.model_bind_group_layout.as_ref().unwrap();
                        let group_layout = editor.group_bind_group_layout.as_ref().unwrap();
                        let camera = editor.camera.as_ref().unwrap();

                        // We need access to texture render mode buffer which is in RendererState or Pipeline
                        // But access via RendererState is hard because we are borrowing pipeline/editor.
                        // However, Cube::new needs it.
                        // In pipeline.rs, `texture_render_mode_buffer` is passed to `RendererState`.
                        // But `editor.renderer_state` has it.
                        // `renderer_state.texture_render_mode_buffer`
                        
                        

                        if let Some(renderer_state) = editor.renderer_state.as_mut() {
                            let buffer = renderer_state.texture_render_mode_buffer.clone();

                            match args.r#type.as_str() {
                                "Cube" => {
                                    let mut cube = Cube::new(
                                        device,
                                        queue,
                                        model_layout,
                                        group_layout,
                                        &buffer,
                                        camera
                                    );
                                    cube.transform.update_position(args.position);
                                    if let Some(scale) = args.scale {
                                        cube.transform.update_scale(scale);
                                    }
                                    renderer_state.cubes.push(cube);
                                },
                                "Sphere" => {
                                    let mut sphere = Sphere::new(
                                        device,
                                        queue,
                                        model_layout,
                                        group_layout,
                                        &buffer,
                                        camera,
                                        1.0, // radius
                                        32, // sectors
                                        32, // stacks
                                        [1.0, 1.0, 1.0], // color
                                        false // debug_moving
                                    );
                                    sphere.transform.update_position(args.position);
                                    if let Some(scale) = args.scale {
                                        sphere.transform.update_scale(scale);
                                    }
                                    renderer_state.spheres.push(sphere);
                                },
                                _ => println!("Unknown primitive type"),
                            }
                            
                            if let Some(saved_state) = editor.saved_state.as_mut() {
                                saved_state_clone = Some(saved_state.clone());
                            }
                        }
                    }
            //     }
            // }
        }
    } else if tool_call.function.name == "spawnNPC" {
        println!("Spawning NPC...");
        let args: Result<SpawnNPCArgs, _> = serde_json::from_str(&tool_call.function.arguments);
        if let Ok(args) = args {
            // if let Some(pipeline_arc_val) = pipeline_store.get() {
            //     if let Some(pipeline_arc) = pipeline_arc_val.as_ref() {
            //         let mut pipeline = pipeline_arc.borrow_mut();
            //         if let Some(editor) = pipeline.export_editor.as_mut() {
            if let Some(editor) = &mut self.context.export_editor {
let Editor { saved_state, renderer_state, .. } = editor;
                        let project_id = project_id.as_ref().expect("Couldn't get project id");
                         let mut asset_file_name = String::new();

                        // Find asset in SavedState
                        if let Some(saved_state) = editor.saved_state.as_ref() {
                            if let Some(model) = saved_state.models.iter().find(|m| m.id == args.asset_id) {
                                asset_file_name = model.fileName.clone();
                            }
                        }

                        if !asset_file_name.is_empty() {
                            let component_id = Uuid::new_v4().to_string();
                            let pos = args.position.unwrap_or([0.0, 0.0, 0.0]);
                            let rot = args.rotation.unwrap_or([0.0, 0.0, 0.0]);
                            let scale = args.scale.unwrap_or([1.0, 1.0, 1.0]);

                            let model_position = Translation3::new(pos[0], pos[1], pos[2]);
                            let model_rotation = UnitQuaternion::from_euler_angles(
                                rot[0].to_radians(), rot[1].to_radians(), rot[2].to_radians()
                            );
                            let model_iso = Isometry3::from_parts(model_position, model_rotation);
                            let model_scale = Vector3::new(scale[0], scale[1], scale[2]);

                            let combat_type = match args.combat_type.as_deref() {
                                Some("Ranged") => CombatType::Ranged,
                                _ => CombatType::Melee,
                            };

                            let damage = args.damage.unwrap_or(10.0);
                            let attack_stats = Some(AttackStats {
                                damage: damage,
                                range: if combat_type == CombatType::Melee { 2.0 } else { 15.0 },
                                cooldown: 1.5,
                                wind_up_time: 0.5,
                                recovery_time: 0.5,
                            });

                            let behavior_config = BehaviorConfig {
                                aggressiveness: args.aggressiveness.unwrap_or(0.5),
                                combat_type: combat_type,
                                wander_radius: args.wander_radius.unwrap_or(10.0),
                                wander_speed: args.wander_speed.unwrap_or(2.0),
                                detection_radius: args.detection_radius.unwrap_or(15.0),
                                melee_stats: if combat_type == CombatType::Melee { attack_stats } else { None },
                                ranged_stats: if combat_type == CombatType::Ranged { attack_stats } else { None },
                            };

                            let renderer_state = editor.renderer_state.as_mut().unwrap();
                            let gpu_resources = editor.gpu_resources.as_ref().unwrap();
                            let camera = editor.camera.as_ref().unwrap();

                            pollster::block_on(handle_add_npc(
                                renderer_state,
                                &gpu_resources.device,
                                &gpu_resources.queue,
                                project_id.clone(),
                                args.asset_id.clone(),
                                component_id.clone(),
                                asset_file_name,
                                model_iso,
                                model_scale,
                                camera,
                                None, // Script state
                                behavior_config.clone()
                            ));

                            // Update SavedState
                            if let Some(saved_state) = editor.saved_state.as_mut() {
                                if let Some(level) = saved_state.levels.as_mut().and_then(|l| l.get_mut(0)) {
                                    let new_component = ComponentData {
                                        id: component_id,
                                        kind: Some(ComponentKind::NPC),
                                        asset_id: args.asset_id.clone(),
                                        generic_properties: GenericProperties {
                                            name: "New NPC".to_string(),
                                            position: pos,
                                            rotation: rot,
                                            scale: scale,
                                        },
                                        npc_properties: Some(NPCProperties {
                                            model_id: args.asset_id,
                                            behavior: behavior_config,
                                        }),
                                        ..Default::default()
                                    };
                                    
                                    if let Some(components) = level.components.as_mut() {
                                        components.push(new_component);
                                    } else {
                                        level.components = Some(vec![new_component]);
                                    }
                                }
                                saved_state_clone = Some(saved_state.clone());
                            }
                        } else {
                            println!("Asset not found for NPC: {}", args.asset_id);
                        }
                    }
            //     }
            // }
        }
    } else if tool_call.function.name == "saveScript" {
        println!("Saving script...");
        let args: Result<SaveScriptArgs, _> = serde_json::from_str(&tool_call.function.arguments);
        if let Ok(args) = args {
            // Update the component script path if provided
            if let Some(component_id) = &args.componentId {
                // if let Some(pipeline_arc_val) = pipeline_store.get() {
                //     if let Some(pipeline_arc) = pipeline_arc_val.as_ref() {
                //         let mut pipeline = pipeline_arc.borrow_mut();
                //         if let Some(editor) = pipeline.export_editor.as_mut() {
                if let Some(editor) = &mut self.context.export_editor {
let Editor { saved_state, renderer_state, .. } = editor;
                            // Update SavedState
                            if let Some(saved_state) = editor.saved_state.as_mut() {
                                if let Some(level) = saved_state.levels.as_mut().and_then(|l| l.get_mut(0)) {
                                    if let Some(components) = level.components.as_mut() {
                                        if let Some(component) = components.iter_mut().find(|c| c.id == *component_id) {
                                            let script_path = format!("scripts/{}", args.filename);
                                            component.rhai_script_path = Some(script_path);
                                        }
                                    }
                                }
                                saved_state_clone = Some(saved_state.clone());
                            }
                    //     }
                    // }
                }
            }
            
             // We need the project path. It's in `selected_project`.
            // let project_path = selected_project.get_untracked().map(|p| p.path).unwrap_or_default();
            
            // if !project_path.is_empty() {
            //     let url = format!("{}/api/save-script", get_api_url());
            //     let body = serde_json::json!({
            //         "projectPath": project_path,
            //         "filename": args.filename,
            //         "content": args.content
            //     });
                
            //     spawn_local(async move {
            //         let _ = Request::post(&url)
            //             .json(&body)
            //             .expect("Couldn't make post body")
            //             .send()
            //             .await;
            //     });
            // }
        }
    } else if tool_call.function.name == "generateHeightmap" {
        println!("Generating heightmap...");
        let args: Result<GenerateHeightmapArgs, _> = serde_json::from_str(&tool_call.function.arguments);
        if let Ok(args) = args {
            // if let Some(pipeline_arc_val) = pipeline_store.get() {
            //     if let Some(pipeline_arc) = pipeline_arc_val.as_ref() {
            //         let mut pipeline = pipeline_arc.borrow_mut();
            //         if let Some(editor) = pipeline.export_editor.as_mut() {
            if let Some(editor) = &mut self.context.export_editor {
let Editor { saved_state, renderer_state, .. } = editor;
                        // 1. Find existing landscape info
                        let mut existing_info = None;
                        
                        if let Some(target_id) = &args.component_id {
                             if let Some(saved_state) = editor.saved_state.as_ref() {
                                if let Some(levels) = saved_state.levels.as_ref() {
                                    if let Some(components) = levels.get(0).and_then(|l| l.components.as_ref()) {
                                        if let Some(component) = components.iter().find(|c| c.id == *target_id) {
                                             let position = component.generic_properties.position;
                                             let asset_id = component.asset_id.clone();
                                             
                                             if let Some(landscapes) = saved_state.landscapes.as_ref() {
                                                if let Some(landscape_data) = landscapes.iter().find(|l| l.id == asset_id) {
                                                    if let Some(heightmap_file) = &landscape_data.heightmap {
                                                        existing_info = Some((position, asset_id, heightmap_file.fileName.clone()));
                                                    }
                                                }
                                             }
                                        }
                                    }
                                }
                             }
                        } else {
                             // Try to find first existing landscape if no ID specified
                             if let Some(saved_state) = editor.saved_state.as_ref() {
                                if let Some(levels) = saved_state.levels.as_ref() {
                                    if let Some(components) = levels.get(0).and_then(|l| l.components.as_ref()) {
                                        if let Some(component) = components.iter().find(|c| c.kind == Some(saved_data::ComponentKind::Landscape)) {
                                            let position = component.generic_properties.position;
                                            let asset_id = component.asset_id.clone();
                                            if let Some(landscapes) = saved_state.landscapes.as_ref() {
                                                if let Some(landscape_data) = landscapes.iter().find(|l| l.id == asset_id) {
                                                    if let Some(heightmap_file) = &landscape_data.heightmap {
                                                        existing_info = Some((position, asset_id, heightmap_file.fileName.clone()));
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        let (position, asset_id, filename) = if let Some(info) = existing_info {
                            info
                        } else {
                            println!("Creating new landscape info.");
                            let new_asset_id = Uuid::new_v4().to_string();
                            ([0.0, 0.0, 0.0], new_asset_id, format!("heightmap_{}.png", Uuid::new_v4()))
                        };

                        let width = 1024;
                        let height = 1024;
                        let mut generator = HeightmapGenerator::new(width, height)
                                                                    .with_scale(1024.0)
                                                                    .with_octaves(8)
                                                                    .with_persistence(0.5)
                                                                    .with_seed(42);
                        
                        if let Some(seed) = args.seed { generator = generator.with_seed(seed); }
                        if let Some(scale) = args.scale { generator = generator.with_scale(scale); }
                        if let Some(persistence) = args.persistence { generator = generator.with_persistence(persistence); }
                        if let Some(lacunarity) = args.lacunarity { generator = generator.with_lacunarity(lacunarity); }

                        if let Some(features) = args.features {
                            for f in features {
                                let f_type = match f.r#type.as_str() {
                                    "Mountain" => FeatureType::Mountain,
                                    "Valley" => FeatureType::Valley,
                                    "Plateau" => FeatureType::Plateau,
                                    "Ridge" => FeatureType::Ridge,
                                    _ => FeatureType::Mountain,
                                };
                                let falloff = match f.falloff.as_str() {
                                    "Linear" => FalloffType::Linear,
                                    "Smooth" => FalloffType::Smooth,
                                    "Gaussian" => FalloffType::Gaussian,
                                    _ => FalloffType::Smooth,
                                };
                                let mut feature = TerrainFeature::new(
                                    (f.center[0], f.center[1]),
                                    f.radius,
                                    f.intensity,
                                    falloff,
                                    f_type
                                );
                                if let Some(ft) = f.flat_top { feature = feature.with_flat_top(ft); }
                                if let Some(t) = f.transition { feature = feature.with_transition(t); }
                                generator.add_feature(feature);
                            }
                        }

                        let img = generator.generate();
                        
                        // Convert to PNG bytes
                        let mut png_bytes: Vec<u8> = Vec::new();
                        let _ = image::ImageBuffer::from_raw(width, height, img.clone().into_raw())
                            .map(|buf: image::ImageBuffer<image::Luma<u16>, Vec<u16>>| {
                                let dyn_img = image::DynamicImage::ImageLuma16(buf);
                                let _ = dyn_img.write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png);
                            });

                        // Upload to API
                        // We need the project path. It's in `selected_project`.
                        let project_id = project_id.as_ref().expect("Couldn't get project id");
                        
                        // if !png_bytes.is_empty() && !project_path.is_empty() {
                        //     let file_part = FormData::new().expect("FormData error");
                        //     // file_part.append("projectPath", &project_path);
                            
                        //     // Manually constructing body or using a way to send FormData compatible with the server
                        //     // Gloo-net Request supports body.
                            
                        //     // Let's use web_sys for FormData as it's cleaner in browser context
                        //     let form_data = web_sys::FormData::new().unwrap();
                        //     form_data.append_with_str("projectPath", &project_path).unwrap();
                        //     form_data.append_with_str("landscapeAssetId", &asset_id).unwrap();
                        //     form_data.append_with_str("filename", &filename).unwrap();
                            
                        //     let uint8_array = js_sys::Uint8Array::from(&png_bytes[..]);
                        //     let blob_parts = js_sys::Array::new();
                        //     blob_parts.push(&uint8_array);
                        //     let blob = web_sys::Blob::new_with_u8_array_sequence(&blob_parts).unwrap();
                        //     form_data.append_with_blob("file", &blob).unwrap();

                        //     let url = format!("{}/api/save-heightmap", get_api_url());
                        //     spawn_local(async move {
                        //         let _ = Request::post(&url)
                        //             .body(form_data)
                        //             .expect("Couldn't make post body")
                        //             .send()
                        //             .await;
                        //     });
                        // }

                        // Save the heightmap
                        match save_heightmap(project_id, &asset_id, &filename, png_bytes) {
                            Ok(path) => println!("Heightmap saved to: {:?}", path),
                            Err(e) => eprintln!("Failed to save heightmap: {}", e),
                        }

                        // Update In-Memory
                        let height_data: Vec<f32> = img.pixels().map(|p| p.0[0] as f32 / 65535.0).collect();

                        let landscape_data = generate_landscape_data(
                            width as usize,
                            height as usize,
                            height_data,
                            1024.0 * 4.0, // size match existing default or reasonable size
                            1024.0 * 4.0,
                            150.0 * 4.0, // height scale
                        );

                        if let Some(renderer_state) = editor.renderer_state.as_mut() {
                            // Clear existing landscapes
                            renderer_state.landscapes.clear();
                            renderer_state.terrain_managers.clear();
                            
                            // Add new landscape with CORRECT position
                            let device = &editor.gpu_resources.as_ref().unwrap().device;
                            let queue = &editor.gpu_resources.as_ref().unwrap().queue;
                            let camera = editor.camera.as_ref().unwrap();
                            
                            renderer_state.add_landscape(
                                device,
                                queue,
                                &asset_id,
                                &landscape_data,
                                position, // Use the position from saved_state
                                camera
                            );
                            
                            println!("Heightmap generated and loaded!");
                            
                            if let Some(saved_state) = editor.saved_state.as_mut() {
                                saved_state_clone = Some(saved_state.clone());
                            }
                        }
                    }
            //     }
            // }
        }
    }
    
    }
}

impl<'a> TabViewer for PipelineTabViewer<'a> {
    type Tab = Tab;

    fn title(&mut self, tab: &mut Self::Tab) -> egui::WidgetText {
        format!("{:?}", tab).into()
    }

    fn ui(&mut self, ui: &mut egui::Ui, tab: &mut Self::Tab) {
        match tab {
            Tab::Projects => {
                let editor = self.context.export_editor.as_mut().unwrap();
                if editor.saved_state.is_none() {
                    ui.label("Create New Project");
                    ui.text_edit_singleline(self.context.new_project_name);
                    if ui.button("Create New Project").clicked() {
                        if !self.context.new_project_name.is_empty() {
                            match utilities::create_project_state(self.context.new_project_name) {
                                Ok(new_state) => {
                                    editor.saved_state = Some(new_state);
                                }
                                Err(e) => {
                                    println!("Failed to create project: {}", e);
                                }
                            }
                        }
                    }
        
                    ui.separator();
                    ui.label("Existing Projects");
        
                    if let Some(projects_dir) = utilities::get_projects_dir() {
                        self.context.projects.clear();
                        if let Ok(entries) = fs::read_dir(projects_dir) {
                            for entry in entries {
                                if let Ok(entry) = entry {
                                    let path = entry.path();
                                    if path.is_dir() {
                                        if let Some(name) = path.file_name() {
                                            if let Some(name_str) = name.to_str() {
                                                self.context.projects.push(name_str.to_string());
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
        
                    for project_id in self.context.projects.iter() {
                        if ui.button(project_id).clicked() {
                            pollster::block_on(load_project(editor, project_id));
                        }
                    }
                } else {
                    ui.label("Project Loaded");
                    if let Some(saved_state) = &editor.saved_state {
                         ui.label(format!("Project: {}", saved_state.id.as_deref().unwrap_or("Unknown")));
                    }
                }
            }
            Tab::Components => {
                let editor = self.context.export_editor.as_mut().unwrap();
                 if let Some(saved_state) = &mut editor.saved_state {
                    if let Some(levels) = &mut saved_state.levels {
                         // Workaround for levels cloning if needed, but here we can iterate
                         if !levels.is_empty() {
                             if let Some(components) = &mut levels[0].components {
                                for component in components {
                                    ui.horizontal(|ui| {
                                        ui.label(&component.generic_properties.name);
                                        if ui.button("Select").clicked() {
                                            *self.context.selected_component_id = Some(component.id.clone());
                                        }
                                    });
                                }
                             }
                         }
                    }
                 }
            }
            Tab::Properties => {
                 let editor = self.context.export_editor.as_mut().unwrap();
                 if let Some(selected_component_id) = self.context.selected_component_id {
                    // Use disjoint borrow pattern to access saved_state and renderer_state simultaneously
                    let Editor { saved_state, renderer_state, .. } = editor;

                    if let Some(saved_state) = saved_state {
                        let project_id = saved_state.id.as_ref().expect("Couldn't get project id").clone();
                        if let Some(levels) = &mut saved_state.levels {
                             if !levels.is_empty() {
                                if let Some(components) = &mut levels[0].components {
                                    // Find the index of the selected component to mutate it
                                    let mut target_component_index = None;
                                    for (i, c) in components.iter().enumerate() {
                                        if &c.id == selected_component_id {
                                            target_component_index = Some(i);
                                            break;
                                        }
                                    }

                                    // Need to calculate light index BEFORE mutating components (which requires mutable borrow)
                                    // But we can iterate components to find the index of our selected ID among lights.
                                    // We only need immutable access to iterate.
                                    let mut light_index = None;
                                    {
                                        let mut current_light_idx = 0;
                                        for c in components.iter() {
                                            if matches!(c.kind, Some(ComponentKind::PointLight)) {
                                                if &c.id == selected_component_id {
                                                    light_index = Some(current_light_idx);
                                                    break;
                                                }
                                                current_light_idx += 1;
                                            }
                                        }
                                    }

                                    if let Some(idx) = target_component_index {
                                        let component = &mut components[idx];
                                        
                                        match component.kind {
                                            Some(ComponentKind::Model) => {
                                                ui.label("Position");
                                                if ui.horizontal(|ui| {
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.position[0]).speed(0.1)).changed() ||
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.position[1]).speed(0.1)).changed() ||
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.position[2]).speed(0.1)).changed()
                                                }).inner {
                                                    if let Some(renderer_state) = renderer_state {
                                                        if let Some(model) = renderer_state.models.iter_mut().find(|m| &m.id == selected_component_id) {
                                                            for mesh in &mut model.meshes {
                                                                mesh.transform.update_position(component.generic_properties.position);
                                                            }
                                                        }
                                                    }
                                                    utilities::update_project_state_component(&project_id, component).expect("Failed to update project state");
                                                }
                                                
                                                ui.label("Rotation");
                                                if ui.horizontal(|ui| {
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.rotation[0]).speed(0.1)).changed() ||
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.rotation[1]).speed(0.1)).changed() ||
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.rotation[2]).speed(0.1)).changed()
                                                }).inner {
                                                     if let Some(renderer_state) = renderer_state {
                                                        if let Some(model) = renderer_state.models.iter_mut().find(|m| &m.id == selected_component_id) {
                                                            for mesh in &mut model.meshes {
                                                                mesh.transform.update_rotation([component.generic_properties.rotation[0].to_radians(), component.generic_properties.rotation[1].to_radians(), component.generic_properties.rotation[2].to_radians()]);
                                                            }
                                                        }
                                                    }
                                                    utilities::update_project_state_component(&project_id, component).expect("Failed to update project state");
                                                }
                                            }
                                            Some(ComponentKind::PointLight) => {
                                                ui.label("Position");
                                                if ui.horizontal(|ui| {
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.position[0]).speed(0.1)).changed() ||
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.position[1]).speed(0.1)).changed() ||
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.position[2]).speed(0.1)).changed()
                                                }).inner {
                                                     if let Some(light_idx) = light_index {
                                                         if let Some(renderer_state) = renderer_state {
                                                             if let Some(light) = renderer_state.point_lights.get_mut(light_idx) {
                                                                 light.position = component.generic_properties.position;
                                                             }
                                                         }
                                                     }
                                                     utilities::update_project_state_component(&project_id, component).expect("Failed to update project state");
                                                }

                                                if let Some(light_props) = &mut component.light_properties {
                                                    ui.label("Intensity");
                                                    if ui.add(egui::DragValue::new(&mut light_props.intensity).speed(0.1)).changed() {
                                                        if let Some(light_idx) = light_index {
                                                            if let Some(renderer_state) = renderer_state {
                                                                if let Some(light) = renderer_state.point_lights.get_mut(light_idx) {
                                                                    light.intensity = light_props.intensity;
                                                                }
                                                            }
                                                        }
                                                        utilities::update_project_state_component(&project_id, component).expect("Failed to update project state");
                                                    }
                                                }
                                                
                                                if let Some(light_props) = &mut component.light_properties {
                                                    ui.label("Max Distance (Radius)");
                                                    if ui.add(egui::DragValue::new(&mut light_props.max_distance).speed(0.1)).changed() {
                                                        if let Some(light_idx) = light_index {
                                                            if let Some(renderer_state) = renderer_state {
                                                                if let Some(light) = renderer_state.point_lights.get_mut(light_idx) {
                                                                    light.max_distance = light_props.max_distance;
                                                                }
                                                            }
                                                        }
                                                        utilities::update_project_state_component(&project_id, component).expect("Failed to update project state");
                                                    }
                                                }
                                                
                                                if let Some(light_props) = &mut component.light_properties {
                                                    ui.label("Color");
                                                    if ui.color_edit_button_rgba_premultiplied(&mut light_props.color).changed() {
                                                        if let Some(light_idx) = light_index {
                                                            if let Some(renderer_state) = renderer_state {
                                                                if let Some(light) = renderer_state.point_lights.get_mut(light_idx) {
                                                                    light.color = [light_props.color[0], light_props.color[1], light_props.color[2]];
                                                                }
                                                            }
                                                        }
                                                        utilities::update_project_state_component(&project_id, component).expect("Failed to update project state");
                                                    }
                                                }
                                            }
                                            _ => {
                                                ui.label("This component type is not editable.");
                                            }
                                        }
                                    }
                                }
                             }
                        }
                    }
                 }
            }
            Tab::Chat => {
                 if self.context.chat.current_session.is_none() {
                    if ui.button("Start New Session").clicked() {
                         let editor = self.context.export_editor.as_ref().unwrap();
                         if let Some(saved_data) = &editor.saved_state {
                             let project_id = saved_data.id.as_ref().expect("Couldn't get id").clone();
                             let client = self.context.chat.client.clone();
                             let api_url = self.context.chat.api_url.clone();
                             
                             let (tx, rx) = std::sync::mpsc::channel();
                             std::thread::spawn(move || {
                                let rt = tokio::runtime::Runtime::new().unwrap();
                                rt.block_on(async {
                                    let url = format!("{}/api/sessions", api_url);
                                    let body = serde_json::json!({ "projectId": project_id });
                                    let res = client.post(&url).json(&body).send().await;
                                    if let Ok(resp) = res {
                                        if let Ok(session) = resp.json::<ChatSession>().await {
                                            let _ = tx.send(session);
                                        }
                                    }
                                });
                             });
                             if let Ok(session) = rx.recv() {
                                 self.context.chat.current_session = Some(session);
                            }
                         }
                    }
                 } else {
                     if let Some(session) = &self.context.chat.current_session {
                         ui.label(format!("Session: {}", session.id));
                     }
                     egui::ScrollArea::vertical().show(ui, |ui| {
                         for msg in &self.context.chat.messages {
                             ui.label(format!("{}: {}", msg.role, msg.content.as_deref().unwrap_or("...")));
                             if let Some(tool_calls) = &msg.tool_calls {
                                for tool_call in tool_calls {
                                    ui.label(format!("Tool | {}: {}", tool_call.function.name, tool_call.function.arguments));
                                }
                             }
                         }
                     });
                     ui.separator();
                     ui.horizontal(|ui| {
                         ui.text_edit_singleline(&mut self.context.chat.current_input);
                         if ui.button("Send").clicked() {
                              let content = self.context.chat.current_input.clone();
                              self.context.chat.current_input.clear();
                              
                              let session_id = self.context.chat.current_session.as_ref().unwrap().id.clone();
                              let client = self.context.chat.client.clone();
                              let api_url = self.context.chat.api_url.clone();

                              // Get saved state for context
                              let editor = self.context.export_editor.as_ref().unwrap();
                              let saved_state = editor.saved_state.as_ref().expect("Couldn't get saved state").clone();
                              let project_id = saved_state.id.as_ref().expect("Couldn't get id").clone();
                              
                              self.context.chat.messages.push(ChatMessage {
                                 id: Uuid::new_v4().to_string(),
                                 role: "user".to_string(),
                                 content: Some(content.clone()),
                                 tool_call_id: None,
                                 tool_calls: None,
                             });
                             
                             let (tx, rx) = std::sync::mpsc::channel();
                             
                             // Clone for thread
                             let saved_state_cl = saved_state.clone();

                             std::thread::spawn(move || {
                                let rt = tokio::runtime::Runtime::new().unwrap();
                                rt.block_on(async {
                                    let url = format!("{}/api/sessions/{}/messages", api_url, session_id);
                                    let body = serde_json::json!({
                                        "role": "user",
                                        "content": content,
                                        "saved_state": saved_state_cl
                                    });
                                    let res = client.post(&url).json(&body).send().await;
                                    if let Ok(resp) = res {
                                        if let Ok(msg) = resp.json::<ChatMessage>().await {
                                            let _ = tx.send(msg);
                                        }
                                    }
                                });
                             });
                             
                             if let Ok(msg) = rx.recv() {
                                 use crate::helpers::utilities::update_project_state;
                                 self.context.chat.messages.push(msg.clone());
                                 
                                 if let Some(tool_calls) = msg.tool_calls {
                                     for tool_call in tool_calls {
                                         self.execute_tool_call(tool_call);
                                     }
                                 }

                                 let _ = update_project_state(&project_id, &saved_state).as_ref().expect("Couldn't save");
                             }
                         }
                     });
                 }
            }
            _ => {
                ui.label("Not implemented");
            }
        }
    }
}
