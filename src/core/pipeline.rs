use crate::core::skinned_pipeline::SkinnedPipeline;
use crate::core::chat::{Chat, ChatMessage, ChatSession, ToolCall};
use crate::game_behaviors::stateful::{BehaviorConfig, CombatType};
use crate::handlers::{handle_add_collectable, handle_add_npc, handle_add_water_plane};
use crate::helpers::landscapes::generate_landscape_data;
use crate::helpers::saved_data::{self, AttackStats, CollectableProperties, CollectableType, LightProperties, NPCProperties};
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
        
        // if tool_call.function.name == "transformObject" {
        //     #[derive(Deserialize)]
        //     struct TransformObjectArgs {
        //         component_id: String,
        //         translation: Option<[f32; 3]>,
        //         rotation: Option<[f32; 3]>,
        //         scale: Option<[f32; 3]>,
        //     }
            
        //     if let Ok(args) = serde_json::from_str::<TransformObjectArgs>(&tool_call.function.arguments) {
        //          if let Some(editor) = &mut self.context.export_editor {
        //             // Update RendererState
        //             let Editor { saved_state, renderer_state, .. } = editor;

        //             if let Some(renderer_state) = renderer_state {
        //                 if let Some(model) = renderer_state.models.iter_mut().find(|m| m.id == args.component_id) {
        //                     for mesh in &mut model.meshes {
        //                         if let Some(t) = args.translation { mesh.transform.update_position(t); }
        //                         if let Some(r) = args.rotation { 
        //                             mesh.transform.update_rotation([r[0].to_radians(), r[1].to_radians(), r[2].to_radians()]); 
        //                         }
        //                         if let Some(s) = args.scale { mesh.transform.update_scale(s); }
        //                     }
        //                 }
        //             }
                    
        //             // Update SavedState
        //             if let Some(saved_state) = saved_state {
        //                 if let Some(level) = saved_state.levels.as_mut().and_then(|l| l.get_mut(0)) {
        //                     if let Some(components) = &mut level.components {
        //                         if let Some(component) = components.iter_mut().find(|c| c.id == args.component_id) {
        //                             if let Some(t) = args.translation { component.generic_properties.position = t; }
        //                             if let Some(r) = args.rotation { component.generic_properties.rotation = r; }
        //                             if let Some(s) = args.scale { component.generic_properties.scale = s; }
        //                         }
        //                     }
        //                 }
        //             }
        //          }
        //     }
        // }
        
        // if tool_call.function.name == "spawnModel" {
        //     #[derive(Deserialize)]
        //     struct SpawnModelArgs {
        //         #[serde(rename = "assetId")]
        //         asset_id: String,
        //         position: Option<[f32; 3]>,
        //         rotation: Option<[f32; 3]>,
        //         scale: Option<[f32; 3]>,
        //     }

        //     if let Ok(args) = serde_json::from_str::<SpawnModelArgs>(&tool_call.function.arguments) {
        //          if let Some(editor) = &mut self.context.export_editor {
        //              // Need disjoint borrow again? 
        //              // We need to read saved_state to find filename, then call async handle_add_model which needs renderer_state
                     
        //              let mut asset_file_name = String::new();
        //              let mut project_id = String::new();
                     
        //              if let Some(saved_state) = &editor.saved_state {
        //                 project_id = saved_state.id.as_ref().expect("Couldn't get id").clone();
        //                 if let Some(model) = saved_state.models.iter().find(|m| m.id == args.asset_id) {
        //                     asset_file_name = model.fileName.clone();
        //                 }
        //              }
                     
        //              if !asset_file_name.is_empty() {
        //                  let component_id = Uuid::new_v4().to_string();
        //                  let pos = args.position.unwrap_or([0.0, 0.0, 0.0]);
        //                  let rot = args.rotation.unwrap_or([0.0, 0.0, 0.0]);
        //                  let scale = args.scale.unwrap_or([1.0, 1.0, 1.0]);
                         
        //                  let model_position = Translation3::new(pos[0], pos[1], pos[2]);
        //                  let model_rotation = UnitQuaternion::from_euler_angles(
        //                      rot[0].to_radians(), rot[1].to_radians(), rot[2].to_radians()
        //                  );
        //                  let model_iso = Isometry3::from_parts(model_position, model_rotation);
        //                  let model_scale = Vector3::new(scale[0], scale[1], scale[2]);
                         
        //                  if let Some(renderer_state) = &mut editor.renderer_state {
        //                      if let Some(gpu_resources) = self.context.gpu_resources {
                                 
        //                          pollster::block_on(handle_add_model(
        //                              renderer_state,
        //                              &gpu_resources.device,
        //                              &gpu_resources.queue,
        //                              project_id,
        //                              args.asset_id.clone(),
        //                              component_id.clone(),
        //                              asset_file_name,
        //                              model_iso,
        //                              model_scale,
        //                              editor.camera.as_ref().unwrap(),
        //                              None
        //                          ));
        //                      }
        //                  }
                         
        //                 if let Some(saved_state) = &mut editor.saved_state {
        //                     if let Some(level) = saved_state.levels.as_mut().and_then(|l| l.get_mut(0)) {
        //                         let new_component = ComponentData {
        //                             id: component_id,
        //                             kind: Some(ComponentKind::Model),
        //                             asset_id: args.asset_id,
        //                             generic_properties: GenericProperties {
        //                                 name: "New Model".to_string(),
        //                                 position: pos,
        //                                 rotation: rot,
        //                                 scale: scale,
        //                             },
        //                             ..Default::default()
        //                         };
                                
        //                         if let Some(components) = &mut level.components {
        //                             components.push(new_component);
        //                         } else {
        //                             level.components = Some(vec![new_component]);
        //                         }
        //                     }
        //                 }
        //              }
        //          }
        //     }
        // }
        
        // if tool_call.function.name == "spawnPointLight" {
        //     #[derive(Deserialize)]
        //     struct SpawnPointLightArgs {
        //         position: [f32; 3],
        //         color: Option<[f32; 3]>,
        //         intensity: Option<f32>,
        //         radius: Option<f32>,
        //     }
            
        //     if let Ok(args) = serde_json::from_str::<SpawnPointLightArgs>(&tool_call.function.arguments) {
        //          if let Some(editor) = &mut self.context.export_editor {
        //              let component_id = Uuid::new_v4().to_string();
        //              let color = args.color.unwrap_or([1.0, 1.0, 1.0]);
        //              let intensity = args.intensity.unwrap_or(1.0);
        //              let radius = args.radius.unwrap_or(200.0);
                     
        //              // Update RendererState
        //              if let Some(renderer_state) = &mut editor.renderer_state {
        //                  renderer_state.point_lights.push(PointLight {
        //                      position: args.position,
        //                      _padding1: 0,
        //                      color: color,
        //                      _padding2: 0,
        //                      intensity: intensity,
        //                      max_distance: radius,
        //                      _padding3: [0; 2]
        //                  });
        //              }
                     
        //              // Update SavedState
        //              if let Some(saved_state) = &mut editor.saved_state {
        //                  if let Some(level) = saved_state.levels.as_mut().and_then(|l| l.get_mut(0)) {
        //                      use crate::helpers::saved_data::LightProperties;
                             
        //                      let new_component = ComponentData {
        //                          id: component_id,
        //                          kind: Some(ComponentKind::PointLight),
        //                          asset_id: "".to_string(),
        //                          generic_properties: GenericProperties {
        //                              name: "New Light".to_string(),
        //                              position: args.position,
        //                              ..Default::default()
        //                          },
        //                          light_properties: Some(LightProperties {
        //                              color: [color[0], color[1], color[2], 1.0],
        //                              intensity: intensity,
        //                              max_distance: radius,
        //                          }),
        //                          ..Default::default()
        //                      };
                             
        //                      if let Some(components) = &mut level.components {
        //                          components.push(new_component);
        //                      } else {
        //                          level.components = Some(vec![new_component]);
        //                      }
        //                  }
        //              }
        //          }
        //     }
        // }
    
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

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

use crate::shape_primitives::Cube::Cube;
use crate::shape_primitives::Sphere::Sphere;
use crate::helpers::load_project::load_project;
use crate::rhai_engine::{ComponentChanges, RhaiEngine};
use crate::game_ui::dialogue_ui;
use crate::game_ui::quest_ui;
use crate::procedural_particles::particle_system::{ParticleSystem, ParticleUniforms};

// use super::chat::Chat;

// Procedural Sky Uniform struct (Rust mirror of WGSL)
#[repr(C)]
#[derive(Debug, Copy, Clone, Pod, Zeroable)]
pub struct ProceduralSkyUniform {
    horizon_color: [f32; 3],
    _padding0: f32, // Pad to 16 bytes for alignment
    zenith_color: [f32; 3],
    _padding1: f32,
    sun_direction: [f32; 3],
    _padding2: f32,
    sun_color: [f32; 3],
    _padding3: f32,
    sun_intensity: f32,
    _padding4: [f32; 3], // Pad to 16 bytes
}

impl Default for ProceduralSkyUniform {
    fn default() -> Self {
        Self {
            horizon_color: [0.7, 0.8, 1.0], // Light blue
            _padding0: 0.0,
            zenith_color: [0.2, 0.3, 0.6], // Darker blue
            _padding1: 0.0,
            sun_direction: [0.0, 1.0, 0.0], // Directly overhead
            _padding2: 0.0,
            sun_color: [1.0, 0.9, 0.7],    // Warm yellow
            _padding3: 0.0,
            sun_intensity: 5.0,
            _padding4: [0.0; 3],
        }
    }
}

