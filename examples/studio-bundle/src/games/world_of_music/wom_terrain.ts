// An island built from a LevelDef: a noisy base that falls into the sea, plateaus and ring walls
// with cliff edges, ramps, hollows. Heights are cached on a 1 m grid; walking, climbing, flying
// and phasing Tones each get their own idea of what is passable, and A* over a 2 m grid finds
// their way. Pure (tests use it); the mesh comes out in the engine's `mesh` vertex layout.

import type { LevelDef, Plateau } from "./wom_data";
import { Rng } from "../nebula/nk_math";

export const SEA = 0;
/** Water deeper than this stops walkers (Tom wades the shallows). */
export const DEEP = -0.7;
/** A walker climbs at most this much per metre. */
export const MAX_GRADE = 1.15;
/** A flier hops ledges up to this height. */
export const FLY_LEDGE = 3.6;
export const NAV_CELL = 2;

export interface Mover { climb: boolean; fly: boolean; phase: boolean }
export const WALKER: Mover = { climb: false, fly: false, phase: false };

const smoothstep = (a: number, b: number, v: number) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

function valueNoise(seed: number) {
    const rng = new Rng(seed);
    const perm = new Float32Array(512);
    for (let i = 0; i < 512; i++) perm[i] = rng.next();
    const h = (x: number, z: number) => perm[((x * 73856093) ^ (z * 19349663)) & 511];
    return (x: number, z: number) => {
        const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
        const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
        const a = h(xi, zi), b = h(xi + 1, zi), c = h(xi, zi + 1), d = h(xi + 1, zi + 1);
        return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };
}

/** How much a plateau covers (x, z): 1 on top, 0 off it, a ramp across its edge. */
export function plateauMask(p: Plateau, x: number, z: number): number {
    const dx = x - p.x, dz = z - p.z;
    let m: number;
    if (p.r !== undefined) {
        const d = Math.hypot(dx, dz);
        m = smoothstep(p.r, p.r - p.edge, d);
        if (p.ri !== undefined) {
            m *= smoothstep(p.ri, p.ri + p.edge, d);
            if (p.gap !== undefined) {
                // The opening: arc length from the gap's direction, at this radius.
                let da = Math.atan2(dz, dx) - p.gap;
                da = Math.atan2(Math.sin(da), Math.cos(da));
                const arc = Math.abs(da) * d;
                m *= smoothstep((p.gapW ?? 8) / 2, (p.gapW ?? 8) / 2 + p.edge, arc);
            }
        }
    } else {
        const hw = (p.w ?? 10) / 2, hd = (p.d ?? 10) / 2;
        m = smoothstep(hw, hw - p.edge, Math.abs(dx)) * smoothstep(hd, hd - p.edge, Math.abs(dz));
    }
    return m;
}

export class Terrain {
    readonly size: number;
    readonly half: number;
    /** Heights on a 1 m grid, (size + 1)^2, corner at (-half, -half). */
    readonly heights: Float32Array;
    /** 1 where a teal-marked (climbable) cliff face is. */
    readonly climbMask: Float32Array;
    readonly n: number;
    private noise: (x: number, z: number) => number;
    /** Gates: segments that block everything while closed (the game owns open/closed). */
    blockers: { ax: number; az: number; bx: number; bz: number; open: boolean; id: string }[] = [];

    constructor(readonly level: LevelDef) {
        this.size = level.size;
        this.half = level.size / 2;
        this.n = level.size + 1;
        this.noise = valueNoise(level.seed);
        this.heights = new Float32Array(this.n * this.n);
        this.climbMask = new Float32Array(this.n * this.n);
        for (let j = 0; j < this.n; j++) for (let i = 0; i < this.n; i++) {
            const x = i - this.half, z = j - this.half;
            this.heights[j * this.n + i] = this.raw(x, z);
        }
        // Climbable faces: steep cells of a plateau marked `climb`.
        for (let j = 1; j < this.n - 1; j++) for (let i = 1; i < this.n - 1; i++) {
            const x = i - this.half, z = j - this.half;
            const g = Math.max(Math.abs(this.heights[j * this.n + i + 1] - this.heights[j * this.n + i - 1]), Math.abs(this.heights[(j + 1) * this.n + i] - this.heights[(j - 1) * this.n + i])) / 2;
            if (g < 0.8) continue;
            for (const p of level.plateaus) if (p.climb && plateauMask({ ...p, edge: p.edge + 2.5, r: p.r !== undefined ? p.r + 1.2 : undefined, w: p.w !== undefined ? p.w + 2.4 : undefined, d: p.d !== undefined ? p.d + 2.4 : undefined }, x, z) > 0.01) this.climbMask[j * this.n + i] = 1;
        }
    }

