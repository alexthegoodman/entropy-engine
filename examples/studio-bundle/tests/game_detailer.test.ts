// The Game World Detailer's core, without the engine: models for planned things, the ground up
// close (pads, road beds, rivers), the placed scene, scatter, ground tiles and levels of detail.
import { describe, expect, it } from "vitest";
import { PlannerModel } from "../src/apps/game_planner/planner_model";
import { layOutTown } from "../src/apps/game_planner/town_planning";
import { createPlacement, fillPolygon, emptyOverlay } from "../src/apps/game_planner/planning_layers";
import type { GameWorld } from "../src/apps/game_planner/planner_types";
import { lookupObject } from "../src/apps/mesha/library";
import { evaluateObject } from "../src/apps/mesha/mesha_object";
import { Ground } from "../src/apps/game_detailer/detail_ground";
import { DEFAULT_SCATTER, defaultStructureModel, fitModel, footprintPieces, kindModelTable, defaultSpotModel, defaultCategoryModel } from "../src/apps/game_detailer/detail_models";
import { buildSceneItems } from "../src/apps/game_detailer/detail_scene";
import { scatterTile, tilesAround } from "../src/apps/game_detailer/detail_scatter";
import { buildGroundTile, buildModelLods, builtinMesh, toRender, fromRender, variantKey } from "../src/apps/game_detailer/detail_mesh";
import { detailOf, emptyDetail } from "../src/apps/game_detailer/detail_types";

/** The Shattered Isles with its capital laid out, a creature placed and forest painted. */
function sampleWorld(): GameWorld {
    const model = new PlannerModel();
    const w = model.world;
    const capital = w.spots.find((s) => s.spotType === "capital") ?? w.spots[0];
    const layout = layOutTown(w, capital);
    w.structures = layout.structures;
    const creature = w.codex.find((c) => c.category === "creature") ?? w.codex[0];
    w.placements = [createPlacement(creature, capital.x + 0.4, capital.y + 0.3, { count: 3 })];
    w.overlay = emptyOverlay(w.meta.worldWidthKm, w.meta.worldHeightKm);
    fillPolygon(w.overlay, w.meta, "forest", [[capital.x - 1.5, capital.y - 1.5], [capital.x - 0.5, capital.y - 1.5], [capital.x - 0.5, capital.y - 0.5], [capital.x - 1.5, capital.y - 0.5]], 1);
    return w;
}

describe("models for planned things", () => {
    it("every default model exists and its values are its own parameters", () => {
        const choices = [
            ...kindModelTable(new PlannerModel().world).map((k) => k.model),
            ...(["fantasy", "scifi", "postapoc", "cyberpunk", "steampunk"] as const).flatMap((g) => (["house", "inn", "keep", "temple", "tower"] as const).map((k) => defaultStructureModel(g, k))),
            ...(["ruin", "shrine", "dungeon", "camp", "boss", "landmark", "port", "fortress"] as const).map(defaultSpotModel),
            ...(["character", "creature", "faction", "lore", "weapon", "power"] as const).map(defaultCategoryModel),
            ...Object.values(DEFAULT_SCATTER).flatMap((l) => l.items.map((i) => ({ objectId: i.objectId, values: i.values }))),
        ].filter((c): c is NonNullable<typeof c> => !!c);
        for (const c of choices) {
            const def = lookupObject(c.objectId);
            expect(def, c.objectId).toBeTruthy();
            for (const k of Object.keys(c.values)) expect(def!.params.some((p) => p.id === k), `${c.objectId}.${k}`).toBe(true);
        }
    });

    it("fits a house to its footprint, snapping sizes so similar ones share a mesh", () => {
        const house = defaultStructureModel("fantasy", "house")!;
        const a = fitModel(house, 10.2, 8.1, 2), b = fitModel(house, 9.9, 7.9, 2);
        expect(a.model.values.width).toBe(10);
        expect(a.model.values.depth).toBe(8);
        expect(variantKey(a.model.objectId, a.model.values, 0)).toBe(variantKey(b.model.objectId, b.model.values, 0));
        // Bigger than a house can be: it is scaled up to fill the footprint.
        expect(fitModel(house, 36, 32, 2).scale).toBeCloseTo(2, 1);
        // Shallow: one storey (no room for a stair).
        expect(fitModel(house, 10, 6.5, 2).model.values.storeys).toBe(1);
    });

    it("splits an L footprint into its two wings", () => {
        const pieces = footprintPieces({ shape: "L", widthM: 18, depthM: 14 });
        expect(pieces.length).toBe(2);
        // The front range runs along the front (+z).
        expect(pieces[0].z).toBeGreaterThan(0);
        expect(pieces[0].w).toBeCloseTo(18);
    });

    it("Mesha's house faces +z, as the Planner's footprints are turned to face the street", () => {
        const def = lookupObject("architecture.house")!;
        const e = evaluateObject(def, { porch: "portico" }, lookupObject);
        const porch = e.mesh.parts.filter((p) => p.region === "entry");
        expect(porch.length).toBeGreaterThan(0);
        let z = 0, n = 0;
        for (const p of porch) for (let i = 2; i < p.positions.length; i += 3) { z += p.positions[i]; n++; }
        expect(z / n).toBeGreaterThan(0);
    });
});

