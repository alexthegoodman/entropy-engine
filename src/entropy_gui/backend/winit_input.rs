//! Winit -> `entropy_gui::RawInput` translation, replacing `egui_winit::State`. Reuses the
//! raw `WindowEvent` stream that already flows through `src/startup.rs`'s
//! `ApplicationHandler::window_event` (the same events the engine's own
//! `EntropyMouseButton`/`EntropyPosition` plumbing observes) rather than introducing a
//! second input path — this is simply another independent observer of the same events.
//!
//! Also the only place IME text is actually consumed into a buffer: previously (real egui
//! aside) `WindowEvent::Ime` was only logged (`src/startup.rs`), never fed to a text field.

use crate::entropy_gui::context::{Context, KeyEvent, Modifiers, PlatformOutput, PointerState, RawInput};
use crate::entropy_gui::context::Key as GuiKey;
use crate::entropy_gui::context::ViewportId;
use crate::entropy_gui::geometry::{pos2, vec2, CursorIcon as GuiCursorIcon, Rect, Vec2};
use winit::event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::ActiveEventLoop;
use winit::keyboard::{Key as WinitKey, NamedKey};
use winit::window::{CustomCursor, CustomCursorSource, Window};

pub struct EventResponse {
    pub consumed: bool,
}

pub struct State {
    pointer_pos: Option<crate::entropy_gui::geometry::Pos2>,
    primary_down: bool,
    secondary_down: bool,
    prev_primary_down: bool,
    prev_secondary_down: bool,
    modifiers: Modifiers,
    scroll_accum: Vec2,
    text_accum: String,
    key_accum: Vec<KeyEvent>,
    ime_preedit: Option<String>,
    last_frame_instant: std::time::Instant,
    pointer_cursors: Option<PointerCursors>,
}

/// The custom "modern pointer" art, one bitmap per DPI tier, swapped in for
/// `GuiCursorIcon::Default` in place of the OS's stock arrow. Built once (needs an
/// `ActiveEventLoop` to hand to winit) via [`build_pointer_cursors`] and installed with
/// [`State::set_pointer_cursors`]; every other `GuiCursorIcon` still maps to a native OS icon.
pub struct PointerCursors {
    c1x: CustomCursor,
    c2x: CustomCursor,
    c3x: CustomCursor,
    c4x: CustomCursor,
}

const POINTER_1X: &[u8] = include_bytes!("../cursors/pointer_32.png");
const POINTER_2X: &[u8] = include_bytes!("../cursors/pointer_64.png");
const POINTER_3X: &[u8] = include_bytes!("../cursors/pointer_96.png");
const POINTER_4X: &[u8] = include_bytes!("../cursors/pointer_128.png");

/// Decodes a pointer PNG (RGBA, hotspot at the art's top-left tip) into a cursor source ready
/// for `ActiveEventLoop::create_custom_cursor`.
fn decode_pointer_cursor(bytes: &[u8]) -> CustomCursorSource {
    let img = image::load_from_memory(bytes).expect("decode pointer cursor PNG").to_rgba8();
    let (w, h) = img.dimensions();
    CustomCursor::from_rgba(img.into_raw(), w as u16, h as u16, 0, 0).expect("build pointer cursor")
}

/// Builds every DPI tier of the custom pointer. Call once per window (needs the
/// `ActiveEventLoop` winit hands out in `resumed`/`create_window`) and pass the result to
/// [`State::set_pointer_cursors`].
pub fn build_pointer_cursors(event_loop: &ActiveEventLoop) -> PointerCursors {
    PointerCursors {
        c1x: event_loop.create_custom_cursor(decode_pointer_cursor(POINTER_1X)),
        c2x: event_loop.create_custom_cursor(decode_pointer_cursor(POINTER_2X)),
        c3x: event_loop.create_custom_cursor(decode_pointer_cursor(POINTER_3X)),
        c4x: event_loop.create_custom_cursor(decode_pointer_cursor(POINTER_4X)),
    }
}

