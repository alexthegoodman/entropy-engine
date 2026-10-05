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
import { resolveParams, defaultValues, type ParamValues } from "../../apps/mesha/mesha_object";
import { packBuilding } from "../../apps/quadplanet/qp_buildings";
import { type Rect } from "./al_nav";
import { type ModelMesh, buildBench, buildStreetLamp, buildTrashBin, buildBarrier, buildCrates, buildSandbags, buildKiosk, buildLootCrate, buildMilitary, buildBeacon, buildFlag } from "./al_models";
import { doorSide, fromUV } from "./al_interior";
import { hashString } from "./al_rng";

export const SCATTER_NAMESPACE = "allegiance-scatter";
export const FOLIAGE_GENERATOR = "allegiance-foliage:3";
export const PROP_GENERATOR = "allegiance-props:3";

/** Paint material in the city vertex layout (tinted by the instance's tint). */
const MAT_PAINT = 11;
/** Foliage: paint that the wind bends (al_shader.ts). */
const MAT_FOLIAGE = 17;
/** Mesha plant regions that are leaves, blades or petals: they flutter and let the sun through. */
const LEAFY = new Set(["leaves", "grass", "plumes", "flowers", "centers", "petals", "center", "dead"]);

// --- Mesha meshes: plants and furniture ----------------------------------------------------------

export interface FoliageSpec {
    family: string;
    object: string;
    values: ParamValues;
    /** Full detail within `near` meters; LOD 1 out to `mid` (default: `range`); LOD 2 out to `range`. */
    near: number;
    mid?: number;
    range: number;
    /**
     * Parameter overrides for the distance meshes, evaluated from the same seed (the same trunk and
     * limbs): fewer, larger leaves. Without one, a LOD is the full mesh simplified.
     */
    lod1?: ParamValues;
    lod2?: ParamValues;
}

export type FoliageLod = 0 | 1 | 2;

/** A library preset's values (empty if it is missing). */
const preset = (object: string, name: string): ParamValues => ({ ...(lookupObject(object)?.presets?.find(p => p.name === name)?.values ?? {}) });

/** Distance LODs for a broadleaf tree: the same limbs (same seed and branching), fewer and larger leaves. */
const TREE_LOD1: ParamValues = { density: 6, leafSize: 0.5 };
const TREE_LOD2: ParamValues = { density: 3, leafSize: 0.75 };

