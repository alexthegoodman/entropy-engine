// The Game World Detailer's part of a world file. It lives in `world.detail`, inside the same
// `worlds/<id>.world.json` the Game World Planner saves, so a world is one file whichever app
// edits it. The Planner carries this section untouched; the Detailer reads the whole plan (terrain,
// spots, roads, structures, codex placements, painted marks) and adds what a 3D level needs on top.
//
// Everything here is optional and additive: a world the Detailer never opened has no `detail` and
// still details fully from defaults (see detail_models.ts).
//
// Keys of `models` (what Mesha model stands for a whole kind of planned thing):
//   "structure:<kind>"   every building of a kind ("structure:inn")
//   "spot:<spotType>"    the landmark at a spot of a type without buildings ("spot:ruin")
//   "codex:<entryId>"    a codex entry placed on the map (an NPC, a creature, a faction outpost)
//   "category:<cat>"     codex placements of a category without their own ("category:creature")
// Keys of `bindings`: a planner entity's id (a structure, spot or placement), for that one thing.

import type { ParamValues } from "../mesha/mesha_object";

export const DETAIL_VERSION = 1;

/** A Mesha library object with parameter values: what Mesha's own scenes store per instance. */
export interface ModelChoice {
    objectId: string;
    values: ParamValues;
    /** The preset it came from, for the inspector ("Hedge-witch apothecary", "My house 2"). */
    presetName?: string;
}

/** Per-entity detail on top of the plan: its own model, a nudge, or hidden. */
export interface EntityBinding {
    /** Its own model (instead of its kind's). */
    model?: ModelChoice;
    /** Meters, in the entity's frame (x right, y up, z toward its front). */
    offset?: [number, number, number];
    /** Extra turn on top of the plan's rotation (degrees). */
    yawDeg?: number;
    scale?: number;
    hidden?: boolean;
    notes?: string;
}

/** A hand-placed object the plan doesn't have: a cart, a lamp post, a pile of crates. */
export interface DetailProp {
    id: string;
    name?: string;
    objectId: string;
    values: ParamValues;
    /** World km, like everything in the plan. */
    x: number;
    y: number;
    /** Meters above the ground under it. */
    lift: number;
    yawDeg: number;
    scale: number;
    /** The planner thing it belongs with (a settlement spot, a building), for the export and outliner. */
    anchorId?: string;
    notes?: string;
}

/** What grows (or lies) where a mark is painted. */
export interface ScatterItem {
    objectId: string;
    values: ParamValues;
    /** Share of the layer's instances (relative to the others). */
    weight: number;
    minScale: number;
    maxScale: number;
    /** Variants (seeds) to cycle through: more looks less repeated, fewer instance better. */
    variants: number;
}

export interface ScatterLayer {
    enabled: boolean;
    /** Instances per hectare where the mark is painted at full density. */
    perHectare: number;
    items: ScatterItem[];
}

/** How a painted mark (or a biome) colors the ground. */
export interface GroundMaterial {
    color: [number, number, number];
    roughness: number;
}

/** A saved view: a place to detail, with where the camera looks from. */
export interface DetailSite {
    id: string;
    name: string;
    /** The point the camera orbits, world km. */
    x: number;
    y: number;
    /** Camera yaw / pitch (degrees) and distance (m). */
    yawDeg: number;
    pitchDeg: number;
    distanceM: number;
    /** The planner thing it was opened on, if any. */
    anchorId?: string;
}

export interface DetailLighting {
    /** "daylight" | "warm" | "night" | ... (mesha_shader STUDIO_PRESETS ids). */
    preset: string;
}

export interface DetailQuality {
    /** 0..1 of each scatter layer's density shown in the viewport (the export always has all of it). */
    scatterDensity: number;
    /** How far out objects stay at full detail; 1 = default. */
    lodScale: number;
    /** Triangles the viewport may draw for objects before far ones drop a level of detail. */
    triangleBudget: number;
}

export interface WorldDetail {
    version: number;
    models: Record<string, ModelChoice>;
    bindings: Record<string, EntityBinding>;
    props: DetailProp[];
    scatter: Record<string, ScatterLayer>;
    ground: Record<string, GroundMaterial>;
    sites: DetailSite[];
    lighting: DetailLighting;
    quality: DetailQuality;
}

export function emptyDetail(): WorldDetail {
    return {
        version: DETAIL_VERSION,
        models: {},
        bindings: {},
        props: [],
        scatter: {},
        ground: {},
        sites: [],
        lighting: { preset: "daylight" },
        quality: { scatterDensity: 0.6, lodScale: 1, triangleBudget: 6_000_000 },
    };
}

/** The world's detail section, made (and filled with defaults where older saves lack fields). */
export function detailOf(world: { detail?: Record<string, unknown> }): WorldDetail {
    const d = (world.detail ??= {}) as Partial<WorldDetail>;
    const e = emptyDetail();
    d.version ??= e.version;
    d.models ??= e.models;
    d.bindings ??= e.bindings;
    d.props ??= e.props;
    d.scatter ??= e.scatter;
    d.ground ??= e.ground;
    d.sites ??= e.sites;
    d.lighting ??= e.lighting;
    d.quality = { ...e.quality, ...(d.quality ?? {}) };
    return d as WorldDetail;
}
