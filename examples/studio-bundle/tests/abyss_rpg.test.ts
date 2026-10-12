// The Abyss: what Alex becomes, headless. Crouching and cover, stealth, the loot of the fallen,
// experience and perks, the river's powers, the Bore's tech, the enemy kinds (the behemoth's
// fire), and the places and encounters of the open floor - all played through the Game the
// addon drives.

import { describe, it, expect, beforeAll } from "vitest";
import { HeightGrid } from "../src/games/abyss/ab_world";
import { Game, GameWorld, NO_INPUT, type GameInput } from "../src/games/abyss/ab_game";
import { alive, kill, noticeRange, type Actor } from "../src/games/abyss/ab_combat";
import { eye } from "../src/games/abyss/ab_player";
import { addXp, newProgress, xpToNext, rollLoot, stats, ENEMIES, POWERS, UPGRADES, killXp } from "../src/games/abyss/ab_rpg";
import { PLACES_OF_NOTE, ENCOUNTERS, ELEVEN, PROCESSION, PLACES2 } from "../src/games/abyss/ab_script2";
import { placeProps, solids } from "../src/games/abyss/ab_props";
import { makeRng } from "../src/games/allegiance/al_rng";
import { lookupObject } from "../src/apps/mesha/library";
import { evaluateObject, validateDefinition } from "../src/apps/mesha/mesha_object";

const DT = 1 / 30;
let grid: HeightGrid;

beforeAll(() => {
    grid = new HeightGrid();
    grid.bake();
}, 300_000);

function newGame(chapter: 1 | 2 = 2): Game {
    const w = new GameWorld(grid);
    w.solids = solids(placeProps(1), chapter);
    return new Game(w);
}

function step(g: Game, frames = 1, input: Partial<GameInput> = {}): void {
    for (let i = 0; i < frames; i++) g.step(DT, { ...NO_INPUT, ...input });
}

function skipScene(g: Game): void {
    let guard = 0;
    while (g.cinema && guard++ < 5) step(g, 1, { skip: true });
}

/** An open floor with nobody else about (patrols out of range, Chapter Two begun). */
function openFloor(): Game {
    const g = newGame(2);
    g.start("roam");
    skipScene(g);
    return g;
}

/** A flat bit of the floor far from everything, with Alex on it. */
function clearing(g: Game, x = 330, z = -40): void {
    g.combat.actors = g.combat.actors.filter(a => a.faction !== "below");
    g.world.solids = g.world.solids.filter(s => Math.hypot(s.x - x, s.z - z) > 60);
    g.teleportTo(x, z, 0);
    step(g, 1);
}

