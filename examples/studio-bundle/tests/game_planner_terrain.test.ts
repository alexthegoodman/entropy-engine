import { describe, expect, it } from "vitest";
import { PlannerModel, paletteForGenre } from "../src/apps/game_planner/planner_model";
import { generateRivers, generateSettlements, routeOverTerrain, scatterPointsOfInterest } from "../src/apps/game_planner/procedural_tools";
import { CRIMSON_EXPANSE_PRESET, SHATTERED_ISLES_PRESET } from "../src/apps/game_planner/presets";
import {
    computeDrainage,
    erodeTerrain,
    extractTerrainContours,
    fitTerrainToSpots,
    generateTerrain,
    niceContourInterval,
    sampleTerrain,
    terrainStats,
    traceIsolines,
} from "../src/apps/game_planner/terrain";
import { calculateTravelTime } from "../src/apps/game_planner/travel_calculator";
import { exportMapToSvg } from "../src/apps/game_planner/agent_pipeline";
import type { TerrainGrid } from "../src/apps/game_planner/planner_types";

const META = { worldWidthKm: 20, worldHeightKm: 20, seaLevelM: 0, seed: 7 };

/** A cone 1000 m high at the center of a 20 km world, falling 100 m per cell (0.5 km). */
function cone(n = 41): TerrainGrid {
    const data: number[] = [];
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            const d = Math.hypot(c - (n - 1) / 2, r - (n - 1) / 2);
            data.push(1000 - d * 100);
        }
    }
    const { min, max } = terrainStats(data);
    return { cols: n, rows: n, data, seaLevelM: 0, minM: min, maxM: max };
}

describe("Terrain: contours", () => {
    it("traces a closed ring at the right radius around a hill", () => {
        const lines = traceIsolines(cone(), META, 500);
        expect(lines.length).toBe(1);
        const ring = lines[0];
        expect(ring.closed).toBe(true);
        for (const [x, y] of ring.points) expect(Math.abs(Math.hypot(x, y) - 2.5)).toBeLessThan(0.2);
    });

    it("chains every contour into continuous polylines (no scattered points)", () => {
        const t = generateTerrain({ widthKm: 30, heightKm: 30, resolution: 65, seed: 3 });
        const contours = extractTerrainContours(t, { worldWidthKm: 30, worldHeightKm: 30 });
        expect(contours.length).toBeGreaterThan(5);
        const cell = 30 / 64;
        for (const c of contours) {
            for (let i = 1; i < c.points.length; i++) {
                const [ax, ay] = c.points[i - 1];
                const [bx, by] = c.points[i];
                // Consecutive points sit in neighboring cells: a line, not a scatter plot.
                expect(Math.hypot(bx - ax, by - ay)).toBeLessThan(cell * 1.5);
            }
        }
    });

    it("picks round contour intervals", () => {
        expect(niceContourInterval(0, 1600)).toBe(100);
        expect(niceContourInterval(0, 300)).toBe(20);
    });
});

