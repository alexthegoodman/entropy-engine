//! Headless tier for window layering: a floating `Window` takes the pointer (press, hold, wheel)
//! away from every panel widget underneath it.
//!
//! `tests/features/window_layers.feature` runs real widgets (a scrolling `PadGrid`, `Window`s, plain
//! `interact` rects) inside a headless `entropy_gui::Context`, one frame at a time. Pointer input is
//! built the way the window backend builds it: a hover frame, a press frame, held frames, a release
//! frame.

use cucumber::{given, then, when, World as _};
use entropy_engine::entropy_gui::color::Color32;
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::geometry::{pos2, vec2, Pos2, Rect, Vec2};
use entropy_engine::entropy_gui::response::Sense;
use entropy_engine::entropy_gui::{
    CentralPanel, Context, Id, Pad, PadEvent, PadGrid, PadGridOptions, PadKind, RawInput, ScrollArea, Window,
};

const SCREEN: (f32, f32) = (900.0, 560.0);

fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> Rect {
    Rect::from_min_max(pos2(x0, y0), pos2(x1, y1))
}

/// The panel's own drag handle, far from both windows.
fn panel_handle() -> Rect {
    rect(460.0, 380.0, 540.0, 420.0)
}

#[derive(Default)]
struct WindowSpec {
    pos: [f32; 2],
    size: [f32; 2],
}

#[derive(cucumber::World)]
struct LayerWorld {
    ctx: Context,
    rack: WindowSpec,
    rack_open: bool,
    analyzer: Option<WindowSpec>,
    pointer: Pos2,
    // Accumulated over the scenario.
    pad_events: Vec<String>,
    rack_button: u32,
    rack_overlap: u32,
    analyzer_button: u32,
    rack_handle_drag: Vec2,
    panel_handle_drag: Vec2,
    // What the last frame reported.
    pad_rects: Vec<Rect>,
    pad_top_at_rest: f32,
    panel_pointer: (Option<Pos2>, bool),
}

impl std::fmt::Debug for LayerWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "LayerWorld")
    }
}

impl Default for LayerWorld {
    fn default() -> Self {
        Self {
            ctx: Context::default(),
            rack: WindowSpec::default(),
            rack_open: true,
            analyzer: None,
            pointer: pos2(0.0, 0.0),
            pad_events: Vec::new(),
            rack_button: 0,
            rack_overlap: 0,
            analyzer_button: 0,
            rack_handle_drag: Vec2::ZERO,
            panel_handle_drag: Vec2::ZERO,
            pad_rects: Vec::new(),
            pad_top_at_rest: 0.0,
            panel_pointer: (None, false),
        }
    }
}

fn pads() -> Vec<Pad> {
    (1..=4)
        .map(|i| {
            let mut p = Pad::new(format!("pad-{i}"), format!("Pad {i}"), Color32::from_rgb(60, 140, 230));
            p.kind = PadKind::Synth;
            p
        })
        .collect()
}

fn event_text(e: &PadEvent) -> String {
    match e {
        PadEvent::Clicked(id) => format!("Clicked({id})"),
        PadEvent::Cleared(id) => format!("Cleared({id})"),
        PadEvent::AddRequested => "AddRequested".into(),
    }
}

