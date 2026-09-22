//! `Knob` — a rotary drag-to-adjust control, the circular counterpart to `Slider`. Built for the
//! DAW's Wavetable window (Motion/Voice groups): a bank of full-width sliders reads like a
//! spreadsheet, a bank of knobs reads like a synth.
//!
//! Interaction is a vertical drag (up raises the value, down lowers it, same convention as every
//! hardware knob and most software ones) rather than the horizontal "grab the exact pixel"
//! Slider uses - a knob has no fixed track for a pointer position to map onto.

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2};
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::FontId;

use super::{SliderNumeric, Widget};

/// Points of vertical drag for a full sweep from `min` to `max`.
const DRAG_RANGE_PX: f32 = 180.0;
/// Rest angle at the minimum: 135°, pointing down-left, so the sweep opens upward like a dial.
const START_ANGLE: f32 = std::f32::consts::PI * 0.75;
/// Total sweep from `min` to `max`: 270°, ending at 45° (down-right). The 90° gap at the bottom
/// is deliberately dead space - it is where a real knob's finger-grip notch would be.
const SWEEP: f32 = std::f32::consts::PI * 1.5;

pub struct Knob<'a, T: SliderNumeric> {
    value: &'a mut T,
    min: f32,
    max: f32,
    text: Option<String>,
    diameter: f32,
}

impl<'a, T: SliderNumeric> Knob<'a, T> {
    pub fn new(value: &'a mut T, range: std::ops::RangeInclusive<T>) -> Self {
        let min = range.start().to_f32();
        let max = range.end().to_f32();
        Self { value, min, max, text: None, diameter: 42.0 }
    }

    pub fn text(mut self, t: impl Into<String>) -> Self {
        self.text = Some(t.into());
        self
    }

    pub fn diameter(mut self, d: f32) -> Self {
        self.diameter = d.max(20.0);
        self
    }
}

impl<'a, T: SliderNumeric> Widget for Knob<'a, T> {
    fn ui(self, ui: &mut Ui) -> Response {
        let Knob { value, min, max, text, diameter } = self;
        let label_font = FontId::proportional(11.0);
        let label_h = if text.is_some() { 14.0 } else { 0.0 };
        let value_h = 13.0;
        let width = diameter.max(56.0);
        let height = label_h + diameter + value_h + 4.0;
        let (rect, mut response) = ui.allocate_response(vec2(width, height), Sense::click_and_drag());

        let cur = value.to_f32();
        if response.dragged() && max > min {
            let delta = response.drag_delta();
            if delta.y != 0.0 {
                let nv = T::from_f32((cur - delta.y / DRAG_RANGE_PX * (max - min)).clamp(min, max));
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
        let center = pos2(rect.center().x, rect.min.y + label_h + diameter / 2.0);
        let radius = diameter / 2.0;

        let arc = |from_t: f32, to_t: f32, stroke: Stroke, r: f32| {
            const STEPS: usize = 24;
            let a0 = START_ANGLE + from_t * SWEEP;
            let a1 = START_ANGLE + to_t * SWEEP;
            let mut prev = pos2(center.x + r * a0.cos(), center.y + r * a0.sin());
            for i in 1..=STEPS {
                let a = a0 + (a1 - a0) * i as f32 / STEPS as f32;
                let p = pos2(center.x + r * a.cos(), center.y + r * a.sin());
                painter.line_segment([prev, p], stroke);
                prev = p;
            }
        };

        painter.circle_filled(center, radius, visuals.widgets.inactive.bg_fill);
        painter.circle_stroke(center, radius, Stroke::new(1.0, visuals.widgets.inactive.bg_stroke.color));
        let track_r = radius - 4.0;
        arc(0.0, 1.0, Stroke::new(2.5, visuals.widgets.inactive.bg_stroke.color.linear_multiply(1.6)), track_r);
        if t > 0.0 {
            let ring_color = if response.dragged() || response.hovered() { visuals.selection.stroke.color } else { visuals.selection.bg_fill };
            arc(0.0, t, Stroke::new(2.5, ring_color), track_r);
        }

        let angle = START_ANGLE + t * SWEEP;
        let tip = pos2(center.x + (radius - 6.0) * angle.cos(), center.y + (radius - 6.0) * angle.sin());
        let pointer_color = visuals.override_text_color.unwrap_or(Color32::from_gray(235));
        painter.line_segment([center, tip], Stroke::new(2.0, pointer_color));

        if let Some(label) = &text {
            painter.text(pos2(rect.center().x, rect.min.y + label_h / 2.0), Align2::CENTER_CENTER, label, label_font, Color32::from_gray(190));
        }
        let value_text = if (value_after - value_after.round()).abs() < 1e-4 { format!("{:.0}", value_after) } else { format!("{:.2}", value_after) };
        painter.text(pos2(rect.center().x, rect.max.y - value_h / 2.0), Align2::CENTER_CENTER, value_text, label_font, visuals.override_text_color.unwrap_or(Color32::from_gray(220)));

        response
    }
}
