use floem::common::rgb_to_wgpu;
use nalgebra::{self as na, vector, Matrix4, Vector3};
use rapier3d::{
    math::Point,
    prelude::{Collider, ColliderBuilder, ColliderHandle, ColliderSet},
};
use std::{f32::consts::PI, sync::Arc};
use uuid::Uuid;
use wgpu::{core::device, util::DeviceExt};

use crate::handlers::Vertex;

use super::{
    RendererState::{MouseState, WindowSize},
    SimpleCamera::SimpleCamera,
    Transform::{matrix4_to_raw_array, Transform},
};

pub struct TranslationGizmo {
    pub arrows: [AxisArrow; 3],
    pub bind_group: wgpu::BindGroup,
    pub texture_bind_group: wgpu::BindGroup,
    pub transform: Transform,
}

impl TranslationGizmo {
    pub fn new(
        device: &wgpu::Device,
        camera: &SimpleCamera,
        window_size: WindowSize,
        bind_group_layout: Arc<wgpu::BindGroupLayout>,
        color_render_mode_buffer: Arc<wgpu::Buffer>,
        texture_bind_group_layout: Arc<wgpu::BindGroupLayout>,
    ) -> Self {
        // Generate a basic gizmo shape (like arrows for each axis)
        let arrow_x = AxisArrow::new(device, 0);
        let arrow_y = AxisArrow::new(device, 1);
        let arrow_z = AxisArrow::new(device, 2);

        // set uniform buffer for transforms
        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Gizmo Uniform Buffer"),
            contents: bytemuck::cast_slice(&raw_matrix),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

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
            arrows: [arrow_x, arrow_y, arrow_z],
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

pub struct AxisArrow {
    pub id: Uuid,
    pub axis: u8,
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
    pub rapier_collider: Collider,
    pub collider_handle: Option<ColliderHandle>,
}

impl AxisArrow {
    pub fn new(device: &wgpu::Device, axis: u8) -> Self {
        let id = Uuid::new_v4();
        let mut vertices = Vec::new();
        let mut indices = Vec::new();
        let mut vertices_for_collision = Vec::new();
        let mut indices_for_collision: Vec<[u32; 3]> = Vec::new();

        let base_index = vertices.len() as u32;
        let length = 1.0;
        let radius = 0.02;
        let segments = 8;

        // Arrow colors
        let red = rgb_to_wgpu(239, 95, 61, 1.0);
        let green = rgb_to_wgpu(173, 240, 70, 1.0);
        let blue = rgb_to_wgpu(62, 113, 240, 1.0);

        let color = match axis {
            0 => [red[0], red[1], red[2]],       // X axis: red
            1 => [green[0], green[1], green[2]], // Y axis: green
            _ => [blue[0], blue[1], blue[2]],    // Z axis: blue
        };

        // Create shaft vertices at both ends
        for end in 0..2 {
            let z = if end == 0 { 0.0 } else { length };
            for i in 0..segments {
                let angle = (i as f32 / segments as f32) * std::f32::consts::PI * 2.0;
                let x = radius * angle.cos();
                let y = radius * angle.sin();

                // Transform position based on axis
                let position = match axis {
                    0 => na::Vector3::new(z, x, y), // X axis
                    1 => na::Vector3::new(x, z, y), // Y axis
                    _ => na::Vector3::new(x, y, z), // Z axis
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

        // Create indices for the shaft (triangles between the two circular ends)
        for i in 0..segments {
            let next = (i + 1) % segments;

            // First triangle of the quad
            indices.extend_from_slice(&[i as u32, next as u32, (i + segments) as u32]);
            indices_for_collision.push([i as u32, next as u32, (i + segments) as u32]);

            // Second triangle of the quad
            indices.extend_from_slice(&[
                next as u32,
                (next + segments) as u32,
                (i + segments) as u32,
            ]);
            indices_for_collision.push([
                next as u32,
                (next + segments) as u32,
                (i + segments) as u32,
            ]);
        }

        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Gizmo Arrow Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Gizmo Arrow Index Buffer"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        let collider = ColliderBuilder::convex_hull(&vertices_for_collision.clone())
            .expect("Couldn't create convex hull")
            .sensor(true)
            .user_data(id.as_u128())
            .build();

        AxisArrow {
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
