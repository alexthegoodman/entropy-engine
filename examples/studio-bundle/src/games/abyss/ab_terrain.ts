// The Abyss's terrain as meshes: the map in 16 x 16 chunks, each at four levels of detail, and a
// coarse ring of land out to the horizon.
//
// A chunk is 64 grid cells (200 m) square. Level k samples every 2^k-th grid vertex: 8192, 2048,
// 512 or 128 triangles. The level comes from the camera's distance to the chunk (`chooseLods`),
// and the nearest chunks always draw at full detail. Neighbors at different levels would leave
// cracks along their shared edge - deep ones down a 540 m cliff - so every chunk hangs a skirt
// from its edges, down to the lowest grid vertex along each edge segment: whatever level the
// neighbor draws, its edge lies between those heights, so the skirt closes the gap.
//
// Vertices use the engine's `mesh` layout (12 floats): position; the normal times 1 + the terrain
// pattern id (ab_shader.ts reads the pattern from its length, as Mesha's viewport shader does);
// uv = (blast scorch, riverbed); color = (paved, cliff strata seed, 0, 1).

import { HeightGrid, GRID, CELL, MAP_HALF, groundMask, outerHeight, clamp } from "./ab_world";

/** The canyon beyond the map's west edge, drawn finer than the horizon ring (x from its far end to the map). */
export const CANYON_FAR_X = -7000;
export const CANYON_HALF_Z = 1400;

export const CHUNK_CELLS = 64;
export const CHUNKS = GRID / CHUNK_CELLS;
export const CHUNK_SIZE = CHUNK_CELLS * CELL;
export const LODS = 4;
/** Pattern id of the terrain in ab_shader.ts. */
export const TERRAIN_PATTERN = 30;
/** Pattern id of the far ring (same shading, no masks). */
export const OUTER_PATTERN = 31;

export interface TerrainMesh {
    vertexData: Float32Array;
    indexData: Uint32Array;
    /** Bounding sphere: x, y, z, radius. */
    bounds: [number, number, number, number];
    triangles: number;
}

/** Masks (scorch, riverbed, paved) baked at twice the height grid's spacing. */
export class MaskGrid {
    static readonly RES = GRID / 2;
    readonly n = MaskGrid.RES + 1;
    readonly scorch = new Float32Array(this.n * this.n);
    readonly river = new Float32Array(this.n * this.n);
    readonly paved = new Float32Array(this.n * this.n);
    private row = 0;
    get done(): boolean { return this.row >= this.n; }
    get progress(): number { return this.row / this.n; }
    bake(rows = Infinity): boolean {
        const end = Math.min(this.n, this.row + rows);
        const step = (MAP_HALF * 2) / MaskGrid.RES;
        for (let j = this.row; j < end; j++) for (let i = 0; i < this.n; i++) {
            const m = groundMask(-MAP_HALF + i * step, -MAP_HALF + j * step);
            const t = j * this.n + i;
            this.scorch[t] = m.scorch; this.river[t] = m.river; this.paved[t] = m.paved;
        }
        this.row = end;
        return this.done;
    }
    /** Bilinear sample of one mask at (x, z). */
    sample(mask: Float32Array, x: number, z: number): number {
        const g = ((x + MAP_HALF) / (MAP_HALF * 2)) * MaskGrid.RES, h = ((z + MAP_HALF) / (MAP_HALF * 2)) * MaskGrid.RES;
        const i = clamp(Math.floor(g), 0, MaskGrid.RES - 1), j = clamp(Math.floor(h), 0, MaskGrid.RES - 1);
        const fx = clamp(g - i, 0, 1), fz = clamp(h - j, 0, 1), n = this.n;
        const a = mask[j * n + i], b = mask[j * n + i + 1], c = mask[(j + 1) * n + i], d = mask[(j + 1) * n + i + 1];
        return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
    }
}

/** Grid normal at vertex (i, j) from its neighbors `s` vertices away. */
function gridNormal(g: HeightGrid, i: number, j: number, s: number): [number, number, number] {
    const dx = g.at(i + s, j) - g.at(i - s, j);
    const dz = g.at(i, j + s) - g.at(i, j - s);
    const nx = -dx, ny = 2 * s * CELL, nz = -dz;
    const l = Math.hypot(nx, ny, nz);
    return [nx / l, ny / l, nz / l];
}

