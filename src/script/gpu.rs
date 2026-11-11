//! Draws what scripts asked for: their WGSL pipelines over cached meshes, each mesh instanced
//! from buffers the script fills, then the UI on top - one pass, no deferred lighting.
//!
//! Bind groups follow Studio's addon convention, so a shader written for an Entropy addon
//! pipeline with the `mesh` layout runs here unchanged:
//! - group 0: the camera (`view_proj`, `view_pos`, window size, inverse view and projection);
//! - group 1: the model (`model_matrix`, identity here: instancing places things);
//! - group 2 and up: the pipeline's own `extraBindGroups`, bound per mesh from `bindings`.

use std::collections::HashMap;
use std::rc::Rc;

use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;

use super::state::{BindingKind, CameraState, EngineState, GpuCommand, MeshData, PipelineDesc, VERTEX_FLOATS};
use super::ui::UiRenderer;

pub const DEPTH_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth24Plus;
const NEAR: f32 = 0.1;
const FAR: f32 = 10000.0;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct CameraUniform {
    view_proj: [[f32; 4]; 4],
    view_pos: [f32; 4],
    window_size: [f32; 2],
    _pad: [f32; 2],
    inverse_view: [[f32; 4]; 4],
    inverse_projection: [[f32; 4]; 4],
}

// --- Small column-major matrix math (no nalgebra on the web build). ---

type M4 = [[f32; 4]; 4];

fn mul(a: &M4, b: &M4) -> M4 {
    let mut o = [[0.0; 4]; 4];
    for c in 0..4 {
        for r in 0..4 {
            o[c][r] = (0..4).map(|k| a[k][r] * b[c][k]).sum();
        }
    }
    o
}

fn sub3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn cross3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn dot3(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn norm3(a: [f32; 3]) -> [f32; 3] {
    let l = dot3(a, a).sqrt();
    if l > 1e-12 { [a[0] / l, a[1] / l, a[2] / l] } else { [0.0, 0.0, -1.0] }
}

/// Right-handed look-at, as nalgebra's `look_at_rh` (Studio's camera).
fn look_at(eye: [f32; 3], target: [f32; 3], up: [f32; 3]) -> M4 {
    let f = norm3(sub3(target, eye));
    let mut s = cross3(f, up);
    if dot3(s, s) < 1e-12 {
        s = cross3(f, [0.0, 0.0, 1.0]);
    }
    let s = norm3(s);
    let u = cross3(s, f);
    [
        [s[0], u[0], -f[0], 0.0],
        [s[1], u[1], -f[1], 0.0],
        [s[2], u[2], -f[2], 0.0],
        [-dot3(s, eye), -dot3(u, eye), dot3(f, eye), 1.0],
    ]
}

/// Right-handed perspective with WebGPU's 0..1 depth.
fn perspective(fovy: f32, aspect: f32, near: f32, far: f32) -> M4 {
    let f = 1.0 / (fovy / 2.0).tan();
    [
        [f / aspect, 0.0, 0.0, 0.0],
        [0.0, f, 0.0, 0.0],
        [0.0, 0.0, far / (near - far), -1.0],
        [0.0, 0.0, near * far / (near - far), 0.0],
    ]
}

fn inverse(m: &M4) -> M4 {
    // Gauss-Jordan on the row-major transpose; fine for a handful of matrices a frame.
    let mut a = [[0.0f64; 8]; 4];
    for r in 0..4 {
        for c in 0..4 {
            a[r][c] = m[c][r] as f64;
        }
        a[r][4 + r] = 1.0;
    }
    for col in 0..4 {
        let pivot = (col..4).max_by(|&x, &y| a[x][col].abs().total_cmp(&a[y][col].abs())).unwrap();
        a.swap(col, pivot);
        let p = a[col][col];
        if p.abs() < 1e-12 {
            return [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]];
        }
        for c in 0..8 {
            a[col][c] /= p;
        }
        for r in 0..4 {
            if r != col {
                let k = a[r][col];
                for c in 0..8 {
                    a[r][c] -= k * a[col][c];
                }
            }
        }
    }
    let mut o = [[0.0; 4]; 4];
    for r in 0..4 {
        for c in 0..4 {
            o[c][r] = a[r][4 + c] as f32;
        }
    }
    o
}

