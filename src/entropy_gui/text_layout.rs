//! Thin `fontdue::layout::Layout` wrapper shared by labels, text-edit, and any custom-painted
//! text (e.g. the video timeline's ruler ticks). Ports the layout call shape from
//! `src/renderer_text/text_due.rs:405-422` — wrapping already works via fontdue, reused as-is.

use fontdue::layout::{CoordinateSystem, GlyphRasterConfig, Layout, LayoutSettings, TextStyle};

#[derive(Clone, Copy, Debug)]
pub struct ShapedGlyph {
    /// Byte offset of the source character in the input `&str` — used to map a screen
    /// x/y back to a cursor position in text-edit widgets.
    pub byte_offset: usize,
    pub x: f32,
    pub y: f32,
    pub raster_config: GlyphRasterConfig,
}

pub struct ShapedText {
    pub glyphs: Vec<ShapedGlyph>,
    pub width: f32,
    pub height: f32,
}

/// Shapes `text` at `px` size. `max_width` enables word-wrap (fontdue's own wrapping);
/// pass `None` for a single unwrapped line (used by text-edit, which manages line breaks
/// itself rather than relying on automatic wrap-point byte mapping).
pub fn shape_text(font: &fontdue::Font, px: f32, max_width: Option<f32>, text: &str) -> ShapedText {
    let mut layout: Layout<()> = Layout::new(CoordinateSystem::PositiveYDown);
    let settings = LayoutSettings { max_width, ..LayoutSettings::default() };
    layout.reset(&settings);

    let style = TextStyle { text, px, font_index: 0, user_data: () };
    layout.append(&[font], &style);

    let mut glyphs = Vec::with_capacity(layout.glyphs().len());
    let mut max_x: f32 = 0.0;
    for g in layout.glyphs() {
        glyphs.push(ShapedGlyph { byte_offset: g.byte_offset, x: g.x, y: g.y, raster_config: g.key });
        max_x = max_x.max(g.x + g.width as f32);
    }

    ShapedText { glyphs, width: max_x, height: layout.height() }
}
