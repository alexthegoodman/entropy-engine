//! Headless tier for `entropy_gui::WaterView`: the real widget, driven by a real water instrument
//! (notes played through `WaterVoice`, publishing into a `WaterShared` exactly as on the audio
//! thread), rasterized on the CPU (`tests/common/raster.rs`). Pictures land in
//! `test-artifacts/water-view/`, so a change to the view can be looked at, not just asserted.

use entropy_engine::audio::matter::rain::RainTarget;
use entropy_engine::audio::matter::water_voice::{Source, Water, WaterAction, WaterShared, WaterSpec, WaterVoice, GLASSES};
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::geometry::{pos2, vec2, Rect};
use entropy_engine::entropy_gui::widgets_water::{pad_rects, target_screen, Target, HOLD_EVERY};
use entropy_engine::entropy_gui::{WaterView, WaterViewEvent, WaterViewOptions};
use image::RgbaImage;
use std::sync::Arc;

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

const W: usize = 1100;
const H: usize = 660;
const SR: f32 = 44_100.0;

fn artifacts() -> std::path::PathBuf {
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("water-view");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A water instrument on `rain`, publishing into a fresh shared state.
fn water(rain: RainTarget) -> (Arc<WaterShared>, WaterVoice, Arc<entropy_engine::audio::matter::water_voice::WaterHandle>) {
    let spec = WaterSpec { rain, ..WaterSpec::default() };
    let shared = Arc::new(WaterShared::default());
    let (voice, handle) = WaterVoice::new(shared.clone(), Water::new(spec, SR));
    (shared, voice, handle)
}

fn run(voice: &mut WaterVoice, secs: f32) {
    let _ = voice.by_ref().take((secs * SR) as usize * 2).count();
}

fn frame(h: &mut Harness, opts: &WaterViewOptions, shared: &WaterShared, pointer: PointerState) -> (Vec<WaterViewEvent>, RgbaImage) {
    let mut events = Vec::new();
    let cmds = h.run(pointer, 0.0, |ui| {
        events = WaterView::new("water-test").show(ui, opts, shared).events;
    });
    let img = h.render(&cmds);
    (events, img)
}

fn settled(h: &mut Harness, opts: &WaterViewOptions, shared: &WaterShared) -> RgbaImage {
    let _ = frame(h, opts, shared, PointerState::default());
    frame(h, opts, shared, PointerState::default()).1
}

fn lit_pixels(img: &RgbaImage) -> usize {
    img.pixels().filter(|p| p.0[0] as u32 + p.0[1] as u32 + p.0[2] as u32 > 330).count()
}

fn difference(a: &RgbaImage, b: &RgbaImage) -> usize {
    a.pixels().zip(b.pixels()).filter(|(x, y)| x.0.iter().zip(y.0.iter()).any(|(p, q)| (*p as i32 - *q as i32).abs() > 24)).count()
}

fn opts(physics: bool) -> WaterViewOptions {
    WaterViewOptions { width: Some(W as f32 - 20.0), height: H as f32 - 20.0, physics_view: physics, ..Default::default() }
}

/// Where the harness puts the widget (its panel has no margin).
fn widget() -> Rect {
    Rect::from_min_size(pos2(0.0, 0.0), vec2(W as f32 - 20.0, H as f32 - 20.0))
}

fn send(handle: &entropy_engine::audio::matter::water_voice::WaterHandle, a: WaterAction) {
    handle.send(a.command(&handle.spec())).unwrap();
}

#[test]
fn water_at_rest_is_drawn() {
    let (shared, mut voice, _handle) = water(RainTarget::Lake);
    run(&mut voice, 0.05);
    let mut h = Harness::new(W, H);
    let img = settled(&mut h, &opts(false), &shared);
    img.save(artifacts().join("at-rest.png")).unwrap();
    assert!(lit_pixels(&img) > 800, "the table should be drawn ({} bright pixels)", lit_pixels(&img));
}

#[test]
fn everything_at_once_is_drawn_from_the_model() {
    let (shared, mut voice, handle) = water(RainTarget::Tent);
    run(&mut voice, 0.05);
    let mut h = Harness::new(W, H);
    let rest = settled(&mut h, &opts(false), &shared);
    // Glasses tuned to a chord and struck, drips, a bottle filling, rain on the tent, the brook,
    // the surf and the tub - all at once, as a busy water track would.
    for (i, pitch) in [523.25f32, 659.25, 783.99, 1046.5].iter().enumerate() {
        send(&handle, WaterAction::Glass { pitch: *pitch, speed: 0.6, spoon: i % 2 == 1 });
    }
    for x in [-0.6f32, 0.0, 0.5] {
        send(&handle, WaterAction::Drip { pitch: 1200.0 + 600.0 * x, x });
    }
    send(&handle, WaterAction::Fill { pitch: 330.0, duration: 4.0 });
    send(&handle, WaterAction::Rain { rate: 20.0, duration: 4.0 });
    send(&handle, WaterAction::Brook { speed: 0.8, duration: 4.0 });
    send(&handle, WaterAction::Surf { height: 1.6, duration: 4.0 });
    send(&handle, WaterAction::Slosh { strength: 1.2, duration: 4.0 });
    // Long enough for the voice to publish again (every 1024 samples).
    run(&mut voice, 0.03);
    let f = shared.frame();
    assert!(f.n_bubbles > 0, "the drips' bubbles should be published");
    assert!(f.glass_strikes.iter().filter(|c| **c > 0).count() == 4, "{:?}", f.glass_strikes);
    let plain = settled(&mut h, &opts(false), &shared);
    plain.save(artifacts().join("struck.png")).unwrap();
    assert!(difference(&rest, &plain) > 3000, "the struck glasses, drops and weather should show ({} pixels differ)", difference(&rest, &plain));
    run(&mut voice, 2.0);
    let f = shared.frame();
    assert!(f.fill_flow.iter().any(|v| *v > 0.0) && f.fill_level_m.iter().any(|v| *v > 0.0), "a vessel should be filling: {:?} {:?}", f.fill_flow, f.fill_level_m);
    assert!(f.brook_fader > 0.9 && f.surf_fader > 0.2, "{} {}", f.brook_fader, f.surf_fader);
    assert!(f.rain_landed > 0 && f.tub_pose.0 != 0.0);
    let later = settled(&mut h, &opts(false), &shared);
    later.save(artifacts().join("weather.png")).unwrap();
    let physics = settled(&mut h, &opts(true), &shared);
    physics.save(artifacts().join("weather-physics.png")).unwrap();
    assert!(difference(&later, &physics) > 5000, "Physics View should add its panels ({} pixels differ)", difference(&later, &physics));
}

#[test]
fn each_rain_surface_is_drawn_as_itself() {
    let mut h = Harness::new(W, H);
    let mut pictures = Vec::new();
    for target in [RainTarget::Lake, RainTarget::Window, RainTarget::Roof, RainTarget::Cymbal, RainTarget::Drum] {
        let (shared, mut voice, handle) = water(target);
        send(&handle, WaterAction::Rain { rate: 30.0, duration: 2.0 });
        run(&mut voice, 0.3);
        assert_eq!(shared.frame().rain_target, target);
        let img = settled(&mut h, &opts(false), &shared);
        img.save(artifacts().join(format!("rain-{}.png", target.name()))).unwrap();
        pictures.push(img);
    }
    for i in 1..pictures.len() {
        assert!(difference(&pictures[0], &pictures[i]) > 800, "surface {i} looks like the lake ({})", difference(&pictures[0], &pictures[i]));
    }
}

#[test]
fn clicking_plays_what_was_clicked() {
    let (shared, mut voice, handle) = water(RainTarget::Lake);
    send(&handle, WaterAction::Glass { pitch: 440.0, speed: 0.3, spoon: false });
    run(&mut voice, 0.05);
    let tuned = (0..GLASSES).find(|&k| shared.state().glass_pitch[k] == 440.0).expect("a glass tuned to A4");
    let mut h = Harness::new(W, H);
    let o = opts(false);
    let _ = frame(&mut h, &o, &shared, PointerState::default());
    let click = |h: &mut Harness, t: Target| -> Vec<WaterViewEvent> {
        let p = target_screen(widget(), &o, t).expect("on screen");
        let press = PointerState { pos: Some(p), primary_down: true, primary_pressed: true, ..Default::default() };
        let (events, _) = frame(h, &o, &shared, press);
        let _ = frame(h, &o, &shared, PointerState { pos: Some(p), ..Default::default() });
        events
    };
    for x in [-0.7f32, 0.0, 0.6] {
        let ev = click(&mut h, Target::Basin(x));
        let got = ev.iter().find_map(|e| if let WaterViewEvent::Drip { x, .. } = e { Some(*x) } else { None });
        let got = got.unwrap_or_else(|| panic!("clicking the basin should drip: {ev:?}"));
        assert!((got - x).abs() < 0.12, "clicked at {x}, dripped at {got}");
    }
    let ev = click(&mut h, Target::Glass(tuned));
    assert!(ev.iter().any(|e| matches!(e, WaterViewEvent::Glass { index, pitch, .. } if *index == tuned && *pitch == 440.0)), "{ev:?}");
    let empty = (0..GLASSES).find(|&k| k != tuned).unwrap();
    let ev = click(&mut h, Target::Glass(empty));
    assert!(ev.iter().any(|e| matches!(e, WaterViewEvent::Glass { index, pitch, .. } if *index == empty && *pitch == 0.0)), "{ev:?}");
    for (k, height) in [(0usize, 0.25f32), (1, 0.8)] {
        let ev = click(&mut h, Target::Vessel(k, height));
        let got = ev.iter().find_map(|e| if let WaterViewEvent::Fill { height, .. } = e { Some(*height) } else { None });
        let got = got.unwrap_or_else(|| panic!("clicking vessel {k} should fill it: {ev:?}"));
        assert!((got - height).abs() < 0.12, "clicked at {height}, filled to {got}");
    }
}

#[test]
fn holding_keeps_weather_going_and_dragging_the_tub_shakes_it() {
    let (shared, mut voice, _handle) = water(RainTarget::Lake);
    run(&mut voice, 0.05);
    let mut h = Harness::new(W, H);
    let o = opts(false);
    let _ = frame(&mut h, &o, &shared, PointerState::default());
    for (t, source) in [(Target::Rain, Source::Rain), (Target::Brook, Source::Brook), (Target::Surf, Source::Surf)] {
        let p = target_screen(widget(), &o, t).expect("on screen");
        let mut holds = Vec::new();
        // Held for half a second (the harness runs at 60 frames a second), dragged upward: renewed,
        // harder.
        for i in 0..=30 {
            let q = p - vec2(0.0, 2.0 * i as f32);
            let pointer = PointerState { pos: Some(q), primary_down: true, primary_pressed: i == 0, ..Default::default() };
            let (ev, _) = frame(&mut h, &o, &shared, pointer);
            holds.extend(ev.into_iter().filter_map(|e| if let WaterViewEvent::Hold { source, velocity } = e { Some((source, velocity)) } else { None }));
        }
        let (ev, _) = frame(&mut h, &o, &shared, PointerState { pos: Some(p), ..Default::default() });
        assert!(ev.is_empty(), "letting go sends nothing more: {ev:?}");
        assert!(holds.iter().all(|x| x.0 == source), "{t:?}: {holds:?}");
        assert!(holds.len() as f32 >= 0.5 / HOLD_EVERY - 1.0, "{t:?} held half a second: {holds:?}");
        assert!(holds.last().unwrap().1 > holds[0].1, "dragging up should be more: {holds:?}");
    }
    // The tub: dragged quickly from side to side, it is shaken harder than when held still.
    let p = target_screen(widget(), &o, Target::Tub).expect("on screen");
    let mut still = Vec::new();
    let mut shaken = Vec::new();
    for (moving, out) in [(false, &mut still), (true, &mut shaken)] {
        for i in 0..=30 {
            let q = if moving { p + vec2(if i % 2 == 0 { -20.0 } else { 20.0 }, 0.0) } else { p };
            let pointer = PointerState { pos: Some(q), primary_down: true, primary_pressed: i == 0, ..Default::default() };
            let (ev, _) = frame(&mut h, &o, &shared, pointer);
            out.extend(ev.into_iter().filter_map(|e| if let WaterViewEvent::Hold { source: Source::Slosh, velocity } = e { Some(velocity) } else { None }));
        }
        let _ = frame(&mut h, &o, &shared, PointerState::default());
    }
    assert!(!still.is_empty() && !shaken.is_empty());
    assert!(shaken.iter().skip(1).fold(0.0f32, |m, v| m.max(*v)) > still.iter().skip(1).fold(0.0f32, |m, v| m.max(*v)), "{still:?} {shaken:?}");
}

#[test]
fn the_pads_and_the_chip_ask_for_what_they_should() {
    let shared = WaterShared::default();
    let mut h = Harness::new(W, H);
    let o = opts(false);
    let _ = frame(&mut h, &o, &shared, PointerState::default());
    for (source, r) in pad_rects(widget()) {
        let press = PointerState { pos: Some(r.center()), primary_down: true, primary_pressed: true, ..Default::default() };
        let (events, _) = frame(&mut h, &o, &shared, press);
        let _ = frame(&mut h, &o, &shared, PointerState::default());
        assert!(events.iter().any(|e| matches!(e, WaterViewEvent::Pad { source: s, .. } if *s == source)), "{source:?}: {events:?}");
    }
    let chip = pos2((W as f32 - 20.0) - 52.0, 21.0);
    let press = PointerState { pos: Some(chip), primary_down: true, primary_pressed: true, ..Default::default() };
    let (events, _) = frame(&mut h, &o, &shared, press);
    assert!(events.contains(&WaterViewEvent::PhysicsView(true)), "got {events:?}");
}
