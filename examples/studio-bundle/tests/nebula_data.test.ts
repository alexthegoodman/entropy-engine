// Nebula Kingdom's rules as data: growth from a moon to a hypergiant, the governments, the
// regions and their goals - checked for the promises the game makes.

import { describe, it, expect } from "vitest";
import {
    START_RADIUS, MAX_LEVEL, RANKS, REGIONS, GALAXIES, FACTIONS, GOVERNMENTS, SPECIES, ABILITIES, YARDSTICKS,
    radiusOfMass, massOfRadius, radiusOfLevel, levelOfRadius, levelProgress, rankOf, tierRadius, compare, formatKm, kindOfRadius, standingTier, garble,
} from "../src/games/nebula/nk_data";
import { generateRegion, regionMass } from "../src/games/nebula/nk_world";

describe("growth", () => {
    it("starts the size of the moon and ends wider than any star", () => {
        expect(radiusOfMass(1)).toBeCloseTo(1737.4);
        expect(compare(radiusOfMass(1))).toBe("as wide as Luna");
        const largestStar = Math.max(...YARDSTICKS.map(y => y[0]));
        expect(radiusOfLevel(MAX_LEVEL)).toBeGreaterThan(largestStar);
        expect(tierRadius(5)).toBeGreaterThan(600000);
    });
    it("has 37 levels and a rank every three", () => {
        expect(levelOfRadius(START_RADIUS)).toBe(1);
        for (let l = 1; l <= MAX_LEVEL; l++) expect(levelOfRadius(radiusOfLevel(l) * 1.001)).toBe(l);
        expect(levelOfRadius(1e12)).toBe(MAX_LEVEL);
        expect(rankOf(1)).toBe("Wisp");
        expect(rankOf(MAX_LEVEL)).toBe("Nebula Monarch");
        expect(new Set(Array.from({ length: MAX_LEVEL }, (_, i) => rankOf(i + 1))).size).toBe(RANKS.length);
        expect(levelProgress(radiusOfLevel(4))).toBeCloseTo(0, 5);
        expect(levelProgress(Math.sqrt(radiusOfLevel(4) * radiusOfLevel(5)))).toBeCloseTo(0.5, 5);
    });
    it("mass and radius invert", () => {
        for (const r of [1737.4, 6371, 695700, 1e9]) expect(radiusOfMass(massOfRadius(r))).toBeCloseTo(r, 3);
    });
    it("names sizes in a way a person can picture", () => {
        expect(compare(6371 * 2)).toBe("2.0 x Earth");
        expect(compare(695700 * 3.02)).toMatch(/Vega|Sirius/);
        expect(formatKm(12345)).toBe("12,345 km");
        expect(formatKm(2.5e6)).toBe("2.50 million km");
        expect(formatKm(1.495978707e8 * 3)).toBe("3.00 AU");
        expect(formatKm(9.4607e12 * 2)).toBe("2.00 ly");
    });
    it("calls a body by what its size makes it", () => {
        expect(kindOfRadius(200)).toBe("asteroid");
        expect(kindOfRadius(1737)).toBe("moon");
        expect(kindOfRadius(6371)).toBe("planet");
        expect(kindOfRadius(69911)).toBe("giant");
        expect(kindOfRadius(695700)).toBe("star");
    });
});

