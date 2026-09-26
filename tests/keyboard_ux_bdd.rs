//! Headless tier for the kit-wide UX pass: keyboard focus and traversal, knob/numeric input,
//! scrolling, tooltips and toasts. `tests/features/keyboard_ux.feature` drives the real widgets
//! through a headless `entropy_gui::Context` one frame at a time, with synthetic keys, text and
//! pointer input, and `tests/common/raster.rs` rasterizes the frames the look assertions check.
//! Pictures land in `test-artifacts/keyboard_ux/`.

use cucumber::{given, then, when, World as _};
use entropy_engine::entropy_gui::context::{KeyEvent, Modifiers, PointerState};
use entropy_engine::entropy_gui::draw_list::DrawCommand;
use entropy_engine::entropy_gui::geometry::{pos2, vec2, Align, Layout, Pos2, Rect};
use entropy_engine::entropy_gui::id::Id;
use entropy_engine::entropy_gui::{Button, CentralPanel, ComboBox, Key, Knob, ScrollArea, Sense, Toast, ToastEvent, ToastKind, UiPrefs, Window};
use std::collections::HashMap;

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

const W: usize = 480;
const H: usize = 360;
const WAVES: [&str; 3] = ["Sine", "Square", "Saw"];

#[derive(cucumber::World)]
struct UxWorld {
    h: Harness,
    // The app's own state, as a real addon would keep it.
    loop_on: bool,
    name: String,
    wave: usize,
    cutoff: f32,
    settings_open: bool,
    activations: HashMap<String, usize>,
    toast_events: Vec<ToastEvent>,
    // What the last frame drew.
    ids: HashMap<String, Id>,
    rects: HashMap<String, Rect>,
    list_rect: Rect,
    pending: Vec<DrawCommand>,
    pointer: Option<Pos2>,
}

impl std::fmt::Debug for UxWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "UxWorld(cutoff={}, wave={}, name={:?})", self.cutoff, self.wave, self.name)
    }
}

impl Default for UxWorld {
    fn default() -> Self {
        Self {
            h: Harness::new(W, H),
            loop_on: false,
            name: String::new(),
            wave: 0,
            cutoff: 1000.0,
            settings_open: false,
            activations: HashMap::new(),
            toast_events: Vec::new(),
            ids: HashMap::new(),
            rects: HashMap::new(),
            list_rect: Rect::NOTHING,
            pending: Vec::new(),
            pointer: None,
        }
    }
}

struct FrameInput {
    pointer: PointerState,
    modifiers: Modifiers,
    keys: Vec<KeyEvent>,
    text: String,
    scroll_y: f32,
    /// The scroll came from a notched mouse wheel.
    lines: bool,
}

impl FrameInput {
    fn idle(pointer: Option<Pos2>) -> Self {
        Self { pointer: PointerState { pos: pointer, ..Default::default() }, modifiers: Modifiers::default(), keys: Vec::new(), text: String::new(), scroll_y: 0.0, lines: false }
    }
}

