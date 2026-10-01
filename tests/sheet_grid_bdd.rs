//! Headless tier for `entropy_gui::SheetGrid`.
//!
//! `tests/features/sheet_grid.feature` runs against the real widget inside a headless
//! `entropy_gui::Context`, one frame at a time. Pointer and keyboard input are built the way the
//! window backend builds them, the widget's events are read back, and each frame's draw list is
//! rasterized on the CPU (the same rasterizer `pad_grid_bdd`/`audio_widgets_bdd` use) so what is
//! asserted about looks is a fact about pixels. Pictures land in `test-artifacts/sheet-grid/`.

use cucumber::{given, then, when, World as _};
use entropy_engine::entropy_gui::color::Color32;
use entropy_engine::entropy_gui::context::{Key, KeyEvent, Modifiers, PointerState};
use entropy_engine::entropy_gui::draw_list::{DrawCommand, DrawTexture};
use entropy_engine::entropy_gui::geometry::{pos2, vec2, Pos2, Rect};
use entropy_engine::entropy_gui::{CentralPanel, Context, RawInput, SheetCell, SheetEdit, SheetEvent, SheetGrid, SheetGridOptions, SheetRange};
use image::RgbaImage;

const SS: usize = 2;
const ATLAS: usize = 1024;

// ------------------------------------------------------------------------------------------
// A small CPU rasterizer for entropy_gui draw lists (the same one pad_grid_bdd/audio_widgets_bdd use)
// ------------------------------------------------------------------------------------------

struct Harness {
    ctx: Context,
    atlas: Vec<[u8; 4]>,
    width: usize,
    height: usize,
    time_step: f32,
}

impl Harness {
    fn new(width: usize, height: usize) -> Self {
        Self { ctx: Context::default(), atlas: vec![[0; 4]; ATLAS * ATLAS], width, height, time_step: 1.0 / 60.0 }
    }

    fn run_with_text(&mut self, pointer: PointerState, keys: Vec<KeyEvent>, modifiers: Modifiers, text_input: String, add: impl FnOnce(&mut entropy_engine::entropy_gui::Ui)) -> Vec<DrawCommand> {
        let raw = RawInput {
            screen_rect: Rect::from_min_size(pos2(0.0, 0.0), vec2(self.width as f32, self.height as f32)),
            pixels_per_point: 1.0,
            pointer,
            key_events: keys,
            modifiers,
            text_input,
            dt: self.time_step,
            ..Default::default()
        };
        let out = self.ctx.run(raw, |ctx| {
            CentralPanel::default().show(ctx, |ui| add(ui));
        });
        for (_, delta) in &out.textures_delta.set {
            for row in 0..delta.height as usize {
                for col in 0..delta.width as usize {
                    let s = (row * delta.width as usize + col) * 4;
                    let d = (delta.y as usize + row) * ATLAS + delta.x as usize + col;
                    self.atlas[d] = [delta.rgba[s], delta.rgba[s + 1], delta.rgba[s + 2], delta.rgba[s + 3]];
                }
            }
        }
        self.ctx.tessellate((), 1.0)
    }

    fn glyph(&self, u: f32, v: f32) -> [f32; 4] {
        let (x, y) = (u * ATLAS as f32 - 0.5, v * ATLAS as f32 - 0.5);
        let (x0, y0) = (x.floor(), y.floor());
        let (fx, fy) = (x - x0, y - y0);
        let at = |xi: f32, yi: f32| {
            let t = self.atlas[(yi.clamp(0.0, ATLAS as f32 - 1.0) as usize) * ATLAS + xi.clamp(0.0, ATLAS as f32 - 1.0) as usize];
            [t[0] as f32 / 255.0, t[1] as f32 / 255.0, t[2] as f32 / 255.0, t[3] as f32 / 255.0]
        };
        let (a, b, c, d) = (at(x0, y0), at(x0 + 1.0, y0), at(x0, y0 + 1.0), at(x0 + 1.0, y0 + 1.0));
        let mut out = [0.0; 4];
        for i in 0..4 {
            out[i] = (a[i] * (1.0 - fx) + b[i] * fx) * (1.0 - fy) + (c[i] * (1.0 - fx) + d[i] * fx) * fy;
        }
        out
    }

