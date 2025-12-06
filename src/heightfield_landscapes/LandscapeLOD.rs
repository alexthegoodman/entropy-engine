use image::DynamicImage;
use nalgebra::{Isometry3, Matrix4, Point3, Vector3};
use rapier3d::parry::query::Ray;
use rapier3d::prelude::*;
use rapier3d::prelude::{Collider, ColliderBuilder, RigidBody, RigidBodyBuilder};
use std::num::NonZeroU32;
use std::str::FromStr;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::Instant;
use util::BufferInitDescriptor;
use uuid::Uuid;
use wgpu::util::DeviceExt;
use wgpu::*;

use crate::core::SimpleCamera::SimpleCamera;
use crate::core::Texture::Texture;
use crate::core::Transform_2::{matrix4_to_raw_array, Transform};
use crate::core::vertex::Vertex;
use crate::helpers::landscapes::get_landscape_pixels;
use crate::helpers::saved_data::LandscapeTextureKinds;

use super::QuadNode::{QuadNode, TerrainMesh};

#[derive(Debug, Clone)]
pub struct Rect {
    pub x: f32,
    pub z: f32,
    pub width: f32,
    pub height: f32,
}

// pub const PHYSICS_DISTANCE: f32 = 1000.0;
// pub const MAX_LOD_LEVELS: usize = 6;
// pub const BASE_LOD_DISTANCE: f32 = 1000.0; // Distance for first LOD transition
// pub const LOD_DISTANCE_MULTIPLIER: f32 = 0.5; // Each level shows more detail at half the distance

pub const PHYSICS_DISTANCE: f32 = 16_777_216.0; // (if 4096 is 1024 resolution, 4 units apart for each vertex, then this should give some room)
pub const MAX_LOD_LEVELS: usize = 6;
pub const BASE_LOD_DISTANCE: f32 = 16_777_216.0; // Distance for first LOD transition
pub const LOD_DISTANCE_MULTIPLIER: f32 = 0.25; // Each level shows more detail at half the distance 16777216

// pub const PHYSICS_DISTANCE: f32 = 1_049_600.0; // (if 4096 is 1024 resolution, 4 units apart for each vertex, then this should give some room)
// pub const MAX_LOD_LEVELS: usize = 6;
// pub const BASE_LOD_DISTANCE: f32 = 1_049_600.0; // Distance for first LOD transition
// pub const LOD_DISTANCE_MULTIPLIER: f32 = 0.5; // Each level shows more detail at half the distance

// pub const PHYSICS_DISTANCE: f32 = 65_536.0; // useful for testing shorter distances
// pub const MAX_LOD_LEVELS: usize = 6;
// pub const BASE_LOD_DISTANCE: f32 = 65_536.0; // Distance for first LOD transition
// pub const LOD_DISTANCE_MULTIPLIER: f32 = 0.5; // Each level shows more detail at half the distance

// Helper function to calculate vertex normals
pub fn calculate_normals(vertices: &mut Vec<Vertex>, indices: &Vec<u32>) {
    // Reset all normals
    for vertex in vertices.iter_mut() {
        vertex.normal = [0.0, 0.0, 0.0];
    }

    // Calculate normals for each triangle and accumulate
    for chunk in indices.chunks(3) {
        if chunk.len() == 3 {
            let v0 = vertices[chunk[0] as usize].position;
            let v1 = vertices[chunk[1] as usize].position;
            let v2 = vertices[chunk[2] as usize].position;

            // Calculate triangle normal
            let edge1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
            let edge2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];

            // Cross product
            let normal = [
                edge1[1] * edge2[2] - edge1[2] * edge2[1],
                edge1[2] * edge2[0] - edge1[0] * edge2[2],
                edge1[0] * edge2[1] - edge1[1] * edge2[0],
            ];

            // Accumulate normals for each vertex of the triangle
            for &index in chunk {
                let vertex = &mut vertices[index as usize];
                vertex.normal[0] += normal[0];
                vertex.normal[1] += normal[1];
                vertex.normal[2] += normal[2];
            }
        }
    }

    // Normalize all normals
    for vertex in vertices.iter_mut() {
        let length = (vertex.normal[0] * vertex.normal[0]
            + vertex.normal[1] * vertex.normal[1]
            + vertex.normal[2] * vertex.normal[2])
            .sqrt();
        if length > 0.0 {
            vertex.normal[0] /= length;
            vertex.normal[1] /= length;
            vertex.normal[2] /= length;
        } else {
            vertex.normal = [0.0, 1.0, 0.0];
        }
    }
}

