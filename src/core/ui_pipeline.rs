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
                draw_ui_geometry(render_pass, &polygon.vertex_buffer, &polygon.index_buffer, polygon.indices.len());
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
                    draw_ui_geometry(render_pass, &text_item.background_polygon.vertex_buffer, &text_item.background_polygon.index_buffer, text_item.background_polygon.indices.len());
                }

                // Text
                text_item.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &text_item.bind_group, &[]);
                render_pass.set_bind_group(3, &text_item.group_bind_group, &[]);
                draw_ui_geometry(render_pass, &text_item.vertex_buffer, &text_item.index_buffer, text_item.indices.len());
            }
        }

        // Render image items
        for image_item in &editor.ui_images {
            if !image_item.hidden {
                image_item.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &image_item.bind_group, &[]);
                render_pass.set_bind_group(3, &image_item.group_bind_group, &[]);
                draw_ui_geometry(render_pass, &image_item.vertex_buffer, &image_item.index_buffer, image_item.indices.len());
            }
        }

        // Render MiniMap
        if let Some(mini_map) = &editor.mini_map {
            if mini_map.visible {
                // Background
                mini_map.background.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &mini_map.background.bind_group, &[]);
                render_pass.set_bind_group(3, &mini_map.background.group_bind_group, &[]);
                draw_ui_geometry(render_pass, &mini_map.background.vertex_buffer, &mini_map.background.index_buffer, mini_map.background.indices.len());

                // Player Marker
                mini_map.player_marker.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &mini_map.player_marker.bind_group, &[]);
                render_pass.set_bind_group(3, &mini_map.player_marker.group_bind_group, &[]);
                draw_ui_geometry(render_pass, &mini_map.player_marker.vertex_buffer, &mini_map.player_marker.index_buffer, mini_map.player_marker.indices.len());

                // NPC Markers
                for (id, marker) in &mini_map.npc_markers {
                    if !marker.hidden {
                        marker.transform.update_uniform_buffer(queue);
                        render_pass.set_bind_group(1, &marker.bind_group, &[]);
                        render_pass.set_bind_group(3, &marker.group_bind_group, &[]);
                        draw_ui_geometry(render_pass, &marker.vertex_buffer, &marker.index_buffer, marker.indices.len());
                    }
                }

                // Collectable Markers
                for (id, marker) in &mini_map.collectable_markers {
                    if !marker.hidden {
                        marker.transform.update_uniform_buffer(queue);
                        render_pass.set_bind_group(1, &marker.bind_group, &[]);
                        render_pass.set_bind_group(3, &marker.group_bind_group, &[]);
                        draw_ui_geometry(render_pass, &marker.vertex_buffer, &marker.index_buffer, marker.indices.len());
                    }
                }
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
                draw_ui_geometry(render_pass, &polygon.vertex_buffer, &polygon.index_buffer, polygon.indices.len());
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
                    draw_ui_geometry(render_pass, &text_item.background_polygon.vertex_buffer, &text_item.background_polygon.index_buffer, text_item.background_polygon.indices.len());
                }

                // Text
                text_item.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &text_item.bind_group, &[]);
                render_pass.set_bind_group(3, &text_item.group_bind_group, &[]);
                draw_ui_geometry(render_pass, &text_item.vertex_buffer, &text_item.index_buffer, text_item.indices.len());
            }
        }

        // Render Stunts Images
        for image_item in &editor.stunts_images {
            if !image_item.hidden && current_time_ms >= image_item.start_time_ms && current_time_ms <= image_item.start_time_ms + image_item.duration_ms {
                image_item.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &image_item.bind_group, &[]);
                render_pass.set_bind_group(3, &image_item.group_bind_group, &[]);
                draw_ui_geometry(render_pass, &image_item.vertex_buffer, &image_item.index_buffer, image_item.indices.len());
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
                draw_ui_geometry(render_pass, &video_item.vertex_buffer, &video_item.index_buffer, video_item.indices.len());
            }
        }
    }
}

/// Binds and draws one UI item's geometry, skipping items that tessellated to
/// nothing (e.g. a bar resized to zero width). Their buffers are zero-sized, and
/// wgpu panics on `slice(..)` of an empty buffer.
fn draw_ui_geometry<'rp>(
    render_pass: &mut wgpu::RenderPass<'rp>,
    vertex_buffer: &'rp wgpu::Buffer,
    index_buffer: &'rp wgpu::Buffer,
    index_count: usize,
) {
    if index_count == 0 || vertex_buffer.size() == 0 || index_buffer.size() == 0 {
        return;
    }
    render_pass.set_vertex_buffer(0, vertex_buffer.slice(..));
    render_pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint32);
    render_pass.draw_indexed(0..index_count as u32, 0, 0..1);
}
