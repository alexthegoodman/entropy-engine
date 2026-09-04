//! `Ui` — cursor/layout/child-region plumbing. Deliberately the simple egui layout model
//! (a `max_rect` the `Ui` is allowed to paint into, plus a `cursor`/`Layout` direction) —
//! this app only ever uses `horizontal`/`vertical`/`vertical_centered`/`with_layout(right_to_left)`,
//! so no general flexbox is needed.

use crate::entropy_gui::context::{Context, Key, KeyEvent, Modifiers, PlatformOutput, RawInput};
use crate::entropy_gui::geometry::{pos2, vec2, Align, Direction, Layout, Pos2, Rect, Vec2};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::{DrawTarget, Painter};
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::style::{Style, Visuals, WidgetVisuals};

pub struct InnerResponse<R> {
    pub inner: R,
    pub response: Response,
}

pub struct Ui {
    pub(crate) ctx: Context,
    id: Id,
    max_rect: Rect,
    cursor: Pos2,
    layout: Layout,
    min_rect: Rect,
    pub(crate) clip_rect: Rect,
    pub(crate) draw_target: DrawTarget,
    next_auto_id_source: u64,
}

fn draw_target_kind(t: DrawTarget) -> DrawTarget {
    t
}

impl Ui {
    pub(crate) fn new(ctx: Context, id: Id, max_rect: Rect, layout: Layout, clip_rect: Rect, draw_target: DrawTarget) -> Self {
        let cursor = match layout.main_dir {
            Direction::RightToLeft => pos2(max_rect.max.x, max_rect.min.y),
            _ => max_rect.min,
        };
        Self { ctx, id, max_rect, cursor, layout, min_rect: Rect::NOTHING, clip_rect, draw_target, next_auto_id_source: 0 }
    }

    pub fn id(&self) -> Id {
        self.id
    }

    pub fn push_id(&mut self, salt: impl std::hash::Hash) {
        self.id = self.id.with(salt);
    }

    pub fn ctx(&self) -> &Context {
        &self.ctx
    }

    pub fn style(&self) -> Style {
        self.ctx.style()
    }

    pub fn visuals(&self) -> Visuals {
        self.style().visuals
    }

    pub fn interactive_visuals(&self, hovered: bool, active: bool) -> WidgetVisuals {
        let v = self.visuals();
        if active {
            v.widgets.active
        } else if hovered {
            v.widgets.hovered
        } else {
            v.widgets.inactive
        }
    }

    pub fn painter(&self) -> Painter {
        Painter::new(self.ctx.clone(), self.clip_rect, draw_target_kind(self.draw_target))
    }

    pub fn max_rect(&self) -> Rect {
        self.max_rect
    }

    fn used_rect(&self) -> Rect {
        if self.min_rect == Rect::NOTHING {
            Rect::from_min_size(self.cursor, Vec2::ZERO)
        } else {
            self.min_rect
        }
    }

    pub fn min_rect(&self) -> Rect {
        self.used_rect()
    }

    fn grow_min_rect(&mut self, rect: Rect) {
        self.min_rect = if self.min_rect == Rect::NOTHING {
            rect
        } else {
            Rect::from_min_max(
                pos2(self.min_rect.min.x.min(rect.min.x), self.min_rect.min.y.min(rect.min.y)),
                pos2(self.min_rect.max.x.max(rect.max.x), self.min_rect.max.y.max(rect.max.y)),
            )
        };
    }

    /// The rect still available for placing content without overlapping anything already
    /// placed in this `Ui` (used by `ui.available_rect_before_wrap`/`available_size`, and to
    /// size nested `horizontal`/`vertical` child regions).
    pub fn available_rect_before_wrap(&self) -> Rect {
        match self.layout.main_dir {
            Direction::LeftToRight => Rect::from_min_max(pos2(self.cursor.x, self.max_rect.min.y), self.max_rect.max),
            Direction::RightToLeft => Rect::from_min_max(self.max_rect.min, pos2(self.cursor.x, self.max_rect.max.y)),
            Direction::TopDown => Rect::from_min_max(pos2(self.max_rect.min.x, self.cursor.y), self.max_rect.max),
        }
    }

    pub fn available_size(&self) -> Vec2 {
        self.available_rect_before_wrap().size()
    }

    pub fn available_width(&self) -> f32 {
        self.available_size().x
    }

    pub fn set_min_height(&mut self, h: f32) {
        self.max_rect.max.y = self.max_rect.max.y.max(self.max_rect.min.y + h);
    }

