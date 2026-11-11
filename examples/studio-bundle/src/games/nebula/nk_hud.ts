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

export interface HudGoal { text: string; done: boolean; progress: number; total: number; optional: boolean; locked: boolean; /** How to do it (shown beneath it). */ how?: string }
export interface HudLesson { title: string; text: string; age: number; life: number; more: number; next: string }
export interface HudBlast { name: string; key: string; selected: boolean; locked: number }
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
    blasts?: HudBlast[];
    blastKey?: string;
    grace?: { value: number; tier: string };
    form?: string;
    lesson?: HudLesson | null;
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
        if (g.how) {
            // How to do it, in the guide's gold, beneath the goal.
            const how = wrap(g.how, 11, 330);
            p.rect(m + 16, y - 1, 2, how.length * 15 - 2, fade(C.gold, 0.6));
            how.forEach((l, i) => p.text(l, m + 24, y + i * 15, 11, fade(C.gold, 0.85)));
            y += how.length * 15 + 6;
        }
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

    // The Field Guide: the lesson for whatever is new, at the right under the lightwaves.
    const l = v.lesson;
    if (l) {
        const a = Math.min(1, l.age * 4) * Math.max(0, Math.min(1, (l.life - l.age) * 1.5));
        const lines = wrap(l.text, 13, 352);
        const ch = 46 + lines.length * 18 + 22;
        const cy = Math.max(ty + 8, h - m - 70 - ch);
        p.rect(tx - 10, cy, 390, ch, fade(C.glassDark, a), 1, fade(C.gold, 0.55 * a));
        p.rect(tx - 10, cy, 3, ch, fade(C.gold, a));
        p.text("FIELD GUIDE", tx + 4, cy + 10, 10, fade(C.gold, 0.8 * a), F.head);
        p.text(l.title, tx + 4, cy + 24, 16, fade(C.white, a), F.head);
        lines.forEach((s2, i) => p.text(s2, tx + 4, cy + 48 + i * 18, 13, fade(C.soft, a)));
        p.text(`[${l.next}] ${l.more > 0 ? `next tip (${l.more} more)` : "hide"}`, tx + 4, cy + ch - 18, 10, fade(C.dim, a), F.head);
        // How long it has left.
        p.rect(tx - 7, cy + ch - 3, 384 * Math.max(0, 1 - l.age / l.life), 2, fade(C.gold, 0.5 * a));
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
    if (v.points > 0) p.text(`${v.points} FACET POINT${v.points > 1 ? "S" : ""}  -  OPEN THE CODEX`, m + 320, by - 116, 12, C.gold, F.head);
    if (v.veil) p.text("VEILED", m + 320, by - 54, 12, C.violet, F.head);
    if (v.form) p.text(v.form.toUpperCase(), m, by - 140, 11, C.soft, F.head);
    if (v.grace) {
        // Grace to the right of centre, Ruin to the left.
        const g = v.grace, gc: Color = g.value >= 0 ? [1, 0.9, 0.6, 1] : [0.9, 0.3, 0.45, 1];
        p.text(`${g.tier.toUpperCase()}  ${g.value > 0 ? "+" : ""}${Math.round(g.value)}`, m + 320, by - 96, 11, g.value === 0 ? C.dim : gc, F.head);
        p.rect(m + 320, by - 80, 120, 4, [0, 0, 0, 0.5], 1, C.faint);
        const half = 60 * Math.min(1, Math.abs(g.value) / 100);
        p.rect(g.value >= 0 ? m + 380 : m + 380 - half, by - 79, half, 2, gc);
        p.rect(m + 380, by - 82, 1, 8, C.dim);
        p.text("RUIN", m + 320, by - 72, 8, C.dim, F.head);
        p.text("GRACE", m + 416, by - 72, 8, C.dim, F.head);
    }

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
    centered(p, v.hints, w / 2, by + 5, 10, C.dim);

    // The blasts you know, above the abilities: the one {fire} throws is lit.
    if (v.blasts && v.blasts.some(b => !b.locked && !b.selected)) {
        const bw = 92, bg = 4, bt = v.blasts.length * (bw + bg) - bg;
        let bx = (w - bt) / 2;
        if (v.blastKey) p.text(`[${v.blastKey}]`, bx + bt + 8, by - 66, 10, C.dim, F.head);
        for (const b of v.blasts) {
            const c = b.locked ? C.dim : b.selected ? C.gold : C.soft;
            p.rect(bx, by - 70, bw, 18, b.selected ? [1, 0.84, 0.45, 0.2] : [0.02, 0.035, 0.07, 0.5], 1, b.selected ? C.gold : C.faint);
            p.text(b.locked ? `LEVEL ${b.locked}` : `${b.key ? `${b.key} ` : ""}${b.name}`, bx + 6, by - 67, 10, c, F.head);
            bx += bw + bg;
        }
    }

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
    v.toasts.forEach((t, i) => centered(p, t.text, cx, by - 96 - i * 20, 13, fade(C.white, Math.max(0, Math.min(1, 4.5 - t.age)))));
}