describe("crouching and cover", () => {
    it("crouching lowers the eye below a barricade's top, slows the walk, and sprinting stands him up", () => {
        const g = openFloor();
        clearing(g);
        const standing = eye(g.body).pos[1] - g.body.y;
        step(g, 20, { crouch: true });
        expect(g.body.crouch).toBe(1);
        const crouched = eye(g.body).pos[1] - g.body.y;
        expect(standing).toBeGreaterThan(1.5);
        expect(crouched).toBeLessThan(1.05);
        const z0 = g.body.z;
        step(g, 30, { crouch: true, moveY: 1 });
        const crouchPace = (g.body.z - z0) / 1;
        expect(crouchPace).toBeLessThan(3);
        step(g, 10, { crouch: true, moveY: 1, sprint: true });
        expect(g.body.crouch).toBeLessThan(0.1);
    });

    it("a crouched Alex behind a barricade is out of sight; standing, he is seen over it; shots and bolts stop at it", () => {
        const g = openFloor();
        clearing(g);
        const x = 330, z = -40;
        // A wall of cover columns 1 m tall, 2 m in front of Alex (north).
        for (let i = -6; i <= 6; i++) g.world.solids.push({ x: x + i * 0.6, z: z + 2, r: 0.42, h: 1, cover: true });
        const w = g.spawnEnemy("adept", x, z + 30, { rank: "initiate" });
        const enemyEye: [number, number, number] = [w.x, w.y + 1.8, w.z];
        step(g, 20, { crouch: true });
        const low: [number, number, number] = [g.body.x, g.body.y + 0.75, g.body.z];
        const high: [number, number, number] = [g.body.x, g.body.y + 1.3, g.body.z];
        expect(g.world.clear(enemyEye, low)).toBe(false);
        expect(g.world.clear(enemyEye, high)).toBe(true);
        // A slug fired low through the wall stops at it.
        const from: [number, number, number] = [x, g.body.y + 0.6, z];
        expect(g.world.raySolids(from, [0, 0, 1], 100)).toBeLessThan(2.5);
        // A bolt inside the wall bursts there.
        expect(g.world.blocked([x, g.world.ground(x, z + 2) + 0.5, z + 2])).toBe(true);
        expect(g.world.blocked([x, g.world.ground(x, z + 2) + 1.6, z + 2])).toBe(false);
    });

    it("casters look for cover between them and their target", () => {
        const g = openFloor();
        clearing(g);
        const x = 330, z = -40;
        for (let i = -4; i <= 4; i++) g.world.solids.push({ x: x + i * 0.6, z: z + 40, r: 0.42, h: 1, cover: true });
        const spot = g.world.coverNear(x + 2, z + 46, [x, g.body.y + 1.3, z], 16)!;
        expect(spot).not.toBeNull();
        // Behind the wall, as seen from Alex.
        expect(spot[1]).toBeGreaterThan(z + 40);
    });

    it("crouched and unheard, a warden notices him only close; a shot or the Veil changes that", () => {
        const g = openFloor();
        clearing(g);
        const w = g.spawnEnemy("warden", 330, 40, { rank: "initiate" });
        w.yaw = Math.PI; // facing Alex
        const view = (crouch: number, veiled = false) => ({ x: g.body.x, y: g.body.y, z: g.body.z, yaw: 0, alive: true, crouch, veiled, hurt() {} });
        expect(noticeRange(g.combat, w, view(0), 140)).toBe(140);
        expect(noticeRange(g.combat, w, view(1), 140)).toBeLessThan(55);
        expect(noticeRange(g.combat, w, view(0, true), 140)).toBeLessThanOrEqual(10);
        g.combat.alert = 5;
        expect(noticeRange(g.combat, w, view(1), 140)).toBe(140);
    });
});

describe("the fallen and what they carry", () => {
    it("every hostile who falls leaves something to search, and Alex earns experience for his own kills", () => {
        const g = openFloor();
        clearing(g);
        const xp0 = g.rpg.xp + xpToNext(g.rpg.level) * 0;
        const w = g.spawnEnemy("warden", g.body.x, g.body.z + 1.5, { rank: "veteran" });
        kill(g.combat, w, "player");
        step(g, 1);
        expect(g.rpg.xp + (g.rpg.level - 1) * 1000).toBeGreaterThan(xp0);
        const loot = g.pickups.find(p => p.kind === "loot" && p.actor === w.id)!;
        expect(loot).toBeTruthy();
        expect(loot.items!.length).toBeGreaterThan(0);
        const before = g.inv.artifacts.length + g.inv.medgel + g.inv.draughts;
        g.teleportTo(loot.x + 0.5, loot.z, 0);
        step(g, 1);
        step(g, 1, { interact: true });
        expect(loot.taken).toBe(true);
        expect(g.inv.artifacts.length + g.inv.medgel + g.inv.draughts).toBeGreaterThan(before);
    });

    it("loot tables: wardens always carry beads, champions something better, a behemoth its tusk", () => {
        const rng = makeRng(3);
        for (let i = 0; i < 20; i++) expect(rollLoot(rng, "warden", "initiate")).toContain("lumen-bead");
        expect(rollLoot(rng, "champion", "veteran")).toContain("warden-sigil");
        expect(rollLoot(rng, "behemoth", "elite")).toContain("behemoth-tusk");
        // The scavenger perk carries more on average.
        const count = (scav: number) => { const r = makeRng(9); let n = 0; for (let i = 0; i < 400; i++) n += rollLoot(r, "warden", "initiate", scav).length; return n; };
        expect(count(2)).toBeGreaterThan(count(0));
    });
});

