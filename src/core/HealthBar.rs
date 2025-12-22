use crate::core::editor::{Point, WindowSize};
use crate::core::SimpleCamera::SimpleCamera as Camera;
use crate::shape_primitives::polygon::{Polygon, Stroke};
use uuid::Uuid;
use std::sync::Arc;

pub struct HealthBar {
    pub background: Polygon,
    pub bar: Polygon,
    pub max_health: f32,
    pub current_health: f32,
    pub width: f32,
    pub height: f32,
}

impl HealthBar {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        model_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        camera: &Camera,
        window_size: &WindowSize,
        position: Point,
        width: f32,
        height: f32,
        max_health: f32,
    ) -> Self {
        let background = Polygon::new(
            window_size,
            device,
            queue,
            model_bind_group_layout,
            group_bind_group_layout,
            camera,
            vec![
                Point { x: 0.0, y: 0.0 },
                Point { x: 1.0, y: 0.0 },
                Point { x: 1.0, y: 1.0 },
                Point { x: 0.0, y: 1.0 },
            ],
            (width, height),
            position,
            (0.0, 0.0, 0.0),
            0.0,
            [0.2, 0.2, 0.2, 1.0], // Dark gray background
            Stroke {
                thickness: 2.0,
                fill: [1.0, 1.0, 1.0, 1.0], // White border
            },
            100, // Layer
            "Health Bar Background".to_string(),
            Uuid::new_v4(),
            Uuid::nil(),
        );

        let bar = Polygon::new(
            window_size,
            device,
            queue,
            model_bind_group_layout,
            group_bind_group_layout,
            camera,
            vec![
                Point { x: 0.0, y: 0.0 },
                Point { x: 1.0, y: 0.0 },
                Point { x: 1.0, y: 1.0 },
                Point { x: 0.0, y: 1.0 },
            ],
            (width, height),
            position,
            (0.0, 0.0, 0.0),
            0.0,
            [1.0, 0.0, 0.0, 1.0], // Red bar
            Stroke {
                thickness: 0.0,
                fill: [0.0, 0.0, 0.0, 0.0],
            },
            101, // Layer (on top)
            "Health Bar".to_string(),
            Uuid::new_v4(),
            Uuid::nil(),
        );

        Self {
            background,
            bar,
            max_health,
            current_health: max_health,
            width,
            height,
        }
    }

    pub fn update_health(&mut self, queue: &wgpu::Queue, health: f32) {
        self.current_health = health.clamp(0.0, self.max_health);
        let percentage = self.current_health / self.max_health;
        
        // Update the bar's scale and position to reflect health
        // The vertices are already scaled by 'width' during Polygon creation.
        // So transform.scale.x = 1.0 means full width.
        
        self.bar.transform.scale.x = percentage;
        
        // The original center was at the same position as the background.
        // We need to shift the bar so it remains left-aligned within the background.
        let original_center_x = self.background.transform.position.x;
        let left_edge = original_center_x - (self.width / 2.0);
        let new_center_x = left_edge + (self.width * percentage / 2.0);
        
        self.bar.transform.position.x = new_center_x;
        self.bar.transform.update_uniform_buffer(queue);
    }
}
