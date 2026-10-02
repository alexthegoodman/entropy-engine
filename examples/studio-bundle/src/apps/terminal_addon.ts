/// <reference path="../addon.d.ts" />
import type { IconName, IconStyle } from "../addon";

// Terminal Addon for Entropy Engine
// A real interactive terminal in the DAW's app-chrome style. Commands run on a native
// pseudo-terminal (ConPTY/pty), so TUI programs like Claude Code and Codex see a real terminal:
// their ANSI output is parsed into a grid and drawn in the engine's monospace face, and the
// command box sends keystrokes to them while they run.

const addonInfo = {
    name: "terminal",
    version: "1.2.0",
    description: "Terminal - a real interactive terminal with one-click MCP connections, CLI installers, and TUI support (claude, codex, etc.).",
    author: ["Entropy Team", "Google DeepMind"],
    capabilities: {
        ui: true,
        needsViewport: false
    },
};

const addon = Entropy.AddonAtom.register(addonInfo);

interface TerminalScreen {
    rows: number;
    cols: number;
    cursorRow: number;
    cursorCol: number;
    cursorVisible: boolean;
    lines: { text: string; fg: [number, number, number] | null; bg: [number, number, number] | null; bold: boolean; italic: boolean; underline: boolean; reverse: boolean }[][];
}

interface TerminalStatus {
    isRunning: boolean;
    exitCode: number | null;
    cwd: string;
    pid: number | null;
    screen: TerminalScreen;
    text: string;
}

const THEMES = ["neon", "obsidian", "violet", "amber"];
const THEME_LABELS = ["Neon", "Obsidian", "Violet", "Amber"];

// Font choice: the first entry is the engine's monospace face (empty family name), the rest are
// the catalog's proportional fonts. Picking a proportional font is expected to misalign the cell
// grid - it's an opt-in preview, not the recommended setting.
const MONO_FONT_LABEL = "Monospace";
const FALLBACK_FONTS = ["Quicksand", "Figtree", "Lexend", "Exo", "Play", "Montserrat", "Outfit", "Zain", "Teachers"];
let fontOptions: string[] = [MONO_FONT_LABEL];

// The workspace palette: the tracks widget's navy greys, with amber for time (playhead, play) and
// one lighter step per layer so the header, toolbars and views read as separate surfaces.
type RGBA = [number, number, number, number];
const rgb = (r: number, g: number, b: number, a = 1): RGBA => [r / 255, g / 255, b / 255, a];
const UI = {
    header: rgb(19, 22, 32),
    nav: rgb(16, 18, 25),
    toolbar: rgb(18, 21, 31),
    view: rgb(14, 16, 22),
    panel: rgb(19, 22, 32),
    card: rgb(24, 27, 38),
    line: rgb(35, 40, 54),
    dim: rgb(136, 144, 166),
    amber: rgb(255, 189, 72),
    warn: rgb(240, 139, 160),
    ok: rgb(80, 235, 130),
};

const icon = (name: IconName, style?: IconStyle): string => Entropy.Icons.get(name, style);
const withIcon = (name: IconName, text: string, style?: IconStyle): string => Entropy.Icons.label(name, text, style);

const W = Entropy.UI.Widget;

// State
let screen: TerminalScreen = { rows: 0, cols: 0, cursorRow: 0, cursorCol: 0, cursorVisible: false, lines: [] };
let terminalText = "";
let isRunning = false;
let exitCode: number | null = null;
let currentCwd = "";
let currentPid: number | null = null;
let commandInput = "";
const cmdHistory: string[] = [];
let historyIndex = -1;
let fontSize = 14.0;
let selectedFont = "";
let selectedTheme = "neon";
let autoScroll = true;
let frameCounter = 0;
let tabId = "";
const POLL_INTERVAL_FRAMES = 4; // Poll status every ~60ms at 60fps

function refreshStatus() {
    try {
        const status = Entropy.Terminal.poll("main") as TerminalStatus;
        if (status) {
            screen = status.screen || screen;
            terminalText = status.text || "";
            isRunning = status.isRunning;
            exitCode = status.exitCode;
            currentCwd = status.cwd || currentCwd;
            currentPid = status.pid;
        }
    } catch {
        // Silently handle if terminal ops are not ready yet
    }
}

function runCommand(cmd: string) {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    if (!cmdHistory.includes(trimmed)) {
        cmdHistory.push(trimmed);
    }
    historyIndex = cmdHistory.length;

    try {
        Entropy.Terminal.execute(trimmed, {
            sessionId: "main",
            cwd: currentCwd,
        });
        commandInput = "";
        refreshStatus();
    } catch (e) {
        Entropy.UI.toast?.({
            id: "term-exec-err",
            message: `Command execution failed: ${e instanceof Error ? e.message : String(e)}`,
            kind: "error",
            durationMs: 4000,
        });
    }
}

