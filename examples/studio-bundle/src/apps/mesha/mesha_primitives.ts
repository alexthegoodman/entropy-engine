// Mesha's geometry builders: the low-level shapes every catalog component is made of. Each builder
// returns a Mesh with outward-facing, counter-clockwise triangles and real normals (smooth across
// gentle curvature, split at hard corners), so rounded edges catch highlights the way a finished,
// manufactured object does.

import {
    type Mesh, type Part, type Vec2, type Vec3,
    newPart, partMesh, vertex, tri, quad, normalize3, cross3, sub3, add3, scale3, dot3, length3, join, transformMesh, compose4, mapPositions,
} from "./mesha_mesh";
import { ensureCCW, ensureCW, signedArea, dedupePoints } from "./mesha_curves";
import { fbm3 } from "./mesha_noise";

const TAU = Math.PI * 2;
const EPS = 1e-7;
const DEG = Math.PI / 180;

// --- Rounded box ---------------------------------------------------------------------------------

/** Sample positions across [-h, h] with `seg` extra rows inside each rounded band, spaced evenly by angle. */
function roundedAxis(h: number, r: number, seg: number, divisions = 1): number[] {
    const flat = h - r;
    const inner: number[] = [];
    // Evenly spaced rows across the flat middle, so a bend or taper has vertices to move.
    for (let k = 1; k < divisions; k++) inner.push(-flat + (2 * flat * k) / divisions);
    if (r <= 1e-6) return [-h, ...inner, h];
    const band: number[] = [];
    for (let k = 0; k <= seg; k++) band.push(flat + r * Math.tan((k / seg) * (Math.PI / 4)));
    const neg = band.slice().reverse().map(v => -v);
    return flat < 1e-6 ? [...neg, ...band.slice(1)] : [...neg, ...inner, ...band];
}

/**
 * A box of `size` centered on the origin whose edges and corners are rounded by `radius` (0 is a
 * sharp box, half the smallest side a pill/sphere). `segments` rows per rounded band.
 */
export function roundedBox(size: Vec3, radius = 0, segments = 4, region = "default", divisions: Vec3 = [1, 1, 1]): Mesh {
    const h: Vec3 = [Math.max(size[0], 1e-5) / 2, Math.max(size[1], 1e-5) / 2, Math.max(size[2], 1e-5) / 2];
    const r = Math.max(0, Math.min(radius, h[0], h[1], h[2]));
    const seg = Math.max(1, Math.round(segments));
    const inner: Vec3 = [h[0] - r, h[1] - r, h[2] - r];
    const part = newPart(region);
    const coords = h.map((v, k) => roundedAxis(v, r, seg, Math.max(1, Math.round(divisions[k]))));
    for (let a = 0; a < 3; a++) {
        for (const s of [1, -1]) {
            const u = s > 0 ? (a + 1) % 3 : (a + 2) % 3;
            const v = s > 0 ? (a + 2) % 3 : (a + 1) % 3;
            const cu = coords[u], cv = coords[v];
            const base = part.positions.length / 3;
            for (let j = 0; j < cv.length; j++) {
                for (let i = 0; i < cu.length; i++) {
                    const q: Vec3 = [0, 0, 0];
                    q[a] = s * h[a]; q[u] = cu[i]; q[v] = cv[j];
                    const c: Vec3 = [Math.max(-inner[0], Math.min(inner[0], q[0])), Math.max(-inner[1], Math.min(inner[1], q[1])), Math.max(-inner[2], Math.min(inner[2], q[2]))];
                    let n: Vec3, p: Vec3;
                    if (r > 1e-6) {
                        n = normalize3(sub3(q, c));
                        p = add3(c, scale3(n, r));
                    } else {
                        n = [0, 0, 0]; n[a] = s; p = q;
                    }
                    vertex(part, p, n, [q[u], q[v]]);
                }
            }
            const w = cu.length;
            for (let j = 0; j < cv.length - 1; j++) {
                for (let i = 0; i < w - 1; i++) {
                    const i0 = base + j * w + i;
                    quad(part, i0, i0 + 1, i0 + 1 + w, i0 + w);
                }
            }
        }
    }
    return partMesh(part);
}

// --- Lathe ---------------------------------------------------------------------------------------

interface Ring { d: number; y: number; n: Vec2; v: number }

/**
 * Rings along a 2D profile of (offset, y) points: one per point where the profile bends gently,
 * two (one per side) where it turns more than `smoothAngle`, so the builder splits normals there.
 * Returns, per segment, the ring it starts on and the ring it ends on.
 */
