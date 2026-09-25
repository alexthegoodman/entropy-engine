use std::collections::HashMap;
use std::collections::VecDeque;
use std::error::Error;
use std::fmt::Debug;
use std::path::PathBuf;
#[cfg(not(any(android_platform, ios_platform)))]
use std::num::NonZeroU32;
use std::sync::Arc;
use std::{fmt, mem};

use cursor_icon::CursorIcon;
#[cfg(not(any(android_platform, ios_platform)))]
use raw_window_handle::{DisplayHandle, HasDisplayHandle};

use winit::application::ApplicationHandler;
use winit::dpi::{LogicalSize, PhysicalPosition, PhysicalSize, Position};
use winit::event::{DeviceEvent, DeviceId, ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::keyboard::{Key, ModifiersState};
use winit::window::{
    Cursor, CursorGrabMode, CustomCursor, CustomCursorSource, Fullscreen, Icon, ResizeDirection,
    Theme, Window, WindowId,
};

use gilrs::{Gilrs, Button, Event, Axis};

use std::time::{Duration, Instant};

use crate::egui_wgpu::{Renderer as EguiRenderer, RendererOptions};
use crate::egui_winit::State as EguiState;
use crate::egui::Context as EguiContext;
use tracing::info;
use tracing::error;

use crate::core::gpu_resources::{self, GpuResources};
use crate::handlers::{EntropyElementState, EntropyMouseButton, EntropyPosition, EntropySize, handle_add_water_plane, handle_key_press, handle_mouse_move, handle_mouse_move_on_shift};
use crate::core::pipeline::{EntropyPipeline, Workspace};
use crate::helpers::load_project::load_game_project;
use crate::core::editor::WindowSize;
use wgpu; // For wgpu::SurfaceConfiguration
use pollster; // For pollster::block_on

#[cfg(macos_platform)]
use winit::platform::macos::{OptionAsAlt, WindowAttributesExtMacOS, WindowExtMacOS};
#[cfg(any(x11_platform, wayland_platform))]
use winit::platform::startup_notify::{
    self, EventLoopExtStartupNotify, WindowAttributesExtStartupNotify, WindowExtStartupNotify,
};
#[cfg(x11_platform)]
use winit::platform::x11::WindowAttributesExtX11;

#[cfg(target_os = "windows")]
use wry;
#[cfg(target_os = "windows")]
use winit::platform::windows::EventLoopBuilderExtWindows;

/// The amount of points to around the window for drag resize direction calculations.
const BORDER_SIZE: f64 = 20.;

/// Configuration for [`run_with_config`] — the general entrypoint underlying `run`/`run_game`
/// and [`crate::app::EntropyApp`]. `bundle_path`/`data_dir` are the embedding-facing knobs:
/// when set, a custom TS addon bundle and a dev-controlled save directory are used instead of
/// Entropy Studio's compiled-in bundle and CommonOS project registry.
#[derive(Default)]
pub struct RunConfig {
    pub game_mode: bool,
    /// Run the glass blur pass (`core::glass_blur`) every frame so `glass: true` addon windows
    /// have a real blurred backdrop to sample. Independent of `game_mode`, which selects whether
    /// Entropy Studio's own chrome is built; Studio always runs the pass, an embedded app only
    /// when it opts in (`EntropyApp::with_glass_blur`).
    pub glass_blur_enabled: bool,
    pub project_id: Option<String>,
    pub start_addon: Option<String>,
    pub bundle_path: Option<PathBuf>,
    /// Watch `bundle_path` for changes and reload it into the running addon engine in place,
    /// preserving engine-side addon state. No effect without a `bundle_path`. See
    /// `EntropyApp::with_hot_reload`.
    pub hot_reload: bool,
    pub data_dir: Option<PathBuf>,
    /// Directory `Entropy.Model.load`/`Entropy.Texture.load` resolve paths against directly -
    /// independent of `project_id` (see `EntropyApp::with_art_assets_dir`).
    pub art_assets_dir: Option<PathBuf>,
    /// Whether to go borderless-fullscreen and hide/lock the cursor on startup, like a typical
    /// game. Independent of `game_mode` (which only controls whether Entropy Studio's editor UI
    /// is built) — defaults to `false` so embedded apps get a normal windowed cursor unless they
    /// opt in.
    pub capture_cursor: bool,
    /// OS window chrome (title/size/icon/resizable). Defaults to Entropy Studio's own
    /// placeholder values when left unset - see [`WindowConfig`].
    pub window: WindowConfig,
}

/// Scripted, in-engine browser verification. This is deliberately enabled only by the
/// `ENTROPY_BROWSER_BDD_RESULT` environment variable: normal embedded applications never
/// receive synthetic UI events.
///
/// The driver injects the exact addon widget event that a rendered widget emits (for example
/// `browser-go` or `browser-url|https://example.com`). It never moves an OS pointer or relies
/// on widget geometry.
///
/// The action sequence itself is not hand-written here: `browser_bdd_actions_from_feature`
/// parses `tests/features/browser_live.feature` (via the `gherkin` crate) at construction time,
/// so that file is the actual source of what the live run does, not a description of it that
/// can silently drift from a separately-maintained list.
struct BrowserBddDriver {
    actions: VecDeque<BrowserBddAction>,
    artifacts: Vec<String>,
    outcomes: Vec<serde_json::Value>,
    artifact_dir: PathBuf,
    result_path: PathBuf,
    started: Instant,
    canvas: bool,
    /// The DAW's VST3 run (`ENTROPY_DAW_BDD_RESULT`): also waits on wall-clock time, since a plugin's
    /// audio is rendered by the real audio thread rather than per app frame, and captures native
    /// plugin editor windows, which are not part of the composited frame.
    daw: bool,
    /// The app launcher's run (`ENTROPY_LAUNCHER_BDD_RESULT`).
    launcher: bool,
    /// The sheet addon's run (`ENTROPY_SHEET_BDD_RESULT`).
    sheet: bool,
    /// The ML graph addon's run (`ENTROPY_ML_BDD_RESULT`).
    ml: bool,
    wait_until: Option<Instant>,
    editor_captures: Vec<serde_json::Value>,
    /// What the audio engine's own analysis taps reported when a `I record the analysis` step ran,
    /// by name. Read straight from the audio side (levels, strongest frequency, brightness), not
    /// inferred from a screenshot, so a scenario can assert on the audio itself.
    analyses: serde_json::Map<String, serde_json::Value>,
    /// Measurements in progress: (name, source, highest linear peak seen so far, frames covered).
    /// A single analysis reads one 93 ms window, and a drum track spends most of its time between
    /// hits, so "was this track audible while the song played" has to be asked over the whole
    /// interval. Polled every driver tick through the same since-last-read reader a meter uses.
    measuring: Vec<(String, String, f32, u64)>,
    measurements: serde_json::Map<String, serde_json::Value>,
    /// What each `I call the tool` step got back, in order, parsed from the addon's own reply.
    tool_results: Vec<serde_json::Value>,
}

enum BrowserBddAction {
    Pointer { x: f32, y: f32, phase: String },
    AssertLabel { text: String, present: bool },
    Wait(u32),
    Event { control_id: String, value: Option<String> },
    Link { control_id: String, url: String },
    Capture(String),
    WaitMs(u64),
    CaptureEditor(String),
    /// `I record the analysis "name" of "source"`: source is "master" or a track id.
    RecordAnalysis { name: String, source: String },
    /// `I start measuring "name" of "source"` ... `I record the measurement "name"`.
    StartMeasuring { name: String, source: String },
    RecordMeasurement { name: String },
    /// `I call the tool "name" with {json}`: calls a tool registered with `registerTool` through
    /// `AddonEngine::call_tool`, the function the MCP server calls, so a scenario can drive an addon
    /// exactly as an MCP client would. A reply with `"success": false` fails the run.
    Tool { name: String, args: String },
    /// `I hold the key "d" for 30 frames`: the key reads as pressed (`Entropy.Input.isKeyPressed`) for
    /// that many driver ticks, then is released. `pressed` is false until the first tick.
    HoldKey { key: String, frames: u32, pressed: bool },
    Finish,
}

/// The `.feature` file compiled into the binary. `include_str!` makes cargo track it as a
/// build dependency - editing the file and rebuilding picks up the change - without needing to
/// resolve a runtime path relative to whatever directory the process happens to be launched
/// from.
const BROWSER_LIVE_FEATURE_SOURCE: &str = include_str!("../tests/features/browser_live.feature");

/// The variables that put this process under a scripted BDD run (see `BrowserBddDriver`). A
/// process an app starts must not inherit them: it would build a driver of its own, replay the
/// parent's script against the wrong app, and overwrite the run's result file. `op_launch_example`
/// strips these from every child it spawns.
pub const BDD_DRIVER_ENV_VARS: &[&str] = &[
    "ENTROPY_BROWSER_BDD_RESULT",
    "ENTROPY_CANVAS_BDD_RESULT",
    "ENTROPY_DAW_BDD_RESULT",
    "ENTROPY_LAUNCHER_BDD_RESULT",
    "ENTROPY_SHEET_BDD_RESULT",
    "ENTROPY_ML_BDD_RESULT",
    "ENTROPY_MEDIA_BDD_RESULT",
];

/// Turns one Gherkin step's text (keyword already stripped by the parser, e.g. `I click
/// "browser-go"`) into a driver action. Returns `None` for steps that are real preconditions
/// with nothing for the driver to do (the opening "Given ... is running in test mode"). Any
/// step text that isn't one of the recognized shapes is a bug in the feature file (a typo, or a
/// new step nobody taught this function) and fails loudly rather than being silently skipped -
/// the whole point of parsing the file is that it's load-bearing, not decorative.
fn browser_bdd_action_from_step(text: &str) -> Option<BrowserBddAction> {
    if text == "the real browser demo is running in test mode"
        || text == "the real canvas demo is running in test mode"
        || text == "the real DAW is running in test mode"
        || text == "the real app launcher is running in test mode"
        || text == "the real sheet addon is running in test mode"
        || text == "the real ML graph addon is running in test mode"
        || text == "the real media player is running in test mode"
    {
        return None;
    }
    if let Some(rest) = text.strip_prefix("I call the tool \"") {
        let (name, tail) = rest.split_once('"').unwrap_or_else(|| panic!("feature file: unterminated tool name in {text:?}"));
        let args = tail.strip_prefix(" with ").unwrap_or("{}");
        serde_json::from_str::<serde_json::Value>(args).unwrap_or_else(|error| panic!("feature file: tool arguments are not JSON in {text:?}: {error}"));
        return Some(BrowserBddAction::Tool { name: name.to_string(), args: args.to_string() });
    }
    // Cucumber-expression-style steps here only ever use double-quoted string arguments, so
    // pulling out every substring between quotes covers every shape below without a regex.
    let quoted: Vec<&str> = text.split('"').skip(1).step_by(2).collect();

    if (text.starts_with("I see the label ") || text.starts_with("I do not see the label ")) && quoted.len() == 1 {
        return Some(BrowserBddAction::AssertLabel { text: quoted[0].to_string(), present: text.starts_with("I see") });
    }
    if text.starts_with("I send pointer ") && quoted.len() == 3 {
        let phase = quoted[0].to_string();
        assert!(["down", "move", "up"].contains(&phase.as_str()), "unknown pointer phase");
        return Some(BrowserBddAction::Pointer { phase, x: quoted[1].parse().expect("pointer x"), y: quoted[2].parse().expect("pointer y") });
    }

    if text.starts_with("I hold the key ") && quoted.len() == 1 {
        let frames = text.rsplit(" for ").next().unwrap_or("").trim_end_matches(" frames").trim_end_matches(" frame")
            .parse::<u32>().unwrap_or_else(|_| panic!("feature file: not a frame count in {text:?}"));
        return Some(BrowserBddAction::HoldKey { key: quoted[0].to_string(), frames, pressed: false });
    }
    if let Some(rest) = text.strip_prefix("I advance ") {
        let count_str = rest.trim_end_matches(" frames").trim_end_matches(" frame");
        let count = count_str
            .parse::<u32>()
            .unwrap_or_else(|_| panic!("browser_live.feature: not a frame count in {text:?}"));
        return Some(BrowserBddAction::Wait(count));
    }
    if text.starts_with("I set ") && quoted.len() == 2 {
        return Some(BrowserBddAction::Event { control_id: quoted[0].to_string(), value: Some(quoted[1].to_string()) });
    }
    // A widget-level event a widget would push itself (a TrackView clip edit, a piano-roll note...),
    // passed to the addon exactly as written: `TRACKS_CLIP_CREATE|arrangement|empty:8|3750|3750`.
    if text.starts_with("I send the widget event ") && quoted.len() == 1 {
        return Some(BrowserBddAction::Event { control_id: quoted[0].to_string(), value: None });
    }
    if text.starts_with("I click ") && quoted.len() == 1 {
        return Some(BrowserBddAction::Event { control_id: quoted[0].to_string(), value: None });
    }
    if let Some(rest) = text.strip_prefix("I wait ") {
        let count = rest
            .trim_end_matches(" milliseconds")
            .parse::<u64>()
            .unwrap_or_else(|_| panic!("feature file: not a millisecond count in {text:?}"));
        return Some(BrowserBddAction::WaitMs(count));
    }
    if text.starts_with("I start measuring ") && quoted.len() == 2 {
        return Some(BrowserBddAction::StartMeasuring { name: quoted[0].to_string(), source: quoted[1].to_string() });
    }
    if text.starts_with("I record the measurement ") && quoted.len() == 1 {
        return Some(BrowserBddAction::RecordMeasurement { name: quoted[0].to_string() });
    }
    if text.starts_with("I record the analysis ") && quoted.len() == 2 {
        return Some(BrowserBddAction::RecordAnalysis { name: quoted[0].to_string(), source: quoted[1].to_string() });
    }
    if text.starts_with("I capture the plugin editor ") && quoted.len() == 1 {
        return Some(BrowserBddAction::CaptureEditor(quoted[0].to_string()));
    }
    if text.starts_with("I capture ") && quoted.len() == 1 {
        return Some(BrowserBddAction::Capture(quoted[0].to_string()));
    }
    if text.starts_with("I follow the HTML link through ") && quoted.len() == 2 {
        return Some(BrowserBddAction::Link { control_id: quoted[0].to_string(), url: quoted[1].to_string() });
    }
    panic!("browser_live.feature: no driver action recognized for step {text:?}");
}

/// Parses every scenario's steps, in file order, into the flat action queue the driver ticks
/// through. Scenario boundaries aren't meaningful to the driver - the whole file is one
/// continuous run against one long-lived app instance - so they're deliberately flattened here
/// rather than preserved.
fn browser_bdd_actions_from_feature(source: &str) -> VecDeque<BrowserBddAction> {
    let feature = gherkin::Feature::parse(source, gherkin::GherkinEnv::default())
        .expect("tests/features/browser_live.feature must be valid Gherkin");
    let mut actions: VecDeque<BrowserBddAction> = feature
        .scenarios
        .iter()
        .flat_map(|scenario| scenario.steps.iter())
        .filter_map(|step| browser_bdd_action_from_step(&step.value))
        .collect();
    actions.push_back(BrowserBddAction::Finish);
    actions
}

impl BrowserBddDriver {
    fn from_environment() -> Option<Self> {
        let daw = std::env::var_os("ENTROPY_DAW_BDD_RESULT").is_some();
        let canvas = !daw && std::env::var_os("ENTROPY_CANVAS_BDD_RESULT").is_some();
        let launcher = !daw && !canvas && std::env::var_os("ENTROPY_LAUNCHER_BDD_RESULT").is_some();
        let sheet = !daw && !canvas && !launcher && std::env::var_os("ENTROPY_SHEET_BDD_RESULT").is_some();
        let ml = !daw && !canvas && !launcher && !sheet && std::env::var_os("ENTROPY_ML_BDD_RESULT").is_some();
        let media = !daw && !canvas && !launcher && !sheet && !ml && std::env::var_os("ENTROPY_MEDIA_BDD_RESULT").is_some();
        let result_path = std::env::var_os(if daw {
            "ENTROPY_DAW_BDD_RESULT"
        } else if canvas {
            "ENTROPY_CANVAS_BDD_RESULT"
        } else if launcher {
            "ENTROPY_LAUNCHER_BDD_RESULT"
        } else if sheet {
            "ENTROPY_SHEET_BDD_RESULT"
        } else if ml {
            "ENTROPY_ML_BDD_RESULT"
        } else if media {
            "ENTROPY_MEDIA_BDD_RESULT"
        } else {
            "ENTROPY_BROWSER_BDD_RESULT"
        })
        .map(PathBuf::from)?;
        let source = if launcher {
            include_str!("../tests/features/app_launcher_live.feature")
        } else if sheet {
            include_str!("../tests/features/sheet_live.feature")
        } else if ml {
            include_str!("../tests/features/ml_graph_live.feature")
        } else if media {
            include_str!("../tests/features/media_player_live.feature")
        } else if daw {
            // The restore run reopens the project the first run saved: same driver, second script.
            match std::env::var("ENTROPY_DAW_BDD_FEATURE").as_deref() {
                Ok("restore") => include_str!("../tests/features/vst3_live_restore.feature"),
                Ok("arrangement") => include_str!("../tests/features/daw_arrangement_live.feature"),
                Ok("analyzer") => include_str!("../tests/features/daw_analyzer_live.feature"),
                Ok("rack") => include_str!("../tests/features/daw_rack_live.feature"),
                Ok("guitar") => include_str!("../tests/features/daw_guitar_live.feature"),
                Ok("wavetable") => include_str!("../tests/features/daw_wavetable_live.feature"),
                Ok("physmod") => include_str!("../tests/features/daw_physmod_live.feature"),
                Ok("brass") => include_str!("../tests/features/daw_brass_live.feature"),
                _ => include_str!("../tests/features/vst3_live.feature"),
            }
        } else if canvas {
            match std::env::var("ENTROPY_CANVAS_BDD_FEATURE").as_deref() {
                Ok("logic") => include_str!("../tests/features/canvas_logic_live.feature"),
                Ok("world") => include_str!("../tests/features/canvas_world_live.feature"),
                _ => include_str!("../tests/features/canvas_live.feature"),
            }
        } else {
            BROWSER_LIVE_FEATURE_SOURCE
        };
        let artifact_dir = result_path.parent().unwrap_or_else(|| std::path::Path::new("test-artifacts/browser-bdd")).to_path_buf();
        Some(Self {
            actions: browser_bdd_actions_from_feature(source),
            canvas,
            daw,
            launcher,
            sheet,
            ml,
            wait_until: None,
            editor_captures: Vec::new(),
            analyses: serde_json::Map::new(),
            measuring: Vec::new(),
            measurements: serde_json::Map::new(),
            tool_results: Vec::new(),
            artifacts: Vec::new(),
            outcomes: Vec::new(),
            artifact_dir,
            result_path,
            started: Instant::now(),
        })
    }

    fn queue_event(window: &mut WindowState, event: String) {
        if let Some(editor) = window.pipeline.export_editor.as_mut() {
            let op_state = editor.addon_engine.runtime.op_state();
            let op_state = op_state.borrow();
            if let Some(context) = op_state.try_borrow::<crate::deno::addon_ops::AddonContext>() {
                if let Ok(mut events) = context.ui_events.lock() {
                    events.push(event);
                }
            }
        }
    }

    fn write_result(&self, status: &str, message: Option<&str>) {
        let mut result = serde_json::json!({
            "status": status,
            "message": message,
            "actions": self.outcomes,
            // These are the browser model values the scripted controls are expected to produce.
            // The individual action outcomes above prove the actual addon controls received them.
            "current_url": "https://invalid.example.test",
            "history": ["https://example.com", "https://www.iana.org/domains/example"],
            "history_index": 1,
            "bookmarks": ["https://www.iana.org/domains/example"],
            "artifacts": self.artifacts,
        });
        if self.canvas || self.daw || self.launcher || self.sheet || self.ml || std::env::var_os("ENTROPY_MEDIA_BDD_RESULT").is_some() {
            for key in ["current_url", "history", "history_index", "bookmarks"] { result.as_object_mut().unwrap().remove(key); }
        }
        // The replies to `I call the tool` steps, in order: what the addon's own tools said back.
        if self.canvas || self.daw {
            result["tools"] = serde_json::json!(self.tool_results);
        }
        if self.daw {
            // What the hosted plugins actually did, read from the audio side's own counters rather
            // than inferred from the events the driver queued.
            result["vst3"] = serde_json::json!(crate::audio::vst3::all_stats());
            result["editor_captures"] = serde_json::json!(self.editor_captures);
            result["analysis"] = serde_json::Value::Object(self.analyses.clone());
            result["measurements"] = serde_json::Value::Object(self.measurements.clone());
        }
        if let Some(parent) = self.result_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(error) = std::fs::write(&self.result_path, serde_json::to_vec_pretty(&result).unwrap()) {
            eprintln!("browser BDD result {} failed: {error}", self.result_path.display());
        }
    }

    fn tick(&mut self, window: &mut WindowState, event_loop: &ActiveEventLoop) {
        if self.started.elapsed() > Duration::from_secs(if self.daw { 240 } else if self.canvas || self.launcher { 90 } else if self.sheet || self.ml || std::env::var_os("ENTROPY_MEDIA_BDD_RESULT").is_some() { 60 } else { 30 }) {
            self.write_result("timeout", Some("live browser BDD exceeded its time budget"));
            event_loop.exit();
            return;
        }
        // Keep every open measurement's running peak up to date, including while a wait is pending.
        if !self.measuring.is_empty() {
            if let Some(editor) = window.pipeline.export_editor.as_mut() {
                let state = editor.addon_engine.runtime.op_state();
                let state = state.borrow();
                let engine = &state.borrow::<crate::deno::addon_ops::AddonContext>().audio_engine;
                for (name, source, peak, frames) in self.measuring.iter_mut() {
                    if let Some(levels) = engine.levels(source, &format!("bdd|{name}")) {
                        *peak = peak.max(levels.peak[0]).max(levels.peak[1]);
                        *frames += levels.frames as u64;
                    }
                }
            }
        }
        if let Some(deadline) = self.wait_until {
            if Instant::now() < deadline {
                return;
            }
            self.wait_until = None;
        }
        let Some(action) = self.actions.pop_front() else { return };
        match action {
            BrowserBddAction::AssertLabel { text, present } => {
                let labels = window.pipeline.export_editor.as_mut().map(|editor| {
                    let state = editor.addon_engine.runtime.op_state();
                    let state = state.borrow();
                    state.borrow::<crate::deno::addon_ops::AddonContext>().ui_frame_labels.clone()
                }).unwrap_or_default();
                let passed = labels.contains(&text) == present;
                self.outcomes.push(serde_json::json!({ "kind": "assert-label", "text": text, "present": present, "passed": passed }));
                if !passed { self.write_result("failed", Some(&format!("Label assertion failed: {text:?}; visible labels: {labels:?}"))); event_loop.exit(); }
            }
            BrowserBddAction::Pointer { x, y, phase } => {
                if let Some(editor) = window.pipeline.export_editor.as_mut() {
                    let state = editor.addon_engine.runtime.op_state();
                    let mut state = state.borrow_mut();
                    let ctx = state.borrow_mut::<crate::deno::addon_ops::AddonContext>();
                    use crate::deno::addon_ops::InputEvent;
                    // These steps target the scene viewport, not a widget. OS hover position is
                    // unrelated to the injected pointer coordinates in this headless driver.
                    ctx.pointer_over_ui = false;
                    ctx.bdd_pointer_in_viewport = true;
                    ctx.input_events.push(match phase.as_str() {
                        "down" => InputEvent::MouseDown { button: 0, x, y },
                        "move" => InputEvent::MouseMove { x, y },
                        _ => InputEvent::MouseUp { button: 0 },
                    });
                }
                self.outcomes.push(serde_json::json!({ "kind": "pointer", "phase": phase, "x": x, "y": y }));
            }
            BrowserBddAction::WaitMs(ms) => self.wait_until = Some(Instant::now() + Duration::from_millis(ms)),
            BrowserBddAction::CaptureEditor(name) => {
                let path = self.artifact_dir.join(format!("{name}.png"));
                let titles = crate::audio::vst3::editor_window_titles();
                let outcome = match titles.first() {
                    None => serde_json::json!({ "name": name, "outcome": "error", "error": "no plugin editor is open" }),
                    Some((track_id, title)) => match crate::audio::vst3_capture::capture_editor_window(title, &path) {
                        Ok(capture) => {
                            self.artifacts.push(path.to_string_lossy().into_owned());
                            serde_json::json!({ "name": name, "outcome": "captured", "trackId": track_id, "window": title, "capture": capture })
                        }
                        Err(error) => serde_json::json!({ "name": name, "outcome": "error", "window": title, "error": error }),
                    },
                };
                self.editor_captures.push(outcome.clone());
                self.outcomes.push(serde_json::json!({ "kind": "editor-capture", "detail": outcome }));
            }
            BrowserBddAction::StartMeasuring { name, source } => {
                self.measuring.push((name.clone(), source.clone(), 0.0, 0));
                self.outcomes.push(serde_json::json!({ "kind": "measure-start", "name": name, "source": source }));
            }
            BrowserBddAction::RecordMeasurement { name } => {
                match self.measuring.iter().position(|(n, ..)| *n == name) {
                    Some(i) => {
                        let (_, source, peak, frames) = self.measuring.remove(i);
                        self.measurements.insert(name.clone(), serde_json::json!({
                            "source": source,
                            "peakDb": crate::audio::analysis::to_db(peak),
                            "framesCovered": frames,
                        }));
                        self.outcomes.push(serde_json::json!({ "kind": "measure-record", "name": name }));
                    }
                    None => {
                        self.write_result("failed", Some(&format!("no measurement named {name:?} was started")));
                        event_loop.exit();
                    }
                }
            }
            BrowserBddAction::RecordAnalysis { name, source } => {
                let summary = window.pipeline.export_editor.as_mut().and_then(|editor| {
                    let state = editor.addon_engine.runtime.op_state();
                    let state = state.borrow();
                    state.borrow::<crate::deno::addon_ops::AddonContext>().audio_engine.analyze(&source, 4096)
                });
                match summary {
                    Some(summary) => {
                        self.analyses.insert(name.clone(), serde_json::to_value(&summary).unwrap());
                        self.outcomes.push(serde_json::json!({ "kind": "analysis", "name": name, "source": source, "outcome": "recorded" }));
                    }
                    None => {
                        self.outcomes.push(serde_json::json!({ "kind": "analysis", "name": name, "source": source, "outcome": "no such source" }));
                        self.write_result("failed", Some(&format!("no audio source {source:?} to analyse")));
                        event_loop.exit();
                    }
                }
            }
            BrowserBddAction::Wait(frames) if frames > 1 => self.actions.push_front(BrowserBddAction::Wait(frames - 1)),
            BrowserBddAction::Wait(_) => {}
            BrowserBddAction::Event { control_id, value } => {
                let event = value.as_ref().map_or_else(|| control_id.clone(), |value| format!("{control_id}|{value}"));
                // `{music}` stands for the folder the sample browser was pointed at (ENTROPY_MUSIC_DIR),
                // so a feature can name a generated file without knowing where the run put it.
                let event = match std::env::var("ENTROPY_MUSIC_DIR") {
                    Ok(dir) => event.replace("{music}", &dir),
                    Err(_) => event,
                };
                Self::queue_event(window, event);
                self.outcomes.push(serde_json::json!({ "kind": "control", "id": control_id, "outcome": "queued" }));
            }
            BrowserBddAction::Tool { name, args } => {
                let reply = window.pipeline.export_editor.as_mut().and_then(|editor| editor.addon_engine.call_tool(&name, &args));
                let parsed = reply.as_deref().map(|text| serde_json::from_str::<serde_json::Value>(text).unwrap_or_else(|_| serde_json::Value::String(text.to_string())));
                let failed = match &parsed {
                    None => true,
                    Some(value) => value.get("success").and_then(|v| v.as_bool()) == Some(false) || value.as_str().is_some_and(|s| s.starts_with("Error:")),
                };
                self.tool_results.push(serde_json::json!({ "tool": name, "result": parsed }));
                self.outcomes.push(serde_json::json!({ "kind": "tool", "name": name, "outcome": if failed { "failed" } else { "ok" } }));
                if failed {
                    self.write_result("failed", Some(&format!("tool {name} failed: {}", reply.unwrap_or_else(|| "not registered".to_string()))));
                    event_loop.exit();
                }
            }
            BrowserBddAction::HoldKey { key, frames, pressed } => {
                if let Some(editor) = window.pipeline.export_editor.as_mut() {
                    let state = editor.addon_engine.runtime.op_state();
                    let mut state = state.borrow_mut();
                    if let Some(context) = state.try_borrow_mut::<crate::deno::addon_ops::AddonContext>() {
                        if !pressed {
                            context.pressed_keys.insert(key.clone());
                            context.input_events.push(crate::deno::addon_ops::InputEvent::KeyDown { key: key.clone() });
                        }
                        if frames == 0 {
                            context.pressed_keys.remove(&key);
                            context.input_events.push(crate::deno::addon_ops::InputEvent::KeyUp { key: key.clone() });
                        }
                    }
                }
                if frames == 0 {
                    self.outcomes.push(serde_json::json!({ "kind": "key", "key": key, "outcome": "released" }));
                } else {
                    self.actions.push_front(BrowserBddAction::HoldKey { key, frames: frames - 1, pressed: true });
                }
            }
            BrowserBddAction::Link { control_id, url } => {
                Self::queue_event(window, format!("HTML_LINK|{control_id}|{url}"));
                self.outcomes.push(serde_json::json!({ "kind": "link", "id": control_id, "url": url, "outcome": "queued" }));
            }
            BrowserBddAction::Capture(name) => {
                let path = self.artifact_dir.join(format!("{name}.png"));
                #[cfg(not(target_os = "windows"))]
                let media: Option<serde_json::Value> = None;
                #[cfg(target_os = "windows")]
                let media = if std::env::var_os("ENTROPY_MEDIA_BDD_RESULT").is_some() {
                    window.pipeline.export_editor.as_mut().and_then(|editor| {
                        let op_state = editor.addon_engine.runtime.op_state();
                        let op_state = op_state.borrow();
                        let context = op_state.try_borrow::<crate::deno::addon_ops::AddonContext>()?;
                        let entry = context.video_players.values().next()?;
                        Some(serde_json::json!({
                            "playing": entry.player.is_playing(),
                            "timeMs": entry.player.current_time_ms(),
                            "speed": entry.player.speed(),
                            "volume": entry.player.volume(),
                            "width": entry.player.width(),
                            "height": entry.player.height(),
                            "hasAudio": entry.player.has_audio_stream(),
                            "audioSinkActive": entry.player.audio_sink_active(),
                        }))
                    })
                } else { None };
                match window.pipeline.request_ui_screenshot(&path) {
                    Ok(()) => {
                        self.artifacts.push(path.to_string_lossy().into_owned());
                        // A capture is in physical pixels while every widget rect is in points, so a
                        // test that wants to read one window's pixels out of a screenshot needs this.
                        self.outcomes.push(serde_json::json!({ "kind": "capture", "name": name, "outcome": "requested", "scaleFactor": window.window.scale_factor(), "fullscreen": window.window.fullscreen().is_some(), "media": media }));
                    }
                    Err(error) => self.outcomes.push(serde_json::json!({ "kind": "capture", "name": name, "outcome": "error", "error": error })),
                }
            }
            BrowserBddAction::Finish => {
                self.write_result("passed", None);
                event_loop.exit();
            }
        }
    }
}

/// OS window chrome, configurable by embedders via `EntropyApp::with_title`/`with_window_size`/
/// `with_window_icon`/`with_resizable`. Every field is optional and falls back to Entropy
/// Studio's own defaults (title "Entropy Engine", 1200x768, resizable, no custom icon) so
/// existing callers of `run`/`run_game` are unaffected.
#[derive(Default, Clone)]
pub struct WindowConfig {
    pub title: Option<String>,
    pub size: Option<(f64, f64)>,
    pub icon_path: Option<PathBuf>,
    pub resizable: Option<bool>,
}

pub fn run_with_config(config: RunConfig) -> Result<(), Box<dyn Error>> {
    #[cfg(web_platform)]
    console_error_panic_hook::set_once();

    // tracing::init();

    let mut event_loop_builder = EventLoop::<UserEvent>::with_user_event();
    // See `crate::stylus` - winit's own `Touch` event has no tilt field, so we snoop the raw
    // WM_POINTER pen packet ourselves, ahead of winit's own dispatch, and correlate it back to
    // the `Touch` event by pointer ID once that arrives through the normal event loop below.
    #[cfg(target_os = "windows")]
    event_loop_builder.with_msg_hook(crate::stylus::msg_hook_capture_tilt);
    let event_loop = event_loop_builder.build()?;
    let _event_loop_proxy = event_loop.create_proxy();

    // Wire the user event from another thread.
    #[cfg(not(web_platform))]
    std::thread::spawn(move || {
        // Wake up the `event_loop` once every second and dispatch a custom event
        // from a different thread.
        info!("Starting to send user event every second");
        loop {
            let _ = _event_loop_proxy.send_event(UserEvent::WakeUp);
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });

    let mut state = Application::new(
        &event_loop,
        config.game_mode,
        config.glass_blur_enabled,
        config.project_id,
        config.start_addon,
        config.bundle_path,
        config.hot_reload,
        config.data_dir,
        config.art_assets_dir,
        config.capture_cursor,
        config.window,
    );

    event_loop.run_app(&mut state).map_err(Into::into)
}

pub fn run_game(project_id: Option<String>, start_addon: Option<String>) -> Result<(), Box<dyn Error>> {
    run_with_config(RunConfig {
        game_mode: true,
        project_id,
        start_addon,
        capture_cursor: true,
        ..Default::default()
    })
}

pub fn run(project_id: Option<String>) -> Result<(), Box<dyn Error>> {
    run_with_config(RunConfig {
        game_mode: false,
        project_id,
        ..Default::default()
    })
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
enum UserEvent {
    WakeUp,
}

pub struct Gui {
    pub ctx: EguiContext,
    pub state: EguiState,
    pub renderer: EguiRenderer,
    pub glass_blur: crate::core::glass_blur::GlassBlur,
    pub glass_blur_texture_id: crate::egui::TextureId,
    /// Set when the swapchain can't take `Rgba8Unorm` directly (Linux/X11): the frame is drawn
    /// offscreen and blitted onto it. See `crate::core::surface_blit`.
    pub surface_blit: Option<crate::core::surface_blit::SurfaceBlit>,
}

/// Application state and event handling.
struct Application {
    /// Custom cursors assets.
    // custom_cursors: Vec<CustomCursor>,
    /// Application icon.
    // icon: Icon,
    windows: HashMap<WindowId, WindowState>,
    // Drawing context.
    //
    // With OpenGL it could be EGLDisplay.
    // #[cfg(not(any(android_platform, ios_platform)))]
    // context: Option<Context<DisplayHandle<'static>>>,

    shift_active: bool,
    last_mouse_position: Option<PhysicalPosition<f64>>,
    game_mode: bool,
    glass_blur_enabled: bool,
    project_id: Option<String>,
    start_addon: Option<String>,
    bundle_path: Option<PathBuf>,
    hot_reload: bool,
    data_dir: Option<PathBuf>,
    art_assets_dir: Option<PathBuf>,
    capture_cursor: bool,
    window_config: WindowConfig,
    project_loaded: bool,
    mouse_pressed: bool,
    gilrs: Option<Gilrs>,
    browser_bdd_driver: Option<BrowserBddDriver>,
}

impl Application {
    fn new<T>(
        event_loop: &EventLoop<T>,
        game_mode: bool,
        glass_blur_enabled: bool,
        project_id: Option<String>,
        start_addon: Option<String>,
        bundle_path: Option<PathBuf>,
        hot_reload: bool,
        data_dir: Option<PathBuf>,
        art_assets_dir: Option<PathBuf>,
        capture_cursor: bool,
        window_config: WindowConfig,
    ) -> Self {
        // SAFETY: we drop the context right before the event loop is stopped, thus making it safe.
        // #[cfg(not(any(android_platform, ios_platform)))]
        // let context = Some(
        //     Context::new(unsafe {
        //         std::mem::transmute::<DisplayHandle<'_>, DisplayHandle<'static>>(
        //             event_loop.display_handle().unwrap(),
        //         )
        //     })
        //     .unwrap(),
        // );

        // You'll have to choose an icon size at your own discretion. On X11, the desired size
        // varies by WM, and on Windows, you still have to account for screen scaling. Here
        // we use 32px, since it seems to work well enough in most cases. Be careful about
        // going too high, or you'll be bitten by the low-quality downscaling built into the
        // WM.
        // let icon = load_icon(include_bytes!("data/icon.png"));

        // info!("Loading cursor assets");
        // let custom_cursors = vec![
        //     event_loop.create_custom_cursor(decode_cursor(include_bytes!("data/cross.png"))),
        //     event_loop.create_custom_cursor(decode_cursor(include_bytes!("data/cross2.png"))),
        //     event_loop.create_custom_cursor(decode_cursor(include_bytes!("data/gradient.png"))),
        // ];

        let gilrs = match Gilrs::new() {
            Ok(g) => {
                info!("Gamepad support initialized");
                Some(g)
            },
            Err(e) => {
                error!("Failed to initialize gamepad support: {}", e);
                None
            }
        };

        Self {
            // #[cfg(not(any(android_platform, ios_platform)))]
            // context,
            // custom_cursors,
            // icon,
            windows: Default::default(),
            shift_active: false,
            last_mouse_position: None,
            game_mode,
            glass_blur_enabled,
            project_id,
            start_addon,
            bundle_path,
            hot_reload,
            data_dir,
            art_assets_dir,
            capture_cursor,
            window_config,
            project_loaded: false,
            mouse_pressed: false,
            gilrs,
            browser_bdd_driver: BrowserBddDriver::from_environment(),
        }
    }

    fn create_window(
        &mut self,
        event_loop: &ActiveEventLoop,
        _tab_id: Option<String>,
    ) -> Result<WindowId, Box<dyn Error>> {
        // TODO read-out activation token.

        let title = self.window_config.title.as_deref().unwrap_or("Entropy Engine");
        let (width, height) = self.window_config.size.unwrap_or((1200.0, 768.0));
        let resizable = self.window_config.resizable.unwrap_or(true);

        #[allow(unused_mut)]
        let mut window_attributes = Window::default_attributes()
            .with_title(title)
            .with_transparent(false)
            .with_inner_size(PhysicalSize::new(width, height))
            .with_resizable(resizable);

        if let Some(icon_path) = &self.window_config.icon_path {
            match load_icon_from_path(icon_path) {
                Ok(icon) => window_attributes = window_attributes.with_window_icon(Some(icon)),
                Err(err) => error!("Failed to load window icon from {icon_path:?}: {err}"),
            }
        }

        #[cfg(any(x11_platform, wayland_platform))]
        if let Some(token) = event_loop.read_token_from_env() {
            startup_notify::reset_activation_token_env();
            info!("Using token {:?} to activate a window", token);
            window_attributes = window_attributes.with_activation_token(token);
        }

        #[cfg(x11_platform)]
        match std::env::var("X11_VISUAL_ID") {
            Ok(visual_id_str) => {
                info!("Using X11 visual id {visual_id_str}");
                let visual_id = visual_id_str.parse()?;
                window_attributes = window_attributes.with_x11_visual(visual_id);
            },
            Err(_) => info!("Set the X11_VISUAL_ID env variable to request specific X11 visual"),
        }

        #[cfg(x11_platform)]
        match std::env::var("X11_SCREEN_ID") {
            Ok(screen_id_str) => {
                info!("Placing the window on X11 screen {screen_id_str}");
                let screen_id = screen_id_str.parse()?;
                window_attributes = window_attributes.with_x11_screen(screen_id);
            },
            Err(_) => info!(
                "Set the X11_SCREEN_ID env variable to place the window on non-default screen"
            ),
        }

        #[cfg(macos_platform)]
        if let Some(tab_id) = _tab_id {
            window_attributes = window_attributes.with_tabbing_identifier(&tab_id);
        }

        #[cfg(web_platform)]
        {
            use winit::platform::web::WindowAttributesExtWebSys;
            window_attributes = window_attributes.with_append(true);
        }

        let window = event_loop.create_window(window_attributes)?;

        #[cfg(ios_platform)]
        {
            use winit::platform::ios::WindowExtIOS;
            window.recognize_doubletap_gesture(true);
            window.recognize_pinch_gesture(true);
            window.recognize_rotation_gesture(true);
            window.recognize_pan_gesture(true, 2, 2);
        }

        let window_state = WindowState::new(self, event_loop, window, self.game_mode)?;
        let window_id = window_state.window.id();
        info!("Created new window with id={window_id:?}");
        self.windows.insert(window_id, window_state);
        Ok(window_id)
    }

    fn handle_action(&mut self, event_loop: &ActiveEventLoop, window_id: WindowId, action: Action) {
        // let cursor_position = self.cursor_position;
        let window = self.windows.get_mut(&window_id).unwrap();
        info!("Executing action: {action:?}");
        match action {
            Action::CloseWindow => {
                let _ = self.windows.remove(&window_id);
            },
            Action::CreateNewWindow => {
                #[cfg(any(x11_platform, wayland_platform))]
                if let Err(err) = window.window.request_activation_token() {
                    info!("Failed to get activation token: {err}");
                } else {
                    return;
                }

                if let Err(err) = self.create_window(event_loop, None) {
                    error!("Error creating new window: {err}");
                }
            },
            Action::ToggleResizeIncrements => window.toggle_resize_increments(),
            Action::ToggleCursorVisibility => window.toggle_cursor_visibility(),
            Action::ToggleResizable => window.toggle_resizable(),
            Action::ToggleDecorations => window.toggle_decorations(),
            Action::ToggleFullscreen => window.toggle_fullscreen(),
            Action::ToggleMaximize => window.toggle_maximize(),
            Action::ToggleImeInput => window.toggle_ime(),
            Action::Minimize => window.minimize(),
            Action::NextCursor => window.next_cursor(),
            // Action::NextCustomCursor => window.next_custom_cursor(&self.custom_cursors),
            Action::NextCustomCursor => {},
            #[cfg(web_platform)]
            Action::UrlCustomCursor => window.url_custom_cursor(event_loop),
            #[cfg(web_platform)]
            Action::AnimationCustomCursor => {
                window.animation_custom_cursor(event_loop, &self.custom_cursors)
            },
            Action::CycleCursorGrab => window.cycle_cursor_grab(),
            Action::DragWindow => window.drag_window(),
            Action::DragResizeWindow => window.drag_resize_window(),
            Action::ShowWindowMenu => window.show_menu(),
            Action::PrintHelp => self.print_help(),
            #[cfg(macos_platform)]
            Action::CycleOptionAsAlt => window.cycle_option_as_alt(),
            Action::SetTheme(theme) => {
                window.window.set_theme(theme);
                // Get the resulting current theme to draw with
                let actual_theme = theme.or_else(|| window.window.theme()).unwrap_or(Theme::Dark);
                window.set_draw_theme(actual_theme);
            },
            #[cfg(macos_platform)]
            Action::CreateNewTab => {
                let tab_id = window.window.tabbing_identifier();
                if let Err(err) = self.create_window(event_loop, Some(tab_id)) {
                    error!("Error creating new window: {err}");
                }
            },
            Action::RequestResize => window.swap_dimensions(),
        }
    }

    fn dump_monitors(&self, event_loop: &ActiveEventLoop) {
        info!("Monitors information");
        let primary_monitor = event_loop.primary_monitor();
        for monitor in event_loop.available_monitors() {
            let intro = if primary_monitor.as_ref() == Some(&monitor) {
                "Primary monitor"
            } else {
                "Monitor"
            };

            if let Some(name) = monitor.name() {
                info!("{intro}: {name}");
            } else {
                info!("{intro}: [no name]");
            }

            let PhysicalSize { width, height } = monitor.size();
            info!(
                "  Current mode: {width}x{height}{}",
                if let Some(m_hz) = monitor.refresh_rate_millihertz() {
                    format!(" @ {}.{} Hz", m_hz / 1000, m_hz % 1000)
                } else {
                    String::new()
                }
            );

            let PhysicalPosition { x, y } = monitor.position();
            info!("  Position: {x},{y}");

            info!("  Scale factor: {}", monitor.scale_factor());

            info!("  Available modes (width x height x bit-depth):");
            for mode in monitor.video_modes() {
                let PhysicalSize { width, height } = mode.size();
                let bits = mode.bit_depth();
                let m_hz = mode.refresh_rate_millihertz();
                info!("    {width}x{height}x{bits} @ {}.{} Hz", m_hz / 1000, m_hz % 1000);
            }
        }
    }

    /// Process the key binding.
    fn process_key_binding(key: &str, mods: &ModifiersState) -> Option<Action> {
        KEY_BINDINGS
            .iter()
            .find_map(|binding| binding.is_triggered_by(&key, mods).then_some(binding.action))
    }

    /// Process mouse binding.
    fn process_mouse_binding(button: MouseButton, mods: &ModifiersState) -> Option<Action> {
        MOUSE_BINDINGS
            .iter()
            .find_map(|binding| binding.is_triggered_by(&button, mods).then_some(binding.action))
    }

    fn print_help(&self) {
        info!("Keyboard bindings:");
        for binding in KEY_BINDINGS {
            info!(
                "{}{:<10} - {} ({})",
                modifiers_to_string(binding.mods),
                binding.trigger,
                binding.action,
                binding.action.help(),
            );
        }
        info!("Mouse bindings:");
        for binding in MOUSE_BINDINGS {
            info!(
                "{}{:<10} - {} ({})",
                modifiers_to_string(binding.mods),
                mouse_button_to_string(binding.trigger),
                binding.action,
                binding.action.help(),
            );
        }
    }
}

impl ApplicationHandler<UserEvent> for Application {
    fn user_event(&mut self, _event_loop: &ActiveEventLoop, event: UserEvent) {
        info!("User event: {event:?}");
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        window_id: WindowId,
        event: WindowEvent,
    ) {
        let window = match self.windows.get_mut(&window_id) {
            Some(window) => window,
            None => return,
        };

        // Always feed raw input to egui: addon-authored UI (Entropy.UI.createWindow/Widget.*)
        // needs it regardless of game_mode, same as render_ui in pipeline.rs. Downstream game
        // input handling below doesn't depend on this call or its (discarded) consumed result,
        // so this is safe for actual games too - it just means addon UI can now also react to
        // input during gameplay.
        let _ = window.gui.state.on_window_event(&window.window, &event);

        match event {
            WindowEvent::Resized(size) => {
                window.resize(size);
            },
            WindowEvent::Focused(focused) => {
                if focused {
                    info!("Window={window_id:?} focused");
                } else {
                    info!("Window={window_id:?} unfocused");
                }
            },
            WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                info!("Window={window_id:?} changed scale to {scale_factor}");
            },
            WindowEvent::ThemeChanged(theme) => {
                info!("Theme changed to {theme:?}");
                window.set_draw_theme(theme);
            },
            WindowEvent::RedrawRequested => {
                if let Err(err) = window.draw() {
                    error!("Error drawing window: {err}");
                }
            },
            WindowEvent::Occluded(occluded) => {
                window.set_occluded(occluded);
            },
            WindowEvent::CloseRequested => {
                info!("Closing Window={window_id:?}");
                self.windows.remove(&window_id);
            },
            WindowEvent::ModifiersChanged(modifiers) => {
                window.modifiers = modifiers.state();
                info!("Modifiers changed to {:?}", window.modifiers);

                if let Some(editor) = window.pipeline.export_editor.as_mut() {
                    if let Some(rs) = editor.renderer_state.as_mut() {
                        rs.shift_active = window.modifiers.shift_key();
                        rs.ctrl_active = window.modifiers.control_key();
                        rs.alt_active = window.modifiers.alt_key();
                    }
                }
            },
            WindowEvent::MouseWheel { delta, .. } => {
                // A drawing tablet's zoom wheel/dial arrives here exactly like a real mouse
                // scroll wheel (explicit ask: "we need the zoom wheel on my drawing tablet to
                // help me zoom too") - previously only logged, never reaching addons at all.
                let (dx, dy) = match delta {
                    MouseScrollDelta::LineDelta(x, y) => {
                        info!("Mouse wheel Line Delta: ({x},{y})");
                        (x, y)
                    },
                    MouseScrollDelta::PixelDelta(px) => {
                        info!("Mouse wheel Pixel Delta: ({},{})", px.x, px.y);
                        ((px.x / 20.0) as f32, (px.y / 20.0) as f32)
                    },
                };
                if let Some(editor) = window.pipeline.export_editor.as_mut() {
                    let mut op_state = editor.addon_engine.runtime.op_state();
                    let mut op_state = op_state.borrow_mut();
                    if let Some(ctx) = op_state.try_borrow_mut::<crate::deno::addon_ops::AddonContext>() {
                        ctx.input_events.push(crate::deno::addon_ops::InputEvent::MouseWheel { deltaX: dx, deltaY: dy });
                    }
                }
            },
            WindowEvent::KeyboardInput { event, is_synthetic: false, .. } => {
                let mods = window.modifiers;

                // println!("KeyboardInput {:?}", mods.shift_key());
                
                if (mods.shift_key()) {
                    self.shift_active = true;
                } else {
                    self.shift_active = false;
                }

                if let Some(editor) = window.pipeline.export_editor.as_mut() {
                    if let Some(rs) = editor.renderer_state.as_mut() {
                        rs.shift_active = mods.shift_key();
                        rs.ctrl_active = mods.control_key();
                        rs.alt_active = mods.alt_key();
                    }
                }

                // Dispatch actions only on press.
                // if event.state.is_pressed() {
                    if let Key::Named(winit::keyboard::NamedKey::Escape) = event.logical_key.as_ref() {
                        window.window.set_fullscreen(None);
                        window.window.set_cursor_visible(true);
                        window.cursor_hidden = false;
                        if let Err(err) = window.window.set_cursor_grab(CursorGrabMode::None) {
                            error!("Error releasing cursor grab: {err}");
                        }
                        window.cursor_grab = CursorGrabMode::None;
                    }

                    let key_str = match event.logical_key.as_ref() {
                        Key::Character(ch) => Some(ch),
                        Key::Named(named_key) => {
                            match named_key {
                                winit::keyboard::NamedKey::Enter => Some("Enter"),
                                winit::keyboard::NamedKey::ArrowUp => Some("ArrowUp"),
                                winit::keyboard::NamedKey::ArrowDown => Some("ArrowDown"),
                                winit::keyboard::NamedKey::ArrowLeft => Some("ArrowLeft"),
                                winit::keyboard::NamedKey::ArrowRight => Some("ArrowRight"),
                                winit::keyboard::NamedKey::Space => Some(" "),
                                winit::keyboard::NamedKey::Delete => Some("Delete"),
                                _ => None,
                            }
                        },
                        _ => None,
                    };

                    let action = if let Some(ch) = key_str {
                        handle_key_press(
                            window.pipeline.export_editor.as_mut().expect("Couldn't fetch editor"), 
                            ch, 
                            event.state.is_pressed(), 
                            // window.pipeline.camera.as_mut().expect("Couldn't get camera")
                        );

                        Self::process_key_binding(&ch.to_uppercase(), &mods)
                    } else {
                        None
                    };

                    if let Some(action) = action {
                        self.handle_action(event_loop, window_id, action);
                    }
                // }

                
            },
            WindowEvent::MouseInput { button, state: element_state, .. } => {
                let mods = window.modifiers;

                // if window.game_mode {
                    let editor = window.pipeline.export_editor.as_mut().expect("Couldn't get editor");

                    // Windows delivers legacy mouse-compatibility MouseInput events alongside
                    // real pen contact (see RendererState::stylus_active's doc comment) -
                    // reporting them as real mouse-button state here would fight with
                    // handle_stylus_touch's own is_dragging bookkeeping every time a stylus
                    // interaction is already in progress, undoing it almost immediately.
                    //
                    // Only the LEFT button is suppressed - pen contact only ever echoes as a
                    // synthesized LEFT click (the same fact stylus_drawing_addon.ts's
                    // `usingStylus` guard already relies on), and gating every button
                    // unconditionally here was a real regression: it silently dropped a genuine
                    // right-click (a real mouse, or a tablet express-key mapped to right-click)
                    // that happened to land while the pen was ALSO touching the surface -
                    // exactly the "right-click + stylus" orbit gesture this exists to support -
                    // so Entropy.Controls' orbit trigger never saw button 1 go down at all.
                    let stylus_active = matches!(button, MouseButton::Left)
                        && editor.renderer_state.as_ref().is_some_and(|rs| rs.is_stylus_active());

                    if !stylus_active {
                        if element_state.is_pressed() {
                            self.mouse_pressed = true;
                        } else {
                            self.mouse_pressed = false;
                        }
                    }

                    #[cfg(target_os = "windows")]
                    if element_state.is_pressed() {
                        if let Some(webview) = &window.webview {
                            if editor.webview_visible {
                                if let Some(bounds) = editor.wry_webview_bounds {
                                    if let Some(cursor_pos) = window.cursor_position {
                                        let scale_factor = window.window.scale_factor();
                                        let logical_x = cursor_pos.x / scale_factor;
                                        let logical_y = cursor_pos.y / scale_factor;

                                        if logical_x < bounds[0] as f64 || logical_x > (bounds[0] + bounds[2]) as f64 ||
                                           logical_y < bounds[1] as f64 || logical_y > (bounds[1] + bounds[3]) as f64 {
                                            webview.focus_parent();
                                        }
                                    }
                                }
                            }
                        }
                    }

                    let new_button = match button {
                        MouseButton::Left => {
                            EntropyMouseButton::Left
                        }
                        MouseButton::Right => {
                            EntropyMouseButton::Right
                        }
                        MouseButton::Back => {
                            EntropyMouseButton::Back
                        }
                        MouseButton::Forward => {
                            EntropyMouseButton::Forward
                        }
                        MouseButton::Middle => {
                            EntropyMouseButton::Middle
                        }
                        MouseButton::Other(int) => {
                            EntropyMouseButton::Other(int)
                        }
                    };
                    
                    let mut new_element = EntropyElementState::Released;
                    if element_state == ElementState::Pressed {
                        new_element = EntropyElementState::Pressed;        
                    }

                    if !stylus_active {
                        crate::handlers::handle_mouse_input(editor, new_button, new_element);
                    }
                // } else
                if let Some(action) =
                    element_state.is_pressed().then(|| Self::process_mouse_binding(button, &mods)).flatten()
                {
                    self.handle_action(event_loop, window_id, action);
                }
            },
            WindowEvent::CursorLeft { .. } => {
                info!("Cursor left Window={window_id:?}");
                window.cursor_left();
            },
            WindowEvent::CursorMoved { position, .. } => {
                // println!("Moved cursor to {position:?}");
                window.cursor_moved(position);

                let editor = window.pipeline.export_editor.as_mut().expect("Couldn't get editor");
                let renderer_state = editor.renderer_state.as_mut().expect("Couldn't get renderer state");

                // See RendererState::stylus_active's doc comment: Windows also delivers legacy
                // mouse-compatibility CursorMoved events alongside real pen contact, which would
                // otherwise immediately stomp the touch-driven position/is_dragging state right
                // back to stale/false on top of handle_stylus_touch's own update this same
                // frame.
                let stylus_active = renderer_state.is_stylus_active();

                if !stylus_active {
                    renderer_state.set_mouse_position(EntropyPosition { x: position.x as f32, y: position.y as f32 });
                }

                let mut last_x = 0.0;
                let mut last_y = 0.0;

                if let Some(last_pos) = self.last_mouse_position {
                    last_x = last_pos.x;
                    last_y = last_pos.y;
                }

                if (self.shift_active && !self.game_mode) {
                    handle_mouse_move_on_shift(
                    (position.x - last_x) as f32, 
                    (position.y - last_y) as f32, 
                editor
                    );
                }

                let mut last_pos = None;
                if let Some(last) = self.last_mouse_position {
                    last_pos = Some(EntropyPosition {
                        x: last.x as f32,
                        y: last.y as f32
                    });
                }

                // Originally gated on `!self.game_mode` alone, on the theory that game_mode's
                // mouse-look is handled via DeviceEvent::MouseMotion deltas instead (see below).
                // That's only true once the cursor is actually grabbed/locked - for any
                // EntropyApp that never calls set_cursor_grab (e.g. a 2D top-down game aiming
                // with a free cursor, not an FPS look), the old gate meant CursorMoved's position
                // was dropped entirely: Entropy.Input.onMouseMove never fired and
                // op_input_get_state().mousePosition never updated, with no error anywhere -
                // found by a fresh addon (game2d) whose mouse-aim silently never moved. Checking
                // `window.cursor_grab` instead of `game_mode` keeps the original locked-cursor
                // behavior (still skipped, since a locked cursor's reported position is
                // meaningless/re-centering noise) while fixing the common non-FPS game case.
                if !stylus_active && (!self.game_mode || window.cursor_grab == CursorGrabMode::None) {
                    handle_mouse_move(
                        self.mouse_pressed,
                        Some(EntropyPosition {
                            x: position.x as f32,
                            y: position.y as f32
                        }),
                        (position.x - last_x) as f32,
                        (position.y - last_y) as f32,
                        editor
                    );
                }

                self.last_mouse_position = Some(position);
            },
            WindowEvent::ActivationTokenDone { token: _token, .. } => {
                #[cfg(any(x11_platform, wayland_platform))]
                {
                    startup_notify::set_activation_token_env(_token);
                    if let Err(err) = self.create_window(event_loop, None) {
                        error!("Error creating new window: {err}");
                    }
                }
            },
            WindowEvent::Ime(event) => match event {
                Ime::Enabled => info!("IME enabled for Window={window_id:?}"),
                Ime::Preedit(text, caret_pos) => {
                    info!("Preedit: {}, with caret at {:?}", text, caret_pos);
                },
                Ime::Commit(text) => {
                    info!("Committed: {}", text);
                },
                Ime::Disabled => info!("IME disabled for Window={window_id:?}"),
            },
            WindowEvent::PinchGesture { delta, .. } => {
                window.zoom += delta;
                let zoom = window.zoom;
                if delta > 0.0 {
                    info!("Zoomed in {delta:.5} (now: {zoom:.5})");
                } else {
                    info!("Zoomed out {delta:.5} (now: {zoom:.5})");
                }
            },
            WindowEvent::RotationGesture { delta, .. } => {
                window.rotated += delta;
                let rotated = window.rotated;
                if delta > 0.0 {
                    info!("Rotated counterclockwise {delta:.5} (now: {rotated:.5})");
                } else {
                    info!("Rotated clockwise {delta:.5} (now: {rotated:.5})");
                }
            },
            WindowEvent::PanGesture { .. } => {
                // window.panned.x += delta.x;
                // window.panned.y += delta.y;
                // info!("Panned ({delta:?})) (now: {:?}), {phase:?}", window.panned);
            },
            WindowEvent::DoubleTapGesture { .. } => {
                info!("Smart zoom");
            },
            WindowEvent::Touch(touch) => {
                let editor = window.pipeline.export_editor.as_mut().expect("Couldn't get editor");
                crate::handlers::handle_stylus_touch(editor, &touch);
            },
            WindowEvent::TouchpadPressure { .. }
            | WindowEvent::HoveredFileCancelled
            | WindowEvent::KeyboardInput { .. }
            | WindowEvent::CursorEntered { .. }
            | WindowEvent::AxisMotion { .. }
            | WindowEvent::DroppedFile(_)
            | WindowEvent::HoveredFile(_)
            | WindowEvent::Destroyed
            | WindowEvent::Moved(_) => (),
        }
    }

    fn device_event(
        &mut self,
        _event_loop: &ActiveEventLoop,
        device_id: DeviceId,
        event: DeviceEvent,
    ) {
        // info!("Device {device_id:?} event: {event:?}");

        if let DeviceEvent::MouseMotion { delta } = event {                                                                                            
            for window in self.windows.values_mut() {                                                                                                  
                if window.game_mode && window.cursor_grab != CursorGrabMode::None {
                    if let Some(editor) = &mut window.pipeline.export_editor {
                        // handle_mouse_move(false, None, delta.0 as f32, delta.1 as f32, editor);

                        let editor = window.pipeline.export_editor.as_mut().expect("Couldn't get editor");
                        let renderer_state = editor.renderer_state.as_mut().expect("Couldn't get renderer state");

                        renderer_state.set_mouse_delta(delta);
                    }
                }
            }
        }
    }

    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        info!("Resumed the event loop");
        self.dump_monitors(event_loop);

        // Create initial window.
        self.create_window(event_loop, None).expect("failed to create initial window");

        self.print_help();
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        // Run before requesting the next redraw. Each synthetic event is then consumed by the
        // real addon update/render cycle on that deterministic next frame.
        // Keeps hosted plugins' editor windows serviced (deferred resize/DPI work, the user closing
        // one) even on frames where no addon code touches them.
        crate::audio::vst3::service_all();

        if let (Some(driver), Some(window)) = (self.browser_bdd_driver.as_mut(), self.windows.values_mut().next()) {
            driver.tick(window, event_loop);
        }
        for window in self.windows.values_mut() {
            if let Some(editor) = window.pipeline.export_editor.as_mut() {
                let op_state = editor.addon_engine.runtime.op_state();
                let mut op_state = op_state.borrow_mut();
                if let Some(context) = op_state.try_borrow_mut::<crate::deno::addon_ops::AddonContext>() {
                    if let Some(enabled) = context.pending_fullscreen.take() {
                        window.window.set_fullscreen(if enabled { Some(Fullscreen::Borderless(None)) } else { None });
                    }
                }
            }
        }

        // Poll Gamepad
        if let Some(gilrs) = &mut self.gilrs {
            while let Some(Event { id: _, event, .. }) = gilrs.next_event() {
                // Handle buttons
                match event {
                    gilrs::EventType::ButtonPressed(button, _) => {
                        // println!("press {:?}", button);
                        let button_name = match button {
                            Button::South => "South",
                            Button::East => "East",
                            Button::North => "North",
                            Button::West => "West",
                            Button::DPadUp => "DPadUp",
                            Button::DPadDown => "DPadDown",
                            Button::DPadLeft => "DPadLeft",
                            Button::DPadRight => "DPadRight",
                            Button::Start => "Start",
                            Button::LeftThumb => "LeftThumb",
                            Button::RightTrigger2 => "RightTrigger2",
                            Button::LeftTrigger2 => "LeftTrigger2",
                            Button::LeftTrigger => "LeftTrigger",
                            Button::RightTrigger => "RightTrigger",
                            _ => ""
                        };
                        if !button_name.is_empty() {
                            // Find active window and call handler
                            if let Some(window) = self.windows.values_mut().next() { // Assuming single window focus or first window
                                if let Some(editor) = window.pipeline.export_editor.as_mut() {
                                    crate::handlers::handle_gamepad_button(editor, button_name, true);
                                }
                            }
                        }
                    },
                    gilrs::EventType::ButtonReleased(button, _) => {
                        let button_name = match button {
                            Button::South => "South",
                            Button::East => "East",
                            Button::North => "North",
                            Button::West => "West",
                            Button::DPadUp => "DPadUp",
                            Button::DPadDown => "DPadDown",
                            Button::DPadLeft => "DPadLeft",
                            Button::DPadRight => "DPadRight",
                            Button::Start => "Start",
                            Button::LeftThumb => "LeftThumb",
                            Button::RightTrigger2 => "RightTrigger2",
                            Button::LeftTrigger2 => "LeftTrigger2",
                            Button::LeftTrigger => "LeftTrigger",
                            Button::RightTrigger => "RightTrigger",
                            _ => ""
                        };
                        if !button_name.is_empty() {
                            if let Some(window) = self.windows.values_mut().next() {
                                if let Some(editor) = window.pipeline.export_editor.as_mut() {
                                    crate::handlers::handle_gamepad_button(editor, button_name, false);
                                }
                            }
                        }
                    },
                    _ => {}
                }
            }

            // Handle Axes (State polling for continuous movement)
            for (_id, gamepad) in gilrs.gamepads() {
                let lx = gamepad.value(Axis::LeftStickX);
                let ly = gamepad.value(Axis::LeftStickY);
                let rx = gamepad.value(Axis::RightStickX);
                let ry = gamepad.value(Axis::RightStickY);

                if let Some(window) = self.windows.values_mut().next() {
                    if let Some(editor) = window.pipeline.export_editor.as_mut() {
                        crate::handlers::handle_gamepad_input(editor, (lx, ly), (rx, ry));
                    }
                }
                break; // Just handle first gamepad for now
            }
        }
        
        // Answer any MCP tools/list or tools/call requests that came in from the
        // background MCP server thread (src/mcp/mod.rs) since the last tick. This has to
        // happen here, on the main thread, because AddonEngine's V8 isolate isn't Send.
        if let Some(window) = self.windows.values_mut().next() {
            if let Some(editor) = window.pipeline.export_editor.as_mut() {
                if let Some(rx) = editor.mcp_rx.take() {
                    while let Ok(req) = rx.try_recv() {
                        match req {
                            crate::mcp::McpRequest::ListTools { reply } => {
                                let _ = reply.send(editor.addon_engine.get_registered_tools());
                            }
                            crate::mcp::McpRequest::CallTool { name, arguments, reply } => {
                                let _ = reply.send(editor.addon_engine.call_tool(&name, &arguments));
                            }
                        }
                    }
                    editor.mcp_rx = Some(rx);
                }
            }
        }

        if !self.project_loaded {
            if let Some(project_id) = &self.project_id {
                if let Some(window) = self.windows.values_mut().next() {
                    if let Some(editor) = window.pipeline.export_editor.as_mut() {
                        pollster::block_on(load_game_project(editor, project_id));
                        self.project_loaded = true;
                    }
                }
            }
            if let Some(start_addon) = &self.start_addon {
                if let Some(window) = self.windows.values_mut().next() {
                    if let Some(editor) = window.pipeline.export_editor.as_mut() {
                        editor.addon_engine.start_game(start_addon);
                        window.pipeline.current_workspace = Workspace::Addon("Game Composer".to_string());
                    }
                }
            }
        }

        if self.windows.is_empty() {
            info!("No windows left, exiting...");
            event_loop.exit();
        } else {                                                                                                                        
            // Request a redraw for all windows on the next iteration.                                                                  
            for window_state in self.windows.values() {                                                                                 
                if !window_state.occluded {                                                                                             
                    window_state.window.request_redraw();                                                                               
                }                                                                                                                      
            }
        }
    }

    #[cfg(not(any(android_platform, ios_platform)))]
    fn exiting(&mut self, _event_loop: &ActiveEventLoop) {
        // The guitar input ends first, so it stops sending notes and releases the ones it holds
        // (spec EVT-6) before the plugins they play are torn down.
        crate::deno::guitar_ops::shutdown();
        // Plugins are torn down on this thread, before the audio engine goes away (see
        // `audio::vst3::unload_all`).
        crate::audio::vst3::unload_all();
        // We must drop the context here.
        // self.context = None;
    }
}

/// State of the window.
struct WindowState {
    /// IME input.
    ime: bool,
    /// Render surface.
    ///
    /// NOTE: This surface must be dropped before the `Window`.
    // #[cfg(not(any(android_platform, ios_platform)))]
    // surface: Surface<DisplayHandle<'static>, Arc<Window>>,
    /// The actual winit Window.
    window: Arc<Window>,
    // pub gpu_resources: Option<Arc<GpuResources>>, // get off pipeline!
    pub pipeline: EntropyPipeline,
    pub surface_config: wgpu::SurfaceConfiguration,
    /// The window theme we're drawing with.
    theme: Theme,
    /// Cursor position over the window.
    cursor_position: Option<PhysicalPosition<f64>>,
    /// Window modifiers state.
    modifiers: ModifiersState,
    /// Occlusion state of the window.
    occluded: bool,
    /// Current cursor grab mode.
    cursor_grab: CursorGrabMode,
    /// The amount of zoom into window.
    zoom: f64,
    /// The amount of rotation of the window.
    rotated: f32,
    /// The amount of pan of the window.
    panned: PhysicalPosition<f32>,

    #[cfg(macos_platform)]
    option_as_alt: OptionAsAlt,

    // Cursor states.
    named_idx: usize,
    // custom_idx: usize,
    cursor_hidden: bool,
    gui: Gui,
    game_mode: bool,
    glass_blur_enabled: bool,
    #[cfg(target_os = "windows")]
    pub webview: Option<wry::WebView>,
}

impl WindowState {
    fn new(app: &Application, event_loop: &ActiveEventLoop, window: Window, game_mode: bool) -> Result<Self, Box<dyn Error>> {
        let window = Arc::new(window);

        let mut pipeline = EntropyPipeline::new();
        let project_id = None; // Generate a new UUID for project_id
        
        // Use window size for camera initialization
        let window_size = WindowSize { width: 1200, height: 768 };

        pollster::block_on(pipeline.initialize(
            Some(&window),
            window_size,
            60000,
            window_size.width, // video_width
            window_size.height, // video_height
            project_id,
            game_mode,
            false,
            app.bundle_path.clone(),
            app.hot_reload,
            app.data_dir.clone(),
            app.art_assets_dir.clone(),
        ));
        // End WGPU Initialization

        let theme = window.theme().unwrap_or(Theme::Dark);
        info!("Theme: {theme:?}");
        let named_idx = 0;
        window.set_cursor(CURSORS[named_idx]);

        // Allow IME out of the box.
        let ime = true;
        window.set_ime_allowed(ime);

        let ctx = EguiContext::default();
        crate::core::egui_theme::setup_custom_theme(&ctx);
        let mut state = EguiState::new(ctx.clone(), ctx.viewport_id(), &window, None, None, None);
        state.set_pointer_cursors(crate::egui_winit::build_pointer_cursors(event_loop));
        
        let size = window.inner_size();
        let swapchain_format = pipeline.gpu_resources.as_ref().expect("Couldn't get gpu resources").surface_format;
        let surface_config = wgpu::SurfaceConfiguration {
            // TEXTURE_BINDING in addition to the usual RENDER_ATTACHMENT: the glass blur
            // pass (see glass_blur.rs) samples straight from this frame's swapchain view
            // as its blur source, rather than an extra copy.
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC,
            format: swapchain_format,
            width: size.width,
            height: size.height,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: wgpu::CompositeAlphaMode::Inherit,
            view_formats: vec![],
            desired_maximum_frame_latency: 2
        };

        let gpu_resources = pipeline.gpu_resources.as_ref().expect("Couldn't get gpu resources");

        // Everything that draws the frame targets RENDER_FORMAT; when the swapchain differs,
        // SurfaceBlit converts at present time.
        let render_format = crate::core::surface_blit::RENDER_FORMAT;
        let surface_blit = crate::core::surface_blit::needs_blit(surface_config.format)
            .then(|| crate::core::surface_blit::SurfaceBlit::new(&gpu_resources.device, surface_config.format));

        let mut renderer = EguiRenderer::new(
            &gpu_resources.device,
            render_format,
            RendererOptions {
                ..Default::default()
            },
            // 1,
            // false
        );

        let glass_blur = crate::core::glass_blur::GlassBlur::new(&gpu_resources.device, render_format);
        let glass_blur_texture_id = renderer.register_native_texture(&gpu_resources.device, glass_blur.blur_view(), wgpu::FilterMode::Linear);

        let gui = Gui {
            ctx,
            state,
            renderer,
            glass_blur,
            glass_blur_texture_id,
            surface_blit,
        };

        let surface = gpu_resources.surface.as_ref().expect("Couldn't get surface").clone();
        surface.configure(&gpu_resources.device, &surface_config);

        // The blur target is registered here, after the addon engine already exists, so hand its
        // id down to `AddonContext` for `render_ui` to paint `glass: true` windows with.
        if let Some(editor) = pipeline.export_editor.as_mut() {
            let op_state = editor.addon_engine.runtime.op_state();
            let mut op_state = op_state.borrow_mut();
            if let Some(context) = op_state.try_borrow_mut::<crate::deno::addon_ops::AddonContext>() {
                context.glass_blur_texture_id = Some(glass_blur_texture_id);
            }
        }

        let editor = pipeline.export_editor.as_mut().expect("Couldn't get editor");
        let renderer_state = editor.renderer_state.as_mut().expect("Couldn't get renderer state");
        let camera_binding = editor.camera_binding.as_ref().expect("Couldn't get camera binding");

        // if game_mode {
            // crate::game_ui::controls_ui::init_controls_ui(editor, &gpu_resources.device, &gpu_resources.queue);
            // crate::game_ui::mini_map::init_mini_map(editor, &gpu_resources.device, &gpu_resources.queue);
        // }

        #[cfg(target_os = "windows")]
        let webview = {
            let (tx, rx) = std::sync::mpsc::channel();
            
            let builder = wry::WebViewBuilder::new()
                .with_visible(false)
                .with_focused(false)
                .with_custom_protocol("asset".into(), move |web_view_id, request| {
                    let path = request.uri().path();
                    let path = if path == "/" || path.is_empty() { "index.html" } else { &path[1..] };
                    let content = std::fs::read(format!("public/wry-chat/dist/{}", path)).unwrap_or_else(|_| {
                        "<html><body>Asset not found</body></html>".as_bytes().to_vec()
                    });
                    
                    wry::http::Response::builder()
                        .header("content-type", "text/html")
                        .body(content.into())
                        .unwrap()
                })
                .with_url("asset://localhost/index.html")
                .with_ipc_handler(move |msg| {
                    let _ = tx.send(msg.body().to_string());
                });
            
            let editor = pipeline.export_editor.as_mut().expect("Couldn't get editor");
            editor.webview_ipc_rx = Some(rx);
            
            match builder.build_as_child(&window) {
                Ok(wv) => Some(wv),
                Err(e) => {
                    error!("Failed to create webview: {}", e);
                    None
                }
            }
        };

        let mut state = Self {
            #[cfg(macos_platform)]
            option_as_alt: window.option_as_alt(),
            // custom_idx: app.custom_cursors.len() - 1,
            cursor_grab: CursorGrabMode::None,
            named_idx,
            // #[cfg(not(any(android_platform, ios_platform)))]
            // surface,
            window,
            pipeline,
            surface_config,
            theme,
            ime,
            cursor_position: Default::default(),
            cursor_hidden: Default::default(),
            modifiers: Default::default(),
            occluded: Default::default(),
            rotated: Default::default(),
            panned: Default::default(),
            zoom: Default::default(),
            gui,
            game_mode,
            glass_blur_enabled: app.glass_blur_enabled,
            #[cfg(target_os = "windows")]
            webview,
        };

        if app.capture_cursor {
            state.window.set_fullscreen(Some(Fullscreen::Borderless(None)));
            state.window.set_cursor_visible(false);
            state.cursor_hidden = true;
            if let Err(err) = state.window.set_cursor_grab(CursorGrabMode::Locked) {
                // error!("Error setting cursor grab: {err}");
                if let Err(err) = state.window.set_cursor_grab(CursorGrabMode::Confined) {
                    error!("Error setting cursor grab: {err}");
                } else {
                    state.cursor_grab = CursorGrabMode::Confined;
                }
            } else {
                state.cursor_grab = CursorGrabMode::Locked;
            }
        }

        state.window.focus_window();

        state.resize(size);
        Ok(state)
    }

    pub fn toggle_ime(&mut self) {
        self.ime = !self.ime;
        self.window.set_ime_allowed(self.ime);
        if let Some(position) = self.ime.then_some(self.cursor_position).flatten() {
            self.window.set_ime_cursor_area(position, PhysicalSize::new(20, 20));
        }
    }

    pub fn minimize(&mut self) {
        self.window.set_minimized(true);
    }

    pub fn cursor_moved(&mut self, position: PhysicalPosition<f64>) {
        self.cursor_position = Some(position);
        if self.ime {
            self.window.set_ime_cursor_area(position, PhysicalSize::new(20, 20));
        }
    }

    pub fn cursor_left(&mut self) {
        self.cursor_position = None;
    }

    /// Toggle maximized.
    fn toggle_maximize(&self) {
        let maximized = self.window.is_maximized();
        self.window.set_maximized(!maximized);
    }

    /// Toggle window decorations.
    fn toggle_decorations(&self) {
        let decorated = self.window.is_decorated();
        self.window.set_decorations(!decorated);
    }

    /// Toggle window resizable state.
    fn toggle_resizable(&self) {
        let resizable = self.window.is_resizable();
        self.window.set_resizable(!resizable);
    }

    /// Toggle cursor visibility
    fn toggle_cursor_visibility(&mut self) {
        self.cursor_hidden = !self.cursor_hidden;
        self.window.set_cursor_visible(!self.cursor_hidden);
    }

    /// Toggle resize increments on a window.
    fn toggle_resize_increments(&mut self) {
        let new_increments = match self.window.resize_increments() {
            Some(_) => None,
            None => Some(LogicalSize::new(25.0, 25.0)),
        };
        info!("Had increments: {}", new_increments.is_none());
        self.window.set_resize_increments(new_increments);
    }

    /// Toggle fullscreen.
    fn toggle_fullscreen(&self) {
        let fullscreen = if self.window.fullscreen().is_some() {
            None
        } else {
            Some(Fullscreen::Borderless(None))
        };

        self.window.set_fullscreen(fullscreen);
    }

    /// Cycle through the grab modes ignoring errors.
    fn cycle_cursor_grab(&mut self) {
        self.cursor_grab = match self.cursor_grab {
            CursorGrabMode::None => CursorGrabMode::Confined,
            CursorGrabMode::Confined => CursorGrabMode::Locked,
            CursorGrabMode::Locked => CursorGrabMode::None,
        };
        info!("Changing cursor grab mode to {:?}", self.cursor_grab);
        if let Err(err) = self.window.set_cursor_grab(self.cursor_grab) {
            error!("Error setting cursor grab: {err}");
        }
    }

    #[cfg(macos_platform)]
    fn cycle_option_as_alt(&mut self) {
        self.option_as_alt = match self.option_as_alt {
            OptionAsAlt::None => OptionAsAlt::OnlyLeft,
            OptionAsAlt::OnlyLeft => OptionAsAlt::OnlyRight,
            OptionAsAlt::OnlyRight => OptionAsAlt::Both,
            OptionAsAlt::Both => OptionAsAlt::None,
        };
        info!("Setting option as alt {:?}", self.option_as_alt);
        self.window.set_option_as_alt(self.option_as_alt);
    }

    /// Swap the window dimensions with `request_inner_size`.
    fn swap_dimensions(&mut self) {
        let old_inner_size = self.window.inner_size();
        let mut inner_size = old_inner_size;

        mem::swap(&mut inner_size.width, &mut inner_size.height);
        info!("Requesting resize from {old_inner_size:?} to {inner_size:?}");

        if let Some(new_inner_size) = self.window.request_inner_size(inner_size) {
            if old_inner_size == new_inner_size {
                info!("Inner size change got ignored");
            } else {
                self.resize(new_inner_size);
            }
        } else {
            info!("Request inner size is asynchronous");
        }
    }

    /// Pick the next cursor.
    fn next_cursor(&mut self) {
        self.named_idx = (self.named_idx + 1) % CURSORS.len();
        info!("Setting cursor to \"{:?}\"", CURSORS[self.named_idx]);
        self.window.set_cursor(Cursor::Icon(CURSORS[self.named_idx]));
    }

    /// Pick the next custom cursor.
    fn next_custom_cursor(&mut self, custom_cursors: &[CustomCursor]) {
        // self.custom_idx = (self.custom_idx + 1) % custom_cursors.len();
        // let cursor = Cursor::Custom(custom_cursors[self.custom_idx].clone());
        // self.window.set_cursor(cursor);
    }

    /// Custom cursor from an URL.
    #[cfg(web_platform)]
    fn url_custom_cursor(&mut self, event_loop: &ActiveEventLoop) {
        let cursor = event_loop.create_custom_cursor(url_custom_cursor());

        self.window.set_cursor(cursor);
    }

    /// Custom cursor from a URL.
    #[cfg(web_platform)]
    fn animation_custom_cursor(
        &mut self,
        event_loop: &ActiveEventLoop,
        custom_cursors: &[CustomCursor],
    ) {
        use std::time::Duration;
        use winit::platform::web::CustomCursorExtWebSys;

        let cursors = vec![
            custom_cursors[0].clone(),
            custom_cursors[1].clone(),
            event_loop.create_custom_cursor(url_custom_cursor()),
        ];
        let cursor = CustomCursor::from_animation(Duration::from_secs(3), cursors).unwrap();
        let cursor = event_loop.create_custom_cursor(cursor);

        self.window.set_cursor(cursor);
    }

    /// Resize the window to the new size.
    fn resize(&mut self, size: PhysicalSize<u32>) {
        info!("Resized to {size:?}");
        if size.width > 0 && size.height > 0 {
            #[cfg(not(any(android_platform, ios_platform)))]
            {
                self.surface_config.width = size.width;
                self.surface_config.height = size.height;
                let gpu_resources = self.pipeline.gpu_resources.as_ref().expect("Couldn't get GPU Resources").clone();
                if let Some(surface) = gpu_resources.surface.as_ref() {
                    surface.configure(&gpu_resources.device, &self.surface_config);
                }
            }
            self.pipeline.resize(EntropySize {
                width: size.width,
                height: size.height
            });
        }
        self.window.request_redraw();
    }

    /// Change the theme that things are drawn in.
    fn set_draw_theme(&mut self, theme: Theme) {
        self.theme = theme;
        self.window.request_redraw();
    }

    /// Show window menu.
    fn show_menu(&self) {
        if let Some(position) = self.cursor_position {
            self.window.show_window_menu(position);
        }
    }

    /// Drag the window.
    fn drag_window(&self) {
        if let Err(err) = self.window.drag_window() {
            info!("Error starting window drag: {err}");
        } else {
            info!("Dragging window Window={:?}", self.window.id());
        }
    }

    /// Drag-resize the window.
    fn drag_resize_window(&self) {
        let position = match self.cursor_position {
            Some(position) => position,
            None => {
                info!("Drag-resize requires cursor to be inside the window");
                return;
            },
        };

        let win_size = self.window.inner_size();
        let border_size = BORDER_SIZE * self.window.scale_factor();

        let x_direction = if position.x < border_size {
            ResizeDirection::West
        } else if position.x > (win_size.width as f64 - border_size) {
            ResizeDirection::East
        } else {
            // Use arbitrary direction instead of None for simplicity.
            ResizeDirection::SouthEast
        };

        let y_direction = if position.y < border_size {
            ResizeDirection::North
        } else if position.y > (win_size.height as f64 - border_size) {
            ResizeDirection::South
        } else {
            // Use arbitrary direction instead of None for simplicity.
            ResizeDirection::SouthEast
        };

        let direction = match (x_direction, y_direction) {
            (ResizeDirection::West, ResizeDirection::North) => ResizeDirection::NorthWest,
            (ResizeDirection::West, ResizeDirection::South) => ResizeDirection::SouthWest,
            (ResizeDirection::West, _) => ResizeDirection::West,
            (ResizeDirection::East, ResizeDirection::North) => ResizeDirection::NorthEast,
            (ResizeDirection::East, ResizeDirection::South) => ResizeDirection::SouthEast,
            (ResizeDirection::East, _) => ResizeDirection::East,
            (_, ResizeDirection::South) => ResizeDirection::South,
            (_, ResizeDirection::North) => ResizeDirection::North,
            _ => return,
        };

        if let Err(err) = self.window.drag_resize_window(direction) {
            info!("Error starting window drag-resize: {err}");
        } else {
            info!("Drag-resizing window Window={:?}", self.window.id());
        }
    }

    /// Change window occlusion state.
    fn set_occluded(&mut self, occluded: bool) {
        self.occluded = occluded;
        if !occluded {
            self.window.request_redraw();
        }
    }

    /// Draw the window contents.
    #[cfg(not(any(android_platform, ios_platform)))]
    fn draw(&mut self) -> Result<(), Box<dyn Error>> {
        if self.occluded {
            info!("Skipping drawing occluded window={:?}", self.window.id());
            return Ok(());
        }

        self.pipeline.render_display_frame(&mut self.gui, &self.window, self.game_mode, self.glass_blur_enabled);

        #[cfg(target_os = "windows")]
        if !self.game_mode {
            if let Some(webview) = &self.webview {
                if let Some(editor) = &mut self.pipeline.export_editor {
                    if let Some(bounds) = editor.wry_webview_bounds {
                        let scale_factor = self.window.scale_factor();
                        
                        let x = (bounds[0] * scale_factor as f32) as i32;
                        let y = (bounds[1] * scale_factor as f32) as i32;
                        let width = (bounds[2] * scale_factor as f32) as u32;
                        let height = (bounds[3] * scale_factor as f32) as u32;
                        
                        webview.set_bounds(wry::Rect {
                            position: wry::dpi::Position::Physical(wry::dpi::PhysicalPosition::new(x, y)),
                            size: wry::dpi::Size::Physical(wry::dpi::PhysicalSize::new(width, height)),
                        });
                        webview.set_visible(true);
                        editor.webview_visible = true;
                    } else {
                        if editor.webview_visible {
                            webview.focus_parent();
                        }

                        webview.set_visible(false);
                        editor.webview_visible = false;
                    }

                    // Process pending scripts
                    let scripts: Vec<String> = std::mem::take(&mut editor.pending_webview_scripts);
                    for script in scripts {
                        if let Err(e) = webview.evaluate_script(&script) {
                            error!("Failed to evaluate script in webview: {}", e);
                        }
                    }
                }
            }
        }

        Ok(())
    }

    #[cfg(any(android_platform, ios_platform))]
    fn draw(&mut self) -> Result<(), Box<dyn Error>> {
        info!("Drawing but without rendering...");
        Ok(())
    }
}

struct Binding<T: Eq> {
    trigger: T,
    mods: ModifiersState,
    action: Action,
}

impl<T: Eq> Binding<T> {
    const fn new(trigger: T, mods: ModifiersState, action: Action) -> Self {
        Self { trigger, mods, action }
    }

    fn is_triggered_by(&self, trigger: &T, mods: &ModifiersState) -> bool {
        &self.trigger == trigger && &self.mods == mods
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    CloseWindow,
    ToggleCursorVisibility,
    CreateNewWindow,
    ToggleResizeIncrements,
    ToggleImeInput,
    ToggleDecorations,
    ToggleResizable,
    ToggleFullscreen,
    ToggleMaximize,
    Minimize,
    NextCursor,
    NextCustomCursor,
    #[cfg(web_platform)]
    UrlCustomCursor,
    #[cfg(web_platform)]
    AnimationCustomCursor,
    CycleCursorGrab,
    PrintHelp,
    DragWindow,
    DragResizeWindow,
    ShowWindowMenu,
    #[cfg(macos_platform)]
    CycleOptionAsAlt,
    SetTheme(Option<Theme>),
    #[cfg(macos_platform)]
    CreateNewTab,
    RequestResize,
}

impl Action {
    fn help(&self) -> &'static str {
        match self {
            Action::CloseWindow => "Close window",
            Action::ToggleCursorVisibility => "Hide cursor",
            Action::CreateNewWindow => "Create new window",
            Action::ToggleImeInput => "Toggle IME input",
            Action::ToggleDecorations => "Toggle decorations",
            Action::ToggleResizable => "Toggle window resizable state",
            Action::ToggleFullscreen => "Toggle fullscreen",
            Action::ToggleMaximize => "Maximize",
            Action::Minimize => "Minimize",
            Action::ToggleResizeIncrements => "Use resize increments when resizing window",
            Action::NextCursor => "Advance the cursor to the next value",
            Action::NextCustomCursor => "Advance custom cursor to the next value",
            #[cfg(web_platform)]
            Action::UrlCustomCursor => "Custom cursor from an URL",
            #[cfg(web_platform)]
            Action::AnimationCustomCursor => "Custom cursor from an animation",
            Action::CycleCursorGrab => "Cycle through cursor grab mode",
            Action::PrintHelp => "Print help",
            Action::DragWindow => "Start window drag",
            Action::DragResizeWindow => "Start window drag-resize",
            Action::ShowWindowMenu => "Show window menu",
            #[cfg(macos_platform)]
            Action::CycleOptionAsAlt => "Cycle option as alt mode",
            Action::SetTheme(None) => "Change to the system theme",
            Action::SetTheme(Some(Theme::Light)) => "Change to a light theme",
            Action::SetTheme(Some(Theme::Dark)) => "Change to a dark theme",
            #[cfg(macos_platform)]
            Action::CreateNewTab => "Create new tab",
            Action::RequestResize => "Request a resize",
        }
    }
}

impl fmt::Display for Action {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        Debug::fmt(&self, f)
    }
}

