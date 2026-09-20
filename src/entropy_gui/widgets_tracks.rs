//! `TrackView` - a generic, pannable/zoomable multi-track clip editor: one lane per track,
//! colored clip blocks with drag-to-move and edge-drag-to-trim, an optional waveform (as a
//! peak-bar array) or a miniature note preview drawn inside a clip, a playhead, and
//! Delete/right-click to remove a clip. Same domain-agnostic shape as
//! `NodeGraphEditor`/`KeyframeTimeline` (see their module docs) - the caller hands in plain
//! `Track`/`TrackClip` data rebuilt from its own state every frame, `show()` returns
//! `TrackViewEvent`s to apply back, and a live-drag override in `Memory` keeps a move/resize
//! visually smooth without the widget ever getting a `&mut` into the caller's clips directly.
//!
//! This generalizes the clip-lane rendering that already existed, addon-editor-specific, in
//! `core::video_timeline_ui::VideoTimeline` (its `render_clip` closure, built directly
//! against `Editor`/`stunts_state`'s four hardcoded object kinds) - same move/resize/select
//! interaction, rebuilt against plain data plus an added waveform lane so it can host both
//! video and audio clips, driven from the JS addon API the same way `Snarl`/`PianoRoll`
//! already are.
//!
//! ## Arrangement mode
//!
//! `TrackViewOptions` turns the same widget into a DAW-style arrangement view without
//! changing what it is: a musical ruler (bar numbers + beat ticks) when `bar_ms > 0`, bar and
//! beat gridlines with alternating bar shading, a `snap_ms` grid that move/trim/draw all snap
//! to (hold Alt to bypass), a colored header per lane with optional mute/solo pills and the
//! active lane highlighted, drag-on-empty-lane to draw a new clip, a "Duplicate" menu item,
//! and clips that carry a miniature note preview (`TrackClip::notes`) tiled across their loop
//! length. With `TrackViewOptions::default()` none of that is on and the widget behaves as it
//! always did, so the video/keyframe demo is unaffected.
//!
//! ## Known simplifications (documented, not accidental)
//!
//! - A clip's waveform is drawn from caller-supplied peaks (`TrackClip::peaks`, one bar per
//!   sample bucket, 0..1 normalized) - this widget never decodes audio itself. An addon owns
//!   getting from a file to a peaks array.
//! - No thumbnail rendering for video clips (that needs a registered GPU texture per clip,
//!   the same machinery `MiniMap` uses for its landscape preview) - a video clip is a solid
//!   color block with its label, same as any other non-audio clip until that's built.
//! - Clips move only along time. Dragging one to a different lane is not offered: in the DAW
//!   a lane is an instrument, so a clip changing lane would silently change what it sounds
//!   like.
//! - The canvas is exactly as tall as its lanes and never scrolls vertically itself; it is
//!   meant to sit in a scrolling panel. That is why, in arrangement mode, the wheel only zooms
//!   with Ctrl held - a plain wheel is left for the panel.
//! - Hit testing has no occlusion (see `widgets_keyframe_timeline`'s module docs). Which
//!   overlapping widget wins a drag is decided by registration order, so this file registers
//!   the ruler, headers and clips before the empty-lane draw gesture and the background pan.

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::context::Key;
use crate::entropy_gui::geometry::{pos2, vec2, Align2, CursorIcon, FontId, Pos2, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::memory::ClipDragKind;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::shape::Shape;
use crate::entropy_gui::ui::{interact, Ui};

const RULER_H: f32 = 26.0;
const TRACK_H: f32 = 44.0;
const LABEL_W: f32 = 120.0;
const CLIP_PAD_Y: f32 = 5.0;
const EDGE_GRAB: f32 = 6.0;
const MIN_CLIP_MS: i32 = 20;
const MIN_ZOOM: f32 = 0.5; // ms per pixel
const MAX_ZOOM: f32 = 2000.0;

// A dark, slightly blue palette. Everything is derived from these so the widget reads as one
// surface rather than a stack of unrelated rects.
const BG: Color32 = Color32::from_rgb(17, 19, 26);
const LANE_EVEN: Color32 = Color32::from_rgb(22, 25, 33);
const LANE_ODD: Color32 = Color32::from_rgb(26, 29, 38);
const HEADER_BG: Color32 = Color32::from_rgb(29, 32, 42);
const HEADER_HOVER: Color32 = Color32::from_rgb(36, 40, 52);
const HEADER_ACTIVE: Color32 = Color32::from_rgb(40, 45, 62);
const RULER_BG: Color32 = Color32::from_rgb(30, 33, 44);
const TEXT: Color32 = Color32::from_rgb(214, 220, 234);
const TEXT_DIM: Color32 = Color32::from_rgb(112, 120, 142);
const PLAYHEAD: Color32 = Color32::from_rgb(255, 189, 72);

/// One miniature note inside a clip, all three values normalized 0..1 within one loop of the
/// clip's content: `start`/`len` along time, `y` from the top of the preview area.
#[derive(Clone, Copy, Debug)]
pub struct MiniNote {
    pub start: f32,
    pub len: f32,
    pub y: f32,
}

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
    /// Length of one repeat of this clip's content. `0` means the content does not repeat.
    /// When shorter than `duration_ms`, `notes` are tiled and a divider is drawn at each
    /// repeat - the way a looped pattern shows in a DAW arrangement.
    pub loop_ms: i32,
    /// Miniature note preview, tiled every `loop_ms`. Empty for a clip with no such content.
    pub notes: Vec<MiniNote>,
}

