//! Fast tier for the `entropy_gui::TrackView` arrangement widget.
//!
//! `tests/features/track_view.feature` is executed against the real widget: each step builds a
//! `RawInput` frame exactly as the window backend would (pointer position, pressed/held/released
//! edges, modifiers, key events), runs it through a headless `entropy_gui::Context`, and reads
//! back the `TrackViewEvent`s. That exercises the code the addon-level tests cannot reach - snap
//! maths, drag origin, edge grabbing, the draw-to-create gesture, hit-test priority - without a
//! window or a GPU. Injected `TRACKS_*` events in the DAW suites skip all of it.
//!
//! Geometry the steps rely on: a 1000 px wide screen, a 100 px header gutter, 34 px lanes, a 26 px
//! ruler, and `fit_on_open`, which zooms the 9000 ms song to the 900 px grid: 10 ms per pixel.

use cucumber::{given, then, when, World as _};
use entropy_engine::entropy_gui::color::Color32;
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::geometry::{pos2, vec2, Pos2, Rect};
use entropy_engine::entropy_gui::{
    CentralPanel, Context, Key, KeyEvent, Modifiers, RawInput, Track, TrackClip, TrackView, TrackViewEvent, TrackViewOptions,
};

const LABEL_W: f32 = 100.0;
const LANE_H: f32 = 34.0;
const RULER_H: f32 = 26.0;
const SCREEN_W: f32 = 1000.0;
const SCREEN_H: f32 = 700.0;

fn x_at(ms: f32, zoom: f32) -> f32 {
    LABEL_W + ms / zoom
}

fn lane_y(lane: usize) -> f32 {
    RULER_H + LANE_H * (lane as f32 - 1.0) + LANE_H / 2.0
}

#[derive(cucumber::World)]
struct ViewWorld {
    ctx: Context,
    tracks: Vec<Track>,
    options: TrackViewOptions,
    duration_ms: i32,
    selected: Option<(String, String)>,
    pos: Option<Pos2>,
    alt: bool,
    keys: Vec<KeyEvent>,
    scroll_y: f32,
    ctrl: bool,
    zoom: f32,
    /// The zoom just before the last wheel step, for the zoom assertions.
    zoom_before: f32,
    events: Vec<TrackViewEvent>,
}

impl std::fmt::Debug for ViewWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ViewWorld").field("events", &self.events).field("zoom", &self.zoom).finish()
    }
}

impl Default for ViewWorld {
    fn default() -> Self {
        Self {
            ctx: Context::default(),
            tracks: Vec::new(),
            options: TrackViewOptions::default(),
            duration_ms: 0,
            selected: None,
            pos: None,
            alt: false,
            keys: Vec::new(),
            scroll_y: 0.0,
            ctrl: false,
            zoom: 5.0,
            zoom_before: 5.0,
            events: Vec::new(),
        }
    }
}

