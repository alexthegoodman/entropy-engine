use crate::{art_assets::Model::Model, helpers::saved_data::ScatterSettings};

use rand::SeedableRng;
use rand::Rng;
use wgpu::util::DeviceExt;

pub struct ScatteredModel {
    pub model: Model, // The base model to scatter
    pub settings: ScatterSettings,
    pub instance_buffer: wgpu::Buffer,
    pub instance_count: u32,
}

pub struct ScatteredModelPipeline {
    pub pipeline: wgpu::RenderPipeline,
    pub models: Vec<ScatteredModel>,
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
    pub fn generate_instances(
        &mut self,
        device: &wgpu::Device,
        settings: &ScatterSettings,
        player_pos: [f32; 3],
        landscape_sampler: &dyn Fn(f32, f32) -> f32, // Height sampling function
    ) {
        let mut instances = Vec::new();
        
        // Calculate grid based on radius
        let grid_size = 10.0; // Size of each grid cell
        let grid_cells = (settings.radius * 2.0 / grid_size).ceil() as u32;
        
        // Use density to determine instances per cell
        let instances_per_cell = (settings.density * grid_size * grid_size) as u32;
        
        let mut rng = rand::rngs::StdRng::seed_from_u64(settings.seed as u64);
        
        for cell_x in 0..grid_cells {
            for cell_z in 0..grid_cells {
                // Calculate cell world position relative to player
                let world_cell_x = player_pos[0] - settings.radius + (cell_x as f32 * grid_size);
                let world_cell_z = player_pos[2] - settings.radius + (cell_z as f32 * grid_size);
                
                for _ in 0..instances_per_cell {
                    // Random position within cell
                    let offset_x = rng.r#gen::<f32>() * grid_size;
                    let offset_z = rng.r#gen::<f32>() * grid_size;
                    
                    let world_x = world_cell_x + offset_x;
                    let world_z = world_cell_z + offset_z;
                    
                    // Sample landscape height
                    let world_y = landscape_sampler(world_x, world_z);
                    
                    // Distance culling
                    let dx = world_x - player_pos[0];
                    let dz = world_z - player_pos[2];
                    let dist = (dx * dx + dz * dz).sqrt();
                    
                    if dist > settings.radius {
                        continue;
                    }
                    
                    // Random rotation around Y axis
                    let rotation_y = rng.r#gen::<f32>() * std::f32::consts::TAU;
                    let rotation = [0.0, rotation_y.sin(), 0.0, rotation_y.cos()]; // Quaternion
                    
                    // Random scale variation (0.8 to 1.2)
                    let scale = 0.8 + rng.r#gen::<f32>() * 0.4;
                    
                    instances.push(ModelInstance {
                        position: [world_x, world_y, world_z],
                        rotation,
                        scale,
                        variation: rng.r#gen::<f32>(),
                    });
                }
            }
        }
        
        self.instance_count = instances.len() as u32;
        
        // Create instance buffer
        self.instance_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Scattered Model Instance Buffer"),
            contents: bytemuck::cast_slice(&instances),
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        });
    }
}