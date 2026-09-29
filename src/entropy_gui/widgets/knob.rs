//! `Knob` — a rotary drag-to-adjust control, the circular counterpart to `Slider`. Built for the
//! DAW's Wavetable window (Motion/Voice groups): a bank of full-width sliders reads like a
//! spreadsheet, a bank of knobs reads like a synth.
//!
//! Interaction is a vertical drag (up raises the value, down lowers it, same convention as every
//! hardware knob and most software ones) rather than the horizontal "grab the exact pixel"
//! Slider uses - a knob has no fixed track for a pointer position to map onto. Shift slows the
//! drag tenfold for fine adjustment. Double-click types an exact value, Ctrl/Alt+click resets to
//! the default, and when focused the arrow keys step it (see `value_entry`).

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2, Rect};
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::FontId;

use super::value_entry::{self, KeyAction, ValueSpec};
use super::{SliderNumeric, Widget};

/// Points of vertical drag for a full sweep from `min` to `max`.
const DRAG_RANGE_PX: f32 = 180.0;
/// Shift-drag moves this much slower.
const FINE_FACTOR: f32 = 0.1;
/// Rest angle at the minimum: 135°, pointing down-left, so the sweep opens upward like a dial.
const START_ANGLE: f32 = std::f32::consts::PI * 0.75;
/// Total sweep from `min` to `max`: 270°, ending at 45° (down-right). The 90° gap at the bottom
/// is deliberately dead space - it is where a real knob's finger-grip notch would be.
const SWEEP: f32 = std::f32::consts::PI * 1.5;

/// Sizing and layout style for a [`Knob`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KnobSize {
    /// Standard stacked layout: label above dial, value below dial.
    #[default]
    Normal,
    /// Compact horizontal layout: label on the left, smaller dial in the middle, value on the right.
    Small,
}

impl KnobSize {
    pub fn from_str(s: &str) -> Self {
        match s {
            "small" => Self::Small,
            _ => Self::Normal,
        }
    }
}

pub struct Knob<'a, T: SliderNumeric> {
    value: &'a mut T,
    spec: ValueSpec,
    text: Option<String>,
    diameter: Option<f32>,
    size: KnobSize,
    tooltip: bool,
}

impl<'a, T: SliderNumeric> Knob<'a, T> {
    pub fn new(value: &'a mut T, range: std::ops::RangeInclusive<T>) -> Self {
        let min = range.start().to_f32();
        let max = range.end().to_f32();
        let integer = T::from_f32(0.5).to_f32() != 0.5;
        Self {
            value,
            spec: ValueSpec { min, max, integer, ..Default::default() },
            text: None,
            diameter: None,
            size: KnobSize::Normal,
            tooltip: true,
        }
    }

    pub fn text(mut self, t: impl Into<String>) -> Self {
        self.text = Some(t.into());
        self
    }

    /// Sets the layout and size mode.
    pub fn size(mut self, size: KnobSize) -> Self {
        self.size = size;
        self
    }

    /// Convenience helper for compact horizontal small layout.
    pub fn small(self) -> Self {
        self.size(KnobSize::Small)
    }

    pub fn diameter(mut self, d: f32) -> Self {
        self.diameter = Some(d.max(12.0));
        self
    }

    /// The value Ctrl+click (or Delete while focused) returns to.
    pub fn default_value(mut self, v: f32) -> Self {
        self.spec.default = Some(v);
        self
    }

    /// Shown after the value: "Hz", "dB", "%".
    pub fn unit(mut self, unit: impl Into<String>) -> Self {
        self.spec.unit = unit.into();
        self
    }

    /// One arrow-key step (a hundredth of the range by default).
    pub fn step(mut self, step: f32) -> Self {
        self.spec.step = Some(step);
        self
    }

    pub fn decimals(mut self, d: usize) -> Self {
        self.spec.decimals = Some(d);
        self
    }

    /// Turns off the built-in help tooltip (for a caller that shows its own).
    pub fn show_tooltip(mut self, on: bool) -> Self {
        self.tooltip = on;
        self
    }
}

