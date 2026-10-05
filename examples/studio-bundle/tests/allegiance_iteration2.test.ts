// Allegiance, second round of upgrades: enemies whose aim settles in, the car you can call,
// aiming (smoothed turning, aim down sights, aim assist), trees kept off the roads, Mesha city
// buildings on the map's footprints, leafy trees with matching distance meshes, and furniture.
import { describe, expect, it } from "vitest";
import { newStreet, stepStreet, spawnGuards, aimSettle, guardAccuracy, AIM_SETTLE, type StreetContext } from "../src/games/allegiance/al_street";
import { newCar, callCar, stepCall, callEta, callAltitude, flightClear, openSky, parkBeside, CALL_CLEARANCE, type FlightEnvironment } from "../src/games/allegiance/al_vehicle";
import {
    newLook, addMouse, stepLook, stepAds, adsFov, stickCurve, pickAssistTarget, assistFriction, assistPull, bendAngle, adsSpread, adsMove,
    HIP_FOV, ADS_FOV, ADS_TIME, MOUSE_YAW,
} from "../src/games/allegiance/al_aim";
import {
    RoadMask, roadSegments, roadMargin, scatterAround, scatterMesh, foliageKey, foliageValues, foliageLods, FOLIAGE, FoliageMeshes, PROPS, cacheProps, BROADLEAF,
} from "../src/games/allegiance/al_scatter";
import { evaluateObject, resolveParams, defaultValues } from "../src/apps/mesha/mesha_object";
import { lookupObject } from "../src/apps/mesha/library";
import cityBlock from "../src/apps/mesha/library/city_block";
import { buildingValues, buildingStyle, storeysFor, packBuilding, modelHeight, BUILDING_MODEL, BUILDING_SIZE } from "../src/apps/quadplanet/qp_buildings";
import { CityHouses, HOUSE_MODEL, MAT_GLASS, type CityBuilding, type CityEngine } from "../src/apps/quadplanet/qp_city";
import { packWorld } from "../src/apps/quadplanet/qp_shader";
import { makeRng } from "../src/games/allegiance/al_rng";
import type { Rect } from "../src/games/allegiance/al_nav";

const ctx = (): StreetContext => ({ partyShare: 0.1, rivalShares: {}, atWar: false, heat: 0, enemyQuality: 0.5, followers: [], playerWeapon: "rifle", calm: true });

describe("enemy aim settles in", () => {
    it("starts rattled and tightens over a few seconds on one target", () => {
        expect(aimSettle(0)).toBeCloseTo(0.2, 5);
        expect(aimSettle(AIM_SETTLE)).toBeCloseTo(1, 5);
        expect(aimSettle(AIM_SETTLE / 2)).toBeGreaterThan(aimSettle(1));
        for (let t = 0; t < AIM_SETTLE; t += 0.25) expect(aimSettle(t + 0.25)).toBeGreaterThanOrEqual(aimSettle(t));
        expect(guardAccuracy(0.5, true)).toBeCloseTo(guardAccuracy(0.5, false) / 2, 5);
    });
    it("lands far fewer hits in the first seconds of a fight than once settled", () => {
        // Many short fights against fresh guards versus the same guards already on target.
        const hitsIn = (settled: boolean) => {
            let hits = 0;
            for (let trial = 0; trial < 30; trial++) {
                const st = newStreet(), r = makeRng(100 + trial);
                st.civilianTarget = 0;
                st.player.x = 0; st.player.z = 25;
                st.player.health = 1e9;
                spawnGuards(st, ctx(), r, "mil-t", [[0, 0], [3, 0], [-3, 0]]);
                for (const g of st.actors) { g.alerted = true; if (settled) { g.aim = 30; g.aimAt = -1; } }
                for (let i = 0; i < 20; i++) { stepStreet(st, null, ctx(), 0.1, r, () => 0); hits += st.events.filter(e => e.kind === "player-hit").length; }
            }
            return hits;
        };
        const fresh = hitsIn(false), settled = hitsIn(true);
        expect(settled).toBeGreaterThan(fresh * 2);
    });
    it("makes the founding outpost's guards green conscripts", () => {
        const st = newStreet(), r = makeRng(4);
        spawnGuards(st, ctx(), r, "outpost-x", [[0, 0]], true);
        spawnGuards(st, ctx(), r, "mil-x", [[5, 0]]);
        expect(st.actors[0].accuracy).toBeLessThan(st.actors[1].accuracy * 0.6);
    });
});

