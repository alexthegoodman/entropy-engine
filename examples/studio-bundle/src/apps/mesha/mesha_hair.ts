// Mesha's hair: groomed strands with physics.
//
// A few hundred guide strands are rooted on the scalp inside the hairline and groomed by the style:
// each leaves the scalp along a flow away from the part (forward over the brow for a fringe, back
// to a tie for a ponytail or bun), lifts with the hair's volume, follows the head round under its
// own weight and is cut where the style ends (at the jaw for a bob, the shoulder blades for long
// hair). Curls wind round that path. The guides are then settled by a small-step position-based
// solver: each is a chain of particles held by its root, keeping its segment lengths, resisting
// bending and (how much depends on the style) springing back toward its groomed shape, while
// gravity pulls it down onto the head, the shoulders and the clothes.
//
// Thousands of render strands are interpolated from the guides (each follows its three nearest,
// gathering into clumps toward the tips, with a little frizz) and drawn as narrow ribbons that lie
// along the hair's surface; their uv carries a per-strand random and the position along the strand
// for the viewport's hair shading. Brows, lashes and beards are short static strands on the face,
// and a thin cap under the hair darkens the scalp. In the viewport the guides keep simulating, so
// hair swings when the figure is moved and blows in the wind.

import { type Mesh, type Vec3, type Part, newPart } from "./mesha_mesh";
import { type SdfNode, type Box, LazyGrid, offset, intersect, custom, meshField, fieldOf } from "./mesha_sdf";
import { type FigureHandle, eyeGeometry } from "./mesha_figure";
import { type Simulator, type DynamicSource, attachDynamic, invertFrame, mulFrame, applyFrame, localDirection, sameFrame, addLag } from "./mesha_dynamics";
import type { Mat4 } from "./mesha_mesh";
import { hash01, rng, noise3 } from "./mesha_noise";

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
const norm = (a: Vec3): Vec3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export const HAIR_STYLES = ["none", "buzz", "short", "pixie", "bob", "shoulder", "long", "ponytail", "bun", "curly", "afro"] as const;
export type HairStyle = typeof HAIR_STYLES[number];
export const PARTINGS = ["side", "center", "back"] as const;
export const BEARDS = ["none", "stubble", "mustache", "short", "full"] as const;
export type BeardStyle = typeof BEARDS[number];

export interface HairParams {
    style: HairStyle;
    /** Length relative to the style's own (1 as styled). */
    length: number;
    /** 0 straight to 1 tight curls. */
    curl: number;
    /** How far hair stands off the head, 0 sleek to 1 full. */
    volume: number;
    part: typeof PARTINGS[number];
    /** Fringe: 0 swept back, 1 brushing the brows. */
    bangs: number;
    /** Strand count relative to normal. */
    density: number;
    beard: BeardStyle;
    /** Brow fullness, 0 fine to 1 bushy. */
    brows: number;
    lashes: boolean;
    /** Wind during the settle (m/s). */
    wind: number;
    seed: number;
    /** Simulated settle frames. */
    settle: number;
    detail: number;
}

export const DEFAULT_HAIR: HairParams = {
    style: "long", length: 1, curl: 0.1, volume: 0.35, part: "side", bangs: 0, density: 1, beard: "none", brows: 0.5, lashes: true, wind: 0, seed: 1, settle: 36, detail: 1,
};

interface StyleSpec {
    /** Strand length (m) at the crown; strands are cut at the style's hem besides. */
    length: number;
    /** Hem height in head units below the eyes (where the cut runs), or null for no hem cut. */
    hem: number | null;
    /** Hem tilt: longer in front (A-line) when positive. */
    aline: number;
    /** Spring back to the groomed shape (0 hangs freely, 1 holds). */
    hold: number;
    /** Initial lift off the scalp. */
    lift: number;
    curl: number;
    volume: number;
    tie?: "pony" | "bun";
}

const STYLES: Record<Exclude<HairStyle, "none">, StyleSpec> = {
    buzz: { length: 0.006, hem: null, aline: 0, hold: 1, lift: 0.05, curl: 0, volume: 0 },
    short: { length: 0.065, hem: null, aline: 0, hold: 0.85, lift: 0.5, curl: 0, volume: 0.4 },
    pixie: { length: 0.09, hem: null, aline: 0, hold: 0.7, lift: 0.35, curl: 0, volume: 0.35 },
    bob: { length: 0.3, hem: -0.095, aline: 0.25, hold: 0.25, lift: 0.25, curl: 0, volume: 0.35 },
    shoulder: { length: 0.4, hem: -0.24, aline: 0.1, hold: 0.12, lift: 0.2, curl: 0, volume: 0.3 },
    long: { length: 0.62, hem: -0.48, aline: 0.05, hold: 0.06, lift: 0.18, curl: 0, volume: 0.3 },
    ponytail: { length: 0.36, hem: null, aline: 0, hold: 0.1, lift: 0, curl: 0, volume: 0.05, tie: "pony" },
    bun: { length: 0.3, hem: null, aline: 0, hold: 1, lift: 0, curl: 0, volume: 0.05, tie: "bun" },
    curly: { length: 0.34, hem: -0.2, aline: 0.05, hold: 0.35, lift: 0.5, curl: 0.75, volume: 0.75 },
    afro: { length: 0.13, hem: null, aline: 0, hold: 0.95, lift: 1, curl: 1, volume: 1 },
};

// --- Head frame ----------------------------------------------------------------------------------

interface HeadFrame {
    /** Head-local point (head units, origin between the eyes) to world, and directions. */
    P: (x: number, y: number, z: number) => Vec3;
    D: (x: number, y: number, z: number) => Vec3;
    /** World point to head-local. */
    local: (p: Vec3) => Vec3;
    hu: number;
    /** Cranium center (world). */
    center: Vec3;
}

function headFrame(h: FigureHandle): HeadFrame {
    const O = h.headPoint(0, 0, 0);
    const ex = h.headDir(1, 0, 0), ey = h.headDir(0, 1, 0), ez = h.headDir(0, 0, 1);
    const hu = h.head.hu;
    return {
        P: h.headPoint, D: h.headDir, hu,
        local: p => { const d = sub(p, O); return [dot(d, ex) / hu, dot(d, ey) / hu, dot(d, ez) / hu]; },
        center: h.headPoint(0, 0.02, -0.014),
    };
}

/**
 * Where hair grows: above the hairline, a curve in head units by the angle round the head (0 at
 * the front): high on the forehead, dipping at the temples, over the ears, lowest at the nape.
 */
function hairlineY(theta: number, recession: number): number {
    const a = Math.abs(theta) / Math.PI; // 0 front .. 1 back
    // front, temple, over the ear, behind it, nape
    const knots: [number, number][] = [[0, 0.06 + recession], [0.18, 0.052 + recession * 1.3], [0.3, 0.04], [0.42, 0.035], [0.5, 0.028], [0.62, -0.015], [0.8, -0.06], [1, -0.075]];
    for (let i = 0; i + 1 < knots.length; i++) {
        if (a <= knots[i + 1][0]) {
            const t = (a - knots[i][0]) / (knots[i + 1][0] - knots[i][0]);
            const s = t * t * (3 - 2 * t);
            return lerp(knots[i][1], knots[i + 1][1], s);
        }
    }
    return knots[knots.length - 1][1];
}

