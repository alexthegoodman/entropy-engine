// Which Mesha model stands for each planned thing, and how it is sized to the plan.
//
// The Planner says "an inn, an L-shaped footprint of 18 x 14 m, two floors, facing the street";
// the Detailer turns that into Mesha procedural objects (a house per wing of the L, 2 storeys,
// sized to each wing), so a level is detailed from the moment it is opened. Designers then pick
// another model for one building or for every inn, shape it with its Mesha controls, or vary it.
//
// Resolution order for a planned thing: its own binding's model, then its kind's model in the
// world's detail (`models["structure:inn"]`), then the genre default here.

import type { CodexCategory, GameWorld, GenreType, SpotType, StructureKind, WorldStructure } from "../game_planner/planner_types";
import { localParts } from "../game_planner/town_planning";
import { lookupObject } from "../mesha/library";
import { resolveParams, type ParamValues } from "../mesha/mesha_object";
import type { ModelChoice, ScatterLayer, GroundMaterial } from "./detail_types";

export const choice = (objectId: string, values: ParamValues = {}, presetName?: string): ModelChoice => ({ objectId, values, ...(presetName ? { presetName } : {}) });

/** Things drawn from simple generated geometry rather than a library object. */
export type BuiltinKind = "wall" | "well" | "dock" | "marker";

// -------------------------------------------------------------------------------------------------
// Defaults by genre
// -------------------------------------------------------------------------------------------------

type KindTable = Partial<Record<StructureKind, ModelChoice>>;

const FANTASY: KindTable = {
    house: choice("architecture.house", { wallFinish: "masonry.whitewash", roofFinish: "roofing.slate", trimFinish: "wood.oak", porch: "none" }),
    shop: choice("architecture.arcane_emporium"),
    inn: choice("architecture.house", { wallFinish: "masonry.fieldstone", trimFinish: "wood.walnut", porch: "veranda", chimneys: 2 }),
    farmhouse: choice("architecture.house", { wallFinish: "masonry.stucco", roofFinish: "roofing.slate", porch: "veranda", storeys: 1 }),
    smithy: choice("architecture.house", { wallFinish: "masonry.fieldstone", chimneys: 1, porch: "none", dormers: 0 }),
    workshop: choice("architecture.house", { wallFinish: "wood.weathered", porch: "none", dormers: 0 }),
    barn: choice("architecture.house", { wallFinish: "wood.weathered", roofFinish: "roofing.slate", porch: "none", dormers: 0, chimneys: 0, pitch: 48 }),
    hall: choice("architecture.city_block", { floors: 2 }),
    barracks: choice("architecture.city_block", { floors: 2 }),
    warehouse: choice("architecture.city_block", { floors: 1 }),
    keep: choice("architecture.city_block", { floors: 4 }),
    gate: choice("architecture.city_block", { floors: 3 }),
    temple: choice("architecture.dome_building"),
    tower: choice("architecture.cave_dwelling", { tiers: 3, roof: "cone", roofFinish: "roofing.slate" }),
    mill: choice("architecture.cave_dwelling", { tiers: 2, roof: "cone" }),
};

const SCIFI: KindTable = {
    house: choice("architecture.hab_lodge"),
    shop: choice("architecture.hab_lodge", { decks: 1 }),
    inn: choice("architecture.hab_lodge", { decks: 2 }, "Mars outpost inn"),
    farmhouse: choice("architecture.hab_lodge", { decks: 1 }),
    temple: choice("architecture.dome_building"),
    tower: choice("architecture.city_block", { floors: 6 }),
    mill: choice("architecture.dome_building"),
};

const POSTAPOC: KindTable = {
    house: choice("architecture.wasteland_depot", { bays: 3 }),
    shop: choice("architecture.wasteland_depot", { bays: 3 }),
    inn: choice("architecture.wasteland_depot"),
    farmhouse: choice("architecture.wasteland_depot", { bays: 3 }),
    workshop: choice("architecture.wasteland_depot"),
    barn: choice("architecture.wasteland_depot"),
    keep: choice("architecture.rust_dome"),
    temple: choice("architecture.rust_dome"),
    tower: choice("architecture.city_block", { floors: 5 }),
};

const CYBERPUNK: KindTable = {
    house: choice("architecture.city_block", { floors: 6 }),
    shop: choice("architecture.city_block", { floors: 4 }),
    inn: choice("architecture.city_block", { floors: 8 }),
    hall: choice("architecture.city_block", { floors: 12 }),
    keep: choice("architecture.city_block", { floors: 24 }),
    tower: choice("architecture.city_block", { floors: 30 }),
    temple: choice("architecture.dome_building"),
};

