use crate::entropy_gui::geometry::{vec2, Align2, StrokeKind};
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::style::DEFAULT_FONT_SIZE;
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::{FontId, WidgetText};

use super::Widget;

pub struct Button {
    text: WidgetText,
    enabled: bool,
}

impl Button {
    pub fn new(text: impl Into<WidgetText>) -> Self {
        Self { text: text.into(), enabled: true }
    }
}

impl Widget for Button {
    fn ui(self, ui: &mut Ui) -> Response {
        let font = FontId::proportional(DEFAULT_FONT_SIZE);
        let padding = ui.style().spacing.button_padding;
        let text_size = Painter::measure_text(ui.ctx(), font, &self.text.0.text);
        let size = vec2(text_size.x + padding.x * 2.0, text_size.y.max(font.size) + padding.y * 2.0).max(ui.style().spacing.interact_size);

        let sense = if self.enabled { Sense::click() } else { Sense::hover() };
        let (rect, response) = ui.allocate_response(size, sense);

        let visuals = ui.interactive_visuals(response.hovered(), response.clicked());
        let painter = ui.painter();
        painter.rect_filled(rect, visuals.corner_radius, visuals.bg_fill);
        if visuals.bg_stroke.width > 0.0 {
            painter.rect_stroke(rect, visuals.corner_radius, visuals.bg_stroke, StrokeKind::Middle);
        }
        let text_color = self.text.0.color.unwrap_or(visuals.fg_stroke.color);
        painter.text(rect.center(), Align2::CENTER_CENTER, &self.text.0.text, font, text_color);

        response
    }
}

impl Ui {
    pub fn button(&mut self, text: impl Into<WidgetText>) -> Response {
        self.add(Button::new(text))
    }

    pub fn add_enabled(&mut self, enabled: bool, mut button: Button) -> Response {
        button.enabled = enabled;
        self.add(button)
    }
}
