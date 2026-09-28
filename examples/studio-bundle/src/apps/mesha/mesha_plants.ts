// Foliage builders for Mesha's plant components: leaves, branching tree skeletons, pinnate fronds,
// grass clumps, scattering on the ground and distributing over a surface. Leaves are thin sheets
// built double-sided (the viewport culls back faces, and a GLB viewer usually does too).
//
// Foliage carries two extra values in its UVs, which the viewport's foliage shading reads:
//   uv.x  0 at a leaf's base, 1 at its tip (bases shade a little deeper),
//   uv.y  whole part: how buried the leaf is in its crown (0 outside .. 15 deep inside, darker);
//         fraction: how far its color leans toward the material's second tint (autumn mixes,
//         dry grass tips, per-leaf variety). See foliageV.

import { type Mesh, type Part, type Vec3, newPart, vertex, tri, join, normalize3, cross3, sub3, add3, scale3, dot3, length3 } from "./mesha_mesh";
import { rng, noise3 } from "./mesha_noise";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** A foliage uv.y: how deep in the crown (0..1) and how far toward the tint color (0..1). */
export function foliageV(occlusion: number, tint: number): number {
    return Math.round(clamp(occlusion, 0, 1) * 15) + clamp(tint, 0, 0.999);
}

/** Splits a foliage uv.y back into occlusion (0..1) and tint (0..1). */
export function splitFoliageV(v: number): { occlusion: number; tint: number } {
    const whole = Math.floor(v + 1e-6);
    return { occlusion: clamp(whole, 0, 15) / 15, tint: clamp(v - whole, 0, 1) };
}

/** Rewrites uv.y of vertices [from, to) of a part: occlusion replaced, `tint` added to whatever tint gradient they carry. */
function stamp(part: Part, from: number, to: number, occlusion: number, tint: number): void {
    for (let v = from; v < to; v++) {
        const own = splitFoliageV(part.uvs[v * 2 + 1]).tint;
        part.uvs[v * 2 + 1] = foliageV(occlusion, own + tint);
    }
}

// --- Leaves --------------------------------------------------------------------------------------

export const LEAF_SHAPES = ["ovate", "lanceolate", "round", "heart", "lobed", "blade", "petal", "spray"] as const;
export type LeafShape = typeof LEAF_SHAPES[number];

/** Half-width (0..1 of the leaf's width) at `t` (0 base .. 1 tip). */
function leafWidth(shape: LeafShape, t: number, lobes: number): number {
    const s = (x: number) => Math.max(0, Math.sin(Math.PI * clamp(x, 0, 1)));
    switch (shape) {
        case "lanceolate": return s(t ** 0.9) ** 1.4;
        case "round": return s(t ** 0.9) ** 0.5;
        case "heart": return s(0.22 + 0.78 * t ** 1.15) ** 0.7;
        case "lobed": return s(t ** 0.8) ** 0.85 * (0.5 + 0.5 * Math.abs(Math.cos(Math.PI * lobes * t)) ** 0.5);
        case "blade": return (1 - t) ** 0.6 * (0.75 + 0.25 * s(t));
        case "petal": return s(t ** 1.6) ** 0.6;
        case "spray": {
            const saw = Math.abs((t * lobes) % 1 - 0.5) * 2;
            return Math.sqrt(Math.max(0, 1 - t ** 3)) * (0.3 + 0.7 * saw ** 1.4);
        }
        default: return s(t ** 0.8) ** 0.85;
    }
}

export interface LeafOptions {
    shape?: LeafShape;
    length?: number;
    width?: number;
    /** Degrees each half rises from the midrib (a V-shaped leaf). */
    fold?: number;
    /** Degrees the blade bends down over its length. */
    curl?: number;
    /** Stalk length before the blade. */
    petiole?: number;
    segments?: number;
    /** Lobes (lobed) or teeth (spray). */
    lobes?: number;
    /** A tint gradient toward the tip (0..1): dry grass tips, lavender spikes. */
    tipTint?: number;
    region?: string;
}

/** A midline bending down in the YZ plane: point, tangent and upper normal at each of `rows + 1` stations. */
function bentMidline(length: number, rows: number, theta: (t: number) => number, z0 = 0): { p: Vec3[]; tan: Vec3[]; up: Vec3[] } {
    const p: Vec3[] = [[0, 0, z0]], tan: Vec3[] = [], up: Vec3[] = [];
    const sub = 4;
    let y = 0, z = z0;
    for (let r = 0; r <= rows; r++) {
        const t = r / rows, a = theta(t);
        tan.push([0, -Math.sin(a), Math.cos(a)]);
        up.push([0, Math.cos(a), Math.sin(a)]);
        if (r === rows) break;
        for (let k = 0; k < sub; k++) {
            const tm = (r + (k + 0.5) / sub) / rows, am = theta(tm);
            y -= Math.sin(am) * length / (rows * sub);
            z += Math.cos(am) * length / (rows * sub);
        }
        p.push([0, y, z]);
    }
    return { p, tan, up };
}

/** Normals from faces, accumulated per vertex index (a grid sheet shares its vertices). */
function faceNormals(part: Part, from: number): void {
    const n = part.positions.length / 3;
    const acc = new Float64Array((n - from) * 3);
    for (let t = 0; t < part.indices.length; t += 3) {
        const a = part.indices[t], b = part.indices[t + 1], c = part.indices[t + 2];
        if (a < from) continue;
        const pa: Vec3 = [part.positions[a * 3], part.positions[a * 3 + 1], part.positions[a * 3 + 2]];
        const fn = cross3(sub3([part.positions[b * 3], part.positions[b * 3 + 1], part.positions[b * 3 + 2]], pa), sub3([part.positions[c * 3], part.positions[c * 3 + 1], part.positions[c * 3 + 2]], pa));
        for (const v of [a, b, c]) { const o = (v - from) * 3; acc[o] += fn[0]; acc[o + 1] += fn[1]; acc[o + 2] += fn[2]; }
    }
    for (let v = from; v < n; v++) {
        const o = (v - from) * 3;
        const nn = normalize3([acc[o], acc[o + 1], acc[o + 2]], [0, 1, 0]);
        part.normals[v * 3] = nn[0]; part.normals[v * 3 + 1] = nn[1]; part.normals[v * 3 + 2] = nn[2];
    }
}

