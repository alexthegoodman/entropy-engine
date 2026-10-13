// The Abyss's air and water, as data and pure functions (the addon draws them):
//
// - Smoke plumes: columns of smoke billowing up out of the crack - from vents on the floor,
//   fissures in the walls, the burning lip of the rim - rising, swelling and leaning with the
//   wind until they spread into the pall over everything. A plume is a fixed site; its puffs are
//   a function of time (no simulation), so any frame can be drawn, tested or skipped to.
// - Fires: where the world burns (the blast's craters and ejecta on the plain, gas burning out
//   of the walls, wreckage and ruins on the floor). Near ones are real fires (ab_game feeds them
//   to the effects, they light and burn); far ones are drawn as glowing flame clusters.
// - Water: the Source's pool and the river still running below the Source, as meshes over the
//   baked ground (each vertex carries how deep it is, for the shader's shallows and shore foam).

import { makeRng } from "../allegiance/al_rng";
import {
    crackSD, riverDistance, CRATERS, SOURCE_POOL, RIVER, MAP_HALF, CANYON_X, riftBend, SETTLEMENT, EVAC_LZ, type V2, type V3,
} from "./ab_world";
import type { PackedMesh } from "./ab_models";

// --- Smoke plumes ------------------------------------------------------------------------------------

export interface Plume {
    x: number; z: number;
    /** Ground under its base (filled by the caller; plumes can be placed before the grid is baked). */
    y: number;
    /** How high it climbs (m) before it is part of the pall, how wide it gets, how fast it rises. */
    height: number;
    width: number;
    rate: number;
    /** Gray of its smoke (0 black .. 1 pale) and a phase so plumes do not pulse together. */
    shade: number;
    phase: number;
    /** Out-of-map plumes over the far canyon (drawn always, coarser). */
    far: boolean;
}

/** Puffs per plume (more for the big ones). */
export const PUFFS = 12;

/**
 * The plume sites: along the floor near the walls and the river, out of the walls' fissures,
 * from the rim's burning lip, and down the canyon beyond the map (the Western Dark smokes too).
 */
export function plumeSites(seed = 77): Plume[] {
    const rng = makeRng(seed);
    const out: Plume[] = [];
    const add = (x: number, z: number, height: number, width: number, shade: number, far = false) =>
        out.push({ x, z, y: 0, height, width, rate: 0.018 + rng.next() * 0.02, shade, phase: rng.next(), far });
    // Inside the crack: vents on the floor and fissures in the walls (most near the walls).
    for (let i = 0; i < 260 && out.length < 24; i++) {
        const x = -MAP_HALF + 60 + rng.next() * (MAP_HALF * 2 - 120), z = riftBend(x) + (rng.next() - 0.5) * 1700;
        const d = crackSD(x, z);
        if (d > -40 || d < -420) continue;
        if (Math.hypot(x - SETTLEMENT[0], z - SETTLEMENT[1]) < 260 || Math.hypot(x - EVAC_LZ[0], z - EVAC_LZ[1]) < 160) continue;
        add(x, z, 380 + rng.next() * 380, 40 + rng.next() * 50, 0.06 + rng.next() * 0.08);
    }
    // The rim's lip, still burning: lower, darker columns.
    for (let i = 0; i < 200 && out.length < 36; i++) {
        const x = -MAP_HALF + rng.next() * MAP_HALF * 2, z = riftBend(x) + (rng.next() < 0.5 ? -1 : 1) * (700 + rng.next() * 260);
        const d = crackSD(x, z);
        if (d < 10 || d > 140) continue;
        add(x, z, 200 + rng.next() * 220, 26 + rng.next() * 30, 0.04 + rng.next() * 0.05);
    }
    // Down the canyon past the map's edge: a wall of smoke in the west.
    for (let i = 0; i < 12; i++) {
        const x = CANYON_X - 800 - i * 340 - rng.next() * 200, z = riftBend(x) + (rng.next() - 0.5) * 1100;
        add(x, z, 500 + rng.next() * 500, 90 + rng.next() * 90, 0.07 + rng.next() * 0.08, true);
    }
    return out;
}

export interface Puff { x: number; y: number; z: number; size: number; opacity: number; spin: number; shade: number }

/**
 * Where a plume's puffs are at time t: each rises from the vent, swells and leans with the wind,
 * thickest a little above the ground, thinning as it joins the pall at the top.
 */
