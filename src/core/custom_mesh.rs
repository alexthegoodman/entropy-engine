use nalgebra::{Matrix4, Vector3};
use wgpu::util::DeviceExt;
use crate::core::{SimpleCamera::SimpleCamera, Transform_2::{Transform, matrix4_to_raw_array}, transform::create_empty_group_transform};
use std::sync::Arc;
use wgpu;
use crate::core::editor::WindowSize;

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
    pub render_role: Option<String>,
    pub model_bind_group: wgpu::BindGroup,
}

impl CustomMesh {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
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

        model_bind_group_layout: &wgpu::BindGroupLayout,
        texture_render_mode_buffer: &wgpu::Buffer,
        group_bind_group_layout: &wgpu::BindGroupLayout,
        camera: &SimpleCamera
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

        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("CustomMesh Uniform Buffer"),
            contents: bytemuck::cast_slice(&raw_matrix),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        // Create a 1x1 white texture as a default
        let texture_size = wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        };

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Default White Texture"),
            size: texture_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        // Create white pixel data
        let white_pixel: [u8; 4] = [255, 255, 255, 255];

        // Copy white pixel data to texture
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &white_pixel,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: None,
            },
            texture_size,
        );

        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });

        // Create default sampler
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        // Create a 1x1 default normal texture (flat normal, [0.5, 0.5, 1.0, 1.0] for (0,0,1) normal)
        let normal_texture_size = wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        };
        let normal_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Default Normal Texture"),
            size: normal_texture_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let flat_normal: [u8; 4] = [128, 128, 255, 255]; // (0,0,1) normal in Rgba8Unorm
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &normal_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &flat_normal,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: None,
            },
            normal_texture_size,
        );
        let normal_texture_view = normal_texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });

        // Create a 1x1 default PBR params texture (metallic=0, roughness=1, AO=1)
        let pbr_params_texture_size = wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        };
        let pbr_params_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Default PBR Params Texture"),
            size: pbr_params_texture_size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let default_pbr_params: [u8; 4] = [0, 255, 255, 255]; // metallic=0, roughness=1, AO=1
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &pbr_params_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &default_pbr_params,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: None,
            },
            pbr_params_texture_size,
        );
        let pbr_params_texture_view = pbr_params_texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &model_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&texture_view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Sampler(&sampler),
            },wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: texture_render_mode_buffer,
                            offset: 0,
                            size: None,
                        }),
                    },
            wgpu::BindGroupEntry {
                binding: 4,
                resource: wgpu::BindingResource::TextureView(&normal_texture_view), // normal array
            },
            wgpu::BindGroupEntry {
                binding: 5,
                resource: wgpu::BindingResource::TextureView(&pbr_params_texture_view), // pbr params array
            }],
            label: None,
        });

        let mut transform = Transform::new(
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(1.0, 1.0, 1.0),
            uniform_buffer,
        );

        let (tmp_group_bind_group, tmp_group_transform) =
            create_empty_group_transform(device, group_bind_group_layout, &WindowSize {
                width: camera.viewport.window_size.width,
                height: camera.viewport.window_size.height
            });

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
            render_role: None,
            model_bind_group: bind_group
        }
    }
}
