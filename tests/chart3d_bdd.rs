//! Headless tier for `entropy_gui::Chart3dView`.
//!
//! `tests/features/chart3d.feature` runs against the real widget inside a headless
//! `entropy_gui::Context`, one frame at a time. Pointer input is built the way the
//! window backend builds it (hover frames, press frames, drag frames, release frames).
//! What is drawn is rasterized on the CPU (`tests/common/raster.rs`), verifying pixels
//! and interaction facts. Pictures land in `test-artifacts/chart3d/`.

use std::path::PathBuf;

use cucumber::{given, then, when, World as _};
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::draw_list::DrawCommand;
use entropy_engine::entropy_gui::geometry::{pos2, Pos2};
use entropy_engine::entropy_gui::{
    Chart3dEvent, Chart3dOptions, Chart3dProjector, Chart3dResponse, Chart3dSeries, Chart3dType,
    Chart3dView,
};
use image::RgbaImage;

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

fn artifacts_dir() -> PathBuf {
    let dir = PathBuf::from("test-artifacts/chart3d");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[derive(cucumber::World)]
struct Chart3dWorld {
    h: Harness,
    series: Vec<Chart3dSeries>,
    opts: Chart3dOptions,
    resp: Option<Chart3dResponse>,
    events: Vec<Chart3dEvent>,
    pending: Vec<DrawCommand>,
    image: Option<RgbaImage>,
    primary: bool,
    pos: Option<Pos2>,
    camera_before: Option<(f32, f32, f32)>, // yaw, pitch, zoom
}

impl std::fmt::Debug for Chart3dWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Chart3dWorld({} series)", self.series.len())
    }
}

impl Default for Chart3dWorld {
    fn default() -> Self {
        Self {
            h: Harness::new(960, 680),
            series: Vec::new(),
            opts: Chart3dOptions {
                width: Some(920.0),
                height: 640.0,
                ..Default::default()
            },
            resp: None,
            events: Vec::new(),
            pending: Vec::new(),
            image: None,
            primary: false,
            pos: None,
            camera_before: None,
        }
    }
}

impl Chart3dWorld {
    fn pointer(&self, pos: Option<Pos2>, pressed: bool, released: bool) -> PointerState {
        PointerState {
            pos,
            primary_down: self.primary,
            primary_pressed: pressed,
            primary_released: released,
            ..Default::default()
        }
    }

    fn frame_with(&mut self, pointer: PointerState, scroll: f32) {
        let opts = self.opts.clone();
        let series = self.series.clone();
        let mut out = None;
        self.pending = self.h.run(pointer, scroll, |ui| {
            out = Some(Chart3dView::new("chart").options(opts).show(ui, &series));
        });
        let resp = out.expect("the widget was not drawn");
        for e in &resp.events {
            match e {
                Chart3dEvent::ChartTypeChanged(t) => self.opts.chart_type = *t,
                Chart3dEvent::Hovered { .. } => {}
            }
        }
        self.events.extend(resp.events.iter().cloned());
        self.resp = Some(resp);
        self.image = None;
        self.pos = pointer.pos;
    }

    fn frame(&mut self) {
        let p = self.pointer(self.pos, false, false);
        self.frame_with(p, 0.0);
    }

    fn hover(&mut self, p: Pos2) {
        let s = self.pointer(Some(p), false, false);
        self.frame_with(s, 0.0);
    }

    fn press(&mut self, p: Pos2) {
        self.hover(p);
        self.primary = true;
        let s = self.pointer(Some(p), true, false);
        self.frame_with(s, 0.0);
    }

    fn release(&mut self) {
        self.primary = false;
        let s = self.pointer(self.pos, false, true);
        self.frame_with(s, 0.0);
    }

    fn click(&mut self, p: Pos2) {
        self.press(p);
        self.release();
    }

    fn picture(&mut self) -> RgbaImage {
        if self.image.is_none() {
            if self.pending.is_empty() {
                self.frame();
            }
            self.image = Some(self.h.render(&self.pending));
        }
        self.image.clone().unwrap()
    }
}

// ------------------------------------------------------------------------------------------
// Steps
// ------------------------------------------------------------------------------------------

