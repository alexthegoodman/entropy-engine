// Armageddon 2070's look: decent, readable, cheap. Four instanced pipelines and a screen pass.
//
//   LIT      every opaque thing: a sun with soft wrap, a sky/ground ambient, contact darkening at
//            the foot of walls, procedural materials (concrete, brick, adobe, metal, corrugated
//            containers, sandbags, rock, wood, fused glass, hesco, rust), the terrain's blended ground
//            types, soldiers' and vehicles' team camouflage, the sky with the orange glow of the
//            burning subcontinent on one horizon, the sea, and foliage as billboard cards (grass,
//            bushes, broadleaf, pines, palms, dead trees, reeds) cut out in the shader.
//   GLOW     additive light: tracers, muzzle flashes, explosions, sparks, territory rings, markers.
//   SMOKE    alpha-blended soft puffs: smoke grenades, burning wrecks, dust.
//   SCREEN   distance fog from depth, filmic tone curve, vignette, hurt and flash, EMP static.
//
// Depth is written as w / (w + DEPTH_K) so the screen pass recovers distance (w = K d / (1 - d)). It
// is written per fragment from the interpolated view depth: written per vertex, the rasterizer would
// interpolate the curve linearly across a triangle, and a big face close to the camera (a wall you
// stand beside) came out metres deeper than it is, so whatever stood behind it showed through. The
// clip z stays an ordinary 1 - NEAR / w so near-plane clipping is right.

export const DEPTH_K = 200;
export const WORLD_FLOATS = 8 * 4;
export const ITEM_FLOATS = 28;
export const POST_FLOATS = 4 * 4;

/** Item.params.x in LIT. */
export const LIT = { prop: 0, terrain: 1, water: 2, sky: 3, body: 4, card: 5, emissive: 6 } as const;
/** Prop materials (Item.extra.y with LIT.prop). */
export const MAT: Record<string, number> = { concrete: 0, brick: 1, adobe: 2, metal: 3, container: 4, sandbag: 5, rock: 6, wood: 7, glass: 8, barrier: 9, rubble: 10, hesco: 11, pipe: 12, wreck: 13, dome: 14, plaster: 15, asphalt: 16 };
/** Body parts (Item.extra.y with LIT.body): cloth camo, armor plate, skin, gun metal, visor, vehicle hull. */
export const BODY = { cloth: 0, plate: 1, skin: 2, gun: 3, visor: 4, hull: 5, rubber: 6, glass: 7 } as const;
/** Card silhouettes (Item.extra.y with LIT.card). */
export const CARD = { grass: 0, bush: 1, broadleaf: 2, pine: 3, palm: 4, dead: 5, reed: 6 } as const;
/** Item.params.x in GLOW. */
export const GLOW = { dot: 0, ring: 1, beam: 2, fire: 3, flatRing: 4, marker: 5 } as const;

const COMMON = /* wgsl */ `
struct Camera { view_proj: mat4x4<f32>, view_pos: vec4<f32> };
@group(0) @binding(0) var<uniform> camera: Camera;

struct World {
    time: vec4<f32>,    // seconds, aspect, fog density, exposure
    sun: vec4<f32>,     // direction to the sun, intensity
    cam: vec4<f32>,     // camera position, biome (0 coast, 1 mountain, 2 industrial, 3 city)
    fog: vec4<f32>,     // fog color, snow line
    sky: vec4<f32>,     // zenith color, azimuth of the fusion glow
    suncol: vec4<f32>,  // sun color, ambient
    misc: vec4<f32>,    // hurt, flash, emp, sea level
    spare: vec4<f32>,
};
@group(2) @binding(0) var<uniform> world: World;

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
    @location(8) scale: vec3<f32>,
    @location(9) view_w: f32,
};
struct FOut { @location(0) color: vec4<f32>, @builtin(frag_depth) depth: f32 };

fn far_depth(c: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(c.xy, c.w - 0.05, c.w);
}
fn depth_of(w: f32) -> f32 { let v = max(w, 0.0); return v / (v + ${DEPTH_K.toFixed(1)}); }
fn hash2(p: vec2<f32>) -> f32 { var q = fract(p * vec2<f32>(123.34, 456.21)); q = q + dot(q, q + 45.32); return fract(q.x * q.y); }
fn vnoise(p: vec2<f32>) -> f32 {
    let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2<f32>(1.0, 0.0)), u.x), mix(hash2(i + vec2<f32>(0.0, 1.0)), hash2(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}
fn fbm2(p: vec2<f32>) -> f32 { return vnoise(p) * 0.5 + vnoise(p * 2.03 + vec2<f32>(5.1, 1.7)) * 0.3 + vnoise(p * 4.1 + vec2<f32>(2.3, 9.4)) * 0.2; }
`;

