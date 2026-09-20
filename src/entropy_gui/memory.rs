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
    /// Pan/zoom for one `NodeGraphEditor` instance, keyed by its editor id.
    NodeGraphView { pan: Vec2, zoom: f32 },
    /// Horizontal scroll (px) + zoom (ms/px) for one `KeyframeTimeline` or `TrackView`
    /// instance, keyed by its own id - the two widgets share this variant since they never
    /// collide (different id namespaces) and want the exact same pan/zoom shape.
    TimelineView { scroll_x: f32, zoom: f32 },
    /// A single remembered number for a widget (e.g. the bar length a `TrackView` was last drawn
    /// with, so a tempo change can rescale zoom instead of changing how much of the song fits).
    Scalar(f32),
    /// A user-typed draft string not yet (or not always) in sync with the caller's own data -
    /// currently just `ColorPicker`'s hex field, which needs to hold a free-typed string across
    /// frames without the widget re-deriving and stomping it from the color every single frame.
    /// See `widgets_color_picker` for why a plain re-derive-every-frame approach doesn't work.
    TextDraft(String),
}

/// Which edge (if any) of a `TrackView` clip is being dragged - see `widgets_tracks`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClipDragKind {
    Move,
    ResizeLeft,
    ResizeRight,
}

/// Live state for a node-graph link currently being dragged out of a pin — see
/// `entropy_gui::widgets_node_graph`. Only one link can be dragged application-wide at a
/// time, same rationale as `active_drag` below.
#[derive(Clone, Debug)]
pub struct LinkDrag {
    pub from_node: String,
    pub from_pin: String,
    pub from_output: bool,
}

#[derive(Default)]
pub struct Memory {
    data: IdMap<WidgetState>,
    pub focused: Option<Id>,
    /// At most one popup-style overlay (a `ComboBox` dropdown, a `ColorPicker`, a
    /// right-click `context_menu`) can be open application-wide at a time - opening one
    /// clears whatever id was here before, which is also what gives these overlays a
    /// correct z-order for free: since only one is ever open, there's never a second
    /// popup's draw call to be ambiguously above or below it in the same frame. Before this
    /// was unified, `ComboBox` (and `ColorPicker` when it was first built) tracked their own
    /// open/closed state independently per-id via `WidgetState::Open`, which let a dropdown
    /// and a color picker (or two dropdowns) end up open simultaneously with no defined
    /// stacking order between their two `Overlay`-layer draw calls - a real bug, not a
    /// hypothetical one. `CollapsingHeader` is NOT a popup and deliberately keeps its own
    /// independent per-id `WidgetState::Open` - many sections should stay expanded at once.
    pub popup_open: Option<Id>,
    pub popup_pos: Pos2,
    /// At most one widget can be "the" active drag application-wide at a time — sufficient
    /// for every custom-painted drag interaction in this app (timeline clips/keyframes,
    /// splitters, window chrome), so no per-widget drag state is needed.
    pub active_drag: Option<Id>,
    pub drag_origin: Pos2,
    /// While a `NodeGraphEditor` node title is being dragged, its live graph-space position —
    /// keyed by the title bar's own interact id so rendering can show a lag-free drag even
    /// though `nodes` is caller-owned data the widget can't mutate directly (see the node
    /// graph editor's module docs for why this can't just piggyback on `active_drag`).
    pub node_drag: Option<(Id, Pos2)>,
    /// Set while dragging a new link out of a pin in a `NodeGraphEditor`; cleared on release
    /// (whether or not the release landed on a valid opposite-kind pin).
    pub link_drag: Option<LinkDrag>,
    /// Live (time_ms) override for a `KeyframeTimeline` keyframe being dragged, keyed by the
    /// keyframe's own interact id - same lag-free-preview rationale as `node_drag`, since the
    /// widget never gets a `&mut` into the caller's keyframes either.
    pub keyframe_drag: Option<(Id, i32)>,
    /// Live (kind, start_ms, duration_ms) override for a `TrackView` clip being moved or
    /// resized, keyed by the clip's own interact id - same rationale as `keyframe_drag`.
    pub clip_drag: Option<(Id, ClipDragKind, i32, i32)>,
    /// Where a `TrackView` clip drag began: (clip interact id, pointer x at press, the clip's
    /// start_ms, its duration_ms). Snapping needs the un-snapped position measured from the
    /// press rather than an accumulated per-frame delta - rounding a small delta every frame
    /// would swallow it and the clip would never leave its snap point.
    pub clip_drag_origin: Option<(Id, f32, i32, i32)>,
    /// A clip being drawn into an empty `TrackView` lane: (lane interact id, anchor_ms, current
    /// end ms), both already snapped. Drawn as a ghost until release turns it into an event.
    pub lane_draw: Option<(Id, i32, i32)>,
    /// Set while a `KanbanBoard` card is being dragged: (board id, source column id, card
    /// id). The card's live position isn't stored here - it's read straight from the
    /// pointer each frame - only its identity, so the widget knows which card to draw as a
    /// floating ghost and skip drawing at its normal column position.
    pub kanban_drag: Option<(Id, String, String)>,
    /// One `DocEditor` instance's whole document (paragraphs, per-paragraph layout cache,
    /// cursor/selection) - keyed by the widget's id like everything else here, but stored in
    /// its own map rather than the small `WidgetState` enum: that enum's `get`/`set` clone the
    /// whole value on every access, which is fine for a few bytes of cursor/blink state but
    /// would mean cloning an entire (potentially huge) document every frame. `take_doc_editor`/
    /// `put_doc_editor` move it in and out instead - see `widgets_doc_editor` module docs.
    doc_editors: IdMap<crate::entropy_gui::widgets_doc_editor::DocEditorState>,
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

