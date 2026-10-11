// The Abyss's one shader. Everything is drawn by it: the terrain, the sky, Mesha objects (whose
// surfaces - wood, fabric, rust, skin, hair, glass... - come straight from Mesha's viewport shader,
// lifted out by anchor so the game always matches what Mesha shows), animated people, and the
// effects (fire, smoke, magic, the Source's waterfall, searchlight beams, rotor blur).
//
// Vertices use the engine's `mesh` layout as Mesha packs it (mesha_scene.ts packVertices): the
// normal's length is 1 + a surface pattern id; color is the sRGB base color with roughness and a
// metal flag in alpha. The game's own pattern ids start at 30:
//
//   30 terrain (uv = scorch, riverbed; color.r = paved, color.g = strata seed)
//   31 the land beyond the map          40 sky dome
//   41 magic (bolts, the warriors' wards, the surge): self-lit, tint color, swirling
//   42 fire   43 smoke / dust           44 the Source's waterfall
//   45 light beam (searchlights, the Source's shaft)    46 tracer
//   47 rotor blur disc                  48 scorch decal (ground)
//   49 glowing moss / crystal (self-lit, pulsing)
//
// Lighting: the sun, shadowed by the crack's walls (baked into the light map: ab_world.ts
// LightMap) and by objects (the engine's sun-shadow cascades, group 3); skylight, reduced where
// the walls hide the sky; light bounced off the walls; up to 16 point lights (muzzle flashes,
// fires, magic, lamps); then fog that thickens into the abyss as dust hangs in it.
//
// People (item.anim.w = 1): uv.y's integer part says which limb a vertex belongs to (0 rigid, 1/2
// left/right leg, 3/4 left/right arm), its fraction / 0.49 how much (blending into the torso);
// legs swing about the hip and arms about the shoulder by sin(phase) * amplitude. anim.z picks a
// pose for the arms: 1 aiming a rifle, 2 casting (right arm thrust up and forward), 3 a melee
// swing (right arm at extra.w radians).

import { MESHA_SHADER } from "../../apps/mesha/mesha_shader";

export const PATTERN = {
    terrain: 30, outer: 31, sky: 40, magic: 41, fire: 42, smoke: 43, waterfall: 44, beam: 45,
    tracer: 46, rotor: 47, scorch: 48, moss: 49,
} as const;

/** Hip and shoulder pivots of Mesha's default human (meters above the soles). */
export const HIP = 0.92;
export const SHOULDER = 1.42;

export const MAX_LIGHTS = 16;
/** Floats in the World uniform: 12 vec4 of parameters, then two vec4 per point light. */
export const WORLD_FLOATS = (12 + MAX_LIGHTS * 2) * 4;
/** Floats per Item (a uniform, or one record of an instanced batch). */
export const ITEM_FLOATS = 28;

function between(src: string, from: string, to: string): string {
    const a = src.indexOf(from), b = src.indexOf(to, a + 1);
    if (a < 0 || b < 0) throw new Error(`Abyss shader: Mesha shader anchor not found: ${a < 0 ? from : to}`);
    return src.slice(a, b);
}

/** Mesha's noise helpers (hash3, vnoise, fbm). */
const MESHA_NOISE = between(MESHA_SHADER, "fn hash3(", "// The studio environment");
/** Mesha's surface patterns: everything from its glass pane to its rust, reading `uvp` for uv. */
const MESHA_PATTERNS = between(MESHA_SHADER, "    if (pattern == 16) {", "    let key = normalize(studio.key_dir.xyz);").split("in.uv").join("uvp");

