use crate::core::camera::CameraBinding;
use nalgebra::{Point3, Vector3, Matrix4};
use wgpu::{util::DeviceExt, RenderPipeline};

#[derive(Debug, Clone, Copy)]
pub struct ShadowSettings {
    pub map_size: u32,
    pub bias: i32,
    pub slope_scale: f32,
    pub half_extent: f32,
}

impl Default for ShadowSettings {
    fn default() -> Self {
        Self {
            map_size: 1024,
            bias: 2,
            slope_scale: 2.0,
            half_extent: 2048.0, // 4096-wide orthographic frustum, matches the original hardcoded bounds
        }
    }
}

pub struct ShadowPipelineData {
    pub light_camera_binding: CameraBinding,
    pub shadow_pipeline: RenderPipeline,
    pub shadow_texture: wgpu::Texture,
    pub shadow_view: wgpu::TextureView,
    pub shadow_sampler: wgpu::Sampler,
    pub shadow_bind_group_layout: wgpu::BindGroupLayout,
    pub shadow_bind_group: wgpu::BindGroup,
    pub light_view_proj_matrix: Matrix4<f32>,
    pub settings: ShadowSettings,
}

impl ShadowPipelineData {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        model_bind_group_layout: &wgpu::BindGroupLayout,
        window_width: u32,
        window_height: u32,
        light_position: [f32; 3]
    ) -> Self {
        Self::new_with_settings(device, queue, model_bind_group_layout, window_width, window_height, light_position, ShadowSettings::default())
    }

    pub fn new_with_settings(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        model_bind_group_layout: &wgpu::BindGroupLayout,
        window_width: u32,
        window_height: u32,
        light_position: [f32; 3],
        settings: ShadowSettings,
    ) -> Self {
        let shadow_map_size = settings.map_size;
        let shadow_map_format = wgpu::TextureFormat::Depth32Float; // Or Depth16Unorm, Depth24Plus

        // 1. Light Camera Setup
        let light_position = Point3::new(light_position[0], light_position[1], light_position[2]);
        let light_target = Point3::new(0.0, 0.0, 0.0);
        let light_up = Vector3::new(0.0, 1.0, 0.0);

        let light_view = Matrix4::look_at_rh(&light_position, &light_target, &light_up);
        // Orthographic projection for directional light, adjust as needed for scene size
        let half_extent = settings.half_extent;
        let light_proj = nalgebra::Matrix4::new_orthographic(
            -half_extent, half_extent,  // left, right
            -half_extent, half_extent,  // bottom, top
            -500.0, 500.0     // near, far (adjust based on your scene height)
        );
        let light_view_proj_matrix = light_proj * light_view;

        let mut light_camera = crate::core::SimpleCamera::SimpleCamera::new(
            light_position,
            (light_target - light_position).normalize(),
            light_up,
            45.0f32.to_radians(), // Fov not used for orthographic, but kept for Camera struct
            0.1,
            100.0,
            shadow_map_size as f32,
            shadow_map_size as f32
        );

        light_camera.view_projection_matrix = light_view_proj_matrix; // so the binding gets the orthographic matrix

        let mut light_camera_binding = CameraBinding::new(device);
        light_camera_binding.update_3d(queue, &light_camera);


        // 2. Shadow Map Texture
        let shadow_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Shadow Map Texture"),
            size: wgpu::Extent3d {
                width: shadow_map_size,
                height: shadow_map_size,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: shadow_map_format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });

        let shadow_view = shadow_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // 3. Shadow Map Sampler (with comparison for PCF)
        let shadow_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Shadow Map Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            compare: Some(wgpu::CompareFunction::LessEqual), // Important for PCF
            lod_min_clamp: 0.0,
            lod_max_clamp: 100.0,
            ..Default::default()
        });

        // 4. Shadow Pipeline Layout
        // This layout uses the light's camera binding (group 0) and the model's transform (group 1)
        let shadow_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Shadow Pipeline Layout"),
                bind_group_layouts: &[
                    &light_camera_binding.bind_group_layout, // Group 0: light camera
                    model_bind_group_layout,                 // Group 1: model transform
                ],
                push_constant_ranges: &[],
            });

        // 5. Shadow Render Pipeline
        let shader_module_shadow =
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Shadow Shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/shadows.wgsl").into()),
            });

        let shadow_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Shadow Render Pipeline"),
            layout: Some(&shadow_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader_module_shadow,
                entry_point: Some("vs_main"),
                buffers: &[crate::core::vertex::Vertex::desc()],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: None, // No fragment shader needed for depth-only pass
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: Some(wgpu::Face::Back), // Cull back faces to avoid shadow acne from light perspective
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: shadow_map_format,
                depth_write_enabled: true,
                depth_compare: wgpu::CompareFunction::LessEqual, // Important for shadow mapping
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState {
                    constant: settings.bias, // Corresponds to depthBias in GLSL
                    slope_scale: settings.slope_scale, // Corresponds to depthBiasSlopeFactor
                    clamp: 0.0,
                },
            }),
            multisample: wgpu::MultisampleState {
                count: 1,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
            multiview: None,
            cache: None,
        });

        // Shadow Bind Group: Contains the light's camera binding
        let shadow_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Shadow Bind Group Layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Depth, // Depth texture
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison), // Comparison sampler
                        count: None,
                    },
                ],
            });

        let shadow_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Shadow Bind Group"),
            layout: &shadow_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: light_camera_binding.buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&shadow_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&shadow_sampler),
                },
            ],
        });


        Self {
            light_camera_binding,
            shadow_pipeline,
            shadow_texture,
            shadow_view,
            shadow_sampler,
            shadow_bind_group_layout,
            shadow_bind_group,
            light_view_proj_matrix,
            settings,
        }
    }

    pub fn render_shadow_pass<'rp>(
        &'rp self,
        render_pass: &mut wgpu::RenderPass<'rp>,
        renderer_state: &'rp mut crate::core::RendererState::RendererState,
        queue: &wgpu::Queue,
    ) {
        render_pass.set_pipeline(&self.shadow_pipeline);
        render_pass.set_bind_group(0, &self.light_camera_binding.bind_group, &[]);

        // Render all shadow-casting objects
        // The vertex shader will handle transforming them into light space and outputting depth.

        // Draw cubes
        for cube in &renderer_state.cubes {
            cube.transform.update_uniform_buffer(queue); // Ensure transform is up-to-date
            render_pass.set_bind_group(1, &cube.bind_group, &[]);
            render_pass.set_vertex_buffer(0, cube.vertex_buffer.slice(..));
            render_pass.set_index_buffer(
                cube.index_buffer.slice(..),
                wgpu::IndexFormat::Uint32,
            );
            render_pass.draw_indexed(0..cube.index_count as u32, 0, 0..1);
        }

        // Draw models
        for model in &renderer_state.models {
            for mesh in &model.meshes {
                mesh.transform.update_uniform_buffer(queue); // Ensure transform is up-to-date
                render_pass.set_bind_group(1, &mesh.bind_group, &[]);
                render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                render_pass.set_index_buffer(
                    mesh.index_buffer.slice(..),
                    wgpu::IndexFormat::Uint32,
                );
                render_pass.draw_indexed(0..mesh.index_count as u32, 0, 0..1);
            }
        }

        // Draw landscapes
        for landscape in &renderer_state.landscapes {
            landscape.transform.update_uniform_buffer(queue); // Ensure transform is up-to-date
            render_pass.set_bind_group(1, &landscape.bind_group, &[]);
            render_pass.set_vertex_buffer(0, landscape.vertex_buffer.slice(..));
            render_pass.set_index_buffer(
                landscape.index_buffer.slice(..),
                wgpu::IndexFormat::Uint32,
            );
            render_pass.draw_indexed(0..landscape.index_count as u32, 0, 0..1);
        }

        // Draw addon-spawned cubes and meshes (Entropy.Model.createProcedural/createMesh) -
        // without this, nothing an addon spawns can ever cast a shadow, only the built-in
        // editor cubes/models/landscapes above can. Both types were already created against
        // renderer_state.model_bind_group_layout (same as the built-in cubes/models), so
        // their existing group-1 bind group is directly compatible with this pipeline.
        for cubes in renderer_state.addon_cubes.values() {
            for cube in cubes {
                cube.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &cube.bind_group, &[]);
                render_pass.set_vertex_buffer(0, cube.vertex_buffer.slice(..));
                render_pass.set_index_buffer(cube.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                render_pass.draw_indexed(0..cube.index_count as u32, 0, 0..1);
            }
        }
        for meshes in renderer_state.addon_meshes.values() {
            for mesh in meshes {
                mesh.transform.update_uniform_buffer(queue);
                render_pass.set_bind_group(1, &mesh.model_bind_group, &[]);
                render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                render_pass.set_index_buffer(mesh.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                render_pass.draw_indexed(0..mesh.num_indices, 0, 0..mesh.instance_count);
            }
        }

        // TODO: Handle grass and water if they need to cast shadows. This might require specific shadow rendering paths for them.
        // For now, they are not included as shadow casters.
    }
}