pub struct ExportPipeline {
    // pub device: Option<wgpu::Device>,
    // pub queue: Option<wgpu::Queue>,
    pub gpu_resources: Option<Arc<GpuResources>>,
    pub camera: Option<Camera>,
    pub camera_binding: Option<CameraBinding>,
    pub geometry_pipeline: Option<RenderPipeline>,
    pub lighting_pipeline: Option<RenderPipeline>,
    pub procedural_sky_pipeline: Option<RenderPipeline>, // New field for procedural sky
    pub procedural_sky_bind_group: Option<wgpu::BindGroup>, // New field for procedural sky bind group
    pub procedural_sky_uniform_buffer: Option<wgpu::Buffer>, // New field for procedural sky uniform buffer
    pub debug_sphere_pipeline: Option<RenderPipeline>,
    pub texture: Option<Arc<wgpu::Texture>>,
    pub view: Option<Arc<wgpu::TextureView>>,
    pub depth_view: Option<wgpu::TextureView>,
    pub dock_state: DockState<Tab>,
    pub window_size_bind_group: Option<wgpu::BindGroup>,
    pub export_editor: Option<Editor>,
    pub frame_buffer: Option<FrameCaptureBuffer>,
    pub chat: Chat,
    new_project_name: String,
    projects: Vec<String>,

    start_time: Instant,

    // G-Buffer textures
    pub g_buffer_position_texture: Option<wgpu::Texture>,
    pub g_buffer_position_view: Option<wgpu::TextureView>,
    pub g_buffer_normal_texture: Option<wgpu::Texture>,
    pub g_buffer_normal_view: Option<wgpu::TextureView>,
    pub g_buffer_albedo_texture: Option<wgpu::Texture>,
    pub g_buffer_albedo_view: Option<wgpu::TextureView>,
    pub g_buffer_pbr_material_texture: Option<wgpu::Texture>,
    pub g_buffer_pbr_material_view: Option<wgpu::TextureView>,
    pub g_buffer_sampler: Option<wgpu::Sampler>,
    pub shadow_pipeline_data: Option<ShadowPipelineData>,
    pub ui_pipeline: Option<UiPipeline>,

    // G-Buffer bind group
    pub g_buffer_bind_group_layout: Option<wgpu::BindGroupLayout>,
    pub g_buffer_bind_group: Option<wgpu::BindGroup>,
    pub lighting_bind_group: Option<wgpu::BindGroup>,
    pub directional_light_buffer: Option<wgpu::Buffer>,
    pub point_lights_buffer: Option<wgpu::Buffer>,
    pub gizmo_pipeline: Option<RenderPipeline>,

    pub directional_light_position: [f32; 3],
    pub selected_component_id: Option<String>,
}

impl ExportPipeline {
    pub fn new() -> Self {
        let mut dock_state = DockState::new(vec![Tab::Projects, Tab::Components]);
        let surface = dock_state.main_surface_mut();
        let [_, _] = surface.split_below(NodeIndex::root(), 0.5, vec![Tab::Properties, Tab::Chat]);

        ExportPipeline {
            // device: None,
            // queue: None,
            gpu_resources: None,
            camera: None,
            camera_binding: None,
            geometry_pipeline: None,
            lighting_pipeline: None,
            texture: None,
            view: None,
            depth_view: None,
            dock_state,
            window_size_bind_group: None,
            export_editor: None,
            frame_buffer: None,
            chat: Chat::new(),
            new_project_name: String::new(),
            projects: Vec::new(),
            
            start_time: Instant::now(),

            g_buffer_position_texture: None,
            g_buffer_position_view: None,
            g_buffer_normal_texture: None,
            g_buffer_normal_view: None,
            g_buffer_albedo_texture: None,
            g_buffer_albedo_view: None,
            g_buffer_pbr_material_texture: None,
            g_buffer_pbr_material_view: None,
            g_buffer_bind_group_layout: None,
            g_buffer_bind_group: None,
            lighting_bind_group: None,
            directional_light_buffer: None,
            point_lights_buffer: None,
            g_buffer_sampler: None,
            shadow_pipeline_data: None,
            ui_pipeline: None,
            gizmo_pipeline: None,
            procedural_sky_pipeline: None,
            procedural_sky_bind_group: None,
            procedural_sky_uniform_buffer: None,
            debug_sphere_pipeline: None,
            directional_light_position: [2.0, 2.0, 2.0],
            selected_component_id: None,
        }
    }

