// Live physics hooks. A generator that makes something that should keep moving in the viewport
// (cloth, hair) registers a DynamicSource against the part it produced; the viewport finds it by
// that part's vertex array, spawns its own simulator per placed instance, and each frame writes the
// simulator's positions and normals over the region's vertices. The evaluated mesh is the source's
// rest state, so everything else (export, contact sheets, tests) sees the settled shape.

import type { Mat4, Part } from "./mesha_mesh";

export interface Simulator {
    /** Vertices it writes: the whole region, in the part's order. */
    readonly vertexCount: number;
    /** Local-space positions and unit normals after the last step. */
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    /**
     * Advances `dt` seconds. `frame` is the instance's world-from-local matrix this frame: when it
     * moves, the simulator keeps its free particles where they were in the world, so they swing.
     * `wind` is a world-space air velocity (m/s). Returns false once settled and nothing moves.
     */
    step(dt: number, frame: Mat4, wind: [number, number, number]): boolean;
}

export interface DynamicSource {
    /** What it is, for status text ("hair", "cloth"). */
    kind: string;
    spawn(): Simulator;
}

const sources = new WeakMap<number[], DynamicSource>();

export function attachDynamic(part: Part, source: DynamicSource): void {
    sources.set(part.positions, source);
}

/** The source behind a part, if a generator registered one (survives region changes and joins). */
export function dynamicOf(part: Part): DynamicSource | undefined {
    return sources.get(part.positions);
}

// --- Frame helpers -------------------------------------------------------------------------------

/** Inverse of a rigid-plus-uniform-scale column-major matrix. */
export function invertFrame(m: Mat4): Mat4 {
    const s2 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] || 1;
    // Rotation * scale: the inverse is the transpose over scale squared.
    const r = [m[0] / s2, m[4] / s2, m[8] / s2, m[1] / s2, m[5] / s2, m[9] / s2, m[2] / s2, m[6] / s2, m[10] / s2];
    const tx = -(r[0] * m[12] + r[3] * m[13] + r[6] * m[14]);
    const ty = -(r[1] * m[12] + r[4] * m[13] + r[7] * m[14]);
    const tz = -(r[2] * m[12] + r[5] * m[13] + r[8] * m[14]);
    return [r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, tx, ty, tz, 1];
}

export function mulFrame(a: Mat4, b: Mat4): Mat4 {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
}

/** Applies a column-major matrix to points in place (xyz triples). */
export function applyFrame(m: Mat4, xs: Float64Array | Float32Array, mask?: Uint8Array): void {
    for (let i = 0, v = 0; i < xs.length; i += 3, v++) {
        if (mask && !mask[v]) continue;
        const x = xs[i], y = xs[i + 1], z = xs[i + 2];
        xs[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
        xs[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        xs[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
}

/** World direction into local (rotation and scale only). */
export function localDirection(inv: Mat4, d: [number, number, number]): [number, number, number] {
    return [inv[0] * d[0] + inv[4] * d[1] + inv[8] * d[2], inv[1] * d[0] + inv[5] * d[1] + inv[9] * d[2], inv[2] * d[0] + inv[6] * d[1] + inv[10] * d[2]];
}

export function sameFrame(a: Mat4 | null, b: Mat4): boolean {
    if (!a) return false;
    for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > 1e-7) return false;
    return true;
}

/**
 * Adds to `shift` how far each free particle must move in its figure's frame to stay put in the
 * world (`moved` minus `x`), scaled down so none lags more than `maxLag` this frame: a drag swings
 * hair and cloth, while a sudden jump (a typed rotation, an undo) carries them along instead of
 * sweeping the body through them.
 */
export function addLag(shift: Float64Array, moved: Float64Array, x: Float64Array, free: (particle: number) => boolean, maxLag: number): void {
    let most = 0;
    for (let i = 0; i < x.length; i += 3) {
        if (!free(i / 3)) continue;
        const d = Math.sqrt((moved[i] - x[i]) ** 2 + (moved[i + 1] - x[i + 1]) ** 2 + (moved[i + 2] - x[i + 2]) ** 2);
        if (d > most) most = d;
    }
    const k = most > maxLag ? maxLag / most : 1;
    for (let i = 0; i < x.length; i++) if (free((i / 3) | 0)) shift[i] += (moved[i] - x[i]) * k;
}
