//! Keyboard focus: Tab/Shift+Tab traversal, a visible focus ring, Enter/Space activation,
//! Escape to dismiss, and focus returning to whatever opened a window or popup once it closes.
//!
//! Immediate mode has no retained widget tree to walk, so traversal works off the order widgets
//! *register* in: every focusable widget calls `Context::register_focusable` while it is drawn,
//! which appends it to this frame's list. Keys that move focus are resolved in `end_frame`, once
//! the list is complete, and the new focus is painted from the next frame on (one frame of
//! latency, the same delay the window occlusion list already has).
//!
//! Each entry remembers the layer it was drawn in (the base panels, or a `Window`/popup), and Tab
//! stays inside the current layer the way it stays inside the active dialog on a desktop. F6
//! moves between layers. A popup list (a `ComboBox` dropdown, a context menu) is a "menu layer":
//! Up/Down move through its rows as well.
//!
//! Focus is "visible" (a ring is drawn) only when the keyboard put it there, like CSS's
//! `:focus-visible`: clicking a button focuses it without drawing a ring on it.
//!
//! Widgets that manage `Memory::focused` on their own (the sheet grid's cell editor, the doc
//! editor) never register. Focus they hold is "foreign": the traversal keys leave it alone, and
//! it still counts as typing for `Context::wants_keyboard_input`.

use crate::entropy_gui::color::Stroke;
use crate::entropy_gui::context::{Context, Key};
use crate::entropy_gui::geometry::{Rect, StrokeKind};
use crate::entropy_gui::id::{Id, IdMap};
use crate::entropy_gui::painter::Painter;

#[derive(Clone, Copy, Debug)]
pub(crate) struct FocusEntry {
    pub(crate) id: Id,
    pub(crate) rect: Rect,
    /// `None` = the base layer.
    pub(crate) layer: Option<Id>,
    /// A text field (or a knob's typed-value field): it wants every key, including Escape.
    pub(crate) text: bool,
    /// The entry a popup should land on when it opens from the keyboard (its current choice).
    pub(crate) selected: bool,
}

#[derive(Default)]
pub(crate) struct FocusState {
    pub(crate) entries: Vec<FocusEntry>,
    pub(crate) prev_entries: Vec<FocusEntry>,
    /// Keyboard put the current focus there, so draw a ring.
    pub(crate) visible: bool,
    /// Pressed keys a widget already handled this frame, so the frame-level handling in
    /// `end_frame` (and any later widget) skips them.
    pub(crate) consumed: Vec<Key>,
    /// A focusable widget took this frame's pointer press. An unclaimed press blurs.
    pub(crate) press_claimed: bool,
    /// The last layer the pointer pressed in: where Tab starts when nothing is focused yet.
    pub(crate) active_layer: Option<Option<Id>>,
    pub(crate) menu_layers: Vec<Id>,
    pub(crate) windows: Vec<Id>,
    pub(crate) windows_prev: Vec<Id>,
    /// Window or popup id -> the widget that had focus when it opened.
    pub(crate) openers: IdMap<Id>,
    /// Put focus on the first (or selected) entry of this layer once it has been drawn.
    pub(crate) enter_layer: Option<Id>,
    /// Set when keyboard focus moves, so the scroll area holding it scrolls it into view.
    pub(crate) reveal: Option<Id>,
    pub(crate) reveal_rect: Option<Rect>,
    /// A widget activated from the keyboard this frame (Enter/Space), with its layer.
    pub(crate) activated: Option<(Id, Option<Id>)>,
}

impl FocusState {
    pub(crate) fn begin_frame(&mut self) {
        self.prev_entries = std::mem::take(&mut self.entries);
        self.windows_prev = std::mem::take(&mut self.windows);
        self.menu_layers.clear();
        self.consumed.clear();
        self.press_claimed = false;
        self.reveal_rect = None;
        self.activated = None;
    }

    fn entry(&self, id: Id) -> Option<&FocusEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    fn layer_entries(&self, layer: Option<Id>) -> Vec<FocusEntry> {
        self.entries.iter().filter(|e| e.layer == layer).copied().collect()
    }

    /// Distinct layers in first-registration order: base panels first, then windows in the
    /// order they were drawn (which is bottom-to-top).
    fn layers(&self) -> Vec<Option<Id>> {
        let mut out: Vec<Option<Id>> = Vec::new();
        for e in &self.entries {
            if !out.contains(&e.layer) {
                out.push(e.layer);
            }
        }
        out
    }
}

