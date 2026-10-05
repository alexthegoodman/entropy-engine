//! Cascaded sun shadows for addon pipelines that do their own lighting (render mode "mesh",
//! `pbr: false`), such as Allegiance's QuadPlanet world.
//!
//! A pipeline created with `sunShadows: true` gets two things:
//!
//! - a depth-only **caster** variant, built from the same WGSL with the vertex entry point
//!   `vs_shadow` (which must not touch the receiver group). Every mesh drawn with that pipeline
//!   is drawn again into each cascade with group 0 swapped for a copy of the camera uniform whose
//!   `view_proj` is the cascade's light matrix (the eye position stays the camera's, so anything
//!   the vertex stage decides by distance to the camera decides the same way for its shadow);
//! - a **receiver** bind group appended after its extra groups: binding 0 is the cascades as a
//!   `texture_depth_2d_array`, binding 1 a comparison sampler, binding 2 the `SunShadow` uniform
//!   (light matrices, each cascade's texel size in meters, count/map size/strength).
//!
//! The addon computes the light matrices (`Entropy.Lighting.setSunShadows`): it knows its own
//! render origin, sun and camera. Matrices map render space to clip space with z in [0, 1].

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use bytemuck::{Pod, Zeroable};

use crate::core::camera::CameraUniform;
use crate::core::custom_mesh::CustomMesh;
use crate::core::frustum::Frustum;
use crate::core::vertex::Vertex;

pub const MAX_CASCADES: usize = 4;
pub const SHADOW_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Depth32Float;
pub const DEFAULT_MAP_SIZE: u32 = 2048;

#[repr(C)]
#[derive(Debug, Copy, Clone, Pod, Zeroable)]
struct SunShadowUniform {
    cascades: [[f32; 16]; MAX_CASCADES],
    /// World size of one texel in each cascade (meters).
    texel: [f32; 4],
    /// x = active cascades (0 = everything lit), y = map size, z = strength, w = depth units per
    /// meter along the light (for bias in meters).
    params: [f32; 4],
}

/// Whether cascade `index` must be rendered on `frame`: always when its matrix changed (or it was
/// never rendered), else on every `every`-th frame, offset by the index so throttled cascades take
/// turns.
pub fn cascade_due(rendered: Option<&[f32; 16]>, matrix: &[f32; 16], frame: u64, index: usize, every: u32) -> bool {
    rendered != Some(matrix) || (frame + index as u64) % every.max(1) as u64 == 0
}

pub struct AddonSunShadows {
    pub map_size: u32,
    texture: wgpu::Texture,
    layer_views: Vec<wgpu::TextureView>,
    sampler: wgpu::Sampler,
    pub receiver_layout: Arc<wgpu::BindGroupLayout>,
    pub receiver_bind_group: wgpu::BindGroup,
    uniform_buffer: wgpu::Buffer,
    camera_buffers: Vec<wgpu::Buffer>,
    camera_bind_groups: Vec<wgpu::BindGroup>,
    /// Light view-projections (column-major), one per active cascade.
    pub cascades: Vec<[f32; 16]>,
    pub texel: [f32; 4],
    pub strength: f32,
    pub depth_per_meter: f32,
    /// Pipeline id -> its depth-only caster variant and how many cascades (nearest first) it
    /// casts into.
    pub casters: HashMap<String, (Arc<wgpu::RenderPipeline>, u32)>,
    /// Pipelines whose layout ends with the receiver group.
    pub receivers: HashSet<String>,
    /// Draws issued into the cascades last frame (all cascades).
    pub last_draws: u32,
    /// Per cascade: while its matrix holds still, it is re-rendered only every n-th frame (far
    /// cascades hold big, slow-changing scenery; 1 is every frame). Cascades are staggered so two
    /// throttled ones never refresh on the same frame.
    pub refresh: [u32; MAX_CASCADES],
    /// The matrix each cascade's map was last rendered with (None: never, or the map was remade).
    rendered: [Option<[f32; 16]>; MAX_CASCADES],
    frame: u64,
    /// Cascades actually rendered by the last `render`.
    pub last_rendered: u32,
}

