// What Nebula Kingdom hands the renderer and the painter: the World uniform, the meshes, the
// instances a scene draws, and every screen drawn into a fake engine.

import { describe, it, expect } from "vitest";
import { Game, newCampaign } from "../src/games/nebula/nk_game";
import { REGIONS, massOfRadius, radiusOfLevel, FACTIONS } from "../src/games/nebula/nk_data";
import { packWorld, placed, oriented, type WorldLook } from "../src/games/nebula/nk_render";
import { WORLD_FLOATS, ITEM_FLOATS, SOLID_KIND, GLOW_KIND, NEBULA_SOLID_SHADER, NEBULA_GLOW_SHADER, MAX_HOLES } from "../src/games/nebula/nk_shader";
import { MESHES, icosphere, quad, cone } from "../src/games/nebula/nk_meshes";
import { drawScene, nebulaPalette, type Draw } from "../src/games/nebula/nk_scene";
import { drawHud, drawChart, drawCodex, drawTitle, drawCrowned, drawDispersed, drawFold, wrap, type HudView } from "../src/games/nebula/nk_hud";
import { Painter } from "../src/games/allegiance/al_ui";

function recorder() {
    const solids: { mesh: string; m: number[]; params: readonly number[] }[] = [], glows: { m: number[]; kind: number; color: readonly number[] }[] = [];
    const d: Draw = { solid: (mesh, m, _c, params) => { solids.push({ mesh, m, params }); }, glow: (m, color, kind) => { glows.push({ m, kind, color }); } };
    return { d, solids, glows };
}
function at(region: string): Game {
    const i = REGIONS.findIndex(r => r.id === region);
    const c = newCampaign();
    c.completed = REGIONS.slice(0, i).map(r => r.id); c.region = region; c.mass = massOfRadius(radiusOfLevel(1 + i * 3)) * 1.02;
    return new Game(c);
}

describe("meshes and shaders", () => {
    it("meshes are in the engine's 12-float layout with valid indices", () => {
        for (const [name, make] of Object.entries(MESHES)) {
            const m = make();
            expect(m.vertexData.length % 12, name).toBe(0);
            expect(m.indexData.length % 3, name).toBe(0);
            expect(Math.max(...m.indexData), name).toBeLessThan(m.vertexData.length / 12);
        }
        expect(icosphere(2).indexData.length / 3).toBe(320);
        expect(quad().indexData.length).toBe(6);
        expect(cone(8).indexData.length).toBe(48);
    });
    it("every sphere vertex is on the unit sphere, and the sky faces inward", () => {
        const s = icosphere(3).vertexData, sky = icosphere(3, true).vertexData;
        for (let i = 0; i < s.length; i += 12) {
            expect(Math.hypot(s[i], s[i + 1], s[i + 2])).toBeCloseTo(1, 5);
            expect(sky[i + 3]).toBeCloseTo(-sky[i], 5);
        }
    });
    it("shaders declare the two entry points and the same Item the renderer packs", () => {
        for (const src of [NEBULA_SOLID_SHADER, NEBULA_GLOW_SHADER]) {
            expect(src).toContain("fn vs_main");
            expect(src).toContain("fn fs_main");
            expect(src).toContain("items: array<Item>");
            expect((src.match(/\{/g) ?? []).length).toBe((src.match(/\}/g) ?? []).length);
        }
        expect(ITEM_FLOATS).toBe(16 + 12);
    });
    it("packs the World uniform: camera basis, sky, lights and holes", () => {
        const look: WorldLook = {
            time: 3, warp: 0.5, attune: 1, flash: 0, hurt: 0, camPos: [0, 0, -8], camTarget: [0, 0, 0], fov: 60, screen: [1600, 900],
            deep: [0.1, 0.2, 0.3], a: [1, 0, 0], b: [0, 1, 0], clouds: 0.5, stars: 1, seed: 2, exposure: 1, saturation: 1, vignette: 0.3, fade: 0,
            lights: [{ pos: [1, 2, 3], color: [1, 1, 1], intensity: 2, reach: 0 }], holes: [[5, 6, 7, 2], [1, 1, 1, 1], [2, 2, 2, 2], [3, 3, 3, 3], [9, 9, 9, 9]],
        };
        const w = packWorld(look);
        expect(w).toHaveLength(WORLD_FLOATS);
        expect([w[0], w[1], w[2]]).toEqual([3, 0.5, 1]);
        expect([w[12], w[13], w[14]]).toEqual([0, 0, 1]);          // forward
        expect(w[4] * w[12] + w[5] * w[13] + w[6] * w[14]).toBeCloseTo(0); // right is across it
        expect(w[9]).toBeCloseTo(1);                                // up
        expect(w[34]).toBe(1);                                      // one light
        expect(w[35]).toBe(MAX_HOLES);                              // holes are capped
        expect([w[68], w[69], w[70], w[71]]).toEqual([5, 6, 7, 2]);
    });
    it("builds matrices that put a unit mesh where it should be", () => {
        expect(placed([1, 2, 3], 2).slice(12, 15)).toEqual([1, 2, 3]);
        const m = oriented([0, 0, 0], [1, 0, 0], 1, 1, 5);
        expect([m[8], m[9], m[10]]).toEqual([5, 0, 0]);
    });
});

