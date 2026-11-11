// Every screen of Nebula Kingdom, drawn with rectangles and text through Allegiance's retained
// Painter: the title, the HUD (goals, the lightwave transcript, what the reticle rests on,
// cohesion and charge, rank and size, abilities), the Star Chart you fold from, the Codex
// (facets, abilities, the governments and where you stand with each), and the end cards.
// The views are plain data, so the addon builds them and tests can draw them into a fake.

import { Painter, type Color } from "../allegiance/al_ui";
import type { RGB } from "./nk_data";

export const C = {
    white: [0.95, 0.97, 1, 1] as Color,
    soft: [0.82, 0.88, 0.97, 1] as Color,
    dim: [0.74, 0.8, 0.92, 1] as Color,
    faint: [0.6, 0.7, 0.9, 0.22] as Color,
    glass: [0.02, 0.035, 0.07, 0.72] as Color,
    glassDark: [0.012, 0.02, 0.045, 0.9] as Color,
    line: [0.55, 0.75, 1, 0.3] as Color,
    cyan: [0.5, 0.92, 1, 1] as Color,
    gold: [1, 0.84, 0.45, 1] as Color,
    green: [0.55, 1, 0.72, 1] as Color,
    amber: [1, 0.74, 0.35, 1] as Color,
    red: [1, 0.38, 0.38, 1] as Color,
    violet: [0.8, 0.62, 1, 1] as Color,
    clear: [0, 0, 0, 0] as Color,
};
export const F = { head: "Iceberg", ui: "Exo", lore: "Federo" };

const rgba = (c: RGB | Color, a = 1): Color => [c[0], c[1], c[2], a];
const fade = (c: Color, a: number): Color => [c[0], c[1], c[2], c[3] * a];
const ADV: Record<string, number> = { Iceberg: 0.6, Exo: 0.53, Federo: 0.45 };
const tw = (s: string, size: number, font = F.ui) => s.length * size * (ADV[font] ?? 0.55);

function centered(p: Painter, s: string, cx: number, y: number, size: number, c: Color, font = F.ui): void {
    p.text(s, cx - tw(s, size, font) / 2, y, size, c, font);
}

function meter(p: Painter, x: number, y: number, w: number, h: number, value: number, c: Color): void {
    p.rect(x, y, w, h, [0, 0, 0, 0.5], 1, C.faint);
    const v = Math.max(0, Math.min(1, value));
    if (v > 0.004) p.rect(x + 1, y + 1, Math.max(1, (w - 2) * v), h - 2, c);
}

/** Wraps text to a width (the Painter's own wrap is the engine's; this is for measuring height). */
export function wrap(s: string, size: number, width: number): string[] {
    const words = s.split(" "), lines: string[] = [];
    let line = "";
    for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (tw(next, size) > width && line) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
}

function paragraph(p: Painter, s: string, x: number, y: number, size: number, width: number, c: Color, font = F.ui): number {
    const lines = wrap(s, size, width);
    lines.forEach((l, i) => p.text(l, x, y + i * size * 1.45, size, c, font));
    return y + lines.length * size * 1.45;
}

// --- The HUD ---------------------------------------------------------------------------------------

export interface HudGoal { text: string; done: boolean; progress: number; total: number; optional: boolean; locked: boolean }
export interface HudMessage { speaker: string; text: string; color: RGB; age: number; kind: string }
export interface HudAbility { name: string; key: string; ready: number; locked: number; active: boolean; affordable: boolean }
export interface HudMarker { x: number; y: number; label: string; sub: string; color: RGB; onscreen: boolean }
export interface HudFocus { x: number; y: number; size: number; name: string; line: string; note: string; color: RGB; health: number | null }
export interface HudView {
    w: number; h: number; time: number;
    region: string; galaxy: string; government: string; governmentColor: RGB; standing: string; complete: boolean;
    goals: HudGoal[];
    messages: HudMessage[];
    attune: boolean; veil: boolean;
    rank: string; level: number; maxLevel: number; progress: number; radius: string; compare: string;
    cohesion: number; charge: number; fed: boolean; points: number;
    abilities: HudAbility[];
    focus: HudFocus | null;
    markers: HudMarker[];
    stride: number; speed: string;
    warning: string;
    banner: { title: string; text: string; age: number; color: RGB } | null;
    toasts: { text: string; age: number }[];
    hints: string;
}

