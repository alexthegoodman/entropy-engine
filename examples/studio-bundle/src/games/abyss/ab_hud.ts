// Every screen of The Abyss, drawn with Entropy.UI.drawRect/drawText through Allegiance's
// retained Painter (al_ui.ts): the loading screen, the title, cutscene letterbox and cards, the
// augmented-reality HUD Alex sees through his augment, the "signal lost" screen, the inventory and
// codex, and the chapter's end card.
//
// The AR HUD is a thin cyan holograph over the world: corner brackets framing the view, a compass
// ribbon with the objective's bearing, the objective, the squad's vitals, Alex's vitals and the
// depth below the rim, the weapon and its coils, an adaptive crosshair, brackets round every
// warden in sight (all of them, through rock, for a while after a scan), markers on the squad,
// pickups and aircraft, the radio and SAGE, damage arcs, and the boot sequence.

import { Painter, type Color, type DrawApi } from "../allegiance/al_ui";
import type { V3 } from "./ab_world";

export const C = {
    cyan: [0.45, 0.93, 1, 1] as Color,
    cyanDim: [0.45, 0.93, 1, 0.42] as Color,
    cyanFaint: [0.45, 0.93, 1, 0.16] as Color,
    glass: [0.02, 0.07, 0.09, 0.42] as Color,
    glassDark: [0.01, 0.03, 0.04, 0.7] as Color,
    amber: [1, 0.76, 0.32, 1] as Color,
    amberDim: [1, 0.76, 0.32, 0.45] as Color,
    red: [1, 0.33, 0.28, 1] as Color,
    redDim: [1, 0.33, 0.28, 0.4] as Color,
    green: [0.5, 1, 0.72, 1] as Color,
    white: [0.94, 0.97, 1, 1] as Color,
    grey: [0.62, 0.68, 0.72, 1] as Color,
    violet: [0.82, 0.62, 1, 1] as Color,
    black: [0, 0, 0, 1] as Color,
    clear: [0, 0, 0, 0] as Color,
    gold: [1, 0.84, 0.36, 1] as Color,
};

/** Fonts from the engine's catalog: a clean technical face, a sci-fi display face, a serif for lore. */
export const F = { ui: "Exo", head: "Iceberg", lore: "Federo", body: "Play" };

const ADV: Record<string, number> = { Exo: 0.55, Iceberg: 0.42, Federo: 0.5, Play: 0.5 };
export const tw = (s: string, size: number, font = F.ui) => s.length * size * (ADV[font] ?? 0.55);

const alpha = (c: Color, a: number): Color => [c[0], c[1], c[2], c[3] * a];

// --- A painter that never hands the engine a broken shape --------------------------------------------

/**
 * Allegiance's Painter, refusing rectangles and texts with a non-finite or empty geometry (the
 * engine cannot draw an empty polygon). The first one refused is reported, to find its source.
 */
export class SafePainter extends Painter {
    refused = 0;
    onRefused: ((what: string) => void) | null = null;
    rect(x: number, y: number, w: number, h: number, c: Color, strokeWidth = 0, stroke?: Color): void {
        if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h)) || w < 0.5 || h < 0.5) { this.refuse(`rect ${x},${y},${w},${h}`); return; }
        super.rect(x, y, w, h, c, strokeWidth, stroke);
    }
    text(s: string, x: number, y: number, size: number, c: Color, font?: string, w = 0, h = 0, bg?: Color): void {
        if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(size)) || size <= 0) { this.refuse(`text "${s}" ${x},${y}`); return; }
        super.text(s, x, y, size, c, font, w, h, bg);
    }
    private refuse(what: string): void {
        if (this.refused++ === 0) this.onRefused?.(what);
    }
}

export function safeEnginePainter(api: DrawApi): SafePainter {
    return new SafePainter({
        clear: () => api.clear(),
        rect: o => api.drawRect({ position: [o.x, o.y], size: [o.w, o.h], color: o.c, strokeThickness: o.sw, strokeColor: o.sc }),
        text: o => api.drawText({ text: o.s, position: [o.x, o.y], dimensions: [o.w, o.h], fontSize: o.size, color: o.c, fontFamily: o.f, backgroundFill: o.bg }),
    });
}

// --- Projection ---------------------------------------------------------------------------------

export interface Cam { pos: V3; target: V3; fov: number; w: number; h: number }

/** Screen position of a world point (null behind the camera); z is the distance along the view. */
export function project(cam: Cam, p: V3): { x: number; y: number; z: number } | null {
    const f = norm(sub(cam.target, cam.pos));
    let r = cross(f, [0, 1, 0]);
    if (Math.hypot(...r) < 1e-6) r = [1, 0, 0];
    r = norm(r);
    const u = cross(r, f);
    const d = sub(p, cam.pos);
    const z = dot(d, f);
    if (z < 0.1) return null;
    const t = Math.tan((cam.fov * Math.PI) / 360);
    const aspect = cam.w / cam.h;
    const x = dot(d, r) / (z * t * aspect), y = dot(d, u) / (z * t);
    return { x: (x * 0.5 + 0.5) * cam.w, y: (0.5 - y * 0.5) * cam.h, z };
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// --- Pieces ------------------------------------------------------------------------------------

/** A thin line between two points (axis-aligned or stepped: the painter draws rectangles). */
function line(p: Painter, x0: number, y0: number, x1: number, y1: number, c: Color, w = 1.5): void {
    if (Math.abs(x1 - x0) < 0.5 || Math.abs(y1 - y0) < 0.5) {
        p.rect(Math.min(x0, x1) - (Math.abs(x1 - x0) < 0.5 ? w / 2 : 0), Math.min(y0, y1) - (Math.abs(y1 - y0) < 0.5 ? w / 2 : 0), Math.max(w, Math.abs(x1 - x0)), Math.max(w, Math.abs(y1 - y0)), c);
        return;
    }
    const n = Math.min(24, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4));
    for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        p.rect(x0 + (x1 - x0) * t - w / 2, y0 + (y1 - y0) * t - w / 2, w + 1, w + 1, c);
    }
}