/// Nearest DPI tier for `scale_factor` (1x/2x/3x/4x assets, midpoint thresholds).
fn pick_pointer_cursor(cursors: &PointerCursors, scale_factor: f64) -> &CustomCursor {
    if scale_factor <= 1.5 {
        &cursors.c1x
    } else if scale_factor <= 2.5 {
        &cursors.c2x
    } else if scale_factor <= 3.5 {
        &cursors.c3x
    } else {
        &cursors.c4x
    }
}

impl State {
    pub fn new(
        _ctx: Context,
        _viewport_id: ViewportId,
        _window: &Window,
        _native_pixels_per_point: Option<f32>,
        _theme: Option<()>,
        _max_texture_side: Option<usize>,
    ) -> Self {
        Self {
            pointer_pos: None,
            primary_down: false,
            secondary_down: false,
            prev_primary_down: false,
            prev_secondary_down: false,
            modifiers: Modifiers::default(),
            scroll_accum: Vec2::ZERO,
            text_accum: String::new(),
            key_accum: Vec::new(),
            ime_preedit: None,
            last_frame_instant: std::time::Instant::now(),
            pointer_cursors: None,
        }
    }

    /// Installs the custom "modern pointer" art built by [`build_pointer_cursors`]; without
    /// this, `GuiCursorIcon::Default` just falls back to the OS's native arrow.
    pub fn set_pointer_cursors(&mut self, cursors: PointerCursors) {
        self.pointer_cursors = Some(cursors);
    }

    pub fn on_window_event(&mut self, _window: &Window, event: &WindowEvent) -> EventResponse {
        match event {
            WindowEvent::CursorMoved { position, .. } => {
                self.pointer_pos = Some(pos2(position.x as f32, position.y as f32));
            }
            WindowEvent::CursorLeft { .. } => {
                self.pointer_pos = None;
            }
            WindowEvent::MouseInput { state, button, .. } => {
                let down = matches!(state, ElementState::Pressed);
                match button {
                    MouseButton::Left => self.primary_down = down,
                    MouseButton::Right => self.secondary_down = down,
                    _ => {}
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let (dx, dy) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => (*x * 24.0, *y * 24.0),
                    MouseScrollDelta::PixelDelta(p) => (p.x as f32, p.y as f32),
                };
                self.scroll_accum += vec2(dx, dy);
            }
            WindowEvent::ModifiersChanged(mods) => {
                let s = mods.state();
                self.modifiers = Modifiers { shift: s.shift_key(), ctrl: s.control_key(), alt: s.alt_key(), command: s.super_key() };
            }
            WindowEvent::KeyboardInput { event, is_synthetic: false, .. } => {
                let pressed = event.state == ElementState::Pressed;
                if pressed {
                    if let Some(text) = &event.text {
                        if !text.chars().any(|c| c.is_control()) {
                            self.text_accum.push_str(text.as_str());
                        }
                    }
                }
                if let Some(key) = map_key(&event.logical_key) {
                    self.key_accum.push(KeyEvent { key, pressed, modifiers: self.modifiers });
                }
            }
            WindowEvent::Ime(ime) => match ime {
                Ime::Preedit(text, _caret) => {
                    self.ime_preedit = if text.is_empty() { None } else { Some(text.clone()) };
                }
                Ime::Commit(text) => {
                    self.text_accum.push_str(text);
                    self.ime_preedit = None;
                }
                Ime::Enabled => {}
                Ime::Disabled => self.ime_preedit = None,
            },
            _ => {}
        }
        EventResponse { consumed: false }
    }