export function drawHud(p: Painter, v: HudView): void {
    const { w, h } = v;
    const m = 22;

    // Where you are, who governs it, and what is asked of you.
    p.text(v.region.toUpperCase(), m, m, 24, C.white, F.head);
    p.text(`${v.galaxy}  -  ${v.government}`, m, m + 30, 12, rgba(v.governmentColor, 0.95));
    p.text(`Standing: ${v.standing}`, m, m + 46, 11, C.dim);
    let y = m + 70;
    for (const g of v.goals) {
        const c = g.done ? fade(C.green, 0.75) : g.locked ? C.dim : g.optional ? C.soft : C.white;
        const mark = g.done ? "+" : g.locked ? "x" : "-";
        const count = g.total > 1 ? `  ${g.progress}/${g.total}` : "";
        const lines = wrap(`${g.text}${count}${g.optional && !g.done ? "  (optional)" : ""}`, 13, 340);
        p.text(mark, m, y, 13, c, F.head);
        lines.forEach((l, i) => p.text(l, m + 16, y + i * 18, 13, c));
        y += lines.length * 18 + 4;
    }
    if (v.complete) p.text("REGION COMPLETE  -  [M] STAR CHART", m, y + 4, 12, C.gold, F.head);

    // The lightwaves that have reached you.
    const tx = w - m - 380;
    p.text(v.attune ? "LIGHTWAVES  -  ATTUNED" : "LIGHTWAVES", tx, m, 12, v.attune ? C.cyan : C.dim, F.head);
    let ty = m + 20;
    for (const msg of v.messages) {
        const a = Math.max(0, Math.min(1, (16 - msg.age) / 3)) * Math.min(1, msg.age * 4 + 0.2);
        if (a <= 0.01) continue;
        p.text(msg.speaker.toUpperCase(), tx, ty, 11, rgba(msg.color, a), F.head);
        ty += 15;
        for (const l of wrap(msg.text, 13, 370)) { p.text(l, tx, ty, 13, fade(msg.kind === "edict" ? C.white : C.soft, a), msg.kind === "edict" ? F.lore : F.ui); ty += 18; }
        ty += 6;
    }

    // What you are.
    const by = h - m;
    p.text(`${v.rank.toUpperCase()}  -  LEVEL ${v.level}`, m, by - 118, 20, C.white, F.head);
    meter(p, m, by - 90, 300, 6, v.progress, C.gold);
    p.text(`Radius ${v.radius}  -  ${v.compare}`, m, by - 78, 12, C.soft);
    p.text("COHESION", m, by - 54, 10, C.dim, F.head);
    meter(p, m + 76, by - 53, 224, 10, v.cohesion, v.cohesion < 0.3 ? C.red : C.cyan);
    p.text("CHARGE", m, by - 36, 10, C.dim, F.head);
    meter(p, m + 76, by - 35, 224, 10, v.charge, C.violet);
    p.text(v.fed ? "Fed: knitting" : "Hungry: cohesion will not knit until you feed", m, by - 16, 11, v.fed ? C.dim : C.amber);
    if (v.points > 0) p.text(`${v.points} FACET POINT${v.points > 1 ? "S" : ""}  -  [TAB]`, m + 320, by - 116, 12, C.gold, F.head);
    if (v.veil) p.text("VEILED", m + 320, by - 54, 12, C.violet, F.head);

    // Abilities.
    const slot = 84, gap = 6, total = v.abilities.length * (slot + gap) - gap;
    let ax = (w - total) / 2;
    for (const a of v.abilities) {
        const locked = a.locked > 0;
        p.rect(ax, by - 46, slot, 46, a.active ? [0.3, 0.5, 0.9, 0.35] : C.glass, 1, a.active ? C.cyan : C.faint);
        if (!locked && a.ready < 1) p.rect(ax + 1, by - 3, (slot - 2) * a.ready, 2, C.cyan);
        p.text(a.key, ax + 6, by - 42, 10, locked ? C.dim : C.gold, F.head);
        p.text(locked ? `LEVEL ${a.locked}` : a.name, ax + 6, by - 24, 12, locked ? C.dim : a.ready >= 1 && a.affordable ? C.white : C.dim);
        ax += slot + gap;
    }
    p.text(v.hints, w - m - tw(v.hints, 11), by - 12, 11, C.dim);

    // The reticle and what it rests on.
    const cx = w / 2, cy = h / 2;
    p.rect(cx - 1, cy - 1, 2, 2, C.white);
    for (const [dx, dy, rw, rh] of [[-14, -0.5, 8, 1], [6, -0.5, 8, 1], [-0.5, -14, 1, 8], [-0.5, 6, 1, 8]]) p.rect(cx + dx, cy + dy, rw, rh, fade(C.white, 0.6));
    const f = v.focus;
    if (f) {
        const s = Math.max(18, Math.min(h * 0.42, f.size)), c = rgba(f.color, 0.9), k = Math.max(6, s * 0.22);
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
            p.rect(f.x + sx * s - (sx > 0 ? k : 0), f.y + sy * s - 0.75, k, 1.5, c);
            p.rect(f.x + sx * s - 0.75, f.y + sy * s - (sy > 0 ? k : 0), 1.5, k, c);
        }
        const ly = Math.min(h - 150, f.y + s + 8);
        centered(p, f.name.toUpperCase(), f.x, ly, 14, c, F.head);
        centered(p, f.line, f.x, ly + 18, 12, C.soft);
        if (f.health !== null) meter(p, f.x - 50, ly + 36, 100, 4, f.health, c);
        if (f.note) centered(p, f.note, f.x, ly + (f.health !== null ? 46 : 36), 12, C.gold);
    }
    for (const mk of v.markers) {
        const c = rgba(mk.color, mk.onscreen ? 0.9 : 0.7);
        p.rect(mk.x - 3, mk.y - 3, 6, 6, c);
        if (mk.onscreen) { p.text(mk.label, mk.x + 8, mk.y - 8, 11, c, F.head); p.text(mk.sub, mk.x + 8, mk.y + 5, 10, C.dim); }
        else p.text(mk.label, Math.max(m, Math.min(w - m - tw(mk.label, 10), mk.x - tw(mk.label, 10) / 2)), Math.max(m, Math.min(h - m - 12, mk.y + (mk.y < h / 2 ? 8 : -18))), 10, c, F.head);
    }

    if (v.stride > 0.05) centered(p, `LIGHTSTRIDE  -  ${v.speed}`, cx, h * 0.72, 13, fade(C.cyan, Math.min(1, v.stride * 3)), F.head);
    if (v.warning) centered(p, v.warning, cx, h * 0.3, 18, (v.time * 4) % 1 < 0.6 ? C.red : fade(C.red, 0.4), F.head);

    if (v.banner) {
        const b = v.banner, a = Math.min(1, b.age * 3) * Math.max(0, Math.min(1, (6 - b.age)));
        if (a > 0.01) {
            const bw = Math.min(w - 80, Math.max(tw(b.title, 34, F.head), tw(b.text, 14)) + 80);
            p.rect((w - bw) / 2, h * 0.15, bw, 1, rgba(b.color, a * 0.7));
            centered(p, b.title, cx, h * 0.15 + 12, 34, rgba(b.color, a), F.head);
            centered(p, b.text, cx, h * 0.15 + 56, 14, fade(C.white, a));
            p.rect((w - bw) / 2, h * 0.15 + 84, bw, 1, rgba(b.color, a * 0.7));
        }
    }
    v.toasts.forEach((t, i) => centered(p, t.text, cx, by - 84 - i * 20, 13, fade(C.white, Math.max(0, Math.min(1, 4.5 - t.age)))));
}

