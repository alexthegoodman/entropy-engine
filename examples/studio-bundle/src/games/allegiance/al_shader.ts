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
// tex_origin.w raises the arms to aim a weapon. So a whole walking, aiming
// person is one mesh and one 24-float uniform write per frame.

import { QUADPLANET_SHADER } from "../../apps/quadplanet/qp_shader";

export const MAT_CLOTH_TOP = 12;
export const MAT_CLOTH_BOTTOM = 13;
export const MAT_BODY = 14;
export const MAT_SKIN = 15;
export const MAT_HAIR = 16;

export const HIP = 0.92;
export const SHOULDER = 1.42;

function inject(src: string, anchor: string, replacement: string): string {
    if (!src.includes(anchor)) throw new Error(`Allegiance shader: QuadPlanet shader anchor not found: ${anchor}`);
    return src.replace(anchor, replacement);
}

function build(people: boolean): string {
    let s = QUADPLANET_SHADER;
    if (people) s = inject(s, "@group(2) @binding(1) var<uniform> item: Item;", `struct PersonColors {
        skin: vec4<f32>,
        hair: vec4<f32>,
    };
    @group(2) @binding(2) var<uniform> person_colors: PersonColors;
    @group(2) @binding(1) var<uniform> item: Item;`);
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
    s = inject(s, "        if (material == 3 || material == 6 || material == 11) { base = base * item.tint.rgb; }",
        `        if (material == 3 || material == 6 || material == 11) { base = base * item.tint.rgb; }
        if (material == 12) { base = base * linear(item.tint.rgb); }
        if (material == 13) { base = base * linear(item.tex_origin.xyz); }
        ${people ? `if (material == 15) { base = base * linear(person_colors.skin.rgb); }
        if (material == 16) { base = base * linear(person_colors.hair.rgb); }` : ""}`);
    s = inject(s, "        if (material == 3) { spec = 0.35; shin = 48.0; }",
        `        if (material == 3) { spec = 0.35; shin = 48.0; }
        if (material >= 12 && material <= 16) { spec = 0.1; shin = 18.0; }`);
    s = inject(s, "        if (material == 3 || material == 6 || material == 8 || material == 11) { col = col + base * 0.14 * max(dot(n, v), 0.0); }",
        "        if (material == 3 || material == 6 || material == 8 || material == 11 || (material >= 12 && material <= 16)) { col = col + base * 0.18 * max(dot(n, v), 0.0); }");
    return s;
}

export const ALLEGIANCE_SHADER = build(false);
export const PEOPLE_SHADER = build(true);
