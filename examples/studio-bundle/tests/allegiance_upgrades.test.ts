// The Allegiance upgrades: boost that builds up, car upgrades, inventory, shops and house loot,
// military compounds and their capture, the founding mission, membership dynamics, entering
// houses, sky markers and the mini map, set dressing, guards, and the slower speech marker.
import { describe, expect, it } from "vitest";
import { newCampaign, discoverSettlement, partyShare, migrateCampaign, FOUNDING_COMRADES, type Campaign } from "../src/games/allegiance/al_state";
import { PARTY, REGIONS, regionDefById } from "../src/games/allegiance/al_data";
import { advanceDay, applySpeech, memberFlow, takeRegion, loseRegion } from "../src/games/allegiance/al_world";
import { newCar, stepCar, carSpec, boostSpeed, BASE_CAR, CAR_UPGRADES, type FlightEnvironment } from "../src/games/allegiance/al_vehicle";
import { NO_PLAYER_INPUT, newBody } from "../src/games/allegiance/al_player";
import {
    ITEMS, addItem, itemCount, useItem, quickHealItem, shopForBuilding, shopStock, buyStock, buyCarUpgrade, sellItem, houseLoot, takeHouseLoot, isLooted, SHOP_EVERY,
} from "../src/games/allegiance/al_items";
import {
    compoundBuildings, compoundGarrison, compoundPlan, compoundLayout, compoundToLocal, findClearSite, stepCapture, defenderDown, reinforceCompounds,
    ensureCompound, compoundsNear, offsetLatLon, RAISE_SECONDS,
} from "../src/games/allegiance/al_military";
import { startFoundingMission, updateMission, missionObjective, missionDistance, MISSION_REWARD } from "../src/games/allegiance/al_mission";
import { houseAtDoor, entryPoint, exitPoint, clampInside, atDoorInside, enterable, toU, toV, doorSide } from "../src/games/allegiance/al_interior";
import { cameraBasis, calibrate, project, skyMarkers, miniMapRuns, toMapCell } from "../src/games/allegiance/al_markers";
import { scatterAround, scatterMesh, foliageKey, FOLIAGE, FoliageMeshes, packFoliage, cacheProps, PROPS, batchKey, meshOfBatch, SCATTER_NAMESPACE } from "../src/games/allegiance/al_scatter";
import { newStreet, stepStreet, spawnGuards, guardsOf, playerShoot, type StreetContext } from "../src/games/allegiance/al_street";
import { startSpeech, chooseCard, MARKER_SPEED } from "../src/games/allegiance/al_speech";
import { weaponById } from "../src/games/allegiance/al_data";
import { angularDistance, EARTH_RADIUS_KM } from "../src/games/allegiance/al_state";
import { makeRng } from "../src/games/allegiance/al_rng";
import { evaluateObject } from "../src/apps/mesha/mesha_object";
import { lookupObject } from "../src/apps/mesha/library";
import type { Rect } from "../src/games/allegiance/al_nav";
import { Painter } from "../src/games/allegiance/al_ui";
import { UiFrame, drawScreen, layoutMarkers, type GameView, type Mode } from "../src/games/allegiance/al_screens";

const flat: FlightEnvironment = { height: () => 0, sea: () => false, buildings: [] };
const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => angularDistance(a.lat, a.lon, b.lat, b.lon) * EARTH_RADIUS_KM;
const rect = (over: Partial<Rect> = {}): Rect => ({ cx: 0, cz: 0, ux: 1, uz: 0, hw: 5, hd: 4, height: 6, base: 0, key: "house-1", door: [0, 5.6], kind: "house", ...over });

