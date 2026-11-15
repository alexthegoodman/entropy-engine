// World of Music's look, in four pipelines and one screen pass:
//
//   TOON     every opaque thing. Light is cut into three flat bands of grey, shadows are hatched
//            in ink, and only an item's `chroma` lets its own color through - fully, and bright.
//            The ground carries a network of veins (a Voronoi web); music is drawn as pulses of
//            color racing out along them, and the Red Corruption stains the land black with red
//            veins that beat.
//   INK      the same meshes again, pushed out along their normals and drawn back-faces only:
//            a black brush line around every character and prop.
//   GLOW     additive light on camera-facing quads: notes, sparks, bolts, rings, the cursor.
//   SCREEN   (Entropy.Screen.setEffect) reads the frame and its depth: a strong depth of field
//            focused on Agent Tom, a bloom that only colored light gets, a pale haze with
//            distance, ink lines where depth breaks, grain. The dreamy haze of the place.
//
// Depth is written as w / (w + DEPTH_K): monotonic, never past the far plane, and the screen pass
// turns it back into distance exactly (w = K d / (1 - d)).

export const MAX_PULSES = 32;
export const MAX_DARKS = 8;
export const DEPTH_K = 60;
export const WORLD_VEC4 = 8 + MAX_PULSES * 2 + MAX_DARKS;
export const WORLD_FLOATS = WORLD_VEC4 * 4;
export const ITEM_FLOATS = 28;
export const POST_FLOATS = 4 * 4;

/** Item.params.x in the TOON pipeline. */
export const TOON = { prop: 0, terrain: 1, water: 2, sky: 3, foliage: 4, creature: 5, corrupt: 6, mech: 7, ghost: 8, card: 9 } as const;
/** Surface patterns for props (Item.extra.y with TOON.prop / TOON.foliage). */
export const MATERIAL = { plain: 0, stone: 1, bark: 2, wood: 3, leaf: 4, shell: 5, ringed: 6 } as const;
/** Silhouettes drawn on a billboard card (Item.extra.y with TOON.card). */
export const CARD = { grass: 0, reed: 1, fern: 2, bush: 3, flower: 4, broad: 5 } as const;
/** Item.params.x in the GLOW pipeline. */
export const GLOW = { dot: 0, ring: 1, note: 2, star: 3, flatRing: 4, beam: 5, heart: 6, shock: 7 } as const;

