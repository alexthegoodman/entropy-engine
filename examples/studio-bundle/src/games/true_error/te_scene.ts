// Geometry built in code: the spire's boxes and ramps as one ARCH mesh (tiling UVs in meters, the
// material layer and the baked sky openness in the vertex alpha), the plain far below, and the
// hypercube - a real tesseract, its 16 corners turned in two 4D planes and projected to 3D.

import { openness, MAT, type Box, type Ramp, type V3 } from "./te_level";

export interface MeshData { vertexData: Float32Array; indexData: Uint32Array }

/** Meters one repeat of each material covers (te_level.ts MAT order). */
const TILE = [2.4, 2.4, 2, 2, 3, 2.4, 1.5, 1.8, 3];

class Builder {
    v: number[] = [];
    i: number[] = [];
    quad(p: V3[], n: V3, uv: [number, number][], tint: V3, mat: number, openOffset = 0.3): void {
        const base = this.v.length / 12;
        for (let k = 0; k < 4; k++) {
            const q = p[k];
            const o = openness(q[0] + n[0] * openOffset, q[1] + n[1] * openOffset + 0.2, q[2] + n[2] * openOffset);
            this.v.push(q[0], q[1], q[2], n[0], n[1], n[2], uv[k][0], uv[k][1], tint[0], tint[1], tint[2], mat + Math.min(0.99, o * 0.99));
        }
        this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    done(): MeshData { return { vertexData: new Float32Array(this.v), indexData: new Uint32Array(this.i) }; }
}

/** A box's six faces with UVs in meters / tile along each face. */
function addBox(b: Builder, box: Box): void {
    const [x0, y0, z0] = box.min, [x1, y1, z1] = box.max;
    const t = TILE[box.mat] / (box.uvScale ?? 1);
    const u = (a: number) => a / t;
    const tint = box.tint, m = box.mat;
    // +y, -y
    b.quad([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0], [[u(x0), u(z0)], [u(x0), u(z1)], [u(x1), u(z1)], [u(x1), u(z0)]], tint, m);
    b.quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], [[u(x0), u(z0)], [u(x1), u(z0)], [u(x1), u(z1)], [u(x0), u(z1)]], tint, m);
    // +x, -x
    b.quad([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0], [[u(z0), u(-y0)], [u(z0), u(-y1)], [u(z1), u(-y1)], [u(z1), u(-y0)]], tint, m);
    b.quad([[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], [-1, 0, 0], [[u(-z1), u(-y0)], [u(-z1), u(-y1)], [u(-z0), u(-y1)], [u(-z0), u(-y0)]], tint, m);
    // +z, -z
    b.quad([[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]], [0, 0, 1], [[u(-x1), u(-y0)], [u(-x1), u(-y1)], [u(-x0), u(-y1)], [u(-x0), u(-y0)]], tint, m);
    b.quad([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], [0, 0, -1], [[u(x0), u(-y0)], [u(x0), u(-y1)], [u(x1), u(-y1)], [u(x1), u(-y0)]], tint, m);
}

function addRamp(b: Builder, r: Ramp): void {
    const t = TILE[r.mat];
    const len = Math.hypot(r.z1 - r.z0, r.y1 - r.y0);
    const ny = (r.z1 - r.z0) / len, nz = -(r.y1 - r.y0) / len;
    const top: V3[] = [[r.x0, r.y0, r.z0], [r.x0, r.y1, r.z1], [r.x1, r.y1, r.z1], [r.x1, r.y0, r.z0]];
    const bot: V3[] = top.map(p => [p[0], p[1] - r.thick * ny, p[2] - r.thick * nz] as V3);
    const tint: V3 = [0.86, 0.84, 0.8];
    b.quad(top, [0, ny, nz], [[r.x0 / t, 0], [r.x0 / t, len / t], [r.x1 / t, len / t], [r.x1 / t, 0]], tint, r.mat);
    b.quad([bot[0], bot[3], bot[2], bot[1]], [0, -ny, -nz], [[0, 0], [1, 0], [1, len / t], [0, len / t]], tint, r.mat);
    b.quad([bot[0], bot[1], top[1], top[0]], [-1, 0, 0], [[0, 0], [len / t, 0], [len / t, r.thick / t], [0, r.thick / t]], tint, r.mat);
    b.quad([top[3], top[2], bot[2], bot[3]], [1, 0, 0], [[0, 0], [len / t, 0], [len / t, r.thick / t], [0, r.thick / t]], tint, r.mat);
    // The torn end at the bottom.
    b.quad([bot[3], top[3], top[0], bot[0]], [0, 0, -1], [[0, 0], [0, 0.2], [1, 0.2], [1, 0]], tint, r.mat);
}

export function archMesh(boxes: Box[], ramps: Ramp[]): MeshData {
    const b = new Builder();
    for (const box of boxes) if (box.draw) addBox(b, box);
    for (const r of ramps) addRamp(b, r);
    return b.done();
}