describe("flying car boost and upgrades", () => {
    const fly = (spec = BASE_CAR, seconds = 1, sprint = true) => {
        const c = newCar({ x: 0, z: 0, y: 200, yaw: 0 }); c.piloting = true;
        const speeds: number[] = [];
        for (let i = 0; i < seconds * 60; i++) { stepCar(c, { ...NO_PLAYER_INPUT, forward: true, sprint }, false, 1 / 60, flat, spec); if (i % 60 === 59) speeds.push(Math.hypot(c.vx, c.vz)); }
        return { c, speeds };
    };
    it("builds boost up over time to a much higher top speed for long distances", () => {
        const { c, speeds } = fly(BASE_CAR, 12);
        expect(speeds[0]).toBeLessThan(45);
        for (let i = 1; i < speeds.length; i++) expect(speeds[i]).toBeGreaterThanOrEqual(speeds[i - 1] - 0.01);
        expect(speeds[speeds.length - 1]).toBeGreaterThan(BASE_CAR.boostMax * 0.95);
        expect(c.boost).toBe(1);
        // Cruise without boost stays at cruising speed; the boost bleeds off.
        for (let i = 0; i < 240; i++) stepCar(c, { ...NO_PLAYER_INPUT, forward: true }, false, 1 / 60, flat);
        expect(Math.hypot(c.vx, c.vz)).toBeCloseTo(BASE_CAR.cruise, 0);
        expect(c.boost).toBeLessThan(0.1);
    });
    it("needs to be moving to charge, and upgrades raise speed, ramp, climb and ceiling", () => {
        const idle = newCar({ x: 0, z: 0, y: 50, yaw: 0 }); idle.piloting = true;
        for (let i = 0; i < 120; i++) stepCar(idle, { ...NO_PLAYER_INPUT, sprint: true }, false, 1 / 60, flat);
        expect(idle.boost).toBe(0);
        const top = carSpec({ turbine: 3, capacitor: 3, gyro: 3, lift: 3, ceiling: 3 });
        expect(top.boostMax).toBe(250); expect(top.boostRamp).toBe(3); expect(top.cruise).toBe(40); expect(top.climb).toBe(22); expect(top.ceiling).toBe(2500);
        expect(fly(top, 4).speeds[3]).toBeGreaterThan(fly(BASE_CAR, 4).speeds[3] * 1.5);
        expect(boostSpeed(BASE_CAR, 0)).toBe(BASE_CAR.boostStart);
        expect(carSpec({ turbine: 9 })).toEqual(carSpec({ turbine: 3 }));
        const c = newCar({ x: 0, z: 0, y: 900, yaw: 0 }); c.piloting = true;
        for (let i = 0; i < 300; i++) stepCar(c, { ...NO_PLAYER_INPUT, jump: true }, false, 1 / 60, flat, carSpec({ ceiling: 1 }));
        expect(c.y).toBeLessThanOrEqual(1000.3);
    });
    it("buys upgrade tiers in order at the garage", () => {
        const c = newCampaign({ seed: 1, spawn: "london" });
        c.party.funds = 100000;
        for (let t = 0; t < 3; t++) expect(buyCarUpgrade(c, "turbine")).toBeNull();
        expect(c.player.carUpgrades!.turbine).toBe(3);
        expect(buyCarUpgrade(c, "turbine")).toContain("fully");
        expect(c.party.funds).toBe(100000 - CAR_UPGRADES[0].prices.reduce((a, b) => a + b, 0));
        c.party.funds = 0;
        expect(buyCarUpgrade(c, "lift")).toContain("costs");
    });
});

describe("inventory, shops and loot", () => {
    it("starts with supplies, uses items on you, and quick-heals with the right item", () => {
        const c = newCampaign({ seed: 2, spawn: "london" });
        expect(itemCount(c, "medkit")).toBe(2);
        const t = { health: 30, armor: 0, stamina: 0.2 };
        expect(useItem(c, "medkit", t)).toBe("Used Field Medkit.");
        expect(t.health).toBe(90);
        expect(itemCount(c, "medkit")).toBe(1);
        expect(useItem(c, "armor-patch", t)).toContain("!");
        addItem(c, "stim"); useItem(c, "stim", t);
        expect(t.stamina).toBe(1);
        expect(quickHealItem(c, 100)).toBeNull();
        expect(quickHealItem(c, 20)).toBe("medkit");
        expect(quickHealItem(c, 90)).toBe("ration");
        const ammo = c.player.ammo.pistol;
        addItem(c, "ammo-box"); useItem(c, "ammo-box", t);
        expect(c.player.ammo.pistol).toBe(ammo + weaponById("pistol").magazine);
        expect(useItem(c, "scrap", t)).toContain("!");
    });
    it("puts shops in some buildings, never in houses, the same ones every time", () => {
        const keys = Array.from({ length: 700 }, (_, i) => `osm-${i}`);
        const shops = keys.map(k => shopForBuilding(k, "box")).filter(Boolean);
        expect(shops.length).toBeGreaterThan(700 / SHOP_EVERY * 0.6);
        expect(shops.length).toBeLessThan(700 / SHOP_EVERY * 1.5);
        expect(new Set(shops)).toEqual(new Set(["general", "gunsmith", "garage"]));
        expect(keys.every(k => shopForBuilding(k, "house") === null)).toBe(true);
        expect(keys.map(k => shopForBuilding(k, "box"))).toEqual(keys.map(k => shopForBuilding(k, "box")));
    });
    it("stocks each shop by kind and buys and sells through them", () => {
        const c = newCampaign({ seed: 3, spawn: "london" });
        c.party.funds = 50000;
        const kinds = (k: Parameters<typeof shopStock>[1]) => new Set(shopStock(c, k).map(l => l.kind));
        expect(kinds("general")).toEqual(new Set(["item", "pamphlets"]));
        expect(kinds("gunsmith")).toEqual(new Set(["weapon", "ammo", "armor"]));
        expect(kinds("garage")).toEqual(new Set(["car"]));
        expect(kinds("hq").size).toBe(6);
        expect(shopStock(c, "gunsmith").find(l => l.id === "pistol" && l.kind === "weapon")!.blocked).toBe("OWNED");
        expect(buyStock(c, { kind: "item", id: "medkit" })).toBeNull();
        expect(buyStock(c, { kind: "weapon", id: "rifle" })).toBeNull();
        expect(buyStock(c, { kind: "car", id: "gyro" })).toBeNull();
        expect(c.player.weapons).toContain("rifle");
        expect(c.player.carUpgrades!.gyro).toBe(1);
        addItem(c, "scrap", 2);
        const before = c.party.funds;
        expect(sellItem(c, "scrap")).toBe(60);
        expect(c.party.funds).toBe(before + 60);
        expect(typeof sellItem(c, "stim")).toBe("string");
    });
    it("leaves deterministic supplies in houses that can be taken once", () => {
        const caches = Array.from({ length: 200 }, (_, i) => houseLoot(`house-${i}`));
        expect(caches.filter(Boolean).length).toBeGreaterThan(120);
        expect(caches.filter(x => x === null).length).toBeGreaterThan(10);
        expect(houseLoot("house-7")).toEqual(houseLoot("house-7"));
        const cache = caches.find(Boolean)!;
        expect(Math.abs(cache.u)).toBeLessThanOrEqual(0.6);
        const c = newCampaign({ seed: 4, spawn: "london" });
        const funds = c.party.funds;
        const got = takeHouseLoot(c, cache);
        expect(got).toBeTruthy();
        expect(isLooted(c, cache.key)).toBe(true);
        expect(takeHouseLoot(c, cache)).toBeNull();
        const credits = cache.items.find(x => x.id === "credits")?.count ?? 0;
        expect(c.party.funds).toBe(funds + credits);
        expect(ITEMS.every(i => i.sell <= i.price || i.price === 0)).toBe(true);
    });
    it("loads older saves with empty inventories and no mission", () => {
        const c = newCampaign({ seed: 5, spawn: "london" }) as Partial<Campaign> & Campaign;
        delete c.player.inventory; delete c.compounds; delete c.mission; delete c.looted;
        const back = migrateCampaign(JSON.parse(JSON.stringify(c)));
        expect(back.player.inventory).toEqual({});
        expect(back.compounds).toEqual({});
        expect(back.mission).toBeNull();
    });
});