    fn render(&self, commands: &[DrawCommand]) -> RgbaImage {
        let (w, h) = (self.width * SS, self.height * SS);
        let mut buf = vec![[0.09f32, 0.10, 0.12]; w * h];
        for cmd in commands {
            if matches!(cmd.texture, DrawTexture::Native(_)) {
                continue;
            }
            let clip = (
                (cmd.clip_rect.min.x * SS as f32).floor().max(0.0) as usize,
                (cmd.clip_rect.min.y * SS as f32).floor().max(0.0) as usize,
                ((cmd.clip_rect.max.x * SS as f32).ceil() as usize).min(w),
                ((cmd.clip_rect.max.y * SS as f32).ceil() as usize).min(h),
            );
            for tri in cmd.indices.chunks_exact(3) {
                let v = [&cmd.vertices[tri[0] as usize], &cmd.vertices[tri[1] as usize], &cmd.vertices[tri[2] as usize]];
                let p: Vec<(f32, f32)> = v.iter().map(|v| (v.position[0] * SS as f32, v.position[1] * SS as f32)).collect();
                let area = (p[1].0 - p[0].0) * (p[2].1 - p[0].1) - (p[2].0 - p[0].0) * (p[1].1 - p[0].1);
                if area.abs() < 1.0e-6 {
                    continue;
                }
                let x0 = (p.iter().map(|q| q.0).fold(f32::MAX, f32::min).floor().max(clip.0 as f32)) as usize;
                let x1 = (p.iter().map(|q| q.0).fold(f32::MIN, f32::max).ceil().min(clip.2 as f32)) as usize;
                let y0 = (p.iter().map(|q| q.1).fold(f32::MAX, f32::min).floor().max(clip.1 as f32)) as usize;
                let y1 = (p.iter().map(|q| q.1).fold(f32::MIN, f32::max).ceil().min(clip.3 as f32)) as usize;
                for y in y0..y1 {
                    for x in x0..x1 {
                        let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
                        let w0 = ((p[1].0 - px) * (p[2].1 - py) - (p[2].0 - px) * (p[1].1 - py)) / area;
                        let w1 = ((p[2].0 - px) * (p[0].1 - py) - (p[0].0 - px) * (p[2].1 - py)) / area;
                        let w2 = 1.0 - w0 - w1;
                        if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                            continue;
                        }
                        let mut c = [0.0f32; 4];
                        for i in 0..4 {
                            c[i] = v[0].color[i] * w0 + v[1].color[i] * w1 + v[2].color[i] * w2;
                        }
                        if cmd.texture == DrawTexture::Glyph {
                            let u = v[0].tex_coords[0] * w0 + v[1].tex_coords[0] * w1 + v[2].tex_coords[0] * w2;
                            let vv = v[0].tex_coords[1] * w0 + v[1].tex_coords[1] * w1 + v[2].tex_coords[1] * w2;
                            let t = self.glyph(u, vv);
                            for i in 0..4 {
                                c[i] *= t[i];
                            }
                        }
                        let dst = &mut buf[y * w + x];
                        for i in 0..3 {
                            dst[i] = c[i] * c[3] + dst[i] * (1.0 - c[3]);
                        }
                    }
                }
            }
        }
        let mut img = RgbaImage::new(self.width as u32, self.height as u32);
        for y in 0..self.height {
            for x in 0..self.width {
                let mut acc = [0.0f32; 3];
                for sy in 0..SS {
                    for sx in 0..SS {
                        let p = buf[(y * SS + sy) * w + x * SS + sx];
                        for i in 0..3 {
                            acc[i] += p[i];
                        }
                    }
                }
                let n = (SS * SS) as f32;
                img.put_pixel(x as u32, y as u32, image::Rgba([(acc[0] / n * 255.0) as u8, (acc[1] / n * 255.0) as u8, (acc[2] / n * 255.0) as u8, 255]));
            }
        }
        img
    }
}

