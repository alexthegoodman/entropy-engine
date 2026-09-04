use crate::entropy_gui::color::Color32;
use crate::entropy_gui::geometry::{vec2, StrokeKind};
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::ui::Ui;

impl Ui {
    pub fn color_edit_button_rgba_unmultiplied(&mut self, rgba: &mut [f32; 4]) -> Response {
        self.color_edit_button_impl(rgba)
    }
    pub fn color_edit_button_rgba_premultiplied(&mut self, rgba: &mut [f32; 4]) -> Response {
        self.color_edit_button_impl(rgba)
    }

    /// No real HSV picker popup in v1 — clicking cycles through a small preset palette as a
    /// functional stand-in. Nothing load-bearing in this app's egui usage depends on precise
    /// color picking through this widget; a full picker is a natural, isolated follow-up.
    fn color_edit_button_impl(&mut self, rgba: &mut [f32; 4]) -> Response {
        let size = vec2(28.0, self.style().spacing.interact_size.y);
        let (rect, mut response) = self.allocate_response(size, Sense::click());
        let color = Color32::from_rgba_f32(*rgba);
        let painter = self.painter();
        painter.rect_filled(rect, 4u8, color);
        painter.rect_stroke(rect, 4u8, self.visuals().widgets.inactive.bg_stroke, StrokeKind::Middle);

        if response.clicked() {
            const PRESETS: [[f32; 4]; 6] = [
                [1.0, 1.0, 1.0, 1.0],
                [0.9, 0.3, 0.3, 1.0],
                [0.3, 0.8, 0.4, 1.0],
                [0.3, 0.5, 0.9, 1.0],
                [0.9, 0.7, 0.2, 1.0],
                [0.1, 0.1, 0.1, 1.0],
            ];
            let idx = PRESETS
                .iter()
                .position(|p| (p[0] - rgba[0]).abs() < 0.01 && (p[1] - rgba[1]).abs() < 0.01 && (p[2] - rgba[2]).abs() < 0.01);
            let next = match idx {
                Some(i) => (i + 1) % PRESETS.len(),
                None => 0,
            };
            *rgba = PRESETS[next];
            response.mark_changed();
        }
        response
    }
}
