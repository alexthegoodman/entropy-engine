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
// Material ids ride in uv.x's integer part and the chunk's quadtree level in uv.y's; terrain
// chunks put their local grid position in the fractions (qp_quadtree.ts packChunkUv) so the debug
// view can color each level and outline each chunk.

/** Floats in the World uniform (9 vec4). */
export const WORLD_FLOATS = 36;
/** Floats in the per-object Item uniform: model matrix + tint. */
export const ITEM_FLOATS = 20;
export const MAX_PLANETS = 3;

export interface WorldUniform {
    sunDir: [number, number, number];
    time: number;
    sunColor: [number, number, number];
    exposure: number;
    debugLod: boolean;
    planets: { center: [number, number, number]; radius: number; atmosphere: [number, number, number]; atmosphereHeight: number }[];
}

export function packWorld(w: WorldUniform): Float32Array {
    const out = new Float32Array(WORLD_FLOATS);
    out.set([...w.sunDir, w.time], 0);
    out.set([...w.sunColor, 0], 4);
    out.set([w.exposure, w.debugLod ? 1 : 0, Math.min(MAX_PLANETS, w.planets.length), 0], 8);
    for (let i = 0; i < MAX_PLANETS; i++) {
        const p = w.planets[i];
        if (!p) continue;
        out.set([...p.center, p.radius], 12 + i * 4);
        out.set([...p.atmosphere, p.atmosphereHeight], 24 + i * 4);
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
    params: vec4<f32>,         // x = exposure, y = LOD debug tint, z = planet count
    planet: array<vec4<f32>, 3>,     // center xyz, radius
    atmosphere: array<vec4<f32>, 3>, // color rgb, shell thickness
};
@group(2) @binding(0) var<uniform> world: World;

struct Item {
    model: mat4x4<f32>,
    tint: vec4<f32>,           // rgb multiplies paint, w = glow boost
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
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let material = i32(floor(in.tex_coords.x + 0.0005));
    if (material == 9) {
        // The sky sphere rides with the camera and sits at the far end of the depth range.
        let w = camera.view_pos.xyz + in.position * 30000.0;
        var clip = camera.view_proj * vec4<f32>(w, 1.0);
        clip.z = clip.w * 0.99999;
        out.clip_position = clip;
        out.world_pos = w;
        out.normal = in.normal;
    } else {
        let w = item.model * vec4<f32>(in.position, 1.0);
        out.clip_position = camera.view_proj * w;
        out.world_pos = w.xyz;
        out.normal = (item.model * vec4<f32>(in.normal, 0.0)).xyz;
    }
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

// Ray (origin o, unit dir d) against a sphere: (t_enter, t_exit), or t_exit < 0 when missed.
fn sphere_hit(o: vec3<f32>, d: vec3<f32>, c: vec3<f32>, r: f32) -> vec2<f32> {
    let oc = o - c;
    let b = dot(oc, d);
    let h = b * b - (dot(oc, oc) - r * r);
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
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let material = i32(floor(in.uv.x + 0.0005));
    let cam = camera.view_pos.xyz;
    let sun = normalize(world.sun_dir.xyz);
    let count = i32(world.params.z);

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
        return finish(col);
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
    let ndl = max(dot(n, sun), 0.0);
    // Sky light from above (colored by the atmosphere by day) and a little starlight at night.
    let sky_amb = atmo * (0.22 + 0.18 * max(dot(n, up), 0.0)) * day + vec3<f32>(0.012, 0.014, 0.02);
    var base = linear(in.color.rgb);
    var col = vec3<f32>(0.0);

    if (material == 4) {
        col = base * (1.1 + item.tint.w * 2.2);
    } else if (material == 5) {
        let r = reflect(-v, n);
        let fres = 0.08 + 0.92 * pow(1.0 - max(dot(n, v), 0.0), 4.0);
        col = base * 0.12 + sky_amb * 0.6 * fres + world.sun_color.rgb * pow(max(dot(r, sun), 0.0), 180.0) * 3.0;
    } else {
        if (material == 3) { base = base * item.tint.rgb; }
        var spec = 0.0;
        var shin = 16.0;
        if (material == 1) { spec = 1.2; shin = 140.0; }
        if (material == 2) { spec = 0.45; shin = 40.0; }
        if (material == 3) { spec = 0.35; shin = 48.0; }
        let h = normalize(sun + v);
        let s = pow(max(dot(n, h), 0.0), shin) * spec * ndl;
        // Terminator softening: the ground's own normal and the planet's curvature both count.
        let lit = ndl * smoothstep(-0.12, 0.2, dot(up, sun));
        col = base * (world.sun_color.rgb * lit * 1.35 + sky_amb) + world.sun_color.rgb * s;
        // Ship and suit: a faint fill from the camera so a back-lit model still reads.
        if (material == 3) { col = col + base * 0.14 * max(dot(n, v), 0.0); }
        if (material == 1) {
            let fres = pow(1.0 - max(dot(n, v), 0.0), 5.0);
            col = col + atmo * fres * 0.5 * day;
        }
        if (world.params.y > 0.5 && material <= 2) {
            let level = floor(in.uv.y + 0.0005);
            let local = vec2<f32>(in.uv.x - f32(material), in.uv.y - level);
            let tint = linear(lod_color(level)) * (0.25 + 0.75 * lit + 0.1);
            col = mix(col, tint, 0.6);
            // Outline every chunk: darken within ~1.5 pixels of its border.
            let edge = min(min(local.x, 1.0 - local.x), min(local.y, 1.0 - local.y));
            let line = 1.0 - smoothstep(0.0, max(fwidth(edge) * 1.5, 0.0001), edge - 0.001);
            col = mix(col, vec3<f32>(0.01), line * 0.85);
        }
    }

    // Aerial perspective through every atmosphere between the camera and this point.
    for (var i = 0; i < count; i = i + 1) {
        let hz = atmosphere_segment(cam, -v, i, dist, 0.1, 1.0);
        col = col * hz.transmit + hz.light;
    }
    return finish(col);
}
`;