const GENRE_KINDS: Record<GenreType, KindTable> = {
    fantasy: FANTASY,
    historical: FANTASY,
    steampunk: { ...FANTASY, shop: choice("architecture.house", { wallFinish: "masonry.brick" }), tower: choice("architecture.city_block", { floors: 5 }) },
    scifi: { ...FANTASY, ...SCIFI },
    postapoc: { ...FANTASY, ...POSTAPOC },
    cyberpunk: { ...FANTASY, ...CYBERPUNK },
};

/** What stands at a spot that has no buildings of its own (settlements are laid out in the Planner). */
const SPOT_MODELS: Partial<Record<SpotType, ModelChoice>> = {
    ruin: choice("architecture.ruin"),
    shrine: choice("architecture.river_shrine"),
    dungeon: choice("architecture.cave_dwelling", { tiers: 1 }),
    mine: choice("architecture.cave_dwelling", { tiers: 1 }),
    camp: choice("street.barrel", { kind: "burn" }),
    boss: choice("creature.behemoth"),
    landmark: choice("nature.crystal_cluster", { height: 3.2, count: 3, spread: 18 }),
    port: choice("transport.container"),
    fortress: choice("architecture.city_block", { floors: 4 }),
};

const CATEGORY_MODELS: Record<CodexCategory, ModelChoice> = {
    character: choice("people.human", { quality: "draft" }),
    creature: choice("creature.behemoth"),
    faction: choice("street.barricade"),
    lore: choice("nature.crystal_cluster"),
    weapon: choice("household.crate"),
    power: choice("nature.crystal_cluster", { count: 3 }),
};

/** Builtins: footprints with no library object. */
const BUILTIN_KINDS: Partial<Record<StructureKind, BuiltinKind>> = { wall: "wall", well: "well", dock: "dock" };

/** Structure kinds that are painted on the ground, not built. */
export const GROUND_KINDS: ReadonlySet<StructureKind> = new Set(["street", "plaza", "market", "garden", "field"]);

export function defaultStructureModel(genre: GenreType, kind: StructureKind): ModelChoice | null {
    return GENRE_KINDS[genre]?.[kind] ?? FANTASY[kind] ?? null;
}

export function builtinFor(kind: StructureKind): BuiltinKind | null {
    return BUILTIN_KINDS[kind] ?? null;
}

export function defaultSpotModel(spotType: SpotType): ModelChoice | null {
    return SPOT_MODELS[spotType] ?? null;
}

export function defaultCategoryModel(category: CodexCategory): ModelChoice {
    return CATEGORY_MODELS[category];
}

// -------------------------------------------------------------------------------------------------
// Fitting a model to a footprint
// -------------------------------------------------------------------------------------------------

/** Sizes snap to this (m) so similar buildings share one mesh (and one instanced draw). */
export const SIZE_STEP = 0.5;
const snap = (v: number) => Math.round(v / SIZE_STEP) * SIZE_STEP;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface FittedModel {
    model: ModelChoice;
    /** Uniform scale that makes the model fill a footprint larger than it can be built. */
    scale: number;
}

/**
 * The model's values for a footprint of `w` x `d` meters and `floors` floors (0: unknown), and a
 * scale when the model's own size limits stop short of the footprint. Objects without a rule keep
 * their values and scale 1.
 */
