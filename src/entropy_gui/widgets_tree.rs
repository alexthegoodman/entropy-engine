//! `TreeView` — a Figma/VS Code-style outliner: indented rows, a disclosure triangle for
//! anything with children, a full-row selection highlight, and an optional per-row checkbox
//! (Canvas Surfaces uses it to mark several parts before grouping them). Same domain-agnostic
//! shape as `KanbanBoard`/`TrackView` - the caller hands in one flat, already depth-computed
//! `Vec<TreeNode>` every frame (this widget does not derive parent/child structure itself,
//! collapsing a hidden subtree is the caller's job - just omit its rows), `show()` returns
//! `TreeEvent`s to apply back.
//!
//! Built to replace a hand-stacked list of `Button`/`Checkbox` widgets (three widgets and up
//! to two full rows per tree node, with indentation faked as literal leading spaces in a
//! button's own text) that Canvas Surfaces' "Groups & animation" panel used at first - real
//! pixel indentation and a real selection highlight bar read as a hierarchy at a glance in a
//! way a flat button stack never did.

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::ui::{interact, Ui};

const ROW_H: f32 = 22.0;
const INDENT: f32 = 16.0;
const TRIANGLE_W: f32 = 16.0;
const CHECKBOX_SIZE: f32 = 13.0;
const ROW_PAD_X: f32 = 6.0;
const LABEL_SIZE: f32 = 12.5;

#[derive(Clone, Debug)]
pub struct TreeNode {
    /// Unique within this tree.
    pub id: String,
    pub label: String,
    /// 0 for a root row; each level of nesting the caller wants drawn adds 1.
    pub depth: u32,
    /// Draws a disclosure triangle when true. A group with no children shouldn't get a
    /// triangle that toggles nothing.
    pub has_children: bool,
    pub expanded: bool,
    /// `None` hides this row's checkbox entirely; `Some(value)` shows it at that state.
    pub marked: Option<bool>,
    pub selected: bool,
}

impl TreeNode {
    pub fn new(id: impl Into<String>, label: impl Into<String>, depth: u32) -> Self {
        Self { id: id.into(), label: label.into(), depth, has_children: false, expanded: true, marked: None, selected: false }
    }
}

#[derive(Clone, Debug)]
pub enum TreeEvent {
    /// A row's label was clicked - the conventional "select this" signal.
    Selected(String),
    /// A row's disclosure triangle was clicked. Apply this to whatever expanded-set the
    /// caller owns; this widget has no collapsed-state memory of its own.
    ToggleExpand(String),
    /// A row's checkbox was clicked, carrying its new (post-click) value.
    Marked(String, bool),
}

pub struct TreeResponse {
    pub events: Vec<TreeEvent>,
}

pub struct TreeView {
    id: Id,
}

impl TreeView {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("tree_view").with(id_salt) }
    }

    pub fn show(self, ui: &mut Ui, nodes: &[TreeNode]) -> TreeResponse {
        let ctx = ui.ctx().clone();
        let tree_id = self.id;
        let mut events = Vec::new();
        let visuals = ui.visuals();
        let label_font = FontId::proportional(LABEL_SIZE);

        let width = ui.available_size().x.max(120.0);
        let height = (ROW_H * nodes.len() as f32).max(1.0);
        let (bg_response, painter) = ui.allocate_painter(vec2(width, height), Sense::hover());
        let origin = bg_response.rect.min;

        for (row, node) in nodes.iter().enumerate() {
            let row_rect = Rect::from_min_size(pos2(origin.x, origin.y + row as f32 * ROW_H), vec2(width, ROW_H));

            if node.selected {
                painter.rect_filled(row_rect, 3u8, visuals.selection.bg_fill.linear_multiply(0.35));
            } else {
                let hover_resp = interact(&ctx, row_rect, tree_id.with(("row_hover", &node.id)), Sense::hover());
                if hover_resp.hovered() {
                    painter.rect_filled(row_rect, 3u8, visuals.widgets.hovered.weak_bg_fill);
                }
            }

            let indent_x = row_rect.min.x + ROW_PAD_X + node.depth as f32 * INDENT;
            let mut x = indent_x;

            if node.has_children {
                let tri_rect = Rect::from_min_size(pos2(x, row_rect.min.y), vec2(TRIANGLE_W, ROW_H));
                let tri_resp = interact(&ctx, tri_rect, tree_id.with(("expand", &node.id)), Sense::click());
                let glyph = if node.expanded { "\u{25BE}" } else { "\u{25B8}" }; // ▾ expanded / ▸ collapsed
                painter.text(tri_rect.center(), Align2::CENTER_CENTER, glyph, label_font, if tri_resp.hovered() { Color32::from_gray(240) } else { Color32::from_gray(165) });
                if tri_resp.clicked() {
                    events.push(TreeEvent::ToggleExpand(node.id.clone()));
                }
            }
            x += TRIANGLE_W;

            let checkbox_x = row_rect.max.x - ROW_PAD_X - CHECKBOX_SIZE;
            let label_max_x = if node.marked.is_some() { checkbox_x - 6.0 } else { row_rect.max.x - ROW_PAD_X };
            let label_rect = Rect::from_min_max(pos2(x, row_rect.min.y), pos2(label_max_x.max(x), row_rect.max.y));
            let label_resp = interact(&ctx, label_rect, tree_id.with(("select", &node.id)), Sense::click());
            let text_color = if node.selected { Color32::WHITE } else { Color32::from_gray(215) };
            painter.text(pos2(label_rect.min.x, label_rect.center().y), Align2::LEFT_CENTER, &node.label, label_font, text_color);
            if label_resp.clicked() {
                events.push(TreeEvent::Selected(node.id.clone()));
            }

            if let Some(marked) = node.marked {
                let box_rect = Rect::from_min_size(pos2(checkbox_x, row_rect.min.y + (ROW_H - CHECKBOX_SIZE) / 2.0), vec2(CHECKBOX_SIZE, CHECKBOX_SIZE));
                let box_resp = interact(&ctx, box_rect, tree_id.with(("mark", &node.id)), Sense::click());
                painter.rect_stroke(box_rect, 2u8, Stroke::new(1.0, Color32::from_gray(150)), StrokeKind::Middle);
                if marked {
                    painter.rect_filled(box_rect.shrink(2.5), 1u8, visuals.selection.bg_fill);
                }
                if box_resp.clicked() {
                    events.push(TreeEvent::Marked(node.id.clone(), !marked));
                }
            }
        }

        TreeResponse { events }
    }
}
