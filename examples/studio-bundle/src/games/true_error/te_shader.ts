// True Error's shaders.
//
//   ASSET   Meshy models: their own base color, normal and metallic/roughness maps (one texture
//           array pair per model, bound per mesh), instanced from a storage buffer of Items.
//   ARCH    the tower and everything built in code: tiling PBR material sets (assets/materials) as
//           texture arrays, the layer and a baked sky openness packed into the vertex color's alpha
//           (layer + openness * 0.99); also the Mars sky (kind 1), the ground far below (kind 2) and
//           solids (kind 3: the shared box/cylinder/sphere shapes placed per instance - doors, the lift,
//           crates, collectibles - their layer, metalness, uv scale and openness in Item.extra), Noctis's
//           old roads (kind 4: asphalt ribbons worn by the shader - cracks, potholes, sand, paint) and
//           its scrub (kind 5: crossed cards whose grass blades the shader cuts out). Surfaces with
//           params.y = 1 are terrain: mapped from the world (two projections, so cliffs don't
//           stretch) with a second, larger sample against tiling. Every surface gathers procedural
//           wear: dust on what faces up, oil stains and scorch marks on floors, cracks in concrete
//           and asphalt, streaks down walls.
//   GLOW    additive light: dots, laser bolts, holograms, the dark zone, the hypercube's edges.
//   LIGHT   deferred: ASSET and ARCH write a G-buffer (albedo; normal + emissive; roughness,
//           metalness, openness, heat) and this full-screen pass lights each visible pixel once
//           with shade(), its position solved back from the depth.
//   SKY     the Mars sky, drawn forward after the lighting where nothing else is.
//   SCREEN  height fog over the city from depth, the lenses (night, heat, distance, simulation),
//           the Error's glitch, letterbox, tone curve, vignette and grain.
//
// Depth is reversed (Entropy.Screen.setReversedDepth): clip z is the near plane, so depth = NEAR / w,
// 1 at the near plane falling toward 0 far away, in a float buffer that keeps it precise out to the
// skyline. No shader writes frag_depth, so the GPU rejects hidden fragments before shading them; the
// screen pass recovers distance as NEAR / depth.
//
// Normal maps use a cotangent frame from screen derivatives: the engine's vertex layout (position,
// normal, uv, color) has no tangents.

/** The near plane (m); depth = NEAR / view w. */
export const NEAR = 0.05;
/** Depth of the sky dome: behind anything nearer than NEAR / SKY_DEPTH (50 km). */
const SKY_DEPTH = 1e-6;
export const MAX_LIGHTS = 16;
export const WORLD_FLOATS = (8 + MAX_LIGHTS * 2) * 4;
export const ITEM_FLOATS = 28;
export const POST_FLOATS = 8 * 4;

/** Item.params.x for ARCH. */
export const ARCH = { surface: 0, sky: 1, ground: 2, solid: 3, road: 4, scrub: 5 } as const;
/** Item.params.x for GLOW. */
export const GLOW = { dot: 0, beam: 1, holo: 2, dark: 3, edge: 4, mote: 5, ring: 6 } as const;
/** World.time.z: the lens. */
export const LENS = { none: 0, night: 1, heat: 2, distance: 3, simulation: 4 } as const;

const HEAD = /* wgsl */ `
struct Camera { view_proj: mat4x4<f32>, view_pos: vec4<f32> };
@group(0) @binding(0) var<uniform> camera: Camera;

struct Light { pos: vec4<f32>, color: vec4<f32> };
struct World {
    time: vec4<f32>,     // seconds, exposure, lens, glitch (0..1)
    sun: vec4<f32>,      // direction toward the sun, intensity
    suncol: vec4<f32>,   // sun color, ambient strength
    sky_top: vec4<f32>,  // zenith color, light count
    sky_hor: vec4<f32>,  // horizon color, sim-vision pulse
    ground: vec4<f32>,   // light bounced up from below, interior ambient floor
    dark: vec4<f32>,     // dark zone center, radius
    misc: vec4<f32>,     // dark zone strength, hit flash, dust, 0
    lights: array<Light, ${MAX_LIGHTS}>,
};
@group(2) @binding(0) var<uniform> world: World;
struct FOut { @location(0) color: vec4<f32> };

fn hash2(p: vec2<f32>) -> f32 { var q = fract(p * vec2<f32>(123.34, 456.21)); q = q + dot(q, q + 45.32); return fract(q.x * q.y); }
fn hash3(p: vec3<f32>) -> f32 { return hash2(p.xy + vec2<f32>(p.z * 17.13, p.z * 3.71)); }
fn vnoise(p: vec2<f32>) -> f32 {
    let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2<f32>(1.0, 0.0)), u.x), mix(hash2(i + vec2<f32>(0.0, 1.0)), hash2(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}
fn fbm2(p: vec2<f32>) -> f32 { return vnoise(p) * 0.5 + vnoise(p * 2.03 + vec2<f32>(5.1, 1.7)) * 0.3 + vnoise(p * 4.1 + vec2<f32>(2.3, 9.4)) * 0.2; }
// Distance to the nearest cell border of a jittered grid (0 on a crack): F2 - F1 of a Voronoi.
fn crack(p: vec2<f32>) -> f32 {
    let i = floor(p); let f = fract(p);
    var d1 = 8.0; var d2 = 8.0;
    for (var y = -1; y <= 1; y = y + 1) {
        for (var x = -1; x <= 1; x = x + 1) {
            let g = vec2<f32>(f32(x), f32(y));
            let o = vec2<f32>(hash2(i + g), hash2(i + g + vec2<f32>(19.7, 7.3)));
            let d = length(g + o - f);
            if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
        }
    }
    return d2 - d1;
}
const DUST = vec3<f32>(0.45, 0.3, 0.21);
`;

