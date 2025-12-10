use wgpu::util::DeviceExt;
use crate::core::{SimpleCamera::SimpleCamera, vertex::Vertex, RendererState::RendererState};
use crate::heightfield_landscapes::Landscape::Landscape;
use nalgebra::{Matrix4, Vector3, Point3};
use rand::{Rng, random};

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct TreeUniforms {
    time: f32,
    _padding: [f32; 3],
}

// Branch node for recursive tree generation
#[derive(Debug, Clone)]
struct BranchNode {
    start_pos: [f32; 3],
    end_pos: [f32; 3],
    radius: f32,
    generation: u32,
}

pub struct TreeArchetype {
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
}

impl TreeArchetype {
    pub fn new(device: &wgpu::Device) -> Self {
        let mut vertices = vec![];
        let mut indices: Vec<u32> = vec![];
        
        let mut rng = rand::thread_rng();
        
        // Generate tree using recursive branching
        let trunk_base = [0.0, 0.0, 0.0];
        let trunk_top = [0.0, 3.5, 0.0];
        let trunk_radius = 0.25;
        
        let root_branch = BranchNode {
            start_pos: trunk_base,
            end_pos: trunk_top,
            radius: trunk_radius,
            generation: 0,
        };
        
        let mut branches = vec![root_branch];
        Self::generate_branches(&mut branches, 0, 4, &mut rng);
        
        // Create geometry for all branches
        for branch in &branches {
            Self::add_branch_geometry(
                &mut vertices,
                &mut indices,
                branch,
                &mut rng,
            );
        }
        
        // Add foliage clusters at branch endpoints
        for branch in &branches {
            if branch.generation >= 2 {
                Self::add_foliage_cluster(
                    &mut vertices,
                    &mut indices,
                    branch.end_pos,
                    0.4 + random::<f32>() * 0.3,
                    &mut rng,
                );
            }
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
    
    fn generate_branches(
        branches: &mut Vec<BranchNode>,
        parent_idx: usize,
        max_generation: u32,
        rng: &mut impl Rng,
    ) {
        let parent = branches[parent_idx].clone();
        
        if parent.generation >= max_generation {
            return;
        }
        
        let dir = [
            parent.end_pos[0] - parent.start_pos[0],
            parent.end_pos[1] - parent.start_pos[1],
            parent.end_pos[2] - parent.start_pos[2],
        ];
        
        let num_children = if parent.generation == 0 {
            3 + rng.gen_range(0..2)
        } else {
            2 + rng.gen_range(0..2)
        };
        
        for _ in 0..num_children {
            let angle = random::<f32>() * std::f32::consts::PI * 2.0;
            let tilt = if parent.generation == 0 {
                0.3 + random::<f32>() * 0.4
            } else {
                0.4 + random::<f32>() * 0.6
            };
            
            let length_scale = 0.6 + random::<f32>() * 0.3;
            let branch_length = (parent.end_pos[1] - parent.start_pos[1]) * length_scale;
            
            let forward = [
                dir[0] + angle.cos() * tilt,
                dir[1] * 0.7 + 0.3,
                dir[2] + angle.sin() * tilt,
            ];
            
            let mag = (forward[0] * forward[0] + forward[1] * forward[1] + forward[2] * forward[2]).sqrt();
            let forward_norm = [
                forward[0] / mag * branch_length,
                forward[1] / mag * branch_length,
                forward[2] / mag * branch_length,
            ];
            
            let child_end = [
                parent.end_pos[0] + forward_norm[0],
                parent.end_pos[1] + forward_norm[1],
                parent.end_pos[2] + forward_norm[2],
            ];
            
            let child_radius = parent.radius * (0.5 + random::<f32>() * 0.15);
            
            let child = BranchNode {
                start_pos: parent.end_pos,
                end_pos: child_end,
                radius: child_radius,
                generation: parent.generation + 1,
            };
            
            let child_idx = branches.len();
            branches.push(child);
            
            Self::generate_branches(branches, child_idx, max_generation, rng);
        }
    }
    
    fn add_branch_geometry(
        vertices: &mut Vec<Vertex>,
        indices: &mut Vec<u32>,
        branch: &BranchNode,
        rng: &mut impl Rng,
    ) {
        let segments = 6;
        let height_segments = 3;
        
        let bark_color_base = [0.3, 0.2, 0.1, 1.0];
        
        let dir = [
            branch.end_pos[0] - branch.start_pos[0],
            branch.end_pos[1] - branch.start_pos[1],
            branch.end_pos[2] - branch.start_pos[2],
        ];
        
        for h in 0..=height_segments {
            let t = h as f32 / height_segments as f32;
            let radius = branch.radius * (1.0 - t * 0.2);
            
            let pos = [
                branch.start_pos[0] + dir[0] * t,
                branch.start_pos[1] + dir[1] * t,
                branch.start_pos[2] + dir[2] * t,
            ];
            
            let ring_start = vertices.len() as u32;
            
            for i in 0..segments {
                let angle = (i as f32 / segments as f32) * 2.0 * std::f32::consts::PI;
                let cos_a = angle.cos();
                let sin_a = angle.sin();
                
                // Procedural bark texture using pseudo-noise
                let noise_val = ((pos[1] * 10.0 + angle * 3.0).sin() * 0.5 + 0.5) * 0.3;
                let bark_variation = 1.0 - noise_val;
                
                let vertex_pos = [
                    pos[0] + radius * cos_a,
                    pos[1],
                    pos[2] + radius * sin_a,
                ];
                
                vertices.push(Vertex {
                    position: vertex_pos,
                    tex_coords: [i as f32 / segments as f32, t],
                    normal: [cos_a, 0.0, sin_a],
                    color: [
                        bark_color_base[0] * bark_variation,
                        bark_color_base[1] * bark_variation,
                        bark_color_base[2] * bark_variation,
                        1.0,
                    ],
                });
            }
            
            if h > 0 {
                let prev_ring = ring_start - segments as u32;
                for i in 0..segments {
                    let i_u32 = i as u32;
                    let next_i = (i + 1) % segments;
                    let next_i_u32 = next_i as u32;
                    
                    indices.extend_from_slice(&[
                        prev_ring + i_u32,
                        ring_start + i_u32,
                        prev_ring + next_i_u32,
                        ring_start + i_u32,
                        ring_start + next_i_u32,
                        prev_ring + next_i_u32,
                    ]);
                }
            }
        }
    }
    
    fn add_foliage_cluster(
        vertices: &mut Vec<Vertex>,
        indices: &mut Vec<u32>,
        center: [f32; 3],
        radius: f32,
        rng: &mut impl Rng,
    ) {
        let detail_level = 2;
        let leaves_color = [0.1, 0.5, 0.1, 1.0];
        
        // Create icosphere-like foliage cluster
        let t = (1.0 + 5.0_f32.sqrt()) / 2.0;
        
        let mut ico_verts = vec![
            [-1.0, t, 0.0], [1.0, t, 0.0], [-1.0, -t, 0.0], [1.0, -t, 0.0],
            [0.0, -1.0, t], [0.0, 1.0, t], [0.0, -1.0, -t], [0.0, 1.0, -t],
            [t, 0.0, -1.0], [t, 0.0, 1.0], [-t, 0.0, -1.0], [-t, 0.0, 1.0],
        ];
        
        // Normalize and scale
        for v in &mut ico_verts {
            let mag = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            v[0] = v[0] / mag * radius + center[0];
            v[1] = v[1] / mag * radius + center[1];
            v[2] = v[2] / mag * radius + center[2];
        }
        
        let start_idx = vertices.len() as u32;
        
        for v in ico_verts {
            let normal = [
                (v[0] - center[0]) / radius,
                (v[1] - center[1]) / radius,
                (v[2] - center[2]) / radius,
            ];
            
            let color_variation = 0.8 + random::<f32>() * 0.4;
            
            vertices.push(Vertex {
                position: v,
                tex_coords: [0.0, 0.0],
                normal,
                color: [
                    leaves_color[0] * color_variation,
                    leaves_color[1] * color_variation,
                    leaves_color[2] * color_variation,
                    1.0,
                ],
            });
        }
        
        // Icosahedron faces
        let faces = [
            [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
            [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
            [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
            [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
        ];
        
        for face in faces {
            indices.extend_from_slice(&[
                start_idx + face[0],
                start_idx + face[1],
                start_idx + face[2],
            ]);
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
            size: (1000 * std::mem::size_of::<TreeInstance>()) as wgpu::BufferAddress,
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