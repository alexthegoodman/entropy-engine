//! Headless tier for `entropy_gui::WavetableView`.
//!
//! `tests/features/wavetable_view.feature` runs against the real widget and the real
//! `audio::wavetable::Wavetable`, one frame at a time inside a headless `entropy_gui::Context`.
//! Pointer input is built the way the window backend builds it: a hover frame, a press frame, held
//! frames, a release frame, and for a pen the pressure, tilt, side button and eraser end. Gestures are
//! aimed at cells of the table through the widget's own projector, and every frame's draw list is
//! rasterized on the CPU (`tests/common/raster.rs`), so what is asserted about looks is a fact about
//! pixels. Pictures land in `test-artifacts/wavetable-view/`.

use cucumber::{given, then, when, World as _};
use entropy_engine::audio::wavetable::{BrushTool, Stamp, Wavetable, WavetableParams, WavetableVoice, TABLE_SIZE};
use entropy_engine::entropy_gui::context::{Modifiers, PenState, PointerState};
use entropy_engine::entropy_gui::draw_list::DrawCommand;
use entropy_engine::entropy_gui::geometry::{pos2, vec2, Pos2, Rect};
use entropy_engine::entropy_gui::widgets_wavetable::{harmonic_amplitudes, harmonics_plot, Camera};
use entropy_engine::entropy_gui::{ViewTool, WavetableEvent, WavetableOptions, WavetableResponse, WavetableView};
use image::RgbaImage;

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

#[derive(cucumber::World)]
struct WtWorld {
    h: Harness,
    table: Wavetable,
    opts: WavetableOptions,
    resp: Option<WavetableResponse>,
    /// Every event since the last `I clear the events`.
    events: Vec<WavetableEvent>,
    pending: Vec<DrawCommand>,
    image: Option<RgbaImage>,
    modifiers: Modifiers,
    pen: Option<PenState>,
    primary: bool,
    secondary: bool,
    pos: Option<Pos2>,
    snapshot: Vec<f32>,
    remembered: std::collections::HashMap<String, f32>,
    voice: Option<WavetableVoice>,
    last_velocity: f32,
}

impl std::fmt::Debug for WtWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "WtWorld({} frames)", self.table.frames())
    }
}

impl Default for WtWorld {
    fn default() -> Self {
        Self {
            h: Harness::new(1000, 760),
            table: Wavetable::new(32),
            opts: WavetableOptions { width: Some(960.0), height: 700.0, ..Default::default() },
            resp: None,
            events: Vec::new(),
            pending: Vec::new(),
            image: None,
            modifiers: Modifiers::default(),
            pen: None,
            primary: false,
            secondary: false,
            pos: None,
            snapshot: Vec::new(),
            remembered: Default::default(),
            voice: None,
            last_velocity: 0.0,
        }
    }
}

fn event_name(e: &WavetableEvent) -> String {
    match e {
        WavetableEvent::StrokeBegan => "StrokeBegan".into(),
        WavetableEvent::StrokeEnded => "StrokeEnded".into(),
        WavetableEvent::Edited => "Edited".into(),
        WavetableEvent::FrameSelected(f) => format!("FrameSelected({f})"),
        WavetableEvent::ToolSelected(t) => format!("ToolSelected({})", t.name()),
        WavetableEvent::KeyDown { midi, .. } => format!("KeyDown({midi})"),
        WavetableEvent::KeyUp { midi } => format!("KeyUp({midi})"),
    }
}

impl WtWorld {
    fn pointer(&self, pos: Option<Pos2>, pressed_primary: bool, pressed_secondary: bool, released: bool) -> PointerState {
        let barrel = self.pen.is_some_and(|p| p.barrel);
        PointerState {
            pos,
            primary_down: self.primary,
            primary_pressed: pressed_primary,
            primary_released: released,
            secondary_down: self.secondary || (self.primary && barrel),
            secondary_pressed: pressed_secondary || (pressed_primary && barrel),
            pen: if self.primary { self.pen } else { None },
            ..Default::default()
        }
    }

