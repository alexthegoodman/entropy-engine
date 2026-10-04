// Mesha houses on Earth's OpenStreetMap buildings.
//
// The Rust side (src/heightfield_landscapes/QuadPlanet/city.rs) streams OpenStreetMap tiles around
// the camera and draws every building as a box (level of detail 2) and every road as a ribbon,
// and it knows which footprints fit our house model: those come back from
// `Entropy.QuadPlanet.buildings` as placements (where, which way the front faces the street,
// width, depth, height, the ground under it, a seed). This module draws those as Mesha houses:
//
// - LOD 0, the nearest few: the full house, interior and all (rooms, stairs, doors), its window
//   glass see-through.
// - LOD 1, out to a few hundred meters: the same evaluation's exterior only, simplified on a Rust
//   thread to a few centimeters of error (Entropy.MeshCache `simplify`): ~5-15k triangles instead
//   of 50-350k.
// - Beyond that, or until a model is ready: the box. The shader folds away the boxes of houses
//   within `hideRadius` of the camera (World uniform), and this module keeps that radius at the
//   nearest house it isn't drawing, so a box only disappears once its house is there.
//
// Every house mesh is cached on disk (Entropy.MeshCache) under its generator version and
// parameter values. Building a house the first time costs a Mesha evaluation (10-150 ms, on this
// thread: the runtime has no workers) - at most one per frame; after that, on any visit, it is a
// disk read. Parameters come from the placement deterministically (its seed picks a style, its
// size is rounded to half meters), so a street of similar houses shares a handful of meshes and a
// place looks the same on every visit.

import { type Vec3, add, distance, scale, sub } from "./qp_math";
import { evaluateObject, objectParamRange, resolveParams, defaultValues, type Evaluation, type ParamValues } from "../mesha/mesha_object";
import { lookupObject } from "../mesha/library";
import houseDef from "../mesha/library/house";

export const HOUSE_NAMESPACE = "quadplanet-houses";
/** Bump when house.ts, the parameter mapping or the packing below changes: old meshes then miss. */
export const HOUSE_GENERATOR = "architecture.house:1";

/** QuadPlanet shader material ids (qp_shader.ts). */
export const MAT_PAINT = 11;
export const MAT_GLOW = 4;
export const MAT_GLASS = 5;
export const MAT_FOUNDATION = 6;
export const MAT_CLEAR_GLASS = 7;

/** Regions only seen from inside: left out of LOD 1. */
export const INTERIOR_REGIONS = new Set(["interior", "ceiling", "floors", "leaf", "treads", "stair"]);

/** LOD 1 simplification: error in meters, and parts smaller than this are dropped. */
export const LOD1_SIMPLIFY = { maxError: 0.05, minFeature: 0.2 };

export interface CityBuilding {
    key: string;
    seed: number;
    kind: "house" | "box";
    anchor: Vec3;
    right: Vec3;
    up: Vec3;
    forward: Vec3;
    width: number;
    depth: number;
    height: number;
    minHeight: number;
    groundMin: number;
    groundMax: number;
    area: number;
    fill: number;
    colour: [number, number, number] | null;
    lat: number;
    lon: number;
    distance: number;
}

/** The house model's size range, for the Rust side's house rule. */
export function houseRule() {
    const values = resolveParams(houseDef, defaultValues(houseDef));
    const range = (id: string, v: ParamValues = values) => objectParamRange(houseDef, houseDef.params.find(p => p.id === id)!, v);
    const oneStorey = resolveParams(houseDef, { ...values, storeys: 1 });
    return {
        minWidth: Math.ceil(range("width")[0] * 10) / 10,
        maxWidth: range("width")[1],
        minDepth: range("depth", oneStorey)[0],
        maxDepth: range("depth")[1],
        maxHeight: 13.5,
        minArea: 40,
        tolerance: 0.08,
    };
}

const STYLES = (houseDef.presets ?? []).map(p => p.values);