describe("the scene", () => {
    it("draws the sky, the worlds, the creatures and the player's cloud", () => {
        const g = new Game();
        const { d, solids, glows } = recorder();
        const out = drawScene(d, g, 1, 0, [], [0, 3, -8]);
        expect(solids.filter(s => s.params[0] === SOLID_KIND.sky)).toHaveLength(1);
        expect(solids.filter(s => s.params[0] === SOLID_KIND.planet).length).toBeGreaterThanOrEqual(4);
        expect(solids.filter(s => s.params[0] === SOLID_KIND.rock).length).toBeGreaterThan(20);
        expect(solids.filter(s => s.params[0] === SOLID_KIND.hide).length).toBeGreaterThan(20);
        expect(glows.filter(x => x.kind === GLOW_KIND.gas).length).toBeGreaterThanOrEqual(100);
        expect(out.lights.length).toBeGreaterThanOrEqual(2);
        expect(out.holes).toHaveLength(0);
        for (const s of solids) for (const v of s.m) expect(Number.isFinite(v)).toBe(true);
        for (const x of glows) for (const v of x.m) expect(Number.isFinite(v)).toBe(true);
    });
    it("the player is always one unit wide at the origin, whatever its size", () => {
        for (const region of ["cradle", "throne"]) {
            const g = at(region);
            const { d, glows } = recorder();
            drawScene(d, g, 1, 0, [], [0, 3, -8]);
            const near = glows.filter(x => x.kind === GLOW_KIND.gas && Math.hypot(x.m[12], x.m[13], x.m[14]) < 1.6);
            expect(near.length).toBeGreaterThanOrEqual(110);
            expect(Math.max(...near.map(x => Math.hypot(x.m[12], x.m[13], x.m[14])))).toBeGreaterThan(0.6);
            // Each puff is a fraction of the cloud wide.
            for (const x of near.slice(0, 20)) expect(Math.abs(x.m[0])).toBeLessThan(1);
        }
    });
    it("lightwaves are invisible until you attune", () => {
        const g = new Game();
        for (let i = 0; i < 60; i++) g.step(1 / 30);
        expect(g.signals.length).toBeGreaterThan(0);
        const dark = recorder(), lit = recorder();
        drawScene(dark.d, g, 1, 0, [], [0, 3, -8]);
        drawScene(lit.d, g, 1, 1, [], [0, 3, -8]);
        const waves = (r: ReturnType<typeof recorder>) => r.glows.filter(x => x.kind === GLOW_KIND.wave && x.color[3] > 0.3).length;
        expect(waves(lit)).toBeGreaterThan(waves(dark));
        expect(lit.glows.filter(x => x.kind === GLOW_KIND.mark).length).toBeGreaterThan(5);
        expect(dark.glows.filter(x => x.kind === GLOW_KIND.mark)).toHaveLength(0);
    });
    it("black holes are a horizon, a disc, a photon ring, and a bend in the sky", () => {
        const g = at("drowned");
        const { d, solids, glows } = recorder();
        const out = drawScene(d, g, 1, 0, [], [0, 3, -8]);
        expect(out.holes).toHaveLength(2);
        expect(solids.filter(s => s.params[0] === SOLID_KIND.horizon)).toHaveLength(2);
        expect(glows.filter(x => x.kind === GLOW_KIND.disc)).toHaveLength(2);
        expect(glows.filter(x => x.kind === GLOW_KIND.photon)).toHaveLength(2);
        expect(solids.filter(s => s.params[0] === SOLID_KIND.star).length).toBeGreaterThanOrEqual(3);
    });
    it("the nebula's colours change as it grows", () => {
        expect(nebulaPalette(1).mid).not.toEqual(nebulaPalette(37).mid);
        for (const l of [1, 19, 37]) for (const c of Object.values(nebulaPalette(l))) for (const v of c) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); }
    });
});

