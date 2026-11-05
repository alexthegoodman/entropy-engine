// Quest paths (routes drawn for quests, which make or wire up the quest) and town planning
// (building footprints, streets, walls, laying out a whole settlement), plus the physical roads and
// rivers that sculpting now lays and the bicubic terrain re-sampling.
import { describe, expect, it } from "vitest";
import { PlannerModel } from "../src/apps/game_planner/planner_model";
import { SHATTERED_ISLES_PRESET } from "../src/apps/game_planner/presets";
import { resampleTerrain, sampleTerrain } from "../src/apps/game_planner/terrain";
import { calculateTravelTime } from "../src/apps/game_planner/travel_calculator";
import { evaluateIntent } from "../src/apps/game_planner/intent_model";
import { exportMapToSvg, generateGameDesignDoc } from "../src/apps/game_planner/agent_pipeline";
import { questFromRoute, questPathTravel, rolesFromStops, routeSpots } from "../src/apps/game_planner/quest_paths";
import {
    STRUCTURE_KINDS,
    STRUCTURE_KIND_IDS,
    alignToStreet,
    createStructure,
    layOutTown,
    localOutline,
    localParts,
    structureAreaM2,
    structureGeometry,
    toWorld,
    townSummary,
    triangulate,
} from "../src/apps/game_planner/town_planning";
import { deserializeWorld, serializeWorld } from "../src/apps/game_planner/world_store";
import type { WorldSpot } from "../src/apps/game_planner/planner_types";

const fresh = () => new PlannerModel(SHATTERED_ISLES_PRESET);
const spot = (m: PlannerModel, id: string) => m.world.spots.find((s) => s.id === id)!;
const at = (s: WorldSpot): [number, number] => [s.x, s.y];

