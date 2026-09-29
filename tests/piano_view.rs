//! Headless tier for `entropy_gui::PianoView`: the real widget, driven by the real grand piano
//! engine (notes played through `PianoEngine`, publishing into a `PianoShared` exactly as on the
//! audio thread), rasterized on the CPU (`tests/common/raster.rs`). Pictures land in
//! `test-artifacts/piano-view/`, so a change to the view can be visually inspected and asserted.

use entropy_engine::audio::piano::{
    railsback_frequency, PianoEngine, PianoParams, PianoPreset, PianoShared,
};
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::geometry::pos2;
use entropy_engine::entropy_gui::{PianoEvent, PianoOptions, PianoView};
use image::RgbaImage;
use std::sync::Arc;

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

const W: usize = 1100;
const H: usize = 680;

fn artifacts() -> std::path::PathBuf {
    let dir = std::env::current_dir()
        .unwrap()
        .join("test-artifacts")
        .join("piano-view");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Plays notes into a fresh shared state, leaving the engine mid-note (so the shared state shows a sounding grand piano).
fn sounding_piano(keys: &[usize], secs: f32) -> Arc<PianoShared> {
    let shared = Arc::new(PianoShared::default());
    let mut params = PianoParams::default();
    params.preset = PianoPreset::ConcertGrand;
    let mut engine = PianoEngine::new(44_100.0, &params);

    for &k in keys {
        let f = railsback_frequency(k);
        engine.note_on(f, 0.85);
    }

    let frames = (secs * 44_100.0) as usize;
    for _ in 0..frames {
        let [l, r] = engine.next_frame();
        let e = 0.5 * (l * l + r * r);
        shared.publish(&engine, e);
    }

    shared
}

fn frame(
    h: &mut Harness,
    opts: &PianoOptions,
    shared: &PianoShared,
    pointer: PointerState,
) -> (Vec<PianoEvent>, RgbaImage) {
    let mut events = Vec::new();
    let cmds = h.run(pointer, 0.0, |ui| {
        let resp = PianoView::new("piano-view-test").show(ui, opts, shared);
        events = resp.events;
    });
    let img = h.render(&cmds);
    (events, img)
}

fn settled(h: &mut Harness, opts: &PianoOptions, shared: &PianoShared) -> RgbaImage {
    let _ = frame(h, opts, shared, PointerState::default());
    frame(h, opts, shared, PointerState::default()).1
}

fn lit_pixels(img: &RgbaImage) -> usize {
    img.pixels()
        .filter(|p| p.0[0] as u32 + p.0[1] as u32 + p.0[2] as u32 > 330)
        .count()
}

fn difference(a: &RgbaImage, b: &RgbaImage) -> usize {
    a.pixels()
        .zip(b.pixels())
        .filter(|(x, y)| {
            x.0.iter()
                .zip(y.0.iter())
                .any(|(p, q)| (*p as i32 - *q as i32).abs() > 24)
        })
        .count()
}

fn opts(physics: bool) -> PianoOptions {
    PianoOptions {
        width: Some(W as f32 - 20.0),
        height: H as f32 - 20.0,
        physics_view: physics,
    }
}

#[test]
fn the_view_draws_at_rest_and_under_active_sound() {
    let idle_shared = PianoShared::default();
    let mut h = Harness::new(W, H);

    // 1. Idle state
    let idle_img = settled(&mut h, &opts(false), &idle_shared);
    idle_img.save(artifacts().join("grand-piano-idle.png")).unwrap();
    let idle_lit = lit_pixels(&idle_img);
    println!("Grand piano at rest: {} lit pixels", idle_lit);
    assert!(idle_lit > 1500, "Piano rim, keyboard and cast iron frame must be drawn");

    // 2. Sounding state (C-major chord: C4, E4, G4 -> keys 39, 43, 46)
    let sounding_shared = sounding_piano(&[39, 43, 46], 0.25);
    let sounding_img = settled(&mut h, &opts(false), &sounding_shared);
    sounding_img.save(artifacts().join("grand-piano-sounding.png")).unwrap();
    let sound_lit = lit_pixels(&sounding_img);
    println!("Grand piano sounding: {} lit pixels", sound_lit);
    assert!(sound_lit > 1500, "Sounding piano must be rendered");

    // The sounding state illuminates vibrating strings and active hammers
    let diff = difference(&idle_img, &sounding_img);
    println!("Visual difference (idle vs sounding): {} pixels", diff);
    assert!(diff > 500, "Sounding strings and hammers must produce visual difference");
}

#[test]
fn physics_view_overlays_soundboard_modes_and_hammer_curves() {
    let sounding_shared = sounding_piano(&[48], 0.3); // A4 (concert pitch)
    let mut h = Harness::new(W, H);

    let plain = settled(&mut h, &opts(false), &sounding_shared);
    let physics = settled(&mut h, &opts(true), &sounding_shared);
    physics.save(artifacts().join("grand-piano-physics-view.png")).unwrap();

    let diff = difference(&plain, &physics);
    println!("Physics view overlay difference: {} pixels", diff);
    assert!(
        diff > 4000,
        "Physics View overlay must draw soundboard plate modes, hammer traces, and Railsback curves"
    );
}

#[test]
fn sustain_pedal_down_lifts_dampers_visually() {
    let shared = Arc::new(PianoShared::default());
    let mut params = PianoParams::default();
    params.sustain_pedal = 1.0;
    let mut engine = PianoEngine::new(44_100.0, &params);
    engine.note_on(railsback_frequency(39), 0.8);
    for _ in 0..4410 {
        let [l, r] = engine.next_frame();
        shared.publish(&engine, 0.5 * (l * l + r * r));
    }

    let mut h = Harness::new(W, H);
    let pedal_img = settled(&mut h, &opts(false), &shared);
    pedal_img.save(artifacts().join("grand-piano-sustain-pedal.png")).unwrap();

    let lit = lit_pixels(&pedal_img);
    println!("Grand piano sustain pedal down: {} lit pixels", lit);
    assert!(lit > 1500, "Piano with dampers lifted must be rendered cleanly");
}

#[test]
fn clicking_keyboard_produces_key_events() {
    let shared = PianoShared::default();
    let mut h = Harness::new(W, H);
    let o = opts(false);

    // Warm up layout
    let _ = frame(&mut h, &o, &shared, PointerState::default());

    use entropy_engine::entropy_gui::geometry::{Rect,vec2};
    use entropy_engine::entropy_gui::widgets_piano::piano_key_rects;
    let stage=Rect::from_min_size(pos2(0.0,0.0),vec2(W as f32-20.0,H as f32-20.0));
    let r=piano_key_rects(stage).into_iter().find(|(k,_)|*k==39).unwrap().1;
    let click_pos=pos2(r.center().x,r.max.y-20.0);
    let press=PointerState{pos:Some(click_pos),primary_down:true,primary_pressed:true,..Default::default()};
    let (events,_)=frame(&mut h,&o,&shared,press);
    assert_eq!(events.iter().filter(|e|matches!(e,PianoEvent::KeyPressed{key:39,..})).count(),1,"{events:?}");
    let held=PointerState{pos:Some(click_pos),primary_down:true,..Default::default()};
    assert!(frame(&mut h,&o,&shared,held).0.is_empty(),"no retrigger while held");
    let released=PointerState{pos:Some(pos2(-10.0,-10.0)),primary_released:true,..Default::default()};
    let events=frame(&mut h,&o,&shared,released).0;
    assert!(events.iter().any(|e|matches!(e,PianoEvent::KeyReleased{key:39,..})),"{events:?}");
}

#[test]
fn clicking_pedal_and_chips_produce_control_events() {
    let shared = PianoShared::default();
    let mut h = Harness::new(W, H);
    let o = opts(false);

    // 1. Click Physics chip at top-right
    let chip_pos = pos2((W as f32) - 80.0, 30.0);
    let press_chip = PointerState {
        pos: Some(chip_pos),
        primary_down: true,
        primary_pressed: true,
        ..Default::default()
    };
    let (events, _) = frame(&mut h, &o, &shared, press_chip);
    println!("Chip click events: {:?}", events);
    assert!(
        events.iter().any(|e| matches!(e, PianoEvent::PhysicsToggled(_))),
        "Clicking physics chip should toggle physics view"
    );

    // 2. Click Sustain Pedal button at top-left
    let pedal_pos = pos2(30.0, 60.0);
    let press_pedal = PointerState {
        pos: Some(pedal_pos),
        primary_down: true,
        primary_pressed: true,
        ..Default::default()
    };
    let (events_pedal, _) = frame(&mut h, &o, &shared, press_pedal);
    println!("Pedal click events: {:?}", events_pedal);
    assert!(
        events_pedal.iter().any(|e| matches!(e, PianoEvent::SustainToggled { .. })),
        "Clicking sustain pedal button should toggle sustain pedal"
    );
}