// // Helper function to sample height with normalized coordinates
pub fn sample_height_normalized(norm_x: f32, norm_z: f32, height_data: &[f32]) -> f32 {
    let width = (height_data.len() as f32).sqrt() as usize;
    let x = (norm_x * (width - 1) as f32).round() as usize;
    let z = (norm_z * (width - 1) as f32).round() as usize;
    let index = z * width + x;
    height_data.get(index).copied().unwrap_or(0.0)
}

pub fn sample_height_world(world_x: f32, world_z: f32, height_data: &[f32]) -> f32 {
    let width = (height_data.len() as f32).sqrt() as f32;

    // println!("normal width {:?}", width);

    // Convert from world space to 0-1 range using actual terrain width
    let norm_x = (world_x + width / 2.0) / width;
    let norm_z = (world_z + width / 2.0) / width;

    // Use these normalized coordinates directly to get the index
    let index = ((norm_z * width as f32) as f32 * width) + (norm_x * width as f32) as f32;

    // println!(
    //     "World pos ({:.1}, {:.1}) -> norm ({:.3}, {:.3}) -> index {}",
    //     world_x, world_z, norm_x, norm_z, index
    // );

    height_data.get(index as usize).copied().unwrap_or(0.0)
}

// Helper function to sample height from the height data
pub fn sample_height(x: f32, z: f32, height_data: &[f32]) -> f32 {
    // You'll need to implement proper sampling based on your height data format
    // This is a placeholder that returns 0.0
    0.0
}

// Create type for the message we'll send through channel
pub type ColliderMessage = (String, Collider); // (chunk_id, collider)

pub fn get_camera_distance_from_bounds(bounds: Rect, transform_position: [f32; 3], camera: &mut SimpleCamera) -> f32 {
    // let camera = get_camera();

    // Get node corners in world space
    let corners = [
        // Near corners
        [
            transform_position[0] + bounds.x,
            transform_position[1],
            transform_position[2] + bounds.z,
        ],
        [
            transform_position[0] + bounds.x + bounds.width,
            transform_position[1],
            transform_position[2] + bounds.z,
        ],
        // Far corners
        [
            transform_position[0] + bounds.x,
            transform_position[1],
            transform_position[2] + bounds.z + bounds.height,
        ],
        [
            transform_position[0] + bounds.x + bounds.width,
            transform_position[1],
            transform_position[2] + bounds.z + bounds.height,
        ],
    ];

    // Find closest point to camera
    let closest_dist = corners
        .iter()
        .map(|corner| {
            distance_squared(
                [camera.position.x, camera.position.y, camera.position.z],
                *corner,
            )
        })
        .reduce(f32::min)
        .unwrap_or(f32::MAX);

    closest_dist
}

pub fn get_camera_distance_from_bound_center(bounds: Rect, transform_position: [f32; 3], camera: &mut SimpleCamera) -> f32 {
    // let camera = get_camera();

    // Get node corners in world space
    let center = [
        transform_position[0] + bounds.x + (bounds.width / 2.0),
        transform_position[1],
        transform_position[2] + bounds.z + (bounds.height / 2.0),
    ];

    // Find closest point to camera
    let dist = distance_squared(
        [camera.position.x, camera.position.y, camera.position.z],
        center,
    );

    dist
}

pub fn get_camera_distance_from_bound_center_rel(
    bounds: Rect,
    transform_position: [f32; 3],
    camera: &mut SimpleCamera
) -> f32 {
    // let camera = get_camera();

    // Get node corners in world space
    // let center = [
    //     transform_position[0] + bounds.x + (bounds.width / 2.0),
    //     camera.position[1],
    //     transform_position[2] + bounds.z + (bounds.height / 2.0),
    // ];
    let center = [
        bounds.x + (bounds.width / 2.0), // transform should be applied at root mesh creation?
        camera.position[1],
        bounds.z + (bounds.height / 2.0),
    ];

    // Find closest point to camera
    let dist = distance_squared(
        [camera.position.x, camera.position.y, camera.position.z],
        center,
    );

    dist
}

