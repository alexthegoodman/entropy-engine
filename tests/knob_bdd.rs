//! Headless tier for `entropy_gui::Knob`.
//!
//! `tests/features/knob.feature` drives the real widget through a headless `entropy_gui::Context`,
//! one frame at a time, the same way `tab_bar_bdd.rs` drives `TabBar`. A press then a sequence of
//! drag frames reproduces exactly what `Context::interact`'s drag tracking expects (a press frame
//! with zero delta, then frames whose delta is measured against the previous frame's pointer
//! position, not the press position) - `tests/common/raster.rs`'s `Harness` supplies the context
//! and the CPU rasterizer for the one look assertion (the fill arc actually changes the picture).
//! Pictures land in `test-artifacts/knob/`.

use cucumber::{given, then, when, World as _};
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::draw_list::DrawCommand;
use entropy_engine::entropy_gui::geometry::{pos2, Pos2, Rect};
use entropy_engine::entropy_gui::Knob;
use image::RgbaImage;
use std::collections::HashMap;

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

#[derive(cucumber::World)]
struct KnobWorld {
    h: Harness,
    min: f32,
    max: f32,
    value: f32,
    changed: bool,
    rect: Rect,
    pointer: Pos2,
    pending: Vec<DrawCommand>,
    images: HashMap<String, RgbaImage>,
    small: bool,
    label: String,
    unit: String,
}

impl std::fmt::Debug for KnobWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "KnobWorld(value={})", self.value)
    }
}

impl Default for KnobWorld {
    fn default() -> Self {
        Self {
            h: Harness::new(160, 120),
            min: 0.0,
            max: 100.0,
            value: 50.0,
            changed: false,
            rect: Rect::NOTHING,
            pointer: pos2(0.0, 0.0),
            pending: Vec::new(),
            images: HashMap::new(),
            small: false,
            label: "Cutoff".to_string(),
            unit: String::new(),
        }
    }
}

impl KnobWorld {
    fn frame(&mut self, pointer: PointerState) {
        let (min, max) = (self.min, self.max);
        let mut val = self.value;
        let mut resp = None;
        let small = self.small;
        let label = self.label.clone();
        let unit = self.unit.clone();
        self.pending = self.h.run(pointer, 0.0, |ui| {
            let mut k = Knob::new(&mut val, min..=max).text(label);
            if small {
                k = k.small();
            }
            if !unit.is_empty() {
                k = k.unit(unit);
            }
            resp = Some(ui.add(k));
        });
        let resp = resp.expect("the knob was not drawn");
        self.changed = resp.changed();
        self.rect = resp.rect;
        self.value = val;
    }

    fn ensure_frame(&mut self) {
        if self.rect == Rect::NOTHING {
            self.frame(PointerState::default());
        }
    }

    fn center(&mut self) -> Pos2 {
        self.ensure_frame();
        self.rect.center()
    }

    fn picture(&mut self) -> RgbaImage {
        self.h.render(&self.pending)
    }
}

fn artifacts_dir() -> std::path::PathBuf {
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("knob");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

// ------------------------------------------------------------------------------------------
// Steps
// ------------------------------------------------------------------------------------------

#[given(expr = "a knob from {float} to {float} starting at {float}")]
fn a_knob(world: &mut KnobWorld, min: f32, max: f32, start: f32) {
    world.min = min;
    world.max = max;
    world.value = start;
    world.small = false;
    world.label = "Cutoff".to_string();
    world.unit = String::new();
    world.rect = Rect::NOTHING;
}

#[given(expr = "a small knob with label {string} from {float} to {float} starting at {float} with unit {string}")]
fn a_small_knob(world: &mut KnobWorld, label: String, min: f32, max: f32, start: f32, unit: String) {
    world.min = min;
    world.max = max;
    world.value = start;
    world.small = true;
    world.label = label;
    world.unit = unit;
    world.rect = Rect::NOTHING;
}

#[then("the knob is horizontal and more wide than tall")]
fn knob_is_horizontal(world: &mut KnobWorld) {
    world.ensure_frame();
    assert!(
        world.rect.width() > world.rect.height(),
        "small knob should be wider than tall (width: {}, height: {})",
        world.rect.width(),
        world.rect.height()
    );
    assert!(
        world.rect.height() <= 24.0,
        "small knob height should be compact (<= 24.0), got {}",
        world.rect.height()
    );
}

#[when("a frame is drawn")]
fn drawn(world: &mut KnobWorld) {
    world.frame(PointerState::default());
}

#[when("a frame is drawn with the pointer resting on the knob")]
fn drawn_hovered(world: &mut KnobWorld) {
    let p = world.center();
    world.frame(PointerState { pos: Some(p), ..Default::default() });
}

#[when("I press the knob")]
fn press(world: &mut KnobWorld) {
    let p = world.center();
    world.pointer = p;
    world.frame(PointerState { pos: Some(p), primary_pressed: true, primary_down: true, ..Default::default() });
}

#[when(expr = "I drag the pointer up {float} points")]
fn drag_up(world: &mut KnobWorld, points: f32) {
    let p = pos2(world.pointer.x, world.pointer.y - points);
    world.pointer = p;
    world.frame(PointerState { pos: Some(p), primary_down: true, ..Default::default() });
}

#[when(expr = "I drag the pointer down {float} points")]
fn drag_down(world: &mut KnobWorld, points: f32) {
    let p = pos2(world.pointer.x, world.pointer.y + points);
    world.pointer = p;
    world.frame(PointerState { pos: Some(p), primary_down: true, ..Default::default() });
}

#[when("I release the pointer")]
fn release(world: &mut KnobWorld) {
    let p = world.pointer;
    world.frame(PointerState { pos: Some(p), primary_released: true, ..Default::default() });
}

#[when(expr = "the knob is set to {float}")]
fn set_value(world: &mut KnobWorld, v: f32) {
    world.value = v;
}

#[then(expr = "the value is {float}")]
fn value_is(world: &mut KnobWorld, expected: f32) {
    assert!((world.value - expected).abs() < 1e-3, "value is {} not {expected}", world.value);
}

#[then("there is a change event")]
fn changed(world: &mut KnobWorld) {
    assert!(world.changed, "no change event on this frame");
}

#[then("there is no change event")]
fn not_changed(world: &mut KnobWorld) {
    assert!(!world.changed, "an unexpected change event on this frame");
}

#[then(expr = "I save the picture {string}")]
fn save_picture(world: &mut KnobWorld, name: String) {
    world.ensure_frame();
    let img = world.picture();
    img.save(artifacts_dir().join(format!("{name}.png"))).unwrap();
    world.images.insert(name, img);
}

#[then(expr = "{string} and {string} look different")]
fn look_different(world: &mut KnobWorld, a: String, b: String) {
    let ia = world.images.get(&a).unwrap_or_else(|| panic!("no saved picture {a}"));
    let ib = world.images.get(&b).unwrap_or_else(|| panic!("no saved picture {b}"));
    let mut diff = 0.0f64;
    for (pa, pb) in ia.pixels().zip(ib.pixels()) {
        for i in 0..3 {
            diff += (pa[i] as f64 - pb[i] as f64).abs();
        }
    }
    assert!(diff > 500.0, "{a} and {b} are almost identical (total channel difference {diff})");
}

fn main() {
    futures::executor::block_on(
        KnobWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/knob.feature"),
    );
}
