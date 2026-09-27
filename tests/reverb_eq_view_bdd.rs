//! Headless tier for `entropy_gui::ReverbEqView`.
//!
//! `tests/features/reverb_eq_view.feature` runs against the real widget, one frame at a time inside
//! a headless `entropy_gui::Context`. Gestures are aimed through the widget's own geometry (its
//! node positions, chip rects and EQ plot mapping), and every frame's draw list is rasterized on the
//! CPU (`tests/common/raster.rs`), so what is asserted about looks is a fact about pixels. Pictures
//! land in `test-artifacts/reverb-eq-view/`.

use cucumber::{given, then, when, World as _};
use entropy_engine::audio::eq::{BandKind, EqBand};
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::draw_list::DrawCommand;
use entropy_engine::entropy_gui::geometry::{pos2, Pos2, Rect};
use entropy_engine::entropy_gui::widgets_reverb_eq::eq_point;
use entropy_engine::entropy_gui::{ReverbEqEvent, ReverbEqOptions, ReverbEqResponse, ReverbEqView, ReverbSettings, SpaceView};
use image::RgbaImage;

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

#[derive(cucumber::World)]
struct RvWorld {
    h: Harness,
    opts: ReverbEqOptions,
    resp: Option<ReverbEqResponse>,
    events: Vec<ReverbEqEvent>,
    pending: Vec<DrawCommand>,
    image: Option<RgbaImage>,
    primary: bool,
    secondary: bool,
    pos: Option<Pos2>,
    camera_before: Option<(f32, f32)>,
}

impl std::fmt::Debug for RvWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RvWorld({} events)", self.events.len())
    }
}

impl Default for RvWorld {
    fn default() -> Self {
        Self {
            h: Harness::new(1000, 720),
            opts: ReverbEqOptions {
                width: Some(980.0),
                height: 690.0,
                reverb: ReverbSettings { room_size: 16.0, time: 1.8, damping: 0.5, mix: 0.3 },
                caption: Some("Lead".into()),
                ..Default::default()
            },
            resp: None,
            events: Vec::new(),
            pending: Vec::new(),
            image: None,
            primary: false,
            secondary: false,
            pos: None,
            camera_before: None,
        }
    }
}

impl RvWorld {
    fn pointer(&self, pos: Option<Pos2>, pressed_primary: bool, pressed_secondary: bool, released: bool) -> PointerState {
        PointerState {
            pos,
            primary_down: self.primary,
            primary_pressed: pressed_primary,
            primary_released: released,
            secondary_down: self.secondary,
            secondary_pressed: pressed_secondary,
            ..Default::default()
        }
    }

