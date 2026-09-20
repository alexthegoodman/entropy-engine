//! Headless tier for `entropy_gui::PadGrid` and the scrolling `TreeView`.
//!
//! `tests/features/pad_grid.feature` runs against the real widgets inside a headless
//! `entropy_gui::Context`, one frame at a time. Pointer input is built the way the window backend
//! builds it (a hover frame, a press frame, a release frame), the widgets' events are read back, and
//! each frame's draw list is rasterized on the CPU (triangles with per-vertex colour, glyph-atlas
//! text, 2x supersampled) so what is asserted about looks is a fact about pixels. The rasterizer is
//! the one `audio_widgets_bdd` uses. Pictures land in `test-artifacts/pad-grid/`.

use cucumber::{given, then, when, World as _};
use entropy_engine::entropy_gui::color::Color32;
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::draw_list::{DrawCommand, DrawTexture};
use entropy_engine::entropy_gui::geometry::{pos2, vec2, Pos2, Rect};
use entropy_engine::entropy_gui::response::Sense;
use entropy_engine::entropy_gui::{
    CentralPanel, Context, Pad, PadEvent, PadGrid, PadGridOptions, PadKind, RawInput, ScrollArea, TreeEvent, TreeNode, TreeView,
};
use image::RgbaImage;

const SS: usize = 2;
const ATLAS: usize = 1024;
const BLUE: Color32 = Color32::from_rgb(60, 140, 230);

// ------------------------------------------------------------------------------------------
// A small CPU rasterizer for entropy_gui draw lists (the same one audio_widgets_bdd uses)
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

    fn run(&mut self, pointer: PointerState, scroll: f32, add: impl FnOnce(&mut entropy_engine::entropy_gui::Ui)) -> Vec<DrawCommand> {
        let raw = RawInput {
            screen_rect: Rect::from_min_size(pos2(0.0, 0.0), vec2(self.width as f32, self.height as f32)),
            pixels_per_point: 1.0,
            pointer,
            scroll_delta: vec2(0.0, scroll),
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
        // Bilinear, texel centres at +0.5.
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

    /// Composites `commands` over an opaque window-grey background and box-filters down to 1x.
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

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Pads,
    Tree,
    Page,
}

#[derive(cucumber::World)]
struct PadWorld {
    h: Harness,
    mode: Mode,
    pads: Vec<Pad>,
    opts: PadGridOptions,
    nodes: Vec<TreeNode>,
    cap: f32,
    // What the last frame reported.
    rects: Vec<(String, Rect)>,
    add_rect: Option<Rect>,
    events: Vec<String>,
    tree_top: Pos2,
    tree_height: f32,
    marker_y: f32,
    marker_y_first: f32,
    pending: Vec<DrawCommand>,
    image: Option<RgbaImage>,
    brightness_before: f32,
    frames: usize,
}

impl std::fmt::Debug for PadWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PadWorld({:?})", self.mode)
    }
}

impl Default for PadWorld {
    fn default() -> Self {
        Self {
            h: Harness::new(900, 560),
            mode: Mode::Pads,
            pads: Vec::new(),
            opts: PadGridOptions::default(),
            nodes: Vec::new(),
            cap: 200.0,
            rects: Vec::new(),
            add_rect: None,
            events: Vec::new(),
            tree_top: pos2(0.0, 0.0),
            tree_height: 0.0,
            marker_y: 0.0,
            marker_y_first: f32::NAN,
            pending: Vec::new(),
            image: None,
            brightness_before: 0.0,
            frames: 0,
        }
    }
}

fn tree_nodes(n: usize) -> Vec<TreeNode> {
    (0..n).map(|i| TreeNode::new(format!("r{i}"), format!("row {i}"), 0)).collect()
}

fn sample_pad(id: &str, color: Color32, trim: [f32; 2]) -> Pad {
    let mut p = Pad::new(id, "Kick", color);
    p.kind = PadKind::Sample;
    p.waveform = vec![1.0; 48];
    p.trim = trim;
    p.sublabel = "kick_808".into();
    p.hint = "C2".into();
    p
}