describe("calling your car", () => {
    const tower: Rect = { cx: 50, cz: 0, ux: 1, uz: 0, hw: 8, hd: 8, height: 60, base: 0, key: "tower", door: [50, 9] };
    const env: FlightEnvironment = { height: () => 0, sea: () => false, buildings: [tower] };
    it("climbs over the rooftops on its way, flies to you and lands on the spot", () => {
        const c = newCar({ x: 0, y: 0.22, z: 0, yaw: 0 });
        expect(callAltitude(c, 100, 0, env)).toBeGreaterThan(60);
        expect(callAltitude(c, 0, 100, { ...env, buildings: [] })).toBeCloseTo(0.22 + 20, 1);
        expect(callAltitude(c, 0, 1000, { ...env, buildings: [] })).toBeCloseTo(0.22 + CALL_CLEARANCE, 1);
        // A tower beside the path (not under it) doesn't lift the cruise.
        expect(callAltitude(c, 0, 100, { ...env, buildings: [{ ...tower, cx: 30, cz: 50 }] })).toBeCloseTo(0.22 + 20, 1);
        callCar(c, { x: 100, y: 0.22, z: 0, yaw: Math.PI / 2 }, env);
        expect(c.call?.phase).toBe("climb");
        const eta = callEta(c, env);
        expect(eta).toBeGreaterThan(5);
        let landed = false, t = 0;
        for (; t < 120 && !landed; t += 1 / 30) {
            landed = stepCall(c, 1 / 30, env);
            expect(flightClear(c, env)).toBe(true);
        }
        expect(landed).toBe(true);
        expect(c.call).toBeNull();
        expect(c.state).toBe("parked");
        expect(Math.hypot(c.x - 100, c.z)).toBeLessThan(1);
        expect(c.y).toBeCloseTo(0.22, 1);
        expect(t).toBeLessThan(eta * 2 + 10);
    });
    it("lands only where the sky is open: never under or against a tall building's walls", () => {
        const walkable = (x: number, z: number) => !(Math.abs(x - tower.cx) < tower.hw + 0.5 && Math.abs(z - tower.cz) < tower.hd + 0.5);
        const spot = parkBeside(40, 0, walkable, () => 0, car => openSky(car, [tower]))!;
        expect(spot).not.toBeNull();
        expect(openSky(spot.car, [tower])).toBe(true);
        // Its rotors clear the tower all the way down.
        for (let y = 0.22; y < 70; y += 2) expect(flightClear({ ...spot.car, y }, env)).toBe(true);
        expect(openSky({ x: 40, y: 0, z: 0, yaw: 0 }, [tower])).toBe(false);
    });
    it("reports a blocked descent so another spot can be chosen", () => {
        const c = newCar({ x: 0, y: 80, z: 0, yaw: 0 });
        callCar(c, { x: 50 - 8 - 1, y: 0.22, z: 0, yaw: 0 }, env);
        for (let i = 0; i < 30 * 30 && !(c.call?.stuck ?? 0); i++) stepCall(c, 1 / 30, env);
        expect(c.call?.phase).toBe("descend");
        expect(c.call?.stuck).toBeGreaterThan(0);
    });
    it("does nothing while you fly it yourself", () => {
        const c = newCar({ x: 0, y: 0.22, z: 0, yaw: 0 });
        callCar(c, { x: 50, y: 0.22, z: 0, yaw: 0 }, env);
        c.piloting = true;
        expect(stepCall(c, 1, env)).toBe(false);
        expect(c.x).toBe(0);
    });
});

