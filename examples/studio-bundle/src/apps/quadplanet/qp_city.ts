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
import { InstanceBatches, type InstanceEngine } from "./qp_instances";
import { ITEM_FLOATS, surfaceKind } from "./qp_shader";

export const HOUSE_NAMESPACE = "quadplanet-houses";
/** Bump when house.ts, the parameter mapping or the packing below changes: old meshes then miss. */
export const HOUSE_GENERATOR = "architecture.house:2";

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
export function houseValues(b: Pick<CityBuilding, "seed" | "width" | "depth" | "height">, sizeStep = 0.5): ParamValues {
    const style = STYLES.length ? STYLES[b.seed % STYLES.length] : {};
    const snap = (x: number) => Math.round(x / sizeStep) * sizeStep;
    const width = snap(b.width), depth = snap(b.depth);
    // A stair needs about 8 m of depth: shallower houses get one storey.
    const storeys = depth < 8 ? 1 : Math.max(1, Math.min(3, Math.round((b.height - 1.5) / 3)));
    return resolveParams(houseDef, { ...style, width, depth, storeys, roofVisible: true, cutaway: 0 });
}

/** Cache key for a house's mesh at a level of detail. */
export function variantKey(values: ParamValues, generator = HOUSE_GENERATOR): string {
    const sorted = Object.keys(values).sort().map(k => `${k}=${values[k]}`).join(",");
    return `${generator}|${sorted}`;
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
        // The surface the shader draws on paint (qp_shader.ts surfaceKind): brick, render, tiles...
        const kind = material === MAT_PAINT ? surfaceKind(m?.id) : 0;
        const base = vo / 12;
        const n = p.positions.length / 3;
        for (let i = 0; i < n; i++) {
            v[vo] = p.positions[i * 3]; v[vo + 1] = p.positions[i * 3 + 1]; v[vo + 2] = p.positions[i * 3 + 2];
            v[vo + 3] = p.normals[i * 3]; v[vo + 4] = p.normals[i * 3 + 1]; v[vo + 5] = p.normals[i * 3 + 2];
            v[vo + 6] = material + 0.5; v[vo + 7] = kind + 0.5;
            v[vo + 8] = color[0]; v[vo + 9] = color[1]; v[vo + 10] = color[2]; v[vo + 11] = alpha;
            vo += 12;
        }
        for (const k of p.indices) idx[io++] = base + k;
    }
    return { vertexData: v, indexData: idx, triangles: ni / 3 };
}

/**
 * What CityHouses draws on the map's placements: Mesha houses (HOUSE_MODEL, the default) or any
 * other model that fits a footprint (qp_buildings.ts: city buildings on the remaining boxes).
 */
export interface CityModel {
    /** Which placements it takes ("house" or "box"). */
    kind: "house" | "box";
    namespace: string;
    generator: string;
    /** Instance batch prefix. */
    prefix: string;
    /** Parameter values for a placement, or null to leave it as a box. Deterministic. */
    values: (b: CityBuilding, sizeStep: number) => ParamValues | null;
    evaluate: (values: ParamValues) => Evaluation;
    pack: (e: Evaluation, lod: 0 | 1) => { vertexData: Float32Array; indexData: Uint32Array; triangles: number };
    lod1Simplify: { maxError: number; minFeature?: number };
    /** Typical triangle counts per LOD until the real ones are known. */
    estimate: [number, number];
    /** How far a model may be stretched to its real footprint (and height: [min, max] or null for none). */
    maxFit: number;
    fitHeight: ((b: CityBuilding, values: ParamValues) => number) | null;
    /** Evaluations may go to the house worker (qp_house_worker.ts evaluates houses only). */
    background: boolean;
}

export const HOUSE_MODEL: CityModel = {
    kind: "house", namespace: HOUSE_NAMESPACE, generator: HOUSE_GENERATOR, prefix: "qp-houses",
    values: (b, step) => houseValues(b, step),
    evaluate: values => evaluateObject(houseDef, values, lookupObject),
    pack: packHouse, lod1Simplify: LOD1_SIMPLIFY, estimate: [150_000, 10_000], maxFit: 0.12, fitHeight: null, background: true,
};

