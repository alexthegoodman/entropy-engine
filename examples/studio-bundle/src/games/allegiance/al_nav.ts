// Street navigation: a flat local map of the few hundred meters around you, and paths across it.
//
// Earth is 6,371 km in radius, so within a kilometer the ground is flat to the centimeter (well,
// to the curvature's ~8 cm at 1 km, which the height function absorbs). The street layer works in a
// local tangent frame: x east, z north, in meters from an origin on the ground near you, with
// heights from the real terrain. OpenStreetMap buildings (Entropy.QuadPlanet.buildings) become
// oriented rectangles in that frame; the nav grid rasterizes them (and open water) as blocked
// cells, and A* finds paths between building doors along the streets between them. The grid
// follows you: once you walk far from its center it is rebuilt around you.

import { type Vec3, add, cross, dot, normalize, scale, sub } from "../../apps/quadplanet/qp_math";

// --- Local frame ---------------------------------------------------------------------------------

export interface LocalFrame {
    /** World point of the local origin (on the ground). */
    origin: Vec3;
    /** Unit vectors at the origin: east, up (away from Earth's center), north. */
    east: Vec3;
    up: Vec3;
    north: Vec3;
}

/** A frame at `origin` on a planet centered at `center` (+Y is the planet's north pole). */
export function makeLocalFrame(origin: Vec3, center: Vec3 = [0, 0, 0]): LocalFrame {
    const up = normalize(sub(origin, center));
    let east = cross([0, 1, 0], up);
    if (Math.hypot(east[0], east[1], east[2]) < 1e-9) east = [1, 0, 0];
    east = normalize(east);
    const north = normalize(cross(up, east));
    return { origin, east, up, north };
}

/** World point → local (x east, y up, z north), meters. */
export function toLocal(f: LocalFrame, p: Vec3): Vec3 {
    const d = sub(p, f.origin);
    return [dot(d, f.east), dot(d, f.up), dot(d, f.north)];
}

/** Local (x, y, z) → world point. (y is height above the tangent plane at the origin.) */
export function toWorld(f: LocalFrame, x: number, y: number, z: number): Vec3 {
    return add(add(add(f.origin, scale(f.east, x)), scale(f.up, y)), scale(f.north, z));
}

/** A world direction → local. */
export function dirToLocal(f: LocalFrame, d: Vec3): Vec3 {
    return [dot(d, f.east), dot(d, f.up), dot(d, f.north)];
}

export function dirToWorld(f: LocalFrame, x: number, y: number, z: number): Vec3 {
    return add(add(scale(f.east, x), scale(f.up, y)), scale(f.north, z));
}

// --- Buildings as rectangles ---------------------------------------------------------------------

/** An oriented rectangle footprint in the local frame. `ux, uz` is its right axis (unit). */
export interface Rect {
    cx: number; cz: number;
    ux: number; uz: number;
    hw: number; hd: number;
    height: number;
    /** Ground height at the footprint (local y). */
    base: number;
    key: string;
    /** The door: in front of the building's street side (local x, z). */
    door: [number, number];
    /** "house" for homes you can enter; anything else stays closed. */
    kind?: string;
}

export interface BuildingLike {
    key: string;
    anchor: Vec3;
    right: Vec3;
    forward: Vec3;
    width: number;
    depth: number;
    height: number;
    kind?: string;
}

export function buildingToRect(f: LocalFrame, b: BuildingLike): Rect {
    const a = toLocal(f, b.anchor);
    const r = dirToLocal(f, b.right);
    const fw = dirToLocal(f, b.forward);
    const rl = Math.hypot(r[0], r[2]) || 1;
    const fl = Math.hypot(fw[0], fw[2]) || 1;
    const ux = r[0] / rl, uz = r[2] / rl;
    const fx = fw[0] / fl, fz = fw[2] / fl;
    const hd = b.depth / 2;
    return {
        cx: a[0], cz: a[2], ux, uz, hw: b.width / 2, hd, height: b.height, base: a[1], key: b.key,
        door: [a[0] + fx * (hd + 1.6), a[2] + fz * (hd + 1.6)], kind: b.kind,
    };
}

