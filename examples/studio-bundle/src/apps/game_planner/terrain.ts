// Terrain for the Game World Planner: one heightfield every map layer and tool reads.
//
// The world's terrain is a regular grid of elevations in meters (`TerrainGrid`), row 0 along the
// north edge (y = +H/2) and column 0 along the west edge (x = -W/2). The map widget draws it as a
// shaded relief / heatmap, contours are traced from it with marching squares, rivers follow its
// drainage, settlements and roads are scored and routed over it, and spots read their elevation
// from it. Generating, eroding or re-fitting terrain replaces this one grid, so every layer agrees.

import type { ContourLine, TerrainGrid, WorldMetadata, WorldSpot } from "./planner_types";

// -------------------------------------------------------------------------------------------------
// Random numbers and noise
// -------------------------------------------------------------------------------------------------

/** Seedable PRNG (Mulberry32). */
export class PRNG {
    private s: number;

    constructor(seed = 1337) {
        this.s = seed | 0;
    }

    next(): number {
        let t = (this.s += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    range(min: number, max: number): number {
        return min + this.next() * (max - min);
    }

    int(min: number, max: number): number {
        return Math.floor(this.range(min, max + 1));
    }

    pick<T>(arr: T[]): T {
        return arr[this.int(0, arr.length - 1)];
    }
}

/** 2D gradient (Perlin) noise. `noise` is roughly in -0.7..0.7. */
export class Noise2D {
    private p: number[] = [];

    constructor(seed = 42) {
        const rng = new PRNG(seed);
        const perm: number[] = [];
        for (let i = 0; i < 256; i++) perm.push(i);
        for (let i = 255; i > 0; i--) {
            const j = rng.int(0, i);
            [perm[i], perm[j]] = [perm[j], perm[i]];
        }
        this.p = [...perm, ...perm];
    }

    private fade(t: number): number {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }

    private grad(hash: number, x: number, y: number): number {
        // Eight gradient directions (not four) so the noise has no visible axis bias.
        switch (hash & 7) {
            case 0: return x + y;
            case 1: return -x + y;
            case 2: return x - y;
            case 3: return -x - y;
            case 4: return x * 1.4142;
            case 5: return -x * 1.4142;
            case 6: return y * 1.4142;
            default: return -y * 1.4142;
        }
    }

    noise(x: number, y: number): number {
        const fx = Math.floor(x);
        const fy = Math.floor(y);
        const X = fx & 255;
        const Y = fy & 255;
        const xf = x - fx;
        const yf = y - fy;
        const u = this.fade(xf);
        const v = this.fade(yf);
        const p = this.p;
        const aa = p[p[X] + Y];
        const ab = p[p[X] + Y + 1];
        const ba = p[p[X + 1] + Y];
        const bb = p[p[X + 1] + Y + 1];
        const x1 = this.grad(aa, xf, yf) + u * (this.grad(ba, xf - 1, yf) - this.grad(aa, xf, yf));
        const x2 = this.grad(ab, xf, yf - 1) + u * (this.grad(bb, xf - 1, yf - 1) - this.grad(ab, xf, yf - 1));
        return (x1 + v * (x2 - x1)) * 0.5;
    }

    /** Fractal Brownian motion, normalized to about -1..1. */
    fractal(x: number, y: number, octaves = 4, persistence = 0.5, lacunarity = 2.0): number {
        let total = 0;
        let frequency = 1;
        let amplitude = 1;
        let maxValue = 0;
        for (let i = 0; i < octaves; i++) {
            // Offset each octave so their lattices never line up.
            total += this.noise(x * frequency + i * 17.31, y * frequency - i * 9.73) * amplitude;
            maxValue += amplitude;
            amplitude *= persistence;
            frequency *= lacunarity;
        }
        return (total / maxValue) * 2.0;
    }

    /** Ridged multifractal: sharp crests where the noise crosses zero, 0..1. */
    ridged(x: number, y: number, octaves = 4, lacunarity = 2.1, gain = 0.55): number {
        let sum = 0;
        let amp = 0.5;
        let freq = 1;
        let weight = 1;
        let norm = 0;
        for (let i = 0; i < octaves; i++) {
            let n = 1 - Math.abs(this.noise(x * freq + i * 31.7, y * freq + i * 11.1) * 2);
            n = n * n * weight;
            weight = Math.min(1, Math.max(0, n * 2));
            sum += n * amp;
            norm += amp;
            amp *= gain;
            freq *= lacunarity;
        }
        return sum / norm;
    }
}

const smoothstep = (a: number, b: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};

// -------------------------------------------------------------------------------------------------
// Grid helpers
// -------------------------------------------------------------------------------------------------

export function terrainCellKm(t: TerrainGrid, meta: Pick<WorldMetadata, "worldWidthKm" | "worldHeightKm">): { dx: number; dy: number } {
    return { dx: meta.worldWidthKm / (t.cols - 1), dy: meta.worldHeightKm / (t.rows - 1) };
}

/** World km position of grid vertex (col, row). */
export function gridToWorld(t: TerrainGrid, meta: Pick<WorldMetadata, "worldWidthKm" | "worldHeightKm">, col: number, row: number): [number, number] {
    const { dx, dy } = terrainCellKm(t, meta);
    return [-meta.worldWidthKm / 2 + col * dx, meta.worldHeightKm / 2 - row * dy];
}

/** Fractional grid coordinates of a world km position. */
export function worldToGrid(t: TerrainGrid, meta: Pick<WorldMetadata, "worldWidthKm" | "worldHeightKm">, x: number, y: number): [number, number] {
    const { dx, dy } = terrainCellKm(t, meta);
    return [(x + meta.worldWidthKm / 2) / dx, (meta.worldHeightKm / 2 - y) / dy];
}

/** Bilinear elevation (meters) at a world km position; clamps to the world edge. */
export function sampleTerrain(t: TerrainGrid, meta: Pick<WorldMetadata, "worldWidthKm" | "worldHeightKm">, x: number, y: number): number {
    const [gc, gr] = worldToGrid(t, meta, x, y);
    const c = Math.min(t.cols - 1.0001, Math.max(0, gc));
    const r = Math.min(t.rows - 1.0001, Math.max(0, gr));
    const c0 = Math.floor(c);
    const r0 = Math.floor(r);
    const fc = c - c0;
    const fr = r - r0;
    const d = t.data;
    const i = r0 * t.cols + c0;
    const top = d[i] + (d[i + 1] - d[i]) * fc;
    const bot = d[i + t.cols] + (d[i + t.cols + 1] - d[i + t.cols]) * fc;
    return top + (bot - top) * fr;
}

/** Slope in degrees at a world km position (central differences). */
export function sampleSlopeDeg(t: TerrainGrid, meta: Pick<WorldMetadata, "worldWidthKm" | "worldHeightKm">, x: number, y: number): number {
    const { dx, dy } = terrainCellKm(t, meta);
    const ex = sampleTerrain(t, meta, x + dx, y) - sampleTerrain(t, meta, x - dx, y);
    const ey = sampleTerrain(t, meta, x, y + dy) - sampleTerrain(t, meta, x, y - dy);
    const gx = ex / (2 * dx * 1000);
    const gy = ey / (2 * dy * 1000);
    return (Math.atan(Math.sqrt(gx * gx + gy * gy)) * 180) / Math.PI;
}

export function terrainStats(data: ArrayLike<number>): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return { min, max };
}

function finalize(cols: number, rows: number, data: ArrayLike<number>, seaLevelM: number): TerrainGrid {
    const out: number[] = new Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = Math.round(data[i] * 10) / 10;
    const { min, max } = terrainStats(out);
    return { cols, rows, data: out, seaLevelM, minM: min, maxM: max };
}

/** Converts the legacy row-of-rows grid the old procedural tools produced. */
export function terrainFromRows(grid: number[][], seaLevelM = 0): TerrainGrid {
    const rows = grid.length;
    const cols = grid[0]?.length || 0;
    const data: number[] = [];
    for (const row of grid) data.push(...row);
    return finalize(cols, rows, data, seaLevelM);
}

export function terrainToRows(t: TerrainGrid): number[][] {
    const out: number[][] = [];
    for (let r = 0; r < t.rows; r++) out.push(t.data.slice(r * t.cols, (r + 1) * t.cols));
    return out;
}

// -------------------------------------------------------------------------------------------------
// Generation
// -------------------------------------------------------------------------------------------------

export interface TerrainConfig {
    widthKm: number;
    heightKm: number;
    /** Grid vertices along each axis (default 129). */
    resolution?: number;
    seed: number;
    /** Highest peak in meters above sea level. */
    mountainScale?: number;
    /** Deepest sea floor in meters below sea level. */
    oceanDepthM?: number;
    seaLevelM?: number;
    /** Surround the land with ocean. */
    islandMask?: boolean;
    /** 0..1: how much of the land is mountain ranges (default 0.55). */
    ruggedness?: number;
    /** -0.5..0.5 raises (more land) or lowers (more sea) the whole continent (default 0). */
    landBias?: number;
}

/**
 * A continent or archipelago: domain-warped fBm for the landmass, ridged multifractal mountain
 * ranges where the land is high, an optional ocean falloff toward the edges. Land is rescaled so the
 * highest peak is `mountainScale` and the deepest water `oceanDepthM`.
 */
export function generateTerrain(config: TerrainConfig): TerrainGrid {
    const res = Math.max(9, Math.min(257, Math.round(config.resolution || 129)));
    const cols = res;
    const rows = res;
    const seed = config.seed | 0;
    const base = new Noise2D(seed);
    const warp = new Noise2D(seed + 7);
    const ridge = new Noise2D(seed + 101);
    const detail = new Noise2D(seed + 211);
    const maxM = config.mountainScale ?? 2600;
    const depthM = config.oceanDepthM ?? 900;
    const sea = config.seaLevelM ?? 0;
    const island = config.islandMask !== false;
    const rugged = Math.min(1, Math.max(0, config.ruggedness ?? 0.55));
    const bias = config.landBias ?? 0;
    // Noise frequencies are per kilometer so a 10 km and a 60 km world have mountains of the same size.
    const kmScale = Math.max(config.widthKm, config.heightKm);
    const contFreq = 2.1;                 // landmasses per world
    const ridgeFreq = kmScale / 9.0;      // ranges ~9 km apart
    const detailFreq = kmScale / 2.2;     // hills ~2 km apart

    const raw = new Float64Array(cols * rows);
    for (let r = 0; r < rows; r++) {
        const ny = r / (rows - 1) - 0.5;
        for (let c = 0; c < cols; c++) {
            const nx = c / (cols - 1) - 0.5;
            // Domain warp: bends coastlines and ranges into natural curves.
            const wx = warp.fractal(nx * 2.0 + 5.2, ny * 2.0 + 1.3, 3) * 0.16;
            const wy = warp.fractal(nx * 2.0 + 1.7, ny * 2.0 + 9.2, 3) * 0.16;
            const px = nx + wx;
            const py = ny + wy;

            let cont = base.fractal(px * contFreq, py * contFreq, 5, 0.5, 2.0) * 0.55 + 0.12 + bias;
            if (island) {
                const rad = Math.sqrt(nx * nx + ny * ny) * 2; // 0 at center, 1 at the edge midpoints
                cont = cont * 0.75 + 0.32 * (1 - smoothstep(0.2, 0.75, rad)) - 0.55 * smoothstep(0.6, 1.05, rad);
            }
            const mountainMask = smoothstep(0.02, 0.35, cont);
            const ridges = ridge.ridged(px * ridgeFreq, py * ridgeFreq, 5);
            const hills = detail.fractal(px * detailFreq, py * detailFreq, 3, 0.5, 2.0);
            let h = cont + ridges * ridges * 1.1 * rugged * mountainMask + hills * 0.035 * (0.3 + mountainMask);
            // Gentle coastal shelf: flattens the band just above and below sea level into beaches and shallows.
            if (h > -0.04 && h < 0.04) h *= 0.6;
            raw[r * cols + c] = h;
        }
    }

    let maxLand = 1e-6;
    let minSea = -1e-6;
    for (let i = 0; i < raw.length; i++) {
        if (raw[i] > maxLand) maxLand = raw[i];
        if (raw[i] < minSea) minSea = raw[i];
    }
    const data = new Float64Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
        const h = raw[i];
        data[i] = h >= 0
            ? sea + Math.pow(h / maxLand, 1.45) * maxM // lowlands broad, peaks rare
            : sea - Math.pow(h / minSea, 0.8) * depthM;
    }
    return finalize(cols, rows, data, sea);
}