/** Appends the back face of vertices/triangles [vFrom.., tFrom..): same positions, flipped normals and winding. */
function addBackFace(part: Part, vFrom: number, tFrom: number): void {
    const vTo = part.positions.length / 3, tTo = part.indices.length;
    const offset = vTo - vFrom;
    for (let v = vFrom; v < vTo; v++) {
        vertex(part, [part.positions[v * 3], part.positions[v * 3 + 1], part.positions[v * 3 + 2]], [-part.normals[v * 3], -part.normals[v * 3 + 1], -part.normals[v * 3 + 2]], [part.uvs[v * 2], part.uvs[v * 2 + 1]]);
    }
    for (let t = tFrom; t < tTo; t += 3) tri(part, part.indices[t] + offset, part.indices[t + 2] + offset, part.indices[t + 1] + offset);
}

/**
 * One leaf lying flat: it grows along +Z from the origin (after its petiole), is `width` across X,
 * its upper face looks up +Y, and `curl` bends it down toward the tip. Double-sided.
 */
export function leaf(o: LeafOptions = {}): Mesh {
    const shape = o.shape ?? "ovate", L = Math.max(1e-4, o.length ?? 0.1), W = Math.max(1e-5, o.width ?? L * 0.5);
    const lobes = Math.max(1, Math.round(o.lobes ?? 3));
    const fold = clamp(o.fold ?? 0, 0, 80) * DEG, curl = (o.curl ?? 0) * DEG, pet = Math.max(0, o.petiole ?? 0);
    const tipTint = clamp(o.tipTint ?? 0, 0, 1);
    let rows = Math.max(2, Math.round(o.segments ?? 5));
    if (shape === "lobed") rows = Math.max(rows, lobes * 2);
    if (shape === "spray") rows = Math.max(rows, lobes * 2 + 1);
    const part = newPart(o.region ?? "default");
    const mid = bentMidline(L, rows, t => curl * t ** 1.3, pet);
    const rowIds: number[][] = [];
    for (let r = 0; r <= rows; r++) {
        const t = r / rows;
        const w = leafWidth(shape, t, lobes) * W / 2;
        const v = foliageV(0, tipTint * t * t);
        if (w < W * 1e-3) { const id = vertex(part, mid.p[r], mid.up[r], [t, v]); rowIds.push([id, id, id]); continue; }
        const lift = Math.tan(fold) * w;
        // Heart leaves: the two lobes reach back past the stalk.
        const back = shape === "heart" ? -0.22 * L * (1 - t) ** 2 : 0;
        const ids = [-1, 0, 1].map(u => {
            const pos = add3(add3(mid.p[r], [u * w, 0, 0]), add3(scale3(mid.up[r], Math.abs(u) * lift), scale3(mid.tan[r], Math.abs(u) * back)));
            return vertex(part, pos, mid.up[r], [t, v]);
        });
        rowIds.push(ids);
    }
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < 2; c++) {
            const a = rowIds[r][c], b = rowIds[r + 1][c], cc = rowIds[r + 1][c + 1], d = rowIds[r][c + 1];
            if (a !== b && b !== cc && a !== cc) tri(part, a, b, cc);
            if (a !== cc && cc !== d && a !== d) tri(part, a, cc, d);
        }
    }
    faceNormals(part, 0);
    addBackFace(part, 0, 0);
    if (pet > 1e-5) {
        // The stalk: a thin three-sided tube from the origin to the blade.
        const r = Math.max(W * 0.035, L * 0.012);
        const base = part.positions.length / 3;
        for (const z of [0, pet]) for (let k = 0; k <= 3; k++) {
            const a = (k / 3) * TAU;
            vertex(part, [Math.cos(a) * r, Math.sin(a) * r, z], [Math.cos(a), Math.sin(a), 0], [0, foliageV(0, 0)]);
        }
        for (let k = 0; k < 3; k++) {
            const a = base + k, b = base + k + 1, c = base + 4 + k + 1, d = base + 4 + k;
            // Outward: around +Z counter-clockwise, rising along +Z.
            tri(part, a, b, c); tri(part, a, c, d);
        }
    }
    return { parts: [part] };
}

// --- Placing copies in a frame -------------------------------------------------------------------

/**
 * Appends `src` into `into` (one part per region), mapped so the source's +Z points along `dir`,
 * its +Y as close to `up` as possible, scaled by `s`, at `at`. Returns the first new vertex per part.
 */
function placeInto(into: Map<string, Part>, src: Mesh, at: Vec3, dir: Vec3, up: Vec3, s: number, regionOverride = ""): { part: Part; from: number }[] {
    const Z = normalize3(dir, [0, 0, 1]);
    let Y = sub3(up, scale3(Z, dot3(up, Z)));
    if (length3(Y) < 1e-6) Y = Math.abs(Z[1]) < 0.9 ? sub3([0, 1, 0], scale3(Z, Z[1])) : sub3([1, 0, 0], scale3(Z, Z[0]));
    Y = normalize3(Y);
    const X = cross3(Y, Z);
    const out: { part: Part; from: number }[] = [];
    for (const p of src.parts) {
        const region = regionOverride || p.region;
        let dst = into.get(region);
        if (!dst) { dst = newPart(region); into.set(region, dst); }
        const from = dst.positions.length / 3;
        for (let v = 0; v < p.positions.length; v += 3) {
            const x = p.positions[v] * s, y = p.positions[v + 1] * s, z = p.positions[v + 2] * s;
            dst.positions.push(at[0] + X[0] * x + Y[0] * y + Z[0] * z, at[1] + X[1] * x + Y[1] * y + Z[1] * z, at[2] + X[2] * x + Y[2] * y + Z[2] * z);
            const nx = p.normals[v], ny = p.normals[v + 1], nz = p.normals[v + 2];
            dst.normals.push(X[0] * nx + Y[0] * ny + Z[0] * nz, X[1] * nx + Y[1] * ny + Z[1] * nz, X[2] * nx + Y[2] * ny + Z[2] * nz);
        }
        for (let v = 0; v < p.uvs.length; v++) dst.uvs.push(p.uvs[v]);
        for (let i = 0; i < p.indices.length; i++) dst.indices.push(p.indices[i] + from);
        out.push({ part: dst, from });
    }
    return out;
}