/**
 * House parameters for a placement: a style (a preset) picked by its seed, its footprint rounded
 * to half meters, and storeys from its OpenStreetMap height. Deterministic.
 */
export function houseValues(b: Pick<CityBuilding, "seed" | "width" | "depth" | "height">): ParamValues {
    const style = STYLES.length ? STYLES[b.seed % STYLES.length] : {};
    const half = (x: number) => Math.round(x * 2) / 2;
    const width = half(b.width), depth = half(b.depth);
    // A stair needs about 8 m of depth: shallower houses get one storey.
    const storeys = depth < 8 ? 1 : Math.max(1, Math.min(3, Math.round((b.height - 1.5) / 3)));
    return resolveParams(houseDef, { ...style, width, depth, storeys, roofVisible: true, cutaway: 0 });
}

/** Cache key for a house's mesh at a level of detail. */
export function variantKey(values: ParamValues): string {
    const sorted = Object.keys(values).sort().map(k => `${k}=${values[k]}`).join(",");
    return `${HOUSE_GENERATOR}|${sorted}`;
}

/**
 * Where the house's origin (its ground, center of its footprint) goes, and how far its foundation
 * must reach down to meet the lowest ground under it. The floor sits just above the highest
 * ground, so no terrain comes up through it.
 */
export function houseOrigin(b: Pick<CityBuilding, "anchor" | "up" | "groundMin" | "groundMax">, plinth: number): { origin: Vec3; skirt: number } {
    const y0 = Math.max(b.groundMin, b.groundMax - plinth + 0.05);
    return { origin: add(b.anchor, scale(b.up, y0 - b.groundMin)), skirt: y0 - b.groundMin + 0.3 };
}

/** A house evaluation in the QuadPlanet vertex layout (see qp_shader.ts): LOD 0 everything, LOD 1 the outside. */
export function packHouse(e: Evaluation, lod: 0 | 1): { vertexData: Float32Array; indexData: Uint32Array; triangles: number } {
    const parts = e.mesh.parts.filter(p => p.indices.length && (lod === 0 || !INTERIOR_REGIONS.has(p.region)));
    const nv = parts.reduce((n, p) => n + p.positions.length / 3, 0);
    const ni = parts.reduce((n, p) => n + p.indices.length, 0);
    const v = new Float32Array(nv * 12);
    const idx = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const p of parts) {
        const m = e.materials[p.region];
        const color = m?.color ?? [0.7, 0.7, 0.7];
        let material = MAT_PAINT, alpha = 0;
        // Window glass: see-through in a full house (it has rooms to see), opaque and glossy far
        // away, where the LOD has no interior.
        if (m?.clear || m?.transmission) { material = lod === 0 ? MAT_CLEAR_GLASS : MAT_GLASS; alpha = m.clear ?? 0.7; }
        else if (m?.pattern === "glow") material = MAT_GLOW;
        else if (p.region === "foundation") material = MAT_FOUNDATION;
        const base = vo / 12;
        const n = p.positions.length / 3;
        for (let i = 0; i < n; i++) {
            v[vo] = p.positions[i * 3]; v[vo + 1] = p.positions[i * 3 + 1]; v[vo + 2] = p.positions[i * 3 + 2];
            v[vo + 3] = p.normals[i * 3]; v[vo + 4] = p.normals[i * 3 + 1]; v[vo + 5] = p.normals[i * 3 + 2];
            v[vo + 6] = material + 0.5; v[vo + 7] = 0.5;
            v[vo + 8] = color[0]; v[vo + 9] = color[1]; v[vo + 10] = color[2]; v[vo + 11] = alpha;
            vo += 12;
        }
        for (const k of p.indices) idx[io++] = base + k;
    }
    return { vertexData: v, indexData: idx, triangles: ni / 3 };
}