    pub async fn initialize(
        &mut self,
        
        #[cfg(target_os = "windows")]
        window: Option<&Window>,

        #[cfg(target_arch = "wasm32")]
        canvas: Option<HtmlCanvasElement>,

        window_size: WindowSize,
        sequences: Vec<Sequence>,
        video_current_sequence_timeline: SavedTimelineStateConfig,
        video_width: u32,
        video_height: u32,
        project_id: String,
        game_mode: bool
    ) {
        let mut camera = Camera::new(
            Point3::new(0.0, 0.5, -5.0),
            Vector3::new(0.0, 0.0, -1.0),
            Vector3::new(0.0, 1.0, 0.0),
            45.0f32.to_radians(),
            0.1,
            100000.0,
            window_size.width as f32,
            window_size.height as f32
        );

        // Center camera on viewport center with appropriate zoom
        let center_x = video_width as f32 / 2.0;
        let center_y = video_height as f32 / 2.0;
        let zoom_level = 0.05; // Adjust as needed
        
        // camera.birds_eye_zoom_on_point(-0.48, -0.40, 1.25); 
        // camera.position = Vector3::new(-0.5, -0.5, 1.4);

        let viewport = Arc::new(Mutex::new(Viewport::new(
            // swap for video dimensions?
            // window_size.width as f32,
            // window_size.height as f32,
            video_width as f32,
            video_height as f32,
        )));

        // create a dedicated editor so it can be used in the async thread
        let mut export_editor = Editor::new(viewport, project_id.clone());

        #[cfg(target_arch = "wasm32")]
        let window = if let Some(canvas) = canvas {
            Some(wgpu::SurfaceTarget::Canvas(canvas))
        } else {
            None
        };

        // continue on with wgpu items
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            ..Default::default()
        });

        let mut surface: Option<Arc<wgpu::Surface<'static>>> = None;

        let adapter = if let Some(window) = window {
            // SAFETY: The surface must not outlive the window.
            let s = unsafe { instance.create_surface(window).unwrap() };
            // We can transmute the lifetime to static because the window lives for the duration
            // of the application, which is effectively a static lifetime.
            let s: wgpu::Surface<'static> = unsafe { std::mem::transmute(s) };
            let s = Arc::new(s);
            surface = Some(s.clone());
            instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::default(),
                    compatible_surface: Some(&s),
                    force_fallback_adapter: false,
                })
                .await
                .expect("Couldn't get gpu adapter")
        } else {
            instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::default(),
                    compatible_surface: None, // no surface desired for export
                    force_fallback_adapter: false,
                })
                .await
                .expect("Couldn't get gpu adapter")
        };

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: None,
                    // required_features: wgpu::Features::FLOAT32_FILTERABLE,
                    required_limits: Limits {
                        // max_bind_groups: 5, // bad for wasm :(
                        ..Default::default()
                    },
                    ..Default::default()
                },
                // None,
            )
            .await
            .expect("Couldn't get gpu device");

        let mut camera_binding = CameraBinding::new(&device);

        let depth_texture = device.create_texture(&wgpu::TextureDescriptor {
            size: wgpu::Extent3d {
                // width: window_size.width.clone(),
                // height: window_size.height.clone(),
                width: video_width.clone(),
                height: video_height.clone(),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1, // used in a multisampled environment
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth24Plus,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            label: Some("Stunts Engine Export Depth Texture"),
            view_formats: &[],
        });

        let depth_view = depth_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Create G-buffer textures and views
        let gbuffer_position_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("G-Buffer Position Texture"),
            size: wgpu::Extent3d {
                width: video_width,
                height: video_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let gbuffer_position_view = gbuffer_position_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let gbuffer_normal_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("G-Buffer Normal Texture"),
            size: wgpu::Extent3d {
                width: video_width,
                height: video_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let gbuffer_normal_view = gbuffer_normal_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let gbuffer_albedo_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("G-Buffer Albedo Texture"),
            size: wgpu::Extent3d {
                width: video_width,
                height: video_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let gbuffer_albedo_view = gbuffer_albedo_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let gbuffer_pbr_material_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("G-Buffer PBR Material Texture"),
            size: wgpu::Extent3d {
                width: video_width,
                height: video_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let gbuffer_pbr_material_view = gbuffer_pbr_material_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let g_buffer_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("G-Buffer Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        let g_buffer_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("G-Buffer Bind Group Layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 4,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering),
                        count: None,
                    },
                ],
            });

        let g_buffer_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("G-Buffer Bind Group"),
            layout: &g_buffer_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&gbuffer_position_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&gbuffer_normal_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&gbuffer_albedo_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&gbuffer_pbr_material_view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::Sampler(&g_buffer_sampler),
                },
            ],
        });

        let depth_stencil_state = wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth24Plus,
            depth_write_enabled: true,
            depth_compare: wgpu::CompareFunction::Less,
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        };

        let model_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                entries: &[
                    // Existing uniform buffer binding
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    // Texture binding
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            // view_dimension: wgpu::TextureViewDimension::D2,
                            view_dimension: wgpu::TextureViewDimension::D2Array,
                            multisampled: false,
                        },
                        count: None,
                    },
                    // Sampler binding
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                    // Render mode
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    // Normal map texture array
                    wgpu::BindGroupLayoutEntry {
                        binding: 4,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2Array,
                            multisampled: false,
                        },
                        count: None,
                    },
                    // PBR params texture array
                    wgpu::BindGroupLayoutEntry {
                        binding: 5,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2Array,
                            multisampled: false,
                        },
                        count: None,
                    },
                ],
                label: Some("Stunts Engine Export Model Layout"),
            });

        let model_bind_group_layout = Arc::new(model_bind_group_layout);

        let group_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                entries: &[
                    // Existing uniform buffer binding
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
                label: Some("export group_bind_group_layout"),
            });

        let group_bind_group_layout = Arc::new(group_bind_group_layout);

        let ui_model_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                entries: &[
                    // Uniform buffer binding
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    // Texture binding (D2)
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    // Sampler binding
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
                label: Some("UI Model Bind Group Layout"),
            });

        let ui_model_bind_group_layout = Arc::new(ui_model_bind_group_layout);

        let window_size_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::cast_slice(&[WindowSizeShader {
                // swap for vidoe dimensions?
                // width: window_size.width as f32,
                // height: window_size.height as f32,
                width: video_width.clone() as f32,
                height: video_height.clone() as f32,
            }]),
            usage: wgpu::BufferUsages::UNIFORM,
        });

        let window_size_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: None,
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
            });

        let window_size_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &window_size_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: window_size_buffer.as_entire_binding(),
            }],
            label: None,
        });

        let color_render_mode_buffer =
            device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Color Render Mode Buffer"),
                    contents: bytemuck::cast_slice(&[0i32]), // Default to normal mode
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

        let color_render_mode_buffer = Arc::new(color_render_mode_buffer);

        let texture_render_mode_buffer =
            device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Texture Render Mode Buffer"),
                    contents: bytemuck::cast_slice(&[1i32]), // Default to text mode
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

        let texture_render_mode_buffer = Arc::new(texture_render_mode_buffer);

        let regular_texture_render_mode_buffer =
            device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Regular Texture Render Mode Buffer"),
                    contents: bytemuck::cast_slice(&[2i32]), // Default to text mode
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

        let regular_texture_render_mode_buffer = Arc::new(regular_texture_render_mode_buffer);

        // Define the layouts
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Stunts Engine Export Pipeline Layout"),
            bind_group_layouts: &[
                &camera_binding.bind_group_layout,
                &model_bind_group_layout,
                &window_size_bind_group_layout,
                &group_bind_group_layout,
            ],
            push_constant_ranges: &[],
        });

        // Load the shaders
        let shader_module_vert_primary =
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Stunts Engine Export Vert Shader"),
                // source: wgpu::ShaderSource::Wgsl(include_str!("shaders/vert_primary.wgsl").into()), // stunts
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/primary_vertex.wgsl").into()), // midpoint
            });

        // let shader_module_frag_primary =
        //     device.create_shader_module(wgpu::ShaderModuleDescriptor {
        //         label: Some("Stunts Engine Export Frag Shader"),
        //         // source: wgpu::ShaderSource::Wgsl(include_str!("shaders/frag_primary.wgsl").into()), // stunts
        //         source: wgpu::ShaderSource::Wgsl(include_str!("shaders/primary_fragment.wgsl").into()), // midpoint
        //     });

        let shader_module_frag_gbuffer =
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("G-Buffer Frag Shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/gbuffer_fragment.wgsl").into()),
            });

        // let swapchain_capabilities = gpu_resources
        //     .surface
        //     .get_capabilities(&gpu_resources.adapter);
        // let swapchain_format = swapchain_capabilities.formats[0]; // Choosing the first available format
        // let swapchain_format = wgpu::TextureFormat::Rgba8UnormSrgb; // hardcode for now - may be able to change from the floem requirement
        let swapchain_format = wgpu::TextureFormat::Rgba8Unorm;
        // let swapchain_format = wgpu::TextureFormat::Rgba8Unorm;

        // Configure the render pipeline
        // let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        //     label: Some("Entropy Engine Render Pipeline"),
        //     layout: Some(&pipeline_layout),
        //     multiview: None,
        //     cache: None,
        //     vertex: wgpu::VertexState {
        //         module: &shader_module_vert_primary,
        //         entry_point: Some("vs_main"), // name of the entry point in your vertex shader
        //         buffers: &[Vertex::desc()], // Make sure your Vertex::desc() matches your vertex structure
        //         compilation_options: wgpu::PipelineCompilationOptions::default(),
        //     },
        //     fragment: Some(wgpu::FragmentState {
        //         module: &shader_module_frag_primary,
        //         entry_point: Some("fs_main"), // name of the entry point in your fragment shader
        //         targets: &[Some(wgpu::ColorTargetState {
        //             format: swapchain_format,
        //             // blend: Some(wgpu::BlendState::REPLACE),
        //             blend: Some(wgpu::BlendState {
        //                 color: wgpu::BlendComponent {
        //                     src_factor: wgpu::BlendFactor::SrcAlpha,
        //                     dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        //                     operation: wgpu::BlendOperation::Add,
        //                 },
        //                 alpha: wgpu::BlendComponent {
        //                     src_factor: wgpu::BlendFactor::One,
        //                     dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        //                     operation: wgpu::BlendOperation::Add,
        //                 },
        //             }),
        //             write_mask: wgpu::ColorWrites::ALL,
        //         })],
        //         compilation_options: wgpu::PipelineCompilationOptions::default(),
        //     }),
        //     // primitive: wgpu::PrimitiveState::default(),
        //     // depth_stencil: None,
        //     // multisample: wgpu::MultisampleState::default(),
        //     primitive: wgpu::PrimitiveState {
        //         conservative: false,
        //         topology: wgpu::PrimitiveTopology::TriangleList, // how vertices are assembled into geometric primitives
        //         // strip_index_format: Some(wgpu::IndexFormat::Uint32),
        //         strip_index_format: None,
        //         front_face: wgpu::FrontFace::Ccw, // Counter-clockwise is considered the front face
        //         // none cull_mode
        //         cull_mode: None,
        //         polygon_mode: wgpu::PolygonMode::Fill,
        //         // Other properties such as conservative rasterization can be set here
        //         unclipped_depth: false,
        //     },
        //     depth_stencil: Some(depth_stencil_state.clone()), // Optional, only if you are using depth testing
        //     multisample: wgpu::MultisampleState {
        //         // count: 4, // effect performance
        //         count: 1,
        //         mask: !0,
        //         alpha_to_coverage_enabled: false,
        //     },
        // });

        let directional_light_position = [-2.0, 2.0, 2.0];

        let shadow_pipeline_data = ShadowPipelineData::new(
            &device,
            &queue,
            &model_bind_group_layout,
            video_width,
            video_height,
            directional_light_position
        );

        let ui_pipeline = UiPipeline::new(
            &device,
            &camera_binding.bind_group_layout,
            &ui_model_bind_group_layout,
            &window_size_bind_group_layout,
            &group_bind_group_layout,
            swapchain_format,
        );

        let geometry_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Entropy Engine Geometry Pipeline"),
            layout: Some(&pipeline_layout),
            multiview: None,
            cache: None,
            vertex: wgpu::VertexState {
                module: &shader_module_vert_primary,
                entry_point: Some("vs_main"),
                buffers: &[Vertex::desc()],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader_module_frag_gbuffer,
                entry_point: Some("fs_main"),
                targets: &[
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba16Float,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba16Float,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                ],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                conservative: false,
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
            },
            depth_stencil: Some(depth_stencil_state),
            multisample: wgpu::MultisampleState {
                count: 1,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
        });

        // Directional Light
        #[repr(C)]
        #[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
        struct DirectionalLightUniform {
            position: [f32; 3],
            _padding: u32,
            color: [f32; 3],
            _padding2: u32,
        }

        let directional_light_uniform = DirectionalLightUniform {
            position: directional_light_position,
            // position: [-0.5, -1.0, -0.3], // since this is the direction in the shader
            _padding: 0,
            color: [0.5, 0.5, 0.5],
            _padding2: 0,
        };

        let directional_light_buffer = device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("Directional Light VB"),
                contents: bytemuck::cast_slice(&[directional_light_uniform]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }
        );

        // Point Lights
        let point_lights_uniform = crate::core::editor::PointLightsUniform {
            point_lights: [[0.0; 12]; crate::core::editor::MAX_POINT_LIGHTS],
            num_point_lights: 0,
            _padding: [0; 3],
        };

        let point_lights_buffer = device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("Point Lights VB"),
                contents: bytemuck::cast_slice(&[point_lights_uniform]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }
        );

        let lighting_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // Shadow map texture
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
                // Shadow map sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison),
                    count: None,
                },
            ],
            label: Some("Lighting Bind Group Layout"),
        });

        let lighting_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &lighting_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: directional_light_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: point_lights_buffer.as_entire_binding(),
                },
                // Shadow map texture view
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&shadow_pipeline_data.shadow_view),
                },
                // Shadow map sampler
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(&shadow_pipeline_data.shadow_sampler),
                },
            ],
            label: Some("Lighting Bind Group"),
        });

        let lighting_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Lighting Pipeline Layout"),
            bind_group_layouts: &[
                &lighting_bind_group_layout, // group(0)
                &g_buffer_bind_group_layout,
                // &window_size_bind_group_layout,
                 &camera_binding.bind_group_layout,
                &shadow_pipeline_data.shadow_bind_group_layout, // group(3)
                // &camera_binding.bind_group_layout
            ],
            push_constant_ranges: &[],
        });

        let shader_module_lighting =
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Lighting Shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/lighting.wgsl").into()),
            });

        let lighting_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Lighting Pipeline"),
            layout: Some(&lighting_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader_module_lighting,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader_module_lighting,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: swapchain_format,
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

                let texture = device.create_texture(&wgpu::TextureDescriptor {
            size: wgpu::Extent3d {
                // width: window_size.width,
                // height: window_size.height,
                width: video_width.clone(),
                height: video_height.clone(),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            // sample_count: 4,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: swapchain_format,
            usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::RENDER_ATTACHMENT,
            label: Some("Export render texture"),
            view_formats: &[],
        });

        let texture = Arc::new(texture);

        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        let view = Arc::new(view);

        camera_binding.update_3d(&queue, &camera);

        let shader_module_gizmo_vert =
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Gizmo Vert Shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/gizmo_vertex.wgsl").into()),
            });

        let shader_module_gizmo_frag =
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Gizmo Frag Shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/gizmo_fragment.wgsl").into()),
            });

        let gizmo_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Gizmo Pipeline Layout"),
            bind_group_layouts: &[
                &window_size_bind_group_layout,
            ],
            push_constant_ranges: &[],
        });

        let gizmo_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Gizmo Pipeline"),
            layout: Some(&gizmo_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader_module_gizmo_vert,
                entry_point: Some("vs_main"),
                buffers: &[
                    wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<[f32; 2]>() as wgpu::BufferAddress,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &wgpu::vertex_attr_array![0 => Float32x2],
                    },
                    wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<[f32; 4]>() as wgpu::BufferAddress,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &wgpu::vertex_attr_array![1 => Float32x4],
                    },
                ],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader_module_gizmo_frag,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: swapchain_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        // --- Procedural Sky Setup ---
        let procedural_sky_config_from_level = export_editor
            .saved_state
            .as_ref()
            .and_then(|state| state.levels.as_ref())
            .and_then(|levels| levels.get(0)) // Assuming we always work with the first level
            .and_then(|level| level.procedural_sky.clone())
            .unwrap_or_default(); // Get from saved_data, or use defaults

        let procedural_sky_uniform_data = ProceduralSkyUniform {
            horizon_color: procedural_sky_config_from_level.horizon_color,
            zenith_color: procedural_sky_config_from_level.zenith_color,
            sun_direction: procedural_sky_config_from_level.sun_direction,
            sun_color: procedural_sky_config_from_level.sun_color,
            sun_intensity: procedural_sky_config_from_level.sun_intensity,
            ..Default::default()
        };

        let procedural_sky_uniform_buffer = device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("Procedural Sky Uniform Buffer"),
                contents: bytemuck::cast_slice(&[procedural_sky_uniform_data]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }
        );

        let procedural_sky_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Procedural Sky Bind Group Layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: Some(std::num::NonZeroU64::new(std::mem::size_of::<camera::CameraUniform>() as u64).unwrap()),
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: Some(std::num::NonZeroU64::new(std::mem::size_of::<ProceduralSkyUniform>() as u64).unwrap()),
                        },
                        count: None,
                    },
                ],
            });
        
        let procedural_sky_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Procedural Sky Bind Group"),
            layout: &procedural_sky_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: camera_binding.buffer.as_entire_binding(), // Re-use camera_binding's buffer
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: procedural_sky_uniform_buffer.as_entire_binding(),
                },
            ],
        });

        let shader_module_sky =
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Procedural Sky Shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/sky.wgsl").into()),
            });

        let shader_module_debug_sphere =
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Debug Sphere Shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/debug_sphere.wgsl").into()),
            });

        let debug_sphere_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Debug Sphere Pipeline Layout"),
            bind_group_layouts: &[
                &camera_binding.bind_group_layout,
                &model_bind_group_layout,
            ],
            push_constant_ranges: &[],
        });

        let debug_sphere_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Debug Sphere Pipeline"),
            layout: Some(&debug_sphere_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader_module_debug_sphere,
                entry_point: Some("vs_main"),
                buffers: &[Vertex::desc()],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader_module_debug_sphere,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: swapchain_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::LineList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth24Plus,
                depth_write_enabled: false,
                depth_compare: wgpu::CompareFunction::LessEqual,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let procedural_sky_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Procedural Sky Pipeline Layout"),
            bind_group_layouts: &[&procedural_sky_bind_group_layout],
            push_constant_ranges: &[],
        });

        let procedural_sky_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Procedural Sky Pipeline"),
            layout: Some(&procedural_sky_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader_module_sky,
                entry_point: Some("vs_main"),
                buffers: &[], // No vertex buffers, generates full screen triangle from vertex_index
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader_module_sky,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: swapchain_format, // Use the main swapchain format
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: Some(wgpu::Face::Back), // Cull back faces (since we're rendering from inside)
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            // IMPORTANT: For skybox, we need to pass depth test if depth is 1.0 (far plane) and disable depth write
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth24Plus, // Match the depth buffer format
                depth_write_enabled: false, // Don't write to depth buffer
                depth_compare: wgpu::CompareFunction::LessEqual, // Draw only where no geometry (depth is 1.0)
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        // --- End Procedural Sky Setup ---

        let skinned_pipeline = SkinnedPipeline::new(&device, &camera_binding.bind_group_layout, &model_bind_group_layout, swapchain_format, wgpu::TextureFormat::Depth24Plus);

        println!("Grid Restored!");

        let mut renderer_state = RendererState::new(
            &device, 
            &queue, 
            model_bind_group_layout.clone(), 
            group_bind_group_layout.clone(), 
            &camera,
            texture_render_mode_buffer.clone(),
            color_render_mode_buffer,
            regular_texture_render_mode_buffer,
            game_mode,
            skinned_pipeline
        );

        if game_mode {
            export_editor.health_bar = Some(HealthBar::new(
                &device,
                &queue,
                &ui_model_bind_group_layout,
                &group_bind_group_layout,
                &camera,
                &WindowSize { width: video_width, height: video_height },
                Point { x: 150.0, y: 50.0 }, // Top-left area
                200.0,
                30.0,
                100.0,
            ));

            export_editor.enemy_health_bar = Some(HealthBar::new(
                &device,
                &queue,
                &ui_model_bind_group_layout,
                &group_bind_group_layout,
                &camera,
                &WindowSize { width: video_width, height: video_height },
                Point { x: video_width as f32 - 150.0, y: 50.0 }, // Top-right area
                200.0,
                30.0,
                100.0,
            ));
        }

        let mut grids = Vec::new();

        if !game_mode {
            grids.push(Grid::new(
                &device,
                &queue,
                &model_bind_group_layout,
                &group_bind_group_layout.clone(),
                &texture_render_mode_buffer.clone(),
                &camera,
                GridConfig {
                    width: 200.0,
                    depth: 200.0,
                    spacing: 4.0,
                    line_thickness: 0.1,
                },
            ));
            grids.push(Grid::new(
                &device,
                &queue,
                &model_bind_group_layout,
                &group_bind_group_layout,
                &texture_render_mode_buffer,
                &camera,
                GridConfig {
                    width: 200.0,
                    depth: 200.0,
                    spacing: 1.0,
                    line_thickness: 0.025,
                },
            ));
        }

        renderer_state.grids = grids;

        export_editor.renderer_state = Some(renderer_state);

        let gpu_resources = if let Some(surface) = surface {
            GpuResources::with_surface(adapter, device, queue, surface)
        } else {
            GpuResources::new(adapter, device, queue)
        };

        let gpu_resources = Arc::new(gpu_resources);

        // set needed editor properties
        export_editor.model_bind_group_layout = Some(model_bind_group_layout.clone());
        export_editor.group_bind_group_layout = Some(group_bind_group_layout.clone());
        export_editor.gpu_resources = Some(gpu_resources.clone());

        // let gpu_resources = export_editor
        //     .gpu_resources
        //     .as_ref()
        //     .expect("Couldn't get gpu resources");

        println!("Pipeline initialized!");
        
        // begin playback
        export_editor.camera = Some(camera);

        // restore objects to the editor
        // sequences.iter().enumerate().for_each(|(i, s)| {
        //     export_editor.restore_sequence_objects(
        //         &s,
        //         // WindowSize {
        //         //     // width: window_size.width as u32,
        //         //     // height: window_size.height as u32,
        //         //     width: video_width.clone(),
        //         //     height: video_height.clone(),
        //         // },
        //         // &camera,
        //         if i == 0 { false } else { true },
        //         // &gpu_resources.device,
        //         // &gpu_resources.queue,
        //     );
        // });
        // #[cfg(target_os = "windows")]
        let now = Instant::now();
        
        // #[cfg(target_arch = "wasm32")]
        // let now = js_sys::Date::now() - self.start_time;
        
        export_editor.video_start_playing_time = Some(now.clone());

        export_editor.video_current_sequence_timeline = Some(video_current_sequence_timeline);
        export_editor.video_current_sequences_data = Some(sequences);

        export_editor.video_is_playing = true;

        // also set motion path playing
        export_editor.start_playing_time = Some(now);
        export_editor.is_playing = true;
        export_editor.ui_model_bind_group_layout = Some(ui_model_bind_group_layout);
        

        export_editor.camera_binding = Some(camera_binding);

        // self.device = Some(device);
        // self.queue = Some(queue);
        

        self.gizmo_pipeline = Some(gizmo_pipeline);

        self.gpu_resources = export_editor.gpu_resources.clone();
        self.geometry_pipeline = Some(geometry_pipeline);
        self.lighting_pipeline = Some(lighting_pipeline);
        self.procedural_sky_pipeline = Some(procedural_sky_pipeline);
        self.procedural_sky_bind_group = Some(procedural_sky_bind_group);
        self.procedural_sky_uniform_buffer = Some(procedural_sky_uniform_buffer);
        self.debug_sphere_pipeline = Some(debug_sphere_pipeline);
        self.texture = Some(texture);
        self.view = Some(view);
        self.depth_view = Some(depth_view);
        self.window_size_bind_group = Some(window_size_bind_group);
        self.export_editor = Some(export_editor);

        self.g_buffer_position_texture = Some(gbuffer_position_texture);
        self.g_buffer_position_view = Some(gbuffer_position_view);
        self.g_buffer_normal_texture = Some(gbuffer_normal_texture);
        self.g_buffer_normal_view = Some(gbuffer_normal_view);
        self.g_buffer_albedo_texture = Some(gbuffer_albedo_texture);
        self.g_buffer_albedo_view = Some(gbuffer_albedo_view);
        self.g_buffer_pbr_material_texture = Some(gbuffer_pbr_material_texture);
        self.g_buffer_pbr_material_view = Some(gbuffer_pbr_material_view);
        self.g_buffer_bind_group_layout = Some(g_buffer_bind_group_layout);
        self.g_buffer_bind_group = Some(g_buffer_bind_group);
        self.lighting_bind_group = Some(lighting_bind_group);
        self.directional_light_buffer = Some(directional_light_buffer);
        self.point_lights_buffer = Some(point_lights_buffer);
        self.g_buffer_sampler = Some(g_buffer_sampler);
        self.shadow_pipeline_data = Some(shadow_pipeline_data);
        self.ui_pipeline = Some(ui_pipeline);
        self.directional_light_position = directional_light_position;
    }

    pub fn resize(&mut self, new_size: EntropySize) {
        if new_size.width > 0 && new_size.height > 0 {
            let gpu_resources = self.gpu_resources.as_ref().unwrap();
            let device = &gpu_resources.device;
            let g_buffer_bind_group_layout = self.g_buffer_bind_group_layout.as_ref().unwrap();
            let g_buffer_sampler = self.g_buffer_sampler.as_ref().unwrap(); // Assuming sampler is at binding 3

            // Recreate depth texture
            let depth_texture = device.create_texture(&wgpu::TextureDescriptor {
                size: wgpu::Extent3d {
                    width: new_size.width,
                    height: new_size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Depth24Plus,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                label: Some("Stunts Engine Export Depth Texture"),
                view_formats: &[],
            });
            let depth_view = depth_texture.create_view(&wgpu::TextureViewDescriptor::default());
            self.depth_view = Some(depth_view);

            // Recreate G-buffer textures and views
            let gbuffer_position_texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("G-Buffer Position Texture"),
                size: wgpu::Extent3d {
                    width: new_size.width,
                    height: new_size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let gbuffer_position_view = gbuffer_position_texture.create_view(&wgpu::TextureViewDescriptor::default());

            let gbuffer_normal_texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("G-Buffer Normal Texture"),
                size: wgpu::Extent3d {
                    width: new_size.width,
                    height: new_size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let gbuffer_normal_view = gbuffer_normal_texture.create_view(&wgpu::TextureViewDescriptor::default());

            let gbuffer_albedo_texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("G-Buffer Albedo Texture"),
                size: wgpu::Extent3d {
                    width: new_size.width,
                    height: new_size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let gbuffer_albedo_view = gbuffer_albedo_texture.create_view(&wgpu::TextureViewDescriptor::default());

            let gbuffer_pbr_material_texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("G-Buffer PBR Material Texture"),
                size: wgpu::Extent3d {
                    width: new_size.width,
                    height: new_size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let gbuffer_pbr_material_view = gbuffer_pbr_material_texture.create_view(&wgpu::TextureViewDescriptor::default());

            // Recreate shadow pipeline data
            let shadow_pipeline_data = ShadowPipelineData::new(
                device,
                &gpu_resources.queue, // Use gpu_resources.queue
                self.export_editor.as_ref().unwrap().model_bind_group_layout.as_ref().unwrap(), // Pass model_bind_group_layout
                new_size.width,
                new_size.height,
                self.directional_light_position
            );

            // Recreate window size buffer and bind group
            let window_size_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&[WindowSizeShader {
                    width: new_size.width as f32,
                    height: new_size.height as f32,
                }]),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let window_size_bind_group_layout =
                device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: None,
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
                });
            let window_size_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                layout: &window_size_bind_group_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: window_size_buffer.as_entire_binding(),
                }],
                label: None,
            });

            // Recreate G-buffer bind group
            let new_g_buffer_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("G-Buffer Bind Group (Resized)"),
                layout: g_buffer_bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&gbuffer_position_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&gbuffer_normal_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(&gbuffer_albedo_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(&gbuffer_pbr_material_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        // Need to get the sampler from the original bind group
                        resource: wgpu::BindingResource::Sampler(&g_buffer_sampler),
                    },
                ],
            });

            self.g_buffer_position_texture = Some(gbuffer_position_texture);
            self.g_buffer_position_view = Some(gbuffer_position_view);
            self.g_buffer_normal_texture = Some(gbuffer_normal_texture);
            self.g_buffer_normal_view = Some(gbuffer_normal_view);
            self.g_buffer_albedo_texture = Some(gbuffer_albedo_texture);
            self.g_buffer_albedo_view = Some(gbuffer_albedo_view);
            self.g_buffer_pbr_material_texture = Some(gbuffer_pbr_material_texture);
            self.g_buffer_pbr_material_view = Some(gbuffer_pbr_material_view);
            self.g_buffer_bind_group = Some(new_g_buffer_bind_group);
            self.shadow_pipeline_data = Some(shadow_pipeline_data); // Add this line
            self.window_size_bind_group = Some(window_size_bind_group);
    
            if let Some(editor) = self.export_editor.as_mut() {
                if let Some(camera) = editor.camera.as_mut() {
                    // camera.aspect = new_size.width as f32 / new_size.height as f32;
                    camera.aspect_ratio = new_size.width as f32 / new_size.height as f32;
                    camera.viewport.width = new_size.width as f32;
                    camera.viewport.height = new_size.height as f32;
                    camera.viewport.window_size.width = new_size.width;
                    camera.viewport.window_size.height = new_size.height;
                }
            }

            // resize ui elements
            let editor = self.export_editor.as_mut().expect("Couldn't get editor");
            if let Some(enemy_health_bar) = &mut editor.enemy_health_bar {
                enemy_health_bar.bar.transform.update_position([new_size.width as f32 - 150.0, 50.0, 0.0]);
                enemy_health_bar.background.transform.update_position([new_size.width as f32 - 150.0, 50.0, 0.0]);
            }
        }
    }

    pub fn render_frame(&mut self, target_view: Option<&wgpu::TextureView>, current_time: f64, game_mode: bool) {
        let editor = self.export_editor.as_mut().expect("Couldn't get editor");
        let renderer_state = editor.renderer_state.as_mut().expect("Couldn't get RendererState");
        let gpu_resources = self
            .gpu_resources
            .as_ref()
            .expect("Couldn't get gpu resources");
        let device = &gpu_resources.device;
        let queue = &gpu_resources.queue;
        // let device = self.device.as_ref().expect("Couldn't get device");
        // let queue = self.queue.as_ref().expect("Couldn't get queue");
        let view = if let Some(target_view) = target_view {
            target_view
        } else {
            self.view.as_ref().expect("Couldn't get texture view")
        };
        let depth_view = self
            .depth_view
            .as_ref()
            .expect("Couldn't get depth texture view");
        // let render_pipeline = self
        //     .render_pipeline
        //     .as_ref()
        //     .expect("Couldn't get render pipeline");
        let geometry_pipeline = self
            .geometry_pipeline
            .as_ref()
            .expect("Couldn't get geometry pipeline");
        // let camera_binding = self
        //     .camera_binding
        //     .as_ref()
        //     .expect("Couldn't get camera binding");
        let camera = editor
            .camera
            .as_mut()
            .expect("Couldn't get camera");
        let camera_binding = editor
            .camera_binding
            .as_mut()
            .expect("Couldn't get camera binding");
        let window_size_bind_group = self
            .window_size_bind_group
            .as_ref()
            .expect("Couldn't get window size bind group");
        // let camera = self.camera.as_ref().expect("Couldn't get camera"); // careful, we have a camera on editor and on self
        let texture = self.texture.as_ref().expect("Couldn't get texture");
        
        // Sync player health to UI
        if let Some(player) = &renderer_state.player_character {
            if let Some(health_bar) = &mut editor.health_bar {
                health_bar.update_health(queue, player.stats.health);
            }
        }

        // Sync enemy health to UI
        if let Some(target_id) = &editor.current_enemy_target {
            if let Some(npc) = renderer_state.npcs.iter().find(|n| &n.id == target_id) {
                 if let Some(health_bar) = &mut editor.enemy_health_bar {
                    health_bar.update_health(queue, npc.stats.health);
                }
            }
        }

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            // Update procedural sky uniform buffer if config is present
            let current_procedural_sky_config = editor
                .saved_state
                .as_ref()
                .and_then(|state| state.levels.as_ref())
                .and_then(|levels| levels.get(0))
                .and_then(|level| level.procedural_sky.clone());

            if let Some(config) = current_procedural_sky_config {
                let procedural_sky_uniform_data = ProceduralSkyUniform {
                    horizon_color: config.horizon_color,
                    zenith_color: config.zenith_color,
                    sun_direction: config.sun_direction,
                    sun_color: config.sun_color,
                    sun_intensity: config.sun_intensity,
                    ..Default::default()
                };
                queue.write_buffer(
                    self.procedural_sky_uniform_buffer.as_ref().unwrap(),
                    0,
                    bytemuck::cast_slice(&[procedural_sky_uniform_data]),
                );
            }

            // Shadow Pass
            {
                let shadow_pipeline_data = self.shadow_pipeline_data.as_ref().unwrap();

                let mut shadow_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Shadow Pass"),
                    color_attachments: &[], // No color attachment, we only care about depth
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: &shadow_pipeline_data.shadow_view,
                        depth_ops: Some(wgpu::Operations {
                            load: wgpu::LoadOp::Clear(1.0), // Clear to max depth
                            store: wgpu::StoreOp::Store,
                        }),
                        stencil_ops: None,
                    }),
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });

                shadow_pipeline_data.render_shadow_pass(
                    &mut shadow_pass,
                    renderer_state,
                    queue,
                );
            }

            // update rapier collisions
            renderer_state.update_rapier();

            // perhaps counterproductive to avoid physics in the preview
            // but sometimes you dont want to mix physics when doing design (make this a setting)
            if game_mode {
                // step through physics each frame
                renderer_state.step_physics_pipeline(
                    &gpu_resources.device,
                    &gpu_resources.queue,
                    camera_binding,
                    camera
                );
            }

            // Execute Rhai component scripts
            let mut changes: Vec<ComponentChanges> = Vec::new();
            if let Some(saved_state) = editor.saved_state.as_ref() {
                if let Some(levels) = saved_state.levels.as_ref() {
                    if let Some(components) = levels.get(0).and_then(|l| l.components.as_ref()) {
                        for component in components.iter() {
                            if let Some(script_path) = &component.rhai_script_path {
                                if let Some(change) = editor.rhai_engine.execute_component_script(
                                    renderer_state,
                                    component,
                                    script_path,
                                    "on_update",
                                ) {
                                    changes.push(change);
                                }
                            }
                        }
                    }
                }
            }

            // Apply collected changes
            for change in changes {
                if let Some(model) = renderer_state.models.iter_mut().find(|m| m.id == change.component_id) {
                    if let Some(new_pos) = change.new_position {
                        let pos_array = [new_pos.x, new_pos.y, new_pos.z];
                        
                        // Update model's transform for rendering
                        for mesh in &mut model.meshes {
                            mesh.transform.update_position(pos_array);
                        }
                        
                        // Update rigidbody for physics
                        if let Some(rb_handle) = model.meshes[0].rigid_body_handle {
                            if let Some(rb) = renderer_state.rigid_body_set.get_mut(rb_handle) {
                                let new_isometry = nalgebra::Isometry3::translation(new_pos.x, new_pos.y, new_pos.z);
                                rb.set_position(new_isometry, true);
                            }
                        }
                    }
                }
            }

            let time = self.start_time.elapsed().as_secs_f32();
            if !renderer_state.particle_systems.is_empty() {
                renderer_state.particle_systems.retain_mut(|system| system.update(queue, time));
            }

            let gbuffer_position_view = self.g_buffer_position_view.as_ref().unwrap();            let gbuffer_normal_view = self.g_buffer_normal_view.as_ref().unwrap();
            let gbuffer_albedo_view = self.g_buffer_albedo_view.as_ref().unwrap();
            let gbuffer_pbr_material_view = self.g_buffer_pbr_material_view.as_ref().unwrap();

            let clear_color = wgpu::Color::BLACK;

            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Geometry Pass"),
                color_attachments: &[
                    Some(wgpu::RenderPassColorAttachment {
                        view: gbuffer_position_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(clear_color),
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None
                    }),
                    Some(wgpu::RenderPassColorAttachment {
                        view: gbuffer_normal_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(clear_color),
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None
                    }),
                    Some(wgpu::RenderPassColorAttachment {
                        view: gbuffer_albedo_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(clear_color),
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None
                    }),
                    Some(wgpu::RenderPassColorAttachment {
                        view: gbuffer_pbr_material_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(clear_color),
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None
                    }),
                ],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &depth_view, // This is the depth texture view
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0), // Clear to max depth
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None, // Set this if using stencil
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            render_pass.set_pipeline(&geometry_pipeline);

            render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
            render_pass.set_bind_group(2, window_size_bind_group, &[]);

            // // draw cubes
            for (poly_index, cube) in renderer_state.cubes.iter().enumerate() {
                // if !polygon.hidden {
                    cube
                        .transform
                        .update_uniform_buffer(&queue);
                    render_pass.set_bind_group(1, &cube.bind_group, &[]);
                    render_pass.set_bind_group(3, &cube.group_bind_group, &[]);
                    render_pass.set_vertex_buffer(0, cube.vertex_buffer.slice(..));
                    render_pass.set_index_buffer(
                        cube.index_buffer.slice(..),
                        wgpu::IndexFormat::Uint32,
                    );
                    render_pass.draw_indexed(0..cube.index_count as u32, 0, 0..1);
                // }
            }

            // draw spheres
            for sphere in &renderer_state.spheres {
                sphere.transform.update_uniform_buffer(&queue);
                render_pass.set_bind_group(1, &sphere.bind_group, &[]);
                render_pass.set_bind_group(3, &sphere.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, sphere.vertex_buffer.slice(..));
                render_pass.set_index_buffer(
                    sphere.index_buffer.slice(..),
                    wgpu::IndexFormat::Uint32,
                );
                render_pass.draw_indexed(0..sphere.index_count as u32, 0, 0..1);
            }

            // draw debug rays
            for debug_ray in &renderer_state.debug_rays {
                // println!("display debug line");
                debug_ray.cube.transform.update_uniform_buffer(&queue);
                render_pass.set_bind_group(1, &debug_ray.cube.bind_group, &[]);
                render_pass.set_bind_group(3, &debug_ray.cube.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, debug_ray.cube.vertex_buffer.slice(..));
                render_pass.set_index_buffer(
                    debug_ray.cube.index_buffer.slice(..),
                    wgpu::IndexFormat::Uint32,
                );
                render_pass.draw_indexed(0..debug_ray.cube.index_count as u32, 0, 0..1);
            }

            for (poly_index, grid) in renderer_state.grids.iter().enumerate() {
                // if !polygon.hidden {
                    grid
                        .transform
                        .update_uniform_buffer(&queue);
                    render_pass.set_bind_group(1, &grid.bind_group, &[]);
                    render_pass.set_bind_group(3, &grid.group_bind_group, &[]);
                    render_pass.set_vertex_buffer(0, grid.vertex_buffer.slice(..));
                    render_pass.set_index_buffer(
                        grid.index_buffer.slice(..),
                        wgpu::IndexFormat::Uint32,
                    );
                    render_pass.draw_indexed(0..grid.index_count as u32, 0, 0..1);
                // }
            }

            for model in &renderer_state.models {
                for mesh in &model.meshes {
                    // Conditional rendering based on skinning
                    if let Some(skin_bind_group) = &model.skin_bind_group {
                        // Use the skinned pipeline and bind its specific bind group
                        if let Some(pipeline_instance) = &renderer_state.skinned_pipeline {
                            render_pass.set_pipeline(&pipeline_instance.render_pipeline);
                            // Bind skin uniform at group 2 (as defined in skinned_pipeline.rs)
                            render_pass.set_bind_group(2, skin_bind_group, &[]);
                        } else {
                             // Fallback to geometry_pipeline if skinned_pipeline is None (should not happen if initialized correctly)
                            render_pass.set_pipeline(&geometry_pipeline);
                        }
                    } else {
                        // Use the regular geometry pipeline for non-skinned meshes
                        render_pass.set_pipeline(&geometry_pipeline);
                    }

                    // if model.hide_from_world {
                    //     println!("Render mesh uniform {:?}", mesh.transform.position);
                    // }

                    mesh.transform.update_uniform_buffer(&gpu_resources.queue);

                    render_pass.set_bind_group(0, &camera_binding.bind_group, &[]); // Camera
                    render_pass.set_bind_group(1, &mesh.bind_group, &[]); // Model transform + textures
                    // render_pass.set_bind_group(2, window_size_bind_group, &[]); // Window size is not needed for skinned shader
                    render_pass.set_bind_group(3, &mesh.group_bind_group, &[]); // Group transform (if any)

                    // Need to use the regular vertex buffer with regular Vertex if using geometry pipeline
                    render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                    render_pass.set_index_buffer(
                        mesh.index_buffer.slice(..),
                        wgpu::IndexFormat::Uint32,
                    );
                    render_pass.draw_indexed(0..mesh.index_count as u32, 0, 0..1);
                }
            }

            for house in &renderer_state.procedural_houses {
                for mesh in &house.meshes {
                    render_pass.set_pipeline(&geometry_pipeline);
                    mesh.transform.update_uniform_buffer(&gpu_resources.queue);
                    render_pass.set_bind_group(1, &mesh.bind_group, &[]);
                    // render_pass.set_bind_group(3, &mesh.group_bind_group, &[]);
                    render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                    render_pass.set_index_buffer(
                        mesh.index_buffer.slice(..),
                        wgpu::IndexFormat::Uint32,
                    );

                    render_pass.draw_indexed(0..mesh.index_count as u32, 0, 0..1);
                }
            }

            for (poly_index, landscape) in renderer_state.landscapes.iter().enumerate() {
                // if !polygon.hidden {
                    render_pass.set_pipeline(&geometry_pipeline);
                    landscape
                        .transform
                        .update_uniform_buffer(&queue); // probably unnecessary
                    render_pass.set_bind_group(1, &landscape.bind_group, &[]);
                    render_pass.set_bind_group(3, &landscape.group_bind_group, &[]);
                    render_pass.set_vertex_buffer(0, landscape.vertex_buffer.slice(..));
                    render_pass.set_index_buffer(
                        landscape.index_buffer.slice(..),
                        wgpu::IndexFormat::Uint32,
                    );
                    render_pass.draw_indexed(0..landscape.index_count as u32, 0, 0..1);
                // }
            }

            // draw grass

            for grass in &mut renderer_state.grasses {
                if let Some(player_character) = &renderer_state.player_character {
                    if let Some(model_id) = &player_character.model_id {
                        let player_model = renderer_state.models.iter().find(|m| m.id == model_id.clone());
                        let player_model = player_model.as_ref().expect("Couldn't find related model");
                        let model_mesh = player_model.meshes.get(0);
                        let model_mesh = model_mesh.as_ref().expect("Couldn't get first mesh");
                        grass.update_uniforms(&queue, time as f32, Point3::new(model_mesh.transform.position.x, model_mesh.transform.position.y, model_mesh.transform.position.z));
                    } else if let Some(sphere) = &player_character.sphere {
                        grass.update_uniforms(&queue, time as f32, Point3::new(sphere.transform.position.x, sphere.transform.position.y, sphere.transform.position.z));
                    } else {
                        grass.update_uniforms(&queue, time as f32, camera.position);
                    }
                } else {
                    grass.update_uniforms(&queue, time as f32, camera.position);
                }

                render_pass.set_pipeline(&grass.render_pipeline);
                render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                render_pass.set_bind_group(1, &grass.uniform_bind_group, &[]);
                render_pass.set_bind_group(2, &grass.landscape_bind_group, &[]);
                render_pass.set_vertex_buffer(0, grass.blade.vertex_buffer.slice(..));
                render_pass.set_index_buffer(grass.blade.index_buffer.slice(..), wgpu::IndexFormat::Uint16);

                let grid_cells = ((grass.config.render_distance * 2.0) / grass.config.grid_size).ceil() as u32;
                let total_instances = grid_cells * grid_cells * grass.config.blade_density as u32;

                render_pass.draw_indexed(0..grass.blade.index_count, 0, 0..total_instances);
                render_pass.set_pipeline(&geometry_pipeline);
            }

            // draw trees
            for trees in &renderer_state.procedural_trees {
                trees.update_uniforms(&queue, time as f32);
                render_pass.draw_trees(
                    trees,
                    &camera_binding.bind_group,
                );
                render_pass.set_pipeline(&geometry_pipeline);
            }

            // draw water
            for water_plane in &mut renderer_state.water_planes {
                if let Some(player_character) = &renderer_state.player_character {
                    if let Some(model_id) = &player_character.model_id {
                        let player_model = renderer_state.models.iter().find(|m| m.id == model_id.clone());
                        let player_model = player_model.as_ref().expect("Couldn't find related model");
                        let model_mesh = player_model.meshes.get(0);
                        let model_mesh = model_mesh.as_ref().expect("Couldn't get first mesh");
                        water_plane.update_uniforms(queue, time as f32, [model_mesh.transform.position.x, model_mesh.transform.position.y, model_mesh.transform.position.z]);
                        render_pass.draw_water(water_plane, &camera_binding.bind_group, &water_plane.time_bind_group, &water_plane.landscape_bind_group, &water_plane.config_bind_group);
                    } else if let Some(sphere) = &player_character.sphere {
                        let player_pos = sphere.transform.position;
                        water_plane.update_uniforms(queue, time as f32, [player_pos.x, player_pos.y, player_pos.z]);
                        render_pass.draw_water(water_plane, &camera_binding.bind_group, &water_plane.time_bind_group, &water_plane.landscape_bind_group, &water_plane.config_bind_group);
                    }
                }
            }

            if !renderer_state.particle_systems.is_empty() {                
                for system in &renderer_state.particle_systems {
                    // println!("isntance count {:?}", system.instance_count);
                    render_pass.set_pipeline(&system.render_pipeline);
                    render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                    render_pass.set_bind_group(1, &system.uniform_bind_group, &[]);
                    render_pass.draw(0..6, 0..system.instance_count);
                }
            }

            // Drop the render pass before doing texture copies
            drop(render_pass);

            // obviously, no good reason to set this on every frame
            let mut point_lights_uniform_data = crate::core::editor::PointLightsUniform {
                point_lights: [[0.0; 12]; crate::core::editor::MAX_POINT_LIGHTS], // Initialize with zeros
                num_point_lights: renderer_state.point_lights.len() as u32,
                _padding: [0; 3],
            };

            for (i, pl) in renderer_state.point_lights.iter().enumerate() {
                // point_lights_uniform_data.point_lights[i] = *pl;
                 point_lights_uniform_data.point_lights[i] = [
                    pl.position[0], pl.position[1], pl.position[2],0.0,  // position + padding
                    pl.color[0], pl.color[1], pl.color[2],0.0, pl.intensity, pl.max_distance, // color + intensity
                     0.0, 0.0
                ];
            }
            
            // Update point lights buffer
            queue.write_buffer(
                self.point_lights_buffer.as_ref().unwrap(),
                0,
                bytemuck::cast_slice(&[point_lights_uniform_data]),
            );

            // Lighting pass
            {
                let lighting_pipeline = self.lighting_pipeline.as_ref().unwrap();
                let lighting_bind_group = self.lighting_bind_group.as_ref().unwrap();
                let g_buffer_bind_group = self.g_buffer_bind_group.as_ref().unwrap();
                let shadow_pipeline_data = self.shadow_pipeline_data.as_ref().unwrap();
                // let camera_binding = editor.camera_binding.as_ref().unwrap();
                let shadow_bind_group = &shadow_pipeline_data.shadow_bind_group;

                let mut lighting_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Lighting Pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });

                lighting_pass.set_pipeline(lighting_pipeline);
                lighting_pass.set_bind_group(0, lighting_bind_group, &[]);
                lighting_pass.set_bind_group(1, g_buffer_bind_group, &[]);
                // lighting_pass.set_bind_group(2, window_size_bind_group, &[]);
                lighting_pass.set_bind_group(3, shadow_bind_group, &[]);
                // lighting_pass.set_bind_group(4, &camera_binding.bind_group, &[]);
                lighting_pass.set_bind_group(2, &camera_binding.bind_group, &[]);
                lighting_pass.draw(0..3, 0..1);
            }

            // Procedural Sky Render Pass
            {
                if let Some(procedural_sky_pipeline) = self.procedural_sky_pipeline.as_ref() {
                    if let Some(procedural_sky_bind_group) = self.procedural_sky_bind_group.as_ref() {
                        let mut sky_render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                            label: Some("Procedural Sky Pass"),
                            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                                view: &view,
                                resolve_target: None,
                                ops: wgpu::Operations {
                                    load: wgpu::LoadOp::Load, // Load existing color (from lighting pass)
                                    store: wgpu::StoreOp::Store,
                                },
                                depth_slice: None,
                            })],
                            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                                view: &depth_view, // Use the same depth view as geometry pass
                                depth_ops: Some(wgpu::Operations {
                                    load: wgpu::LoadOp::Load, // Load existing depth values
                                    store: wgpu::StoreOp::Store,
                                }),
                                stencil_ops: None,
                            }),
                            timestamp_writes: None,
                            occlusion_query_set: None,
                        });

                        sky_render_pass.set_pipeline(procedural_sky_pipeline);
                        sky_render_pass.set_bind_group(0, procedural_sky_bind_group, &[]);
                        sky_render_pass.draw(0..3, 0..1); // Draw the full-screen triangle
                    }
                }
            }

            {
                if let Some(pipeline) = &self.debug_sphere_pipeline {
                    let mut debug_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("Debug Pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Load,
                                store: wgpu::StoreOp::Store,
                            },
                            depth_slice: None
                        })],
                        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                            view: depth_view,
                            depth_ops: Some(wgpu::Operations {
                                load: wgpu::LoadOp::Load,
                                store: wgpu::StoreOp::Store,
                            }),
                            stencil_ops: None,
                        }),
                        timestamp_writes: None,
                        occlusion_query_set: None,
                    });

                    debug_pass.set_pipeline(pipeline);
                    debug_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                    
                    for npc in &renderer_state.npcs {
                        if let Some(sphere) = &npc.debug_sphere {
                            sphere.transform.update_uniform_buffer(queue);
                            debug_pass.set_bind_group(1, &sphere.bind_group, &[]);
                            debug_pass.set_vertex_buffer(0, sphere.vertex_buffer.slice(..));
                            debug_pass.set_index_buffer(sphere.index_buffer.slice(..), wgpu::IndexFormat::Uint16);
                            debug_pass.draw_indexed(0..sphere.index_count, 0, 0..1);
                        }
                    }
                }
            }

            
            renderer_state.gizmo.update_config(transform_gizmo::GizmoConfig {
                view_matrix: crate::core::SimpleCamera::to_row_major_f64(&camera.get_view()),
                projection_matrix: crate::core::SimpleCamera::to_row_major_f64(&camera.get_projection()),
                viewport: transform_gizmo::Rect {
                    min: (0.0, 0.0).into(),
                    max: (camera.viewport.window_size.width as f32, camera.viewport.window_size.height as f32).into(),
                },
                ..renderer_state.gizmo.config().clone()
            });