// ------------------------------------------------------------------------------------------
// World
// ------------------------------------------------------------------------------------------

#[derive(cucumber::World)]
struct SheetWorld {
    h: Harness,
    cells: Vec<SheetCell>,
    opts: SheetGridOptions,
    selected: Option<(u32, u32)>,
    range: Option<SheetRange>,
    /// (row, col, draft text) - mirrors what a real addon holds while an edit is in progress.
    editing: Option<(u32, u32, String)>,
    origin: Pos2,
    events: Vec<String>,
    pending: Vec<DrawCommand>,
    image: Option<RgbaImage>,
}

impl std::fmt::Debug for SheetWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SheetWorld(selected={:?}, range={:?}, editing={:?})", self.selected, self.range, self.editing)
    }
}

impl Default for SheetWorld {
    fn default() -> Self {
        Self {
            h: Harness::new(900, 560),
            cells: Vec::new(),
            opts: SheetGridOptions { rows: 5, cols: 4, col_width: 90.0, row_height: 22.0, max_height: None, col_widths: None },
            selected: None,
            range: None,
            editing: None,
            origin: pos2(0.0, 0.0),
            events: Vec::new(),
            pending: Vec::new(),
            image: None,
        }
    }
}

fn sheet_event(e: SheetEvent) -> String {
    match e {
        SheetEvent::CellSelected { row, col } => format!("CellSelected({row},{col})"),
        SheetEvent::RangeSelected { start_row, start_col, end_row, end_col } => format!("RangeSelected({start_row},{start_col},{end_row},{end_col})"),
        SheetEvent::CellClearRequested { row, col } => format!("CellClearRequested({row},{col})"),
        SheetEvent::RangeClearRequested { start_row, start_col, end_row, end_col } => format!("RangeClearRequested({start_row},{start_col},{end_row},{end_col})"),
        SheetEvent::CellEditStarted { row, col, initial } => format!("CellEditStarted({row},{col},{initial})"),
        SheetEvent::CellEditChanged { row, col, text } => format!("CellEditChanged({row},{col},{text})"),
        SheetEvent::CellEditCommitted { row, col } => format!("CellEditCommitted({row},{col})"),
        SheetEvent::CellEditCancelled { row, col } => format!("CellEditCancelled({row},{col})"),
        SheetEvent::InsertRowRequested { row } => format!("InsertRowRequested({row})"),
        SheetEvent::DeleteRowRequested { row } => format!("DeleteRowRequested({row})"),
        SheetEvent::InsertColumnRequested { col } => format!("InsertColumnRequested({col})"),
        SheetEvent::DeleteColumnRequested { col } => format!("DeleteColumnRequested({col})"),
        SheetEvent::ColumnResized { col, width } => format!("ColumnResized({col},{width})"),
    }
}

impl SheetWorld {
    fn frame(&mut self, pointer: PointerState, keys: Vec<KeyEvent>) {
        self.frame_with_mods(pointer, keys, Modifiers::default(), String::new())
    }

    fn frame_with_text(&mut self, pointer: PointerState, keys: Vec<KeyEvent>, text_input: String) {
        self.frame_with_mods(pointer, keys, Modifiers::default(), text_input)
    }

