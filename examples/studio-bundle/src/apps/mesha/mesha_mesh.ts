// Mesha's geometry value. A Mesh is a list of Parts, and every Part belongs to one semantic region
// ("frame", "upholstery", "glass"...). Nodes never merge regions, so a material stays attached to
// the geometry it was made for no matter how the procedural object is resized or rebuilt: the
// region, not a face index, is what a material binds to.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** Column-major 4x4, the same layout gl-matrix and WGSL use. */
export type Mat4 = number[];

export interface Part {
    region: string;
    /** Flat x,y,z. */
    positions: number[];
    /** Flat x,y,z, unit length. */
    normals: number[];
    /** Flat u,v. */
    uvs: number[];
    /** Counter-clockwise triangles seen from outside. */
    indices: number[];
}

export interface Mesh {
    parts: Part[];
}

export const emptyMesh = (): Mesh => ({ parts: [] });

export function newPart(region = "default"): Part {
    return { region, positions: [], normals: [], uvs: [], indices: [] };
}

export function partMesh(part: Part): Mesh {
    return { parts: part.indices.length ? [part] : [] };
}

/** Appends a vertex and returns its index. */
export function vertex(part: Part, p: Vec3, n: Vec3, uv: Vec2 = [0, 0]): number {
    const i = part.positions.length / 3;
    part.positions.push(p[0], p[1], p[2]);
    part.normals.push(n[0], n[1], n[2]);
    part.uvs.push(uv[0], uv[1]);
    return i;
}

export function tri(part: Part, a: number, b: number, c: number): void {
    part.indices.push(a, b, c);
}

/** a-b-c-d counter-clockwise. */
export function quad(part: Part, a: number, b: number, c: number, d: number): void {
    part.indices.push(a, b, c, a, c, d);
}

export function vertexCount(mesh: Mesh): number {
    return mesh.parts.reduce((n, p) => n + p.positions.length / 3, 0);
}

export function triangleCount(mesh: Mesh): number {
    return mesh.parts.reduce((n, p) => n + p.indices.length / 3, 0);
}

export function clonePart(p: Part): Part {
    return { region: p.region, positions: p.positions.slice(), normals: p.normals.slice(), uvs: p.uvs.slice(), indices: p.indices.slice() };
}

export function cloneMesh(mesh: Mesh): Mesh {
    return { parts: mesh.parts.map(clonePart) };
}

export function join(...meshes: (Mesh | null | undefined)[]): Mesh {
    return { parts: meshes.flatMap(m => (m ? m.parts : [])) };
}

/** Every part of `mesh` moved into `region`. */
export function setRegion(mesh: Mesh, region: string): Mesh {
    return { parts: mesh.parts.map(p => ({ ...p, region })) };
}

/** One part per region, so a renderer or exporter draws each material once. */
export function mergeByRegion(mesh: Mesh): Part[] {
    const byRegion = new Map<string, Part>();
    for (const p of mesh.parts) {
        let into = byRegion.get(p.region);
        if (!into) { into = newPart(p.region); byRegion.set(p.region, into); }
        const base = into.positions.length / 3;
        for (let i = 0; i < p.positions.length; i++) into.positions.push(p.positions[i]);
        for (let i = 0; i < p.normals.length; i++) into.normals.push(p.normals[i]);
        for (let i = 0; i < p.uvs.length; i++) into.uvs.push(p.uvs[i]);
        for (let i = 0; i < p.indices.length; i++) into.indices.push(p.indices[i] + base);
    }
    return [...byRegion.values()];
}

// --- Vectors -------------------------------------------------------------------------------------

export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export function normalize3(a: Vec3, fallback: Vec3 = [0, 1, 0]): Vec3 {
    const l = length3(a);
    return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : fallback;
}

// --- Matrices ------------------------------------------------------------------------------------

export const identity4 = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function multiply4(a: Mat4, b: Mat4): Mat4 {
    const out = new Array<number>(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
            out[c * 4 + r] = s;
        }
    }
    return out;
}

/** Translate * RotateZ * RotateY * RotateX * Scale: scale first, then X, Y, Z rotation (radians), then move. */
export function compose4(translate: Vec3 = [0, 0, 0], rotate: Vec3 = [0, 0, 0], scale: Vec3 = [1, 1, 1]): Mat4 {
    const [rx, ry, rz] = rotate;
    const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
    // R = Rz * Ry * Rx, columns.
    const m00 = cz * cy, m10 = sz * cy, m20 = -sy;
    const m01 = cz * sy * sx - sz * cx, m11 = sz * sy * sx + cz * cx, m21 = cy * sx;
    const m02 = cz * sy * cx + sz * sx, m12 = sz * sy * cx - cz * sx, m22 = cy * cx;
    const [kx, ky, kz] = scale;
    return [
        m00 * kx, m10 * kx, m20 * kx, 0,
        m01 * ky, m11 * ky, m21 * ky, 0,
        m02 * kz, m12 * kz, m22 * kz, 0,
        translate[0], translate[1], translate[2], 1,
    ];
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
    return [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ];
}

