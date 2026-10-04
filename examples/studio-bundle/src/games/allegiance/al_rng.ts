// Seeded randomness for Allegiance. Everything that rolls dice (the daily world tick, the AI, the
// speech mini-game, pedestrians) takes an Rng, so a campaign replays the same way from a save and
// the tests are deterministic. The state is one 32-bit number, kept in the save file.

export interface Rng {
    /** Uniform in [0, 1). */
    next(): number;
    /** The current state (to save and restore). */
    state(): number;
}

/** mulberry32: small, fast, and good enough for games. */
export function makeRng(seed: number): Rng {
    let a = seed >>> 0;
    return {
        next() {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        },
        state: () => a,
    };
}

export const range = (r: Rng, lo: number, hi: number): number => lo + (hi - lo) * r.next();
export const int = (r: Rng, lo: number, hiInclusive: number): number => lo + Math.floor(r.next() * (hiInclusive - lo + 1));
export const chance = (r: Rng, p: number): boolean => r.next() < p;
export function pick<T>(r: Rng, items: readonly T[]): T {
    return items[Math.floor(r.next() * items.length) % items.length];
}

/** Picks an index with probability proportional to its weight (all zero: uniform). */
export function weighted(r: Rng, weights: readonly number[]): number {
    const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
    if (total <= 0) return Math.floor(r.next() * weights.length);
    let x = r.next() * total;
    for (let i = 0; i < weights.length; i++) {
        x -= Math.max(0, weights[i]);
        if (x < 0) return i;
    }
    return weights.length - 1;
}

/** A normally distributed sample (Box-Muller). */
export function gauss(r: Rng, mean = 0, sd = 1): number {
    const u = Math.max(1e-12, r.next()), v = r.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** A stable 32-bit hash of a string (FNV-1a), for seeding things by name. */
export function hashString(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
