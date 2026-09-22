//! `SheetGrid` - a spreadsheet grid: lettered column headers (A, B, C, ..., AA, AB, ...),
//! numbered row headers, a single selected cell with arrow-key/Tab/Enter navigation, inline
//! cell editing, and a colored border per cell the caller can use to mark which data belongs to
//! which axis of a chart (Alex's own framing: "color coated sheet cells, just colors on the
//! borders").
//!
//! Same domain-agnostic shape as `KanbanBoard`/`TreeView` - the caller hands in a flat, sparse
//! `Vec<SheetCell>` (only cells with content or a border need an entry) every frame, plus which
//! cell is selected and (optionally) which cell is being edited and its live draft text, and
//! `show()` returns `SheetEvent`s to apply back. Formula parsing/evaluation lives entirely on
//! the caller's side (see `sheet_model.ts`); this widget only ever draws the text it is handed.
//!
//! ## Editing
//!
//! Unlike most widgets here, editing is a small caller-driven state machine rather than a
//! single controlled value, because a cell can be edited two ways at once - typed directly into
//! the grid, or typed into a caller-owned formula bar - and both need to land in the same place:
//!
//! - Double-click a cell, or start typing while it is selected (not yet editing) and no other
//!   text field has focus: `CellEditStarted { row, col, initial }`. `initial` is empty for a
//!   double-click (edit the existing content) and the just-typed character(s) for type-to-edit
//!   (replace the content, matching every spreadsheet's own convention). The widget also claims
//!   keyboard focus for its own inline text box at this point, so a caller never has to.
//! - Every edit to the draft (from typing in the widget's own inline box) fires
//!   `CellEditChanged { row, col, text }` - apply it to whatever draft state you show back next
//!   frame as `editing`. A caller whose own formula bar changed the draft instead does not need
//!   this event - just pass the new draft through `editing` directly.
//! - Enter (commit, move down), Tab (commit, move right), clicking a different cell (commit),
//!   or Escape (cancel, discard the draft) end the session: `CellEditCommitted { row, col }` or
//!   `CellEditCancelled { row, col }`. A commit means "write your current draft into the cell";
//!   the widget does not know or care what that draft is.
//!
//! Right-clicking a row or column header opens a small menu to insert or delete it -
//! `InsertRowRequested`/`DeleteRowRequested`/`InsertColumnRequested`/`DeleteColumnRequested`.
//! Re-indexing the cell store (and, if the caller wants it, adjusting formula references that
//! pointed across the seam) is entirely the caller's job - this widget only reports the request.
//!
//! ## Known v1 simplifications (documented, not accidental)
//!
//! - One selected cell, not a range - no shift-click or drag-select, so no multi-cell copy/fill
//!   yet either. Single-cell copy/cut/paste and undo/redo are handled entirely by the caller
//!   (see `sheet_addon.ts`'s `Entropy.Input.onKeyDown` handler) since they need no widget state.
//! - Uniform column width and row height - no per-column resize.
//! - A double-click's cursor lands at the start of the existing text, not wherever was clicked -
//!   good enough to start editing, not a precise click-to-place-cursor.

