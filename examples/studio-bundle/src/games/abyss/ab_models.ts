// Mesha objects as The Abyss's meshes: evaluation -> packed vertices (Mesha's own packing, so the
// shader's patterns match Mesha's viewport), levels of detail by vertex clustering, and the few
// shapes that are effects rather than objects (the sky dome, beams, discs, puffs).

import { evaluateObject, type ParamValues, type Evaluation } from "../../apps/mesha/mesha_object";
import { lookupObject } from "../../apps/mesha/library";
import { type Mesh, transformMesh, compose4, mergeByRegion } from "../../apps/mesha/mesha_mesh";
import { packVertices, type RegionMesh } from "../../apps/mesha/mesha_scene";
import { FALLBACK_MATERIAL } from "../../apps/mesha/mesha_materials";
import { sphere, icosphere, cylinder } from "../../apps/mesha/mesha_primitives";
import { PATTERN } from "./ab_shader";

export interface PackedMesh {
    vertexData: Float32Array;
    indexData: Uint32Array;
    /** Bounding sphere in model space: x, y, z, radius. */
    bounds: [number, number, number, number];
    triangles: number;
}

/** Concatenates packed region meshes into one. */
export function concat(parts: { vertexData: ArrayLike<number>; indexData: ArrayLike<number> }[]): PackedMesh {
    let nv = 0, ni = 0;
    for (const p of parts) { nv += p.vertexData.length; ni += p.indexData.length; }
    const vertexData = new Float32Array(nv), indexData = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const p of parts) {
        vertexData.set(p.vertexData as ArrayLike<number>, vo);
        const base = vo / 12;
        for (let i = 0; i < p.indexData.length; i++) indexData[io + i] = p.indexData[i] + base;
        vo += p.vertexData.length; io += p.indexData.length;
    }
    return { vertexData, indexData, bounds: boundsOf(vertexData), triangles: ni / 3 };
}

export function boundsOf(v: Float32Array): [number, number, number, number] {
    let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
    for (let i = 0; i < v.length; i += 12) {
        const x = v[i], y = v[i + 1], z = v[i + 2];
        if (x < lx) lx = x; if (x > hx) hx = x;
        if (y < ly) ly = y; if (y > hy) hy = y;
        if (z < lz) lz = z; if (z > hz) hz = z;
    }
    if (lx === Infinity) return [0, 0, 0, 0];
    return [(lx + hx) / 2, (ly + hy) / 2, (lz + hz) / 2, Math.hypot(hx - lx, hy - ly, hz - lz) / 2];
}

/** A Mesha evaluation packed for the engine (regions merged, materials in the vertices). */
export function packEvaluation(e: Evaluation, keep: (region: string) => boolean = () => true): PackedMesh {
    const parts = mergeByRegion(e.mesh).filter(p => keep(p.region)).map(p => packVertices({
        region: p.region, material: e.materials[p.region] ?? FALLBACK_MATERIAL, positions: p.positions, normals: p.normals, uvs: p.uvs, indices: p.indices,
    } as RegionMesh));
    return concat(parts);
}

/** Evaluates a Mesha library object and packs it. */
export function meshaObject(id: string, values: ParamValues = {}, keep?: (region: string) => boolean): PackedMesh {
    const def = lookupObject(id);
    if (!def) throw new Error(`Abyss: no Mesha object ${id}`);
    return packEvaluation(evaluateObject(def, values, lookupObject), keep);
}

/** Packs a Mesha mesh with one surface pattern and a flat color (effects, the sky). */
export function packPattern(mesh: Mesh, pattern: number, color: [number, number, number] = [1, 1, 1], alpha = 0.5, transform?: number[]): PackedMesh {
    const m = transform ? transformMesh(mesh, transform) : mesh;
    const parts = m.parts.map(p => {
        const n = p.positions.length / 3;
        const v = new Float32Array(n * 12);
        const s = 1 + pattern;
        for (let i = 0; i < n; i++) {
            const o = i * 12;
            v[o] = p.positions[i * 3]; v[o + 1] = p.positions[i * 3 + 1]; v[o + 2] = p.positions[i * 3 + 2];
            v[o + 3] = p.normals[i * 3] * s; v[o + 4] = p.normals[i * 3 + 1] * s; v[o + 5] = p.normals[i * 3 + 2] * s;
            v[o + 6] = p.uvs[i * 2] ?? 0; v[o + 7] = p.uvs[i * 2 + 1] ?? 0;
            v[o + 8] = color[0]; v[o + 9] = color[1]; v[o + 10] = color[2]; v[o + 11] = alpha;
        }
        return { vertexData: v, indexData: p.indices };
    });
    return concat(parts);
}

/** Flips every triangle (a dome seen from inside). */
export function flipWinding(m: PackedMesh): PackedMesh {
    const idx = new Uint32Array(m.indexData.length);
    for (let i = 0; i < idx.length; i += 3) { idx[i] = m.indexData[i]; idx[i + 1] = m.indexData[i + 2]; idx[i + 2] = m.indexData[i + 1]; }
    return { ...m, indexData: idx };
}

/** The sky: a unit dome seen from inside (scaled and centered on the camera each frame). */
export function skyDome(): PackedMesh {
    return flipWinding(packPattern(sphere(1, 48, 24), PATTERN.sky));
}

