// Mesha's clothing: garments cut to fit the figure, then draped by physics.
//
// A garment starts as a volume built from the body's own pieces (the torso, an arm, a leg) eased
// outward, each piece cut by its own hem plane (a sleeve at the elbow, trousers at the ankle, the
// neckline), plus extra panels where cloth leaves the body (a skirt's cone). The outside of that
// volume is meshed and the cut faces thrown away, which leaves an open shell with real hems: the
// garment as it would sit on a dress form. A small-step XPBD solver (Macklin et al. 2019) then lets
// it hang: stiff stretch along every edge with a fit factor for ease, soft bending across every
// edge, gravity, air drag and wind, and friction against the body's distance field. Loose cloth
// sags into folds at the waist, a flared skirt buckles into flutes, a long sleeve breaks above the
// wrist. The settled shell is given a thickness so hems read, and the solver keeps running in the
// viewport so clothes swing when the figure is moved and stir in the wind.

import { type Mesh, type Vec3, type Part, newPart } from "./mesha_mesh";
import { type SdfNode, type Field, type Box, LazyGrid, union, offset, intersect, custom, roundCone, meshField, fieldOf, ellipsoid, subtract } from "./mesha_sdf";
import type { FigureHandle, BoneName, SegmentName } from "./mesha_figure";
import { type Simulator, type DynamicSource, attachDynamic, invertFrame, mulFrame, applyFrame, localDirection, sameFrame, addLag } from "./mesha_dynamics";
import type { Mat4 } from "./mesha_mesh";
import { hash01 } from "./mesha_noise";

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: Vec3): Vec3 => { const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// --- The solver ----------------------------------------------------------------------------------

export interface ClothOptions {
    /** Rest length over the shell's own edge length: below 1 hugs the body, above 1 hangs looser. */
    fit: number;
    /** Bending compliance: small for stiff denim, larger for silk. */
    bend: number;
    /** Distance the cloth keeps from what it rests on (m). */
    thickness: number;
    friction: number;
    /** Velocity damping per second. */
    damping: number;
    /** Air drag on the cloth's faces (wind pushes through it). */
    drag: number;
}

export interface Collider {
    /** Signed distance in the cloth's local frame; `grad` receives the gradient. */
    sample(x: number, y: number, z: number, grad: number[]): number;
}

/** A triangle mesh of particles under distance and bending constraints, colliding with a field. */
export class ClothSolver {
    readonly n: number;
    readonly x: Float64Array;
    readonly prev: Float64Array;
    readonly w: Float64Array;
    readonly tris: Uint32Array;
    readonly normals: Float64Array;
    private cons: Uint32Array; // pairs
    private rest: Float64Array;
    private comp: Float64Array;
    private grad = [0, 0, 0];
    /** World-from-local of the last frame (null until the viewport first steps it). */
    private frame: Mat4 | null = null;
    private sleep = 0;

    constructor(positions: ArrayLike<number>, tris: ArrayLike<number>, pinned: Uint8Array, private o: ClothOptions, private collider: Collider) {
        this.n = positions.length / 3;
        this.x = Float64Array.from(positions);
        this.prev = Float64Array.from(positions);
        this.w = new Float64Array(this.n).map((_, i) => (pinned[i] ? 0 : 1));
        this.tris = Uint32Array.from(tris);
        this.normals = new Float64Array(this.n * 3);
        // Stretch along every edge, bending across every interior edge (the two opposite corners).
        const edges = new Map<number, number[]>();
        const key = (a: number, b: number) => (a < b ? a * this.n + b : b * this.n + a);
        for (let t = 0; t < this.tris.length; t += 3) {
            for (let k = 0; k < 3; k++) {
                const a = this.tris[t + k], b = this.tris[t + ((k + 1) % 3)], c = this.tris[t + ((k + 2) % 3)];
                const kk = key(a, b);
                const e = edges.get(kk);
                if (e) e.push(c); else edges.set(kk, [a, b, c]);
            }
        }
        const pairs: number[] = [], rest: number[] = [], comp: number[] = [];
        const len = (a: number, b: number) => Math.sqrt((this.x[a * 3] - this.x[b * 3]) ** 2 + (this.x[a * 3 + 1] - this.x[b * 3 + 1]) ** 2 + (this.x[a * 3 + 2] - this.x[b * 3 + 2]) ** 2);
        for (const e of edges.values()) {
            pairs.push(e[0], e[1]); rest.push(len(e[0], e[1]) * o.fit); comp.push(1e-8);
        }
        for (const e of edges.values()) {
            if (e.length < 4) continue;
            pairs.push(e[2], e[3]); rest.push(len(e[2], e[3]) * o.fit); comp.push(o.bend);
        }
        // Shuffle so Gauss-Seidel sweeps carry no directional bias.
        const order = pairs.map((_, i) => i).filter(i => i % 2 === 0).map(i => i / 2);
        for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(hash01(i, 17, 3) * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
        this.cons = new Uint32Array(order.length * 2);
        this.rest = new Float64Array(order.length);
        this.comp = new Float64Array(order.length);
        order.forEach((c, i) => { this.cons[i * 2] = pairs[c * 2]; this.cons[i * 2 + 1] = pairs[c * 2 + 1]; this.rest[i] = rest[c]; this.comp[i] = comp[c]; });
        this.computeNormals();
    }

    /** Boundary loops of the shell (each a list of vertex ids in order). */
    boundaryLoops(): number[][] {
        const count = new Map<number, number>();
        const next = new Map<number, number>();
        const key = (a: number, b: number) => (a < b ? a * this.n + b : b * this.n + a);
        for (let t = 0; t < this.tris.length; t += 3) for (let k = 0; k < 3; k++) {
            const kk = key(this.tris[t + k], this.tris[t + ((k + 1) % 3)]);
            count.set(kk, (count.get(kk) ?? 0) + 1);
        }
        for (let t = 0; t < this.tris.length; t += 3) for (let k = 0; k < 3; k++) {
            const a = this.tris[t + k], b = this.tris[t + ((k + 1) % 3)];
            if (count.get(key(a, b)) === 1) next.set(a, b);
        }
        const loops: number[][] = [];
        const seen = new Set<number>();
        for (const start of next.keys()) {
            if (seen.has(start)) continue;
            const loop: number[] = [];
            let v: number | undefined = start;
            while (v !== undefined && !seen.has(v)) { seen.add(v); loop.push(v); v = next.get(v); }
            if (loop.length > 2) loops.push(loop);
        }
        return loops;
    }

    private tetherOf: Int32Array | null = null;
    private tetherLen: Float64Array | null = null;

    /**
     * Long-range attachments (Kim et al. 2012): every free particle may stray no farther from its
     * nearest anchor than it starts, times `slack`, so heavy cloth hangs from what holds it up
     * instead of stretching the cloth above it.
     */
    tether(anchors: number[], slack = 1.04): void {
        if (!anchors.length) return;
        const X = this.x;
        this.tetherOf = new Int32Array(this.n).fill(-1);
        this.tetherLen = new Float64Array(this.n);
        for (let i = 0; i < this.n; i++) {
            if (this.w[i] === 0) continue;
            let best = -1, bd = Infinity;
            for (const a of anchors) {
                const d = (X[i * 3] - X[a * 3]) ** 2 + (X[i * 3 + 1] - X[a * 3 + 1]) ** 2 + (X[i * 3 + 2] - X[a * 3 + 2]) ** 2;
                if (d < bd) { bd = d; best = a; }
            }
            this.tetherOf[i] = best;
            this.tetherLen[i] = Math.sqrt(bd) * slack;
        }
    }

    private memory: Float64Array | null = null;
    private memoryRate = 0;

    /**
     * A weak pull back toward a remembered shape (the settled drape, in the figure's frame): after a
     * swing a garment returns to how it hangs instead of staying twisted where friction caught it.
     */
    remember(shape: ArrayLike<number>, rate: number): void {
        this.memory = Float64Array.from(shape);
        this.memoryRate = rate;
    }

    /** Pins (or frees) particles. */
    pin(ids: Iterable<number>, pinned = true): void { for (const i of ids) this.w[i] = pinned ? 0 : 1; }

    /** Scales the rest lengths of constraints between two of these particles (an elastic band). */
    tighten(ids: Set<number>, factor: number): void {
        for (let c = 0; c < this.rest.length; c++) if (ids.has(this.cons[c * 2]) && ids.has(this.cons[c * 2 + 1])) this.rest[c] *= factor;
    }

    computeNormals(): void {
        const N = this.normals, X = this.x, T = this.tris;
        N.fill(0);
        for (let t = 0; t < T.length; t += 3) {
            const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
            const ux = X[b] - X[a], uy = X[b + 1] - X[a + 1], uz = X[b + 2] - X[a + 2];
            const vx = X[c] - X[a], vy = X[c + 1] - X[a + 1], vz = X[c + 2] - X[a + 2];
            const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            for (const i of [a, b, c]) { N[i] += nx; N[i + 1] += ny; N[i + 2] += nz; }
        }
        for (let i = 0; i < N.length; i += 3) {
            const l = Math.sqrt(N[i] * N[i] + N[i + 1] * N[i + 1] + N[i + 2] * N[i + 2]) || 1;
            N[i] /= l; N[i + 1] /= l; N[i + 2] /= l;
        }
    }

    /**
     * Advances `dt` seconds in `substeps` small steps. Gravity and wind are local-frame vectors
     * (m/s^2 and m/s). Returns the largest particle speed, for settling.
     */
    simulate(dt: number, substeps: number, gravity: Vec3, wind: Vec3 = [0, 0, 0]): number {
        const h = dt / substeps, X = this.x, P = this.prev, W = this.w, N = this.normals, n = this.n;
        const C = this.cons, R = this.rest, A = this.comp, nc = R.length;
        const o = this.o, g = this.grad;
        const damp = Math.max(0, 1 - o.damping * h);
        // Air: drag toward the wind's velocity across each face, computed once per frame.
        const air = new Float64Array(n * 3);
        if (o.drag > 0) {
            for (let i = 0; i < n; i++) {
                const vx = (X[i * 3] - P[i * 3]) / h, vy = (X[i * 3 + 1] - P[i * 3 + 1]) / h, vz = (X[i * 3 + 2] - P[i * 3 + 2]) / h;
                const rel = (wind[0] - vx) * N[i * 3] + (wind[1] - vy) * N[i * 3 + 1] + (wind[2] - vz) * N[i * 3 + 2];
                air[i * 3] = o.drag * rel * N[i * 3]; air[i * 3 + 1] = o.drag * rel * N[i * 3 + 1]; air[i * 3 + 2] = o.drag * rel * N[i * 3 + 2];
            }
        }
        let vmax = 0;
        const shift = this.shift;
        this.shift = null;
        for (let s = 0; s < substeps; s++) {
            if (shift) for (let i = 0; i < n * 3; i++) { const d = shift[i] / substeps; X[i] += d; P[i] += d; }
            // Predict.
            for (let i = 0; i < n; i++) {
                if (W[i] === 0) continue;
                const k = i * 3;
                const vx = (X[k] - P[k]) * damp, vy = (X[k + 1] - P[k + 1]) * damp, vz = (X[k + 2] - P[k + 2]) * damp;
                P[k] = X[k]; P[k + 1] = X[k + 1]; P[k + 2] = X[k + 2];
                X[k] += vx + (gravity[0] + air[k]) * h * h;
                X[k + 1] += vy + (gravity[1] + air[k + 1]) * h * h;
                X[k + 2] += vz + (gravity[2] + air[k + 2]) * h * h;
            }
            // Constraints (one Gauss-Seidel sweep per small step).
            const ih2 = 1 / (h * h);
            for (let c = 0; c < nc; c++) {
                const a = C[c * 2], b = C[c * 2 + 1];
                const wa = W[a], wb = W[b], ws = wa + wb;
                if (ws === 0) continue;
                const ka = a * 3, kb = b * 3;
                const dx = X[kb] - X[ka], dy = X[kb + 1] - X[ka + 1], dz = X[kb + 2] - X[ka + 2];
                const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (L < 1e-9) continue;
                const lambda = -(L - R[c]) / (ws + A[c] * ih2) / L;
                X[ka] -= wa * lambda * dx; X[ka + 1] -= wa * lambda * dy; X[ka + 2] -= wa * lambda * dz;
                X[kb] += wb * lambda * dx; X[kb + 1] += wb * lambda * dy; X[kb + 2] += wb * lambda * dz;
            }
            // Memory of the settled hang.
            const Mm = this.memory;
            if (Mm) {
                const k = this.memoryRate;
                for (let i = 0; i < n; i++) {
                    if (W[i] === 0) continue;
                    const j = i * 3;
                    X[j] += (Mm[j] - X[j]) * k; X[j + 1] += (Mm[j + 1] - X[j + 1]) * k; X[j + 2] += (Mm[j + 2] - X[j + 2]) * k;
                }
            }
            // Tethers: only ever pull a particle back toward its anchor.
            const TO = this.tetherOf, TL = this.tetherLen;
            if (TO && TL) for (let i = 0; i < n; i++) {
                const a = TO[i];
                if (a < 0 || W[i] === 0) continue;
                const k = i * 3, ka = a * 3;
                const dx = X[k] - X[ka], dy = X[k + 1] - X[ka + 1], dz = X[k + 2] - X[ka + 2];
                const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (L <= TL[i]) continue;
                const f = (L - TL[i]) / L;
                X[k] -= dx * f; X[k + 1] -= dy * f; X[k + 2] -= dz * f;
            }
            // Collisions with friction.
            for (let i = 0; i < n; i++) {
                if (W[i] === 0) continue;
                const k = i * 3;
                // The floor.
                if (X[k + 1] < o.thickness) { X[k + 1] = o.thickness; X[k] = lerp(X[k], P[k], o.friction); X[k + 2] = lerp(X[k + 2], P[k + 2], o.friction); }
                const d = this.collider.sample(X[k], X[k + 1], X[k + 2], g);
                if (d >= o.thickness) continue;
                const gl = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]) || 1;
                const nx = g[0] / gl, ny = g[1] / gl, nz = g[2] / gl;
                const push = o.thickness - d;
                X[k] += nx * push; X[k + 1] += ny * push; X[k + 2] += nz * push;
                const mx = X[k] - P[k], my = X[k + 1] - P[k + 1], mz = X[k + 2] - P[k + 2];
                const mn = mx * nx + my * ny + mz * nz;
                const f = Math.min(1, o.friction);
                X[k] -= (mx - mn * nx) * f; X[k + 1] -= (my - mn * ny) * f; X[k + 2] -= (mz - mn * nz) * f;
            }
        }
        for (let i = 0; i < n; i++) {
            const k = i * 3;
            const v = Math.sqrt((X[k] - P[k]) ** 2 + (X[k + 1] - P[k + 1]) ** 2 + (X[k + 2] - P[k + 2]) ** 2) / h;
            if (v > vmax) vmax = v;
        }
        this.computeNormals();
        return vmax;
    }

    /**
     * Follows the instance's transform: free particles keep their world position (so the cloth
     * swings), pinned ones ride along. Large jumps (an undo, a teleport) carry everything along.
     */
    follow(frame: Mat4): boolean {
        if (!this.frame) { this.frame = frame.slice(); return false; }
        if (sameFrame(this.frame, frame)) return false;
        const jump = Math.sqrt((frame[12] - this.frame[12]) ** 2 + (frame[13] - this.frame[13]) ** 2 + (frame[14] - this.frame[14]) ** 2);
        const old = this.frame;
        this.frame = frame.slice();
        if (jump > 0.5) return true;
        // Free particles stay where they were in the world, so in the cloth's own frame they move
        // the other way; the shift is spread over the next step's substeps so the body sweeps
        // into the cloth gradually and never tunnels through it.
        const m = mulFrame(invertFrame(frame), old);
        const moved = Float64Array.from(this.x);
        applyFrame(m, moved);
        const shift = this.shift ?? (this.shift = new Float64Array(this.n * 3));
        addLag(shift, moved, this.x, i => this.w[i] > 0, MAX_LAG);
        return true;
    }
    private shift: Float64Array | null = null;
    get asleep(): boolean { return this.sleep > 30; }
    noteSpeed(v: number, moving: boolean): void { this.sleep = moving || v > 0.02 ? 0 : this.sleep + 1; }
}