/** Is a head-local scalp point inside the hairline (and clear of the ears)? */
function onScalp(q: Vec3, recession = 0): number {
    const theta = Math.atan2(q[0], q[2]);
    return q[1] - hairlineY(theta, recession);
}

/**
 * Where a ray from `from` heading along `dir` first meets the surface (sphere tracing: each step is
 * the field's own distance, so few evaluations), or null if it never does within `maxT`.
 */
function trace(f: (x: number, y: number, z: number) => number, from: Vec3, dir: Vec3, maxT = 0.25): Vec3 | null {
    const at = (t: number): Vec3 => [from[0] + dir[0] * t, from[1] + dir[1] * t, from[2] + dir[2] * t];
    let t = 0, outside = -1;
    for (let i = 0; i < 48 && t < maxT; i++) {
        const p = at(t);
        const d = f(p[0], p[1], p[2]);
        if (d < 0 && outside >= 0) {
            // A field that overestimates its distance can step past the surface: bisect back to it.
            let lo = outside, hi = t;
            for (let k = 0; k < 24; k++) { const m = (lo + hi) / 2, q = at(m); if (f(q[0], q[1], q[2]) > 0) lo = m; else hi = m; }
            return at(hi);
        }
        if (d < 2e-5) return p;
        outside = t;
        t += d * 0.85 + 2e-5;
    }
    return null;
}

/** Finds the head surface along the ray from the cranium center through `dir` (world), from outside. */
function scalpPoint(head: (x: number, y: number, z: number) => number, c: Vec3, dir: Vec3): Vec3 | null {
    return trace(head, add(c, scl(dir, 0.25)), scl(dir, -1), 0.23);
}

/** The field's outward normal by forward differences. */
function normalAt(f: (x: number, y: number, z: number) => number, p: Vec3): Vec3 {
    const e = 2e-4, v = f(p[0], p[1], p[2]);
    return norm([f(p[0] + e, p[1], p[2]) - v, f(p[0], p[1] + e, p[2]) - v, f(p[0], p[1], p[2] + e) - v]);
}

interface Root { p: Vec3; n: Vec3; q: Vec3 }

/** Roots spread evenly over the scalp (a Fibonacci sphere through the cranium, kept inside the hairline). */
function scalpRoots(h: FigureHandle, F: HeadFrame, count: number, seed: number, recession: number, headField: (x: number, y: number, z: number) => number): Root[] {
    const roots: Root[] = [];
    const total = Math.round(count / 0.42);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const jit = rng(seed * 31 + 7);
    for (let i = 0; i < total && roots.length < count * 1.2; i++) {
        const y = 1 - (2 * (i + 0.5)) / total;
        const r = Math.sqrt(1 - y * y), a = i * golden + jit() * 0.3;
        const dl: Vec3 = [Math.cos(a) * r, y, Math.sin(a) * r];
        // Quick reject below the lowest hairline before ray casting.
        if (dl[1] < -0.85) continue;
        const dir = F.D(dl[0], dl[1], dl[2]);
        const p = scalpPoint(headField, F.center, dir);
        if (!p) continue;
        const q = F.local(p);
        if (onScalp(q, recession) < 0) continue;
        roots.push({ p, n: normalAt(headField, p), q });
    }
    return roots;
}

// --- Grooming ------------------------------------------------------------------------------------

export const SEGMENTS = 14;

interface Groom {
    points: Vec3[];
    /** Particles held by the root (the first two, or the whole gathered run of a tie). */
    held: number;
    /** Part of a fringe, cut at the brows. */
    fringe?: boolean;
}

interface GroomContext {
    F: HeadFrame;
    spec: StyleSpec;
    o: HairParams;
    length: number;
    collide: (p: Vec3, r: number) => Vec3;
    /** Distance to what hair rests on, and its gradient. */
    surface: (p: Vec3, grad: number[]) => number;
    tieAt: Vec3;
    partX: number;
}

