use nalgebra::{Isometry3, Matrix4, Point3, Vector3};
use rapier3d::math::{Point, Vector};
use rapier3d::parry::query::point;
use rapier3d::prelude::{point, ActiveCollisionTypes};
use rapier3d::prelude::{
    Collider, ColliderBuilder, ColliderHandle, InteractionGroups, RigidBody, RigidBodyBuilder,
    RigidBodyHandle,
};
use std::str::FromStr;
use uuid::Uuid;
use wgpu::util::{DeviceExt, TextureDataOrder};
use rand::prelude::*;
use rand::Rng;

use crate::core::SimpleCamera::SimpleCamera;
use crate::core::Texture::Texture;
use crate::core::Transform_2::{matrix4_to_raw_array, Transform};
use crate::core::transform::create_empty_group_transform;
use crate::core::vertex::Vertex;
use crate::helpers::landscapes::LandscapePixelData;
use crate::helpers::saved_data::LandscapeTextureKinds;
use crate::core::editor::WindowSize;

pub struct Landscape {
    pub id: String,
    pub transform: Transform,
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
    pub bind_group: wgpu::BindGroup,
    pub group_bind_group: wgpu::BindGroup,
    // pub texture_bind_group: wgpu::BindGroup,
    pub texture_array: Option<wgpu::Texture>,
    pub texture_array_view: Option<wgpu::TextureView>,
    pub texture_bind_group: Option<wgpu::BindGroup>,
    pub rapier_heightfield: Collider,
    pub rapier_rigidbody: RigidBody,
    pub collider_handle: Option<ColliderHandle>,
    pub rigid_body_handle: Option<RigidBodyHandle>,
    pub heights: nalgebra::DMatrix<f32>,
    pub particle_bind_group_layout: Option<wgpu::BindGroupLayout>
}

