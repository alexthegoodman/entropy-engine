// Planning the world in more depth: sculpting terrain (brushes, canyons, mountain ranges, road beds,
// plateaus), Snap to Landscape on spots, painted planning marks tied to regions, codex entries
// placed and painted on the map, and the optional quest planning detail with its planning check.
import { describe, expect, it } from "vitest";
import { PlannerModel } from "../src/apps/game_planner/planner_model";
import { SHATTERED_ISLES_PRESET } from "../src/apps/game_planner/presets";
import { generateTerrain, sampleTerrain } from "../src/apps/game_planner/terrain";
import {
    applyBrushStroke,
    carveCanyon,
    circlePolygon,
    flattenArea,
    gradeAlongPath,
    nearestOnPolyline,
    pointAlong,
    raiseRidge,
} from "../src/apps/game_planner/terrain_sculpt";
import {
    clearInside,
    codexLayerKey,
    codexMapPresence,
    createPlacement,
    emptyOverlay,
    fillPolygon,
    layerCoverage,
    markAt,
    paintStroke,
    populationAt,
    suggestBiome,
} from "../src/apps/game_planner/planning_layers";
import { analyzeQuest, comfortableDanger, describeObjective, objectiveMinutes } from "../src/apps/game_planner/quest_planning";
import { createCodexEntry } from "../src/apps/game_planner/codex_model";
import { generateGameDesignDoc } from "../src/apps/game_planner/agent_pipeline";
import type { TerrainGrid } from "../src/apps/game_planner/planner_types";

const META = { worldWidthKm: 20, worldHeightKm: 20 };
const fresh = () => new PlannerModel(SHATTERED_ISLES_PRESET);

/** A tilted plane: 400 m in the west falling to 200 m in the east. */
function plane(res = 81): TerrainGrid {
    const data: number[] = [];
    for (let r = 0; r < res; r++) for (let c = 0; c < res; c++) data.push(400 - (200 * c) / (res - 1));
    return { cols: res, rows: res, data, seaLevelM: 0, minM: 200, maxM: 400 };
}

const at = (t: TerrainGrid, x: number, y: number) => sampleTerrain(t, META, x, y);

