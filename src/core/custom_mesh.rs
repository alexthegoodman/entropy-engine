use nalgebra::{Matrix4, Vector3, Isometry3};
use wgpu::util::DeviceExt;
use crate::core::{SimpleCamera::SimpleCamera, Transform_2::{Transform, matrix4_to_raw_array}, transform::create_empty_group_transform};
use std::sync::Arc;
use wgpu;
use crate::core::editor::WindowSize;

use rapier3d::prelude::{Collider, ColliderHandle, RigidBody, RigidBodyHandle};

/// Immutable GPU geometry that several meshes can draw. `Entropy.MeshCache.createMesh` spawns
/// every mesh of one cached key from the same pair of buffers (see AddonContext::shared_geometry),
/// so twenty pedestrians of one body variant hold one copy of its vertices on the GPU, not twenty.
pub struct SharedGeometry {
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub num_indices: u32,
}

impl std::fmt::Debug for SharedGeometry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharedGeometry").field("vertex_bytes", &self.vertex_buffer.size()).field("num_indices", &self.num_indices).finish()
    }
}

impl SharedGeometry {
    pub fn upload(device: &wgpu::Device, label: &str, vertex_data: &[u8], index_data: &[u8]) -> Self {
        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(&format!("Custom Mesh Vertex Buffer {}", label)),
            contents: vertex_data,
            // COPY_DST is required for Entropy.Mesh.updateVertices (op_mesh_update_vertices,
            // addon_engine.rs) to queue.write_buffer into this buffer after creation - without
            // it, wgpu rejects the write with a validation panic rather than silently ignoring
            // it, which is how the queue.write_buffer half of that op's fix was actually found.
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        });
        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(&format!("Custom Mesh Index Buffer {}", label)),
            contents: index_data,
            usage: wgpu::BufferUsages::INDEX,
        });
        Self { vertex_buffer, index_buffer, num_indices: (index_data.len() / 4) as u32 }
    }

    pub fn bytes(&self) -> u64 { self.vertex_buffer.size() + self.index_buffer.size() }
}

/// The 1x1 albedo/normal/pbr-params placeholders and sampler that fill the texture slots of an
/// addon mesh's model bind group. One set serves every addon mesh (RendererState::mesh_fallback_material).
pub struct FallbackMaterial {
    pub sampler: wgpu::Sampler,
    pub albedo: wgpu::TextureView,
    pub normal: wgpu::TextureView,
    pub pbr: wgpu::TextureView,
}

impl FallbackMaterial {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        let make_placeholder = |label: &str, pixel: [u8; 4]| {
            let size = wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 };
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
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
                &pixel,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: None },
                size,
            );
            texture.create_view(&wgpu::TextureViewDescriptor {
                dimension: Some(wgpu::TextureViewDimension::D2Array),
                ..Default::default()
            })
        };
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        Self {
            sampler,
            albedo: make_placeholder("Addon Mesh Fallback Albedo", [255, 255, 255, 255]),
            // (0,0,1) normal in Rgba8Unorm
            normal: make_placeholder("Addon Mesh Fallback Normal", [128, 128, 255, 255]),
            // metallic=0, roughness=1, AO=1
            pbr: make_placeholder("Addon Mesh Fallback PBR", [0, 255, 255, 255]),
        }
    }

    /// A model bind group (model_bind_group_layout: transform, albedo, sampler, render mode,
    /// normal, pbr params) for `transform_buffer` with these placeholders.
    pub fn model_bind_group(&self, device: &wgpu::Device, layout: &wgpu::BindGroupLayout, transform_buffer: &wgpu::Buffer, render_mode_buffer: &wgpu::Buffer, label: &str) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: transform_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&self.albedo) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer: render_mode_buffer, offset: 0, size: None }),
                },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&self.normal) },
                wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(&self.pbr) },
            ],
            label: Some(label),
        })
    }
}

pub struct CustomMesh {
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub num_indices: u32,
    /// Instances drawn (`@builtin(instance_index)` 0..instance_count). 0 skips the draw
    /// entirely: Entropy.Model.setInstanceCount hides a pooled mesh without destroying it.
    pub instance_count: u32,
    /// Bounding sphere (center, radius) in the space the camera draws in (render space), for
    /// frustum culling; None: always drawn. The engine cannot derive it when an addon's own
    /// uniforms place the mesh (Entropy.Model.setBounds / createMesh `bounds` supply it).
    pub bounds: Option<([f32; 3], f32)>,
    /// Keeps geometry shared with other meshes alive (MeshCache-spawned meshes); None when this
    /// mesh owns its buffers outright.
    pub geometry: Option<Arc<SharedGeometry>>,
    pub pipeline: Arc<wgpu::RenderPipeline>,
    pub pipeline_id: String,
    pub bind_groups: Vec<wgpu::BindGroup>,
    pub transform: Transform,
    pub id: String,
    pub uniform_buffers: Vec<wgpu::Buffer>, // Store created uniform buffers to keep them alive
    pub samplers: Vec<wgpu::Sampler>, // Add this
    pub time_buffer: Option<wgpu::Buffer>,
    pub render_role: Option<String>,
    pub model_bind_group: wgpu::BindGroup,
    /// Group 1 for the non-PBR addon pass (render mode 2). Built once here; that pass used to
    /// create it - plus three textures and a sampler - for every mesh, every frame.
    pub unlit_bind_group: wgpu::BindGroup,
    pub group_bind_group: wgpu::BindGroup,
    pub behavior_id: Option<String>,
    pub yumon_id: Option<String>,

