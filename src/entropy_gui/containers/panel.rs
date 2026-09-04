//! `CentralPanel` / `SidePanel` / `TopBottomPanel` / `Frame` — the well-known egui panel
//! algorithm: each panel, in call order, shrinks a shared "remaining screen rect" from its
//! declared edge and hands the claimed sliver to its closure. `CentralPanel` always runs
//! last per frame in this app (confirmed in `render_egui.rs`) and just takes whatever's left.

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::context::Context;
use crate::entropy_gui::geometry::{pos2, vec2, Align, CornerRadius, CursorIcon, Layout, Margin, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::{DrawTarget, Painter};
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::ui::{interact, InnerResponse, Ui};

#[derive(Clone, Copy, Debug, Default)]
pub struct Frame {
    pub fill: Color32,
    pub inner_margin: Margin,
    pub stroke: Stroke,
    pub corner_radius: CornerRadius,
}

impl Frame {
    pub fn none() -> Self {
        Self { fill: Color32::TRANSPARENT, inner_margin: Margin::default(), stroke: Stroke::NONE, corner_radius: CornerRadius::same(0) }
    }
    pub fn fill(mut self, c: Color32) -> Self {
        self.fill = c;
        self
    }
    pub fn inner_margin(mut self, m: f32) -> Self {
        self.inner_margin = Margin::same(m as i8);
        self
    }
    pub fn stroke(mut self, s: Stroke) -> Self {
        self.stroke = s;
        self
    }
    pub fn corner_radius(mut self, r: impl Into<CornerRadius>) -> Self {
        self.corner_radius = r.into();
        self
    }

    /// `Frame::show(ui, |ui| ...)` — wraps the *rest of the current `Ui`'s available region*
    /// (not just the closure's content) in this frame's fill/stroke/margin, matching real
    /// egui's usage in `src/core/video_timeline_ui.rs` (a frame that fills the panel).
    pub fn show<R>(self, ui: &mut Ui, add_contents: impl FnOnce(&mut Ui) -> R) -> InnerResponse<R> {
        let region = ui.available_rect_before_wrap();
        paint_frame_bg(ui.ctx(), region, &self);
        let content_rect = shrink_by_margin(region, self.inner_margin);
        let clip = ui.clip_rect.intersect(content_rect);
        let id = ui.next_auto_id("frame");
        let mut child = Ui::new(ui.ctx().clone(), id, content_rect, Layout::top_down(Align::Min), clip, ui.draw_target);
        let inner = add_contents(&mut child);
        ui.advance_after_child(region);
        let resp_id = ui.next_auto_id("frame_resp");
        InnerResponse { inner, response: interact(ui.ctx(), region, resp_id, Sense::hover()) }
    }
}

fn shrink_by_margin(rect: Rect, m: Margin) -> Rect {
    Rect::from_min_max(
        pos2(rect.min.x + m.left as f32, rect.min.y + m.top as f32),
        pos2(rect.max.x - m.right as f32, rect.max.y - m.bottom as f32),
    )
}

fn paint_frame_bg(ctx: &Context, rect: Rect, frame: &Frame) {
    let painter = Painter::new(ctx.clone(), rect, DrawTarget::Main);
    if frame.fill.a() > 0 {
        painter.rect_filled(rect, frame.corner_radius, frame.fill);
    }
    if frame.stroke.width > 0.0 {
        painter.rect_stroke(rect, frame.corner_radius, frame.stroke, StrokeKind::Middle);
    }
}

pub struct CentralPanel {
    frame: Option<Frame>,
}

impl CentralPanel {
    #[allow(clippy::should_implement_trait)]
    pub fn default() -> Self {
        Self { frame: None }
    }
    pub fn frame(mut self, f: Frame) -> Self {
        self.frame = Some(f);
        self
    }

    pub fn show<R>(self, ctx: &Context, add_contents: impl FnOnce(&mut Ui) -> R) -> InnerResponse<R> {
        let rect = ctx.take_used_rect();
        ctx.set_used_rect(Rect::from_min_size(rect.max, vec2(0.0, 0.0)));

        let style = ctx.style();
        let frame = self.frame.unwrap_or_else(|| Frame::none().fill(style.visuals.panel_fill));
        paint_frame_bg(ctx, rect, &frame);

        let content_rect = shrink_by_margin(rect, frame.inner_margin);
        let id = Id::new("central_panel");
        let mut ui = Ui::new(ctx.clone(), id, content_rect, Layout::top_down(Align::Min), content_rect, DrawTarget::Main);
        let inner = add_contents(&mut ui);
        InnerResponse { inner, response: interact(ctx, rect, id, Sense::hover()) }
    }
}

enum TopBottomSide {
    Top,
    Bottom,
}

pub struct TopBottomPanel {
    id: Id,
    side: TopBottomSide,
    frame: Option<Frame>,
    height: f32,
}

impl TopBottomPanel {
    pub fn top(id_source: impl std::hash::Hash) -> Self {
        Self { id: Id::new(id_source), side: TopBottomSide::Top, frame: None, height: 36.0 }
    }
    pub fn bottom(id_source: impl std::hash::Hash) -> Self {
        Self { id: Id::new(id_source), side: TopBottomSide::Bottom, frame: None, height: 36.0 }
    }
    pub fn frame(mut self, f: Frame) -> Self {
        self.frame = Some(f);
        self
    }
    pub fn default_height(mut self, h: f32) -> Self {
        self.height = h;
        self
    }

    pub fn show<R>(self, ctx: &Context, add_contents: impl FnOnce(&mut Ui) -> R) -> InnerResponse<R> {
        let rect = ctx.take_used_rect();
        let (strip, remaining) = match self.side {
            TopBottomSide::Top => (
                Rect::from_min_max(rect.min, pos2(rect.max.x, rect.min.y + self.height)),
                Rect::from_min_max(pos2(rect.min.x, rect.min.y + self.height), rect.max),
            ),
            TopBottomSide::Bottom => (
                Rect::from_min_max(pos2(rect.min.x, rect.max.y - self.height), rect.max),
                Rect::from_min_max(rect.min, pos2(rect.max.x, rect.max.y - self.height)),
            ),
        };
        ctx.set_used_rect(remaining);

        let style = ctx.style();
        let frame = self.frame.unwrap_or_else(|| Frame::none().fill(style.visuals.panel_fill));
        paint_frame_bg(ctx, strip, &frame);

        let content_rect = shrink_by_margin(strip, frame.inner_margin);
        let mut ui = Ui::new(ctx.clone(), self.id, content_rect, Layout::left_to_right(Align::Center), content_rect, DrawTarget::Main);
        let inner = add_contents(&mut ui);
        InnerResponse { inner, response: interact(ctx, strip, self.id, Sense::hover()) }
    }
}

enum Side {
    Left,
    Right,
}

pub struct SidePanel {
    id: Id,
    side: Side,
    resizable: bool,
    default_width: f32,
}

impl SidePanel {
    pub fn left(id_source: impl std::hash::Hash) -> Self {
        Self { id: Id::new(id_source), side: Side::Left, resizable: true, default_width: 200.0 }
    }
    pub fn right(id_source: impl std::hash::Hash) -> Self {
        Self { id: Id::new(id_source), side: Side::Right, resizable: true, default_width: 200.0 }
    }
    pub fn resizable(mut self, r: bool) -> Self {
        self.resizable = r;
        self
    }
    pub fn default_width(mut self, w: f32) -> Self {
        self.default_width = w;
        self
    }

    pub fn show<R>(self, ctx: &Context, add_contents: impl FnOnce(&mut Ui) -> R) -> InnerResponse<R> {
        let rect = ctx.take_used_rect();
        let width = if self.resizable { ctx.memory(|m| m.get_panel_width(self.id, self.default_width)) } else { self.default_width };

        let (strip, remaining, splitter_x) = match self.side {
            Side::Left => (
                Rect::from_min_max(rect.min, pos2(rect.min.x + width, rect.max.y)),
                Rect::from_min_max(pos2(rect.min.x + width, rect.min.y), rect.max),
                rect.min.x + width,
            ),
            Side::Right => (
                Rect::from_min_max(pos2(rect.max.x - width, rect.min.y), rect.max),
                Rect::from_min_max(rect.min, pos2(rect.max.x - width, rect.max.y)),
                rect.max.x - width,
            ),
        };
        ctx.set_used_rect(remaining);

        let style = ctx.style();
        let frame = Frame::none().fill(style.visuals.panel_fill);

        if self.resizable {
            let handle_rect = Rect::from_min_max(pos2(splitter_x - 3.0, rect.min.y), pos2(splitter_x + 3.0, rect.max.y));
            let resp = interact(ctx, handle_rect, self.id.with("splitter"), Sense::drag());
            if resp.dragged() {
                let delta = resp.drag_delta().x;
                let new_width = match self.side {
                    Side::Left => width + delta,
                    Side::Right => width - delta,
                };
                ctx.memory_mut(|m| m.set_panel_width(self.id, new_width.clamp(40.0, rect.width() - 40.0)));
            }
            if resp.hovered() || resp.dragged() {
                ctx.request_cursor_icon(CursorIcon::ResizeHorizontal);
            }
        }

        paint_frame_bg(ctx, strip, &frame);

        let content_rect = shrink_by_margin(strip, frame.inner_margin);
        let mut ui = Ui::new(ctx.clone(), self.id, content_rect, Layout::top_down(Align::Min), content_rect, DrawTarget::Main);
        let inner = add_contents(&mut ui);
        InnerResponse { inner, response: interact(ctx, strip, self.id, Sense::hover()) }
    }
}