describe("military compounds", () => {
    it("sizes compounds to the population they hold", () => {
        const c = newCampaign({ seed: 6, spawn: "london" });
        const size = (kind: string) => compoundBuildings(discoverSettlement(c, { name: `X ${kind}`, kind, lat: 51 + Math.random(), lon: -1 + Math.random() }));
        const dwelling = size("isolated_dwelling"), hamlet = size("hamlet"), village = size("village"), town = size("town"), city = size("city");
        expect(dwelling).toBe(1);
        expect(hamlet).toBeLessThan(village);
        expect(village).toBeLessThan(town);
        expect(town).toBeLessThan(city);
        expect(compoundBuildings(regionDefById("london")!)).toBeGreaterThan(city);
        expect(compoundGarrison(10)).toBe(20);
        expect(compoundGarrison(1)).toBe(2);
    });
    it("stands on the outskirts, walled, with a gate and posts, the same every time", () => {
        const def = regionDefById("paris")!;
        const plan = compoundPlan(def);
        expect(km(plan, def)).toBeCloseTo(1.6, 1);
        expect(compoundPlan(def)).toEqual(plan);
        const layout = compoundLayout(plan);
        expect(layout.structures.filter(s => !["wall", "tower"].includes(s.kind))).toHaveLength(plan.buildings);
        expect(layout.structures.filter(s => s.kind === "tower")).toHaveLength(4);
        // The wall leaves a gate open at the front (+z).
        const walls = layout.structures.filter(s => s.kind === "wall");
        expect(walls.some(w => w.z > layout.radius * 0.95 && Math.abs(w.x) < 2)).toBe(false);
        expect(walls.length).toBeGreaterThan(10);
        expect(layout.posts.length).toBeGreaterThanOrEqual(8);
        for (const [x, z] of layout.posts) expect(Math.hypot(x, z)).toBeLessThan(layout.radius);
        const [x, z] = compoundToLocal(100, 50, Math.PI / 2, 0, 10);
        expect(x).toBeCloseTo(110); expect(z).toBeCloseTo(50);
        const off = offsetLatLon(10, 20, 1, 0);
        expect(km(off, { lat: 10, lon: 20 })).toBeCloseTo(1, 3);
        expect(off.lat).toBeGreaterThan(10);
    });
    it("finds clear ground away from buildings", () => {
        const walkable = (x: number, z: number) => !(x > -50 && x < 50 && z > -50 && z < 50);
        const site = findClearSite(walkable, 0, 0, 20)!;
        expect(site).not.toBeNull();
        for (let a = 0; a < 6.28; a += 0.3) expect(walkable(site[0] + Math.sin(a) * 19, site[1] + Math.cos(a) * 19)).toBe(true);
        expect(findClearSite(() => false, 0, 0, 20, 60)).toBeNull();
    });
    it("is captured by clearing its defenders and holding the flag", () => {
        const c = newCampaign({ seed: 7, spawn: "rome" });
        const cs = ensureCompound(c, "rome")!;
        const progress = { raise: 0 };
        expect(stepCapture(cs, progress, true, 1)).toBe("contested");
        for (let i = 0; i < cs.maxGarrison; i++) defenderDown(cs);
        expect(cs.garrison).toBe(0);
        expect(stepCapture(cs, progress, false, 1)).toBe("held");
        expect(stepCapture(cs, progress, true, RAISE_SECONDS / 2)).toBe("raising");
        expect(stepCapture(cs, progress, false, 0.1)).toBe("held");
        expect(progress.raise).toBe(0);
        stepCapture(cs, progress, true, RAISE_SECONDS / 2);
        expect(stepCapture(cs, progress, true, RAISE_SECONDS / 2 + 0.01)).toBe("captured");
        expect(cs.captured).toBe(true);
    });
    it("changes hands with the town, and refills its garrison while you are away", () => {
        const c = newCampaign({ seed: 8, spawn: "rome" });
        const cs = ensureCompound(c, "berlin")!;
        cs.garrison = 1;
        c.player.lat = 0; c.player.lon = 0;
        reinforceCompounds(c);
        expect(cs.garrison).toBeGreaterThan(1);
        takeRegion(c, c.regions.berlin, "war");
        expect(cs.captured).toBe(true);
        loseRegion(c, c.regions.berlin, "concordat", "test");
        expect(cs.captured).toBe(false);
        expect(cs.garrison).toBe(cs.maxGarrison);
        const near = compoundsNear(c, regionDefById("rome")!.lat, regionDefById("rome")!.lon, 3, [regionDefById("rome")!]);
        expect(near.map(x => x.id)).toContain("mil-rome");
    });
});

