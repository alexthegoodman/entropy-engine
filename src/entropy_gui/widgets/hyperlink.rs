use crate::entropy_gui::color::Stroke;
use crate::entropy_gui::geometry::{pos2, vec2, Align2};
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::style::DEFAULT_FONT_SIZE;
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::{FontId, WidgetText};

impl Ui {
    pub fn hyperlink_to(&mut self, text: impl Into<WidgetText>, url: impl Into<String>) -> Response {
        let text = text.into();
        let url = url.into();
        let font = FontId::proportional(DEFAULT_FONT_SIZE);
        let size = Painter::measure_text(self.ctx(), font, &text.0.text);
        let (rect, response) = self.allocate_response(vec2(size.x, size.y.max(font.size)), Sense::click());
        let color = self.visuals().hyperlink_color;
        let painter = self.painter();
        painter.text(rect.left_top(), Align2::LEFT_TOP, &text.0.text, font, color);
        if response.hovered() {
            painter.line_segment([pos2(rect.min.x, rect.max.y), pos2(rect.max.x, rect.max.y)], Stroke::new(1.0, color));
        }
        if response.clicked() {
            #[cfg(target_os = "windows")]
            {
                let _ = std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn();
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = &url;
            }
        }
        response
    }
}
