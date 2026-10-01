//! `HeatmapView`: 2D matrix heatmap widget with multi-colormap visualization,
//! interactive cell hover inspection, cell selection, cell value labels, and colorbar legend.
//!
//! Features:
//! * 2D matrix data visualization (`rows` x `cols`) with customizable cell gaps and corner rounding.
//! * Multiple colormaps: Turbo, Magma, Viridis, Phosphor, Warm, Cool.
//! * Automatic or custom min/max value scaling.
//! * Value display inside cells with contrast-adaptive text color (white/dark).
//! * Optional row and column header labels.
//! * Interactive pointer hover inspection reporting (row, col, value, labels).
//! * Interactive cell selection on click emitting `HeatmapEvent::CellClicked`.
//! * Colormap switching pills emitting `HeatmapEvent::ColorMapChanged`.
//! * Gradient colorbar legend with min, mid, and max tick labels.

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Pos2, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::ui::Ui;

// ------------------------------------------------------------------------------------------
// Palette & Constants
// ------------------------------------------------------------------------------------------

const PANEL_TOP: Color32 = Color32::from_rgb(14, 17, 24);
const PANEL_BOTTOM: Color32 = Color32::from_rgb(20, 25, 36);
const PANEL_BORDER: Color32 = Color32::from_white_alpha(35);
const LABEL: Color32 = Color32::from_rgb(130, 140, 165);
const LABEL_BRIGHT: Color32 = Color32::from_rgb(215, 225, 245);
const LABEL_MUTED: Color32 = Color32::from_rgb(90, 100, 120);
const ACCENT_MINT: Color32 = Color32::from_rgb(92, 242, 196);
const TOOLTIP_BG: Color32 = Color32::from_rgba_unmultiplied(12, 15, 22, 240);

// ------------------------------------------------------------------------------------------
// Colormaps
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum HeatmapColorMap {
    #[default]
    Turbo,
    Magma,
    Viridis,
    Phosphor,
    Warm,
    Cool,
}

impl HeatmapColorMap {
    pub const ALL: [HeatmapColorMap; 6] = [
        HeatmapColorMap::Turbo,
        HeatmapColorMap::Magma,
        HeatmapColorMap::Viridis,
        HeatmapColorMap::Phosphor,
        HeatmapColorMap::Warm,
        HeatmapColorMap::Cool,
    ];

    pub fn name(&self) -> &'static str {
        match self {
            Self::Turbo => "Turbo",
            Self::Magma => "Magma",
            Self::Viridis => "Viridis",
            Self::Phosphor => "Phosphor",
            Self::Warm => "Warm",
            Self::Cool => "Cool",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name.to_lowercase().as_str() {
            "turbo" => Some(Self::Turbo),
            "magma" => Some(Self::Magma),
            "viridis" => Some(Self::Viridis),
            "phosphor" => Some(Self::Phosphor),
            "warm" => Some(Self::Warm),
            "cool" => Some(Self::Cool),
            _ => None,
        }
    }

