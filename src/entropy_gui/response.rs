//! `Response` + `Sense` — the interaction-result API returned by every widget/`ui.interact`.

use crate::entropy_gui::context::Context;
use crate::entropy_gui::geometry::{Pos2, Rect, Vec2};
use crate::entropy_gui::id::Id;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Sense {
    pub click: bool,
    pub drag: bool,
}

impl Sense {
    pub fn hover() -> Self {
        Self { click: false, drag: false }
    }
    pub fn click() -> Self {
        Self { click: true, drag: false }
    }
    pub fn drag() -> Self {
        Self { click: false, drag: true }
    }
    pub fn click_and_drag() -> Self {
        Self { click: true, drag: true }
    }
}

#[derive(Clone)]
pub struct Response {
    pub(crate) ctx: Context,
    pub id: Id,
    pub rect: Rect,
    pub(crate) hovered: bool,
    pub(crate) clicked: bool,
    pub(crate) secondary_clicked: bool,
    pub(crate) dragged: bool,
    pub(crate) drag_started: bool,
    pub(crate) drag_stopped: bool,
    pub(crate) drag_delta: Vec2,
    pub(crate) interact_pointer_pos: Option<Pos2>,
    pub(crate) changed: bool,
}

impl Response {
    pub fn clicked(&self) -> bool {
        self.clicked
    }
    pub fn secondary_clicked(&self) -> bool {
        self.secondary_clicked
    }
    pub fn hovered(&self) -> bool {
        self.hovered
    }
    pub fn changed(&self) -> bool {
        self.changed
    }
    pub fn dragged(&self) -> bool {
        self.dragged
    }
    pub fn drag_started(&self) -> bool {
        self.drag_started
    }
    pub fn drag_stopped(&self) -> bool {
        self.drag_stopped
    }
    pub fn drag_delta(&self) -> Vec2 {
        self.drag_delta
    }
    pub fn interact_pointer_pos(&self) -> Option<Pos2> {
        self.interact_pointer_pos
    }

    pub(crate) fn mark_changed(&mut self) {
        self.changed = true;
    }

    /// Combines interaction flags from `other` into `self` (used internally when a
    /// composite widget wraps a click target around more than one allocated rect).
    pub fn union(mut self, other: Response) -> Response {
        self.hovered |= other.hovered;
        self.clicked |= other.clicked;
        self.secondary_clicked |= other.secondary_clicked;
        self.dragged |= other.dragged;
        self.drag_started |= other.drag_started;
        self.drag_stopped |= other.drag_stopped;
        self.changed |= other.changed;
        if other.interact_pointer_pos.is_some() {
            self.interact_pointer_pos = other.interact_pointer_pos;
        }
        self.rect = Rect::from_min_max(
            crate::entropy_gui::geometry::pos2(self.rect.min.x.min(other.rect.min.x), self.rect.min.y.min(other.rect.min.y)),
            crate::entropy_gui::geometry::pos2(self.rect.max.x.max(other.rect.max.x), self.rect.max.y.max(other.rect.max.y)),
        );
        self
    }

    /// Shows a tooltip while hovered. Drawn immediately (into the overlay layer) since we
    /// already know this frame's hover state by the time a widget returns its `Response`.
    pub fn on_hover_text(self, text: impl Into<String>) -> Self {
        if self.hovered {
            crate::entropy_gui::containers::tooltip::show_tooltip(&self.ctx, self.rect, text.into());
        }
        self
    }

    /// Opens a right-click popup menu anchored at the click position. A deliberately
    /// simplified single-level inline overlay (drawn late, dismissed by next-frame
    /// click-outside) rather than egui's full layered `Area`/popup subsystem — sufficient
    /// for every real call site in this app (all single-level, no nested submenus).
    pub fn context_menu(&self, add_contents: impl FnOnce(&mut crate::entropy_gui::ui::Ui)) {
        crate::entropy_gui::containers::context_menu::context_menu(&self.ctx, self.id, self.rect, self.secondary_clicked, add_contents);
    }
}
