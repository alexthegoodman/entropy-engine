// Allegiance's secondary pass: landing on flat roofs and landing faster, house levels of detail in
// the air, the territory overlay, comrades (a column at a distance, holding fire until the shooting
// starts, holding a spot, their own cars), invasions on the march and sending troops, soldiers
// taking cover and fanning out, and townspeople kept to the streets.
// The live tier is tests/features/allegiance_secondary_live.feature.
import { describe, expect, it } from "vitest";
import {
    newCar, stepCar, landingClear, landingSpot, landingRate, roofUnder, carFloor, carGround, flightClear, steerAutopilot, autopilotWarp,
    autopilotAltitude, AUTOPILOT_ARRIVE, BASE_CAR, type FlightEnvironment,
} from "../src/games/allegiance/al_vehicle";
import { NavGrid, type Rect } from "../src/games/allegiance/al_nav";
import {
    newStreet, stepStreet, spawnSquad, soldiers, playerShoot, orderComrades, findCover, followSlot, ENGAGE_SECONDS, FOLLOW_BACK,
    type StreetContext,
} from "../src/games/allegiance/al_street";
import { convoySize, escortSlot, stepEscort, convoyCar, CONVOY_SEATS } from "../src/games/allegiance/al_convoy";
import { packTerritories, territoryStrength, borderWidth, TERRITORY_FLOATS, TERRITORY_MAX, TERRITORY_WGSL, TERRITORY_BIND_ENTRIES } from "../src/games/allegiance/al_territory";
import { ALLEGIANCE_TERRAIN_SHADER, ALLEGIANCE_SHADER } from "../src/games/allegiance/al_shader";
import { MATERIAL_BIND_ENTRIES } from "../src/games/allegiance/al_materials";
import { CLOUD_BIND_ENTRIES } from "../src/games/allegiance/al_clouds";
import { newCampaign } from "../src/games/allegiance/al_state";
import { advanceDay, defenseRatio } from "../src/games/allegiance/al_world";
import { dispatchTroops, troopsAvailable } from "../src/games/allegiance/al_party";
import { PARTY, weaponById } from "../src/games/allegiance/al_data";
import { makeRng } from "../src/games/allegiance/al_rng";
import { CityHouses, type CityBuilding } from "../src/apps/quadplanet/qp_city";
import { NO_PLAYER_INPUT } from "../src/games/allegiance/al_player";

const block = (cx: number, cz: number, hw: number, hd: number, height: number, key: string, kind = "box"): Rect =>
    ({ cx, cz, ux: 1, uz: 0, hw, hd, height, base: 0, key, door: [cx, cz - hd - 1.6], kind });
const flat: FlightEnvironment = { height: () => 0, sea: () => false, buildings: [] };

describe("landing", () => {
    it("sets down on a flat roof under the whole rotor footprint, never on a pitched house or half off an edge", () => {
        const roof = block(0, 0, 10, 10, 18, "tower");
        const env = { ...flat, buildings: [roof] };
        expect(roofUnder(0, 0, env.buildings)).toBe(18);
        expect(carFloor(0, 0, env)).toBeCloseTo(18.22, 5);
        expect(landingClear({ x: 0, y: 30, z: 0, yaw: 0 }, env)).toBe(true);
        // Half over the edge: no roof under every rotor.
        expect(roofUnder(9, 0, env.buildings)).toBeNull();
        // A house's roof is pitched.
        expect(roofUnder(0, 0, [block(0, 0, 10, 10, 9, "home", "house")])).toBeNull();
        // A terrace of two blocks a few centimeters apart in height is one roof; a step of a storey is not.
        expect(roofUnder(0, 0, [block(-5, 0, 5, 10, 12, "a"), block(5, 0, 5, 10, 12.3, "b")])).toBe(12.3);
        expect(roofUnder(0, 0, [block(-5, 0, 5, 10, 12, "a"), block(5, 0, 5, 10, 15, "b")])).toBeNull();
        // A block built round a courtyard fills only part of its rectangle: no roof over the yard.
        expect(roofUnder(0, 0, [{ ...block(0, 0, 20, 20, 18, "court"), fill: 0.55 }])).toBeNull();
    });

    it("lands on the roof when you press L over it, and comes down far faster than before", () => {
        const env = { ...flat, buildings: [block(0, 0, 12, 12, 20, "tower")] };
        const c = newCar({ x: 0, y: 320, z: 0, yaw: 0 });
        c.piloting = true; c.state = "landing"; c.landAt = landingSpot(c, env);
        let t = 0;
        while (c.state !== "parked" && t < 120) { stepCar(c, NO_PLAYER_INPUT, false, 0.05, env); t += 0.05; }
        expect(c.state).toBe("parked");
        expect(c.y).toBeCloseTo(20.22, 2);
        // 300 m: the old fixed 3 m/s descent took 100 s.
        expect(t).toBeLessThan(35);
        expect(landingRate(300)).toBeGreaterThan(10);
        expect(landingRate(0.5)).toBeLessThan(2);
    });

    it("glides to the nearest clear spot when it is over something it cannot land on", () => {
        // Over a narrow tower: no room on its roof, and no ground under it.
        const env = { ...flat, buildings: [block(0, 0, 2, 2, 40, "spire")] };
        const c = newCar({ x: 0, y: 80, z: 0, yaw: 0 });
        expect(landingClear(c, env)).toBe(false);
        const spot = landingSpot(c, env)!;
        expect(spot).not.toBeNull();
        expect(Math.hypot(spot.x, spot.z)).toBeGreaterThan(4);
        c.piloting = true; c.state = "landing"; c.landAt = spot;
        for (let t = 0; t < 60 && c.state !== "parked"; t += 0.05) {
            stepCar(c, NO_PLAYER_INPUT, false, 0.05, env);
            expect(flightClear(c, env)).toBe(true);
        }
        expect(c.state).toBe("parked");
        expect(Math.hypot(c.x - spot.x, c.z - spot.z)).toBeLessThan(1.5);
        expect(c.y).toBeCloseTo(carGround(c.x, c.z, env.height), 3);
    });
});