// DEBUG:
// let gizmo_draw_data = renderer_state.gizmo.draw();
// if !gizmo_draw_data.vertices.is_empty() {
    
// // let player_world_pos = DVec3::new(0.0, 0.0, 0.0); // or get from your transform

// // Manually calculate what screen position (0,0,0) should be at
// let viewx = DMat4::from(renderer_state.gizmo.config().view_matrix);
// let proj = DMat4::from(renderer_state.gizmo.config().projection_matrix);
// let vp = proj * viewx;

// // Project to clip space
// let clip = vp * DVec4::new(0.0, 0.0, 0.0, 1.0);
// let ndc = clip.xyz() / clip.w;

// // Convert to screen space (matching transform-gizmo's logic)
// let viewport = renderer_state.gizmo.config().viewport;
// let screen_x = (ndc.x + 1.0) * 0.5 * viewport.width() as f64;
// let screen_y = (1.0 - ndc.y) * 0.5 * viewport.height() as f64;

// println!("=== GIZMO POSITION DEBUG ===");
// println!("Player world position: (0, 0, 0)");
// println!("View matrix first row: {:?}", [viewx.x_axis.x, viewx.x_axis.y, viewx.x_axis.z, viewx.x_axis.w]);
// println!("Projection matrix first row: {:?}", [proj.x_axis.x, proj.x_axis.y, proj.x_axis.z, proj.x_axis.w]);
// println!("Clip space: {:?}", clip);
// println!("NDC: {:?}", ndc);
// println!("Screen position: ({:.1}, {:.1})", screen_x, screen_y);
// println!("Viewport: min=({:.1}, {:.1}), max=({:.1}, {:.1})", 
//     viewport.min.x, viewport.min.y, viewport.max.x, viewport.max.y);