fn decode_cursor(bytes: &[u8]) -> CustomCursorSource {
    let img = image::load_from_memory(bytes).unwrap().to_rgba8();
    let samples = img.into_flat_samples();
    let (_, w, h) = samples.extents();
    let (w, h) = (w as u16, h as u16);
    CustomCursor::from_rgba(samples.samples, w, h, w / 2, h / 2).unwrap()
}

#[cfg(web_platform)]
fn url_custom_cursor() -> CustomCursorSource {
    use std::sync::atomic::{AtomicU64, Ordering};

    use winit::platform::web::CustomCursorExtWebSys;

    static URL_COUNTER: AtomicU64 = AtomicU64::new(0);

    CustomCursor::from_url(
        format!("https://picsum.photos/128?random={}", URL_COUNTER.fetch_add(1, Ordering::Relaxed)),
        64,
        64,
    )
}

fn load_icon(bytes: &[u8]) -> Icon {
    let (icon_rgba, icon_width, icon_height) = {
        let image = image::load_from_memory(bytes).unwrap().into_rgba8();
        let (width, height) = image.dimensions();
        let rgba = image.into_raw();
        (rgba, width, height)
    };
    Icon::from_rgba(icon_rgba, icon_width, icon_height).expect("Failed to open icon")
}

/// Load a window icon from an embedder-supplied path (any format the `image` crate decodes -
/// PNG, ICO, etc). Fallible, unlike [`load_icon`]: a bad icon path is a cosmetic problem, not a
/// reason to abort startup, so callers log and continue without a custom icon on error.
fn load_icon_from_path(path: &std::path::Path) -> Result<Icon, Box<dyn Error>> {
    // Taskbar/titlebar icons don't need to be large, and an embedder's source image (a logo,
    // a marketing asset) is rarely already a small square - downscale rather than require them
    // to pre-process it themselves.
    const ICON_SIZE: u32 = 64;
    let image = image::open(path)?
        .resize_exact(ICON_SIZE, ICON_SIZE, image::imageops::FilterType::Lanczos3)
        .into_rgba8();
    let (width, height) = image.dimensions();
    Ok(Icon::from_rgba(image.into_raw(), width, height)?)
}

