use crate::core::egui_sidebar::{PipelineTabViewer, Tab, UiContext};
use crate::core::pipeline::{DirectionalLightUniform, EntropyPipeline, ProceduralSkyUniform, Workspace};
use crate::core::skinned_pipeline::SkinnedPipeline;
use crate::core::chat::{Chat, ChatMessage, ChatSession, ToolCall};
use crate::deno::addon_ops::AddonContext;
use crate::game_behaviors::stateful::{BehaviorConfig, CombatType};
use crate::handlers::{handle_add_collectable, handle_add_npc, handle_add_water_plane};
use crate::heightfield_landscapes::QuadScape::draw_quadscape;
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
// use crate::deno::script_engine::{ComponentChanges, DenoEngine};
use crate::game_ui::dialogue_ui;
use crate::game_ui::quest_ui;
use crate::procedural_particles::particle_system::{ParticleSystem, ParticleUniforms};

pub fn render_addon_frame(pipeline: &mut EntropyPipeline, target_view: Option<&wgpu::TextureView>, current_time: f64, viewport_rect: Option<[f32; 4]>) {
        let editor = pipeline.export_editor.as_mut().expect("Couldn't get editor");
        let renderer_state = editor.renderer_state.as_mut().expect("Couldn't get RendererState");
        let gpu_resources = pipeline
            .gpu_resources
            .as_ref()
            .expect("Couldn't get gpu resources");
        let device = &gpu_resources.device;
        let queue = &gpu_resources.queue;
        // let device = pipeline.device.as_ref().expect("Couldn't get device");
        // let queue = pipeline.queue.as_ref().expect("Couldn't get queue");
        let view = if let Some(target_view) = target_view {
            target_view
        } else {
            pipeline.view.as_ref().expect("Couldn't get texture view")
        };

        let depth_view = pipeline
            .depth_view
            .as_ref()
            .expect("Couldn't get depth texture view");
        // let render_pipeline = pipeline
        //     .render_pipeline
        //     .as_ref()
        //     .expect("Couldn't get render pipeline");
        let geometry_pipeline = pipeline
            .geometry_pipeline
            .as_ref()
            .expect("Couldn't get geometry pipeline");
        // let camera_binding = pipeline
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

        // if let Some(rect) = viewport_rect {
        //     camera.aspect_ratio = rect[2] / rect[3];
        //     camera.viewport.width = rect[2];
        //     camera.viewport.height = rect[3];
        //     camera.viewport.window_size.width = rect[2] as u32;
        //     camera.viewport.window_size.height = rect[3] as u32;
        //     camera.update();
        //     camera_binding.update_3d(queue, camera);
        // }

         let window_size_bind_group = pipeline
            .window_size_bind_group
            .as_ref()
            .expect("Couldn't get window size bind group");
        let texture = pipeline.texture.as_ref().expect("Couldn't get texture");

        let time = pipeline.start_time.elapsed().as_secs_f32();

        let mut addon_name = "Global";
        if let Workspace::Addon(active_name) = &pipeline.current_workspace {
            addon_name = active_name;
        }

        // Sync enemy health to UI
        // if let Some(target_id) = &editor.current_enemy_target {
        //     if let Some(npc) = renderer_state.npcs.iter().find(|n| &n.id == target_id) {
        //          if let Some(health_bar) = &mut editor.enemy_health_bar {
        //             health_bar.update_health(queue, npc.stats.health);
        //         }
        //     }
        // }

        // Sync player health to UI
        if let Some(player) = &mut renderer_state.player_character {
            // if let Some(health_bar) = &mut editor.health_bar {
            //     health_bar.update_health(queue, player.stats.health);
            // }

            // Update Aim
            player.update_aim(0.016);
            let target_fov = camera.base_fovy * (1.0 - (player.aim_factor * 0.4)); // 40% zoom
            camera.fovy = target_fov;
            // camera.update_view_projection_matrix(); // Called in step_physics_pipeline or later? 
            // Better call it here to be safe, but update() is called in step_physics_pipeline?
            // step_physics_pipeline calls camera.update()
            
            if let Some(mini_map) = &mut editor.mini_map {
                if let Some(rb_handle) = player.movement_rigid_body_handle {
                     if let Some(rb) = renderer_state.rigid_body_set.get(rb_handle) {
                        let position = rb.translation();
                        let yaw = renderer_state.camera_yaw;
                        let landscape_center = Vector3::new(0.0, 0.0, 0.0);
                        let landscape_size = 4096.0; // Matches grid size for now // make match addon global settings

                        mini_map.update_all(queue, *position, yaw, landscape_center, landscape_size, &renderer_state.npcs, &renderer_state.collectables, &renderer_state.rigid_body_set, camera);
                     }
                }
            }
        }

        // update rapier collisions
        renderer_state.update_rapier(); // always update for the sake of raycast

        if renderer_state.game_mode {
            // step through physics each frame
            renderer_state.step_physics_pipeline(
                &gpu_resources.device,
                &gpu_resources.queue,
                camera_binding,
                camera
            );
        }

        {
            let Editor {
                ref mut addon_engine,
                ref mut ui_polygons,
                ref mut ui_textboxes,
                ref font_manager,
                ref ui_model_bind_group_layout,
                ref group_bind_group_layout,
                ..
            } = *editor;

            let ui_model_layout = ui_model_bind_group_layout.as_ref().expect("No ui model layout");
            let group_layout = group_bind_group_layout.as_ref().expect("No group layout");

            addon_engine.update(
                renderer_state, 
                ui_polygons,
                ui_textboxes,
                font_manager,
                ui_model_layout,
                group_layout,
                camera, 
                camera_binding,
                current_time, 
                gpu_resources, 
                addon_name.to_string(),
                pipeline.alpha_renderer.as_mut()
            );
        }

        // Addons that declare `capabilities.needsViewport = false` (e.g. the DAW) don't need
        // the 3D scene. This function runs *after* the egui pass (see pipeline.rs), and the
        // egui pass already painted an opaque frame (CentralPanel's fill + the WryChat/AddonTab
        // panels) into `view` using LoadOp::Load. So we must NOT clear or draw anything here —
        // doing so (even a "clear to a color") would wipe out everything egui just drew, since
        // there's nothing left afterwards to redraw over it. We just skip the whole 3D pipeline
        // and leave `view` exactly as egui left it. addon_engine.update() above still ran (it
        // drives addon onUpdate callbacks, e.g. the DAW's sequencer), so nothing else is lost.
        let needs_viewport = {
            let mut active_addon_name = "Global".to_string();
            if let Workspace::Addon(active_name) = &pipeline.current_workspace {
                active_addon_name = active_name.clone();
            }
            editor.addon_engine.get_registered_addons()
                .iter()
                .find(|a| a.name == active_addon_name)
                .and_then(|a| a.capabilities.get("needsViewport").copied())
                .unwrap_or(true)
        };

        if !needs_viewport {
            return;
        }

        // Update procedural sky and directional light from addon or world state
        let mut current_procedural_sky_config = editor
            .world_state
            .as_ref()
            .and_then(|state| state.levels.as_ref())
            .and_then(|levels| levels.get(0))
            .and_then(|level| level.procedural_sky.clone());

        // Check if addon has a pending sun config override
        if let Some(addon_config) = editor.addon_engine.runtime.op_state().borrow().try_borrow::<AddonContext>().and_then(|ctx| ctx.pending_sun_config.clone()) {
            current_procedural_sky_config = Some(ProceduralSkyConfig { 
                horizon_color: addon_config.horizon_color, 
                zenith_color: addon_config.zenith_color, 
                sun_direction: addon_config.sun_direction, 
                sun_color: addon_config.sun_color,
                sun_intensity: addon_config.sun_intensity 
            });
        }

        if let Some(config) = current_procedural_sky_config {
            let horizon_color = config.horizon_color;
            let zenith_color = config.zenith_color;
            let sun_direction = config.sun_direction;

            let procedural_sky_uniform_data = ProceduralSkyUniform {
                horizon_color: [horizon_color[0], horizon_color[1], horizon_color[2], 1.0],
                zenith_color: [zenith_color[0], zenith_color[1], zenith_color[2], 1.0],
                sun_direction: [sun_direction[0], sun_direction[1], sun_direction[2], 1.0],
                sun_color: config.sun_color,
                sun_intensity: config.sun_intensity,
                ..Default::default()
            };
            queue.write_buffer(
                pipeline.procedural_sky_uniform_buffer.as_ref().unwrap(),
                0,
                bytemuck::cast_slice(&[procedural_sky_uniform_data]),
            );

            // Also update the directional light for PBR rendering
            if let Some(dir_light_buffer) = &pipeline.directional_light_buffer {
                let dir_light_uniform = DirectionalLightUniform {
                    position: sun_direction,
                    _padding: 0,
                    color: [
                        config.sun_color[0] * config.sun_intensity,
                        config.sun_color[1] * config.sun_intensity,
                        config.sun_color[2] * config.sun_intensity,
                    ],
                    _padding2: 0,
                };
                queue.write_buffer(
                    dir_light_buffer,
                    0,
                    bytemuck::cast_slice(&[dir_light_uniform]),
                );
            }
        }

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());

        // --- Alpha Renderer Pass ---
        if let Some(alpha) = &mut pipeline.alpha_renderer {
            // Update camera in alpha renderer
            let camera_uniform = camera_binding.uniform;
            queue.write_buffer(&alpha.camera_buffer, 0, bytemuck::cast_slice(&[camera_uniform]));

            alpha.render(
                &mut encoder,
                pipeline.g_buffer_position_view.as_ref().unwrap(),
                pipeline.g_buffer_normal_view.as_ref().unwrap(),
                pipeline.g_buffer_albedo_view.as_ref().unwrap(),
                pipeline.g_buffer_pbr_material_view.as_ref().unwrap(),
                pipeline.depth_view.as_ref().unwrap(),
                alpha.current_instance_count
            );
        }
        
        let mut pbr_cubes = Vec::new();
        let mut non_pbr_cubes = Vec::new();
        let mut pbr_landscapes = Vec::new();
        let mut non_pbr_landscapes = Vec::new();
        let mut pbr_landscape3ds = Vec::new();
        let mut non_pbr_landscape3ds = Vec::new();
        let mut pbr_quadscapes = Vec::new();
        let mut non_pbr_quadscapes = Vec::new();
        let mut pbr_grasses = Vec::new();
        let mut non_pbr_grasses = Vec::new();
        let mut pbr_meshes = Vec::new();
        let mut non_pbr_meshes = Vec::new();
        let mut pbr_addon_models = Vec::new();
        let mut non_pbr_addon_models = Vec::new();

        {
            let mut op_state = editor.addon_engine.runtime.op_state();
            let op_state = op_state.borrow();
            if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                for (addon_name, cubes) in &renderer_state.addon_cubes {
                    if ctx.hidden_addons.contains(addon_name) {
                        continue;
                    }
                    if let Workspace::Addon(active_name) = &pipeline.current_workspace {
                        if active_name != "Game Composer" && addon_name != active_name && addon_name != "Global" {
                            continue;
                        }
                    } else if addon_name != "Global" {
                        continue;
                    }

                    for cube in cubes {
                        let mut is_pbr = true;
                        if let Some(pid) = &cube.pipeline_id {
                            if pid != "default" {
                                if let Some(config) = ctx.pipeline_configs.get(pid) {
                                    is_pbr = config.pbr.unwrap_or(true);
                                }
                            }
                        }
                        
                        if is_pbr {
                            pbr_cubes.push(cube);
                        } else {
                            non_pbr_cubes.push(cube);
                        }
                    }
                }

                for (addon_name, landscapes) in &renderer_state.addon_landscapes {
                    if ctx.hidden_addons.contains(addon_name) {
                        continue;
                    }
                    if let Workspace::Addon(active_name) = &pipeline.current_workspace {
                        if active_name != "Game Composer" && addon_name != active_name && addon_name != "Global" {
                            continue;
                        }
                    } else if addon_name != "Global" {
                        continue;
                    }

                    for landscape in landscapes {
                        let mut is_pbr = true;
                        if let Some(pid) = &landscape.pipeline_id {
                            if pid != "default" {
                                if let Some(config) = ctx.pipeline_configs.get(pid) {
                                    is_pbr = config.pbr.unwrap_or(true);
                                }
                            }
                        }

                        if is_pbr {
                            pbr_landscapes.push(landscape);
                        } else {
                            non_pbr_landscapes.push(landscape);
                        }
                    }
                }

                for (addon_name, landscapes) in &renderer_state.addon_landscape3ds {
                    if ctx.hidden_addons.contains(addon_name) {
                        continue;
                    }
                    if let Workspace::Addon(active_name) = &pipeline.current_workspace {
                        if active_name != "Game Composer" && addon_name != active_name && addon_name != "Global" {
                            continue;
                        }
                    } else if addon_name != "Global" {
                        continue;
                    }

                    for landscape in landscapes {
                        let mut is_pbr = true;
                        if let Some(pid) = &landscape.pipeline_id {
                            if pid != "default" {
                                if let Some(config) = ctx.pipeline_configs.get(pid) {
                                    is_pbr = config.pbr.unwrap_or(true);
                                }
                            }
                        }

                        if is_pbr {
                            pbr_landscape3ds.push(landscape);
                        } else {
                            non_pbr_landscape3ds.push(landscape);
                        }
                    }
                }

                for (addon_name, landscapes) in &mut renderer_state.addon_quadscapes {
                    if ctx.hidden_addons.contains(addon_name) {
                        continue;
                    }
                    if let Workspace::Addon(active_name) = &pipeline.current_workspace {
                        if active_name != "Game Composer" && addon_name != active_name && addon_name != "Global" {
                            continue;
                        }
                    } else if addon_name != "Global" {
                        continue;
                    }

                    for landscape in landscapes {
                        let mut is_pbr = true; // all pbr for now on quadscapes
                        // if let Some(pid) = &landscape.pipeline_id {
                        //     if pid != "default" {
                        //         if let Some(config) = ctx.pipeline_configs.get(pid) {
                        //             is_pbr = config.pbr.unwrap_or(true);
                        //         }
                        //     }
                        // }

                        if is_pbr {
                            pbr_quadscapes.push(landscape);
                        } else {
                            non_pbr_quadscapes.push(landscape);
                        }
                    }
                }

                for (addon_name, meshes) in &renderer_state.addon_meshes {
                    if ctx.hidden_addons.contains(addon_name) {
                        continue;
                    }
                    if let Workspace::Addon(active_name) = &pipeline.current_workspace {
                        if active_name != "Game Composer" && addon_name != active_name && addon_name != "Global" {
                            continue;
                        }
                    } else if addon_name != "Global" {
                        continue;
                    }

                    for mesh in meshes {
                        let mut is_pbr = true;
                        if let Some(config) = ctx.pipeline_configs.get(&mesh.pipeline_id) {
                            is_pbr = config.pbr.unwrap_or(true);
                        }
                        
                        if is_pbr {
                            pbr_meshes.push(mesh);
                        } else {
                            non_pbr_meshes.push(mesh);
                        }
                    }
                }

                for (addon_name, models) in &renderer_state.addon_models {
                    if ctx.hidden_addons.contains(addon_name) {
                        continue;
                    }
                    if let Workspace::Addon(active_name) = &pipeline.current_workspace {
                        if active_name != "Game Composer" && addon_name != active_name && addon_name != "Global" {
                            continue;
                        }
                    } else if addon_name != "Global" {
                        continue;
                    }

                    for model in models {
                        // Models from GLB are generally PBR-targeted in this engine
                        // unless specifically overridden by a role that uses a non-PBR pipeline
                        let mut is_pbr = true;
                        if let Some(mesh) = model.meshes.get(0) {
                            if let Some(role) = &mesh.render_role {
                                if let Some(pid) = ctx.render_roles.get(role) {
                                    if let Some(config) = ctx.pipeline_configs.get(pid) {
                                        is_pbr = config.pbr.unwrap_or(true);
                                    }
                                }
                            }
                        }

                        if is_pbr {
                            pbr_addon_models.push(model);
                        } else {
                            non_pbr_addon_models.push(model);
                        }
                    }
                }

                for (addon_name, grasses) in &mut renderer_state.addon_grasses {
                    if ctx.hidden_addons.contains(addon_name) {
                        continue;
                    }
                    if let Workspace::Addon(active_name) = &pipeline.current_workspace {
                        if active_name != "Game Composer" && addon_name != active_name && addon_name != "Global" {
                            continue;
                        }
                    } else if addon_name != "Global" {
                        continue;
                    }

                    for grass in grasses {
                        let mut is_pbr = true;
                        // Note: Grass currently doesn't have a pipeline_id field on the Rust struct, 
                        // but it has a render_pipeline. We should check the config it was created with if possible.
                        // For now, let's assume hair particles are PBR if they output to G-buffer.
                        // All hair particles in our system are currently set up to output to G-buffer.
                        
                        if is_pbr {
                            pbr_grasses.push(grass);
                        } else {
                            non_pbr_grasses.push(grass);
                        }
                    }
                }
            }
        }

        // 1. Geometry Pass for PBR objects
        if !pbr_cubes.is_empty() || !pbr_landscapes.is_empty() || !pbr_landscape3ds.is_empty() || !pbr_grasses.is_empty() || !pbr_meshes.is_empty() {
            let gbuffer_position_view = pipeline.g_buffer_position_view.as_ref().unwrap();            
            let gbuffer_normal_view = pipeline.g_buffer_normal_view.as_ref().unwrap();
            let gbuffer_albedo_view = pipeline.g_buffer_albedo_view.as_ref().unwrap();
            let gbuffer_pbr_material_view = pipeline.g_buffer_pbr_material_view.as_ref().unwrap();

            let clear_color = wgpu::Color::BLACK;

            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Addon PBR Geometry Pass"),
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
                    view: &depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            if let Some(rect) = viewport_rect {
                // render_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
                render_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
            }

            render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
            render_pass.set_bind_group(2, window_size_bind_group, &[]);

            {
                let op_state = editor.addon_engine.runtime.op_state();
                let op_state = op_state.borrow();
                if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                    
                    for cube in &pbr_cubes {
                        let mut pipeline_set = false;
                        
                        // 1. Check Role Override
                        if let Some(role) = &cube.render_role {
                            if let Some(pid) = ctx.render_roles.get(role) {
                                if let Some(p) = ctx.pipelines.get(pid) {
                                    render_pass.set_pipeline(p);
                                    pipeline_set = true;
                                }
                            }
                        }

                        // 2. Check Explicit Pipeline
                        if !pipeline_set {
                            if let Some(pid) = &cube.pipeline_id {
                                if pid != "default" {
                                    if let Some(custom_pipeline) = ctx.pipelines.get(pid) {
                                        render_pass.set_pipeline(custom_pipeline);
                                        pipeline_set = true;
                                    }
                                }
                            }
                        }

                        if !pipeline_set {
                            render_pass.set_pipeline(&geometry_pipeline);
                        }

                        cube.transform.update_uniform_buffer(&queue);
                        render_pass.set_bind_group(1, &cube.bind_group, &[]);
                        render_pass.set_bind_group(3, &cube.group_bind_group, &[]);
                        render_pass.set_vertex_buffer(0, cube.vertex_buffer.slice(..));
                        render_pass.set_index_buffer(
                            cube.index_buffer.slice(..),
                            wgpu::IndexFormat::Uint32,
                        );
                        render_pass.draw_indexed(0..cube.index_count as u32, 0, 0..1);
                    }

                    for landscape in &pbr_landscapes {
                        let mut pipeline_set = false;

                        // 1. Check Role Override
                        if let Some(role) = &landscape.render_role {
                            if let Some(pid) = ctx.render_roles.get(role) {
                                if let Some(p) = ctx.pipelines.get(pid) {
                                    render_pass.set_pipeline(p);
                                    pipeline_set = true;
                                }
                            }
                        }

                        if !pipeline_set {
                            if let Some(pid) = &landscape.pipeline_id {
                                if pid != "default" {
                                    if let Some(custom_pipeline) = ctx.pipelines.get(pid) {
                                        render_pass.set_pipeline(custom_pipeline);
                                        pipeline_set = true;
                                    }
                                }
                            }
                        }

                        if !pipeline_set {
                            render_pass.set_pipeline(&geometry_pipeline);
                        }

                        landscape.transform.update_uniform_buffer(&queue);
                        render_pass.set_bind_group(1, &landscape.bind_group, &[]);
                        render_pass.set_bind_group(3, &landscape.group_bind_group, &[]);
                        render_pass.set_vertex_buffer(0, landscape.vertex_buffer.slice(..));
                        render_pass.set_index_buffer(
                            landscape.index_buffer.slice(..),
                            wgpu::IndexFormat::Uint32,
                        );
                        render_pass.draw_indexed(0..landscape.index_count as u32, 0, 0..1);
                    }

                    for landscape in &pbr_landscape3ds {
                        let mut pipeline_set = false;

                        // 1. Check Role Override
                        if let Some(role) = &landscape.render_role {
                            if let Some(pid) = ctx.render_roles.get(role) {
                                if let Some(p) = ctx.pipelines.get(pid) {
                                    render_pass.set_pipeline(p);
                                    pipeline_set = true;
                                }
                            }
                        }

                        if !pipeline_set {
                            if let Some(pid) = &landscape.pipeline_id {
                                if pid != "default" {
                                    if let Some(custom_pipeline) = ctx.pipelines.get(pid) {
                                        render_pass.set_pipeline(custom_pipeline);
                                        pipeline_set = true;
                                    }
                                }
                            }
                        }

                        if !pipeline_set {
                            render_pass.set_pipeline(&geometry_pipeline);
                        }

                        landscape.transform.update_uniform_buffer(&queue);
                        render_pass.set_bind_group(1, &landscape.bind_group, &[]);
                        render_pass.set_bind_group(3, &landscape.group_bind_group, &[]);
                        render_pass.set_vertex_buffer(0, landscape.vertex_buffer.slice(..));
                        render_pass.set_index_buffer(
                            landscape.index_buffer.slice(..),
                            wgpu::IndexFormat::Uint32,
                        );
                        render_pass.draw_indexed(0..landscape.index_count as u32, 0, 0..1);
                    }

                    for landscape in pbr_quadscapes {
                        let mut pipeline_set = false;

                        if !pipeline_set {
                            render_pass.set_pipeline(&geometry_pipeline);
                        }

                        landscape.update(Vector3::new(camera.position.x, camera.position.y, camera.position.z), &device, &mut renderer_state.rigid_body_set, &mut renderer_state.collider_set);
                        draw_quadscape(landscape, &mut render_pass);
                    }

                    // println!("Pbr Meshes {:?}", pbr_meshes.len());
                    // println!("Pbr mesh 10th position {:?}", pbr_meshes.get(10).and_then(|m| Some(m.transform.position)));

                    for mesh in &pbr_meshes {
                        let mut pipeline_set = false;

                        // 1. Check Role Override
                        // if let Some(role) = &mesh.render_role {
                        //     if let Some(pid) = ctx.render_roles.get(role) {
                        //         if let Some(p) = ctx.pipelines.get(pid) {
                        //             render_pass.set_pipeline(p);
                        //             pipeline_set = true;
                        //         }
                        //     }
                        // }

                        if !pipeline_set {
                            if mesh.pipeline_id == "default" {
                                render_pass.set_pipeline(geometry_pipeline);
                                pipeline_set = true;
                                // println!("default");
                            } else {
                                render_pass.set_pipeline(&mesh.pipeline);
                                // println!("custom");
                            }
                        }
                        
                        render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                        render_pass.set_bind_group(1, &mesh.model_bind_group, &[]);

                        if mesh.pipeline_id == "default" {
                            // println!("~~~~~~~~~~ THE EViL DefAULT pipeLINE");
                            render_pass.set_bind_group(2, window_size_bind_group, &[]);
                            render_pass.set_bind_group(3, &mesh.group_bind_group, &[]);
                        } else {
                            // println!("~~~~~~~~~~ THE GOOOOOD pipeLINE");
                            for (i, bind_group) in mesh.bind_groups.iter().enumerate() {
                                render_pass.set_bind_group((i + 2) as u32, bind_group, &[]);
                            }
                        }

                        if let Some(time_buffer) = &mesh.time_buffer {
                            queue.write_buffer(time_buffer, 0, bytemuck::cast_slice(&[time as f32]));
                        }

                        mesh.transform.update_uniform_buffer(&queue);
                        render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                        render_pass.set_index_buffer(
                            mesh.index_buffer.slice(..),
                            wgpu::IndexFormat::Uint32,
                        );
                        render_pass.draw_indexed(0..mesh.num_indices, 0, 0..mesh.instance_count);

                        // println!("~~~~~~~~~~ THE GOOOOOD draw");
                    }

                    for model in &pbr_addon_models {
                        for mesh in &model.meshes {
                            let mut pipeline_set = false;
                            
                            // 1. Check Role Override
                            if let Some(role) = &mesh.render_role {
                                if let Some(pid) = ctx.render_roles.get(role) {
                                    if let Some(p) = ctx.pipelines.get(pid) {
                                        render_pass.set_pipeline(p);
                                        pipeline_set = true;
                                    }
                                }
                            }

                            if !pipeline_set {
                                if let Some(skin_bind_group) = &model.skin_bind_group {
                                    if let Some(pipeline_instance) = &renderer_state.skinned_pipeline {
                                        render_pass.set_pipeline(&pipeline_instance.render_pipeline);
                                        render_pass.set_bind_group(2, skin_bind_group, &[]);
                                    } else {
                                        render_pass.set_pipeline(geometry_pipeline);
                                    }
                                } else {
                                    render_pass.set_pipeline(geometry_pipeline);
                                }
                            }

                            mesh.transform.update_uniform_buffer(queue);
                            render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                            render_pass.set_bind_group(1, &mesh.bind_group, &[]);
                            render_pass.set_bind_group(3, &mesh.group_bind_group, &[]);

                            render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                            render_pass.set_index_buffer(
                                mesh.index_buffer.slice(..),
                                wgpu::IndexFormat::Uint32,
                            );
                            render_pass.draw_indexed(0..mesh.index_count as u32, 0, 0..1);
                        }
                    }

                    // --- Entity Visuals (NPCs and Player Instances) ---
                    let mut entities_to_render = Vec::new();
                    if let Some(player) = &renderer_state.player_character {
                        if player.transform.is_some() && player.model_id.is_some() {
                            entities_to_render.push((player.model_id.as_ref().unwrap(), player.transform.as_ref().unwrap(), &player.model_bind_group, &player.skin_bind_group));
                        }
                    }
                    for npc in &renderer_state.npcs {
                        if npc.transform.is_some() && !npc.model_id.is_empty() {
                            entities_to_render.push((&npc.model_id, npc.transform.as_ref().unwrap(), &npc.model_bind_group, &npc.skin_bind_group));
                        }
                    }

                    // if renderer_state.npcs.len() > 0 {
                    //     println!("NPCS: {:?} and {:?}", renderer_state.npcs.len(), entities_to_render.len());    
                    // }

                    for (template_id, transform, model_bg, skin_bg) in entities_to_render {
                        // Find Template (CustomMesh or Model)
                        if let Some(mesh) = renderer_state.addon_meshes.values().flatten().find(|m| &m.id == template_id) {
                            // println!("Mesh load {:?} {:?} {:?}", template_id, mesh.pipeline_id, transform.position);
                            if mesh.pipeline_id == "default" {
                                render_pass.set_pipeline(geometry_pipeline);
                            } else {
                                render_pass.set_pipeline(&mesh.pipeline);
                            }
                            render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                            if let Some(bg) = model_bg { render_pass.set_bind_group(1, bg, &[]); }
                            if let Some(bg) = skin_bg { render_pass.set_bind_group(2, bg, &[]); }
                            
                            for (i, bind_group) in mesh.bind_groups.iter().enumerate() {
                                render_pass.set_bind_group((i + 3) as u32, bind_group, &[]);
                            }

                            transform.update_uniform_buffer(queue);
                            render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                            render_pass.set_index_buffer(mesh.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                            render_pass.draw_indexed(0..mesh.num_indices, 0, 0..1);
                        } else if let Some(model) = renderer_state.models.iter().chain(renderer_state.addon_models.values().flatten()).find(|m| &m.id == template_id) {
                            for mesh in &model.meshes {
                                if let Some(skin_bg_instance) = skin_bg {
                                    if let Some(pipeline_instance) = &renderer_state.skinned_pipeline {
                                        render_pass.set_pipeline(&pipeline_instance.render_pipeline);
                                        render_pass.set_bind_group(2, skin_bg_instance, &[]);
                                    } else {
                                        render_pass.set_pipeline(geometry_pipeline);
                                    }
                                } else {
                                    render_pass.set_pipeline(geometry_pipeline);
                                }

                                transform.update_uniform_buffer(queue);
                                render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                                if let Some(bg) = model_bg { render_pass.set_bind_group(1, bg, &[]); }
                                render_pass.set_bind_group(3, &mesh.group_bind_group, &[]);

                                render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                                render_pass.set_index_buffer(mesh.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                                render_pass.draw_indexed(0..mesh.index_count as u32, 0, 0..1);
                            }
                        }
                    }

                    for grass in &mut pbr_grasses {
                        let mut pipeline_set = false;

                        // 1. Check Role Override
                        if let Some(role) = &grass.render_role {
                            if let Some(pid) = ctx.render_roles.get(role) {
                                if let Some(p) = ctx.pipelines.get(pid) {
                                    render_pass.set_pipeline(p);
                                    pipeline_set = true;
                                }
                            }
                        }

                        if !pipeline_set {
                            render_pass.set_pipeline(&grass.render_pipeline);
                        }

                        // Update uniforms
                        if let Some(player_character) = &renderer_state.player_character {
                            if let Some(model_id) = &player_character.model_id {
                                let player_model = renderer_state.models.iter().find(|m| m.id == model_id.clone());
                                if let Some(player_model) = player_model {
                                    let model_mesh = player_model.meshes.get(0);
                                    if let Some(model_mesh) = model_mesh {
                                        grass.update_uniforms(&queue, time as f32, Point3::new(model_mesh.transform.position.x, model_mesh.transform.position.y, model_mesh.transform.position.z));
                                    } else {
                                        grass.update_uniforms(&queue, time as f32, camera.position);
                                    }
                                } else {
                                    grass.update_uniforms(&queue, time as f32, camera.position);
                                }
                            } else if let Some(sphere) = &player_character.sphere {
                                grass.update_uniforms(&queue, time as f32, Point3::new(sphere.transform.position.x, sphere.transform.position.y, sphere.transform.position.z));
                            } else {
                                grass.update_uniforms(&queue, time as f32, camera.position);
                            }
                        } else {
                            grass.update_uniforms(&queue, time as f32, camera.position);
                        }

                        render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                        render_pass.set_bind_group(1, &grass.uniform_bind_group, &[]);
                        // render_pass.set_bind_group(2, &grass.landscape_bind_group, &[]); // now set in JS explicitly

                        for (i, bind_group) in grass.bind_groups.iter().enumerate() {
                            render_pass.set_bind_group((i + 2) as u32, bind_group, &[]);
                        }

                        render_pass.set_vertex_buffer(0, grass.blade.vertex_buffer.slice(..));
                        render_pass.set_index_buffer(grass.blade.index_buffer.slice(..), wgpu::IndexFormat::Uint16);

                        let grid_cells = ((grass.config.render_distance * 2.0) / grass.config.grid_size).ceil() as u32;
                        let total_instances = grid_cells * grid_cells * grass.config.blade_density as u32;

                        render_pass.draw_indexed(0..grass.blade.index_count, 0, 0..total_instances);
                    }
                }
            }
            drop(render_pass);

            // Update point lights buffer for addons
            let mut collected_lights = if pipeline.current_workspace == Workspace::GameEngine {
                renderer_state.point_lights.clone()
            } else {
                Vec::new()
            };

            for (addon_name, lights) in &renderer_state.addon_point_lights {
                if let Workspace::Addon(active_name) = &pipeline.current_workspace {
                    if addon_name == active_name || addon_name == "Global" {
                        collected_lights.extend(lights.clone());
                    }
                } else if addon_name == "Global" {
                    collected_lights.extend(lights.clone());
                }
            }

            let mut point_lights_uniform_data = crate::core::editor::PointLightsUniform {
                point_lights: [[0.0; 12]; crate::core::editor::MAX_POINT_LIGHTS],
                num_point_lights: collected_lights.len().min(crate::core::editor::MAX_POINT_LIGHTS) as u32,
                _padding: [0; 3],
            };

            for (i, pl) in collected_lights.iter().take(crate::core::editor::MAX_POINT_LIGHTS).enumerate() {
                 point_lights_uniform_data.point_lights[i] = [
                    pl.position[0], pl.position[1], pl.position[2], 0.0,
                    pl.color[0], pl.color[1], pl.color[2], 0.0,
                    pl.intensity, pl.max_distance, 0.0, 0.0
                ];
            }
            
            queue.write_buffer(
                pipeline.point_lights_buffer.as_ref().unwrap(),
                0,
                bytemuck::cast_slice(&[point_lights_uniform_data]),
            );

            

            // 2. Lighting Pass for PBR objects
            let mut custom_lighting_pid = None;
            let mut extra_lighting_bind_groups = Vec::new();
            
            {
                let mut op_state = editor.addon_engine.runtime.op_state();
                let op_state = op_state.borrow();
                if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                    // Find if any used pipeline has a custom lighting pipeline
                    for cube in &pbr_cubes {
                        if let Some(pid) = &cube.pipeline_id {
                            if ctx.lighting_pipelines.contains_key(pid) {
                                custom_lighting_pid = Some(pid.clone());
                                if let Some(bgs) = ctx.lighting_bind_groups.get(pid) {
                                    extra_lighting_bind_groups = bgs.clone();
                                }
                                break;
                            }
                        }
                    }
                }
            }

            let lighting_bind_group = pipeline.lighting_bind_group.as_ref().unwrap();
            let g_buffer_bind_group = pipeline.g_buffer_bind_group.as_ref().unwrap();
            let shadow_pipeline_data = pipeline.shadow_pipeline_data.as_ref().unwrap();
            let shadow_bind_group = &shadow_pipeline_data.shadow_bind_group;

            let mut lighting_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Addon Lighting Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        // load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        // load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.85, g: 0.05, b: 0.05, a: 1.0 }),
                            load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            if let Some(rect) = viewport_rect {
                // lighting_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
                lighting_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
            }

            if let Some(pid) = &custom_lighting_pid {
                let mut op_state = editor.addon_engine.runtime.op_state();
                let op_state = op_state.borrow();
                if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                    if let Some(lp) = ctx.lighting_pipelines.get(pid) {
                        lighting_pass.set_pipeline(lp);
                    }
                }
            } else {
                lighting_pass.set_pipeline(pipeline.lighting_pipeline.as_ref().unwrap());
            }

            lighting_pass.set_bind_group(0, lighting_bind_group, &[]);
            lighting_pass.set_bind_group(1, g_buffer_bind_group, &[]);
            lighting_pass.set_bind_group(2, &camera_binding.bind_group, &[]);
            lighting_pass.set_bind_group(3, shadow_bind_group, &[]);

            // Set extra bind groups for custom lighting
            for (i, bg) in extra_lighting_bind_groups.iter().enumerate() {
                lighting_pass.set_bind_group((i + 4) as u32, bg, &[]);
            }

            lighting_pass.draw(0..3, 0..1);
            drop(lighting_pass);
        }

        // 3. Pass for non-PBR objects
        if !non_pbr_cubes.is_empty() || !non_pbr_landscapes.is_empty() || !non_pbr_grasses.is_empty() || !non_pbr_meshes.is_empty() || !non_pbr_addon_models.is_empty() {
            let has_pbr = !pbr_cubes.is_empty() || !pbr_landscapes.is_empty();
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Addon non-PBR Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        // load: if !has_pbr { wgpu::LoadOp::Clear(wgpu::Color::BLACK) } else { wgpu::LoadOp::Load },
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: if !has_pbr { wgpu::LoadOp::Clear(1.0) } else { wgpu::LoadOp::Load },
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            if let Some(rect) = viewport_rect {
                // render_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
                render_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
            }

            render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
            render_pass.set_bind_group(2, window_size_bind_group, &[]);

            {
                let op_state = editor.addon_engine.runtime.op_state();
                let op_state = op_state.borrow();
                if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                    
                    for cube in &non_pbr_cubes {
                        let mut pipeline_set = false;

                        // 1. Check Role Override
                        if let Some(role) = &cube.render_role {
                            if let Some(pid) = ctx.render_roles.get(role) {
                                if let Some(p) = ctx.pipelines.get(pid) {
                                    render_pass.set_pipeline(p);
                                    pipeline_set = true;
                                }
                            }
                        }

                        if !pipeline_set {
                            if let Some(pid) = &cube.pipeline_id {
                                if pid != "default" {
                                    if let Some(custom_pipeline) = ctx.pipelines.get(pid) {
                                        render_pass.set_pipeline(custom_pipeline);
                                        pipeline_set = true;
                                    }
                                }
                            }
                        }

                        if !pipeline_set {
                            // Non-PBR with default pipeline is not ideal as geometry_pipeline expects G-buffer targets
                            // But we'll use it if nothing else is set
                            render_pass.set_pipeline(&geometry_pipeline);
                        }

                        cube.transform.update_uniform_buffer(&queue);
                        render_pass.set_bind_group(1, &cube.bind_group, &[]);
                        render_pass.set_bind_group(3, &cube.group_bind_group, &[]);
                        render_pass.set_vertex_buffer(0, cube.vertex_buffer.slice(..));
                        render_pass.set_index_buffer(
                            cube.index_buffer.slice(..),
                            wgpu::IndexFormat::Uint32,
                        );
                        render_pass.draw_indexed(0..cube.index_count as u32, 0, 0..1);
                    }

                    for landscape in &non_pbr_landscapes {
                        let mut pipeline_set = false;

                        // 1. Check Role Override
                        if let Some(role) = &landscape.render_role {
                            if let Some(pid) = ctx.render_roles.get(role) {
                                if let Some(p) = ctx.pipelines.get(pid) {
                                    render_pass.set_pipeline(p);
                                    pipeline_set = true;
                                }
                            }
                        }

                        if !pipeline_set {
                            if let Some(pid) = &landscape.pipeline_id {
                                if pid != "default" {
                                    if let Some(custom_pipeline) = ctx.pipelines.get(pid) {
                                        render_pass.set_pipeline(custom_pipeline);
                                        pipeline_set = true;
                                    }
                                }
                            }
                        }

                        if !pipeline_set {
                            render_pass.set_pipeline(&geometry_pipeline);
                        }

                        landscape.transform.update_uniform_buffer(&queue);
                        render_pass.set_bind_group(1, &landscape.bind_group, &[]);
                        render_pass.set_bind_group(3, &landscape.group_bind_group, &[]);
                        render_pass.set_vertex_buffer(0, landscape.vertex_buffer.slice(..));
                        render_pass.set_index_buffer(
                            landscape.index_buffer.slice(..),
                            wgpu::IndexFormat::Uint32,
                        );
                        render_pass.draw_indexed(0..landscape.index_count as u32, 0, 0..1);
                    }

                    for landscape in &non_pbr_landscape3ds {
                        let mut pipeline_set = false;

                        // 1. Check Role Override
                        if let Some(role) = &landscape.render_role {
                            if let Some(pid) = ctx.render_roles.get(role) {
                                if let Some(p) = ctx.pipelines.get(pid) {
                                    render_pass.set_pipeline(p);
                                    pipeline_set = true;
                                }
                            }
                        }

                        if !pipeline_set {
                            if let Some(pid) = &landscape.pipeline_id {
                                if pid != "default" {
                                    if let Some(custom_pipeline) = ctx.pipelines.get(pid) {
                                        render_pass.set_pipeline(custom_pipeline);
                                        pipeline_set = true;
                                    }
                                }
                            }
                        }

                        if !pipeline_set {
                            render_pass.set_pipeline(&geometry_pipeline);
                        }

                        landscape.transform.update_uniform_buffer(&queue);
                        render_pass.set_bind_group(1, &landscape.bind_group, &[]);
                        render_pass.set_bind_group(3, &landscape.group_bind_group, &[]);
                        render_pass.set_vertex_buffer(0, landscape.vertex_buffer.slice(..));
                        render_pass.set_index_buffer(
                            landscape.index_buffer.slice(..),
                            wgpu::IndexFormat::Uint32,
                        );
                        render_pass.draw_indexed(0..landscape.index_count as u32, 0, 0..1);
                    }

                    for mesh in &non_pbr_meshes {
                        let mut pipeline_set = false;

                        // 1. Check Role Override
                        if let Some(role) = &mesh.render_role {
                            if let Some(pid) = ctx.render_roles.get(role) {
                                if let Some(p) = ctx.pipelines.get(pid) {
                                    render_pass.set_pipeline(p);
                                    pipeline_set = true;
                                }
                            }
                        }

                        if !pipeline_set {
                            render_pass.set_pipeline(&mesh.pipeline);
                        }

                        render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                        
                        // Create a temporary bind group for the transform
                        let transform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                            layout: &renderer_state.model_bind_group_layout,
                            entries: &[wgpu::BindGroupEntry {
                                binding: 0,
                                resource: mesh.transform.uniform_buffer.as_entire_binding(),
                            }],
                            label: Some("Mesh Transform Bind Group"),
                        });
                        render_pass.set_bind_group(1, &transform_bind_group, &[]);

                        for (i, bind_group) in mesh.bind_groups.iter().enumerate() {
                            render_pass.set_bind_group((i + 2) as u32, bind_group, &[]);
                        }
                        
                        if let Some(time_buffer) = &mesh.time_buffer {
                            queue.write_buffer(time_buffer, 0, bytemuck::cast_slice(&[time as f32]));
                        }
                        
                                                mesh.transform.update_uniform_buffer(&queue);
                        
                                                render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                        
                                                render_pass.set_index_buffer(
                        
                                                    mesh.index_buffer.slice(..),
                        
                                                    wgpu::IndexFormat::Uint32,
                        
                                                );
                        
                                                render_pass.draw_indexed(0..mesh.num_indices, 0, 0..mesh.instance_count);
                        
                                            }
                        
                        
                        
                                            for model in &non_pbr_addon_models {
                        
                                                for mesh in &model.meshes {
                        
                                                    let mut pipeline_set = false;
                        
                                                    
                        
                                                    // 1. Check Role Override
                        
                                                    if let Some(role) = &mesh.render_role {
                        
                                                        if let Some(pid) = ctx.render_roles.get(role) {
                        
                                                            if let Some(p) = ctx.pipelines.get(pid) {
                        
                                                                render_pass.set_pipeline(p);
                        
                                                                pipeline_set = true;
                        
                                                            }
                        
                                                        }
                        
                                                    }
                        
                        
                        
                                                    if !pipeline_set {
                        
                                                        // For non-PBR pass, we don't have a dedicated skinned non-PBR pipeline in RendererState usually,
                        
                                                        // but we should check if one is available or just fallback to geometry_pipeline.
                        
                                                        // Actually, geometry_pipeline is often PBR-ish (expects G-buffer).
                        
                                                        // This is a bit of a gray area in current renderer state for non-PBR.
                        
                                                        render_pass.set_pipeline(geometry_pipeline);
                        
                                                    }
                        
                        
                        
                                                    mesh.transform.update_uniform_buffer(queue);
                        
                                                    render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                        
                                                    render_pass.set_bind_group(1, &mesh.bind_group, &[]);
                        
                                                    render_pass.set_bind_group(3, &mesh.group_bind_group, &[]);
                        
                        
                        
                                                    render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                        
                                                    render_pass.set_index_buffer(
                        
                                                        mesh.index_buffer.slice(..),
                        
                                                        wgpu::IndexFormat::Uint32,
                        
                                                    );
                        
                                                    render_pass.draw_indexed(0..mesh.index_count as u32, 0, 0..1);
                        
                                                }
                        
                                            }
                        
                        
                        
                                            for grass in &mut non_pbr_grasses {
                        let mut pipeline_set = false;

                        // 1. Check Role Override
                        if let Some(role) = &grass.render_role {
                            if let Some(pid) = ctx.render_roles.get(role) {
                                if let Some(p) = ctx.pipelines.get(pid) {
                                    render_pass.set_pipeline(p);
                                    pipeline_set = true;
                                }
                            }
                        }

                        if !pipeline_set {
                            render_pass.set_pipeline(&grass.render_pipeline);
                        }

                        // Update uniforms
                        if let Some(player_character) = &renderer_state.player_character {
                            if let Some(model_id) = &player_character.model_id {
                                let player_model = renderer_state.models.iter().find(|m| m.id == model_id.clone());
                                if let Some(player_model) = player_model {
                                    let model_mesh = player_model.meshes.get(0);
                                    if let Some(model_mesh) = model_mesh {
                                        grass.update_uniforms(&queue, time as f32, Point3::new(model_mesh.transform.position.x, model_mesh.transform.position.y, model_mesh.transform.position.z));
                                    } else {
                                        grass.update_uniforms(&queue, time as f32, camera.position);
                                    }
                                } else {
                                    grass.update_uniforms(&queue, time as f32, camera.position);
                                }
                            } else if let Some(sphere) = &player_character.sphere {
                                grass.update_uniforms(&queue, time as f32, Point3::new(sphere.transform.position.x, sphere.transform.position.y, sphere.transform.position.z));
                            } else {
                                grass.update_uniforms(&queue, time as f32, camera.position);
                            }
                        } else {
                            grass.update_uniforms(&queue, time as f32, camera.position);
                        }

                        render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                        render_pass.set_bind_group(1, &grass.uniform_bind_group, &[]);
                        render_pass.set_bind_group(2, &grass.landscape_bind_group, &[]);

                        for (i, bind_group) in grass.bind_groups.iter().enumerate() {
                            render_pass.set_bind_group((i + 3) as u32, bind_group, &[]);
                        }

                        render_pass.set_vertex_buffer(0, grass.blade.vertex_buffer.slice(..));
                        render_pass.set_index_buffer(grass.blade.index_buffer.slice(..), wgpu::IndexFormat::Uint16);

                        let grid_cells = ((grass.config.render_distance * 2.0) / grass.config.grid_size).ceil() as u32;
                        let total_instances = grid_cells * grid_cells * grass.config.blade_density as u32;

                        render_pass.draw_indexed(0..grass.blade.index_count, 0, 0..total_instances);
                    }
                }
            }
            drop(render_pass);
        }

        // 1.5 Procedural Sky Pass
            {
                let mut sky_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Addon Procedural Sky Pass"),
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

                if let Some(rect) = viewport_rect {
                    sky_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
                }

                sky_pass.set_pipeline(pipeline.procedural_sky_pipeline.as_ref().unwrap());
                sky_pass.set_bind_group(0, pipeline.procedural_sky_bind_group.as_ref().unwrap(), &[]);
                sky_pass.draw(0..3, 0..1);
            }

            // NEW: Composite Texture Pass (for compute-rendered particles, etc.)
            {
                let mut op_state = editor.addon_engine.runtime.op_state();
                let op_state = op_state.borrow();
                if let Some(ctx) = op_state.try_borrow::<AddonContext>() {
                    for composite in &ctx.composites {
                        let mut composite_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                            label: Some(&format!("Composite Pass: {}", composite.name)),
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

                        if let Some(rect) = viewport_rect {
                            composite_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
                        }

                        composite_pass.set_pipeline(&composite.pipeline);
                        
                        // Create bind group on-the-fly for the texture
                        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                            address_mode_u: wgpu::AddressMode::ClampToEdge,
                            address_mode_v: wgpu::AddressMode::ClampToEdge,
                            address_mode_w: wgpu::AddressMode::ClampToEdge,
                            mag_filter: wgpu::FilterMode::Linear,
                            min_filter: wgpu::FilterMode::Linear,
                            mipmap_filter: wgpu::FilterMode::Nearest,
                            ..Default::default()
                        });

                        let bind_group_layout = composite.pipeline.get_bind_group_layout(1);
                        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                            layout: &bind_group_layout,
                            entries: &[
                                wgpu::BindGroupEntry {
                                    binding: 0,
                                    resource: wgpu::BindingResource::TextureView(&composite.texture_view),
                                },
                                wgpu::BindGroupEntry {
                                    binding: 1,
                                    resource: wgpu::BindingResource::Sampler(&sampler),
                                },
                                wgpu::BindGroupEntry {
                                    binding: 2,
                                    resource: wgpu::BindingResource::TextureView(&depth_view),
                                },
                            ],
                            label: Some("Composite Bind Group"),
                        });

                        composite_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                        composite_pass.set_bind_group(1, &bind_group, &[]);
                        
                        for (i, extra_bg) in composite.bind_groups.iter().enumerate() {
                            composite_pass.set_bind_group((i + 2) as u32, extra_bg, &[]);
                        }

                        if let Some(time_buffer) = &composite.time_buffer {
                            queue.write_buffer(time_buffer, 0, bytemuck::cast_slice(&[time as f32]));
                        }

                        // println!("Render Composite");

                        composite_pass.draw(0..3, 0..1);
                    }
                }
            }

            // Gizmo Render Pass
            let gizmo_draw_data = renderer_state.gizmo.draw();
            if !renderer_state.game_mode && !gizmo_draw_data.vertices.is_empty() {
                let gizmo_vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Addon Gizmo Vertex Buffer"),
                    contents: bytemuck::cast_slice(&gizmo_draw_data.vertices),
                    usage: wgpu::BufferUsages::VERTEX,
                });

                let gizmo_color_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Addon Gizmo Color Buffer"),
                    contents: bytemuck::cast_slice(&gizmo_draw_data.colors),
                    usage: wgpu::BufferUsages::VERTEX,
                });

                let gizmo_index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Addon Gizmo Index Buffer"),
                    contents: bytemuck::cast_slice(&gizmo_draw_data.indices),
                    usage: wgpu::BufferUsages::INDEX,
                });

                let mut gizmo_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Addon Gizmo Pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    })],
                    depth_stencil_attachment: None, // Gizmo usually draws on top without depth
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });

                if let Some(rect) = viewport_rect {
                    gizmo_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
                }

                gizmo_pass.set_pipeline(pipeline.gizmo_pipeline.as_ref().unwrap());
                gizmo_pass.set_bind_group(0, window_size_bind_group, &[]);
                gizmo_pass.set_vertex_buffer(0, gizmo_vertex_buffer.slice(..));
                gizmo_pass.set_vertex_buffer(1, gizmo_color_buffer.slice(..));
                gizmo_pass.set_index_buffer(gizmo_index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                gizmo_pass.draw_indexed(0..gizmo_draw_data.indices.len() as u32, 0, 0..1);
            }

            {
                if let Some(pipeline) = &pipeline.debug_sphere_pipeline {
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

                    if let Some(rect) = viewport_rect {
                        // debug_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
                        debug_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
                    }

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

            // UI Render Pass
            {
                if let Some(ui_pipeline) = pipeline.ui_pipeline.as_ref() {
                    let camera_binding = editor.camera_binding.as_ref().unwrap();
                    let window_size_bind_group = pipeline
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

                    if let Some(rect) = viewport_rect {
                        // ui_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
                        ui_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
                    }

                    ui_pipeline.render(
                        &mut ui_pass,
                        editor,
                        &camera_binding.bind_group,
                        window_size_bind_group,
                        queue,
                    );
                }
            }

        if pipeline.frame_buffer.is_some() {
            let frame_buffer = pipeline
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
