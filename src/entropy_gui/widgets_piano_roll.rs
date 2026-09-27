//! `PianoRoll` - the step grid the DAW paints patterns into: a key column of row labels, a ruler
//! numbered in bars and beats, notes as rounded blocks shaded by velocity, an optional velocity
//! lane underneath, a hover preview of where a click would paint, and a playhead.
//!
//! Same caller-owns-the-data shape as `TrackView`: the caller hands in the cells every frame and
//! gets back raw press / drag / release cell coordinates (`PianoRollEvent`), and decides itself
//! whether a press adds or erases - the widget never edits a pattern.
//!
//! Sizing: by default rows are `DEFAULT_ROW_H` tall and the grid is as tall as its rows.
//! `row_h` fixes the row height; `fill_height` stretches rows to fill the height left in the
//! `Ui` (clamped to a readable range). When the rows need more height than there is, the grid
//! scrolls vertically under the plain mouse wheel; the ruler and velocity lane stay put.

use std::collections::HashMap;

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::shape::Shape;
use crate::entropy_gui::ui::Ui;

pub const DEFAULT_ROW_H: f32 = 16.0;
const LABEL_W: f32 = 56.0;
const RULER_H: f32 = 22.0;
const VELOCITY_H: f32 = 64.0;
const MIN_FILL_ROW_H: f32 = 18.0;
const MAX_FILL_ROW_H: f32 = 56.0;
const POP_SECONDS: f32 = 0.22;

const BG: Color32 = Color32::from_rgb(14, 17, 23);
const ROW_A: Color32 = Color32::from_rgb(16, 19, 26);
const ROW_B: Color32 = Color32::from_rgb(14, 17, 23);
const KEY_BG: Color32 = Color32::from_rgb(20, 23, 34);
const KEY_DARK: Color32 = Color32::from_rgb(38, 43, 56);
const RULER_BG: Color32 = Color32::from_rgb(20, 23, 34);
const LINE_STEP: Color32 = Color32::from_rgb(25, 29, 39);
const LINE_BEAT: Color32 = Color32::from_rgb(37, 42, 55);
const LINE_BAR: Color32 = Color32::from_rgb(58, 66, 88);
const TEXT: Color32 = Color32::from_rgb(196, 202, 218);
const TEXT_DIM: Color32 = Color32::from_rgb(112, 120, 142);
const PLAYHEAD: Color32 = Color32::from_rgb(255, 189, 72);

#[derive(Clone, Copy, Debug)]
pub struct PianoRollNote {
    /// Display row, 0 at the top.
    pub row: usize,
    pub step: usize,
    pub length: usize,
    pub velocity: f32,
}

#[derive(Clone, Debug)]
pub struct PianoRollStyle {
    /// Fixed row height; 0 means `DEFAULT_ROW_H`, or fill when `fill_height` is set.
    pub row_h: f32,
    pub fill_height: bool,
    pub note_color: Color32,
    /// Display rows to tint (a scale's root notes), so octaves are easy to find.
    pub highlight_rows: Vec<usize>,
    pub show_velocity: bool,
}

impl Default for PianoRollStyle {
    fn default() -> Self {
        Self { row_h: 0.0, fill_height: false, note_color: Color32::from_rgb(90, 170, 255), highlight_rows: Vec::new(), show_velocity: false }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PianoRollEvent {
    Down { row: usize, step: usize },
    Drag { row: usize, step: usize },
    Up { row: usize, step: usize },
}

pub struct PianoRoll {
    id: Id,
}

#[derive(Default)]
struct RollState {
    scroll_y: f32,
    /// When each note (by row, step) first appeared, for the pop-in.
    born: HashMap<(usize, usize), f32>,
    initialized: bool,
}

fn with_alpha(c: Color32, a: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), a)
}