fn modifiers_to_string(mods: ModifiersState) -> String {
    let mut mods_line = String::new();
    // Always add + since it's printed as a part of the bindings.
    for (modifier, desc) in [
        (ModifiersState::SUPER, "Super+"),
        (ModifiersState::ALT, "Alt+"),
        (ModifiersState::CONTROL, "Ctrl+"),
        (ModifiersState::SHIFT, "Shift+"),
    ] {
        if !mods.contains(modifier) {
            continue;
        }

        mods_line.push_str(desc);
    }
    mods_line
}

fn mouse_button_to_string(button: MouseButton) -> &'static str {
    match button {
        MouseButton::Left => "LMB",
        MouseButton::Right => "RMB",
        MouseButton::Middle => "MMB",
        MouseButton::Back => "Back",
        MouseButton::Forward => "Forward",
        MouseButton::Other(_) => "",
    }
}

/// Cursor list to cycle through.
const CURSORS: &[CursorIcon] = &[
    CursorIcon::Default,
    CursorIcon::Crosshair,
    CursorIcon::Pointer,
    CursorIcon::Move,
    CursorIcon::Text,
    CursorIcon::Wait,
    CursorIcon::Help,
    CursorIcon::Progress,
    CursorIcon::NotAllowed,
    CursorIcon::ContextMenu,
    CursorIcon::Cell,
    CursorIcon::VerticalText,
    CursorIcon::Alias,
    CursorIcon::Copy,
    CursorIcon::NoDrop,
    CursorIcon::Grab,
    CursorIcon::Grabbing,
    CursorIcon::AllScroll,
    CursorIcon::ZoomIn,
    CursorIcon::ZoomOut,
    CursorIcon::EResize,
    CursorIcon::NResize,
    CursorIcon::NeResize,
    CursorIcon::NwResize,
    CursorIcon::SResize,
    CursorIcon::SeResize,
    CursorIcon::SwResize,
    CursorIcon::WResize,
    CursorIcon::EwResize,
    CursorIcon::NsResize,
    CursorIcon::NeswResize,
    CursorIcon::NwseResize,
    CursorIcon::ColResize,
    CursorIcon::RowResize,
];

