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

use crate::core::Texture::Texture;
use crate::core::Transform_2::{matrix4_to_raw_array, Transform};
use crate::core::vertex::Vertex;
use crate::helpers::landscapes::LandscapePixelData;
use crate::helpers::saved_data::LandscapeTextureKinds;

pub struct Landscape {
    pub id: String,
    pub transform: Transform,
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
    pub bind_group: wgpu::BindGroup,
    // pub texture_bind_group: wgpu::BindGroup,
    pub texture_array: Option<wgpu::Texture>,
    pub texture_array_view: Option<wgpu::TextureView>,
    pub texture_bind_group: Option<wgpu::BindGroup>,
    pub rapier_heightfield: Collider,
    pub rapier_rigidbody: RigidBody,
    pub collider_handle: Option<ColliderHandle>,
    pub rigid_body_handle: Option<RigidBodyHandle>,
    pub heights: nalgebra::DMatrix<f32>,
}

impl Landscape {
    pub fn new(
        landscapeComponentId: &String,
        data: &LandscapePixelData,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        texture_bind_group_layout: &wgpu::BindGroupLayout,
        color_render_mode_buffer: &wgpu::Buffer,
        position: [f32; 3],
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

        println!(
            "vertices length: {:?} heights length: {:?}",
            vertices.len(),
            data.rapier_heights.clone().len()
        );

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

        // set uniform buffer for transforms
        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Model GLB Uniform Buffer"),
            contents: bytemuck::cast_slice(&raw_matrix),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
            label: None,
        });

        // creating default texture view and sampler just like in Model, for use when model has no textures, but uses same shader
        // Create a default empty texture and sampler
        // let default_texture = device.create_texture(&wgpu::TextureDescriptor {
        //     label: Some("Default Empty Texture"),
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

        // let default_texture_view =
        //     default_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // // potential texture bind group
        // let texture_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        //     layout: &texture_bind_group_layout,
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
        //             resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
        //                 buffer: color_render_mode_buffer,
        //                 offset: 0,
        //                 size: None,
        //             }),
        //         },
        //     ],
        //     label: None,
        // });

        Self {
            id: landscapeComponentId.to_owned(),
            index_count: indices.len() as u32,
            vertex_buffer,
            index_buffer,
            bind_group,
            // texture_bind_group,
            transform: Transform::new(
                Vector3::new(0.0, -100.0, 0.0),
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
                wgpu::ImageCopyTexture {
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
                wgpu::ImageDataLayout {
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

    fn update_bind_group(
        &mut self,
        device: &wgpu::Device,
        texture_bind_group_layout: &wgpu::BindGroupLayout,
        texture_render_mode_buffer: &wgpu::Buffer,
        color_render_mode_buffer: &wgpu::Buffer,
    ) {
        if let Some(texture_array_view) = &self.texture_array_view {
            let sampler = device.create_sampler(&wgpu::SamplerDescriptor::default());

            self.texture_bind_group = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                layout: texture_bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(texture_array_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer: texture_render_mode_buffer,
                            offset: 0,
                            size: None,
                        }),
                    },
                ],
                label: Some("landscape_texture_bind_group"),
            }));
        }
    }

    // Generate vertex buffer from heightmap data
    pub fn generate_terrain(data: &LandscapePixelData, scale: f32) -> (Vec<Vertex>, Vec<u32>) {
        let mut vertices = Vec::with_capacity(data.width * data.height);
        // let mut rapier_vertices = Vec::with_capacity(data.width * data.height);
        let mut indices = Vec::new();

        for y in 0..data.height {
            for x in 0..data.width {
                vertices.push(Vertex {
                    position: data.pixel_data[y][x].position,
                    normal: [0.0, 0.0, 0.0],
                    tex_coords: data.pixel_data[y][x].tex_coords,
                    color: [1.0, 1.0, 1.0, 1.0],
                });
                // rapier_vertices.push(Point::new(
                //     data.pixel_data[y][x].position[0],
                //     data.pixel_data[y][x].position[1],
                //     data.pixel_data[y][x].position[2],
                // ));
            }
        }

        // Generate indices with additional connections
        for y in 0..(data.height - 1) {
            for x in 0..(data.width - 1) {
                let top_left = (y * data.width + x) as u32;
                let top_right = top_left + 1;
                let bottom_left = ((y + 1) * data.width + x) as u32;
                let bottom_right = bottom_left + 1;

                // Main triangle
                indices.extend_from_slice(&[top_left, bottom_left, top_right]);
                indices.extend_from_slice(&[top_right, bottom_left, bottom_right]);

                // Additional connections
                if x < data.width - 2 {
                    // Connect to the next column
                    indices.extend_from_slice(&[top_right, bottom_right, top_right + 1]);
                    indices.extend_from_slice(&[bottom_right, bottom_right + 1, top_right + 1]);
                }

                if y < data.height - 2 {
                    // Connect to the next row
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

        // println!("Generating terrain colliders...");

        // // Create a static rigid body which doesn't move
        // let terrain_body = RigidBodyBuilder::fixed() // fixed means immovable
        //     .build();

        // println!("Body built...");

        // let terrain_collider = ColliderBuilder::trimesh(
        //     rapier_vertices,
        //     indices
        //         .chunks(3)
        //         .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        //         .collect::<Vec<[u32; 3]>>(),
        // )
        // .build();

        println!("Terrain ready!");

        (vertices, indices)
    }
}