describe("aiming", () => {
    it("glides mouse motion out over a few frames, losing none of it", () => {
        const s = newLook();
        addMouse(s, 100, 0);
        let total = 0;
        const first = stepLook(s, 0, 0, 1 / 60).yaw;
        total += first;
        expect(first).toBeGreaterThan(0);
        expect(first).toBeLessThan(100 * MOUSE_YAW * 0.6);
        for (let i = 0; i < 60; i++) total += stepLook(s, 0, 0, 1 / 60).yaw;
        expect(total).toBeCloseTo(100 * MOUSE_YAW, 3);
    });
    it("eases the stick up to speed, with a curve for fine aim", () => {
        expect(stickCurve(0.3)).toBeLessThan(0.3 * 0.5);
        expect(stickCurve(1)).toBe(1);
        expect(stickCurve(-0.5)).toBeCloseTo(-Math.pow(0.5, 1.8), 6);
        const s = newLook();
        const rates: number[] = [];
        for (let i = 0; i < 30; i++) rates.push(stepLook(s, 1, 0, 1 / 60).yaw * 60);
        expect(rates[0]).toBeLessThan(rates[10]);
        expect(rates[29]).toBeGreaterThan(rates[10] * 0.99);
        // Let go: it slows down rather than stopping dead.
        const after = stepLook(s, 0, 0, 1 / 60).yaw;
        expect(after).toBeGreaterThan(0);
    });
    it("raises the sights over ADS_TIME: narrower view, slower turning, tighter spread", () => {
        const s = newLook();
        expect(adsFov(s)).toBe(HIP_FOV);
        for (let t = 0; t < ADS_TIME + 0.05; t += 1 / 60) stepAds(s, true, 1 / 60);
        expect(s.ads).toBe(1);
        expect(adsFov(s)).toBe(ADS_FOV);
        expect(adsSpread(1)).toBeLessThan(0.5);
        expect(adsMove(1)).toBeLessThan(0.6);
        const hip = newLook(), ads = s;
        addMouse(hip, 100, 0); addMouse(ads, 100, 0);
        expect(ads.pendingYaw).toBeLessThan(hip.pendingYaw);
    });
    it("picks the soldier nearest the crosshair, slows over them and draws onto them", () => {
        const eye: [number, number, number] = [0, 1.6, 0];
        const soldiers = [{ id: 1, x: 0.8, y: 0, z: 30 }, { id: 2, x: -12, y: 0, z: 30 }];
        // Looking straight ahead (+Z), soldier 1 is a degree and a half off; soldier 2 well outside the cone.
        const pick = pickAssistTarget(eye, 0, 0, soldiers, 0.5, 0, 200);
        expect(pick?.target.id).toBe(1);
        expect(pickAssistTarget(eye, 0, 0, soldiers, 0, 0, 200)).toBeNull();
        expect(pickAssistTarget(eye, 0, 0, soldiers, 0.5, 0, 200, () => false)).toBeNull();
        expect(pickAssistTarget(eye, Math.PI, 0, soldiers, 1, 1, 200)).toBeNull();
        expect(assistFriction(pick, 0.5)).toBeGreaterThan(0);
        expect(assistFriction(pick, 0.5)).toBeLessThan(assistFriction(pick, 1));
        // Magnetism only while aiming down sights or firing, toward the target, never past it.
        expect(assistPull(pick, 0.5, 0, false, 1 / 60).yaw).toBe(0);
        let yaw = 0, pitch = 0;
        for (let i = 0; i < 120; i++) {
            const p = pickAssistTarget(eye, yaw, pitch, soldiers, 0.8, 1, 200);
            if (!p) break;
            const d = assistPull(p, 0.8, 1, false, 1 / 60);
            yaw += d.yaw; pitch += d.pitch;
        }
        const final = pickAssistTarget(eye, yaw, pitch, soldiers, 0.8, 1, 200)!;
        expect(final.angle).toBeLessThan(pick!.angle * 0.2);
        expect(final.angle).toBeLessThan(bendAngle(0.8));
    });
});