/** A hash-ish seed per position for the cliff shader (strata offset). */
const strataSeed = (x: number, z: number): number => {
    const v = Math.sin(x * 0.0123 + z * 0.0071) * 43758.5453;
    return v - Math.floor(v);
};

/** Builds chunk (ci, cj) at level `lod`. */
export function buildChunk(g: HeightGrid, masks: MaskGrid | null, ci: number, cj: number, lod: number): TerrainMesh {
    const step = 1 << lod;
    const n = CHUNK_CELLS / step;
    const i0 = ci * CHUNK_CELLS, j0 = cj * CHUNK_CELLS;
    // Interior vertices, then four skirts of (n + 1) vertices each.
    const vcount = (n + 1) * (n + 1) + 4 * (n + 1);
    const v = new Float32Array(vcount * 12);
    const idx: number[] = [];
    const scale = 1 + TERRAIN_PATTERN;
    let lo = Infinity, hi = -Infinity;
    const put = (k: number, x: number, y: number, z: number, nrm: [number, number, number]) => {
        const o = k * 12;
        v[o] = x; v[o + 1] = y; v[o + 2] = z;
        v[o + 3] = nrm[0] * scale; v[o + 4] = nrm[1] * scale; v[o + 5] = nrm[2] * scale;
        v[o + 6] = masks ? masks.sample(masks.scorch, x, z) : 0;
        v[o + 7] = masks ? masks.sample(masks.river, x, z) : 0;
        v[o + 8] = masks ? masks.sample(masks.paved, x, z) : 0;
        v[o + 9] = strataSeed(x, z); v[o + 10] = 0; v[o + 11] = 1;
        if (y < lo) lo = y;
        if (y > hi) hi = y;
    };
    for (let b = 0; b <= n; b++) for (let a = 0; a <= n; a++) {
        const gi = i0 + a * step, gj = j0 + b * step;
        put(b * (n + 1) + a, -MAP_HALF + gi * CELL, g.at(gi, gj), -MAP_HALF + gj * CELL, gridNormal(g, gi, gj, 1));
    }
    for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) {
        const p = b * (n + 1) + a, q = p + 1, r = p + n + 1, s = r + 1;
        // The same diagonal as HeightGrid.height (from q to r); counter-clockwise seen from above.
        idx.push(p, r, q, q, r, s);
    }
    // Skirts: north (b = n), south (b = 0), west (a = 0), east (a = n). Each hangs to the lowest
    // full-resolution vertex along the segments it touches.
    const interior = (n + 1) * (n + 1);
    const edges: { at: (k: number) => [number, number] }[] = [
        { at: k => [k, 0] },
        { at: k => [k, n] },
        { at: k => [0, k] },
        { at: k => [n, k] },
    ];
    edges.forEach((e, ei) => {
        const base = interior + ei * (n + 1);
        for (let k = 0; k <= n; k++) {
            const [a, b] = e.at(k);
            const top = b * (n + 1) + a;
            const gi = i0 + a * step, gj = j0 + b * step;
            // Lowest fine vertex within one segment either side along this edge.
            let low = Infinity;
            for (let t = -step; t <= step; t++) {
                const fi = ei < 2 ? gi + t : gi, fj = ei < 2 ? gj : gj + t;
                low = Math.min(low, g.at(fi, fj));
            }
            const o = top * 12;
            const nrm: [number, number, number] = [v[o + 3] / scale, v[o + 4] / scale, v[o + 5] / scale];
            put(base + k, v[o], low - 1.5 - step * 0.5, v[o + 2], nrm);
        }
        for (let k = 0; k < n; k++) {
            const [a0, b0] = e.at(k), [a1, b1] = e.at(k + 1);
            const t0 = b0 * (n + 1) + a0, t1 = b1 * (n + 1) + a1, s0 = base + k, s1 = base + k + 1;
            // Both windings: a skirt is seen from whichever side the gap opens toward.
            idx.push(t0, t1, s0, t1, s1, s0, t0, s0, t1, t1, s0, s1);
        }
    });
    const cx = -MAP_HALF + (i0 + CHUNK_CELLS / 2) * CELL, cz = -MAP_HALF + (j0 + CHUNK_CELLS / 2) * CELL;
    const cy = (lo + hi) / 2;
    const radius = Math.hypot(CHUNK_SIZE / 2, CHUNK_SIZE / 2, (hi - lo) / 2) + 2;
    return { vertexData: v, indexData: Uint32Array.from(idx), bounds: [cx, cy, cz, radius], triangles: idx.length / 3 };
}

