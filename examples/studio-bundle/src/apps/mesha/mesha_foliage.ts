// Foliage builders for the component catalog: leaves, fronds, scattering leaves over a volume, and a
// branching crown that grows from a trunk. Plants are thin open sheets and small tubes, so these
// are written to keep every triangle well formed (no collapsed tips, no folded sheets) at any
// parameter values the fuzzer throws at them.

import { type Mesh, type Mat4, type Vec3, emptyMesh, join, newPart, partMesh, vertex, tri, recomputeNormals, transformMesh, normalize3, cross3, add3, sub3, scale3, length3 } from "./mesha_mesh";
import { hash01 } from "./mesha_noise";
import { sweep } from "./mesha_primitives";
import { circle2 } from "./mesha_curves";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const GOLDEN = 2.399963229728653;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// --- Leaves --------------------------------------------------------------------------------------

export interface LeafOptions {
    length: number;
    width: number;
    /** Where along the blade it is widest, 0..1 (low is ovate, high is obovate). */
    widest: number;
    /** Below 1 the ends are rounder, above 1 they are pointier. */
    fullness: number;
    /** A bare petiole before the blade starts. */
    stalk: number;
    /** Degrees the two halves fold up along the midrib (V section). */
    fold: number;
    /** Degrees the whole blade bends away from its front face, tip down. */
    curl: number;
    /** Ruffle along the edges, as a share of half the width. */
    wave: number;
    waveCount: number;
    /** Saw teeth along the edge (0 is smooth). */
    teeth: number;
    toothDepth: number;
    /** 0 is a simple leaf; 3 or more makes a palmate leaf (maple, fan palm) with that many lobes. */
    lobes: number;
    lobeDepth: number;
    /** Degrees a palmate leaf fans across. */
    spread: number;
    /** Rows along the blade and columns on each half. */
    rows: number;
    half: number;
}

export const LEAF_DEFAULTS: LeafOptions = {
    length: 1, width: 0.5, widest: 0.4, fullness: 1, stalk: 0, fold: 15, curl: 20, wave: 0, waveCount: 3, teeth: 0, toothDepth: 0.15,
    lobes: 0, lobeDepth: 0.5, spread: 200, rows: 5, half: 1,
};

function widthProfile(t: number, widest: number, fullness: number): number {
    if (t <= 0 || t >= 1) return 0;
    const k = Math.log(0.5) / Math.log(clamp(widest, 0.05, 0.95));
    return Math.pow(Math.sin(Math.PI * Math.pow(t, k)), Math.max(0.15, fullness));
}

/**
 * A leaf lying in the XY plane: base at the origin, tip along +Y, front face toward +Z. Curl bends
 * it toward -Z (so laid with its front up, the tip droops), fold lifts both edges toward +Z.
 */