function profileRings(profile: Vec2[], smoothAngle: number, closed: boolean): { rings: Ring[]; segments: [number, number][] } {
    const n = profile.length;
    const segCount = closed ? n : n - 1;
    const segNormal: Vec2[] = [];
    const cum: number[] = [0];
    for (let s = 0; s < segCount; s++) {
        const a = profile[s], b = profile[(s + 1) % n];
        const dd = b[0] - a[0], dy = b[1] - a[1];
        const l = Math.hypot(dd, dy) || 1;
        segNormal.push([dy / l, -dd / l]);
        cum.push(cum[s] + l);
    }
    const total = cum[segCount] || 1;
    const rings: Ring[] = [];
    const inRing: number[] = new Array(n).fill(-1), outRing: number[] = new Array(n).fill(-1);
    const cosLimit = Math.cos(smoothAngle);
    for (let j = 0; j < n; j++) {
        const prev = closed ? (j - 1 + segCount) % segCount : j - 1;
        const next = closed ? j % segCount : j < segCount ? j : -1;
        const v = (j === 0 && closed ? 0 : cum[j]) / total;
        const [d, y] = profile[j];
        if (prev >= 0 && next >= 0) {
            const a = segNormal[prev], b = segNormal[next];
            if (a[0] * b[0] + a[1] * b[1] >= cosLimit) {
                const m = [a[0] + b[0], a[1] + b[1]], l = Math.hypot(m[0], m[1]) || 1;
                rings.push({ d, y, n: [m[0] / l, m[1] / l], v });
                inRing[j] = outRing[j] = rings.length - 1;
            } else {
                rings.push({ d, y, n: a, v }); inRing[j] = rings.length - 1;
                rings.push({ d, y, n: b, v }); outRing[j] = rings.length - 1;
            }
        } else if (next >= 0) {
            rings.push({ d, y, n: segNormal[next], v }); outRing[j] = rings.length - 1;
        } else {
            rings.push({ d, y, n: segNormal[prev], v }); inRing[j] = rings.length - 1;
        }
    }
    const segments: [number, number][] = [];
    for (let s = 0; s < segCount; s++) {
        const end = (s + 1) % n;
        let endRing = inRing[end];
        if (closed && end === 0) {
            // Closing segment: its end ring needs v = 1, so give it its own copy.
            const r = rings[inRing[0]];
            rings.push({ ...r, v: 1 });
            endRing = rings.length - 1;
        }
        segments.push([outRing[s], endRing]);
    }
    return { rings, segments };
}

export interface LatheOptions {
    segments?: number;
    /** Radians, default a full turn. */
    sweep?: number;
    /** Degrees between neighbouring profile segments below which normals are smoothed. Default 40. */
    smoothAngle?: number;
    /** The profile's last point joins its first (a torus). */
    closed?: boolean;
    region?: string;
}

/**
 * Spins a (radius, y) profile around +Y. Run the profile from bottom to top with the material on
 * the left of travel (outward normals); a profile that starts and ends on the axis (radius 0)
 * makes a closed solid - a bottle, a turned table leg, a knob.
 */
export function lathe(profile: Vec2[], options: LatheOptions = {}): Mesh {
    const segs = Math.max(3, Math.round(options.segments ?? 32));
    const sweep = options.sweep ?? TAU;
    const part = newPart(options.region ?? "default");
    if (profile.length < 2) return partMesh(part);
    const clean = dedupePoints(profile.map(([r, y]) => [Math.max(0, r), y] as Vec2), !!options.closed);
    if (clean.length < 2) return partMesh(part);
    const { rings, segments } = profileRings(clean, (options.smoothAngle ?? 40) * DEG, !!options.closed);
    const ringBase: number[] = [];
    for (const ring of rings) {
        ringBase.push(part.positions.length / 3);
        for (let k = 0; k <= segs; k++) {
            const t = k / segs, a = t * sweep;
            const c = Math.cos(a), s = -Math.sin(a);
            vertex(part, [ring.d * c, ring.y, ring.d * s], normalize3([ring.n[0] * c, ring.n[1], ring.n[0] * s]), [t, ring.v]);
        }
    }
    for (const [ra, rb] of segments) {
        const A = rings[ra], B = rings[rb];
        const aAxis = A.d < EPS, bAxis = B.d < EPS;
        if (aAxis && bAxis) continue;
        for (let k = 0; k < segs; k++) {
            const a0 = ringBase[ra] + k, a1 = a0 + 1, b1 = ringBase[rb] + k + 1, b0 = ringBase[rb] + k;
            if (aAxis) tri(part, a0, b1, b0);
            else if (bAxis) tri(part, a0, a1, b1);
            else quad(part, a0, a1, b1, b0);
        }
    }
    return partMesh(part);
}