    pub fn take_egui_input(&mut self, window: &Window) -> RawInput {
        let size = window.inner_size();
        let now = std::time::Instant::now();
        let dt = now.duration_since(self.last_frame_instant).as_secs_f32();
        self.last_frame_instant = now;

        let input = RawInput {
            screen_rect: Rect::from_min_size(pos2(0.0, 0.0), vec2(size.width as f32, size.height as f32)),
            // Deliberately always 1.0 (not `window.scale_factor()`) — this GUI kit lays out
            // in the same pixel space it renders to rather than a separate logical-point
            // space, trading HiDPI crispness on scaled displays for a much simpler coordinate
            // model. A documented v1 simplification, not an oversight.
            pixels_per_point: 1.0,
            pointer: PointerState {
                pos: self.pointer_pos,
                delta: Vec2::ZERO,
                primary_down: self.primary_down,
                primary_pressed: self.primary_down && !self.prev_primary_down,
                primary_released: !self.primary_down && self.prev_primary_down,
                secondary_down: self.secondary_down,
                secondary_pressed: self.secondary_down && !self.prev_secondary_down,
            },
            scroll_delta: self.scroll_accum,
            modifiers: self.modifiers,
            text_input: std::mem::take(&mut self.text_accum),
            ime_preedit: self.ime_preedit.clone(),
            key_events: std::mem::take(&mut self.key_accum),
            dt: dt.min(0.25),
        };

        self.prev_primary_down = self.primary_down;
        self.prev_secondary_down = self.secondary_down;
        self.scroll_accum = Vec2::ZERO;

        input
    }

    pub fn handle_platform_output(&mut self, window: &Window, output: PlatformOutput) {
        if output.cursor_icon == GuiCursorIcon::Default {
            if let Some(cursors) = &self.pointer_cursors {
                window.set_cursor(pick_pointer_cursor(cursors, window.scale_factor()).clone());
                return;
            }
        }
        window.set_cursor(map_cursor_icon(output.cursor_icon));
    }
}

fn map_key(logical_key: &WinitKey) -> Option<GuiKey> {
    match logical_key {
        WinitKey::Named(NamedKey::ArrowLeft) => Some(GuiKey::ArrowLeft),
        WinitKey::Named(NamedKey::ArrowRight) => Some(GuiKey::ArrowRight),
        WinitKey::Named(NamedKey::ArrowUp) => Some(GuiKey::ArrowUp),
        WinitKey::Named(NamedKey::ArrowDown) => Some(GuiKey::ArrowDown),
        WinitKey::Named(NamedKey::Home) => Some(GuiKey::Home),
        WinitKey::Named(NamedKey::End) => Some(GuiKey::End),
        WinitKey::Named(NamedKey::Backspace) => Some(GuiKey::Backspace),
        WinitKey::Named(NamedKey::Delete) => Some(GuiKey::Delete),
        WinitKey::Named(NamedKey::Enter) => Some(GuiKey::Enter),
        WinitKey::Named(NamedKey::Escape) => Some(GuiKey::Escape),
        WinitKey::Named(NamedKey::Tab) => Some(GuiKey::Tab),
        WinitKey::Character(s) => match s.as_str() {
            "a" | "A" => Some(GuiKey::A),
            "c" | "C" => Some(GuiKey::C),
            "v" | "V" => Some(GuiKey::V),
            "x" | "X" => Some(GuiKey::X),
            _ => None,
        },
        _ => None,
    }
}

fn map_cursor_icon(icon: GuiCursorIcon) -> winit::window::CursorIcon {
    use winit::window::CursorIcon as W;
    match icon {
        GuiCursorIcon::Default => W::Default,
        GuiCursorIcon::PointingHand => W::Pointer,
        GuiCursorIcon::Text => W::Text,
        GuiCursorIcon::ResizeHorizontal => W::EwResize,
        GuiCursorIcon::ResizeVertical => W::NsResize,
        GuiCursorIcon::ResizeNwSe => W::NwseResize,
        GuiCursorIcon::ResizeNeSw => W::NeswResize,
        GuiCursorIcon::Grab => W::Grab,
        GuiCursorIcon::Grabbing => W::Grabbing,
        GuiCursorIcon::NotAllowed => W::NotAllowed,
    }
}
