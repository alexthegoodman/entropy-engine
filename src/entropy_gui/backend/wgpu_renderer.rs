//! wgpu render backend, replacing `egui_wgpu::Renderer`. Reuses the engine's native `Vertex`
//! format and a shader with the same vertex/fragment logic as `src/core/shaders/ui.wgsl`
//! (see `shaders/gui.wgsl`), stripped to two bind groups since every vertex already carries
//! its final absolute pixel-space position (no per-object model transform needed for an
//! immediate-mode draw list). Batches the whole frame's draw list into one shared
//! vertex/index buffer and issues one `draw_indexed` per batch, clipped via
//! `set_scissor_rect` — the same clipping convention `render_addon_frame.rs` already uses.

use crate::core::vertex::Vertex;
use crate::entropy_gui::context::ImageDelta;
use crate::entropy_gui::draw_list::{DrawCommand, DrawTexture, TextureId};
use std::collections::HashMap;

const INITIAL_ATLAS_SIZE: u32 = 1024;

#[derive(Default)]
pub struct RendererOptions;

pub struct ScreenDescriptor {
    pub size_in_pixels: [u32; 2],
    pub pixels_per_point: f32,
}

pub struct Renderer {
    pipeline: wgpu::RenderPipeline,
    texture_bind_group_layout: wgpu::BindGroupLayout,
    window_size_buffer: wgpu::Buffer,
    window_size_bind_group: wgpu::BindGroup,
    sampler: wgpu::Sampler,
    white_texture: Option<wgpu::Texture>,
    white_bind_group: Option<wgpu::BindGroup>,
    atlas_texture: wgpu::Texture,
    atlas_bind_group: wgpu::BindGroup,
    native_textures: HashMap<TextureId, wgpu::BindGroup>,
    next_native_id: u64,
    vertex_buffer: wgpu::Buffer,
    index_buffer: wgpu::Buffer,
    vertex_capacity: usize,
    index_capacity: usize,
    batch_ranges: Vec<(u32, u32)>,
}

fn create_solid_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    layout: &wgpu::BindGroupLayout,
    sampler: &wgpu::Sampler,
    rgba: [u8; 4],
) -> (wgpu::Texture, wgpu::BindGroup) {
    let size = wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("entropy_gui solid texture"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        &rgba,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: None },
        size,
    );
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("entropy_gui solid texture bind group"),
        layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
        ],
    });
    (texture, bind_group)
}