    fn frame_with_mods(&mut self, pointer: PointerState, keys: Vec<KeyEvent>, modifiers: Modifiers, text_input: String) {
        let (cells, opts, selected, range, editing) = (self.cells.clone(), self.opts.clone(), self.selected, self.range, self.editing.clone());
        let mut out = None;
        let mut active_mods = modifiers;
        for k in &keys {
            active_mods.shift |= k.modifiers.shift;
            active_mods.ctrl |= k.modifiers.ctrl;
            active_mods.alt |= k.modifiers.alt;
            active_mods.command |= k.modifiers.command;
        }
        self.pending = self.h.run_with_text(pointer, keys, active_mods, text_input, |ui| {
            let edit_arg = editing.as_ref().map(|(row, col, value)| SheetEdit { row: *row, col: *col, value: value.as_str() });
            let r = SheetGrid::new("grid").options(opts).selected_range(range).show(ui, &cells, selected, edit_arg);
            out = Some((r.events, r.origin));
        });
        let (ev, origin) = out.unwrap();
        // Mirror what a real addon does: apply each reported state change straight back onto
        // what's handed in next frame, so a sequence of steps (Tab, then Enter, ...) composes
        // the way it would through an addon's own callbacks.
        for e in &ev {
            match e {
                SheetEvent::CellSelected { row, col } => {
                    self.selected = Some((*row, *col));
                    self.range = None;
                }
                SheetEvent::RangeSelected { start_row, start_col, end_row, end_col } => {
                    self.selected = Some((*start_row, *start_col));
                    self.range = Some(SheetRange::new(*start_row, *start_col, *end_row, *end_col));
                }
                SheetEvent::CellEditStarted { row, col, initial } => {
                    let base = if initial.is_empty() { self.cells.iter().find(|c| c.row == *row && c.col == *col).map(|c| c.text.clone()).unwrap_or_default() } else { initial.clone() };
                    self.editing = Some((*row, *col, base));
                }
                SheetEvent::CellEditChanged { row, col, text } => self.editing = Some((*row, *col, text.clone())),
                SheetEvent::CellEditCommitted { .. } | SheetEvent::CellEditCancelled { .. } => self.editing = None,
                SheetEvent::ColumnResized { col, width } => {
                    self.opts.col_widths.get_or_insert_with(std::collections::HashMap::new).insert(*col, *width);
                }
                _ => {}
            }
        }
        self.events = ev.into_iter().map(sheet_event).collect();
        self.origin = origin;
        self.image = None;
    }

    fn hover(&mut self, p: Pos2) {
        self.frame(PointerState { pos: Some(p), ..Default::default() }, Vec::new());
    }

    /// Hover, press and release at `p`; the events reported are the ones from the press frame,
    /// which is where the widget reports a click.
    fn click(&mut self, p: Pos2) {
        self.hover(p);
        let press = PointerState { pos: Some(p), primary_pressed: true, primary_down: true, ..Default::default() };
        self.frame(press, Vec::new());
        let pressed_events = std::mem::take(&mut self.events);
        let release = PointerState { pos: Some(p), primary_released: true, ..Default::default() };
        self.frame(release, Vec::new());
        self.events = pressed_events;
    }

    fn shift_click(&mut self, p: Pos2) {
        self.hover(p);
        let shift_mods = Modifiers { shift: true, ..Default::default() };
        let press = PointerState { pos: Some(p), primary_pressed: true, primary_down: true, ..Default::default() };
        self.frame_with_mods(press, Vec::new(), shift_mods, String::new());
        let pressed_events = std::mem::take(&mut self.events);
        let release = PointerState { pos: Some(p), primary_released: true, ..Default::default() };
        self.frame_with_mods(release, Vec::new(), shift_mods, String::new());
        self.events = pressed_events;
    }

    fn drag(&mut self, from: Pos2, to: Pos2) {
        self.hover(from);
        let press = PointerState { pos: Some(from), primary_pressed: true, primary_down: true, ..Default::default() };
        self.frame(press, Vec::new());
        let move_to = PointerState { pos: Some(to), primary_down: true, ..Default::default() };
        self.frame(move_to, Vec::new());
        let move_events = std::mem::take(&mut self.events);
        let release = PointerState { pos: Some(to), primary_released: true, ..Default::default() };
        self.frame(release, Vec::new());
        self.events = move_events;
    }

    fn press_key(&mut self, key: Key) {
        self.frame(PointerState::default(), vec![KeyEvent { key, pressed: true, modifiers: Modifiers::default() }]);
    }

    fn press_key_with_shift(&mut self, key: Key) {
        let shift_mods = Modifiers { shift: true, ..Default::default() };
        self.frame_with_mods(
            PointerState::default(),
            vec![KeyEvent { key, pressed: true, modifiers: shift_mods }],
            shift_mods,
            String::new(),
        );
    }