const ITEMS = /* wgsl */ `
// color: tint rgb, opacity; params: kind, flags, emissive, heat; extra: material/glow width,
// hit flash, glitch, sky openness.
struct Item { model: mat4x4<f32>, color: vec4<f32>, params: vec4<f32>, extra: vec4<f32> };
@group(2) @binding(1) var<storage, read> items: array<Item>;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
};
struct VOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) vcolor: vec4<f32>,
    @location(4) local: vec3<f32>,
    @location(5) @interpolate(flat) color: vec4<f32>,
    @location(6) @interpolate(flat) params: vec4<f32>,
    @location(7) @interpolate(flat) extra: vec4<f32>,
};
// The G-buffer (addon_pipeline.rs ADDON_GBUFFER_FORMATS): albedo; normal and emissive strength;
// roughness, metalness, sky openness, heat.
struct GOut { @location(0) albedo: vec4<f32>, @location(1) normal: vec4<f32>, @location(2) material: vec4<f32> };
fn gbuffer(albedo: vec3<f32>, n: vec3<f32>, emissive: f32, rough: f32, metal: f32, open: f32, heat: f32) -> GOut {
    var g: GOut;
    g.albedo = vec4<f32>(albedo, 1.0);
    g.normal = vec4<f32>(n, emissive);
    g.material = vec4<f32>(rough, metal, open, clamp(heat, 0.0, 1.0));
    return g;
}

// Reversed depth with an infinite far plane: NEAR / w after the divide.
fn far_depth(c: vec4<f32>) -> vec4<f32> { return vec4<f32>(c.xy, ${NEAR}, c.w); }

fn world_normal(it: Item, n: vec3<f32>) -> vec3<f32> {
    let sx = length(it.model[0].xyz); let sy = length(it.model[1].xyz); let sz = length(it.model[2].xyz);
    let nl = n / max(vec3<f32>(sx * sx, sy * sy, sz * sz), vec3<f32>(1e-12));
    return normalize(it.model[0].xyz * nl.x + it.model[1].xyz * nl.y + it.model[2].xyz * nl.z);
}

fn standard_vertex(in: VertexInput, it: Item) -> VOut {
    var out: VOut;
    let wp = (it.model * vec4<f32>(in.position, 1.0)).xyz;
    let clip = camera.view_proj * vec4<f32>(wp, 1.0);
    out.clip = far_depth(clip);
    out.world_pos = wp;
    out.normal = world_normal(it, in.normal);
    out.uv = in.tex_coords;
    out.vcolor = in.color;
    out.local = in.position;
    out.color = it.color;
    out.params = it.params;
    out.extra = it.extra;
    return out;
}

// The Mars sky: butterscotch dust by day, the blue glow around the sun, Phobos, and the arc of
// debris from the planets the Last Day destroyed.
fn sky_color(d: vec3<f32>) -> vec3<f32> {
    let sun = normalize(world.sun.xyz);
    let up = clamp(d.y, -1.0, 1.0);
    var col = mix(world.sky_hor.rgb, world.sky_top.rgb, pow(clamp(up, 0.0, 1.0), 0.6));
    col = mix(col, world.sky_hor.rgb * 0.7, smoothstep(0.0, -0.15, up));
    let mu = max(dot(d, sun), 0.0);
    col = col + vec3<f32>(0.35, 0.55, 0.9) * pow(mu, 18.0) * 0.9 + vec3<f32>(0.9, 0.75, 0.55) * pow(mu, 4.0) * 0.18;
    col = col + world.suncol.rgb * smoothstep(0.9993, 0.9997, mu) * 18.0;
    // Phobos, small and grey, high in the east-south.
    let ph = normalize(vec3<f32>(0.35, 0.55, -0.75));
    let pd = dot(d, ph);
    if (pd > 0.99935) {
        let lit = 0.35 + 0.65 * smoothstep(-0.2, 0.6, dot(normalize(d - ph * pd + vec3<f32>(1e-4)), sun));
        col = mix(col, vec3<f32>(0.42, 0.38, 0.34) * lit * (0.8 + 0.4 * fbm2(d.xz * 900.0)), smoothstep(0.99935, 0.99945, pd));
    }
    // The debris arc: a thin tilted band of glinting rubble.
    let band_n = normalize(vec3<f32>(0.25, 0.4, 0.88));
    let b = abs(dot(d, band_n));
    let along = atan2(d.z, d.x);
    let grit = fbm2(vec2<f32>(along * 40.0, b * 400.0));
    col = col + vec3<f32>(0.8, 0.7, 0.6) * smoothstep(0.035, 0.0, b) * smoothstep(0.0, 0.25, up + 0.05) * (0.04 + 0.12 * grit * grit);
    return col;
}
`;

const COMMON = HEAD + ITEMS;

// Cascaded sun shadows (core/addon_sun_shadows.rs), as Allegiance and The Abyss draw them.
const SHADOW = /* wgsl */ `
struct SunShadow { cascades: array<mat4x4<f32>, 4>, texel: vec4<f32>, params: vec4<f32> };
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
    // Four bilinear comparison taps (each already a 2x2 filter): a soft edge about three texels wide.
    let o = step * 0.9;
    var sum = textureSampleCompareLevel(shadow_maps, shadow_sampler, uv + vec2<f32>(-o, -o), k, depth);
    sum = sum + textureSampleCompareLevel(shadow_maps, shadow_sampler, uv + vec2<f32>(o, -o), k, depth);
    sum = sum + textureSampleCompareLevel(shadow_maps, shadow_sampler, uv + vec2<f32>(-o, o), k, depth);
    sum = sum + textureSampleCompareLevel(shadow_maps, shadow_sampler, uv + vec2<f32>(o, o), k, depth);
    out.lit = sum * 0.25;
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
        if (k + 1 < count) { let b = cascade_lookup(p, n, k + 1); if (b.edge >= 0.0) { next = b.lit; } }
        return mix(1.0, mix(next, a.lit, blend), sun_shadow.params.z);
    }
    return 1.0;
}
`;

