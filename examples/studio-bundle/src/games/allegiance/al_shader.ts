// Allegiance draws with QuadPlanet's shader (terrain, sky, atmosphere, cities: qp_shader.ts) plus
// people. This injects clothing, body and per-person skin/hair materials into it:
//
// - 12: clothing, top  - colored by the item's tint.rgb (party armbands and uniforms recolor
//       without rebuilding the mesh);
// - 13: clothing, bottom - colored by the item's tex_origin.xyz;
// - 14: eyes, lips, shoes, gear - the vertex color;
// - 15/16: skin/hair - separate per-person colors, without new geometry.
//
// People are animated in the vertex shader: uv.y's integer part says which limb a vertex
// belongs to (0 rigid, 1/2 left/right leg, 3/4 left/right arm). Legs swing about the hip and
// arms about the shoulder by sin(phase) * amplitude, with phase = |tex_origin.w| and amplitude
// tint.w; uv.y's fractional part / 0.49 blends the limb into the torso. A negative
// tex_origin.w raises the arms to aim a weapon.
//
// People are instanced (al_crowd.ts): the people shader reads its Item and colors from a
// storage-buffer record per instance, by @builtin(instance_index), instead of a uniform per
// person. The vertex stage passes the index on (flat) so the fragment stage reads the same one.
//
// - 17: foliage (al_scatter.ts packFoliage): painted like 11, bent by the wind in the vertex
//       stage (uv.y's fraction is how far, in meters, the vertex bends in a full gust; an integer
//       part of 1 marks a leaf, which also flutters and lets the sun through from behind).
//
// Sun shadows (core/addon_sun_shadows.rs): every Allegiance pipeline is created with
// `sunShadows` (the terrain's receives only). vs_shadow draws what casts into the cascades - not
// the ground, water, roads, glass, glowing things or sky, and not the first-person weapon at the
// eye - and the receiver group (group 3, after the item group) shades every surface by PCF over
// the cascade it falls in, with the cloud shadows on top (al_sky.ts places the cascades).

import { QUADPLANET_SHADER, instancedShader } from "../../apps/quadplanet/qp_shader";

export const MAT_CLOTH_TOP = 12;
export const MAT_CLOTH_BOTTOM = 13;
export const MAT_BODY = 14;
export const MAT_SKIN = 15;
export const MAT_HAIR = 16;

export const MAT_FOLIAGE = 17;

export const HIP = 0.92;
export const SHOULDER = 1.42;

function inject(src: string, anchor: string, replacement: string): string {
    if (!src.includes(anchor)) throw new Error(`Allegiance shader: QuadPlanet shader anchor not found: ${anchor}`);
    return src.replace(anchor, replacement);
}