    /// One frame with `ch` as this frame's committed text input - the same thing a keystroke
    /// hands `RawInput.text_input` in the real window backend.
    fn type_char(&mut self, ch: &str) {
        self.frame_with_text(PointerState::default(), Vec::new(), ch.to_string());
    }

    /// Double-click `p`: two ordinary clicks close enough together (a handful of frames, well
    /// under `DOUBLE_CLICK_WINDOW`) for the widget to treat as one double-click.
    fn double_click(&mut self, p: Pos2) {
        self.click(p);
        let second = std::mem::take(&mut self.events);
        self.click(p);
        self.events = second.into_iter().chain(std::mem::take(&mut self.events)).collect();
    }

    fn right_click(&mut self, p: Pos2) {
        self.hover(p);
        let press = PointerState { pos: Some(p), secondary_pressed: true, secondary_down: true, ..Default::default() };
        self.frame(press, Vec::new());
        let release = PointerState { pos: Some(p), ..Default::default() };
        self.frame(release, Vec::new());
    }

    /// Right-clicks `p` to open its context menu, draws the frame the menu actually appears on,
    /// then clicks `offset` away from the menu's own content origin (`p` plus the popup's 4px
    /// inner padding - see `context_menu.rs`) to hit one of its items.
    fn right_click_menu_item(&mut self, p: Pos2, offset: Pos2) {
        self.right_click(p);
        self.frame(PointerState::default(), Vec::new());
        self.click(pos2(p.x + 4.0 + offset.x, p.y + 4.0 + offset.y));
    }

    fn cell_rect(&self, row: u32, col: u32) -> Rect {
        use entropy_engine::entropy_gui::widgets_sheet::ROW_HEADER_W;
        Rect::from_min_size(
            pos2(self.origin.x + ROW_HEADER_W + self.opts.col_x(col), self.origin.y + row as f32 * self.opts.row_height),
            vec2(self.opts.col_width(col), self.opts.row_height),
        )
    }

    /// Center of row `row`'s own header cell (in the fixed `ROW_HEADER_W`-wide gutter).
    fn row_header_center(&self, row: u32) -> Pos2 {
        use entropy_engine::entropy_gui::widgets_sheet::ROW_HEADER_W;
        pos2(self.origin.x + ROW_HEADER_W / 2.0, self.origin.y + row as f32 * self.opts.row_height + self.opts.row_height / 2.0)
    }

    /// Center of column `col`'s own header cell, in the fixed row above the scrolling body.
    fn col_header_center(&self, col: u32) -> Pos2 {
        use entropy_engine::entropy_gui::widgets_sheet::{HEADER_H, ROW_HEADER_W};
        pos2(self.origin.x + ROW_HEADER_W + self.opts.col_x(col) + self.opts.col_width(col) / 2.0, self.origin.y - HEADER_H / 2.0)
    }

    /// Center of the resize divider handle at the right edge of column `col`'s header cell.
    fn col_header_divider(&self, col: u32) -> Pos2 {
        use entropy_engine::entropy_gui::widgets_sheet::{HEADER_H, ROW_HEADER_W};
        pos2(self.origin.x + ROW_HEADER_W + self.opts.col_x(col) + self.opts.col_width(col), self.origin.y - HEADER_H / 2.0)
    }

    fn ensure_frame(&mut self) {
        if self.pending.is_empty() {
            self.frame(PointerState::default(), Vec::new());
        }
    }

    fn picture(&mut self) -> RgbaImage {
        if self.image.is_none() {
            self.image = Some(self.h.render(&self.pending));
        }
        self.image.clone().unwrap()
    }
}

fn px(img: &RgbaImage, x: f32, y: f32) -> [i32; 3] {
    let p = img.get_pixel(x.round() as u32, y.round() as u32);
    [p[0] as i32, p[1] as i32, p[2] as i32]
}