describe("the founding mission", () => {
    it("starts beside your hometown, guides you there, and makes the outpost your HQ", () => {
        const c = newCampaign({ seed: 9, hometown: { name: "Levittown", kind: "town", lat: 40.7259, lon: -73.5143 } });
        const m = startFoundingMission(c);
        const outpost = c.compounds![m.compound];
        expect(outpost.kind).toBe("outpost");
        expect(missionDistance(c)).toBeGreaterThan(200);
        expect(missionDistance(c)).toBeLessThan(400);
        expect(missionObjective(c)).toContain("5 comrades");
        expect(updateMission(c)).toBeNull();
        c.player.lat = outpost.lat; c.player.lon = outpost.lon;
        expect(updateMission(c)).toContain("Take it");
        expect(missionObjective(c)).toContain(`${outpost.garrison} defenders`);
        outpost.garrison = 0;
        expect(updateMission(c)).toContain("Raise the flag");
        expect(missionObjective(c)).toContain("flagpole");
        const funds = c.party.funds;
        outpost.captured = true;
        expect(updateMission(c)).toContain("HQ is yours");
        expect(c.mission!.step).toBe("done");
        expect(c.party.hqSite).toEqual({ lat: outpost.lat, lon: outpost.lon, name: "Levittown HQ" });
        expect(c.party.funds).toBe(funds + MISSION_REWARD);
        expect(missionObjective(c)).toBeNull();
        // The HQ is on the sky markers, whatever the distance.
        expect(skyMarkers(c, 0, 0).some(s => s.kind === "hq")).toBe(true);
    });
});

describe("membership dynamics", () => {
    it("starts with five comrades who walk with you", () => {
        const c = newCampaign({ seed: 10, spawn: "london" });
        expect(c.members).toHaveLength(FOUNDING_COMRADES);
        expect(c.members.filter(m => m.follower)).toHaveLength(5);
        expect(c.regions.london.members).toBe(5);
    });
    it("members attract members, faster with support and momentum", () => {
        const c = newCampaign({ seed: 11, spawn: "london" });
        const rs = c.regions.london;
        rs.members = 100;
        const quiet = memberFlow(rs, 1, 0);
        rs.momentum = 1;
        const busy = memberFlow(rs, 1, 0);
        expect(busy.joined).toBeGreaterThan(quiet.joined * 1.5);
        rs.support[PARTY] = 0.3;
        expect(memberFlow(rs, 1, 0).joined).toBeGreaterThan(busy.joined);
    });
    it("rivals poach members, more where they out-poll you and the regime is hot", () => {
        const c = newCampaign({ seed: 12, spawn: "london" });
        const rs = c.regions.london;
        rs.members = 200;
        const calm = memberFlow(rs, 9, 0);
        expect(calm.poacher).not.toBeNull();
        rs.heat = 1;
        expect(memberFlow(rs, 9, 0).lost).toBeGreaterThan(calm.lost);
        rs.heat = 0;
        rs.support[PARTY] = 0.6; rs.support[calm.poacher!] = 0.05;
        expect(memberFlow(rs, 9, 0).lost).toBeLessThan(calm.lost);
        expect(memberFlow(rs, 9, 0, 0).lost).toBeGreaterThanOrEqual(memberFlow(rs, 9, 0, 1).lost);
    });
    it("grows an active party and bleeds a neglected one", () => {
        const run = (speeches: boolean) => {
            const c = newCampaign({ seed: 13, spawn: "lagos" });
            c.party.funds = 1e6;
            for (let d = 0; d < 40; d++) {
                if (speeches && d % 2 === 0) applySpeech(c, "lagos", { score: 0.8, crowd: 30, joined: 3, karma: 0 });
                advanceDay(c);
            }
            return c.regions.lagos.members;
        };
        const active = run(true), idle = run(false);
        expect(active).toBeGreaterThan(30);
        expect(active).toBeGreaterThan(idle * 3);
        expect(idle).toBeLessThanOrEqual(8);
    });
});

