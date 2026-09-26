use crate::entropy_gui::color::Color32;
use crate::entropy_gui::geometry::{pos2, vec2, Align2};
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::FontId;

use super::value_entry::{self, KeyAction, ValueSpec};
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
    spec: ValueSpec,
    text: Option<String>,
    tooltip: bool,
}

impl<'a, T: SliderNumeric> Slider<'a, T> {
    pub fn new(value: &'a mut T, range: std::ops::RangeInclusive<T>) -> Self {
        let min = range.start().to_f32();
        let max = range.end().to_f32();
        let integer = T::from_f32(0.5).to_f32() != 0.5;
        Self { value, spec: ValueSpec { min, max, integer, ..Default::default() }, text: None, tooltip: true }
    }
    pub fn text(mut self, t: impl Into<String>) -> Self {
        self.text = Some(t.into());
        self
    }
    /// The value Ctrl+click (or Delete while focused) returns to.
    pub fn default_value(mut self, v: f32) -> Self {
        self.spec.default = Some(v);
        self
    }
    pub fn unit(mut self, unit: impl Into<String>) -> Self {
        self.spec.unit = unit.into();
        self
    }
    pub fn step(mut self, step: f32) -> Self {
        self.spec.step = Some(step);
        self
    }
    pub fn decimals(mut self, d: usize) -> Self {
        self.spec.decimals = Some(d);
        self
    }
    pub fn show_tooltip(mut self, on: bool) -> Self {
        self.tooltip = on;
        self
    }
}

impl<'a, T: SliderNumeric> Widget for Slider<'a, T> {
    fn ui(self, ui: &mut Ui) -> Response {
        let Slider { value, spec, text, tooltip } = self;
        let (min, max) = (spec.min, spec.max);
        let height = ui.style().spacing.interact_size.y;
        let width = ui.available_width().clamp(80.0, 240.0);
        let (rect, mut response) = ui.allocate_response(vec2(width, height), Sense::click_and_drag());
        let ctx = ui.ctx().clone();

        let cur = value.to_f32();
        let typing = value_entry::entry_active(&ctx, response.id);
        if typing {
            if let Some(Some(v)) = value_entry::show_entry(ui, &response, rect, &spec) {
                value_entry::apply(value, &spec, v, &mut response);
            }
        } else {
            let focused = ui.focus_with(&mut response, crate::entropy_gui::ui::FocusOptions { activate: false, ..Default::default() });
            let fine = ctx.input(|i| i.modifiers.shift);
            if value_entry::reset_click(&ctx, &response) {
                if let Some(d) = spec.default {
                    value_entry::apply(value, &spec, d, &mut response);
                }
            } else if value_entry::double_clicked(&ctx, &response) {
                value_entry::begin_entry(&ctx, response.id, &spec, cur, String::new());
            } else if fine && response.dragged() && max > min {
                // Shift: the value follows the pointer at a tenth of the speed instead of jumping
                // to it, so small moves are possible.
                let dx = response.drag_delta().x;
                if dx != 0.0 {
                    value_entry::apply(value, &spec, cur + dx / rect.width().max(1.0) * (max - min) * 0.1, &mut response);
                }
            } else if response.dragged() || response.clicked() {
                if let Some(pos) = response.interact_pointer_pos() {
                    let t = ((pos.x - rect.min.x) / rect.width().max(1.0)).clamp(0.0, 1.0);
                    value_entry::apply(value, &spec, min + t * (max - min), &mut response);
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
        if typing {
            return response;
        }

        let value_after = value.to_f32();
        let t = if max > min { ((value_after - min) / (max - min)).clamp(0.0, 1.0) } else { 0.0 };

        let visuals = ui.visuals();
        let painter = ui.painter();
        let track = crate::entropy_gui::geometry::Rect::from_min_size(pos2(rect.min.x, rect.center().y - 2.0), vec2(rect.width(), 4.0));
        painter.rect_filled(track, 2u8, visuals.widgets.noninteractive.bg_fill);
        let fill = crate::entropy_gui::geometry::Rect::from_min_size(track.min, vec2(track.width() * t, track.height()));
        painter.rect_filled(fill, 2u8, visuals.selection.bg_fill);
        let active = response.hovered() || response.dragged() || response.has_focus();
        painter.circle_filled(pos2(rect.min.x + rect.width() * t, rect.center().y), if active { 7.0 } else { 6.0 }, visuals.selection.stroke.color);

        let label = match &text {
            Some(t) => format!("{}: {}", t, spec.format(value_after)),
            None => spec.format(value_after),
        };
        let color = visuals.override_text_color.unwrap_or(Color32::from_gray(220));
        painter.text(pos2(rect.min.x + 6.0, rect.center().y), Align2::LEFT_CENTER, label, FontId::proportional(12.0), color);

        if tooltip && !response.dragged() {
            response = response.on_hover_text(spec.help(text.as_deref(), value_after));
        }
        response
    }
}