/** Rotates `v` about unit `axis` by `angle` radians (Rodrigues). */
function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
    const c = Math.cos(angle), s = Math.sin(angle);
    const k = axis, d = dot3(k, v), x = cross3(k, v);
    return [v[0] * c + x[0] * s + k[0] * d * (1 - c), v[1] * c + x[1] * s + k[1] * d * (1 - c), v[2] * c + x[2] * s + k[2] * d * (1 - c)];
}

function perpendicular(v: Vec3): Vec3 {
    return normalize3(Math.abs(v[1]) < 0.9 ? cross3(v, [0, 1, 0]) : cross3(v, [1, 0, 0]));
}

function randomUnit(r: () => number): Vec3 {
    const z = r() * 2 - 1, a = r() * TAU, s = Math.sqrt(1 - z * z);
    return [Math.cos(a) * s, z, Math.sin(a) * s];
}

// --- Tubes ---------------------------------------------------------------------------------------

/**
 * A tube through `pts` with a radius per point, parallel-transported frames, uv.x around in meters,
 * uv.y along in meters. `flare` swells the base into root buttresses; `rings` adds bands (palms).
 */
function tube(part: Part, pts: Vec3[], radii: number[], sides: number, o: { capStart?: boolean; capEnd?: boolean; flare?: number; flareSeed?: number; rings?: number; ringDepth?: number; vOffset?: number; bump?: number; bumpSeed?: number } = {}): void {
    const n = pts.length;
    if (n < 2) return;
    const T: Vec3[] = pts.map((_, i) => normalize3(sub3(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)])));
    let N = perpendicular(T[0]);
    const frames: { N: Vec3; B: Vec3 }[] = [];
    for (let i = 0; i < n; i++) {
        if (i > 0) N = normalize3(sub3(N, scale3(T[i], dot3(N, T[i]))), perpendicular(T[i]));
        frames.push({ N, B: cross3(T[i], N) });
    }
    const along: number[] = [o.vOffset ?? 0];
    for (let i = 1; i < n; i++) along.push(along[i - 1] + length3(sub3(pts[i], pts[i - 1])));
    const r0 = radii[0], circ = Math.max(0.02, TAU * r0);
    const base = part.positions.length / 3;
    const flare = o.flare ?? 0, lobePhase = (o.flareSeed ?? 0) * 1.7;
    const rings = o.rings ?? 0, ringDepth = o.ringDepth ?? 0, bump = o.bump ?? 0;
    for (let i = 0; i < n; i++) {
        const s = along[i] - (o.vOffset ?? 0);
        const band = rings > 0 ? 1 - ringDepth * (0.5 + 0.5 * Math.cos(TAU * rings * s / Math.max(1e-6, along[n - 1] - (o.vOffset ?? 0)))) : 1;
        for (let k = 0; k <= sides; k++) {
            const a = (k / sides) * TAU;
            const dirv = add3(scale3(frames[i].N, Math.cos(a)), scale3(frames[i].B, Math.sin(a)));
            let r = radii[i] * band;
            if (flare > 0) {
                const near = Math.exp(-s / (r0 * 2.2));
                r *= 1 + flare * near * (0.55 + 0.45 * Math.max(0, Math.cos(5 * a + lobePhase)) ** 2);
            }
            if (bump > 0) r *= 1 + bump * noise3(Math.cos(a) * 2.2, Math.sin(a) * 2.2, s * 3 / Math.max(0.05, r0 * 8), o.bumpSeed ?? 0);
            vertex(part, add3(pts[i], scale3(dirv, r)), dirv, [(k / sides) * circ, along[i]]);
        }
    }
    const ring = (i: number, k: number) => base + i * (sides + 1) + k;
    for (let i = 0; i < n - 1; i++) {
        for (let k = 0; k < sides; k++) {
            tri(part, ring(i, k), ring(i, k + 1), ring(i + 1, k + 1));
            tri(part, ring(i, k), ring(i + 1, k + 1), ring(i + 1, k));
        }
    }
    if (o.capEnd) {
        // A short rounded point closes the tip.
        const tipR = radii[n - 1];
        const tip = vertex(part, add3(pts[n - 1], scale3(T[n - 1], tipR * 1.2)), T[n - 1], [0, along[n - 1] + tipR]);
        for (let k = 0; k < sides; k++) tri(part, ring(n - 1, k), ring(n - 1, k + 1), tip);
    }
    if (o.capStart) {
        const c = vertex(part, pts[0], scale3(T[0], -1), [0, along[0]]);
        const first = part.positions.length / 3;
        // Separate rim vertices with the cap's own normal, so the side stays smooth.
        for (let k = 0; k <= sides; k++) vertex(part, [part.positions[ring(0, k) * 3], part.positions[ring(0, k) * 3 + 1], part.positions[ring(0, k) * 3 + 2]], scale3(T[0], -1), [0, along[0]]);
        for (let k = 0; k < sides; k++) tri(part, first + k + 1, first + k, c);
    }
}

// --- Trees ---------------------------------------------------------------------------------------

export type CrownShape = "round" | "oval" | "conical" | "spreading" | "columnar";

export interface TreeOptions {
    height: number;
    trunkRadius: number;
    /** Branching depth below the trunk (0 is a bare pole). */
    levels: number;
    /** Main limbs on the trunk. */
    branches: number;
    /** Branches on every limb, and on theirs. */
    twigs: number;
    /** Share of the height that is bare trunk. */
    crownBase: number;
    /** 0: the trunk forks into limbs at the crown base (oak). 1: one leader to the top (spruce). */
    leader: number;
    /** Degrees limbs leave their parent at. */
    angle: number;
    /** Limb length relative to the crown's height. */
    reach: number;
    /** Each branch's length relative to its parent. */
    subReach: number;
    crownShape: CrownShape;
    /** Child radius relative to its parent where it leaves. */
    radiusRatio: number;
    /** Random bending. */
    gnarl: number;
    /** Positive: branches arch down (weeping). Negative: they sweep up. */
    droop: number;
    /** Degrees the trunk leans. */
    lean: number;
    flare: number;
    sides: number;
    segments: number;
    seed: number;
    leaf?: Mesh | null;
    /** Per terminal branch. */
    leaves: number;
    /** Where leaves start along a twig (0..1). */
    leafStart: number;
    /** Degrees between a leaf and its twig. */
    leafAngle: number;
    /** 0 leaves face the sky; 1 they hang. */
    leafDroop: number;
    /** "twig": along the twig, facing up. "random": any orientation (puffs, clusters). */
    leafAlign: "twig" | "flat" | "random";
    leafScaleVariation: number;
    tintVariation: number;
    /** Flowers or fruit at the twig tips (their +Y faces out). */
    bloom?: Mesh | null;
    /** Per twig tip. */
    blooms: number;
    /** Triangles all the leaves together may use; the count per twig drops to fit. */
    leafBudget: number;
    bark: number;
    barkRegion: string;
    leafRegion: string;
}

