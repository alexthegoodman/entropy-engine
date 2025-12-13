use cgmath::{Matrix4, Point3, Vector2, Vector3, Rad, perspective, InnerSpace};

use crate::core::{SimpleCamera::SimpleCamera, editor::{Point, WindowSize, WindowSizeShader, size_to_normal}};

#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub position: Vector2<f32>,
    pub zoom: f32,
    pub window_size: WindowSize,
    pub focus_point: Vector2<f32>, // Center point of the view
                                   // Implied constants:
                                   // direction: Always (0, 0, -1)    // Always looking into screen
                                   // up: Always (0, 1, 0)           // Y is always up
                                   // znear: -1.0                    // Simple z-range for 2D
                                   // zfar: 1.0                      // Simple z-range for 2D
}

impl Camera {
    pub fn new(window_size: WindowSize) -> Self {
        let focus_point = Vector2::new(
            window_size.width as f32 / 2.0,
            window_size.height as f32 / 2.0,
        );

        Self {
            position: Vector2::new(0.0, 0.0),
            zoom: 1.0,
            window_size,
            focus_point,
        }
    }

    // pub fn screen_to_world(&self, screen_pos: Point) -> Point {
    //     Point {
    //         x: (screen_pos.x + self.position.x),
    //         y: (screen_pos.y + self.position.y),
    //     }
    // }

    // pub fn world_to_screen(&self, world_pos: Point) -> Point {
    //     Point {
    //         x: (world_pos.x - self.position.x),
    //         y: (world_pos.y - self.position.y),
    //     }
    // }

    // pub fn ds_ndc_to_top_left(&self, ds_ndc_pos: Point) -> Point {
    //     let aspect_ratio = self.window_size.width as f32 / self.window_size.height as f32;
    //     let pos_x = ds_ndc_pos.x / self.window_size.width as f32;
    //     let pos_y = ds_ndc_pos.y / self.window_size.height as f32;

    //     let (x, y) = self.ndc_to_normalized(pos_x, pos_y);

    //     let x = (x * self.window_size.width as f32) + 65.0;
    //     let y = y * self.window_size.height as f32;

    //     Point { x, y }
    // }

    // pub fn ndc_to_top_left(&self, ds_ndc_pos: Point) -> Point {
    //     let aspect_ratio = self.window_size.width as f32 / self.window_size.height as f32;

    //     let (x, y) = self.ndc_to_normalized(ds_ndc_pos.x, ds_ndc_pos.y);

    //     let x = (x * self.window_size.width as f32);
    //     let y = y * self.window_size.height as f32;

    //     Point { x, y }
    // }

    // pub fn ndc_to_normalized(&self, ndc_x: f32, ndc_y: f32) -> (f32, f32) {
    //     // Convert from [-1, 1] to [0, 1]
    //     let norm_x = (ndc_x + 1.0) / 2.0;
    //     // Flip Y and convert from [-1, 1] to [0, 1]
    //     let norm_y = (-ndc_y + 1.0) / 2.0;

    //     (norm_x, norm_y)
    // }

    // And its inverse if you need it
    // pub fn normalized_to_ndc(&self, norm_x: f32, norm_y: f32) -> (f32, f32) {
    //     // Convert from [0, 1] to [-1, 1]
    //     let ndc_x = (norm_x * 2.0) - 1.0;
    //     // Convert from [0, 1] to [-1, 1] and flip Y
    //     let ndc_y = -((norm_y * 2.0) - 1.0);

    //     (ndc_x, ndc_y)
    // }

    pub fn get_view_projection_matrix(&self) -> Matrix4<f32> {
        let projection = self.get_projection();

        let view = self.get_view();

        let vp = projection * view;

        vp
    }

    pub fn get_projection(&self) -> Matrix4<f32> {
        let zoom_factor = self.zoom;
        let aspect_ratio = self.window_size.width as f32 / self.window_size.height as f32;

        let left = -1.0;
        let right = 1.0;
        let top = 1.0;
        let bottom = -1.0;
        let dx = (right - left) / (2.0 * zoom_factor);
        let dy = (top - bottom) / (2.0 * zoom_factor);
        let cx = (right + left) / 2.0;
        let cy = (top + bottom) / 2.0;

        let left = cx - dx;
        let right = cx + dx;
        let top = cy + dy;
        let bottom = cy - dy;

        // cgmath::ortho(
        //     -(zoom_factor * aspect_ratio) / 2.0, // left
        //     (zoom_factor * aspect_ratio) / 2.0,  // right
        //     -zoom_factor,                        // bottom
        //     zoom_factor,                         // top
        //     -100.0,                              // near
        //     100.0,                               // far
        // )
        cgmath::ortho(
            left,   // left
            right,  // right
            bottom, // bottom
            top,    // top
            -100.0, // near
            100.0,  // far
        )
    }

