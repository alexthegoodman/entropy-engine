//! Headless tier for `entropy_gui::TabBar`.
//!
//! `tests/features/tab_bar.feature` runs against the real widget inside a headless
//! `entropy_gui::Context`, one frame at a time. Pointer input is built the way the window
//! backend builds it (a hover frame, a press frame, a release frame), the widget's events are
//! read back, and each frame's draw list is rasterized on the CPU (`tests/common/raster.rs`) so
//! what is asserted about looks is a fact about pixels. Pictures land in `test-artifacts/tab-bar/`.

use cucumber::{given, then, when, World as _};
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::draw_list::DrawCommand;
use entropy_engine::entropy_gui::geometry::{pos2, vec2, Align, Layout, Pos2, Rect};
use entropy_engine::entropy_gui::{Tab, TabBar, TabBarEvent};
use image::RgbaImage;

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

#[derive(cucumber::World)]
struct TabWorld {
    h: Harness,
    tabs: Vec<Tab>,
    selected: String,
    column: f32,
    /// What the last frame reported.
    rects: Vec<(String, Rect)>,
    events: Vec<String>,
    pending: Vec<DrawCommand>,
    image: Option<RgbaImage>,
    frames: usize,
}

impl std::fmt::Debug for TabWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "TabWorld({} frames)", self.frames)
    }
}

impl Default for TabWorld {
    fn default() -> Self {
        Self {
            h: Harness::new(420, 160),
            tabs: Vec::new(),
            selected: String::new(),
            column: 296.0,
            rects: Vec::new(),
            events: Vec::new(),
            pending: Vec::new(),
            image: None,
            frames: 0,
        }
    }
}

impl TabWorld {
    /// One frame: the bar sits in a column `self.column` wide, like the sidebar's content area.
    fn frame(&mut self, pointer: PointerState) {
        let (tabs, selected, column) = (self.tabs.clone(), self.selected.clone(), self.column);
        let mut out = None;
        self.frames += 1;
        self.pending = self.h.run(pointer, 0.0, |ui| {
            let top = ui.available_rect_before_wrap().min;
            let mut child = ui.child_ui_at(Rect::from_min_size(top, vec2(column, 200.0)), Layout::top_down(Align::Min), "column");
            out = Some(TabBar::new("bar").show(&mut child, &tabs, &selected));
        });
        let resp = out.expect("the bar was not drawn");
        self.events = resp.events.into_iter().map(|e| match e { TabBarEvent::Selected(id) => format!("Selected({id})") }).collect();
        self.rects = resp.rects;
        self.image = None;
    }

    fn hover(&mut self, p: Pos2) {
        self.frame(PointerState { pos: Some(p), ..Default::default() });
    }

    /// Hover, press and release at `p`; the events are the ones from the press frame, which is
    /// where the widget reports a click.
    fn click(&mut self, p: Pos2) {
        self.hover(p);
        self.frame(PointerState { pos: Some(p), primary_pressed: true, primary_down: true, ..Default::default() });
        let pressed = std::mem::take(&mut self.events);
        self.frame(PointerState { pos: Some(p), primary_released: true, ..Default::default() });
        self.events = pressed;
    }

    fn ensure_frame(&mut self) {
        if self.rects.is_empty() {
            self.frame(PointerState::default());
        }
    }

    fn rect(&mut self, id: &str) -> Rect {
        self.ensure_frame();
        self.rects.iter().find(|(t, _)| t == id).unwrap_or_else(|| panic!("no tab {id}")).1
    }

    fn picture(&mut self) -> RgbaImage {
        if self.image.is_none() {
            self.image = Some(self.h.render(&self.pending));
        }
        self.image.clone().unwrap()
    }
}

