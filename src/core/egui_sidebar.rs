use crate::core::pipeline::{EntropyPipeline, Workspace};
use crate::core::skinned_pipeline::SkinnedPipeline;
use crate::core::chat::{Chat, ChatMessage, ChatSession, ToolCall};
use crate::game_behaviors::stateful::{BehaviorConfig, CombatType};
use crate::handlers::{handle_add_collectable, handle_add_npc, handle_add_water_plane};
use crate::helpers::landscapes::generate_landscape_data;
use crate::helpers::saved_data::{self, AppExperience, AttackStats, CollectableProperties, CollectableType, LightProperties, NPCProperties};
use crate::helpers::utilities::{save_heightmap, save_rhai_script};
use crate::procedural_heightmaps::heightmap_generation::{FalloffType, FeatureType, HeightmapGenerator, TerrainFeature};
use crate::vector_animations::animations::ObjectType;
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
use crate::helpers::load_project::{load_game_project, load_video_project};
use crate::deno::script_engine::{ComponentChanges, DenoEngine};
use crate::game_ui::dialogue_ui;
use crate::game_ui::quest_ui;
use crate::procedural_particles::particle_system::{ParticleSystem, ParticleUniforms};
use crate::helpers::utilities::update_project_state;

#[cfg(target_arch = "wasm32")]
use web_sys::HtmlCanvasElement;
use wgpu::{Limits, RenderPipeline, util::DeviceExt};
use bytemuck::{Pod, Zeroable}; // For procedural sky uniform

#[cfg(target_os = "windows")]
use winit::window::Window;

#[cfg(target_os = "windows")]
use egui;
use egui_dock::{DockArea, DockState, NodeIndex, Style, TabViewer};
use rfd::FileDialog;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Tab {
    Viewport,
    Projects,
    Components,
    Properties,
    WryChat, // full
    Chat, //  egui
    AssetLibrary,
    Controls,
    Writing,
    Addons,
    VideoTimeline,
    Animations,
    Research,
    Publish,
    Grammar,
    Manage,
    Citations,
    AddonTab { id: String, label: String },
    ScriptEditor { path: std::path::PathBuf },
}

#[cfg(target_os = "windows")]
use crate::startup::Gui;

pub struct UiContext<'a> {
    pub export_editor: &'a mut Option<Editor>,
    pub new_project_name: &'a mut String,
    pub projects: &'a mut Vec<(String, String)>,
    pub selected_component_id: &'a mut Option<String>,
    pub chat: &'a mut Chat,
    pub video_timeline_ui: &'a mut crate::core::video_timeline_ui::VideoTimeline,
    pub gpu_resources: &'a Option<Arc<GpuResources>>,
    pub current_app: AppExperience,
    pub next_workspace: &'a mut Option<Workspace>,
}

pub struct PipelineTabViewer<'a> {
    pub context: UiContext<'a>,
}


fn apply_keyframes_to_selected(editor: &mut Editor, property_name: &str, keyframes: Vec<crate::vector_animations::animations::UIKeyframe>) {
    if let Some(selected) = &editor.selected_object {
        if let Some(stunts_state) = &mut editor.stunts_state {
            let paths = stunts_state.object_motion_paths.get_or_insert_with(Vec::new);
            let object_id_str = selected.object_id.to_string();
            
            if let Some(path) = paths.iter_mut().find(|p| p.polygon_id == object_id_str) {
                if let Some(prop) = path.properties.iter_mut().find(|p| p.name == property_name) {
                    prop.keyframes = keyframes;
                } else {
                    path.properties.push(crate::vector_animations::animations::AnimationProperty {
                        name: property_name.to_string(),
                        keyframes,
                        ..Default::default()
                    });
                }
            } else {
                paths.push(crate::vector_animations::animations::AnimationData {
                    id: Uuid::new_v4().to_string(),
                    polygon_id: object_id_str,
                    properties: vec![crate::vector_animations::animations::AnimationProperty {
                        name: property_name.to_string(),
                        keyframes,
                        ..Default::default()
                    }],
                    ..Default::default()
                });
            }

            if let Some(project_id) = &stunts_state.id {
                let _ = crate::helpers::utilities::update_project_state(project_id, stunts_state);
            }
        }
    }
}

impl<'a> TabViewer for PipelineTabViewer<'a> {
    type Tab = Tab;

    fn title(&mut self, tab: &mut Self::Tab) -> egui::WidgetText {
        match tab {
            Tab::AddonTab { label, .. } => label.as_str().into(),
            Tab::ScriptEditor { path } => {
                let filename = path.file_name().and_then(|f| f.to_str()).unwrap_or("Script");
                filename.into()
            }
            _ => format!("{:?}", tab).into(),
        }
    }

    fn ui(&mut self, ui: &mut egui::Ui, tab: &mut Self::Tab) {
        let editor = self.context.export_editor.as_mut().unwrap();
        
        // Poll Webview IPC
        if let Some(rx) = &editor.webview_ipc_rx {
            while let Ok(msg) = rx.try_recv() {
                // println!("Incoming msg: {:?}", msg);

                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&msg) {
                    println!("Incoming json: {:?}", json);

                    if json["type"] == "analysis" {
                        let data = &json["data"];
                        let sophia = &mut editor.sophia_app_state;
                        
                        if let Some(subjects) = data["subjects"].as_array() {
                            sophia.subjects = subjects.iter().map(|s| s.as_str().unwrap_or_default().to_string()).collect();
                        }
                        if let Some(keywords) = data["keywords"].as_array() {
                            sophia.keywords = keywords.iter().map(|s| s.as_str().unwrap_or_default().to_string()).collect();
                        }
                        if let Some(grammar) = data["grammar"].as_array() {
                            sophia.grammar_issues = grammar.iter().map(|g| {
                                crate::helpers::saved_data::GrammarIssue {
                                    original: g["original"].as_str().unwrap_or_default().to_string(),
                                    suggestion: g["suggestion"].as_str().unwrap_or_default().to_string(),
                                    explanation: g["explanation"].as_str().unwrap_or_default().to_string(),
                                    start_index: g["startIndex"].as_u64().unwrap_or(0) as usize,
                                    end_index: g["endIndex"].as_u64().unwrap_or(0) as usize,
                                }
                            }).collect();
                        }
                    } else if json["type"] == "fetch_tools" {
                        let tools = editor.addon_engine.get_registered_tools();
                        if let Ok(tools_json) = serde_json::to_string(&tools) {
                            let script = format!("window.onToolsFetched({})", tools_json);
                            editor.pending_webview_scripts.push(script);
                        }
                    } else if json["type"] == "call_tool" {
                        let tool_name = json["name"].as_str().unwrap_or_default();
                        let call_id = json["callId"].as_str().unwrap_or_default();
                        let arguments = json["arguments"].as_str().unwrap_or("{}");
                        
                        if let Some(result) = editor.addon_engine.call_tool(tool_name, arguments) {
                            let script = format!("window.onToolResult('{}', '{}', {})", tool_name, call_id, result);
                            editor.pending_webview_scripts.push(script);
                        }
                    }
                }
            }
        }

