// Mesha's viewport look: one unlit-pipeline shader that does its own studio lighting, so objects
// read as finished products rather than grey clay - a soft key light, a cool fill, a gradient sky
// that glossy and metal surfaces reflect, fabric sheen, wood grain, speckled stone and leather,
// glossy tinted glass, a floor with baked contact shadows and a fading grid, and a rim glow on
// the selected object. Materials arrive packed in the vertex (see mesha_scene.ts packVertices).

export interface StudioLighting {
    id: string;
    label: string;
    keyDir: [number, number, number];
    keyColor: [number, number, number];
    keyIntensity: number;
    fillDir: [number, number, number];
    fillIntensity: number;
    skyTop: [number, number, number];
    skyHorizon: [number, number, number];
    ground: [number, number, number];
    exposure: number;
}

export const STUDIO_PRESETS: StudioLighting[] = [
    { id: "studio", label: "Studio", keyDir: [0.55, 0.8, 0.35], keyColor: [1, 0.97, 0.92], keyIntensity: 2.3, fillDir: [-0.6, 0.35, -0.25], fillIntensity: 0.5, skyTop: [0.16, 0.17, 0.19], skyHorizon: [0.42, 0.43, 0.45], ground: [0.36, 0.36, 0.37], exposure: 1.0 },
    { id: "daylight", label: "Daylight", keyDir: [0.35, 0.85, 0.45], keyColor: [1, 0.96, 0.88], keyIntensity: 2.6, fillDir: [-0.5, 0.45, -0.4], fillIntensity: 0.65, skyTop: [0.36, 0.55, 0.85], skyHorizon: [0.82, 0.86, 0.9], ground: [0.56, 0.54, 0.5], exposure: 1.0 },
    { id: "warm", label: "Warm evening", keyDir: [0.8, 0.35, 0.3], keyColor: [1, 0.72, 0.45], keyIntensity: 2.4, fillDir: [-0.5, 0.4, -0.3], fillIntensity: 0.35, skyTop: [0.2, 0.19, 0.28], skyHorizon: [0.78, 0.55, 0.4], ground: [0.38, 0.32, 0.29], exposure: 1.05 },
    { id: "night", label: "Gallery night", keyDir: [0.3, 0.9, 0.2], keyColor: [0.95, 0.95, 1], keyIntensity: 2.2, fillDir: [-0.7, 0.2, -0.4], fillIntensity: 0.25, skyTop: [0.05, 0.055, 0.07], skyHorizon: [0.14, 0.15, 0.17], ground: [0.12, 0.12, 0.13], exposure: 1.1 },
];

/** Floats in the shared Studio uniform (7 vec4). */
export const STUDIO_FLOATS = 28;

/**
 * `focus` is the camera's distance to what it orbits. The floor's horizon fade and the aerial
 * perspective scale with it, so a house framed from 40 m stays as crisp as a chair framed from 3 m.
 */