const COMMON = /* wgsl */ `
struct Camera { view_proj: mat4x4<f32>, view_pos: vec4<f32> };
@group(0) @binding(0) var<uniform> camera: Camera;

struct Pulse { a: vec4<f32>, b: vec4<f32> };   // a: x, z, radius now, strength; b: rgb, width
struct World {
    time: vec4<f32>,      // seconds, aspect, focus distance, exposure
    sun: vec4<f32>,       // direction (to the sun), haze density
    cam: vec4<f32>,       // camera position, dof strength
    screen: vec4<f32>,    // w, h, pulses, darks
    tom: vec4<f32>,       // Agent Tom's position, hurt
    fog: vec4<f32>,       // haze color, fade to black
    look: vec4<f32>,      // vein strength, hatch strength, ink strength, flash
    spare: vec4<f32>,
    pulses: array<Pulse, ${MAX_PULSES}>,
    darks: array<vec4<f32>, ${MAX_DARKS}>, // x, z, radius, heart (1 full .. 0)
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
};

fn far_depth(c: vec4<f32>) -> vec4<f32> {
    let w = max(c.w, 0.0001);
    return vec4<f32>(c.xy, c.w * (w / (w + ${DEPTH_K.toFixed(1)})), c.w);
}
fn hash2(p: vec2<f32>) -> f32 { var q = fract(p * vec2<f32>(123.34, 456.21)); q = q + dot(q, q + 45.32); return fract(q.x * q.y); }
fn hash22(p: vec2<f32>) -> vec2<f32> { return vec2<f32>(hash2(p), hash2(p + vec2<f32>(17.3, 9.1))); }
fn vnoise(p: vec2<f32>) -> f32 {
    let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2<f32>(1.0, 0.0)), u.x), mix(hash2(i + vec2<f32>(0.0, 1.0)), hash2(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}
fn luma(c: vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.299, 0.587, 0.114)); }

// Scattered round dots: pebbles, sand grains, speckle.
fn dots(p: vec2<f32>, scale: f32, density: f32, size: f32) -> f32 {
    let q = p * scale;
    let cell = floor(q);
    let o = hash22(cell) * 0.6 + vec2<f32>(0.2);
    let d = length(fract(q) - o);
    return smoothstep(size, size * 0.6, d) * step(1.0 - density, hash2(cell + vec2<f32>(7.3, 1.9)));
}
// Short pen dashes leaning one way: grass drawn with a nib.
fn dashes(p: vec2<f32>, scale: f32, density: f32, len: f32) -> f32 {
    let q = p * scale;
    let cell = floor(q);
    let local = fract(q) - hash22(cell) * 0.6 - vec2<f32>(0.2);
    let lean = (hash2(cell + vec2<f32>(1.7, 4.4)) - 0.5) * 0.8;
    let d = abs(local.x - local.y * lean);
    return smoothstep(0.045, 0.0, d) * step(abs(local.y), len) * step(1.0 - density, hash2(cell + vec2<f32>(3.1, 7.7)));
}

// Distance to the nearest edge of a Voronoi web (the veins), in cell units.
fn veins(p: vec2<f32>) -> f32 {
    let i = floor(p); let f = fract(p);
    var d1 = 8.0; var d2 = 8.0;
    for (var y = -1; y <= 1; y = y + 1) {
        for (var x = -1; x <= 1; x = x + 1) {
            let o = vec2<f32>(f32(x), f32(y));
            let r = o + hash22(i + o) * 0.85 - f;
            let d = dot(r, r);
            if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
        }
    }
    return sqrt(d2) - sqrt(d1);
}

// How much of the Red Corruption covers p (0 .. 1), and how alive its heart still is.
fn corruption(p: vec2<f32>) -> vec2<f32> {
    var c = 0.0; var heart = 0.0;
    let n = i32(world.screen.w + 0.5);
    for (var i = 0; i < n; i = i + 1) {
        let d = world.darks[i];
        if (d.z < 0.05) { continue; }
        let k = clamp(1.0 - length(p - d.xy) / d.z, 0.0, 1.0);
        let edge = vnoise(p * 0.35 + d.xy) * 0.35;
        let m = smoothstep(0.0, 0.25 + edge, k);
        if (m > c) { c = m; heart = d.w; }
    }
    return vec2<f32>(c, heart);
}

// Every music pulse passing p right now, as light (rgb) along the veins.
fn music(p: vec2<f32>, vein: f32) -> vec3<f32> {
    var col = vec3<f32>(0.0);
    let n = i32(world.screen.z + 0.5);
    for (var i = 0; i < n; i = i + 1) {
        let q = world.pulses[i];
        let d = length(p - q.a.xy);
        let w = q.b.w;
        let ring = exp(-pow((d - q.a.z) / w, 2.0));
        let inner = smoothstep(q.a.z, 0.0, d) * 0.25;
        col = col + q.b.rgb * (ring + inner) * q.a.w * vein;
    }
    return col;
}
`;

