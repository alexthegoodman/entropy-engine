//! Plain multiline text edit with a line-number gutter — replaces
//! `egui_code_editor::CodeEditor` (see the plan's decision on deferred widgets). No syntax
//! highlighting yet: once panels/docking run on `entropy_gui::Ui`, the real widget (which
//! needs a real `&mut egui::Ui`) can no longer be invoked in place without a whole separate
//! offscreen-egui bridge, so this is a deliberately simple functional stand-in. A real
//! highlighter is a natural, isolated follow-up.

use crate::entropy_gui::color::Color32;
use crate::entropy_gui::geometry::{pos2, vec2, Align, Align2, Layout, Rect};
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Response;
use crate::entropy_gui::style::DEFAULT_FONT_SIZE;
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::FontId;

pub fn code_editor(ui: &mut Ui, content: &mut String) -> Response {
    let line_count = content.split('\n').count().max(1);
    let font = FontId::monospace(DEFAULT_FONT_SIZE);
    let digit_w = Painter::measure_text(ui.ctx(), font, "0").x.max(7.0);
    let gutter_w = digit_w * (line_count.to_string().len() as f32 + 1.0) + 10.0;

    let region = ui.available_rect_before_wrap();
    let gutter_rect = Rect::from_min_size(region.min, vec2(gutter_w, region.height()));

    let visuals = ui.visuals();
    let painter = ui.painter();
    painter.rect_filled(gutter_rect, 0u8, visuals.extreme_bg_color);

    let line_h = font.size + 4.0;
    for i in 0..line_count {
        let label = (i + 1).to_string();
        let w = Painter::measure_text(ui.ctx(), font, &label).x;
        painter.text(pos2(gutter_rect.max.x - 6.0 - w, region.min.y + 4.0 + i as f32 * line_h), Align2::LEFT_TOP, label, font, Color32::from_gray(110));
    }

    let body_rect = Rect::from_min_max(pos2(gutter_rect.max.x + 4.0, region.min.y), region.max);
    let mut body = ui.child_ui_at(body_rect, Layout::top_down(Align::Min), "code_editor_body");
    let response = body.text_edit_multiline(content);
    ui.advance_after_child(region);
    response
}
