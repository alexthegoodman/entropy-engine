// Destruction: every building on the street map can be blown down - map houses, city blocks and
// the compounds' headquarters, barracks, depots, hangars, towers and wall segments alike.
//
// Small arms do nothing to a building; explosions do (al_fx.ts, the Cobra's solar missiles in
// al_cobra.ts). Each building has hit points from its size. When they run out it breaks apart:
// its model is dropped (CityHouses.setExcluded, or the compound's scatter item) and, in the same
// frame, a shell of wall panels and roof slabs in its exact shape takes its place. The panels give
// way from the blast outward, upper storeys come down under gravity, and the pieces tumble,
// bounce and settle as the rubble. The building leaves the street map (nav grid, bullets, the
// car's clearance), so a blown wall is a breach.
//
// Ruins are kept in the campaign by building key (Campaign.ruins) with the day they fell: the
// regime rebuilds a compound two days later, the city a house or block in a week. A ruin you come
// back to is a settled pile of the same pieces, deterministic in its key.
//
// Pieces live in the street's local frame (x east, y up, z north). They collide with the ground
// only; overlapping and half-buried chunks read as rubble.

import { type Rect } from "./al_nav";
import { makeRng, hashString, type Rng } from "./al_rng";

type RGB = [number, number, number];

/** City surfaces the pieces are textured with (qp_shader.ts SURFACE, via the chunk meshes). */
export type ChunkSurface = "brick" | "concrete" | "render" | "metal" | "stone";
export const CHUNK_SURFACES: ChunkSurface[] = ["brick", "concrete", "render", "metal", "stone"];

export interface Piece {
    /** The building it came from (all its pieces go when the ruin is rebuilt or left behind). */
    key: string;
    x: number; y: number; z: number;
    vx: number; vy: number; vz: number;
    /** Orientation (yaw about up, then pitch, then roll) and its rates. */
    yaw: number; pitch: number; roll: number;
    wy: number; wp: number; wr: number;
    /** Full size along its own axes (m). */
    w: number; h: number; d: number;
    surface: ChunkSurface;
    tint: RGB;
    /** Seconds it holds in place before giving way. */
    release: number;
    asleep: boolean;
    age: number;
    /** Small debris fades out (sinks) after this many seconds; rubble stays. */
    life?: number;
}

// --- Strength ------------------------------------------------------------------------------------

/** A compound's structures are rects keyed `al-mil-<compound>-<index>` (allegiance_addon.ts). */
export const isMilitary = (r: Rect): boolean => r.kind === "military";

/** Hit points: compound buildings by type, map buildings by their volume. */
export function buildingHp(r: Rect): number {
    const w = r.hw * 2, d = r.hd * 2;
    if (isMilitary(r)) {
        if (r.height < 3) return 160;                          // wall segment
        if (w <= 3.5 && d <= 3.5) return 260;                  // watchtower
        return r.height >= 6.8 && w * d >= 120 ? 1100 : 700;   // headquarters; barracks, depots, hangars
    }
    return Math.round(Math.max(220, Math.min(4500, 120 + w * d * r.height * 0.25)));
}

/** Horizontal distance from (x, z) to the rect's footprint (0 inside), and vertical gap above its roof. */
export function distanceToRect(r: Rect, x: number, y: number, z: number): number {
    const dx = x - r.cx, dz = z - r.cz;
    const u = Math.abs(dx * r.ux + dz * r.uz) - r.hw;
    const v = Math.abs(-dx * r.uz + dz * r.ux) - r.hd;
    const flat = Math.hypot(Math.max(0, u), Math.max(0, v));
    const above = Math.max(0, y - (r.base + r.height)), below = Math.max(0, r.base - y);
    return Math.hypot(flat, above + below);
}

export interface Blast { x: number; y: number; z: number; radius: number; damage: number }

/** Damage a blast does to a building: full on contact, falling off linearly to its radius. */
export function blastOnRect(b: Blast, r: Rect): number {
    const d = distanceToRect(r, b.x, b.y, b.z);
    if (d >= b.radius) return 0;
    return b.damage * (1 - d / b.radius);
}