/** Four corner brackets round a box. */
function brackets(p: Painter, x: number, y: number, w: number, h: number, c: Color, len = 10, t = 1.5): void {
    const l = Math.min(len, w / 3, h / 3);
    p.rect(x, y, l, t, c); p.rect(x, y, t, l, c);
    p.rect(x + w - l, y, l, t, c); p.rect(x + w - t, y, t, l, c);
    p.rect(x, y + h - t, l, t, c); p.rect(x, y + h - l, t, l, c);
    p.rect(x + w - l, y + h - t, l, t, c); p.rect(x + w - t, y + h - l, t, l, c);
}

/** A segmented bar (cells), filled to `v` (0..1). */
function cells(p: Painter, x: number, y: number, w: number, h: number, n: number, v: number, on: Color, off: Color = C.cyanFaint): void {
    const gap = 2, cw = (w - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
        const k = Math.max(0, Math.min(1, v * n - i));
        p.rect(x + i * (cw + gap), y, cw, h, off);
        if (k > 0) p.rect(x + i * (cw + gap), y, cw * k, h, on);
    }
}

function textC(p: Painter, s: string, cx: number, y: number, size: number, c: Color, font = F.ui): void {
    p.text(s, cx - tw(s, size, font) / 2, y, size, c, font);
}
function textR(p: Painter, s: string, rx: number, y: number, size: number, c: Color, font = F.ui): void {
    p.text(s, rx - tw(s, size, font), y, size, c, font);
}

/** A small diamond marker. */
function diamond(p: Painter, x: number, y: number, r: number, c: Color): void {
    for (let i = -r; i <= r; i += 1.5) {
        const w = (r - Math.abs(i)) * 2;
        if (w > 0.5) p.rect(x - w / 2, y + i, w, 1.6, c);
    }
}