impl TrackClip {
    pub fn new(id: impl Into<String>, label: impl Into<String>, start_ms: i32, duration_ms: i32, color: Color32) -> Self {
        Self { id: id.into(), label: label.into(), start_ms, duration_ms, color, peaks: Vec::new(), loop_ms: 0, notes: Vec::new() }
    }
}

#[derive(Clone, Debug)]
pub struct Track {
    /// Unique within the timeline.
    pub id: String,
    pub label: String,
    /// A second, dimmer line under `label` in the header (e.g. an instrument name). Only shown
    /// when the lane is tall enough for two lines.
    pub sublabel: String,
    /// Accent for the header strip. `None` uses a neutral gray.
    pub color: Option<Color32>,
    pub muted: bool,
    pub solo: bool,
    /// Draw mute/solo pills in the header and report their clicks.
    pub controls: bool,
    /// An unused lane the caller is showing so the arrangement always has room: a dimmed
    /// header, no pills. Its clips (if any) still work.
    pub placeholder: bool,
    pub clips: Vec<TrackClip>,
}

impl Track {
    pub fn new(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            sublabel: String::new(),
            color: None,
            muted: false,
            solo: false,
            controls: false,
            placeholder: false,
            clips: Vec::new(),
        }
    }
}

/// Everything beyond the data: grid, snapping, sizing and which optional behaviors are on.
/// `Default` reproduces the original plain clip-timeline.
#[derive(Clone, Debug, Default)]
pub struct TrackViewOptions {
    /// Lane height in px. `0.0` uses the default (44).
    pub lane_h: f32,
    /// Header gutter width in px. `0.0` uses the default (120).
    pub label_w: f32,
    /// Grid that move / trim / draw snap to. `0` disables snapping.
    pub snap_ms: i32,
    /// Length of one bar. `> 0` switches the ruler and gridlines from seconds to bars/beats.
    pub bar_ms: i32,
    /// Length of one beat. Needed alongside `bar_ms` to draw beat ticks.
    pub beat_ms: i32,
    /// Zoom so the whole `duration_ms` fits the first time this view is shown.
    pub fit_on_open: bool,
    /// Only zoom on Ctrl+wheel, leaving a plain wheel for a surrounding scroll panel.
    pub zoom_needs_ctrl: bool,
    /// Dragging on empty lane space draws a new clip (reported as `ClipCreateRequested`).
    pub allow_draw: bool,
    /// Lane to highlight as the active one.
    pub active_track: Option<String>,
    /// Number each lane (1-based) in its header.
    pub lane_numbers: bool,
    /// Shortest clip a trim or draw can produce. `0` uses the default (20ms).
    pub min_clip_ms: i32,
    /// When the playhead leaves the visible span, scroll to bring it back.
    pub follow_playhead: bool,
    /// Width to leave free on the right, e.g. for a surrounding scroll panel's scrollbar.
    pub right_gutter: f32,
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
    /// "Duplicate" was chosen from a clip's menu.
    ClipDuplicateRequested { track: String, clip: String },
    /// A drag on empty lane space finished (`TrackViewOptions::allow_draw`), already snapped.
    ClipCreateRequested { track: String, start_ms: i32, duration_ms: i32 },
    /// A track's label gutter, or empty space in its lane, was clicked.
    TrackClicked(String),
    TrackMuteToggled(String),
    TrackSoloToggled(String),
    /// Empty canvas (not a clip, header or the ruler) was clicked - the conventional
    /// "deselect" signal.
    BackgroundClicked,
}

pub struct TrackViewResponse {
    pub canvas_rect: Rect,
    pub events: Vec<TrackViewEvent>,
    pub zoom: f32,
}

pub struct TrackView {
    id: Id,
    options: TrackViewOptions,
}

fn with_alpha(c: Color32, a: u8) -> Color32 {
    Color32([c.0[0], c.0[1], c.0[2], a])
}

fn snap_to(t: i32, snap_ms: i32) -> i32 {
    if snap_ms > 0 {
        ((t as f32 / snap_ms as f32).round() as i32) * snap_ms
    } else {
        t
    }
}