/** The engine calls the city needs (the addon passes Entropy's; tests pass fakes). */
export interface CityEngine {
    buildings: (position: Vec3, radius: number, limit: number) => CityBuilding[];
    status: (namespace: string, key: string) => "ready" | "pending" | "missing";
    put: (namespace: string, key: string, mesh: { vertexData: Float32Array; indexData: Uint32Array; meta?: unknown }, options?: { simplify?: { maxError: number; minFeature?: number }; background?: boolean }) => void;
    /** A cached mesh's real triangle count (after simplification), or null. */
    info: (namespace: string, key: string) => { triangleCount: number } | null;
    createMesh: (namespace: string, key: string, meshId: string, item: string) => boolean;
    clearMesh: (meshId: string) => void;
    createItem: () => string;
    writeItem: (item: string, data: Float32Array) => void;
    destroyItem: (item: string) => void;
    now: () => number;
}

export interface CityOptions {
    /** Full houses (with interiors) within this many meters, at most `maxLod0` of them. */
    lod0Radius: number;
    maxLod0: number;
    /** Exterior-only simplified houses within this many meters. */
    lod1Radius: number;
    /** Triangles all drawn houses may take together. */
    triangleBudget: number;
}

export const DEFAULT_CITY_OPTIONS: CityOptions = { lod0Radius: 45, maxLod0: 8, lod1Radius: 350, triangleBudget: 3_000_000 };

/** Until a mesh's real size is known: typical house triangle counts. */
const ESTIMATE = [150_000, 10_000];

interface Variant {
    values: ParamValues;
    key: string;
    /** Per LOD: what the cache said last, and the mesh's triangle count once known. */
    status: [string | null, string | null];
    triangles: [number, number];
    /** Nearest building wanting it (generation goes nearest first), and which LODs are wanted. */
    want: number;
    wants: [boolean, boolean];
}

interface Shown { lod: 0 | 1; meshId: string; item: string; variant: string; origin: Vec3; skirt: number; building: CityBuilding }

export interface CityHouseStats {
    candidates: number;
    lod0: number;
    lod1: number;
    variants: number;
    generated: number;
    queued: number;
    triangles: number;
    hideRadius: number;
    lastBuildMs: number;
}

export class CityHouses {
    options: CityOptions;
    private candidates: CityBuilding[] = [];
    private queryCenter: Vec3 | null = null;
    private queryRadius = 0;
    private queryVersion = -1;
    private variants = new Map<string, Variant>();
    private variantOf = new Map<string, string>();
    private shown = new Map<string, Shown>();
    private renderOrigin: Vec3 = [0, 0, 0];
    private generated = 0;
    private lastBuildMs = 0;
    hideRadius = 0;
    lastStats: CityHouseStats = { candidates: 0, lod0: 0, lod1: 0, variants: 0, generated: 0, queued: 0, triangles: 0, hideRadius: 0, lastBuildMs: 0 };

    constructor(private engine: CityEngine, options: Partial<CityOptions> = {}) {
        this.options = { ...DEFAULT_CITY_OPTIONS, ...options };
    }

    private variantFor(b: CityBuilding): Variant {
        let vk = this.variantOf.get(b.key);
        if (!vk) {
            const values = houseValues(b);
            vk = variantKey(values);
            this.variantOf.set(b.key, vk);
            if (!this.variants.has(vk)) this.variants.set(vk, { values, key: vk, status: [null, null], triangles: [ESTIMATE[0], ESTIMATE[1]], want: Infinity, wants: [false, false] });
        }
        return this.variants.get(vk)!;
    }

    private meshKey(v: Variant, lod: 0 | 1) { return `${v.key}|lod${lod}`; }

    /** Refreshes what the cache says about a variant's LOD (cheap once it is ready). */
    private ready(v: Variant, lod: 0 | 1): boolean {
        if (v.status[lod] === "ready") return true;
        const s = this.engine.status(HOUSE_NAMESPACE, this.meshKey(v, lod));
        v.status[lod] = s;
        if (s === "ready") {
            const info = this.engine.info(HOUSE_NAMESPACE, this.meshKey(v, lod));
            if (info) v.triangles[lod] = info.triangleCount;
            return true;
        }
        return false;
    }