/** The session's damage ledger: hit points lost per building key, until it falls. */
export class Damage {
    taken = new Map<string, number>();
    /**
     * Applies a blast to every rect near it. Returns the rects that fell, and the damaged ones
     * (with the share of their hit points gone) that still stand.
     */
    apply(b: Blast, rects: readonly Rect[]): { fell: Rect[]; hurt: { rect: Rect; share: number }[] } {
        const fell: Rect[] = [], hurt: { rect: Rect; share: number }[] = [];
        for (const r of rects) {
            if (r.key.startsWith("al-player-car") || r.key.startsWith("al-cobra")) continue;
            const reach = b.radius + r.hw + r.hd;
            if (Math.abs(r.cx - b.x) > reach || Math.abs(r.cz - b.z) > reach) continue;
            const dmg = blastOnRect(b, r);
            if (dmg <= 0) continue;
            const total = (this.taken.get(r.key) ?? 0) + dmg;
            const hp = buildingHp(r);
            if (total >= hp) { this.taken.delete(r.key); fell.push(r); }
            else { this.taken.set(r.key, total); hurt.push({ rect: r, share: total / hp }); }
        }
        return { fell, hurt };
    }
}

// --- Ruins ---------------------------------------------------------------------------------------

/** Days until the regime rebuilds a compound structure, and the city a house or block. */
export const REBUILD_DAYS = { military: 2, civil: 7 };

/** Drops ruins old enough to have been rebuilt (called at dawn). Returns how many were rebuilt. */
export function rebuildRuins(ruins: Record<string, number>, day: number): number {
    let n = 0;
    for (const [key, fell] of Object.entries(ruins)) {
        const days = key.startsWith("al-mil-") ? REBUILD_DAYS.military : REBUILD_DAYS.civil;
        if (day - fell >= days) { delete ruins[key]; n++; }
    }
    return n;
}

/** Most ruins remembered (oldest are forgotten first: rebuilt early). */
export const MAX_RUINS = 2000;
export function addRuin(ruins: Record<string, number>, key: string, day: number): void {
    ruins[key] = day;
    const keys = Object.keys(ruins);
    if (keys.length > MAX_RUINS) {
        keys.sort((a, b) => ruins[a] - ruins[b]);
        for (const k of keys.slice(0, keys.length - MAX_RUINS)) delete ruins[k];
    }
}

// --- Breaking apart ------------------------------------------------------------------------------

/** What a building's pieces look like: its surface and a tint (seeded from its key). */
export function buildingLook(r: Rect, colour?: RGB | null): { surface: ChunkSurface; tint: RGB } {
    const h = hashString(`look:${r.key}`);
    const k = (h % 1000) / 1000;
    if (isMilitary(r)) return r.height < 3 ? { surface: "stone", tint: [0.85, 0.83, 0.78] } : { surface: "concrete", tint: [0.78 + k * 0.1, 0.8 + k * 0.08, 0.72] };
    if (colour) return { surface: r.kind === "house" ? "render" : "concrete", tint: colour };
    if (r.kind === "house") return k < 0.55 ? { surface: "brick", tint: [0.95, 0.85 + k * 0.1, 0.8] } : { surface: "render", tint: [0.95, 0.92, 0.85 - k * 0.1] };
    if (r.height > 30) return k < 0.5 ? { surface: "concrete", tint: [0.82, 0.83, 0.85] } : { surface: "metal", tint: [0.6, 0.66, 0.72] };
    return k < 0.45 ? { surface: "brick", tint: [0.9, 0.8, 0.72] } : k < 0.8 ? { surface: "concrete", tint: [0.85, 0.83, 0.8] } : { surface: "render", tint: [0.95, 0.9, 0.8] };
}

/** Pieces per building, at most (a tower is broken into bigger panels than a cottage). */
export const PIECES_PER_BUILDING = 150;

/**
 * The building as a shell of pieces in its exact shape: wall panels round its four sides, storey
 * by storey, roof slabs, and a few blocks of its insides. Nothing moves yet.
 */