interface Branch { pts: Vec3[]; radii: number[]; level: number; length: number; children: number }

const shapeFactor = (shape: CrownShape, t: number): number => {
    switch (shape) {
        case "conical": return 0.12 + 0.88 * (1 - t);
        case "oval": return 0.25 + 0.75 * Math.sin(Math.PI * clamp(0.12 + 0.8 * t, 0, 1)) ** 0.8;
        case "spreading": return 0.55 + 0.45 * Math.sin(Math.PI * clamp(0.35 + 0.6 * t, 0, 1));
        case "columnar": return 0.45 + 0.25 * (1 - t);
        default: return 0.3 + 0.7 * Math.sin(Math.PI * clamp(0.18 + 0.72 * t, 0, 1)) ** 0.6;
    }
};

/** A branching tree: tapering bark tubes and, optionally, `leaf` copies on every terminal branch. */
export function tree(o: TreeOptions): Mesh {
    const r = rng(o.seed * 7 + 3);
    const H = Math.max(0.05, o.height), R0 = Math.max(0.002, o.trunkRadius);
    const levels = clamp(Math.round(o.levels), 0, 4);
    const branchesN = clamp(Math.round(o.branches), 1, 64), twigsN0 = clamp(Math.round(o.twigs), 0, 24);
    // Keep the branch count sane whatever the controls say: thin the deepest level first.
    let twigsN = twigsN0;
    const estimate = (tw: number) => { let total = 1, layer = branchesN; for (let l = 1; l <= levels; l++) { total += layer; layer *= tw; } return total; };
    while (twigsN > 1 && estimate(twigsN) > 2400) twigsN--;
    const cb = clamp(o.crownBase, 0, 0.95), leader = clamp(o.leader, 0, 1);
    const segs = clamp(Math.round(o.segments), 2, 24);
    const minY = H * 0.015;
    const branches: Branch[] = [];

    const grow = (start: Vec3, dir: Vec3, length: number, radius: number, tipRadius: number, level: number, bend: Vec3 | null): Branch => {
        const n = level === 0 ? Math.max(3, Math.round(segs * 1.5)) : Math.max(2, Math.round(segs * (1 - 0.18 * level)));
        const step = length / n;
        const pts: Vec3[] = [start];
        const radii: number[] = [radius];
        let d = normalize3(dir);
        // Twigs hang far more than limbs: a willow's limbs rise, its twigs fall in curtains.
        const depth = levels ? level / levels : 0;
        // Branches also reach for the light a little, which fills the top of the crown.
        const g = (o.droop >= 0 ? o.droop * (0.08 + 0.92 * depth * depth) : o.droop * (0.4 + 0.6 * depth)) * (level === 0 ? 0 : 1) - (level === 0 || leader >= 0.5 ? 0 : 0.3 * depth);
        for (let i = 1; i <= n; i++) {
            const wobble = randomUnit(r);
            d = normalize3(add3(d, add3(scale3(wobble, o.gnarl * 0.3), [0, -g * 2.4 / n, 0])));
            if (bend && i < n * 0.5) d = normalize3(add3(d, scale3(bend, 0.18 / n)));
            let p = add3(pts[i - 1], scale3(d, step));
            if (p[1] < minY) { p = [p[0], minY + (minY - p[1]) * 0.1, p[2]]; d = normalize3([d[0], Math.max(d[1], 0.05), d[2]]); }
            pts.push(p);
            radii.push(radius + (tipRadius - radius) * (i / n) ** 0.9);
        }
        const b: Branch = { pts, radii, level, length, children: 0 };
        branches.push(b);
        return b;
    };

    const sample = (b: Branch, t: number): { p: Vec3; tan: Vec3; radius: number } => {
        const f = clamp(t, 0, 1) * (b.pts.length - 1);
        const i = Math.min(b.pts.length - 2, Math.floor(f)), u = f - i;
        const p = add3(scale3(b.pts[i], 1 - u), scale3(b.pts[i + 1], u));
        return { p, tan: normalize3(sub3(b.pts[i + 1], b.pts[i])), radius: b.radii[i] * (1 - u) + b.radii[i + 1] * u };
    };

    // Trunk: leaning, as tall as the leader reaches (a forking tree stops at its crown base).
    const leanDir = rotateAbout([0, 1, 0], normalize3([Math.cos(r() * TAU), 0, Math.sin(r() * TAU)]), o.lean * DEG);
    const trunkLen = H * (levels ? cb + (1 - cb) * (0.14 + 0.86 * leader) : 1);
    const trunkTip = R0 * (levels ? 0.55 - 0.47 * leader : 0.25);
    const trunk = grow([0, 0, 0], leanDir, trunkLen, R0, trunkTip, 0, null);

    const spawn = (parent: Branch, level: number) => {
        if (level > levels) return;
        const count = level === 1 ? branchesN : twigsN;
        if (!count) return;
        let t0: number, t1: number;
        if (level === 1) {
            // Along the crown part of the trunk; a forking trunk puts its limbs near the top.
            t0 = clamp((H * cb) / trunkLen, 0, 0.98);
            t1 = leader >= 0.5 ? 0.96 : 1;
        } else { t0 = level === 2 ? 0.12 : 0.22; t1 = 0.98; }
        const phase = r() * TAU;
        for (let k = 0; k < count; k++) {
            const tr = count === 1 ? 0.5 : (k + 0.5 + (r() - 0.5) * 0.5) / count;
            const t = clamp(t0 + (t1 - t0) * tr, 0, 1);
            const at = sample(parent, t);
            const az = phase + k * GOLDEN * (level === 1 && leader >= 0.5 ? 1 : 1.15) + (r() - 0.5) * 0.5;
            const side = rotateAbout(perpendicular(at.tan), at.tan, az);
            // Lower limbs spread wider than the ones near the top.
            // A forking crown mixes steep limbs that fill its middle with wide ones that shape its edge.
            const spread = level === 1 && leader < 0.5 ? 0.35 + 0.95 * ((k * 0.618034 + 0.3) % 1) : 1;
            const ang = (o.angle * (level === 1 ? (1 + 0.35 * (1 - tr)) * spread : 0.85) + (r() - 0.5) * 18) * DEG;
            let dir = normalize3(add3(scale3(at.tan, Math.cos(ang)), scale3(side, Math.sin(ang))));
            const shape = level === 1 ? shapeFactor(o.crownShape, tr) : 1 - 0.45 * tr;
            const crownH = Math.max(H * 0.05, H - at.p[1]);
            let len = level === 1 ? Math.max(H * 0.04, (H * (1 - cb)) * o.reach * shape) : parent.length * o.subReach * shape;
            // Limbs of a forking crown climb at an angle to fill it, but can't all reach past the top of the tree.
            if (level === 1 && leader < 0.5) len = Math.min(len / (0.6 + 0.4 * Math.cos(ang)), crownH * 1.3 + H * 0.1);
            len *= 0.85 + r() * 0.3;
            const rad = Math.min(at.radius * 0.85, Math.max(R0 * 0.012, at.radius * o.radiusRatio * (level === 1 && leader < 0.5 ? 1.25 : 1)));
            const tip = Math.max(R0 * 0.006, rad * (level < levels ? 0.35 : 0.12));
            // Upswept limbs of a round crown curve toward the sky before spreading.
            const bend: Vec3 | null = level === 1 && leader < 0.5 ? [0, 1, 0] : null;
            if (level === 1 && leader >= 0.5) dir = normalize3(add3(dir, [0, -0.15 * o.droop, 0]));
            const child = grow(add3(at.p, scale3(at.tan, -at.radius * 0.2)), dir, len, rad, tip, level, bend);
            parent.children++;
            spawn(child, level + 1);
        }
    };
    spawn(trunk, 1);

    const bark = newPart(o.barkRegion || "default");
    const maxSides = clamp(Math.round(o.sides), 3, 32);
    branches.forEach((b, i) => {
        const sides = clamp(Math.round(maxSides * Math.sqrt(b.radii[0] / R0)), 3, maxSides);
        tube(bark, b.pts, b.radii, sides, {
            capStart: b.level === 0, capEnd: true,
            flare: b.level === 0 ? o.flare : 0, flareSeed: o.seed,
            vOffset: i * 3.1, bump: b.level === 0 ? o.bark * 0.08 : 0, bumpSeed: o.seed,
        });
    });

    const parts: Part[] = [bark];
    if (o.leaf && o.leaf.parts.length && o.leaves > 0) {
        // Every twig carries leaves; the branches that hold twigs carry some along their outer half.
        const terminals = branches.filter(b => b.level === levels || (b.children === 0 && b.level > 0) || levels === 0);
        const inner = levels >= 2 && o.leafAlign !== "random" ? branches.filter(b => b.level === levels - 1 && b.children > 0) : [];
        // A single leader carries foliage up its spire, where its limbs are too short to.
        if (leader >= 0.5 && levels >= 1 && o.leafAlign !== "random") inner.push(trunk);
        const slots = terminals.length + inner.length * 0.5;
        const leafTris = Math.max(1, o.leaf.parts.reduce((t, p) => t + p.indices.length / 3, 0));
        const per = Math.max(1, Math.min(Math.round(o.leaves), Math.floor(o.leafBudget / (leafTris * Math.max(1, slots)))));
        const leafParts = new Map<string, Part>();
        const placed: { at: Vec3; spans: { part: Part; from: number; to: number }[]; tint: number }[] = [];
        let li = 0;
        const hosts = [
            ...terminals.map(b => ({ b, n: per, start: o.leafStart })),
            ...inner.map(b => (b === trunk ? { b, n: per * 2, start: 0.8 } : { b, n: Math.max(1, Math.round(per / 2)), start: 0.55 })),
        ];
        for (const { b, n: count, start } of hosts) {
            for (let k = 0; k < count; k++) {
                const t = count === 1 ? 1 : start + (1 - start) * (k / (count - 1));
                const at = sample(b, t);
                let dir: Vec3, up: Vec3;
                if (o.leafAlign === "random") {
                    dir = randomUnit(r); up = randomUnit(r);
                } else if (o.leafAlign === "flat") {
                    // Two ranks in the branch's own horizontal plane: a fir's flat sprays, a beech's leaf rows.
                    let side = cross3(at.tan, [0, 1, 0]);
                    side = length3(side) < 1e-4 ? perpendicular(at.tan) : normalize3(side);
                    if (k % 2) side = scale3(side, -1);
                    const a = (k === count - 1 && count > 1 ? 0 : o.leafAngle) * DEG;
                    dir = normalize3(add3(scale3(at.tan, Math.cos(a)), scale3(side, Math.sin(a))));
                    dir = normalize3(add3(dir, [0, -o.leafDroop * 0.8 + (r() - 0.5) * 0.25, 0]));
                    up = [0, 1, 0];
                } else {
                    const side = rotateAbout(perpendicular(at.tan), at.tan, li * GOLDEN * 1.3 + r() * 0.8);
                    const a = (k === count - 1 && count > 1 ? o.leafAngle * 0.35 : o.leafAngle) * DEG;
                    dir = normalize3(add3(scale3(at.tan, Math.cos(a)), scale3(side, Math.sin(a))));
                    dir = normalize3(add3(dir, [0, -o.leafDroop * 1.4, 0]));
                    up = normalize3(add3([0, 1, 0], scale3(side, 0.35 + 0.5 * (r() - 0.5))));
                }
                const pos: Vec3 = add3(at.p, scale3(dir, at.radius));
                if (pos[1] < minY * 2) pos[1] = minY * 2;
                const s = 1 + (r() * 2 - 1) * o.leafScaleVariation;
                const spans = placeInto(leafParts, o.leaf, pos, dir, up, s, o.leafRegion).map(x => ({ ...x, to: x.part.positions.length / 3 }));
                placed.push({ at: pos, spans, tint: r() * o.tintVariation });
                li++;
            }
        }
        // Crown shading: leaves deep inside and low in the crown sit in its shadow.
        const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
        for (const p of placed) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p.at[a]); hi[a] = Math.max(hi[a], p.at[a]); }
        const c = scale3(add3(lo, hi), 0.5), half = scale3(sub3(hi, lo), 0.5).map(x => Math.max(x, 1e-3)) as Vec3;
        for (const p of placed) {
            const e = Math.hypot((p.at[0] - c[0]) / half[0], (p.at[1] - c[1]) / half[1], (p.at[2] - c[2]) / half[2]);
            const low = 1 - (p.at[1] - lo[1]) / (half[1] * 2);
            const occ = clamp(0.85 * (1 - e) + 0.3 * low * low, 0, 1);
            for (const sp of p.spans) stamp(sp.part, sp.from, sp.to, occ, p.tint);
        }
        parts.push(...leafParts.values());
    }
    if (o.bloom && o.bloom.parts.length && o.blooms > 0) {
        // Flowers (or fruit) at the ends of the twigs, facing out and up.
        const tips = branches.filter(b => b.level === levels && b.level > 0);
        const bloomTris = Math.max(1, o.bloom.parts.reduce((t, p) => t + p.indices.length / 3, 0));
        const each = Math.max(0, Math.round(o.blooms));
        // Over budget, a random share of the tips flower.
        const keep = Math.min(1, 60000 / (bloomTris * Math.max(1, tips.length * each)));
        const bloomParts = new Map<string, Part>();
        for (const b of tips) {
            for (let j = 0; j < each; j++) {
                if ((j > 0 && r() > 0.8) || r() > keep) continue;
                const at = sample(b, 1 - j * 0.22);
                const face = normalize3(add3(at.tan, [0, 0.8, 0]));
                const spans = placeInto(bloomParts, o.bloom, add3(at.p, scale3(at.tan, at.radius)), rotateAbout(perpendicular(face), face, r() * TAU), face, 0.85 + r() * 0.3, "");
                const tint = r() * o.tintVariation;
                for (const sp of spans) addTint(sp.part, sp.from, sp.part.positions.length / 3, tint);
            }
        }
        parts.push(...bloomParts.values());
    }
    return settleOnGround({ parts: parts.filter(p => p.indices.length) });
}

