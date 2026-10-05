// Mesha city buildings on Earth's OpenStreetMap footprints that are not houses: offices,
// apartment blocks, shops, civic halls and warehouses (Mesha's architecture.city_block), drawn by
// CityHouses (qp_city.ts) with this model in place of the box the map would otherwise show.
//
// - Style: from the building's height and footprint, and its seed: towers are glass offices or
//   concrete blocks, big low sheds warehouses, the rest tenements, stucco apartments, concrete
//   blocks and the odd civic hall. Deterministic, so a street looks the same on every visit.
// - Size: the footprint snaps to `sizeStep` (similar buildings share one mesh and one instanced
//   draw) and the model is stretched to the real footprint; storeys come from the map's height,
//   and the model is stretched a little in height to meet it.
// - Glazing is opaque, glossy glass (MAT_GLASS): these buildings have no rooms to see into.
// - The box city.rs draws for a ground-standing building (uv.y's integer part 2) is folded away
//   within the radius these models have taken over (World uniform city.z, qp_shader.ts).

import { evaluateObject, resolveParams, defaultValues, type Evaluation, type ParamValues } from "../mesha/mesha_object";
import { lookupObject } from "../mesha/library";
import cityBlock from "../mesha/library/city_block";
import { type CityBuilding, type CityModel, MAT_PAINT, MAT_GLOW, MAT_GLASS, MAT_FOUNDATION } from "./qp_city";
import { surfaceKind } from "./qp_shader";

export const BUILDING_NAMESPACE = "quadplanet-buildings";
/** Bump when city_block.ts, the mapping or the packing changes: old meshes then miss. */
export const BUILDING_GENERATOR = "architecture.city_block:3";

const PRESETS = new Map((cityBlock.presets ?? []).map(p => [p.name, p.values]));
const preset = (name: string): ParamValues => PRESETS.get(name) ?? {};

/** Footprints outside this are left as boxes (sheds, and the giant footprints of malls and plants). */
export const BUILDING_SIZE = { min: 3, max: 140 };

/** The style a building gets: by height, footprint and seed. */
export function buildingStyle(b: Pick<CityBuilding, "seed" | "width" | "depth" | "height">): string {
    const area = b.width * b.depth;
    const r = b.seed % 100;
    if (b.height >= 30) return r < 55 ? "Glass office" : "Concrete block";
    if (area > 1400 && b.height < 14) return "Warehouse";
    if (area < 60 && b.height < 6) return "Warehouse";
    if (b.height >= 18) return r < 30 ? "Concrete block" : r < 62 ? "Brick tenement" : r < 78 ? "Stucco apartments" : "Glass office";
    if (r < 36) return "Brick tenement";
    if (r < 64) return "Stucco apartments";
    if (r < 86) return "Concrete block";
    return "Civic stone";
}

/** Storeys for a height (meters), with the style's ground and upper storey heights. */
export function storeysFor(height: number, ground: number, storey: number): number {
    return Math.max(1, Math.min(40, Math.round((height - ground) / storey) + 1));
}

/** City building parameters for a placement (null: leave the box). Deterministic. */
export function buildingValues(b: Pick<CityBuilding, "seed" | "width" | "depth" | "height" | "minHeight">, sizeStep = 2): ParamValues | null {
    if (b.minHeight > 0 || b.height < 2.5) return null;
    if (Math.min(b.width, b.depth) < BUILDING_SIZE.min || Math.max(b.width, b.depth) > BUILDING_SIZE.max) return null;
    const style = buildingStyle(b);
    const base = resolveParams(cityBlock, { ...defaultValues(cityBlock), ...preset(style) });
    const snap = (x: number) => Math.max(BUILDING_SIZE.min, Math.round(x / sizeStep) * sizeStep);
    const ground = Number(base.groundHeight), storey = Number(base.floorHeight);
    const floors = storeysFor(b.height, ground, storey);
    // Small buildings: fewer, lower storeys look right; a shop floor needs a few meters of front.
    const width = snap(b.width), depth = snap(b.depth);
    const values: ParamValues = { ...preset(style), width, depth, floors, seed: 1 + (b.seed % 7) };
    if (width < 7 && values.ground === "shops") values.ground = "lobby";
    return resolveParams(cityBlock, { ...defaultValues(cityBlock), ...values });
}

/** The model's height for its values (ground storey, upper storeys and the roof slab). */
export function modelHeight(values: ParamValues): number {
    return Number(values.groundHeight) + Math.max(0, Number(values.floors) - 1) * Number(values.floorHeight) + 0.3;
}

/** Packs a city building in the QuadPlanet vertex layout; LOD 1 drops the window frames' smallest parts on simplification. */
export function packBuilding(e: Evaluation, _lod: 0 | 1): { vertexData: Float32Array; indexData: Uint32Array; triangles: number } {
    const parts = e.mesh.parts.filter(p => p.indices.length);
    const nv = parts.reduce((n, p) => n + p.positions.length / 3, 0);
    const ni = parts.reduce((n, p) => n + p.indices.length, 0);
    const v = new Float32Array(nv * 12);
    const idx = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const p of parts) {
        const m = e.materials[p.region];
        const color = m?.color ?? [0.7, 0.7, 0.7];
        let material = MAT_PAINT, alpha = 0;
        if (m?.clear || m?.transmission || p.region === "glass") { material = MAT_GLASS; alpha = 0.7; }
        else if (m?.pattern === "glow") material = MAT_GLOW;
        else if (p.region === "foundation") material = MAT_FOUNDATION;
        // Glazing reads darker than the glass color (the dim rooms behind it).
        const k = material === MAT_GLASS ? 0.55 : 1;
        // The surface the shader draws on paint (qp_shader.ts surfaceKind): brick, render, tiles...
        const kind = material === MAT_PAINT ? surfaceKind(m?.id) : 0;
        const base = vo / 12;
        for (let i = 0; i < p.positions.length / 3; i++) {
            v[vo] = p.positions[i * 3]; v[vo + 1] = p.positions[i * 3 + 1]; v[vo + 2] = p.positions[i * 3 + 2];
            v[vo + 3] = p.normals[i * 3]; v[vo + 4] = p.normals[i * 3 + 1]; v[vo + 5] = p.normals[i * 3 + 2];
            v[vo + 6] = material + 0.5; v[vo + 7] = kind + 0.5;
            v[vo + 8] = color[0] * k; v[vo + 9] = color[1] * k; v[vo + 10] = color[2] * k; v[vo + 11] = alpha;
            vo += 12;
        }
        for (const q of p.indices) idx[io++] = base + q;
    }
    return { vertexData: v, indexData: idx, triangles: ni / 3 };
}

export const BUILDING_MODEL: CityModel = {
    kind: "box", namespace: BUILDING_NAMESPACE, generator: BUILDING_GENERATOR, prefix: "qp-buildings",
    values: (b, step) => buildingValues(b, step),
    evaluate: values => evaluateObject(cityBlock, values, lookupObject),
    pack: packBuilding,
    // Far away a building keeps its window grid, sills and cornices; welding and small errors
    // take the triangles out.
    lod1Simplify: { maxError: 0.04, minFeature: 0.04 },
    estimate: [15_000, 3_000],
    // Snapped sizes are close; the stretch covers the rest so the model meets its neighbours.
    maxFit: 0.35,
    fitHeight: (b, values) => Math.max(0.8, Math.min(1.5, b.height / modelHeight(values))),
    background: false,
};