    /// Evaluates colormap at parameter `t` in [0.0, 1.0].
    pub fn color_at(&self, t: f32) -> Color32 {
        let t = t.clamp(0.0, 1.0);
        match self {
            Self::Turbo => {
                let stops: [(f32, Color32); 6] = [
                    (0.0, Color32::from_rgb(10, 14, 26)),
                    (0.2, Color32::from_rgb(32, 75, 185)),
                    (0.4, Color32::from_rgb(28, 175, 160)),
                    (0.6, Color32::from_rgb(140, 215, 50)),
                    (0.8, Color32::from_rgb(250, 110, 25)),
                    (1.0, Color32::from_rgb(255, 245, 220)),
                ];
                for w in stops.windows(2) {
                    if t <= w[1].0 {
                        return w[0].1.lerp(w[1].1, (t - w[0].0) / (w[1].0 - w[0].0));
                    }
                }
                stops[5].1
            }
            Self::Magma => {
                let stops: [(f32, Color32); 5] = [
                    (0.0, Color32::from_rgb(10, 8, 20)),
                    (0.25, Color32::from_rgb(60, 15, 95)),
                    (0.5, Color32::from_rgb(180, 45, 90)),
                    (0.75, Color32::from_rgb(250, 140, 50)),
                    (1.0, Color32::from_rgb(252, 253, 190)),
                ];
                for w in stops.windows(2) {
                    if t <= w[1].0 {
                        return w[0].1.lerp(w[1].1, (t - w[0].0) / (w[1].0 - w[0].0));
                    }
                }
                stops[4].1
            }
            Self::Viridis => {
                let stops: [(f32, Color32); 5] = [
                    (0.0, Color32::from_rgb(68, 1, 84)),
                    (0.25, Color32::from_rgb(59, 82, 139)),
                    (0.5, Color32::from_rgb(33, 145, 140)),
                    (0.75, Color32::from_rgb(94, 201, 98)),
                    (1.0, Color32::from_rgb(253, 231, 37)),
                ];
                for w in stops.windows(2) {
                    if t <= w[1].0 {
                        return w[0].1.lerp(w[1].1, (t - w[0].0) / (w[1].0 - w[0].0));
                    }
                }
                stops[4].1
            }
            Self::Phosphor => {
                let stops: [(f32, Color32); 4] = [
                    (0.0, Color32::from_rgb(10, 14, 20)),
                    (0.3, Color32::from_rgb(18, 65, 60)),
                    (0.7, ACCENT_MINT),
                    (1.0, Color32::from_rgb(240, 255, 250)),
                ];
                for w in stops.windows(2) {
                    if t <= w[1].0 {
                        return w[0].1.lerp(w[1].1, (t - w[0].0) / (w[1].0 - w[0].0));
                    }
                }
                stops[3].1
            }
            Self::Warm => {
                let stops: [(f32, Color32); 5] = [
                    (0.0, Color32::from_rgb(35, 10, 15)),
                    (0.3, Color32::from_rgb(160, 30, 45)),
                    (0.6, Color32::from_rgb(235, 95, 35)),
                    (0.85, Color32::from_rgb(255, 190, 45)),
                    (1.0, Color32::from_rgb(255, 250, 210)),
                ];
                for w in stops.windows(2) {
                    if t <= w[1].0 {
                        return w[0].1.lerp(w[1].1, (t - w[0].0) / (w[1].0 - w[0].0));
                    }
                }
                stops[4].1
            }
            Self::Cool => {
                let stops: [(f32, Color32); 5] = [
                    (0.0, Color32::from_rgb(10, 18, 38)),
                    (0.3, Color32::from_rgb(25, 60, 135)),
                    (0.6, Color32::from_rgb(45, 150, 215)),
                    (0.85, Color32::from_rgb(110, 225, 245)),
                    (1.0, Color32::from_rgb(235, 252, 255)),
                ];
                for w in stops.windows(2) {
                    if t <= w[1].0 {
                        return w[0].1.lerp(w[1].1, (t - w[0].0) / (w[1].0 - w[0].0));
                    }
                }
                stops[4].1
            }
        }
    }
}

/// Chooses contrast-adaptive text color based on perceived background luminance.
pub fn text_color_for_bg(bg: Color32) -> Color32 {
    let [r, g, b, _] = bg.0;
    let lum = 0.299 * (r as f32) + 0.587 * (g as f32) + 0.114 * (b as f32);
    if lum > 140.0 {
        Color32::from_rgb(16, 20, 28)
    } else {
        Color32::from_rgb(240, 245, 255)
    }
}

pub fn format_value(val: f32, precision: usize) -> String {
    if !val.is_finite() {
        return "-".to_string();
    }
    if val.abs() >= 1000.0 {
        format!("{:.0}", val)
    } else {
        match precision {
            0 => format!("{:.0}", val),
            1 => format!("{:.1}", val),
            2 => format!("{:.2}", val),
            _ => format!("{:.3}", val),
        }
    }
}

// ------------------------------------------------------------------------------------------
// Options & Configuration
// ------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct HeatmapOptions {
    pub colormap: HeatmapColorMap,
    pub min_value: Option<f32>,
    pub max_value: Option<f32>,
    pub show_values: bool,
    pub value_precision: usize,
    pub show_colorbar: bool,
    pub show_labels: bool,
    pub show_toolbar: bool,
    pub row_labels: Vec<String>,
    pub col_labels: Vec<String>,
    pub title: Option<String>,
    pub cell_gap: f32,
    pub cell_radius: f32,
    pub width: Option<f32>,
    pub height: Option<f32>,
    pub selected_cell: Option<(usize, usize)>,
}