/**
 * Whatever reaches below the floor (the leaning trunk's base ring, a sweeping limb's lowest sprays)
 * is squashed to a sliver just under it, keeping its shading, rather than poking through.
 */
export function settleOnGround(mesh: Mesh): Mesh {
    for (const p of mesh.parts) for (let v = 1; v < p.positions.length; v += 3) if (p.positions[v] < 0) p.positions[v] *= 0.0005;
    return mesh;
}

// --- Fronds --------------------------------------------------------------------------------------

export interface FrondOptions {
    length: number;
    /** Degrees the frond arches down over its length. */
    arch: number;
    /** 1 fully open; lower coils the tip into a fiddlehead. */
    unfurl: number;
    /** Leaflets on each side. */
    leaflets: number;
    /** Longest leaflet relative to the frond. */
    leafletLength: number;
    /** Leaflet width relative to its length. */
    leafletWidth: number;
    /** Degrees between leaflets and the stem, toward the tip. */
    leafletAngle: number;
    /** Degrees the leaflets hang below the frond's plane. */
    leafletDroop: number;
    shape: LeafShape;
    /** Bare stalk share at the base. */
    stalk: number;
    stemRadius: number;
    tintVariation: number;
    seed: number;
    stemRegion: string;
    leafRegion: string;
}

