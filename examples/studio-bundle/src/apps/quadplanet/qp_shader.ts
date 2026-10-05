// QuadPlanet's one shader (an unlit-pipeline "mesh" layout shader doing its own lighting).
//
// - Terrain chunks: biome vertex colors, sun + sky ambient that fades to night on the dark side,
//   a sun glint on water, and aerial perspective: every fragment is hazed by how much of the
//   planet's atmosphere shell lies between it and the camera. From orbit that same haze is what
//   makes the limb glow; on the ground it is the blue distance.
// - The sky: a sphere that follows the camera. Stars and the sun, and for each planet the
//   scattering along the view ray through its atmosphere shell - so standing on a planet you get
//   a blue (or amber) day sky that darkens toward space as you climb, and from space a thin glowing
//   rim around each planet.
// - The ship and walker: painted, glass and glowing (engine) surfaces, placed by a per-object
//   model matrix so they move without re-uploading geometry.
//
// - Procedural texturing: terrain gets rock, soil and grass, snow, water and ice surface detail
//   from 3D noise evaluated in the fragment shader, with bump-mapped normals from the noise's
//   analytic gradient. Every octave fades out once it is finer than a pixel, so the detail is
//   there when you look at the ground at your feet and never shimmers on a distant mountain.
//   Which texture a spot gets comes from the vertex color: its alpha is the rock weight
//   (planet.rs Planet::color), snow is told apart by its color.
//
// Coordinates. Planets are tens (Earth: thousands) of kilometers across and hundreds apart, more than f32 can place
// to the millimeter. Everything is drawn relative to a render origin near the camera
// (quadplanet_addon.ts): chunk vertices are relative to their own origin and the per-object model
// matrix moves them by (chunk origin - render origin); the camera and the planets in the World
// uniform are given relative to it too. Texture noise must not depend on that origin, so each
// chunk also gets `tex_origin`, its own origin modulo TEX_PERIOD: the noise repeats every
// TEX_PERIOD meters, so neighbouring chunks agree on it, and the numbers it sees stay small.
//
// Depth is logarithmic (written per fragment): the engine's depth buffer is 24-bit with a 0.1 m
// near plane, which leaves hundreds of meters of depth resolution at the distance of a far
// mountain range. log2(1 + w) spreads it evenly over every scale, from the walker's boots to the
// next planet.
//
// Material ids ride in uv.x's integer part and the chunk's quadtree level in uv.y's; terrain
// chunks put their local grid position in the fractions (mesh.rs pack_chunk_uv) so the debug
// view can color each level and outline each chunk.
//
// Earth's cities (city.rs, qp_city.ts) add:
// - 11 / 6: house surfaces (matte paint, brick, roofing...); 6 is a house's foundation, whose
//   bottom is pushed down by the item's tex_origin.w so it reaches the lowest ground under it.
// - 7: see-through window glass (a full house, which has rooms to see): an ordered dither leaves
//   the color's alpha share of the pane out, like Mesha's viewport.
// - 8: building boxes (level of detail 2), one mesh per city tile. Each vertex knows its
//   building's anchor: uv.x's fraction and uv.y's fraction hold the x/z offset from it
//   ((f - 0.5) * 4000 m), the color's alpha the height above it; uv.y's integer part is 1 for a
//   house and 2 for another building standing on the ground. A house box within world.city.x of
//   the camera, and another building's box within world.city.z, is folded away: a model is there
//   instead (qp_city.ts houses, qp_buildings.ts city buildings). Walls get rows of windows from
//   the height above the anchor.
// - 11's surface kind rides in uv.y's integer part (surfaceKind, from the Mesha material): 1 brick,
//   2 render/plaster/paint, 3 concrete, 4 stone, 5 roof tiles and slates, 6 metal, 7 wood. Each
//   is drawn procedurally in the object's own space (courses, joints, tiles, planks, blotches)
//   with weathering: grime rising from the ground and rain streaks running down the walls.
// - 10: roads, faded out past world.city.y and nudged toward the camera in depth so they stay
//   over the ground they are draped on, even where a coarser terrain chunk is drawn.

/** Floats in the World uniform (14 vec4). */
export const WORLD_FLOATS = 56;
/** Floats in the per-object Item uniform: model matrix, tint, texture origin. */
export const ITEM_FLOATS = 24;
/** The texture noise repeats every this many meters (a power of two: see the shader). */
export const TEX_PERIOD = 1024;
export const MAX_PLANETS = 4;

export interface WorldUniform {
    sunDir: [number, number, number];
    time: number;
    sunColor: [number, number, number];
    exposure: number;
    debugLod: boolean;
    /** Outline every chunk (independent of the level tint). */
    debugOutlines?: boolean;
    planets: { center: [number, number, number]; radius: number; atmosphere: [number, number, number]; atmosphereHeight: number }[];
    /** Cities: house boxes within `hideRadius` of the camera (other buildings' within `buildingHideRadius`) are folded away; roads end at `roadDistance`. */
    city?: { hideRadius: number; roadDistance: number; buildingHideRadius?: number };
    /**
     * Clouds and wind (default: none). `cloudOffset` is where the cloud noise is sampled relative
     * to the render origin, kept small by the caller (render origin plus drift, modulo
     * CLOUD_PERIOD); `cloudAltitude` is the cloud layer's height above the first planet's radius;
     * `wind` is the wind's velocity in render space (m/s).
     */
    weather?: { cloudCover: number; cloudOffset: [number, number, number]; cloudAltitude: number; wind: [number, number, number] };
}

/** The cloud noise repeats every this many meters. */
export const CLOUD_PERIOD = 65536;

export function packWorld(w: WorldUniform): Float32Array {
    const out = new Float32Array(WORLD_FLOATS);
    out.set([...w.sunDir, w.time], 0);
    out.set([...w.sunColor, 0], 4);
    out.set([w.exposure, w.debugLod ? 1 : 0, Math.min(MAX_PLANETS, w.planets.length), w.debugOutlines ? 1 : 0], 8);
    for (let i = 0; i < MAX_PLANETS; i++) {
        const p = w.planets[i];
        if (!p) continue;
        out.set([...p.center, p.radius], 12 + i * 4);
        out.set([...p.atmosphere, p.atmosphereHeight], 12 + MAX_PLANETS * 4 + i * 4);
    }
    out.set([w.city?.hideRadius ?? 0, w.city?.roadDistance ?? 3000, w.city?.buildingHideRadius ?? 0, 0], 12 + MAX_PLANETS * 8);
    const wx = w.weather;
    if (wx) {
        out.set([...wx.cloudOffset, wx.cloudCover], 16 + MAX_PLANETS * 8);
        out.set([...wx.wind, wx.cloudAltitude], 20 + MAX_PLANETS * 8);
    }
    return out;
}