fn artifacts_dir() -> std::path::PathBuf {
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("tab-bar");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// "Tool, Surfaces" -> [("tool", "Tool"), ("surfaces", "Surfaces")]: the id is the lower-cased label.
fn parse_tabs(list: &str) -> Vec<Tab> {
    list.split(',').map(|l| l.trim()).map(|l| Tab::new(l.to_lowercase(), l)).collect()
}

fn overlaps(a: &Rect, b: &Rect) -> bool {
    a.min.x < b.max.x && b.min.x < a.max.x && a.min.y < b.max.y && b.min.y < a.max.y
}

fn luminance(p: &image::Rgba<u8>) -> f32 {
    0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32
}

/// The brightest pixel in the tab's label area (its top rows, clear of the underline).
fn label_peak(img: &RgbaImage, r: Rect) -> f32 {
    let mut peak = 0.0f32;
    for y in r.min.y as u32 + 3..(r.max.y as u32).saturating_sub(4) {
        for x in r.min.x as u32 + 2..r.max.x as u32 - 2 {
            peak = peak.max(luminance(img.get_pixel(x, y)));
        }
    }
    peak
}

/// Mean colour of the tab's background, sampled from a strip just inside its left edge where no
/// label pixels reach, clear of the underline.
fn edge_colour(img: &RgbaImage, r: Rect) -> [f32; 3] {
    let (x0, x1) = (r.min.x as u32 + 2, r.min.x as u32 + 5);
    let (y0, y1) = (r.min.y as u32 + 8, r.max.y as u32 - 8);
    let mut acc = [0.0f32; 3];
    let mut n = 0.0;
    for y in y0..y1 {
        for x in x0..x1 {
            let p = img.get_pixel(x, y);
            for i in 0..3 {
                acc[i] += p[i] as f32;
            }
            n += 1.0;
        }
    }
    [acc[0] / n, acc[1] / n, acc[2] / n]
}

/// The colour of the two pixel rows at the bottom of a tab, where the underline goes.
fn underline_colour(img: &RgbaImage, r: Rect) -> [f32; 3] {
    let y = r.max.y as u32 - 1;
    let x = ((r.min.x + r.max.x) / 2.0) as u32;
    let p = img.get_pixel(x, y);
    [p[0] as f32, p[1] as f32, p[2] as f32]
}

fn distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

// ------------------------------------------------------------------------------------------
// Steps
// ------------------------------------------------------------------------------------------

#[given(expr = "a tab bar with the tabs {string} in a {int} pixel column")]
fn bar(world: &mut TabWorld, list: String, column: f32) {
    world.tabs = parse_tabs(&list);
    world.column = column;
    world.selected = world.tabs[0].id.clone();
}

#[given(expr = "the {string} tab is selected")]
fn selected(world: &mut TabWorld, id: String) {
    world.selected = id;
}

#[when("a frame is drawn")]
fn drawn(world: &mut TabWorld) {
    world.frame(PointerState::default());
}

#[when(expr = "I click the {string} tab")]
fn click_tab(world: &mut TabWorld, id: String) {
    let r = world.rect(&id);
    world.click(r.center());
}

#[when(expr = "I click the gap after the {string} tab")]
fn click_gap(world: &mut TabWorld, id: String) {
    let r = world.rect(&id);
    world.click(pos2(r.max.x + 1.0, r.center().y));
}

#[when(expr = "the pointer rests on the {string} tab")]
fn rest_on(world: &mut TabWorld, id: String) {
    let r = world.rect(&id);
    world.hover(r.center());
}

#[then(expr = "the events are {string}")]
fn events_are(world: &mut TabWorld, expected: String) {
    assert_eq!(world.events.join(","), expected);
}

#[then("there are no events")]
fn no_events(world: &mut TabWorld) {
    assert!(world.events.is_empty(), "unexpected events: {:?}", world.events);
}

#[then("every tab is on the same line")]
fn same_line(world: &mut TabWorld) {
    world.ensure_frame();
    let y = world.rects[0].1.min.y;
    assert!(world.rects.iter().all(|(_, r)| (r.min.y - y).abs() < 0.5), "tabs are on different lines: {:?}", world.rects);
}

#[then("the tabs fill the column from edge to edge")]
fn fills(world: &mut TabWorld) {
    world.ensure_frame();
    let left = world.rects.iter().map(|(_, r)| r.min.x).fold(f32::MAX, f32::min);
    let right = world.rects.iter().map(|(_, r)| r.max.x).fold(f32::MIN, f32::max);
    assert!((right - left - world.column).abs() < 1.0, "tabs span {} of a {} px column", right - left, world.column);
}

#[then("no two tabs overlap")]
fn no_overlap(world: &mut TabWorld) {
    world.ensure_frame();
    for (i, (a, ra)) in world.rects.iter().enumerate() {
        for (b, rb) in &world.rects[i + 1..] {
            assert!(!overlaps(ra, rb), "tabs {a} and {b} overlap: {ra:?} {rb:?}");
        }
    }
}

#[then("the tabs use more than one line")]
fn many_lines(world: &mut TabWorld) {
    world.ensure_frame();
    let mut ys: Vec<i32> = world.rects.iter().map(|(_, r)| r.min.y.round() as i32).collect();
    ys.sort();
    ys.dedup();
    assert!(ys.len() > 1, "all tabs share one line in a {} px column: {:?}", world.column, world.rects);
}

#[then("no tab reaches past the right edge of the column")]
fn inside_column(world: &mut TabWorld) {
    world.ensure_frame();
    let left = world.rects.iter().map(|(_, r)| r.min.x).fold(f32::MAX, f32::min);
    for (id, r) in &world.rects {
        assert!(r.max.x <= left + world.column + 0.5, "tab {id} ends at {} in a column that ends at {}", r.max.x, left + world.column);
    }
}

#[then(expr = "the {string} tab has an underline and the {string} tab does not")]
fn underline(world: &mut TabWorld, with: String, without: String) {
    let (a, b) = (world.rect(&with), world.rect(&without));
    let img = world.picture();
    let above = |r: Rect| {
        let p = img.get_pixel(((r.min.x + r.max.x) / 2.0) as u32, r.max.y as u32 - 6);
        [p[0] as f32, p[1] as f32, p[2] as f32]
    };
    let with_line = distance(underline_colour(&img, a), above(a));
    let without_line = distance(underline_colour(&img, b), above(b));
    assert!(with_line > 60.0, "the selected tab's bottom row is only {with_line:.0} away from the row above it");
    assert!(without_line < 20.0, "an unselected tab has a line at its bottom ({without_line:.0})");
}

#[then(expr = "the {string} label is brighter than the {string} label")]
fn brighter(world: &mut TabWorld, a: String, b: String) {
    let (ra, rb) = (world.rect(&a), world.rect(&b));
    let img = world.picture();
    let (pa, pb) = (label_peak(&img, ra), label_peak(&img, rb));
    assert!(pa > pb + 30.0, "{a} peaks at {pa:.0}, {b} at {pb:.0}");
}

#[then(expr = "the {string} tab is lighter than the {string} tab")]
fn lighter(world: &mut TabWorld, a: String, b: String) {
    let (ra, rb) = (world.rect(&a), world.rect(&b));
    let img = world.picture();
    let (ca, cb) = (edge_colour(&img, ra), edge_colour(&img, rb));
    let (la, lb) = (ca[0] + ca[1] + ca[2], cb[0] + cb[1] + cb[2]);
    assert!(la > lb + 15.0, "{a} background {ca:?} is not lighter than {b} {cb:?}");
}

#[then(expr = "I save the picture {string}")]
fn save_picture(world: &mut TabWorld, name: String) {
    world.ensure_frame();
    let img = world.picture();
    img.save(artifacts_dir().join(format!("{name}.png"))).unwrap();
}

fn main() {
    futures::executor::block_on(
        TabWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/tab_bar.feature"),
    );
}