/// Where focus goes when Tab is pressed with nothing focused: the layer last clicked in if it has
/// focusable widgets, else an open popup, else the base layer, else whatever is first.
fn starting_layer(state: &FocusState) -> Option<Option<Id>> {
    let layers = state.layers();
    if let Some(menu) = state.menu_layers.last() {
        if layers.contains(&Some(*menu)) {
            return Some(Some(*menu));
        }
    }
    if let Some(active) = state.active_layer {
        if layers.contains(&active) {
            return Some(active);
        }
    }
    if layers.contains(&None) {
        return Some(None);
    }
    layers.first().copied()
}

/// The frame-level keyboard handling, run from `Context::end_frame` once every widget of the
/// frame has registered. `focused` is `Memory::focused`; `popup_open` is `Memory::popup_open`.
pub(crate) fn resolve(state: &mut FocusState, focused: &mut Option<Id>, popup_open: &mut Option<Id>, keys: &[crate::entropy_gui::context::KeyEvent], pointer_pressed: bool) {
    let registered = |state: &FocusState, id: Option<Id>| id.map_or(false, |id| state.entry(id).is_some());
    let foreign = focused.is_some() && !registered(state, *focused) && !state.prev_entries.iter().any(|e| Some(e.id) == *focused);

    // A widget that was focused last frame and was not drawn this frame is gone (its window
    // closed, its tab switched away). Its focus goes back to an opener below, or nowhere.
    if let Some(id) = *focused {
        if state.entry(id).is_none() && state.prev_entries.iter().any(|e| e.id == id) {
            *focused = None;
        }
    }

    // Closing a window or popup hands focus back to the widget that opened it.
    let closed: Vec<Id> = state.windows_prev.iter().filter(|w| !state.windows.contains(w)).copied().collect();
    for w in closed {
        if let Some(opener) = state.openers.remove(&w) {
            let focus_was_inside = focused.map_or(true, |f| state.entry(f).map_or(true, |e| e.layer == Some(w)));
            if focus_was_inside && state.entry(opener).is_some() {
                *focused = Some(opener);
            }
        }
    }

    if pointer_pressed {
        state.visible = false;
        if !state.press_claimed && registered(state, *focused) {
            *focused = None;
        }
    }

    if let Some(layer) = state.enter_layer {
        let in_layer = state.layer_entries(Some(layer));
        if let Some(target) = in_layer.iter().find(|e| e.selected).or(in_layer.first()) {
            *focused = Some(target.id);
            state.reveal = Some(target.id);
            state.visible = true;
            state.enter_layer = None;
        }
    }

    for ev in keys.iter().filter(|k| k.pressed) {
        if state.consumed.contains(&ev.key) {
            continue;
        }
        match ev.key {
            Key::Tab if !foreign => {
                let scope = match focused.and_then(|f| state.entry(f)) {
                    Some(e) => Some(e.layer),
                    None => starting_layer(state),
                };
                let Some(scope) = scope else { continue };
                let list = state.layer_entries(scope);
                if list.is_empty() {
                    continue;
                }
                let cur = focused.and_then(|f| list.iter().position(|e| e.id == f));
                let next = match (cur, ev.modifiers.shift) {
                    (Some(i), false) => (i + 1) % list.len(),
                    (Some(i), true) => (i + list.len() - 1) % list.len(),
                    (None, false) => 0,
                    (None, true) => list.len() - 1,
                };
                *focused = Some(list[next].id);
                state.reveal = Some(list[next].id);
                state.visible = true;
            }
            Key::F6 if !foreign => {
                let layers = state.layers();
                if layers.is_empty() {
                    continue;
                }
                let cur_layer = focused.and_then(|f| state.entry(f)).map(|e| e.layer);
                let idx = cur_layer.and_then(|l| layers.iter().position(|x| *x == l));
                let next = match (idx, ev.modifiers.shift) {
                    (Some(i), false) => (i + 1) % layers.len(),
                    (Some(i), true) => (i + layers.len() - 1) % layers.len(),
                    (None, _) => 0,
                };
                if let Some(first) = state.layer_entries(layers[next]).first() {
                    *focused = Some(first.id);
                    state.reveal = Some(first.id);
                    state.visible = true;
                }
            }
            Key::ArrowDown | Key::ArrowUp | Key::Home | Key::End if !foreign => {
                // Only inside a popup list: elsewhere the arrows belong to the focused widget
                // (a slider, a tab bar) or to the app.
                let Some(entry) = focused.and_then(|f| state.entry(f)).copied() else { continue };
                let Some(layer) = entry.layer.filter(|l| state.menu_layers.contains(l)) else { continue };
                let list = state.layer_entries(Some(layer));
                let i = list.iter().position(|e| e.id == entry.id).unwrap_or(0);
                let next = match ev.key {
                    Key::ArrowDown => (i + 1).min(list.len() - 1),
                    Key::ArrowUp => i.saturating_sub(1),
                    Key::Home => 0,
                    _ => list.len() - 1,
                };
                *focused = Some(list[next].id);
                state.reveal = Some(list[next].id);
                state.visible = true;
            }
            Key::Escape => {
                if let Some(popup) = popup_open.take() {
                    if let Some(opener) = state.openers.remove(&popup) {
                        *focused = Some(opener);
                        state.visible = true;
                    }
                } else if registered(state, *focused) {
                    *focused = None;
                }
            }
            _ => {}
        }
    }
}