export function cylinder(radius: number, height: number, segments = 32, region = "default", bevel = 0, bevelSegments = 3): Mesh {
    return lathe(capsuleProfile(radius, radius, height, bevel, bevelSegments), { segments, region });
}

/** (radius, y) profile of a closed cylinder/frustum from y = 0 to `height` with rounded rims. */
export function capsuleProfile(bottomRadius: number, topRadius: number, height: number, bevel = 0, bevelSegments = 3): Vec2[] {
    const b = Math.max(0, Math.min(bevel, Math.min(bottomRadius, topRadius) * 0.999, height / 2 - 1e-5));
    if (b <= 1e-6) return [[0, 0], [bottomRadius, 0], [topRadius, height], [0, height]];
    const out: Vec2[] = [[0, 0]];
    const n = Math.max(1, Math.round(bevelSegments));
    for (let k = 0; k <= n; k++) { const a = -Math.PI / 2 + (k / n) * (Math.PI / 2); out.push([bottomRadius - b + Math.cos(a) * b, b + Math.sin(a) * b]); }
    for (let k = 0; k <= n; k++) { const a = (k / n) * (Math.PI / 2); out.push([topRadius - b + Math.cos(a) * b, height - b + Math.sin(a) * b]); }
    out.push([0, height]);
    return out;
}

export function sphere(radius: number, segments = 32, rings = 16, region = "default"): Mesh {
    const profile: Vec2[] = [];
    const n = Math.max(2, Math.round(rings));
    for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + (i / n) * Math.PI; profile.push([Math.cos(a) * radius, Math.sin(a) * radius]); }
    profile[0][0] = 0; profile[n][0] = 0;
    return lathe(profile, { segments, region, smoothAngle: 90 });
}

export function torus(major: number, minor: number, segments = 48, sides = 16, region = "default"): Mesh {
    // Counter-clockwise in (r, y) keeps the material on the left of travel.
    const profile: Vec2[] = Array.from({ length: Math.max(3, sides) }, (_, i) => {
        const a = -Math.PI / 2 + (i / sides) * TAU;
        return [major + Math.cos(a) * minor, Math.sin(a) * minor] as Vec2;
    });
    return lathe(profile, { segments, region, closed: true, smoothAngle: 90 });
}

/** An icosphere: evenly sized triangles everywhere, the right base for noise-displaced organic shapes. */
export function icosphere(radius: number, subdivisions = 3, region = "default"): Mesh {
    const t = (1 + Math.sqrt(5)) / 2;
    let verts: Vec3[] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(v => normalize3(v as Vec3));
    let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    for (let s = 0; s < Math.min(6, Math.max(0, Math.round(subdivisions))); s++) {
        const cache = new Map<string, number>();
        const mid = (a: number, b: number) => {
            const key = a < b ? `${a}_${b}` : `${b}_${a}`;
            let i = cache.get(key);
            if (i === undefined) { i = verts.length; verts.push(normalize3(scale3(add3(verts[a], verts[b]), 0.5))); cache.set(key, i); }
            return i;
        };
        const next: number[][] = [];
        for (const [a, b, c] of faces) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
        faces = next;
        verts = [...verts];
    }
    const part = newPart(region);
    for (const v of verts) vertex(part, scale3(v, radius), v, [0.5 + Math.atan2(v[2], v[0]) / TAU, 0.5 + Math.asin(v[1]) / Math.PI]);
    for (const [a, b, c] of faces) tri(part, a, b, c);
    return partMesh(part);
}

// --- Polygon triangulation (ear clipping with holes) ---------------------------------------------

function pointInTri(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
    const s = (p1: Vec2, p2: Vec2, p3: Vec2) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
    const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
    const neg = d1 < -1e-12 || d2 < -1e-12 || d3 < -1e-12, pos = d1 > 1e-12 || d2 > 1e-12 || d3 > 1e-12;
    return !(neg && pos);
}

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
    const o = (p: Vec2, q: Vec2, r: Vec2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
    return ((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) && ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12));
}

/**
 * Triangulates a simple CCW polygon with CW holes. Returns index triples into the concatenation of
 * `outer` and then every hole, in order - counter-clockwise in the polygon's plane.
 */