describe("entering houses", () => {
    it("opens houses at their front door only; other buildings stay closed", () => {
        const house = rect(), office = rect({ key: "office", kind: "box", cx: 30, door: [30, 5.6] });
        expect(enterable(house)).toBe(true);
        expect(enterable(office)).toBe(false);
        expect(houseAtDoor([house, office], 0.5, 5.8)?.key).toBe("house-1");
        expect(houseAtDoor([house, office], 30, 5.6)).toBeNull();
        expect(houseAtDoor([house], 0, -6)).toBeNull();
    });
    it("puts you inside facing in, keeps you within the walls, and lets you out at the door", () => {
        const r = rect({ ux: Math.cos(0.7), uz: -Math.sin(0.7), door: [0, 0] });
        r.door = [-r.uz * 5.6, r.ux * 5.6];
        expect(doorSide(r)).toBe(1);
        const at = entryPoint(r);
        expect(Math.abs(toU(r, at.x, at.z))).toBeLessThan(0.01);
        expect(toV(r, at.x, at.z)).toBeGreaterThan(2);
        expect(toV(r, at.x, at.z)).toBeLessThan(r.hd);
        expect(atDoorInside(r, at.x, at.z)).toBe(true);
        const [x, z] = clampInside(r, 100, -100, 0.3);
        expect(Math.abs(toU(r, x, z))).toBeLessThanOrEqual(r.hw - 0.3 - 0.35 + 1e-9);
        expect(Math.abs(toV(r, x, z))).toBeLessThanOrEqual(r.hd - 0.3 - 0.35 + 1e-9);
        expect(atDoorInside(r, x, z)).toBe(false);
        const out = exitPoint(r);
        expect(out.x).toBeCloseTo(r.door[0]); expect(out.z).toBeCloseTo(r.door[1]);
    });
});

describe("sky markers and the mini map", () => {
    const cam = cameraBasis([0, 0, 0], [0, 0, -10], [0, 1, 0], 1, 1);
    it("projects ahead to the screen and pins what is behind or aside to its edge", () => {
        const ahead = project(cam, [0, 0, -50], 1600, 900);
        expect(ahead.onScreen).toBe(true);
        expect(ahead.x).toBeCloseTo(800); expect(ahead.y).toBeCloseTo(450);
        const right = project(cam, [10, 10, -50], 1600, 900);
        expect(right.x).toBeGreaterThan(800); expect(right.y).toBeLessThan(450);
        const behind = project(cam, [5, 0, 50], 1600, 900, 36);
        expect(behind.onScreen).toBe(false);
        expect(behind.behind).toBe(true);
        expect(behind.x).toBeCloseTo(1600 - 36);
        const far = project(cam, [0, 500, -10], 1600, 900, 36);
        expect(far.onScreen).toBe(false);
        expect(far.y).toBeCloseTo(36);
        // Calibrated from the engine's picking rays at the screen's edges.
        const t = calibrate(cam, [0.7, 0, -1], [0, 0.4, -1]);
        expect(t.tanX).toBeCloseTo(0.7); expect(t.tanY).toBeCloseTo(0.4);
    });
    it("marks nearby towns and cities, uncaptured compounds and the mission, nearest first", () => {
        const c = newCampaign({ seed: 14, spawn: "london" });
        startFoundingMission(c);
        const town = discoverSettlement(c, { name: "Croydon", kind: "town", lat: 51.372, lon: -0.099 });
        const london = regionDefById("london")!;
        const markers = skyMarkers(c, london.lat, london.lon, { rangeKm: 60, missionCompound: c.mission!.compound });
        expect(markers.some(m => m.id === town.id && m.kind === "town")).toBe(true);
        expect(markers.some(m => m.kind === "mission")).toBe(true);
        const places = markers.filter(m => m.kind === "town" || m.kind === "city");
        for (let i = 1; i < places.length; i++) expect(places[i].km).toBeGreaterThanOrEqual(places[i - 1].km);
        const cs = ensureCompound(c, town.id)!;
        expect(skyMarkers(c, cs.lat, cs.lon, { compoundKm: 5 }).some(m => m.id === cs.id)).toBe(true);
        cs.captured = true;
        expect(skyMarkers(c, cs.lat, cs.lon, { compoundKm: 5 }).some(m => m.id === cs.id)).toBe(false);
    });
    it("draws the street map as merged runs, north up", () => {
        const what = (x: number, z: number) => (x > 0 && x < 20 && z > 0 && z < 10 ? 1 : x < -15 ? 2 : 0);
        const runs = miniMapRuns(what, 0, 0, 10, 5);
        expect(runs.some(r => r[3] === 1)).toBe(true);
        expect(runs.some(r => r[3] === 2)).toBe(true);
        // One run per row per stretch: a 20 m wide building is one rectangle per row.
        const building = runs.filter(r => r[3] === 1);
        expect(building.every(r => r[2] - r[1] + 1 === 4)).toBe(true);
        expect(Math.min(...building.map(r => r[0]))).toBeLessThan(5);
        expect(toMapCell({ cells: 10, cellMeters: 5 }, 0, 0, 0, 25)).toEqual({ x: 5, y: 0 });
        expect(toMapCell({ cells: 10, cellMeters: 5 }, 0, 0, 0, 99)).toBeNull();
        expect(toMapCell({ cells: 10, cellMeters: 5 }, 0, 0, 0, 99, true)).toEqual({ x: 5, y: 0 });
    });
});

