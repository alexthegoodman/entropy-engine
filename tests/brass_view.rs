//! Headless tier for `entropy_gui::BrassView`: the real widget, driven by the real brass engine
//! (notes played through `BrassVoice`, publishing into a `BrassShared` exactly as on the audio
//! thread), rasterized on the CPU (`tests/common/raster.rs`). Pictures land in
//! `test-artifacts/brass-view/`, so a change to the view can be looked at, not just asserted.

use entropy_engine::audio::brass::{BrassParams, BrassShared, BrassVoice};
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::geometry::{pos2, vec2, Pos2, Rect};
use entropy_engine::entropy_gui::widgets_brass::slide_handle_screen;
use entropy_engine::entropy_gui::{BrassView, BrassViewEvent, BrassViewOptions};
use image::RgbaImage;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

const W: usize = 1100;
const H: usize = 660;

fn artifacts() -> std::path::PathBuf {
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("brass-view");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Plays `params` (held) for `secs` into a fresh shared state, leaving the voice mid-note.
fn sounding(params: BrassParams, secs: f32) -> (Arc<BrassShared>, BrassVoice) {
    let shared = Arc::new(BrassShared::default());
    let mut voice = BrassVoice::new(shared.clone(), params, Some(Arc::new(AtomicBool::new(true))));
    let _ = voice.by_ref().take((secs * 44_100.0) as usize * 2).count();
    (shared, voice)
}

fn frame(h: &mut Harness, opts: &BrassViewOptions, shared: &BrassShared, pointer: PointerState) -> (Vec<BrassViewEvent>, RgbaImage) {
    let mut events = Vec::new();
    let cmds = h.run(pointer, 0.0, |ui| {
        events = BrassView::new("brass-test").show(ui, opts, shared).events;
    });
    let img = h.render(&cmds);
    (events, img)
}

/// Two frames (the second with the display scale settled), the second one's picture.
fn settled(h: &mut Harness, opts: &BrassViewOptions, shared: &BrassShared) -> RgbaImage {
    let _ = frame(h, opts, shared, PointerState::default());
    frame(h, opts, shared, PointerState::default()).1
}

fn lit_pixels(img: &RgbaImage) -> usize {
    img.pixels().filter(|p| p.0[0] as u32 + p.0[1] as u32 + p.0[2] as u32 > 330).count()
}

fn difference(a: &RgbaImage, b: &RgbaImage) -> usize {
    a.pixels().zip(b.pixels()).filter(|(x, y)| x.0.iter().zip(y.0.iter()).any(|(p, q)| (*p as i32 - *q as i32).abs() > 24)).count()
}

fn opts(physics: bool) -> BrassViewOptions {
    BrassViewOptions { width: Some(W as f32 - 20.0), height: H as f32 - 20.0, physics_view: physics, ..Default::default() }
}

#[test]
fn the_visible_keyboard_plays_releases_and_glides_between_keys() {
    let shared = BrassShared::default();
    let mut h = Harness::new(W, H);
    let o = opts(false);
    let _ = frame(&mut h, &o, &shared, PointerState::default());
    let keys = entropy_engine::entropy_gui::widgets_wavetable::key_layout(
        o.first_key, o.key_octaves,
        Rect::from_min_size(pos2(10.0, H as f32 - 10.0 - 60.0), vec2(W as f32 - 20.0, 60.0)),
    );
    let key = |midi| keys.iter().find(|(m, _, _)| *m == midi).unwrap().1.center();
    let c = key(48);
    let d = key(50);
    let press = PointerState { pos: Some(c), primary_down: true, primary_pressed: true, ..Default::default() };
    let (events, _) = frame(&mut h, &o, &shared, press);
    assert!(events.iter().any(|e| matches!(e, BrassViewEvent::KeyDown { midi: 48, .. })), "press: {events:?}");
    let drag = PointerState { pos: Some(d), primary_down: true, ..Default::default() };
    let (events, _) = frame(&mut h, &o, &shared, drag);
    assert!(events.contains(&BrassViewEvent::KeyUp { midi: 48 }), "drag: {events:?}");
    assert!(events.iter().any(|e| matches!(e, BrassViewEvent::KeyDown { midi: 50, .. })), "drag: {events:?}");
    let (events, _) = frame(&mut h, &o, &shared, PointerState { pos: Some(d), ..Default::default() });
    assert!(events.contains(&BrassViewEvent::KeyUp { midi: 50 }), "release: {events:?}");
}

#[test]
fn the_view_draws_a_sounding_trombone_and_physics_view_adds_to_it() {
    let (shared, _voice) = sounding(BrassParams { freq: 233.08, breath: 0.6, breath_noise: 0.0, ..Default::default() }, 0.6);
    let mut h = Harness::new(W, H);
    let plain = settled(&mut h, &opts(false), &shared);
    plain.save(artifacts().join("bb3-first-position.png")).unwrap();
    let physics = settled(&mut h, &opts(true), &shared);
    physics.save(artifacts().join("bb3-first-position-physics.png")).unwrap();
    assert!(lit_pixels(&plain) > 1500, "the instrument should be drawn ({} bright pixels)", lit_pixels(&plain));
    assert!(difference(&plain, &physics) > 5000, "Physics View should add its overlays ({} pixels differ)", difference(&plain, &physics));
}

#[test]
fn the_slide_is_drawn_where_the_note_puts_it() {
    // B♭3 in first position, then G3 in fourth: the slide is further out, so the picture differs.
    let (first, _v1) = sounding(BrassParams { freq: 233.08, breath_noise: 0.0, ..Default::default() }, 0.5);
    let (fourth, _v2) = sounding(BrassParams { freq: 196.0, breath_noise: 0.0, ..Default::default() }, 0.5);
    let (s1, s4) = (first.state(), fourth.state());
    assert!(s4.extension > s1.extension + 0.2, "G3 should put the slide out: {} vs {}", s4.extension, s1.extension);
    let mut h = Harness::new(W, H);
    let a = settled(&mut h, &opts(false), &first);
    let b = settled(&mut h, &opts(false), &fourth);
    b.save(artifacts().join("g3-fourth-position.png")).unwrap();
    assert!(difference(&a, &b) > 3000);
}

#[test]
fn a_loud_note_looks_different_from_a_soft_one() {
    let (soft, _v1) = sounding(BrassParams { freq: 174.61, breath: 0.2, breath_noise: 0.0, ..Default::default() }, 0.6);
    let (loud, _v2) = sounding(BrassParams { freq: 174.61, breath: 0.95, breath_noise: 0.0, ..Default::default() }, 0.6);
    assert!(loud.state().wave_steepness > 10.0 * soft.state().wave_steepness);
    let mut h = Harness::new(W, H);
    let a = settled(&mut h, &opts(true), &soft);
    let b = settled(&mut h, &opts(true), &loud);
    a.save(artifacts().join("f3-pp-physics.png")).unwrap();
    b.save(artifacts().join("f3-fff-physics.png")).unwrap();
    assert!(difference(&a, &b) > 2000);
}

#[test]
fn a_silent_instrument_is_drawn_at_rest() {
    let shared = BrassShared::default();
    let mut h = Harness::new(W, H);
    let img = settled(&mut h, &opts(false), &shared);
    img.save(artifacts().join("at-rest.png")).unwrap();
    assert!(lit_pixels(&img) > 500);
}

#[test]
fn clicking_the_physics_chip_asks_for_physics_view() {
    let shared = BrassShared::default();
    let mut h = Harness::new(W, H);
    let o = opts(false);
    let _ = frame(&mut h, &o, &shared, PointerState::default());
    let chip = pos2(10.0 + (W as f32 - 20.0) - 52.0, 10.0 + 21.0);
    let press = PointerState { pos: Some(chip), primary_down: true, primary_pressed: true, ..Default::default() };
    let (events, _) = frame(&mut h, &o, &shared, press);
    assert!(events.contains(&BrassViewEvent::PhysicsView(true)), "got {events:?}");
}

#[test]
fn dragging_in_the_playing_map_sets_breath_and_lips() {
    let (shared, _voice) = sounding(BrassParams { freq: 233.08, breath_noise: 0.0, ..Default::default() }, 0.4);
    let mut h = Harness::new(W, H);
    let o = opts(true);
    let _ = frame(&mut h, &o, &shared, PointerState::default());
    // The map is the middle panel of the right-hand column; find it by pressing down the column.
    let x = 10.0 + (W as f32 - 20.0) - 120.0;
    let mut found = None;
    for k in 0..60 {
        let p: Pos2 = pos2(x, 50.0 + k as f32 * 8.0);
        let press = PointerState { pos: Some(p), primary_down: true, primary_pressed: true, ..Default::default() };
        let (events, _) = frame(&mut h, &o, &shared, press);
        let _ = frame(&mut h, &o, &shared, PointerState::default());
        if let Some(v) = events.iter().find_map(|e| if let BrassViewEvent::PlayDrag { breath, lip_tension } = e { Some((*breath, *lip_tension, p)) } else { None }) {
            found = Some(v);
            break;
        }
    }
    let (breath, tension, p) = found.expect("a press in the playing map should play there");
    assert!((0.0..=1.0).contains(&breath) && (-1.0..=1.0).contains(&tension));
    // Further right is more breath.
    let press = PointerState { pos: Some(p), primary_down: true, primary_pressed: true, ..Default::default() };
    let _ = frame(&mut h, &o, &shared, press);
    let right = PointerState { pos: Some(pos2(p.x + 40.0, p.y)), primary_down: true, ..Default::default() };
    let (events, _) = frame(&mut h, &o, &shared, right);
    let breath2 = events.iter().find_map(|e| if let BrassViewEvent::PlayDrag { breath, .. } = e { Some(*breath) } else { None }).expect("dragging keeps playing");
    assert!(breath2 > breath, "{breath} then {breath2}");
}

#[test]
fn dragging_the_slide_asks_for_a_position() {
    let (shared, _voice) = sounding(BrassParams { freq: 233.08, breath_noise: 0.0, ..Default::default() }, 0.4);
    let mut h = Harness::new(W, H);
    let o = opts(false);
    let _ = frame(&mut h, &o, &shared, PointerState::default());
    // The harness puts the widget at (10, 10), W - 20 wide.
    let widget = Rect::from_min_size(pos2(10.0, 10.0), vec2(W as f32 - 20.0, H as f32 - 20.0));
    let p = slide_handle_screen(widget, &o, &shared).expect("the handle is on screen");
    let press = PointerState { pos: Some(p), primary_down: true, primary_pressed: true, ..Default::default() };
    let (events, _) = frame(&mut h, &o, &shared, press);
    let position = events.iter().find_map(|e| if let BrassViewEvent::SlideDrag { position } = e { Some(*position) } else { None }).unwrap_or_else(|| panic!("grabbing the handle should move the slide: {events:?}"));
    assert!((0.9..=2.0).contains(&position), "first position grabbed at {position}");
    // Drag well out along the slide (to the right on the default camera).
    let out = PointerState { pos: Some(pos2(p.x + 200.0, p.y + 20.0)), primary_down: true, ..Default::default() };
    let (events, _) = frame(&mut h, &o, &shared, out);
    let position2 = events.iter().find_map(|e| if let BrassViewEvent::SlideDrag { position } = e { Some(*position) } else { None }).expect("dragging keeps moving the slide");
    assert!(position2 > position + 1.5, "{position} then {position2}");
}

#[test]
fn the_trumpet_horn_and_tuba_are_drawn_with_their_valves() {
    use entropy_engine::audio::brass::{BrassInstrument, Mute};
    let mut h = Harness::new(W, H);
    let cases = [
        ("trumpet-bb4-open", BrassParams { instrument: BrassInstrument::Trumpet, freq: 466.16, breath_noise: 0.0, ..Default::default() }),
        ("trumpet-a4-valve-2", BrassParams { instrument: BrassInstrument::Trumpet, freq: 440.0, breath_noise: 0.0, ..Default::default() }),
        ("trumpet-harmon", BrassParams { instrument: BrassInstrument::Trumpet, freq: 466.16, mute: Mute::Harmon, breath_noise: 0.0, ..Default::default() }),
        ("horn-f3", BrassParams { instrument: BrassInstrument::Horn, freq: 174.61, breath_noise: 0.0, ..Default::default() }),
        ("horn-a4-stopped", BrassParams { instrument: BrassInstrument::Horn, freq: 440.0, hand: Some(1.0), breath_noise: 0.0, ..Default::default() }),
        ("tuba-f2", BrassParams { instrument: BrassInstrument::Tuba, freq: 87.31, breath_noise: 0.0, ..Default::default() }),
    ];
    let mut pictures = Vec::new();
    for (name, p) in cases {
        let (shared, _voice) = sounding(p, 0.6);
        let s = shared.state();
        let img = settled(&mut h, &opts(true), &shared);
        img.save(artifacts().join(format!("{name}.png"))).unwrap();
        assert!(s.playing, "{name} should be playing");
        assert!(lit_pixels(&img) > 1500, "{name}: the instrument should be drawn ({} bright pixels)", lit_pixels(&img));
        // No slide to grab on a valved instrument.
        assert!(slide_handle_screen(Rect::from_min_size(pos2(10.0, 10.0), vec2(W as f32 - 20.0, H as f32 - 20.0)), &opts(true), &shared).is_none());
        pictures.push((name, s, img));
    }
    let (open, valve2) = (&pictures[0], &pictures[1]);
    assert_eq!(open.1.valves, 0, "B♭4 is played open");
    assert_eq!(valve2.1.valves, 0b10, "A4 is played on the second valve");
    assert!(difference(&open.2, &valve2.2) > 2000, "the valve going down shows ({} pixels differ)", difference(&open.2, &valve2.2));
    assert_eq!(pictures[2].1.mute, Mute::Harmon);
    assert!(pictures[4].1.hand > 0.95);
}