const COMMON = /* wgsl */ `
struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0) var<uniform> camera: Camera;

struct Light { pos: vec4<f32>, color: vec4<f32> };

struct World {
    sun_dir: vec4<f32>,        // xyz toward the sun, w = time (s)
    sun_color: vec4<f32>,      // rgb, w = intensity
    sky_zenith: vec4<f32>,     // rgb, w = exposure
    sky_horizon: vec4<f32>,    // rgb, w = base haze density (1/m)
    bounce: vec4<f32>,         // rgb light bounced off the walls, w = abyss dust density at the floor (1/m)
    dust: vec4<f32>,           // rgb dust in shadow, w = dust scale height (m)
    map: vec4<f32>,            // map half size, light map min y, light map range, light map size
    source: vec4<f32>,         // the Source's light: rgb, w = intensity
    source_pos: vec4<f32>,     // xyz, w = reach (m)
    grade: vec4<f32>,          // x saturation, y contrast, z fade to black (0..1), w vignette
    screen: vec4<f32>,         // viewport w, h, floor y, light count
    misc: vec4<f32>,           // x camera's sun visibility, y flash (white, 0..1), z flash hue (0 white, 1 magic), w surge
    lights: array<Light, ${MAX_LIGHTS}>,
};
@group(2) @binding(0) var<uniform> world: World;

struct Item {
    model: mat4x4<f32>,
    tint: vec4<f32>,           // rgb multiplier / effect color, w = glow or heat
    anim: vec4<f32>,           // x walk phase, y swing amplitude, z arm pose, w person (1)
    extra: vec4<f32>,          // x opacity (dither), y flags (1 view model, 2 no fog), z rim highlight, w melee swing angle
};
ITEM_BINDING
@group(2) @binding(2) var light_map: texture_2d<f32>;

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
    @location(4) @interpolate(flat) tint: vec4<f32>,
    @location(5) @interpolate(flat) anim: vec4<f32>,
    @location(6) @interpolate(flat) extra: vec4<f32>,
    @location(7) local_pos: vec3<f32>,
    // The surface pattern, exact per vertex: an interpolated normal's length shrinks across a
    // sharp crease (a cliff's edge), which would read as another pattern.
    @location(8) @interpolate(flat) pattern: f32,
};

struct Posed { world_pos: vec3<f32>, normal: vec3<f32> };

fn rot_x(v: vec3<f32>, a: f32) -> vec3<f32> {
    let c = cos(a);
    let s = sin(a);
    return vec3<f32>(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
}

// The vertex in the world: people's limbs posed first (see the file comment).
fn pose_vertex(in: VertexInput, it: Item) -> Posed {
    var pos = in.position;
    var nrm = in.normal;
    if (it.anim.w > 0.5) {
        let limb = i32(floor(in.tex_coords.y + 0.0005));
        if (limb > 0) {
            let weight = clamp(fract(in.tex_coords.y) / 0.49, 0.0, 1.0);
            let side = select(-1.0, 1.0, limb == 1 || limb == 3);
            // Positive angles swing a limb forward (+Z, the way Mesha's human faces).
            var ang = sin(it.anim.x) * it.anim.y * side;
            var pivot = vec3<f32>(0.0, ${HIP}, 0.0);
            if (limb >= 3) {
                pivot = vec3<f32>(0.0, ${SHOULDER}, 0.0);
                ang = -ang * 0.8;
                let pose = i32(round(it.anim.z));
                if (pose == 1) { ang = select(1.2, 1.5, limb == 4); }
                if (pose == 2) { ang = select(0.35, 2.55, limb == 4); }
                if (pose == 3) { ang = select(0.5, it.extra.w, limb == 4); }
                if (pose == 4) { ang = select(-0.15, -0.15, limb == 4); }
            }
            ang = ang * weight;
            let q = pos - pivot;
            pos = pivot + rot_x(q, -ang);
            let len = length(nrm);
            nrm = rot_x(nrm, -ang);
            nrm = normalize(nrm) * len;
        }
    }
    var out: Posed;
    out.world_pos = (it.model * vec4<f32>(pos, 1.0)).xyz;
    out.normal = normalize((it.model * vec4<f32>(nrm, 0.0)).xyz) * length(nrm);
    return out;
}

@vertex
fn vs_main(in: VertexInput, @builtin(instance_index) ii: u32) -> VertexOutput {
    let it = ITEM_FETCH;
    let posed = pose_vertex(in, it);
    var out: VertexOutput;
    out.clip_position = camera.view_proj * vec4<f32>(posed.world_pos, 1.0);
    out.world_pos = posed.world_pos;
    out.normal = posed.normal;
    out.uv = in.tex_coords;
    out.color = in.color;
    out.tint = it.tint;
    out.anim = it.anim;
    out.extra = it.extra;
    out.local_pos = in.position;
    out.pattern = round(length(in.normal) - 1.0);
    return out;
}

// Cast into the sun's cascades: not the terrain (its shadows are baked), the sky, glowing things,
// effects, or the weapon held at the eye.
@vertex
fn vs_shadow(in: VertexInput, @builtin(instance_index) ii: u32) -> @builtin(position) vec4<f32> {
    let it = ITEM_FETCH;
    let pattern = i32(round(length(in.normal) - 1.0));
    let skip = pattern == 30 || pattern == 31 || pattern >= 40 || pattern == 11 || it.extra.y >= 0.5 || it.extra.x < 0.5;
    if (skip) { return vec4<f32>(0.0, 0.0, 2.0, 1.0); }
    let posed = pose_vertex(in, it);
    return camera.view_proj * vec4<f32>(posed.world_pos, 1.0);
}

${MESHA_NOISE}

fn vnoise2(p: vec2<f32>) -> f32 { return vnoise(vec3<f32>(p.x, 0.37, p.y)); }

fn aces(x: vec3<f32>) -> vec3<f32> {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn dither_keep(clip: vec4<f32>, keep: f32) -> bool {
    let c = vec2<u32>(clip.xy);
    let b2 = ((c.x ^ c.y) & 1u) * 2u + (c.y & 1u);
    let b4 = b2 * 4u + (((c.x >> 1u) ^ (c.y >> 1u)) & 1u) * 2u + ((c.y >> 1u) & 1u);
    return (f32(b4) + 0.5) / 16.0 <= keep;
}

// --- The light map (ab_world.ts LightMap) --------------------------------------------------------

struct LightSample { top: f32, sky: f32, ground: f32 };

fn light_texel(i: i32, j: i32) -> vec4<f32> {
    let n = i32(world.map.w);
    return textureLoad(light_map, vec2<i32>(clamp(i, 0, n - 1), clamp(j, 0, n - 1)), 0);
}

fn decode_light(t: vec4<f32>) -> LightSample {
    var s: LightSample;
    s.top = world.map.y + (t.r * 255.0 * 256.0 + t.g * 255.0) / 65535.0 * world.map.z;
    s.sky = t.b;
    s.ground = world.map.y + t.a * world.map.z;
    return s;
}

fn light_at(p: vec3<f32>) -> LightSample {
    let n = world.map.w;
    let g = (p.xz + vec2<f32>(world.map.x)) / (2.0 * world.map.x) * n - vec2<f32>(0.5);
    let i = i32(floor(g.x));
    let j = i32(floor(g.y));
    let f = g - floor(g);
    let a = decode_light(light_texel(i, j));
    let b = decode_light(light_texel(i + 1, j));
    let c = decode_light(light_texel(i, j + 1));
    let d = decode_light(light_texel(i + 1, j + 1));
    var s: LightSample;
    s.top = mix(mix(a.top, b.top, f.x), mix(c.top, d.top, f.x), f.y);
    s.sky = mix(mix(a.sky, b.sky, f.x), mix(c.sky, d.sky, f.x), f.y);
    s.ground = mix(mix(a.ground, b.ground, f.x), mix(c.ground, d.ground, f.x), f.y);
    let inside = abs(p.x) < world.map.x && abs(p.z) < world.map.x;
    if (!inside) { s.top = -10000.0; s.sky = 1.0; s.ground = p.y; }
    return s;
}

// The walls' shadow (soft over a few meters) and how much sky a point sees.
fn wall_sun(p: vec3<f32>, ls: LightSample) -> f32 {
    return smoothstep(-3.0, 3.0, p.y - ls.top);
}
fn sky_seen(p: vec3<f32>, ls: LightSample) -> f32 {
    let above = clamp((p.y - ls.ground) / max(40.0, -ls.ground + 20.0), 0.0, 1.0);
    return mix(ls.sky, 1.0, above);
}
`;