//     println!("First gizmo vertex: ({:.1}, {:.1})", 
//         gizmo_draw_data.vertices[0][0], 
//         gizmo_draw_data.vertices[0][1]);
    
//     // Calculate center of all vertices to see where gizmo thinks it is
//     let mut sum_x = 0.0;
//     let mut sum_y = 0.0;
//     for v in &gizmo_draw_data.vertices {
//         sum_x += v[0];
//         sum_y += v[1];
//     }
//     let center_x = sum_x / gizmo_draw_data.vertices.len() as f32;
//     let center_y = sum_y / gizmo_draw_data.vertices.len() as f32;
//     println!("Gizmo vertex center: ({:.1}, {:.1})", center_x, center_y);
//     println!("===========================");
// }


            let gizmo_draw_data = renderer_state.gizmo.draw();
            if !game_mode && !gizmo_draw_data.vertices.is_empty() {
                // DEBUG: Print first few vertices and viewport info
                // println!("=== GIZMO DEBUG ===");
                // println!("Viewport: {:?}", renderer_state.gizmo.config().viewport);
                // println!("Window size: {}x{}", camera.viewport.window_size.width, camera.viewport.window_size.height);
                // println!("Vertex count: {}", gizmo_draw_data.vertices.len());
                // println!("First 5 vertices:");
                // for (i, v) in gizmo_draw_data.vertices.iter().take(5).enumerate() {
                //     println!("  [{}]: ({}, {})", i, v[0], v[1]);
                // }
                // println!("Index count: {}", gizmo_draw_data.indices.len());
                // println!("==================");

                // println!("Rendering gizmo");
                let gizmo_vertex_buffer =
                    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Gizmo Vertex Buffer"),
                        contents: bytemuck::cast_slice(&gizmo_draw_data.vertices),
                        usage: wgpu::BufferUsages::VERTEX,
                    });

                let gizmo_color_buffer =
                    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Gizmo Color Buffer"),
                        contents: bytemuck::cast_slice(&gizmo_draw_data.colors),
                        usage: wgpu::BufferUsages::VERTEX,
                    });

                let gizmo_index_buffer =
                    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Gizmo Index Buffer"),
                        contents: bytemuck::cast_slice(&gizmo_draw_data.indices),
                        usage: wgpu::BufferUsages::INDEX,
                    });

            let mut gizmo_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Gizmo Pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });

                gizmo_pass.set_pipeline(self.gizmo_pipeline.as_ref().unwrap());
                gizmo_pass.set_bind_group(0, window_size_bind_group, &[]);
                gizmo_pass.set_vertex_buffer(0, gizmo_vertex_buffer.slice(..));
                gizmo_pass.set_vertex_buffer(1, gizmo_color_buffer.slice(..));
                gizmo_pass.set_index_buffer(gizmo_index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                gizmo_pass.draw_indexed(0..gizmo_draw_data.indices.len() as u32, 0, 0..1);
            }

            // UI Render Pass
            {
                if let Some(ui_pipeline) = self.ui_pipeline.as_ref() {
                    let camera_binding = editor.camera_binding.as_ref().unwrap();
                    let window_size_bind_group = self
                        .window_size_bind_group
                        .as_ref()
                        .expect("Couldn't get window size bind group");

                    let mut ui_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("UI Pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Load,
                                store: wgpu::StoreOp::Store,
                            },
                            depth_slice: None,
                        })],
                        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                            view: &depth_view,
                            depth_ops: Some(wgpu::Operations {
                                load: wgpu::LoadOp::Load,
                                store: wgpu::StoreOp::Store,
                            }),
                            stencil_ops: None,
                        }),
                        timestamp_writes: None,
                        occlusion_query_set: None,
                    });

                    ui_pipeline.render(
                        &mut ui_pass,
                        editor,
                        &camera_binding.bind_group,
                        window_size_bind_group,
                        queue,
                    );
                }
            }

            if self.frame_buffer.is_some() {
                let frame_buffer = self
                    .frame_buffer
                    .as_ref()
                    .expect("Couldn't get frame buffer");
                frame_buffer.capture_frame(device, queue, texture, &mut encoder);
            }

            // Update Dialogue UI
            dialogue_ui::update_dialogue_ui(editor, device, queue);
            quest_ui::update_quest_ui(editor, device, queue);

            let command_buffer = encoder.finish();
            queue.submit(std::iter::once(command_buffer));
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub fn render_display_frame(&mut self, game_mode: bool) {}

    #[cfg(target_os = "windows")]
    pub fn render_display_frame(&mut self, gui: &mut Gui, window: &Window, game_mode: bool) {
        let gpu_resources = self.gpu_resources.as_ref().expect("Couldn't get GPU Resources").clone();
    
        let output = gpu_resources.surface.as_ref().unwrap()
            .get_current_texture()
            .expect("Failed to get current swap chain texture");
    
        let view = output.texture.create_view(&wgpu::TextureViewDescriptor::default());
    
        self.render_frame(Some(&view), 0.0, game_mode);
    
        if !game_mode {
            let mut encoder = gpu_resources.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("egui encoder"),
            });
            
            let raw_input = gui.state.take_egui_input(&window);
            let full_output = gui.ctx.run(raw_input, |ctx| {
                self.ui(ctx);
            });
        
            gui.state.handle_platform_output(&window, full_output.platform_output);
        
            let tris = gui.ctx.tessellate(full_output.shapes, full_output.pixels_per_point);
            let screen_descriptor = egui_wgpu::ScreenDescriptor {
                size_in_pixels: [output.texture.width(), output.texture.height()],
                pixels_per_point: window.scale_factor() as f32,
            };
        
            for (id, image_delta) in &full_output.textures_delta.set {
                gui.renderer.update_texture(&gpu_resources.device, &gpu_resources.queue, *id, image_delta);
            }
            
            gui.renderer.update_buffers(&gpu_resources.device, &gpu_resources.queue, &mut encoder, &tris, &screen_descriptor);
        
            {
                let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("egui"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });

                gui.renderer.render(&mut rpass.forget_lifetime(), &tris, &screen_descriptor);
            }
        
            // drop(rpass);
        
            gpu_resources.queue.submit(Some(encoder.finish()));
        }

        output.present();
    }
    


    fn ui(&mut self, ctx: &egui::Context) {
        let mut context = UiContext {
            export_editor: &mut self.export_editor,
            new_project_name: &mut self.new_project_name,
            projects: &mut self.projects,
            selected_component_id: &mut self.selected_component_id,
            chat: &mut self.chat,
            gpu_resources: &self.gpu_resources,
        };

        let mut viewer = PipelineTabViewer { context };

        egui::SidePanel::right("dock_sidebar")
            .resizable(true)
            .default_width(300.0)
            .show(ctx, |ui| {
                DockArea::new(&mut self.dock_state)
                    .style(Style::from_egui(ctx.style().as_ref()))
                    .show_inside(ui, &mut viewer);
            });
    }
}
