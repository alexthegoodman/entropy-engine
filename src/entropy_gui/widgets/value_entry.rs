//! What `Knob`, `Slider` and `DragValue` share for precise numeric input:
//!
//! - **Type an exact value**: double-click (or press Enter while focused, or just start typing a
//!   number) opens an inline field over the value. Enter or clicking away commits, Escape
//!   cancels. The unit is optional when typing (`440`, `440 Hz`), and `k`/`m` suffixes scale
//!   (`2.5k` is 2500, `12m` is 0.012).
//! - **Fine adjustment**: hold Shift while dragging or using the arrow keys for a tenth of the
//!   normal speed.
//! - **Reset to default**: Ctrl+click (or Alt+click, or Delete/Backspace while focused).
//! - **Keyboard**: arrows step, Page Up/Down take ten steps, Home/End jump to the ends.
//! - **Units and range** in the readout and the tooltip.

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::context::{Context, Key};
use crate::entropy_gui::geometry::{pos2, Align2, FontId, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::response::Response;
use crate::entropy_gui::ui::{FocusOptions, Ui};

/// Seconds between two clicks for them to count as a double-click.
pub const DOUBLE_CLICK_SECONDS: f32 = 0.4;

/// How a numeric widget formats, parses, steps and resets its value.
#[derive(Clone, Debug, PartialEq)]
pub struct ValueSpec {
    pub min: f32,
    pub max: f32,
    pub default: Option<f32>,
    /// Shown after the number: "Hz", "dB", "%", "ms".
    pub unit: String,
    /// One arrow-key step. `None` uses a hundredth of the range (or 1 for an unbounded value).
    pub step: Option<f32>,
    /// Digits after the point. `None` shows whole numbers as whole and two decimals otherwise.
    pub decimals: Option<usize>,
    /// Values snap to whole numbers (an `i32` widget).
    pub integer: bool,
}

impl Default for ValueSpec {
    fn default() -> Self {
        Self { min: f32::NEG_INFINITY, max: f32::INFINITY, default: None, unit: String::new(), step: None, decimals: None, integer: false }
    }
}

impl ValueSpec {
    pub fn bounded(&self) -> bool {
        self.min.is_finite() && self.max.is_finite() && self.max > self.min
    }

    pub fn clamp(&self, v: f32) -> f32 {
        let v = if self.integer { v.round() } else { v };
        if self.min <= self.max {
            v.clamp(self.min, self.max)
        } else {
            v
        }
    }

    pub fn step(&self) -> f32 {
        if let Some(s) = self.step.filter(|s| *s > 0.0) {
            return s;
        }
        if self.integer {
            return 1.0;
        }
        if self.bounded() {
            (self.max - self.min) / 100.0
        } else {
            1.0
        }
    }

    /// The number alone, without the unit.
    pub fn format_number(&self, v: f32) -> String {
        if self.integer {
            return format!("{:.0}", v);
        }
        match self.decimals {
            Some(d) => format!("{:.*}", d, v),
            None if (v - v.round()).abs() < 1e-4 => format!("{:.0}", v),
            None => format!("{:.2}", v),
        }
    }

    pub fn format(&self, v: f32) -> String {
        let n = self.format_number(v);
        if self.unit.is_empty() {
            n
        } else if self.unit == "%" {
            format!("{n}%")
        } else {
            format!("{n} {}", self.unit)
        }
    }

    /// Reads what the user typed. Accepts the unit or not, a `k`/`m` scale suffix, and a
    /// comma as the decimal point. `None` if it is not a number.
    pub fn parse(&self, text: &str) -> Option<f32> {
        let mut t = text.trim().to_string();
        if !self.unit.is_empty() && t.to_lowercase().ends_with(&self.unit.to_lowercase()) {
            t.truncate(t.len() - self.unit.len());
        }
        let t = t.trim().replace(',', ".");
        let (num, scale) = match t.chars().last() {
            Some('k') | Some('K') => (&t[..t.len() - 1], 1000.0),
            Some('m') if !self.unit.eq_ignore_ascii_case("m") => (&t[..t.len() - 1], 0.001),
            _ => (t.as_str(), 1.0),
        };
        let v: f32 = num.trim().parse().ok()?;
        v.is_finite().then(|| self.clamp(v * scale))
    }

    /// The tooltip every numeric widget shows: the value, its range, its default and how to
    /// type, reset and fine-adjust it.
    pub fn help(&self, label: Option<&str>, value: f32) -> String {
        let mut out = match label {
            Some(l) if !l.is_empty() => format!("{l}: {}", self.format(value)),
            _ => self.format(value),
        };
        if self.bounded() {
            out.push_str(&format!("\nRange {} to {}", self.format(self.min), self.format(self.max)));
        }
        if let Some(d) = self.default {
            out.push_str(&format!(" \u{b7} default {}", self.format(d)));
        }
        out.push_str("\nDouble-click to type a value");
        if self.default.is_some() {
            out.push_str(" \u{b7} Ctrl+click to reset");
        }
        out.push_str("\nShift for fine adjustment");
        out
    }
}

/// Stores `v` (clamped to `spec`) into `value`, marking the response changed if it moved.
pub(crate) fn apply<T: super::SliderNumeric>(value: &mut T, spec: &ValueSpec, v: f32, response: &mut Response) {
    let nv = T::from_f32(spec.clamp(v));
    if nv.to_f32() != value.to_f32() {
        *value = nv;
        response.mark_changed();
    }
}

/// The inline field while a value is being typed.
#[derive(Clone, Debug, Default)]
pub(crate) struct ValueEntry {
    pub(crate) id: Option<Id>,
    pub(crate) text: String,
    /// The first keystroke replaces the whole text (it starts selected).
    pub(crate) replace: bool,
}

/// What the keyboard and modifiers asked a focused numeric widget to do this frame.
pub(crate) enum KeyAction {
    None,
    Set(f32),
    /// Open the inline field, pre-filled with this text (empty = the current value, selected).
    BeginEntry(String),
}

/// Double-click detection shared by the numeric widgets: true on the second primary press on
/// the same widget within `DOUBLE_CLICK_SECONDS`.
pub(crate) fn double_clicked(ctx: &Context, response: &Response) -> bool {
    if !(response.hovered() && ctx.input(|i| i.pointer.primary_pressed)) {
        return false;
    }
    let now = ctx.time();
    let is_double = ctx.memory_mut(|m| {
        let hit = matches!(m.last_click, Some((id, t)) if id == response.id && now - t <= DOUBLE_CLICK_SECONDS);
        m.last_click = if hit { None } else { Some((response.id, now)) };
        hit
    });
    is_double
}

/// Ctrl/Cmd/Alt held on this frame's press: the reset gesture.
pub(crate) fn reset_click(ctx: &Context, response: &Response) -> bool {
    response.hovered() && ctx.input(|i| i.pointer.primary_pressed && (i.modifiers.ctrl || i.modifiers.command || i.modifiers.alt))
}

/// Keyboard handling for a focused numeric widget.
pub(crate) fn keys(ctx: &Context, spec: &ValueSpec, value: f32) -> KeyAction {
    let fine = ctx.input(|i| i.modifiers.shift);
    let step = spec.step() * if fine { 0.1 } else { 1.0 };
    let mut v = value;
    let mut moved = false;
    for (key, delta) in [(Key::ArrowUp, step), (Key::ArrowRight, step), (Key::ArrowDown, -step), (Key::ArrowLeft, -step), (Key::PageUp, step * 10.0), (Key::PageDown, -step * 10.0)] {
        if ctx.consume_key(key) {
            v += delta;
            moved = true;
        }
    }
    if spec.bounded() {
        if ctx.consume_key(Key::Home) {
            v = spec.min;
            moved = true;
        }
        if ctx.consume_key(Key::End) {
            v = spec.max;
            moved = true;
        }
    }
    if moved {
        return KeyAction::Set(spec.clamp(v));
    }
    if let Some(d) = spec.default {
        if ctx.consume_key(Key::Delete) || ctx.consume_key(Key::Backspace) {
            return KeyAction::Set(spec.clamp(d));
        }
    }
    if ctx.consume_key(Key::Enter) {
        return KeyAction::BeginEntry(String::new());
    }
    // Typing a number starts an entry with that keystroke, like a spreadsheet cell.
    let typed = ctx.input(|i| i.text_input.clone());
    if !typed.is_empty() && typed.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-' || c == ',') {
        return KeyAction::BeginEntry(typed);
    }
    KeyAction::None
}