describe("screens", () => {
    const fake = () => { const ops: { k: string; s?: string; x: number; y: number; w: number; h: number }[] = []; return { ops, p: new Painter({ clear: () => { ops.length = 0; }, rect: o => { ops.push(o); }, text: o => { ops.push(o); } }) }; };
    const view = (over: Partial<HudView> = {}): HudView => ({
        w: 1600, h: 900, time: 1, region: "Cradle Shoals", galaxy: "The Lantern Reach", government: FACTIONS.concord.name, governmentColor: FACTIONS.concord.color, standing: "Known", complete: false,
        goals: [{ text: "Gather 20 essence motes", done: false, progress: 3, total: 20, optional: false, locked: false }], messages: [{ speaker: "Envoy Lumen", text: "Little Wisp, the shoals are yours.", color: [1, 1, 1], age: 2, kind: "edict" }],
        attune: false, veil: false, rank: "Wisp", level: 1, maxLevel: 37, progress: 0.3, radius: "1,737 km", compare: "as wide as Luna", cohesion: 1, charge: 0.5, fed: true, points: 1,
        abilities: [{ name: "Lance", key: "LMB", ready: 1, locked: 0, active: false, affordable: true }, { name: "Pulse", key: "Q", ready: 1, locked: 3, active: false, affordable: true }],
        focus: { x: 800, y: 400, size: 40, name: "Pell", line: "moon", note: "[E] hold to siphon", color: [1, 1, 1], health: 0.5 }, markers: [{ x: 30, y: 30, label: "PELL", sub: "1 km", color: [1, 1, 1], onscreen: false }],
        stride: 0.5, speed: "1 km / s", warning: "FLARE", banner: { title: "LEVEL 2", text: "x", age: 1, color: [1, 1, 1] }, toasts: [{ text: "Done", age: 1 }], hints: "[M] Star Chart", ...over,
    });
    it("the HUD shows goals, the transcript, vitals, abilities and the focus, all on screen", () => {
        const { ops, p } = fake();
        p.begin(); drawHud(p, view()); p.flush();
        const texts = ops.filter(o => o.k === "t").map(o => o.s);
        for (const s of ["CRADLE SHOALS", "WISP  -  LEVEL 1", "ENVOY LUMEN", "PELL", "LEVEL 3", "Lance", "FLARE", "LEVEL 2"]) expect(texts, s).toContain(s);
        expect(texts.some(s => s?.includes("3/20"))).toBe(true);
        for (const o of ops) { expect(Number.isFinite(o.x + o.y + o.w + o.h)).toBe(true); expect(o.x).toBeGreaterThanOrEqual(-1); expect(o.y).toBeGreaterThanOrEqual(-1); expect(o.x).toBeLessThanOrEqual(1601); }
    });
    it("the Star Chart offers every region as something to click", () => {
        const { p } = fake();
        p.begin();
        drawChart(p, { w: 1600, h: 900, selected: "cradle", note: "", galaxies: [{ name: "A", government: "B", color: [1, 1, 1], text: "t", regions: [{ id: "cradle", name: "Cradle", text: "x", state: "here", size: "s", why: "" }, { id: "hearthring", name: "Hearth", text: "x", state: "sealed", size: "s", why: "w" }] }] });
        p.flush();
        expect(p.buttons.map(b => b.id)).toEqual(["fold:cradle", "fold:hearthring"]);
        expect(p.hit(p.buttons[1].x + 2, p.buttons[1].y + 2)?.id).toBe("fold:hearthring");
    });
    it("the Codex offers a + only while there are points to spend", () => {
        const base = { w: 1600, h: 900, rank: "Wisp", level: 1, radius: "1 km", compare: "x", facets: [{ id: "density", name: "Density", text: "t", rank: 0, max: 5 }, { id: "reach", name: "Reach", text: "t", rank: 5, max: 5 }], abilities: [], factions: [], stats: [] };
        const a = fake(); a.p.begin(); drawCodex(a.p, { ...base, points: 1 }); a.p.flush();
        expect(a.p.buttons.map(b => b.id)).toEqual(["facet:density"]);
        const b = fake(); b.p.begin(); drawCodex(b.p, { ...base, points: 0 }); b.p.flush();
        expect(b.p.buttons).toHaveLength(0);
    });
    it("the title, the fold, dispersal and the crown all draw", () => {
        const { ops, p } = fake();
        p.begin();
        drawTitle(p, { w: 1600, h: 900, time: 1, canContinue: true, summary: "s", sound: true });
        drawFold(p, 1600, 900, "Cradle Shoals", "The Lantern Reach", 0.5);
        drawDispersed(p, 1600, 900, 1);
        drawCrowned(p, 1600, 900, 3, ["a", "b"]);
        p.flush();
        const texts = ops.filter(o => o.k === "t").map(o => o.s);
        for (const s of ["NEBULA KINGDOM", "FOLDING", "DISPERSED", "NEBULA MONARCH"]) expect(texts).toContain(s);
        expect(p.buttons.map(b => b.id)).toEqual(["continue", "new", "sound", "reign"]);
    });
    it("wraps text to a width", () => {
        const lines = wrap("one two three four five six seven eight nine ten", 13, 120);
        expect(lines.length).toBeGreaterThan(2);
        expect(lines.join(" ")).toBe("one two three four five six seven eight nine ten");
    });
});
