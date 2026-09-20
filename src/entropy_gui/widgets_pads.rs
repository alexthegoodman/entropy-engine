//! `PadGrid` - a drum-machine pad bank: rounded pads in a grid, each with a name, a waveform
//! thumbnail of the sound on it, a colour accent, a selection ring and a glow the caller can pulse
//! when the pad is hit. Same domain-agnostic shape as `TreeView`/`KanbanBoard`: the caller hands
//! in one flat, already-resolved `Vec<Pad>` per frame (the widget knows nothing about samples,
//! tracks or files, only what to draw), and `show()` returns `PadEvent`s to apply back.
//!
//! What a pad shows follows `PadKind`:
//! - `Sample`: the waveform, with the part outside a trim range dimmed and the trim edges marked.
//! - `Synth`: a built-in voice, drawn quietly (no picture of a sound that is computed live).
//! - `Empty`: a faint "+", the slot exists but nothing is on it.
//! - `Missing`: a sample that was assigned but whose file is gone, in a warning tint, so a moved
//!   folder shows up as a red pad instead of a silent one.

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Rect, StrokeKind, Vec2};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::ui::{interact, Ui};

const GAP: f32 = 8.0;
const RADIUS: u8 = 9;
const ACCENT_H: f32 = 3.0;
const HEAD_H: f32 = 22.0;
const FOOT_H: f32 = 20.0;
const BASE: Color32 = Color32::from_rgb(25, 27, 33);
const WARN: Color32 = Color32::from_rgb(226, 96, 96);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PadKind {
    Empty,
    Synth,
    Sample,
    Missing,
}

#[derive(Clone, Debug)]
pub struct Pad {
    /// Unique within the grid.
    pub id: String,
    pub label: String,
    /// The second line, usually the file name.
    pub sublabel: String,
    /// A small tag in the top-right corner, such as the MIDI note the pad answers to.
    pub hint: String,
    pub color: Color32,
    pub kind: PadKind,
    /// Peak envelope of the sound, 0..1 per bin, drawn for `Sample` pads.
    pub waveform: Vec<f32>,
    /// Start and end of the played part as fractions of the waveform, `[0, 1]` when untrimmed.
    pub trim: [f32; 2],
    pub selected: bool,
    /// 0..1, how lit the pad is right now. The caller decays it; this widget keeps no time.
    pub glow: f32,
}