describe("experience, levels and perks", () => {
    it("levels up on experience, a perk point each, more vitals each", () => {
        const p = newProgress();
        expect(addXp(p, xpToNext(1) - 1)).toBe(0);
        expect(addXp(p, 1 + xpToNext(2))).toBe(2);
        expect(p.level).toBe(3);
        expect(p.points).toBe(2);
        expect(stats(p).maxHealth).toBe(108);
        expect(killXp("champion", "elite")).toBeGreaterThan(killXp("warden", "initiate") * 10);
    });

    it("perks change the numbers: plates, steadier aim, softer steps", () => {
        const g = openFloor();
        g.rpg.points = 4;
        const cap = g.armorCap();
        expect(g.takePerk("plating")).toBe(true);
        expect(g.armorCap()).toBe(cap + 20);
        expect(g.takePerk("steady")).toBe(true);
        expect(stats(g.rpg).spread).toBeCloseTo(0.85);
        expect(g.takePerk("softstep")).toBe(true);
        expect(stats(g.rpg).stealth).toBeCloseTo(0.8);
        expect(g.rpg.points).toBe(1);
        g.rpg.points = 0;
        expect(g.takePerk("medic")).toBe(false);
    });
});

describe("powers of the river and the Bore's tech", () => {
    it("a potion teaches a power; casting spends Resonance; the lance burns a warden through its ward", () => {
        const g = openFloor();
        clearing(g);
        expect(g.learn("lance")).toBe(true);
        expect(g.rpg.power).toBe("lance");
        expect(g.rpg.resonance).toBe(100);
        const champ = g.spawnEnemy("champion", g.body.x, g.body.z + 12, { rank: "initiate" });
        g.combat.wardensPassive = true;
        const ward0 = champ.ward!;
        g.body.yaw = 0; g.body.pitch = Math.atan2(champ.y + 1.2 - (g.body.y + 1.66), 12);
        step(g, 1, { cast: true });
        expect(g.rpg.resonance).toBeLessThan(100);
        expect(champ.ward!).toBeLessThan(ward0);
        // Cooling down: a second press at once does nothing.
        const r = g.rpg.resonance;
        step(g, 1, { cast: true });
        expect(g.rpg.resonance).toBeGreaterThanOrEqual(r);
    });

    it("Still Water drinks damage; Mend heals; a draught refills Resonance", () => {
        const g = openFloor();
        clearing(g);
        g.learn("ward"); g.learn("mend");
        g.rpg.power = "ward";
        step(g, 1, { cast: true });
        expect(g.ward.hp).toBe(90);
        const h = g.health;
        g.hurt(40, [g.body.x, g.body.y, g.body.z + 5]);
        expect(g.health).toBe(h);
        expect(g.ward.hp).toBe(50);
        g.health = 40;
        g.rpg.power = "mend";
        g.powerCd = 0;
        step(g, 1, { cast: true });
        step(g, 4 * 30);
        expect(g.health).toBeGreaterThan(80);
        g.rpg.resonance = 0;
        g.inv.draughts = 1;
        step(g, 1, { draught: true });
        expect(g.inv.draughts).toBe(0);
        expect(g.rpg.resonance).toBeGreaterThan(45);
    });

    it("tech upgrades install for good", () => {
        const g = openFloor();
        const cap = g.armorCap();
        expect(g.install("weave")).toBe(true);
        expect(g.armorCap()).toBe(cap + 40);
        expect(g.install("weave")).toBe(false);
        expect(g.install("reflex")).toBe(true);
        expect(stats(g.rpg).sprint).toBeGreaterThan(1);
        expect(Object.keys(UPGRADES).length).toBe(5);
        expect(Object.keys(POWERS).length).toBe(5);
    });
});