describe("roads stay clear", () => {
    const mask = new RoadMask(roadSegments([{ points: [[0, -0.001], [0, 0.001]], width: 8, street: true }], (lat, lon) => [lon * 111320, lat * 110540]));
    it("knows a road's surface and its verge", () => {
        expect(mask.segments).toBe(1);
        expect(mask.covers(0, 0)).toBe(true);
        expect(mask.covers(50, 3.9)).toBe(true);
        expect(mask.covers(50, 4.5)).toBe(false);
        expect(mask.covers(50, 4.5, roadMargin("tree-oak"))).toBe(true);
        expect(mask.covers(500, 0)).toBe(false);
    });
    it("plants nothing on the road, and lines it with street trees", () => {
        const items = scatterAround([], { walkable: () => true, roads: mask, origin: { lat: 0, lon: 0 }, area: { x: 0, z: 0, half: 120 } });
        expect(items.length).toBeGreaterThan(0);
        for (const it of items) expect(mask.covers(it.x, it.z, roadMargin(it.family) - 0.01)).toBe(false);
        const verge = items.filter(it => Math.abs(it.z) < 9 && Math.abs(it.x) < 100 && (BROADLEAF.includes(it.family) || it.family === "conifer"));
        expect(verge.length).toBeGreaterThan(6);
        // Deterministic.
        expect(scatterAround([], { walkable: () => true, roads: mask, origin: { lat: 0, lon: 0 }, area: { x: 0, z: 0, half: 120 } })).toEqual(items);
    });
});