/**
 * Bends the terrain so it agrees with authored spot elevations, leaving land far away untouched.
 * A spot on land is met by scaling the relief around it (ridges and valleys keep their shape, a
 * massif simply grows or sinks); a spot at the shore or in the sea is met by raising or lowering
 * the ground directly. Gaussian falloff (`radiusKm`); a few passes resolve overlapping spots.
 */
export function fitTerrainToSpots(
    t: TerrainGrid,
    meta: Pick<WorldMetadata, "worldWidthKm" | "worldHeightKm">,
    spots: Array<Pick<WorldSpot, "x" | "y" | "elevation">>,
    radiusKm = 3.0,
    passes = 5
): TerrainGrid {
    if (spots.length === 0) return t;
    const data = Float64Array.from(t.data);
    const work: TerrainGrid = { ...t, data: data as unknown as number[] };
    const sea = t.seaLevelM;
    const { dx, dy } = terrainCellKm(t, meta);
    const n = data.length;
    const { max: maxBefore } = terrainStats(t.data);
    const cap = Math.max(maxBefore, ...spots.map((s) => s.elevation)) * 1.08 + 20;

    // Visits every grid cell within 3 radii of a spot with its Gaussian weight.
    const around = (s: Pick<WorldSpot, "x" | "y">, radius: number, fn: (k: number, w: number) => void) => {
        const sigma2 = 2 * radius * radius;
        const reach = radius * 3;
        const [gc, gr] = worldToGrid(t, meta, s.x, s.y);
        const c0 = Math.max(0, Math.floor(gc - reach / dx));
        const c1 = Math.min(t.cols - 1, Math.ceil(gc + reach / dx));
        const r0 = Math.max(0, Math.floor(gr - reach / dy));
        const r1 = Math.min(t.rows - 1, Math.ceil(gr + reach / dy));
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                const [wx, wy] = gridToWorld(t, meta, c, r);
                fn(r * t.cols + c, Math.exp(-((wx - s.x) ** 2 + (wy - s.y) ** 2) / sigma2));
            }
        }
    };

    // 1. Scale the relief: each land spot compares its target to the mean height of the land around
    //    it, so a mountain town raises its whole massif (ridges intact) instead of growing a cone.
    const mulW = new Float64Array(n), mulWL = new Float64Array(n), mulMax = new Float64Array(n);
    const scaleRadius = radiusKm * 1.5;
    for (const s of spots) {
        const targetAbove = s.elevation - sea;
        if (targetAbove <= 5) continue;
        let sw = 0, sh = 0;
        around(s, scaleRadius, (k, w) => {
            if (data[k] > sea) {
                sw += w;
                sh += w * (data[k] - sea);
            }
        });
        const localAbove = sw > 0 ? sh / sw : 0;
        if (localAbove < 30) continue;
        const logRatio = Math.log(Math.min(3, Math.max(0.33, targetAbove / localAbove)));
        around(s, scaleRadius, (k, w) => {
            mulW[k] += w;
            mulWL[k] += w * logRatio;
            if (w > mulMax[k]) mulMax[k] = w;
        });
    }
    for (let k = 0; k < n; k++) {
        if (mulW[k] > 0 && data[k] > sea) data[k] = sea + (data[k] - sea) * Math.exp((mulWL[k] / mulW[k]) * mulMax[k]);
    }

    // 2. Land each spot exactly with small additive corrections.
    for (let pass = 0; pass < passes; pass++) {
        const addW = new Float64Array(n), addWR = new Float64Array(n), addMax = new Float64Array(n);
        let worst = 0;
        for (const s of spots) {
            const residual = s.elevation - sampleTerrain(work, meta, s.x, s.y);
            worst = Math.max(worst, Math.abs(residual));
            if (Math.abs(residual) < 0.25) continue;
            around(s, radiusKm * (pass === 0 ? 1 : 0.6), (k, w) => {
                addW[k] += w;
                addWR[k] += w * residual;
                if (w > addMax[k]) addMax[k] = w;
            });
        }
        if (worst < 0.25) break;
        for (let k = 0; k < n; k++) if (addW[k] > 0) data[k] += (addWR[k] / addW[k]) * addMax[k];
    }
    // Keep peaks believable: compress anything far above the highest authored or generated summit.
    for (let k = 0; k < n; k++) {
        if (data[k] > cap) data[k] = cap + (data[k] - cap) * 0.2;
    }
    return finalize(t.cols, t.rows, data, t.seaLevelM);
}

