// The Cobra, fire and explosions, and destructible buildings (al_cobra.ts, al_fx.ts,
// al_destruction.ts, al_street.ts blasts): the TypeScript tier of allegiance_destruction_live.feature.

import { describe, expect, it } from "vitest";
import { type Rect } from "../src/games/allegiance/al_nav";
import {
    Damage, buildingHp, distanceToRect, shellPieces, breakApart, rubblePile, stepPieces, debris, pieceAxes, buildingLook, rebuildRuins, addRuin,
    PIECES_PER_BUILDING, REBUILD_DAYS, type Piece,
} from "../src/games/allegiance/al_destruction";
import { newFx, explode, ignite, stepFx, fireDamageAt, fireStrength, particleOpacity, dustCloud, MAX_PARTICLES } from "../src/games/allegiance/al_fx";
import {
    COBRA_CELLS, COBRA_SPEC, MISSILE_BUILDING_DAMAGE, solarRate, newCobraState, chargeCobra, fireMissile, stepMissiles, aimPoint, podPosition, cobraSpot, restoreCobras, type Missile,
} from "../src/games/allegiance/al_cobra";
import { BASE_CAR, newCar, stepCar } from "../src/games/allegiance/al_vehicle";
import { compoundLayout } from "../src/games/allegiance/al_military";
import { newStreet, blastStreet, burnStreet, type Actor } from "../src/games/allegiance/al_street";
import { NO_PLAYER_INPUT } from "../src/games/allegiance/al_player";
import { makeRng } from "../src/games/allegiance/al_rng";
import { PROPS } from "../src/games/allegiance/al_scatter";
import { ALLEGIANCE_INSTANCED_SHADER, MAT_FIRE, MAT_SMOKE } from "../src/games/allegiance/al_shader";

const flat = () => 0;
const rect = (key: string, cx: number, cz: number, w: number, d: number, h: number, kind = "house", yaw = 0): Rect =>
    ({ cx, cz, ux: Math.cos(yaw), uz: -Math.sin(yaw), hw: w / 2, hd: d / 2, height: h, base: 0, key, door: [cx, cz + d / 2 + 1.6], kind });

function soldier(id: number, x: number, z: number, extra: Partial<Actor> = {}): Actor {
    return { id, kind: "soldier", side: "enemy", name: `S${id}`, segment: "worker", x, z, y: 0, heading: 0, speed: 0, path: [], state: "fight", stateTime: 0,
        opinion: 0, lean: "concordat", member: false, memberId: null, pamphletCooldown: 0, talkCooldown: 0, charisma: 1, admin: 1, combat: 1, health: 100, maxHealth: 100,
        weapon: "rifle", mag: 10, cooldown: 0, reload: 0, accuracy: 0.5, target: null, retarget: 0, repath: 0, stride: 0, faction: null,
        look: { shirt: [0, 0, 0], pants: [0, 0, 0], skin: [0, 0, 0], hair: [0, 0, 0], hat: false, female: false }, slot: null, militia: false, loot: null, ...extra };
}