export function fitModel(model: ModelChoice, w: number, d: number, floors = 0): FittedModel {
    const v: ParamValues = { ...model.values };
    let scale = 1;
    const short = Math.min(w, d);
    switch (model.objectId) {
        case "architecture.house": {
            const width = clamp(snap(w), 7, 18), depth = clamp(snap(d), 6, 16);
            v.width = width; v.depth = depth;
            if (floors > 0 && v.storeys === undefined) v.storeys = clamp(Math.round(floors), 1, 3);
            // A stair needs about 8 m of depth: shallow houses get one storey (as in Allegiance).
            if (depth < 8) v.storeys = 1;
            scale = Math.max(1, Math.min(w / width, d / depth));
            break;
        }
        case "architecture.city_block":
            v.width = clamp(snap(w), 4, 90); v.depth = clamp(snap(d), 4, 90);
            if (floors > 0 && v.floors === undefined) v.floors = clamp(Math.round(floors), 1, 40);
            break;
        case "architecture.arcane_emporium": {
            const width = clamp(snap(w), 6.4, 11), depth = clamp(snap(d), 5.5, 10);
            v.width = width; v.depth = depth;
            scale = Math.max(1, Math.min(w / width, d / depth));
            break;
        }
        case "architecture.wasteland_depot":
            v.width = clamp(snap(short), 9, 22);
            v.bays = clamp(Math.round(Math.max(w, d) / 4.6), 3, 8);
            break;
        case "architecture.dome_building": v.radius = clamp(snap(short / 2), 3, 14); break;
        case "architecture.river_shrine": v.radius = clamp(snap(short / 2), 5, 16); break;
        case "architecture.cave_dwelling":
            v.radius = clamp(snap(short / 2), 2.2, 5.5);
            if (floors > 0 && v.tiers === undefined) v.tiers = clamp(Math.round(floors), 1, 3);
            break;
        case "architecture.rust_dome": v.radius = clamp(snap(short / 2), 9, 20); break;
        case "architecture.ruin": v.length = clamp(snap(Math.max(w, d)), 3, 16); break;
        default:
            break;
    }
    const def = lookupObject(model.objectId);
    const values = def ? resolveParams(def, v) : v;
    // Keep only what differs from the definition's defaults? No: keep everything resolved, so a
    // cache key is the same whichever way the values were reached.
    return { model: { ...model, values }, scale };
}

// -------------------------------------------------------------------------------------------------
// Pieces of a footprint
// -------------------------------------------------------------------------------------------------

export interface FootprintPiece {
    /** Center in the structure's own frame, meters: x right, z toward its front. */
    x: number;
    z: number;
    w: number;
    d: number;
}

/**
 * One piece per wing: a rect or round footprint is one piece; an L, T or U one per range, so an
 * L-shaped inn becomes two houses joined at the corner.
 */
export function footprintPieces(s: Pick<WorldStructure, "shape" | "widthM" | "depthM">): FootprintPiece[] {
    return localParts(s.shape, s.widthM, s.depthM).map((poly) => {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const [x, y] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        // The Planner's local front is -y; the Detailer's is +z.
        return { x: (x0 + x1) / 2, z: -(y0 + y1) / 2, w: x1 - x0, d: y1 - y0 };
    });
}

// -------------------------------------------------------------------------------------------------
// Scatter and ground defaults per painted mark
// -------------------------------------------------------------------------------------------------

const item = (objectId: string, weight: number, minScale: number, maxScale: number, variants = 3, values: ParamValues = {}) => ({ objectId, values, weight, minScale, maxScale, variants });

export const DEFAULT_SCATTER: Record<string, ScatterLayer> = {
    forest: { enabled: true, perHectare: 70, items: [item("nature.tree", 6, 0.75, 1.3, 4), item("nature.shrub", 3, 0.7, 1.4), item("nature.fern", 3, 0.8, 1.3, 2), item("nature.rock", 1, 0.6, 1.6, 2)] },
    jungle: { enabled: true, perHectare: 90, items: [item("nature.palm", 4, 0.7, 1.3, 3), item("nature.fern", 5, 1, 1.8, 2), item("nature.shrub", 3, 1, 1.6)] },
    conifer: { enabled: true, perHectare: 80, items: [item("nature.conifer", 7, 0.7, 1.4, 4), item("nature.rock", 1, 0.6, 1.6, 2), item("nature.fern", 2, 0.8, 1.2, 2)] },
    meadow: { enabled: true, perHectare: 220, items: [item("nature.grass", 8, 0.8, 1.4, 2), item("nature.flowers", 3, 0.8, 1.3, 2), item("nature.shrub", 0.3, 0.6, 1)] },
    farmland: { enabled: true, perHectare: 160, items: [item("nature.grass", 1, 1.2, 1.8, 2, { height: 0.9 })] },
    brush: { enabled: true, perHectare: 60, items: [item("nature.shrub", 4, 0.5, 1.1), item("nature.grass", 3, 0.7, 1.2, 2), item("nature.rock", 1, 0.5, 1.2, 2)] },
    marsh: { enabled: true, perHectare: 140, items: [item("nature.grass", 5, 1.3, 2.2, 2, { height: 1.1 }), item("nature.shrub", 1, 0.6, 1)] },
    sand: { enabled: true, perHectare: 6, items: [item("nature.rock", 1, 0.4, 1.4, 3)] },
    rock: { enabled: true, perHectare: 30, items: [item("nature.rock", 1, 0.8, 3.5, 4)] },
    snow: { enabled: true, perHectare: 10, items: [item("nature.conifer", 1, 0.6, 1.1, 2), item("nature.rock", 2, 0.8, 2.5, 3)] },
    ash: { enabled: true, perHectare: 12, items: [item("nature.rock", 1, 0.6, 2.4, 3, { stone: "stone.dark" })] },
    blight: { enabled: true, perHectare: 10, items: [item("nature.crystal_cluster", 1, 0.5, 1.4, 3, { crystalFinish: "glow.riverViolet" }), item("nature.rock", 1, 0.6, 1.6, 2)] },
    ruins: { enabled: true, perHectare: 4, items: [item("architecture.ruin", 1, 0.7, 1, 3), item("nature.rock", 2, 0.5, 1.4, 2)] },
    urban: { enabled: false, perHectare: 0, items: [] },
};