describe("quest paths", () => {
    it("drawing a route through spots makes a quest: giver, objectives in order, turn-in when it comes back", () => {
        const m = fresh();
        const [a, b, c] = m.world.spots;
        const before = m.world.missions.length;
        m.pendingPathPoints = [at(a), [0, 0], at(b), at(c), at(a)];
        const r = m.finishPendingQuestPath()!;
        expect(r.created).toBe(true);
        expect(m.world.missions.length).toBe(before + 1);
        expect(r.mission.startSpotId).toBe(a.id);
        expect(r.mission.objectiveSpotIds).toEqual([b.id, c.id]);
        expect(r.mission.turnInSpotId).toBe(a.id);
        expect(r.questPath.missionId).toBe(r.mission.id);
        expect(r.questPath.spotIds).toEqual([a.id, null, b.id, c.id, a.id]);
        // The places know the quest; the route is selected and the quest highlighted.
        expect(spot(m, b.id).linkedMissionIds).toContain(r.mission.id);
        expect(m.selectedId).toBe(r.questPath.id);
        expect(m.highlightedQuestId).toBe(r.mission.id);
        // The next route goes to the same quest.
        expect(m.pendingQuestId).toBe(r.mission.id);
        expect(m.canUndo).toBe(true);
        m.undo();
        expect(m.world.missions.length).toBe(before);
        expect(m.questPaths.length).toBe(0);
    });

    it("a route that starts off any spot has no giver; one through no spots is still a quest", () => {
        const m = fresh();
        const b = m.world.spots[1];
        const { mission } = questFromRoute(m.world, [[0, 0], at(b)]);
        expect(mission.startSpotId).toBeUndefined();
        expect(mission.objectiveSpotIds).toEqual([b.id]);
        expect(mission.title).toContain(b.name);
        const blank = questFromRoute(m.world, [[0, 0], [1, 1]]);
        expect(blank.mission.objectiveSpotIds).toEqual([]);
        expect(blank.mission.title).toMatch(/^New Quest/);
    });

    it("adding a route to an existing quest fills only what it lacks", () => {
        const m = fresh();
        const quest = m.world.missions[0];
        const knownStart = quest.startSpotId;
        const other = m.world.spots.find((s) => s.id !== knownStart && !quest.objectiveSpotIds.includes(s.id))!;
        m.pendingQuestId = quest.id;
        m.pendingPathPoints = [at(spot(m, knownStart!)), at(other)];
        const r = m.finishPendingQuestPath()!;
        expect(r.created).toBe(false);
        expect(r.mission.startSpotId).toBe(knownStart);
        expect(r.mission.objectiveSpotIds).toContain(other.id);
        expect(r.linked.some((l) => l.includes(other.name))).toBe(true);
    });

    it("roles: repeats are dropped and a loop is a turn-in", () => {
        const m = fresh();
        const [a, b] = m.world.spots;
        expect(rolesFromStops([a, b, b, a], true)).toMatchObject({ giver: a, objectives: [b, b].slice(0, 1), turnIn: a });
        expect(routeSpots(m.world, [at(a), at(a), at(b)]).stops.map((s) => s.id)).toEqual([a.id, b.id]);
    });

    it("route points on a spot follow it; the quest's routes go when the quest is deleted", () => {
        const m = fresh();
        const [a, b] = m.world.spots;
        m.pendingPathPoints = [at(a), [1, 1], at(b)];
        const r = m.finishPendingQuestPath()!;
        m.moveSpot(b.id, b.x + 1, b.y - 1);
        const q = m.questPaths[0];
        expect(q.points[2]).toEqual(at(spot(m, b.id)));
        expect(q.points[1]).toEqual([1, 1]);
        m.deleteSpot(a.id);
        expect(m.questPaths[0].spotIds![0]).toBeNull();
        m.deleteMission(r.mission.id);
        expect(m.questPaths.length).toBe(0);
    });

    it("quest paths are not roads: travel times ignore them", () => {
        const m = fresh();
        const [a, b] = m.world.spots;
        const t = m.world.terrain!;
        const before = calculateTravelTime(at(a), at(b), m.world.paths, m.world.regions, { terrain: t, meta: m.world.meta });
        m.pendingPathPoints = [at(a), at(b)];
        m.finishPendingQuestPath();
        const after = calculateTravelTime(at(a), at(b), m.world.paths, m.world.regions, { terrain: t, meta: m.world.meta });
        expect(after.distanceKm).toBe(before.distanceKm);
        expect(m.world.paths.some((p) => (p as any).pathType === "quest")).toBe(false);
    });

    it("travel along the drawn route: longer way, longer time; climbing is slower; mounted is faster", () => {
        const m = fresh();
        const [a, b] = m.world.spots;
        const direct = questPathTravel(m.world, [at(a), at(b)]);
        const detour = questPathTravel(m.world, [at(a), [a.x + 4, a.y - 4], at(b)]);
        expect(detour.distanceKm).toBeGreaterThan(direct.distanceKm);
        expect(detour.hours).toBeGreaterThan(direct.hours);
        expect(questPathTravel(m.world, [at(a), at(b)], "mount").hours).toBeLessThan(direct.hours);
        expect(direct.climbM + direct.descentM).toBeGreaterThan(0);
        // Naismith: an hour per 600 m climbed on top of the walk; nothing absurd over mountains.
        const walk = direct.distanceKm / 4.5;
        expect(direct.hours).toBeGreaterThanOrEqual(walk + direct.climbM / 600 - 0.01);
        expect(direct.hours).toBeLessThanOrEqual(walk / 0.75 + direct.climbM / 600 + 0.01);
        // Flat ground at walking pace: ~4.5 km/h.
        const flat = { ...m.world, terrain: undefined };
        const f = questPathTravel(flat, [[0, 0], [4.5, 0]]);
        expect(f.hours).toBeGreaterThan(0.9);
        expect(f.hours).toBeLessThan(1.6);
    });

    it("the GDD and the SVG include routes", () => {
        const m = fresh();
        const [a, b] = m.world.spots;
        m.pendingPathPoints = [at(a), at(b)];
        m.finishPendingQuestPath();
        expect(generateGameDesignDoc(m.world)).toContain("**Route:**");
        expect(exportMapToSvg(m.world)).toContain("Quest paths");
    });
});

