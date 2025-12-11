use nalgebra::{Matrix4, Point3, Vector3};
use wgpu::util::DeviceExt;

use crate::core::SimpleCamera::SimpleCamera;
use crate::core::Transform_2::{Transform, matrix4_to_raw_array};
use crate::core::editor::WindowSize;
use crate::core::transform::create_empty_group_transform;
use crate::core::vertex::Vertex;

pub struct Grid {
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
    pub bind_group: wgpu::BindGroup,
    pub group_bind_group: wgpu::BindGroup,
    pub transform: Transform
    // pub texture_bind_group: wgpu::BindGroup,
}

pub struct GridConfig {
    pub width: f32,
    pub depth: f32,
    pub spacing: f32,
    pub line_thickness: f32,
}

impl Grid {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        group_bind_group_layout: &wgpu::BindGroupLayout,
        texture_render_mode_buffer: &wgpu::Buffer,
        camera: &SimpleCamera,
        config: GridConfig,
    ) -> Self {
        // Generate grid vertices and indices
        let (vertices, indices) = Self::generate_grid(
            config.width,
            config.depth,
            config.spacing,
            config.line_thickness,
        );

        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Grid Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Grid Index Buffer"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        // let empty_buffer = Matrix4::<f32>::identity();
        // let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let grid_position = Vector3::new(0.0, 0.0, 0.0); // Adjust this Y value as needed
        let translation_matrix = Matrix4::new_translation(&grid_position);
        let translation_matrix = translation_matrix.transpose(); // Transpose to match wgpu layout
        let raw_matrix = matrix4_to_raw_array(&translation_matrix);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Grid Uniform Buffer"),
            contents: bytemuck::cast_slice(&raw_matrix),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        // let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        //     layout: &bind_group_layout,
        //     entries: &[wgpu::BindGroupEntry {
        //         binding: 0,
        //         resource: uniform_buffer.as_entire_binding(),
        //     }],
        //     label: None,
        // });

        // // Create a default empty texture and sampler
        // let default_texture = device.create_texture(&wgpu::TextureDescriptor {
        //     label: Some("Default Empty Grid Texture"),
        //     size: wgpu::Extent3d {
        //         width: 1,
        //         height: 1,
        //         depth_or_array_layers: 1,
        //     },
        //     mip_level_count: 1,
        //     sample_count: 1,
        //     dimension: wgpu::TextureDimension::D2,
        //     format: wgpu::TextureFormat::Rgba8UnormSrgb,
        //     usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        //     view_formats: &[],
        // });

        // let default_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        //     address_mode_u: wgpu::AddressMode::ClampToEdge,
        //     address_mode_v: wgpu::AddressMode::ClampToEdge,
        //     address_mode_w: wgpu::AddressMode::ClampToEdge,
        //     mag_filter: wgpu::FilterMode::Linear,
        //     min_filter: wgpu::FilterMode::Linear,
        //     mipmap_filter: wgpu::FilterMode::Nearest,
        //     ..Default::default()
        // });

        // let default_texture_view = default_texture.create_view(&wgpu::TextureViewDescriptor {
        //     dimension: Some(wgpu::TextureViewDimension::D2Array),
        //     ..Default::default()
        // });

        // let texture_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        //     layout: texture_bind_group_layout,
        //     entries: &[
        //         wgpu::BindGroupEntry {
        //             binding: 0,
        //             resource: wgpu::BindingResource::TextureView(&default_texture_view),
        //         },
        //         wgpu::BindGroupEntry {
        //             binding: 1,
        //             resource: wgpu::BindingResource::Sampler(&default_sampler),
        //         },
        //         wgpu::BindGroupEntry {
        //             binding: 2,
        //             resource: color_render_mode_buffer.as_entire_binding(),
        //         },
        //     ],
        //     label: Some("grid_texture_bind_group"),
        // });

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
                resource: wgpu::BindingResource::TextureView(&texture_view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Sampler(&sampler),
            },
            wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: texture_render_mode_buffer,
                            offset: 0,
                            size: None,
                        }),
                    }, wgpu::BindGroupEntry {
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
            index_count: indices.len() as u32,
            bind_group,
            group_bind_group: tmp_group_bind_group,
             transform: Transform::new(
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(1.0, 1.0, 1.0),
                uniform_buffer,
            ),
            // texture_bind_group,
        }
    }

    // fn generate_grid(width: f32, depth: f32, spacing: f32) -> (Vec<Vertex>, Vec<u16>) {
    //     let mut vertices = Vec::new();
    //     let mut indices = Vec::new();

    //     let half_width = width / 2.0;
    //     let half_depth = depth / 2.0;

    //     for i in 0..=((width / spacing) as u16) {
    //         let x = -half_width + i as f32 * spacing;
    //         vertices.push(Vertex {
    //             position: [x, 0.0, -half_depth],
    //             normal: [0.0, 0.0, 0.0],
    //             tex_coords: [0.0, 0.0],
    //             color: [1.0, 1.0, 1.0],
    //         });
    //         vertices.push(Vertex {
    //             position: [x, 0.0, half_depth],
    //             normal: [0.0, 0.0, 0.0],
    //             tex_coords: [0.0, 0.0],
    //             color: [1.0, 1.0, 1.0],
    //         });
    //         indices.push(i * 2);
    //         indices.push(i * 2 + 1);
    //     }

    //     let base = vertices.len() as u16;
    //     for i in 0..=((depth / spacing) as u16) {
    //         let z = -half_depth + i as f32 * spacing;
    //         vertices.push(Vertex {
    //             position: [-half_width, 0.0, z],
    //             normal: [0.0, 0.0, 0.0],
    //             tex_coords: [0.0, 0.0],
    //             color: [1.0, 1.0, 1.0],
    //         });
    //         vertices.push(Vertex {
    //             position: [half_width, 0.0, z],
    //             normal: [0.0, 0.0, 0.0],
    //             tex_coords: [0.0, 0.0],
    //             color: [1.0, 1.0, 1.0],
    //         });
    //         indices.push(base + i * 2);
    //         indices.push(base + i * 2 + 1);
    //     }

    //     // web_sys::console::log_1(&format!("Grid vertices: {:?}", vertices).into());
    //     // web_sys::console::log_1(&format!("Grid indices: {:?}", indices).into());

    //     (vertices, indices)
    // }

    fn generate_grid(
        width: f32,
        depth: f32,
        spacing: f32,
        line_width: f32,
    ) -> (Vec<Vertex>, Vec<u32>) {
        let mut vertices = Vec::new();
        let mut indices: Vec<u32> = Vec::new();

        let half_width = width / 2.0;
        let half_depth = depth / 2.0;
        let half_line_width = line_width / 2.0;
        let color = [1.0, 1.0, 0.0, 1.0];

        // Generate vertices and indices for vertical lines (along Z axis)
        for i in 0..=((width / spacing) as u32) {
            let x = -half_width + i as f32 * spacing;

            // Create four vertices for each line (rectangle)
            vertices.extend_from_slice(&[
                // Bottom-left vertex
                Vertex {
                    position: [x - half_line_width, 0.0, -half_depth],
                    normal: [0.0, 1.0, 0.0],
                    tex_coords: [0.0, 0.0],
                    color,
                },
                // Bottom-right vertex
                Vertex {
                    position: [x + half_line_width, 0.0, -half_depth],
                    normal: [0.0, 1.0, 0.0],
                    tex_coords: [1.0, 0.0],
                    color,
                },
                // Top-left vertex
                Vertex {
                    position: [x - half_line_width, 0.0, half_depth],
                    normal: [0.0, 1.0, 0.0],
                    tex_coords: [0.0, 1.0],
                    color,
                },
                // Top-right vertex
                Vertex {
                    position: [x + half_line_width, 0.0, half_depth],
                    normal: [0.0, 1.0, 0.0],
                    tex_coords: [1.0, 1.0],
                    color,
                },
            ]);

            // Add indices for two triangles
            let base_idx = (i * 4) as u32;
            indices.extend_from_slice(&[
                base_idx,
                base_idx + 1,
                base_idx + 2, // First triangle
                base_idx + 1,
                base_idx + 3,
                base_idx + 2, // Second triangle
            ]);
        }

        let vertical_vertex_count = vertices.len() as u32;

        // Generate vertices and indices for horizontal lines (along X axis)
        for i in 0..=((depth / spacing) as u32) {
            let z = -half_depth + i as f32 * spacing;

            // Create four vertices for each line (rectangle)
            vertices.extend_from_slice(&[
                // Left-bottom vertex
                Vertex {
                    position: [-half_width, 0.0, z - half_line_width],
                    normal: [0.0, 1.0, 0.0],
                    tex_coords: [0.0, 0.0],
                    color,
                },
                // Right-bottom vertex
                Vertex {
                    position: [half_width, 0.0, z - half_line_width],
                    normal: [0.0, 1.0, 0.0],
                    tex_coords: [1.0, 0.0],
                    color,
                },
                // Left-top vertex
                Vertex {
                    position: [-half_width, 0.0, z + half_line_width],
                    normal: [0.0, 1.0, 0.0],
                    tex_coords: [0.0, 1.0],
                    color,
                },
                // Right-top vertex
                Vertex {
                    position: [half_width, 0.0, z + half_line_width],
                    normal: [0.0, 1.0, 0.0],
                    tex_coords: [1.0, 1.0],
                    color,
                },
            ]);

            // Add indices for two triangles
            let base_idx = vertical_vertex_count + (i * 4);
            indices.extend_from_slice(&[
                base_idx,
                base_idx + 1,
                base_idx + 2, // First triangle
                base_idx + 1,
                base_idx + 3,
                base_idx + 2, // Second triangle
            ]);
        }

        (vertices, indices)
    }
}