// --- Garments ------------------------------------------------------------------------------------

export const TOPS = ["none", "tank", "tee", "longsleeve", "sweater", "dress"] as const;
export const BOTTOMS = ["none", "trousers", "jeans", "shorts", "skirt"] as const;
export const NECKLINES = ["crew", "vneck", "scoop"] as const;
export type TopKind = typeof TOPS[number];
export type BottomKind = typeof BOTTOMS[number];

export interface OutfitParams {
    top: TopKind;
    /** Sleeve length as a share of the arm (0 sleeveless). Ignored by tank. */
    sleeve: number;
    /** Top hem: 0 at the waist, 1 at the hip, 2 at mid-thigh (a dress's skirt length is `skirtLength`). */
    topLength: number;
    neckline: typeof NECKLINES[number];
    /** 0 tight, 1 loose. */
    topFit: number;
    bottom: BottomKind;
    /** Trousers and shorts: share of the leg covered; skirt and dress: hem height share from waist to floor. */
    bottomLength: number;
    bottomFit: number;
    /** Skirt and dress flare, 0 straight to 1 full circle. */
    flare: number;
    /** Wind during the drape (m/s), from the front-left. */
    wind: number;
    /** Mesh detail multiplier (1 normal, smaller finer). */
    detail: number;
    seed: number;
    /** Simulated settle frames (60 per second). */
    settle: number;
}