export function shellPieces(r: Rect, look: { surface: ChunkSurface; tint: RGB }, rng: Rng): Piece[] {
    const w = r.hw * 2, d = r.hd * 2, h = Math.max(1, r.height);
    const thick = isMilitary(r) && h < 3 ? 0.6 : Math.min(0.6, Math.max(0.3, Math.min(w, d) * 0.04));
    // Panel size: about PIECES_PER_BUILDING pieces over the walls and roof.
    const area = 2 * (w + d) * h + w * d * 0.5;
    const s = Math.max(1.4, Math.sqrt(area / (PIECES_PER_BUILDING * 0.8)));
    const out: Piece[] = [];
    const ux = r.ux, uz = r.uz, vx = -r.uz, vz = r.ux;
    const yaw0 = Math.atan2(-uz, ux);   // a piece's own x runs along the rect's u (pieceAxes: x = (cos, 0, -sin))
    const add = (u: number, y: number, v: number, pw: number, ph: number, pd: number, along: "u" | "v") => {
        const k = 0.86 + rng.next() * 0.12;
        out.push({
            key: r.key, x: r.cx + ux * u + vx * v, y, z: r.cz + uz * u + vz * v, vx: 0, vy: 0, vz: 0,
            yaw: along === "u" ? yaw0 : yaw0 - Math.PI / 2, pitch: 0, roll: 0, wy: 0, wp: 0, wr: 0,
            w: pw * k, h: ph * (0.9 + rng.next() * 0.1), d: pd, surface: look.surface,
            tint: [look.tint[0] * (0.9 + rng.next() * 0.1), look.tint[1] * (0.9 + rng.next() * 0.1), look.tint[2] * (0.9 + rng.next() * 0.1)],
            release: 0, asleep: true, age: 0,
        });
    };
    const rows = Math.max(1, Math.round(h / (s * 0.85)));
    const rh = h / rows;
    for (const [len, along, off] of [[w, "u", r.hd], [w, "u", -r.hd], [d, "v", r.hw], [d, "v", -r.hw]] as const) {
        const cols = Math.max(1, Math.round(len / s));
        const cw = len / cols;
        for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
            const a = -len / 2 + (i + 0.5) * cw, y = r.base + (j + 0.5) * rh;
            if (along === "u") add(a, y, off - Math.sign(off) * thick / 2, cw, rh, thick, "u");
            else add(off - Math.sign(off) * thick / 2, y, a, cw, rh, thick, "v");
        }
    }
    // The roof, in slabs.
    const ru = Math.max(1, Math.round(w / (s * 1.4))), rv = Math.max(1, Math.round(d / (s * 1.4)));
    if (w > 1.5 && d > 1.5) for (let i = 0; i < ru; i++) for (let j = 0; j < rv; j++)
        add(-r.hw + (i + 0.5) * w / ru, r.base + h - thick / 2, -r.hd + (j + 0.5) * d / rv, w / ru, thick, d / rv, "u");
    // Floors and fittings: some solid blocks inside, so the pile has some bulk.
    if (h > 3 && w > 4 && d > 4) {
        const n = Math.min(10, Math.round(h / 3));
        for (let i = 0; i < n; i++) {
            const bw = s * (0.5 + rng.next() * 0.5);
            add((rng.next() - 0.5) * (w - bw), r.base + (i + 0.5) * h / n, (rng.next() - 0.5) * (d - bw), bw, Math.min(rh, bw), bw, "u");
        }
    }
    return out;
}

/**
 * Sets the shell in motion from a blast at (bx, by, bz): pieces near it are thrown out at once,
 * the rest give way a little later the farther they are, and everything comes down under gravity.
 */
export function breakApart(pieces: Piece[], bx: number, by: number, bz: number, power: number, rng: Rng): void {
    for (const p of pieces) {
        const dx = p.x - bx, dy = p.y - by, dz = p.z - bz;
        const dist = Math.hypot(dx, dy, dz) || 1;
        const push = power * Math.exp(-dist / 9);
        p.release = dist / 22 + rng.next() * 0.35;
        p.vx = dx / dist * push + (rng.next() - 0.5) * 2.5;
        p.vz = dz / dist * push + (rng.next() - 0.5) * 2.5;
        p.vy = Math.max(0, dy / dist) * push * 0.6 + rng.next() * 2.5;
        p.wy = (rng.next() - 0.5) * 3; p.wp = (rng.next() - 0.5) * 4; p.wr = (rng.next() - 0.5) * 4;
        p.asleep = false;
    }
}

