// Small vector and random helpers for Nebula Kingdom. Positions are kilometres in doubles: the
// game spans a moon to a hypergiant, and a double holds that with room to spare.

export type V3 = [number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const norm = (a: V3, fallback: V3 = [0, 0, 1]): V3 => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [...fallback]; };
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const clamp = (v: number, lo = 0, hi = 1): number => (v < lo ? lo : v > hi ? hi : v);
export const smooth = (a: number, b: number, v: number): number => { const t = clamp((v - a) / (b - a)); return t * t * (3 - 2 * t); };
/** Moves `a` toward `b` by at most `step`. */
export const approach = (a: number, b: number, step: number): number => (a < b ? Math.min(b, a + step) : Math.max(b, a - step));

/** Forward for a yaw about +Y (0 faces +Z) and a pitch (positive: nose up). */
export const forwardOf = (yaw: number, pitch: number): V3 => [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];

/** Right and up for a forward vector (world up +Y; steady when looking straight up or down). */
export function basis(f: V3): { right: V3; up: V3 } {
    let r = cross([0, 1, 0], f);
    if (len(r) < 1e-6) r = [1, 0, 0];
    r = norm(r);
    return { right: r, up: norm(cross(f, r)) };
}

/** Distance from point p to the segment a-b. */
export function segmentDistance(p: V3, a: V3, b: V3): number {
    const ab = sub(b, a), l2 = dot(ab, ab);
    const t = l2 > 0 ? clamp(dot(sub(p, a), ab) / l2) : 0;
    return dist(p, add(a, mul(ab, t)));
}

export function hashString(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

/** A seeded generator (mulberry32): the same seed always builds the same region. */
export class Rng {
    private s: number;
    constructor(seed: number | string) { this.s = (typeof seed === "string" ? hashString(seed) : seed) >>> 0 || 1; }
    next(): number {
        let t = (this.s += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    range(a: number, b: number): number { return a + (b - a) * this.next(); }
    int(a: number, b: number): number { return Math.floor(this.range(a, b + 1)); }
    pick<T>(items: readonly T[]): T { return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))]; }
    /** A uniformly random direction. */
    dir(): V3 {
        const z = this.range(-1, 1), a = this.range(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
        return [r * Math.cos(a), z, r * Math.sin(a)];
    }
    /** A point inside the unit ball. */
    ball(): V3 { return mul(this.dir(), Math.cbrt(this.next())); }
}
