// Implicit surfaces for Mesha's organic objects. A shape is a tree of signed distance primitives
// (spheres, ellipsoids, round cones, rounded boxes, or any custom bounded function) combined with
// smooth unions and subtractions, the way a sculptor blocks out forms and blends them together. Every
// node knows its bounding box and can bound its own value over a cube of space, so a tree can be
// specialized to that cube: whatever can't change the value inside it is pruned, and a point query
// near a fingertip only touches the finger.
//
// `meshField` turns a field into triangles with adaptive octree dual contouring: cells far from the
// surface are pruned by the distance bound, cells near it subdivide down to a size that can vary over
// space (fine on a face, coarse on a back), and every minimal edge the surface crosses becomes a quad
// joining the vertices of the cells around it, so neighbouring cells of different sizes stitch with
// no cracks. Vertices sit on the surface (a Newton step along the gradient) with the gradient as
// their normal, which shades an organic shape smoothly at any resolution.

import { type Vec3 } from "./mesha_mesh";

export type Field = (x: number, y: number, z: number) => number;

/** Axis-aligned box: min x, y, z, max x, y, z. */
export type Box = [number, number, number, number, number, number];

/** Distance from a point to a box (0 inside). */
function boxDist(b: Box, x: number, y: number, z: number): number {
    const dx = Math.max(b[0] - x, 0, x - b[3]), dy = Math.max(b[1] - y, 0, y - b[4]), dz = Math.max(b[2] - z, 0, z - b[5]);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const inflate = (b: Box, r: number): Box => [b[0] - r, b[1] - r, b[2] - r, b[3] + r, b[4] + r, b[5] + r];
const unionBox = (boxes: Box[]): Box => {
    const out: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const b of boxes) for (let k = 0; k < 3; k++) { out[k] = Math.min(out[k], b[k]); out[k + 3] = Math.max(out[k + 3], b[k + 3]); }
    return out;
};

/** Cubic smooth minimum: C2 blends, at most k/6 below the plain minimum. */
export function smin(a: number, b: number, k: number): number {
    if (k <= 0) return a < b ? a : b;
    const h = Math.max(k - Math.abs(a - b), 0) / k;
    return (a < b ? a : b) - h * h * h * k * (1 / 6);
}
export function smax(a: number, b: number, k: number): number {
    return -smin(-a, -b, k);
}

// --- Frames --------------------------------------------------------------------------------------

/** Row-major 3x3 rotation whose rows are the local x, y, z axes in world space. */
export type Rot = [number, number, number, number, number, number, number, number, number];

export const IDENTITY_ROT: Rot = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** A frame whose local +Y runs along `axis`, with local +Z as close to `forward` as possible. */
export function frameFromAxis(axis: Vec3, forward: Vec3 = [0, 0, 1]): Rot {
    let yx = axis[0], yy = axis[1], yz = axis[2];
    const yl = Math.hypot(yx, yy, yz) || 1; yx /= yl; yy /= yl; yz /= yl;
    let d = forward[0] * yx + forward[1] * yy + forward[2] * yz;
    let zx = forward[0] - d * yx, zy = forward[1] - d * yy, zz = forward[2] - d * yz;
    let zl = Math.hypot(zx, zy, zz);
    if (zl < 1e-6) { const alt: Vec3 = Math.abs(yy) < 0.9 ? [0, 1, 0] : [1, 0, 0]; d = alt[0] * yx + alt[1] * yy + alt[2] * yz; zx = alt[0] - d * yx; zy = alt[1] - d * yy; zz = alt[2] - d * yz; zl = Math.hypot(zx, zy, zz); }
    zx /= zl; zy /= zl; zz /= zl;
    // x = y cross z
    const xx = yy * zz - yz * zy, xy = yz * zx - yx * zz, xz = yx * zy - yy * zx;
    return [xx, xy, xz, yx, yy, yz, zx, zy, zz];
}

/** Rotation from Euler degrees (applied X, then Y, then Z), as local axes in rows. */
export function rotFromEuler(rx: number, ry: number, rz: number): Rot {
    const D = Math.PI / 180;
    const cx = Math.cos(rx * D), sx = Math.sin(rx * D), cy = Math.cos(ry * D), sy = Math.sin(ry * D), cz = Math.cos(rz * D), sz = Math.sin(rz * D);
    // World matrix M = Rz Ry Rx (columns are local axes); rows of the result are M's columns.
    const m00 = cz * cy, m10 = sz * cy, m20 = -sy;
    const m01 = cz * sy * sx - sz * cx, m11 = sz * sy * sx + cz * cx, m21 = cy * sx;
    const m02 = cz * sy * cx + sz * sx, m12 = sz * sy * cx - cz * sx, m22 = cy * cx;
    return [m00, m10, m20, m01, m11, m21, m02, m12, m22];
}

/** a then b: the frame b expressed in a's local space, composed into world. */
export function mulRot(a: Rot, b: Rot): Rot {
    // Rows of b are local axes in a-space; convert each to world via a.
    const out = new Array(9) as Rot;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = b[r * 3] * a[c] + b[r * 3 + 1] * a[3 + c] + b[r * 3 + 2] * a[6 + c];
    return out;
}

