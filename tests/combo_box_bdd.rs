//! Headless tier for `entropy_gui::widgets::ComboBox`'s popup.
//!
//! Before this session the popup was a fixed 180pt panel with no scrolling: a list longer than it
//! still drew every row (clickable), just past the panel's own drawn background, so nothing beyond
//! the fold looked like part of the dropdown. `tests/features/combo_box.feature` proves the popup
//! now really scrolls: a row far past the fold sits outside the popup's own bounds until scrolled,
//! and scrolling brings its real, returned rect inside those bounds where a click reaches it.

use cucumber::{given, then, when, World as _};
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::draw_list::DrawCommand;
use entropy_engine::entropy_gui::geometry::{pos2, vec2, Pos2, Rect};
use entropy_engine::entropy_gui::widgets::ComboBox;

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

#[derive(cucumber::World)]
struct ComboWorld {
    h: Harness,
    items: usize,
    button_rect: Rect,
    popup_rect: Rect,
    item_rects: Vec<Rect>,
    clicked: Vec<usize>,
    pending: Vec<DrawCommand>,
}

impl std::fmt::Debug for ComboWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ComboWorld({} items)", self.items)
    }
}

impl Default for ComboWorld {
    fn default() -> Self {
        Self {
            h: Harness::new(300, 400),
            items: 3,
            button_rect: Rect::NOTHING,
            popup_rect: Rect::NOTHING,
            item_rects: Vec::new(),
            clicked: Vec::new(),
            pending: Vec::new(),
        }
    }
}

impl ComboWorld {
    /// Draws one frame of the combo box with `n` items in its popup, recording each item's real
    /// rect and any that report a click this frame.
    fn frame(&mut self, pointer: PointerState, scroll: f32) {
        let n = self.items;
        let mut rects = vec![Rect::NOTHING; n];
        let mut just_clicked = Vec::new();
        let mut btn_rect = None;
        self.pending = self.h.run(pointer, scroll, |ui| {
            let resp = ComboBox::from_label("Pick").selected_text("Pick one").show_ui(ui, |ui| {
                for i in 0..n {
                    let r = ui.button(format!("Item {i}"));
                    rects[i] = r.rect;
                    if r.clicked() {
                        just_clicked.push(i);
                    }
                }
            });
            btn_rect = Some(resp.rect);
        });
        self.button_rect = btn_rect.expect("the combo box was not drawn");
        self.popup_rect = Rect::from_min_size(
            pos2(self.button_rect.min.x, self.button_rect.max.y + 2.0),
            vec2(self.button_rect.width().max(150.0), 180.0),
        );
        self.item_rects = rects;
        self.clicked.extend(just_clicked);
    }

    fn open_popup(&mut self) {
        self.frame(PointerState::default(), 0.0);
        let center = self.button_rect.center();
        self.frame(PointerState { pos: Some(center), primary_pressed: true, primary_down: true, ..Default::default() }, 0.0);
        self.frame(PointerState { pos: Some(center), primary_released: true, ..Default::default() }, 0.0);
        // The popup toggled open on the press frame above; draw one more settled frame so the
        // caller's next `item_rects` lookup reflects the open popup, not the toggle frame.
        self.frame(PointerState::default(), 0.0);
    }

    fn click_at(&mut self, p: Pos2) {
        self.frame(PointerState { pos: Some(p), ..Default::default() }, 0.0);
        self.frame(PointerState { pos: Some(p), primary_pressed: true, primary_down: true, ..Default::default() }, 0.0);
    }
}

fn artifacts_dir() -> std::path::PathBuf {
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("combo-box");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Whether `r` sits inside `popup`'s vertical span, allowing a few points of slack for the
/// popup's own 4pt content padding (the test's `popup_rect` is the outer panel, not the shrunk
/// content region the real `ScrollArea` clips against).
fn contained_in(popup: Rect, r: Rect) -> bool {
    const SLACK: f32 = 6.0;
    popup.min.y - SLACK <= r.min.y && r.max.y <= popup.max.y + SLACK
}

// ------------------------------------------------------------------------------------------
// Steps
// ------------------------------------------------------------------------------------------

#[given(expr = "a dropdown with {int} items")]
fn a_dropdown(world: &mut ComboWorld, n: usize) {
    world.items = n;
}

#[when("I open the dropdown")]
fn open(world: &mut ComboWorld) {
    world.open_popup();
}

#[when(expr = "I scroll the popup by {int} points")]
fn scroll(world: &mut ComboWorld, points: i32) {
    let p = world.popup_rect.center();
    // The scrolled offset is clamped to content bounds only when it is SAVED at the end of
    // `ScrollArea::show`, not for the layout of the frame that carried the scroll delta itself
    // (a frame that scrolls far past the end briefly lays content out past where it will settle).
    // A second, zero-delta frame reads back the now-clamped stored offset, which is what a real
    // frame after the wheel stops moving would show.
    world.frame(PointerState { pos: Some(p), ..Default::default() }, -(points as f32));
    world.frame(PointerState { pos: Some(p), ..Default::default() }, 0.0);
}

#[when(expr = "I click item {int}")]
fn click_item(world: &mut ComboWorld, i: usize) {
    let r = world.item_rects[i];
    assert_ne!(r, Rect::NOTHING, "item {i} was never drawn");
    world.click_at(r.center());
}

#[then(expr = "item {int} is outside the popup")]
fn outside(world: &mut ComboWorld, i: usize) {
    let r = world.item_rects[i];
    assert_ne!(r, Rect::NOTHING, "item {i} was never drawn");
    assert!(!contained_in(world.popup_rect, r), "item {i} at {r:?} is already inside the popup {:?} with no scroll", world.popup_rect);
}

#[then(expr = "item {int} is inside the popup")]
fn inside(world: &mut ComboWorld, i: usize) {
    let r = world.item_rects[i];
    assert_ne!(r, Rect::NOTHING, "item {i} was never drawn");
    assert!(contained_in(world.popup_rect, r), "item {i} at {r:?} is not inside the popup {:?}", world.popup_rect);
}

#[then(expr = "item {int} was clicked")]
fn was_clicked(world: &mut ComboWorld, i: usize) {
    assert!(world.clicked.contains(&i), "item {i} was not clicked; clicks were {:?}", world.clicked);
}

#[then(expr = "I save the picture {string}")]
fn save_picture(world: &mut ComboWorld, name: String) {
    let img = world.h.render(&world.pending);
    img.save(artifacts_dir().join(format!("{name}.png"))).unwrap();
}

fn main() {
    futures::executor::block_on(
        ComboWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/combo_box.feature"),
    );
}