export function triangulate(outer: Vec2[], holes: Vec2[][] = []): number[] {
    const pts: Vec2[] = [...outer];
    let ring: number[] = outer.map((_, i) => i);
    const holeIdx = holes.map(h => { const start = pts.length; pts.push(...h); return h.map((_, i) => start + i); });
    // Bridge each hole into the ring, rightmost hole first, through a vertex that sees it.
    holeIdx.sort((a, b) => Math.max(...b.map(i => pts[i][0])) - Math.max(...a.map(i => pts[i][0])));
    for (const hole of holeIdx) {
        let m = 0;
        for (let i = 1; i < hole.length; i++) if (pts[hole[i]][0] > pts[hole[m]][0]) m = i;
        const M = pts[hole[m]];
        const allEdges = (): [Vec2, Vec2][] => {
            const e: [Vec2, Vec2][] = [];
            for (let i = 0; i < ring.length; i++) e.push([pts[ring[i]], pts[ring[(i + 1) % ring.length]]]);
            for (const h of holeIdx) for (let i = 0; i < h.length; i++) e.push([pts[h[i]], pts[h[(i + 1) % h.length]]]);
            return e;
        };
        const edges = allEdges();
        let best = -1, bestDist = Infinity;
        for (let i = 0; i < ring.length; i++) {
            const P = pts[ring[i]];
            const dist = (P[0] - M[0]) ** 2 + (P[1] - M[1]) ** 2;
            if (dist >= bestDist) continue;
            if (edges.some(([a, b]) => segmentsCross(M, P, a, b))) continue;
            best = i; bestDist = dist;
        }
        if (best < 0) best = 0;
        const rotated = [...hole.slice(m), ...hole.slice(0, m), hole[m]];
        ring = [...ring.slice(0, best + 1), ...rotated, ring[best], ...ring.slice(best + 1)];
    }
    return earClip(pts, ring);
}

/**
 * Ear clipping over a doubly linked ring: walks forward from the last ear instead of restarting,
 * and only reflex vertices can lie inside a candidate ear, so only those are tested.
 */
function earClip(pts: Vec2[], ring: number[]): number[] {
    const out: number[] = [];
    const n = ring.length;
    if (n < 3) return out;
    const prev = new Int32Array(n), next = new Int32Array(n);
    for (let i = 0; i < n; i++) { prev[i] = (i - 1 + n) % n; next[i] = (i + 1) % n; }
    const P = (i: number) => pts[ring[i]];
    const area = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const reflex = new Uint8Array(n);
    const updateReflex = (i: number) => { reflex[i] = area(P(prev[i]), P(i), P(next[i])) <= 1e-14 ? 1 : 0; };
    for (let i = 0; i < n; i++) updateReflex(i);
    const same = (a: Vec2, b: Vec2) => a[0] === b[0] && a[1] === b[1];
    const isEar = (i: number) => {
        if (reflex[i]) return false;
        const ia = prev[i], ic = next[i];
        const a = P(ia), b = P(i), c = P(ic);
        for (let j = next[ic]; j !== ia; j = next[j]) {
            if (!reflex[j]) continue;
            const p = P(j);
            if (same(p, a) || same(p, b) || same(p, c)) continue;
            if (pointInTri(p, a, b, c)) return false;
        }
        return true;
    };
    let remaining = n, i = 0, stall = 0;
    while (remaining > 3) {
        if (isEar(i)) {
            out.push(ring[prev[i]], ring[i], ring[next[i]]);
            const a = prev[i], c = next[i];
            next[a] = c; prev[c] = a;
            remaining--; stall = 0;
            updateReflex(a); updateReflex(c);
            i = c;
            continue;
        }
        i = next[i];
        if (++stall > remaining) {
            // No ear left (collinear runs or slight self-overlap): drop the flattest vertex and go on.
            let flat = i, flatA = Infinity, j = i;
            for (let k = 0; k < remaining; k++, j = next[j]) {
                const ar = Math.abs(area(P(prev[j]), P(j), P(next[j])));
                if (ar < flatA) { flatA = ar; flat = j; }
            }
            const a = prev[flat], c = next[flat];
            if (!reflex[flat] || flatA < 1e-14) { /* dropping a sliver loses nothing */ } else out.push(ring[a], ring[flat], ring[c]);
            next[a] = c; prev[c] = a; remaining--; stall = 0;
            updateReflex(a); updateReflex(c);
            i = c;
        }
    }
    const a = i, b = next[i], c = next[next[i]];
    if (area(P(a), P(b), P(c)) > 1e-14) out.push(ring[a], ring[b], ring[c]);
    return out;
}

// --- Extrude -------------------------------------------------------------------------------------

/** Outward normals of each edge of a loop in its own orientation (right of travel). */
function edgeNormals(loop: Vec2[]): Vec2[] {
    return loop.map((p, i) => {
        const q = loop[(i + 1) % loop.length];
        const ex = q[0] - p[0], ey = q[1] - p[1];
        const l = Math.hypot(ex, ey) || 1;
        return [ey / l, -ex / l] as Vec2;
    });
}

