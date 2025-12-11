use nalgebra::{Isometry3, Matrix4, Point3, Quaternion, UnitQuaternion, Vector3};
use rapier3d::math::Point;
use rapier3d::prelude::ColliderBuilder;
use rapier3d::prelude::*;
use uuid::Uuid;
use wgpu::util::DeviceExt;

use gltf::buffer::{Source, View};
use gltf::Glb;
use gltf::Gltf;
use wgpu::wgt::TextureDataOrder;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use image;

use crate::core::SimpleCamera::SimpleCamera;
use crate::core::Transform_2::{matrix4_to_raw_array, Transform};
use crate::core::transform::create_empty_group_transform;
use crate::core::vertex::Vertex;
use crate::helpers::utilities::get_common_os_dir;
use crate::core::editor::WindowSize;

pub struct Mesh {
    // pub transform: Matrix4<f32>,
    pub transform: Transform,
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
    pub bind_group: wgpu::BindGroup,
    pub normal_texture: Option<wgpu::Texture>,
    pub normal_texture_view: Option<wgpu::TextureView>,
    pub pbr_params_texture: Option<wgpu::Texture>,
    pub pbr_params_texture_view: Option<wgpu::TextureView>,
    pub rapier_collider: Collider,
    pub collider_handle: Option<ColliderHandle>,
    pub rapier_rigidbody: RigidBody,
    pub rigid_body_handle: Option<RigidBodyHandle>,
}

pub struct Model {
    pub id: String,
    pub group_transform: Transform,
    pub group_bind_group: wgpu::BindGroup,
    pub meshes: Vec<Mesh>,
    // pub transform: Transform,
}

