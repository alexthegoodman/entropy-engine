import { describe, it, expect } from "vitest";
import { Game } from "../src/games/true_error/te_game";
import { KIT, KIT_MODELS, NOCTIS_ROADS, roadMesh, scrubMesh } from "../src/games/true_error/te_dressing";
import { noctisHeight } from "../src/games/true_error/te_noctis";
import { type Prop } from "../src/games/true_error/te_level";
import { propBoxes } from "../src/games/true_error/te_game";

const kitOf = (g: Game) => g.level.props.filter((p): p is Prop & { kit: true } => !!p.kit);

describe("True Error scenery kit (te_dressing.ts)", () => {
    for (const mission of [1, 2]) {
        it(`dresses mission ${mission} the same way every time, with kit models only`, () => {
            const a = kitOf(new Game(undefined, mission)), b = kitOf(new Game(undefined, mission));
            const by: Record<string, number> = {};
            for (const p of a) by[p.model] = (by[p.model] ?? 0) + 1;
            console.log(`mission ${mission}: ${a.length} kit props`, JSON.stringify(by));
            expect(a.length).toBeGreaterThan(mission === 1 ? 40 : 250);
            expect(JSON.stringify(a)).toBe(JSON.stringify(b));
            for (const p of a) expect(KIT_MODELS).toContain(p.model);
        });

        it(`keeps mission ${mission}'s spots clear of anything solid it adds`, () => {
            const g = new Game(undefined, mission);
            const kit = kitOf(g).filter(p => p.collide);
            const boxes = propBoxes({ ...g.level, props: kit });
            const spots = [
                ...g.level.uses.map(u => ({ id: `use ${u.id}`, p: u.pos })), ...g.level.items.map(i => ({ id: `item ${i.id}`, p: i.pos })),
                ...g.level.pickups.map(c => ({ id: `cell ${c.id}`, p: c.pos })), ...g.level.checkpoints.map(c => ({ id: `checkpoint ${c.id}`, p: c.pos })),
                ...g.level.enemies.map(e => ({ id: `machine ${e.id}`, p: e.pos })),
            ];
            for (const s of spots) for (const b of boxes) {
                const inside = s.p[0] > b.min[0] - 0.5 && s.p[0] < b.max[0] + 0.5 && s.p[2] > b.min[2] - 0.5 && s.p[2] < b.max[2] + 0.5 && s.p[1] > b.min[1] - 1 && s.p[1] < b.max[1];
                expect(inside, `${s.id} at ${s.p} is inside a kit prop`).toBe(false);
            }
        });
    }

    it("sizes every placed piece within its kit range (or the rubble's)", () => {
        for (const p of kitOf(new Game(undefined, 2))) {
            const [lo, hi] = KIT[p.model as keyof typeof KIT].size;
            expect(p.size, p.model).toBeGreaterThan(lo * 0.5);
            expect(p.size, p.model).toBeLessThan(Math.max(hi, 9) + 0.01);
        }
    });

    it("builds the roads over the ground and the scrub off them", () => {
        for (const [i, r] of NOCTIS_ROADS.entries()) {
            const m = roadMesh(r, noctisHeight, () => 1, i);
            expect(m.indexData.length).toBeGreaterThan(100);
            for (let k = 0; k < m.vertexData.length; k += 12) expect(Math.abs(m.vertexData[k + 1] - 0.07 - noctisHeight(m.vertexData[k], m.vertexData[k + 2]))).toBeLessThan(1e-3);
        }
        const g = new Game(undefined, 2);
        const s = scrubMesh(g.level, -60, -120, 120);
        expect(s.indexData.length).toBeGreaterThan(600);
    });
});