#[given("a 3D chart with 3 series and 4 categories")]
fn given_chart_3_series(world: &mut Chart3dWorld) {
    world.series = vec![
        Chart3dSeries::new("SaaS", vec![120.0, 145.0, 180.0, 215.0]),
        Chart3dSeries::new("Hardware", vec![95.0, 80.0, 110.0, 140.0]),
        Chart3dSeries::new("Services", vec![60.0, 75.0, 70.0, 95.0]),
    ];
    world.opts.x_labels = vec!["Q1".into(), "Q2".into(), "Q3".into(), "Q4".into()];
    world.opts.title = Some("Quarterly Breakdown".into());
}

#[given(regex = r#"^the chart type is "(Surface|Bar|Ribbon)"$"#)]
fn given_chart_type(world: &mut Chart3dWorld, chart_type: String) {
    world.opts.chart_type = Chart3dType::from_name(&chart_type).unwrap();
}

#[when("a frame is drawn")]
fn when_frame_drawn(world: &mut Chart3dWorld) {
    world.frame();
}

#[then("the chart space is not blank")]
fn then_not_blank(world: &mut Chart3dWorld) {
    let img = world.picture();
    let (w, h) = (img.width(), img.height());
    // Sample inner chart pixels, ensuring that some are drawn differently from the dark background
    let mut different = 0;
    for y in (h / 4)..(h * 3 / 4) {
        for x in (w / 4)..(w * 3 / 4) {
            let p = img.get_pixel(x, y);
            // Non-black / non-dark background
            if p[0] > 30 || p[1] > 40 || p[2] > 60 {
                different += 1;
            }
        }
    }
    assert!(different > 500, "chart space had only {different} lit pixels");
}

#[then("there is neon teal in the chart")]
fn then_neon_teal(world: &mut Chart3dWorld) {
    let img = world.picture();
    let mut teals = 0;
    for p in img.pixels() {
        // Teal has strong G and B, lower R: e.g. [70, 230, 214]
        if p[1] > 140 && p[2] > 130 && p[0] < p[1] - 40 {
            teals += 1;
        }
    }
    assert!(teals > 50, "expected neon teal pixels, found {teals}");
}

#[when(regex = r"^I drag the pointer by (-?\d+) pixels horizontally and (-?\d+) pixels vertically$")]
fn when_drag_pointer(world: &mut Chart3dWorld, dx: i32, dy: i32) {
    world.frame();
    let cam = world.resp.as_ref().unwrap().camera;
    world.camera_before = Some((cam.yaw, cam.pitch, cam.zoom));

    let rect = world.resp.as_ref().unwrap().rect;
    let start = rect.center();

    world.press(start);
    let steps = 5;
    for i in 1..=steps {
        let f = i as f32 / steps as f32;
        world.hover(pos2(start.x + dx as f32 * f, start.y + dy as f32 * f));
    }
    world.release();
}

#[then("the camera turned")]
fn then_camera_turned(world: &mut Chart3dWorld) {
    let (yaw_before, pitch_before, _) = world.camera_before.unwrap();
    let cam = world.resp.as_ref().unwrap().camera;
    assert!(
        (cam.yaw - yaw_before).abs() > 0.1 || (cam.pitch - pitch_before).abs() > 0.05,
        "camera did not turn: before ({yaw_before}, {pitch_before}), after ({}, {})",
        cam.yaw, cam.pitch
    );
}

#[when(regex = r"^I scroll the wheel by (-?\d+) units$")]
fn when_scroll(world: &mut Chart3dWorld, units: i32) {
    world.frame();
    let cam = world.resp.as_ref().unwrap().camera;
    world.camera_before = Some((cam.yaw, cam.pitch, cam.zoom));

    let center = world.resp.as_ref().unwrap().rect.center();
    let p = world.pointer(Some(center), false, false);
    world.frame_with(p, units as f32);
}

#[then("the camera zoom increased")]
fn then_zoom_increased(world: &mut Chart3dWorld) {
    let (_, _, zoom_before) = world.camera_before.unwrap();
    let cam = world.resp.as_ref().unwrap().camera;
    assert!(cam.zoom > zoom_before, "zoom did not increase: before {zoom_before}, after {}", cam.zoom);
}