export function plumePuffs(p: Plume, t: number, wind: V2 = [3.2, 1.1], count = PUFFS): Puff[] {
    const out: Puff[] = [];
    for (let k = 0; k < count; k++) {
        const u = (t * p.rate + p.phase + k / count) % 1;
        const rise = u * p.height;
        // A plume leans downwind more the higher it gets, and wanders.
        const wob = Math.sin((k + p.phase * 13) * 1.7 + t * 0.07) * p.width * 0.18;
        const x = p.x + wind[0] * rise * 0.22 + wob, z = p.z + wind[1] * rise * 0.22 + Math.cos(k * 2.3 + p.phase * 7) * p.width * 0.15;
        const size = p.width * (0.32 + 1.1 * Math.sqrt(u));
        const opacity = Math.sin(Math.PI * Math.min(1, u * 1.15)) * (0.95 - u * 0.35);
        out.push({ x, y: p.y + rise + size * 0.3, z, size, opacity: Math.max(0, opacity), spin: k * 2.4 + u * 0.6, shade: p.shade * (1 + u * 0.6) });
    }
    return out;
}

// --- Fires ---------------------------------------------------------------------------------------------

export interface FireSite { x: number; z: number; radius: number; /** "surface" plain and rim; "wall" gas burning from a fissure; "floor" wreckage, ruins. */ kind: "surface" | "wall" | "floor" }

/** Where the world burns. */
export function fireSites(seed = 91): FireSite[] {
    const rng = makeRng(seed);
    const out: FireSite[] = [];
    // The craters' rims and the blast's ejecta round the crack.
    for (const [cx, cz, r] of CRATERS) for (let i = 0; i < 3; i++) {
        const a = rng.next() * Math.PI * 2, d = r * (0.6 + rng.next() * 0.6);
        out.push({ x: cx + Math.cos(a) * d, z: cz + Math.sin(a) * d, radius: 1.2 + rng.next() * 1.6, kind: "surface" });
    }
    for (let i = 0; i < 300 && out.length < 42; i++) {
        const x = -MAP_HALF + rng.next() * MAP_HALF * 2, z = (rng.next() - 0.5) * MAP_HALF * 2;
        const d = crackSD(x, z);
        if (d < 4 || d > 220) continue;
        out.push({ x, z, radius: 0.9 + rng.next() * 1.8, kind: "surface" });
    }
    // Gas burning out of the walls (on the terraces' treads, part way down).
    for (let i = 0; i < 400 && out.length < 62; i++) {
        const x = -MAP_HALF + rng.next() * MAP_HALF * 2, z = riftBend(x) + (rng.next() - 0.5) * 1800;
        const d = crackSD(x, z);
        if (d > -30 || d < -230) continue;
        out.push({ x, z, radius: 0.8 + rng.next() * 1.2, kind: "wall" });
    }
    // The floor: what still burns from the battles.
    for (let i = 0; i < 400 && out.length < 84; i++) {
        const x = -MAP_HALF + 100 + rng.next() * (MAP_HALF * 2 - 200), z = riftBend(x) + (rng.next() - 0.5) * 1400;
        const d = crackSD(x, z);
        if (d > -260 || riverDistance(x, z).d < 20) continue;
        if (Math.hypot(x - EVAC_LZ[0], z - EVAC_LZ[1]) < 90) continue;
        out.push({ x, z, radius: 1 + rng.next() * 2, kind: "floor" });
    }
    return out;
}

// --- Water -------------------------------------------------------------------------------------------


/** A point along the river's center line at t (0 the Source .. 1 its western end). */
export function riverPoint(t: number): V2 {
    let total = 0;
    const seg: number[] = [];
    for (let i = 0; i + 1 < RIVER.length; i++) { const l = Math.hypot(RIVER[i + 1][0] - RIVER[i][0], RIVER[i + 1][1] - RIVER[i][1]); seg.push(l); total += l; }
    let want = Math.max(0, Math.min(1, t)) * total;
    for (let i = 0; i < seg.length; i++) {
        if (want <= seg[i]) { const f = want / seg[i]; return [RIVER[i][0] + (RIVER[i + 1][0] - RIVER[i][0]) * f, RIVER[i][1] + (RIVER[i + 1][1] - RIVER[i][1]) * f]; }
        want -= seg[i];
    }
    return RIVER[RIVER.length - 1];
}

