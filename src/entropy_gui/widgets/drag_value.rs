use crate::entropy_gui::geometry::{vec2, Align2, CursorIcon, StrokeKind};
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::style::DEFAULT_FONT_SIZE;
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::FontId;

use super::slider::SliderNumeric;
use super::value_entry::{self, KeyAction, ValueSpec};
use super::Widget;

pub struct DragValue<'a, T: SliderNumeric> {
    value: &'a mut T,
    prefix: String,
    speed: f32,
    spec: ValueSpec,
}

impl<'a, T: SliderNumeric> DragValue<'a, T> {
    pub fn new(value: &'a mut T) -> Self {
        let integer = T::from_f32(0.5).to_f32() != 0.5;
        Self { value, prefix: String::new(), speed: 1.0, spec: ValueSpec { integer, ..Default::default() } }
    }
    pub fn prefix(mut self, p: impl Into<String>) -> Self {
        self.prefix = p.into();
        self
    }
    pub fn speed(mut self, s: f32) -> Self {
        self.speed = s;
        self
    }
    /// Clamps dragging, typing and the arrow keys to `range` (unbounded by default).
    pub fn range(mut self, range: std::ops::RangeInclusive<f32>) -> Self {
        self.spec.min = *range.start();
        self.spec.max = *range.end();
        self
    }
    pub fn suffix(mut self, unit: impl Into<String>) -> Self {
        self.spec.unit = unit.into();
        self
    }
    pub fn default_value(mut self, v: f32) -> Self {
        self.spec.default = Some(v);
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
}

impl<'a, T: SliderNumeric> Widget for DragValue<'a, T> {
    fn ui(self, ui: &mut Ui) -> Response {
        let DragValue { value, prefix, speed, mut spec } = self;
        if spec.decimals.is_none() && !spec.integer {
            spec.decimals = Some(2);
        }
        let cur = value.to_f32();
        let font = FontId::proportional(DEFAULT_FONT_SIZE);
        let padding = ui.style().spacing.button_padding;
        let label = format!("{}{}", prefix, spec.format(cur));
        let text_size = Painter::measure_text(ui.ctx(), font, &label);
        let size = vec2((text_size.x + padding.x * 2.0).max(56.0), text_size.y + padding.y * 2.0);
        let (rect, mut response) = ui.allocate_response(size, Sense::click_and_drag());
        let ctx = ui.ctx().clone();

        let typing = value_entry::entry_active(&ctx, response.id);
        if typing {
            if let Some(Some(v)) = value_entry::show_entry(ui, &response, rect, &spec) {
                value_entry::apply(value, &spec, v, &mut response);
            }
            return response;
        }

        let focused = ui.focus_with(&mut response, crate::entropy_gui::ui::FocusOptions { activate: false, ..Default::default() });
        if value_entry::reset_click(&ctx, &response) {
            if let Some(d) = spec.default {
                value_entry::apply(value, &spec, d, &mut response);
            }
        } else if value_entry::double_clicked(&ctx, &response) {
            value_entry::begin_entry(&ctx, response.id, &spec, cur, String::new());
        } else if response.dragged() {
            let delta = response.drag_delta().x;
            if delta != 0.0 {
                let fine = if ctx.input(|i| i.modifiers.shift) { 0.1 } else { 1.0 };
                value_entry::apply(value, &spec, cur + delta * speed * fine, &mut response);
            }
        }
        if focused {
            let spec_keys = ValueSpec { step: spec.step.or(Some(speed.max(f32::EPSILON))), ..spec.clone() };
            match value_entry::keys(&ctx, &spec_keys, value.to_f32()) {
                KeyAction::Set(v) => value_entry::apply(value, &spec, v, &mut response),
                KeyAction::BeginEntry(initial) => value_entry::begin_entry(&ctx, response.id, &spec, value.to_f32(), initial),
                KeyAction::None => {}
            }
        }

        let visuals = ui.interactive_visuals(response.hovered(), response.dragged());
        let painter = ui.painter();
        painter.rect_filled(rect, visuals.corner_radius, visuals.bg_fill);
        painter.rect_stroke(rect, visuals.corner_radius, visuals.bg_stroke, StrokeKind::Middle);
        let label_after = format!("{}{}", prefix, spec.format(value.to_f32()));
        painter.text(rect.center(), Align2::CENTER_CENTER, label_after, font, visuals.fg_stroke.color);

        if response.hovered() || response.dragged() {
            ctx.request_cursor_icon(CursorIcon::ResizeHorizontal);
        }
        if !response.dragged() {
            let v = value.to_f32();
            response = response.on_hover_text(format!("Drag to change \u{b7} {}", spec.help(None, v).split_once('\n').map_or("", |(_, rest)| rest).trim_start()));
        }
        response
    }
}
