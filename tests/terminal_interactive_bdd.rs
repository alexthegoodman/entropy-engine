//! Machine-specific BDD confirmation that interactive TUI programs (Claude Code, Codex) actually
//! run inside the terminal's pseudo-terminal: they see a real terminal, render, answer a forward
//! slash command, and quit on `/exit`. Only forward-slash commands that make no model request are
//! used (`/help`, `/exit`), so this never costs any tokens.
//!
//! Scenarios are skipped (trivially) when the tool is not installed, so this suite stays green on
//! machines without them. The pty plumbing itself is covered platform-independently by
//! `terminal_bdd.rs`.

use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

use cucumber::{given, then, when, World as _};
use entropy_engine::deno::terminal_ops::{TerminalManager, GLOBAL_TERMINAL_MANAGER};

#[derive(cucumber::World)]
pub struct InteractiveWorld {
    program: Option<String>,
    session_id: String,
    last_pid: Option<u32>,
}

impl std::fmt::Debug for InteractiveWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "InteractiveWorld(program={:?})", self.program)
    }
}

impl Default for InteractiveWorld {
    fn default() -> Self {
        Self {
            program: None,
            session_id: String::new(),
            last_pid: None,
        }
    }
}

/// Whether `name` resolves on the machine (the same way `cmd /c <name>` would).
fn is_available(name: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        matches!(
            Command::new("cmd").args(["/c", "where", name]).output(),
            Ok(o) if o.status.success() && !o.stdout.is_empty()
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        matches!(
            Command::new("sh").args(["-c", "command -v \"$1\"", "sh", name]).output(),
            Ok(o) if o.status.success() && !o.stdout.is_empty()
        )
    }
}

fn poll_text(session_id: &str) -> String {
    GLOBAL_TERMINAL_MANAGER.lock().unwrap().poll_status(session_id).text
}

fn poll_running(session_id: &str) -> bool {
    GLOBAL_TERMINAL_MANAGER.lock().unwrap().poll_status(session_id).is_running
}

#[given(expr = "the interactive program {string} is installed")]
fn program_installed(world: &mut InteractiveWorld, name: String) {
    if is_available(&name) {
        world.program = Some(name.clone());
        world.session_id = format!("interactive-{name}");
    } else {
        eprintln!("[skip] '{name}' is not installed or not on PATH - scenario passes trivially");
        world.program = None;
    }
}

#[when(expr = "I start it in a new terminal session")]
fn start_program(world: &mut InteractiveWorld) {
    if world.program.is_none() {
        return;
    }
    let name = world.program.clone().unwrap();
    // A single word, so the default cmd shell runs the Volta shim directly - no quoting involved.
    let pid = TerminalManager::execute(&GLOBAL_TERMINAL_MANAGER, &world.session_id, &name, None, None)
        .expect("Failed to start the interactive program");
    world.last_pid = Some(pid);
}

#[then(expr = "it should be running within {int} ms")]
fn should_be_running(world: &mut InteractiveWorld, timeout_ms: i32) {
    if world.program.is_none() {
        return;
    }
    let start = Instant::now();
    let timeout = Duration::from_millis(timeout_ms as u64);
    let mut running = false;
    while start.elapsed() < timeout {
        if poll_running(&world.session_id) {
            running = true;
            break;
        }
        sleep(Duration::from_millis(200));
    }
    let text = poll_text(&world.session_id);
    assert!(running, "program did not start within {}ms. Output:\n{}", timeout_ms, text);
}

#[then(expr = "it should render output within {int} ms")]
fn should_render(world: &mut InteractiveWorld, timeout_ms: i32) {
    if world.program.is_none() {
        return;
    }
    let start = Instant::now();
    let timeout = Duration::from_millis(timeout_ms as u64);
    let mut rendered = false;
    while start.elapsed() < timeout {
        if poll_text(&world.session_id).trim().len() > 20 {
            rendered = true;
            break;
        }
        sleep(Duration::from_millis(200));
    }
    let text = poll_text(&world.session_id);
    assert!(rendered, "program produced no output within {}ms. Output:\n{}", timeout_ms, text);
}

#[when(expr = "I type {string}")]
fn type_command(world: &mut InteractiveWorld, input: String) {
    if world.program.is_none() {
        return;
    }
    let data = format!("{input}\r");
    GLOBAL_TERMINAL_MANAGER.lock().unwrap().write_input(&world.session_id, &data).expect("write_input failed");
}

#[when(expr = "I press Enter")]
fn press_enter(world: &mut InteractiveWorld) {
    if world.program.is_none() {
        return;
    }
    GLOBAL_TERMINAL_MANAGER.lock().unwrap().write_input(&world.session_id, "\r").expect("write_input failed");
}

// Select the trust dialog's "Yes, I trust this folder" (Down arrow, then Enter).
#[when(expr = "I trust the folder")]
fn trust_folder(world: &mut InteractiveWorld) {
    if world.program.is_none() {
        return;
    }
    GLOBAL_TERMINAL_MANAGER.lock().unwrap().write_input(&world.session_id, "\x1b[B\r").expect("write_input failed");
}

#[then(expr = "it should still be running after {int} ms")]
fn still_running_after(world: &mut InteractiveWorld, timeout_ms: i32) {
    if world.program.is_none() {
        return;
    }
    // Give the TUI time to process the previous command before the next one arrives.
    sleep(Duration::from_millis(timeout_ms as u64));
    let status = GLOBAL_TERMINAL_MANAGER.lock().unwrap().poll_status(&world.session_id);
    assert!(status.is_running, "program exited unexpectedly after a slash command. Output:\n{}", status.text);
}

#[then(expr = "it should exit within {int} ms")]
fn should_exit(world: &mut InteractiveWorld, timeout_ms: i32) {
    if world.program.is_none() {
        return;
    }
    let start = Instant::now();
    let timeout = Duration::from_millis(timeout_ms as u64);
    let mut exited = false;
    while start.elapsed() < timeout {
        if !poll_running(&world.session_id) {
            exited = true;
            break;
        }
        sleep(Duration::from_millis(200));
    }
    let status = GLOBAL_TERMINAL_MANAGER.lock().unwrap().poll_status(&world.session_id);
    assert!(
        exited,
        "program did not exit after /exit within {}ms. running={}, exit_code={:?}, text:\n{}",
        timeout_ms, status.is_running, status.exit_code, status.text
    );
}

fn main() {
    futures::executor::block_on(
        InteractiveWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/terminal_interactive.feature"),
    );
}
