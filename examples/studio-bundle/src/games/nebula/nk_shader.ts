// Nebula Kingdom's shaders. Two pipelines draw everything, both instanced (each instance's Item
// comes from a storage buffer by @builtin(instance_index)):
//
//   SOLID  opaque meshes - the sky (with black holes bending it), asteroids, moons, planets,
//          gas giants, stars, horizons, the hides of creatures, envoys' crystal.
//   GLOW   additive light on quads - the gas a nebula is made of, coronas, lightwaves, bolts,
//          accretion discs, rings, sparks, the rift. Nothing here hides anything: it only adds.
//
// Space is drawn in the player's own units (1 = the nebula's radius) around the player, so a
// moon and a hypergiant both fit a float. Depth is written as w / (w + 80): nothing is ever
// beyond the far plane, however far away it is.
//
// Item.params.x picks the kind (see SOLID_KIND / GLOW_KIND); params.y is a per-thing seed.

export const WORLD_FLOATS = 21 * 4;
export const ITEM_FLOATS = 28;
export const MAX_LIGHTS = 4;
export const MAX_HOLES = 4;

export const SOLID_KIND = { rock: 0, planet: 1, star: 2, horizon: 3, hide: 4, crystal: 5, sky: 9 } as const;
export const PLANET_LOOK = { rock: 0, ice: 1, ocean: 2, lava: 3, desert: 4, gas: 5, banded: 6 } as const;
export const GLOW_KIND = {
    gas: 0, halo: 1, corona: 2, wave: 3, spark: 4, bolt: 5, disc: 6, rings: 7, rift: 8, photon: 9,
    fire: 11, shock: 12, mark: 13, mote: 14, stream: 15,
} as const;
/** How a GLOW quad is placed (Item.params.w): facing the camera, along an axis, or flat in a plane. */
export const PLACE = { billboard: 0, axial: 1, planar: 2 } as const;

const COMMON = /* wgsl */ `
struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0) var<uniform> camera: Camera;

struct Light { pos: vec4<f32>, color: vec4<f32> };

struct World {
    time: vec4<f32>,       // seconds, warp (0..1 folding), attune (0..1), flash
    cam_right: vec4<f32>,  // xyz, aspect
    cam_up: vec4<f32>,     // xyz, tan(fov / 2)
    cam_fwd: vec4<f32>,    // xyz, hurt (0..1)
    sky_deep: vec4<f32>,   // rgb, cloud amount
    sky_a: vec4<f32>,      // rgb, star amount
    sky_b: vec4<f32>,      // rgb, galaxy seed
    grade: vec4<f32>,      // exposure, saturation, vignette, fade to black
    screen: vec4<f32>,     // w, h, lights, holes
    lights: array<Light, ${MAX_LIGHTS}>,   // pos.w: reach (0: a sun, no falloff); color.w: intensity
    holes: array<vec4<f32>, ${MAX_HOLES}>, // xyz, horizon radius
};
@group(2) @binding(0) var<uniform> world: World;

struct Item {
    model: mat4x4<f32>,
    color: vec4<f32>,
    params: vec4<f32>,     // kind, seed, look / shape, placement or integrity
    extra: vec4<f32>,
};
@group(2) @binding(1) var<storage, read> items: array<Item>;

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
    @location(3) local: vec3<f32>,
    @location(4) @interpolate(flat) color: vec4<f32>,
    @location(5) @interpolate(flat) params: vec4<f32>,
    @location(6) @interpolate(flat) extra: vec4<f32>,
};

fn far_depth(clip: vec4<f32>) -> vec4<f32> {
    let w = max(clip.w, 0.00001);
    return vec4<f32>(clip.xy, clip.w * (w / (w + 80.0)), clip.w);
}

fn hash3(p: vec3<f32>) -> f32 {
    var q = fract(p * vec3<f32>(0.1031, 0.1030, 0.0973));
    q = q + dot(q, q.yxz + 33.33);
    return fract((q.x + q.y) * q.z);
}

fn hash33(p: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(hash3(p), hash3(p + vec3<f32>(17.1, 3.7, 9.2)), hash3(p + vec3<f32>(5.3, 41.9, 23.4)));
}

fn vnoise(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = mix(hash3(i), hash3(i + vec3<f32>(1.0, 0.0, 0.0)), u.x);
    let b = mix(hash3(i + vec3<f32>(0.0, 1.0, 0.0)), hash3(i + vec3<f32>(1.0, 1.0, 0.0)), u.x);
    let c = mix(hash3(i + vec3<f32>(0.0, 0.0, 1.0)), hash3(i + vec3<f32>(1.0, 0.0, 1.0)), u.x);
    let d = mix(hash3(i + vec3<f32>(0.0, 1.0, 1.0)), hash3(i + vec3<f32>(1.0, 1.0, 1.0)), u.x);
    return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}

fn fbm(p_in: vec3<f32>, octaves: i32) -> f32 {
    var p = p_in;
    var s = 0.0;
    var a = 0.5;
    for (var i = 0; i < octaves; i = i + 1) {
        s = s + a * vnoise(p);
        p = p * 2.03 + vec3<f32>(11.7, 5.3, 8.1);
        a = a * 0.5;
    }
    return s;
}

fn grade(col_in: vec3<f32>, clip: vec4<f32>) -> vec3<f32> {
    var col = col_in;
    let luma = dot(col, vec3<f32>(0.2126, 0.7152, 0.0722));
    col = mix(vec3<f32>(luma), col, world.grade.y);
    let uv = clip.xy / max(world.screen.xy, vec2<f32>(1.0));
    let e = uv - vec2<f32>(0.5);
    let edge = smoothstep(0.3, 0.8, length(e * vec2<f32>(1.0, 0.85)));
    col = col * (1.0 - world.grade.z * edge);
    // Harm reddens the edge of sight; a flash whitens all of it.
    col = col + vec3<f32>(0.5, 0.03, 0.06) * world.cam_fwd.w * edge;
    col = mix(col, vec3<f32>(0.9, 0.97, 1.0), clamp(world.time.w, 0.0, 1.0));
    return col * (1.0 - world.grade.w);
}
`;

