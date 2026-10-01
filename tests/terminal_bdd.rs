//! Headless BDD test suite for Terminal operations and TerminalView widget.

use std::thread::sleep;
use std::time::{Duration, Instant};

use cucumber::{given, then, when, World as _};
use entropy_engine::deno::terminal_ops::{TerminalManager, GLOBAL_TERMINAL_MANAGER};
use entropy_engine::entropy_gui::draw_list::DrawCommand;
use entropy_engine::entropy_gui::widgets_terminal::{TerminalLine, TerminalLineKind, TerminalTheme, TerminalView};

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

#[derive(cucumber::World)]
pub struct TerminalWorld {
    session_id: String,
    last_pid: Option<u32>,
    view_lines: Vec<TerminalLine>,
    pending_draw: Vec<DrawCommand>,
    harness: Harness,
    font_names: Vec<String>,
}

impl std::fmt::Debug for TerminalWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "TerminalWorld(session={})", self.session_id)
    }
}

impl Default for TerminalWorld {
    fn default() -> Self {
        Self {
            session_id: "default_test".to_string(),
            last_pid: None,
            view_lines: Vec::new(),
            pending_draw: Vec::new(),
            harness: Harness::new(800, 600),
            font_names: Vec::new(),
        }
    }
}

#[given(expr = "a new terminal session {string}")]
fn new_terminal_session(world: &mut TerminalWorld, id: String) {
    world.session_id = id;
    let _ = TerminalManager::execute(&GLOBAL_TERMINAL_MANAGER, &world.session_id, "clear", None, None);
    world.last_pid = None;
}

#[when(expr = "I execute terminal command {string}")]
fn execute_terminal_command(world: &mut TerminalWorld, cmd: String) {
    let pid = TerminalManager::execute(&GLOBAL_TERMINAL_MANAGER, &world.session_id, &cmd, None, None)
        .expect("Command execution failed");
    world.last_pid = Some(pid);
}

#[then(expr = "the session should have {int} lines")]
fn session_should_have_lines(world: &mut TerminalWorld, count: i32) {
    let status = GLOBAL_TERMINAL_MANAGER.lock().unwrap().poll_status(&world.session_id);
    assert_eq!(status.lines.len(), count as usize, "Expected {} lines, got {}", count, status.lines.len());
}

#[then(expr = "line {int} text should contain the current working directory")]
fn line_text_contains_cwd(world: &mut TerminalWorld, line_num: i32) {
    let status = GLOBAL_TERMINAL_MANAGER.lock().unwrap().poll_status(&world.session_id);
    let idx = (line_num - 1) as usize;
    assert!(idx < status.lines.len(), "Line index out of bounds");
    let line_text = &status.lines[idx].text;
    assert!(
        line_text.contains(&status.cwd) || status.cwd.contains(line_text),
        "Expected line text '{}' to relate to cwd '{}'",
        line_text,
        status.cwd
    );
}

#[then(expr = "the session output should be empty")]
fn session_output_empty(world: &mut TerminalWorld) {
    let status = GLOBAL_TERMINAL_MANAGER.lock().unwrap().poll_status(&world.session_id);
    assert!(status.lines.is_empty(), "Expected empty lines, got {}", status.lines.len());
}

#[then(expr = "the command should start a background process")]
fn command_starts_background_process(world: &mut TerminalWorld) {
    assert!(world.last_pid.is_some(), "PID was not returned");
    assert!(world.last_pid.unwrap() > 0, "PID was zero");
}

#[then(expr = "after waiting up to {int} ms the process should finish with exit code {int}")]
fn wait_process_finish(world: &mut TerminalWorld, timeout_ms: i32, expected_code: i32) {
    let start = Instant::now();
    let timeout = Duration::from_millis(timeout_ms as u64);
    let mut finished = false;

    while start.elapsed() < timeout {
        let status = GLOBAL_TERMINAL_MANAGER.lock().unwrap().poll_status(&world.session_id);
        if !status.is_running && status.exit_code == Some(expected_code) {
            finished = true;
            break;
        }
        sleep(Duration::from_millis(50));
    }

    let final_status = GLOBAL_TERMINAL_MANAGER.lock().unwrap().poll_status(&world.session_id);
    assert!(
        finished,
        "Process did not finish with exit code {} within {}ms. Status: running={}, exit_code={:?}",
        expected_code, timeout_ms, final_status.is_running, final_status.exit_code
    );
}