/// The six frustum planes (inward normals) of a view-projection, for sphere culling.
fn frustum(vp: &M4) -> [[f32; 4]; 6] {
    let row = |r: usize| [vp[0][r], vp[1][r], vp[2][r], vp[3][r]];
    let (r0, r1, r2, r3) = (row(0), row(1), row(2), row(3));
    let add = |a: [f32; 4], b: [f32; 4], s: f32| [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2], a[3] + s * b[3]];
    let mut planes = [add(r3, r0, 1.0), add(r3, r0, -1.0), add(r3, r1, 1.0), add(r3, r1, -1.0), r2, add(r3, r2, -1.0)];
    for p in planes.iter_mut() {
        let l = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt().max(1e-12);
        for v in p.iter_mut() {
            *v /= l;
        }
    }
    planes
}

struct PipelineEntry {
    pipeline: wgpu::RenderPipeline,
    desc: PipelineDesc,
    extra_layouts: Vec<wgpu::BindGroupLayout>,
}

struct GpuMesh {
    vertices: wgpu::Buffer,
    indices: wgpu::Buffer,
    count: u32,
}

struct MeshEntry {
    pipeline: String,
    geometry: Rc<GpuMesh>,
    instances: u32,
    groups: Vec<(u32, wgpu::BindGroup)>,
    bounds: Option<([f32; 3], f32)>,
}

pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub format: wgpu::TextureFormat,
    camera_buffer: wgpu::Buffer,
    camera_group: wgpu::BindGroup,
    camera_layout: wgpu::BindGroupLayout,
    model_layout: wgpu::BindGroupLayout,
    model_group: wgpu::BindGroup,
    pipelines: HashMap<String, PipelineEntry>,
    buffers: HashMap<String, wgpu::Buffer>,
    geometry: HashMap<usize, (Rc<MeshData>, Rc<GpuMesh>)>,
    /// Meshes in creation order (opaque draw first, then transparent, each in this order).
    meshes: Vec<(String, MeshEntry)>,
    depth: Option<(wgpu::Texture, wgpu::TextureView, [u32; 2])>,
    pub ui: UiRenderer,
    pub errors: Vec<String>,
    pub drawn: u32,
    /// The scene's own target when it renders below the window's resolution (a HiDPI browser
    /// window draws the scene at CSS pixels and scales it up; the UI stays sharp).
    scene_target: Option<(wgpu::Texture, wgpu::TextureView, [u32; 2], wgpu::BindGroup)>,
    blit_pipeline: wgpu::RenderPipeline,
    blit_layout: wgpu::BindGroupLayout,
    blit_sampler: wgpu::Sampler,
}

fn bgl_entry(binding: u32, visibility: wgpu::ShaderStages, ty: wgpu::BufferBindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility, ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: None }, count: None }
}

