//! Color + stroke types, mirroring egui's `Color32`/`Stroke`/`Shadow`.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Color32(pub [u8; 4]);

impl Color32 {
    pub const TRANSPARENT: Color32 = Color32([0, 0, 0, 0]);
    pub const WHITE: Color32 = Color32([255, 255, 255, 255]);
    pub const BLACK: Color32 = Color32([0, 0, 0, 255]);
    pub const GRAY: Color32 = Color32([128, 128, 128, 255]);
    pub const RED: Color32 = Color32([255, 0, 0, 255]);
    pub const GREEN: Color32 = Color32([0, 255, 0, 255]);
    pub const YELLOW: Color32 = Color32([255, 255, 0, 255]);

    pub const fn from_rgb(r: u8, g: u8, b: u8) -> Self {
        Color32([r, g, b, 255])
    }
    pub const fn from_rgba_unmultiplied(r: u8, g: u8, b: u8, a: u8) -> Self {
        Color32([r, g, b, a])
    }
    pub const fn from_rgba_premultiplied(r: u8, g: u8, b: u8, a: u8) -> Self {
        Color32([r, g, b, a])
    }
    pub const fn from_gray(v: u8) -> Self {
        Color32([v, v, v, 255])
    }
    pub const fn from_black_alpha(a: u8) -> Self {
        Color32([0, 0, 0, a])
    }
    pub const fn from_white_alpha(a: u8) -> Self {
        Color32([255, 255, 255, a])
    }

    pub fn linear_multiply(&self, factor: f32) -> Color32 {
        let factor = factor.clamp(0.0, 1.0);
        Color32([self.0[0], self.0[1], self.0[2], (self.0[3] as f32 * factor).round() as u8])
    }

    pub fn r(&self) -> u8 { self.0[0] }
    pub fn g(&self) -> u8 { self.0[1] }
    pub fn b(&self) -> u8 { self.0[2] }
    pub fn a(&self) -> u8 { self.0[3] }

    pub fn to_array_f32(&self) -> [f32; 4] {
        [
            self.0[0] as f32 / 255.0,
            self.0[1] as f32 / 255.0,
            self.0[2] as f32 / 255.0,
            self.0[3] as f32 / 255.0,
        ]
    }

    pub fn to_rgba_unmultiplied(&self) -> [f32; 4] {
        self.to_array_f32()
    }
    pub fn to_rgba_premultiplied(&self) -> [f32; 4] {
        self.to_array_f32()
    }

    pub fn from_rgba_f32(rgba: [f32; 4]) -> Self {
        Color32([
            (rgba[0].clamp(0.0, 1.0) * 255.0).round() as u8,
            (rgba[1].clamp(0.0, 1.0) * 255.0).round() as u8,
            (rgba[2].clamp(0.0, 1.0) * 255.0).round() as u8,
            (rgba[3].clamp(0.0, 1.0) * 255.0).round() as u8,
        ])
    }

    /// Linear-interpolate toward `other` by `t` in [0,1].
    pub fn lerp(&self, other: Color32, t: f32) -> Color32 {
        let t = t.clamp(0.0, 1.0);
        let mut out = [0u8; 4];
        for i in 0..4 {
            out[i] = (self.0[i] as f32 + (other.0[i] as f32 - self.0[i] as f32) * t).round() as u8;
        }
        Color32(out)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Stroke {
    pub width: f32,
    pub color: Color32,
}

impl Stroke {
    pub const NONE: Stroke = Stroke { width: 0.0, color: Color32::TRANSPARENT };

    pub fn new(width: f32, color: Color32) -> Self {
        Self { width, color }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Shadow {
    pub color: Color32,
    pub offset: [i8; 2],
    pub blur: u8,
    pub spread: u8,
}