const LIT_SRC = /* wgsl */ `
${COMMON}

@vertex
fn vs_main(in: VertexInput, @builtin(instance_index) ii: u32) -> VOut {
    let it = items[ii];
    var out: VOut;
    let kind = i32(it.params.x + 0.5);
    let sx = length(it.model[0].xyz);
    let sy = length(it.model[1].xyz);
    let sz = length(it.model[2].xyz);
    out.scale = vec3<f32>(sx, sy, sz);
    if (kind == 5) {
        // A billboard card turned about +y toward the camera, standing on its base, swaying in the wind.
        let c = it.model[3].xyz;
        var tc = camera.view_pos.xyz - c;
        tc.y = 0.0;
        let f = normalize(tc + vec3<f32>(0.0001, 0.0, 0.0));
        let r = vec3<f32>(f.z, 0.0, -f.x);
        let t = in.position.y * 0.5 + 0.5;
        let sway = sin(world.time.x * 1.4 + it.params.y * 13.0 + c.x * 0.21 + c.z * 0.17) * 0.06 * t * t * sx;
        let wp = c + r * (in.position.x * sx + sway) + vec3<f32>(0.0, t * sy, 0.0);
        out.clip = far_depth(camera.view_proj * vec4<f32>(wp, 1.0));
        out.view_w = out.clip.w;
        out.world_pos = wp;
        out.normal = normalize(f * 0.5 + vec3<f32>(0.0, 1.0, 0.0));
        out.uv = in.tex_coords;
        out.vcolor = in.color;
        out.local = in.position;
        out.color = it.color;
        out.params = it.params;
        out.extra = it.extra;
        return out;
    }
    let nl = in.normal / max(vec3<f32>(sx * sx, sy * sy, sz * sz), vec3<f32>(1e-12));
    let n = normalize(it.model[0].xyz * nl.x + it.model[1].xyz * nl.y + it.model[2].xyz * nl.z);
    var wp = (it.model * vec4<f32>(in.position, 1.0)).xyz;
    if (kind == 3) { wp = camera.view_pos.xyz + in.position * 1800.0; }
    if (kind == 2) { wp.y = wp.y + sin(wp.x * 0.11 + world.time.x * 0.9) * 0.15 + cos(wp.z * 0.09 + world.time.x * 0.7) * 0.15; }
    let clip = camera.view_proj * vec4<f32>(wp, 1.0);
    out.clip = far_depth(clip);
    out.view_w = clip.w;
    if (kind == 3) { out.clip = vec4<f32>(clip.xy, clip.w * 0.99999, clip.w); out.view_w = 1e9; }
    out.world_pos = wp;
    out.normal = n;
    out.uv = in.tex_coords;
    out.vcolor = in.color;
    out.local = in.position;
    out.color = it.color;
    out.params = it.params;
    out.extra = it.extra;
    return out;
}

fn sky(dir: vec3<f32>) -> vec3<f32> {
    let up = clamp(dir.y, -1.0, 1.0);
    let horizon = world.fog.rgb;
    var col = mix(horizon, world.sky.rgb, smoothstep(0.0, 0.55, up));
    col = mix(col, horizon * 0.8, smoothstep(0.02, -0.25, up));
    let L = normalize(world.sun.xyz);
    let s = max(dot(dir, L), 0.0);
    col = col + world.suncol.rgb * (pow(s, 600.0) * 4.0 + pow(s, 12.0) * 0.25);
    // The fusion glow: a low orange band on one horizon, where the subcontinent still burns.
    let az = atan2(dir.x, dir.z);
    let da = abs(atan2(sin(az - world.sky.w), cos(az - world.sky.w)));
    let glow = exp(-da * da * 2.2) * exp(-max(up, 0.0) * 9.0) * smoothstep(-0.1, 0.02, up);
    col = mix(col, vec3<f32>(1.0, 0.42, 0.14), glow * 0.55);
    // Clouds and ash.
    let p = dir.xz / max(0.08, dir.y + 0.2) * 1.6 + vec2<f32>(world.time.x * 0.004, 0.0);
    let cl = fbm2(p * 0.7);
    let cloud = smoothstep(0.5, 0.75, cl) * smoothstep(-0.02, 0.2, up);
    col = mix(col, mix(vec3<f32>(0.92), horizon * 0.85, 0.4) * (0.75 + 0.35 * s), cloud * 0.7);
    return col;
}

fn ambient(n: vec3<f32>) -> vec3<f32> {
    let skyA = mix(world.fog.rgb, world.sky.rgb, 0.5);
    let groundA = vec3<f32>(0.32, 0.28, 0.24);
    return mix(groundA, skyA, n.y * 0.5 + 0.5) * world.suncol.w;
}

fn bricks(p: vec2<f32>) -> vec2<f32> {
    let row = floor(p.y / 0.075);
    let q = vec2<f32>(p.x / 0.22 + row * 0.5, p.y / 0.075);
    let f = fract(q);
    let mortar = 1.0 - smoothstep(0.0, 0.06, min(min(f.x, 1.0 - f.x) * 2.9, min(f.y, 1.0 - f.y)));
    return vec2<f32>(mortar, hash2(floor(q)));
}

// The card silhouettes: x = signed distance (inside < 0), y = tone.
fn blade(q: vec2<f32>, bx: f32, tx: f32, ty: f32, w: f32) -> f32 {
    let a = vec2<f32>(bx, -1.0);
    let b = vec2<f32>(tx, ty);
    let ab = b - a;
    let t = clamp(dot(q - a, ab) / dot(ab, ab), 0.0, 1.0);
    return length(q - (a + ab * t)) - w * (1.0 - t * 0.9);
}
fn card(q: vec2<f32>, shape: i32, seed: f32) -> vec2<f32> {
    var d = 9.0;
    var tone = 1.0;
    if (shape == 0 || shape == 6) {
        let n = select(9, 6, shape == 6);
        for (var i = 0; i < 9; i = i + 1) {
            if (i >= n) { break; }
            let fi = f32(i);
            let h = hash2(vec2<f32>(seed * 31.0 + fi, fi * 1.7));
            let bx = (fi / f32(n - 1) - 0.5) * 0.6;
            let tx = (fi / f32(n - 1) - 0.5) * 1.6 + (h - 0.5) * 0.4;
            let ty = select(-0.1 + h * 1.0, 0.6 + h * 0.4, shape == 6);
            d = min(d, blade(q, bx, tx, ty, select(0.07, 0.05, shape == 6)));
        }
        tone = 0.75 + 0.35 * (q.y * 0.5 + 0.5);
    } else if (shape == 1 || shape == 2) {
        // Bush (low) and broadleaf canopy (a trunk below a lumpy crown).
        let j = vec2<f32>(hash2(vec2<f32>(seed, 1.0)), hash2(vec2<f32>(seed, 2.0))) - vec2<f32>(0.5);
        if (shape == 2) {
            d = min(d, max(abs(q.x) - 0.06 + (q.y + 1.0) * 0.02, q.y + 0.2));
            let cq = (q - vec2<f32>(0.0, 0.25)) * vec2<f32>(1.0, 1.2);
            d = min(d, length(cq - vec2<f32>(-0.38, -0.05) - j * 0.2) - 0.45);
            d = min(d, length(cq - vec2<f32>(0.36, 0.0) + j * 0.2) - 0.45);
            d = min(d, length(cq - vec2<f32>(0.0, 0.32)) - 0.5);
            d = min(d, length(cq - vec2<f32>(0.05, -0.15)) - 0.42);
        } else {
            d = min(d, length(q - vec2<f32>(-0.45, -0.5) - j * 0.2) - 0.5);
            d = min(d, length(q - vec2<f32>(0.45, -0.45) + j * 0.2) - 0.52);
            d = min(d, length(q - vec2<f32>(0.0, -0.05) - j * 0.15) - 0.6);
            d = min(d, length(q - vec2<f32>(-0.25, 0.35) + j * 0.1) - 0.38);
        }
        d = d + (vnoise(q * 11.0 + vec2<f32>(seed * 7.0)) - 0.5) * 0.12;
        tone = 0.72 + 0.4 * (q.y * 0.5 + 0.5) + step(0.7, vnoise(q * 8.0 + vec2<f32>(seed))) * 0.1;
        if (shape == 2 && q.y < -0.2) { tone = 0.55; }
    } else if (shape == 3) {
        // Pine: stacked triangles over a thin trunk.
        d = max(abs(q.x) - 0.05, q.y + 0.75);
        for (var k = 0; k < 4; k = k + 1) {
            let fk = f32(k);
            let base = -0.75 + fk * 0.42;
            let w = 0.72 - fk * 0.15;
            let tri = max(abs(q.x) * 1.6 - (base + 0.65 - q.y) * w * 1.6, base - q.y);
            d = min(d, max(tri, q.y - (base + 0.65)));
        }
        d = d + (vnoise(q * 14.0 + vec2<f32>(seed * 5.0)) - 0.5) * 0.05;
        tone = 0.7 + 0.4 * (q.y * 0.5 + 0.5);
    } else if (shape == 4) {
        // Palm: a leaning trunk and drooping fronds.
        let lean = (q.y + 1.0) * 0.12;
        d = abs(q.x - lean) - 0.045;
        d = max(d, q.y - 0.55);
        for (var k = 0; k < 6; k = k + 1) {
            let a = f32(k) / 6.0 * 6.283 + seed * 3.0;
            let dir = vec2<f32>(cos(a), -abs(sin(a)) * 0.5 + 0.3);
            let c = vec2<f32>(0.24, 0.6);
            let rel = q - c;
            let t = clamp(dot(rel, dir) / dot(dir, dir), 0.0, 1.0);
            let pt = c + dir * t + vec2<f32>(0.0, -t * t * 0.35);
            d = min(d, length(q - pt) - 0.07 * (1.0 - t));
        }
        tone = select(0.8, 0.55, q.y < 0.5 && abs(q.x - lean) < 0.06);
    } else {
        // Dead tree: bare branches.
        d = abs(q.x) - 0.05 + (q.y + 1.0) * 0.015;
        for (var k = 0; k < 5; k = k + 1) {
            let fk = f32(k);
            let h = hash2(vec2<f32>(seed, fk));
            let y0 = -0.3 + fk * 0.25;
            let side = select(-1.0, 1.0, h > 0.5);
            d = min(d, blade(q + vec2<f32>(0.0, -y0 - 1.0), 0.0, side * (0.3 + h * 0.4), 0.0 - h * 0.3 + 0.2, 0.035));
        }
        d = max(d, q.y - 0.95);
        tone = 0.5;
    }
    return vec2<f32>(d, tone);
}

fn shade(albedo: vec3<f32>, n: vec3<f32>, wp: vec3<f32>, spec: f32, rough: f32) -> vec3<f32> {
    let L = normalize(world.sun.xyz);
    let V = normalize(camera.view_pos.xyz - wp);
    let ndl = dot(n, L);
    let diff = clamp(ndl * 0.85 + 0.15, 0.0, 1.0);
    let H = normalize(L + V);
    let sp = pow(max(dot(n, H), 0.0), mix(80.0, 8.0, rough)) * spec;
    return albedo * (world.suncol.rgb * diff * world.sun.w + ambient(n)) + world.suncol.rgb * sp * step(0.0, ndl);
}

fn fs_color(in: VOut) -> vec4<f32> {
    let kind = i32(in.params.x + 0.5);
    let wp = in.world_pos;
    let p = wp.xz;
    if (kind == 3) { return vec4<f32>(sky(normalize(wp - camera.view_pos.xyz)), 1.0); }
    if (kind == 5) {
        let s = card(in.local.xy, i32(in.extra.y + 0.5), in.params.y);
        if (s.x > 0.0) { discard; }
        var c = in.color.rgb * s.y * (0.85 + 0.3 * vnoise(in.local.xy * 4.0 + vec2<f32>(in.params.y * 9.0)));
        let lit = shade(c, normalize(in.normal), wp, 0.0, 1.0);
        return vec4<f32>(lit, 1.0);
    }
    var n = normalize(in.normal);
    var albedo = in.color.rgb;
    var spec = 0.05;
    var rough = 0.9;
    var emit = vec3<f32>(0.0);
    if (kind == 1) {
        // Terrain: dirt, with grass (r), rock (g), sand (b) and paving (a) blended in.
        let w = in.vcolor;
        let g = fbm2(p * 0.08);
        let fine = vnoise(p * 1.7);
        let biome = i32(world.cam.w + 0.5);
        var dirt = mix(vec3<f32>(0.42, 0.34, 0.25), vec3<f32>(0.52, 0.43, 0.32), g) * (0.9 + fine * 0.2);
        var grass = mix(vec3<f32>(0.3, 0.36, 0.17), vec3<f32>(0.42, 0.44, 0.22), g) * (0.85 + fine * 0.25);
        if (biome == 0) { grass = mix(vec3<f32>(0.5, 0.47, 0.3), vec3<f32>(0.58, 0.52, 0.34), g); }
        if (biome == 2) { grass = mix(vec3<f32>(0.4, 0.42, 0.3), vec3<f32>(0.47, 0.46, 0.33), g); }
        var rock = mix(vec3<f32>(0.4, 0.39, 0.37), vec3<f32>(0.55, 0.53, 0.5), vnoise(p * 0.3 + vec2<f32>(wp.y * 0.4))) * (0.85 + fine * 0.25);
        var sand = mix(vec3<f32>(0.72, 0.64, 0.48), vec3<f32>(0.8, 0.72, 0.56), g) * (0.92 + fine * 0.1);
        if (biome == 0) {
            // Fused glass: green-black sheets that glint.
            let glass = smoothstep(0.55, 0.7, fbm2(p * 0.03 + vec2<f32>(9.0)));
            sand = mix(sand, vec3<f32>(0.16, 0.24, 0.2) + vec3<f32>(0.1) * fine, glass);
            spec = spec + glass * w.b * 0.9; rough = mix(rough, 0.15, glass * w.b);
        }
        let road = smoothstep(0.75, 0.95, w.a);
        var paved = mix(vec3<f32>(0.5, 0.49, 0.46) * (0.9 + fine * 0.15), vec3<f32>(0.2, 0.2, 0.21) * (0.9 + fine * 0.2), road);
        let crack = smoothstep(0.03, 0.0, abs(vnoise(p * 0.7) - 0.5)) * 0.3;
        paved = paved * (1.0 - crack);
        albedo = dirt;
        albedo = mix(albedo, grass, clamp(w.r, 0.0, 1.0));
        albedo = mix(albedo, sand, clamp(w.b, 0.0, 1.0));
        albedo = mix(albedo, rock, clamp(w.g + smoothstep(0.6, 0.85, 1.0 - n.y), 0.0, 1.0));
        albedo = mix(albedo, paved, clamp(w.a, 0.0, 1.0));
        // Snow above the snow line on flat ground; scorch marks everywhere.
        let snow = smoothstep(world.fog.w, world.fog.w + 15.0, wp.y + fine * 6.0) * smoothstep(0.6, 0.85, n.y);
        albedo = mix(albedo, vec3<f32>(0.9, 0.92, 0.95), snow);
        let scorch = smoothstep(0.78, 0.86, vnoise(p * 0.045 + vec2<f32>(3.3, 7.1)));
        albedo = albedo * (1.0 - scorch * 0.45);
    } else if (kind == 2) {
        let depth = in.vcolor.r;
        albedo = mix(vec3<f32>(0.28, 0.4, 0.4), vec3<f32>(0.06, 0.14, 0.18), smoothstep(0.0, 8.0, depth));
        let ripple = vnoise(p * 0.4 + vec2<f32>(world.time.x * 0.2, 0.0)) + vnoise(p * 0.9 - vec2<f32>(0.0, world.time.x * 0.25));
        n = normalize(vec3<f32>((ripple - 1.0) * 0.12, 1.0, (vnoise(p * 0.5) - 0.5) * 0.12));
        spec = 1.2; rough = 0.1;
        let foam = smoothstep(0.6, 0.0, depth + sin(world.time.x * 1.3 + p.x * 0.1) * 0.15);
        albedo = mix(albedo, vec3<f32>(0.85), foam * 0.7);
    } else if (kind == 0) {
        // Props: procedural materials in world space (triplanar-ish by the dominant axis).
        let m = i32(in.extra.y + 0.5);
        let an = abs(n);
        var uvp = wp.xy;
        if (an.x > an.z && an.x > an.y) { uvp = wp.zy; }
        else if (an.y > an.x && an.y > an.z) { uvp = wp.xz; }
        let g = fbm2(uvp * 0.5 + vec2<f32>(in.params.y));
        let fine = vnoise(uvp * 6.0);
        let grime = smoothstep(1.5, 0.0, in.local.y * in.scale.y + in.scale.y) * 0.25;
        if (m == 0 || m == 9 || m == 14) {
            albedo = albedo * (0.82 + g * 0.25 + fine * 0.06);
            let panel = smoothstep(0.03, 0.0, abs(fract(uvp.x / 3.0) - 0.5) - 0.48) + smoothstep(0.03, 0.0, abs(fract(uvp.y / 3.0) - 0.5) - 0.48);
            albedo = albedo * (1.0 - panel * 0.2);
            let stain = smoothstep(0.55, 0.8, vnoise(vec2<f32>(uvp.x * 1.3, uvp.y * 0.2)));
            albedo = albedo * (1.0 - stain * 0.18);
            if (m == 9) { albedo = albedo * (1.0 - smoothstep(0.02, 0.0, abs(fract(wp.y * 1.2) - 0.5) - 0.45) * 0.15); }
        } else if (m == 1) {
            let b = bricks(uvp);
            albedo = mix(albedo * (0.8 + b.y * 0.35), vec3<f32>(0.62, 0.6, 0.55), b.x * 0.8) * (0.9 + g * 0.15);
        } else if (m == 2 || m == 15) {
            albedo = albedo * (0.88 + g * 0.2 + fine * 0.05);
            let crackl = smoothstep(0.012, 0.0, abs(vnoise(uvp * 1.7) - 0.5)) * 0.2 * step(0.55, vnoise(uvp * 0.4 + vec2<f32>(7.0)));
            albedo = albedo * (1.0 - crackl);
            // Plaster: chipped paint showing brick.
            if (m == 15) { let chip = smoothstep(0.8, 0.83, vnoise(uvp * 2.2 + vec2<f32>(in.params.y))) * smoothstep(0.45, 0.65, vnoise(uvp * 0.3)); let b = bricks(uvp); albedo = mix(albedo, mix(vec3<f32>(0.55, 0.3, 0.22), vec3<f32>(0.6, 0.58, 0.52), b.x), chip); }
        } else if (m == 3 || m == 12) {
            albedo = albedo * (0.85 + g * 0.2);
            spec = 0.5; rough = 0.45;
            let rust = smoothstep(0.6, 0.85, fbm2(uvp * 0.8 + vec2<f32>(in.params.y * 3.0)));
            albedo = mix(albedo, vec3<f32>(0.4, 0.2, 0.1), rust * 0.6);
        } else if (m == 4) {
            // Corrugated container sides.
            let rib = sin(dot(uvp, vec2<f32>(1.0, 0.0)) * 12.0) * 0.5 + 0.5;
            albedo = albedo * (0.8 + rib * 0.25) * (0.9 + g * 0.15);
            let rust = smoothstep(0.62, 0.85, fbm2(uvp * 0.6 + vec2<f32>(in.params.y)));
            albedo = mix(albedo, vec3<f32>(0.36, 0.18, 0.09), rust * 0.55);
            spec = 0.3; rough = 0.5;
        } else if (m == 5) {
            // Sandbags: staggered bags.
            let row = floor(wp.y / 0.18);
            let q = vec2<f32>(dot(uvp, vec2<f32>(1.0, 0.0)) / 0.55 + row * 0.5, wp.y / 0.18);
            let f = fract(q);
            let bag = smoothstep(0.0, 0.18, min(min(f.x, 1.0 - f.x) * 2.0, min(f.y, 1.0 - f.y) * 1.2));
            albedo = albedo * (0.6 + 0.4 * bag) * (0.9 + hash2(floor(q)) * 0.2) * (0.95 + fine * 0.1);
        } else if (m == 6 || m == 10) {
            albedo = albedo * (0.7 + g * 0.45 + fine * 0.1);
            albedo = mix(albedo, albedo * vec3<f32>(0.8, 0.85, 0.7), smoothstep(0.6, 0.9, n.y) * 0.4);
        } else if (m == 7) {
            let plank = fract(wp.y * 3.0 + hash2(floor(uvp * vec2<f32>(0.5, 3.0))) * 0.0);
            albedo = albedo * (0.75 + 0.25 * smoothstep(0.0, 0.1, min(plank, 1.0 - plank))) * (0.85 + vnoise(vec2<f32>(uvp.x * 8.0, uvp.y * 0.5)) * 0.25);
        } else if (m == 8) {
            albedo = vec3<f32>(0.12, 0.22, 0.18) + vec3<f32>(0.08, 0.12, 0.1) * g;
            spec = 1.0; rough = 0.12;
        } else if (m == 11) {
            // Hesco: wire mesh over sand.
            let mesh = smoothstep(0.08, 0.0, min(abs(fract(uvp.x * 4.0) - 0.5), abs(fract(uvp.y * 4.0) - 0.5)) - 0.42);
            albedo = mix(vec3<f32>(0.62, 0.55, 0.42) * (0.85 + g * 0.2), vec3<f32>(0.3, 0.3, 0.28), mesh * 0.6);
        } else if (m == 13) {
            // Burnt-out wreck: soot, rust, a ghost of paint.
            let soot = smoothstep(0.3, 0.7, fbm2(uvp * 0.9 + vec2<f32>(in.params.y)));
            albedo = mix(albedo * 0.7, vec3<f32>(0.32, 0.17, 0.09), 0.5);
            albedo = mix(albedo, vec3<f32>(0.06), soot * 0.7);
            spec = 0.2; rough = 0.7;
        } else if (m == 16) {
            albedo = vec3<f32>(0.2) * (0.9 + fine * 0.2);
        }
        albedo = albedo * (1.0 - grime);
    } else if (kind == 4) {
        // Soldiers and vehicles: team colour broken up by camouflage; plates, skin, metal, glass.
        let part = i32(in.extra.y + 0.5);
        let cam = in.extra.x;
        let q = (in.local.xz + in.local.yy * 0.7 + vec2<f32>(in.params.y)) * max(cam, 0.01);
        let blot = smoothstep(0.45, 0.55, vnoise(q * 3.0)) * 0.5 + smoothstep(0.55, 0.65, vnoise(q * 5.0 + vec2<f32>(3.0))) * 0.5;
        if (part == 0) { albedo = mix(albedo, albedo * vec3<f32>(0.62, 0.66, 0.6), blot) * (0.9 + vnoise(in.local.xy * 20.0) * 0.12); }
        else if (part == 1) { albedo = mix(albedo, albedo * 0.7, blot * 0.6); spec = 0.25; rough = 0.55; }
        else if (part == 2) { albedo = in.color.rgb; spec = 0.1; rough = 0.6; }
        else if (part == 3) { albedo = vec3<f32>(0.08, 0.085, 0.09); spec = 0.6; rough = 0.35; }
        else if (part == 4) { albedo = vec3<f32>(0.05); emit = in.color.rgb * 0.9; spec = 1.0; rough = 0.1; }
        else if (part == 5) {
            albedo = mix(albedo, albedo * vec3<f32>(0.6, 0.62, 0.58), blot * 0.7);
            let an = abs(n);
            var uv2 = in.local.xy * in.scale.xy;
            if (an.x > 0.5) { uv2 = in.local.zy * in.scale.zy; } else if (an.y > 0.5) { uv2 = in.local.xz * in.scale.xz; }
            let seam = smoothstep(0.04, 0.0, abs(fract(uv2.x / 1.6) - 0.5) - 0.47);
            albedo = albedo * (1.0 - seam * 0.25) * (0.88 + vnoise(uv2 * 3.0) * 0.18);
            spec = 0.35; rough = 0.5;
        }
        else if (part == 6) { albedo = vec3<f32>(0.07); rough = 1.0; }
        else if (part == 7) { albedo = vec3<f32>(0.1, 0.13, 0.15); spec = 1.5; rough = 0.08; }
        // Hit flash and the team's thin identification glow stripe.
        emit = emit + in.color.rgb * in.params.z;
    } else if (kind == 6) {
        return vec4<f32>(in.color.rgb * (1.0 + in.params.z), 1.0);
    }
    // Contact darkening near the ground (props and bodies stand on it).
    var col = shade(albedo, n, wp, spec, rough);
    col = col + emit;
    return vec4<f32>(col, 1.0);
}

@fragment
fn fs_main(in: VOut) -> FOut {
    var o: FOut;
    o.color = fs_color(in);
    o.depth = min(depth_of(in.view_w), 0.99999);
    return o;
}
`;