    /** The island's base: gently rolling, falling into the sea past ~45% of the size. */
    base(x: number, z: number): number {
        const r = Math.hypot(x, z * 1.08) / this.half;
        const rolling = (this.noise(x / 23, z / 23) - 0.5) * 2.2 + (this.noise(x / 9 + 40, z / 9) - 0.5) * 0.6;
        const land = 1.8 + rolling;
        const shore = smoothstep(0.84, 1.0, r);
        // The spawn beach slopes gently into the water.
        return land * (1 - shore) + (-5) * shore;
    }

    private plateauHeight(x: number, z: number): number {
        let h = this.base(x, z);
        let up = 0;
        for (const p of this.level.plateaus) up = Math.max(up, p.h * plateauMask(p, x, z));
        h += up;
        for (const w of this.level.hollows) h -= w.depth * smoothstep(w.r, w.r * 0.55, Math.hypot(x - w.x, z - w.z));
        return h;
    }

    raw(x: number, z: number): number {
        let h = this.plateauHeight(x, z);
        for (const r of this.level.ramps) {
            const ax = r.from[0], az = r.from[1], bx = r.to[0], bz = r.to[1];
            const lx = bx - ax, lz = bz - az, l2 = lx * lx + lz * lz;
            const t = Math.max(0, Math.min(1, ((x - ax) * lx + (z - az) * lz) / l2));
            const px = ax + lx * t, pz = az + lz * t, d = Math.hypot(x - px, z - pz);
            const along = ((x - ax) * lx + (z - az) * lz) / l2;
            if (along < -0.05 || along > 1.08) continue;
            const m = smoothstep(r.w / 2 + 0.6, r.w / 2 - 0.4, d);
            if (m <= 0) continue;
            const lo = this.plateauHeight(ax, az), hi = this.plateauHeight(bx, bz);
            const rampH = lo + (hi - lo) * smoothstep(0, 1, t);
            h = h + (rampH - h) * m;
        }
        return h;
    }

    /** Bilinear height at (x, z) from the 1 m cache. */
    height(x: number, z: number): number {
        const fx = Math.max(0, Math.min(this.size - 1e-3, x + this.half)), fz = Math.max(0, Math.min(this.size - 1e-3, z + this.half));
        const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, n = this.n, H = this.heights;
        const a = H[j * n + i], b = H[j * n + i + 1], c = H[(j + 1) * n + i], d = H[(j + 1) * n + i + 1];
        return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    }

    /** The ground or the water surface, whichever is higher (what feet stand on). */
    surface(x: number, z: number): number { return Math.max(this.height(x, z), SEA); }

    normal(x: number, z: number): [number, number, number] {
        const e = 0.6;
        const dx = this.height(x + e, z) - this.height(x - e, z), dz = this.height(x, z + e) - this.height(x, z - e);
        const l = Math.hypot(dx, 2 * e, dz);
        return [-dx / l, (2 * e) / l, -dz / l];
    }

    /** The ground's steepness at (x, z): rise per metre. */
    grade(x: number, z: number): number {
        const e = 0.5;
        return Math.hypot(this.height(x + e, z) - this.height(x - e, z), this.height(x, z + e) - this.height(x, z - e)) / (2 * e);
    }

    climbable(x: number, z: number): boolean {
        const i = Math.round(x + this.half), j = Math.round(z + this.half);
        if (i < 0 || j < 0 || i >= this.n || j >= this.n) return false;
        return this.climbMask[j * this.n + i] > 0;
    }

    inBounds(x: number, z: number): boolean { return Math.abs(x) < this.half - 2 && Math.abs(z) < this.half - 2; }

    /** Whether a closed gate's segment crosses the move a -> b (or b is within `pad` of it). */
    gateBlocks(ax: number, az: number, bx: number, bz: number, pad = 0.6): boolean {
        for (const g of this.blockers) {
            if (g.open) continue;
            if (segDist(bx, bz, g.ax, g.az, g.bx, g.bz) < pad) return true;
            if (segmentsCross(ax, az, bx, bz, g.ax, g.az, g.bx, g.bz)) return true;
        }
        return false;
    }

