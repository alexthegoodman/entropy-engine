//! Terminal operations and session management for Entropy Engine.
//! Provides real OS process spawning, background stdout/stderr streaming,
//! non-blocking polling, working directory tracking, and UI widget integration.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use chrono::Local;
use deno_core::op2;
use deno_core::OpState;
use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};

use crate::deno::addon_ops::{AddonContext, UiWidget};
use crate::entropy_gui::widgets_terminal::{TerminalLine, TerminalLineKind, TerminalTheme, TerminalView};

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLineConfig {
    pub id: u64,
    pub kind: String,
    pub text: String,
    pub timestamp: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStatusConfig {
    pub is_running: bool,
    pub exit_code: Option<i32>,
    pub cwd: String,
    pub pid: Option<u32>,
    pub lines: Vec<TerminalLineConfig>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWidgetConfig {
    pub id: String,
    pub lines: Vec<TerminalLineConfig>,
    pub is_running: Option<bool>,
    pub font_family: Option<String>,
    pub font_size: Option<f32>,
    pub theme: Option<String>,
    pub height: Option<f32>,
    pub auto_scroll: Option<bool>,
}

struct RunningProcess {
    pid: u32,
    stdin_tx: Option<std::sync::mpsc::Sender<String>>,
    start_time: Instant,
}

pub struct TerminalSession {
    pub session_id: String,
    pub cwd: PathBuf,
    pub lines: Vec<TerminalLineConfig>,
    pub history: Vec<String>,
    pub exit_code: Option<i32>,
    pub line_counter: u64,
    running: Option<RunningProcess>,
}

impl TerminalSession {
    pub fn new(session_id: impl Into<String>, initial_cwd: PathBuf) -> Self {
        Self {
            session_id: session_id.into(),
            cwd: initial_cwd,
            lines: Vec::new(),
            history: Vec::new(),
            exit_code: None,
            line_counter: 0,
            running: None,
        }
    }

    pub fn push_line(&mut self, kind: impl Into<String>, text: impl Into<String>) {
        self.line_counter += 1;
        let timestamp = Local::now().format("%H:%M:%S").to_string();
        self.lines.push(TerminalLineConfig {
            id: self.line_counter,
            kind: kind.into(),
            text: text.into(),
            timestamp,
        });
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
        session.push_line("command", format!("> {trimmed}"));

        // Built-in commands
        let lower = trimmed.to_ascii_lowercase();
        if lower == "clear" || lower == "cls" {
            session.lines.clear();
            return Ok(0);
        }

        if lower == "pwd" {
            let cwd_str = session.cwd.display().to_string();
            session.push_line("system", cwd_str);
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
                        session.push_line("system", msg);
                    }
                    Err(e) => {
                        let err_msg = format!("Cannot change directory to '{target}': {e}");
                        session.push_line("error", err_msg);
                    }
                }
            }
            return Ok(0);
        }

        // Prevent overlapping runs in same session
        if session.running.is_some() {
            return Err("A process is already running in this terminal session. Stop it first.".to_string());
        }

        // Determine OS shell
        #[cfg(target_os = "windows")]
        let (shell_bin, shell_args) = if shell == Some("cmd") {
            ("cmd.exe", vec!["/C".to_string(), trimmed.to_string()])
        } else {
            // Default to PowerShell on Windows
            ("powershell.exe", vec!["-NoProfile".to_string(), "-Command".to_string(), trimmed.to_string()])
        };

        #[cfg(not(target_os = "windows"))]
        let (shell_bin, shell_args) = if let Some(sh) = shell {
            (sh, vec!["-c".to_string(), trimmed.to_string()])
        } else {
            ("sh", vec!["-c".to_string(), trimmed.to_string()])
        };

        let cwd = session.cwd.clone();
        let mut cmd = std::process::Command::new(shell_bin);
        cmd.args(&shell_args);
        cmd.current_dir(&cwd);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        cmd.stdin(std::process::Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("Could not spawn process: {e}"))?;
        let pid = child.id();

        let (stdin_tx, stdin_rx) = std::sync::mpsc::channel::<String>();
        session.running = Some(RunningProcess {
            pid,
            stdin_tx: Some(stdin_tx),
            start_time: Instant::now(),
        });
        session.exit_code = None;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let mut stdin = child.stdin.take();

        let mgr_clone = Arc::clone(manager_arc);
        let session_id_str = session_id.to_string();

        // Stdin forwarding thread
        if let Some(mut cin) = stdin {
            std::thread::spawn(move || {
                while let Ok(msg) = stdin_rx.recv() {
                    let _ = cin.write_all(msg.as_bytes());
                    let _ = cin.flush();
                }
            });
        }

        // Stdout reader thread
        if let Some(out) = stdout {
            let mgr_out = Arc::clone(&mgr_clone);
            let s_id = session_id_str.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(out);
                for line in reader.lines() {
                    match line {
                        Ok(l) => {
                            if let Ok(mut lock) = mgr_out.lock() {
                                if let Some(sess) = lock.sessions.get_mut(&s_id) {
                                    sess.push_line("stdout", l);
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        // Stderr reader thread
        if let Some(err) = stderr {
            let mgr_err = Arc::clone(&mgr_clone);
            let s_id = session_id_str.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(err);
                for line in reader.lines() {
                    match line {
                        Ok(l) => {
                            if let Ok(mut lock) = mgr_err.lock() {
                                if let Some(sess) = lock.sessions.get_mut(&s_id) {
                                    sess.push_line("stderr", l);
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        // Child process wait thread
        let mgr_wait = Arc::clone(&mgr_clone);
        let s_id_wait = session_id_str;
        std::thread::spawn(move || {
            let start = Instant::now();
            let status = child.wait();
            let elapsed = start.elapsed().as_secs_f32();

            if let Ok(mut lock) = mgr_wait.lock() {
                if let Some(sess) = lock.sessions.get_mut(&s_id_wait) {
                    sess.running = None;
                    match status {
                        Ok(st) => {
                            let code = st.code().unwrap_or(0);
                            sess.exit_code = Some(code);
                            if code == 0 {
                                sess.push_line("success", format!("Process completed with code 0 ({elapsed:.2}s)"));
                            } else {
                                sess.push_line("error", format!("Process exited with code {code} ({elapsed:.2}s)"));
                            }
                        }
                        Err(e) => {
                            sess.exit_code = Some(1);
                            sess.push_line("error", format!("Process wait error: {e} ({elapsed:.2}s)"));
                        }
                    }
                }
            }
        });

        Ok(pid)
    }

    pub fn kill(&mut self, session_id: &str) -> Result<(), String> {
        let session = self.sessions.get_mut(session_id).ok_or("Session not found")?;
        if let Some(proc) = session.running.take() {
            #[cfg(target_os = "windows")]
            {
                // Kill process tree on Windows
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &proc.pid.to_string()])
                    .output();
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = std::process::Command::new("kill")
                    .args(["-9", &proc.pid.to_string()])
                    .output();
            }
            session.exit_code = Some(-1);
            session.push_line("system", "Process terminated by user.");
            Ok(())
        } else {
            Ok(())
        }
    }

    pub fn write_input(&mut self, session_id: &str, input: &str) -> Result<(), String> {
        let session = self.sessions.get_mut(session_id).ok_or("Session not found")?;
        if let Some(ref proc) = session.running {
            if let Some(ref tx) = proc.stdin_tx {
                let mut data = input.to_string();
                if !data.ends_with('\n') {
                    data.push('\n');
                }
                tx.send(data).map_err(|e| format!("Stdin send failed: {e}"))?;
            }
        }
        Ok(())
    }

    pub fn poll_status(&self, session_id: &str) -> TerminalStatusConfig {
        if let Some(sess) = self.sessions.get(session_id) {
            TerminalStatusConfig {
                is_running: sess.running.is_some(),
                exit_code: sess.exit_code,
                cwd: sess.cwd.display().to_string(),
                pid: sess.running.as_ref().map(|r| r.pid),
                lines: sess.lines.clone(),
            }
        } else {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            TerminalStatusConfig {
                is_running: false,
                exit_code: None,
                cwd: cwd.display().to_string(),
                pid: None,
                lines: Vec::new(),
            }
        }
    }
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
            lines: Vec::new(),
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
        sess.lines.clear();
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
