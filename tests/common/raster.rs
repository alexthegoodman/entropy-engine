//! A small CPU rasterizer for `entropy_gui` draw lists, shared by headless widget tiers via
//! `#[path = "common/raster.rs"] mod raster;`. Triangles with per-vertex colour and glyph-atlas
//! text, composited over an opaque window-grey background and box-filtered down from 2x
//! supersampling. It is the same code `pad_grid_bdd` and `audio_widgets_bdd` carry inline.

#![allow(dead_code)]

use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::draw_list::{DrawCommand, DrawTexture};
use entropy_engine::entropy_gui::geometry::{pos2, vec2, Rect};
use entropy_engine::entropy_gui::{CentralPanel, Context, RawInput};
use image::RgbaImage;

pub const SS: usize = 2;
pub const ATLAS: usize = 1024;

pub struct Harness {
    pub ctx: Context,
    atlas: Vec<[u8; 4]>,
    pub width: usize,
    pub height: usize,
    time_step: f32,
}

impl Harness {
    pub fn new(width: usize, height: usize) -> Self {
        Self { ctx: Context::default(), atlas: vec![[0; 4]; ATLAS * ATLAS], width, height, time_step: 1.0 / 60.0 }
    }

    pub fn run(&mut self, pointer: PointerState, scroll: f32, add: impl FnOnce(&mut entropy_engine::entropy_gui::Ui)) -> Vec<DrawCommand> {
        let raw = RawInput {
            screen_rect: Rect::from_min_size(pos2(0.0, 0.0), vec2(self.width as f32, self.height as f32)),
            pixels_per_point: 1.0,
            pointer,
            scroll_delta: vec2(0.0, scroll),
            dt: self.time_step,
            ..Default::default()
        };
        let out = self.ctx.run(raw, |ctx| {
            CentralPanel::default().show(ctx, |ui| add(ui));
        });
        for (_, delta) in &out.textures_delta.set {
            for row in 0..delta.height as usize {
                for col in 0..delta.width as usize {
                    let s = (row * delta.width as usize + col) * 4;
                    let d = (delta.y as usize + row) * ATLAS + delta.x as usize + col;
                    self.atlas[d] = [delta.rgba[s], delta.rgba[s + 1], delta.rgba[s + 2], delta.rgba[s + 3]];
                }
            }
        }
        self.ctx.tessellate((), 1.0)
    }

    fn glyph(&self, u: f32, v: f32) -> [f32; 4] {
        // Bilinear, texel centres at +0.5.
        let (x, y) = (u * ATLAS as f32 - 0.5, v * ATLAS as f32 - 0.5);
        let (x0, y0) = (x.floor(), y.floor());
        let (fx, fy) = (x - x0, y - y0);
        let at = |xi: f32, yi: f32| {
            let t = self.atlas[(yi.clamp(0.0, ATLAS as f32 - 1.0) as usize) * ATLAS + xi.clamp(0.0, ATLAS as f32 - 1.0) as usize];
            [t[0] as f32 / 255.0, t[1] as f32 / 255.0, t[2] as f32 / 255.0, t[3] as f32 / 255.0]
        };
        let (a, b, c, d) = (at(x0, y0), at(x0 + 1.0, y0), at(x0, y0 + 1.0), at(x0 + 1.0, y0 + 1.0));
        let mut out = [0.0; 4];
        for i in 0..4 {
            out[i] = (a[i] * (1.0 - fx) + b[i] * fx) * (1.0 - fy) + (c[i] * (1.0 - fx) + d[i] * fx) * fy;
        }
        out
    }

    /// Composites `commands` over an opaque window-grey background and box-filters down to 1x.
    pub fn render(&self, commands: &[DrawCommand]) -> RgbaImage {
        let (w, h) = (self.width * SS, self.height * SS);
        let mut buf = vec![[0.09f32, 0.10, 0.12]; w * h];
        for cmd in commands {
            if matches!(cmd.texture, DrawTexture::Native(_)) {
                continue;
            }
            let clip = (
                (cmd.clip_rect.min.x * SS as f32).floor().max(0.0) as usize,
                (cmd.clip_rect.min.y * SS as f32).floor().max(0.0) as usize,
                ((cmd.clip_rect.max.x * SS as f32).ceil() as usize).min(w),
                ((cmd.clip_rect.max.y * SS as f32).ceil() as usize).min(h),
            );
            for tri in cmd.indices.chunks_exact(3) {
                let v = [&cmd.vertices[tri[0] as usize], &cmd.vertices[tri[1] as usize], &cmd.vertices[tri[2] as usize]];
                let p: Vec<(f32, f32)> = v.iter().map(|v| (v.position[0] * SS as f32, v.position[1] * SS as f32)).collect();
                let area = (p[1].0 - p[0].0) * (p[2].1 - p[0].1) - (p[2].0 - p[0].0) * (p[1].1 - p[0].1);
                if area.abs() < 1.0e-6 {
                    continue;
                }
                let x0 = (p.iter().map(|q| q.0).fold(f32::MAX, f32::min).floor().max(clip.0 as f32)) as usize;
                let x1 = (p.iter().map(|q| q.0).fold(f32::MIN, f32::max).ceil().min(clip.2 as f32)) as usize;
                let y0 = (p.iter().map(|q| q.1).fold(f32::MAX, f32::min).floor().max(clip.1 as f32)) as usize;
                let y1 = (p.iter().map(|q| q.1).fold(f32::MIN, f32::max).ceil().min(clip.3 as f32)) as usize;
                for y in y0..y1 {
                    for x in x0..x1 {
                        let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
                        let w0 = ((p[1].0 - px) * (p[2].1 - py) - (p[2].0 - px) * (p[1].1 - py)) / area;
                        let w1 = ((p[2].0 - px) * (p[0].1 - py) - (p[0].0 - px) * (p[2].1 - py)) / area;
                        let w2 = 1.0 - w0 - w1;
                        if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                            continue;
                        }
                        let mut c = [0.0f32; 4];
                        for i in 0..4 {
                            c[i] = v[0].color[i] * w0 + v[1].color[i] * w1 + v[2].color[i] * w2;
                        }
                        if cmd.texture == DrawTexture::Glyph {
                            let u = v[0].tex_coords[0] * w0 + v[1].tex_coords[0] * w1 + v[2].tex_coords[0] * w2;
                            let vv = v[0].tex_coords[1] * w0 + v[1].tex_coords[1] * w1 + v[2].tex_coords[1] * w2;
                            let t = self.glyph(u, vv);
                            for i in 0..4 {
                                c[i] *= t[i];
                            }
                        }
                        let dst = &mut buf[y * w + x];
                        for i in 0..3 {
                            dst[i] = c[i] * c[3] + dst[i] * (1.0 - c[3]);
                        }
                    }
                }
            }
        }
        let mut img = RgbaImage::new(self.width as u32, self.height as u32);
        for y in 0..self.height {
            for x in 0..self.width {
                let mut acc = [0.0f32; 3];
                for sy in 0..SS {
                    for sx in 0..SS {
                        let p = buf[(y * SS + sy) * w + x * SS + sx];
                        for i in 0..3 {
                            acc[i] += p[i];
                        }
                    }
                }
                let n = (SS * SS) as f32;
                img.put_pixel(x as u32, y as u32, image::Rgba([(acc[0] / n * 255.0) as u8, (acc[1] / n * 255.0) as u8, (acc[2] / n * 255.0) as u8, 255]));
            }
        }
        img
    }
}