/** How far down the river from the Source the water still runs (beyond, the bed is dry). */
export const RIVER_WET = 0.34;

/**
 * The water: a grid over the pool and the wet reach of the river, `cell` meters, keeping the cells
 * where the water stands above the ground (and a rim of cells round them so the shore can fade).
 * Each vertex: uv.x its depth (level - ground), uv.y how far down the river it is.
 */
export function buildWater(ground: (x: number, z: number) => number, cell = 4): PackedMesh {
    // The pool stands four meters over its basin's deepest point.
    const poolLevel = ground(SOURCE_POOL[0], SOURCE_POOL[1]) + 4;
    const level = (x: number, z: number): { y: number; t: number } => {
        const pool = Math.hypot(x - SOURCE_POOL[0], z - SOURCE_POOL[1]);
        const r = riverDistance(x, z);
        // The river's water: a meter and a half over its bed's center, falling with it.
        const c = riverPoint(r.t);
        const riverY = ground(c[0], c[1]) + 1.6;
        const poolW = 1 - Math.min(1, Math.max(0, (pool - 90) / 60));
        return { y: poolW * poolLevel + (1 - poolW) * Math.min(riverY, poolLevel), t: poolW > 0.5 ? 0 : r.t };
    };
    const x0 = 560, x1 = 1460, z0 = -340, z1 = 200;
    const nx = Math.ceil((x1 - x0) / cell), nz = Math.ceil((z1 - z0) / cell);
    const vid = new Int32Array((nx + 1) * (nz + 1)).fill(-1);
    const verts: number[] = [];
    const idx: number[] = [];
    const wet = (x: number, z: number): boolean => {
        const pool = Math.hypot(x - SOURCE_POOL[0], z - SOURCE_POOL[1]);
        const r = riverDistance(x, z);
        return pool < 150 || (r.t < RIVER_WET && r.d < 40);
    };
    const vertex = (i: number, j: number): number => {
        const k = j * (nx + 1) + i;
        if (vid[k] >= 0) return vid[k];
        const x = x0 + i * cell, z = z0 + j * cell;
        const l = level(x, z);
        const depth = l.y - ground(x, z);
        vid[k] = verts.length / 12;
        // Normal up with the pattern's length (50) folded in; the color is unused.
        verts.push(x, l.y, z, 0, 51, 0, depth, l.t, 0.2, 0.3, 0.35, 0.5);
        return vid[k];
    };
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const x = x0 + (i + 0.5) * cell, z = z0 + (j + 0.5) * cell;
        if (!wet(x, z)) continue;
        const l = level(x, z);
        // A cell whose corners all stand well above the water is dry ground: skip it.
        let under = false;
        for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) if (ground(x0 + (i + dx) * cell, z0 + (j + dz) * cell) < l.y + 0.4) under = true;
        if (!under) continue;
        const p = vertex(i, j), q = vertex(i + 1, j), r = vertex(i, j + 1), s = vertex(i + 1, j + 1);
        idx.push(p, r, q, q, r, s);
    }
    const v = Float32Array.from(verts);
    let lx = Infinity, hx = -Infinity, lz = Infinity, hz = -Infinity, ly = Infinity, hy = -Infinity;
    for (let o = 0; o < v.length; o += 12) { lx = Math.min(lx, v[o]); hx = Math.max(hx, v[o]); ly = Math.min(ly, v[o + 1]); hy = Math.max(hy, v[o + 1]); lz = Math.min(lz, v[o + 2]); hz = Math.max(hz, v[o + 2]); }
    return { vertexData: v, indexData: Uint32Array.from(idx), bounds: [(lx + hx) / 2, (ly + hy) / 2, (lz + hz) / 2, Math.hypot(hx - lx, hy - ly, hz - lz) / 2], triangles: idx.length / 3 };
}

export type { V3 };

// --- Caves -------------------------------------------------------------------------------------------

/**
 * A cave: a vaulted tunnel winding in from its mouth to a domed chamber, built as a shell of rock
 * over the ground (the floor inside is the world's own). Its walls are solid, and the light map
 * is darkened under its roof (`caveRoofs`), so inside it is dark but for what glows there.
 */