/** The engine calls the city needs (the addon passes Entropy's; tests pass fakes). */
export interface CityEngine {
    buildings: (position: Vec3, radius: number, limit: number) => CityBuilding[];
    status: (namespace: string, key: string) => "ready" | "pending" | "missing";
    put: (namespace: string, key: string, mesh: { vertexData: Float32Array; indexData: Uint32Array; meta?: unknown }, options?: { simplify?: { maxError: number; minFeature?: number }; background?: boolean }) => void;
    /** A cached mesh's real triangle count (after simplification), or null. */
    info: (namespace: string, key: string) => { triangleCount: number } | null;
    /**
     * Instanced batches of HOUSE_NAMESPACE meshes: `createMesh(key, ...)` spawns cache key `key`
     * with a pipeline drawing ITEM_FLOATS records per instance (qp_shader.ts instancedShader).
     */
    instances: InstanceEngine;
    /**
     * Optional: evaluates and caches a house off this thread (qp_house_worker.ts through
     * Entropy.Worker). Returns a job handle, or null to evaluate here instead.
     */
    generateInBackground?: (job: HouseJob) => number | null;
    /** A background job's state; "failed" falls back to evaluating that house here. */
    pollBackground?: (job: number) => "pending" | "done" | "failed" | "unknown";
    now: () => number;
}

/** A house to evaluate and cache: its parameter values and the cache keys/LODs wanted. */
export interface HouseJob { values: ParamValues; lod0Key: string | null; lod1Key: string | null }

export interface CityOptions {
    /** Full houses (with interiors) within this many meters, at most `maxLod0` of them. */
    lod0Radius: number;
    maxLod0: number;
    /** Exterior-only simplified houses within this many meters. */
    lod1Radius: number;
    /** Triangles all drawn houses may take together. */
    triangleBudget: number;
    /** With a finite build budget, at least this long between Mesha evaluations (each holds its
     * frame for tens of milliseconds): a hitch now and then rather than a run of slow frames. */
    minBuildIntervalMs: number;
    /**
     * Footprints snap to this step (meters) before choosing a house, and each house is stretched
     * to its real footprint (a few percent). Coarser steps make more buildings share one house
     * mesh: fewer evaluations, fewer cached meshes, bigger instanced batches.
     */
    sizeStep: number;
    /**
     * A finished street is chosen again only once the camera has moved this far (meters) since
     * the last choice: re-sorting thousands of candidates for every centimeter of a walk changes
     * nothing a player could see. Meanwhile the hide radius shrinks by the distance moved.
     */
    reselectDistance: number;
    /** ...and, when the camera keeps moving (a car), not more often than this (ms) unless it has
     * gone ten times `reselectDistance`. 0: no time limit. */
    reselectMs: number;
}

export const DEFAULT_CITY_OPTIONS: CityOptions = { lod0Radius: 45, maxLod0: 8, lod1Radius: 350, triangleBudget: 3_000_000, minBuildIntervalMs: 0, sizeStep: 0.5, reselectDistance: 1, reselectMs: 0 };

/** Background house evaluations queued at once (the worker runs them one by one). */
const MAX_IN_FLIGHT = 4;



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

