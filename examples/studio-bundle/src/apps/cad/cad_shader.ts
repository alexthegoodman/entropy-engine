// The CAD viewport's look, shared by every CAD app: a dark instrument-panel space where geometry
// reads as light. Two shaders:
//
//  * SURFACE - bodies (machined, holographic, zebra-striped or curvature-mapped), the grid planes
//    (the floor, the sketch plane), sketch region fills and the backdrop dome. What a mesh is comes
//    from its Item uniform, so one pipeline pair (opaque, see-through) draws them all.
//  * LINES - body edges and sketch curves as ribbons widened on screen (see Entropy.Cad.spawnLines
//    for the vertex layout), so a line is the same crisp width at any zoom.
//
// Geometry arrives in document units; `scene.unit` scales it to the world.

/** Floats in the Scene uniform (4 vec4). */
export const SCENE_FLOATS = 16;
/** Floats in an Item uniform (3 vec4). */
export const ITEM_FLOATS = 12;

export type ViewMode = "solid" | "holo" | "zebra" | "curvature";
export const VIEW_MODES: { id: ViewMode; label: string; hint: string }[] = [
    { id: "solid", label: "Solid", hint: "Machined surfaces with lit edges" },
    { id: "holo", label: "Holo", hint: "See-through light: look inside the form" },
    { id: "zebra", label: "Zebra", hint: "Reflection stripes: a kink in a stripe is a kink in the surface" },
    { id: "curvature", label: "Curvature", hint: "Colour by how tightly the surface bends" },
];

export const ITEM_KIND = { body: 0, grid: 1, backdrop: 2, fill: 3 } as const;

export interface SceneUniform {
    viewport: [number, number];
    time: number;
    /** World units per document unit. */
    unit: number;
    mode: ViewMode;
    /** Camera distance to what it orbits (world units): fades and haze scale with it. */
    focus: number;
    accent: [number, number, number];
    keyDir: [number, number, number];
}

export function packScene(s: SceneUniform): Float32Array {
    const n = Math.hypot(...s.keyDir) || 1;
    return new Float32Array([
        s.viewport[0], s.viewport[1], s.time, 0,
        s.unit, VIEW_MODES.findIndex(m => m.id === s.mode), s.focus, 0,
        s.accent[0], s.accent[1], s.accent[2], 1,
        s.keyDir[0] / n, s.keyDir[1] / n, s.keyDir[2] / n, 0,
    ]);
}

export interface ItemUniform {
    kind: number;
    tint: [number, number, number];
    /** Bodies: selection glow 0..1. Lines: nothing. */
    glow?: number;
    opacity?: number;
    /** Bodies: the face index to light up, or -1. */
    face?: number;
    /** Bodies: drawn as faint light whatever the view mode (while a sketch is being drawn through them). */
    ghost?: boolean;
    /** Grids: spacing of the fine lines, and the radius they fade out at (document units). */
    step?: number;
    reach?: number;
}

export function packItem(i: ItemUniform): Float32Array {
    return new Float32Array([
        i.tint[0], i.tint[1], i.tint[2], i.glow ?? 0,
        i.face ?? -1, i.kind, i.opacity ?? 1, i.step ?? 10,
        i.reach ?? 1000, i.ghost ? 1 : 0, 0, 0,
    ]);
}

const COMMON = /* wgsl */ `
struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0) var<uniform> camera: Camera;

struct Scene {
    viewport: vec4<f32>,   // width, height, time
    params: vec4<f32>,     // x unit (world per document unit), y view mode, z focus distance
    accent: vec4<f32>,
    key_dir: vec4<f32>,
};
@group(2) @binding(0) var<uniform> scene: Scene;

struct Item {
    tint: vec4<f32>,       // rgb, w = selection glow
    params: vec4<f32>,     // x highlighted face, y kind, z opacity, w grid step
    extra: vec4<f32>,      // x grid reach, y ghost
};
@group(2) @binding(1) var<uniform> item: Item;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
};
`;