impl Default for HeatmapOptions {
    fn default() -> Self {
        Self {
            colormap: HeatmapColorMap::Turbo,
            min_value: None,
            max_value: None,
            show_values: true,
            value_precision: 1,
            show_colorbar: true,
            show_labels: true,
            show_toolbar: true,
            row_labels: Vec::new(),
            col_labels: Vec::new(),
            title: None,
            cell_gap: 2.0,
            cell_radius: 3.0,
            width: None,
            height: Some(320.0),
            selected_cell: None,
        }
    }
}

// ------------------------------------------------------------------------------------------
// Events & Response
// ------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub enum HeatmapEvent {
    CellClicked {
        row: usize,
        col: usize,
        value: f32,
    },
    CellHovered {
        row: usize,
        col: usize,
        value: f32,
    },
    ColorMapChanged(HeatmapColorMap),
}

#[derive(Clone, Debug, PartialEq)]
pub struct HeatmapHover {
    pub row: usize,
    pub col: usize,
    pub value: f32,
    pub row_label: Option<String>,
    pub col_label: Option<String>,
    pub rect: Rect,
}

#[derive(Clone, Debug)]
pub struct HeatmapResponse {
    pub rect: Rect,
    pub grid_rect: Rect,
    pub events: Vec<HeatmapEvent>,
    pub hover: Option<HeatmapHover>,
    pub selected_cell: Option<(usize, usize)>,
}

#[derive(Clone, Debug, Default)]
struct HeatmapState {
    colormap: HeatmapColorMap,
    selected_cell: Option<(usize, usize)>,
}

// ------------------------------------------------------------------------------------------
// Widget Implementation
// ------------------------------------------------------------------------------------------

pub struct HeatmapView {
    id: Id,
    options: HeatmapOptions,
}

