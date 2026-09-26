//! `ScrollArea` - a clipped region whose content can be taller (or wider) than it.
//!
//! - A notched mouse wheel eases toward its target instead of jumping (off with
//!   `UiPrefs::reduce_motion`); trackpad scrolling, already smooth, is followed exactly.
//! - The scrollbar thumb can be dragged, and a click on the track pages toward the click.
//! - Page Up/Down, Home and End scroll the area under the pointer, or the one holding the
//!   focused widget (after that widget had its chance to use the key).
//! - When keyboard focus moves to a widget inside, the area scrolls it into view.

use crate::entropy_gui::context::Key;
use crate::entropy_gui::geometry::{pos2, vec2, Align, Layout, Rect, Vec2};
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::ui::{interact, InnerResponse, Ui};

/// Width of the thumb at rest and while hovered/dragged. The hit area is always the wider one.
const BAR_W: f32 = 4.0;
const BAR_W_ACTIVE: f32 = 8.0;
/// How quickly an eased scroll closes on its target: the remaining distance shrinks by
/// `1 - exp(-EASE_RATE * dt)` each frame (about 90% in 0.13 s).
const EASE_RATE: f32 = 18.0;
/// Space kept between a revealed widget and the area's edge.
const REVEAL_MARGIN: f32 = 8.0;

#[derive(Clone, Copy, Default)]
struct ScrollState {
    /// Where the content is drawn from.
    offset: Vec2,
    /// Where the wheel and keys asked to go; `offset` eases toward it.
    target: Vec2,
    /// Last frame's content overflowed vertically: this frame keeps a gutter for the scrollbar
    /// so content never sits under it (a drag on the thumb must not also click a row).
    overflow_y: bool,
}

pub struct ScrollArea {
    vertical: bool,
    horizontal: bool,
}

impl ScrollArea {
    pub fn vertical() -> Self {
        Self { vertical: true, horizontal: false }
    }
    pub fn horizontal() -> Self {
        Self { vertical: false, horizontal: true }
    }
    pub fn both() -> Self {
        Self { vertical: true, horizontal: true }
    }

