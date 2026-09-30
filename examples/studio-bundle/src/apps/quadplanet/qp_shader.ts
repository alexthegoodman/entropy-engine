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

/** Floats in the World uniform (11 vec4). */
export const WORLD_FLOATS = 44;
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
}

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
    return out;
}

export const MATERIAL_PAINT = 3;
export const MATERIAL_GLOW = 4;
export const MATERIAL_GLASS = 5;
export const MATERIAL_SKY = 9;

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

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let material = i32(floor(in.tex_coords.x + 0.0005));
    var clip: vec4<f32>;
    if (material == 9) {
        // The sky sphere rides with the camera and sits at the far end of the depth range.
        let w = camera.view_pos.xyz + in.position * 30000.0;
        clip = camera.view_proj * vec4<f32>(w, 1.0);
        clip.z = clip.w * SKY_DEPTH;
        out.world_pos = w;
        out.normal = in.normal;
    } else {
        let w = item.model * vec4<f32>(in.position, 1.0);
        clip = camera.view_proj * w;
        // Logarithmic depth (rewritten exactly per fragment); anything in front of the camera
        // stays inside the clip volume, however near or far.
        clip.z = log_depth(clip.w) * clip.w;
        out.world_pos = w.xyz;
        out.normal = (item.model * vec4<f32>(in.normal, 0.0)).xyz;
    }
    out.clip_position = clip;
    out.view_w = clip.w;
    out.tex_pos = in.position + item.tex_origin.xyz;
    out.uv = in.tex_coords;
    out.color = in.color;
    return out;
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
        out.color = finish(col);
        out.depth = SKY_DEPTH;
        return out;
    }
    out.depth = log_depth(in.view_w);

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

    if (material == 4) {
        col = base * (1.1 + item.tint.w * 2.2);
    } else if (material == 5) {
        let r = reflect(-v, n);
        let fres = 0.08 + 0.92 * pow(1.0 - max(dot(n, v), 0.0), 4.0);
        let sky_amb = atmo * (0.22 + 0.18 * max(dot(n, up), 0.0)) * day + vec3<f32>(0.012, 0.014, 0.02);
        col = base * 0.12 + sky_amb * 0.6 * fres + world.sun_color.rgb * pow(max(dot(r, sun), 0.0), 180.0) * 3.0;
    } else {
        if (material == 3) { base = base * item.tint.rgb; }
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
        let ndl = max(dot(n, sun), 0.0);
        // Sky light from above (colored by the atmosphere by day) and a little starlight at night.
        let sky_amb = atmo * (0.22 + 0.18 * max(dot(n, up), 0.0)) * day + vec3<f32>(0.012, 0.014, 0.02);
        let h = normalize(sun + v);
        let s = pow(max(dot(n, h), 0.0), shin) * spec * ndl;
        // Terminator softening: the ground's own normal and the planet's curvature both count.
        let lit = ndl * smoothstep(-0.12, 0.2, dot(up, sun));
        col = base * (world.sun_color.rgb * lit * 1.35 + sky_amb * ao) + world.sun_color.rgb * s * smoothstep(-0.12, 0.2, dot(up, sun));
        // Ship and suit: a faint fill from the camera so a back-lit model still reads.
        if (material == 3) { col = col + base * 0.14 * max(dot(n, v), 0.0); }
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