/** The 3x3 inverse-transpose of `m`'s linear part (row-major 9) and its determinant. */
function normalMatrix(m: Mat4): { n: number[]; det: number } {
    const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    // inverse-transpose = cofactor matrix / det
    const inv = 1 / (det || 1);
    const n = [
        A * inv, B * inv, C * inv,
        -(b * i - c * h) * inv, (a * i - c * g) * inv, -(a * h - b * g) * inv,
        (b * f - c * e) * inv, -(a * f - c * d) * inv, (a * e - b * d) * inv,
    ];
    return { n, det };
}

/** A transformed copy. A mirroring matrix (negative determinant) flips the winding so faces still point out. */
export function transformMesh(mesh: Mesh, m: Mat4): Mesh {
    const { n, det } = normalMatrix(m);
    return {
        parts: mesh.parts.map(p => {
            const positions = new Array<number>(p.positions.length);
            const normals = new Array<number>(p.normals.length);
            for (let v = 0; v < p.positions.length; v += 3) {
                const x = p.positions[v], y = p.positions[v + 1], z = p.positions[v + 2];
                positions[v] = m[0] * x + m[4] * y + m[8] * z + m[12];
                positions[v + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
                positions[v + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
                const nx = p.normals[v], ny = p.normals[v + 1], nz = p.normals[v + 2];
                const tx = n[0] * nx + n[1] * ny + n[2] * nz;
                const ty = n[3] * nx + n[4] * ny + n[5] * nz;
                const tz = n[6] * nx + n[7] * ny + n[8] * nz;
                const l = Math.hypot(tx, ty, tz) || 1;
                normals[v] = tx / l; normals[v + 1] = ty / l; normals[v + 2] = tz / l;
            }
            let indices = p.indices;
            if (det < 0) {
                indices = p.indices.slice();
                for (let t = 0; t < indices.length; t += 3) { const s = indices[t + 1]; indices[t + 1] = indices[t + 2]; indices[t + 2] = s; }
            }
            return { region: p.region, positions, normals, uvs: p.uvs.slice(), indices };
        }),
    };
}

export interface Bounds { min: Vec3; max: Vec3 }

export function bounds(mesh: Mesh): Bounds | null {
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (const p of mesh.parts) {
        for (let v = 0; v < p.positions.length; v += 3) {
            any = true;
            for (let k = 0; k < 3; k++) {
                const x = p.positions[v + k];
                if (x < min[k]) min[k] = x;
                if (x > max[k]) max[k] = x;
            }
        }
    }
    return any ? { min, max } : null;
}

/**
 * Normals from the faces, averaged over every vertex that shares a position when `smooth`, so a
 * displaced surface stays one continuous shape across its UV and region seams. Flat splits every
 * triangle into its own three vertices (a faceted, low-poly look).
 */
export function recomputeNormals(mesh: Mesh, smooth = true): Mesh {
    if (!smooth) {
        return {
            parts: mesh.parts.map(p => {
                const out = newPart(p.region);
                for (let t = 0; t < p.indices.length; t += 3) {
                    const ids = [p.indices[t], p.indices[t + 1], p.indices[t + 2]];
                    const pts = ids.map(i => [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]] as Vec3);
                    const nrm = normalize3(cross3(sub3(pts[1], pts[0]), sub3(pts[2], pts[0])));
                    const base = out.positions.length / 3;
                    ids.forEach((i, k) => vertex(out, pts[k], nrm, [p.uvs[i * 2], p.uvs[i * 2 + 1]]));
                    tri(out, base, base + 1, base + 2);
                }
                return out;
            }),
        };
    }
    const key = (x: number, y: number, z: number) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    const sums = new Map<string, Vec3>();
    for (const p of mesh.parts) {
        for (let t = 0; t < p.indices.length; t += 3) {
            const a = p.indices[t] * 3, b = p.indices[t + 1] * 3, c = p.indices[t + 2] * 3;
            const pa: Vec3 = [p.positions[a], p.positions[a + 1], p.positions[a + 2]];
            const e1 = sub3([p.positions[b], p.positions[b + 1], p.positions[b + 2]], pa);
            const e2 = sub3([p.positions[c], p.positions[c + 1], p.positions[c + 2]], pa);
            const fn = cross3(e1, e2); // area-weighted
            for (const v of [a, b, c]) {
                const k = key(p.positions[v], p.positions[v + 1], p.positions[v + 2]);
                const s = sums.get(k);
                if (s) { s[0] += fn[0]; s[1] += fn[1]; s[2] += fn[2]; } else sums.set(k, [...fn]);
            }
        }
    }
    return {
        parts: mesh.parts.map(p => {
            const normals = p.normals.slice();
            for (let v = 0; v < p.positions.length; v += 3) {
                const s = sums.get(key(p.positions[v], p.positions[v + 1], p.positions[v + 2]));
                if (!s) continue;
                const n = normalize3(s, [p.normals[v], p.normals[v + 1], p.normals[v + 2]]);
                normals[v] = n[0]; normals[v + 1] = n[1]; normals[v + 2] = n[2];
            }
            return { ...p, positions: p.positions.slice(), uvs: p.uvs.slice(), indices: p.indices.slice(), normals };
        }),
    };
}

/**
 * Auto-smooth: each triangle corner gets the area-weighted average of the faces around its position
 * whose normals are within `angle` radians of its own face, so gentle curvature shades smooth and
 * creases stay crisp (Blender's "Shade Auto Smooth"). Corners that end up identical are re-shared.
 */
export function autoSmoothNormals(mesh: Mesh, angle: number): Mesh {
    const cosLimit = Math.cos(angle);
    // Weld positions to small integer ids once per vertex.
    const ids = new Map<string, number>();
    const vertId: Int32Array[] = mesh.parts.map(p => {
        const out = new Int32Array(p.positions.length / 3);
        for (let v = 0; v < out.length; v++) {
            const k = `${Math.round(p.positions[v * 3] * 1e5)},${Math.round(p.positions[v * 3 + 1] * 1e5)},${Math.round(p.positions[v * 3 + 2] * 1e5)}`;
            let id = ids.get(k);
            if (id === undefined) { id = ids.size; ids.set(k, id); }
            out[v] = id;
        }
        return out;
    });
    // Face normals (unit, plus area weight) and, per welded id, the faces around it.
    const faces: { n: Vec3; w: number }[][] = [];
    const around: number[][] = Array.from({ length: ids.size }, () => []);
    const all: { n: Vec3; w: number }[] = [];
    mesh.parts.forEach((p, pi) => {
        const list: { n: Vec3; w: number }[] = [];
        for (let t = 0; t < p.indices.length; t += 3) {
            const a = p.indices[t] * 3, b = p.indices[t + 1] * 3, c = p.indices[t + 2] * 3;
            const pa: Vec3 = [p.positions[a], p.positions[a + 1], p.positions[a + 2]];
            const fn = cross3(sub3([p.positions[b], p.positions[b + 1], p.positions[b + 2]], pa), sub3([p.positions[c], p.positions[c + 1], p.positions[c + 2]], pa));
            const face = { n: normalize3(fn), w: length3(fn) };
            list.push(face);
            const fi = all.length;
            all.push(face);
            for (let k = 0; k < 3; k++) around[vertId[pi][p.indices[t + k]]].push(fi);
        }
        faces.push(list);
    });
    return {
        parts: mesh.parts.map((p, pi) => {
            const out = newPart(p.region);
            // Per source vertex: the corners already emitted for it, reused when the normal matches.
            const emitted = new Map<number, { n: Vec3; v: number }[]>();
            for (let t = 0; t < p.indices.length; t += 3) {
                const face = faces[pi][t / 3];
                const corner: number[] = [];
                for (let k = 0; k < 3; k++) {
                    const i = p.indices[t + k];
                    let sx = 0, sy = 0, sz = 0;
                    for (const fi of around[vertId[pi][i]]) {
                        const f = all[fi];
                        if (f.n[0] * face.n[0] + f.n[1] * face.n[1] + f.n[2] * face.n[2] < cosLimit) continue;
                        sx += f.n[0] * f.w; sy += f.n[1] * f.w; sz += f.n[2] * f.w;
                    }
                    const n = normalize3([sx, sy, sz], face.n);
                    let list = emitted.get(i);
                    if (!list) { list = []; emitted.set(i, list); }
                    let v = -1;
                    for (const e of list) if (e.n[0] * n[0] + e.n[1] * n[1] + e.n[2] * n[2] > 0.99999) { v = e.v; break; }
                    if (v < 0) {
                        v = vertex(out, [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]], n, [p.uvs[i * 2], p.uvs[i * 2 + 1]]);
                        list.push({ n, v });
                    }
                    corner.push(v);
                }
                tri(out, corner[0], corner[1], corner[2]);
            }
            return out;
        }),
    };
}

/** Moves every vertex by `f(position, normal)`, keeping normals (call `recomputeNormals` after a large change). */
export function mapPositions(mesh: Mesh, f: (p: Vec3, n: Vec3) => Vec3): Mesh {
    return {
        parts: mesh.parts.map(p => {
            const positions = p.positions.slice();
            for (let v = 0; v < positions.length; v += 3) {
                const q = f([positions[v], positions[v + 1], positions[v + 2]], [p.normals[v], p.normals[v + 1], p.normals[v + 2]]);
                positions[v] = q[0]; positions[v + 1] = q[1]; positions[v + 2] = q[2];
            }
            return { ...p, positions, normals: p.normals.slice(), uvs: p.uvs.slice(), indices: p.indices.slice() };
        }),
    };
}
