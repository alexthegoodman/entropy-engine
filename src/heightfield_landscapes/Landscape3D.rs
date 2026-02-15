use nalgebra::{Isometry3, Matrix4, Point3, Vector3};
use rapier3d::prelude::{
    Collider, ColliderBuilder, ColliderHandle, RigidBody, RigidBodyBuilder,
    RigidBodyHandle,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use wgpu::util::DeviceExt;

use crate::core::SimpleCamera::SimpleCamera;
use crate::core::Transform_2::{matrix4_to_raw_array, Transform};
use crate::core::transform::create_empty_group_transform;
use crate::core::vertex::Vertex;
use crate::core::editor::WindowSize;

pub struct Landscape3D {
    pub id: String,
    pub transform: Transform,
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
    pub bind_group: wgpu::BindGroup,
    pub group_bind_group: wgpu::BindGroup,
    pub rapier_collider: Collider,
    pub rapier_rigidbody: RigidBody,
    pub collider_handle: Option<ColliderHandle>,
    pub rigid_body_handle: Option<RigidBodyHandle>,
    pub pipeline_id: Option<String>,
    pub render_role: Option<String>,
}

impl Landscape3D {
    pub fn new(
        id: &String,
        vertices: Vec<Vertex>,
        indices: Vec<u32>,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        group_bind_group_layout: &wgpu::BindGroupLayout,
        texture_render_mode_buffer: &wgpu::Buffer,
        color_render_mode_buffer: &wgpu::Buffer,
        position: [f32; 3],
        camera: &SimpleCamera,
        pipeline_id: Option<String>
    ) -> Self {
        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Landscape3D Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Landscape3D Index Buffer"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        // Create trimesh collider
        let rapier_vertices: Vec<Point3<f32>> = vertices.iter().map(|v| Point3::from(v.position)).collect();
        let rapier_indices: Vec<[u32; 3]> = indices.chunks(3).filter(|c| c.len() == 3).map(|c| [c[0], c[1], c[2]]).collect();

        let uuid = uuid::Uuid::parse_str(id).unwrap_or_else(|_| uuid::Uuid::new_v4());

        let terrain_collider = ColliderBuilder::trimesh(rapier_vertices, rapier_indices)
            .friction(0.9)
            .restitution(0.1)
            .user_data(uuid.as_u128())
            .build();

        let isometry = Isometry3::translation(position[0], position[1], position[2]);
        let ground_rigid_body = RigidBodyBuilder::fixed()
            .position(isometry)
            .user_data(uuid.as_u128())
            .build();

        // Create uniform buffer for transform
        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Landscape3D Uniform Buffer"),
            contents: bytemuck::cast_slice(&raw_matrix),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        // Create dummy textures/samplers to satisfy the bind group layout
        let texture_size = wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        };
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Default White Texture"),
            size: texture_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let white_pixel: [u8; 4] = [255, 255, 255, 255];
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &white_pixel,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: None,
            },
            texture_size,
        );
        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor::default());

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: texture_render_mode_buffer,
                        offset: 0,
                        size: None,
                    }),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(&texture_view), // Use same view for normal array
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::TextureView(&texture_view), // Use same view for pbr params array
                },
            ],
            label: Some("landscape3d_bind_group"),
        });

        let (group_bind_group, _) = create_empty_group_transform(device, group_bind_group_layout, &WindowSize {
            width: camera.viewport.window_size.width,
            height: camera.viewport.window_size.height
        });

        Self {
            id: id.to_owned(),
            transform: Transform::new(
                Vector3::new(position[0], position[1], position[2]),
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(1.0, 1.0, 1.0),
                uniform_buffer,
            ),
            vertex_buffer,
            index_buffer,
            index_count: indices.len() as u32,
            bind_group,
            group_bind_group,
            rapier_collider: terrain_collider,
            rapier_rigidbody: ground_rigid_body,
            collider_handle: None,
            rigid_body_handle: None,
            pipeline_id,
            render_role: None,
        }
    }
}