// --- The Star Chart ---------------------------------------------------------------------------------

export interface ChartRegion { id: string; name: string; text: string; state: "here" | "open" | "sealed" | "done"; size: string; why: string }
export interface ChartGalaxy { name: string; government: string; color: RGB; text: string; regions: ChartRegion[] }
export interface ChartView { w: number; h: number; galaxies: ChartGalaxy[]; selected: string; note: string; hints?: string }

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
        centered(p, sel.state === "sealed" ? sel.why : sel.state === "here" ? "You are here" : v.hints?.startsWith("[D-PAD]") ? "[A] to fold" : "[ENTER] or click again to fold", w / 2, h - 96, 13, sel.state === "sealed" ? C.amber : C.gold, F.head);
    }
    if (v.note) centered(p, v.note, w / 2, h - 70, 13, C.amber);
    centered(p, v.hints ?? "[ARROWS] choose   [ENTER] fold   [M] or [ESC] close", w / 2, h - 40, 11, C.dim);
}

// --- The Codex: facets, form, Grace, blasts, abilities, governments ---------------------------------

export interface CodexFacet { id: string; name: string; text: string; rank: number; max: number }
export interface CodexAbility { name: string; key: string; text: string; level: number; unlocked: boolean }
export interface CodexFaction { name: string; form: string; creed: string; color: RGB; standing: number; tier: string; laws: string[]; fluency: number }
export interface CodexForm { id: string; name: string; text: string; perks: string[]; color: RGB; chosen: boolean }
export interface CodexBlast { id: string; name: string; text: string; level: number; unlocked: boolean; selected: boolean; color: RGB }
export interface CodexView {
    w: number; h: number; points: number; rank: string; level: number; radius: string; compare: string;
    facets: CodexFacet[]; abilities: CodexAbility[]; factions: CodexFaction[];
    stats: string[];
    forms?: CodexForm[]; formNote?: string;
    blasts?: CodexBlast[];
    grace?: { value: number; tier: string };
    /** The item a gamepad cursor rests on ("facet:density", "form:dark", ...). */
    cursor?: string;
    note?: string;
    hints?: string;
}

