use crate::{art_assets::Model::Model, helpers::saved_data::ScatterSettings};
use crate::heightfield_landscapes::Landscape::Landscape;

use rand::SeedableRng;
use rand::Rng;
use wgpu::util::DeviceExt;

#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct ScatteredModelConfig {
    pub player_pos: [f32; 4], // x, y, z, padding
    pub radius: f32,
    pub density: f32,
    pub seed: f32,
    pub grid_size: f32,
    
    pub landscape_size: f32,
    pub landscape_height: f32,
    pub landscape_y_offset: f32,
    pub _pad: f32,
}

pub struct ScatteredModel {
    pub model: Model, // The base model to scatter
    pub settings: ScatterSettings,
    // pub instance_buffer: Option<wgpu::Buffer>, // Replaced by procedural generation
    pub instance_count: u32,
    
    pub uniform_buffer: wgpu::Buffer,
    pub uniform_bind_group: wgpu::BindGroup,
    pub landscape_bind_group: wgpu::BindGroup,
    pub config: ScatteredModelConfig,
}

pub struct ScatteredModelPipeline {
    pub render_pipeline: wgpu::RenderPipeline,
    // pub models: Vec<ScatteredModel>, // Models are stored in RendererState
}

#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct ModelInstance {
    pub position: [f32; 3],
    pub rotation: [f32; 4], // quaternion
    pub scale: f32,
    pub variation: f32, // Random seed for shader variations
}

impl ModelInstance {
    pub fn desc<'a>() -> wgpu::VertexBufferLayout<'a> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<ModelInstance>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &[
                // Position
                wgpu::VertexAttribute {
                    offset: 0,
                    shader_location: 5,
                    format: wgpu::VertexFormat::Float32x3,
                },
                // Rotation (quaternion)
                wgpu::VertexAttribute {
                    offset: std::mem::size_of::<[f32; 3]>() as wgpu::BufferAddress,
                    shader_location: 6,
                    format: wgpu::VertexFormat::Float32x4,
                },
                // Scale
                wgpu::VertexAttribute {
                    offset: std::mem::size_of::<[f32; 7]>() as wgpu::BufferAddress,
                    shader_location: 7,
                    format: wgpu::VertexFormat::Float32,
                },
                // Variation
                wgpu::VertexAttribute {
                    offset: std::mem::size_of::<[f32; 8]>() as wgpu::BufferAddress,
                    shader_location: 8,
                    format: wgpu::VertexFormat::Float32,
                },
            ],
        }
    }
}

impl ScatteredModel {
    pub fn new(
        device: &wgpu::Device,
        model: Model,
        settings: ScatterSettings,
        landscape: &mut Landscape,
        bind_group_layout: &wgpu::BindGroupLayout, // Layout for uniform bind group
    ) -> Self {
        let grid_size = 25.0;
        let grid_cells = (settings.radius * 2.0 / grid_size).ceil() as u32;
        let instances_per_cell = (settings.density * 100.0) as u32;
        let instance_count = grid_cells * grid_cells * instances_per_cell;

        let config = ScatteredModelConfig {
            player_pos: [0.0; 4],
            radius: settings.radius,
            density: settings.density,
            seed: settings.seed as f32,
            grid_size,
            landscape_size: landscape.terrain_size,
            landscape_height: landscape.terrain_height,
            landscape_y_offset: landscape.transform.position.y,
            _pad: 0.0,
        };

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Scattered Model Config Buffer"),
            contents: bytemuck::cast_slice(&[config]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let uniform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
            label: Some("Scattered Model Uniform Bind Group"),
        });

        landscape.create_layout_for_particles(device);
        let landscape_bind_group = landscape.create_particle_bind_group(device);

        Self {
            model,
            settings,
            instance_count,
            uniform_buffer,
            uniform_bind_group,
            landscape_bind_group,
            config,
        }
    }

    pub fn update_uniforms(&mut self, queue: &wgpu::Queue, player_pos: [f32; 3]) {
        self.config.player_pos = [player_pos[0], player_pos[1], player_pos[2], 0.0];
        queue.write_buffer(&self.uniform_buffer, 0, bytemuck::cast_slice(&[self.config]));
    }
}