// Set dressing: Mesha foliage (trees, conifers, palms, shrubs, grass, flowers) and low-poly street
// props (benches, lamps, bins, barriers, crates, shop kiosks), placed around the buildings of the
// street map and drawn instanced.
//
// - Foliage meshes are evaluated from Mesha's nature library once (on the loading screen, one per
//   frame) and kept in the mesh cache like the houses and people; a simplified level of detail is
//   made on a Rust thread for distance.
// - Placement is deterministic in each building's key: a house always has the same trees in its
//   yard, a shop the same kiosk at its door. Open ground gets sparse stands of trees on a grid
//   anchored to latitude/longitude, so they too stay put across visits.
// - Drawing: every instance of a mesh in one 96 m tile is one instanced draw with a bounding
//   sphere, so tiles out of view are culled by the engine; instances beyond each family's range are
//   skipped, and near ones use full detail. Records are rebuilt only when you move.

import { evaluateObject, type Evaluation } from "../../apps/mesha/mesha_object";
import { lookupObject } from "../../apps/mesha/library";
import type { ParamValues } from "../../apps/mesha/mesha_object";
import { type Rect } from "./al_nav";
import { type ModelMesh, buildBench, buildStreetLamp, buildTrashBin, buildBarrier, buildCrates, buildSandbags, buildKiosk, buildLootCrate, buildMilitary, buildBeacon, buildFlag } from "./al_models";
import { doorSide, fromUV } from "./al_interior";
import { hashString } from "./al_rng";

export const SCATTER_NAMESPACE = "allegiance-scatter";
export const FOLIAGE_GENERATOR = "allegiance-foliage:1";
export const PROP_GENERATOR = "allegiance-props:1";

/** Paint material in the city vertex layout (tinted by the instance's tint). */
const MAT_PAINT = 11;

// --- Foliage meshes ------------------------------------------------------------------------------

export interface FoliageSpec {
    family: string;
    object: string;
    values: ParamValues;
    /** Full detail within this many meters; the simplified mesh beyond, out to `range`. */
    near: number;
    range: number;
}

export const FOLIAGE: FoliageSpec[] = [
    { family: "tree-round", object: "nature.tree", values: { canopy: "clusters", height: 8, levels: 3, crownShape: "round", seed: 5 }, near: 45, range: 320 },
    { family: "tree-oval", object: "nature.tree", values: { canopy: "clusters", height: 11, levels: 3, crownShape: "oval", seed: 11, clusterSize: 1.1 }, near: 45, range: 320 },
    { family: "conifer", object: "nature.conifer", values: { height: 10, whorls: 22, density: 5, seed: 9 }, near: 30, range: 320 },
    { family: "palm", object: "nature.palm", values: {}, near: 35, range: 300 },
    { family: "shrub", object: "nature.shrub", values: { density: 0.6, stems: 5 }, near: 25, range: 140 },
    { family: "grass", object: "nature.grass", values: {}, near: 30, range: 60 },
    { family: "flowers", object: "nature.flowers", values: {}, near: 20, range: 50 },
];

export const foliageSpec = (family: string): FoliageSpec | undefined => FOLIAGE.find(f => f.family === family);

export function foliageKey(spec: FoliageSpec, lod: 0 | 1): string {
    const values = Object.keys(spec.values).sort().map(k => `${k}=${spec.values[k]}`).join(",");
    return `${FOLIAGE_GENERATOR}|${spec.object}|${values}|lod${lod}`;
}

/** Simplification for distant foliage (welded and decimated on a Rust thread). */
export const FOLIAGE_LOD1 = { maxError: 0.12, minFeature: 0.05, targetRatio: 0.12 };