export const DEFAULT_OUTFIT: OutfitParams = {
    top: "tee", sleeve: 0.28, topLength: 1, neckline: "crew", topFit: 0.4,
    bottom: "jeans", bottomLength: 1, bottomFit: 0.3, flare: 0.4, wind: 0, detail: 1, seed: 1, settle: 40,
};

/** A piece of a garment: an eased body segment (or a panel), and where it ends (positive = cut away). */
interface Piece { node: SdfNode; keep: Field[] }

interface GarmentSpec {
    region: string;
    pieces: Piece[];
    /** Cuts through every piece (a neckline, a waistband), positive where cloth is removed. */
    cuts: Field[];
    /** Height range the cloth can occupy (meshing stops a little beyond it). */
    yRange: [number, number];
    /** Smooth-union radius joining the pieces (the armpit, the crotch). */
    blend: number;
    options: ClothOptions;
    /** The waistband (bottoms) grips the body. */
    waist?: { center: Vec3; up: Vec3 };
    /** What a garment worn over this one rests on. */
    cover: SdfNode;
    /** Tops: cloth lying on the body above this height (on the shoulders) holds the garment up. */
    shoulders?: number;
}

/** Signed distance past a plane through `p` facing `n` (positive beyond it). */
function plane(p: Vec3, n: Vec3): Field {
    const [px, py, pz] = p, [nx, ny, nz] = norm(n);
    return (x, y, z) => (x - px) * nx + (y - py) * ny + (z - pz) * nz;
}

/** A cut removing the inside of `region` (a field negative inside). */
const removeInside = (region: Field): Field => (x, y, z) => -region(x, y, z);

/** A point a share `t` along a chain of joints, and the direction there. */
function along(points: Vec3[], t: number): { p: Vec3; d: Vec3 } {
    const lens = points.slice(1).map((q, i) => Math.hypot(...sub(q, points[i])));
    const total = lens.reduce((a, b) => a + b, 0);
    let s = clamp(t, 0, 1) * total;
    for (let i = 0; i < lens.length; i++) {
        if (s <= lens[i] || i === lens.length - 1) {
            const u = lens[i] > 0 ? clamp(s / lens[i], 0, 1) : 0;
            return { p: lerp3(points[i], points[i + 1], u), d: norm(sub(points[i + 1], points[i])) };
        }
        s -= lens[i];
    }
    return { p: points[points.length - 1], d: [0, -1, 0] };
}