describe("enemy kinds", () => {
    it("ranks make tougher enemies; champions carry a ward; every kind has a look", () => {
        const g = openFloor();
        clearing(g);
        const a = g.spawnEnemy("warden", 330, 0, { rank: "initiate" });
        const b = g.spawnEnemy("warden", 334, 0, { rank: "elite" });
        expect(b.maxHp).toBeGreaterThan(a.maxHp * 2);
        expect(b.power!).toBeGreaterThan(a.power!);
        const c = g.spawnEnemy("champion", 338, 0);
        expect(c.ward!).toBeGreaterThan(0);
        for (const def of Object.values(ENEMIES)) expect(def.look).toBeTruthy();
    });

    it("the behemoth breathes fire on what stands before it, and its rider rides in the howdah", () => {
        const g = openFloor();
        clearing(g);
        const x = g.body.x, z = g.body.z;
        const beast = g.spawnEnemy("behemoth", x, z + 14, { rank: "initiate" });
        beast.yaw = Math.PI;
        const rider = g.spawnEnemy("adept", beast.x, beast.z, { rank: "initiate" });
        rider.mount = beast.id;
        g.inv.armor = 0;
        const h0 = g.health;
        let fired = false;
        for (let i = 0; i < 30 * 6 && g.alive; i++) {
            step(g, 1);
            if (beast.state === "cast") fired = true;
        }
        expect(fired).toBe(true);
        expect(g.health < h0 || !g.alive).toBe(true);
        expect(g.fx.particles.some(p => p.kind === "fire")).toBe(true);
        // The rider stays up on its back.
        expect(rider.y).toBeGreaterThan(beast.y + 4);
        expect(Math.hypot(rider.x - beast.x, rider.z - beast.z)).toBeLessThan(2);
    });

    it("the behemoth is a ready Mesha object with its legs split off", () => {
        const def = lookupObject("creature.behemoth")!;
        expect(validateDefinition(def)).toEqual([]);
        const e = evaluateObject(def, {}, lookupObject);
        const regions = new Set(e.mesh.parts.map(p => p.region));
        for (const r of ["legFL", "legFR", "legBL", "legBR", "fire", "tusk"]) expect(regions.has(r)).toBe(true);
        expect(e.stats.triangles).toBeLessThan(12000);
        const bar = lookupObject("street.barricade")!;
        expect(validateDefinition(bar)).toEqual([]);
        for (const p of bar.presets!) {
            const b = evaluateObject(bar, p.values, lookupObject).stats.bounds!;
            expect(b.max[1]).toBeGreaterThan(0.85);
            expect(b.max[1]).toBeLessThan(1.25);
        }
    });
});

