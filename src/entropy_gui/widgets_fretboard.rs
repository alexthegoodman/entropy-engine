//! `FretboardView`: a guitar neck for learning tabs, drawn in the same neon style as `WavetableView`
//! and `PhysModView` - glowing lines on a dark gradient, no attempt at photorealism.
//!
//! Two parts, top to bottom:
//!
//! * the **highway**, a tab staff scrolling toward a "now" line: every upcoming step's fret numbers
//!   on its strings, coloured by how it went (waiting, now, hit, partly played, missed), with bar
//!   lines, so the player reads ahead the way they read a tab;
//! * the **neck**, with frets spaced as on a real guitar (softened so high frets stay readable), inlays,
//!   and on it: where the fingers go now (with the suggested finger), the next few notes as ghosts,
//!   and what the guitar is heard playing - right notes in teal, wrong ones in rose, their strings
//!   vibrating.
//!
//! The caller owns all of it and redraws it every frame: nothing here knows about tabs or grading.
//! Clicking a string at a fret reports `FretboardEvent::Pick` (the app plays and grades it as if the
//! guitar had), so a lesson can be tried with a mouse.
//!
//! Strings are numbered as `guitar::tab` numbers them: 0 is the lowest. By default the highest string
//! is drawn on top, as a tab is written; `low_on_top` draws the neck as the player looks down on it.

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Pos2, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::ui::Ui;

// ------------------------------------------------------------------------------------------
// Palette (shared with the other neon views)
// ------------------------------------------------------------------------------------------

const BG_TOP: [f32; 3] = [0.028, 0.032, 0.070];
const BG_BOTTOM: [f32; 3] = [0.060, 0.050, 0.120];
const AMBER: [f32; 3] = [1.0, 0.78, 0.36];
const TEAL: [f32; 3] = [0.28, 0.90, 0.84];
const VIOLET: [f32; 3] = [0.58, 0.45, 1.0];
const ROSE: [f32; 3] = [1.0, 0.36, 0.42];
const SKY: [f32; 3] = [0.45, 0.62, 1.0];
const DIM: [f32; 3] = [0.34, 0.34, 0.46];
const WOOD: [f32; 3] = [0.10, 0.075, 0.09];
const SILVER: [f32; 3] = [0.70, 0.72, 0.82];
const LABEL: Color32 = Color32::from_rgb(170, 176, 205);

fn mix3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    let t = t.clamp(0.0, 1.0);
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}
fn c32(c: [f32; 3], a: f32) -> Color32 {
    Color32::from_rgba_f32([c[0], c[1], c[2], a.clamp(0.0, 1.0)])
}

pub const MAX_FRET: u8 = 24;
pub const STRINGS: usize = 6;
pub const STANDARD_TUNING: [u8; STRINGS] = [40, 45, 50, 55, 59, 64];

pub fn note_name(midi: u8) -> String {
    const NAMES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    format!("{}{}", NAMES[(midi % 12) as usize], (midi / 12) as i32 - 1)
}

fn pitch_name(midi: u8) -> &'static str {
    const NAMES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    NAMES[(midi % 12) as usize]
}

// ------------------------------------------------------------------------------------------
// Public options / events / response
// ------------------------------------------------------------------------------------------

/// A note on the neck: which string (0 = lowest) at which fret (0 = open).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FretMark {
    pub string: u8,
    pub fret: u8,
    /// The suggested finger, 1 (index) to 4 (little); shown in the dot. None shows the fret.
    pub finger: Option<u8>,
    /// For an upcoming note: how many steps ahead (1 = next). Fades with distance.
    pub ahead: u8,
    /// For a heard note: whether it is one the lesson wants.
    pub correct: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum HighwayState {
    #[default]
    Waiting,
    /// The step being played now.
    Current,
    Hit,
    Partial,
    Miss,
}

impl HighwayState {
    pub fn from_name(name: &str) -> Self {
        match name {
            "current" => Self::Current,
            "hit" => Self::Hit,
            "partial" => Self::Partial,
            "miss" => Self::Miss,
            _ => Self::Waiting,
        }
    }

