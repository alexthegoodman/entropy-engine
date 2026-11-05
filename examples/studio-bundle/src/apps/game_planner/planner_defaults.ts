// Defaults shared by the planner UI, the built-in agent and proposal normalization: what a spot,
// path or region of each type looks like when nobody said otherwise.

import type { BiomeType, PathType, RegionType, SpotType } from "./planner_types";

export type RGBA = [number, number, number, number];

export const SPOT_TYPES: SpotType[] = ["capital", "city", "town", "village", "fortress", "dungeon", "ruin", "port", "shrine", "camp", "mine", "boss", "landmark"];
export const PATH_TYPES: PathType[] = ["highway", "road", "trail", "river", "bridge"];
export const REGION_TYPES: RegionType[] = ["kingdom", "province", "biome", "danger", "district"];
export const BIOMES: BiomeType[] = ["plains", "forest", "jungle", "desert", "tundra", "volcanic", "swamp", "alpine", "coastal", "savanna", "taiga", "badlands"];

export const SPOT_COLORS: Record<SpotType, RGBA> = {
    capital: [0.98, 0.75, 0.14, 1],
    city: [0.95, 0.62, 0.25, 1],
    town: [0.35, 0.8, 0.5, 1],
    village: [0.45, 0.75, 0.4, 1],
    fortress: [0.6, 0.65, 0.75, 1],
    dungeon: [0.95, 0.25, 0.35, 1],
    ruin: [0.65, 0.5, 0.85, 1],
    port: [0.22, 0.74, 0.97, 1],
    shrine: [0.7, 0.45, 0.95, 1],
    camp: [0.85, 0.5, 0.2, 1],
    mine: [0.8, 0.5, 0.3, 1],
    boss: [0.9, 0.15, 0.25, 1],
    landmark: [0.9, 0.9, 0.95, 1],
};

export function isMajorSpotType(t: SpotType): boolean {
    return t === "capital" || t === "city" || t === "fortress" || t === "port";
}

export const PATH_DEFAULTS: Record<PathType, { color: RGBA; width: number; surfaceQuality: number; flowSpeed: number; isMajor: boolean }> = {
    highway: { color: [0.98, 0.75, 0.14, 1], width: 5, surfaceQuality: 0.8, flowSpeed: 0, isMajor: true },
    road: { color: [0.85, 0.75, 0.55, 1], width: 3.5, surfaceQuality: 1.0, flowSpeed: 0, isMajor: false },
    trail: { color: [0.65, 0.55, 0.4, 1], width: 2, surfaceQuality: 1.35, flowSpeed: 0, isMajor: false },
    river: { color: [0.22, 0.6, 0.92, 1], width: 4.5, surfaceQuality: 1.0, flowSpeed: 1.5, isMajor: true },
    bridge: { color: [0.8, 0.85, 0.9, 1], width: 3.5, surfaceQuality: 0.9, flowSpeed: 0, isMajor: false },
};

export const BIOME_COLORS: Record<BiomeType, { fill: RGBA; border: RGBA }> = {
    plains: { fill: [0.2, 0.7, 0.35, 0.22], border: [0.3, 0.85, 0.45, 0.85] },
    forest: { fill: [0.15, 0.55, 0.25, 0.25], border: [0.2, 0.7, 0.35, 0.85] },
    jungle: { fill: [0.1, 0.65, 0.4, 0.28], border: [0.15, 0.85, 0.5, 0.9] },
    desert: { fill: [0.85, 0.75, 0.35, 0.25], border: [0.95, 0.85, 0.45, 0.85] },
    tundra: { fill: [0.6, 0.75, 0.85, 0.25], border: [0.75, 0.88, 0.98, 0.85] },
    volcanic: { fill: [0.75, 0.25, 0.15, 0.28], border: [0.95, 0.35, 0.2, 0.9] },
    swamp: { fill: [0.3, 0.45, 0.25, 0.3], border: [0.4, 0.6, 0.35, 0.85] },
    alpine: { fill: [0.65, 0.7, 0.8, 0.25], border: [0.8, 0.85, 0.95, 0.85] },
    coastal: { fill: [0.2, 0.65, 0.75, 0.22], border: [0.3, 0.8, 0.9, 0.85] },
    savanna: { fill: [0.75, 0.65, 0.25, 0.22], border: [0.88, 0.78, 0.35, 0.85] },
    taiga: { fill: [0.2, 0.45, 0.4, 0.25], border: [0.25, 0.6, 0.55, 0.85] },
    badlands: { fill: [0.7, 0.4, 0.25, 0.25], border: [0.85, 0.5, 0.35, 0.85] },
};

export const DANGER_COLORS = { fill: [0.85, 0.15, 0.2, 0.2] as RGBA, border: [0.98, 0.3, 0.35, 0.9] as RGBA };

export const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
