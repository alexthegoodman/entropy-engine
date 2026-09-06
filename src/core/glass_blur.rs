//! Backdrop blur for "glass" UI panels (activity bar, top bar, addon/script panels, the
//! Projects picker card) — see `render_egui.rs`'s `glass_fill`/`paint_glass_backdrop` for
//! where this gets sampled from.
//!
//! Deliberately a single fixed-size, low-resolution target rather than something that
//! tracks the window size: the source is sampled by UV (0..1), not by pixel, so a fixed
//! target still blurs the whole current frame correctly regardless of window size or
//! aspect ratio, and skipping resize handling entirely removes a whole class of bugs for
//! a purely cosmetic effect. `BLUR_WIDTH`/`BLUR_HEIGHT` trade quality for cost — the drop
//! in resolution from a real window (typically 1000+ px) is most of the blur; the 3x3
//! tent kernel in the shader just smooths the seams between output texels.
const BLUR_WIDTH: u32 = 384;
const BLUR_HEIGHT: u32 = 216;

pub struct GlassBlur {
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    texel_size_buffer: wgpu::Buffer,
    blur_texture: wgpu::Texture,
    blur_view: wgpu::TextureView,
}

impl GlassBlur {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("glass blur shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/glass_blur.wgsl").into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("glass blur bind group layout"),
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
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("glass blur pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("glass blur pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None,
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

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("glass blur sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let (blur_texture, blur_view) = Self::create_target(device, format);

        let texel_size_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("glass blur texel size"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Self { pipeline, bind_group_layout, sampler, texel_size_buffer, blur_texture, blur_view }
    }

    fn create_target(device: &wgpu::Device, format: wgpu::TextureFormat) -> (wgpu::Texture, wgpu::TextureView) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("glass blur target"),
            size: wgpu::Extent3d { width: BLUR_WIDTH, height: BLUR_HEIGHT, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        (texture, view)
    }

    pub fn blur_view(&self) -> &wgpu::TextureView {
        &self.blur_view
    }

    /// Re-blurs `source` (the just-rendered 3D scene, at its full resolution) into this
    /// struct's small internal target. `source` must have been created with
    /// `TEXTURE_BINDING` usage (the swapchain surface config grants this - see
    /// startup.rs). Call once per frame, after the 3D pass and before the egui pass that
    /// samples `blur_view()` for glass panel backgrounds.
    pub fn render(&self, device: &wgpu::Device, queue: &wgpu::Queue, encoder: &mut wgpu::CommandEncoder, source: &wgpu::TextureView, source_width: u32, source_height: u32) {
        queue.write_buffer(&self.texel_size_buffer, 0, bytemuck::cast_slice(&[1.0 / source_width.max(1) as f32, 1.0 / source_height.max(1) as f32, 0.0f32, 0.0f32]));

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("glass blur bind group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(source) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 2, resource: self.texel_size_buffer.as_entire_binding() },
            ],
        });

        let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("glass blur pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.blur_view,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        rpass.set_pipeline(&self.pipeline);
        rpass.set_bind_group(0, &bind_group, &[]);
        rpass.draw(0..3, 0..1);
    }
}