fn artifacts_dir() -> std::path::PathBuf {
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("sheet-grid");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

// ------------------------------------------------------------------------------------------
// Steps
// ------------------------------------------------------------------------------------------

#[given(expr = "a sheet grid of {int} rows and {int} columns at {int} by {int} cells")]
fn grid(world: &mut SheetWorld, rows: u32, cols: u32, w: f32, h: f32) {
    world.opts = SheetGridOptions { rows, cols, col_width: w, row_height: h, max_height: None, col_widths: None };
    world.cells = Vec::new();
    world.selected = None;
    world.editing = None;
}

#[given(expr = "column {int} has width {int} pixels")]
fn col_has_width(world: &mut SheetWorld, col: u32, width: f32) {
    world.opts.col_widths.get_or_insert_with(std::collections::HashMap::new).insert(col, width);
}

#[given(expr = "cell {int},{int} contains {string}")]
fn cell_text(world: &mut SheetWorld, row: u32, col: u32, text: String) {
    world.cells.push(SheetCell::new(row, col, text));
}

#[given(expr = "cell {int},{int} has a red border")]
fn cell_border(world: &mut SheetWorld, row: u32, col: u32) {
    let mut c = SheetCell::new(row, col, "");
    c.border = Some(Color32::from_rgb(230, 40, 40));
    world.cells.push(c);
}

#[given(expr = "cell {int},{int} is selected")]
fn select_given(world: &mut SheetWorld, row: u32, col: u32) {
    world.selected = Some((row, col));
    world.range = None;
}

#[given(expr = "cells from {int},{int} to {int},{int} are selected")]
fn range_given(world: &mut SheetWorld, r1: u32, c1: u32, r2: u32, c2: u32) {
    world.selected = Some((r1, c1));
    world.range = Some(SheetRange::new(r1, c1, r2, c2));
}

#[when("a frame is drawn")]
fn draw(world: &mut SheetWorld) {
    world.frame(PointerState::default(), Vec::new());
}

#[when(expr = "I click cell {int},{int}")]
fn click_cell(world: &mut SheetWorld, row: u32, col: u32) {
    world.ensure_frame();
    let c = world.cell_rect(row, col).center();
    world.click(c);
}

#[when(expr = "I shift-click cell {int},{int}")]
fn shift_click_cell(world: &mut SheetWorld, row: u32, col: u32) {
    world.ensure_frame();
    let c = world.cell_rect(row, col).center();
    world.shift_click(c);
}

#[when(expr = "I drag from cell {int},{int} to cell {int},{int}")]
fn drag_cells(world: &mut SheetWorld, r1: u32, c1: u32, r2: u32, c2: u32) {
    world.ensure_frame();
    let p1 = world.cell_rect(r1, c1).center();
    let p2 = world.cell_rect(r2, c2).center();
    world.drag(p1, p2);
}

#[when(expr = "I double-click cell {int},{int}")]
fn double_click_cell(world: &mut SheetWorld, row: u32, col: u32) {
    world.ensure_frame();
    let c = world.cell_rect(row, col).center();
    world.double_click(c);
}

#[when(expr = "I type {string}")]
fn type_text(world: &mut SheetWorld, text: String) {
    world.type_char(&text);
}

#[when(expr = "I press {string}")]
fn press(world: &mut SheetWorld, key: String) {
    let k = match key.as_str() {
        "ArrowLeft" => Key::ArrowLeft,
        "ArrowRight" => Key::ArrowRight,
        "ArrowUp" => Key::ArrowUp,
        "ArrowDown" => Key::ArrowDown,
        "Tab" => Key::Tab,
        "Enter" => Key::Enter,
        "Delete" => Key::Delete,
        "Backspace" => Key::Backspace,
        "Escape" => Key::Escape,
        other => panic!("unknown key {other}"),
    };
    world.press_key(k);
}

#[when(expr = "I press Shift+{string}")]
fn press_shift(world: &mut SheetWorld, key: String) {
    let k = match key.as_str() {
        "ArrowLeft" => Key::ArrowLeft,
        "ArrowRight" => Key::ArrowRight,
        "ArrowUp" => Key::ArrowUp,
        "ArrowDown" => Key::ArrowDown,
        other => panic!("unknown shift key {other}"),
    };
    world.press_key_with_shift(k);
}

#[when(expr = "I right-click the row header for row {int} and choose {string}")]
fn row_header_menu(world: &mut SheetWorld, row: u32, item: String) {
    world.ensure_frame();
    let idx = match item.as_str() {
        "Insert row above" => 0,
        "Insert row below" => 1,
        "Delete row" => 2,
        other => panic!("unknown row menu item {other}"),
    };
    let p = world.row_header_center(row);
    world.right_click_menu_item(p, pos2(20.0, idx as f32 * 32.0 + 11.0));
}

#[when(expr = "I right-click the column header for column {int} and choose {string}")]
fn col_header_menu(world: &mut SheetWorld, col: u32, item: String) {
    world.ensure_frame();
    let idx = match item.as_str() {
        "Insert column left" => 0,
        "Insert column right" => 1,
        "Delete column" => 2,
        other => panic!("unknown column menu item {other}"),
    };
    let p = world.col_header_center(col);
    world.right_click_menu_item(p, pos2(20.0, idx as f32 * 32.0 + 11.0));
}

#[when(expr = "I drag column {int} divider by {int} pixels")]
fn drag_col_divider(world: &mut SheetWorld, col: u32, dx: f32) {
    world.ensure_frame();
    let from = world.col_header_divider(col);
    let to = pos2(from.x + dx, from.y);
    world.drag(from, to);
}

#[when(expr = "I double-click column {int} divider")]
fn double_click_col_divider(world: &mut SheetWorld, col: u32) {
    world.ensure_frame();
    let p = world.col_header_divider(col);
    world.double_click(p);
}

#[then(expr = "the events are {string}")]
fn events_are(world: &mut SheetWorld, text: String) {
    assert_eq!(world.events.join(", "), text);
}

#[then("there are no events")]
fn no_events(world: &mut SheetWorld) {
    assert!(world.events.is_empty(), "{:?}", world.events);
}

#[then(expr = "cell {int},{int} is being edited with {string}")]
fn editing_is(world: &mut SheetWorld, row: u32, col: u32, text: String) {
    assert_eq!(world.editing, Some((row, col, text)));
}

#[then("nothing is being edited")]
fn nothing_editing(world: &mut SheetWorld) {
    assert_eq!(world.editing, None, "{:?}", world.editing);
}

#[then(expr = "cell {int},{int} is {int} pixels right of cell {int},{int}")]
fn right_of(world: &mut SheetWorld, br: u32, bc: u32, dx: f32, ar: u32, ac: u32) {
    let (ra, rb) = (world.cell_rect(ar, ac), world.cell_rect(br, bc));
    assert!((rb.min.x - ra.min.x - dx).abs() < 0.01 && (rb.min.y - ra.min.y).abs() < 0.01, "{ra:?} {rb:?}");
}

#[then(expr = "cell {int},{int} is {int} pixels below cell {int},{int}")]
fn below(world: &mut SheetWorld, br: u32, bc: u32, dy: f32, ar: u32, ac: u32) {
    let (ra, rb) = (world.cell_rect(ar, ac), world.cell_rect(br, bc));
    assert!((rb.min.y - ra.min.y - dy).abs() < 0.01 && (rb.min.x - ra.min.x).abs() < 0.01, "{ra:?} {rb:?}");
}

#[then(expr = "cell {int},{int} has width {int} pixels")]
fn cell_width_is(world: &mut SheetWorld, row: u32, col: u32, width: f32) {
    let r = world.cell_rect(row, col);
    assert!((r.width() - width).abs() < 0.01, "cell {row},{col} width is {}, expected {width}", r.width());
}

#[then(expr = "column {int} has width {int} pixels")]
fn col_width_is(world: &mut SheetWorld, col: u32, width: f32) {
    assert!((world.opts.col_width(col) - width).abs() < 0.01, "column {col} width is {}, expected {width}", world.opts.col_width(col));
}

fn ring_white(world: &mut SheetWorld, row: u32, col: u32) -> bool {
    let r = world.cell_rect(row, col);
    let img = world.picture();
    // The selection ring is a 2px stroke centred on the cell's own top edge - scan across it
    // rather than trusting one exact pixel, the same convention PadGrid's edge-color checks use.
    (-1..=1).any(|dy| {
        let p = px(&img, r.center().x, r.min.y + dy as f32);
        p[0] > 150 && p[1] > 150 && p[2] > 150
    })
}

#[then(expr = "cell {int},{int} has a white selection ring")]
fn has_ring(world: &mut SheetWorld, row: u32, col: u32) {
    assert!(ring_white(world, row, col), "no selection ring on {row},{col}");
}

#[then(expr = "cell {int},{int} has no selection ring")]
fn no_ring(world: &mut SheetWorld, row: u32, col: u32) {
    assert!(!ring_white(world, row, col), "unexpected selection ring on {row},{col}");
}

#[then(expr = "cell {int},{int} has a red border")]
fn assert_red_border(world: &mut SheetWorld, row: u32, col: u32) {
    let r = world.cell_rect(row, col);
    let img = world.picture();
    let y = r.center().y as u32;
    let mut best = (-1i32, 0u32);
    for x in (r.min.x as u32)..(r.max.x as u32) {
        let p = px(&img, x as f32, y as f32);
        let redness = p[0] - p[2];
        if redness > best.0 {
            best = (redness, x);
        }
    }
    println!("    reddest pixel in cell {row},{col}'s row: x={} redness={}", best.1, best.0);
    assert!(best.0 > 60, "no red border pixel found in cell {row},{col} (best redness {})", best.0);
}

#[then(expr = "the selection range perimeter is white for rows {int} to {int} and columns {int} to {int}")]
fn range_perimeter_white(world: &mut SheetWorld, r1: u32, r2: u32, c1: u32, c2: u32) {
    use entropy_engine::entropy_gui::widgets_sheet::ROW_HEADER_W;
    let min_r = r1.min(r2);
    let max_r = r1.max(r2);
    let min_c = c1.min(c2);
    let max_c = c1.max(c2);
    let img = world.picture();
    let top_y = world.origin.y + min_r as f32 * world.opts.row_height;
    let bottom_y = world.origin.y + (max_r + 1) as f32 * world.opts.row_height;
    let left_x = world.origin.x + ROW_HEADER_W + world.opts.col_x(min_c);
    let right_x = world.origin.x + ROW_HEADER_W + world.opts.col_x(max_c) + world.opts.col_width(max_c);

    let mid_x = (left_x + right_x) / 2.0;
    let has_top = (-1..=1).any(|dy| {
        let p = px(&img, mid_x, top_y + dy as f32);
        p[0] > 150 && p[1] > 150 && p[2] > 150
    });
    assert!(has_top, "no white top perimeter line for range");

    let has_bottom = (-1..=1).any(|dy| {
        let p = px(&img, mid_x, bottom_y + dy as f32);
        p[0] > 150 && p[1] > 150 && p[2] > 150
    });
    assert!(has_bottom, "no white bottom perimeter line for range");
}

#[then(expr = "inner boundary between cell {int},{int} and {int},{int} has no white line")]
fn inner_boundary_no_white(world: &mut SheetWorld, r1: u32, c1: u32, _r2: u32, _c2: u32) {
    let img = world.picture();
    let r = world.cell_rect(r1, c1);
    let mid_x = r.center().x;
    let has_white = (-1..=1).any(|dy| {
        let p = px(&img, mid_x, r.max.y + dy as f32);
        p[0] > 150 && p[1] > 150 && p[2] > 150
    });
    assert!(!has_white, "unexpected white line at inner boundary between cells");
}

#[then(expr = "I save the picture {string}")]
fn save_picture(world: &mut SheetWorld, name: String) {
    let img = world.picture();
    img.save(artifacts_dir().join(format!("{name}.png"))).unwrap();
    let colours: std::collections::HashSet<[u8; 4]> = img.pixels().map(|p| p.0).collect();
    assert!(colours.len() > 20, "{name} looks blank: {} colours", colours.len());
}

fn main() {
    futures::executor::block_on(SheetWorld::cucumber().max_concurrent_scenarios(1).fail_on_skipped().run_and_exit("tests/features/sheet_grid.feature"));
}
