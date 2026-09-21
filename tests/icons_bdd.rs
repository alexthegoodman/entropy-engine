//! Headless tier for Phosphor icons in `entropy_gui`.
//!
//! `tests/features/icons.feature` runs the real `Button` and `TabBar` inside a headless
//! `entropy_gui::Context`, rasterizes each frame's draw list on the CPU (`tests/common/raster.rs`)
//! and asserts about the pixels: an icon draws a real glyph rather than a missing-glyph box,
//! sits on the text's vertical centre, does not change a button's height, and comes in three
//! weights. Pictures land in `test-artifacts/icons/`.

use cucumber::{given, then, when, World as _};
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::draw_list::DrawCommand;
use entropy_engine::entropy_gui::geometry::{vec2, Align, Layout, Rect};
use entropy_engine::entropy_gui::icons::{self, IconStyle};
use entropy_engine::entropy_gui::{Tab, TabBar};
use image::{Rgba, RgbaImage};

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

/// Ink a glyph must draw to count as drawn. A blank glyph draws 0; the thinnest icon (minus, a
/// one pixel line) draws about 11.
const MIN_INK: f32 = 5.0;

/// A private-use character none of the Phosphor weights draw.
const MISSING: char = '\u{F8FE}';

#[derive(cucumber::World)]
struct IconWorld {
    h: Harness,
    buttons: Vec<String>,
    tabs: Vec<String>,
    column: f32,
    /// Raw feature label -> where the last frame put it.
    rects: Vec<(String, Rect)>,
    pending: Vec<DrawCommand>,
    image: Option<RgbaImage>,
}

impl std::fmt::Debug for IconWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "IconWorld({} buttons, {} tabs)", self.buttons.len(), self.tabs.len())
    }
}

impl Default for IconWorld {
    fn default() -> Self {
        Self { h: Harness::new(1100, 70), buttons: Vec::new(), tabs: Vec::new(), column: 330.0, rects: Vec::new(), pending: Vec::new(), image: None }
    }
}

/// "{play} Play" -> the icon character, a space, "Play". `{name:style}` picks a weight.
fn expand(label: &str) -> String {
    let mut out = String::new();
    let mut rest = label;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let close = rest[open..].find('}').unwrap_or_else(|| panic!("unclosed brace in {label:?}")) + open;
        let token = &rest[open + 1..close];
        if token == "missing" {
            out.push(MISSING);
        } else {
            let (name, style) = match token.split_once(':') {
                Some((n, s)) => (n, IconStyle::from_name(s).unwrap_or_else(|| panic!("no icon style {s:?} in {label:?}"))),
                None => (token, IconStyle::Regular),
            };
            out.push(icons::glyph(name, style).unwrap_or_else(|| panic!("no icon named {name:?} in {label:?}")));
        }
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    out
}

/// `"a", "b"` -> ["a", "b"]
fn quoted_list(list: &str) -> Vec<String> {
    list.split('"').enumerate().filter(|(i, _)| i % 2 == 1).map(|(_, s)| s.to_string()).collect()
}

impl IconWorld {
    fn frame(&mut self) {
        let buttons: Vec<(String, String)> = self.buttons.iter().map(|l| (l.clone(), expand(l))).collect();
        let tabs: Vec<Tab> = self.tabs.iter().map(|l| Tab::new(l.clone(), expand(l))).collect();
        let column = self.column;
        let mut rects: Vec<(String, Rect)> = Vec::new();
        self.pending = self.h.run(PointerState::default(), 0.0, |ui| {
            if !buttons.is_empty() {
                ui.horizontal(|ui| {
                    for (raw, shown) in &buttons {
                        rects.push((raw.clone(), ui.button(shown.as_str()).rect));
                    }
                });
            }
            if !tabs.is_empty() {
                let top = ui.available_rect_before_wrap().min;
                let mut child = ui.child_ui_at(Rect::from_min_size(top, vec2(column, 200.0)), Layout::top_down(Align::Min), "column");
                let selected = tabs[0].id.clone();
                rects.extend(TabBar::new("bar").show(&mut child, &tabs, &selected).rects);
            }
        });
        self.rects = rects;
        self.image = None;
    }

    fn ensure_frame(&mut self) {
        if self.rects.is_empty() {
            self.frame();
        }
    }

    fn rect(&mut self, raw: &str) -> Rect {
        self.ensure_frame();
        self.rects.iter().find(|(l, _)| l == raw).unwrap_or_else(|| panic!("nothing was drawn for {raw:?}")).1
    }

    fn picture(&mut self) -> RgbaImage {
        self.ensure_frame();
        if self.image.is_none() {
            self.image = Some(self.h.render(&self.pending));
        }
        self.image.clone().unwrap()
    }
}

