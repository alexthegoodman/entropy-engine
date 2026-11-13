// Parallax occlusion mapping for the shared PBR sets (pbr_sets.ts): the WGSL that marches a view
// ray through a height map, finds where it meets the surface, and marches a second ray toward the
// sun for a self-shadow. Plain fragment-stage WGSL with `textureSampleGrad`, no storage textures
// or compute, so it runs unchanged in the browser (WebGPU) build.
//
// Two tracers share one entry point, `pom_trace`, switched by `PomSettings` (a uniform, so a test
// can flip modes between captures):
//   mode 1 "classic": 8-24 evenly spaced steps and one secant guess between the last two. What
//          Allegiance shipped with; kept so the new one can be compared against it.
//   mode 2 "refined": more steps at grazing angles, a per-pixel jitter on where the steps fall
//          (turns the layer terraces into fine noise), then a binary search between the last two
//          steps so the hit is exact to a tiny fraction of a layer.
// Both return the hit's uv and its depth (0 = the surface, 1 = the height map's black); with
// shadow_steps > 0 the hit also carries a soft self-shadow from marching toward the light.
//
// The caller owns the frame and the shading; see pomHitToWorld in the WGSL for moving the shaded
// point down the view ray so fragment depth and shadows follow the relief.

import type { MaterialLayout } from "./pbr_sets";

export interface PomSettings {
    /** 0 off (flat normal mapping), 1 classic, 2 refined. */
    mode: 0 | 1 | 2;
    /** Steps looking straight at the surface, and at a grazing angle (interpolated by view angle). */
    minSteps: number;
    maxSteps: number;
    /** Binary-search iterations after the linear search (mode 2). */
    refine: number;
    /** Samples toward the light for the self-shadow (0 = off). */
    shadowSteps: number;
    /** Penumbra: how fast the shadow darkens as the ray sinks under the relief. */
    shadowSoft: number;
    /** Per-pixel jitter of the step positions (mode 2). */
    jitter: boolean;
    /** Move the shaded point (and written depth) down the view ray to the hit. */
    depthWrite: boolean;
    /** Blur of the height the rays march through, as a multiplier on the sampling footprint (1 = the
     *  texels as they are, 4 = two mip levels softer). Fine spikes stop turning into streaks; the
     *  normal map still carries the fine detail. */
    smooth: number;
}

export const POM_CLASSIC: PomSettings = { mode: 1, minSteps: 8, maxSteps: 24, refine: 0, shadowSteps: 0, shadowSoft: 4, jitter: false, depthWrite: false, smooth: 1 };
export const POM_REFINED: PomSettings = { mode: 2, minSteps: 16, maxSteps: 48, refine: 6, shadowSteps: 0, shadowSoft: 4, jitter: true, depthWrite: false, smooth: 2 };
export const POM_FULL: PomSettings = { ...POM_REFINED, shadowSteps: 16, depthWrite: true };
/** Far too slow to ship: the reference the others are scored against in the lab. */
export const POM_ULTRA: PomSettings = { mode: 2, minSteps: 96, maxSteps: 128, refine: 12, shadowSteps: 0, shadowSoft: 4, jitter: false, depthWrite: false, smooth: 1 };

/** The uniform's three vec4s. */
export const POM_SETTINGS_FLOATS = 12;
export function packPomSettings(s: PomSettings): number[] {
    return [s.mode, s.minSteps, s.maxSteps, s.refine, s.shadowSteps, s.shadowSoft, s.jitter ? 1 : 0, s.depthWrite ? 1 : 0, s.smooth, 0, 0, 0];
}

/** Declares the maps (`pom_basecolor`, `pom_normal`, `pom_roughness`, `pom_height_map`, `pom_metallic`, `pom_sampler`). */
export function pomDeclarations(layout: MaterialLayout): string {
    const g = layout.group, b = layout.binding;
    return /* wgsl */ `
@group(${g}) @binding(${b.basecolor}) var pom_basecolor: texture_2d_array<f32>;
@group(${g}) @binding(${b.normal}) var pom_normal: texture_2d_array<f32>;
@group(${g}) @binding(${b.roughness}) var pom_roughness: texture_2d_array<f32>;
@group(${g}) @binding(${b.height}) var pom_height_map: texture_2d_array<f32>;
@group(${g}) @binding(${b.metallic}) var pom_metallic: texture_2d_array<f32>;
@group(${g}) @binding(${b.sampler}) var pom_sampler: sampler;
`;
}

