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

pub struct ScaleGizmo {
    pub handles: [AxisHandle; 3],
    pub bind_group: wgpu::BindGroup,
    pub texture_bind_group: wgpu::BindGroup,
    pub transform: Transform,
}

impl ScaleGizmo {
    pub fn new(
        device: &wgpu::Device,
        camera: &SimpleCamera,
        window_size: WindowSize,
        bind_group_layout: Arc<wgpu::BindGroupLayout>,
        color_render_mode_buffer: Arc<wgpu::Buffer>,
        texture_bind_group_layout: Arc<wgpu::BindGroupLayout>,
    ) -> Self {
        // Create scale handles for each axis
        let handle_x = AxisHandle::new(device, 0);
        let handle_y = AxisHandle::new(device, 1);
        let handle_z = AxisHandle::new(device, 2);

        // Set up uniform buffer for transforms
        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Scale Gizmo Uniform Buffer"),
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
            handles: [handle_x, handle_y, handle_z],
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

pub struct AxisHandle {
    pub id: Uuid,
    pub axis: u8,
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
    pub rapier_collider: Collider,
    pub collider_handle: Option<ColliderHandle>,
}

impl AxisHandle {
    pub fn new(device: &wgpu::Device, axis: u8) -> Self {
        let id = Uuid::new_v4();
        let mut vertices = Vec::new();
        let mut indices = Vec::new();
        let mut vertices_for_collision = Vec::new();
        let mut indices_for_collision: Vec<[u32; 3]> = Vec::new();

        // Handle colors (same as other gizmos)
        let color = match axis {
            0 => [1.0, 0.0, 0.0], // X axis: red
            1 => [0.0, 1.0, 0.0], // Y axis: green
            _ => [0.0, 0.0, 1.0], // Z axis: blue
        };

        // Parameters for the scale handle
        let shaft_length = 1.0;
        let shaft_width = 0.02;
        let cube_size = 0.1;
        let cube_offset = shaft_length;

        // Create shaft vertices
        let shaft_vertices = create_shaft_vertices(shaft_length, shaft_width, axis, color);
        let shaft_indices = create_shaft_indices(vertices.len() as u32);

        vertices.extend(shaft_vertices.iter().cloned());
        indices.extend(shaft_indices.iter().cloned());
        vertices_for_collision.extend(
            shaft_vertices
                .iter()
                .map(|v| Point::new(v.position[0], v.position[1], v.position[2])),
        );

        // Create cube vertices at the end
        let cube_vertices = create_cube_vertices(cube_size, cube_offset, axis, color);
        let cube_indices = create_cube_indices(vertices.len() as u32);

        vertices.extend(cube_vertices.iter().cloned());
        indices.extend(cube_indices.iter().cloned());
        vertices_for_collision.extend(
            cube_vertices
                .iter()
                .map(|v| Point::new(v.position[0], v.position[1], v.position[2])),
        );

        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Scale Handle Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Scale Handle Index Buffer"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        let collider = ColliderBuilder::convex_hull(&vertices_for_collision)
            .expect("Couldn't create convex hull")
            .sensor(true)
            .user_data(id.as_u128())
            .build();

        AxisHandle {
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

fn create_shaft_vertices(length: f32, width: f32, axis: u8, color: [f32; 3]) -> Vec<Vertex> {
    let mut vertices = Vec::new();
    let half_width = width / 2.0;

    // Create vertices for a rectangular prism along the specified axis
    let positions = match axis {
        0 => {
            // X axis
            vec![
                // Front face
                [0.0, -half_width, -half_width],
                [length, -half_width, -half_width],
                [length, half_width, -half_width],
                [0.0, half_width, -half_width],
                // Back face
                [0.0, -half_width, half_width],
                [length, -half_width, half_width],
                [length, half_width, half_width],
                [0.0, half_width, half_width],
            ]
        }
        1 => {
            // Y axis
            vec![
                [-half_width, 0.0, -half_width],
                [-half_width, length, -half_width],
                [half_width, length, -half_width],
                [half_width, 0.0, -half_width],
                [-half_width, 0.0, half_width],
                [-half_width, length, half_width],
                [half_width, length, half_width],
                [half_width, 0.0, half_width],
            ]
        }
        _ => {
            // Z axis
            vec![
                [-half_width, -half_width, 0.0],
                [-half_width, -half_width, length],
                [half_width, -half_width, length],
                [half_width, -half_width, 0.0],
                [-half_width, half_width, 0.0],
                [-half_width, half_width, length],
                [half_width, half_width, length],
                [half_width, half_width, 0.0],
            ]
        }
    };

    for pos in positions {
        vertices.push(Vertex {
            position: pos,
            normal: [0.0, 0.0, 1.0],
            tex_coords: [0.0, 0.0],
            color,
        });
    }

    vertices
}

fn create_shaft_indices(base_index: u32) -> Vec<u32> {
    vec![
        // Front face
        base_index + 0,
        base_index + 1,
        base_index + 2,
        base_index + 2,
        base_index + 3,
        base_index + 0,
        // Back face
        base_index + 5,
        base_index + 4,
        base_index + 7,
        base_index + 7,
        base_index + 6,
        base_index + 5,
        // Right face
        base_index + 1,
        base_index + 5,
        base_index + 6,
        base_index + 6,
        base_index + 2,
        base_index + 1,
        // Left face
        base_index + 4,
        base_index + 0,
        base_index + 3,
        base_index + 3,
        base_index + 7,
        base_index + 4,
        // Top face
        base_index + 3,
        base_index + 2,
        base_index + 6,
        base_index + 6,
        base_index + 7,
        base_index + 3,
        // Bottom face
        base_index + 4,
        base_index + 5,
        base_index + 1,
        base_index + 1,
        base_index + 0,
        base_index + 4,
    ]
}

fn create_cube_vertices(size: f32, offset: f32, axis: u8, color: [f32; 3]) -> Vec<Vertex> {
    let mut vertices = Vec::new();
    let half_size = size / 2.0;

    let positions = match axis {
        0 => {
            // X axis
            vec![
                [offset - half_size, -half_size, -half_size],
                [offset + half_size, -half_size, -half_size],
                [offset + half_size, half_size, -half_size],
                [offset - half_size, half_size, -half_size],
                [offset - half_size, -half_size, half_size],
                [offset + half_size, -half_size, half_size],
                [offset + half_size, half_size, half_size],
                [offset - half_size, half_size, half_size],
            ]
        }
        1 => {
            // Y axis
            vec![
                [-half_size, offset - half_size, -half_size],
                [-half_size, offset + half_size, -half_size],
                [half_size, offset + half_size, -half_size],
                [half_size, offset - half_size, -half_size],
                [-half_size, offset - half_size, half_size],
                [-half_size, offset + half_size, half_size],
                [half_size, offset + half_size, half_size],
                [half_size, offset - half_size, half_size],
            ]
        }
        _ => {
            // Z axis
            vec![
                [-half_size, -half_size, offset - half_size],
                [-half_size, -half_size, offset + half_size],
                [half_size, -half_size, offset + half_size],
                [half_size, -half_size, offset - half_size],
                [-half_size, half_size, offset - half_size],
                [-half_size, half_size, offset + half_size],
                [half_size, half_size, offset + half_size],
                [half_size, half_size, offset - half_size],
            ]
        }
    };

    for pos in positions {
        vertices.push(Vertex {
            position: pos,
            normal: [0.0, 0.0, 1.0],
            tex_coords: [0.0, 0.0],
            color,
        });
    }

    vertices
}

fn create_cube_indices(base_index: u32) -> Vec<u32> {
    // Same indices pattern as shaft, just with the new base index
    create_shaft_indices(base_index)
}
