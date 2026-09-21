//! `Context` — the GUI's root shared state. Single-pass architecture: widgets tessellate
//! directly into a per-frame draw list as they're called (no egui-style shape retention or
//! cross-frame animation interpolation, since this app renders one frame per redraw at a
//! fixed `pixels_per_point`). `run()`/`tessellate()` stay as thin, signature-compatible
//! shims so `src/core/pipeline.rs`'s call site barely changes.

use crate::entropy_gui::atlas::GlyphAtlas;
use crate::entropy_gui::draw_list::{DrawList, TextureId};
use crate::entropy_gui::fonts::FontRegistry;
use crate::entropy_gui::geometry::{CursorIcon, Pos2, Rect};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::memory::Memory;
use crate::entropy_gui::style::Style;
use std::cell::{RefCell, RefMut};
use std::rc::Rc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Modifiers {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub command: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    ArrowDown,
    Home,
    End,
    Backspace,
    Delete,
    Enter,
    Escape,
    Tab,
    A,
    C,
    V,
    X,
}

#[derive(Clone, Copy, Debug)]
pub struct KeyEvent {
    pub key: Key,
    pub pressed: bool,
    pub modifiers: Modifiers,
}

/// What a pen reports while it touches the surface. Absent (`PointerState::pen == None`) for a
/// mouse, so a widget can tell "a pen at pressure 0.4" from "a mouse" and treat a mouse as a
/// fixed, comfortable pressure of its own.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PenState {
    /// 0..1.
    pub pressure: f32,
    /// Degrees from the surface normal: 0 is upright, +-90 is flat. Zero when the pen does not
    /// report tilt (most cheap styli only report pressure); check `has_tilt`.
    pub tilt_x: f32,
    pub tilt_y: f32,
    pub has_tilt: bool,
    /// The side button. The window backend also reports it as the secondary button.
    pub barrel: bool,
    /// The pen is being used upside down, or its eraser end is down.
    pub eraser: bool,
}

/// Pointer state for the current frame — already edge-detected (pressed/released) by the
/// winit backend, mirroring `egui::InputState::pointer`'s method-call shape.
#[derive(Clone, Copy, Debug, Default)]
pub struct PointerState {
    pub pos: Option<Pos2>,
    pub delta: crate::entropy_gui::geometry::Vec2,
    pub primary_down: bool,
    pub primary_pressed: bool,
    pub primary_released: bool,
    pub secondary_down: bool,
    pub secondary_pressed: bool,
    /// Set while a pen is touching; `None` for a mouse.
    pub pen: Option<PenState>,
}

impl PointerState {
    pub fn hover_pos(&self) -> Option<Pos2> {
        self.pos
    }
    pub fn interact_pos(&self) -> Option<Pos2> {
        self.pos
    }
    pub fn primary_pressed(&self) -> bool {
        self.primary_pressed
    }
    pub fn primary_down(&self) -> bool {
        self.primary_down
    }
    pub fn primary_released(&self) -> bool {
        self.primary_released
    }
}

/// Per-frame input snapshot, fed in via `Context::run` and read back via `ui.input(|i| ...)`.
/// Built by the winit backend (`backend/winit_input.rs`), which owns all edge-detection.
#[derive(Clone, Debug, Default)]
pub struct RawInput {
    pub screen_rect: Rect,
    pub pixels_per_point: f32,
    pub pointer: PointerState,
    pub scroll_delta: crate::entropy_gui::geometry::Vec2,
    pub modifiers: Modifiers,
    /// Committed text this frame (typed characters and/or IME commit).
    pub text_input: String,
    /// IME composition-in-progress text (not yet committed), for underline-overlay rendering.
    pub ime_preedit: Option<String>,
    pub key_events: Vec<KeyEvent>,
    pub dt: f32,
}

pub type InputState = RawInput;

/// A no-op placeholder matching `egui::Context::viewport_id()`'s return type — this app
/// never uses multi-viewport egui.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct ViewportId;

#[derive(Clone, Copy, Debug, Default)]
pub struct PlatformOutput {
    pub cursor_icon: CursorIcon,
}