    pub fn show<R>(self, ui: &mut Ui, add_contents: impl FnOnce(&mut Ui) -> R) -> InnerResponse<R> {
        let id = ui.next_auto_id("scroll_area");
        let region = ui.available_rect_before_wrap();
        let ctx = ui.ctx().clone();
        let mut st: ScrollState = ctx.memory_mut(|m| m.take_view_state(id.with("state")));
        let reduce_motion = ctx.prefs().reduce_motion;
        let dt = ui.input(|i| i.dt);

        let pointer = ui.input(|i| i.pointer.pos);
        let hovered = pointer.map_or(false, |p| region.contains(p));
        // With areas nested (a scrolling list inside a scrolling page) the wheel belongs to the
        // innermost one under the pointer, not to both.
        let inner_owns = pointer.map_or(false, |p| ctx.memory(|m| m.scroll_owned_by_inner(id, region, p)));
        let owns_pointer = hovered && !inner_owns;
        if owns_pointer {
            let (delta, in_lines) = ui.input(|i| (i.scroll_delta, i.scroll_in_lines));
            let before = st.target;
            if self.vertical {
                st.target.y -= delta.y;
            }
            if self.horizontal {
                st.target.x -= if self.vertical { delta.x } else { delta.x + delta.y };
            }
            // A trackpad already scrolls smoothly: follow it exactly rather than lag behind it.
            if !in_lines {
                st.offset += st.target - before;
            }
        }

        // Ease the drawn offset toward the target.
        if reduce_motion {
            st.offset = st.target;
        } else {
            let k = 1.0 - (-EASE_RATE * dt.max(0.0)).exp();
            st.offset += (st.target - st.offset) * k;
            if (st.target - st.offset).length() < 0.5 {
                st.offset = st.target;
            }
        }

        const HUGE: f32 = 100_000.0;
        let gutter = if self.vertical && st.overflow_y { BAR_W_ACTIVE + 4.0 } else { 0.0 };
        let content_max_rect = Rect::from_min_size(
            pos2(region.min.x - st.offset.x, region.min.y - st.offset.y),
            vec2(if self.horizontal { HUGE } else { region.width() - gutter }, if self.vertical { HUGE } else { region.height() }),
        );
        let clip = ui.clip_rect.intersect(region);
        let focus_before = ctx.focus_entry_count();
        let reveal_before = ctx.has_pending_reveal_rect();
        let mut child = Ui::new(ctx.clone(), id.with("content"), content_max_rect, Layout::top_down(Align::Min), clip, ui.draw_target);
        let inner = add_contents(&mut child);
        let content_size = child.min_rect().size();
        let max_offset = vec2((content_size.x - region.width()).max(0.0), (content_size.y - region.height()).max(0.0));
        let focus_inside = ctx.focused_since(focus_before);

        // Keyboard paging: the area under the pointer, or the one holding focus.
        if (owns_pointer && !ctx.wants_keyboard_input()) || focus_inside {
            let page = (region.height() - 40.0).max(region.height() * 0.5);
            if self.vertical && max_offset.y > 0.0 {
                if ctx.consume_key(Key::PageDown) {
                    st.target.y += page;
                }
                if ctx.consume_key(Key::PageUp) {
                    st.target.y -= page;
                }
                if !focus_inside {
                    if ctx.consume_key(Key::Home) {
                        st.target.y = 0.0;
                    }
                    if ctx.consume_key(Key::End) {
                        st.target.y = max_offset.y;
                    }
                }
            }
        }

        // A widget inside just got keyboard focus: bring it into view, then let an enclosing
        // area bring this whole region into view in turn.
        if !reveal_before {
            if let Some(r) = ctx.take_reveal_rect() {
                if self.vertical {
                    if r.min.y < region.min.y + REVEAL_MARGIN {
                        st.target.y = st.offset.y - (region.min.y + REVEAL_MARGIN - r.min.y);
                    } else if r.max.y > region.max.y - REVEAL_MARGIN {
                        st.target.y = st.offset.y + (r.max.y - (region.max.y - REVEAL_MARGIN)).min(r.min.y - region.min.y - REVEAL_MARGIN);
                    }
                }
                if self.horizontal {
                    if r.min.x < region.min.x + REVEAL_MARGIN {
                        st.target.x = st.offset.x - (region.min.x + REVEAL_MARGIN - r.min.x);
                    } else if r.max.x > region.max.x - REVEAL_MARGIN {
                        st.target.x = st.offset.x + (r.max.x - (region.max.x - REVEAL_MARGIN));
                    }
                }
                ctx.put_reveal_rect(region);
            }
        }

        // Scrollbar: drag the thumb, or click the track to page toward the click.
        let mut thumb_dragged = false;
        if self.vertical && content_size.y > region.height() {
            let track = Rect::from_min_size(pos2(region.max.x - BAR_W_ACTIVE - 2.0, region.min.y), vec2(BAR_W_ACTIVE + 2.0, region.height()));
            let ratio = (region.height() / content_size.y).clamp(0.02, 1.0);
            let thumb_h = (track.height() * ratio).max(18.0).min(track.height());
            let travel = (track.height() - thumb_h).max(1.0);
            let range = max_offset.y.max(1.0);
            let thumb_y = track.min.y + travel * (st.offset.y / range).clamp(0.0, 1.0);
            let thumb_hit = Rect::from_min_size(pos2(track.min.x, thumb_y), vec2(track.width(), thumb_h));

            let thumb_resp = interact(&ctx, thumb_hit, id.with("thumb"), Sense::drag());
            if thumb_resp.dragged() {
                thumb_dragged = true;
                st.target.y += thumb_resp.drag_delta().y * range / travel;
                st.target.y = st.target.y.clamp(0.0, max_offset.y);
                st.offset.y = st.target.y;
            }
            let track_resp = interact(&ctx, track, id.with("track"), Sense::click());
            if track_resp.clicked() && !thumb_resp.hovered() {
                if let Some(p) = track_resp.interact_pointer_pos() {
                    let page = region.height() - 40.0;
                    st.target.y += if p.y < thumb_y { -page } else { page };
                }
            }

            let active = thumb_resp.hovered() || thumb_resp.dragged() || track_resp.hovered();
            let w = if active { BAR_W_ACTIVE } else { BAR_W };
            let visuals = ui.visuals();
            // From the text color, not the border: a theme's border can be transparent, and the
            // thumb must always be findable.
            let base = visuals.override_text_color.unwrap_or(visuals.widgets.inactive.fg_stroke.color);
            let color = if thumb_resp.dragged() { visuals.selection.stroke.color } else { base.linear_multiply(if active { 0.55 } else { 0.28 }) };
            if active {
                ui.painter().rect_filled(Rect::from_min_size(pos2(region.max.x - w - 2.0, region.min.y), vec2(w, region.height())), 3u8, visuals.extreme_bg_color.linear_multiply(0.6));
            }
            let thumb = Rect::from_min_size(pos2(region.max.x - w - 2.0, thumb_y), vec2(w, thumb_h));
            ui.painter().rect_filled(thumb, 3u8, color);
        }

        st.target.x = st.target.x.clamp(0.0, max_offset.x);
        st.target.y = st.target.y.clamp(0.0, max_offset.y);
        st.offset.x = st.offset.x.clamp(0.0, max_offset.x);
        st.offset.y = st.offset.y.clamp(0.0, max_offset.y);
        let _ = thumb_dragged;
        st.overflow_y = self.vertical && content_size.y > region.height();
        ctx.memory_mut(|m| {
            m.set_scroll(id, st.offset);
            m.put_view_state(id.with("state"), st);
        });
        if (self.vertical && content_size.y > region.height()) || (self.horizontal && content_size.x > region.width()) {
            ctx.memory_mut(|m| m.note_scrollable(id, region));
        }

        ui.advance_after_child(Rect::from_min_size(region.min, region.size()));
        let resp_id = ui.next_auto_id("scroll_area_resp");
        InnerResponse { inner, response: ui.interact(region, resp_id, Sense::hover()) }
    }
}
