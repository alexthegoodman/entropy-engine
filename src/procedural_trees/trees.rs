use wgpu::util::DeviceExt;
use crate::core::{SimpleCamera::SimpleCamera, vertex::Vertex, RendererState::RendererState};
use crate::heightfield_landscapes::Landscape::Landscape;
use nalgebra::{Matrix4, Vector3, Point3};
use rand::Rng;

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct TreeUniforms {
    time: f32,
    _padding: [f32; 3],
}

pub struct TreeArchetype {
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
}

impl TreeArchetype {
    pub fn new(device: &wgpu::Device) -> Self {
        // A simple tree made of a cylinder trunk and a cone for leaves
        let mut vertices = vec![];
        let mut indices: Vec<u32> = vec![];

        // Trunk (cylinder)
        let trunk_height = 2.0;
        let trunk_radius = 0.2;
        let trunk_segments = 8;
        let trunk_color = [0.4, 0.2, 0.0, 1.0]; // Brown

        // Leaves (cone)
        let leaves_height = 4.0;
        let leaves_radius = 1.5;
        let leaves_segments = 12;
        let leaves_color = [0.0, 0.5, 0.0, 1.0]; // Dark green

        // --- Create Trunk ---
        let trunk_base_start_index = vertices.len() as u32;
        // Bottom circle
        for i in 0..trunk_segments {
            let angle = (i as f32 / trunk_segments as f32) * 2.0 * std::f32::consts::PI;
            vertices.push(Vertex {
                position: [trunk_radius * angle.cos(), 0.0, trunk_radius * angle.sin()],
                tex_coords: [0.0, 0.0],
                normal: [angle.cos(), 0.0, angle.sin()],
                color: trunk_color,
            });
        }
        // Top circle
        let trunk_top_start_index = vertices.len() as u32;
        for i in 0..trunk_segments {
            let angle = (i as f32 / trunk_segments as f32) * 2.0 * std::f32::consts::PI;
            vertices.push(Vertex {
                position: [trunk_radius * angle.cos(), trunk_height, trunk_radius * angle.sin()],
                tex_coords: [0.0, 0.0],
                normal: [angle.cos(), 0.0, angle.sin()],
                color: trunk_color,
            });
        }
        // Trunk side indices
        for i in 0..trunk_segments {
            let i_u32 = i as u32;
            let next_i_u32 = (i_u32 + 1) % trunk_segments as u32;
            indices.extend_from_slice(&[
                trunk_base_start_index + i_u32, trunk_top_start_index + i_u32, trunk_base_start_index + next_i_u32,
                trunk_top_start_index + i_u32, trunk_top_start_index + next_i_u32, trunk_base_start_index + next_i_u32,
            ]);
        }

        // --- Create Leaves ---
        let leaves_base_start_index = vertices.len() as u32;
        // Base circle
        for i in 0..leaves_segments {
            let angle = (i as f32 / leaves_segments as f32) * 2.0 * std::f32::consts::PI;
            vertices.push(Vertex {
                position: [leaves_radius * angle.cos(), trunk_height, leaves_radius * angle.sin()],
                tex_coords: [0.0, 0.0],
                normal: [angle.cos(), 0.0, angle.sin()],
                color: leaves_color,
            });
        }
        // Cone tip
        let cone_tip_index = vertices.len() as u32;
        vertices.push(Vertex {
            position: [0.0, trunk_height + leaves_height, 0.0],
            tex_coords: [0.5, 1.0],
            normal: [0.0, 1.0, 0.0],
            color: leaves_color,
        });
        // Leaves indices
        for i in 0..leaves_segments {
            indices.extend_from_slice(&[
                cone_tip_index,
                leaves_base_start_index + i as u32,
                leaves_base_start_index + ((i + 1) % leaves_segments) as u32,
            ]);
        }
        
        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Tree Archetype Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Tree Archetype Index Buffer"),
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


#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct TreeInstance {
    pub position: [f32; 3],
    pub scale: f32,
    pub rotation: [f32; 3],
}

pub struct ProceduralTrees {
    pub archetypes: Vec<TreeArchetype>,
    pub instances: Vec<TreeInstance>,
    pub instance_buffer: wgpu::Buffer,
    pub render_pipeline: wgpu::RenderPipeline,
    pub uniform_buffer: wgpu::Buffer,
    pub uniform_bind_group: wgpu::BindGroup,
}

impl ProceduralTrees {
    pub fn new(
        device: &wgpu::Device,
        camera_bind_group_layout: &wgpu::BindGroupLayout,
        landscape: &mut Landscape,
    ) -> Self {
        let archetypes = vec![TreeArchetype::new(device)];
        
        let instances = vec![]; 

        let instance_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Tree Instance Buffer"),
            size: (1000 * std::mem::size_of::<TreeInstance>()) as wgpu::BufferAddress, // pre-allocate for 1000 trees
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let uniform_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Tree Uniform Buffer"),
            size: std::mem::size_of::<TreeUniforms>() as wgpu::BufferAddress,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let uniform_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
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
            label: Some("tree_uniform_bind_group_layout"),
        });

