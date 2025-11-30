use std::f32::consts::PI;

use cgmath::SquareMatrix;
use cgmath::{Matrix3, Matrix4, Rad, Vector2, Vector3};
use wgpu::util::DeviceExt;
use crate::vertex::get_z_layer;

use crate::editor::{Point, WindowSize};

pub struct Transform {
    pub position: Vector2<f32>,
    pub rotation: f32, // Rotation angle in radians
    pub scale: Vector2<f32>,
    pub uniform_buffer: wgpu::Buffer,
    pub layer: f32,
}

impl Transform {
    pub fn new(
        position: Vector2<f32>,
        rotation: f32, // Accepts angle in radians
        scale: Vector2<f32>,
        uniform_buffer: wgpu::Buffer,
        window_size: &WindowSize,
    ) -> Self {
        // let x = ((position[0]) / window_size.width as f32) * 2.0 - 1.0;
        // let y = 1.0 - ((position[1]) / window_size.height as f32) * 2.0;

        // println!("Transform x: {:?} y: {:?}", x, y);

        Self {
            // position: Vector2::new(x, y),
            position,
            rotation,
            scale,
            uniform_buffer,
            layer: 0.0,
        }
    }

    // pub fn update_transform(&self) -> Matrix3<f32> {
    //     // Create individual transformation matrices
    //     let translation = Matrix3::from_translation(self.position);
    //     let rotation = Matrix3::from_angle_z(Rad(self.rotation));
    //     let scale = Matrix3::from_nonuniform_scale(self.scale.x, self.scale.y);

    //     // Combine transformations: translation * rotation * scale
    //     translation * rotation * scale
    // }

    pub fn update_transform(&self, window_size: &WindowSize) -> Matrix4<f32> {
        let x = self.position.x;
        let y = self.position.y;

        // Create individual transformation matrices
        let translation = Matrix4::from_translation(Vector3::new(x, y, get_z_layer(self.layer)));
        let rotation = Matrix4::from_axis_angle(Vector3::new(0.0, 0.0, 1.0), Rad(self.rotation));
        // let scale = Matrix4::from_scale(self.scale.x);
        let scale = Matrix4::from_nonuniform_scale(self.scale.x, self.scale.y, 1.0); // Use both x and y scale

        // Combine transformations: translation * rotation * scale
        translation * rotation * scale
    }

    pub fn update_uniform_buffer(&self, queue: &wgpu::Queue, window_size: &WindowSize) {
        // Convert Matrix3 to Matrix4 for shader compatibility
        // let transform_matrix = self.matrix3_to_matrix4(self.update_transform(window_size));
        let transform_matrix = self.update_transform(window_size);
        let raw_matrix = matrix4_to_raw_array(&transform_matrix);
        queue.write_buffer(&self.uniform_buffer, 0, bytemuck::cast_slice(&raw_matrix));
    }

    fn matrix3_to_matrix4(&self, mat3: Matrix3<f32>) -> Matrix4<f32> {
        Matrix4::new(
            mat3.x.x, mat3.x.y, 0.0, mat3.x.z, // 1
            mat3.y.x, mat3.y.y, 0.0, mat3.y.z, // 2
            0.0, 0.0, 1.0, 0.0, // 3
            mat3.z.x, mat3.z.y, 0.0, mat3.z.z, // 4
        )
    }

    pub fn update_position(&mut self, position: [f32; 2], window_size: &WindowSize) {
        // let x = ((position[0]) / window_size.width as f32) * 2.0 - 1.0;
        // let y = 1.0 - ((position[1]) / window_size.height as f32) * 2.0;

        // self.position = Vector2::new(x, y);
        self.position = Vector2::new(position[0], position[1]);
    }

    pub fn update_rotation(&mut self, angle: f32) {
        self.rotation = angle;
    }

    pub fn update_rotation_degrees(&mut self, degrees: f32) {
        self.rotation = degrees * (PI / 180.0);
    }

    pub fn update_scale(&mut self, scale: [f32; 2]) {
        self.scale = Vector2::new(scale[0], scale[1]);
    }

    pub fn translate(&mut self, translation: Vector2<f32>) {
        self.position += translation;
    }

    pub fn rotate(&mut self, angle: f32) {
        self.rotation += angle;
    }

    pub fn rotate_degrees(&mut self, degrees: f32) {
        self.rotation += degrees * (PI / 180.0);
    }

    pub fn scale(&mut self, scale: Vector2<f32>) {
        self.scale.x *= scale.x;
        self.scale.y *= scale.y;
    }
}

pub fn matrix4_to_raw_array(matrix: &Matrix4<f32>) -> [[f32; 4]; 4] {
    let mut array = [[0.0; 4]; 4];
    for i in 0..4 {
        for j in 0..4 {
            array[i][j] = matrix[i][j];
        }
    }
    array
}