/** The groomed path of a strand from a root: SEGMENTS + 1 points. */
function groom(root: Root, g: GroomContext, salt: number): Groom {
    const { F, spec, o } = g;
    const q = root.q;
    const down = [0, -1, 0] as Vec3;
    const vol = clamp(spec.volume * 0.5 + o.volume * 0.7, 0, 1.4);
    // The flow along the scalp: away from the part, down and back; a fringe falls forward.
    const side = q[0] - g.partX;
    const lateral = F.D(Math.sign(side) || 1, 0, 0);
    const back = F.D(0, -0.15, -1);
    const fringeZone = clamp((q[2] - 0.02) / 0.05, 0, 1) * clamp((q[1] - 0.03) / 0.04, 0, 1) * (1 - clamp(Math.abs(q[0]) / 0.07, 0, 1));
    // Hair from the front of the scalp is combed back and to the side, away from the face.
    const front = clamp(q[2] / 0.07, 0, 1);
    let flow: Vec3;
    if (o.part === "back") flow = norm(add(scl(back, 1 + front), scl(lateral, 0.25 * clamp(Math.abs(q[0]) / 0.05, 0, 1))));
    else {
        // The part only steers hair on top of the head and toward the front; behind, it falls straight.
        const steer = clamp((q[1] + 0.01) / 0.06, 0, 1) * (1 - 0.8 * clamp(-q[2] / 0.06, 0, 1));
        flow = norm(add(scl(lateral, clamp(Math.abs(side) / 0.03, 0.35, 1) * steer), add(scl(back, 0.25 + 1.1 * front), scl(F.D(0, -1, 0), 0.2 + 0.6 * (1 - steer)))));
    }
    const bangs = clamp(o.bangs, 0, 1) * fringeZone;
    if (bangs > 0) flow = norm(add(scl(flow, 1 - bangs), scl(F.D(0.25 * Math.sign(side || 1), -0.4, 1), bangs * 1.4)));
    if (spec.tie) flow = norm(sub(g.tieAt, root.p));
    // Strand length: the style's, a fringe cut at the brows, a little natural variation.
    let L = g.length * (0.92 + 0.16 * hash01(o.seed, salt, 3));
    if (bangs > 0.25 && !spec.tie) L = Math.min(L, 0.15);
    if (spec.tie === "pony" || spec.tie === "bun") L = len(sub(g.tieAt, root.p)) * 1.05 + g.length;
    const ds = L / SEGMENTS;
    const pts: Vec3[] = [root.p];
    let p = root.p;
    // Leave the scalp along the flow, lifted by the volume (straight out for an afro).
    let d = spec.volume >= 0.9 ? norm(add(root.n, scl(flow, 0.25))) : norm(add(flow, scl(root.n, spec.lift * 0.5 + vol * 0.2)));
    // How far off the scalp the strand lies: more with volume, and only as much as a short cut allows.
    const layer = (0.0015 + vol * 0.006 * (0.4 + 0.6 * hash01(o.seed, salt, 5))) * clamp(L / 0.05, 0.12, 1);
    const ng = [0, 0, 0];
    let hugging: Vec3 | null = null;
    let tied = -1;
    for (let k = 1; k <= SEGMENTS; k++) {
        if (spec.tie && tied < 0) {
            // Gathered along the scalp to the tie.
            const toTie = sub(g.tieAt, p);
            if (len(toTie) < ds * 1.2) { p = g.tieAt; tied = k; pts.push(p); continue; }
            d = norm(toTie);
        } else if (spec.tie === "pony") {
            // The tail: out from the tie, then falling.
            d = norm(add(scl(d, 0.75), scl(down, 0.35)));
        } else if (spec.tie === "bun") {
            // Wound round the tie point.
            const axis = F.D(0, 0.35, -1);
            const r = 0.028 * F.hu / 0.2;
            const ang = (k - tied) * 1.3 + salt * 0.37;
            const u = norm(cross(axis, [0, 1, 0])), v = norm(cross(axis, u));
            const target = add(g.tieAt, add(add(scl(u, Math.cos(ang) * r), scl(v, Math.sin(ang) * r)), scl(axis, 0.006 * (k - tied))));
            pts.push(target); p = target; continue;
        } else {
            // Gravity turns the strand toward hanging (less for hair that holds a style). Above the
            // skull's widest point hair lies on the head, sliding down along it; below, it falls free.
            const fall = (1 - spec.hold) * 0.45 + 0.04;
            let pull = down;
            hugging = null;
            const dist = g.surface(p, ng);
            if (spec.volume >= 0.9) {
                // An afro stands out from the head in every direction.
                d = norm(add(d, scl(norm(sub(p, F.center)), 0.5)));
            } else if (dist < layer + 0.03) {
                const n: Vec3 = norm(ng as Vec3);
                const pd = dot(down, n);
                if (pd < 0) {
                    const td = sub(down, scl(n, pd)), tl = len(td);
                    pull = tl > 0.25 ? scl(td, 1 / tl) : d;
                    d = norm(sub(d, scl(n, dot(d, n))));
                    hugging = n;
                }
            }
            d = norm(add(d, scl(pull, fall)));
        }
        let next = add(p, scl(d, ds));
        if (hugging) {
            // A straight step leaves a curved head: draw it back down onto its layer.
            const dn = g.surface(next, ng);
            const lift = layer + (spec.lift + vol) * 0.004 * (k / SEGMENTS);
            if (dn > lift) next = sub(next, scl(norm(ng as Vec3), (dn - lift) * 0.8));
        }
        next = g.collide(next, layer);
        d = norm(sub(next, p));
        p = next;
        pts.push(p);
    }
    if (L < 0.03) {
        // A very short strand's steps are finer than the collisions that shaped it: smooth the kinks out.
        for (let r = 0; r < 3; r++) for (let k = 1; k < pts.length - 1; k++) pts[k] = g.collide(scl(add(add(pts[k - 1], pts[k + 1]), scl(pts[k], 2)), 0.25), layer);
    }
    return { points: pts, held: tied > 0 ? tied + 1 : 2, fringe: bangs > 0.25 && !spec.tie };
}

/** A polyline re-sampled to SEGMENTS + 1 points over its first `length` meters. */
function resample(pts: Vec3[], length: number): Vec3[] {
    const out: Vec3[] = [pts[0]];
    const seg = length / SEGMENTS;
    let i = 0;
    for (let k = 1; k <= SEGMENTS; k++) {
        let want = seg;
        let p = out[out.length - 1];
        while (want > 1e-9) {
            const q = pts[Math.min(i + 1, pts.length - 1)];
            const l = len(sub(q, p));
            if (i + 1 >= pts.length || l >= want) {
                const dir = i + 1 >= pts.length ? norm(sub(pts[pts.length - 1], pts[Math.max(0, pts.length - 2)])) : norm(sub(q, p));
                p = add(p, scl(dir, want));
                want = 0;
            } else { want -= l; p = q; i++; }
        }
        out.push(p);
    }
    return out;
}

/** Curls: each point beyond the root winds round the strand's path (a helix of radius growing from the root). */
function curlPath(pts: Vec3[], curl: number, seed: number, salt: number): Vec3[] {
    if (curl <= 0.01) return pts;
    const total = pts.slice(1).reduce((a, p, i) => a + len(sub(p, pts[i])), 0);
    // Short hair can only hold a small curl: radius and wavelength shrink with the strand.
    const short = clamp(total / 0.15, 0.04, 1);
    const R = (0.004 + 0.012 * curl) * short, wave = (0.12 - 0.08 * curl) * Math.sqrt(short);
    const phase = hash01(seed, salt, 9) * Math.PI * 2;
    const out: Vec3[] = [pts[0]];
    let s = 0;
    for (let k = 1; k < pts.length; k++) {
        s += len(sub(pts[k], pts[k - 1]));
        const t = norm(sub(pts[k], pts[k - 1]));
        const u = norm(Math.abs(t[1]) < 0.9 ? cross(t, [0, 1, 0]) : cross(t, [1, 0, 0])), v = cross(t, u);
        const ramp = clamp(s / Math.min(0.03, total * 0.3), 0, 1);
        const a = phase + (s / wave) * Math.PI * 2;
        out.push(add(pts[k], add(scl(u, Math.cos(a) * R * ramp), scl(v, Math.sin(a) * R * ramp))));
    }
    return out;
}

// --- The guide solver ----------------------------------------------------------------------------

export interface HairCollider { sample(x: number, y: number, z: number, grad: number[]): number }

/** Guide strands as particle chains (Müller et al.'s position-based dynamics, small steps). */
export class HairSolver {
    readonly x: Float64Array;
    readonly prev: Float64Array;
    readonly rest: Float64Array;
    readonly held: Uint8Array;
    private seg: Float64Array;
    private bend: Float64Array;
    private grad = [0, 0, 0];
    private frame: Mat4 | null = null;
    private sleep = 0;
    readonly count: number;
    readonly stride = SEGMENTS + 1;

    constructor(guides: Groom[], private hold: number, private radius: Float64Array, private collider: HairCollider, private damping = 2.2) {
        this.count = guides.length;
        const n = this.count * this.stride;
        this.x = new Float64Array(n * 3);
        this.held = new Uint8Array(n);
        guides.forEach((g, i) => g.points.forEach((p, k) => {
            const j = (i * this.stride + k) * 3;
            this.x[j] = p[0]; this.x[j + 1] = p[1]; this.x[j + 2] = p[2];
            if (k < g.held) this.held[i * this.stride + k] = 1;
        }));
        this.prev = Float64Array.from(this.x);
        this.rest = Float64Array.from(this.x);
        this.seg = new Float64Array(n);
        this.bend = new Float64Array(n);
        for (let i = 0; i < this.count; i++) for (let k = 1; k < this.stride; k++) {
            const a = (i * this.stride + k - 1) * 3, b = a + 3;
            this.seg[i * this.stride + k] = Math.sqrt((this.x[b] - this.x[a]) ** 2 + (this.x[b + 1] - this.x[a + 1]) ** 2 + (this.x[b + 2] - this.x[a + 2]) ** 2);
            if (k >= 2) {
                const c = a - 3;
                this.bend[i * this.stride + k] = Math.sqrt((this.x[b] - this.x[c]) ** 2 + (this.x[b + 1] - this.x[c + 1]) ** 2 + (this.x[b + 2] - this.x[c + 2]) ** 2);
            }
        }
    }

