//! Swapchain format adapter. Every pipeline that draws the final frame (scene, entropy_gui, glass
//! blur, addon pipelines) targets `Rgba8Unorm`, which Windows swapchains accept directly. Linux
//! Vulkan/X11 surfaces only offer BGRA formats, so there the frame is drawn into an offscreen
//! `Rgba8Unorm` texture of the window's size and copied onto the real swapchain texture by one
//! full-screen draw just before present. Where the surface supports `Rgba8Unorm` none of this runs.

pub const RENDER_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// `Rgba8Unorm` if the surface supports it, else the closest non-sRGB 8-bit format (the engine
/// writes non-sRGB values, so an sRGB swapchain would double-encode and wash the frame out).
pub fn pick_surface_format(supported: &[wgpu::TextureFormat]) -> wgpu::TextureFormat {
    [RENDER_FORMAT, wgpu::TextureFormat::Bgra8Unorm]
        .into_iter()
        .find(|format| supported.contains(format))
        .or_else(|| supported.iter().copied().find(|format| !format.is_srgb()))
        .or_else(|| supported.first().copied())
        .unwrap_or(RENDER_FORMAT)
}

pub fn needs_blit(surface_format: wgpu::TextureFormat) -> bool {
    surface_format != RENDER_FORMAT
}

pub struct SurfaceBlit {
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    target: Option<BlitTarget>,
}

struct BlitTarget {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    bind_group: wgpu::BindGroup,
}

impl SurfaceBlit {
    pub fn new(device: &wgpu::Device, surface_format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("surface blit shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/surface_blit.wgsl").into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("surface blit bind group layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering),
                    count: None,
                },
            ],
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("surface blit pipeline layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("surface blit pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("surface blit sampler"),
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        Self { pipeline, bind_group_layout, sampler, target: None }
    }

    /// The offscreen `RENDER_FORMAT` texture the frame should be drawn into, (re)created to match
    /// the swapchain texture's size.
    pub fn target(&mut self, device: &wgpu::Device, width: u32, height: u32) -> (&wgpu::Texture, &wgpu::TextureView) {
        let stale = self
            .target
            .as_ref()
            .map_or(true, |target| target.texture.width() != width || target.texture.height() != height);
        if stale {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("surface blit offscreen frame"),
                size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: RENDER_FORMAT,
                // Same usages the swapchain itself is configured with (see startup.rs), since
                // this texture stands in for it for the whole frame.
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("surface blit bind group"),
                layout: &self.bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                    wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                ],
            });
            self.target = Some(BlitTarget { texture, view, bind_group });
        }
        let target = self.target.as_ref().expect("surface blit target was just created");
        (&target.texture, &target.view)
    }

    /// Draws the offscreen frame onto the swapchain texture's view.
    pub fn blit(&self, encoder: &mut wgpu::CommandEncoder, surface_view: &wgpu::TextureView) {
        let Some(target) = &self.target else { return };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("surface blit"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: surface_view,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &target.bind_group, &[]);
        pass.draw(0..3, 0..1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wgpu::TextureFormat::*;

    #[test]
    fn keeps_rgba_when_supported() {
        assert_eq!(pick_surface_format(&[Bgra8UnormSrgb, Rgba8Unorm, Bgra8Unorm]), Rgba8Unorm);
    }

    #[test]
    fn falls_back_to_non_srgb_bgra() {
        assert_eq!(pick_surface_format(&[Bgra8UnormSrgb, Bgra8Unorm]), Bgra8Unorm);
        assert!(needs_blit(Bgra8Unorm));
        assert!(!needs_blit(Rgba8Unorm));
    }
}