impl PianoRoll {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("piano_roll").with(id_salt) }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn show(
        self,
        ui: &mut Ui,
        rows: usize,
        steps: usize,
        steps_per_beat: usize,
        labels: Option<&[String]>,
        notes: &[PianoRollNote],
        playhead: f32,
        style: &PianoRollStyle,
    ) -> Vec<PianoRollEvent> {
        let rows = rows.max(1);
        let steps = steps.max(1);
        let steps_per_beat = steps_per_beat.max(1);
        let steps_per_bar = steps_per_beat * 4;
        let ctx = ui.ctx().clone();
        let now = ctx.time();
        let state_id = self.id.with("state");
        let mut st: RollState = ctx.memory_mut(|m| m.take_view_state(state_id));

        let avail = ui.available_size();
        let width = avail.x.max(LABEL_W + steps as f32 * 6.0);
        let vel_h = if style.show_velocity { VELOCITY_H } else { 0.0 };
        let bounded = avail.y.is_finite() && avail.y < 20_000.0;
        // With a bounded height (not inside a scroll area) the roll keeps to it and scrolls its rows.
        let room = if bounded { (avail.y - RULER_H - vel_h - 2.0).max(MIN_FILL_ROW_H * 3.0) } else { f32::INFINITY };
        let row_h = if style.row_h > 0.0 {
            style.row_h
        } else if style.fill_height && room.is_finite() {
            (room / rows as f32).clamp(MIN_FILL_ROW_H, MAX_FILL_ROW_H)
        } else {
            DEFAULT_ROW_H
        };
        let content_h = row_h * rows as f32;
        let view_h = if room.is_finite() { room.min(content_h).max(row_h) } else { content_h };
        let total_h = RULER_H + view_h + vel_h;

        let (full_rect, _) = ui.allocate_exact_size(vec2(width, total_h), Sense::hover());
        let painter = ui.painter().with_clip_rect(full_rect);
        let grid_w = width - LABEL_W;
        let col_w = grid_w / steps as f32;
        let ruler = Rect::from_min_size(pos2(full_rect.min.x + LABEL_W, full_rect.min.y), vec2(grid_w, RULER_H));
        let view = Rect::from_min_size(pos2(full_rect.min.x + LABEL_W, ruler.max.y), vec2(grid_w, view_h));
        let keys = Rect::from_min_size(pos2(full_rect.min.x, ruler.max.y), vec2(LABEL_W, view_h));
        let vel_rect = Rect::from_min_size(pos2(view.min.x, view.max.y), vec2(grid_w, vel_h));

        // Vertical scroll when the rows do not fit.
        let max_scroll = (content_h - view_h).max(0.0);
        let (pointer, scroll_delta, ctrl) = ui.input(|i| (i.pointer.pos, i.scroll_delta, i.modifiers.ctrl));
        let over = pointer.map_or(false, |p| view.contains(p) || keys.contains(p));
        if over && max_scroll > 0.0 && !ctrl && scroll_delta.y.abs() > 0.0 {
            st.scroll_y -= scroll_delta.y;
        }
        let first_frame = !st.initialized;
        if first_frame && max_scroll > 0.0 {
            // Open centred, where most melodies live, rather than on the highest notes.
            st.scroll_y = max_scroll * 0.5;
        }
        st.initialized = true;
        st.scroll_y = st.scroll_y.clamp(0.0, max_scroll);
        let row_top = |r: usize| view.min.y - st.scroll_y + r as f32 * row_h;

        painter.rect_filled(full_rect, 6u8, BG);

        // ---- rows and key column ----
        let grid_p = painter.with_clip_rect(view);
        let keys_p = painter.with_clip_rect(keys);
        for r in 0..rows {
            let y0 = row_top(r);
            if y0 > view.max.y || y0 + row_h < view.min.y {
                continue;
            }
            let label = labels.and_then(|l| l.get(r));
            let dark_key = label.map_or(r % 2 == 1, |l| l.contains('#'));
            let highlight = style.highlight_rows.contains(&r);
            let mut bg = if r % 2 == 0 { ROW_A } else { ROW_B };
            if highlight {
                bg = bg.lerp(PLAYHEAD, 0.05);
            }
            grid_p.rect_filled(Rect::from_min_size(pos2(view.min.x, y0), vec2(grid_w, row_h)), 0u8, bg);
            grid_p.line_segment([pos2(view.min.x, y0 + row_h), pos2(view.max.x, y0 + row_h)], Stroke::new(1.0, Color32::from_rgb(22, 26, 35)));

            let key_rect = Rect::from_min_size(pos2(keys.min.x, y0), vec2(LABEL_W, row_h));
            keys_p.rect_filled(key_rect, 0u8, if highlight { KEY_BG.lerp(PLAYHEAD, 0.08) } else { KEY_BG });
            keys_p.line_segment([pos2(key_rect.min.x, key_rect.max.y), pos2(key_rect.max.x, key_rect.max.y)], Stroke::new(1.0, Color32::from_rgb(27, 31, 42)));
            // A key chip on the right edge: dark for sharps, light for naturals.
            let chip_h = (row_h - 8.0).clamp(4.0, 14.0);
            let chip = Rect::from_center_size(pos2(key_rect.max.x - 9.0, key_rect.center().y), vec2(10.0, chip_h));
            keys_p.rect_filled(chip, 2u8, if highlight { with_alpha(PLAYHEAD, 140) } else if dark_key { KEY_DARK } else { Color32::from_rgb(70, 78, 98) });
            if let Some(label) = label {
                let size = (row_h * 0.6).clamp(9.0, 11.5);
                keys_p.text(pos2(key_rect.min.x + 8.0, key_rect.center().y), Align2::LEFT_CENTER, label, FontId::monospace(size), if highlight { PLAYHEAD } else { TEXT });
            }
        }
        painter.line_segment([pos2(keys.max.x, full_rect.min.y), pos2(keys.max.x, full_rect.max.y)], Stroke::new(1.0, Color32::from_rgb(38, 43, 56)));

        // ---- vertical gridlines, in the grid and the velocity lane ----
        for s in 0..=steps {
            let x = view.min.x + s as f32 * col_w;
            let (color, w) = if s % steps_per_bar == 0 { (LINE_BAR, 1.2) } else if s % steps_per_beat == 0 { (LINE_BEAT, 1.0) } else { (LINE_STEP, 1.0) };
            grid_p.line_segment([pos2(x, view.min.y), pos2(x, view.max.y)], Stroke::new(w, color));
            if vel_h > 0.0 && s % steps_per_beat == 0 {
                painter.line_segment([pos2(x, vel_rect.min.y), pos2(x, vel_rect.max.y)], Stroke::new(1.0, LINE_STEP));
            }
        }

        // ---- ruler: bar numbers, then bar.beat ----
        painter.rect_filled(Rect::from_min_size(full_rect.min, vec2(width, RULER_H)), 0u8, RULER_BG);
        painter.line_segment([pos2(full_rect.min.x, ruler.max.y), pos2(full_rect.max.x, ruler.max.y)], Stroke::new(1.0, Color32::from_rgb(38, 43, 56)));
        let beat_w = col_w * steps_per_beat as f32;
        for b in 0..steps.div_ceil(steps_per_beat) {
            let x = ruler.min.x + b as f32 * beat_w;
            let bar = b / 4 + 1;
            let is_bar = b % 4 == 0;
            painter.line_segment([pos2(x, ruler.min.y + if is_bar { 4.0 } else { 12.0 }), pos2(x, ruler.max.y)], Stroke::new(1.0, if is_bar { LINE_BAR } else { LINE_BEAT }));
            if is_bar {
                painter.text(pos2(x + 5.0, ruler.center().y), Align2::LEFT_CENTER, format!("{bar}"), FontId::monospace(11.0), TEXT);
            } else if beat_w >= 34.0 {
                painter.text(pos2(x + 4.0, ruler.center().y + 1.0), Align2::LEFT_CENTER, format!("{bar}.{}", b % 4 + 1), FontId::monospace(9.5), TEXT_DIM);
            }
        }

        // ---- interaction (hit-tested before notes are drawn so the hover preview knows) ----
        let cell_at = |p: crate::entropy_gui::geometry::Pos2| -> Option<(usize, usize)> {
            if !view.contains(p) {
                return None;
            }
            let step = (((p.x - view.min.x) / col_w) as usize).min(steps - 1);
            let row = (((p.y - view.min.y + st.scroll_y) / row_h) as usize).min(rows - 1);
            Some((row, step))
        };
        let mut events = Vec::new();
        let (interact_pos, pressed, down, released) =
            ui.input(|i| (i.pointer.interact_pos(), i.pointer.primary_pressed(), i.pointer.primary_down(), i.pointer.primary_released()));
        if let Some((row, step)) = interact_pos.and_then(cell_at) {
            if pressed {
                events.push(PianoRollEvent::Down { row, step });
            } else if down {
                events.push(PianoRollEvent::Drag { row, step });
            } else if released {
                events.push(PianoRollEvent::Up { row, step });
            }
        }
        let hover_cell = pointer.and_then(cell_at);
        let covers = |n: &PianoRollNote, row: usize, step: usize| n.row == row && step >= n.step && step < n.step + n.length.max(1);
        if let Some((row, step)) = hover_cell {
            if !notes.iter().any(|n| covers(n, row, step)) {
                let r = Rect::from_min_size(pos2(view.min.x + step as f32 * col_w + 1.0, row_top(row) + 2.0), vec2(col_w - 2.0, row_h - 4.0));
                grid_p.rect_filled(r, 4u8, with_alpha(style.note_color, 36));
                grid_p.rect_stroke(r, 4u8, Stroke::new(1.0, with_alpha(style.note_color, 150)), StrokeKind::Middle);
            }
        }

        // ---- notes ----
        let mut seen = std::collections::HashSet::new();
        for n in notes {
            if n.row >= rows || n.step >= steps {
                continue;
            }
            let key = (n.row, n.step);
            seen.insert(key);
            // Notes present when the roll first opens do not pop; only newly painted ones do.
            let born = *st.born.entry(key).or_insert(if first_frame { now - POP_SECONDS } else { now });
            let age = now - born;
            let t = (age / POP_SECONDS).clamp(0.0, 1.0);
            let pop = if t >= 1.0 { 1.0 } else { 0.6 + 0.4 * (1.0 - (1.0 - t).powi(3)) + 0.08 * (t * std::f32::consts::PI).sin() };

            let x0 = view.min.x + n.step as f32 * col_w;
            let w = (n.length.max(1) as f32 * col_w - 2.0).max(3.0);
            let y0 = row_top(n.row);
            let full = Rect::from_min_size(pos2(x0 + 1.0, y0 + 2.0), vec2(w, row_h - 4.0));
            let rect = Rect::from_center_size(full.center(), vec2(full.width() * pop, full.height() * pop));
            let vel = n.velocity.clamp(0.0, 1.0);
            let alpha = (110.0 + vel * 145.0) as u8;
            let hovered = hover_cell.map_or(false, |(r, s)| covers(n, r, s));
            let fill = if hovered { with_alpha(style.note_color.lerp(Color32::WHITE, 0.25), alpha) } else { with_alpha(style.note_color, alpha) };
            let radius = (row_h * 0.22).clamp(2.0, 6.0) as u8;
            grid_p.rect_filled(rect, radius, fill);
            // A darker lip along the bottom gives the block some depth.
            grid_p.rect_filled(Rect::from_min_max(pos2(rect.min.x + 1.0, rect.max.y - 2.0), pos2(rect.max.x - 1.0, rect.max.y)), 1u8, Color32::from_black_alpha(50));
            if w >= 42.0 && row_h >= 20.0 && t >= 1.0 {
                if let Some(label) = labels.and_then(|l| l.get(n.row)) {
                    grid_p.with_clip_rect(rect).text(pos2(rect.min.x + 6.0, rect.center().y), Align2::LEFT_CENTER, label, FontId::monospace(10.0), Color32::from_rgba_unmultiplied(6, 18, 24, 220));
                }
            }

            if vel_h > 0.0 {
                let x = x0 + 4.0;
                let h = (vel_h - 14.0) * vel;
                let base = vel_rect.max.y - 6.0;
                painter.line_segment([pos2(x, base), pos2(x, base - h)], Stroke::new(2.0, with_alpha(style.note_color, 200)));
                painter.circle_filled(pos2(x, base - h), 3.5, style.note_color.lerp(Color32::WHITE, 0.35));
            }
        }
        st.born.retain(|k, _| seen.contains(k));
        if st.born.len() > 4096 {
            st.born.clear();
        }

        if vel_h > 0.0 {
            painter.line_segment([pos2(full_rect.min.x, vel_rect.min.y), pos2(full_rect.max.x, vel_rect.min.y)], Stroke::new(1.0, Color32::from_rgb(44, 50, 66)));
            painter.text(pos2(full_rect.min.x + 8.0, vel_rect.min.y + 12.0), Align2::LEFT_CENTER, "velocity", FontId::proportional(9.5), TEXT_DIM);
        }

        // ---- playhead ----
        if playhead >= 0.0 {
            let x = view.min.x + playhead.clamp(0.0, 1.0) * grid_w;
            painter.line_segment([pos2(x, ruler.max.y), pos2(x, full_rect.max.y)], Stroke::new(5.0, with_alpha(PLAYHEAD, 40)));
            painter.line_segment([pos2(x, ruler.min.y + 2.0), pos2(x, full_rect.max.y)], Stroke::new(1.5, PLAYHEAD));
            painter.add(Shape::convex_polygon(vec![pos2(x - 5.0, ruler.max.y - 8.0), pos2(x + 5.0, ruler.max.y - 8.0), pos2(x, ruler.max.y)], PLAYHEAD, Stroke::NONE));
        }

        // A thin scroll indicator when rows overflow.
        if max_scroll > 0.0 {
            let track_h = view.height();
            let thumb_h = (track_h * view_h / content_h).max(16.0);
            let y = view.min.y + (track_h - thumb_h) * (st.scroll_y / max_scroll);
            painter.rect_filled(Rect::from_min_size(pos2(view.max.x - 5.0, y), vec2(3.0, thumb_h)), 2u8, Color32::from_white_alpha(50));
        }

        painter.rect_stroke(full_rect, 6u8, Stroke::new(1.0, Color32::from_rgb(38, 43, 56)), StrokeKind::Middle);
        ctx.memory_mut(|m| m.put_view_state(state_id, st));
        events
    }
}