impl ViewWorld {
    /// One frame of input through the widget. `pressed`/`released` are the edges; `down` is held.
    fn frame(&mut self, down: bool, pressed: bool, released: bool) {
        let raw = RawInput {
            screen_rect: Rect::from_min_size(pos2(0.0, 0.0), vec2(SCREEN_W, SCREEN_H)),
            pixels_per_point: 1.0,
            pointer: PointerState { pos: self.pos, primary_down: down, primary_pressed: pressed, primary_released: released, ..Default::default() },
            scroll_delta: vec2(0.0, std::mem::take(&mut self.scroll_y)),
            modifiers: Modifiers { alt: self.alt, ctrl: self.ctrl, ..Default::default() },
            key_events: std::mem::take(&mut self.keys),
            dt: 1.0 / 60.0,
            ..Default::default()
        };
        let mut produced = Vec::new();
        let mut zoom = self.zoom;
        let selected: Option<(String, String)> = self.selected.clone();
        let (tracks, options, duration) = (&self.tracks, self.options.clone(), self.duration_ms);
        self.ctx.run(raw, |ctx| {
            CentralPanel::default().show(ctx, |ui| {
                let selected_ref = selected.as_ref().map(|(t, c)| (t.as_str(), c.as_str()));
                let response = TrackView::new("arrangement").options(options).show(ui, tracks, duration, 0, selected_ref);
                zoom = response.zoom;
                produced = response.events;
            });
        });
        self.zoom = zoom;
        // Apply move/resize the way an addon would, so the next frame draws what a real caller would hand back.
        for event in &produced {
            match event {
                TrackViewEvent::ClipMoved { clip, start_ms, .. } => {
                    if let Some(c) = self.clip_mut(clip) {
                        c.start_ms = *start_ms;
                    }
                }
                TrackViewEvent::ClipResized { clip, start_ms, duration_ms, .. } => {
                    if let Some(c) = self.clip_mut(clip) {
                        c.start_ms = *start_ms;
                        c.duration_ms = *duration_ms;
                    }
                }
                _ => {}
            }
        }
        self.events.extend(produced);
    }

    fn clip_mut(&mut self, id: &str) -> Option<&mut TrackClip> {
        self.tracks.iter_mut().flat_map(|t| t.clips.iter_mut()).find(|c| c.id == id)
    }

    fn clip(&self, id: &str) -> &TrackClip {
        self.tracks.iter().flat_map(|t| t.clips.iter()).find(|c| c.id == id).unwrap_or_else(|| panic!("no clip {id}"))
    }

    fn hover(&mut self, x: f32, y: f32) {
        self.pos = Some(pos2(x, y));
        self.frame(false, false, false);
    }

    /// Press at (x, y), walk to (x2, y) in small steps (a real drag arrives as many events, and the
    /// widget measures from where the press began), then release.
    fn drag(&mut self, from: (f32, f32), to_x: f32) {
        self.events.clear();
        self.hover(from.0, from.1);
        self.pos = Some(pos2(from.0, from.1));
        self.frame(true, true, false);
        let steps = ((to_x - from.0).abs() / 6.0).ceil().max(1.0) as i32;
        for i in 1..=steps {
            let x = from.0 + (to_x - from.0) * i as f32 / steps as f32;
            self.pos = Some(pos2(x, from.1));
            self.frame(true, false, false);
        }
        self.frame(false, false, true);
    }

    fn click(&mut self, x: f32, y: f32) {
        self.events.clear();
        self.hover(x, y);
        self.frame(true, true, false);
        self.frame(false, false, true);
    }

    fn last_moved(&self, clip_id: &str) -> Option<i32> {
        self.events.iter().rev().find_map(|e| match e {
            TrackViewEvent::ClipMoved { clip, start_ms, .. } if clip == clip_id => Some(*start_ms),
            _ => None,
        })
    }

    fn last_resized(&self, clip_id: &str) -> Option<(i32, i32)> {
        self.events.iter().rev().find_map(|e| match e {
            TrackViewEvent::ClipResized { clip, start_ms, duration_ms, .. } if clip == clip_id => Some((*start_ms, *duration_ms)),
            _ => None,
        })
    }

    fn created(&self) -> Vec<(String, i32, i32)> {
        self.events
            .iter()
            .filter_map(|e| match e {
                TrackViewEvent::ClipCreateRequested { track, start_ms, duration_ms } => Some((track.clone(), *start_ms, *duration_ms)),
                _ => None,
            })
            .collect()
    }
}

