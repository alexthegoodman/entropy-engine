use nalgebra::{Isometry3, Matrix4, Point3, Vector3};
use wgpu::util::DeviceExt;
use rapier3d::prelude::{Collider, ColliderBuilder, RigidBody, RigidBodyBuilder, ColliderHandle, RigidBodyHandle, point};

use crate::core::{Transform_2::{Transform, matrix4_to_raw_array}, vertex::Vertex};

// Defines the configuration for generating a procedural house.
pub struct HouseConfig {
    pub width: f32,
    pub depth: f32,
    pub height: f32,
    pub wall_thickness: f32,
    pub num_stories: u32,
    // Represents the level of destruction, from 0.0 (intact) to 1.0 (completely destroyed).
    pub destruction_level: f32, 
}

impl Default for HouseConfig {
    fn default() -> Self {
        Self {
            width: 10.0,
            depth: 12.0,
            height: 3.0, // Height of one story
            wall_thickness: 0.2,
            num_stories: 3,
            destruction_level: 0.0,
        }
    }
}

pub struct Mesh {
    pub transform: Transform,
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
    pub bind_group: wgpu::BindGroup,
    pub collider: Collider,
    pub collider_handle: Option<ColliderHandle>,
    pub rigid_body: RigidBody,
    pub rigid_body_handle: Option<RigidBodyHandle>,
}

pub struct House {
    pub id: String,
    pub meshes: Vec<Mesh>,
    pub config: HouseConfig,
}

impl House {
    pub fn new(
        id: &str,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        config: &HouseConfig,
        isometry: Isometry3<f32>,
    ) -> Self {
        let mut vertices = Vec::new();
        let mut indices = Vec::new();

        // --- Generate House Geometry ---
        // We will generate the house floor by floor.
        for story in 0..config.num_stories {
            let story_y_offset = story as f32 * config.height;

            // Create floor and ceiling
            let floor_y = story_y_offset;
            let ceiling_y = story_y_offset + config.height;
            
            // Floor
            generate_cuboid(
                &mut vertices, &mut indices,
                Point3::new(-config.width / 2.0, floor_y, -config.depth / 2.0),
                Point3::new(config.width / 2.0, floor_y + config.wall_thickness, config.depth / 2.0),
            );

            // Walls
            // Front wall
            generate_cuboid(
                &mut vertices, &mut indices,
                Point3::new(-config.width / 2.0, floor_y, config.depth / 2.0 - config.wall_thickness),
                Point3::new(config.width / 2.0, ceiling_y, config.depth / 2.0),
            );
            // Back wall
            generate_cuboid(
                &mut vertices, &mut indices,
                Point3::new(-config.width / 2.0, floor_y, -config.depth / 2.0),
                Point3::new(config.width / 2.0, ceiling_y, -config.depth / 2.0 + config.wall_thickness),
            );
            // Left wall
            generate_cuboid(
                &mut vertices, &mut indices,
                Point3::new(-config.width / 2.0, floor_y, -config.depth / 2.0),
                Point3::new(-config.width / 2.0 + config.wall_thickness, ceiling_y, config.depth / 2.0),
            );
            // Right wall
            generate_cuboid(
                &mut vertices, &mut indices,
                Point3::new(config.width / 2.0 - config.wall_thickness, floor_y, -config.depth / 2.0),
                Point3::new(config.width / 2.0, ceiling_y, config.depth / 2.0),
            );
        }

        // --- Create wgpu Buffers ---
        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(&format!("House Vertex Buffer: {}", id)),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(&format!("House Index Buffer: {}", id)),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        // --- Create dummy textures and sampler ---
        let (default_sampler, default_albedo_view, default_normal_view, default_pbr_params_view) = create_default_textures_and_sampler(device, queue);

        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Model GLB Uniform Buffer"),
            contents: bytemuck::cast_slice(&raw_matrix),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        

        // convenience buffers?
        let color_render_mode_buffer =
            device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Color Render Mode Buffer"),
                    contents: bytemuck::cast_slice(&[0i32]), // Default to normal mode
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

        // let texture_render_mode_buffer =
        //     device
        //         .create_buffer_init(&wgpu::util::BufferInitDescriptor {
        //             label: Some("Texture Render Mode Buffer"),
        //             contents: bytemuck::cast_slice(&[1i32]), // Default to text mode
        //             usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        //         });
        // let regular_texture_render_mode_buffer =
        //     device
        //         .create_buffer_init(&wgpu::util::BufferInitDescriptor {
        //             label: Some("Regular Texture Render Mode Buffer"),
        //             contents: bytemuck::cast_slice(&[2i32]), // Default to text mode
        //             usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        //         });

        // --- Bind Group ---
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&default_albedo_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&default_sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer: &color_render_mode_buffer,
                        offset: 0,
                        size: None,
                    }),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::TextureView(&default_normal_view),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: wgpu::BindingResource::TextureView(&default_pbr_params_view),
                },
            ],
            label: Some("House Bind Group"),
        });

        let euler =  isometry.rotation.euler_angles();

        let transform = Transform::new(
            Vector3::new(
                isometry.translation.x,
                isometry.translation.y,
                isometry.translation.z,
            ),
            Vector3::new(euler.0, euler.1, euler.2),
            Vector3::new(1.0, 1.0, 1.0), // apply scale directly to vertices and set this to 1
            uniform_buffer,
        );

        let rapier_points: Vec<Point3<f32>> = vertices
            .iter()
            .map(|v| Point3::new(v.position[0], v.position[1], v.position[2]))
            .collect();
        let rapier_indices: Vec<[u32; 3]> = indices.chunks_exact(3).map(|chunk| [chunk[0], chunk[1], chunk[2]]).collect();

        let collider = ColliderBuilder::trimesh(rapier_points, rapier_indices)
            .friction(0.7)
            .restitution(0.0)
            .build();
        
        let rigid_body = RigidBodyBuilder::fixed().position(isometry).build();

        let mesh = Mesh {
            transform,
            vertex_buffer,
            index_buffer,
            index_count: indices.len() as u32,
            bind_group,
            collider,
            collider_handle: None,
            rigid_body,
            rigid_body_handle: None,
        };

        Self {
            id: id.to_string(),
            meshes: vec![mesh],
            config: config.clone(),
        }
    }
}