/** A pinnate frond (fern, palm): an arching stem growing along +Z with leaflets on both sides. */
export function frond(o: FrondOptions): Mesh {
    const r = rng(o.seed * 11 + 5);
    const L = Math.max(1e-3, o.length), rows = 24;
    const coil = (1 - clamp(o.unfurl, 0, 1)) * 3.2 * Math.PI;
    const theta = (t: number) => o.arch * DEG * t + coil * t ** 2.2;
    const mid = bentMidline(L, rows, theta);
    const stem = newPart(o.stemRegion || "default");
    const radii = mid.p.map((_, i) => Math.max(o.stemRadius * 0.15, o.stemRadius * (1 - 0.85 * (i / rows))));
    tube(stem, mid.p, radii, 5, { capStart: true, capEnd: true });
    const leafParts = new Map<string, Part>();
    const n = clamp(Math.round(o.leaflets), 0, 80);
    const openness = clamp(o.unfurl, 0, 1) ** 0.7;
    const stalk = clamp(o.stalk, 0, 0.9);
    const leafMesh = leaf({ shape: o.shape, length: 1, width: clamp(o.leafletWidth, 0.02, 2), fold: 18, curl: 12, segments: o.shape === "blade" ? 3 : 4, lobes: 3 });
    for (let k = 0; k < n; k++) {
        const t = stalk + (1 - stalk) * ((k + 0.5) / n) * 0.97;
        const f = t * rows, i = Math.min(rows - 1, Math.floor(f)), u = f - i;
        const at = add3(scale3(mid.p[i], 1 - u), scale3(mid.p[i + 1], u));
        const tan = normalize3(add3(scale3(mid.tan[i], 1 - u), scale3(mid.tan[i + 1], u)));
        const up = normalize3(add3(scale3(mid.up[i], 1 - u), scale3(mid.up[i + 1], u)));
        const lt = (t - stalk) / Math.max(1e-6, 1 - stalk);
        const size = L * o.leafletLength * (0.35 + 0.65 * Math.sin(Math.PI * clamp(0.12 + 0.85 * lt, 0, 1)) ** 0.7) * (1 - 0.35 * lt) * (0.4 + 0.6 * openness);
        for (const side of [-1, 1]) {
            const sideV: Vec3 = [side, 0, 0];
            const a = o.leafletAngle * DEG;
            let dir = normalize3(add3(scale3(tan, Math.cos(a)), scale3(sideV, Math.sin(a))));
            dir = normalize3(add3(dir, scale3(up, -Math.tan(clamp(o.leafletDroop, -60, 80) * DEG))));
            const spans = placeInto(leafParts, leafMesh, at, dir, up, size * (0.92 + r() * 0.16), o.leafRegion || "default");
            const tint = r() * o.tintVariation;
            for (const sp of spans) stamp(sp.part, sp.from, sp.part.positions.length / 3, 0.1 + 0.25 * (1 - lt), tint);
        }
    }
    return { parts: [stem, ...leafParts.values()].filter(p => p.indices.length) };
}