// Shading shared by ASSET and ARCH: sun (shadowed), sky and bounce ambient scaled by how open to
// the sky the point is, point lights, a GGX-ish specular lobe, then the lens and the Error.
const SHADE = /* wgsl */ `
fn perturb(n: vec3<f32>, p: vec3<f32>, uv: vec2<f32>, m: vec3<f32>, dp1: vec3<f32>, dp2: vec3<f32>, duv1: vec2<f32>, duv2: vec2<f32>) -> vec3<f32> {
    let dp2perp = cross(dp2, n);
    let dp1perp = cross(n, dp1);
    let t = dp2perp * duv1.x + dp1perp * duv2.x;
    let b = dp2perp * duv1.y + dp1perp * duv2.y;
    let inv = inverseSqrt(max(max(dot(t, t), dot(b, b)), 1e-20));
    return normalize(t * inv * m.x - b * inv * m.y + n * m.z);
}

fn ggx(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, rough: f32) -> f32 {
    let h = normalize(v + l);
    let a = max(rough * rough, 0.02);
    let nh = max(dot(n, h), 0.0);
    let d = a * a / (3.14159 * pow(nh * nh * (a * a - 1.0) + 1.0, 2.0));
    return d * 0.25 / max(dot(n, l) * dot(n, v), 0.15);
}

// Heat vision: cold blue world, hot things (params.w) toward white.
fn heat_palette(t: f32) -> vec3<f32> {
    let c0 = vec3<f32>(0.02, 0.02, 0.12); let c1 = vec3<f32>(0.35, 0.0, 0.55); let c2 = vec3<f32>(0.95, 0.25, 0.05); let c3 = vec3<f32>(1.0, 0.9, 0.4);
    if (t < 0.33) { return mix(c0, c1, t / 0.33); }
    if (t < 0.66) { return mix(c1, c2, (t - 0.33) / 0.33); }
    return mix(c2, c3, (t - 0.66) / 0.34);
}

fn shade(albedo: vec3<f32>, n: vec3<f32>, p: vec3<f32>, rough: f32, metal: f32, open: f32, emissive: vec3<f32>, heat: f32) -> vec3<f32> {
    let v = normalize(camera.view_pos.xyz - p);
    let l = normalize(world.sun.xyz);
    let ndl = max(dot(n, l), 0.0);
    let sh = select(1.0, cast_shadow(p, n), ndl > 0.0);
    let f0 = mix(vec3<f32>(0.04), albedo, metal);
    let diffuse = albedo * (1.0 - metal);
    var col = (diffuse / 3.14159 + f0 * ggx(n, v, l, rough)) * world.suncol.rgb * world.sun.w * ndl * sh * 3.14159;
    // Sky light from above, bounce from below, scaled by openness; an interior floor so rooms are never black.
    let amb_open = max(open, world.ground.w);
    let sky = mix(world.sky_hor.rgb, world.sky_top.rgb, n.y * 0.5 + 0.5);
    let hemi = mix(world.ground.rgb, sky, n.y * 0.5 + 0.5);
    col = col + (diffuse + f0 * 0.5) * hemi * world.suncol.w * amb_open;
    let count = i32(world.sky_top.w);
    for (var i = 0; i < ${MAX_LIGHTS}; i = i + 1) {
        if (i >= count) { break; }
        let li = world.lights[i];
        let d = li.pos.xyz - p;
        let dist = length(d);
        // Point lights cast no shadows: keep each to its own floor so it does not shine through slabs.
        if (dist > li.pos.w || abs(d.y) > max(3.2, li.pos.w * 0.3)) { continue; }
        let ld = d / max(dist, 1e-4);
        let fall = pow(clamp(1.0 - dist / li.pos.w, 0.0, 1.0), 2.0) / (1.0 + dist * dist * 0.15);
        let nl = max(dot(n, ld), 0.0);
        col = col + (diffuse / 3.14159 + f0 * ggx(n, v, ld, rough)) * li.color.rgb * li.color.w * nl * fall * 3.14159;
    }
    // The dark zone drinks light near it.
    let dz = length(p - world.dark.xyz);
    if (world.dark.w > 0.0 && p.y > world.dark.y - 0.3) {
        let inside = 1.0 - smoothstep(world.dark.w * 0.6, world.dark.w * 1.25, dz);
        col = mix(col, col * 0.25 + vec3<f32>(0.06, 0.0, 0.1) * world.misc.x, inside * world.misc.x);
    }
    col = col + emissive;
    let lens = i32(world.time.z + 0.5);
    if (lens == 1) {
        // Night vision: amplified, green, flattened.
        let lum = dot(col, vec3<f32>(0.3, 0.55, 0.15)) * 6.0 + 0.02;
        col = vec3<f32>(0.25, 1.0, 0.35) * lum;
    } else if (lens == 2) {
        let lum = dot(col, vec3<f32>(0.3, 0.55, 0.15));
        col = heat_palette(clamp(heat * 0.85 + lum * 0.12 + 0.05, 0.0, 1.0)) * 0.6;
    } else if (lens == 4) {
        // Simulation vision: the real world thins to a cold wireframe-blue ghost.
        let lum = dot(col, vec3<f32>(0.3, 0.55, 0.15));
        col = mix(col, vec3<f32>(0.1, 0.3, 0.45) * (lum * 2.0 + 0.04), 0.75);
    }
    return col;
}

fn fog_out(col: vec3<f32>) -> FOut {
    var o: FOut;
    o.color = vec4<f32>(col, 1.0);
    return o;
}
`;

const ASSET_SRC = /* wgsl */ `
${COMMON}
${SHADOW}
${SHADE}
@group(2) @binding(2) var albedo_map: texture_2d_array<f32>;
@group(2) @binding(3) var data_map: texture_2d_array<f32>;
@group(2) @binding(4) var asset_sampler: sampler;

@vertex
fn vs_main(in: VertexInput, @builtin(instance_index) ii: u32) -> VOut { return standard_vertex(in, items[ii]); }

@vertex
fn vs_shadow(in: VertexInput, @builtin(instance_index) ii: u32) -> @builtin(position) vec4<f32> {
    let it = items[ii];
    // Flag 4: casts no shadow (litter, plants).
    if (it.color.w < 0.5 || (u32(it.params.y + 0.5) & 4u) != 0u) { return vec4<f32>(0.0, 0.0, 2.0, 1.0); }
    return camera.view_proj * (it.model * vec4<f32>(in.position, 1.0));
}

@fragment
fn fs_main(in: VOut) -> GOut {
    let flags = u32(in.params.y + 0.5);
    let dp1 = dpdx(in.world_pos); let dp2 = dpdy(in.world_pos);
    let duv1 = dpdx(in.uv); let duv2 = dpdy(in.uv);
    let base = textureSample(albedo_map, asset_sampler, in.uv, 0);
    let nm = textureSample(data_map, asset_sampler, in.uv, 0).xyz * 2.0 - 1.0;
    let mr = textureSample(data_map, asset_sampler, in.uv, 1);
    if (in.color.w < 0.999 && hash2(in.clip.xy) > in.color.w) { discard; }
    var n = normalize(in.normal);
    if ((flags & 1u) != 0u) { n = perturb(n, in.world_pos, in.uv, nm, dp1, dp2, duv1, duv2); }
    var rough = 0.65; var metal = 0.25;
    if ((flags & 2u) != 0u) { rough = clamp(mr.g, 0.08, 1.0); metal = mr.b; }
    var albedo = base.rgb * in.color.rgb;
    if ((flags & 8u) != 0u) {
        // Scenery weathers where it stands (flag 8, extra.x the ground's height): sand and grime
        // banked round its foot, dust settled on whatever faces up.
        let p = in.world_pos;
        let f = vnoise(p.xz * 1.7 + vec2<f32>(p.y * 0.6, 0.0));
        let foot = 1.0 - smoothstep(0.0, 0.7, p.y - in.extra.x + (f - 0.5) * 0.5);
        albedo = mix(albedo * (1.0 - 0.3 * foot), DUST * (0.7 + 0.35 * f), foot * (0.25 + 0.45 * world.misc.z));
        let up = smoothstep(0.5, 0.95, normalize(in.normal).y);
        let drift = up * world.misc.z * smoothstep(0.25, 0.7, vnoise(p.xz * 0.9 + vec2<f32>(3.1, 7.7)));
        albedo = mix(albedo, DUST * (0.85 + 0.3 * f), drift * 0.85);
        rough = mix(rough, 0.92, max(drift, foot * 0.6));
        metal = metal * (1.0 - drift);
    }
    // Emission is albedo * strength: the glitch bands and the hit flash tint the albedo toward their color.
    var e = in.params.z;
    // Scenery glows only where its texture is bright (a lamp's glass, a screen), not its iron.
    if ((flags & 8u) != 0u) { e = e * smoothstep(0.3, 0.65, max(base.r, base.g)); }
    // The Error's corruption: glitch bands crawling over hacked machines.
    if (in.extra.z > 0.0) {
        let t = world.time.x;
        let band = step(0.82, hash2(vec2<f32>(floor(in.local.y * 18.0 + t * 7.0), floor(t * 9.0))));
        let flick = step(0.5, fract(sin(t * 37.0 + in.local.x * 9.0) * 43758.5));
        let g = band * flick * in.extra.z;
        albedo = mix(albedo, vec3<f32>(1.0, 0.08, 0.05), clamp(g, 0.0, 1.0));
        e = e + g * 1.6;
    }
    albedo = mix(albedo, vec3<f32>(1.0, 0.95, 0.9), clamp(in.extra.y, 0.0, 1.0));
    e = e + in.extra.y * 1.5;
    return gbuffer(albedo, n, e, rough, metal, in.extra.w, in.params.w);
}
`;