describe("building footprints", () => {
    it("every kind has a sensible default", () => {
        for (const k of STRUCTURE_KIND_IDS) {
            const info = STRUCTURE_KINDS[k];
            if (info.shape === "wall" || info.shape === "street") expect(info.lineWidthM).toBeGreaterThan(0);
            else expect(info.widthM * info.depthM).toBeGreaterThan(0);
        }
    });

    it("footprint parts are convex pieces that tile the outline's area", () => {
        const area = (pts: [number, number][]) => Math.abs(pts.reduce((s, p, i) => s + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0) / 2);
        for (const shape of ["rect", "L", "T", "U"] as const) {
            const parts = localParts(shape, 20, 16);
            const sum = parts.reduce((s, p) => s + area(p), 0);
            expect(sum).toBeCloseTo(area(localOutline(shape, 20, 16)), 6);
        }
        expect(area(localParts("round", 10, 10)[0])).toBeCloseTo(Math.PI * 25, -1);
    });

    it("rotation turns the footprint about its center, in meters", () => {
        const s = { x: 1, y: 2, rotationDeg: 90 };
        const p = toWorld(s, [10, 0]);
        expect(p[0]).toBeCloseTo(1, 6);
        expect(p[1]).toBeCloseTo(2.01, 6);
        const st = createStructure(fresh().world, "house", 1, 2, { widthM: 10, depthM: 8 });
        expect(structureAreaM2(st)).toBeCloseTo(80, 3);
    });

    it("triangulates a concave plaza without spilling outside it", () => {
        const L: [number, number][] = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
        const tris = triangulate(L);
        expect(tris.length).toBe(4);
        const area = tris.reduce((s, [a, b, c]) => s + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2, 0);
        expect(area).toBeCloseTo(3, 6);
    });

    it("a new building belongs to the nearest settlement and can face the street", () => {
        const m = fresh();
        const town = m.world.spots.find((s) => ["town", "village", "city", "capital"].includes(s.spotType))!;
        const st = createStructure(m.world, "house", town.x + 0.05, town.y);
        expect(st.spotId).toBe(town.id);
        m.world.paths = []; // only the street below counts
        const street = createStructure(m.world, "street", town.x, town.y, { points: [[town.x - 0.2, town.y + 0.03], [town.x + 0.2, town.y + 0.03]] });
        m.addStructures([street]);
        // A house just south of an east-west street turns to face north (its front is local -y).
        const rot = alignToStreet(m.world, town.x, town.y + 0.015)!;
        expect(rot).toBe(180);
        expect(alignToStreet(m.world, town.x, town.y + 0.5)).toBeNull();
    });

    it("model: add, move (lines move all their points), rotate, duplicate, delete, undo", () => {
        const m = fresh();
        const wall = createStructure(m.world, "wall", 0, 0, { points: [[0, 0], [0.1, 0]] });
        const house = createStructure(m.world, "house", 1, 1);
        m.addStructures([wall, house]);
        m.moveStructure(wall.id, 1, 1);
        expect(m.structures[0].points).toEqual([[1, 1], [1.1, 1]]);
        m.updateStructure(house.id, { rotationDeg: 45 });
        expect(structureGeometry(m.structures[1]).outline[0]).not.toEqual(structureGeometry({ ...house, rotationDeg: 0 }).outline[0]);
        const copy = m.duplicateStructure(house.id)!;
        expect(m.structures.length).toBe(3);
        expect(copy.x).toBeGreaterThan(house.x);
        m.deleteStructure(copy.id);
        expect(m.structures.length).toBe(2);
        m.undo();
        expect(m.structures.length).toBe(3);
    });
});