impl LayerWorld {
    /// One whole frame: the panel first, then the windows, in call order like the engine.
    fn frame(&mut self, pointer: PointerState, scroll: f32) {
        let raw = RawInput {
            screen_rect: Rect::from_min_size(pos2(0.0, 0.0), vec2(SCREEN.0, SCREEN.1)),
            pixels_per_point: 1.0,
            pointer,
            scroll_delta: vec2(0.0, scroll),
            dt: 1.0 / 60.0,
            ..Default::default()
        };
        let ctx = self.ctx.clone();
        let pad_list = pads();
        let (rack_pos, rack_size) = (self.rack.pos, self.rack.size);
        let analyzer = self.analyzer.as_ref().map(|a| (a.pos, a.size));
        let mut open = self.rack_open;

        let mut events = Vec::new();
        let mut rects = Vec::new();
        let mut panel_drag = Vec2::ZERO;
        let mut panel_pointer = (None, false);
        let (mut rack_button, mut rack_overlap, mut analyzer_button) = (0u32, 0u32, 0u32);
        let mut rack_drag = Vec2::ZERO;

        ctx.run(raw, |ctx| {
            CentralPanel::default().show(ctx, |ui| {
                ScrollArea::vertical().show(ui, |ui| {
                    let r = PadGrid::new("grid").options(PadGridOptions::default()).show(ui, &pad_list);
                    events.extend(r.events.iter().map(event_text));
                    rects.extend(r.rects.iter().map(|(_, rc)| *rc));
                    ui.allocate_space(vec2(10.0, 2000.0));
                });
                let h = ui.interact(panel_handle(), Id::new("panel-handle"), Sense::drag());
                if h.dragged() {
                    panel_drag += h.drag_delta();
                }
                panel_pointer = ui.input(|i| (i.pointer.pos, i.pointer.primary_down));
            });

            Window::new("Rack").id(Id::new("rack")).default_pos(rack_pos).default_size(rack_size).open(&mut open).show(ctx, |ui| {
                if ui.interact(rect(180.0, 56.0, 260.0, 84.0), Id::new("rack-button"), Sense::click()).clicked() {
                    rack_button += 1;
                }
                let handle = ui.interact(rect(200.0, 150.0, 280.0, 190.0), Id::new("rack-handle"), Sense::drag());
                if handle.dragged() {
                    rack_drag += handle.drag_delta();
                }
                if ui.interact(rect(300.0, 190.0, 350.0, 230.0), Id::new("rack-overlap"), Sense::click()).clicked() {
                    rack_overlap += 1;
                }
            });

            if let Some((pos, size)) = analyzer {
                Window::new("Analyzer").id(Id::new("analyzer")).default_pos(pos).default_size(size).show(ctx, |ui| {
                    if ui.interact(rect(310.0, 200.0, 340.0, 220.0), Id::new("analyzer-button"), Sense::click()).clicked() {
                        analyzer_button += 1;
                    }
                });
            }
        });

        self.rack_open = open;
        self.pad_events.extend(events);
        self.pad_rects = rects;
        self.panel_pointer = panel_pointer;
        self.panel_handle_drag += panel_drag;
        self.rack_handle_drag += rack_drag;
        self.rack_button += rack_button;
        self.rack_overlap += rack_overlap;
        self.analyzer_button += analyzer_button;
    }

    fn idle(&mut self) {
        self.frame(PointerState { pos: Some(self.pointer), ..Default::default() }, 0.0);
    }

    fn hover(&mut self, p: Pos2) {
        self.pointer = p;
        self.idle();
    }

    fn press(&mut self, p: Pos2) {
        self.hover(p);
        self.frame(PointerState { pos: Some(p), primary_pressed: true, primary_down: true, ..Default::default() }, 0.0);
    }