// --- The Star Chart ---------------------------------------------------------------------------------

export interface ChartRegion { id: string; name: string; text: string; state: "here" | "open" | "sealed" | "done"; size: string; why: string }
export interface ChartGalaxy { name: string; government: string; color: RGB; text: string; regions: ChartRegion[] }
export interface ChartView { w: number; h: number; galaxies: ChartGalaxy[]; selected: string; note: string }

export function drawChart(p: Painter, v: ChartView): void {
    const { w, h } = v;
    p.rect(0, 0, w, h, C.glassDark);
    centered(p, "STAR CHART", w / 2, 34, 34, C.white, F.head);
    centered(p, "A nebula folds along its own light. Any place your light has reached is a moment away - in this galaxy or any other.", w / 2, 78, 13, C.soft, F.lore);
    const cols = v.galaxies.length, gw = Math.min(250, (w - 80) / cols), x0 = (w - gw * cols) / 2, top = 124;
    let chosen: ChartRegion | null = null;
    v.galaxies.forEach((g, i) => {
        const x = x0 + i * gw + 6, cw = gw - 12;
        p.rect(x, top, cw, 2, rgba(g.color, 0.9));
        p.text(g.name.toUpperCase(), x, top + 10, 15, C.white, F.head);
        p.text(g.government, x, top + 32, 11, rgba(g.color, 0.95));
        const ty = paragraph(p, g.text, x, top + 52, 11, cw, C.dim);
        let ry = Math.max(ty + 10, top + 120);
        for (const r of g.regions) {
            const sel = r.id === v.selected;
            if (sel) chosen = r;
            const c = r.state === "sealed" ? C.dim : r.state === "here" ? C.cyan : r.state === "done" ? C.green : C.white;
            p.rect(x, ry, cw, 64, sel ? [0.25, 0.4, 0.75, 0.35] : [0.3, 0.4, 0.6, 0.1], 1, sel ? C.cyan : C.faint);
            p.text(r.name, x + 10, ry + 8, 14, c, F.head);
            p.text(r.state === "here" ? "You are here" : r.state === "sealed" ? "Sealed" : r.state === "done" ? "Complete - fold" : "Open - fold", x + 10, ry + 28, 11, c);
            p.text(r.size, x + 10, ry + 44, 10, C.dim);
            p.hotspot(`fold:${r.id}`, x, ry, cw, 64);
            ry += 72;
        }
    });
    const sel = chosen as ChartRegion | null;
    if (sel) {
        centered(p, sel.name.toUpperCase(), w / 2, h - 150, 20, C.white, F.head);
        centered(p, sel.text, w / 2, h - 122, 13, C.soft, F.lore);
        centered(p, sel.state === "sealed" ? sel.why : sel.state === "here" ? "You are here" : "[ENTER] or click again to fold", w / 2, h - 96, 13, sel.state === "sealed" ? C.amber : C.gold, F.head);
    }
    if (v.note) centered(p, v.note, w / 2, h - 70, 13, C.amber);
    centered(p, "[ARROWS] choose   [ENTER] fold   [M] or [ESC] close", w / 2, h - 40, 11, C.dim);
}

