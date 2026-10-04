//! Terminal operations and session management for Entropy Engine.
//!
//! Spawns real OS processes attached to a native pseudo-terminal (ConPTY on Windows, posix_openpt
//! on Unix) so interactive TUI programs - Claude Code, Codex, vim, etc. - see a real terminal:
//! `isTTY` is true, ANSI/VT output is parsed into a grid by `vt100`, and keystrokes are forwarded
//! through the pty master. The `TerminalView` widget draws that grid.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use deno_core::op2;
use deno_core::OpState;
use lazy_static::lazy_static;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use vt100::Parser;

use crate::deno::addon_ops::{AddonContext, UiWidget};
use crate::entropy_gui::widgets_terminal::{TerminalRun, TerminalScreen};

const DEFAULT_ROWS: u16 = 50;
const DEFAULT_COLS: u16 = 200;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStatusConfig {
    pub is_running: bool,
    pub exit_code: Option<i32>,
    pub cwd: String,
    pub pid: Option<u32>,
    pub screen: TerminalScreen,
    pub text: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWidgetConfig {
    pub id: String,
    pub screen: TerminalScreen,
    pub is_running: Option<bool>,
    pub font_size: Option<f32>,
    pub font_family: Option<String>,
    pub theme: Option<String>,
    pub height: Option<f32>,
    pub auto_scroll: Option<bool>,
}

struct RunningProcess {
    pid: u32,
    writer_tx: mpsc::Sender<Vec<u8>>,
    start_time: Instant,
}

pub struct TerminalSession {
    pub session_id: String,
    pub cwd: PathBuf,
    pub exit_code: Option<i32>,
    pub parser: Arc<Mutex<Parser>>,
    pub history: Vec<String>,
    running: Option<RunningProcess>,
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    /// The pty master must stay alive for the lifetime of the child: dropping it closes the
    /// pseudo-terminal and kills the process (Windows ConPTY reports STATUS_DLL_INIT_FAILED).
    master: Option<Box<dyn portable_pty::MasterPty + Send>>,
}

impl TerminalSession {
    pub fn new(session_id: impl Into<String>, initial_cwd: PathBuf) -> Self {
        Self {
            session_id: session_id.into(),
            cwd: initial_cwd,
            exit_code: None,
            parser: Arc::new(Mutex::new(Parser::new(DEFAULT_ROWS, DEFAULT_COLS, 0))),
            history: Vec::new(),
            running: None,
            child: None,
            master: None,
        }
    }

    /// Feed raw bytes into the terminal parser (used by built-ins and the reader thread).
    fn feed(&self, bytes: &[u8]) {
        if let Ok(mut parser) = self.parser.lock() {
            parser.process(bytes);
        }
    }

    fn write_line(&self, kind: &str, text: &str) {
        let _ = kind;
        self.feed(format!("{text}\r\n").as_bytes());
    }
}

pub struct TerminalManager {
    sessions: HashMap<String, TerminalSession>,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn get_or_create(&mut self, session_id: &str) -> &mut TerminalSession {
        self.sessions.entry(session_id.to_string()).or_insert_with(|| {
            let initial_cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            TerminalSession::new(session_id, initial_cwd)
        })
    }

    pub fn execute(
        manager_arc: &Arc<Mutex<TerminalManager>>,
        session_id: &str,
        command: &str,
        custom_cwd: Option<&str>,
        shell: Option<&str>,
    ) -> Result<u32, String> {
        let trimmed = command.trim();
        if trimmed.is_empty() {
            return Ok(0);
        }

        let mut mgr = manager_arc.lock().map_err(|e| format!("Lock error: {e}"))?;
        let session = mgr.get_or_create(session_id);

        if let Some(dir) = custom_cwd {
            let p = PathBuf::from(dir);
            if p.exists() && p.is_dir() {
                session.cwd = p;
            }
        }

        session.history.push(trimmed.to_string());
        session.write_line("command", &format!("> {trimmed}"));

        // Built-in commands
        let lower = trimmed.to_ascii_lowercase();
        if lower == "clear" || lower == "cls" {
            session.feed(b"\x1b[2J\x1b[H\x1b[3J");
            return Ok(0);
        }

        if lower == "pwd" {
            let cwd_str = session.cwd.display().to_string();
            session.write_line("system", &cwd_str);
            return Ok(0);
        }

        if lower.starts_with("cd ") || lower.starts_with("chdir ") {
            let parts: Vec<&str> = trimmed.splitn(2, ' ').collect();
            if parts.len() == 2 {
                let target = parts[1].trim().trim_matches('"');
                let target_path = if Path::new(target).is_absolute() {
                    PathBuf::from(target)
                } else {
                    session.cwd.join(target)
                };

                match std::fs::canonicalize(&target_path) {
                    Ok(canonical) => {
                        session.cwd = canonical;
                        let msg = format!("Working directory: {}", session.cwd.display());
                        session.write_line("system", &msg);
                    }
                    Err(e) => {
                        let err_msg = format!("Cannot change directory to '{target}': {e}");
                        session.write_line("error", &err_msg);
                    }
                }
            }
            return Ok(0);
        }

        // Prevent overlapping runs in the same session.
        if session.running.is_some() {
            return Err("A process is already running in this terminal session. Stop it first.".to_string());
        }

        // ---- Spawn on a real pseudo-terminal ----
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: DEFAULT_ROWS,
                cols: DEFAULT_COLS,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Could not open a pseudo-terminal: {e}"))?;

        // A shell runs the typed command so built-ins, globbing and PATH shims (npm/Volta `.cmd`)
        // resolve. Default to cmd.exe on Windows: PowerShell resolves Volta's `.ps1` shims, which
        // are blocked by the execution policy here, whereas cmd runs the `.cmd` shims.
        let (shell_bin, shell_args): (&str, Vec<String>) = {
            #[cfg(target_os = "windows")]
            {
                if shell == Some("powershell") {
                    ("powershell.exe", vec!["-NoLogo".to_string(), "-NoProfile".to_string(), "-Command".to_string(), trimmed.to_string()])
                } else {
                    ("cmd.exe", vec!["/c".to_string(), trimmed.to_string()])
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let sh = shell.unwrap_or("sh");
                (sh, vec!["-c".to_string(), trimmed.to_string()])
            }
        };

        let mut cmd = CommandBuilder::new(shell_bin);
        cmd.args(&shell_args);
        cmd.cwd(&session.cwd);
        // Inherit the full process environment. portable-pty's CommandBuilder builds its base env
        // from the Windows registry (system + user), so dynamic PATH entries injected by version
        // managers (Volta, nvm) are missing and `node`/`claude`/`codex` shims are not found. The
        // process env has them.
        for (key, value) in std::env::vars() {
            cmd.env(key, value);
        }
        // Encourage VT colour output even where a CLI would otherwise probe for a terminal.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("FORCE_COLOR", "1");

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Could not spawn process: {e}"))?;
        let pid = child.process_id().unwrap_or(0);

        let portable_pty::PtyPair { master, slave } = pair;
        drop(slave);
        let reader = master
            .try_clone_reader()
            .map_err(|e| format!("Could not read from the terminal: {e}"))?;
        let writer = master
            .take_writer()
            .map_err(|e| format!("Could not write to the terminal: {e}"))?;

        // Reader thread: feed the pty's VT output into the parser, and answer ConPTY's
        // device-status/cursor-position queries (CSI 5n / CSI 6n) which vt100 itself ignores but
        // the shell needs answered before it proceeds.
        let (writer_tx, writer_rx) = mpsc::channel::<Vec<u8>>();
        let resp_tx = writer_tx.clone();
        let parser = Arc::clone(&session.parser);
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        if chunk.windows(4).any(|w| w == b"\x1b[6n") {
                            let (row, col) = parser.lock().map(|p| p.screen().cursor_position()).unwrap_or((0, 0));
                            let _ = resp_tx.send(format!("\x1b[{};{}R", row + 1, col + 1).into_bytes());
                        }
                        if chunk.windows(4).any(|w| w == b"\x1b[5n") {
                            let _ = resp_tx.send(b"\x1b[0n".to_vec());
                        }
                        if let Ok(mut p) = parser.lock() {
                            p.process(chunk);
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Writer thread: forward outbound keystrokes to the pty master.
        std::thread::spawn(move || {
            let mut writer = writer;
            while let Ok(data) = writer_rx.recv() {
                let _ = writer.write_all(&data);
                let _ = writer.flush();
            }
        });

        session.running = Some(RunningProcess {
            pid,
            writer_tx,
            start_time: Instant::now(),
        });
        session.child = Some(child);
        session.master = Some(master);
        session.exit_code = None;

        // Wait thread: poll the child and settle the session when it exits.
        let mgr_clone = Arc::clone(manager_arc);
        let s_id = session_id.to_string();
        std::thread::spawn(move || loop {
            let done = {
                let mut lock = mgr_clone.lock().unwrap();
                if let Some(sess) = lock.sessions.get_mut(&s_id) {
                    match sess.child.as_mut().map(|c| c.try_wait()) {
                        None => true,
                        Some(Ok(Some(status))) => {
                            sess.exit_code = Some(status.exit_code() as i32);
                            sess.running = None;
                            sess.child = None;
                            sess.master = None;
                            true
                        }
                        Some(Ok(None)) => false,
                        Some(Err(_)) => {
                            sess.exit_code = Some(1);
                            sess.running = None;
                            sess.child = None;
                            sess.master = None;
                            true
                        }
                    }
                } else {
                    true
                }
            };
            if done {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        });

        Ok(pid)
    }

    pub fn kill(&mut self, session_id: &str) -> Result<(), String> {
        let session = self.sessions.get_mut(session_id).ok_or("Session not found")?;
        if let Some(proc) = session.running.take() {
            let _ = session.child.as_mut().map(|c| c.kill());
            session.child = None;
            session.master = None;
            #[cfg(target_os = "windows")]
            {
                // Kill the whole tree (a shell may have spawned the interactive program).
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &proc.pid.to_string()])
                    .output();
            }
            session.exit_code = Some(-1);
            session.write_line("system", "Process terminated by user.");
            Ok(())
        } else {
            Ok(())
        }
    }

    pub fn write_input(&mut self, session_id: &str, input: &str) -> Result<(), String> {
        let session = self.sessions.get_mut(session_id).ok_or("Session not found")?;
        if let Some(ref proc) = session.running {
            let data = input.as_bytes().to_vec();
            proc.writer_tx
                .send(data)
                .map_err(|e| format!("Stdin send failed: {e}"))?;
        }
        Ok(())
    }

    pub fn poll_status(&self, session_id: &str) -> TerminalStatusConfig {
        if let Some(sess) = self.sessions.get(session_id) {
            let (screen, text) = build_screen(&sess.parser);
            TerminalStatusConfig {
                is_running: sess.running.is_some(),
                exit_code: sess.exit_code,
                cwd: sess.cwd.display().to_string(),
                pid: sess.running.as_ref().map(|r| r.pid),
                screen,
                text,
            }
        } else {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            TerminalStatusConfig {
                is_running: false,
                exit_code: None,
                cwd: cwd.display().to_string(),
                pid: None,
                screen: TerminalScreen::empty(DEFAULT_ROWS, DEFAULT_COLS),
                text: String::new(),
            }
        }
    }
}

/// Map a `vt100::Color` to 24-bit RGB; `Default` becomes `None` (use the theme).
fn color_to_rgb(c: vt100::Color) -> Option<[u8; 3]> {
    match c {
        vt100::Color::Default => None,
        vt100::Color::Idx(i) => Some(xterm_color(i)),
        vt100::Color::Rgb(r, g, b) => Some([r, g, b]),
    }
}

/// The standard xterm 256-colour palette.
fn xterm_color(i: u8) -> [u8; 3] {
    const CUBE: [u8; 6] = [0, 95, 135, 175, 215, 255];
    const BASIC: [[u8; 3]; 16] = [
        [0, 0, 0],
        [205, 0, 0],
        [0, 205, 0],
        [205, 205, 0],
        [0, 0, 238],
        [205, 0, 205],
        [0, 205, 205],
        [229, 229, 229],
        [127, 127, 127],
        [255, 0, 0],
        [0, 255, 0],
        [255, 255, 0],
        [92, 92, 255],
        [255, 0, 255],
        [0, 255, 255],
        [255, 255, 255],
    ];
    let i = i as usize;
    if i < 16 {
        BASIC[i]
    } else if i < 232 {
        let n = i - 16;
        [CUBE[n / 36], CUBE[(n / 6) % 6], CUBE[n % 6]]
    } else {
        let v = (8 + (i - 232) * 10) as u8;
        [v, v, v]
    }
}

/// Read the parser's screen into a serializable grid plus its plain text. Public so the BDD
/// tests can feed a parser directly and assert on the produced runs/colours.
pub fn build_screen(parser: &Arc<Mutex<Parser>>) -> (TerminalScreen, String) {
    let guard = parser.lock().unwrap();
    let screen = guard.screen();
    let (rows, cols) = screen.size();
    let (cursor_row, cursor_col) = screen.cursor_position();
    let cursor_visible = !screen.hide_cursor();

    let mut lines: Vec<Vec<TerminalRun>> = Vec::with_capacity(rows as usize);
    for r in 0..rows {
        let mut runs: Vec<TerminalRun> = Vec::new();
        for c in 0..cols {
            let cell = screen.cell(r, c);
            let (text, fg, bg, bold, italic, underline, reverse) = match cell {
                Some(cell) => {
                    let text = cell.contents().to_string();
                    let text = if text.is_empty() { " ".to_string() } else { text };
                    (
                        text,
                        color_to_rgb(cell.fgcolor()),
                        color_to_rgb(cell.bgcolor()),
                        cell.bold(),
                        cell.italic(),
                        cell.underline(),
                        cell.inverse(),
                    )
                }
                None => (" ".to_string(), None, None, false, false, false, false),
            };

            let same_style = runs.last().map(|prev: &TerminalRun| {
                prev.fg == fg && prev.bg == bg && prev.bold == bold && prev.italic == italic && prev.underline == underline && prev.reverse == reverse
            }).unwrap_or(false);

            if same_style {
                runs.last_mut().unwrap().text.push_str(&text);
            } else {
                runs.push(TerminalRun { text, fg, bg, bold, italic, underline, reverse });
            }
        }
        lines.push(runs);
    }

    let text = screen.contents();
    (
        TerminalScreen {
            rows,
            cols,
            cursor_row,
            cursor_col,
            cursor_visible,
            lines,
        },
        text,
    )
}

lazy_static! {
    pub static ref GLOBAL_TERMINAL_MANAGER: Arc<Mutex<TerminalManager>> = Arc::new(Mutex::new(TerminalManager::new()));
}

// ----------------- Deno Ops -----------------

#[op2(fast)]
pub fn op_terminal_execute(
    #[string] session_id: String,
    #[string] command: String,
    #[string] custom_cwd: String,
    #[string] shell: String,
) -> Result<u32, deno_error::JsErrorBox> {
    let cwd_opt = if custom_cwd.is_empty() { None } else { Some(custom_cwd.as_str()) };
    let shell_opt = if shell.is_empty() { None } else { Some(shell.as_str()) };
    TerminalManager::execute(&GLOBAL_TERMINAL_MANAGER, &session_id, &command, cwd_opt, shell_opt)
        .map_err(deno_error::JsErrorBox::generic)
}

#[op2]
#[serde]
pub fn op_terminal_poll(#[string] session_id: String) -> TerminalStatusConfig {
    if let Ok(mgr) = GLOBAL_TERMINAL_MANAGER.lock() {
        mgr.poll_status(&session_id)
    } else {
        TerminalStatusConfig {
            is_running: false,
            exit_code: None,
            cwd: String::new(),
            pid: None,
            screen: TerminalScreen::empty(DEFAULT_ROWS, DEFAULT_COLS),
            text: String::new(),
        }
    }
}

#[op2(fast)]
pub fn op_terminal_kill(#[string] session_id: String) -> Result<(), deno_error::JsErrorBox> {
    if let Ok(mut mgr) = GLOBAL_TERMINAL_MANAGER.lock() {
        mgr.kill(&session_id).map_err(deno_error::JsErrorBox::generic)
    } else {
        Err(deno_error::JsErrorBox::generic("Lock failed"))
    }
}

#[op2(fast)]
pub fn op_terminal_write_input(#[string] session_id: String, #[string] input: String) -> Result<(), deno_error::JsErrorBox> {
    if let Ok(mut mgr) = GLOBAL_TERMINAL_MANAGER.lock() {
        mgr.write_input(&session_id, &input).map_err(deno_error::JsErrorBox::generic)
    } else {
        Err(deno_error::JsErrorBox::generic("Lock failed"))
    }
}

#[op2(fast)]
pub fn op_terminal_clear(#[string] session_id: String) {
    if let Ok(mut mgr) = GLOBAL_TERMINAL_MANAGER.lock() {
        let sess = mgr.get_or_create(&session_id);
        sess.feed(b"\x1b[2J\x1b[H\x1b[3J");
    }
}

#[op2]
#[string]
pub fn op_terminal_get_cwd(#[string] session_id: String) -> String {
    if let Ok(mut mgr) = GLOBAL_TERMINAL_MANAGER.lock() {
        let sess = mgr.get_or_create(&session_id);
        sess.cwd.display().to_string()
    } else {
        String::new()
    }
}

#[op2]
#[string]
pub fn op_terminal_set_cwd(#[string] session_id: String, #[string] new_cwd: String) -> Result<String, deno_error::JsErrorBox> {
    if let Ok(mut mgr) = GLOBAL_TERMINAL_MANAGER.lock() {
        let sess = mgr.get_or_create(&session_id);
        let p = PathBuf::from(&new_cwd);
        if p.exists() && p.is_dir() {
            let canonical = std::fs::canonicalize(&p).unwrap_or(p);
            sess.cwd = canonical;
            Ok(sess.cwd.display().to_string())
        } else {
            Err(deno_error::JsErrorBox::generic(format!("Directory '{new_cwd}' not found")))
        }
    } else {
        Err(deno_error::JsErrorBox::generic("Lock error"))
    }
}

#[op2]
#[serde]
pub fn op_terminal_list_fonts() -> Vec<String> {
    crate::renderer_text::fonts::CANONICAL_FONT_NAMES.iter().map(|s| s.to_string()).collect()
}

#[op2]
pub fn op_ui_widget_terminal(state: &mut OpState, #[string] window_id: String, #[serde] config: TerminalWidgetConfig) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        let id = config.id.clone();
        ctx.ui_widgets.entry(window_id).or_default().push(UiWidget::Terminal { id, config });
    }
}
