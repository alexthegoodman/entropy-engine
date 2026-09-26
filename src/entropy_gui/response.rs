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
    /// Has keyboard focus (set by `Ui::focus` for widgets that take part in Tab traversal).
    pub(crate) focused: bool,
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

    /// Whether this widget has keyboard focus.
    pub fn has_focus(&self) -> bool {
        self.focused
    }

    /// Gives this widget keyboard focus (with a visible ring when `visible`).
    pub fn request_focus(&self, visible: bool) {
        self.ctx.request_focus(self.id, visible);
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
        self.focused |= other.focused;
        if other.interact_pointer_pos.is_some() {
            self.interact_pointer_pos = other.interact_pointer_pos;
        }
        self.rect = Rect::from_min_max(
            crate::entropy_gui::geometry::pos2(self.rect.min.x.min(other.rect.min.x), self.rect.min.y.min(other.rect.min.y)),
            crate::entropy_gui::geometry::pos2(self.rect.max.x.max(other.rect.max.x), self.rect.max.y.max(other.rect.max.y)),
        );
        self
    }

    /// Shows a tooltip once the pointer has rested on the widget (or while it has keyboard
    /// focus) - see `containers::tooltip` for the timing rules.
    pub fn on_hover_text(self, text: impl Into<String>) -> Self {
        self.tooltip(text.into(), None)
    }

    /// `on_hover_text` plus the keyboard shortcut that does the same thing, drawn dimmer on the
    /// right: `on_hover_text_with_shortcut("Save version", "Ctrl+S")`.
    pub fn on_hover_text_with_shortcut(self, text: impl Into<String>, shortcut: impl Into<String>) -> Self {
        let shortcut = shortcut.into();
        self.tooltip(text.into(), if shortcut.is_empty() { None } else { Some(shortcut) })
    }

    fn tooltip(self, text: String, shortcut: Option<String>) -> Self {
        if text.is_empty() && shortcut.is_none() {
            return self;
        }
        if self.hovered {
            crate::entropy_gui::containers::tooltip::request(&self.ctx, self.id, self.rect, text, shortcut, false);
        } else if self.focused && self.ctx.focus_visible() {
            crate::entropy_gui::containers::tooltip::request(&self.ctx, self.id, self.rect, text, shortcut, true);
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
