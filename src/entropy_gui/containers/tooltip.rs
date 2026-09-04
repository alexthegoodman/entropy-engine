//! `Response::on_hover_text` — a tiny floating label drawn into the overlay layer.

use crate::entropy_gui::color::Color32;
use crate::entropy_gui::context::Context;
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Rect, StrokeKind};
use crate::entropy_gui::painter::{DrawTarget, Painter};

pub fn show_tooltip(ctx: &Context, anchor_rect: Rect, text: String) {
    let style = ctx.style();
    let font = FontId::proportional(13.0);
    let size = Painter::measure_text(ctx, font, &text);
    let padding = vec2(6.0, 4.0);
    let pos = pos2(anchor_rect.min.x, anchor_rect.max.y + 4.0);
    let rect = Rect::from_min_size(pos, size + padding * 2.0);

    let painter = Painter::new(ctx.clone(), Rect::everything(), DrawTarget::Overlay);
    painter.rect_filled(rect, style.visuals.window_corner_radius, style.visuals.window_fill);
    painter.rect_stroke(rect, style.visuals.window_corner_radius, style.visuals.window_stroke, StrokeKind::Middle);
    painter.text(
        pos2(rect.min.x + padding.x, rect.min.y + padding.y),
        Align2::LEFT_TOP,
        text,
        font,
        style.visuals.override_text_color.unwrap_or(Color32::WHITE),
    );
}