impl<'a, T: SliderNumeric> Widget for Knob<'a, T> {
    fn ui(self, ui: &mut Ui) -> Response {
        let Knob { value, spec, text, diameter: explicit_diameter, size, tooltip } = self;
        let is_small = matches!(size, KnobSize::Small);
        let diameter = explicit_diameter.unwrap_or(if is_small { 22.0 } else { 42.0 });
        let radius = diameter / 2.0;
        let (min, max) = (spec.min, spec.max);
        let label_font = FontId::proportional(11.0);
        let cur = value.to_f32();
        let ctx = ui.ctx().clone();

        let (rect, mut response, value_rect, center) = if is_small {
            let (label_w, label_h) = if let Some(ref l) = text {
                let s = Painter::measure_text(&ctx, label_font, l);
                (s.x, s.y)
            } else {
                (0.0, 0.0)
            };
            let label_gap = if label_w > 0.0 { 6.0 } else { 0.0 };
            let val_sample = spec.format(cur);
            let val_size = Painter::measure_text(&ctx, label_font, &val_sample);
            let val_w = val_size.x.max(22.0);
            let val_gap = 6.0;

            let width = label_w + label_gap + diameter + val_gap + val_w;
            let height = diameter.max(ui.style().spacing.interact_size.y).max(label_h).max(13.0);
            let (rect, response) = ui.allocate_response(vec2(width, height), Sense::click_and_drag());

            let center_x = rect.min.x + label_w + label_gap + radius;
            let center_y = rect.center().y;
            let center = pos2(center_x, center_y);

            let val_start_x = center_x + radius + val_gap;
            let val_rect = Rect::from_min_size(
                pos2(val_start_x - 2.0, center_y - 8.5),
                vec2(val_w + 4.0, 17.0),
            );

            (rect, response, val_rect, center)
        } else {
            let label_h = if text.is_some() { 14.0 } else { 0.0 };
            let value_h = 13.0;
            let width = diameter.max(56.0);
            let height = label_h + diameter + value_h + 4.0;
            let (rect, response) = ui.allocate_response(vec2(width, height), Sense::click_and_drag());

            let val_rect = Rect::from_min_size(
                pos2(rect.min.x, rect.max.y - value_h - 3.0),
                vec2(width, value_h + 4.0),
            );
            let center = pos2(rect.center().x, rect.min.y + label_h + radius);

            (rect, response, val_rect, center)
        };

        let typing = value_entry::entry_active(&ctx, response.id);
        if typing {
            if let Some(result) = value_entry::show_entry(ui, &response, value_rect, &spec) {
                if let Some(v) = result {
                    value_entry::apply(value, &spec, v, &mut response);
                }
            }
        } else {
            let focused = ui.focus_with(&mut response, crate::entropy_gui::ui::FocusOptions { activate: false, ..Default::default() });
            if value_entry::reset_click(&ctx, &response) {
                if let Some(d) = spec.default {
                    value_entry::apply(value, &spec, d, &mut response);
                }
            } else if value_entry::double_clicked(&ctx, &response) {
                value_entry::begin_entry(&ctx, response.id, &spec, cur, String::new());
            } else if response.dragged() && max > min {
                let delta = response.drag_delta();
                if delta.y != 0.0 {
                    let fine = ctx.input(|i| i.modifiers.shift);
                    let speed = if fine { FINE_FACTOR } else { 1.0 };
                    value_entry::apply(value, &spec, cur - delta.y / DRAG_RANGE_PX * (max - min) * speed, &mut response);
                }
            }
            if focused {
                match value_entry::keys(&ctx, &spec, value.to_f32()) {
                    KeyAction::Set(v) => value_entry::apply(value, &spec, v, &mut response),
                    KeyAction::BeginEntry(initial) => value_entry::begin_entry(&ctx, response.id, &spec, value.to_f32(), initial),
                    KeyAction::None => {}
                }
            }
        }

        let value_after = value.to_f32();
        let t = if max > min { ((value_after - min) / (max - min)).clamp(0.0, 1.0) } else { 0.0 };

        let visuals = ui.visuals();
        let painter = ui.painter();

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
        if response.has_focus() && ctx.focus_visible() {
            painter.circle_stroke(center, radius + if is_small { 2.0 } else { 3.0 }, Stroke::new(if is_small { 1.5 } else { 2.0 }, visuals.selection.stroke.color));
        }
        let track_r = if is_small { (radius - 2.5).max(3.0) } else { radius - 4.0 };
        let arc_stroke = if is_small { 2.0 } else { 2.5 };
        arc(0.0, 1.0, Stroke::new(arc_stroke, visuals.widgets.inactive.bg_stroke.color.linear_multiply(1.6)), track_r);
        if t > 0.0 {
            let ring_color = if response.dragged() || response.hovered() || response.has_focus() { visuals.selection.stroke.color } else { visuals.selection.bg_fill };
            arc(0.0, t, Stroke::new(arc_stroke, ring_color), track_r);
        }
        // A tick where the default sits, so "back to default" has a visible target.
        if let (Some(d), true) = (spec.default, max > min) {
            let dt = ((d - min) / (max - min)).clamp(0.0, 1.0);
            let a = START_ANGLE + dt * SWEEP;
            let (r0, r1) = if is_small { (radius + 1.0, radius + 3.0) } else { (radius + 1.0, radius + 4.0) };
            painter.line_segment([pos2(center.x + r0 * a.cos(), center.y + r0 * a.sin()), pos2(center.x + r1 * a.cos(), center.y + r1 * a.sin())], Stroke::new(1.5, Color32::from_gray(150)));
        }

        let angle = START_ANGLE + t * SWEEP;
        let tip_r = if is_small { (radius - 3.0).max(2.0) } else { radius - 6.0 };
        let tip = pos2(center.x + tip_r * angle.cos(), center.y + tip_r * angle.sin());
        let pointer_color = visuals.override_text_color.unwrap_or(Color32::from_gray(235));
        painter.line_segment([center, tip], Stroke::new(if is_small { 1.5 } else { 2.0 }, pointer_color));

        if is_small {
            if let Some(label) = &text {
                painter.text(pos2(rect.min.x, center.y), Align2::LEFT_CENTER, label, label_font, Color32::from_gray(190));
            }
            if !typing {
                let val_start_x = center.x + radius + 6.0;
                painter.text(pos2(val_start_x, center.y), Align2::LEFT_CENTER, spec.format(value_after), label_font, visuals.override_text_color.unwrap_or(Color32::from_gray(220)));
            }
        } else {
            let label_h = if text.is_some() { 14.0 } else { 0.0 };
            let value_h = 13.0;
            if let Some(label) = &text {
                painter.text(pos2(rect.center().x, rect.min.y + label_h / 2.0), Align2::CENTER_CENTER, label, label_font, Color32::from_gray(190));
            }
            if !typing {
                painter.text(pos2(rect.center().x, rect.max.y - value_h / 2.0), Align2::CENTER_CENTER, spec.format(value_after), label_font, visuals.override_text_color.unwrap_or(Color32::from_gray(220)));
            }
        }

        if response.hovered() || response.dragged() {
            ctx.request_cursor_icon(crate::entropy_gui::geometry::CursorIcon::ResizeVertical);
        }
        if tooltip && !response.dragged() && !typing {
            response = response.on_hover_text(spec.help(text.as_deref(), value_after));
        }
        response
    }
}