describe("buildings: strength and damage", () => {
    it("gives compound structures fixed strengths and map buildings strength by volume", () => {
        expect(buildingHp(rect("al-mil-a-0", 0, 0, 14, 10, 7, "military"))).toBe(1100);
        expect(buildingHp(rect("al-mil-a-1", 0, 0, 18, 7, 4.5, "military"))).toBe(700);
        expect(buildingHp(rect("al-mil-a-2", 0, 0, 3, 3, 9, "military"))).toBe(260);
        expect(buildingHp(rect("al-mil-a-3", 0, 0, 9, 0.6, 2.6, "military"))).toBe(160);
        const cottage = buildingHp(rect("h", 0, 0, 10, 9, 7));
        const tower = buildingHp(rect("t", 0, 0, 30, 30, 90, "box"));
        expect(cottage).toBeGreaterThan(MISSILE_BUILDING_DAMAGE);   // a missile hurts a house...
        expect(cottage).toBeLessThan(MISSILE_BUILDING_DAMAGE * 2);  // ...two bring it down
        expect(tower).toBe(4500);                                   // a tower takes a barrage
    });

    it("measures a blast's distance to a footprint, and above its roof", () => {
        const r = rect("h", 0, 0, 10, 10, 6, "house", 0.4);
        expect(distanceToRect(r, 0, 2, 0)).toBe(0);
        expect(distanceToRect(r, 0, 9, 0)).toBeCloseTo(3, 5);
        expect(distanceToRect(r, 20, 1, 0)).toBeGreaterThan(13);
        expect(distanceToRect(r, 20, 1, 0)).toBeLessThan(15);
    });

    it("accumulates damage until a building falls, and spares vehicles", () => {
        const dmg = new Damage();
        const house = rect("h1", 0, 0, 10, 9, 7), far = rect("h2", 60, 0, 10, 9, 7), car = rect("al-player-car", 3, 6, 5, 5, 1.6, "vehicle");
        const blast = { x: 0, y: 2, z: 5, radius: 8, damage: MISSILE_BUILDING_DAMAGE };
        let res = dmg.apply(blast, [house, far, car]);
        expect(res.fell).toEqual([]);
        expect(res.hurt.map(h => h.rect.key)).toEqual(["h1"]);
        expect(res.hurt[0].share).toBeGreaterThan(0.5);
        res = dmg.apply(blast, [house, far, car]);
        expect(res.fell.map(r => r.key)).toEqual(["h1"]);
        expect(dmg.taken.has("h1")).toBe(false);
    });

    it("rebuilds compounds after two days and the city's buildings after a week", () => {
        const ruins: Record<string, number> = {};
        addRuin(ruins, "al-mil-x-0", 10);
        addRuin(ruins, "osm-42", 10);
        expect(rebuildRuins(ruins, 10 + REBUILD_DAYS.military - 1)).toBe(0);
        expect(rebuildRuins(ruins, 10 + REBUILD_DAYS.military)).toBe(1);
        expect(Object.keys(ruins)).toEqual(["osm-42"]);
        expect(rebuildRuins(ruins, 10 + REBUILD_DAYS.civil)).toBe(1);
        expect(Object.keys(ruins)).toEqual([]);
    });
});

