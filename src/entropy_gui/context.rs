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

pub(crate) struct ContextInner {
    pub(crate) style: Style,
    pub(crate) memory: Memory,
    pub(crate) draw_list: DrawList,
    pub(crate) overlay_draw_list: DrawList,
    pub(crate) input: RawInput,
    pub(crate) fonts: FontRegistry,
    pub(crate) atlas: GlyphAtlas,
    pub(crate) used_rect: Rect,
    pub(crate) screen_rect: Rect,
    pub(crate) time: f32,
    pub(crate) cursor_icon: CursorIcon,
    /// Ids whose overlay content (window / popup / context-menu) has already been drawn
    /// this frame, in draw order — lets `Memory::popup_open` control z-order without a
    /// separate deferred-closure queue (see module docs).
    pub(crate) frame_count: u64,
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
            input: RawInput::default(),
            fonts: FontRegistry::new(),
            atlas: GlyphAtlas::new(1024),
            used_rect: Rect::default(),
            screen_rect: Rect::default(),
            time: 0.0,
            cursor_icon: CursorIcon::Default,
            frame_count: 0,
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

    pub fn input<R>(&self, reader: impl FnOnce(&RawInput) -> R) -> R {
        reader(&self.0.borrow().input)
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
        inner.screen_rect = raw_input.screen_rect;
        inner.used_rect = raw_input.screen_rect;
        inner.time += raw_input.dt.max(0.0);
        inner.cursor_icon = CursorIcon::Default;
        inner.frame_count += 1;
        inner.input = raw_input;
    }

    fn end_frame(&self) -> FullOutput {
        let mut inner = self.0.borrow_mut();
        let overlay = std::mem::take(&mut inner.overlay_draw_list);
        inner.draw_list.commands.extend(overlay.commands);

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
