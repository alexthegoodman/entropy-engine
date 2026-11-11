//! The 2D layer: a script's rects and texts drawn over the scene in window pixels (origin top
//! left). One pipeline draws both - solid quads and glyphs sampled from a coverage atlas - in a
//! single vertex buffer rebuilt only when the UI changed. Text is laid out with fontdue the way
//! Studio's text renderer does: top-left anchored, wrapped to the box's width.

use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use super::fonts::Fonts;
use super::state::UiState;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct UiVertex {
    pos: [f32; 2],
    uv: [f32; 2],
    color: [f32; 4],
    /// 0: solid fill; 1: glyph coverage from the atlas.
    mode: f32,
}

const ATLAS: u32 = 2048;

const SHADER: &str = r#"
struct Screen { size: vec4<f32> };
@group(0) @binding(0) var<uniform> screen: Screen;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var atlas_sampler: sampler;

struct VOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) mode: f32,
};

@vertex
fn vs_main(@location(0) pos: vec2<f32>, @location(1) uv: vec2<f32>, @location(2) color: vec4<f32>, @location(3) mode: f32) -> VOut {
    var o: VOut;
    let ndc = vec2<f32>(pos.x / screen.size.x * 2.0 - 1.0, 1.0 - pos.y / screen.size.y * 2.0);
    o.pos = vec4<f32>(ndc, 0.0, 1.0);
    o.uv = uv;
    o.color = color;
    o.mode = mode;
    return o;
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
    var a = in.color.a;
    let cov = textureSampleLevel(atlas, atlas_sampler, in.uv, 0.0).r;
    if (in.mode > 0.5) { a = a * cov; }
    return vec4<f32>(in.color.rgb * a, a);
}
"#;

struct Glyph {
    uv: [f32; 4],
    size: [f32; 2],
}

pub struct UiRenderer {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    screen_buffer: wgpu::Buffer,
    atlas: wgpu::Texture,
    glyphs: HashMap<fontdue::layout::GlyphRasterConfig, Option<Glyph>>,
    shelf: (u32, u32, u32),
    vertex_buffer: Option<wgpu::Buffer>,
    vertex_count: u32,
    built_version: u64,
    built_screen: [u32; 2],
    built_scale: f32,
    layout: fontdue::layout::Layout<()>,
    atlas_reset: bool,
}