/** Each vertex offset by `d` along its miter, capped so sharp spikes don't shoot off. */
function offsetLoop(loop: Vec2[], d: number): Vec2[] {
    if (Math.abs(d) < 1e-9) return loop.map(p => [p[0], p[1]] as Vec2);
    const en = edgeNormals(loop);
    return loop.map((p, i) => {
        const a = en[(i - 1 + loop.length) % loop.length], b = en[i];
        const denom = 1 + a[0] * b[0] + a[1] * b[1];
        let mx = (a[0] + b[0]) / Math.max(denom, 0.25), my = (a[1] + b[1]) / Math.max(denom, 0.25);
        const ml = Math.hypot(mx, my);
        if (ml > 2) { mx *= 2 / ml; my *= 2 / ml; }
        return [p[0] + mx * d, p[1] + my * d] as Vec2;
    });
}

export interface ExtrudeOptions {
    /** Hole outlines (any orientation). */
    holes?: Vec2[][];
    /** Rounded edge size on both caps; 0 is a sharp-edged prism. */
    bevel?: number;
    bevelSegments?: number;
    /** Degrees: outline corners sharper than this get split normals. Default 35. */
    smoothAngle?: number;
    region?: string;
    /** Region for the two caps; defaults to `region`. */
    capRegion?: string;
    capTop?: boolean;
    capBottom?: boolean;
}

/**
 * Extrudes a 2D outline in the XZ plane (x, z) upward from y = 0 to `height`, with holes and an
 * optional rounded bevel along both rims. The workhorse for table tops, gears, panels, frames.
 */
export function extrude(outline: Vec2[], height: number, options: ExtrudeOptions = {}): Mesh {
    const region = options.region ?? "default";
    const sides = newPart(region);
    const caps = newPart(options.capRegion ?? region);
    outline = dedupePoints(outline, true);
    if (outline.length < 3 || Math.abs(signedArea(outline)) < 1e-10) return emptyOf(region);
    // (x, z) with +x right and +z toward the viewer is clockwise when seen from +Y, so outlines are
    // handled in (x, -z) space where counter-clockwise means "seen from above".
    const flip = (p: Vec2): Vec2 => [p[0], -p[1]];
    const outer = ensureCCW(outline.map(flip));
    const holes = (options.holes ?? []).map(h => dedupePoints(h, true)).filter(h => h.length >= 3 && Math.abs(signedArea(h)) > 1e-12).map(h => ensureCW(h.map(flip)));
    const h = Math.max(height, 1e-5);
    const b = Math.max(0, Math.min(options.bevel ?? 0, h / 2 - 1e-5));
    const bs = Math.max(1, Math.round(options.bevelSegments ?? 3));
    // Wall profile as (offset, y): negative offset is inward.
    const profile: Vec2[] = [];
    if (b > 1e-6) {
        for (let k = 0; k <= bs; k++) { const a = -Math.PI / 2 + (k / bs) * (Math.PI / 2); profile.push([-b + Math.cos(a) * b, b + Math.sin(a) * b]); }
        for (let k = 0; k <= bs; k++) { const a = (k / bs) * (Math.PI / 2); profile.push([-b + Math.cos(a) * b, h - b + Math.sin(a) * b]); }
    } else {
        profile.push([0, 0], [0, h]);
    }
    const { rings, segments } = profileRings(profile, 40 * DEG, false);
    const cosLimit = Math.cos((options.smoothAngle ?? 35) * DEG);
    for (const loop of [outer, ...holes]) {
        const en = edgeNormals(loop);
        // Per loop corner: one column (smooth) or two (split at a hard corner).
        const columns: { i: number; n: Vec2; u: number }[] = [];
        let perim = 0;
        const uAt: number[] = [0];
        for (let i = 0; i < loop.length; i++) { const q = loop[(i + 1) % loop.length], p = loop[i]; perim += Math.hypot(q[0] - p[0], q[1] - p[1]); uAt.push(perim); }
        const colStart: number[] = [], colEnd: number[] = [];
        for (let i = 0; i < loop.length; i++) {
            const a = en[(i - 1 + loop.length) % loop.length], c = en[i];
            if (a[0] * c[0] + a[1] * c[1] >= cosLimit) {
                const m = normalize2([a[0] + c[0], a[1] + c[1]]);
                columns.push({ i, n: m, u: uAt[i] });
                colStart[i] = colEnd[i] = columns.length - 1;
            } else {
                columns.push({ i, n: a, u: uAt[i] }); colEnd[i] = columns.length - 1;
                columns.push({ i, n: c, u: uAt[i] }); colStart[i] = columns.length - 1;
            }
        }
        const loopOffsets = rings.map(r => offsetLoop(loop, r.d));
        const colBase: number[] = [];
        for (let ci = 0; ci < columns.length; ci++) {
            colBase.push(sides.positions.length / 3);
            const col = columns[ci];
            for (let ri = 0; ri < rings.length; ri++) {
                const r = rings[ri];
                const p = loopOffsets[ri][col.i];
                const n: Vec3 = normalize3([col.n[0] * r.n[0], r.n[1], -col.n[1] * r.n[0]]);
                vertex(sides, [p[0], r.y, -p[1]], n, [col.u, r.y]);
            }
        }
        // The closing edge's end column needs its own u; duplicate the first start column.
        const lastEndCol = columns.length;
        {
            colBase.push(sides.positions.length / 3);
            const col = columns[colStart[0]];
            for (let ri = 0; ri < rings.length; ri++) {
                const r = rings[ri];
                const p = loopOffsets[ri][col.i];
                const endCol = columns[colEnd[0]];
                const n: Vec3 = normalize3([endCol.n[0] * r.n[0], r.n[1], -endCol.n[1] * r.n[0]]);
                vertex(sides, [p[0], r.y, -p[1]], n, [perim, r.y]);
            }
        }
        for (let i = 0; i < loop.length; i++) {
            const c0 = colStart[i];
            const c1 = i + 1 === loop.length ? lastEndCol : colEnd[i + 1];
            for (const [ra, rb] of segments) {
                const a0 = colBase[c0] + ra, a1 = colBase[c1] + ra, b1 = colBase[c1] + rb, b0 = colBase[c0] + rb;
                // Outer loop travels counter-clockwise from above: bottom edge then up is a0 a1 b1 b0.
                quad(sides, a0, a1, b1, b0);
            }
        }
    }
    // Caps at the innermost offset.
    const capOffset = b > 1e-6 ? -b : 0;
    const capOuter = offsetLoop(outer, capOffset), capHoles = holes.map(hl => offsetLoop(hl, capOffset));
    const all = [...capOuter, ...capHoles.flat()];
    const tris = triangulate(capOuter, capHoles);
    if (options.capBottom !== false) {
        const base = caps.positions.length / 3;
        for (const p of all) vertex(caps, [p[0], 0, -p[1]], [0, -1, 0], [p[0], p[1]]);
        for (let t = 0; t < tris.length; t += 3) tri(caps, base + tris[t], base + tris[t + 2], base + tris[t + 1]);
    }
    if (options.capTop !== false) {
        const base = caps.positions.length / 3;
        for (const p of all) vertex(caps, [p[0], h, -p[1]], [0, 1, 0], [p[0], p[1]]);
        for (let t = 0; t < tris.length; t += 3) tri(caps, base + tris[t], base + tris[t + 1], base + tris[t + 2]);
    }
    return join(partMesh(sides), partMesh(caps));
}

