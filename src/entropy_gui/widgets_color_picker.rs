//! `ColorPicker` - a real HSV wheel (hue = angle, saturation = radius from center) plus
//! value/alpha sliders and an editable hex field, opened as a popup from a small swatch
//! button. Replaces the v1 stand-in `widgets::color_edit` used to ship: clicking the swatch
//! just cycled through six hardcoded presets, with a comment flagging "a full picker is a
//! natural, isolated follow-up." This is that follow-up - every existing call site
//! (`Ui::color_edit_button_rgba_unmultiplied`, and everything built on it - the addon-facing
//! `Entropy.UI.Widget.colorInput`, Studio's own material/light color fields) gets the real
//! wheel with no call-site changes, since `color_edit.rs` now just delegates here.
//!
//! Same caller-owns-the-data shape as the rest of this kit: `rgba: &mut [f32; 4]` is mutated
//! in place, `Response::changed()` reports whether this frame moved it. Hue/saturation/value
//! are derived fresh from `rgba` every frame via `rgb_to_hsv` rather than stored anywhere
//! persistent - simpler, and it means the picker can never drift from the color it's editing.
//! The one real cost: a fully desaturated color (s=0, e.g. pure white/gray/black) has no
//! defined hue, so the wheel's marker resets to hue=0 for any gray rather than remembering
//! the last hue that was dialed to zero saturation. egui's own picker keeps a hidden
//! persistent hue for exactly this reason; not done here to keep this widget stateless
//! besides the hex draft below - a minor, documented rough edge, not a bug.
//!
//! The hex field is the one piece of real per-widget state (`Memory::TextDraft`, keyed off
//! this picker's id): it holds whatever the user is actively typing so a colour picked via the
//! wheel/sliders doesn't get overwritten mid-keystroke by a value re-derived from `rgba` every
//! frame. It's resynced from the live color only when the popup is freshly opened or the wheel/
//! sliders themselves just changed the color - never on a frame where the hex field was the
//! thing being edited.

use crate::core::vertex::Vertex;
use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align, Layout, Pos2, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::{DrawTarget, Painter};
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::ui::{interact, Ui};
use crate::entropy_gui::widgets::Slider;

const WHEEL_RADIUS: f32 = 64.0;
const WHEEL_RINGS: usize = 14;
const WHEEL_SEGMENTS: usize = 48;
const SWATCH_W: f32 = 28.0;
const POPUP_PAD: f32 = 10.0;
const CONTROLS_H: f32 = 140.0;

pub struct ColorPicker {
    id: Id,
}

fn hsv_to_rgb(h: f32, s: f32, v: f32) -> (f32, f32, f32) {
    let h = h.rem_euclid(1.0) * 6.0;
    let i = h.floor();
    let f = h - i;
    let p = v * (1.0 - s);
    let q = v * (1.0 - s * f);
    let t = v * (1.0 - s * (1.0 - f));
    match i as i32 % 6 {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    }
}

fn rgb_to_hsv(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;
    let v = max;
    let s = if max > 0.0 { delta / max } else { 0.0 };
    let h = if delta <= 1e-5 {
        0.0
    } else if max == r {
        ((g - b) / delta).rem_euclid(6.0) / 6.0
    } else if max == g {
        (((b - r) / delta) + 2.0) / 6.0
    } else {
        (((r - g) / delta) + 4.0) / 6.0
    };
    (h, s, v)
}

fn parse_hex(s: &str) -> Option<(f32, f32, f32)> {
    let s = s.trim().trim_start_matches('#');
    if s.len() != 6 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let r = u8::from_str_radix(&s[0..2], 16).ok()?;
    let g = u8::from_str_radix(&s[2..4], 16).ok()?;
    let b = u8::from_str_radix(&s[4..6], 16).ok()?;
    Some((r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0))
}

fn to_hex(r: f32, g: f32, b: f32) -> String {
    format!(
        "#{:02X}{:02X}{:02X}",
        (r.clamp(0.0, 1.0) * 255.0).round() as u8,
        (g.clamp(0.0, 1.0) * 255.0).round() as u8,
        (b.clamp(0.0, 1.0) * 255.0).round() as u8
    )
}