/** Is local point (x, z) inside the rectangle grown by `pad`? */
export function insideRect(r: Rect, x: number, z: number, pad = 0): boolean {
    const dx = x - r.cx, dz = z - r.cz;
    const u = dx * r.ux + dz * r.uz;
    const v = -dx * r.uz + dz * r.ux;
    return Math.abs(u) <= r.hw + pad && Math.abs(v) <= r.hd + pad;
}

/** Pushes a circle at (x, z) out of the rectangle; returns the corrected point. */
export function pushOutOfRect(r: Rect, x: number, z: number, radius: number): [number, number] {
    const dx = x - r.cx, dz = z - r.cz;
    let u = dx * r.ux + dz * r.uz;
    let v = -dx * r.uz + dz * r.ux;
    const ew = r.hw + radius, ed = r.hd + radius;
    if (Math.abs(u) >= ew || Math.abs(v) >= ed) return [x, z];
    // Leave by the nearest side.
    const pu = ew - Math.abs(u), pv = ed - Math.abs(v);
    if (pu < pv) u = Math.sign(u || 1) * ew; else v = Math.sign(v || 1) * ed;
    return [r.cx + u * r.ux - v * r.uz, r.cz + u * r.uz + v * r.ux];
}

/** Where a segment from a to b first enters the rectangle (0..1 along it), or null. */
export function segmentHitsRect(r: Rect, ax: number, az: number, bx: number, bz: number): number | null {
    const toU = (x: number, z: number) => (x - r.cx) * r.ux + (z - r.cz) * r.uz;
    const toV = (x: number, z: number) => -(x - r.cx) * r.uz + (z - r.cz) * r.ux;
    const u0 = toU(ax, az), v0 = toV(ax, az), u1 = toU(bx, bz), v1 = toV(bx, bz);
    let t0 = 0, t1 = 1;
    const clip = (p0: number, p1: number, h: number): boolean => {
        const d = p1 - p0;
        if (Math.abs(d) < 1e-12) return Math.abs(p0) <= h;
        let ta = (-h - p0) / d, tb = (h - p0) / d;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        return t0 <= t1;
    };
    if (!clip(u0, u1, r.hw) || !clip(v0, v1, r.hd)) return null;
    return t0;
}

// --- The nav grid --------------------------------------------------------------------------------

export const NAV_CELL = 2;
export const NAV_SIZE = 280;

export class NavGrid {
    readonly size: number;
    private scratch?: { g: Float32Array; came: Int32Array; seen: Uint32Array; closed: Uint32Array; stamp: number; heap: MinHeap };
    readonly cell: number;
    /** Local coordinates of the grid's center. */
    readonly cx: number;
    readonly cz: number;
    readonly blocked: Uint8Array;
    rects: Rect[] = [];

    constructor(cx: number, cz: number, size = NAV_SIZE, cell = NAV_CELL) {
        this.size = size;
        this.cell = cell;
        this.cx = cx;
        this.cz = cz;
        this.blocked = new Uint8Array(size * size);
    }

    get half(): number { return this.size * this.cell / 2; }

    cellOf(x: number, z: number): [number, number] {
        return [Math.floor((x - this.cx + this.half) / this.cell), Math.floor((z - this.cz + this.half) / this.cell)];
    }

    center(i: number, j: number): [number, number] {
        return [this.cx - this.half + (i + 0.5) * this.cell, this.cz - this.half + (j + 0.5) * this.cell];
    }

    inBounds(i: number, j: number): boolean { return i >= 0 && j >= 0 && i < this.size && j < this.size; }

    isBlocked(i: number, j: number): boolean { return !this.inBounds(i, j) || this.blocked[j * this.size + i] !== 0; }

    walkable(x: number, z: number): boolean {
        const [i, j] = this.cellOf(x, z);
        return !this.isBlocked(i, j);
    }

    /** Marks the cells covered by a building (grown by `pad` meters). */
    addRect(r: Rect, pad = 0.5): void {
        this.rects.push(r);
        const ext = Math.abs(r.ux) * (r.hw + pad) + Math.abs(r.uz) * (r.hd + pad);
        const ezt = Math.abs(r.uz) * (r.hw + pad) + Math.abs(r.ux) * (r.hd + pad);
        const [i0, j0] = this.cellOf(r.cx - ext, r.cz - ezt);
        const [i1, j1] = this.cellOf(r.cx + ext, r.cz + ezt);
        for (let j = Math.max(0, j0); j <= Math.min(this.size - 1, j1); j++) {
            for (let i = Math.max(0, i0); i <= Math.min(this.size - 1, i1); i++) {
                const [x, z] = this.center(i, j);
                if (insideRect(r, x, z, pad)) this.blocked[j * this.size + i] = 1;
            }
        }
    }

