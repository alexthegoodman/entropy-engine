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
// - 18/19: fire and smoke (al_fx.ts): see MAT_FIRE / MAT_SMOKE.
//
// Broken building pieces (al_destruction.ts) are unit boxes in the house material stretched to
// size; their record's tex_origin.w is -1, so their procedural surface (brick, render...) is laid
// out in meters on the piece as drawn rather than on the unit box.
//
// Sun shadows (core/addon_sun_shadows.rs): every Allegiance pipeline is created with
// `sunShadows` (the terrain's receives only). vs_shadow draws what casts into the cascades - not
// the ground, water, roads, glass, glowing things or sky, and not the first-person weapon at the
// eye - and the receiver group (group 3, after the item group) shades every surface by PCF over
// the cascade it falls in, with the cloud shadows on top (al_sky.ts places the cascades).

import { QUADPLANET_SHADER, instancedShader } from "../../apps/quadplanet/qp_shader";
import { materialWgsl, GROUND } from "./al_materials";
import { CLOUD_CACHE_WGSL } from "./al_clouds";
import { TERRITORY_WGSL } from "./al_territory";

export const MAT_CLOTH_TOP = 12;
export const MAT_CLOTH_BOTTOM = 13;
export const MAT_BODY = 14;
export const MAT_SKIN = 15;
export const MAT_HAIR = 16;

export const MAT_FOLIAGE = 17;
/** Fire (al_fx.ts): flames, fireballs and sparks. Self-lit: vertex color x tint.rgb, brightness
 * tint.w, flickering; fades out by ordered dither below tex_origin.w (opacity). Casts nothing. */
export const MAT_FIRE = 18;
/** Smoke and dust (al_fx.ts): lit, colored by tint.rgb, faded by dither like fire. Casts nothing. */
export const MAT_SMOKE = 19;

export const HIP = 0.92;
export const SHOULDER = 1.42;

function inject(src: string, anchor: string, replacement: string): string {
    if (!src.includes(anchor)) throw new Error(`Allegiance shader: QuadPlanet shader anchor not found: ${anchor}`);
    return src.replace(anchor, replacement);
}