/** A Mesha evaluation in the city vertex layout (position, normal, material, color; opaque). */
export function packFoliage(e: Evaluation): { vertexData: Float32Array; indexData: Uint32Array; triangles: number } {
    const parts = e.mesh.parts.filter(p => p.indices.length);
    const nv = parts.reduce((n, p) => n + p.positions.length / 3, 0);
    const ni = parts.reduce((n, p) => n + p.indices.length, 0);
    const v = new Float32Array(nv * 12);
    const idx = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const p of parts) {
        const color = e.materials[p.region]?.color ?? [0.3, 0.5, 0.25];
        const base = vo / 12;
        for (let i = 0; i < p.positions.length / 3; i++) {
            v[vo] = p.positions[i * 3]; v[vo + 1] = p.positions[i * 3 + 1]; v[vo + 2] = p.positions[i * 3 + 2];
            v[vo + 3] = p.normals[i * 3]; v[vo + 4] = p.normals[i * 3 + 1]; v[vo + 5] = p.normals[i * 3 + 2];
            v[vo + 6] = MAT_PAINT + 0.5; v[vo + 7] = 0.5;
            v[vo + 8] = color[0]; v[vo + 9] = color[1]; v[vo + 10] = color[2]; v[vo + 11] = 0;
            vo += 12;
        }
        for (const k of p.indices) idx[io++] = base + k;
    }
    return { vertexData: v, indexData: idx, triangles: ni / 3 };
}

export type ScatterCache = Pick<MeshCacheAPI, "status" | "put" | "failure">;

/**
 * Makes sure every foliage mesh is cached: at most one Mesha evaluation per call (the loading
 * screen calls it every frame). True once everything is ready or waiting on a background simplify.
 */
export class FoliageMeshes {
    generated = 0;
    private done = false;
    constructor(private cache: ScatterCache, private evaluate = (spec: FoliageSpec) => evaluateObject(lookupObject(spec.object)!, spec.values, lookupObject)) {}
    prepare(): boolean {
        if (this.done) return true;
        for (const spec of FOLIAGE) {
            const k0 = foliageKey(spec, 0), k1 = foliageKey(spec, 1);
            const s0 = this.cache.status(SCATTER_NAMESPACE, k0), s1 = this.cache.status(SCATTER_NAMESPACE, k1);
            if (s0 === "ready" && s1 !== "missing") continue;
            if (s0 === "pending") return false;
            const mesh = packFoliage(this.evaluate(spec));
            this.generated++;
            const meta = { generator: FOLIAGE_GENERATOR, family: spec.family, triangles: mesh.triangles };
            if (s0 !== "ready") this.cache.put(SCATTER_NAMESPACE, k0, { vertexData: mesh.vertexData, indexData: mesh.indexData, meta });
            if (s1 === "missing") this.cache.put(SCATTER_NAMESPACE, k1, { vertexData: mesh.vertexData, indexData: mesh.indexData, meta }, { simplify: FOLIAGE_LOD1 });
            return false;
        }
        this.done = true;
        return true;
    }
}

// --- Prop meshes ---------------------------------------------------------------------------------

export const PROPS: Record<string, () => ModelMesh> = {
    bench: buildBench, lamp: buildStreetLamp, bin: buildTrashBin, barrier: buildBarrier, crates: buildCrates, sandbags: buildSandbags,
    kiosk: buildKiosk, loot: buildLootCrate, beacon: () => buildBeacon(300), flag: buildFlag,
    "mil-hq": () => buildMilitary("hq"), "mil-barracks": () => buildMilitary("barracks"), "mil-depot": () => buildMilitary("depot"),
    "mil-hangar": () => buildMilitary("hangar"), "mil-tower": () => buildMilitary("tower"), "mil-wall": () => buildMilitary("wall"),
};

export const propKey = (name: string): string => `${PROP_GENERATOR}|${name}`;

/** Caches every prop mesh that isn't cached yet (they are small; this is instant). */
export function cacheProps(cache: ScatterCache): number {
    let n = 0;
    for (const [name, build] of Object.entries(PROPS)) {
        if (cache.status(SCATTER_NAMESPACE, propKey(name)) !== "missing") continue;
        const m = build();
        cache.put(SCATTER_NAMESPACE, propKey(name), { vertexData: new Float32Array(m.vertexData), indexData: new Uint32Array(m.indexData), meta: { generator: PROP_GENERATOR } });
        n++;
    }
    return n;
}

// --- Placement -----------------------------------------------------------------------------------

/** One placed thing in the street's local frame. `family` is a FOLIAGE family or a PROPS name. */
export interface ScatterItem {
    family: string; x: number; z: number; yaw: number; scale: number; tint: [number, number, number];
    /** Stretch along the model's x (wall segments). */
    sx?: number;
    /** Height (local y) when not standing on the terrain (a crate on a house floor). */
    y?: number;
    /** Glow boost (tint.w): beacons. */
    glow?: number;
}