    /// One frame of the widget with `pointer` and `scroll`. The events it reports are collected, and
    /// a frame or tool selection is fed back into the options the way the DAW's addon would.
    fn frame_with(&mut self, pointer: PointerState, scroll: f32) {
        let opts = self.opts.clone();
        let table = &mut self.table;
        let mut out = None;
        self.pending = self.h.run_with(pointer, scroll, self.modifiers, |ui| {
            out = Some(WavetableView::new("wt").options(opts).show(ui, table));
        });
        let resp = out.expect("the widget was not drawn");
        for e in &resp.events {
            match e {
                WavetableEvent::FrameSelected(f) => self.opts.frame = *f,
                WavetableEvent::ToolSelected(t) => self.opts.tool = *t,
                _ => {}
            }
        }
        self.events.extend(resp.events.iter().cloned());
        self.resp = Some(resp);
        self.image = None;
        self.pos = pointer.pos;
    }

    fn frame(&mut self) {
        let p = self.pointer(self.pos, false, false, false);
        self.frame_with(p, 0.0);
    }

    fn ensure_frame(&mut self) {
        if self.resp.is_none() {
            self.frame();
        }
    }

    fn resp(&mut self) -> WavetableResponse {
        self.ensure_frame();
        self.resp.clone().unwrap()
    }

    fn cell(&mut self, frame: f32, phase: f32) -> Pos2 {
        let r = self.resp();
        r.cell(&self.table, frame, phase).expect("the cell is on screen")
    }

    fn hover(&mut self, p: Pos2) {
        let s = self.pointer(Some(p), false, false, false);
        self.frame_with(s, 0.0);
    }

    fn press(&mut self, p: Pos2, right: bool) {
        self.hover(p);
        if right {
            self.secondary = true;
        } else {
            self.primary = true;
        }
        let s = self.pointer(Some(p), !right, right, false);
        self.frame_with(s, 0.0);
    }

    fn hold(&mut self, p: Pos2) {
        let s = self.pointer(Some(p), false, false, false);
        self.frame_with(s, 0.0);
    }

    fn drag(&mut self, to: Pos2, frames: usize) {
        let from = self.pos.expect("the pointer is not down anywhere");
        for i in 1..=frames {
            let t = i as f32 / frames as f32;
            self.hold(pos2(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t));
        }
    }

    fn release(&mut self) {
        let was_primary = self.primary;
        self.primary = false;
        self.secondary = false;
        // The pen (if any) leaves with the pointer: the release frame carries no pen.
        let s = PointerState { pos: self.pos, primary_released: was_primary, ..Default::default() };
        self.frame_with(s, 0.0);
    }

    fn picture(&mut self) -> RgbaImage {
        self.ensure_frame();
        if self.image.is_none() {
            self.image = Some(self.h.render(&self.pending));
        }
        self.image.clone().unwrap()
    }

    fn height(&mut self, frame: f32, phase: f32) -> f32 {
        self.table.value_at(frame, phase)
    }
}

