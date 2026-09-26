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
    /// `false` draws no background fill or stroke while idle - only the text, plus a subtle
    /// highlight on hover/press - for an icon-tile-style button that shouldn't look like a
    /// bordered dialog control (see the app launcher's home-screen grid).
    frame: bool,
    min_size: crate::entropy_gui::geometry::Vec2,
    selected: bool,
}

impl Button {
    pub fn new(text: impl Into<WidgetText>) -> Self {
        Self { text: text.into(), enabled: true, frame: true, min_size: crate::entropy_gui::geometry::Vec2::ZERO, selected: false }
    }
    /// Grows the hit area to at least `size` (an icon glyph alone is a small target).
    pub fn min_size(mut self, size: crate::entropy_gui::geometry::Vec2) -> Self {
        self.min_size = size;
        self
    }
    /// Draws the button pressed-in: a toggle that is on, the current mode in a tool row.
    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }
    pub fn enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }
    pub fn frame(mut self, frame: bool) -> Self {
        self.frame = frame;
        self
    }
}

impl Widget for Button {
    fn ui(self, ui: &mut Ui) -> Response {
        let font = FontId::proportional(self.text.0.font_size.unwrap_or(DEFAULT_FONT_SIZE));
        let padding = ui.style().spacing.button_padding;
        let text_size = Painter::measure_text(ui.ctx(), font, &self.text.0.text);
        let size = vec2(text_size.x + padding.x * 2.0, text_size.y.max(font.size) + padding.y * 2.0).max(ui.style().spacing.interact_size).max(self.min_size);

        let sense = if self.enabled { Sense::click() } else { Sense::hover() };
        let (rect, mut response) = ui.allocate_response(size, sense);
        if self.enabled {
            ui.focus(&mut response);
        }

        let visuals = if !self.enabled {
            ui.visuals().widgets.noninteractive
        } else {
            ui.interactive_visuals(response.hovered(), response.clicked() || self.selected)
        };
        // Disabled reads as disabled: the whole control fades, not just its color.
        let alpha = self.text.0.alpha * if self.enabled { 1.0 } else { 0.45 };
        let painter = ui.painter();
        if self.frame {
            painter.rect_filled(rect, visuals.corner_radius, visuals.bg_fill.linear_multiply(alpha));
            if visuals.bg_stroke.width > 0.0 {
                let mut stroke = visuals.bg_stroke;
                stroke.color = stroke.color.linear_multiply(alpha);
                painter.rect_stroke(rect, visuals.corner_radius, stroke, StrokeKind::Middle);
            }
        } else if response.hovered() || response.clicked() || self.selected {
            painter.rect_filled(rect, visuals.corner_radius, visuals.weak_bg_fill.linear_multiply(alpha));
        }
        let text_color = self.text.0.color.unwrap_or(visuals.fg_stroke.color).linear_multiply(alpha);
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