#[when(regex = r#"^I click the toolbar button "(\w+)"$"#)]
fn when_click_toolbar_button(world: &mut Chart3dWorld, label: String) {
    world.frame();
    let rect = world.resp.as_ref().unwrap().rect;

    // Button position based on toolbar layout
    let p = match label.as_str() {
        "Surface" => pos2(rect.min.x + 35.0, rect.min.y + 19.0),
        "Bar" => pos2(rect.min.x + 85.0, rect.min.y + 19.0),
        "Ribbon" => pos2(rect.min.x + 135.0, rect.min.y + 19.0),
        "Reset" => pos2(rect.max.x - 30.0, rect.min.y + 19.0),
        "Front" => pos2(rect.max.x - 75.0, rect.min.y + 19.0),
        "Top" => pos2(rect.max.x - 120.0, rect.min.y + 19.0),
        "3D" => pos2(rect.max.x - 165.0, rect.min.y + 19.0),
        _ => panic!("unknown toolbar button {label}"),
    };

    world.click(p);
}

#[then("the camera pitch is at maximum")]
fn then_pitch_max(world: &mut Chart3dWorld) {
    let cam = world.resp.as_ref().unwrap().camera;
    assert!(cam.pitch >= 1.40, "pitch is {}", cam.pitch);
}

#[then("the camera pitch is near the floor")]
fn then_pitch_near_floor(world: &mut Chart3dWorld) {
    let cam = world.resp.as_ref().unwrap().camera;
    assert!(cam.pitch <= 0.25, "pitch is {}", cam.pitch);
}

#[then("the camera is at default orientation")]
fn then_camera_default(world: &mut Chart3dWorld) {
    let cam = world.resp.as_ref().unwrap().camera;
    assert!((cam.yaw - 0.45).abs() < 0.05, "yaw is {}", cam.yaw);
    assert!((cam.pitch - 0.55).abs() < 0.05, "pitch is {}", cam.pitch);
}

#[then(regex = r#"^the chart type changed to "(\w+)"$"#)]
fn then_chart_type_changed(world: &mut Chart3dWorld, expected: String) {
    let t = Chart3dType::from_name(&expected).unwrap();
    assert!(
        world.events.contains(&Chart3dEvent::ChartTypeChanged(t)),
        "expected event for {expected}, got {:?}",
        world.events
    );
    assert_eq!(world.opts.chart_type, t);
}

#[when(regex = r"^I hover over series (\d+) category (\d+)$")]
fn when_hover_point(world: &mut Chart3dWorld, s: usize, c: usize) {
    world.frame();
    let rect = world.resp.as_ref().unwrap().rect;
    let cam = world.resp.as_ref().unwrap().camera;
    let proj = Chart3dProjector::new(&cam, rect);

    // Calculate screen position of series s category c
    let num_series = world.series.len();
    let num_x = world.opts.x_labels.len();
    let val = world.series[s].values[c];
    let val_norm = (val / 310.0).clamp(0.0, 1.0);

    let half_w = 2.0 * 0.45;
    let half_d = 1.8 * 0.45;
    let x = -half_w + (c as f32 / (num_x - 1) as f32) * (half_w * 2.0);
    let z = -half_d + (s as f32 / (num_series - 1) as f32) * (half_d * 2.0);
    let y = val_norm * 0.55;

    let pt = proj.project([x, y, z]).map(|(p, _)| p).unwrap_or_else(|| rect.center());
    world.hover(pt);
}

#[then(regex = r#"^a hover tooltip is displayed with series "([^"]+)" and category "([^"]+)"$"#)]
fn then_hover_tooltip(world: &mut Chart3dWorld, expected_series: String, expected_cat: String) {
    let h = world.resp.as_ref().and_then(|r| r.hover.as_ref());
    assert!(h.is_some(), "expected hover info, but got none");
    let h = h.unwrap();
    assert_eq!(h.series_name, expected_series);
    assert_eq!(h.x_label, expected_cat);
}

#[then(regex = r"^the hover value is about (\d+)$")]
fn then_hover_val(world: &mut Chart3dWorld, expected_val: f32) {
    let h = world.resp.as_ref().and_then(|r| r.hover.as_ref()).unwrap();
    assert!(
        (h.value - expected_val).abs() < 5.0,
        "expected value about {expected_val}, got {}",
        h.value
    );
}

#[then(expr = "I save the picture {string}")]
fn then_save_picture(world: &mut Chart3dWorld, name: String) {
    let img = world.picture();
    let path = artifacts_dir().join(format!("{name}.png"));
    img.save(&path).unwrap();
}

fn main() {
    futures::executor::block_on(
        Chart3dWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/chart3d.feature"),
    );
}
