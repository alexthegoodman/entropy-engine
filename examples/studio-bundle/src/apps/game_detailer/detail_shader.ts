// The Detailer's shader: Mesha's own viewport shader (mesha_shader.ts), so every object looks in
// the level exactly as it does in Mesha, made instanced the way The Abyss and Allegiance draw their
// scatter and crowds: each draw's records (highlight, model matrix, flags) come from a read-only
// storage buffer indexed by @builtin(instance_index), so a hundred houses of one variant, or ten
// thousand trees, are one draw and one buffer write.
//
// On top of Mesha's surfaces it adds the ground (pattern 30: the plan's ground colors broken up by
// noise at two scales) and water (pattern 31: rippled normals over a deep color, the sky reflected),
// a gentle sway for foliage, and it measures the "settle into the floor" occlusion from each
// object's own base rather than from y = 0, since a level's ground is not a studio floor.
//
// The transformation is anchored on Mesha's source; a test checks every anchor is found.

import { MESHA_SHADER } from "../mesha/mesha_shader";

/** Floats per instance record: highlight (4), model matrix (16), flags (4: x occlusion on, y sway, z, w). */
export const RECORD_FLOATS = 24;

function replaceOnce(src: string, from: string, to: string): string {
    const i = src.indexOf(from);
    if (i < 0) throw new Error(`Detailer shader: Mesha shader anchor not found: ${from.slice(0, 60)}`);
    return src.slice(0, i) + to + src.slice(i + from.length);
}

function build(): string {
    let s = MESHA_SHADER;
    s = replaceOnce(s, `struct Item {
    highlight: vec4<f32>,      // rgb accent, w = strength
    model: mat4x4<f32>,
};
@group(2) @binding(1) var<uniform> item: Item;`, `struct Item {
    highlight: vec4<f32>,      // rgb accent, w = strength
    model: mat4x4<f32>,
    flags: vec4<f32>,          // x: settle into the ground (1) or not (0, the ground itself); y: foliage sway
};
@group(2) @binding(1) var<storage, read> items: array<Item>;`);
    s = replaceOnce(s, `    @location(3) color: vec4<f32>,
};

@vertex`, `    @location(3) color: vec4<f32>,
    @location(4) @interpolate(flat) highlight: vec4<f32>,
    // x: height above the object's own base (m); y: settle on/off.
    @location(5) lift: vec2<f32>,
};

@vertex`);
    s = replaceOnce(s, `fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    // Uniform scale only; preserve the normal length carrying the pattern id.
    let world = item.model * vec4<f32>(in.position, 1.0);`, `fn vs_main(in: VertexInput, @builtin(instance_index) ii: u32) -> VertexOutput {
    let item = items[ii];
    var out: VertexOutput;
    // Uniform scale only; preserve the normal length carrying the pattern id.
    var world = item.model * vec4<f32>(in.position, 1.0);
    let base_y = item.model[3].y;
    // Leaves and grass sway a little in the breeze, more the higher they are.
    let pid = round(length(in.normal) - 1.0);
    if (item.flags.y > 0.0 && (pid == 8.0 || pid == 2.0)) {
        let h = max(world.y - base_y, 0.0);
        let t = studio.params.z;
        let ph = item.model[3].x * 0.37 + item.model[3].z * 0.29;
        world = vec4<f32>(world.x + sin(t * 1.3 + ph) * 0.012 * h * item.flags.y, world.y, world.z + cos(t * 1.1 + ph * 1.3) * 0.009 * h * item.flags.y, 1.0);
    }
    out.highlight = item.highlight;
    out.lift = vec2<f32>(world.y - base_y, item.flags.x);`);
    // Settle from the object's base; the ground and water are not darkened at all.
    s = replaceOnce(s, `let occ = 0.6 + 0.4 * smoothstep(0.0, 0.45, p.y);`, `let occ = mix(1.0, 0.6 + 0.4 * smoothstep(0.0, 0.45, in.lift.x), in.lift.y);`);
    s = replaceOnce(s, `let low = 1.0 - smoothstep(0.0, 1.2, p.y);`, `let low = 1.0 - smoothstep(0.0, 1.2, in.lift.x);`);
    s = replaceOnce(s, `let rim = pow(1.0 - nv, 5.0) * item.highlight.w;
    col = col + item.highlight.rgb * rim;`, `let rim = pow(1.0 - nv, 5.0) * in.highlight.w;
    col = col + in.highlight.rgb * (rim + in.highlight.w * 0.08);`);
    // Ground and water, after Mesha's surface patterns and before its lighting.
    s = replaceOnce(s, `    let key = normalize(studio.key_dir.xyz);
    let fill = normalize(studio.fill_dir.xyz);`, `    if (pattern == 30) {
        // Ground: the plan's colors, broken up at field scale and at boot scale.
        let big = fbm(p * 0.035 + vec3<f32>(1.3, 0.0, 7.1));
        let mid = fbm(p * 0.21);
        let fine = vnoise(p * 2.1) * 0.6 + vnoise(p * 7.7) * 0.4;
        base = base * (0.74 + 0.36 * big) * (0.86 + 0.22 * mid) * (0.92 + 0.14 * fine);
        spec_scale = 0.12;
    }
    if (pattern == 31) {
        // Water: two sets of ripples drifting with time, a dark body, the sky in it.
        let t = studio.params.z;
        let q = p.xz;
        let w1 = vnoise(vec3<f32>(q.x * 0.21 + t * 0.35, 0.3, q.y * 0.19)) - 0.5;
        let w2 = vnoise(vec3<f32>(q.x * 0.83 - t * 0.6, 1.7, q.y * 0.71 + t * 0.2)) - 0.5;
        let w3 = vnoise(vec3<f32>(q.x * 2.9 + t * 1.1, 4.1, q.y * 3.3)) - 0.5;
        n = normalize(vec3<f32>(w1 * 0.16 + w2 * 0.1 + w3 * 0.05, 1.0, (w2 - w1) * 0.14 + w3 * 0.05));
        metal = 0.0;
        rough = 0.04;
        base = base * (0.8 + 0.3 * smoothstep(-0.3, 0.3, w1));
    }

    let key = normalize(studio.key_dir.xyz);
    let fill = normalize(studio.fill_dir.xyz);`);
    return s;
}

export const DETAIL_SHADER = build();
