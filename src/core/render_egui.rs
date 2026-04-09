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
use crate::core::editor::Point;
use std::{collections::HashMap, fs, sync::{Arc, Mutex}};
use egui::load::SizedTexture;
use egui::{ImageSource, StrokeKind};
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

pub fn render_egui(pipeline: &mut EntropyPipeline, gui: &mut Gui) {
    let ctx = &gui.ctx;

    let is_project_loaded = if let Some(editor) = &pipeline.export_editor {
        editor.world_state.is_some() || editor.stunts_state.is_some() || editor.sophia_state.is_some()
    } else {
        false
    };

    let mut next_workspace = None;

    egui::SidePanel::left("activity_bar")
        .exact_width(48.0)
        .resizable(false)
        .show(ctx, |ui| {
            ui.vertical_centered(|ui| {
                ui.add_space(6.0);
                
                // Central Chat Icon
                if ui.selectable_label(pipeline.current_workspace == Workspace::CentralChat, "💬")
                    .on_hover_text("Central Chat")
                    .clicked() {
                    next_workspace = Some(Workspace::CentralChat);
                }
                
                ui.add_space(10.0);
                ui.separator();
                ui.add_space(10.0);

                // Addon Icons
                if let Some(editor) = &mut pipeline.export_editor {
                    let addons = editor.addon_engine.get_registered_addons();
                    for addon in addons {
                        // We use the first letter of the name as the icon for now
                        let icon = addon.name.chars().next().unwrap_or('?').to_string();
                        let is_open = pipeline.open_addon_windows.contains(&addon.name);

                        if ui.selectable_label(is_open, icon).on_hover_text(&addon.name).clicked() {
                            if is_open {
                                pipeline.open_addon_windows.remove(&addon.name);
                            } else {
                                pipeline.open_addon_windows.insert(addon.name.clone());
                            }
                        }
                    }
                }
            });
        });

    
        egui::CentralPanel::default()
            .frame(egui::Frame::none().fill(ctx.style().visuals.window_fill()))
            .show(ctx, |ui| {
                // Keep the central space mostly empty/grey
                ui.centered_and_justified(|ui| {
                    ui.label(egui::RichText::new("Entropy Engine").size(32.0).color(ui.visuals().weak_text_color()));
                });

                // Check for new tabs and other global UI logic
                if let Some(editor) = &mut pipeline.export_editor {
                    let new_tabs = editor.addon_engine.consume_new_tabs();
                    for (tab_id, title, addon_name) in new_tabs {
                        let dock_state = pipeline.addon_dock_states.entry(addon_name.clone()).or_insert_with(|| {
                            DockState::new(vec![Tab::Viewport])
                        });
                        let surface = dock_state.main_surface_mut();

                        if !pipeline.focus_mode {
                            surface.split_left(NodeIndex::root(), 0.25, vec![Tab::WryChat]);
                            surface.split_right(NodeIndex::root(), 0.75, vec![Tab::AddonTab { id: tab_id, label: title }]);
                        }
                    }

                    let pending_scripts = std::mem::take(&mut editor.pending_script_tabs);
                    for script_path in pending_scripts {
                        // For now, if we have a current workspace addon, put it there
                        if let Workspace::Addon(name) = &pipeline.current_workspace {
                            let dock_state = pipeline.addon_dock_states.entry(name.clone()).or_insert_with(|| {
                                DockState::new(vec![Tab::Projects])
                            });
                            let surface = dock_state.main_surface_mut();
                            surface.split_right(NodeIndex::root(), 0.5, vec![Tab::ScriptEditor { path: script_path }]);
                        }
                    }

                    editor.addon_engine.render_ui(ctx, &mut gui.renderer);
                }
            });

        if let Some(ws) = next_workspace.clone() {
            pipeline.current_workspace = ws;
        }

        // Show open addon windows
        let open_addons: Vec<String> = pipeline.open_addon_windows.iter().cloned().collect();
        for addon_name in open_addons {
            let mut open = true;
            
            // We need to create the viewer for each window
            let mut viewer = PipelineTabViewer {
                context: UiContext {
                    // pipeline,
                    export_editor: &mut pipeline.export_editor,
                    new_project_name: &mut pipeline.new_project_name,
                    projects: &mut pipeline.projects,
                    selected_component_id: &mut pipeline.selected_component_id,
                    chat: &mut pipeline.chat,
                    video_timeline_ui: &mut pipeline.video_timeline_ui,
                    gpu_resources: &pipeline.gpu_resources,
                    current_app: AppExperience::OpenWorldStudio, // or determine from state
                    next_workspace: &mut next_workspace,
                    egui_renderer: &mut gui.renderer,
                    active_addon: Some(addon_name.clone()),
                },
            };

            if !is_project_loaded {
                egui::CentralPanel::default().show(ctx, |ui| {
                    viewer.ui(ui, &mut Tab::Projects);
                });
            } else {

                egui::Window::new(&addon_name)
                    .open(&mut open)
                    .default_size(egui::vec2(800.0, 600.0))
                    .show(ctx, |ui| {
                        let dock_state = pipeline.addon_dock_states.entry(addon_name.clone()).or_insert_with(|| {
                            // Default layout for new addon windows
                            let mut ds = DockState::new(vec![Tab::Viewport]);
                            let surface = ds.main_surface_mut();
                            surface.split_left(NodeIndex::root(), 0.2, vec![Tab::Components]);
                            surface.split_right(NodeIndex::root(), 0.75, vec![Tab::Properties]);
                            ds
                        });

                        // Window resize detection logic
                        let rect = ui.available_rect_before_wrap();
                        let width = rect.width() as u32;
                        let height = rect.height() as u32;

                        if width > 0 && height > 0 {
                            let needs_recreate = if let Some(target) = pipeline.addon_render_targets.get(&addon_name) {
                                target.width != width || target.height != height
                            } else {
                                true
                            };

                            if needs_recreate {
                                if let Some(gpu_resources) = &pipeline.gpu_resources {
                                    let device = &gpu_resources.device;
                                    
                                    // Create texture
                                    let texture = device.create_texture(&wgpu::TextureDescriptor {
                                        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                                        mip_level_count: 1,
                                        sample_count: 1,
                                        dimension: wgpu::TextureDimension::D2,
                                        format: wgpu::TextureFormat::Rgba8Unorm, 
                                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                                        label: Some(&format!("Addon {} Render Target", addon_name)),
                                        view_formats: &[],
                                    });
                                    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

                                    // Create depth texture
                                    let depth_texture = device.create_texture(&wgpu::TextureDescriptor {
                                        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                                        mip_level_count: 1,
                                        sample_count: 1,
                                        dimension: wgpu::TextureDimension::D2,
                                        format: wgpu::TextureFormat::Depth24Plus,
                                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                                        label: Some(&format!("Addon {} Depth Target", addon_name)),
                                        view_formats: &[],
                                    });
                                    let depth_view = depth_texture.create_view(&wgpu::TextureViewDescriptor::default());

                                    // Create G-Buffer textures
                                    let gbuffer_position_texture = device.create_texture(&wgpu::TextureDescriptor {
                                        label: Some("Addon G-Buffer Position"),
                                        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                                        mip_level_count: 1,
                                        sample_count: 1,
                                        dimension: wgpu::TextureDimension::D2,
                                        format: wgpu::TextureFormat::Rgba16Float,
                                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                                        view_formats: &[],
                                    });
                                    let gbuffer_position_view = gbuffer_position_texture.create_view(&wgpu::TextureViewDescriptor::default());

                                    let gbuffer_normal_texture = device.create_texture(&wgpu::TextureDescriptor {
                                        label: Some("Addon G-Buffer Normal"),
                                        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                                        mip_level_count: 1,
                                        sample_count: 1,
                                        dimension: wgpu::TextureDimension::D2,
                                        format: wgpu::TextureFormat::Rgba16Float,
                                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                                        view_formats: &[],
                                    });
                                    let gbuffer_normal_view = gbuffer_normal_texture.create_view(&wgpu::TextureViewDescriptor::default());

                                    let gbuffer_albedo_texture = device.create_texture(&wgpu::TextureDescriptor {
                                        label: Some("Addon G-Buffer Albedo"),
                                        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                                        mip_level_count: 1,
                                        sample_count: 1,
                                        dimension: wgpu::TextureDimension::D2,
                                        format: wgpu::TextureFormat::Rgba8Unorm,
                                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                                        view_formats: &[],
                                    });
                                    let gbuffer_albedo_view = gbuffer_albedo_texture.create_view(&wgpu::TextureViewDescriptor::default());

                                    let gbuffer_pbr_material_texture = device.create_texture(&wgpu::TextureDescriptor {
                                        label: Some("Addon G-Buffer PBR Material"),
                                        size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                                        mip_level_count: 1,
                                        sample_count: 1,
                                        dimension: wgpu::TextureDimension::D2,
                                        format: wgpu::TextureFormat::Rgba8Unorm,
                                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                                        view_formats: &[],
                                    });
                                    let gbuffer_pbr_material_view = gbuffer_pbr_material_texture.create_view(&wgpu::TextureViewDescriptor::default());

                                    // Create G-Buffer bind group
                                    let g_buffer_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                                        label: Some("Addon G-Buffer Bind Group"),
                                        layout: pipeline.g_buffer_bind_group_layout.as_ref().unwrap(),
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
                                                resource: wgpu::BindingResource::Sampler(pipeline.g_buffer_sampler.as_ref().unwrap()),
                                            },
                                        ],
                                    });

                                    // Register with egui
                                    let egui_tex_id = viewer.context.egui_renderer.register_native_texture(device, &view, wgpu::FilterMode::Linear);

                                    pipeline.addon_render_targets.insert(addon_name.clone(), crate::core::pipeline::AddonRenderTarget {
                                        texture: Arc::new(texture),
                                        view: Arc::new(view),
                                        depth_texture: Arc::new(depth_texture),
                                        depth_view: Arc::new(depth_view),
                                        g_buffer_position_view: Arc::new(gbuffer_position_view),
                                        g_buffer_normal_view: Arc::new(gbuffer_normal_view),
                                        g_buffer_albedo_view: Arc::new(gbuffer_albedo_view),
                                        g_buffer_pbr_material_view: Arc::new(gbuffer_pbr_material_view),
                                        g_buffer_bind_group,
                                        egui_tex_id,
                                        width,
                                        height,
                                    });
                                }
                            }
                        }

                        DockArea::new(dock_state)
                            .style(Style::from_egui(ctx.style().as_ref()))
                            .show_inside(ui, &mut viewer);
                    });

            }
            if !open {
                pipeline.open_addon_windows.remove(&addon_name);
            }
        }
}
