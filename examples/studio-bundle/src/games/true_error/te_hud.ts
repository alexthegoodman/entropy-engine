// True Error's screens, drawn with the retained Painter (allegiance/al_ui.ts): the title card,
// the play HUD (integrity, the rifle's charge, the lens, the objective, prompts, toasts), the
// subtitles, and the level-complete card. Brass and verdigris over a dark glass.

import { Painter, textWidth, type Color } from "../allegiance/al_ui";

export const TE = {
    brass: [0.86, 0.68, 0.36, 1] as Color,
    brassDim: [0.55, 0.43, 0.24, 1] as Color,
    cyan: [0.42, 0.86, 1, 1] as Color,
    red: [1, 0.25, 0.18, 1] as Color,
    violet: [0.7, 0.4, 1, 1] as Color,
    glass: [0.04, 0.035, 0.03, 0.62] as Color,
    ink: [0.92, 0.88, 0.8, 1] as Color,
    dim: [0.62, 0.58, 0.52, 1] as Color,
    shade: [0, 0, 0, 0.5] as Color,
    green: [0.45, 1, 0.5, 1] as Color,
};
export const FONT = { head: "Bungee", body: "Play", num: "Vina Sans" };

export const LENS_NAMES = ["STANDARD", "NIGHT", "HEAT", "DISTANCE", "SIMULATION"];

export interface HudView {
    integrity: number;
    energy: number;
    lens: number;
    objective: string;
    prompt: string;
    subtitle: { who: string; text: string; alpha: number } | null;
    toasts: { text: string; age: number; color: Color }[];
    hurt: number;
    crosshair: boolean;
    aiming: boolean;
    showHelp: boolean;
    dark: number;
    range: number | null;
    lockHint: boolean;
    /** The player last used a gamepad: its controls in the help. */
    pad: boolean;
    fps: number;
}

export function drawSubtitle(p: Painter, w: number, h: number, s: HudView["subtitle"], cinematic: boolean): void {
    if (!s || s.alpha <= 0.01) return;
    const size = Math.max(17, Math.min(24, w / 64));
    const maxW = Math.min(w * 0.7, 980);
    const lines = wrap(s.text, size, maxW);
    const lineH = size * 1.35;
    const bottom = cinematic ? h * 0.88 - 8 : h - 92;
    const top = bottom - lines.length * lineH - (s.who ? size * 1.2 : 0);
    const a = s.alpha;
    p.rect(w / 2 - maxW / 2 - 18, top - 10, maxW + 36, bottom - top + 18, [0, 0, 0, 0.45 * a]);
    if (s.who) p.textC(s.who, w / 2, top - 2, size * 0.72, [TE.brass[0], TE.brass[1], TE.brass[2], a], FONT.head);
    lines.forEach((l, i) => p.textC(l, w / 2, top + (s.who ? size * 1.2 : 0) + i * lineH, size, [TE.ink[0], TE.ink[1], TE.ink[2], a], FONT.body));
}

function wrap(text: string, size: number, maxW: number): string[] {
    const words = text.split(" ");
    const out: string[] = [];
    let line = "";
    for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (textWidth(next, size) > maxW && line) { out.push(line); line = word; }
        else line = next;
    }
    if (line) out.push(line);
    return out;
}

export function drawTitle(p: Painter, w: number, h: number, t: number): void {
    p.rect(0, 0, w, h, [0, 0, 0, 0.35]);
    const pulse = 0.75 + 0.25 * Math.sin(t * 2);
    const size = Math.min(110, w / 9);
    p.textC("TRUE ERROR", w / 2, h * 0.3, size, TE.brass, FONT.head);
    p.textC("LEVEL 1  -  THE CENTRAL SPIRE", w / 2, h * 0.3 + size * 1.25, size * 0.24, TE.ink, FONT.head);
    p.textC("Mars, 4122", w / 2, h * 0.3 + size * 1.75, size * 0.2, TE.dim, FONT.body);
    p.textC("Press ENTER, A or click to begin", w / 2, h * 0.72, 22, [TE.cyan[0], TE.cyan[1], TE.cyan[2], pulse], FONT.body);
    p.textC("ESC or B skips cutscenes", w / 2, h * 0.72 + 34, 16, TE.dim, FONT.body);
}