export const FOLIAGE: FoliageSpec[] = [
    // Broadleaf trees: Mesha's full-leaf trees (thousands of leaves near you).
    { family: "tree-oak", object: "nature.tree", values: { ...preset("nature.tree", "English oak"), leafSize: 0.42, leafShape: "ovate", seed: 5 }, near: 32, mid: 120, range: 380, lod1: { ...TREE_LOD1, leafSize: 0.62 }, lod2: { ...TREE_LOD2, leafSize: 0.9 } },
    { family: "tree-maple", object: "nature.tree", values: { ...preset("nature.tree", "Autumn maple"), leafFinish: "leaf.green", variety: 0.6, seed: 21 }, near: 32, mid: 120, range: 380, lod1: TREE_LOD1, lod2: TREE_LOD2 },
    { family: "tree-birch", object: "nature.tree", values: { ...preset("nature.tree", "Silver birch"), seed: 12 }, near: 32, mid: 120, range: 380, lod1: { ...TREE_LOD1, leafSize: 0.3 }, lod2: { ...TREE_LOD2, leafSize: 0.5 } },
    { family: "conifer", object: "nature.conifer", values: { height: 10, whorls: 22, density: 5, seed: 9 }, near: 30, mid: 120, range: 380 },
    { family: "palm", object: "nature.palm", values: {}, near: 35, mid: 120, range: 340 },
    // Understory.
    { family: "shrub", object: "nature.shrub", values: { density: 0.6, stems: 5 }, near: 25, range: 150 },
    { family: "boxwood", object: "nature.shrub", values: preset("nature.shrub", "Boxwood ball"), near: 22, range: 130 },
    { family: "hydrangea", object: "nature.shrub", values: preset("nature.shrub", "Hydrangea"), near: 22, range: 120 },
    { family: "fern", object: "nature.fern", values: {}, near: 18, range: 70 },
    { family: "rock", object: "nature.rock", values: {}, near: 30, range: 160 },
    { family: "grass", object: "nature.grass", values: {}, near: 30, range: 70 },
    { family: "flowers", object: "nature.flowers", values: {}, near: 20, range: 55 },
    // Ground cover on open ground near you (lawnAround): short lawn patches, longer meadow grass
    // and the odd clump of poppies or daisies. Light meshes (about 4,000 triangles a patch).
    { family: "lawn", object: "nature.grass", values: { clumps: 12, patchRadius: 0.75, blades: 12, height: 0.13, heightVariation: 0.5, bladeWidth: 0.011, clumpRadius: 0.1, lean: 30, curl: 30, tipTint: 0.25, grassFinish: "grass.lawn", seed: 3 }, near: 14, range: 40 },
    { family: "meadow", object: "nature.grass", values: { clumps: 9, patchRadius: 0.75, blades: 14, height: 0.26, heightVariation: 0.5, bladeWidth: 0.011, clumpRadius: 0.11, lean: 35, curl: 40, tipTint: 0.45, grassFinish: "grass.meadow", seed: 4 }, near: 14, range: 45 },
    { family: "poppies", object: "nature.flowers", values: preset("nature.flowers", "Poppies"), near: 14, range: 45 },
    { family: "daisies", object: "nature.flowers", values: { seed: 6 }, near: 14, range: 45 },
    // Furniture: cafe sets on the pavement, dining sets and plants inside houses.
    { family: "cafe-table", object: "furniture.table", values: preset("furniture.table", "Bistro round"), near: 20, range: 90 },
    { family: "cafe-chair", object: "furniture.office_chair", values: preset("furniture.office_chair", "Scandinavian"), near: 18, range: 80 },
    { family: "dining-table", object: "furniture.table", values: { ...preset("furniture.table", "Bistro round"), width: 0.9, topFinish: "wood.oak", legFinish: "wood.walnut" }, near: 20, range: 60 },
    { family: "dining-chair", object: "furniture.office_chair", values: { ...preset("furniture.office_chair", "Scandinavian"), upholstery: "fabric.olive" }, near: 18, range: 60 },
    { family: "potted-plant", object: "household.potted_plant", values: {}, near: 18, range: 70 },
    { family: "table-lamp", object: "household.table_lamp", values: {}, near: 15, range: 40 },
];

export const foliageSpec = (family: string): FoliageSpec | undefined => FOLIAGE.find(f => f.family === family);

/** Every broadleaf tree family (temperate streets, yards and stands). */
export const BROADLEAF = ["tree-oak", "tree-maple", "tree-birch"];

/** The parameter values a LOD is evaluated with. */
export function foliageValues(spec: FoliageSpec, lod: FoliageLod): ParamValues {
    const o = lod === 1 ? spec.lod1 : lod === 2 ? spec.lod2 : undefined;
    return o ? { ...spec.values, ...o } : spec.values;
}

export function foliageKey(spec: FoliageSpec, lod: FoliageLod): string {
    const values = Object.keys(spec.values).sort().map(k => `${k}=${spec.values[k]}`).join(",");
    return `${FOLIAGE_GENERATOR}|${spec.object}|${values}|lod${lod}`;
}

/** Simplification for distant foliage (welded and decimated on a Rust thread). */
export const FOLIAGE_LOD1 = { maxError: 0.12, minFeature: 0.05, targetRatio: 0.12 };
export const FOLIAGE_LOD2 = { maxError: 0.3, minFeature: 0.12, targetRatio: 0.05 };

/** Plants move in the wind; rocks, furniture and potted plants (often indoors) do not. */
export const sways = (spec: FoliageSpec): boolean => spec.object.startsWith("nature.") && spec.object !== "nature.rock";