    /** Can a mover step from a to b (a short step)? Downhill is always fine; uphill needs a gentle grade, a teal cliff (claws) or a low ledge (wings). */
    canStep(ax: number, az: number, bx: number, bz: number, m: Mover): boolean {
        if (!this.inBounds(bx, bz)) return false;
        if (this.gateBlocks(ax, az, bx, bz)) return false;
        const ha = this.height(ax, az), hb = this.height(bx, bz);
        if (hb < DEEP && !m.fly) return false;
        const rise = Math.max(SEA, hb) - Math.max(SEA, ha), run = Math.max(0.05, Math.hypot(bx - ax, bz - az));
        // Uphill onto (or off) ground too steep to stand on is a wall, even when the step runs
        // along it (curved and ramp-side edges would otherwise be climbed tangentially).
        const steep = rise > 0.12 && Math.max(this.grade(bx, bz), this.grade((ax + bx) / 2, (az + bz) / 2)) > MAX_GRADE * 1.25;
        if (rise <= run * MAX_GRADE && !steep) return true;
        if (m.climb && (this.climbable(bx, bz) || this.climbable(ax, az))) return true;
        if (m.fly && rise < FLY_LEDGE * Math.max(1, run / NAV_CELL)) return true;
        return false;
    }

    /** A* over the 2 m nav grid. Portals (pairs of points) are edges for phasing movers. Returns waypoints (x, z) or null. */
    findPath(from: [number, number], to: [number, number], m: Mover, portals: { a: [number, number]; b: [number, number] }[] = [], maxNodes = 30000): [number, number][] | null {
        const N = Math.floor(this.size / NAV_CELL);
        const cell = (x: number, z: number) => [Math.max(0, Math.min(N - 1, Math.floor((x + this.half) / NAV_CELL))), Math.max(0, Math.min(N - 1, Math.floor((z + this.half) / NAV_CELL)))];
        const center = (i: number, j: number): [number, number] => [(i + 0.5) * NAV_CELL - this.half, (j + 0.5) * NAV_CELL - this.half];
        const [si, sj] = cell(from[0], from[1]), [ti, tj] = cell(to[0], to[1]);
        const start = sj * N + si, goal = tj * N + ti;
        if (start === goal) return [to];
        const g = new Float32Array(N * N).fill(Infinity), came = new Int32Array(N * N).fill(-1), closed = new Uint8Array(N * N);
        const heap = new MinHeap();
        g[start] = 0;
        const hcost = (k: number) => { const i = k % N, j = (k / N) | 0; return Math.hypot(i - ti, j - tj) * NAV_CELL; };
        heap.push(start, hcost(start));
        const portalCells = m.phase ? portals.flatMap(p => { const [ai, aj] = cell(p.a[0], p.a[1]), [bi, bj] = cell(p.b[0], p.b[1]); return [[aj * N + ai, bj * N + bi], [bj * N + bi, aj * N + ai]]; }) : [];
        let expanded = 0;
        while (heap.size) {
            const k = heap.pop();
            if (closed[k]) continue;
            if (k === goal) break;
            closed[k] = 1;
            if (++expanded > maxNodes) return null;
            const i = k % N, j = (k / N) | 0, [cx, cz] = center(i, j);
            for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
                if (!di && !dj) continue;
                const ni = i + di, nj = j + dj;
                if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
                const nk = nj * N + ni;
                if (closed[nk]) continue;
                const [nx, nz] = center(ni, nj);
                if (!this.canStep(cx, cz, nx, nz, m)) continue;
                if (di && dj && (!this.canStep(cx, cz, nx, cz, m) || !this.canStep(cx, cz, cx, nz, m))) continue;
                const cost = g[k] + Math.hypot(di, dj) * NAV_CELL + (this.height(nx, nz) < SEA ? 1.5 : 0);
                if (cost < g[nk]) { g[nk] = cost; came[nk] = k; heap.push(nk, cost + hcost(nk)); }
            }
            for (const [pa, pb] of portalCells) if (pa === k && !closed[pb] && g[k] + 1 < g[pb]) { g[pb] = g[k] + 1; came[pb] = k; heap.push(pb, g[pb] + hcost(pb)); }
        }
        if (came[goal] < 0) return null;
        const path: [number, number][] = [to];
        let k = came[goal];
        while (k >= 0 && k !== start) { const c = center(k % N, (k / N) | 0); path.push(c); k = came[k]; }
        path.reverse();
        return simplify(path);
    }

    /** The island as one mesh (mesh layout: position, normal, uv, color). color.r = climbable, color.g = beach/rock, color.b = cliff. */
    mesh(step = 1.5): { vertexData: Float32Array; indexData: Uint32Array } {
        const cells = Math.floor(this.size / step), n = cells + 1;
        const v = new Float32Array(n * n * 12);
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            const x = i * step - this.half, z = j * step - this.half, y = this.height(x, z);
            const nr = this.normal(x, z), o = (j * n + i) * 12;
            const steep = 1 - nr[1];
            v[o] = x; v[o + 1] = y; v[o + 2] = z;
            v[o + 3] = nr[0]; v[o + 4] = nr[1]; v[o + 5] = nr[2];
            v[o + 6] = x / 8; v[o + 7] = z / 8;
            v[o + 8] = this.climbable(x, z) ? 1 : 0;
            v[o + 9] = smoothstep(1.6, 0.3, y);
            v[o + 10] = smoothstep(0.25, 0.55, steep);
            v[o + 11] = 1;
        }
        const idx = new Uint32Array(cells * cells * 6);
        let k = 0;
        for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
            const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
            idx[k++] = a; idx[k++] = c; idx[k++] = b;
            idx[k++] = b; idx[k++] = c; idx[k++] = d;
        }
        return { vertexData: v, indexData: idx };
    }

    /** A point near (x, z) where a walker can stand (for placing things). */
    ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT = 400): [number, number, number] | null {
        let t = 0, prev = oy - this.surface(ox, oz);
        if (prev < 0) return null;
        const stepLen = 0.5;
        while (t < maxT) {
            t += stepLen * (t > 60 ? 2 : 1);
            const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
            const d = y - this.surface(x, z);
            if (d < 0) {
                // Bisect the crossing.
                let lo = t - stepLen * (t > 60 ? 2 : 1), hi = t;
                for (let k = 0; k < 12; k++) {
                    const mid = (lo + hi) / 2, my = oy + dy * mid, mx = ox + dx * mid, mz = oz + dz * mid;
                    if (my - this.surface(mx, mz) < 0) hi = mid; else lo = mid;
                }
                return [ox + dx * hi, oy + dy * hi, oz + dz * hi];
            }
            prev = d;
        }
        return null;
    }
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
    const lx = bx - ax, lz = bz - az, l2 = lx * lx + lz * lz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * lx + (pz - az) * lz) / l2)) : 0;
    return Math.hypot(px - ax - lx * t, pz - az - lz * t);
}
export { segDist };