impl TrackView {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("track_view").with(id_salt), options: TrackViewOptions::default() }
    }

    pub fn options(mut self, options: TrackViewOptions) -> Self {
        self.options = options;
        self
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
        let opts = self.options;
        let lane_h = if opts.lane_h > 0.0 { opts.lane_h } else { TRACK_H };
        let label_w = if opts.label_w > 0.0 { opts.label_w } else { LABEL_W };
        let min_clip = if opts.min_clip_ms > 0 { opts.min_clip_ms } else { MIN_CLIP_MS };
        let musical = opts.bar_ms > 0;

        let had_view = ctx.memory(|m| m.has_timeline_view(view_id));
        let (mut scroll_x, mut zoom) = ctx.memory(|m| m.get_timeline_view(view_id));

        let height = RULER_H + tracks.len().max(1) as f32 * lane_h;
        // Leave a strip on the right so the canvas does not run under a surrounding scrollbar.
        let size = vec2((ui.available_size().x - opts.right_gutter).max(200.0), height.max(80.0));
        let (bg_response, painter) = ui.allocate_painter(size, Sense::click());
        let canvas_rect = bg_response.rect;
        let label_col = Rect::from_min_max(canvas_rect.min, pos2(canvas_rect.min.x + label_w, canvas_rect.max.y));
        let grid_rect = Rect::from_min_max(pos2(canvas_rect.min.x + label_w, canvas_rect.min.y), canvas_rect.max);
        let lanes_top = grid_rect.min.y + RULER_H;

        // A tempo change changes how many milliseconds a bar lasts. Keeping zoom in ms/px would make
        // the song grow or shrink on screen; rescaling it with the bar keeps pixels-per-bar fixed
        // (the horizontal offset is in px, so it stays put too).
        let bar_key = view_id.with("bar_ms");
        if musical {
            let prev = ctx.memory(|m| m.get_scalar(bar_key));
            if let Some(prev) = prev {
                if prev > 0.0 && (prev - opts.bar_ms as f32).abs() > 0.5 {
                    zoom = (zoom * opts.bar_ms as f32 / prev).clamp(MIN_ZOOM, MAX_ZOOM);
                }
            }
            ctx.memory_mut(|m| m.set_scalar(bar_key, opts.bar_ms as f32));
        }

        if opts.fit_on_open && !had_view && duration_ms > 0 {
            zoom = (duration_ms as f32 / grid_rect.width().max(1.0)).clamp(MIN_ZOOM, MAX_ZOOM);
            scroll_x = 0.0;
        }

        let (pointer_pos, mods, scroll_delta) = ui.input(|i| (i.pointer.pos, i.modifiers, i.scroll_delta));
        let over_canvas = pointer_pos.map_or(false, |p| canvas_rect.contains(p));

        if over_canvas {
            let wants_zoom = !opts.zoom_needs_ctrl || mods.ctrl;
            if scroll_delta.y.abs() > 0.0 && wants_zoom {
                if let Some(cursor) = pointer_pos {
                    let time_at_cursor = (cursor.x - grid_rect.min.x - scroll_x) * zoom;
                    let factor = (1.0 + scroll_delta.y * 0.0015).clamp(0.5, 1.6);
                    zoom = (zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
                    scroll_x = cursor.x - grid_rect.min.x - time_at_cursor / zoom;
                }
            } else if scroll_delta.y.abs() > 0.0 && mods.shift {
                scroll_x += scroll_delta.y;
            }
            if scroll_delta.x.abs() > 0.0 {
                scroll_x += scroll_delta.x;
            }
        }

        // Keep the timeline from being panned into empty space on either side.
        if duration_ms > 0 {
            let content_w = duration_ms as f32 / zoom;
            let min_scroll = (grid_rect.width() - content_w).min(0.0);
            scroll_x = scroll_x.clamp(min_scroll, 0.0);
        }

        if opts.follow_playhead && !ctx.memory(|m| m.active_drag.is_some()) {
            let x = grid_rect.min.x + scroll_x + playhead_ms as f32 / zoom;
            if x > grid_rect.max.x - 12.0 || x < grid_rect.min.x {
                scroll_x = -(playhead_ms as f32 / zoom) + 24.0;
                if duration_ms > 0 {
                    let min_scroll = (grid_rect.width() - duration_ms as f32 / zoom).min(0.0);
                    scroll_x = scroll_x.clamp(min_scroll, 0.0);
                }
            }
        }

        let time_to_x = |t: i32| grid_rect.min.x + scroll_x + t as f32 / zoom;
        let x_to_time = |x: f32| ((x - grid_rect.min.x - scroll_x) * zoom) as i32;

        painter.rect_filled(canvas_rect, 6.0_f32, BG);
        let gp = painter.with_clip_rect(grid_rect);

        let mut events = Vec::new();
        let mut clip_rects: Vec<Rect> = Vec::new();

        // ---- lane backgrounds (below everything else in the grid) ----
        for (i, track) in tracks.iter().enumerate() {
            let y0 = lanes_top + i as f32 * lane_h;
            let lane_rect = Rect::from_min_size(pos2(grid_rect.min.x, y0), vec2(grid_rect.width(), lane_h));
            let mut bg = if i % 2 == 1 { LANE_ODD } else { LANE_EVEN };
            if opts.active_track.as_deref() == Some(track.id.as_str()) {
                bg = bg.lerp(track.color.unwrap_or(PLAYHEAD), 0.10);
            }
            gp.rect_filled(lane_rect, 0.0_f32, bg);
        }
        let lanes_bottom = lanes_top + tracks.len().max(1) as f32 * lane_h;
        let lanes_area = Rect::from_min_max(pos2(grid_rect.min.x, lanes_top), pos2(grid_rect.max.x, lanes_bottom));

        // ---- gridlines: alternating bar shading, bar lines, beat lines, snap lines ----
        let ruler_rect = Rect::from_min_max(grid_rect.min, pos2(grid_rect.max.x, lanes_top));
        gp.rect_filled(ruler_rect, 0.0_f32, RULER_BG);

        let first_t = x_to_time(grid_rect.min.x).max(0);
        let last_t = x_to_time(grid_rect.max.x).min(duration_ms.max(0));
        if musical {
            let bar_ms = opts.bar_ms;
            let bar_px = bar_ms as f32 / zoom;
            let beat_ms = if opts.beat_ms > 0 { opts.beat_ms } else { bar_ms };
            let beat_px = beat_ms as f32 / zoom;
            let snap_px = if opts.snap_ms > 0 { opts.snap_ms as f32 / zoom } else { 0.0 };
            // Number every Nth bar so labels never collide however far out the user zooms.
            let mut label_every = 1;
            while (bar_px * label_every as f32) < 34.0 && label_every < 1024 {
                label_every *= 2;
            }
            let first_bar = first_t / bar_ms;
            let last_bar = last_t / bar_ms + 1;
            for b in first_bar..=last_bar {
                let t = b * bar_ms;
                let x = time_to_x(t);
                let x_next = time_to_x(t + bar_ms);
                if b % 2 == 1 {
                    let shade = Rect::from_min_max(pos2(x.max(grid_rect.min.x), lanes_top), pos2(x_next.min(grid_rect.max.x), lanes_bottom));
                    if shade.is_positive() {
                        gp.rect_filled(shade, 0.0_f32, Color32::from_white_alpha(5));
                    }
                }
                // Finer lines first so the bar line lands on top of them.
                if beat_ms < bar_ms && beat_px >= 9.0 {
                    let beats = (bar_ms / beat_ms).max(1);
                    for k in 1..beats {
                        let bx = time_to_x(t + k * beat_ms);
                        gp.line_segment([pos2(bx, lanes_top), pos2(bx, lanes_bottom)], Stroke::new(1.0, Color32::from_white_alpha(14)));
                        gp.line_segment([pos2(bx, ruler_rect.max.y - 5.0), pos2(bx, ruler_rect.max.y)], Stroke::new(1.0, Color32::from_white_alpha(70)));
                    }
                }
                if opts.snap_ms > 0 && opts.snap_ms < beat_ms && snap_px >= 10.0 {
                    let subs = (bar_ms / opts.snap_ms).max(1);
                    for k in 1..subs {
                        let tt = k * opts.snap_ms;
                        if beat_ms > 0 && tt % beat_ms == 0 {
                            continue;
                        }
                        let sx = time_to_x(t + tt);
                        gp.line_segment([pos2(sx, lanes_top), pos2(sx, lanes_bottom)], Stroke::new(1.0, Color32::from_white_alpha(7)));
                    }
                }
                gp.line_segment([pos2(x, lanes_top), pos2(x, lanes_bottom)], Stroke::new(1.0, Color32::from_white_alpha(44)));
                gp.line_segment([pos2(x, ruler_rect.min.y + 4.0), pos2(x, ruler_rect.max.y)], Stroke::new(1.0, Color32::from_white_alpha(110)));
                if b % label_every == 0 && t <= duration_ms {
                    // Whole pixels: a label at a fractional x rasterizes its glyphs at a sub-pixel offset
                    // and two-digit numbers came out doubled.
                    gp.text(pos2((x + 4.0).round(), (ruler_rect.min.y + 3.0).round()), Align2::LEFT_TOP, format!("{}", b + 1), FontId::monospace(10.0), TEXT);
                }
            }
        } else {
            let tick_ms = if zoom < 10.0 { 100 } else if zoom < 50.0 { 500 } else { 1000 };
            let mut t = 0;
            while t <= duration_ms {
                let x = time_to_x(t);
                if x >= grid_rect.min.x && x <= grid_rect.max.x {
                    let is_major = t % 1000 == 0;
                    let h = if is_major { 12.0 } else { 6.0 };
                    gp.line_segment([pos2(x, ruler_rect.max.y - h), pos2(x, ruler_rect.max.y)], Stroke::new(1.0, Color32::from_gray(140)));
                    if is_major {
                        gp.text(pos2(x + 2.0, ruler_rect.min.y + 2.0), Align2::LEFT_TOP, format!("{}s", t / 1000), FontId::monospace(10.0), Color32::from_gray(200));
                    }
                }
                t += tick_ms;
            }
        }

        // Past the end of the arrangement: dimmed, so it reads as "outside the song".
        if duration_ms > 0 {
            let end_x = time_to_x(duration_ms);
            if end_x < grid_rect.max.x {
                let beyond = Rect::from_min_max(pos2(end_x.max(grid_rect.min.x), grid_rect.min.y), grid_rect.max);
                if beyond.is_positive() {
                    gp.rect_filled(beyond, 0.0_f32, Color32::from_black_alpha(110));
                    gp.line_segment([pos2(end_x, grid_rect.min.y), pos2(end_x, lanes_bottom)], Stroke::new(1.0, Color32::from_white_alpha(90)));
                }
            }
        }

        // ---- ruler: click / drag to seek. Registered first so it wins any drag it starts. ----
        let ruler_resp = interact(&ctx, ruler_rect, view_id.with("ruler"), Sense::click_and_drag());
        if ruler_resp.clicked() || ruler_resp.dragged() {
            if let Some(p) = ruler_resp.interact_pointer_pos() {
                events.push(TrackViewEvent::Seek(x_to_time(p.x).clamp(0, duration_ms.max(0))));
            }
        }

        // Whether a press landed on something that is not "the background": the ruler, a header, or
        // a clip. An empty stretch of lane is still background - it selects the lane *and* clears
        // the selection, so a caller gets both `TrackClicked` and `BackgroundClicked`.
        let mut press_taken = false;
        let pressed_now = ui.input(|i| i.pointer.primary_pressed);
        let press_pos = if pressed_now { pointer_pos } else { None };
        if let Some(p) = press_pos {
            if ruler_rect.contains(p) || label_col.contains(p) {
                press_taken = true;
            }
        }

        // ---- headers (label gutter): registered before clips, they never overlap them ----
        for (i, track) in tracks.iter().enumerate() {
            let y0 = lanes_top + i as f32 * lane_h;
            let label_rect = Rect::from_min_size(pos2(label_col.min.x, y0), vec2(label_w, lane_h));
            let is_active = opts.active_track.as_deref() == Some(track.id.as_str());
            let label_id = view_id.with(("track_label", &track.id));
            let label_resp = interact(&ctx, label_rect, label_id, Sense::click());
            let hovered = label_resp.hovered();

            let mut mute_rect = None;
            let mut solo_rect = None;
            if track.controls && !track.placeholder {
                let pill_w = 20.0;
                let pill_h = (lane_h * 0.5).clamp(14.0, 18.0);
                let cy = label_rect.center().y;
                let sr = Rect::from_center_size(pos2(label_rect.max.x - 8.0 - pill_w * 0.5, cy), vec2(pill_w, pill_h));
                let mr = Rect::from_center_size(pos2(sr.min.x - 4.0 - pill_w * 0.5, cy), vec2(pill_w, pill_h));
                solo_rect = Some(sr);
                mute_rect = Some(mr);
            }
            let mut on_pill = false;
            if let Some(mr) = mute_rect {
                let r = interact(&ctx, mr, view_id.with(("track_mute", &track.id)), Sense::click());
                on_pill |= r.hovered();
                if r.clicked() {
                    events.push(TrackViewEvent::TrackMuteToggled(track.id.clone()));
                }
            }
            if let Some(sr) = solo_rect {
                let r = interact(&ctx, sr, view_id.with(("track_solo", &track.id)), Sense::click());
                on_pill |= r.hovered();
                if r.clicked() {
                    events.push(TrackViewEvent::TrackSoloToggled(track.id.clone()));
                }
            }
            if label_resp.clicked() && !on_pill {
                events.push(TrackViewEvent::TrackClicked(track.id.clone()));
            }

            let fill = if is_active { HEADER_ACTIVE } else if hovered { HEADER_HOVER } else { HEADER_BG };
            painter.rect_filled(label_rect, 0.0_f32, fill);
            // Lane divider across header and lane, drawn in the gutter's own painter here and in
            // the grid's below.
            painter.line_segment([pos2(label_rect.min.x, y0 + lane_h), pos2(label_rect.max.x, y0 + lane_h)], Stroke::new(1.0, Color32::from_black_alpha(90)));

            let accent = track.color.unwrap_or(Color32::from_gray(90));
            let strip_alpha = if track.placeholder { 40 } else if track.muted { 110 } else { 255 };
            painter.rect_filled(Rect::from_min_size(label_rect.min, vec2(4.0, lane_h)), 0.0_f32, with_alpha(accent, strip_alpha));

            let mut text_x = label_rect.min.x + 12.0;
            if opts.lane_numbers {
                painter.text(pos2(text_x, label_rect.center().y), Align2::LEFT_CENTER, format!("{:02}", i + 1), FontId::monospace(9.0), TEXT_DIM);
                text_x += 20.0;
            }
            let name_color = if track.placeholder { TEXT_DIM } else if track.muted { TEXT_DIM } else { TEXT };
            let text_painter = painter.with_clip_rect(Rect::from_min_max(
                pos2(label_rect.min.x, label_rect.min.y),
                pos2(mute_rect.map_or(label_rect.max.x - 4.0, |r| r.min.x - 4.0), label_rect.max.y),
            ));
            let two_line = lane_h >= 30.0 && !track.sublabel.is_empty();
            if two_line {
                text_painter.text(pos2(text_x, label_rect.center().y - 6.0), Align2::LEFT_CENTER, &track.label, FontId::proportional(11.5), name_color);
                text_painter.text(pos2(text_x, label_rect.center().y + 7.0), Align2::LEFT_CENTER, &track.sublabel, FontId::proportional(9.5), TEXT_DIM);
            } else {
                text_painter.text(pos2(text_x, label_rect.center().y), Align2::LEFT_CENTER, &track.label, FontId::proportional(11.5), name_color);
            }

            for (rect, letter, on, on_color) in [
                (mute_rect, "M", track.muted, Color32::from_rgb(232, 150, 60)),
                (solo_rect, "S", track.solo, Color32::from_rgb(90, 160, 240)),
            ] {
                if let Some(rect) = rect {
                    let pill_hover = pointer_pos.map_or(false, |p| rect.contains(p));
                    let pill_fill = if on { on_color } else if pill_hover { Color32::from_white_alpha(34) } else { Color32::from_white_alpha(16) };
                    painter.rect_filled(rect, 4.0_f32, pill_fill);
                    painter.text(rect.center(), Align2::CENTER_CENTER, letter, FontId::proportional(10.0), if on { Color32::from_rgb(20, 22, 30) } else { TEXT_DIM });
                }
            }
        }

        // ---- lanes: clips first, then the empty-space draw gesture ----
        let mut lane_draw_events: Vec<TrackViewEvent> = Vec::new();
        for (i, track) in tracks.iter().enumerate() {
            let y0 = lanes_top + i as f32 * lane_h;
            let lane_rect = Rect::from_min_size(pos2(grid_rect.min.x, y0), vec2(grid_rect.width(), lane_h));
            gp.line_segment([pos2(lane_rect.min.x, y0 + lane_h), pos2(lane_rect.max.x, y0 + lane_h)], Stroke::new(1.0, Color32::from_black_alpha(80)));
            let accent = track.color.unwrap_or(Color32::from_gray(90));
            let pad = if lane_h >= 30.0 { 3.5 } else { CLIP_PAD_Y };
            let lane_clip_start = clip_rects.len();

            for clip in &track.clips {
                let clip_id = view_id.with(("clip", &clip.id));
                let live = ctx.memory(|m| m.clip_drag.clone()).filter(|(id, _, _, _)| *id == clip_id);
                let (eff_start, eff_dur) = live.map(|(_, _, s, d)| (s, d)).unwrap_or((clip.start_ms, clip.duration_ms));

                let x0 = time_to_x(eff_start);
                let w = (eff_dur as f32 / zoom).max(4.0);
                let clip_rect = Rect::from_min_size(pos2(x0, y0 + pad), vec2(w, lane_h - pad * 2.0));
                // Only the part inside the grid is interactive, so a clip scrolled under the
                // header never steals the header's clicks.
                let hit_rect = clip_rect.intersect(lane_rect).intersect(grid_rect);
                clip_rects.push(hit_rect);
                if !hit_rect.is_positive() && !ctx.memory(|m| m.clip_drag.as_ref().map_or(false, |(id, ..)| *id == clip_id)) {
                    continue;
                }

                let resp = interact(&ctx, hit_rect, clip_id, Sense::click_and_drag());
                let hover_pos = pointer_pos;
                let on_left_edge = resp.hovered() && hover_pos.map_or(false, |p| p.x < clip_rect.min.x + EDGE_GRAB);
                let on_right_edge = resp.hovered() && hover_pos.map_or(false, |p| p.x > clip_rect.max.x - EDGE_GRAB);
                if on_left_edge || on_right_edge {
                    ui.output_mut(|o| o.cursor_icon = CursorIcon::ResizeHorizontal);
                }
                if resp.hovered() || resp.dragged() {
                    press_taken |= pressed_now;
                }

                if resp.drag_started() {
                    let kind = if on_left_edge {
                        ClipDragKind::ResizeLeft
                    } else if on_right_edge {
                        ClipDragKind::ResizeRight
                    } else {
                        ClipDragKind::Move
                    };
                    let origin_x = resp.interact_pointer_pos().map_or(0.0, |p| p.x);
                    ctx.memory_mut(|m| {
                        m.clip_drag = Some((clip_id, kind, clip.start_ms, clip.duration_ms));
                        m.clip_drag_origin = Some((clip_id, origin_x, clip.start_ms, clip.duration_ms));
                    });
                    events.push(TrackViewEvent::ClipSelected { track: track.id.clone(), clip: clip.id.clone() });
                } else if resp.dragged() {
                    let kind = ctx.memory(|m| m.clip_drag.clone()).filter(|(id, _, _, _)| *id == clip_id).map(|(_, k, _, _)| k);
                    let origin = ctx.memory(|m| m.clip_drag_origin.clone()).filter(|(id, _, _, _)| *id == clip_id);
                    if let (Some(kind), Some((_, origin_x, start0, dur0)), Some(p)) = (kind, origin, pointer_pos) {
                        let dt = ((p.x - origin_x) * zoom).round() as i32;
                        // Alt bypasses the grid for a free, unsnapped placement.
                        let snap = if mods.alt { 0 } else { opts.snap_ms };
                        let end_cap = if duration_ms > 0 { duration_ms } else { i32::MAX };
                        let (new_start, new_dur) = match kind {
                            ClipDragKind::Move => {
                                let s = snap_to(start0 + dt, snap).clamp(0, (end_cap - dur0).max(0));
                                (s, dur0)
                            }
                            ClipDragKind::ResizeLeft => {
                                let end = start0 + dur0;
                                let s = snap_to(start0 + dt, snap).clamp(0, end - min_clip);
                                (s, end - s)
                            }
                            ClipDragKind::ResizeRight => {
                                let end = snap_to(start0 + dur0 + dt, snap).clamp(start0 + min_clip, end_cap.max(start0 + min_clip));
                                (start0, end - start0)
                            }
                        };
                        ctx.memory_mut(|m| m.clip_drag = Some((clip_id, kind, new_start, new_dur)));
                        if matches!(kind, ClipDragKind::Move) {
                            events.push(TrackViewEvent::ClipMoved { track: track.id.clone(), clip: clip.id.clone(), start_ms: new_start });
                        } else {
                            events.push(TrackViewEvent::ClipResized { track: track.id.clone(), clip: clip.id.clone(), start_ms: new_start, duration_ms: new_dur });
                        }
                    }
                }
                if resp.drag_stopped() {
                    ctx.memory_mut(|m| {
                        m.clip_drag = None;
                        m.clip_drag_origin = None;
                    });
                }

                let is_selected = selected == Some((track.id.as_str(), clip.id.as_str()));
                draw_clip(&gp, clip_rect, clip, zoom, is_selected, resp.hovered() || resp.dragged(), track.muted);

                let mut delete_request = false;
                let mut duplicate_request = false;
                resp.context_menu(|menu_ui| {
                    if menu_ui.button("Duplicate").clicked() {
                        duplicate_request = true;
                        menu_ui.close_menu();
                    }
                    if menu_ui.button("Delete Clip").clicked() {
                        delete_request = true;
                        menu_ui.close_menu();
                    }
                });
                if duplicate_request {
                    events.push(TrackViewEvent::ClipDuplicateRequested { track: track.id.clone(), clip: clip.id.clone() });
                }
                if delete_request {
                    events.push(TrackViewEvent::ClipDeleteRequested { track: track.id.clone(), clip: clip.id.clone() });
                }
            }

            // Empty-space gesture. Registered after this lane's clips, so a press that landed
            // on a clip has already been claimed by it and this only ever sees empty space.
            if opts.allow_draw && !mods.alt {
                let draw_id = view_id.with(("lane_draw", &track.id));
                let resp = interact(&ctx, lane_rect.intersect(grid_rect), draw_id, Sense::click_and_drag());
                let on_clip = |p: Pos2| clip_rects[lane_clip_start..].iter().any(|r| r.contains(p));
                let snap = if mods.alt { 0 } else { opts.snap_ms };
                if resp.drag_started() {
                    if let Some(p) = resp.interact_pointer_pos() {
                        if !on_clip(p) {
                            let anchor = snap_to(x_to_time(p.x), snap).max(0);
                            ctx.memory_mut(|m| m.lane_draw = Some((draw_id, anchor, anchor)));
                            events.push(TrackViewEvent::TrackClicked(track.id.clone()));
                        }
                    }
                } else if resp.dragged() {
                    if let (Some(p), true) = (pointer_pos, ctx.memory(|m| m.lane_draw.map_or(false, |(id, ..)| id == draw_id))) {
                        let cur = snap_to(x_to_time(p.x), snap).clamp(0, if duration_ms > 0 { duration_ms } else { i32::MAX });
                        ctx.memory_mut(|m| {
                            if let Some((id, anchor, _)) = m.lane_draw {
                                m.lane_draw = Some((id, anchor, cur));
                            }
                        });
                    }
                }
                if resp.drag_stopped() {
                    let finished = ctx.memory_mut(|m| m.lane_draw.take());
                    if let Some((id, a, b)) = finished {
                        if id == draw_id {
                            let start = a.min(b);
                            let dur = (a - b).abs();
                            // A press with no travel is a plain click on the lane, not a clip.
                            if dur >= min_clip {
                                lane_draw_events.push(TrackViewEvent::ClipCreateRequested { track: track.id.clone(), start_ms: start, duration_ms: dur });
                            }
                        }
                    }
                } else if resp.clicked() && !resp.dragged() {
                    if let Some(p) = resp.interact_pointer_pos() {
                        if !on_clip(p) {
                            events.push(TrackViewEvent::TrackClicked(track.id.clone()));
                        }
                    }
                }

                // Ghost of the clip being drawn.
                if let Some((id, a, b)) = ctx.memory(|m| m.lane_draw) {
                    if id == draw_id {
                        let (s, e) = (a.min(b), a.max(b));
                        let ghost = Rect::from_min_max(pos2(time_to_x(s), y0 + pad), pos2(time_to_x(e).max(time_to_x(s) + 2.0), y0 + lane_h - pad));
                        gp.rect_filled(ghost, 4.0_f32, with_alpha(accent, 70));
                        gp.rect_stroke(ghost, 4.0_f32, Stroke::new(1.5, with_alpha(accent.lerp(Color32::WHITE, 0.4), 230)), StrokeKind::Middle);
                    }
                }
            } else if !opts.allow_draw {
                // No draw gesture: still let an empty click select the lane.
                let resp = interact(&ctx, lane_rect.intersect(grid_rect), view_id.with(("lane_click", &track.id)), Sense::click());
                if resp.clicked() {
                    if let Some(p) = resp.interact_pointer_pos() {
                        if !clip_rects[lane_clip_start..].iter().any(|r| r.contains(p)) {
                            events.push(TrackViewEvent::TrackClicked(track.id.clone()));
                        }
                    }
                }
            }
        }
        events.extend(lane_draw_events);

        // ---- playhead: a soft halo, the line, and a head on the ruler ----
        let ph_x = time_to_x(playhead_ms);
        if ph_x >= grid_rect.min.x && ph_x <= grid_rect.max.x {
            gp.line_segment([pos2(ph_x, ruler_rect.max.y), pos2(ph_x, lanes_bottom)], Stroke::new(5.0, with_alpha(PLAYHEAD, 34)));
            gp.line_segment([pos2(ph_x, grid_rect.min.y + 2.0), pos2(ph_x, lanes_bottom)], Stroke::new(1.5, PLAYHEAD));
            gp.add(Shape::convex_polygon(
                vec![pos2(ph_x - 5.5, ruler_rect.max.y - 9.0), pos2(ph_x + 5.5, ruler_rect.max.y - 9.0), pos2(ph_x, ruler_rect.max.y - 1.0)],
                PLAYHEAD,
                Stroke::NONE,
            ));
        }

        painter.rect_stroke(canvas_rect, 6.0_f32, Stroke::new(1.0, Color32::from_white_alpha(28)), StrokeKind::Middle);

        // ---- background: pan (Alt+drag, or plain drag when clips can't be drawn) ----
        let bg_drag_resp = interact(&ctx, grid_rect, view_id.with("bg_pan"), Sense::drag());
        if bg_drag_resp.dragged() {
            scroll_x += bg_drag_resp.drag_delta().x;
        }
        if bg_response.clicked() && !press_taken {
            if let Some(p) = pointer_pos {
                if lanes_area.contains(p) || (!ruler_rect.contains(p) && !label_col.contains(p)) {
                    events.push(TrackViewEvent::BackgroundClicked);
                }
            }
        }

        // Delete only while the pointer is over the canvas: the caller may have a text field
        // (a BPM box, say) elsewhere in the same window, and Backspace there must not eat a clip.
        if let Some((track_id, clip_id)) = selected {
            let delete_pressed = ui.input(|i| i.key_events.iter().any(|k| k.pressed && matches!(k.key, Key::Delete | Key::Backspace)));
            if delete_pressed && over_canvas {
                events.push(TrackViewEvent::ClipDeleteRequested { track: track_id.to_string(), clip: clip_id.to_string() });
            }
        }

        ctx.memory_mut(|m| m.set_timeline_view(view_id, scroll_x, zoom));

        TrackViewResponse { canvas_rect, events, zoom }
    }
}

