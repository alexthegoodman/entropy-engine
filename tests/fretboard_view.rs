//! Headless tier for `entropy_gui::FretboardView`, the Guitar Tabs app's neck: the real widget,
//! rasterized on the CPU (`tests/common/raster.rs`). Pictures land in `test-artifacts/fretboard-view/`
//! so a change to the view can be looked at, not just asserted.

use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::geometry::pos2;
use entropy_engine::entropy_gui::widgets_fretboard::layout;
use entropy_engine::entropy_gui::{FretMark, FretboardEvent, FretboardOptions, FretboardView, HighwayItem, HighwayState, Rect};
use image::RgbaImage;

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

const W: usize = 1200;
const H: usize = 560;

fn artifacts() -> std::path::PathBuf {
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("fretboard-view");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn frame(h: &mut Harness, opts: &FretboardOptions, pointer: PointerState) -> (Vec<FretboardEvent>, Rect, RgbaImage) {
    let mut events = Vec::new();
    let mut rect = Rect::NOTHING;
    let cmds = h.run(pointer, 0.0, |ui| {
        let resp = FretboardView::new("fb-test").show(ui, opts);
        events = resp.events;
        rect = resp.rect;
    });
    let img = h.render(&cmds);
    (events, rect, img)
}

fn opts() -> FretboardOptions {
    FretboardOptions { width: Some(W as f32 - 20.0), height: H as f32 - 20.0, ..Default::default() }
}

fn mark(string: u8, fret: u8, finger: Option<u8>) -> FretMark {
    FretMark { string, fret, finger, ..Default::default() }
}

/// Pixels close to a colour.
fn count_near(img: &RgbaImage, rgb: [u8; 3], tol: i32) -> usize {
    img.pixels().filter(|p| (0..3).all(|k| (p.0[k] as i32 - rgb[k] as i32).abs() <= tol)).count()
}

const AMBER: [u8; 3] = [255, 199, 92];
const TEAL: [u8; 3] = [71, 230, 214];
const ROSE: [u8; 3] = [255, 92, 107];

/// A C major chord (x32010) being played: the targets with fingers, the next chord (G) as ghosts,
/// what the guitar hears (C3 and E3 right, one wrong note), and the highway.
fn lesson() -> FretboardOptions {
    let mut o = opts();
    o.caption = "Open Chord Changes  -  bar 2, step 3 of 8  -  C".into();
    o.status = "accuracy 92%   streak 4".into();
    o.targets = vec![mark(1, 3, Some(3)), mark(2, 2, Some(2)), mark(3, 0, None), mark(4, 1, Some(1)), mark(5, 0, None)];
    o.muted = vec![0];
    o.upcoming = [(0u8, 3u8), (1, 2), (5, 3)].iter().map(|&(s, f)| FretMark { string: s, fret: f, ahead: 1, ..Default::default() }).collect();
    o.heard = vec![FretMark { string: 1, fret: 3, correct: true, ..Default::default() }, FretMark { string: 3, fret: 4, correct: false, ..Default::default() }];
    let chord = |ahead: f32, notes: &[(u8, u8)], state: HighwayState, label: &str| HighwayItem { ahead, notes: notes.to_vec(), muted: vec![], state, label: Some(label.into()) };
    let g = [(0u8, 3u8), (1, 2), (2, 0), (3, 0), (4, 0), (5, 3)];
    let c = [(1u8, 3u8), (2, 2), (3, 0), (4, 1), (5, 0)];
    o.highway = vec![
        chord(-4.0, &g, HighwayState::Hit, "G"),
        chord(-2.0, &g, HighwayState::Partial, "G"),
        chord(0.0, &c, HighwayState::Current, "C"),
        chord(2.0, &c, HighwayState::Waiting, "C"),
        chord(4.0, &[(2, 0), (3, 2), (4, 3), (5, 2)], HighwayState::Waiting, "D"),
        chord(6.0, &[(2, 0), (3, 2), (4, 3), (5, 2)], HighwayState::Waiting, "D"),
    ];
    o.highway_bars = vec![-2.0, 2.0, 6.0];
    o
}

#[test]
fn a_lesson_draws_targets_ghosts_heard_notes_and_the_highway() {
    let mut h = Harness::new(W, H);
    let o = lesson();
    let _ = frame(&mut h, &o, PointerState::default());
    let (_, _, img) = frame(&mut h, &o, PointerState::default());
    img.save(artifacts().join("c-major-lesson.png")).unwrap();

    // A fresh view: strings keep ringing for a moment after a heard note, and no time passes here.
    let (_, _, bare) = frame(&mut Harness::new(W, H), &opts(), PointerState::default());
    bare.save(artifacts().join("empty-neck.png")).unwrap();

    let amber = count_near(&img, AMBER, 40);
    let teal = count_near(&img, TEAL, 40);
    let rose = count_near(&img, ROSE, 40);
    assert!(amber > count_near(&bare, AMBER, 40) + 600, "targets and the now line should glow amber ({amber})");
    assert!(teal > count_near(&bare, TEAL, 40) + 150, "right notes and hit steps should show teal ({teal})");
    assert!(rose > count_near(&bare, ROSE, 40) + 80, "the wrong note and muted string should show rose ({rose})");
}

#[test]
fn a_window_up_the_neck_and_no_highway_still_draws() {
    let mut h = Harness::new(W, H);
    let mut o = opts();
    // Frets after the first shown wire are drawn: 4 shows fret 5 on.
    o.first_fret = 4;
    o.last_fret = 17;
    o.show_highway = false;
    o.targets = vec![mark(0, 5, Some(1)), mark(1, 7, Some(3)), mark(2, 7, Some(4)), mark(3, 6, Some(2)), mark(4, 5, Some(1)), mark(5, 5, Some(1))];
    let (_, _, img) = frame(&mut h, &o, PointerState::default());
    img.save(artifacts().join("a-barre-at-fret-5.png")).unwrap();
    assert!(count_near(&img, AMBER, 40) > 500);
}

#[test]
fn clicking_the_neck_picks_that_string_and_fret() {
    let mut h = Harness::new(W, H);
    let o = lesson();
    let (_, rect, _) = frame(&mut h, &o, PointerState::default());
    let (_, neck) = layout(rect, &o);
    for (s, f) in [(1u8, 3u8), (5, 0), (0, 12), (3, 7)] {
        let p = pos2(neck.note_x(f), neck.string_y(s));
        let hover = PointerState { pos: Some(p), ..Default::default() };
        let _ = frame(&mut h, &o, hover);
        let press = PointerState { pos: Some(p), primary_down: true, primary_pressed: true, ..Default::default() };
        let (events, _, _) = frame(&mut h, &o, press);
        assert_eq!(events, vec![FretboardEvent::Pick { string: s, fret: f }], "string {s} fret {f}");
        let release = PointerState { pos: Some(p), primary_released: true, ..Default::default() };
        let _ = frame(&mut h, &o, release);
    }
    // A click on the highway is not a pick.
    let (hw, _) = layout(rect, &o);
    let press = PointerState { pos: Some(hw.unwrap().center()), primary_down: true, primary_pressed: true, ..Default::default() };
    let (events, _, _) = frame(&mut h, &o, press);
    assert!(events.is_empty(), "{events:?}");
}

#[test]
fn a_view_that_is_not_interactive_ignores_clicks() {
    let mut h = Harness::new(W, H);
    let mut o = lesson();
    o.interactive = false;
    let (_, rect, _) = frame(&mut h, &o, PointerState::default());
    let (_, neck) = layout(rect, &o);
    let p = pos2(neck.note_x(3), neck.string_y(1));
    let press = PointerState { pos: Some(p), primary_down: true, primary_pressed: true, ..Default::default() };
    let (events, _, _) = frame(&mut h, &o, press);
    assert!(events.is_empty());
}