#[given(expr = "a track view with {int} lanes, {int} bars of {int} ms, snapping to {int} ms")]
fn a_track_view(world: &mut ViewWorld, lanes: usize, bars: i32, bar_ms: i32, snap: i32) {
    world.tracks = (1..=lanes)
        .map(|i| {
            let mut t = Track::new(format!("t{i}"), format!("Track {i}"));
            t.controls = true;
            t.color = Some(Color32::from_rgb(90, 160, 240));
            t
        })
        .collect();
    world.duration_ms = bars * bar_ms;
    world.options = TrackViewOptions {
        lane_h: LANE_H,
        label_w: LABEL_W,
        snap_ms: snap,
        bar_ms,
        beat_ms: bar_ms / 4,
        fit_on_open: true,
        zoom_needs_ctrl: true,
        allow_draw: true,
        lane_numbers: true,
        ..Default::default()
    };
}

#[given(expr = "lane {int} has a clip {string} from {int} ms for {int} ms")]
fn lane_has_clip(world: &mut ViewWorld, lane: usize, id: String, start: i32, dur: i32) {
    let clip = TrackClip::new(id, "clip", start, dur, Color32::from_rgb(90, 160, 240));
    world.tracks[lane - 1].clips.push(clip);
}

#[given("the view has settled")]
fn view_has_settled(world: &mut ViewWorld) {
    // Park the pointer off the widget for a frame so `fit_on_open` has fit the song to the grid.
    world.pos = Some(pos2(500.0, 650.0));
    world.frame(false, false, false);
    assert!((world.zoom - 10.0).abs() < 0.01, "9000 ms over 900 px should fit at 10 ms/px, got {}", world.zoom);
}

#[given(expr = "clip {string} is selected")]
fn clip_is_selected(world: &mut ViewWorld, id: String) {
    world.selected = Some(("t1".into(), id));
}

#[given("snapping is off")]
fn snapping_off(world: &mut ViewWorld) {
    world.options.snap_ms = 0;
}

#[when("I hold Alt")]
fn hold_alt(world: &mut ViewWorld) {
    world.alt = true;
}

#[when(expr = "I drag clip {string} by {int} ms")]
fn drag_clip(world: &mut ViewWorld, id: String, by: i32) {
    let (start, dur) = (world.clip(&id).start_ms as f32, world.clip(&id).duration_ms as f32);
    let z = world.zoom;
    let x = x_at(start + dur / 2.0, z);
    world.drag((x, lane_y(1)), x + by as f32 / z);
}

#[when(expr = "I drag the right edge of clip {string} by {int} ms")]
fn drag_right_edge(world: &mut ViewWorld, id: String, by: i32) {
    let end = (world.clip(&id).start_ms + world.clip(&id).duration_ms) as f32;
    let z = world.zoom;
    let x = x_at(end, z) - 3.0;
    world.drag((x, lane_y(1)), x + by as f32 / z);
}

#[when(expr = "I drag the left edge of clip {string} by {int} ms")]
fn drag_left_edge(world: &mut ViewWorld, id: String, by: i32) {
    let start = world.clip(&id).start_ms as f32;
    let z = world.zoom;
    let x = x_at(start, z) + 3.0;
    world.drag((x, lane_y(1)), x + by as f32 / z);
}

#[when(expr = "I drag from {int} ms to {int} ms on lane {int}")]
fn drag_lane(world: &mut ViewWorld, from: i32, to: i32, lane: usize) {
    let z = world.zoom;
    world.drag((x_at(from as f32, z), lane_y(lane)), x_at(to as f32, z));
}

#[when(expr = "I click at {int} ms on lane {int}")]
fn click_lane(world: &mut ViewWorld, ms: i32, lane: usize) {
    let z = world.zoom;
    world.click(x_at(ms as f32, z), lane_y(lane));
}

#[when(expr = "I click the ruler at {int} ms")]
fn click_ruler(world: &mut ViewWorld, ms: i32) {
    let z = world.zoom;
    world.click(x_at(ms as f32, z), RULER_H / 2.0);
}

#[when(expr = "I drag along the ruler from {int} ms to {int} ms")]
fn drag_ruler(world: &mut ViewWorld, from: i32, to: i32) {
    let z = world.zoom;
    world.drag((x_at(from as f32, z), RULER_H / 2.0), x_at(to as f32, z));
}