const ARCH_SRC = /* wgsl */ `
${COMMON}
${SHADOW}
${SHADE}
@group(2) @binding(2) var base_maps: texture_2d_array<f32>;
@group(2) @binding(3) var normal_maps: texture_2d_array<f32>;
@group(2) @binding(4) var rough_maps: texture_2d_array<f32>;
@group(2) @binding(5) var tile_sampler: sampler;

@vertex
fn vs_main(in: VertexInput, @builtin(instance_index) ii: u32) -> VOut {
    let it = items[ii];
    var out = standard_vertex(in, it);
    let kind = i32(it.params.x + 0.5);
    if (kind == 1) {
        let wp = camera.view_pos.xyz + in.position * 5000.0;
        let clip = camera.view_proj * vec4<f32>(wp, 1.0);
        out.clip = vec4<f32>(clip.xy, clip.w * ${SKY_DEPTH}, clip.w);
        out.world_pos = wp;
    }
    return out;
}

@vertex
fn vs_shadow(in: VertexInput, @builtin(instance_index) ii: u32) -> @builtin(position) vec4<f32> {
    let it = items[ii];
    let kind = i32(it.params.x + 0.5);
    if ((kind != 0 && kind != 3) || it.color.w < 0.5) { return vec4<f32>(0.0, 0.0, 2.0, 1.0); }
    return camera.view_proj * (it.model * vec4<f32>(in.position, 1.0));
}

// Meters one repeat of each material covers (te_scene.ts TILE).
fn tile_of(layer: i32) -> f32 {
    var t = array<f32, 9>(2.4, 2.4, 2.0, 2.0, 3.0, 2.4, 1.5, 1.8, 3.0);
    return t[clamp(layer, 0, 8)];
}

// Wear on a built surface or the ground: oil stains and scorch marks on floors, cracks through
// concrete and asphalt, dust on whatever faces up, streaks down walls. Kept cheap: single-octave
// noise for the masks, and the crack and rim work only where a patch or a mark actually is (and
// cracks only within 70 m, where they'd show).
fn wear(albedo: vec3<f32>, p: vec3<f32>, n: vec3<f32>, layer: i32, terrain: bool) -> vec3<f32> {
    var a = albedo;
    let up = n.y;
    if (up > 0.5) {
        // One mark per 6 m cell at most: a blotch with a noisy rim.
        let cell = floor(p.xz / 6.0);
        let h = hash2(cell + vec2<f32>(p.y * 0.01, 0.0));
        let oil = h < 0.16 && !terrain && layer != 4;
        if (oil || h > 0.9) {
            let c = (cell + vec2<f32>(0.25 + 0.5 * hash2(cell + vec2<f32>(1.7, 0.3)), 0.25 + 0.5 * hash2(cell + vec2<f32>(4.3, 8.1)))) * 6.0;
            let rad = 0.6 + 1.5 * hash2(cell + vec2<f32>(9.1, 2.2));
            let d0 = length(p.xz - c) / rad;
            if (d0 < 2.2) {
                let d = d0 + (vnoise(p.xz * 1.4) - 0.5) * 0.7;
                if (oil) { a = a * mix(0.32, 1.0, smoothstep(0.45, 1.0, d)); }
                else { a = mix(a, vec3<f32>(0.045, 0.04, 0.035), (1.0 - smoothstep(0.15, 1.3, d * 0.75)) * 0.8); }
            }
        }
        if ((layer == 0 || layer == 2 || layer == 8) && length(p - camera.view_pos.xyz) < 70.0) {
            // Cracks only in patches, warped so the cells don't read as a grid; a thin line, broken up along its length.
            let cracked = smoothstep(0.55, 0.75, vnoise(p.xz * 0.11 + vec2<f32>(11.0, 3.0)));
            if (cracked > 0.0) {
                let q = p.xz + (vec2<f32>(vnoise(p.xz * 0.7), vnoise(p.xz * 0.7 + vec2<f32>(5.2, 1.3))) - 0.5) * 1.6;
                let line = (1.0 - smoothstep(0.0, 0.022, crack(q * 0.42))) * smoothstep(0.35, 0.6, vnoise(q * 2.3));
                a = a * (1.0 - 0.55 * cracked * line);
            }
        }
        let lying = smoothstep(0.55, 0.95, up) * smoothstep(0.3, 0.72, vnoise(p.xz * 0.23 + vec2<f32>(3.0, 1.0)));
        a = mix(a, DUST * (0.8 + 0.4 * vnoise(p.xz * 0.45)), world.misc.z * lying * select(0.75, 0.25, terrain));
    } else if (abs(up) < 0.45) {
        // Rain never came, but the condensers leaked: grime runs down from every ledge.
        let k = p.x * abs(n.z) + p.z * abs(n.x);
        let st = vnoise(vec2<f32>(k * 2.4, p.y * 0.11)) * 0.7 + vnoise(vec2<f32>(k * 7.0, p.y * 0.3)) * 0.3;
        a = a * (1.0 - 0.32 * smoothstep(0.42, 0.78, st));
    }
    return a;
}

// Noctis's old roads (ARCH.road): uv.x across (-1..1 the asphalt, a ragged margin to 1.35), uv.y
// meters along. Faded paint, cracks, potholes, sand blown over the edges and in drifts.
fn road_albedo(base: vec3<f32>, uv: vec2<f32>, p: vec3<f32>) -> vec3<f32> {
    let ax = abs(uv.x);
    var a = base * vec3<f32>(0.5, 0.48, 0.47);
    let worn = smoothstep(0.32, 0.62, vnoise(p.xz * 0.35 + vec2<f32>(7.0, 2.0)));
    // A dashed center line and the edge lines, mostly gone.
    let center = (1.0 - smoothstep(0.022, 0.034, ax)) * step(fract(uv.y / 9.0), 0.5);
    let edge = 1.0 - smoothstep(0.016, 0.028, abs(ax - 0.88));
    a = mix(a, vec3<f32>(0.72, 0.58, 0.26), center * worn * 0.8);
    a = mix(a, vec3<f32>(0.7, 0.68, 0.62), edge * worn * 0.6);
    // Alligator cracking in patches, near enough to see.
    let cracked = smoothstep(0.5, 0.68, vnoise(p.xz * 0.09 + vec2<f32>(2.0, 9.0)));
    if (cracked > 0.0 && length(p - camera.view_pos.xyz) < 70.0) {
        let q = p.xz + (vec2<f32>(vnoise(p.xz * 0.9), vnoise(p.xz * 0.9 + vec2<f32>(5.2, 1.3))) - 0.5) * 1.2;
        a = a * (1.0 - 0.5 * cracked * (1.0 - smoothstep(0.0, 0.03, crack(q * 0.9))) * smoothstep(0.3, 0.55, vnoise(q * 3.0)));
    }
    // A long crack along the lanes in places.
    let seam = abs(fract(uv.x * 2.0 + vnoise(vec2<f32>(uv.y * 0.07, 0.0)) * 0.8) - 0.5);
    a = a * (1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.012, seam)) * smoothstep(0.55, 0.7, vnoise(vec2<f32>(uv.y * 0.05, uv.x))));
    // Potholes: dark rims, sand in the bottom.
    let cell = floor(vec2<f32>(uv.x * 2.0, uv.y / 5.0));
    if (hash2(cell + vec2<f32>(3.0, 1.0)) > 0.86) {
        let c = vec2<f32>((cell.x + 0.5) / 2.0, (cell.y + 0.5) * 5.0);
        let d = length(vec2<f32>((uv.x - c.x) * 3.5, (uv.y - c.y) * 0.9)) + (vnoise(p.xz * 2.0) - 0.5) * 0.5;
        a = mix(a, a * 0.35, 1.0 - smoothstep(0.55, 0.75, d));
        a = mix(a, DUST * 0.75, 1.0 - smoothstep(0.0, 0.5, d));
    }
    // Sand: over the shoulders and in drifts across.
    let drift = smoothstep(0.7, 0.95, vnoise(p.xz * 0.12) * 0.8 + ax * 0.35 + vnoise(p.xz * 0.9) * 0.15);
    return mix(a, DUST * (0.75 + 0.3 * vnoise(p.xz * 3.0)), drift);
}

@fragment
fn fs_main(in: VOut) -> GOut {
    let kind = i32(in.params.x + 0.5);
    if (kind == 1) { discard; }
    let terrain = kind == 0 && in.params.y > 0.5;
    let p = in.world_pos;
    if (kind == ${ARCH.road}) {
        // The ragged edge, and nothing past it.
        if (abs(in.uv.x) > 1.0 + 0.2 * (vnoise(vec2<f32>(in.uv.y * 0.3, in.uv.x * 2.0)) - 0.4)) { discard; }
    }
    if (kind == ${ARCH.scrub}) {
        // Blades across the card, each its own height and lean; thinning away from the camera.
        let dist = length(p - camera.view_pos.xyz);
        if (dist > 90.0 || hash2(floor(p.xz * 3.0)) < (dist - 55.0) / 35.0) { discard; }
        let bx = in.uv.x * 13.0;
        let id = floor(bx);
        let seed = in.vcolor.r * 37.0 + in.vcolor.g * 11.0;
        let hb = 0.35 + 0.65 * hash2(vec2<f32>(id, seed));
        let lean = (hash2(vec2<f32>(id + 3.1, seed)) - 0.5) * 0.9;
        let x = fract(bx) - 0.5 - lean * in.uv.y * in.uv.y;
        if (in.uv.y > hb || abs(x) > 0.36 * (1.0 - in.uv.y / hb)) { discard; }
    }
    let dp1 = dpdx(p); let dp2 = dpdy(p);
    var uv = in.uv;
    if (kind == 2) { uv = p.xz / 9.0; }
    if (kind == 3) { uv = in.uv * in.extra.z; }
    let packed = in.vcolor.a;
    var layer = i32(floor(packed + 0.001));
    var open = clamp(fract(packed + 0.001) / 0.99, 0.0, 1.0);
    if (kind == 3) { layer = i32(in.extra.x + 0.5); open = in.extra.w; }
    if (kind == ${ARCH.road}) { layer = 8; open = clamp(packed / 0.99, 0.0, 1.0); uv = vec2<f32>(in.uv.x * 1.3, in.uv.y / 3.0); }
    if (kind == ${ARCH.scrub}) { layer = 4; open = clamp(packed / 0.99, 0.0, 1.0); }
    // The ground is mapped from the world: from above here, from the side on the cliffs (below).
    if (terrain) { uv = p.xz / tile_of(layer); }
    let duv1 = dpdx(uv); let duv2 = dpdy(uv);
    var base = textureSample(base_maps, tile_sampler, uv, layer).rgb;
    var nm = textureSample(normal_maps, tile_sampler, uv, layer).xyz * 2.0 - 1.0;
    var rough = textureSample(rough_maps, tile_sampler, uv, layer).r;
    var n = normalize(in.normal);
    var puv = uv; var pd1 = duv1; var pd2 = duv2;
    if (terrain) {
        let t = tile_of(layer);
        // Against tiling: the same material three times larger and turned, blended in patches.
        let rot = mat2x2<f32>(0.8, 0.6, -0.6, 0.8);
        let big = rot * p.xz / (t * 3.3);
        let g1 = rot * dp1.xz / (t * 3.3); let g2 = rot * dp2.xz / (t * 3.3);
        let wide = textureSampleGrad(base_maps, tile_sampler, big, layer, g1, g2).rgb;
        base = mix(base, wide, 0.25 + 0.4 * vnoise(p.xz * 0.05));
        // Cliffs: a side projection along whichever horizontal axis the slope faces.
        let top = smoothstep(0.5, 0.8, abs(n.y));
        if (top < 0.999) {
            let alongz = abs(n.x) > abs(n.z);
            let suv = select(vec2<f32>(p.x, -p.y), vec2<f32>(p.z, -p.y), alongz) / t;
            let s1 = select(vec2<f32>(dp1.x, -dp1.y), vec2<f32>(dp1.z, -dp1.y), alongz) / t;
            let s2 = select(vec2<f32>(dp2.x, -dp2.y), vec2<f32>(dp2.z, -dp2.y), alongz) / t;
            base = mix(textureSampleGrad(base_maps, tile_sampler, suv, layer, s1, s2).rgb, base, top);
            nm = mix(textureSampleGrad(normal_maps, tile_sampler, suv, layer, s1, s2).xyz * 2.0 - 1.0, nm, top);
            rough = mix(textureSampleGrad(rough_maps, tile_sampler, suv, layer, s1, s2).r, rough, top);
            if (top < 0.5) { puv = suv; pd1 = s1; pd2 = s2; }
        }
        // Large-scale color: darker hollows, paler crests, rust-red and ochre drifts.
        let m = vnoise(p.xz * 0.013 + vec2<f32>(4.0, 1.0));
        base = base * mix(vec3<f32>(0.82, 0.8, 0.8), vec3<f32>(1.12, 1.02, 0.92), m) * (0.9 + 0.2 * vnoise(p.xz * 0.17));
    }
    // Solids use the shared shapes, whose vertex colour is black: their tint alone colours them.
    var albedo = base * select(in.vcolor.rgb, vec3<f32>(1.0), kind == 3 || kind == ${ARCH.road} || kind == ${ARCH.scrub}) * in.color.rgb;
    if (kind == ${ARCH.scrub}) {
        // Dry grass and creeper: dark at the root, ochre to rust at the tips; the tint varies per tuft.
        let v = in.uv.y;
        let tip = mix(vec3<f32>(0.4, 0.29, 0.19), vec3<f32>(0.34, 0.13, 0.1), step(0.82, in.vcolor.b - 0.4 * in.vcolor.g + 0.2));
        let c = mix(vec3<f32>(0.1, 0.065, 0.05), tip * in.vcolor.rgb, smoothstep(0.0, 0.8, v));
        return gbuffer(c * (0.8 + 0.3 * hash2(floor(in.uv * 13.0) + in.vcolor.rg)), n, 0.0, 0.9, 0.0, open, 0.0);
    }
    n = perturb(n, p, puv, vec3<f32>(nm.x, nm.y, max(nm.z, 0.2)), dp1, dp2, pd1, pd2);
    var o = open;
    if (kind == 2) {
        // The plain far below: dust drifts, darker craters.
        let w = fbm2(p.xz * 0.004);
        albedo = albedo * (0.7 + 0.5 * w);
        o = 1.0;
    }
    if (kind == ${ARCH.road}) {
        return gbuffer(road_albedo(albedo, in.uv, p), n, 0.0, clamp(rough * 1.1, 0.4, 1.0), 0.0, o, 0.0);
    }
    if (kind == 3) {
        // A solid: its own metalness, a glow of its tint (the albedo turns toward the tint as it glows), a heat for the heat lens.
        let glowing = mix(albedo, in.color.rgb, clamp(in.params.z * 2.0, 0.0, 1.0));
        return gbuffer(glowing, n, in.params.z, clamp(rough, 0.15, 1.0), in.extra.y, o, in.params.w);
    }
    // Grime: darker low on walls and in the corners of slabs; then the wear.
    let grime = 1.0 - 0.25 * fbm2(p.xz * 0.35 + p.y * 0.2);
    var a = albedo * grime;
    if (kind == 0) { a = wear(a, p, normalize(in.normal), layer, terrain); }
    return gbuffer(a, n, 0.0, clamp(rough, 0.2, 1.0), 0.0, o, 0.0);
}
`;