const TOON_SRC = /* wgsl */ `
${COMMON}

fn place(in: VertexInput, ii: u32, push: f32) -> VOut {
    let it = items[ii];
    var out: VOut;
    var local = in.position;
    let kind = i32(it.params.x + 0.5);
    // Foliage sways; creatures squash and stretch (extra.x = squash).
    if (kind == 4) {
        let sway = sin(world.time.x * 1.3 + it.params.y * 7.0 + local.y * 0.8) * 0.06 * max(0.0, local.y + 1.0);
        local = local + vec3<f32>(sway, 0.0, sway * 0.6);
    }
    if (kind == 5 || kind == 6) {
        let s = it.extra.x;
        local = local * vec3<f32>(1.0 + s * 0.5, 1.0 - s, 1.0 + s * 0.5);
    }
    if (kind == 9) {
        // A billboard card, turned about +y to face the camera, standing on its base.
        let c = it.model[3].xyz;
        let w = length(it.model[0].xyz);
        let h = length(it.model[1].xyz);
        var tc = camera.view_pos.xyz - c;
        tc.y = 0.0;
        let f = normalize(tc + vec3<f32>(0.0001, 0.0, 0.0));
        let r = vec3<f32>(f.z, 0.0, -f.x);
        let t = in.position.y * 0.5 + 0.5;
        let sway = sin(world.time.x * 1.7 + it.params.y * 13.0 + c.x * 0.3 + c.z * 0.2) * 0.1 * t * t * w;
        let cwp = c + r * (in.position.x * w + sway) + vec3<f32>(0.0, t * h, 0.0);
        let cclip = camera.view_proj * vec4<f32>(cwp, 1.0);
        out.clip = far_depth(cclip);
        out.world_pos = cwp;
        out.normal = normalize(f * 0.6 + vec3<f32>(0.0, 1.0, 0.0));
        out.uv = in.tex_coords;
        out.vcolor = in.color;
        out.local = in.position;
        out.color = it.color;
        out.params = it.params;
        out.extra = it.extra;
        if (push > 0.0) { out.clip = vec4<f32>(0.0, 0.0, -2.0, 1.0); }
        return out;
    }
    let sx = dot(it.model[0].xyz, it.model[0].xyz);
    let sy = dot(it.model[1].xyz, it.model[1].xyz);
    let sz = dot(it.model[2].xyz, it.model[2].xyz);
    let nl = in.normal / max(vec3<f32>(sx, sy, sz), vec3<f32>(1e-12));
    let n = normalize(it.model[0].xyz * nl.x + it.model[1].xyz * nl.y + it.model[2].xyz * nl.z);
    var wp = (it.model * vec4<f32>(local, 1.0)).xyz;
    if (kind == 3) { wp = camera.view_pos.xyz + in.position * 900.0; }
    if (kind == 2) { wp.y = wp.y + sin(wp.x * 0.35 + world.time.x * 1.1) * 0.06 + cos(wp.z * 0.3 + world.time.x * 0.8) * 0.06; }
    // The ink hull: pushed out along the normal, thicker far away so lines read at any distance.
    if (push > 0.0) {
        let dist = length(wp - camera.view_pos.xyz);
        wp = wp + n * push * it.extra.w * (0.6 + dist * 0.012);
    }
    let clip = camera.view_proj * vec4<f32>(wp, 1.0);
    out.clip = far_depth(clip);
    if (kind == 3) { out.clip = vec4<f32>(clip.xy, clip.w * 0.99999, clip.w); }
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

@vertex
fn vs_main(in: VertexInput, @builtin(instance_index) ii: u32) -> VOut { return place(in, ii, 0.0); }

// A tapered blade from (bx, -1) to (tx, ty): signed distance (negative inside).
fn blade(q: vec2<f32>, bx: f32, tx: f32, ty: f32, w: f32) -> f32 {
    let a = vec2<f32>(bx, -1.0);
    let b = vec2<f32>(tx, ty);
    let ab = b - a;
    let t = clamp(dot(q - a, ab) / dot(ab, ab), 0.0, 1.0);
    // A slight bow, as real blades have.
    let bow = vec2<f32>(-ab.y, ab.x) / length(ab) * sin(t * 3.1416) * 0.08;
    return length(q - (a + ab * t + bow)) - w * (1.0 - t * 0.92);
}

// A card's silhouette: x = signed distance (inside < 0), y = tone multiplier.
fn card(q: vec2<f32>, shape: i32, seed: f32) -> vec2<f32> {
    var d = 9.0;
    var tone = 1.0;
    if (shape == 0 || shape == 1 || shape == 2 || shape == 4) {
        let n = select(select(select(4, 9, shape == 2), 4, shape == 1), 7, shape == 0);
        let w = select(select(select(0.07, 0.15, shape == 2), 0.06, shape == 1), 0.1, shape == 0);
        for (var i = 0; i < 9; i = i + 1) {
            if (i >= n) { break; }
            let fi = f32(i);
            let h = hash2(vec2<f32>(seed * 31.0 + fi, fi * 1.7));
            let spread = select(0.55, 1.0, shape == 2);
            let bx = (fi / f32(n - 1) - 0.5) * select(0.7, 0.25, shape == 2);
            let tx = (fi / f32(n - 1) - 0.5) * 2.0 * spread + (h - 0.5) * 0.3;
            var ty = select(0.1 + h * 0.85, 0.7 + h * 0.3, shape == 1);
            if (shape == 2) { ty = 0.2 + (1.0 - abs(fi / f32(n - 1) - 0.5) * 2.0) * 0.75; }
            d = min(d, blade(q, bx, tx, ty, w));
            if (shape == 4) {
                let head = length(q - vec2<f32>(tx, ty)) - 0.17 - h * 0.06;
                if (head < d) { d = head; tone = 1.55; }
            }
            if (shape == 1 && fi < 2.0) {
                let pod = length((q - vec2<f32>(tx * 0.9, ty - 0.22)) / vec2<f32>(0.07, 0.2)) - 1.0;
                if (pod * 0.07 < d) { d = pod * 0.07; tone = 0.45; }
            }
        }
    } else if (shape == 3) {
        let j = vec2<f32>(hash2(vec2<f32>(seed, 1.0)), hash2(vec2<f32>(seed, 2.0))) - vec2<f32>(0.5);
        d = min(d, length(q - vec2<f32>(-0.5, -0.5) - j * 0.2) - 0.5);
        d = min(d, length(q - vec2<f32>(0.45, -0.45) + j * 0.2) - 0.52);
        d = min(d, length(q - vec2<f32>(0.0, -0.05) - j * 0.15) - 0.58);
        d = min(d, length(q - vec2<f32>(-0.3, 0.38) + j * 0.1) - 0.38);
        d = min(d, length(q - vec2<f32>(0.32, 0.3) - j * 0.1) - 0.36);
        // Leaf scallops along the edge, and shade toward the bottom.
        d = d + (vnoise(q * 9.0 + vec2<f32>(seed * 7.0)) - 0.5) * 0.09;
        tone = 0.8 + 0.3 * (q.y * 0.5 + 0.5) + step(0.72, vnoise(q * 7.0 + vec2<f32>(seed))) * 0.12;
    } else {
        // Broad leaves (banana, taro): rotated ellipses from the base, each with a dark midrib.
        for (var i = 0; i < 4; i = i + 1) {
            let fi = f32(i);
            let ang = (fi / 3.0 - 0.5) * 1.9 + (hash2(vec2<f32>(seed, fi)) - 0.5) * 0.3;
            let dir = vec2<f32>(sin(ang), cos(ang));
            let c = vec2<f32>(0.0, -1.0) + dir * (0.95 + fi * 0.04);
            let rel = q - c;
            let u = dot(rel, dir);
            let v = dot(rel, vec2<f32>(dir.y, -dir.x));
            let e = length(vec2<f32>(u / 0.9, v / 0.36)) - 1.0;
            let stem = blade(q, 0.0, c.x - dir.x * 0.85, c.y - dir.y * 0.85, 0.05);
            let dd = min(e * 0.36, stem);
            if (dd < d) { d = dd; tone = select(1.0, 0.55, abs(v) < 0.025 && e < 0.0); }
        }
    }
    return vec2<f32>(d, tone);
}

fn bands(l: f32) -> f32 {
    // Three flat bands of light: shadow, mid, lit.
    return select(select(0.38, 0.68, l > 0.12), 1.0, l > 0.55);
}

fn hatch(frag: vec2<f32>, amount: f32) -> f32 {
    let a = fract((frag.x + frag.y) / 7.0);
    let b = fract((frag.x - frag.y) / 9.0);
    let line1 = smoothstep(0.12, 0.0, abs(a - 0.5) - 0.32);
    let line2 = smoothstep(0.12, 0.0, abs(b - 0.5) - 0.34) * step(0.6, amount);
    return clamp((line1 + line2) * amount, 0.0, 1.0);
}

fn sky(dir: vec3<f32>) -> vec3<f32> {
    let up = clamp(dir.y, -1.0, 1.0);
    var col = mix(vec3<f32>(0.86), vec3<f32>(0.62), smoothstep(0.0, 0.9, up));
    col = mix(col, vec3<f32>(0.93), smoothstep(0.08, -0.1, up));
    // A pale sun, and slow bands of cloud in flat greys.
    let s = max(dot(dir, normalize(world.sun.xyz)), 0.0);
    col = mix(col, vec3<f32>(1.0), smoothstep(0.9975, 0.999, s));
    col = col + vec3<f32>(0.12) * pow(s, 24.0);
    let p = dir.xz / max(0.12, dir.y + 0.25) * 2.2 + vec2<f32>(world.time.x * 0.01, 0.0);
    let cl = vnoise(p * 0.8) * 0.6 + vnoise(p * 2.1) * 0.4;
    let cloud = smoothstep(0.55, 0.62, cl) * smoothstep(-0.05, 0.25, up);
    col = mix(col, vec3<f32>(0.97), cloud * 0.85);
    col = mix(col, vec3<f32>(0.7), smoothstep(0.62, 0.7, cl) * cloud * 0.3);
    return col;
}

@fragment
fn fs_main(in: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
    let kind = i32(in.params.x + 0.5);
    let p = in.world_pos.xz;
    if (kind == 3) { return vec4<f32>(sky(normalize(in.world_pos - camera.view_pos.xyz)), 1.0); }
    if (kind == 9) {
        let s = card(in.local.xy, i32(in.extra.y + 0.5), in.params.y);
        if (s.x > 0.0) { discard; }
        let cc = corruption(p);
        var a = luma(in.color.rgb) * s.y * (0.78 + 0.3 * (in.local.y * 0.5 + 0.5));
        a = mix(a, 0.07, cc.x * 0.9);
        let lit = bands(dot(normalize(in.normal), normalize(world.sun.xyz)) * 0.8 + 0.1 * in.local.y);
        var cardCol = vec3<f32>(min(a, 1.0) * mix(0.75, 1.0, lit));
        // An ink line just inside the silhouette.
        let edge = smoothstep(-0.045, -0.01, s.x) * world.look.z;
        cardCol = mix(cardCol, vec3<f32>(0.04), edge * 0.85);
        cardCol = cardCol + vec3<f32>(0.95, 0.06, 0.09) * edge * cc.x * (0.4 + 0.6 * cc.y);
        return vec4<f32>(cardCol, 1.0);
    }
    let n = normalize(in.normal);
    let L = normalize(world.sun.xyz);
    let V = normalize(camera.view_pos.xyz - in.world_pos);
    let ndl = dot(n, L);
    var light = bands(ndl);
    var albedo = luma(in.color.rgb);
    var chroma = in.color.a;
    var col = vec3<f32>(0.0);
    var emit = vec3<f32>(0.0);
    let cor = corruption(p);

    if (kind == 1 || kind == 2) {
        // The ground, in several drawn materials: meadow (pale, sparse short dashes), long grass
        // (darker, dense long dashes), bare soil with pebbles, rippled stippled sand, worn
        // paths, and layered, cracked rock on every cliff.
        let grain = vnoise(p * 0.22) * 0.6 + vnoise(p * 1.1) * 0.4;
        let beach = smoothstep(0.3, 0.7, in.vcolor.g + (vnoise(p * 0.45) - 0.5) * 0.5);
        let cliff = in.vcolor.b;
        let path = select(in.vcolor.a, 0.0, kind == 2);
        let zoneA = vnoise(p * 0.03 + vec2<f32>(3.0, 8.0)) * 0.7 + vnoise(p * 0.09) * 0.3;
        let zoneB = vnoise(p * 0.05 + vec2<f32>(11.0, 5.0)) * 0.75 + vnoise(p * 0.2 + vec2<f32>(2.0)) * 0.25;
        let meadow = smoothstep(0.42, 0.58, zoneA);
        let soil = smoothstep(0.66, 0.72, zoneB) * (1.0 - beach);
        // Grass: long and dark, or short and pale.
        var g = mix(0.4, 0.56, meadow) + grain * 0.08;
        g = g - dashes(p, mix(2.2, 1.5, meadow), mix(0.75, 0.35, meadow), mix(0.34, 0.18, meadow)) * mix(0.2, 0.14, meadow);
        g = g - dashes(p + vec2<f32>(0.37, 0.71), 3.1, 0.3 * (1.0 - meadow), 0.25) * 0.12;
        // Bare soil: dark, with light pebbles and a few cracks.
        var so = 0.36 + grain * 0.06 + dots(p, 2.6, 0.22, 0.18) * 0.18 - smoothstep(0.035, 0.0, veins(p * 0.8)) * 0.07;
        g = mix(g, so, soil);
        // Sand: pale, ripples, stipple and the odd shell.
        let ripple = smoothstep(0.75, 0.95, sin(p.x * 1.4 + p.y * 0.55 + vnoise(p * 0.3) * 6.0)) * 0.05;
        let sand = 0.8 + grain * 0.04 - ripple - dots(p, 6.0, 0.55, 0.16) * 0.12 + dots(p + vec2<f32>(9.0), 0.7, 0.1, 0.2) * 0.12;
        albedo = mix(g, sand, beach);
        // Worn paths: packed light dirt, pebbles, a darker rim.
        // The path's edge frays with noise, so the 1.5 m mesh never shows as steps.
        let fray = path + (vnoise(p * 1.7) - 0.5) * 0.45;
        let dirt = 0.6 + grain * 0.05 - dots(p, 3.2, 0.2, 0.16) * 0.08;
        albedo = mix(albedo, dirt, smoothstep(0.45, 0.65, fray) * 0.85);
        // Rock: strata following height, cracks across them, lighter ledges.
        let strata = fract(in.world_pos.y * 0.85 + vnoise(p * 0.25) * 1.3);
        var rock = 0.3 + grain * 0.06 + smoothstep(0.9, 1.0, strata) * 0.12 - smoothstep(0.1, 0.0, strata) * 0.14;
        rock = rock - smoothstep(0.05, 0.0, veins(vec2<f32>(p.x + p.y, in.world_pos.y * 2.0) * 0.7)) * 0.12;
        albedo = mix(albedo, rock, cliff);
        // The ground keeps two soft bands (cliffs keep three hard ones): small rolls of land
        // must not flicker between light and shadow.
        light = mix(mix(0.74, 1.0, smoothstep(0.2, 0.5, ndl)), light, cliff);
        if (kind == 2) {
            // Water: flat dark grey, a white rim of foam where it meets land.
            let depth = in.vcolor.r;
            albedo = mix(0.78, 0.34, smoothstep(0.0, 4.0, depth));
            let foam = smoothstep(0.55, 0.0, depth + sin(world.time.x * 1.6 + depth * 8.0 + p.x * 0.2) * 0.12);
            let glint = smoothstep(0.82, 0.9, vnoise(p * 0.6 + vec2<f32>(world.time.x * 0.3, 0.0))) * 0.5;
            light = 1.0;
            albedo = mix(albedo, 1.0, max(foam, glint));
        }
        let climb = in.vcolor.r;
        let vein = veins(p / 3.2);
        let veinLine = smoothstep(0.09, 0.0, vein);
        let fine = smoothstep(0.06, 0.0, veins(p / 1.1 + vec2<f32>(4.7, 1.3))) * 0.5;
        let net = max(veinLine, fine) * world.look.x;
        // Veins are faint ink at rest and light up when music runs through them.
        albedo = albedo - net * 0.06;
        emit = emit + music(p, net + 0.06) * (1.0 - cor.x * 0.7);
        if (kind == 1 && climb > 0.5) {
            // Teal handholds: thin rungs up the climbable face.
            let stripe = step(0.86, fract(in.world_pos.y * 1.1)) * step(0.35, fract((p.x + p.y) * 0.25));
            col = vec3<f32>(0.05, 0.92, 0.82);
            chroma = 0.9 * stripe;
            emit = emit + col * 0.2 * stripe;
        }
        // The Red Corruption: the land turns to ink and its veins beat red.
        if (cor.x > 0.0) {
            let beat = 0.55 + 0.45 * sin(world.time.x * 3.2 - length(p) * 0.15);
            albedo = mix(albedo, 0.06, cor.x * 0.92);
            emit = emit + vec3<f32>(0.95, 0.06, 0.09) * max(veinLine, fine * 1.2) * cor.x * (0.45 + 0.9 * beat * cor.y);
        }
    } else if (kind == 4) {
        // Foliage: leaf texture in greys.
        albedo = albedo * (0.85 + vnoise(in.local.xy * 6.0 + in.params.y) * 0.3);
        if (i32(in.extra.y + 0.5) == 4) {
            // A leaf: dark midrib along its length, veins off it.
            let rib = smoothstep(0.07, 0.0, abs(in.local.x));
            let vn = smoothstep(0.06, 0.0, abs(fract(in.local.z * 4.0 - abs(in.local.x) * 2.0) - 0.5) - 0.44) * step(abs(in.local.x), 0.85);
            albedo = albedo - rib * 0.18 - vn * 0.08;
        }
    } else if (kind == 6) {
        // Corrupted flesh: glossy red with black veins that crawl.
        let v = smoothstep(0.08, 0.0, veins(in.local.xz * 2.4 + in.local.y * 1.7 + vec2<f32>(world.time.x * 0.3)));
        col = mix(in.color.rgb, vec3<f32>(0.08, 0.0, 0.01), v * 0.8);
        chroma = 1.0;
        emit = emit + in.color.rgb * (0.18 + in.params.z) * (1.0 - v);
    } else if (kind == 7) {
        let band = smoothstep(0.4, 0.5, fract(in.local.y * 3.0 - world.time.x * 0.8));
        emit = emit + in.color.rgb * (in.params.z + band * 0.25);
    } else if (kind == 0) {
        let m = i32(in.extra.y + 0.5);
        let L = in.local;
        if (m == 1) {
            // Stone: speckle, cracks, lichen on top.
            albedo = albedo * (0.86 + vnoise(L.xz * 5.0 + L.y * 3.0 + in.params.y * 9.0) * 0.22);
            albedo = albedo - smoothstep(0.05, 0.0, veins(L.xz * 1.6 + vec2<f32>(L.y * 1.3, in.params.y * 5.0))) * 0.16;
            albedo = albedo - dots(L.xz * 3.0 + vec2<f32>(in.params.y * 3.0), 3.0, 0.4, 0.2) * 0.08 * smoothstep(0.4, 0.8, n.y);
            albedo = albedo + smoothstep(0.6, 0.9, n.y) * 0.08;
        } else if (m == 2) {
            // Bark: vertical fissures.
            let fis = smoothstep(0.08, 0.0, abs(fract(atan2(L.z, L.x) * 2.5 + vnoise(L.xy * vec2<f32>(3.0, 0.6)) * 1.4) - 0.5) - 0.42);
            albedo = albedo - fis * 0.14;
        } else if (m == 6) {
            // Palm trunk: rings of old leaf bases.
            let ring = fract(L.y * 2.4 + atan2(L.z, L.x) * 0.08);
            albedo = albedo - smoothstep(0.82, 0.95, ring) * 0.16 + smoothstep(0.1, 0.0, ring) * 0.06;
        } else if (m == 3) {
            // Wood planks: seams, grain lines and nail heads.
            let seam = smoothstep(0.06, 0.0, abs(fract(L.x * 1.5 + 0.5) - 0.5) - 0.44);
            let gr = smoothstep(0.7, 0.9, vnoise(vec2<f32>(L.x * 12.0, L.y * 1.5 + L.z)));
            albedo = albedo - seam * 0.2 - gr * 0.06;
        } else if (m == 5) {
            // Shell: ribs fanning out.
            let rib = smoothstep(0.2, 0.0, abs(fract(atan2(L.z, L.x) * 2.2) - 0.5) - 0.3);
            albedo = albedo - rib * 0.08;
        }
    } else if (kind == 8) {
        // A fallen Tone: grey, see-through-ish speckle.
        if (hash2(floor(in.clip.xy * 0.5)) > 0.55 + in.params.z * 0.4) { discard; }
    }

    // Ink hatching in the shadow band (not on colored things: their color stays clean).
    let shade = 1.0 - smoothstep(0.1, 0.5, ndl);
    let h = hatch(in.clip.xy, shade * world.look.y * (1.0 - chroma * 0.8));
    let grey = vec3<f32>(albedo * light) * (1.0 - h * 0.45);
    if (chroma > 0.0 && kind != 6 && !(kind == 1 && in.vcolor.r > 0.5)) { col = in.color.rgb; }
    // Colored things keep their hue at full strength in every band: lit is the color, shadow is
    // the same hue darker - never grey.
    let colored = col * mix(0.62, 1.12, smoothstep(0.1, 0.55, ndl));
    col = mix(grey, colored, chroma);
    // Characters get a white rim; colored ones glow a little.
    if (kind == 5 || kind == 6) {
        let rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
        col = col + vec3<f32>(rim * 0.35);
    }
    col = col + emit + in.color.rgb * chroma * in.params.z;
    return vec4<f32>(col, 1.0);
}
`;