/** Distance from `c` along `dir` to where `f` turns positive (a body's half-width at a height). */
function reach(f: Field, c: Vec3, dir: Vec3, max = 0.5): number {
    let lo = 0, hi = max;
    if (f(c[0] + dir[0] * hi, c[1] + dir[1] * hi, c[2] + dir[2] * hi) < 0) return hi;
    for (let i = 0; i < 24; i++) {
        const m = (lo + hi) / 2;
        if (f(c[0] + dir[0] * m, c[1] + dir[1] * m, c[2] + dir[2] * m) < 0) lo = m; else hi = m;
    }
    return lo;
}

function fabricFor(kind: string, fit: number): ClothOptions {
    const bend = kind === "jeans" ? 2e-7 : kind === "sweater" ? 4e-7 : kind === "trousers" ? 6e-7 : kind === "dress" || kind === "skirt" ? 2e-6 : 1e-6;
    return {
        fit: 0.97 + 0.04 * fit,
        bend,
        thickness: kind === "sweater" ? 0.0045 : kind === "jeans" ? 0.0035 : 0.0028,
        friction: 0.55,
        damping: 1.5,
        drag: 0.35,
    };
}

/** The torso's half-width (x) and half-depth (z) at a height, from its own field. */
function girth(h: FigureHandle, y: number): { c: Vec3; rx: number; rz: number } {
    const f = fieldOf(h.segments.torso), p = h.joint("pelvis");
    const c: Vec3 = [p[0], y, p[2]];
    const rx = Math.max(reach(f, c, [1, 0, 0]), reach(f, c, [-1, 0, 0]));
    const front = reach(f, c, [0, 0, 1]), back = reach(f, c, [0, 0, -1]);
    return { c: [c[0], y, c[2] + (front - back) / 2], rx, rz: (front + back) / 2 };
}

/** A skirt panel: fitted from the waist over the hips, then a cone opening toward the hem. */
function skirtPanel(h: FigureHandle, o: OutfitParams, ease: number): { node: SdfNode; hemY: number } {
    const M = h.measures, s = h.scale;
    const waistY = M.waistY * s + h.lift, hipY = M.hipY * s + h.lift - 0.03;
    const floor = Math.max(0.02, h.params.sole);
    const hemY = waistY - (waistY - floor - 0.03) * clamp(o.bottomLength, 0.12, 1);
    const w = girth(h, waistY), hp = girth(h, hipY);
    const hipR = Math.max(hp.rx, hp.rz / 0.8) + ease + 0.006;
    const squash: [number, number] = [1, clamp(hp.rz / hp.rx, 0.7, 0.95)];
    const flare = 0.06 + 0.9 * clamp(o.flare, 0, 1);
    const hemR = hipR + Math.max(0, hipY - hemY) * flare;
    const fitted = roundCone([w.c[0], waistY + 0.03, w.c[2]], [hp.c[0], hipY, hp.c[2]], Math.max(w.rx, w.rz) + ease, hipR, squash);
    const cone = roundCone([hp.c[0], hipY, hp.c[2]], [hp.c[0], hemY - 0.08, hp.c[2]], hipR, hemR, squash);
    // Hands hanging by the hips stay outside the skirt: the panel dents in around them.
    const S = h.segments;
    const arms = offset(union([S.forearmL, S.handL, S.forearmR, S.handR]), 0.012);
    return { node: subtract(union([fitted, cone], 0.03), arms, 0.02), hemY };
}

function topSpec(h: FigureHandle, o: OutfitParams): GarmentSpec | null {
    if (o.top === "none") return null;
    const S = h.segments, M = h.measures, s = h.scale;
    const ease = 0.004 + 0.022 * clamp(o.topFit, 0, 1) + (o.top === "sweater" ? 0.008 : 0);
    const pieces: Piece[] = [];
    const cuts: Field[] = [];
    const pelvis = h.joint("pelvis");
    const hipY = M.hipY * s + h.lift, waistY = M.waistY * s + h.lift;
    const isDress = o.top === "dress";
    const hemY = clamp(waistY + (hipY - waistY) * o.topLength - Math.max(0, o.topLength - 1) * 0.2, hipY - 0.3, waistY + 0.05);
    let yLo = hemY;
    // The body of the garment: the torso eased out, cut at the hem (a dress continues as a skirt).
    pieces.push({ node: offset(S.torso, ease), keep: isDress ? [] : [plane([pelvis[0], hemY, pelvis[2]], [0, -1, 0])] });
    if (o.topLength > 1 && !isDress) {
        // A tunic reaches past the hip: it hangs as a short tube over the thighs.
        const g = girth(h, hipY - 0.03);
        const r = Math.max(g.rx, g.rz / 0.8) + ease + 0.01;
        pieces.push({ node: roundCone([g.c[0], hipY + 0.03, g.c[2]], [g.c[0], hemY - 0.06, g.c[2]], r, r * (1.03 + 0.1 * o.topFit), [1, clamp(g.rz / g.rx, 0.7, 0.95)]), keep: [plane([pelvis[0], hemY, pelvis[2]], [0, -1, 0])] });
    }
    if (isDress) {
        const sk = skirtPanel(h, o, ease);
        pieces.push({ node: sk.node, keep: [plane([0, sk.hemY, 0], [0, -1, 0])] });
        yLo = sk.hemY;
    }
    // Neckline: a collar opening round the base of the neck, deeper in front for a scoop or a vee.
    const neck = h.joint("neck"), neckTop = h.joint("neck", 0.6);
    const chest0 = h.toWorld("chest", [0, 0, 0]), chest1 = h.toWorld("chest", [0, 0, 1]);
    const fwd = norm(sub(chest1, chest0));
    const up: Vec3 = norm(sub(h.joint("neck", 1), neck));
    const side = norm([fwd[2], 0, -fwd[0]]);
    const nr = 0.055 * s + 0.012;
    const collar = fieldOf(union([ellipsoid(add(neck, [0, 0.03, 0.005]), [nr + 0.008, 0.055, nr + 0.004]), ellipsoid(neckTop, [nr * 1.25, 0.09, nr * 1.25])]));
    cuts.push(removeInside(collar));
    if (o.neckline === "scoop") cuts.push(removeInside(fieldOf(ellipsoid(add(neck, add(scl(fwd, 0.085), scl(up, -0.035))), [nr + 0.025, 0.085, 0.07]))));
    if (o.neckline === "vneck") {
        const tip = add(neck, add(scl(fwd, 0.1), scl(up, -0.13)));
        const sinT = 0.36, cosT = 0.93;
        const n1 = add(scl(up, sinT), scl(side, -cosT)), n2 = add(scl(up, sinT), scl(side, cosT));
        const a = plane(tip, n1), b = plane(tip, n2), c = plane(neck, fwd);
        // Inside the vee: above both slanted edges and in front of the neck.
        cuts.push((x, y, z) => Math.min(a(x, y, z), b(x, y, z), c(x, y, z)));
    }
    // Sleeves: each arm's upper and lower segments eased out and cut at the sleeve's length.
    const sleeve = o.top === "tank" ? -1 : o.top === "longsleeve" || o.top === "sweater" ? Math.max(o.sleeve, 0.92) : o.sleeve;
    for (const L of ["L", "R"] as const) {
        const chain = [h.joint(`upperarm${L}` as BoneName), h.joint(`forearm${L}` as BoneName), h.joint(`hand${L}` as BoneName)];
        if (sleeve < 0) {
            // Sleeveless: the armhole cuts the torso's shell away round the shoulder.
            const sh = chain[0], chest = h.joint("chest");
            const out = norm([sh[0] - chest[0], 0, sh[2] - chest[2]]);
            // The strap over the shoulder runs between the neckline and this armhole.
            const wall = plane(sub(sh, scl(out, 0.028)), out);
            const ball = fieldOf(ellipsoid(add(sh, [0, -0.075, 0]), [0.12, 0.115, 0.11]));
            cuts.push((x, y, z) => Math.min(wall(x, y, z), -ball(x, y, z)));
            continue;
        }
        const arm = offset(union([S[`upperArm${L}` as SegmentName], S[`forearm${L}` as SegmentName]], 0.02), ease * 0.7 + 0.002 + (o.top === "sweater" ? 0.006 : 0));
        const end = along(chain, 0.08 + 0.92 * clamp(sleeve, 0, 1));
        pieces.push({ node: arm, keep: [plane(end.p, end.d)] });
        yLo = Math.min(yLo, end.p[1] - 0.06);
    }
    return {
        region: "top", pieces, cuts, yRange: [yLo, 10], blend: 0.025, options: fabricFor(o.top, o.topFit),
        shoulders: M.shoulderY * s + h.lift - 0.03,
        cover: union(pieces.map(p => p.node)),
    };
}