        let uniform_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &uniform_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
            label: Some("tree_uniform_bind_group"),
        });

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Tree Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("trees.wgsl").into()),
        });

        let render_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Tree Render Pipeline Layout"),
            bind_group_layouts: &[
                camera_bind_group_layout,
                &uniform_bind_group_layout,
            ],
            push_constant_ranges: &[],
        });

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Tree Render Pipeline"),
            layout: Some(&render_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[Vertex::desc(), TreeInstance::desc()],
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
                        format: wgpu::TextureFormat::Rgba8Unorm,
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
                cull_mode: Some(wgpu::Face::Back),
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
        });

        Self {
            archetypes,
            instances,
            instance_buffer,
            render_pipeline,
            uniform_buffer,
            uniform_bind_group,
        }
    }

    pub fn update_uniforms(&self, queue: &wgpu::Queue, time: f32) {
        let uniforms = TreeUniforms {
            time,
            _padding: [0.0; 3],
        };
        queue.write_buffer(&self.uniform_buffer, 0, bytemuck::cast_slice(&[uniforms]));
    }
}

impl TreeInstance {
    fn desc<'a>() -> wgpu::VertexBufferLayout<'a> {
        use std::mem;
        wgpu::VertexBufferLayout {
            array_stride: mem::size_of::<TreeInstance>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &[
                wgpu::VertexAttribute {
                    offset: 0,
                    shader_location: 5,
                    format: wgpu::VertexFormat::Float32x3,
                },
                wgpu::VertexAttribute {
                    offset: mem::size_of::<[f32; 3]>() as wgpu::BufferAddress,
                    shader_location: 6,
                    format: wgpu::VertexFormat::Float32,
                },
                wgpu::VertexAttribute {
                    offset: mem::size_of::<[f32; 4]>() as wgpu::BufferAddress,
                    shader_location: 7,
                    format: wgpu::VertexFormat::Float32x3,
                },
            ],
        }
    }
}

pub trait DrawTrees<'a> {
    fn draw_trees(
        &mut self,
        trees: &'a ProceduralTrees,
        camera_bind_group: &'a wgpu::BindGroup,
    );
}

impl<'a, 'b> DrawTrees<'a> for wgpu::RenderPass<'b>
where
    'a: 'b,
{
    fn draw_trees(
        &mut self,
        trees: &'a ProceduralTrees,
        camera_bind_group: &'a wgpu::BindGroup,
    ) {
        if trees.instances.is_empty() {
            return;
        }

        self.set_pipeline(&trees.render_pipeline);
        self.set_bind_group(0, camera_bind_group, &[]);
        self.set_bind_group(1, &trees.uniform_bind_group, &[]);
        self.set_vertex_buffer(1, trees.instance_buffer.slice(..));

        for archetype in &trees.archetypes {
            self.set_vertex_buffer(0, archetype.vertex_buffer.slice(..));
            self.set_index_buffer(archetype.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            self.draw_indexed(0..archetype.index_count, 0, 0..trees.instances.len() as u32);
        }
    }
}