impl HeatmapView {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self {
            id: Id::new("heatmap_view").with(id_salt),
            options: HeatmapOptions::default(),
        }
    }

    pub fn options(mut self, options: HeatmapOptions) -> Self {
        self.options = options;
        self
    }

    /// Renders 2D grid matrix with `rows` and `cols` from flat `data` slice.
    pub fn show(self, ui: &mut Ui, rows: usize, cols: usize, data: &[f32]) -> HeatmapResponse {
        let ctx = ui.ctx().clone();
        let opts = self.options;
        let width = opts.width.unwrap_or_else(|| ui.available_size().x.max(280.0));
        let height = opts.height.unwrap_or(320.0).max(180.0);
        let (resp, painter) = ui.allocate_painter(vec2(width, height), Sense::click());
        let rect = resp.rect;

        let pointer = ctx.input(|i| i.pointer);
        let pos = pointer.pos;

        let mut st: HeatmapState = ctx.memory_mut(|m| m.take_view_state(self.id));
        if st.colormap == HeatmapColorMap::Turbo && opts.colormap != HeatmapColorMap::Turbo {
            st.colormap = opts.colormap;
        }
        if opts.selected_cell.is_some() {
            st.selected_cell = opts.selected_cell;
        }

        let mut events: Vec<HeatmapEvent> = Vec::new();

        // 1. Panel Background
        painter.rect_filled_gradient(rect, PANEL_TOP, PANEL_TOP, PANEL_BOTTOM, PANEL_BOTTOM);
        painter.rect_stroke(rect, 6u8, Stroke::new(1.0, PANEL_BORDER), StrokeKind::Middle);

        // 2. Toolbar & Header
        let header_h = if opts.title.is_some() || opts.show_toolbar { 32.0 } else { 8.0 };
        let toolbar_rect = Rect::from_min_size(rect.min, vec2(rect.width(), header_h));

        let mut pill_rects: Vec<(HeatmapColorMap, Rect)> = Vec::new();
        if opts.show_toolbar {
            let pill_h = 20.0;
            let pill_y = rect.min.y + 6.0;
            let mut pill_right = rect.max.x - 10.0;

            for &cm in HeatmapColorMap::ALL.iter().rev() {
                let name = cm.name();
                let text_w = Painter::measure_text(&ctx, FontId::proportional(10.5), name).x;
                let pill_w = text_w + 14.0;
                pill_right -= pill_w;
                let p_rect = Rect::from_min_size(pos2(pill_right, pill_y), vec2(pill_w, pill_h));
                pill_rects.push((cm, p_rect));
                pill_right -= 4.0;
            }
        }

        // Draw title
        if let Some(ref title) = opts.title {
            let title_y = rect.min.y + 16.0;
            painter.text(
                pos2(rect.min.x + 12.0, title_y),
                Align2::LEFT_CENTER,
                title,
                FontId::proportional(12.5),
                LABEL_BRIGHT,
            );
        }

        // Check toolbar clicks & draw pills
        if opts.show_toolbar {
            for (cm, p_rect) in &pill_rects {
                let active = *cm == st.colormap;
                let hovered = pos.is_some_and(|p| p_rect.contains(p));

                if hovered && pointer.primary_pressed {
                    st.colormap = *cm;
                    events.push(HeatmapEvent::ColorMapChanged(*cm));
                }

                if active {
                    painter.rect_filled(*p_rect, 4u8, Color32::from_rgba_unmultiplied(92, 242, 196, 60));
                    painter.rect_stroke(*p_rect, 4u8, Stroke::new(1.0, ACCENT_MINT), StrokeKind::Middle);
                } else if hovered {
                    painter.rect_filled(*p_rect, 4u8, Color32::from_white_alpha(30));
                    painter.rect_stroke(*p_rect, 4u8, Stroke::new(1.0, Color32::from_white_alpha(60)), StrokeKind::Middle);
                } else {
                    painter.rect_filled(*p_rect, 4u8, Color32::from_white_alpha(12));
                    painter.rect_stroke(*p_rect, 4u8, Stroke::new(1.0, Color32::from_white_alpha(24)), StrokeKind::Middle);
                }

                let text_color = if active {
                    ACCENT_MINT
                } else if hovered {
                    LABEL_BRIGHT
                } else {
                    LABEL
                };

                painter.text(
                    p_rect.center(),
                    Align2::CENTER_CENTER,
                    cm.name(),
                    FontId::proportional(10.5),
                    text_color,
                );
            }
        }

        // 3. Layout calculation for grid, labels, and colorbar
        let colorbar_w = if opts.show_colorbar { 54.0 } else { 0.0 };

        // Determine row label width
        let mut row_label_w = 0.0f32;
        if opts.show_labels && !opts.row_labels.is_empty() {
            let max_w = opts
                .row_labels
                .iter()
                .map(|l| Painter::measure_text(&ctx, FontId::proportional(10.0), l).x)
                .fold(0.0f32, f32::max);
            row_label_w = (max_w + 10.0).max(36.0);
        }

        let col_label_h = if opts.show_labels && !opts.col_labels.is_empty() { 20.0 } else { 0.0 };

        let padding_x = 10.0;
        let padding_y = 10.0;
        let grid_min_x = rect.min.x + padding_x + row_label_w;
        let grid_min_y = rect.min.y + header_h + col_label_h + 4.0;
        let grid_max_x = rect.max.x - padding_x - colorbar_w;
        let grid_max_y = rect.max.y - padding_y;

        let grid_w = (grid_max_x - grid_min_x).max(20.0);
        let grid_h = (grid_max_y - grid_min_y).max(20.0);
        let grid_rect = Rect::from_min_size(pos2(grid_min_x, grid_min_y), vec2(grid_w, grid_h));

        // 4. Data Min & Max computation
        let (mut data_min, mut data_max) = if data.is_empty() {
            (0.0, 1.0)
        } else {
            let (mn, mx) = data.iter().fold((f32::MAX, f32::MIN), |(a, b), &v| {
                if v.is_finite() {
                    (a.min(v), b.max(v))
                } else {
                    (a, b)
                }
            });
            if mn <= mx {
                (mn, mx)
            } else {
                (0.0, 1.0)
            }
        };

        if let Some(c_min) = opts.min_value {
            data_min = c_min;
        }
        if let Some(c_max) = opts.max_value {
            data_max = c_max;
        }
        if (data_max - data_min).abs() < 1.0e-5 {
            data_max = data_min + 1.0;
        }

        // 5. Draw Column Labels
        if opts.show_labels && !opts.col_labels.is_empty() && cols > 0 {
            let cell_w = (grid_w - (cols.saturating_sub(1) as f32) * opts.cell_gap) / (cols as f32);
            for c in 0..cols {
                if let Some(label) = opts.col_labels.get(c) {
                    let cx = grid_min_x + (c as f32) * (cell_w + opts.cell_gap) + cell_w * 0.5;
                    let cy = grid_min_y - col_label_h * 0.5;
                    painter.text(
                        pos2(cx, cy),
                        Align2::CENTER_CENTER,
                        label,
                        FontId::proportional(10.0),
                        LABEL,
                    );
                }
            }
        }

        // 6. Draw Row Labels
        if opts.show_labels && !opts.row_labels.is_empty() && rows > 0 {
            let cell_h = (grid_h - (rows.saturating_sub(1) as f32) * opts.cell_gap) / (rows as f32);
            for r in 0..rows {
                if let Some(label) = opts.row_labels.get(r) {
                    let rx = grid_min_x - 6.0;
                    let ry = grid_min_y + (r as f32) * (cell_h + opts.cell_gap) + cell_h * 0.5;
                    painter.text(
                        pos2(rx, ry),
                        Align2::RIGHT_CENTER,
                        label,
                        FontId::proportional(10.0),
                        LABEL,
                    );
                }
            }
        }

        // 7. Render Cells
        let mut hover_cell: Option<HeatmapHover> = None;

        if rows > 0 && cols > 0 {
            let cell_w = ((grid_w - (cols.saturating_sub(1) as f32) * opts.cell_gap) / (cols as f32)).max(1.0);
            let cell_h = ((grid_h - (rows.saturating_sub(1) as f32) * opts.cell_gap) / (rows as f32)).max(1.0);

            for r in 0..rows {
                for c in 0..cols {
                    let idx = r * cols + c;
                    let val = data.get(idx).copied().unwrap_or(0.0);
                    let norm = ((val - data_min) / (data_max - data_min)).clamp(0.0, 1.0);
                    let cell_color = st.colormap.color_at(norm);

                    let x0 = grid_min_x + (c as f32) * (cell_w + opts.cell_gap);
                    let y0 = grid_min_y + (r as f32) * (cell_h + opts.cell_gap);
                    let cell_rect = Rect::from_min_size(pos2(x0, y0), vec2(cell_w, cell_h));

                    let is_hovered = pos.is_some_and(|p| cell_rect.contains(p));
                    let is_selected = st.selected_cell == Some((r, c));

                    if is_hovered {
                        hover_cell = Some(HeatmapHover {
                            row: r,
                            col: c,
                            value: val,
                            row_label: opts.row_labels.get(r).cloned(),
                            col_label: opts.col_labels.get(c).cloned(),
                            rect: cell_rect,
                        });
                        events.push(HeatmapEvent::CellHovered { row: r, col: c, value: val });

                        if pointer.primary_pressed {
                            st.selected_cell = Some((r, c));
                            events.push(HeatmapEvent::CellClicked { row: r, col: c, value: val });
                        }
                    }

                    // Render cell body
                    let rad = opts.cell_radius.min(cell_w * 0.4).min(cell_h * 0.4);
                    painter.rect_filled(cell_rect, rad as u8, cell_color);

                    // Cell border
                    if is_selected {
                        painter.rect_stroke(
                            cell_rect.expand(1.5),
                            (rad + 1.0) as u8,
                            Stroke::new(2.0, ACCENT_MINT),
                            StrokeKind::Middle,
                        );
                    } else if is_hovered {
                        painter.rect_stroke(
                            cell_rect.expand(1.0),
                            (rad + 1.0) as u8,
                            Stroke::new(1.5, Color32::WHITE),
                            StrokeKind::Middle,
                        );
                    } else if opts.cell_gap == 0.0 {
                        painter.rect_stroke(
                            cell_rect,
                            0u8,
                            Stroke::new(0.5, Color32::from_white_alpha(15)),
                            StrokeKind::Middle,
                        );
                    }

                    // Render cell value text if enabled and space permits
                    if opts.show_values && cell_w >= 26.0 && cell_h >= 14.0 {
                        let text_val = format_value(val, opts.value_precision);
                        let text_col = text_color_for_bg(cell_color);
                        let font_sz = (cell_h * 0.42).clamp(8.5, 12.0);
                        painter.text(
                            cell_rect.center(),
                            Align2::CENTER_CENTER,
                            text_val,
                            FontId::proportional(font_sz),
                            text_col,
                        );
                    }
                }
            }
        }

        // 8. Render Colorbar Legend
        if opts.show_colorbar {
            let bar_x = rect.max.x - padding_x - colorbar_w + 14.0;
            let bar_w = 12.0;
            let bar_y0 = grid_min_y;
            let bar_h = grid_h;
            let bar_rect = Rect::from_min_size(pos2(bar_x, bar_y0), vec2(bar_w, bar_h));

            // Gradient slices from top (max) to bottom (min)
            let slices = 32;
            let slice_h = bar_h / (slices as f32);
            for s in 0..slices {
                // Top of bar is max value (t = 1.0), bottom is min (t = 0.0)
                let t_top = 1.0 - (s as f32) / (slices as f32);
                let t_bot = 1.0 - ((s + 1) as f32) / (slices as f32);
                let t_mid = (t_top + t_bot) * 0.5;
                let c = st.colormap.color_at(t_mid);
                let s_rect = Rect::from_min_size(pos2(bar_x, bar_y0 + (s as f32) * slice_h), vec2(bar_w, slice_h + 0.5));
                painter.rect_filled(s_rect, 0u8, c);
            }
            painter.rect_stroke(bar_rect, 2u8, Stroke::new(1.0, Color32::from_white_alpha(50)), StrokeKind::Middle);

            // Tick labels
            let label_x = bar_x + bar_w + 5.0;
            // Max tick
            painter.text(
                pos2(label_x, bar_y0),
                Align2::LEFT_TOP,
                format_value(data_max, opts.value_precision),
                FontId::proportional(9.0),
                LABEL,
            );
            // Mid tick
            let mid_v = (data_min + data_max) * 0.5;
            painter.text(
                pos2(label_x, bar_y0 + bar_h * 0.5),
                Align2::LEFT_CENTER,
                format_value(mid_v, opts.value_precision),
                FontId::proportional(9.0),
                LABEL_MUTED,
            );
            // Min tick
            painter.text(
                pos2(label_x, bar_y0 + bar_h),
                Align2::LEFT_BOTTOM,
                format_value(data_min, opts.value_precision),
                FontId::proportional(9.0),
                LABEL,
            );
        }

        // 9. Floating Hover Readout / Tooltip
        if let Some(ref h) = hover_cell {
            let row_str = h.row_label.as_deref().unwrap_or("");
            let col_str = h.col_label.as_deref().unwrap_or("");
            let val_str = format_value(h.value, opts.value_precision.max(2));

            let tip_text = if !row_str.is_empty() && !col_str.is_empty() {
                format!("{row_str}, {col_str}: {val_str}")
            } else if !row_str.is_empty() {
                format!("{row_str} [col {}]: {val_str}", h.col + 1)
            } else if !col_str.is_empty() {
                format!("[row {}], {col_str}: {val_str}", h.row + 1)
            } else {
                format!("Row {}, Col {}: {val_str}", h.row + 1, h.col + 1)
            };

            let font = FontId::proportional(11.0);
            let text_size = Painter::measure_text(&ctx, font, &tip_text);
            let tip_pad_x = 8.0;
            let tip_pad_y = 5.0;
            let tip_w = text_size.x + tip_pad_x * 2.0;
            let tip_h = text_size.y + tip_pad_y * 2.0;

            // Place tooltip above or below cell
            let mut tip_x = h.rect.center().x - tip_w * 0.5;
            tip_x = tip_x.clamp(rect.min.x + 4.0, rect.max.x - tip_w - 4.0);

            let tip_y = if h.rect.min.y - tip_h - 4.0 >= rect.min.y {
                h.rect.min.y - tip_h - 4.0
            } else {
                h.rect.max.y + 4.0
            };

            let tip_rect = Rect::from_min_size(pos2(tip_x, tip_y), vec2(tip_w, tip_h));
            painter.rect_filled(tip_rect, 4u8, TOOLTIP_BG);
            painter.rect_stroke(tip_rect, 4u8, Stroke::new(1.0, Color32::from_white_alpha(70)), StrokeKind::Middle);
            painter.text(
                tip_rect.center(),
                Align2::CENTER_CENTER,
                tip_text,
                font,
                LABEL_BRIGHT,
            );
        }

        // Save state back to context memory
        ctx.memory_mut(|m| m.put_view_state(self.id, st.clone()));

        HeatmapResponse {
            rect,
            grid_rect,
            events,
            hover: hover_cell,
            selected_cell: st.selected_cell,
        }
    }

    /// Convenience wrapper taking 2D slice of rows.
    pub fn show_grid(self, ui: &mut Ui, grid: &[Vec<f32>]) -> HeatmapResponse {
        let rows = grid.len();
        let cols = grid.first().map(|r| r.len()).unwrap_or(0);
        let flat: Vec<f32> = grid.iter().flat_map(|r| r.iter().copied()).collect();
        self.show(ui, rows, cols, &flat)
    }
}