describe("buildings: breaking apart into pieces", () => {
    const r = rect("block", 5, -3, 20, 12, 15, "box", 0.7);
    const look = buildingLook(r);

    it("makes a shell of wall panels and roof slabs in the building's exact shape", () => {
        const ps = shellPieces(r, look, makeRng(1));
        expect(ps.length).toBeGreaterThan(40);
        expect(ps.length).toBeLessThanOrEqual(PIECES_PER_BUILDING * 1.3);
        // Every piece stands within the footprint and between the ground and the roof.
        for (const p of ps) {
            const u = (p.x - r.cx) * r.ux + (p.z - r.cz) * r.uz, v = -(p.x - r.cx) * r.uz + (p.z - r.cz) * r.ux;
            expect(Math.abs(u)).toBeLessThanOrEqual(r.hw + 0.01);
            expect(Math.abs(v)).toBeLessThanOrEqual(r.hd + 0.01);
            expect(p.y).toBeGreaterThan(r.base);
            expect(p.y).toBeLessThan(r.base + r.height);
            expect(p.asleep).toBe(true);
        }
        // Panels reach the corners and the eaves: the shell covers the walls' extent.
        const us = ps.map(p => (p.x - r.cx) * r.ux + (p.z - r.cz) * r.uz);
        expect(Math.max(...us)).toBeGreaterThan(r.hw - 3);
        expect(Math.max(...ps.map(p => p.y + p.h / 2))).toBeGreaterThan(r.height - 0.5);
        // Wall panels along u lie along the wall (their own x on the rect's u axis).
        const front = ps.find(p => Math.abs(-(p.x - r.cx) * r.uz + (p.z - r.cz) * r.ux) > r.hd - 1 && p.w > p.d)!;
        const ax = pieceAxes(front);
        expect(Math.abs(ax[0] * r.ux + ax[2] * r.uz)).toBeCloseTo(1, 5);
    });

    it("breaks apart from the blast outward, falls under gravity and settles on the ground", () => {
        const ps = shellPieces(r, look, makeRng(2));
        const blast = [r.cx + r.ux * r.hw, 3, r.cz + r.uz * r.hw] as const;
        breakApart(ps, blast[0], blast[1], blast[2], 16, makeRng(3));
        const near = ps.filter(p => Math.hypot(p.x - blast[0], p.y - blast[1], p.z - blast[2]) < 5);
        const far = ps.filter(p => Math.hypot(p.x - blast[0], p.y - blast[1], p.z - blast[2]) > 15);
        expect(Math.max(...near.map(p => p.release))).toBeLessThan(Math.min(...far.map(p => p.release)));
        const start = ps.map(p => [p.x, p.z]);
        let live: Piece[] = ps;
        // A second in: the near pieces are flying, the far side still stands.
        for (let i = 0; i < 30; i++) live = stepPieces(live, 1 / 30, flat);
        expect(near.some(p => !p.asleep)).toBe(true);
        for (let i = 0; i < 30 * 14; i++) live = stepPieces(live, 1 / 30, flat);
        expect(live.length).toBe(ps.length);
        expect(live.every(p => p.asleep)).toBe(true);
        // Nothing left standing: the roof slabs are down, and the pile is low.
        expect(Math.max(...live.map(p => p.y))).toBeLessThan(r.height * 0.35);
        for (const p of live) expect(p.y).toBeGreaterThanOrEqual(Math.min(p.w, p.h, p.d) * 0.45 - 1e-6);
        // The blast side was thrown out past the footprint.
        const moved = live.map((p, i) => Math.hypot(p.x - start[i][0], p.z - start[i][1]));
        expect(Math.max(...moved)).toBeGreaterThan(6);
    });

    it("comes back to a ruin as the same settled pile", () => {
        const a = rubblePile(r, look, flat), b = rubblePile(r, look, flat);
        expect(a.length).toBeGreaterThan(40);
        expect(a.map(p => [p.x, p.y, p.z, p.yaw])).toEqual(b.map(p => [p.x, p.y, p.z, p.yaw]));
        expect(a.every(p => p.asleep)).toBe(true);
    });

    it("throws small debris that fades away", () => {
        let d = debris(0, 1, 0, 10, makeRng(4));
        expect(d.length).toBe(10);
        for (let i = 0; i < 60 * 3; i++) d = stepPieces(d, 1 / 60, flat);
        expect(d.length).toBe(10);
        for (let i = 0; i < 60 * 5; i++) d = stepPieces(d, 1 / 60, flat);
        expect(d.length).toBe(0);
    });

    it("textures pieces with the city surfaces: brick, render, concrete, metal and fieldstone", () => {
        for (const s of ["brick", "render", "concrete", "metal", "stone"]) {
            const m = PROPS[`chunk-${s}`]();
            expect(m.vertexData.length).toBe(36 * 12);
            expect(m.vertexData[6]).toBe(11);                          // house material
            expect(Math.floor(m.vertexData[7])).toBeGreaterThan(0);    // a city surface kind
        }
        expect(buildingLook(rect("al-mil-z-0", 0, 0, 9, 0.6, 2.6, "military")).surface).toBe("stone");
    });
});