/** A holographic button: a glass panel in brackets, brighter under the pointer. */
export function arButton(p: Painter, id: string, x: number, y: number, w: number, h: number, label: string, primary = false): void {
    const hot = p.hover === id;
    p.rect(x, y, w, h, hot ? [0.1, 0.32, 0.38, 0.6] : primary ? [0.04, 0.16, 0.2, 0.62] : C.glass);
    brackets(p, x, y, w, h, hot || primary ? C.cyan : C.cyanDim, 9);
    const size = Math.min(16, h * 0.42);
    p.text(label, x + (w - tw(label, size)) / 2, y + (h - size * 1.3) / 2, size, hot ? C.white : primary ? C.white : C.cyan, F.ui);
    p.hotspot(id, x, y, w, h);
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// --- The view the HUD draws (the addon fills it each frame) --------------------------------------

export interface HudMarker { kind: "hostile" | "squad" | "pickup" | "aircraft" | "objective" | "leader"; pos: V3; label: string; dist: number; visible: boolean; hp?: number; assist?: boolean; hurt?: boolean }

export interface HudView {
    w: number; h: number;
    time: number;
    cam: Cam;
    heading: number;
    objective: { title: string; text: string; dist: number | null; bearing: number | null; age: number } | null;
    squad: { name: string; hp: number; alive: boolean; hurt: boolean }[];
    health: number; maxHealth: number;
    armor: number; armorMax: number;
    stamina: number;
    depth: number;
    weapon: { name: string; kind: "gun" | "melee"; mag: number; magMax: number; reserve: number; reloading: number; slot: number; slots: string[] };
    crosshair: { spread: number; assist: boolean; hit: number; kill: boolean; ads: number };
    markers: HudMarker[];
    radio: { speaker: string; text: string; channel: string; age: number }[];
    hurtDirs: { yaw: number; age: number }[];
    prompt: string | null;
    toasts: { text: string; age: number }[];
    scanAge: number;
    bootAge: number;
    hostiles: number;
    medgel: number;
    critical: boolean;
    dead: number | null;
    phaseTitle: string | null;
    triangles: number | null;
}

// --- The AR HUD ----------------------------------------------------------------------------------

export function drawHud(p: Painter, v: HudView): void {
    const { w, h } = v;
    const boot = Math.min(1, v.bootAge / 3.5);
    // Corner brackets framing the augment's view.
    brackets(p, 22, 22, w - 44, h - 44, alpha(C.cyanDim, 0.6 * boot), 34, 1.5);

    drawCompass(p, v, boot);
    drawObjective(p, v, boot);
    drawSquad(p, v, boot);
    drawVitals(p, v, boot);
    drawWeapon(p, v, boot);
    drawMarkers(p, v);
    drawCrosshair(p, v);
    drawRadio(p, v, false);
    drawHurt(p, v);
    if (v.prompt) {
        const s = v.prompt;
        const size = 17, bw = tw(s, size) + 36;
        p.rect(w / 2 - bw / 2, h * 0.64, bw, 34, C.glass);
        brackets(p, w / 2 - bw / 2, h * 0.64, bw, 34, C.cyan, 8);
        textC(p, s, w / 2, h * 0.64 + 6, size, C.white);
    }
    v.toasts.slice(-4).forEach((t, i) => {
        const a = Math.max(0, Math.min(1, (4 - t.age) / 0.6));
        const size = 15, bw = tw(t.text, size) + 26;
        p.rect(w - 40 - bw, h * 0.34 + i * 34, bw, 28, alpha(C.glass, a));
        p.rect(w - 40 - bw, h * 0.34 + i * 34, 3, 28, alpha(C.cyan, a));
        p.text(t.text, w - 40 - bw + 14, h * 0.34 + i * 34 + 5, size, alpha(C.white, a), F.ui);
    });
    if (v.scanAge < 1.6) {
        // The scan pulse: a ring sweeping out from the center.
        const r = v.scanAge * Math.hypot(w, h) * 0.45;
        const a = 1 - v.scanAge / 1.6;
        for (let i = 0; i < 48; i++) {
            const t = (i / 48) * Math.PI * 2;
            p.rect(w / 2 + Math.cos(t) * r - 3, h / 2 + Math.sin(t) * r * 0.8 - 1, 6, 2, alpha(C.cyan, a * 0.8));
        }
        textC(p, "SCAN", w / 2, h / 2 - r * 0.8 - 26, 13, alpha(C.cyan, a), F.head);
    }
    if (v.bootAge < 6) drawBoot(p, v);
    if (v.critical) {
        const pulse = 0.55 + 0.45 * Math.sin(v.time * 6);
        for (let i = 0; i < 6; i++) {
            const k = (6 - i) / 6 * 0.12 * pulse;
            const e = i * 26;
            p.rect(0, e, w, 26, [0.6, 0.02, 0.02, k]); p.rect(0, h - e - 26, w, 26, [0.6, 0.02, 0.02, k]);
            p.rect(e, 0, 26, h, [0.6, 0.02, 0.02, k]); p.rect(w - e - 26, 0, 26, h, [0.6, 0.02, 0.02, k]);
        }
        textC(p, "VITALS CRITICAL", w / 2, h * 0.22, 22, alpha(C.red, pulse), F.head);
    } else if (v.health / v.maxHealth < 0.3) {
        const k = (0.3 - v.health / v.maxHealth) / 0.3 * 0.25;
        for (let i = 0; i < 4; i++) {
            const e = i * 22;
            p.rect(0, e, w, 22, [0.5, 0.02, 0.02, k * (4 - i) / 4]); p.rect(0, h - e - 22, w, 22, [0.5, 0.02, 0.02, k * (4 - i) / 4]);
        }
    }
    if (v.triangles !== null) p.text(`${(v.triangles / 1000).toFixed(0)}k tris`, w - 140, h - 40, 11, C.cyanDim, F.ui);
}

function drawCompass(p: Painter, v: HudView, boot: number): void {
    const cx = v.w / 2, y = 30, half = 280;
    const span = Math.PI / 3; // half of what the ribbon shows
    p.rect(cx - half, y + 16, half * 2, 1, alpha(C.cyanDim, boot));
    // Heading: 0 faces +Z (north); bearings clockwise toward east (+X).
    const deg = ((v.heading * 180) / Math.PI + 360) % 360;
    for (let d = Math.ceil((deg - 60) / 5) * 5; d <= deg + 60; d += 5) {
        const off = ((d - deg) / 180) * Math.PI;
        const x = cx + (off / span) * half;
        const dd = ((d % 360) + 360) % 360;
        const major = dd % 45 === 0, mid = dd % 15 === 0;
        const a = (1 - Math.abs(off) / span) * boot;
        p.rect(x - 0.75, y + 16 - (major ? 12 : mid ? 8 : 4), 1.5, major ? 12 : mid ? 8 : 4, alpha(C.cyan, a));
        if (major) {
            const name = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][dd / 45];
            textC(p, name, x, y - 12, name.length > 1 ? 11 : 14, alpha(dd === 0 ? C.amber : C.cyan, a), F.head);
        } else if (dd % 30 === 0) textC(p, String(dd), x, y - 9, 9, alpha(C.cyanDim, a), F.ui);
    }
    // Center notch and heading readout.
    p.rect(cx - 1, y + 18, 2, 8, alpha(C.white, boot));
    textC(p, String(Math.round(deg)).padStart(3, "0"), cx, y + 26, 11, alpha(C.white, boot), F.ui);
    // The objective's bearing on the ribbon (pinned to the edge when out of range).
    if (v.objective?.bearing !== null && v.objective?.bearing !== undefined) {
        let off = v.objective.bearing - v.heading;
        off = Math.atan2(Math.sin(off), Math.cos(off));
        const clamped = Math.max(-span, Math.min(span, -off));
        const x = cx + (clamped / span) * half;
        diamond(p, x, y + 8, 6, alpha(C.amber, boot));
        if (v.objective.dist !== null) textC(p, `${Math.round(v.objective.dist)} m`, x, y + 40, 11, alpha(C.amber, boot), F.ui);
    }
}

