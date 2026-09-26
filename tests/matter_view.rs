//! Headless tier for `entropy_gui::MatterView`: the real widget, driven by the real kit (hits played
//! through `KitVoice`, publishing into a `MatterShared` exactly as on the audio thread), rasterized
//! on the CPU (`tests/common/raster.rs`). Pictures land in `test-artifacts/matter-view/`, so a
//! change to the view can be looked at, not just asserted.

use entropy_engine::audio::matter::kit::{KitHit, KitSpec, Piece};
use entropy_engine::audio::matter::{Kit, KitCommand, KitVoice, MatterShared};
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::geometry::{pos2, vec2, Rect};
use entropy_engine::entropy_gui::widgets_matter::{face_screen, pad_rects};
use entropy_engine::entropy_gui::{MatterView, MatterViewEvent, MatterViewOptions};
use image::RgbaImage;
use std::sync::Arc;

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

const W: usize = 1100;
const H: usize = 660;

fn artifacts() -> std::path::PathBuf {
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("matter-view");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Plays `hits` into a fresh shared state and runs the kit on for `secs`, leaving it ringing.
fn struck(hits: &[KitHit], secs: f32) -> (Arc<MatterShared>, KitVoice) {
    let shared = Arc::new(MatterShared::default());
    let (mut voice, handle) = KitVoice::new(shared.clone(), Kit::new(KitSpec::default(), 44_100.0));
    for h in hits {
        handle.send(KitCommand::Strike(*h)).unwrap();
    }
    let _ = voice.by_ref().take((secs * 44_100.0) as usize * 2).count();
    (shared, voice)
}

fn frame(h: &mut Harness, opts: &MatterViewOptions, shared: &MatterShared, pointer: PointerState) -> (Vec<MatterViewEvent>, RgbaImage) {
    let mut events = Vec::new();
    let cmds = h.run(pointer, 0.0, |ui| {
        events = MatterView::new("matter-test").show(ui, opts, shared).events;
    });
    let img = h.render(&cmds);
    (events, img)
}

fn settled(h: &mut Harness, opts: &MatterViewOptions, shared: &MatterShared) -> RgbaImage {
    let _ = frame(h, opts, shared, PointerState::default());
    frame(h, opts, shared, PointerState::default()).1
}

fn lit_pixels(img: &RgbaImage) -> usize {
    img.pixels().filter(|p| p.0[0] as u32 + p.0[1] as u32 + p.0[2] as u32 > 330).count()
}

fn difference(a: &RgbaImage, b: &RgbaImage) -> usize {
    a.pixels().zip(b.pixels()).filter(|(x, y)| x.0.iter().zip(y.0.iter()).any(|(p, q)| (*p as i32 - *q as i32).abs() > 24)).count()
}

fn opts(physics: bool) -> MatterViewOptions {
    MatterViewOptions { width: Some(W as f32 - 20.0), height: H as f32 - 20.0, physics_view: physics, ..Default::default() }
}

/// Where the harness puts the widget (its panel has no margin).
fn widget() -> Rect {
    Rect::from_min_size(pos2(0.0, 0.0), vec2(W as f32 - 20.0, H as f32 - 20.0))
}

#[test]
fn a_kit_at_rest_is_drawn() {
    let shared = MatterShared::default();
    let mut h = Harness::new(W, H);
    let img = settled(&mut h, &opts(false), &shared);
    img.save(artifacts().join("at-rest.png")).unwrap();
    assert!(lit_pixels(&img) > 800, "the kit should be drawn ({} bright pixels)", lit_pixels(&img));
}

#[test]
fn a_struck_snare_moves_its_head_and_physics_view_adds_to_it() {
    let shared = MatterShared::default();
    let mut h = Harness::new(W, H);
    let rest = settled(&mut h, &opts(false), &shared);
    // Near the rim: the asymmetric modes ring too, and the wires rattle.
    let (hit, _v) = struck(&[KitHit::at(Piece::Snare, 5.0, 0.7)], 0.012);
    assert!(hit.piece(Piece::Snare).wire_landings > 0, "the wires should be rattling");
    let plain = settled(&mut h, &opts(false), &hit);
    plain.save(artifacts().join("snare-edge.png")).unwrap();
    let physics = settled(&mut h, &opts(true), &hit);
    physics.save(artifacts().join("snare-edge-physics.png")).unwrap();
    assert!(difference(&rest, &plain) > 1500, "the struck head and stick should show ({} pixels differ)", difference(&rest, &plain));
    assert!(difference(&plain, &physics) > 5000, "Physics View should add its overlays ({} pixels differ)", difference(&plain, &physics));
}

#[test]
fn a_crash_and_a_kick_look_different_from_a_snare() {
    let mut h = Harness::new(W, H);
    let (snare, _a) = struck(&[KitHit::at(Piece::Snare, 4.0, 0.3)], 0.01);
    let (crash, _b) = struck(&[KitHit::at(Piece::Crash, 5.0, 0.92)], 0.03);
    let (kick, _c) = struck(&[KitHit::at(Piece::Kick, 5.0, 0.3)], 0.015);
    let a = settled(&mut h, &opts(true), &snare);
    let b = settled(&mut h, &opts(true), &crash);
    let c = settled(&mut h, &opts(true), &kick);
    b.save(artifacts().join("crash-physics.png")).unwrap();
    c.save(artifacts().join("kick-physics.png")).unwrap();
    assert!(difference(&a, &b) > 3000, "{}", difference(&a, &b));
    assert!(difference(&a, &c) > 3000, "{}", difference(&a, &c));
    assert_eq!(crash.focus(), Piece::Crash);
}

#[test]
fn a_tom_hit_shows_the_snare_wires_answering() {
    let (shared, _v) = struck(&[KitHit::at(Piece::RackTom, 6.0, 0.35)], 0.05);
    let snare = shared.piece(Piece::Snare);
    assert_eq!(snare.strikes, 0);
    assert!(snare.wire_landings > 0, "the tom's sound should have reached the wires");
    let mut h = Harness::new(W, H);
    settled(&mut h, &opts(true), &shared).save(artifacts().join("rack-tom-sympathy.png")).unwrap();
}

#[test]
fn clicking_a_head_strikes_it_where_it_was_clicked() {
    let shared = MatterShared::default();
    let mut h = Harness::new(W, H);
    let o = opts(false);
    let _ = frame(&mut h, &o, &shared, PointerState::default());
    for (piece, r) in [(Piece::FloorTom, 0.1), (Piece::FloorTom, 0.8), (Piece::Ride, 0.6), (Piece::Snare, 0.5)] {
        let p = face_screen(widget(), &o, piece, r, 0.4).expect("on screen");
        let press = PointerState { pos: Some(p), primary_down: true, primary_pressed: true, ..Default::default() };
        let (events, _) = frame(&mut h, &o, &shared, press);
        let _ = frame(&mut h, &o, &shared, PointerState { pos: Some(p), ..Default::default() });
        let hit = events.iter().find_map(|e| if let MatterViewEvent::Strike { piece, position, .. } = e { Some((*piece, *position)) } else { None });
        let (got, position) = hit.unwrap_or_else(|| panic!("clicking the {piece:?} should strike it: {events:?}"));
        assert_eq!(got, piece);
        assert!((position - r).abs() < 0.15, "{piece:?} clicked at {r}, struck at {position}");
    }
}

#[test]
fn the_pads_and_the_chip_ask_for_what_they_should() {
    let shared = MatterShared::default();
    let mut h = Harness::new(W, H);
    let o = opts(false);
    let _ = frame(&mut h, &o, &shared, PointerState::default());
    for (piece, r) in pad_rects(widget()) {
        let press = PointerState { pos: Some(r.center()), primary_down: true, primary_pressed: true, ..Default::default() };
        let (events, _) = frame(&mut h, &o, &shared, press);
        let _ = frame(&mut h, &o, &shared, PointerState::default());
        assert!(events.iter().any(|e| matches!(e, MatterViewEvent::Pad { piece: p, .. } if *p == piece)), "{piece:?}: {events:?}");
    }
    let chip = pos2((W as f32 - 20.0) - 52.0, 21.0);
    let press = PointerState { pos: Some(chip), primary_down: true, primary_pressed: true, ..Default::default() };
    let (events, _) = frame(&mut h, &o, &shared, press);
    assert!(events.contains(&MatterViewEvent::PhysicsView(true)), "got {events:?}");
}