    pub fn get_node_graph_view(&self, id: Id) -> (Vec2, f32) {
        match self.data.get(&id) {
            Some(WidgetState::NodeGraphView { pan, zoom }) => (*pan, *zoom),
            _ => (Vec2::ZERO, 1.0),
        }
    }
    pub fn set_node_graph_view(&mut self, id: Id, pan: Vec2, zoom: f32) {
        self.data.insert(id, WidgetState::NodeGraphView { pan, zoom });
    }

    pub fn get_timeline_view(&self, id: Id) -> (f32, f32) {
        match self.data.get(&id) {
            Some(WidgetState::TimelineView { scroll_x, zoom }) => (*scroll_x, *zoom),
            _ => (0.0, 5.0),
        }
    }
    /// Whether this view has ever been stored - lets a widget fit its content to the available
    /// width the first time it appears, then leave zoom alone afterward.
    pub fn get_scalar(&self, id: Id) -> Option<f32> {
        match self.data.get(&id) {
            Some(WidgetState::Scalar(v)) => Some(*v),
            _ => None,
        }
    }
    pub fn set_scalar(&mut self, id: Id, v: f32) {
        self.data.insert(id, WidgetState::Scalar(v));
    }
    pub fn has_timeline_view(&self, id: Id) -> bool {
        matches!(self.data.get(&id), Some(WidgetState::TimelineView { .. }))
    }
    pub fn set_timeline_view(&mut self, id: Id, scroll_x: f32, zoom: f32) {
        self.data.insert(id, WidgetState::TimelineView { scroll_x, zoom });
    }

    /// Moves a `DocEditor`'s document out of `Memory` for the duration of one `show()` call -
    /// pair with `put_doc_editor` at the end. Returns a fresh default document the first time
    /// (or if called twice in a row without a matching `put_doc_editor`, which no real caller
    /// does).
    pub fn take_doc_editor(&mut self, id: Id) -> crate::entropy_gui::widgets_doc_editor::DocEditorState {
        self.doc_editors.remove(&id).unwrap_or_default()
    }
    pub fn put_doc_editor(&mut self, id: Id, state: crate::entropy_gui::widgets_doc_editor::DocEditorState) {
        self.doc_editors.insert(id, state);
    }

    pub fn get_text_draft(&self, id: Id) -> Option<String> {
        match self.data.get(&id) {
            Some(WidgetState::TextDraft(s)) => Some(s.clone()),
            _ => None,
        }
    }
    pub fn set_text_draft(&mut self, id: Id, s: String) {
        self.data.insert(id, WidgetState::TextDraft(s));
    }
}
