use wgpu::util::DeviceExt;
use crate::core::{SimpleCamera::SimpleCamera, vertex::Vertex};
use crate::heightfield_landscapes::Landscape::Landscape;
use nalgebra::{Matrix4, Vector3, Point3};
use std::sync::Arc;

#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GrassConfig {
    pub time: f32,
    pub grid_size: f32,
    pub render_distance: f32,
    pub wind_strength: f32,
    
    pub player_pos: [f32; 4], // x, y, z, and unused w (16-byte aligned)
    
    pub wind_speed: f32,
    pub blade_height: f32,
    pub blade_width: f32,
    pub brownian_strength: f32,
    pub blade_density: f32,

    pub landscape_size: f32,
    pub landscape_height: f32,
    pub landscape_y_offset: f32,

    pub base_color: [f32; 4],
    pub tip_color: [f32; 4],

    pub _pad0: [f32; 2],
}

impl Default for GrassConfig {
    fn default() -> Self {
        Self {
            time: 0.0,
            grid_size: 2.0,
            render_distance: 150.0,
            wind_strength: 2.5,
            player_pos: [0.0; 4],
            wind_speed: 0.3,
            blade_height: 2.75,
            blade_width: 0.03,
            brownian_strength: 0.03,
            blade_density: 15.0,
            landscape_size: 1000.0,
            landscape_height: 100.0,
            landscape_y_offset: 0.0,
            base_color: [0.1, 0.4, 0.1, 1.0], // Dark green
            tip_color: [0.4, 0.8, 0.2, 1.0],  // Light green
            _pad0: [0.0; 2],
        }
    }
}

// Instead of per-blade instances, we'll use a simple grid vertex buffer
// The shader will generate blade positions procedurally
pub struct GrassBlade {
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
}

impl GrassBlade {
    pub fn new(device: &wgpu::Device) -> Self {
        // A single blade mesh with more segments for better bending
        let segments = 5;
        let mut vertices = Vec::new();
        let mut indices = Vec::new();
        
        for i in 0..=segments {
            let y = (i as f32) / (segments as f32);
            let left_x = -0.5;
            let right_x = 0.5;
            
            vertices.push(Vertex {
                position: [left_x, y, 0.0],
                tex_coords: [0.0, 1.0 - y],
                normal: [0.0, 0.0, 1.0],
                color: [1.0, 1.0, 1.0, 1.0],
            });
            
            vertices.push(Vertex {
                position: [right_x, y, 0.0],
                tex_coords: [1.0, 1.0 - y],
                normal: [0.0, 0.0, 1.0],
                color: [1.0, 1.0, 1.0, 1.0],
            });
        }
        
        for i in 0..segments {
            let base = (i * 2) as u16;
            indices.extend_from_slice(&[
                base, base + 1, base + 2,
                base + 1, base + 3, base + 2,
            ]);
        }

        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Grass Blade Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Grass Blade Index Buffer"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        Self {
            vertex_buffer,
            index_buffer,
            index_count: indices.len() as u32,
        }
    }
}

pub struct Grass {
    pub id: Option<String>,
    pub addon_name: Option<String>,
    pub blade: GrassBlade,
    pub render_pipeline: Arc<wgpu::RenderPipeline>,
    pub uniform_buffer: wgpu::Buffer,
    pub uniform_bind_group: wgpu::BindGroup,
    pub landscape_bind_group: wgpu::BindGroup,
    pub bind_groups: Vec<wgpu::BindGroup>,
    pub uniform_buffers: Vec<wgpu::Buffer>,
    pub samplers: Vec<wgpu::Sampler>,
    pub config: GrassConfig,
}