/// The ring drawn around a keyboard-focused widget. Drawn just outside `rect` so it never covers
/// the widget's own content, in the theme's accent.
pub(crate) fn paint_focus_ring(painter: &Painter, rect: Rect, radius: impl Into<crate::entropy_gui::geometry::CornerRadius>) {
    let style = painter.ctx.style();
    let color = style.visuals.selection.stroke.color;
    let painter = painter.with_clip_rect(rect.expand(4.0));
    painter.rect_stroke(rect.expand(2.0), radius, Stroke::new(2.0, color), StrokeKind::Outside);
}

impl Context {
    /// True if `key` was pressed this frame and no widget has handled it yet.
    pub fn key_pressed(&self, key: Key) -> bool {
        let inner = self.0.borrow();
        !inner.focus.consumed.contains(&key) && inner.input.key_events.iter().any(|k| k.pressed && k.key == key)
    }

    /// Like `key_pressed`, but also marks the key handled so nothing after this widget (and none
    /// of the frame-level Tab/Escape handling) reacts to it too.
    pub fn consume_key(&self, key: Key) -> bool {
        let pressed = self.key_pressed(key);
        if pressed {
            self.0.borrow_mut().focus.consumed.push(key);
        }
        pressed
    }

    /// The modifiers held when `key` was pressed, if it was pressed this frame and is unhandled.
    pub fn key_modifiers(&self, key: Key) -> Option<crate::entropy_gui::context::Modifiers> {
        let inner = self.0.borrow();
        if inner.focus.consumed.contains(&key) {
            return None;
        }
        inner.input.key_events.iter().find(|k| k.pressed && k.key == key).map(|k| k.modifiers)
    }

    pub fn has_focus(&self, id: Id) -> bool {
        self.0.borrow().memory.focused == Some(id)
    }

    /// Gives `id` keyboard focus. `visible` draws the focus ring (use it when the keyboard, not
    /// the pointer, asked for this).
    pub fn request_focus(&self, id: Id, visible: bool) {
        let mut inner = self.0.borrow_mut();
        inner.memory.focused = Some(id);
        inner.focus.visible = visible;
        if visible {
            inner.focus.reveal = Some(id);
        }
    }

    pub fn surrender_focus(&self, id: Id) {
        let mut inner = self.0.borrow_mut();
        if inner.memory.focused == Some(id) {
            inner.memory.focused = None;
        }
    }

    /// Whether the focused widget got there from the keyboard.
    pub fn focus_visible(&self) -> bool {
        self.0.borrow().focus.visible
    }

    /// True while text is being typed into the GUI: a text field, a knob's typed value, a sheet
    /// cell or the doc editor has focus. An app's own single-key shortcuts should stand down.
    pub fn wants_keyboard_input(&self) -> bool {
        let inner = self.0.borrow();
        let Some(f) = inner.memory.focused else { return false };
        match inner.focus.entries.iter().chain(inner.focus.prev_entries.iter()).find(|e| e.id == f) {
            Some(e) => e.text,
            None => true,
        }
    }

    /// True while a non-text widget has keyboard focus that the keyboard put there: Tab, Enter,
    /// Space, Escape and the arrows are driving the GUI, not the app.
    pub fn keyboard_navigating(&self) -> bool {
        let inner = self.0.borrow();
        let Some(f) = inner.memory.focused else { return false };
        inner.focus.visible && inner.focus.entries.iter().chain(inner.focus.prev_entries.iter()).any(|e| e.id == f && !e.text)
    }