describe("laying out a settlement", () => {
    const capital = (m: PlannerModel) => m.world.spots.find((s) => s.spotType === "capital")!;

    it("drafts streets, a square, landmarks and houses, all on dry, walkable ground, deterministically", () => {
        const m = fresh();
        const c = capital(m);
        const a = layOutTown(m.world, c);
        const b = layOutTown(m.world, c);
        expect(a.structures.map((s) => [s.kind, s.x, s.y])).toEqual(b.structures.map((s) => [s.kind, s.x, s.y]));
        const kinds = new Set(a.structures.map((s) => s.kind));
        for (const k of ["street", "market", "keep", "temple", "house", "wall"]) expect(kinds.has(k as any)).toBe(true);
        const buildings = a.structures.filter((s) => ["rect", "round", "L", "T", "U"].includes(s.shape) && s.kind !== "dock" && s.kind !== "gate");
        expect(buildings.length).toBeGreaterThan(40);
        const t = m.world.terrain!;
        for (const s of buildings) expect(sampleTerrain(t, m.world.meta, s.x, s.y)).toBeGreaterThan(m.world.meta.seaLevelM);
        expect(a.structures.every((s) => s.spotId === c.id)).toBe(true);
        // Buildings do not overlap much: centers are at least a few meters apart.
        for (let i = 0; i < buildings.length; i++)
            for (let j = i + 1; j < buildings.length; j++)
                expect(Math.hypot(buildings[i].x - buildings[j].x, buildings[i].y - buildings[j].y) * 1000).toBeGreaterThan(3);
        // Nothing is built on the roads that run through town (the King's Road highway does).
        const roads = m.world.paths.filter((p) => p.pathType !== "river");
        const segDist = (x: number, y: number, a: number[], b: number[]) => {
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
            return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t) * 1000;
        };
        for (const s of buildings)
            for (const r of roads)
                for (let i = 0; i < r.points.length - 1; i++) expect(segDist(s.x, s.y, r.points[i], r.points[i + 1])).toBeGreaterThan(Math.max(s.widthM, s.depthM) / 2);
        // Houses line the highway too.
        const hw = roads.find((r) => r.pathType === "highway")!;
        expect(buildings.some((s) => hw.points.some((q, i) => i < hw.points.length - 1 && segDist(s.x, s.y, q, hw.points[i + 1]) < 25))).toBe(true);
        // A different variant is a different draft.
        expect(layOutTown(m.world, c, { variant: 3 }).structures.map((s) => s.x)).not.toEqual(a.structures.map((s) => s.x));
    });

    it("a village gets fields, a smaller footprint and no walls", () => {
        const m = fresh();
        const v = m.addSpot({ ...m.world.spots[0], id: "spot_test_village", name: "Testford", spotType: "village", x: m.world.spots[0].x + 1.5, y: m.world.spots[0].y });
        const { structures } = layOutTown(m.world, v);
        expect(structures.some((s) => s.kind === "wall")).toBe(false);
        const n = structures.filter((s) => s.kind === "house" || s.kind === "farmhouse" || s.kind === "barn").length;
        expect(n).toBeGreaterThan(4);
        expect(n).toBeLessThan(30);
    });

    it("town summaries, clearing, the town following its spot, and the GDD", () => {
        const m = fresh();
        const c = capital(m);
        m.addStructures(layOutTown(m.world, c).structures);
        const sum = townSummary(m.world, c.id);
        expect(sum.buildings).toBeGreaterThan(40);
        expect(sum.builtAreaM2).toBeGreaterThan(5000);
        const first = m.structures.find((s) => s.spotId === c.id)!;
        const [fx, fy] = [first.x, first.y];
        m.moveSpot(c.id, c.x + 0.5, c.y);
        expect(m.structures.find((s) => s.id === first.id)!.x).toBeCloseTo(fx + 0.5, 3);
        expect(m.structures.find((s) => s.id === first.id)!.y).toBeCloseTo(fy, 3);
        expect(generateGameDesignDoc(m.world)).toContain("**Town plan:**");
        expect(m.clearTown(c.id)).toBe(sum.total);
        expect(townSummary(m.world, c.id).total).toBe(0);
    });

    it("towns and routes survive a save", () => {
        const m = fresh();
        m.addStructures(layOutTown(m.world, capital(m)).structures);
        const [a, b] = m.world.spots;
        m.pendingPathPoints = [at(a), at(b)];
        m.finishPendingQuestPath();
        const back = deserializeWorld(serializeWorld(m.world));
        expect(back.structures!.length).toBe(m.structures.length);
        expect(back.questPaths!.length).toBe(1);
        expect(back.structures![5].kind).toBe(m.structures[5].kind);
    });
});

describe("roads and rivers are laid by sculpting", () => {
    it("a road bed lays a road (or nothing, if asked), a canyon can run a river", () => {
        const m = fresh();
        const n = m.world.paths.length;
        m.sculpt.mode = "grade";
        m.sculpt.layRoad = "trail";
        expect(m.sculptShape([[0, 0], [2, 1], [4, 0]])).toBe(true);
        expect(m.world.paths.length).toBe(n + 1);
        expect(m.lastLaidPath!.pathType).toBe("trail");
        m.sculpt.layRoad = "none";
        m.sculptShape([[0, 3], [2, 4]]);
        expect(m.world.paths.length).toBe(n + 1);
        m.sculpt.mode = "canyon";
        m.sculpt.layRiver = true;
        m.sculptShape([[-6, 6], [-3, 3]]);
        expect(m.world.paths[m.world.paths.length - 1].pathType).toBe("river");
        // The laid road counts for "connect" intents like any road.
        const intent = m.addIntent("route", [[0, 0], [4, 0]], { kind: "connect" });
        expect(evaluateIntent(m.world, intent).satisfied).toBe(true);
    });
});

describe("terrain resolution", () => {
    it("re-samples bicubically: same ground at shared points, finer grid", () => {
        const m = fresh();
        const t = m.world.terrain!;
        const fine = resampleTerrain(t, 257);
        expect(fine.cols).toBe(257);
        expect(fine.data.length).toBe(257 * 257);
        // Grid vertex (c, r) of the 129 grid is (2c, 2r) of the 257 one.
        for (const [c, r] of [[10, 10], [64, 64], [100, 30]]) expect(fine.data[2 * r * 257 + 2 * c]).toBeCloseTo(t.data[r * 129 + c], 1);
        for (const [x, y] of [[0, 0], [3.3, -2.1]]) expect(Math.abs(sampleTerrain(fine, m.world.meta, x, y) - sampleTerrain(t, m.world.meta, x, y))).toBeLessThan(25);
        m.setTerrain(fine);
        expect(m.world.terrain!.cols).toBe(257);
        m.undo();
        expect(m.world.terrain!.cols).toBe(129);
    });
});