fn artifacts_dir() -> std::path::PathBuf {
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("icons");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn distance(a: &Rgba<u8>, b: &Rgba<u8>) -> f32 {
    (0..3).map(|i| (a[i] as f32 - b[i] as f32).abs()).sum::<f32>() / 255.0
}

/// The widget's own background, read where no glyph reaches: just inside its left edge.
fn background(img: &RgbaImage, r: Rect) -> Rgba<u8> {
    *img.get_pixel(r.min.x as u32 + 3, r.center().y as u32)
}

/// The rect with a margin cut away, so a button's border or a tab's underline is not ink.
fn inner(r: Rect) -> (u32, u32, u32, u32) {
    (r.min.x as u32 + 3, r.min.y as u32 + 4, r.max.x as u32 - 3, r.max.y as u32 - 4)
}

/// Total ink in the rect: the summed distance from the background, in whole-pixel units, so a
/// half-covered antialiased pixel counts as about half. Comparable between two glyphs.
fn ink(img: &RgbaImage, r: Rect) -> f32 {
    let bg = background(img, r);
    let (x0, y0, x1, y1) = inner(r);
    let mut total = 0.0;
    for y in y0..y1 {
        for x in x0..x1 {
            let d = distance(img.get_pixel(x, y), &bg);
            if d > 0.05 {
                total += d;
            }
        }
    }
    total
}

/// Horizontal runs of columns that hold real ink, as (first x, last x).
fn ink_runs(img: &RgbaImage, r: Rect) -> Vec<(u32, u32)> {
    let bg = background(img, r);
    let (x0, y0, x1, y1) = inner(r);
    let mut runs: Vec<(u32, u32)> = Vec::new();
    for x in x0..x1 {
        let has = (y0..y1).any(|y| distance(img.get_pixel(x, y), &bg) > 0.3);
        if has {
            match runs.last_mut() {
                Some(last) if last.1 + 1 == x => last.1 = x,
                _ => runs.push((x, x)),
            }
        }
    }
    runs
}

/// Vertical extent of ink between two columns, as (first y, last y).
fn ink_rows(img: &RgbaImage, r: Rect, xs: (u32, u32)) -> Option<(u32, u32)> {
    let bg = background(img, r);
    let (_, y0, _, y1) = inner(r);
    let rows: Vec<u32> = (y0..y1).filter(|&y| (xs.0..=xs.1).any(|x| distance(img.get_pixel(x, y), &bg) > 0.3)).collect();
    Some((*rows.first()?, *rows.last()?))
}

// ------------------------------------------------------------------------------------------
// Steps
// ------------------------------------------------------------------------------------------

#[given(regex = r#"^buttons labelled (.+)$"#)]
fn buttons(world: &mut IconWorld, list: String) {
    world.buttons = quoted_list(&list);
    assert!(!world.buttons.is_empty(), "no labels in {list:?}");
}

#[given(expr = "a tab bar with the tabs {string} in a {int} pixel column")]
fn tab_bar(world: &mut IconWorld, list: String, column: f32) {
    world.tabs = list.split(',').map(|t| t.trim().to_string()).collect();
    world.column = column;
}

#[when("a frame is drawn")]
fn drawn(world: &mut IconWorld) {
    world.frame();
}

#[then(expr = "the {string} button has ink")]
fn has_ink(world: &mut IconWorld, label: String) {
    let r = world.rect(&label);
    let img = world.picture();
    let amount = ink(&img, r);
    println!("      {label}: ink {amount:.1}");
    assert!(amount > MIN_INK, "{label} has {amount:.1} pixels of ink");
}

#[then(expr = "the {string} button looks different from the {string} button")]
fn differs(world: &mut IconWorld, a: String, b: String) {
    let (ra, rb) = (world.rect(&a), world.rect(&b));
    let img = world.picture();
    let (bga, bgb) = (background(&img, ra), background(&img, rb));
    let mut total = 0.0;
    for dy in 0..16 {
        for dx in 0..16 {
            let pa = img.get_pixel(ra.center().x as u32 - 8 + dx, ra.center().y as u32 - 8 + dy);
            let pb = img.get_pixel(rb.center().x as u32 - 8 + dx, rb.center().y as u32 - 8 + dy);
            total += (distance(pa, &bga) - distance(pb, &bgb)).abs();
        }
    }
    println!("      pixel difference {total:.1}");
    assert!(total > 10.0, "{a} and {b} differ by only {total:.1}");
}

#[then(expr = "the {string} button is as tall as the {string} button")]
fn same_height(world: &mut IconWorld, a: String, b: String) {
    let (ra, rb) = (world.rect(&a), world.rect(&b));
    println!("      heights {:.1} and {:.1}", ra.height(), rb.height());
    assert!((ra.height() - rb.height()).abs() < 0.5, "{a} is {} tall, {b} is {}", ra.height(), rb.height());
}

#[then(expr = "the {string} button is wider than the {string} button by {int} to {int} pixels")]
fn wider_by(world: &mut IconWorld, a: String, b: String, low: f32, high: f32) {
    let (ra, rb) = (world.rect(&a), world.rect(&b));
    let extra = ra.width() - rb.width();
    println!("      {:.1} px wider ({:.1} against {:.1})", extra, ra.width(), rb.width());
    assert!(extra >= low && extra <= high, "{a} is {extra:.1} px wider than {b}, expected {low} to {high}");
}

#[then(expr = "the {string} button is narrower than the {string} button")]
fn narrower(world: &mut IconWorld, a: String, b: String) {
    let (ra, rb) = (world.rect(&a), world.rect(&b));
    assert!(ra.width() < rb.width(), "{a} is {} wide, {b} is {}", ra.width(), rb.width());
}

#[then(regex = r#"^the "(.+)" button has at least ([0-9.]+) times the ink of the "(.+)" button$"#)]
fn heavier(world: &mut IconWorld, a: String, factor: f32, b: String) {
    let (ra, rb) = (world.rect(&a), world.rect(&b));
    let img = world.picture();
    let (ia, ib) = (ink(&img, ra), ink(&img, rb));
    println!("      ink {ia:.1} against {ib:.1} ({:.2}x)", ia / ib);
    assert!(ia >= ib * factor, "{a} has {ia:.1} ink, {b} has {ib:.1}: {:.2}x, wanted {factor}x", ia / ib);
}

#[then(regex = r"^in every button the icon's centre is within ([0-9.]+) pixels of the capitals' centre$")]
fn aligned(world: &mut IconWorld, tolerance: f32) {
    world.ensure_frame();
    let img = world.picture();
    for (label, r) in world.rects.clone() {
        let runs = ink_runs(&img, r);
        assert!(runs.len() >= 2, "{label}: found {} ink runs", runs.len());
        // The icon is the run before the widest gap, the capitals everything after it.
        let split = (1..runs.len()).max_by_key(|&i| runs[i].0 - runs[i - 1].1).unwrap();
        let icon = (runs[0].0, runs[split - 1].1);
        let text = (runs[split].0, runs.last().unwrap().1);
        let (iy0, iy1) = ink_rows(&img, r, icon).unwrap();
        let (ty0, ty1) = ink_rows(&img, r, text).unwrap();
        let (ic, tc) = ((iy0 + iy1) as f32 / 2.0, (ty0 + ty1) as f32 / 2.0);
        println!("      {label}: icon rows {iy0}..{iy1} (centre {ic}), capitals {ty0}..{ty1} (centre {tc}), off by {:+.1}", ic - tc);
        assert!((ic - tc).abs() <= tolerance, "{label}: icon centre {ic} against capitals {tc}");
    }
}

#[then("every button has ink")]
fn every_button(world: &mut IconWorld) {
    world.ensure_frame();
    let img = world.picture();
    let mut weakest = f32::MAX;
    for (label, r) in world.rects.clone() {
        let amount = ink(&img, r);
        weakest = weakest.min(amount);
        assert!(amount > MIN_INK, "{label} has only {amount:.1} of ink");
    }
    println!("      {} buttons, weakest has {weakest:.1} of ink", world.rects.len());
}

#[then("every tab is on the same line")]
fn same_line(world: &mut IconWorld) {
    world.ensure_frame();
    let y = world.rects[0].1.min.y;
    assert!(world.rects.iter().all(|(_, r)| (r.min.y - y).abs() < 0.5), "tabs are on different lines: {:?}", world.rects);
}

#[then("every tab has ink")]
fn every_tab(world: &mut IconWorld) {
    every_button(world);
}

#[then(expr = "I save the picture {string}")]
fn save_picture(world: &mut IconWorld, name: String) {
    let img = world.picture();
    // Cropped to what was drawn and enlarged 3x so the glyphs can be inspected by eye.
    let right = world.rects.iter().map(|(_, r)| r.max.x).fold(0.0f32, f32::max) as u32 + 8;
    let bottom = world.rects.iter().map(|(_, r)| r.max.y).fold(0.0f32, f32::max) as u32 + 8;
    let crop = image::imageops::crop_imm(&img, 0, 0, right.min(img.width()), bottom.min(img.height())).to_image();
    let big = image::imageops::resize(&crop, crop.width() * 3, crop.height() * 3, image::imageops::FilterType::Nearest);
    big.save(artifacts_dir().join(format!("{name}.png"))).unwrap();
}

fn main() {
    futures::executor::block_on(
        IconWorld::cucumber().max_concurrent_scenarios(1).fail_on_skipped().run_and_exit("tests/features/icons.feature"),
    );
}