export function drawCodex(p: Painter, v: CodexView): void {
    const { w, h } = v;
    p.rect(0, 0, w, h, C.glassDark);
    centered(p, `${v.rank.toUpperCase()}  -  LEVEL ${v.level}`, w / 2, 24, 28, C.white, F.head);
    centered(p, `Radius ${v.radius}  -  ${v.compare}`, w / 2, 58, 13, C.soft);
    const gap = 24, colW = Math.min(440, (w - 60 - gap * 2) / 3), x0 = (w - colW * 3 - gap * 2) / 2;
    const lx = x0, mx = x0 + colW + gap, rx = x0 + (colW + gap) * 2, top = 92;
    const cursorBox = (id: string, x: number, y: number, bw: number, bh: number) => { if (v.cursor === id) p.rect(x - 3, y - 3, bw + 6, bh + 6, [0, 0, 0, 0], 2, C.cyan); };

    // Facets.
    p.text(`FACETS${v.points > 0 ? `  -  ${v.points} POINT${v.points > 1 ? "S" : ""} TO SPEND` : ""}`, lx, top, 14, v.points > 0 ? C.gold : C.white, F.head);
    let y = top + 24;
    v.facets.forEach((f, i) => {
        p.rect(lx, y, colW, 44, [0.3, 0.4, 0.6, 0.1], 1, C.faint);
        cursorBox(`facet:${f.id}`, lx, y, colW, 44);
        p.text(`${i + 1}  ${f.name}`, lx + 10, y + 5, 13, C.white, F.head);
        for (let k = 0; k < f.max; k++) p.rect(lx + 140 + k * 15, y + 8, 10, 10, k < f.rank ? C.gold : [1, 1, 1, 0.08], 1, C.faint);
        p.text(f.text, lx + 10, y + 25, 10, C.dim);
        if (v.points > 0 && f.rank < f.max) { p.rect(lx + colW - 42, y + 7, 32, 30, [1, 0.84, 0.45, 0.18], 1, C.gold); p.text("+", lx + colW - 31, y + 10, 18, C.gold, F.head); p.hotspot(`facet:${f.id}`, lx + colW - 42, y + 7, 32, 30); }
        y += 49;
    });
    y += 10;
    p.text("ABILITIES", lx, y, 14, C.white, F.head);
    y += 22;
    for (const a of v.abilities) {
        p.text(a.key, lx, y, 10, a.unlocked ? C.gold : C.dim, F.head);
        p.text(a.unlocked ? a.name : `${a.name} (level ${a.level})`, lx + 96, y, 11, a.unlocked ? C.white : C.dim, F.head);
        y += 17;
    }
    y += 10;
    v.stats.forEach((st, i) => p.text(st, lx + (i % 2) * (colW / 2), y + Math.floor(i / 2) * 15, 10, C.dim));

    // Form, Grace and blasts.
    let my = top;
    if (v.forms) {
        p.text("YOUR FORM", mx, my, 14, C.white, F.head);
        if (v.formNote) p.text(v.formNote, mx + 110, my + 3, 10, C.amber);
        my += 24;
        for (const f of v.forms) {
            const c = rgba(f.color, 1);
            p.rect(mx, my, colW, 58, f.chosen ? [f.color[0] * 0.3, f.color[1] * 0.3, f.color[2] * 0.3, 0.5] : [0.3, 0.4, 0.6, 0.1], 1, f.chosen ? c : C.faint);
            cursorBox(`form:${f.id}`, mx, my, colW, 58);
            p.rect(mx, my, 3, 58, c);
            p.text(f.name.toUpperCase(), mx + 12, my + 5, 13, c, F.head);
            if (f.chosen) p.text("YOU", mx + colW - 40, my + 6, 11, c, F.head);
            p.text(f.text, mx + 12, my + 22, 10, C.soft, F.lore);
            p.text(f.perks.join("  -  "), mx + 12, my + 38, 9, C.dim);
            p.hotspot(`form:${f.id}`, mx, my, colW, 58);
            my += 63;
        }
        my += 6;
    }
    if (v.grace) {
        const g = v.grace, gc: Color = g.value >= 0 ? [1, 0.9, 0.6, 1] : [0.9, 0.3, 0.45, 1];
        p.text("GRACE AND RUIN", mx, my, 14, C.white, F.head);
        p.text(`${g.tier.toUpperCase()}  ${g.value > 0 ? "+" : ""}${Math.round(g.value)}`, mx + colW - 120, my + 2, 12, g.value === 0 ? C.soft : gc, F.head);
        my += 22;
        meter(p, mx, my, colW, 6, (g.value + 100) / 200, gc);
        p.rect(mx + colW / 2, my - 2, 1, 10, C.dim);
        my += 12;
        p.text("Mercy, tribute and defence bring Grace: cohesion knits faster.", mx, my, 10, C.dim);
        p.text("Crimes and devouring bring Ruin: your blasts bite harder.", mx, my + 14, 10, C.dim);
        my += 38;
    }
    if (v.blasts) {
        p.text("BLASTS", mx, my, 14, C.white, F.head);
        my += 22;
        v.blasts.forEach((b, i) => {
            const c = !b.unlocked ? C.dim : b.selected ? C.gold : C.white;
            p.rect(mx, my, colW, 34, b.selected ? [1, 0.84, 0.45, 0.14] : [0.3, 0.4, 0.6, 0.08], 1, b.selected ? C.gold : C.faint);
            cursorBox(`blast:${b.id}`, mx, my, colW, 34);
            p.text(`${i + 1}  ${b.unlocked ? b.name : `${b.name} (level ${b.level})`}`, mx + 8, my + 4, 12, c, F.head);
            const t = wrap(b.text, 9, colW - 16)[0] ?? "";
            p.text(t, mx + 8, my + 20, 9, C.dim);
            if (b.unlocked) p.hotspot(`blast:${b.id}`, mx, my, colW, 34);
            my += 38;
        });
    }

    // The governments.
    p.text("THE GOVERNMENTS", rx, top, 14, C.white, F.head);
    let gy = top + 24;
    const step = Math.min(104, Math.max(86, (h - 60 - gy) / Math.max(1, v.factions.length)));
    for (const f of v.factions) {
        const c = rgba(f.color, 1);
        p.rect(rx, gy, 3, step - 12, c);
        p.text(f.name.toUpperCase(), rx + 12, gy, 13, c, F.head);
        p.text(f.tier.toUpperCase(), rx + colW - 80, gy, 11, f.standing <= -15 ? C.red : f.standing >= 25 ? C.green : C.soft, F.head);
        meter(p, rx + 12, gy + 19, colW - 12, 5, (f.standing + 100) / 200, c);
        p.rect(rx + 12 + (colW - 12) / 2, gy + 17, 1, 9, C.dim);
        p.text(f.form, rx + 12, gy + 30, 10, C.soft);
        p.text(`"${f.creed}"`, rx + 12, gy + 45, 11, C.white, F.lore);
        p.text(wrap(f.laws[0] ?? "", 9, colW - 12)[0] ?? "", rx + 12, gy + 61, 9, C.dim);
        p.text(f.fluency >= 1 ? "You understand their light." : `Their tongue is ${Math.round(f.fluency * 100)}% clear to you: listen (Attune helps).`, rx + 12, gy + 74, 9, f.fluency >= 1 ? C.dim : C.amber);
        gy += step;
    }
    if (v.note) centered(p, v.note, w / 2, h - 54, 12, C.amber);
    centered(p, v.hints ?? "[1-6] spend a facet point   [G] near an envoy: offer tribute   [TAB] or [ESC] close", w / 2, h - 30, 11, C.dim);
}