// -------------------------------------------------------------------------------------------------
// Hydraulic erosion (particle droplets)
// -------------------------------------------------------------------------------------------------

export interface ErosionOptions {
    droplets?: number;
    seed?: number;
    inertia?: number;
    capacity?: number;
    erodeSpeed?: number;
    depositSpeed?: number;
    evaporate?: number;
    maxSteps?: number;
}

/**
 * Rain droplets run downhill over the heightfield, picking up sediment where they speed up and
 * dropping it where they slow down: valleys deepen into gullies, basins fill into flat alluvial
 * floors. Works on a normalized copy, so the result does not depend on the mountain height.
 */
export function erodeTerrain(t: TerrainGrid, opts: ErosionOptions = {}): TerrainGrid {
    const cols = t.cols;
    const rows = t.rows;
    const { min, max } = terrainStats(t.data);
    const span = Math.max(1, max - min);
    const h = new Float64Array(t.data.length);
    for (let i = 0; i < h.length; i++) h[i] = (t.data[i] - min) / span;

    const droplets = opts.droplets ?? 30000;
    const rng = new PRNG(opts.seed ?? 8821);
    const inertia = opts.inertia ?? 0.05;
    const capacityK = opts.capacity ?? 4;
    const erodeK = opts.erodeSpeed ?? 0.3;
    const depositK = opts.depositSpeed ?? 0.3;
    const evap = opts.evaporate ?? 0.02;
    const maxSteps = opts.maxSteps ?? 48;
    const minSlope = 0.0005;
    const gravity = 4;
    // Keep the ocean floor out of it: droplets stop once they reach the sea.
    const seaN = (t.seaLevelM - min) / span;

    const heightGrad = (x: number, y: number) => {
        const cx = Math.floor(x);
        const cy = Math.floor(y);
        const u = x - cx;
        const v = y - cy;
        const i = cy * cols + cx;
        const nw = h[i], ne = h[i + 1], sw = h[i + cols], se = h[i + cols + 1];
        return {
            gx: (ne - nw) * (1 - v) + (se - sw) * v,
            gy: (sw - nw) * (1 - u) + (se - ne) * u,
            h: nw * (1 - u) * (1 - v) + ne * u * (1 - v) + sw * (1 - u) * v + se * u * v,
        };
    };

    for (let d = 0; d < droplets; d++) {
        let x = rng.range(1, cols - 2);
        let y = rng.range(1, rows - 2);
        let dirX = 0;
        let dirY = 0;
        let speed = 1;
        let water = 1;
        let sediment = 0;
        for (let step = 0; step < maxSteps; step++) {
            const cx = Math.floor(x);
            const cy = Math.floor(y);
            const u = x - cx;
            const v = y - cy;
            const here = heightGrad(x, y);
            if (here.h <= seaN) break;
            dirX = dirX * inertia - here.gx * (1 - inertia);
            dirY = dirY * inertia - here.gy * (1 - inertia);
            const len = Math.hypot(dirX, dirY);
            if (len < 1e-9) break;
            dirX /= len;
            dirY /= len;
            const nx = x + dirX;
            const ny = y + dirY;
            if (nx < 0 || nx >= cols - 1 || ny < 0 || ny >= rows - 1) break;
            const dh = heightGrad(nx, ny).h - here.h;
            const capacity = Math.max(-dh, minSlope) * speed * water * capacityK;
            const i = cy * cols + cx;
            if (sediment > capacity || dh > 0) {
                const amount = dh > 0 ? Math.min(dh, sediment) : (sediment - capacity) * depositK;
                sediment -= amount;
                h[i] += amount * (1 - u) * (1 - v);
                h[i + 1] += amount * u * (1 - v);
                h[i + cols] += amount * (1 - u) * v;
                h[i + cols + 1] += amount * u * v;
            } else {
                const amount = Math.min((capacity - sediment) * erodeK, -dh);
                // Erode with a small 3x3 brush so channels are smooth, not single-cell trenches.
                let wsum = 0;
                const ws: Array<[number, number]> = [];
                for (let oy = -1; oy <= 2; oy++) {
                    for (let ox = -1; ox <= 2; ox++) {
                        const bx = cx + ox;
                        const by = cy + oy;
                        if (bx < 0 || by < 0 || bx >= cols || by >= rows) continue;
                        const dist = Math.hypot(bx - x, by - y);
                        if (dist > 1.6) continue;
                        const w = 1.6 - dist;
                        wsum += w;
                        ws.push([by * cols + bx, w]);
                    }
                }
                for (const [k, w] of ws) h[k] -= (amount * w) / wsum;
                sediment += amount;
            }
            speed = Math.sqrt(Math.max(0, speed * speed - dh * gravity * span / 1000 * 10));
            water *= 1 - evap;
            x = nx;
            y = ny;
        }
    }

    const out = new Float64Array(h.length);
    for (let i = 0; i < h.length; i++) {
        out[i] = min + h[i] * span;
        // Valleys deepen but land never drops into the sea: no stray inland "lakes" at sea level.
        if (t.data[i] > t.seaLevelM && out[i] <= t.seaLevelM) out[i] = t.seaLevelM + 0.5;
    }
    return finalize(cols, rows, out, t.seaLevelM);
}