function bottomSpec(h: FigureHandle, o: OutfitParams): GarmentSpec | null {
    if (o.bottom === "none" || o.top === "dress") return null;
    const S = h.segments, M = h.measures, s = h.scale;
    const ease = 0.003 + 0.02 * clamp(o.bottomFit, 0, 1);
    const pelvis = h.joint("pelvis");
    const waistY = M.waistY * s + h.lift - 0.015;
    const up: Vec3 = norm(sub(h.joint("spine"), pelvis));
    const waistAt: Vec3 = [pelvis[0], waistY, pelvis[2]];
    const pieces: Piece[] = [];
    let yLo = 0;
    const hips = offset(S.torso, ease);
    if (o.bottom === "skirt") {
        const sk = skirtPanel(h, o, ease);
        pieces.push({ node: hips, keep: [plane([0, sk.hemY, 0], [0, -1, 0])] }, { node: sk.node, keep: [plane([0, sk.hemY, 0], [0, -1, 0])] });
        yLo = sk.hemY;
    } else {
        pieces.push({ node: hips, keep: [] });
        const share = o.bottom === "shorts" ? 0.08 + clamp(o.bottomLength, 0, 1) * 0.42 : clamp(o.bottomLength, 0.2, 1);
        yLo = 10;
        for (const L of ["L", "R"] as const) {
            const leg = offset(union([S[`thigh${L}` as SegmentName], S[`shin${L}` as SegmentName]], 0.02), ease + 0.002);
            const chain = [h.joint(`thigh${L}` as BoneName), h.joint(`shin${L}` as BoneName), h.joint(`foot${L}` as BoneName)];
            // Full length breaks just above the ankle bone.
            const end = along(chain, Math.min(share, 0.965));
            pieces.push({ node: leg, keep: [plane(end.p, end.d)] });
            yLo = Math.min(yLo, end.p[1] - 0.06);
        }
    }
    const waist = plane(waistAt, up);
    const kind = o.bottom === "skirt" ? "skirt" : o.bottom;
    const all = union(pieces.map(p => p.node));
    return {
        region: "bottom", pieces, cuts: [waist], yRange: [yLo, waistY + 0.08], blend: 0.03, options: fabricFor(kind, o.bottomFit),
        waist: { center: waistAt, up },
        cover: intersect(all, custom([-50, -50, -50, 50, 50, 50], waist)),
    };
}

// --- Fitting and draping -------------------------------------------------------------------------

interface Shell { positions: number[]; tris: number[] }

/**
 * Meshes the smooth union of a garment's pieces, then clips it exactly where each piece ends and
 * along every cut, so hems run cleanly along their planes. A vertex belongs to the piece whose
 * surface it lies on (the nearest), and that piece's own cuts decide whether it stays.
 */