    /** A wanted LOD that is neither cached nor being made. */
    private needs(v: Variant, lod: 0 | 1): boolean {
        return v.wants[lod] && !this.ready(v, lod) && v.status[lod] !== "pending";
    }

    /**
     * Evaluates a house and caches the LODs it is missing (LOD 1 is simplified on a Rust thread).
     * LOD 0 (megabytes, with every room) is only kept for houses someone has come close to.
     */
    private generate(v: Variant): void {
        const t0 = this.engine.now();
        const e = evaluateObject(houseDef, v.values, lookupObject);
        if (this.needs(v, 0)) {
            const lod0 = packHouse(e, 0);
            this.engine.put(HOUSE_NAMESPACE, this.meshKey(v, 0), { ...lod0, meta: { generator: HOUSE_GENERATOR } }, { background: true });
            v.status[0] = "pending";
            v.triangles[0] = lod0.triangles;
        }
        if (!this.ready(v, 1) && v.status[1] !== "pending") {
            const lod1 = packHouse(e, 1);
            this.engine.put(HOUSE_NAMESPACE, this.meshKey(v, 1), { ...lod1, meta: { generator: HOUSE_GENERATOR, simplifiedFrom: lod1.triangles } }, { simplify: LOD1_SIMPLIFY });
            v.status[1] = "pending";
        }
        this.generated++;
        this.lastBuildMs = this.engine.now() - t0;
    }

    private writeItem(s: Shown): void {
        const b = s.building;
        const t = sub(s.origin, this.renderOrigin);
        this.engine.writeItem(s.item, new Float32Array([
            ...b.right, 0, ...b.up, 0, ...b.forward, 0, t[0], t[1], t[2], 1,
            1, 1, 1, 0,
            0, 0, 0, s.skirt,
        ]));
    }

    private remove(key: string): void {
        const s = this.shown.get(key);
        if (!s) return;
        this.engine.clearMesh(s.meshId);
        this.engine.destroyItem(s.item);
        this.shown.delete(key);
    }

    /** Drops every drawn house (they come back on the next update). */
    clear(): void {
        for (const key of [...this.shown.keys()]) this.remove(key);
        this.candidates = [];
        this.queryCenter = null;
    }