    /** Marks every cell for which `test(x, z)` is true (open water). */
    markWhere(test: (x: number, z: number) => boolean, stride = 4): void {
        // Sampled coarsely, then filled in blocks: water doesn't need meter precision.
        for (let j = 0; j < this.size; j += stride) {
            for (let i = 0; i < this.size; i += stride) {
                const [x, z] = this.center(i + stride / 2, j + stride / 2);
                if (!test(x, z)) continue;
                for (let b = j; b < Math.min(this.size, j + stride); b++)
                    for (let a = i; a < Math.min(this.size, i + stride); a++) this.blocked[b * this.size + a] = 2;
            }
        }
    }

    /** The nearest walkable cell center to (x, z), searching outward up to `maxRing` cells. */
    nearestWalkable(x: number, z: number, maxRing = 30): [number, number] | null {
        const [ci, cj] = this.cellOf(x, z);
        if (!this.isBlocked(ci, cj)) return this.center(ci, cj);
        for (let ring = 1; ring <= maxRing; ring++) {
            let best: [number, number] | null = null, bestD = Infinity;
            for (let dj = -ring; dj <= ring; dj++) {
                for (let di = -ring; di <= ring; di++) {
                    if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
                    if (this.isBlocked(ci + di, cj + dj)) continue;
                    const d = di * di + dj * dj;
                    if (d < bestD) { bestD = d; best = this.center(ci + di, cj + dj); }
                }
            }
            if (best) return best;
        }
        return null;
    }