function normalize2(v: Vec2): Vec2 {
    const l = Math.hypot(v[0], v[1]) || 1;
    return [v[0] / l, v[1] / l];
}

function emptyOf(_region: string): Mesh {
    return { parts: [] };
}

// --- Sweep ---------------------------------------------------------------------------------------

export interface SweepOptions {
    /** Per path point scale of the profile (tapering branches, a tube that swells). */
    scales?: number[];
    /** Radians of profile rotation per unit of path length. */
    twist?: number;
    closed?: boolean;
    caps?: boolean;
    smoothAngle?: number;
    region?: string;
    /** A preferred "up" for the first frame; default picks one not parallel to the path. */
    up?: Vec3;
}

/**
 * Sweeps a closed 2D profile (CCW) along a 3D path with rotation-minimizing frames: tubes, rails,
 * chair frames, bent wire, cables and branches.
 */
export function sweep(path: Vec3[], profile: Vec2[], options: SweepOptions = {}): Mesh {
    const part = newPart(options.region ?? "default");
    const pts = dedupePath(path);
    if (pts.length < 2 || profile.length < 3) return partMesh(part);
    const closed = !!options.closed && pts.length > 2;
    const prof = ensureCCW(profile);
    const n = pts.length;
    const tangents: Vec3[] = pts.map((_, i) => {
        const a = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
        const b = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
        return normalize3(sub3(b, a));
    });
    let up: Vec3 = options.up ?? [0, 1, 0];
    if (Math.abs(dot3(up, tangents[0])) > 0.95) up = [1, 0, 0];
    let N = normalize3(cross3(cross3(tangents[0], up), tangents[0]));
    const frames: { N: Vec3; B: Vec3 }[] = [];
    for (let i = 0; i < n; i++) {
        if (i > 0) {
            // Double-reflection rotation-minimizing frame (Wang et al.).
            const v1 = sub3(pts[i], pts[i - 1]);
            const c1 = dot3(v1, v1) || 1;
            const rL = sub3(N, scale3(v1, (2 / c1) * dot3(v1, N)));
            const tL = sub3(tangents[i - 1], scale3(v1, (2 / c1) * dot3(v1, tangents[i - 1])));
            const v2 = sub3(tangents[i], tL);
            const c2 = dot3(v2, v2);
            N = c2 < 1e-12 ? rL : sub3(rL, scale3(v2, (2 / c2) * dot3(v2, rL)));
            N = normalize3(sub3(N, scale3(tangents[i], dot3(N, tangents[i]))));
        }
        frames.push({ N, B: normalize3(cross3(tangents[i], N)) });
    }
    // Profile normals (outward, right of CCW travel), smoothed unless the corner is sharp.
    const pn = edgeNormals(prof);
    const cosLimit = Math.cos((options.smoothAngle ?? 40) * DEG);
    const cols: { p: Vec2; n: Vec2; u: number }[] = [];
    let perim = 0;
    const colOfSeg: [number, number][] = [];
    for (let i = 0; i < prof.length; i++) {
        const a = pn[(i - 1 + prof.length) % prof.length], c = pn[i];
        const smooth = a[0] * c[0] + a[1] * c[1] >= cosLimit;
        if (i > 0) perim += Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]);
        if (smooth) { cols.push({ p: prof[i], n: normalize2([a[0] + c[0], a[1] + c[1]]), u: perim }); colOfSeg[i] = [cols.length - 1, cols.length - 1]; }
        else { cols.push({ p: prof[i], n: a, u: perim }); cols.push({ p: prof[i], n: c, u: perim }); colOfSeg[i] = [cols.length - 1, cols.length - 2]; }
    }
    perim += Math.hypot(prof[0][0] - prof[prof.length - 1][0], prof[0][1] - prof[prof.length - 1][1]);
    const first = colOfSeg[0];
    // The closing segment ends on vertex 0's "in" column, repeated with u = perimeter.
    const lastIn = cols.length; cols.push({ p: prof[0], n: cols[first[1]].n, u: perim });
    const ringCount = closed ? n + 1 : n;
    const along: number[] = [0];
    for (let i = 1; i < ringCount; i++) along.push(along[i - 1] + length3(sub3(pts[i % n], pts[i - 1])));
    const twist = options.twist ?? 0;
    const ringBase: number[] = [];
    for (let i = 0; i < ringCount; i++) {
        const pi = i % n;
        const f = frames[pi];
        const s = options.scales?.[pi] ?? 1;
        const tw = twist * along[i];
        const ct = Math.cos(tw), st = Math.sin(tw);
        ringBase.push(part.positions.length / 3);
        for (const col of cols) {
            const px = (col.p[0] * ct - col.p[1] * st) * s, py = (col.p[0] * st + col.p[1] * ct) * s;
            const nx = col.n[0] * ct - col.n[1] * st, ny = col.n[0] * st + col.n[1] * ct;
            const pos = add3(pts[pi], add3(scale3(f.N, px), scale3(f.B, py)));
            vertex(part, pos, normalize3(add3(scale3(f.N, nx), scale3(f.B, ny))), [col.u, along[i]]);
        }
    }
    for (let i = 0; i < ringCount - 1; i++) {
        for (let k = 0; k < prof.length; k++) {
            const c0 = colOfSeg[k][0];
            const c1 = k + 1 === prof.length ? lastIn : colOfSeg[k + 1][1];
            const a0 = ringBase[i] + c0, a1 = ringBase[i] + c1, b0 = ringBase[i + 1] + c0, b1 = ringBase[i + 1] + c1;
            quad(part, a0, a1, b1, b0);
        }
    }
    const mesh = partMesh(part);
    if (closed || options.caps === false) return mesh;
    const capPart = newPart(options.region ?? "default");
    const tris = triangulate(prof);
    for (const [end, sign] of [[0, -1], [n - 1, 1]] as const) {
        const f = frames[end];
        const s = options.scales?.[end] ?? 1;
        const tw = twist * along[end];
        const ct = Math.cos(tw), st = Math.sin(tw);
        const base = capPart.positions.length / 3;
        const nrm = scale3(tangents[end], sign);
        for (const p of prof) {
            const px = (p[0] * ct - p[1] * st) * s, py = (p[0] * st + p[1] * ct) * s;
            vertex(capPart, add3(pts[end], add3(scale3(f.N, px), scale3(f.B, py))), nrm, [p[0], p[1]]);
        }
        for (let t = 0; t < tris.length; t += 3) {
            if (sign > 0) tri(capPart, base + tris[t], base + tris[t + 1], base + tris[t + 2]);
            else tri(capPart, base + tris[t], base + tris[t + 2], base + tris[t + 1]);
        }
    }
    return join(mesh, partMesh(capPart));
}

