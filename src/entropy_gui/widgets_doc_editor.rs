//! `DocEditor` — a true multi-page document editor: fixed-size pages with margins, real
//! pagination (paragraphs flow and break across page boundaries at line granularity, not just
//! line-wrapped in one infinite column), basic bold/italic formatting, and a performance model
//! designed so a keystroke's cost doesn't grow with total document length.
//!
//! ## Data model
//! A document is `Vec<Paragraph>`, each paragraph a `Vec<Run>` of (text, format). Enter creates
//! a new paragraph; a paragraph's concatenated run text never contains `\n`, so word-wrap only
//! ever needs to reason about one paragraph's plain text at a time.
//!
//! ## Performance model
//! Two passes run every frame:
//! - **Reshape** (`ensure_layout`): fontdue shaping of one paragraph's text via
//!   `text_layout::shape_text`, cached in `layout_cache` keyed by paragraph index and
//!   invalidated only for paragraphs whose text, format, or the page's content width actually
//!   changed. A keystroke touches exactly one paragraph, so this costs O(that paragraph's
//!   length), not O(document length) - see the "v1 simplifications" note below on what that
//!   still doesn't cover.
//! - **Paginate** (`paginate`): walks every already-shaped line's cached height and buckets
//!   lines into pages. This is O(total lines in the document), but it's pure arithmetic over
//!   already-cached heights (no fontdue/atlas access at all), so even at a few thousand lines
//!   it's microseconds - see `src/bin/doc_editor_bench.rs` for measured numbers.
//!
//! Both are exposed as plain methods on `DocEditorState` so `doc_editor_bench` can exercise the
//! exact same code path the live widget uses, headlessly (no window/GPU needed - `shape_text`
//! only needs an `entropy_gui::Context` for its `FontRegistry`).
//!
//! ## v1 simplifications (documented, not accidental)
//! - No true bold/italic font faces exist in this engine (`entropy_gui::fonts` loads exactly
//!   one proportional face). Bold is a faux double-strike, italic a per-vertex shear - see
//!   `Painter::styled_glyphs`. Real, but not what a shipping word processor would want.
//! - Only Left/Right/Up/Down/Home/End/Backspace/Delete/Enter + Shift-extend selection are
//!   wired up. No mouse drag-to-select, no copy/paste, no undo.
//! - Bold/Italic toolbar buttons apply to a selection only when it's within one paragraph
//!   (`apply_format_range` bails out across paragraph boundaries) - a documented gap, not a
//!   silent one.
//! - Reshaping is per-paragraph, not per-line: a keystroke in a 5,000-character paragraph
//!   reshapes all 5,000 characters, not just the touched line. Fine for normal prose
//!   paragraphs (measured in `doc_editor_bench`); a pathologically long single paragraph would
//!   need real incremental (line-level) reshaping to stay fast.

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::context::{Context, Key};
use crate::entropy_gui::geometry::{pos2, vec2, FontFamily, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::text_layout::{shape_text, ShapedGlyph};
use crate::entropy_gui::ui::Ui;

pub const DOC_FONT_SIZE: f32 = 15.0;
const LINE_HEIGHT_EXTRA: f32 = 6.0;
const LINE_HEIGHT: f32 = DOC_FONT_SIZE + LINE_HEIGHT_EXTRA;
const PARA_SPACING: f32 = 8.0;
const PAGE_GAP: f32 = 28.0;
const TOOLBAR_H: f32 = 30.0;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct RunFormat {
    pub bold: bool,
    pub italic: bool,
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
                return r.format;
            }
            acc = end;
        }
        self.runs.last().map(|r| r.format).unwrap_or_default()
    }

    /// Inserts `text` (all one format) at byte offset `at`, splitting/merging runs as needed.
    /// The common case - typing continues in a run that already has the active format - is a
    /// single `String::insert_str` with no run-list surgery at all.
    fn insert(&mut self, at: usize, text: &str, format: RunFormat) {
        if text.is_empty() {
            return;
        }
        if self.runs.is_empty() {
            self.runs.push(Run { text: text.to_string(), format });
            return;
        }
        let mut acc = 0usize;
        for i in 0..self.runs.len() {
            let run_len = self.runs[i].text.len();
            let run_end = acc + run_len;
            if at <= run_end {
                let local = at - acc;
                if self.runs[i].format == format {
                    self.runs[i].text.insert_str(local, text);
                } else if local == run_len && i + 1 < self.runs.len() && self.runs[i + 1].format == format {
                    self.runs[i + 1].text.insert_str(0, text);
                } else if local == 0 {
                    self.runs.insert(i, Run { text: text.to_string(), format });
                } else {
                    let tail = self.runs[i].text.split_off(local);
                    let tail_run = Run { text: tail, format: self.runs[i].format };
                    self.runs.insert(i + 1, Run { text: text.to_string(), format });
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
            let fmt = para.runs[i].format;
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
}

#[derive(Clone, Debug)]
pub struct ParagraphLayout {
    lines: Vec<ShapedLine>,
}

fn layout_paragraph(ctx: &Context, para: &Paragraph, content_width: f32) -> ParagraphLayout {
    let text = para.plain_text();
    let shaped = {
        let mut guard = ctx.inner_mut();
        let face_set = guard.fonts.shaping_set(FontFamily::Proportional);
        shape_text(face_set, DOC_FONT_SIZE, Some(content_width.max(10.0)), &text)
    };

    if shaped.glyphs.is_empty() {
        return ParagraphLayout { lines: vec![ShapedLine { glyphs: Vec::new(), start_byte: 0, end_byte: 0, width: 0.0 }] };
    }

    // A wrapped line boundary is detected by the pen's x resetting backward, not by watching
    // `g.y`: fontdue reports each glyph's *own* top-left y, which shifts slightly per-glyph
    // with that glyph's individual ascent/descent metrics even within a single visual line
    // (a bug caught by actually screenshotting this - see the doc editor post's failure
    // notes) - so a small y-based epsilon produced a false "new line" every couple of
    // characters, and painting each of those at a full line-height step while their x values
    // kept climbing (never reset) drew the text as a descending staircase instead of wrapped
    // paragraphs. x is monotonically non-decreasing within one real line and only resets at
    // an actual wrap, so it's the reliable signal.
    //
    // `finish_line` also re-zeroes every glyph's y to be relative to that line's own top
    // (subtracting the line's minimum y) rather than fontdue's absolute-within-paragraph y -
    // painting adds its own per-line vertical offset (`LINE_HEIGHT * line_index`), so leaving
    // the absolute y in would double-count it while also carrying over the same per-glyph
    // metric jitter that broke line detection.
    fn finish_line(glyphs: Vec<ShapedGlyph>) -> ShapedLine {
        let start_byte = glyphs.first().unwrap().byte_offset;
        let width = glyphs.iter().fold(0.0f32, |m, g| m.max(g.x));
        let min_y = glyphs.iter().fold(f32::MAX, |m, g| m.min(g.y));
        let glyphs = glyphs.into_iter().map(|mut g| { g.y -= min_y; g }).collect();
        ShapedLine { glyphs, start_byte, end_byte: 0, width }
    }

    let mut lines: Vec<ShapedLine> = Vec::new();
    let mut current: Vec<ShapedGlyph> = Vec::new();
    let mut prev_x = -1.0f32;
    for g in shaped.glyphs {
        if g.x < prev_x - 0.01 && !current.is_empty() {
            lines.push(finish_line(std::mem::take(&mut current)));
        }
        prev_x = g.x;
        current.push(g);
    }
    if !current.is_empty() {
        lines.push(finish_line(current));
    }

    let n = lines.len();
    for i in 0..n {
        lines[i].end_byte = if i + 1 < n { lines[i + 1].start_byte } else { text.len() };
    }
    ParagraphLayout { lines }
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

#[derive(Clone, Debug)]
pub struct DocEditorState {
    paragraphs: Vec<Paragraph>,
    layout_cache: Vec<Option<ParagraphLayout>>,
    cached_content_width: f32,
    cursor_para: usize,
    cursor_off: usize,
    selection_anchor: Option<(usize, usize)>,
    active_format: RunFormat,
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
        let format = self.active_format;
        let (p, o) = (self.cursor_para, self.cursor_off);
        self.paragraphs[p].insert(o, s, format);
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
                        right_runs.push(Run { text: tail, format: para.runs[i].format });
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

    fn selection_all_has(&self, a: (usize, usize), b: (usize, usize), bold_flag: bool, italic_flag: bool) -> bool {
        if a.0 != b.0 {
            return false;
        }
        let (start, end) = (a.1.min(b.1), a.1.max(b.1));
        if start >= end {
            return true;
        }
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

    fn apply_format_range(&mut self, a: (usize, usize), b: (usize, usize), bold_flag: bool, italic_flag: bool, new_val: bool) {
        if a.0 != b.0 {
            return; // v1: single-paragraph formatting only, see module docs.
        }
        let p = a.0;
        let (start, end) = (a.1.min(b.1), a.1.max(b.1));
        if start == end {
            return;
        }
        let para = &mut self.paragraphs[p];
        split_run_at(para, start);
        split_run_at(para, end);
        let mut acc = 0usize;
        for r in para.runs.iter_mut() {
            let r_end = acc + r.text.len();
            if acc >= start && r_end <= end {
                if bold_flag {
                    r.format.bold = new_val;
                }
                if italic_flag {
                    r.format.italic = new_val;
                }
            }
            acc = r_end;
        }
        merge_adjacent_runs(para);
        self.invalidate(p);
    }

    fn toggle_format(&mut self, bold: bool, italic: bool) {
        if let Some(anchor) = self.selection_anchor {
            let mut a = anchor;
            let mut b = (self.cursor_para, self.cursor_off);
            if b < a {
                std::mem::swap(&mut a, &mut b);
            }
            let all_set = self.selection_all_has(a, b, bold, italic);
            self.apply_format_range(a, b, bold, italic, !all_set);
        } else {
            if bold {
                self.active_format.bold = !self.active_format.bold;
            }
            if italic {
                self.active_format.italic = !self.active_format.italic;
            }
        }
    }
    pub fn toggle_bold(&mut self) {
        self.toggle_format(true, false);
    }
    pub fn toggle_italic(&mut self) {
        self.toggle_format(false, true);
    }
    pub fn active_bold(&self) -> bool {
        self.active_format.bold
    }
    pub fn active_italic(&self) -> bool {
        self.active_format.italic
    }

    /// Buckets already-shaped lines into fixed-height pages. O(total lines), no shaping.
    pub fn paginate(&self, page: PageConfig) -> Vec<PageLayout> {
        let content_h = page.content_height();
        let mut pages = Vec::new();
        let mut cur = PageLayout::default();
        for (pi, layout) in self.layout_cache.iter().enumerate() {
            let Some(layout) = layout else { continue };
            let n_lines = layout.lines.len().max(1);
            let mut line_start = 0usize;
            while line_start < n_lines {
                let remaining = content_h - cur.used_height;
                let max_fit = (remaining / LINE_HEIGHT).floor().max(0.0) as usize;
                if max_fit == 0 && cur.used_height > 0.0 {
                    pages.push(std::mem::take(&mut cur));
                    continue;
                }
                let take = max_fit.max(1).min(n_lines - line_start);
                cur.entries.push(PageEntry { para: pi, line_start, line_end: line_start + take });
                cur.used_height += take as f32 * LINE_HEIGHT;
                line_start += take;
            }
            cur.used_height += PARA_SPACING;
        }
        if !cur.entries.is_empty() || pages.is_empty() {
            pages.push(cur);
        }
        pages
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
                if local_y >= y && local_y < y + LINE_HEIGHT {
                    return Some((entry.para, self.byte_at_x(entry.para, li, local_x)));
                }
                last = Some((entry.para, line.end_byte));
                y += LINE_HEIGHT;
            }
            y += PARA_SPACING;
        }
        last
    }

    /// Replaces the whole document with `count` synthetic paragraphs of varying length - used
    /// by the "Load Sample" toolbar button and `doc_editor_bench`.
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
}

pub struct DocEditor {
    id: Id,
}

impl DocEditor {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("doc_editor").with(id_salt) }
    }

    pub fn show(self, ui: &mut Ui, page: PageConfig) -> DocEditorResponse {
        let ctx = ui.ctx().clone();
        let id = self.id;
        let mut state = ctx.memory_mut(|m| m.take_doc_editor(id));

        ui.horizontal(|ui| {
            let bold_label = if state.active_bold() { "Bold *" } else { "Bold" };
            if ui.button(bold_label).clicked() {
                state.toggle_bold();
            }
            let italic_label = if state.active_italic() { "Italic *" } else { "Italic" };
            if ui.button(italic_label).clicked() {
                state.toggle_italic();
            }
            if ui.button("Load 300-Paragraph Sample").clicked() {
                state.seed_sample(300);
            }
            ui.label(format!("{} words", state.word_count()));
        });
        ui.add_space(4.0);

        let region = ui.available_rect_before_wrap();
        let canvas_size = vec2(region.width(), (region.height() - TOOLBAR_H).max(60.0));
        let (canvas_response, painter) = ui.allocate_painter(canvas_size, Sense::click_and_drag());
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
        let total_page_h = page.height + PAGE_GAP;
        let max_scroll = ((pages.len() as f32) * total_page_h - canvas_rect.height()).max(0.0);
        state.scroll_y = state.scroll_y.clamp(0.0, max_scroll);

        // Gated on `clicked()`, not `interact_pointer_pos()` - the latter is `Some` on every
        // frame the pointer merely hovers the canvas (see `ui::interact`), not just the frame
        // of an actual click. Using it unconditionally re-ran hit-testing (and reset the
        // cursor to wherever the mouse happened to be sitting) on every single frame after
        // the first click, which scrambled typed text as the paragraph reflowed underneath a
        // stationary pointer - caught by actually typing into a running window, not just by
        // the app failing to crash.
        let clicked_pos = canvas_response.clicked().then(|| canvas_response.interact_pointer_pos()).flatten().map(|p| {
            let doc_y = p.y - canvas_rect.min.y + state.scroll_y;
            let page_idx = ((doc_y / total_page_h).floor().max(0.0)) as usize;
            let page_top = page_idx as f32 * total_page_h;
            let local_y = doc_y - page_top - page.margin;
            let page_x0 = canvas_rect.min.x + ((canvas_rect.width() - page.width) / 2.0).max(0.0);
            let local_x = p.x - page_x0 - page.margin;
            (page_idx, local_x, local_y)
        });

        let first_visible = ((state.scroll_y / total_page_h).floor().max(0.0)) as usize;
        let last_visible = (((state.scroll_y + canvas_rect.height()) / total_page_h).ceil().max(0.0)) as usize;

        for page_idx in first_visible..=last_visible {
            if page_idx >= pages.len() {
                break;
            }
            let page_top_doc_y = page_idx as f32 * total_page_h;
            let page_top_screen_y = canvas_rect.min.y + page_top_doc_y - state.scroll_y;
            if page_top_screen_y > canvas_rect.max.y || page_top_screen_y + page.height < canvas_rect.min.y {
                continue;
            }
            let page_x0 = canvas_rect.min.x + ((canvas_rect.width() - page.width) / 2.0).max(0.0);
            let page_rect = Rect::from_min_size(pos2(page_x0, page_top_screen_y), vec2(page.width, page.height));

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
                    clipped.styled_glyphs(origin, &line.glyphs, FontFamily::Proportional, Color32::from_gray(20), |off| {
                        let f = state.paragraph_format_at(entry.para, off);
                        (f.bold, f.italic)
                    });

                    if is_focused
                        && state.selection_anchor.is_none()
                        && state.cursor_para == entry.para
                        && state.blink_on
                        && state.cursor_off >= line.start_byte
                        && state.cursor_off <= line.end_byte
                    {
                        let cx = state.cursor_x(entry.para);
                        clipped.line_segment(
                            [pos2(origin.x + cx, origin.y), pos2(origin.x + cx, origin.y + DOC_FONT_SIZE)],
                            Stroke::new(1.5, Color32::from_rgb(20, 20, 200)),
                        );
                    }
                    y += LINE_HEIGHT;
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

        let response = DocEditorResponse { word_count: state.word_count(), char_count: state.char_count(), page_count: pages.len() };
        ctx.memory_mut(|m| m.put_doc_editor(id, state));
        response
    }
}
