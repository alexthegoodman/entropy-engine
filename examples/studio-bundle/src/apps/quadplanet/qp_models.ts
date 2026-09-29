// Procedural models for QuadPlanet: the ship, the walker (body + two swinging legs) and the sky
// sphere. Everything is built from convex primitives whose triangles are turned to face away
// from the primitive's own center, so the engine's back-face culling keeps the outside.
//
// Model space: +X right, +Y up, -Z forward (see qp_math.ts frameMatrix), origin on the ground.

import { type Vec3, add, cross, dot, normalize, sub } from "./qp_math";
import { MATERIAL_GLASS, MATERIAL_GLOW, MATERIAL_PAINT, MATERIAL_SKY } from "./qp_shader";

type RGB = [number, number, number];

export interface ModelMesh { vertexData: number[]; indexData: number[] }

export class MeshBuilder {
    vertexData: number[] = [];
    indexData: number[] = [];
    private count = 0;

    /** Adds triangles (flat-shaded) from a point list, each turned to face away from `inside`. */
    private tri(a: Vec3, b: Vec3, c: Vec3, inside: Vec3, color: RGB, material: number, smooth?: [Vec3, Vec3, Vec3]): void {
        let n = normalize(cross(sub(b, a), sub(c, a)));
        const centroid: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
        let pts: Vec3[] = [a, b, c];
        let norms = smooth ? [...smooth] : [n, n, n];
        if (dot(n, sub(centroid, inside)) < 0) {
            pts = [a, c, b];
            norms = smooth ? [smooth[0], smooth[2], smooth[1]] : norms;
            n = [-n[0], -n[1], -n[2]];
            if (!smooth) norms = [n, n, n];
        }
        for (let k = 0; k < 3; k++) {
            const p = pts[k], nn = norms[k];
            this.vertexData.push(p[0], p[1], p[2], nn[0], nn[1], nn[2], material, 0, color[0], color[1], color[2], 1);
            this.indexData.push(this.count++);
        }
    }

    /** A hexahedron from 8 corners: bottom face 0-3, top face 4-7, both in the same order. */
    hexa(c: Vec3[], color: RGB, material = MATERIAL_PAINT): this {
        const inside: Vec3 = c.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3).map(v => v / 8) as Vec3;
        const quads = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
        for (const q of quads) {
            this.tri(c[q[0]], c[q[1]], c[q[2]], inside, color, material);
            this.tri(c[q[0]], c[q[2]], c[q[3]], inside, color, material);
        }
        return this;
    }

    box(center: Vec3, half: Vec3, color: RGB, material = MATERIAL_PAINT): this {
        const [x, y, z] = center, [hx, hy, hz] = half;
        return this.hexa([
            [x - hx, y - hy, z - hz], [x + hx, y - hy, z - hz], [x + hx, y - hy, z + hz], [x - hx, y - hy, z + hz],
            [x - hx, y + hy, z - hz], [x + hx, y + hy, z - hz], [x + hx, y + hy, z + hz], [x - hx, y + hy, z + hz],
        ], color, material);
    }

    /** Smooth-shaded ellipsoid. */
    ellipsoid(center: Vec3, radii: Vec3, color: RGB, material = MATERIAL_PAINT, seg = 18, ring = 12): this {
        const pt = (i: number, j: number): [Vec3, Vec3] => {
            const th = (i / seg) * Math.PI * 2, ph = (j / ring) * Math.PI;
            const u: Vec3 = [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
            const p: Vec3 = [center[0] + u[0] * radii[0], center[1] + u[1] * radii[1], center[2] + u[2] * radii[2]];
            const n = normalize([u[0] / radii[0], u[1] / radii[1], u[2] / radii[2]]);
            return [p, n];
        };
        for (let j = 0; j < ring; j++) {
            for (let i = 0; i < seg; i++) {
                const [a, na] = pt(i, j), [b, nb] = pt(i + 1, j), [c, nc] = pt(i, j + 1), [d, nd] = pt(i + 1, j + 1);
                if (j > 0) this.tri(a, b, c, center, color, material, [na, nb, nc]);
                if (j < ring - 1) this.tri(b, d, c, center, color, material, [nb, nd, nc]);
            }
        }
        return this;
    }

    /** Cylinder along Z from z0 to z1 (capped). */
    cylinderZ(cx: number, cy: number, z0: number, z1: number, r: number, color: RGB, material = MATERIAL_PAINT, seg = 16): this {
        const inside: Vec3 = [cx, cy, (z0 + z1) / 2];
        for (let i = 0; i < seg; i++) {
            const t0 = (i / seg) * Math.PI * 2, t1 = ((i + 1) / seg) * Math.PI * 2;
            const p = (t: number, z: number): Vec3 => [cx + Math.cos(t) * r, cy + Math.sin(t) * r, z];
            const n = (t: number): Vec3 => [Math.cos(t), Math.sin(t), 0];
            this.tri(p(t0, z0), p(t1, z0), p(t0, z1), inside, color, material, [n(t0), n(t1), n(t0)]);
            this.tri(p(t1, z0), p(t1, z1), p(t0, z1), inside, color, material, [n(t1), n(t1), n(t0)]);
            this.tri([cx, cy, z0], p(t0, z0), p(t1, z0), inside, color, material);
            this.tri([cx, cy, z1], p(t1, z1), p(t0, z1), inside, color, material);
        }
        return this;
    }

    build(): ModelMesh { return { vertexData: this.vertexData, indexData: this.indexData }; }
}