export function drawHud(p: Painter, w: number, h: number, v: HudView): void {
    // Integrity and charge, top left.
    const x = 28, y = 26, bw = 260;
    p.rect(x - 12, y - 12, bw + 24, 104, TE.glass);
    p.text("INTEGRITY", x, y - 2, 14, TE.brass, FONT.head);
    p.bar(x, y + 18, bw, 12, Math.max(0, v.integrity) / 100, v.integrity < 30 ? TE.red : TE.ink);
    p.text("PHOTON CHARGE", x, y + 38, 14, TE.brass, FONT.head);
    p.bar(x, y + 58, bw, 8, Math.max(0, v.energy) / 100, TE.cyan);
    p.text(`OBJECTIVE  ${v.objective}`, x - 4, y + 96, 15, TE.ink, FONT.body, 0, 0, TE.shade);
    // The lens, top right.
    const lensC = v.lens === 4 ? TE.cyan : v.lens === 1 ? TE.green : v.lens === 2 ? TE.red : TE.brass;
    p.textR(`LENS  ${LENS_NAMES[v.lens]}`, w - 28, 22, 18, lensC, FONT.head);
    p.textR(v.pad ? "Y switch lens" : "1-5 switch lens", w - 28, 48, 14, TE.dim, FONT.body);
    if (v.range !== null) p.textR(`RANGE ${v.range < 999 ? v.range.toFixed(1) + " m" : "---"}`, w - 28, 70, 18, TE.brass, FONT.num);
    // Crosshair.
    if (v.crosshair) {
        const cx = w / 2, cy = h / 2, g = v.aiming ? 5 : 9, c: Color = [1, 1, 1, 0.85];
        p.rect(cx - g - 8, cy - 1, 8, 2, c); p.rect(cx + g, cy - 1, 8, 2, c);
        p.rect(cx - 1, cy - g - 8, 2, 8, c); p.rect(cx - 1, cy + g, 2, 8, c);
        p.rect(cx - 1, cy - 1, 2, 2, TE.cyan);
    }
    if (v.prompt) {
        const size = 20;
        const tw = textWidth(v.prompt, size);
        p.rect(w / 2 - tw / 2 - 16, h * 0.62 - 8, tw + 32, size + 18, TE.glass);
        p.textC(v.prompt, w / 2, h * 0.62, size, TE.cyan, FONT.body);
    }
    if (v.dark > 0.05) p.textC("DARK RADIATION  -  COGNITION FAILING", w / 2, h * 0.2, 22, [TE.violet[0], TE.violet[1], TE.violet[2], Math.min(1, v.dark * 1.5)], FONT.head);
    // Toasts, right side.
    v.toasts.forEach((t, i) => {
        const a = Math.max(0, Math.min(1, 3.2 - t.age));
        p.textR(t.text, w - 28, h * 0.32 + i * 36, 19, [t.color[0], t.color[1], t.color[2], a], FONT.head);
    });
    if (v.showHelp) {
        const lines = v.pad
            ? ["L-STICK move (click: run)   A jump", "R-STICK look   RT fire   LT aim", "X reset a downed machine (or shoot it)", "Y / D-PAD lenses   BACK hide help"]
            : ["WASD move   SHIFT run   SPACE jump", "MOUSE look   LMB fire   RMB aim", "E reset a downed machine (or shoot it)", "1-5 lenses   H hide help"];
        const bx = 28, by = h - 40 - lines.length * 22;
        p.rect(bx - 12, by - 10, 360, lines.length * 22 + 18, TE.glass);
        lines.forEach((l, i) => p.text(l, bx, by + i * 22, 15, TE.dim, FONT.body));
    }
    if (v.lockHint) p.textC("Click to capture the mouse", w / 2, h * 0.08, 16, TE.dim, FONT.body);
    if (v.fps > 0) p.textR(`${Math.round(v.fps)} fps`, w - 28, h - 30, 13, TE.dim, FONT.body);
}

export interface Results { time: number; resets: number; destroyed: number; deaths: number }

export function drawComplete(p: Painter, w: number, h: number, r: Results, t: number): void {
    p.rect(0, 0, w, h, [0, 0, 0, Math.min(0.6, t * 0.3)]);
    if (t < 0.6) return;
    const size = Math.min(80, w / 12);
    p.textC("LEVEL COMPLETE", w / 2, h * 0.24, size, TE.brass, FONT.head);
    p.textC("The Central Spire", w / 2, h * 0.24 + size * 1.2, size * 0.32, TE.ink, FONT.body);
    const rows: [string, string][] = [
        ["TIME", `${Math.floor(r.time / 60)}:${String(Math.floor(r.time % 60)).padStart(2, "0")}`],
        ["MINDS RESTORED", String(r.resets)],
        ["MACHINES DESTROYED", String(r.destroyed)],
        ["REBOOTS", String(r.deaths)],
    ];
    const top = h * 0.46;
    rows.forEach(([k, v], i) => {
        p.textR(k, w / 2 - 20, top + i * 40, 22, TE.dim, FONT.head);
        p.text(v, w / 2 + 20, top + i * 40, 24, TE.ink, FONT.num);
    });
    const path = r.resets > r.destroyed ? "The Doctor will remember your mercy." : r.destroyed > r.resets ? "The scrap merchants will remember you." : "";
    if (path) p.textC(path, w / 2, top + rows.length * 40 + 20, 18, TE.cyan, FONT.body);
    p.textC("Press ENTER or A to play again", w / 2, h * 0.86, 18, TE.dim, FONT.body);
}