#[then(expr = "the session output should contain {string}")]
fn session_output_contains(world: &mut TerminalWorld, expected: String) {
    let start = Instant::now();
    let mut found = false;
    let mut all_text = String::new();

    while start.elapsed() < Duration::from_millis(1500) {
        let status = GLOBAL_TERMINAL_MANAGER.lock().unwrap().poll_status(&world.session_id);
        all_text = status.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n");
        if all_text.contains(&expected) {
            found = true;
            break;
        }
        sleep(Duration::from_millis(50));
    }

    assert!(found, "Output did not contain '{}'. Full output:\n{}", expected, all_text);
}

#[when(expr = "I execute long running command {string}")]
fn execute_long_running(world: &mut TerminalWorld, cmd: String) {
    let pid = TerminalManager::execute(&GLOBAL_TERMINAL_MANAGER, &world.session_id, &cmd, None, None)
        .expect("Failed to start long running command");
    world.last_pid = Some(pid);
    sleep(Duration::from_millis(200));
}

#[then(expr = "the session is currently running")]
fn session_is_running(world: &mut TerminalWorld) {
    let status = GLOBAL_TERMINAL_MANAGER.lock().unwrap().poll_status(&world.session_id);
    assert!(status.is_running, "Expected session to be running, but is_running was false");
}

#[when(expr = "I terminate the running process")]
fn terminate_process(world: &mut TerminalWorld) {
    GLOBAL_TERMINAL_MANAGER.lock().unwrap().kill(&world.session_id).expect("Kill failed");
}

#[then(expr = "the process should be stopped within {int} ms")]
fn process_stopped_within(world: &mut TerminalWorld, timeout_ms: i32) {
    let start = Instant::now();
    let timeout = Duration::from_millis(timeout_ms as u64);
    let mut stopped = false;

    while start.elapsed() < timeout {
        let status = GLOBAL_TERMINAL_MANAGER.lock().unwrap().poll_status(&world.session_id);
        if !status.is_running {
            stopped = true;
            break;
        }
        sleep(Duration::from_millis(50));
    }

    assert!(stopped, "Process was not stopped within {} ms", timeout_ms);
}

#[given(expr = "a terminal view with {int} output lines")]
fn terminal_view_with_lines(world: &mut TerminalWorld, count: i32) {
    world.view_lines = (0..count)
        .map(|i| TerminalLine::new(i as u64, TerminalLineKind::Stdout, format!("Log line {i}"), "12:00:00"))
        .collect();
}

#[when(expr = "I render the terminal view with font {string} and size {int}")]
fn render_with_font_and_size(world: &mut TerminalWorld, font: String, size: i32) {
    let lines = world.view_lines.clone();
    world.pending_draw = world.harness.run(Default::default(), 0.0, |ui| {
        TerminalView::new("term_view_test", &lines)
            .font_family(font)
            .font_size(size as f32)
            .show(ui);
    });
}

#[then(expr = "the widget allocates space and renders draw commands")]
fn widget_renders_commands(world: &mut TerminalWorld) {
    assert!(!world.pending_draw.is_empty(), "Expected draw commands, got empty list");
}

#[when(expr = "I render the terminal view with font {string} and theme {string}")]
fn render_with_font_and_theme(world: &mut TerminalWorld, font: String, theme_name: String) {
    let lines = world.view_lines.clone();
    let theme = TerminalTheme::from_name(&theme_name);
    world.pending_draw = world.harness.run(Default::default(), 0.0, |ui| {
        TerminalView::new("term_view_test", &lines)
            .font_family(font)
            .theme(theme)
            .show(ui);
    });
}

#[then(expr = "the widget renders with non-zero draw commands")]
fn widget_renders_nonzero_commands(world: &mut TerminalWorld) {
    assert!(!world.pending_draw.is_empty(), "Draw list is empty");
}

#[given(expr = "the terminal font catalog")]
fn load_font_catalog(world: &mut TerminalWorld) {
    world.font_names = entropy_engine::renderer_text::fonts::CANONICAL_FONT_NAMES
        .iter()
        .map(|s| s.to_string())
        .collect();
}

#[then(expr = "it contains at least {int} fonts")]
fn font_catalog_min_count(world: &mut TerminalWorld, count: i32) {
    assert!(
        world.font_names.len() >= count as usize,
        "Expected at least {} fonts, got {}",
        count,
        world.font_names.len()
    );
}

#[then(expr = "it contains {string}")]
fn font_catalog_contains(world: &mut TerminalWorld, font: String) {
    assert!(
        world.font_names.iter().any(|f| f.eq_ignore_ascii_case(&font)),
        "Catalog did not contain font '{}'. Available: {:?}",
        font,
        world.font_names
    );
}

fn main() {
    futures::executor::block_on(
        TerminalWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/terminal.feature"),
    );
}