/** A local-space vector in world space. */
export function rotApply(r: Rot, v: Vec3): Vec3 {
    return [v[0] * r[0] + v[1] * r[3] + v[2] * r[6], v[0] * r[1] + v[1] * r[4] + v[2] * r[7], v[0] * r[2] + v[1] * r[5] + v[2] * r[8]];
}

/** A world-space vector in local space. */
export function rotInverse(r: Rot, v: Vec3): Vec3 {
    return [v[0] * r[0] + v[1] * r[1] + v[2] * r[2], v[0] * r[3] + v[1] * r[4] + v[2] * r[5], v[0] * r[6] + v[1] * r[7] + v[2] * r[8]];
}

/** Rotation by `angle` radians about a unit axis (Rodrigues), as local axes in rows. */
export function rotAxisAngle(axis: Vec3, angle: number): Rot {
    const [x, y, z] = axis, c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    // Column-major world matrix, transposed into rows-of-local-axes = its columns.
    return [
        t * x * x + c, t * x * y + s * z, t * x * z - s * y,
        t * x * y - s * z, t * y * y + c, t * y * z + s * x,
        t * x * z + s * y, t * y * z - s * x, t * z * z + c,
    ];
}

// --- Nodes ---------------------------------------------------------------------------------------

/** Bounds a `spec` call found for its cube (read right after the call; no allocation per call). */
export const SPEC = { lo: 0, hi: 0 };

export interface SdfNode {
    box: Box;
    /** The point function (compiled once, cached). */
    fn(): Field;
    /**
     * Bounds over the cube centred at (x, y, z) with half-diagonal `h` (`L` is the slack allowed for
     * approximate distances) left in SPEC, and the node with every part that can't affect the value
     * inside that cube removed. Exact inside the cube: a union drops children that never come within
     * its blend radius of the nearest one, a subtraction drops a cutter that never reaches the surface.
     */
    spec(x: number, y: number, z: number, h: number, L: number): SdfNode;
}

class Prim implements SdfNode {
    constructor(public box: Box, private f: Field) {}
    fn(): Field { return this.f; }
    spec(x: number, y: number, z: number, h: number, L: number): SdfNode {
        const v = this.f(x, y, z);
        SPEC.lo = v - h * L; SPEC.hi = v + h * L;
        return this;
    }
}