    // Physics
    pub rapier_collider: Collider,
    pub collider_handle: Option<ColliderHandle>,
    pub rapier_rigidbody: RigidBody,
    pub rigid_body_handle: Option<RigidBodyHandle>,

    /// The matrix last written to the transform's uniform buffer: unchanged transforms (static
    /// terrain chunks, houses) skip the per-frame upload.
    last_uploaded_transform: std::sync::Mutex<Option<[[f32; 4]; 4]>>,
}

use rapier3d::prelude::{ColliderBuilder, RigidBodyBuilder, LockedAxes};

impl CustomMesh {
    pub fn new(
        device: &wgpu::Device,
        geometry: Arc<SharedGeometry>,
        shared: bool,
        pipeline: Arc<wgpu::RenderPipeline>,
        pipeline_id: String,
        bind_groups: Vec<wgpu::BindGroup>,
        position: [f32; 3],
        id: String,
        uniform_buffers: Vec<wgpu::Buffer>,
        samplers: Vec<wgpu::Sampler>,
        instance_count: u32,
        time_buffer: Option<wgpu::Buffer>,

        model_bind_group_layout: &wgpu::BindGroupLayout,
        texture_render_mode_buffer: &wgpu::Buffer,
        unlit_render_mode_buffer: &wgpu::Buffer,
        fallback: &FallbackMaterial,
        group_bind_group_layout: &wgpu::BindGroupLayout,
        camera: &SimpleCamera
    ) -> Self {
        let uuid = uuid::Uuid::parse_str(&id).unwrap_or_else(|_| uuid::Uuid::new_v4());

        let rapier_collider = ColliderBuilder::capsule_y(1.0, 0.5)
            .friction(0.7)
            .restitution(0.0)
            .density(1.0)
            .user_data(uuid.as_u128())
            .build();

        let rapier_rigidbody = RigidBodyBuilder::fixed()
            .position(Isometry3::translation(position[0], position[1], position[2]))
            .user_data(uuid.as_u128())
            .build();

        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("CustomMesh Uniform Buffer"),
            contents: bytemuck::cast_slice(&raw_matrix),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let bind_group = fallback.model_bind_group(device, model_bind_group_layout, &uniform_buffer, texture_render_mode_buffer, "CustomMesh Model Bind Group");
        let unlit_bind_group = fallback.model_bind_group(device, model_bind_group_layout, &uniform_buffer, unlit_render_mode_buffer, "Mesh Transform Bind Group");

        let mut transform = Transform::new(
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(1.0, 1.0, 1.0),
            uniform_buffer,
        );

        let (tmp_group_bind_group, tmp_group_transform) =
            create_empty_group_transform(device, group_bind_group_layout, &WindowSize {
                width: camera.viewport.window_size.width,
                height: camera.viewport.window_size.height
            });

        transform.update_position(position);

        Self {
            vertex_buffer: geometry.vertex_buffer.clone(),
            index_buffer: geometry.index_buffer.clone(),
            num_indices: geometry.num_indices,
            instance_count,
            bounds: None,
            geometry: shared.then_some(geometry),
            pipeline,
            pipeline_id,
            bind_groups,
            transform,
            id,
            uniform_buffers,
            samplers,
            time_buffer,
            render_role: None,
            model_bind_group: bind_group,
            unlit_bind_group,
            group_bind_group: tmp_group_bind_group,
            behavior_id: None,
            yumon_id: None,
            rapier_collider,
            collider_handle: None,
            rapier_rigidbody,
            rigid_body_handle: None,
            last_uploaded_transform: std::sync::Mutex::new(None),
        }
    }

    /// Writes the transform's matrix to its uniform buffer if it changed since the last write
    /// through here. Returns whether it wrote.
    pub fn upload_transform(&self, queue: &wgpu::Queue) -> bool {
        let raw = matrix4_to_raw_array(&self.transform.update_transform().transpose());
        let mut last = self.last_uploaded_transform.lock().unwrap_or_else(|e| e.into_inner());
        if *last == Some(raw) { return false; }
        queue.write_buffer(&self.transform.uniform_buffer, 0, bytemuck::cast_slice(&raw));
        *last = Some(raw);
        true
    }
}