function drawObjective(p: Painter, v: HudView, boot: number): void {
    const o = v.objective;
    const x = 44, y = 72;
    if (o) {
        const fresh = o.age < 2.5;
        const flash = fresh ? 0.5 + 0.5 * Math.sin(o.age * 12) : 1;
        p.rect(x, y, 3, 46, alpha(C.amber, boot));
        p.text(o.title, x + 12, y - 1, 12, alpha(C.amberDim, boot), F.head);
        p.text(o.text.toUpperCase(), x + 12, y + 15, 17, alpha(fresh ? C.amber : C.white, boot * flash), F.ui);
        if (o.dist !== null) p.text(`${Math.round(o.dist)} M`, x + 12, y + 38, 11, alpha(C.cyanDim, boot), F.ui);
        if (fresh) p.text("NEW OBJECTIVE", x + 12, y - 18, 10, alpha(C.amber, boot * flash), F.ui);
    }
    if (v.hostiles > 0) {
        p.text(`HOSTILES  ${v.hostiles}`, x + 12, y + 58, 12, alpha(C.red, boot), F.ui);
    }
}

function drawSquad(p: Painter, v: HudView, boot: number): void {
    if (!v.squad.length) return;
    const x = 44, y0 = 170;
    p.text("KILO-TWO", x, y0 - 20, 11, alpha(C.cyanDim, boot), F.head);
    v.squad.forEach((m, i) => {
        const y = y0 + i * 22;
        const c = !m.alive ? C.redDim : m.hurt ? C.amber : C.cyan;
        p.text(m.name.toUpperCase(), x, y, 11, alpha(m.alive ? C.white : C.grey, boot), F.ui);
        if (m.alive) {
            p.rect(x + 118, y + 6, 70, 3, alpha(C.cyanFaint, boot));
            p.rect(x + 118, y + 6, 70 * Math.max(0, Math.min(1, m.hp)), 3, alpha(c, boot));
        } else {
            p.rect(x + 118, y + 7, 70, 1, alpha(C.redDim, boot));
            p.text("KIA", x + 194, y, 10, alpha(C.red, boot), F.ui);
        }
    });
}

function drawVitals(p: Painter, v: HudView, boot: number): void {
    const x = 44, y = v.h - 128;
    p.text("VITALS", x, y - 2, 11, alpha(C.cyanDim, boot), F.head);
    const hv = v.health / v.maxHealth;
    const hc = hv < 0.3 ? C.red : hv < 0.6 ? C.amber : C.cyan;
    cells(p, x, y + 16, 260, 12, 20, hv * boot, hc);
    p.text(String(Math.round(v.health)), x + 270, y + 10, 18, alpha(hc, boot), F.ui);
    if (v.armorMax > 0) {
        p.text("PLATES", x, y + 34, 10, alpha(C.cyanDim, boot), F.ui);
        cells(p, x + 52, y + 38, 208, 6, 10, (v.armor / v.armorMax) * boot, C.white, [1, 1, 1, 0.12]);
    }
    p.text("AUGMENT", x, y + 50, 10, alpha(C.cyanDim, boot), F.ui);
    p.rect(x + 58, y + 56, 202, 2, alpha(C.cyanFaint, boot));
    p.rect(x + 58, y + 56, 202 * v.stamina, 2, alpha(C.cyan, boot));
    // Depth below the rim, and the link to SAGE.
    p.text(`DEPTH  ${Math.round(v.depth)} M`, x, y + 66, 13, alpha(C.white, boot), F.ui);
    p.rect(x + 150, y + 73, 6, 6, alpha(C.green, boot * (0.6 + 0.4 * Math.sin(v.time * 3))));
    p.text("SAGE LINK", x + 162, y + 67, 11, alpha(C.cyanDim, boot), F.ui);
    if (v.medgel > 0) p.text(`MEDGEL x${v.medgel}  [H]`, x + 270, y + 46, 11, alpha(C.cyanDim, boot), F.ui);
}

function drawWeapon(p: Painter, v: HudView, boot: number): void {
    const wp = v.weapon;
    const rx = v.w - 44, y = v.h - 128;
    textR(p, wp.name.toUpperCase(), rx, y - 2, 13, alpha(C.cyanDim, boot), F.head);
    if (wp.kind === "gun") {
        const low = wp.mag <= wp.magMax * 0.25;
        textR(p, String(wp.mag).padStart(2, "0"), rx - 76, y + 12, 44, alpha(low ? C.amber : C.white, boot), F.ui);
        textR(p, `/ ${wp.reserve}`, rx, y + 30, 18, alpha(C.cyanDim, boot), F.ui);
        cells(p, rx - 220, y + 66, 220, 4, Math.min(32, wp.magMax), (wp.mag / wp.magMax) * boot, low ? C.amber : C.cyan);
        if (wp.reloading > 0) textR(p, "RELOADING", rx, y + 76, 12, alpha(C.amber, boot * (0.5 + 0.5 * Math.sin(v.time * 10))), F.ui);
    } else {
        textR(p, "EDGE", rx - 30, y + 16, 34, alpha(C.white, boot), F.ui);
        p.rect(rx - 20, y + 30, 10, 10, alpha(C.cyan, boot));
    }
    // The slots.
    let x = rx;
    for (let i = wp.slots.length - 1; i >= 0; i--) {
        const s = `${i + 1} ${wp.slots[i]}`;
        const cw = tw(s, 10) + 14;
        x -= cw;
        const on = i === wp.slot;
        if (on) p.rect(x - 4, y + 90, cw - 6, 16, alpha(C.cyanFaint, boot * 2));
        p.text(s, x, y + 91, 10, alpha(on ? C.white : C.cyanDim, boot), F.ui);
    }
}