export function sphere(c: Vec3, r: number): SdfNode {
    const [cx, cy, cz] = c;
    return new Prim([cx - r, cy - r, cz - r, cx + r, cy + r, cz + r], (x, y, z) => Math.sqrt((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) - r);
}

/** World box of a local box [-h, h] under rotation `rot` about `c`. */
function orientedBox(c: Vec3, h: Vec3, rot: Rot): Box {
    const ex = Math.abs(rot[0]) * h[0] + Math.abs(rot[3]) * h[1] + Math.abs(rot[6]) * h[2];
    const ey = Math.abs(rot[1]) * h[0] + Math.abs(rot[4]) * h[1] + Math.abs(rot[7]) * h[2];
    const ez = Math.abs(rot[2]) * h[0] + Math.abs(rot[5]) * h[1] + Math.abs(rot[8]) * h[2];
    return [c[0] - ex, c[1] - ey, c[2] - ez, c[0] + ex, c[1] + ey, c[2] + ez];
}

/** An ellipsoid with semi-axes `r` along its local axes (Inigo Quilez's bound: the surface is exact). */
export function ellipsoid(c: Vec3, r: Vec3, rot: Rot = IDENTITY_ROT): SdfNode {
    const [cx, cy, cz] = c;
    const [r0, r1, r2] = r.map(v => Math.max(1e-5, v));
    const [a, b, d, e, f, g, h, i, j] = rot;
    const minR = Math.min(r0, r1, r2);
    return new Prim(orientedBox(c, [r0, r1, r2], rot), (x, y, z) => {
        const px = x - cx, py = y - cy, pz = z - cz;
        const lx = px * a + py * b + pz * d, ly = px * e + py * f + pz * g, lz = px * h + py * i + pz * j;
        const k0 = Math.sqrt((lx / r0) ** 2 + (ly / r1) ** 2 + (lz / r2) ** 2);
        if (k0 < 1e-9) return -minR;
        const k1 = Math.sqrt((lx / (r0 * r0)) ** 2 + (ly / (r1 * r1)) ** 2 + (lz / (r2 * r2)) ** 2);
        return (k0 * (k0 - 1)) / k1;
    });
}

/** A rounded box of half extents `h` (corner radius `round`, inside them) about `c`. */
export function roundBox(c: Vec3, h: Vec3, round: number, rot: Rot = IDENTITY_ROT): SdfNode {
    const [cx, cy, cz] = c;
    const r = Math.max(0, Math.min(round, h[0], h[1], h[2]));
    const hx = h[0] - r, hy = h[1] - r, hz = h[2] - r;
    const [a, b, d, e, f, g, hh, i, j] = rot;
    return new Prim(orientedBox(c, h, rot), (x, y, z) => {
        const px = x - cx, py = y - cy, pz = z - cz;
        const qx = Math.abs(px * a + py * b + pz * d) - hx, qy = Math.abs(px * e + py * f + pz * g) - hy, qz = Math.abs(px * hh + py * i + pz * j) - hz;
        const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
        return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
    });
}

/**
 * A round cone: spheres of radius `ra` at `a` and `rb` at `b` and the cone tangent to both (exact).
 * `squash` [sx, sz] flattens its cross-section across the local x and z of `forward`'s frame (an oval
 * forearm, a flat finger): the surface stays exact, the distance off it conservative.
 */
export function roundCone(a: Vec3, b: Vec3, ra: number, rb: number, squash: [number, number] = [1, 1], forward: Vec3 = [0, 0, 1]): SdfNode {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (len < 1e-6 || Math.abs(ra - rb) >= len * 0.999) {
        // Degenerate: one sphere swallows the other.
        return ra >= rb ? ellipsoid(a, [ra * squash[0], ra, ra * squash[1]], frameFromAxis(sub(b, a), forward)) : ellipsoid(b, [rb * squash[0], rb, rb * squash[1]], frameFromAxis(sub(b, a), forward));
    }
    const rot = frameFromAxis(sub(b, a), forward);
    const [sx, sz] = [Math.max(0.05, squash[0]), Math.max(0.05, squash[1])];
    const ms = Math.min(sx, sz, 1);
    const l2 = len * len, rr = ra - rb, a2 = l2 - rr * rr, il2 = 1 / l2;
    const [ax, ay, az] = a;
    const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = rot;
    const rmax = Math.max(ra, rb);
    const lo: Box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
    const box = inflate(lo, rmax * Math.max(sx, sz, 1));
    return new Prim(box, (x, y, z) => {
        const px = x - ax, py = y - ay, pz = z - az;
        // Local coordinates, axis along +y, cross-section unsquashed.
        const lx = (px * m0 + py * m1 + pz * m2) / sx, ly = px * m3 + py * m4 + pz * m5, lz = (px * m6 + py * m7 + pz * m8) / sz;
        // iq's sdRoundCone with a = origin, b = (0, len, 0).
        const yy = ly * len;
        const zz = yy - l2;
        const wx = lx * l2, wy = ly * l2 - len * yy, wz = lz * l2;
        const x2 = wx * wx + wy * wy + wz * wz;
        const y2 = yy * yy * l2, z2 = zz * zz * l2;
        const k = Math.sign(rr) * rr * rr * x2;
        let d: number;
        if (Math.sign(zz) * a2 * z2 > k) d = Math.sqrt(x2 + z2) * il2 - rb;
        else if (Math.sign(yy) * a2 * y2 < k) d = Math.sqrt(x2 + y2) * il2 - ra;
        else d = (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - ra;
        return d * ms;
    });
}

export const capsule = (a: Vec3, b: Vec3, r: number, squash: [number, number] = [1, 1], forward: Vec3 = [0, 0, 1]) => roundCone(a, b, r, r, squash, forward);

/** Any field you can bound: `fn` must be no more than its true distance off the surface (or close). */
export function custom(box: Box, fn: Field): SdfNode {
    return new Prim(box, fn);
}

function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }

class Union implements SdfNode {
    box: Box;
    private f: Field | null = null;
    constructor(private children: SdfNode[], private k: number, box?: Box) {
        // A smooth union swells past its parts by at most k / 6.
        this.box = box ?? inflate(unionBox(children.map(c => c.box)), k / 6 + 1e-6);
    }
    fn(): Field {
        if (this.f) return this.f;
        const fns = this.children.map(c => c.fn());
        const k = this.k;
        if (fns.length === 1) return (this.f = fns[0]);
        if (k <= 0) {
            return (this.f = (x, y, z) => {
                let v = fns[0](x, y, z);
                for (let i = 1; i < fns.length; i++) { const d = fns[i](x, y, z); if (d < v) v = d; }
                return v;
            });
        }
        const ik = 1 / k, k6 = k / 6;
        return (this.f = (x, y, z) => {
            let v = fns[0](x, y, z);
            for (let i = 1; i < fns.length; i++) {
                const d = fns[i](x, y, z);
                const diff = v - d;
                const h = k - (diff < 0 ? -diff : diff);
                v = v < d ? v : d;
                if (h > 0) { const t = h * ik; v -= t * t * t * k6; }
            }
            return v;
        });
    }
    // Per-node scratch: a node is never inside its own spec call, so reuse is safe.
    private sLo: Float64Array | null = null;
    private sHi: Float64Array | null = null;
    private sBd: Float64Array | null = null;
    private sNode: (SdfNode | null)[] = [];
    spec(x: number, y: number, z: number, h: number, L: number): SdfNode {
        const kids = this.children, n = kids.length, k = this.k;
        const lo = this.sLo ?? (this.sLo = new Float64Array(n)), hi = this.sHi ?? (this.sHi = new Float64Array(n)), bd = this.sBd ?? (this.sBd = new Float64Array(n));
        const nodes = this.sNode;
        // Children whose boxes overlap the cube first, then any other that could come within the
        // blend radius of the best upper bound found.
        let m = Infinity;
        for (let i = 0; i < n; i++) {
            const d = boxDist(kids[i].box, x, y, z) - h;
            bd[i] = d;
            nodes[i] = null;
            if (d > 0) continue;
            nodes[i] = kids[i].spec(x, y, z, h, L);
            lo[i] = SPEC.lo; hi[i] = SPEC.hi;
            if (SPEC.hi < m) m = SPEC.hi;
        }
        if (m === Infinity) {
            // Nothing overlaps the cube: the nearest child bounds the rest.
            let near = 0;
            for (let i = 1; i < n; i++) if (bd[i] < bd[near]) near = i;
            nodes[near] = kids[near].spec(x, y, z, h, L);
            lo[near] = SPEC.lo; hi[near] = SPEC.hi;
            m = SPEC.hi;
        }
        for (let i = 0; i < n; i++) {
            if (nodes[i] || bd[i] > m + k) continue;
            nodes[i] = kids[i].spec(x, y, z, h, L);
            lo[i] = SPEC.lo; hi[i] = SPEC.hi;
            if (SPEC.hi < m) m = SPEC.hi;
        }
        let low = Infinity, count = 0, same = true, only = -1;
        for (let i = 0; i < n; i++) {
            if (!nodes[i] || lo[i] > m + k) { nodes[i] = null; same = false; continue; }
            count++;
            only = i;
            if (lo[i] < low) low = lo[i];
            if (nodes[i] !== kids[i]) same = false;
        }
        if (count === 0) { SPEC.lo = m; SPEC.hi = m; return this; }
        if (count === 1) { SPEC.lo = lo[only]; SPEC.hi = m; return nodes[only]!; }
        let node: SdfNode = this;
        if (!same) {
            const kept: SdfNode[] = [];
            for (let i = 0; i < n; i++) if (nodes[i]) kept.push(nodes[i]!);
            node = new Union(kept, k, this.box);
        }
        SPEC.lo = low - k / 6; SPEC.hi = m;
        return node;
    }
}

/** Plain (k = 0) or smooth union, blended in order. */
export function union(children: SdfNode[], k = 0): SdfNode {
    const list = children.filter(Boolean);
    return list.length === 1 ? list[0] : new Union(list, k);
}

class Subtract implements SdfNode {
    box: Box;
    private f: Field | null = null;
    constructor(private base: SdfNode, private cutter: SdfNode, private k: number) { this.box = base.box; }
    fn(): Field {
        if (this.f) return this.f;
        const b = this.base.fn(), c = this.cutter.fn(), k = this.k;
        return (this.f = (x, y, z) => smax(b(x, y, z), -c(x, y, z), k));
    }
    spec(x: number, y: number, z: number, h: number, L: number): SdfNode {
        const b = this.base.spec(x, y, z, h, L);
        const blo = SPEC.lo, bhi = SPEC.hi;
        // The cut only changes the value where the cutter comes within k of the base's surface.
        const reach = Math.max(0, -blo) + this.k;
        if (boxDist(this.cutter.box, x, y, z) - h > reach) { SPEC.lo = blo; SPEC.hi = bhi; return b; }
        const c = this.cutter.spec(x, y, z, h, L);
        const clo = SPEC.lo;
        SPEC.lo = blo;
        if (clo > reach) { SPEC.hi = bhi; return b; }
        SPEC.hi = Math.max(bhi, -clo) + this.k / 6;
        return b === this.base && c === this.cutter ? this : new Subtract(b, c, this.k);
    }
}

/** `base` with `cutter` carved out of it, the cut edge rounded by `k`. */
export function subtract(base: SdfNode, cutters: SdfNode | SdfNode[], k = 0): SdfNode {
    const list = Array.isArray(cutters) ? cutters : [cutters];
    if (!list.length) return base;
    return new Subtract(base, list.length === 1 ? list[0] : union(list), k);
}

class Intersect implements SdfNode {
    box: Box;
    private f: Field | null = null;
    constructor(private a: SdfNode, private b: SdfNode, private k: number) {
        const A = a.box, B = b.box;
        this.box = [Math.max(A[0], B[0]), Math.max(A[1], B[1]), Math.max(A[2], B[2]), Math.min(A[3], B[3]), Math.min(A[4], B[4]), Math.min(A[5], B[5])];
        for (let i = 0; i < 3; i++) if (this.box[i] > this.box[i + 3]) this.box[i + 3] = this.box[i];
    }
    fn(): Field {
        if (this.f) return this.f;
        const a = this.a.fn(), b = this.b.fn(), k = this.k;
        return (this.f = (x, y, z) => smax(a(x, y, z), b(x, y, z), k));
    }
    spec(x: number, y: number, z: number, h: number, L: number): SdfNode {
        const a = this.a.spec(x, y, z, h, L);
        const alo = SPEC.lo, ahi = SPEC.hi;
        const b = this.b.spec(x, y, z, h, L);
        const blo = SPEC.lo, bhi = SPEC.hi;
        if (bhi < alo - this.k) { SPEC.lo = alo; SPEC.hi = ahi; return a; }
        if (ahi < blo - this.k) { SPEC.lo = blo; SPEC.hi = bhi; return b; }
        SPEC.lo = Math.max(alo, blo); SPEC.hi = Math.max(ahi, bhi) + this.k / 6;
        return a === this.a && b === this.b ? this : new Intersect(a, b, this.k);
    }
}

export function intersect(a: SdfNode, b: SdfNode, k = 0): SdfNode {
    return new Intersect(a, b, k);
}

/** Offsets a node's surface outward by `d` (negative shrinks): a garment's ease, a shoe's upper. */
export function offset(node: SdfNode, d: number): SdfNode {
    let f: Field | null = null;
    const self: SdfNode = {
        box: inflate(node.box, Math.max(0, d)),
        fn() { if (!f) { const g = node.fn(); f = (x, y, z) => g(x, y, z) - d; } return f; },
        spec(x, y, z, h, L) {
            const sp = node.spec(x, y, z, h, L);
            SPEC.lo -= d; SPEC.hi -= d;
            return sp === node ? self : offset(sp, d);
        },
    };
    return self;
}

/** The whole field. */
export function fieldOf(node: SdfNode): Field {
    return node.fn();
}

// --- Gradient ------------------------------------------------------------------------------------

export function gradient(f: Field, x: number, y: number, z: number, h = 5e-4): Vec3 {
    const gx = f(x + h, y, z) - f(x - h, y, z), gy = f(x, y + h, z) - f(x, y - h, z), gz = f(x, y, z + h) - f(x, y, z - h);
    const l = Math.hypot(gx, gy, gz) || 1;
    return [gx / l, gy / l, gz / l];
}

// --- Lazy grid -----------------------------------------------------------------------------------

const BRICK = 8; // lattice points per brick side

/**
 * A field sampled on demand onto a regular lattice and read back trilinearly: cloth and hair hit-test
 * a body thousands of times per step, and this turns each query into eight array reads once the
 * lattice around them has filled in. The lattice is stored in 8^3 bricks allocated as they're first
 * touched, and each brick is filled from the tree specialized to it (so a point by the wrist never
 * evaluates the head). Outside `box` it answers with the distance to the box.
 */
export class LazyGrid {
    readonly nx: number; readonly ny: number; readonly nz: number;
    private bx: number; private by: number; private bz: number;
    private bricks: (Float32Array | undefined)[];
    private ox: number; private oy: number; private oz: number;
    private inv: number;
    private field: Field | null;
    /** Bricks farther than `exactWithin` from every surface are filled with a linear fit. */
    constructor(private source: Field | SdfNode, private box: Box, readonly cell: number, private exactWithin = 0.06) {
        this.ox = box[0]; this.oy = box[1]; this.oz = box[2];
        this.nx = Math.max(2, Math.ceil((box[3] - box[0]) / cell) + 1);
        this.ny = Math.max(2, Math.ceil((box[4] - box[1]) / cell) + 1);
        this.nz = Math.max(2, Math.ceil((box[5] - box[2]) / cell) + 1);
        this.bx = Math.ceil(this.nx / BRICK); this.by = Math.ceil(this.ny / BRICK); this.bz = Math.ceil(this.nz / BRICK);
        this.bricks = new Array(this.bx * this.by * this.bz);
        this.inv = 1 / cell;
        this.field = typeof source === "function" ? source : null;
    }
    private fill(bi: number, bj: number, bk: number): Float32Array {
        const data = new Float32Array(BRICK * BRICK * BRICK);
        const c = this.cell, x0 = this.ox + bi * BRICK * c, y0 = this.oy + bj * BRICK * c, z0 = this.oz + bk * BRICK * c;
        let f = this.field;
        if (!f) {
            const half = (BRICK - 1) * c * 0.5, cx = x0 + half, cy = y0 + half, cz = z0 + half;
            f = (this.source as SdfNode).spec(cx, cy, cz, half * 1.7321, 1.3).fn();
            if (SPEC.lo > this.exactWithin) {
                // Far from every surface nothing collides: a linear fit is all a query needs.
                const v = f(cx, cy, cz), e = c;
                const gx = (f(cx + e, cy, cz) - v) / e, gy = (f(cx, cy + e, cz) - v) / e, gz = (f(cx, cy, cz + e) - v) / e;
                let o = 0;
                for (let k = 0; k < BRICK; k++) for (let j = 0; j < BRICK; j++) for (let i = 0; i < BRICK; i++) data[o++] = v + gx * (i * c - half) + gy * (j * c - half) + gz * (k * c - half);
                return data;
            }
        }
        let o = 0;
        for (let k = 0; k < BRICK; k++) for (let j = 0; j < BRICK; j++) for (let i = 0; i < BRICK; i++) data[o++] = f(x0 + i * c, y0 + j * c, z0 + k * c);
        return data;
    }
    private at(i: number, j: number, k: number): number {
        const bi = (i / BRICK) | 0, bj = (j / BRICK) | 0, bk = (k / BRICK) | 0;
        const b = (bk * this.by + bj) * this.bx + bi;
        const data = this.bricks[b] ?? (this.bricks[b] = this.fill(bi, bj, bk));
        return data[((k - bk * BRICK) * BRICK + (j - bj * BRICK)) * BRICK + (i - bi * BRICK)];
    }
    /** Trilinear distance; `grad`, if given, receives the (unnormalized) gradient. */
    sample(x: number, y: number, z: number, grad?: number[]): number {
        const fx = (x - this.ox) * this.inv, fy = (y - this.oy) * this.inv, fz = (z - this.oz) * this.inv;
        if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx < this.nx - 1 && fy < this.ny - 1 && fz < this.nz - 1)) {
            const d = boxDist(this.box, x, y, z);
            if (grad) { grad[0] = 0; grad[1] = 1; grad[2] = 0; }
            return Math.max(d, this.cell * 4);
        }
        const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
        const tx = fx - i, ty = fy - j, tz = fz - k;
        const c000 = this.at(i, j, k), c100 = this.at(i + 1, j, k), c010 = this.at(i, j + 1, k), c110 = this.at(i + 1, j + 1, k);
        const c001 = this.at(i, j, k + 1), c101 = this.at(i + 1, j, k + 1), c011 = this.at(i, j + 1, k + 1), c111 = this.at(i + 1, j + 1, k + 1);
        const x00 = c000 + (c100 - c000) * tx, x10 = c010 + (c110 - c010) * tx, x01 = c001 + (c101 - c001) * tx, x11 = c011 + (c111 - c011) * tx;
        const y0 = x00 + (x10 - x00) * ty, y1 = x01 + (x11 - x01) * ty;
        if (grad) {
            const dx0 = (c100 - c000) * (1 - ty) + (c110 - c010) * ty, dx1 = (c101 - c001) * (1 - ty) + (c111 - c011) * ty;
            grad[0] = (dx0 * (1 - tz) + dx1 * tz) * this.inv;
            grad[1] = ((x10 - x00) * (1 - tz) + (x11 - x01) * tz) * this.inv;
            grad[2] = (y1 - y0) * this.inv;
        }
        return y0 + (y1 - y0) * tz;
    }
}

