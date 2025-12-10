use nalgebra::{Matrix4, Point3, Vector3};
use std::f32::consts::PI;
use wgpu::util::DeviceExt;

use crate::core::SimpleCamera::SimpleCamera;
use crate::core::Transform_2::{matrix4_to_raw_array, Transform};
use crate::core::transform::create_empty_group_transform;
use crate::core::vertex::Vertex;
use crate::core::editor::WindowSize;

pub struct Sphere {
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub bind_group: wgpu::BindGroup,
    pub group_bind_group: wgpu::BindGroup,
    pub transform: Transform,
    pub index_count: u32,
    pub normal_texture: Option<wgpu::Texture>,
    pub normal_texture_view: Option<wgpu::TextureView>,
    pub pbr_params_texture: Option<wgpu::Texture>,
    pub pbr_params_texture_view: Option<wgpu::TextureView>,
}

impl Sphere {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        group_bind_group_layout: &wgpu::BindGroupLayout, 
        texture_render_mode_buffer: &wgpu::Buffer,
        camera: &SimpleCamera,
        radius: f32,
        sectors: u32, // longitude
        stacks: u32,  // latitude
        color: [f32; 3]
    ) -> Self {
        let (vertices, indices) = Self::generate_sphere_data(radius, sectors, stacks, color);

        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Sphere Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Sphere Index Buffer"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Cube Uniform Buffer"),
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

        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
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

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&texture_view), // albedo array
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

        let (tmp_group_bind_group, tmp_group_transform) =
            create_empty_group_transform(device, group_bind_group_layout, &WindowSize {
                width: camera.viewport.window_size.width,
                height: camera.viewport.window_size.height
            });

        Self {
            vertex_buffer,
            index_buffer,
            bind_group,
            group_bind_group: tmp_group_bind_group,
            transform: Transform::new(
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(1.0, 1.0, 1.0),
                uniform_buffer,
            ),
            index_count: indices.len() as u32,
            normal_texture: Some(normal_texture),
            normal_texture_view: Some(normal_texture_view),
            pbr_params_texture: Some(pbr_params_texture),
            pbr_params_texture_view: Some(pbr_params_texture_view),
        }
    }

    fn generate_sphere_data(radius: f32, sectors: u32, stacks: u32, color: [f32; 3]) -> (Vec<Vertex>, Vec<u16>) {
        let mut vertices = Vec::new();
        let mut indices = Vec::new();

        let sector_step = 2.0 * PI / sectors as f32;
        let stack_step = PI / stacks as f32;

        for i in 0..=stacks {
            let stack_angle = PI / 2.0 - (i as f32 * stack_step);
            let xy = radius * stack_angle.cos();
            let z = radius * stack_angle.sin();

            for j in 0..=sectors {
                let sector_angle = j as f32 * sector_step;
                let x = xy * sector_angle.cos();
                let y = xy * sector_angle.sin();

                // Normalized vertex normal
                let normal = Vector3::new(x, y, z).normalize();

                // Texture coordinates
                let s = j as f32 / sectors as f32;
                let t = i as f32 / stacks as f32;

                vertices.push(Vertex {
                    position: [x, y, z],
                    normal: [normal.x, normal.y, normal.z],
                    tex_coords: [s, t],
                    color: [color[0], color[1], color[2], 1.0], // Default to gray, can be modified as needed
                });
            }
        }

        // Generate indices
        for i in 0..stacks {
            let k1 = i * (sectors + 1);
            let k2 = k1 + sectors + 1;

            for j in 0..sectors {
                if i != 0 {
                    indices.push(k1 as u16 + j as u16);
                    indices.push(k2 as u16 + j as u16);
                    indices.push(k1 as u16 + (j + 1) as u16);
                }

                if i != (stacks - 1) {
                    indices.push(k1 as u16 + (j + 1) as u16);
                    indices.push(k2 as u16 + j as u16);
                    indices.push(k2 as u16 + (j + 1) as u16);
                }
            }
        }

        (vertices, indices)
    }
}
