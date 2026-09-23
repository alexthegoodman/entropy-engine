//! `KanbanBoard` — a fixed-column, vertically-stacked card board: click-and-drag a card
//! between columns (or to a new position within one column), click a card to select it,
//! right-click for a delete menu, and a "+" button per column header to request a new card.
//! Same domain-agnostic shape as `NodeGraphEditor`/`TrackView`/`KeyframeTimeline` (see their
//! module docs) - the caller hands in plain `KanbanColumn`/`KanbanCard` data rebuilt from its
//! own state every frame, `show()` returns `KanbanEvent`s to apply back, and a live-drag id
//! in `Memory` (`Memory::kanban_drag`) lets the widget draw a floating "ghost" of the card
//! under the cursor without ever getting a `&mut` into the caller's board directly.
//!
//! Built for `CC Manager`, an Entropy addon that tracks planning work (backlog / in progress
//! / done, or whatever columns the addon configures) as a JSON file both a human (via this
//! widget) and a Claude Code session (by editing the JSON directly) can maintain.
//!
//! ## Known v1 simplifications (documented, not accidental)
//!
//! - No per-column scrolling: a column's cards simply stack top-to-bottom and the column
//!   grows to fit them. A board with a very tall column will scroll past its window unless
//!   the caller wraps the whole widget in `Entropy.UI.Widget` scroll handling of its own.
//! - Description wrapping uses `Painter::measure_text` word-by-word (real glyph metrics, not
//!   an average-char-width guess), capped at a fixed line count with a trailing "…" - not a
//!   full text-layout pass like `DocEditor`'s.
//! - Dropping a card mid-drag doesn't live-reflow the other cards in the target column (no
//!   "gap" preview) - only the final drop computes an insertion index, same convention
//!   `TrackView`'s clip drag uses (position, not a full continuous relayout).

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::context::Key;
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::ui::{interact, Ui};

const COLUMN_W: f32 = 260.0;
const COLUMN_GAP: f32 = 14.0;
const HEADER_H: f32 = 34.0;
const ADD_BTN_SIZE: f32 = 22.0;
const CARD_GAP: f32 = 8.0;
const CARD_INSET: f32 = 6.0;
const CARD_PAD: f32 = 10.0;
const TITLE_SIZE: f32 = 13.0;
const DESC_SIZE: f32 = 11.5;
const TAG_SIZE: f32 = 10.0;
const LINE_H: f32 = 15.0;
const MAX_DESC_LINES: usize = 4;
const TAG_ROW_H: f32 = 18.0;

#[derive(Clone, Debug)]
pub struct KanbanCard {
    /// Unique within the whole board, not just its column.
    pub id: String,
    pub title: String,
    pub description: String,
    pub color: Color32,
    pub tags: Vec<String>,
}

impl KanbanCard {
    pub fn new(id: impl Into<String>, title: impl Into<String>) -> Self {
        Self { id: id.into(), title: title.into(), description: String::new(), color: Color32::from_rgb(90, 130, 230), tags: Vec::new() }
    }
}

#[derive(Clone, Debug)]
pub struct KanbanColumn {
    pub id: String,
    pub title: String,
    pub cards: Vec<KanbanCard>,
}

impl KanbanColumn {
    pub fn new(id: impl Into<String>, title: impl Into<String>) -> Self {
        Self { id: id.into(), title: title.into(), cards: Vec::new() }
    }
}

#[derive(Clone, Debug)]
pub enum KanbanEvent {
    /// A card was dropped into `to_column` at `to_index` (may be the same column it started
    /// in, reordering within it). Apply this to your own data so the board this widget shows
    /// converges with what you hand back next frame.
    CardMoved { card: String, from_column: String, to_column: String, to_index: usize },
    /// A card's drag started, or it was plain-clicked without dragging - indistinguishable
    /// from a click until release, same convention `TrackView` uses. Use it for selection.
    CardSelected { column: String, card: String },
    /// "Delete Card" was chosen from a card's right-click menu, or Delete/Backspace was
    /// pressed with one selected.
    CardDeleteRequested { column: String, card: String },
    /// A column header's "+" button was clicked.
    AddCardRequested { column: String },
    /// A column header (outside the "+" button) was clicked.
    ColumnClicked(String),
    /// Empty board background was clicked - the conventional "deselect" signal.
    BackgroundClicked,
}

pub struct KanbanResponse {
    pub events: Vec<KanbanEvent>,
}

pub struct KanbanBoard {
    id: Id,
}