// --- Title and end cards ----------------------------------------------------------------------------

export interface TitleControl { what: string; keys: string; pad: string }
export interface TitleView { w: number; h: number; time: number; canContinue: boolean; summary: string; sound: boolean; device?: "keys" | "pad"; controls?: TitleControl[] }

export function drawTitle(p: Painter, v: TitleView): void {
    const { w, h } = v;
    p.rect(0, 0, w, h, [0, 0.005, 0.02, 0.25]);
    centered(p, "NEBULA KINGDOM", w / 2, h * 0.14, Math.min(86, w / 15), C.white, F.head);
    centered(p, "You are born the size of a moon. You will end wider than a star.", w / 2, h * 0.14 + Math.min(86, w / 15) + 18, 18, C.soft, F.lore);
    const bw = 300, bx = (w - bw) / 2;
    let y = h * 0.42;
    if (v.canContinue) {
        p.button("continue", bx, y, bw, 46, "CONTINUE", "ghost", { size: 16 });
        centered(p, v.summary, w / 2, y + 52, 12, C.dim);
        y += 84;
    }
    p.button("new", bx, y, bw, 46, v.canContinue ? "A NEW NEBULA" : "BEGIN", "ghost", { size: 16 });
    y += 60;
    p.button("sound", bx, y, bw, 34, v.sound ? "SOUND: ON" : "SOUND: OFF", "ghost", { size: 12 });
    y += 52;
    const pad = v.device === "pad";
    centered(p, pad ? "PRESS  [A]  OR  [START]  TO PLAY" : "PRESS  [ENTER]  TO PLAY  -  OR CLICK", w / 2, y, 13, C.gold, F.head);

    // The controls, keyboard and gamepad side by side (the one you are holding is lit).
    const rows = v.controls ?? [];
    if (!rows.length) return;
    const pw = Math.min(340, (w - bw - 120) / 2), rowH = Math.min(18, (h * 0.5) / (rows.length + 2));
    const top = h * 0.4;
    const panel = (x: number, title: string, which: "keys" | "pad") => {
        const on = (v.device ?? "keys") === which;
        const ph = rowH * rows.length + 44;
        p.rect(x, top, pw, ph, on ? [0.05, 0.1, 0.2, 0.55] : [0.02, 0.035, 0.07, 0.4], 1, on ? C.cyan : C.faint);
        p.text(title, x + 12, top + 10, 13, on ? C.cyan : C.soft, F.head);
        if (on) p.text("IN USE", x + pw - 60, top + 11, 10, C.cyan, F.head);
        rows.forEach((r, i) => {
            const ry = top + 34 + i * rowH;
            p.text(r.what, x + 12, ry, 11, on ? C.soft : C.dim);
            const k = which === "keys" ? r.keys : r.pad;
            p.text(k, x + pw - 12 - tw(k, 11, F.head), ry, 11, on ? C.white : C.dim, F.head);
        });
    };
    panel(bx - 30 - pw, "KEYBOARD & MOUSE", "keys");
    panel(bx + bw + 30, "GAMEPAD", "pad");
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