pub fn angle_between_points(p1: Point, p2: Point) -> f32 {
    let dx = p2.x - p1.x;
    let dy = p2.y - p1.y;

    // Calculate the angle in radians using atan2
    let angle_rad = dy.atan2(dx);

    angle_rad
}

pub fn degrees_between_points(p1: Point, p2: Point) -> f32 {
    let angle_rad = angle_between_points(p1, p2);

    // Convert radians to degrees if needed
    let angle_deg = angle_rad * 180.0 / PI;

    angle_deg
}

/// For creating temporary group bind groups
/// Later, when real groups are introduced, this will be replaced
pub fn create_empty_group_transform(
    device: &wgpu::Device,
    group_bind_group_layout: &wgpu::BindGroupLayout,
    window_size: &WindowSize,
) -> (wgpu::BindGroup, Transform) {
    let empty_buffer = Matrix4::<f32>::identity();
    let raw_matrix = matrix4_to_raw_array(&empty_buffer);

    let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Group Uniform Buffer"),
        contents: bytemuck::cast_slice(&raw_matrix),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });

    // Now create your bind group with these defaults
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        layout: &group_bind_group_layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: uniform_buffer.as_entire_binding(),
        }],
        label: None,
    });

    let group_transform = Transform::new(
        Vector2::new(0.0, 0.0),
        0.0,
        Vector2::new(1.0, 1.0),
        uniform_buffer,
        window_size,
    );

    (bind_group, group_transform)
}

// UPCOMING: perspective illusion with side scaling (each object has 4 sides in transform)
// use cgmath::{Matrix4, Vector2, Vector3, Rad};
// use std::f32::consts::PI;

// pub struct Transform {
//     pub position: Vector2<f32>,
//     pub rotation: f32,
//     pub scale: Vector2<f32>,
//     // Add side scales - clockwise from top
//     pub side_scales: [f32; 4],
//     pub uniform_buffer: wgpu::Buffer,
//     pub layer: f32,
// }

// impl Transform {
//     pub fn new(
//         position: Vector2<f32>,
//         rotation: f32,
//         scale: Vector2<f32>,
//         uniform_buffer: wgpu::Buffer,
//         window_size: &WindowSize,
//     ) -> Self {
//         Self {
//             position,
//             rotation,
//             scale,
//             // Initialize all sides with scale 1.0
//             side_scales: [1.0; 4],
//             uniform_buffer,
//             layer: 0.0,
//         }
//     }

//     // Add method to update individual side scales
//     pub fn update_side_scale(&mut self, side: usize, scale: f32) {
//         if side < 4 {
//             self.side_scales[side] = scale;
//         }
//     }

//     pub fn update_transform(&self, window_size: &WindowSize) -> Matrix4<f32> {
//         let x = self.position.x;
//         let y = self.position.y;

//         // Basic transformations
//         let translation = Matrix4::from_translation(Vector3::new(x, y, self.layer));
//         let rotation = Matrix4::from_axis_angle(Vector3::new(0.0, 0.0, 1.0), Rad(self.rotation));
//         let base_scale = Matrix4::from_nonuniform_scale(self.scale.x, self.scale.y, 1.0);

//         // Create perspective-like effect using side scales
//         // This creates a shear matrix that affects each side differently
//         let perspective_matrix = Matrix4::new(
//             self.side_scales[0], 0.0, 0.0, 0.0,
//             0.0, self.side_scales[1], 0.0, 0.0,
//             0.0, 0.0, self.side_scales[2], 0.0,
//             0.0, 0.0, 0.0, self.side_scales[3],
//         );

//         // Combine all transformations
//         // Order: translation * rotation * base_scale * perspective
//         translation * rotation * base_scale * perspective_matrix
//     }

//     // Helper method to set all side scales at once
//     pub fn set_side_scales(&mut self, scales: [f32; 4]) {
//         self.side_scales = scales;
//     }

//     // Helper method to create a perspective effect
//     pub fn set_perspective(&mut self, angle: f32) {
//         // Calculate side scales based on perspective angle
//         let top_scale = 1.0;
//         let right_scale = 1.0 - (angle.sin() * 0.5);
//         let bottom_scale = 1.0 - (angle.cos() * 0.5);
//         let left_scale = 1.0 - (angle.sin() * 0.5);

//         self.side_scales = [top_scale, right_scale, bottom_scale, left_scale];
//     }

//     // Rest of your existing methods remain the same...
// }

// // Scale individual sides
// transform.update_side_scale(0, 1.0);  // Top
// transform.update_side_scale(1, 0.8);  // Right
// transform.update_side_scale(2, 0.6);  // Bottom
// transform.update_side_scale(3, 0.8);  // Left

// // Or create a perspective effect
// transform.set_perspective(45.0_f32.to_radians());