// The sky dome, forward, after the lighting: it sits at SKY_DEPTH, so only empty pixels take it.
const SKY_SRC = /* wgsl */ `
${COMMON}
fn heat_palette(t: f32) -> vec3<f32> {
    let c0 = vec3<f32>(0.02, 0.02, 0.12); let c1 = vec3<f32>(0.35, 0.0, 0.55);
    return mix(c0, c1, t / 0.33);
}

@vertex
fn vs_main(in: VertexInput, @builtin(instance_index) ii: u32) -> VOut {
    var out = standard_vertex(in, items[ii]);
    let wp = camera.view_pos.xyz + in.position * 5000.0;
    let clip = camera.view_proj * vec4<f32>(wp, 1.0);
    out.clip = vec4<f32>(clip.xy, clip.w * ${SKY_DEPTH}, clip.w);
    out.world_pos = wp;
    return out;
}

@fragment
fn fs_main(in: VOut) -> FOut {
    var o: FOut;
    let d = normalize(in.world_pos - camera.view_pos.xyz);
    var col = sky_color(d);
    let lens = i32(world.time.z + 0.5);
    if (lens == 1) { col = vec3<f32>(0.25, 1.0, 0.35) * dot(col, vec3<f32>(0.3, 0.55, 0.15)) * 2.0; }
    if (lens == 2) { col = heat_palette(0.08); }
    if (lens == 4) { col = vec3<f32>(0.03, 0.09, 0.14) + col * 0.15; }
    o.color = vec4<f32>(col, 1.0);
    return o;
}
`;