/** A settled pile of the building's pieces (a ruin you come back to): deterministic in its key. */
export function rubblePile(r: Rect, look: { surface: ChunkSurface; tint: RGB }, ground: (x: number, z: number) => number): Piece[] {
    const rng = makeRng(hashString(`rubble:${r.key}`));
    const pieces = shellPieces(r, look, rng);
    const w = r.hw * 2, d = r.hd * 2;
    // Fallen within the footprint (a little beyond for tall ones), heaped toward the middle.
    const spread = 1 + Math.min(0.5, r.height / 60);
    for (const p of pieces) {
        const a = rng.next() * Math.PI * 2, t = Math.sqrt(rng.next());
        const u = Math.cos(a) * t * r.hw * spread, v = Math.sin(a) * t * r.hd * spread;
        p.x = r.cx + r.ux * u - r.uz * v; p.z = r.cz + r.uz * u + r.ux * v;
        const heap = (1 - t) * Math.min(4, Math.max(0.6, r.height * w * d / 1500));
        p.y = ground(p.x, p.z) + Math.min(p.w, p.h, p.d) * 0.4 + heap * rng.next();
        p.yaw = rng.next() * Math.PI * 2; p.pitch = (rng.next() - 0.5) * 1.6 + (rng.next() < 0.6 ? Math.PI / 2 : 0); p.roll = (rng.next() - 0.5) * 0.8;
        p.asleep = true; p.release = 0;
    }
    return pieces;
}

/** Small debris thrown by an explosion (fades after a few seconds). */
export function debris(x: number, y: number, z: number, count: number, rng: Rng, surface: ChunkSurface = "concrete", tint: RGB = [0.55, 0.53, 0.5]): Piece[] {
    const out: Piece[] = [];
    for (let i = 0; i < count; i++) {
        const a = rng.next() * Math.PI * 2, up = 4 + rng.next() * 9, out2 = 3 + rng.next() * 9;
        const s = 0.12 + rng.next() * 0.35;
        out.push({ key: "debris", x, y: y + 0.3, z, vx: Math.cos(a) * out2, vy: up, vz: Math.sin(a) * out2,
            yaw: rng.next() * 6.28, pitch: rng.next() * 6.28, roll: 0, wy: (rng.next() - 0.5) * 12, wp: (rng.next() - 0.5) * 12, wr: (rng.next() - 0.5) * 12,
            w: s * (0.6 + rng.next()), h: s, d: s * (0.6 + rng.next()), surface, tint, release: 0, asleep: false, age: 0, life: 4 + rng.next() * 3 });
    }
    return out;
}

// --- Motion --------------------------------------------------------------------------------------

export const GRAVITY = 9.8;

/** Steps every piece: held ones wait, falling ones tumble, landed ones bounce, slide and sleep. */
export function stepPieces(pieces: Piece[], dt: number, ground: (x: number, z: number) => number): Piece[] {
    const h = Math.min(dt, 0.05);
    for (const p of pieces) {
        p.age += dt;
        if (p.asleep || p.age < p.release) continue;
        p.vy -= GRAVITY * h;
        p.x += p.vx * h; p.y += p.vy * h; p.z += p.vz * h;
        p.yaw += p.wy * h; p.pitch += p.wp * h; p.roll += p.wr * h;
        // Resting on its thinnest side (roughly): half its smallest size above the ground.
        const g = ground(p.x, p.z) + Math.min(p.w, p.h, p.d) * 0.45;
        if (p.y < g) {
            p.y = g;
            if (p.vy < 0) p.vy = -p.vy * 0.22;
            p.vx *= 0.55; p.vz *= 0.55; p.wy *= 0.5; p.wp *= 0.5; p.wr *= 0.5;
            if (Math.hypot(p.vx, p.vy, p.vz) < 0.5) { p.asleep = true; p.vx = p.vy = p.vz = 0; }
        }
    }
    // Spent debris goes (it sinks out of sight over its last second).
    return pieces.filter(p => p.life === undefined || p.age < p.life);
}

/** Piece rotation as three columns (local frame): yaw about y, then pitch about x, then roll about z. */
export function pieceAxes(p: Piece): [number, number, number, number, number, number, number, number, number] {
    const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw), cp = Math.cos(p.pitch), sp = Math.sin(p.pitch), cr = Math.cos(p.roll), sr = Math.sin(p.roll);
    // R = Ry * Rx * Rz, columns.
    const x: [number, number, number] = [cy * cr + sy * sp * sr, cp * sr, -sy * cr + cy * sp * sr];
    const y: [number, number, number] = [-cy * sr + sy * sp * cr, cp * cr, sy * sr + cy * sp * cr];
    const z: [number, number, number] = [sy * cp, -sp, cy * cp];
    return [...x, ...y, ...z];
}

export { makeRng };