impl AddonSunShadows {
    pub fn new(device: &wgpu::Device, map_size: u32) -> Self {
        let receiver_layout = Arc::new(device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Addon Sun Shadow Receiver Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Depth,
                        view_dimension: wgpu::TextureViewDimension::D2Array,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        }));
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Addon Sun Shadow Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            compare: Some(wgpu::CompareFunction::LessEqual),
            ..Default::default()
        });
        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Addon Sun Shadow Uniform"),
            size: std::mem::size_of::<SunShadowUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let camera_buffers = (0..MAX_CASCADES)
            .map(|i| device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(&format!("Addon Sun Shadow Camera {i}")),
                size: std::mem::size_of::<CameraUniform>() as u64,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }))
            .collect();
        let (texture, layer_views, receiver_bind_group) = Self::make_maps(device, map_size, &receiver_layout, &sampler, &uniform_buffer);
        Self {
            map_size,
            texture,
            layer_views,
            sampler,
            receiver_layout,
            receiver_bind_group,
            uniform_buffer,
            camera_buffers,
            camera_bind_groups: Vec::new(),
            cascades: Vec::new(),
            texel: [0.0; 4],
            strength: 1.0,
            depth_per_meter: 0.0,
            casters: HashMap::new(),
            receivers: HashSet::new(),
            last_draws: 0,
            refresh: [1; MAX_CASCADES],
            rendered: [None; MAX_CASCADES],
            frame: 0,
            last_rendered: 0,
        }
    }

    fn make_maps(
        device: &wgpu::Device,
        map_size: u32,
        layout: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
        uniform: &wgpu::Buffer,
    ) -> (wgpu::Texture, Vec<wgpu::TextureView>, wgpu::BindGroup) {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Addon Sun Shadow Cascades"),
            size: wgpu::Extent3d { width: map_size, height: map_size, depth_or_array_layers: MAX_CASCADES as u32 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: SHADOW_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let layer_views = (0..MAX_CASCADES as u32)
            .map(|layer| texture.create_view(&wgpu::TextureViewDescriptor {
                label: Some("Addon Sun Shadow Cascade"),
                dimension: Some(wgpu::TextureViewDimension::D2),
                base_array_layer: layer,
                array_layer_count: Some(1),
                ..Default::default()
            }))
            .collect();
        let array_view = texture.create_view(&wgpu::TextureViewDescriptor {
            label: Some("Addon Sun Shadow Cascades View"),
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Addon Sun Shadow Receiver"),
            layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&array_view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(sampler) },
                wgpu::BindGroupEntry { binding: 2, resource: uniform.as_entire_binding() },
            ],
        });
        (texture, layer_views, bind_group)
    }

    /// A new shadow map resolution (clamped to 256..=8192): the cascades are remade.
    pub fn set_map_size(&mut self, device: &wgpu::Device, map_size: u32) {
        let map_size = map_size.clamp(256, 8192);
        if map_size == self.map_size { return; }
        let (texture, views, bind_group) = Self::make_maps(device, map_size, &self.receiver_layout, &self.sampler, &self.uniform_buffer);
        self.texture = texture;
        self.layer_views = views;
        self.receiver_bind_group = bind_group;
        self.map_size = map_size;
        self.rendered = [None; MAX_CASCADES];
    }

    /// The depth-only variant of an addon pipeline: `vs_shadow`, no fragment stage, both faces
    /// (foliage and thin Mesha parts are single-sided), slope-scaled depth bias.
    pub fn create_caster(
        device: &wgpu::Device,
        name: &str,
        vertex_shader: &str,
        layouts: &[&wgpu::BindGroupLayout],
    ) -> wgpu::RenderPipeline {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(&format!("{name} Shadow Caster Shader")),
            source: wgpu::ShaderSource::Wgsl(vertex_shader.into()),
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some(&format!("{name} Shadow Caster Layout")),
            bind_group_layouts: layouts,
            push_constant_ranges: &[],
        });
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(&format!("{name} Shadow Caster")),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_shadow"),
                buffers: &[Vertex::desc()],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: None,
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: SHADOW_FORMAT,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::Less,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState { constant: 0, slope_scale: 1.5, clamp: 0.0 },
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        })
    }

    /// Renders every caster into every active cascade (each culled by the cascade's own
    /// frustum, not the camera's: a wall behind you still shades the street ahead) and uploads
    /// the receiver uniform. With no cascades it only uploads "everything lit".
    pub fn render<'m>(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        camera: &CameraUniform,
        camera_layout: &wgpu::BindGroupLayout,
        meshes: &[&'m CustomMesh],
    ) {
        let count = self.cascades.len().min(MAX_CASCADES);
        let mut uniform = SunShadowUniform {
            cascades: [[0.0; 16]; MAX_CASCADES],
            texel: self.texel,
            params: [count as f32, self.map_size as f32, self.strength, self.depth_per_meter],
        };
        for (i, c) in self.cascades.iter().take(count).enumerate() { uniform.cascades[i] = *c; }
        queue.write_buffer(&self.uniform_buffer, 0, bytemuck::cast_slice(&[uniform]));
        self.last_draws = 0;
        self.last_rendered = 0;
        self.frame = self.frame.wrapping_add(1);
        if count == 0 { self.rendered = [None; MAX_CASCADES]; return; }
        if self.camera_bind_groups.is_empty() {
            self.camera_bind_groups = self.camera_buffers.iter().map(|buffer| device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Addon Sun Shadow Camera"),
                layout: camera_layout,
                entries: &[wgpu::BindGroupEntry { binding: 0, resource: buffer.as_entire_binding() }],
            })).collect();
        }
        for (i, m) in self.cascades.iter().take(count).enumerate() {
            if !cascade_due(self.rendered[i].as_ref(), m, self.frame, i, self.refresh[i]) { continue; }
            self.rendered[i] = Some(*m);
            self.last_rendered += 1;
            let cols = [[m[0], m[1], m[2], m[3]], [m[4], m[5], m[6], m[7]], [m[8], m[9], m[10], m[11]], [m[12], m[13], m[14], m[15]]];
            queue.write_buffer(&self.camera_buffers[i], 0, bytemuck::cast_slice(&[camera.with_view_proj(cols)]));
            let frustum = Frustum::from_view_proj(&nalgebra::Matrix4::from_column_slice(m));
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Addon Sun Shadow Cascade"),
                color_attachments: &[],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &self.layer_views[i],
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_bind_group(0, &self.camera_bind_groups[i], &[]);
            let mut current: Option<&str> = None;
            for mesh in meshes {
                let Some((caster, max_cascade)) = self.casters.get(&mesh.pipeline_id) else { continue };
                if i as u32 >= *max_cascade { continue; }
                if let Some((center, radius)) = mesh.bounds {
                    if !frustum.sphere_visible(center, radius) { continue; }
                }
                if current != Some(mesh.pipeline_id.as_str()) {
                    pass.set_pipeline(caster);
                    current = Some(mesh.pipeline_id.as_str());
                }
                mesh.upload_transform(queue);
                pass.set_bind_group(1, &mesh.unlit_bind_group, &[]);
                for (g, bind_group) in mesh.bind_groups.iter().enumerate() {
                    pass.set_bind_group((g + 2) as u32, bind_group, &[]);
                }
                pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                pass.set_index_buffer(mesh.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..mesh.num_indices, 0, 0..mesh.instance_count);
                self.last_draws += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::cascade_due;

    #[test]
    fn still_cascades_refresh_on_their_turn_and_moved_ones_at_once() {
        let a = [1.0f32; 16];
        let mut b = a;
        b[12] = 2.0;
        // Every frame by default, never-rendered or moved: always.
        assert!((0..8).all(|f| cascade_due(Some(&a), &a, f, 0, 1)));
        assert!(cascade_due(None, &a, 1, 3, 4));
        assert!(cascade_due(Some(&a), &b, 1, 3, 4));
        // Held still: cascade 2 every 2nd frame, cascade 3 every 4th, never on the same frame.
        let two: Vec<u64> = (0..8).filter(|&f| cascade_due(Some(&a), &a, f, 2, 2)).collect();
        let four: Vec<u64> = (0..8).filter(|&f| cascade_due(Some(&a), &a, f, 3, 4)).collect();
        assert_eq!(two, vec![0, 2, 4, 6]);
        assert_eq!(four, vec![1, 5]);
        assert!(two.iter().all(|f| !four.contains(f)));
    }
}