impl Model {
    fn load_wgpu_texture_from_gltf_image(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        gltf_image_data: &gltf::image::Data,
        label: &str,
        format: wgpu::TextureFormat, // Add format parameter
    ) -> (wgpu::Texture, wgpu::TextureView) {
        let img = match gltf_image_data.format {
            gltf::image::Format::R8G8B8 => {
                // glTF doesn't support R8G8B8 directly for textures, usually converted to R8G8B8A8
                // For now, assuming image::load handles it or converting.
                // If it's truly R8G8B8, it would need padding to R8G8B8A8 or a specific WGPU format.
                // For simplicity, let's convert to RGBA8
                image::DynamicImage::ImageRgb8(
                    image::RgbImage::from_raw(
                        gltf_image_data.width,
                        gltf_image_data.height,
                        gltf_image_data.pixels.to_vec(),
                    )
                    .unwrap(),
                )
                .to_rgba8()
            }
            gltf::image::Format::R8G8B8A8 => {
                image::RgbaImage::from_raw(
                    gltf_image_data.width,
                    gltf_image_data.height,
                    gltf_image_data.pixels.to_vec(),
                )
                .unwrap()
            }
            // gltf::image::Format::R5G6B5 => {
            //     // Placeholder: needs proper conversion from R5G6B5 to RGBA8
            //     eprintln!("Warning: R5G6B5 format not fully supported, converting to RGBA8 (may lose precision).");
            //     image::DynamicImage::ImageRgb16(
            //         image::ImageBuffer::from_raw(
            //             gltf_image_data.width,
            //             gltf_image_data.height,
            //             gltf_image_data.pixels.to_vec(),
            //         )
            //         .unwrap(),
            //     )
            //     .to_rgba8()
            // }
            _ => {
                // For other formats, try to load and convert.
                // This part might need to be more robust based on actual glTF data.
                eprintln!(
                    "Warning: Unsupported glTF image format {:?}, attempting generic load.",
                    gltf_image_data.format
                );
                image::load_from_memory(&gltf_image_data.pixels)
                    .unwrap()
                    .to_rgba8()
            }
        };


        let size = wgpu::Extent3d {
            width: img.width(),
            height: img.height(),
            depth_or_array_layers: 1,
        };

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format, // Use the provided format
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &img,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4 * img.width()),
                rows_per_image: Some(img.height()),
            },
            size,
        );

        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });

        (texture, texture_view)
    }

    pub fn from_glb(
        model_component_id: &String,
        bytes: &Vec<u8>,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        group_bind_group_layout: &wgpu::BindGroupLayout,
        regular_texture_render_mode_buffer: &wgpu::Buffer,
        color_render_mode_buffer: &wgpu::Buffer,
        isometry: Isometry3<f32>,
        scale: Vector3<f32>,
        camera: &SimpleCamera
    ) -> Self {
        let glb = Glb::from_slice(&bytes).expect("Couldn't create glb from slice");

        let mut meshes = Vec::new();

        let gltf = Gltf::from_slice(&glb.json).expect("Failed to parse GLTF JSON");

        let buffer_data = match glb.bin {
            Some(bin) => bin,
            None => panic!("No binary data found in GLB file"),
        };

        let mut loaded_textures: Vec<(Arc<wgpu::Texture>, Arc<wgpu::TextureView>)> = Vec::new();

        // Load all textures from GLB
        for texture in gltf.textures() {
            let gltf_image = match texture.source().source() {
                gltf::image::Source::View { view, mime_type: _ } => {
                    let image_data = &buffer_data[view.offset()..view.offset() + view.length()];
                    image::load_from_memory(image_data).unwrap().to_rgba8()
                }
                gltf::image::Source::Uri { uri, mime_type: _ } => {
                    panic!("External URI image sources are not yet supported in glb files: {}", uri);
                }
            };
            let size = wgpu::Extent3d {
                width: gltf_image.width(),
                height: gltf_image.height(),
                depth_or_array_layers: 1,
            };
            let wgpu_texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some(&format!("GLB Texture {}", texture.index())),
                size,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &wgpu_texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &gltf_image,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(4 * gltf_image.width()),
                    rows_per_image: Some(gltf_image.height()),
                },
                size,
            );
            let wgpu_texture_view = wgpu_texture.create_view(&wgpu::TextureViewDescriptor {
                dimension: Some(wgpu::TextureViewDimension::D2Array),
                ..Default::default()
            });
            loaded_textures.push((Arc::new(wgpu_texture), Arc::new(wgpu_texture_view)));
        }  

        for node in gltf.nodes() {
            let transform = node.transform().decomposed();
            if let Some(mesh) = node.mesh() {

            

        // for mesh in gltf.meshes() {
            for primitive in mesh.primitives() {
                // Create a default sampler to be used for all textures
                let default_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                    address_mode_u: wgpu::AddressMode::Repeat,
                    address_mode_v: wgpu::AddressMode::Repeat,
                    address_mode_w: wgpu::AddressMode::Repeat,
                    mag_filter: wgpu::FilterMode::Linear,
                    min_filter: wgpu::FilterMode::Linear,
                    mipmap_filter: wgpu::FilterMode::Linear,
                    ..Default::default()
                });
                
                // Create 1x1 default textures for cases where PBR maps are missing
                let default_albedo_texture = device.create_texture_with_data(
                    queue,
                    &wgpu::TextureDescriptor {
                        label: Some("Default Albedo Texture"),
                        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: wgpu::TextureFormat::Rgba8UnormSrgb,
                        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                        view_formats: &[],
                    },
                    TextureDataOrder::default(),
                    &[255, 255, 255, 255], // White
                );
                let default_albedo_view = default_albedo_texture.create_view(&wgpu::TextureViewDescriptor {
                    dimension: Some(wgpu::TextureViewDimension::D2Array),
                    ..Default::default()
                });

                let default_normal_texture = device.create_texture_with_data(
                    queue,
                    &wgpu::TextureDescriptor {
                        label: Some("Default Normal Texture"),
                        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                        view_formats: &[],
                    },
                    TextureDataOrder::default(),
                    &[128, 128, 255, 255], // Flat normal (0,0,1)
                );
                let default_normal_view = default_normal_texture.create_view(&wgpu::TextureViewDescriptor {
                    dimension: Some(wgpu::TextureViewDimension::D2Array),
                    ..Default::default()
                });

                let default_pbr_params_texture = device.create_texture_with_data(
                    queue,
                    &wgpu::TextureDescriptor {
                        label: Some("Default PBR Params Texture"),
                        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                        mip_level_count: 1,
                        sample_count: 1,
                        dimension: wgpu::TextureDimension::D2,
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                        view_formats: &[],
                    },
                    TextureDataOrder::default(),
                    &[0, 255, 255, 255], // Metallic=0, Roughness=1, AO=1
                );
                let default_pbr_params_view = default_pbr_params_texture.create_view(&wgpu::TextureViewDescriptor {
                    dimension: Some(wgpu::TextureViewDimension::D2Array),
                    ..Default::default()
                });

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
                    "first 5 tex_coords {:?}",
                    tex_coords[0],
                    // tex_coords[100],
                    // tex_coords[200],
                    // tex_coords[300],
                    // tex_coords[400]
                );

                // 2. Apply scaling to positions
                let scaled_positions: Vec<[f32; 3]> = positions
                    .map(|p| [p[0] * scale.x, p[1] * scale.y, p[2] * scale.z])
                    .collect();

                let vertices: Vec<Vertex> = scaled_positions.iter()
                    .zip(normals.iter())
                    .zip(tex_coords.iter())
                    .zip(colors.iter())
                    .map(|(((p, n), t), c)| Vertex {
                        position: *p,
                        normal: *n,
                        tex_coords: *t,
                        color: [c[0], c[1], c[2], 1.0],
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

                // --- Conversion Step ---
                // 1. Check if the length is a multiple of 3 (essential for a valid triangle mesh).
                if indices_u32.len() % 3 != 0 {
                    // You should handle this error, as it means the mesh data is corrupt
                    // or not a standard indexed triangle list.
                    eprintln!("Error: Flat index vector length is not a multiple of 3.");
                    // Decide how to proceed: panic, return an error, or just skip collider creation.
                }

                let rapier_indices: Vec<[u32; 3]> = indices_u32
                    .chunks_exact(3) // Iterate over the vector in non-overlapping chunks of 3
                    .map(|chunk| {
                        // Since we checked len() % 3 == 0, and used chunks_exact,
                        // this unwrap should be safe.
                        // It converts a &[u32] slice of length 3 into a [u32; 3] array.
                        let a: [u32; 3] = chunk.try_into().unwrap();
                        a
                    })
                    .collect();

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

                let material = primitive.material();
                let pbr_metallic_roughness = material.pbr_metallic_roughness();

                // let (base_color_view, normal_view, pbr_params_view) = {
                    // Base color texture
                    let loaded_base = pbr_metallic_roughness
                        .base_color_texture()
                        .and_then(|info| loaded_textures.get(info.texture().index()));
                        // .map_or_else(
                        //     || (Arc::new(default_albedo_texture), Arc::new(default_albedo_view)),
                        //     |(tex, view)| (Arc::clone(tex), Arc::clone(view)),
                        // );
                    
                    let mut base_color_view = Arc::new(default_albedo_view);
                    if let Some(base) = loaded_base {
                        base_color_view = base.1.clone();
                    }

                    // Normal texture
                    let loaded_normal = material
                        .normal_texture()
                        .and_then(|info| loaded_textures.get(info.texture().index()));
                        // .map_or_else(
                        //     || (Arc::new(default_normal_texture), Arc::new(default_normal_view)),
                        //     |(tex, view)| (Arc::clone(tex), Arc::clone(view)),
                        // );

                    let mut normal_tex =Arc::new(default_normal_texture);
                    let mut normal_view = Arc::new(default_normal_view);
                    if let Some(normal) = loaded_normal {
                        normal_tex = normal.0.clone();
                        normal_view = normal.1.clone();
                    }

                    // Metallic-Roughness and Occlusion packing for pbr_params_view (R: Metallic, G: Roughness, B: AO)
                    // let (pbr_params_tex, pbr_params_view) = {
                        let mut pbr_image_data = vec![0u8; 4]; // Default to [0,1,1,1] i.e., [metallic=0, roughness=1, ao=1]

                        // Metallic-Roughness (green channel is roughness, blue channel is metallic)
                        if let Some(info) = pbr_metallic_roughness.metallic_roughness_texture() {
                            if let Some((tex, view)) = loaded_textures.get(info.texture().index()) {
                                // For simplicity, we are using the 1x1 default texture directly.
                                // In a real scenario, you'd sample the actual texture.
                                // Here, we take default values
                                pbr_image_data[0] = 0; // metallic
                                pbr_image_data[1] = 255; // roughness
                            }
                        } else {
                            pbr_image_data[0] = 0; // default metallic
                            pbr_image_data[1] = 255; // default roughness
                        }

                        // Occlusion (red channel is occlusion)
                        if let Some(info) = material.occlusion_texture() {
                            if let Some((tex, view)) = loaded_textures.get(info.texture().index()) {
                                // Similar to metallic-roughness, using default for now.
                                pbr_image_data[2] = 255; // ao
                            }
                        } else {
                            pbr_image_data[2] = 255; // default ao
                        }

                        let pbr_params_tex = device.create_texture_with_data(
                            queue,
                            &wgpu::TextureDescriptor {
                                label: Some("Packed PBR Params Texture"),
                                size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                                mip_level_count: 1,
                                sample_count: 1,
                                dimension: wgpu::TextureDimension::D2,
                                format: wgpu::TextureFormat::Rgba8Unorm,
                                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                                view_formats: &[],
                            },
                            TextureDataOrder::default(),
                            &pbr_image_data,
                        );
                        let pbr_params_tex = Arc::new(pbr_params_tex);
                        let pbr_params_view = Arc::new(pbr_params_tex.create_view(&wgpu::TextureViewDescriptor {
                            dimension: Some(wgpu::TextureViewDimension::D2Array),
                            ..Default::default()
                        }));
                    //     (Arc::new(packed_pbr_texture), Arc::new(packed_pbr_texture.create_view(&wgpu::TextureViewDescriptor::default())))
                    // };
                //     (base_color_view, normal_view, pbr_params_view)
                // };

                let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    layout: &bind_group_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: uniform_buffer.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(&base_color_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: wgpu::BindingResource::Sampler(&default_sampler),
                        },
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                                buffer: regular_texture_render_mode_buffer,
                                offset: 0,
                                size: None,
                            }),
                        },
                        wgpu::BindGroupEntry {
                            binding: 4,
                            resource: wgpu::BindingResource::TextureView(&normal_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 5,
                            resource: wgpu::BindingResource::TextureView(&pbr_params_view),
                        },
                    ],
                    label: None,
                });

                // rapier physics and collision detection!
                // let rapier_collider = ColliderBuilder::convex_hull(&rapier_points)
                //     .expect("Couldn't create convex hull")
                //     .friction(0.7)
                //     .restitution(0.0)
                //     .density(1.0)
                //     .user_data(
                //         Uuid::from_str(&model_component_id)
                //             .expect("Couldn't extract uuid")
                //             .as_u128(),
                //     )
                //     .build();

                // to support interiors, although may need to use a hollow box collider? not sure. assemble houses in engine? well obviously just do fixed rigidbody for a house
                // would like to see a PhysicsSettings attached to models in the saved state
                let rapier_collider = ColliderBuilder::trimesh(rapier_points, rapier_indices)
                    // .expect("Couldn't create trimesh")
                    .friction(0.7)
                    .restitution(0.0)
                    .density(1.0)
                    .user_data(
                        Uuid::from_str(&model_component_id)
                            .expect("Couldn't extract uuid")
                            .as_u128(),
                    )
                    .build();

                let dynamic_body = RigidBodyBuilder::fixed()
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

                // let euler = isometry.rotation.euler_angles();
                

                
                let node_quat: nalgebra::Unit<Quaternion<f32>> = UnitQuaternion::from_quaternion(Quaternion::new(transform.1[0], transform.1[1], transform.1[2], transform.1[3]));
                // 
                // let new_quat = node_quat * quat;
                // let euler = new_quat.euler_angles();
                // let node_euler= node_quat.euler_angles();

                // println!("node euler {:?} {:?} {:?} {:?} {:?} {:?} {:?}", model_component_id, euler.0, euler.1, euler.2, euler.0.to_degrees(), euler.1.to_degrees(), euler.2.to_degrees());

                let euler = node_quat.euler_angles();

                meshes.push(Mesh {
                    transform: Transform::new(
                        Vector3::new(
                            isometry.translation.x,
                            isometry.translation.y,
                            isometry.translation.z,
                        ),
                        Vector3::new( euler.0.to_degrees(), euler.1.to_degrees(), euler.2.to_degrees()),
                        Vector3::new(1.0, 1.0, 1.0), // apply scale directly to vertices and set this to 1
                        uniform_buffer,
                    ),
                    vertex_buffer,
                    index_buffer,
                    index_count: indices_u32.len() as u32,
                    bind_group,
                    // group_bind_group: tmp_group_bind_group,
                    normal_texture: Some(Arc::try_unwrap(normal_tex).unwrap_or_else(|arc| arc.as_ref().clone())), // Store the texture
                    normal_texture_view: Some(Arc::try_unwrap(normal_view).unwrap_or_else(|arc| arc.as_ref().clone())),
                    pbr_params_texture: Some(Arc::try_unwrap(pbr_params_tex).unwrap_or_else(|arc| arc.as_ref().clone())),
                    pbr_params_texture_view: Some(Arc::try_unwrap(pbr_params_view).unwrap_or_else(|arc| arc.as_ref().clone())),
                    rapier_collider,
                    rapier_rigidbody: dynamic_body,
                    collider_handle: None,
                    rigid_body_handle: None,
                });
            }
        // }
        }
        }

        // probably better per model rather than per mesh
        let mut t_data =
            create_empty_group_transform(device, group_bind_group_layout, &WindowSize {
                width: camera.viewport.window_size.width,
                height: camera.viewport.window_size.height
            });

        let quat = isometry.rotation.quaternion();
        let quat: nalgebra::Unit<Quaternion<f32>> = UnitQuaternion::from_quaternion(Quaternion::new(quat.w, quat.i, quat.j, quat.k));

        t_data.1.rotation = quat;
        t_data.1.update_uniform_buffer(queue);

        Model {
            id: model_component_id.to_string(),
            group_transform: t_data.1,
            group_bind_group: t_data.0,
            meshes,
        }
    }
}

pub fn read_model(
    projectId: String,
    modelFilename: String,
) -> Result<Vec<u8>, String> {
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