const INK_SRC = /* wgsl */ `
${COMMON}
${TOON_SRC.slice(TOON_SRC.indexOf("fn place"), TOON_SRC.indexOf("@vertex"))}
@vertex
fn vs_main(in: VertexInput, @builtin(instance_index) ii: u32) -> VOut { return place(in, ii, 1.0); }

@fragment
fn fs_main(in: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
    if (front) { discard; }
    // Ink: near-black, warmed by the thing's own color when it has one.
    let c = mix(vec3<f32>(0.03), in.color.rgb * 0.18, in.color.a * 0.5);
    return vec4<f32>(c, 1.0);
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
        // Flat on the ground (rings around switches, the cursor, slam waves).
        wp = center + vec3<f32>(in.position.x * sx, 0.0, in.position.y * sx);
    } else if (kind == 5) {
        // A beam from center along model[2] (length = its length), facing the camera.
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
    let clip = camera.view_proj * vec4<f32>(wp, 1.0);
    out.clip = far_depth(clip);
    out.world_pos = wp;
    out.normal = vec3<f32>(0.0, 1.0, 0.0);
    out.uv = in.position.xy;
    out.vcolor = in.color;
    out.local = in.position;
    out.color = it.color;
    out.params = it.params;
    out.extra = it.extra;
    return out;
}

fn note_glyph(p: vec2<f32>) -> f32 {
    // An eighth note: a tilted oval head, a stem, a flag.
    let q = vec2<f32>(p.x + 0.25, p.y + 0.45);
    let c = cos(-0.45); let s = sin(-0.45);
    let r = vec2<f32>(q.x * c - q.y * s, q.x * s + q.y * c);
    let head = length(r / vec2<f32>(0.32, 0.22));
    let stem = max(abs(p.x - 0.05) - 0.05, abs(p.y - 0.15) - 0.6);
    let flag = length(vec2<f32>(p.x - 0.28, p.y - 0.45) / vec2<f32>(0.28, 0.12)) - 1.0;
    let d = min(min(head - 1.0, stem * 8.0), max(flag, -(p.x - 0.05)) );
    return smoothstep(0.15, -0.1, d);
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
    let kind = i32(in.params.x + 0.5);
    let p = in.uv;
    let d = length(p);
    var a = 0.0;
    if (kind == 0) { a = exp(-d * d * 4.0) ; }
    else if (kind == 1 || kind == 4) {
        let w = max(0.03, in.params.z);
        a = exp(-pow((d - (1.0 - w)) / w, 2.0)) ;
        if (kind == 4) { a = a + exp(-d * d * 3.0) * in.extra.x; }
    }
    else if (kind == 2) { a = note_glyph(p * 1.2) + exp(-d * d * 3.0) * 0.25; }
    else if (kind == 3) {
        let star = max(0.0, 1.0 - abs(p.x * p.y) * 30.0 - d * 0.8);
        a = star + exp(-d * d * 10.0);
    }
    else if (kind == 5) { a = exp(-p.x * p.x * 6.0); }
    else if (kind == 6) {
        let beat = 0.7 + 0.3 * sin(world.time.x * 4.0 + in.params.y);
        a = exp(-d * d * 2.5) * beat + smoothstep(0.08, 0.0, abs(d - 0.7 - 0.1 * beat)) * 0.4;
    }
    else if (kind == 7) { a = smoothstep(0.2, 0.0, abs(d - 0.85)) * (1.0 - d * 0.5); }
    if (d > 1.0 && kind != 5) { a = 0.0; }
    return vec4<f32>(in.color.rgb * in.color.a, a);
}
`;

