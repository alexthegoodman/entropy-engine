use nalgebra::{Matrix4, Vector3};
use wgpu::util::DeviceExt;
use crate::core::Transform_2::{Transform, matrix4_to_raw_array};
use std::sync::Arc;
use wgpu;

pub struct CustomMesh {
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub num_indices: u32,
    pub instance_count: u32,
    pub pipeline: Arc<wgpu::RenderPipeline>,
    pub pipeline_id: String,
    pub bind_groups: Vec<wgpu::BindGroup>,
    pub transform: Transform,
    pub id: String,
    pub uniform_buffers: Vec<wgpu::Buffer>, // Store created uniform buffers to keep them alive
    pub samplers: Vec<wgpu::Sampler>, // Add this
    pub time_buffer: Option<wgpu::Buffer>,
}

impl CustomMesh {
    pub fn new(
        device: &wgpu::Device,
        vertex_data: &[u8],
        index_data: &[u8],
        pipeline: Arc<wgpu::RenderPipeline>,
        pipeline_id: String,
        bind_groups: Vec<wgpu::BindGroup>,
        position: [f32; 3],
        id: String,
        uniform_buffers: Vec<wgpu::Buffer>,
        samplers: Vec<wgpu::Sampler>,
        instance_count: u32,
        time_buffer: Option<wgpu::Buffer>,
    ) -> Self {
        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(&format!("Custom Mesh Vertex Buffer {}", id)),
            contents: vertex_data,
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(&format!("Custom Mesh Index Buffer {}", id)),
            contents: index_data,
            usage: wgpu::BufferUsages::INDEX,
        });

        let num_indices = (index_data.len() / 4) as u32; // Assuming u32 indices

        // set uniform buffer for transforms
        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Landscape Uniform Buffer"),
            contents: bytemuck::cast_slice(&raw_matrix),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let mut transform = Transform::new(
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(1.0, 1.0, 1.0),
            uniform_buffer,
        );
        transform.update_position(position);

        Self {
            vertex_buffer,
            index_buffer,
            num_indices,
            instance_count,
            pipeline,
            pipeline_id,
            bind_groups,
            transform,
            id,
            uniform_buffers,
            samplers,
            time_buffer,
        }
    }
}