// -------------------------------------------------------------------------------------------------
// Drainage: depression filling, flow directions, accumulation
// -------------------------------------------------------------------------------------------------

export interface Drainage {
    /** Filled elevations (no pits), meters. */
    filled: Float64Array;
    /** Index of the downstream cell, or -1 for an outlet (sea or map edge). */
    downstream: Int32Array;
    /** Upstream cell count including itself. */
    accumulation: Float64Array;
}

const NEIGHBORS: Array<[number, number, number]> = [
    [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
    [-1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [1, 1, Math.SQRT2],
];

/** Min-heap keyed on a float, for priority-flood and A*. */
class MinHeap {
    private keys: number[] = [];
    private vals: number[] = [];
    get size(): number {
        return this.keys.length;
    }
    push(key: number, val: number): void {
        const k = this.keys, v = this.vals;
        k.push(key);
        v.push(val);
        let i = k.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (k[p] <= k[i]) break;
            [k[p], k[i]] = [k[i], k[p]];
            [v[p], v[i]] = [v[i], v[p]];
            i = p;
        }
    }
    pop(): number {
        const k = this.keys, v = this.vals;
        const top = v[0];
        const lastK = k.pop()!;
        const lastV = v.pop()!;
        if (k.length > 0) {
            k[0] = lastK;
            v[0] = lastV;
            let i = 0;
            for (;;) {
                const l = i * 2 + 1;
                const r = l + 1;
                let m = i;
                if (l < k.length && k[l] < k[m]) m = l;
                if (r < k.length && k[r] < k[m]) m = r;
                if (m === i) break;
                [k[m], k[i]] = [k[i], k[m]];
                [v[m], v[i]] = [v[i], v[m]];
                i = m;
            }
        }
        return top;
    }
}

/** Priority-flood depression filling (Barnes et al.), then D8 flow and accumulation. */
export function computeDrainage(t: TerrainGrid): Drainage {
    const { cols, rows } = t;
    const n = cols * rows;
    const filled = Float64Array.from(t.data);
    const done = new Uint8Array(n);
    const heap = new MinHeap();
    const sea = t.seaLevelM;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const i = r * cols + c;
            if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1 || t.data[i] <= sea) {
                done[i] = 1;
                heap.push(filled[i], i);
            }
        }
    }
    const downstream = new Int32Array(n).fill(-1);
    const order: number[] = [];
    while (heap.size > 0) {
        const i = heap.pop();
        order.push(i);
        const r = Math.floor(i / cols);
        const c = i - r * cols;
        for (const [dr, dc] of NEIGHBORS) {
            const nr = r + dr;
            const nc = c + dc;
            if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
            const j = nr * cols + nc;
            if (done[j]) continue;
            done[j] = 1;
            // Epsilon keeps a gradient across filled flats so water still has a way out.
            if (filled[j] <= filled[i]) filled[j] = filled[i] + 0.01;
            downstream[j] = i;
            heap.push(filled[j], j);
        }
    }
    // Steepest descent on the filled surface (falls back to the flood parent on flats).
    for (let i = 0; i < n; i++) {
        if (downstream[i] < 0) continue;
        const r = Math.floor(i / cols);
        const c = i - r * cols;
        let best = downstream[i];
        let bestDrop = (filled[i] - filled[best]) / 1;
        for (const [dr, dc, dist] of NEIGHBORS) {
            const nr = r + dr;
            const nc = c + dc;
            if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
            const j = nr * cols + nc;
            const drop = (filled[i] - filled[j]) / dist;
            if (drop > bestDrop) {
                bestDrop = drop;
                best = j;
            }
        }
        downstream[i] = best;
    }
    const accumulation = new Float64Array(n).fill(1);
    for (let k = order.length - 1; k >= 0; k--) {
        const i = order[k];
        const d = downstream[i];
        if (d >= 0) accumulation[d] += accumulation[i];
    }
    return { filled, downstream, accumulation };
}

