/// <reference path="../addon.d.ts" />

// Terminal Addon for Entropy Engine
// High-performance interactive terminal with one-click agent setup,
// CLI installers, and catalog typography from the 60-font collection.

const addonInfo = {
    name: "terminal",
    version: "1.0.0",
    description: "Terminal - developer terminal with convenience buttons for MCP connections, CLI installers, custom typography, and real process execution.",
    author: ["Entropy Team", "Google DeepMind"],
    capabilities: { ui: true },
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
let showExplainer = false;
let showAllFonts = false;
let allCatalogFonts: string[] = [];
let frameCounter = 0;
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

function setupUI() {
    try {
        currentCwd = Entropy.Terminal.getCwd("main");
        allCatalogFonts = Entropy.Terminal.listFonts();
    } catch {
        currentCwd = "";
        allCatalogFonts = POPULAR_FONTS;
    }

    refreshStatus();

    const win = Entropy.UI.createTab({
        title: "Terminal",
        onRender: () => renderUI(win),
    });
}

function renderUI(win: string) {
    frameCounter++;
    if (frameCounter % POLL_INTERVAL_FRAMES === 0) {
        refreshStatus();
    }

    // Header with status
    Entropy.UI.Widget.horizontal(win, (w) => {
        Entropy.UI.Widget.label(w, { text: "Entropy Terminal", bold: true, fontSize: 16.0 });
        if (isRunning) {
            Entropy.UI.Widget.label(w, {
                text: `● RUNNING${currentPid ? ` (PID: ${currentPid})` : ""}`,
                bold: true,
                fontSize: 12.0,
            });
        } else {
            Entropy.UI.Widget.label(w, {
                text: exitCode !== null ? `● IDLE (Exit code: ${exitCode})` : "● IDLE",
                bold: false,
                fontSize: 12.0,
            });
        }
    });

    // Subtitle & CWD info bar
    Entropy.UI.Widget.horizontal(win, (w) => {
        Entropy.UI.Widget.label(w, {
            text: currentCwd ? `CWD: ${currentCwd}` : "Ready for commands",
            fontSize: 12.0,
        });
        Entropy.UI.Widget.button(w, {
            text: showExplainer ? "Hide Help ▲" : "What is this? ▼",
            onClick: () => {
                showExplainer = !showExplainer;
            },
        });
    });

    // Friendly explainer for non-technical users
    if (showExplainer) {
        Entropy.UI.Widget.collapsingHeader(win, "Getting Started & One-Click Tools Guide", (w) => {
            Entropy.UI.Widget.label(w, {
                text: "• MCP (Model Context Protocol): Bridges your AI coding assistants (Claude Code or Antigravity) directly into Entropy Engine.",
            });
            Entropy.UI.Widget.label(w, {
                text: "• Convenience Buttons: One-click shortcuts to install developer tools and configure connections without typing terminal syntax.",
            });
            Entropy.UI.Widget.label(w, {
                text: "• Modern Typography: Choose beautiful fonts like Quicksand, Figtree, or Lexend instead of traditional monospace.",
            });
            Entropy.UI.Widget.label(w, {
                text: "• Real Execution: Commands run in background OS processes with live stdout/stderr output streaming.",
            });
        }, "terminal_guide_header", true);
    }

    Entropy.UI.Widget.separator(win);

    const isNarrow = Entropy.UI.isNarrow ? Entropy.UI.isNarrow(720) : false;

    // Convenience Action Section: MCP & Agent Setup
    Entropy.UI.Widget.label(win, { text: "AI Agent & MCP Connections (One-Click)", bold: true, fontSize: 13.0 });
    if (isNarrow) {
        Entropy.UI.Widget.horizontal(win, (w) => {
            Entropy.UI.Widget.button(w, {
                text: "Connect Claude Code",
                onClick: () => {
                    runCommand("claude mcp add --transport http entropy-engine http://127.0.0.1:47100/mcp");
                },
            });
            Entropy.UI.Widget.button(w, {
                text: "Connect Antigravity",
                onClick: () => {
                    runCommand("agy mcp add --transport http entropy-engine http://127.0.0.1:47100/mcp");
                },
            });
        });
        Entropy.UI.Widget.horizontal(win, (w) => {
            Entropy.UI.Widget.button(w, {
                text: "Test MCP Server Status",
                onClick: () => {
                    runCommand('node -e "fetch(\'http://127.0.0.1:47100/mcp\').then(r=>console.log(\'MCP Server active! HTTP Status:\', r.status)).catch(e=>console.error(\'MCP Server offline:\', e.message))"');
                },
            });
        });
    } else {
        Entropy.UI.Widget.horizontal(win, (w) => {
            Entropy.UI.Widget.button(w, {
                text: "Connect MCP to Claude Code",
                onClick: () => {
                    runCommand("claude mcp add --transport http entropy-engine http://127.0.0.1:47100/mcp");
                },
            });
            Entropy.UI.Widget.button(w, {
                text: "Connect MCP to Antigravity",
                onClick: () => {
                    runCommand("agy mcp add --transport http entropy-engine http://127.0.0.1:47100/mcp");
                },
            });
            Entropy.UI.Widget.button(w, {
                text: "Test MCP Server",
                onClick: () => {
                    runCommand('node -e "fetch(\'http://127.0.0.1:47100/mcp\').then(r=>console.log(\'MCP Server active! HTTP Status:\', r.status)).catch(e=>console.error(\'MCP Server offline:\', e.message))"');
                },
            });
        });
    }

    // Convenience Action Section: Tooling & Installers
    Entropy.UI.Widget.label(win, { text: "Tooling Installers & System Utilities", bold: true, fontSize: 13.0 });
    if (isNarrow) {
        Entropy.UI.Widget.horizontal(win, (w) => {
            Entropy.UI.Widget.button(w, {
                text: "Install Claude Code",
                onClick: () => {
                    runCommand("npm install -g @anthropic-ai/claude-code");
                },
            });
            Entropy.UI.Widget.button(w, {
                text: "Install Antigravity CLI",
                onClick: () => {
                    runCommand("npm install -g antigravity-cli");
                },
            });
        });
        Entropy.UI.Widget.horizontal(win, (w) => {
            Entropy.UI.Widget.button(w, {
                text: "System Check",
                onClick: () => {
                    runCommand("node -v; npm -v; git --version; cargo --version");
                },
            });
            Entropy.UI.Widget.button(w, {
                text: "Git Status",
                onClick: () => {
                    runCommand("git status -s");
                },
            });
            Entropy.UI.Widget.button(w, {
                text: "Monorepo Build",
                onClick: () => {
                    runCommand("npm run build");
                },
            });
        });
    } else {
        Entropy.UI.Widget.horizontal(win, (w) => {
            Entropy.UI.Widget.button(w, {
                text: "Install Claude Code",
                onClick: () => {
                    runCommand("npm install -g @anthropic-ai/claude-code");
                },
            });
            Entropy.UI.Widget.button(w, {
                text: "Install Antigravity CLI",
                onClick: () => {
                    runCommand("npm install -g antigravity-cli");
                },
            });
            Entropy.UI.Widget.button(w, {
                text: "System Check",
                onClick: () => {
                    runCommand("node -v; npm -v; git --version; cargo --version");
                },
            });
            Entropy.UI.Widget.button(w, {
                text: "Git Status",
                onClick: () => {
                    runCommand("git status -s");
                },
            });
            Entropy.UI.Widget.button(w, {
                text: "Monorepo Build",
                onClick: () => {
                    runCommand("npm run build");
                },
            });
        });
    }

    Entropy.UI.Widget.separator(win);

    // Style & Typography Toolbar
    if (isNarrow) {
        Entropy.UI.Widget.horizontal(win, (w) => {
            Entropy.UI.Widget.label(w, { text: "Font:", bold: true });
            for (const font of POPULAR_FONTS.slice(0, 3)) {
                Entropy.UI.Widget.button(w, {
                    text: selectedFont === font ? `✓ ${font}` : font,
                    onClick: () => {
                        selectedFont = font;
                    },
                });
            }
            Entropy.UI.Widget.button(w, {
                text: showAllFonts ? "Less ▲" : "More ▼",
                onClick: () => {
                    showAllFonts = !showAllFonts;
                },
            });
            Entropy.UI.Widget.button(w, {
                text: "A-",
                onClick: () => {
                    fontSize = Math.max(10.0, fontSize - 1.0);
                },
            });
            Entropy.UI.Widget.label(w, { text: `${fontSize}pt` });
            Entropy.UI.Widget.button(w, {
                text: "A+",
                onClick: () => {
                    fontSize = Math.min(24.0, fontSize + 1.0);
                },
            });
        });
        Entropy.UI.Widget.horizontal(win, (w) => {
            Entropy.UI.Widget.label(w, { text: "Theme:", bold: true });
            for (const th of THEMES) {
                Entropy.UI.Widget.button(w, {
                    text: selectedTheme === th ? `✓ ${th.toUpperCase()}` : th.toUpperCase(),
                    onClick: () => {
                        selectedTheme = th;
                    },
                });
            }
        });
    } else {
        Entropy.UI.Widget.horizontal(win, (w) => {
            Entropy.UI.Widget.label(w, { text: "Font:", bold: true });
            for (const font of POPULAR_FONTS.slice(0, 6)) {
                Entropy.UI.Widget.button(w, {
                    text: selectedFont === font ? `✓ ${font}` : font,
                    onClick: () => {
                        selectedFont = font;
                    },
                });
            }

            Entropy.UI.Widget.button(w, {
                text: showAllFonts ? "Less Fonts ▲" : "More Fonts ▼",
                onClick: () => {
                    showAllFonts = !showAllFonts;
                },
            });

            // Font size buttons
            Entropy.UI.Widget.button(w, {
                text: "A-",
                onClick: () => {
                    fontSize = Math.max(10.0, fontSize - 1.0);
                },
            });
            Entropy.UI.Widget.label(w, { text: `${fontSize}pt` });
            Entropy.UI.Widget.button(w, {
                text: "A+",
                onClick: () => {
                    fontSize = Math.min(24.0, fontSize + 1.0);
                },
            });

            // Theme buttons
            for (const th of THEMES) {
                Entropy.UI.Widget.button(w, {
                    text: selectedTheme === th ? `✓ ${th.toUpperCase()}` : th.toUpperCase(),
                    onClick: () => {
                        selectedTheme = th;
                    },
                });
            }
        });
    }

    // Extended fonts selection row if requested
    if (showAllFonts && allCatalogFonts.length > 0) {
        Entropy.UI.Widget.horizontal(win, (w) => {
            Entropy.UI.Widget.label(w, { text: "Catalog:", bold: true });
            const sliceCount = isNarrow ? 6 : 10;
            for (const font of allCatalogFonts.slice(6, 6 + sliceCount)) {
                Entropy.UI.Widget.button(w, {
                    text: selectedFont === font ? `✓ ${font}` : font,
                    onClick: () => {
                        selectedFont = font;
                    },
                });
            }
        });
    }

    // Terminal display widget
    Entropy.UI.Widget.terminal(win, {
        id: "main_terminal_view",
        lines,
        isRunning,
        fontFamily: selectedFont,
        fontSize,
        theme: selectedTheme,
        height: 380.0,
        autoScroll,
    });

    // Command input & execution controls
    Entropy.UI.Widget.textInput(win, {
        id: "terminal_cmd_input",
        label: "Command:",
        value: commandInput,
        onChange: (val) => {
            commandInput = val;
        },
    });

    if (isNarrow) {
        Entropy.UI.Widget.horizontal(win, (w) => {
            Entropy.UI.Widget.button(w, {
                text: isRunning ? "Running..." : "Execute (Enter)",
                onClick: () => {
                    runCommand(commandInput);
                },
            });

            if (isRunning) {
                Entropy.UI.Widget.button(w, {
                    text: "■ Stop",
                    onClick: () => {
                        stopRunningProcess();
                    },
                });
            }

            Entropy.UI.Widget.button(w, {
                text: "Clear",
                onClick: () => {
                    clearTerminal();
                },
            });
        });

        Entropy.UI.Widget.horizontal(win, (w) => {
            Entropy.UI.Widget.button(w, {
                text: "Copy Output",
                onClick: () => {
                    copyAllOutput();
                },
            });

            Entropy.UI.Widget.button(w, {
                text: autoScroll ? "Scroll: ON" : "Scroll: OFF",
                onClick: () => {
                    autoScroll = !autoScroll;
                },
            });

            if (cmdHistory.length > 0) {
                Entropy.UI.Widget.button(w, {
                    text: "↑ Last",
                    onClick: () => {
                        if (cmdHistory.length > 0) {
                            historyIndex = Math.max(0, historyIndex - 1);
                            commandInput = cmdHistory[historyIndex] || cmdHistory[cmdHistory.length - 1];
                        }
                    },
                });
            }
        });
    } else {
        Entropy.UI.Widget.horizontal(win, (w) => {
            Entropy.UI.Widget.button(w, {
                text: isRunning ? "Running..." : "Execute Command (Enter)",
                onClick: () => {
                    runCommand(commandInput);
                },
            });

            if (isRunning) {
                Entropy.UI.Widget.button(w, {
                    text: "■ Stop / Terminate Process",
                    onClick: () => {
                        stopRunningProcess();
                    },
                });
            }

            Entropy.UI.Widget.button(w, {
                text: "Clear Output",
                onClick: () => {
                    clearTerminal();
                },
            });

            Entropy.UI.Widget.button(w, {
                text: "Copy Output",
                onClick: () => {
                    copyAllOutput();
                },
            });

            Entropy.UI.Widget.button(w, {
                text: autoScroll ? "Auto-Scroll: ON" : "Auto-Scroll: OFF",
                onClick: () => {
                    autoScroll = !autoScroll;
                },
            });

            if (cmdHistory.length > 0) {
                Entropy.UI.Widget.button(w, {
                    text: "↑ Last Command",
                    onClick: () => {
                        if (cmdHistory.length > 0) {
                            historyIndex = Math.max(0, historyIndex - 1);
                            commandInput = cmdHistory[historyIndex] || cmdHistory[cmdHistory.length - 1];
                        }
                    },
                });
            }
        });
    }
}

addon.onInit(async () => {
    setupUI();
});