describe("Mesha foliage and furniture", () => {
    it("uses only full-leaf trees, with distance meshes grown from the same tree", () => {
        for (const f of FOLIAGE.filter(f => f.object === "nature.tree")) {
            expect(f.values.canopy ?? "leaves").toBe("leaves");
            expect(foliageLods(f)).toEqual([0, 1, 2]);
            // Same seed and branching at every LOD: only the leaves change.
            for (const lod of [1, 2] as const) {
                const v = foliageValues(f, lod);
                expect(v.seed).toBe(f.values.seed);
                expect(v.levels).toBe(f.values.levels);
                expect(Number(v.leafSize)).toBeGreaterThan(Number(f.values.leafSize ?? 0.26));
            }
        }
        expect(FOLIAGE.some(f => f.family === "tree-round" || f.family === "tree-oval")).toBe(false);
        const oak = FOLIAGE.find(f => f.family === "tree-oak")!;
        expect(scatterMesh("tree-oak", 10)).toBe(foliageKey(oak, 0));
        expect(scatterMesh("tree-oak", 60)).toBe(foliageKey(oak, 1));
        expect(scatterMesh("tree-oak", 200)).toBe(foliageKey(oak, 2));
        expect(scatterMesh("tree-oak", 1000)).toBeNull();
        expect(scatterMesh("cafe-chair", 10)).toContain("furniture.office_chair");
    });
    it("caches every LOD, evaluating a LOD with its own values once and simplifying the rest", () => {
        const store = new Map<string, { simplify: boolean }>();
        const cache = {
            status: (_ns: string, k: string) => (store.has(k) ? "ready" as const : "missing" as const),
            put: (_ns: string, k: string, _m: unknown, o?: { simplify?: unknown }) => { store.set(k, { simplify: !!o?.simplify }); },
            failure: () => null,
        };
        const grass = evaluateObject(lookupObject("nature.grass")!, {}, lookupObject);
        const seen: string[] = [];
        const f = new FoliageMeshes(cache, (spec, values) => { seen.push(`${spec.family}:${values.leafSize ?? ""}`); return grass; });
        let frames = 0;
        while (!f.prepare() && frames < 200) frames++;
        const lods = FOLIAGE.reduce((n, s) => n + foliageLods(s).length, 0);
        expect(store.size).toBe(lods);
        const ownLods = FOLIAGE.reduce((n, s) => n + 1 + (s.lod1 ? 1 : 0) + (s.lod2 ? 1 : 0), 0);
        expect(seen).toHaveLength(ownLods);
        expect([...store.entries()].filter(([k]) => !k.endsWith("lod0")).every(([, v]) => v.simplify)).toBe(true);
    });
    it("furnishes cafes on the pavement, chairs facing their table", () => {
        const rects: Rect[] = Array.from({ length: 60 }, (_, i) => ({ cx: (i % 10) * 40, cz: Math.floor(i / 10) * 40, ux: 1, uz: 0, hw: 8, hd: 6, height: 12, base: 0, key: `shop-${i}`, door: [(i % 10) * 40, Math.floor(i / 10) * 40 + 7.6], kind: "box" }));
        const items = scatterAround(rects, { walkable: (x, z) => !rects.some(r => Math.abs(x - r.cx) < r.hw + 0.3 && Math.abs(z - r.cz) < r.hd + 0.3) });
        const tables = items.filter(i => i.family === "cafe-table");
        const chairs = items.filter(i => i.family === "cafe-chair");
        expect(tables.length).toBeGreaterThan(3);
        expect(chairs.length).toBeGreaterThanOrEqual(tables.length * 2);
        for (const ch of chairs) {
            const t = tables.reduce((a, b) => (Math.hypot(a.x - ch.x, a.z - ch.z) < Math.hypot(b.x - ch.x, b.z - ch.z) ? a : b));
            // The chair's front (+Z rotated by yaw) points at the table.
            const fx = Math.sin(ch.yaw), fz = Math.cos(ch.yaw);
            expect((t.x - ch.x) * fx + (t.z - ch.z) * fz).toBeGreaterThan(0);
        }
    });
    it("builds the compound's buildings from Mesha's city building", () => {
        for (const k of ["mil-hq", "mil-barracks", "mil-depot", "mil-hangar"]) {
            const m = PROPS[k]();
            expect(m.vertexData.length / 12).toBeGreaterThan(400);
            // Turned to face -Z: the door (and anything in front) is on the -Z side.
            let minZ = Infinity, maxZ = -Infinity;
            for (let i = 0; i < m.vertexData.length; i += 12) { minZ = Math.min(minZ, m.vertexData[i + 2]); maxZ = Math.max(maxZ, m.vertexData[i + 2]); }
            expect(-minZ).toBeGreaterThanOrEqual(maxZ - 1e-4);
        }
        const props = new Map<string, unknown>();
        expect(cacheProps({ status: (_n, k) => (props.has(k) ? "ready" : "missing"), put: (_n, k, m) => { props.set(k, m); }, failure: () => null })).toBe(Object.keys(PROPS).length);
    });
});