function segmentsCross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
    const o = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
    const o1 = o(ax, az, bx, bz, cx, cz), o2 = o(ax, az, bx, bz, dx, dz), o3 = o(cx, cz, dx, dz, ax, az), o4 = o(cx, cz, dx, dz, bx, bz);
    return o1 * o2 < 0 && o3 * o4 < 0;
}

/** Drops waypoints that sit on a straight line between their neighbours. */
function simplify(p: [number, number][]): [number, number][] {
    if (p.length < 3) return p;
    const out: [number, number][] = [p[0]];
    for (let i = 1; i < p.length - 1; i++) {
        const a = out[out.length - 1], b = p[i], c = p[i + 1];
        const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (Math.abs(cr) > 0.01) out.push(b);
    }
    out.push(p[p.length - 1]);
    return out;
}

class MinHeap {
    private k: number[] = [];
    private p: number[] = [];
    get size() { return this.k.length; }
    push(key: number, pri: number): void {
        const k = this.k, p = this.p;
        k.push(key); p.push(pri);
        let i = k.length - 1;
        while (i > 0) {
            const up = (i - 1) >> 1;
            if (p[up] <= p[i]) break;
            [k[up], k[i]] = [k[i], k[up]]; [p[up], p[i]] = [p[i], p[up]];
            i = up;
        }
    }
    pop(): number {
        const k = this.k, p = this.p, top = k[0];
        const lk = k.pop()!, lp = p.pop()!;
        if (k.length) {
            k[0] = lk; p[0] = lp;
            let i = 0;
            for (;;) {
                const l = i * 2 + 1, r = l + 1;
                let m = i;
                if (l < k.length && p[l] < p[m]) m = l;
                if (r < k.length && p[r] < p[m]) m = r;
                if (m === i) break;
                [k[m], k[i]] = [k[i], k[m]]; [p[m], p[i]] = [p[i], p[m]];
                i = m;
            }
        }
        return top;
    }
}