// Deferred lighting: one full-screen triangle; every pixel with geometry runs shade() once.
const LIGHT_SRC = /* wgsl */ `
${HEAD}
${SHADOW}
${SHADE}
@group(1) @binding(0) var g_albedo: texture_2d<f32>;
@group(1) @binding(1) var g_normal: texture_2d<f32>;
@group(1) @binding(2) var g_material: texture_2d<f32>;
@group(1) @binding(3) var g_depth: texture_depth_2d;

struct LOut { @builtin(position) pos: vec4<f32> };

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> LOut {
    var out: LOut;
    let x = f32((i << 1u) & 2u);
    let y = f32(i & 2u);
    out.pos = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
    return out;
}

// The world point at this pixel: clip = view_proj * p with clip.xy = ndc * w and clip.w = w
// (= NEAR / depth), three linear equations in p - rows 0, 1 and 3 of view_proj.
fn world_at(ndc: vec2<f32>, w: f32) -> vec3<f32> {
    let m = camera.view_proj;
    let r0 = vec4<f32>(m[0][0], m[1][0], m[2][0], m[3][0]);
    let r1 = vec4<f32>(m[0][1], m[1][1], m[2][1], m[3][1]);
    let r3 = vec4<f32>(m[0][3], m[1][3], m[2][3], m[3][3]);
    let a = r0.xyz; let b = r1.xyz; let c = r3.xyz;
    let k = vec3<f32>(ndc.x * w - r0.w, ndc.y * w - r1.w, w - r3.w);
    let bc = cross(b, c); let ca = cross(c, a); let ab = cross(a, b);
    let det = dot(a, bc);
    return (k.x * bc + k.y * ca + k.z * ab) / det;
}

@fragment
fn fs_main(in: LOut) -> @location(0) vec4<f32> {
    let px = vec2<i32>(in.pos.xy);
    let d = textureLoad(g_depth, px, 0);
    // Nothing drawn here: the sky comes after.
    if (d <= ${SKY_DEPTH * 2}) { return vec4<f32>(0.0, 0.0, 0.0, 0.0); }
    let size = vec2<f32>(textureDimensions(g_depth));
    let ndc = vec2<f32>(in.pos.x / size.x * 2.0 - 1.0, 1.0 - in.pos.y / size.y * 2.0);
    let p = world_at(ndc, ${NEAR} / d);
    let alb = textureLoad(g_albedo, px, 0);
    let nrm = textureLoad(g_normal, px, 0);
    let mat = textureLoad(g_material, px, 0);
    let n = normalize(nrm.xyz);
    let col = shade(alb.rgb, n, p, mat.x, mat.y, mat.z, alb.rgb * nrm.w, mat.w);
    return vec4<f32>(col, 1.0);
}
`;