impl UiRenderer {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("script ui"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
        let screen_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("script ui screen"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let atlas = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("script ui atlas"),
            size: wgpu::Extent3d { width: ATLAS, height: ATLAS, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = atlas.create_view(&Default::default());
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("script ui"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("script ui"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: screen_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&sampler) },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("script ui"), bind_group_layouts: &[&layout], push_constant_ranges: &[] });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("script ui"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<UiVertex>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32x4, 3 => Float32],
                }],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        Self {
            pipeline,
            bind_group,
            screen_buffer,
            atlas,
            glyphs: HashMap::new(),
            shelf: (0, 0, 0),
            vertex_buffer: None,
            vertex_count: 0,
            built_version: u64::MAX,
            built_screen: [0, 0],
            built_scale: 0.0,
            layout: fontdue::layout::Layout::new(fontdue::layout::CoordinateSystem::PositiveYDown),
            atlas_reset: false,
        }
    }

    fn quad(out: &mut Vec<UiVertex>, x0: f32, y0: f32, x1: f32, y1: f32, uv: [f32; 4], color: [f32; 4], mode: f32) {
        let v = |x: f32, y: f32, u: f32, w: f32| UiVertex { pos: [x, y], uv: [u, w], color, mode };
        let (u0, v0, u1, v1) = (uv[0], uv[1], uv[2], uv[3]);
        out.extend_from_slice(&[v(x0, y0, u0, v0), v(x1, y0, u1, v0), v(x1, y1, u1, v1), v(x0, y0, u0, v0), v(x1, y1, u1, v1), v(x0, y1, u0, v1)]);
    }

    fn glyph(&mut self, queue: &wgpu::Queue, key: fontdue::layout::GlyphRasterConfig, font: &fontdue::Font) -> Option<[f32; 6]> {
        if !self.glyphs.contains_key(&key) {
            let (metrics, bitmap) = font.rasterize_config(key);
            let entry = if metrics.width == 0 || metrics.height == 0 {
                None
            } else {
                let (w, h) = (metrics.width as u32, metrics.height as u32);
                let (mut x, mut y, mut row) = self.shelf;
                if x + w + 1 > ATLAS {
                    x = 0;
                    y += row + 1;
                    row = 0;
                }
                if y + h + 1 > ATLAS {
                    // Full: start over (the next frames re-add what they still draw).
                    self.glyphs.clear();
                    self.atlas_reset = true;
                    x = 0;
                    y = 0;
                    row = 0;
                }
                queue.write_texture(
                    wgpu::TexelCopyTextureInfo { texture: &self.atlas, mip_level: 0, origin: wgpu::Origin3d { x, y, z: 0 }, aspect: wgpu::TextureAspect::All },
                    &bitmap,
                    wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(w), rows_per_image: Some(h) },
                    wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                );
                self.shelf = (x + w + 1, y, row.max(h));
                let a = ATLAS as f32;
                Some(Glyph { uv: [x as f32 / a, y as f32 / a, (x + w) as f32 / a, (y + h) as f32 / a], size: [w as f32, h as f32] })
            };
            self.glyphs.insert(key, entry);
        }
        self.glyphs.get(&key).and_then(|g| g.as_ref()).map(|g| [g.uv[0], g.uv[1], g.uv[2], g.uv[3], g.size[0], g.size[1]])
    }

    /// Rebuilds the vertices when the UI or the window changed.
    pub fn prepare(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, ui: &UiState, screen: [u32; 2], scale: f32) {
        queue.write_buffer(&self.screen_buffer, 0, bytemuck::cast_slice(&[screen[0] as f32, screen[1] as f32, 0.0, 0.0]));
        if ui.version == self.built_version && screen == self.built_screen && scale == self.built_scale {
            return;
        }
        self.atlas_reset = false;
        let fonts = Fonts::get();
        let mut out: Vec<UiVertex> = Vec::with_capacity((ui.rects.len() + ui.texts.len() * 8) * 6);
        let none = [0.0; 4];
        for r in &ui.rects {
            let (x, y, w, h) = (r.pos[0], r.pos[1], r.size[0], r.size[1]);
            Self::quad(&mut out, x, y, x + w, y + h, none, r.color, 0.0);
            let s = r.stroke;
            if s > 0.0 && r.stroke_color[3] > 0.0 {
                let c = r.stroke_color;
                Self::quad(&mut out, x, y, x + w, y + s, none, c, 0.0);
                Self::quad(&mut out, x, y + h - s, x + w, y + h, none, c, 0.0);
                Self::quad(&mut out, x, y + s, x + s, y + h - s, none, c, 0.0);
                Self::quad(&mut out, x + w - s, y + s, x + w, y + h - s, none, c, 0.0);
            }
        }
        for t in &ui.texts {
            let (x, y) = (t.pos[0], t.pos[1]);
            if t.background[3] > 0.0 {
                Self::quad(&mut out, x, y, x + t.size[0], y + t.size[1], none, t.background, 0.0);
            }
            if t.text.trim().is_empty() || t.color[3] <= 0.0 || t.font_size <= 0.0 {
                continue;
            }
            let fi = Fonts::index(&t.font);
            let font = &fonts.fonts[fi];
            // Laid out and rasterized at device pixels (`scale` of them a UI pixel) so text stays
            // sharp on a HiDPI screen, then placed back in UI pixels.
            let k = scale.max(0.25);
            self.layout.reset(&fontdue::layout::LayoutSettings { max_width: if t.size[0] > 0.0 { Some(t.size[0] * k) } else { None }, ..Default::default() });
            self.layout.append(std::slice::from_ref(font), &fontdue::layout::TextStyle::new(&t.text, (t.font_size.round().max(1.0) * k).round(), 0));
            let placed: Vec<_> = self.layout.glyphs().iter().map(|g| (g.key, g.x, g.y)).collect();
            for (key, gx, gy) in placed {
                if let Some([u0, v0, u1, v1, w, h]) = self.glyph(queue, key, font) {
                    let (x0, y0) = (((x * k) + gx).round() / k, ((y * k) + gy).round() / k);
                    Self::quad(&mut out, x0, y0, x0 + w / k, y0 + h / k, [u0, v0, u1, v1], t.color, 1.0);
                }
            }
        }
        self.vertex_count = out.len() as u32;
        self.vertex_buffer = if out.is_empty() {
            None
        } else {
            Some(device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("script ui vertices"), contents: bytemuck::cast_slice(&out), usage: wgpu::BufferUsages::VERTEX }))
        };
        // A build that overflowed the atlas holds glyphs from before the reset: redo it next frame.
        self.built_version = if self.atlas_reset { u64::MAX } else { ui.version };
        self.built_screen = screen;
        self.built_scale = scale;
    }

    pub fn draw<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>) {
        if let Some(vb) = &self.vertex_buffer {
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.set_vertex_buffer(0, vb.slice(..));
            pass.draw(0..self.vertex_count, 0..1);
        }
    }
}