// --- The Codex: facets, abilities, governments ------------------------------------------------------

export interface CodexFacet { id: string; name: string; text: string; rank: number; max: number }
export interface CodexAbility { name: string; key: string; text: string; level: number; unlocked: boolean }
export interface CodexFaction { name: string; form: string; creed: string; color: RGB; standing: number; tier: string; laws: string[]; fluency: number }
export interface CodexView {
    w: number; h: number; points: number; rank: string; level: number; radius: string; compare: string;
    facets: CodexFacet[]; abilities: CodexAbility[]; factions: CodexFaction[];
    stats: string[];
}

export function drawCodex(p: Painter, v: CodexView): void {
    const { w, h } = v;
    p.rect(0, 0, w, h, C.glassDark);
    centered(p, `${v.rank.toUpperCase()}  -  LEVEL ${v.level}`, w / 2, 28, 30, C.white, F.head);
    centered(p, `Radius ${v.radius}  -  ${v.compare}`, w / 2, 66, 13, C.soft);
    const colW = Math.min(520, (w - 120) / 2), lx = w / 2 - colW - 20, rx = w / 2 + 20;

    p.text(`FACETS${v.points > 0 ? `  -  ${v.points} POINT${v.points > 1 ? "S" : ""} TO SPEND` : ""}`, lx, 104, 15, v.points > 0 ? C.gold : C.white, F.head);
    let y = 130;
    v.facets.forEach((f, i) => {
        p.rect(lx, y, colW, 46, [0.3, 0.4, 0.6, 0.1], 1, C.faint);
        p.text(`${i + 1}  ${f.name}`, lx + 10, y + 6, 14, C.white, F.head);
        for (let k = 0; k < f.max; k++) p.rect(lx + 150 + k * 16, y + 9, 11, 11, k < f.rank ? C.gold : [1, 1, 1, 0.08], 1, C.faint);
        p.text(f.text, lx + 10, y + 26, 11, C.dim);
        if (v.points > 0 && f.rank < f.max) { p.rect(lx + colW - 46, y + 8, 36, 30, [1, 0.84, 0.45, 0.18], 1, C.gold); p.text("+", lx + colW - 33, y + 11, 18, C.gold, F.head); p.hotspot(`facet:${f.id}`, lx + colW - 46, y + 8, 36, 30); }
        y += 52;
    });
    y += 8;
    p.text("ABILITIES", lx, y, 15, C.white, F.head);
    y += 24;
    for (const a of v.abilities) {
        const c = a.unlocked ? C.white : C.dim;
        p.text(a.key, lx, y, 11, a.unlocked ? C.gold : C.dim, F.head);
        p.text(a.unlocked ? a.name : `${a.name} (level ${a.level})`, lx + 56, y, 12, c, F.head);
        y = Math.max(y + 22, paragraph(p, a.text, lx + 190, y, 11, colW - 190, C.dim) + 4);
    }
    y += 8;
    v.stats.forEach((s, i) => p.text(s, lx + (i % 2) * (colW / 2), y + Math.floor(i / 2) * 16, 11, C.dim));

    p.text("THE GOVERNMENTS", rx, 104, 15, C.white, F.head);
    let gy = 130;
    for (const f of v.factions) {
        const c = rgba(f.color, 1);
        p.rect(rx, gy, 3, 92, c);
        p.text(f.name.toUpperCase(), rx + 12, gy, 14, c, F.head);
        p.text(f.tier.toUpperCase(), rx + colW - 90, gy, 12, f.standing <= -15 ? C.red : f.standing >= 25 ? C.green : C.soft, F.head);
        meter(p, rx + 12, gy + 21, colW - 12, 5, (f.standing + 100) / 200, c);
        p.rect(rx + 12 + (colW - 12) / 2, gy + 19, 1, 9, C.dim);
        p.text(f.form, rx + 12, gy + 32, 11, C.soft);
        p.text(`"${f.creed}"`, rx + 12, gy + 48, 12, C.white, F.lore);
        p.text(f.laws[0] ?? "", rx + 12, gy + 66, 10, C.dim);
        p.text(f.fluency >= 1 ? "You understand their light." : `Their tongue is ${Math.round(f.fluency * 100)}% clear to you: listen (Attune helps).`, rx + 12, gy + 80, 10, f.fluency >= 1 ? C.dim : C.amber);
        gy += 104;
    }
    centered(p, "[1-6] spend a facet point   [G] near an envoy: offer tribute   [TAB] or [ESC] close", w / 2, h - 34, 11, C.dim);
}