function dedupePath(path: Vec3[]): Vec3[] {
    const out: Vec3[] = [];
    for (const p of path) if (!out.length || length3(sub3(p, out[out.length - 1])) > 1e-7) out.push(p);
    return out;
}

// --- Deformers -----------------------------------------------------------------------------------

/**
 * Bends the mesh around a vertical axis: `angle` radians across `width` of X, both ends curving toward +Z
 * (a chair back that wraps the sitter). Normals rotate with the bend.
 */
export function bendY(mesh: Mesh, angle: number, width: number): Mesh {
    if (Math.abs(angle) < 1e-6 || width <= 1e-6) return mesh;
    const R = width / angle;
    return {
        parts: mesh.parts.map(p => {
            const positions = p.positions.slice(), normals = p.normals.slice();
            for (let v = 0; v < positions.length; v += 3) {
                const x = positions[v], z = positions[v + 2];
                const th = x / R;
                const c = Math.cos(th), s = Math.sin(th);
                positions[v] = (R - z) * s;
                positions[v + 2] = R - (R - z) * c;
                const nx = normals[v], nz = normals[v + 2];
                normals[v] = nx * c + nz * s;
                normals[v + 2] = -nx * s + nz * c;
            }
            return { ...p, positions, normals, uvs: p.uvs.slice(), indices: p.indices.slice() };
        }),
    };
}

