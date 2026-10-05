// Textured PBR surfaces: tiling material sets (base color, normal, roughness and height maps) drawn
// in Allegiance's own forward shader, not the engine's deferred PBR path. That path would cost
// the atmosphere, logarithmic depth, render origin and sun shadows this shader already has; the
// maps are what make a surface rich, and they work here just as well.
//
// - A set covers city surface kinds (qp_shader.ts SURFACE): fieldstone on rubble walls.
//   Each map type is one mipmapped texture array (Entropy.Texture.loadArray), a layer per set,
//   bound in group 2 after the instance records of the houses pipeline (houses, city buildings,
//   set dressing). A file that cannot be read loads as a magenta/black checkerboard (base color)
//   or a neutral value (the others), so a missing asset is plain to see.
// - Meshes from Mesha have no texture coordinates, so the maps are laid on the same planes the
//   procedural surfaces use (along and up a wall, across and up a roof's slope), in the object's
//   own space, so they stay put on a building.
// - Near the camera the height map drives parallax occlusion mapping: the view ray is stepped
//   through the height field so stones stand proud of their joints and hide what lies behind
//   them. It fades out by PARALLAX_FAR, where plain normal mapping takes over, and the height also
//   darkens the crevices. Roughness feeds a normalized specular lobe (dielectric, F0 = 0.04).

import type { BindingConfig, BindingEntry } from "../../addon";
import { SURFACE } from "../../apps/quadplanet/qp_shader";

export interface MaterialSet {
    /** Folder under MATERIAL_DIR holding basecolor.png, normal.png, roughness.png and height.png. */
    name: string;
    /** Surface kinds drawn with it (qp_shader.ts SURFACE). */
    kinds: number[];
    /** Meters one repeat of the maps covers. */
    tile: number;
    /** How deep the height map's range is (meters): the parallax depth. */
    depth: number;
}

export const MATERIAL_DIR = "examples/studio-bundle/assets/materials";
export const MATERIAL_SETS: MaterialSet[] = [
    // Rubble walls: cottages, farmhouse plinths and chimneys, and the compounds' perimeter walls.
    { name: "fieldstone", kinds: [SURFACE.fieldstone], tile: 1.6, depth: 0.06 },
];
export const MATERIAL_MAPS = ["basecolor", "normal", "roughness", "height"] as const;
export const MATERIAL_SIZE = 1024;
/** Parallax is full within PARALLAX_NEAR meters and gone by PARALLAX_FAR. */
export const PARALLAX_NEAR = 6;
export const PARALLAX_FAR = 14;

/** Texture ids, by map. */
export const materialTextureId = (map: typeof MATERIAL_MAPS[number]): string => `allegiance-material-${map}`;

/** The files of one map, a layer per set. */
export const materialFiles = (map: typeof MATERIAL_MAPS[number], sets = MATERIAL_SETS): string[] =>
    sets.map(s => `${MATERIAL_DIR}/${s.name}/${map}.png`);

/** What a map's missing layer becomes: the checkerboard for color, neutral values for the rest. */
export function materialFallback(map: typeof MATERIAL_MAPS[number]): "checker" | [number, number, number, number] {
    if (map === "basecolor") return "checker";
    if (map === "normal") return [0.5, 0.5, 1, 1];
    if (map === "roughness") return [0.8, 0.8, 0.8, 1];
    return [1, 1, 1, 1];
}

export interface MaterialLoad { missing: { map: string; set: string }[] }

/** Loads every map array (once, at startup). */
export function loadMaterials(load: (config: { id: string; files: string[]; srgb: boolean; size: number; fallback: "checker" | [number, number, number, number] }) => { missing: number[] }): MaterialLoad {
    const missing: { map: string; set: string }[] = [];
    for (const map of MATERIAL_MAPS) {
        const r = load({ id: materialTextureId(map), files: materialFiles(map), srgb: map === "basecolor", size: MATERIAL_SIZE, fallback: materialFallback(map) });
        for (const i of r.missing) missing.push({ map, set: MATERIAL_SETS[i]?.name ?? String(i) });
    }
    return { missing };
}

/** First group-2 binding of the material textures in the houses pipeline (after world and records). */
export const MATERIAL_BINDING = 2;

/** The pipeline's layout entries for the maps and their sampler. */
export const MATERIAL_BIND_ENTRIES: BindingEntry[] = [
    ...MATERIAL_MAPS.map((_, i) => ({ binding: MATERIAL_BINDING + i, visibility: ["Fragment"], resourceType: "TextureArray" } as BindingEntry)),
    { binding: MATERIAL_BINDING + MATERIAL_MAPS.length, visibility: ["Fragment"], resourceType: "Sampler" },
];

/** A mesh's bindings for the maps and the tiling sampler. */
export function materialBindings(): BindingConfig[] {
    return [
        ...MATERIAL_MAPS.map((map, i) => ({ group: 2, binding: MATERIAL_BINDING + i, resource: { type: "Texture", value: { id: materialTextureId(map) } } } as BindingConfig)),
        { group: 2, binding: MATERIAL_BINDING + MATERIAL_MAPS.length, resource: { type: "SamplerRepeat" } } as BindingConfig,
    ];
}

