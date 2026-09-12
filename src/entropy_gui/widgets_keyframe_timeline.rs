//! `KeyframeTimeline` — a generic, pannable/zoomable keyframe editor: a row per animated
//! property, diamonds for keyframes, drag one to retime it, right-click a row to add one at
//! the playhead, Delete/Backspace to remove the selected one. Same domain-agnostic shape as
//! `NodeGraphEditor` (see `widgets_node_graph.rs`'s module docs) - the caller hands in plain
//! `KeyframeRow`/`Keyframe` data rebuilt from its own state every frame, `show()` returns
//! `KeyframeTimelineEvent`s to apply back, and a per-keyframe live-drag override in `Memory`
//! keeps dragging visually smooth even though the widget never gets a `&mut` into the
//! caller's keyframes directly.
//!
//! This generalizes the keyframe-row rendering that already existed, addon-editor-specific,
//! in `core::video_timeline_ui::VideoTimeline` (built directly against `Editor`/
//! `stunts_state`) - same interaction model (drag-to-retime, right-click-to-add,
//! ms-per-pixel zoom, playhead), rebuilt against plain data so it can be driven from the JS
//! addon API the same way `Snarl`/`PianoRoll` already are.
//!
//! ## Known v1 simplifications (documented, not accidental)
//!
//! - Zooming (vertical scroll wheel, mirrors `NodeGraphEditor`) keeps the cursor's *time*
//!   fixed on screen exactly like the node graph's 2D zoom does - but panning is left-drag
//!   only, same single-axis restriction as the node graph's lack of middle-mouse pan.
//! - Delete/Backspace removes the selected keyframe whenever this widget has one, without
//!   requiring the pointer to be over the canvas first (`NodeGraphEditor` requires hover) -
//!   fine as long as an addon screen shows at most one keyframe timeline, which is the only
//!   case exercised so far.
//! - "Add Keyframe" is only offered at the current playhead position (right-click a row),
//!   not at an arbitrary clicked time - same restriction `VideoTimeline`'s property tracks
//!   already shipped with, kept here for consistency rather than novelty.
//! - Overlapping-region hit testing has no occlusion (same as `NodeGraphEditor`): clicking a
//!   keyframe also satisfies the background canvas's own click sense, so a caller may see a
//!   `KeyframeSelected` and a `BackgroundClicked` on the same frame. Apply `BackgroundClicked`
//!   as "deselect unless something more specific also fired," same as the node graph editor.

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::context::Key;
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::shape::Shape;
use crate::entropy_gui::ui::{interact, Ui};

const RULER_H: f32 = 22.0;
const ROW_H: f32 = 26.0;
const LABEL_W: f32 = 120.0;
const KF_HALF: f32 = 5.0;
const KF_HIT_PAD: f32 = 4.0;
const MIN_ZOOM: f32 = 0.5; // ms per pixel
const MAX_ZOOM: f32 = 200.0;

#[derive(Clone, Debug)]
pub struct Keyframe {
    /// Unique within this row - not globally unique.
    pub id: String,
    pub time_ms: i32,
}

impl Keyframe {
    pub fn new(id: impl Into<String>, time_ms: i32) -> Self {
        Self { id: id.into(), time_ms }
    }
}

#[derive(Clone, Debug)]
pub struct KeyframeRow {
    /// Unique within the timeline.
    pub id: String,
    pub label: String,
    pub keyframes: Vec<Keyframe>,
}

impl KeyframeRow {
    pub fn new(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self { id: id.into(), label: label.into(), keyframes: Vec::new() }
    }
}

#[derive(Clone, Debug)]
pub enum KeyframeTimelineEvent {
    /// Ruler was clicked/dragged - conventionally, seek the playhead here.
    Seek(i32),
    /// Fired every frame a keyframe is being dragged - apply it to your own data so the
    /// position this widget shows converges with what you hand back in next frame's `rows`.
    KeyframeMoved { row: String, keyframe: String, time_ms: i32 },
    /// A keyframe drag started (indistinguishable from a plain click until release, same
    /// convention `NodeGraphEditor` uses) - use it to update your own selection state.
    KeyframeSelected { row: String, keyframe: String },
    /// "Add Keyframe at Playhead" was chosen from a row's right-click menu.
    KeyframeAddRequested { row: String, time_ms: i32 },
    /// "Delete Keyframe" was chosen, or Delete/Backspace was pressed with one selected.
    KeyframeDeleteRequested { row: String, keyframe: String },
    /// A row's label gutter was clicked - use it for row selection/focus.
    RowClicked(String),
    /// Empty canvas was clicked - the conventional "deselect" signal.
    BackgroundClicked,
}

pub struct KeyframeTimelineResponse {
    pub canvas_rect: Rect,
    pub events: Vec<KeyframeTimelineEvent>,
    pub zoom: f32,
}

pub struct KeyframeTimeline {
    id: Id,
}

