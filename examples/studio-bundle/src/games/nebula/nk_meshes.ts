// The few meshes Nebula Kingdom draws everything with, in the engine's `mesh` vertex layout
// (position, normal, uv, color: 12 floats): spheres of several finenesses, a quad for every
// piece of light, and a cone for spines and stings. Shapes come from each instance's matrix.

export interface MeshData { vertexData: Float32Array; indexData: Uint32Array }

function pack(positions: number[], normals: number[], uvs: number[], indices: number[]): MeshData {
    const n = positions.length / 3;
    const v = new Float32Array(n * 12);
    for (let i = 0; i < n; i++) {
        v.set([positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2], uvs[i * 2], uvs[i * 2 + 1], 1, 1, 1, 1], i * 12);
    }
    return { vertexData: v, indexData: new Uint32Array(indices) };
}

/** A unit icosphere (radius 1), subdivided `level` times; `inside` flips it to be seen from within. */
export function icosphere(level: number, inside = false): MeshData {
    const t = (1 + Math.sqrt(5)) / 2;
    let verts: number[][] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    verts = verts.map(v => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; });
    let faces: number[][] = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    for (let l = 0; l < level; l++) {
        const cache = new Map<number, number>();
        const mid = (a: number, b: number): number => {
            const key = a < b ? a * 1e6 + b : b * 1e6 + a;
            const hit = cache.get(key);
            if (hit !== undefined) return hit;
            const m = [verts[a][0] + verts[b][0], verts[a][1] + verts[b][1], verts[a][2] + verts[b][2]];
            const len = Math.hypot(m[0], m[1], m[2]);
            verts.push([m[0] / len, m[1] / len, m[2] / len]);
            cache.set(key, verts.length - 1);
            return verts.length - 1;
        };
        const next: number[][] = [];
        for (const [a, b, c] of faces) {
            const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
            next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
        }
        faces = next;
    }
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
    for (const v of verts) {
        positions.push(v[0], v[1], v[2]);
        normals.push(inside ? -v[0] : v[0], inside ? -v[1] : v[1], inside ? -v[2] : v[2]);
        uvs.push(Math.atan2(v[2], v[0]) / (Math.PI * 2) + 0.5, Math.asin(v[1]) / Math.PI + 0.5);
    }
    for (const [a, b, c] of faces) { if (inside) indices.push(a, c, b); else indices.push(a, b, c); }
    return pack(positions, normals, uvs, indices);
}

/** A quad from -1 to 1 in x and y (the GLOW shader reads its position as the point on the quad). */
export function quad(): MeshData {
    return pack([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 2, 0, 2, 3]);
}

/** A cone: base of radius 1 at z = 0, apex at z = 1. */
export function cone(segments = 10): MeshData {
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
    const slope = Math.SQRT1_2;
    for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2, a1 = ((i + 1) / segments) * Math.PI * 2, am = (a0 + a1) / 2;
        const base = positions.length / 3;
        positions.push(Math.cos(a0), Math.sin(a0), 0, Math.cos(a1), Math.sin(a1), 0, 0, 0, 1);
        normals.push(Math.cos(a0) * slope, Math.sin(a0) * slope, slope, Math.cos(a1) * slope, Math.sin(a1) * slope, slope, Math.cos(am) * slope, Math.sin(am) * slope, slope);
        uvs.push(i / segments, 0, (i + 1) / segments, 0, (i + 0.5) / segments, 1);
        indices.push(base, base + 1, base + 2);
        // The base cap.
        const cap = positions.length / 3;
        positions.push(0, 0, 0, Math.cos(a1), Math.sin(a1), 0, Math.cos(a0), Math.sin(a0), 0);
        normals.push(0, 0, -1, 0, 0, -1, 0, 0, -1);
        uvs.push(0.5, 0.5, 1, 1, 0, 1);
        indices.push(cap, cap + 1, cap + 2);
    }
    return pack(positions, normals, uvs, indices);
}

export const MESHES: Record<string, () => MeshData> = {
    "sphere-5": () => icosphere(5),
    "sphere-4": () => icosphere(4),
    "sphere-3": () => icosphere(3),
    "sphere-2": () => icosphere(2),
    "sphere-1": () => icosphere(1),
    sky: () => icosphere(3, true),
    quad: () => quad(),
    cone: () => cone(),
};