impl Grass {
    pub fn new(
        device: &wgpu::Device,
        camera_bind_group_layout: &wgpu::BindGroupLayout,
        landscape: &mut Landscape,
        custom_pipeline: Option<Arc<wgpu::RenderPipeline>>,
    ) -> Self {
        let blade = GrassBlade::new(device);
        
        let mut config = GrassConfig::default();
        config.landscape_height = landscape.terrain_height;
        config.landscape_size = landscape.terrain_size;
        config.landscape_y_offset = landscape.transform.position.y;

        // -- Uniforms --
        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Grass Uniform Buffer"),
            size: std::mem::size_of::<GrassConfig>() as wgpu::BufferAddress,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let uniform_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
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
            label: Some("grass_uniform_bind_group_layout"),
        });

        let uniform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &uniform_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
            label: Some("grass_uniform_bind_group"),
        });

        // Create landscape bind group for height sampling
        landscape.create_layout_for_particles(device);
        let landscape_bind_group = landscape.create_particle_bind_group(device);

        let render_pipeline = if let Some(pipeline) = custom_pipeline {
            pipeline
        } else {
            // Shaders
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Grass Shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("grass.wgsl").into()),
            });

            // Render Pipeline
            let render_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Grass Render Pipeline Layout"),
                bind_group_layouts: &[
                    camera_bind_group_layout,
                    &uniform_bind_group_layout,
                    &landscape.particle_bind_group_layout.as_ref().expect("Couldn't get landscape layout"),
                ],
                push_constant_ranges: &[],
            });

            Arc::new(device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Grass Render Pipeline"),
                layout: Some(&render_pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    buffers: &[Vertex::desc()],
                    compilation_options: Default::default(),
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
                            blend: None,
                            write_mask: wgpu::ColorWrites::ALL,
                        }),
                        Some(wgpu::ColorTargetState {
                            format: wgpu::TextureFormat::Rgba8Unorm, // New target for PBR material
                            blend: None,
                            write_mask: wgpu::ColorWrites::ALL,
                        }),
                    ],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    strip_index_format: None,
                    front_face: wgpu::FrontFace::Ccw,
                    cull_mode: None,
                    ..Default::default()
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Depth24Plus,
                    depth_write_enabled: true,
                    depth_compare: wgpu::CompareFunction::Less,
                    stencil: wgpu::StencilState::default(),
                    bias: wgpu::DepthBiasState::default(),
                }),
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            }))
        };

        Self {
            id: None,
            addon_name: None,
            blade,
            render_pipeline,
            uniform_buffer,
            uniform_bind_group,
            landscape_bind_group,
            bind_groups: Vec::new(),
            uniform_buffers: Vec::new(),
            samplers: Vec::new(),
            config,
        }
    }

    pub fn new_without_landscape(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        camera_bind_group_layout: &wgpu::BindGroupLayout,
        custom_pipeline: Option<Arc<wgpu::RenderPipeline>>,
    ) -> Self {
        let blade = GrassBlade::new(device);
        
        let mut config = GrassConfig::default();
        config.landscape_height = 0.0;
        config.landscape_size = 4096.0;
        config.landscape_y_offset = 0.0;

        // -- Uniforms --
        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Grass Uniform Buffer"),
            size: std::mem::size_of::<GrassConfig>() as wgpu::BufferAddress,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let uniform_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
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
            label: Some("grass_uniform_bind_group_layout"),
        });

        let uniform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &uniform_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
            label: Some("grass_uniform_bind_group"),
        });

        // Create dummy landscape bind group layout
        let landscape_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
            label: Some("Dummy Landscape Particle Bind Group Layout"),
        });

        let dummy_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Dummy Landscape Texture"),
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &dummy_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &[255, 255, 255, 255],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: None,
            },
            wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        );
        let dummy_view = dummy_texture.create_view(&wgpu::TextureViewDescriptor::default());
        let dummy_sampler = device.create_sampler(&wgpu::SamplerDescriptor::default());

        let landscape_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &landscape_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&dummy_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&dummy_sampler),
                },
            ],
            label: Some("Dummy Landscape Particle Bind Group"),
        });

        let render_pipeline = if let Some(pipeline) = custom_pipeline {
            pipeline
        } else {
            // Shaders
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Grass Shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("grass.wgsl").into()),
            });

            // Render Pipeline
            let render_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Grass Render Pipeline Layout"),
                bind_group_layouts: &[
                    camera_bind_group_layout,
                    &uniform_bind_group_layout,
                    &landscape_bind_group_layout,
                ],
                push_constant_ranges: &[],
            });

            Arc::new(device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Grass Render Pipeline"),
                layout: Some(&render_pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs_main"),
                    buffers: &[Vertex::desc()],
                    compilation_options: Default::default(),
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
                            blend: None,
                            write_mask: wgpu::ColorWrites::ALL,
                        }),
                        Some(wgpu::ColorTargetState {
                            format: wgpu::TextureFormat::Rgba8Unorm, // New target for PBR material
                            blend: None,
                            write_mask: wgpu::ColorWrites::ALL,
                        }),
                    ],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    strip_index_format: None,
                    front_face: wgpu::FrontFace::Ccw,
                    cull_mode: None,
                    ..Default::default()
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Depth24Plus,
                    depth_write_enabled: true,
                    depth_compare: wgpu::CompareFunction::Less,
                    stencil: wgpu::StencilState::default(),
                    bias: wgpu::DepthBiasState::default(),
                }),
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            }))
        };

        Self {
            id: None,
            addon_name: None,
            blade,
            render_pipeline,
            uniform_buffer,
            uniform_bind_group,
            landscape_bind_group,
            bind_groups: Vec::new(),
            uniform_buffers: Vec::new(),
            samplers: Vec::new(),
            config,
        }
    }

    pub fn update_uniforms(&mut self, queue: &wgpu::Queue, time: f32, player_pos: Point3<f32>) {
        self.config.time = time;
        self.config.player_pos = [player_pos.x, player_pos.y, player_pos.z, 0.0];
        queue.write_buffer(&self.uniform_buffer, 0, bytemuck::cast_slice(&[self.config]));
    }

    pub fn update_config(&mut self, queue: &wgpu::Queue, config: GrassConfig) {
        self.config = config;
        queue.write_buffer(&self.uniform_buffer, 0, bytemuck::cast_slice(&[self.config]));
    }
}