export const MATERIAL_PAINT = 3;
export const MATERIAL_GLOW = 4;
export const MATERIAL_GLASS = 5;
export const MATERIAL_SKY = 9;
export const MATERIAL_FOUNDATION = 6;
export const MATERIAL_HOUSE = 11;
export const MATERIAL_CLEAR_GLASS = 7;
export const MATERIAL_BUILDING_BOX = 8;
export const MATERIAL_ROAD = 10;

/** Surface kinds for material 11 (uv.y's integer part): see the top. */
export const SURFACE = { plain: 0, brick: 1, render: 2, concrete: 3, stone: 4, tiles: 5, metal: 6, wood: 7 } as const;

/** The surface kind a Mesha material is drawn as (by its id; plain when unknown). */
export function surfaceKind(id: string | undefined): number {
    if (!id) return SURFACE.plain;
    if (id === "masonry.brick" || id === "masonry.buff" || id === "masonry.whitewash") return SURFACE.brick;
    if (id === "masonry.stucco" || id === "masonry.plaster" || id.startsWith("paint.")) return SURFACE.render;
    if (id.startsWith("masonry.") && id.includes("oncrete") || id.startsWith("composite.")) return SURFACE.concrete;
    if (id.startsWith("stone.") || id === "masonry.fieldstone") return SURFACE.stone;
    if (id === "roofing.seam") return SURFACE.metal;
    if (id.startsWith("roofing.")) return SURFACE.tiles;
    if (id.startsWith("metal.")) return SURFACE.metal;
    if (id.startsWith("wood.")) return SURFACE.wood;
    return SURFACE.plain;
}

