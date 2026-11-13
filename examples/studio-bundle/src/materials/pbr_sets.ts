// Shared PBR material sets for any addon's own mesh pipeline: a folder of maps (basecolor, normal,
// roughness, height, metallic) per set, loaded as mipmapped texture arrays with a layer per set
// (Entropy.Texture.loadArray), plus the bind group entries and mesh bindings that expose them to a
// shader. pom.ts has the WGSL that reads them (parallax occlusion mapping and self-shadowing).
//
// Allegiance's al_materials.ts predates this and keys sets by surface kind; this module is
// kind-free (a set is just a name, a repeat size and a relief depth) so any addon can use it.
//
// Usage:
//   const layout = materialLayout();                       // bindings 2..7 of group 2 by default
//   Entropy.Pipeline.create({ ..., extraBindGroups: [{ entries: [...myEntries, ...layout.entries] }] });
//   loadMaterialSets(SETS, c => Entropy.Texture.loadArray(c));
//   Entropy.Model.createMesh({ ..., bindings: [...mine, ...layout.bindings] });
//   // shader: pomDeclarations(layout) + pomFunctions(...) from pom.ts

import type { BindingConfig, BindingEntry } from "../addon";

export interface PbrSet {
    /** Folder under `dir` holding basecolor.png, normal.png, roughness.png, height.png, metallic.png. */
    name: string;
    /** Meters one repeat of the maps covers. */
    tile: number;
    /** Relief depth in meters: how far below the surface the height map's black sits. */
    depth: number;
}

export const PBR_DIR = "examples/studio-bundle/assets/materials";
export const PBR_MAPS = ["basecolor", "normal", "roughness", "height", "metallic"] as const;
export type PbrMap = typeof PBR_MAPS[number];
export const PBR_SIZE = 1024;

export interface MaterialLayout {
    /** Bind group the maps live in (the pipeline's first extra group is 2). */
    group: number;
    /** Binding of each map, and of the sampler. */
    binding: Record<PbrMap | "sampler", number>;
    id: (map: PbrMap) => string;
    entries: BindingEntry[];
    bindings: BindingConfig[];
}

/**
 * Where the maps bind. `base` is the first binding (color, normal, roughness, height, sampler, then
 * metallic); `metallic` overrides the last for a group that already uses base + 5.
 */
export function materialLayout(options: { base?: number; metallic?: number; group?: number; prefix?: string } = {}): MaterialLayout {
    const base = options.base ?? 2;
    const group = options.group ?? 2;
    const prefix = options.prefix ?? "pbr";
    const binding = { basecolor: base, normal: base + 1, roughness: base + 2, height: base + 3, sampler: base + 4, metallic: options.metallic ?? base + 5 };
    const id = (map: PbrMap) => `${prefix}-${map}`;
    return {
        group, binding, id,
        entries: [
            ...PBR_MAPS.map(map => ({ binding: binding[map], visibility: ["Fragment"], resourceType: "TextureArray" } as BindingEntry)),
            { binding: binding.sampler, visibility: ["Fragment"], resourceType: "Sampler" },
        ],
        bindings: [
            ...PBR_MAPS.map(map => ({ group, binding: binding[map], resource: { type: "Texture", value: { id: id(map) } } } as BindingConfig)),
            { group, binding: binding.sampler, resource: { type: "SamplerRepeat" } } as BindingConfig,
        ],
    };
}

/** What a missing layer becomes: the checkerboard for color, neutral values for the rest. */
export function pbrFallback(map: PbrMap): "checker" | [number, number, number, number] {
    if (map === "basecolor") return "checker";
    if (map === "normal") return [0.5, 0.5, 1, 1];
    if (map === "roughness") return [0.8, 0.8, 0.8, 1];
    if (map === "metallic") return [0, 0, 0, 1];
    return [1, 1, 1, 1];
}

type LoadArray = (config: { id: string; files: string[]; srgb: boolean; size: number; fallback: "checker" | [number, number, number, number] }) => { missing: number[] };

/** Loads every map array once (at startup). Returns the "set/map" names that were missing. */
export function loadMaterialSets(sets: PbrSet[], load: LoadArray, layout = materialLayout(), dir = PBR_DIR, size = PBR_SIZE): string[] {
    const missing: string[] = [];
    for (const map of PBR_MAPS) {
        const r = load({ id: layout.id(map), files: sets.map(s => `${dir}/${s.name}/${map}.png`), srgb: map === "basecolor", size, fallback: pbrFallback(map) });
        for (const i of r.missing) missing.push(`${sets[i]?.name ?? i}/${map}`);
    }
    return missing;
}

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

/** WGSL constant tables, `POM_TILE` and `POM_DEPTH`, indexed by layer. */
export function setTablesWgsl(sets: PbrSet[]): string {
    return `const POM_TILE = array<f32, ${sets.length}>(${sets.map(s => f(s.tile)).join(", ")});
const POM_DEPTH = array<f32, ${sets.length}>(${sets.map(s => f(s.depth)).join(", ")});`;
}