// --- Title and end cards ----------------------------------------------------------------------------

export interface TitleView { w: number; h: number; time: number; canContinue: boolean; summary: string; sound: boolean }

export function drawTitle(p: Painter, v: TitleView): void {
    const { w, h } = v;
    p.rect(0, 0, w, h, [0, 0.005, 0.02, 0.25]);
    centered(p, "NEBULA KINGDOM", w / 2, h * 0.2, 86, C.white, F.head);
    centered(p, "You are born the size of a moon. You will end wider than a star.", w / 2, h * 0.2 + 104, 18, C.soft, F.lore);
    const bw = 300, bx = (w - bw) / 2;
    let y = h * 0.5;
    if (v.canContinue) {
        p.button("continue", bx, y, bw, 46, "CONTINUE", "ghost", { size: 16 });
        centered(p, v.summary, w / 2, y + 52, 12, C.dim);
        y += 84;
    }
    p.button("new", bx, y, bw, 46, v.canContinue ? "A NEW NEBULA" : "BEGIN", "ghost", { size: 16 });
    y += 60;
    p.button("sound", bx, y, bw, 34, v.sound ? "SOUND: ON" : "SOUND: OFF", "ghost", { size: 12 });
    const lines = [
        "MOUSE steer  -  W/S thrust  -  A/D strafe  -  SPACE/CTRL rise and sink  -  SHIFT Lightstride",
        "LMB Lance  -  E siphon a world or a star  -  Q Pulse  -  C Veil  -  F Shed  -  R Starfire  -  T Attune",
        "M Star Chart (fold anywhere)  -  TAB Codex  -  G tribute to an envoy  -  gamepad supported",
    ];
    lines.forEach((l, i) => centered(p, l, w / 2, h - 96 + i * 20, 12, C.dim));
}