impl Pad {
    pub fn new(id: impl Into<String>, label: impl Into<String>, color: Color32) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            sublabel: String::new(),
            hint: String::new(),
            color,
            kind: PadKind::Empty,
            waveform: Vec::new(),
            trim: [0.0, 1.0],
            selected: false,
            glow: 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PadGridOptions {
    pub columns: usize,
    pub pad_size: Vec2,
    /// A dashed "+" tile after the last pad that asks for a new one.
    pub add_tile: bool,
}

impl Default for PadGridOptions {
    fn default() -> Self {
        Self { columns: 4, pad_size: vec2(132.0, 88.0), add_tile: false }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum PadEvent {
    /// A pad was clicked: select it, play it, or put whatever is armed on it.
    Clicked(String),
    /// A pad was right-clicked: take its sound off.
    Cleared(String),
    /// The add tile was clicked.
    AddRequested,
}

pub struct PadGridResponse {
    pub events: Vec<PadEvent>,
    /// Where every pad was drawn, in the same order as the input, for tests and callers that
    /// position something next to a pad.
    pub rects: Vec<(String, Rect)>,
    pub add_rect: Option<Rect>,
}

pub struct PadGrid {
    id: Id,
    options: PadGridOptions,
}

fn with_alpha(c: Color32, a: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), a)
}

/// `text` cut to about `max_chars` characters, with "..." where it was cut.
fn clip_text(text: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max_chars || max_chars < 4 {
        return text.to_string();
    }
    let mut s: String = chars[..max_chars - 3].iter().collect();
    s.push_str("...");
    s
}

impl PadGrid {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("pad_grid").with(id_salt), options: PadGridOptions::default() }
    }

    pub fn options(mut self, options: PadGridOptions) -> Self {
        self.options = options;
        self
    }

    /// Size of the grid for `count` pads (plus the add tile if enabled): what `show` allocates.
    pub fn size_for(options: &PadGridOptions, count: usize) -> Vec2 {
        let cells = count + usize::from(options.add_tile);
        let cols = options.columns.max(1);
        let rows = cells.div_ceil(cols).max(1);
        let used_cols = cells.min(cols).max(1);
        vec2(
            used_cols as f32 * options.pad_size.x + (used_cols - 1) as f32 * GAP,
            rows as f32 * options.pad_size.y + (rows - 1) as f32 * GAP,
        )
    }

    pub fn show(self, ui: &mut Ui, pads: &[Pad]) -> PadGridResponse {
        let ctx = ui.ctx().clone();
        let grid_id = self.id;
        let opts = self.options;
        let cols = opts.columns.max(1);
        let mut events = Vec::new();
        let mut rects = Vec::with_capacity(pads.len());

        let (bg, painter) = ui.allocate_painter(Self::size_for(&opts, pads.len()), Sense::hover());
        let origin = bg.rect.min;
        let cell = |i: usize| {
            let (col, row) = (i % cols, i / cols);
            Rect::from_min_size(
                pos2(origin.x + col as f32 * (opts.pad_size.x + GAP), origin.y + row as f32 * (opts.pad_size.y + GAP)),
                opts.pad_size,
            )
        };

        let title_font = FontId::proportional(12.5);
        let small_font = FontId::proportional(10.5);
        let hint_font = FontId::proportional(10.0);

        for (i, pad) in pads.iter().enumerate() {
            let r = cell(i);
            rects.push((pad.id.clone(), r));
            let resp = interact(&ctx, r, grid_id.with(("pad", &pad.id)), Sense::click());
            let hovered = resp.hovered();
            let accent = if pad.kind == PadKind::Missing { WARN } else { pad.color };
            let glow = pad.glow.clamp(0.0, 1.0);

            // Halo: a soft ring behind the pad, wider while it is hit and steady while selected.
            if pad.selected {
                painter.rect_filled(r.expand(3.0), RADIUS + 3, with_alpha(accent, 46));
            }
            if glow > 0.01 {
                painter.rect_filled(r.expand(2.0 + glow * 5.0), RADIUS + 5, with_alpha(accent, (glow * 96.0) as u8));
            }

            let tint = match pad.kind {
                PadKind::Sample => 0.13,
                PadKind::Missing => 0.16,
                PadKind::Synth => 0.07,
                PadKind::Empty => 0.0,
            } + if hovered { 0.05 } else { 0.0 }
                + glow * 0.34;
            let fill = BASE.lerp(accent, tint.min(0.7));
            painter.rect_filled(r, RADIUS, fill);

            // A strip of colour along the top edge, full strength only for a pad with a sound.
            let strip = Rect::from_min_size(pos2(r.min.x + 10.0, r.min.y + 1.0), vec2(r.width() - 20.0, ACCENT_H));
            let strip_alpha = match pad.kind {
                PadKind::Sample | PadKind::Missing => 235,
                PadKind::Synth => 120,
                PadKind::Empty => 40,
            };
            painter.rect_filled(strip, 2u8, with_alpha(accent, strip_alpha));

            // The picture area between the header and footer lines.
            let pic = Rect::from_min_max(pos2(r.min.x + 10.0, r.min.y + HEAD_H + 4.0), pos2(r.max.x - 10.0, r.max.y - FOOT_H - 2.0));
            match pad.kind {
                PadKind::Sample | PadKind::Missing if !pad.waveform.is_empty() => {
                    let n = pad.waveform.len();
                    let bar_w = pic.width() / n as f32;
                    let mid = pic.center().y;
                    let half = pic.height() / 2.0;
                    let (t0, t1) = (pad.trim[0].clamp(0.0, 1.0), pad.trim[1].clamp(0.0, 1.0));
                    // Solid colours mixed against the pad's own fill rather than translucent bars: adjacent
                    // translucent bars leave a visible seam between them, which reads as a barcode.
                    let played = fill.lerp(accent, 0.72 + glow * 0.28);
                    let dimmed = fill.lerp(accent, 0.16);
                    for (b, v) in pad.waveform.iter().enumerate() {
                        let frac = (b as f32 + 0.5) / n as f32;
                        let inside = frac >= t0 && frac <= t1;
                        let h = (v.clamp(0.0, 1.0) * half).max(0.75);
                        let x = pic.min.x + b as f32 * bar_w;
                        let bar = Rect::from_min_max(pos2(x, mid - h), pos2(x + bar_w, mid + h));
                        painter.rect_filled(bar, 0u8, if inside { played } else { dimmed });
                    }
                    if t0 > 0.001 || t1 < 0.999 {
                        for t in [t0, t1] {
                            let x = pic.min.x + t * pic.width();
                            painter.line_segment([pos2(x, pic.min.y), pos2(x, pic.max.y)], Stroke::new(1.0, Color32::from_white_alpha(170)));
                        }
                    }
                }
                PadKind::Missing => {
                    painter.text(pic.center(), Align2::CENTER_CENTER, "file missing", small_font, with_alpha(WARN, 210));
                }
                PadKind::Synth => {
                    painter.text(pic.center(), Align2::CENTER_CENTER, "built-in", small_font, Color32::from_white_alpha(70));
                }
                _ => {
                    painter.text(pic.center(), Align2::CENTER_CENTER, "+", FontId::proportional(24.0), Color32::from_white_alpha(46));
                }
            }

            // Text: name and note on the header line, the file on the footer line.
            let label_color = if pad.kind == PadKind::Empty { Color32::from_gray(150) } else { Color32::WHITE };
            painter.text(pos2(r.min.x + 11.0, r.min.y + 6.0 + ACCENT_H), Align2::LEFT_TOP, &pad.label, title_font, label_color);
            if !pad.hint.is_empty() {
                painter.text(pos2(r.max.x - 11.0, r.min.y + 8.0 + ACCENT_H), Align2::RIGHT_TOP, &pad.hint, hint_font, Color32::from_gray(140));
            }
            if !pad.sublabel.is_empty() {
                let max_chars = ((r.width() - 20.0) / 5.4) as usize;
                painter.text(pos2(r.min.x + 11.0, r.max.y - 6.0), Align2::LEFT_BOTTOM, clip_text(&pad.sublabel, max_chars), small_font, Color32::from_gray(172));
            }

            let border = if pad.selected {
                Stroke::new(2.0, accent)
            } else if hovered {
                Stroke::new(1.0, with_alpha(accent, 150))
            } else {
                Stroke::new(1.0, Color32::from_white_alpha(22))
            };
            painter.rect_stroke(r, RADIUS, border, StrokeKind::Middle);

            if resp.clicked() {
                events.push(PadEvent::Clicked(pad.id.clone()));
            } else if resp.secondary_clicked() {
                events.push(PadEvent::Cleared(pad.id.clone()));
            }
        }

        let mut add_rect = None;
        if opts.add_tile {
            let r = cell(pads.len());
            add_rect = Some(r);
            let resp = interact(&ctx, r, grid_id.with("add"), Sense::click());
            painter.rect_filled(r, RADIUS, BASE.lerp(Color32::WHITE, if resp.hovered() { 0.06 } else { 0.02 }));
            painter.rect_stroke(r, RADIUS, Stroke::new(1.0, Color32::from_white_alpha(if resp.hovered() { 90 } else { 36 })), StrokeKind::Middle);
            painter.text(r.center(), Align2::CENTER_CENTER, "+ Add pad", title_font, Color32::from_white_alpha(if resp.hovered() { 210 } else { 120 }));
            if resp.clicked() {
                events.push(PadEvent::AddRequested);
            }
        }

        PadGridResponse { events, rects, add_rect }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_grid_is_sized_from_its_pad_count_and_columns() {
        let o = PadGridOptions { columns: 4, pad_size: vec2(100.0, 80.0), add_tile: false };
        assert_eq!(PadGrid::size_for(&o, 0), vec2(100.0, 80.0));
        assert_eq!(PadGrid::size_for(&o, 3), vec2(3.0 * 100.0 + 2.0 * GAP, 80.0));
        assert_eq!(PadGrid::size_for(&o, 5), vec2(4.0 * 100.0 + 3.0 * GAP, 2.0 * 80.0 + GAP));
        let with_tile = PadGridOptions { add_tile: true, ..o };
        assert_eq!(PadGrid::size_for(&with_tile, 4), PadGrid::size_for(&o, 5), "the add tile takes the next cell");
    }

    #[test]
    fn long_names_are_cut_with_dots_and_short_ones_left_alone() {
        assert_eq!(clip_text("Kick", 10), "Kick");
        assert_eq!(clip_text("Kick_Heavy_808_Layered", 10), "Kick_He...");
        assert_eq!(clip_text("abc", 2), "abc", "too little room to cut sensibly");
    }
}