const GLOW_SRC = /* wgsl */ `
${COMMON}

@vertex
fn vs_main(in: VertexInput, @builtin(instance_index) ii: u32) -> VOut {
    let it = items[ii];
    var out = standard_vertex(in, it);
    let kind = i32(it.params.x + 0.5);
    let center = it.model[3].xyz;
    if (kind == 0 || kind == 5) {
        // Camera-facing dot of radius |model x axis|.
        let size = length(it.model[0].xyz);
        let f = normalize(center - camera.view_pos.xyz);
        let r = normalize(cross(f, vec3<f32>(0.0, 1.0, 0.0)) + vec3<f32>(1e-5, 0.0, 0.0));
        let u = cross(r, f);
        let wp = center + (r * in.position.x + u * in.position.y) * size;
        let clip = camera.view_proj * vec4<f32>(wp, 1.0);
        out.clip = far_depth(clip); out.world_pos = wp;
    } else if (kind == 1) {
        // A beam from the item's origin along its z axis (length = |z|), width extra.x, turned to face the camera.
        let axis = it.model[2].xyz;
        let len = length(axis);
        let a = axis / max(len, 1e-5);
        let mid = center + axis * 0.5;
        let side = normalize(cross(a, normalize(camera.view_pos.xyz - mid)) + vec3<f32>(1e-5, 0.0, 0.0));
        let wp = center + axis * (in.position.y * 0.5 + 0.5) + side * in.position.x * it.extra.x;
        let clip = camera.view_proj * vec4<f32>(wp, 1.0);
        out.clip = far_depth(clip); out.world_pos = wp;
    }
    return out;
}

@fragment
fn fs_main(in: VOut) -> FOut {
    let kind = i32(in.params.x + 0.5);
    let t = world.time.x;
    var c = in.color.rgb;
    var a = in.color.w;
    let lens = i32(world.time.z + 0.5);
    // Simulation-only light (params.y = 1) shows through the simulation lens alone.
    if (in.params.y > 0.5 && lens != 4) { discard; }
    if (kind == 0 || kind == 5) {
        let r = length(in.local.xy);
        a = a * pow(max(1.0 - r, 0.0), select(2.0, 3.0, kind == 5));
    } else if (kind == 1) {
        let x = abs(in.local.x);
        a = a * (pow(max(1.0 - x, 0.0), 2.0) + 0.6 * pow(max(1.0 - x, 0.0), 12.0));
        c = mix(c, vec3<f32>(1.0), pow(max(1.0 - x, 0.0), 10.0));
    } else if (kind == 2) {
        // Hologram: scanlines and flicker, brighter where the surface turns away.
        let v = normalize(camera.view_pos.xyz - in.world_pos);
        let rim = 1.0 - abs(dot(normalize(in.normal), v));
        let scan = 0.55 + 0.45 * sin(in.world_pos.y * 60.0 - t * 6.0);
        let flick = 0.85 + 0.15 * step(0.1, fract(sin(floor(t * 14.0)) * 9123.1));
        a = a * (0.18 + rim * 0.9) * scan * flick;
    } else if (kind == 3) {
        // The dark zone: a violet shell that churns, almost black inside.
        let v = normalize(camera.view_pos.xyz - in.world_pos);
        let rim = 1.0 - abs(dot(normalize(in.normal), v));
        let swirl = fbm2(in.local.xz * 3.0 + vec2<f32>(t * 0.3, -t * 0.21) + in.local.y * 2.0);
        a = a * (pow(rim, 2.5) * 1.4 + swirl * 0.25);
        c = mix(vec3<f32>(0.25, 0.0, 0.6), vec3<f32>(0.7, 0.3, 1.0), swirl);
    } else if (kind == 4) {
        // Hypercube edges: hot core.
        let v = normalize(camera.view_pos.xyz - in.world_pos);
        let facing = abs(dot(normalize(in.normal), v));
        a = a * (0.4 + 0.6 * facing);
        c = mix(c, vec3<f32>(1.0), facing * facing * 0.7);
    } else if (kind == 6) {
        let r = length(in.local.xz);
        a = a * smoothstep(0.75, 0.9, r) * smoothstep(1.0, 0.92, r) * (0.6 + 0.4 * sin(t * 4.0));
    }
    if (lens == 2) { c = vec3<f32>(1.0, 0.85, 0.4); }
    var o: FOut;
    o.color = vec4<f32>(c * a, 1.0);
    return o;
}
`;