describe("places and encounters of the open floor", () => {
    it("finding a place gives experience once and lists it", () => {
        const g = openFloor();
        clearing(g);
        const pl = PLACES_OF_NOTE.find(p => p.id === "source")!;
        const lv = g.rpg.level, xp = g.rpg.xp;
        g.teleportTo(pl.at[0], pl.at[1] + 10, 0);
        step(g, 2);
        expect(g.rpg.discovered).toContain("source");
        expect(g.rpg.level > lv || g.rpg.xp > xp).toBe(true);
        const n = g.rpg.discovered.length;
        step(g, 2);
        expect(g.rpg.discovered.length).toBe(n);
    });

    it("an encounter begins as Alex nears: its guard, its prize; taking the prize ends it - fought or sneaked", () => {
        const g = openFloor();
        const e = ENCOUNTERS.find(x => x.id === "vigil")!;
        const pl = PLACES_OF_NOTE.find(p => p.id === e.place)!;
        g.teleportTo(pl.at[0], pl.at[1] - 150, 0);
        step(g, 2);
        expect(g.ch2!.summary().quests["enc-vigil"].status).toBe("active");
        const guards = g.combat.actors.filter(a => a.tag === "enc:vigil" && alive(a));
        expect(guards.length).toBe(e.guards.length);
        expect(guards.some(a => a.kind === "champion")).toBe(true);
        const prize = g.pickups.find(p => p.kind === "potion" && !p.taken)!;
        expect(prize.item).toBe("lance");
        // Sneak in and take it from under their noses.
        g.combat.wardensPassive = true;
        g.teleportTo(prize.x + 0.6, prize.z, 0);
        step(g, 1);
        step(g, 1, { interact: true });
        step(g, 2);
        expect(g.rpg.powers).toContain("lance");
        expect(g.ch2!.summary().quests["enc-vigil"].status).toBe("done");
    });

    it("the bone field's behemoth comes with a rider; the surface's caches hold tech", () => {
        const g = openFloor();
        const bf = PLACES_OF_NOTE.find(p => p.id === "bonefield")!;
        g.teleportTo(bf.at[0], bf.at[1] - 240, 0);
        step(g, 2);
        const beast = g.combat.actors.find(a => a.role === "beast")!;
        expect(beast).toBeTruthy();
        expect(g.combat.actors.some(a => a.mount === beast.id)).toBe(true);
        const st = PLACES_OF_NOTE.find(p => p.id === "station9")!;
        g.teleportTo(st.at[0], st.at[1] + 200, 0);
        step(g, 2);
        expect(g.pickups.filter(p => p.kind === "tech" && !p.taken).map(p => p.item).sort()).toEqual(["reflex", "weave"]);
        expect(g.combat.actors.filter(a => a.tag === "enc:station9").every(a => a.role === "gunner")).toBe(true);
    });

    it("Eleven Is Down calls Alex in on the radio, and its crew holds their wreck", () => {
        const g = openFloor();
        g.teleportTo(ELEVEN[0] + 300, ELEVEN[1], 0);
        step(g, 2);
        expect(g.ch2!.summary().quests.eleven.status).toBe("active");
        g.teleportTo(ELEVEN[0] + 10, ELEVEN[1], 0);
        step(g, 2);
        expect(g.ch2!.summary().quests.eleven.stage).toBe("defend");
        const crew = g.combat.actors.filter(a => a.tag === "crew");
        expect(crew.length).toBe(3);
        for (const a of g.combat.actors.filter(x => x.tag === "eleven")) kill(g.combat, a, "player");
        step(g, 2);
        expect(g.ch2!.summary().quests.eleven.stage).toBe("talk");
        // The crew stayed by the wreck rather than trailing after Alex.
        g.teleportTo(ELEVEN[0] + 200, ELEVEN[1], 0);
        step(g, 60);
        for (const a of crew) expect(Math.hypot(a.x - ELEVEN[0], a.z - ELEVEN[1])).toBeLessThan(20);
    });

    it("The Last Procession: sentinels shoot pilgrims of below; their elder thanks Alex with the river's vials", () => {
        const g = openFloor();
        g.teleportTo(PROCESSION[0] + 150, PROCESSION[1], 0);
        step(g, 2);
        expect(g.ch2!.summary().quests.procession.stage).toBe("defend");
        const sentinels = g.combat.actors.filter(a => a.tag === "procession");
        expect(sentinels.length).toBe(4);
        for (const a of sentinels) kill(g.combat, a, "player");
        step(g, 2);
        const elder = g.ch2!.npc("elder")!;
        g.teleportTo(elder.x + 1.5, elder.z, 0);
        step(g, 1);
        const d0 = g.inv.draughts;
        step(g, 1, { interact: true });
        step(g, 3);
        expect(g.ch2!.summary().quests.procession.status).toBe("done");
        expect(g.inv.draughts).toBe(d0 + 3);
    });

    it("saves and restores what Alex has become", () => {
        const g = openFloor();
        g.learn("veil");
        g.install("optics");
        g.rpg.discovered.push("source");
        addXp(g.rpg, 500);
        const save = JSON.parse(JSON.stringify(g.ch2!.save()));
        const h = openFloor();
        h.ch2!.load(save);
        expect(h.rpg.powers).toContain("veil");
        expect(h.rpg.upgrades).toContain("optics");
        expect(h.rpg.level).toBe(g.rpg.level);
        expect(h.rpg.discovered).toContain("source");
        void PLACES2;
        void ({} as Actor);
    });
});