describe("set dressing", () => {
    const rects = (): Rect[] => Array.from({ length: 40 }, (_, i) => rect({ key: `b-${i}`, kind: i % 3 ? "house" : "box", cx: (i % 8) * 30, cz: Math.floor(i / 8) * 30, door: [(i % 8) * 30, Math.floor(i / 8) * 30 + 5.6] }));
    const walkable = (x: number, z: number) => !rects().some(r => Math.abs(x - r.cx) < r.hw + 0.5 && Math.abs(z - r.cz) < r.hd + 0.5);
    it("plants yards and dresses streets deterministically, only on free ground", () => {
        const items = scatterAround(rects(), { walkable, shopOf: r => (r.key === "b-0" ? "garage" : null), origin: { lat: 51, lon: 0 }, area: { x: 100, z: 60, half: 200 } });
        expect(items).toEqual(scatterAround(rects(), { walkable, shopOf: r => (r.key === "b-0" ? "garage" : null), origin: { lat: 51, lon: 0 }, area: { x: 100, z: 60, half: 200 } }));
        expect(items.every(it => walkable(it.x, it.z))).toBe(true);
        const families = new Set(items.map(i => i.family));
        expect(families.has("shrub") || families.has("tree-round") || families.has("tree-oval")).toBe(true);
        expect(items.filter(i => i.family === "kiosk")).toHaveLength(1);
        expect(scatterAround(rects(), { walkable, tropical: true, origin: { lat: 0, lon: 0 }, area: { x: 0, z: 0, half: 400 } }).some(i => i.family === "conifer")).toBe(false);
        const reserved = scatterAround(rects(), { walkable, reserved: () => true });
        expect(reserved).toHaveLength(0);
    });
    it("draws near foliage in full, far foliage simplified, and nothing out of range", () => {
        const tree = FOLIAGE.find(f => f.family === "tree-round")!;
        expect(scatterMesh("tree-round", 10)).toBe(foliageKey(tree, 0));
        expect(scatterMesh("tree-round", 100)).toBe(foliageKey(tree, 1));
        expect(scatterMesh("tree-round", 5000)).toBeNull();
        expect(scatterMesh("grass", 200)).toBeNull();
        expect(scatterMesh("bench", 50)).toContain("bench");
        expect(scatterMesh("bench", 900)).toBeNull();
        expect(scatterMesh("beacon", 3000)).toContain("beacon");
        const key = batchKey(foliageKey(tree, 0), 150, -20);
        expect(meshOfBatch(key)).toBe(foliageKey(tree, 0));
        expect(batchKey("m", 150, -20)).not.toBe(batchKey("m", 10, 10));
    });
    it("evaluates each Mesha plant once into the cache, with a simplified distance mesh", () => {
        const store = new Map<string, { simplify: boolean }>();
        const cache = {
            status: (_ns: string, k: string) => (store.has(k) ? "ready" as const : "missing" as const),
            put: (_ns: string, k: string, _m: unknown, o?: { simplify?: unknown }) => { store.set(k, { simplify: !!o?.simplify }); },
            failure: () => null,
        };
        let evaluations = 0;
        const grass = evaluateObject(lookupObject("nature.grass")!, {}, lookupObject);
        const f = new FoliageMeshes(cache, () => { evaluations++; return grass; });
        let frames = 0;
        while (!f.prepare() && frames < 50) frames++;
        expect(evaluations).toBe(FOLIAGE.length);
        expect(store.size).toBe(FOLIAGE.length * 2);
        expect([...store.entries()].filter(([k]) => k.endsWith("lod1")).every(([, v]) => v.simplify)).toBe(true);
        const packed = packFoliage(grass);
        expect(packed.vertexData.length % 12).toBe(0);
        expect(packed.triangles).toBeGreaterThan(100);
        const props = new Map<string, unknown>();
        expect(cacheProps({ status: (_n, k) => (props.has(k) ? "ready" : "missing"), put: (_n, k, m) => { props.set(k, m); }, failure: () => null })).toBe(Object.keys(PROPS).length);
        expect(SCATTER_NAMESPACE).toBe("allegiance-scatter");
    });
});