/// A rectangular region of pixels to upload into a texture — mirrors real egui's
/// `textures_delta` mechanism (this is genuinely how the shared glyph atlas gets its pixels
/// onto the GPU: `end_frame` drains `GlyphAtlas::take_uploads()` into these). Every entry in
/// practice targets `TextureId::ATLAS`; `register_native_texture` is eager/immediate, not
/// deferred through here, so no other texture ever appears in `textures_delta.set`.
#[derive(Clone, Debug)]
pub struct ImageDelta {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Clone, Debug, Default)]
pub struct TexturesDelta {
    pub set: Vec<(TextureId, ImageDelta)>,
    pub free: Vec<TextureId>,
}

#[derive(Clone, Debug, Default)]
pub struct FullOutput {
    /// Unused placeholder — geometry is already in `Context`'s draw list by the time `run()`
    /// returns. Exists only so `ctx.tessellate(full_output.shapes, ...)` keeps compiling.
    pub shapes: (),
    pub textures_delta: TexturesDelta,
    pub platform_output: PlatformOutput,
    pub pixels_per_point: f32,
}

/// One floating window's footprint, kept so widgets in lower layers can tell the pointer is over
/// something drawn on top of them. `order` is the window's `show` call order within its frame,
/// which is also its draw order (later is on top).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Occluder {
    pub(crate) id: Id,
    pub(crate) order: u32,
    pub(crate) rect: Rect,
}

/// The layer a widget is being built in. `None` (on `ContextInner::layer`) is the base layer:
/// panels, tabs and dock leaves. Each `Window` is a layer above it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LayerKey {
    pub(crate) id: Id,
    pub(crate) order: u32,
}

pub(crate) struct ContextInner {
    pub(crate) style: Style,
    pub(crate) memory: Memory,
    pub(crate) draw_list: DrawList,
    pub(crate) overlay_draw_list: DrawList,
    /// Merged in after `overlay_draw_list` in `end_frame` - see `painter::DrawTarget::Popup`
    /// for why this third list exists (a `Window`'s entire body already renders to
    /// `overlay_draw_list`, so a popup nested inside one needs a layer above *that*, not
    /// just another entry within it).
    pub(crate) popup_draw_list: DrawList,
    pub(crate) input: RawInput,
    pub(crate) fonts: FontRegistry,
    pub(crate) atlas: GlyphAtlas,
    pub(crate) used_rect: Rect,
    pub(crate) screen_rect: Rect,
    pub(crate) time: f32,
    pub(crate) cursor_icon: CursorIcon,
    pub(crate) frame_count: u64,
    /// True once any widget's `interact()` this frame reported the pointer as hovering its
    /// rect - the generic "is the pointer currently over some GUI element" signal real egui
    /// exposes as `ctx.wants_pointer_input()`. Addon-facing game/world code (e.g. a level
    /// editor's click-to-select) needs this to avoid also reacting to clicks meant for a UI
    /// button/window - see `Context::pointer_over_ui` and its addon-facing
    /// `Entropy.Input.isPointerOverUI()`.
    pub(crate) pointer_over_ui: bool,
    /// Window footprints from the previous frame. A window is built after the panels beneath it,
    /// so this frame's list is not complete yet when those panels hit-test; last frame's is (the
    /// same one-frame delay egui's layer hit-testing has).
    pub(crate) occluders_prev: Vec<Occluder>,
    pub(crate) occluders_cur: Vec<Occluder>,
    /// Layer the widgets being built right now belong to (`None` = base).
    pub(crate) layer: Option<LayerKey>,
    /// Windows begun so far this frame; the next one's `order`.
    pub(crate) windows_begun: u32,
    /// Which layer a held pointer button was pressed on (`Some(None)` = base), until it is
    /// released. While set, only that layer sees the pointer, so dragging a slider out of a
    /// window does not start driving whatever is underneath.
    pub(crate) pointer_capture: Option<Option<Id>>,
}

impl ContextInner {
    /// The topmost window under `pos` (last frame's footprints), or `None` for the base layer.
    fn top_layer_at(&self, pos: Pos2) -> Option<Id> {
        self.occluders_prev.iter().filter(|o| o.rect.contains(pos)).max_by_key(|o| o.order).map(|o| o.id)
    }