    /// Adds a widget to this frame's Tab order and returns whether it has focus. A primary press
    /// on `rect` focuses it (without a ring); `text` marks a widget that wants every key.
    pub(crate) fn register_focusable(&self, id: Id, rect: Rect, text: bool, selected: bool, pressed_here: bool) -> bool {
        let mut inner = self.0.borrow_mut();
        let layer = inner.layer.map(|l| l.id);
        inner.focus.entries.push(FocusEntry { id, rect, layer, text, selected });
        if pressed_here {
            inner.memory.focused = Some(id);
            inner.focus.press_claimed = true;
            inner.focus.visible = false;
        }
        let focused = inner.memory.focused == Some(id);
        if focused && inner.focus.reveal == Some(id) {
            inner.focus.reveal = None;
            inner.focus.reveal_rect = Some(rect);
        }
        focused
    }

    /// Marks the layer being built right now as a popup list (Up/Down move through it).
    pub(crate) fn mark_menu_layer(&self, layer: Id) {
        self.0.borrow_mut().focus.menu_layers.push(layer);
    }

    /// Records that window/popup `id` is on screen this frame. The first frame it appears, the
    /// focused widget is remembered as its opener (focus goes back there when it closes), and a
    /// keyboard user's focus moves into it.
    pub(crate) fn note_layer_shown(&self, id: Id, take_focus: bool) {
        let mut inner = self.0.borrow_mut();
        inner.focus.windows.push(id);
        if !inner.focus.windows_prev.contains(&id) {
            if let Some(opener) = inner.memory.focused {
                inner.focus.openers.insert(id, opener);
            }
            if take_focus && inner.focus.visible {
                inner.focus.enter_layer = Some(id);
            }
        }
    }

    /// Remembers `opener` as the widget focus returns to when popup `popup` closes.
    pub(crate) fn set_opener(&self, popup: Id, opener: Id) {
        self.0.borrow_mut().focus.openers.insert(popup, opener);
    }

    pub(crate) fn note_activated(&self, id: Id) {
        let mut inner = self.0.borrow_mut();
        let layer = inner.layer.map(|l| l.id);
        inner.focus.activated = Some((id, layer));
    }

    /// The widget Enter/Space activated this frame, if it was inside `layer`.
    pub(crate) fn activated_in_layer(&self, layer: Id) -> bool {
        matches!(self.0.borrow().focus.activated, Some((_, Some(l))) if l == layer)
    }

    /// How many focusable widgets have registered so far this frame. With `focused_since`, lets a
    /// container ask "is the focused widget one of mine?".
    pub(crate) fn focus_entry_count(&self) -> usize {
        self.0.borrow().focus.entries.len()
    }

    /// True if the focused widget registered after the first `start` entries of this frame.
    pub(crate) fn focused_since(&self, start: usize) -> bool {
        let inner = self.0.borrow();
        let Some(f) = inner.memory.focused else { return false };
        inner.focus.entries.iter().skip(start).any(|e| e.id == f)
    }

    pub(crate) fn has_pending_reveal_rect(&self) -> bool {
        self.0.borrow().focus.reveal_rect.is_some()
    }

    /// Takes the rect of a keyboard-focused widget that still needs scrolling into view.
    pub(crate) fn take_reveal_rect(&self) -> Option<Rect> {
        self.0.borrow_mut().focus.reveal_rect.take()
    }

    pub(crate) fn put_reveal_rect(&self, rect: Rect) {
        self.0.borrow_mut().focus.reveal_rect = Some(rect);
    }

    /// Escape was pressed while focus sat on a non-text widget inside window `id`, and no popup
    /// is open: the window should close. Consumes the key when it answers yes.
    pub(crate) fn escape_closes_window(&self, id: Id) -> bool {
        let yes = {
            let inner = self.0.borrow();
            let pressed = !inner.focus.consumed.contains(&Key::Escape) && inner.input.key_events.iter().any(|k| k.pressed && k.key == Key::Escape);
            pressed
                && inner.memory.popup_open.is_none()
                && inner.memory.focused.map_or(false, |f| inner.focus.prev_entries.iter().any(|e| e.id == f && e.layer == Some(id) && !e.text))
        };
        if yes {
            self.0.borrow_mut().focus.consumed.push(Key::Escape);
        }
        yes
    }
}