function sendInput(text: string) {
    if (!isRunning) return;
    try {
        Entropy.Terminal.writeInput(text + "\r", "main");
        commandInput = "";
    } catch (e) {
        Entropy.UI.toast?.({
            id: "term-send-err",
            message: `Could not send input: ${e instanceof Error ? e.message : String(e)}`,
            kind: "error",
            durationMs: 3000,
        });
    }
}

function stopRunningProcess() {
    try {
        Entropy.Terminal.kill("main");
        refreshStatus();
        Entropy.UI.toast?.({
            id: "term-kill",
            message: "Termination signal sent to running process tree.",
            kind: "info",
            durationMs: 3000,
        });
    } catch (e) {
        Entropy.UI.toast?.({
            id: "term-kill-err",
            message: `Could not terminate process: ${e instanceof Error ? e.message : String(e)}`,
            kind: "error",
            durationMs: 3000,
        });
    }
}

function clearTerminal() {
    try {
        Entropy.Terminal.clear("main");
        refreshStatus();
    } catch {
        // ignore
    }
}

function copyAllOutput() {
    const text = terminalText || "";
    if (text.trim().length === 0) {
        Entropy.UI.toast?.({
            id: "term-copy-empty",
            message: "Terminal output is currently empty.",
            kind: "info",
            durationMs: 2500,
        });
        return;
    }
    Entropy.Clipboard.writeText(text);
    Entropy.UI.toast?.({
        id: "term-copy-ok",
        message: "Copied terminal output to clipboard!",
        kind: "success",
        durationMs: 3000,
    });
}

function copyMcpUrl() {
    Entropy.Clipboard.writeText("http://127.0.0.1:47100/mcp");
    Entropy.UI.toast?.({
        id: "term-mcp-url",
        message: "MCP server URL copied to clipboard.",
        kind: "success",
        durationMs: 2500,
    });
}

function setupUI() {
    try {
        currentCwd = Entropy.Terminal.getCwd("main");
    } catch {
        currentCwd = "";
    }

    try {
        const catalog = Entropy.Terminal.listFonts?.();
        if (Array.isArray(catalog) && catalog.length > 0) {
            fontOptions = [MONO_FONT_LABEL, ...catalog];
        } else {
            fontOptions = [MONO_FONT_LABEL, ...FALLBACK_FONTS];
        }
    } catch {
        fontOptions = [MONO_FONT_LABEL, ...FALLBACK_FONTS];
    }

    refreshStatus();

    tabId = Entropy.UI.createTab({
        title: "Terminal",
        // Fill the window itself (bars + split) rather than a page-long scroll.
        scroll: false,
        onRender: () => renderUI(tabId),
    });
}

// A compact breadcrumb for long paths: drive/volume initials + ".../" + the tail.
function shortPath(p: string, max = 64): string {
    if (p.length <= max) return p;
    const parts = p.split(/[\\/]/);
    if (parts.length <= 1) return `${p.slice(0, max)}…`;
    const tail = parts[parts.length - 1];
    const head = parts.slice(0, -1).map((s) => s[0] || "").join("/");
    const combined = `${head}/…/${tail}`;
    return combined.length <= max ? combined : `…/${tail.slice(-(max - 4))}`;
}

function statusText(): string {
    if (isRunning) return `Running${currentPid ? ` · PID ${currentPid}` : ""}`;
    if (exitCode !== null) return `Idle · exit ${exitCode}`;
    return "Idle";
}

