//! Headless benchmark for `entropy_gui`'s per-frame CPU cost - the part of every frame that runs
//! on the UI thread before anything reaches the GPU. No window, no wgpu: a plain `Context` is
//! driven through `Context::run` exactly the way `render_tabs` drives it, then drained with
//! `tessellate` (what the wgpu backend uploads).
//!
//! Scenes mirror the two apps used as the reference workloads:
//! - `cc-manager/*`: CC Manager's tab - a header, a separator and the kanban board, at a few
//!   board sizes (cards carry a title, a description and tags, as tasks.json ones do).
//! - `daw/*`: the DAW's main tab - a transport/control strip of buttons, knobs, sliders,
//!   dropdowns and checkboxes over the arrangement `TrackView`, at a few song sizes.
//! - `labels/*`: a wall of plain labels, to isolate text shaping.
//!
//! Each scene reports wall time per frame (avg/p50/p95/max over steady-state frames, after a
//! warm-up that fills the glyph atlas), plus what one frame produces: draw commands (one
//! `draw_indexed` each), vertices and indices.
//!
//! Run with `cargo run --release --bin gui_bench`. Optional first argument filters scenes by
//! substring, e.g. `cargo run --release --bin gui_bench -- kanban`.

use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::{
    pos2, vec2, CentralPanel, Color32, ComboBox, Context, KanbanBoard, KanbanCard, KanbanColumn, Knob, MiniNote, RawInput, Rect,
    ScrollArea, Slider, Track, TrackClip, TrackView, TrackViewOptions,
};
use std::time::Instant;

const WARMUP: usize = 30;
const FRAMES: usize = 400;

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[(((sorted.len() - 1) as f64) * p).round() as usize]
}

struct FrameStats {
    commands: usize,
    vertices: usize,
    indices: usize,
}

fn raw_input(w: f32, h: f32, pointer: Option<(f32, f32)>) -> RawInput {
    RawInput {
        screen_rect: Rect::from_min_size(pos2(0.0, 0.0), vec2(w, h)),
        pixels_per_point: 1.0,
        pointer: PointerState { pos: pointer.map(|(x, y)| pos2(x, y)), ..Default::default() },
        dt: 1.0 / 60.0,
        ..Default::default()
    }
}

