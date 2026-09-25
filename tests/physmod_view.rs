//! Headless tier for `entropy_gui::PhysModView`: the real widget, driven by the real bowed-string
//! engine (notes rendered offline through `PhysModVoice`, publishing into a `PhysModShared` exactly as
//! on the audio thread), rasterized on the CPU (`tests/common/raster.rs`). Pictures land in
//! `test-artifacts/physmod-view/`, so a change to the view can be looked at, not just asserted.

use entropy_engine::audio::physmod::{PhysModParams, PhysModShared, PhysModVoice};
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::geometry::{pos2, Pos2};
use entropy_engine::entropy_gui::{PhysModEvent, PhysModOptions, PhysModView};
use image::RgbaImage;
use std::sync::Arc;

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

const W: usize = 1100;
const H: usize = 640;

fn artifacts() -> std::path::PathBuf {
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("physmod-view");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Plays `params` for `secs` into a fresh shared state, leaving the voice mid-note (so the shared
/// state shows a sounding instrument).
fn sounding(params: PhysModParams, secs: f32) -> (Arc<PhysModShared>, PhysModVoice) {
    let shared = Arc::new(PhysModShared::default());
    let mut voice = PhysModVoice::new(shared.clone(), PhysModParams { duration: 30.0, ..params }, None);
    let n = (secs * 44_100.0) as usize * 2;
    let _ = voice.by_ref().take(n).count();
    (shared, voice)
}

fn frame(h: &mut Harness, opts: &PhysModOptions, shared: &PhysModShared, pointer: PointerState) -> (Vec<PhysModEvent>, RgbaImage) {
    let mut events = Vec::new();
    let cmds = h.run(pointer, 0.0, |ui| {
        let resp = PhysModView::new("pm-test").show(ui, opts, shared);
        events = resp.events;
    });
    let img = h.render(&cmds);
    (events, img)
}

fn idle() -> PointerState {
    PointerState::default()
}

fn lit_pixels(img: &RgbaImage) -> usize {
    img.pixels().filter(|p| p.0[0] as u32 + p.0[1] as u32 + p.0[2] as u32 > 330).count()
}

fn difference(a: &RgbaImage, b: &RgbaImage) -> usize {
    a.pixels().zip(b.pixels()).filter(|(x, y)| x.0.iter().zip(y.0.iter()).any(|(p, q)| (*p as i32 - *q as i32).abs() > 24)).count()
}

fn opts(physics: bool) -> PhysModOptions {
    PhysModOptions { width: Some(W as f32 - 20.0), height: H as f32 - 20.0, physics_view: physics, ..Default::default() }
}

#[test]
fn the_view_draws_a_sounding_instrument_and_physics_view_adds_to_it() {
    let (shared, _voice) = sounding(PhysModParams { freq: 392.0, vibrato_depth: 0.0, ..Default::default() }, 0.6);
    let mut h = Harness::new(W, H);
    let (_, plain) = frame(&mut h, &opts(false), &shared, idle());
    let (_, plain) = {
        // A second frame, so the display scale has settled on the note.
        let _ = plain;
        frame(&mut h, &opts(false), &shared, idle())
    };
    plain.save(artifacts().join("g4-on-the-d-string.png")).unwrap();
    let (_, physics) = frame(&mut h, &opts(true), &shared, idle());
    let (_, physics) = {
        let _ = physics;
        frame(&mut h, &opts(true), &shared, idle())
    };
    physics.save(artifacts().join("g4-on-the-d-string-physics.png")).unwrap();
    assert!(lit_pixels(&plain) > 1500, "the instrument should be drawn ({} bright pixels)", lit_pixels(&plain));
    assert!(difference(&plain, &physics) > 5000, "Physics View should add its overlays ({} pixels differ)", difference(&plain, &physics));
}

#[test]
fn a_silent_instrument_is_drawn_at_rest_and_says_how_to_start() {
    let shared = PhysModShared::default();
    let mut h = Harness::new(W, H);
    let (_, img) = frame(&mut h, &opts(false), &shared, idle());
    img.save(artifacts().join("at-rest.png")).unwrap();
    assert!(lit_pixels(&img) > 500);
}

#[test]
fn clicking_the_physics_chip_asks_for_physics_view() {
    let shared = PhysModShared::default();
    let mut h = Harness::new(W, H);
    let o = opts(false);
    let _ = frame(&mut h, &o, &shared, idle());
    // The chip sits in the top-right corner of the stage (see `Layout::new`).
    let chip = pos2(10.0 + (W as f32 - 20.0) - 52.0, 10.0 + 21.0);
    let press = PointerState { pos: Some(chip), primary_down: true, primary_pressed: true, ..Default::default() };
    let (events, _) = frame(&mut h, &o, &shared, press);
    assert!(events.contains(&PhysModEvent::PhysicsView(true)), "got {events:?}");
}

#[test]
fn dragging_in_the_playable_window_diagram_moves_the_bow() {
    let (shared, _voice) = sounding(PhysModParams { freq: 523.25, vibrato_depth: 0.0, ..Default::default() }, 0.4);
    let mut h = Harness::new(W, H);
    let o = opts(true);
    let _ = frame(&mut h, &o, &shared, idle());
    // Find the diagram by scanning for a press that yields a bow drag: its box sits under the chip.
    let stage_right = 10.0 + (W as f32 - 20.0);
    let p: Pos2 = pos2(stage_right - 80.0, 10.0 + 32.0 + 10.0 + 70.0);
    let press = PointerState { pos: Some(p), primary_down: true, primary_pressed: true, ..Default::default() };
    let (events, _) = frame(&mut h, &o, &shared, press);
    let drag = events.iter().find_map(|e| if let PhysModEvent::BowDrag { position, force } = e { Some((*position, *force)) } else { None });
    let (position, force) = drag.unwrap_or_else(|| panic!("a press in the diagram should move the bow, got {events:?}"));
    assert!((0.02..=0.5).contains(&position) && (0.0..=1.0).contains(&force));
    // Towards the right of the diagram is towards the fingerboard: a larger bow position.
    let right = PointerState { pos: Some(pos2(p.x + 40.0, p.y)), primary_down: true, ..Default::default() };
    let (events2, _) = frame(&mut h, &o, &shared, right);
    let (position2, _) = events2.iter().find_map(|e| if let PhysModEvent::BowDrag { position, force } = e { Some((*position, *force)) } else { None }).expect("dragging keeps moving the bow");
    assert!(position2 > position, "{position} then {position2}");
}

#[test]
fn a_cello_with_sympathetic_strings_draws_them() {
    let p = PhysModParams {
        freq: 146.83 * 1.5,
        strings: [65.41, 98.0, 146.83, 220.0],
        body_size: 0.72,
        sympathetic: [98.0, 146.83, 196.0, 220.0, 0.0, 0.0],
        coupling: 0.7,
        vibrato_depth: 0.0,
        ..Default::default()
    };
    let (shared, _voice) = sounding(p, 0.8);
    let mut h = Harness::new(W, H);
    let _ = frame(&mut h, &opts(true), &shared, idle());
    let (_, img) = frame(&mut h, &opts(true), &shared, idle());
    img.save(artifacts().join("cello-with-sympathetic-strings.png")).unwrap();
    assert_eq!(shared.string_count(), 8);
    assert!(lit_pixels(&img) > 1500);
}