/**
 * How far (m) a point `y` meters up a plant `height` tall bends in a full gust: nothing at the
 * root, growing with the square of the height, more for taller plants (a tree's crown a third of
 * a meter, a grass tip a few centimeters).
 */
export function bendAt(y: number, height: number): number {
    if (height <= 0) return 0;
    const k = Math.min(0.5, 0.06 + height * 0.025);
    const h = Math.max(0, Math.min(1, y / height));
    return Math.min(0.98, k * h * h);
}

/**
 * A Mesha evaluation in the city vertex layout (position, normal, material, color; opaque). With
 * `wind`, it is foliage (material 17): uv.y carries the bend (fraction) and a leaf flag (integer).
 */
export function packFoliage(e: Evaluation, wind = false): { vertexData: Float32Array; indexData: Uint32Array; triangles: number } {
    const parts = e.mesh.parts.filter(p => p.indices.length);
    let height = 0;
    if (wind) for (const p of parts) for (let i = 1; i < p.positions.length; i += 3) height = Math.max(height, p.positions[i]);
    const nv = parts.reduce((n, p) => n + p.positions.length / 3, 0);
    const ni = parts.reduce((n, p) => n + p.indices.length, 0);
    const v = new Float32Array(nv * 12);
    const idx = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const p of parts) {
        const color = e.materials[p.region]?.color ?? [0.3, 0.5, 0.25];
        const leaf = wind && LEAFY.has(p.region) ? 1 : 0;
        const base = vo / 12;
        for (let i = 0; i < p.positions.length / 3; i++) {
            v[vo] = p.positions[i * 3]; v[vo + 1] = p.positions[i * 3 + 1]; v[vo + 2] = p.positions[i * 3 + 2];
            v[vo + 3] = p.normals[i * 3]; v[vo + 4] = p.normals[i * 3 + 1]; v[vo + 5] = p.normals[i * 3 + 2];
            if (wind) { v[vo + 6] = MAT_FOLIAGE + 0.5; v[vo + 7] = leaf + bendAt(p.positions[i * 3 + 1], height); }
            else { v[vo + 6] = MAT_PAINT + 0.5; v[vo + 7] = 0.5; }
            v[vo + 8] = color[0]; v[vo + 9] = color[1]; v[vo + 10] = color[2]; v[vo + 11] = 0;
            vo += 12;
        }
        for (const k of p.indices) idx[io++] = base + k;
    }
    return { vertexData: v, indexData: idx, triangles: ni / 3 };
}

export type ScatterCache = Pick<MeshCacheAPI, "status" | "put" | "failure">;

/**
 * Makes sure every Mesha mesh is cached: at most one evaluation per call (the loading screen calls
 * it every frame). LOD 0 is the evaluation itself; a LOD with parameter overrides is evaluated
 * again (same seed, fewer and larger leaves) and simplified; one without is the LOD 0 evaluation
 * simplified. True once everything is ready or waiting on a background simplify.
 */
export class FoliageMeshes {
    generated = 0;
    private done = false;
    constructor(private cache: ScatterCache, private evaluate = (spec: FoliageSpec, values: ParamValues) => evaluateObject(lookupObject(spec.object)!, values, lookupObject)) {}
    prepare(): boolean {
        if (this.done) return true;
        for (const spec of FOLIAGE) {
            const lods = foliageLods(spec);
            const status = lods.map(l => this.cache.status(SCATTER_NAMESPACE, foliageKey(spec, l)));
            if (status[0] === "pending") return false;
            const missing = lods.filter((_, i) => status[i] === "missing");
            if (!missing.length) continue;
            // The LOD whose values this evaluation uses: its own overrides, or LOD 0's.
            const source = (l: FoliageLod): FoliageLod => (l === 0 || (l === 1 ? spec.lod1 : spec.lod2) ? l : 0);
            const from = source(missing[0]);
            const mesh = packFoliage(this.evaluate(spec, foliageValues(spec, from)), sways(spec));
            this.generated++;
            const meta = { generator: FOLIAGE_GENERATOR, family: spec.family, triangles: mesh.triangles };
            for (const l of missing) {
                if (source(l) !== from) continue;
                const simplify = l === 1 ? FOLIAGE_LOD1 : l === 2 ? FOLIAGE_LOD2 : null;
                this.cache.put(SCATTER_NAMESPACE, foliageKey(spec, l), { vertexData: mesh.vertexData, indexData: mesh.indexData, meta }, simplify ? { simplify } : undefined);
            }
            return false;
        }
        this.done = true;
        return true;
    }
}