function renderUI(win: string) {
    frameCounter++;
    if (frameCounter % POLL_INTERVAL_FRAMES === 0) {
        refreshStatus();
    }

    const isNarrow = Entropy.UI.isNarrow ? Entropy.UI.isNarrow(860) : false;

    // ---- Header: the app title on the left, output actions on the right ----
    W.bar(win, { id: "term_header", height: 52, fill: UI.header, border: UI.line, paddingX: 12 },
        (left: string) => {
            W.label(left, { text: withIcon("terminal-window", "Terminal"), bold: true, fontSize: 14 });
            if (!isNarrow) {
                W.label(left, { text: statusText(), color: isRunning ? UI.amber : UI.dim, fontSize: 12 });
            }
        },
        undefined,
        (right: string) => {
            W.button(right, { text: icon("copy"), id: "copy_output", frame: false, tooltip: "Copy all output", onClick: () => copyAllOutput() });
            W.button(right, { text: icon("eraser"), id: "clear_output", frame: false, tooltip: "Clear output", onClick: () => clearTerminal() });
            W.button(right, {
                text: icon(autoScroll ? "arrow-line-down" : "arrow-line-up"),
                id: "autoscroll_toggle",
                frame: false,
                selected: autoScroll,
                tooltip: autoScroll ? "Auto-scroll: ON (follow the latest output)" : "Auto-scroll: OFF",
                onClick: () => { autoScroll = !autoScroll; },
            });
        });

    // ---- View bar: the working directory on the left ----
    W.bar(win, { id: "term_view", height: 40, fill: UI.nav, border: UI.line, paddingX: 12 },
        (left: string) => {
            W.label(left, { text: icon("folder"), fontSize: 12, color: UI.dim });
            W.label(left, { text: currentCwd ? shortPath(currentCwd) : "Ready", monospace: true, color: UI.dim, fontSize: 12 });
        },
        undefined,
        (right: string) => {
            W.label(right, { text: `${screen.cols}×${screen.rows}`, color: UI.dim, fontSize: 12 });
        });

    // ---- Main: the terminal as the hero, quick actions in the side inspector ----
    W.split(win, { id: "term_split", sideWidth: 300, reserveBottom: 80, sideFill: UI.panel, divider: UI.line, mainFill: UI.view, scrollSide: true },
        (main: string) => {
            W.terminal(main, {
                id: "main_terminal_view",
                screen,
                isRunning,
                fontSize,
                fontFamily: selectedFont,
                theme: selectedTheme,
                autoScroll,
            });
        },
        (side: string) => {
            W.label(side, { text: "Quick Actions", bold: true, fontSize: 13 });

            W.label(side, { text: "AI Agents & MCP", bold: true, color: UI.dim, fontSize: 12 });
            W.button(side, { text: withIcon("plug", "Connect Claude Code"), id: "connect_claude", tooltip: "claude mcp add --transport http entropy-engine http://127.0.0.1:47100/mcp", onClick: () => runCommand("claude mcp add --transport http entropy-engine http://127.0.0.1:47100/mcp") });
            W.button(side, { text: withIcon("plug", "Connect Antigravity"), id: "connect_agy", tooltip: "agy mcp add --transport http entropy-engine http://127.0.0.1:47100/mcp", onClick: () => runCommand("agy mcp add --transport http entropy-engine http://127.0.0.1:47100/mcp") });
            W.button(side, { text: withIcon("activity", "Test MCP Server"), id: "test_mcp", tooltip: "Fetch the MCP endpoint and report its HTTP status", onClick: () => runCommand('node -e "fetch(\'http://127.0.0.1:47100/mcp\').then(r=>console.log(\'MCP Server active! HTTP Status:\', r.status)).catch(e=>console.error(\'MCP Server offline:\', e.message))"') });
            W.button(side, { text: withIcon("link-simple", "Copy MCP URL"), id: "copy_mcp_url", tooltip: "Copy http://127.0.0.1:47100/mcp to the clipboard", onClick: () => copyMcpUrl() });

            W.separator(side);

            W.label(side, { text: "Installers & Tools", bold: true, color: UI.dim, fontSize: 12 });
            W.button(side, { text: withIcon("download-simple", "Install Claude Code"), id: "install_claude", tooltip: "npm install -g @anthropic-ai/claude-code", onClick: () => runCommand("npm install -g @anthropic-ai/claude-code") });
            W.button(side, { text: withIcon("download-simple", "Install Antigravity CLI"), id: "install_agy", tooltip: "npm install -g antigravity-cli", onClick: () => runCommand("npm install -g antigravity-cli") });
            W.button(side, { text: withIcon("gauge", "System Check"), id: "system_check", tooltip: "Report node, npm, git and cargo versions", onClick: () => runCommand("node -v & npm -v & git --version & cargo --version") });
            W.button(side, { text: withIcon("git-branch", "Git Status"), id: "git_status", tooltip: "git status -s", onClick: () => runCommand("git status -s") });
            W.button(side, { text: withIcon("hammer", "Monorepo Build"), id: "monorepo_build", tooltip: "npm run build", onClick: () => runCommand("npm run build") });

            W.separator(side);

            // Appearance: theme and size, folded away so the workspace stays clean.
            W.collapsingHeader(side, "Appearance", (w: string) => {
                W.label(w, { text: "Theme", bold: true, color: UI.dim, fontSize: 12 });
                W.segmented(w, {
                    id: "term_theme",
                    options: THEME_LABELS,
                    selectedIndex: Math.max(0, THEMES.indexOf(selectedTheme)),
                    compact: true,
                    accent: UI.amber,
                    onChange: (idx: string) => { selectedTheme = THEMES[parseInt(idx, 10)] ?? "neon"; },
                });
                W.label(w, { text: "Font", bold: true, color: UI.dim, fontSize: 12 });
                W.dropdown(w, {
                    id: "term_font",
                    label: "",
                    options: fontOptions,
                    selectedIndex: Math.max(0, fontOptions.indexOf(selectedFont)),
                    onChange: (idx: string) => {
                        const i = parseInt(idx, 10);
                        selectedFont = i === 0 ? "" : (fontOptions[i] ?? "");
                    },
                });
                if (selectedFont !== "") {
                    W.label(w, { text: "Proportional font: cell grid will misalign.", color: UI.warn, fontSize: 11 });
                }
                W.horizontal(w, (r: string) => {
                    W.button(r, { text: "A-", id: "font_down", tooltip: "Smaller text", onClick: () => { fontSize = Math.max(9.0, fontSize - 1.0); } });
                    W.label(r, { text: `${fontSize}pt`, monospace: true });
                    W.button(r, { text: "A+", id: "font_up", tooltip: "Larger text", onClick: () => { fontSize = Math.min(24.0, fontSize + 1.0); } });
                });
            }, "term_appearance", false);

            W.collapsingHeader(side, "Getting Started", (w: string) => {
                W.label(w, { text: "MCP bridges your AI coding assistant (Claude Code or Antigravity) into Entropy Engine." });
                W.label(w, { text: "Type a command like claude or codex and press Run - it runs here interactively." });
                W.label(w, { text: "While a program runs, the command box sends keystrokes to it (try /help or /exit)." });
            }, "term_help", false);
        });

    // ---- Command bar: prompt + input on the left, history / Stop / Run-Send on the right ----
    const cmdWidth = Math.max(160, (Entropy.UI.getViewportWidth?.() ?? 900) - 300);
    W.bar(win, { id: "term_input", height: 52, fill: UI.toolbar, border: UI.line, borderTop: true, paddingX: 12 },
        (left: string) => {
            W.label(left, { text: icon("terminal"), fontSize: 13, color: isRunning ? UI.amber : UI.dim });
            W.textInput(left, {
                id: "terminal_cmd_input",
                value: commandInput,
                width: cmdWidth,
                onChange: (val: string) => { commandInput = val; },
            });
        },
        undefined,
        (right: string) => {
            W.button(right, {
                text: icon("arrow-up"),
                id: "history_up",
                frame: false,
                disabled: cmdHistory.length === 0,
                tooltip: "Previous command",
                onClick: () => {
                    if (cmdHistory.length === 0) return;
                    historyIndex = Math.max(0, historyIndex - 1);
                    commandInput = cmdHistory[historyIndex] ?? cmdHistory[cmdHistory.length - 1];
                },
            });
            if (isRunning) {
                W.button(right, {
                    text: isNarrow ? icon("stop") : withIcon("stop", "Stop"),
                    id: "stop_process",
                    color: UI.warn,
                    tooltip: "Terminate the running process tree",
                    onClick: () => stopRunningProcess(),
                });
            }
            W.button(right, {
                text: isRunning
                    ? (isNarrow ? icon("paper-plane-right") : withIcon("paper-plane-right", "Send"))
                    : (isNarrow ? icon("play") : withIcon("play", "Run")),
                id: "run_command",
                accent: UI.amber,
                minWidth: isNarrow ? 44 : 84,
                disabled: !isRunning && commandInput.trim().length === 0,
                tooltip: isRunning ? "Send the typed text to the running program" : "Run the command",
                onClick: () => {
                    if (isRunning) {
                        sendInput(commandInput);
                    } else {
                        runCommand(commandInput);
                    }
                },
            });
        });

    // ---- Status bar: a hint on the left, the MCP endpoint on the right ----
    W.bar(win, { id: "term_status", height: 28, fill: UI.nav, border: UI.line, borderTop: true, paddingX: 12 },
        (left: string) => {
            W.label(left, { text: isRunning ? "Program running - type and press Send, or /exit to quit." : "Type a command (e.g. claude or codex), or use a Quick Action on the right.", color: UI.dim, fontSize: 12 });
        },
        undefined,
        (right: string) => {
            W.label(right, { text: "MCP server · 127.0.0.1:47100", color: UI.dim, fontSize: 12 });
        });
}

addon.onInit(async () => {
    setupUI();
});