export interface RiverChannel {
    /** World km points, source first, mouth last. */
    points: [number, number][];
    /** Upstream area at the mouth, in grid cells. */
    discharge: number;
}

/** Corner-cutting smoothing for polylines; keeps the endpoints. */
export function chaikin(points: [number, number][], iterations = 2): [number, number][] {
    let pts = points;
    for (let it = 0; it < iterations; it++) {
        if (pts.length < 3) return pts;
        const out: [number, number][] = [pts[0]];
        for (let i = 0; i < pts.length - 1; i++) {
            const [ax, ay] = pts[i];
            const [bx, by] = pts[i + 1];
            out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25]);
            out.push([ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
        }
        out.push(pts[pts.length - 1]);
        pts = out;
    }
    return pts;
}

/** Douglas-Peucker simplification in world km. */
export function simplifyPolyline(points: [number, number][], toleranceKm: number): [number, number][] {
    if (points.length <= 2) return points;
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, points.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop()!;
        const [ax, ay] = points[a];
        const [bx, by] = points[b];
        const len = Math.hypot(bx - ax, by - ay) || 1e-9;
        let maxD = -1;
        let idx = -1;
        for (let i = a + 1; i < b; i++) {
            const [px, py] = points[i];
            const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
            if (d > maxD) {
                maxD = d;
                idx = i;
            }
        }
        if (maxD > toleranceKm && idx > 0) {
            keep[idx] = 1;
            stack.push([a, idx], [idx, b]);
        }
    }
    return points.filter((_, i) => keep[i]);
}

