use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2, Rect, StrokeKind};
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::style::DEFAULT_FONT_SIZE;
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::{FontId, WidgetText};

impl Ui {
    pub fn checkbox(&mut self, value: &mut bool, text: impl Into<WidgetText>) -> Response {
        let text = text.into();
        let box_size = 16.0_f32;
        let font = FontId::proportional(DEFAULT_FONT_SIZE);
        let text_size = Painter::measure_text(self.ctx(), font, &text.0.text);
        let spacing = self.style().spacing.item_spacing.x;
        let extra = if text.0.text.is_empty() { 0.0 } else { spacing + text_size.x };
        let h = box_size.max(text_size.y).max(self.style().spacing.interact_size.y);
        let (rect, mut response) = self.allocate_response(vec2(box_size + extra, h), Sense::click());

        let box_rect = Rect::from_min_size(pos2(rect.min.x, rect.center().y - box_size / 2.0), vec2(box_size, box_size));
        let visuals = self.interactive_visuals(response.hovered(), *value);
        let painter = self.painter();
        painter.rect_filled(box_rect, 3u8, visuals.bg_fill);
        painter.rect_stroke(box_rect, 3u8, visuals.bg_stroke, StrokeKind::Middle);
        if *value {
            let c = visuals.fg_stroke.color;
            painter.line_segment(
                [pos2(box_rect.min.x + 3.0, box_rect.center().y), pos2(box_rect.min.x + box_size * 0.42, box_rect.max.y - 3.0)],
                Stroke::new(2.0, c),
            );
            painter.line_segment(
                [pos2(box_rect.min.x + box_size * 0.42, box_rect.max.y - 3.0), pos2(box_rect.max.x - 2.0, box_rect.min.y + 3.0)],
                Stroke::new(2.0, c),
            );
        }
        if !text.0.text.is_empty() {
            let text_color = self.visuals().override_text_color.unwrap_or(Color32::from_gray(220));
            painter.text(pos2(box_rect.max.x + spacing, rect.center().y), Align2::LEFT_CENTER, &text.0.text, font, text_color);
        }

        if response.clicked() {
            *value = !*value;
            response.mark_changed();
        }
        response
    }
}