/** Triangles a chunk draws at each level (interior and skirts). */
export const chunkTriangles = (lod: number): number => {
    const n = CHUNK_CELLS >> lod;
    return 2 * n * n + 16 * n;
};

/** Distance from (x, z) to chunk (ci, cj)'s square (0 inside it). */
export function chunkDistance(ci: number, cj: number, x: number, z: number): number {
    const x0 = -MAP_HALF + ci * CHUNK_SIZE, z0 = -MAP_HALF + cj * CHUNK_SIZE;
    const dx = Math.max(x0 - x, 0, x - (x0 + CHUNK_SIZE));
    const dz = Math.max(z0 - z, 0, z - (z0 + CHUNK_SIZE));
    return Math.hypot(dx, dz);
}

/** Distances (m) beyond which a chunk drops to the next level. `detail` scales them all. */
export const LOD_RANGES = [260, 620, 1300];

/** The level each chunk draws at for a camera at (x, y, z): by distance in 3D (height counts). */
export function chooseLods(x: number, y: number, z: number, groundY: number, detail = 1): Uint8Array {
    const out = new Uint8Array(CHUNKS * CHUNKS);
    const up = Math.max(0, y - groundY) * 0.6;
    for (let cj = 0; cj < CHUNKS; cj++) for (let ci = 0; ci < CHUNKS; ci++) {
        const d = Math.hypot(chunkDistance(ci, cj, x, z), up) / Math.max(0.2, detail);
        out[cj * CHUNKS + ci] = d < LOD_RANGES[0] ? 0 : d < LOD_RANGES[1] ? 1 : d < LOD_RANGES[2] ? 2 : 3;
    }
    return out;
}

// --- The ring beyond the map ----------------------------------------------------------------------

export const OUTER_EXTENT = 14000;
export const OUTER_CELL = 200;

/** The land around the map out to the horizon, coarse, with a skirt along its inner edge. */
export function buildOuterRing(): TerrainMesh {
    const n = (OUTER_EXTENT * 2) / OUTER_CELL;
    const v: number[] = [];
    const idx: number[] = [];
    const scale = 1 + OUTER_PATTERN;
    const index = new Map<number, number>();
    const vertex = (i: number, j: number): number => {
        const key = j * (n + 1) + i;
        let k = index.get(key);
        if (k !== undefined) return k;
        const x = -OUTER_EXTENT + i * OUTER_CELL, z = -OUTER_EXTENT + j * OUTER_CELL;
        const y = outerHeight(x, z);
        const e = OUTER_CELL;
        const nx = -(outerHeight(x + e, z) - outerHeight(x - e, z)), nz = -(outerHeight(x, z + e) - outerHeight(x, z - e)), ny = 2 * e;
        const l = Math.hypot(nx, ny, nz);
        k = v.length / 12;
        v.push(x, y, z, (nx / l) * scale, (ny / l) * scale, (nz / l) * scale, 0.35, 0, 0, strataSeed(x, z), 0, 1);
        index.set(key, k);
        return k;
    };
    const inside = (i: number, j: number) => {
        const x0 = -OUTER_EXTENT + i * OUTER_CELL, z0 = -OUTER_EXTENT + j * OUTER_CELL;
        const map = x0 >= -MAP_HALF && x0 + OUTER_CELL <= MAP_HALF && z0 >= -MAP_HALF && z0 + OUTER_CELL <= MAP_HALF;
        // The far canyon has a mesh of its own (buildCanyon).
        const canyon = x0 >= CANYON_FAR_X && x0 + OUTER_CELL <= -MAP_HALF && z0 >= -CANYON_HALF_Z && z0 + OUTER_CELL <= CANYON_HALF_Z;
        return map || canyon;
    };
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        if (inside(i, j)) continue;
        const p = vertex(i, j), q = vertex(i + 1, j), r = vertex(i, j + 1), s = vertex(i + 1, j + 1);
        idx.push(p, r, q, q, r, s);
    }
    // A skirt hanging inside the map's edge, under the chunks, so the seam never shows sky.
    const ring: [number, number][] = [];
    const m = (MAP_HALF * 2) / OUTER_CELL;
    const i0 = (OUTER_EXTENT - MAP_HALF) / OUTER_CELL;
    for (let k = 0; k < m; k++) ring.push([i0 + k, i0]);
    for (let k = 0; k < m; k++) ring.push([i0 + m, i0 + k]);
    for (let k = 0; k < m; k++) ring.push([i0 + m - k, i0 + m]);
    for (let k = 0; k < m; k++) ring.push([i0, i0 + m - k]);
    const first = v.length / 12;
    for (const [i, j] of ring) {
        const top = vertex(i, j);
        v.push(v[top * 12], v[top * 12 + 1] - 40, v[top * 12 + 2], 0, scale, 0, 0.35, 0, 0, 0, 0, 1);
    }
    for (let k = 0; k < ring.length; k++) {
        const t0 = vertex(ring[k][0], ring[k][1]), t1 = vertex(ring[(k + 1) % ring.length][0], ring[(k + 1) % ring.length][1]);
        const s0 = first + k, s1 = first + ((k + 1) % ring.length);
        idx.push(t0, s0, t1, t1, s0, s1, t0, t1, s0, t1, s1, s0);
    }
    return { vertexData: Float32Array.from(v), indexData: Uint32Array.from(idx), bounds: [0, 0, 0, OUTER_EXTENT * 1.5], triangles: idx.length / 3 };
}

