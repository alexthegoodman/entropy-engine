//! Headless tier for `entropy_gui::HeatmapView`.
//!
//! `tests/features/heatmap.feature` runs against the real widget inside a headless
//! `entropy_gui::Context`, one frame at a time. Pointer input is built the way the
//! window backend builds it (hover frames, press frames, click frames).
//! What is drawn is rasterized on the CPU (`tests/common/raster.rs`), verifying pixels
//! and interaction facts. Pictures land in `test-artifacts/heatmap/`.

use std::path::PathBuf;

use cucumber::{given, then, when, World as _};
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::draw_list::DrawCommand;
use entropy_engine::entropy_gui::geometry::{pos2, Pos2};
use entropy_engine::entropy_gui::{
    HeatmapColorMap, HeatmapEvent, HeatmapOptions, HeatmapResponse, HeatmapView,
};
use image::RgbaImage;

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

fn artifacts_dir() -> PathBuf {
    let dir = PathBuf::from("test-artifacts/heatmap");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[derive(cucumber::World)]
struct HeatmapWorld {
    h: Harness,
    rows: usize,
    cols: usize,
    data: Vec<f32>,
    opts: HeatmapOptions,
    resp: Option<HeatmapResponse>,
    events: Vec<HeatmapEvent>,
    pending: Vec<DrawCommand>,
    image: Option<RgbaImage>,
    primary: bool,
    pos: Option<Pos2>,
}

impl std::fmt::Debug for HeatmapWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "HeatmapWorld({}x{})", self.rows, self.cols)
    }
}

impl Default for HeatmapWorld {
    fn default() -> Self {
        Self {
            h: Harness::new(960, 680),
            rows: 0,
            cols: 0,
            data: Vec::new(),
            opts: HeatmapOptions {
                width: Some(920.0),
                height: Some(640.0),
                ..Default::default()
            },
            resp: None,
            events: Vec::new(),
            pending: Vec::new(),
            image: None,
            primary: false,
            pos: None,
        }
    }
}

impl HeatmapWorld {
    fn pointer(&self, pos: Option<Pos2>, pressed: bool, released: bool) -> PointerState {
        PointerState {
            pos,
            primary_down: self.primary,
            primary_pressed: pressed,
            primary_released: released,
            ..Default::default()
        }
    }

    fn frame_with(&mut self, pointer: PointerState, scroll: f32) {
        let opts = self.opts.clone();
        let rows = self.rows;
        let cols = self.cols;
        let data = self.data.clone();
        let mut out = None;
        self.pending = self.h.run(pointer, scroll, |ui| {
            out = Some(HeatmapView::new("test_heatmap").options(opts).show(ui, rows, cols, &data));
        });
        let resp = out.expect("the heatmap widget was not drawn");
        for e in &resp.events {
            if let HeatmapEvent::ColorMapChanged(cm) = e {
                self.opts.colormap = *cm;
            }
        }
        self.events.extend(resp.events.iter().cloned());
        self.resp = Some(resp);
        self.image = None;
        self.pos = pointer.pos;
    }

    fn frame(&mut self) {
        let p = self.pointer(self.pos, false, false);
        self.frame_with(p, 0.0);
    }

    fn hover(&mut self, p: Pos2) {
        let s = self.pointer(Some(p), false, false);
        self.frame_with(s, 0.0);
    }

    fn press(&mut self, p: Pos2) {
        self.hover(p);
        self.primary = true;
        let s = self.pointer(Some(p), true, false);
        self.frame_with(s, 0.0);
    }

    fn release(&mut self) {
        self.primary = false;
        let s = self.pointer(self.pos, false, true);
        self.frame_with(s, 0.0);
    }

    fn click(&mut self, p: Pos2) {
        self.press(p);
        self.release();
    }

    fn picture(&mut self) -> RgbaImage {
        if self.image.is_none() {
            if self.pending.is_empty() {
                self.frame();
            }
            self.image = Some(self.h.render(&self.pending));
        }
        self.image.clone().unwrap()
    }