impl UxWorld {
    fn frame(&mut self, input: FrameInput) {
        let mut raw = self.h.raw_input(input.pointer, input.modifiers);
        raw.key_events = input.keys;
        raw.text_input = input.text;
        raw.scroll_delta = vec2(0.0, input.scroll_y);
        raw.scroll_in_lines = input.lines;

        let mut ids = HashMap::new();
        let mut rects = HashMap::new();
        let mut list_rect = Rect::NOTHING;
        let mut activated: Vec<String> = Vec::new();
        let (mut loop_on, mut name, mut wave, mut cutoff, mut settings_open) = (self.loop_on, self.name.clone(), self.wave, self.cutoff, self.settings_open);

        self.pending = self.h.run_raw(raw, |ctx| {
            let mut note = |label: &str, r: &entropy_engine::entropy_gui::Response| {
                ids.insert(label.to_string(), r.id);
                rects.insert(label.to_string(), r.rect);
            };
            CentralPanel::default().show(ctx, |ui| {
                let r = ui.add(Button::new("Play")).on_hover_text_with_shortcut("Play", "Space");
                note("Play", &r);
                if r.clicked() {
                    activated.push("Play".into());
                }
                let r = ui.add(Button::new("Stop")).on_hover_text_with_shortcut("Stop", "Esc");
                note("Stop", &r);
                if r.clicked() {
                    activated.push("Stop".into());
                }
                let r = ui.checkbox(&mut loop_on, "Loop");
                note("Loop", &r);
                let r = ui.text_edit_singleline_sized(&mut name, 160.0, Id::new("name-field"));
                note("Name", &r);
                let r = ComboBox::from_id_source("wave").selected_text(WAVES[wave]).show_ui(ui, |ui| {
                    for (i, w) in WAVES.iter().enumerate() {
                        let r = ui.selectable_value(&mut wave, i, *w);
                        note(w, &r);
                    }
                });
                note("Wave", &r);
                let r = ui.add(Knob::new(&mut cutoff, 20.0..=20000.0).text("Cutoff").unit("Hz").default_value(1000.0));
                note("Cutoff", &r);
                let r = ui.add(Button::new("Open settings"));
                note("Open settings", &r);
                if r.clicked() {
                    settings_open = true;
                }
                let (rect, _) = ui.allocate_exact_size(vec2(200.0, 80.0), Sense::hover());
                list_rect = rect;
                let mut child = ui.child_ui_at(rect, Layout::top_down(Align::Min), "list");
                ScrollArea::vertical().show(&mut child, |ui| {
                    for i in 1..=20 {
                        let label = format!("Row {i}");
                        let r = ui.add(Button::new(label.as_str()));
                        note(&label, &r);
                    }
                });
            });
            Window::new("Settings").default_pos([260.0, 40.0]).default_size([200.0, 150.0]).open(&mut settings_open).show(ctx, |ui| {
                let r = ui.add(Button::new("Apply"));
                note("Apply", &r);
                let r = ui.add(Button::new("Reset"));
                note("Reset", &r);
            });
        });
        self.toast_events.extend(self.h.ctx.take_toast_events());
        for a in activated {
            *self.activations.entry(a).or_default() += 1;
        }
        self.ids = ids;
        self.rects = rects;
        self.list_rect = list_rect;
        (self.loop_on, self.name, self.wave, self.cutoff, self.settings_open) = (loop_on, name, wave, cutoff, settings_open);
    }

    fn idle(&mut self) {
        self.frame(FrameInput::idle(self.pointer));
    }

    fn key(&mut self, key: Key, modifiers: Modifiers) {
        let mut input = FrameInput::idle(self.pointer);
        input.modifiers = modifiers;
        input.keys = vec![KeyEvent { key, pressed: true, modifiers }, KeyEvent { key, pressed: false, modifiers }];
        self.frame(input);
        // One more frame, so whatever the key changed (focus moves at the end of a frame) is drawn.
        self.idle();
    }

    fn press_release(&mut self, at: Pos2, modifiers: Modifiers) {
        self.pointer = Some(at);
        let mut down = FrameInput::idle(self.pointer);
        down.modifiers = modifiers;
        down.pointer.primary_down = true;
        down.pointer.primary_pressed = true;
        self.frame(down);
        let mut up = FrameInput::idle(self.pointer);
        up.modifiers = modifiers;
        up.pointer.primary_released = true;
        self.frame(up);
    }

    fn rect(&self, label: &str) -> Rect {
        *self.rects.get(label).unwrap_or_else(|| panic!("{label:?} was not drawn last frame; drawn: {:?}", self.rects.keys()))
    }

    fn focused_label(&self) -> Option<String> {
        let focused = self.h.ctx.memory(|m| m.focused)?;
        self.ids.iter().find(|(_, id)| **id == focused).map(|(l, _)| l.clone())
    }

    fn list_offset(&self) -> f32 {
        self.list_rect.min.y + 0.0 - self.rect("Row 1").min.y
    }

    fn picture(&self) -> image::RgbaImage {
        self.h.render(&self.pending)
    }

    fn accent(&self) -> [u8; 3] {
        let c = self.h.ctx.style().visuals.selection.stroke.color;
        [c.r(), c.g(), c.b()]
    }
}

fn shift() -> Modifiers {
    Modifiers { shift: true, ..Default::default() }
}