function build(people: boolean): string {
    let s = QUADPLANET_SHADER;
    s = inject(s, "        var pos = in.position;\n", `        var pos = in.position;
        var nrm = in.normal;
        if (material >= 12 && material <= 16) {
            // People: swing the limbs about the hip / shoulder (see al_shader.ts).
            let limb = i32(floor(in.tex_coords.y + 0.0005));
            if (limb > 0) {
                let weight = clamp(fract(in.tex_coords.y) / 0.49, 0.0, 1.0);
                let phase = abs(item.tex_origin.w);
                let aiming = item.tex_origin.w < 0.0;
                let side = select(-1.0, 1.0, limb == 1 || limb == 3);
                var ang = sin(phase) * item.tint.w * side;
                var pivot = vec3<f32>(0.0, ${HIP}, 0.0);
                if (limb >= 3) {
                    pivot = vec3<f32>(0.0, ${SHOULDER}, 0.0);
                    ang = -ang * 0.8;
                    if (aiming) { ang = select(1.15, 1.5, limb == 4); }
                }
                ang = ang * weight;
                let c = cos(ang);
                let sn = sin(ang);
                let q = pos - pivot;
                pos = pivot + vec3<f32>(q.x, q.y * c - q.z * sn, q.y * sn + q.z * c);
                nrm = vec3<f32>(nrm.x, nrm.y * c - nrm.z * sn, nrm.y * sn + nrm.z * c);
            }
        }
`);
    s = inject(s, "        out.normal = (item.model * vec4<f32>(in.normal, 0.0)).xyz;", "        out.normal = (item.model * vec4<f32>(nrm, 0.0)).xyz;");
    s = inject(s, "        let w = item.model * vec4<f32>(pos, 1.0);\n", `        var w = item.model * vec4<f32>(pos, 1.0);
        if (material == ${MAT_FOLIAGE}) { w = vec4<f32>(w.xyz + foliage_sway(in.tex_coords.y, pos), 1.0); }
`);
    s = inject(s, "        if (material == 3 || material == 6 || material == 11) { base = base * item.tint.rgb; }",
        `        if (material == 3 || material == 6 || material == 11) { base = base * item.tint.rgb; }
        if (material == ${MAT_FOLIAGE}) { base = base * item.tint.rgb; }
        if (material == 12) { base = base * linear(item.tint.rgb); }
        if (material == 13) { base = base * linear(item.tex_origin.xyz); }
        ${people ? `if (material == 15) { base = base * linear(person_colors.skin.rgb); }
        if (material == 16) { base = base * linear(person_colors.hair.rgb); }` : ""}`);
    s = inject(s, "        if (material == 3) { spec = 0.35; shin = 48.0; }",
        `        if (material == 3) { spec = 0.35; shin = 48.0; }
        if (material >= 12 && material <= 16) { spec = 0.1; shin = 18.0; }
        if (material == ${MAT_FOLIAGE}) {
            // Leaves: a waxy sheen, lit from either side.
            spec = 0.16; shin = 30.0;
            if (dot(n, v) < 0.0) { n = -n; }
        }`);
    s = inject(s, "        if (material == 3 || material == 6 || material == 8 || material == 11) { col = col + base * 0.14 * max(dot(n, v), 0.0); }",
        `        if (material == 3 || material == 6 || material == 8 || material == 11 || (material >= 12 && material <= 16)) { col = col + base * 0.18 * max(dot(n, v), 0.0); }
        if (material == ${MAT_FOLIAGE}) {
            // Sun through the leaves: bright yellow-green where you look toward the sun past them.
            let leaf = select(0.35, 1.0, in.uv.y >= 1.0);
            let through = pow(max(dot(-v, sun), 0.0), 4.0) * 0.9 + max(dot(-n, sun), 0.0) * 0.4;
            col = col + base * vec3<f32>(1.15, 1.3, 0.55) * world.sun_color.rgb * through * leaf * sun_vis * smoothstep(-0.12, 0.2, dot(up, sun));
            col = col + base * 0.1 * max(dot(n, v), 0.0);
        }`);
    s = inject(s, "// --- Texture noise ---", `${FOLIAGE_WGSL}
// --- Texture noise ---`);
    s = inject(s, `// How much direct sun reaches a surface point (1 = all): cloud shadows here; games add cast
// shadows (al_shader.ts).
fn sun_visibility(p: vec3<f32>, n: vec3<f32>, view_w: f32, i: i32) -> f32 {
    return cloud_shadow(p, normalize(world.sun_dir.xyz), i);
}`, SHADOW_WGSL);
    // Shade: with real shadows, much of the street is lit by the sky alone, so the sky's light is
    // a broad, paler fill (whiter under cloud) plus sunlight bounced up from the lit ground onto
    // walls and undersides; without it shadows read as navy holes.
    s = inject(s, `        // Sky light from above (colored by the atmosphere by day) and a little starlight at night.
        let sky_amb = atmo * (0.22 + 0.18 * max(dot(n, up), 0.0)) * day + vec3<f32>(0.012, 0.014, 0.02);`,
        `        // Sky light (Allegiance): a paler fill than QuadPlanet's, and bounce from the sunlit ground.
        let sky_tone = mix(atmo, vec3<f32>(dot(atmo, vec3<f32>(0.3, 0.5, 0.2))), 0.55 + 0.35 * world.cloud.w);
        let bounce = world.sun_color.rgb * 0.09 * clamp(0.55 - 0.45 * dot(n, up), 0.0, 1.0) * smoothstep(-0.12, 0.2, dot(up, sun));
        let sky_amb = (sky_tone * (0.3 + 0.22 * max(dot(n, up), 0.0)) + bounce) * day + vec3<f32>(0.012, 0.014, 0.02);`);
    s += CASTER_WGSL;
    if (people) s = instancedShader(s, {
        recordType: "PersonRecord",
        declarations: `struct PersonColors {
    skin: vec4<f32>,
    hair: vec4<f32>,
};
// One per instance: al_crowd.ts PERSON_FLOATS.
struct PersonRecord {
    model: mat4x4<f32>,
    tint: vec4<f32>,
    tex_origin: vec4<f32>,
    skin: vec4<f32>,
    hair: vec4<f32>,
};
var<private> person_colors: PersonColors;`,
        load: `let r = instances[i];
    item = Item(r.model, r.tint, r.tex_origin);
    person_colors = PersonColors(r.skin, r.hair);`,
    });
    return s;
}