function drawCrosshair(p: Painter, v: HudView): void {
    const cx = v.w / 2, cy = v.h / 2;
    const ch = v.crosshair;
    const c = ch.assist ? C.gold : alpha(C.white, 0.85);
    const gap = 6 + ch.spread * 900 * (1 - ch.ads * 0.6);
    const len = 8 - ch.ads * 3;
    p.rect(cx - 1, cy - gap - len, 2, len, c);
    p.rect(cx - 1, cy + gap, 2, len, c);
    p.rect(cx - gap - len, cy - 1, len, 2, c);
    p.rect(cx + gap, cy - 1, len, 2, c);
    p.rect(cx - 1, cy - 1, 2, 2, alpha(c, 0.8));
    if (ch.hit > 0) {
        const hc = ch.kill ? C.red : C.white;
        const a = Math.min(1, ch.hit / 0.12);
        for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) line(p, cx + dx * 7, cy + dy * 7, cx + dx * 14, cy + dy * 14, alpha(hc, a), 2);
    }
}

function drawMarkers(p: Painter, v: HudView): void {
    for (const m of v.markers) {
        const s = project(v.cam, m.pos);
        if (!s) continue;
        if (s.x < -40 || s.x > v.w + 40 || s.y < -40 || s.y > v.h + 40) continue;
        if (m.kind === "hostile" || m.kind === "leader") {
            const top = project(v.cam, [m.pos[0], m.pos[1] + 1.9, m.pos[2]]);
            const hgt = top ? Math.max(14, s.y - top.y) : 20;
            const wdt = hgt * 0.5;
            const c = m.kind === "leader" ? C.violet : m.visible ? (m.assist ? C.gold : C.red) : C.redDim;
            brackets(p, s.x - wdt / 2 - 4, s.y - hgt - 4, wdt + 8, hgt + 8, c, 7, m.visible ? 1.5 : 1);
            if (m.visible || m.kind === "leader") {
                p.text(`${m.label}  ${Math.round(m.dist)}M`, s.x + wdt / 2 + 8, s.y - hgt - 4, 10, c, F.ui);
                if (m.hp !== undefined && m.hp < 1) { p.rect(s.x - wdt / 2, s.y + 6, wdt, 2, C.redDim); p.rect(s.x - wdt / 2, s.y + 6, wdt * m.hp, 2, c); }
            }
        } else if (m.kind === "squad") {
            const top = project(v.cam, [m.pos[0], m.pos[1] + 2.15, m.pos[2]]);
            if (!top || m.dist > 70) continue;
            const c = m.hurt ? C.amber : C.green;
            diamond(p, top.x, top.y, 4, c);
            textC(p, m.label, top.x, top.y - 18, 10, alpha(c, 0.9), F.ui);
        } else if (m.kind === "pickup") {
            diamond(p, s.x, s.y - 14, 5, C.cyan);
            textC(p, m.label, s.x, s.y - 36, 11, C.cyan, F.ui);
            textC(p, `${Math.round(m.dist)} m`, s.x, s.y - 4, 9, C.cyanDim, F.ui);
        } else if (m.kind === "aircraft") {
            if (m.dist > 1600) continue;
            p.rect(s.x - 5, s.y - 1, 10, 2, alpha(C.cyanDim, 0.8));
            p.text(m.label.toUpperCase(), s.x + 8, s.y - 6, 9, C.cyanDim, F.ui);
        } else if (m.kind === "objective") {
            diamond(p, s.x, s.y, 7, C.amber);
            textC(p, `${Math.round(m.dist)} m`, s.x, s.y + 12, 11, C.amber, F.ui);
        }
    }
}

const CHANNEL_COLOR: Record<string, Color> = { radio: C.cyan, sage: C.amber, voice: C.white, translation: C.violet, caption: C.grey };

