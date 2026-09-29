// Small vector helpers for QuadPlanet. Plain tuples keep the hot loops (chunk building) free of
// allocation-heavy classes and make every value trivially JSON-serializable for the MCP tools.

export type Vec3 = [number, number, number];

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
export const smoothstep = (e0: number, e1: number, x: number): number => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
};

export function normalize(a: Vec3): Vec3 {
    const l = length(a);
    return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
}

/** `v` with its component along the unit vector `n` removed. */
export function projectOnPlane(v: Vec3, n: Vec3): Vec3 {
    return addScaled(v, n, -dot(v, n));
}

/** Rotates `v` around the unit `axis` by `angle` radians (Rodrigues). */
export function rotateAround(v: Vec3, axis: Vec3, angle: number): Vec3 {
    const c = Math.cos(angle), s = Math.sin(angle);
    const k = cross(axis, v);
    const d = dot(axis, v) * (1 - c);
    return [v[0] * c + k[0] * s + axis[0] * d, v[1] * c + k[1] * s + axis[1] * d, v[2] * c + k[2] * s + axis[2] * d];
}

/** Any unit vector perpendicular to the unit `n`. */
export function anyPerpendicular(n: Vec3): Vec3 {
    const helper: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    return normalize(cross(helper, n));
}

/**
 * An orthonormal frame: `forward` and `up` as given (forward made perpendicular to up), and
 * `right` completing a right-handed basis (right = forward x up).
 */
export interface Frame { forward: Vec3; up: Vec3; right: Vec3 }

export function makeFrame(forward: Vec3, up: Vec3): Frame {
    const u = normalize(up);
    let f = projectOnPlane(forward, u);
    if (length(f) < 1e-6) f = anyPerpendicular(u);
    f = normalize(f);
    return { forward: f, up: u, right: normalize(cross(f, u)) };
}

/**
 * Column-major 4x4 model matrix (WGSL `mat4x4<f32>` layout) placing a model whose local axes are
 * +X right, +Y up, -Z forward at `position` with the given frame and uniform scale.
 */
export function frameMatrix(position: Vec3, frame: Frame, s = 1): number[] {
    const { right: r, up: u, forward: f } = frame;
    return [
        r[0] * s, r[1] * s, r[2] * s, 0,
        u[0] * s, u[1] * s, u[2] * s, 0,
        -f[0] * s, -f[1] * s, -f[2] * s, 0,
        position[0], position[1], position[2], 1,
    ];
}

export function identity4(): number[] {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Cubic Bezier point. */
export function bezier(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return [
        p0[0] * a + p1[0] * b + p2[0] * c + p3[0] * d,
        p0[1] * a + p1[1] * b + p2[1] * c + p3[1] * d,
        p0[2] * a + p1[2] * b + p2[2] * c + p3[2] * d,
    ];
}

/** Cubic Bezier derivative (unnormalized tangent). */
export function bezierTangent(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
    const u = 1 - t;
    const a = 3 * u * u, b = 6 * u * t, c = 3 * t * t;
    return [
        (p1[0] - p0[0]) * a + (p2[0] - p1[0]) * b + (p3[0] - p2[0]) * c,
        (p1[1] - p0[1]) * a + (p2[1] - p1[1]) * b + (p3[1] - p2[1]) * c,
        (p1[2] - p0[2]) * a + (p2[2] - p1[2]) * b + (p3[2] - p2[2]) * c,
    ];
}

/** Rounds every component to `digits` decimals (for readable tool replies). */
export function round3(v: Vec3, digits = 2): Vec3 {
    const k = 10 ** digits;
    return [Math.round(v[0] * k) / k, Math.round(v[1] * k) / k, Math.round(v[2] * k) / k];
}