describe("Terrain: generation, fitting and erosion", () => {
    it("is deterministic per seed and respects the peak and the island mask", () => {
        const a = generateTerrain({ widthKm: 30, heightKm: 30, resolution: 65, seed: 11, mountainScale: 2000, islandMask: true });
        const b = generateTerrain({ widthKm: 30, heightKm: 30, resolution: 65, seed: 11, mountainScale: 2000, islandMask: true });
        expect(a.data).toEqual(b.data);
        expect(a.maxM).toBeLessThanOrEqual(2000.5);
        expect(a.maxM).toBeGreaterThan(1900);
        // The whole rim of an island world is sea.
        for (let c = 0; c < a.cols; c++) {
            expect(a.data[c]).toBeLessThan(0);
            expect(a.data[(a.rows - 1) * a.cols + c]).toBeLessThan(0);
        }
    });

    it("bends the ground to authored spot elevations without touching far-away land", () => {
        const t = generateTerrain({ widthKm: 30, heightKm: 30, resolution: 97, seed: 5, islandMask: false, landBias: 0.2 });
        const meta = { worldWidthKm: 30, worldHeightKm: 30 };
        const spots = [{ x: 0, y: 0, elevation: 1200 }, { x: 5, y: 3, elevation: 40 }];
        const fitted = fitTerrainToSpots(t, meta, spots);
        for (const s of spots) expect(Math.abs(sampleTerrain(fitted, meta, s.x, s.y) - s.elevation)).toBeLessThan(1);
        expect(Math.abs(sampleTerrain(fitted, meta, -13, -13) - sampleTerrain(t, meta, -13, -13))).toBeLessThan(1);
    });

    it("erodes valleys without sinking land into the sea", () => {
        const t = generateTerrain({ widthKm: 30, heightKm: 30, resolution: 65, seed: 9 });
        const e = erodeTerrain(t, { droplets: 20000 });
        let changed = 0;
        for (let i = 0; i < t.data.length; i++) {
            if (Math.abs(e.data[i] - t.data[i]) > 0.5) changed++;
            if (t.data[i] > t.seaLevelM) expect(e.data[i]).toBeGreaterThan(t.seaLevelM);
        }
        expect(changed).toBeGreaterThan(t.data.length * 0.05);
    });
});

describe("Terrain: drainage, rivers, settlements and roads", () => {
    const t = generateTerrain({ widthKm: 30, heightKm: 30, resolution: 97, seed: 48201, islandMask: true });
    const meta = { ...SHATTERED_ISLES_PRESET.meta };

    it("drains every cell to an outlet", () => {
        const d = computeDrainage(t);
        let outlets = 0;
        for (let i = 0; i < d.downstream.length; i++) if (d.downstream[i] < 0) outlets++;
        expect(outlets).toBeGreaterThan(0);
        const total = d.accumulation.reduce((sum, a, i) => (d.downstream[i] < 0 ? sum + a : sum), 0);
        expect(total).toBe(t.data.length);
    });

    it("runs rivers downhill from high ground into the sea", () => {
        const rivers = generateRivers(meta, t, 3);
        expect(rivers.length).toBeGreaterThanOrEqual(1);
        for (const r of rivers) {
            const src = sampleTerrain(t, meta, r.points[0][0], r.points[0][1]);
            const mouth = sampleTerrain(t, meta, r.points[r.points.length - 1][0], r.points[r.points.length - 1][1]);
            expect(src).toBeGreaterThan(mouth);
            expect(mouth).toBeLessThan(30);
        }
        // Distinct ids, so a second run never collides with the first.
        expect(new Set(rivers.map((r) => r.id)).size).toBe(rivers.length);
    });

    it("sites settlements on land and roads around water", () => {
        const { spots, roads } = generateSettlements(meta, t);
        expect(spots.length).toBeGreaterThanOrEqual(5);
        for (const s of spots) {
            expect(s.elevation).toBeGreaterThan(0);
            expect(Math.abs(s.elevation - sampleTerrain(t, meta, s.x, s.y))).toBeLessThan(1);
        }
        const port = spots.find((s) => s.spotType === "port")!;
        expect(port.elevation).toBeLessThan(200);
        expect(roads.some((r) => r.pathType === "highway")).toBe(true);
        for (const r of roads) {
            const wet = r.points.filter(([x, y]) => sampleTerrain(t, meta, x, y) < -5).length;
            expect(wet / r.points.length).toBeLessThan(0.15);
        }
    });

    it("routes a road that climbs less than the straight line", () => {
        const a: [number, number] = [-6, -3];
        const b: [number, number] = [6, 3];
        const pts = routeOverTerrain(t, meta, a, b);
        expect(pts[0]).toEqual(a);
        expect(pts[pts.length - 1]).toEqual(b);
        const climb = (ps: [number, number][]) => {
            let total = 0;
            for (let i = 1; i < ps.length; i++) {
                const n = 10;
                for (let k = 1; k <= n; k++) {
                    const f0 = (k - 1) / n, f1 = k / n;
                    const e0 = sampleTerrain(t, meta, ps[i - 1][0] + (ps[i][0] - ps[i - 1][0]) * f0, ps[i - 1][1] + (ps[i][1] - ps[i - 1][1]) * f0);
                    const e1 = sampleTerrain(t, meta, ps[i - 1][0] + (ps[i][0] - ps[i - 1][0]) * f1, ps[i - 1][1] + (ps[i][1] - ps[i - 1][1]) * f1);
                    total += Math.abs(e1 - e0);
                }
            }
            return total;
        };
        expect(climb(pts)).toBeLessThanOrEqual(climb([a, b]) * 1.05);
    });

    it("scatters points of interest on land", () => {
        const pois = scatterPointsOfInterest(meta, [], 8, t);
        expect(pois.length).toBe(8);
        for (const p of pois) expect(p.elevation).toBeGreaterThan(0);
    });
});