const GLOW_SRC = /* wgsl */ `
${COMMON}

@vertex
fn vs_main(in: VertexInput, @builtin(instance_index) ii: u32) -> VOut {
    let it = items[ii];
    var out: VOut;
    let center = it.model[3].xyz;
    let sx = length(it.model[0].xyz);
    let sy = length(it.model[1].xyz);
    let kind = i32(it.params.x + 0.5);
    var wp: vec3<f32>;
    if (kind == 4) {
        wp = center + vec3<f32>(in.position.x * sx, 0.0, in.position.y * sx);
    } else if (kind == 2) {
        let axis = it.model[2].xyz;
        let mid = center + axis * (in.position.y * 0.5 + 0.5);
        let side = normalize(cross(normalize(axis), normalize(camera.view_pos.xyz - mid)));
        wp = mid + side * in.position.x * sx;
    } else {
        let f = normalize(camera.view_pos.xyz - center);
        var r = cross(vec3<f32>(0.0, 1.0, 0.0), f);
        if (length(r) < 1e-4) { r = vec3<f32>(1.0, 0.0, 0.0); }
        r = normalize(r);
        let u = cross(f, r);
        wp = center + r * in.position.x * sx + u * in.position.y * sy;
    }
    out.clip = far_depth(camera.view_proj * vec4<f32>(wp, 1.0));
        out.view_w = out.clip.w;
    out.world_pos = wp;
    out.normal = vec3<f32>(0.0, 1.0, 0.0);
    out.uv = in.position.xy;
    out.vcolor = in.color;
    out.local = in.position;
    out.color = it.color;
    out.params = it.params;
    out.extra = it.extra;
    out.scale = vec3<f32>(sx, sy, 1.0);
    return out;
}

fn fs_color(in: VOut) -> vec4<f32> {
    let kind = i32(in.params.x + 0.5);
    let p = in.uv;
    let d = length(p);
    var a = 0.0;
    if (kind == 0) { a = exp(-d * d * 5.0); }
    else if (kind == 1 || kind == 4) {
        let w = max(0.02, in.params.z);
        a = exp(-pow((d - (1.0 - w)) / w, 2.0));
        if (kind == 4) { a = a * (0.6 + 0.4 * sin(atan2(p.y, p.x) * 24.0 + in.extra.x * 6.0) ) + exp(-d * d * 3.0) * in.extra.y; }
    }
    else if (kind == 2) { a = exp(-p.x * p.x * 5.0) * smoothstep(1.0, 0.6, abs(p.y)); }
    else if (kind == 3) {
        let n = vnoise(p * 3.0 + vec2<f32>(in.params.y * 7.0)) * 0.6 + vnoise(p * 7.0 - vec2<f32>(in.params.y)) * 0.4;
        a = smoothstep(1.0, 0.2, d + n * 0.5 - 0.15);
    }
    else if (kind == 5) {
        let diamond = abs(p.x) + abs(p.y);
        a = smoothstep(0.75, 0.65, diamond) - smoothstep(0.55, 0.45, diamond) * 0.7;
    }
    if (d > 1.0 && kind != 2) { a = 0.0; }
    return vec4<f32>(in.color.rgb * in.color.a, a);
}

@fragment
fn fs_main(in: VOut) -> FOut {
    var o: FOut;
    o.color = fs_color(in);
    o.depth = min(depth_of(in.view_w), 0.99999);
    return o;
}
`;