const SCREEN_SRC = /* wgsl */ `
struct Camera { view_proj: mat4x4<f32>, view_pos: vec4<f32> };
@group(0) @binding(0) var<uniform> camera: Camera;
@group(1) @binding(0) var frame: texture_2d<f32>;
@group(1) @binding(1) var samp: sampler;
@group(1) @binding(2) var depth: texture_depth_2d;
struct Post {
    a: vec4<f32>,   // focus distance, focus range, max blur (px), haze density
    b: vec4<f32>,   // haze color, bloom
    c: vec4<f32>,   // screen w, h, time, ink
    d: vec4<f32>,   // vignette, grain, fade, flash
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

fn coc(w: f32) -> f32 {
    let f = post.a.x;
    let range = post.a.y;
    // Far things melt into the haze; the near foreground blurs too, gently.
    let far = smoothstep(f + range * 0.4, f + range * 3.5, w);
    let near = smoothstep(f * 0.55, f * 0.2, w) * 0.7;
    return clamp(max(far, near), 0.0, 1.0);
}

@fragment
fn fs_main(in: VO) -> @location(0) vec4<f32> {
    let size = vec2<f32>(textureDimensions(frame));
    let px = vec2<i32>(in.uv * size);
    let w = dist_at(px);
    let base = textureSampleLevel(frame, samp, in.uv, 0.0).rgb;
    let c0 = coc(w);
    let radius = c0 * post.a.z;
    // Depth of field: a golden-angle disc gather; samples nearer than this pixel only count
    // if they are blurred themselves (so sharp things do not smear over the background).
    var acc = base;
    var wsum = 1.0;
    var bloom = vec3<f32>(0.0);
    let taps = 24;
    let br = max(radius, 6.0) * 1.6 + 4.0;
    for (var k = 0; k < taps; k = k + 1) {
        let fk = f32(k) + 0.5;
        let a = fk * 2.39996;
        let r = sqrt(fk / f32(taps));
        let o = vec2<f32>(cos(a), sin(a)) * r;
        let uv = in.uv + o * radius / size;
        let s = textureSampleLevel(frame, samp, uv, 0.0).rgb;
        let sw = dist_at(vec2<i32>(uv * size));
        let sc = coc(sw);
        let wt = select(1.0, sc, sw < w - 0.5);
        acc = acc + s * wt;
        wsum = wsum + wt;
        // Bloom: only colored light glows (grey stays grey, however bright).
        let buv = in.uv + o * br / size;
        let b = textureSampleLevel(frame, samp, buv, 0.0).rgb;
        let sat = max(b.r, max(b.g, b.b)) - min(b.r, min(b.g, b.b));
        bloom = bloom + b * smoothstep(0.25, 0.75, sat) * smoothstep(0.45, 1.0, max(b.r, max(b.g, b.b)));
    }
    var col = acc / wsum;
    col = col + bloom / f32(taps) * post.b.w;
    // Ink lines where depth breaks (silhouettes of the land and everything on it), fading
    // with the blur so far things stay soft.
    let wl = dist_at(px + vec2<i32>(-1, 0)); let wr = dist_at(px + vec2<i32>(1, 0));
    let wu = dist_at(px + vec2<i32>(0, -1)); let wd = dist_at(px + vec2<i32>(0, 1));
    let edge = max(max(abs(wl - w), abs(wr - w)), max(abs(wu - w), abs(wd - w))) / max(w, 0.5);
    let ink = smoothstep(0.06, 0.18, edge) * (1.0 - c0) * post.c.w * step(w, 900.0);
    col = mix(col, vec3<f32>(0.04), ink * 0.85);
    // The dreamy haze: distance lifts everything toward a pale grey-white.
    let sky = w > 9e4;
    let haze = select(1.0 - exp(-w * post.a.w), 0.35, sky);
    col = mix(col, post.b.rgb, clamp(haze, 0.0, 0.85));
    // Grain, vignette, fades.
    let g = fract(sin(dot(in.uv * size + vec2<f32>(post.c.z * 61.0, post.c.z * 17.0), vec2<f32>(12.9898, 78.233))) * 43758.5453);
    col = col + (g - 0.5) * post.d.y;
    let e = in.uv - vec2<f32>(0.5);
    col = col * (1.0 - post.d.x * smoothstep(0.35, 0.85, length(e * vec2<f32>(1.0, 0.8))));
    col = mix(col, vec3<f32>(1.0), post.d.w);
    col = col * (1.0 - post.d.z);
    return vec4<f32>(col, 1.0);
}
`;

export const WOM_TOON_SHADER = TOON_SRC;
export const WOM_INK_SHADER = INK_SRC;
export const WOM_GLOW_SHADER = GLOW_SRC;
export const WOM_SCREEN_SHADER = SCREEN_SRC;