    // pub fn get_projection(&self) -> Matrix4<f32> {
    //     let zoom_factor = self.zoom;
    //     let aspect_ratio = self.window_size.width as f32 / self.window_size.height as f32;

    //     // Projection matrix now only scales to scene bounds, not NDC
    //     Matrix4::from_nonuniform_scale(zoom_factor * aspect_ratio, zoom_factor, 1.0)
    // }

    pub fn get_view(&self) -> Matrix4<f32> {
        // | 1  0  0  0 |
        // | 0  1  0  0 |
        // | 0  0  1  0 |
        // |-x -y  0  1 |

        // creates illusion of camera movement by shifting matrix based on position (default test_norm is 0,0)
        let test_norm = size_to_normal(&self.window_size, self.position.x, self.position.y);
        let view = Matrix4::new(
            // self.zoom,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            // self.zoom,
            1.0,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            -test_norm.0,
            -test_norm.1,
            0.0,
            1.0,
        );

        view
    }

    pub fn pan(&mut self, delta: Vector2<f32>) {
        // println!("delta {:?} {:?}", delta, self.position);
        self.position += delta;
    }

    // pub fn zoom(&mut self, factor: f32, center: Point) {
    //     // let world_center = self.screen_to_world(center);
    //     let world_center = center;

    //     // For zoom in/out to be reversible, we need multiplicative inverses
    //     // e.g., zooming by 0.9 then by 1/0.9 should restore original state
    //     let zoom_factor = if factor > 0.0 {
    //         1.0 + factor
    //     } else {
    //         1.0 / (1.0 - factor)
    //     };

    //     println!("zoom {:?} {:?}", self.zoom, zoom_factor);

    //     let old_zoom = self.zoom;
    //     self.zoom = (self.zoom * zoom_factor).clamp(-10.0, 10.0);

    //     // Keep the point under cursor stationary
    //     // let world_pos = Vector2::new(world_center.x, world_center.y);
    //     // self.position = world_pos + (self.position - world_pos) * (old_zoom / self.zoom);
    // }