impl PadWorld {
    /// One frame through whichever widget the scenario set up.
    fn frame(&mut self, pointer: PointerState, scroll: f32) {
        let mut events: Vec<String> = Vec::new();
        self.frames += 1;
        match self.mode {
            Mode::Pads => {
                let (pads, opts) = (self.pads.clone(), self.opts);
                let mut out = None;
                self.pending = self.h.run(pointer, scroll, |ui| {
                    let r = PadGrid::new("grid").options(opts).show(ui, &pads);
                    out = Some((r.events, r.rects, r.add_rect));
                });
                let (ev, rects, add) = out.unwrap();
                for e in ev {
                    events.push(match e {
                        PadEvent::Clicked(id) => format!("Clicked({id})"),
                        PadEvent::Cleared(id) => format!("Cleared({id})"),
                        PadEvent::AddRequested => "AddRequested".into(),
                    });
                }
                self.rects = rects;
                self.add_rect = add;
            }
            Mode::Tree => {
                let (nodes, cap) = (self.nodes.clone(), self.cap);
                let mut out = None;
                self.pending = self.h.run(pointer, scroll, |ui| {
                    let top = ui.available_rect_before_wrap().min;
                    let r = TreeView::new("tree").max_height(cap).width(300.0).show(ui, &nodes);
                    out = Some((r.events, top, ui.min_rect().height()));
                });
                let (ev, top, height) = out.unwrap();
                events.extend(ev.into_iter().map(tree_event));
                self.tree_top = top;
                self.tree_height = height;
            }
            Mode::Page => {
                let (nodes, cap) = (self.nodes.clone(), self.cap);
                let mut out = None;
                self.pending = self.h.run(pointer, scroll, |ui| {
                    ScrollArea::vertical().show(ui, |ui| {
                        let (marker, _) = ui.allocate_exact_size(vec2(10.0, 10.0), Sense::hover());
                        let top = ui.available_rect_before_wrap().min;
                        let r = TreeView::new("tree").max_height(cap).width(300.0).show(ui, &nodes);
                        ui.allocate_exact_size(vec2(10.0, 1400.0), Sense::hover());
                        out = Some((r.events, top, marker.min.y));
                    });
                });
                let (ev, top, marker_y) = out.unwrap();
                events.extend(ev.into_iter().map(tree_event));
                self.tree_top = top;
                self.marker_y = marker_y;
                if self.marker_y_first.is_nan() {
                    self.marker_y_first = marker_y;
                }
            }
        }
        self.events = events;
        self.image = None;
    }

    fn hover(&mut self, p: Pos2) {
        self.frame(PointerState { pos: Some(p), ..Default::default() }, 0.0);
    }

    /// Hover, press and release at `p`; the events are the ones from the press frame, which is
    /// where the widgets report a click.
    fn click(&mut self, p: Pos2, secondary: bool) {
        self.hover(p);
        let press = if secondary {
            PointerState { pos: Some(p), secondary_pressed: true, secondary_down: true, ..Default::default() }
        } else {
            PointerState { pos: Some(p), primary_pressed: true, primary_down: true, ..Default::default() }
        };
        self.frame(press, 0.0);
        let pressed_events = std::mem::take(&mut self.events);
        let release = PointerState { pos: Some(p), primary_released: !secondary, ..Default::default() };
        self.frame(release, 0.0);
        self.events = pressed_events;
    }

    fn rect(&self, n: usize) -> Rect {
        self.rects[n - 1].1
    }

    /// Widget geometry only exists once a frame has been drawn.
    fn ensure_frame(&mut self) {
        if self.rects.is_empty() && self.mode == Mode::Pads {
            self.frame(PointerState::default(), 0.0);
        }
    }

