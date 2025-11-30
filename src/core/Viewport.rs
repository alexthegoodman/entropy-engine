use crate::core::RendererState::WindowSize;



#[derive(Clone, Copy)]
pub struct Viewport {
    pub width: f32,
    pub height: f32,
    pub window_size: WindowSize,
}

impl Viewport {
    pub fn new(width: f32, height: f32) -> Self {
        Viewport { 
            width, 
            height, 
            window_size: WindowSize {
                width: width as u32,
                height: height as u32
            } 
        }
    }

    pub fn to_ndc(&self, x: f32, y: f32) -> (f32, f32) {
        let ndc_x = (x / self.width) * 2.0 - 1.0;
        let ndc_y = -((y / self.height) * 2.0 - 1.0); // Flip Y-axis
        (ndc_x, ndc_y)
    }
}