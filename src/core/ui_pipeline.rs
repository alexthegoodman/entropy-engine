use crate::core::editor::Editor;
use crate::core::vertex::Vertex;
use crate::shape_primitives::polygon::Polygon;
use crate::renderer_text::text_due::TextRenderer;
use crate::renderer_images::st_image::StImage;
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
    }
}