pub fn get_camera_distance_from_bounds_rel(bounds: Rect, transform_position: [f32; 3], camera: &mut SimpleCamera) -> f32 {
    // let camera = get_camera();

    // Get node corners in world space
    let corners = [
        // Near corners
        [
            transform_position[0] + bounds.x,
            camera.position[1],
            transform_position[2] + bounds.z,
        ],
        [
            transform_position[0] + bounds.x + bounds.width,
            camera.position[1],
            transform_position[2] + bounds.z,
        ],
        // Far corners
        [
            transform_position[0] + bounds.x,
            camera.position[1],
            transform_position[2] + bounds.z + bounds.height,
        ],
        [
            transform_position[0] + bounds.x + bounds.width,
            camera.position[1],
            transform_position[2] + bounds.z + bounds.height,
        ],
    ];

    // Find closest point to camera
    let closest_dist = corners
        .iter()
        .map(|corner| {
            distance_squared(
                [camera.position.x, camera.position.y, camera.position.z],
                *corner,
            )
        })
        .reduce(f32::min)
        .unwrap_or(f32::MAX);

    closest_dist
}

// pub fn add_physics_components_mini(
//     rigid_body_set: &mut RigidBodySet,
//     collider_set: &mut ColliderSet,
//     device: &wgpu::Device,
//     // mesh: &mut TerrainMesh,
//     quad: &mut QuadNode,
//     collider: Collider,
// ) {
//     if let Some(ref mut mesh) = quad.mesh {
//         // Get rigid body
//         if let Some(ref rigid_body) = mesh.rigid_body {
//             let rigid_body_handle = rigid_body_set.insert(rigid_body.clone());
//             quad.rigid_body_handle = Some(rigid_body_handle);

//             println!(
//                 "Actual rigid_body world position: {:?}",
//                 rigid_body.position()
//             );

//             println!("landscape collider insert_with_parent");

//             let collider_handle =
//                 collider_set.insert_with_parent(collider, rigid_body_handle, rigid_body_set);
//             quad.collider_handle = Some(collider_handle);

//             if let Some(collider) = collider_set.get(collider_handle) {
//                 // Access the collider here
//                 let position = collider.position();
//                 println!("Collider position: {:?}", position);
//                 if let Some(debug_mesh) = create_debug_collision_mesh(&collider, device, position) {
//                     quad.debug_mesh = Some(debug_mesh);
//                 }
//             }
//         }
//     }
// }

pub fn add_physics_components_mini(
    rigid_body_set: &mut RigidBodySet,
    collider_set: &mut ColliderSet,
    device: &wgpu::Device,
    quad: &mut QuadNode,
    collider: Collider,
    create_debug_mesh: bool
) {
    if let Some(ref mut mesh) = quad.mesh {
        // Take ownership of the rigid body instead of cloning
        if let Some(rigid_body) = mesh.rigid_body.take() {
            // Use take() to move ownership
            let rigid_body_handle = rigid_body_set.insert(rigid_body); // No clone needed
            quad.rigid_body_handle = Some(rigid_body_handle);

            // println!(
            //     "Actual rigid_body world position: {:?}",
            //     rigid_body_set.get(rigid_body_handle).unwrap().position()
            // );

            // println!("landscape collider insert_with_parent");

            let collider_handle =
                collider_set.insert_with_parent(collider, rigid_body_handle, rigid_body_set);
            quad.collider_handle = Some(collider_handle);

            // if create_debug_mesh {
                if let Some(collider) = collider_set.get(collider_handle) {
                    // Access the collider here
                    let position = collider.position();
                    // println!("Collider position: {:?}", position);
                    if let Some(debug_mesh) = create_debug_collision_mesh(&collider, device, position) {
                        quad.debug_mesh = Some(debug_mesh);
                    }
                }
            // }
        }
    }
}

// Utility function to calculate squared distance between two 3D points
pub fn distance_squared(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let dz = b[2] - a[2];
    dx * dx + dy * dy + dz * dz
}

use rand::prelude::*;
use rand::Rng;

