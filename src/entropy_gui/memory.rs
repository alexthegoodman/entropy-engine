//! Persistent per-widget state, keyed by `Id`. A small closed enum rather than a generic
//! `Any`-boxed store — the set of stateful widgets in this app is small and fully known.

use crate::entropy_gui::geometry::{Pos2, Rect, Vec2};
use crate::entropy_gui::id::{Id, IdMap};

#[derive(Clone, Debug)]
pub struct TextEditState {
    pub cursor: usize,
    pub selection_anchor: Option<usize>,
    pub blink_on: bool,
    pub blink_timer: f32,
}

impl Default for TextEditState {
    fn default() -> Self {
        Self { cursor: 0, selection_anchor: None, blink_on: true, blink_timer: 0.0 }
    }
}

#[derive(Clone, Debug)]
pub enum WidgetState {
    ScrollOffset(Vec2),
    Open(bool),
    TextEdit(TextEditState),
    WindowRect(Rect),
    PanelWidth(f32),
}

#[derive(Default)]
pub struct Memory {
    data: IdMap<WidgetState>,
    pub focused: Option<Id>,
    pub popup_open: Option<Id>,
    pub popup_pos: Pos2,
    /// At most one widget can be "the" active drag application-wide at a time — sufficient
    /// for every custom-painted drag interaction in this app (timeline clips/keyframes,
    /// splitters, window chrome), so no per-widget drag state is needed.
    pub active_drag: Option<Id>,
    pub drag_origin: Pos2,
}

impl Memory {
    pub fn get_scroll(&self, id: Id) -> Vec2 {
        match self.data.get(&id) {
            Some(WidgetState::ScrollOffset(v)) => *v,
            _ => Vec2::ZERO,
        }
    }
    pub fn set_scroll(&mut self, id: Id, v: Vec2) {
        self.data.insert(id, WidgetState::ScrollOffset(v));
    }

    pub fn get_open(&self, id: Id, default: bool) -> bool {
        match self.data.get(&id) {
            Some(WidgetState::Open(b)) => *b,
            _ => default,
        }
    }
    pub fn set_open(&mut self, id: Id, open: bool) {
        self.data.insert(id, WidgetState::Open(open));
    }
    pub fn toggle_open(&mut self, id: Id, default: bool) {
        let cur = self.get_open(id, default);
        self.set_open(id, !cur);
    }

    pub fn get_text_edit(&self, id: Id) -> TextEditState {
        match self.data.get(&id) {
            Some(WidgetState::TextEdit(s)) => s.clone(),
            _ => TextEditState::default(),
        }
    }
    pub fn set_text_edit(&mut self, id: Id, s: TextEditState) {
        self.data.insert(id, WidgetState::TextEdit(s));
    }

    pub fn get_window_rect(&self, id: Id, default: Rect) -> Rect {
        match self.data.get(&id) {
            Some(WidgetState::WindowRect(r)) => *r,
            _ => default,
        }
    }
    pub fn set_window_rect(&mut self, id: Id, r: Rect) {
        self.data.insert(id, WidgetState::WindowRect(r));
    }

    pub fn get_panel_width(&self, id: Id, default: f32) -> f32 {
        match self.data.get(&id) {
            Some(WidgetState::PanelWidth(w)) => *w,
            _ => default,
        }
    }
    pub fn set_panel_width(&mut self, id: Id, w: f32) {
        self.data.insert(id, WidgetState::PanelWidth(w));
    }
}
