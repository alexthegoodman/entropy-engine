use std::sync::Arc;
use wgpu::util::DeviceExt;
use crate::core::gpu_resources::GpuResources;
use crate::core::vertex::ModelVertex;
use bytemuck::{Pod, Zeroable};

#[repr(C)]
#[derive(Debug, Copy, Clone, Pod, Zeroable)]
pub struct AlphaInstanceData {
    pub model_matrix: [[f32; 4]; 4],
    pub mesh_index: u32,
    pub material_index: u32,
    pub _padding: [u32; 2],
}

#[repr(C)]
#[derive(Debug, Copy, Clone, Pod, Zeroable)]
pub struct MeshDescriptor {
    pub base_vertex: i32,
    pub first_index: u32,
    pub index_count: u32,
    pub _padding: u32,
}

#[repr(C)]
#[derive(Debug, Copy, Clone, Pod, Zeroable)]
pub struct DrawIndexedIndirect {
    pub index_count: u32,
    pub instance_count: u32,
    pub first_index: u32,
    pub base_vertex: i32,
    pub first_instance: u32,
}

pub struct AlphaRenderer {
    pub gpu_resources: Arc<GpuResources>,
    
    // Global geometry buffers
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub current_vertex_offset: u64,
    pub current_index_offset: u64,
    
    // Instance data
    pub instance_buffer: wgpu::Buffer,
    pub max_instances: u32,
    pub current_instance_count: u32,
    
    // Mesh descriptors (placeholders for now)
    pub mesh_descriptor_buffer: wgpu::Buffer,
    pub mesh_descriptors: Vec<MeshDescriptor>,
    
    // Indirect draw arguments
    pub draw_args_buffer: wgpu::Buffer,
    
    // Visible instance indices
    pub visible_indices_buffer: wgpu::Buffer,
    
    // Camera
    pub camera_buffer: wgpu::Buffer,

    // Pipelines
    pub compute_culling_pipeline: wgpu::ComputePipeline,
    pub render_pipeline: wgpu::RenderPipeline,
    
    // Bind groups
    pub compute_bind_group: wgpu::BindGroup,
    pub render_bind_group: wgpu::BindGroup,
}

impl AlphaRenderer {
    pub fn upload_mesh(&mut self, vertices: &[ModelVertex], indices: &[u32]) -> u32 {
        let device = &self.gpu_resources.device;
        let queue = &self.gpu_resources.queue;

        let vertex_data = bytemuck::cast_slice(vertices);
        let index_data = bytemuck::cast_slice(indices);

        queue.write_buffer(&self.vertex_buffer, self.current_vertex_offset, vertex_data);
        queue.write_buffer(&self.index_buffer, self.current_index_offset, index_data);

        let mesh_index = self.mesh_descriptors.len() as u32;
        let descriptor = MeshDescriptor {
            base_vertex: (self.current_vertex_offset / std::mem::size_of::<ModelVertex>() as u64) as i32,
            first_index: (self.current_index_offset / 4) as u32,
            index_count: indices.len() as u32,
            _padding: 0,
        };

        self.mesh_descriptors.push(descriptor);
        
        self.current_vertex_offset += vertex_data.len() as u64;
        self.current_index_offset += index_data.len() as u64;

        mesh_index
    }