const roundPt = (p: [number, number]): [number, number] => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];

/**
 * The largest drainage channels: picks the outlets that collect the most water and walks each one
 * upstream along its biggest tributary until the channel is a trickle. Returned source-to-mouth.
 */
export function traceRiverChannels(
    t: TerrainGrid,
    meta: Pick<WorldMetadata, "worldWidthKm" | "worldHeightKm">,
    count: number,
    drainage: Drainage = computeDrainage(t)
): RiverChannel[] {
    const { cols, rows } = t;
    const { accumulation, downstream } = drainage;
    const n = cols * rows;
    const minAcc = Math.max(4, n * 0.0015);
    const minCells = Math.max(4, Math.round(Math.max(cols, rows) / 20));
    // Every land cell that drains straight into the sea or off the map is a mouth candidate.
    const upstreamOf: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) if (downstream[i] >= 0) upstreamOf[downstream[i]].push(i);
    const mouths: number[] = [];
    for (let i = 0; i < n; i++) {
        if (t.data[i] <= t.seaLevelM) continue;
        const d = downstream[i];
        if (d < 0 || t.data[d] <= t.seaLevelM) mouths.push(i);
    }
    mouths.sort((a, b) => accumulation[b] - accumulation[a]);
    const used = new Uint8Array(n);
    const channels: RiverChannel[] = [];
    for (const mouth of mouths) {
        if (channels.length >= count) break;
        if (accumulation[mouth] < minAcc * 3 || used[mouth]) continue;
        const cells: number[] = [mouth];
        let cur = mouth;
        for (;;) {
            let best = -1;
            for (const u of upstreamOf[cur]) {
                if (t.data[u] <= t.seaLevelM) continue;
                if (best < 0 || accumulation[u] > accumulation[best]) best = u;
            }
            if (best < 0 || accumulation[best] < minAcc || used[best]) break;
            cells.push(best);
            cur = best;
        }
        if (cells.length < minCells) continue;
        for (const c of cells) {
            used[c] = 1;
            // Keep rivers apart: mark a one-cell margin so the next river picks another valley.
            const r = Math.floor(c / cols), cc = c - r * cols;
            for (const [dr, dc] of NEIGHBORS) {
                const nr = r + dr, nc = cc + dc;
                if (nr >= 0 && nc >= 0 && nr < rows && nc < cols) used[nr * cols + nc] = 1;
            }
        }
        cells.reverse();
        let pts = cells.map((i) => gridToWorld(t, meta, i % cols, Math.floor(i / cols)));
        // End the river in the sea, not one cell short of the shore.
        const d = downstream[mouth];
        if (d >= 0) pts.push(gridToWorld(t, meta, d % cols, Math.floor(d / cols)));
        pts = chaikin(simplifyPolyline(pts, terrainCellKm(t, meta).dx * 0.35), 2).map(roundPt);
        channels.push({ points: pts, discharge: accumulation[mouth] });
    }
    return channels;
}

/** Lowers the ground along river channels so valleys and contours bend around the water. */
export function carveRivers(t: TerrainGrid, meta: Pick<WorldMetadata, "worldWidthKm" | "worldHeightKm">, rivers: Array<{ points: [number, number][] }>, depthM = 12): TerrainGrid {
    const data = Float64Array.from(t.data);
    const { dx } = terrainCellKm(t, meta);
    for (const river of rivers) {
        const pts = river.points;
        for (let i = 0; i < pts.length - 1; i++) {
            const steps = Math.max(1, Math.ceil(Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) / (dx * 0.5)));
            for (let s = 0; s < steps; s++) {
                const f = s / steps;
                const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f;
                const y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f;
                const [gc, gr] = worldToGrid(t, meta, x, y);
                const depth = depthM * (0.4 + 0.6 * (i / pts.length));
                for (let r = Math.floor(gr) - 1; r <= Math.ceil(gr) + 1; r++) {
                    for (let c = Math.floor(gc) - 1; c <= Math.ceil(gc) + 1; c++) {
                        if (r < 0 || c < 0 || r >= t.rows || c >= t.cols) continue;
                        const k = r * t.cols + c;
                        if (data[k] <= t.seaLevelM) continue;
                        const w = Math.max(0, 1 - Math.hypot(c - gc, r - gr) / 1.8);
                        const target = Math.max(t.seaLevelM + 0.5, t.data[k] - depth * w);
                        if (target < data[k]) data[k] = target;
                    }
                }
            }
        }
    }
    return finalize(t.cols, t.rows, data, t.seaLevelM);
}

// -------------------------------------------------------------------------------------------------
// Contours: marching squares + segment chaining
// -------------------------------------------------------------------------------------------------