    fn cell_center(&self, r: usize, c: usize) -> Pos2 {
        let resp = self.resp.as_ref().expect("frame must be drawn before querying cell center");
        let grid = resp.grid_rect;
        let gap = self.opts.cell_gap;
        let cell_w = (grid.width() - (self.cols.saturating_sub(1) as f32) * gap) / (self.cols as f32);
        let cell_h = (grid.height() - (self.rows.saturating_sub(1) as f32) * gap) / (self.rows as f32);
        let x = grid.min.x + (c as f32) * (cell_w + gap) + cell_w * 0.5;
        let y = grid.min.y + (r as f32) * (cell_h + gap) + cell_h * 0.5;
        pos2(x, y)
    }
}

// ------------------------------------------------------------------------------------------
// Step Definitions
// ------------------------------------------------------------------------------------------

#[given(regex = r"^a heatmap with (\d+) rows and (\d+) columns of matrix data$")]
fn given_matrix_data(world: &mut HeatmapWorld, rows: usize, cols: usize) {
    world.rows = rows;
    world.cols = cols;
    world.data = Vec::with_capacity(rows * cols);
    for r in 0..rows {
        for c in 0..cols {
            // Gradient pattern across rows and columns (e.g. 10.0 to 100.0)
            let val = 10.0 + (r as f32) * 15.0 + (c as f32) * 12.0;
            world.data.push(val);
        }
    }
    world.frame();
}

#[given(expr = "row labels {string} and col labels {string}")]
fn given_labels(world: &mut HeatmapWorld, row_str: String, col_str: String) {
    world.opts.row_labels = row_str.split(',').map(|s| s.trim().to_string()).collect();
    world.opts.col_labels = col_str.split(',').map(|s| s.trim().to_string()).collect();
    world.frame();
}

#[given(expr = "the heatmap colormap is {string}")]
fn given_colormap(world: &mut HeatmapWorld, cm_name: String) {
    if let Some(cm) = HeatmapColorMap::from_name(&cm_name) {
        world.opts.colormap = cm;
    }
    world.frame();
}

#[given(regex = r"^the min value is ([0-9.]+) and max value is ([0-9.]+)$")]
fn given_min_max(world: &mut HeatmapWorld, mn: f32, mx: f32) {
    world.opts.min_value = Some(mn);
    world.opts.max_value = Some(mx);
    world.frame();
}

#[when(expr = "a frame is drawn")]
fn when_frame_drawn(world: &mut HeatmapWorld) {
    world.frame();
}

#[when(expr = "the heatmap colormap is set to {string}")]
fn when_set_colormap(world: &mut HeatmapWorld, cm_name: String) {
    if let Some(cm) = HeatmapColorMap::from_name(&cm_name) {
        world.opts.colormap = cm;
    }
    world.frame();
}

#[when(regex = r"^I hover over row (\d+) column (\d+)$")]
fn when_hover_cell(world: &mut HeatmapWorld, row: usize, col: usize) {
    let pt = world.cell_center(row, col);
    world.hover(pt);
}

#[when(regex = r"^I click row (\d+) column (\d+)$")]
fn when_click_cell(world: &mut HeatmapWorld, row: usize, col: usize) {
    let pt = world.cell_center(row, col);
    world.click(pt);
}

#[when(expr = "I click the colormap pill {string}")]
fn when_click_colormap_pill(world: &mut HeatmapWorld, cm_name: String) {
    // Colormap pills are drawn at top right
    let target_cm = HeatmapColorMap::from_name(&cm_name).expect("unknown colormap");
    let resp = world.resp.as_ref().unwrap();
    let rect = resp.rect;
    let pill_y = rect.min.y + 16.0;

    // Estimate pill X from reversed order: Cool, Warm, Phosphor, Viridis, Magma, Turbo
    let idx = HeatmapColorMap::ALL.iter().rev().position(|&c| c == target_cm).unwrap();
    // Rough offset from right
    let pill_x = rect.max.x - 20.0 - (idx as f32) * 58.0;
    world.click(pos2(pill_x, pill_y));
}