const SCREEN_SRC = /* wgsl */ `
struct Camera { view_proj: mat4x4<f32>, view_pos: vec4<f32> };
@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var frame: texture_2d<f32>;
@group(1) @binding(1) var samp: sampler;
@group(1) @binding(2) var depth: texture_depth_2d;
struct Post {
    a: vec4<f32>,   // fog density at the floor (1/m), fog scale height (m), fog floor y, time
    b: vec4<f32>,   // fog color, exposure
    c: vec4<f32>,   // vignette, grain, hurt, fade to black
    d: vec4<f32>,   // lens, glitch, letterbox (0..1), saturation
    fwd: vec4<f32>, // camera forward, tan(half fov y)
    right: vec4<f32>, // camera right, aspect
    up: vec4<f32>,  // camera up, sim pulse
    sun: vec4<f32>, // direction to the sun, haze sun glow strength
};
@group(2) @binding(0) var<uniform> post: Post;
struct VO { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VO {
    var out: VO;
    let x = f32((i << 1u) & 2u);
    let y = f32(i & 2u);
    out.pos = vec4<f32>(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
    out.uv = vec2<f32>(x, y);
    return out;
}

fn hash2(p: vec2<f32>) -> f32 { var q = fract(p * vec2<f32>(123.34, 456.21)); q = q + dot(q, q + 45.32); return fract(q.x * q.y); }

fn dist_at(px: vec2<i32>) -> f32 {
    let size = vec2<i32>(textureDimensions(depth));
    let d = textureLoad(depth, clamp(px, vec2<i32>(0), size - vec2<i32>(1)), 0);
    if (d <= ${SKY_DEPTH * 2}) { return 1e6; }
    return ${NEAR} / d;
}

fn filmic(x: vec3<f32>) -> vec3<f32> {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_main(in: VO) -> @location(0) vec4<f32> {
    let size = vec2<f32>(textureDimensions(frame));
    let t = post.a.w;
    var uv = in.uv;
    let glitch = post.d.y;
    // The Error: rows of the image shove sideways in blocks.
    if (glitch > 0.0) {
        let row = floor(uv.y * 40.0);
        let k = hash2(vec2<f32>(row, floor(t * 12.0)));
        if (k > 1.0 - glitch * 0.35) { uv.x = uv.x + (hash2(vec2<f32>(row, t)) - 0.5) * 0.08 * glitch; }
    }
    let px = vec2<i32>(uv * size);
    let w = dist_at(px);
    var col = textureSampleLevel(frame, samp, uv, 0.0).rgb;
    if (glitch > 0.0) {
        let off = vec2<f32>(0.006 * glitch, 0.0);
        col.r = textureSampleLevel(frame, samp, uv + off, 0.0).r;
        col.b = textureSampleLevel(frame, samp, uv - off, 0.0).b;
    }
    let lens = i32(post.d.x + 0.5);
    // The view ray of this pixel, for the height fog and the sun's glow in the haze.
    let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let dir = normalize(post.fwd.xyz + post.right.xyz * ndc.x * post.fwd.w * post.right.w + post.up.xyz * ndc.y * post.fwd.w);
    // Exponential height fog: density a * exp(-(y - floor) / H), integrated along the ray.
    if (w < 9e5 && lens != 4) {
        let cam = camera.view_pos.xyz;
        let len = w / max(dot(dir, post.fwd.xyz), 0.05);
        let H = post.a.y;
        let y0 = cam.y - post.a.z;
        let dy = dir.y * len;
        var od: f32;
        if (abs(dy) < 0.01) { od = post.a.x * exp(-y0 / H) * len; }
        else { od = post.a.x * H * exp(-y0 / H) * (1.0 - exp(-dy / H)) / dir.y; }
        let f = 1.0 - exp(-max(od, 0.0));
        let glow = pow(max(dot(dir, normalize(post.sun.xyz)), 0.0), 6.0) * post.sun.w;
        var fogc = post.b.rgb * (1.0 + glow);
        if (lens == 1) { fogc = vec3<f32>(0.1, 0.4, 0.14) * dot(fogc, vec3<f32>(0.3, 0.55, 0.15)) * 3.0; }
        if (lens == 2) { fogc = vec3<f32>(0.03, 0.02, 0.15); }
        col = mix(col, fogc, f);
    }
    // Simulation lens: depth edges drawn as cyan lines, a sweeping pulse.
    if (lens == 4) {
        let e = abs(dist_at(px + vec2<i32>(1, 0)) - w) + abs(dist_at(px + vec2<i32>(0, 1)) - w);
        let edge = smoothstep(0.02, 0.2, e / max(w, 1.0));
        let pulse = smoothstep(0.0, 0.08, 0.08 - abs(fract(w * 0.02 - t * 0.35) - 0.5) * 0.16) ;
        col = col + vec3<f32>(0.2, 0.85, 1.0) * (edge * select(0.8, 0.15, w > 9e5) + pulse * 0.12);
        col = col + vec3<f32>(0.0, 0.12, 0.18) * (0.5 + 0.5 * sin(uv.y * size.y * 1.5));
    }
    col = filmic(col * post.b.w);
    let sat = post.d.w;
    let lum = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
    col = mix(vec3<f32>(lum), col, sat);
    if (lens == 1) { col = col + (hash2(uv * size + t) - 0.5) * 0.12; }
    if (lens == 3) {
        // Distance lens: a ranging reticle vignette.
        let r = length((uv - 0.5) * vec2<f32>(size.x / size.y, 1.0));
        col = col * smoothstep(0.62, 0.42, r);
        col = col + vec3<f32>(0.9, 0.7, 0.3) * smoothstep(0.003, 0.0, abs(r - 0.41)) * 0.6;
    }
    // Hurt: red at the edges.
    let edge_r = length(uv - 0.5);
    col = mix(col, vec3<f32>(0.6, 0.02, 0.02), post.c.z * smoothstep(0.25, 0.75, edge_r));
    col = col * mix(1.0, 1.0 - smoothstep(0.35, 0.85, edge_r), post.c.x);
    col = col + (hash2(uv * size + vec2<f32>(t * 61.0, t * 17.0)) - 0.5) * post.c.y;
    // Letterbox for cutscenes.
    let bar = post.d.z * 0.12;
    if (uv.y < bar || uv.y > 1.0 - bar) { col = vec3<f32>(0.0); }
    col = mix(col, vec3<f32>(0.0), post.c.w);
    return vec4<f32>(col, 1.0);
}
`;

export const TE_ASSET_SHADER = ASSET_SRC;
export const TE_ARCH_SHADER = ARCH_SRC;
export const TE_SKY_SHADER = SKY_SRC;
export const TE_LIGHT_SHADER = LIGHT_SRC;
export const TE_GLOW_SHADER = GLOW_SRC;
export const TE_SCREEN_SHADER = SCREEN_SRC;