describe("the autopilot", () => {
    it("climbs over the town, flies to the destination with time running faster on the long leg, and arrives", () => {
        const env = { ...flat, buildings: [block(0, 40, 10, 10, 60, "tower")] };
        const c = newCar({ x: 0, y: 0.22, z: 0, yaw: 2 });
        c.piloting = true;
        const target: [number, number] = [3000, 24000];
        let t = 0, maxWarp = 1, arrived = false;
        while (t < 400) {
            const km = Math.hypot(target[0] - c.x, target[1] - c.z) / 1000;
            const st = steerAutopilot(c, target[0], target[1], km, env);
            if (st.arrived) { arrived = true; break; }
            c.yaw = st.yaw;
            const warp = autopilotWarp(km, c.y - carFloor(c.x, c.z, env), BASE_CAR);
            maxWarp = Math.max(maxWarp, warp);
            for (let left = 0.05 * warp; left > 1e-6; left -= 0.2) stepCar(c, st.input, st.descend, Math.min(0.2, left), env);
            expect(flightClear(c, env)).toBe(true);
            t += 0.05;
        }
        expect(arrived).toBe(true);
        expect(Math.hypot(target[0] - c.x, target[1] - c.z)).toBeLessThan(AUTOPILOT_ARRIVE);
        expect(maxWarp).toBeGreaterThan(4);
        // Cruising at its height (under the ceiling), not still climbing.
        expect(c.y).toBeGreaterThan(autopilotAltitude(BASE_CAR) * 0.8);
        expect(c.y).toBeLessThan(BASE_CAR.ceiling);
    });
});

describe("houses from the air", () => {
    it("drops every full house model when told to (in the car), keeping the simplified exteriors", () => {
        const at = (x: number): CityBuilding => ({ key: `h${x}`, seed: x, kind: "house", anchor: [x, 0, 0], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1],
            width: 9, depth: 9, height: 7, minHeight: 0, groundMin: 0, groundMax: 0, area: 81, fill: 1, colour: null, lat: 0, lon: 0, distance: 0 });
        const list = [5, 20, 60, 120].map(at);
        const cache = new Map<string, number>();
        const city = new CityHouses({
            buildings: () => list.map(b => ({ ...b })), status: (_ns, k) => cache.has(k) ? "ready" : "missing",
            put: (_ns, k, mesh) => { cache.set(k, mesh.indexData.length / 3); }, info: (_ns, k) => cache.has(k) ? { triangleCount: cache.get(k)! } : null,
            instances: { createBuffer: () => "b", destroyBuffer: () => {}, writeBuffer: () => {}, createMesh: () => true, clearMesh: () => {}, setInstanceCount: () => {} },
            now: () => 0,
        }, { lod0Radius: 40, maxLod0: 3, lod1Radius: 300, triangleBudget: 1e9 });
        for (let i = 0; i < 6; i++) city.update([0, 0, 0], [0, 0, 0], 1, Infinity);
        expect(city.lastStats.lod0).toBe(2);
        const ground = city.lastStats.triangles;
        city.configure({ lod0Radius: 0, maxLod0: 0 });
        for (let i = 0; i < 3; i++) city.update([0, 0, 0], [0, 0, 0], 1, Infinity);
        expect(city.lastStats.lod0).toBe(0);
        expect(city.lastStats.lod1).toBe(4);
        expect(city.lastStats.triangles).toBeLessThan(ground);
    }, 60000);
});