// Cascaded sun shadows (core/addon_sun_shadows.rs), as Allegiance draws them.
const SHADOW_WGSL = /* wgsl */ `
struct SunShadow {
    cascades: array<mat4x4<f32>, 4>,
    texel: vec4<f32>,
    params: vec4<f32>,         // x = cascades, y = map size, z = strength, w = depth per meter
};
@group(3) @binding(0) var shadow_maps: texture_depth_2d_array;
@group(3) @binding(1) var shadow_sampler: sampler_comparison;
@group(3) @binding(2) var<uniform> sun_shadow: SunShadow;

struct CascadeHit { lit: f32, edge: f32 };

fn cascade_lookup(p: vec3<f32>, n: vec3<f32>, k: i32) -> CascadeHit {
    var out: CascadeHit;
    out.lit = 1.0;
    let texel = sun_shadow.texel[k];
    let q = p + n * texel * 1.5;
    let c = sun_shadow.cascades[k] * vec4<f32>(q, 1.0);
    let uv = vec2<f32>(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
    out.edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
    if (out.edge <= 0.0 || c.z >= 1.0) { out.edge = -1.0; return out; }
    let depth = c.z - texel * sun_shadow.params.w;
    let step = 1.0 / sun_shadow.params.y;
    var sum = 0.0;
    for (var y = -1; y <= 1; y = y + 1) {
        for (var x = -1; x <= 1; x = x + 1) {
            sum = sum + textureSampleCompareLevel(shadow_maps, shadow_sampler, uv + vec2<f32>(f32(x), f32(y)) * step * 1.2, k, depth);
        }
    }
    out.lit = sum / 9.0;
    return out;
}

fn cast_shadow(p: vec3<f32>, n: vec3<f32>) -> f32 {
    let count = i32(sun_shadow.params.x);
    for (var k = 0; k < count; k = k + 1) {
        let a = cascade_lookup(p, n, k);
        if (a.edge < 0.0) { continue; }
        let blend = smoothstep(0.0, 0.1, a.edge);
        if (blend >= 1.0) { return mix(1.0, a.lit, sun_shadow.params.z); }
        var next = 1.0;
        if (k + 1 < count) {
            let b = cascade_lookup(p, n, k + 1);
            if (b.edge >= 0.0) { next = b.lit; }
        }
        return mix(1.0, mix(next, a.lit, blend), sun_shadow.params.z);
    }
    return 1.0;
}
`;