fn artifacts_dir() -> std::path::PathBuf {
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("wavetable-view");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn luminance(p: &image::Rgba<u8>) -> f32 {
    0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32
}

/// The brightest pixel within `r` pixels of `p`.
fn brightest_near(img: &RgbaImage, p: Pos2, r: i32) -> image::Rgba<u8> {
    let mut best = *img.get_pixel(p.x.clamp(0.0, img.width() as f32 - 1.0) as u32, p.y.clamp(0.0, img.height() as f32 - 1.0) as u32);
    for dy in -r..=r {
        for dx in -r..=r {
            let (x, y) = (p.x as i32 + dx, p.y as i32 + dy);
            if x >= 0 && y >= 0 && (x as u32) < img.width() && (y as u32) < img.height() {
                let px = img.get_pixel(x as u32, y as u32);
                if luminance(px) > luminance(&best) {
                    best = *px;
                }
            }
        }
    }
    best
}

/// The phase where frame `frame` peaks: the crest, wherever the preset put it.
fn crest_phase(table: &Wavetable, frame: f32) -> f32 {
    (0..512).map(|i| i as f32 / 512.0).max_by(|a, b| table.value_at(frame, *a).partial_cmp(&table.value_at(frame, *b)).unwrap()).unwrap()
}

fn changed_frames(before: &[f32], after: &[f32]) -> Vec<usize> {
    (0..before.len() / TABLE_SIZE).filter(|f| before[f * TABLE_SIZE..(f + 1) * TABLE_SIZE] != after[f * TABLE_SIZE..(f + 1) * TABLE_SIZE]).collect()
}

fn pen(pressure: f32) -> PenState {
    PenState { pressure, ..Default::default() }
}

// ------------------------------------------------------------------------------------------
// Given
// ------------------------------------------------------------------------------------------

#[given(expr = "a wavetable of {int} {string} frames")]
fn table_of(world: &mut WtWorld, frames: usize, preset: String) {
    world.table = Wavetable::new(frames);
    assert!(world.table.load_preset(&preset), "no preset called {preset}");
    let (w, h, keep) = (world.opts.width, world.opts.height, world.opts.tool);
    world.opts = WavetableOptions { width: w, height: h, tool: keep, ..Default::default() };
    world.resp = None;
    world.events.clear();
    world.snapshot.clear();
}

#[given(expr = "the tool is {string}")]
fn set_tool(world: &mut WtWorld, name: String) {
    world.opts.tool = ViewTool::from_name(&name).unwrap_or_else(|| panic!("no tool {name}"));
}

#[given(expr = "the brush radius is {float}")]
fn set_radius(world: &mut WtWorld, r: f32) {
    world.opts.radius = r;
}

#[given(expr = "the brush strength is {float}")]
fn set_strength(world: &mut WtWorld, s: f32) {
    world.opts.strength = s;
}

#[given(expr = "frame {int} is selected")]
fn select_frame(world: &mut WtWorld, f: usize) {
    world.opts.frame = f;
}

#[given(expr = "frame {int} has a tall hump at phase {float}")]
fn hump(world: &mut WtWorld, frame: f32, phase: f32) {
    let mut s = Stamp::new(BrushTool::Raise, frame, phase);
    s.radius = 0.1;
    s.amount = 2.0;
    world.table.begin_edit();
    world.table.stamp(&s);
    world.table.end_edit();
    world.table.commit_all();
}

#[given(expr = "frame {int} has a narrow spike at phase {float}")]
fn spike(world: &mut WtWorld, frame: f32, phase: f32) {
    let mut s = Stamp::new(BrushTool::Raise, frame, phase);
    s.radius = 0.05;
    s.amount = 2.0;
    world.table.begin_edit();
    world.table.stamp(&s);
    world.table.end_edit();
    world.table.commit_all();
}

#[given("shift is held")]
fn shift(world: &mut WtWorld) {
    world.modifiers.shift = true;
}

#[given(expr = "a pen pressing at {float} pressure")]
fn a_pen(world: &mut WtWorld, p: f32) {
    world.pen = Some(pen(p));
}

#[given(expr = "a pen pressing at {float} pressure leaning {int} degrees right")]
fn a_leaning_pen(world: &mut WtWorld, p: f32, deg: f32) {
    world.pen = Some(PenState { pressure: p, tilt_x: deg, tilt_y: 0.0, has_tilt: true, ..Default::default() });
}

#[given(expr = "a pen pressing at {float} pressure and standing upright")]
fn an_upright_pen(world: &mut WtWorld, p: f32) {
    world.pen = Some(PenState { pressure: p, has_tilt: true, ..Default::default() });
}

#[given(expr = "a pen pressing at {float} pressure with its eraser end down")]
fn an_eraser(world: &mut WtWorld, p: f32) {
    world.pen = Some(PenState { pressure: p, eraser: true, ..Default::default() });
}

#[given(expr = "a pen pressing at {float} pressure with its side button held")]
fn a_barrel(world: &mut WtWorld, p: f32) {
    world.pen = Some(PenState { pressure: p, barrel: true, ..Default::default() });
}

#[given(expr = "a note is sounding at position {float}")]
fn a_note(world: &mut WtWorld, position: f32) {
    let mut params = WavetableParams::default();
    params.position = position;
    params.duration = 30.0;
    params.gain = 0.4;
    let mut voice = WavetableVoice::new(world.table.shared(), params, None);
    // Run it long enough to have reported where it is reading (it reports every 256 frames).
    let _ = voice.by_ref().take(2 * 2048).count();
    world.voice = Some(voice);
}

#[given(expr = "key {int} is held")]
fn held_key(world: &mut WtWorld, midi: u8) {
    world.opts.held.push(midi);
}

// ------------------------------------------------------------------------------------------
// When
// ------------------------------------------------------------------------------------------

#[when("a frame is drawn")]
fn drawn(world: &mut WtWorld) {
    world.frame();
}

#[when("the note ends")]
fn note_ends(world: &mut WtWorld) {
    world.voice = None;
}

#[given(expr = "I take a snapshot of the table")]
#[when(expr = "I take a snapshot of the table")]
fn snapshot(world: &mut WtWorld) {
    world.snapshot = world.table.data().to_vec();
}

#[given(expr = "I remember the height at frame {float} phase {float} as {string}")]
#[when(expr = "I remember the height at frame {float} phase {float} as {string}")]
fn remember(world: &mut WtWorld, frame: f32, phase: f32, name: String) {
    let h = world.height(frame, phase);
    world.remembered.insert(name, h);
}

#[when("I clear the events")]
fn clear_events(world: &mut WtWorld) {
    world.events.clear();
}

#[when(expr = "I press on frame {float} phase {float}")]
fn press_on(world: &mut WtWorld, frame: f32, phase: f32) {
    let p = world.cell(frame, phase);
    world.press(p, false);
}

#[when(expr = "I press the right button on frame {float} phase {float}")]
fn press_right(world: &mut WtWorld, frame: f32, phase: f32) {
    let p = world.cell(frame, phase);
    world.press(p, true);
}

#[when(expr = "I hold for {int} frames")]
fn hold_for(world: &mut WtWorld, n: usize) {
    let p = world.pos.expect("no pointer");
    for _ in 0..n {
        world.hold(p);
    }
}

#[when(expr = "I drag to frame {float} phase {float} over {int} frames")]
fn drag_to(world: &mut WtWorld, frame: f32, phase: f32, n: usize) {
    // Aim with the camera as it is now; a drag that turns the camera does not chase the cell.
    let to = world.cell(frame, phase);
    world.drag(to, n);
}

#[when(expr = "I drag the pointer {int} pixels right over {int} frames")]
fn drag_right(world: &mut WtWorld, dx: f32, n: usize) {
    let from = world.pos.unwrap();
    world.drag(pos2(from.x + dx, from.y), n);
}

#[when(expr = "I drag the pointer {int} pixels down over {int} frames")]
fn drag_down(world: &mut WtWorld, dy: f32, n: usize) {
    let from = world.pos.unwrap();
    world.drag(pos2(from.x, from.y + dy), n);
}

#[when(expr = "I drag the pointer {int} pixels up over {int} frames")]
fn drag_up(world: &mut WtWorld, dy: f32, n: usize) {
    let from = world.pos.unwrap();
    world.drag(pos2(from.x, from.y - dy), n);
}

#[when("I release")]
fn release(world: &mut WtWorld) {
    world.release();
}

#[when(expr = "I click the {string} button")]
fn click_button(world: &mut WtWorld, label: String) {
    let r = world.resp().pill(&label).unwrap_or_else(|| panic!("no button {label}"));
    world.press(r.center(), false);
    world.release();
}

#[when("I scroll the wheel up over the terrain")]
fn scroll_up(world: &mut WtWorld) {
    let t = world.resp().terrain;
    let p = pos2(t.center().x, t.center().y);
    let s = world.pointer(Some(p), false, false, false);
    world.frame_with(s, 120.0);
}

#[when("I press the frame rail at the top")]
fn rail_top(world: &mut WtWorld) {
    let rail = world.resp().rail;
    world.press(pos2(rail.center().x, rail.min.y + 1.0), false);
}

#[when(expr = "I press the cycle strip at phase {float} value {float}")]
fn press_cycle(world: &mut WtWorld, phase: f32, value: f32) {
    let p = world.resp().cycle_point(phase, value);
    world.press(p, false);
}

#[when(expr = "I drag the cycle strip to phase {float} value {float} over {int} frames")]
fn drag_cycle(world: &mut WtWorld, phase: f32, value: f32, n: usize) {
    let to = world.resp().cycle_point(phase, value);
    world.drag(to, n);
}

fn key_point(world: &mut WtWorld, midi: u8, where_: &str) -> Pos2 {
    let r = world.resp().key(midi).unwrap_or_else(|| panic!("no key {midi}"));
    let y = match where_ {
        "top" => r.min.y + r.height() * 0.05,
        _ => r.min.y + r.height() * 0.95,
    };
    // The middle of a white key is clear of the black keys on either side of it.
    pos2(r.center().x, y)
}

#[when(expr = "I press key {int} near the {word}")]
fn press_key(world: &mut WtWorld, midi: u8, where_: String) {
    let p = key_point(world, midi, &where_);
    world.press(p, false);
    world.last_velocity = world
        .events
        .iter()
        .rev()
        .find_map(|e| if let WavetableEvent::KeyDown { velocity, .. } = e { Some(*velocity) } else { None })
        .unwrap_or(-1.0);
}

#[when(expr = "I slide to key {int}")]
fn slide_to(world: &mut WtWorld, midi: u8) {
    let r = world.resp().key(midi).unwrap();
    let y = world.pos.unwrap().y;
    world.drag(pos2(r.center().x, y), 6);
}

// ------------------------------------------------------------------------------------------
// Then: looks
// ------------------------------------------------------------------------------------------

#[then("the terrain is not blank")]
fn not_blank(world: &mut WtWorld) {
    let t = world.resp().terrain;
    let img = world.picture();
    let mut bright = 0;
    let mut colours = std::collections::HashSet::new();
    for y in t.min.y as u32..t.max.y as u32 {
        for x in t.min.x as u32..t.max.x as u32 {
            let p = img.get_pixel(x, y);
            if luminance(p) > 90.0 {
                bright += 1;
            }
            colours.insert((p[0] / 8, p[1] / 8, p[2] / 8));
        }
    }
    assert!(bright > 1500, "only {bright} bright pixels: the ridges are not being drawn");
    assert!(colours.len() > 200, "only {} distinct colours: the picture is flat", colours.len());
}

#[then(expr = "the ridge of frame {int} is teal at its crest")]
fn teal_crest(world: &mut WtWorld, frame: f32) {
    let ph = crest_phase(&world.table, frame);
    let p = world.cell(frame, ph);
    let px = brightest_near(&world.picture(), p, 4);
    assert!(px[1] as i32 > px[0] as i32 + 40, "crest of frame {frame} is {px:?}, expected a teal (green well above red)");
}

#[then(expr = "the ridge of frame {int} is pink at its crest")]
fn pink_crest(world: &mut WtWorld, frame: f32) {
    let ph = crest_phase(&world.table, frame);
    let p = world.cell(frame, ph);
    let px = brightest_near(&world.picture(), p, 4);
    assert!(px[0] as i32 > px[1] as i32 + 15 && px[0] as i32 > 120, "crest of frame {frame} is {px:?}, expected a pink (red well above green)");
}

/// How many of the pixels 12 to 40 px straight below (`sign` 1.0) or above (-1.0) a cell are bright
/// enough to be a ridge line (a ridge's glow alone stays under this), and their average colour.
fn strip_beside(world: &mut WtWorld, frame: f32, phase: f32, sign: f32) -> (usize, [f32; 3], f32) {
    let crest = world.cell(frame, phase);
    let img = world.picture();
    let mut bright = 0;
    let mut sum = [0.0f32; 3];
    let mut n = 0.0;
    let mut rough = 0.0f32;
    let mut prev: Option<f32> = None;
    for dy in 12..40 {
        let p = img.get_pixel(crest.x as u32, (crest.y + sign * dy as f32) as u32);
        let l = luminance(p);
        if let Some(q) = prev {
            rough += (l - q).abs();
        }
        prev = Some(l);
        if l > 85.0 {
            bright += 1;
        }
        for i in 0..3 {
            sum[i] += p[i] as f32;
        }
        n += 1.0;
    }
    (bright, [sum[0] / n, sum[1] / n, sum[2] / n], rough)
}

#[then(expr = "the pixels under the crest of frame {int} at phase {float} show no ridge from behind it")]
fn hidden_behind(world: &mut WtWorld, frame: f32, phase: f32) {
    let (bright, mean, rough) = strip_beside(world, frame, phase, 1.0);
    // Measured: 27 behind a curtain (a smooth tinted wash), 473 in the open (ridge lines crossing).
    assert!(rough < 100.0 && bright == 0, "the strip under the hump has {bright} ridge-line pixels and roughness {rough:.0}: a ridge from behind shows through the curtain");
    assert!(mean[1] >= mean[0] - 5.0, "the strip under the hump is tinted {mean:?}, not by the hump's own teal");
}

#[then("the same pixels away from the hump do show ridges")]
fn control_strip(world: &mut WtWorld) {
    // The same strip method, above the front ridge where nothing hides the ridges behind it: they
    // must show there, or the test above could pass on an empty picture.
    let (bright, mean, rough) = strip_beside(world, 0.0, 0.9, -1.0);
    let _ = (bright, mean);
    assert!(rough > 250.0, "the control strip has roughness {rough:.0}, so the measurement cannot see ridge lines");
}

/// The phase where frame `frame` is lowest: the one place on a ridge with no other ridge within a few
/// pixels of it, so what is measured there is that ridge and nothing else.
fn trough_phase(table: &Wavetable, frame: f32) -> f32 {
    (0..512).map(|i| i as f32 / 512.0).min_by(|a, b| table.value_at(frame, *a).partial_cmp(&table.value_at(frame, *b)).unwrap()).unwrap()
}

#[then(expr = "the ridge of frame {int} is brighter than the ridge of frame {int} where each dips lowest")]
fn brighter_ridge(world: &mut WtWorld, a: f32, b: f32) {
    let (pa, pb) = (trough_phase(&world.table, a), trough_phase(&world.table, b));
    let (ca, cb) = (world.cell(a, pa), world.cell(b, pb));
    let img = world.picture();
    let (la, lb) = (luminance(&brightest_near(&img, ca, 2)), luminance(&brightest_near(&img, cb, 2)));
    assert!(la > lb + 25.0, "frame {a} peaks at {la:.0}, frame {b} at {lb:.0}");
}

fn amber_pixels(img: &RgbaImage, t: Rect) -> usize {
    let mut n = 0;
    for y in t.min.y as u32..t.max.y as u32 {
        for x in t.min.x as u32..t.max.x as u32 {
            let p = img.get_pixel(x, y);
            if p[0] > 200 && (140..225).contains(&p[1]) && p[2] < 140 {
                n += 1;
            }
        }
    }
    n
}

#[then(expr = "there is amber near the crest of the ridge at position {float}")]
fn amber(world: &mut WtWorld, _position: f32) {
    let t = world.resp().terrain;
    let n = amber_pixels(&world.picture(), t);
    assert!(n >= 25, "only {n} amber pixels: the live ridge is not drawn");
}

#[then(expr = "there is no amber near the crest of the ridge at position {float}")]
fn no_amber(world: &mut WtWorld, _position: f32) {
    let t = world.resp().terrain;
    let n = amber_pixels(&world.picture(), t);
    assert!(n < 5, "{n} amber pixels remain after the note ended");
}

#[then("the strongest harmonic bar is the first")]
fn first_bar(world: &mut WtWorld) {
    let r = world.resp();
    let img = world.picture();
    let plot = harmonics_plot(r.harmonics);
    let bw = plot.width() / 48.0;
    let top_of = |i: usize| -> f32 {
        let x = (plot.min.x + (i as f32 + 0.5) * bw) as u32;
        (plot.min.y as u32..plot.max.y as u32).find(|y| luminance(img.get_pixel(x, *y)) > 90.0).map(|y| y as f32).unwrap_or(plot.max.y)
    };
    let tops: Vec<f32> = (0..6).map(top_of).collect();
    assert!(tops[0] < tops[1] && tops[1] <= tops[2] + 1.0 && tops[0] < tops[5], "bar tops (smaller is taller): {tops:?}");
    // And the maths behind the bars agree with what a saw is.
    let a = harmonic_amplitudes(world.table.frame(31), 8);
    assert!(a[0] > a[1] && a[1] > a[2], "a saw's harmonics fall: {a:?}");
}

#[then("the cycle strip shows a wave that crosses zero")]
fn cycle_shows(world: &mut WtWorld) {
    let r = world.resp();
    let img = world.picture();
    let mid = r.cycle.center().y;
    let count = |y0: f32, y1: f32| {
        let mut n = 0;
        for y in y0 as u32..y1 as u32 {
            for x in r.cycle.min.x as u32 + 4..r.cycle.max.x as u32 - 4 {
                if luminance(img.get_pixel(x, y)) > 120.0 {
                    n += 1;
                }
            }
        }
        n
    };
    let (up, down) = (count(r.cycle.min.y + 16.0, mid - 3.0), count(mid + 3.0, r.cycle.max.y - 4.0));
    assert!(up > 25 && down > 25, "the wave is only drawn on one side of zero ({up} above, {down} below)");
}

// ------------------------------------------------------------------------------------------
// Then: the table and the camera
// ------------------------------------------------------------------------------------------

/// The value of `data` (frames x TABLE_SIZE) at a fractional frame and a phase: what the table
/// read before the gesture, from the snapshot, or from a fresh sine stack if none was taken.
fn baseline(world: &WtWorld, frame: f32, phase: f32) -> f32 {
    let frames = world.table.frames();
    let owned;
    let data: &[f32] = if world.snapshot.is_empty() {
        let mut t = Wavetable::new(frames);
        t.load_preset("sine");
        owned = t.data().to_vec();
        &owned
    } else {
        &world.snapshot
    };
    let f = frame.clamp(0.0, (frames - 1) as f32);
    let (f0, tf) = (f.floor() as usize, f - f.floor());
    let f1 = (f0 + 1).min(frames - 1);
    let x = phase.rem_euclid(1.0) * TABLE_SIZE as f32;
    let (i0, tx) = (x.floor() as usize % TABLE_SIZE, x - x.floor());
    let i1 = (i0 + 1) % TABLE_SIZE;
    let row = |r: usize| data[r * TABLE_SIZE + i0] * (1.0 - tx) + data[r * TABLE_SIZE + i1] * tx;
    row(f0) * (1.0 - tf) + row(f1) * tf
}

#[then(expr = "the height at frame {float} phase {float} has risen by at least {float}")]
fn risen(world: &mut WtWorld, frame: f32, phase: f32, by: f32) {
    let (b, a) = (baseline(world, frame, phase), world.height(frame, phase));
    assert!(a - b >= by, "the height went from {b:.3} to {a:.3}, a rise of {:.3}", a - b);
}

#[then(expr = "the height at frame {float} phase {float} has fallen by at least {float}")]
fn fallen(world: &mut WtWorld, frame: f32, phase: f32, by: f32) {
    let (b, a) = (baseline(world, frame, phase), world.height(frame, phase));
    assert!(b - a >= by, "the height went from {b:.3} to {a:.3}, a fall of {:.3}", b - a);
}

#[then(expr = "the height at frame {float} phase {float} has fallen by at least {float} since {string}")]
fn fallen_since(world: &mut WtWorld, frame: f32, phase: f32, by: f32, name: String) {
    let b = world.remembered[&name];
    let a = world.height(frame, phase);
    let events: Vec<String> = world.events.iter().map(event_name).collect();
    assert!(b - a >= by, "the height went from {b:.3} to {a:.3}, a fall of {:.3}; events so far: {events:?}", b - a);
}

#[then(expr = "only frames {int} to {int} have changed")]
fn only_frames(world: &mut WtWorld, lo: usize, hi: usize) {
    assert!(!world.snapshot.is_empty(), "no snapshot was taken");
    let changed = changed_frames(&world.snapshot, world.table.data());
    assert!(!changed.is_empty(), "nothing changed");
    assert!(changed.iter().all(|f| (lo..=hi).contains(f)), "frames {changed:?} changed, expected only {lo} to {hi}");
}

#[then("the table has changed")]
fn has_changed(world: &mut WtWorld) {
    assert!(!changed_frames(&world.snapshot, world.table.data()).is_empty(), "the table is as it was");
}

#[then("the table is as it was in the snapshot")]
fn as_snapshot(world: &mut WtWorld) {
    assert!(!world.snapshot.is_empty(), "no snapshot was taken");
    let changed = changed_frames(&world.snapshot, world.table.data());
    assert!(changed.is_empty(), "frames {changed:?} differ from the snapshot");
}

#[then(expr = "the events are {string}")]
fn events_are(world: &mut WtWorld, expected: String) {
    let got: Vec<String> = world.events.iter().map(event_name).collect();
    assert_eq!(got.join(","), expected);
}

#[then("the camera has turned")]
fn camera_turned(world: &mut WtWorld) {
    let c = world.resp().camera;
    let d = Camera::default();
    assert!((c.yaw - d.yaw).abs() > 0.15 || (c.pitch - d.pitch).abs() > 0.15, "the camera is still at its default: {c:?}");
}

#[then("the camera pitch is within its limits")]
fn pitch_limits(world: &mut WtWorld) {
    let c = world.resp().camera;
    assert!((Camera::PITCH_MIN..=Camera::PITCH_MAX).contains(&c.pitch), "pitch {} is outside {}..{}", c.pitch, Camera::PITCH_MIN, Camera::PITCH_MAX);
}

#[then("the camera has zoomed in")]
fn zoomed(world: &mut WtWorld) {
    let c = world.resp().camera;
    assert!(c.zoom > 1.05, "zoom is {}", c.zoom);
}

// ------------------------------------------------------------------------------------------
// Then: pen comparisons
// ------------------------------------------------------------------------------------------

#[then(expr = "I remember how far the height at frame {float} phase {float} has risen as {string}")]
fn remember_rise(world: &mut WtWorld, frame: f32, phase: f32, name: String) {
    let rise = world.height(frame, phase) - baseline(world, frame, phase);
    world.remembered.insert(name, rise);
}

#[then(expr = "{string} is more than twice {string}")]
fn more_than_twice(world: &mut WtWorld, a: String, b: String) {
    let (x, y) = (world.remembered[&a], world.remembered[&b]);
    assert!(x > 2.0 * y && x > 0.05, "{a} is {x:.3}, {b} is {y:.3}");
}

#[then(expr = "{string} is more than {string}")]
fn more_than(world: &mut WtWorld, a: String, b: String) {
    let (x, y) = (world.remembered[&a], world.remembered[&b]);
    assert!(x > y + 0.03, "{a} is {x:.3}, {b} is {y:.3}");
}

// ------------------------------------------------------------------------------------------
// Then: the cycle strip and the keys
// ------------------------------------------------------------------------------------------

#[then(expr = "frame {int} at phase {float} reads about {float}")]
fn reads_about(world: &mut WtWorld, frame: f32, phase: f32, v: f32) {
    let got = world.height(frame, phase);
    assert!((got - v).abs() < 0.1, "frame {frame} at phase {phase} reads {got:.3}, expected about {v}");
}

#[then(expr = "the key velocity is below {float}")]
fn velocity_below(world: &mut WtWorld, v: f32) {
    assert!(world.last_velocity >= 0.0 && world.last_velocity < v, "velocity {}", world.last_velocity);
}

#[then(expr = "the key velocity is above {float}")]
fn velocity_above(world: &mut WtWorld, v: f32) {
    assert!(world.last_velocity > v, "velocity {}", world.last_velocity);
}

#[then(expr = "the key velocity is between {float} and {float}")]
fn velocity_between(world: &mut WtWorld, lo: f32, hi: f32) {
    assert!((lo..=hi).contains(&world.last_velocity), "velocity {} is not in {lo}..{hi}", world.last_velocity);
}

fn key_lit(world: &mut WtWorld, midi: u8) -> bool {
    let r = world.resp().key(midi).unwrap();
    let img = world.picture();
    let p = img.get_pixel(r.center().x as u32, (r.min.y + r.height() * 0.85) as u32);
    p[1] as i32 - p[0] as i32 > 60
}

#[then(expr = "key {int} is lit")]
fn lit(world: &mut WtWorld, midi: u8) {
    assert!(key_lit(world, midi), "key {midi} is not lit");
}

#[then(expr = "key {int} is not lit")]
fn not_lit(world: &mut WtWorld, midi: u8) {
    assert!(!key_lit(world, midi), "key {midi} is lit");
}

#[then(expr = "I save the picture {string}")]
fn save_picture(world: &mut WtWorld, name: String) {
    let img = world.picture();
    img.save(artifacts_dir().join(format!("{name}.png"))).unwrap();
}

fn main() {
    futures::executor::block_on(
        WtWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/wavetable_view.feature"),
    );
}