describe("the territory overlay", () => {
    it("fades in with altitude and packs places, colors and the border width for the shader", () => {
        expect(territoryStrength(80)).toBe(0);
        expect(territoryStrength(300)).toBeGreaterThan(0.3);
        expect(territoryStrength(600)).toBe(1);
        expect(borderWidth(1000)).toBeGreaterThan(borderWidth(100));
        const f = packTerritories([{ at: [1, 2, 3], radius: 4000, color: [0.9, 0.1, 0.1], party: true }, { at: [5, 6, 7], radius: 0, color: [0.2, 0.3, 0.9], party: false }], 0.7, 12);
        expect(f.length).toBe(TERRITORY_FLOATS);
        expect([...f.slice(0, 4)]).toEqual([expect.closeTo(0.7, 5), 2, 12, 0]);
        expect([...f.slice(4, 8)]).toEqual([1, 2, 3, 4000]);
        expect([...f.slice(4 + TERRITORY_MAX * 4, 8 + TERRITORY_MAX * 4)].map(v => Math.round(v * 10) / 10)).toEqual([0.9, 0.1, 0.1, 1]);
        // Its binding shares group 2 with the world, the item, the material maps and the cloud atlas.
        const used = [0, 1, ...MATERIAL_BIND_ENTRIES.map(e => e.binding), ...CLOUD_BIND_ENTRIES.map(e => e.binding)];
        for (const e of TERRITORY_BIND_ENTRIES) expect(used).not.toContain(e.binding);
        // Only the terrain's pipeline carries it; everything else keeps its layout.
        expect(ALLEGIANCE_TERRAIN_SHADER).toContain("territory_overlay(col, in.world_pos)");
        expect(ALLEGIANCE_TERRAIN_SHADER).toContain(TERRITORY_WGSL.trim().slice(0, 40));
        expect(ALLEGIANCE_SHADER).not.toContain("territory_overlay");
    });
});

// --- Comrades and soldiers -----------------------------------------------------------------------

const ctx = (extra: Partial<StreetContext> = {}): StreetContext => ({
    partyShare: 0.2, rivalShares: { concordat: 0.4, vanguard: 0.2, verdant: 0.1, current: 0.1 }, atWar: false, heat: 0,
    enemyQuality: 0.7, followers: [], playerWeapon: "pistol", calm: true, ...extra,
});
const ground = () => 0;
const comrades = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `C${i + 1}`, armed: true, combat: 6 }));