/// One clip: rounded body, a title strip, then the content preview (waveform peaks and/or
/// tiled mini notes) with loop dividers, all inside the clip's own clip-rect.
fn draw_clip(gp: &crate::entropy_gui::painter::Painter, rect: Rect, clip: &TrackClip, zoom: f32, selected: bool, hot: bool, muted: bool) {
    let mut base = clip.color;
    if muted {
        // Desaturate toward gray so a muted lane's clips visibly step back.
        base = base.lerp(Color32::from_gray(96), 0.65);
    }
    let body = Color32::from_rgb(20, 23, 31).lerp(base, 0.30);
    let title = base.lerp(Color32::BLACK, 0.18).lerp(Color32::WHITE, if selected || hot { 0.14 } else { 0.0 });
    let notes_col = base.lerp(Color32::WHITE, 0.72);
    let border = if selected { Color32::WHITE } else { base.lerp(Color32::WHITE, if hot { 0.45 } else { 0.22 }) };

    gp.rect_filled(rect, 4.0_f32, body);

    let has_title = rect.height() >= 22.0;
    let title_h = if has_title { 12.0 } else { 0.0 };
    let clip_painter = gp.with_clip_rect(rect.shrink(0.5));

    if has_title {
        let strip = Rect::from_min_size(rect.min + vec2(1.0, 1.0), vec2((rect.width() - 2.0).max(0.0), title_h));
        clip_painter.rect_filled(strip, 3.0_f32, title);
    }

    let content = Rect::from_min_max(pos2(rect.min.x, rect.min.y + title_h + 1.5), pos2(rect.max.x, rect.max.y - 2.0));

    // Waveform (audio) lane content.
    if !clip.peaks.is_empty() && content.height() > 2.0 {
        let bars = clip.peaks.len();
        let bar_w = (rect.width() / bars as f32).max(1.0);
        let mid_y = content.center().y;
        for (bi, amp) in clip.peaks.iter().enumerate() {
            let amp = amp.clamp(0.0, 1.0);
            let bar_h = (content.height() * 0.95 * amp).max(1.0);
            let bx = rect.min.x + bi as f32 * bar_w;
            if bx > rect.max.x {
                break;
            }
            clip_painter.line_segment(
                [pos2(bx + bar_w * 0.5, mid_y - bar_h * 0.5), pos2(bx + bar_w * 0.5, mid_y + bar_h * 0.5)],
                Stroke::new(bar_w.min(2.0), with_alpha(notes_col, 190)),
            );
        }
    }

    // Loop content: tiled mini notes with a divider at each repeat.
    if !clip.notes.is_empty() && content.height() > 3.0 {
        let loop_ms = if clip.loop_ms > 0 { clip.loop_ms } else { clip.duration_ms.max(1) };
        let loop_px = loop_ms as f32 / zoom;
        let reps = ((clip.duration_ms as f32 / loop_ms as f32).ceil() as i32).max(1);
        let note_h = (content.height() / 6.0).clamp(2.0, 4.0);
        let usable_h = (content.height() - note_h).max(1.0);
        for rep in 0..reps {
            let rep_x = rect.min.x + rep as f32 * loop_px;
            if rep_x > rect.max.x {
                break;
            }
            if rep > 0 {
                clip_painter.line_segment([pos2(rep_x, content.min.y - 1.0), pos2(rep_x, rect.max.y - 1.5)], Stroke::new(1.0, with_alpha(base.lerp(Color32::WHITE, 0.5), 90)));
            }
            for n in &clip.notes {
                let nx = rep_x + n.start * loop_px;
                if nx > rect.max.x {
                    continue;
                }
                let nw = (n.len * loop_px).max(1.5);
                let ny = content.min.y + n.y.clamp(0.0, 1.0) * usable_h;
                let nr = Rect::from_min_size(pos2(nx, ny), vec2(nw.min(rect.max.x - nx), note_h));
                if nr.is_positive() {
                    clip_painter.rect_filled(nr, 0.5_f32, with_alpha(notes_col, if muted { 120 } else { 235 }));
                }
            }
        }
    }

    if has_title {
        let title_painter = gp.with_clip_rect(Rect::from_min_size(rect.min, vec2(rect.width(), title_h + 1.0)).shrink2(vec2(3.0, 0.0)));
        title_painter.text(pos2(rect.min.x + 5.0, rect.min.y + 1.0 + title_h * 0.5), Align2::LEFT_CENTER, &clip.label, FontId::proportional(10.0), Color32::from_white_alpha(if muted { 150 } else { 245 }));
    } else {
        let p = gp.with_clip_rect(rect);
        p.text(rect.min + vec2(4.0, 2.0), Align2::LEFT_TOP, &clip.label, FontId::proportional(10.0), Color32::WHITE);
    }

    gp.rect_stroke(rect, 4.0_f32, Stroke::new(if selected { 2.0 } else { 1.0 }, border), StrokeKind::Middle);
}