describe("Mesha city buildings", () => {
    const placement = (over: Partial<CityBuilding> = {}): CityBuilding => ({
        key: "b", seed: 12345, kind: "box", anchor: [0, 6371000, 0], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1],
        width: 20, depth: 14, height: 18, minHeight: 0, groundMin: 0, groundMax: 0.5, area: 280, fill: 1, colour: null, lat: 51.5, lon: 0, distance: 10, ...over,
    });
    it("evaluates every style within its triangle limit, standing on the ground, front to +Z", () => {
        for (const p of cityBlock.presets!) {
            const e = evaluateObject(cityBlock, resolveParams(cityBlock, { ...defaultValues(cityBlock), ...p.values }), lookupObject);
            const tris = e.mesh.parts.reduce((n, q) => n + q.indices.length / 3, 0);
            expect(tris).toBeGreaterThan(800);
            expect(tris).toBeLessThan(cityBlock.limits!.maxTriangles!);
            let minY = Infinity, maxZ = -Infinity, minZ = Infinity;
            for (const q of e.mesh.parts) for (let i = 0; i < q.positions.length; i += 3) { minY = Math.min(minY, q.positions[i + 1]); maxZ = Math.max(maxZ, q.positions[i + 2]); minZ = Math.min(minZ, q.positions[i + 2]); }
            expect(minY).toBeCloseTo(0, 3);
            expect(maxZ).toBeGreaterThanOrEqual(-minZ - 1e-4);
        }
        const tower = evaluateObject(cityBlock, resolveParams(cityBlock, { ...defaultValues(cityBlock), width: 60, depth: 40, floors: 30 }), lookupObject);
        expect(tower.mesh.parts.reduce((n, q) => n + q.indices.length / 3, 0)).toBeLessThan(150_000);
    });
    it("gives a placement a style, storeys and a snapped size, deterministically", () => {
        expect(buildingStyle(placement({ height: 80 }))).toMatch(/Glass office|Concrete block/);
        expect(buildingStyle(placement({ width: 60, depth: 40, height: 9 }))).toBe("Warehouse");
        expect(storeysFor(4.4, 4.4, 3.3)).toBe(1);
        expect(storeysFor(4.4 + 3.3 * 4, 4.4, 3.3)).toBe(5);
        const v = buildingValues(placement())!;
        expect(v).toEqual(buildingValues(placement()));
        expect(Number(v.width) % 2).toBe(0);
        expect(Math.abs(modelHeight(v) - 18)).toBeLessThan(4);
        expect(buildingValues(placement({ minHeight: 5 }))).toBeNull();
        expect(buildingValues(placement({ width: BUILDING_SIZE.max + 10 }))).toBeNull();
        expect(BUILDING_MODEL.fitHeight!(placement({ height: 400 }), v)).toBe(1.5);
    });
    it("packs glazing as opaque glass", () => {
        const e = evaluateObject(cityBlock, resolveParams(cityBlock, defaultValues(cityBlock)), lookupObject);
        const p = packBuilding(e, 1);
        const materials = new Set<number>();
        for (let i = 0; i < p.vertexData.length; i += 12) materials.add(Math.floor(p.vertexData[i + 6]));
        expect(materials.has(MAT_GLASS)).toBe(true);
    });
    it("streams them on the map's boxes with CityHouses, and folds the boxes they replace", () => {
        const puts: string[] = [];
        const ready = new Set<string>();
        const created: string[] = [];
        const engine: CityEngine = {
            buildings: () => [placement({ key: "a", distance: 20 }), placement({ key: "h", kind: "house", distance: 15 }), placement({ key: "c", seed: 9, width: 40, depth: 30, height: 9, distance: 90 })],
            status: (_ns, k) => (ready.has(k) ? "ready" : "missing"),
            put: (ns, k) => { expect(ns).toBe(BUILDING_MODEL.namespace); puts.push(k); ready.add(k); },
            info: () => ({ triangleCount: 5000 }),
            instances: {
                createBuffer: () => "buf", destroyBuffer: () => {}, writeBuffer: () => {},
                createMesh: (key: string) => { created.push(key); return ready.has(key); }, clearMesh: () => {}, setInstanceCount: () => {},
            },
            now: () => 0,
        };
        const city = new CityHouses(engine, { lod0Radius: 50, lod1Radius: 300, sizeStep: 2 }, BUILDING_MODEL);
        const hide = city.update([0, 6371000, 0], [0, 0, 0], 1, Infinity);
        expect(puts.every(k => k.startsWith(BUILDING_MODEL.generator))).toBe(true);
        expect(city.lastStats.candidates).toBe(2);
        expect(city.lastStats.lod0 + city.lastStats.lod1).toBe(2);
        expect(hide).toBeGreaterThan(90);
        expect(HOUSE_MODEL.kind).toBe("house");
        // The shader's fold radius for these boxes rides in the World uniform's city.z.
        const w = packWorld({ sunDir: [0, 1, 0], time: 0, sunColor: [1, 1, 1], exposure: 1, debugLod: false, planets: [], city: { hideRadius: 10, roadDistance: 3000, buildingHideRadius: 123 } });
        expect(Array.from(w).includes(123)).toBe(true);
    });
});
