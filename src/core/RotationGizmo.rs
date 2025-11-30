use nalgebra::{self as na, Matrix4, Vector3};
use rapier3d::{
    math::Point,
    prelude::{Collider, ColliderBuilder, ColliderHandle, ColliderSet},
};
use std::{f32::consts::PI, sync::Arc};
use uuid::Uuid;
use wgpu::util::DeviceExt;

use crate::handlers::Vertex;

use super::{
    RendererState::{MouseState, WindowSize},
    SimpleCamera::SimpleCamera,
    Transform::{matrix4_to_raw_array, Transform},
};

pub struct RotationGizmo {
    pub rings: [AxisRing; 3],
    pub bind_group: wgpu::BindGroup,
    pub texture_bind_group: wgpu::BindGroup,
    pub transform: Transform,
}

impl RotationGizmo {
    pub fn new(
        device: &wgpu::Device,
        camera: &SimpleCamera,
        window_size: WindowSize,
        bind_group_layout: Arc<wgpu::BindGroupLayout>,
        color_render_mode_buffer: Arc<wgpu::Buffer>,
        texture_bind_group_layout: Arc<wgpu::BindGroupLayout>,
    ) -> Self {
        // Create rotation rings for each axis
        let ring_x = AxisRing::new(device, 0);
        let ring_y = AxisRing::new(device, 1);
        let ring_z = AxisRing::new(device, 2);

        // Set up uniform buffer for transforms
        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Rotation Gizmo Uniform Buffer"),
            contents: bytemuck::cast_slice(&raw_matrix),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        // Create default texture and sampler (similar to TranslationGizmo)
        let default_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Default Empty Texture"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        let default_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        let default_texture_view = default_texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });

        // Create bind groups
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
            label: None,
        });

        let texture_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &texture_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&default_texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&default_sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &color_render_mode_buffer,
                        offset: 0,
                        size: None,
                    }),
                },
            ],
            label: None,
        });

        Self {
            rings: [ring_x, ring_y, ring_z],
            bind_group,
            texture_bind_group,
            transform: Transform::new(
                Vector3::new(2.0, 2.0, 2.0),
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(1.0, 1.0, 1.0),
                uniform_buffer,
            ),
        }
    }
}

pub struct AxisRing {
    pub id: Uuid,
    pub axis: u8,
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
    pub rapier_collider: Collider,
    pub collider_handle: Option<ColliderHandle>,
}

impl AxisRing {
    pub fn new(device: &wgpu::Device, axis: u8) -> Self {
        let id = Uuid::new_v4();
        let mut vertices = Vec::new();
        let mut indices = Vec::new();
        let mut vertices_for_collision = Vec::new();
        let mut indices_for_collision: Vec<[u32; 3]> = Vec::new();

        let radius = 1.0;
        let thickness = 0.02;
        let segments = 64; // More segments for smoother circle

        // Ring colors (same as translation gizmo)
        let color = match axis {
            0 => [1.0, 0.0, 0.0], // X axis: red
            1 => [0.0, 1.0, 0.0], // Y axis: green
            _ => [0.0, 0.0, 1.0], // Z axis: blue
        };

        // Create vertices for the ring
        for i in 0..segments {
            let angle = (i as f32 / segments as f32) * PI * 2.0;
            let next_angle = ((i + 1) as f32 / segments as f32) * PI * 2.0;

            // Inner and outer vertices for current and next position
            for &r in &[radius - thickness, radius + thickness] {
                for &a in &[angle, next_angle] {
                    let (x, y) = (r * a.cos(), r * a.sin());

                    // Transform position based on axis
                    let position = match axis {
                        0 => na::Vector3::new(0.0, x, y), // YZ plane (X axis rotation)
                        1 => na::Vector3::new(x, 0.0, y), // XZ plane (Y axis rotation)
                        _ => na::Vector3::new(x, y, 0.0), // XY plane (Z axis rotation)
                    };

                    vertices.push(Vertex {
                        position: [position.x, position.y, position.z],
                        normal: [0.0, 0.0, 1.0],
                        tex_coords: [0.0, 0.0],
                        color,
                    });

                    vertices_for_collision.push(Point::new(position.x, position.y, position.z));
                }
            }

            // Create indices for the current segment
            let base = (i * 4) as u32;
            indices.extend_from_slice(&[base, base + 1, base + 2, base + 1, base + 3, base + 2]);

            indices_for_collision.push([base, base + 1, base + 2]);
            indices_for_collision.push([base + 1, base + 3, base + 2]);
        }

        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Rotation Ring Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Rotation Ring Index Buffer"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        let collider = ColliderBuilder::convex_hull(&vertices_for_collision)
            .expect("Couldn't create convex hull")
            .sensor(true)
            .user_data(id.as_u128())
            .build();

        AxisRing {
            id,
            axis,
            vertex_buffer,
            index_buffer,
            index_count: indices.len() as u32,
            rapier_collider: collider,
            collider_handle: None,
        }
    }
}