describe("terrain sculpting", () => {
    it("measures distance and position along a polyline", () => {
        const line: [number, number][] = [[0, 0], [4, 0], [4, 3]];
        const n = nearestOnPolyline([2, 1], line);
        expect(n.d).toBeCloseTo(1, 5);
        expect(n.s).toBeCloseTo(2, 5);
        expect(n.total).toBeCloseTo(7, 5);
        expect(pointAlong(line, 5.5)).toEqual([4, 1.5]);
    });

    it("carves a canyon: a deep floor along the course, untouched ground beyond the rim", () => {
        const t = plane();
        const line: [number, number][] = [[-8, 0], [8, 0]];
        const out = carveCanyon(t, META, line, { widthKm: 2, depthM: 300, steepness: 0.8 });
        // Deep in the middle of the floor.
        expect(at(t, 0, 0) - at(out, 0, 0)).toBeGreaterThan(250);
        // Walls: shallower toward the rim, nothing beyond it.
        expect(at(t, 0, 0.7) - at(out, 0, 0.7)).toBeLessThan(at(t, 0, 0) - at(out, 0, 0));
        expect(at(out, 0, 2)).toBeCloseTo(at(t, 0, 2), 1);
        // A canyon through land stays above the sea.
        expect(at(out, 0, 0)).toBeGreaterThan(0);
        // Only ever cut, never filled.
        for (let i = 0; i < t.data.length; i++) expect(out.data[i]).toBeLessThanOrEqual(t.data[i] + 1e-6);
        // The floor runs downhill from the first point.
        const floor = [-7, -3, 0, 3, 7].map((x) => at(out, x, 0));
        for (let i = 1; i < floor.length; i++) expect(floor[i]).toBeLessThanOrEqual(floor[i - 1] + 0.5);
    });

    it("carves a canyon that drains even when drawn uphill", () => {
        const t = plane();
        const out = carveCanyon(t, META, [[8, 0], [-8, 0]], { widthKm: 2, depthM: 150 });
        const floor = [7, 3, 0, -3, -7].map((x) => at(out, x, 0));
        for (let i = 1; i < floor.length; i++) expect(floor[i]).toBeLessThanOrEqual(floor[i - 1] + 0.5);
    });

    it("raises a mountain range along its spine, tapering to the base", () => {
        const t = plane();
        const out = raiseRidge(t, META, [[-6, 0], [6, 0]], { widthKm: 4, heightM: 1500, roughness: 0.4, seed: 3 });
        const rise = (x: number, y: number) => at(out, x, y) - at(t, x, y);
        expect(rise(0, 0)).toBeGreaterThan(700);
        expect(rise(0, 1.2)).toBeLessThan(rise(0, 0));
        expect(rise(0, 3)).toBeCloseTo(0, 1);
        expect(out.maxM).toBeGreaterThan(t.maxM + 600);
    });

    it("grades a road bed: an even, gentle grade through rough ground", () => {
        const t = generateTerrain({ widthKm: 20, heightKm: 20, resolution: 97, seed: 11, mountainScale: 1800, islandMask: false, landBias: 0.35 });
        const line: [number, number][] = [[-6, -2], [0, 1], [6, -1]];
        const out = gradeAlongPath(t, META, line, { widthKm: 0.3, maxGrade: 0.06 });
        // Sample along the route: the edited profile is much smoother than the original.
        const steepest = (g: TerrainGrid) => {
            let worst = 0;
            let prev = at(g, ...pointAlong(line, 0));
            for (let s = 0.25; s <= nearestOnPolyline(line[0], line).total; s += 0.25) {
                const e = at(g, ...pointAlong(line, s));
                if (e > 0 && prev > 0) worst = Math.max(worst, Math.abs(e - prev) / 250);
                prev = e;
            }
            return worst;
        };
        expect(steepest(out)).toBeLessThan(steepest(t));
        expect(steepest(out)).toBeLessThan(0.12);
        // Far from the road nothing changed.
        expect(at(out, 0, 8)).toBeCloseTo(at(t, 0, 8), 1);
    });

    it("levels a plateau or a building pad and blends its edge", () => {
        const t = generateTerrain({ widthKm: 20, heightKm: 20, resolution: 81, seed: 5, islandMask: false, landBias: 0.3 });
        const pad = circlePolygon(1, 1, 1.5);
        const out = flattenArea(t, META, pad, { targetM: 333, featherKm: 0.6 });
        expect(at(out, 1, 1)).toBeCloseTo(333, 0);
        expect(at(out, 1.6, 1.2)).toBeCloseTo(333, 0);
        expect(at(out, 1, 6)).toBeCloseTo(at(t, 1, 6), 1);
    });

    it("brushes: raise builds up, lower digs, flatten levels, smooth softens", () => {
        const t = plane();
        const stroke: [number, number][] = [[-2, 0], [2, 0]];
        const up = applyBrushStroke(t, META, stroke, { mode: "raise", radiusKm: 1, strength: 1 });
        const down = applyBrushStroke(t, META, stroke, { mode: "lower", radiusKm: 1, strength: 1 });
        expect(at(up, 0, 0)).toBeGreaterThan(at(t, 0, 0) + 20);
        expect(at(down, 0, 0)).toBeLessThan(at(t, 0, 0) - 20);
        const flat = applyBrushStroke(t, META, stroke, { mode: "flatten", radiusKm: 1.2, strength: 1, targetM: 250 });
        expect(Math.abs(at(flat, 0, 0) - 250)).toBeLessThan(Math.abs(at(t, 0, 0) - 250) * 0.3);
        const bumpy = applyBrushStroke(t, META, [[0, 0]], { mode: "raise", radiusKm: 0.3, strength: 1 });
        const smooth = applyBrushStroke(bumpy, META, [[0, 0], [0.01, 0]], { mode: "smooth", radiusKm: 1, strength: 1 });
        expect(at(smooth, 0, 0) - at(t, 0, 0)).toBeLessThan(at(bumpy, 0, 0) - at(t, 0, 0));
    });
});

