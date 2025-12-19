use nalgebra::{Matrix4, Point3, Quaternion, UnitQuaternion, Vector3};
use wgpu::util::DeviceExt;

use crate::core::vertex::Vertex;

#[derive(Debug)]
pub struct Transform {
    pub position: Vector3<f32>,
    pub rotation: UnitQuaternion<f32>,
    pub scale: Vector3<f32>,
    pub uniform_buffer: wgpu::Buffer,
}

impl Transform {
    pub fn new(
        position: Vector3<f32>,
        rotation: Vector3<f32>, // Accepts euler angles
        scale: Vector3<f32>,
        uniform_buffer: wgpu::Buffer,
    ) -> Self {
        let rotation_quat = UnitQuaternion::from_euler_angles(rotation.x, rotation.y, rotation.z);

        Self {
            position,
            rotation: rotation_quat,
            scale,
            uniform_buffer,
        }
    }

    pub fn new_with_quat(
        position: Vector3<f32>,
        rotation: UnitQuaternion<f32>,
        scale: Vector3<f32>,
        uniform_buffer: wgpu::Buffer,
    ) -> Self {
        Self {
            position,
            rotation,
            scale,
            uniform_buffer,
        }
    }

    pub fn update_transform(&self) -> Matrix4<f32> {
        let translation = Matrix4::new_translation(&self.position);
        let rotation = self.rotation.to_homogeneous();
        let scale = Matrix4::new_nonuniform_scaling(&self.scale);
        translation * rotation * scale
    }

    pub fn update_uniform_buffer(&self, queue: &wgpu::Queue) {
        let transform_matrix = self.update_transform().transpose();
        let raw_matrix = matrix4_to_raw_array(&transform_matrix);
        queue.write_buffer(&self.uniform_buffer, 0, bytemuck::cast_slice(&raw_matrix));
    }

    pub fn update_position(&mut self, position: [f32; 3]) {
        self.position = Vector3::from(position);
    }

    pub fn update_rotation(&mut self, rotation: [f32; 3]) {
        let rotation_quat = UnitQuaternion::from_euler_angles(
            rotation.get(0).expect("rotation x").to_owned(),
            rotation.get(1).expect("rotation y").to_owned(),
            rotation.get(2).expect("rotation z").to_owned(),
        );

        self.rotation = rotation_quat;
    }

    pub fn update_rotation_quat(&mut self, quaternion: [f32; 4]) {
        self.rotation = UnitQuaternion::from_quaternion(Quaternion::new(
            quaternion[3], // w component
            quaternion[0], // x component
            quaternion[1], // y component
            quaternion[2], // z component
        ));
    }

    pub fn update_scale(&mut self, scale: [f32; 3]) {
        self.scale = Vector3::new(
            scale.get(0).expect("scale x").to_owned(),
            scale.get(1).expect("scale y").to_owned(),
            scale.get(2).expect("scale z").to_owned(),
        );
    }

    pub fn translate(&mut self, translation: Vector3<f32>) {
        self.position += translation;
    }

    // pub fn rotate(&mut self, rotation: Vector3<f32>) {
    //     self.rotation += rotation;
    // }

    pub fn rotate(&mut self, rotation: Vector3<f32>) {
        // For euler angles
        let rotation_quat = UnitQuaternion::from_euler_angles(rotation.x, rotation.y, rotation.z);
        self.rotation = self.rotation * rotation_quat;
    }

    pub fn rotate_quat(&mut self, rotation: UnitQuaternion<f32>) {
        // For quaternions
        self.rotation = self.rotation * rotation;
    }

    pub fn scale(&mut self, scale: Vector3<f32>) {
        self.scale.component_mul_assign(&scale);
    }
}

pub fn matrix4_to_raw_array(matrix: &Matrix4<f32>) -> [[f32; 4]; 4] {
    let mut array = [[0.0; 4]; 4];
    for i in 0..4 {
        for j in 0..4 {
            array[i][j] = matrix[(i, j)];
        }
    }
    array
}

// fn matrix4_to_raw_array(matrix: &nalgebra::Matrix4<f32>) -> [f32; 16] {
//     let mut raw_array = [0.0; 16];
//     for i in 0..4 {
//         for j in 0..4 {
//             raw_array[i * 4 + j] = matrix[(i, j)];
//         }
//     }
//     raw_array
// }