    fn colour(self) -> [f32; 3] {
        match self {
            Self::Waiting => SKY,
            Self::Current => AMBER,
            Self::Hit => TEAL,
            Self::Partial => VIOLET,
            Self::Miss => ROSE,
        }
    }
}

/// One step on the highway.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HighwayItem {
    /// Beats from now (negative: already passed).
    pub ahead: f32,
    /// (string, fret) pairs.
    pub notes: Vec<(u8, u8)>,
    /// Strings struck muted.
    pub muted: Vec<u8>,
    pub state: HighwayState,
    /// A chord name or the like, shown over the column.
    pub label: Option<String>,
}

#[derive(Clone, Debug)]
pub struct FretboardOptions {
    pub width: Option<f32>,
    pub height: f32,
    /// MIDI note of each open string, lowest first.
    pub tuning: [u8; STRINGS],
    /// The frets shown. With `first_fret` 0 the nut is drawn.
    pub first_fret: u8,
    pub last_fret: u8,
    pub targets: Vec<FretMark>,
    pub upcoming: Vec<FretMark>,
    pub heard: Vec<FretMark>,
    /// Strings the target step mutes, marked with an X at the nut.
    pub muted: Vec<u8>,
    pub show_highway: bool,
    pub highway: Vec<HighwayItem>,
    /// Bar lines on the highway, in beats from now.
    pub highway_bars: Vec<f32>,
    /// Beats visible ahead of the now line.
    pub highway_span: f32,
    /// Top-left line (song, bar, step).
    pub caption: String,
    /// Top-right line (a score, a hint).
    pub status: String,
    /// 0..1, fading: a flash over the targets after a hit (or a miss, with `flash_miss`).
    pub flash: f32,
    pub flash_miss: bool,
    pub low_on_top: bool,
    /// Report clicks on the neck.
    pub interactive: bool,
}