use std::collections::HashMap;

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::context::{Key, KeyEvent};
use crate::entropy_gui::geometry::{pos2, vec2, Align, Align2, FontId, Layout, Pos2, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::ui::{interact, Ui};
use crate::entropy_gui::widgets::ScrollArea;

pub const ROW_HEADER_W: f32 = 42.0;
pub const HEADER_H: f32 = 22.0;
/// A second click on the same cell within this many seconds of the first counts as a
/// double-click (edit existing content) rather than two independent single clicks.
const DOUBLE_CLICK_WINDOW: f32 = 0.4;

/// Converts a 0-based column index to its spreadsheet letters (0 -> "A", 25 -> "Z", 26 -> "AA").
pub fn col_letters(index: u32) -> String {
    let mut n = index + 1;
    let mut letters = Vec::new();
    while n > 0 {
        let rem = (n - 1) % 26;
        letters.push((b'A' + rem as u8) as char);
        n = (n - 1) / 26;
    }
    letters.into_iter().rev().collect()
}

#[derive(Clone, Debug, Default)]
pub struct SheetCell {
    pub row: u32,
    pub col: u32,
    /// Already-evaluated display text - this widget never parses or computes formulas.
    pub text: String,
    /// Right-aligned like a number; left-aligned otherwise, matching every spreadsheet's convention.
    pub numeric: bool,
    /// A colored outline around the whole cell - the caller's way to mark related cells (e.g.
    /// "this column feeds the chart's X axis").
    pub border: Option<Color32>,
    /// True when `text` is an error message from a failed formula (bad ref, cycle, parse
    /// error) - drawn in an error color instead of the normal text color.
    pub error: bool,
}

impl SheetCell {
    pub fn new(row: u32, col: u32, text: impl Into<String>) -> Self {
        Self { row, col, text: text.into(), numeric: false, border: None, error: false }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SheetGridOptions {
    pub rows: u32,
    pub cols: u32,
    pub col_width: f32,
    pub row_height: f32,
    /// Caps the grid at this height and scrolls the rows inside it, same convention as
    /// `TreeView::max_height`. The column header row stays fixed above the scroll region.
    pub max_height: Option<f32>,
}

impl Default for SheetGridOptions {
    fn default() -> Self {
        Self { rows: 20, cols: 10, col_width: 92.0, row_height: 22.0, max_height: None }
    }
}

/// The cell currently being edited and its live draft text - see the module doc's "Editing"
/// section for how this is driven.
#[derive(Clone, Copy, Debug)]
pub struct SheetEdit<'a> {
    pub row: u32,
    pub col: u32,
    pub value: &'a str,
}

#[derive(Clone, Debug)]
pub enum SheetEvent {
    /// A cell was clicked, or navigated to with the arrow keys/Tab/Enter while another cell was
    /// already selected. Use it both for selection and for advancing a formula bar's target.
    CellSelected { row: u32, col: u32 },
    /// Delete/Backspace pressed with a cell selected (and not being edited) - clear its content.
    CellClearRequested { row: u32, col: u32 },
    /// Start an edit session - see the module doc's "Editing" section.
    CellEditStarted { row: u32, col: u32, initial: String },
    CellEditChanged { row: u32, col: u32, text: String },
    CellEditCommitted { row: u32, col: u32 },
    CellEditCancelled { row: u32, col: u32 },
    /// A row header's context menu asked for a new row inserted at this index (existing rows at
    /// and after it shift down by one).
    InsertRowRequested { row: u32 },
    DeleteRowRequested { row: u32 },
    /// A column header's context menu asked for a new column inserted at this index (existing
    /// columns at and after it shift right by one).
    InsertColumnRequested { col: u32 },
    DeleteColumnRequested { col: u32 },
}

pub struct SheetResponse {
    pub events: Vec<SheetEvent>,
    /// Top-left of cell (0, 0) in this frame's painted (post-scroll) coordinates - a test can
    /// find any cell's rect from this plus the options' `col_width`/`row_height`.
    pub origin: Pos2,
}

pub struct SheetGrid {
    id: Id,
    options: SheetGridOptions,
}

impl SheetGrid {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("sheet_grid").with(id_salt), options: SheetGridOptions::default() }
    }

    pub fn options(mut self, options: SheetGridOptions) -> Self {
        self.options = options;
        self
    }

    pub fn show(self, ui: &mut Ui, cells: &[SheetCell], selected: Option<(u32, u32)>, editing: Option<SheetEdit>) -> SheetResponse {
        let grid_id = self.id;
        let opts = self.options;
        let ctx = ui.ctx().clone();
        let visuals = ui.visuals();
        let header_font = FontId::proportional(12.0);
        let cell_font = FontId::proportional(12.5);

        let body_w = ROW_HEADER_W + opts.cols as f32 * opts.col_width;

        let cell_map: HashMap<(u32, u32), &SheetCell> = cells.iter().map(|c| ((c.row, c.col), c)).collect();

        // Column header row - painted once, outside the scroll region, so it stays fixed while
        // the rows below it scroll (a cheap stand-in for a real frozen-row implementation).
        let (header_resp, header_painter) = ui.allocate_painter(vec2(body_w, HEADER_H), Sense::hover());
        let header_rect = header_resp.rect;
        header_painter.rect_filled(header_rect, 0u8, visuals.widgets.inactive.weak_bg_fill);
        let corner_rect = Rect::from_min_size(header_rect.min, vec2(ROW_HEADER_W, HEADER_H));
        header_painter.rect_stroke(corner_rect, 0u8, Stroke::new(1.0, Color32::from_gray(55)), StrokeKind::Middle);
        let mut events = Vec::new();
        for c in 0..opts.cols {
            let x = header_rect.min.x + ROW_HEADER_W + c as f32 * opts.col_width;
            let r = Rect::from_min_size(pos2(x, header_rect.min.y), vec2(opts.col_width, HEADER_H));
            if selected.is_some_and(|(_, sc)| sc == c) {
                header_painter.rect_filled(r, 0u8, visuals.selection.bg_fill.linear_multiply(0.25));
            }
            header_painter.text(r.center(), Align2::CENTER_CENTER, col_letters(c), header_font, Color32::from_gray(190));
            header_painter.rect_stroke(r, 0u8, Stroke::new(1.0, Color32::from_gray(45)), StrokeKind::Middle);

            let head_resp = interact(&ctx, r, grid_id.with(("col_head", c)), Sense::click());
            let mut insert_left = false;
            let mut insert_right = false;
            let mut delete = false;
            head_resp.context_menu(|menu_ui| {
                if menu_ui.button("Insert column left").clicked() {
                    insert_left = true;
                    menu_ui.close_menu();
                }
                if menu_ui.button("Insert column right").clicked() {
                    insert_right = true;
                    menu_ui.close_menu();
                }
                if menu_ui.button("Delete column").clicked() {
                    delete = true;
                    menu_ui.close_menu();
                }
            });
            if insert_left {
                events.push(SheetEvent::InsertColumnRequested { col: c });
            }
            if insert_right {
                events.push(SheetEvent::InsertColumnRequested { col: c + 1 });
            }
            if delete {
                events.push(SheetEvent::DeleteColumnRequested { col: c });
            }
        }

        // Scrollable body: row headers + cells.
        let content_h = opts.rows as f32 * opts.row_height;
        let height = opts.max_height.map_or(content_h, |cap| content_h.min(cap)).max(opts.row_height);
        let (body_rect, _) = ui.allocate_exact_size(vec2(body_w, height), Sense::hover());
        let mut child = ui.child_ui_at(body_rect, Layout::top_down(Align::Min), (grid_id, "scroll"));
        let mut origin = pos2(0.0, 0.0);
        let inner = ScrollArea::vertical()
            .show(&mut child, |inner_ui| {
                let r = Self::body(grid_id, inner_ui, &ctx, &opts, &cell_map, selected, editing.as_ref(), body_w, cell_font);
                origin = r.1;
                r.0
            })
            .inner;
        events.extend(inner);

        // A cell is selected, nothing is being edited yet, and no other text field owns
        // keyboard focus (the formula bar, if the user clicked into it instead, already claimed
        // it) - typing now means "start editing this cell, replacing its content".
        if let (Some((row, col)), None) = (selected, editing) {
            if ctx.memory(|m| m.focused.is_none()) {
                let typed = ui.input(|i| i.text_input.clone());
                if !typed.is_empty() {
                    events.push(SheetEvent::CellEditStarted { row, col, initial: typed });
                    ctx.memory_mut(|m| m.focused = Some(grid_id.with(("edit", row, col))));
                }
            }
        }

        if let Some(edit) = editing {
            let pressed: Vec<KeyEvent> = ui.input(|i| i.key_events.iter().filter(|k| k.pressed).cloned().collect());
            for ev in pressed {
                match ev.key {
                    Key::Enter => {
                        events.push(SheetEvent::CellEditCommitted { row: edit.row, col: edit.col });
                        if edit.row + 1 < opts.rows {
                            events.push(SheetEvent::CellSelected { row: edit.row + 1, col: edit.col });
                        }
                        ctx.memory_mut(|m| m.focused = None);
                    }
                    Key::Tab => {
                        events.push(SheetEvent::CellEditCommitted { row: edit.row, col: edit.col });
                        if edit.col + 1 < opts.cols {
                            events.push(SheetEvent::CellSelected { row: edit.row, col: edit.col + 1 });
                        }
                        ctx.memory_mut(|m| m.focused = None);
                    }
                    Key::Escape => {
                        events.push(SheetEvent::CellEditCancelled { row: edit.row, col: edit.col });
                        ctx.memory_mut(|m| m.focused = None);
                    }
                    _ => {}
                }
            }
        } else if let Some((row, col)) = selected {
            let pressed: Vec<Key> = ui.input(|i| i.key_events.iter().filter(|k| k.pressed).map(|k| k.key).collect());
            for key in pressed {
                match key {
                    Key::ArrowLeft if col > 0 => events.push(SheetEvent::CellSelected { row, col: col - 1 }),
                    Key::ArrowRight if col + 1 < opts.cols => events.push(SheetEvent::CellSelected { row, col: col + 1 }),
                    Key::ArrowUp if row > 0 => events.push(SheetEvent::CellSelected { row: row - 1, col }),
                    Key::ArrowDown if row + 1 < opts.rows => events.push(SheetEvent::CellSelected { row: row + 1, col }),
                    Key::Tab if col + 1 < opts.cols => events.push(SheetEvent::CellSelected { row, col: col + 1 }),
                    Key::Enter if row + 1 < opts.rows => events.push(SheetEvent::CellSelected { row: row + 1, col }),
                    Key::Delete | Key::Backspace => events.push(SheetEvent::CellClearRequested { row, col }),
                    _ => {}
                }
            }
        }

        SheetResponse { events, origin }
    }

    #[allow(clippy::too_many_arguments)]
    fn body(
        grid_id: Id,
        ui: &mut Ui,
        ctx: &crate::entropy_gui::context::Context,
        opts: &SheetGridOptions,
        cell_map: &HashMap<(u32, u32), &SheetCell>,
        selected: Option<(u32, u32)>,
        editing: Option<&SheetEdit>,
        width: f32,
        cell_font: FontId,
    ) -> (Vec<SheetEvent>, Pos2) {
        let mut events = Vec::new();
        let visuals = ui.visuals();
        let height = (opts.rows as f32 * opts.row_height).max(1.0);
        let (bg_response, painter) = ui.allocate_painter(vec2(width, height), Sense::hover());
        let origin = bg_response.rect.min;

        // Age the double-click memo by this frame's dt once, up front, rather than per cell.
        let dt = ui.input(|i| i.dt);
        ctx.memory_mut(|m| {
            if let Some((id, _, age)) = &mut m.sheet_last_click {
                if *id == grid_id {
                    *age += dt;
                }
            }
        });

        for r in 0..opts.rows {
            let y = origin.y + r as f32 * opts.row_height;
            let rh_rect = Rect::from_min_size(pos2(origin.x, y), vec2(ROW_HEADER_W, opts.row_height));
            let is_sel_row = selected.is_some_and(|(sr, _)| sr == r);
            painter.rect_filled(rh_rect, 0u8, if is_sel_row { visuals.selection.bg_fill.linear_multiply(0.25) } else { visuals.widgets.inactive.weak_bg_fill });
            painter.text(rh_rect.center(), Align2::CENTER_CENTER, (r + 1).to_string(), cell_font, Color32::from_gray(170));
            painter.rect_stroke(rh_rect, 0u8, Stroke::new(1.0, Color32::from_gray(45)), StrokeKind::Middle);

            let head_resp = interact(ctx, rh_rect, grid_id.with(("row_head", r)), Sense::click());
            let mut insert_above = false;
            let mut insert_below = false;
            let mut delete = false;
            head_resp.context_menu(|menu_ui| {
                if menu_ui.button("Insert row above").clicked() {
                    insert_above = true;
                    menu_ui.close_menu();
                }
                if menu_ui.button("Insert row below").clicked() {
                    insert_below = true;
                    menu_ui.close_menu();
                }
                if menu_ui.button("Delete row").clicked() {
                    delete = true;
                    menu_ui.close_menu();
                }
            });
            if insert_above {
                events.push(SheetEvent::InsertRowRequested { row: r });
            }
            if insert_below {
                events.push(SheetEvent::InsertRowRequested { row: r + 1 });
            }
            if delete {
                events.push(SheetEvent::DeleteRowRequested { row: r });
            }

            for c in 0..opts.cols {
                let x = origin.x + ROW_HEADER_W + c as f32 * opts.col_width;
                let cell_rect = Rect::from_min_size(pos2(x, y), vec2(opts.col_width, opts.row_height));
                let is_selected = selected == Some((r, c));
                let is_editing = editing.is_some_and(|e| e.row == r && e.col == c);

                if is_editing {
                    let edit = editing.unwrap();
                    painter.rect_filled(cell_rect, 0u8, visuals.selection.bg_fill.linear_multiply(0.35));
                    painter.rect_stroke(cell_rect, 0u8, Stroke::new(2.0, Color32::WHITE), StrokeKind::Middle);

                    let mut child = ui.child_ui_at(cell_rect.shrink(1.0), Layout::top_down(Align::Min), grid_id.with(("edit_ui", r, c)));
                    let mut draft = edit.value.to_string();
                    let edit_id = grid_id.with(("edit", r, c));
                    let resp = child.text_edit_singleline_sized(&mut draft, opts.col_width - 2.0, edit_id);
                    if resp.changed() {
                        events.push(SheetEvent::CellEditChanged { row: r, col: c, text: draft });
                    }
                    continue;
                }

                let cell = cell_map.get(&(r, c)).copied();

                let bg = if is_selected { visuals.selection.bg_fill.linear_multiply(0.35) } else { visuals.extreme_bg_color };
                painter.rect_filled(cell_rect, 0u8, bg);
                painter.rect_stroke(cell_rect, 0u8, Stroke::new(1.0, Color32::from_gray(40)), StrokeKind::Middle);

                if let Some(cell) = cell {
                    if !cell.text.is_empty() {
                        let color = if cell.error { Color32::from_rgb(230, 90, 90) } else { Color32::from_gray(225) };
                        let (align, tx) =
                            if cell.numeric { (Align2::RIGHT_CENTER, cell_rect.max.x - 6.0) } else { (Align2::LEFT_CENTER, cell_rect.min.x + 6.0) };
                        painter.text(pos2(tx, cell_rect.center().y), align, &cell.text, cell_font, color);
                    }
                    if let Some(border) = cell.border {
                        painter.rect_stroke(cell_rect.shrink(1.0), 0u8, Stroke::new(2.0, border), StrokeKind::Middle);
                    }
                }

                if is_selected {
                    painter.rect_stroke(cell_rect, 0u8, Stroke::new(2.0, Color32::WHITE), StrokeKind::Middle);
                }

                let resp = interact(ctx, cell_rect, grid_id.with(("cell", r, c)), Sense::click());
                if resp.clicked() {
                    let double = ctx.memory(|m| matches!(m.sheet_last_click, Some((id, cell, age)) if id == grid_id && cell == (r, c) && age < DOUBLE_CLICK_WINDOW));

                    if let Some(edit) = editing {
                        events.push(SheetEvent::CellEditCommitted { row: edit.row, col: edit.col });
                        ctx.memory_mut(|m| m.focused = None);
                    }

                    if double {
                        events.push(SheetEvent::CellEditStarted { row: r, col: c, initial: String::new() });
                        ctx.memory_mut(|m| {
                            m.focused = Some(grid_id.with(("edit", r, c)));
                            m.sheet_last_click = None;
                        });
                    } else {
                        events.push(SheetEvent::CellSelected { row: r, col: c });
                        ctx.memory_mut(|m| m.sheet_last_click = Some((grid_id, (r, c), 0.0)));
                    }
                }
            }
        }

        (events, origin)
    }
}

#[cfg(test)]
mod tests {
    use super::col_letters;

    #[test]
    fn col_letters_matches_spreadsheet_convention() {
        assert_eq!(col_letters(0), "A");
        assert_eq!(col_letters(1), "B");
        assert_eq!(col_letters(25), "Z");
        assert_eq!(col_letters(26), "AA");
        assert_eq!(col_letters(27), "AB");
        assert_eq!(col_letters(51), "AZ");
        assert_eq!(col_letters(701), "ZZ");
        assert_eq!(col_letters(702), "AAA");
    }
}