export interface Cave {
    id: string;
    name: string;
    /** The tunnel's center line, mouth first (m). */
    path: V2[];
    width: number;
    height: number;
    /** The chamber at the tunnel's end: center, radius, height. */
    chamber: { at: V2; r: number; h: number };
}

/** The Whispering Vein: a slab of the north wall that fell in the blast, already hollowed by the kingdoms into a temple. */
export const CAVES: Cave[] = [
    { id: "vein", name: "The Whispering Vein", path: [[-200, 432], [-198, 446], [-203, 460], [-210, 474], [-214, 488]], width: 9, height: 7.5, chamber: { at: [-216, 504], r: 14, h: 13 } },
];

const lerp2 = (a: V2, b: V2, t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Stations along a cave's tunnel, `step` meters apart: position and unit direction. */
export function caveStations(c: Cave, step = 1.5): { at: V2; dir: V2 }[] {
    const out: { at: V2; dir: V2 }[] = [];
    for (let i = 0; i + 1 < c.path.length; i++) {
        const a = c.path[i], b = c.path[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const dir: V2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        for (let d = 0; d < len; d += step) out.push({ at: lerp2(a, b, d / len), dir });
    }
    // On into the chamber a little, so the seam is inside its dome.
    const last = c.path[c.path.length - 1], prev = c.path[c.path.length - 2];
    const l = Math.hypot(last[0] - prev[0], last[1] - prev[1]);
    const dir: V2 = [(last[0] - prev[0]) / l, (last[1] - prev[1]) / l];
    for (let d = 0; d <= 4; d += step) out.push({ at: [last[0] + dir[0] * d, last[1] + dir[1] * d], dir });
    return out;
}

/** A gentle lumpiness for rock (deterministic). */
const lump = (x: number, y: number, z: number): number => Math.sin(x * 0.71 + z * 0.33) * Math.sin(y * 0.93 - x * 0.27) * 0.5 + Math.sin(z * 1.7 + y * 1.3) * 0.25;

/** The cave's rock: the tunnel's vault and the chamber's dome, drawn from both sides (terrain shading: the walls' strata). */
export function buildCave(c: Cave, ground: (x: number, z: number) => number): PackedMesh {
    const v: number[] = [];
    const idx: number[] = [];
    const scale = 31; // terrain pattern (30) + 1
    const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number): number => {
        const l = Math.hypot(nx, ny, nz) || 1;
        v.push(x, y, z, nx / l * scale, ny / l * scale, nz / l * scale, 0, 0, 0, Math.abs(Math.sin(x * 0.0123 + z * 0.0071)), 0, 1);
        return v.length / 12 - 1;
    };
    const quad = (a: number, b: number, d: number, e: number) => idx.push(a, b, d, b, e, d, a, d, b, b, d, e);
    // The tunnel: an arch (both feet sunk into the ground) at each station, rings joined.
    const st = caveStations(c);
    const A = 14;
    const rings: number[][] = [];
    for (const s of st) {
        const side: V2 = [s.dir[1], -s.dir[0]];
        const base = ground(s.at[0], s.at[1]) - 0.8;
        const ring: number[] = [];
        for (let k = 0; k <= A; k++) {
            const a = (k / A) * Math.PI;
            const n = 1 + 0.09 * lump(s.at[0] + k, base, s.at[1]);
            const ox = Math.cos(a) * c.width / 2 * n, oy = Math.sin(a) * c.height * n;
            const x = s.at[0] + side[0] * ox, z = s.at[1] + side[1] * ox, y = base + oy;
            ring.push(vert(x, y, z, side[0] * Math.cos(a), Math.sin(a) * 0.8, side[1] * Math.cos(a)));
        }
        rings.push(ring);
    }
    for (let i = 0; i + 1 < rings.length; i++) for (let k = 0; k < A; k++) quad(rings[i][k], rings[i][k + 1], rings[i + 1][k], rings[i + 1][k + 1]);
    // The chamber: a dome, open where the tunnel comes in.
    const [cx, cz] = c.chamber.at;
    const g = ground(cx, cz) - 0.8;
    const T = 40, P = 10;
    const last = c.path[c.path.length - 1];
    const inAng = Math.atan2(last[1] - cz, last[0] - cx);
    const gap = Math.atan2(c.width / 2 + 0.6, c.chamber.r) + 0.05;
    const grid: number[][] = [];
    for (let i = 0; i <= T; i++) {
        const th = (i / T) * Math.PI * 2;
        const col: number[] = [];
        for (let j = 0; j <= P; j++) {
            const ph = (j / P) * Math.PI / 2;
            const n = 1 + 0.1 * lump(th * 9, ph * 7, cx);
            const x = cx + Math.cos(th) * Math.cos(ph) * c.chamber.r * n, z = cz + Math.sin(th) * Math.cos(ph) * c.chamber.r * n, y = g + Math.sin(ph) * c.chamber.h * n;
            col.push(vert(x, y, z, Math.cos(th) * Math.cos(ph), Math.sin(ph), Math.sin(th) * Math.cos(ph)));
        }
        grid.push(col);
    }
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    for (let i = 0; i < T; i++) for (let j = 0; j < P; j++) {
        const th = ((i + 0.5) / T) * Math.PI * 2;
        const y = Math.sin(((j + 0.5) / P) * Math.PI / 2) * c.chamber.h;
        // The doorway: where the tunnel meets the dome, below the tunnel's own roof.
        if (Math.abs(wrap(th - inAng)) < gap && y < c.height * 1.05) continue;
        quad(grid[i][j], grid[i + 1][j], grid[i][j + 1], grid[i + 1][j + 1]);
    }
    const vd = Float32Array.from(v);
    let lx = Infinity, hx = -Infinity, ly = Infinity, hy = -Infinity, lz = Infinity, hz = -Infinity;
    for (let o = 0; o < vd.length; o += 12) { lx = Math.min(lx, vd[o]); hx = Math.max(hx, vd[o]); ly = Math.min(ly, vd[o + 1]); hy = Math.max(hy, vd[o + 1]); lz = Math.min(lz, vd[o + 2]); hz = Math.max(hz, vd[o + 2]); }
    return { vertexData: vd, indexData: Uint32Array.from(idx), bounds: [(lx + hx) / 2, (ly + hy) / 2, (lz + hz) / 2, Math.hypot(hx - lx, hy - ly, hz - lz) / 2], triangles: idx.length / 3 };
}

/** The cave's walls as solids (columns along both sides of the tunnel and round the chamber, but its doorway). */
export function caveSolids(c: Cave): { x: number; z: number; r: number; h: number; cover: boolean }[] {
    const out: { x: number; z: number; r: number; h: number; cover: boolean }[] = [];
    const st = caveStations(c, 1.2);
    // Not round the mouth's lip (the first meter) so it can be walked into.
    for (const s of st.slice(1, -3)) for (const sd of [-1, 1]) {
        const off = c.width / 2 + 0.5;
        out.push({ x: s.at[0] + s.dir[1] * off * sd, z: s.at[1] - s.dir[0] * off * sd, r: 0.9, h: c.height + 2, cover: true });
    }
    const [cx, cz] = c.chamber.at;
    const last = c.path[c.path.length - 1];
    const inAng = Math.atan2(last[1] - cz, last[0] - cx);
    const gap = Math.atan2(c.width / 2 + 0.6, c.chamber.r) + 0.08;
    const n = Math.ceil((2 * Math.PI * c.chamber.r) / 1.4);
    for (let i = 0; i < n; i++) {
        const th = (i / n) * Math.PI * 2;
        if (Math.abs(Math.atan2(Math.sin(th - inAng), Math.cos(th - inAng))) < gap) continue;
        out.push({ x: cx + Math.cos(th) * (c.chamber.r + 0.5), z: cz + Math.sin(th) * (c.chamber.r + 0.5), r: 1, h: c.chamber.h, cover: true });
    }
    return out;
}

/** Where a cave's roof shuts out the sky: circles (x, z, r) and the height under which it is dark. */
export function caveRoofs(c: Cave, ground: (x: number, z: number) => number): { x: number; z: number; r: number; top: number }[] {
    const out = caveStations(c, 3).map(s => ({ x: s.at[0], z: s.at[1], r: c.width / 2 + 1, top: ground(s.at[0], s.at[1]) + c.height * 0.85 }));
    // The first few meters are open to the light at the mouth.
    out.splice(0, 2);
    const [cx, cz] = c.chamber.at;
    out.push({ x: cx, z: cz, r: c.chamber.r + 1, top: ground(cx, cz) + c.chamber.h * 0.85 });
    return out;
}