export const QUADPLANET_SHADER = /* wgsl */ `
struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0) var<uniform> camera: Camera;

struct World {
    sun_dir: vec4<f32>,        // xyz, w = time
    sun_color: vec4<f32>,
    params: vec4<f32>,         // x = exposure, y = LOD debug tint, z = planet count, w = chunk outlines
    planet: array<vec4<f32>, ${MAX_PLANETS}>,     // center xyz (relative to the render origin), radius
    atmosphere: array<vec4<f32>, ${MAX_PLANETS}>, // color rgb, shell thickness
    city: vec4<f32>,           // x = house box hide radius, y = road distance, z = other buildings' box hide radius
    cloud: vec4<f32>,          // xyz = cloud noise offset (see packWorld), w = cloud cover (0 = none)
    wind: vec4<f32>,           // xyz = wind velocity (m/s), w = cloud layer altitude
};
@group(2) @binding(0) var<uniform> world: World;

struct Item {
    model: mat4x4<f32>,
    tint: vec4<f32>,           // rgb multiplies paint, w = glow boost
    tex_origin: vec4<f32>,     // xyz: the object's origin modulo TEX_PERIOD (terrain texturing)
};
@group(2) @binding(1) var<uniform> item: Item;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) color: vec4<f32>,
    @location(4) tex_pos: vec3<f32>,
    @location(5) view_w: f32,
    @location(6) local_normal: vec3<f32>,
};

struct FragmentOutput {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
};

const TEX_PERIOD: f32 = ${TEX_PERIOD}.0;
// Depth reaches 1 at this distance (m): past the far side of the system.
const LOG_DEPTH_FAR: f32 = 1.0e8;
const SKY_DEPTH: f32 = 0.99999;

fn log_depth(w: f32) -> f32 {
    return clamp(log2(max(w, 1.0e-6) + 1.0) / log2(LOG_DEPTH_FAR + 1.0), 0.0, 1.0);
}

// The vertex stage, shared by vs_main and any other entry point a game adds (Allegiance's shadow
// caster): world_pos is where the vertex really is; view_w < 0 marks a folded-away vertex.
fn vertex_common(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let material = i32(floor(in.tex_coords.x + 0.0005));
    var clip: vec4<f32>;
    var folded = false;
    if (material == 9) {
        // The sky sphere rides with the camera and sits at the far end of the depth range.
        let w = camera.view_pos.xyz + in.position * 30000.0;
        clip = camera.view_proj * vec4<f32>(w, 1.0);
        clip.z = clip.w * SKY_DEPTH;
        out.world_pos = w;
        out.normal = in.normal;
    } else {
        var pos = in.position;
        if (material == 6 && pos.y < 0.01) {
            // A house's foundation reaches down to the lowest ground under it.
            pos.y = pos.y - item.tex_origin.w;
        }
        let w = item.model * vec4<f32>(pos, 1.0);
        clip = camera.view_proj * w;
        if (material == 8 && in.tex_coords.y >= 1.0) {
            // A house's (or another building's) box: fold it away where its model is drawn
            // instead (see the top).
            let anchor = in.position - vec3<f32>((fract(in.tex_coords.x) - 0.5) * 4000.0, in.color.a, (fract(in.tex_coords.y) - 0.5) * 4000.0);
            let a = item.model * vec4<f32>(anchor, 1.0);
            let hide = select(world.city.z, world.city.x, in.tex_coords.y < 2.0);
            if (length(a.xyz - camera.view_pos.xyz) < hide) {
                clip = vec4<f32>(0.0, 0.0, 0.0, 1.0);
                folded = true;
            }
        }
        // Logarithmic depth (rewritten exactly per fragment); anything in front of the camera
        // stays inside the clip volume, however near or far.
        clip.z = log_depth(clip.w) * clip.w;
        out.world_pos = w.xyz;
        out.normal = (item.model * vec4<f32>(in.normal, 0.0)).xyz;
    }
    out.clip_position = clip;
    out.view_w = select(clip.w, -1.0, folded);
    out.tex_pos = in.position + item.tex_origin.xyz;
    out.uv = in.tex_coords;
    out.color = in.color;
    out.local_normal = in.normal;
    return out;
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    return vertex_common(in);
}

fn hash3(p: vec3<f32>) -> f32 {
    let q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
    let r = q + dot(q, q.yxz + 33.33);
    return fract((r.x + r.y) * r.z);
}

fn aces(x: vec3<f32>) -> vec3<f32> {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}

// --- Texture noise ---------------------------------------------------------------------------

// Integer hash of a lattice point, in [0, 1].
fn lattice(q: vec3<u32>) -> f32 {
    var v = q * 1664525u + 1013904223u;
    v.x = v.x + v.y * v.z; v.y = v.y + v.z * v.x; v.z = v.z + v.x * v.y;
    v = v ^ (v >> vec3<u32>(16u));
    v.x = v.x + v.y * v.z; v.y = v.y + v.z * v.x; v.z = v.z + v.x * v.y;
    return f32(v.x & 0xffffffu) / 16777215.0;
}

// Value noise in [-1, 1] with its analytic gradient (.yzw, per lattice unit), repeating every
// \`period\` lattice cells (an integer): the lattice is wrapped before hashing.
fn vnoise(x: vec3<f32>, period: f32) -> vec4<f32> {
    let i = floor(x);
    let f = x - i;
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    let w0 = i - period * floor(i / period);
    let p = u32(period);
    let a0 = vec3<u32>(w0);
    let a1 = (a0 + vec3<u32>(1u)) % vec3<u32>(p);
    let a = lattice(vec3<u32>(a0.x, a0.y, a0.z));
    let b = lattice(vec3<u32>(a1.x, a0.y, a0.z));
    let c = lattice(vec3<u32>(a0.x, a1.y, a0.z));
    let d = lattice(vec3<u32>(a1.x, a1.y, a0.z));
    let e = lattice(vec3<u32>(a0.x, a0.y, a1.z));
    let f1 = lattice(vec3<u32>(a1.x, a0.y, a1.z));
    let g = lattice(vec3<u32>(a0.x, a1.y, a1.z));
    let h = lattice(vec3<u32>(a1.x, a1.y, a1.z));
    let k1 = b - a;
    let k2 = c - a;
    let k3 = e - a;
    let k4 = a - b - c + d;
    let k5 = a - c - e + g;
    let k6 = a - b - e + f1;
    let k7 = -a + b + c - d + e - f1 - g + h;
    let v = a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
    let grad = du * vec3<f32>(
        k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
        k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
        k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y);
    return vec4<f32>(v * 2.0 - 1.0, grad * 2.0);
}

// How much of an octave of wavelength 1/freq survives a pixel \`footprint\` meters wide.
fn octave_fade(freq: f32, footprint: f32) -> f32 {
    return 1.0 - smoothstep(0.3, 0.6, footprint * freq);
}

// Fractal noise in meters-space: (value, gradient per meter). \`freq\` is the first octave's
// frequency (a power of two, cycles per meter). Octaves finer than a pixel are faded out.
fn fbm(p: vec3<f32>, freq0: f32, octaves: i32, gain: f32, footprint: f32) -> vec4<f32> {
    var sum = vec4<f32>(0.0);
    var amp = 0.5;
    var freq = freq0;
    for (var o = 0; o < octaves; o = o + 1) {
        let fade = octave_fade(freq, footprint);
        if (fade <= 0.0) { break; }
        // Integer lattice offsets decorrelate the octaves without breaking the period.
        let n = vnoise(p * freq + vec3<f32>(f32(o) * 17.0, f32(o) * 31.0, f32(o) * 7.0), TEX_PERIOD * freq);
        sum = sum + vec4<f32>(n.x, n.yzw * freq) * amp * fade;
        amp = amp * gain;
        freq = freq * 2.0;
    }
    return sum;
}

// Tilts normal n by the gradient of a height field (meters per meter).
fn bump(n: vec3<f32>, grad: vec3<f32>) -> vec3<f32> {
    return normalize(n - (grad - dot(grad, n) * n));
}

struct Surface { albedo: vec3<f32>, n: vec3<f32>, spec: f32, shin: f32, ao: f32 };

// --- City surfaces (material 11) ---------------------------------------------------------------

// A city surface: color, a height gradient in the object's own space (for the bump), gloss and
// occlusion.
struct Facade { albedo: vec3<f32>, grad: vec3<f32>, spec: f32, shin: f32, ao: f32 };

// Courses of blocks (bricks, ashlar, tiles, planks): \`size\` is one block (along, up) in meters,
// \`joint\` the joint's width, \`stagger\` the offset of every other course. x = joint amount
// (0 block .. 1 joint), y = the block's random tone, z = how far up its course (0..1).
fn courses(uv: vec2<f32>, size: vec2<f32>, joint: f32, stagger: f32) -> vec3<f32> {
    let row = floor(uv.y / size.y);
    let x = uv.x / size.x + stagger * (row - 2.0 * floor(row * 0.5));
    let col = floor(x);
    let fu = fract(x) * size.x;
    let fv = fract(uv.y / size.y) * size.y;
    let inside = smoothstep(0.0, joint, fu) * smoothstep(0.0, joint, size.x - fu) * smoothstep(0.0, joint, fv) * smoothstep(0.0, joint, size.y - fv);
    return vec3<f32>(1.0 - inside, hash3(vec3<f32>(col, row, 3.7)), fv / size.y);
}

// (along, up) on a wall; on a roof (across the slope, up the slope); on a floor its plan.
fn surface_uv(p: vec3<f32>, ln: vec3<f32>) -> vec2<f32> {
    let flat = vec2<f32>(ln.x, ln.z);
    let fl = length(flat);
    if (abs(ln.y) < 0.5) {
        let along = vec2<f32>(-flat.y, flat.x) / max(fl, 1.0e-4);
        return vec2<f32>(dot(p.xz, along), p.y);
    }
    if (fl < 0.08) { return p.xz; }
    let across = vec2<f32>(-flat.y, flat.x) / fl;
    return vec2<f32>(dot(p.xz, across), p.y / fl);
}

fn city_surface(kind: i32, base: vec3<f32>, p: vec3<f32>, ln: vec3<f32>, fp: f32) -> Facade {
    var f: Facade;
    f.albedo = base;
    f.grad = vec3<f32>(0.0);
    f.spec = 0.12;
    f.shin = 24.0;
    f.ao = 1.0;
    let uv = surface_uv(p, ln);
    let wall = abs(ln.y) < 0.5;
    // Broad blotches every surface has (repairs, sun-bleaching, damp), and a fine grain.
    let blotch = fbm(p, 1.0 / 4.0, 3, 0.5, fp);
    let grain = fbm(p, 4.0, 3, 0.5, fp);
    if (kind == 1) {
        // Brick: 215 x 65 mm with 10 mm mortar, stretcher bond.
        let c = courses(uv, vec2<f32>(0.225, 0.075), 0.011, 0.5);
        let vis = octave_fade(1.0 / 0.075, fp);
        let brick = base * (0.8 + 0.4 * c.y) * mix(vec3<f32>(1.0), vec3<f32>(1.08, 0.95, 0.88), hash3(vec3<f32>(floor(uv / 0.15), 1.0)));
        let mortar = mix(vec3<f32>(0.58, 0.56, 0.52), base, 0.2);
        f.albedo = mix(mix(base, mortar, 0.2), mix(brick, mortar, c.x), vis);
        f.ao = 1.0 - 0.25 * c.x * vis;
        f.grad = grain.yzw * 0.004;
        f.spec = 0.06; f.shin = 14.0;
    } else if (kind == 2) {
        // Render, plaster and paint: soft blotches and a trowelled grain.
        f.albedo = base * (0.93 + 0.1 * blotch.x + 0.03 * grain.x);
        f.grad = grain.yzw * 0.006 + blotch.yzw * 0.02;
        f.spec = 0.08; f.shin = 16.0;
    } else if (kind == 3) {
        // Concrete: formwork panels with faint seams and tie holes, and dark weather stains.
        let c = courses(uv, vec2<f32>(2.4, 1.2), 0.012, 0.0);
        let vis = octave_fade(1.0 / 1.2, fp);
        let tie = vec2<f32>(fract(uv.x / 0.6) - 0.5, fract(uv.y / 0.6) - 0.5);
        let hole = (1.0 - smoothstep(0.008, 0.014, length(tie * 0.6))) * octave_fade(16.0, fp);
        f.albedo = base * (0.86 + 0.16 * blotch.x + 0.06 * grain.x) * (1.0 - 0.18 * c.x * vis) * (1.0 - 0.3 * hole) * (0.97 + 0.06 * c.y * vis);
        f.grad = grain.yzw * 0.008;
        f.ao = 1.0 - 0.2 * c.x * vis;
    } else if (kind == 4) {
        // Dressed stone: large blocks, each its own tone, with fine joints.
        let c = courses(uv, vec2<f32>(0.62, 0.34), 0.012, 0.5);
        let vis = octave_fade(1.0 / 0.34, fp);
        f.albedo = base * mix(vec3<f32>(0.96), (0.8 + 0.35 * c.y) * vec3<f32>(1.0) * (1.0 - 0.3 * c.x), vis) * (0.92 + 0.1 * grain.x);
        f.grad = grain.yzw * 0.01;
        f.ao = 1.0 - 0.3 * c.x * vis;
        f.spec = 0.1;
    } else if (kind == 5) {
        // Roof tiles and slates: overlapping courses, each darker at its lower edge.
        let c = courses(uv, vec2<f32>(0.3, 0.24), 0.008, 0.5);
        let vis = octave_fade(1.0 / 0.24, fp);
        let lap = 0.72 + 0.28 * smoothstep(0.0, 0.5, c.z);
        f.albedo = base * mix(vec3<f32>(0.88), (0.82 + 0.3 * c.y) * lap * (1.0 - 0.35 * c.x) * vec3<f32>(1.0), vis) * (0.94 + 0.08 * blotch.x);
        f.ao = mix(0.9, lap, vis);
        f.spec = 0.18; f.shin = 30.0;
    } else if (kind == 6) {
        // Metal: a brushed sheen, dulled in patches.
        f.albedo = base * (0.9 + 0.12 * blotch.x);
        f.spec = 0.55 - 0.25 * smoothstep(0.0, 0.6, blotch.x); f.shin = 70.0;
    } else if (kind == 7) {
        // Wood: boards with their own tone and grain running along them.
        let c = courses(uv, vec2<f32>(2.7, 0.16), 0.006, 0.37);
        let vis = octave_fade(1.0 / 0.16, fp);
        let g = fbm(vec3<f32>(uv.x * 0.15, uv.y * 6.0, c.y * 31.0), 4.0, 3, 0.5, fp);
        f.albedo = base * mix(vec3<f32>(0.95), (0.8 + 0.35 * c.y) * (0.9 + 0.15 * g.x) * (1.0 - 0.4 * c.x) * vec3<f32>(1.0), vis);
        f.ao = 1.0 - 0.3 * c.x * vis;
        f.spec = 0.1; f.shin = 20.0;
    } else {
        f.albedo = base * (0.95 + 0.06 * blotch.x);
    }
    if (wall && kind != 6) {
        // Weathering: grime splashed up from the street, and rain streaks down from the top.
        let h = p.y;
        let splash = 1.0 - 0.28 * (1.0 - smoothstep(0.0, 1.1, h)) * (0.7 + 0.3 * blotch.x);
        let streak = vnoise(vec3<f32>(uv.x * 2.2, h * 0.09, 5.0), TEX_PERIOD).x;
        let rain = 1.0 - 0.12 * smoothstep(0.1, 0.8, streak) * smoothstep(0.5, 3.0, h);
        f.albedo = f.albedo * splash * rain;
        f.ao = f.ao * (0.82 + 0.18 * smoothstep(0.0, 0.6, h));
    }
    return f;
}

// Bare rock: lumpy grain, fracture lines and faint strata along the planet's up direction.
fn rock_surface(base: vec3<f32>, t: vec3<f32>, n: vec3<f32>, up: vec3<f32>, fp: f32) -> Surface {
    var s: Surface;
    let lumps = fbm(t, 1.0 / 16.0, 9, 0.52, fp);
    // Fractures: thin valleys of a ridged field, as dark lines with a dent in the normal.
    let cn = vnoise(t * 0.5 + vec3<f32>(3.0, 11.0, 5.0), TEX_PERIOD * 0.5);
    let cfade = octave_fade(2.0, fp);
    let crack = (1.0 - smoothstep(0.0, 0.07, abs(cn.x))) * cfade;
    let fine = fbm(t, 4.0, 5, 0.6, fp);
    let strata = sin(dot(t, up) * 3.7 + lumps.x * 4.0) * octave_fade(1.0, fp);
    var grad = lumps.yzw * 0.55 + fine.yzw * 0.05;
    grad = grad + sign(cn.x) * cn.yzw * 0.5 * crack * 0.12;
    s.n = bump(n, grad);
    let tone = 0.78 + 0.45 * lumps.x + 0.18 * fine.x + 0.06 * strata;
    let mineral = mix(vec3<f32>(1.0), vec3<f32>(1.08, 0.97, 0.88), smoothstep(-0.2, 0.5, fbm(t, 1.0 / 64.0, 3, 0.5, fp).x));
    s.albedo = base * tone * mineral * (1.0 - 0.55 * crack);
    s.ao = 1.0 - 0.5 * crack;
    s.spec = 0.12;
    s.shin = 24.0;
    return s;
}

// Soil and vegetation: tufts and blades read as fine speckle, with bare earth and pebbles
// between. \`green\` is how vegetated the vertex color is.
fn ground_surface(base: vec3<f32>, t: vec3<f32>, n: vec3<f32>, fp: f32) -> Surface {
    var s: Surface;
    let green = clamp((base.g - max(base.r, base.b)) * 6.0, 0.0, 1.0);
    let clumps = fbm(t, 1.0 / 8.0, 4, 0.5, fp);
    let blades = fbm(t, 8.0, 4, 0.7, fp);
    let dirt = smoothstep(0.05, 0.35, fbm(t + vec3<f32>(19.0), 1.0 / 4.0, 3, 0.5, fp).x - 0.4 * green);
    // Pebbles: a few centimeters across, grey-brown, mostly where the earth is bare.
    let pebble_n = vnoise(t * 16.0 + vec3<f32>(7.0), TEX_PERIOD * 16.0);
    let pebbles = smoothstep(0.55, 0.75, pebble_n.x) * octave_fade(32.0, fp) * (0.25 + 0.75 * dirt);
    let soil = base * vec3<f32>(1.05, 0.86, 0.66) * 0.8;
    var albedo = base * (0.82 + 0.35 * clumps.x) * (0.85 + 0.3 * blades.x * green);
    // Meadow patches tens of meters across: lusher, darker swards and drier, yellower ones.
    let sward = fbm(t + vec3<f32>(41.0, 7.0, 23.0), 1.0 / 32.0, 3, 0.5, fp).x;
    albedo = mix(albedo, albedo * vec3<f32>(1.16, 1.04, 0.6), smoothstep(0.0, 0.45, sward) * green * 0.5);
    albedo = mix(albedo, albedo * vec3<f32>(0.74, 0.92, 0.78), smoothstep(0.0, -0.4, sward) * green * 0.55);
    albedo = mix(albedo, soil * (0.9 + 0.2 * blades.x), dirt * 0.7);
    let stone = mix(soil, vec3<f32>(0.1, 0.095, 0.09), 0.5) * (0.8 + 0.4 * pebble_n.x);
    albedo = mix(albedo, stone, pebbles * 0.7);
    s.albedo = albedo;
    s.n = bump(n, clumps.yzw * 0.25 + blades.yzw * 0.012 * (1.0 - dirt) + pebble_n.yzw * 16.0 * 0.004 * pebbles);
    s.ao = 0.85 + 0.15 * blades.x;
    s.spec = 0.05;
    s.shin = 12.0;
    return s;
}

// Snow: soft wind-blown drifts and a sparkle of crystals.
fn snow_surface(base: vec3<f32>, t: vec3<f32>, n: vec3<f32>, fp: f32) -> Surface {
    var s: Surface;
    let drifts = fbm(t, 1.0 / 8.0, 5, 0.45, fp);
    s.n = bump(n, drifts.yzw * 0.2);
    s.albedo = base * (0.94 + 0.08 * drifts.x);
    s.ao = 1.0;
    // Crystals: rare lattice cells glint (only close enough for a cell to be a few pixels).
    let cell = floor(t * 16.0);
    let glint = step(0.994, hash3(cell)) * octave_fade(16.0, fp);
    s.spec = 0.25 + glint * 30.0;
    s.shin = 60.0 + glint * 400.0;
    return s;
}

fn blend_surface(a: Surface, b: Surface, t: f32) -> Surface {
    var s: Surface;
    s.albedo = mix(a.albedo, b.albedo, t);
    s.n = normalize(mix(a.n, b.n, t));
    s.spec = mix(a.spec, b.spec, t);
    s.shin = mix(a.shin, b.shin, t);
    s.ao = mix(a.ao, b.ao, t);
    return s;
}

// Ray (origin o, unit dir d) against a sphere: (t_enter, t_exit), or t_exit < 0 when missed.
fn sphere_hit(o: vec3<f32>, d: vec3<f32>, c: vec3<f32>, r: f32) -> vec2<f32> {
    let oc = o - c;
    let b = dot(oc, d);
    // |oc|^2 - r^2 as a product: on Earth both squares are ~4e13, and their f32 difference
    // would lose everything below a few hundred meters of altitude.
    let l = length(oc);
    let h = b * b - (l - r) * (l + r);
    if (h < 0.0) { return vec2<f32>(1.0, -1.0); }
    let s = sqrt(h);
    return vec2<f32>(-b - s, -b + s);
}

// Palette colors are authored in sRGB; lighting happens in linear space.
fn linear(c: vec3<f32>) -> vec3<f32> {
    return pow(max(c, vec3<f32>(0.0)), vec3<f32>(2.2));
}

fn atmo_color(i: i32) -> vec3<f32> {
    return linear(world.atmosphere[i].rgb);
}

// How lit the atmosphere/ground is at a point above planet i (soft terminator).
fn daylight(p: vec3<f32>, i: i32) -> f32 {
    let up = normalize(p - world.planet[i].xyz);
    return smoothstep(-0.22, 0.28, dot(up, world.sun_dir.xyz));
}

// Scattered light and remaining transmittance along the camera ray segment [t0, t1] through
// planet i's atmosphere shell.
struct Haze { light: vec3<f32>, transmit: f32 };

// k is the scattering strength: the sky integrates the whole shell (k ~ 1.2), while the haze in
// front of terrain is much lighter (k ~ 0.1) or the ground would vanish a few hundred meters out.
// extinction is how much lit air hides what is behind it: strongly for stars (they vanish by
// day), no more than the haze adds for terrain (it fades into the haze, not into black).
fn atmosphere_segment(o: vec3<f32>, d: vec3<f32>, i: i32, t_max: f32, k: f32, extinction: f32) -> Haze {
    var out: Haze;
    out.light = vec3<f32>(0.0);
    out.transmit = 1.0;
    let c = world.planet[i].xyz;
    let r = world.planet[i].w;
    let h = world.atmosphere[i].w;
    let hit = sphere_hit(o, d, c, r + h);
    if (hit.y < 0.0) { return out; }
    let t0 = max(hit.x, 0.0);
    let t1 = min(hit.y, t_max);
    if (t1 <= t0) { return out; }
    let len = t1 - t0;
    // Density grows toward the ground: weight by how deep the segment's middle sits.
    let mid = o + d * ((t0 + t1) * 0.5);
    let depth = clamp(1.0 - (length(mid - c) - r) / h, 0.0, 1.0);
    let optical = len / h * (0.35 + 0.9 * depth * depth);
    let day = daylight(mid, i);
    let sun_d = max(dot(d, world.sun_dir.xyz), 0.0);
    let forward = 1.0 + 1.6 * pow(sun_d, 6.0);
    let amount = 1.0 - exp(-optical * k);
    // Thick, low paths bleach toward white (the horizon), thin ones keep the color.
    let tint = mix(atmo_color(i), vec3<f32>(1.0, 0.97, 0.92), clamp(optical * 0.05, 0.0, 0.3));
    out.light = tint * amount * day * forward * 1.15;
    // By day the lit air hides what is behind it (stars vanish); at night it is transparent.
    out.transmit = mix(1.0, exp(-optical * k * extinction), day);
    return out;
}

fn stars(d: vec3<f32>) -> vec3<f32> {
    var col = vec3<f32>(0.0);
    for (var layer = 0; layer < 2; layer = layer + 1) {
        let scale = select(260.0, 120.0, layer == 1);
        let q = d * scale;
        let cell = floor(q);
        let h = hash3(cell + f32(layer) * 17.0);
        if (h > 0.985) {
            let center = cell + vec3<f32>(hash3(cell + 3.1), hash3(cell + 7.7), hash3(cell + 1.3));
            let dist = length(q - center);
            let b = smoothstep(0.32, 0.0, dist) * (h - 0.985) * 66.0;
            let warm = hash3(cell + 9.9);
            col = col + b * mix(vec3<f32>(0.75, 0.82, 1.0), vec3<f32>(1.0, 0.85, 0.7), warm);
        }
    }
    // A faint band of milky light.
    let band = exp(-pow(dot(d, normalize(vec3<f32>(0.2, 0.9, -0.35))) * 3.2, 2.0));
    col = col + vec3<f32>(0.05, 0.045, 0.07) * band;
    return col;
}

fn planet_of(p: vec3<f32>) -> i32 {
    var best = 0;
    var best_d = 1e30;
    let count = i32(world.params.z);
    for (var i = 0; i < count; i = i + 1) {
        let dd = length(p - world.planet[i].xyz) - world.planet[i].w;
        if (dd < best_d) { best_d = dd; best = i; }
    }
    return best;
}

fn finish(c: vec3<f32>) -> vec4<f32> {
    return vec4<f32>(pow(aces(c * world.params.x), vec3<f32>(1.0 / 2.2)), 1.0);
}

// A distinct hue per quadtree level (golden-ratio steps around the color wheel).
fn lod_color(level: f32) -> vec3<f32> {
    let k = fract(level * 0.618034 + 0.08) * 6.0;
    return clamp(vec3<f32>(abs(k - 3.0) - 1.0, 2.0 - abs(k - 2.0), 2.0 - abs(k - 4.0)), vec3<f32>(0.0), vec3<f32>(1.0));
}

// --- Clouds ----------------------------------------------------------------------------------

const CLOUD_PERIOD: f32 = ${CLOUD_PERIOD}.0;

// Cloud density (0..1) at a point (render space) of the cloud layer: broad billows with ragged
// edges, thinned by the cover. \`octaves\` trades detail for cost (ground shadows need few).
fn cloud_density(p: vec3<f32>, octaves: i32) -> f32 {
    let cover = world.cloud.w;
    if (cover <= 0.0) { return 0.0; }
    let q = p + world.cloud.xyz;
    var sum = 0.0;
    var amp = 0.5;
    var freq = 1.0 / 4096.0;
    for (var o = 0; o < octaves; o = o + 1) {
        sum = sum + vnoise(q * freq + vec3<f32>(f32(o) * 5.0, f32(o) * 13.0, f32(o) * 3.0), CLOUD_PERIOD * freq).x * amp;
        amp = amp * 0.5;
        freq = freq * 2.0;
    }
    return smoothstep(1.0 - cover * 1.15, 1.25 - cover * 0.9, sum + 0.5);
}

// Where a ray from o along unit d crosses planet i's cloud layer (meters along it), or -1.
fn cloud_hit(o: vec3<f32>, d: vec3<f32>, i: i32) -> f32 {
    let hit = sphere_hit(o, d, world.planet[i].xyz, world.planet[i].w + world.wind.w);
    if (hit.y < 0.0) { return -1.0; }
    // From under the layer the ray leaves through its far side; from above, it enters it first.
    return select(hit.y, hit.x, hit.x > 0.0);
}

// How much sun gets through the clouds to point p.
fn cloud_shadow(p: vec3<f32>, sun: vec3<f32>, i: i32) -> f32 {
    if (world.cloud.w <= 0.0 || i != 0) { return 1.0; }
    let t = cloud_hit(p, sun, i);
    if (t < 0.0) { return 1.0; }
    return 1.0 - 0.62 * cloud_density(p + sun * t, 3);
}

// Clouds over the sky color \`col\` along view ray d from the camera.
fn sky_clouds(col: vec3<f32>, cam: vec3<f32>, d: vec3<f32>, sun: vec3<f32>) -> vec3<f32> {
    if (world.cloud.w <= 0.0) { return col; }
    let c = world.planet[0].xyz;
    let up = normalize(cam - c);
    let alt = length(cam - c) - world.planet[0].w;
    if (alt > world.wind.w) { return col; }
    let t = cloud_hit(cam, d, 0);
    if (t < 0.0) { return col; }
    let p = cam + d * t;
    let dens = cloud_density(p, 6);
    if (dens <= 0.001) { return col; }
    // Light through the cloud toward the sun: denser there means a darker, bluer underside.
    let toward = cloud_density(p + sun * 350.0, 4);
    let day = daylight(p, 0);
    let sun_h = smoothstep(-0.1, 0.35, dot(up, sun));
    let warm = mix(vec3<f32>(1.0, 0.62, 0.38), vec3<f32>(1.0), sun_h);
    let lit = world.sun_color.rgb * warm * (1.25 - 0.85 * toward) * day;
    let shade = linear(world.atmosphere[0].rgb) * 0.45 * day + vec3<f32>(0.03, 0.035, 0.045);
    let silver = pow(max(dot(d, sun), 0.0), 8.0) * (1.0 - dens) * 1.5 * world.sun_color.rgb * day;
    var cloud = mix(shade, lit, 0.55 + 0.45 * (1.0 - dens)) + silver;
    // Far clouds sink into the haze toward the horizon.
    let fade = smoothstep(0.0, 0.12, dot(d, up)) * exp(-t / 60000.0);
    return mix(col, cloud, clamp(dens * 1.3, 0.0, 1.0) * fade);
}

// How much direct sun reaches a surface point (1 = all): cloud shadows here; games add cast
// shadows (al_shader.ts).
fn sun_visibility(p: vec3<f32>, n: vec3<f32>, view_w: f32, i: i32) -> f32 {
    return cloud_shadow(p, normalize(world.sun_dir.xyz), i);
}

@fragment
fn fs_main(in: VertexOutput) -> FragmentOutput {
    var out: FragmentOutput;
    let material = i32(floor(in.uv.x + 0.0005));
    let cam = camera.view_pos.xyz;
    let sun = normalize(world.sun_dir.xyz);
    let count = i32(world.params.z);
    // One pixel's width on the surface, in meters: texture octaves finer than this fade out.
    // (Derivatives are taken here, in uniform control flow, for every material.)
    let footprint = max(length(fwidth(in.tex_pos)), 1.0e-4);
    let chunk_edge_fw = fwidth(in.uv);
    // Building box windows: cells along the wall and up it (used by material 8).
    let wall_dir = normalize(vec2<f32>(-in.local_normal.z, in.local_normal.x) + vec2<f32>(1.0e-6, 0.0));
    let win_uv = vec2<f32>(dot(in.tex_pos.xz, wall_dir) / 3.0, in.color.a / 3.2);
    let win_fw = max(fwidth(win_uv.x), fwidth(win_uv.y));

    if (material == 9) {
        let d = normalize(in.world_pos - cam);
        var col = stars(d);
        let sd = dot(d, sun);
        col = col + world.sun_color.rgb * (smoothstep(0.99955, 0.9998, sd) * 30.0 + pow(max(sd, 0.0), 900.0) * 3.0 + pow(max(sd, 0.0), 12.0) * 0.06);
        for (var i = 0; i < count; i = i + 1) {
            // Rays that hit a planet are covered by its terrain; this is the sky around it.
            let hz = atmosphere_segment(cam, d, i, 1e9, 1.2, 3.0);
            col = col * hz.transmit + hz.light;
        }
        col = sky_clouds(col, cam, d, sun);
        out.color = finish(col);
        out.depth = SKY_DEPTH;
        return out;
    }
    out.depth = log_depth(in.view_w);
    if (material == 10) {
        // Roads: gone past the road distance, and pulled toward the camera in depth (a few meters
        // at a kilometer) so they stay over whatever terrain chunk is drawn under them.
        if (in.view_w > world.city.y) { discard; }
        out.depth = log_depth(max(in.view_w * 0.996 - 0.05, 0.01));
    }
    if (material == 7) {
        // See-through window glass: leave the alpha share of the pane unpainted (4 x 4 ordered
        // dither), less at grazing angles where glass mirrors more.
        let vv = normalize(camera.view_pos.xyz - in.world_pos);
        let fr = pow(1.0 - abs(dot(normalize(in.normal), vv)), 3.0);
        let keep = 1.0 - in.color.a * (1.0 - fr);
        let c = vec2<u32>(in.clip_position.xy);
        let b2 = ((c.x ^ c.y) & 1u) * 2u + (c.y & 1u);
        let b4 = b2 * 4u + (((c.x >> 1u) ^ (c.y >> 1u)) & 1u) * 2u + ((c.y >> 1u) & 1u);
        if ((f32(b4) + 0.5) / 16.0 > keep) { discard; }
    }

    let pi = planet_of(in.world_pos);
    let pc = world.planet[pi].xyz;
    var n = normalize(in.normal);
    let v_vec = cam - in.world_pos;
    let dist = length(v_vec);
    let v = v_vec / max(dist, 0.0001);
    let up = normalize(in.world_pos - pc);
    let day = daylight(in.world_pos, pi);
    let atmo = atmo_color(pi);
    var base = linear(in.color.rgb);
    var col = vec3<f32>(0.0);
    let sun_vis = sun_visibility(in.world_pos, n, in.view_w, pi);

    if (material == 4) {
        col = base * (1.1 + item.tint.w * 2.2);
    } else if (material == 5 || material == 7) {
        let r = reflect(-v, n);
        let fres = 0.08 + 0.92 * pow(1.0 - max(dot(n, v), 0.0), 4.0);
        let sky_amb = atmo * (0.22 + 0.18 * max(dot(n, up), 0.0)) * day + vec3<f32>(0.012, 0.014, 0.02);
        col = base * 0.12 + sky_amb * 0.6 * fres + world.sun_color.rgb * pow(max(dot(r, sun), 0.0), 180.0) * 3.0 * sun_vis;
    } else {
        if (material == 3 || material == 6 || material == 11) { base = base * item.tint.rgb; }
        var spec = 0.0;
        var shin = 16.0;
        var ao = 1.0;
        let t = in.tex_pos;
        if (material == 0) {
            // Terrain: rock where the vertex says so, snow by its color, soil and grass elsewhere.
            let rock_w = smoothstep(0.15, 0.75, in.color.a);
            let snow_w = smoothstep(0.72, 0.86, min(in.color.r, min(in.color.g, in.color.b))) * (1.0 - rock_w);
            var g = ground_surface(base, t, n, footprint);
            if (snow_w > 0.0) { g = blend_surface(g, snow_surface(base, t, n, footprint), snow_w); }
            if (rock_w > 0.0) { g = blend_surface(g, rock_surface(base, t, n, up, footprint), rock_w); }
            base = g.albedo;
            n = g.n;
            spec = g.spec;
            shin = g.shin;
            ao = g.ao;
        } else if (material == 1) {
            // Water: wind ripples drifting with time.
            let time = world.sun_dir.w;
            let waves = fbm(t + vec3<f32>(time * 0.6, 0.0, time * 0.35), 1.0 / 8.0, 6, 0.55, footprint);
            let chop = fbm(t - vec3<f32>(time * 0.9, 0.0, -time * 0.5), 1.0 / 2.0, 4, 0.5, footprint);
            n = bump(n, waves.yzw * 0.12 + chop.yzw * 0.03);
            spec = 1.2;
            shin = 140.0;
        } else if (material == 8) {
            // Building boxes: rows of windows on the walls (from the height above the building's
            // anchor and the distance along the wall), faded to their average once a window is
            // under a couple of pixels.
            let ln = normalize(in.local_normal);
            if (abs(ln.y) < 0.5) {
                let v = win_uv.y;
                let fw = win_fw;
                let cell = fract(win_uv);
                let inside = step(0.22, cell.x) * step(cell.x, 0.78) * step(0.3, cell.y) * step(cell.y, 0.82) * step(1.0, v);
                let glass = vec3<f32>(0.05, 0.065, 0.085);
                let w = mix(inside, 0.29 * step(1.0, v), smoothstep(0.15, 0.4, fw));
                base = mix(base, glass, w);
                spec = 0.6 * w;
                shin = 90.0;
            }
        } else if (material == 10) {
            // Roads: a little grain and wear.
            let g = fbm(t, 1.0 / 2.0, 4, 0.5, footprint);
            base = base * (0.9 + 0.12 * g.x);
            spec = 0.08;
            shin = 20.0;
        } else if (material == 11) {
            // City surfaces: brick, render, concrete, stone, tiles, metal, wood (see the top).
            let f = city_surface(i32(floor(in.uv.y + 0.0005)), base, in.tex_pos, normalize(in.local_normal), footprint);
            base = f.albedo;
            spec = f.spec;
            shin = f.shin;
            ao = f.ao;
            n = bump(n, (item.model * vec4<f32>(f.grad, 0.0)).xyz);
        } else if (material == 2) {
            // Ice: smooth sheets with pale fracture lines.
            let sheet = fbm(t, 1.0 / 16.0, 5, 0.5, footprint);
            let cn = vnoise(t * 0.25, TEX_PERIOD * 0.25);
            let crack = (1.0 - smoothstep(0.0, 0.05, abs(cn.x))) * octave_fade(1.0, footprint);
            n = bump(n, sheet.yzw * 0.06);
            base = base * (0.95 + 0.1 * sheet.x) + vec3<f32>(0.12) * crack;
            spec = 0.45;
            shin = 40.0;
        }
        if (material == 3) { spec = 0.35; shin = 48.0; }
        if (material == 6) { spec = 0.12; shin = 24.0; }
        let ndl = max(dot(n, sun), 0.0);
        // Sky light from above (colored by the atmosphere by day) and a little starlight at night.
        let sky_amb = atmo * (0.22 + 0.18 * max(dot(n, up), 0.0)) * day + vec3<f32>(0.012, 0.014, 0.02);
        let h = normalize(sun + v);
        let s = pow(max(dot(n, h), 0.0), shin) * spec * ndl;
        // Terminator softening: the ground's own normal and the planet's curvature both count.
        let lit = ndl * smoothstep(-0.12, 0.2, dot(up, sun)) * sun_vis;
        col = base * (world.sun_color.rgb * lit * 1.35 + sky_amb * ao) + world.sun_color.rgb * s * smoothstep(-0.12, 0.2, dot(up, sun)) * sun_vis;
        // Ship and suit: a faint fill from the camera so a back-lit model still reads.
        if (material == 3 || material == 6 || material == 8 || material == 11) { col = col + base * 0.14 * max(dot(n, v), 0.0); }
        if (material == 1) {
            let fres = pow(1.0 - max(dot(n, v), 0.0), 5.0);
            col = col + atmo * fres * 0.5 * day;
        }
        if (world.params.y > 0.5 && material <= 2) {
            let level = floor(in.uv.y + 0.0005);
            let tint = linear(lod_color(level)) * (0.25 + 0.75 * lit + 0.1);
            col = mix(col, tint, 0.6);
        }
        if (world.params.w > 0.5 && material <= 2) {
            // Outline every chunk (a drawn line, not a gap): white, so it can't pass for a crack
            // showing the dark space behind the ground.
            let level = floor(in.uv.y + 0.0005);
            let local = vec2<f32>(in.uv.x - f32(material), in.uv.y - level);
            let edge = min(min(local.x, 1.0 - local.x), min(local.y, 1.0 - local.y));
            let line = 1.0 - smoothstep(0.0, max(max(chunk_edge_fw.x, chunk_edge_fw.y) * 1.5, 0.0001), edge - 0.001);
            col = mix(col, vec3<f32>(1.0), line * 0.8);
        }
    }

    // Aerial perspective through every atmosphere between the camera and this point.
    for (var i = 0; i < count; i = i + 1) {
        let hz = atmosphere_segment(cam, -v, i, dist, 0.1, 1.0);
        col = col * hz.transmit + hz.light;
    }
    out.color = finish(col);
    return out;
}
`;