describe("Snap to Landscape and sculpting in the model", () => {
    it("snapped spots follow the terrain; spots with an authored elevation keep it", () => {
        const m = fresh();
        const keep = m.world.spots[0];
        const follow = m.world.spots[1];
        m.updateSpot(keep.id, { elevation: 2222 });
        expect(m.world.spots[0].snapToGround).toBe(false);
        expect(m.world.spots[1].snapToGround).not.toBe(false);
        m.pendingSculptPoints = [];
        m.sculpt.mode = "plateau";
        m.sculpt.snapToLandscape = false;
        m.sculpt.targetM = 777;
        const box: [number, number][] = [[follow.x - 1, follow.y - 1], [follow.x + 1, follow.y - 1], [follow.x + 1, follow.y + 1], [follow.x - 1, follow.y + 1]];
        expect(m.sculptShape(box)).toBe(true);
        expect(m.world.spots[1].elevation).toBe(777);
        expect(m.world.spots[0].elevation).toBe(2222);
        // Moving an unsnapped spot keeps its elevation; switching the snap back on puts it on the ground.
        m.moveSpot(keep.id, keep.x + 1, keep.y);
        expect(m.world.spots[0].elevation).toBe(2222);
        m.updateSpot(keep.id, { snapToGround: true });
        expect(m.world.spots[0].elevation).toBe(m.elevationAt(m.world.spots[0].x, m.world.spots[0].y));
    });

    it("a brush stroke over many map events is one undo step", () => {
        const m = fresh();
        const before = JSON.stringify(m.world.terrain!.data);
        m.sculpt.mode = "raise";
        m.sculptBrush([[0, 0]], false);
        m.sculptBrush([[0.5, 0]], false);
        m.sculptBrush([[1, 0]], false);
        m.sculptBrush([], true);
        expect(JSON.stringify(m.world.terrain!.data)).not.toBe(before);
        expect(m.undo()).toBe(true);
        expect(JSON.stringify(m.world.terrain!.data)).toBe(before);
    });

    it("flatten with Snap to Landscape levels to the ground where the stroke started", () => {
        const m = fresh();
        const start = m.elevationAt(-2.5, 2.0);
        m.sculpt.mode = "flatten";
        m.sculpt.snapToLandscape = true;
        m.sculpt.strength = 1;
        m.sculpt.radiusKm = 1.5;
        m.sculptBrush([[-2.5, 2.0], [-1.5, 2.0], [-0.5, 2.0]], false);
        m.sculptBrush([], true);
        expect(Math.abs(m.elevationAt(-1.5, 2.0) - start)).toBeLessThan(40);
    });
});

describe("planning marks", () => {
    it("paints a stroke, thins other surface marks, and reports coverage inside a region", () => {
        const o = emptyOverlay(20, 20);
        paintStroke(o, META, "meadow", [[-5, 0], [5, 0]], { radiusKm: 1.5, strength: 1 });
        expect(markAt(o, META, "meadow", 0, 0)).toBeGreaterThan(0.8);
        paintStroke(o, META, "forest", [[0, 0]], { radiusKm: 1, strength: 1, exclusive: true });
        expect(markAt(o, META, "forest", 0, 0)).toBeGreaterThan(0.8);
        expect(markAt(o, META, "meadow", 0, 0)).toBeLessThan(0.3);
        const box: [number, number][] = [[-6, -2], [6, -2], [6, 2], [-6, 2]];
        const cov = layerCoverage(o, META, box);
        expect(cov[0].key).toBe("meadow");
        expect(cov.find((c) => c.key === "forest")!.areaKm2).toBeGreaterThan(1);
        expect(suggestBiome(o, META, box)?.biome).toBe("plains");
    });

    it("erases, clips to a region and fills or clears a polygon", () => {
        const o = emptyOverlay(20, 20);
        const clip: [number, number][] = [[0, -5], [5, -5], [5, 5], [0, 5]];
        paintStroke(o, META, "snow", [[-3, 0], [3, 0]], { radiusKm: 1, strength: 1, clip });
        expect(markAt(o, META, "snow", -2, 0)).toBe(0);
        expect(markAt(o, META, "snow", 2, 0)).toBeGreaterThan(0.5);
        paintStroke(o, META, "snow", [[2, 0]], { radiusKm: 1, strength: 1, erase: true });
        expect(markAt(o, META, "snow", 2, 0)).toBeLessThan(0.2);
        fillPolygon(o, META, "sand", clip, 1);
        expect(markAt(o, META, "sand", 2.5, 2.5)).toBe(1);
        clearInside(o, META, clip);
        expect(markAt(o, META, "sand", 2.5, 2.5)).toBe(0);
        expect(o.layers.sand).toBeUndefined();
    });

    it("model painting is one undo step per stroke and can be confined to a region", () => {
        const m = fresh();
        const region = m.world.regions[0];
        m.paintClipRegionId = region.id;
        m.paint("forest", [[0, 0], [1, 0]], false);
        m.paint("forest", [[2, 0]], true);
        const inside = layerCoverage(m.world.overlay, m.world.meta, region.points).find((c) => c.key === "forest")?.areaKm2 ?? 0;
        const total = layerCoverage(m.world.overlay, m.world.meta).find((c) => c.key === "forest")?.areaKm2 ?? 0;
        expect(total).toBeCloseTo(inside, 5);
        expect(m.undo()).toBe(true);
        expect(m.world.overlay?.layers.forest).toBeUndefined();
    });
});