interface Shown { lod: 0 | 1; variant: string; origin: Vec3; skirt: number; fit: [number, number, number]; building: CityBuilding }

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
    /** Instanced draws (one per house mesh in view range) and their instances. */
    batches: number;
    instances: number;
    /** Evaluations handed to a background worker. */
    background: number;
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
    private lastBuildAt = -Infinity;
    /** Where the last full update ran, and whether it left every wanted house drawn at its
     * wanted level of detail with nothing to make: then a still camera needs no work at all. */
    private lastCamera: Vec3 | null = null;
    private lastSelectAt = -Infinity;
    private settled = false;
    hideRadius = 0;
    lastStats: CityHouseStats = { candidates: 0, lod0: 0, lod1: 0, variants: 0, generated: 0, queued: 0, triangles: 0, hideRadius: 0, lastBuildMs: 0, batches: 0, instances: 0, background: 0 };
    private batches: InstanceBatches;
    /** The drawn set changed (or moved with the render origin) since the batches were written. */
    private dirty = false;
    private backgroundJobs = 0;
    /** Variants being evaluated in the background (variant key -> job). */
    private inFlight = new Map<string, number>();
    /** Variants whose background evaluation failed: evaluated here from then on. */
    private foreground = new Set<string>();
    /** The last background failure, for the stats. */
    lastBackgroundError: string | null = null;

    constructor(private engine: CityEngine, options: Partial<CityOptions> = {}, readonly model: CityModel = HOUSE_MODEL) {
        this.options = { ...DEFAULT_CITY_OPTIONS, ...options };
        this.batches = new InstanceBatches(engine.instances, ITEM_FLOATS, {
            prefix: model.prefix, idleFrames: 1,
            // Evicted from the cache meanwhile: make it again.
            onMissing: key => {
                const i = key.lastIndexOf("|lod");
                const v = this.variants.get(key.slice(0, i));
                if (v) v.status[Number(key.slice(i + 4)) as 0 | 1] = null;
                this.settled = false;
                for (const [k, sh] of this.shown) if (sh.variant === key.slice(0, i)) this.shown.delete(k);
            },
        });
    }

    private variantFor(b: CityBuilding): Variant {
        let vk = this.variantOf.get(b.key);
        if (!vk) {
            const values = this.model.values(b, this.options.sizeStep)!;
            vk = variantKey(values, this.model.generator);
            this.variantOf.set(b.key, vk);
            if (!this.variants.has(vk)) this.variants.set(vk, { values, key: vk, status: [null, null], triangles: [this.model.estimate[0], this.model.estimate[1]], want: Infinity, wants: [false, false] });
        }
        return this.variants.get(vk)!;
    }

    private meshKey(v: Variant, lod: 0 | 1) { return `${v.key}|lod${lod}`; }

    /** Refreshes what the cache says about a variant's LOD (cheap once it is ready). */
    private ready(v: Variant, lod: 0 | 1): boolean {
        if (v.status[lod] === "ready") return true;
        const s = this.engine.status(this.model.namespace, this.meshKey(v, lod));
        v.status[lod] = s;
        if (s === "ready") {
            const info = this.engine.info(this.model.namespace, this.meshKey(v, lod));
            if (info) v.triangles[lod] = info.triangleCount;
            return true;
        }
        return false;
    }

    /** A wanted LOD that is neither cached nor being made. */
    private needs(v: Variant, lod: 0 | 1): boolean {
        return v.wants[lod] && !this.inFlight.has(v.key) && !this.ready(v, lod) && v.status[lod] !== "pending";
    }

    /** Collects finished background evaluations. */
    private pollBackground(): void {
        for (const [key, job] of this.inFlight) {
            const state = this.engine.pollBackground?.(job) ?? "unknown";
            if (state === "pending") continue;
            this.inFlight.delete(key);
            const v = this.variants.get(key);
            if (state === "failed" || state === "unknown") {
                this.foreground.add(key);
                this.lastBackgroundError = `${state}: ${key}`;
                if (v) v.status = [null, null];
            }
        }
    }

    /**
     * Evaluates a house and caches the LODs it is missing (LOD 1 is simplified on a Rust thread).
     * LOD 0 (megabytes, with every room) is only kept for houses someone has come close to.
     */
    private generate(v: Variant): void {
        const t0 = this.engine.now();
        const lod0Key = this.needs(v, 0) ? this.meshKey(v, 0) : null;
        const lod1Key = !this.ready(v, 1) && v.status[1] !== "pending" ? this.meshKey(v, 1) : null;
        const job = this.foreground.has(v.key) || !this.model.background ? null : this.engine.generateInBackground?.({ values: v.values, lod0Key, lod1Key }) ?? null;
        if (job !== null) {
            // The worker puts the meshes into the cache; until the job is over this variant is
            // neither re-made nor counted missing (needs() checks inFlight).
            this.inFlight.set(v.key, job);
            this.backgroundJobs++;
            this.lastBuildMs = this.engine.now() - t0;
            return;
        }
        const m = this.model;
        const e = m.evaluate(v.values);
        if (this.needs(v, 0)) {
            const lod0 = m.pack(e, 0);
            this.engine.put(m.namespace, this.meshKey(v, 0), { ...lod0, meta: { generator: m.generator } }, { background: true });
            v.status[0] = "pending";
            v.triangles[0] = lod0.triangles;
        }
        if (!this.ready(v, 1) && v.status[1] !== "pending") {
            const lod1 = m.pack(e, 1);
            this.engine.put(m.namespace, this.meshKey(v, 1), { ...lod1, meta: { generator: m.generator, simplifiedFrom: lod1.triangles } }, { simplify: m.lod1Simplify });
            v.status[1] = "pending";
        }
        this.generated++;
        this.lastBuildMs = this.engine.now() - t0;
    }

    /** Rewrites every batch from the drawn set: one record (an Item) per house. */
    private writeBatches(): void {
        this.batches.begin();
        for (const s of this.shown.values()) {
            const b = s.building;
            const t = sub(s.origin, this.renderOrigin);
            const [fx, fz, fy] = s.fit;
            // Center and radius of the house, generously (roof, porch, foundation skirt).
            const h = b.height * fy + 6;
            const c = add(t, scale(b.up, h / 2 - s.skirt / 2));
            const r = 0.5 * Math.hypot(b.width * 1.2, b.depth * 1.3, h + s.skirt) + 2;
            const { data, offset: o } = this.batches.add(this.meshKey(this.variants.get(s.variant)!, s.lod), [c[0], c[1], c[2], r]);
            data[o] = b.right[0] * fx; data[o + 1] = b.right[1] * fx; data[o + 2] = b.right[2] * fx; data[o + 3] = 0;
            data[o + 4] = b.up[0] * fy; data[o + 5] = b.up[1] * fy; data[o + 6] = b.up[2] * fy; data[o + 7] = 0;
            data[o + 8] = b.forward[0] * fz; data[o + 9] = b.forward[1] * fz; data[o + 10] = b.forward[2] * fz; data[o + 11] = 0;
            data[o + 12] = t[0]; data[o + 13] = t[1]; data[o + 14] = t[2]; data[o + 15] = 1;
            // Neighbours sharing a mesh still differ: a tone (lighter, darker, warmer, cooler) and
            // where the surface patterns and weathering fall (tex_origin.xz; y stays 0, the
            // shader reads height above the ground from it).
            const r1 = (Math.imul(b.seed | 0, 0x9e3779b1) >>> 0) / 4294967296, r2 = (Math.imul((b.seed | 0) ^ 0x5bd1e995, 0x85ebca6b) >>> 0) / 4294967296;
            const tone = 0.9 + 0.17 * r1, warm = (r2 - 0.5) * 0.08;
            data[o + 16] = tone * (1 + warm); data[o + 17] = tone; data[o + 18] = tone * (1 - warm); data[o + 19] = 0;
            data[o + 20] = (b.seed % 61) * 3.1; data[o + 21] = 0; data[o + 22] = (b.seed % 47) * 2.3; data[o + 23] = s.skirt;
        }
        this.batches.flush();
        this.dirty = false;
    }

    private remove(key: string): void {
        if (this.shown.delete(key)) this.dirty = true;
    }

    /** Drops every drawn house (they come back on the next update). */
    clear(): void {
        this.shown.clear();
        this.batches.clear();
        this.dirty = false;
        this.candidates = [];
        this.queryCenter = null;
        this.settled = false;
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
        // Standing still (or nearly) in a finished street: the selection, and so everything below,
        // would come out the same (it sorted thousands of candidates and checked caches every frame).
        // Unlimited budgets (settling, fixed-step runs) keep exact selections.
        if (this.settled && !originMoved && cityVersion === this.queryVersion && this.lastCamera) {
            const moved = distance(camera, this.lastCamera);
            const exact = buildMs === Infinity;
            const soon = !exact && o.reselectMs > 0 && this.engine.now() - this.lastSelectAt < o.reselectMs && moved < o.reselectDistance * 10;
            if (moved < (exact ? 0.05 : o.reselectDistance) || soon) return Math.max(0, this.hideRadius - moved);
        }
        this.lastCamera = camera;
        this.lastSelectAt = this.engine.now();
        this.renderOrigin = renderOrigin;
        const queryRadius = o.lod1Radius + 80;
        let requeried = false;
        if (!this.queryCenter || cityVersion !== this.queryVersion || distance(camera, this.queryCenter) > 30) {
            requeried = true;
            const limit = 4000;
            this.candidates = this.engine.buildings(camera, queryRadius, limit).filter(b => b.kind === this.model.kind && this.model.values(b, this.options.sizeStep) !== null);
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

        // Make missing meshes, nearest first. Here: one Mesha evaluation per frame at most (each
        // is tens of milliseconds), unless the budget is unlimited. In the background: a few
        // jobs in flight, whatever the frame budget, since they cost this thread nothing.
        this.pollBackground();
        const missing = [...this.variants.values()].filter(v => v.want < Infinity && (this.needs(v, 0) || this.needs(v, 1)));
        missing.sort((a, b) => a.want - b.want);
        const started = this.engine.now();
        const throttled = buildMs !== Infinity && started - this.lastBuildAt < o.minBuildIntervalMs;
        const background = !!this.engine.generateInBackground && buildMs !== Infinity;
        for (const v of missing) {
            if (buildMs <= 0) break;
            if (background && !this.foreground.has(v.key)) {
                if (this.inFlight.size >= MAX_IN_FLIGHT) continue;
            } else if (throttled) break;
            this.generate(v);
            if (this.inFlight.has(v.key)) continue;
            this.lastBuildAt = this.engine.now();
            if (buildMs !== Infinity) break;
            if (this.engine.now() - started > buildMs) break;
        }

        // Show what is ready: the wanted LOD, or the other one meanwhile.
        let complete = missing.length === 0;
        for (const b of this.candidates) {
            const lodWanted = want.get(b.key);
            const current = this.shown.get(b.key);
            if (lodWanted === undefined) { if (current) this.remove(b.key); continue; }
            const v = this.variantFor(b);
            const other: 0 | 1 = lodWanted === 0 ? 1 : 0;
            const lod = this.ready(v, lodWanted) ? lodWanted : this.ready(v, other) && (other === 1 || b.distance < o.lod0Radius * 2) ? other : null;
            if (lod !== lodWanted) complete = false;
            if (lod === null) { if (current && current.variant !== v.key) this.remove(b.key); continue; }
            if (current && current.lod === lod && current.variant === v.key) continue;
            const plinth = Number(v.values.plinth ?? 0.5);
            const { origin, skirt } = houseOrigin(b, plinth);
            // Stretch the (snapped) house over the building's real footprint.
            const maxFit = this.model.maxFit;
            const fit = (real: number, model: unknown) => {
                const m = Number(model);
                return m > 0 ? Math.min(1 + maxFit, Math.max(1 - maxFit, real / m)) : 1;
            };
            this.shown.set(b.key, { lod, variant: v.key, origin, skirt, fit: [fit(b.width, v.values.width), fit(b.depth, v.values.depth), this.model.fitHeight?.(b, v.values) ?? 1], building: b });
            this.dirty = true;
        }
        this.settled = complete;
        // Only a new placement query can leave drawn houses out of the candidates.
        if (requeried) {
            const inList = new Set(this.candidates.map(b => b.key));
            for (const key of [...this.shown.keys()]) if (!inList.has(key)) this.remove(key);
        }
        if (this.dirty || originMoved) this.writeBatches();

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
            batches: this.batches.lastStats.drawnBatches, instances: this.batches.lastStats.instances, background: this.backgroundJobs,
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