const HULL: RGB = [0.86, 0.87, 0.9];
const ACCENT: RGB = [0.95, 0.42, 0.12];
const DARK: RGB = [0.2, 0.21, 0.25];
const GLASS: RGB = [0.18, 0.32, 0.45];
const ENGINE_GLOW: RGB = [0.35, 0.7, 1.0];

/** The ship: about 10 units long, landing legs touching y = 0, nose toward -Z. */
export function buildShip(): ModelMesh {
    const m = new MeshBuilder();
    const y = 1.7;
    m.ellipsoid([0, y, 0], [1.25, 0.85, 4.6], HULL);
    m.ellipsoid([0, y - 0.05, -3.9], [0.72, 0.5, 1.3], ACCENT);
    m.ellipsoid([0, y + 0.55, -1.5], [0.72, 0.52, 1.7], GLASS, MATERIAL_GLASS);
    // Swept wings, left and right.
    for (const s of [-1, 1]) {
        const wy = y - 0.25, t = 0.12;
        const root = s * 1.0, tip = s * 5.4;
        m.hexa([
            [root, wy - t, -0.6], [tip, wy - t + 0.35, 1.6], [tip, wy - t + 0.35, 2.7], [root, wy - t, 2.9],
            [root, wy + t, -0.6], [tip, wy + t + 0.35, 1.6], [tip, wy + t + 0.35, 2.7], [root, wy + t, 2.9],
        ], HULL);
        // Accent stripe along the leading edge and a glowing wingtip light.
        m.hexa([
            [root * 1.02, wy + t, -0.55], [tip * 0.98, wy + t + 0.35, 1.62], [tip * 0.98, wy + t + 0.36, 1.95], [root * 1.02, wy + t + 0.01, 0.0],
            [root * 1.02, wy + t + 0.04, -0.55], [tip * 0.98, wy + t + 0.39, 1.62], [tip * 0.98, wy + t + 0.4, 1.95], [root * 1.02, wy + t + 0.05, 0.0],
        ], ACCENT);
        m.box([tip, wy + 0.35, 2.15], [0.08, 0.1, 0.5], s < 0 ? [1, 0.25, 0.2] : [0.3, 1, 0.4], MATERIAL_GLOW);
        // Engine nacelle and its exhaust.
        m.cylinderZ(s * 1.25, y - 0.2, 1.6, 5.0, 0.52, DARK);
        m.cylinderZ(s * 1.25, y - 0.2, 5.0, 5.12, 0.4, ENGINE_GLOW, MATERIAL_GLOW);
        // Landing legs.
        m.box([s * 1.1, 0.55, 1.2], [0.09, 0.55, 0.09], DARK);
        m.box([s * 1.1, 0.04, 1.2], [0.3, 0.04, 0.38], DARK);
    }
    m.box([0, 0.55, -2.8], [0.09, 0.55, 0.09], DARK);
    m.box([0, 0.04, -2.8], [0.3, 0.04, 0.34], DARK);
    // Tail fin.
    m.hexa([
        [-0.08, y + 0.5, 1.8], [-0.08, y + 0.5, 4.2], [-0.05, y + 2.1, 4.6], [-0.05, y + 2.1, 3.5],
        [0.08, y + 0.5, 1.8], [0.08, y + 0.5, 4.2], [0.05, y + 2.1, 4.6], [0.05, y + 2.1, 3.5],
    ], ACCENT);
    return m.build();
}

