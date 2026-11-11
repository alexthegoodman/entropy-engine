// Nebula Kingdom, played headless: feeding and growing, siphoning worlds and stars, combat,
// the governments' law, lightwaves and black-hole shadows, the holes themselves, and folding.

import { describe, it, expect } from "vitest";
import { Game, NO_INPUT, newCampaign, type GameEvent } from "../src/games/nebula/nk_game";
import { REGIONS, massOfRadius, radiusOfLevel, ABILITIES } from "../src/games/nebula/nk_data";
import { makeCreature } from "../src/games/nebula/nk_world";
import { add, mul, dist, len, type V3 } from "../src/games/nebula/nk_math";
import { DT, run, steer, flyTo, mine } from "./nebula_bot";

function at(region: string, level?: number): Game {
    const i = REGIONS.findIndex(r => r.id === region);
    const c = newCampaign();
    c.completed = REGIONS.slice(0, i).map(r => r.id);
    c.region = region;
    c.mass = massOfRadius(radiusOfLevel(level ?? 1 + i * 3)) * 1.02;
    return new Game(c);
}
/** Steps and gathers every event. */
function collect(g: Game, seconds: number, input = NO_INPUT): GameEvent[] {
    const out: GameEvent[] = [];
    for (let t = 0; t < seconds; t += DT) { g.step(DT, input); out.push(...g.events); }
    return out;
}

describe("flight and feeding", () => {
    it("thrust moves the nebula the way it faces, and a Lightstride is many times faster", () => {
        const g = new Game();
        collect(g, 2, { ...NO_INPUT, thrust: 1 });
        const cruise = len(g.player.vel);
        expect(g.player.pos[2]).toBeGreaterThan(g.region.entry[2]);
        expect(cruise).toBeCloseTo(g.player.radius * 2.6, -2);
        collect(g, 3, { ...NO_INPUT, thrust: 1, surge: true });
        expect(len(g.player.vel)).toBeGreaterThan(cruise * 8);
        expect(g.player.charge).toBeLessThan(g.maxCharge);
    });
    it("absorbs motes, which fall to it from a distance, and grows", () => {
        const g = new Game();
        const mote = g.region.bodies.find(b => b.kind === "mote")!;
        g.player.pos = add(mote.pos, [0, 0, -g.player.radius * 3]);
        const before = g.mass;
        const ev = collect(g, 3);
        expect(ev.some(e => e.kind === "absorb")).toBe(true);
        expect(g.mass).toBeGreaterThan(before);
        expect(g.goals[0].progress).toBeGreaterThan(0);
    });
    it("swallows rubble smaller than half its size and is stopped by what is bigger", () => {
        const g = new Game();
        const rock = g.region.bodies.find(b => b.kind === "asteroid" && b.radius < g.player.radius * 0.45)!;
        g.player.pos = [...rock.pos];
        g.step(DT);
        expect(rock.alive).toBe(false);
        const pell = g.region.bodies.find(b => b.key === "pell")!;
        g.player.pos = [...pell.pos];
        g.step(DT);
        expect(dist(g.player.pos, pell.pos)).toBeGreaterThanOrEqual(pell.radius);
    });
    it("mines a whole moon by siphoning it, growing all the while", () => {
        const g = new Game();
        const pell = g.region.bodies.find(b => b.key === "pell")!;
        const r0 = g.player.radius;
        expect(mine(g, "pell")).toBe(true);
        expect(g.goals.find(x => x.def.id === "pell")!.done).toBe(true);
        expect(g.player.radius).toBeGreaterThan(r0 * 1.7);
        expect(g.player.level).toBeGreaterThan(1);
        expect(g.campaign.points).toBeGreaterThan(0);
        expect(pell.alive).toBe(false);
    });
    it("a star being consumed throws flares that a Lightstride carries you through", () => {
        const g = at("hearthring");
        const candle = g.region.bodies.find(b => b.key === "candle")!;
        g.player.pos = add(candle.pos, [0, 0, -(candle.radius + g.player.radius * 1.5)]);
        const ev = collect(g, 6, { ...NO_INPUT, siphon: true });
        expect(ev.some(e => e.kind === "starflare")).toBe(true);
        expect(ev.some(e => e.kind === "hurt")).toBe(true);
        expect(mine(g, "candle")).toBe(true);
        expect(g.campaign.stats.stars).toBe(1);
    });
    it("spends facet points", () => {
        const g = at("tollgate");
        g.campaign.points = 2;
        const hp = g.maxCohesion;
        expect(g.spendFacet("density")).toBe(true);
        expect(g.maxCohesion).toBeGreaterThan(hp);
        expect(g.spendFacet("current")).toBe(true);
        expect(g.spendFacet("reach")).toBe(false);
    });
});