    /// True when the layer currently being built should not see the pointer.
    fn pointer_hidden(&self) -> bool {
        let mine = self.layer.map(|l| l.id);
        if let Some(captured) = self.pointer_capture {
            return captured != mine;
        }
        let Some(pos) = self.input.pointer.pos else { return false };
        let my_order = self.layer.map_or(-1_i64, |l| l.order as i64);
        self.occluders_prev.iter().any(|o| o.order as i64 > my_order && o.rect.contains(pos))
    }
}

#[derive(Clone)]
pub struct Context(Rc<RefCell<ContextInner>>);

impl Default for Context {
    fn default() -> Self {
        Context(Rc::new(RefCell::new(ContextInner {
            style: Style::default(),
            memory: Memory::default(),
            draw_list: DrawList::new(),
            overlay_draw_list: DrawList::new(),
            popup_draw_list: DrawList::new(),
            input: RawInput::default(),
            fonts: FontRegistry::new(),
            atlas: GlyphAtlas::new(1024),
            used_rect: Rect::default(),
            screen_rect: Rect::default(),
            time: 0.0,
            cursor_icon: CursorIcon::Default,
            frame_count: 0,
            pointer_over_ui: false,
            occluders_prev: Vec::new(),
            occluders_cur: Vec::new(),
            layer: None,
            windows_begun: 0,
            pointer_capture: None,
        })))
    }
}