describe("governments and creatures", () => {
    it("has five governments, each with a form, a creed and laws", () => {
        expect(GOVERNMENTS).toHaveLength(5);
        for (const id of GOVERNMENTS) {
            const f = FACTIONS[id];
            expect(f.form.length).toBeGreaterThan(10);
            expect(f.creed.length).toBeGreaterThan(5);
            expect(f.laws.length).toBeGreaterThan(0);
            for (const e of f.enemies) expect(FACTIONS[e]).toBeDefined();
        }
    });
    it("grades standing", () => {
        expect(standingTier(-80)).toBe("Hunted");
        expect(standingTier(-20)).toBe("Hostile");
        expect(standingTier(0)).toBe("Known");
        expect(standingTier(30)).toBe("Favored");
        expect(standingTier(70)).toBe("Allied");
    });
    it("has many kinds of creature", () => {
        expect(Object.keys(SPECIES).length).toBeGreaterThanOrEqual(12);
        for (const s of Object.values(SPECIES)) { expect(s.hp).toBeGreaterThan(0); expect(FACTIONS[s.faction]).toBeDefined(); }
    });
    it("a foreign tongue comes clear with fluency", () => {
        const text = "The Silence hears.";
        expect(garble(text, 1, 3)).toBe(text);
        const half = garble(text, 0.5, 3), none = garble(text, 0, 3);
        expect(none).not.toBe(text);
        expect(none).toHaveLength(text.length);
        const same = (s: string) => [...s].filter((ch, i) => ch === text[i]).length;
        expect(same(half)).toBeGreaterThan(same(none));
    });
    it("abilities unlock as levels are attained", () => {
        expect(ABILITIES.lance.level).toBe(1);
        expect(ABILITIES.flare.level).toBeGreaterThan(ABILITIES.decoy.level);
    });
});

describe("regions", () => {
    it("has six galaxies of two regions, each a tier wider than the last", () => {
        expect(GALAXIES).toHaveLength(6);
        expect(REGIONS).toHaveLength(12);
        REGIONS.forEach((r, i) => expect(r.tier).toBe(i));
        for (const g of GALAXIES) expect(REGIONS.filter(r => r.galaxy === g.id)).toHaveLength(2);
        expect(new Set(REGIONS.map(r => r.id)).size).toBe(12);
    });
    it("every goal refers to something the region holds", () => {
        for (const def of REGIONS) {
            const region = generateRegion(def);
            for (const g of def.goals) {
                if (g.type === "mine") for (const k of g.keys ?? []) expect(region.bodies.some(b => b.key === k), `${def.id}: ${k}`).toBe(true);
                if (g.type === "clear") expect(region.creatures.some(c => c.group === g.group), `${def.id}: ${g.group}`).toBe(true);
                if (g.type === "defeat") expect(region.creatures.some(c => c.key === g.key), `${def.id}: ${g.key}`).toBe(true);
                if (g.type === "defend") expect(region.creatures.some(c => c.group === g.group)).toBe(true);
                if (g.type === "feed" || g.type === "sling" || g.type === "lure") expect(region.holes.some(h => h.key === g.hole), `${def.id}: ${g.hole}`).toBe(true);
                if (g.type === "lure") expect(g.to === "rift" ? !!region.rift : region.holes.some(h => h.key === g.to)).toBe(true);
            }
            expect(def.goals.some(g => !g.optional)).toBe(true);
        }
    });
    it("every region holds enough to grow a tier on", () => {
        for (const def of REGIONS) {
            const region = generateRegion(def);
            const entry = massOfRadius(tierRadius(def.tier)), next = massOfRadius(tierRadius(def.tier + 1));
            expect(regionMass(region), def.id).toBeGreaterThan(next - entry);
        }
    });
    it("builds the same region every time", () => {
        const a = generateRegion(REGIONS[3]), b = generateRegion(REGIONS[3]);
        expect(a.bodies.map(x => x.pos)).toEqual(b.bodies.map(x => x.pos));
        expect(a.creatures.map(x => x.pos)).toEqual(b.creatures.map(x => x.pos));
    });
    it("there are goals of clearing regions, mining worlds, and outwitting black holes", () => {
        const types = new Set(REGIONS.flatMap(r => r.goals.map(g => g.type)));
        for (const t of ["clear", "mine", "feed", "lure", "sling", "defend", "defeat", "standing"]) expect(types.has(t as never), t).toBe(true);
        expect(REGIONS.filter(r => r.holes?.length).length).toBeGreaterThanOrEqual(5);
    });
});