/** The tracer. Needs `pomDeclarations` before it. */
export const POM_WGSL = /* wgsl */ `
struct PomSettings {
    a: vec4<f32>,   // mode, min steps, max steps, refine iterations
    b: vec4<f32>,   // shadow steps, shadow softness, jitter, depth write
    c: vec4<f32>,   // height blur (footprint multiplier)
};

struct PomHit {
    uv: vec2<f32>,   // where the view ray meets the surface (map coordinates)
    depth: f32,      // 0 at the surface plane, 1 at the height map's black
    shadow: f32,     // 1 lit, 0 in the relief's own shadow
};

fn pom_h(layer: i32, p: vec2<f32>, gx: vec2<f32>, gy: vec2<f32>) -> f32 {
    return textureSampleGrad(pom_height_map, pom_sampler, p, layer, gx, gy).r;
}

// Interleaved gradient noise (Jimenez): cheap, well distributed over screen pixels.
fn pom_noise(p: vec2<f32>) -> f32 {
    return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}

// Tangent frame (columns T, B, N) from screen derivatives, so any mesh with uv coordinates
// works without a tangent attribute. uv in meters, v up the surface.
fn pom_frame(p: vec3<f32>, uv: vec2<f32>, n: vec3<f32>) -> mat3x3<f32> {
    let dp1 = dpdx(p);
    let dp2 = dpdy(p);
    let duv1 = dpdx(uv);
    let duv2 = dpdy(uv);
    let dp2perp = cross(dp2, n);
    let dp1perp = cross(n, dp1);
    let t = dp2perp * duv1.x + dp1perp * duv2.x;
    let b = dp2perp * duv1.y + dp1perp * duv2.y;
    let inv = inverseSqrt(max(max(dot(t, t), dot(b, b)), 1.0e-20));
    return mat3x3<f32>(t * inv, b * inv, n);
}

// uv0: map coordinates of the surface point; gx, gy: their screen derivatives.
// shift: how far the map coordinates move over the full depth along the view ray (uv units);
// vz: the view ray's cosine to the normal; lshift: the same along the light ray, per unit of rise;
// frag: the fragment's pixel position (jitter).
fn pom_trace(layer: i32, uv0: vec2<f32>, gx: vec2<f32>, gy: vec2<f32>, shift: vec2<f32>, vz: f32, lshift: vec2<f32>, frag: vec2<f32>, s: PomSettings) -> PomHit {
    var hit: PomHit;
    // The march reads a softened height (a bigger footprint, so a higher mip).
    let hx = gx * max(s.c.x, 1.0);
    let hy = gy * max(s.c.x, 1.0);
    hit.uv = uv0;
    hit.depth = 0.0;
    hit.shadow = 1.0;
    if (s.a.x < 0.5) { return hit; }
    if (s.a.x < 1.5) {
        // Classic: even steps and one secant guess.
        let steps = mix(s.a.z, s.a.y, vz);
        let step = 1.0 / steps;
        var depth = 0.0;
        var cur = uv0;
        var surface = 1.0 - pom_h(layer, cur, hx, hy);
        var prev_cur = cur;
        var prev_gap = surface;
        for (var i = 0; i < 32; i = i + 1) {
            if (depth >= surface || f32(i) >= steps) { break; }
            prev_cur = cur;
            prev_gap = surface - depth;
            cur = cur - shift * step;
            depth = depth + step;
            surface = 1.0 - pom_h(layer, cur, hx, hy);
        }
        let after = surface - depth;
        let w = clamp(after / (after - prev_gap + 1.0e-5), 0.0, 1.0);
        hit.uv = mix(cur, prev_cur, w);
        hit.depth = depth - step * w;
        return hit;
    }
    // Refined: linear search with jittered sample positions, then a binary search.
    let n = clamp(round(mix(s.a.z, s.a.y, clamp(vz, 0.0, 1.0))), 1.0, 128.0);
    let step = 1.0 / n;
    let j = select(0.0, pom_noise(frag), s.b.z > 0.5);
    var lo = 0.0;
    var hi = 1.0;
    for (var i = 0; i < 128; i = i + 1) {
        if (f32(i) >= n) { break; }
        let d = (f32(i) + j) * step;
        if (d >= 1.0 - pom_h(layer, uv0 - shift * d, hx, hy)) { hi = d; break; }
        lo = d;
    }
    for (var k = 0; k < 12; k = k + 1) {
        if (f32(k) >= s.a.w) { break; }
        let mid = 0.5 * (lo + hi);
        if (mid >= 1.0 - pom_h(layer, uv0 - shift * mid, hx, hy)) { hi = mid; } else { lo = mid; }
    }
    let d = 0.5 * (lo + hi);
    hit.uv = uv0 - shift * d;
    hit.depth = d;
    // Self-shadow: rise from the hit toward the light; any height above the ray blocks it.
    let count = s.b.x;
    if (count > 0.5) {
        let hh = 1.0 - d;
        var sh = 1.0;
        for (var i = 1; i <= 32; i = i + 1) {
            if (f32(i) > count) { break; }
            let rise = f32(i) / count * (1.0 - hh);
            let over = pom_h(layer, hit.uv + lshift * rise, hx, hy) - (hh + rise) - 0.01;
            if (over > 0.0) { sh = min(sh, 1.0 - clamp(over * s.b.y / max(rise, 0.03), 0.0, 1.0)); }
        }
        hit.shadow = sh;
    }
    return hit;
}
`;

/**
 * The tracer for a shader that already declares its own height texture and sampler: the same
 * functions with those names in place of `pom_height_map` / `pom_sampler`.
 */
export function pomTracer(names: { height: string; sampler: string }): string {
    return POM_WGSL.replaceAll("pom_height_map", names.height).replaceAll("pom_sampler", names.sampler);
}

/** A WGSL expression building a PomSettings from a preset (for a shader with fixed settings). */
export function pomSettingsWgsl(s: PomSettings): string {
    const p = packPomSettings(s).map(v => Number.isInteger(v) ? `${v}.0` : String(v));
    return `PomSettings(vec4<f32>(${p.slice(0, 4).join(", ")}), vec4<f32>(${p.slice(4, 8).join(", ")}), vec4<f32>(${p.slice(8, 12).join(", ")}))`;
}
