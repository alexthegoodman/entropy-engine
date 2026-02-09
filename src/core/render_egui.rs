use crate::core::egui_sidebar::{PipelineTabViewer, Tab, UiContext};
use crate::core::pipeline::{EntropyPipeline, ProceduralSkyUniform, Workspace};
use crate::core::skinned_pipeline::SkinnedPipeline;
use crate::core::chat::{Chat, ChatMessage, ChatSession, ToolCall};
use crate::game_behaviors::stateful::{BehaviorConfig, CombatType};
use crate::handlers::{handle_add_collectable, handle_add_npc, handle_add_water_plane};
use crate::helpers::landscapes::generate_landscape_data;
use crate::helpers::saved_data::{self, AppExperience, AttackStats, CollectableProperties, CollectableType, LightProperties, NPCProperties};
use crate::procedural_heightmaps::heightmap_generation::{FalloffType, FeatureType, HeightmapGenerator, TerrainFeature};
#[cfg(target_os = "windows")]
use crate::startup::Gui;
use crate::vector_animations::motion::Motion;
use crate::water_plane::config::WaterConfig;
use crate::{
    core::{Grid::{Grid, GridConfig}, RendererState::RendererState, SimpleCamera::SimpleCamera as Camera, Texture::pack_pbr_textures, camera::{self, CameraBinding}, editor::{
        Editor, PointLight, Viewport, WindowSize, WindowSizeShader
    }, gpu_resources::{self, GpuResources}, vertex::Vertex}, handlers::{EntropySize, handle_add_model}, heightfield_landscapes::Landscape::{PBRMaterialType, PBRTextureKind}, helpers::{landscapes::{read_landscape_heightmap_as_texture, read_texture_bytes}, saved_data::{ComponentData, GenericProperties, ComponentKind, LandscapeTextureKinds, LevelData, PBRTextureData, ProceduralSkyConfig, SavedState}, timelines::SavedTimelineStateConfig, utilities}, procedural_trees::trees::DrawTrees, vector_animations::animations::{Sequence, ObjectType}, video_export::frame_buffer::FrameCaptureBuffer, water_plane::water::DrawWater
};
use crate::core::Texture::Texture;
use crate::core::shadow_pipeline::ShadowPipelineData;
use crate::core::ui_pipeline::UiPipeline;
use crate::core::HealthBar::HealthBar;
use crate::core::editor::Point;
use std::{collections::HashMap, fs, sync::{Arc, Mutex}};
use egui::StrokeKind;
// use cgmath::{Point3, Vector3};
use nalgebra::{Isometry3, Point3, Translation3, UnitQuaternion, Vector3};
use transform_gizmo::{EnumSet, GizmoMode};
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

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;
use crate::shape_primitives::Cube::Cube;
use crate::shape_primitives::Sphere::Sphere;
// use crate::helpers::load_project::load_project;
use crate::deno::script_engine::{ComponentChanges, DenoEngine};
use crate::game_ui::dialogue_ui;
use crate::game_ui::quest_ui;
use crate::game_ui::hud::{Crosshair, AmmoDisplay};
use crate::procedural_particles::particle_system::{ParticleSystem, ParticleUniforms};

 pub fn render_egui(pipeline: &mut EntropyPipeline, ctx: &egui::Context) {
        // egui::TopBottomPanel::top("command_bar").show(ctx, |ui| {
        //     ui.horizontal_centered(|ui| {
        //          // Check if we need to load projects
        //          if pipeline.projects.is_empty() {
        //              if let Ok(registry) = utilities::load_project_registry() {
        //                  for project in registry.projects {
        //                      pipeline.projects.push((project.project_name, project.project_id));
        //                  }
        //              }
        //          }

        //          let mut selected_text = "All Projects".to_string();
        //          if let Some(id) = &pipeline.command_bar_project_id {
        //              if let Some((name, _)) = pipeline.projects.iter().find(|(_, pid)| pid == id) {
        //                  selected_text = name.clone();
        //              }
        //          }

        //          egui::ComboBox::from_id_source("command_bar_project_combo")
        //             .selected_text(selected_text)
        //             .show_ui(ui, |ui| {
        //                 ui.selectable_value(&mut pipeline.command_bar_project_id, None, "All Projects");
        //                 for (name, id) in &pipeline.projects {
        //                      ui.selectable_value(&mut pipeline.command_bar_project_id, Some(id.clone()), name);
        //                 }
        //             });

        //          let response = ui.add_sized(
        //              ui.available_size(),
        //              egui::TextEdit::multiline(&mut pipeline.command_bar_input).desired_rows(2).hint_text("Enter AI command (Ctrl+K to focus)...")
        //          );
                 
        //          if ctx.input_mut(|i| i.consume_key(egui::Modifiers::CTRL, egui::Key::K)) {
        //              response.request_focus();
        //          }

        //          if response.lost_focus() && ctx.input(|i| i.key_pressed(egui::Key::Enter)) {
        //              if !pipeline.command_bar_input.trim().is_empty() {
        //                  let content = pipeline.command_bar_input.clone();
        //                  pipeline.command_bar_input.clear();
                         
        //                  pipeline.chat.is_loading = true;
                         
        //                  let client = pipeline.chat.client.clone();
        //                  let api_url = pipeline.chat.api_url.clone();
                         
        //                  // Determine project ID
        //                  let project_id_to_use = pipeline.command_bar_project_id.clone()
        //                      .or_else(|| pipeline.export_editor.as_ref().and_then(|e| e.world_state.as_ref()).and_then(|ws| ws.id.clone()));
                        
        //                 // TODO: need to load the correct state depending on either the chosen project, or, if All Projects is chosen, then it needs to
        //                 // use an AI endpoint to decide which project is relevant to the AI command, then here we use that info to finally send the relevant state
        //                 // probably easiest to just freshly load the relevant project's state direct from file once it is chosen / determined
        //                  let mut world_state_cl = None;
        //                  if let Some(editor) = pipeline.export_editor.as_ref() {
        //                      if let Some(ws) = &editor.world_state {
        //                          world_state_cl = Some(ws.clone());
        //                      }
        //                  }
                         
        //                  let current_session = pipeline.chat.current_session.clone();
        //                  let (tx, rx) = std::sync::mpsc::channel();
        //                  pipeline.chat.rx = Some(rx);

        //                  // Add user message to chat immediately for UI feedback
        //                  pipeline.chat.messages.push(ChatMessage {
        //                      id: Uuid::new_v4().to_string(),
        //                      role: "user".to_string(),
        //                      content: Some(content.clone()),
        //                      tool_call_id: None,
        //                      tool_calls: None,
        //                  });

        //                  std::thread::spawn(move || {
        //                      let rt = tokio::runtime::Runtime::new().unwrap();
        //                      rt.block_on(async {
        //                          let mut session_id = None;
                                 
        //                          if let Some(s) = current_session {
        //                              session_id = Some(s.id);
        //                          } else if let Some(pid) = project_id_to_use {
        //                              // Create session
        //                              let url = format!("{}/api/sessions", api_url);
        //                              let body = serde_json::json!({ "projectId": pid });
        //                              if let Ok(res) = client.post(&url).json(&body).send().await {
        //                                  if let Ok(session) = res.json::<ChatSession>().await {
        //                                      session_id = Some(session.id);
        //                                  }
        //                              }
        //                          }

        //                          if let Some(sid) = session_id {
        //                              let url = format!("{}/api/sessions/{}/messages", api_url, sid);
        //                              let body = serde_json::json!({
        //                                  "role": "user",
        //                                  "content": content,
        //                                  "world_state": world_state_cl
        //                              });
                                     
        //                              let res = client.post(&url).json(&body).send().await;
        //                              if let Ok(resp) = res {
        //                                  if let Ok(msg) = resp.json::<ChatMessage>().await {
        //                                      let _ = tx.send(msg);
        //                                  }
        //                              }
        //                          }
        //                      });
        //                  });
        //              }
        //          }
        //     });
        // });

        let is_project_loaded = if let Some(editor) = &pipeline.export_editor {
            editor.world_state.is_some() || editor.stunts_state.is_some() || editor.sophia_state.is_some()
        } else {
            false
        };

        let mut next_workspace = None;
        {
            let mut context = UiContext {
                export_editor: &mut pipeline.export_editor,
                new_project_name: &mut pipeline.new_project_name,
                projects: &mut pipeline.projects,
                selected_component_id: &mut pipeline.selected_component_id,
                chat: &mut pipeline.chat,
                video_timeline_ui: &mut pipeline.video_timeline_ui,
                gpu_resources: &pipeline.gpu_resources,
                current_app: match &pipeline.current_workspace {
                    Workspace::GameEngine => AppExperience::OpenWorldStudio,
                    Workspace::Sophia => AppExperience::Sophia,
                    Workspace::Stunts => AppExperience::Stunts,
                    Workspace::CentralChat => AppExperience::OpenWorldStudio,
                    Workspace::Addon(_) => AppExperience::OpenWorldStudio, // Default for addons
                },
                next_workspace: &mut next_workspace,
            };

            let mut viewer = PipelineTabViewer { context };

            if !is_project_loaded {
                egui::CentralPanel::default().show(ctx, |ui| {
                    viewer.ui(ui, &mut Tab::Projects);
                });
            } else {
                egui::SidePanel::left("activity_bar")
                    .resizable(false)
                    .default_width(48.0)
                    .show(ctx, |ui| {
                        ui.vertical_centered(|ui| {
                            ui.add_space(6.0);
                            // if ui.selectable_label(pipeline.current_workspace == Workspace::GameEngine, "🎮").on_hover_text("Open World Studio (Games)").clicked() {
                            //     pipeline.current_workspace = Workspace::GameEngine;
                            // }
                            // ui.add_space(6.0);
                            // if ui.selectable_label(pipeline.current_workspace == Workspace::Sophia, "⚡").on_hover_text("Sophia (Writing)").clicked() {
                            //     pipeline.current_workspace = Workspace::Sophia;
                            // }
                            // ui.add_space(6.0);
                            // if ui.selectable_label(pipeline.current_workspace == Workspace::Stunts, "🎬").on_hover_text("Stunts (Videos)").clicked() {
                            //     pipeline.current_workspace = Workspace::Stunts;
                            // }
                            // ui.add_space(6.0);
                            // if ui.selectable_label(pipeline.current_workspace == Workspace::CentralChat, "💬").on_hover_text("Central Chat Workspace").clicked() {
                            //     pipeline.current_workspace = Workspace::CentralChat;
                            // }

                            // Render Addon Workspaces
                            if let Some(editor) = &mut viewer.context.export_editor {
                                let addons = editor.addon_engine.get_registered_addons();
                                for addon in addons {
                                    // Only show if it has UI/workspace capability (assume yes for now or check metadata)
                                    // We use the first letter of the name as the icon for now
                                    let icon = addon.name.chars().next().unwrap_or('?').to_string();
                                    let is_active = if let Workspace::Addon(name) = &pipeline.current_workspace {
                                        name == &addon.name
                                    } else {
                                        false
                                    };
                                    
                                    ui.add_space(6.0);
                                    if ui.selectable_label(is_active, icon).on_hover_text(&addon.name).clicked() {
                                        pipeline.current_workspace = Workspace::Addon(addon.name.clone());
                                    }
                                }
                            }

                            ui.add_space(6.0);
                            if ui.selectable_label(pipeline.show_addon_manager, "➕").on_hover_text("Manage Addons").clicked() {
                                pipeline.show_addon_manager = !pipeline.show_addon_manager;
                            }
                        });
                    });

                if pipeline.show_addon_manager {
                    // TODO: make a tab so it doesnt float
                    egui::Window::new("Entropy Addons")
                        .default_size([400.0, 500.0])
                        .open(&mut pipeline.show_addon_manager)
                        .show(ctx, |ui| {
                            ui.heading("Manage Addons");
                            ui.separator();
                            
                            if ui.button("Load Addon Bundle").clicked() {
                                if let Some(path) = rfd::FileDialog::new()
                                    .add_filter("JavaScript", &["js", "mjs", "bundle"])
                                    .pick_file() {
                                    
                                    if let Some(editor) = &mut viewer.context.export_editor {
                                        println!("Loading addon from: {:?}", path);
                                        let res = pollster::block_on(editor.addon_engine.load_addon(&path));
                                        match res {
                                            Ok(_) => println!("Addon loaded successfully"),
                                            Err(e) => println!("Failed to load addon: {}", e),
                                        }
                                    }
                                }
                            }

                            ui.separator();
                            ui.label("Registered Addons:");
                            
                            if let Some(editor) = &mut viewer.context.export_editor {
                                let addons = editor.addon_engine.get_registered_addons();
                                if addons.is_empty() {
                                    ui.label("No addons registered.");
                                } else {
                                    for addon in addons {
                                        ui.group(|ui| {
                                            ui.strong(&addon.name);
                                            ui.label(format!("Version: {}", addon.version));
                                            ui.label(&addon.description);
                                            ui.label(format!("Author: {}", addon.author.join(", ")));
                                        });
                                    }
                                }
                            }
                        });
                }

                // if pipeline.show_central_chat_overlay {
                //     egui::Window::new("Central Chat")
                //         .default_size([400.0, 600.0])
                //         .open(&mut pipeline.show_central_chat_overlay)
                //         .show(ctx, |ui| {
                //             DockArea::new(&mut pipeline.central_chat_dock_state)
                //                 .style(Style::from_egui(ctx.style().as_ref()))
                //                 .show_inside(ui, &mut viewer);
                //         });
                // }

                // if pipeline.current_workspace == Workspace::Sophia {
                //     if let Some(editor) = &mut viewer.context.export_editor {
                //         let quiet_mode = editor.sophia_app_state.quiet_mode;

                //         if quiet_mode {
                //             egui::CentralPanel::default().show(ctx, |ui| {
                //                 viewer.ui(ui, &mut Tab::Writing);
                //             });
                //         } else {
                //             egui::CentralPanel::default().show(ctx, |ui| {
                //                 DockArea::new(&mut pipeline.sophia_dock_state)
                //                     .style(Style::from_egui(ctx.style().as_ref()))
                //                     .show_inside(ui, &mut viewer);
                //             });
                //         }
                //     }
                // } else {
                    egui::CentralPanel::default()
                        .show(ctx, |ui| {
                        
                        if let Some(editor) = &mut viewer.context.export_editor {
                            let new_tabs = editor.addon_engine.consume_new_tabs();
                            for (tab_id, title, addon_name) in new_tabs {
                                let dock_state = pipeline.addon_dock_states.entry(addon_name.clone()).or_insert_with(|| {
                                    let mut ds = DockState::new(vec![Tab::Viewport, Tab::Projects, Tab::Chat]);
                                    ds
                                });
                                let surface = dock_state.main_surface_mut();
                                surface.split_left(NodeIndex::root(), 0.25, vec![Tab::WryChat]);
                                surface.split_right(NodeIndex::root(), 0.75, vec![Tab::AddonTab { id: tab_id, label: title }]);
                            }

                            let pending_scripts = std::mem::take(&mut editor.pending_script_tabs);
                            for script_path in pending_scripts {
                                if let Workspace::Addon(name) = &pipeline.current_workspace {
                                    let dock_state = pipeline.addon_dock_states.entry(name.clone()).or_insert_with(|| {
                                        DockState::new(vec![Tab::Projects])
                                    });
                                    let surface = dock_state.main_surface_mut();
                                    surface.split_right(NodeIndex::root(), 0.5, vec![Tab::ScriptEditor { path: script_path }]);
                                }
                            }
                        }

                        let active_dock_state = match &pipeline.current_workspace {
                            Workspace::Addon(name) => {
                                pipeline.addon_dock_states.entry(name.clone()).or_insert_with(|| {
                                    let mut ds = DockState::new(vec![Tab::Projects]);
                                    ds
                                })
                            },
                            _ => return
                        };

                        DockArea::new(active_dock_state)
                            .style(Style::from_egui(ctx.style().as_ref()))
                            .show_inside(ui, &mut viewer);

                        if let Some(editor) = &mut viewer.context.export_editor {
                            editor.addon_engine.render_ui(ctx);
                        }

                        // Draw selection highlight for Stunts objects
                        // if let Some(editor) = &viewer.context.export_editor {
                        //     if let Some(selected) = &editor.selected_object {
                        //         let mut rect_pos = None;
                        //         let mut rect_size = None;

                        //         match selected.object_type {
                        //             ObjectType::Polygon => {
                        //                 if let Some(poly) = editor.stunts_polygons.iter().find(|p| p.id == selected.object_id) {
                        //                     rect_pos = Some(poly.transform.position);
                        //                     rect_size = Some(poly.dimensions);
                        //                 }
                        //             }
                        //             ObjectType::TextItem => {
                        //                 if let Some(text) = editor.stunts_textboxes.iter().find(|t| t.id == selected.object_id) {
                        //                     rect_pos = Some(text.transform.position);
                        //                     rect_size = Some(text.dimensions);
                        //                 }
                        //             }
                        //             ObjectType::ImageItem => {
                        //                 if let Some(img) = editor.stunts_images.iter().find(|i| i.id == selected.object_id.to_string()) {
                        //                     rect_pos = Some(img.transform.position);
                        //                     rect_size = Some((img.transform.scale.x, img.transform.scale.y));
                        //                 }
                        //             }
                        //             ObjectType::VideoItem => {
                        //                 if let Some(vid) = editor.stunts_videos.iter().find(|v| v.id == selected.object_id.to_string()) {
                        //                     rect_pos = Some(vid.transform.position);
                        //                     rect_size = Some((vid.transform.scale.x, vid.transform.scale.y));
                        //                 }
                        //             }
                        //         }

                        //         if let (Some(pos), Some(size)) = (rect_pos, rect_size) {
                        //             let screen_rect = egui::Rect::from_center_size(
                        //                 egui::pos2(pos.x, pos.y),
                        //                 egui::vec2(size.0, size.1)
                        //             );
                                    
                        //             let painter = ui.painter();
                        //             painter.rect_stroke(
                        //                 screen_rect.expand(2.0),
                        //                 2.0,
                        //                 egui::Stroke::new(2.0, egui::Color32::from_rgb(255, 165, 0)), // Orange selection box
                        //                 StrokeKind::Middle
                        //             );

                        //             // Draw tiny handles at corners
                        //             let handle_color = egui::Color32::WHITE;
                        //             let handle_size = 6.0;
                        //             for corner in &[screen_rect.left_top(), screen_rect.right_top(), screen_rect.left_bottom(), screen_rect.right_bottom()] {
                        //                 painter.rect_filled(
                        //                     egui::Rect::from_center_size(*corner, egui::vec2(handle_size, handle_size)),
                        //                     1.0,
                        //                     handle_color
                        //                 );
                        //             }
                        //         }
                        //     }
                        // }
                    });
                // }
            }
        } // context and viewer dropped here

        if let Some(ws) = next_workspace {
            pipeline.current_workspace = ws;
        }
    }