/// Greedy word-wrap using real glyph metrics, capped at `max_lines` with a trailing "…" on
/// the last line if the text didn't fit.
fn wrap_text(ctx: &crate::entropy_gui::context::Context, text: &str, font_id: FontId, max_width: f32, max_lines: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut current = String::new();

    for word in text.split_whitespace() {
        let candidate = if current.is_empty() { word.to_string() } else { format!("{current} {word}") };
        let w = Painter::measure_text(ctx, font_id, &candidate).x;
        if w <= max_width || current.is_empty() {
            current = candidate;
        } else {
            lines.push(std::mem::take(&mut current));
            current = word.to_string();
            if lines.len() == max_lines {
                break;
            }
        }
    }
    if lines.len() < max_lines && !current.is_empty() {
        lines.push(current);
    }

    if lines.len() == max_lines {
        // Might still be mid-word or have trailing text left unconsumed - either way, mark
        // truncation by appending "…" to the last line (trimming to make room if needed).
        let consumed: usize = lines.iter().map(|l| l.len() + 1).sum();
        if consumed < text.len() {
            let last = lines.last_mut().unwrap();
            while Painter::measure_text(ctx, font_id, &format!("{last}…")).x > max_width && !last.is_empty() {
                last.pop();
            }
            last.push('…');
        }
    }

    lines
}