impl ColorPicker {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("color_picker").with(id_salt) }
    }

    /// Draws the hue/saturation disc, `radius` px, centered at `center`, at the given `value`.
    /// Interaction: click/drag anywhere within `radius` of `center` sets hue (angle) and
    /// saturation (distance from center, clamped to the wheel edge for a drag that overshoots
    /// it) - the standard "polar HSV wheel" convention. Returns whether `h`/`s` changed.
    fn wheel(ctx: &crate::entropy_gui::context::Context, id: Id, painter: &Painter, center: Pos2, radius: f32, h: &mut f32, s: &mut f32, v: f32) -> bool {
        let mut vertices = Vec::with_capacity(1 + (WHEEL_SEGMENTS + 1) * WHEEL_RINGS);
        let mut indices = Vec::with_capacity(WHEEL_SEGMENTS * 3 + WHEEL_SEGMENTS * (WHEEL_RINGS - 1) * 6);

        let (cr, cg, cb) = hsv_to_rgb(0.0, 0.0, v);
        vertices.push(Vertex::new(center.x, center.y, 0.0, [cr, cg, cb, 1.0]));

        let seg_count = WHEEL_SEGMENTS + 1;
        for ring in 1..=WHEEL_RINGS {
            let s_ring = ring as f32 / WHEEL_RINGS as f32;
            let r = s_ring * radius;
            for seg in 0..seg_count {
                let t = seg as f32 / WHEEL_SEGMENTS as f32;
                let angle = t * std::f32::consts::TAU;
                let (rr, gg, bb) = hsv_to_rgb(t, s_ring, v);
                let x = center.x + r * angle.cos();
                let y = center.y + r * angle.sin();
                vertices.push(Vertex::new(x, y, 0.0, [rr, gg, bb, 1.0]));
            }
        }

        for seg in 0..WHEEL_SEGMENTS {
            indices.extend_from_slice(&[0, 1 + seg as u32, 1 + (seg as u32 + 1)]);
        }
        for ring in 1..WHEEL_RINGS {
            let ring_start = 1 + (ring - 1) * seg_count;
            let next_start = 1 + ring * seg_count;
            for seg in 0..WHEEL_SEGMENTS {
                let a = (ring_start + seg) as u32;
                let b = (ring_start + seg + 1) as u32;
                let c = (next_start + seg) as u32;
                let d = (next_start + seg + 1) as u32;
                indices.extend_from_slice(&[a, b, d, a, d, c]);
            }
        }
        painter.mesh(vertices, indices);

        let bounds = Rect::from_center_size(center, vec2(radius * 2.0, radius * 2.0));
        let resp = interact(ctx, bounds, id, Sense::click_and_drag());
        let mut changed = false;
        if resp.dragged() || resp.clicked() {
            if let Some(p) = ctx.input(|i| i.pointer.pos) {
                let dx = p.x - center.x;
                let dy = p.y - center.y;
                let dist = (dx * dx + dy * dy).sqrt();
                let ang = dy.atan2(dx);
                let ang = if ang < 0.0 { ang + std::f32::consts::TAU } else { ang };
                *h = ang / std::f32::consts::TAU;
                *s = (dist / radius).clamp(0.0, 1.0);
                changed = true;
            }
        }

        let mx = center.x + *s * radius * (*h * std::f32::consts::TAU).cos();
        let my = center.y + *s * radius * (*h * std::f32::consts::TAU).sin();
        let marker_color = if v > 0.5 { Color32::BLACK } else { Color32::WHITE };
        painter.circle_stroke(pos2(mx, my), 5.0, Stroke::new(2.0, marker_color));
        painter.circle_stroke(pos2(mx, my), 6.5, Stroke::new(1.0, Color32::from_gray(128)));

        changed
    }

    /// Draws the swatch button; clicking it toggles a popup with the wheel + value/alpha
    /// sliders + hex field. Mutates `rgba` ([r,g,b,a], each 0..1) in place.
    pub fn show(self, ui: &mut Ui, rgba: &mut [f32; 4]) -> Response {
        let id = self.id;
        let ctx = ui.ctx().clone();

        let size = vec2(SWATCH_W, ui.style().spacing.interact_size.y);
        let (rect, mut response) = ui.allocate_response(size, Sense::click());
        let swatch_color = Color32::from_rgba_f32(*rgba);
        {
            let painter = ui.painter();
            painter.rect_filled(rect, 4u8, swatch_color);
            painter.rect_stroke(rect, 4u8, ui.visuals().widgets.inactive.bg_stroke, StrokeKind::Middle);
        }

        let is_open_before = ctx.memory(|m| m.popup_open) == Some(id);
        if response.clicked() {
            ctx.memory_mut(|m| m.popup_open = if is_open_before { None } else { Some(id) });
        }
        let is_open = ctx.memory(|m| m.popup_open) == Some(id);
        let just_opened = is_open && !is_open_before;

        if is_open {
            let popup_w = WHEEL_RADIUS * 2.0 + POPUP_PAD * 2.0;
            let popup_h = WHEEL_RADIUS * 2.0 + POPUP_PAD * 2.0 + CONTROLS_H;
            let popup_rect = Rect::from_min_size(pos2(rect.min.x, rect.max.y + 4.0), vec2(popup_w, popup_h));

            let style = ui.style();
            let bg = Painter::new(ctx.clone(), Rect::everything(), DrawTarget::Popup);
            bg.rect_filled(popup_rect, style.visuals.window_corner_radius, style.visuals.window_fill);
            bg.rect_stroke(popup_rect, style.visuals.window_corner_radius, style.visuals.window_stroke, StrokeKind::Middle);

            let (mut h, mut s, mut v) = rgb_to_hsv(rgba[0], rgba[1], rgba[2]);
            let mut a = rgba[3];
            let mut changed = false;
            let mut wheel_or_sliders_changed = just_opened;

            let wheel_center = pos2(popup_rect.min.x + POPUP_PAD + WHEEL_RADIUS, popup_rect.min.y + POPUP_PAD + WHEEL_RADIUS);
            if Self::wheel(&ctx, id.with("wheel"), &bg, wheel_center, WHEEL_RADIUS, &mut h, &mut s, v) {
                changed = true;
                wheel_or_sliders_changed = true;
            }

            let controls_top = wheel_center.y + WHEEL_RADIUS + 10.0;
            let content_rect = Rect::from_min_max(pos2(popup_rect.min.x + POPUP_PAD, controls_top), pos2(popup_rect.max.x - POPUP_PAD, popup_rect.max.y - POPUP_PAD));
            let mut popup_ui = Ui::new(ctx.clone(), id.with("popup"), content_rect, Layout::top_down(Align::Min), popup_rect, DrawTarget::Popup);

            if popup_ui.add(Slider::new(&mut v, 0.0_f32..=1.0_f32).text("Value")).changed() {
                changed = true;
                wheel_or_sliders_changed = true;
            }
            if popup_ui.add(Slider::new(&mut a, 0.0_f32..=1.0_f32).text("Alpha")).changed() {
                changed = true;
            }

            let (hr, hg, hb) = hsv_to_rgb(h, s, v);
            let hex_id = id.with("hex");
            let mut hex_draft = ctx.memory(|m| m.get_text_draft(hex_id)).unwrap_or_default();
            if wheel_or_sliders_changed || hex_draft.is_empty() {
                hex_draft = to_hex(hr, hg, hb);
            }
            popup_ui.label("Hex");
            let hex_resp = popup_ui.text_edit_singleline(&mut hex_draft);
            if hex_resp.changed() {
                if let Some((pr, pg, pb)) = parse_hex(&hex_draft) {
                    let (ph, ps, pv) = rgb_to_hsv(pr, pg, pb);
                    h = ph;
                    s = ps;
                    v = pv;
                    changed = true;
                }
            }
            ctx.memory_mut(|m| m.set_text_draft(hex_id, hex_draft));

            if changed {
                let (fr, fg, fb) = hsv_to_rgb(h, s, v);
                *rgba = [fr, fg, fb, a];
                response.mark_changed();
            }

            // Any primary press outside both the swatch button and the popup itself closes it
            // next frame - same convention `ComboBox`'s popup already uses.
            let press_pos = ui.input(|i| if i.pointer.primary_pressed { i.pointer.pos } else { None });
            if let Some(p) = press_pos {
                if !rect.contains(p) && !popup_rect.contains(p) {
                    ctx.memory_mut(|m| if m.popup_open == Some(id) { m.popup_open = None });
                }
            }
        }

        response
    }
}
