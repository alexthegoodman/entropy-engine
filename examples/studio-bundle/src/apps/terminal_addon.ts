/// <reference path="../addon.d.ts" />
import type { IconName, IconStyle } from "../addon";

// Terminal Addon for Entropy Engine
// A developer terminal restyled to match the DAW's app chrome: a header bar, a
// session/view bar, a split main (output) + side (quick actions) layout, and a
// bottom command bar + status bar. One-click MCP connections and CLI installers
// live in the side inspector; appearance controls are tucked into a folding card.

const addonInfo = {
    name: "terminal",
    version: "1.1.0",
    description: "Terminal - developer terminal with one-click MCP connections, CLI installers, catalog typography, and real process execution.",
    author: ["Entropy Team", "Google DeepMind"],
    capabilities: {
        ui: true,
        needsViewport: false
    },
};

const addon = Entropy.AddonAtom.register(addonInfo);

interface TerminalLine {
    id: number;
    kind: string;
    text: string;
    timestamp: string;
}

interface TerminalStatus {
    isRunning: boolean;
    exitCode: number | null;
    cwd: string;
    pid: number | null;
    lines: TerminalLine[];
}

// Curated fonts from the ~60 catalog fonts in src/fonts/
const POPULAR_FONTS = [
    "Quicksand",
    "Figtree",
    "Lexend",
    "Exo",
    "Play",
    "Montserrat",
    "Outfit",
    "Zain",
    "Teachers",
];

const THEMES = ["neon", "obsidian", "violet", "amber"];
const THEME_LABELS = ["Neon", "Obsidian", "Violet", "Amber"];

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
let lines: TerminalLine[] = [];
let isRunning = false;
let exitCode: number | null = null;
let currentCwd = "";
let currentPid: number | null = null;
let commandInput = "";
const cmdHistory: string[] = [];
let historyIndex = -1;
let selectedFont = "Quicksand";
let fontSize = 14.0;
let selectedTheme = "neon";
let autoScroll = true;
let frameCounter = 0;
let tabId = "";
const POLL_INTERVAL_FRAMES = 4; // Poll status every ~60ms at 60fps

function refreshStatus() {
    try {
        const status = Entropy.Terminal.poll("main") as TerminalStatus;
        if (status) {
            lines = status.lines || [];
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
        lines = [];
        refreshStatus();
    } catch {
        lines = [];
    }
}

function copyAllOutput() {
    if (lines.length === 0) {
        Entropy.UI.toast?.({
            id: "term-copy-empty",
            message: "Terminal output is currently empty.",
            kind: "info",
            durationMs: 2500,
        });
        return;
    }
    const fullText = lines.map((l) => `${l.timestamp ? `[${l.timestamp}] ` : ""}${l.text}`).join("\n");
    Entropy.Clipboard.writeText(fullText);
    Entropy.UI.toast?.({
        id: "term-copy-ok",
        message: `Copied ${lines.length} lines of terminal output to clipboard!`,
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

    // ---- View bar: the working directory on the left, the session on the right ----
    W.bar(win, { id: "term_view", height: 40, fill: UI.nav, border: UI.line, paddingX: 12 },
        (left: string) => {
            W.label(left, { text: icon("folder"), fontSize: 12, color: UI.dim });
            W.label(left, { text: currentCwd ? shortPath(currentCwd) : "Ready", monospace: true, color: UI.dim, fontSize: 12 });
        },
        undefined,
        (right: string) => {
            W.label(right, { text: `${lines.length} line${lines.length === 1 ? "" : "s"}`, color: UI.dim, fontSize: 12 });
        });

    // ---- Main: the terminal output as the hero, quick actions in the side inspector ----
    W.split(win, { id: "term_split", sideWidth: 300, reserveBottom: 80, sideFill: UI.panel, divider: UI.line, mainFill: UI.view, scrollSide: true },
        (main: string) => {
            W.terminal(main, {
                id: "main_terminal_view",
                lines,
                isRunning,
                fontFamily: selectedFont,
                fontSize,
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
            W.button(side, { text: withIcon("gauge", "System Check"), id: "system_check", tooltip: "Report node, npm, git and cargo versions", onClick: () => runCommand("node -v; npm -v; git --version; cargo --version") });
            W.button(side, { text: withIcon("git-branch", "Git Status"), id: "git_status", tooltip: "git status -s", onClick: () => runCommand("git status -s") });
            W.button(side, { text: withIcon("hammer", "Monorepo Build"), id: "monorepo_build", tooltip: "npm run build", onClick: () => runCommand("npm run build") });

            W.separator(side);

            // Appearance: theme, font and size, folded away so the workspace stays clean.
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
                    options: POPULAR_FONTS,
                    selectedIndex: Math.max(0, POPULAR_FONTS.indexOf(selectedFont)),
                    onChange: (idx: string) => { selectedFont = POPULAR_FONTS[parseInt(idx, 10)] ?? "Quicksand"; },
                });
                W.horizontal(w, (r: string) => {
                    W.button(r, { text: "A-", id: "font_down", tooltip: "Smaller text", onClick: () => { fontSize = Math.max(10.0, fontSize - 1.0); } });
                    W.label(r, { text: `${fontSize}pt`, monospace: true });
                    W.button(r, { text: "A+", id: "font_up", tooltip: "Larger text", onClick: () => { fontSize = Math.min(24.0, fontSize + 1.0); } });
                });
            }, "term_appearance", false);

            W.collapsingHeader(side, "Getting Started", (w: string) => {
                W.label(w, { text: "MCP bridges your AI coding assistant (Claude Code or Antigravity) into Entropy Engine." });
                W.label(w, { text: "Quick Actions run common developer commands without typing terminal syntax." });
                W.label(w, { text: "Commands run in real background OS processes, streaming live stdout and stderr." });
            }, "term_help", false);
        });

    // ---- Command bar: prompt + input on the left, Run / Stop on the right ----
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
                text: isNarrow ? icon("paper-plane-right") : withIcon("paper-plane-right", "Run"),
                id: "run_command",
                accent: UI.amber,
                minWidth: isNarrow ? 44 : 84,
                disabled: commandInput.trim().length === 0,
                tooltip: "Run the command",
                onClick: () => runCommand(commandInput),
            });
        });

    // ---- Status bar: a hint on the left, the MCP endpoint on the right ----
    W.bar(win, { id: "term_status", height: 28, fill: UI.nav, border: UI.line, borderTop: true, paddingX: 12 },
        (left: string) => {
            W.label(left, { text: isRunning ? "Command running in the background..." : "Type a command, or use a Quick Action on the right.", color: UI.dim, fontSize: 12 });
        },
        undefined,
        (right: string) => {
            W.label(right, { text: "MCP server · 127.0.0.1:47100", color: UI.dim, fontSize: 12 });
        });
}

addon.onInit(async () => {
    setupUI();
});
