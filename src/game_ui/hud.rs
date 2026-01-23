use crate::core::editor::{Point, WindowSize};
use crate::core::SimpleCamera::SimpleCamera as Camera;
use crate::shape_primitives::polygon::{Polygon, Stroke};
use crate::renderer_text::text_due::{TextRenderer, TextRendererConfig};
use uuid::Uuid;
use std::sync::Arc;

pub struct Crosshair {
    pub vertical: Polygon,
    pub horizontal: Polygon,
}

impl Crosshair {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        ui_model_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        camera: &Camera,
        window_size: &WindowSize,
    ) -> Self {
        let center_x = window_size.width as f32 / 2.0;
        let center_y = window_size.height as f32 / 2.0;
        let size = 20.0;
        let thickness = 2.0;
        
        let vertical = Polygon::new(
            window_size,
            device,
            queue,
            ui_model_bind_group_layout,
            group_bind_group_layout,
            camera,
            vec![Point{x:0.0, y:0.0}, Point{x:1.0, y:0.0}, Point{x:1.0, y:1.0}, Point{x:0.0, y:1.0}],
            (thickness, size),
            Point { x: center_x, y: center_y },
            (0.0, 0.0, 0.0),
            0.0,
            [1.0, 1.0, 1.0, 0.8],
            Stroke { thickness: 0.0, fill: [0.0, 0.0, 0.0, 0.0] },
            100,
            "Crosshair Vertical".to_string(),
            Uuid::new_v4(),
            Uuid::nil(),
        );

        let horizontal = Polygon::new(
            window_size,
            device,
            queue,
            ui_model_bind_group_layout,
            group_bind_group_layout,
            camera,
            vec![Point{x:0.0, y:0.0}, Point{x:1.0, y:0.0}, Point{x:1.0, y:1.0}, Point{x:0.0, y:1.0}],
            (size, thickness),
            Point { x: center_x, y: center_y },
            (0.0, 0.0, 0.0),
            0.0,
            [1.0, 1.0, 1.0, 0.8],
            Stroke { thickness: 0.0, fill: [0.0, 0.0, 0.0, 0.0] },
            100,
            "Crosshair Horizontal".to_string(),
            Uuid::new_v4(),
            Uuid::nil(),
        );

        Self {
            vertical,
            horizontal,
        }
    }

    pub fn render(&self, device: &wgpu::Device, queue: &wgpu::Queue, render_pass: &mut wgpu::RenderPass) {
        // Since Polygon manages its own bind groups and buffers, we need to call its render-like setup
        // But Polygon doesn't have a simple render method that takes a pass.
        // It seems pipeline.rs iterates over polygons and renders them.
        // So we should expose these polygons to the pipeline or copy the render logic.
        
        // Let's assume we call update_uniform_buffer and then manual set_bind_group like in pipeline.rs
        // Or we add these polygons to the editor's ui_polygons list?
        // If we add them to editor.ui_polygons, they are rendered automatically.
        // But we want to toggle them or manage them separately.
    }

    pub fn resize(&mut self, queue: &wgpu::Queue, window_size: &WindowSize) {
        let center_x = window_size.width as f32 / 2.0;
        let center_y = window_size.height as f32 / 2.0;

        self.vertical.transform.update_position([center_x, center_y, 0.0]);
        self.vertical.transform.update_uniform_buffer(queue);

        self.horizontal.transform.update_position([center_x, center_y, 0.0]);
        self.horizontal.transform.update_uniform_buffer(queue);
    }
}

pub struct AmmoDisplay {
    pub text_renderer: TextRenderer,
    pub last_ammo: i32,
}

impl AmmoDisplay {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        ui_model_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        camera: &Camera,
        window_size: &WindowSize,
        font_data: &[u8],
    ) -> Self {
        let config = TextRendererConfig {
            id: Uuid::new_v4(),
            name: "Ammo Display".to_string(),
            text: "Ammo: --".to_string(),
            font_family: "Basic".to_string(),
            font_size: 32,
            dimensions: (300.0, 50.0),
            position: Point { x: window_size.width as f32 - 250.0, y: window_size.height as f32 - 100.0 },
            layer: 201,
            color: [255, 255, 255, 255],
            background_fill: [0, 0, 0, 0],
        };

        let text_renderer = TextRenderer::new(
            device,
            queue,
            ui_model_bind_group_layout,
            group_bind_group_layout,
            font_data,
            window_size,
            "Ammo: --".to_string(),
            config,
            Uuid::new_v4(),
            Uuid::nil(),
            camera
        );

        Self {
            text_renderer,
            last_ammo: -1,
        }
    }

    pub fn update(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, ammo: Option<u32>, max_ammo: Option<u32>) {
        let current_val = ammo.map(|a| a as i32).unwrap_or(-1);
        
        if current_val != self.last_ammo {
            self.last_ammo = current_val;
            
            let text = if let Some(a) = ammo {
                if let Some(m) = max_ammo {
                    format!("Ammo: {} / {}", a, m)
                } else {
                    format!("Ammo: {}", a)
                }
            } else {
                "Ammo: --".to_string()
            };
            
            self.text_renderer.update_text(device, queue, text);
        }
    }

    pub fn resize(&mut self, queue: &wgpu::Queue, window_size: &WindowSize) {
        let new_position = Point { x: window_size.width as f32 - 250.0, y: window_size.height as f32 - 100.0 };
        self.text_renderer.transform.update_position([new_position.x, new_position.y, 0.0]);
    }
}