#[then(expr = "the heatmap space is not blank")]
fn then_not_blank(world: &mut HeatmapWorld) {
    let img = world.picture();
    let resp = world.resp.as_ref().unwrap();
    let gr = resp.grid_rect;
    let mut non_bg = 0;
    for y in (gr.min.y as u32)..(gr.max.y as u32) {
        for x in (gr.min.x as u32)..(gr.max.x as u32) {
            let p = img.get_pixel(x, y);
            // Window background is around [23, 25, 30]
            if p[0] > 35 || p[1] > 35 || p[2] > 40 {
                non_bg += 1;
            }
        }
    }
    assert!(non_bg > 500, "heatmap space is unexpectedly blank");
}

#[then(expr = "the colorbar legend is rendered")]
fn then_colorbar_rendered(world: &mut HeatmapWorld) {
    let resp = world.resp.as_ref().unwrap();
    assert!(resp.grid_rect.width() > 100.0);
    assert!(resp.rect.width() > resp.grid_rect.width() + 40.0);
}

#[then(expr = "there is phosphor mint in the heatmap")]
fn then_phosphor_mint(world: &mut HeatmapWorld) {
    let img = world.picture();
    let mut mint_pixels = 0;
    for p in img.pixels() {
        // Mint color is around [92, 242, 196]
        if p[1] > 180 && p[0] < 150 && p[2] > 140 {
            mint_pixels += 1;
        }
    }
    assert!(mint_pixels > 50, "expected phosphor mint pixels in heatmap, found {mint_pixels}");
}

#[then(expr = "a hover tooltip is displayed with row {string} and column {string}")]
fn then_hover_tooltip(world: &mut HeatmapWorld, expected_row: String, expected_col: String) {
    let resp = world.resp.as_ref().unwrap();
    let h = resp.hover.as_ref().expect("expected hover info");
    assert_eq!(h.row_label.as_deref(), Some(expected_row.as_str()));
    assert_eq!(h.col_label.as_deref(), Some(expected_col.as_str()));
}

#[then(regex = r"^a cell hover event was emitted for row (\d+) and column (\d+)$")]
fn then_hover_event(world: &mut HeatmapWorld, row: usize, col: usize) {
    let found = world.events.iter().any(|e| matches!(e, HeatmapEvent::CellHovered { row: r, col: c, .. } if *r == row && *c == col));
    assert!(found, "expected CellHovered event for ({row}, {col})");
}

#[then(regex = r"^a cell clicked event was emitted for row (\d+) and column (\d+)$")]
fn then_click_event(world: &mut HeatmapWorld, row: usize, col: usize) {
    let found = world.events.iter().any(|e| matches!(e, HeatmapEvent::CellClicked { row: r, col: c, .. } if *r == row && *c == col));
    assert!(found, "expected CellClicked event for ({row}, {col})");
}

#[then(regex = r"^cell at row (\d+) column (\d+) is selected$")]
fn then_cell_selected(world: &mut HeatmapWorld, row: usize, col: usize) {
    let resp = world.resp.as_ref().unwrap();
    assert_eq!(resp.selected_cell, Some((row, col)));
}

#[then(expr = "the active colormap is {string}")]
fn then_active_colormap(world: &mut HeatmapWorld, expected_name: String) {
    assert_eq!(world.opts.colormap.name(), expected_name);
}

#[then(expr = "a colormap changed event was emitted for {string}")]
fn then_colormap_event(world: &mut HeatmapWorld, expected_name: String) {
    let found = world.events.iter().any(|e| matches!(e, HeatmapEvent::ColorMapChanged(cm) if cm.name() == expected_name));
    assert!(found, "expected ColorMapChanged event for {expected_name}");
}

#[then(expr = "I save the picture {string}")]
fn then_save_picture(world: &mut HeatmapWorld, name: String) {
    let img = world.picture();
    let path = artifacts_dir().join(format!("{name}.png"));
    img.save(&path).unwrap();
}

fn main() {
    futures::executor::block_on(
        HeatmapWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/heatmap.feature"),
    );
}