pub fn create_debug_collision_mesh(
    collider: &Collider,
    device: &Device,
    position: &Isometry3<f32>,
) -> Option<TerrainMesh> {
    // For heightfield
    // println!(
    //     "Heightfield collision groups: {:?}",
    //     collider.collision_groups()
    // );
    // println!("Heightfield solver groups: {:?}", collider.solver_groups());
    // println!("Is sensor: {:?}", collider.is_sensor());
    // println!("Collider parent handle: {:?}", collider.parent());

    println!("Heightfield Position {:?}:", position);

    if let Some(shape) = collider.shape().as_heightfield() {
    // if let Some(shape) = collider.shape().as_trimesh() {
        // Cast a ray from above the heightfield straight down
        // let start = Point3::new(0.0, 100.0, 0.0);
        // let direction = Vector3::new(0.0, 1.0, 0.0);
        // if let Some(intersection) = shape.cast_local_ray(
        //     &Ray::new(start, direction),
        //     f32::MAX,
        //     true, // solid
        // ) {
        //     // Calculate intersection point in world space
        //     let hit_point = start + direction * intersection;
        //     println!("Intersection at world position: {:?}", hit_point);
        //     println!("Relative to origin: {:?}", hit_point - Point3::origin());
        //     //    println!("Current rigid body position: {:?}", rb_pos.translation);
        //     //    // This difference might tell us what offset we need
        //     //    println!("Offset needed: {:?}", hit_point.coords - rb_pos.translation.vector);
        // } else {
        //     println!("No intersection found with ray!");
        // }

        // Debug print the heightfield properties
        // println!("Heightfield properties:");
        // println!("  Scale: {:?}", shape.scale());
        // println!("  Dimensions: {} x {}", shape.nrows(), shape.ncols());

        let mut vertices = Vec::new();
        let mut indices = Vec::new();
        let mut vertex_index = 0;

        // Generate random UV coordinates for color
        let mut rng = rand::thread_rng();
        let random_uv = [
            rng.gen_range(0.0..1.0), // U
            rng.gen_range(0.0..1.0), // V
        ];

        // println!("Generated random UV coordinates for color: {:?}", random_uv);

        // // Print some height values from the heightfield directly
        // println!("Raw height samples:");
        // for i in 0..3 {
        //     println!("  Height at {}: {}", i, shape.heights()[i]);
        // }

        // Get triangles and build vertex/index buffers
        let triangles = shape.triangles();

        // Track min/max Y values to verify variation
        let mut min_y = f32::MAX;
        let mut max_y = f32::MIN;

        for triangle in triangles {
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

            // let tri_a = triangle.a;
            // let tri_b = triangle.b;
            // let tri_c = triangle.c;

            // Add vertices with random UV coordinates
            // ideally, make + 452.0 dynamic with terrain position
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

        // println!("Height range in debug mesh:");
        // println!("  Min Y: {}", min_y);
        // println!("  Max Y: {}", max_y);
        // println!("  Variation: {}", max_y - min_y);

        // println!("Debug mesh stats:");
        // println!("  Vertices: {}", vertices.len());
        // println!("  Indices: {}", indices.len());

        // Create vertex buffer
        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Debug Collision Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        // Create index buffer
        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Debug Collision Index Buffer"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        Some(TerrainMesh {
            mesh_id: "001".to_string(),
            vertex_buffer,
            index_buffer,
            index_count: indices.len() as u32,
            collider: None,
            rigid_body: Some(RigidBodyBuilder::fixed().build()),
            depth: 1,
        })
    } else {
        None
    }
}

// Add this to handle hysteresis for LOD transitions
pub struct LodTransition {
    split_distance: f32,
    merge_distance: f32,
    transition_factor: f32,
}

impl LodTransition {
    pub fn new(base_distance: f32) -> Self {
        Self {
            split_distance: base_distance,
            merge_distance: base_distance * 1.2, // Add 20% hysteresis
            transition_factor: 0.0,
        }
    }

    pub fn update(&mut self, camera_distance: f32) -> bool {
        if camera_distance < self.split_distance {
            self.transition_factor = (self.split_distance - camera_distance) / self.split_distance;
            true
        } else if camera_distance > self.merge_distance {
            self.transition_factor = 0.0;
            false
        } else {
            // Keep current state to avoid flickering
            self.transition_factor > 0.5
        }
    }
}