describe("comrades", () => {
    it("walk in a loose column several meters behind you", () => {
        const st = newStreet(), r = makeRng(3);
        st.player.heading = 0;
        const c = ctx({ followers: comrades(5) });
        for (let i = 0; i < 400; i++) stepStreet(st, null, c, 0.05, r, ground);
        const party = st.actors.filter(a => a.kind === "follower");
        expect(party).toHaveLength(5);
        for (const a of party) {
            // Behind you (you face +z), and not crowding you.
            expect(a.z).toBeLessThan(-FOLLOW_BACK + 1.5);
            expect(Math.hypot(a.x, a.z)).toBeGreaterThan(4.5);
        }
        const [x0] = followSlot(0, 5, { x: 0, z: 0, heading: 0 }, null), [x2] = followSlot(2, 5, { x: 0, z: 0, heading: 0 }, null);
        expect(Math.abs(x2 - x0)).toBeGreaterThan(5);
    });

    it("hold their fire until you shoot first, then join the fight", () => {
        const st = newStreet(), r = makeRng(5), nav = new NavGrid(0, 0, 200, 2);
        st.player.health = 1e9;
        const c = ctx({ followers: comrades(3).map(f => ({ ...f, combat: 8 })) });
        stepStreet(st, nav, c, 0.1, r, ground);
        // A patrol a little way off that has not opened fire: guards at their posts, not alerted yet.
        expect(spawnSquad(st, nav, c, r, 3, false)).toBeGreaterThan(0);
        // Just outside the 45 m at which guards notice you, in the comrades' rifle range.
        for (const s of soldiers(st)) { s.x = 34 + s.id % 3 * 2; s.z = 34; s.post = [s.x, s.z]; s.alerted = false; s.compound = "x"; }
        let partyShots = 0;
        for (let i = 0; i < 100; i++) { stepStreet(st, nav, c, 0.05, r, ground); partyShots += st.shots.filter(s => s.side === "party" && s.age === 0).length; }
        expect(st.engaged).toBe(0);
        expect(partyShots).toBe(0);
        const foe = soldiers(st)[0];
        const dx = foe.x - st.player.x, dz = foe.z - st.player.z, l = Math.hypot(dx, dz);
        playerShoot(st, nav, [st.player.x, 1.6, st.player.z], [dx / l, 0, dz / l], { ...weaponById("rifle"), spread: 0 }, 0, r);
        expect(st.engaged).toBe(ENGAGE_SECONDS);
        for (let i = 0; i < 200; i++) { stepStreet(st, nav, c, 0.05, r, ground); partyShots += st.shots.filter(s => s.side === "party" && s.age === 0).length; }
        expect(partyShots).toBeGreaterThan(0);
    });

    it("hold a spot you send them to, and fall in again when called back", () => {
        const st = newStreet(), r = makeRng(9);
        const c = ctx({ followers: comrades(4) });
        stepStreet(st, null, c, 0.1, r, ground);
        expect(orderComrades(st, [40, 10])).toBe(4);
        for (let i = 0; i < 600; i++) stepStreet(st, null, c, 0.05, r, ground);
        for (const a of st.actors.filter(x => x.kind === "follower")) expect(Math.hypot(a.x - 40, a.z - 10)).toBeLessThan(5);
        orderComrades(st, null);
        for (let i = 0; i < 600; i++) stepStreet(st, null, c, 0.05, r, ground);
        for (const a of st.actors.filter(x => x.kind === "follower")) expect(Math.hypot(a.x, a.z)).toBeLessThan(14);
    });

    it("take as many cars as they need and fly in formation on yours", () => {
        expect(convoySize(0)).toBe(0);
        expect(convoySize(5)).toBe(2);
        expect(convoySize(CONVOY_SEATS * 9)).toBe(3);
        const lead = newCar({ x: 0, y: 120, z: 0, yaw: 0 });
        lead.piloting = true; lead.state = "flying";
        const escorts = [0, 1, 2].map(i => convoyCar(i * 5 - 5, -4, 0, flat).car);
        for (let t = 0; t < 40; t += 0.05) {
            // The leader cruises north at 20 m/s.
            lead.vz = 20; lead.z += lead.vz * 0.05;
            escorts.forEach((c, i) => stepEscort(c, i, lead, 0.05, flat));
        }
        escorts.forEach((c, i) => {
            const [sx, sz] = escortSlot(i, lead);
            expect(Math.hypot(c.x - sx, c.z - sz)).toBeLessThan(4);
            expect(Math.abs(c.y - lead.y)).toBeLessThan(5);
        });
        // Two off the leader's quarters, one behind, none in its seat.
        expect(new Set(escorts.map(c => Math.round(c.x))).size).toBe(3);
        for (const c of escorts) expect(c.z).toBeLessThan(lead.z - 5);
    });
});