    pub fn zoom(&mut self, delta: f32, center: Point) {
        self.zoom = self.zoom + delta;
        println!("new zoom: {:?} delta: {:?}", self.zoom, delta);
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Camera3D {
    pub position: Vector3<f32>,
    pub target: Vector3<f32>,
    pub up: Vector3<f32>,
    pub fovy: Rad<f32>,
    pub aspect: f32,
    pub znear: f32,
    pub zfar: f32,
    pub window_size: WindowSize,
}

impl Camera3D {
    pub fn new(window_size: WindowSize) -> Self {
        Self {
            // position: Vector3::new(0.0, 0.0, 0.1),
            position: Vector3::new(0.0, 0.0, 2.6),
            target: Vector3::new(0.0, 0.0, 0.0),
            up: Vector3::new(0.0, 1.0, 0.0),
            fovy: Rad(std::f32::consts::FRAC_PI_4),
            // fovy: Rad(std::f32::consts::FRAC_PI_6),
            // fovy: Rad::from(Deg(60.0)),
            // aspect: window_size.width as f32 / window_size.height as f32, // causes distortation, maybe wouldn't with right combo
            aspect: 1.0,
            znear: 0.1,
            zfar: 1000.0,
            window_size,
        }
    }

    pub fn get_view_projection_matrix(&self) -> Matrix4<f32> {
        let projection = self.get_projection();
        let view = self.get_view();
        projection * view
    }

    pub fn get_projection(&self) -> Matrix4<f32> {
        perspective(self.fovy, self.aspect, self.znear, self.zfar)
    }

    pub fn get_view(&self) -> Matrix4<f32> {
        cgmath::Matrix4::look_at_rh(
            Point3::new(self.position.x, self.position.y, self.position.z),
            Point3::new(self.target.x, self.target.y, self.target.z),
            self.up,
        )
    }

    pub fn pan(&mut self, delta: Vector2<f32>) {
        let right = (self.target - self.position).cross(self.up).normalize();
        let up = right.cross(self.target - self.position).normalize();
        
        let movement = right * delta.x + up * delta.y;
        self.position += movement;
        self.target += movement;
    }

    pub fn zoom(&mut self, delta: f32, _center: Point) {
        let direction = (self.target - self.position).normalize();
        self.position += direction * delta;
    }

    pub fn orbit(&mut self, yaw_delta: f32, pitch_delta: f32) {
        let radius = (self.position - self.target).magnitude();
        let current_dir = (self.position - self.target).normalize();
        
        // Calculate current spherical coordinates
        let current_yaw = current_dir.z.atan2(current_dir.x);
        let current_pitch = current_dir.y.asin();
        
        // Apply deltas
        let new_yaw = current_yaw + yaw_delta;
        let new_pitch = (current_pitch + pitch_delta).clamp(-std::f32::consts::FRAC_PI_2 + 0.01, std::f32::consts::FRAC_PI_2 - 0.01);
        
        // Convert back to cartesian
        let new_dir = Vector3::new(
            new_pitch.cos() * new_yaw.cos(),
            new_pitch.sin(),
            new_pitch.cos() * new_yaw.sin(),
        );
        
        self.position = self.target + new_dir * radius;
    }

    pub fn set_aspect_ratio(&mut self, aspect: f32) {
        self.aspect = aspect;
    }

    // pub fn birds_eye_zoom_on_point(&mut self, point_x: f32, point_y: f32, zoom_level: f32) {
    //     // Set target to the point we want to focus on (content is around z=-2.5)
    //     self.target = Vector3::new(point_x, point_y, -2.5);
        
    //     // Position camera above znear (0.1) but close enough to see content
    //     // Higher zoom_level = closer = more zoomed in
    //     let base_distance = 10.0; // Safe distance from znear
    //     let distance = base_distance / zoom_level.max(0.1); // Prevent division by zero
        
    //     self.position = Vector3::new(point_x, point_y, distance);
        
    //     // Ensure we're looking straight down
    //     self.up = Vector3::new(0.0, 1.0, 0.0);
    // }
    pub fn birds_eye_zoom_on_point(&mut self, point_x: f32, point_y: f32, zoom_level: f32) {
        self.target = Vector3::new(point_x, point_y, 0.0);
        // Closer distance = more zoomed in
        // let zoom_level = get_z_layer(zoom_level); // zoom_level > 1 = closer
        self.position = Vector3::new(point_x, point_y, zoom_level);
    }
}

use bytemuck::{Pod, Zeroable};
use cgmath::SquareMatrix;

#[repr(C)]
#[derive(Debug, Copy, Clone, Pod, Zeroable)]
pub struct CameraUniform {
    view_proj: [[f32; 4]; 4],
    view_pos: [f32; 4],
    window_size: WindowSizeShader
}

impl CameraUniform {
    pub fn new() -> Self {
        Self {
            view_proj: Matrix4::identity().into(),
            view_pos: [0.0; 4],
            window_size: WindowSizeShader { width: 1.0, height: 1.0 }
        }
    }

    pub fn update_view_proj(&mut self, camera: &Camera) {
        self.view_proj = camera.get_view_projection_matrix().into();
    }

    // pub fn update_view_proj_3d(&mut self, camera: &Camera3D) {
    //     self.view_proj = camera.get_view_projection_matrix().into();
    // }

    pub fn update_view_proj_3d(&mut self, camera: &SimpleCamera) {
        self.view_proj = camera.view_projection_matrix.into();
        self.view_pos = camera.position.to_homogeneous().into();
        self.window_size = WindowSizeShader { width: camera.viewport.width, height: camera.viewport.height }
    }
}

pub struct CameraBinding {
    pub buffer: wgpu::Buffer,
    pub bind_group: wgpu::BindGroup,
    pub bind_group_layout: wgpu::BindGroupLayout,
    pub uniform: CameraUniform,
}

impl CameraBinding {
    pub fn new(device: &wgpu::Device) -> Self {
        let uniform = CameraUniform::new();

        // Create the uniform buffer
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Camera Uniform Buffer"),
            size: std::mem::size_of::<CameraUniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // Create bind group layout
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Camera Bind Group Layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: Some(
                        std::num::NonZeroU64::new(std::mem::size_of::<CameraUniform>() as u64)
                            .unwrap(),
                    ),
                },
                count: None,
            }],
        });

        // Create bind group
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Camera Bind Group"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: buffer.as_entire_binding(),
            }],
        });

        Self {
            buffer,
            bind_group,
            bind_group_layout,
            uniform,
        }
    }

    pub fn update(&mut self, queue: &wgpu::Queue, camera: &Camera) {
        self.uniform.update_view_proj(camera);
        queue.write_buffer(
            &self.buffer,
            0,
            bytemuck::cast_slice(&[self.uniform]),
        );
    }

    pub fn update_3d(&mut self, queue: &wgpu::Queue, camera: &SimpleCamera) {
        self.uniform.update_view_proj_3d(camera);
        queue.write_buffer(
            &self.buffer,
            0,
            bytemuck::cast_slice(&[self.uniform]),
        );
    }
}