/// Runs `scene` for `WARMUP + FRAMES` frames and prints one stats line. The pointer sweeps
/// across the window so hover paths are exercised the way a moving mouse would.
fn bench(filter: &str, name: &str, w: f32, h: f32, mut scene: impl FnMut(&Context)) {
    if !name.contains(filter) {
        return;
    }
    let ctx = Context::default();
    let mut times = Vec::with_capacity(FRAMES);
    let mut last = FrameStats { commands: 0, vertices: 0, indices: 0 };
    for frame in 0..(WARMUP + FRAMES) {
        let t = frame as f32 / (WARMUP + FRAMES) as f32;
        let input = raw_input(w, h, Some((w * t, h * 0.5)));
        let t0 = Instant::now();
        let _ = ctx.run(input, |ctx| scene(ctx));
        let commands = ctx.tessellate((), 1.0);
        let dt = t0.elapsed().as_secs_f64() * 1000.0;
        if frame >= WARMUP {
            times.push(dt);
        }
        last = FrameStats {
            commands: commands.len(),
            vertices: commands.iter().map(|c| c.vertices.len()).sum(),
            indices: commands.iter().map(|c| c.indices.len()).sum(),
        };
        std::hint::black_box(&commands);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let avg = times.iter().sum::<f64>() / times.len() as f64;
    println!(
        "{name:<34} avg {avg:>7.3} ms  p50 {:>7.3}  p95 {:>7.3}  max {:>7.3}  | {:>5} draws {:>7} verts {:>7} idx",
        percentile(&times, 0.50),
        percentile(&times, 0.95),
        times.last().copied().unwrap_or(0.0),
        last.commands,
        last.vertices,
        last.indices,
    );
}

const WORDS: &[&str] = &[
    "render", "the", "arrangement", "view", "without", "reshaping", "every", "label", "on", "each", "frame", "and", "keep", "kanban",
    "cards", "in", "sync", "with", "tasks.json", "after", "a", "Claude", "Code", "session", "edits", "it",
];

fn sentence(seed: usize, words: usize) -> String {
    (0..words).map(|i| WORDS[(seed * 7 + i * 13) % WORDS.len()]).collect::<Vec<_>>().join(" ")
}

fn board(cards_per_column: usize) -> Vec<KanbanColumn> {
    let names = [("backlog", "Backlog"), ("in_progress", "In Progress"), ("review", "Review"), ("done", "Done")];
    names
        .iter()
        .enumerate()
        .map(|(ci, (id, title))| {
            let mut col = KanbanColumn::new(*id, *title);
            for k in 0..cards_per_column {
                let seed = ci * 1000 + k;
                let mut card = KanbanCard::new(format!("{id}-{k}"), sentence(seed, 4 + seed % 6));
                card.description = sentence(seed + 3, 18 + seed % 20);
                card.tags = vec!["entropy-engine".into(), if k % 2 == 0 { "perf".into() } else { "ui".into() }];
                col.cards.push(card);
            }
            col
        })
        .collect()
}

fn song(tracks: usize, clips_per_track: usize) -> Vec<Track> {
    (0..tracks)
        .map(|t| {
            let mut track = Track::new(format!("t{t}"), format!("Track {}", t + 1));
            track.sublabel = "PhysMod Strings".into();
            track.color = Some(Color32::from_rgb(90 + (t * 23 % 120) as u8, 120, 200));
            track.controls = true;
            for c in 0..clips_per_track {
                let mut clip = TrackClip::new(format!("t{t}c{c}"), format!("Pattern {}", c + 1), c as i32 * 4000, 3800, Color32::from_rgb(80, 140, 220));
                clip.loop_ms = 1900;
                clip.notes = (0..16).map(|n| MiniNote { start: n as f32 / 16.0, len: 1.0 / 20.0, y: ((n * 5 + t) % 12) as f32 / 12.0 }).collect();
                if t % 3 == 0 {
                    clip.peaks = (0..128).map(|p| (p as f32 * 0.37).sin() * 0.5 + 0.5).collect();
                }
                track.clips.push(clip);
            }
            track
        })
        .collect()
}

/// The DAW tab's control strip: roughly what `daw_synth_addon.ts` emits above the arrangement
/// (transport buttons, per-instrument knobs/sliders, dropdowns and checkboxes in rows).
fn daw_controls(ui: &mut entropy_engine::entropy_gui::Ui, knobs: &mut [f32], sliders: &mut [f32], checks: &mut [bool]) {
    ui.label("DAW");
    ui.horizontal(|ui| {
        for b in ["Play", "Stop", "Record", "Loop", "Metronome", "New song", "Open", "Save", "Export", "Undo", "Redo"] {
            let _ = ui.button(b);
        }
    });
    ui.separator();
    ui.horizontal(|ui| {
        for (i, k) in knobs.iter_mut().enumerate() {
            ui.push_id(("knob", i));
            let _ = ui.add(Knob::new(k, 0.0..=1.0));
        }
    });
    for (i, s) in sliders.iter_mut().enumerate() {
        ui.push_id(("slider", i));
        let _ = ui.add(Slider::new(s, 0.0..=1.0).text(format!("Param {i}")));
    }
    ui.horizontal(|ui| {
        for i in 0..6 {
            let _ = ComboBox::from_id_source(("combo", i)).selected_text(format!("Preset {i}")).show_ui(ui, |_| {});
        }
    });
    ui.horizontal(|ui| {
        for (i, c) in checks.iter_mut().enumerate() {
            let _ = ui.checkbox(c, format!("Opt {i}"));
        }
    });
}

fn main() {
    let filter = std::env::args().nth(1).unwrap_or_default();
    println!("entropy_gui headless frame benchmark ({FRAMES} frames after {WARMUP} warm-up)\n");

    for &cards in &[5usize, 25, 100] {
        let columns = board(cards);
        bench(&filter, &format!("cc-manager/kanban {:>3} cards", cards * 4), 1240.0, 800.0, |ctx| {
            CentralPanel::default().show(ctx, |ui| {
                ScrollArea::vertical().show(ui, |ui| {
                    ui.label("CC Manager");
                    ui.label("Plan Claude Code work here, or point a Claude Code session at cc-manager/tasks.json directly - both read and write the same file.");
                    ui.separator();
                    let _ = KanbanBoard::new("cc_manager_board").show(ui, &columns, None);
                });
            });
        });
    }

    for &(tracks, clips) in &[(8usize, 4usize), (16, 8), (32, 16)] {
        let song = song(tracks, clips);
        let mut knobs = vec![0.5f32; 15];
        let mut sliders = vec![0.25f32; 16];
        let mut checks = vec![false; 8];
        let duration = clips as i32 * 4000;
        bench(&filter, &format!("daw/{tracks:>2} tracks x {clips:>2} clips"), 1800.0, 1000.0, |ctx| {
            CentralPanel::default().show(ctx, |ui| {
                ScrollArea::vertical().show(ui, |ui| {
                    daw_controls(ui, &mut knobs, &mut sliders, &mut checks);
                    let options = TrackViewOptions { bar_ms: 2000, beat_ms: 500, snap_ms: 250, ..Default::default() };
                    let _ = TrackView::new("arrangement").options(options).show(ui, &song, duration, 1234, None);
                });
            });
        });
    }

    for &n in &[100usize, 500] {
        let texts: Vec<String> = (0..n).map(|i| sentence(i, 6)).collect();
        bench(&filter, &format!("labels/{n:>3} labels"), 1800.0, 20000.0, |ctx| {
            CentralPanel::default().show(ctx, |ui| {
                for t in &texts {
                    ui.label(t.as_str());
                }
            });
        });
    }
}
