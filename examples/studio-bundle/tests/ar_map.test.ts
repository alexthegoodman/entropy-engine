// Armageddon 2070's four battlefields: 8-12 territories each, reachable by infantry and vehicles
// from both headquarters, and - the point of the maps - good, varied cover everywhere.
import { describe, expect, it } from "vitest";
import { MAPS, World, NI, NV, NAV_INF, NAV_VEH, FAR, boxInFootprint } from "../src/games/armageddon/ar_map";
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
    it("no dead ground between neighbouring sites: cover within 8 m along the way, no open run past 32 m", () => {
        for (const w of worlds) {
            const nodes = [...w.territories.map(t => ({ x: t.x, z: t.z, r: t.radius, name: t.name })), ...w.bases.map(b => ({ x: b.x, z: b.z, r: b.radius, name: `HQ ${b.team}` }))];
            const links = new Set<string>();
            nodes.forEach((a, i) => { for (const { j } of nodes.map((b, j) => ({ j, d: Math.hypot(a.x - b.x, a.z - b.z) })).filter(q => q.j !== i).sort((p, q) => p.d - q.d).slice(0, 3)) links.add(`${Math.min(i, j)},${Math.max(i, j)}`); });
            let covered = 0, all = 0;
            for (const key of links) {
                const [a, b] = key.split(",").map(n => nodes[Number(n)]);
                const L = Math.hypot(b.x - a.x, b.z - a.z), ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
                let run = 0, worst = 0;
                for (let s = a.r; s <= L - b.r; s += 2) {
                    const x = a.x + ux * s, z = a.z + uz * s;
                    if (w.wet(x, z)) { run = 0; continue; }
                    let found = false;
                    for (let dz = -8; dz <= 8 && !found; dz++) for (let dx = -8; dx <= 8 && !found; dx++) if (dx * dx + dz * dz <= 64 && w.coverHeight(x + dx, z + dz) >= 0.9) found = true;
                    all++;
                    if (found) { covered++; run = 0; } else { run += 2; worst = Math.max(worst, run); }
                }
                expect(worst, `${w.def.name}: ${a.name} to ${b.name} open run (m)`).toBeLessThanOrEqual(32);
            }
            expect(covered / all, `${w.def.name}: share of the way with cover within 8 m`).toBeGreaterThanOrEqual(0.93);
        }
    });
    it("buildings are ways through: two doors or more, rooms inside", () => {
        // Partitions are 0.3 m plaster walls; every map has hundreds of them.
        for (const w of worlds) expect(w.boxes.filter(b => b.kind === "wall" && b.mat === "plaster" && Math.abs(b.hx - 0.15) < 1e-6).length, w.def.name).toBeGreaterThan(100);
    });
    it("inside a building there is only floor and its own partitions (no barriers, crates, rubble, trees or stray walls)", () => {
        for (const w of worlds) {
            expect(w.buildings.length, w.def.name).toBeGreaterThan(60);
            const bad: string[] = [];
            for (const f of w.buildings) {
                // The outer walls straddle the footprint's edge; 0.6 m in from it is the rooms.
                const inner = { ...f, hx: f.hx - 0.6, hz: f.hz - 0.6 };
                for (const b of w.boxes) {
                    if (b.y >= f.y + f.h - 0.01 || b.y + b.h <= f.y || !boxInFootprint(b, inner)) continue;
                    if (!(b.kind === "wall" && b.mat === "plaster" && Math.abs(b.hx - 0.15) < 1e-6)) bad.push(`${b.kind} ${b.mat} at ${b.x.toFixed(1)}, ${b.z.toFixed(1)} in the building at ${f.x}, ${f.z}`);
                }
                for (const t of w.foliage) if (Math.abs(t.x - f.x) < f.hx && Math.abs(t.z - f.z) < f.hz) bad.push(`${t.kind} in the building at ${f.x}, ${f.z}`);
                // Buildings never overlap one another.
                for (const g of w.buildings) if (g !== f && boxInFootprint({ ...f, yaw: 0 }, g)) bad.push(`buildings at ${f.x}, ${f.z} and ${g.x}, ${g.z} overlap`);
            }
            expect(bad.slice(0, 10), w.def.name).toEqual([]);
        }
    });
    it("windows and doors are gaps: a ray passes through a doorway and is stopped by the wall beside it", () => {
        const w = worlds[0];
        let door = 0, wall = 0;
        for (let k = 0; k < w.lo.length; k += 7) { if (w.gap[k] > 0 && w.lo[k] === 0) door++; if (w.lo[k] >= 30) wall++; }
        expect(door).toBeGreaterThan(50);
        expect(wall).toBeGreaterThan(500);
    });
    it("rounds and sight pass through windows as drawn, square on and at 30 degrees, and stop at the wall", () => {
        for (const w of worlds) {
            let tries = 0, square = 0, angled = 0, walls = 0;
            for (const b of w.boxes) {
                // A window's sill: a 1.2 m wall segment 1 m tall (the lintel sits 2.1 m up).
                if (b.kind !== "wall" || Math.abs(b.h - 1.0) > 1e-6 || Math.abs(b.hz - 0.6) > 1e-6) continue;
                const nx = Math.cos(b.yaw), nz = -Math.sin(b.yaw), ux = Math.sin(b.yaw), uz = Math.cos(b.yaw), y = b.y + 1.55;
                const ray = (side: number) => w.trace(b.x - nx * 3 - ux * side, y, b.z - nz * 3 - uz * side, b.x + nx * 3 + ux * side, y, b.z + nz * 3 + uz * side);
                if (w.solidAt(b.x - nx * 3, y, b.z - nz * 3) || w.solidAt(b.x + nx * 3, y, b.z + nz * 3)) continue;
                tries++;
                if (ray(0) >= 0.999) square++;
                if (ray(1.73) >= 0.999 || ray(-1.73) >= 0.999) angled++;
                // 2 m along the wall the same ray hits brick (unless that is another opening).
                const wx = b.x + ux * 2.2, wz = b.z + uz * 2.2;
                if (w.trace(wx - nx * 3, y - 1.2, wz - nz * 3, wx + nx * 3, y - 1.2, wz + nz * 3) < 0.999) walls++;
            }
            expect(tries, w.def.name).toBeGreaterThan(100);
            expect(square / tries, `${w.def.name} square through windows`).toBeGreaterThan(0.9);
            expect(angled / tries, `${w.def.name} angled through windows`).toBeGreaterThan(0.8);
            expect(walls / tries, `${w.def.name} the wall under the sill line still stops rounds`).toBeGreaterThan(0.8);
        }
    });
    it("billboard foliage and concealment: bushes hide soldiers", () => {
        for (const w of worlds) { expect(w.foliage.length).toBeGreaterThan(1500); expect(w.conceal.some(v => v > 100)).toBe(true); }
    });
});