    pub fn add_instance(&mut self, instance: AlphaInstanceData) {
        if self.current_instance_count >= self.max_instances {
            return;
        }

        let queue = &self.gpu_resources.queue;
        let offset = (self.current_instance_count as usize * std::mem::size_of::<AlphaInstanceData>()) as u64;
        queue.write_buffer(&self.instance_buffer, offset, bytemuck::cast_slice(&[instance]));
        
        self.current_instance_count += 1;
    }
    pub fn new(gpu_resources: Arc<GpuResources>) -> Self {
        let device = &gpu_resources.device;

        let max_instances = 10000;
        
        // 1. Buffers
        let vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Alpha Vertex Buffer"),
            size: 10 * 1024 * 1024, // 10MB placeholder
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let index_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Alpha Index Buffer"),
            size: 10 * 1024 * 1024, // 10MB placeholder
            usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let instance_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Alpha Instance Buffer"),
            size: (max_instances * std::mem::size_of::<AlphaInstanceData>()) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let mesh_descriptor_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Alpha Mesh Descriptor Buffer"),
            size: 1024,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let draw_args_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Alpha Draw Args Buffer"),
            size: std::mem::size_of::<DrawIndexedIndirect>() as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::INDIRECT | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let visible_indices_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Alpha Visible Indices Buffer"),
            size: (max_instances * 4) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let camera_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Alpha Camera Buffer"),
            size: 64, // mat4x4
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // 2. Shaders
        let culling_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Alpha Culling Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/culling.wgsl").into()),
        });

        let render_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Alpha Render Shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shaders/render.wgsl").into()),
        });

        // 3. Bind Group Layouts
        let compute_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Alpha Compute Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let render_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Alpha Render Layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        // 4. Bind Groups
        let compute_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Alpha Compute Bind Group"),
            layout: &compute_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: camera_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: instance_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: draw_args_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: visible_indices_buffer.as_entire_binding() },
            ],
        });

        let render_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Alpha Render Bind Group"),
            layout: &render_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: camera_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: instance_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: visible_indices_buffer.as_entire_binding() },
            ],
        });

        // 5. Pipelines
        let compute_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Alpha Compute Pipeline Layout"),
            bind_group_layouts: &[&compute_layout],
            push_constant_ranges: &[],
        });

        let compute_culling_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Alpha Culling Pipeline"),
            layout: Some(&compute_pipeline_layout),
            module: &culling_shader,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        });

        let render_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Alpha Render Pipeline Layout"),
            bind_group_layouts: &[&render_layout],
            push_constant_ranges: &[],
        });

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Alpha Render Pipeline"),
            layout: Some(&render_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &render_shader,
                entry_point: Some("vs_main"),
                buffers: &[ModelVertex::desc()],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &render_shader,
                entry_point: Some("fs_main"),
                targets: &[
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba16Float, // Position
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba16Float, // Normal
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm, // Albedo
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm, // PBR
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                ],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
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

        AlphaRenderer {
            gpu_resources,
            vertex_buffer,
            index_buffer,
            current_vertex_offset: 0,
            current_index_offset: 0,
            instance_buffer,
            max_instances,
            current_instance_count: 0,
            mesh_descriptor_buffer,
            mesh_descriptors: Vec::new(),
            draw_args_buffer,
            visible_indices_buffer,
            camera_buffer,
            compute_culling_pipeline,
            render_pipeline,
            compute_bind_group,
            render_bind_group,
        }
    }

    pub fn render(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        position_view: &wgpu::TextureView,
        normal_view: &wgpu::TextureView,
        albedo_view: &wgpu::TextureView,
        pbr_view: &wgpu::TextureView,
        depth_view: &wgpu::TextureView,
        instance_count: u32,
    ) {
        // 1. Reset draw arguments (instance_count = 0)
        self.gpu_resources.queue.write_buffer(
            &self.draw_args_buffer,
            4, // Offset to instance_count
            bytemuck::cast_slice(&[0u32]),
        );

        // 2. Compute Pass (Culling)
        {
            let mut cpass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Alpha Culling Pass"),
                timestamp_writes: None,
            });
            cpass.set_pipeline(&self.compute_culling_pipeline);
            cpass.set_bind_group(0, &self.compute_bind_group, &[]);
            let workgroups = (instance_count + 63) / 64;
            cpass.dispatch_workgroups(workgroups, 1, 1);
        }

        // 3. Render Pass
        {
            let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Alpha Render Pass"),
                color_attachments: &[
                    Some(wgpu::RenderPassColorAttachment {
                        view: position_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load, // Assume already cleared
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    }),
                    Some(wgpu::RenderPassColorAttachment {
                        view: normal_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    }),
                    Some(wgpu::RenderPassColorAttachment {
                        view: albedo_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    }),
                    Some(wgpu::RenderPassColorAttachment {
                        view: pbr_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    }),
                ],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            rpass.set_pipeline(&self.render_pipeline);
            rpass.set_bind_group(0, &self.render_bind_group, &[]);
            rpass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
            rpass.set_index_buffer(self.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            rpass.draw_indexed_indirect(&self.draw_args_buffer, 0);
        }
    }
}
