//! Docking UI — renders a `DockState<Tab>` tree: recursively lays out `Split` nodes with a
//! draggable divider, and `Leaf` nodes as a tab bar (click to select) over the active tab's
//! content. See `tree.rs`'s module docs for exactly what's in v1 vs. deliberately deferred.

pub mod tree;
pub use tree::{DockState, NodeIndex, Orientation, Surface};

use crate::entropy_gui::color::Color32;
use crate::entropy_gui::geometry::{pos2, vec2, Align, Align2, CursorIcon, Layout, Rect};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::style::DEFAULT_FONT_SIZE;
use crate::entropy_gui::ui::{interact, Ui};
use crate::entropy_gui::{FontId, WidgetText};
use tree::Node;

pub trait TabViewer {
    type Tab;
    fn title(&mut self, tab: &mut Self::Tab) -> WidgetText;
    fn ui(&mut self, ui: &mut Ui, tab: &mut Self::Tab);
}

/// Cosmetic-only mapping from the app's `Style` — matches `egui_dock::Style::from_egui`'s
/// call shape (`Style::from_egui(ctx.style().as_ref())`).
pub struct Style {
    pub tab_bg: Color32,
    pub hovered_tab_bg: Color32,
    pub active_tab_bg: Color32,
    pub accent: Color32,
    pub text_color: Color32,
    pub divider_color: Color32,
}

impl Style {
    pub fn from_egui(style: &crate::entropy_gui::style::Style) -> Self {
        let v = &style.visuals;
        Self {
            tab_bg: v.panel_fill,
            hovered_tab_bg: v.widgets.hovered.bg_fill,
            active_tab_bg: v.widgets.active.weak_bg_fill,
            accent: v.selection.stroke.color,
            text_color: v.override_text_color.unwrap_or(Color32::from_gray(220)),
            divider_color: v.widgets.noninteractive.bg_stroke.color,
        }
    }
}

pub struct DockArea<'a, Tab> {
    dock_state: &'a mut DockState<Tab>,
    style: Option<Style>,
}

impl<'a, Tab> DockArea<'a, Tab> {
    pub fn new(dock_state: &'a mut DockState<Tab>) -> Self {
        Self { dock_state, style: None }
    }

    pub fn style(mut self, style: Style) -> Self {
        self.style = Some(style);
        self
    }

    pub fn show_inside(self, ui: &mut Ui, viewer: &mut impl TabViewer<Tab = Tab>) {
        let style = self.style.unwrap_or_else(|| Style::from_egui(&ui.style()));
        let region = ui.available_rect_before_wrap();
        render_node(ui, self.dock_state.main_surface_mut(), NodeIndex::root(), region, &style, viewer);
        ui.advance_after_child(region);
    }
}

fn idx_id(idx: NodeIndex) -> Id {
    Id::new(("dock_leaf", idx.0))
}

fn render_node<Tab>(ui: &mut Ui, surface: &mut Surface<Tab>, idx: NodeIndex, rect: Rect, style: &Style, viewer: &mut impl TabViewer<Tab = Tab>) {
    let kind = match &surface.nodes[idx.0] {
        Node::Split { fraction, orientation, children } => Some((*fraction, *orientation, *children)),
        Node::Leaf { .. } => None,
    };

    let Some((fraction, orientation, children)) = kind else {
        render_leaf(ui, surface, idx, rect, style, viewer);
        return;
    };

    let thickness = 4.0;
    let (rect_a, rect_b, splitter_rect) = match orientation {
        Orientation::Horizontal => {
            let split_x = rect.min.x + rect.width() * fraction;
            (
                Rect::from_min_max(rect.min, pos2(split_x - thickness / 2.0, rect.max.y)),
                Rect::from_min_max(pos2(split_x + thickness / 2.0, rect.min.y), rect.max),
                Rect::from_min_max(pos2(split_x - thickness / 2.0, rect.min.y), pos2(split_x + thickness / 2.0, rect.max.y)),
            )
        }
        Orientation::Vertical => {
            let split_y = rect.min.y + rect.height() * fraction;
            (
                Rect::from_min_max(rect.min, pos2(rect.max.x, split_y - thickness / 2.0)),
                Rect::from_min_max(pos2(rect.min.x, split_y + thickness / 2.0), rect.max),
                Rect::from_min_max(pos2(rect.min.x, split_y - thickness / 2.0), pos2(rect.max.x, split_y + thickness / 2.0)),
            )
        }
    };

    let splitter_id = ui.id().with(("dock_splitter", idx.0));
    let resp = interact(ui.ctx(), splitter_rect, splitter_id, Sense::drag());
    if resp.dragged() {
        let delta = match orientation {
            Orientation::Horizontal => resp.drag_delta().x / rect.width().max(1.0),
            Orientation::Vertical => resp.drag_delta().y / rect.height().max(1.0),
        };
        let new_fraction = (fraction + delta).clamp(0.05, 0.95);
        if let Node::Split { fraction: f, .. } = &mut surface.nodes[idx.0] {
            *f = new_fraction;
        }
    }
    if resp.hovered() || resp.dragged() {
        let icon = match orientation {
            Orientation::Horizontal => CursorIcon::ResizeHorizontal,
            Orientation::Vertical => CursorIcon::ResizeVertical,
        };
        ui.ctx().request_cursor_icon(icon);
    }
    ui.painter().rect_filled(splitter_rect, 0u8, style.divider_color);

    render_node(ui, surface, children[0], rect_a, style, viewer);
    render_node(ui, surface, children[1], rect_b, style, viewer);
}

