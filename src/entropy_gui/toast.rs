//! Toasts: short status messages stacked in the bottom-right corner - "Saved", "Export 40%",
//! "Couldn't save - Retry". Any code with the `Context` can show one; the kit draws the stack at
//! the end of every frame, above everything else.
//!
//! A toast never takes keyboard focus when it appears, so typing and shortcuts carry on. Its
//! buttons are still reachable from the keyboard: the stack is its own layer, so F6 moves into it
//! and Tab moves between its buttons. Hovering a toast pauses its countdown.
//!
//! Toasts are keyed by a caller-chosen string id: showing a toast whose id is already on screen
//! replaces it in place, which is how a progress toast is updated and how a "Saving..." toast
//! turns into "Saved".

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::context::Context;
use crate::entropy_gui::geometry::{pos2, vec2, Align, Align2, FontId, Layout, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::{DrawTarget, Painter};
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::ui::{interact, Ui};
use crate::entropy_gui::widgets::Button;

const WIDTH: f32 = 320.0;
const MARGIN: f32 = 16.0;
const GAP: f32 = 8.0;
const MAX_VISIBLE: usize = 4;
const APPEAR_SECONDS: f32 = 0.18;
const MESSAGE_SIZE: f32 = 13.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ToastKind {
    #[default]
    Info,
    Success,
    Warning,
    Error,
}

impl ToastKind {
    pub fn parse(s: &str) -> Self {
        match s {
            "success" => Self::Success,
            "warning" => Self::Warning,
            "error" => Self::Error,
            _ => Self::Info,
        }
    }

    fn accent(self, theme_accent: Color32) -> Color32 {
        match self {
            Self::Info => theme_accent,
            Self::Success => Color32::from_rgb(90, 200, 120),
            Self::Warning => Color32::from_rgb(230, 180, 60),
            Self::Error => Color32::from_rgb(230, 90, 90),
        }
    }

    fn glyph(self) -> &'static str {
        match self {
            Self::Info => "\u{2139}",
            Self::Success => "\u{2713}",
            Self::Warning => "!",
            Self::Error => "\u{2715}",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Toast {
    /// Showing another toast with the same id replaces this one in place.
    pub id: String,
    pub message: String,
    pub kind: ToastKind,
    /// A button on the toast ("Undo", "Retry", "Cancel"). Clicking it reports
    /// `ToastEvent::Action` and dismisses the toast.
    pub action: Option<String>,
    /// `Some(0..=1)` draws a progress bar; `Some(negative)` an indeterminate one.
    pub progress: Option<f32>,
    /// Seconds on screen. `None` keeps it until it is dismissed or replaced (use it for progress
    /// and for errors the user has to see).
    pub duration: Option<f32>,
}

impl Toast {
    pub fn new(id: impl Into<String>, message: impl Into<String>) -> Self {
        Self { id: id.into(), message: message.into(), kind: ToastKind::Info, action: None, progress: None, duration: Some(4.0) }
    }
    pub fn kind(mut self, kind: ToastKind) -> Self {
        self.kind = kind;
        self
    }
    pub fn action(mut self, label: impl Into<String>) -> Self {
        self.action = Some(label.into());
        self
    }
    pub fn progress(mut self, p: f32) -> Self {
        self.progress = Some(p);
        self
    }
    pub fn duration(mut self, seconds: Option<f32>) -> Self {
        self.duration = seconds;
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToastEvent {
    /// The toast's action button was pressed.
    Action(String),
    /// The toast was closed with its close button (not when it timed out or was replaced).
    Dismissed(String),
}

struct Live {
    toast: Toast,
    /// Seconds left, when the toast has a duration.
    remaining: Option<f32>,
    /// 0..1 appearance animation.
    appear: f32,
    hovered: bool,
}

#[derive(Default)]
pub(crate) struct Toasts {
    live: Vec<Live>,
    events: Vec<ToastEvent>,
    /// Indeterminate progress bar phase.
    phase: f32,
    /// Where each toast and its action button were drawn last frame.
    layout: Vec<(String, Rect, Option<Rect>)>,
}

impl Toasts {
    pub(crate) fn tick(&mut self, dt: f32) {
        self.phase = (self.phase + dt * 0.8).fract();
        for t in &mut self.live {
            t.appear = (t.appear + dt / APPEAR_SECONDS).min(1.0);
            if !t.hovered {
                if let Some(r) = t.remaining.as_mut() {
                    *r -= dt;
                }
            }
        }
        self.live.retain(|t| t.remaining.map_or(true, |r| r > 0.0));
    }
}

impl Context {
    /// Shows `toast`, or updates the one already on screen with the same id (keeping its place in
    /// the stack and restarting its countdown).
    pub fn show_toast(&self, toast: Toast) {
        let mut inner = self.0.borrow_mut();
        let remaining = toast.duration;
        if let Some(live) = inner.toasts.live.iter_mut().find(|t| t.toast.id == toast.id) {
            live.toast = toast;
            live.remaining = remaining;
        } else {
            let appear = if inner.prefs.reduce_motion { 1.0 } else { 0.0 };
            inner.toasts.live.push(Live { toast, remaining, appear, hovered: false });
        }
    }

    pub fn dismiss_toast(&self, id: &str) {
        self.0.borrow_mut().toasts.live.retain(|t| t.toast.id != id);
    }

    /// The toasts on screen, oldest first.
    pub fn toasts(&self) -> Vec<Toast> {
        self.0.borrow().toasts.live.iter().map(|t| t.toast.clone()).collect()
    }

    /// Where each toast on screen was drawn last frame: (id, card, action button).
    pub fn toast_layout(&self) -> Vec<(String, Rect, Option<Rect>)> {
        self.0.borrow().toasts.layout.clone()
    }

    /// Button presses on toasts since the last call.
    pub fn take_toast_events(&self) -> Vec<ToastEvent> {
        std::mem::take(&mut self.0.borrow_mut().toasts.events)
    }
}

fn wrap(ctx: &Context, text: &str, font: FontId, max_w: f32) -> Vec<String> {
    let mut lines = Vec::new();
    for para in text.split('\n') {
        let mut line = String::new();
        for word in para.split_whitespace() {
            let candidate = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
            if !line.is_empty() && Painter::measure_text(ctx, font, &candidate).x > max_w {
                lines.push(std::mem::take(&mut line));
                line = word.to_string();
            } else {
                line = candidate;
            }
        }
        lines.push(line);
    }
    lines
}

/// Draws the stack. Called from `Context::end_frame`, after every other widget, so it sits on top.
pub(crate) fn show_toasts(ctx: &Context) {
    ctx.0.borrow_mut().toasts.layout.clear();
    let (toasts, phase, reduce_motion) = {
        let inner = ctx.0.borrow();
        let visible: Vec<(Toast, f32)> = inner.toasts.live.iter().rev().take(MAX_VISIBLE).map(|t| (t.toast.clone(), t.appear)).collect();
        (visible, inner.toasts.phase, inner.prefs.reduce_motion)
    };
    if toasts.is_empty() {
        return;
    }
    let screen = ctx.screen_rect();
    let style = ctx.style();
    let font = FontId::proportional(MESSAGE_SIZE);
    let text_color = style.visuals.override_text_color.unwrap_or(Color32::WHITE);
    let accent_theme = style.visuals.selection.stroke.color;
    let width = WIDTH.min(screen.width() - MARGIN * 2.0).max(160.0);

    let layer_id = Id::new("entropy_gui_toasts");
    let previous = ctx.enter_layer(layer_id);
    let mut bottom = screen.max.y - MARGIN;
    let mut hovered_ids = Vec::new();
    let mut actions = Vec::new();
    let mut dismissed = Vec::new();

    // Newest at the bottom, nearest the corner; older ones stack upward.
    for (toast, appear) in toasts {
        let tid = layer_id.with(&toast.id);
        let text_w = width - 36.0 - 30.0;
        let lines = wrap(ctx, &toast.message, font, text_w);
        let line_h = MESSAGE_SIZE + 5.0;
        let action_h = if toast.action.is_some() { 30.0 } else { 0.0 };
        let progress_h = if toast.progress.is_some() { 10.0 } else { 0.0 };
        let height = 14.0 + lines.len() as f32 * line_h + action_h + progress_h + 6.0;
        let slide = if reduce_motion { 0.0 } else { (1.0 - appear) * 24.0 };
        let rect = Rect::from_min_size(pos2(screen.max.x - MARGIN - width + slide, bottom - height), vec2(width, height));
        bottom -= height + GAP;
        let alpha = if reduce_motion { 1.0 } else { appear };

        let painter = Painter::new(ctx.clone(), Rect::everything(), DrawTarget::Popup);
        let accent = toast.kind.accent(accent_theme);
        painter.rect_filled(rect.translate(vec2(0.0, 3.0)), style.visuals.window_corner_radius, Color32::from_black_alpha((90.0 * alpha) as u8));
        painter.rect_filled(rect, style.visuals.window_corner_radius, style.visuals.window_fill.linear_multiply(alpha));
        painter.rect_stroke(rect, style.visuals.window_corner_radius, Stroke::new(1.0, style.visuals.window_stroke.color.linear_multiply(alpha)), StrokeKind::Middle);
        painter.rect_filled(Rect::from_min_size(pos2(rect.min.x + 1.0, rect.min.y + 6.0), vec2(3.0, height - 12.0)), 1u8, accent.linear_multiply(alpha));
        painter.text(pos2(rect.min.x + 20.0, rect.min.y + 7.0 + line_h / 2.0), Align2::CENTER_CENTER, toast.kind.glyph(), FontId::proportional(14.0), accent.linear_multiply(alpha));
        for (i, line) in lines.iter().enumerate() {
            painter.text(pos2(rect.min.x + 34.0, rect.min.y + 7.0 + i as f32 * line_h), Align2::LEFT_TOP, line, font, text_color.linear_multiply(alpha));
        }

        // The whole card: hover pauses the countdown, and it swallows clicks (it is a layer).
        let card = interact(ctx, rect, tid.with("card"), Sense::hover());
        if card.hovered() {
            hovered_ids.push(toast.id.clone());
        }


        let mut y = rect.min.y + 7.0 + lines.len() as f32 * line_h + 4.0;
        let mut action_rect = None;
        if let Some(label) = &toast.action {
            let row = Rect::from_min_size(pos2(rect.min.x + 30.0, y), vec2(width - 40.0, 26.0));
            let mut ui = Ui::new(ctx.clone(), tid.with("action"), row, Layout::left_to_right(Align::Center), row.expand(4.0), DrawTarget::Popup);
            let resp = ui.add(Button::new(label.as_str()));
            action_rect = Some(resp.rect);
            if resp.clicked() {
                actions.push(toast.id.clone());
            }
            y += action_h;
        }
        // Close button, top right. Registered after the action, so F6 into a toast lands on
        // "Undo"/"Retry" first.
        let close_rect = Rect::from_min_size(pos2(rect.max.x - 26.0, rect.min.y + 5.0), vec2(20.0, 20.0));
        let mut ui = Ui::new(ctx.clone(), tid, close_rect, Layout::top_down(Align::Min), close_rect.expand(4.0), DrawTarget::Popup);
        let close = ui.add(Button::new("\u{2715}").frame(false).min_size(vec2(20.0, 20.0))).on_hover_text("Dismiss");
        if close.clicked() {
            dismissed.push(toast.id.clone());
        }
        ctx.0.borrow_mut().toasts.layout.push((toast.id.clone(), rect, action_rect));
        if let Some(p) = toast.progress {
            let track = Rect::from_min_size(pos2(rect.min.x + 34.0, y + 2.0), vec2(width - 48.0, 4.0));
            painter.rect_filled(track, 2u8, style.visuals.widgets.inactive.bg_stroke.color.linear_multiply(alpha));
            let fill = if p >= 0.0 {
                Rect::from_min_size(track.min, vec2(track.width() * p.clamp(0.0, 1.0), track.height()))
            } else if reduce_motion {
                // A still bar reads as "working" without moving.
                Rect::from_min_size(pos2(track.min.x + track.width() * 0.3, track.min.y), vec2(track.width() * 0.4, track.height()))
            } else {
                let seg = track.width() * 0.3;
                let x = track.min.x - seg + (track.width() + seg) * phase;
                Rect::from_min_max(pos2(x.max(track.min.x), track.min.y), pos2((x + seg).min(track.max.x), track.max.y))
            };
            painter.rect_filled(fill, 2u8, accent.linear_multiply(alpha));
        }
        ctx.add_occluder(layer_id, rect);
    }
    ctx.leave_layer(previous);

    let mut inner = ctx.0.borrow_mut();
    for t in &mut inner.toasts.live {
        t.hovered = hovered_ids.contains(&t.toast.id);
    }
    for id in &actions {
        inner.toasts.events.push(ToastEvent::Action(id.clone()));
    }
    for id in &dismissed {
        inner.toasts.events.push(ToastEvent::Dismissed(id.clone()));
    }
    inner.toasts.live.retain(|t| !actions.contains(&t.toast.id) && !dismissed.contains(&t.toast.id));
}