/** The LODs a family is drawn with: three when it has a middle distance, else two. */
export const foliageLods = (spec: FoliageSpec): FoliageLod[] => (spec.mid !== undefined && spec.mid < spec.range ? [0, 1, 2] : [0, 1]);

// --- Prop meshes ---------------------------------------------------------------------------------

/**
 * A compound building from Mesha's city building (architecture.city_block): a preset at the
 * structure's size, turned so its door faces -Z like the compound layout expects.
 */
export function meshaBuilding(presetName: string, values: ParamValues): ModelMesh {
    const def = lookupObject("architecture.city_block")!;
    const e = evaluateObject(def, resolveParams(def, { ...defaultValues(def), ...preset("architecture.city_block", presetName), ...values }), lookupObject);
    const packed = packBuilding(e, 0);
    const v = Array.from(packed.vertexData);
    // Half a turn about +Y: x and z (positions and normals) change sign.
    for (let i = 0; i < v.length; i += 12) { v[i] = -v[i]; v[i + 2] = -v[i + 2]; v[i + 3] = -v[i + 3]; v[i + 5] = -v[i + 5]; }
    return { vertexData: v, indexData: Array.from(packed.indexData) };
}

export const PROPS: Record<string, () => ModelMesh> = {
    bench: buildBench, lamp: buildStreetLamp, bin: buildTrashBin, barrier: buildBarrier, crates: buildCrates, sandbags: buildSandbags,
    kiosk: buildKiosk, loot: buildLootCrate, beacon: () => buildBeacon(300), flag: buildFlag,
    // Compound buildings: Mesha city buildings at the layout's sizes (al_military.ts SIZES).
    "mil-hq": () => meshaBuilding("Barracks", { width: 14, depth: 10, floors: 2, groundHeight: 3.8, floorHeight: 3.2, rooftop: "stair", parapet: 0.9, pilaster: 0.2, windowWidth: 0.4 }),
    "mil-barracks": () => meshaBuilding("Barracks", { width: 18, depth: 7, floors: 1, groundHeight: 4.2, rooftop: "plant" }),
    "mil-depot": () => meshaBuilding("Warehouse", { width: 11, depth: 11, floors: 1, groundHeight: 5.2, facadeFinish: "masonry.darkConcrete", trimFinish: "masonry.concrete" }),
    "mil-hangar": () => meshaBuilding("Warehouse", { width: 16, depth: 14, floors: 1, groundHeight: 6.2, facadeFinish: "metal.corrugatedGreen", bayWidth: 5 }),
    "mil-tower": () => buildMilitary("tower"), "mil-wall": () => buildMilitary("wall"),
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
    /** The roads (OpenStreetMap center lines and widths): nothing grows or stands on them. */
    roads?: RoadMask;
}

/** A stretch of road in the local frame: its center line from a to b, and half its paved width. */
export interface RoadSegment { ax: number; az: number; bx: number; bz: number; half: number; street?: boolean }

