use crate::core::editor::Editor;
use crate::core::vertex::Vertex;
use crate::shape_primitives::polygon::Polygon;
use crate::renderer_text::text_due::TextRenderer;
use crate::renderer_images::st_image::StImage;
use crate::renderer_videos::st_video::StVideo;
use wgpu::RenderPipeline;

pub struct UiPipeline {
    pub pipeline: RenderPipeline,
}

impl UiPipeline {
    pub fn new(
        device: &wgpu::Device,
        camera_bind_group_layout: &wgpu::BindGroupLayout,
        ui_model_bind_group_layout: &wgpu::BindGroupLayout,
        window_size_bind_group_layout: &wgpu::BindGroupLayout,
        group_bind_group_layout: &wgpu::BindGroupLayout,
        format: wgpu::TextureFormat,
    ) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("UI Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/ui.wgsl").into()),
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("UI Pipeline Layout"),
            bind_group_layouts: &[
                camera_bind_group_layout,
                ui_model_bind_group_layout,
                window_size_bind_group_layout,
                group_bind_group_layout,
            ],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("UI Render Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[Vertex::desc()],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth24Plus,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::Always,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Self { pipeline }
    }

    pub fn render<'rp>(
        &'rp self,
        render_pass: &mut wgpu::RenderPass<'rp>,
        editor: &'rp Editor,
        camera_bind_group: &'rp wgpu::BindGroup,
        window_size_bind_group: &'rp wgpu::BindGroup,
        queue: &wgpu::Queue,
    ) {
        let renderer_state = editor.renderer_state.as_ref().expect("Couldn't get renderer state");

        render_pass.set_pipeline(&self.pipeline);
        render_pass.set_bind_group(0, camera_bind_group, &[]);
        render_pass.set_bind_group(2, window_size_bind_group, &[]);

        // Render static polygons
        for polygon in &editor.ui_polygons {
            if !polygon.hidden {
                polygon.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &polygon.bind_group, &[]);
                render_pass.set_bind_group(3, &polygon.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, polygon.vertex_buffer.slice(..));
                render_pass.set_index_buffer(polygon.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                render_pass.draw_indexed(0..polygon.indices.len() as u32, 0, 0..1);
            }
        }

        // Render text items
        for text_item in &editor.ui_textboxes {
            if !text_item.hidden {
                // Background polygon first
                if !text_item.background_polygon.hidden {
                    text_item.background_polygon.transform.update_uniform_buffer(queue);
                    render_pass.set_bind_group(1, &text_item.background_polygon.bind_group, &[]);
                    render_pass.set_bind_group(3, &text_item.background_polygon.group_bind_group, &[]);
                    render_pass.set_vertex_buffer(0, text_item.background_polygon.vertex_buffer.slice(..));
                    render_pass.set_index_buffer(text_item.background_polygon.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                    render_pass.draw_indexed(0..text_item.background_polygon.indices.len() as u32, 0, 0..1);
                }

                // Text
                text_item.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &text_item.bind_group, &[]);
                render_pass.set_bind_group(3, &text_item.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, text_item.vertex_buffer.slice(..));
                render_pass.set_index_buffer(text_item.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                render_pass.draw_indexed(0..text_item.indices.len() as u32, 0, 0..1);
            }
        }

        // Render image items
        for image_item in &editor.ui_images {
            if !image_item.hidden {
                image_item.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &image_item.bind_group, &[]);
                render_pass.set_bind_group(3, &image_item.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, image_item.vertex_buffer.slice(..));
                render_pass.set_index_buffer(image_item.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                render_pass.draw_indexed(0..image_item.indices.len() as u32, 0, 0..1);
            }
        }

        // Render health bar
        if let Some(health_bar) = &editor.health_bar {
            // Background
            health_bar.background.transform.update_uniform_buffer(queue);
            render_pass.set_bind_group(1, &health_bar.background.bind_group, &[]);
            render_pass.set_bind_group(3, &health_bar.background.group_bind_group, &[]);
            render_pass.set_vertex_buffer(0, health_bar.background.vertex_buffer.slice(..));
            render_pass.set_index_buffer(health_bar.background.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            render_pass.draw_indexed(0..health_bar.background.indices.len() as u32, 0, 0..1);

            // Bar
            health_bar.bar.transform.update_uniform_buffer(queue);
            render_pass.set_bind_group(1, &health_bar.bar.bind_group, &[]);
            render_pass.set_bind_group(3, &health_bar.bar.group_bind_group, &[]);
            render_pass.set_vertex_buffer(0, health_bar.bar.vertex_buffer.slice(..));
            render_pass.set_index_buffer(health_bar.bar.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            render_pass.draw_indexed(0..health_bar.bar.indices.len() as u32, 0, 0..1);
        }

        // Render enemy health bar
        if let Some(enemy_health_bar) = &editor.enemy_health_bar {
            // Background
            enemy_health_bar.background.transform.update_uniform_buffer(queue);
            render_pass.set_bind_group(1, &enemy_health_bar.background.bind_group, &[]);
            render_pass.set_bind_group(3, &enemy_health_bar.background.group_bind_group, &[]);
            render_pass.set_vertex_buffer(0, enemy_health_bar.background.vertex_buffer.slice(..));
            render_pass.set_index_buffer(enemy_health_bar.background.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            render_pass.draw_indexed(0..enemy_health_bar.background.indices.len() as u32, 0, 0..1);

            // Bar
            enemy_health_bar.bar.transform.update_uniform_buffer(queue);
            render_pass.set_bind_group(1, &enemy_health_bar.bar.bind_group, &[]);
            render_pass.set_bind_group(3, &enemy_health_bar.bar.group_bind_group, &[]);
            render_pass.set_vertex_buffer(0, enemy_health_bar.bar.vertex_buffer.slice(..));
            render_pass.set_index_buffer(enemy_health_bar.bar.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            render_pass.draw_indexed(0..enemy_health_bar.bar.indices.len() as u32, 0, 0..1);
        }

        // Render MiniMap
        if let Some(mini_map) = &editor.mini_map {
            if mini_map.visible {
                // Background
                mini_map.background.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &mini_map.background.bind_group, &[]);
                render_pass.set_bind_group(3, &mini_map.background.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, mini_map.background.vertex_buffer.slice(..));
                render_pass.set_index_buffer(mini_map.background.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                render_pass.draw_indexed(0..mini_map.background.indices.len() as u32, 0, 0..1);

                // Player Marker
                mini_map.player_marker.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &mini_map.player_marker.bind_group, &[]);
                render_pass.set_bind_group(3, &mini_map.player_marker.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, mini_map.player_marker.vertex_buffer.slice(..));
                render_pass.set_index_buffer(mini_map.player_marker.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                render_pass.draw_indexed(0..mini_map.player_marker.indices.len() as u32, 0, 0..1);

                // NPC Markers
                for (id, marker) in &mini_map.npc_markers {
                    if !marker.hidden {
                        marker.transform.update_uniform_buffer(queue);
                        render_pass.set_bind_group(1, &marker.bind_group, &[]);
                        render_pass.set_bind_group(3, &marker.group_bind_group, &[]);
                        render_pass.set_vertex_buffer(0, marker.vertex_buffer.slice(..));
                        render_pass.set_index_buffer(marker.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                        render_pass.draw_indexed(0..marker.indices.len() as u32, 0, 0..1);
                    }
                }

                // Collectable Markers
                for (id, marker) in &mini_map.collectable_markers {
                    if !marker.hidden {
                        marker.transform.update_uniform_buffer(queue);
                        render_pass.set_bind_group(1, &marker.bind_group, &[]);
                        render_pass.set_bind_group(3, &marker.group_bind_group, &[]);
                        render_pass.set_vertex_buffer(0, marker.vertex_buffer.slice(..));
                        render_pass.set_index_buffer(marker.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                        render_pass.draw_indexed(0..marker.indices.len() as u32, 0, 0..1);
                    }
                }
            }
        }

        // Render Crosshair
        if let Some(crosshair) = &editor.crosshair {
            // Vertical
            crosshair.vertical.transform.update_uniform_buffer(queue);
            render_pass.set_bind_group(1, &crosshair.vertical.bind_group, &[]);
            render_pass.set_bind_group(3, &crosshair.vertical.group_bind_group, &[]);
            render_pass.set_vertex_buffer(0, crosshair.vertical.vertex_buffer.slice(..));
            render_pass.set_index_buffer(crosshair.vertical.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            render_pass.draw_indexed(0..crosshair.vertical.indices.len() as u32, 0, 0..1);

            // Horizontal
            crosshair.horizontal.transform.update_uniform_buffer(queue);
            render_pass.set_bind_group(1, &crosshair.horizontal.bind_group, &[]);
            render_pass.set_bind_group(3, &crosshair.horizontal.group_bind_group, &[]);
            render_pass.set_vertex_buffer(0, crosshair.horizontal.vertex_buffer.slice(..));
            render_pass.set_index_buffer(crosshair.horizontal.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            render_pass.draw_indexed(0..crosshair.horizontal.indices.len() as u32, 0, 0..1);
        }

        // Render Ammo Display
        if let Some(ammo_display) = &editor.ammo_display {
            if !ammo_display.text_renderer.hidden {
                ammo_display.text_renderer.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &ammo_display.text_renderer.bind_group, &[]);
                render_pass.set_bind_group(3, &ammo_display.text_renderer.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, ammo_display.text_renderer.vertex_buffer.slice(..));
                render_pass.set_index_buffer(ammo_display.text_renderer.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                render_pass.draw_indexed(0..ammo_display.text_renderer.indices.len() as u32, 0, 0..1);
            }
        }
    }

    pub fn render_stunts<'rp>(
        &'rp self,
        render_pass: &mut wgpu::RenderPass<'rp>,
        editor: &'rp Editor,
        camera_bind_group: &'rp wgpu::BindGroup,
        window_size_bind_group: &'rp wgpu::BindGroup,
        queue: &wgpu::Queue,
        current_time_ms: i32,
    ) {
        render_pass.set_pipeline(&self.pipeline);
        render_pass.set_bind_group(0, camera_bind_group, &[]);
        render_pass.set_bind_group(2, window_size_bind_group, &[]);

        // Render Stunts Polygons
        for polygon in &editor.stunts_polygons {
            if !polygon.hidden && current_time_ms >= polygon.start_time_ms && current_time_ms <= polygon.start_time_ms + polygon.duration_ms {
                polygon.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &polygon.bind_group, &[]);
                render_pass.set_bind_group(3, &polygon.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, polygon.vertex_buffer.slice(..));
                render_pass.set_index_buffer(polygon.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                render_pass.draw_indexed(0..polygon.indices.len() as u32, 0, 0..1);
            }
        }

        // Render Stunts Text
        for text_item in &editor.stunts_textboxes {
            if !text_item.hidden && current_time_ms >= text_item.start_time_ms && current_time_ms <= text_item.start_time_ms + text_item.duration_ms {
                // Background polygon first
                if !text_item.background_polygon.hidden {
                    text_item.background_polygon.transform.update_uniform_buffer(queue);
                    render_pass.set_bind_group(1, &text_item.background_polygon.bind_group, &[]);
                    render_pass.set_bind_group(3, &text_item.background_polygon.group_bind_group, &[]);
                    render_pass.set_vertex_buffer(0, text_item.background_polygon.vertex_buffer.slice(..));
                    render_pass.set_index_buffer(text_item.background_polygon.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                    render_pass.draw_indexed(0..text_item.background_polygon.indices.len() as u32, 0, 0..1);
                }

                // Text
                text_item.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &text_item.bind_group, &[]);
                render_pass.set_bind_group(3, &text_item.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, text_item.vertex_buffer.slice(..));
                render_pass.set_index_buffer(text_item.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                render_pass.draw_indexed(0..text_item.indices.len() as u32, 0, 0..1);
            }
        }

        // Render Stunts Images
        for image_item in &editor.stunts_images {
            if !image_item.hidden && current_time_ms >= image_item.start_time_ms && current_time_ms <= image_item.start_time_ms + image_item.duration_ms {
                image_item.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &image_item.bind_group, &[]);
                render_pass.set_bind_group(3, &image_item.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, image_item.vertex_buffer.slice(..));
                render_pass.set_index_buffer(image_item.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                render_pass.draw_indexed(0..image_item.indices.len() as u32, 0, 0..1);
            }
        }

        // Render Stunts Videos
        for video_item in &editor.stunts_videos {
            if !video_item.hidden && current_time_ms >= video_item.start_time_ms && current_time_ms <= video_item.start_time_ms + video_item.duration_ms {
                // we probably want to call draw_video_frame here if video is playing
                // but let's just render the current frame for now
                video_item.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &video_item.bind_group, &[]);
                render_pass.set_bind_group(3, &video_item.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, video_item.vertex_buffer.slice(..));
                render_pass.set_index_buffer(video_item.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                render_pass.draw_indexed(0..video_item.indices.len() as u32, 0, 0..1);
            }
        }
    }
}