// --- Grass ---------------------------------------------------------------------------------------

export interface BladesOptions {
    count: number;
    height: number;
    heightVariation: number;
    width: number;
    /** Radius of the clump's base. */
    radius: number;
    /** Degrees the blades lean out. */
    lean: number;
    /** Degrees each blade bends over its length. */
    curl: number;
    /** Gradient toward the tint color at the tips (0..1). */
    tipTint: number;
    tintVariation: number;
    segments: number;
    seed: number;
    shape: LeafShape;
}

/** A clump of grass blades rising from a small disc, leaning out and curling over. */
export function blades(o: BladesOptions): Mesh {
    const r = rng(o.seed * 13 + 1);
    const n = clamp(Math.round(o.count), 1, 600);
    const into = new Map<string, Part>();
    for (let k = 0; k < n; k++) {
        const rr = o.radius * Math.sqrt((k + 0.5) / n), az = k * GOLDEN + r() * 0.6;
        const out: Vec3 = [Math.cos(az), 0, Math.sin(az)];
        const at: Vec3 = [out[0] * rr, 0, out[2] * rr];
        const h = o.height * (1 - o.heightVariation * r()) * (1 - 0.25 * (rr / Math.max(1e-6, o.radius)));
        const tilt = (o.lean * (0.25 + 0.75 * (rr / Math.max(1e-6, o.radius)) ** 0.7) + (r() - 0.5) * 16) * DEG;
        // Tilt out from vertical, with a little random swing around the clump.
        const swing = rotateAbout(out, [0, 1, 0], (r() - 0.5) * 0.9);
        const dir = normalize3(add3(scale3([0, 1, 0], Math.cos(tilt)), scale3(swing, Math.sin(tilt))));
        const blade = leaf({ shape: o.shape, length: h, width: o.width * (0.75 + r() * 0.5), fold: 22, curl: o.curl * (0.6 + r() * 0.8), segments: o.segments, tipTint: o.tipTint, lobes: 3 });
        // The blade's face looks back toward the clump, so its curl carries the tip outward.
        const spans = placeInto(into, blade, at, dir, scale3(swing, -1), 1, "");
        const tint = r() * o.tintVariation;
        for (const sp of spans) stamp(sp.part, sp.from, sp.part.positions.length / 3, 0.35 * (1 - rr / Math.max(1e-6, o.radius)), tint);
    }
    return settleOnGround({ parts: [...into.values()] });
}

// --- Scattering ----------------------------------------------------------------------------------

export interface ScatterOptions {
    count: number;
    radius: number;
    seed: number;
    scaleMin: number;
    scaleMax: number;
    /** Degrees of random tilt from upright. */
    tilt: number;
    /** 0 even; 1 crowds the middle. */
    falloff: number;
    tintVariation: number;
}

/** Copies of `mesh` spread over a disc on the ground (a sunflower spiral, jittered), each turned, tilted and sized at random. */
export function scatter(mesh: Mesh, o: ScatterOptions): Mesh {
    const r = rng(o.seed * 17 + 9);
    const n = clamp(Math.round(o.count), 1, 2000);
    const into = new Map<string, Part>();
    for (let k = 0; k < n; k++) {
        const u = n === 1 ? 0 : Math.sqrt((k + 0.2 + r() * 0.6) / n) ** (1 + 1.5 * o.falloff);
        const az = k * GOLDEN + (r() - 0.5) * 0.7;
        const at: Vec3 = [Math.cos(az) * u * o.radius, 0, Math.sin(az) * u * o.radius];
        const yaw = r() * TAU;
        const tiltAxis = normalize3([Math.cos(r() * TAU), 0, Math.sin(r() * TAU)]);
        const tilt = o.tilt * DEG * (0.3 + 0.7 * r()) * (n === 1 ? 0.3 : 1);
        const up = rotateAbout([0, 1, 0], tiltAxis, tilt);
        // The source's +Z (its facing) turns about the new up.
        const facing = rotateAbout(rotateAbout([0, 0, 1], [0, 1, 0], yaw), tiltAxis, tilt);
        const s = o.scaleMin + (o.scaleMax - o.scaleMin) * r();
        const spans = placeInto(into, mesh, at, facing, up, s, "");
        const tint = r() * o.tintVariation;
        if (tint > 0) for (const sp of spans) addTint(sp.part, sp.from, sp.part.positions.length / 3, tint);
    }
    return settleOnGround({ parts: [...into.values()] });
}

/** Adds to the tint fraction of foliage vertices, keeping their occlusion. */
function addTint(part: Part, from: number, to: number, tint: number): void {
    for (let v = from; v < to; v++) {
        const f = splitFoliageV(part.uvs[v * 2 + 1]);
        part.uvs[v * 2 + 1] = foliageV(f.occlusion, f.tint + tint);
    }
}

export interface SurfaceOptions {
    count: number;
    seed: number;
    scaleMin: number;
    scaleMax: number;
    /** Degrees each copy's tip lifts off the surface. */
    tilt: number;
    tintVariation: number;
    /** Also output the surface itself, shaded as deep foliage (a clipped hedge's body). */
    keepSurface: boolean;
    /** Region for the surface when kept (empty keeps its own). */
    surfaceRegion: string;
    /** Only faces whose normal's y is at least this (-1 everywhere, 0 upward-facing only). */
    minNormalY?: number;
}