/** Road surfaces for quick "is this on a road?" checks: segments hashed into 16 m cells. */
export class RoadMask {
    private cells = new Map<number, RoadSegment[]>();
    static readonly CELL = 16;
    readonly segments: number;
    readonly list: readonly RoadSegment[];
    constructor(segments: readonly RoadSegment[]) {
        this.list = segments;
        const c = RoadMask.CELL;
        for (const sg of segments) {
            const pad = sg.half + 3;
            const i0 = Math.floor((Math.min(sg.ax, sg.bx) - pad) / c), i1 = Math.floor((Math.max(sg.ax, sg.bx) + pad) / c);
            const j0 = Math.floor((Math.min(sg.az, sg.bz) - pad) / c), j1 = Math.floor((Math.max(sg.az, sg.bz) + pad) / c);
            if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4096) continue;
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
                const k = RoadMask.key(i, j);
                const list = this.cells.get(k);
                if (list) list.push(sg); else this.cells.set(k, [sg]);
            }
        }
        this.segments = segments.length;
    }
    private static key(i: number, j: number): number { return (i + 32768) * 65536 + (j + 32768); }
    /** True when (x, z) is on a road's surface, or within `margin` meters of its edge (margin up to 3 m). */
    covers(x: number, z: number, margin = 0): boolean {
        const list = this.cells.get(RoadMask.key(Math.floor(x / RoadMask.CELL), Math.floor(z / RoadMask.CELL)));
        if (!list) return false;
        for (const sg of list) {
            const dx = sg.bx - sg.ax, dz = sg.bz - sg.az, l2 = dx * dx + dz * dz;
            const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - sg.ax) * dx + (z - sg.az) * dz) / l2)) : 0;
            const ex = x - (sg.ax + dx * t), ez = z - (sg.az + dz * t);
            const r = sg.half + margin;
            if (ex * ex + ez * ez <= r * r) return true;
        }
        return false;
    }
}

/** Road segments from polylines in the local frame (`toLocal` maps a [lat, lon] point). */
export function roadSegments(roads: readonly { points: [number, number][]; width: number; street?: boolean }[], toLocal: (lat: number, lon: number) => [number, number]): RoadSegment[] {
    const out: RoadSegment[] = [];
    for (const r of roads) {
        const pts = r.points.map(([lat, lon]) => toLocal(lat, lon));
        for (let i = 1; i < pts.length; i++) out.push({ ax: pts[i - 1][0], az: pts[i - 1][1], bx: pts[i][0], bz: pts[i][1], half: r.width / 2, street: r.street ?? true });
    }
    return out;
}

/** How far from a road's edge each kind of thing keeps (meters): trunks well back, small things just off it. */
export function roadMargin(family: string): number {
    if (family.startsWith("tree") || family === "conifer" || family === "palm") return 1.8;
    if (family === "shrub") return 1;
    if (foliageSpec(family)) return 0.3;
    return 0.4;
}

const SHOP_TINT: Record<string, [number, number, number]> = { general: [0.2, 0.55, 0.35], gunsmith: [0.75, 0.15, 0.12], garage: [0.2, 0.4, 0.8] };

function rand(seed: number): () => number {
    let h = seed >>> 0;
    return () => { h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0; h = (h ^ (h >>> 12)) >>> 0; h = Math.imul(h ^ (h >>> 15), 0x297a2d39) >>> 0; return ((h ^ (h >>> 15)) >>> 0) / 4294967296; };
}

/** Street trees stand this far apart along a road (meters), this far out from its edge. */
export const STREET_TREE_SPACING = 13;
export const STREET_TREE_SETBACK = 2.6;

