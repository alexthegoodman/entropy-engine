//! Low-level immediate drawing — the API `src/core/video_timeline_ui.rs` and the JS-addon
//! `MiniMap`/`PianoRoll` widgets are built entirely out of.

use crate::core::vertex::Vertex;
use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::context::{Context, ContextInner};
use crate::entropy_gui::draw_list::{DrawTexture, TextureId};
use crate::entropy_gui::geometry::{Align2, CornerRadius, FontId, Pos2, Rect, StrokeKind};
use crate::entropy_gui::shape::{self, Shape};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum DrawTarget {
    Main,
    Overlay,
}

#[derive(Clone)]
pub struct Painter {
    pub(crate) ctx: Context,
    pub(crate) clip_rect: Rect,
    pub(crate) target: DrawTarget,
}

impl Painter {
    pub(crate) fn new(ctx: Context, clip_rect: Rect, target: DrawTarget) -> Self {
        Self { ctx, clip_rect, target }
    }

    pub fn clip_rect(&self) -> Rect {
        self.clip_rect
    }

    pub fn with_clip_rect(&self, clip_rect: Rect) -> Painter {
        Painter { ctx: self.ctx.clone(), clip_rect: self.clip_rect.intersect(clip_rect), target: self.target }
    }

    fn push(&self, texture: DrawTexture, vertices: Vec<Vertex>, indices: Vec<u32>) {
        if vertices.is_empty() || indices.is_empty() {
            return;
        }
        let mut inner = self.ctx.inner_mut();
        let list = match self.target {
            DrawTarget::Main => &mut inner.draw_list,
            DrawTarget::Overlay => &mut inner.overlay_draw_list,
        };
        list.push(self.clip_rect, texture, vertices, indices);
    }

    pub fn rect_filled(&self, rect: Rect, corner_radius: impl Into<CornerRadius>, fill: Color32) {
        let (v, i) = shape::tessellate_rect(rect, corner_radius.into(), fill, Stroke::NONE);
        self.push(DrawTexture::White, v, i);
    }

    /// An axis-aligned rect with an independent color per corner, bilinearly interpolated
    /// across the quad by the renderer — used for soft animated backdrops (see
    /// `core::gradient_backdrop`). No rounding/stroke support; layer a plain `rect_filled`
    /// on top if a hard edge is needed.
    pub fn rect_filled_gradient(&self, rect: Rect, top_left: Color32, top_right: Color32, bottom_left: Color32, bottom_right: Color32) {
        let verts = vec![
            Vertex { position: [rect.min.x, rect.min.y, 0.0], normal: [0.0; 3], tex_coords: [0.0, 0.0], color: top_left.to_array_f32() },
            Vertex { position: [rect.max.x, rect.min.y, 0.0], normal: [0.0; 3], tex_coords: [1.0, 0.0], color: top_right.to_array_f32() },
            Vertex { position: [rect.max.x, rect.max.y, 0.0], normal: [0.0; 3], tex_coords: [1.0, 1.0], color: bottom_right.to_array_f32() },
            Vertex { position: [rect.min.x, rect.max.y, 0.0], normal: [0.0; 3], tex_coords: [0.0, 1.0], color: bottom_left.to_array_f32() },
        ];
        let idx = vec![0, 1, 2, 0, 2, 3];
        self.push(DrawTexture::White, verts, idx);
    }

    pub fn rect_stroke(&self, rect: Rect, corner_radius: impl Into<CornerRadius>, stroke: Stroke, _kind: StrokeKind) {
        let (v, i) = shape::tessellate_rect(rect, corner_radius.into(), Color32::TRANSPARENT, stroke);
        self.push(DrawTexture::White, v, i);
    }

    pub fn line_segment(&self, points: [Pos2; 2], stroke: Stroke) {
        let (v, i) = shape::tessellate_line(&points, stroke);
        self.push(DrawTexture::White, v, i);
    }

    pub fn circle_filled(&self, center: Pos2, radius: f32, fill: Color32) {
        let (v, i) = shape::tessellate_circle(center, radius, fill, Stroke::NONE);
        self.push(DrawTexture::White, v, i);
    }

    pub fn circle_stroke(&self, center: Pos2, radius: f32, stroke: Stroke) {
        let (v, i) = shape::tessellate_circle(center, radius, Color32::TRANSPARENT, stroke);
        self.push(DrawTexture::White, v, i);
    }

    pub fn add(&self, shape: Shape) {
        let (v, i) = shape::tessellate_shape(&shape);
        self.push(DrawTexture::White, v, i);
    }