    fn picture(&mut self) -> RgbaImage {
        if self.image.is_none() {
            self.image = Some(self.h.render(&self.pending));
        }
        self.image.clone().unwrap()
    }

    /// The area a sample pad draws its waveform in (see `widgets_pads`: 10 px in from the sides,
    /// below the 22 px header and above the 20 px footer).
    fn picture_area(&self) -> Rect {
        let r = self.rect(1);
        Rect::from_min_max(pos2(r.min.x + 10.0, r.min.y + 26.0), pos2(r.max.x - 10.0, r.max.y - 22.0))
    }
}

fn tree_event(e: TreeEvent) -> String {
    match e {
        TreeEvent::Selected(id) => format!("Selected({id})"),
        TreeEvent::ToggleExpand(id) => format!("Toggle({id})"),
        TreeEvent::Marked(id, v) => format!("Marked({id},{v})"),
    }
}

fn px(img: &RgbaImage, x: f32, y: f32) -> [i32; 3] {
    let p = img.get_pixel(x.round() as u32, y.round() as u32);
    [p[0] as i32, p[1] as i32, p[2] as i32]
}

fn mean_brightness(img: &RgbaImage, r: Rect) -> f32 {
    let (mut sum, mut n) = (0.0f64, 0.0f64);
    for y in r.min.y as u32..r.max.y as u32 {
        for x in r.min.x as u32..r.max.x as u32 {
            let p = img.get_pixel(x, y);
            sum += (p[0] as f64 + p[1] as f64 + p[2] as f64) / 3.0;
            n += 1.0;
        }
    }
    (sum / n) as f32
}