impl Context {
    pub(crate) fn inner_mut(&self) -> RefMut<'_, ContextInner> {
        self.0.borrow_mut()
    }

    pub fn style(&self) -> Style {
        self.0.borrow().style.clone()
    }

    pub fn set_style(&self, style: Style) {
        self.0.borrow_mut().style = style;
    }

    pub fn viewport_id(&self) -> ViewportId {
        ViewportId
    }

    pub fn pixels_per_point(&self) -> f32 {
        let ppp = self.0.borrow().input.pixels_per_point;
        if ppp > 0.0 {
            ppp
        } else {
            1.0
        }
    }

    pub fn request_cursor_icon(&self, icon: CursorIcon) {
        self.0.borrow_mut().cursor_icon = icon;
    }

    /// The frame's input as the layer currently being built should see it: when the pointer is
    /// over a window drawn above that layer (or a press started on another layer), the pointer
    /// position, buttons and wheel are withheld, so a panel never reacts to a click a window
    /// swallowed. Keyboard and text input are untouched.
    pub fn input<R>(&self, reader: impl FnOnce(&RawInput) -> R) -> R {
        let inner = self.0.borrow();
        if inner.pointer_hidden() {
            let mut masked = inner.input.clone();
            masked.pointer = PointerState { pos: None, ..PointerState::default() };
            masked.scroll_delta = crate::entropy_gui::geometry::Vec2::ZERO;
            return reader(&masked);
        }
        reader(&inner.input)
    }

    /// Starts a window layer and returns the layer to hand back to `leave_layer`. Called by
    /// `Window::show` before it hit-tests its own title bar, so those hit-tests use the window's
    /// own layer.
    pub(crate) fn enter_layer(&self, id: Id) -> Option<LayerKey> {
        let mut inner = self.0.borrow_mut();
        let key = LayerKey { id, order: inner.windows_begun };
        inner.windows_begun += 1;
        std::mem::replace(&mut inner.layer, Some(key))
    }

    pub(crate) fn leave_layer(&self, previous: Option<LayerKey>) {
        self.0.borrow_mut().layer = previous;
    }

    /// Records the window's final footprint for next frame's hit-testing.
    pub(crate) fn add_occluder(&self, id: Id, rect: Rect) {
        let mut inner = self.0.borrow_mut();
        let order = inner.layer.map_or(0, |l| l.order);
        inner.occluders_cur.push(Occluder { id, order, rect });
    }

    pub fn output_mut<R>(&self, writer: impl FnOnce(&mut PlatformOutput) -> R) -> R {
        let mut inner = self.0.borrow_mut();
        let mut out = PlatformOutput { cursor_icon: inner.cursor_icon };
        let r = writer(&mut out);
        inner.cursor_icon = out.cursor_icon;
        r
    }

    pub fn screen_rect(&self) -> Rect {
        self.0.borrow().screen_rect
    }

    /// The remaining screen area not yet claimed by a panel this frame — panels shrink this
    /// in call order (`TopBottomPanel`/`SidePanel`/`CentralPanel`, see `containers/panel.rs`).
    pub(crate) fn take_used_rect(&self) -> Rect {
        self.0.borrow().used_rect
    }
    pub(crate) fn set_used_rect(&self, rect: Rect) {
        self.0.borrow_mut().used_rect = rect;
    }

    /// Every font name available to `DocEditor`'s font picker (the engine's ~60-font catalog).
    pub fn font_names(&self) -> Vec<String> {
        self.0.borrow().fonts.catalog_font_names()
    }

    pub fn memory<R>(&self, reader: impl FnOnce(&Memory) -> R) -> R {
        reader(&self.0.borrow().memory)
    }
    pub fn memory_mut<R>(&self, writer: impl FnOnce(&mut Memory) -> R) -> R {
        writer(&mut self.0.borrow_mut().memory)
    }

    pub fn run(&self, raw_input: RawInput, add_contents: impl FnOnce(&Context)) -> FullOutput {
        self.begin_frame(raw_input);
        add_contents(self);
        self.end_frame()
    }

    fn begin_frame(&self, raw_input: RawInput) {
        let mut inner = self.0.borrow_mut();
        inner.draw_list.clear();
        inner.overlay_draw_list.clear();
        inner.popup_draw_list.clear();
        inner.screen_rect = raw_input.screen_rect;
        inner.used_rect = raw_input.screen_rect;
        inner.time += raw_input.dt.max(0.0);
        inner.cursor_icon = CursorIcon::Default;
        inner.frame_count += 1;
        inner.pointer_over_ui = false;
        inner.input = raw_input;
        inner.occluders_prev = std::mem::take(&mut inner.occluders_cur);
        inner.windows_begun = 0;
        inner.layer = None;
        let p = inner.input.pointer;
        if p.primary_pressed || p.secondary_pressed {
            inner.pointer_capture = Some(p.pos.and_then(|pos| inner.top_layer_at(pos)));
        } else if !p.primary_down && !p.primary_released && !p.secondary_down {
            inner.pointer_capture = None;
        }
        inner.memory.begin_scroll_frame();
    }

    /// Marks the pointer as currently over some GUI element - called from `interact()`
    /// whenever it computes `hovered = true`, so this ends up true for the frame if the pointer
    /// is over *any* widget/window, not just ones that specifically check for it.
    pub(crate) fn mark_pointer_over_ui(&self) {
        self.0.borrow_mut().pointer_over_ui = true;
    }

    /// True if the pointer was over any GUI widget/window at any point so far this frame.
    /// Addon-facing as `Entropy.Input.isPointerOverUI()` - see the field doc comment on
    /// `ContextInner::pointer_over_ui`.
    pub fn pointer_over_ui(&self) -> bool {
        self.0.borrow().pointer_over_ui
    }

    fn end_frame(&self) -> FullOutput {
        let mut inner = self.0.borrow_mut();
        let overlay = std::mem::take(&mut inner.overlay_draw_list);
        inner.draw_list.commands.extend(overlay.commands);
        let popup = std::mem::take(&mut inner.popup_draw_list);
        inner.draw_list.commands.extend(popup.commands);

        let set = inner
            .atlas
            .take_uploads()
            .into_iter()
            .map(|u| (TextureId::ATLAS, ImageDelta { x: u.x, y: u.y, width: u.width, height: u.height, rgba: u.rgba }))
            .collect();

        FullOutput {
            shapes: (),
            textures_delta: TexturesDelta { set, free: Vec::new() },
            platform_output: PlatformOutput { cursor_icon: inner.cursor_icon },
            pixels_per_point: inner.input.pixels_per_point,
        }
    }

    /// Signature-compatible adapter for the old `ctx.tessellate(shapes, ppp)` call site —
    /// geometry is already tessellated into the draw list by the time this is called, so
    /// this just drains it.
    pub fn tessellate(&self, _shapes: (), _pixels_per_point: f32) -> Vec<crate::entropy_gui::draw_list::DrawCommand> {
        std::mem::take(&mut self.0.borrow_mut().draw_list).commands
    }

    pub fn time(&self) -> f32 {
        self.0.borrow().time
    }
}
