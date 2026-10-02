//! Headless BDD test suite for Terminal operations and TerminalView widget.
//!
//! The fast tier here covers the pseudo-terminal pipeline with guaranteed-available programs
//! (the shell, `node`) - real stdin round-trips, colour parsing, built-ins and termination - so
//! the interactive-tool scenarios in `terminal_interactive_bdd.rs` (claude/codex) can assume the
//! plumbing already works.

use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::{Duration, Instant};

use cucumber::{given, then, when, World as _};
use entropy_engine::deno::terminal_ops::{TerminalManager, build_screen, GLOBAL_TERMINAL_MANAGER};
use entropy_engine::entropy_gui::draw_list::DrawCommand;
use entropy_engine::entropy_gui::widgets_terminal::{TerminalRun, TerminalScreen, TerminalView};
use vt100::Parser;

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

#[derive(cucumber::World)]
pub struct TerminalWorld {
    session_id: String,
    last_pid: Option<u32>,
    view_screen: TerminalScreen,
    pending_draw: Vec<DrawCommand>,
    harness: Harness,
    font_names: Vec<String>,
    parsed: Option<(TerminalScreen, String)>,
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
            view_screen: TerminalScreen::empty(10, 40),
            pending_draw: Vec::new(),
            harness: Harness::new(800, 600),
            font_names: Vec::new(),
            parsed: None,
        }
    }
}

fn status_text(session_id: &str) -> String {
    GLOBAL_TERMINAL_MANAGER.lock().unwrap().poll_status(session_id).text
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

#[when(expr = "I execute long running command {string}")]
fn execute_long_running(world: &mut TerminalWorld, cmd: String) {
    let pid = TerminalManager::execute(&GLOBAL_TERMINAL_MANAGER, &world.session_id, &cmd, None, None)
        .expect("Failed to start long running command");
    world.last_pid = Some(pid);
    sleep(Duration::from_millis(300));
}

// The node one-liner has inner double quotes, which cucumber `{string}` does not unescape, so it
// is hardcoded here rather than passed through the feature file.
// PowerShell (not cmd) receives the script as one literal argument via `-Command`, so inner
// quotes/parentheses survive without cmd's `/c` re-parsing mangling them.
#[when(expr = "I start an echo-back process")]
fn start_echo_back(world: &mut TerminalWorld) {
    let cmd = "$x = Read-Host 'in'; Write-Output ('got:' + $x)";
    let pid = TerminalManager::execute(&GLOBAL_TERMINAL_MANAGER, &world.session_id, cmd, None, Some("powershell"))
        .expect("Failed to start echo-back process");
    world.last_pid = Some(pid);
    sleep(Duration::from_millis(500));
}

#[when(expr = "I probe raw key delivery")]
fn probe_raw_key(world: &mut TerminalWorld) {
    let spawn = |sess: &str| {
        let cmd = "$k=[Console]::ReadKey($true); Write-Output ('KEY=' + [int]$k.Key + ' CHAR=' + [int]$k.KeyChar)";
        let _ = TerminalManager::execute(&GLOBAL_TERMINAL_MANAGER, sess, cmd, None, Some("powershell")).expect("probe spawn failed");
        sleep(Duration::from_millis(400));
    };
    let probe = |sess: &str, label: &str, bytes: &str| {
        spawn(sess);
        GLOBAL_TERMINAL_MANAGER.lock().unwrap().write_input(sess, bytes).expect("write failed");
        sleep(Duration::from_millis(700));
        let status = GLOBAL_TERMINAL_MANAGER.lock().unwrap().poll_status(sess);
        eprintln!("[probe] {label} => running={} text={:?}", status.is_running, status.text);
    };
    probe("probe-cr", "ENTER(\\r)", "\r");
    probe("probe-lf", "ENTER(\\n)", "\n");
    probe("probe-crlf", "ENTER(\\r\\n)", "\r\n");
    probe("probe-down", "DOWN(\\x1b[B)", "\x1b[B");
}

#[when(expr = "I type {string} into the terminal")]
fn type_into_terminal(world: &mut TerminalWorld, input: String) {
    let mut data = input;
    data.push('\r');
    GLOBAL_TERMINAL_MANAGER.lock().unwrap().write_input(&world.session_id, &data).expect("write_input failed");
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
        all_text = status_text(&world.session_id);
        if all_text.contains(&expected) {
            found = true;
            break;
        }
        sleep(Duration::from_millis(50));
    }

    assert!(found, "Output did not contain '{}'. Full output:\n{}", expected, all_text);
}

#[then(expr = "the session output should be empty")]
fn session_output_empty(world: &mut TerminalWorld) {
    let text = status_text(&world.session_id);
    assert!(text.trim().is_empty(), "Expected empty output, got: {:?}", text);
}

#[then(expr = "the session output should contain the current working directory")]
fn output_contains_cwd(world: &mut TerminalWorld) {
    let status = GLOBAL_TERMINAL_MANAGER.lock().unwrap().poll_status(&world.session_id);
    assert!(
        status.text.contains(&status.cwd) || status.cwd.contains(&status.text),
        "Expected output to relate to cwd '{}', got: {:?}",
        status.cwd,
        status.text
    );
}

#[then(expr = "the session is currently running")]
fn session_is_running(world: &mut TerminalWorld) {
    let status = GLOBAL_TERMINAL_MANAGER.lock().unwrap().poll_status(&world.session_id);
    assert!(
        status.is_running,
        "Expected session to be running, but is_running was false. exit_code={:?}, text={:?}",
        status.exit_code,
        status.text
    );
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

// --- Widget rendering ---

#[given(expr = "a terminal screen with {int} rows")]
fn terminal_screen_with_rows(world: &mut TerminalWorld, rows: u16) {
    let mut lines = Vec::new();
    for r in 0..rows {
        lines.push(vec![TerminalRun::plain(format!("Log line {r}"))]);
    }
    world.view_screen = TerminalScreen {
        rows,
        cols: 40,
        cursor_row: 0,
        cursor_col: 0,
        cursor_visible: false,
        lines,
    };
}

#[when(expr = "I render the terminal view")]
fn render_terminal_view(world: &mut TerminalWorld) {
    let screen = world.view_screen.clone();
    world.pending_draw = world.harness.run(Default::default(), 0.0, |ui| {
        TerminalView::new("term_view_test", &screen).show(ui);
    });
}

#[then(expr = "the widget allocates space and renders draw commands")]
fn widget_renders_commands(world: &mut TerminalWorld) {
    assert!(!world.pending_draw.is_empty(), "Expected draw commands, got empty list");
}

// --- Colour parsing ---

#[given(expr = "a parser fed with red and green text")]
fn parser_with_colours(world: &mut TerminalWorld) {
    let parser = Arc::new(Mutex::new(Parser::new(5, 20, 0)));
    {
        let mut p = parser.lock().unwrap();
        p.process(b"\x1b[31mRED\x1b[0m \x1b[32mGREEN\x1b[0m");
    }
    world.parsed = Some(build_screen(&parser));
}

#[then(expr = "the screen has red and green cells")]
fn screen_has_red_and_green(world: &mut TerminalWorld) {
    let (screen, text) = world.parsed.as_ref().expect("parser step must run first");
    let all_runs: Vec<&TerminalRun> = screen.lines.iter().flatten().collect();
    assert!(all_runs.iter().any(|r| r.fg == Some([205, 0, 0])), "no red cells in {:?}", text);
    assert!(all_runs.iter().any(|r| r.fg == Some([0, 205, 0])), "no green cells in {:?}", text);
}

// --- Font catalog ---

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