/** Subtitles: the radio and SAGE in play, spoken lines and the translator in cutscenes. */
export function drawRadio(p: Painter, v: Pick<HudView, "w" | "h" | "radio" | "time">, cinema: boolean): void {
    const lines = v.radio.slice(-2);
    lines.forEach((l, i) => {
        const y = cinema ? v.h - v.h * 0.11 + 14 + i * 30 - (lines.length - 1) * 30 : v.h - 210 + i * 36 - (lines.length - 1) * 36;
        const c = CHANNEL_COLOR[l.channel] ?? C.white;
        const tag = l.channel === "sage" ? "SAGE" : l.channel === "translation" ? "TRANSLATOR" : l.speaker.toUpperCase();
        const text = l.text;
        const size = cinema ? 19 : 17;
        const fade = Math.min(1, l.age / 0.25);
        const total = (tag ? tw(tag, 12, F.head) + 16 : 0) + tw(text, size, F.body);
        const x = v.w / 2 - total / 2;
        if (!cinema) p.rect(x - 14, y - 4, total + 28, size + 14, alpha(C.glassDark, fade));
        if (tag && l.channel !== "caption") {
            p.text(tag, x, y + (size - 12) / 2 + 1, 12, alpha(c, fade), F.head);
            if (l.channel === "radio") for (let k = 0; k < 3; k++) p.rect(x - 9 + k * 2.5, y + 4 + (k % 2) * 2, 1.5, size - 4 - (k % 2) * 4, alpha(c, fade * 0.7));
        }
        p.text(text, x + (tag && l.channel !== "caption" ? tw(tag, 12, F.head) + 16 : 0), y, size, alpha(l.channel === "translation" ? C.violet : l.channel === "caption" ? C.grey : C.white, fade), F.body);
    });
}

function drawHurt(p: Painter, v: HudView): void {
    const cx = v.w / 2, cy = v.h / 2;
    for (const d of v.hurtDirs) {
        const a = Math.max(0, 1 - d.age / 1.6);
        // Damage from behind shows at the bottom; screen angle from the yaw relative to view.
        const ang = -d.yaw - Math.PI / 2;
        for (let k = -3; k <= 3; k++) {
            const t = ang + k * 0.06;
            const r = 190 - Math.abs(k) * 3;
            p.rect(cx + Math.cos(t) * r - 4, cy + Math.sin(t) * r * 0.8 - 4, 8, 8, [1, 0.2, 0.15, a * (1 - Math.abs(k) / 4)]);
        }
    }
}

const BOOT = [
    "AEGIS AUGMENT v7.2 ... OK",
    "OPTIC OVERLAY ......... OK",
    "SAGE TACTICAL LINK .... ESTABLISHED",
    "SQUAD TELEMETRY ....... 8 SIGNALS",
    "DEPTH REFERENCE ....... RIM +0 M",
    "WELCOME, LIEUTENANT.",
];

function drawBoot(p: Painter, v: HudView): void {
    const n = Math.min(BOOT.length, Math.floor(v.bootAge / 0.55) + 1);
    const a = Math.min(1, (6 - v.bootAge) / 0.8);
    for (let i = 0; i < n; i++) p.text(BOOT[i], 44, v.h * 0.5 + i * 22, 15, alpha(i === BOOT.length - 1 ? C.amber : C.cyan, a), F.ui);
}

// --- Cutscenes ----------------------------------------------------------------------------------

export interface CinemaView {
    w: number; h: number; time: number;
    letterbox: boolean;
    cards: { lines: string[]; style: "title" | "chapter" | "caption" | "lore"; alpha: number; age: number }[];
    radio: { speaker: string; text: string; channel: string; age: number }[];
    skip: number;
    black: boolean;
}

export function drawCinema(p: Painter, v: CinemaView): void {
    const { w, h } = v;
    if (v.black) p.rect(0, 0, w, h, C.black);
    if (v.letterbox) {
        const bar = h * 0.11;
        p.rect(0, 0, w, bar, C.black);
        p.rect(0, h - bar, w, bar, C.black);
    }
    for (const c of v.cards) {
        const a = c.alpha;
        if (c.style === "title") {
            const s = c.lines[0];
            const size = 104;
            const spread = 1 + Math.min(1, c.age / 5) * 0.06;
            textC(p, s.split("").join(" ".repeat(Math.round(spread))), w / 2, h * 0.38, size, alpha(C.white, a), F.head);
            p.rect(w / 2 - 240 * spread, h * 0.38 + size * 1.25, 480 * spread, 1.5, alpha(C.cyan, a * 0.8));
        } else if (c.style === "chapter") {
            textC(p, c.lines[0], w / 2, h * 0.42, 20, alpha(C.cyan, a), F.head);
            textC(p, c.lines[1] ?? "", w / 2, h * 0.42 + 34, 54, alpha(C.white, a), F.head);
        } else if (c.style === "lore") {
            c.lines.forEach((l, i) => textC(p, l, w / 2, h * 0.42 + (i - (c.lines.length - 1) / 2) * 40, 26, alpha([0.88, 0.86, 0.8, 1], a), F.lore));
        } else {
            c.lines.forEach((l, i) => textC(p, l, w / 2, h * 0.72 + i * 34, 23, alpha([0.92, 0.9, 0.86, 1], a), F.lore));
        }
    }
    drawRadio(p, { w, h, radio: v.radio, time: v.time }, true);
    if (v.skip > 0) {
        const s = "HOLD  SPACE  TO SKIP";
        textR(p, s, w - 40, h - 40, 12, C.grey, F.ui);
        p.rect(w - 40 - tw(s, 12), h - 22, tw(s, 12), 2, alpha(C.grey, 0.3));
        p.rect(w - 40 - tw(s, 12), h - 22, tw(s, 12) * Math.min(1, v.skip), 2, C.white);
    }
}

// --- Screens --------------------------------------------------------------------------------------