describe("codex on the map", () => {
    it("places and paints enemies and NPCs, and the codex entry knows where it is", () => {
        const m = fresh();
        const wolves = createCodexEntry("Shadow Wolves", "creature", "Pack hunters", "Grey wolves gone wrong.");
        m.addCodexEntry(wolves);
        const oak = m.world.spots.find((s) => s.id === "spot_oakhaven")!;
        m.addPlacement(createPlacement(wolves, oak.x + 0.3, oak.y));
        m.paint(codexLayerKey(wolves.id), [[oak.x - 1, oak.y], [oak.x + 1, oak.y]], true, { exclusive: false });
        m.linkCodexSpot(wolves.id, oak.id);
        const where = codexMapPresence(m.world, m.world.codex.find((c) => c.id === wolves.id)!);
        expect(where.placements).toHaveLength(1);
        expect(where.placements[0].count).toBe(4); // a pack
        expect(where.paintedKm2).toBeGreaterThan(0.5);
        expect(where.spots.map((s) => s.id)).toContain(oak.id);
        expect(m.world.spots.find((s) => s.id === oak.id)!.linkedCodexIds).toContain(wolves.id);
        const who = populationAt(m.world, oak.x, oak.y);
        expect(who[0].codex.id).toBe(wolves.id);
        expect(who[0].count).toBe(4);

        // Deleting the entry removes its placements, its painted layer and its links.
        m.deleteCodexEntry(wolves.id);
        expect(m.placements).toHaveLength(0);
        expect(m.world.overlay?.layers[codexLayerKey(wolves.id)]).toBeUndefined();
        expect(m.world.spots.find((s) => s.id === oak.id)!.linkedCodexIds).not.toContain(wolves.id);
    });
});

