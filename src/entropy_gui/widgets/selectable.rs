use crate::entropy_gui::geometry::{vec2, Align2};
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::style::DEFAULT_FONT_SIZE;
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::{FontId, WidgetText};

impl Ui {
    pub fn selectable_label(&mut self, selected: bool, text: impl Into<WidgetText>) -> Response {
        let text = text.into();
        let font = FontId::proportional(DEFAULT_FONT_SIZE);
        let padding = self.style().spacing.button_padding;
        let text_size = Painter::measure_text(self.ctx(), font, &text.0.text);
        let size = vec2(text_size.x + padding.x * 2.0, text_size.y.max(font.size) + padding.y * 2.0).max(self.style().spacing.interact_size);
        let (rect, response) = self.allocate_response(size, Sense::click());

        let visuals = self.interactive_visuals(response.hovered(), selected);
        let painter = self.painter();
        if selected || response.hovered() {
            painter.rect_filled(rect, visuals.corner_radius, visuals.bg_fill);
        }
        let color = text.0.color.unwrap_or(visuals.fg_stroke.color);
        painter.text(rect.center(), Align2::CENTER_CENTER, &text.0.text, font, color);
        response
    }

    pub fn selectable_value<T: PartialEq>(&mut self, current: &mut T, value: T, text: impl Into<WidgetText>) -> Response {
        let is_selected = *current == value;
        let mut response = self.selectable_label(is_selected, text);
        if response.clicked() && !is_selected {
            *current = value;
            response.mark_changed();
        }
        response
    }

    pub fn toggle_value(&mut self, value: &mut bool, text: impl Into<WidgetText>) -> Response {
        let mut response = self.selectable_label(*value, text);
        if response.clicked() {
            *value = !*value;
            response.mark_changed();
        }
        response
    }
}