    /** Advances `dt` seconds; gravity and wind in the local frame. Returns the largest speed. */
    simulate(dt: number, substeps: number, gravity: Vec3, wind: Vec3): number {
        const h = dt / substeps, X = this.x, P = this.prev, R = this.rest, S = this.stride, g = this.grad;
        const damp = Math.max(0, 1 - this.damping * h);
        let vmax = 0;
        const shift = this.shift;
        this.shift = null;
        for (let s = 0; s < substeps; s++) {
            if (shift) for (let i = 0; i < X.length; i++) { const d = shift[i] / substeps; X[i] += d; P[i] += d; }
            for (let i = 0; i < this.count; i++) for (let k = 0; k < S; k++) {
                const v = i * S + k, j = v * 3;
                if (this.held[v]) continue;
                // Wind drags the hair toward its own speed, more at the tips; a little turbulence.
                const tip = k / (S - 1);
                const gust = wind[0] || wind[1] || wind[2] ? 0.6 + 0.4 * Math.sin(i * 1.7 + s * 0.3) : 0;
                const ax = gravity[0] + (wind[0] * gust - (X[j] - P[j]) / h) * 2.5 * tip;
                const ay = gravity[1] + (wind[1] * gust - (X[j + 1] - P[j + 1]) / h) * 2.5 * tip;
                const az = gravity[2] + (wind[2] * gust - (X[j + 2] - P[j + 2]) / h) * 2.5 * tip;
                const vx = (X[j] - P[j]) * damp, vy = (X[j + 1] - P[j + 1]) * damp, vz = (X[j + 2] - P[j + 2]) * damp;
                P[j] = X[j]; P[j + 1] = X[j + 1]; P[j + 2] = X[j + 2];
                X[j] += vx + ax * h * h; X[j + 1] += vy + ay * h * h; X[j + 2] += vz + az * h * h;
            }
            for (let i = 0; i < this.count; i++) {
                const base = i * S;
                for (let k = 1; k < S; k++) {
                    const v = base + k;
                    // Shape memory: a styled strand springs back toward its groomed place, less toward the tip.
                    if (!this.held[v] && this.hold > 0) {
                        const w = this.hold * (1 - 0.6 * (k / S)) * 0.35;
                        const j = v * 3;
                        X[j] += (R[j] - X[j]) * w; X[j + 1] += (R[j + 1] - X[j + 1]) * w; X[j + 2] += (R[j + 2] - X[j + 2]) * w;
                    }
                    // Length: follow the leader (the parent never moves), so roots hold firmly.
                    const a = (v - 1) * 3, b = v * 3;
                    if (!this.held[v]) {
                        const dx = X[b] - X[a], dy = X[b + 1] - X[a + 1], dz = X[b + 2] - X[a + 2];
                        const L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
                        const f = this.seg[v] / L;
                        X[b] = X[a] + dx * f; X[b + 1] = X[a + 1] + dy * f; X[b + 2] = X[a + 2] + dz * f;
                    }
                    // Bending: keep the span over two segments.
                    if (k >= 2 && !this.held[v]) {
                        const c = (v - 2) * 3;
                        const dx = X[b] - X[c], dy = X[b + 1] - X[c + 1], dz = X[b + 2] - X[c + 2];
                        const L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
                        if (L < this.bend[v]) {
                            const f = (this.bend[v] / L - 1) * 0.35;
                            X[b] += dx * f; X[b + 1] += dy * f; X[b + 2] += dz * f;
                        }
                    }
                    // Collisions: keep off the head, body and clothes.
                    if (!this.held[v]) {
                        const r = this.radius[i];
                        const d = this.collider.sample(X[b], X[b + 1], X[b + 2], g);
                        if (d < r) {
                            const gl = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]) || 1;
                            X[b] += (g[0] / gl) * (r - d); X[b + 1] += (g[1] / gl) * (r - d); X[b + 2] += (g[2] / gl) * (r - d);
                            // Friction against what it rests on.
                            X[b] = lerp(X[b], P[b], 0.3); X[b + 1] = lerp(X[b + 1], P[b + 1], 0.3); X[b + 2] = lerp(X[b + 2], P[b + 2], 0.3);
                        }
                    }
                }
            }
        }
        for (let v = 0, j = 0; v < this.count * S; v++, j += 3) {
            const sp = Math.sqrt((X[j] - P[j]) ** 2 + (X[j + 1] - P[j + 1]) ** 2 + (X[j + 2] - P[j + 2]) ** 2) / h;
            if (sp > vmax) vmax = sp;
        }
        return vmax;
    }

    follow(frame: Mat4): boolean {
        if (!this.frame) { this.frame = frame.slice(); return false; }
        if (sameFrame(this.frame, frame)) return false;
        const old = this.frame;
        this.frame = frame.slice();
        if (Math.sqrt((frame[12] - old[12]) ** 2 + (frame[13] - old[13]) ** 2 + (frame[14] - old[14]) ** 2) > 0.5) return true;
        // Free particles keep their world place (so the hair swings), spread over the next step.
        const m = mulFrame(invertFrame(frame), old);
        const moved = Float64Array.from(this.x);
        applyFrame(m, moved);
        const shift = this.shift ?? (this.shift = new Float64Array(this.x.length));
        addLag(shift, moved, this.x, i => !this.held[i], MAX_LAG);
        return true;
    }
    private shift: Float64Array | null = null;
    get asleep(): boolean { return this.sleep > 30; }
    noteSpeed(v: number, moving: boolean): void { this.sleep = moving || v > 0.02 ? 0 : this.sleep + 1; }
}

// --- Render strands ------------------------------------------------------------------------------

interface Binding {
    /** Fixed frizz offsets per strand point (xyz), precomputed so a frame only interpolates. */
    frizzAt: Float32Array;
    root: Vec3;
    guides: [number, number, number];
    weights: [number, number, number];
    /** Nearest guide, which the tip gathers toward (clumping). */
    clump: number;
    clumpAmount: number;
    rand: number;
    width: number;
    frizz: number;
    salt: number;
}

/**
 * Binds render strands to their three nearest guides by root, among guides combed the same way (the
 * same side of the part, fringe or not), so no strand is an average of two that part company.
 */
