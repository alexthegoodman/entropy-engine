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

// note: render_addon_frame is used today, while this render_frame is legacy code kept for reference only
pub fn render_frame(pipeline: &mut EntropyPipeline, target_view: Option<&wgpu::TextureView>, current_time: f64, game_mode: bool, viewport_rect: Option<[f32; 4]>) {
        let editor = pipeline.export_editor.as_mut().expect("Couldn't get editor");
        let renderer_state = editor.renderer_state.as_mut().expect("Couldn't get RendererState");
        
        // Process pending loot drops
        if !renderer_state.pending_loot_drops.is_empty() {
            let loot_drops: Vec<_> = renderer_state.pending_loot_drops.drain(..).collect();
            let gpu_resources = pipeline.gpu_resources.as_ref().expect("Couldn't get gpu resources");
            let project_id = editor.project_id.clone();
            let camera = editor.camera.as_ref().expect("Couldn't get camera").clone();

            for (pos, item) in loot_drops {
                let mut item_comp = item.clone();
                // Ensure unique ID for the world instance
                item_comp.id = Uuid::new_v4().to_string();
                
                let isometry = Isometry3::translation(pos.x, pos.y, pos.z);
                let scale = Vector3::new(
                    item.generic_properties.scale[0],
                    item.generic_properties.scale[1],
                    item.generic_properties.scale[2]
                );

                // Find related stat
                let dummy_stat = crate::helpers::saved_data::StatData::default();
                let stat_id = item.collectable_properties.as_ref().and_then(|p| p.stat_id.clone());
                let related_stat = if let Some(sid) = stat_id {
                    editor.world_state.as_ref()
                        .and_then(|s| s.stats.as_ref())
                        .and_then(|stats| stats.iter().find(|s| s.id == sid))
                        .unwrap_or(&dummy_stat)
                } else {
                    &dummy_stat
                };

                pollster::block_on(crate::handlers::handle_add_collectable(
                    renderer_state,
                    &gpu_resources.device,
                    &gpu_resources.queue,
                    project_id.as_ref().expect("Couldn't get project id").clone(),
                    item.asset_id.clone(),
                    item_comp.id.clone(),
                    item.asset_id.clone(), // filename assumed to be asset_id for now if not specified? 
                    // Actually handle_add_collectable uses modelFilename. 
                    // Let's assume asset_id is the filename if modelFilename not in ComponentData
                    // item.asset_id.clone(),
                    isometry,
                    scale,
                    &camera,
                    item.collectable_properties.as_ref().expect("No collectable properties"),
                    related_stat,
                    false, // hide_in_world
                    item.script_state.clone(),
                    None // behavior_id
                ));
            }
        }

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
        // let camera = pipeline.camera.as_ref().expect("Couldn't get camera"); // careful, we have a camera on editor and on pipeline
        let texture = pipeline.texture.as_ref().expect("Couldn't get texture");
        
        // // Sync player health to UI
        // if let Some(player) = &mut renderer_state.player_character {
        //     if let Some(health_bar) = &mut editor.health_bar {
        //         health_bar.update_health(queue, player.stats.health);
        //     }

        //     // Update Aim
        //     player.update_aim(0.016);
        //     let target_fov = camera.base_fovy * (1.0 - (player.aim_factor * 0.4)); // 40% zoom
        //     camera.fovy = target_fov;
        //     // camera.update_view_projection_matrix(); // Called in step_physics_pipeline or later? 
        //     // Better call it here to be safe, but update() is called in step_physics_pipeline?
        //     // step_physics_pipeline calls camera.update()
            
        //     if let Some(mini_map) = &mut editor.mini_map {
        //         if let Some(rb_handle) = player.movement_rigid_body_handle {
        //              if let Some(rb) = renderer_state.rigid_body_set.get(rb_handle) {
        //                 let position = rb.translation();
        //                 let yaw = renderer_state.camera_yaw;
        //                 let landscape_center = Vector3::new(0.0, 0.0, 0.0);
        //                 let landscape_size = 4096.0; // Matches grid size for now

        //                 mini_map.update_all(queue, *position, yaw, landscape_center, landscape_size, &renderer_state.npcs, &renderer_state.collectables, &renderer_state.rigid_body_set, camera);
        //              }
        //         }
        //     }

        //     // Handle Firing
        //     if player.is_firing {
        //         let mut fire_type = saved_data::FireType::Manual;
        //         if let Some(weapon) = &player.inventory.equipped_weapon {
        //             if let Some(props) = &weapon.collectable_properties {
        //                 if let Some(ft) = &props.fire_type {
        //                     fire_type = ft.clone();
        //                 }
        //             }
        //         }

        //         let mut should_attack = false;
        //         match fire_type {
        //             saved_data::FireType::Automatic => {
        //                 should_attack = true;
        //             }
        //             saved_data::FireType::SemiAutomatic | saved_data::FireType::Manual => {
        //                 if !player.has_fired_this_press {
        //                     should_attack = true;
        //                     player.has_fired_this_press = true;
        //                 }
        //             }
        //         }

        //         if should_attack {
        //             let (attacked_npc_id, debug_line) = player.attack(
        //                 &renderer_state.rigid_body_set,
        //                 &renderer_state.collider_set,
        //                 &mut renderer_state.query_pipeline,
        //                 &mut renderer_state.npcs,
        //                 camera,
        //             );
                    
        //             if let Some(id) = attacked_npc_id {
        //                 editor.current_enemy_target = Some(id.clone());
        //                 println!("Updated enemy target: {:?}", id);

        //                 // Alert nearby NPCs when one is hit
        //                 if let Some(npc) = renderer_state.npcs.iter().find(|n| n.id == id) {
        //                     if let Some(rb) = renderer_state.rigid_body_set.get(npc.rigid_body_handle) {
        //                         let alert_pos = rb.translation();
        //                         let alert_pos = Vector3::new(alert_pos.x, alert_pos.y, alert_pos.z);

        //                         renderer_state.alert_nearby_npcs(alert_pos, 40.0); // Slightly larger radius for being hit
        //                     }
        //                 }
        //             }

        //             // Execute Rhai on_attack scripts for the player
        //             // let mut script_changes = Vec::new();
        //             // if let Some(world_state) = &editor.world_state {
        //             //     if let Some(levels) = &world_state.levels {
        //             //         if let Some(components) = levels.get(0).and_then(|l| l.components.as_ref()) {
        //             //             for component in components.iter() {
        //             //                 if component.kind == Some(ComponentKind::PlayerCharacter) {
        //             //                     if let Some(script_path) = &component.js_script_path {
        //             //                         if let Some(change) = editor.deno_engine.execute_component_script(
        //             //                             renderer_state,
        //             //                             component,
        //             //                             script_path,
        //             //                             "on_attack",
        //             //                         ) {
        //             //                             script_changes.push(change);
        //             //                         }
        //             //                     }
        //             //                 }
        //             //             }
        //             //         }
        //             //     }
        //             // }

        //             // // Handle particle spawns from on_attack
        //             // for change in script_changes {
        //             //     if let Some(spawns) = change.particle_spawns {
        //             //         let gpu_resources = editor.gpu_resources.as_ref().expect("GPU resources missing");
        //             //         for spawn in spawns {
        //             //             if let Some((start, end)) = debug_line {
        //             //                 let uniforms = ParticleUniforms {
        //             //                     position: [spawn.position.x, spawn.position.y, spawn.position.z, 0.0],
        //             //                     time: 0.0,
        //             //                     emission_rate: spawn.emission_rate,
        //             //                     life_time: spawn.life_time,
        //             //                     radius: spawn.radius,
        //             //                     gravity: [spawn.gravity.x, spawn.gravity.y, spawn.gravity.z, 0.0],
        //             //                     initial_speed_min: spawn.initial_speed_min,
        //             //                     initial_speed_max: spawn.initial_speed_max,
        //             //                     start_color: spawn.start_color,
        //             //                     end_color: spawn.end_color,
        //             //                     size: spawn.size,
        //             //                     mode: spawn.mode,
        //             //                     target_position: [end.x, end.y, end.z, 0.0],
        //             //                     _pad2: [0.0; 4],
        //             //                 };
                                    
        //             //                 let system = ParticleSystem::new(
        //             //                     &gpu_resources.device,
        //             //                     &camera_binding.bind_group_layout,
        //             //                     uniforms,
        //             //                     500,
        //             //                     wgpu::TextureFormat::Rgba8Unorm,
        //             //                 );
                                    
        //             //                 renderer_state.particle_systems.push(system);
        //             //             }
        //             //         }
        //             //     }
        //             // }

        //             // Handle debug hitscan line
        //             if renderer_state.game_settings.show_hitscan_line {
        //                 if let Some((start, end)) = debug_line {
        //                     let gpu_resources = editor.gpu_resources.as_ref().expect("GPU resources missing");
        //                     let mut debug_cube = Cube::new(
        //                         &gpu_resources.device,
        //                         &gpu_resources.queue,
        //                         &renderer_state.model_bind_group_layout,
        //                         &renderer_state.group_bind_group_layout,
        //                         &renderer_state.texture_render_mode_buffer,
        //                         camera,
        //                     );

        //                     let dir = (end - start).normalize();
        //                     let offset_start = start + dir * 0.5;
        //                     let length = nalgebra::distance(&offset_start, &end);
                            
        //                     if length > 0.0 && (end - start).dot(&dir) > 0.5 {
        //                         let scale = 0.02;
        //                         let rotation = UnitQuaternion::rotation_between(&Vector3::z(), &dir).unwrap_or_default();
        //                         let center_offset = rotation * Vector3::new(scale * 0.5, scale * 0.5, 0.0);
        //                         let draw_pos = offset_start - center_offset;

        //                         debug_cube.transform.update_position([draw_pos.x, draw_pos.y, draw_pos.z]);
        //                         debug_cube.transform.update_scale([scale, scale, length]);
        //                         debug_cube.transform.update_rotation_quat([
        //                             rotation.coords.x,
        //                             rotation.coords.y,
        //                             rotation.coords.z,
        //                             rotation.coords.w,
        //                         ]);
                                
        //                         debug_cube.transform.update_uniform_buffer(&gpu_resources.queue);
                                
        //                         renderer_state.debug_rays.push(crate::core::RendererState::DebugRay {
        //                             cube: debug_cube,
        //                             expires_at: Instant::now() + Duration::from_millis(500),
        //                         });
        //                     }
        //                 }
        //             }
        //         }
        //     } else {
        //         player.has_fired_this_press = false;
        //     }
        // }

        // // Sync enemy health to UI
        // if let Some(target_id) = &editor.current_enemy_target {
        //     if let Some(npc) = renderer_state.npcs.iter().find(|n| &n.id == target_id) {
        //          if let Some(health_bar) = &mut editor.enemy_health_bar {
        //             health_bar.update_health(queue, npc.stats.health);
        //         }
        //     }
        // }

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            // Update procedural sky uniform buffer if config is present
            let current_procedural_sky_config = editor
                .world_state
                .as_ref()
                .and_then(|state| state.levels.as_ref())
                .and_then(|levels| levels.get(0))
                .and_then(|level| level.procedural_sky.clone());

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
            }

            // Shadow Pass
            {
                let shadow_pipeline_data = pipeline.shadow_pipeline_data.as_ref().unwrap();

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

            // // update rapier collisions
            // renderer_state.update_rapier();

            // // perhaps counterproductive to avoid physics in the preview
            // // but sometimes you dont want to mix physics when doing design (make this a setting)
            // if game_mode {
            //     // step through physics each frame
            //     renderer_state.step_physics_pipeline(
            //         &gpu_resources.device,
            //         &gpu_resources.queue,
            //         camera_binding,
            //         camera
            //     );
            // }

            // Execute JS component scripts
            // let mut changes: Vec<ComponentChanges> = Vec::new();
            // if let Some(world_state) = editor.world_state.as_ref() {
            //     if let Some(levels) = world_state.levels.as_ref() {
            //         if let Some(components) = levels.get(0).and_then(|l| l.components.as_ref()) {
            //             for component in components.iter() {
            //                 if let Some(script_path) = &component.js_script_path {
            //                     if let Some(change) = editor.deno_engine.execute_component_script(
            //                         renderer_state,
            //                         component,
            //                         script_path,
            //                         "on_update",
            //                     ) {
            //                         changes.push(change);
            //                     }
            //                 }
            //             }
            //         }
            //     }
            // }

            // // Apply collected changes
            // for change in changes {
            //     if let Some(model) = renderer_state.models.iter_mut().find(|m| m.id == change.component_id) {
            //         if let Some(new_pos) = change.new_position {
            //             let pos_array = [new_pos.x, new_pos.y, new_pos.z];
                        
            //             // Update model's transform for rendering
            //             for mesh in &mut model.meshes {
            //                 mesh.transform.update_position(pos_array);
            //             }
                        
            //             // Update rigidbody for physics
            //             if let Some(rb_handle) = model.meshes[0].rigid_body_handle {
            //                 if let Some(rb) = renderer_state.rigid_body_set.get_mut(rb_handle) {
            //                     let new_isometry = nalgebra::Isometry3::translation(new_pos.x, new_pos.y, new_pos.z);
            //                     rb.set_position(new_isometry, true);
            //                 }
            //             }
            //         }
            //     }
            // }

            let time = pipeline.start_time.elapsed().as_secs_f32();
            if !renderer_state.particle_systems.is_empty() {
                renderer_state.particle_systems.retain_mut(|system| system.update(queue, time));
            }

            let gbuffer_position_view = pipeline.g_buffer_position_view.as_ref().unwrap();            let gbuffer_normal_view = pipeline.g_buffer_normal_view.as_ref().unwrap();
            let gbuffer_albedo_view = pipeline.g_buffer_albedo_view.as_ref().unwrap();
            let gbuffer_pbr_material_view = pipeline.g_buffer_pbr_material_view.as_ref().unwrap();

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

            if let Some(rect) = viewport_rect {
                // render_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
                render_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
            }

            render_pass.set_pipeline(&geometry_pipeline);

            render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
            render_pass.set_bind_group(2, window_size_bind_group, &[]);

            // // draw cubes
            // for (poly_index, cube) in renderer_state.cubes.iter().enumerate() {
            //     // if !polygon.hidden {
            //         cube
            //             .transform
            //             .update_uniform_buffer(&queue);
            //         render_pass.set_bind_group(1, &cube.bind_group, &[]);
            //         render_pass.set_bind_group(3, &cube.group_bind_group, &[]);
            //         render_pass.set_vertex_buffer(0, cube.vertex_buffer.slice(..));
            //         render_pass.set_index_buffer(
            //             cube.index_buffer.slice(..),
            //             wgpu::IndexFormat::Uint32,
            //         );
            //         render_pass.draw_indexed(0..cube.index_count as u32, 0, 0..1);
            //     // }
            // }

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

            // for model in &renderer_state.models {
            //     for mesh in &model.meshes {
            //         // Conditional rendering based on skinning
            //         if let Some(skin_bind_group) = &model.skin_bind_group {
            //             // Use the skinned pipeline and bind its specific bind group
            //             if let Some(pipeline_instance) = &renderer_state.skinned_pipeline {
            //                 render_pass.set_pipeline(&pipeline_instance.render_pipeline);
            //                 // Bind skin uniform at group 2 (as defined in skinned_pipeline.rs)
            //                 render_pass.set_bind_group(2, skin_bind_group, &[]);
            //             } else {
            //                  // Fallback to geometry_pipeline if skinned_pipeline is None (should not happen if initialized correctly)
            //                 render_pass.set_pipeline(&geometry_pipeline);
            //             }
            //         } else {
            //             // Use the regular geometry pipeline for non-skinned meshes
            //             render_pass.set_pipeline(&geometry_pipeline);
            //         }

            //         // if model.hide_from_world {
            //         //     println!("Render mesh uniform {:?}", mesh.transform.position);
            //         // }

            //         mesh.transform.update_uniform_buffer(&gpu_resources.queue);

            //         render_pass.set_bind_group(0, &camera_binding.bind_group, &[]); // Camera
            //         render_pass.set_bind_group(1, &mesh.bind_group, &[]); // Model transform + textures
            //         // render_pass.set_bind_group(2, window_size_bind_group, &[]); // Window size is not needed for skinned shader
            //         render_pass.set_bind_group(3, &mesh.group_bind_group, &[]); // Group transform (if any)

            //         // Need to use the regular vertex buffer with regular Vertex if using geometry pipeline
            //         render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
            //         render_pass.set_index_buffer(
            //             mesh.index_buffer.slice(..),
            //             wgpu::IndexFormat::Uint32,
            //         );
            //         render_pass.draw_indexed(0..mesh.index_count as u32, 0, 0..1);
            //     }
            // }

            for house in &renderer_state.procedural_houses {
                for mesh in &house.meshes {
                    mesh.transform.update_uniform_buffer(&gpu_resources.queue);

                    render_pass.set_bind_group(0, &camera_binding.bind_group, &[]); // Camera
                    render_pass.set_bind_group(1, &mesh.bind_group, &[]); // Model transform + textures
                    // render_pass.set_bind_group(3, &mesh.group_bind_group, &[]); // Group transform (if any)

                    // Need to use the regular vertex buffer with regular Vertex if using geometry pipeline
                    render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                    render_pass.set_index_buffer(
                        mesh.index_buffer.slice(..),
                        wgpu::IndexFormat::Uint32,
                    );
                    render_pass.draw_indexed(0..mesh.index_count as u32, 0, 0..1);
                }
            }

            // Render Scattered Models
            if let Some(pipeline) = &renderer_state.scattered_model_pipeline {
                render_pass.set_pipeline(&pipeline.render_pipeline);
                
                // Calculate player position for uniforms
                let player_pos = if let Some(player_character) = &renderer_state.player_character {
                    if let Some(model_id) = &player_character.model_id {
                            renderer_state.models.iter().find(|m| m.id == model_id.clone())
                            .and_then(|m| m.meshes.get(0))
                            .map(|mesh| [mesh.transform.position.x, mesh.transform.position.y, mesh.transform.position.z])
                            .unwrap_or([camera.position.x, camera.position.y, camera.position.z])
                    } else if let Some(sphere) = &player_character.sphere {
                            [sphere.transform.position.x, sphere.transform.position.y, sphere.transform.position.z]
                    } else {
                        [camera.position.x, camera.position.y, camera.position.z]
                    }
                } else {
                    [camera.position.x, camera.position.y, camera.position.z]
                };

                for scattered_model in &mut renderer_state.scattered_models {
                    if scattered_model.instance_count == 0 {
                        continue;
                    }
                    
                    scattered_model.update_uniforms(&queue, player_pos);

                    render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                    render_pass.set_bind_group(2, window_size_bind_group, &[]); // Window size
                    render_pass.set_bind_group(4, &scattered_model.uniform_bind_group, &[]);
                    render_pass.set_bind_group(5, &scattered_model.landscape_bind_group, &[]);

                    for mesh in &scattered_model.model.meshes {
                        // We need the model bind group for textures, but the transform in it is ignored by shader 
                        // (except maybe for global model transform if we added it, but here instances drive position)
                        render_pass.set_bind_group(1, &mesh.bind_group, &[]);
                        render_pass.set_bind_group(3, &mesh.group_bind_group, &[]); // Group transform (if any)

                        render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                        // No instance buffer needed - procedural generation
                        render_pass.set_index_buffer(
                            mesh.index_buffer.slice(..),
                            wgpu::IndexFormat::Uint32,
                        );
                        
                        render_pass.draw_indexed(0..mesh.index_count as u32, 0, 0..scattered_model.instance_count);
                    }
                }
            }

            // Render addon landscapes (3D)
            for landscapes in renderer_state.addon_landscape3ds.values() {
                for landscape in landscapes {
                    render_pass.set_pipeline(&geometry_pipeline);
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
            }

            // Render addon landscapes (Heightfield)
            for landscapes in renderer_state.addon_landscapes.values() {
                for landscape in landscapes {
                    render_pass.set_pipeline(&geometry_pipeline);
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
            }

            // for (poly_index, landscape) in renderer_state.landscapes.iter().enumerate() {
            //     // if !polygon.hidden {
            //         render_pass.set_pipeline(&geometry_pipeline);
            //         landscape
            //             .transform
            //             .update_uniform_buffer(&queue); // probably unnecessary
            //         render_pass.set_bind_group(1, &landscape.bind_group, &[]);
            //         render_pass.set_bind_group(3, &landscape.group_bind_group, &[]);
            //         render_pass.set_vertex_buffer(0, landscape.vertex_buffer.slice(..));
            //         render_pass.set_index_buffer(
            //             landscape.index_buffer.slice(..),
            //             wgpu::IndexFormat::Uint32,
            //         );
            //         render_pass.draw_indexed(0..landscape.index_count as u32, 0, 0..1);
            //     // }
            // }

            // draw grass

            // for grass in &mut renderer_state.grasses {
            //     if let Some(player_character) = &renderer_state.player_character {
            //         if let Some(model_id) = &player_character.model_id {
            //             let player_model = renderer_state.models.iter().find(|m| m.id == model_id.clone());
            //             let player_model = player_model.as_ref().expect("Couldn't find related model");
            //             let model_mesh = player_model.meshes.get(0);
            //             let model_mesh = model_mesh.as_ref().expect("Couldn't get first mesh");
            //             grass.update_uniforms(&queue, time as f32, Point3::new(model_mesh.transform.position.x, model_mesh.transform.position.y, model_mesh.transform.position.z));
            //         } else if let Some(sphere) = &player_character.sphere {
            //             grass.update_uniforms(&queue, time as f32, Point3::new(sphere.transform.position.x, sphere.transform.position.y, sphere.transform.position.z));
            //         } else {
            //             grass.update_uniforms(&queue, time as f32, camera.position);
            //         }
            //     } else {
            //         grass.update_uniforms(&queue, time as f32, camera.position);
            //     }

            //     render_pass.set_pipeline(&grass.render_pipeline);
            //     render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
            //     render_pass.set_bind_group(1, &grass.uniform_bind_group, &[]);
            //     render_pass.set_bind_group(2, &grass.landscape_bind_group, &[]);

            //     for (i, bind_group) in grass.bind_groups.iter().enumerate() {
            //         render_pass.set_bind_group((i + 3) as u32, bind_group, &[]);
            //     }

            //     render_pass.set_vertex_buffer(0, grass.blade.vertex_buffer.slice(..));
            //     render_pass.set_index_buffer(grass.blade.index_buffer.slice(..), wgpu::IndexFormat::Uint16);

            //     let grid_cells = ((grass.config.render_distance * 2.0) / grass.config.grid_size).ceil() as u32;
            //     let total_instances = grid_cells * grid_cells * grass.config.blade_density as u32;

            //     render_pass.draw_indexed(0..grass.blade.index_count, 0, 0..total_instances);
            //     render_pass.set_pipeline(&geometry_pipeline);
            // }

            // draw trees
            for trees in &renderer_state.procedural_trees {
                trees.update_uniforms(&queue, time as f32);
                render_pass.draw_trees(
                    trees,
                    &camera_binding.bind_group,
                );
                render_pass.set_pipeline(&geometry_pipeline);
            }

            // // draw water
            // for water_plane in &mut renderer_state.water_planes {
            //     if let Some(player_character) = &renderer_state.player_character {
            //         if let Some(model_id) = &player_character.model_id {
            //             let player_model = renderer_state.models.iter().find(|m| m.id == model_id.clone());
            //             let player_model = player_model.as_ref().expect("Couldn't find related model");
            //             let model_mesh = player_model.meshes.get(0);
            //             let model_mesh = model_mesh.as_ref().expect("Couldn't get first mesh");
            //             water_plane.update_uniforms(queue, time as f32, [model_mesh.transform.position.x, model_mesh.transform.position.y, model_mesh.transform.position.z]);
            //             render_pass.draw_water(water_plane, &camera_binding.bind_group, &water_plane.time_bind_group, &water_plane.landscape_bind_group, &water_plane.config_bind_group);
            //         } else if let Some(sphere) = &player_character.sphere {
            //             let player_pos = sphere.transform.position;
            //             water_plane.update_uniforms(queue, time as f32, [player_pos.x, player_pos.y, player_pos.z]);
            //             render_pass.draw_water(water_plane, &camera_binding.bind_group, &water_plane.time_bind_group, &water_plane.landscape_bind_group, &water_plane.config_bind_group);
            //         }
            //     }
            // }

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
            // let mut collected_lights = if pipeline.current_workspace == Workspace::GameEngine {
            //     renderer_state.point_lights.clone()
            // } else {
            //     Vec::new()
            // };

            // for (addon_name, lights) in &renderer_state.addon_point_lights {
            //     if let Workspace::Addon(active_name) = &pipeline.current_workspace {
            //         if addon_name == active_name || addon_name == "Global" {
            //             collected_lights.extend(lights.clone());
            //         }
            //     } else if addon_name == "Global" {
            //         collected_lights.extend(lights.clone());
            //     }
            // }

            // let mut point_lights_uniform_data = crate::core::editor::PointLightsUniform {
            //     point_lights: [[0.0; 12]; crate::core::editor::MAX_POINT_LIGHTS], // Initialize with zeros
            //     num_point_lights: collected_lights.len().min(crate::core::editor::MAX_POINT_LIGHTS) as u32,
            //     _padding: [0; 3],
            // };

            // for (i, pl) in collected_lights.iter().take(crate::core::editor::MAX_POINT_LIGHTS).enumerate() {
            //     // point_lights_uniform_data.point_lights[i] = *pl;
            //      point_lights_uniform_data.point_lights[i] = [
            //         pl.position[0], pl.position[1], pl.position[2],0.0,  // position + padding
            //         pl.color[0], pl.color[1], pl.color[2],0.0, pl.intensity, pl.max_distance, // color + intensity
            //          0.0, 0.0
            //     ];
            // }
            
            // // Update point lights buffer
            // queue.write_buffer(
            //     pipeline.point_lights_buffer.as_ref().unwrap(),
            //     0,
            //     bytemuck::cast_slice(&[point_lights_uniform_data]),
            // );

            // Lighting pass
            // {
            //     let lighting_pipeline = pipeline.lighting_pipeline.as_ref().unwrap();
            //     let lighting_bind_group = pipeline.lighting_bind_group.as_ref().unwrap();
            //     let g_buffer_bind_group = pipeline.g_buffer_bind_group.as_ref().unwrap();
            //     let shadow_pipeline_data = pipeline.shadow_pipeline_data.as_ref().unwrap();
            //     // let camera_binding = editor.camera_binding.as_ref().unwrap();
            //     let shadow_bind_group = &shadow_pipeline_data.shadow_bind_group;

            //     let mut lighting_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            //         label: Some("Lighting Pass"),
            //         color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            //             view: &view,
            //             resolve_target: None,
            //             ops: wgpu::Operations {
            //                 load: wgpu::LoadOp::Load,
            //                 store: wgpu::StoreOp::Store,
            //             },
            //             depth_slice: None,
            //         })],
            //         depth_stencil_attachment: None,
            //         timestamp_writes: None,
            //         occlusion_query_set: None,
            //     });

            //     if let Some(rect) = viewport_rect {
            //         // lighting_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
            //         lighting_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
            //     }

            //     lighting_pass.set_pipeline(lighting_pipeline);
            //     lighting_pass.set_bind_group(0, lighting_bind_group, &[]);
            //     lighting_pass.set_bind_group(1, g_buffer_bind_group, &[]);
            //     // lighting_pass.set_bind_group(2, window_size_bind_group, &[]);
            //     lighting_pass.set_bind_group(3, shadow_bind_group, &[]);
            //     // lighting_pass.set_bind_group(4, &camera_binding.bind_group, &[]);
            //     lighting_pass.set_bind_group(2, &camera_binding.bind_group, &[]);
            //     lighting_pass.draw(0..3, 0..1);
            // }

            // Procedural Sky Render Pass
            // {
            //     if let Some(procedural_sky_pipeline) = pipeline.procedural_sky_pipeline.as_ref() {
            //         if let Some(procedural_sky_bind_group) = pipeline.procedural_sky_bind_group.as_ref() {
            //             let mut sky_render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            //                 label: Some("Procedural Sky Pass"),
            //                 color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            //                     view: &view,
            //                     resolve_target: None,
            //                     ops: wgpu::Operations {
            //                         load: wgpu::LoadOp::Load, // Load existing color (from lighting pass)
            //                         store: wgpu::StoreOp::Store,
            //                     },
            //                     depth_slice: None,
            //                 })],
            //                 depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
            //                     view: &depth_view, // Use the same depth view as geometry pass
            //                     depth_ops: Some(wgpu::Operations {
            //                         load: wgpu::LoadOp::Load, // Load existing depth values
            //                         store: wgpu::StoreOp::Store,
            //                     }),
            //                     stencil_ops: None,
            //                 }),
            //                 timestamp_writes: None,
            //                 occlusion_query_set: None,
            //             });

            //             if let Some(rect) = viewport_rect {
            //                 // sky_render_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
            //                 sky_render_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
            //             }

            //             sky_render_pass.set_pipeline(procedural_sky_pipeline);
            //             sky_render_pass.set_bind_group(0, procedural_sky_bind_group, &[]);
            //             sky_render_pass.draw(0..3, 0..1); // Draw the full-screen triangle
            //         }
            //     }
            // }

            // {
            //     if let Some(pipeline) = &pipeline.debug_sphere_pipeline {
            //         let mut debug_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            //             label: Some("Debug Pass"),
            //             color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            //                 view: view,
            //                 resolve_target: None,
            //                 ops: wgpu::Operations {
            //                     load: wgpu::LoadOp::Load,
            //                     store: wgpu::StoreOp::Store,
            //                 },
            //                 depth_slice: None
            //             })],
            //             depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
            //                 view: depth_view,
            //                 depth_ops: Some(wgpu::Operations {
            //                     load: wgpu::LoadOp::Load,
            //                     store: wgpu::StoreOp::Store,
            //                 }),
            //                 stencil_ops: None,
            //             }),
            //             timestamp_writes: None,
            //             occlusion_query_set: None,
            //         });

            //         if let Some(rect) = viewport_rect {
            //             // debug_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
            //             debug_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
            //         }

            //         debug_pass.set_pipeline(pipeline);
            //         debug_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                    
            //         for npc in &renderer_state.npcs {
            //             if let Some(sphere) = &npc.debug_sphere {
            //                 sphere.transform.update_uniform_buffer(queue);
            //                 debug_pass.set_bind_group(1, &sphere.bind_group, &[]);
            //                 debug_pass.set_vertex_buffer(0, sphere.vertex_buffer.slice(..));
            //                 debug_pass.set_index_buffer(sphere.index_buffer.slice(..), wgpu::IndexFormat::Uint16);
            //                 debug_pass.draw_indexed(0..sphere.index_count, 0, 0..1);
            //             }
            //         }
            //     }
            // }

            
//             renderer_state.gizmo.update_config(transform_gizmo::GizmoConfig {
//                 view_matrix: crate::core::SimpleCamera::to_row_major_f64(&camera.get_view()),
//                 projection_matrix: crate::core::SimpleCamera::to_row_major_f64(&camera.get_projection()),
//                 viewport: transform_gizmo::Rect {
//                     min: (0.0, 0.0).into(),
//                     max: (camera.viewport.window_size.width as f32, camera.viewport.window_size.height as f32).into(),
//                 },
//                 modes: GizmoMode::all_translate(),
//                 ..renderer_state.gizmo.config().clone()
//             });

//             // println!("gizmo {:?}", renderer_state.gizmo.config().clone());

// // DEBUG:
// // let gizmo_draw_data = renderer_state.gizmo.draw();
// // if !gizmo_draw_data.vertices.is_empty() {
    
// // // let player_world_pos = DVec3::new(0.0, 0.0, 0.0); // or get from your transform

// // // Manually calculate what screen position (0,0,0) should be at
// // let viewx = DMat4::from(renderer_state.gizmo.config().view_matrix);
// // let proj = DMat4::from(renderer_state.gizmo.config().projection_matrix);
// // let vp = proj * viewx;

// // // Project to clip space
// // let clip = vp * DVec4::new(0.0, 0.0, 0.0, 1.0);
// // let ndc = clip.xyz() / clip.w;

// // // Convert to screen space (matching transform-gizmo's logic)
// // let viewport = renderer_state.gizmo.config().viewport;
// // let screen_x = (ndc.x + 1.0) * 0.5 * viewport.width() as f64;
// // let screen_y = (1.0 - ndc.y) * 0.5 * viewport.height() as f64;

// // println!("=== GIZMO POSITION DEBUG ===");
// // println!("Player world position: (0, 0, 0)");
// // println!("View matrix first row: {:?}", [viewx.x_axis.x, viewx.x_axis.y, viewx.x_axis.z, viewx.x_axis.w]);
// // println!("Projection matrix first row: {:?}", [proj.x_axis.x, proj.x_axis.y, proj.x_axis.z, proj.x_axis.w]);
// // println!("Clip space: {:?}", clip);
// // println!("NDC: {:?}", ndc);
// // println!("Screen position: ({:.1}, {:.1})", screen_x, screen_y);
// // println!("Viewport: min=({:.1}, {:.1}), max=({:.1}, {:.1})", 
// //     viewport.min.x, viewport.min.y, viewport.max.x, viewport.max.y);

// //     println!("First gizmo vertex: ({:.1}, {:.1})", 
// //         gizmo_draw_data.vertices[0][0], 
// //         gizmo_draw_data.vertices[0][1]);
    
// //     // Calculate center of all vertices to see where gizmo thinks it is
// //     let mut sum_x = 0.0;
// //     let mut sum_y = 0.0;
// //     for v in &gizmo_draw_data.vertices {
// //         sum_x += v[0];
// //         sum_y += v[1];
// //     }
// //     let center_x = sum_x / gizmo_draw_data.vertices.len() as f32;
// //     let center_y = sum_y / gizmo_draw_data.vertices.len() as f32;
// //     println!("Gizmo vertex center: ({:.1}, {:.1})", center_x, center_y);
// //     println!("===========================");
// // }


//             let gizmo_draw_data = renderer_state.gizmo.draw();
//             if !game_mode && !gizmo_draw_data.vertices.is_empty() {
//                 // DEBUG: Print first few vertices and viewport info
//                 // println!("=== GIZMO DEBUG ===");
//                 // println!("Viewport: {:?}", renderer_state.gizmo.config().viewport);
//                 // println!("Window size: {}x{}", camera.viewport.window_size.width, camera.viewport.window_size.height);
//                 // println!("Vertex count: {}", gizmo_draw_data.vertices.len());
//                 // println!("First 5 vertices:");
//                 // for (i, v) in gizmo_draw_data.vertices.iter().take(5).enumerate() {
//                 //     println!("  [{}]: ({}, {})", i, v[0], v[1]);
//                 // }
//                 // println!("Index count: {}", gizmo_draw_data.indices.len());
//                 // println!("==================");

//                 // println!("Rendering gizmo");
//                 let gizmo_vertex_buffer =
//                     device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
//                         label: Some("Gizmo Vertex Buffer"),
//                         contents: bytemuck::cast_slice(&gizmo_draw_data.vertices),
//                         usage: wgpu::BufferUsages::VERTEX,
//                     });

//                 let gizmo_color_buffer =
//                     device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
//                         label: Some("Gizmo Color Buffer"),
//                         contents: bytemuck::cast_slice(&gizmo_draw_data.colors),
//                         usage: wgpu::BufferUsages::VERTEX,
//                     });

//                 let gizmo_index_buffer =
//                     device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
//                         label: Some("Gizmo Index Buffer"),
//                         contents: bytemuck::cast_slice(&gizmo_draw_data.indices),
//                         usage: wgpu::BufferUsages::INDEX,
//                     });

//             let mut gizmo_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
//                     label: Some("Gizmo Pass"),
//                     color_attachments: &[Some(wgpu::RenderPassColorAttachment {
//                         view: &view,
//                         resolve_target: None,
//                         ops: wgpu::Operations {
//                             load: wgpu::LoadOp::Load,
//                             store: wgpu::StoreOp::Store,
//                         },
//                         depth_slice: None,
//                     })],
//                     depth_stencil_attachment: None,
//                     timestamp_writes: None,
//                     occlusion_query_set: None,
//                 });

//                 if let Some(rect) = viewport_rect {
//                     // gizmo_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
//                     gizmo_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
//                 }

//                 gizmo_pass.set_pipeline(pipeline.gizmo_pipeline.as_ref().unwrap());
//                 gizmo_pass.set_bind_group(0, window_size_bind_group, &[]);
//                 gizmo_pass.set_vertex_buffer(0, gizmo_vertex_buffer.slice(..));
//                 gizmo_pass.set_vertex_buffer(1, gizmo_color_buffer.slice(..));
//                 gizmo_pass.set_index_buffer(gizmo_index_buffer.slice(..), wgpu::IndexFormat::Uint32);
//                 gizmo_pass.draw_indexed(0..gizmo_draw_data.indices.len() as u32, 0, 0..1);
//             }

            // // UI Render Pass
            // {
            //     if let Some(ui_pipeline) = pipeline.ui_pipeline.as_ref() {
            //         let camera_binding = editor.camera_binding.as_ref().unwrap();
            //         let window_size_bind_group = pipeline
            //             .window_size_bind_group
            //             .as_ref()
            //             .expect("Couldn't get window size bind group");

            //         let mut ui_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            //             label: Some("UI Pass"),
            //             color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            //                 view: &view,
            //                 resolve_target: None,
            //                 ops: wgpu::Operations {
            //                     load: wgpu::LoadOp::Load,
            //                     store: wgpu::StoreOp::Store,
            //                 },
            //                 depth_slice: None,
            //             })],
            //             depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
            //                 view: &depth_view,
            //                 depth_ops: Some(wgpu::Operations {
            //                     load: wgpu::LoadOp::Load,
            //                     store: wgpu::StoreOp::Store,
            //                 }),
            //                 stencil_ops: None,
            //             }),
            //             timestamp_writes: None,
            //             occlusion_query_set: None,
            //         });

            //         if let Some(rect) = viewport_rect {
            //             // ui_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
            //             ui_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
            //         }

            //         ui_pipeline.render(
            //             &mut ui_pass,
            //             editor,
            //             &camera_binding.bind_group,
            //             window_size_bind_group,
            //             queue,
            //         );
            //     }
            // }

            if pipeline.frame_buffer.is_some() {
                let frame_buffer = pipeline
                    .frame_buffer
                    .as_ref()
                    .expect("Couldn't get frame buffer");
                frame_buffer.capture_frame(device, queue, texture, &mut encoder);
            }

            // // Update Dialogue UI
            // dialogue_ui::update_dialogue_ui(editor, device, queue);
            // quest_ui::update_quest_ui(editor, device, queue);

            let command_buffer = encoder.finish();
            queue.submit(std::iter::once(command_buffer));
        }
    }