/** Scales X and Z linearly with Y between `y0` (factor 1) and `y1` (factor `amount`). */
export function taperY(mesh: Mesh, amount: number, y0: number, y1: number): Mesh {
    const span = y1 - y0 || 1;
    return mapPositions(mesh, ([x, y, z]) => {
        const t = Math.max(0, Math.min(1, (y - y0) / span));
        const f = 1 + (amount - 1) * t;
        return [x * f, y, z * f];
    });
}

/** Rotates around +Y by `rate` radians per unit of height. */
export function twistY(mesh: Mesh, rate: number): Mesh {
    return {
        parts: mesh.parts.map(p => {
            const positions = p.positions.slice(), normals = p.normals.slice();
            for (let v = 0; v < positions.length; v += 3) {
                const a = positions[v + 1] * rate, c = Math.cos(a), s = Math.sin(a);
                const x = positions[v], z = positions[v + 2];
                positions[v] = x * c - z * s; positions[v + 2] = x * s + z * c;
                const nx = normals[v], nz = normals[v + 2];
                normals[v] = nx * c - nz * s; normals[v + 2] = nx * s + nz * c;
            }
            return { ...p, positions, normals, uvs: p.uvs.slice(), indices: p.indices.slice() };
        }),
    };
}

/** Pushes vertices along their normal by fractal noise sampled at `frequency` (displaced shapes want smooth normals afterwards). */
export function displaceNoise(mesh: Mesh, amount: number, frequency: number, seed = 0, octaves = 4, radial = false): Mesh {
    return mapPositions(mesh, (p, n) => {
        const d = fbm3(p[0] * frequency, p[1] * frequency, p[2] * frequency, seed, octaves) * amount;
        // Radial: along the direction from the origin. A shape that is star-shaped around the origin
        // stays star-shaped, so however strong the noise its faces can never fold over.
        const dir = radial ? normalize3(p, n) : n;
        return [p[0] + dir[0] * d, p[1] + dir[1] * d, p[2] + dir[2] * d];
    });
}

// --- Arrangement ---------------------------------------------------------------------------------

/** `count` copies rotated evenly around +Y. */
export function radialArray(mesh: Mesh, count: number, startAngle = 0): Mesh {
    const n = Math.max(1, Math.round(count));
    return join(...Array.from({ length: n }, (_, i) => transformMesh(mesh, compose4([0, 0, 0], [0, startAngle + (i / n) * TAU, 0]))));
}

/** `count` copies, each `offset` further along. */
export function linearArray(mesh: Mesh, count: number, offset: Vec3): Mesh {
    const n = Math.max(1, Math.round(count));
    return join(...Array.from({ length: n }, (_, i) => transformMesh(mesh, compose4(scale3(offset, i)))));
}

/** The mesh plus its mirror image across the plane through the origin normal to `axis`. */
export function mirror(mesh: Mesh, axis: 0 | 1 | 2, keepOriginal = true): Mesh {
    const s: Vec3 = [1, 1, 1];
    s[axis] = -1;
    const m = transformMesh(mesh, compose4([0, 0, 0], [0, 0, 0], s));
    return keepOriginal ? join(mesh, m) : m;
}

export function copyPart(p: Part): Part {
    return { ...p, positions: p.positions.slice(), normals: p.normals.slice(), uvs: p.uvs.slice(), indices: p.indices.slice() };
}
