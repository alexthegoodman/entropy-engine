// A Mesha scene: procedural object instances placed in the world. Each instance keeps its object
// id and parameter values (never baked geometry), so it stays editable; this module turns
// instances into world-space meshes per material for the viewport and for GLB export, and packs
// them into the engine's vertex layout.

import { mat4 } from "gl-matrix";
import { type Mesh, type Vec3, compose4, transformMesh, mergeByRegion } from "./mesha_mesh";
import { type ObjectLookup, type ParamValues, type Evaluation, evaluateObject } from "./mesha_object";
import { type MaterialPreset, FALLBACK_MATERIAL } from "./mesha_materials";
import { browsableObjects } from "./library";
import type { ObjectDef } from "./mesha_object";

export interface Instance {
    id: string;
    objectId: string;
    values: ParamValues;
    position: Vec3;
    /** Degrees about +Y. */
    rotationY: number;
    /** Full gizmo orientation; absent in older, yaw-only scenes. */
    rotation?: [number, number, number, number];
    scale: number;
    name?: string;
}

export interface RegionMesh {
    region: string;
    material: MaterialPreset;
    positions: number[];
    normals: number[];
    uvs: number[];
    indices: number[];
}

export interface BakedInstance {
    id: string;
    evaluation: Evaluation;
    meshes: RegionMesh[];
}

/** Evaluations keyed by object id + values: moving an object never re-runs its generator. */
export class EvaluationCache {
    private entries = new Map<string, Evaluation>();
    constructor(private lookup: ObjectLookup, private capacity = 64) {}
    get(objectId: string, values: ParamValues): Evaluation {
        const key = `${objectId}|${JSON.stringify(values, Object.keys(values).sort())}`;
        let e = this.entries.get(key);
        if (e) { this.entries.delete(key); this.entries.set(key, e); return e; }
        const def = this.lookup(objectId);
        if (!def) throw new Error(`No object "${objectId}"`);
        e = evaluateObject(def, values, this.lookup);
        this.entries.set(key, e);
        while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value as string);
        return e;
    }
}

export function instanceRotation(i: Instance): [number, number, number, number] {
    const half = i.rotationY * Math.PI / 360;
    return i.rotation ?? [0, Math.sin(half), 0, Math.cos(half)];
}

export function instanceMatrix(i: Instance) {
    if (i.rotation) return Array.from(mat4.fromRotationTranslationScale(mat4.create(), i.rotation, i.position, [i.scale, i.scale, i.scale]));
    return compose4(i.position, [0, (i.rotationY * Math.PI) / 180, 0], [i.scale, i.scale, i.scale]);
}

export function bakeInstance(i: Instance, evaluation: Evaluation): BakedInstance {
    const world: Mesh = transformMesh(evaluation.mesh, instanceMatrix(i));
    return {
        id: i.id,
        evaluation,
        meshes: mergeByRegion(world).map(p => ({ region: p.region, material: evaluation.materials[p.region] ?? FALLBACK_MATERIAL, positions: p.positions, normals: p.normals, uvs: p.uvs, indices: p.indices })),
    };
}

export function buildScene(instances: Instance[], lookup: ObjectLookup, cache = new EvaluationCache(lookup)): BakedInstance[] {
    return instances.map(i => bakeInstance(i, cache.get(i.objectId, i.values)));
}

// --- Library search ------------------------------------------------------------------------------

/** How Add Object orders categories; any other category follows, alphabetically. */
export const CATEGORY_ORDER = ["Furniture", "Household", "Architecture", "Mechanical", "Nature"];

/** Browsable objects ranked for `query` (all of them, by category, for an empty query). */
export function searchLibrary(query: string, category?: string): ObjectDef[] {
    const all = browsableObjects().filter(d => !category || d.category === category);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const rank = (c: string) => { const i = CATEGORY_ORDER.indexOf(c); return i < 0 ? CATEGORY_ORDER.length : i; };
    if (!words.length) return all.slice().sort((a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    const phrase = query.toLowerCase().trim();
    const scored = all.map(d => {
        const name = d.name.toLowerCase(), tags = (d.tags ?? []).map(t => t.toLowerCase()), text = `${d.category} ${d.description ?? ""}`.toLowerCase();
        let score = 0;
        if (name === phrase) score += 100;
        if (tags.includes(phrase)) score += 80;
        for (const w of words) {
            if (name.includes(w)) score += 20;
            if (tags.some(t => t.split(/\s+/).includes(w))) score += 12;
            else if (tags.some(t => t.includes(w))) score += 6;
            if (text.includes(w)) score += 3;
        }
        return { d, score };
    });
    return scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score || a.d.name.localeCompare(b.d.name)).map(s => s.d);
}

// --- Engine vertex packing -----------------------------------------------------------------------

/** Pattern ids the viewport shader understands, carried in the normal's length (1 + id). */
export const PATTERN_IDS = { none: 0, wood: 1, fabric: 2, brushed: 3, speckle: 4, glass: 5, foliage: 8, bark: 9, mass: 10 } as const;

/**
 * The engine's `mesh` layout: position(3) normal(3) uv(2) color(4). Color is the material's sRGB
 * base color; alpha packs roughness and a metal flag (metal: 0.5 + 0.49 r, else 0.49 r); the
 * normal's length is 1 + the surface pattern id. The shader unpacks all three.
 */
export function packVertices(mesh: RegionMesh): { vertexData: number[]; indexData: number[] } {
    const m = mesh.material;
    const pattern = m.transmission ? PATTERN_IDS.glass : PATTERN_IDS[m.pattern] ?? 0;
    const alpha = m.metallic > 0.5 ? 0.5 + 0.49 * m.roughness : 0.49 * m.roughness;
    const scale = 1 + pattern;
    const n = mesh.positions.length / 3;
    const vertexData = new Array<number>(n * 12);
    for (let v = 0; v < n; v++) {
        const o = v * 12;
        vertexData[o] = mesh.positions[v * 3]; vertexData[o + 1] = mesh.positions[v * 3 + 1]; vertexData[o + 2] = mesh.positions[v * 3 + 2];
        vertexData[o + 3] = mesh.normals[v * 3] * scale; vertexData[o + 4] = mesh.normals[v * 3 + 1] * scale; vertexData[o + 5] = mesh.normals[v * 3 + 2] * scale;
        vertexData[o + 6] = mesh.uvs[v * 2]; vertexData[o + 7] = mesh.uvs[v * 2 + 1];
        vertexData[o + 8] = m.color[0]; vertexData[o + 9] = m.color[1]; vertexData[o + 10] = m.color[2]; vertexData[o + 11] = alpha;
    }
    return { vertexData, indexData: mesh.indices.slice() };
}

/** A small solid-color RGBA texture for one material, for GLB export's per-mesh texture. */
export function materialTexture(m: MaterialPreset, size = 4): Uint8Array {
    const out = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) out.set([Math.round(m.color[0] * 255), Math.round(m.color[1] * 255), Math.round(m.color[2] * 255), 255], i * 4);
    return out;
}
