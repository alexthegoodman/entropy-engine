// The Material Lab's one forward shader: a lit surface with PBR maps from the shared sets
// (materials/pbr_sets.ts) and parallax occlusion mapping from materials/pom.ts. It is also the
// reference for how another addon plugs the shared module into its own mesh shader:
//   1. pomDeclarations(layout) + POM_WGSL + setTablesWgsl(sets) at the top,
//   2. a frame (pom_frame), the view and light rays in it, and one pom_trace call,
//   3. maps sampled at the hit uv, the shaded point moved down the view ray for depth.

import { pomDeclarations, POM_WGSL } from "../../materials/pom";
import { setTablesWgsl, type MaterialLayout, type PbrSet } from "../../materials/pbr_sets";

/** Group 2 binding 0 (shared by every mesh) and 1 (one per mesh). */
export const LAB_WORLD_FLOATS = 8;
export const LAB_ITEM_FLOATS = 16;

export function labShader(layout: MaterialLayout, sets: PbrSet[]): string {
    return /* wgsl */ `
struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0) var<uniform> camera: Camera;

struct Lab {
    sun: vec4<f32>,     // xyz toward the sun, w = sun strength
    sky: vec4<f32>,     // rgb sky light, w = exposure
};
@group(2) @binding(0) var<uniform> lab: Lab;

struct Item {
    pom: PomSettings,
    mesh: vec4<f32>,    // x = layer, y = depth scale, z = parallax full within, w = gone beyond (m)
};
@group(2) @binding(1) var<uniform> item: Item;

${pomDeclarations(layout)}
${POM_WGSL}
${setTablesWgsl(sets)}

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

struct FragmentOutput {
    @location(0) color: vec4<f32>,
    @builtin(frag_depth) depth: f32,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.clip_position = camera.view_proj * vec4<f32>(in.position, 1.0);
    out.world_pos = in.position;
    out.normal = in.normal;
    out.uv = in.tex_coords;
    out.color = in.color;
    return out;
}

fn aces(x: vec3<f32>) -> vec3<f32> {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_main(in: VertexOutput) -> FragmentOutput {
    var out: FragmentOutput;
    let n = normalize(in.normal);
    let to_eye = camera.view_pos.xyz - in.world_pos;
    let dist = length(to_eye);
    let v = to_eye / dist;
    let layer = i32(item.mesh.x);
    let tile = POM_TILE[layer];
    let depth_m = POM_DEPTH[layer] * item.mesh.y;

    // Maps' v runs down the image: flip it, and scale to one repeat.
    let flip = vec2<f32>(1.0, -1.0) / tile;
    let uv0 = in.uv * flip;
    let gx = dpdx(in.uv) * flip;
    let gy = dpdy(in.uv) * flip;
    let tbn = pom_frame(in.world_pos, in.uv, n);
    let vt = vec3<f32>(dot(v, tbn[0]), dot(v, tbn[1]), dot(v, n));
    let l = normalize(lab.sun.xyz);
    let lt = vec3<f32>(dot(l, tbn[0]), dot(l, tbn[1]), dot(l, n));

    // Full parallax close up, none past item.mesh.w.
    let near = 1.0 - smoothstep(item.mesh.z, item.mesh.w, dist);
    let depth_uv = depth_m / tile * near;
    let vz = max(vt.z, 0.08);
    let shift = vec2<f32>(vt.x, -vt.y) / vz * depth_uv;
    let lshift = vec2<f32>(lt.x, -lt.y) / max(lt.z, 0.05) * depth_uv;
    var settings = item.pom;
    if (near <= 0.0 || vt.z <= 0.08) { settings.a.x = 0.0; }
    if (lt.z <= 0.02) { settings.b.x = 0.0; }
    let hit = pom_trace(layer, uv0, gx, gy, shift, vz, lshift, in.clip_position.xy, settings);

    let uv = hit.uv;
    let albedo = textureSampleGrad(pom_basecolor, pom_sampler, uv, layer, gx, gy).rgb;
    let nt = textureSampleGrad(pom_normal, pom_sampler, uv, layer, gx, gy).xyz * 2.0 - 1.0;
    let nw = normalize(tbn[0] * nt.x + tbn[1] * nt.y + n * max(nt.z, 0.05));
    let rough = clamp(textureSampleGrad(pom_roughness, pom_sampler, uv, layer, gx, gy).r, 0.04, 1.0);
    let metallic = clamp(textureSampleGrad(pom_metallic, pom_sampler, uv, layer, gx, gy).r, 0.0, 1.0);
    let height = pom_h(layer, uv, gx, gy);

    // Light: the sun (with the relief's own shadow), sky fill darkened in the crevices, a lobe.
    let ao = mix(0.45, 1.0, smoothstep(0.05, 0.55, height));
    let ndl = max(dot(nw, l), 0.0);
    let lit = ndl * hit.shadow;
    let h = normalize(l + v);
    let a = rough * rough;
    let shin = clamp(2.0 / (a * a) - 2.0, 2.0, 2048.0);
    let f0 = mix(vec3<f32>(0.04), albedo, metallic);
    let fresnel = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - max(dot(nw, v), 0.0), 5.0);
    let spec = pow(max(dot(nw, h), 0.0), shin) * (shin + 8.0) / 8.0 * ndl * hit.shadow;
    let sky_fill = lab.sky.rgb * (0.55 + 0.45 * nw.y);
    let col = albedo * (1.0 - metallic) * (lab.sun.w * lit + sky_fill * ao) + lab.sun.w * fresnel * spec;
    out.color = vec4<f32>(pow(aces(col * lab.sky.w), vec3<f32>(1.0 / 2.2)), 1.0);

    // Depth: the shaded point sits down the view ray, not on the surface plane.
    var depth = in.clip_position.z;
    if (settings.b.w > 0.5 && settings.a.x > 0.5) {
        let moved = in.world_pos - v * (hit.depth * depth_m * near / vz);
        let clip = camera.view_proj * vec4<f32>(moved, 1.0);
        depth = clip.z / clip.w;
    }
    out.depth = depth;
    return out;
}
`;
}