describe("combat", () => {
    it("the Lance finds a hostile creature near the aim and kills it; it leaves essence", () => {
        const g = new Game();
        const foe = g.region.creatures.find(c => c.species.id === "gnawer")!;
        g.player.pos = add(foe.pos, [0, 0, -g.player.radius * 14]);
        const ev: GameEvent[] = [];
        run(g, 60, x => { const s = steer(x, foe.pos, { fire: true }); s.thrust = 0; return s; }, x => { ev.push(...x.events); return !foe.alive; });
        expect(foe.alive).toBe(false);
        expect(g.region.bodies.some(b => b.kind === "essence")).toBe(true);
        expect(g.campaign.stats.kills).toBe(1);
    });
    it("bigger things hit harder: damage scales with the sizes", () => {
        expect(Game.scaled(10, 2, 1)).toBeGreaterThan(Game.scaled(10, 1, 1));
        expect(Game.scaled(10, 1, 2)).toBeLessThan(10);
        expect(Game.scaled(10, 1, 1)).toBe(10);
    });
    it("the Pulse throws hostile things back and spares friends", () => {
        const g = at("hearthring", 5);
        const p = g.player;
        const foe = makeCreature(g.region, "quill", add(p.pos, [0, 0, p.radius * 5]));
        const friend = makeCreature(g.region, "manta", add(p.pos, [p.radius * 5, 0, 0]));
        const hp = friend.hp;
        g.step(DT, { ...NO_INPUT, pulse: true });
        expect(foe.hp).toBeLessThan(foe.maxHp);
        expect(len(foe.vel)).toBeGreaterThan(p.radius);
        expect(friend.hp).toBe(hp);
        expect(g.player.cd.pulse).toBeGreaterThan(0);
    });
    it("is dispersed at no cohesion and gathers again, a little smaller", () => {
        const g = at("tollgate");
        const mass = g.mass;
        g.player.cohesion = 0.01;
        g.player.sinceHurt = 0;
        makeCreature(g.region, "thrall", add(g.player.pos, [0, 0, g.player.radius * 2]));
        const ev = collect(g, 12);
        expect(ev.some(e => e.kind === "dispersed")).toBe(true);
        expect(ev.some(e => e.kind === "reformed")).toBe(true);
        expect(g.player.alive).toBe(true);
        expect(g.mass).toBeLessThan(mass);
        expect(g.mass).toBeGreaterThanOrEqual(1);
    });
    it("a beast will not pick a fight with a cloud far bigger than it", () => {
        const g = at("cradle", 6);
        const sk = g.region.creatures.find(c => c.species.id === "skimmer")!;
        g.player.pos = add(sk.pos, [0, 0, -g.player.radius * 3]);
        collect(g, 2);
        expect(sk.state).not.toBe("hunt");
    });
    it("the Veil hides you from hunters", () => {
        const g = at("tollgate", 7);
        expect(g.has("veil")).toBe(true);
        const m = g.region.creatures.find(c => c.species.id === "marauder")!;
        g.player.pos = add(m.pos, [0, 0, -m.sight * 0.6]);
        g.step(DT, { ...NO_INPUT, veil: true });
        collect(g, 2);
        expect(g.player.veil).toBe(true);
        expect(m.state).not.toBe("hunt");
        g.step(DT, { ...NO_INPUT, veil: true });
        g.player.cd.veil = 0;
        collect(g, 2);
        expect(m.state).toBe("hunt");
    });
});

