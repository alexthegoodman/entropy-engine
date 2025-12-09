use mint::RowMatrix4;
use nalgebra::{Matrix4, Perspective3, Point3, Rotation3, Unit, Vector3};

use crate::core::Viewport::Viewport;

pub struct SimpleCamera {
    pub position: Point3<f32>,
    pub direction: Vector3<f32>,
    pub up: Vector3<f32>,
    pub aspect_ratio: f32,
    pub fovy: f32,
    pub znear: f32,
    pub zfar: f32,
    pub view_projection_matrix: Matrix4<f32>,
    pub viewport: Viewport
}

impl SimpleCamera {
    pub fn new(
        position: Point3<f32>,
        direction: Vector3<f32>,
        up: Vector3<f32>,
        // aspect_ratio: f32,
        fovy: f32,
        znear: f32,
        zfar: f32,
        windowWidth: f32, windowHeight: f32
    ) -> Self {
        Self {
            position,
            direction,
            up,
            // aspect_ratio,
            aspect_ratio: 16.0 / 9.0, // default aspect ratio
            fovy,
            znear,
            zfar,
            view_projection_matrix: Matrix4::identity(),
            viewport: Viewport::new(windowWidth, windowHeight)
        }
    }

    pub fn update_aspect_ratio(&mut self, aspect_ratio: f32) {
        self.aspect_ratio = aspect_ratio;
    }

    pub fn get_view(&self) -> Matrix4<f32> {
        let view_matrix =
            Matrix4::look_at_rh(&self.position, &(self.position + self.direction), &self.up);
        view_matrix
    }

    pub fn get_projection(&self) -> Matrix4<f32> {
        let projection_matrix =
            Matrix4::new_perspective(self.aspect_ratio, self.fovy, self.znear, self.zfar);
        projection_matrix
    }

    pub fn update_view_projection_matrix(&mut self) {
        let view_matrix = self.get_view();
        let projection_matrix = self.get_projection();

        self.view_projection_matrix = projection_matrix * view_matrix;
    }

    pub fn update(&mut self) {
        self.update_view_projection_matrix();
    }

    pub fn rotate(&mut self, yaw: f32, pitch: f32) {
        let yaw_rotation = Rotation3::from_axis_angle(&Unit::new_normalize(self.up), yaw);
        let right = self.up.cross(&self.direction).normalize();
        let pitch_rotation = Rotation3::from_axis_angle(&Unit::new_normalize(right), pitch);

        let rotation = yaw_rotation * pitch_rotation;
        self.direction = rotation * self.direction;

        self.update_view_projection_matrix();
    }

    pub fn set_rotation_euler(&mut self, yaw: f32, pitch: f32, roll: f32) {
        // Create rotation from euler angles
        // Note: Generally for FPS cameras we might ignore roll (keep it 0)
        let rotation = Rotation3::from_euler_angles(pitch, yaw, roll);

        // Reset direction vector and apply rotation
        // Assuming forward is -z (typical in graphics)
        self.direction = rotation * Vector3::new(0.0, 0.0, -1.0);

        // Update right vector if you need it
        let right = self.up.cross(&self.direction).normalize();

        self.update_view_projection_matrix();
    }

    // You might also want this helper that only takes yaw and pitch
    pub fn set_rotation_euler_yp(&mut self, yaw: f32, pitch: f32) {
        // Clamp pitch to prevent camera flipping over
        let pitch = pitch.clamp(-std::f32::consts::FRAC_PI_2, std::f32::consts::FRAC_PI_2);

        // Call full euler rotation with roll = 0
        self.set_rotation_euler(yaw, pitch, 0.0);
    }

    pub fn forward_vector(&self) -> Vector3<f32> {
        self.direction.normalize()
    }

    pub fn up_vector(&self) -> Vector3<f32> {
        self.up.normalize()
    }

    pub fn right_vector(&self) -> Vector3<f32> {
        // Right vector is cross product of forward and up
        self.direction.cross(&self.up).normalize()
    }
}

pub fn to_row_major_f64(m: &Matrix4<f32>) -> RowMatrix4<f64> {
    let transposed = m.transpose();
    let data: [f64; 16] = transposed.as_slice()
        .iter()
        .map(|&x| x as f64)
        .collect::<Vec<f64>>()
        .try_into()
        .unwrap();
    RowMatrix4::from(data)
}