impl Gpu {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue, format: wgpu::TextureFormat) -> Self {
        let camera_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("script camera"),
            entries: &[bgl_entry(0, wgpu::ShaderStages::VERTEX_FRAGMENT, wgpu::BufferBindingType::Uniform)],
        });
        let model_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("script model"),
            entries: &[bgl_entry(0, wgpu::ShaderStages::VERTEX_FRAGMENT, wgpu::BufferBindingType::Uniform)],
        });
        let camera_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("script camera"),
            size: std::mem::size_of::<CameraUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let camera_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("script camera"),
            layout: &camera_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: camera_buffer.as_entire_binding() }],
        });
        let identity: [[f32; 4]; 4] = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]];
        let model_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("script model"),
            contents: bytemuck::cast_slice(&[identity]),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let model_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("script model"),
            layout: &model_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: model_buffer.as_entire_binding() }],
        });
        let ui = UiRenderer::new(&device, format);
        let blit_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("script blit"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let blit_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("script blit"), source: wgpu::ShaderSource::Wgsl(BLIT_SHADER.into()) });
        let blit_pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("script blit"), bind_group_layouts: &[&blit_layout], push_constant_ranges: &[] });
        let blit_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("script blit"),
            layout: Some(&blit_pl),
            vertex: wgpu::VertexState { module: &blit_shader, entry_point: Some("vs_main"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState {
                module: &blit_shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });
        let blit_sampler = device.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
        Self {
            device,
            queue,
            format,
            camera_buffer,
            camera_group,
            camera_layout,
            model_layout,
            model_group,
            pipelines: HashMap::new(),
            buffers: HashMap::new(),
            geometry: HashMap::new(),
            meshes: Vec::new(),
            depth: None,
            ui,
            errors: Vec::new(),
            drawn: 0,
            scene_target: None,
            blit_pipeline,
            blit_layout,
            blit_sampler,
        }
    }

    fn error(&mut self, e: String) {
        log::warn!("{e}");
        self.errors.push(e);
    }

    fn create_pipeline(&mut self, id: String, desc: PipelineDesc) {
        let device = &self.device;
        let vertex_src = desc.vertex_shader.clone().unwrap_or_else(|| DEFAULT_SHADER.to_string());
        let fragment_src = desc.fragment_shader.clone().unwrap_or_else(|| vertex_src.clone());
        let extra_layouts: Vec<wgpu::BindGroupLayout> = desc
            .extra_groups
            .iter()
            .enumerate()
            .map(|(i, group)| {
                let entries: Vec<_> = group
                    .iter()
                    .map(|e| {
                        let mut vis = wgpu::ShaderStages::NONE;
                        if e.vertex {
                            vis |= wgpu::ShaderStages::VERTEX;
                        }
                        if e.fragment {
                            vis |= wgpu::ShaderStages::FRAGMENT;
                        }
                        if vis == wgpu::ShaderStages::NONE {
                            vis = wgpu::ShaderStages::VERTEX_FRAGMENT;
                        }
                        let ty = match e.kind {
                            BindingKind::Uniform => wgpu::BufferBindingType::Uniform,
                            BindingKind::StorageRead => wgpu::BufferBindingType::Storage { read_only: true },
                        };
                        bgl_entry(e.binding, vis, ty)
                    })
                    .collect();
                device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(&format!("{} group {}", desc.name, i + 2)), entries: &entries })
            })
            .collect();
        let mut layouts: Vec<&wgpu::BindGroupLayout> = vec![&self.camera_layout, &self.model_layout];
        layouts.extend(extra_layouts.iter());

        device.push_error_scope(wgpu::ErrorFilter::Validation);
        let vs = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(&format!("{} vs", desc.name)), source: wgpu::ShaderSource::Wgsl(vertex_src.into()) });
        let fs = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(&format!("{} fs", desc.name)), source: wgpu::ShaderSource::Wgsl(fragment_src.into()) });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some(&desc.name), bind_group_layouts: &layouts, push_constant_ranges: &[] });
        let blend = wgpu::BlendState {
            color: wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::SrcAlpha,
                dst_factor: if desc.additive { wgpu::BlendFactor::One } else { wgpu::BlendFactor::OneMinusSrcAlpha },
                operation: wgpu::BlendOperation::Add,
            },
            alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
        };
        let attrs = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2, 3 => Float32x4];
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(&desc.name),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &vs,
                entry_point: Some("vs_main"),
                buffers: &[wgpu::VertexBufferLayout { array_stride: (VERTEX_FLOATS * 4) as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &attrs }],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &fs,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState { format: self.format, blend: Some(blend), write_mask: wgpu::ColorWrites::ALL })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: if desc.double_sided { None } else { Some(wgpu::Face::Back) },
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: DEPTH_FORMAT,
                depth_write_enabled: !desc.transparent,
                depth_compare: wgpu::CompareFunction::Less,
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });
        // Natively a validation error is reported here; in a browser the scope resolves later
        // and WebGPU logs it to the console itself.
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(e) = pollster::block_on(device.pop_error_scope()) {
            self.error(format!("pipeline {:?}: {e}", desc.name));
            return;
        }
        #[cfg(target_arch = "wasm32")]
        {
            let _ = device.pop_error_scope();
        }
        self.pipelines.insert(id, PipelineEntry { pipeline, desc, extra_layouts });
    }

    fn geometry_for(&mut self, mesh: &Rc<MeshData>) -> Rc<GpuMesh> {
        let key = Rc::as_ptr(mesh) as usize;
        if let Some((_, g)) = self.geometry.get(&key) {
            return g.clone();
        }
        let vertices = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("script mesh vertices"),
            contents: bytemuck::cast_slice(&mesh.vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let indices = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("script mesh indices"),
            contents: bytemuck::cast_slice(&mesh.indices),
            usage: wgpu::BufferUsages::INDEX,
        });
        let g = Rc::new(GpuMesh { vertices, indices, count: mesh.indices.len() as u32 });
        // The Rc kept alongside pins the pointer used as the key.
        self.geometry.insert(key, (mesh.clone(), g.clone()));
        g
    }

    pub fn apply(&mut self, commands: Vec<GpuCommand>) {
        for c in commands {
            match c {
                GpuCommand::CreatePipeline { id, desc } => self.create_pipeline(id, desc),
                GpuCommand::CreateBuffer { id, size, storage } => {
                    let usage = if storage { wgpu::BufferUsages::STORAGE } else { wgpu::BufferUsages::UNIFORM } | wgpu::BufferUsages::COPY_DST;
                    let size = size.max(16).div_ceil(16) * 16;
                    let b = self.device.create_buffer(&wgpu::BufferDescriptor { label: Some(&id), size, usage, mapped_at_creation: false });
                    self.buffers.insert(id, b);
                }
                GpuCommand::WriteBuffer { id, offset, data } => match self.buffers.get(&id) {
                    Some(b) if offset + data.len() as u64 <= b.size() => {
                        let n = data.len() / 4 * 4;
                        if n > 0 {
                            self.queue.write_buffer(b, offset, &data[..n]);
                        }
                    }
                    Some(_) => self.error(format!("Buffer.write: {} bytes do not fit buffer {id}", data.len())),
                    None => self.error(format!("Buffer.write: no buffer {id}")),
                },
                GpuCommand::DestroyBuffer { id } => {
                    if let Some(b) = self.buffers.remove(&id) {
                        b.destroy();
                    }
                }
                GpuCommand::CreateMesh { id, mesh, pipeline, instances, bindings } => {
                    let Some(p) = self.pipelines.get(&pipeline) else {
                        self.error(format!("mesh {id}: no pipeline {pipeline}"));
                        continue;
                    };
                    let mut groups = Vec::new();
                    let mut failed = None;
                    for (i, layout) in p.extra_layouts.iter().enumerate() {
                        let g = (i + 2) as u32;
                        let mut entries = Vec::new();
                        for b in bindings.iter().filter(|b| b.group == g) {
                            match self.buffers.get(&b.buffer) {
                                Some(buf) => entries.push(wgpu::BindGroupEntry { binding: b.binding, resource: buf.as_entire_binding() }),
                                None => failed = Some(format!("mesh {id}: no buffer {}", b.buffer)),
                            }
                        }
                        if failed.is_some() {
                            break;
                        }
                        groups.push((g, self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(&id), layout, entries: &entries })));
                    }
                    if let Some(e) = failed {
                        self.error(e);
                        continue;
                    }
                    let geometry = self.geometry_for(&mesh);
                    self.meshes.retain(|(m, _)| *m != id);
                    self.meshes.push((id, MeshEntry { pipeline, geometry, instances, groups, bounds: None }));
                }
                GpuCommand::ClearMesh { id } => self.meshes.retain(|(m, _)| *m != id),
                GpuCommand::SetInstanceCount { id, count } => {
                    if let Some((_, m)) = self.meshes.iter_mut().find(|(m, _)| *m == id) {
                        m.instances = count;
                    }
                }
                GpuCommand::SetBounds { id, bounds } => {
                    if let Some((_, m)) = self.meshes.iter_mut().find(|(m, _)| *m == id) {
                        m.bounds = bounds;
                    }
                }
            }
        }
        // Geometry no mesh uses any more goes (a script that rebuilt its cache).
        if self.geometry.len() > 64 {
            let live: std::collections::HashSet<usize> = self.meshes.iter().map(|(_, m)| Rc::as_ptr(&m.geometry) as usize).collect();
            self.geometry.retain(|_, (_, g)| live.contains(&(Rc::as_ptr(g) as usize)));
        }
    }

    fn depth_view(&mut self, size: [u32; 2]) -> wgpu::TextureView {
        if self.depth.as_ref().map(|d| d.2) != Some(size) {
            let t = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("script depth"),
                size: wgpu::Extent3d { width: size[0].max(1), height: size[1].max(1), depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: DEPTH_FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            });
            let v = t.create_view(&Default::default());
            self.depth = Some((t, v, size));
        }
        self.depth.as_ref().unwrap().1.clone()
    }

    fn camera(&self, cam: &CameraState, size: [u32; 2]) -> (CameraUniform, M4) {
        let aspect = size[0].max(1) as f32 / size[1].max(1) as f32;
        let view = look_at(cam.position, cam.target, cam.up);
        let proj = perspective(cam.fov.clamp(5.0, 150.0).to_radians(), aspect, NEAR, FAR);
        let vp = mul(&proj, &view);
        let u = CameraUniform {
            view_proj: vp,
            view_pos: [cam.position[0], cam.position[1], cam.position[2], 1.0],
            window_size: [size[0] as f32, size[1] as f32],
            _pad: [0.0; 2],
            inverse_view: inverse(&view),
            inverse_projection: inverse(&proj),
        };
        (u, vp)
    }

    fn scene_view(&mut self, size: [u32; 2]) -> (wgpu::TextureView, wgpu::BindGroup) {
        if self.scene_target.as_ref().map(|t| t.2) != Some(size) {
            let t = self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("script scene"),
                size: wgpu::Extent3d { width: size[0].max(1), height: size[1].max(1), depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: self.format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let v = t.create_view(&Default::default());
            let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("script blit"),
                layout: &self.blit_layout,
                entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&v) }, wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.blit_sampler) }],
            });
            self.scene_target = Some((t, v, size, bg));
        }
        let t = self.scene_target.as_ref().unwrap();
        (t.1.clone(), t.3.clone())
    }

    /// Applies the queued commands and draws a frame into `target` (`physical` pixels). The
    /// scene renders at `logical` size - what scripts see as the window - and is scaled up when
    /// that is smaller; the UI is laid out in logical pixels and drawn at full resolution.
    pub fn render(&mut self, state: &mut EngineState, target: &wgpu::TextureView, logical: [u32; 2], physical: [u32; 2]) {
        let commands = std::mem::take(&mut state.commands);
        self.apply(commands);
        let (cam, vp) = self.camera(&state.camera, logical);
        self.queue.write_buffer(&self.camera_buffer, 0, bytemuck::bytes_of(&cam));
        let planes = frustum(&vp);
        let scale = physical[0] as f32 / logical[0].max(1) as f32;
        self.ui.prepare(&self.device, &self.queue, &state.ui, logical, scale);
        let depth = self.depth_view(logical);
        let offscreen = logical != physical;
        let scene = if offscreen { Some(self.scene_view(logical)) } else { None };
        let scene_view = scene.as_ref().map(|s| &s.0).unwrap_or(target);
        let mut encoder = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("script frame") });
        let c = state.clear_color;
        let mut drawn = 0;
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("script scene"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: scene_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: c[0], g: c[1], b: c[2], a: c[3] }), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &depth,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Discard }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            for transparent in [false, true] {
                for (_, m) in &self.meshes {
                    let Some(p) = self.pipelines.get(&m.pipeline) else { continue };
                    if p.desc.transparent != transparent || m.instances == 0 {
                        continue;
                    }
                    if let Some((c, r)) = m.bounds {
                        if r >= 0.0 && planes.iter().any(|p| p[0] * c[0] + p[1] * c[1] + p[2] * c[2] + p[3] < -r) {
                            continue;
                        }
                    }
                    pass.set_pipeline(&p.pipeline);
                    pass.set_bind_group(0, &self.camera_group, &[]);
                    pass.set_bind_group(1, &self.model_group, &[]);
                    for (g, bg) in &m.groups {
                        pass.set_bind_group(*g, bg, &[]);
                    }
                    pass.set_vertex_buffer(0, m.geometry.vertices.slice(..));
                    pass.set_index_buffer(m.geometry.indices.slice(..), wgpu::IndexFormat::Uint32);
                    pass.draw_indexed(0..m.geometry.count, 0, 0..m.instances);
                    drawn += 1;
                }
            }
        }
        // The UI (and, when the scene rendered smaller, its upscale) in a pass of its own.
        {
            let load = if scene.is_some() { wgpu::LoadOp::Clear(wgpu::Color::BLACK) } else { wgpu::LoadOp::Load };
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("script ui"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load, store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            if let Some((_, blit_group)) = &scene {
                pass.set_pipeline(&self.blit_pipeline);
                pass.set_bind_group(0, blit_group, &[]);
                pass.draw(0..3, 0..1);
            }
            self.ui.draw(&mut pass);
        }
        self.queue.submit(Some(encoder.finish()));
        self.drawn = drawn;
    }

    /// Renders a frame offscreen and reads it back as tightly packed RGBA8 (native only: a
    /// browser cannot block on the GPU).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn capture(&mut self, state: &mut EngineState, size: [u32; 2]) -> Vec<u8> {
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("script capture"),
            size: wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        self.render(state, &view, size, size);
        let row = (size[0] * 4).div_ceil(256) * 256;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("script capture readback"),
            size: (row * size[1]) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(size[1]) } },
            wgpu::Extent3d { width: size[0], height: size[1], depth_or_array_layers: 1 },
        );
        self.queue.submit(Some(encoder.finish()));
        let slice = buffer.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        let data = slice.get_mapped_range();
        let bgra = matches!(self.format, wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb);
        let mut out = Vec::with_capacity((size[0] * size[1] * 4) as usize);
        for y in 0..size[1] {
            let line = &data[(y * row) as usize..(y * row + size[0] * 4) as usize];
            for px in line.chunks(4) {
                if bgra {
                    out.extend_from_slice(&[px[2], px[1], px[0], 255]);
                } else {
                    out.extend_from_slice(&[px[0], px[1], px[2], 255]);
                }
            }
        }
        out
    }

    pub fn mesh_count(&self) -> usize {
        self.meshes.len()
    }
}