/** Per surface kind: its layer (-1: procedural), tile and depth, as WGSL constants. */
export function materialTable(sets = MATERIAL_SETS): { layer: number[]; tile: number[]; depth: number[] } {
    const layer = new Array(9).fill(-1), tile = new Array(9).fill(1), depth = new Array(9).fill(0);
    sets.forEach((s, i) => { for (const k of s.kinds) { layer[k] = i; tile[k] = s.tile; depth[k] = s.depth; } });
    return { layer, tile, depth };
}

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

/**
 * WGSL for the textured surfaces (declarations, the table and textured_surface). The caller
 * computes the surface coordinates and their screen derivatives where control flow is uniform.
 */
export function materialWgsl(sets = MATERIAL_SETS): string {
    const t = materialTable(sets);
    const b = MATERIAL_BINDING;
    return /* wgsl */ `
@group(2) @binding(${b}) var mat_basecolor: texture_2d_array<f32>;
@group(2) @binding(${b + 1}) var mat_normal: texture_2d_array<f32>;
@group(2) @binding(${b + 2}) var mat_roughness: texture_2d_array<f32>;
@group(2) @binding(${b + 3}) var mat_height: texture_2d_array<f32>;
@group(2) @binding(${b + 4}) var mat_sampler: sampler;

const SURFACE_LAYER = array<i32, 9>(${t.layer.join(", ")});
const SURFACE_TILE = array<f32, 9>(${t.tile.map(f).join(", ")});
const SURFACE_DEPTH = array<f32, 9>(${t.depth.map(f).join(", ")});

struct Textured { albedo: vec3<f32>, n_local: vec3<f32>, rough: f32, height: f32 };

fn surface_layer(kind: i32) -> i32 {
    if (kind < 0 || kind > 8) { return -1; }
    return SURFACE_LAYER[kind];
}

// The textured surface at local point p (normal ln, surface coordinates uv0 with screen
// derivatives dx/dy), seen along v_local (unit, toward the eye, object space) from dist meters.
fn textured_surface(kind: i32, layer: i32, uv0: vec2<f32>, dx: vec2<f32>, dy: vec2<f32>, ln: vec3<f32>, v_local: vec3<f32>, dist: f32) -> Textured {
    var out: Textured;
    let tile = SURFACE_TILE[kind];
    // Image up is up the wall (or slope): the maps' v runs down.
    let flip = vec2<f32>(1.0, -1.0) / tile;
    var uv = uv0 * flip;
    let gx = dx * flip;
    let gy = dy * flip;
    // The tangent frame surface_uv lays the maps on: along (or across), then up (or up-slope).
    let flat = vec2<f32>(ln.x, ln.z);
    let fl = length(flat);
    var t = vec3<f32>(1.0, 0.0, 0.0);
    if (fl >= 0.08) { t = normalize(vec3<f32>(-flat.y, 0.0, flat.x)); }
    let b = cross(t, ln);
    // Parallax occlusion near the eye: march the view ray down through the height field.
    let near = 1.0 - smoothstep(${f(PARALLAX_NEAR)}, ${f(PARALLAX_FAR)}, dist);
    let vt = vec3<f32>(dot(v_local, t), dot(v_local, b), dot(v_local, ln));
    if (near > 0.0 && vt.z > 0.08) {
        let shift = vec2<f32>(vt.x, -vt.y) / vt.z * (SURFACE_DEPTH[kind] / tile) * near;
        let steps = mix(24.0, 8.0, vt.z);
        let step = 1.0 / steps;
        var depth = 0.0;
        var cur = uv;
        var surface = 1.0 - textureSampleGrad(mat_height, mat_sampler, cur, layer, gx, gy).r;
        var prev_cur = cur;
        var prev_gap = surface;
        for (var i = 0; i < 32; i = i + 1) {
            if (depth >= surface || f32(i) >= steps) { break; }
            prev_cur = cur;
            prev_gap = surface - depth;
            cur = cur - shift * step;
            depth = depth + step;
            surface = 1.0 - textureSampleGrad(mat_height, mat_sampler, cur, layer, gx, gy).r;
        }
        // Between the last two steps, where the ray met the surface.
        let after = surface - depth;
        let w = clamp(after / (after - prev_gap + 1.0e-5), 0.0, 1.0);
        uv = mix(cur, prev_cur, w);
    }
    out.albedo = textureSampleGrad(mat_basecolor, mat_sampler, uv, layer, gx, gy).rgb;
    let nt = textureSampleGrad(mat_normal, mat_sampler, uv, layer, gx, gy).xyz * 2.0 - 1.0;
    out.n_local = normalize(t * nt.x + b * nt.y + ln * max(nt.z, 0.05));
    out.rough = clamp(textureSampleGrad(mat_roughness, mat_sampler, uv, layer, gx, gy).r, 0.04, 1.0);
    out.height = textureSampleGrad(mat_height, mat_sampler, uv, layer, gx, gy).r;
    return out;
}
`;
}