describe("governments", () => {
    it("feeding on a living world is a crime its government answers", () => {
        const g = at("hearthring");
        const aurel = g.region.bodies.find(b => b.key === "aurel")!;
        const before = g.standing("concord");
        g.player.pos = add(aurel.pos, [0, 0, -(aurel.radius + g.player.radius * 1.5)]);
        const ev = collect(g, 1, { ...NO_INPUT, siphon: true });
        expect(ev.some(e => e.kind === "crime")).toBe(true);
        expect(g.standing("concord")).toBe(before - 30);
        const warden = g.region.creatures.find(c => c.species.id === "warden")!;
        expect(g.hostile(warden)).toBe(true);
    });
    it("tribute to an envoy buys standing for a twentieth of your mass", () => {
        const g = at("tollgate");
        const envoy = g.region.creatures.find(c => c.species.id === "envoy")!;
        g.player.pos = add(envoy.pos, [0, 0, -(envoy.radius + g.player.radius * 3)]);
        const mass = g.mass, standing = g.standing("drift");
        g.step(DT, { ...NO_INPUT, tribute: true });
        expect(g.mass).toBeCloseTo(mass * 0.95, 5);
        expect(g.standing("drift")).toBe(standing + 12);
        g.step(DT);
        expect(g.goals.find(x => x.def.id === "toll")!.done).toBe(true);
    });
    it("soldiers of governments at war fight each other", () => {
        const g = at("hearthring");
        const warden = g.region.creatures.find(c => c.species.id === "warden")!;
        const quill = makeCreature(g.region, "quill", add(warden.pos, [0, 0, g.region.scale * 6]));
        g.player.pos = add(warden.pos, [0, g.region.scale * 300, 0]);
        collect(g, 3);
        expect(warden.state).toBe("hunt");
        expect(warden.target).toBe(quill.id);
        expect(quill.target).not.toBe(-1);
    });
    it("killing a government's citizens costs standing with it and pleases its enemies", () => {
        const g = at("marches");
        const quill = g.region.creatures.find(c => c.species.id === "quill")!;
        const ember = g.standing("ember"), concord = g.standing("concord");
        g.hurtCreature(quill, 1e6, g.player.radius, -1);
        expect(g.standing("ember")).toBeLessThan(ember);
        expect(g.standing("concord")).toBeGreaterThan(concord);
    });
});

describe("lightwaves", () => {
    it("the region's edict arrives as a wave, a moment after it is sent", () => {
        const g = new Game();
        collect(g, 1.3);
        expect(g.signals.some(s => s.kind === "edict")).toBe(true);
        expect(g.messages).toHaveLength(0);
        collect(g, 2);
        expect(g.messages[0].kind).toBe("edict");
        expect(g.messages[0].text).toContain("Wisp");
    });
    it("an unknown government's speech is garbled until you have listened to it", () => {
        const g = at("choir");
        collect(g, 4);
        const edict = g.messages.find(m => m.kind === "edict")!;
        expect(edict.text).not.toContain("Cantor has strayed");
        g.campaign.lexicon.synod = 20;
        expect(g.fluency("synod")).toBe(1);
    });
    it("a cry for help brings the creature's own kind - unless a black hole's shadow lies between", () => {
        const g = at("bazaar");
        const hole = g.region.holes[0];
        const a = makeCreature(g.region, "quill", add(hole.pos, [hole.radius * 8, 0, 0]));
        const heard = makeCreature(g.region, "quill", add(hole.pos, [hole.radius * 8, hole.radius * 6, 0]));
        const deaf = makeCreature(g.region, "quill", add(hole.pos, [-hole.radius * 8, 0, 0]));
        for (const c of [a, heard, deaf]) c.sight = 0;
        g.player.pos = add(hole.pos, [hole.radius * 8, 0, -hole.radius * 30]);
        g.campaign.standing.ember = 0;
        expect(g.shadowed(a.pos, deaf.pos)).toBe(hole);
        expect(g.shadowed(a.pos, heard.pos)).toBeNull();
        g.hurtCreature(a, 1, g.player.radius, -1);
        collect(g, 3);
        expect(heard.provoked).toBeGreaterThan(0);
        expect(deaf.provoked).toBe(0);
    });
    it("attuning is a toggle the game reports", () => {
        const g = new Game();
        g.step(DT, { ...NO_INPUT, attune: true });
        expect(g.player.attune).toBe(true);
        expect(g.events.some(e => e.kind === "attune")).toBe(true);
    });
});