describe("compound guards on the street", () => {
    const ctx = (): StreetContext => ({ partyShare: 0.1, rivalShares: {}, atWar: false, heat: 0, enemyQuality: 0.5, followers: [], playerWeapon: "rifle", calm: true });
    const flatH = () => 0;
    it("hold their posts until you come close, then fight; their deaths count for the compound", () => {
        const st = newStreet(), r = makeRng(3);
        st.civilianTarget = 0;
        st.player.x = 0; st.player.z = -120;
        spawnGuards(st, ctx(), r, "mil-x", [[0, 0], [4, 0]]);
        for (let i = 0; i < 50; i++) stepStreet(st, null, ctx(), 0.1, r, flatH);
        const g = guardsOf(st, "mil-x");
        expect(g).toHaveLength(2);
        expect(g.every(a => !a.alerted && Math.hypot(a.x - a.post![0], a.z - a.post![1]) < 1)).toBe(true);
        expect(st.shots).toHaveLength(0);
        st.player.z = -30;
        for (let i = 0; i < 30; i++) stepStreet(st, null, ctx(), 0.1, r, flatH);
        expect(guardsOf(st, "mil-x").every(a => a.alerted)).toBe(true);
        const target = guardsOf(st, "mil-x")[0];
        target.health = 1;
        st.events.length = 0;
        const shot = playerShoot(st, null, [st.player.x, 1.4, st.player.z], (() => { const dx = target.x - st.player.x, dy = 1.2 - 1.4, dz = target.z - st.player.z, l = Math.hypot(dx, dy, dz); return [dx / l, dy / l, dz / l] as [number, number, number]; })(), { ...weaponById("rifle"), spread: 0 }, 0, r);
        expect(shot[0].hit?.id).toBe(target.id);
        const kill = st.events.find(e => e.kind === "kill");
        expect(kill && kill.kind === "kill" && kill.compound).toBe("mil-x");
        expect(st.events.some(e => e.kind === "squad-defeated")).toBe(false);
    });
    it("can't hurt you while the respawn shield lasts", () => {
        const st = newStreet(), r = makeRng(5);
        st.civilianTarget = 0;
        st.player.shield = 3;
        spawnGuards(st, ctx(), r, "mil-y", [[0, 6], [2, 6], [-2, 6]]);
        for (const g of st.actors) { g.alerted = true; g.accuracy = 5; }
        for (let i = 0; i < 25; i++) stepStreet(st, null, ctx(), 0.1, r, flatH);
        expect(st.player.health).toBe(100);
        expect(st.player.shield).toBeCloseTo(0.5, 5);
    });
});

describe("the slower speech marker", () => {
    it("sweeps slowly enough to aim, with a wider sweet zone", () => {
        const s = startSpeech({ region: "london", ideology: "solidarity", oratory: 0, persuasion: 0, crowd: 10, seed: 3 });
        chooseCard(s, 0);
        expect(s.markerSpeed).toBe(MARKER_SPEED);
        expect(s.markerSpeed).toBeLessThan(0.5);
        expect(s.sweetHalf).toBeGreaterThanOrEqual(0.09);
    });
});

describe("first person", () => {
    it("starts in first person on foot", () => {
        expect(newBody().firstPerson).toBe(true);
    });
});

void REGIONS; void partyShare;