pub(crate) fn entry_active(ctx: &Context, id: Id) -> bool {
    ctx.memory(|m| m.value_entry.id == Some(id))
}

pub(crate) fn begin_entry(ctx: &Context, id: Id, spec: &ValueSpec, value: f32, initial: String) {
    let (text, replace) = if initial.is_empty() { (spec.format_number(value), true) } else { (initial, false) };
    ctx.memory_mut(|m| m.value_entry = ValueEntry { id: Some(id), text, replace });
    ctx.request_focus(id, ctx.focus_visible());
}

/// Draws the inline field over `rect` and handles its keys. Returns the committed value, or
/// `Some(None)` when the entry ended without a value (Escape, or text that is not a number).
pub(crate) fn show_entry(ui: &Ui, response: &Response, rect: Rect, spec: &ValueSpec) -> Option<Option<f32>> {
    let ctx = ui.ctx();
    let id = response.id;
    let mut entry = ctx.memory(|m| m.value_entry.clone());

    // While typing, the widget is a text entry: app shortcuts stand down and Escape is ours.
    let mut r = response.clone();
    ui.focus_with(&mut r, FocusOptions { activate: false, text: true, selected: false, ring: false });

    let mut done: Option<Option<f32>> = None;
    let typed = ctx.input(|i| i.text_input.clone());
    if !typed.is_empty() {
        if entry.replace {
            entry.text.clear();
        }
        entry.text.push_str(&typed);
        entry.replace = false;
    }
    if ctx.consume_key(Key::Backspace) {
        if entry.replace {
            entry.text.clear();
        } else {
            entry.text.pop();
        }
        entry.replace = false;
    }
    if ctx.consume_key(Key::Enter) || ctx.consume_key(Key::Tab) {
        done = Some(spec.parse(&entry.text));
    }
    if ctx.consume_key(Key::Escape) {
        done = Some(None);
    }
    for key in [Key::ArrowUp, Key::ArrowDown, Key::ArrowLeft, Key::ArrowRight, Key::Space, Key::Delete, Key::Home, Key::End, Key::PageUp, Key::PageDown] {
        ctx.consume_key(key);
    }
    // A press anywhere else commits, like leaving a spreadsheet cell.
    let pressed_elsewhere = ctx.input(|i| i.pointer.primary_pressed && i.pointer.pos.map_or(false, |p| !rect.contains(p)));
    if done.is_none() && pressed_elsewhere {
        done = Some(spec.parse(&entry.text));
    }
    // Focus moved away some other way (a window closed): drop the entry.
    if done.is_none() && !ctx.has_focus(id) {
        done = Some(None);
    }

    let visuals = ui.visuals();
    let font = FontId::proportional(12.0);
    let shown = if spec.unit.is_empty() { entry.text.clone() } else { format!("{} {}", entry.text, spec.unit) };
    // Wide enough for what is typed, centered on the widget, so "20000 Hz" never spills out.
    let need = crate::entropy_gui::painter::Painter::measure_text(ctx, font, &shown).x + 14.0;
    let rect = if need > rect.width() { Rect::from_center_size(rect.center(), crate::entropy_gui::geometry::vec2(need, rect.height())) } else { rect };
    let painter = ui.painter();
    painter.rect_filled(rect, 3u8, visuals.extreme_bg_color);
    painter.rect_stroke(rect, 3u8, Stroke::new(1.5, visuals.selection.stroke.color), StrokeKind::Middle);
    let text_color = visuals.override_text_color.unwrap_or(Color32::from_gray(235));
    let text_rect = painter.with_clip_rect(rect.shrink(2.0)).text(pos2(rect.center().x, rect.center().y), Align2::CENTER_CENTER, &shown, font, text_color);
    if entry.replace {
        // "Selected" text: the first keystroke replaces it.
        painter.rect_filled(text_rect.expand(1.0), 2u8, visuals.selection.bg_fill.linear_multiply(0.6));
        painter.with_clip_rect(rect.shrink(2.0)).text(pos2(rect.center().x, rect.center().y), Align2::CENTER_CENTER, &shown, font, text_color);
    } else {
        let digits_w = crate::entropy_gui::painter::Painter::measure_text(ctx, font, &entry.text).x;
        let x = text_rect.min.x + digits_w + 1.0;
        let blink = (ctx.time() * 1.9).fract() < 0.6;
        if blink {
            painter.line_segment([pos2(x, rect.center().y - 6.0), pos2(x, rect.center().y + 6.0)], Stroke::new(1.2, text_color));
        }
    }

    if done.is_some() {
        ctx.memory_mut(|m| m.value_entry = ValueEntry::default());
    } else {
        ctx.memory_mut(|m| m.value_entry = entry);
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hz() -> ValueSpec {
        ValueSpec { min: 20.0, max: 20000.0, default: Some(1000.0), unit: "Hz".into(), ..Default::default() }
    }

    #[test]
    fn parses_with_or_without_the_unit_and_with_scale_suffixes() {
        let s = hz();
        assert_eq!(s.parse("440"), Some(440.0));
        assert_eq!(s.parse("440 Hz"), Some(440.0));
        assert_eq!(s.parse(" 440hz "), Some(440.0));
        assert_eq!(s.parse("2.5k"), Some(2500.0));
        assert_eq!(s.parse("1,5k"), Some(1500.0));
        assert_eq!(s.parse("abc"), None);
    }

    #[test]
    fn typed_values_are_clamped_to_the_range() {
        let s = hz();
        assert_eq!(s.parse("5"), Some(20.0));
        assert_eq!(s.parse("99k"), Some(20000.0));
    }

    #[test]
    fn formats_with_the_unit() {
        let s = hz();
        assert_eq!(s.format(440.0), "440 Hz");
        assert_eq!(s.format(440.5), "440.50 Hz");
        let pct = ValueSpec { unit: "%".into(), ..Default::default() };
        assert_eq!(pct.format(50.0), "50%");
    }

    #[test]
    fn integer_values_round() {
        let s = ValueSpec { min: 0.0, max: 10.0, integer: true, ..Default::default() };
        assert_eq!(s.parse("3.6"), Some(4.0));
        assert_eq!(s.step(), 1.0);
    }

    #[test]
    fn the_default_step_is_a_hundredth_of_the_range() {
        assert!((hz().step() - 199.8).abs() < 1e-3);
        assert_eq!(ValueSpec::default().step(), 1.0);
    }
}
