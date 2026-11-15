// World of Music: what the renderer packs for the GPU, checked without one.
import { describe, expect, it } from "vitest";
import { packWorld, packPost, box, cylinder, torus, waterMesh, yawed, at, between, type WorldLook } from "../src/games/world_of_music/wom_render";
import { WORLD_FLOATS, WORLD_VEC4, MAX_PULSES, MAX_DARKS, POST_FLOATS, WOM_TOON_SHADER, WOM_SCREEN_SHADER, WOM_INK_SHADER, WOM_GLOW_SHADER, DEPTH_K } from "../src/games/world_of_music/wom_shader";
import { Terrain } from "../src/games/world_of_music/wom_terrain";
import { LEVELS } from "../src/games/world_of_music/wom_data";

const look: WorldLook = {
    time: 3, aspect: 1.7, focus: 12, exposure: 1, sun: [0, 1, 0], haze: 0.01, cam: [1, 2, 3], dof: 1, screen: [1600, 900],
    tom: [4, 5, 6], hurt: 0, fog: [0.9, 0.9, 0.9], fade: 0, veins: 1, hatch: 1, ink: 1, flash: 0,
    pulses: [{ x: 1, z: 2, radius: 3, strength: 0.5, color: [1, 0, 0], width: 1.5 }],
    darks: [[10, 20, 15, 0.5]],
};

describe("World of Music rendering data", () => {
    it("the World uniform matches the WGSL struct", () => {
        expect(WORLD_VEC4).toBe(8 + MAX_PULSES * 2 + MAX_DARKS);
        expect(WOM_TOON_SHADER).toContain(`pulses: array<Pulse, ${MAX_PULSES}>`);
        expect(WOM_TOON_SHADER).toContain(`darks: array<vec4<f32>, ${MAX_DARKS}>`);
        const w = packWorld(look);
        expect(w.length).toBe(WORLD_FLOATS);
        expect([...w.slice(12, 16)]).toEqual([1600, 900, 1, 1]);
        expect([...w.slice(32, 40)]).toEqual([1, 2, 3, 0.5, 1, 0, 0, 1.5]);
        expect([...w.slice((8 + MAX_PULSES * 2) * 4, (8 + MAX_PULSES * 2) * 4 + 4)]).toEqual([10, 20, 15, 0.5]);
    });
    it("the screen pass uniform and depth encoding agree", () => {
        const p = packPost({ focus: 12, range: 7, blur: 9, haze: 0.006, fog: [1, 1, 1], bloom: 0.5, screen: [10, 20], time: 1, ink: 1, vignette: 0.3, grain: 0.03, fade: 0, flash: 0 });
        expect(p.length).toBe(POST_FLOATS);
        expect(p[0]).toBe(12);
        expect(WOM_SCREEN_SHADER).toContain(`${DEPTH_K.toFixed(1)} * d / max(1e-5, 1.0 - d)`);
        for (const src of [WOM_TOON_SHADER, WOM_INK_SHADER, WOM_GLOW_SHADER, WOM_SCREEN_SHADER]) { expect(src).toContain("fn vs_main"); expect(src).toContain("fn fs_main"); }
    });
    it("meshes are closed and wound outward", () => {
        for (const m of [box(), cylinder(), torus()]) {
            const v = m.vertexData, I = m.indexData;
            expect(I.length % 3).toBe(0);
            let out = 0, tris = 0;
            for (let k = 0; k < I.length; k += 3) {
                const p = (i: number) => [v[i * 12], v[i * 12 + 1], v[i * 12 + 2]];
                const n = (i: number) => [v[i * 12 + 3], v[i * 12 + 4], v[i * 12 + 5]];
                const a = p(I[k]), b = p(I[k + 1]), c = p(I[k + 2]);
                const cr = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
                const nn = n(I[k]);
                if (Math.hypot(...cr) < 1e-9) continue;
                tris++;
                if (cr[0] * nn[0] + cr[1] * nn[1] + cr[2] * nn[2] > 0) out++;
            }
            expect(out / tris).toBeGreaterThan(0.99);
        }
    });
    it("transforms place body parts where a body's frame says", () => {
        const p = at([0, 0, 0], Math.PI / 2, [0, 0, 1]);
        expect(p[0]).toBeCloseTo(1); expect(p[2]).toBeCloseTo(0);
        const m = yawed([1, 2, 3], 0, 2, 3, 4);
        expect([m[0], m[5], m[10], m[12], m[13], m[14]]).toEqual([2, 3, 4, 1, 2, 3]);
        const s = between([0, 0, 0], [0, 0, 5], 1);
        expect(Math.hypot(s[4], s[5], s[6])).toBeCloseTo(5);
    });
    it("the water knows how deep it is", () => {
        const t = new Terrain(LEVELS[0]);
        const m = waterMesh(t, 10);
        const depths = [];
        for (let i = 0; i < m.vertexData.length; i += 12) depths.push(m.vertexData[i + 8]);
        expect(Math.max(...depths)).toBeGreaterThan(3);
        expect(Math.min(...depths)).toBe(0);
    });
});
