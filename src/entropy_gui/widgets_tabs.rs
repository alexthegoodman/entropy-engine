//! `TabBar` - a non-fullscreen tab strip for organizing one panel or window into pages. The
//! engine's own tabs (`Entropy.UI.createTab`) each own the whole work area; this is the other
//! kind, a row of labels inside a window that decides which group of widgets the caller draws
//! beneath it. Same domain-agnostic shape as `TreeView`/`KanbanBoard`: the caller hands in the
//! tabs and which one is selected, `show()` returns a `TabBarEvent::Selected` to apply back. The
//! widget keeps no selection state of its own and does not draw the page - that is the caller's
//! `if selected == "draw" { ... }`.
//!
//! Layout: when every tab fits on one line they stretch to fill it (a segmented control); when
//! they do not, they keep their natural widths and wrap onto further lines, so a narrow sidebar
//! never clips a label.

use crate::entropy_gui::color::Color32;
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Rect};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::ui::{interact, Ui};

const TAB_H: f32 = 28.0;
const TAB_PAD_X: f32 = 8.0;
const TAB_GAP: f32 = 2.0;
const LABEL_SIZE: f32 = 12.5;
const UNDERLINE_H: f32 = 2.0;

#[derive(Clone, Debug)]
pub struct Tab {
    /// Unique within this bar. It is what `TabBarEvent::Selected` carries.
    pub id: String,
    pub label: String,
}

impl Tab {
    pub fn new(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self { id: id.into(), label: label.into() }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TabBarEvent {
    /// A tab other than the selected one was clicked.
    Selected(String),
}

pub struct TabBarResponse {
    pub events: Vec<TabBarEvent>,
    /// Each tab's rectangle from this frame, in `tabs` order. Geometry for tests and for a caller
    /// that wants to anchor something to a tab.
    pub rects: Vec<(String, Rect)>,
}

pub struct TabBar {
    id: Id,
}

impl TabBar {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("tab_bar").with(id_salt) }
    }

    pub fn show(self, ui: &mut Ui, tabs: &[Tab], selected: &str) -> TabBarResponse {
        let bar_id = self.id;
        let ctx = ui.ctx().clone();
        let width = ui.available_size().x.max(80.0);
        let font = FontId::proportional(LABEL_SIZE);
        let natural: Vec<f32> = tabs
            .iter()
            .map(|t| Painter::measure_text(&ctx, font, &t.label).x.ceil() + TAB_PAD_X * 2.0)
            .collect();
        let slots = layout_tabs(&natural, width);
        let rows = slots.last().map(|s| s.row + 1).unwrap_or(1);

        let height = rows as f32 * (TAB_H + TAB_GAP) - TAB_GAP + 1.0;
        let (bg, painter) = ui.allocate_painter(vec2(width, height), Sense::hover());
        let origin = bg.rect.min;
        let visuals = ui.visuals();
        let accent = visuals.selection.bg_fill;
        let mut events = Vec::new();
        let mut rects = Vec::new();

        for (tab, slot) in tabs.iter().zip(&slots) {
            let min = pos2(origin.x + slot.x, origin.y + slot.row as f32 * (TAB_H + TAB_GAP));
            let rect = Rect::from_min_size(min, vec2(slot.width, TAB_H));
            let resp = interact(&ctx, rect, bar_id.with(("tab", &tab.id)), Sense::click());
            let is_selected = tab.id == selected;

            if is_selected {
                painter.rect_filled(rect, 3u8, accent.linear_multiply(0.22));
                painter.rect_filled(Rect::from_min_size(pos2(rect.min.x, rect.max.y - UNDERLINE_H), vec2(rect.width(), UNDERLINE_H)), 0u8, accent);
            } else if resp.hovered() {
                painter.rect_filled(rect, 3u8, visuals.widgets.hovered.weak_bg_fill);
            }
            let color = if is_selected {
                Color32::WHITE
            } else if resp.hovered() {
                Color32::from_gray(230)
            } else {
                Color32::from_gray(165)
            };
            painter.text(rect.center(), Align2::CENTER_CENTER, &tab.label, font, color);

            if resp.clicked() && !is_selected {
                events.push(TabBarEvent::Selected(tab.id.clone()));
            }
            rects.push((tab.id.clone(), rect));
        }

        // A hairline under the whole strip, so the selected tab's underline reads as sitting on it.
        let base = origin.y + height - 1.0;
        painter.rect_filled(Rect::from_min_size(pos2(origin.x, base), vec2(width, 1.0)), 0u8, Color32::from_gray(60));
        TabBarResponse { events, rects }
    }
}

/// Where one tab goes: its line, its x offset from the bar's left edge, and its width.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TabSlot {
    pub row: usize,
    pub x: f32,
    pub width: f32,
}

/// Places tabs of the given natural widths into a bar `available` points wide. If they all fit
/// on one line they are stretched evenly to fill it; otherwise they keep their natural widths and
/// wrap, and a tab wider than the bar gets a line to itself, clamped to the bar's width.
pub fn layout_tabs(natural: &[f32], available: f32) -> Vec<TabSlot> {
    if natural.is_empty() {
        return Vec::new();
    }
    let gaps = TAB_GAP * (natural.len() as f32 - 1.0);
    let total: f32 = natural.iter().sum::<f32>() + gaps;
    if total <= available {
        let extra = (available - total) / natural.len() as f32;
        let mut x = 0.0;
        return natural
            .iter()
            .map(|w| {
                let slot = TabSlot { row: 0, x, width: w + extra };
                x += w + extra + TAB_GAP;
                slot
            })
            .collect();
    }
    let mut slots = Vec::with_capacity(natural.len());
    let (mut row, mut x) = (0usize, 0.0f32);
    for &w in natural {
        let w = w.min(available);
        if x > 0.0 && x + w > available {
            row += 1;
            x = 0.0;
        }
        slots.push(TabSlot { row, x, width: w });
        x += w + TAB_GAP;
    }
    slots
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tabs_that_fit_stretch_to_fill_one_line() {
        let slots = layout_tabs(&[60.0, 80.0, 60.0], 300.0);
        assert!(slots.iter().all(|s| s.row == 0));
        let last = slots.last().unwrap();
        assert!((last.x + last.width - 300.0).abs() < 1.0e-3);
        assert!((slots[1].x - (slots[0].x + slots[0].width + TAB_GAP)).abs() < 1.0e-3);
    }

    #[test]
    fn tabs_that_do_not_fit_wrap_at_natural_width() {
        let slots = layout_tabs(&[100.0, 100.0, 100.0], 250.0);
        assert_eq!(slots.iter().map(|s| s.row).collect::<Vec<_>>(), vec![0, 0, 1]);
        assert!(slots.iter().all(|s| s.width == 100.0));
        assert_eq!(slots[2].x, 0.0);
    }

    #[test]
    fn a_tab_wider_than_the_bar_is_clamped_and_alone() {
        let slots = layout_tabs(&[40.0, 500.0, 40.0], 200.0);
        assert_eq!(slots[1].width, 200.0);
        assert_eq!(slots.iter().map(|s| s.row).collect::<Vec<_>>(), vec![0, 1, 2]);
    }

    #[test]
    fn no_tabs_lays_out_nothing() {
        assert!(layout_tabs(&[], 200.0).is_empty());
    }
}