/** Copies of `mesh` over the faces of `surface` (area-weighted), their +Y along its normal: leaves on a clipped hedge. */
export function distributeOnSurface(surface: Mesh, mesh: Mesh, o: SurfaceOptions): Mesh {
    const r = rng(o.seed * 19 + 23);
    const tris: { a: Vec3; b: Vec3; c: Vec3; na: Vec3; nb: Vec3; nc: Vec3; area: number }[] = [];
    let total = 0;
    let lo = Infinity, hi = -Infinity;
    for (const p of surface.parts) {
        for (let v = 1; v < p.positions.length; v += 3) { lo = Math.min(lo, p.positions[v]); hi = Math.max(hi, p.positions[v]); }
        for (let t = 0; t < p.indices.length; t += 3) {
            const g = (i: number): Vec3 => [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]];
            const gn = (i: number): Vec3 => [p.normals[i * 3], p.normals[i * 3 + 1], p.normals[i * 3 + 2]];
            const [i0, i1, i2] = [p.indices[t], p.indices[t + 1], p.indices[t + 2]];
            const a = g(i0), b = g(i1), c = g(i2);
            const fn = cross3(sub3(b, a), sub3(c, a));
            const area = length3(fn) / 2;
            if (!(area > 0) || fn[1] / (area * 2) < (o.minNormalY ?? -1)) continue;
            total += area;
            tris.push({ a, b, c, na: gn(i0), nb: gn(i1), nc: gn(i2), area: total });
        }
    }
    const into = new Map<string, Part>();
    const n = clamp(Math.round(o.count), 0, 20000);
    if (tris.length) for (let k = 0; k < n; k++) {
        const pick = r() * total;
        let lo2 = 0, hi2 = tris.length - 1;
        while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (tris[m].area < pick) lo2 = m + 1; else hi2 = m; }
        const T = tris[lo2];
        let u = r(), v = r();
        if (u + v > 1) { u = 1 - u; v = 1 - v; }
        const w = 1 - u - v;
        const at = add3(add3(scale3(T.a, w), scale3(T.b, u)), scale3(T.c, v));
        const nrm = normalize3(add3(add3(scale3(T.na, w), scale3(T.nb, u)), scale3(T.nc, v)));
        const tangent = rotateAbout(perpendicular(nrm), nrm, r() * TAU);
        const lift = o.tilt * DEG * (0.4 + 0.6 * r());
        // The copy's +Z runs along the surface, tipped up by `tilt`; its +Y follows the normal.
        const dir = normalize3(add3(scale3(tangent, Math.cos(lift)), scale3(nrm, Math.sin(lift))));
        const s = o.scaleMin + (o.scaleMax - o.scaleMin) * r();
        const spans = placeInto(into, mesh, at, dir, nrm, s, "");
        const low = hi > lo ? 1 - (at[1] - lo) / (hi - lo) : 0;
        const tint = r() * o.tintVariation;
        for (const sp of spans) stamp(sp.part, sp.from, sp.part.positions.length / 3, 0.35 * low * low + 0.1 * Math.max(0, -nrm[1]), tint);
    }
    const out: Mesh = { parts: [...into.values()] };
    if (!o.keepSurface) return out;
    const body = surface.parts.map(p => ({ ...p, region: o.surfaceRegion || p.region, positions: p.positions.slice(), normals: p.normals.slice(), indices: p.indices.slice(), uvs: p.uvs.map((x, i) => (i % 2 ? foliageV(0.8, 0) : 0.5)) }));
    return join(out, { parts: body });
}

// --- Stalks --------------------------------------------------------------------------------------

export interface StalkOptions {
    radius: number;
    tipRadius: number;
    sides: number;
    /** Bands along the stalk (palm trunks, bamboo). */
    rings: number;
    ringDepth: number;
    flare: number;
    bark: number;
    seed: number;
}

/** A tapering round stalk along a path: palm and tree-fern trunks, flower stems, reeds. */
export function stalk(path: Vec3[], o: StalkOptions): Mesh {
    const part = newPart("default");
    const pts = path.filter((p, i) => i === 0 || length3(sub3(p, path[i - 1])) > 1e-7);
    if (pts.length < 2) return { parts: [] };
    const along: number[] = [0];
    for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + length3(sub3(pts[i], pts[i - 1])));
    const total = along[along.length - 1] || 1;
    const radii = along.map(s => o.radius + (o.tipRadius - o.radius) * (s / total));
    // Rings need enough stations along the path to show.
    let p2 = pts, r2 = radii;
    const want = Math.max(pts.length, Math.round(o.rings * 4));
    if (o.rings > 0 && want > pts.length) {
        p2 = []; r2 = [];
        for (let k = 0; k <= want; k++) {
            const s = (k / want) * total;
            let i = 0;
            while (i < along.length - 2 && along[i + 1] < s) i++;
            const u = clamp((s - along[i]) / Math.max(1e-9, along[i + 1] - along[i]), 0, 1);
            p2.push(add3(scale3(pts[i], 1 - u), scale3(pts[i + 1], u)));
            r2.push(radii[i] * (1 - u) + radii[i + 1] * u);
        }
    }
    tube(part, p2, r2, clamp(Math.round(o.sides), 3, 64), { capStart: true, capEnd: true, rings: o.rings, ringDepth: clamp(o.ringDepth, 0, 0.6), flare: o.flare, flareSeed: o.seed, bump: o.bark * 0.08, bumpSeed: o.seed });
    // A stalk rooted on the floor with a leaning first stretch tips its base ring: keep it on the floor.
    if (pts[0][1] >= 0) settleOnGround({ parts: [part] });
    return { parts: [part] };
}

/**
 * Foliage shading for geometry that isn't leaves (stylized puffs, tiers, a hedge's body): sets how
 * deep in the crown it reads (lower parts deeper by `gradient`) and a random tint per part.
 */
export function shadeFoliage(mesh: Mesh, o: { occlusion: number; gradient: number; tintVariation: number; seed: number }): Mesh {
    let lo = Infinity, hi = -Infinity;
    for (const p of mesh.parts) for (let v = 1; v < p.positions.length; v += 3) { lo = Math.min(lo, p.positions[v]); hi = Math.max(hi, p.positions[v]); }
    const r = rng(o.seed * 29 + 7);
    return {
        parts: mesh.parts.map(p => {
            const tint = r() * o.tintVariation;
            const uvs = p.uvs.slice();
            for (let v = 0; v < uvs.length / 2; v++) {
                const h = hi > lo ? (p.positions[v * 3 + 1] - lo) / (hi - lo) : 1;
                uvs[v * 2] = 1;
                uvs[v * 2 + 1] = foliageV(o.occlusion + o.gradient * (1 - h) ** 2, tint);
            }
            return { ...p, positions: p.positions.slice(), normals: p.normals.slice(), indices: p.indices.slice(), uvs };
        }),
    };
}