describe("soldiers", () => {
    it("find cover hugging a wall, out of their target's sight", () => {
        const nav = new NavGrid(0, 0, 200, 1);
        // A wall between the soldier's side and the target.
        nav.addRect(block(0, 0, 6, 0.6, 3, "wall"));
        const spot = findCover(nav, { x: 2, z: 5 }, { x: 0, z: -25 }, 60, makeRng(4))!;
        expect(spot).not.toBeNull();
        expect(nav.sightClear(spot[0], spot[1], 0, -25)).toBe(false);
        expect(nav.walkable(spot[0], spot[1])).toBe(true);
        expect(Math.hypot(spot[0] - 2, spot[1] - 5)).toBeLessThan(11);
    });

    it("fan out around you instead of coming on in a file", () => {
        // Open ground: a squad arrives in a bunch and spreads across a wide arc as it closes in.
        const nav = new NavGrid(0, 0, 400, 2);
        const st = newStreet(), r = makeRng(12);
        st.player.health = 1e9;
        const c = ctx({ atWar: true, calm: true });
        stepStreet(st, nav, c, 0.1, r, ground);
        expect(spawnSquad(st, nav, c, r, 5, false)).toBe(5);
        const arc = () => {
            const b = soldiers(st).map(s => Math.atan2(s.x, s.z));
            const m = Math.atan2(b.reduce((t, x) => t + Math.sin(x), 0), b.reduce((t, x) => t + Math.cos(x), 0));
            const off = b.map(x => Math.atan2(Math.sin(x - m), Math.cos(x - m)));
            return Math.max(...off) - Math.min(...off);
        };
        const before = arc();
        const seen: number[] = [];
        for (let i = 0; i < 400; i++) { stepStreet(st, nav, c, 0.05, r, ground); if (i % 50 === 49) seen.push(Math.round(arc() * 100) / 100); }
        expect(before).toBeLessThan(0.25);
        expect(Math.max(...seen)).toBeGreaterThan(0.8);
    });

    it("duck into cover behind buildings under fire", () => {
        const nav = new NavGrid(0, 0, 400, 2);
        for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) if (i || j) nav.addRect(block(i * 34, j * 34, 7, 5, 8, `b${i}${j}`));
        const st = newStreet(), r = makeRng(12);
        st.player.health = 1e9;
        const c = ctx({ atWar: true, calm: true });
        stepStreet(st, nav, c, 0.1, r, ground);
        spawnSquad(st, nav, c, r, 5, false);
        const hidden = new Set<number>();
        for (let i = 0; i < 1200; i++) {
            stepStreet(st, nav, c, 0.05, r, ground);
            for (const s of soldiers(st)) if ((s.coverTime ?? 0) > 0 && s.cover && Math.hypot(s.x - s.cover[0], s.z - s.cover[1]) < 0.5) {
                // Crouched at their cover: out of your sight.
                expect(nav.sightClear(s.x, s.z, st.player.x, st.player.z)).toBe(false);
                hidden.add(s.id);
            }
        }
        expect(hidden.size).toBeGreaterThan(0);
    });
});

describe("townspeople", () => {
    it("appear and walk only along the streets, and none in open country", () => {
        const st = newStreet(), r = makeRng(2), nav = new NavGrid(0, 0, 400, 2);
        // A street of doors 60-90 m east of you; nothing anywhere else.
        st.streetPoints = Array.from({ length: 40 }, (_, i) => [60 + (i % 10) * 3, -20 + Math.floor(i / 10) * 12] as [number, number]);
        for (let i = 0; i < 300; i++) stepStreet(st, nav, ctx(), 0.1, r, ground);
        const people = st.actors.filter(a => a.kind === "civilian");
        expect(people.length).toBeGreaterThan(5);
        for (const a of people) expect(a.x).toBeGreaterThan(40);
        const empty = newStreet();
        empty.streetPoints = [];
        empty.urbanCap = 0;
        for (let i = 0; i < 100; i++) stepStreet(empty, nav, ctx(), 0.1, r, ground);
        expect(empty.actors.filter(a => a.kind === "civilian")).toHaveLength(0);
    });
});

describe("invasions on the march", () => {
    it("give a day's warning, and enough troops sent in time turn them back", () => {
        const c = newCampaign({ seed: 11, spawn: "berlin" });
        const home = c.regions.berlin;
        home.governor = PARTY;
        home.army = 0;
        home.threat = { attacker: "vanguard", force: 600, day: c.day + 1 };
        // Troops elsewhere: 2,000 armed members in Paris.
        c.regions.paris.army = 2000;
        expect(troopsAvailable(c, "berlin")).toBe(2000);
        expect(defenseRatio(c, home, 600)).toBe(0);
        expect(dispatchTroops(c, "berlin", 0.25).moved).toBe(500);
        expect(defenseRatio(c, home, 600)).toBeLessThan(1);
        const sent = dispatchTroops(c, "berlin", 1);
        expect(sent.moved).toBe(1500);
        expect(c.regions.paris.army).toBe(0);
        expect(defenseRatio(c, home, 600)).toBeGreaterThan(1);
        advanceDay(c, null);
        expect(home.threat).toBeNull();
        expect(home.war).toBeNull();
        expect(home.governor).toBe(PARTY);
        expect(c.news.some(n => n.text.includes("turns back"))).toBe(true);
    });

    it("start a war when nobody comes", () => {
        const c = newCampaign({ seed: 12, spawn: "berlin" });
        const home = c.regions.berlin;
        home.governor = PARTY;
        home.army = 5;
        home.threat = { attacker: "vanguard", force: 600, day: c.day + 1 };
        advanceDay(c, null);
        expect(home.threat).toBeNull();
        expect(home.war?.attacker).toBe("vanguard");
    });
});