function build(people: boolean, textured = false, territories = false): string {
    let s = QUADPLANET_SHADER;
    if (territories) {
        // The terrain's own pipeline (ground, roads, distant building boxes): the territory overlay
        // seen from the air (al_territory.ts), before the haze.
        s += TERRITORY_WGSL;
        s = inject(s, "    // Aerial perspective through every atmosphere between the camera and this point.",
            "    if (material == 0 || material == 8 || material == 10) { col = territory_overlay(col, in.world_pos); }\n    // Aerial perspective through every atmosphere between the camera and this point.");
    }
    s = inject(s, "fn cloud_density(p: vec3<f32>, octaves: i32) -> f32 {", "fn cloud_density_procedural(p: vec3<f32>, octaves: i32) -> f32 {");
    s += CLOUD_CACHE_WGSL;
    // Reserved sun_color.w is zero in production. Profiler-only single-feature bypasses
    // retain geometry, lighting and depth so shader costs can be isolated without guessing.
    s = inject(s, "    if (world.cloud.w <= 0.0 || i != 0) { return 1.0; }", "    if (world.sun_color.w == 1.0 || world.cloud.w <= 0.0 || i != 0) { return 1.0; }");
    s = inject(s, "    if (world.cloud.w <= 0.0) { return col; }", "    if (world.sun_color.w == 2.0 || world.cloud.w <= 0.0) { return col; }");
    s = inject(s, "        if (material == 0) {", "        if (world.sun_color.w == 3.0) {\n            // Diagnostic: retain vertex albedo, normal and default surface properties.\n        } else if (material == 0) {");
    s = inject(s, "    out.transmit = 1.0;", "    out.transmit = 1.0;\n    if (world.sun_color.w == 4.0) { return out; }");
    s = inject(s, "fn stars(d: vec3<f32>) -> vec3<f32> {", "fn stars(d: vec3<f32>) -> vec3<f32> {\n    if (world.sun_color.w == 5.0) { return vec3<f32>(0.0); }");
    s = inject(s, "    if (material == 7) {\n        // See-through window glass", `    if (material == ${MAT_FIRE} || material == ${MAT_SMOKE}) {
        // Fire and smoke fade by ordered dither (4 x 4), so nothing needs blending.
        let fc = vec2<u32>(in.clip_position.xy);
        let fb2 = ((fc.x ^ fc.y) & 1u) * 2u + (fc.y & 1u);
        let fb4 = fb2 * 4u + (((fc.x >> 1u) ^ (fc.y >> 1u)) & 1u) * 2u + ((fc.y >> 1u) & 1u);
        if ((f32(fb4) + 0.5) / 16.0 > item.tex_origin.w) { discard; }
    }
    if (material == 7) {
        // See-through window glass`);
    s = inject(s, "    if (material == 4) {\n        col = base * (1.1 + item.tint.w * 2.2);", `    if (material == ${MAT_FIRE}) {
        // Flames: hot where the vertex color is bright, licking and flickering over the surface.
        let ft = world.sun_dir.w;
        let q = in.tex_pos * 2.3 + vec3<f32>(item.tex_origin.x);
        let flick = 0.75 + 0.25 * sin(q.x * 3.1 + ft * 17.0) * sin(q.y * 2.7 - ft * 23.0 + q.z * 1.9);
        let rim = pow(max(dot(n, v), 0.0), 0.6);
        col = linear(item.tint.rgb) * base * (0.6 + 0.4 * rim) * flick * (1.2 + item.tint.w * 3.0);
    } else if (material == 4) {
        col = base * (1.1 + item.tint.w * 2.2);`);
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
        if (material == ${MAT_SMOKE}) { base = base * item.tint.rgb; }
        if (material == 12) { base = base * linear(item.tint.rgb); }
        if (material == 13) { base = base * linear(item.tex_origin.xyz); }
        ${people ? `if (material == 15) { base = base * linear(person_colors.skin.rgb); }
        if (material == 16) { base = base * linear(person_colors.hair.rgb); }` : ""}`);
    s = inject(s, "        if (material == 3) { spec = 0.35; shin = 48.0; }",
        `        if (material == 3) { spec = 0.35; shin = 48.0; }
        if (material >= 12 && material <= 16) { spec = 0.1; shin = 18.0; }
        if (material == ${MAT_SMOKE}) { spec = 0.0; if (dot(n, v) < 0.0) { n = -n; } }
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
    if (textured) {
        // PBR material maps (al_materials.ts) on the surface kinds that have a set; the rest stay
        // procedural. Coordinates and their derivatives are taken where control flow is uniform.
        s = inject(s, "// --- Texture noise ---", `${materialWgsl()}
// --- Texture noise ---`);
        s = inject(s, "    let win_fw = max(fwidth(win_uv.x), fwidth(win_uv.y));\n", `    let win_fw = max(fwidth(win_uv.x), fwidth(win_uv.y));
    // In meters on the object as drawn (a wall segment is one meter stretched to its length).
    let mat_scale = vec3<f32>(length(item.model[0].xyz), length(item.model[1].xyz), length(item.model[2].xyz));
    let mat_uv0 = surface_uv(in.tex_pos * mat_scale, normalize(in.local_normal));
    let mat_dx = dpdx(mat_uv0);
    let mat_dy = dpdy(mat_uv0);
    let ground_dx = dpdx(in.tex_pos);
    let ground_dy = dpdy(in.tex_pos);
`);
        s = inject(s, "            var g = ground_surface(base, t, n, footprint);", "            var g = ground_surface_maps(in.color.rgb, t, n, up, footprint, ground_dx, ground_dy);");
        s = inject(s, "            if (snow_w > 0.0) { g = blend_surface(g, snow_surface(base, t, n, footprint), snow_w); }", "            // Snow is blended from the supplied map in ground_surface_maps.");
        s = inject(s, `            // Roads: a little grain and wear.
            let g = fbm(t, 1.0 / 2.0, 4, 0.5, footprint);
            base = base * (0.9 + 0.12 * g.x);
            spec = 0.08;
            shin = 20.0;`, `            let road = ground_maps(${GROUND.asphalt}, t, n, ground_dx, ground_dy);
            base = road.albedo; n = road.n_local;
            let a = road.rough * road.rough;
            shin = clamp(2.0 / (a * a) - 2.0, 2.0, 2048.0);
            spec = 0.04 * (shin + 8.0) / 8.0;`);
        s = inject(s, "        } else if (material == 11) {", "        } else if (material == 11 || material == 6) {");
        // A colored Fresnel term and reduced diffuse distinguish exposed metal from coatings.
        s = inject(s, "        var shin = 16.0;", "        var shin = 16.0;\n        var spec_color = vec3<f32>(1.0);\n        var diffuse_weight = 1.0;");
        s = inject(s, `            let f = city_surface(i32(floor(in.uv.y + 0.0005)), base, in.tex_pos, normalize(in.local_normal), footprint);
            base = f.albedo;
            spec = f.spec;
            shin = f.shin;
            ao = f.ao;
            n = bump(n, (item.model * vec4<f32>(f.grad, 0.0)).xyz);`, `            let kind = i32(floor(in.uv.y + 0.0005));
            let layer = surface_layer(kind);
            let ln = normalize(in.local_normal);
            if (layer >= 0) {
                // Textured: maps with parallax near the eye, then the same weathering.
                let m = item.model;
                let vl = normalize(vec3<f32>(dot(v, normalize(m[0].xyz)), dot(v, normalize(m[1].xyz)), dot(v, normalize(m[2].xyz))));
                let tx = textured_surface(kind, layer, mat_uv0, mat_dx, mat_dy, ln, vl, dist);
                let f = city_surface(0, tx.albedo * item.tint.rgb, in.tex_pos * mat_scale, ln, footprint);
                base = f.albedo;
                // Roughness as a normalized specular lobe (dielectric).
                let a = tx.rough * tx.rough;
                shin = clamp(2.0 / (a * a) - 2.0, 2.0, 2048.0);
                let f0 = mix(vec3<f32>(0.04), tx.albedo, tx.metallic);
                let fresnel = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - max(dot(n, v), 0.0), 5.0);
                spec = (shin + 8.0) / 8.0;
                spec_color = fresnel;
                diffuse_weight = 1.0 - tx.metallic;
                ao = f.ao * mix(0.5, 1.0, smoothstep(0.05, 0.55, tx.height));
                n = normalize((m * vec4<f32>(tx.n_local, 0.0)).xyz);
            } else {
                // Broken pieces (tex_origin.w < 0): the pattern in meters on the piece as drawn.
                let ftex = select(in.tex_pos, in.tex_pos * mat_scale, item.tex_origin.w < -0.5);
                let f = city_surface(kind, base, ftex, ln, footprint);
                base = f.albedo;
                spec = f.spec;
                shin = f.shin;
                ao = f.ao;
                n = bump(n, (item.model * vec4<f32>(f.grad, 0.0)).xyz);
            }`);
        s = inject(s, "        if (material == 6) { spec = 0.12; shin = 24.0; }", "        // Foundation surfaces now retain the map's roughness and specular response.");
        s = inject(s, "col = base * (world.sun_color.rgb * lit * 1.35 + sky_amb * ao) + world.sun_color.rgb * s", "col = base * diffuse_weight * (world.sun_color.rgb * lit * 1.35 + sky_amb * ao) + world.sun_color.rgb * spec_color * s");
    }
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
    // Ground, water, ice, glass, glowing things (lamps, the HQ's light beam), fire, smoke, the sky and roads cast nothing.
    if (material <= 2 || material == 4 || material == 5 || material == 7 || material == 9 || material == 10 || material == 18 || material == 19 || o.view_w < 0.0 || at_eye) {
        return vec4<f32>(0.0, 0.0, 2.0, 1.0);
    }
    return camera.view_proj * vec4<f32>(o.world_pos, 1.0);
}
`;

export const ALLEGIANCE_SHADER = build(false, true);
/** ALLEGIANCE_SHADER for the terrain pipeline, with the territory overlay (al_territory.ts, group 2 binding 10). */
export const ALLEGIANCE_TERRAIN_SHADER = build(false, true, true);
/** ALLEGIANCE_SHADER for instanced batches of Items (houses, city buildings, set dressing), with the material maps. */
export const ALLEGIANCE_INSTANCED_SHADER = instancedShader(build(false, true));
export const PEOPLE_SHADER = build(true);
