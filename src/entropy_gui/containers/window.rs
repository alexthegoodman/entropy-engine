//! `Window` — a floating, draggable, resizable, optionally-closable panel. Always drawn into
//! the overlay layer (after all panel/dock content, regardless of call order) so it floats
//! above everything else — matching this app's one real usage (the addon-manager window).

use crate::entropy_gui::color::Color32;
use crate::entropy_gui::context::Context;
use crate::entropy_gui::geometry::{pos2, vec2, Align, Align2, CursorIcon, FontId, Layout, Pos2, Rect, StrokeKind, Vec2};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::{DrawTarget, Painter};
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::draw_list::TextureId;
use crate::entropy_gui::ui::{interact, InnerResponse, Ui};

const TITLE_BAR_HEIGHT: f32 = 28.0;

/// Laid over the blurred backdrop of a `glass` window: the blur alone has no contrast of its own,
/// so text on it would sit on whatever the scene happened to be. Dark and translucent, matching
/// `render_egui.rs`'s own glass tint for Studio's dock chrome.
const GLASS_TINT: Color32 = Color32::from_rgba_unmultiplied(0x0D, 0x0B, 0x14, 0x96);
/// Same tint again over the title bar, so the bar still reads as a distinct strip on glass
/// instead of disappearing into the body.
const GLASS_TITLE_TINT: Color32 = Color32::from_rgba_unmultiplied(0x0D, 0x0B, 0x14, 0x6E);

pub struct Window<'open> {
    title: String,
    id: Option<Id>,
    resizable: bool,
    default_size: Vec2,
    default_pos: Option<Pos2>,
    open: Option<&'open mut bool>,
    glass: Option<TextureId>,
}

impl<'open> Window<'open> {
    pub fn new(title: impl Into<String>) -> Self {
        Self { title: title.into(), id: None, resizable: true, default_size: vec2(320.0, 240.0), default_pos: None, open: None, glass: None }
    }
    /// Paint a blurred copy of the frame behind this window instead of the theme's opaque
    /// `window_fill`. `texture_id` is the glass blur target (see `core::glass_blur`); it is only
    /// redrawn when the app opted into the blur pass, so passing an id from an app that did not
    /// shows the pass's clear color rather than the scene.
    pub fn glass(mut self, texture_id: TextureId) -> Self {
        self.glass = Some(texture_id);
        self
    }
    pub fn id(mut self, id: Id) -> Self {
        self.id = Some(id);
        self
    }
    pub fn resizable(mut self, r: bool) -> Self {
        self.resizable = r;
        self
    }
    pub fn default_size(mut self, size: impl Into<[f32; 2]>) -> Self {
        let s: [f32; 2] = size.into();
        self.default_size = vec2(s[0], s[1]);
        self
    }
    /// Top-left corner the window first appears at, in screen pixels. Only affects the very
    /// first frame - after that its position is whatever the user last dragged it to (cached by
    /// `id` in `ctx.memory`), same as `default_size`. Unset centers the window on screen instead.
    pub fn default_pos(mut self, pos: impl Into<[f32; 2]>) -> Self {
        let p: [f32; 2] = pos.into();
        self.default_pos = Some(pos2(p[0], p[1]));
        self
    }
    pub fn open(mut self, open: &'open mut bool) -> Self {
        self.open = Some(open);
        self
    }