// Wind (world.wind: velocity in render space, m/s) bends a plant over and back in gusts; the
// phase comes from where the plant stands on the street (tex_origin.xz, al_scatter placement),
// so a rebase of the render origin does not jolt it.
const FOLIAGE_WGSL = /* wgsl */ `
fn foliage_sway(code: f32, local: vec3<f32>) -> vec3<f32> {
    let speed = length(world.wind.xyz);
    if (speed < 0.01) { return vec3<f32>(0.0); }
    let dir = world.wind.xyz / speed;
    let bend = fract(code);
    let leaf = code >= 1.0;
    let t = world.sun_dir.w;
    let ph = dot(item.tex_origin.xz, vec2<f32>(0.37, 0.23));
    let strength = clamp(speed / 7.0, 0.0, 1.6);
    // Gusts roll across the street; between them the plant leans a little and sways.
    let gust = 0.55 + 0.45 * sin(t * 0.55 - ph * 0.6) * sin(t * 0.21 + ph * 0.3);
    let sway = 0.45 + 0.55 * sin(t * 1.7 + ph) * (0.7 + 0.3 * sin(t * 2.9 + ph * 1.7));
    var d = dir * bend * strength * (0.35 * gust + 0.4 * sway * gust);
    // Bending over brings the top down a little.
    let up = normalize(item.model[1].xyz);
    d = d - up * dot(d, d) * 0.35 / max(bend + 0.3, 0.3);
    if (leaf) {
        let q = local * 3.1 + vec3<f32>(ph);
        d = d + vec3<f32>(sin(t * 7.3 + q.x), sin(t * 9.1 + q.y), sin(t * 8.2 + q.z)) * 0.025 * strength * (0.5 + gust);
    }
    return d;
}
`;

// Cascaded sun shadows: PCF over the cascade a point falls in, blended into the next one near
// its edge. Bias: the point is pushed out along its normal by a texel and a half, and the
// compare depth pulled toward the light by a texel (params.w converts meters to depth).
const SHADOW_WGSL = /* wgsl */ `
struct SunShadow {
    cascades: array<mat4x4<f32>, 4>,
    texel: vec4<f32>,
    params: vec4<f32>,         // x = cascades, y = map size, z = strength, w = depth per meter
};
@group(3) @binding(0) var shadow_maps: texture_depth_2d_array;
@group(3) @binding(1) var shadow_sampler: sampler_comparison;
@group(3) @binding(2) var<uniform> sun_shadow: SunShadow;

// Lit share (0..1) of point p in cascade k; edge = how far inside the cascade it is (uv units),
// negative when outside.
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
        // The outer tenth of a cascade blends into the next (or, for the last, into full sun).
        let blend = smoothstep(0.0, 0.1, a.edge);
        if (blend >= 1.0) { return a.lit; }
        var next = 1.0;
        if (k + 1 < count) {
            let b = cascade_lookup(p, n, k + 1);
            if (b.edge >= 0.0) { next = b.lit; }
        }
        return mix(next, a.lit, blend);
    }
    return 1.0;
}

fn sun_visibility(p: vec3<f32>, n: vec3<f32>, view_w: f32, i: i32) -> f32 {
    let clouds = cloud_shadow(p, normalize(world.sun_dir.xyz), i);
    if (sun_shadow.params.x < 0.5 || view_w < 0.0) { return clouds; }
    return clouds * mix(1.0, cast_shadow(p, normalize(n)), sun_shadow.params.z);
}
`;

// The shadow caster's vertex stage: the same vertex (pose, wind, folding) as vs_main, through the
// cascade's light matrix (camera.view_proj in the cascade's copy of the camera uniform).
const CASTER_WGSL = /* wgsl */ `
@vertex
fn vs_shadow(in: VertexInput) -> @builtin(position) vec4<f32> {
    let o = vertex_common(in);
    let material = i32(floor(in.tex_coords.x + 0.0005));
    let at_eye = length(item.model[3].xyz - camera.view_pos.xyz) < 0.75;
    // Ground, water, ice, glass, glowing things (lamps, the HQ's light beam), the sky and roads cast nothing.
    if (material <= 2 || material == 4 || material == 5 || material == 7 || material == 9 || material == 10 || o.view_w < 0.0 || at_eye) {
        return vec4<f32>(0.0, 0.0, 2.0, 1.0);
    }
    return camera.view_proj * vec4<f32>(o.world_pos, 1.0);
}
`;

export const ALLEGIANCE_SHADER = build(false);
/** ALLEGIANCE_SHADER for instanced batches of Items (houses: qp_city.ts). */
export const ALLEGIANCE_INSTANCED_SHADER = instancedShader(ALLEGIANCE_SHADER);
export const PEOPLE_SHADER = build(true);