describe("black holes", () => {
    it("pull harder the nearer you are", () => {
        const g = at("bazaar");
        const hole = g.region.holes[0];
        const drift = (d: number) => { g.player.pos = add(hole.pos, [hole.radius * d, 0, 0]); g.player.vel = [0, 0, 0]; g.step(DT); return -g.player.vel[0]; };
        expect(drift(3)).toBeGreaterThan(drift(6) * 3);
    });
    it("crossing a horizon tears a third of you away and throws you out", () => {
        const g = at("bazaar");
        const hole = g.region.holes[0], mass = g.mass;
        g.player.pos = add(hole.pos, [hole.radius * 0.5, 0, 0]);
        g.step(DT);
        expect(g.events.some(e => e.kind === "torn")).toBe(true);
        expect(g.mass).toBeCloseTo(mass * 0.65, 5);
        expect(dist(g.player.pos, hole.pos)).toBeGreaterThan(hole.radius * 3);
        expect(g.player.alive).toBe(true);
    });
    it("grazing the ergosphere and coming out again is a slingshot", () => {
        const g = at("bazaar");
        const hole = g.region.holes[0];
        g.player.pos = add(hole.pos, [hole.radius * 2, 0, -hole.radius * 3]);
        g.player.yaw = 0;
        const ev = collect(g, 8, { ...NO_INPUT, thrust: 1, surge: true });
        expect(ev.some(e => e.kind === "sling")).toBe(true);
        expect(g.goals.find(x => x.def.type === "sling")!.done).toBe(true);
    });
    it("hunters fly straight at you - and into a hole kept between you and them", () => {
        const g = at("bazaar");
        const hole = g.region.holes[0];
        g.region.creatures = [];
        g.player.pos = add(hole.pos, [0, 0, -hole.radius * 3.4]);
        for (let i = 0; i < 4; i++) { const c = makeCreature(g.region, "marauder", add(hole.pos, [(i - 1.5) * hole.radius * 0.3, 0, hole.radius * 9])); c.state = "hunt"; c.target = -1; c.provoked = 99; }
        const ev = collect(g, 25);
        expect(ev.filter(e => e.kind === "swallowed").length).toBeGreaterThanOrEqual(3);
        expect(hole.fed).toBeGreaterThanOrEqual(3);
    });
    it("a hunting hole follows mass - and prefers what you Shed", () => {
        const g = at("choir");
        const hole = g.region.holes.find(h => h.key === "cantor")!;
        const start: V3 = [...hole.pos];
        g.region.creatures = [];
        g.player.pos = add(hole.pos, [hole.radius * 12, 0, 0]);
        collect(g, 3);
        expect(hole.pos[0]).toBeGreaterThan(start[0]);
        expect(g.has("decoy")).toBe(true);
        g.player.yaw = -Math.PI / 2;   // facing -X: the knot is shed behind, toward +X
        g.step(DT, { ...NO_INPUT, decoy: true });
        expect(g.decoys).toHaveLength(1);
        const decoy = g.decoys[0];
        g.player.pos = add(hole.pos, [-hole.radius * 12, 0, 0]);
        const x0 = hole.pos[0];
        collect(g, 2);
        expect(hole.pos[0]).toBeGreaterThan(x0);
        expect(dist(hole.pos, decoy.pos)).toBeLessThan(dist(start, decoy.pos));
    });
    it("a hole led into the rift is banished", () => {
        const g = at("choir");
        const hole = g.region.holes.find(h => h.key === "cantor")!;
        hole.pos = add(g.region.rift!.pos, [g.region.rift!.radius * 1.5, 0, 0]);
        g.region.creatures = [];
        g.player.pos = add(g.region.rift!.pos, [-hole.radius * 9, 0, 0]);
        const ev = collect(g, 30);
        expect(ev.some(e => e.kind === "banished")).toBe(true);
        expect(g.region.holes.some(h => h.key === "cantor")).toBe(false);
        expect(g.goals.find(x => x.def.id === "lure")!.done).toBe(true);
    });
    it("two holes led together merge, and the wave scours the region", () => {
        const g = at("drowned");
        const dirge = g.region.holes.find(h => h.key === "dirge")!, knell = g.region.holes.find(h => h.key === "knell")!;
        const size = knell.radius + dirge.radius;
        dirge.pos = add(knell.pos, [knell.radius * 3, 0, 0]);
        g.player.pos = add(knell.pos, [-knell.radius * 12, 0, 0]);
        const ev = collect(g, 30);
        expect(ev.some(e => e.kind === "merge")).toBe(true);
        expect(g.region.holes).toHaveLength(1);
        expect(knell.radius).toBeCloseTo(size);
        expect(g.region.creatures.some(c => c.species.menace)).toBe(false);
    });
    it("the Hollow King ignores decoys and the rift stays shut until its anchors are eaten", () => {
        const g = at("throne");
        expect(g.region.rift!.open).toBe(false);
        expect(g.goals.find(x => x.def.id === "king")!.locked).toBe(true);
        for (const b of g.region.bodies) if (b.key.startsWith("anchor")) g.player.pos = [...b.pos], b.radius = g.player.radius * 0.4;
        for (const k of ["anchor1", "anchor2", "anchor3"]) { const b = g.region.bodies.find(x => x.key === k)!; g.player.pos = [...b.pos]; g.step(DT); }
        expect(g.goals.find(x => x.def.id === "anchors")!.done).toBe(true);
        expect(g.goals.find(x => x.def.id === "king")!.locked).toBe(false);
        expect(g.region.rift!.open).toBe(true);
    });
});