function shellOf(spec: GarmentSpec, cell: number): Shell | null {
    const [yLo, yHi] = spec.yRange;
    const margin = cell * 4;
    let volume: SdfNode = union(spec.pieces.map(p => p.node), spec.blend);
    volume = intersect(volume, custom([-50, -50, -50, 50, 50, 50], (x, y) => Math.max(yLo - margin - y, y - yHi - margin)));
    const b = volume.box;
    const box: Box = [Math.max(b[0], -3) - cell * 2, Math.max(b[1], yLo - margin) - cell * 2, Math.max(b[2], -3) - cell * 2, Math.min(b[3], 3) + cell * 2, Math.min(b[4], yHi + margin) + cell * 2, Math.min(b[5], 3) + cell * 2];
    const fm = meshField(volume, { box, size: cell, lipschitz: 1.3 });
    if (!fm.indices.length) return null;
    const P = fm.positions.slice();
    const nv = P.length / 3;
    const pieceFields = spec.pieces.map(p => fieldOf(p.node));
    // The cut value at a vertex: positive is cut away.
    const cutAt = (x: number, y: number, z: number): number => {
        let owner = 0, best = Infinity;
        for (let i = 0; i < pieceFields.length; i++) { const d = Math.abs(pieceFields[i](x, y, z)); if (d < best) { best = d; owner = i; } }
        let c = Math.max(yLo - y, y - yHi);
        for (const k of spec.pieces[owner].keep) c = Math.max(c, k(x, y, z));
        for (const k of spec.cuts) c = Math.max(c, k(x, y, z));
        return c;
    };
    const C = new Float64Array(nv);
    for (let v = 0; v < nv; v++) C[v] = cutAt(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    // Snap vertices lying almost on a cut onto it, so clipping makes no slivers.
    const snap = cell * 0.3;
    for (let v = 0; v < nv; v++) {
        if (Math.abs(C[v]) >= snap) continue;
        const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2], e = 1e-4;
        const gx = (cutAt(x + e, y, z) - C[v]) / e, gy = (cutAt(x, y + e, z) - C[v]) / e, gz = (cutAt(x, y, z + e) - C[v]) / e;
        const g2 = gx * gx + gy * gy + gz * gz;
        if (g2 > 1e-6) { P[v * 3] -= gx * C[v] / g2; P[v * 3 + 1] -= gy * C[v] / g2; P[v * 3 + 2] -= gz * C[v] / g2; }
        C[v] = 0;
    }
    // Clip each triangle against C <= 0, sharing the new vertex on every cut edge.
    const out: number[] = [];
    const edgeVert = new Map<number, number>();
    const cross = (a: number, b: number): number => {
        const key = a < b ? a * nv + b : b * nv + a;
        let v = edgeVert.get(key);
        if (v === undefined) {
            const t = C[a] / (C[a] - C[b]);
            v = P.length / 3;
            P.push(P[a * 3] + (P[b * 3] - P[a * 3]) * t, P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * t, P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * t);
            edgeVert.set(key, v);
        }
        return v;
    };
    const I = fm.indices;
    for (let t = 0; t < I.length; t += 3) {
        const v = [I[t], I[t + 1], I[t + 2]];
        const inside = v.map(i => C[i] <= 0);
        const nIn = inside.filter(Boolean).length;
        if (nIn === 3) { out.push(v[0], v[1], v[2]); continue; }
        if (nIn === 0) continue;
        // Rotate so the odd one out comes first.
        const odd = nIn === 1 ? inside.indexOf(true) : inside.indexOf(false);
        const a = v[odd], b = v[(odd + 1) % 3], c = v[(odd + 2) % 3];
        if (nIn === 1) {
            // Only a is kept: one small triangle.
            const ab = C[a] < 0 ? cross(a, b) : a, ac = C[a] < 0 ? cross(a, c) : a;
            out.push(a, ab, ac);
        } else {
            // a is cut away: the quad ab, b, c, ac remains.
            const ab = C[b] < 0 ? cross(a, b) : b, ac = C[c] < 0 ? cross(a, c) : c;
            out.push(ab, b, c, ab, c, ac);
        }
    }
    // Drop degenerate triangles, then keep the largest connected piece of cloth, reindexed.
    const keep: number[] = [];
    for (let t = 0; t < out.length; t += 3) if (out[t] !== out[t + 1] && out[t + 1] !== out[t + 2] && out[t] !== out[t + 2]) keep.push(out[t], out[t + 1], out[t + 2]);
    const total = P.length / 3;
    const parent = new Int32Array(total).map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let t = 0; t < keep.length; t += 3) { const a = find(keep[t]); parent[find(keep[t + 1])] = a; parent[find(keep[t + 2])] = a; }
    const size = new Map<number, number>();
    for (let t = 0; t < keep.length; t += 3) { const r = find(keep[t]); size.set(r, (size.get(r) ?? 0) + 1); }
    let best = -1, bestN = 0;
    for (const [r, k] of size) if (k > bestN) { best = r; bestN = k; }
    const map = new Int32Array(total).fill(-1);
    const positions: number[] = [], tris: number[] = [];
    for (let t = 0; t < keep.length; t += 3) {
        if (find(keep[t]) !== best) continue;
        for (let k = 0; k < 3; k++) {
            const v = keep[t + k];
            if (map[v] < 0) { map[v] = positions.length / 3; positions.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); }
            tris.push(map[v]);
        }
    }
    return tris.length ? { positions, tris } : null;
}

/** A collider from a grid of the body (and whatever is worn beneath). */
export function gridCollider(grid: LazyGrid): Collider {
    return { sample: (x, y, z, g) => grid.sample(x, y, z, g) };
}

export interface DrapedGarment {
    region: string;
    solver: ClothSolver;
    /** What a garment worn over it rests on. */
    cover: SdfNode;
    thickness: number;
    /** The collision grid it draped against (already filled where the cloth goes), reused live. */
    grid?: LazyGrid;
}

const GRAVITY: Vec3 = [0, -9.81, 0];
/** The most a part may lag behind its figure in one frame (a sudden turn carries the rest along). */
const MAX_LAG = 0.03;

/** Fits and drapes one garment over `under` (the body, and anything worn beneath). */
function drape(spec: GarmentSpec, under: SdfNode, box: Box, o: OutfitParams): DrapedGarment | null {
    let cell = 0.0135 * clamp(o.detail, 0.6, 2.5);
    let shell = shellOf(spec, cell);
    // A big garment (a floor-length circle skirt) is cut coarser to stay within budget.
    const budget = 9000 / clamp(o.detail, 0.6, 2.5);
    if (shell && shell.positions.length / 3 > budget * 1.15) {
        cell *= Math.sqrt(shell.positions.length / 3 / budget);
        shell = shellOf(spec, cell);
    }
    if (!shell) return null;
    const grid = new LazyGrid(under, box, 0.007);
    const n = shell.positions.length / 3;
    const solver = new ClothSolver(shell.positions, shell.tris, new Uint8Array(n), spec.options, gridCollider(grid));
    if (spec.waist) {
        // The waistband: the loop nearest the waist plane grips the body.
        let bestLoop: number[] | null = null, bestD = Infinity;
        for (const loop of solver.boundaryLoops()) {
            let d = 0;
            for (const v of loop) d += Math.abs(solver.x[v * 3 + 1] - spec.waist.center[1]);
            d /= loop.length;
            if (d < bestD) { bestD = d; bestLoop = loop; }
        }
        if (bestLoop && bestD < 0.05) { solver.tighten(new Set(bestLoop), 0.94); solver.pin(bestLoop); }
    }
    // What holds the garment up: its waistband, and cloth lying on top of the shoulders.
    if (spec.shoulders) {
        const g = [0, 0, 0];
        const N = solver.normals;
        const anchors: number[] = [];
        for (let i = 0; i < n; i++) {
            if (solver.x[i * 3 + 1] < spec.shoulders) continue;
            const d = grid.sample(solver.x[i * 3], solver.x[i * 3 + 1], solver.x[i * 3 + 2], g);
            if (d < spec.options.thickness + 0.03 && N[i * 3 + 1] > 0.55) anchors.push(i);
        }
        solver.pin(anchors);
    }
    const anchors: number[] = [];
    for (let i = 0; i < n; i++) if (solver.w[i] === 0) anchors.push(i);
    solver.tether(anchors);
    // A breath of disorder so symmetric cloth can buckle into folds.
    for (let i = 0; i < n; i++) if (solver.w[i] > 0) for (let k = 0; k < 3; k++) solver.x[i * 3 + k] += (hash01(o.seed, i, k) - 0.5) * 0.0004;
    solver.prev.set(solver.x);
    const wind = scl(norm([0.6, 0, 1]), o.wind);
    const frames = Math.round(clamp(o.settle, 0, 400));
    for (let f = 0; f < frames; f++) solver.simulate(1 / 60, 8, GRAVITY, wind);
    solver.prev.set(solver.x);
    return { region: spec.region, solver, cover: spec.cover, thickness: spec.options.thickness, grid };
}

