// Curves: the 2D outlines and 3D paths Mesha's builders consume. A 2D outline is a list of points
// (closed unless a builder says otherwise); a 3D path is a list of points a profile is swept along.

import type { Vec2, Vec3 } from "./mesha_mesh";

const TAU = Math.PI * 2;

/** Signed area, positive when counter-clockwise. */
export function signedArea(poly: Vec2[]): number {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
}

export function ensureCCW(poly: Vec2[]): Vec2[] {
    return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

export function ensureCW(poly: Vec2[]): Vec2[] {
    return signedArea(poly) > 0 ? poly.slice().reverse() : poly;
}

export function circle2(radius: number, segments = 32, center: Vec2 = [0, 0], start = 0): Vec2[] {
    const n = Math.max(3, Math.round(segments));
    return Array.from({ length: n }, (_, i) => {
        const a = start + (i / n) * TAU;
        return [center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius] as Vec2;
    });
}

export function ellipse2(rx: number, ry: number, segments = 32): Vec2[] {
    return circle2(1, segments).map(([x, y]) => [x * rx, y * ry] as Vec2);
}

/** Regular polygon; `start` rotates it (a hexagon with flats top and bottom wants start = 0). */
export function polygon2(radius: number, sides: number, start = 0): Vec2[] {
    return circle2(radius, sides, [0, 0], start);
}

/** A width x height rectangle centered on the origin with every corner rounded by `radius`. */
export function roundedRect2(width: number, height: number, radius: number, cornerSegments = 6): Vec2[] {
    const hw = width / 2, hh = height / 2;
    const r = Math.max(0, Math.min(radius, hw - 1e-4, hh - 1e-4));
    if (r <= 1e-5) return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    const out: Vec2[] = [];
    const corners: [number, number, number][] = [[hw - r, -hh + r, -Math.PI / 2], [hw - r, hh - r, 0], [-hw + r, hh - r, Math.PI / 2], [-hw + r, -hh + r, Math.PI]];
    const n = Math.max(1, Math.round(cornerSegments));
    for (const [cx, cy, a0] of corners) {
        for (let k = 0; k <= n; k++) {
            const a = a0 + (k / n) * (Math.PI / 2);
            out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
        }
    }
    return out;
}

/** Superellipse |x/a|^p + |y/b|^p = 1: p = 2 is an ellipse, larger p approaches a rectangle ("squircle" near 4). */
export function superellipse2(a: number, b: number, exponent: number, segments = 48): Vec2[] {
    const e = 2 / Math.max(0.2, exponent);
    return Array.from({ length: segments }, (_, i) => {
        const t = (i / segments) * TAU;
        const c = Math.cos(t), s = Math.sin(t);
        return [a * Math.sign(c) * Math.abs(c) ** e, b * Math.sign(s) * Math.abs(s) ** e] as Vec2;
    });
}

export function star2(outer: number, inner: number, points: number, start = Math.PI / 2): Vec2[] {
    const out: Vec2[] = [];
    for (let i = 0; i < points * 2; i++) {
        const r = i % 2 ? inner : outer, a = start + (i / (points * 2)) * TAU;
        out.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return out;
}

/**
 * A spur gear's outline: `teeth` trapezoid teeth between `root` and `tip` radius. `toothWidth` is the
 * share of each pitch the tooth tip covers (0..1) and `flank` how much wider its base is; `tipRound`
 * adds points across each tip so it reads as machined rather than cut from paper.
 */
export function gear2(teeth: number, root: number, tip: number, toothWidth = 0.45, flank = 0.25, tipSegments = 3): Vec2[] {
    const n = Math.max(3, Math.round(teeth));
    const pitch = TAU / n;
    const out: Vec2[] = [];
    const tipHalf = (pitch * Math.min(0.9, Math.max(0.1, toothWidth))) / 2;
    const baseHalf = Math.min(pitch * 0.49, tipHalf + pitch * flank * 0.5);
    for (let i = 0; i < n; i++) {
        const c = i * pitch;
        const pt = (a: number, r: number) => out.push([Math.cos(a) * r, Math.sin(a) * r]);
        pt(c - pitch / 2, root);
        pt(c - baseHalf, root);
        const m = Math.max(1, Math.round(tipSegments));
        for (let k = 0; k <= m; k++) pt(c - tipHalf + (2 * tipHalf * k) / m, tip);
        pt(c + baseHalf, root);
    }
    return out;
}

export function translate2(poly: Vec2[], dx: number, dy: number): Vec2[] {
    return poly.map(([x, y]) => [x + dx, y + dy] as Vec2);
}

export function rotate2(poly: Vec2[], angle: number): Vec2[] {
    const c = Math.cos(angle), s = Math.sin(angle);
    return poly.map(([x, y]) => [x * c - y * s, x * s + y * c] as Vec2);
}

export function scale2(poly: Vec2[], sx: number, sy = sx): Vec2[] {
    return poly.map(([x, y]) => [x * sx, y * sy] as Vec2);
}

/** Turns (radians) below which filletPolyline leaves a corner alone. */
const GENTLE_TURN = (12 * Math.PI) / 180;

/**
 * Replaces each corner of a polyline with a circular arc of up to `radius` (shortened where the
 * neighbouring edges are too short), so a profile with hard corners turns into one that catches
 * light like a real, finished object. Open polylines keep their end points.
 */
export function filletPolyline<T extends Vec2 | Vec3>(points: T[], radius: number, segments = 4, closed = false): T[] {
    if (radius <= 1e-6 || points.length < 3) return points.slice();
    const dim = points[0].length;
    const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
    const len = (a: number[]) => Math.hypot(...a);
    const out: T[] = [];
    const n = points.length;
    for (let i = 0; i < n; i++) {
        const isEnd = !closed && (i === 0 || i === n - 1);
        const p = points[i];
        if (isEnd) { out.push(p.slice() as T); continue; }
        const prev = points[(i - 1 + n) % n], next = points[(i + 1) % n];
        const a = sub(prev, p), b = sub(next, p);
        const la = len(a), lb = len(b);
        if (la < 1e-9 || lb < 1e-9) { out.push(p.slice() as T); continue; }
        const ua = a.map(v => v / la), ub = b.map(v => v / lb);
        const cos = Math.max(-1, Math.min(1, ua.reduce((s, v, k) => s + v * ub[k], 0)));
        const angle = Math.acos(cos);
        // Gentle corners stay as they are: a fillet's exact arc normals would leave the straight
        // runs between arcs flat-shaded (a faceted look), where averaged normals shade smoothly.
        if (angle > Math.PI - GENTLE_TURN || angle < 1e-3) { out.push(p.slice() as T); continue; }
        // Distance from the corner to the tangent points, capped at half of each neighbouring edge.
        let t = radius / Math.tan(angle / 2);
        t = Math.min(t, la * 0.5, lb * 0.5);
        const r = t * Math.tan(angle / 2);
        const pa = p.map((v, k) => v + ua[k] * t), pb = p.map((v, k) => v + ub[k] * t);
        const bis = ua.map((v, k) => v + ub[k]);
        const lbis = len(bis);
        const centerDist = r / Math.sin(angle / 2);
        const center = p.map((v, k) => v + (bis[k] / lbis) * centerDist);
        const m = Math.max(1, Math.round(segments));
        const va = sub(pa, center), vb = sub(pb, center);
        const sweep = Math.PI - angle;
        for (let k = 0; k <= m; k++) {
            // Slerp between the two radius vectors.
            const s = k / m;
            const w1 = Math.sin((1 - s) * sweep) / Math.sin(sweep), w2 = Math.sin(s * sweep) / Math.sin(sweep);
            const q = center.map((c, d) => c + va[d] * w1 + vb[d] * w2);
            out.push(q.slice(0, dim) as T);
        }
    }
    return dedupePoints(out, closed);
}

/** Drops consecutive points closer than `eps` (and a closing duplicate when `closed`). */
export function dedupePoints<T extends Vec2 | Vec3>(points: T[], closed = false, eps = 1e-7): T[] {
    const out: T[] = [];
    for (const p of points) {
        const last = out[out.length - 1];
        if (last && Math.hypot(...p.map((v, k) => v - last[k])) <= eps) continue;
        out.push(p);
    }
    if (closed && out.length > 2 && Math.hypot(...out[0].map((v, k) => v - out[out.length - 1][k])) <= eps) out.pop();
    return out;
}

/** Evenly spaced points along a cubic Bezier. */
export function bezier3<T extends Vec2 | Vec3>(p0: T, p1: T, p2: T, p3: T, segments = 16): T[] {
    const out: T[] = [];
    for (let i = 0; i <= segments; i++) {
        const t = i / segments, u = 1 - t;
        const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        out.push(p0.map((_, k) => a * p0[k] + b * p1[k] + c * p2[k] + d * p3[k]) as T);
    }
    return out;
}

/** A smooth curve through every control point (centripetal-ish Catmull-Rom), `samples` per span. */
export function smoothPath<T extends Vec2 | Vec3>(points: T[], samples = 8, closed = false): T[] {
    if (points.length < 3) return points.map(p => p.slice() as T);
    const n = points.length;
    const at = (i: number) => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
    const out: T[] = [];
    const spans = closed ? n : n - 1;
    for (let i = 0; i < spans; i++) {
        const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
        for (let s = 0; s < samples; s++) {
            const t = s / samples, t2 = t * t, t3 = t2 * t;
            out.push(p1.map((_, k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)) as T);
        }
    }
    if (!closed) out.push(points[n - 1].slice() as T);
    return out;
}

/** A helix around +Y starting at angle 0, `turns` full turns rising `pitch` per turn. */
export function helix3(radius: number, pitch: number, turns: number, segmentsPerTurn = 24): Vec3[] {
    const n = Math.max(2, Math.round(turns * segmentsPerTurn));
    return Array.from({ length: n + 1 }, (_, i) => {
        const t = (i / n) * turns;
        const a = t * TAU;
        return [Math.cos(a) * radius, t * pitch, -Math.sin(a) * radius] as Vec3;
    });
}

export function arc3(radius: number, start: number, end: number, segments = 16, center: Vec3 = [0, 0, 0]): Vec3[] {
    return Array.from({ length: segments + 1 }, (_, i) => {
        const a = start + ((end - start) * i) / segments;
        return [center[0] + Math.cos(a) * radius, center[1], center[2] + Math.sin(a) * radius] as Vec3;
    });
}

export function pathLength(points: (Vec2 | Vec3)[]): number {
    let l = 0;
    for (let i = 1; i < points.length; i++) l += Math.hypot(...points[i].map((v, k) => v - points[i - 1][k]));
    return l;
}

/** `count` points evenly spaced by arc length. */
export function resample<T extends Vec2 | Vec3>(points: T[], count: number): T[] {
    if (points.length < 2 || count < 2) return points.map(p => p.slice() as T);
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(...points[i].map((v, k) => v - points[i - 1][k])));
    const total = cum[cum.length - 1];
    const out: T[] = [];
    let j = 0;
    for (let i = 0; i < count; i++) {
        const d = (total * i) / (count - 1);
        while (j < cum.length - 2 && cum[j + 1] < d) j++;
        const seg = cum[j + 1] - cum[j] || 1;
        const t = (d - cum[j]) / seg;
        out.push(points[j].map((v, k) => v + (points[j + 1][k] - v) * t) as T);
    }
    return out;
}

/** Splits every segment longer than `step` into equal pieces; the original points stay. */
export function subdivideSegments<T extends Vec2 | Vec3>(points: T[], step: number, closed = false): T[] {
    if (step <= 0 || points.length < 2) return points.map(p => p.slice() as T);
    const out: T[] = [];
    const n = points.length;
    const spans = closed ? n : n - 1;
    for (let i = 0; i < spans; i++) {
        const a = points[i], b = points[(i + 1) % n];
        const len = Math.hypot(...a.map((v, k) => b[k] - v));
        const pieces = Math.min(256, Math.max(1, Math.ceil(len / step)));
        for (let k = 0; k < pieces; k++) out.push(a.map((v, d) => v + ((b[d] - v) * k) / pieces) as T);
    }
    if (!closed) out.push(points[n - 1].slice() as T);
    return out;
}
