//! `DocEditor` — a true multi-page document editor: fixed-size pages with margins, real
//! pagination (paragraphs flow and break across page boundaries at line granularity, not just
//! line-wrapped in one infinite column), per-run font family/size/color/bold/italic, an
//! optional continuous (non-paginated) mode, and a performance model designed so a keystroke's
//! cost doesn't grow with total document length.
//!
//! ## Who builds the toolbar
//! This widget is the page canvas ONLY - no built-in Bold/Italic/font/size/color/load-sample
//! controls. An addon builds its own toolbar out of ordinary `Entropy.UI.Widget.*` widgets
//! (buttons, a dropdown for font family, a numeric input for size, a color input) and drives
//! this widget through `DocEditorCommand`s (`Entropy.UI.Widget.docEditorToggleBold`, etc. on the
//! JS side - see `addon_ops.rs`), applied once at the top of `show()` before input/layout/paint.
//! `DocEditorResponse` reports the current active format back (via the `DOCEDIT_STATS` event)
//! so the addon's own buttons can show correct pressed/current-value state.
//!
//! ## Data model
//! A document is `Vec<Paragraph>`, each paragraph a `Vec<Run>` of (text, format). Enter creates
//! a new paragraph; a paragraph's concatenated run text never contains `\n`, so word-wrap only
//! ever needs to reason about one paragraph's plain text at a time. `RunFormat` carries bold,
//! italic, a font family name (looked up in the engine's ~60-font catalog, `entropy_gui::fonts`
//! - see its own module docs), a point size, and a color - all independently settable per run.
//!
//! ## Performance model
//! Two passes run every frame:
//! - **Reshape** (`ensure_layout`): shapes one paragraph's runs (each against its own font/size)
//!   via a small `fontdue::layout::Layout` driven directly in `layout_paragraph`, cached in
//!   `layout_cache` keyed by paragraph index and invalidated only for paragraphs whose text,
//!   format, or the page's content width actually changed. A keystroke touches exactly one
//!   paragraph, so this costs O(that paragraph's length), not O(document length) - see the "v1
//!   simplifications" note below on what that still doesn't cover.
//! - **Paginate** (`paginate`): walks every already-shaped line's cached height and buckets
//!   lines into pages (or, in continuous mode, one unbounded page). This is O(total lines in
//!   the document), but it's pure arithmetic over already-cached heights (no fontdue/atlas
//!   access at all), so even at a few thousand lines it's microseconds - see
//!   `src/bin/doc_editor_bench.rs` for measured numbers.
//!
//! Both are exposed as plain methods on `DocEditorState` so `doc_editor_bench` can exercise the
//! exact same code path the live widget uses, headlessly (no window/GPU needed - shaping only
//! needs an `entropy_gui::Context` for its `FontRegistry`).
//!
//! ## v1 simplifications (documented, not accidental)
//! - No bold/italic *weight* of any catalog font is loaded - just whichever regular-weight file
//!   the catalog embeds per family name. Bold is a faux double-strike, italic a per-vertex
//!   shear - see `Painter::styled_glyphs`. Real, but not what a shipping word processor would
//!   want for a family that actually ships a bold/italic file.
//! - Only Left/Right/Up/Down/Home/End/Backspace/Delete/Enter + Shift-extend selection are
//!   wired up. No mouse drag-to-select, no copy/paste, no undo.
//! - Format commands (bold/italic/family/size/color) apply to a selection only when it's
//!   within one paragraph (`apply_to_selection_or_active` bails out across paragraph
//!   boundaries) - a documented gap, not a silent one.
//! - Reshaping is per-paragraph, not per-line: a keystroke in a 5,000-character paragraph
//!   reshapes all 5,000 characters, not just the touched line. Fine for normal prose
//!   paragraphs (measured in `doc_editor_bench`); a pathologically long single paragraph would
//!   need real incremental (line-level) reshaping to stay fast.
//! - Continuous (non-paginated) mode still uses `PageConfig`'s width/margin for line-wrapping
//!   and horizontal placement - only the page-*height*-driven page breaking is disabled. There
//!   is no "infinite width" mode.

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::context::{Context, Key};
use crate::entropy_gui::geometry::{pos2, vec2, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::text_layout::ShapedGlyph;
use crate::entropy_gui::ui::Ui;

pub const DOC_FONT_SIZE: f32 = 15.0;
pub const DEFAULT_FONT_NAME: &str = "Figtree";
const LINE_HEIGHT_EXTRA: f32 = 6.0;
const PARA_SPACING: f32 = 8.0;
const PAGE_GAP: f32 = 28.0;

fn prev_char_boundary(s: &str, i: usize) -> usize {
    if i == 0 {
        return 0;
    }
    let mut j = i - 1;
    while j > 0 && !s.is_char_boundary(j) {
        j -= 1;
    }
    j
}
fn next_char_boundary(s: &str, i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    let mut j = i + 1;
    while j < s.len() && !s.is_char_boundary(j) {
        j += 1;
    }
    j
}

#[derive(Clone, Debug, PartialEq)]
pub struct RunFormat {
    pub bold: bool,
    pub italic: bool,
    pub font_name: String,
    pub size: f32,
    pub color: Color32,
}

impl Default for RunFormat {
    fn default() -> Self {
        Self { bold: false, italic: false, font_name: DEFAULT_FONT_NAME.to_string(), size: DOC_FONT_SIZE, color: Color32::from_gray(20) }
    }
}

#[derive(Clone, Debug)]
struct Run {
    text: String,
    format: RunFormat,
}

#[derive(Clone, Debug, Default)]
struct Paragraph {
    runs: Vec<Run>,
}

impl Paragraph {
    fn plain_text(&self) -> String {
        let mut s = String::new();
        for r in &self.runs {
            s.push_str(&r.text);
        }
        s
    }

    fn len(&self) -> usize {
        self.runs.iter().map(|r| r.text.len()).sum()
    }

    fn format_at(&self, offset: usize) -> RunFormat {
        let mut acc = 0;
        for r in &self.runs {
            let end = acc + r.text.len();
            if offset < end {
                return r.format.clone();
            }
            acc = end;
        }
        self.runs.last().map(|r| r.format.clone()).unwrap_or_default()
    }

    /// Inserts `text` (all one format) at byte offset `at`, splitting/merging runs as needed.
    /// The common case - typing continues in a run that already has the active format - is a
    /// single `String::insert_str` with no run-list surgery at all.
    fn insert(&mut self, at: usize, text: &str, format: &RunFormat) {
        if text.is_empty() {
            return;
        }
        if self.runs.is_empty() {
            self.runs.push(Run { text: text.to_string(), format: format.clone() });
            return;
        }
        let mut acc = 0usize;
        for i in 0..self.runs.len() {
            let run_len = self.runs[i].text.len();
            let run_end = acc + run_len;
            if at <= run_end {
                let local = at - acc;
                if self.runs[i].format == *format {
                    self.runs[i].text.insert_str(local, text);
                } else if local == run_len && i + 1 < self.runs.len() && self.runs[i + 1].format == *format {
                    self.runs[i + 1].text.insert_str(0, text);
                } else if local == 0 {
                    self.runs.insert(i, Run { text: text.to_string(), format: format.clone() });
                } else {
                    let tail = self.runs[i].text.split_off(local);
                    let tail_run = Run { text: tail, format: self.runs[i].format.clone() };
                    self.runs.insert(i + 1, Run { text: text.to_string(), format: format.clone() });
                    self.runs.insert(i + 2, tail_run);
                }
                return;
            }
            acc = run_end;
        }
    }

    /// Removes one byte range - every caller here removes exactly one character at a time, so
    /// (unlike `insert`) this never needs to span more than one run.
    fn remove_range(&mut self, start: usize, end: usize) {
        if start >= end {
            return;
        }
        let mut acc = 0usize;
        for i in 0..self.runs.len() {
            let run_len = self.runs[i].text.len();
            let run_end = acc + run_len;
            if start >= acc && end <= run_end {
                let local_start = start - acc;
                let local_end = end - acc;
                self.runs[i].text.replace_range(local_start..local_end, "");
                if self.runs[i].text.is_empty() {
                    self.runs.remove(i);
                }
                return;
            }
            acc = run_end;
        }
    }
}

fn split_run_at(para: &mut Paragraph, at: usize) {
    let mut acc = 0usize;
    for i in 0..para.runs.len() {
        let run_len = para.runs[i].text.len();
        let end = acc + run_len;
        if at > acc && at < end {
            let local = at - acc;
            let tail = para.runs[i].text.split_off(local);
            let fmt = para.runs[i].format.clone();
            para.runs.insert(i + 1, Run { text: tail, format: fmt });
            return;
        }
        if at <= end {
            return;
        }
        acc = end;
    }
}

fn merge_adjacent_runs(para: &mut Paragraph) {
    let mut i = 0;
    while i + 1 < para.runs.len() {
        if para.runs[i].format == para.runs[i + 1].format {
            let next = para.runs.remove(i + 1).text;
            para.runs[i].text.push_str(&next);
        } else {
            i += 1;
        }
    }
    para.runs.retain(|r| !r.text.is_empty());
}

/// Max run size overlapping byte range `[start, end)` - used to size a shaped line by its
/// tallest run, same idea real typesetting uses for mixed-size lines.
fn max_size_in_range(para: &Paragraph, start: usize, end: usize) -> f32 {
    let mut acc = 0usize;
    let mut max_size: Option<f32> = None;
    for r in &para.runs {
        let r_end = acc + r.text.len();
        if acc < end.max(start + 1) && r_end > start {
            max_size = Some(max_size.map_or(r.format.size, |m: f32| m.max(r.format.size)));
        }
        acc = r_end;
    }
    max_size.unwrap_or(DOC_FONT_SIZE)
}

#[derive(Clone, Debug)]
struct ShapedLine {
    /// Positions are relative to the paragraph's own top-left (x already accounts for
    /// word-wrap - each new line's glyphs restart near x=0).
    glyphs: Vec<ShapedGlyph>,
    start_byte: usize,
    /// Exclusive - equals the next line's `start_byte`, or the paragraph's total length for
    /// the last line.
    end_byte: usize,
    width: f32,
    /// This line's own height (tallest run's size + padding) - lines in the same paragraph can
    /// differ if their runs have different font sizes.
    height: f32,
}

#[derive(Clone, Debug)]
pub struct ParagraphLayout {
    lines: Vec<ShapedLine>,
    /// Font names used by this paragraph's runs, in the order `ShapedGlyph::font_index` indexes
    /// into - indices past the end mean the shared emoji/symbol fallback faces. Stored
    /// alongside the shaped lines because painting (a different frame/call than shaping) needs
    /// the same name-to-index mapping to resolve glyphs back to real fonts - see
    /// `Painter::styled_glyphs`.
    face_names: Vec<String>,
}

/// Shapes one paragraph's runs - each against its own font/size - as one continuous,
/// word-wrapped `fontdue::layout::Layout`, so wrapping still flows correctly across a run
/// boundary in the middle of a line (e.g. a bold word followed by a plain one). Glyph byte
/// offsets are corrected to be relative to the whole paragraph's plain text: fontdue's own
/// `byte_offset` restarts at 0 for every `Layout::append` call (confirmed against fontdue
/// 0.9.2's actual source - not documented on docs.rs), so each call's offsets are rebased by
/// `base`, the cumulative length of everything appended so far this call.
fn layout_paragraph(ctx: &Context, para: &Paragraph, content_width: f32) -> ParagraphLayout {
    use fontdue::layout::{CoordinateSystem, Layout, LayoutSettings, TextStyle};

    let mut face_names: Vec<String> = Vec::new();
    for run in &para.runs {
        if !face_names.iter().any(|n| n == &run.format.font_name) {
            face_names.push(run.format.font_name.clone());
        }
    }

    let mut glyphs: Vec<ShapedGlyph> = Vec::new();
    {
        let mut guard = ctx.inner_mut();
        for name in &face_names {
            guard.fonts.ensure_named(name);
        }
        let fallback = guard.fonts.font_for(crate::entropy_gui::geometry::FontFamily::Proportional);
        let mut faces: Vec<&fontdue::Font> = Vec::with_capacity(face_names.len() + 2);
        for name in &face_names {
            faces.push(guard.fonts.get_named(name).unwrap_or(fallback));
        }
        let emoji_idx = faces.len() as u8;
        faces.push(guard.fonts.icon_fallbacks()[0].unwrap_or(fallback));
        let symbol_idx = faces.len() as u8;
        faces.push(guard.fonts.icon_fallbacks()[1].unwrap_or(fallback));

        let mut layout: Layout<()> = Layout::new(CoordinateSystem::PositiveYDown);
        layout.reset(&LayoutSettings { max_width: Some(content_width.max(10.0)), ..LayoutSettings::default() });

        let mut base = 0usize;
        for run in &para.runs {
            if run.text.is_empty() {
                continue;
            }
            let primary_idx = face_names.iter().position(|n| n == &run.format.font_name).unwrap_or(0) as u8;
            let chars: Vec<(usize, char)> = run.text.char_indices().collect();
            let mut sub_start = 0usize;
            let mut sub_face: Option<u8> = None;
            for (pos, &(bi, ch)) in chars.iter().enumerate() {
                let face_here = if faces[primary_idx as usize].lookup_glyph_index(ch) != 0 {
                    primary_idx
                } else if faces[emoji_idx as usize].lookup_glyph_index(ch) != 0 {
                    emoji_idx
                } else if faces[symbol_idx as usize].lookup_glyph_index(ch) != 0 {
                    symbol_idx
                } else {
                    primary_idx
                };
                match sub_face {
                    None => sub_face = Some(face_here),
                    Some(cur) if cur != face_here => {
                        append_sub(&mut layout, &faces, run.format.size, &run.text[sub_start..bi], cur, base + sub_start, &mut glyphs);
                        sub_start = bi;
                        sub_face = Some(face_here);
                    }
                    _ => {}
                }
                if pos == chars.len() - 1 {
                    if let Some(cur) = sub_face {
                        append_sub(&mut layout, &faces, run.format.size, &run.text[sub_start..], cur, base + sub_start, &mut glyphs);
                    }
                }
            }
            base += run.text.len();
        }
        if glyphs.is_empty() {
            // Nothing shaped (all runs empty/absent) - one call still needed for consistent
            // metrics, matching `text_layout::shape_text`'s own empty-text handling.
            layout.append(&faces, &TextStyle { text: "", px: DOC_FONT_SIZE, font_index: 0, user_data: () });
        }
    }

    if glyphs.is_empty() {
        let h = para.runs.first().map(|r| r.format.size).unwrap_or(DOC_FONT_SIZE) + LINE_HEIGHT_EXTRA;
        return ParagraphLayout {
            lines: vec![ShapedLine { glyphs: Vec::new(), start_byte: 0, end_byte: 0, width: 0.0, height: h }],
            face_names,
        };
    }

    // A wrapped line boundary is detected by the pen's x resetting backward, not by watching
    // `g.y`: fontdue reports each glyph's *own* top-left y, which shifts slightly per-glyph
    // with that glyph's individual ascent/descent metrics even within a single visual line
    // (confirmed against fontdue 0.9.2's own docs.rs page for `GlyphPosition::y`: it's each
    // glyph's own bounding-box top, not a shared line baseline) - so a small y-based epsilon
    // produced a false "new line" every couple of characters, and painting each of those at a
    // full line-height step while their x values kept climbing (never reset) drew the text as
    // a descending staircase instead of wrapped paragraphs, a bug caught by actually
    // screenshotting this. x is monotonically non-decreasing within one real line and only
    // resets at an actual wrap, so it's the reliable signal.
    //
    // `finish_line` also re-zeroes every glyph's y to be relative to that line's own top
    // (subtracting the line's minimum y) rather than fontdue's absolute-within-paragraph y -
    // painting adds its own per-line vertical offset (via each line's own `height`), so leaving
    // the absolute y in would double-count it while also carrying over the same per-glyph
    // metric jitter that broke line detection.
    fn finish_line(glyphs: Vec<ShapedGlyph>) -> (usize, f32, Vec<ShapedGlyph>) {
        let start_byte = glyphs.first().unwrap().byte_offset;
        let width = glyphs.iter().fold(0.0f32, |m, g| m.max(g.x));
        let min_y = glyphs.iter().fold(f32::MAX, |m, g| m.min(g.y));
        let glyphs = glyphs.into_iter().map(|mut g| { g.y -= min_y; g }).collect();
        (start_byte, width, glyphs)
    }

    let mut raw_lines: Vec<(usize, f32, Vec<ShapedGlyph>)> = Vec::new();
    let mut current: Vec<ShapedGlyph> = Vec::new();
    let mut prev_x = -1.0f32;
    for g in glyphs {
        if g.x < prev_x - 0.01 && !current.is_empty() {
            raw_lines.push(finish_line(std::mem::take(&mut current)));
        }
        prev_x = g.x;
        current.push(g);
    }
    if !current.is_empty() {
        raw_lines.push(finish_line(current));
    }

    let text_len = para.len();
    let n = raw_lines.len();
    let mut lines: Vec<ShapedLine> = Vec::with_capacity(n);
    for i in 0..n {
        let (start_byte, width, glyphs) = std::mem::replace(&mut raw_lines[i], (0, 0.0, Vec::new()));
        let end_byte = if i + 1 < n { raw_lines[i + 1].0 } else { text_len };
        let height = max_size_in_range(para, start_byte, end_byte.max(start_byte + 1)) + LINE_HEIGHT_EXTRA;
        lines.push(ShapedLine { glyphs, start_byte, end_byte, width, height });
    }

    ParagraphLayout { lines, face_names }
}

fn append_sub(layout: &mut fontdue::layout::Layout<()>, faces: &[&fontdue::Font], px: f32, text: &str, font_index: u8, base_offset: usize, out: &mut Vec<ShapedGlyph>) {
    if text.is_empty() {
        return;
    }
    let before = layout.glyphs().len();
    layout.append(faces, &fontdue::layout::TextStyle { text, px, font_index: font_index as usize, user_data: () });
    for g in &layout.glyphs()[before..] {
        out.push(ShapedGlyph { byte_offset: base_offset + g.byte_offset, x: g.x, y: g.y, raster_config: g.key, font_index: g.font_index as u8 });
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PageConfig {
    pub width: f32,
    pub height: f32,
    pub margin: f32,
}

impl PageConfig {
    /// US Letter at 96 DPI with 1" margins - the default a real word processor opens to.
    pub fn us_letter() -> Self {
        Self { width: 816.0, height: 1056.0, margin: 96.0 }
    }
    pub fn content_width(&self) -> f32 {
        (self.width - 2.0 * self.margin).max(50.0)
    }
    pub fn content_height(&self) -> f32 {
        (self.height - 2.0 * self.margin).max(50.0)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct PageEntry {
    pub para: usize,
    pub line_start: usize,
    pub line_end: usize,
}

#[derive(Clone, Debug, Default)]
pub struct PageLayout {
    pub entries: Vec<PageEntry>,
    pub used_height: f32,
}

/// A command an addon-built toolbar sends in to mutate the document - applied to the current
/// selection if there is one (single-paragraph only, see module docs), otherwise to the format
/// that will be used for whatever's typed next. Queued JS-side (one op per command) and drained
/// once per frame right before `DocEditor::show` runs - see `addon_ops.rs`/`addon_engine.rs`.
#[derive(Clone, Debug)]
pub enum DocEditorCommand {
    ToggleBold,
    ToggleItalic,
    SetFontFamily(String),
    SetFontSize(f32),
    SetColor(Color32),
    /// Turns page-height-driven pagination on/off - off means one continuous, unbounded page
    /// (still wrapped/margined at the page's width) rather than discrete page breaks.
    SetPaginated(bool),
    /// Replaces the whole document with this many synthetic sample paragraphs - for a demo's
    /// "Load Sample" button.
    LoadSample(usize),
}

#[derive(Clone, Debug)]
pub struct DocEditorState {
    paragraphs: Vec<Paragraph>,
    layout_cache: Vec<Option<ParagraphLayout>>,
    cached_content_width: f32,
    cursor_para: usize,
    cursor_off: usize,
    selection_anchor: Option<(usize, usize)>,
    active_format: RunFormat,
    paginated: bool,
    desired_x: Option<f32>,
    scroll_y: f32,
    blink_on: bool,
    blink_timer: f32,
}

impl Default for DocEditorState {
    fn default() -> Self {
        Self {
            paragraphs: vec![Paragraph::default()],
            layout_cache: vec![None],
            cached_content_width: -1.0,
            cursor_para: 0,
            cursor_off: 0,
            selection_anchor: None,
            active_format: RunFormat::default(),
            paginated: true,
            desired_x: None,
            scroll_y: 0.0,
            blink_on: true,
            blink_timer: 0.0,
        }
    }
}

impl DocEditorState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn word_count(&self) -> usize {
        self.paragraphs.iter().map(|p| p.plain_text().split_whitespace().count()).sum()
    }
    pub fn char_count(&self) -> usize {
        self.paragraphs.iter().map(|p| p.len()).sum()
    }
    pub fn paragraph_count(&self) -> usize {
        self.paragraphs.len()
    }
    pub fn is_paginated(&self) -> bool {
        self.paginated
    }
    pub fn active_bold(&self) -> bool {
        self.active_format.bold
    }
    pub fn active_italic(&self) -> bool {
        self.active_format.italic
    }
    pub fn active_font_name(&self) -> &str {
        &self.active_format.font_name
    }
    pub fn active_font_size(&self) -> f32 {
        self.active_format.size
    }
    pub fn active_color(&self) -> Color32 {
        self.active_format.color
    }

    pub fn set_cursor(&mut self, para: usize, offset: usize) {
        let para = para.min(self.paragraphs.len().saturating_sub(1));
        let offset = offset.min(self.paragraphs[para].len());
        self.cursor_para = para;
        self.cursor_off = offset;
        self.selection_anchor = None;
        self.desired_x = None;
    }

    fn invalidate(&mut self, idx: usize) {
        if idx < self.layout_cache.len() {
            self.layout_cache[idx] = None;
        }
    }

    pub fn insert_char(&mut self, ch: char) {
        let mut buf = [0u8; 4];
        let s = ch.encode_utf8(&mut buf);
        let (p, o) = (self.cursor_para, self.cursor_off);
        self.paragraphs[p].insert(o, s, &self.active_format.clone());
        self.cursor_off += s.len();
        self.invalidate(p);
        self.desired_x = None;
    }

    pub fn insert_str(&mut self, text: &str) {
        for ch in text.chars() {
            self.insert_char(ch);
        }
    }

    pub fn enter(&mut self) {
        let (p, o) = (self.cursor_para, self.cursor_off);
        let mut right_runs: Vec<Run> = Vec::new();
        {
            let para = &mut self.paragraphs[p];
            let mut acc = 0usize;
            let mut i = 0;
            while i < para.runs.len() {
                let run_len = para.runs[i].text.len();
                let run_end = acc + run_len;
                if o < run_end {
                    let local = o - acc;
                    if local > 0 {
                        let tail = para.runs[i].text.split_off(local);
                        right_runs.push(Run { text: tail, format: para.runs[i].format.clone() });
                        i += 1;
                    }
                    right_runs.extend(para.runs.drain(i..));
                    break;
                }
                acc = run_end;
                i += 1;
            }
        }
        self.paragraphs.insert(p + 1, Paragraph { runs: right_runs });
        self.layout_cache.insert(p + 1, None);
        self.invalidate(p);
        self.cursor_para = p + 1;
        self.cursor_off = 0;
        self.selection_anchor = None;
        self.desired_x = None;
    }

    pub fn backspace(&mut self) {
        let (p, o) = (self.cursor_para, self.cursor_off);
        if o > 0 {
            let text = self.paragraphs[p].plain_text();
            let prev = prev_char_boundary(&text, o);
            self.paragraphs[p].remove_range(prev, o);
            self.cursor_off = prev;
            self.invalidate(p);
        } else if p > 0 {
            let prev_len = self.paragraphs[p - 1].len();
            let runs = std::mem::take(&mut self.paragraphs[p].runs);
            self.paragraphs[p - 1].runs.extend(runs);
            self.paragraphs.remove(p);
            self.layout_cache.remove(p);
            self.invalidate(p - 1);
            self.cursor_para = p - 1;
            self.cursor_off = prev_len;
        }
        self.selection_anchor = None;
        self.desired_x = None;
    }

    pub fn delete_forward(&mut self) {
        let (p, o) = (self.cursor_para, self.cursor_off);
        let len = self.paragraphs[p].len();
        if o < len {
            let text = self.paragraphs[p].plain_text();
            let next = next_char_boundary(&text, o);
            self.paragraphs[p].remove_range(o, next);
            self.invalidate(p);
        } else if p + 1 < self.paragraphs.len() {
            let runs = std::mem::take(&mut self.paragraphs[p + 1].runs);
            self.paragraphs[p].runs.extend(runs);
            self.paragraphs.remove(p + 1);
            self.layout_cache.remove(p + 1);
            self.invalidate(p);
        }
        self.selection_anchor = None;
        self.desired_x = None;
    }

    fn begin_selection(&mut self, extend: bool) {
        if extend {
            if self.selection_anchor.is_none() {
                self.selection_anchor = Some((self.cursor_para, self.cursor_off));
            }
        } else {
            self.selection_anchor = None;
        }
    }

    pub fn move_left(&mut self, extend: bool) {
        self.begin_selection(extend);
        let (p, o) = (self.cursor_para, self.cursor_off);
        if o > 0 {
            let text = self.paragraphs[p].plain_text();
            self.cursor_off = prev_char_boundary(&text, o);
        } else if p > 0 {
            self.cursor_para = p - 1;
            self.cursor_off = self.paragraphs[p - 1].len();
        }
        self.desired_x = None;
    }

    pub fn move_right(&mut self, extend: bool) {
        self.begin_selection(extend);
        let (p, o) = (self.cursor_para, self.cursor_off);
        let len = self.paragraphs[p].len();
        if o < len {
            let text = self.paragraphs[p].plain_text();
            self.cursor_off = next_char_boundary(&text, o);
        } else if p + 1 < self.paragraphs.len() {
            self.cursor_para = p + 1;
            self.cursor_off = 0;
        }
        self.desired_x = None;
    }

    fn ensure_layout(&mut self, ctx: &Context, page: PageConfig, idx: usize) {
        let cw = page.content_width();
        if (self.cached_content_width - cw).abs() > 0.5 {
            for c in self.layout_cache.iter_mut() {
                *c = None;
            }
            self.cached_content_width = cw;
        }
        if self.layout_cache[idx].is_none() {
            let layout = layout_paragraph(ctx, &self.paragraphs[idx], cw);
            self.layout_cache[idx] = Some(layout);
        }
    }

    /// Reshapes every paragraph whose cache is stale (dirty from an edit, or never shaped) -
    /// cheap for everything else, since `ensure_layout` no-ops on an already-cached paragraph.
    pub fn ensure_all_layout(&mut self, ctx: &Context, page: PageConfig) {
        for i in 0..self.paragraphs.len() {
            self.ensure_layout(ctx, page, i);
        }
    }

    fn line_index_at(&self, para: usize, offset: usize) -> usize {
        let layout = self.layout_cache[para].as_ref().unwrap();
        layout
            .lines
            .iter()
            .position(|l| offset >= l.start_byte && offset <= l.end_byte)
            .unwrap_or(layout.lines.len().saturating_sub(1))
    }

    fn cursor_x(&self, para: usize) -> f32 {
        let layout = self.layout_cache[para].as_ref().unwrap();
        let off = self.cursor_off;
        if let Some(line) = layout.lines.iter().find(|l| off >= l.start_byte && off <= l.end_byte) {
            if let Some(g) = line.glyphs.iter().find(|g| g.byte_offset == off) {
                return g.x;
            }
            return line.width;
        }
        0.0
    }

    fn byte_at_x(&self, para: usize, line_idx: usize, x: f32) -> usize {
        let layout = self.layout_cache[para].as_ref().unwrap();
        let Some(line) = layout.lines.get(line_idx) else { return 0 };
        if x >= line.width {
            return line.end_byte;
        }
        let mut best = line.start_byte;
        let mut best_dist = f32::MAX;
        for g in &line.glyphs {
            let d = (g.x - x).abs();
            if d < best_dist {
                best_dist = d;
                best = g.byte_offset;
            }
        }
        best
    }

    pub fn move_home(&mut self, ctx: &Context, page: PageConfig, extend: bool) {
        self.begin_selection(extend);
        let p = self.cursor_para;
        self.ensure_layout(ctx, page, p);
        let li = self.line_index_at(p, self.cursor_off);
        self.cursor_off = self.layout_cache[p].as_ref().unwrap().lines[li].start_byte;
        self.desired_x = None;
    }

    pub fn move_end(&mut self, ctx: &Context, page: PageConfig, extend: bool) {
        self.begin_selection(extend);
        let p = self.cursor_para;
        self.ensure_layout(ctx, page, p);
        let li = self.line_index_at(p, self.cursor_off);
        self.cursor_off = self.layout_cache[p].as_ref().unwrap().lines[li].end_byte;
        self.desired_x = None;
    }

    pub fn move_vertical(&mut self, ctx: &Context, page: PageConfig, up: bool, extend: bool) {
        self.begin_selection(extend);
        let p = self.cursor_para;
        self.ensure_layout(ctx, page, p);
        let x = self.desired_x.unwrap_or_else(|| self.cursor_x(p));
        self.desired_x = Some(x);
        let line_idx = self.line_index_at(p, self.cursor_off);
        let n_lines = self.layout_cache[p].as_ref().unwrap().lines.len();

        if up {
            if line_idx > 0 {
                self.cursor_off = self.byte_at_x(p, line_idx - 1, x);
            } else if p > 0 {
                let prev = p - 1;
                self.ensure_layout(ctx, page, prev);
                let last_line = self.layout_cache[prev].as_ref().unwrap().lines.len().saturating_sub(1);
                self.cursor_para = prev;
                self.cursor_off = self.byte_at_x(prev, last_line, x);
            }
        } else if line_idx + 1 < n_lines {
            self.cursor_off = self.byte_at_x(p, line_idx + 1, x);
        } else if p + 1 < self.paragraphs.len() {
            let next = p + 1;
            self.ensure_layout(ctx, page, next);
            self.cursor_para = next;
            self.cursor_off = self.byte_at_x(next, 0, x);
        }
    }

    fn selection_bounds(&self) -> Option<((usize, usize), (usize, usize))> {
        let anchor = self.selection_anchor?;
        let mut a = anchor;
        let mut b = (self.cursor_para, self.cursor_off);
        if b < a {
            std::mem::swap(&mut a, &mut b);
        }
        if a.0 != b.0 || a.1 == b.1 {
            return None; // v1: single-paragraph, non-empty selections only, see module docs.
        }
        Some((a, b))
    }

    fn selection_all_has(&self, a: (usize, usize), b: (usize, usize), bold_flag: bool, italic_flag: bool) -> bool {
        let (start, end) = (a.1, b.1);
        let mut acc = 0usize;
        for r in &self.paragraphs[a.0].runs {
            let r_end = acc + r.text.len();
            let overlap_start = start.max(acc);
            let overlap_end = end.min(r_end);
            if overlap_start < overlap_end {
                if bold_flag && !r.format.bold {
                    return false;
                }
                if italic_flag && !r.format.italic {
                    return false;
                }
            }
            acc = r_end;
        }
        true
    }

    /// Applies `mutate` to every run fully inside the current selection (splitting at its
    /// boundaries first), or to `active_format` (what gets used for text typed next) if there
    /// is no selection. Selections spanning more than one paragraph are a no-op - see module
    /// docs.
    fn apply_to_selection_or_active(&mut self, mutate: impl Fn(&mut RunFormat)) {
        if let Some((a, b)) = self.selection_bounds() {
            let p = a.0;
            let (start, end) = (a.1, b.1);
            let para = &mut self.paragraphs[p];
            split_run_at(para, start);
            split_run_at(para, end);
            let mut acc = 0usize;
            for r in para.runs.iter_mut() {
                let r_end = acc + r.text.len();
                if acc >= start && r_end <= end {
                    mutate(&mut r.format);
                }
                acc = r_end;
            }
            merge_adjacent_runs(para);
            self.invalidate(p);
        } else {
            mutate(&mut self.active_format);
        }
    }

    fn toggle_format(&mut self, bold: bool, italic: bool) {
        match self.selection_bounds() {
            Some((a, b)) => {
                let new_val = !self.selection_all_has(a, b, bold, italic);
                self.apply_to_selection_or_active(|f| {
                    if bold {
                        f.bold = new_val;
                    }
                    if italic {
                        f.italic = new_val;
                    }
                });
            }
            None => {
                if bold {
                    self.active_format.bold = !self.active_format.bold;
                }
                if italic {
                    self.active_format.italic = !self.active_format.italic;
                }
            }
        }
    }
    pub fn toggle_bold(&mut self) {
        self.toggle_format(true, false);
    }
    pub fn toggle_italic(&mut self) {
        self.toggle_format(false, true);
    }
    pub fn set_font_family(&mut self, name: String) {
        self.apply_to_selection_or_active(move |f| f.font_name = name.clone());
    }
    pub fn set_font_size(&mut self, size: f32) {
        let size = size.clamp(4.0, 200.0);
        self.apply_to_selection_or_active(move |f| f.size = size);
    }
    pub fn set_color(&mut self, color: Color32) {
        self.apply_to_selection_or_active(move |f| f.color = color);
    }
    pub fn set_paginated(&mut self, paginated: bool) {
        self.paginated = paginated;
    }

    pub fn apply_command(&mut self, command: &DocEditorCommand) {
        match command {
            DocEditorCommand::ToggleBold => self.toggle_bold(),
            DocEditorCommand::ToggleItalic => self.toggle_italic(),
            DocEditorCommand::SetFontFamily(name) => self.set_font_family(name.clone()),
            DocEditorCommand::SetFontSize(size) => self.set_font_size(*size),
            DocEditorCommand::SetColor(color) => self.set_color(*color),
            DocEditorCommand::SetPaginated(v) => self.set_paginated(*v),
            DocEditorCommand::LoadSample(count) => self.seed_sample(*count),
        }
    }

    /// Buckets already-shaped lines into pages. O(total lines), no shaping. In continuous
    /// (`paginated == false`) mode, content height is treated as unbounded, so this always
    /// returns exactly one `PageLayout` holding the whole document.
    pub fn paginate(&self, page: PageConfig) -> Vec<PageLayout> {
        let content_h = if self.paginated { page.content_height() } else { f32::INFINITY };
        let mut pages: Vec<PageLayout> = Vec::new();
        let mut cur = PageLayout::default();
        for (pi, layout) in self.layout_cache.iter().enumerate() {
            let Some(layout) = layout else { continue };
            for (li, line) in layout.lines.iter().enumerate() {
                if cur.used_height > 0.0 && cur.used_height + line.height > content_h {
                    pages.push(std::mem::take(&mut cur));
                }
                if let Some(last) = cur.entries.last_mut() {
                    if last.para == pi && last.line_end == li {
                        last.line_end = li + 1;
                        cur.used_height += line.height;
                        continue;
                    }
                }
                cur.entries.push(PageEntry { para: pi, line_start: li, line_end: li + 1 });
                cur.used_height += line.height;
            }
            cur.used_height += PARA_SPACING;
        }
        if !cur.entries.is_empty() || pages.is_empty() {
            pages.push(cur);
        }
        pages
    }

    /// (top-of-page, height) in document space for every page `paginate` returned - uniform
    /// `page.height` steps in paginated mode, or a single page sized to its own content in
    /// continuous mode. Used for scroll clamping, visible-range culling, and click mapping so
    /// both modes share one code path in `DocEditor::show`.
    pub fn page_metrics(&self, pages: &[PageLayout], page: PageConfig) -> Vec<(f32, f32)> {
        if self.paginated {
            (0..pages.len()).map(|i| (i as f32 * (page.height + PAGE_GAP), page.height)).collect()
        } else {
            let h = pages.first().map(|p| p.used_height).unwrap_or(0.0) + 2.0 * page.margin;
            vec![(0.0, h.max(page.height))]
        }
    }

    fn layout_ref(&self, idx: usize) -> &ParagraphLayout {
        self.layout_cache[idx].as_ref().expect("ensure_all_layout must run before painting/hit-testing")
    }

    fn paragraph_format_at(&self, idx: usize, offset: usize) -> RunFormat {
        self.paragraphs[idx].format_at(offset)
    }

    /// Maps a click at `(local_x, local_y)` inside page `page_idx`'s content box to a
    /// (paragraph, byte offset) cursor position.
    pub fn hit_test(&self, pages: &[PageLayout], page_idx: usize, local_x: f32, local_y: f32) -> Option<(usize, usize)> {
        let page = pages.get(page_idx)?;
        let mut y = 0.0f32;
        let mut last = None;
        for entry in &page.entries {
            let layout = self.layout_cache[entry.para].as_ref()?;
            for li in entry.line_start..entry.line_end {
                let line = &layout.lines[li];
                if local_y >= y && local_y < y + line.height {
                    return Some((entry.para, self.byte_at_x(entry.para, li, local_x)));
                }
                last = Some((entry.para, line.end_byte));
                y += line.height;
            }
            y += PARA_SPACING;
        }
        last
    }

    /// Replaces the whole document with `count` synthetic paragraphs of varying length - see
    /// `DocEditorCommand::LoadSample` and `doc_editor_bench`.
    pub fn seed_sample(&mut self, count: usize) {
        const WORDS: &[&str] = &[
            "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "entropy", "engine",
            "renders", "pages", "of", "text", "with", "real", "pagination", "margins", "and",
            "incremental", "layout", "caching", "so", "keystrokes", "stay", "fast", "even", "in",
            "a", "very", "long", "document", "that", "spans", "many", "printed", "pages", "worth",
            "of", "content", "for", "testing",
        ];
        self.paragraphs.clear();
        self.layout_cache.clear();
        for i in 0..count.max(1) {
            let mut text = String::new();
            let len = 40 + (i * 7) % 60;
            for w in 0..len {
                if w > 0 {
                    text.push(' ');
                }
                text.push_str(WORDS[(i * 13 + w) % WORDS.len()]);
            }
            text.push('.');
            self.paragraphs.push(Paragraph { runs: vec![Run { text, format: RunFormat::default() }] });
            self.layout_cache.push(None);
        }
        self.cursor_para = 0;
        self.cursor_off = 0;
        self.selection_anchor = None;
        self.cached_content_width = -1.0;
    }
}

pub struct DocEditorResponse {
    pub word_count: usize,
    pub char_count: usize,
    pub page_count: usize,
    pub paginated: bool,
    pub active_bold: bool,
    pub active_italic: bool,
    pub active_font_name: String,
    pub active_font_size: f32,
    pub active_color: Color32,
}

pub struct DocEditor {
    id: Id,
}

impl DocEditor {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("doc_editor").with(id_salt) }
    }

    /// `commands` are applied once, in order, before input handling/layout/paint - see the
    /// module docs' "who builds the toolbar" section. This widget draws only the paginated (or
    /// continuous) page canvas; every control is the caller's own.
    pub fn show(self, ui: &mut Ui, page: PageConfig, commands: &[DocEditorCommand]) -> DocEditorResponse {
        let ctx = ui.ctx().clone();
        let id = self.id;
        let mut state = ctx.memory_mut(|m| m.take_doc_editor(id));

        for command in commands {
            state.apply_command(command);
        }

        let region = ui.available_rect_before_wrap();
        let (canvas_response, painter) = ui.allocate_painter(region.size(), Sense::click_and_drag());
        let canvas_rect = canvas_response.rect;

        if canvas_response.clicked() {
            ctx.memory_mut(|m| m.focused = Some(id));
        }
        let is_focused = ctx.memory(|m| m.focused) == Some(id);

        let pointer_pos = ui.input(|i| i.pointer.pos);
        let over_canvas = pointer_pos.map_or(false, |p| canvas_rect.contains(p));
        let scroll = ui.input(|i| i.scroll_delta.y);
        if over_canvas && scroll.abs() > 0.0 {
            state.scroll_y -= scroll;
        }

        if is_focused {
            let (typed, key_events) = ui.input(|i| (i.text_input.clone(), i.key_events.clone()));
            if !typed.is_empty() {
                state.insert_str(&typed);
            }
            for ev in key_events {
                if !ev.pressed {
                    continue;
                }
                let shift = ev.modifiers.shift;
                match ev.key {
                    Key::Backspace => state.backspace(),
                    Key::Delete => state.delete_forward(),
                    Key::Enter => state.enter(),
                    Key::ArrowLeft => state.move_left(shift),
                    Key::ArrowRight => state.move_right(shift),
                    Key::ArrowUp => state.move_vertical(&ctx, page, true, shift),
                    Key::ArrowDown => state.move_vertical(&ctx, page, false, shift),
                    Key::Home => state.move_home(&ctx, page, shift),
                    Key::End => state.move_end(&ctx, page, shift),
                    _ => {}
                }
            }
        }

        state.ensure_all_layout(&ctx, page);
        let pages = state.paginate(page);
        let metrics = state.page_metrics(&pages, page);
        let doc_total_h = metrics.last().map(|(top, h)| top + h).unwrap_or(0.0);
        let max_scroll = (doc_total_h - canvas_rect.height()).max(0.0);
        state.scroll_y = state.scroll_y.clamp(0.0, max_scroll);

        // Gated on `clicked()`, not `interact_pointer_pos()` - the latter is `Some` on every
        // frame the pointer merely hovers the canvas (see `ui::interact`), not just the frame
        // of an actual click. Using it unconditionally re-ran hit-testing (and reset the
        // cursor to wherever the mouse happened to be sitting) on every single frame after
        // the first click, which scrambled typed text as the paragraph reflowed underneath a
        // stationary pointer - caught by actually typing into a running window, not just by
        // the app failing to crash.
        let clicked_pos = canvas_response.clicked().then(|| canvas_response.interact_pointer_pos()).flatten().and_then(|p| {
            let doc_y = p.y - canvas_rect.min.y + state.scroll_y;
            let page_idx = metrics.iter().position(|(top, h)| doc_y >= *top && doc_y < top + h)?;
            let (page_top, _) = metrics[page_idx];
            let local_y = doc_y - page_top - page.margin;
            let page_x0 = canvas_rect.min.x + ((canvas_rect.width() - page.width) / 2.0).max(0.0);
            let local_x = p.x - page_x0 - page.margin;
            Some((page_idx, local_x, local_y))
        });

        for (page_idx, (page_top_doc_y, page_h)) in metrics.iter().enumerate() {
            if page_idx >= pages.len() {
                break;
            }
            let page_top_screen_y = canvas_rect.min.y + page_top_doc_y - state.scroll_y;
            if page_top_screen_y > canvas_rect.max.y || page_top_screen_y + page_h < canvas_rect.min.y {
                continue;
            }
            let page_x0 = canvas_rect.min.x + ((canvas_rect.width() - page.width) / 2.0).max(0.0);
            let page_rect = Rect::from_min_size(pos2(page_x0, page_top_screen_y), vec2(page.width, *page_h));

            painter.rect_filled(page_rect, 2u8, Color32::from_gray(248));
            painter.rect_stroke(page_rect, 2u8, Stroke::new(1.0, Color32::from_gray(60)), StrokeKind::Middle);

            let content_origin = pos2(page_rect.min.x + page.margin, page_rect.min.y + page.margin);
            let clipped = painter.with_clip_rect(page_rect.intersect(canvas_rect));
            let mut y = 0.0f32;
            for entry in &pages[page_idx].entries {
                let layout = state.layout_ref(entry.para);
                for li in entry.line_start..entry.line_end {
                    let line = &layout.lines[li];
                    let origin = pos2(content_origin.x, content_origin.y + y);
                    clipped.styled_glyphs(origin, &line.glyphs, &layout.face_names, |off| {
                        let f = state.paragraph_format_at(entry.para, off);
                        (f.bold, f.italic, f.color)
                    });

                    if is_focused
                        && state.selection_anchor.is_none()
                        && state.cursor_para == entry.para
                        && state.blink_on
                        && state.cursor_off >= line.start_byte
                        && state.cursor_off <= line.end_byte
                    {
                        let cx = state.cursor_x(entry.para);
                        let caret_h = line.height - LINE_HEIGHT_EXTRA * 0.5;
                        clipped.line_segment(
                            [pos2(origin.x + cx, origin.y), pos2(origin.x + cx, origin.y + caret_h)],
                            Stroke::new(1.5, Color32::from_rgb(20, 20, 200)),
                        );
                    }
                    y += line.height;
                }
                y += PARA_SPACING;
            }

            if let Some((cp_page, lx, ly)) = clicked_pos {
                if cp_page == page_idx {
                    if let Some((cp, co)) = state.hit_test(&pages, page_idx, lx, ly) {
                        state.set_cursor(cp, co);
                    }
                }
            }
        }

        state.blink_timer += ui.input(|i| i.dt);
        if state.blink_timer > 0.53 {
            state.blink_timer = 0.0;
            state.blink_on = !state.blink_on;
        }

        let response = DocEditorResponse {
            word_count: state.word_count(),
            char_count: state.char_count(),
            page_count: pages.len(),
            paginated: state.is_paginated(),
            active_bold: state.active_bold(),
            active_italic: state.active_italic(),
            active_font_name: state.active_font_name().to_string(),
            active_font_size: state.active_font_size(),
            active_color: state.active_color(),
        };
        ctx.memory_mut(|m| m.put_doc_editor(id, state));
        response
    }
}