fn artifacts_dir() -> std::path::PathBuf {
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("pad-grid");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

// ------------------------------------------------------------------------------------------
// Pad grid steps
// ------------------------------------------------------------------------------------------

#[given(expr = "a pad grid of {int} pads in {int} columns of {int} by {int} pixels")]
fn grid(world: &mut PadWorld, n: usize, cols: usize, w: f32, h: f32) {
    world.mode = Mode::Pads;
    world.pads = (1..=n).map(|i| sample_pad(&format!("pad-{i}"), BLUE, [0.0, 1.0])).collect();
    world.opts = PadGridOptions { columns: cols, pad_size: vec2(w, h), add_tile: false };
}

#[given(expr = "a pad grid of {int} pads in {int} columns of {int} by {int} pixels with an add tile")]
fn grid_tile(world: &mut PadWorld, n: usize, cols: usize, w: f32, h: f32) {
    grid(world, n, cols, w, h);
    world.opts.add_tile = true;
}

#[given(expr = "a pad grid with one blue sample pad whose waveform is full height and trim is {float} to {float}")]
fn one_pad(world: &mut PadWorld, a: f32, b: f32) {
    world.mode = Mode::Pads;
    world.pads = vec![sample_pad("pad-1", BLUE, [a, b])];
    world.opts = PadGridOptions::default();
}

#[given("a pad grid with a synth pad, an empty pad, a sample pad and a missing pad")]
fn four_kinds(world: &mut PadWorld) {
    world.mode = Mode::Pads;
    let mut pads = Vec::new();
    for (i, kind) in [PadKind::Synth, PadKind::Empty, PadKind::Sample, PadKind::Missing].into_iter().enumerate() {
        let mut p = Pad::new(format!("pad-{}", i + 1), "Pad", BLUE);
        p.kind = kind;
        if matches!(kind, PadKind::Sample | PadKind::Missing) {
            p.waveform = (0..48).map(|k| 1.0 - k as f32 / 48.0).collect();
        }
        pads.push(p);
    }
    world.pads = pads;
    world.opts = PadGridOptions::default();
}

#[given("the pad's file is missing")]
fn missing(world: &mut PadWorld) {
    world.pads[0].kind = PadKind::Missing;
}

#[when("the pad is selected")]
fn select(world: &mut PadWorld) {
    world.pads[0].selected = true;
}

#[when("the pad glows at full strength")]
fn glow(world: &mut PadWorld) {
    world.pads[0].glow = 1.0;
}

#[when("a frame is drawn")]
fn draw(world: &mut PadWorld) {
    world.frame(PointerState::default(), 0.0);
}

#[when("I remember how bright the pad is")]
fn remember(world: &mut PadWorld) {
    let r = world.rect(1).shrink(2.0);
    let img = world.picture();
    world.brightness_before = mean_brightness(&img, r);
}

#[when(expr = "I click pad {int}")]
fn click_pad(world: &mut PadWorld, n: usize) {
    world.ensure_frame();
    let c = world.rect(n).center();
    world.click(c, false);
}

#[when(expr = "I right-click pad {int}")]
fn right_click_pad(world: &mut PadWorld, n: usize) {
    world.ensure_frame();
    let c = world.rect(n).center();
    world.click(c, true);
}

#[when("I click the add tile")]
fn click_add(world: &mut PadWorld) {
    world.ensure_frame();
    let c = world.add_rect.expect("an add tile").center();
    world.click(c, false);
}

#[when(expr = "I click between pad {int} and pad {int}")]
fn click_gap(world: &mut PadWorld, a: usize, b: usize) {
    world.ensure_frame();
    let (ra, rb) = (world.rect(a), world.rect(b));
    let p = pos2((ra.max.x + rb.min.x) / 2.0, ra.center().y);
    world.click(p, false);
}

#[then(expr = "the events are {string}")]
fn events_are(world: &mut PadWorld, text: String) {
    assert_eq!(world.events.join(", "), text);
}

#[then("there are no events")]
fn no_events(world: &mut PadWorld) {
    assert!(world.events.is_empty(), "{:?}", world.events);
}

#[then(expr = "pad {int} is {int} pixels right of pad {int}")]
fn right_of(world: &mut PadWorld, b: usize, dx: f32, a: usize) {
    let (ra, rb) = (world.rect(a), world.rect(b));
    assert!((rb.min.x - ra.min.x - dx).abs() < 0.01 && (rb.min.y - ra.min.y).abs() < 0.01, "{ra:?} {rb:?}");
}

#[then(expr = "pad {int} is directly below pad {int} by {int} pixels")]
fn below(world: &mut PadWorld, b: usize, a: usize, dy: f32) {
    let (ra, rb) = (world.rect(a), world.rect(b));
    assert!((rb.min.y - ra.min.y - dy).abs() < 0.01 && (rb.min.x - ra.min.x).abs() < 0.01, "{ra:?} {rb:?}");
}

#[then(expr = "the add tile is {int} pixels right of pad {int}")]
fn add_right_of(world: &mut PadWorld, dx: f32, n: usize) {
    let (r, add) = (world.rect(n), world.add_rect.expect("an add tile"));
    assert!((add.min.x - r.min.x - dx).abs() < 0.01 && (add.min.y - r.min.y).abs() < 0.01, "{r:?} {add:?}");
}

#[then(expr = "I save the picture {string}")]
fn save_picture(world: &mut PadWorld, name: String) {
    let img = world.picture();
    img.save(artifacts_dir().join(format!("{name}.png"))).unwrap();
    let colours: std::collections::HashSet<[u8; 4]> = img.pixels().map(|p| p.0).collect();
    assert!(colours.len() > 60, "{name} looks blank: {} colours", colours.len());
}

fn blue_at(world: &mut PadWorld, frac: f32) -> i32 {
    let a = world.picture_area();
    let img = world.picture();
    px(&img, a.min.x + a.width() * frac, a.center().y)[2]
}

#[then("the waveform is brighter in the played half than in the trimmed-off half")]
fn brighter_played(world: &mut PadWorld) {
    let (left, right) = (blue_at(world, 0.25), blue_at(world, 0.75));
    println!("    blue channel: trimmed-off half {left}, played half {right}");
    assert!(right > left + 40, "left {left}, right {right}");
}

#[then("the waveform is equally bright on both halves")]
fn equal(world: &mut PadWorld) {
    let (left, right) = (blue_at(world, 0.25), blue_at(world, 0.75));
    assert!((left - right).abs() < 10, "left {left}, right {right}");
}

fn white_near(world: &mut PadWorld, frac: f32) -> bool {
    let a = world.picture_area();
    let img = world.picture();
    let x = a.min.x + a.width() * frac;
    (-1..=1).any(|dx| {
        let p = px(&img, x + dx as f32, a.min.y + 3.0);
        p[0] > 100 && p[1] > 100 && p[2] > 100
    })
}

#[then("the trim edge is marked in white")]
fn trim_marked(world: &mut PadWorld) {
    assert!(white_near(world, 0.5), "no white mark at the trim start");
}

#[then("no trim edge is marked")]
fn no_trim(world: &mut PadWorld) {
    assert!(!white_near(world, 0.5) && !white_near(world, 0.0) && !white_near(world, 1.0));
}

fn strip(world: &mut PadWorld) -> [i32; 3] {
    let r = world.rect(1);
    let img = world.picture();
    px(&img, r.center().x, r.min.y + 2.5)
}

#[then("the pad's accent strip is red")]
fn strip_red(world: &mut PadWorld) {
    let p = strip(world);
    assert!(p[0] > p[2] + 60, "{p:?}");
}

#[then("the pad's accent strip is blue")]
fn strip_blue(world: &mut PadWorld) {
    let p = strip(world);
    assert!(p[2] > p[0] + 60, "{p:?}");
}

/// The pixels across the pad's left border at mid height: one column outside it, its own, one inside.
fn edge(world: &mut PadWorld) -> Vec<[i32; 3]> {
    let r = world.rect(1);
    let img = world.picture();
    (-1..=1).map(|dx| px(&img, r.min.x + dx as f32, r.center().y)).collect()
}

fn accent_blue(p: &[i32; 3]) -> bool {
    p[2] > p[0] + 110
}

#[then("the pad's left edge is blue")]
fn edge_blue(world: &mut PadWorld) {
    let e = edge(world);
    assert!(e.iter().any(accent_blue), "{e:?}");
}

#[then("the pad's left edge is not blue")]
fn edge_plain(world: &mut PadWorld) {
    let e = edge(world);
    assert!(!e.iter().any(accent_blue), "{e:?}");
}

#[then("the pad is brighter than it was")]
fn brighter(world: &mut PadWorld) {
    let r = world.rect(1).shrink(2.0);
    let img = world.picture();
    let now = mean_brightness(&img, r);
    println!("    mean brightness {:.1} -> {now:.1}", world.brightness_before);
    assert!(now > world.brightness_before + 8.0, "{} -> {now}", world.brightness_before);
}

#[then("the four pads are drawn differently from one another")]
fn kinds_differ(world: &mut PadWorld) {
    let n = world.pads.len();
    let rects: Vec<Rect> = (1..=n).map(|i| world.rect(i)).collect();
    let img = world.picture();
    for a in 0..n {
        for b in (a + 1)..n {
            let mut differing = 0;
            let (ra, rb) = (rects[a], rects[b]);
            for dy in 10..(ra.height() as u32 - 10) {
                for dx in 10..(ra.width() as u32 - 10) {
                    let pa = img.get_pixel(ra.min.x as u32 + dx, ra.min.y as u32 + dy);
                    let pb = img.get_pixel(rb.min.x as u32 + dx, rb.min.y as u32 + dy);
                    if (0..3).map(|i| (pa[i] as i32 - pb[i] as i32).abs()).sum::<i32>() > 40 {
                        differing += 1;
                    }
                }
            }
            println!("    pad {} vs pad {}: {differing} pixels differ", a + 1, b + 1);
            assert!(differing > 60, "pads {} and {} look the same", a + 1, b + 1);
        }
    }
}

// ------------------------------------------------------------------------------------------
// Tree steps
// ------------------------------------------------------------------------------------------

#[given(expr = "a tree of {int} rows capped at {int} pixels")]
fn tree(world: &mut PadWorld, n: usize, cap: f32) {
    world.mode = Mode::Tree;
    world.nodes = tree_nodes(n);
    world.cap = cap;
}

#[given(expr = "a page that scrolls, holding a tree of {int} rows capped at {int} pixels")]
fn page(world: &mut PadWorld, n: usize, cap: f32) {
    world.mode = Mode::Page;
    world.nodes = tree_nodes(n);
    world.cap = cap;
}

#[given(expr = "a tree of {int} rows with icons and details")]
fn tree_details(world: &mut PadWorld, n: usize) {
    world.mode = Mode::Tree;
    world.cap = 400.0;
    world.nodes = (0..n)
        .map(|i| {
            let mut node = TreeNode::new(format!("r{i}"), format!("sample_{i}.wav"), 0);
            node.icon = "\u{266A}".into();
            node.detail = "84 KB".into();
            node
        })
        .collect();
}

#[then(expr = "the tree is {int} pixels tall")]
fn tree_tall(world: &mut PadWorld, h: f32) {
    assert!((world.tree_height - h).abs() < 1.0, "{}", world.tree_height);
}

#[when("I click the top row of the tree")]
fn click_top(world: &mut PadWorld) {
    let p = pos2(world.tree_top.x + 60.0, world.tree_top.y + 11.0);
    world.click(p, false);
}

#[when(expr = "I turn the wheel by {int} pixels over the tree")]
fn wheel_tree(world: &mut PadWorld, px: f32) {
    let p = pos2(world.tree_top.x + 60.0, world.tree_top.y + 100.0);
    world.frame(PointerState { pos: Some(p), ..Default::default() }, -px);
}

#[when(expr = "I turn the wheel by {int} pixels over the page below the tree")]
fn wheel_page(world: &mut PadWorld, px: f32) {
    let p = pos2(world.tree_top.x + 60.0, world.tree_top.y + world.cap + 120.0);
    world.frame(PointerState { pos: Some(p), ..Default::default() }, -px);
}

#[then("the page has not moved")]
fn page_still(world: &mut PadWorld) {
    assert!((world.marker_y - world.marker_y_first).abs() < 0.01, "the page moved from {} to {}", world.marker_y_first, world.marker_y);
}

#[then("the page has moved")]
fn page_moved(world: &mut PadWorld) {
    assert!(world.marker_y < world.marker_y_first - 30.0, "the page is still at {} (started at {})", world.marker_y, world.marker_y_first);
}

#[then("the tree has scrolled")]
fn tree_scrolled(world: &mut PadWorld) {
    // Rows are 22 px, so a 132 px wheel total puts row 6 at the top.
    let p = pos2(world.tree_top.x + 60.0, world.tree_top.y + 11.0);
    world.click(p, false);
    assert_eq!(world.events.join(","), "Selected(r6)", "the tree did not scroll by the wheel it was given");
}

#[then("the tree has lit pixels at both ends of its rows")]
fn tree_lit(world: &mut PadWorld) {
    let img = world.picture();
    let (x0, y0) = (world.tree_top.x, world.tree_top.y);
    let lit_in = |xa: f32, xb: f32| {
        (xa as u32..xb as u32).any(|x| (y0 as u32..y0 as u32 + 22).any(|y| {
            let p = img.get_pixel(x, y);
            p[0].max(p[1]).max(p[2]) > 70
        }))
    };
    assert!(lit_in(x0 + 20.0, x0 + 42.0), "no icon at the left end of the row");
    assert!(lit_in(x0 + 250.0, x0 + 294.0), "no detail text at the right end of the row");
}

fn main() {
    futures::executor::block_on(
        PadWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/pad_grid.feature"),
    );
}