    /// A rounded version of `image` — samples `texture_id` into a rounded-rect mesh
    /// instead of a plain quad. Used for glass backdrop blur, where the blurred image and
    /// a translucent tint (a plain `rect_filled` layered on top, same `corner_radius`)
    /// need matching rounded silhouettes.
    pub fn image_rounded(&self, texture_id: TextureId, rect: Rect, corner_radius: impl Into<CornerRadius>, uv: Rect, tint: Color32) {
        let (v, i) = shape::tessellate_rounded_rect_textured(rect, corner_radius.into().as_f32(), uv, tint);
        self.push(DrawTexture::Native(texture_id), v, i);
    }

    pub fn image(&self, texture_id: TextureId, rect: Rect, uv: Rect, tint: Color32) {
        let c = tint.to_array_f32();
        let verts = vec![
            Vertex { position: [rect.min.x, rect.min.y, 0.0], normal: [0.0; 3], tex_coords: [uv.min.x, uv.min.y], color: c },
            Vertex { position: [rect.max.x, rect.min.y, 0.0], normal: [0.0; 3], tex_coords: [uv.max.x, uv.min.y], color: c },
            Vertex { position: [rect.max.x, rect.max.y, 0.0], normal: [0.0; 3], tex_coords: [uv.max.x, uv.max.y], color: c },
            Vertex { position: [rect.min.x, rect.max.y, 0.0], normal: [0.0; 3], tex_coords: [uv.min.x, uv.max.y], color: c },
        ];
        let idx = vec![0, 1, 2, 0, 2, 3];
        self.push(DrawTexture::Native(texture_id), verts, idx);
    }

    /// Draws `text` with its `align` anchor at `pos`. Returns the tight bounding rect
    /// (egui's painter.text returns a galley rect too, used e.g. for hover-box sizing).
    pub fn text(&self, pos: Pos2, align: Align2, text: impl ToString, font_id: FontId, color: Color32) -> Rect {
        let text = text.to_string();
        let mut guard = self.ctx.inner_mut();
        let ContextInner { fonts, atlas, draw_list, overlay_draw_list, .. } = &mut *guard;
        let face_set = fonts.shaping_set(font_id.family);

        let shaped = crate::entropy_gui::text_layout::shape_text(face_set, font_id.size, None, &text);
        let (ox, oy) = match align {
            Align2::LEFT_TOP => (pos.x, pos.y),
            Align2::LEFT_CENTER => (pos.x, pos.y - shaped.height / 2.0),
            Align2::CENTER_CENTER => (pos.x - shaped.width / 2.0, pos.y - shaped.height / 2.0),
            _ => (pos.x, pos.y),
        };

        let mut vertices = Vec::with_capacity(shaped.glyphs.len() * 4);
        let mut indices = Vec::with_capacity(shaped.glyphs.len() * 6);
        let c = color.to_array_f32();
        for g in &shaped.glyphs {
            let font = face_set[g.font_index as usize];
            let cached = atlas.get_or_rasterize(font, g.raster_config);
            if cached.width <= 0.0 || cached.height <= 0.0 {
                continue;
            }
            let x0 = ox + g.x;
            let y0 = oy + g.y;
            let x1 = x0 + cached.width;
            let y1 = y0 + cached.height;
            let (u0, v0) = cached.uv_min;
            let (uw, vh) = cached.uv_size;
            let base = vertices.len() as u32;
            vertices.extend_from_slice(&[
                Vertex { position: [x0, y0, 0.0], normal: [0.0; 3], tex_coords: [u0, v0], color: c },
                Vertex { position: [x1, y0, 0.0], normal: [0.0; 3], tex_coords: [u0 + uw, v0], color: c },
                Vertex { position: [x1, y1, 0.0], normal: [0.0; 3], tex_coords: [u0 + uw, v0 + vh], color: c },
                Vertex { position: [x0, y1, 0.0], normal: [0.0; 3], tex_coords: [u0, v0 + vh], color: c },
            ]);
            indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
        }

        let list = match self.target {
            DrawTarget::Main => &mut *draw_list,
            DrawTarget::Overlay => &mut *overlay_draw_list,
        };
        list.push(self.clip_rect, DrawTexture::Glyph, vertices, indices);

        Rect::from_min_size(crate::entropy_gui::geometry::pos2(ox, oy), crate::entropy_gui::geometry::vec2(shaped.width, shaped.height))
    }

    /// Measures `text` without drawing it (used by widgets to size their allocated rect
    /// before painting, e.g. buttons/labels).
    pub fn measure_text(ctx: &Context, font_id: FontId, text: &str) -> crate::entropy_gui::geometry::Vec2 {
        let mut guard = ctx.inner_mut();
        let ContextInner { fonts, .. } = &mut *guard;
        let face_set = fonts.shaping_set(font_id.family);
        let shaped = crate::entropy_gui::text_layout::shape_text(face_set, font_id.size, None, text);
        crate::entropy_gui::geometry::vec2(shaped.width, shaped.height.max(font_id.size))
    }
}