    /// Allocates `size` at the cursor along the layout's main axis, applying cross-axis
    /// alignment within `max_rect`, and advances the cursor.
    pub fn allocate_space(&mut self, size: Vec2) -> Rect {
        let spacing = self.style().spacing.item_spacing;
        let rect = match self.layout.main_dir {
            Direction::LeftToRight => {
                let y = match self.layout.cross_align {
                    Align::Center => self.max_rect.min.y + (self.max_rect.height() - size.y) / 2.0,
                    Align::Max => self.max_rect.max.y - size.y,
                    Align::Min => self.cursor.y,
                };
                let r = Rect::from_min_size(pos2(self.cursor.x, y), size);
                self.cursor.x += size.x + spacing.x;
                r
            }
            Direction::RightToLeft => {
                let y = match self.layout.cross_align {
                    Align::Center => self.max_rect.min.y + (self.max_rect.height() - size.y) / 2.0,
                    Align::Max => self.max_rect.max.y - size.y,
                    Align::Min => self.cursor.y,
                };
                let r = Rect::from_min_size(pos2(self.cursor.x - size.x, y), size);
                self.cursor.x -= size.x + spacing.x;
                r
            }
            Direction::TopDown => {
                let x = match self.layout.cross_align {
                    Align::Center => self.max_rect.min.x + (self.max_rect.width() - size.x) / 2.0,
                    Align::Max => self.max_rect.max.x - size.x,
                    Align::Min => self.cursor.x,
                };
                let r = Rect::from_min_size(pos2(x, self.cursor.y), size);
                self.cursor.y += size.y + spacing.y;
                r
            }
        };
        self.grow_min_rect(rect);
        rect
    }

    pub fn add_space(&mut self, amount: f32) {
        match self.layout.main_dir {
            Direction::LeftToRight => self.cursor.x += amount,
            Direction::RightToLeft => self.cursor.x -= amount,
            Direction::TopDown => self.cursor.y += amount,
        }
    }

    /// A stable-enough id for an unlabeled/repeatable widget: this `Ui`'s id salted with
    /// `salt` (typically the widget's label text) plus a per-`Ui` call counter, so
    /// same-labeled repeated widgets (e.g. addon-generated rows) don't collide.
    pub fn next_auto_id(&mut self, salt: impl std::hash::Hash) -> Id {
        let id = self.id.with(&salt).with(self.next_auto_id_source);
        self.next_auto_id_source += 1;
        id
    }

    pub fn interact(&self, rect: Rect, id: Id, sense: Sense) -> Response {
        interact(&self.ctx, rect, id, sense)
    }

    pub fn allocate_response(&mut self, size: Vec2, sense: Sense) -> (Rect, Response) {
        let rect = self.allocate_space(size);
        let id = self.next_auto_id("widget");
        (rect, interact(&self.ctx, rect, id, sense))
    }

    pub fn allocate_exact_size(&mut self, size: Vec2, sense: Sense) -> (Rect, Response) {
        self.allocate_response(size, sense)
    }

    pub fn allocate_painter(&mut self, size: Vec2, sense: Sense) -> (Response, Painter) {
        let (rect, response) = self.allocate_response(size, sense);
        let painter = Painter::new(self.ctx.clone(), self.clip_rect.intersect(rect), draw_target_kind(self.draw_target));
        (response, painter)
    }

    fn child_region(&self) -> Rect {
        self.available_rect_before_wrap()
    }

    pub fn layout_direction(&self) -> Direction {
        self.layout.main_dir
    }

    pub(crate) fn advance_after_child(&mut self, used: Rect) {
        let spacing = self.style().spacing.item_spacing;
        match self.layout.main_dir {
            Direction::LeftToRight => self.cursor.x += used.width().max(0.0) + spacing.x,
            Direction::RightToLeft => self.cursor.x -= used.width().max(0.0) + spacing.x,
            Direction::TopDown => self.cursor.y += used.height().max(0.0) + spacing.y,
        }
        self.grow_min_rect(used);
    }

    pub fn with_layout<R>(&mut self, layout: Layout, add_contents: impl FnOnce(&mut Ui) -> R) -> InnerResponse<R> {
        let mut region = self.child_region();
        // `child_region()` extends all the way to this Ui's bottom edge, which is fine for a
        // TopDown child (cross-axis is Min-aligned so it doesn't matter) but wrong for a
        // LeftToRight/RightToLeft row: `allocate_space`'s Align::Center/Max cross-axis
        // placement centers within `max_rect.height()`, so an unclamped region would center
        // the row's content across the *entire remaining panel height* instead of one row.
        // Clamp to a single row's height as a single-pass estimate.
        if matches!(layout.main_dir, Direction::LeftToRight | Direction::RightToLeft) {
            let row_height = self.style().spacing.interact_size.y;
            region.max.y = region.min.y + row_height;
        }
        let mut child = Ui::new(self.ctx.clone(), self.next_auto_id("child"), region, layout, self.clip_rect, self.draw_target);
        let inner = add_contents(&mut child);
        let used = child.used_rect();
        self.advance_after_child(used);
        let resp_id = self.next_auto_id("child_resp");
        InnerResponse { inner, response: interact(&self.ctx, used, resp_id, Sense::hover()) }
    }