const KEY_BINDINGS: &[Binding<&'static str>] = &[
    // Binding::new("Q", ModifiersState::CONTROL, Action::CloseWindow),
    // Binding::new("H", ModifiersState::CONTROL, Action::PrintHelp),
    // Binding::new("F", ModifiersState::CONTROL, Action::ToggleFullscreen),
    // Binding::new("D", ModifiersState::CONTROL, Action::ToggleDecorations),
    // Binding::new("I", ModifiersState::CONTROL, Action::ToggleImeInput),
    // Binding::new("L", ModifiersState::CONTROL, Action::CycleCursorGrab),
    // Binding::new("P", ModifiersState::CONTROL, Action::ToggleResizeIncrements),
    // Binding::new("R", ModifiersState::CONTROL, Action::ToggleResizable),
    // Binding::new("R", ModifiersState::ALT, Action::RequestResize),
    // // M.
    // Binding::new("M", ModifiersState::CONTROL, Action::ToggleMaximize),
    // Binding::new("M", ModifiersState::ALT, Action::Minimize),
    // // N.
    // Binding::new("N", ModifiersState::CONTROL, Action::CreateNewWindow),
    // // C.
    // Binding::new("C", ModifiersState::CONTROL, Action::NextCursor),
    // Binding::new("C", ModifiersState::ALT, Action::NextCustomCursor),
    // #[cfg(web_platform)]
    // Binding::new(
    //     "C",
    //     ModifiersState::CONTROL.union(ModifiersState::SHIFT),
    //     Action::UrlCustomCursor,
    // ),
    // #[cfg(web_platform)]
    // Binding::new(
    //     "C",
    //     ModifiersState::ALT.union(ModifiersState::SHIFT),
    //     Action::AnimationCustomCursor,
    // ),
    // Binding::new("Z", ModifiersState::CONTROL, Action::ToggleCursorVisibility),
    // // K.
    // Binding::new("K", ModifiersState::empty(), Action::SetTheme(None)),
    // Binding::new("K", ModifiersState::SUPER, Action::SetTheme(Some(Theme::Light))),
    // Binding::new("K", ModifiersState::CONTROL, Action::SetTheme(Some(Theme::Dark))),
    // #[cfg(macos_platform)]
    // Binding::new("T", ModifiersState::SUPER, Action::CreateNewTab),
    // #[cfg(macos_platform)]
    // Binding::new("O", ModifiersState::CONTROL, Action::CycleOptionAsAlt),
];

const MOUSE_BINDINGS: &[Binding<MouseButton>] = &[
    // Binding::new(MouseButton::Left, ModifiersState::ALT, Action::DragResizeWindow),
    // Binding::new(MouseButton::Left, ModifiersState::CONTROL, Action::DragWindow),
    // Binding::new(MouseButton::Right, ModifiersState::CONTROL, Action::ShowWindowMenu),
];