export function drawLoading(p: Painter, w: number, h: number, stage: string, progress: number, time: number): void {
    p.rect(0, 0, w, h, [0.01, 0.012, 0.016, 1]);
    textC(p, "T H E   A B Y S S", w / 2, h * 0.36, 64, C.white, F.head);
    textC(p, "CHAPTER ONE  -  FIRST BLOOD", w / 2, h * 0.36 + 86, 16, C.cyanDim, F.head);
    const bw = 420;
    p.rect(w / 2 - bw / 2, h * 0.62, bw, 2, C.cyanFaint);
    p.rect(w / 2 - bw / 2, h * 0.62, bw * progress, 2, C.cyan);
    textC(p, `${stage.toUpperCase()}${".".repeat(1 + Math.floor(time * 2) % 3)}`, w / 2, h * 0.62 + 14, 12, C.cyanDim, F.ui);
    textC(p, "\"The Deep Bore went down hundreds of miles. Something was waiting at the bottom.\"", w / 2, h * 0.82, 16, [0.7, 0.7, 0.68, 1], F.lore);
}

export interface TitleView { w: number; h: number; time: number; hasCheckpoint: boolean; checkpointLabel: string; aimAssist: number; sensitivity: number; chapterMenu: boolean }

export function drawTitle(p: Painter, v: TitleView): void {
    const { w, h } = v;
    // A dark band over the moving crack behind.
    p.rect(0, 0, w, h, [0, 0, 0, 0.25]);
    p.rect(0, h * 0.18, w, h * 0.3, [0, 0, 0, 0.35]);
    textC(p, "T H E   A B Y S S", w / 2, h * 0.22, 92, C.white, F.head);
    p.rect(w / 2 - 330, h * 0.22 + 118, 660, 1.5, C.cyanDim);
    textC(p, "CHAPTER ONE  -  FIRST BLOOD", w / 2, h * 0.22 + 132, 18, C.cyan, F.head);
    const bx = w / 2 - 170, bw = 340;
    let y = h * 0.56;
    const btn = (id: string, label: string, primary = false) => { arButton(p, id, bx, y, bw, 44, label, primary); y += 54; };
    if (!v.chapterMenu) {
        btn("begin", "BEGIN CHAPTER ONE", true);
        if (v.hasCheckpoint) btn("continue", `CONTINUE - ${v.checkpointLabel}`);
        btn("chapters", "SELECT A MOMENT");
        p.text(`AIM ASSIST ${Math.round(v.aimAssist * 100)}%`, bx, y + 6, 13, C.cyanDim, F.ui);
        arButton(p, "assist-down", bx + 200, y, 60, 30, "-"); arButton(p, "assist-up", bx + 270, y, 60, 30, "+");
        y += 40;
        p.text(`LOOK SPEED ${v.sensitivity.toFixed(1)}`, bx, y + 6, 13, C.cyanDim, F.ui);
        arButton(p, "look-down", bx + 200, y, 60, 30, "-"); arButton(p, "look-up", bx + 270, y, 60, 30, "+");
    } else {
        const moments: [string, string][] = [["ledge", "LEDGE KILO"], ["descent", "THE ROCKSLIDE"], ["floor", "THE FLOOR"], ["ambush", "FIRST BLOOD"], ["fallback", "FALL BACK"], ["evac", "EXTRACTION"], ["laststand", "NO EVAC"], ["ending", "THE ENDING"]];
        y = h * 0.5;
        for (const [id, label] of moments) { arButton(p, `moment-${id}`, bx, y, bw, 34, label); y += 40; }
        arButton(p, "back", bx, y + 8, bw, 34, "BACK", true);
    }
    textC(p, "WASD move  -  right-drag / arrows look  -  left click fire  -  Z aim  -  R reload  -  F/3 blade  -  E interact  -  H medgel  -  Q scan  -  TAB inventory", w / 2, h - 44, 12, [0.7, 0.75, 0.78, 0.9], F.ui);
}

export function drawDead(p: Painter, w: number, h: number, t: number): void {
    const a = Math.min(1, t / 0.6);
    p.rect(0, 0, w, h, [0.05, 0, 0, 0.55 * a]);
    // Static: broken bands across the view.
    for (let i = 0; i < 14; i++) {
        const y = ((Math.sin(i * 91.7 + t * 37) * 0.5 + 0.5) * h) | 0;
        p.rect(0, y, w, 2 + (i % 3), [1, 1, 1, 0.05 * a]);
    }
    textC(p, "SIGNAL LOST", w / 2, h * 0.42, 54, alpha(C.red, a), F.head);
    textC(p, "AUGMENT RESTARTING", w / 2, h * 0.42 + 72, 14, alpha(C.cyanDim, a), F.ui);
    p.rect(w / 2 - 150, h * 0.42 + 96, 300, 2, C.cyanFaint);
    p.rect(w / 2 - 150, h * 0.42 + 96, 300 * Math.min(1, t / 3.5), 2, C.cyan);
}

export interface InventoryView {
    w: number; h: number;
    weapons: { name: string; description: string; current: boolean }[];
    armor: string | null; armorValue: number; medgel: number;
    artifacts: { name: string; value: number; note: string }[];
    selected: number;
    total: number;
    objective: string | null;
}