export const CAD_SURFACE_SHADER = COMMON + /* wgsl */ `
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
    var world = in.position * scene.params.x;
    // The backdrop is a dome that travels with the camera.
    if (item.params.y > 1.5 && item.params.y < 2.5) { world = in.position + camera.view_pos.xyz; }
    out.clip_position = camera.view_proj * vec4<f32>(world, 1.0);
    out.world_pos = world;
    out.normal = in.normal;
    out.uv = in.tex_coords;
    out.color = in.color;
    return out;
}

fn hash2(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

// One set of grid lines with a spacing of 'step', antialiased by how fast 'p' changes on screen.
fn grid_lines(p: vec2<f32>, spacing: f32, width: f32) -> f32 {
    let q = p / spacing;
    let w = max(fwidth(q), vec2<f32>(1e-6));
    let d = abs(fract(q - 0.5) - 0.5) / w;
    let ink = 1.0 - min(min(d.x, d.y) / width, 1.0);
    // Lines finer than a pixel fade out instead of shimmering.
    return ink * clamp(1.5 - max(w.x, w.y) * 2.0, 0.0, 1.0);
}

fn tonemap(c: vec3<f32>) -> vec3<f32> {
    return c / (c + vec3<f32>(0.85)) * 1.6;
}

fn shade_body(in: VertexOutput, facing: bool) -> vec4<f32> {
    var n = normalize(in.normal);
    if (!facing) { n = -n; }
    let v = normalize(camera.view_pos.xyz - in.world_pos);
    let l = normalize(scene.key_dir.xyz);
    let accent = scene.accent.rgb;
    let mode = scene.params.y;
    let ndv = clamp(dot(n, v), 0.0, 1.0);
    let rim = pow(1.0 - ndv, 3.0);
    let picked = abs(in.uv.x - item.params.x) < 0.5;
    let glow = item.tint.w;

    if (item.extra.y > 0.5) {
        // A ghost: just enough light to place a sketch against.
        return vec4<f32>(mix(item.tint.rgb, accent, 0.6) * (0.4 + rim), (0.05 + rim * 0.4) * item.params.z);
    }
    if (mode > 0.5 && mode < 1.5) {
        // Holo: mostly rim light, with slow scan lines drifting up through the form.
        let scan = 0.5 + 0.5 * sin(in.world_pos.y * 90.0 / max(scene.params.z, 0.3) - scene.viewport.z * 1.6);
        var a = 0.08 + rim * 0.75 + scan * 0.05 + glow * 0.12;
        var c = mix(item.tint.rgb, accent, 0.65) * (0.55 + rim * 1.6 + scan * 0.2);
        if (picked) { c = c + accent * 0.8; a = a + 0.25; }
        return vec4<f32>(c, clamp(a, 0.0, 0.95) * item.params.z);
    }
    if (mode > 1.5 && mode < 2.5) {
        // Zebra: stripes of a striped room, mirrored in the surface.
        let r = reflect(-v, n);
        let band = r.y * 9.0 + r.x * 2.0;
        let w = fwidth(band);
        let stripe = smoothstep(0.5 - w, 0.5 + w, abs(fract(band) - 0.5) * 2.0);
        var c = mix(vec3<f32>(0.02, 0.03, 0.04), vec3<f32>(0.9, 0.95, 1.0), stripe) * (0.55 + 0.45 * ndv);
        if (picked) { c = mix(c, accent, 0.5); }
        return vec4<f32>(c + accent * rim * 0.25 * glow, 1.0);
    }
    if (mode > 2.5) {
        // Curvature: how fast the normal turns across the surface, flat (deep blue) to tight (hot).
        // Scaled by the viewing distance, so the colours mean "tight for its size" at any zoom.
        let k = length(fwidth(n)) / max(length(fwidth(in.world_pos)), 1e-7) * scene.params.z * 0.05;
        let t = k / (1.0 + k);
        let cold = vec3<f32>(0.03, 0.10, 0.28);
        let mid = vec3<f32>(0.05, 0.75, 0.70);
        let hot = vec3<f32>(1.0, 0.55, 0.12);
        var c = mix(mix(cold, mid, smoothstep(0.0, 0.45, t)), hot, smoothstep(0.45, 1.0, t)) * (0.45 + 0.55 * ndv);
        if (picked) { c = mix(c, vec3<f32>(1.0), 0.35); }
        return vec4<f32>(c, 1.0);
    }

    // Solid: dark machined metal under a cool key light, a warm bounce from below, and a rim of
    // the accent colour so silhouettes read against the dark room.
    let base = item.tint.rgb;
    let h = normalize(l + v);
    let diffuse = max(dot(n, l), 0.0);
    let wrap = 0.5 + 0.5 * dot(n, l);
    let sky = mix(vec3<f32>(0.10, 0.075, 0.06), vec3<f32>(0.20, 0.27, 0.34), 0.5 + 0.5 * n.y);
    let r = reflect(-v, n);
    // A soft-box strip overhead, reflected: enough to show how a surface flows.
    let strip = smoothstep(0.6, 0.95, r.y) * 0.3;
    let spec = pow(max(dot(n, h), 0.0), 48.0) * 0.35;
    var c = base * (sky * 1.5 + vec3<f32>(0.95, 0.98, 1.0) * (diffuse * 0.85 + wrap * 0.18));
    c = c + vec3<f32>(0.75, 0.9, 1.0) * (spec + strip * (0.25 + 0.75 * rim));
    c = c + accent * rim * (0.35 + glow * 0.9);
    if (picked) { c = mix(c, accent, 0.45) + accent * 0.15; }
    return vec4<f32>(tonemap(c), 1.0);
}

fn shade_grid(in: VertexOutput) -> vec4<f32> {
    // uv carries the plane's own coordinates in document units.
    let p = in.uv;
    let spacing = item.params.w;
    let reach = item.extra.x;
    let fine = grid_lines(p, spacing, 1.0);
    let coarse = grid_lines(p, spacing * 10.0, 1.4);
    // The plane's own axes, brighter.
    let w = max(fwidth(p), vec2<f32>(1e-6));
    let axis = max(1.0 - abs(p.x) / (w.x * 1.2), 1.0 - abs(p.y) / (w.y * 1.2));
    let fade = 1.0 - smoothstep(reach * 0.35, reach, length(p));
    let a = (fine * 0.14 + coarse * 0.3 + clamp(axis, 0.0, 1.0) * 0.38) * fade * item.params.z;
    let c = mix(item.tint.rgb, scene.accent.rgb, clamp(axis, 0.0, 1.0) * 0.6 + coarse * 0.25);
    return vec4<f32>(c, a);
}

fn shade_backdrop(in: VertexOutput) -> vec4<f32> {
    let d = normalize(in.world_pos - camera.view_pos.xyz);
    let up = d.y;
    // A dark room: black overhead, a faint band of light at the horizon. (Colours are linear:
    // the display curve lifts these a long way.)
    let horizon = exp(-abs(up) * 6.0);
    var c = mix(vec3<f32>(0.002, 0.003, 0.005), vec3<f32>(0.006, 0.0095, 0.015), smoothstep(-0.3, 0.7, up));
    c = c + mix(item.tint.rgb, scene.accent.rgb, 0.5) * horizon * 0.03;
    // Fine grain so the gradient doesn't band.
    c = c + (hash2(in.clip_position.xy) - 0.5) * 0.0008;
    return vec4<f32>(c, 1.0);
}

fn shade_fill(in: VertexOutput) -> vec4<f32> {
    // A closed region: a wash of colour with fine diagonal hatching, like a section on a drawing.
    let hatch = smoothstep(0.35, 0.5, abs(fract((in.clip_position.x + in.clip_position.y) / 9.0) - 0.5));
    return vec4<f32>(in.color.rgb, in.color.a * (0.55 + 0.45 * hatch) * item.params.z);
}

@fragment
fn fs_main(in: VertexOutput, @builtin(front_facing) facing: bool) -> @location(0) vec4<f32> {
    let kind = item.params.y;
    if (kind < 0.5) { return shade_body(in, facing); }
    if (kind < 1.5) { return shade_grid(in); }
    if (kind < 2.5) { return shade_backdrop(in); }
    return shade_fill(in);
}
`;