export function drawDispersed(p: Painter, w: number, h: number, t: number): void {
    const a = Math.min(1, t / 1.2);
    p.rect(0, 0, w, h, [0.02, 0, 0.03, 0.55 * a]);
    centered(p, "DISPERSED", w / 2, h * 0.4, 56, fade(C.red, a), F.head);
    centered(p, "Your light scatters... and gathers again, a little less than it was.", w / 2, h * 0.4 + 72, 15, fade(C.soft, a), F.lore);
}

export function drawFold(p: Painter, w: number, h: number, name: string, galaxy: string, t: number): void {
    const a = Math.min(1, t * 2) * Math.min(1, (1 - t) * 4 + 0.2);
    centered(p, "FOLDING", w / 2, h * 0.7, 14, fade(C.cyan, a), F.head);
    centered(p, name.toUpperCase(), w / 2, h * 0.7 + 22, 34, fade(C.white, a), F.head);
    centered(p, galaxy, w / 2, h * 0.7 + 66, 14, fade(C.soft, a), F.lore);
}

export function drawCrowned(p: Painter, w: number, h: number, t: number, lines: string[]): void {
    const a = Math.min(1, t / 2);
    p.rect(0, 0, w, h, [0.02, 0.015, 0.05, 0.6 * a]);
    centered(p, "NEBULA MONARCH", w / 2, h * 0.24, 72, fade(C.gold, a), F.head);
    centered(p, "The Hollow King is gone into the white. Five governments look to one light.", w / 2, h * 0.24 + 96, 17, fade(C.white, a), F.lore);
    centered(p, "The kingdom is yours. It is as wide as you are.", w / 2, h * 0.24 + 124, 17, fade(C.white, a), F.lore);
    lines.forEach((l, i) => centered(p, l, w / 2, h * 0.55 + i * 24, 14, fade(C.soft, a)));
    p.button("reign", (w - 300) / 2, h * 0.8, 300, 46, "REIGN ON", "ghost", { size: 16 });
}
