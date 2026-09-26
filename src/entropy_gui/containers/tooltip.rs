//! Tooltips. `Response::on_hover_text` (and `on_hover_text_with_shortcut`) *request* a tooltip;
//! the kit decides at the end of the frame whether one shows:
//!
//! - after the pointer has rested on the widget for `UiPrefs::tooltip_delay`, so sweeping across
//!   a toolbar does not flash a trail of tips;
//! - immediately while tooltips are "warm" (one closed a moment ago), so moving along a row of
//!   icon buttons reads each one without waiting again;
//! - for the keyboard-focused widget too, so Tab can read an icon button's name;
//! - never while a button is held (a drag is in progress).
//!
//! The tip is placed below the widget, flipped above when there is no room, and clamped to the
//! screen. A shortcut is drawn right-aligned in a dimmer color, e.g. `Save version   Ctrl+S`.
//! Drawn into the `Popup` layer so it floats over a `Window`'s own body (see
//! `painter::DrawTarget::Popup`).

use crate::entropy_gui::color::Color32;
use crate::entropy_gui::context::Context;
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::{DrawTarget, Painter};

/// How long after a tooltip hides the next one still shows without the delay.
const WARM_SECONDS: f32 = 0.6;
const FONT_SIZE: f32 = 13.0;

#[derive(Clone, Debug)]
struct Request {
    id: Id,
    anchor: Rect,
    text: String,
    shortcut: Option<String>,
    /// Requested because the widget has keyboard focus, not because the pointer is on it.
    keyboard: bool,
}

#[derive(Default)]
pub(crate) struct TooltipState {
    request: Option<Request>,
    shown_for: Option<Id>,
    hover_id: Option<Id>,
    hover_time: f32,
    /// Seconds tooltips stay warm after one hides (counts down; 0 when cold, as at startup).
    warm_left: f32,
    dt: f32,
    /// What the tooltip drawn this frame says (text, then shortcut), for tests and scripted runs.
    shown_text: Option<String>,
}

impl TooltipState {
    pub(crate) fn begin_frame(&mut self, dt: f32) {
        self.dt = dt;
        self.request = None;
    }
}

/// Asks for a tooltip on `anchor`. A pointer request beats a keyboard-focus one.
pub(crate) fn request(ctx: &Context, id: Id, anchor: Rect, text: String, shortcut: Option<String>, keyboard: bool) {
    let mut inner = ctx.0.borrow_mut();
    if keyboard && inner.tooltip.request.as_ref().is_some_and(|r| !r.keyboard) {
        return;
    }
    inner.tooltip.request = Some(Request { id, anchor, text, shortcut, keyboard });
}

/// Kept for callers that draw a tip right away with no delay (a drag readout, say).
pub fn show_tooltip(ctx: &Context, anchor_rect: Rect, text: String) {
    paint(ctx, anchor_rect, &text, None);
}

pub(crate) fn end_frame(ctx: &Context) {
    let (req, delay) = {
        let mut inner = ctx.0.borrow_mut();
        let delay = inner.prefs.tooltip_delay;
        let dt = inner.tooltip.dt;
        let held = inner.input.pointer.primary_down || inner.input.pointer.secondary_down;
        let req = inner.tooltip.request.take().filter(|r| r.keyboard || !held);
        let st = &mut inner.tooltip;
        match &req {
            Some(r) if st.hover_id == Some(r.id) => st.hover_time += dt,
            Some(r) => {
                st.hover_id = Some(r.id);
                // Warm: a tip was just showing, so the neighbour's shows straight away.
                st.hover_time = if st.warm_left > 0.0 { delay } else { 0.0 };
            }
            None => {
                st.hover_id = None;
                st.hover_time = 0.0;
            }
        }
        (req, delay)
    };
    let mut inner_shown = None;
    if let Some(r) = req {
        let ready = ctx.0.borrow().tooltip.hover_time >= delay;
        if ready {
            paint(ctx, r.anchor, &r.text, r.shortcut.as_deref());
            inner_shown = Some(r.id);
            let text = match &r.shortcut {
                Some(s) => format!("{}  {}", r.text, s),
                None => r.text.clone(),
            };
            ctx.0.borrow_mut().tooltip.shown_text = Some(text);
        }
    }
    if inner_shown.is_none() {
        ctx.0.borrow_mut().tooltip.shown_text = None;
    }
    let mut inner = ctx.0.borrow_mut();
    let dt = inner.tooltip.dt;
    let st = &mut inner.tooltip;
    if inner_shown.is_some() {
        st.warm_left = WARM_SECONDS;
    } else {
        st.warm_left = (st.warm_left - dt).max(0.0);
    }
    st.shown_for = inner_shown;
}

impl Context {
    /// The text of the tooltip drawn in the last frame (followed by its shortcut), if one was.
    pub fn shown_tooltip(&self) -> Option<String> {
        self.0.borrow().tooltip.shown_text.clone()
    }
}

/// Where the tip goes: below `anchor`, above it if it would run off the bottom, and clamped
/// horizontally inside `screen`.
pub fn place(anchor: Rect, size: crate::entropy_gui::geometry::Vec2, screen: Rect) -> Rect {
    let gap = 6.0;
    let mut y = anchor.max.y + gap;
    if y + size.y > screen.max.y && anchor.min.y - gap - size.y >= screen.min.y {
        y = anchor.min.y - gap - size.y;
    }
    let y = y.clamp(screen.min.y, (screen.max.y - size.y).max(screen.min.y));
    let x = anchor.min.x.clamp(screen.min.x, (screen.max.x - size.x).max(screen.min.x));
    Rect::from_min_size(pos2(x, y), size)
}

fn paint(ctx: &Context, anchor: Rect, text: &str, shortcut: Option<&str>) {
    let style = ctx.style();
    let font = FontId::proportional(FONT_SIZE);
    let line_h = FONT_SIZE + 4.0;
    let lines: Vec<&str> = text.split('\n').collect();
    let text_w = lines.iter().map(|l| Painter::measure_text(ctx, font, l).x).fold(0.0, f32::max);
    let shortcut_w = shortcut.map_or(0.0, |s| Painter::measure_text(ctx, font, s).x + 18.0);
    let padding = vec2(8.0, 5.0);
    let size = vec2(text_w + shortcut_w, lines.len() as f32 * line_h - 4.0) + padding * 2.0;
    let rect = place(anchor, size, ctx.screen_rect());

    let painter = Painter::new(ctx.clone(), Rect::everything(), DrawTarget::Popup);
    painter.rect_filled(rect, style.visuals.window_corner_radius, style.visuals.window_fill);
    painter.rect_stroke(rect, style.visuals.window_corner_radius, style.visuals.window_stroke, StrokeKind::Middle);
    let color = style.visuals.override_text_color.unwrap_or(Color32::WHITE);
    for (i, line) in lines.iter().enumerate() {
        painter.text(pos2(rect.min.x + padding.x, rect.min.y + padding.y + i as f32 * line_h), Align2::LEFT_TOP, *line, font, color);
    }
    if let Some(s) = shortcut {
        painter.text(pos2(rect.max.x - padding.x, rect.min.y + padding.y), Align2::RIGHT_TOP, s, font, color.linear_multiply(0.55));
    }
}