export interface ScatterOptions {
    /** Free ground (no building, no water). */
    walkable: (x: number, z: number) => boolean;
    /** Ground kept clear (compounds, the spawn point, your car). */
    reserved?: (x: number, z: number) => boolean;
    /** Palms instead of conifers. */
    tropical?: boolean;
    /** The shop in a building, if any (al_items.shopForBuilding). */
    shopOf?: (r: Rect) => string | null;
    /** Latitude/longitude of the local origin, for the open-ground grid; omitted: no open-ground stands. */
    origin?: { lat: number; lon: number };
    /** Area for open-ground stands: center and half-size (local meters). */
    area?: { x: number; z: number; half: number };
}

const SHOP_TINT: Record<string, [number, number, number]> = { general: [0.2, 0.55, 0.35], gunsmith: [0.75, 0.15, 0.12], garage: [0.2, 0.4, 0.8] };

function rand(seed: number): () => number {
    let h = seed >>> 0;
    return () => { h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0; h = (h ^ (h >>> 12)) >>> 0; h = Math.imul(h ^ (h >>> 15), 0x297a2d39) >>> 0; return ((h ^ (h >>> 15)) >>> 0) / 4294967296; };
}

/** Everything placed around `rects` (deterministic in each building's key). */
export function scatterAround(rects: readonly Rect[], o: ScatterOptions): ScatterItem[] {
    const out: ScatterItem[] = [];
    const free = (x: number, z: number) => o.walkable(x, z) && !(o.reserved?.(x, z) ?? false);
    const put = (family: string, x: number, z: number, yaw: number, scale = 1, tint: [number, number, number] = [1, 1, 1]) => {
        if (free(x, z)) out.push({ family, x, z, yaw, scale, tint });
    };
    const tall = o.tropical ? "palm" : "conifer";
    for (const r of rects) {
        if (r.key.startsWith("al-")) continue;
        const rnd = rand(hashString(`scatter:${r.key}`));
        const side = doorSide(r);
        const facing = Math.atan2(-r.uz * side, r.ux * side);
        if (r.kind === "house") {
            // Back yard: a tree or two; side yards: shrubs; tufts of grass and flowers around.
            const trees = Math.floor(rnd() * 3);
            for (let i = 0; i < trees; i++) {
                const [x, z] = fromUV(r, (rnd() - 0.5) * 1.8 * r.hw, -side * (r.hd + 3 + rnd() * 5));
                const pick = rnd();
                put(pick < 0.3 ? tall : pick < 0.65 ? "tree-round" : "tree-oval", x, z, rnd() * 6.28, 0.75 + rnd() * 0.5, [0.9 + rnd() * 0.2, 0.9 + rnd() * 0.2, 0.9 + rnd() * 0.15]);
            }
            const shrubs = Math.floor(rnd() * 3);
            for (let i = 0; i < shrubs; i++) {
                const s = rnd() < 0.5 ? -1 : 1;
                const [x, z] = fromUV(r, s * (r.hw + 1.1 + rnd() * 0.8), (rnd() - 0.5) * 1.6 * r.hd);
                put("shrub", x, z, rnd() * 6.28, 0.7 + rnd() * 0.6);
            }
            for (let i = 0; i < 3; i++) {
                const [x, z] = fromUV(r, (rnd() - 0.5) * 2.4 * r.hw, -side * (r.hd + 0.8 + rnd() * 2));
                put(rnd() < 0.7 ? "grass" : "flowers", x, z, rnd() * 6.28, 0.8 + rnd() * 0.5);
            }
            continue;
        }
        // Other buildings: shop kiosks at the door, benches, lamps and bins along the front.
        const shop = o.shopOf?.(r) ?? null;
        if (shop) {
            const [x, z] = fromUV(r, Math.min(r.hw - 1.4, 2.8), side * (r.hd + 1.2));
            put("kiosk", x, z, facing, 1, SHOP_TINT[shop] ?? [1, 1, 1]);
        }
        if (rnd() < 0.3) { const [x, z] = fromUV(r, -(r.hw * 0.55), side * (r.hd + 1.1)); put("bench", x, z, facing); }
        if (rnd() < 0.35) { const [x, z] = fromUV(r, (rnd() - 0.5) * 1.6 * r.hw, side * (r.hd + 3.6)); put("lamp", x, z, facing + Math.PI); }
        if (rnd() < 0.2) { const [x, z] = fromUV(r, r.hw * 0.8, side * (r.hd + 0.9)); put("bin", x, z, facing); }
        if (rnd() < 0.12) { const [x, z] = fromUV(r, -side * (r.hw + 1.4), (rnd() - 0.5) * r.hd); put("crates", x, z, rnd() * 6.28); }
        if (rnd() < 0.25) { const [x, z] = fromUV(r, (rnd() < 0.5 ? -1 : 1) * (r.hw + 2.5), -side * (r.hd * 0.5)); put(rnd() < 0.5 ? "tree-round" : "shrub", x, z, rnd() * 6.28, 0.8 + rnd() * 0.3); }
    }
    // Open ground: stands of trees on a lat/lon-anchored grid, only well away from buildings.
    if (o.origin && o.area) {
        const cell = 30, mLat = 110540, mLon = 111320 * Math.cos(o.origin.lat * Math.PI / 180);
        const toLocalXZ = (lat: number, lon: number): [number, number] => [(lon - o.origin!.lon) * mLon, (lat - o.origin!.lat) * mLat];
        const latOf = (z: number) => o.origin!.lat + z / mLat, lonOf = (x: number) => o.origin!.lon + x / mLon;
        const gLat = cell / mLat, gLon = cell / mLon;
        const j0 = Math.floor(latOf(o.area.z - o.area.half) / gLat), j1 = Math.floor(latOf(o.area.z + o.area.half) / gLat);
        const i0 = Math.floor(lonOf(o.area.x - o.area.half) / gLon), i1 = Math.floor(lonOf(o.area.x + o.area.half) / gLon);
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
            const rnd = rand(hashString(`open:${i}:${j}`));
            if (rnd() > 0.4) continue;
            const [x, z] = toLocalXZ((j + rnd()) * gLat, (i + rnd()) * gLon);
            let open = true;
            for (const [dx, dz] of [[0, 0], [9, 0], [-9, 0], [0, 9], [0, -9]]) if (!free(x + dx, z + dz)) { open = false; break; }
            if (!open) continue;
            const n = 1 + Math.floor(rnd() * 3);
            for (let k = 0; k < n; k++) {
                const pick = rnd();
                put(pick < 0.35 ? tall : pick < 0.7 ? "tree-oval" : "tree-round", x + (rnd() - 0.5) * 10, z + (rnd() - 0.5) * 10, rnd() * 6.28, 0.8 + rnd() * 0.6, [0.9 + rnd() * 0.2, 0.9 + rnd() * 0.2, 0.9 + rnd() * 0.15]);
            }
            if (rnd() < 0.5) put("shrub", x + (rnd() - 0.5) * 12, z + (rnd() - 0.5) * 12, rnd() * 6.28, 0.8 + rnd() * 0.5);
        }
    }
    return out;
}

// --- Drawing -------------------------------------------------------------------------------------

/** Meters per culling tile: everything of one mesh in one tile is a single draw with one bounding sphere. */
export const TILE = 96;
/** Props are drawn out to this distance. */
export const PROP_RANGE = 180;

/** Which mesh (cache key) an item draws with from `distance` meters, or null when it is too far. */
export function scatterMesh(family: string, distance: number): string | null {
    const spec = foliageSpec(family);
    if (spec) {
        if (distance > spec.range) return null;
        return foliageKey(spec, distance <= spec.near ? 0 : 1);
    }
    if (!PROPS[family]) return null;
    return distance <= (family === "beacon" ? 6000 : PROP_RANGE) ? propKey(family) : null;
}

/** The batch an item goes in: its mesh and its culling tile. */
export const batchKey = (mesh: string, x: number, z: number): string => `${mesh}#${Math.floor(x / TILE)},${Math.floor(z / TILE)}`;
export const meshOfBatch = (key: string): string => key.slice(0, key.lastIndexOf("#"));