// --- Octree dual contouring ----------------------------------------------------------------------

/** A sphere of space that wants cells no larger than `size`. */
export interface DetailRegion { center: Vec3; radius: number; size: number }

export interface MeshFieldOptions {
    /** Region to mesh (the field must be positive on its boundary). */
    box: Box;
    /** Cell size away from every detail region. */
    size: number;
    regions?: DetailRegion[];
    /** How much a field can exceed its true distance (approximate primitives); pruning slack. */
    lipschitz?: number;
}

export interface FieldMesh {
    positions: number[];
    normals: number[];
    indices: number[];
    /** Size of the cell each vertex came from. */
    cellSize: number[];
}

interface OctNode {
    x: number; y: number; z: number; s: number;
    up: OctNode | null;
    kids: OctNode[] | null;
    /** -1 none yet; otherwise this leaf's vertex. */
    v: number;
    /** Corner sign mask (bit set = inside); 0 or 255 for no crossing. */
    mask: number;
    f: Field;
}

const EDGES: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7], // along x
    [0, 2], [1, 3], [4, 6], [5, 7], // along y
    [0, 4], [1, 5], [2, 6], [3, 7], // along z
];

/** Meshes the zero set of `node` (negative inside). */
export function meshField(node: SdfNode, options: MeshFieldOptions): FieldMesh {
    const regions = options.regions ?? [];
    const L = options.lipschitz ?? 1.25;
    const minSize = Math.min(options.size, ...regions.map(r => r.size));
    const ext = Math.max(options.box[3] - options.box[0], options.box[4] - options.box[1], options.box[5] - options.box[2]);
    let depth = 0;
    while (minSize * (1 << depth) < ext) depth++;
    const unit = minSize;
    const N = 1 << depth;
    const ox = (options.box[0] + options.box[3]) / 2 - (N * unit) / 2;
    const oy = (options.box[1] + options.box[4]) / 2 - (N * unit) / 2;
    const oz = (options.box[2] + options.box[5]) / 2 - (N * unit) / 2;
    const K = N + 1;
    const rootField = fieldOf(node);
    const corner = new CornerTable();
    const cornerValue = (f: Field, i: number, j: number, k: number) => {
        const key = (k * K + j) * K + i;
        let v = corner.get(key);
        if (v !== v) { v = f(ox + i * unit, oy + j * unit, oz + k * unit); corner.set(key, v); }
        return v;
    };
    // Smallest wanted cell anywhere in a box.
    const targetIn = (x0: number, y0: number, z0: number, w: number) => {
        let t = options.size;
        for (const r of regions) {
            if (r.size >= t) continue;
            const dx = Math.max(x0 - r.center[0], 0, r.center[0] - (x0 + w)), dy = Math.max(y0 - r.center[1], 0, r.center[1] - (y0 + w)), dz = Math.max(z0 - r.center[2], 0, r.center[2] - (z0 + w));
            if (dx * dx + dy * dy + dz * dz <= r.radius * r.radius) t = r.size;
        }
        return t;
    };
    const leaves: OctNode[] = [];
    const build = (n: OctNode, sdf: SdfNode, level: number): void => {
        const w = n.s * unit;
        const x0 = ox + n.x * unit, y0 = oy + n.y * unit, z0 = oz + n.z * unit;
        const cx = x0 + w / 2, cy = y0 + w / 2, cz = z0 + w / 2, h = w * 0.8661;
        // Re-specialize the tree every third level; in between, the parent's tree bounds the cell.
        if (level % 3 === 0) {
            const sp = sdf.spec(cx, cy, cz, h, L);
            if (SPEC.lo > 0) { n.mask = 0; return; }
            if (SPEC.hi < 0) { n.mask = 255; return; }
            sdf = sp;
            n.f = sdf.fn();
        } else {
            n.f = sdf.fn();
            const c = n.f(cx, cy, cz);
            if (Math.abs(c) > h * L) { n.mask = c < 0 ? 255 : 0; return; }
        }
        // Cells come in powers of two: keep one up to 1.45 times its target rather than halving it.
        if (n.s > 1 && w > targetIn(x0, y0, z0, w) * 1.45) {
            const h = n.s / 2;
            n.kids = [];
            for (let k = 0; k < 8; k++) {
                const kid: OctNode = { x: n.x + (k & 1) * h, y: n.y + ((k >> 1) & 1) * h, z: n.z + ((k >> 2) & 1) * h, s: h, up: n, kids: null, v: -1, mask: 0, f: rootField };
                n.kids.push(kid);
                build(kid, sdf, level + 1);
            }
            return;
        }
        const f = n.f;
        let mask = 0;
        for (let k = 0; k < 8; k++) if (cornerValue(f, n.x + (k & 1) * n.s, n.y + ((k >> 1) & 1) * n.s, n.z + ((k >> 2) & 1) * n.s) < 0) mask |= 1 << k;
        n.mask = mask;
        if (mask !== 0 && mask !== 255) leaves.push(n);
    };
    const root: OctNode = { x: 0, y: 0, z: 0, s: N, up: null, kids: null, v: -1, mask: 0, f: rootField };
    build(root, node, 0);

    const positions: number[] = [], normals: number[] = [], cellSize: number[] = [];
    const place = (n: OctNode): number => {
        if (n.v >= 0) return n.v;
        const w = n.s * unit;
        const x0 = ox + n.x * unit, y0 = oy + n.y * unit, z0 = oz + n.z * unit;
        const f = n.f;
        let px = 0, py = 0, pz = 0, cnt = 0;
        if (n.mask !== 0 && n.mask !== 255) {
            for (let e = 0; e < 12; e++) {
                const a = EDGES[e][0], b = EDGES[e][1];
                const ia = (n.mask >> a) & 1, ib = (n.mask >> b) & 1;
                if (ia === ib) continue;
                const fa = cornerValue(f, n.x + (a & 1) * n.s, n.y + ((a >> 1) & 1) * n.s, n.z + ((a >> 2) & 1) * n.s);
                const fb = cornerValue(f, n.x + (b & 1) * n.s, n.y + ((b >> 1) & 1) * n.s, n.z + ((b >> 2) & 1) * n.s);
                const t = Math.min(1, Math.max(0, fa / (fa - fb)));
                px += x0 + ((a & 1) + ((b & 1) - (a & 1)) * t) * w;
                py += y0 + (((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t) * w;
                pz += z0 + (((a >> 2) & 1) + (((b >> 2) & 1) - ((a >> 2) & 1)) * t) * w;
                cnt++;
            }
        }
        if (cnt) { px /= cnt; py /= cnt; pz /= cnt; } else { px = x0 + w / 2; py = y0 + w / 2; pz = z0 + w / 2; }
        // A Newton step onto the surface, kept inside the cell; its gradient is the normal.
        const h = Math.max(unit * 0.25, w * 0.05);
        const v = f(px, py, pz);
        let gx = (f(px + h, py, pz) - v) / h, gy = (f(px, py + h, pz) - v) / h, gz = (f(px, py, pz + h) - v) / h;
        const g2 = gx * gx + gy * gy + gz * gz;
        if (g2 > 1e-12) {
            const s = v / g2;
            px = Math.min(x0 + w, Math.max(x0, px - gx * s));
            py = Math.min(y0 + w, Math.max(y0, py - gy * s));
            pz = Math.min(z0 + w, Math.max(z0, pz - gz * s));
        }
        const gl = Math.sqrt(g2) || 1;
        gx /= gl; gy /= gl; gz /= gl;
        if (g2 <= 1e-12) { gx = 0; gy = 1; gz = 0; }
        n.v = positions.length / 3;
        positions.push(px, py, pz);
        normals.push(gx, gy, gz);
        cellSize.push(w);
        return n.v;
    };
    // Leaf containing a lattice-space point, searched up from a nearby leaf and back down.
    const locate = (from: OctNode, x: number, y: number, z: number): OctNode | null => {
        if (x < 0 || y < 0 || z < 0 || x >= N || y >= N || z >= N) return null;
        let n = from;
        while (n.up && (x < n.x || y < n.y || z < n.z || x >= n.x + n.s || y >= n.y + n.s || z >= n.z + n.s)) n = n.up;
        while (n.kids) {
            const h = n.s / 2;
            n = n.kids[(x >= n.x + h ? 1 : 0) + (y >= n.y + h ? 2 : 0) + (z >= n.z + h ? 4 : 0)];
        }
        return n;
    };
    const indices: number[] = [];
    const quad: OctNode[] = [null!, null!, null!, null!];
    const ids = [0, 0, 0, 0];
    const m = [0, 0, 0], p = [0, 0, 0];
    for (const leaf of leaves) {
        for (let e = 0; e < 12; e++) {
            const a = EDGES[e][0], b = EDGES[e][1];
            const ia = (leaf.mask >> a) & 1, ib = (leaf.mask >> b) & 1;
            if (ia === ib) continue;
            const axis = e >> 2; // 0 x, 1 y, 2 z
            const u = (axis + 1) % 3, v = (axis + 2) % 3;
            // Edge midpoint in lattice units.
            m[0] = leaf.x + (a & 1) * leaf.s; m[1] = leaf.y + ((a >> 1) & 1) * leaf.s; m[2] = leaf.z + ((a >> 2) & 1) * leaf.s;
            m[axis] += leaf.s / 2;
            let finer = false, emitter = -1;
            for (let q = 0; q < 4; q++) {
                const du = q === 1 || q === 2 ? 0.25 : -0.25, dv = q >= 2 ? 0.25 : -0.25;
                p[0] = m[0]; p[1] = m[1]; p[2] = m[2];
                p[u] += du; p[v] += dv;
                const c = locate(leaf, p[0], p[1], p[2]);
                if (!c) { finer = true; break; }
                if (c.s < leaf.s) { finer = true; break; }
                if (c.s === leaf.s && emitter < 0) emitter = q;
                quad[q] = c;
            }
            if (finer || quad[emitter] !== leaf) continue;
            for (let q = 0; q < 4; q++) ids[q] = place(quad[q]);
            // Inside at the low end: the surface faces +axis, which the (u, v) order already winds toward.
            if (ia === 0) emitQuad(indices, positions, ids[0], ids[3], ids[2], ids[1]);
            else emitQuad(indices, positions, ids[0], ids[1], ids[2], ids[3]);
        }
    }
    return { positions, normals, indices, cellSize };
}

function emitQuad(indices: number[], P: number[], a: number, b: number, c: number, d: number): void {
    const dist = (i: number, j: number) => (P[i * 3] - P[j * 3]) ** 2 + (P[i * 3 + 1] - P[j * 3 + 1]) ** 2 + (P[i * 3 + 2] - P[j * 3 + 2]) ** 2;
    const tri = (x: number, y: number, z: number) => { if (x !== y && y !== z && x !== z) indices.push(x, y, z); };
    if (dist(a, c) <= dist(b, d)) { tri(a, b, c); tri(a, c, d); } else { tri(a, b, d); tri(b, c, d); }
}

/** Lattice corner values by integer key: open addressing, far cheaper than a Map at this scale. */
class CornerTable {
    private keys = new Float64Array(1 << 16).fill(-1);
    private vals = new Float32Array(1 << 16);
    private size = 0;
    private mask = (1 << 16) - 1;
    private slot(key: number): number {
        let h = (Math.imul((key % 2147483647) | 0, 0x9e3779b1) ^ ((key / 4294967296) | 0)) & this.mask;
        while (this.keys[h] !== -1 && this.keys[h] !== key) h = (h + 1) & this.mask;
        return h;
    }
    get(key: number): number {
        const h = this.slot(key);
        return this.keys[h] === key ? this.vals[h] : NaN;
    }
    set(key: number, v: number): void {
        if ((this.size + 1) * 2 > this.keys.length) this.grow();
        const h = this.slot(key);
        if (this.keys[h] !== key) { this.keys[h] = key; this.size++; }
        this.vals[h] = v;
    }
    private grow(): void {
        const ok = this.keys, ov = this.vals;
        this.keys = new Float64Array(ok.length * 2).fill(-1);
        this.vals = new Float32Array(ok.length * 2);
        this.mask = this.keys.length - 1;
        for (let i = 0; i < ok.length; i++) if (ok[i] !== -1) { const h = this.slot(ok[i]); this.keys[h] = ok[i]; this.vals[h] = ov[i]; }
    }
}