    pub fn horizontal<R>(&mut self, add_contents: impl FnOnce(&mut Ui) -> R) -> InnerResponse<R> {
        self.with_layout(Layout::left_to_right(Align::Center), add_contents)
    }

    pub fn vertical<R>(&mut self, add_contents: impl FnOnce(&mut Ui) -> R) -> InnerResponse<R> {
        self.with_layout(Layout::top_down(Align::Min), add_contents)
    }

    pub fn vertical_centered<R>(&mut self, add_contents: impl FnOnce(&mut Ui) -> R) -> InnerResponse<R> {
        self.with_layout(Layout::top_down(Align::Center), add_contents)
    }

    /// Draws a thin border framing the closure's content. The border is painted after the
    /// content (a stroke only, so drawing "on top" reads fine visually) since its final size
    /// isn't known until the content has been laid out — a deliberate single-pass simplification.
    pub fn group<R>(&mut self, add_contents: impl FnOnce(&mut Ui) -> R) -> InnerResponse<R> {
        let margin = 6.0;
        let region = self.child_region();
        let inner_rect = region.shrink(margin);
        let mut child = Ui::new(self.ctx.clone(), self.next_auto_id("group"), inner_rect, Layout::top_down(Align::Min), self.clip_rect, self.draw_target);
        let inner = add_contents(&mut child);
        let used = child.used_rect().expand(margin);
        let visuals = self.visuals();
        self.painter().rect_stroke(used, visuals.widgets.noninteractive.corner_radius, visuals.widgets.noninteractive.bg_stroke, crate::entropy_gui::geometry::StrokeKind::Middle);
        self.advance_after_child(used);
        let resp_id = self.next_auto_id("group_resp");
        InnerResponse { inner, response: interact(&self.ctx, used, resp_id, Sense::hover()) }
    }

    /// Builds a fresh `Ui` rooted at an arbitrary rect, independent of this `Ui`'s cursor —
    /// used by panels/windows/dock leaves to hand a content region to a closure.
    pub fn child_ui_at(&self, rect: Rect, layout: Layout, id_salt: impl std::hash::Hash) -> Ui {
        Ui::new(self.ctx.clone(), self.id.with(id_salt), rect, layout, self.clip_rect.intersect(rect), self.draw_target)
    }

    pub fn input<R>(&self, reader: impl FnOnce(&RawInput) -> R) -> R {
        self.ctx.input(reader)
    }

    pub fn output_mut<R>(&self, writer: impl FnOnce(&mut PlatformOutput) -> R) -> R {
        self.ctx.output_mut(writer)
    }

    pub fn close_menu(&self) {
        self.ctx.memory_mut(|m| m.popup_open = None);
    }
}

/// Shared hit-testing + drag-state logic for `ui.interact`/`allocate_response`.
pub(crate) fn interact(ctx: &Context, rect: Rect, id: Id, sense: Sense) -> Response {
    let input = ctx.input(|i| i.clone());
    let hovered = input.pointer.pos.map_or(false, |p| rect.contains(p));

    let clicked = sense.click && hovered && input.pointer.primary_pressed;
    let secondary_clicked = hovered && input.pointer.secondary_pressed;

    let (dragging, drag_started, drag_stopped, drag_delta) = ctx.memory_mut(|m| {
        if !sense.drag {
            return (false, false, false, Vec2::ZERO);
        }
        if m.active_drag == Some(id) {
            let mut delta = Vec2::ZERO;
            if let Some(p) = input.pointer.pos {
                delta = p - m.drag_origin;
                m.drag_origin = p;
            }
            let stopped = input.pointer.primary_released || !input.pointer.primary_down;
            if stopped {
                m.active_drag = None;
            }
            (!stopped, false, stopped, delta)
        } else if hovered && input.pointer.primary_pressed && m.active_drag.is_none() {
            m.active_drag = Some(id);
            m.drag_origin = input.pointer.pos.unwrap_or_default();
            (true, true, false, Vec2::ZERO)
        } else {
            (false, false, false, Vec2::ZERO)
        }
    });

    let interact_pointer_pos = if hovered || dragging { input.pointer.pos } else { None };

    Response {
        ctx: ctx.clone(),
        id,
        rect,
        hovered,
        clicked,
        secondary_clicked,
        dragged: dragging,
        drag_started,
        drag_stopped,
        drag_delta,
        interact_pointer_pos,
        changed: false,
    }
}