/** Everything placed around `rects` (deterministic in each building's key). */
export function scatterAround(rects: readonly Rect[], o: ScatterOptions): ScatterItem[] {
    const out: ScatterItem[] = [];
    const free = (x: number, z: number) => o.walkable(x, z) && !(o.reserved?.(x, z) ?? false);
    const put = (family: string, x: number, z: number, yaw: number, scale = 1, tint: [number, number, number] = [1, 1, 1]) => {
        if (free(x, z) && !(o.roads?.covers(x, z, roadMargin(family)) ?? false)) out.push({ family, x, z, yaw, scale, tint });
    };
    const leafTint = (rnd: () => number): [number, number, number] => [0.9 + rnd() * 0.2, 0.9 + rnd() * 0.2, 0.9 + rnd() * 0.15];
    const tall = o.tropical ? "palm" : "conifer";
    /** A tree for a yard, a stand or a street: mostly broadleaf, with the climate's tall tree mixed in. */
    const pickTree = (rnd: () => number, tallShare: number): string => {
        const p = rnd();
        if (p < tallShare) return tall;
        if (o.tropical) return p < 0.75 ? "palm" : BROADLEAF[Math.floor(rnd() * BROADLEAF.length)];
        return BROADLEAF[Math.floor(rnd() * BROADLEAF.length)];
    };
    for (const r of rects) {
        if (r.key.startsWith("al-")) continue;
        const rnd = rand(hashString(`scatter:${r.key}`));
        const side = doorSide(r);
        const facing = Math.atan2(-r.uz * side, r.ux * side);
        if (r.kind === "house") {
            // Back yard: one to three trees; side yards: shrubs and hedges; front: a flower bed;
            // grass, ferns and flowers around.
            const trees = 1 + Math.floor(rnd() * 3);
            for (let i = 0; i < trees; i++) {
                const [x, z] = fromUV(r, (rnd() - 0.5) * 1.8 * r.hw, -side * (r.hd + 3 + rnd() * 6));
                put(pickTree(rnd, 0.25), x, z, rnd() * 6.28, 0.75 + rnd() * 0.5, leafTint(rnd));
            }
            const shrubs = 1 + Math.floor(rnd() * 3);
            for (let i = 0; i < shrubs; i++) {
                const s = rnd() < 0.5 ? -1 : 1;
                const [x, z] = fromUV(r, s * (r.hw + 1.1 + rnd() * 0.8), (rnd() - 0.5) * 1.6 * r.hd);
                const k = rnd();
                put(k < 0.5 ? "shrub" : k < 0.8 ? "boxwood" : "hydrangea", x, z, rnd() * 6.28, 0.7 + rnd() * 0.6);
            }
            if (rnd() < 0.6) { const [x, z] = fromUV(r, (rnd() < 0.5 ? -1 : 1) * r.hw * 0.6, side * (r.hd + 1.2)); put(rnd() < 0.5 ? "hydrangea" : "boxwood", x, z, rnd() * 6.28, 0.8 + rnd() * 0.3); }
            for (let i = 0; i < 6; i++) {
                const [x, z] = fromUV(r, (rnd() - 0.5) * 2.6 * r.hw, -side * (r.hd + 0.8 + rnd() * 3));
                const k = rnd();
                put(k < 0.55 ? "grass" : k < 0.8 ? "flowers" : "fern", x, z, rnd() * 6.28, 0.8 + rnd() * 0.5);
            }
            continue;
        }
        // Other buildings: shop kiosks at the door, cafe tables, planters, benches, lamps and bins
        // along the front.
        const shop = o.shopOf?.(r) ?? null;
        if (shop) {
            const [x, z] = fromUV(r, Math.min(r.hw - 1.4, 2.8), side * (r.hd + 1.2));
            put("kiosk", x, z, facing, 1, SHOP_TINT[shop] ?? [1, 1, 1]);
        }
        if (r.hw > 4 && rnd() < 0.28) {
            // A cafe: a table or two on the pavement, two or three chairs at each.
            const tables = 1 + Math.floor(rnd() * 2);
            for (let t = 0; t < tables; t++) {
                const [x, z] = fromUV(r, -r.hw * 0.5 + t * 2.4, side * (r.hd + 1.9));
                if (!free(x, z) || (o.roads?.covers(x, z, 0.8) ?? false)) continue;
                put("cafe-table", x, z, rnd() * 6.28);
                const seats = 2 + Math.floor(rnd() * 2);
                for (let c = 0; c < seats; c++) {
                    const a = facing + (c / seats) * Math.PI * 2 + rnd() * 0.3;
                    // Chairs face the table (their front is +Z).
                    put("cafe-chair", x + Math.sin(a) * 0.62, z + Math.cos(a) * 0.62, a + Math.PI);
                }
            }
        }
        if (rnd() < 0.4) { const [x, z] = fromUV(r, (rnd() < 0.5 ? -1 : 1) * Math.min(r.hw - 0.6, 2), side * (r.hd + 0.6)); put("potted-plant", x, z, rnd() * 6.28, 1.4 + rnd() * 0.4); }
        if (rnd() < 0.3) { const [x, z] = fromUV(r, -(r.hw * 0.55), side * (r.hd + 1.1)); put("bench", x, z, facing); }
        if (rnd() < 0.35) { const [x, z] = fromUV(r, (rnd() - 0.5) * 1.6 * r.hw, side * (r.hd + 3.6)); put("lamp", x, z, facing + Math.PI); }
        if (rnd() < 0.2) { const [x, z] = fromUV(r, r.hw * 0.8, side * (r.hd + 0.9)); put("bin", x, z, facing); }
        if (rnd() < 0.12) { const [x, z] = fromUV(r, -side * (r.hw + 1.4), (rnd() - 0.5) * r.hd); put("crates", x, z, rnd() * 6.28); }
        if (rnd() < 0.45) { const [x, z] = fromUV(r, (rnd() < 0.5 ? -1 : 1) * (r.hw + 2.5), -side * (r.hd * 0.5)); put(rnd() < 0.6 ? pickTree(rnd, 0.15) : "shrub", x, z, rnd() * 6.28, 0.8 + rnd() * 0.3, leafTint(rnd)); }
    }
    // Street trees: a row along each side of town streets, on the verge just off the road.
    if (o.roads && o.origin) {
        const mLat = 110540, mLon = 111320 * Math.cos(o.origin.lat * Math.PI / 180);
        for (const sg of o.roads.list) {
            if (!sg.street || sg.half * 2 > 11) continue;
            const dx = sg.bx - sg.ax, dz = sg.bz - sg.az, len = Math.hypot(dx, dz);
            if (len < 4) continue;
            const ux = dx / len, uz = dz / len;
            for (let t = STREET_TREE_SPACING / 2; t < len; t += STREET_TREE_SPACING) {
                for (const s of [-1, 1]) {
                    const off = sg.half + STREET_TREE_SETBACK;
                    const x = sg.ax + ux * t - uz * off * s, z = sg.az + uz * t + ux * off * s;
                    if (o.area && (Math.abs(x - o.area.x) > o.area.half || Math.abs(z - o.area.z) > o.area.half)) continue;
                    // Deterministic in where it stands on Earth, not in the order roads arrive.
                    const rnd = rand(hashString(`street:${Math.round((o.origin.lat + z / mLat) * 1e5)}:${Math.round((o.origin.lon + x / mLon) * 1e5)}`));
                    if (rnd() < 0.3) continue;
                    put(pickTree(rnd, 0.08), x, z, rnd() * 6.28, 0.7 + rnd() * 0.35, leafTint(rnd));
                }
            }
        }
    }
    // Open ground: stands of trees with an understory on a lat/lon-anchored grid, only well away
    // from buildings.
    if (o.origin && o.area) {
        const cell = 22, mLat = 110540, mLon = 111320 * Math.cos(o.origin.lat * Math.PI / 180);
        const toLocalXZ = (lat: number, lon: number): [number, number] => [(lon - o.origin!.lon) * mLon, (lat - o.origin!.lat) * mLat];
        const latOf = (z: number) => o.origin!.lat + z / mLat, lonOf = (x: number) => o.origin!.lon + x / mLon;
        const gLat = cell / mLat, gLon = cell / mLon;
        const j0 = Math.floor(latOf(o.area.z - o.area.half) / gLat), j1 = Math.floor(latOf(o.area.z + o.area.half) / gLat);
        const i0 = Math.floor(lonOf(o.area.x - o.area.half) / gLon), i1 = Math.floor(lonOf(o.area.x + o.area.half) / gLon);
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
            const rnd = rand(hashString(`open:${i}:${j}`));
            if (rnd() > 0.55) continue;
            const [x, z] = toLocalXZ((j + rnd()) * gLat, (i + rnd()) * gLon);
            let open = true;
            for (const [dx, dz] of [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]]) if (!free(x + dx, z + dz)) { open = false; break; }
            if (!open) continue;
            const n = 2 + Math.floor(rnd() * 4);
            for (let k = 0; k < n; k++) put(pickTree(rnd, 0.3), x + (rnd() - 0.5) * 12, z + (rnd() - 0.5) * 12, rnd() * 6.28, 0.8 + rnd() * 0.6, leafTint(rnd));
            const under = 2 + Math.floor(rnd() * 4);
            for (let k = 0; k < under; k++) {
                const f = rnd();
                put(f < 0.35 ? "shrub" : f < 0.6 ? "fern" : f < 0.85 ? "grass" : "rock", x + (rnd() - 0.5) * 14, z + (rnd() - 0.5) * 14, rnd() * 6.28, 0.7 + rnd() * 0.6);
            }
        }
    }
    return out;
}