/** A round contour interval giving roughly `targetLines` levels over the land's relief. */
export function niceContourInterval(minM: number, maxM: number, targetLines = 16): number {
    const span = Math.max(1, maxM - Math.min(minM, 0));
    const raw = span / targetLines;
    const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
    for (const s of steps) if (s >= raw) return s;
    return 1000;
}

/**
 * Isolines of `level` across the grid as connected polylines (in world km). Each grid cell is
 * classified by which corners are above the level; crossing points are interpolated along cell
 * edges and segments sharing an edge are chained, so every line is one continuous polyline
 * (closed around hills, open where it leaves the map).
 */
export function traceIsolines(
    t: TerrainGrid,
    meta: Pick<WorldMetadata, "worldWidthKm" | "worldHeightKm">,
    level: number
): Array<{ points: [number, number][]; closed: boolean }> {
    const { cols, rows, data } = t;
    const lv = level + 1e-4; // never exactly on a vertex
    const halfW = meta.worldWidthKm / 2;
    const halfH = meta.worldHeightKm / 2;
    const sx = meta.worldWidthKm / (cols - 1);
    const sy = meta.worldHeightKm / (rows - 1);
    const hBase = 0;
    const vBase = rows * cols;
    // Edge ids: horizontal edge (r, c)-(r, c+1) = r*cols + c; vertical edge (r, c)-(r+1, c) = vBase + r*cols + c.
    const edgePoint = (e: number): [number, number] => {
        if (e < vBase) {
            const r = Math.floor(e / cols);
            const c = e - r * cols;
            const a = data[r * cols + c];
            const b = data[r * cols + c + 1];
            const f = (lv - a) / (b - a);
            return [-halfW + (c + f) * sx, halfH - r * sy];
        }
        const k = e - vBase;
        const r = Math.floor(k / cols);
        const c = k - r * cols;
        const a = data[r * cols + c];
        const b = data[(r + 1) * cols + c];
        const f = (lv - a) / (b - a);
        return [-halfW + c * sx, halfH - (r + f) * sy];
    };

    const segA: number[] = [];
    const segB: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < cols - 1; c++) {
            const tl = data[r * cols + c] > lv ? 1 : 0;
            const tr = data[r * cols + c + 1] > lv ? 1 : 0;
            const br = data[(r + 1) * cols + c + 1] > lv ? 1 : 0;
            const bl = data[(r + 1) * cols + c] > lv ? 1 : 0;
            const idx = (tl << 3) | (tr << 2) | (br << 1) | bl;
            if (idx === 0 || idx === 15) continue;
            const top = hBase + r * cols + c;
            const bottom = hBase + (r + 1) * cols + c;
            const left = vBase + r * cols + c;
            const right = vBase + r * cols + c + 1;
            const add = (a: number, b: number) => {
                segA.push(a);
                segB.push(b);
            };
            switch (idx) {
                case 1: case 14: add(left, bottom); break;
                case 2: case 13: add(bottom, right); break;
                case 3: case 12: add(left, right); break;
                case 4: case 11: add(top, right); break;
                case 6: case 9: add(top, bottom); break;
                case 7: case 8: add(left, top); break;
                case 5: case 10: {
                    // Saddle: the cell center decides which diagonal pair is connected.
                    const center = (data[r * cols + c] + data[r * cols + c + 1] + data[(r + 1) * cols + c] + data[(r + 1) * cols + c + 1]) / 4 > lv;
                    if ((idx === 5) === center) {
                        add(left, top);
                        add(bottom, right);
                    } else {
                        add(left, bottom);
                        add(top, right);
                    }
                    break;
                }
            }
        }
    }

    // Chain segments that share an edge crossing.
    const byEdge = new Map<number, number[]>();
    for (let s = 0; s < segA.length; s++) {
        for (const e of [segA[s], segB[s]]) {
            const list = byEdge.get(e);
            if (list) list.push(s);
            else byEdge.set(e, [s]);
        }
    }
    const used = new Uint8Array(segA.length);
    const lines: Array<{ points: [number, number][]; closed: boolean }> = [];
    const otherEnd = (s: number, e: number) => (segA[s] === e ? segB[s] : segA[s]);
    const nextSeg = (e: number): number => {
        const list = byEdge.get(e);
        if (!list) return -1;
        for (const s of list) if (!used[s]) return s;
        return -1;
    };
    for (let s0 = 0; s0 < segA.length; s0++) {
        if (used[s0]) continue;
        used[s0] = 1;
        const forward: number[] = [segA[s0], segB[s0]];
        // Extend from the tail...
        for (;;) {
            const tail = forward[forward.length - 1];
            const s = nextSeg(tail);
            if (s < 0) break;
            used[s] = 1;
            forward.push(otherEnd(s, tail));
        }
        // ...and from the head.
        const backward: number[] = [];
        let head = forward[0];
        for (;;) {
            const s = nextSeg(head);
            if (s < 0) break;
            used[s] = 1;
            head = otherEnd(s, head);
            backward.push(head);
        }
        const edges = backward.reverse().concat(forward);
        const closed = edges.length > 3 && edges[0] === edges[edges.length - 1];
        lines.push({ points: edges.map(edgePoint).map(roundPt), closed });
    }
    return lines;
}