export function packStudio(l: StudioLighting, focus = 3): Float32Array {
    const norm = (v: [number, number, number]) => { const n = Math.hypot(...v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
    return new Float32Array([
        ...norm(l.keyDir), 0,
        ...l.keyColor, l.keyIntensity,
        ...norm(l.fillDir), l.fillIntensity,
        ...l.skyTop, 0,
        ...l.skyHorizon, 0,
        ...l.ground, 0,
        l.exposure, Math.max(1, focus / 6), 0, 0,
    ]);
}

/** Per-object uniform: rgb accent and how strongly to glow it (selection), followed by the object matrix. */
export const ITEM_FLOATS = 20;

export const MESHA_SHADER = /* wgsl */ `
struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0) var<uniform> camera: Camera;

struct Studio {
    key_dir: vec4<f32>,
    key_color: vec4<f32>,      // rgb, w = intensity
    fill_dir: vec4<f32>,       // xyz, w = intensity
    sky_top: vec4<f32>,
    sky_horizon: vec4<f32>,
    ground: vec4<f32>,
    params: vec4<f32>,         // x = exposure, y = distance scale (>= 1, grows with the framed focus distance)
};
@group(2) @binding(0) var<uniform> studio: Studio;

struct Item {
    highlight: vec4<f32>,      // rgb accent, w = strength
    model: mat4x4<f32>,
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
    // Uniform scale only; preserve the normal length carrying the pattern id.
    let world = item.model * vec4<f32>(in.position, 1.0);
    out.clip_position = camera.view_proj * world;
    out.world_pos = world.xyz;
    out.normal = normalize((item.model * vec4<f32>(in.normal, 0.0)).xyz) * length(in.normal);      // its length carries the surface pattern id
    out.uv = in.tex_coords;
    out.color = in.color;
    return out;
}

fn hash3(p: vec3<f32>) -> f32 {
    let q = fract(p * 0.3183099 + vec3<f32>(0.1, 0.2, 0.3)) * 17.0;
    return fract(q.x * q.y * q.z * (q.x + q.y + q.z));
}

fn vnoise(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(mix(hash3(i), hash3(i + vec3<f32>(1.0, 0.0, 0.0)), u.x), mix(hash3(i + vec3<f32>(0.0, 1.0, 0.0)), hash3(i + vec3<f32>(1.0, 1.0, 0.0)), u.x), u.y),
        mix(mix(hash3(i + vec3<f32>(0.0, 0.0, 1.0)), hash3(i + vec3<f32>(1.0, 0.0, 1.0)), u.x), mix(hash3(i + vec3<f32>(0.0, 1.0, 1.0)), hash3(i + vec3<f32>(1.0, 1.0, 1.0)), u.x), u.y),
        u.z);
}

fn fbm(p: vec3<f32>) -> f32 {
    return vnoise(p) * 0.55 + vnoise(p * 2.03) * 0.28 + vnoise(p * 4.1) * 0.17;
}

// The studio environment: what glossy and metal surfaces reflect, with a softbox up and to the side.
fn sky(d: vec3<f32>) -> vec3<f32> {
    if (d.y < 0.0) {
        let t = pow(1.0 + d.y, 4.0);
        return mix(studio.ground.rgb * 0.7, studio.sky_horizon.rgb, t);
    }
    let base = mix(studio.sky_horizon.rgb, studio.sky_top.rgb, pow(d.y, 0.6));
    let softbox = pow(max(dot(d, normalize(vec3<f32>(0.5, 0.75, 0.45))), 0.0), 24.0) * 3.0;
    let rim = pow(max(dot(d, normalize(vec3<f32>(-0.7, 0.4, -0.5))), 0.0), 16.0) * 0.8;
    return base + vec3<f32>(softbox + rim) * studio.key_color.rgb;
}

fn aces(x: vec3<f32>) -> vec3<f32> {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let raw = in.normal;
    let nlen = length(raw);
    let pattern = i32(round(nlen - 1.0));
    var n = raw / max(nlen, 0.0001);
    let v = normalize(camera.view_pos.xyz - in.world_pos);
    let p = in.world_pos;
    let dist = length(camera.view_pos.xyz - p);

    // --- The backdrop: a seamless studio sweep, darker overhead, meeting the floor's far color ---
    if (pattern == 7) {
        let d = normalize(p - camera.view_pos.xyz);
        let up = clamp(d.y, 0.0, 1.0);
        let col = mix(studio.sky_horizon.rgb, studio.sky_top.rgb, pow(up, 0.55));
        return vec4<f32>(pow(aces(col * studio.params.x), vec3<f32>(1.0 / 2.2)), 1.0);
    }

    // --- The floor: baked contact shadow in the vertex color, a grid fading into the horizon ---
    if (pattern == 6) {
        let shadow = in.color.a;
        var floor_col = studio.ground.rgb * (1.0 - 0.62 * shadow);
        let g = p.xz;
        let w = fwidth(g) * 1.2;
        let minor = abs(fract(g * 4.0 - 0.5) - 0.5) / max(w * 4.0, vec2<f32>(0.0001));
        let major = abs(fract(g - 0.5) - 0.5) / max(w, vec2<f32>(0.0001));
        let line_minor = 1.0 - clamp(min(minor.x, minor.y), 0.0, 1.0);
        let line_major = 1.0 - clamp(min(major.x, major.y), 0.0, 1.0);
        let fade = exp(-length(g) * 0.16);
        floor_col = floor_col * (1.0 - 0.05 * line_minor * fade - 0.1 * line_major * fade);
        // Fade to exactly the backdrop's horizon color well before the floor's edge.
        let horizon = smoothstep(4.0 * studio.params.y, 34.0 * studio.params.y, dist);
        let col = mix(floor_col * (0.78 + 0.22 * in.color.r), studio.sky_horizon.rgb, horizon);
        return vec4<f32>(pow(aces(col * studio.params.x), vec3<f32>(1.0 / 2.2)), 1.0);
    }

    if (dot(n, v) < 0.0) { n = -n; } // open shells shade from both sides
    var base = pow(in.color.rgb, vec3<f32>(2.2));
    let a = in.color.a;
    var metal = select(0.0, 1.0, a >= 0.5);
    var rough = clamp((a - metal * 0.5) / 0.49, 0.03, 1.0);
    var sheen = 0.0;
    var spec_scale = 1.0;
    var foliage = 0.0;       // leaves: soft wrap lighting and light through them from behind
    var crown_occ = 0.0;     // how deep in its crown a leaf sits (uv.y's whole part / 15)

    if (pattern == 1) {
        // Wood: long streaky grain, along X on flat faces and along Y on standing ones.
        let horizontal = abs(n.y) > 0.6;
        let q = select(vec3<f32>(p.x * 42.0, p.y * 2.0, p.z * 42.0), vec3<f32>(p.x * 2.2, p.y * 2.2, p.z * 48.0), horizontal);
        let rings = fract(fbm(q) * 5.0);
        let streak = smoothstep(0.0, 0.45, rings) * smoothstep(1.0, 0.55, rings);
        base = base * (0.8 + 0.28 * streak) * (0.92 + 0.12 * vnoise(p * 9.0));
        rough = clamp(rough + 0.08 * (1.0 - streak), 0.03, 1.0);
    } else if (pattern == 2) {
        // Fabric: soft mottling and a velvet-like sheen at grazing angles.
        base = base * (0.9 + 0.14 * fbm(p * 28.0));
        sheen = 0.35;
        spec_scale = 0.3;
    } else if (pattern == 3) {
        // Brushed metal: fine streaks break up the reflection.
        let streaks = vnoise(vec3<f32>(p.x * 3.0, p.y * 380.0, p.z * 3.0)) * 0.5 + vnoise(vec3<f32>(p.x * 380.0, p.y * 3.0, p.z * 3.0)) * 0.5;
        rough = clamp(rough + 0.12 * (streaks - 0.5), 0.03, 1.0);
        base = base * (0.94 + 0.1 * streaks);
    } else if (pattern == 4) {
        // Speckle: stone grains, leather pores, stoneware flecks.
        let s = vnoise(p * 70.0);
        let fleck = smoothstep(0.78, 0.9, s);
        base = mix(base * (0.9 + 0.18 * fbm(p * 7.0)), base * 0.45, fleck * 0.6);
    } else if (pattern == 8) {
        // Foliage: the vertex color already leans toward the tint per leaf; bases sit a little
        // deeper, and leaves buried in the crown are shaded by the leaves around them.
        crown_occ = clamp(floor(in.uv.y + 0.00001), 0.0, 15.0) / 15.0;
        let along = clamp(in.uv.x, 0.0, 1.0);
        base = base * (0.78 + 0.22 * smoothstep(0.0, 0.7, along)) * (0.9 + 0.18 * vnoise(p * 31.0));
        foliage = 1.0;
        spec_scale = 0.15;
    } else if (pattern == 9) {
        // Bark: furrows running along the branch (uv.x is meters around it, uv.y meters along).
        let q = vec3<f32>(in.uv.x * 9.0, in.uv.y * 1.3, 0.37);
        let warp = fbm(q * vec3<f32>(0.5, 0.6, 1.0)) * 1.6;
        let f = fbm(vec3<f32>(q.x + warp, q.y * 0.9, 1.7));
        let ridge = 1.0 - abs(f * 2.0 - 1.0);
        base = base * (0.48 + 0.72 * smoothstep(0.35, 0.9, ridge)) * (0.9 + 0.2 * vnoise(p * 40.0));
        rough = clamp(rough + 0.1, 0.03, 1.0);
    } else if (pattern == 10) {
        // Birch: chalky white with dark horizontal lenticels and patches.
        let dash = smoothstep(0.68, 0.8, vnoise(vec3<f32>(in.uv.x * 7.0, in.uv.y * 34.0, 3.1)));
        let blotch = smoothstep(0.66, 0.82, fbm(vec3<f32>(in.uv.x * 3.0, in.uv.y * 2.2, 8.3)));
        base = mix(base * (0.92 + 0.1 * vnoise(p * 25.0)), vec3<f32>(0.035, 0.03, 0.028), max(dash * 0.9, blotch * 0.85));
    } else if (pattern == 12 || pattern == 14) {
        // Corrugated sheet: ribs across the face (down the slope on a roof), shaded by bending the
        // normal, faded out where they get finer than a pixel.
        var t = vec3<f32>(1.0, 0.0, 0.0);
        if (abs(n.y) < 0.85) { t = normalize(cross(n, vec3<f32>(0.0, 1.0, 0.0))); }
        let s = dot(p, t) * 82.0;
        let fade = clamp(1.4 - fwidth(s) * 0.45, 0.0, 1.0);
        n = normalize(n + t * sin(s) * 0.42 * fade);
        base = base * (0.93 + 0.07 * cos(s) * fade);
    } else if (pattern == 15) {
        // Hull panels: dark seams on a 1.2 x 0.8 m grid across the face, each panel a touch different.
        var u = p.x;
        var w = p.z;
        if (abs(n.y) < 0.7) { u = dot(p, normalize(cross(n, vec3<f32>(0.0, 1.0, 0.0)))); w = p.y; }
        let g = vec2<f32>(u / 1.2, w / 0.8);
        let e = min(fract(g), 1.0 - fract(g)) * vec2<f32>(1.2, 0.8);
        let fw = max(fwidth(g) * vec2<f32>(1.2, 0.8), vec2<f32>(0.0001));
        let seam = 1.0 - clamp(min(e.x / (fw.x + 0.006), e.y / (fw.y + 0.006)), 0.0, 1.0);
        base = base * (0.96 + 0.08 * hash3(vec3<f32>(floor(g), 0.5))) * (1.0 - 0.5 * seam);
    }
    if (pattern == 13 || pattern == 14) {
        // Rust: fine blotches, streaks running down from edges, heavier near the ground.
        let blot = fbm(p * 2.6 + vec3<f32>(3.1, 0.0, 1.7)) * 0.7 + vnoise(p * 9.0) * 0.3;
        let streak = vnoise(vec3<f32>(p.x * 11.0 + p.z * 11.0, p.y * 0.7, 2.3));
        let low = 1.0 - smoothstep(0.0, 1.2, p.y);
        let amount = clamp(smoothstep(0.5, 0.75, blot) * 0.8 + smoothstep(0.55, 0.9, streak) * 0.45 + low * 0.2, 0.0, 0.85);
        let rust = mix(vec3<f32>(0.13, 0.045, 0.02), vec3<f32>(0.3, 0.11, 0.035), vnoise(p * 17.0));
        base = mix(base, rust, amount);
        rough = clamp(mix(rough, 0.9, amount), 0.03, 1.0);
        metal = metal * (1.0 - amount);
    }

    let key = normalize(studio.key_dir.xyz);
    let fill = normalize(studio.fill_dir.xyz);
    let ndl = max(dot(n, key), 0.0);
    let ndf = max(dot(n, fill), 0.0);
    let nv = max(dot(n, v), 0.0);
    let hemi = mix(studio.ground.rgb, studio.sky_top.rgb * 1.4 + studio.sky_horizon.rgb * 0.4, n.y * 0.5 + 0.5);
    // A little floor occlusion so feet and undersides settle into the ground.
    // Smoothstep, not a clamped ramp: a ramp's end leaves a visible brightness line.
    let occ = 0.6 + 0.4 * smoothstep(0.0, 0.45, p.y);
    // Leaves wrap light around a little (they are thin and scatter it).
    let wrap = mix(ndl, max((dot(n, key) + 0.35) / 1.35, 0.0), foliage);
    let crown = 1.0 - 0.62 * crown_occ;
    let key_light = studio.key_color.rgb * studio.key_color.w * wrap * mix(1.0, crown * crown, foliage);
    let diffuse_light = key_light * 0.5 + studio.key_color.rgb * studio.fill_dir.w * ndf * 0.5 + hemi * 0.55 * occ * mix(1.0, crown, foliage);

    let h = normalize(key + v);
    let shininess = 2.0 / (rough * rough * rough + 0.001);
    let spec = ((shininess + 8.0) / 25.0) * pow(max(dot(n, h), 0.0), min(shininess, 4000.0)) * ndl;
    let fresnel = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
    let r = reflect(-v, n);
    let env = sky(r);
    let f0 = mix(vec3<f32>(0.04), base, metal);
    let reflectance = mix(vec3<f32>(fresnel * (1.0 - rough) * (1.0 - rough) * 0.8), f0 + (1.0 - f0) * fresnel * (1.0 - rough), metal);
    var col = base * (1.0 - metal) * diffuse_light
        + env * reflectance * occ * mix(1.0, crown * 0.3, foliage) * (0.35 + 0.65 * (1.0 - rough))
        + studio.key_color.rgb * spec * mix(vec3<f32>(0.05 + 0.3 * fresnel), f0, metal) * spec_scale;
    col = col + base * sheen * pow(1.0 - nv, 3.0) * (hemi + key_light * 0.3);
    // Light through a leaf lit from behind: a warm, saturated glow.
    let through = pow(max(dot(-n, key), 0.0), 1.5) * (0.35 + 0.65 * pow(max(dot(-v, key), 0.0), 2.0));
    col = col + foliage * base * vec3<f32>(1.0, 1.12, 0.62) * studio.key_color.rgb * studio.key_color.w * through * 0.5 * crown;

    if (pattern == 5) {
        // Glass: tinted body, strong fresnel reflections, a bright caustic-ish glint through it.
        let body = base * (0.35 + 0.45 * pow(nv, 0.5)) * (hemi + key_light * 0.25);
        col = body + env * (0.08 + fresnel * 1.1) + studio.key_color.rgb * spec * 1.2;
    }

    if (pattern == 11) {
        // Self-lit: light strips, crystals and lit windows glow whatever the key light does.
        col = base * 2.4 + env * fresnel * 0.3;
    }

    // Selection: a thin accent rim on the silhouette only.
    let rim = pow(1.0 - nv, 5.0) * item.highlight.w;
    col = col + item.highlight.rgb * rim;

    // Aerial perspective toward the horizon color for very distant things.
    col = mix(col, studio.sky_horizon.rgb, smoothstep(6.0 * studio.params.y, 40.0 * studio.params.y, dist) * 0.8);
    return vec4<f32>(pow(aces(col * studio.params.x), vec3<f32>(1.0 / 2.2)), 1.0);
}
`;