export function drawInventory(p: Painter, v: InventoryView): void {
    const { w, h } = v;
    p.rect(0, 0, w, h, [0, 0.02, 0.03, 0.72]);
    textC(p, "AUGMENT  -  FIELD INVENTORY", w / 2, 50, 20, C.cyan, F.head);
    if (v.objective) textC(p, `OBJECTIVE: ${v.objective.toUpperCase()}`, w / 2, 84, 13, C.amber, F.ui);
    const col = (x: number, title: string) => { p.text(title, x, 130, 13, C.cyanDim, F.head); p.rect(x, 152, 420, 1, C.cyanFaint); };
    const x0 = w / 2 - 660, x1 = w / 2 - 210, x2 = w / 2 + 240;
    col(x0, "WEAPONS");
    v.weapons.forEach((wp, i) => {
        const y = 166 + i * 70;
        if (wp.current) p.rect(x0 - 8, y - 4, 416, 62, C.cyanFaint);
        p.text(`${i + 1}  ${wp.name.toUpperCase()}`, x0, y, 16, wp.current ? C.white : C.cyan, F.ui);
        p.text(wp.description, x0 + 22, y + 24, 12, C.grey, F.body, 390, 32);
    });
    col(x1, "KIT");
    p.text(v.armor ? v.armor.toUpperCase() : "NO PLATES", x1, 166, 16, v.armor ? C.white : C.grey, F.ui);
    if (v.armor) p.text(`${Math.round(v.armorValue)} / 100`, x1, 190, 12, C.cyanDim, F.ui);
    p.text(`MEDGEL  x${v.medgel}`, x1, 226, 16, C.white, F.ui);
    p.text("55 vitals. [H] to apply.", x1, 250, 12, C.grey, F.body);
    col(x2, "ARTIFACTS OF BELOW");
    if (!v.artifacts.length) p.text("Nothing yet. [Q] scans for what the eye misses.", x2, 166, 13, C.grey, F.body);
    v.artifacts.forEach((a, i) => {
        const y = 166 + i * 26;
        const on = i === v.selected;
        if (on) p.rect(x2 - 8, y - 3, 416, 24, C.cyanFaint);
        p.hotspot(`artifact-${i}`, x2 - 8, y - 3, 416, 24);
        p.text(a.name.toUpperCase(), x2, y, 14, on ? C.white : C.cyan, F.ui);
        textR(p, `${a.value} CR`, x2 + 400, y, 14, C.amber, F.ui);
    });
    if (v.artifacts.length) {
        textR(p, `ESTIMATED VALUE  ${v.total} CR`, x2 + 400, 176 + v.artifacts.length * 26, 13, C.amber, F.ui);
        const a = v.artifacts[Math.min(v.selected, v.artifacts.length - 1)];
        p.rect(x2 - 8, 220 + v.artifacts.length * 26, 416, 120, C.glass);
        p.text("SAGE", x2, 228 + v.artifacts.length * 26, 11, C.amber, F.head);
        p.text(a.note, x2, 248 + v.artifacts.length * 26, 13, C.white, F.body, 400, 90);
    }
    arButton(p, "resume", w / 2 - 230, h - 96, 140, 40, "RESUME", true);
    arButton(p, "to-title", w / 2 + 90, h - 96, 140, 40, "TITLE");
}

export interface CompleteView { w: number; h: number; time: number; seconds: number; kills: number; accuracy: number; artifacts: number; value: number; squadAlive: number; squadTotal: number }

export function drawComplete(p: Painter, v: CompleteView): void {
    const { w, h } = v;
    p.rect(0, 0, w, h, [0.01, 0.012, 0.016, 1]);
    textC(p, "CHAPTER ONE", w / 2, h * 0.16, 22, C.cyan, F.head);
    textC(p, "FIRST BLOOD", w / 2, h * 0.16 + 36, 64, C.white, F.head);
    textC(p, "COMPLETE", w / 2, h * 0.16 + 116, 18, C.amber, F.head);
    const rows: [string, string][] = [
        ["TIME IN THE ABYSS", fmtTime(v.seconds)],
        ["WARDENS FALLEN TO YOUR HAND", String(v.kills)],
        ["ACCURACY", `${Math.round(v.accuracy * 100)}%`],
        ["ARTIFACTS RECOVERED", `${v.artifacts}  (${v.value} CR)`],
        ["KILO-TWO STILL BREATHING", `${v.squadAlive + 1} of ${v.squadTotal + 1}`],
    ];
    rows.forEach(([k, val], i) => {
        const y = h * 0.42 + i * 40;
        p.text(k, w / 2 - 300, y, 16, C.cyanDim, F.ui);
        textR(p, val, w / 2 + 300, y, 18, C.white, F.ui);
        p.rect(w / 2 - 300, y + 28, 600, 1, C.cyanFaint);
    });
    textC(p, "NEXT:  CHAPTER TWO  -  RETALIATION", w / 2, h * 0.78, 16, C.amber, F.head);
    textC(p, "The surface answers with everything it has. The kingdoms below answer as one.", w / 2, h * 0.78 + 30, 15, [0.75, 0.75, 0.72, 1], F.lore);
    arButton(p, "replay", w / 2 - 230, h * 0.88, 200, 42, "PLAY AGAIN", true);
    arButton(p, "to-title", w / 2 + 30, h * 0.88, 200, 42, "TITLE");
}