impl KeyframeTimeline {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("keyframe_timeline").with(id_salt) }
    }

    pub fn show(
        self,
        ui: &mut Ui,
        rows: &[KeyframeRow],
        duration_ms: i32,
        playhead_ms: i32,
        selected: Option<(&str, &str)>,
    ) -> KeyframeTimelineResponse {
        let ctx = ui.ctx().clone();
        let timeline_id = self.id;
        let (mut scroll_x, mut zoom) = ctx.memory(|m| m.get_timeline_view(timeline_id));

        let height = RULER_H + rows.len().max(1) as f32 * ROW_H;
        let size = vec2(ui.available_size().x.max(200.0), height.max(60.0));
        let (bg_response, painter) = ui.allocate_painter(size, Sense::click());
        let canvas_rect = bg_response.rect;
        let label_col = Rect::from_min_max(canvas_rect.min, pos2(canvas_rect.min.x + LABEL_W, canvas_rect.max.y));
        let grid_rect = Rect::from_min_max(pos2(canvas_rect.min.x + LABEL_W, canvas_rect.min.y), canvas_rect.max);

        let visuals = ui.visuals();
        painter.rect_filled(canvas_rect, visuals.window_corner_radius, visuals.extreme_bg_color);

        let pointer_pos = ui.input(|i| i.pointer.pos);
        let over_canvas = pointer_pos.map_or(false, |p| canvas_rect.contains(p));

        // Zoom: mouse wheel over the canvas, keeping the time under the cursor fixed on
        // screen - same shape as `NodeGraphEditor`'s wheel zoom, just one axis.
        let scroll = ui.input(|i| i.scroll_delta.y);
        if scroll.abs() > 0.0 && over_canvas {
            if let Some(cursor) = pointer_pos {
                let time_at_cursor = (cursor.x - grid_rect.min.x - scroll_x) * zoom;
                let factor = (1.0 + scroll * 0.0015).clamp(0.5, 1.6);
                zoom = (zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
                scroll_x = cursor.x - grid_rect.min.x - time_at_cursor / zoom;
            }
        }

        let time_to_x = |t: i32| grid_rect.min.x + scroll_x + t as f32 / zoom;
        let x_to_time = |x: f32| ((x - grid_rect.min.x - scroll_x) * zoom) as i32;

        let mut events = Vec::new();

        // Ruler + ticks.
        let ruler_rect = Rect::from_min_max(grid_rect.min, pos2(grid_rect.max.x, grid_rect.min.y + RULER_H));
        painter.rect_filled(ruler_rect, 0u8, visuals.widgets.inactive.bg_fill);
        let tick_ms = if zoom < 10.0 { 100 } else if zoom < 50.0 { 500 } else { 1000 };
        let mut t = 0;
        while t <= duration_ms {
            let x = time_to_x(t);
            if x >= grid_rect.min.x && x <= grid_rect.max.x {
                let is_major = t % 1000 == 0;
                let h = if is_major { 12.0 } else { 6.0 };
                painter.line_segment([pos2(x, ruler_rect.max.y - h), pos2(x, ruler_rect.max.y)], Stroke::new(1.0, Color32::from_gray(140)));
                if is_major {
                    painter.text(pos2(x + 2.0, ruler_rect.min.y + 2.0), Align2::LEFT_TOP, format!("{}s", t / 1000), FontId::monospace(10.0), Color32::from_gray(200));
                }
            }
            t += tick_ms;
        }

        // Ruler seek (click or drag) - a dedicated click_and_drag sense on just the ruler
        // strip, same "scrub the playhead" convention `VideoTimeline` already used.
        let ruler_resp = interact(&ctx, ruler_rect, timeline_id.with("ruler"), Sense::click_and_drag());
        if ruler_resp.clicked() || ruler_resp.dragged() {
            if let Some(p) = ruler_resp.interact_pointer_pos() {
                events.push(KeyframeTimelineEvent::Seek(x_to_time(p.x).clamp(0, duration_ms)));
            }
        }

        // Row lanes + labels.
        for (i, row) in rows.iter().enumerate() {
            let y0 = grid_rect.min.y + RULER_H + i as f32 * ROW_H;
            let lane_rect = Rect::from_min_size(pos2(grid_rect.min.x, y0), vec2(grid_rect.width(), ROW_H));
            let bg = if i % 2 == 1 { Color32::from_gray(34) } else { Color32::from_gray(28) };
            painter.rect_filled(lane_rect, 0u8, bg);
            painter.line_segment([pos2(canvas_rect.min.x, y0 + ROW_H), pos2(canvas_rect.max.x, y0 + ROW_H)], Stroke::new(1.0, Color32::from_gray(48)));

            let label_rect = Rect::from_min_size(pos2(label_col.min.x, y0), vec2(LABEL_W, ROW_H));
            let label_id = timeline_id.with(("row_label", &row.id));
            let label_resp = interact(&ctx, label_rect, label_id, Sense::click());
            if label_resp.clicked() {
                events.push(KeyframeTimelineEvent::RowClicked(row.id.clone()));
            }
            painter.rect_filled(label_rect, 0u8, if label_resp.hovered() { visuals.widgets.hovered.bg_fill } else { visuals.widgets.inactive.bg_fill });
            painter.text(pos2(label_rect.min.x + 6.0, label_rect.center().y), Align2::LEFT_CENTER, &row.label, FontId::proportional(11.0), Color32::from_gray(220));

            let row_bg_resp = interact(&ctx, lane_rect, timeline_id.with(("row_bg", &row.id)), Sense::click());
            let mut add_request = None;
            row_bg_resp.context_menu(|menu_ui| {
                if menu_ui.button("Add Keyframe at Playhead").clicked() {
                    add_request = Some(playhead_ms);
                    menu_ui.close_menu();
                }
            });
            if let Some(time_ms) = add_request {
                events.push(KeyframeTimelineEvent::KeyframeAddRequested { row: row.id.clone(), time_ms });
            }

            for kf in &row.keyframes {
                let kf_id = timeline_id.with(("kf", &row.id, &kf.id));
                let live = ctx.memory(|m| m.keyframe_drag).filter(|(id, _)| *id == kf_id).map(|(_, t)| t);
                let effective_time = live.unwrap_or(kf.time_ms);
                let x = time_to_x(effective_time);
                let center = pos2(x, y0 + ROW_H * 0.5);
                let hit = Rect::from_center_size(center, vec2((KF_HALF + KF_HIT_PAD) * 2.0, (KF_HALF + KF_HIT_PAD) * 2.0));
                let resp = interact(&ctx, hit, kf_id, Sense::click_and_drag());

                if resp.drag_started() {
                    ctx.memory_mut(|m| m.keyframe_drag = Some((kf_id, kf.time_ms)));
                    events.push(KeyframeTimelineEvent::KeyframeSelected { row: row.id.clone(), keyframe: kf.id.clone() });
                } else if resp.dragged() {
                    let delta_time = resp.drag_delta().x * zoom;
                    let new_time = (effective_time as f32 + delta_time).round() as i32;
                    let clamped = new_time.clamp(0, duration_ms);
                    ctx.memory_mut(|m| m.keyframe_drag = Some((kf_id, clamped)));
                    events.push(KeyframeTimelineEvent::KeyframeMoved { row: row.id.clone(), keyframe: kf.id.clone(), time_ms: clamped });
                }
                if resp.drag_stopped() {
                    ctx.memory_mut(|m| m.keyframe_drag = None);
                }

                let is_selected = selected == Some((row.id.as_str(), kf.id.as_str()));
                let fill = if is_selected {
                    visuals.selection.stroke.color
                } else if resp.hovered() {
                    Color32::WHITE
                } else {
                    Color32::from_gray(200)
                };
                let d = KF_HALF;
                let pts = vec![pos2(center.x, center.y - d), pos2(center.x + d, center.y), pos2(center.x, center.y + d), pos2(center.x - d, center.y)];
                painter.add(Shape::convex_polygon(pts, fill, Stroke::new(1.0, Color32::BLACK)));

                let mut delete_request = false;
                resp.context_menu(|menu_ui| {
                    if menu_ui.button("Delete Keyframe").clicked() {
                        delete_request = true;
                        menu_ui.close_menu();
                    }
                });
                if delete_request {
                    events.push(KeyframeTimelineEvent::KeyframeDeleteRequested { row: row.id.clone(), keyframe: kf.id.clone() });
                }
            }
        }

        // Playhead.
        let ph_x = time_to_x(playhead_ms);
        if ph_x >= grid_rect.min.x && ph_x <= grid_rect.max.x {
            painter.line_segment([pos2(ph_x, grid_rect.min.y), pos2(ph_x, grid_rect.max.y)], Stroke::new(1.5, Color32::from_rgb(0xDD, 0xA3, 0x3D)));
        }

        painter.rect_stroke(grid_rect, 0u8, Stroke::new(1.0, Color32::from_gray(90)), StrokeKind::Middle);

        // Background pan: left-drag on the grid, resolved after every row/keyframe
        // interaction above so a press on a keyframe lets its own `interact()` claim
        // `active_drag` first (same ordering rationale as `NodeGraphEditor`'s bg pan).
        let bg_drag_resp = interact(&ctx, grid_rect, timeline_id.with("bg_pan"), Sense::drag());
        if bg_drag_resp.dragged() {
            scroll_x += bg_drag_resp.drag_delta().x;
        }
        if bg_response.clicked() {
            events.push(KeyframeTimelineEvent::BackgroundClicked);
        }

        // Delete/Backspace for the selected keyframe - see the module's v1-simplifications doc.
        if let Some((row_id, kf_id)) = selected {
            let delete_pressed = ui.input(|i| i.key_events.iter().any(|k| k.pressed && matches!(k.key, Key::Delete | Key::Backspace)));
            if delete_pressed {
                events.push(KeyframeTimelineEvent::KeyframeDeleteRequested { row: row_id.to_string(), keyframe: kf_id.to_string() });
            }
        }

        ctx.memory_mut(|m| m.set_timeline_view(timeline_id, scroll_x, zoom));

        KeyframeTimelineResponse { canvas_rect, events, zoom }
    }
}
