//! `TrackView` — a generic, pannable/zoomable multi-track clip editor: one lane per track,
//! colored clip blocks with drag-to-move and edge-drag-to-trim, an optional waveform (as a
//! peak-bar array) drawn inside a clip for audio, a playhead, and Delete/right-click to
//! remove a clip. Same domain-agnostic shape as `NodeGraphEditor`/`KeyframeTimeline` (see
//! their module docs) - the caller hands in plain `Track`/`TrackClip` data rebuilt from its
//! own state every frame, `show()` returns `TrackViewEvent`s to apply back, and a live-drag
//! override in `Memory` keeps a move/resize visually smooth without the widget ever getting
//! a `&mut` into the caller's clips directly.
//!
//! This generalizes the clip-lane rendering that already existed, addon-editor-specific, in
//! `core::video_timeline_ui::VideoTimeline` (its `render_clip` closure, built directly
//! against `Editor`/`stunts_state`'s four hardcoded object kinds) - same move/resize/select
//! interaction, rebuilt against plain data plus an added waveform lane so it can host both
//! video and audio clips, driven from the JS addon API the same way `Snarl`/`PianoRoll`
//! already are.
//!
//! ## Known v1 simplifications (documented, not accidental)
//!
//! - A clip's waveform is drawn from caller-supplied peaks (`TrackClip::peaks`, one bar per
//!   sample bucket, 0..1 normalized) - this widget never decodes audio itself. An addon owns
//!   getting from a file to a peaks array.
//! - No thumbnail rendering for video clips (that needs a registered GPU texture per clip,
//!   the same machinery `MiniMap` uses for its landscape preview) - a video clip is a solid
//!   color block with its label, same as any other non-audio clip until that's built.
//! - Same overlapping-hit-testing and pan/zoom restrictions documented in
//!   `widgets_keyframe_timeline`'s module docs apply here too (shared code shape).

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::context::Key;
use crate::entropy_gui::geometry::{pos2, vec2, Align2, CursorIcon, FontId, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::memory::ClipDragKind;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::ui::{interact, Ui};

const RULER_H: f32 = 22.0;
const TRACK_H: f32 = 44.0;
const LABEL_W: f32 = 120.0;
const CLIP_PAD_Y: f32 = 5.0;
const EDGE_GRAB: f32 = 6.0;
const MIN_CLIP_MS: i32 = 20;
const MIN_ZOOM: f32 = 0.5; // ms per pixel
const MAX_ZOOM: f32 = 200.0;

#[derive(Clone, Debug)]
pub struct TrackClip {
    /// Unique within the whole `TrackView` - not just its track.
    pub id: String,
    pub label: String,
    pub start_ms: i32,
    pub duration_ms: i32,
    pub color: Color32,
    /// Normalized (0..1) amplitude peaks drawn as vertical bars filling the clip - empty
    /// means "no waveform" (the typical case for a video/generic clip).
    pub peaks: Vec<f32>,
}

impl TrackClip {
    pub fn new(id: impl Into<String>, label: impl Into<String>, start_ms: i32, duration_ms: i32, color: Color32) -> Self {
        Self { id: id.into(), label: label.into(), start_ms, duration_ms, color, peaks: Vec::new() }
    }
}

#[derive(Clone, Debug)]
pub struct Track {
    /// Unique within the timeline.
    pub id: String,
    pub label: String,
    pub clips: Vec<TrackClip>,
}

impl Track {
    pub fn new(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self { id: id.into(), label: label.into(), clips: Vec::new() }
    }
}

#[derive(Clone, Debug)]
pub enum TrackViewEvent {
    Seek(i32),
    /// Fired every frame a clip is being moved - apply it to your own data so the position
    /// this widget shows converges with what you hand back in next frame's `tracks`.
    ClipMoved { track: String, clip: String, start_ms: i32 },
    /// Fired every frame a clip's edge is being dragged.
    ClipResized { track: String, clip: String, start_ms: i32, duration_ms: i32 },
    /// A clip's move/resize drag started (indistinguishable from a plain click until
    /// release, same convention `NodeGraphEditor` uses) - use it for selection state.
    ClipSelected { track: String, clip: String },
    /// "Delete Clip" was chosen, or Delete/Backspace was pressed with one selected.
    ClipDeleteRequested { track: String, clip: String },
    /// A track's label gutter was clicked.
    TrackClicked(String),
    /// Empty canvas was clicked - the conventional "deselect" signal.
    BackgroundClicked,
}

pub struct TrackViewResponse {
    pub canvas_rect: Rect,
    pub events: Vec<TrackViewEvent>,
    pub zoom: f32,
}

pub struct TrackView {
    id: Id,
}

impl TrackView {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("track_view").with(id_salt) }
    }

    pub fn show(
        self,
        ui: &mut Ui,
        tracks: &[Track],
        duration_ms: i32,
        playhead_ms: i32,
        selected: Option<(&str, &str)>,
    ) -> TrackViewResponse {
        let ctx = ui.ctx().clone();
        let view_id = self.id;
        let (mut scroll_x, mut zoom) = ctx.memory(|m| m.get_timeline_view(view_id));

        let height = RULER_H + tracks.len().max(1) as f32 * TRACK_H;
        let size = vec2(ui.available_size().x.max(200.0), height.max(80.0));
        let (bg_response, painter) = ui.allocate_painter(size, Sense::click());
        let canvas_rect = bg_response.rect;
        let label_col = Rect::from_min_max(canvas_rect.min, pos2(canvas_rect.min.x + LABEL_W, canvas_rect.max.y));
        let grid_rect = Rect::from_min_max(pos2(canvas_rect.min.x + LABEL_W, canvas_rect.min.y), canvas_rect.max);

        let visuals = ui.visuals();
        painter.rect_filled(canvas_rect, visuals.window_corner_radius, visuals.extreme_bg_color);

        let pointer_pos = ui.input(|i| i.pointer.pos);
        let over_canvas = pointer_pos.map_or(false, |p| canvas_rect.contains(p));

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

        let ruler_resp = interact(&ctx, ruler_rect, view_id.with("ruler"), Sense::click_and_drag());
        if ruler_resp.clicked() || ruler_resp.dragged() {
            if let Some(p) = ruler_resp.interact_pointer_pos() {
                events.push(TrackViewEvent::Seek(x_to_time(p.x).clamp(0, duration_ms)));
            }
        }

        for (i, track) in tracks.iter().enumerate() {
            let y0 = grid_rect.min.y + RULER_H + i as f32 * TRACK_H;
            let lane_rect = Rect::from_min_size(pos2(grid_rect.min.x, y0), vec2(grid_rect.width(), TRACK_H));
            let bg = if i % 2 == 1 { Color32::from_gray(30) } else { Color32::from_gray(24) };
            painter.rect_filled(lane_rect, 0u8, bg);
            painter.line_segment([pos2(canvas_rect.min.x, y0 + TRACK_H), pos2(canvas_rect.max.x, y0 + TRACK_H)], Stroke::new(1.0, Color32::from_gray(48)));

            let label_rect = Rect::from_min_size(pos2(label_col.min.x, y0), vec2(LABEL_W, TRACK_H));
            let label_id = view_id.with(("track_label", &track.id));
            let label_resp = interact(&ctx, label_rect, label_id, Sense::click());
            if label_resp.clicked() {
                events.push(TrackViewEvent::TrackClicked(track.id.clone()));
            }
            painter.rect_filled(label_rect, 0u8, if label_resp.hovered() { visuals.widgets.hovered.bg_fill } else { visuals.widgets.inactive.bg_fill });
            painter.text(pos2(label_rect.min.x + 6.0, label_rect.center().y), Align2::LEFT_CENTER, &track.label, FontId::proportional(11.0), Color32::from_gray(220));

            for clip in &track.clips {
                let clip_id = view_id.with(("clip", &clip.id));
                let live = ctx.memory(|m| m.clip_drag.clone()).filter(|(id, _, _, _)| *id == clip_id);
                let (eff_start, eff_dur) = live.map(|(_, _, s, d)| (s, d)).unwrap_or((clip.start_ms, clip.duration_ms));

                let x0 = time_to_x(eff_start);
                let w = (eff_dur as f32 / zoom).max(4.0);
                let clip_rect = Rect::from_min_size(pos2(x0, y0 + CLIP_PAD_Y), vec2(w, TRACK_H - CLIP_PAD_Y * 2.0));

                let resp = interact(&ctx, clip_rect, clip_id, Sense::click_and_drag());
                let hover_pos = ui.input(|i| i.pointer.pos);
                let on_left_edge = resp.hovered() && hover_pos.map_or(false, |p| p.x < clip_rect.min.x + EDGE_GRAB);
                let on_right_edge = resp.hovered() && hover_pos.map_or(false, |p| p.x > clip_rect.max.x - EDGE_GRAB);
                if on_left_edge || on_right_edge {
                    ui.output_mut(|o| o.cursor_icon = CursorIcon::ResizeHorizontal);
                }

                if resp.drag_started() {
                    let kind = if on_left_edge {
                        ClipDragKind::ResizeLeft
                    } else if on_right_edge {
                        ClipDragKind::ResizeRight
                    } else {
                        ClipDragKind::Move
                    };
                    ctx.memory_mut(|m| m.clip_drag = Some((clip_id, kind, clip.start_ms, clip.duration_ms)));
                    events.push(TrackViewEvent::ClipSelected { track: track.id.clone(), clip: clip.id.clone() });
                } else if resp.dragged() {
                    let delta_time = (resp.drag_delta().x * zoom).round() as i32;
                    let kind = ctx.memory(|m| m.clip_drag.clone()).filter(|(id, _, _, _)| *id == clip_id).map(|(_, k, _, _)| k);
                    if let Some(kind) = kind {
                        let (mut new_start, mut new_dur) = (eff_start, eff_dur);
                        match kind {
                            ClipDragKind::Move => {
                                new_start = (eff_start + delta_time).max(0);
                            }
                            ClipDragKind::ResizeLeft => {
                                let candidate = (eff_start + delta_time).max(0);
                                let max_start = eff_start + eff_dur - MIN_CLIP_MS;
                                new_start = candidate.min(max_start);
                                new_dur = eff_start + eff_dur - new_start;
                            }
                            ClipDragKind::ResizeRight => {
                                new_dur = (eff_dur + delta_time).max(MIN_CLIP_MS);
                            }
                        }
                        ctx.memory_mut(|m| m.clip_drag = Some((clip_id, kind, new_start, new_dur)));
                        if matches!(kind, ClipDragKind::Move) {
                            events.push(TrackViewEvent::ClipMoved { track: track.id.clone(), clip: clip.id.clone(), start_ms: new_start });
                        } else {
                            events.push(TrackViewEvent::ClipResized { track: track.id.clone(), clip: clip.id.clone(), start_ms: new_start, duration_ms: new_dur });
                        }
                    }
                }
                if resp.drag_stopped() {
                    ctx.memory_mut(|m| m.clip_drag = None);
                }

                let is_selected = selected == Some((track.id.as_str(), clip.id.as_str()));
                let fill = if is_selected { clip.color.lerp(Color32::WHITE, 0.25) } else { clip.color };
                painter.rect_filled(clip_rect, 3u8, fill);
                let border_color = if is_selected { Color32::WHITE } else { Color32::from_gray(210) };
                painter.rect_stroke(clip_rect, 3u8, Stroke::new(if is_selected { 2.0 } else { 1.0 }, border_color), StrokeKind::Middle);

                if !clip.peaks.is_empty() {
                    let bars = clip.peaks.len();
                    let bar_w = (clip_rect.width() / bars as f32).max(1.0);
                    let mid_y = clip_rect.center().y;
                    for (bi, amp) in clip.peaks.iter().enumerate() {
                        let amp = amp.clamp(0.0, 1.0);
                        let bar_h = (clip_rect.height() * 0.9 * amp).max(1.0);
                        let bx = clip_rect.min.x + bi as f32 * bar_w;
                        if bx > clip_rect.max.x {
                            break;
                        }
                        painter.line_segment(
                            [pos2(bx + bar_w * 0.5, mid_y - bar_h * 0.5), pos2(bx + bar_w * 0.5, mid_y + bar_h * 0.5)],
                            Stroke::new(bar_w.min(2.0), Color32::from_rgba_unmultiplied(255, 255, 255, 190)),
                        );
                    }
                }

                let text_rect = clip_rect.shrink(3.0);
                let p = painter.with_clip_rect(clip_rect);
                p.text(text_rect.left_top(), Align2::LEFT_TOP, &clip.label, FontId::proportional(11.0), Color32::WHITE);

                let mut delete_request = false;
                resp.context_menu(|menu_ui| {
                    if menu_ui.button("Delete Clip").clicked() {
                        delete_request = true;
                        menu_ui.close_menu();
                    }
                });
                if delete_request {
                    events.push(TrackViewEvent::ClipDeleteRequested { track: track.id.clone(), clip: clip.id.clone() });
                }
            }
        }

        let ph_x = time_to_x(playhead_ms);
        if ph_x >= grid_rect.min.x && ph_x <= grid_rect.max.x {
            painter.line_segment([pos2(ph_x, grid_rect.min.y), pos2(ph_x, grid_rect.max.y)], Stroke::new(1.5, Color32::from_rgb(0xDD, 0xA3, 0x3D)));
        }

        painter.rect_stroke(grid_rect, 0u8, Stroke::new(1.0, Color32::from_gray(90)), StrokeKind::Middle);

        let bg_drag_resp = interact(&ctx, grid_rect, view_id.with("bg_pan"), Sense::drag());
        if bg_drag_resp.dragged() {
            scroll_x += bg_drag_resp.drag_delta().x;
        }
        if bg_response.clicked() {
            events.push(TrackViewEvent::BackgroundClicked);
        }

        if let Some((track_id, clip_id)) = selected {
            let delete_pressed = ui.input(|i| i.key_events.iter().any(|k| k.pressed && matches!(k.key, Key::Delete | Key::Backspace)));
            if delete_pressed {
                events.push(TrackViewEvent::ClipDeleteRequested { track: track_id.to_string(), clip: clip_id.to_string() });
            }
        }

        ctx.memory_mut(|m| m.set_timeline_view(view_id, scroll_x, zoom));

        TrackViewResponse { canvas_rect, events, zoom }
    }
}