impl KanbanBoard {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("kanban_board").with(id_salt) }
    }

    pub fn show(self, ui: &mut Ui, columns: &[KanbanColumn], selected: Option<(&str, &str)>) -> KanbanResponse {
        let ctx = ui.ctx().clone();
        let board_id = self.id;
        let mut events = Vec::new();
        let visuals = ui.visuals();

        let title_font = FontId::proportional(TITLE_SIZE);
        let desc_font = FontId::proportional(DESC_SIZE);
        let tag_font = FontId::proportional(TAG_SIZE);
        let card_inner_w = COLUMN_W - CARD_INSET * 2.0 - CARD_PAD * 2.0;

        // Pre-measure every card's height so column layout and hit-testing agree in one pass.
        let card_heights: Vec<Vec<f32>> = columns
            .iter()
            .map(|col| {
                col.cards
                    .iter()
                    .map(|card| {
                        let title_lines = wrap_text(&ctx, &card.title, title_font, card_inner_w, usize::MAX).len();
                        let desc_lines = if card.description.is_empty() {
                            0
                        } else {
                            wrap_text(&ctx, &card.description, desc_font, card_inner_w, MAX_DESC_LINES).len()
                        };
                        let tag_h = if card.tags.is_empty() { 0.0 } else { TAG_ROW_H };
                        CARD_PAD * 2.0 + title_lines as f32 * LINE_H + desc_lines as f32 * LINE_H + tag_h
                    })
                    .collect()
            })
            .collect();

        let total_w = columns.len() as f32 * COLUMN_W + (columns.len().saturating_sub(1)) as f32 * COLUMN_GAP;
        let column_content_h: Vec<f32> = columns
            .iter()
            .enumerate()
            .map(|(ci, col)| {
                HEADER_H
                    + CARD_GAP
                    + card_heights[ci].iter().map(|h| h + CARD_GAP).sum::<f32>()
                    + if col.cards.is_empty() { 40.0 } else { 0.0 }
            })
            .collect();
        let board_h = ui.available_size().y.max(column_content_h.iter().cloned().fold(160.0_f32, f32::max));
        let size = vec2(ui.available_size().x.max(total_w), board_h);

        let (bg_response, painter) = ui.allocate_painter(size, Sense::click());
        let board_rect = bg_response.rect;
        painter.rect_filled(board_rect, visuals.window_corner_radius, visuals.extreme_bg_color);

        let dragging = ctx.memory(|m| m.kanban_drag.clone()).filter(|(id, _, _)| *id == board_id);
        let pointer_pos = ui.input(|i| i.pointer.pos);

        // Computed once, up front, for the *whole* board: which column/insertion-slot the
        // pointer is currently over. This must NOT be computed incrementally inside the
        // per-column loop below - the dragged card's own `drag_stopped` handling runs while
        // that loop is still visiting the card's *source* column, which for a rightward drag
        // is always visited before the target column, so an incremental version would only
        // ever see columns already passed and silently fall back to "drop in place."
        let drop_target: Option<(usize, usize)> = pointer_pos.and_then(|p| {
            if p.y < board_rect.min.y || p.y > board_rect.max.y {
                return None;
            }
            let slot = COLUMN_W + COLUMN_GAP;
            let rel_x = p.x - board_rect.min.x;
            if rel_x < 0.0 {
                return None;
            }
            let ci = (rel_x / slot) as usize;
            if ci >= columns.len() || rel_x - ci as f32 * slot > COLUMN_W {
                return None;
            }
            let mut insert_index = columns[ci].cards.len();
            let mut cursor_y = board_rect.min.y + HEADER_H + CARD_GAP;
            for (idx, h) in card_heights[ci].iter().enumerate() {
                if p.y < cursor_y + h / 2.0 {
                    insert_index = idx;
                    break;
                }
                cursor_y += h + CARD_GAP;
            }
            Some((ci, insert_index))
        });
        // `bg_response` spans the whole board, including every card/header/button drawn on
        // top of it - this app's `interact()` has no topmost-only hit-test, so a click inside
        // a card also satisfies the board background's own click test. Track whether anything
        // more specific consumed the click so `BackgroundClicked` doesn't fire (and stomp a
        // `CardSelected` from the same press) alongside it.
        let mut click_consumed = false;

        for (ci, col) in columns.iter().enumerate() {
            let x0 = board_rect.min.x + ci as f32 * (COLUMN_W + COLUMN_GAP);
            let column_rect = Rect::from_min_size(pos2(x0, board_rect.min.y), vec2(COLUMN_W, board_h));

            let header_rect = Rect::from_min_size(column_rect.min, vec2(COLUMN_W, HEADER_H));
            painter.rect_filled(header_rect, visuals.widgets.inactive.corner_radius, visuals.widgets.inactive.weak_bg_fill);

            let add_rect = Rect::from_min_size(pos2(header_rect.max.x - ADD_BTN_SIZE - 6.0, header_rect.min.y + (HEADER_H - ADD_BTN_SIZE) / 2.0), vec2(ADD_BTN_SIZE, ADD_BTN_SIZE));
            let add_resp = interact(&ctx, add_rect, board_id.with(("add", &col.id)), Sense::click());
            painter.rect_filled(add_rect, 3u8, if add_resp.hovered() { visuals.widgets.hovered.bg_fill } else { visuals.widgets.inactive.bg_fill });
            painter.text(add_rect.center(), Align2::CENTER_CENTER, "+", FontId::proportional(14.0), Color32::from_gray(230));
            if add_resp.clicked() {
                events.push(KanbanEvent::AddCardRequested { column: col.id.clone() });
                click_consumed = true;
            }

            let header_click_rect = Rect::from_min_max(header_rect.min, pos2(add_rect.min.x - 4.0, header_rect.max.y));
            let header_resp = interact(&ctx, header_click_rect, board_id.with(("header", &col.id)), Sense::click());
            if header_resp.clicked() {
                events.push(KanbanEvent::ColumnClicked(col.id.clone()));
                click_consumed = true;
            }
            painter.text(
                pos2(header_rect.min.x + 10.0, header_rect.center().y),
                Align2::LEFT_CENTER,
                format!("{} ({})", col.title, col.cards.len()),
                title_font,
                Color32::from_gray(230),
            );
            painter.line_segment([pos2(column_rect.min.x, header_rect.max.y), pos2(column_rect.max.x, header_rect.max.y)], Stroke::new(1.0, Color32::from_gray(55)));

            let mut cursor_y = header_rect.max.y + CARD_GAP;

            for (idx, card) in col.cards.iter().enumerate() {
                let is_dragged = dragging.as_ref().map_or(false, |(_, _, c)| c == &card.id);
                let card_h = card_heights[ci][idx];
                let card_rect = Rect::from_min_size(pos2(column_rect.min.x + CARD_INSET, cursor_y), vec2(COLUMN_W - CARD_INSET * 2.0, card_h));

                if !is_dragged {
                    Self::paint_card(&painter, &ctx, card_rect, card, selected == Some((col.id.as_str(), card.id.as_str())), &visuals, title_font, desc_font, tag_font, card_inner_w);
                }

                let interact_id = board_id.with(("card", &card.id));
                let resp = interact(&ctx, card_rect, interact_id, Sense::click_and_drag());

                if resp.drag_started() {
                    ctx.memory_mut(|m| m.kanban_drag = Some((board_id, col.id.clone(), card.id.clone())));
                    events.push(KanbanEvent::CardSelected { column: col.id.clone(), card: card.id.clone() });
                    click_consumed = true;
                } else if resp.clicked() {
                    events.push(KanbanEvent::CardSelected { column: col.id.clone(), card: card.id.clone() });
                    click_consumed = true;
                }
                if resp.drag_stopped() && dragging.as_ref().map_or(false, |(_, _, c)| c == &card.id) {
                    if let Some((target_col, target_idx)) = drop_target {
                        let to_col = columns[target_col].id.clone();
                        events.push(KanbanEvent::CardMoved { card: card.id.clone(), from_column: col.id.clone(), to_column: to_col, to_index: target_idx });
                    }
                    ctx.memory_mut(|m| m.kanban_drag = None);
                }

                let mut delete_request = false;
                resp.context_menu(|menu_ui| {
                    if menu_ui.button("Delete Card").clicked() {
                        delete_request = true;
                        menu_ui.close_menu();
                    }
                });
                if delete_request {
                    events.push(KanbanEvent::CardDeleteRequested { column: col.id.clone(), card: card.id.clone() });
                }

                cursor_y += card_h + CARD_GAP;
            }

            if col.cards.is_empty() {
                painter.text(pos2(column_rect.min.x + 10.0, cursor_y + 6.0), Align2::LEFT_TOP, "No cards", desc_font, Color32::from_gray(110));
            }

            painter.rect_stroke(column_rect, 0u8, Stroke::new(1.0, Color32::from_gray(45)), StrokeKind::Middle);
        }

        // Floating ghost for the card currently being dragged, drawn last so it's on top.
        if let (Some((_, src_col, card_id)), Some(p)) = (&dragging, pointer_pos) {
            if let Some((ci, card)) = columns.iter().enumerate().find_map(|(ci, c)| c.cards.iter().find(|c2| &c2.id == card_id).map(|c2| (ci, c2))) {
                let card_h = card_heights[ci][columns[ci].cards.iter().position(|c| &c.id == card_id).unwrap()];
                let ghost_rect = Rect::from_min_size(pos2(p.x - (COLUMN_W - CARD_INSET * 2.0) / 2.0, p.y - card_h / 2.0), vec2(COLUMN_W - CARD_INSET * 2.0, card_h));
                Self::paint_card(&painter, &ctx, ghost_rect, card, false, &visuals, title_font, desc_font, tag_font, card_inner_w);
                painter.rect_stroke(ghost_rect, 4u8, Stroke::new(2.0, Color32::WHITE), StrokeKind::Middle);
            }
            let _ = src_col;
        }

        if bg_response.clicked() && !click_consumed {
            events.push(KanbanEvent::BackgroundClicked);
        }

        if let Some((col_id, card_id)) = selected {
            let delete_pressed = ui.input(|i| i.key_events.iter().any(|k| k.pressed && matches!(k.key, Key::Delete | Key::Backspace)));
            if delete_pressed {
                events.push(KanbanEvent::CardDeleteRequested { column: col_id.to_string(), card: card_id.to_string() });
            }
        }

        KanbanResponse { events }
    }

    fn paint_card(
        painter: &Painter,
        ctx: &crate::entropy_gui::context::Context,
        rect: Rect,
        card: &KanbanCard,
        is_selected: bool,
        visuals: &crate::entropy_gui::style::Visuals,
        title_font: FontId,
        desc_font: FontId,
        tag_font: FontId,
        inner_w: f32,
    ) {
        painter.rect_filled(rect, 4u8, visuals.widgets.inactive.bg_fill);
        let border = if is_selected { Color32::WHITE } else { Color32::from_gray(60) };
        painter.rect_stroke(rect, 4u8, Stroke::new(if is_selected { 2.0 } else { 1.0 }, border), StrokeKind::Middle);
        // Left accent bar in the card's own color.
        painter.rect_filled(Rect::from_min_size(rect.min, vec2(4.0, rect.height())), 0u8, card.color);

        let mut y = rect.min.y + CARD_PAD;
        let text_x = rect.min.x + CARD_PAD + 4.0;
        for line in wrap_text(ctx, &card.title, title_font, inner_w, usize::MAX) {
            painter.text(pos2(text_x, y), Align2::LEFT_TOP, line, title_font, Color32::from_gray(240));
            y += LINE_H;
        }

        if !card.description.is_empty() {
            for line in wrap_text(ctx, &card.description, desc_font, inner_w, MAX_DESC_LINES) {
                painter.text(pos2(text_x, y), Align2::LEFT_TOP, line, desc_font, Color32::from_gray(175));
                y += LINE_H;
            }
        }

        if !card.tags.is_empty() {
            let mut x = text_x;
            for tag in &card.tags {
                let w = Painter::measure_text(ctx, tag_font, tag).x + 10.0;
                if x + w > rect.max.x - CARD_PAD {
                    break;
                }
                let pill_rect = Rect::from_min_size(pos2(x, y + 1.0), vec2(w, TAG_ROW_H - 4.0));
                painter.rect_filled(pill_rect, 3u8, Color32::from_gray(45));
                painter.text(pill_rect.center(), Align2::CENTER_CENTER, tag, tag_font, Color32::from_gray(200));
                x += w + 4.0;
            }
        }
    }
}