/**
 * The canyon the crack becomes west of the map, out to CANYON_FAR_X: columns that widen with the
 * distance from the map (20 m at its edge, 160 m far out), rows 25 m apart, the map's own masks
 * (scorch, the dry river), and a skirt round its border so no seam shows sky.
 */
export function buildCanyon(): TerrainMesh {
    const xs: number[] = [];
    for (let x = -MAP_HALF, step = 20; x > CANYON_FAR_X; x -= step, step = Math.min(160, step * 1.045)) xs.push(x);
    xs.push(CANYON_FAR_X);
    const zs: number[] = [];
    for (let z = -CANYON_HALF_Z; z <= CANYON_HALF_Z; z += 25) zs.push(z);
    const nx = xs.length, nz = zs.length;
    const v = new Float32Array((nx * nz + 2 * (nx + nz)) * 12);
    const idx: number[] = [];
    const scale = 1 + TERRAIN_PATTERN;
    const put = (k: number, x: number, z: number, drop = 0) => {
        const y = outerHeight(x, z) - drop;
        const e = 6;
        const ddx = outerHeight(x + e, z) - outerHeight(x - e, z), ddz = outerHeight(x, z + e) - outerHeight(x, z - e);
        const l = Math.hypot(ddx, 2 * e, ddz);
        const m = groundMask(x, z);
        const o = k * 12;
        v[o] = x; v[o + 1] = y; v[o + 2] = z;
        v[o + 3] = (-ddx / l) * scale; v[o + 4] = (2 * e / l) * scale; v[o + 5] = (-ddz / l) * scale;
        v[o + 6] = m.scorch; v[o + 7] = m.river; v[o + 8] = 0;
        v[o + 9] = strataSeed(x, z); v[o + 10] = 0; v[o + 11] = 1;
    };
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) put(j * nx + i, xs[i], zs[j]);
    for (let j = 0; j + 1 < nz; j++) for (let i = 0; i + 1 < nx; i++) {
        // x decreases with i: wind so the faces point up.
        const p = j * nx + i, q = p + 1, r = p + nx, t = r + 1;
        idx.push(p, q, r, q, t, r);
    }
    // The skirt: the border's vertices again, hung 60 m lower, faces both ways.
    const border: number[] = [];
    for (let i = 0; i < nx; i++) border.push(i);
    for (let j = 1; j < nz; j++) border.push(j * nx + nx - 1);
    for (let i = nx - 2; i >= 0; i--) border.push((nz - 1) * nx + i);
    for (let j = nz - 2; j > 0; j--) border.push(j * nx);
    const base = nx * nz;
    border.forEach((b, k) => put(base + k, v[b * 12], v[b * 12 + 2], 60));
    for (let k = 0; k < border.length; k++) {
        const a = border[k], b = border[(k + 1) % border.length], sa = base + k, sb = base + (k + 1) % border.length;
        idx.push(a, b, sa, b, sb, sa, a, sa, b, b, sa, sb);
    }
    const used = base + border.length;
    return { vertexData: v.subarray(0, used * 12), indexData: Uint32Array.from(idx), bounds: [(CANYON_FAR_X - MAP_HALF) / 2, -300, 0, Math.hypot((MAP_HALF - CANYON_FAR_X) / 2, CANYON_HALF_Z, 400)], triangles: idx.length / 3 };
}