// --- Output --------------------------------------------------------------------------------------

/** Two-sided cloth: the outer surface, an inner one a cloth's thickness inside, joined at the hems. */
function solidify(sol: ClothSolver, thickness: number, intoPos: Float32Array, intoNrm: Float32Array): void {
    const n = sol.n, X = sol.x, N = sol.normals;
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
        intoPos[i * 3 + k] = X[i * 3 + k];
        intoNrm[i * 3 + k] = N[i * 3 + k];
        intoPos[(n + i) * 3 + k] = X[i * 3 + k] - N[i * 3 + k] * thickness;
        intoNrm[(n + i) * 3 + k] = -N[i * 3 + k];
    }
}

function garmentPart(d: DrapedGarment): Part {
    const sol = d.solver, n = sol.n;
    const loops = sol.boundaryLoops();
    const pos = new Float32Array(n * 6), nrm = new Float32Array(n * 6);
    solidify(sol, d.thickness * 0.7, pos, nrm);
    const part = newPart(d.region);
    part.positions = Array.from(pos);
    part.normals = Array.from(nrm);
    part.uvs = new Array(n * 4).fill(0);
    const idx: number[] = [];
    const T = sol.tris;
    for (let t = 0; t < T.length; t += 3) idx.push(T[t], T[t + 1], T[t + 2]);
    for (let t = 0; t < T.length; t += 3) idx.push(n + T[t], n + T[t + 2], n + T[t + 1]);
    // Hems: a strip joining the two layers along every boundary loop.
    for (const loop of loops) for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        idx.push(a, n + a, b, b, n + a, n + b);
    }
    part.indices = idx;
    return part;
}

/** A viewport simulator for one draped garment, starting from its settled state. */
function clothSource(d: DrapedGarment, collider: () => Collider): DynamicSource {
    const base = d.solver;
    const x0 = Float64Array.from(base.x);
    const tris = base.tris;
    const pinned = new Uint8Array(base.n).map((_, i) => (base.w[i] === 0 ? 1 : 0));
    const opts = (base as unknown as { o: ClothOptions }).o;
    return {
        kind: "cloth",
        spawn(): Simulator {
            const sol = new ClothSolver(x0, tris, pinned, { ...opts, fit: 1 }, collider());
            // Rest lengths are the settled shape's, so it holds still until something moves it;
            // tethers to what holds it up keep a swinging garment from stretching off the body.
            const anchors: number[] = [];
            for (let i = 0; i < sol.n; i++) if (pinned[i]) anchors.push(i);
            sol.tether(anchors, 1.03);
            sol.remember(x0, 0.0008);
            const n = sol.n;
            const positions = new Float32Array(n * 6), normals = new Float32Array(n * 6);
            solidify(sol, d.thickness * 0.7, positions, normals);
            return {
                vertexCount: n * 2, positions, normals,
                step(dt, frame, wind) {
                    const moved = sol.follow(frame);
                    const inv = invertFrame(frame);
                    const g = localDirection(inv, GRAVITY), w = localDirection(inv, wind);
                    const windy = Math.hypot(...wind) > 0.01;
                    if (sol.asleep && !moved && !windy) return false;
                    const v = sol.simulate(Math.min(dt, 1 / 30), 5, g as Vec3, w as Vec3);
                    sol.noteSpeed(v, moved || windy);
                    solidify(sol, d.thickness * 0.7, positions, normals);
                    return true;
                },
            };
        },
    };
}

export interface Outfit {
    mesh: Mesh;
    garments: DrapedGarment[];
    /** The body together with every garment, for hair to rest on. */
    under: SdfNode;
}

/** Dresses a figure: fits each garment, drapes it in order (bottoms first), and returns the cloth. */
export function dress(h: FigureHandle, params: Partial<OutfitParams> = {}): Outfit {
    const o: OutfitParams = { ...DEFAULT_OUTFIT, ...params };
    const box: Box = [h.box[0] - 0.4, h.box[1] - 0.05, h.box[2] - 0.4, h.box[3] + 0.4, h.box[4] + 0.1, h.box[5] + 0.4];
    let under: SdfNode = h.body;
    const garments: DrapedGarment[] = [];
    const parts: Part[] = [];
    for (const spec of [bottomSpec(h, o), topSpec(h, o)]) {
        if (!spec) continue;
        const d = drape(spec, under, box, o);
        if (!d) continue;
        garments.push(d);
        const part = garmentPart(d);
        // Live cloth collides with the body and what lies beneath it, on the grid it draped against.
        const grid = d.grid!;
        attachDynamic(part, clothSource(d, () => gridCollider(grid)));
        parts.push(part);
        // The next garment rests on this one's volume.
        under = union([under, offset(d.cover, d.thickness)]);
    }
    return { mesh: { parts }, garments, under };
}

// --- Footwear ------------------------------------------------------------------------------------

export const SHOES = ["none", "sneakers", "boots", "flats", "heels"] as const;
export type ShoeKind = typeof SHOES[number];

/** How a shoe lifts the figure: sole thickness under the ball of the foot, and heel height. */
export function shoeLift(kind: ShoeKind): { sole: number; heel: number } {
    switch (kind) {
        case "sneakers": return { sole: 0.026, heel: 0.008 };
        case "boots": return { sole: 0.03, heel: 0.012 };
        case "flats": return { sole: 0.008, heel: 0 };
        case "heels": return { sole: 0.01, heel: 0.075 };
        default: return { sole: 0, heel: 0 };
    }
}

/**
 * Shoes fitted to the figure's feet: an upper eased over the foot (and up the shin for boots), open
 * where the foot goes in, given a leather thickness; a sole slab under it to the floor; a heel post
 * for heels. Rigid, so no physics.
 */