const SOLID = /* wgsl */ `
@vertex
fn vs_main(in: VertexInput, @builtin(instance_index) ii: u32) -> VertexOutput {
    let it = items[ii];
    var out: VertexOutput;
    var local = in.position;
    let kind = i32(it.params.x + 0.5);
    if (kind == 0) {
        // Rubble: every rock its own lump.
        let k = fbm(local * 1.6 + vec3<f32>(it.params.y * 37.0), 3);
        local = local * (0.72 + 0.62 * k);
    }
    var world_pos = (it.model * vec4<f32>(local, 1.0)).xyz;
    if (kind == 9) { world_pos = camera.view_pos.xyz + in.position * 400.0; }
    let sx = dot(it.model[0].xyz, it.model[0].xyz);
    let sy = dot(it.model[1].xyz, it.model[1].xyz);
    let sz = dot(it.model[2].xyz, it.model[2].xyz);
    let nl = in.normal / max(vec3<f32>(sx, sy, sz), vec3<f32>(1e-12));
    out.normal = normalize(it.model[0].xyz * nl.x + it.model[1].xyz * nl.y + it.model[2].xyz * nl.z);
    let clip = camera.view_proj * vec4<f32>(world_pos, 1.0);
    out.clip_position = far_depth(clip);
    if (kind == 9) { out.clip_position = vec4<f32>(clip.xy, clip.w * 0.999999, clip.w); }
    out.world_pos = world_pos;
    out.uv = in.tex_coords;
    out.local = in.position;
    out.color = it.color;
    out.params = it.params;
    out.extra = it.extra;
    return out;
}

fn rot_y(p: vec3<f32>, a: f32) -> vec3<f32> {
    let c = cos(a);
    let s = sin(a);
    return vec3<f32>(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
}

// --- The sky -----------------------------------------------------------------------------------------

fn star_layer(dir: vec3<f32>, scale: f32, density: f32) -> vec3<f32> {
    let p = dir * scale;
    let cell = floor(p);
    let h = hash33(cell);
    if (h.x > density) { return vec3<f32>(0.0); }
    let center = cell + vec3<f32>(0.5) + (h - vec3<f32>(0.5)) * 0.6;
    let d = length(p - center);
    let bright = pow(h.y, 6.0) * 3.0 + 0.25;
    let twinkle = 0.85 + 0.15 * sin(world.time.x * (1.0 + h.z * 3.0) + h.x * 60.0);
    let core = smoothstep(0.22, 0.0, d) * bright * twinkle;
    // Blue-white through gold to ember.
    let tint = mix(mix(vec3<f32>(0.7, 0.8, 1.0), vec3<f32>(1.0, 0.95, 0.85), smoothstep(0.2, 0.6, h.z)), vec3<f32>(1.0, 0.65, 0.45), smoothstep(0.75, 1.0, h.z));
    return tint * core;
}

fn bend(dir_in: vec3<f32>) -> vec4<f32> {
    // Light passing a black hole is turned toward it: the sky behind is pulled into a ring.
    var dir = dir_in;
    var ring = 0.0;
    let n = i32(world.screen.w + 0.5);
    for (var i = 0; i < n; i = i + 1) {
        let h = world.holes[i];
        let to = h.xyz - camera.view_pos.xyz;
        let dist = length(to);
        let b = to / max(dist, 1e-6);
        let alpha = asin(clamp(h.w / max(dist, h.w * 1.02), 0.0, 1.0));
        let einstein = alpha * 1.9;
        let c = clamp(dot(dir, b), -1.0, 1.0);
        let theta = acos(c);
        if (theta < 1.4 && theta > 1e-4) {
            let fade = smoothstep(1.4, 0.5, theta);
            let bent = theta - fade * einstein * einstein / theta;
            let perp = normalize(dir - b * c);
            dir = normalize(b * cos(bent) + perp * sin(bent));
            ring = ring + exp(-pow((theta - einstein) / max(einstein * 0.12, 1e-4), 2.0)) * 0.55;
        }
    }
    return vec4<f32>(dir, ring);
}

fn sky_color(dir_in: vec3<f32>) -> vec3<f32> {
    let bent = bend(dir_in);
    var dir = bent.xyz;
    let seed = world.sky_b.w;
    let warp = world.time.y;
    let fwd = world.cam_fwd.xyz;

    // Stars. Folding stretches them into streaks that pour past.
    var stars = vec3<f32>(0.0);
    if (warp > 0.001) {
        let radial = normalize(dir - fwd * dot(dir, fwd) + vec3<f32>(1e-5));
        for (var k = 0; k < 6; k = k + 1) {
            let d2 = normalize(dir + radial * (f32(k) * 0.035 * warp) + fwd * (world.time.x * 0.9 * warp));
            stars = stars + (star_layer(d2, 70.0, 0.22) + star_layer(d2, 150.0, 0.16)) * (1.0 - f32(k) / 6.0);
        }
        stars = stars * 0.5;
    } else {
        stars = star_layer(dir, 70.0, 0.1) + star_layer(dir, 150.0, 0.12) + star_layer(dir, 310.0, 0.14) * 0.7;
    }
    stars = stars * world.sky_a.w;

    // The galaxy you are in: a band of light across the sky, and its gas.
    let axis = normalize(vec3<f32>(sin(seed * 3.1), 0.55 + 0.4 * cos(seed * 1.7), cos(seed * 2.3)));
    let lat = dot(dir, axis);
    let band = exp(-lat * lat * 9.0);
    let q = dir * 2.2 + vec3<f32>(seed * 7.0);
    let warped = q + vec3<f32>(fbm(q * 1.3 + vec3<f32>(3.1), 3), fbm(q * 1.3 + vec3<f32>(7.9), 3), fbm(q * 1.3, 3)) * 1.4;
    let gas = fbm(warped, 5);
    let lanes = fbm(warped * 2.6 + vec3<f32>(19.0), 4);
    let amount = world.sky_deep.w;
    var cloud = smoothstep(0.42 - amount * 0.2, 0.9, gas + band * 0.35) * (0.35 + band * 0.9);
    cloud = cloud * (1.0 - 0.75 * smoothstep(0.5, 0.75, lanes) * band);
    let hue = fbm(q * 0.8 + vec3<f32>(31.0), 3);
    let cloud_col = mix(world.sky_a.rgb, world.sky_b.rgb, smoothstep(0.35, 0.65, hue));
    var col = world.sky_deep.rgb * (0.6 + 0.8 * band) + cloud_col * cloud * (0.55 + amount * 0.5);
    // Unresolved stars thicken the band.
    col = col + vec3<f32>(0.9, 0.9, 1.0) * band * band * 0.07 * world.sky_a.w * (0.5 + fbm(dir * 40.0, 2));
    // Bright knots where the gas is thickest.
    col = col + cloud_col * pow(max(cloud, 0.0), 3.0) * 0.5;

    // Other galaxies, far off: a handful of tilted smudges.
    for (var g = 0; g < 7; g = g + 1) {
        let hg = hash33(vec3<f32>(f32(g) * 13.7 + seed * 5.0, 2.0, 9.0));
        let c = normalize(hg * 2.0 - vec3<f32>(1.0));
        let dd = dir - c * dot(dir, c);
        let t1 = normalize(cross(c, vec3<f32>(0.3, 1.0, 0.2)));
        let t2 = cross(c, t1);
        let ang = hg.x * 6.283;
        let u = dot(dd, t1) * cos(ang) + dot(dd, t2) * sin(ang);
        let v = -dot(dd, t1) * sin(ang) + dot(dd, t2) * cos(ang);
        let size = 0.02 + hg.y * 0.035;
        let r2 = (u * u + v * v * (6.0 + hg.z * 10.0)) / (size * size);
        let facing = step(0.0, dot(dir, c));
        let arms = 0.6 + 0.4 * sin(atan2(v * 3.0, u) * 2.0 + sqrt(r2) * 3.0);
        col = col + facing * mix(vec3<f32>(0.75, 0.82, 1.0), vec3<f32>(1.0, 0.85, 0.7), hg.z) * (exp(-r2) * 0.5 * arms + exp(-r2 * 9.0) * 0.6);
    }

    col = col + stars * (1.0 - 0.6 * clamp(cloud, 0.0, 1.0));
    col = col + vec3<f32>(1.0, 0.86, 0.7) * bent.w;

    // The fold itself: a tunnel of light ahead.
    if (warp > 0.001) {
        let ahead = max(dot(dir_in, fwd), 0.0);
        let rings = 0.5 + 0.5 * sin(acos(clamp(ahead, -1.0, 1.0)) * 46.0 - world.time.x * 26.0);
        col = col + mix(world.sky_a.rgb, vec3<f32>(1.0), 0.6) * warp * (pow(ahead, 22.0) * 1.6 + rings * pow(ahead, 3.0) * 0.22);
    }
    return col;
}

// --- Surfaces ----------------------------------------------------------------------------------------

struct Lit { diffuse: vec3<f32>, day: f32 };

fn light_at(p: vec3<f32>, n: vec3<f32>, wrap: f32) -> Lit {
    var sum = vec3<f32>(0.0);
    var day = 0.0;
    let count = i32(world.screen.z + 0.5);
    for (var i = 0; i < count; i = i + 1) {
        let l = world.lights[i];
        let to = l.pos.xyz - p;
        let d = length(to);
        var atten = 1.0;
        if (l.pos.w > 0.0) { atten = pow(clamp(1.0 - d / l.pos.w, 0.0, 1.0), 2.0); }
        let ndl = clamp((dot(n, to / max(d, 1e-6)) + wrap) / (1.0 + wrap), 0.0, 1.0);
        sum = sum + l.color.rgb * l.color.w * ndl * atten;
        day = max(day, ndl * atten * min(l.color.w, 1.0));
    }
    return Lit(sum, day);
}

fn planet_albedo(p: vec3<f32>, look: i32, seed: f32, tint: vec3<f32>) -> vec4<f32> {
    // rgb albedo, a = glow (lava) or ocean (specular) depending on look
    let s = vec3<f32>(seed * 91.0, seed * 37.0, seed * 53.0);
    if (look == 1) {
        let h = fbm(p * 3.0 + s, 5);
        let crack = smoothstep(0.035, 0.0, abs(fbm(p * 5.0 + s * 1.7, 4) - 0.5));
        return vec4<f32>(mix(mix(vec3<f32>(0.5, 0.66, 0.86), vec3<f32>(0.95, 0.98, 1.0), smoothstep(0.3, 0.7, h)), vec3<f32>(0.25, 0.42, 0.62), crack * 0.8), 0.25);
    }
    if (look == 2) {
        let h = fbm(p * 2.3 + s, 6);
        let land = smoothstep(0.5, 0.54, h);
        let sea = mix(vec3<f32>(0.02, 0.09, 0.3), vec3<f32>(0.06, 0.32, 0.52), smoothstep(0.38, 0.5, h));
        let ground = mix(mix(vec3<f32>(0.16, 0.36, 0.12), vec3<f32>(0.5, 0.42, 0.26), smoothstep(0.56, 0.7, h)), vec3<f32>(0.9, 0.92, 0.95), smoothstep(0.72, 0.8, h));
        var col = mix(sea, ground, land);
        col = mix(col, vec3<f32>(0.95, 0.97, 1.0), smoothstep(0.78, 0.9, abs(p.y) + (h - 0.5) * 0.3));
        let clouds = smoothstep(0.52, 0.72, fbm(p * 4.0 + s * 2.0 + vec3<f32>(world.time.x * 0.012, 0.0, 0.0), 5));
        col = mix(col, vec3<f32>(1.0), clouds * 0.85);
        return vec4<f32>(col, (1.0 - land) * (1.0 - clouds));
    }
    if (look == 3) {
        let h = fbm(p * 3.2 + s, 5);
        let vein = pow(1.0 - abs(fbm(p * 4.5 + s * 1.3 + vec3<f32>(0.0, world.time.x * 0.01, 0.0), 5) * 2.0 - 1.0), 7.0);
        return vec4<f32>(mix(vec3<f32>(0.05, 0.04, 0.045), vec3<f32>(0.2, 0.14, 0.12), h), vein * 2.2);
    }
    if (look == 4) {
        let h = fbm(p * 2.6 + s, 5);
        let dunes = 0.5 + 0.5 * sin(p.y * 30.0 + fbm(p * 6.0 + s, 3) * 8.0);
        return vec4<f32>(mix(vec3<f32>(0.45, 0.24, 0.13), vec3<f32>(0.86, 0.66, 0.4), smoothstep(0.3, 0.7, h)) * (0.85 + 0.15 * dunes), 0.0);
    }
    if (look == 5 || look == 6) {
        let turb = fbm(p * vec3<f32>(2.0, 6.0, 2.0) + s, 4);
        let stripe = sin(p.y * (11.0 + seed * 9.0) + turb * select(2.2, 5.0, look == 6));
        let storm = smoothstep(0.62, 0.8, fbm(p * 5.0 + s * 3.0, 4));
        let a = tint;
        let b = mix(tint.zxy, vec3<f32>(0.95, 0.9, 0.82), 0.55);
        var col = mix(a, b, smoothstep(-0.5, 0.5, stripe));
        col = mix(col, vec3<f32>(1.0, 0.96, 0.9), storm * 0.5);
        return vec4<f32>(col, 0.0);
    }
    let h = fbm(p * 3.0 + s, 5);
    // Craters: rings of shadow and rim.
    let c = fbm(p * 9.0 + s * 2.0, 3);
    let crater = smoothstep(0.62, 0.66, c) * (1.0 - smoothstep(0.7, 0.74, c));
    return vec4<f32>(mix(vec3<f32>(0.2, 0.19, 0.19), vec3<f32>(0.62, 0.58, 0.55), smoothstep(0.25, 0.75, h)) * (1.0 - crater * 0.45) * mix(vec3<f32>(1.0), tint, 0.35), 0.0);
}

fn tonemap(c: vec3<f32>) -> vec3<f32> {
    let x = c * world.grade.x;
    return pow(clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let kind = i32(in.params.x + 0.5);
    let seed = in.params.y;
    let t = world.time.x;

    if (kind == 9) {
        let dir = normalize(in.world_pos - camera.view_pos.xyz);
        return vec4<f32>(grade(tonemap(sky_color(dir)), in.clip_position), 1.0);
    }

    let v = normalize(camera.view_pos.xyz - in.world_pos);
    var n = normalize(in.normal);
    var col = vec3<f32>(0.0);

    if (kind == 0) {
        // Rubble is faceted: the normal of the triangle itself.
        var fn_ = normalize(cross(dpdx(in.world_pos), dpdy(in.world_pos)));
        if (dot(fn_, v) < 0.0) { fn_ = -fn_; }
        n = normalize(mix(n, fn_, 0.8));
        let grain = fbm(in.local * 5.0 + vec3<f32>(seed * 23.0), 3);
        let lit = light_at(in.world_pos, n, 0.15);
        col = in.color.rgb * (0.55 + 0.7 * grain) * (lit.diffuse + world.sky_deep.rgb * 0.6 + vec3<f32>(0.015));
    } else if (kind == 1) {
        let look = i32(in.params.z + 0.5);
        let integrity = in.params.w;
        let p = rot_y(normalize(in.local), t * 0.02 + seed * 6.0);
        let surf = planet_albedo(p, look, seed, in.color.rgb);
        let lit = light_at(in.world_pos, n, 0.08);
        let nv = max(dot(n, v), 0.0);
        col = surf.rgb * (lit.diffuse + world.sky_deep.rgb * 0.5 + vec3<f32>(0.012));
        if (look == 3) { col = col + vec3<f32>(1.0, 0.35, 0.05) * surf.a; }
        if (look == 2 || look == 1) {
            // The sun glints off water and ice.
            let count = i32(world.screen.z + 0.5);
            for (var i = 0; i < count; i = i + 1) {
                let l = world.lights[i];
                let h = normalize(normalize(l.pos.xyz - in.world_pos) + v);
                col = col + l.color.rgb * pow(max(dot(n, h), 0.0), 90.0) * surf.a * min(l.color.w, 1.5) * 0.7;
            }
        }
        // Cities shine on the night side of a living world.
        if (in.extra.x > 0.5) {
            let cell = floor(p * 46.0);
            let lights = step(0.86, hash3(cell)) * smoothstep(0.5, 0.56, fbm(p * 2.3 + vec3<f32>(seed * 91.0, seed * 37.0, seed * 53.0), 6));
            col = col + vec3<f32>(1.0, 0.78, 0.4) * lights * (1.0 - smoothstep(0.02, 0.25, lit.day)) * 0.9;
        }
        // Air: a bright rim on the lit side.
        col = col + in.extra.yzw * pow(1.0 - nv, 2.5) * (0.25 + lit.day) * 0.9;
        // Being drunk dry: fissures of your own light open across it.
        if (integrity < 0.999) {
            let fissure = 1.0 - abs(fbm(p * 4.0 + vec3<f32>(seed * 11.0), 5) * 2.0 - 1.0);
            let open = smoothstep(integrity * 0.9 + 0.08, integrity * 0.9 + 0.2, fissure);
            col = mix(col, vec3<f32>(0.0), open * 0.6) + vec3<f32>(0.5, 0.9, 1.0) * open * (1.4 + 0.6 * sin(t * 9.0 + fissure * 30.0));
        }
    } else if (kind == 2) {
        let p = rot_y(normalize(in.local), t * 0.015 + seed * 6.0);
        let flow = vec3<f32>(0.0, t * 0.04, 0.0);
        let cells = fbm(p * 7.0 + flow + vec3<f32>(seed * 40.0), 5);
        let fine = fbm(p * 22.0 - flow * 2.0, 3);
        let spots = smoothstep(0.34, 0.26, fbm(p * 2.6 + vec3<f32>(seed * 13.0), 4));
        let mu = max(dot(n, v), 0.0);
        var heat = 0.62 + 0.55 * cells + 0.22 * fine - spots * 0.5;
        heat = heat * (0.42 + 0.58 * pow(mu, 0.45));
        // Flares brighten the whole face.
        heat = heat * (1.0 + in.extra.x * 0.9);
        let base = in.color.rgb;
        col = base * heat * 1.25 + vec3<f32>(1.0) * pow(max(heat - 0.7, 0.0), 2.0) * 1.2;
        col = col + base * pow(1.0 - mu, 3.0) * 0.6;
        // Being consumed: dark cracks crawl across the photosphere.
        let integrity = in.params.w;
        if (integrity < 0.999) {
            let fissure = 1.0 - abs(fbm(p * 3.0 + vec3<f32>(seed * 11.0), 5) * 2.0 - 1.0);
            let open = smoothstep(integrity * 0.9 + 0.1, integrity * 0.9 + 0.22, fissure);
            col = mix(col, vec3<f32>(0.02, 0.0, 0.04), open * 0.85);
        }
        return vec4<f32>(grade(pow(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(0.8)), in.clip_position), 1.0);
    } else if (kind == 3) {
        return vec4<f32>(grade(vec3<f32>(0.0), in.clip_position), 1.0);
    } else if (kind == 4) {
        let look = i32(in.params.z + 0.5);
        let lit = light_at(in.world_pos, n, 0.35);
        let nv = max(dot(n, v), 0.0);
        let q = in.local * 3.0 + vec3<f32>(seed * 19.0);
        var mark = 0.0;
        if (look == 1) { mark = smoothstep(0.58, 0.66, fbm(q * 1.6, 3)); }
        else if (look == 2) { mark = smoothstep(0.55, 0.9, 0.5 + 0.5 * sin(in.local.z * 9.0 + fbm(q, 2) * 3.0)); }
        else if (look == 3) { mark = pow(1.0 - abs(fbm(q * 1.4, 4) * 2.0 - 1.0), 6.0); }
        let pulse = 0.7 + 0.3 * sin(t * 2.4 + seed * 40.0 + in.local.z * 2.0);
        col = in.color.rgb * (lit.diffuse + world.sky_deep.rgb + vec3<f32>(0.03)) * (0.6 + 0.4 * fbm(q * 2.0, 2));
        col = col + in.extra.rgb * (mark * 1.5 * pulse + pow(1.0 - nv, 2.2) * 0.9);
        col = mix(col, vec3<f32>(1.6), clamp(in.extra.w, 0.0, 1.0));
    } else {
        // Crystal: an envoy's body, all facets and inner light.
        var fn_ = normalize(cross(dpdx(in.world_pos), dpdy(in.world_pos)));
        if (dot(fn_, v) < 0.0) { fn_ = -fn_; }
        let nv = max(dot(fn_, v), 0.0);
        let lit = light_at(in.world_pos, fn_, 0.2);
        let shimmer = 0.6 + 0.4 * sin(t * 1.7 + dot(fn_, vec3<f32>(7.0, 13.0, 5.0)) * 4.0);
        col = in.color.rgb * (0.25 + lit.diffuse * 0.6) + in.extra.rgb * (pow(1.0 - nv, 1.6) * 1.6 + 0.35 * shimmer);
    }
    return vec4<f32>(grade(tonemap(col), in.clip_position), 1.0);
}
`;