function bindStrands(roots: Root[], guideRoots: Root[], o: HairParams, spec: StyleSpec, width: number, group: (q: Vec3) => number): Binding[] {
    const groups = guideRoots.map(r => group(r.q));
    return roots.map((r, i): Binding => {
        const best: [number, number][] = [];
        const mine = group(r.q);
        for (let g = 0; g < guideRoots.length; g++) {
            if (groups[g] !== mine && groups.includes(mine)) continue;
            const d = len(sub(r.p, guideRoots[g].p));
            if (best.length < 3) { best.push([d, g]); best.sort((a, b) => a[0] - b[0]); }
            else if (d < best[2][0]) { best[2] = [d, g]; best.sort((a, b) => a[0] - b[0]); }
        }
        while (best.length < 3) best.push(best[0]);
        const w = best.map(([d]) => 1 / (d * d + 1e-6));
        const ws = w[0] + w[1] + w[2];
        return {
            root: r.p, guides: [best[0][1], best[1][1], best[2][1]], weights: [w[0] / ws, w[1] / ws, w[2] / ws],
            clump: best[0][1], clumpAmount: clamp(0.35 + 0.4 * spec.curl + 0.2 * hash01(o.seed, i, 21), 0, 0.9),
            rand: hash01(o.seed, i, 22), width: width * (0.75 + 0.5 * hash01(o.seed, i, 23)),
            // Frizz in proportion to the hair's length (a buzz cut's few millimetres barely stray).
            frizz: (0.0015 + 0.004 * spec.curl * hash01(o.seed, i, 24)) * clamp(spec.length / 0.15, 0.03, 1),
            salt: i,
            frizzAt: new Float32Array(0),
        };
    }).map(b => {
        const S = SEGMENTS + 1;
        b.frizzAt = new Float32Array(S * 3);
        if (b.frizz > 0) for (let k = 1; k < S; k++) {
            const f = b.frizz * (k / (S - 1));
            b.frizzAt[k * 3] = noise3(b.salt * 1.3, k * 0.7, 0.5) * f;
            b.frizzAt[k * 3 + 1] = noise3(b.salt * 1.3, k * 0.7, 3.5) * f;
            b.frizzAt[k * 3 + 2] = noise3(b.salt * 1.3, k * 0.7, 7.5) * f;
        }
        return b;
    });
}

/**
 * Writes every render strand's ribbon: positions and normals for two vertices per strand point.
 * `guide(i, k)` reads guide i's point k.
 */
function writeRibbons(binds: Binding[], gx: Float64Array, stride: number, F: { center: Vec3 }, push: ((p: number[], r: number) => void) | null, pos: Float32Array, nrm: Float32Array): void {
    const S = SEGMENTS + 1;
    const pts = new Float64Array(S * 3);
    const c = F.center;
    for (let s = 0; s < binds.length; s++) {
        const b = binds[s];
        // The strand: its root plus the guides' offsets from theirs, gathering toward one guide at the tip.
        for (let k = 0; k < S; k++) {
            const t = k / (S - 1);
            const cl = b.clumpAmount * t * t;
            let x = b.root[0], y = b.root[1], z = b.root[2];
            for (let m = 0; m < 3; m++) {
                const gi = b.guides[m];
                const w = b.weights[m] * (1 - cl) + (gi === b.clump ? cl : 0);
                const j = (gi * stride + k) * 3, j0 = gi * stride * 3;
                x += (gx[j] - gx[j0]) * w; y += (gx[j + 1] - gx[j0 + 1]) * w; z += (gx[j + 2] - gx[j0 + 2]) * w;
            }
            x += b.frizzAt[k * 3]; y += b.frizzAt[k * 3 + 1]; z += b.frizzAt[k * 3 + 2];
            pts[k * 3] = x; pts[k * 3 + 1] = y; pts[k * 3 + 2] = z;
        }
        // The ribbon lies across the hair's surface: its width perpendicular to the strand and to
        // the direction out from the head (horizontal for hair hanging below it). A strand shorter
        // than a few ribbon widths keeps one width direction, so it can't twist.
        let span = 0;
        for (let k = 1; k < S; k++) span += Math.sqrt((pts[k * 3] - pts[k * 3 - 3]) ** 2 + (pts[k * 3 + 1] - pts[k * 3 - 2]) ** 2 + (pts[k * 3 + 2] - pts[k * 3 - 1]) ** 2);
        const rigid = span < b.width * 12;
        // Interpolated strands can cut into the head between their guides: lift them back onto
        // the hair's layer (not short strands, which lie as their guides do).
        if (push && !rigid) { const tmp = [0, 0, 0]; for (let k = 1; k < S; k++) { tmp[0] = pts[k * 3]; tmp[1] = pts[k * 3 + 1]; tmp[2] = pts[k * 3 + 2]; push(tmp, 0.001 + 0.002 * b.rand); pts[k * 3] = tmp[0]; pts[k * 3 + 1] = tmp[1]; pts[k * 3 + 2] = tmp[2]; } }
        let fx = 0, fy = 0, fz = 0;
        if (rigid) {
            const tx = pts[(S - 1) * 3] - pts[0], ty = pts[(S - 1) * 3 + 1] - pts[1], tz = pts[(S - 1) * 3 + 2] - pts[2];
            const ox = pts[0] - c[0], oy = pts[1] - c[1], oz = pts[2] - c[2];
            fx = ty * oz - tz * oy; fy = tz * ox - tx * oz; fz = tx * oy - ty * ox;
            const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1; fx /= fl; fy /= fl; fz /= fl;
        }
        let lbx = 0, lby = 0, lbz = 0;
        for (let k = 0; k < S; k++) {
            const a = Math.max(0, k - 1), bb = Math.min(S - 1, k + 1);
            let tx = pts[bb * 3] - pts[a * 3], ty = pts[bb * 3 + 1] - pts[a * 3 + 1], tz = pts[bb * 3 + 2] - pts[a * 3 + 2];
            const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1; tx /= tl; ty /= tl; tz /= tl;
            const px = pts[k * 3], py = pts[k * 3 + 1], pz = pts[k * 3 + 2];
            let ox = px - c[0], oy = py - Math.min(py, c[1]), oz = pz - c[2];
            const ol = Math.sqrt(ox * ox + oy * oy + oz * oz) || 1; ox /= ol; oy /= ol; oz /= ol;
            let bx = rigid ? fx : ty * oz - tz * oy, by = rigid ? fy : tz * ox - tx * oz, bz = rigid ? fz : tx * oy - ty * ox;
            const bl = Math.sqrt(bx * bx + by * by + bz * bz);
            // Where the strand points straight out (a bun's coil) the width is undefined: keep the
            // last one. And never turn it over between points, so a ribbon can't twist.
            if (bl < 0.15 && k > 0) { bx = lbx; by = lby; bz = lbz; }
            else if (bl < 1e-6) { bx = 1; by = 0; bz = 0; }
            else { bx /= bl; by /= bl; bz /= bl; }
            if (k > 0 && bx * lbx + by * lby + bz * lbz < 0) { bx = -bx; by = -by; bz = -bz; }
            lbx = bx; lby = by; lbz = bz;
            let nx = by * tz - bz * ty, ny = bz * tx - bx * tz, nz = bx * ty - by * tx;
            const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (nl > 1e-9) { nx /= nl; ny /= nl; nz /= nl; } else { nx = ox; ny = oy; nz = oz; }
            const w = b.width * (1 - 0.65 * (k / (S - 1))) * 0.5;
            const v = (s * S + k) * 2;
            pos[v * 3] = px - bx * w; pos[v * 3 + 1] = py - by * w; pos[v * 3 + 2] = pz - bz * w;
            pos[v * 3 + 3] = px + bx * w; pos[v * 3 + 4] = py + by * w; pos[v * 3 + 5] = pz + bz * w;
            nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz;
            nrm[v * 3 + 3] = nx; nrm[v * 3 + 4] = ny; nrm[v * 3 + 5] = nz;
        }
    }
}