#[when(expr = "I click the {word} pill of lane {int}")]
fn click_pill(world: &mut ViewWorld, which: String, lane: usize) {
    // The pills sit at the right end of the header: 20 px wide, 8 px in from the edge, 4 px apart.
    let solo_x = LABEL_W - 8.0 - 10.0;
    let mute_x = solo_x - 10.0 - 4.0 - 10.0;
    let x = match which.as_str() {
        "mute" => mute_x,
        "solo" => solo_x,
        other => panic!("unknown pill {other}"),
    };
    world.click(x, lane_y(lane));
}

#[when("I press Delete with the pointer over the timeline")]
fn delete_over(world: &mut ViewWorld) {
    world.events.clear();
    let z = world.zoom;
    world.pos = Some(pos2(x_at(4000.0, z), lane_y(2)));
    world.keys.push(KeyEvent { key: Key::Delete, pressed: true, modifiers: Modifiers::default() });
    world.frame(false, false, false);
}

#[when("I press Delete with the pointer elsewhere")]
fn delete_elsewhere(world: &mut ViewWorld) {
    world.events.clear();
    world.pos = Some(pos2(500.0, 650.0));
    world.keys.push(KeyEvent { key: Key::Delete, pressed: true, modifiers: Modifiers::default() });
    world.frame(false, false, false);
}

#[when("I scroll the wheel over the timeline")]
fn wheel(world: &mut ViewWorld) {
    world.events.clear();
    world.zoom_before = world.zoom;
    let z = world.zoom;
    world.pos = Some(pos2(x_at(4000.0, z), lane_y(2)));
    world.scroll_y = 60.0;
    world.frame(false, false, false);
}

#[when("I scroll the wheel over the timeline holding Ctrl")]
fn wheel_ctrl(world: &mut ViewWorld) {
    world.ctrl = true;
    wheel(world);
    world.ctrl = false;
}

#[then(expr = "clip {string} was moved to start at {int} ms")]
fn clip_moved_to(world: &mut ViewWorld, id: String, start: i32) {
    assert_eq!(world.last_moved(&id), Some(start), "events: {:#?}", world.events);
}

#[then(expr = "clip {string} was resized to start at {int} ms and last {int} ms")]
fn clip_resized_to(world: &mut ViewWorld, id: String, start: i32, dur: i32) {
    assert_eq!(world.last_resized(&id), Some((start, dur)), "events: {:#?}", world.events);
}

#[then(expr = "clip {string} ends at {int} ms and lasts at least {int} ms")]
fn clip_ends_at(world: &mut ViewWorld, id: String, end: i32, min: i32) {
    let (start, dur) = world.last_resized(&id).unwrap_or_else(|| panic!("no resize: {:#?}", world.events));
    assert_eq!(start + dur, end);
    assert!(dur >= min, "duration {dur} < {min}");
}

#[then(expr = "a clip was created on lane {int} from {int} ms for {int} ms")]
fn clip_created(world: &mut ViewWorld, lane: usize, start: i32, dur: i32) {
    assert_eq!(world.created(), vec![(format!("t{lane}"), start, dur)], "events: {:#?}", world.events);
}

#[then("no clip was created")]
fn no_clip_created(world: &mut ViewWorld) {
    assert!(world.created().is_empty(), "events: {:#?}", world.events);
}

#[then(expr = "the lane {int} track was clicked")]
fn lane_clicked(world: &mut ViewWorld, lane: usize) {
    let id = format!("t{lane}");
    assert!(world.events.iter().any(|e| matches!(e, TrackViewEvent::TrackClicked(t) if *t == id)), "events: {:#?}", world.events);
}