    /** Straight-line walkability between two points (grid DDA). */
    lineClear(ax: number, az: number, bx: number, bz: number): boolean {
        const len = Math.hypot(bx - ax, bz - az);
        const steps = Math.max(1, Math.ceil(len / (this.cell * 0.5)));
        for (let k = 0; k <= steps; k++) {
            const t = k / steps;
            if (!this.walkable(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
        }
        return true;
    }

    /**
     * A* over 8-connected cells (no corner cutting), then string-pulled to the fewest straight
     * legs. Returns waypoints from start to goal (local x, z), or null when unreachable.
     */
    findPath(ax: number, az: number, bx: number, bz: number, maxExpand = 20000): [number, number][] | null {
        const start = this.nearestWalkable(ax, az, 6);
        const goal = this.nearestWalkable(bx, bz, 12);
        if (!start || !goal) return null;
        const [si, sj] = this.cellOf(start[0], start[1]);
        const [gi, gj] = this.cellOf(goal[0], goal[1]);
        const N = this.size;
        const sIdx = sj * N + si, gIdx = gj * N + gi;
        if (sIdx === gIdx) return [[bx, bz]];
        // Scratch reused across searches: a cell's g/came are only valid when its stamp is this
        // search's, and closed when its closed stamp is (no per-search allocation or clearing).
        const sc = this.scratch ??= { g: new Float32Array(N * N), came: new Int32Array(N * N), seen: new Uint32Array(N * N), closed: new Uint32Array(N * N), stamp: 0, heap: new MinHeap() };
        if (++sc.stamp === 0xffffffff) { sc.seen.fill(0); sc.closed.fill(0); sc.stamp = 1; }
        const stamp = sc.stamp, g = sc.g, came = sc.came, seen = sc.seen, closed = sc.closed, heap = sc.heap;
        heap.clear();
        const h = (i: number, j: number) => {
            const dx = Math.abs(i - gi), dy = Math.abs(j - gj);
            return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
        };
        g[sIdx] = 0; came[sIdx] = -1; seen[sIdx] = stamp;
        heap.push(sIdx, h(si, sj));
        let expanded = 0;
        let found = false;
        while (heap.size) {
            const cur = heap.pop();
            if (closed[cur] === stamp) continue;
            if (cur === gIdx) { found = true; break; }
            closed[cur] = stamp;
            if (++expanded > maxExpand) break;
            const ci = cur % N, cj = (cur - ci) / N;
            for (let dj = -1; dj <= 1; dj++) {
                for (let di = -1; di <= 1; di++) {
                    if (!di && !dj) continue;
                    const ni = ci + di, nj = cj + dj;
                    if (this.isBlocked(ni, nj)) continue;
                    if (di && dj && (this.isBlocked(ci + di, cj) || this.isBlocked(ci, cj + dj))) continue;
                    const n = nj * N + ni;
                    if (closed[n] === stamp) continue;
                    const cost = g[cur] + (di && dj ? Math.SQRT2 : 1);
                    if (seen[n] !== stamp || cost < g[n]) {
                        seen[n] = stamp;
                        g[n] = cost;
                        came[n] = cur;
                        heap.push(n, cost + h(ni, nj));
                    }
                }
            }
        }
        if (!found) return null;
        const cells: [number, number][] = [];
        for (let k = gIdx; k !== -1; k = came[k]) {
            const i = k % N, j = (k - i) / N;
            cells.push(this.center(i, j));
        }
        cells.reverse();
        cells[cells.length - 1] = this.walkable(bx, bz) ? [bx, bz] : goal;
        // String pulling: skip waypoints while the straight line stays clear.
        const out: [number, number][] = [];
        let anchor: [number, number] = [ax, az];
        let k = 0;
        while (k < cells.length) {
            let far = k;
            for (let m = cells.length - 1; m > k; m--) {
                if (this.lineClear(anchor[0], anchor[1], cells[m][0], cells[m][1])) { far = m; break; }
            }
            out.push(cells[far]);
            anchor = cells[far];
            k = far + 1;
        }
        return out;
    }

    /** A random walkable point within `radius` of (x, z). */
    randomWalkable(x: number, z: number, radius: number, rnd: () => number, tries = 30): [number, number] | null {
        for (let t = 0; t < tries; t++) {
            const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * radius;
            const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
            if (this.walkable(px, pz)) return [px, pz];
        }
        return null;
    }

    /** Line of sight for bullets: blocked by buildings (not by water). */
    sightClear(ax: number, az: number, bx: number, bz: number): boolean {
        for (const r of this.rects) {
            // Cheap reject by distance.
            const mx = (ax + bx) / 2, mz = (az + bz) / 2;
            const reach = Math.hypot(bx - ax, bz - az) / 2 + r.hw + r.hd;
            if (Math.abs(r.cx - mx) > reach || Math.abs(r.cz - mz) > reach) continue;
            if (segmentHitsRect(r, ax, az, bx, bz) !== null) return false;
        }
        return true;
    }

    /** Pushes a circle out of every building it overlaps. */
    collide(x: number, z: number, radius: number): [number, number] {
        let p: [number, number] = [x, z];
        for (const r of this.rects) {
            if (Math.abs(r.cx - p[0]) > r.hw + r.hd + radius || Math.abs(r.cz - p[1]) > r.hw + r.hd + radius) continue;
            p = pushOutOfRect(r, p[0], p[1], radius);
        }
        return p;
    }
}

/** A binary min-heap of (index, priority). */
class MinHeap {
    private idx: number[] = [];
    private pri: number[] = [];
    get size(): number { return this.idx.length; }
    clear(): void { this.idx.length = 0; this.pri.length = 0; }
    push(i: number, p: number): void {
        const a = this.idx, q = this.pri;
        a.push(i); q.push(p);
        let k = a.length - 1;
        while (k > 0) {
            const parent = (k - 1) >> 1;
            if (q[parent] <= q[k]) break;
            const ti = a[parent]; a[parent] = a[k]; a[k] = ti;
            const tp = q[parent]; q[parent] = q[k]; q[k] = tp;
            k = parent;
        }
    }
    pop(): number {
        const a = this.idx, q = this.pri;
        const top = a[0];
        const li = a.pop()!, lp = q.pop()!;
        if (a.length) {
            a[0] = li; q[0] = lp;
            let k = 0;
            for (;;) {
                const l = 2 * k + 1, r = l + 1;
                let m = k;
                if (l < a.length && q[l] < q[m]) m = l;
                if (r < a.length && q[r] < q[m]) m = r;
                if (m === k) break;
                const ti = a[m]; a[m] = a[k]; a[k] = ti;
                const tp = q[m]; q[m] = q[k]; q[k] = tp;
                k = m;
            }
        }
        return top;
    }
}