function ribbonPart(region: string, binds: Binding[], pos: Float32Array, nrm: Float32Array): Part {
    const S = SEGMENTS + 1;
    const part = newPart(region);
    part.positions = Array.from(pos);
    part.normals = Array.from(nrm);
    const uvs = new Array(binds.length * S * 4);
    const idx: number[] = [];
    for (let s = 0; s < binds.length; s++) for (let k = 0; k < S; k++) {
        const v = (s * S + k) * 2;
        uvs[v * 2] = binds[s].rand; uvs[v * 2 + 1] = k / (S - 1);
        uvs[v * 2 + 2] = binds[s].rand; uvs[v * 2 + 3] = k / (S - 1);
        if (k < S - 1) idx.push(v, v + 1, v + 3, v, v + 3, v + 2);
    }
    part.uvs = uvs;
    part.indices = idx;
    return part;
}

// --- Short static strands: brows, lashes, beard --------------------------------------------------

/** Static strands as ribbons: each a list of points, a width and a random. */
function strandsPart(region: string, strands: { pts: Vec3[]; width: number; rand: number; out: Vec3 }[]): Part {
    const part = newPart(region);
    for (const st of strands) {
        const n = st.pts.length;
        const base = part.positions.length / 3;
        for (let k = 0; k < n; k++) {
            const t = norm(sub(st.pts[Math.min(n - 1, k + 1)], st.pts[Math.max(0, k - 1)]));
            let b = norm(cross(t, st.out));
            let nn = norm(cross(b, t));
            if (dot(nn, st.out) < 0) { nn = scl(nn, -1); b = scl(b, -1); }
            const w = st.width * (1 - 0.8 * (k / (n - 1))) * 0.5;
            const p = st.pts[k];
            part.positions.push(p[0] - b[0] * w, p[1] - b[1] * w, p[2] - b[2] * w, p[0] + b[0] * w, p[1] + b[1] * w, p[2] + b[2] * w);
            part.normals.push(...nn, ...nn);
            part.uvs.push(st.rand, k / (n - 1), st.rand, k / (n - 1));
            if (k < n - 1) { const v = base + k * 2; part.indices.push(v, v + 1, v + 3, v, v + 3, v + 2); }
        }
    }
    return part;
}

/** A short curved strand from `p` leaving along `d`, bending toward `bend`. */
function shortStrand(p: Vec3, d: Vec3, bend: Vec3, length: number, steps = 4): Vec3[] {
    const pts: Vec3[] = [p];
    let q = p, dir = norm(d);
    for (let k = 1; k <= steps; k++) {
        dir = norm(add(dir, scl(bend, 0.35)));
        q = add(q, scl(dir, length / steps));
        pts.push(q);
    }
    return pts;
}

function brows(h: FigureHandle, F: HeadFrame, o: HairParams, head: (x: number, y: number, z: number) => number): Part {
    const strands: { pts: Vec3[]; width: number; rand: number; out: Vec3 }[] = [];
    const R = rng(o.seed * 13 + 1);
    const count = Math.round(90 + 110 * clamp(o.brows, 0, 1));
    const m = h.params.masculinity;
    for (const sd of [1, -1]) {
        for (let i = 0; i < count; i++) {
            // Along the brow from the inner end to the tail: an arch, thicker at the inner end.
            const t = R();
            const x = sd * lerp(0.011, 0.056, t);
            const archY = 0.021 + 0.007 * Math.sin(Math.PI * Math.min(1, t * 1.25)) - 0.006 * t * t + (m - 0.5) * -0.003;
            const thick = (0.0045 + 0.004 * clamp(o.brows, 0, 1)) * (1 - 0.55 * t);
            const y = archY + (R() - 0.5) * thick;
            const q = F.P(x, y, 0.15);
            const dir = F.D(x, y - 0.02, 0.15);
            // Ray in from the front onto the brow.
            const p = trace(head, q, scl(F.D(0, 0, 1), -1), 0.14);
            if (!p) continue;
            void dir;
            const out = F.D(sd * 0.25, 0.1, 1);
            // Inner hairs point up, the rest sweep outward along the arch.
            const along = F.D(sd, t < 0.2 ? 1.6 : 0.25 - 0.3 * t, 0.15);
            const length = (0.007 + 0.004 * R()) * (0.8 + 0.5 * clamp(o.brows, 0, 1));
            strands.push({ pts: shortStrand(add(p, scl(out, 0.0003)), along, scl(out, -0.6), length, 3), width: 0.0009, rand: R(), out });
        }
    }
    return strandsPart("brows", strands);
}

function lashes(h: FigureHandle, F: HeadFrame, o: HairParams): Part {
    const strands: { pts: Vec3[]; width: number; rand: number; out: Vec3 }[] = [];
    const eg = eyeGeometry(h.params);
    const R = rng(o.seed * 17 + 3);
    const m = h.params.masculinity;
    for (const sd of [1, -1]) {
        const ec: Vec3 = [sd * eg.x, 0, eg.z];
        const a = eg.r * 1.1 * eg.open, b = eg.r * 0.35 * eg.open, Rr = eg.r + 0.0016;
        for (const upper of [true, false]) {
            const n = upper ? 46 : 14;
            for (let i = 0; i < n; i++) {
                const u = (i + R() * 0.6) / n;
                const phi = upper ? Math.PI * (0.06 + 0.88 * u) : Math.PI * (1.12 + 0.76 * u);
                const tilt = sd * 7 * Math.PI / 180;
                let lx = Math.cos(phi) * a, ly = Math.sin(phi) * b - 0.0004;
                [lx, ly] = [lx * Math.cos(tilt) - ly * Math.sin(tilt), lx * Math.sin(tilt) + ly * Math.cos(tilt)];
                const lz = Math.sqrt(Math.max(0, Rr * Rr - lx * lx - ly * ly));
                const p = F.P(ec[0] + lx, ec[1] + ly, ec[2] + lz);
                const out = F.D(lx * 0.6, ly * 0.6, lz);
                const centre = 1 - Math.abs(u - 0.6) * 1.2;
                const length = (upper ? 0.0085 : 0.0034) * (0.7 + 0.4 * centre) * lerp(1.08, 0.88, m);
                const curlDir = F.D(0, upper ? 1 : -1, -0.2);
                const leave = F.D(lx * 0.5 + sd * 0.0005, (upper ? 0.35 : -0.3) * eg.r + ly * 0.3, lz * 1.1);
                strands.push({ pts: shortStrand(p, leave, curlDir, length, 4), width: upper ? 0.00045 : 0.0003, rand: R(), out });
            }
        }
    }
    return strandsPart("lashes", strands);
}