/** The plain under the city: a wide quad, soil (UVs come from world xz in the shader). */
export function groundMesh(y: number, half: number): MeshData {
    const b = new Builder();
    b.quad([[-half, y, -half], [-half, y, half], [half, y, half], [half, y, -half]], [0, 1, 0], [[0, 0], [0, 1], [1, 1], [1, 0]], [0.95, 0.62, 0.45], MAT.soil, 0);
    return b.done();
}

// --- The hypercube --------------------------------------------------------------------------------

const CORNERS: number[][] = [];
for (let i = 0; i < 16; i++) CORNERS.push([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1, i & 8 ? 1 : -1]);
/** Pairs of corners one coordinate apart: the tesseract's 32 edges. */
export const EDGES: [number, number][] = [];
for (let a = 0; a < 16; a++) for (let k = 0; k < 4; k++) { const b = a ^ (1 << k); if (a < b) EDGES.push([a, b]); }

/**
 * The 16 corners at time t, turned in the xw and zw planes (and a slow yz drift), projected from
 * 4D with a perspective on w, scaled to `size` meters across, centered on `c`.
 */
export function tesseract(t: number, c: V3, size: number): V3[] {
    const a = t * 0.45, b = t * 0.31, g = t * 0.12;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    return CORNERS.map(([x0, y0, z0, w0]) => {
        let x = x0 * ca - w0 * sa, w = x0 * sa + w0 * ca;
        let z = z0 * cb - w * sb; w = z0 * sb + w * cb;
        const y = y0 * cg - z * sg; z = y0 * sg + z * cg;
        const k = 1 / (2.6 - w);
        const s = (size / 2) * k * 1.6;
        return [c[0] + x * s, c[1] + y * s, c[2] + z * s] as V3;
    });
}

/** A frame whose z axis runs from a to b (length |b - a|), x and y `r` thick: for edges and beams. */
export function along(a: V3, b: V3, r: number): number[] {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...d) || 1e-6;
    const f: V3 = [d[0] / len, d[1] / len, d[2] / len];
    const up: V3 = Math.abs(f[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    let x: V3 = [up[1] * f[2] - up[2] * f[1], up[2] * f[0] - up[0] * f[2], up[0] * f[1] - up[1] * f[0]];
    const xl = Math.hypot(...x); x = [x[0] / xl, x[1] / xl, x[2] / xl];
    const y: V3 = [f[1] * x[2] - f[2] * x[1], f[2] * x[0] - f[0] * x[2], f[0] * x[1] - f[1] * x[0]];
    const m: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    // The unit box shape spans -1..1, so half extents.
    return [x[0] * r, x[1] * r, x[2] * r, 0, y[0] * r, y[1] * r, y[2] * r, 0, d[0] / 2, d[1] / 2, d[2] / 2, 0, m[0], m[1], m[2], 1];
}

/**
 * A model placed: turned by yaw about +y, scaled by s, its model-space point (cx, -lift, cz)
 * brought to `pos` (so a Meshy prop stands on the floor at its center).
 */
export function placeModel(pos: V3, yaw: number, s: number, cx: number, lift: number, cz: number, pitch = 0, roll = 0): number[] {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    // R = Ry(yaw) * Rx(pitch) * Rz(roll), columns.
    const r0: V3 = [cy * cr + sy * sp * sr, cp * sr, -sy * cr + cy * sp * sr];
    const r1: V3 = [-cy * sr + sy * sp * cr, cp * cr, sy * sr + cy * sp * cr];
    const r2: V3 = [sy * cp, -sp, cy * cp];
    const ox = -cx * s, oy = lift * s, oz = -cz * s;
    const t: V3 = [pos[0] + r0[0] * ox + r1[0] * oy + r2[0] * oz, pos[1] + r0[1] * ox + r1[1] * oy + r2[1] * oz, pos[2] + r0[2] * ox + r1[2] * oy + r2[2] * oz];
    return [r0[0] * s, r0[1] * s, r0[2] * s, 0, r1[0] * s, r1[1] * s, r1[2] * s, 0, r2[0] * s, r2[1] * s, r2[2] * s, 0, t[0], t[1], t[2], 1];
}

/** A frame at p with x = -forward (the rifle's barrel is its -x), y = up, scaled by s. */
export function rifleFrame(p: V3, fwd: V3, s: number): number[] {
    const up: V3 = [0, 1, 0];
    let r: V3 = [fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2], fwd[0] * up[1] - fwd[1] * up[0]];
    const rl = Math.hypot(...r) || 1; r = [r[0] / rl, r[1] / rl, r[2] / rl];
    const u: V3 = [r[1] * fwd[2] - r[2] * fwd[1], r[2] * fwd[0] - r[0] * fwd[2], r[0] * fwd[1] - r[1] * fwd[0]];
    return [-fwd[0] * s, -fwd[1] * s, -fwd[2] * s, 0, u[0] * s, u[1] * s, u[2] * s, 0, -r[0] * s, -r[1] * s, -r[2] * s, 0, p[0], p[1], p[2], 1];
}
