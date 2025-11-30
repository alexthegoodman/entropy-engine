use nalgebra::{Isometry3, Matrix4, Point3, Vector3};
use rapier3d::math::Point;
use rapier3d::prelude::ColliderBuilder;
use rapier3d::prelude::*;
use uuid::Uuid;
use wgpu::util::DeviceExt;

use gltf::buffer::{Source, View};
use gltf::Glb;
use gltf::Gltf;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;

use crate::core::Transform_2::{matrix4_to_raw_array, Transform};
use crate::handlers::Vertex;
use crate::helpers::utilities::get_common_os_dir;

pub struct Mesh {
    // pub transform: Matrix4<f32>,
    pub transform: Transform,
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
    pub bind_group: wgpu::BindGroup,
    pub texture_bind_group: wgpu::BindGroup,
    pub rapier_collider: Collider,
    pub collider_handle: Option<ColliderHandle>,
    pub rapier_rigidbody: RigidBody,
    pub rigid_body_handle: Option<RigidBodyHandle>,
}

pub struct Model {
    pub id: String,
    pub meshes: Vec<Mesh>,
    // pub transform: Transform,
}

impl Model {
    pub fn from_glb(
        model_component_id: &String,
        bytes: &Vec<u8>,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        texture_bind_group_layout: &wgpu::BindGroupLayout,
        texture_render_mode_buffer: &wgpu::Buffer,
        color_render_mode_buffer: &wgpu::Buffer,
        isometry: Isometry3<f32>,
    ) -> Self {
        // web_sys::console::log_1(&format!("Bytes len: {:?}", bytes.len()).into());

        let glb = Glb::from_slice(&bytes).expect("Couldn't create glb from slice");

        let mut meshes = Vec::new();

        let gltf = Gltf::from_slice(&glb.json).expect("Failed to parse GLTF JSON");

        let buffer_data = match glb.bin {
            Some(bin) => bin,
            None => panic!("No binary data found in GLB file"),
        };

        let uses_textures = gltf.textures().len().gt(&0);

        println!("Textures count: {:?}", gltf.textures().len());

        let mut textures = Vec::new();

        if (gltf.textures().len() > 0) {
            for texture in gltf.textures() {
                match texture.source().source() {
                    gltf::image::Source::View { view, mime_type: _ } => {
                        let img_data = &buffer_data[view.offset()..view.offset() + view.length()];
                        let img = image::load_from_memory(img_data).unwrap().to_rgba8();
                        let (width, height) = img.dimensions();

                        let size = wgpu::Extent3d {
                            width,
                            height,
                            depth_or_array_layers: 1,
                        };

                        let texture = device.create_texture(&wgpu::TextureDescriptor {
                            label: Some("GLB Texture"),
                            size,
                            mip_level_count: 1,
                            sample_count: 1,
                            dimension: wgpu::TextureDimension::D2,
                            format: wgpu::TextureFormat::Rgba8UnormSrgb,
                            usage: wgpu::TextureUsages::TEXTURE_BINDING
                                | wgpu::TextureUsages::COPY_DST,
                            view_formats: &[],
                        });

                        queue.write_texture(
                            wgpu::ImageCopyTexture {
                                texture: &texture,
                                mip_level: 0,
                                origin: wgpu::Origin3d::ZERO,
                                aspect: wgpu::TextureAspect::All,
                            },
                            &img,
                            wgpu::ImageDataLayout {
                                offset: 0,
                                bytes_per_row: Some(4 * width), // TODO: is this correct?
                                rows_per_image: Some(height),
                            },
                            size,
                        );

                        // let texture_view =
                        //     texture.create_view(&wgpu::TextureViewDescriptor::default());

                        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor {
                            dimension: Some(wgpu::TextureViewDimension::D2Array),
                            ..Default::default()
                        });

                        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                            address_mode_u: wgpu::AddressMode::ClampToEdge,
                            address_mode_v: wgpu::AddressMode::ClampToEdge,
                            address_mode_w: wgpu::AddressMode::ClampToEdge,
                            mag_filter: wgpu::FilterMode::Linear,
                            min_filter: wgpu::FilterMode::Linear,
                            mipmap_filter: wgpu::FilterMode::Nearest,
                            ..Default::default()
                        });

                        textures.push((texture_view, sampler));
                    }
                    gltf::image::Source::Uri { uri, mime_type: _ } => {
                        panic!(
                            "External URI image sources are not yet supported in glb files: {}",
                            uri
                        );
                    }
                }
            }
        }

        // Create a default empty texture and sampler, only used if no textures
        let default_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Default Empty Texture"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8UnormSrgb,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        let default_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        let default_texture_view = default_texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });

        for mesh in gltf.meshes() {
            for primitive in mesh.primitives() {
                let reader = primitive.reader(|buffer| Some(&buffer_data));

                let positions = reader
                    .read_positions()
                    .expect("Positions not existing in glb");
                let colors = reader
                    .read_colors(0)
                    .map(|v| v.into_rgb_f32().collect())
                    .unwrap_or_else(|| vec![[1.0, 1.0, 1.0]; positions.len()]);
                let normals: Vec<[f32; 3]> = reader
                    .read_normals()
                    .map(|iter| iter.collect())
                    .unwrap_or_else(|| vec![[0.0, 0.0, 1.0]; positions.len()]);
                let tex_coords: Vec<[f32; 2]> = reader
                    .read_tex_coords(0)
                    .map(|v| v.into_f32().collect())
                    .unwrap_or_else(|| vec![[0.0, 0.0]; positions.len()]);

                println!(
                    "first 5 tex_coords {:?} {:?} {:?} {:?} {:?}",
                    tex_coords[0],
                    tex_coords[100],
                    tex_coords[200],
                    tex_coords[300],
                    tex_coords[400]
                );

                let vertices: Vec<Vertex> = positions
                    .zip(normals.iter())
                    .zip(tex_coords.iter())
                    .zip(colors.iter())
                    .map(|(((p, n), t), c)| Vertex {
                        position: p,
                        normal: *n,
                        tex_coords: *t,
                        color: *c,
                    })
                    .collect();

                let rapier_points: Vec<Point<f32>> = vertices
                    .iter()
                    .map(|vertex| {
                        point![vertex.position[0], vertex.position[1], vertex.position[2]]
                    })
                    .collect();

                let indices_u32: Vec<u32> = reader
                    .read_indices()
                    .map(|iter| iter.into_u32().collect())
                    .unwrap_or_default();

                // let indices: Vec<u16> = indices_u32.iter().map(|&i| i as u16).collect();

                println!("Model vertices: {:?}", vertices.len());
                println!("Model indices: {:?}", indices_u32.len());

                let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Model GLB Vertex Buffer"),
                    contents: bytemuck::cast_slice(&vertices),
                    usage: wgpu::BufferUsages::VERTEX,
                });

                let index_buffer: wgpu::Buffer =
                    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Model GLB Index Buffer"),
                        contents: bytemuck::cast_slice(&indices_u32),
                        usage: wgpu::BufferUsages::INDEX,
                    });

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

                let render_mode_buffer = if uses_textures {
                    texture_render_mode_buffer
                } else {
                    color_render_mode_buffer
                };

                // Handle the texture bind group conditionally
                let texture_bind_group = if uses_textures && !textures.is_empty() {
                    let material = primitive.material();
                    let texture_index = material
                        .pbr_metallic_roughness()
                        .base_color_texture()
                        .map_or(0, |info| info.texture().index());
                    let (texture_view, sampler) = &textures[texture_index];

                    println!(
                        "Texture coord set {:?}",
                        material
                            .pbr_metallic_roughness()
                            .base_color_texture()
                            .map_or(0, |info| info.tex_coord())
                    );

                    device.create_bind_group(&wgpu::BindGroupDescriptor {
                        layout: &texture_bind_group_layout,
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::TextureView(texture_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::Sampler(sampler),
                            },
                            wgpu::BindGroupEntry {
                                binding: 2,
                                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                    buffer: render_mode_buffer,
                                    offset: 0,
                                    size: None,
                                }),
                            },
                        ],
                        label: None,
                    })
                } else {
                    device.create_bind_group(&wgpu::BindGroupDescriptor {
                        layout: &texture_bind_group_layout,
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::TextureView(&default_texture_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::Sampler(&default_sampler),
                            },
                            wgpu::BindGroupEntry {
                                binding: 2,
                                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                    buffer: render_mode_buffer,
                                    offset: 0,
                                    size: None,
                                }),
                            },
                        ],
                        label: None,
                    })
                };

                // rapier physics and collision detection!
                let rapier_collider = ColliderBuilder::convex_hull(&rapier_points)
                    .expect("Couldn't create convex hull")
                    .friction(0.7)
                    .restitution(0.0)
                    .density(1.0)
                    .user_data(
                        Uuid::from_str(&model_component_id)
                            .expect("Couldn't extract uuid")
                            .as_u128(),
                    )
                    .build();

                let dynamic_body = RigidBodyBuilder::dynamic()
                    .additional_mass(70.0) // Explicitly set mass (e.g., 70kg for a person)
                    .linear_damping(0.1)
                    .position(isometry)
                    .locked_axes(LockedAxes::ROTATION_LOCKED_X | LockedAxes::ROTATION_LOCKED_Z)
                    .user_data(
                        Uuid::from_str(&model_component_id)
                            .expect("Couldn't extract uuid")
                            .as_u128(),
                    )
                    .build();

                let euler = isometry.rotation.euler_angles();

                meshes.push(Mesh {
                    // transform: Matrix4::identity(),
                    transform: Transform::new(
                        Vector3::new(
                            isometry.translation.x,
                            isometry.translation.y,
                            isometry.translation.z,
                        ),
                        Vector3::new(euler.0, euler.1, euler.2),
                        Vector3::new(1.0, 1.0, 1.0),
                        uniform_buffer,
                    ),
                    vertex_buffer,
                    index_buffer,
                    index_count: indices_u32.len() as u32,
                    bind_group,
                    texture_bind_group,
                    rapier_collider,
                    rapier_rigidbody: dynamic_body,
                    collider_handle: None,
                    rigid_body_handle: None,
                });
            }
        }

        Model {
            id: model_component_id.to_string(),
            meshes,
        }
    }
}

pub fn read_model(
    // state: tauri::State<'_, AppState>,
    projectId: String,
    modelFilename: String,
) -> Result<Vec<u8>, String> {
    // let handle = &state.handle;
    // let config = handle.config();
    // let package_info = handle.package_info();
    // let env = handle.env();

    let sync_dir = get_common_os_dir().expect("Couldn't get CommonOS directory");
    let model_path = sync_dir.join(format!(
        "midpoint/projects/{}/models/{}",
        projectId, modelFilename
    ));

    let mut file = File::open(&model_path).map_err(|e| format!("Failed to open model: {}", e))?;

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read model: {}", e))?;

    Ok(bytes)
}