function beard(h: FigureHandle, F: HeadFrame, o: HairParams, head: (x: number, y: number, z: number) => number): Part | null {
    if (o.beard === "none") return null;
    const strands: { pts: Vec3[]; width: number; rand: number; out: Vec3 }[] = [];
    const R = rng(o.seed * 19 + 5);
    const L = o.beard === "stubble" ? 0.0018 : o.beard === "short" ? 0.009 : o.beard === "full" ? 0.03 : 0.012;
    const count = o.beard === "stubble" ? 5000 : o.beard === "mustache" ? 700 : 2600;
    for (let i = 0; i < count * 3 && strands.length < count; i++) {
        // Candidate directions over the lower face from the head's center.
        const ax = (R() - 0.5) * 2.4, ay = -0.15 - R() * 1.25;
        const dl = norm([ax, ay, 0.55 + R() * 0.6]);
        const dir = F.D(dl[0], dl[1], dl[2]);
        const c = F.P(0, -0.04, -0.01);
        const p = trace(head, add(c, scl(dir, 0.2)), scl(dir, -1), 0.18);
        if (!p) continue;
        const q = F.local(p);
        // The beard's region: jaw, chin, cheeks below the cheekbones, the upper lip; not the lips.
        const mouth = Math.hypot(q[0] / 0.026, (q[1] + 0.07) / 0.011);
        const upperLip = q[1] > -0.065 && q[1] < -0.05 && Math.abs(q[0]) < 0.03 && q[2] > 0.06;
        const cheek = q[1] < -0.025 - Math.abs(q[0]) * 0.15 && Math.abs(q[0]) < 0.068 && q[2] > -0.035;
        const neckLine = q[1] > -0.135 + Math.max(0, -q[2]) * 0.3;
        const isMustache = upperLip && mouth > 1.0;
        const ok = o.beard === "mustache" ? isMustache : (isMustache || (cheek && neckLine && mouth > 1.15 && !(q[1] > -0.05 && Math.abs(q[0]) < 0.035)));
        if (!ok) continue;
        const n = normalAt(head, p);
        const downish = norm(add(F.D(Math.sign(q[0]) * 0.3, -1, 0.15), scl(n, 0.4)));
        const len = L * (0.7 + 0.6 * R()) * (isMustache && o.beard === "full" ? 0.6 : 1);
        strands.push({ pts: shortStrand(add(p, scl(n, 0.0002)), add(scl(n, 0.6), downish), F.D(0, -1, 0.1), len, o.beard === "stubble" ? 1 : 4), width: o.beard === "stubble" ? 0.0007 : 0.0011, rand: R(), out: n });
    }
    return strandsPart("beard", strands);
}

// --- The cap under the hair ------------------------------------------------------------------------

/** A thin shell over the scalp inside the hairline, hair-colored, so the scalp never shows pale. */
function scalpCap(h: FigureHandle, F: HeadFrame, recession: number, detail: number): Part | null {
    const headNode = h.segments.head;
    // A little inside the hairline, so the roots there cover its edge.
    const region = custom([-50, -50, -50, 50, 50, 50], (x, y, z) => (0.006 - onScalp(F.local([x, y, z]), recession)) * F.hu);
    const cap = intersect(offset(headNode, 0.0009), region);
    const b = cap.box;
    const cell = 0.0032 * clamp(detail, 0.6, 2.5);
    const fm = meshField(cap, { box: [b[0] - 0.01, b[1] - 0.01, b[2] - 0.01, b[3] + 0.01, b[4] + 0.01, b[5] + 0.01], size: cell, lipschitz: 1.4 });
    if (!fm.indices.length) return null;
    const part = newPart("hairCap");
    part.positions = fm.positions;
    part.normals = fm.normals;
    part.uvs = new Array((fm.positions.length / 3) * 2).fill(0).map((_, i) => (i % 2 ? 0 : 0.5));
    part.indices = fm.indices;
    return part;
}

// --- Assembling ----------------------------------------------------------------------------------

export interface HairResult {
    mesh: Mesh;
    guides: number;
    strands: number;
    solver: HairSolver | null;
}

const GRAVITY: Vec3 = [0, -9.81, 0];
/** The most a part may lag behind its figure in one frame (a sudden turn carries the rest along). */
const MAX_LAG = 0.06;