fn render_leaf<Tab>(ui: &mut Ui, surface: &mut Surface<Tab>, idx: NodeIndex, rect: Rect, style: &Style, viewer: &mut impl TabViewer<Tab = Tab>) {
    let tab_bar_h = 30.0;
    let content_margin = 10.0; // thematic padding
    let tab_bar_rect = Rect::from_min_max(rect.min, pos2(rect.max.x, rect.min.y + tab_bar_h));
    // `unclipped_content_rect` is the full area below the tab bar, used only to build the clip
    // rect. `content_rect` (shrunk by the margin) is what widgets actually lay out into. Clipping
    // to the *unshrunk* rect gives widgets sitting flush against the padded edge room for their
    // border stroke / AA fringe, instead of slicing it off exactly at the layout boundary.
    let unclipped_content_rect = Rect::from_min_max(pos2(rect.min.x, rect.min.y + tab_bar_h), rect.max);
    let content_rect = unclipped_content_rect.shrink(content_margin);
    let font = FontId::proportional(DEFAULT_FONT_SIZE);

    ui.painter().rect_filled(tab_bar_rect, 0u8, style.tab_bg);

    let tab_count = if let Node::Leaf { tabs, .. } = &surface.nodes[idx.0] { tabs.len() } else { 0 };

    let mut x = tab_bar_rect.min.x + 6.0;
    for i in 0..tab_count {
        let title = if let Node::Leaf { tabs, .. } = &mut surface.nodes[idx.0] { viewer.title(&mut tabs[i]).0.text } else { String::new() };
        let text_size = Painter::measure_text(ui.ctx(), font, &title);
        let tab_w = text_size.x + 20.0;
        let tab_rect = Rect::from_min_size(pos2(x, tab_bar_rect.min.y), vec2(tab_w, tab_bar_h));
        let tab_id = ui.id().with(("dock_tab", idx.0, i));
        let resp = interact(ui.ctx(), tab_rect, tab_id, Sense::click());

        if resp.clicked() {
            if let Node::Leaf { active, .. } = &mut surface.nodes[idx.0] {
                *active = i;
            }
        }
        let is_active = if let Node::Leaf { active, .. } = &surface.nodes[idx.0] { *active == i } else { false };

        let bg = if is_active {
            style.active_tab_bg
        } else if resp.hovered() {
            style.hovered_tab_bg
        } else {
            style.tab_bg
        };
        ui.painter().rect_filled(tab_rect, 0u8, bg);
        if is_active {
            let underline = Rect::from_min_max(pos2(tab_rect.min.x, tab_rect.max.y - 2.0), tab_rect.max);
            ui.painter().rect_filled(underline, 0u8, style.accent);
        }
        ui.painter().text(pos2(tab_rect.min.x + 8.0, tab_rect.center().y), Align2::LEFT_CENTER, &title, font, style.text_color);

        x += tab_w;
    }

    let active_idx = if let Node::Leaf { active, .. } = &surface.nodes[idx.0] { *active } else { 0 };
    if let Node::Leaf { tabs, .. } = &mut surface.nodes[idx.0] {
        if let Some(tab) = tabs.get_mut(active_idx) {
            let clip = ui.clip_rect.intersect(unclipped_content_rect);
            let mut child_ui = Ui::new(ui.ctx().clone(), idx_id(idx), content_rect, Layout::top_down(Align::Min), clip, ui.draw_target);
            viewer.ui(&mut child_ui, tab);
        }
    }
}
