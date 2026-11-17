// Armageddon 2070's four battlefields: 8-12 territories each, reachable by infantry and vehicles
// from both headquarters, and - the point of the maps - good, varied cover everywhere.
import { describe, expect, it } from "vitest";
import { MAPS, World, NI, NV, NAV_INF, NAV_VEH, FAR } from "../src/games/armageddon/ar_map";
import { Rng } from "../src/games/nebula/nk_math";

const worlds = MAPS.map(m => new World(m));

describe("Armageddon maps", () => {
    it("has four maps of 8-12 territories with two headquarters", () => {
        expect(MAPS.length).toBe(4);
        for (const w of worlds) { expect(w.territories.length).toBeGreaterThanOrEqual(8); expect(w.territories.length).toBeLessThanOrEqual(12); expect(w.bases.length).toBe(2); }
    });
    for (const w of worlds) {
        it(`${w.def.name}: every territory is reachable on foot and by vehicle from both bases`, () => {
            for (const t of w.territories) for (const [kind, n, cell] of [["inf", NI, NAV_INF], ["veh", NV, NAV_VEH]] as const) for (const b of [0, 1]) {
                const f = w.flow(`base${b}`, kind);
                let best = FAR;
                for (let z = t.z - t.radius; z <= t.z + t.radius; z += cell) for (let x = t.x - t.radius; x <= t.x + t.radius; x += cell) best = Math.min(best, World.sample(f, n, cell, x, z));
                expect(best, `${t.name} ${kind} from base ${b}`).toBeLessThan(FAR);
            }
        });
        it(`${w.def.name}: cover within 6 m of almost every open spot, four kinds of cover, broken sightlines`, () => {
            const rng = new Rng(1);
            for (const t of w.territories) {
                const mats = new Set(w.boxes.filter(b => b.kind !== "deco" && Math.hypot(b.x - t.x, b.z - t.z) < t.radius * 1.2).map(b => b.mat));
                expect(mats.size, `${t.name} cover kinds`).toBeGreaterThanOrEqual(4);
                const pts: [number, number][] = [];
                for (let k = 0; k < 400 && pts.length < 100; k++) { const a = rng.range(0, 6.283), r = Math.sqrt(rng.next()) * t.radius; const x = t.x + Math.cos(a) * r, z = t.z + Math.sin(a) * r; if (!w.infBlocked(x, z) && w.coverHeight(x, z) < 0.3) pts.push([x, z]); }
                let near = 0;
                for (const [x, z] of pts) { let found = false; for (let dz = -6; dz <= 6 && !found; dz++) for (let dx = -6; dx <= 6 && !found; dx++) if (dx * dx + dz * dz <= 36 && w.coverHeight(x + dx, z + dz) >= 0.9) found = true; if (found) near++; }
                expect(near / pts.length, `${t.name} near cover`).toBeGreaterThanOrEqual(0.85);
                let clear = 0, pairs = 0;
                for (let k = 0; k < 200; k++) { const a = pts[rng.int(0, pts.length - 1)], b = pts[rng.int(0, pts.length - 1)]; if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 15) continue; pairs++; if (w.trace(a[0], w.height(a[0], a[1]) + 1.6, a[1], b[0], w.height(b[0], b[1]) + 1.6, b[1]) >= 0.999) clear++; }
                expect(clear / Math.max(1, pairs), `${t.name} open sightlines`).toBeLessThan(0.75);
            }
        });
    }
    it("windows and doors are gaps: a ray passes through a doorway and is stopped by the wall beside it", () => {
        const w = worlds[0];
        let door = 0, wall = 0;
        for (let k = 0; k < w.lo.length; k += 7) { if (w.gap[k] > 0 && w.lo[k] === 0) door++; if (w.lo[k] >= 30) wall++; }
        expect(door).toBeGreaterThan(50);
        expect(wall).toBeGreaterThan(500);
    });
    it("billboard foliage and concealment: bushes hide soldiers", () => {
        for (const w of worlds) { expect(w.foliage.length).toBeGreaterThan(1500); expect(w.conceal.some(v => v > 100)).toBe(true); }
    });
});