export const CAD_LINE_SHADER = COMMON + /* wgsl */ `
struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) color: vec4<f32>,
    // x: signed distance from the centre line in pixels; y: half width; z: dashed; w: unused
    @location(1) edge: vec4<f32>,
    @location(2) dir: vec2<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let unit = scene.params.x;
    let eye = camera.view_pos.xyz;
    // Pulled a hair toward the eye so a line on a surface wins over the surface.
    let pull = 0.004;
    var own = in.position * unit;
    var other = in.normal * unit;
    own = own + (eye - own) * pull;
    other = other + (eye - other) * pull;
    let c0 = camera.view_proj * vec4<f32>(own, 1.0);
    let c1 = camera.view_proj * vec4<f32>(other, 1.0);
    let size = scene.viewport.xy;
    // Screen direction toward the other end, valid even when that end is behind the eye.
    var d = (c1.xy * c0.w - c0.xy * c1.w) * size;
    let is_end = (in.tex_coords.y - 2.0 * floor(in.tex_coords.y * 0.5)) > 0.5;
    if (is_end) { d = -d; }
    let len = length(d);
    if (len > 1e-9) { d = d / len; } else { d = vec2<f32>(1.0, 0.0); }
    let hw = abs(in.tex_coords.x) * 0.5 + 1.0;
    let side = sign(in.tex_coords.x);
    let n = vec2<f32>(-d.y, d.x);
    // Square caps: each end reaches half a width past its point, which also closes the joints.
    var along = -1.0;
    if (is_end) { along = 1.0; }
    let offset = (n * side * hw + d * along * (hw - 1.0)) / size * 2.0;
    out.clip_position = vec4<f32>(c0.xy + offset * c0.w, c0.z, c0.w);
    out.color = in.color * vec4<f32>(item.tint.rgb, item.params.z);
    out.edge = vec4<f32>(side * hw, hw - 1.0, floor(in.tex_coords.y * 0.5), 0.0);
    out.dir = d;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let dist = abs(in.edge.x);
    var a = 1.0 - smoothstep(in.edge.y - 0.5, in.edge.y + 0.6, dist);
    // A faint halo beyond the core makes lines glow without a blur pass.
    a = a + (1.0 - smoothstep(0.0, in.edge.y + 1.0, dist)) * 0.18;
    if (in.edge.z > 0.5) {
        // Dashes measured in screen space along the line: steady however the curve is segmented.
        let t = fract(dot(in.clip_position.xy, in.dir) / 11.0);
        a = a * smoothstep(0.42, 0.5, abs(t - 0.5) * 2.0 + 0.2);
    }
    return vec4<f32>(in.color.rgb, clamp(a, 0.0, 1.0) * in.color.a);
}
`;