#[then(expr = "the lane {int} track was not clicked")]
fn lane_not_clicked(world: &mut ViewWorld, lane: usize) {
    let id = format!("t{lane}");
    assert!(!world.events.iter().any(|e| matches!(e, TrackViewEvent::TrackClicked(t) if *t == id)), "events: {:#?}", world.events);
}

#[then("the background was clicked")]
fn background_clicked(world: &mut ViewWorld) {
    assert!(world.events.iter().any(|e| matches!(e, TrackViewEvent::BackgroundClicked)), "events: {:#?}", world.events);
}

#[then("the background was not clicked")]
fn background_not_clicked(world: &mut ViewWorld) {
    assert!(!world.events.iter().any(|e| matches!(e, TrackViewEvent::BackgroundClicked)), "events: {:#?}", world.events);
}

#[then(expr = "clip {string} was selected")]
fn clip_selected(world: &mut ViewWorld, id: String) {
    assert!(world.events.iter().any(|e| matches!(e, TrackViewEvent::ClipSelected { clip, .. } if *clip == id)), "events: {:#?}", world.events);
}

#[then(expr = "the playhead was sought to {int} ms")]
fn sought(world: &mut ViewWorld, ms: i32) {
    let last = world.events.iter().rev().find_map(|e| match e {
        TrackViewEvent::Seek(t) => Some(*t),
        _ => None,
    });
    assert_eq!(last, Some(ms), "events: {:#?}", world.events);
}

#[then(expr = "lane {int} was muted")]
fn muted(world: &mut ViewWorld, lane: usize) {
    let id = format!("t{lane}");
    assert!(world.events.iter().any(|e| matches!(e, TrackViewEvent::TrackMuteToggled(t) if *t == id)), "events: {:#?}", world.events);
}

#[then(expr = "lane {int} was soloed")]
fn soloed(world: &mut ViewWorld, lane: usize) {
    let id = format!("t{lane}");
    assert!(world.events.iter().any(|e| matches!(e, TrackViewEvent::TrackSoloToggled(t) if *t == id)), "events: {:#?}", world.events);
}

#[then("no deletion was requested")]
fn no_deletion(world: &mut ViewWorld) {
    assert!(!world.events.iter().any(|e| matches!(e, TrackViewEvent::ClipDeleteRequested { .. })), "events: {:#?}", world.events);
}

#[then(expr = "clip {string} was requested for deletion")]
fn deletion(world: &mut ViewWorld, id: String) {
    assert!(world.events.iter().any(|e| matches!(e, TrackViewEvent::ClipDeleteRequested { clip, .. } if *clip == id)), "events: {:#?}", world.events);
}

#[when(expr = "the bars become {int} ms long")]
fn bars_become(world: &mut ViewWorld, bar_ms: i32) {
    // What a tempo change does to the widget's input: the bar (and beat) length in ms changes.
    world.options.bar_ms = bar_ms;
    world.options.beat_ms = bar_ms / 4;
    world.pos = Some(pos2(500.0, 650.0));
    world.frame(false, false, false);
}

#[then(expr = "the zoom is {int} ms per pixel")]
fn zoom_is(world: &mut ViewWorld, ms_per_px: i32) {
    assert!((world.zoom - ms_per_px as f32).abs() < 0.01, "zoom is {} ms/px, expected {ms_per_px}", world.zoom);
}

#[then("the zoom is unchanged")]
fn zoom_unchanged(world: &mut ViewWorld) {
    assert!((world.zoom - world.zoom_before).abs() < 1e-4, "zoom moved from {} to {}", world.zoom_before, world.zoom);
}

#[then("the zoom changed")]
fn zoom_changed(world: &mut ViewWorld) {
    assert!((world.zoom - world.zoom_before).abs() > 0.01, "zoom stayed at {}", world.zoom);
}

#[tokio::main]
async fn main() {
    // run_and_exit, not run: a failing step must fail the test binary.
    ViewWorld::cucumber().fail_on_skipped().run_and_exit("tests/features/track_view.feature").await;
}