    /**
     * Streams houses around `camera` (world). `cityVersion` changes whenever the city's tiles do
     * (the placements are queried again then). `buildMs`: how long this frame may spend making
     * new house meshes (Infinity: everything now; 0: none). Returns the radius within which the
     * shader should hide house boxes.
     */
    update(camera: Vec3, renderOrigin: Vec3, cityVersion: number, buildMs: number): number {
        const o = this.options;
        const originMoved = renderOrigin.some((x, i) => x !== this.renderOrigin[i]);
        this.renderOrigin = renderOrigin;
        const queryRadius = o.lod1Radius + 80;
        if (!this.queryCenter || cityVersion !== this.queryVersion || distance(camera, this.queryCenter) > 30) {
            const limit = 4000;
            this.candidates = this.engine.buildings(camera, queryRadius, limit).filter(b => b.kind === "house");
            this.queryCenter = camera;
            this.queryVersion = cityVersion;
            // A truncated list only covers out to its farthest building.
            this.queryRadius = this.candidates.length >= limit ? this.candidates[this.candidates.length - 1].distance : queryRadius;
        }
        for (const b of this.candidates) b.distance = distance(camera, b.anchor);
        this.candidates.sort((a, b) => a.distance - b.distance);

        // What each house should be, nearest first, within the triangle budget.
        const want = new Map<string, 0 | 1>();
        let triangles = 0, n0 = 0;
        for (const v of this.variants.values()) { v.want = Infinity; v.wants = [false, false]; }
        for (const b of this.candidates) {
            const v = this.variantFor(b);
            let lod: 0 | 1 | null = null;
            if (b.distance < o.lod0Radius && n0 < o.maxLod0 && triangles + v.triangles[0] <= o.triangleBudget) lod = 0;
            else if (b.distance < o.lod1Radius && triangles + v.triangles[1] <= o.triangleBudget) lod = 1;
            if (lod === null) continue;
            if (lod === 0) n0++;
            triangles += v.triangles[lod];
            want.set(b.key, lod);
            v.want = Math.min(v.want, b.distance);
            v.wants[lod] = true;
        }

        // Make missing meshes, nearest first: one Mesha evaluation per frame at most (each is tens
        // of milliseconds), unless the budget is unlimited.
        const missing = [...this.variants.values()].filter(v => v.want < Infinity && (this.needs(v, 0) || this.needs(v, 1)));
        missing.sort((a, b) => a.want - b.want);
        const started = this.engine.now();
        for (const v of missing) {
            if (buildMs <= 0) break;
            this.generate(v);
            if (buildMs !== Infinity) break;
            if (this.engine.now() - started > buildMs) break;
        }

        // Show what is ready: the wanted LOD, or the other one meanwhile.
        for (const b of this.candidates) {
            const lodWanted = want.get(b.key);
            const current = this.shown.get(b.key);
            if (lodWanted === undefined) { if (current) this.remove(b.key); continue; }
            const v = this.variantFor(b);
            const other: 0 | 1 = lodWanted === 0 ? 1 : 0;
            const lod = this.ready(v, lodWanted) ? lodWanted : this.ready(v, other) && (other === 1 || b.distance < o.lod0Radius * 2) ? other : null;
            if (lod === null) { if (current && current.variant !== v.key) this.remove(b.key); continue; }
            if (current && current.lod === lod && current.variant === v.key) {
                if (originMoved) this.writeItem(current);
                continue;
            }
            const plinth = Number(v.values.plinth ?? 0.5);
            const { origin, skirt } = houseOrigin(b, plinth);
            const meshId = `qp-house:${b.key}:${lod}`;
            const item = current?.item ?? this.engine.createItem();
            const s: Shown = { lod, meshId, item, variant: v.key, origin, skirt, building: b };
            this.writeItem(s);
            if (!this.engine.createMesh(HOUSE_NAMESPACE, this.meshKey(v, lod), meshId, item)) {
                // Evicted from the cache meanwhile: make it again.
                v.status[lod] = null;
                if (!current) this.engine.destroyItem(item);
                continue;
            }
            if (current) this.engine.clearMesh(current.meshId);
            this.shown.set(b.key, s);
        }
        const inList = new Set(this.candidates.map(b => b.key));
        for (const key of [...this.shown.keys()]) if (!inList.has(key)) this.remove(key);

        // Boxes hide inside the nearest house we aren't drawing (and inside what the last
        // placement query is still sure to cover).
        let hide = this.queryRadius - distance(camera, this.queryCenter!);
        for (const b of this.candidates) {
            if (!this.shown.has(b.key)) { hide = Math.min(hide, b.distance); break; }
        }
        this.hideRadius = Math.max(0, hide - 0.01);

        let shownTriangles = 0, lod0 = 0, lod1 = 0;
        for (const s of this.shown.values()) {
            shownTriangles += this.variants.get(s.variant)!.triangles[s.lod];
            if (s.lod === 0) lod0++; else lod1++;
        }
        this.lastStats = {
            candidates: this.candidates.length, lod0, lod1, variants: this.variants.size, generated: this.generated,
            queued: missing.length, triangles: shownTriangles, hideRadius: Math.round(this.hideRadius * 10) / 10, lastBuildMs: Math.round(this.lastBuildMs),
        };
        return this.hideRadius;
    }

    /** True while houses that should be drawn are still being made (for settling captures). */
    busy(): boolean {
        for (const b of this.candidates) {
            if (b.distance >= this.options.lod1Radius) break;
            const s = this.shown.get(b.key);
            if (!s) return true;
            const v = this.variants.get(s.variant)!;
            if (b.distance < this.options.lod0Radius && s.lod !== 0 && v.status[0] !== "ready") return true;
        }
        return false;
    }
}