describe("upgrade screens", () => {
    const render = (mode: Mode, extra: Partial<GameView> = {}) => {
        const strings: string[] = [];
        let rects = 0;
        const painter = new Painter({ clear: () => { strings.length = 0; rects = 0; }, rect: () => { rects++; }, text: o => { strings.push(o.s); } });
        const ui = new UiFrame(painter, 1600, 900);
        const c = newCampaign({ seed: 3, spawn: "london" });
        startFoundingMission(c);
        const acts: [string, unknown][] = [];
        const g: GameView = {
            mode, tab: "inventory", c, setup: { party: "", leader: "", ideology: "solidarity", color: 0, spawn: null, focus: null },
            loading: { progress: 0, stage: "", lines: [], tip: "", place: "", elapsed: 0 }, speech: null, dialogue: null, toasts: [], region: "london",
            selectedRegion: null, selectedMember: null, memberPage: 0, prompt: null, street: { civilians: 0, listeners: 0, soldiers: 0, followers: 5, rally: null, rallyTime: 0 },
            weapon: { name: "M-90", mag: 12, reserve: 36, reloading: false, magazine: 12 }, pamphlet: "propaganda", stamina: 1, armor: 0, land: null, hasSave: true, time: 0,
            firstPerson: true, debug: null, act: (n, a) => { acts.push([n, a]); }, ...extra,
        };
        painter.begin(); drawScreen(g, ui); painter.flush();
        return { strings, rects, ids: painter.buttons.map(b => b.id), ui, painter, acts, c };
    };
    it("shows the mission as the objective, and the markers, mini map, capture bar and boost meter", () => {
        const r = render("play", {
            markers: [{ id: "a", kind: "mission", label: "OBJECTIVE: OUTPOST", distance: "279 m", x: 800, y: 300, color: [1, 0.8, 0.2, 1], onScreen: true }],
            minimap: { cells: 10, cellMeters: 5, runs: [[0, 1, 3, 1], [2, 0, 9, 2]], dots: [{ x: 3, y: 3, color: [1, 0, 0, 1], size: 6, kind: "enemy" }], heading: 0.5 },
            capture: { name: "the outpost", defenders: 3, raise: 0, state: "contested" },
            car: { boost: 0.4, speed: 60, altitude: 120, ceiling: 500 },
        });
        expect(r.strings.some(s => s.startsWith("FOUNDING:"))).toBe(true);
        expect(r.strings).toContain("OBJECTIVE: OUTPOST  279 m");
        expect(r.strings.some(s => s.includes("3 DEFENDERS LEFT"))).toBe(true);
        expect(r.strings.some(s => s.startsWith("BOOST 40%"))).toBe(true);
        expect(r.strings).toContain("50 m");
    });
    it("draws the shop alone (no HUD text through it), with buy and sell buttons that act", () => {
        const r = render("shop", { shop: { kind: "garage", name: "Hover Garage" } });
        expect(r.strings).toContain("HOVER GARAGE");
        expect(r.strings.some(s => s.startsWith("FOUNDING:"))).toBe(false);
        expect(r.ids).toContain("shop-buy-car-turbine");
        expect(r.ids).toContain("shop-sell-medkit");
        const b = r.painter.buttons.find(x => x.id === "shop-buy-car-turbine")!;
        r.ui.click(b.x + 2, b.y + 2);
        expect(r.acts[0]).toEqual(["shop-buy", { kind: "car", id: "turbine" }]);
    });
    it("lists the inventory with use buttons, the car and the HQ", () => {
        const r = render("console");
        expect(r.ids).toContain("tab-inventory");
        expect(r.ids).toContain("use-medkit");
        expect(r.strings.some(s => s.startsWith("FIELD MEDKIT x2"))).toBe(true);
        expect(r.strings).toContain("FLYING CAR");
        expect(r.strings.some(s => s.startsWith("None yet"))).toBe(true);
    });
    it("keeps edge markers off the HUD corners and labels from overlapping", () => {
        const at = (id: string, kind: "city" | "town" | "hq", x: number, y: number, onScreen = false) => ({ id, kind, label: id.toUpperCase(), distance: "1 km", x, y, color: [1, 1, 1, 1] as [number, number, number, number], onScreen });
        const laid = layoutMarkers([at("a", "town", 4, 20), at("b", "city", 4, 880), at("c", "town", 800, 400, true), at("d", "town", 805, 402, true), at("e", "hq", 1590, 10)], 1600, 900);
        for (const l of laid) if (!l.m.onScreen) { expect(l.y).toBeGreaterThanOrEqual(160); expect(l.y).toBeLessThanOrEqual(900 - 190); }
        expect(laid[0].m.kind).toBe("hq");
        const labels = laid.map(l => l.label).filter(Boolean) as { x: number; y: number; w: number }[];
        for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
            const a = labels[i], b = labels[j];
            expect(a.x < b.x + b.w && a.x + a.w > b.x && Math.abs(a.y - b.y) < 18).toBe(false);
        }
    });
});

describe("named members and rival parties", () => {
    it("lose wavering named members to the rival that out-polls you", async () => {
        const { dailyMembers } = await import("../src/games/allegiance/al_party");
        const c = newCampaign({ seed: 21, spawn: "lagos" });
        for (const m of c.members) { m.follower = false; m.loyalty = 20; }
        const rs = c.regions.lagos;
        rs.support[PARTY] = 0.01;
        let lost = 0;
        for (let d = 0; d < 60 && c.members.length; d++) { const n = c.members.length; dailyMembers(c); lost += n - c.members.length; }
        expect(lost).toBeGreaterThan(0);
        expect(c.news.some(n => n.text.includes("leaves the party for"))).toBe(true);
    });
});
