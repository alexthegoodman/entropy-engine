use crate::entropy_gui::color::Color32;
use crate::entropy_gui::geometry::{vec2, Align2};
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::style::{DEFAULT_FONT_SIZE, HEADING_FONT_SIZE};
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::{FontId, WidgetText};

fn label_color(ui: &Ui, wt: &WidgetText) -> Color32 {
    if let Some(c) = wt.0.color {
        return c;
    }
    let base = ui.visuals().override_text_color.unwrap_or(Color32::from_gray(210));
    if wt.0.strong {
        Color32::WHITE
    } else {
        base
    }
}

impl Ui {
    pub fn label(&mut self, text: impl Into<WidgetText>) -> Response {
        let text = text.into();
        let font = FontId::proportional(DEFAULT_FONT_SIZE);
        let size = Painter::measure_text(self.ctx(), font, &text.0.text);
        let (rect, response) = self.allocate_response(vec2(size.x, size.y.max(font.size)), Sense::hover());
        let color = label_color(self, &text);
        self.painter().text(rect.left_top(), Align2::LEFT_TOP, &text.0.text, font, color);
        response
    }

    pub fn heading(&mut self, text: impl Into<WidgetText>) -> Response {
        let text = text.into();
        let font = FontId::proportional(HEADING_FONT_SIZE);
        let size = Painter::measure_text(self.ctx(), font, &text.0.text);
        let (rect, response) = self.allocate_response(vec2(size.x, size.y.max(font.size)), Sense::hover());
        let color = label_color(self, &text);
        self.painter().text(rect.left_top(), Align2::LEFT_TOP, &text.0.text, font, color);
        response
    }

    pub fn strong(&mut self, text: impl Into<WidgetText>) -> Response {
        let mut t: WidgetText = text.into();
        t.0.strong = true;
        self.label(t)
    }
}