    fn drag_to(&mut self, to: Pos2) {
        let from = self.pointer;
        for step in 1..=4 {
            let t = step as f32 / 4.0;
            let p = pos2(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
            self.frame(PointerState { pos: Some(p), primary_down: true, ..Default::default() }, 0.0);
            self.pointer = p;
        }
    }

    fn release(&mut self) {
        self.frame(PointerState { pos: Some(self.pointer), primary_released: true, ..Default::default() }, 0.0);
    }

    fn click(&mut self, p: Pos2) {
        self.press(p);
        self.release();
    }

    /// Frames until the windows' footprints from the previous frame are in place, the way a
    /// running app has them long before anyone clicks.
    fn settle(&mut self) {
        self.pointer = pos2(700.0, 500.0);
        for _ in 0..3 {
            self.idle();
        }
        self.pad_top_at_rest = self.pad_rects[0].min.y;
    }

    fn window_rect(spec: &WindowSpec) -> Rect {
        Rect::from_min_size(pos2(spec.pos[0], spec.pos[1]), vec2(spec.size[0], spec.size[1]))
    }
}

// ------------------------------------------------------------------------------------------

#[given(expr = "a pad grid under a window {string} at {int},{int} sized {int} by {int}")]
fn grid_and_window(world: &mut LayerWorld, _name: String, x: i32, y: i32, w: i32, h: i32) {
    world.rack = WindowSpec { pos: [x as f32, y as f32], size: [w as f32, h as f32] };
    world.settle();
    // The scenarios depend on pad 2 sitting partly under the window and pad 4 clear of it.
    let win = LayerWorld::window_rect(&world.rack);
    let pad2 = world.pad_rects[1];
    for p in [pos2(200.0, 70.0), pos2(150.0, 60.0), pos2(150.0, 34.0)] {
        assert!(pad2.contains(p) && win.contains(p), "{p:?} must be over both pad 2 ({pad2:?}) and the window ({win:?})");
    }
    let close = pos2(win.max.x - 14.0, win.min.y + 14.0);
    assert!(world.pad_rects[2].contains(close), "the close button {close:?} must sit over pad 3 {:?}", world.pad_rects[2]);
    assert!(!win.intersect(world.pad_rects[3]).is_positive(), "pad 4 {:?} must be clear of the window {win:?}", world.pad_rects[3]);
}

#[given(expr = "a second window {string} at {int},{int} sized {int} by {int}")]
fn second_window(world: &mut LayerWorld, _name: String, x: i32, y: i32, w: i32, h: i32) {
    world.analyzer = Some(WindowSpec { pos: [x as f32, y as f32], size: [w as f32, h as f32] });
    world.settle();
}

#[when(expr = "I click the centre of pad {int}")]
fn click_pad(world: &mut LayerWorld, n: usize) {
    let c = world.pad_rects[n - 1].center();
    world.click(c);
}

#[when(expr = "I click at {int},{int}")]
fn click_at(world: &mut LayerWorld, x: i32, y: i32) {
    world.click(pos2(x as f32, y as f32));
}

#[when(expr = "the pointer hovers at {int},{int}")]
fn hover_at(world: &mut LayerWorld, x: i32, y: i32) {
    world.hover(pos2(x as f32, y as f32));
}

#[when(expr = "I press at {int},{int}")]
fn press_at(world: &mut LayerWorld, x: i32, y: i32) {
    world.press(pos2(x as f32, y as f32));
}

#[when(expr = "I drag to {int},{int} holding the button")]
fn drag_to(world: &mut LayerWorld, x: i32, y: i32) {
    world.drag_to(pos2(x as f32, y as f32));
}

#[when("I release the button")]
fn release(world: &mut LayerWorld) {
    world.release();
}

#[when(expr = "I scroll by {int} at {int},{int}")]
fn scroll_at(world: &mut LayerWorld, dy: i32, x: i32, y: i32) {
    let p = pos2(x as f32, y as f32);
    world.hover(p);
    world.frame(PointerState { pos: Some(p), ..Default::default() }, dy as f32);
}

#[when("I click the close button of the window")]
fn click_close(world: &mut LayerWorld) {
    let win = LayerWorld::window_rect(&world.rack);
    world.click(pos2(win.max.x - 14.0, win.min.y + 14.0));
    assert!(!world.rack_open, "the close button did not close the window");
}

// ------------------------------------------------------------------------------------------

#[then(expr = "the pad events are {string}")]
fn pad_events(world: &mut LayerWorld, expected: String) {
    assert_eq!(world.pad_events.join(","), expected);
}

#[then("the Rack button was clicked")]
fn rack_button_clicked(world: &mut LayerWorld) {
    assert_eq!(world.rack_button, 1);
}

#[then("the Rack button was not clicked")]
fn rack_button_not_clicked(world: &mut LayerWorld) {
    assert_eq!(world.rack_button, 0);
}

#[then("the Rack overlap button was not clicked")]
fn rack_overlap_not_clicked(world: &mut LayerWorld) {
    assert_eq!(world.rack_overlap, 0);
}

#[then("the Analyzer button was clicked")]
fn analyzer_clicked(world: &mut LayerWorld) {
    assert_eq!(world.analyzer_button, 1);
}

#[then("the pointer is over the UI")]
fn over_ui(world: &mut LayerWorld) {
    assert!(world.ctx.pointer_over_ui());
}

#[then(expr = "the pad grid has moved {int} pixels")]
fn grid_moved(world: &mut LayerWorld, px: i32) {
    let moved = world.pad_top_at_rest - world.pad_rects[0].min.y;
    assert!((moved - px as f32).abs() < 0.5, "moved {moved}, expected {px}");
}

fn assert_vec(got: Vec2, x: i32, y: i32) {
    assert!((got.x - x as f32).abs() < 0.5 && (got.y - y as f32).abs() < 0.5, "got {got:?}, expected ({x}, {y})");
}

#[then(expr = "the Rack handle was dragged by {int},{int}")]
fn rack_handle_dragged(world: &mut LayerWorld, x: i32, y: i32) {
    assert_vec(world.rack_handle_drag, x, y);
}

#[then(expr = "the panel handle was dragged by {int},{int}")]
fn panel_handle_dragged(world: &mut LayerWorld, x: i32, y: i32) {
    assert_vec(world.panel_handle_drag, x, y);
}

#[then("the panel handle saw no drag")]
fn panel_handle_no_drag(world: &mut LayerWorld) {
    assert_vec(world.panel_handle_drag, 0, 0);
}

#[then("the panel sees no pointer and no held button")]
fn panel_blind(world: &mut LayerWorld) {
    assert_eq!(world.panel_pointer, (None, false));
}

fn main() {
    futures::executor::block_on(LayerWorld::cucumber().max_concurrent_scenarios(1).fail_on_skipped().run_and_exit("tests/features/window_layers.feature"));
}