function injectOnce(src: string, anchor: string, replacement: string): string {
    if (src.split(anchor).length !== 2) throw new Error(`instancedShader: anchor not found exactly once: ${anchor}`);
    return src.replace(anchor, replacement);
}

/**
 * The same shader drawing many instances of one mesh (qp_instances.ts): instead of one Item
 * uniform per object, group 2 binding 1 is a read-only storage array of records indexed by
 * @builtin(instance_index). The vertex stage passes the index on as a flat varying so the
 * fragment stage reads the same record. `load` fills the private `item` (and anything else the
 * caller declared in `declarations`) from `instances[i]`; by default a record is an Item.
 */
export function instancedShader(src: string, options: { recordType?: string; declarations?: string; load?: string } = {}): string {
    const record = options.recordType ?? "Item";
    let s = injectOnce(src, "@group(2) @binding(1) var<uniform> item: Item;", `${options.declarations ?? ""}
@group(2) @binding(1) var<storage, read> instances: array<${record}>;
var<private> item: Item;
fn load_instance(i: u32) {
    ${options.load ?? "item = instances[i];"}
}`);
    s = injectOnce(s, "    @location(3) color: vec4<f32>,\n};\n\nstruct VertexOutput {", "    @location(3) color: vec4<f32>,\n    @builtin(instance_index) instance: u32,\n};\n\nstruct VertexOutput {");
    s = injectOnce(s, "    @location(6) local_normal: vec3<f32>,\n};", "    @location(6) local_normal: vec3<f32>,\n    @location(7) @interpolate(flat) instance: u32,\n};");
    s = injectOnce(s, "fn vertex_common(in: VertexInput) -> VertexOutput {\n    var out: VertexOutput;\n", "fn vertex_common(in: VertexInput) -> VertexOutput {\n    var out: VertexOutput;\n    load_instance(in.instance);\n    out.instance = in.instance;\n");
    s = injectOnce(s, "fn fs_main(in: VertexOutput) -> FragmentOutput {\n", "fn fs_main(in: VertexOutput) -> FragmentOutput {\n    load_instance(in.instance);\n");
    return s;
}

/** QUADPLANET_SHADER for instanced batches of Items (houses). */
export const QUADPLANET_INSTANCED_SHADER = instancedShader(QUADPLANET_SHADER);