    /// One frame. Band edits, selections and view changes are fed back into the options the way
    /// the DAW's addon does.
    fn frame_with(&mut self, pointer: PointerState, scroll: f32) {
        let opts = self.opts.clone();
        let mut out = None;
        self.pending = self.h.run(pointer, scroll, |ui| {
            out = Some(ReverbEqView::new("rv").options(opts).show(ui));
        });
        let resp = out.expect("the widget was not drawn");
        for e in &resp.events {
            match e {
                ReverbEqEvent::BandChanged { index, band } => self.opts.eq.bands[*index] = *band,
                ReverbEqEvent::BandSelected(s) => self.opts.selected = *s,
                ReverbEqEvent::ViewSelected(v) => self.opts.view = *v,
                ReverbEqEvent::EditEnded => {}
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

    fn resp(&mut self) -> ReverbEqResponse {
        if self.resp.is_none() {
            self.frame();
        }
        self.resp.clone().unwrap()
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

    fn drag(&mut self, to: Pos2, frames: usize) {
        let from = self.pos.expect("the pointer is not down anywhere");
        for i in 1..=frames {
            let t = i as f32 / frames as f32;
            let s = self.pointer(Some(pos2(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t)), false, false, false);
            self.frame_with(s, 0.0);
        }
    }

    fn release(&mut self) {
        let was_primary = self.primary;
        self.primary = false;
        self.secondary = false;
        let s = PointerState { pos: self.pos, primary_released: was_primary, ..Default::default() };
        self.frame_with(s, 0.0);
    }

    fn picture(&mut self) -> RgbaImage {
        if self.resp.is_none() {
            self.frame();
        }
        if self.image.is_none() {
            self.image = Some(self.h.render(&self.pending));
        }
        self.image.clone().unwrap()
    }

    fn node(&mut self, band: usize) -> Pos2 {
        self.resp().nodes[band - 1]
    }

    fn last_change(&self, band: usize) -> Option<EqBand> {
        self.events.iter().rev().find_map(|e| match e {
            ReverbEqEvent::BandChanged { index, band: b } if *index == band - 1 => Some(*b),
            _ => None,
        })
    }
}

fn artifacts_dir() -> std::path::PathBuf {
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("reverb-eq-view");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Pixels in `r` that are clearly lit (not the dark backdrop).
fn lit_pixels(img: &RgbaImage, r: Rect) -> usize {
    let mut n = 0;
    for y in r.min.y.max(0.0) as u32..(r.max.y as u32).min(img.height()) {
        for x in r.min.x.max(0.0) as u32..(r.max.x as u32).min(img.width()) {
            let p = img.get_pixel(x, y).0;
            if p[0] as u32 + p[1] as u32 + p[2] as u32 > 240 {
                n += 1;
            }
        }
    }
    n
}

// ---------------------------------------------------------------- given

#[given(regex = r"^a reverb of ([\d.]+) m, ([\d.]+) s, damping ([\d.]+) and mix ([\d.]+)$")]
fn given_reverb(world: &mut RvWorld, size: f32, time: f32, damping: f32, mix: f32) {
    world.opts.reverb = ReverbSettings { room_size: size, time, damping, mix };
}

#[given(regex = r"^band (\d) is a bell at ([\d.]+) Hz with ([+-][\d.]+) dB(?: and Q ([\d.]+))?$")]
fn given_bell(world: &mut RvWorld, band: usize, hz: f32, db: f32, q: String) {
    let q = q.parse().unwrap_or(1.0);
    world.opts.eq.bands[band - 1] = EqBand::new(BandKind::Peak, true, hz, db, q);
}

#[given(regex = r"^band (\d) is on$")]
fn given_on(world: &mut RvWorld, band: usize) {
    world.opts.eq.bands[band - 1].enabled = true;
}

#[given(regex = r"^the track is playing a tone at ([\d.]+) Hz$")]
fn given_tone(world: &mut RvWorld, hz: f32) {
    // A 4096-point spectrum: a peak at the tone and its first harmonics over a soft noise floor.
    let n = 2049;
    let bin_hz = world.opts.sample_rate * 0.5 / (n - 1) as f32;
    let mut bins = vec![-78.0f32; n];
    for (h, level) in [(1.0f32, -8.0f32), (2.0, -20.0), (3.0, -28.0), (4.0, -36.0)] {
        let b = (hz * h / bin_hz).round() as usize;
        for d in 0..5usize {
            let v = level - 9.0 * d as f32;
            if b + d < n {
                bins[b + d] = bins[b + d].max(v);
            }
            if b >= d {
                bins[b - d] = bins[b - d].max(v);
            }
        }
    }
    world.opts.spectrum_db = bins;
}

#[given(regex = r#"^the view is "(\w+)"$"#)]
fn given_view(world: &mut RvWorld, view: String) {
    world.opts.view = SpaceView::from_name(&view).expect("a view name");
}

// ---------------------------------------------------------------- when

#[when("a frame is drawn")]
fn when_frame(world: &mut RvWorld) {
    world.frame();
}

#[when(regex = r"^(\d+) frames are drawn$")]
fn when_frames(world: &mut RvWorld, n: usize) {
    for _ in 0..n {
        world.frame();
    }
}

#[when(regex = r"^I drag band (\d)'s node to ([\d.]+) Hz and ([+-][\d.]+) dB$")]
fn when_drag_node(world: &mut RvWorld, band: usize, hz: f32, db: f32) {
    let from = world.node(band);
    let plot = world.resp().eq_plot;
    let to = eq_point(plot, hz, db);
    world.press(from, false);
    world.drag(to, 8);
    world.release();
}

#[when(regex = r"^I right-click band (\d)'s node$")]
fn when_right_click(world: &mut RvWorld, band: usize) {
    let p = world.node(band);
    world.press(p, true);
    world.release();
}

#[when(regex = r"^I turn the wheel by ([\d.-]+) over band (\d)'s node$")]
fn when_wheel(world: &mut RvWorld, amount: f32, band: usize) {
    let p = world.node(band);
    world.hover(p);
    let s = world.pointer(Some(p), false, false, false);
    world.frame_with(s, amount);
}

#[when(regex = r"^I click chip (\d)$")]
fn when_chip(world: &mut RvWorld, chip: usize) {
    let r = world.resp().chips[chip - 1];
    world.press(r.center(), false);
    world.release();
}

#[when(regex = r#"^I click the "(\w+)" button$"#)]
fn when_button(world: &mut RvWorld, label: String) {
    let r = world.resp().pills.iter().find(|(l, _)| *l == label).expect("the button is shown").1;
    world.press(r.center(), false);
    world.release();
}

#[when("I drag across the space")]
fn when_orbit(world: &mut RvWorld) {
    let r = world.resp();
    world.camera_before = Some((r.camera.yaw, r.camera.pitch));
    let space = r.space;
    let from = pos2(space.center().x - 80.0, space.center().y);
    world.press(from, false);
    world.drag(pos2(from.x + 160.0, from.y + 30.0), 6);
    world.release();
}

// ---------------------------------------------------------------- then

#[then("the space is not blank")]
fn then_space_lit(world: &mut RvWorld) {
    let space = world.resp().space;
    let img = world.picture();
    let lit = lit_pixels(&img, space);
    assert!(lit > 3000, "only {lit} lit pixels in the space");
}

#[then("the EQ plot is not blank")]
fn then_eq_lit(world: &mut RvWorld) {
    let plot = world.resp().eq_plot;
    let img = world.picture();
    let lit = lit_pixels(&img, plot);
    assert!(lit > 400, "only {lit} lit pixels in the EQ plot");
}

#[then("there is neon violet in the space")]
fn then_violet(world: &mut RvWorld) {
    let space = world.resp().space;
    let img = world.picture();
    let mut found = 0;
    for y in space.min.y as u32..space.max.y as u32 {
        for x in space.min.x as u32..space.max.x as u32 {
            let [r, g, b, _] = img.get_pixel(x, y).0.map(|c| c as u32);
            if b > 170 && r > 90 && g < r + 40 && b > g + 40 {
                found += 1;
            }
        }
    }
    assert!(found > 50, "the room's edges should glow violet ({found} pixels)");
}

#[then(regex = r"^band (\d) was changed to about ([\d.]+) Hz and ([+-][\d.]+) dB$")]
fn then_changed(world: &mut RvWorld, band: usize, hz: f32, db: f32) {
    let b = world.last_change(band).expect("the band was never changed");
    assert!((b.freq / hz).log2().abs() < 0.06, "freq {} for {hz}", b.freq);
    assert!((b.gain_db - db).abs() < 0.6, "gain {} for {db}", b.gain_db);
    assert!(b.enabled);
}

#[then(regex = r"^band (\d) was selected$")]
fn then_selected(world: &mut RvWorld, band: usize) {
    assert!(world.events.contains(&ReverbEqEvent::BandSelected(Some(band - 1))), "{:?}", world.events);
}

#[then("the last event is EditEnded")]
fn then_edit_ended(world: &mut RvWorld) {
    assert_eq!(world.events.last(), Some(&ReverbEqEvent::EditEnded), "{:?}", world.events);
}

#[then(regex = r"^band (\d) was switched off$")]
fn then_off(world: &mut RvWorld, band: usize) {
    let b = world.last_change(band).expect("the band was never changed");
    assert!(!b.enabled);
}

#[then(regex = r"^band (\d)'s Q went up$")]
fn then_q_up(world: &mut RvWorld, band: usize) {
    let b = world.last_change(band).expect("the band was never changed");
    assert!(b.q > 1.05, "Q is {}", b.q);
}

#[then(regex = r#"^the view "(\w+)" was chosen$"#)]
fn then_view(world: &mut RvWorld, view: String) {
    let v = SpaceView::from_name(&view).unwrap();
    assert!(world.events.contains(&ReverbEqEvent::ViewSelected(v)), "{:?}", world.events);
}

#[then("the camera turned")]
fn then_camera(world: &mut RvWorld) {
    let (yaw, pitch) = world.camera_before.unwrap();
    let c = world.resp().camera;
    assert!((c.yaw - yaw).abs() > 0.5, "yaw {} -> {}", yaw, c.yaw);
    assert!((c.pitch - pitch).abs() > 0.05);
}

#[then("no band was changed")]
fn then_no_change(world: &mut RvWorld) {
    assert!(!world.events.iter().any(|e| matches!(e, ReverbEqEvent::BandChanged { .. })), "{:?}", world.events);
}

#[then(expr = "I save the picture {string}")]
fn save_picture(world: &mut RvWorld, name: String) {
    let img = world.picture();
    img.save(artifacts_dir().join(format!("{name}.png"))).unwrap();
}

fn main() {
    futures::executor::block_on(
        RvWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/reverb_eq_view.feature"),
    );
}
