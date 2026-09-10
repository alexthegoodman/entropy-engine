use mint::RowMatrix4;
use nalgebra::{Matrix4, Perspective3, Point3, Rotation3, Unit, Vector3};

use crate::core::Viewport::Viewport;

pub struct SimpleCamera {
    pub position: Point3<f32>,
    pub direction: Vector3<f32>,
    pub up: Vector3<f32>,
    pub aspect_ratio: f32,
    pub fovy: f32,
    pub base_fovy: f32,
    pub znear: f32,
    pub zfar: f32,
    pub view_projection_matrix: Matrix4<f32>,
    pub inverse_view_matrix: Matrix4<f32>,
    pub inverse_projection_matrix: Matrix4<f32>,
    pub viewport: Viewport,
    /// When true, `get_active_projection` (and thus every frame's view-projection matrix)
    /// uses `get_orthographic_projection` instead of the default perspective projection.
    pub is_orthographic: bool,
    /// World-space height of the orthographic view volume, centered on `position` - the
    /// width is derived from this and `aspect_ratio`. Unused in perspective mode.
    pub ortho_view_height: f32,
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
            base_fovy: fovy,
            znear,
            zfar,
            view_projection_matrix: Matrix4::identity(),
            inverse_view_matrix: Matrix4::identity(),
            inverse_projection_matrix: Matrix4::identity(),
            viewport: Viewport::new(windowWidth, windowHeight),
            is_orthographic: false,
            ortho_view_height: 10.0,
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

    /// World-space orthographic projection centered on `position.x/y`, sized by
    /// `ortho_view_height` (world units, full height) and `aspect_ratio`. Unlike the
    /// perspective projection, apparent sprite size is constant regardless of distance
    /// from screen center - the point of using this for a 2D game.
    pub fn get_orthographic_projection(&self) -> Matrix4<f32> {
        let half_height = self.ortho_view_height / 2.0;
        let half_width = half_height * self.aspect_ratio;

        let left = self.position.x - half_width;
        let right = self.position.x + half_width;
        let bottom = self.position.y - half_height;
        let top = self.position.y + half_height;
        let near = -100.0;
        let far = 100.0;

        Matrix4::new_orthographic(left, right, bottom, top, near, far)
    }

    /// The projection matrix actually used for rendering this frame - perspective unless
    /// `is_orthographic` is set. Call sites that previously called `get_projection()`
    /// directly (view-projection matrix, addon `camera_proj` snapshot) should use this
    /// instead so orthographic mode applies everywhere consistently.
    pub fn get_active_projection(&self) -> Matrix4<f32> {
        if self.is_orthographic {
            self.get_orthographic_projection()
        } else {
            self.get_projection()
        }
    }

    pub fn update_view_projection_matrix(&mut self) {
        let view_matrix = self.get_view();
        let projection_matrix = self.get_active_projection();

        self.view_projection_matrix = projection_matrix * view_matrix;
        self.inverse_view_matrix = view_matrix
            .try_inverse()
            .expect("Could not invert view matrix!");
        self.inverse_projection_matrix = projection_matrix
            .try_inverse()
            .expect("Could not invert projection matrix!");
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