// Allegiance draws with QuadPlanet's shader (terrain, sky, atmosphere, cities: qp_shader.ts) plus
// people. Rather than fork 600 lines of WGSL, this injects three materials into it:
//
// - 12: clothing, top  - colored by the item's tint.rgb (party armbands and uniforms recolor
//       without rebuilding the mesh);
// - 13: clothing, bottom - colored by the item's tex_origin.xyz;
// - 14: skin, hair, gear - the vertex color.
//
// All three are animated in the vertex shader: uv.y's integer part says which limb a vertex
// belongs to (0 rigid, 1/2 left/right leg, 3/4 left/right arm). Legs swing about the hip and
// arms about the shoulder by sin(phase) * amplitude, with phase = |tex_origin.w| and amplitude
// tint.w; a negative tex_origin.w raises the arms to aim a weapon. So a whole walking, aiming
// person is one mesh and one 24-float uniform write per frame.

import { QUADPLANET_SHADER } from "../../apps/quadplanet/qp_shader";

export const MAT_CLOTH_TOP = 12;
export const MAT_CLOTH_BOTTOM = 13;
export const MAT_BODY = 14;

export const HIP = 0.92;
export const SHOULDER = 1.42;

function inject(src: string, anchor: string, replacement: string): string {
    if (!src.includes(anchor)) throw new Error(`Allegiance shader: QuadPlanet shader anchor not found: ${anchor}`);
    return src.replace(anchor, replacement);
}

function build(): string {
    let s = QUADPLANET_SHADER;
    s = inject(s, "        var pos = in.position;\n", `        var pos = in.position;
        var nrm = in.normal;
        if (material >= 12 && material <= 14) {
            // People: swing the limbs about the hip / shoulder (see al_shader.ts).
            let limb = i32(floor(in.tex_coords.y + 0.0005));
            if (limb > 0) {
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
                let c = cos(ang);
                let sn = sin(ang);
                let q = pos - pivot;
                pos = pivot + vec3<f32>(q.x, q.y * c - q.z * sn, q.y * sn + q.z * c);
                nrm = vec3<f32>(nrm.x, nrm.y * c - nrm.z * sn, nrm.y * sn + nrm.z * c);
            }
        }
`);
    s = inject(s, "        out.normal = (item.model * vec4<f32>(in.normal, 0.0)).xyz;", "        out.normal = (item.model * vec4<f32>(nrm, 0.0)).xyz;");
    s = inject(s, "        if (material == 3 || material == 6 || material == 11) { base = base * item.tint.rgb; }",
        `        if (material == 3 || material == 6 || material == 11) { base = base * item.tint.rgb; }
        if (material == 12) { base = base * linear(item.tint.rgb); }
        if (material == 13) { base = base * linear(item.tex_origin.xyz); }`);
    s = inject(s, "        if (material == 3) { spec = 0.35; shin = 48.0; }",
        `        if (material == 3) { spec = 0.35; shin = 48.0; }
        if (material >= 12 && material <= 14) { spec = 0.1; shin = 18.0; }`);
    s = inject(s, "        if (material == 3 || material == 6 || material == 8 || material == 11) { col = col + base * 0.14 * max(dot(n, v), 0.0); }",
        "        if (material == 3 || material == 6 || material == 8 || material == 11 || (material >= 12 && material <= 14)) { col = col + base * 0.18 * max(dot(n, v), 0.0); }");
    return s;
}

export const ALLEGIANCE_SHADER = build();
