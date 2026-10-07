// The territory overlay: flying high, the ground is washed in the color of whoever governs it -
// your party's color where you rule, each rival's where they do - with a bright line along every
// border, so you can read the map from the air. It fades in with altitude.
//
// Ownership follows regionAt (al_state.ts) exactly: a point inside a settlement's radius belongs to
// the nearest such settlement; anywhere else to the nearest hinterland anchor (the 108 regions).
// The terrain shader (al_shader.ts ALLEGIANCE_TERRAIN_SHADER) works this out per pixel from up to
// TERRITORY_MAX places in one uniform buffer, rewritten as you fly.

import type { BindingConfig, BindingEntry } from "../../addon";

export const TERRITORY_MAX = 64;
/** head (strength, count, border width, unused), then TERRITORY_MAX spots and TERRITORY_MAX colors. */
export const TERRITORY_FLOATS = 4 + TERRITORY_MAX * 8;
/** After the material maps (2-6, metallic 9) and the cloud atlas (7, 8). */
export const TERRITORY_BINDING = 10;

export const TERRITORY_BIND_ENTRIES: BindingEntry[] = [
    { binding: TERRITORY_BINDING, visibility: ["Fragment"], resourceType: "Uniform" },
];
export function territoryBindings(buffer: string): BindingConfig[] {
    return [{ group: 2, binding: TERRITORY_BINDING, resource: { type: "Buffer", value: { id: buffer } } }];
}

/** A place on the overlay: its center (render space), radius (meters; 0 for a hinterland anchor), and color. */
export interface TerritorySpot { at: [number, number, number]; radius: number; color: [number, number, number]; party: boolean }

/** How strongly the overlay shows at `altitude` meters above the ground: none below 120 m, full by 450 m. */
export function territoryStrength(altitude: number): number {
    const t = Math.max(0, Math.min(1, (altitude - 120) / 330));
    return t * t * (3 - 2 * t);
}

/** Border lines widen with altitude so they stay a few pixels across (meters). */
export function borderWidth(altitude: number): number {
    return Math.max(6, altitude * 0.012);
}

/** The uniform's floats. Settlements go first (the shader needs no order, but a truncated list keeps them). */
export function packTerritories(spots: readonly TerritorySpot[], strength: number, width: number): Float32Array {
    const out = new Float32Array(TERRITORY_FLOATS);
    const list = spots.slice(0, TERRITORY_MAX);
    out[0] = strength; out[1] = list.length; out[2] = width;
    list.forEach((s, i) => {
        const o = 4 + i * 4, c = 4 + TERRITORY_MAX * 4 + i * 4;
        out[o] = s.at[0]; out[o + 1] = s.at[1]; out[o + 2] = s.at[2]; out[o + 3] = s.radius;
        out[c] = s.color[0]; out[c + 1] = s.color[1]; out[c + 2] = s.color[2]; out[c + 3] = s.party ? 1 : 0;
    });
    return out;
}

/** The overlay in WGSL: `territory_overlay(col, p)` tints a lit, linear color at render-space point p. */
export const TERRITORY_WGSL = /* wgsl */ `
struct Territories {
    head: vec4<f32>,
    spot: array<vec4<f32>, ${TERRITORY_MAX}>,
    color: array<vec4<f32>, ${TERRITORY_MAX}>,
};
@group(2) @binding(${TERRITORY_BINDING}) var<uniform> territories: Territories;

fn territory_overlay(col: vec3<f32>, p: vec3<f32>) -> vec3<f32> {
    let k = territories.head.x;
    if (k <= 0.001) { return col; }
    let n = i32(territories.head.y);
    // Settlements: the nearest whose radius takes p in, and the runner-up (for the border between them).
    var sd = 1e30; var sd2 = 1e30; var si = -1; var rim = 1e30;
    // Hinterland: the nearest anchor and the runner-up.
    var hd = 1e30; var hd2 = 1e30; var hi = -1;
    for (var i = 0; i < n; i = i + 1) {
        let s = territories.spot[i];
        let d = distance(p, s.xyz);
        if (s.w > 0.0) {
            // How far p is from this settlement's edge (in or out): a line follows every rim.
            rim = min(rim, abs(s.w - d));
            if (d <= s.w) {
                if (d < sd) { sd2 = sd; sd = d; si = i; } else if (d < sd2) { sd2 = d; }
            }
        } else {
            if (d < hd) { hd2 = hd; hd = d; hi = i; } else if (d < hd2) { hd2 = d; }
        }
    }
    var c = vec4<f32>(0.0);
    var a = 0.0;
    var edge = rim;
    if (si >= 0) {
        c = territories.color[si];
        a = 0.3;
        edge = min(edge, (sd2 - sd) * 0.5);
    } else if (hi >= 0) {
        c = territories.color[hi];
        a = 0.16;
        edge = min(edge, (hd2 - hd) * 0.5);
    } else {
        return col;
    }
    let tint = pow(c.rgb, vec3<f32>(2.2));
    let lum = dot(col, vec3<f32>(0.3, 0.5, 0.2));
    // Your own ground a little stronger, so it reads at a glance.
    let wash = a * (1.0 + 0.3 * c.a) * k;
    var out = mix(col, tint * (lum * 1.7 + 0.03), wash);
    let w = territories.head.z;
    let line = 1.0 - smoothstep(w * 0.35, w, edge);
    out = mix(out, tint * (lum * 2.4 + 0.12) + vec3<f32>(0.04), line * 0.85 * k);
    return out;
}
`;