fn create_default_textures_and_sampler(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
) -> (wgpu::Sampler, wgpu::TextureView, wgpu::TextureView, wgpu::TextureView) {
    let default_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        address_mode_u: wgpu::AddressMode::Repeat,
        address_mode_v: wgpu::AddressMode::Repeat,
        address_mode_w: wgpu::AddressMode::Repeat,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });

    let default_albedo_texture = device.create_texture_with_data(
        queue,
        &wgpu::TextureDescriptor {
            label: Some("Default Albedo Texture"),
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::LayerMajor,
        &[255, 255, 255, 255], // White
    );
    let default_albedo_view = default_albedo_texture.create_view(&wgpu::TextureViewDescriptor::default());

    let default_normal_texture = device.create_texture_with_data(
        queue,
        &wgpu::TextureDescriptor {
            label: Some("Default Normal Texture"),
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::LayerMajor,
        &[128, 128, 255, 255], // Flat normal (0,0,1)
    );
    let default_normal_view = default_normal_texture.create_view(&wgpu::TextureViewDescriptor::default());

    let default_pbr_params_texture = device.create_texture_with_data(
        queue,
        &wgpu::TextureDescriptor {
            label: Some("Default PBR Params Texture"),
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        },
        wgpu::util::TextureDataOrder::LayerMajor,
        &[0, 255, 255, 255], // Metallic=0, Roughness=1, AO=1
    );
    let default_pbr_params_view = default_pbr_params_texture.create_view(&wgpu::TextureViewDescriptor::default());

    (default_sampler, default_albedo_view, default_normal_view, default_pbr_params_view)
}

fn generate_cuboid(vertices: &mut Vec<Vertex>, indices: &mut Vec<u32>, min: Point3<f32>, max: Point3<f32>) {
    let start_index = vertices.len() as u32;

    // 8 corners of the cuboid
    let corners = [
        Point3::new(min.x, min.y, min.z), // 0
        Point3::new(max.x, min.y, min.z), // 1
        Point3::new(max.x, min.y, max.z), // 2
        Point3::new(min.x, min.y, max.z), // 3
        Point3::new(min.x, max.y, min.z), // 4
        Point3::new(max.x, max.y, min.z), // 5
        Point3::new(max.x, max.y, max.z), // 6
        Point3::new(min.x, max.y, max.z), // 7
    ];

    // Normals for each face
    let normals = [
        [0.0, 0.0, -1.0], // Front
        [0.0, 0.0, 1.0],  // Back
        [1.0, 0.0, 0.0],  // Right
        [-1.0, 0.0, 0.0], // Left
        [0.0, 1.0, 0.0],  // Top
        [0.0, -1.0, 0.0], // Bottom
    ];
    
    // Vertices for each face
    let faces = [
        // Front face
        (corners[4], corners[5], corners[1], corners[0], normals[0]),
        // Back face
        (corners[7], corners[3], corners[2], corners[6], normals[1]),
        // Right face
        (corners[6], corners[2], corners[1], corners[5], normals[2]),
        // Left face
        (corners[7], corners[4], corners[0], corners[3], normals[3]),
        // Top face
        (corners[7], corners[6], corners[5], corners[4], normals[4]),
        // Bottom face
        (corners[3], corners[0], corners[1], corners[2], normals[5]),
    ];

    for (p1, p2, p3, p4, normal) in &faces {
        let base_vertex_index = vertices.len() as u32;
        vertices.extend_from_slice(&[
            Vertex { position: [p1.x, p1.y, p1.z], normal: *normal, tex_coords: [0.0, 0.0], color: [1.0, 1.0, 1.0, 1.0] },
            Vertex { position: [p2.x, p2.y, p2.z], normal: *normal, tex_coords: [1.0, 0.0], color: [1.0, 1.0, 1.0, 1.0] },
            Vertex { position: [p3.x, p3.y, p3.z], normal: *normal, tex_coords: [1.0, 1.0], color: [1.0, 1.0, 1.0, 1.0] },
            Vertex { position: [p4.x, p4.y, p4.z], normal: *normal, tex_coords: [0.0, 1.0], color: [1.0, 1.0, 1.0, 1.0] },
        ]);
        indices.extend_from_slice(&[
            base_vertex_index, base_vertex_index + 1, base_vertex_index + 2,
            base_vertex_index, base_vertex_index + 2, base_vertex_index + 3,
        ]);
    }
}

impl Clone for HouseConfig {
    fn clone(&self) -> Self {
        Self {
            width: self.width,
            depth: self.depth,
            height: self.height,
            wall_thickness: self.wall_thickness,
            num_stories: self.num_stories,
            destruction_level: self.destruction_level,
        }
    }
}