describe("the ground up close", () => {
    const world = sampleWorld();
    const ground = new Ground(world);

    it("is smooth bicubic terrain with micro-relief", () => {
        const s = world.spots[0];
        const a = ground.heightAt(s.x + 0.31, s.y + 0.27), b = ground.heightAt(s.x + 0.312, s.y + 0.27);
        expect(Number.isFinite(a)).toBe(true);
        // 2 m apart: never a cliff out of nothing.
        expect(Math.abs(a - b)).toBeLessThan(3);
    });

    it("levels the ground under a building", () => {
        const house = world.structures!.find((s) => s.kind === "house")!;
        const pad = ground.padHeight(house.id)!;
        expect(pad).not.toBeNull();
        expect(ground.heightAt(house.x, house.y)).toBeCloseTo(pad, 3);
        expect(ground.sample(house.x, house.y).surface!.occupied).toBe("building");
    });

    it("lays streets over a plaza, not in a trench under it", () => {
        const areas = world.structures!.filter((s) => s.shape === "area");
        expect(areas.length).toBeGreaterThan(0);
        for (const a of areas) {
            const pad = ground.padHeight(a.id)!;
            // The middle of a square is on its surface, streets crossing it or not.
            const pts = a.points ?? [[a.x, a.y]];
            const cx = pts.reduce((t, p) => t + p[0], 0) / pts.length, cy = pts.reduce((t, p) => t + p[1], 0) / pts.length;
            expect(Math.abs(ground.heightAt(cx, cy) - pad)).toBeLessThan(0.6);
        }
    });

    it("lays road beds and keeps them clear", () => {
        const road = world.paths.find((p) => p.pathType === "road" || p.pathType === "highway");
        if (!road) return;
        const [a, b] = road.points;
        const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const s = ground.sample(mid[0], mid[1]);
        expect(["road", "water", "building", "area"]).toContain(s.surface!.occupied);
    });

    it("carves rivers below their banks", () => {
        const river = world.paths.find((p) => p.pathType === "river");
        if (!river) return;
        const p = river.points[Math.floor(river.points.length / 2)];
        expect(ground.heightAt(p[0], p[1])).toBeLessThan(ground.baseHeight(p[0], p[1]));
    });
});

describe("the placed scene", () => {
    const world = sampleWorld();
    const ground = new Ground(world);
    const detail = detailOf(world);

    it("details a laid-out capital from defaults", () => {
        const items = buildSceneItems(world, detail, ground);
        const buildings = items.filter((i) => i.source === "structure" && i.model);
        expect(buildings.length).toBeGreaterThan(20);
        expect(items.some((i) => i.builtin?.kind === "wall")).toBe(world.structures!.some((s) => s.kind === "wall"));
        // Three creatures for a pack of three.
        expect(items.filter((i) => i.source === "placement").length).toBe(3);
        for (const i of items) expect(Number.isFinite(i.elevation) && Number.isFinite(i.x) && Number.isFinite(i.yaw)).toBe(true);
    });

    it("uses a kind's model, then one building's own", () => {
        const d = detailOf(JSON.parse(JSON.stringify(world)));
        const house = world.structures!.find((s) => s.kind === "house")!;
        d.models["structure:house"] = { objectId: "architecture.city_block", values: { floors: 3 } };
        let items = buildSceneItems(world, d, ground);
        expect(items.find((i) => i.sourceId === house.id)!.model!.objectId).toBe("architecture.city_block");
        d.bindings[house.id] = { model: { objectId: "architecture.arcane_emporium", values: {} }, yawDeg: 15 };
        items = buildSceneItems(world, d, ground);
        const it = items.find((i) => i.sourceId === house.id)!;
        expect(it.model!.objectId).toBe("architecture.arcane_emporium");
        expect(it.origin).toBe("binding");
        expect(it.yaw).toBeCloseTo(((house.rotationDeg + 15) * Math.PI) / 180);
    });

    it("places props on the ground", () => {
        const d = emptyDetail();
        const s = world.spots[0];
        d.props.push({ id: "p1", objectId: "street.barrel", values: {}, x: s.x + 0.01, y: s.y, lift: 0.5, yawDeg: 0, scale: 1 });
        const prop = buildSceneItems(world, d, ground).find((i) => i.source === "prop")!;
        expect(prop.elevation).toBeCloseTo(ground.heightAt(s.x + 0.01, s.y) + 0.5, 5);
    });
});

