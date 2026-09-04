use crate::entropy_gui::color::Stroke;
use crate::entropy_gui::geometry::{pos2, vec2, Direction};
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::ui::Ui;

impl Ui {
    pub fn separator(&mut self) -> Response {
        let color = self.visuals().widgets.noninteractive.bg_stroke.color;
        let is_top_down = matches!(self.layout_direction(), Direction::TopDown);
        let size = if is_top_down { vec2(self.available_width().max(1.0), 6.0) } else { vec2(6.0, self.available_size().y.max(1.0).min(200.0)) };
        let (rect, response) = self.allocate_response(size, Sense::hover());
        let mid = rect.center();
        let painter = self.painter();
        if is_top_down {
            painter.line_segment([pos2(rect.min.x, mid.y), pos2(rect.max.x, mid.y)], Stroke::new(1.0, color));
        } else {
            painter.line_segment([pos2(mid.x, rect.min.y), pos2(mid.x, rect.max.y)], Stroke::new(1.0, color));
        }
        response
    }
}