const SMOKE_SRC = /* wgsl */ `
${COMMON}
${GLOW_SRC.slice(GLOW_SRC.indexOf("@vertex"), GLOW_SRC.indexOf("fn fs_color"))}
fn fs_color(in: VOut) -> vec4<f32> {
    let p = in.uv;
    let n = vnoise(p * 2.5 + vec2<f32>(in.params.y * 5.0, world.time.x * 0.15)) * 0.6 + vnoise(p * 5.0 + vec2<f32>(in.params.y)) * 0.4;
    let a = smoothstep(1.0, 0.25, length(p) + (n - 0.5) * 0.7) * in.color.a;
    let lit = 0.75 + 0.35 * (p.y * 0.5 + 0.5);
    let col = in.color.rgb * lit * (world.suncol.rgb * 0.6 + vec3<f32>(world.suncol.w));
    return vec4<f32>(col, a);
}

@fragment
fn fs_main(in: VOut) -> FOut {
    var o: FOut;
    o.color = fs_color(in);
    o.depth = min(depth_of(in.view_w), 0.99999);
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
    a: vec4<f32>,   // fog density, fog start, screen w, h
    b: vec4<f32>,   // fog color, time
    c: vec4<f32>,   // vignette, grain, hurt, flash
    d: vec4<f32>,   // emp, ads, exposure, saturation
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

fn dist_at(px: vec2<i32>) -> f32 {
    let size = vec2<i32>(textureDimensions(depth));
    let d = textureLoad(depth, clamp(px, vec2<i32>(0), size - vec2<i32>(1)), 0);
    if (d >= 0.99999) { return 1e5; }
    return ${DEPTH_K.toFixed(1)} * d / max(1e-5, 1.0 - d);
}

fn filmic(x: vec3<f32>) -> vec3<f32> {
    let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_main(in: VO) -> @location(0) vec4<f32> {
    let size = vec2<f32>(textureDimensions(frame));
    let px = vec2<i32>(in.uv * size);
    let w = dist_at(px);
    var col = textureSampleLevel(frame, samp, in.uv, 0.0).rgb;
    // Distance fog (the sky keeps its own colour).
    if (w < 9e4) {
        let f = 1.0 - exp(-max(0.0, w - post.a.y) * post.a.x);
        col = mix(col, post.b.rgb, clamp(f, 0.0, 0.92));
    }
    col = filmic(col * post.d.z);
    let l = dot(col, vec3<f32>(0.299, 0.587, 0.114));
    col = mix(vec3<f32>(l), col, post.d.w);
    // Vignette (stronger aiming down sights), grain, hurt, flash, EMP static.
    let e = in.uv - vec2<f32>(0.5);
    let v = length(e * vec2<f32>(1.0, 0.75));
    col = col * (1.0 - (post.c.x + post.d.y * 0.25) * smoothstep(0.3, 0.85, v));
    let g = fract(sin(dot(in.uv * size + vec2<f32>(post.b.w * 61.0, post.b.w * 17.0), vec2<f32>(12.9898, 78.233))) * 43758.5453);
    col = col + (g - 0.5) * (post.c.y + post.d.x * 0.5);
    col = mix(col, vec3<f32>(0.55, 0.02, 0.02), post.c.z * smoothstep(0.2, 0.8, v) * 0.85);
    col = mix(col, vec3<f32>(1.0, 0.95, 0.85), post.c.w);
    if (post.d.x > 0.0) { let band = step(0.5, fract(in.uv.y * 90.0 + post.b.w * 7.0)); col = mix(col, vec3<f32>(g), post.d.x * 0.35 * band); }
    return vec4<f32>(col, 1.0);
}
`;

export const AR_LIT_SHADER = LIT_SRC;
export const AR_GLOW_SHADER = GLOW_SRC;
export const AR_SMOKE_SHADER = SMOKE_SRC;
export const AR_SCREEN_SHADER = SCREEN_SRC;