export function footwear(h: FigureHandle, kind: ShoeKind, detail = 1): Mesh {
    if (kind === "none") return { parts: [] };
    const S = h.segments;
    const { sole } = shoeLift(kind);
    const cell = 0.007 * clamp(detail, 0.6, 2.5);
    const uppers = newPart("shoes"), soles = newPart("soles");
    for (const L of ["L", "R"] as const) {
        const foot = S[`foot${L}` as SegmentName], shin = S[`shin${L}` as SegmentName];
        const ankle = h.joint(`foot${L}` as BoneName), knee = h.joint(`shin${L}` as BoneName);
        const shinUp = norm(sub(knee, ankle));
        const ease = kind === "boots" ? 0.006 : kind === "sneakers" ? 0.0055 : 0.0025;
        const fwd = norm(sub(h.joint(`toes${L}` as BoneName), ankle));
        // The last: a smooth heel-to-toe form the upper is shaped on, blended over the real foot.
        const fb = h.skeleton.bones.get(`foot${L}` as BoneName)!, tb = h.skeleton.bones.get(`toes${L}` as BoneName)!;
        const W = (bone: BoneName, q: Vec3) => h.toWorld(bone, q);
        const sd = L === "L" ? 1 : -1;
        const heelP = W(`foot${L}` as BoneName, add(fb.head, [0, -0.045, -h.measures.heelBack + 0.03]));
        const ballP = W(`toes${L}` as BoneName, add(tb.head, [-sd * 0.004, 0.004, 0.0]));
        const toeP = W(`toes${L}` as BoneName, add(tb.head, [-sd * 0.006, -0.002, (tb.tail[2] - tb.head[2]) * 0.92]));
        const footUp = norm(sub(W(`foot${L}` as BoneName, [0, 1, 0]), W(`foot${L}` as BoneName, [0, 0, 0])));
        const s0 = h.scale;
        const last = union([
            roundCone(heelP, ballP, 0.033 * s0, 0.04 * s0, [1.25, 0.72], fwd),
            roundCone(ballP, toeP, 0.04 * s0, 0.024 * s0, [1.45, 0.62], fwd),
        ], 0.02);
        const upperBase = offset(union([last, foot], 0.025), ease);
        // The collar: round the ankle for sneakers, up the calf for boots, a low line parallel to
        // the sole for flats and heels (the instep shows; heel cup and toe box stay covered).
        const pieces: Piece[] = [];
        const upper = kind === "boots" ? union([upperBase, offset(shin, ease)], 0.02) : upperBase;
        const soleAt = add(heelP, scl(footUp, -0.03 * s0));
        const collar = kind === "boots" ? plane(add(ankle, scl(shinUp, 0.17)), shinUp)
            : kind === "sneakers" ? plane(add(ankle, scl(shinUp, 0.02)), add(shinUp, scl(fwd, -0.25)))
            : plane(add(soleAt, scl(footUp, 0.045 * s0)), footUp);
        pieces.push({ node: upper, keep: [collar] });
        // Below the sole's top the upper is the sole's job.
        const spec: GarmentSpec = {
            region: "shoes", pieces, cuts: [(x, y) => sole + 0.004 - y], yRange: [sole, 0.7], blend: 0, cover: upper,
            options: fabricFor("jeans", 0),
        };
        const shell = shellOf(spec, cell);
        if (shell) {
            const n = shell.positions.length / 3;
            const solver = new ClothSolver(shell.positions, shell.tris, new Uint8Array(n).fill(1), spec.options, { sample: () => 1 });
            const part = garmentPart({ region: "shoes", solver, cover: upper, thickness: kind === "boots" ? 0.004 : 0.003 });
            appendPart(uppers, part);
        }
        // The sole: the foot's outline a little proud, from the floor to just over the foot's underside.
        const footF = fieldOf(offset(foot, 0.009));
        const top = sole + 0.008;
        const slab = custom([-5, 0, -5, 5, top + 0.02, 5], (x, y, z) => Math.max(footF(x, top - 0.002, z), y - top, -y));
        let soleNode: SdfNode = intersect(offset(foot, 0.012), custom([-5, -1, -5, 5, 5, 5], (x, y) => y - top));
        soleNode = union([soleNode, slab], 0.004);
        if (kind === "heels" || kind === "boots") {
            // A heel post from the floor up under the heel bone.
            const heelAt = h.toWorld(`foot${L}` as BoneName, add(h.skeleton.bones.get(`foot${L}` as BoneName)!.head, [0, -0.05, -h.measures.heelBack + 0.03]));
            const hy = Math.max(0.01, heelAt[1] - 0.02);
            const w = kind === "heels" ? 0.009 : 0.028;
            soleNode = union([soleNode, roundCone([heelAt[0], hy, heelAt[2] - 0.004], [heelAt[0], 0.004, heelAt[2] - (kind === "heels" ? 0.012 : 0)], w * 1.4, w, [1, 1])], 0.006);
        }
        // Nothing below the floor.
        soleNode = intersect(soleNode, custom([-5, -1, -5, 5, 5, 5], (_x, y) => -y));
        const b = soleNode.box;
        const fm = meshField(soleNode, { box: [b[0] - 0.02, -0.01, b[2] - 0.02, b[3] + 0.02, Math.min(b[4], 0.2) + 0.02, b[5] + 0.02], size: cell, lipschitz: 1.4 });
        const base = soles.positions.length / 3;
        // The tread lies on the floor exactly (the mesher only approximates the cut plane).
        for (let i = 1; i < fm.positions.length; i += 3) if (fm.positions[i] < 0) fm.positions[i] = 0;
        soles.positions.push(...fm.positions);
        soles.normals.push(...fm.normals);
        for (let i = 0; i < fm.positions.length / 3; i++) soles.uvs.push(0, 0);
        for (const i of fm.indices) soles.indices.push(base + i);
    }
    return { parts: [uppers, soles].filter(p => p.indices.length) };
}

function appendPart(into: Part, p: Part): void {
    const base = into.positions.length / 3;
    into.positions.push(...p.positions);
    into.normals.push(...p.normals);
    into.uvs.push(...p.uvs);
    for (const i of p.indices) into.indices.push(base + i);
}

/** Points on a garment, for tests: does any particle sit inside the body? */
export function penetration(d: DrapedGarment, body: Field): { inside: number; worst: number } {
    let inside = 0, worst = 0;
    for (let i = 0; i < d.solver.n; i++) {
        const v = body(d.solver.x[i * 3], d.solver.x[i * 3 + 1], d.solver.x[i * 3 + 2]);
        if (v < 0) { inside++; worst = Math.min(worst, v); }
    }
    return { inside, worst };
}