describe("Planner model with terrain", () => {
    it("gives presets a heightfield that matches their authored spots", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const t = model.world.terrain!;
        expect(t.data.length).toBe(t.cols * t.rows);
        for (const s of model.world.spots) expect(Math.abs(model.elevationAt(s.x, s.y) - s.elevation)).toBeLessThanOrEqual(1);
        expect(model.world.contours).toEqual([]);
        expect(paletteForGenre(CRIMSON_EXPANSE_PRESET.meta.genre)).toBe("arid");
    });

    it("keeps a saved heightfield instead of regenerating it", () => {
        const a = new PlannerModel(SHATTERED_ISLES_PRESET);
        a.world.terrain!.data[0] = -1234;
        const b = new PlannerModel(JSON.parse(JSON.stringify(a.world)));
        expect(b.world.terrain!.data[0]).toBe(-1234);
    });

    it("puts a moved spot on the ground, and a whole drag is one undo step", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const id = model.world.spots[3].id;
        const startElev = model.world.spots[3].elevation;
        model.draggingSpotId = id;
        for (let k = 1; k <= 10; k++) model.moveSpot(id, -6.5 + k * 0.25, -1.5 - k * 0.2);
        model.endSpotDrag();
        const s = model.world.spots[3];
        expect(s.elevation).toBe(model.elevationAt(s.x, s.y));
        expect(s.elevation).not.toBe(startElev);
        model.undo();
        expect(model.world.spots[3].x).toBe(-6.5);
        expect(model.canUndo).toBe(false);
    });

    it("coalesces typing into one field into one undo step", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const entry = model.world.codex[0];
        for (const v of ["A", "Ar", "Arc", "Arch"]) model.updateCodexEntry(entry.id, { name: v });
        model.updateCodexEntry(entry.id, { subtitle: "New" });
        model.undo();
        expect(model.world.codex[0].name).toBe("Arch");
        model.undo();
        expect(model.world.codex[0].name).toBe(entry.name);
        expect(model.canUndo).toBe(false);
    });

    it("estimates travel with the real climb along the way", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const ctx = { terrain: model.world.terrain!, meta: model.world.meta };
        const flat = calculateTravelTime([0, 6.5], [8.5, -6]);
        const hilly = calculateTravelTime([0, 6.5], [8.5, -6], [], [], ctx);
        expect(hilly.directDistanceKm).toBe(flat.directDistanceKm);
        expect(hilly.climbM).toBeGreaterThan(1000);
        expect(hilly.distanceKm).toBeGreaterThan(flat.distanceKm);
    });

    it("exports terrain contours in the SVG map", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const svg = exportMapToSvg(model.world, 800, 800);
        expect((svg.match(/<polyline/g) || []).length).toBeGreaterThan(20);
    });
});
