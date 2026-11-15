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
export const TOON = { prop: 0, terrain: 1, water: 2, sky: 3, foliage: 4, creature: 5, corrupt: 6, mech: 7, ghost: 8 } as const;
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
        // The ground: grass greys, pale sand by the water, dark cliff faces, teal climbing marks.
        let grain = vnoise(p * 0.22) * 0.6 + vnoise(p * 1.1) * 0.4;
        let beach = in.vcolor.g;
        let cliff = in.vcolor.b;
        albedo = mix(0.46 + grain * 0.1, 0.8 + grain * 0.05, beach);
        albedo = mix(albedo, 0.28 + grain * 0.08, cliff);
        // Strokes of grass, drawn as darker dashes.
        // Grass as short ink dashes, sparse, like a pen drawing.
        let cell = floor(p * 1.4);
        let jitter = hash22(cell);
        let local = fract(p * 1.4) - jitter * 0.6 - vec2<f32>(0.2);
        let dash = smoothstep(0.05, 0.0, abs(local.x + local.y * 0.25)) * step(abs(local.y), 0.22) * step(0.72, hash2(cell + vec2<f32>(3.1, 7.7)));
        albedo = albedo - dash * 0.22 * (1.0 - beach) * (1.0 - cliff);
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
    } else if (kind == 6) {
        // Corrupted flesh: glossy red with black veins that crawl.
        let v = smoothstep(0.08, 0.0, veins(in.local.xz * 2.4 + in.local.y * 1.7 + vec2<f32>(world.time.x * 0.3)));
        col = mix(in.color.rgb, vec3<f32>(0.08, 0.0, 0.01), v * 0.8);
        chroma = 1.0;
        emit = emit + in.color.rgb * (0.18 + in.params.z) * (1.0 - v);
    } else if (kind == 7) {
        let band = smoothstep(0.4, 0.5, fract(in.local.y * 3.0 - world.time.x * 0.8));
        emit = emit + in.color.rgb * (in.params.z + band * 0.25);
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