/** Grows, styles and settles a figure's hair; `under` is the body with its clothes, for hair to rest on. */
export function growHair(h: FigureHandle, under: SdfNode, params: Partial<HairParams> = {}): HairResult {
    const o: HairParams = { ...DEFAULT_HAIR, ...params };
    const F = headFrame(h);
    const headField = fieldOf(h.segments.head);
    const parts: Part[] = [];
    if (o.lashes) parts.push(lashes(h, F, o));
    parts.push(brows(h, F, o, headField));
    const bd = beard(h, F, o, headField);
    if (bd) parts.push(bd);
    if (o.style === "none") return { mesh: { parts }, guides: 0, strands: 0, solver: null };
    const spec: StyleSpec = { ...STYLES[o.style] };
    spec.curl = clamp(Math.max(spec.curl, o.curl), 0, 1);
    const recession = h.params.masculinity > 0.7 ? 0.004 : 0;
    const cap = scalpCap(h, F, recession, o.detail);
    if (cap) parts.push(cap);
    const detail = clamp(o.detail, 0.6, 2.5);
    // Collisions: the body and clothes, near the head finely.
    const hb = h.box;
    const box: Box = [hb[0] - 0.5, Math.max(-0.05, hb[1]), hb[2] - 0.5, hb[3] + 0.5, hb[4] + 0.3, hb[5] + 0.5];
    const grid = new LazyGrid(under, box, 0.005);
    const g = [0, 0, 0];
    const collide = (p: Vec3, r: number): Vec3 => {
        const d = grid.sample(p[0], p[1], p[2], g);
        if (d >= r) return p;
        const gl = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]) || 1;
        return [p[0] + g[0] / gl * (r - d), p[1] + g[1] / gl * (r - d), p[2] + g[2] / gl * (r - d)];
    };
    // Guides.
    const guideCount = Math.round((o.style === "buzz" ? 120 : o.style === "afro" ? 420 : 300) / detail);
    const guideRoots = scalpRoots(h, F, guideCount, o.seed, recession, headField);
    const tieAt = spec.tie === "bun" ? add(F.P(0, 0.075, -0.115), scl(F.D(0, 0.3, -1), 0.012)) : F.P(0, 0.035, -0.12);
    const length = spec.length * clamp(o.length, 0.3, 2.2) * (h.scale / 0.97);
    const ctx: GroomContext = { F, spec, o, length, collide, surface: (p, gg) => grid.sample(p[0], p[1], p[2], gg), tieAt, partX: o.part === "center" ? 0 : o.part === "side" ? 0.032 * (hash01(o.seed, 1, 1) < 0.5 ? 1 : -1) : 0 };
    const guides = guideRoots.map((r, i) => {
        const gr = groom(r, ctx, i);
        const pts = spec.tie === "bun" ? gr.points : curlPath(gr.points, spec.curl, o.seed, i);
        return { points: pts, held: gr.held, fringe: gr.fringe };
    });
    const radius = new Float64Array(guides.length).map((_, i) => 0.002 + (spec.volume * 0.5 + o.volume * 0.5) * 0.009 * (0.5 + 0.5 * hash01(o.seed, i, 41)));
    const solver = new HairSolver(guides, spec.hold, radius, { sample: (x, y, z, gg) => grid.sample(x, y, z, gg) });
    const wind: Vec3 = scl(norm([0.6, 0, 1]), o.wind);
    const frames = spec.hold >= 0.95 ? 0 : Math.round(clamp(o.settle, 0, 300));
    for (let f = 0; f < frames; f++) solver.simulate(1 / 60, 5, GRAVITY, wind);
    solver.prev.set(solver.x);
    // The cut, made on the hanging hair as a stylist would: at the style's hem (longer in front
    // for an A-line) and, for a fringe, just above the brows. Then the shorter hair relaxes.
    let final = solver;
    if ((spec.hem !== null || guides.some(gd => gd.fringe)) && !spec.tie) {
        const hem = spec.hem;
        const trimmed = guides.map((gd, i) => {
            const pts: Vec3[] = [];
            for (let k = 0; k <= SEGMENTS; k++) { const j = (i * solver.stride + k) * 3; pts.push([solver.x[j], solver.x[j + 1], solver.x[j + 2]]); }
            const beyond = (pt: Vec3) => {
                const l = F.local(pt);
                let v = Infinity;
                if (hem !== null) v = l[1] - (hem * Math.max(0.5, o.length) - spec.aline * l[2] * 0.6);
                if (gd.fringe) v = Math.min(v, l[1] - 0.03);
                return v;
            };
            let total = 0;
            for (let k = 1; k <= SEGMENTS; k++) {
                const seg = len(sub(pts[k], pts[k - 1]));
                const a = beyond(pts[k - 1]), b = beyond(pts[k]);
                if (b < 0 && k > gd.held) {
                    const t = a > 0 ? a / (a - b) : 0;
                    const keep = Math.max(total + seg * t, 0.012);
                    return { points: resample(pts, keep), held: gd.held, fringe: gd.fringe };
                }
                total += seg;
            }
            return { points: pts, held: gd.held, fringe: gd.fringe };
        });
        final = new HairSolver(trimmed, spec.hold, radius, { sample: (x, y, z, gg) => grid.sample(x, y, z, gg) });
        for (let f = 0; f < Math.min(frames, 15); f++) final.simulate(1 / 60, 6, GRAVITY, wind);
        final.prev.set(final.x);
    }
    // Render strands, interpolated from the settled guides.
    const strandCount = Math.round((o.style === "buzz" ? 6000 : o.style === "afro" ? 5200 : 4200) * clamp(o.density, 0.2, 3) / detail);
    const roots = scalpRoots(h, F, strandCount, o.seed + 101, recession, headField);
    // Each ribbon stands for a lock of hairs: wide enough not to fall between a screen's pixels.
    const width = (o.style === "buzz" ? 0.0013 : 0.0042) * Math.sqrt(4200 / Math.max(500, strandCount)) * (o.style === "afro" ? 1.25 : 1);
    const group = (q: Vec3) => {
        const fringe = o.bangs > 0.2 && q[2] > 0.035 && q[1] > 0.045 && Math.abs(q[0]) < 0.06 ? 2 : 0;
        return fringe + (o.part === "back" || spec.tie ? 0 : q[0] >= ctx.partX ? 1 : 0);
    };
    const binds = bindStrands(roots, guideRoots, o, spec, width, group);
    const S = SEGMENTS + 1;
    const pos = new Float32Array(binds.length * S * 6), nrm = new Float32Array(binds.length * S * 6);
    const push = (p: number[], r: number) => { const q = collide(p as Vec3, r); p[0] = q[0]; p[1] = q[1]; p[2] = q[2]; };
    writeRibbons(binds, final.x, final.stride, F, push, pos, nrm);
    const hair = ribbonPart("hair", binds, pos, nrm);
    // In the viewport the guides keep moving.
    // Live, the hair collides on the grid it was groomed against (already filled where it hangs).
    attachDynamic(hair, hairSource(final, binds, F, () => ({ sample: (x, y, z, gg) => grid.sample(x, y, z, gg) }), spec.hold));
    parts.push(hair);
    return { mesh: { parts }, guides: guides.length, strands: binds.length, solver: final };
}

function hairSource(base: HairSolver, binds: Binding[], F: HeadFrame, collider: () => HairCollider, hold: number): DynamicSource {
    const x0 = Float64Array.from(base.x);
    const held = base.held.slice();
    const radius = (base as unknown as { radius: Float64Array }).radius;
    return {
        kind: "hair",
        spawn(): Simulator {
            const guides: Groom[] = [];
            for (let i = 0; i < base.count; i++) {
                const pts: Vec3[] = [];
                let h = 0;
                for (let k = 0; k < base.stride; k++) {
                    const j = (i * base.stride + k) * 3;
                    pts.push([x0[j], x0[j + 1], x0[j + 2]]);
                    if (held[i * base.stride + k]) h = k + 1;
                }
                guides.push({ points: pts, held: h });
            }
            // The settled shape is the rest shape; styled hair springs back to it.
            const sol = new HairSolver(guides, Math.max(hold, 0.04), radius, collider());
            const S = SEGMENTS + 1;
            const positions = new Float32Array(binds.length * S * 6), normals = new Float32Array(binds.length * S * 6);
            writeRibbons(binds, sol.x, sol.stride, F, null, positions, normals);
            return {
                vertexCount: binds.length * S * 2, positions, normals,
                step(dt, frame, windWorld) {
                    const moved = sol.follow(frame);
                    const inv = invertFrame(frame);
                    const windy = Math.hypot(...windWorld) > 0.01;
                    if (sol.asleep && !moved && !windy) return false;
                    const v = sol.simulate(Math.min(dt, 1 / 30), 3, localDirection(inv, GRAVITY) as Vec3, localDirection(inv, windWorld) as Vec3);
                    sol.noteSpeed(v, moved || windy);
                    writeRibbons(binds, sol.x, sol.stride, F, null, positions, normals);
                    return true;
                },
            };
        },
    };
}