export function leaf(options: Partial<LeafOptions>): Mesh {
    const o = { ...LEAF_DEFAULTS, ...options };
    const L = Math.max(1e-4, o.length), W = Math.max(1e-4, o.width);
    const half = Math.max(1, Math.round(o.half));
    const kappa = (o.curl * DEG) / L;
    const fold = clamp(o.fold, -65, 65) * DEG;
    const cf = Math.cos(fold), sf = Math.sin(fold);
    // Curl is constant curvature about the x axis: distance y along the blade lands at (py, pz).
    const bend = (y: number, x: number, lift: number): Vec3 => {
        const a = kappa * y;
        if (Math.abs(kappa) < 1e-7) return [x, y, lift];
        return [x, Math.sin(a) / kappa + lift * Math.sin(a), -(1 - Math.cos(a)) / kappa + lift * Math.cos(a)];
    };
    const part = newPart();
    const grid = (rowsOf: { y: number; hw: number; t: number }[]) => {
        const cols = half * 2 + 1;
        for (const r of rowsOf) {
            for (let j = 0; j < cols; j++) {
                const u = (j - half) / half;
                const x = u * r.hw;
                const edge = Math.abs(u);
                const lift = Math.abs(x) * sf + (o.wave > 0 ? o.wave * r.hw * edge * edge * Math.sin(o.waveCount * TAU * r.t) : 0);
                const p = bend(r.y, x * cf, lift);
                vertex(part, p, [0, 0, 1], [u * 0.5 + 0.5, r.y / L]);
            }
        }
        for (let k = 0; k < rowsOf.length - 1; k++) {
            for (let j = 0; j < cols - 1; j++) {
                const a = k * cols + j, b = a + 1, c = b + cols, d = a + cols;
                tri(part, a, b, c); tri(part, a, c, d);
            }
        }
    };
    if (o.lobes >= 3) {
        // Palmate: rays fan from the base, the radius pulled in between lobes.
        const lobes = Math.min(24, Math.round(o.lobes));
        const spread = clamp(o.spread, 60, 340) * DEG;
        const rays = (lobes - 1) * 4 + 1;
        const rings = Math.max(3, Math.min(8, Math.round(o.rows / 2 + 1)));
        const depth = clamp(o.lobeDepth, 0, 0.85);
        const base = o.stalk;
        const at = (r: number, theta: number): Vec3 => {
            const x = Math.sin(theta) * r, y = base + Math.cos(theta) * r;
            const lift = Math.abs(x) * sf;
            return bend(y, x * cf, lift);
        };
        // The stalk (a thin strip) first.
        const hwS = Math.max(W * 0.02, 1e-4);
        if (base > 1e-6) {
            for (const y of [0, base]) for (const x of [-hwS, hwS]) vertex(part, bend(y, x, 0), [0, 0, 1], [0.5, y / L]);
            tri(part, 0, 1, 3); tri(part, 0, 3, 2);
        }
        const apex = part.positions.length / 3;
        vertex(part, bend(base, 0, 0), [0, 0, 1], [0.5, 0]);
        const first = part.positions.length / 3;
        for (let i = 1; i <= rings; i++) {
            const s = i / rings;
            for (let j = 0; j < rays; j++) {
                const theta = ((j / (rays - 1)) - 0.5) * spread;
                const p = (j / (rays - 1)) * (lobes - 1);
                const tri01 = Math.abs(p - Math.round(p)) * 2; // 0 at a lobe tip, 1 in the notch
                const radius = (L - base) * (1 - depth * Math.pow(tri01, 1.1)) * s;
                vertex(part, at(radius, theta), [0, 0, 1], [j / (rays - 1), s]);
            }
        }
        for (let j = 0; j < rays - 1; j++) tri(part, apex, first + j + 1, first + j);
        for (let i = 0; i < rings - 1; i++) {
            for (let j = 0; j < rays - 1; j++) {
                const a = first + i * rays + j, b = a + 1, c = b + rays, d = a + rays;
                tri(part, a, b, c); tri(part, a, c, d);
            }
        }
        // The palmate blade is `length` long; fit `width` by scaling x.
        const mesh = partMesh(part);
        const sx = W / Math.max(1e-6, 2 * (L - base) * Math.sin(Math.min(spread / 2, Math.PI / 2)));
        const sized = transformMesh(mesh, [sx, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        return recomputeNormals(sized, true);
    }
    const rows = Math.max(2, Math.min(64, Math.max(Math.round(o.rows), Math.round(o.teeth) * 2 + 2)));
    const floor = Math.max(W * 0.014, 1e-5);
    const list: { y: number; hw: number; t: number }[] = [];
    if (o.stalk > 1e-6) list.push({ y: 0, hw: floor, t: 0 });
    for (let k = 0; k <= rows; k++) {
        const t = k / rows;
        let hw = (W / 2) * widthProfile(t, o.widest, o.fullness);
        if (o.teeth > 0 && k > 0 && k < rows && k % 2 === 1) hw *= 1 - clamp(o.toothDepth, 0, 0.6);
        list.push({ y: o.stalk + t * L, hw: Math.max(hw, floor), t });
    }
    grid(list);
    return recomputeNormals(partMesh(part), true);
}

// --- Frames and placement ------------------------------------------------------------------------

/** A matrix whose +Y is `y`, whose +Z is as near `zHint` as it can be, uniformly scaled by `s` and rolled about `y`. */
export function frame(origin: Vec3, y: Vec3, zHint: Vec3, s: number, rollRad = 0): Mat4 {
    const Y = normalize3(y);
    let X = cross3(Y, zHint);
    if (length3(X) < 1e-5) X = cross3(Y, Math.abs(Y[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]);
    X = normalize3(X);
    let Z = cross3(X, Y);
    if (rollRad) {
        const c = Math.cos(rollRad), sn = Math.sin(rollRad);
        const X2: Vec3 = [X[0] * c + Z[0] * sn, X[1] * c + Z[1] * sn, X[2] * c + Z[2] * sn];
        const Z2: Vec3 = [Z[0] * c - X[0] * sn, Z[1] * c - X[1] * sn, Z[2] * c - X[2] * sn];
        X = X2; Z = Z2;
    }
    return [X[0] * s, X[1] * s, X[2] * s, 0, Y[0] * s, Y[1] * s, Y[2] * s, 0, Z[0] * s, Z[1] * s, Z[2] * s, 0, origin[0], origin[1], origin[2], 1];
}

// --- Fronds --------------------------------------------------------------------------------------

export interface FrondOptions {
    length: number;
    pairs: number;
    /** Longest leaflet, as a share of the frond's length. */
    leafletLength: number;
    /** Leaflet width as a share of its own length. */
    leafletWidth: number;
    /** Degrees between each leaflet and the rachis (90 is square, smaller sweeps forward). */
    angle: number;
    /** Degrees the leaflets tilt up out of the frond's plane. */
    lift: number;
    /** Degrees each leaflet curls down along its length. */
    droop: number;
    /** Degrees the whole frond arches (tip down). */
    curl: number;
    /** Where along the frond the leaflets are longest, 0..1. */
    peak: number;
    /** Share of the frond that is bare stalk at the base. */
    gap: number;
    rachis: number;
    fold: number;
}

/**
 * A pinnate frond (fern, palm, fir bough): a rachis arching along +Y with pairs of leaflets. Base
 * at the origin, front (upper) face toward +Z, curling toward -Z like `leaf`.
 */
export function frond(o: FrondOptions): Mesh {
    const L = Math.max(1e-3, o.length);
    const pairs = Math.max(1, Math.min(60, Math.round(o.pairs)));
    const kappa = (o.curl * DEG) / L;
    const at = (s: number): { p: Vec3; T: Vec3; N: Vec3 } => {
        const a = kappa * s;
        if (Math.abs(kappa) < 1e-7) return { p: [0, s, 0], T: [0, 1, 0], N: [0, 0, 1] };
        return { p: [0, Math.sin(a) / kappa, -(1 - Math.cos(a)) / kappa], T: [0, Math.cos(a), -Math.sin(a)], N: [0, Math.sin(a), Math.cos(a)] };
    };
    const leafletL = Math.max(1e-3, o.leafletLength * L);
    const unit = leaf({ length: 1, width: clamp(o.leafletWidth, 0.02, 0.9), widest: 0.4, fullness: 0.9, fold: o.fold, curl: o.droop, rows: 2, half: 1 });
    const parts: Mesh[] = [];
    const gap = clamp(o.gap, 0, 0.7);
    const angle = clamp(o.angle, 15, 90) * DEG, lift = Math.tan(clamp(o.lift, -60, 60) * DEG) * Math.sin(angle);
    for (let i = 0; i < pairs; i++) {
        const tt = (i + 0.5) / pairs;
        const t = gap + (1 - gap) * tt;
        const { p, T, N } = at(t * L);
        const size = leafletL * Math.max(0.16, widthProfile(tt, clamp(o.peak, 0.1, 0.9), 0.75));
        for (const side of [-1, 1]) {
            const dir = normalize3(add3(add3(scale3(T, Math.cos(angle)), scale3([1, 0, 0], side * Math.sin(angle))), scale3(N, lift)));
            parts.push(transformMesh(unit, frame(p, dir, N, size)));
        }
    }
    // Terminal leaflet.
    const end = at(L);
    parts.push(transformMesh(unit, frame(end.p, end.T, end.N, leafletL * 0.4)));
    const path: Vec3[] = Array.from({ length: 9 }, (_, k) => at((k / 8) * L).p);
    parts.push(sweep(path, circle2(Math.max(1e-4, o.rachis), 5), { scales: path.map((_, k) => lerp(1, 0.35, k / 8)) }));
    return join(...parts);
}

// --- Scattering ----------------------------------------------------------------------------------

export interface ScatterOptions {
    mesh: Mesh;
    centers: Vec3[];
    count: number;
    volume: "sphere" | "dome" | "cone" | "disc" | "column" | "box";
    size: Vec3;
    /** 0 fills the volume, 1 only its surface. */
    hollow: number;
    orient: "outward" | "up" | "random" | "surface";
    /** Degrees of random wobble in each direction (for "surface": how far each copy may spin from pointing downhill). */
    spread: number;
    /** Pulls every direction toward -Y (0..1). */
    droop: number;
    scaleMin: number;
    scaleMax: number;
    /** Degrees of random roll about each instance's own axis. */
    roll: number;
    /** Copies whose base would lie below this height are left out (keeps foliage off the ground). */
    minY: number;
    seed: number;
}

/** Copies of `mesh` (base at the origin, pointing along +Y) spread over a volume around each center. */
export function scatter(o: ScatterOptions): Mesh {
    const parts: Mesh[] = [];
    const n = Math.max(0, Math.min(2000, Math.round(o.count)));
    if (!n || !o.mesh.parts.length) return emptyMesh();
    const up: Vec3 = [0, 1, 0];
    const hollow = clamp(o.hollow, 0, 1);
    o.centers.forEach((c, ci) => {
        const key = ci * 7919 + 3;
        for (let i = 0; i < n; i++) {
            const h = (k: number) => hash01(o.seed, key + i * 31, k);
            let p: Vec3, out: Vec3;
            const radial = hollow + (1 - hollow) * Math.cbrt(h(1));
            const phase = i * GOLDEN + ci * 1.7 + h(2) * 0.5;
            switch (o.volume) {
                case "dome": case "sphere": {
                    const y = o.volume === "dome" ? 1 - (i + 0.5) / n + (h(3) - 0.5) * 0.4 / n : 1 - (2 * (i + 0.5)) / n + (h(3) - 0.5) * 0.8 / n;
                    const yy = clamp(y, o.volume === "dome" ? 0 : -1, 1);
                    const r = Math.sqrt(Math.max(0, 1 - yy * yy));
                    const d: Vec3 = [Math.cos(phase) * r, yy, Math.sin(phase) * r];
                    p = [d[0] * o.size[0] * radial, d[1] * o.size[1] * radial, d[2] * o.size[2] * radial];
                    out = normalize3([d[0] / Math.max(o.size[0], 1e-6), d[1] / Math.max(o.size[1], 1e-6), d[2] / Math.max(o.size[2], 1e-6)]);
                    break;
                }
                case "cone": case "column": {
                    const v = (i + 0.5) / n;
                    const taper = o.volume === "cone" ? 1 - v : 1;
                    const rr = Math.sqrt(hollow * hollow + (1 - hollow * hollow) * h(1)) * taper;
                    p = [Math.cos(phase) * rr * o.size[0], v * o.size[1], Math.sin(phase) * rr * o.size[2]];
                    out = normalize3([Math.cos(phase), o.volume === "cone" ? 0.35 : 0, Math.sin(phase)]);
                    break;
                }
                case "box": {
                    // The skin of a box (size is its half extents), top and four sides, stratified by face area.
                    const [hx, hy, hz] = o.size;
                    const areas = [hy * hz, hy * hz, hx * hz, hx * hy, hx * hy];
                    const total = areas.reduce((a, b) => a + b, 0) || 1;
                    let pick = ((i + 0.5) / n) * total, face = 0;
                    while (face < 4 && pick > areas[face]) { pick -= areas[face]; face++; }
                    const u = h(12) * 2 - 1, v = h(13) * 2 - 1;
                    const inset = (1 - hollow) * h(1) * Math.min(hx, hy, hz) * 0.8;
                    switch (face) {
                        case 0: p = [hx - inset, v * hy, u * hz]; out = [1, 0, 0]; break;
                        case 1: p = [-hx + inset, v * hy, u * hz]; out = [-1, 0, 0]; break;
                        case 2: p = [u * hx, hy - inset, v * hz]; out = [0, 1, 0]; break;
                        case 3: p = [u * hx, v * hy, hz - inset]; out = [0, 0, 1]; break;
                        default: p = [u * hx, v * hy, -hz + inset]; out = [0, 0, -1];
                    }
                    break;
                }
                default: {
                    const rr = Math.sqrt(hollow * hollow + (1 - hollow * hollow) * ((i + 0.5) / n));
                    p = [Math.cos(phase) * rr * o.size[0], 0, Math.sin(phase) * rr * o.size[2]];
                    out = normalize3([Math.cos(phase) * rr, 0.9, Math.sin(phase) * rr]);
                }
            }
            let d: Vec3;
            let zHint = up;
            if (o.orient === "surface") {
                // Lying on the volume's skin, facing out, long axis running downhill (spun by up to `spread`).
                zHint = out;
                let t0 = sub3([0, -1, 0], scale3(out, -out[1]));
                if (length3(t0) < 0.2) t0 = cross3(out, [h(4) - 0.5, 0.3, h(5) - 0.5]);
                t0 = normalize3(t0, [1, 0, 0]);
                const spin = (h(7) - 0.5) * 2 * clamp(o.spread, 0, 180) * DEG;
                d = add3(scale3(t0, Math.cos(spin)), scale3(cross3(out, t0), Math.sin(spin)));
            } else {
                d = o.orient === "up" ? up : o.orient === "random" ? normalize3([h(4) - 0.5, h(5) - 0.5, h(6) - 0.5]) : out;
                if (o.spread > 0) {
                    const s = Math.tan(clamp(o.spread, 0, 89) * DEG);
                    d = add3(d, [(h(7) - 0.5) * 2 * s, (h(8) - 0.5) * 2 * s, (h(9) - 0.5) * 2 * s]);
                }
            }
            d = normalize3(add3(d, [0, -clamp(o.droop, 0, 1.5), 0]));
            const s = lerp(o.scaleMin, o.scaleMax, h(10));
            if (c[1] + p[1] < o.minY) continue;
            const m = frame(add3(c, p), d, zHint, Math.max(1e-4, s), (h(11) - 0.5) * 2 * o.roll * DEG);
            parts.push(transformMesh(o.mesh, m));
        }
    });
    return join(...parts);
}

// --- Rosettes ------------------------------------------------------------------------------------

export interface RosetteOptions {
    mesh: Mesh;
    count: number;
    layers: number;
    /** Degrees from vertical the first layer leans out (0 is upright, 90 lies flat). */
    open: number;
    /** Added to `open` on each further layer. */
    openStep: number;
    /** Each further layer's scale relative to the last. */
    scaleStep: number;
    /** Height gained per layer. */
    lift: number;
    /** Random tilt, roll and scale (0..1). */
    jitter: number;
    seed: number;
}

/**
 * Copies of `mesh` (base at the origin, +Y along it, front toward +Z) around the Y axis, each
 * leaning out `open` degrees with its front facing in and up, layer on layer: petals, agave and
 * succulent whorls, lily and tulip cups.
 */
export function rosette(o: RosetteOptions): Mesh {
    const n = Math.max(1, Math.min(200, Math.round(o.count)));
    const layers = Math.max(1, Math.min(8, Math.round(o.layers)));
    const parts: Mesh[] = [];
    for (let l = 0; l < layers; l++) {
        for (let k = 0; k < n; k++) {
            const h = (q: number) => hash01(o.seed, l * 977 + k * 31 + 7, q);
            const az = ((k + (l % 2) * 0.5 + l * 0.17) / n) * TAU + (h(1) - 0.5) * o.jitter * 0.5;
            const alpha = clamp(o.open + l * o.openStep + (h(2) - 0.5) * o.jitter * 24, 0, 175) * DEG;
            const ca = Math.cos(az), sa = Math.sin(az);
            const d: Vec3 = [ca * Math.sin(alpha), Math.cos(alpha), sa * Math.sin(alpha)];
            const inward: Vec3 = [-ca * Math.cos(alpha), Math.sin(alpha), -sa * Math.cos(alpha)];
            const s = Math.max(1e-4, Math.pow(o.scaleStep, l) * (1 + (h(3) - 0.5) * o.jitter * 0.4));
            parts.push(transformMesh(o.mesh, frame([0, l * o.lift, 0], d, inward, s, (h(4) - 0.5) * o.jitter * 40 * DEG)));
        }
    }
    return join(...parts);
}

// --- Branching crowns ----------------------------------------------------------------------------

export type Envelope = "round" | "spreading" | "columnar" | "conical" | "vase";

/** The crown's outline: radius (0..1) at height v (0 base, 1 top). */
export function envelopeRadius(kind: Envelope, v: number): number {
    switch (kind) {
        case "spreading": return clamp((0.5 + 0.5 * Math.sin(Math.min(1, v * 1.7) * Math.PI / 2)) * (1 - 0.6 * Math.max(0, (v - 0.72) / 0.28) ** 1.5), 0.2, 1);
        case "columnar": return clamp(Math.pow(Math.sin(Math.PI * (0.06 + 0.88 * v)), 0.55), 0.22, 1);
        case "conical": return clamp(1 - v * 0.9, 0.12, 1);
        case "vase": return clamp(0.32 + 0.68 * Math.pow(v, 0.9) * (1 - 0.3 * Math.pow(v, 4)), 0.25, 1);
        default: return clamp(Math.sqrt(Math.max(0, 1 - (2 * v - 1) ** 2)) * 0.95 + 0.15 * (1 - v), 0.2, 1);
    }
}

export interface BranchOptions {
    trunk: Vec3[];
    count: number;
    /** Where the crown starts and how tall and wide it is. */
    crownBase: number;
    crownHeight: number;
    crownRadius: number;
    envelope: Envelope;
    /** Degrees a branch rises from the trunk. */
    angle: number;
    /** How far the tips sag, as a share of the reach. */
    droop: number;
    /** How much each branch bows up before it bends out, as a share of the reach. */
    arch: number;
    radius: number;
    taper: number;
    twigs: number;
    twigLength: number;
    twigSpread: number;
    jitter: number;
    /** No branch or twig ends lower than this. */
    minTipY: number;
    seed: number;
    sides: number;
}

const bez2 = (a: Vec3, c: Vec3, b: Vec3, t: number): Vec3 => {
    const u = 1 - t;
    return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1], u * u * a[2] + 2 * u * t * c[2] + t * t * b[2]];
};

/** Grows the crown's branches and twigs; returns their meshes and every branch/twig tip (plus the trunk's top). */
export function growBranches(o: BranchOptions): { mesh: Mesh; tips: Vec3[] } {
    const trunk = o.trunk;
    const tips: Vec3[] = [];
    if (trunk.length < 2) return { mesh: emptyMesh(), tips };
    const top = trunk[trunk.length - 1];
    tips.push(top);
    const trunkAt = (y: number): Vec3 => {
        for (let i = 0; i < trunk.length - 1; i++) {
            const a = trunk[i], b = trunk[i + 1];
            if (y <= b[1] || i === trunk.length - 2) {
                const t = clamp((y - a[1]) / Math.max(1e-6, b[1] - a[1]), 0, 1);
                return [lerp(a[0], b[0], t), y, lerp(a[2], b[2], t)];
            }
        }
        return top;
    };
    const count = Math.max(0, Math.min(40, Math.round(o.count)));
    const sides = Math.max(3, Math.min(12, Math.round(o.sides)));
    const profile = circle2(1, sides);
    const meshes: Mesh[] = [];
    const tube = (pts: Vec3[], r0: number, taper: number) => {
        const scales = pts.map((_, k) => r0 * lerp(1, taper, k / (pts.length - 1)));
        meshes.push(sweep(pts, profile, { scales }));
    };
    const rise = Math.tan(clamp(o.angle, 5, 80) * DEG);
    const h = (i: number, k: number) => hash01(o.seed, i * 131 + 5, k);
    for (let i = 0; i < count; i++) {
        const u = (i + 0.5) / count;
        const v = 0.06 + 0.9 * u;
        const phi = i * GOLDEN + (h(i, 1) - 0.5) * o.jitter * 2;
        const reach = Math.max(1e-3, o.crownRadius * envelopeRadius(o.envelope, v) * (1 + (h(i, 2) - 0.5) * o.jitter * 0.8));
        const tipY = Math.max(o.minTipY, o.crownBase + o.crownHeight * v - o.droop * reach * 0.6);
        const attachY = clamp(tipY - reach * rise * 0.55, Math.max(0.05, trunk[0][1] + (top[1] - trunk[0][1]) * 0.08), top[1] * 0.985);
        const A = trunkAt(attachY);
        const dir: Vec3 = [Math.cos(phi), 0, Math.sin(phi)];
        const tip = add3(A, [dir[0] * reach, tipY - A[1], dir[2] * reach]);
        const C: Vec3 = [A[0] + dir[0] * reach * 0.45, lerp(A[1], tip[1], 0.55) + o.arch * reach * 0.5, A[2] + dir[2] * reach * 0.45];
        const path = Array.from({ length: 7 }, (_, k) => bez2(A, C, tip, k / 6));
        const r0 = o.radius * lerp(1, 0.6, u);
        tube(path, r0, o.taper);
        tips.push(tip);
        for (let k = 0; k < Math.max(0, Math.round(o.twigs)); k++) {
            const s = lerp(0.35, 0.78, (k + 0.5) / Math.max(1, Math.round(o.twigs)));
            const B = bez2(A, C, tip, s);
            const B2 = bez2(A, C, tip, Math.min(1, s + 0.05));
            const along = normalize3(sub3(B2, B));
            const side = k % 2 === 0 ? 1 : -1;
            const a = side * (o.twigSpread + (h(i * 7 + k, 3) - 0.5) * 20) * DEG;
            const flat: Vec3 = normalize3([along[0] * Math.cos(a) - along[2] * Math.sin(a), 0.18, along[0] * Math.sin(a) + along[2] * Math.cos(a)]);
            const Lt = reach * Math.max(0.05, o.twigLength) * lerp(1, 0.6, s);
            const T: Vec3 = [B[0] + flat[0] * Lt, Math.max(o.minTipY, B[1] + flat[1] * Lt - o.droop * Lt * 0.4), B[2] + flat[2] * Lt];
            const Cc: Vec3 = [(B[0] + T[0]) / 2, (B[1] + T[1]) / 2 + o.arch * Lt * 0.25, (B[2] + T[2]) / 2];
            tube(Array.from({ length: 5 }, (_, q) => bez2(B, Cc, T, q / 4)), r0 * 0.5 * lerp(1, 0.6, s), o.taper);
            tips.push(T);
        }
    }
    return { mesh: join(...meshes), tips };
}
