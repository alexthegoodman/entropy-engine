use nalgebra::{Matrix4, Point3, Vector3};
use std::f32::consts::PI;
use wgpu::util::DeviceExt;

use crate::core::Transform::{matrix4_to_raw_array, Transform};
use crate::handlers::Vertex;

pub struct Sphere {
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub bind_group: wgpu::BindGroup,
    pub transform: Transform,
    pub index_count: u32,
}

impl Sphere {
    pub fn new(
        device: &wgpu::Device,
        bind_group_layout: &wgpu::BindGroupLayout,
        radius: f32,
        sectors: u32, // longitude
        stacks: u32,  // latitude
    ) -> Self {
        let (vertices, indices) = Self::generate_sphere_data(radius, sectors, stacks);

        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Sphere Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Sphere Index Buffer"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Sphere Uniform Buffer"),
            contents: bytemuck::cast_slice(&raw_matrix),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
            label: None,
        });

        Self {
            vertex_buffer,
            index_buffer,
            bind_group,
            transform: Transform::new(
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(1.0, 1.0, 1.0),
                uniform_buffer,
            ),
            index_count: indices.len() as u32,
        }
    }

    fn generate_sphere_data(radius: f32, sectors: u32, stacks: u32) -> (Vec<Vertex>, Vec<u16>) {
        let mut vertices = Vec::new();
        let mut indices = Vec::new();

        let sector_step = 2.0 * PI / sectors as f32;
        let stack_step = PI / stacks as f32;

        for i in 0..=stacks {
            let stack_angle = PI / 2.0 - (i as f32 * stack_step);
            let xy = radius * stack_angle.cos();
            let z = radius * stack_angle.sin();

            for j in 0..=sectors {
                let sector_angle = j as f32 * sector_step;
                let x = xy * sector_angle.cos();
                let y = xy * sector_angle.sin();

                // Normalized vertex normal
                let normal = Vector3::new(x, y, z).normalize();

                // Texture coordinates
                let s = j as f32 / sectors as f32;
                let t = i as f32 / stacks as f32;

                vertices.push(Vertex {
                    position: [x, y, z],
                    normal: [normal.x, normal.y, normal.z],
                    tex_coords: [s, t],
                    color: [0.7, 0.7, 0.7], // Default to gray, can be modified as needed
                });
            }
        }

        // Generate indices
        for i in 0..stacks {
            let k1 = i * (sectors + 1);
            let k2 = k1 + sectors + 1;

            for j in 0..sectors {
                if i != 0 {
                    indices.push(k1 as u16 + j as u16);
                    indices.push(k2 as u16 + j as u16);
                    indices.push(k1 as u16 + (j + 1) as u16);
                }

                if i != (stacks - 1) {
                    indices.push(k1 as u16 + (j + 1) as u16);
                    indices.push(k2 as u16 + j as u16);
                    indices.push(k2 as u16 + (j + 1) as u16);
                }
            }
        }

        (vertices, indices)
    }
}