const FRAGMENT = /* wgsl */ `
// --- Sky -----------------------------------------------------------------------------------------

fn sky_color(d: vec3<f32>) -> vec3<f32> {
    let sun = normalize(world.sun_dir.xyz);
    let up = clamp(d.y, -1.0, 1.0);
    var col = mix(world.sky_horizon.rgb, world.sky_zenith.rgb, pow(clamp(up, 0.0, 1.0), 0.5));
    // Below the horizon: the haze over the land.
    col = mix(col, world.sky_horizon.rgb * 0.75, smoothstep(0.0, -0.08, up));
    let cs = max(dot(d, sun), 0.0);
    // The sun through the blast's haze: a soft disc, a wide glow, warm toward the horizon.
    col = col + world.sun_color.rgb * (pow(cs, 900.0) * 18.0 + pow(cs, 60.0) * 0.55 + pow(cs, 6.0) * 0.22);
    return col;
}

fn smoke_layer(d: vec3<f32>, t: f32) -> vec4<f32> {
    // Ash drifting high over the plain: a sheet of fbm clouds, thicker toward the horizon.
    if (d.y <= 0.01) { return vec4<f32>(0.0); }
    let q = d.xz / (d.y + 0.08) * 1.6 + vec2<f32>(t * 0.004, t * 0.0015);
    let c = fbm(vec3<f32>(q.x, 3.1, q.y)) * 0.6 + fbm(vec3<f32>(q.x * 3.3, 7.7, q.y * 3.3)) * 0.4;
    let a = smoothstep(0.42, 0.78, c) * (0.35 + 0.65 * smoothstep(0.7, 0.05, d.y));
    return vec4<f32>(mix(vec3<f32>(0.22, 0.2, 0.19), vec3<f32>(0.55, 0.47, 0.4), c), a);
}

// --- Fog ------------------------------------------------------------------------------------------

// Height fog: a thin haze everywhere, and dust thickening toward the floor of the abyss
// (density bounce.w at the floor, falling off over dust.w meters), integrated along the ray.
fn fog(col: vec3<f32>, p: vec3<f32>, sun_here: f32) -> vec3<f32> {
    let cam = camera.view_pos.xyz;
    let dv = p - cam;
    let dist = length(dv);
    if (dist < 0.01) { return col; }
    let dir = dv / dist;
    let floor_y = world.screen.z;
    let h = max(world.dust.w, 1.0);
    let y0 = cam.y - floor_y;
    var dusty = 0.0;
    if (abs(dir.y) < 0.0005) {
        dusty = world.bounce.w * exp(-y0 / h) * dist;
    } else {
        dusty = world.bounce.w * h / dir.y * (exp(-y0 / h) - exp(-(y0 + dir.y * dist) / h));
    }
    let optical = max(dusty, 0.0) + world.sky_horizon.w * dist;
    let trans = exp(-optical);
    let sun = normalize(world.sun_dir.xyz);
    let mie = pow(max(dot(dir, sun), 0.0), 6.0);
    let lit = clamp(0.5 * (sun_here + world.misc.x), 0.0, 1.0);
    let inscatter = mix(world.dust.rgb, world.sky_horizon.rgb * 0.9 + world.sun_color.rgb * mie * 0.6, lit);
    return col * trans + inscatter * (1.0 - trans);
}

fn finish(col_in: vec3<f32>, clip: vec4<f32>) -> vec4<f32> {
    var col = aces(col_in * world.sky_zenith.w);
    // Grade: saturation and contrast, a vignette, and fades.
    let luma = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
    col = mix(vec3<f32>(luma), col, world.grade.x);
    col = clamp((col - vec3<f32>(0.5)) * world.grade.y + vec3<f32>(0.5), vec3<f32>(0.0), vec3<f32>(1.0));
    let uv = clip.xy / max(world.screen.xy, vec2<f32>(1.0));
    let e = uv - vec2<f32>(0.5);
    col = col * (1.0 - world.grade.w * smoothstep(0.25, 0.75, length(e * vec2<f32>(1.0, 0.8))));
    // A flash (explosions, the surge) and the fade to black.
    let flash_col = mix(vec3<f32>(1.0, 0.97, 0.9), vec3<f32>(0.75, 0.95, 1.0), world.misc.z);
    col = mix(col, flash_col, clamp(world.misc.y, 0.0, 1.0));
    col = col * (1.0 - world.grade.z);
    return vec4<f32>(pow(col, vec3<f32>(1.0 / 2.2)), 1.0);
}

// --- Terrain --------------------------------------------------------------------------------------

struct Ground { base: vec3<f32>, rough: f32, glow: vec3<f32>, n: vec3<f32> };

fn lin(c: vec3<f32>) -> vec3<f32> { return pow(c, vec3<f32>(2.2)); }

fn strata_color(h: f32) -> vec3<f32> {
    let basalt = vec3<f32>(0.25, 0.24, 0.24);
    let shale = vec3<f32>(0.36, 0.34, 0.33);
    let ochre = vec3<f32>(0.47, 0.39, 0.31);
    let lime = vec3<f32>(0.56, 0.53, 0.47);
    let rust = vec3<f32>(0.43, 0.31, 0.24);
    var c = mix(basalt, shale, smoothstep(0.0, 0.3, h));
    c = mix(c, ochre, smoothstep(0.35, 0.55, h));
    c = mix(c, lime, smoothstep(0.62, 0.8, h));
    c = mix(c, rust, smoothstep(0.88, 0.97, h));
    return c;
}

fn rock_strata(p: vec3<f32>, seed: f32) -> vec3<f32> {
    // Bands of the crust, dipping gently east and warped so they undulate along the wall.
    let warp = fbm(p * 0.006) * 24.0 + fbm(p * 0.021) * 6.0 + p.x * 0.035 - p.z * 0.012;
    let s = (p.y + warp) / 14.0;
    let band = floor(s);
    let c1 = strata_color(hash3(vec3<f32>(band, 1.7, 3.1)));
    let c2 = strata_color(hash3(vec3<f32>(band + 1.0, 1.7, 3.1)));
    var c = mix(c1, c2, smoothstep(0.55, 1.0, fract(s)));
    // Fine laminations; cracks wandering through the rock (ridged noise); stains washed down the face;
    // patches of weathering that break the bands up.
    let lam = 0.9 + 0.1 * sin((p.y + warp) * 2.7 + fbm(p * 0.35) * 3.0);
    let r1 = 1.0 - abs(vnoise(vec3<f32>(p.x * 0.09, p.y * 0.035, p.z * 0.09)) * 2.0 - 1.0);
    let r2 = 1.0 - abs(vnoise(vec3<f32>(p.x * 0.27 + 3.1, p.y * 0.11, p.z * 0.27)) * 2.0 - 1.0);
    let crack = smoothstep(0.9, 0.985, r1) * 0.55 + smoothstep(0.93, 0.99, r2) * 0.3;
    let stain = vnoise(vec3<f32>(p.x * 0.22 + p.z * 0.22, p.y * 0.01, seed * 9.0));
    let weather = fbm(p * 0.018);
    c = mix(c, vec3<f32>(0.4, 0.37, 0.34), smoothstep(0.55, 0.8, weather) * 0.5);
    c = c * lam * (0.82 + 0.25 * stain) * (1.0 - 0.5 * crack);
    return lin(c);
}

fn ground_shade(p: vec3<f32>, n_in: vec3<f32>, uv: vec2<f32>, col: vec4<f32>, far: bool) -> Ground {
    var g: Ground;
    var n = n_in;
    let slope = 1.0 - n.y;
    let scorch = uv.x;
    let river = uv.y;
    let paved = col.r;
    let t = world.sun_dir.w;
    // Relief finer than the mesh: grain on the flats, broken blocks on the rock faces.
    let fq = p * 0.9;
    let bump = vec3<f32>(fbm(fq) - 0.5, fbm(fq + vec3<f32>(2.1, 8.3, 0.4)) - 0.5, fbm(fq + vec3<f32>(5.2, 1.3, 7.7)) - 0.5);
    let cq = p * 0.12;
    let chunky = vec3<f32>(fbm(cq) - 0.5, fbm(cq + vec3<f32>(4.4, 1.1, 9.2)) - 0.5, fbm(cq + vec3<f32>(7.3, 3.9, 2.6)) - 0.5);
    let cliff = smoothstep(0.35, 0.7, slope);
    n = normalize(n + bump * select(0.35, 0.12, far) + chunky * cliff * 1.1);

    let rock = rock_strata(p, col.g);
    // Dust and soil on anything flat enough to hold it.
    let surface_soil = lin(mix(vec3<f32>(0.56, 0.5, 0.42), vec3<f32>(0.44, 0.39, 0.32), fbm(p * 0.05)));
    let deep_soil = lin(mix(vec3<f32>(0.3, 0.27, 0.25), vec3<f32>(0.4, 0.36, 0.31), fbm(p * 0.07)));
    let depth = clamp(-p.y / 500.0, 0.0, 1.0);
    var soil = mix(surface_soil, deep_soil, smoothstep(0.15, 0.6, depth));
    // Rubble: scattered pale stones on the floor and the scree.
    let stones = smoothstep(0.7, 0.85, vnoise(p * 1.7)) * (0.4 + 0.6 * depth);
    soil = mix(soil, rock * 1.25, stones * 0.6);
    let flat_k = smoothstep(0.55, 0.28, slope);
    var base = mix(rock, soil, flat_k);
    var rough = 0.9;
    // The blast: ash and char around the rim and in the craters, glassy in places.
    let ash = lin(mix(vec3<f32>(0.11, 0.1, 0.1), vec3<f32>(0.24, 0.22, 0.21), fbm(p * 0.13)));
    base = mix(base, ash, scorch * (0.55 + 0.45 * flat_k));
    rough = mix(rough, 0.55, scorch * smoothstep(0.75, 0.9, vnoise(p * 0.8)));
    // Flagstones (the settlement's streets and plaza) and the base's concrete pad.
    if (paved > 0.02) {
        var paving = vec3<f32>(0.0);
        if (p.y < -200.0) {
            let cell = floor(p.xz / 1.3 + vec2<f32>(vnoise2(p.xz * 0.4)) * 0.6);
            let hcell = hash3(vec3<f32>(cell, 2.0));
            let e = abs(fract(p.xz / 1.3 + vec2<f32>(vnoise2(p.xz * 0.4)) * 0.6) - vec2<f32>(0.5));
            let grout = smoothstep(0.43, 0.49, max(e.x, e.y));
            paving = lin(mix(vec3<f32>(0.5, 0.46, 0.4), vec3<f32>(0.64, 0.58, 0.5), hcell) * (1.0 - 0.55 * grout));
        } else {
            let e = abs(fract(p.xz / vec2<f32>(6.0, 4.0)) - vec2<f32>(0.5));
            let seam = smoothstep(0.47, 0.495, max(e.x, e.y));
            paving = lin(vec3<f32>(0.5, 0.5, 0.49) * (0.9 + 0.15 * vnoise(p * 0.7)) * (1.0 - 0.4 * seam));
        }
        base = mix(base, paving, smoothstep(0.1, 0.6, paved) * flat_k);
    }
    // The riverbed: dark wet stones, and pools still holding the Source's light.
    var glow = vec3<f32>(0.0);
    if (river > 0.02) {
        let wet = lin(vec3<f32>(0.16, 0.17, 0.19));
        base = mix(base, wet, river * 0.85);
        rough = mix(rough, 0.12, river);
        let pools = smoothstep(0.62, 0.8, fbm(p * 0.045 + vec3<f32>(0.0, t * 0.01, 0.0))) * smoothstep(0.55, 0.9, river);
        let ripple = 0.75 + 0.25 * sin(t * 1.7 + fbm(p * 0.3) * 12.0);
        glow = glow + world.source.rgb * world.source.w * pools * ripple * 0.5;
    }
    // Moss of the deep: faint blue-green light in the dark at the foot of the walls and on the floor.
    if (p.y < world.screen.z + 140.0) {
        let m = smoothstep(0.66, 0.82, fbm(p * 0.11 + vec3<f32>(3.0))) * smoothstep(world.screen.z + 140.0, world.screen.z + 20.0, p.y);
        let pulse = 0.7 + 0.3 * sin(t * 0.6 + hash3(floor(p * 0.2)) * 6.28);
        glow = glow + mix(vec3<f32>(0.1, 0.55, 0.5), vec3<f32>(0.35, 0.2, 0.75), vnoise(p * 0.02)) * m * pulse * 0.12 * (1.0 - scorch);
    }
    g.base = base;
    g.rough = rough;
    g.glow = glow;
    g.n = n;
    return g;
}

// --- Point lights ---------------------------------------------------------------------------------

fn point_lights(p: vec3<f32>, n: vec3<f32>) -> vec3<f32> {
    var sum = vec3<f32>(0.0);
    let count = i32(world.screen.w);
    for (var i = 0; i < ${MAX_LIGHTS}; i = i + 1) {
        if (i >= count) { break; }
        let l = world.lights[i];
        let d = l.pos.xyz - p;
        let dist = length(d);
        if (dist > l.pos.w) { continue; }
        let k = 1.0 - dist / l.pos.w;
        let ndl = max(dot(n, d / max(dist, 0.001)) * 0.8 + 0.2, 0.0);
        sum = sum + l.color.rgb * l.color.w * ndl * k * k;
    }
    return sum;
}

// --- Effects -------------------------------------------------------------------------------------

fn effect(pattern: i32, in: VertexOutput, v: vec3<f32>) -> vec4<f32> {
    let t = world.sun_dir.w;
    let n = normalize(in.normal);
    let rim = pow(max(dot(n, v), 0.0), 0.7);
    let q = in.local_pos;
    if (pattern == 41) {
        // Magic: a swirling, bright core in the tint's color, hot white at the center.
        let swirl = fbm(q * 3.0 + vec3<f32>(t * 2.3, -t * 1.7, t * 1.1));
        let core = pow(rim, 2.0);
        let c = in.tint.rgb * (0.8 + 1.6 * swirl) + vec3<f32>(1.0) * core * 0.9;
        return vec4<f32>(c * (1.0 + in.tint.w * 2.5), 1.0);
    }
    if (pattern == 42) {
        let qq = in.world_pos * 2.3 + vec3<f32>(in.extra.w);
        let flick = 0.75 + 0.25 * sin(qq.x * 3.1 + t * 17.0) * sin(qq.y * 2.7 - t * 23.0 + qq.z * 1.9);
        return vec4<f32>(in.tint.rgb * in.color.rgb * (0.6 + 0.4 * rim) * flick * (1.2 + in.tint.w * 3.0), 1.0);
    }
    if (pattern == 44) {
        // The Source's waterfall: streaks rushing down, colors shifting, brightest at its heart.
        let fall = fract(in.uv.y * 3.0 + t * 0.9 + vnoise(vec3<f32>(in.uv.x * 40.0, 0.0, 1.0)) * 0.7);
        let streak = smoothstep(0.0, 0.25, fall) * smoothstep(1.0, 0.55, fall);
        let lanes = 0.55 + 0.45 * vnoise(vec3<f32>(in.uv.x * 60.0, in.uv.y * 2.0 - t * 2.0, 3.0));
        let heart = 1.0 - abs(in.uv.x - 0.5) * 2.0;
        let c = world.source.rgb * (0.4 + 1.6 * streak * lanes) * (0.5 + heart) + vec3<f32>(1.0) * pow(heart, 6.0) * 0.4;
        return vec4<f32>(c * world.source.w * 1.6, 1.0);
    }
    if (pattern == 45) {
        // A light beam: brightest along its axis (uv.x across, uv.y along), fading out.
        let across = 1.0 - abs(in.uv.x - 0.5) * 2.0;
        let along = 1.0 - clamp(in.uv.y, 0.0, 1.0);
        let dust = 0.7 + 0.3 * vnoise(in.world_pos * 0.2 + vec3<f32>(t * 0.3));
        return vec4<f32>(in.tint.rgb * pow(across, 1.5) * along * dust * in.tint.w, 1.0);
    }
    if (pattern == 46) {
        return vec4<f32>(in.tint.rgb * (2.0 + in.tint.w * 3.0), 1.0);
    }
    if (pattern == 47) {
        // Rotor blur: a faint disc, darker toward the tips, banded.
        let r = length(q.xz);
        let band = 0.7 + 0.3 * sin(r * 6.0);
        return vec4<f32>(vec3<f32>(0.06, 0.065, 0.07) * band, 1.0);
    }
    if (pattern == 49) {
        let pulse = 0.75 + 0.25 * sin(t * 1.3 + in.world_pos.x * 0.7 + in.world_pos.z * 0.3);
        return vec4<f32>(in.color.rgb * in.tint.rgb * (1.5 + in.tint.w * 2.0) * pulse, 1.0);
    }
    return vec4<f32>(in.color.rgb, 1.0);
}

// Opacity of an effect's pixel (dithered): beams fade at their edges, rotor discs are faint.
fn effect_keep(pattern: i32, in: VertexOutput) -> f32 {
    var keep = in.extra.x;
    if (pattern == 45) { keep = keep * pow(1.0 - abs(in.uv.x - 0.5) * 2.0, 0.8) * (1.0 - clamp(in.uv.y, 0.0, 1.0)) * 0.7; }
    if (pattern == 47) { keep = keep * 0.22; }
    if (pattern == 44) { keep = keep * (0.55 + 0.45 * (1.0 - abs(in.uv.x - 0.5) * 2.0)); }
    return keep;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let raw = in.normal;
    let nlen = length(raw);
    let pattern = i32(in.pattern);
    let p = in.world_pos;
    let cam = camera.view_pos.xyz;
    let v = normalize(cam - p);
    let dist = length(cam - p);
    // Derivatives in uniform control flow (hair strands read their direction from uv.y).
    let t_raw = dpdx(in.world_pos) * dpdy(in.uv.y) - dpdy(in.world_pos) * dpdx(in.uv.y);

    if (pattern == 40) {
        let d = normalize(p - cam);
        var col = sky_color(d);
        let sm = smoke_layer(d, world.sun_dir.w);
        col = mix(col, sm.rgb * (0.6 + 0.6 * world.sun_color.rgb), sm.a * 0.8);
        return finish(col, in.clip_position);
    }

    // Dithered opacity: fading things, effects.
    var keep = in.extra.x;
    if (pattern >= 41 && pattern != 48) { keep = effect_keep(pattern, in); }
    if (keep < 0.999 && !dither_keep(in.clip_position, keep)) { discard; }

    let ls = light_at(p);
    let sun_wall = wall_sun(p, ls);

    if (pattern >= 41 && pattern != 43 && pattern != 48) {
        let e = effect(pattern, in, v);
        var col = e.rgb;
        if (in.extra.y < 1.5) { col = mix(col, fog(col, p, sun_wall), 0.6); }
        return finish(col, in.clip_position);
    }

    var n = raw / max(nlen, 0.0001);
    if (dot(n, v) < 0.0) { n = -n; }
    var base = pow(in.color.rgb, vec3<f32>(2.2));
    let a = in.color.a;
    var metal = select(0.0, 1.0, a >= 0.5);
    var rough = clamp((a - metal * 0.5) / 0.49, 0.03, 1.0);
    var glow = vec3<f32>(0.0);
    var uvp = in.uv;
    if (in.anim.w > 0.5) { uvp.y = 0.5; }

    if (world.misc.w > 0.5 && (pattern == 30 || pattern == 31)) {
        // Debug: the terrain's masks (scorch red, paved green, riverbed blue).
        return vec4<f32>(in.uv.x, in.color.r, in.uv.y, 1.0);
    }
    if (pattern == 30 || pattern == 31) {
        let g = ground_shade(p, n, in.uv, in.color, pattern == 31 || dist > 900.0);
        base = g.base;
        rough = g.rough;
        metal = 0.0;
        glow = g.glow;
        n = g.n;
    } else if (pattern == 43) {
        // Smoke and dust: lit puffs colored by the tint.
        base = in.tint.rgb;
        rough = 1.0;
        metal = 0.0;
    } else if (pattern == 48) {
        // A scorch on the ground: char, darkest at the center.
        let r = length(in.local_pos.xz);
        base = mix(vec3<f32>(0.02, 0.018, 0.017), vec3<f32>(0.1, 0.09, 0.085), smoothstep(0.2, 1.0, r + 0.2 * vnoise(p * 2.0)));
        rough = 0.95;
        metal = 0.0;
        if (!dither_keep(in.clip_position, 1.0 - smoothstep(0.6, 1.0, r))) { discard; }
    } else {
        base = base * in.tint.rgb;
    }

${MESHA_PATTERNS}

    if (pattern == 11) {
        glow = glow + base * 2.4 * (1.0 + in.tint.w);
    }

    // --- Lighting ---
    let sun = normalize(world.sun_dir.xyz);
    var sun_vis = sun_wall;
    if (sun_vis > 0.001 && pattern != 30 && pattern != 31 && dist < 600.0) { sun_vis = sun_vis * cast_shadow(p, n); }
    else if (sun_vis > 0.001 && (pattern == 30 || pattern == 31) && dist < 600.0) { sun_vis = sun_vis * cast_shadow(p, n); }
    let sky_vis = sky_seen(p, ls);
    let ndl = max(dot(n, sun), 0.0);
    let nv = max(dot(n, v), 0.0);
    let wrap = mix(ndl, max((dot(n, sun) + 0.35) / 1.35, 0.0), foliage);
    var key_wrap = vec3<f32>(wrap);
    if (skin > 0.5) {
        let kd = dot(n, sun);
        let reach = vec3<f32>(0.45, 0.24, 0.18);
        key_wrap = max((vec3<f32>(kd) + reach) / (vec3<f32>(1.0) + reach), vec3<f32>(0.0));
    }
    let sun_light = world.sun_color.rgb * world.sun_color.w * key_wrap * sun_vis;
    // Skylight from the open sky above; light bounced off the sunlit walls below and around.
    let sky_dir = mix(world.sky_horizon.rgb, world.sky_zenith.rgb * 1.3, n.y * 0.5 + 0.5);
    // Light from the ground below (sunlit sand up top; the walls' glow down in the crack).
    let below = mix(world.bounce.rgb * 1.6, world.bounce.rgb, sky_vis) * max(-n.y * 0.5 + 0.5, 0.0);
    let ambient = sky_dir * (0.35 + 0.65 * sky_vis) * (0.3 + 0.7 * sky_vis) * 1.05
        + world.bounce.rgb * (1.0 - sky_vis * 0.5) * (0.55 + 0.45 * (1.0 - n.y)) * 0.8
        + below * 0.6;
    // The Source lights the east end of the floor.
    let sd = world.source_pos.xyz - p;
    let sdist = length(sd);
    let source_k = pow(max(1.0 - sdist / world.source_pos.w, 0.0), 2.0) * (max(dot(n, sd / max(sdist, 1.0)), 0.0) * 0.7 + 0.3);
    let lamps = point_lights(p, n) + world.source.rgb * world.source.w * source_k * 2.0;
    let diffuse_light = sun_light + ambient + lamps;

    let h = normalize(sun + v);
    let shininess = 2.0 / (rough * rough * rough + 0.001);
    let spec = ((shininess + 8.0) / 25.0) * pow(max(dot(n, h), 0.0), min(shininess, 4000.0)) * ndl * sun_vis;
    let fresnel = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
    let r = reflect(-v, n);
    let env = sky_color(r) * (0.2 + 0.8 * sky_vis);
    let f0 = mix(vec3<f32>(0.04), base, metal);
    let reflectance = mix(vec3<f32>(fresnel * (1.0 - rough) * (1.0 - rough) * 0.8), f0 + (1.0 - f0) * fresnel * (1.0 - rough), metal);
    var col = base * (1.0 - metal) * diffuse_light
        + env * reflectance * mix(1.0, crown_occ * 0.3, foliage) * (0.35 + 0.65 * (1.0 - rough))
        + world.sun_color.rgb * world.sun_color.w * spec * mix(vec3<f32>(0.05 + 0.3 * fresnel), f0, metal) * spec_scale * 0.6;
    col = col + base * sheen * pow(1.0 - nv, 3.0) * (ambient + sun_light * 0.3);
    if (skin > 0.5) {
        col = col + base * vec3<f32>(1.0, 0.38, 0.26) * pow(1.0 - nv, 2.5) * 0.18 * (ambient + world.sun_color.rgb * 0.4 * sun_vis);
    }
    let through = pow(max(dot(-n, sun), 0.0), 1.5) * (0.35 + 0.65 * pow(max(dot(-v, sun), 0.0), 2.0));
    col = col + foliage * base * vec3<f32>(1.0, 1.12, 0.62) * world.sun_color.rgb * world.sun_color.w * through * 0.5 * sun_vis;
    if (pattern == 5 || pattern == 16) {
        let body = base * (0.35 + 0.45 * pow(nv, 0.5)) * (ambient + sun_light * 0.25);
        col = body + env * (0.08 + fresnel * 1.1) + world.sun_color.rgb * spec * 1.2;
    }
    col = col + glow;
    // A highlight rim (pickups, objective items).
    col = col + in.tint.rgb * pow(1.0 - nv, 3.0) * in.extra.z;

    if (in.extra.y < 1.5) { col = fog(col, p, sun_vis); }
    return finish(col, in.clip_position);
}
`;

/** The shader for meshes with one Item uniform each. */
export const ABYSS_SHADER = (COMMON + SHADOW_WGSL + FRAGMENT)
    .replace("ITEM_BINDING", "@group(2) @binding(1) var<uniform> item: Item;")
    .split("ITEM_FETCH").join("item");

/** The shader for instanced batches: each instance's Item from a storage buffer. */
export const ABYSS_INSTANCED_SHADER = (COMMON + SHADOW_WGSL + FRAGMENT)
    .replace("ITEM_BINDING", "@group(2) @binding(1) var<storage, read> items: array<Item>;")
    .split("ITEM_FETCH").join("items[ii]");