const BLIT_SHADER: &str = r#"
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var src_sampler: sampler;
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VOut {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var o: VOut;
    o.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
    o.uv = vec2<f32>(p.x, 1.0 - p.y);
    return o;
}
@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> { return textureSampleLevel(src, src_sampler, in.uv, 0.0); }
"#;

/// A pipeline created without shaders draws vertex colors.
const DEFAULT_SHADER: &str = r#"
struct Camera { view_proj: mat4x4<f32>, view_pos: vec4<f32> };
@group(0) @binding(0) var<uniform> camera: Camera;
struct Model { model_matrix: mat4x4<f32> };
@group(1) @binding(0) var<uniform> model: Model;
struct VOut { @builtin(position) pos: vec4<f32>, @location(0) color: vec4<f32> };
@vertex
fn vs_main(@location(0) position: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>, @location(3) color: vec4<f32>) -> VOut {
    var o: VOut;
    o.pos = camera.view_proj * model.model_matrix * vec4<f32>(position, 1.0);
    o.color = color;
    return o;
}
@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> { return in.color; }
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inverse_undoes_the_view() {
        let v = look_at([1.0, 2.0, 3.0], [0.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
        let id = mul(&v, &inverse(&v));
        for c in 0..4 {
            for r in 0..4 {
                assert!((id[c][r] - if c == r { 1.0 } else { 0.0 }).abs() < 1e-4);
            }
        }
    }

    #[test]
    fn a_point_ahead_projects_to_the_centre() {
        let v = look_at([0.0, 0.0, 5.0], [0.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
        let p = perspective(1.0, 1.5, NEAR, FAR);
        let vp = mul(&p, &v);
        let clip: Vec<f32> = (0..4).map(|r| vp[3][r]).collect(); // the origin
        assert!(clip[0].abs() < 1e-5 && clip[1].abs() < 1e-5);
        assert!((clip[3] - 5.0).abs() < 1e-4, "w is the distance in front");
        let z = clip[2] / clip[3];
        assert!(z > 0.0 && z < 1.0);
    }
}
