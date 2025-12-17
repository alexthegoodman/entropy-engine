use wgpu::{util::DeviceExt, PipelineCompilationOptions};

use crate::{heightfield_landscapes::Landscape::Landscape, water_plane::config::WaterConfig};

pub struct WaterPlane {
    pub pipeline: wgpu::RenderPipeline,
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub num_indices: u32,
    pub time_buffer: wgpu::Buffer,
    pub time_bind_group: wgpu::BindGroup,
    pub player_pos_buffer: wgpu::Buffer,
    pub player_pos_bind_group: wgpu::BindGroup,
    pub landscape_bind_group: wgpu::BindGroup,
    pub config: WaterConfig,
    pub config_buffer: wgpu::Buffer,
    pub config_bind_group: wgpu::BindGroup,
    pub config_bind_group_layout: wgpu::BindGroupLayout,
}

impl WaterPlane {
    pub fn new(
        device: &wgpu::Device,
        camera_bind_group_layout: &wgpu::BindGroupLayout,
        texture_format: wgpu::TextureFormat,
        landscape: &mut Landscape,
        config: WaterConfig,
    ) -> Self {
        landscape.create_layout_for_particles(device);
        let landscape_bind_group = landscape.create_particle_bind_group(device);

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Water Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("water.wgsl").into()),
        });

        let time_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Time Buffer"),
            size: std::mem::size_of::<f32>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let time_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
                label: Some("time_bind_group_layout"),
            });

        let time_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &time_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: time_buffer.as_entire_binding(),
            }],
            label: Some("time_bind_group"),
        });

        let config_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Water Config Buffer"),
            contents: bytemuck::cast_slice(&[config]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let config_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
                label: Some("water_config_bind_group_layout"),
            });

        let config_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &config_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: config_buffer.as_entire_binding(),
            }],
            label: Some("water_config_bind_group"),
        });

        // Generate dense water mesh
        let size = 4096.0;
        let half_size = size / 2.0;
        let y = -300.0;

        // Adjust these for performance vs quality tradeoff
        // let grid_resolution = 256; // 256x256 = 65,536 vertices (good quality)
        // For even better quality: 384 (147k verts) or 512 (262k verts)
        // For performance: 128 (16k verts) or 192 (37k verts)
        let grid_resolution = 128;

        let (vertices, indices) = Self::generate_grid_mesh(size, half_size, y, grid_resolution);

        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Water Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Water Index Buffer"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        let num_indices = indices.len() as u32;

        let player_pos_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Player Pos Buffer"),
            size: std::mem::size_of::<[f32; 4]>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let player_pos_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
                label: Some("player_pos_bind_group_layout"),
            });

        let player_pos_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &player_pos_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: player_pos_buffer.as_entire_binding(),
            }],
            label: Some("player_pos_bind_group"),
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Water Pipeline Layout"),
            bind_group_layouts: &[
                camera_bind_group_layout,
                &time_bind_group_layout,
                &landscape
                    .particle_bind_group_layout
                    .as_ref()
                    .expect("Couldn't get landscape layout"), // Add landscape bind group
                &player_pos_bind_group_layout,
                &config_bind_group_layout,
            ],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Water Pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<[f32; 3]>() as wgpu::BufferAddress,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x3],
                }],
                compilation_options: PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba16Float,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba16Float,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm, // New target for PBR material
                        blend: None, // Water PBR material is likely opaque
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                ],
                compilation_options: PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth24Plus,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::Less,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState {
                count: 1,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
            multiview: None,
            cache: None,
        });

        Self {
            pipeline,
            vertex_buffer,
            index_buffer,
            num_indices,
            time_buffer,
            time_bind_group,
            player_pos_buffer,
            player_pos_bind_group,
            landscape_bind_group,
            config,
            config_buffer,
            config_bind_group,
            config_bind_group_layout,
        }
    }

    pub fn update_config(&mut self, queue: &wgpu::Queue, config: WaterConfig) {
        self.config = config;
        queue.write_buffer(&self.config_buffer, 0, bytemuck::cast_slice(&[self.config]));
    }

    /// Generate a dense grid mesh for the water plane
    /// Returns (vertices, indices)
    fn generate_grid_mesh(
        size: f32,
        half_size: f32,
        y: f32,
        resolution: usize,
    ) -> (Vec<f32>, Vec<u32>) {
        let mut vertices = Vec::new();
        let mut indices = Vec::new();

        // Generate vertices
        for row in 0..=resolution {
            for col in 0..=resolution {
                let x = -half_size + (col as f32 / resolution as f32) * size;
                let z = -half_size + (row as f32 / resolution as f32) * size;

                vertices.push(x);
                vertices.push(y);
                vertices.push(z);
            }
        }

        // Generate indices (two triangles per grid cell)
        for row in 0..resolution {
            for col in 0..resolution {
                let top_left = (row * (resolution + 1) + col) as u32;
                let top_right = top_left + 1;
                let bottom_left = ((row + 1) * (resolution + 1) + col) as u32;
                let bottom_right = bottom_left + 1;

                // First triangle
                indices.push(top_left);
                indices.push(bottom_left);
                indices.push(top_right);

                // Second triangle
                indices.push(top_right);
                indices.push(bottom_left);
                indices.push(bottom_right);
            }
        }

        (vertices, indices)
    }
}

pub trait DrawWater<'a> {
    fn draw_water(
        &mut self,
        water_plane: &'a WaterPlane,
        camera_bind_group: &'a wgpu::BindGroup,
        time_bind_group: &'a wgpu::BindGroup,
        landscape_bind_group: &'a wgpu::BindGroup,
        player_pos_bind_group: &'a wgpu::BindGroup,
        config_bind_group: &'a wgpu::BindGroup,
    );
}

impl<'a, 'b> DrawWater<'a> for wgpu::RenderPass<'b>
where
    'a: 'b,
{
    fn draw_water(
        &mut self,
        water_plane: &'a WaterPlane,
        camera_bind_group: &'a wgpu::BindGroup,
        time_bind_group: &'a wgpu::BindGroup,
        landscape_bind_group: &'a wgpu::BindGroup,
        player_pos_bind_group: &'a wgpu::BindGroup,
        config_bind_group: &'a wgpu::BindGroup,
    ) {
        self.set_pipeline(&water_plane.pipeline);
        self.set_bind_group(0, camera_bind_group, &[]);
        self.set_bind_group(1, time_bind_group, &[]);
        self.set_bind_group(2, landscape_bind_group, &[]);
        self.set_bind_group(3, player_pos_bind_group, &[]);
        self.set_bind_group(4, config_bind_group, &[]);
        self.set_vertex_buffer(0, water_plane.vertex_buffer.slice(..));
        self.set_index_buffer(water_plane.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
        self.draw_indexed(0..water_plane.num_indices, 0, 0..1);
    }
}