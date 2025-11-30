use nalgebra::{Matrix4, Rotation3, Vector3};
use wgpu::util::DeviceExt;

use crate::core::Transform_2::{matrix4_to_raw_array, Transform};

#[repr(C)]
#[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct LightUniformData {
    direction: [f32; 3],
    _padding1: f32, // Need padding for alignment
    color: [f32; 3],
    _padding2: f32,
    ambient_intensity: f32,
    time_of_day: f32,
    _padding3: [f32; 2], // Pad to 16-byte alignment
}

pub struct LightState {
    pub transform: Transform,
    pub color: Vector3<f32>,
    pub ambient_intensity: f32,
    pub time_of_day: f32,
    pub uniform_buffer: wgpu::Buffer,
    pub bind_group: wgpu::BindGroup,
}

impl LightState {
    pub fn new(device: &wgpu::Device, bind_group_layout: &wgpu::BindGroupLayout) -> Self {
        let initial_direction = Vector3::new(1.0, -1.0, -1.0).normalize();
        let transform = Transform::new(
            Vector3::zeros(),            // position (not really used for directional light)
            Vector3::new(0.0, 0.0, 0.0), // rotation (will affect light direction)
            Vector3::new(1.0, 1.0, 1.0), // scale (not really used for directional light)
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Light Transform Buffer"),
                contents: bytemuck::cast_slice(&matrix4_to_raw_array(&Matrix4::identity())),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }),
        );

        let uniform_data = LightUniformData {
            direction: initial_direction.into(),
            _padding1: 0.0,
            color: [1.0, 1.0, 1.0], // White light
            _padding2: 0.0,
            ambient_intensity: 0.1,
            time_of_day: 0.2, // Start near sunrise
            _padding3: [0.0; 2],
        };

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Light Uniform Buffer"),
            contents: bytemuck::cast_slice(&[uniform_data]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
            label: Some("Light Bind Group"),
        });

        Self {
            transform,
            color: Vector3::new(1.0, 1.0, 1.0),
            ambient_intensity: 0.1,
            time_of_day: 0.2,
            uniform_buffer,
            bind_group,
        }
    }

    // pub fn tick_day(&self, queue: &wgpu::Queue) {
    //     // Update light position/rotation based on time
    //     let time = std::time::Instant::now()
    //         .duration_since(std::time::UNIX_EPOCH)
    //         .as_secs_f32();

    //     // Rotate light to simulate day/night cycle
    //     // Complete rotation every 24 seconds (for testing - adjust as needed)
    //     let rotation_speed = 2.0 * std::f32::consts::PI / 24.0;
    //     self.transform.rotation.y = time * rotation_speed;

    //     // Update time of day (cycles between 0 and 1)
    //     self.time_of_day = (time % 24.0) / 24.0;

    //     // Update sunrise/sunset colors
    //     let sunrise_color = Vector3::new(1.0, 0.7, 0.4); // Warm orange
    //     let daylight_color = Vector3::new(1.0, 1.0, 1.0); // White
    //     let t = smoothstep(0.15, 0.3, self.time_of_day);
    //     self.color = sunrise_color.lerp(&daylight_color, t);

    //     // Update light uniforms
    //     self.update(queue);
    // }

    pub fn update(&mut self, queue: &wgpu::Queue) {
        // Update transform matrix first (this updates the transform.buffer)
        self.transform.update_uniform_buffer(queue);

        // Get direction from rotation (assuming -Z is forward)
        // let rotation = Rotation3::from_euler_angles(
        //     self.transform.rotation.x,
        //     self.transform.rotation.y,
        //     self.transform.rotation.z,
        // );
        let rotation = self.transform.rotation.to_rotation_matrix();
        let direction = rotation * Vector3::new(0.0, 0.0, -1.0);

        // Update uniform buffer
        let uniform_data = LightUniformData {
            direction: direction.into(),
            _padding1: 0.0,
            color: [self.color.x, self.color.y, self.color.z],
            _padding2: 0.0,
            ambient_intensity: self.ambient_intensity,
            time_of_day: self.time_of_day,
            _padding3: [0.0; 2],
        };

        queue.write_buffer(
            &self.uniform_buffer,
            0,
            bytemuck::cast_slice(&[uniform_data]),
        );
    }
}

// Helper function for smooth interpolation
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