describe("fire and explosions", () => {
    it("makes a fireball, sparks, smoke, a scorch mark, a fire and a shake", () => {
        const fx = newFx(1);
        explode(fx, 0, 0.3, 0, 1, 0, [0, 1.6, 10]);
        expect(fx.explosions).toBe(1);
        expect(fx.particles.filter(p => p.kind === "fire").length).toBeGreaterThan(5);
        expect(fx.particles.filter(p => p.kind === "spark").length).toBeGreaterThan(10);
        expect(fx.particles.filter(p => p.kind === "smoke").length).toBeGreaterThan(8);
        expect(fx.scorches.length).toBe(1);
        expect(fx.shake).toBeGreaterThan(0.5);
        // In the air: no scorch.
        explode(fx, 0, 60, 0, 1, 0, null);
        expect(fx.scorches.length).toBe(1);
    });

    it("lets smoke rise and drift with the wind, then clears", () => {
        const fx = newFx(2);
        explode(fx, 0, 1, 0, 1, 0, null);
        fx.fires = [];
        for (let i = 0; i < 90; i++) stepFx(fx, 1 / 30, [4, 0], flat);
        const smoke = fx.particles.filter(p => p.kind === "smoke");
        expect(smoke.length).toBeGreaterThan(0);
        expect(smoke.reduce((s, p) => s + p.y, 0) / smoke.length).toBeGreaterThan(4);
        expect(smoke.reduce((s, p) => s + p.x, 0) / smoke.length).toBeGreaterThan(2);
        expect(smoke.every(p => particleOpacity(p) <= 1)).toBe(true);
        for (let i = 0; i < 30 * 10; i++) stepFx(fx, 1 / 30, [4, 0], flat);
        expect(fx.particles.length).toBe(0);
        expect(fx.shake).toBe(0);
    });

    it("keeps fires burning for their time, emitting flames and smoke, hurting whoever stands in them", () => {
        const fx = newFx(3);
        const f = ignite(fx, 10, 0, 10, 1.5, 8);
        expect(ignite(fx, 10.5, 0, 10, 1, 20)).toBe(f);  // feeding the same fire
        expect(fx.fires.length).toBe(1);
        for (let i = 0; i < 60; i++) stepFx(fx, 1 / 30, [0, 0], flat);
        expect(fireStrength(f)).toBeCloseTo(1, 5);
        expect(fx.particles.some(p => p.kind === "fire" && p.flame)).toBe(true);
        expect(fx.particles.some(p => p.kind === "smoke")).toBe(true);
        expect(fireDamageAt(fx, 10, 10)).toBeGreaterThan(10);
        expect(fireDamageAt(fx, 20, 10)).toBe(0);
        for (let i = 0; i < 30 * 20; i++) stepFx(fx, 1 / 30, [0, 0], flat);
        expect(fx.fires.length).toBe(0);
    });

    it("bounds the particles however much burns", () => {
        const fx = newFx(4);
        for (let i = 0; i < 40; i++) { explode(fx, i, 0, 0, 2, 0, null); dustCloud(fx, i, 0, 0, 30, 20); }
        expect(fx.particles.length).toBeLessThanOrEqual(MAX_PARTICLES);
    });

    it("hurts soldiers in a blast, never civilians or comrades, and you only on foot", () => {
        const st = newStreet();
        st.actors.push(soldier(1, 2, 0), soldier(2, 30, 0),
            { ...soldier(3, 1, 1), kind: "civilian", side: "neutral" }, { ...soldier(4, 0, 2), kind: "follower", side: "party" });
        st.player.x = 3; st.player.z = 0;
        const killed = blastStreet(st, 0, 1, 0, 8, 180, "party", false);
        expect(killed).toBe(1);
        expect(st.actors[0].state).toBe("dead");
        expect(st.events.some(e => e.kind === "kill")).toBe(true);
        expect(st.actors[1].health).toBe(100);
        expect(st.actors[2].health).toBe(100);
        expect(st.actors[3].health).toBe(100);
        expect(st.player.health).toBe(100);
        blastStreet(st, 3, 1, 0, 8, 100, "party", true);
        expect(st.player.health).toBeLessThan(100);
    });

    it("burns soldiers standing in a fire", () => {
        const st = newStreet();
        st.actors.push(soldier(1, 0, 0));
        const fx = newFx(5);
        const f = ignite(fx, 0, 0, 0, 1.5, 30);
        f.age = 1;
        for (let i = 0; i < 300; i++) burnStreet(st, (x, z) => fireDamageAt(fx, x, z), 1 / 30, false);
        expect(st.actors[0].state).toBe("dead");
    });

    it("draws fire and smoke in their own fading materials, casting no shadow", () => {
        const s = ALLEGIANCE_INSTANCED_SHADER;
        expect(s).toContain(`material == ${MAT_FIRE} || material == ${MAT_SMOKE}`);
        expect(s).toContain("item.tex_origin.w) { discard; }");
        expect(s).toContain("material == 18 || material == 19 || o.view_w");
        expect(s).toContain("in.tex_pos * mat_scale, item.tex_origin.w < -0.5");
        for (const name of ["fx-fire", "fx-flame", "fx-spark"]) expect(PROPS[name]().vertexData[6]).toBe(MAT_FIRE);
        expect(PROPS["fx-smoke"]().vertexData[6]).toBe(MAT_SMOKE);
    });
});