/** A unit puff (smoke, fireballs, magic): a lumpy icosphere. */
export function puff(pattern: number, color: [number, number, number] = [1, 1, 1]): PackedMesh {
    const m = icosphere(1, 1);
    for (const p of m.parts) for (let i = 0; i < p.positions.length; i += 3) {
        const k = 0.85 + 0.3 * Math.abs(Math.sin(p.positions[i] * 7.1 + p.positions[i + 1] * 3.3) * Math.cos(p.positions[i + 2] * 5.7));
        p.positions[i] *= k; p.positions[i + 1] *= k; p.positions[i + 2] *= k;
    }
    return packPattern(m, pattern, color);
}

/**
 * A light beam: a cone of `segments` sides from the apex at the origin along +Z, unit length and
 * unit end radius (scale it), with uv.x running across (0..1 round each side) and uv.y along.
 * Drawn from both sides.
 */
export function beam(segments = 12): PackedMesh {
    const v: number[] = [], idx: number[] = [];
    const s = 1 + PATTERN.beam;
    for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        const x = Math.cos(a), y = Math.sin(a);
        const u = Math.abs((i / segments) * 2 % 2 - 1);
        v.push(0, 0, 0, x * s, y * s, 0, u, 0, 1, 1, 1, 0.5);
        v.push(x, y, 1, x * s, y * s, 0, u, 1, 1, 1, 1, 0.5);
    }
    for (let i = 0; i < segments; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, b, c, c, b, d, a, c, b, c, d, b);
    }
    return { vertexData: Float32Array.from(v), indexData: Uint32Array.from(idx), bounds: [0, 0, 0.5, 1.2], triangles: idx.length / 3 };
}

/** A vertical ribbon (the waterfall): unit wide (x 0..1 -> uv.x), unit tall (y 0..-1 -> uv.y), bowed out. */
export function ribbon(columns = 16, rows = 24, bow = 0.12): PackedMesh {
    const v: number[] = [], idx: number[] = [];
    const s = 1 + PATTERN.waterfall;
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= columns; i++) {
        const u = i / columns, t = j / rows;
        const x = u - 0.5, y = -t, z = Math.sin(u * Math.PI) * bow * (0.4 + t);
        v.push(x, y, z, 0, 0, s, u, t, 1, 1, 1, 0.5);
    }
    for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
        const a = j * (columns + 1) + i, b = a + 1, c = a + columns + 1, d = c + 1;
        idx.push(a, c, b, b, c, d, a, b, c, b, d, c);
    }
    return { vertexData: Float32Array.from(v), indexData: Uint32Array.from(idx), bounds: [0, -0.5, 0, 0.8], triangles: idx.length / 3 };
}

/** A flat disc (rotor blur) of unit radius in the XZ plane, both sides. */
export function disc(pattern: number, segments = 24): PackedMesh {
    const m = cylinder(1, 0.01, segments);
    return packPattern(m, pattern);
}

/** A ground decal (scorch): a unit disc slightly above y = 0. */
export function decal(): PackedMesh {
    return packPattern(transformMesh(cylinder(1, 0.02, 16), compose4([0, 0.02, 0])), PATTERN.scorch);
}

/** A tracer: a unit box along +Z from 0 to 1, thin. */
export function tracer(): PackedMesh {
    return packPattern(transformMesh(cylinder(0.5, 1, 6), compose4([0, 0, 0], [Math.PI / 2, 0, 0])), PATTERN.tracer);
}

// --- Levels of detail -----------------------------------------------------------------------------

/**
 * A coarser copy by vertex clustering: vertices that share a `cell`-sized cube and a material
 * (color, alpha, pattern) weld into their first member; collapsed triangles go. Normals keep
 * their length (the pattern id) and their direction from the first vertex. Good enough at the
 * distances it is drawn from; it never moves a material boundary more than a cell.
 */
export function cluster(m: PackedMesh, cell: number): PackedMesh {
    const n = m.vertexData.length / 12;
    const remap = new Uint32Array(n);
    const cells = new Map<string, number>();
    const out: number[] = [];
    const v = m.vertexData;
    for (let i = 0; i < n; i++) {
        const o = i * 12;
        const pat = Math.round(Math.hypot(v[o + 3], v[o + 4], v[o + 5]));
        const key = `${Math.floor(v[o] / cell)},${Math.floor(v[o + 1] / cell)},${Math.floor(v[o + 2] / cell)},${pat},${(v[o + 8] * 64) | 0},${(v[o + 9] * 64) | 0},${(v[o + 10] * 64) | 0},${(v[o + 11] * 16) | 0},${Math.floor(v[o + 7] + 0.0005)}`;
        let k = cells.get(key);
        if (k === undefined) {
            k = out.length / 12;
            cells.set(key, k);
            for (let c = 0; c < 12; c++) out.push(v[o + c]);
        }
        remap[i] = k;
    }
    const idx: number[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < m.indexData.length; i += 3) {
        const a = remap[m.indexData[i]], b = remap[m.indexData[i + 1]], c = remap[m.indexData[i + 2]];
        if (a === b || b === c || a === c) continue;
        const key = a < b ? (b < c ? `${a},${b},${c}` : a < c ? `${a},${c},${b}` : `${c},${a},${b}`) : (a < c ? `${b},${a},${c}` : b < c ? `${b},${c},${a}` : `${c},${b},${a}`);
        if (seen.has(key)) continue;
        seen.add(key);
        idx.push(a, b, c);
    }
    const vertexData = Float32Array.from(out);
    return { vertexData, indexData: Uint32Array.from(idx), bounds: m.bounds, triangles: idx.length / 3 };
}

/** Levels of detail: the full mesh and coarser copies at cells scaled to its size. */
export function lods(m: PackedMesh, cells: readonly number[]): PackedMesh[] {
    const out = [m];
    for (const c of cells) out.push(cluster(m, c));
    return out;
}