describe("quest planning", () => {
    it("estimates the journey over terrain and time at the objectives", () => {
        const m = fresh();
        const q = m.world.missions.find((x) => x.id === "mission_timber_beast")!;
        const a = analyzeQuest(m.world, q);
        expect(a.stops.map((s) => s.id)).toEqual(["spot_iron_gate_keep", "spot_oakhaven", "spot_oakhaven"]);
        expect(a.legs).toHaveLength(1);
        expect(a.travelMinutes).toBeGreaterThan(20);
        expect(a.totalMinutes).toBeGreaterThan(a.travelMinutes);
        expect(a.chainDepth).toBe(2);
        expect(a.summary).toMatch(/on foot/);
    });

    it("flags a defeat target that isn't on the map, and clears it once placed", () => {
        const m = fresh();
        const bear = createCodexEntry("Shadow Bear", "creature", "Shadow-infused grizzly", "");
        m.addCodexEntry(bear);
        const q = m.world.missions.find((x) => x.id === "mission_timber_beast")!;
        m.updateMission(q.id, { objectiveDetails: { spot_oakhaven: { action: "defeat", targetCodexId: bear.id, count: 1 } } });
        const warn = () => analyzeQuest(m.world, m.world.missions.find((x) => x.id === q.id)!).issues.filter((i) => i.text.includes("Shadow Bear"));
        expect(warn().length).toBe(1);
        const oak = m.world.spots.find((s) => s.id === "spot_oakhaven")!;
        m.addPlacement(createPlacement(bear, oak.x + 0.4, oak.y, { count: 1 }));
        expect(warn().length).toBe(0);
        expect(describeObjective(m.world, oak, m.world.missions.find((x) => x.id === q.id)!.objectiveDetails!.spot_oakhaven)).toBe("Defeat Shadow Bear at Oakhaven Hamlet");
    });

    it("warns when the objective is far too dangerous for the quest's level", () => {
        const m = fresh();
        const q = m.world.missions.find((x) => x.id === "mission_dragon_slayer")!;
        const caldera = m.world.spots.find((s) => s.id === "spot_drake_peak")!;
        m.addRegion({ name: "Ash", regionType: "danger", points: circlePolygon(caldera.x, caldera.y, 1), fillColor: [1, 0, 0, 0.2], borderColor: [1, 0, 0, 1], isMajor: true, dominantBiome: "volcanic", dangerLevel: 10, description: "" });
        m.updateMission(q.id, { levelMin: 2, levelMax: 4 });
        const a = analyzeQuest(m.world, m.world.missions.find((x) => x.id === q.id)!);
        expect(a.peakDanger).toBe(10);
        expect(a.issues.some((i) => i.severity === "warn" && i.text.includes("steep for a level 4 quest"))).toBe(true);
        expect(comfortableDanger(40)).toBe(9);
    });

    it("checks story order and follows outcomes to what they unlock", () => {
        const m = fresh();
        const audience = m.world.missions.find((x) => x.id === "mission_first_audience")!;
        // Requiring an Act 2 quest from an Act 1 quest is flagged.
        m.updateMission(audience.id, { prerequisiteMissionIds: [...audience.prerequisiteMissionIds, "mission_dragon_slayer"] });
        const a = analyzeQuest(m.world, m.world.missions.find((x) => x.id === audience.id)!);
        expect(a.issues.some((i) => i.text.includes("comes later in the story"))).toBe(true);
        const cargo = m.world.missions.find((x) => x.id === "mission_smugglers_cargo")!;
        m.updateMission(cargo.id, { outcomes: [{ id: "o1", label: "Turn Reza in", unlocksMissionIds: ["mission_timber_beast"] }] });
        const b = analyzeQuest(m.world, m.world.missions.find((x) => x.id === cargo.id)!);
        expect(b.unlocks.map((x) => x.id).sort()).toEqual(["mission_first_audience", "mission_timber_beast"]);
    });

    it("objective time defaults by action and count", () => {
        expect(objectiveMinutes(undefined)).toBe(2);
        expect(objectiveMinutes({ action: "talk" })).toBe(4);
        expect(objectiveMinutes({ action: "defeat", count: 5 })).toBeGreaterThan(objectiveMinutes({ action: "defeat", count: 1 }));
        expect(objectiveMinutes({ action: "defeat", minutes: 30 })).toBe(30);
    });

    it("the design document carries regional plans, population and quest detail", () => {
        const m = fresh();
        const region = m.world.regions[0];
        m.updateRegion(region.id, { plan: { climate: "Cold sea fogs", levelMin: 3, levelMax: 8 } });
        m.paint("forest", region.points.slice(0, 1), true);
        const reza = m.world.codex.find((c) => c.id === "codex_captain_reza")!;
        m.addPlacement(createPlacement(reza, 6.5, 5.2));
        m.updateMission("mission_smugglers_cargo", { giverCodexId: reza.id, hook: "Reza owes you a favor", levelMin: 2, levelMax: 4 });
        const md = generateGameDesignDoc(m.world);
        expect(md).toContain("**Climate:** Cold sea fogs");
        expect(md).toContain("**Hook:** Reza owes you a favor");
        expect(md).toContain("**Given by:** Captain");
        expect(md).toContain("*On the map:*");
    });
});
