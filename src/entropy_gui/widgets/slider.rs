use crate::entropy_gui::color::Color32;
use crate::entropy_gui::geometry::{pos2, vec2, Align2};
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::FontId;

use super::Widget;

pub trait SliderNumeric: Copy {
    fn to_f32(self) -> f32;
    fn from_f32(v: f32) -> Self;
}
impl SliderNumeric for f32 {
    fn to_f32(self) -> f32 {
        self
    }
    fn from_f32(v: f32) -> Self {
        v
    }
}
impl SliderNumeric for i32 {
    fn to_f32(self) -> f32 {
        self as f32
    }
    fn from_f32(v: f32) -> Self {
        v.round() as i32
    }
}

pub struct Slider<'a, T: SliderNumeric> {
    value: &'a mut T,
    min: f32,
    max: f32,
    text: Option<String>,
}

impl<'a, T: SliderNumeric> Slider<'a, T> {
    pub fn new(value: &'a mut T, range: std::ops::RangeInclusive<T>) -> Self {
        let min = range.start().to_f32();
        let max = range.end().to_f32();
        Self { value, min, max, text: None }
    }
    pub fn text(mut self, t: impl Into<String>) -> Self {
        self.text = Some(t.into());
        self
    }
}

impl<'a, T: SliderNumeric> Widget for Slider<'a, T> {
    fn ui(self, ui: &mut Ui) -> Response {
        let Slider { value, min, max, text } = self;
        let height = ui.style().spacing.interact_size.y;
        let width = ui.available_width().clamp(80.0, 240.0);
        let (rect, mut response) = ui.allocate_response(vec2(width, height), Sense::click_and_drag());

        let cur = value.to_f32();
        if response.dragged() || response.clicked() {
            if let Some(pos) = response.interact_pointer_pos() {
                let t = ((pos.x - rect.min.x) / rect.width().max(1.0)).clamp(0.0, 1.0);
                let nv = T::from_f32(min + t * (max - min));
                if nv.to_f32() != cur {
                    *value = nv;
                    response.mark_changed();
                }
            }
        }

        let value_after = value.to_f32();
        let t = if max > min { ((value_after - min) / (max - min)).clamp(0.0, 1.0) } else { 0.0 };

        let visuals = ui.visuals();
        let painter = ui.painter();
        let track = crate::entropy_gui::geometry::Rect::from_min_size(pos2(rect.min.x, rect.center().y - 2.0), vec2(rect.width(), 4.0));
        painter.rect_filled(track, 2u8, visuals.widgets.noninteractive.bg_fill);
        let fill = crate::entropy_gui::geometry::Rect::from_min_size(track.min, vec2(track.width() * t, track.height()));
        painter.rect_filled(fill, 2u8, visuals.selection.bg_fill);
        painter.circle_filled(pos2(rect.min.x + rect.width() * t, rect.center().y), 6.0, visuals.selection.stroke.color);

        let label = match &text {
            Some(t) => format!("{}: {:.2}", t, value_after),
            None => format!("{:.2}", value_after),
        };
        let color = visuals.override_text_color.unwrap_or(Color32::from_gray(220));
        painter.text(pos2(rect.min.x + 6.0, rect.center().y), Align2::LEFT_CENTER, label, FontId::proportional(12.0), color);

        response
    }
}