fn artifacts_dir() -> std::path::PathBuf {
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("keyboard_ux");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn named_key(name: &str) -> Key {
    match name {
        "Tab" => Key::Tab,
        "Enter" => Key::Enter,
        "Space" => Key::Space,
        "Escape" => Key::Escape,
        "Up" => Key::ArrowUp,
        "Down" => Key::ArrowDown,
        "Left" => Key::ArrowLeft,
        "Right" => Key::ArrowRight,
        "Home" => Key::Home,
        "End" => Key::End,
        "Delete" => Key::Delete,
        "Page Down" => Key::PageDown,
        "Page Up" => Key::PageUp,
        "F6" => Key::F6,
        other => panic!("unknown key {other:?}"),
    }
}

// ------------------------------------------------------------------------------------------
// Steps
// ------------------------------------------------------------------------------------------

#[given("the form is on screen")]
fn form(world: &mut UxWorld) {
    world.idle();
    world.idle();
}

#[given("motion is reduced")]
fn reduced(world: &mut UxWorld) {
    world.h.ctx.set_prefs(UiPrefs { reduce_motion: true, ..world.h.ctx.prefs() });
}

#[when(regex = r"^I press (Shift\+)?(Tab|Enter|Space|Escape|Up|Down|Left|Right|Home|End|Delete|Page Down|Page Up|F6)$")]
fn press(world: &mut UxWorld, shifted: String, key: String) {
    let mods = if shifted.is_empty() { Modifiers::default() } else { shift() };
    world.key(named_key(&key), mods);
}

#[when(expr = "I tab to {string}")]
fn tab_to(world: &mut UxWorld, label: String) {
    for _ in 0..60 {
        if world.focused_label().as_deref() == Some(label.as_str()) {
            return;
        }
        world.key(Key::Tab, Modifiers::default());
    }
    panic!("Tab never reached {label:?}");
}

#[when(expr = "I type {string}")]
fn type_text(world: &mut UxWorld, text: String) {
    let mut input = FrameInput::idle(world.pointer);
    input.text = text;
    world.frame(input);
    world.idle();
}

#[when(expr = "I click {string}")]
fn click(world: &mut UxWorld, label: String) {
    let at = world.rect(&label).center();
    world.press_release(at, Modifiers::default());
    world.idle();
}

#[when("I click empty space")]
fn click_empty(world: &mut UxWorld) {
    world.press_release(pos2(470.0, 300.0), Modifiers::default());
    world.idle();
}

#[when(expr = "I double-click {string}")]
fn double_click(world: &mut UxWorld, label: String) {
    let at = world.rect(&label).center();
    world.press_release(at, Modifiers::default());
    world.press_release(at, Modifiers::default());
    world.idle();
}

#[when(expr = "I ctrl-click {string}")]
fn ctrl_click(world: &mut UxWorld, label: String) {
    let at = world.rect(&label).center();
    world.press_release(at, Modifiers { ctrl: true, ..Default::default() });
    world.idle();
}

fn drag(world: &mut UxWorld, from: Pos2, dy: f32, modifiers: Modifiers) {
    // Well clear of any earlier click, so the press is not read as a double-click.
    for _ in 0..30 {
        world.idle();
    }
    world.pointer = Some(from);
    let mut down = FrameInput::idle(world.pointer);
    down.modifiers = modifiers;
    down.pointer.primary_down = true;
    down.pointer.primary_pressed = true;
    world.frame(down);
    let steps = 6;
    for i in 1..=steps {
        let p = pos2(from.x, from.y + dy * i as f32 / steps as f32);
        world.pointer = Some(p);
        let mut mv = FrameInput::idle(world.pointer);
        mv.modifiers = modifiers;
        mv.pointer.primary_down = true;
        world.frame(mv);
    }
    let mut up = FrameInput::idle(world.pointer);
    up.modifiers = modifiers;
    up.pointer.primary_released = true;
    world.frame(up);
    world.pointer = None;
    world.idle();
}

#[when(regex = r#"^I drag "([^"]+)" up (\d+) points( holding Shift)?$"#)]
fn drag_up(world: &mut UxWorld, label: String, points: f32, shifted: String) {
    let from = world.rect(&label).center();
    let mods = if shifted.is_empty() { Modifiers::default() } else { shift() };
    drag(world, from, -points, mods);
}

#[when(expr = "I drag the list's scrollbar thumb down {float} points")]
fn drag_thumb(world: &mut UxWorld, points: f32) {
    // A frame first, so the list knows it overflows and draws its scrollbar.
    world.idle();
    let from = pos2(world.list_rect.max.x - 5.0, world.list_rect.min.y + 6.0);
    drag(world, from, points, Modifiers::default());
}

#[when(expr = "I advance {int} frame(s)")]
fn advance(world: &mut UxWorld, n: usize) {
    for _ in 0..n {
        world.idle();
    }
}

#[when("I rest the pointer on the list")]
fn rest_on_list(world: &mut UxWorld) {
    world.pointer = Some(pos2(world.list_rect.min.x + 60.0, world.list_rect.center().y));
    world.idle();
}

#[when(expr = "I scroll the wheel down {float} points")]
fn wheel(world: &mut UxWorld, points: f32) {
    let mut input = FrameInput::idle(world.pointer);
    input.scroll_y = -points;
    input.lines = true;
    world.frame(input);
}

#[when(expr = "I rest the pointer on {string} for {int} frame(s)")]
fn rest_on(world: &mut UxWorld, label: String, frames: usize) {
    world.pointer = Some(world.rect(&label).center());
    for _ in 0..frames {
        world.idle();
    }
}

#[when(expr = "a {string} toast says {string} for {int} second(s)")]
fn toast_for(world: &mut UxWorld, kind: String, message: String, seconds: u32) {
    world.h.ctx.show_toast(Toast::new(message.clone(), message).kind(ToastKind::parse(&kind)).duration(Some(seconds as f32)));
}

#[when(expr = "an {string} toast says {string} with the action {string}")]
fn toast_action(world: &mut UxWorld, kind: String, message: String, action: String) {
    world.h.ctx.show_toast(Toast::new(message.clone(), message).kind(ToastKind::parse(&kind)).action(action).duration(None));
}

#[when(expr = "a progress toast {string} is at {float}")]
fn toast_progress(world: &mut UxWorld, message: String, progress: f32) {
    world.h.ctx.show_toast(Toast::new("progress", message).progress(progress).duration(None));
}

#[when(expr = "I click the toast button {string}")]
fn click_toast_button(world: &mut UxWorld, _label: String) {
    let layout = world.h.ctx.toast_layout();
    let action = layout.iter().find_map(|(_, _, a)| *a).expect("a toast with an action button is on screen");
    world.press_release(action.center(), Modifiers::default());
    world.idle();
}

#[when(expr = "I rest the pointer on the toast {string} for {int} frames")]
fn rest_on_toast(world: &mut UxWorld, id: String, frames: usize) {
    world.idle();
    let card = world.h.ctx.toast_layout().into_iter().find(|(i, _, _)| *i == id).map(|(_, r, _)| r).expect("the toast is on screen");
    world.pointer = Some(pos2(card.min.x + 40.0, card.center().y));
    for _ in 0..frames {
        world.idle();
    }
}

#[then(expr = "{string} has keyboard focus")]
fn has_focus(world: &mut UxWorld, label: String) {
    assert_eq!(world.focused_label().as_deref(), Some(label.as_str()));
}

#[then("nothing has keyboard focus")]
fn no_focus(world: &mut UxWorld) {
    assert_eq!(world.h.ctx.memory(|m| m.focused), None, "focused: {:?}", world.focused_label());
}

#[then(expr = "{string} was activated {int} time(s)")]
fn activated(world: &mut UxWorld, label: String, n: usize) {
    assert_eq!(world.activations.get(&label).copied().unwrap_or(0), n);
}

#[then("the Loop checkbox is on")]
fn loop_on(world: &mut UxWorld) {
    assert!(world.loop_on);
}

fn ring_pixel_is_accent(world: &UxWorld, label: &str) -> bool {
    let img = world.picture();
    let r = world.rect(label);
    let accent = world.accent();
    // The middle of the ring's top edge, 2 points above the widget.
    let (x, y) = (r.center().x as u32, (r.min.y - 2.0) as u32);
    let p = img.get_pixel(x, y);
    let d: i32 = (0..3).map(|i| (p[i] as i32 - accent[i] as i32).abs()).sum();
    d < 90
}

#[then(expr = "a focus ring is drawn around {string}")]
fn ring(world: &mut UxWorld, label: String) {
    assert!(ring_pixel_is_accent(world, &label), "no accent-coloured ring above {label}");
}

#[then(expr = "no focus ring is drawn around {string}")]
fn no_ring(world: &mut UxWorld, label: String) {
    assert!(!ring_pixel_is_accent(world, &label), "a ring was drawn above {label} for a pointer click");
}

#[then("the GUI wants the keyboard for typing")]
fn wants_keyboard(world: &mut UxWorld) {
    assert!(world.h.ctx.wants_keyboard_input());
}

#[then("the GUI does not want the keyboard for typing")]
fn not_wants_keyboard(world: &mut UxWorld) {
    assert!(!world.h.ctx.wants_keyboard_input());
}

#[then(expr = "the Name field reads {string}")]
fn name_reads(world: &mut UxWorld, text: String) {
    assert_eq!(world.name, text);
}

#[then(expr = "the {string} dropdown is open")]
fn dropdown_open(world: &mut UxWorld, _label: String) {
    assert!(world.h.ctx.memory(|m| m.popup_open).is_some());
}

#[then(expr = "the {string} dropdown is closed")]
fn dropdown_closed(world: &mut UxWorld, _label: String) {
    assert!(world.h.ctx.memory(|m| m.popup_open).is_none());
}

#[then(expr = "the Wave is {string}")]
fn wave_is(world: &mut UxWorld, wave: String) {
    assert_eq!(WAVES[world.wave], wave);
}

#[then("the Settings window is open")]
fn settings_open(world: &mut UxWorld) {
    assert!(world.settings_open);
}

#[then("the Settings window is closed")]
fn settings_closed(world: &mut UxWorld) {
    assert!(!world.settings_open);
}

#[then(expr = "the Cutoff is {float}")]
fn cutoff_is(world: &mut UxWorld, v: f32) {
    assert!((world.cutoff - v).abs() < 0.05, "cutoff is {} not {v}", world.cutoff);
}

#[then(expr = "{string} is outside the list's visible area")]
fn outside(world: &mut UxWorld, label: String) {
    let r = world.rect(&label);
    assert!(r.min.y >= world.list_rect.max.y || r.max.y <= world.list_rect.min.y, "{label} at {r:?} is inside {:?}", world.list_rect);
}

#[then(expr = "{string} is inside the list's visible area")]
fn inside(world: &mut UxWorld, label: String) {
    let r = world.rect(&label);
    assert!(r.min.y >= world.list_rect.min.y && r.max.y <= world.list_rect.max.y, "{label} at {r:?} is not inside {:?}", world.list_rect);
}

#[then(expr = "the list has scrolled down between {float} and {float} points")]
fn scrolled_between(world: &mut UxWorld, lo: f32, hi: f32) {
    let off = world.list_offset();
    assert!(off >= lo && off <= hi, "scrolled {off}");
}

#[then(expr = "the list has scrolled down more than {float} points")]
fn scrolled_more(world: &mut UxWorld, lo: f32) {
    let off = world.list_offset();
    assert!(off > lo, "scrolled {off}");
}

#[then("no tooltip is shown")]
fn no_tooltip(world: &mut UxWorld) {
    assert_eq!(world.h.ctx.shown_tooltip(), None);
}

#[then(expr = "the tooltip {string} is shown")]
fn tooltip_shown(world: &mut UxWorld, text: String) {
    let shown = world.h.ctx.shown_tooltip().unwrap_or_default();
    assert!(shown.contains(&text), "tooltip is {shown:?}");
}

#[then(expr = "the toast {string} is on screen")]
fn toast_on(world: &mut UxWorld, message: String) {
    assert!(world.h.ctx.toasts().iter().any(|t| t.message == message));
}

#[then(expr = "the toast {string} is gone")]
fn toast_gone(world: &mut UxWorld, message: String) {
    assert!(!world.h.ctx.toasts().iter().any(|t| t.message == message));
}

#[then(expr = "the toast action for {string} was reported")]
fn toast_reported(world: &mut UxWorld, id: String) {
    assert!(world.toast_events.contains(&ToastEvent::Action(id)), "{:?}", world.toast_events);
}

#[then(expr = "there is {int} toast on screen")]
fn toast_count(world: &mut UxWorld, n: usize) {
    assert_eq!(world.h.ctx.toasts().len(), n);
}

#[then(expr = "I save the picture {string}")]
fn save_picture(world: &mut UxWorld, name: String) {
    world.picture().save(artifacts_dir().join(format!("{name}.png"))).unwrap();
}

fn main() {
    futures::executor::block_on(
        UxWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/keyboard_ux.feature"),
    );
}
