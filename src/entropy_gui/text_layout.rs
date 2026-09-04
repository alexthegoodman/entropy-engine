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
    /// Index into the 3-face `fonts` slice `shape_text` was called with — which face this
    /// glyph was actually shaped (and must be rasterized) against. Almost always 0 (the
    /// requested text face); 1/2 mark a character that face had no glyph for and that fell
    /// back to the emoji/symbol face instead (see `FontRegistry::resolve_for_char`).
    pub font_index: u8,
}

pub struct ShapedText {
    pub glyphs: Vec<ShapedGlyph>,
    pub width: f32,
    pub height: f32,
}

/// Shapes `text` at `px` size against a 3-face set: `fonts[0]` is the requested text face,
/// `fonts[1]`/`fonts[2]` are icon fallbacks (see `FontRegistry::shaping_set`). Each character
/// is shaped against the first face in that order that actually has a glyph for it, so a
/// label mixing ordinary text with an emoji/symbol icon renders both correctly in one call.
/// `max_width` enables word-wrap (fontdue's own wrapping); pass `None` for a single unwrapped
/// line (used by text-edit, which manages line breaks itself rather than relying on
/// automatic wrap-point byte mapping).
pub fn shape_text(fonts: [&fontdue::Font; 3], px: f32, max_width: Option<f32>, text: &str) -> ShapedText {
    let mut layout: Layout<()> = Layout::new(CoordinateSystem::PositiveYDown);
    let settings = LayoutSettings { max_width, ..LayoutSettings::default() };
    layout.reset(&settings);

    // Split `text` into runs of consecutive characters that resolve to the same face, and
    // shape each run in turn — `Layout::append` continues laying out from where the previous
    // append left off, so multiple appends into the same `Layout` behave as one continuous run
    // of styled text (this is exactly what it's for).
    let mut run_start = 0usize;
    let mut run_font_index: Option<u8> = None;
    let char_indices: Vec<(usize, char)> = text.char_indices().collect();
    for (pos, &(byte_idx, ch)) in char_indices.iter().enumerate() {
        let font_index = resolve_font_index(fonts, ch);
        match run_font_index {
            None => run_font_index = Some(font_index),
            Some(current) if current != font_index => {
                let run_end = byte_idx;
                append_run(&mut layout, fonts, px, &text[run_start..run_end], current);
                run_start = run_end;
                run_font_index = Some(font_index);
            }
            _ => {}
        }
        if pos == char_indices.len() - 1 {
            if let Some(current) = run_font_index {
                append_run(&mut layout, fonts, px, &text[run_start..], current);
            }
        }
    }
    if char_indices.is_empty() {
        // Nothing to shape, but `Layout::append` still needs a call for line-height metrics.
        append_run(&mut layout, fonts, px, "", 0);
    }

    let mut glyphs = Vec::with_capacity(layout.glyphs().len());
    let mut max_x: f32 = 0.0;
    for g in layout.glyphs() {
        glyphs.push(ShapedGlyph { byte_offset: g.byte_offset, x: g.x, y: g.y, raster_config: g.key, font_index: g.font_index as u8 });
        max_x = max_x.max(g.x + g.width as f32);
    }

    ShapedText { glyphs, width: max_x, height: layout.height() }
}

fn resolve_font_index(fonts: [&fontdue::Font; 3], ch: char) -> u8 {
    if fonts[0].lookup_glyph_index(ch) != 0 {
        return 0;
    }
    if fonts[1].lookup_glyph_index(ch) != 0 {
        return 1;
    }
    if fonts[2].lookup_glyph_index(ch) != 0 {
        return 2;
    }
    0
}

fn append_run(layout: &mut Layout<()>, fonts: [&fontdue::Font; 3], px: f32, text: &str, font_index: u8) {
    let style = TextStyle { text, px, font_index: font_index as usize, user_data: () };
    layout.append(&fonts, &style);
}