describe("the Cobra", () => {
    it("parks one in every compound's courtyard, clear of its buildings and the flag", () => {
        for (const cs of [{ id: "outpost-x", buildings: 2, kind: "outpost" as const }, { id: "mil-y", buildings: 7, kind: "garrison" as const }]) {
            const l = compoundLayout(cs);
            const [x, z] = cobraSpot(l);
            expect(Math.hypot(x - l.flag[0], z - l.flag[1])).toBeGreaterThan(6);
            for (const st of l.structures) expect(Math.hypot(st.x - x, st.z - z) - Math.hypot(st.w, st.d) / 2).toBeGreaterThan(3);
        }
    });

    it("flies heavier and slower than the car", () => {
        expect(COBRA_SPEC.cruise).toBeLessThan(BASE_CAR.cruise);
        expect(COBRA_SPEC.boostMax).toBeLessThan(BASE_CAR.boostMax);
        const c = newCar({ x: 0, y: 0.22, z: 0, yaw: 0 });
        c.piloting = true;
        const env = { height: flat, sea: () => false, buildings: [] };
        for (let i = 0; i < 60; i++) stepCar(c, { ...NO_PLAYER_INPUT, jump: true }, false, 1 / 30, env, COBRA_SPEC);
        for (let i = 0; i < 120; i++) stepCar(c, { ...NO_PLAYER_INPUT, forward: true }, false, 1 / 30, env, COBRA_SPEC);
        expect(Math.hypot(c.vx, c.vz)).toBeCloseTo(COBRA_SPEC.cruise, 0);
    });

    it("charges its solar cells fastest under a high, clear sun", () => {
        expect(solarRate(1, 0)).toBeGreaterThan(solarRate(0.3, 0));
        expect(solarRate(1, 0)).toBeGreaterThan(solarRate(1, 1));
        expect(solarRate(-0.2, 0)).toBeGreaterThan(0);
        const s = newCobraState("mil-a");
        s.cells = 0;
        chargeCobra(s, 4, 1, 0);
        expect(s.cells).toBeGreaterThan(3.5);
        chargeCobra(s, 60, 1, 0);
        expect(s.cells).toBe(COBRA_CELLS);
    });

    it("fires from alternating pods, a cell a missile, with a pause between", () => {
        const c = { x: 0, y: 10, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0 };
        const s = newCobraState("mil-a");
        const a = fireMissile(c, s, [0, 0, 50], null, 1)!;
        expect(a).not.toBeNull();
        expect(fireMissile(c, s, [0, 0, 50], null, 2)).toBeNull();   // cooling down
        s.cooldown = 0;
        const b = fireMissile(c, s, [0, 0, 50], null, 3)!;
        expect(Math.sign(a.x)).toBe(-Math.sign(b.x));
        expect(s.cells).toBe(COBRA_CELLS - 2);
        // Pods sit on the flanks, ahead of center (forward is +z at yaw 0).
        expect(podPosition(c, 0)[2]).toBeGreaterThan(0);
        s.cells = 0.5; s.cooldown = 0;
        expect(fireMissile(c, s, [0, 0, 50], null, 4)).toBeNull();
    });

    it("flies its missiles into the ground, a building or the soldier it tracks", () => {
        const c = { x: 0, y: 30, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0 };
        const run = (ms: Missile[], w: Parameters<typeof stepMissiles>[2]) => {
            for (let i = 0; i < 400; i++) { const h = stepMissiles(ms, 1 / 60, w); if (h.length) return h[0]; }
            return null;
        };
        const s = newCobraState("mil-a");
        let hit = run([fireMissile(c, s, [0, 0, 80], null, 1)!], { height: flat, rects: [], soldiers: [] })!;
        expect(hit.kind).toBe("ground");
        expect(hit.z).toBeGreaterThan(70);
        s.cooldown = 0;
        hit = run([fireMissile(c, s, [0, 0, 80], null, 2)!], { height: flat, rects: [rect("wall", 0, 50, 20, 4, 40, "box")], soldiers: [] })!;
        expect(hit.kind).toBe("building");
        expect(hit.key).toBe("wall");
        expect(hit.z).toBeLessThan(49);
        // A tracked soldier who runs is followed.
        s.cooldown = 0;
        const runner = { id: 7, x: 0, y: 0, z: 60 };
        const m = fireMissile(c, s, [0, 1, 60], 7, 3)!;
        let soldierHit = null;
        for (let i = 0; i < 400 && !soldierHit; i++) { runner.x += 5 / 60; soldierHit = stepMissiles([m], 1 / 60, { height: flat, rects: [], soldiers: [runner] })[0] ?? null; }
        expect(soldierHit?.kind).toBe("soldier");
        expect(soldierHit?.soldier).toBe(7);
    });

    it("aims where the crosshair meets a building or the ground", () => {
        const wall = rect("w", 0, 40, 30, 2, 20, "box");
        const p = aimPoint([0, 10, 0], [0, -0.1, 0.995], 400, flat, [wall]);
        expect(p[2]).toBeCloseTo(39, 0);
        const g = aimPoint([0, 10, 0], [0, -0.5, 0.866], 400, flat, []);
        expect(g[1]).toBeCloseTo(0, 0);
        expect(g[2]).toBeCloseTo(17.3, 0);
        const sky = aimPoint([0, 10, 0], [0, 0.5, 0.866], 400, flat, []);
        expect(Math.hypot(sky[0], sky[1] - 10, sky[2])).toBeCloseTo(400, 0);
    });

    it("lets its hull take the hits while you are aboard", () => {
        const st = newStreet();
        st.player.hull = 100;
        blastStreet(st, 0, 1, 0, 8, 100, "enemy", true);
        expect(st.player.health).toBe(100);
        expect(st.player.hull).toBeLessThan(100);
        expect(st.events.some(e => e.kind === "hull-hit")).toBe(true);
    });

    it("gives a compound a new Cobra at dawn unless it is the one you keep", () => {
        const compounds = { a: { cobraTaken: true }, b: { cobraTaken: true }, c: {} };
        expect(restoreCobras(compounds, "b")).toBe(1);
        expect(compounds.a.cobraTaken).toBe(false);
        expect(compounds.b.cobraTaken).toBe(true);
    });

    it("has a Cobra mesh with glowing solar panels and missile pods", () => {
        const m = PROPS.cobra();
        const mats = new Set<number>();
        for (let i = 6; i < m.vertexData.length; i += 12) mats.add(m.vertexData[i]);
        expect(mats.has(3)).toBe(true);
        expect(mats.has(4)).toBe(true);
        let minX = Infinity, maxX = -Infinity;
        for (let i = 0; i < m.vertexData.length; i += 12) { minX = Math.min(minX, m.vertexData[i]); maxX = Math.max(maxX, m.vertexData[i]); }
        expect(maxX - minX).toBeGreaterThan(5);
    });
});
