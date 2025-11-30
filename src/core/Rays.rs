use nalgebra::{Point3, Vector3};
use rapier3d::prelude::*;
use uuid::Uuid;
use wgpu::util::DeviceExt;

use crate::handlers::Vertex;

use super::SimpleCamera::SimpleCamera;

// Create ray from camera and mouse position
pub fn create_ray_from_mouse(
    mouse_pos: (f32, f32),
    camera: &SimpleCamera,
    screen_width: u32,
    screen_height: u32,
) -> Ray {
    // Convert screen coordinates to normalized device coordinates (NDC)
    let x = (2.0 * mouse_pos.0) / screen_width as f32 - 1.0;
    let y = 1.0 - (2.0 * mouse_pos.1) / screen_height as f32;

    // Get inverse view-projection matrix
    let inv_view_proj = camera.view_projection_matrix.try_inverse().unwrap();

    // Transform NDC to world space
    let near_point = inv_view_proj.transform_point(&Point3::new(x, y, -1.0));
    let far_point = inv_view_proj.transform_point(&Point3::new(x, y, 1.0));

    // Calculate ray direction
    let direction = (far_point - near_point).normalize();

    // println!("casting ray {:?} {:?}", direction, camera.position);

    // Create Rapier ray
    Ray::new(
        point![camera.position.x, camera.position.y, camera.position.z],
        vector![direction.x, direction.y, direction.z],
    )
}

// Perform raycast
pub fn cast_ray_at_components(
    ray: &Ray,
    query_pipeline: &QueryPipeline,
    rigid_body_set: &RigidBodySet,
    collider_set: &ColliderSet,
) -> Option<(ColliderHandle, f32)> {
    // Setup raycast parameters
    let max_toi = 1000.0; // Maximum distance to check
    let solid = true; // Detect solid objects
    let filter = QueryFilter::default()
        // Optionally add filters here, like:
        // .exclude_collider(some_collider_handle)
        // .groups(InteractionGroups::new(0b0001, 0b0010)) // If using collision groups
        ;

    // Perform the raycast
    query_pipeline.cast_ray(&rigid_body_set, &collider_set, ray, max_toi, solid, filter)
}

pub fn create_ray_debug_mesh(
    ray: &Ray,
    length: f32,
    thickness: f32,
    device: &wgpu::Device,
) -> (wgpu::Buffer, wgpu::Buffer, usize) {
    // Create a thin box along the ray
    let half_thickness = thickness / 2.0;

    // Create a rotation matrix to align the box with the ray direction
    let up = if ray.dir.y.abs() > 0.99 {
        Vector3::new(1.0, 0.0, 0.0) // Alternative up vector if ray is vertical
    } else {
        Vector3::new(0.0, 1.0, 0.0)
    };

    let right = ray.dir.cross(&up).normalize();
    let new_up = right.cross(&ray.dir).normalize();
    let end_point = ray.origin + ray.dir * length;

    // Create vertices in local space and transform them
    let vertices = [
        // Near face (create vertices in a plane perpendicular to ray direction)
        transform_vertex(
            ray.origin,
            -right * half_thickness - new_up * half_thickness,
            [1.0, 0.0, 0.0],
        ),
        transform_vertex(
            ray.origin,
            right * half_thickness - new_up * half_thickness,
            [1.0, 0.0, 0.0],
        ),
        transform_vertex(
            ray.origin,
            right * half_thickness + new_up * half_thickness,
            [1.0, 0.0, 0.0],
        ),
        transform_vertex(
            ray.origin,
            -right * half_thickness + new_up * half_thickness,
            [1.0, 0.0, 0.0],
        ),
        // Far face
        transform_vertex(
            end_point,
            -right * half_thickness - new_up * half_thickness,
            [1.0, 1.0, 0.0],
        ),
        transform_vertex(
            end_point,
            right * half_thickness - new_up * half_thickness,
            [1.0, 1.0, 0.0],
        ),
        transform_vertex(
            end_point,
            right * half_thickness + new_up * half_thickness,
            [1.0, 1.0, 0.0],
        ),
        transform_vertex(
            end_point,
            -right * half_thickness + new_up * half_thickness,
            [1.0, 1.0, 0.0],
        ),
    ];

    // Helper function to create transformed vertices
    fn transform_vertex(origin: Point3<f32>, offset: Vector3<f32>, color: [f32; 3]) -> Vertex {
        Vertex {
            position: [
                origin.x + offset.x,
                origin.y + offset.y,
                origin.z + offset.z,
            ],
            normal: [0.0, 0.0, 1.0],
            tex_coords: [0.0, 0.0],
            color,
        }
    }

    // Indices for the box (6 faces, 2 triangles each)
    let indices: [u16; 36] = [
        // Front face
        0, 1, 2, 2, 3, 0, // Back face
        4, 5, 6, 6, 7, 4, // Top face
        3, 2, 6, 6, 7, 3, // Bottom face
        0, 1, 5, 5, 4, 0, // Right face
        1, 2, 6, 6, 5, 1, // Left face
        0, 3, 7, 7, 4, 0,
    ];

    let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Debug Ray Vertex Buffer"),
        contents: bytemuck::cast_slice(&vertices),
        usage: wgpu::BufferUsages::VERTEX,
    });

    let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Debug Ray Index Buffer"),
        contents: bytemuck::cast_slice(&indices),
        usage: wgpu::BufferUsages::INDEX,
    });

    (vertex_buffer, index_buffer, indices.len())
}