const SUIT: RGB = [0.92, 0.92, 0.9];
const SUIT_ACCENT: RGB = [0.95, 0.5, 0.15];
const VISOR: RGB = [0.55, 0.42, 0.18];

/** The walker's body (without legs): feet at y = 0 when legs are attached at the hips. */
export function buildWalkerBody(): ModelMesh {
    const m = new MeshBuilder();
    m.ellipsoid([0, 1.18, 0], [0.33, 0.4, 0.23], SUIT);
    m.ellipsoid([0, 0.86, 0], [0.3, 0.14, 0.2], SUIT_ACCENT);
    m.box([0, 1.22, 0.3], [0.25, 0.3, 0.12], DARK);
    m.ellipsoid([0, 1.66, 0], [0.23, 0.24, 0.23], SUIT);
    m.ellipsoid([0, 1.66, -0.1], [0.17, 0.13, 0.15], VISOR, MATERIAL_GLASS);
    for (const s of [-1, 1]) m.ellipsoid([s * 0.42, 1.1, 0], [0.09, 0.33, 0.1], SUIT);
    m.box([0.14, 1.36, 0.43], [0.03, 0.05, 0.02], [0.3, 1, 0.5], MATERIAL_GLOW);
    return m.build();
}

/** Hip height: the legs' pivot above the feet. */
export const HIP_HEIGHT = 0.86;

/** One leg hanging from the pivot at the origin down to the foot at y = -HIP_HEIGHT. */
export function buildWalkerLeg(): ModelMesh {
    const m = new MeshBuilder();
    m.ellipsoid([0, -0.38, 0], [0.12, 0.42, 0.13], SUIT);
    m.box([0, -0.8, -0.05], [0.12, 0.06, 0.18], DARK);
    return m.build();
}

/** A unit sphere seen from inside, drawn as the sky (the shader scales and centers it). */
export function buildSky(seg = 32, ring = 16): ModelMesh {
    const vertexData: number[] = [];
    const indexData: number[] = [];
    for (let j = 0; j <= ring; j++) {
        for (let i = 0; i <= seg; i++) {
            const th = (i / seg) * Math.PI * 2, ph = (j / ring) * Math.PI;
            const p: Vec3 = [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
            vertexData.push(p[0], p[1], p[2], -p[0], -p[1], -p[2], MATERIAL_SKY, 0, 0, 0, 0, 1);
        }
    }
    const row = seg + 1;
    for (let j = 0; j < ring; j++) {
        for (let i = 0; i < seg; i++) {
            const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
            // Wound to face the center (the camera sits inside).
            indexData.push(a, b, c, b, d, c);
        }
    }
    return fixSkyWinding({ vertexData, indexData });
}

/** Orients every sky triangle so its front faces the sphere's center. */
function fixSkyWinding(m: ModelMesh): ModelMesh {
    const P = (i: number): Vec3 => [m.vertexData[i * 12], m.vertexData[i * 12 + 1], m.vertexData[i * 12 + 2]];
    for (let t = 0; t < m.indexData.length; t += 3) {
        const a = P(m.indexData[t]), b = P(m.indexData[t + 1]), c = P(m.indexData[t + 2]);
        const n = cross(sub(b, a), sub(c, a));
        const centroid: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
        if (dot(n, centroid) > 0) {
            const tmp = m.indexData[t + 1];
            m.indexData[t + 1] = m.indexData[t + 2];
            m.indexData[t + 2] = tmp;
        }
    }
    return m;
}