describe("folding", () => {
    it("only reaches where your light has: the next region opens when this one is done", () => {
        const g = new Game();
        expect(g.canFold("hearthring").ok).toBe(false);
        expect(g.canFold("cradle").why).toBe("You are here");
        g.campaign.completed.push("cradle");
        expect(g.canFold("hearthring").ok).toBe(true);
        expect(g.canFold("tollgate").ok).toBe(false);
    });
    it("crosses galaxies in under three seconds, from anywhere", () => {
        const g = at("throne");
        expect(g.region.def.galaxy).toBe("hollow");
        g.player.pos = add(g.player.pos, mul([1, 0, 0], g.region.scale * 500));
        expect(g.startFold("cradle")).toBe(true);
        const ev = collect(g, 2.7);
        expect(ev.some(e => e.kind === "arrive")).toBe(true);
        expect(g.region.def.id).toBe("cradle");
        expect(g.region.def.galaxy).toBe("lantern");
        expect(g.fold).toBeNull();
        expect(g.campaign.stats.folds).toBe(1);
        expect(g.player.pos).toEqual(g.region.entry);
    });
    it("a black hole's grip holds your light", () => {
        const g = at("bazaar");
        g.campaign.completed.push("bazaar");
        const hole = g.region.holes[0];
        g.player.pos = add(hole.pos, [hole.radius * 2.5, 0, 0]);
        expect(g.canFold("cradle").ok).toBe(false);
    });
    it("what was finished in a region stays finished when you return", () => {
        const g = new Game();
        expect(mine(g, "pell")).toBe(true);
        g.campaign.completed.push("cradle");
        g.startFold("hearthring");
        collect(g, 3);
        g.startFold("cradle");
        collect(g, 3);
        expect(g.region.bodies.some(b => b.key === "pell")).toBe(false);
        expect(g.goals.find(x => x.def.id === "pell")!.done).toBe(true);
    });
    it("the campaign survives being saved as JSON", () => {
        const g = at("bazaar");
        g.campaign.points = 3;
        const copy = new Game(JSON.parse(JSON.stringify(g.campaign)));
        expect(copy.region.def.id).toBe("bazaar");
        expect(copy.player.level).toBe(g.player.level);
        expect(copy.campaign.points).toBe(3);
        expect(copy.has("decoy")).toBe(g.player.level >= ABILITIES.decoy.level);
    });
    void flyTo;
});