const GLOW = /* wgsl */ `
@vertex
fn vs_main(in: VertexInput, @builtin(instance_index) ii: u32) -> VertexOutput {
    let it = items[ii];
    var out: VertexOutput;
    let place = i32(it.params.w + 0.5);
    let center = it.model[3].xyz;
    let q = in.position.xy;
    var world_pos = center;
    if (place == 0) {
        let sx = length(it.model[0].xyz);
        let sy = length(it.model[1].xyz);
        let roll = it.extra.w;
        let c = cos(roll);
        let s = sin(roll);
        let x = q.x * sx;
        let y = q.y * sy;
        world_pos = center + world.cam_right.xyz * (x * c - y * s) + world.cam_up.xyz * (x * s + y * c);
    } else if (place == 1) {
        let axis = it.model[2].xyz;
        let width = length(it.model[0].xyz);
        let side = normalize(cross(axis, camera.view_pos.xyz - center) + vec3<f32>(1e-6));
        world_pos = center + axis * (q.y * 0.5) + side * (q.x * width);
    } else {
        world_pos = (it.model * vec4<f32>(q.x, 0.0, q.y, 1.0)).xyz;
    }
    out.clip_position = far_depth(camera.view_proj * vec4<f32>(world_pos, 1.0));
    out.world_pos = world_pos;
    out.normal = vec3<f32>(0.0, 1.0, 0.0);
    out.uv = q;
    out.local = in.position;
    out.color = it.color;
    out.params = it.params;
    out.extra = it.extra;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let kind = i32(in.params.x + 0.5);
    let seed = in.params.y;
    let t = world.time.x;
    let q = in.uv;
    let r = length(q);
    var col = in.color.rgb;
    var a = 0.0;

    if (kind == 0) {
        // Gas: a soft knot of cloud, its edges torn by turbulence that drifts.
        let w = vec3<f32>(q * 1.5, seed * 31.0 + t * 0.045);
        let warp = vec2<f32>(fbm(w + vec3<f32>(3.7, 1.1, 0.0), 3), fbm(w + vec3<f32>(8.3, 5.9, 0.0), 3)) - vec2<f32>(0.5);
        let d = fbm(vec3<f32>((q + warp * 0.9) * 2.1, seed * 17.0 + t * 0.03), 4);
        let fall = pow(clamp(1.0 - r, 0.0, 1.0), 1.6);
        a = fall * smoothstep(0.18, 0.75, d + fall * 0.35) * 1.5;
        // Filaments brighter and whiter than the body of the cloud.
        let fil = pow(clamp(1.0 - abs(d * 2.0 - 1.0), 0.0, 1.0), 5.0) * fall;
        col = col * (0.8 + 0.5 * d) + vec3<f32>(1.0) * fil * 0.35 * in.extra.x;
    } else if (kind == 1) {
        a = exp(-r * r * 5.0) * 0.7 + pow(clamp(1.0 - r, 0.0, 1.0), 6.0) * 0.9;
        a = a * smoothstep(1.0, 0.7, r);
    } else if (kind == 2) {
        // A star's corona: a halo, and streamers that crawl outward.
        let ang = atan2(q.y, q.x);
        let rays = fbm(vec3<f32>(cos(ang) * 2.5, sin(ang) * 2.5, r * 2.2 - t * 0.12 + seed * 9.0), 4);
        let inner = in.extra.x;
        a = exp(-max(r - inner, 0.0) * 5.5) * (0.35 + 1.1 * rays * rays) * smoothstep(1.0, 0.55, r);
        a = a + exp(-max(r - inner, 0.0) * 22.0) * 0.6;
        col = mix(col, vec3<f32>(1.0), exp(-max(r - inner, 0.0) * 14.0) * 0.6);
    } else if (kind == 3) {
        // A lightwave: the shell of a sphere seen edge-on, with fainter crests behind the front.
        let front = exp(-pow((r - 0.93) / 0.022, 2.0));
        let crests = (0.5 + 0.5 * sin((0.93 - r) * 120.0)) * smoothstep(0.55, 0.93, r) * step(r, 0.93) * 0.22;
        let ang = atan2(q.y, q.x);
        let grain = 0.6 + 0.4 * sin(ang * 36.0 + seed * 20.0 + t * 2.0);
        a = (front + crests) * grain;
    } else if (kind == 4) {
        let spike = exp(-abs(q.x) * 34.0) * exp(-abs(q.y) * 3.2) + exp(-abs(q.y) * 34.0) * exp(-abs(q.x) * 3.2);
        a = exp(-r * r * 26.0) * 1.3 + spike * 0.6 * in.extra.x + exp(-r * 4.0) * 0.12;
        a = a * smoothstep(1.0, 0.6, r);
        col = mix(col, vec3<f32>(1.0), exp(-r * r * 60.0));
    } else if (kind == 5) {
        // A bolt: a hot core along the axis, brightest at its head.
        let across = exp(-q.x * q.x * 9.0) * 0.55 + exp(-q.x * q.x * 90.0);
        let along = smoothstep(-1.0, 0.7, q.y) * smoothstep(1.0, 0.82, q.y);
        a = across * along * (0.8 + 0.2 * sin(q.y * 40.0 - t * 50.0));
        col = mix(col, vec3<f32>(1.0), exp(-q.x * q.x * 70.0) * along);
    } else if (kind == 6) {
        // An accretion disc: hot and blue-white inside, red at the rim, one side rushing toward you.
        let inner = in.extra.x;
        let ang = atan2(q.y, q.x);
        let swirl = ang + log(max(r, 0.05)) * 3.2 - t * (0.5 / max(r, 0.2));
        let streak = fbm(vec3<f32>(cos(swirl) * 3.0, sin(swirl) * 3.0, r * 9.0 + seed * 5.0), 4);
        let body = smoothstep(inner, inner + 0.06, r) * pow(smoothstep(1.0, inner, r), 1.4);
        let hot = smoothstep(1.0, inner, r);
        col = mix(in.color.rgb, vec3<f32>(1.0, 0.97, 0.92), pow(hot, 2.5));
        a = body * (0.25 + 1.5 * streak * streak) * (1.0 + 0.55 * sin(ang + in.extra.y));
    } else if (kind == 7) {
        // A world's rings.
        let inner = in.extra.x;
        let bands = fbm(vec3<f32>(r * 46.0, seed * 9.0, 0.0), 3);
        let gap = smoothstep(0.03, 0.0, abs(r - mix(inner, 1.0, 0.62)));
        a = smoothstep(inner, inner + 0.02, r) * smoothstep(1.0, 0.97, r) * (0.25 + 0.9 * bands) * (1.0 - gap * 0.9);
    } else if (kind == 8) {
        // The rift: a wound in space, pale arms turning into a bright heart.
        let ang = atan2(q.y, q.x);
        let arms = 0.5 + 0.5 * sin(ang * 3.0 + log(max(r, 0.02)) * 6.0 - t * 1.6);
        let froth = fbm(vec3<f32>(q * 4.0, t * 0.3 + seed), 4);
        a = pow(clamp(1.0 - r, 0.0, 1.0), 1.4) * (0.25 + arms * 0.9 + froth * 0.5) + exp(-r * r * 30.0) * 1.5;
        a = a * in.extra.x;
        col = mix(col, vec3<f32>(1.0), exp(-r * 4.0));
    } else if (kind == 9) {
        // The photon ring, and the far side of the disc lifted over the shadow.
        let ring = exp(-pow((r - 0.5) / 0.02, 2.0)) * 1.2;
        let arc = exp(-pow((r - 0.62) / 0.07, 2.0)) * (0.35 + 0.65 * smoothstep(-0.2, 0.9, q.y * in.extra.x)) * 0.8;
        a = ring + arc * (0.5 + 0.8 * fbm(vec3<f32>(atan2(q.y, q.x) * 3.0 + t * 0.4, r * 9.0, seed), 3));
        col = mix(col, vec3<f32>(1.0, 0.95, 0.88), ring);
    } else if (kind == 11) {
        // Starfire: a river of light, wider as it goes.
        let width = mix(0.18, 1.0, clamp(q.y * 0.5 + 0.5, 0.0, 1.0));
        let x = q.x / width;
        let flow = fbm(vec3<f32>(x * 2.5, q.y * 5.0 - t * 9.0, seed), 4);
        a = exp(-x * x * 4.5) * (0.35 + 1.3 * flow) * smoothstep(-1.0, -0.85, q.y) * smoothstep(1.0, 0.2, q.y) * step(abs(x), 1.6);
        col = mix(col, vec3<f32>(1.0), exp(-x * x * 30.0) * 0.8);
    } else if (kind == 12) {
        // A Pulse: the shell, thick and bright.
        a = exp(-pow((r - 0.9) / 0.06, 2.0)) * 1.2 + smoothstep(0.9, 0.0, r) * 0.08;
        a = a * step(r, 1.0);
    } else if (kind == 13) {
        // What Attune shows around a creature: a thin ring with four ticks.
        let ring = exp(-pow((r - 0.9) / 0.012, 2.0));
        let ang = atan2(q.y, q.x);
        let ticks = step(0.92, abs(cos(ang * 2.0))) * smoothstep(0.78, 0.84, r) * step(r, 0.98);
        a = ring * (0.55 + 0.45 * sin(ang * 40.0 + t * 3.0)) + ticks * 0.9;
    } else if (kind == 14) {
        let tw = 0.7 + 0.3 * sin(t * 3.0 + seed * 50.0);
        a = (exp(-r * r * 18.0) * 1.2 + exp(-r * 3.5) * 0.3) * tw * smoothstep(1.0, 0.6, r);
        col = mix(col, vec3<f32>(1.0), exp(-r * r * 50.0));
    } else {
        // A siphon stream: matter pulled off a world in a braided rope.
        let braid = sin(q.y * 9.0 - t * 14.0 + seed * 6.0) * 0.35;
        let x = q.x - braid;
        let flow = fbm(vec3<f32>(x * 3.0, q.y * 7.0 - t * 11.0, seed), 3);
        a = (exp(-x * x * 12.0) * (0.4 + 1.2 * flow) + exp(-x * x * 120.0)) * smoothstep(-1.0, -0.8, q.y) * smoothstep(1.0, 0.8, q.y);
    }

    a = clamp(a * in.color.a, 0.0, 4.0);
    col = grade(col, in.clip_position);
    return vec4<f32>(col, a);
}
`;

export const NEBULA_SOLID_SHADER = COMMON + SOLID;
export const NEBULA_GLOW_SHADER = COMMON + GLOW;