impl Renderer {
    pub fn new(device: &wgpu::Device, output_color_format: wgpu::TextureFormat, _options: RendererOptions) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("entropy_gui shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("../shaders/gui.wgsl").into()),
        });

        let window_size_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("entropy_gui window size layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                count: None,
            }],
        });

        let texture_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("entropy_gui texture layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("entropy_gui pipeline layout"),
            bind_group_layouts: &[&window_size_bind_group_layout, &texture_bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("entropy_gui pipeline"),
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
                    format: output_color_format,
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
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let window_size_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("entropy_gui window size buffer"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let window_size_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("entropy_gui window size bind group"),
            layout: &window_size_bind_group_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: window_size_buffer.as_entire_binding() }],
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let atlas_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("entropy_gui glyph atlas"),
            size: wgpu::Extent3d { width: INITIAL_ATLAS_SIZE, height: INITIAL_ATLAS_SIZE, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let atlas_view = atlas_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let atlas_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("entropy_gui atlas bind group"),
            layout: &texture_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&atlas_view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) },
            ],
        });

        let vertex_capacity = 4096usize;
        let index_capacity = 8192usize;
        let vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("entropy_gui vertex buffer"),
            size: (vertex_capacity * std::mem::size_of::<Vertex>()) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let index_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("entropy_gui index buffer"),
            size: (index_capacity * std::mem::size_of::<u32>()) as u64,
            usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Self {
            pipeline,
            texture_bind_group_layout,
            window_size_buffer,
            window_size_bind_group,
            sampler,
            white_texture: None,
            white_bind_group: None,
            atlas_texture,
            atlas_bind_group,
            native_textures: HashMap::new(),
            next_native_id: 1,
            vertex_buffer,
            index_buffer,
            vertex_capacity,
            index_capacity,
            batch_ranges: Vec::new(),
        }
    }

    pub fn update_texture(&mut self, _device: &wgpu::Device, queue: &wgpu::Queue, id: TextureId, delta: &ImageDelta) {
        if id != TextureId::ATLAS || delta.width == 0 || delta.height == 0 {
            return;
        }
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.atlas_texture,
                mip_level: 0,
                origin: wgpu::Origin3d { x: delta.x, y: delta.y, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            &delta.rgba,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(delta.width * 4), rows_per_image: Some(delta.height) },
            wgpu::Extent3d { width: delta.width, height: delta.height, depth_or_array_layers: 1 },
        );
    }

    pub fn register_native_texture(&mut self, device: &wgpu::Device, view: &wgpu::TextureView, filter: wgpu::FilterMode) -> TextureId {
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: filter,
            min_filter: filter,
            mipmap_filter: filter,
            ..Default::default()
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("entropy_gui native texture bind group"),
            layout: &self.texture_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&sampler) },
            ],
        });
        let id = TextureId(self.next_native_id);
        self.next_native_id += 1;
        self.native_textures.insert(id, bind_group);
        id
    }

    pub fn update_buffers(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        _encoder: &mut wgpu::CommandEncoder,
        draw_commands: &[DrawCommand],
        screen_descriptor: &ScreenDescriptor,
    ) {
        if self.white_bind_group.is_none() {
            let (tex, bg) = create_solid_texture(device, queue, &self.texture_bind_group_layout, &self.sampler, [255, 255, 255, 255]);
            self.white_texture = Some(tex);
            self.white_bind_group = Some(bg);
        }

        let w = screen_descriptor.size_in_pixels[0] as f32;
        let h = screen_descriptor.size_in_pixels[1] as f32;
        queue.write_buffer(&self.window_size_buffer, 0, bytemuck::cast_slice(&[w, h, 0.0f32, 0.0f32]));

        let mut vertices: Vec<Vertex> = Vec::new();
        let mut indices: Vec<u32> = Vec::new();
        self.batch_ranges.clear();
        for cmd in draw_commands {
            let base = vertices.len() as u32;
            let index_start = indices.len() as u32;
            vertices.extend_from_slice(&cmd.vertices);
            indices.extend(cmd.indices.iter().map(|i| i + base));
            let index_count = indices.len() as u32 - index_start;
            self.batch_ranges.push((index_start, index_count));
        }

        if vertices.len() > self.vertex_capacity {
            self.vertex_capacity = (vertices.len() * 2).max(self.vertex_capacity);
            self.vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("entropy_gui vertex buffer"),
                size: (self.vertex_capacity * std::mem::size_of::<Vertex>()) as u64,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }
        if indices.len() > self.index_capacity {
            self.index_capacity = (indices.len() * 2).max(self.index_capacity);
            self.index_buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("entropy_gui index buffer"),
                size: (self.index_capacity * std::mem::size_of::<u32>()) as u64,
                usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }

        if !vertices.is_empty() {
            queue.write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(&vertices));
        }
        if !indices.is_empty() {
            queue.write_buffer(&self.index_buffer, 0, bytemuck::cast_slice(&indices));
        }
    }

    pub fn render<'rp>(&'rp self, render_pass: &mut wgpu::RenderPass<'rp>, draw_commands: &[DrawCommand], screen_descriptor: &ScreenDescriptor) {
        if draw_commands.is_empty() || self.batch_ranges.len() != draw_commands.len() {
            return;
        }

        render_pass.set_pipeline(&self.pipeline);
        render_pass.set_bind_group(0, &self.window_size_bind_group, &[]);
        render_pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
        render_pass.set_index_buffer(self.index_buffer.slice(..), wgpu::IndexFormat::Uint32);

        let fb_w = screen_descriptor.size_in_pixels[0] as f32;
        let fb_h = screen_descriptor.size_in_pixels[1] as f32;

        for (cmd, &(index_start, index_count)) in draw_commands.iter().zip(self.batch_ranges.iter()) {
            if index_count == 0 {
                continue;
            }
            let bind_group = match cmd.texture {
                DrawTexture::White => self.white_bind_group.as_ref(),
                DrawTexture::Glyph => Some(&self.atlas_bind_group),
                DrawTexture::Native(id) => self.native_textures.get(&id),
            };
            let Some(bind_group) = bind_group else { continue };
            render_pass.set_bind_group(1, bind_group, &[]);

            let clip = cmd.clip_rect;
            let x = clip.min.x.max(0.0).min(fb_w);
            let y = clip.min.y.max(0.0).min(fb_h);
            let ww = (clip.max.x.max(x).min(fb_w) - x).max(0.0);
            let hh = (clip.max.y.max(y).min(fb_h) - y).max(0.0);
            if ww <= 0.0 || hh <= 0.0 {
                continue;
            }
            render_pass.set_scissor_rect(x as u32, y as u32, ww as u32, hh as u32);
            render_pass.draw_indexed(index_start..index_start + index_count, 0, 0..1);
        }
    }
}