impl Landscape {
    pub fn new(
        landscapeComponentId: &String,
        data: &LandscapePixelData,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        group_bind_group_layout: &wgpu::BindGroupLayout,
        // texture_bind_group_layout: &wgpu::BindGroupLayout,
        texture_render_mode_buffer: &wgpu::Buffer,
        color_render_mode_buffer: &wgpu::Buffer,
        position: [f32; 3],
        camera: &SimpleCamera
    ) -> Self {
        // load actual vertices and indices (most important for now)
        let scale = 1.0;
        let (vertices, indices) = Self::generate_terrain(data, scale);

        // Create the scale vector - this determines the size of each cell in the heightfield

        // let ratio = square_height / square_size;
        // let scale = Vector::new(
        //     square_size, // x scale (width between columns) // i chose 2 because it 1024x1024 heightmap and 2048 size
        //     square_height,  // y scale (height scaling)
        //     square_size, // z scale (width between rows)
        // );

        // let terrain_collider = ColliderBuilder::heightfield(data.rapier_heights.clone(), scale)
        //     .friction(0.5) // Adjust how slippery the terrain is
        //     .restitution(0.0) // How bouncy (probably want 0 for terrain)
        //     .collision_groups(InteractionGroups::all()) // Make sure it can collide with everything
        //     .user_data(
        //         Uuid::from_str(landscapeComponentId)
        //             .expect("Couldn't extract uuid")
        //             .as_u128(),
        //     )
        //     .build();

        // Get the actual dimensions of your heightmap data
        let heightmap_width = data.rapier_heights.ncols() as f32;
        let heightmap_height = data.rapier_heights.nrows() as f32;

        // Print some debug info
        println!(
            "Heightmap dimensions: {} x {}",
            heightmap_width, heightmap_height
        );
        println!(
            "Sample heights min/max: {:?}/{:?}",
            data.rapier_heights
                .iter()
                .fold(f32::INFINITY, |a, &b| a.min(b)),
            data.rapier_heights
                .iter()
                .fold(f32::NEG_INFINITY, |a, &b| a.max(b))
        );

        // let square_size = 1024.0 * 100.0;
        // let square_height = 1858.0;
        let square_size = 1024.0 * 4.0;
        let square_height = 150.0 * 4.0;

        // Create terrain size that matches your actual terrain dimensions
        let terrain_size = Vector::new(
            square_size, // Total width in world units
            // 250.0,  // Total height in world units
            1.0,         // already specified when loading
            square_size, // Total depth in world units
        );

        let isometry = Isometry3::translation(position[0], position[1], position[2]);

        // let isometry = Isometry3::translation(-500.0, -500.0, -500.0);

        // println!(
        //     "vertices length: {:?} heights length: {:?}",
        //     vertices.len(),
        //     data.rapier_heights.clone().len()
        // );

        let terrain_collider =
            ColliderBuilder::heightfield(data.rapier_heights.clone(), terrain_size)
                .friction(0.9)
                .restitution(0.1)
                // .position(isometry)
                .user_data(
                    Uuid::from_str(landscapeComponentId)
                        .expect("Couldn't extract uuid")
                        .as_u128(),
                )
                .build();

        // Create the ground as a fixed rigid body

        println!("insert landscape position {:?}", position);

        let ground_rigid_body = RigidBodyBuilder::fixed()
            .position(isometry)
            .user_data(
                Uuid::from_str(&landscapeComponentId)
                    .expect("Couldn't extract uuid")
                    .as_u128(),
            )
            .sleeping(false)
            .build();

        // let (vertices, indices) = Self::generate_debug_terrain(&terrain_collider, &device, &isometry);

        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Landscape Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer: wgpu::Buffer =
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Landscape Index Buffer"),
                contents: bytemuck::cast_slice(&indices),
                usage: wgpu::BufferUsages::INDEX,
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

        // set uniform buffer for transforms
        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Landscape Uniform Buffer"),
            contents: bytemuck::cast_slice(&raw_matrix),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
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
            },wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: texture_render_mode_buffer,
                            offset: 0,
                            size: None,
                        }),
                    }],
            label: None,
        });

        let (tmp_group_bind_group, tmp_group_transform) =
            create_empty_group_transform(device, group_bind_group_layout, &WindowSize {
                width: camera.viewport.window_size.width,
                height: camera.viewport.window_size.height
            });

        Self {
            id: landscapeComponentId.to_owned(),
            index_count: indices.len() as u32,
            vertex_buffer,
            index_buffer,
            bind_group,
            group_bind_group: tmp_group_bind_group,
            // texture_bind_group,
            transform: Transform::new(
                Vector3::new(position[0], position[1], position[2]),
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(1.0, 1.0, 1.0),
                uniform_buffer,
            ),
            texture_array: None,
            texture_array_view: None,
            texture_bind_group: None,
            rapier_heightfield: terrain_collider,
            rapier_rigidbody: ground_rigid_body,
            collider_handle: None,
            rigid_body_handle: None,
            heights: data.rapier_heights.clone(),
            particle_bind_group_layout: None
        }
    }

    pub fn update_texture(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        texture_bind_group_layout: &wgpu::BindGroupLayout,
        texture_render_mode_buffer: &wgpu::Buffer,
        color_render_mode_buffer: &wgpu::Buffer,
        kind: LandscapeTextureKinds,
        new_texture: &Texture,
    ) {
        let layer = match kind {
            LandscapeTextureKinds::Primary => 0,
            LandscapeTextureKinds::PrimaryMask => 1,
            LandscapeTextureKinds::Rockmap => 2,
            LandscapeTextureKinds::RockmapMask => 3,
            LandscapeTextureKinds::Soil => 4,
            LandscapeTextureKinds::SoilMask => 5,
        };

        if self.texture_array.is_none() {
            self.create_texture_array(device, new_texture.size());
        }

        if let Some(texture_array) = &self.texture_array {
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: texture_array,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: 0,
                        y: 0,
                        z: layer,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                &new_texture.data,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(4 * new_texture.size().width),
                    rows_per_image: Some(new_texture.size().height),
                },
                new_texture.size(),
            );

            self.update_bind_group(
                device,
                texture_bind_group_layout,
                texture_render_mode_buffer,
                color_render_mode_buffer,
            );
        }
    }

    fn create_texture_array(&mut self, device: &wgpu::Device, size: wgpu::Extent3d) {
        let texture_array = device.create_texture(&wgpu::TextureDescriptor {
            size: wgpu::Extent3d {
                width: size.width,
                height: size.height,
                depth_or_array_layers: 6, // Primary, Rockmap, Soil and associated masks
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            label: Some("landscape_texture_array"),
            view_formats: &[],
        });

        let texture_array_view = texture_array.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });

        self.texture_array = Some(texture_array);
        self.texture_array_view = Some(texture_array_view);
    }

    // fn update_bind_group(
    //     &mut self,
    //     device: &wgpu::Device,
    //     texture_bind_group_layout: &wgpu::BindGroupLayout,
    //     texture_render_mode_buffer: &wgpu::Buffer,
    //     color_render_mode_buffer: &wgpu::Buffer,
    // ) {
    //     if let Some(texture_array_view) = &self.texture_array_view {
    //         let sampler = device.create_sampler(&wgpu::SamplerDescriptor::default());

    //         self.texture_bind_group = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
    //             layout: texture_bind_group_layout,
    //             entries: &[
    //                 wgpu::BindGroupEntry {
    //                     binding: 0,
    //                     resource: wgpu::BindingResource::TextureView(texture_array_view),
    //                 },
    //                 wgpu::BindGroupEntry {
    //                     binding: 1,
    //                     resource: wgpu::BindingResource::Sampler(&sampler),
    //                 },
    //                 wgpu::BindGroupEntry {
    //                     binding: 2,
    //                     resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
    //                         buffer: texture_render_mode_buffer,
    //                         offset: 0,
    //                         size: None,
    //                     }),
    //                 },
    //             ],
    //             label: Some("landscape_texture_bind_group"),
    //         }));
    //     }
    // }

    pub fn create_particle_bind_group(&self, device: &wgpu::Device) -> wgpu::BindGroup {
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor::default());

        device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &self.particle_bind_group_layout.as_ref().unwrap(),
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&self.texture_array_view.as_ref().expect("Couldn't get landscape texture array")), // Your texture array view
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler), // Your existing sampler
                },
            ],
            label: Some("Landscape Particle Bind Group"),
        })
    }

    pub fn create_layout_for_particles(&mut self, device: &wgpu::Device) {
        let landscape_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                entries: &[
                    // Texture array binding
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX, // Vertex shader needs to sample height
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2Array, // Texture array
                            multisampled: false,
                        },
                        count: None,
                    },
                    // Sampler binding
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::VERTEX, // Vertex shader needs the sampler too
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), // Filtering sampler
                        count: None,
                    },
                ],
                label: Some("Landscape Particle Bind Group Layout"),
            });

        self.particle_bind_group_layout = Some(landscape_bind_group_layout);
    }

    fn update_bind_group(
        &mut self,
        device: &wgpu::Device,
        texture_bind_group_layout: &wgpu::BindGroupLayout,
        texture_render_mode_buffer: &wgpu::Buffer,
        color_render_mode_buffer: &wgpu::Buffer,
    ) {
        if let Some(texture_array_view) = &self.texture_array_view {
            let sampler = device.create_sampler(&wgpu::SamplerDescriptor::default());

            // let empty_buffer = Matrix4::<f32>::identity();
            // let raw_matrix = matrix4_to_raw_array(&empty_buffer);

            // let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            //     label: Some("Terrain Uniform Buffer"),
            //     contents: bytemuck::cast_slice(&raw_matrix),
            //     usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            // });

            println!("New landscape bind group!");

            self.bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                layout: texture_bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: self.transform.uniform_buffer.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&texture_array_view),
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
                    },
                ],
                label: Some("landscape_texture_bind_group"),
            });
        }
    }

    // Generate vertex buffer from heightmap data
    // pub fn generate_terrain(data: &LandscapePixelData, scale: f32) -> (Vec<Vertex>, Vec<u32>) {
    //     let mut vertices = Vec::with_capacity(data.width * data.height);
    //     // let mut rapier_vertices = Vec::with_capacity(data.width * data.height);
    //     let mut indices = Vec::new();

    //     for y in 0..data.height {
    //         for x in 0..data.width {
    //             vertices.push(Vertex {
    //                 position: data.pixel_data[y][x].position,
    //                 normal: [0.0, 1.0, 0.0],
    //                 tex_coords: data.pixel_data[y][x].tex_coords,
    //                 color: [1.0, 1.0, 1.0, 1.0],
    //             });
    //             // rapier_vertices.push(Point::new(
    //             //     data.pixel_data[y][x].position[0],
    //             //     data.pixel_data[y][x].position[1],
    //             //     data.pixel_data[y][x].position[2],
    //             // ));
    //         }
    //     }

    //     // Generate indices with additional connections
    //     for y in 0..(data.height - 1) {
    //         for x in 0..(data.width - 1) {
    //             let top_left = (y * data.width + x) as u32;
    //             let top_right = top_left + 1;
    //             let bottom_left = ((y + 1) * data.width + x) as u32;
    //             let bottom_right = bottom_left + 1;

    //             // Main triangle
    //             indices.extend_from_slice(&[top_left, bottom_left, top_right]);
    //             indices.extend_from_slice(&[top_right, bottom_left, bottom_right]);

    //             // Additional connections
    //             if x < data.width - 2 {
    //                 // Connect to the next column
    //                 indices.extend_from_slice(&[top_right, bottom_right, top_right + 1]);
    //                 indices.extend_from_slice(&[bottom_right, bottom_right + 1, top_right + 1]);
    //             }

    //             if y < data.height - 2 {
    //                 // Connect to the next row
    //                 indices.extend_from_slice(&[
    //                     bottom_left,
    //                     bottom_left + data.width as u32,
    //                     bottom_right,
    //                 ]);
    //                 indices.extend_from_slice(&[
    //                     bottom_right,
    //                     bottom_left + data.width as u32,
    //                     bottom_right + data.width as u32,
    //                 ]);
    //             }
    //         }
    //     }

    //     // println!("Generating terrain colliders...");

    //     // // Create a static rigid body which doesn't move
    //     // let terrain_body = RigidBodyBuilder::fixed() // fixed means immovable
    //     //     .build();

    //     // println!("Body built...");

    //     // let terrain_collider = ColliderBuilder::trimesh(
    //     //     rapier_vertices,
    //     //     indices
    //     //         .chunks(3)
    //     //         .map(|chunk| [chunk[0], chunk[1], chunk[2]])
    //     //         .collect::<Vec<[u32; 3]>>(),
    //     // )
    //     // .build();

    //     println!("Terrain ready!");

    //     (vertices, indices)
    // }

    pub fn generate_terrain(data: &LandscapePixelData, scale: f32) -> (Vec<Vertex>, Vec<u32>) {
        let mut vertices = Vec::with_capacity(data.width * data.height);
        let mut indices = Vec::new();

        // First pass: Create vertices with placeholder normals
        for y in 0..data.height {
            for x in 0..data.width {
                vertices.push(Vertex {
                    position: data.pixel_data[y][x].position,
                    normal: [0.0, 1.0, 0.0], // Will calculate properly below
                    tex_coords: data.pixel_data[y][x].tex_coords,
                    color: [1.0, 1.0, 1.0, 1.0],
                });
            }
        }

        // Generate indices
        for y in 0..(data.height - 1) {
            for x in 0..(data.width - 1) {
                let top_left = (y * data.width + x) as u32;
                let top_right = top_left + 1;
                let bottom_left = ((y + 1) * data.width + x) as u32;
                let bottom_right = bottom_left + 1;

                // Main triangles
                indices.extend_from_slice(&[top_left, bottom_left, top_right]);
                indices.extend_from_slice(&[top_right, bottom_left, bottom_right]);

                // Additional connections
                if x < data.width - 2 {
                    indices.extend_from_slice(&[top_right, bottom_right, top_right + 1]);
                    indices.extend_from_slice(&[bottom_right, bottom_right + 1, top_right + 1]);
                }

                if y < data.height - 2 {
                    indices.extend_from_slice(&[
                        bottom_left,
                        bottom_left + data.width as u32,
                        bottom_right,
                    ]);
                    indices.extend_from_slice(&[
                        bottom_right,
                        bottom_left + data.width as u32,
                        bottom_right + data.width as u32,
                    ]);
                }
            }
        }

        // Calculate proper normals
        Self::calculate_normals(&mut vertices, &indices, data.width, data.height);

        println!("Terrain ready!");

        (vertices, indices)
    }

    fn calculate_normals(vertices: &mut [Vertex], indices: &[u32], width: usize, height: usize) {
        // Initialize all normals to zero
        for vertex in vertices.iter_mut() {
            vertex.normal = [0.0, 0.0, 0.0];
        }

        // Calculate face normals and accumulate to vertex normals
        for triangle in indices.chunks(3) {
            let i0 = triangle[0] as usize;
            let i1 = triangle[1] as usize;
            let i2 = triangle[2] as usize;

            let v0 = vertices[i0].position;
            let v1 = vertices[i1].position;
            let v2 = vertices[i2].position;

            // Calculate two edges of the triangle
            let edge1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
            let edge2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];

            // Cross product gives us the face normal
            let normal = [
                edge1[1] * edge2[2] - edge1[2] * edge2[1],
                edge1[2] * edge2[0] - edge1[0] * edge2[2],
                edge1[0] * edge2[1] - edge1[1] * edge2[0],
            ];

            // Accumulate to each vertex of the triangle
            for &idx in &[i0, i1, i2] {
                vertices[idx].normal[0] += normal[0];
                vertices[idx].normal[1] += normal[1];
                vertices[idx].normal[2] += normal[2];
            }
        }

        // Normalize all vertex normals
        for vertex in vertices.iter_mut() {
            let length = (vertex.normal[0] * vertex.normal[0]
                + vertex.normal[1] * vertex.normal[1]
                + vertex.normal[2] * vertex.normal[2])
                .sqrt();

            if length > 0.0001 {
                vertex.normal[0] /= length;
                vertex.normal[1] /= length;
                vertex.normal[2] /= length;
            } else {
                // Fallback to up vector if normal is too small
                vertex.normal = [0.0, 1.0, 0.0];
            }
        }
    }

    pub fn generate_debug_terrain(
        collider: &Collider,
        device: &wgpu::Device,
        position: &Isometry3<f32>
    ) -> (Vec<Vertex>, Vec<u32>) {
        let mut vertices = Vec::new();
        let mut indices = Vec::new();

         if let Some(shape) = collider.shape().as_heightfield() {
    // if let Some(shape) = collider.shape().as_trimesh() {

        
        let mut vertex_index = 0;

        // Generate random UV coordinates for color
        let mut rng = rand::thread_rng();
        let random_uv = [
            rng.gen_range(0.0..1.0), // U
            rng.gen_range(0.0..1.0), // V
        ];

        // Get triangles and build vertex/index buffers
        let triangles = shape.triangles();

        // println!("Debug Mesh Triangle count {:?}", &triangles.count());

        // Track min/max Y values to verify variation
        let mut min_y = f32::MAX;
        let mut max_y = f32::MIN;

        for triangle in triangles {
            if vertex_index > 100_000 {
                return (vertices, indices)
            }

            // Check Y variation in triangles
            min_y = min_y.min(triangle.a.y).min(triangle.b.y).min(triangle.c.y);
            max_y = max_y.max(triangle.a.y).max(triangle.b.y).max(triangle.c.y);

            if vertex_index < 3 {
                println!("Triangle {}:", vertex_index / 3);
                println!("  A: {:?}", triangle.a);
                println!("  B: {:?}", triangle.b);
                println!("  C: {:?}", triangle.c);
            }

            let tri_a = position * triangle.a;
            let tri_b = position * triangle.b;
            let tri_c = position * triangle.c;

            if vertex_index < 3 {
                println!("Triangle adjusted {}:", vertex_index / 3);
                println!("  A: {:?}", tri_a);
                println!("  B: {:?}", tri_b);
                println!("  C: {:?}", tri_c);
            }

            vertices.push(Vertex {
                position: [tri_a.x, tri_a.y, tri_a.z],
                normal: [0.0, 1.0, 0.0],
                tex_coords: random_uv, // Use the same random UV for all vertices
                color: [1.0, 1.0, 1.0, 1.0], // Default white color since we're using UVs for color
            });
            vertices.push(Vertex {
                position: [tri_b.x, tri_b.y, tri_b.z],
                normal: [0.0, 1.0, 0.0],
                tex_coords: random_uv,
                color: [1.0, 1.0, 1.0, 1.0],
            });
            vertices.push(Vertex {
                position: [tri_c.x, tri_c.y, tri_c.z],
                normal: [0.0, 1.0, 0.0],
                tex_coords: random_uv,
                color: [1.0, 1.0, 1.0, 1.0],
            });

            // Add indices for this triangle
            indices.push(vertex_index);
            indices.push(vertex_index + 1);
            indices.push(vertex_index + 2);

            vertex_index += 3;
        }
        
    }
    
            (vertices, indices)
        }
    
        pub fn get_height_at(&self, world_x: f32, world_z: f32) -> Option<f32> {
            // These should match the values used when creating the collider
            let square_size = 1024.0 * 4.0;
            let num_cols = self.heights.ncols();
            let num_rows = self.heights.nrows();
    
            // Landscape's origin in world space
            let land_origin_x = self.transform.position.x - (square_size / 2.0);
            let land_origin_z = self.transform.position.z - (square_size / 2.0);
    
            // 1. Convert world coordinates to landscape-local coordinates
            let local_x = world_x - land_origin_x;
            let local_z = world_z - land_origin_z;
    
            // 2. Normalize coordinates to [0, 1] range
            let norm_x = local_x / square_size;
            let norm_z = local_z / square_size;
    
            // Check if the coordinates are within the landscape bounds
            if norm_x < 0.0 || norm_x >= 1.0 || norm_z < 0.0 || norm_z >= 1.0 {
                return None;
            }
    
            // 3. Scale normalized coordinates to heightmap grid indices
            let grid_x = norm_x * (num_cols as f32 - 1.0);
            let grid_z = norm_z * (num_rows as f32 - 1.0);
    
            // 4. Perform bilinear interpolation
            let x0 = grid_x.floor() as usize;
            let z0 = grid_z.floor() as usize;
            let x1 = (x0 + 1).min(num_cols - 1);
            let z1 = (z0 + 1).min(num_rows - 1);
    
            // Get the heights of the four corner points
            let h00 = self.heights[(z0, x0)];
            let h10 = self.heights[(z0, x1)];
            let h01 = self.heights[(z1, x0)];
            let h11 = self.heights[(z1, x1)];
    
            // Calculate interpolation weights (fract parts)
            let tx = grid_x - x0 as f32;
            let tz = grid_z - z0 as f32;
    
            // Interpolate along x-axis
            let h_top = h00 * (1.0 - tx) + h10 * tx;
            let h_bottom = h01 * (1.0 - tx) + h11 * tx;
    
            // Interpolate along z-axis
            let final_height = h_top * (1.0 - tz) + h_bottom * tz;
            
            // Add the landscape's base Y position
            Some(final_height + self.transform.position.y)
        }
    }