describe("scatter", () => {
    const world = sampleWorld();
    const ground = new Ground(world);
    const detail = detailOf(world);
    const capital = world.spots.find((s) => s.spotType === "capital") ?? world.spots[0];

    it("grows the painted forest, the same way every time", () => {
        const tiles = tilesAround(capital.x - 1, capital.y - 1, 0.3, 0.128);
        const a = tiles.flatMap(([tx, ty]) => scatterTile(ground, detail, tx, ty, 0.128));
        const b = tiles.flatMap(([tx, ty]) => scatterTile(ground, detail, tx, ty, 0.128));
        expect(a.length).toBeGreaterThan(50);
        expect(a).toEqual(b);
        expect(a.some((i) => i.model.objectId === "nature.tree")).toBe(true);
        // Few variants: many instances share each mesh.
        expect(new Set(a.map((i) => i.variantKey)).size).toBeLessThan(20);
    });

    it("thins with density and keeps off buildings and roads", () => {
        const [tx, ty] = tilesAround(capital.x - 1, capital.y - 1, 0.05, 0.128)[0];
        const full = scatterTile(ground, detail, tx, ty, 0.128, { density: 1 }).length;
        const thin = scatterTile(ground, detail, tx, ty, 0.128, { density: 0.25 }).length;
        expect(thin).toBeLessThan(full);
        for (const i of scatterTile(ground, detail, tx, ty, 0.128)) expect(ground.sample(i.x, i.y).surface!.occupied).toBeNull();
    });

    it("grows nothing where nothing is painted", () => {
        const tiles = tilesAround(capital.x + 3, capital.y + 3, 0.2, 0.128);
        expect(tiles.flatMap(([tx, ty]) => scatterTile(ground, detail, tx, ty, 0.128)).length).toBe(0);
    });
});

describe("meshes", () => {
    const world = sampleWorld();
    const ground = new Ground(world);
    const origin = { x: world.spots[0].x, y: world.spots[0].y };

    it("round-trips the render frame", () => {
        const [rx, rz] = toRender(origin, origin.x + 0.25, origin.y + 0.1);
        expect(rx).toBeCloseTo(250);
        expect(rz).toBeCloseTo(-100);
        const [x, y] = fromRender(origin, rx, rz);
        expect(x).toBeCloseTo(origin.x + 0.25);
        expect(y).toBeCloseTo(origin.y + 0.1);
    });

    it("builds a ground tile with skirts and the ground pattern", () => {
        const t = buildGroundTile(ground, origin, origin.x, origin.y, 0.128, 16);
        const n = 17 * 17;
        // Grid vertices plus four skirts.
        expect(t.vertexData.length / 12).toBe(n + 4 * 17);
        expect(t.triangles).toBe(16 * 16 * 2 + 4 * 16 * 2);
        // Normal length 31 = ground pattern 30.
        expect(Math.hypot(t.vertexData[3], t.vertexData[4], t.vertexData[5])).toBeCloseTo(31, 3);
        for (const v of t.vertexData) expect(Number.isFinite(v)).toBe(true);
    });

    it("makes levels of detail that get much lighter", () => {
        const lods = buildModelLods("nature.tree", {});
        expect(lods.lods.length).toBe(3);
        expect(lods.lods[2].triangles).toBeLessThan(lods.lods[0].triangles * 0.5);
        expect(lods.radius).toBeGreaterThan(1);
    });

    it("builds builtins standing on the ground", () => {
        const wall = builtinMesh({ kind: "wall", size: [10, 6, 4] });
        let minY = Infinity;
        for (let i = 1; i < wall.vertexData.length; i += 12) minY = Math.min(minY, wall.vertexData[i]);
        expect(minY).toBeCloseTo(0, 3);
        expect(builtinMesh({ kind: "well", size: [4, 1.1, 4] }).triangles).toBeGreaterThan(10);
    });
});