        match tab {
            Tab::Viewport => {
                let editor = self.context.export_editor.as_mut().unwrap();
                let rect = ui.available_rect_before_wrap();
                editor.viewport_tab_rect = Some([rect.min.x, rect.min.y, rect.width(), rect.height()]);
                editor.is_viewport_visible = true;
            }
            Tab::WryChat => {
                let editor = self.context.export_editor.as_mut().unwrap();
                let rect = ui.available_rect_before_wrap();
                editor.wry_webview_bounds = Some([rect.min.x, rect.min.y, rect.width(), rect.height()]);
            }
            Tab::Projects => {
                let editor = self.context.export_editor.as_mut().unwrap();

                ui.heading("Your Projects");

                // Games
                if self.context.current_app == AppExperience::OpenWorldStudio && editor.world_state.is_none() {
                    ui.label("Create New Project");
                    ui.text_edit_singleline(self.context.new_project_name);
                    if ui.button("Create New Project").clicked() {
                        if !self.context.new_project_name.is_empty() {
                            match utilities::create_project_state(self.context.new_project_name, self.context.current_app) {
                                Ok(new_state) => {
                                    editor.world_state = Some(new_state);
                                    *self.context.next_workspace = Some(Workspace::Addon("Game Composer".to_string()));
                                }
                                Err(e) => {
                                    println!("Failed to create project: {}", e);
                                }
                            }
                        }
                    }
        
                    ui.separator();
                    ui.label("Existing Projects");
        
                    self.context.projects.clear();
                    if let Ok(registry) = utilities::load_project_registry() {
                        for project in registry.projects {
                            if project.app == self.context.current_app {
                                self.context.projects.push((project.project_name, project.project_id));
                            }
                        }
                    }
        
                    for (project_name, project_id) in self.context.projects.iter() {
                        if ui.button(project_name).clicked() {
                            pollster::block_on(load_game_project(editor, project_id));
                            *self.context.next_workspace = Some(Workspace::Addon("Game Composer".to_string()));
                        }
                    }
                } else if self.context.current_app == AppExperience::OpenWorldStudio {
                    ui.label("Project Loaded");
                    if let Some(world_state) = &editor.world_state {
                         ui.label(format!("Project: {}", world_state.project_name));
                    }
                    if ui.button("Close Project").clicked() {
                         editor.world_state = None;
                    }
                }

                // Videos
                if self.context.current_app == AppExperience::Stunts && editor.stunts_state.is_none() {
                    ui.label("Create New Project");
                    ui.text_edit_singleline(self.context.new_project_name);
                    if ui.button("Create New Project").clicked() {
                        if !self.context.new_project_name.is_empty() {
                            match utilities::create_project_state(self.context.new_project_name, self.context.current_app) {
                                Ok(new_state) => {
                                    editor.stunts_state = Some(new_state);
                                    editor.sync_stunts_objects();
                                    *self.context.next_workspace = Some(Workspace::Addon("Game Composer".to_string()));
                                }
                                Err(e) => {
                                    println!("Failed to create project: {}", e);
                                }
                            }
                        }
                    }
        
                    ui.separator();
                    ui.label("Existing Projects");
        
                    self.context.projects.clear();
                    if let Ok(registry) = utilities::load_project_registry() {
                        for project in registry.projects {
                            if project.app == self.context.current_app {
                                self.context.projects.push((project.project_name, project.project_id));
                            }
                        }
                    }
        
                    for (project_name, project_id) in self.context.projects.iter() {
                        if ui.button(project_name).clicked() {
                            load_video_project(editor, project_id);
                            editor.sync_stunts_objects();
                            *self.context.next_workspace = Some(Workspace::Addon("Game Composer".to_string()));
                        }
                    }
                } else if self.context.current_app == AppExperience::Stunts {
                    ui.label("Project Loaded");
                    if let Some(stunts_state) = &editor.stunts_state {
                         ui.label(format!("Project: {}", stunts_state.project_name));
                    }
                    if ui.button("Close Project").clicked() {
                         editor.stunts_state = None;
                    }
                }

                // Writing
                if self.context.current_app == AppExperience::Sophia && editor.sophia_state.is_none() {
                    ui.label("Create New Project");
                    ui.text_edit_singleline(self.context.new_project_name);
                    if ui.button("Create New Project").clicked() {
                        if !self.context.new_project_name.is_empty() {
                            match utilities::create_project_state(self.context.new_project_name, self.context.current_app) {
                                Ok(new_state) => {
                                    editor.sophia_state = Some(new_state);
                                    *self.context.next_workspace = Some(Workspace::Addon("Game Composer".to_string()));
                                }
                                Err(e) => {
                                    println!("Failed to create project: {}", e);
                                }
                            }
                        }
                    }
        
                    ui.separator();
                    ui.label("Existing Projects");
        
                    self.context.projects.clear();
                    if let Ok(registry) = utilities::load_project_registry() {
                        for project in registry.projects {
                            if project.app == self.context.current_app {
                                self.context.projects.push((project.project_name, project.project_id));
                            }
                        }
                    }
        
                    for (project_name, project_id) in self.context.projects.iter() {
                        if ui.button(project_name).clicked() {
                            // pollster::block_on(load_writing_project(editor, project_id));
                            *self.context.next_workspace = Some(Workspace::Addon("Game Composer".to_string()));
                        }
                    }
                } else if self.context.current_app == AppExperience::Sophia {
                    ui.label("Project Loaded");
                    if let Some(sophia_state) = &editor.sophia_state {
                         ui.label(format!("Project: {}", sophia_state.project_name));
                    }
                    if ui.button("Close Project").clicked() {
                         editor.sophia_state = None;
                    }
                }
            }
            Tab::Components => {
                let editor = self.context.export_editor.as_mut().unwrap();
                 if let Some(world_state) = &mut editor.world_state {
                    if let Some(levels) = &mut world_state.levels {
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
                 
                 // Handle Stunts Objects
                 if let Some(selected) = editor.selected_object.clone() {
                    ui.heading(format!("Selected: {:?}", selected.object_type));
                    
                    let mut updated = false;
                    let gpu_resources = self.context.gpu_resources.as_ref().unwrap();

                    match selected.object_type {
                        ObjectType::Polygon => {
                            if let Some(poly) = editor.stunts_polygons.iter_mut().find(|p| p.id == selected.object_id) {
                                ui.label("Name");
                                ui.text_edit_singleline(&mut poly.name);
                                
                                ui.label("Position");
                                if ui.horizontal(|ui| {
                                    ui.add(egui::DragValue::new(&mut poly.transform.position.x)).changed() |
                                    ui.add(egui::DragValue::new(&mut poly.transform.position.y)).changed()
                                }).inner {
                                    poly.transform.update_uniform_buffer(&gpu_resources.queue);
                                    updated = true;
                                }

                                ui.label("Dimensions");
                                if ui.horizontal(|ui| {
                                    ui.add(egui::DragValue::new(&mut poly.dimensions.0).prefix("W: ")).changed() |
                                    ui.add(egui::DragValue::new(&mut poly.dimensions.1).prefix("H: ")).changed()
                                }).inner {
                                    // Update polygon data based on new dimensions
                                    poly.update_data_from_dimensions(
                                        &editor.camera.as_ref().unwrap().viewport.window_size,
                                        &gpu_resources.device,
                                        &gpu_resources.queue,
                                        editor.ui_model_bind_group_layout.as_ref().unwrap(),
                                        poly.dimensions,
                                        editor.camera.as_ref().unwrap()
                                    );
                                    updated = true;
                                }

                                ui.label("Fill Color");
                                if ui.color_edit_button_rgba_unmultiplied(&mut [
                                    (poly.fill[0] * 255.0),
                                    (poly.fill[1] * 255.0),
                                    (poly.fill[2] * 255.0),
                                    (poly.fill[3] * 255.0),
                                ]).changed() {
                                    // Color editing logic here if needed
                                }

                                ui.separator();
                                ui.label("Layering");
                                ui.horizontal(|ui| {
                                    if ui.button("Bring Forward").clicked() {
                                        poly.layer += 1;
                                        updated = true;
                                    }
                                    if ui.button("Send Backward").clicked() {
                                        poly.layer = (poly.layer - 1).max(0);
                                        updated = true;
                                    }
                                });
                            }
                        }
                        ObjectType::TextItem => {
                            if let Some(text) = editor.stunts_textboxes.iter_mut().find(|t| t.id == selected.object_id) {
                                ui.label("Text");
                                if ui.text_edit_multiline(&mut text.text).changed() {
                                    text.render_text(&gpu_resources.device, &gpu_resources.queue);
                                    updated = true;
                                }

                                ui.label("Font Size");
                                if ui.add(egui::DragValue::new(&mut text.font_size)).changed() {
                                    text.render_text(&gpu_resources.device, &gpu_resources.queue);
                                    updated = true;
                                }

                                ui.label("Position");
                                if ui.horizontal(|ui| {
                                    ui.add(egui::DragValue::new(&mut text.transform.position.x)).changed() |
                                    ui.add(egui::DragValue::new(&mut text.transform.position.y)).changed()
                                }).inner {
                                    text.transform.update_uniform_buffer(&gpu_resources.queue);
                                    // Also update background
                                    text.background_polygon.transform.position.x = text.transform.position.x;
                                    text.background_polygon.transform.position.y = text.transform.position.y;
                                    text.background_polygon.transform.update_uniform_buffer(&gpu_resources.queue);
                                    updated = true;
                                }

                                ui.separator();
                                ui.label("Layering");
                                ui.horizontal(|ui| {
                                    if ui.button("Bring Forward").clicked() {
                                        text.update_layer(text.layer + 1);
                                        updated = true;
                                    }
                                    if ui.button("Send Backward").clicked() {
                                        text.update_layer((text.layer - 1).max(0));
                                        updated = true;
                                    }
                                });
                            }
                        }
                        ObjectType::ImageItem => {
                            if let Some(img) = editor.stunts_images.iter_mut().find(|i| i.id == selected.object_id.to_string()) {
                                ui.label(format!("Path: {}", img.path));
                                
                                ui.label("Position");
                                if ui.horizontal(|ui| {
                                    ui.add(egui::DragValue::new(&mut img.transform.position.x)).changed() |
                                    ui.add(egui::DragValue::new(&mut img.transform.position.y)).changed()
                                }).inner {
                                    img.transform.update_uniform_buffer(&gpu_resources.queue);
                                    updated = true;
                                }

                                ui.label("Scale");
                                if ui.horizontal(|ui| {
                                    ui.add(egui::DragValue::new(&mut img.transform.scale.x).prefix("X: ")).changed() |
                                    ui.add(egui::DragValue::new(&mut img.transform.scale.y).prefix("Y: ")).changed()
                                }).inner {
                                    img.transform.update_uniform_buffer(&gpu_resources.queue);
                                    updated = true;
                                }

                                ui.separator();
                                ui.label("Layering");
                                ui.horizontal(|ui| {
                                    if ui.button("Bring Forward").clicked() {
                                        img.layer += 1;
                                        updated = true;
                                    }
                                    if ui.button("Send Backward").clicked() {
                                        img.layer = (img.layer - 1).max(0);
                                        updated = true;
                                    }
                                });
                            }
                        }
                        ObjectType::VideoItem => {
                            if let Some(vid) = editor.stunts_videos.iter_mut().find(|v| v.id == selected.object_id.to_string()) {
                                ui.label(format!("Video: {}", vid.name));
                                
                                ui.label("Position");
                                if ui.horizontal(|ui| {
                                    ui.add(egui::DragValue::new(&mut vid.transform.position.x)).changed() |
                                    ui.add(egui::DragValue::new(&mut vid.transform.position.y)).changed()
                                }).inner {
                                    vid.transform.update_uniform_buffer(&gpu_resources.queue);
                                    updated = true;
                                }

                                ui.label("Scale");
                                if ui.horizontal(|ui| {
                                    ui.add(egui::DragValue::new(&mut vid.transform.scale.x).prefix("X: ")).changed() |
                                    ui.add(egui::DragValue::new(&mut vid.transform.scale.y).prefix("Y: ")).changed()
                                }).inner {
                                    vid.transform.update_uniform_buffer(&gpu_resources.queue);
                                    updated = true;
                                }

                                ui.separator();
                                ui.label("Layering");
                                ui.horizontal(|ui| {
                                    if ui.button("Bring Forward").clicked() {
                                        vid.layer += 1;
                                        updated = true;
                                    }
                                    if ui.button("Send Backward").clicked() {
                                        vid.layer = (vid.layer - 1).max(0);
                                        updated = true;
                                    }
                                });
                            }
                        }
                    }

                    if updated {
                        if let Some(stunts_state) = editor.stunts_state.as_mut() {
                            // Sync state back to saved data
                            match selected.object_type {
                                ObjectType::Polygon => {
                                    if let Some(poly) = editor.stunts_polygons.iter().find(|p| p.id == selected.object_id) {
                                        if let Some(saved_polys) = &mut stunts_state.active_polygons {
                                            if let Some(saved) = saved_polys.iter_mut().find(|p| p.id == poly.id.to_string()) {
                                                saved.position.x = poly.transform.position.x as i32;
                                                saved.position.y = poly.transform.position.y as i32;
                                                saved.dimensions = (poly.dimensions.0 as i32, poly.dimensions.1 as i32);
                                                saved.name = poly.name.clone();
                                                saved.layer = poly.layer;
                                            }
                                        }
                                    }
                                }
                                ObjectType::TextItem => {
                                    if let Some(text) = editor.stunts_textboxes.iter().find(|t| t.id == selected.object_id) {
                                        if let Some(saved_texts) = &mut stunts_state.active_text_items {
                                            if let Some(saved) = saved_texts.iter_mut().find(|t| t.id == text.id.to_string()) {
                                                saved.position.x = text.transform.position.x as i32;
                                                saved.position.y = text.transform.position.y as i32;
                                                saved.text = text.text.clone();
                                                saved.font_size = text.font_size;
                                                saved.layer = text.layer;
                                            }
                                        }
                                    }
                                }
                                ObjectType::ImageItem => {
                                    if let Some(img) = editor.stunts_images.iter().find(|i| i.id == selected.object_id.to_string()) {
                                        if let Some(saved_imgs) = &mut stunts_state.active_image_items {
                                            if let Some(saved) = saved_imgs.iter_mut().find(|i| i.id == img.id) {
                                                saved.position.x = img.transform.position.x as i32;
                                                saved.position.y = img.transform.position.y as i32;
                                                saved.dimensions = (img.transform.scale.x as u32, img.transform.scale.y as u32);
                                                saved.layer = img.layer;
                                            }
                                        }
                                    }
                                }
                                ObjectType::VideoItem => {
                                    if let Some(vid) = editor.stunts_videos.iter().find(|v| v.id == selected.object_id.to_string()) {
                                        if let Some(saved_vids) = &mut stunts_state.active_video_items {
                                            if let Some(saved) = saved_vids.iter_mut().find(|v| v.id == vid.id) {
                                                saved.position.x = vid.transform.position.x as i32;
                                                saved.position.y = vid.transform.position.y as i32;
                                                saved.dimensions = (vid.transform.scale.x as u32, vid.transform.scale.y as u32);
                                                saved.layer = vid.layer;
                                            }
                                        }
                                    }
                                }
                            }
                            if let Some(project_id) = &stunts_state.id {
                                let _ = utilities::update_project_state(project_id, stunts_state);
                            }
                        }
                    }

                    ui.separator();
                    if ui.button("Deselect").clicked() {
                        editor.selected_object = None;
                    }

                 } else if let Some(selected_component_id) = self.context.selected_component_id {
                    // Use disjoint borrow pattern to access world_state and renderer_state simultaneously
                    let Editor { world_state, renderer_state, camera, .. } = editor;

                    if let Some(world_state) = world_state {
                        let project_id = world_state.id.as_ref().expect("Couldn't get project id").clone();
                        if let Some(levels) = &mut world_state.levels {
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
                                                let mut changed = false;
                                                ui.label("Position");
                                                if ui.horizontal(|ui| {
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.position[0]).speed(0.1)).changed() ||
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.position[1]).speed(0.1)).changed() ||
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.position[2]).speed(0.1)).changed()
                                                }).inner {
                                                    changed = true;
                                                }
                                                
                                                ui.label("Rotation");
                                                if ui.horizontal(|ui| {
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.rotation[0]).speed(0.1)).changed() ||
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.rotation[1]).speed(0.1)).changed() ||
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.rotation[2]).speed(0.1)).changed()
                                                }).inner {
                                                     changed = true;
                                                }

                                                ui.label("Scale");
                                                if ui.horizontal(|ui| {
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.scale[0]).speed(0.1)).changed() ||
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.scale[1]).speed(0.1)).changed() ||
                                                    ui.add(egui::DragValue::new(&mut component.generic_properties.scale[2]).speed(0.1)).changed()
                                                }).inner {
                                                     changed = true;
                                                }

                                                if changed {
                                                     if let Some(renderer_state) = renderer_state {
                                                        // Update by re-importing the model to handle complex hierarchies correctly
                                                        if let Some(pos) = renderer_state.models.iter().position(|m| &m.id == selected_component_id) {
                                                            let old_model = renderer_state.models.remove(pos);
                                                            for mesh in old_model.meshes {
                                                                if let Some(handle) = mesh.collider_handle {
                                                                    renderer_state.collider_set.remove(handle, &mut renderer_state.island_manager, &mut renderer_state.rigid_body_set, true);
                                                                }
                                                                if let Some(handle) = mesh.rigid_body_handle {
                                                                    renderer_state.rigid_body_set.remove(
                                                                        handle, 
                                                                        &mut renderer_state.island_manager, 
                                                                        &mut renderer_state.collider_set, 
                                                                        &mut renderer_state.impulse_joint_set,
                                                                        &mut renderer_state.multibody_joint_set, 
                                                                        true
                                                                    );
                                                                }
                                                            }
                                                        }

                                                        let model_asset_id = component.asset_id.clone();
                                                        if let Some(model_file) = world_state.models.iter().find(|m| m.id == model_asset_id) {
                                                            let model_filename = model_file.fileName.clone();
                                                            let isometry = Isometry3::from_parts(
                                                                Translation3::from(Vector3::from(component.generic_properties.position)),
                                                                UnitQuaternion::from_euler_angles(
                                                                    component.generic_properties.rotation[0].to_radians(),
                                                                    component.generic_properties.rotation[1].to_radians(),
                                                                    component.generic_properties.rotation[2].to_radians(),
                                                                )
                                                            );
                                                            let scale = Vector3::from(component.generic_properties.scale);
                                                            
                                                            if let (Some(gpu), Some(camera)) = (&self.context.gpu_resources, &camera) {
                                                                pollster::block_on(crate::handlers::handle_add_model(
                                                                    renderer_state,
                                                                    &gpu.device,
                                                                    &gpu.queue,
                                                                    project_id.clone(),
                                                                    model_asset_id,
                                                                    selected_component_id.clone(),
                                                                    model_filename,
                                                                    isometry,
                                                                    scale,
                                                                    camera,
                                                                    component.script_state.clone(),
                                                                ));
                                                            }
                                                        }
                                                    }
                                                    utilities::update_project_state_component(&project_id, component).expect("Failed to update project state");
                                                }

                                                ui.separator();
                                                ui.heading("Script");
                                                
                                                let scripts_dir = utilities::get_scripts_dir(&project_id);
                                                if let Some(scripts_dir) = scripts_dir {
                                                    let mut scripts = Vec::new();
                                                    if let Ok(entries) = std::fs::read_dir(&scripts_dir) {
                                                        for entry in entries.flatten() {
                                                            if entry.path().is_file() {
                                                                if let Some(name) = entry.file_name().to_str() {
                                                                    if name.ends_with(".js") {
                                                                        scripts.push(name.to_string());
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }

                                                    let mut current_script = component.js_script_path.clone().unwrap_or_default();
                                                    egui::ComboBox::from_label("Select Script")
                                                        .selected_text(if current_script.is_empty() { "None" } else { &current_script })
                                                        .show_ui(ui, |ui| {
                                                            ui.selectable_value(&mut current_script, "".to_string(), "None");
                                                            for script in scripts {
                                                                ui.selectable_value(&mut current_script, script.clone(), script);
                                                            }
                                                        });

                                                    if ui.button("Create New Script").clicked() {
                                                        let new_script_name = format!("script_{}.js", Uuid::new_v4().to_string()[0..8].to_string());
                                                        let full_path = scripts_dir.join(&new_script_name);
                                                        let default_content = "export function on_update(player, system, state) {\n    return state;\n}\n";
                                                        if let Ok(_) = std::fs::write(&full_path, default_content) {
                                                            component.js_script_path = Some(new_script_name.clone());
                                                            utilities::update_project_state_component(&project_id, component).expect("Failed to update project state");
                                                            
                                                            editor.script_editors.entry(full_path.clone())
                                                                .or_insert_with(|| crate::core::script_editor::ScriptEditor::new(full_path.clone()));
                                                            editor.pending_script_tabs.push(full_path);
                                                        }
                                                    }

                                                    if current_script != component.js_script_path.clone().unwrap_or_default() {
                                                        component.js_script_path = if current_script.is_empty() { None } else { Some(current_script) };
                                                        utilities::update_project_state_component(&project_id, component).expect("Failed to update project state");
                                                    }

                                                    if let Some(script_path) = &component.js_script_path {
                                                        if ui.button("Edit Script").clicked() {
                                                            let full_path = scripts_dir.join(script_path);
                                                            editor.script_editors.entry(full_path.clone())
                                                                .or_insert_with(|| crate::core::script_editor::ScriptEditor::new(full_path.clone()));
                                                            
                                                            editor.pending_script_tabs.push(full_path);
                                                        }
                                                    }
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
            Tab::AssetLibrary => {
                let editor = self.context.export_editor.as_mut().unwrap();
                let mut world_state_opt = editor.world_state.clone(); 
                
                if let Some(world_state) = &mut world_state_opt {
                    let project_id = world_state.id.clone().unwrap_or_default();
                    
                    egui::CollapsingHeader::new("Models").show(ui, |ui| {
                        for model in &world_state.models {
                            ui.label(&model.fileName);
                        }
                        if ui.button("Add Model").clicked() {
                            if let Some(path) = FileDialog::new()
                                .add_filter("GLB/GLTF", &["glb", "gltf"])
                                .pick_file() 
                            {
                                if let Some(models_dir) = utilities::get_models_dir(&project_id) {
                                    let filename = path.file_name().unwrap().to_string_lossy().to_string();
                                    let dest_path = models_dir.join(&filename);
                                    if let Ok(_) = fs::copy(&path, &dest_path) {
                                        let new_file = saved_data::File {
                                            id: Uuid::new_v4().to_string(),
                                            fileName: filename,
                                            ..Default::default()
                                        };
                                        world_state.models.push(new_file);
                                        // utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                                    }
                                }
                            }
                        }
                    });

                    egui::CollapsingHeader::new("Landscapes").show(ui, |ui| {
                        if world_state.landscapes.is_none() {
                            world_state.landscapes = Some(Vec::new());
                        }
                        let landscapes = world_state.landscapes.as_mut().unwrap();
                        
                        for landscape in landscapes.iter_mut() {
                            ui.collapsing(format!("Landscape: {}", landscape.id), |ui| {
                                ui.label("Heightmap:");
                                if let Some(hm) = &landscape.heightmap {
                                    ui.label(&hm.fileName);
                                } else {
                                    ui.label("None");
                                }
                                if ui.button("Set Heightmap").clicked() {
                                    if let Some(path) = FileDialog::new().add_filter("Image", &["png", "jpg"]).pick_file() {
                                        if let Some(hm_dir) = utilities::get_heightmap_dir(&project_id, &landscape.id) {
                                            let filename = path.file_name().unwrap().to_string_lossy().to_string();
                                            let dest_path = hm_dir.join(&filename);
                                            if let Ok(_) = fs::copy(&path, &dest_path) {
                                                landscape.heightmap = Some(saved_data::File {
                                                    id: Uuid::new_v4().to_string(),
                                                    fileName: filename,
                                                    ..Default::default()
                                                });
                                                // utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                                            }
                                        }
                                    }
                                }
                                
                                ui.label("Rockmap:");
                                if let Some(rm) = &landscape.rockmap {
                                    ui.label(&rm.fileName);
                                } else {
                                    ui.label("None");
                                }
                                if ui.button("Set Rockmap").clicked() {
                                     if let Some(path) = FileDialog::new().add_filter("Image", &["png", "jpg"]).pick_file() {
                                        if let Some(rm_dir) = utilities::get_rockmap_dir(&project_id, &landscape.id) {
                                            let filename = path.file_name().unwrap().to_string_lossy().to_string();
                                            let dest_path = rm_dir.join(&filename);
                                            if let Ok(_) = fs::copy(&path, &dest_path) {
                                                landscape.rockmap = Some(saved_data::File {
                                                    id: Uuid::new_v4().to_string(),
                                                    fileName: filename,
                                                    ..Default::default()
                                                });
                                                // utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                                            }
                                        }
                                     }
                                }

                                ui.label("Soil:");
                                if let Some(s) = &landscape.soil {
                                    ui.label(&s.fileName);
                                } else {
                                    ui.label("None");
                                }
                                if ui.button("Set Soil").clicked() {
                                     if let Some(path) = FileDialog::new().add_filter("Image", &["png", "jpg"]).pick_file() {
                                        if let Some(s_dir) = utilities::get_soilmap_dir(&project_id, &landscape.id) {
                                            let filename = path.file_name().unwrap().to_string_lossy().to_string();
                                            let dest_path = s_dir.join(&filename);
                                            if let Ok(_) = fs::copy(&path, &dest_path) {
                                                landscape.soil = Some(saved_data::File {
                                                    id: Uuid::new_v4().to_string(),
                                                    fileName: filename,
                                                    ..Default::default()
                                                });
                                                // utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                                            }
                                        }
                                     }
                                }
                            });
                        }
                        
                        if ui.button("Add New Landscape Entry").clicked() {
                             landscapes.push(saved_data::LandscapeData {
                                 id: Uuid::new_v4().to_string(),
                                 heightmap: None,
                                 rockmap: None,
                                 soil: None,
                             });
                            //  utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                        }
                    });

                    egui::CollapsingHeader::new("Textures").show(ui, |ui| {
                        if world_state.textures.is_none() {
                            world_state.textures = Some(Vec::new());
                        }
                        let textures = world_state.textures.as_mut().unwrap();

                        for tex in textures {
                            ui.label(&tex.fileName);
                        }

                        if ui.button("Add Texture").clicked() {
                            if let Some(path) = FileDialog::new()
                                .add_filter("Image", &["png", "jpg", "jpeg", "tga", "bmp"])
                                .pick_file() 
                            {
                                if let Some(textures_dir) = utilities::get_textures_dir(&project_id) {
                                    let filename = path.file_name().unwrap().to_string_lossy().to_string();
                                    let dest_path = textures_dir.join(&filename);
                                    if let Ok(_) = fs::copy(&path, &dest_path) {
                                        let new_file = saved_data::File {
                                            id: Uuid::new_v4().to_string(),
                                            fileName: filename,
                                            ..Default::default()
                                        };
                                        if let Some(tex_vec) = world_state.textures.as_mut() {
                                            tex_vec.push(new_file);
                                        }
                                        // utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                                    }
                                }
                            }
                        }
                    });

                    egui::CollapsingHeader::new("PBR Textures").show(ui, |ui| {
                        if world_state.pbr_textures.is_none() {
                            world_state.pbr_textures = Some(Vec::new());
                        }
                        let pbr_textures = world_state.pbr_textures.as_mut().unwrap();

                        for pbr in pbr_textures.iter_mut() {
                             ui.collapsing(format!("PBR: {}", pbr.id), |ui| {
                                 ui.horizontal(|ui| {
                                     ui.label("Diff:");
                                     if let Some(f) = &pbr.diff { ui.label(&f.fileName); } else { ui.label("None"); }
                                     if ui.button("Set").clicked() {
                                         if let Some(path) = FileDialog::new().add_filter("Image", &["png", "jpg"]).pick_file() {
                                             if let Some(tex_dir) = utilities::get_textures_dir(&project_id) {
                                                 let filename = path.file_name().unwrap().to_string_lossy().to_string();
                                                 let dest_path = tex_dir.join(&filename);
                                                  if let Ok(_) = fs::copy(&path, &dest_path) {
                                                     pbr.diff = Some(saved_data::File { id: Uuid::new_v4().to_string(), fileName: filename, ..Default::default() });
                                                    //  utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                                                  }
                                             }
                                         }
                                     }
                                 });
                                 ui.horizontal(|ui| {
                                     ui.label("Normal:");
                                     if let Some(f) = &pbr.nor_gl { ui.label(&f.fileName); } else { ui.label("None"); }
                                     if ui.button("Set").clicked() {
                                         if let Some(path) = FileDialog::new().add_filter("Image", &["png", "jpg"]).pick_file() {
                                             if let Some(tex_dir) = utilities::get_textures_dir(&project_id) {
                                                 let filename = path.file_name().unwrap().to_string_lossy().to_string();
                                                 let dest_path = tex_dir.join(&filename);
                                                  if let Ok(_) = fs::copy(&path, &dest_path) {
                                                     pbr.nor_gl = Some(saved_data::File { id: Uuid::new_v4().to_string(), fileName: filename, ..Default::default() });
                                                    //  utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                                                  }
                                             }
                                         }
                                     }
                                 });
                                 ui.horizontal(|ui| {
                                     ui.label("Rough:");
                                     if let Some(f) = &pbr.rough { ui.label(&f.fileName); } else { ui.label("None"); }
                                     if ui.button("Set").clicked() {
                                         if let Some(path) = FileDialog::new().add_filter("Image", &["png", "jpg"]).pick_file() {
                                             if let Some(tex_dir) = utilities::get_textures_dir(&project_id) {
                                                 let filename = path.file_name().unwrap().to_string_lossy().to_string();
                                                 let dest_path = tex_dir.join(&filename);
                                                  if let Ok(_) = fs::copy(&path, &dest_path) {
                                                     pbr.rough = Some(saved_data::File { id: Uuid::new_v4().to_string(), fileName: filename, ..Default::default() });
                                                    //  utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                                                  }
                                             }
                                         }
                                     }
                                 });
                                 ui.horizontal(|ui| {
                                     ui.label("AO:");
                                     if let Some(f) = &pbr.ao { ui.label(&f.fileName); } else { ui.label("None"); }
                                     if ui.button("Set").clicked() {
                                         if let Some(path) = FileDialog::new().add_filter("Image", &["png", "jpg"]).pick_file() {
                                             if let Some(tex_dir) = utilities::get_textures_dir(&project_id) {
                                                 let filename = path.file_name().unwrap().to_string_lossy().to_string();
                                                 let dest_path = tex_dir.join(&filename);
                                                  if let Ok(_) = fs::copy(&path, &dest_path) {
                                                     pbr.ao = Some(saved_data::File { id: Uuid::new_v4().to_string(), fileName: filename, ..Default::default() });
                                                    //  utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                                                  }
                                             }
                                         }
                                     }
                                 });
                                 ui.horizontal(|ui| {
                                     ui.label("Metal:");
                                     if let Some(f) = &pbr.metallic { ui.label(&f.fileName); } else { ui.label("None"); }
                                     if ui.button("Set").clicked() {
                                         if let Some(path) = FileDialog::new().add_filter("Image", &["png", "jpg"]).pick_file() {
                                             if let Some(tex_dir) = utilities::get_textures_dir(&project_id) {
                                                 let filename = path.file_name().unwrap().to_string_lossy().to_string();
                                                 let dest_path = tex_dir.join(&filename);
                                                  if let Ok(_) = fs::copy(&path, &dest_path) {
                                                     pbr.metallic = Some(saved_data::File { id: Uuid::new_v4().to_string(), fileName: filename, ..Default::default() });
                                                    //  utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                                                  }
                                             }
                                         }
                                     }
                                 });
                                 ui.horizontal(|ui| {
                                     ui.label("Disp:");
                                     if let Some(f) = &pbr.disp { ui.label(&f.fileName); } else { ui.label("None"); }
                                     if ui.button("Set").clicked() {
                                         if let Some(path) = FileDialog::new().add_filter("Image", &["png", "jpg"]).pick_file() {
                                             if let Some(tex_dir) = utilities::get_textures_dir(&project_id) {
                                                 let filename = path.file_name().unwrap().to_string_lossy().to_string();
                                                 let dest_path = tex_dir.join(&filename);
                                                  if let Ok(_) = fs::copy(&path, &dest_path) {
                                                     pbr.disp = Some(saved_data::File { id: Uuid::new_v4().to_string(), fileName: filename, ..Default::default() });
                                                    //  utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                                                  }
                                             }
                                         }
                                     }
                                 });
                                 ui.horizontal(|ui| {
                                     ui.label("Arm:");
                                     if let Some(f) = &pbr.arm { ui.label(&f.fileName); } else { ui.label("None"); }
                                     if ui.button("Set").clicked() {
                                         if let Some(path) = FileDialog::new().add_filter("Image", &["png", "jpg"]).pick_file() {
                                             if let Some(tex_dir) = utilities::get_textures_dir(&project_id) {
                                                 let filename = path.file_name().unwrap().to_string_lossy().to_string();
                                                 let dest_path = tex_dir.join(&filename);
                                                  if let Ok(_) = fs::copy(&path, &dest_path) {
                                                     pbr.arm = Some(saved_data::File { id: Uuid::new_v4().to_string(), fileName: filename, ..Default::default() });
                                                    //  utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                                                  }
                                             }
                                         }
                                     }
                                 });
                             });
                        }

                        if ui.button("Add New PBR Texture Entry").clicked() {
                             pbr_textures.push(saved_data::PBRTextureData {
                                 id: Uuid::new_v4().to_string(),
                                 ..Default::default()
                             });
                            //  utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                        }
                    });

                    egui::CollapsingHeader::new("Stats").show(ui, |ui| {
                        if world_state.stats.is_none() {
                            world_state.stats = Some(Vec::new());
                        }
                        let stats = world_state.stats.as_mut().unwrap();

                        let mut to_remove_index = None;
                        
                        for (i, stat) in stats.iter_mut().enumerate() {
                            let stat_name = stat.name.clone();
                            ui.collapsing(if stat.name.is_empty() { "Unnamed Stat" } else { stat_name.as_str() }, |ui| {
                                ui.text_edit_singleline(&mut stat.name);
                                
                                ui.label("Character Stats:");
                                if stat.character.is_none() { stat.character = Some(saved_data::CharacterStats::default()); }
                                if let Some(char_stats) = &mut stat.character {
                                    ui.horizontal(|ui| { ui.label("Health"); ui.add(egui::DragValue::new(&mut char_stats.health)); });
                                    ui.horizontal(|ui| { ui.label("Stamina"); ui.add(egui::DragValue::new(&mut char_stats.stamina)); });
                                }

                                ui.label("Attack Stats:");
                                if stat.attack.is_none() { stat.attack = Some(saved_data::AttackStats::default()); }
                                if let Some(atk) = &mut stat.attack {
                                    ui.horizontal(|ui| { ui.label("Damage"); ui.add(egui::DragValue::new(&mut atk.damage)); });
                                    ui.horizontal(|ui| { ui.label("Range"); ui.add(egui::DragValue::new(&mut atk.range)); });
                                    ui.horizontal(|ui| { ui.label("Cooldown"); ui.add(egui::DragValue::new(&mut atk.cooldown)); });
                                }
                                
                                ui.label("Defense Stats:");
                                if stat.defense.is_none() { stat.defense = Some(saved_data::DefenseStats::default()); }
                                if let Some(def) = &mut stat.defense {
                                    ui.horizontal(|ui| { ui.label("Block Chance"); ui.add(egui::DragValue::new(&mut def.block_chance)); });
                                }
                                
                                ui.label("Weight:");
                                if stat.weight.is_none() { stat.weight = Some(0.0); }
                                if let Some(w) = &mut stat.weight {
                                     ui.add(egui::DragValue::new(w)); 
                                }

                                // if ui.button("Save Changes").clicked() {
                                //     utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                                // }
                                if ui.button("Delete Stat").clicked() {
                                    to_remove_index = Some(i);
                                }
                            });
                        }
                        
                        if let Some(idx) = to_remove_index {
                            stats.remove(idx);
                            // utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                        }

                        if ui.button("Add New Stat").clicked() {
                            stats.push(saved_data::StatData {
                                id: Uuid::new_v4().to_string(),
                                name: "New Stat".to_string(),
                                ..Default::default()
                            });
                            //  utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                        }
                    });

                    if ui.button("Save Changes").clicked() {
                        utilities::update_project_state(&project_id, world_state).expect("Failed to save state");
                    }
                }
                
                if let Some(new_state) = world_state_opt {
                    editor.world_state = Some(new_state);
                }
            }
            Tab::Chat => {
                // // TODO: this egui chat will be replaced with the wry-based chat (which will live in its own left-hand sidebar)
                // let mut received_msg = None;
                // if let Some(rx) = &self.context.chat.rx {
                //     match rx.try_recv() {
                //         Ok(msg) => received_msg = Some(msg),
                //         Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                //             self.context.chat.is_loading = false;
                //             self.context.chat.rx = None;
                //         },
                //         Err(std::sync::mpsc::TryRecvError::Empty) => {},
                //     }
                // }

                // if let Some(msg) = received_msg {
                //     self.context.chat.is_loading = false;
                //     self.context.chat.rx = None;
                //     self.context.chat.messages.push(msg.clone());

                //     if let Some(tool_calls) = msg.tool_calls {
                //         for tool_call in tool_calls {
                //             self.execute_tool_call(tool_call);
                //         }
                //     }

                //     if let Some(editor) = self.context.export_editor.as_ref() {
                //         if let Some(world_state) = &editor.world_state {
                //              let project_id = world_state.id.as_ref().expect("Couldn't get id").clone();
                //              let _ = update_project_state(&project_id, world_state);
                //         }
                //     }
                // }

                // // Check for sessions list
                // if let Some(rx) = &self.context.chat.sessions_rx {
                //     match rx.try_recv() {
                //         Ok(sessions) => {
                //             self.context.chat.available_sessions = sessions;
                //             self.context.chat.sessions_rx = None;
                //             self.context.chat.is_loading = false;
                //         },
                //         Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                //             self.context.chat.sessions_rx = None;
                //             self.context.chat.is_loading = false;
                //         },
                //         Err(std::sync::mpsc::TryRecvError::Empty) => {},
                //     }
                // }

                // // Check for session history
                // if let Some(rx) = &self.context.chat.messages_rx {
                //     match rx.try_recv() {
                //         Ok(messages) => {
                //             self.context.chat.messages = messages;
                //             self.context.chat.messages_rx = None;
                //             self.context.chat.is_loading = false;
                //         },
                //         Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                //             self.context.chat.messages_rx = None;
                //             self.context.chat.is_loading = false;
                //         },
                //         Err(std::sync::mpsc::TryRecvError::Empty) => {},
                //     }
                // }

                //  if self.context.chat.current_session.is_none() {
                //     if ui.button("Start New Session").clicked() {
                //          let editor = self.context.export_editor.as_ref().unwrap();
                //          if let Some(saved_data) = &editor.world_state {
                //              let project_id = saved_data.id.as_ref().expect("Couldn't get id").clone();
                //              let client = self.context.chat.client.clone();
                //              let api_url = self.context.chat.api_url.clone();
                             
                //              let (tx, rx) = std::sync::mpsc::channel();
                //              std::thread::spawn(move || {
                //                 let rt = tokio::runtime::Runtime::new().unwrap();
                //                 rt.block_on(async {
                //                     let url = format!("{}/api/sessions", api_url);
                //                     let body = serde_json::json!({ "projectId": project_id });
                //                     let res = client.post(&url).json(&body).send().await;
                //                     if let Ok(resp) = res {
                //                         if let Ok(session) = resp.json::<ChatSession>().await {
                //                             let _ = tx.send(session);
                //                         }
                //                     }
                //                 });
                //              });
                //              if let Ok(session) = rx.recv() {
                //                  self.context.chat.current_session = Some(session);
                //                  self.context.chat.messages.clear();
                //             }
                //          }
                //     }

                //     ui.separator();
                //     ui.horizontal(|ui| {
                //         ui.label("Previous Sessions");
                //         if ui.button("Refresh").clicked() {
                //             if let Some(editor) = self.context.export_editor.as_ref() {
                //                 if let Some(saved_data) = &editor.world_state {
                //                     let project_id = saved_data.id.as_ref().expect("Couldn't get id").clone();
                //                     let client = self.context.chat.client.clone();
                //                     let api_url = self.context.chat.api_url.clone();
                                    
                //                     let (tx, rx) = std::sync::mpsc::channel();
                //                     self.context.chat.sessions_rx = Some(rx);
                //                     self.context.chat.is_loading = true;

                //                     std::thread::spawn(move || {
                //                         let rt = tokio::runtime::Runtime::new().unwrap();
                //                         rt.block_on(async {
                //                             let url = format!("{}/api/projects/{}/sessions", api_url, project_id);
                //                             if let Ok(res) = client.get(&url).send().await {
                //                                 if let Ok(sessions) = res.json::<Vec<ChatSession>>().await {
                //                                     let _ = tx.send(sessions);
                //                                 }
                //                             }
                //                         });
                //                     });
                //                 }
                //             }
                //         }
                //     });

                //     egui::ScrollArea::vertical().show(ui, |ui| {
                //         for session in &self.context.chat.available_sessions {
                //             ui.horizontal(|ui| {
                //                 ui.label(format!("Session {}", &session.id[0..8]));
                //                 if ui.button("Resume").clicked() {
                //                     self.context.chat.current_session = Some(session.clone());
                                    
                //                     // Fetch messages
                //                     let session_id = session.id.clone();
                //                     let client = self.context.chat.client.clone();
                //                     let api_url = self.context.chat.api_url.clone();
                                    
                //                     let (tx, rx) = std::sync::mpsc::channel();
                //                     self.context.chat.messages_rx = Some(rx);
                //                     self.context.chat.is_loading = true;

                //                     std::thread::spawn(move || {
                //                         let rt = tokio::runtime::Runtime::new().unwrap();
                //                         rt.block_on(async {
                //                             let url = format!("{}/api/sessions/{}/messages", api_url, session_id);
                //                             if let Ok(res) = client.get(&url).send().await {
                //                                 if let Ok(messages) = res.json::<Vec<ChatMessage>>().await {
                //                                     let _ = tx.send(messages);
                //                                 }
                //                             }
                //                         });
                //                     });
                //                 }
                //             });
                //         }
                //     });

                //  } else {
                //      ui.horizontal(|ui| {
                //         if ui.button("Back to Sessions").clicked() {
                //             self.context.chat.current_session = None;
                //             self.context.chat.messages.clear();
                //         }
                //         if let Some(session) = &self.context.chat.current_session {
                //              ui.label(format!("Session: {}", session.id));
                //         }
                //      });
                     
                //      egui::ScrollArea::vertical().show(ui, |ui| {
                //          for msg in &self.context.chat.messages {
                //              ui.label(format!("{}: {}", msg.role, msg.content.as_deref().unwrap_or("...")));
                //              if let Some(tool_calls) = &msg.tool_calls {
                //                 for tool_call in tool_calls {
                //                     ui.label(format!("Tool | {}: {}", tool_call.function.name, tool_call.function.arguments));
                //                 }
                //              }
                //          }
                //      });
                //      ui.separator();
                //      ui.horizontal(|ui| {
                //          ui.text_edit_multiline(&mut self.context.chat.current_input);
                         
                //          let btn_text = if self.context.chat.is_loading { "Loading..." } else { "Send" };
                //          if ui.add_enabled(!self.context.chat.is_loading, egui::Button::new(btn_text)).clicked() {
                //                 let content = self.context.chat.current_input.clone();
                //                 self.context.chat.current_input.clear();
                //                 self.context.chat.is_loading = true;

                //                 let session_id = self.context.chat.current_session.as_ref().unwrap().id.clone();
                //                 let client = self.context.chat.client.clone();
                //                 let api_url = self.context.chat.api_url.clone();

                //                 let mut world_state_cl = None;
                                
                //                 {
                //                     // Get saved state for context
                //                     let editor = self.context.export_editor.as_ref().unwrap();
                //                     let world_state = editor.world_state.as_ref().expect("Couldn't get saved state").clone();
                                    
                //                     self.context.chat.messages.push(ChatMessage {
                //                         id: Uuid::new_v4().to_string(),
                //                         role: "user".to_string(),
                //                         content: Some(content.clone()),
                //                         tool_call_id: None,
                //                         tool_calls: None,
                //                     });
                                    
                //                     // Clone for thread
                //                     world_state_cl = Some(world_state.clone());
                //                 }

                //                 let (tx, rx) = std::sync::mpsc::channel();
                //                 self.context.chat.rx = Some(rx);

                //                 std::thread::spawn(move || {
                //                     let rt = tokio::runtime::Runtime::new().unwrap();
                //                     rt.block_on(async {
                //                         let url = format!("{}/api/sessions/{}/messages", api_url, session_id);
                //                         let body = serde_json::json!({
                //                             "role": "user",
                //                             "content": content,
                //                             "world_state": world_state_cl
                //                         });
                //                         let res = client.post(&url).json(&body).send().await;
                //                         if let Ok(resp) = res {
                //                             if let Ok(msg) = resp.json::<ChatMessage>().await {
                //                                 let _ = tx.send(msg);
                //                             }
                //                         }
                //                     });
                //                 });
                //          }
                //      });
                //  }
            
            }
            Tab::Writing => {
                // // TODO: this writing app, which controls wry currently, will be removed. then wry will become used for chat. but we still want wry in a tab
                // let editor = self.context.export_editor.as_mut().unwrap();
                // let sophia = &mut editor.sophia_app_state;

                // ui.horizontal(|ui| {
                //     ui.heading("Sophia Writing App");
                //     ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                //         if ui.checkbox(&mut sophia.quiet_mode, "Quiet Mode").changed() {
                //             println!("Quiet Mode: {}", sophia.quiet_mode);
                //         }
                //     });
                // });
                
                // ui.separator();
                // ui.label("Draft:");

                // let rect = ui.available_rect_before_wrap();
                // editor.wry_webview_bounds = Some([rect.min.x, rect.min.y, rect.width(), rect.height()]);
            }
            Tab::Addons => {
                let editor = self.context.export_editor.as_mut().unwrap();
                ui.heading("Entropy Addons");
                
                if ui.button("Load Addon Bundle").clicked() {
                    if let Some(path) = FileDialog::new()
                        .add_filter("JavaScript", &["js", "mjs", "bundle"])
                        .pick_file() {
                        
                        println!("Loading addon from: {:?}", path);
                        // Block on the async load for now, similar to load_game_project
                        let res = pollster::block_on(editor.addon_engine.load_addon(&path));
                        match res {
                            Ok(_) => println!("Addon loaded successfully"),
                            Err(e) => println!("Failed to load addon: {}", e),
                        }
                    }
                }
                
                ui.separator();
                ui.label("Active Addons:");
                
                // We need to access the registered addons from the AddonEngine context
                // But AddonEngine holds the OpState which holds the context.
                // For now, we can just display a placeholder or add a method to AddonEngine to get metadata.
                // Since we can't easily peek into OpState from here without some helper, 
                // we will leave the list empty for this iteration or use a simple cached list in AddonEngine if we add one.
            }
            Tab::VideoTimeline => {
                let editor = self.context.export_editor.as_mut().unwrap();
                self.context.video_timeline_ui.show(ui, editor);
            }
            Tab::Animations => {
                let editor = self.context.export_editor.as_mut().unwrap();
                ui.heading("Animation Presets");
                
                if let Some(selected) = &editor.selected_object {
                    ui.label(format!("Applying to: {}", selected.object_id));
                    ui.separator();

                    egui::CollapsingHeader::new("⭕ Geometric: Circle")
                        .default_open(true)
                        .show(ui, |ui| {
                            ui.add(egui::Slider::new(&mut editor.anim_preset_circle_radius, 10.0..=500.0).text("Radius"));
                            ui.add(egui::Slider::new(&mut editor.anim_preset_circle_duration, 500.0..=10000.0).text("Duration (ms)"));
                            if ui.button("Apply Circle Motion").clicked() {
                                let kfs = crate::vector_animations::presets::generate_circle_keyframes(
                                    editor.anim_preset_circle_radius,
                                    editor.anim_preset_circle_duration as u64,
                                    24
                                );
                                apply_keyframes_to_selected(editor, "Position", kfs);
                            }
                        });

                    ui.add_space(10.0);

                    egui::CollapsingHeader::new("🏀 Elegant: Elastic Bounce")
                        .default_open(false)
                        .show(ui, |ui| {
                            ui.add(egui::Slider::new(&mut editor.anim_preset_bounce_intensity, 10.0..=300.0).text("Intensity"));
                            ui.add(egui::Slider::new(&mut editor.anim_preset_bounce_duration, 200.0..=5000.0).text("Duration (ms)"));
                            if ui.button("Apply Bounce").clicked() {
                                let kfs = crate::vector_animations::presets::generate_bounce_keyframes(
                                    editor.anim_preset_bounce_intensity,
                                    editor.anim_preset_bounce_duration as u64
                                );
                                apply_keyframes_to_selected(editor, "Position", kfs);
                            }
                        });
                } else {
                    // ui.warning("Select an object in the viewport or timeline to apply animations.");
                }
            }
            Tab::Research => {
                let editor = self.context.export_editor.as_mut().unwrap();
                let sophia = &mut editor.sophia_app_state;

                // Check for results
                if let Some(rx) = &sophia.research_rx {
                    if let Ok(results) = rx.try_recv() {
                        sophia.research_results = results;
                        sophia.is_searching = false;
                        sophia.research_rx = None;
                    }
                }

                ui.heading("Research");
                ui.horizontal(|ui| {
                    ui.text_edit_singleline(&mut sophia.research_query);
                    if ui.button("Search").clicked() && !sophia.is_searching {
                        sophia.is_searching = true;
                        let query = sophia.research_query.clone();
                        let client = self.context.chat.client.clone();
                        let api_url = self.context.chat.api_url.clone();
                        let (tx, rx) = std::sync::mpsc::channel();
                        sophia.research_rx = Some(rx);

                        std::thread::spawn(move || {
                            let rt = tokio::runtime::Runtime::new().unwrap();
                            rt.block_on(async {
                                let url = format!("{}/api/exa", api_url);
                                let body = serde_json::json!({ "query": query });
                                if let Ok(res) = client.post(&url).json(&body).send().await {
                                    if let Ok(data) = res.json::<serde_json::Value>().await {
                                        if let Some(results) = data["results"].as_array() {
                                            let mapped: Vec<crate::helpers::saved_data::ResearchResult> = results.iter().map(|r| {
                                                crate::helpers::saved_data::ResearchResult {
                                                    id: r["id"].as_str().unwrap_or_default().to_string(),
                                                    title: r["title"].as_str().unwrap_or_default().to_string(),
                                                    url: r["url"].as_str().unwrap_or_default().to_string(),
                                                    text: r["text"].as_str().unwrap_or_default().to_string(),
                                                    highlights: r["highlights"].as_array().unwrap_or(&vec![]).iter().map(|h| h.as_str().unwrap_or_default().to_string()).collect(),
                                                }
                                            }).collect();
                                            let _ = tx.send(mapped);
                                        }
                                    }
                                }
                            });
                        });
                    }
                });

                if sophia.is_searching {
                    ui.label("Searching...");
                }

                egui::ScrollArea::vertical().show(ui, |ui| {
                    for result in &sophia.research_results {
                        ui.group(|ui| {
                            ui.hyperlink_to(&result.title, &result.url);
                            for highlight in &result.highlights {
                                ui.label(egui::RichText::new(highlight).italics());
                            }
                        });
                    }
                });
            }
            Tab::Publish => {
                ui.heading("Publish");
                ui.separator();
                ui.label("Export options:");
                if ui.button("Export to PDF").clicked() {
                    println!("Exporting to PDF...");
                }
                if ui.button("Export to Ebook (EPUB)").clicked() {
                    println!("Exporting to EPUB...");
                }
                if ui.button("Print Preparation").clicked() {
                    println!("Preparing for print...");
                }
            }
            Tab::Grammar => {
                let editor = self.context.export_editor.as_mut().unwrap();
                let sophia = &mut editor.sophia_app_state;

                ui.heading("Grammar & Style");

                egui::ScrollArea::vertical().show(ui, |ui| {
                    if sophia.grammar_issues.is_empty() {
                        ui.label("No issues found.");
                    }
                    for issue in &sophia.grammar_issues {
                        ui.group(|ui| {
                            ui.label(format!("Original: {}", issue.original));
                            ui.label(egui::RichText::new(format!("Suggestion: {}", issue.suggestion)).color(egui::Color32::GREEN));
                            ui.label(&issue.explanation);
                        });
                    }
                });
            }
            Tab::Manage => {
                let editor = self.context.export_editor.as_mut().unwrap();
                let sophia = &mut editor.sophia_app_state;

                ui.heading("Manage Elements");
                ui.collapsing("Subjects", |ui| {
                    for subject in &sophia.subjects {
                        ui.label(subject);
                    }
                });
                ui.collapsing("Keywords", |ui| {
                    for keyword in &sophia.keywords {
                        ui.label(keyword);
                    }
                });
            }
            Tab::Citations => {
                ui.heading("Citations");
                ui.label("Organize and manage your project citations here.");
            }
            Tab::AddonTab { id, .. } => {
                let editor = self.context.export_editor.as_mut().unwrap();
                editor.addon_engine.render_tab(ui, id);
            }
            Tab::ScriptEditor { path } => {
                let editor = self.context.export_editor.as_mut().unwrap();
                if let Some(script_editor) = editor.script_editors.get_mut(path) {
                    script_editor.show(ui);
                } else {
                    ui.label("Script editor not found for this path.");
                }
            }
            _ => {
                ui.label("Not implemented");
            }
        }
    }
}
