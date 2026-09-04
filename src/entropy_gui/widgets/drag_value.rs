use crate::entropy_gui::geometry::{vec2, Align2, CursorIcon, StrokeKind};
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::style::DEFAULT_FONT_SIZE;
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::FontId;

use super::slider::SliderNumeric;
use super::Widget;

pub struct DragValue<'a, T: SliderNumeric> {
    value: &'a mut T,
    prefix: String,
    speed: f32,
}

impl<'a, T: SliderNumeric> DragValue<'a, T> {
    pub fn new(value: &'a mut T) -> Self {
        Self { value, prefix: String::new(), speed: 1.0 }
    }
    pub fn prefix(mut self, p: impl Into<String>) -> Self {
        self.prefix = p.into();
        self
    }
    pub fn speed(mut self, s: f32) -> Self {
        self.speed = s;
        self
    }
}

impl<'a, T: SliderNumeric> Widget for DragValue<'a, T> {
    fn ui(self, ui: &mut Ui) -> Response {
        let DragValue { value, prefix, speed } = self;
        let cur = value.to_f32();
        let font = FontId::proportional(DEFAULT_FONT_SIZE);
        let padding = ui.style().spacing.button_padding;
        let label = format!("{}{:.2}", prefix, cur);
        let text_size = Painter::measure_text(ui.ctx(), font, &label);
        let size = vec2((text_size.x + padding.x * 2.0).max(44.0), text_size.y + padding.y * 2.0);
        let (rect, mut response) = ui.allocate_response(size, Sense::click_and_drag());

        if response.dragged() {
            let delta = response.drag_delta().x;
            if delta != 0.0 {
                let nv = T::from_f32(cur + delta * speed);
                if nv.to_f32() != cur {
                    *value = nv;
                    response.mark_changed();
                }
            }
        }

        let visuals = ui.interactive_visuals(response.hovered(), response.dragged());
        let painter = ui.painter();
        painter.rect_filled(rect, visuals.corner_radius, visuals.bg_fill);
        painter.rect_stroke(rect, visuals.corner_radius, visuals.bg_stroke, StrokeKind::Middle);
        let label_after = format!("{}{:.2}", prefix, value.to_f32());
        painter.text(rect.center(), Align2::CENTER_CENTER, label_after, font, visuals.fg_stroke.color);

        if response.hovered() || response.dragged() {
            ui.ctx().request_cursor_icon(CursorIcon::ResizeHorizontal);
        }
        response
    }
}