/** Hypsometric color for an elevation (meters above sea level), as RGBA 0..1. */
export function hypsometricColor(elevationM: number, seaLevelM = 0, maxM = 2600): [number, number, number, number] {
    const e = elevationM - seaLevelM;
    if (e < 0) {
        const d = Math.min(1, -e / 600);
        return [0.16 - d * 0.1, 0.42 - d * 0.22, 0.6 - d * 0.18, 1];
    }
    const stops: Array<[number, [number, number, number]]> = [
        [0.0, [0.78, 0.74, 0.55]],
        [0.03, [0.42, 0.62, 0.36]],
        [0.18, [0.27, 0.5, 0.27]],
        [0.38, [0.6, 0.6, 0.36]],
        [0.58, [0.62, 0.47, 0.32]],
        [0.78, [0.55, 0.5, 0.48]],
        [1.0, [0.95, 0.96, 0.98]],
    ];
    const n = Math.min(1, e / Math.max(1, maxM));
    for (let i = 0; i < stops.length - 1; i++) {
        const [a, ca] = stops[i];
        const [b, cb] = stops[i + 1];
        if (n <= b) {
            const f = (n - a) / (b - a);
            return [ca[0] + (cb[0] - ca[0]) * f, ca[1] + (cb[1] - ca[1]) * f, ca[2] + (cb[2] - ca[2]) * f, 1];
        }
    }
    return [0.95, 0.96, 0.98, 1];
}

/**
 * Contour lines of the whole terrain at `intervalM` (auto when omitted), one `ContourLine` per
 * connected isoline. Lines whose level is a multiple of five intervals are index contours.
 */
export function extractTerrainContours(
    t: TerrainGrid,
    meta: Pick<WorldMetadata, "worldWidthKm" | "worldHeightKm">,
    intervalM?: number
): ContourLine[] {
    const { min, max } = terrainStats(t.data);
    const interval = intervalM ?? niceContourInterval(t.seaLevelM, max);
    const out: ContourLine[] = [];
    const start = Math.ceil((Math.max(min, t.seaLevelM - 1000) - t.seaLevelM) / interval) * interval + t.seaLevelM;
    for (let level = start; level <= max; level += interval) {
        if (level < t.seaLevelM && (t.seaLevelM - level) % (interval * 5) !== 0) continue; // sparse bathymetry
        const [r, g, b] = hypsometricColor(level, t.seaLevelM, max);
        const isIndex = Math.round((level - t.seaLevelM) / interval) % 5 === 0;
        for (const line of traceIsolines(t, meta, level)) {
            if (line.points.length < 3) continue;
            out.push({ elevation: level, points: line.points, color: [r * 0.6, g * 0.6, b * 0.6, isIndex ? 0.9 : 0.55] });
        }
    }
    return out;
}

/**
 * Default terrain for a world that has none (a preset, an older save): generated from the world's
 * seed and fitted to its spots' elevations so the authored map and the ground agree.
 */
export function terrainForWorld(
    meta: WorldMetadata,
    spots: Array<Pick<WorldSpot, "x" | "y" | "elevation">>,
    opts: Partial<TerrainConfig> = {},
    rivers: Array<{ points: [number, number][] }> = []
): TerrainGrid {
    const peak = Math.max(800, ...spots.map((s) => s.elevation * 1.25));
    const base = generateTerrain({
        widthKm: meta.worldWidthKm,
        heightKm: meta.worldHeightKm,
        resolution: 129,
        seed: meta.seed,
        mountainScale: Math.min(4500, peak),
        seaLevelM: meta.seaLevelM,
        islandMask: meta.genre === "fantasy",
        ...opts,
    });
    // A light erosion pass gives valleys and drainage before the spots pin their elevations.
    const eroded = erodeTerrain(base, { droplets: 14000, seed: meta.seed });
    // Rivers the world already has get valleys to run in.
    const carved = rivers.length ? carveRivers(eroded, meta, rivers, 25) : eroded;
    return fitTerrainToSpots(carved, meta, spots);
}

/**
 * The heightfield at a new resolution, sampled with Catmull-Rom (bicubic) interpolation so finer
 * grids stay smooth rather than faceted. Going finer adds room for detail (sculpting, roads, town
 * pads); going coarser keeps the save and the map lighter.
 */
export function resampleTerrain(t: TerrainGrid, cols: number, rows: number = cols): TerrainGrid {
    cols = Math.max(2, Math.round(cols));
    rows = Math.max(2, Math.round(rows));
    const { data } = t;
    const at = (c: number, r: number) => data[Math.max(0, Math.min(t.rows - 1, r)) * t.cols + Math.max(0, Math.min(t.cols - 1, c))];
    const cr = (p0: number, p1: number, p2: number, p3: number, f: number) =>
        p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
    const out = new Array<number>(cols * rows);
    for (let r = 0; r < rows; r++) {
        const gy = (r / (rows - 1)) * (t.rows - 1);
        const r1 = Math.floor(gy);
        const fy = gy - r1;
        for (let c = 0; c < cols; c++) {
            const gx = (c / (cols - 1)) * (t.cols - 1);
            const c1 = Math.floor(gx);
            const fx = gx - c1;
            const row = (rr: number) => cr(at(c1 - 1, rr), at(c1, rr), at(c1 + 1, rr), at(c1 + 2, rr), fx);
            const v = cr(row(r1 - 1), row(r1), row(r1 + 1), row(r1 + 2), fy);
            out[r * cols + c] = Math.round(v * 100) / 100;
        }
    }
    const { min, max } = terrainStats(out);
    return { cols, rows, data: out, seaLevelM: t.seaLevelM, minM: min, maxM: max };
}