/** Ground cover is planted on this grid (meters), anchored to latitude/longitude. */
export const LAWN_CELL = 2.4;
/** ...within this distance of you (it is replanted as you move). */
export const LAWN_RADIUS = 46;

/**
 * Ground cover around (cx, cz): on open ground (no building within a meter, no road, not
 * reserved) a lat/lon-anchored grid of lawn patches, meadow grass in drifts, and now and then a
 * clump of wildflowers. Deterministic in where each cell is on Earth, so walking away and back
 * finds the same grass.
 */
export function lawnAround(cx: number, cz: number, o: ScatterOptions & { origin: { lat: number; lon: number } }, radius = LAWN_RADIUS): ScatterItem[] {
    const out: ScatterItem[] = [];
    const mLat = 110540, mLon = 111320 * Math.cos(o.origin.lat * Math.PI / 180);
    const gLat = LAWN_CELL / mLat, gLon = LAWN_CELL / mLon;
    const latOf = (z: number) => o.origin.lat + z / mLat, lonOf = (x: number) => o.origin.lon + x / mLon;
    const j0 = Math.floor(latOf(cz - radius) / gLat), j1 = Math.floor(latOf(cz + radius) / gLat);
    const i0 = Math.floor(lonOf(cx - radius) / gLon), i1 = Math.floor(lonOf(cx + radius) / gLon);
    const clear = (x: number, z: number) => o.walkable(x, z) && !(o.reserved?.(x, z) ?? false)
        && o.walkable(x + 1, z) && o.walkable(x - 1, z) && o.walkable(x, z + 1) && o.walkable(x, z - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const rnd = rand(hashString(`lawn:${i}:${j}`));
        const x = ((i + rnd()) * gLon - o.origin.lon) * mLon, z = ((j + rnd()) * gLat - o.origin.lat) * mLat;
        if ((x - cx) ** 2 + (z - cz) ** 2 > radius * radius) continue;
        const p = rnd();
        if (p > 0.82) continue;
        if (!clear(x, z) || (o.roads?.covers(x, z, 0.5) ?? false)) continue;
        // Drifts: meadow grass where a slow hash of the cell's neighbourhood says so.
        const drift = rand(hashString(`drift:${Math.floor(i / 5)}:${Math.floor(j / 5)}`))();
        const family = p < 0.025 ? "poppies" : p < 0.05 ? "daisies" : drift < 0.35 ? "meadow" : "lawn";
        const g = 0.9 + rnd() * 0.2;
        out.push({ family, x, z, yaw: rnd() * 6.28, scale: family === "lawn" || family === "meadow" ? 1 + rnd() * 0.6 : 0.85 + rnd() * 0.5, tint: [g * (0.95 + rnd() * 0.12), g, g * (0.9 + rnd() * 0.12)] });
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
        if (distance <= spec.near) return foliageKey(spec, 0);
        return foliageKey(spec, foliageLods(spec).length === 3 && distance > spec.mid! ? 2 : 1);
    }
    if (!PROPS[family]) return null;
    return distance <= (family === "beacon" ? 6000 : PROP_RANGE) ? propKey(family) : null;
}

/** The batch an item goes in: its mesh and its culling tile. */
export const batchKey = (mesh: string, x: number, z: number): string => `${mesh}#${Math.floor(x / TILE)},${Math.floor(z / TILE)}`;
export const meshOfBatch = (key: string): string => key.slice(0, key.lastIndexOf("#"));
