// The whole of Nebula Kingdom, played start to finish by a simple pilot (tests/nebula_bot.ts):
// twelve regions in six galaxies, from a Wisp the size of Luna to a Monarch wider than any star.

import { describe, it, expect } from "vitest";
import { Game, NO_INPUT, newCampaign } from "../src/games/nebula/nk_game";
import { REGIONS, MAX_LEVEL, YARDSTICKS, GOVERNMENTS } from "../src/games/nebula/nk_data";
import { playRegion } from "./nebula_bot";

describe("the campaign", () => {
    it("can be played from Cradle Shoals to the Quiet Throne", () => {
        const g = new Game(newCampaign());
        expect(g.player.radius).toBeCloseTo(1737.4, 0);
        const levels: number[] = [];
        for (const r of REGIONS) {
            expect(g.region.def.id).toBe(r.id);
            expect(playRegion(g), `${r.id}: ${JSON.stringify(g.summary().goals.filter(x => !x.done))}`).toBe(true);
            levels.push(g.player.level);
            const next = g.nextRegion();
            if (next) {
                expect(g.startFold(next.id), next.id).toBe(true);
                for (let i = 0; i < 100; i++) g.step(1 / 30, NO_INPUT);
            }
        }
        // Each region grew the nebula, and it ends at the last level, larger than the largest star.
        for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeGreaterThan(levels[i - 1]);
        expect(g.player.level).toBe(MAX_LEVEL);
        expect(g.player.radius).toBeGreaterThan(Math.max(...YARDSTICKS.map(y => y[0])));
        expect(g.campaign.crowned).toBe(true);
        expect(g.campaign.completed).toHaveLength(REGIONS.length);
        expect(g.campaign.stats.stars).toBeGreaterThanOrEqual(15);
        expect(g.campaign.stats.folds).toBe(REGIONS.length - 1);
        expect(GOVERNMENTS.filter(f => g.standing(f) >= 25).length).toBeGreaterThanOrEqual(3);
        // Not a walkover, not a wall: the pilot is careless and is dispersed now and then.
        expect(g.campaign.stats.dispersed).toBeLessThan(60);
    }, 300_000);
});