impl Default for FretboardOptions {
    fn default() -> Self {
        Self {
            width: None,
            height: 420.0,
            tuning: STANDARD_TUNING,
            first_fret: 0,
            last_fret: 12,
            targets: Vec::new(),
            upcoming: Vec::new(),
            heard: Vec::new(),
            muted: Vec::new(),
            show_highway: true,
            highway: Vec::new(),
            highway_bars: Vec::new(),
            highway_span: 8.0,
            caption: String::new(),
            status: String::new(),
            flash: 0.0,
            flash_miss: false,
            low_on_top: false,
            interactive: true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FretboardEvent {
    /// The neck was clicked on `string` (0 = lowest) at `fret` (0 = open, left of the first fret).
    Pick { string: u8, fret: u8 },
}

pub struct FretboardResponse {
    pub events: Vec<FretboardEvent>,
    /// The string and fret under the pointer, if any.
    pub hovered: Option<(u8, u8)>,
    /// Where the widget was drawn (see `layout`).
    pub rect: Rect,
}

// ------------------------------------------------------------------------------------------
// Geometry
// ------------------------------------------------------------------------------------------

/// Distance of fret wire `f` from the nut on a real neck, as a fraction of the scale length.
fn real_fret_pos(f: f32) -> f32 {
    1.0 - 2f32.powf(-f / 12.0)
}

/// The neck's layout: where frets and strings are on screen.
#[derive(Clone, Copy, Debug)]
pub struct Neck {
    /// The fretted area (from the first shown fret wire, or the nut, to the last).
    pub board: Rect,
    /// Left of the board: string names, and the open/muted markers.
    pub gutter: Rect,
    pub first: u8,
    pub last: u8,
    pub low_on_top: bool,
}

impl Neck {
    pub fn new(area: Rect, first: u8, last: u8, low_on_top: bool) -> Self {
        let first = first.min(MAX_FRET - 1);
        let last = last.clamp(first + 1, MAX_FRET);
        let gutter_w = 58.0f32.min(area.width() * 0.15);
        let gutter = Rect::from_min_max(area.min, pos2(area.min.x + gutter_w, area.max.y));
        let board = Rect::from_min_max(pos2(gutter.max.x, area.min.y), pos2(area.max.x - 12.0, area.max.y));
        Self { board, gutter, first, last, low_on_top }
    }

    /// Screen x of fret wire `f` (the nut is wire 0). Spacing is 60% real, 40% even, so frets
    /// shrink up the neck as on a guitar but the twelfth fret is not crushed.
    pub fn wire_x(&self, f: f32) -> f32 {
        let (a, b) = (self.first as f32, self.last as f32);
        let real = (real_fret_pos(f) - real_fret_pos(a)) / (real_fret_pos(b) - real_fret_pos(a)).max(1.0e-6);
        let even = (f - a) / (b - a).max(1.0e-6);
        self.board.min.x + (0.6 * real + 0.4 * even) * self.board.width()
    }

    /// Where a note at `fret` is drawn: just behind its fret wire, where a finger presses; an open
    /// string sits in the gutter.
    pub fn note_x(&self, fret: u8) -> f32 {
        if fret == 0 {
            return self.gutter.max.x - 14.0;
        }
        // Below the window: pinned to its left edge.
        if fret <= self.first {
            return self.board.min.x + 4.0;
        }
        let f = fret as f32;
        let lo = self.wire_x((f - 1.0).max(self.first as f32));
        let hi = self.wire_x(f);
        lo + (hi - lo) * 0.62
    }

    /// Row of string `s` (0 = lowest), top to bottom.
    fn row(&self, s: u8) -> usize {
        if self.low_on_top { s as usize } else { STRINGS - 1 - s as usize }
    }

    pub fn string_y(&self, s: u8) -> f32 {
        let pad = self.board.height() * 0.09;
        let span = self.board.height() - 2.0 * pad;
        self.board.min.y + pad + span * self.row(s) as f32 / (STRINGS - 1) as f32
    }

    fn string_gap(&self) -> f32 {
        (self.board.height() * 0.82) / (STRINGS - 1) as f32
    }

    /// The string and fret under `p`: the nearest string within half a gap, and the fret whose cell
    /// holds `p` (0 in the gutter or left of the first wire when the nut shows).
    pub fn hit(&self, p: Pos2) -> Option<(u8, u8)> {
        if p.y < self.board.min.y - 4.0 || p.y > self.board.max.y + 4.0 || p.x < self.gutter.min.x + 18.0 || p.x > self.board.max.x {
            return None;
        }
        let gap = self.string_gap();
        let s = (0..STRINGS as u8).min_by(|a, b| (self.string_y(*a) - p.y).abs().total_cmp(&(self.string_y(*b) - p.y).abs()))?;
        if (self.string_y(s) - p.y).abs() > gap * 0.5 {
            return None;
        }
        if p.x < self.board.min.x {
            return Some((s, 0));
        }
        for f in (self.first + 1)..=self.last {
            if p.x <= self.wire_x(f as f32) {
                return Some((s, f));
            }
        }
        Some((s, self.last))
    }
}

// ------------------------------------------------------------------------------------------
// The view
// ------------------------------------------------------------------------------------------

#[derive(Default)]
struct ViewState {
    /// Per string, how hard it is vibrating on screen (follows `heard`, decays), and whether the
    /// note on it was a right one.
    ring: [f32; STRINGS],
    ring_ok: [bool; STRINGS],
    last_time: f32,
}

const HEADER_H: f32 = 26.0;
const NUMBERS_H: f32 = 18.0;

/// Where the highway (if shown) and the neck sit in the widget's rect.
pub fn layout(rect: Rect, opts: &FretboardOptions) -> (Option<Rect>, Neck) {
    let body = Rect::from_min_max(pos2(rect.min.x, rect.min.y + HEADER_H), pos2(rect.max.x, rect.max.y - NUMBERS_H));
    let (highway, neck_rect) = if opts.show_highway {
        let h = (body.height() * 0.40).clamp(80.0, 190.0);
        (Some(Rect::from_min_max(body.min, pos2(body.max.x, body.min.y + h))), Rect::from_min_max(pos2(body.min.x, body.min.y + h + 16.0), body.max))
    } else {
        (None, body)
    };
    (highway, Neck::new(neck_rect, opts.first_fret, opts.last_fret, opts.low_on_top))
}

pub struct FretboardView {
    id: Id,
}

impl FretboardView {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new(id_salt) }
    }

    pub fn show(self, ui: &mut Ui, opts: &FretboardOptions) -> FretboardResponse {
        let ctx = ui.ctx().clone();
        let width = opts.width.unwrap_or_else(|| ui.available_width().max(420.0));
        let (resp, painter) = ui.allocate_painter(vec2(width, opts.height.max(200.0)), Sense::click_and_drag());
        let rect = resp.rect;
        let pointer = ctx.input(|i| i.pointer);
        let mut st: ViewState = ctx.memory_mut(|m| m.take_view_state(self.id));
        let now = ctx.time();
        let dt = (now - st.last_time).clamp(0.0, 0.1);
        st.last_time = now;

        // ---------------------------------------------------------------- layout
        let (highway_rect, neck) = layout(rect, opts);

        // ---------------------------------------------------------------- input
        let mut events = Vec::new();
        let hovered = if opts.interactive && resp.hovered() { pointer.pos.and_then(|p| neck.hit(p)) } else { None };
        if opts.interactive && pointer.primary_pressed && resp.hovered() {
            if let Some((string, fret)) = hovered {
                events.push(FretboardEvent::Pick { string, fret });
            }
        }

        // Strings ring while a heard note sits on them, and settle after.
        for s in 0..STRINGS {
            let on = opts.heard.iter().find(|h| h.string as usize == s);
            st.ring[s] = if on.is_some() { 1.0 } else { st.ring[s] * (-dt / 0.35).exp() };
            if let Some(h) = on {
                st.ring_ok[s] = h.correct;
            }
        }

        // ---------------------------------------------------------------- drawing
        for y in 0..20 {
            let t0 = y as f32 / 20.0;
            let t1 = (y + 1) as f32 / 20.0;
            let band = Rect::from_min_max(pos2(rect.min.x, rect.min.y + t0 * rect.height()), pos2(rect.max.x, rect.min.y + t1 * rect.height()));
            painter.rect_filled(band, 0u8, c32(mix3(BG_TOP, BG_BOTTOM, (t0 + t1) * 0.5), 1.0));
        }
        let clip = painter.with_clip_rect(rect);
        draw_header(&clip, rect, HEADER_H, opts);
        if let Some(hw) = highway_rect {
            draw_highway(&clip.with_clip_rect(hw), hw, &neck, opts, now);
        }
        draw_neck(&clip, &neck, opts, &st, now);
        draw_fret_numbers(&clip, &neck, rect.max.y - NUMBERS_H);
        for m in opts.upcoming.iter().filter(|m| m.ahead > 0).rev() {
            draw_upcoming(&clip, &neck, m);
        }
        for m in &opts.targets {
            draw_target(&clip, &neck, m, opts, now);
        }
        for m in &opts.heard {
            draw_heard(&clip, &neck, m, &opts.tuning, now);
        }
        if let Some((s, f)) = hovered {
            let p = pos2(neck.note_x(f), neck.string_y(s));
            clip.circle_stroke(p, 11.0, Stroke::new(1.5, c32(SILVER, 0.7)));
            let midi = opts.tuning[s as usize].saturating_add(f);
            clip.text(pos2(p.x, p.y - 15.0), Align2::CENTER_BOTTOM, note_name(midi), FontId::proportional(11.0), c32(SILVER, 0.95));
        }

        ctx.memory_mut(|m| m.put_view_state(self.id, st));
        FretboardResponse { events, hovered, rect }
    }
}

fn glow_dot(p: &Painter, c: Pos2, r: f32, colour: [f32; 3], alpha: f32) {
    for (k, a) in [(2.2, 0.07), (1.7, 0.12), (1.3, 0.22)] {
        p.circle_filled(c, r * k, c32(colour, alpha * a));
    }
    p.circle_filled(c, r, c32(colour, alpha));
}

fn draw_header(p: &Painter, rect: Rect, h: f32, opts: &FretboardOptions) {
    let y = rect.min.y + h * 0.5;
    if !opts.caption.is_empty() {
        p.text(pos2(rect.min.x + 12.0, y), Align2::LEFT_CENTER, &opts.caption, FontId::proportional(13.0), c32(AMBER, 0.95));
    }
    if !opts.status.is_empty() {
        p.text(pos2(rect.max.x - 12.0, y), Align2::RIGHT_CENTER, &opts.status, FontId::proportional(12.0), LABEL);
    }
}

fn draw_highway(p: &Painter, r: Rect, neck: &Neck, opts: &FretboardOptions, now: f32) {
    p.rect_filled(r, 6u8, c32([0.02, 0.02, 0.05], 0.55));
    p.rect_stroke(r, 6u8, Stroke::new(1.0, c32(DIM, 0.35)), StrokeKind::Middle);
    let pad = r.height() * 0.13;
    let row_y = |s: u8| {
        let row = if neck.low_on_top { s as f32 } else { (STRINGS - 1) as f32 - s as f32 };
        r.min.y + pad + (r.height() - 2.0 * pad) * row / (STRINGS - 1) as f32
    };
    // Room behind the now line for the last few steps, so a miss can be seen sliding away.
    let span = opts.highway_span.max(1.0);
    let behind = (span * 0.3).max(2.0);
    let staff_x = r.min.x + 30.0;
    let px_per_beat = (r.max.x - 18.0 - staff_x - 16.0) / (span + behind);
    let now_x = staff_x + 16.0 + behind * px_per_beat;
    let x_of = |ahead: f32| now_x + ahead * px_per_beat;

    // Staff lines, with the string names in the gutter.
    for s in 0..STRINGS as u8 {
        let y = row_y(s);
        p.line_segment([pos2(r.min.x + 30.0, y), pos2(r.max.x - 6.0, y)], Stroke::new(1.0, c32(DIM, 0.45)));
        let name = pitch_name(opts.tuning[s as usize]);
        let label = if s as usize == STRINGS - 1 && pitch_name(opts.tuning[0]) == name { name.to_lowercase() } else { name.to_string() };
        p.text(pos2(r.min.x + 16.0, y), Align2::CENTER_CENTER, label, FontId::monospace(11.0), c32(DIM, 0.9));
    }
    for &b in &opts.highway_bars {
        let x = x_of(b);
        if x > r.min.x + 30.0 && x < r.max.x {
            p.line_segment([pos2(x, row_y(if neck.low_on_top { 0 } else { 5 })), pos2(x, row_y(if neck.low_on_top { 5 } else { 0 }))], Stroke::new(1.5, c32(SILVER, 0.35)));
        }
    }
    // The now line.
    let pulse = 0.75 + 0.25 * (now * 4.0).sin();
    p.line_segment([pos2(now_x, r.min.y + 4.0), pos2(now_x, r.max.y - 4.0)], Stroke::new(7.0, c32(AMBER, 0.12 * pulse)));
    p.line_segment([pos2(now_x, r.min.y + 4.0), pos2(now_x, r.max.y - 4.0)], Stroke::new(1.8, c32(AMBER, 0.85)));

    let font = FontId::monospace(12.0);
    for item in &opts.highway {
        let x = x_of(item.ahead);
        if x < staff_x - 10.0 || x > r.max.x + 20.0 {
            continue;
        }
        let colour = item.state.colour();
        let current = item.state == HighwayState::Current;
        // Passed steps and far-off ones fade.
        let fade = if item.ahead < 0.0 { (1.0 + item.ahead / 3.0).clamp(0.25, 1.0) } else { (1.0 - item.ahead / (span * 1.4)).clamp(0.35, 1.0) };
        if item.notes.len() > 1 {
            let ys: Vec<f32> = item.notes.iter().map(|n| row_y(n.0)).collect();
            let (lo, hi) = (ys.iter().cloned().fold(f32::MAX, f32::min), ys.iter().cloned().fold(f32::MIN, f32::max));
            p.line_segment([pos2(x, lo), pos2(x, hi)], Stroke::new(if current { 3.0 } else { 2.0 }, c32(colour, 0.35 * fade)));
        }
        for &(s, f) in &item.notes {
            let y = row_y(s);
            let text = f.to_string();
            let w = 10.0 + 7.5 * text.len() as f32;
            let pill = Rect::from_center_size(pos2(x, y), vec2(w, 17.0));
            if current {
                p.rect_filled(pill.expand(4.0), 10u8, c32(colour, 0.18));
            }
            p.rect_filled(pill, 8u8, c32(mix3([0.03, 0.03, 0.07], colour, 0.25), 0.95 * fade));
            p.rect_stroke(pill, 8u8, Stroke::new(if current { 2.0 } else { 1.2 }, c32(colour, 0.95 * fade)), StrokeKind::Middle);
            p.text(pill.center(), Align2::CENTER_CENTER, text, font, c32(mix3(colour, [1.0, 1.0, 1.0], 0.55), fade));
        }
        for &s in &item.muted {
            p.text(pos2(x, row_y(s)), Align2::CENTER_CENTER, "x", font, c32(DIM, fade));
        }
        if let Some(label) = &item.label {
            p.text(pos2(x, r.min.y + 2.0), Align2::CENTER_TOP, label, FontId::proportional(10.0), c32(colour, 0.85 * fade));
        }
    }
}

fn draw_neck(p: &Painter, neck: &Neck, opts: &FretboardOptions, st: &ViewState, now: f32) {
    let b = neck.board;
    // The fingerboard, a touch lighter toward the middle.
    let wood = Rect::from_min_max(pos2(b.min.x, b.min.y), pos2(b.max.x, b.max.y));
    p.rect_filled_gradient(wood, c32(WOOD, 1.0), c32(mix3(WOOD, VIOLET, 0.08), 1.0), c32(mix3(WOOD, [0.0, 0.0, 0.0], 0.3), 1.0), c32(WOOD, 1.0));
    p.line_segment([pos2(b.min.x, b.min.y), pos2(b.max.x, b.min.y)], Stroke::new(1.0, c32(VIOLET, 0.35)));
    p.line_segment([pos2(b.min.x, b.max.y), pos2(b.max.x, b.max.y)], Stroke::new(1.0, c32(VIOLET, 0.35)));

    // Inlays: single dots at 3 5 7 9 15 17 19 21, doubles at 12 and 24.
    let mid = (neck.string_y(2) + neck.string_y(3)) * 0.5;
    for f in (neck.first + 1)..=neck.last {
        let x = (neck.wire_x(f as f32 - 1.0) + neck.wire_x(f as f32)) * 0.5;
        match f % 12 {
            3 | 5 | 7 | 9 => p.circle_filled(pos2(x, mid), 5.0, c32(VIOLET, 0.35)),
            0 => {
                p.circle_filled(pos2(x, (neck.string_y(1) + neck.string_y(2)) * 0.5), 5.0, c32(VIOLET, 0.42));
                p.circle_filled(pos2(x, (neck.string_y(3) + neck.string_y(4)) * 0.5), 5.0, c32(VIOLET, 0.42));
            }
            _ => {}
        }
    }
    // Fret wires, and the nut when it shows.
    for f in neck.first..=neck.last {
        let x = neck.wire_x(f as f32);
        if f == 0 {
            p.line_segment([pos2(x, b.min.y), pos2(x, b.max.y)], Stroke::new(9.0, c32(SILVER, 0.12)));
            p.line_segment([pos2(x, b.min.y), pos2(x, b.max.y)], Stroke::new(5.0, c32(mix3(SILVER, AMBER, 0.2), 0.9)));
        } else {
            p.line_segment([pos2(x, b.min.y), pos2(x, b.max.y)], Stroke::new(4.0, c32(SILVER, 0.08)));
            p.line_segment([pos2(x, b.min.y), pos2(x, b.max.y)], Stroke::new(1.6, c32(SILVER, 0.55)));
        }
    }
    // Strings: thicker low, vibrating while heard.
    for s in 0..STRINGS as u8 {
        let y = neck.string_y(s);
        let thick = 1.0 + 0.45 * (STRINGS as f32 - 1.0 - s as f32) * 0.5 + 0.2 * (s < 3) as u8 as f32;
        let ring = st.ring[s as usize];
        let tint = if st.ring_ok[s as usize] { TEAL } else { ROSE };
        let colour = if ring > 0.02 { mix3(SILVER, tint, ring) } else { SILVER };
        let x0 = neck.gutter.min.x + 30.0;
        let x1 = b.max.x;
        if ring > 0.02 {
            let amp = 2.6 * ring;
            let n = 64;
            let pts: Vec<Pos2> = (0..=n)
                .map(|k| {
                    let t = k as f32 / n as f32;
                    let env = (std::f32::consts::PI * t).sin();
                    pos2(x0 + (x1 - x0) * t, y + amp * env * (now * 38.0 + s as f32).sin())
                })
                .collect();
            for w in pts.windows(2) {
                p.line_segment([w[0], w[1]], Stroke::new(thick + 6.0, c32(tint, 0.10 * ring)));
            }
            for w in pts.windows(2) {
                p.line_segment([w[0], w[1]], Stroke::new(thick, c32(colour, 0.95)));
            }
        } else {
            p.line_segment([pos2(x0, y), pos2(x1, y)], Stroke::new(thick, c32(colour, 0.7)));
        }
        // Name in the gutter.
        let name = pitch_name(opts.tuning[s as usize]);
        let label = if s as usize == STRINGS - 1 && pitch_name(opts.tuning[0]) == name { name.to_lowercase() } else { name.to_string() };
        p.text(pos2(neck.gutter.min.x + 14.0, y), Align2::CENTER_CENTER, label, FontId::monospace(12.0), c32(if ring > 0.02 { tint } else { DIM }, 0.95));
    }
    // Muted strings for the step being played.
    for &s in &opts.muted {
        let c = pos2(neck.note_x(0), neck.string_y(s));
        let d = 5.0;
        p.line_segment([pos2(c.x - d, c.y - d), pos2(c.x + d, c.y + d)], Stroke::new(2.0, c32(ROSE, 0.85)));
        p.line_segment([pos2(c.x - d, c.y + d), pos2(c.x + d, c.y - d)], Stroke::new(2.0, c32(ROSE, 0.85)));
    }
    if neck.first > 0 {
        p.text(pos2(b.min.x + 4.0, b.min.y - 3.0), Align2::LEFT_BOTTOM, format!("fret {}", neck.first + 1), FontId::proportional(10.0), c32(DIM, 0.9));
    }
}

fn draw_fret_numbers(p: &Painter, neck: &Neck, y: f32) {
    for f in (neck.first + 1)..=neck.last {
        let x = (neck.wire_x(f as f32 - 1.0) + neck.wire_x(f as f32)) * 0.5;
        let marked = matches!(f % 12, 0 | 3 | 5 | 7 | 9);
        p.text(pos2(x, y + 3.0), Align2::CENTER_TOP, f.to_string(), FontId::proportional(10.0), c32(if marked { SILVER } else { DIM }, 0.85));
    }
}

fn mark_pos(neck: &Neck, m: &FretMark) -> Pos2 {
    pos2(neck.note_x(m.fret), neck.string_y(m.string.min(STRINGS as u8 - 1)))
}

fn dot_radius(neck: &Neck) -> f32 {
    (neck.string_gap() * 0.40).clamp(7.0, 15.0)
}

fn draw_upcoming(p: &Painter, neck: &Neck, m: &FretMark) {
    let c = mark_pos(neck, m);
    let r = dot_radius(neck) * 0.9;
    let a = (0.85 - 0.22 * (m.ahead as f32 - 1.0)).clamp(0.2, 0.85);
    p.circle_filled(c, r, c32([0.03, 0.03, 0.08], 0.7 * a));
    p.circle_stroke(c, r, Stroke::new(1.6, c32(SKY, a)));
    p.text(c, Align2::CENTER_CENTER, m.ahead.to_string(), FontId::proportional(10.0), c32(SKY, a));
}

fn draw_target(p: &Painter, neck: &Neck, m: &FretMark, opts: &FretboardOptions, now: f32) {
    let c = mark_pos(neck, m);
    let r = dot_radius(neck);
    let breathe = 0.85 + 0.15 * (now * 3.2).sin();
    if m.fret == 0 {
        // An open string: a ring at the nut.
        p.circle_stroke(c, r * 0.8, Stroke::new(5.0, c32(AMBER, 0.18 * breathe)));
        p.circle_stroke(c, r * 0.8, Stroke::new(2.2, c32(AMBER, 0.95)));
    } else {
        glow_dot(p, c, r, AMBER, 0.95 * breathe);
        let text = m.finger.map(|f| f.to_string()).unwrap_or_else(|| m.fret.to_string());
        p.text(c, Align2::CENTER_CENTER, text, FontId::proportional((r * 1.15).clamp(10.0, 16.0)), Color32::from_rgb(28, 18, 8));
    }
    if opts.flash > 0.01 {
        let colour = if opts.flash_miss { ROSE } else { TEAL };
        let grow = 1.0 + (1.0 - opts.flash) * 1.4;
        p.circle_stroke(c, r * grow, Stroke::new(3.0, c32(colour, opts.flash)));
    }
}

fn draw_heard(p: &Painter, neck: &Neck, m: &FretMark, tuning: &[u8; STRINGS], now: f32) {
    let c = mark_pos(neck, m);
    let r = dot_radius(neck) * 0.55;
    let colour = if m.correct { TEAL } else { ROSE };
    let pulse = 0.8 + 0.2 * (now * 9.0).sin();
    p.circle_stroke(c, r * 2.1, Stroke::new(2.0, c32(colour, 0.5 * pulse)));
    glow_dot(p, c, r, colour, 0.95);
    if !m.correct {
        let midi = tuning[m.string.min(5) as usize].saturating_add(m.fret);
        p.text(pos2(c.x, c.y + r * 2.3), Align2::CENTER_TOP, note_name(midi), FontId::proportional(10.0), c32(ROSE, 0.95));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn neck() -> Neck {
        Neck::new(Rect::from_min_max(pos2(0.0, 0.0), pos2(1000.0, 300.0)), 0, 12, false)
    }

    #[test]
    fn frets_get_closer_up_the_neck_and_span_the_board() {
        let n = neck();
        assert!((n.wire_x(0.0) - n.board.min.x).abs() < 0.01);
        assert!((n.wire_x(12.0) - n.board.max.x).abs() < 0.01);
        let first = n.wire_x(1.0) - n.wire_x(0.0);
        let twelfth = n.wire_x(12.0) - n.wire_x(11.0);
        assert!(first > twelfth * 1.3, "{first} vs {twelfth}");
    }

    #[test]
    fn the_high_string_is_on_top_unless_asked_otherwise() {
        let n = neck();
        assert!(n.string_y(5) < n.string_y(0));
        let flipped = Neck { low_on_top: true, ..n };
        assert!(flipped.string_y(0) < flipped.string_y(5));
    }

    #[test]
    fn a_click_lands_on_the_string_and_fret_drawn_there() {
        let n = neck();
        for s in 0..6u8 {
            for f in 0..=12u8 {
                let p = pos2(n.note_x(f), n.string_y(s));
                assert_eq!(n.hit(p), Some((s, f)), "string {s} fret {f}");
            }
        }
        assert_eq!(n.hit(pos2(500.0, -50.0)), None);
    }

    #[test]
    fn a_window_up_the_neck_starts_past_its_first_wire() {
        let n = Neck::new(Rect::from_min_max(pos2(0.0, 0.0), pos2(1000.0, 300.0)), 5, 17, false);
        let p = pos2(n.note_x(6), n.string_y(2));
        assert_eq!(n.hit(p), Some((2, 6)));
        assert!(n.note_x(6) > n.board.min.x);
        assert_eq!(n.note_x(0), n.gutter.max.x - 14.0);
    }
}