    pub fn show<R>(mut self, ctx: &Context, add_contents: impl FnOnce(&mut Ui) -> R) -> Option<InnerResponse<Option<R>>> {
        if let Some(o) = self.open.as_ref() {
            if !**o {
                return None;
            }
        }

        let id = self.id.unwrap_or_else(|| Id::new(&self.title));
        let screen = ctx.screen_rect();
        let default_min = self.default_pos.unwrap_or_else(|| {
            pos2((screen.width() - self.default_size.x).max(0.0) / 2.0, (screen.height() - self.default_size.y).max(0.0) / 2.0)
        });
        let default_rect = Rect::from_min_size(default_min, self.default_size);
        let rect = ctx.memory(|m| m.get_window_rect(id, default_rect));

        // Everything below (title bar, close button, body) is this window's layer: it sees the
        // pointer unless a window built after it covers the pointer, and the panels underneath
        // stop seeing the pointer wherever this window sits (see `Context::input`).
        let previous_layer = ctx.enter_layer(id);

        let title_rect = Rect::from_min_max(rect.min, pos2(rect.max.x, rect.min.y + TITLE_BAR_HEIGHT));

        // Interact against last frame's rect first so this frame's drag/resize is reflected
        // immediately in what we paint below (no one-frame lag).
        let drag_resp = interact(ctx, title_rect, id.with("titlebar"), Sense::drag());
        let mut new_rect = rect;
        if drag_resp.dragged() {
            new_rect = new_rect.translate(drag_resp.drag_delta());
        }

        let resize_handle = Rect::from_min_size(pos2(rect.max.x - 12.0, rect.max.y - 12.0), vec2(12.0, 12.0));
        let resize_resp = if self.resizable { Some(interact(ctx, resize_handle, id.with("resize"), Sense::drag())) } else { None };
        if let Some(r) = &resize_resp {
            if r.dragged() {
                let d = r.drag_delta();
                new_rect.max.x = (new_rect.max.x + d.x).max(new_rect.min.x + 160.0);
                new_rect.max.y = (new_rect.max.y + d.y).max(new_rect.min.y + 100.0);
            }
            if r.hovered() || r.dragged() {
                ctx.request_cursor_icon(CursorIcon::ResizeNwSe);
            }
        }

        if new_rect != rect {
            ctx.memory_mut(|m| m.set_window_rect(id, new_rect));
        }

        let title_rect = Rect::from_min_max(new_rect.min, pos2(new_rect.max.x, new_rect.min.y + TITLE_BAR_HEIGHT));
        let style = ctx.style();
        let painter = Painter::new(ctx.clone(), Rect::everything(), DrawTarget::Overlay);
        if let Some(texture_id) = self.glass {
            // The blur target covers the whole screen, so the slice to sample is this window's
            // rect expressed in 0..1 screen coordinates - same mapping as `paint_glass_backdrop`.
            let uv = Rect::from_min_max(
                pos2((new_rect.min.x - screen.min.x) / screen.width().max(1.0), (new_rect.min.y - screen.min.y) / screen.height().max(1.0)),
                pos2((new_rect.max.x - screen.min.x) / screen.width().max(1.0), (new_rect.max.y - screen.min.y) / screen.height().max(1.0)),
            );
            painter.image_rounded(texture_id, new_rect, style.visuals.window_corner_radius, uv, Color32::WHITE);
            painter.rect_filled(new_rect, style.visuals.window_corner_radius, GLASS_TINT);
        } else {
            painter.rect_filled(new_rect, style.visuals.window_corner_radius, style.visuals.window_fill);
        }
        painter.rect_stroke(new_rect, style.visuals.window_corner_radius, style.visuals.window_stroke, StrokeKind::Middle);
        painter.rect_filled(title_rect, style.visuals.window_corner_radius, if self.glass.is_some() { GLASS_TITLE_TINT } else { style.visuals.widgets.open.bg_fill });
        let text_color = style.visuals.override_text_color.unwrap_or(Color32::WHITE);
        painter.text(pos2(title_rect.min.x + 10.0, title_rect.center().y), Align2::LEFT_CENTER, &self.title, FontId::proportional(13.0), text_color);

        if self.resizable {
            let handle = Rect::from_min_size(pos2(new_rect.max.x - 12.0, new_rect.max.y - 12.0), vec2(12.0, 12.0));
            painter.rect_filled(handle, 2u8, style.visuals.widgets.inactive.bg_stroke.color);
        }

        if let Some(open_ref) = self.open.as_mut() {
            let close_rect = Rect::from_min_size(pos2(title_rect.max.x - 24.0, title_rect.min.y + 4.0), vec2(20.0, 20.0));
            let close_resp = interact(ctx, close_rect, id.with("close"), Sense::click());
            let close_color = if close_resp.hovered() { style.visuals.widgets.hovered.fg_stroke.color } else { text_color };
            painter.text(close_rect.center(), Align2::CENTER_CENTER, "\u{2715}", FontId::proportional(12.0), close_color);
            if close_resp.clicked() {
                **open_ref = false;
            }
        }

        let body = Rect::from_min_max(pos2(new_rect.min.x, new_rect.min.y + TITLE_BAR_HEIGHT), new_rect.max).shrink(8.0);
        let mut ui = Ui::new(ctx.clone(), id, body, Layout::top_down(Align::Min), body, DrawTarget::Overlay);
        let inner = add_contents(&mut ui);

        let response = interact(ctx, new_rect, id, Sense::hover());
        ctx.add_occluder(id, new_rect);
        ctx.leave_layer(previous_layer);
        Some(InnerResponse { inner: Some(inner), response })
    }
}