/** Ground colors (sRGB) and roughness per mark; "base" is unpainted land. */
export const DEFAULT_GROUND: Record<string, GroundMaterial> = {
    base: { color: [0.36, 0.45, 0.24], roughness: 0.9 },
    forest: { color: [0.22, 0.27, 0.14], roughness: 0.95 },
    jungle: { color: [0.17, 0.3, 0.12], roughness: 0.95 },
    conifer: { color: [0.24, 0.26, 0.17], roughness: 0.95 },
    meadow: { color: [0.42, 0.54, 0.25], roughness: 0.9 },
    farmland: { color: [0.58, 0.52, 0.28], roughness: 0.9 },
    brush: { color: [0.5, 0.47, 0.3], roughness: 0.92 },
    marsh: { color: [0.27, 0.33, 0.22], roughness: 0.7 },
    sand: { color: [0.78, 0.69, 0.5], roughness: 0.85 },
    rock: { color: [0.47, 0.45, 0.42], roughness: 0.85 },
    snow: { color: [0.9, 0.92, 0.95], roughness: 0.6 },
    ash: { color: [0.2, 0.18, 0.17], roughness: 0.9 },
    blight: { color: [0.33, 0.25, 0.36], roughness: 0.85 },
    ruins: { color: [0.5, 0.47, 0.42], roughness: 0.9 },
    urban: { color: [0.52, 0.51, 0.49], roughness: 0.8 },
    cliff: { color: [0.43, 0.41, 0.38], roughness: 0.85 },
    beach: { color: [0.76, 0.7, 0.53], roughness: 0.85 },
    seabed: { color: [0.36, 0.38, 0.3], roughness: 0.8 },
    water: { color: [0.1, 0.22, 0.27], roughness: 0.05 },
    highway: { color: [0.5, 0.49, 0.46], roughness: 0.75 },
    road: { color: [0.47, 0.41, 0.33], roughness: 0.85 },
    trail: { color: [0.45, 0.38, 0.28], roughness: 0.9 },
    street: { color: [0.52, 0.49, 0.44], roughness: 0.8 },
    plaza: { color: [0.6, 0.57, 0.5], roughness: 0.75 },
    market: { color: [0.58, 0.53, 0.44], roughness: 0.8 },
    garden: { color: [0.32, 0.47, 0.22], roughness: 0.9 },
    field: { color: [0.62, 0.55, 0.3], roughness: 0.9 },
};

/** The structure kinds the Planner knows, with the model the genre gives them (for the inspector). */
export function kindModelTable(world: GameWorld): Array<{ key: string; label: string; model: ModelChoice | null; builtin: BuiltinKind | null }> {
    const kinds: StructureKind[] = ["house", "shop", "inn", "farmhouse", "smithy", "workshop", "barn", "hall", "barracks", "warehouse", "keep", "gate", "temple", "tower", "mill", "well", "dock", "wall"];
    return kinds.map((k) => ({ key: `structure:${k}`, label: k, model: defaultStructureModel(world.meta.genre, k), builtin: builtinFor(k) }));
}

/**
 * Parameters the plan's footprint sets (the inspector shows them as "from the plan": change the
 * footprint in the Planner, or move and turn the building here). Floors/storeys are only a
 * default from the plan and stay editable.
 */
export const FITTED_PARAMS: Record<string, string[]> = {
    "architecture.house": ["width", "depth"],
    "architecture.city_block": ["width", "depth"],
    "architecture.arcane_emporium": ["width", "depth"],
    "architecture.wasteland_depot": ["width", "bays"],
    "architecture.dome_building": ["radius"],
    "architecture.river_shrine": ["radius"],
    "architecture.cave_dwelling": ["radius"],
    "architecture.rust_dome": ["radius"],
    "architecture.ruin": ["length"],
};
