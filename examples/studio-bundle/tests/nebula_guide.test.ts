// Nebula Kingdom's second pass: the Field Guide that explains every new thing, the gamepad's
// Lightstride, four blasts, four forms, Grace and Ruin, and the new creatures and their variants.

import { describe, it, expect } from "vitest";
import { Game, NO_INPUT, newCampaign, normalizeCampaign, YIELD_TIME, type GameEvent, type Campaign } from "../src/games/nebula/nk_game";
import {
    REGIONS, LESSONS, GOAL_HOW, ABILITIES, BLASTS, BLAST_IDS, FORM_LEVEL, SPECIES, BINDINGS, massOfRadius, radiusOfLevel, controlText, alignmentTier,
} from "../src/games/nebula/nk_data";
import { generateRegion, makeCreature } from "../src/games/nebula/nk_world";
import { nebulaPalette } from "../src/games/nebula/nk_scene";
import { drawHud, drawTitle, drawCodex, type HudView } from "../src/games/nebula/nk_hud";
import { Painter } from "../src/games/allegiance/al_ui";
import { add, dist, len, type V3 } from "../src/games/nebula/nk_math";
import { DT } from "./nebula_bot";

function at(region: string, level?: number): Game {
    const i = REGIONS.findIndex(r => r.id === region);
    const c = newCampaign();
    c.completed = REGIONS.slice(0, i).map(r => r.id);
    c.region = region;
    c.mass = massOfRadius(radiusOfLevel(level ?? 1 + i * 3)) * 1.02;
    return new Game(c);
}
function collect(g: Game, seconds: number, input = NO_INPUT): GameEvent[] {
    const out: GameEvent[] = [];
    for (let t = 0; t < seconds; t += DT) { g.step(DT, input); out.push(...g.events); }
    return out;
}
const lessons = (ev: GameEvent[]) => ev.flatMap(e => (e.kind === "lesson" ? [e.id] : []));
/** An empty stretch of the region, far from everything, to test one creature at a time. */
function alone(g: Game): void { g.region.creatures = []; g.region.holes = []; g.player.pos = [0, g.region.scale * 900, 0]; g.player.vel = [0, 0, 0]; }

describe("the Field Guide", () => {
    it("explains flying and every goal of the first region as soon as you arrive", () => {
        const g = new Game();
        const ids = lessons(collect(g, 1));
        expect(ids[0]).toBe("fly");
        for (const id of ["goal:absorb", "goal:mine", "goal:clear"]) expect(ids, id).toContain(id);
    });
    it("explains the black-hole tricks the moment they are asked of you", () => {
        const g = at("bazaar");
        const ids = lessons(collect(g, 1));
        expect(ids).toContain("goal:sling");
        expect(ids).toContain("goal:feed");
    });
    it("teaches each thing once only", () => {
        const g = new Game();
        collect(g, 1);
        const again = lessons(collect(g, 2));
        expect(again).not.toContain("fly");
        expect(new Set(g.campaign.taught).size).toBe(g.campaign.taught.length);
    });
    it("a goal waiting on another is explained when it opens", () => {
        const g = at("throne");
        expect(lessons(collect(g, 1))).not.toContain("goal:lure");
        const ev: GameEvent[] = [];
        for (const k of ["anchor1", "anchor2", "anchor3"]) { const b = g.region.bodies.find(x => x.key === k)!; b.radius = g.player.radius * 0.4; g.player.pos = [...b.pos]; g.step(DT); ev.push(...g.events); }
        ev.push(...collect(g, 1));
        expect(lessons(ev)).toContain("goal:lure");
    });
    it("every kind of goal, ability, blast and odd creature has a lesson and a how-to", () => {
        for (const t of new Set(REGIONS.flatMap(r => r.goals.map(x => x.type)))) { expect(LESSONS[`goal:${t}`], t).toBeDefined(); expect(GOAL_HOW[t], t).toBeTruthy(); }
        for (const a of Object.values(ABILITIES)) if (a.level > 1) expect(LESSONS[`ability:${a.id}`], a.id).toBeDefined();
        for (const b of BLAST_IDS) if (b !== "lance") expect(LESSONS[`blast:${b}`], b).toBeDefined();
        for (const s of Object.values(SPECIES)) if (s.trait) expect(LESSONS[`species:${s.id}`], s.id).toBeDefined();
    });
    it("names keys or buttons for whichever device you hold, and leaves no blanks", () => {
        expect(controlText("Hold {stride}", "keys")).toBe("Hold [SHIFT]");
        expect(controlText("Hold {stride}", "pad")).toBe("Hold [LT or L3]");
        expect(controlText("{name} yields", "pad", { name: "Vash" })).toBe("Vash yields");
        const texts = [...Object.values(LESSONS).map(l => l.text), ...Object.values(GOAL_HOW), ...REGIONS.flatMap(r => r.goals.map(x => x.how ?? ""))];
        for (const d of ["keys", "pad"] as const) for (const t of texts) expect(controlText(t, d, { name: "X" }), t).not.toMatch(/[{}]/);
        for (const b of Object.values(BINDINGS)) { expect(b.keys.length).toBeGreaterThan(0); expect(b.pad.length).toBeGreaterThan(0); }
    });
    it("levelling teaches the ability or blast it brings", () => {
        const g = new Game();
        g.campaign.mass = massOfRadius(radiusOfLevel(3)) * 1.01;
        g.player.radius = radiusOfLevel(3) * 1.003;
        const ids = lessons(collect(g, 0.6));
        expect(ids).toContain("blast:shard");
        expect(ids).toContain("ability:pulse");
        expect(ids).toContain("facets");
    });
});

describe("the gamepad's Lightstride", () => {
    it("starts from the trigger alone, with no stick held", () => {
        const g = new Game();
        alone(g);
        collect(g, 2, { ...NO_INPUT, surge: true });
        expect(g.player.stride).toBeGreaterThan(0.5);
        expect(len(g.player.vel)).toBeGreaterThan(g.player.radius * 2.6 * 3);
    });
    it("stops when you pull back", () => {
        const g = new Game();
        alone(g);
        collect(g, 1, { ...NO_INPUT, surge: true });
        collect(g, 1, { ...NO_INPUT, surge: true, thrust: -1 });
        expect(g.player.stride).toBe(0);
    });
});

describe("blasts", () => {
    it("the Lance is first; the others come with levels and are chosen", () => {
        const g = new Game();
        expect(g.blast).toBe("lance");
        expect(g.selectBlast("shard")).toBe(false);
        const h = at("marches");
        expect(h.blasts).toEqual(BLAST_IDS.filter(b => BLASTS[b].level <= h.player.level));
        expect(h.selectBlast("beam")).toBe(true);
        expect(h.blast).toBe("beam");
        h.step(DT, { ...NO_INPUT, blastNext: true });
        expect(h.blast).toBe("seeker");
        h.step(DT, { ...NO_INPUT, blastPick: "lance" });
        expect(h.blast).toBe("lance");
    });
    it("Shardfall throws seven shards that do not fly far", () => {
        const g = at("hearthring");
        alone(g);
        g.selectBlast("shard");
        g.step(DT, { ...NO_INPUT, fire: true });
        const shards = g.bolts.filter(b => b.kind === "shard");
        expect(shards).toHaveLength(7);
        collect(g, 1.2);
        expect(g.bolts.filter(b => b.kind === "shard")).toHaveLength(0);
    });
    it("the Sunthread burns what it touches while held, and drinks charge", () => {
        const g = at("marches");
        alone(g);
        const p = g.player;
        const foe = makeCreature(g.region, "pyre", add(p.pos, [0, 0, p.radius * 15]));
        foe.speed = 0; foe.sight = 0;
        g.selectBlast("beam");
        const charge = p.charge;
        collect(g, 0.6, { ...NO_INPUT, fire: true });
        expect(p.beam.on).toBe(true);
        expect(p.beam.target).toBe(foe.id);
        expect(foe.hp).toBeLessThan(foe.maxHp);
        expect(p.charge).toBeLessThan(charge - 10);
        g.step(DT);
        expect(p.beam.on).toBe(false);
    });
    it("Seekers find an enemy that is not in front of you", () => {
        const g = at("tollgate", 9);
        alone(g);
        const p = g.player;
        const foe = makeCreature(g.region, "marauder", add(p.pos, [p.radius * 20, 0, 0]));
        foe.speed = 0; foe.sight = 0;
        g.campaign.standing.drift = 0;
        foe.provoked = 99;
        g.selectBlast("seeker");
        g.step(DT, { ...NO_INPUT, fire: true });
        expect(g.bolts.filter(b => b.kind === "seeker")).toHaveLength(3);
        collect(g, 6);
        expect(foe.hp).toBeLessThan(foe.maxHp);
    });
});

describe("new creatures", () => {
    it("Glass Sentinels turn the Lance back, but not the Sunthread", () => {
        const g = at("marches");
        alone(g);
        const p = g.player;
        const glass = makeCreature(g.region, "prism", add(p.pos, [0, 0, p.radius * 12]));
        glass.speed = 0; glass.sight = 0;
        const ev = collect(g, 1.2, { ...NO_INPUT, fire: true });
        expect(ev.some(e => e.kind === "reflect")).toBe(true);
        expect(glass.hp).toBe(glass.maxHp);
        expect(g.campaign.taught).toContain("species:prism");
        g.selectBlast("beam");
        collect(g, 1, { ...NO_INPUT, fire: true });
        expect(glass.hp).toBeLessThan(glass.maxHp);
    });
    it("a Splitter breaks into two halves, which do not split again", () => {
        const g = at("hearthring");
        alone(g);
        const sp = makeCreature(g.region, "splitter", add(g.player.pos, [0, 0, g.player.radius * 10]));
        g.hurtCreature(sp, 1e6, g.player.radius, -1);
        const halves = g.region.creatures.filter(c => c.alive && c.species.id === "splitter");
        expect(halves).toHaveLength(2);
        expect(halves.every(c => c.gen === 1 && c.radius < sp.radius)).toBe(true);
        for (const h of halves) g.hurtCreature(h, 1e6, g.player.radius, -1);
        expect(g.region.creatures.filter(c => c.alive && c.species.id === "splitter")).toHaveLength(0);
    });
    it("a Lurker lies hidden and still until you come close, then strikes", () => {
        const g = at("tollgate");
        alone(g);
        const p = g.player;
        const lurk = makeCreature(g.region, "lurker", add(p.pos, [0, 0, p.radius * 30]));
        expect(lurk.hidden).toBe(true);
        collect(g, 1);
        expect(lurk.hidden).toBe(true);
        expect(g.aimTarget()).toBeNull();
        p.pos = add(lurk.pos, [0, 0, -p.radius * 5]);
        const ev = collect(g, 0.5);
        expect(ev.some(e => e.kind === "ambush")).toBe(true);
        expect(lurk.hidden).toBe(false);
        expect(lurk.state).toBe("hunt");
    });
    it("a Hollow Wraith folds space to land beside you", () => {
        const g = at("choir");
        alone(g);
        const p = g.player;
        const w = makeCreature(g.region, "wraith", add(p.pos, [0, 0, p.radius * 30]));
        w.state = "hunt"; w.target = -1; w.provoked = 99; w.blinkIn = 0;
        const ev = collect(g, 0.2);
        expect(ev.some(e => e.kind === "blink")).toBe(true);
        expect(dist(w.pos, p.pos)).toBeLessThan(p.radius * 6);
    });
    it("variants grow commoner deeper in, and are the same every visit", () => {
        expect(generateRegion(REGIONS[0]).creatures.filter(c => c.affix)).toHaveLength(0);
        const deep = REGIONS.slice(6).flatMap(def => generateRegion(def).creatures.filter(c => c.affix));
        expect(deep.length).toBeGreaterThan(3);
        expect(new Set(deep.map(c => c.affix)).size).toBeGreaterThanOrEqual(3);
        const again = REGIONS.slice(6).flatMap(def => generateRegion(def).creatures.filter(c => c.affix));
        expect(again.map(c => c.name)).toEqual(deep.map(c => c.name));
        for (const c of deep) expect(c.name.split(" ").length).toBeGreaterThan(1);
    });
    it("an Armoured one is harder to break; a Volatile one bursts", () => {
        const g = at("drowned");
        alone(g);
        const p = g.player;
        const plain = makeCreature(g.region, "thrall", add(p.pos, [p.radius * 40, 0, 0]));
        const armour = makeCreature(g.region, "thrall", add(p.pos, [-p.radius * 40, 0, 0]), { affix: "armored" });
        expect(armour.maxHp).toBeGreaterThan(plain.maxHp * 1.5);
        const bomb = makeCreature(g.region, "thrall", add(p.pos, [0, 0, p.radius * 2]), { affix: "volatile" });
        const before = p.cohesion;
        g.hurtCreature(bomb, 1e6, p.radius, -1);
        expect(g.events.some(e => e.kind === "burst")).toBe(true);
        expect(p.cohesion).toBeLessThan(before);
    });
});

describe("Grace and Ruin", () => {
    const beaten = () => {
        const g = at("tollgate");
        const vash = g.region.creatures.find(c => c.key === "vash")!;
        g.player.pos = add(vash.pos, [0, 0, -(vash.radius + g.player.radius * 4)]);
        g.hurtCreature(vash, 1e6, g.player.radius, -1);
        return { g, vash };
    };
    it("a beaten champion yields instead of dying, and waits on your mercy", () => {
        const { g, vash } = beaten();
        expect(vash.alive).toBe(true);
        expect(vash.yielding).toBe(true);
        expect(g.hostile(vash)).toBe(false);
        expect(g.events.some(e => e.kind === "yield")).toBe(true);
        expect(g.campaign.taught).toContain("yield");
    });
    it("sparing it is Grace, and wins the fight", () => {
        const { g, vash } = beaten();
        g.step(DT, { ...NO_INPUT, tribute: true });
        expect(vash.alive).toBe(false);
        expect(g.alignment).toBeGreaterThan(0);
        expect(g.campaign.stats.spared).toBe(1);
        g.step(DT);
        expect(g.goals.find(x => x.def.id === "vash")!.done).toBe(true);
    });
    it("devouring it is Ruin, and feeds you", () => {
        const { g, vash } = beaten();
        collect(g, 1);
        const mass = g.mass;
        g.hurtCreature(vash, 1, g.player.radius, -1);
        expect(vash.alive).toBe(false);
        expect(g.alignment).toBeLessThan(0);
        expect(g.mass).toBeGreaterThan(mass);
        expect(g.campaign.stats.devoured).toBe(1);
    });
    it("a bolt already in flight when it yields does not devour it", () => {
        const { g, vash } = beaten();
        g.hurtCreature(vash, 1, g.player.radius, -1);
        expect(vash.alive).toBe(true);
    });
    it("left alone, it slips away in time", () => {
        const { g, vash } = beaten();
        g.player.pos = add(vash.pos, [0, g.region.scale * 200, 0]);
        const ev = collect(g, YIELD_TIME + 1);
        expect(vash.alive).toBe(false);
        expect(ev.some(e => e.kind === "spared" && e.slipped)).toBe(true);
    });
    it("feeding on a living world is Ruin", () => {
        const g = at("hearthring");
        const aurel = g.region.bodies.find(b => b.key === "aurel")!;
        g.player.pos = add(aurel.pos, [0, 0, -(aurel.radius + g.player.radius * 1.5)]);
        collect(g, 0.3, { ...NO_INPUT, siphon: true });
        expect(g.alignment).toBeLessThanOrEqual(-15);
        expect(alignmentTier(-70)).toBe("Ruinous");
        expect(alignmentTier(70)).toBe("Radiant");
    });
    it("shows in your light", () => {
        const grace = nebulaPalette(10, "", 100), ruin = nebulaPalette(10, "", -100), none = nebulaPalette(10);
        const bright = (c: number[]) => c[0] + c[1] + c[2];
        expect(bright(grace.mid)).toBeGreaterThan(bright(none.mid));
        expect(bright(ruin.mid)).toBeLessThan(bright(none.mid));
        expect(bright(ruin.edge)).toBeLessThan(bright(grace.edge));
    });
    it("Grace knits cohesion faster", () => {
        const knit = (a: number) => { const g = at("tollgate"); alone(g); g.campaign.alignment = a; g.player.cohesion = 10; collect(g, 1); return g.player.cohesion; };
        expect(knit(100)).toBeGreaterThan(knit(0));
    });
});

describe("forms", () => {
    it("are chosen at level 7: the first is free, a change costs a tenth of you", () => {
        const young = new Game();
        expect(young.chooseForm("dark").ok).toBe(false);
        const g = at("tollgate", FORM_LEVEL);
        const mass = g.mass;
        expect(g.chooseForm("reflection").ok).toBe(true);
        expect(g.mass).toBe(mass);
        expect(g.chooseForm("reflection").ok).toBe(false);
        expect(g.chooseForm("dark").ok).toBe(true);
        expect(g.mass).toBeCloseTo(mass * 0.9, 6);
    });
    it("each changes how you play and how you look", () => {
        const g = at("tollgate", 9);
        const hp = g.maxCohesion, dmg = g.damageMul, pull = g.pullRange;
        g.chooseForm("reflection"); expect(g.maxCohesion).toBeGreaterThan(hp);
        g.chooseForm("emission"); expect(g.damageMul).toBeGreaterThan(dmg);
        g.chooseForm("planetary"); expect(g.pullRange).toBeGreaterThan(pull);
        const looks = (["emission", "reflection", "dark", "planetary"] as const).map(f => nebulaPalette(10, f).mid.join());
        expect(new Set(looks).size).toBe(4);
    });
    it("a Dark Nebula's Veil is cheap", () => {
        const veilCost = (form: "" | "dark") => { const g = at("tollgate", 9); alone(g); if (form) g.chooseForm(form); g.player.charge = 50; g.step(DT, { ...NO_INPUT, veil: true }); const c = g.player.charge; collect(g, 1); return c - g.player.charge; };
        expect(veilCost("dark")).toBeLessThan(veilCost(""));
    });
});

describe("saves", () => {
    it("a campaign saved before all this loads with sensible defaults", () => {
        const old = JSON.parse(JSON.stringify(newCampaign())) as Partial<Campaign>;
        delete old.blast; delete old.form; delete old.alignment; delete old.taught;
        const c = normalizeCampaign(old as Campaign);
        expect(c.blast).toBe("lance");
        expect(c.form).toBe("");
        expect(c.alignment).toBe(0);
        expect(c.taught).toEqual([]);
        expect(c.stats.spared).toBe(0);
        expect(new Game(c).region.def.id).toBe("cradle");
    });
});

describe("screens", () => {
    const fake = () => { const ops: { k: string; s?: string; x: number; y: number; w: number; h: number }[] = []; return { ops, p: new Painter({ clear: () => { ops.length = 0; }, rect: o => { ops.push(o); }, text: o => { ops.push(o); } }) }; };
    const texts = (ops: { k: string; s?: string }[]) => ops.filter(o => o.k === "t").map(o => o.s ?? "");
    const view = (over: Partial<HudView> = {}): HudView => ({
        w: 1280, h: 720, time: 1, region: "The Comet Bazaar", galaxy: "The Drift", government: "The Drift Collective", governmentColor: [1, 1, 1], standing: "Known", complete: false,
        goals: [{ text: "Slingshot around the Sump", done: false, progress: 0, total: 1, optional: false, locked: false, how: "Fly fast past the Sump and out the far side. Hold [LT or L3] for speed." }],
        messages: [], attune: false, veil: false, rank: "Shroud", level: 10, maxLevel: 37, progress: 0.3, radius: "1 km", compare: "x", cohesion: 1, charge: 1, fed: true, points: 0,
        abilities: [{ name: "Lance", key: "RT", ready: 1, locked: 0, active: false, affordable: true }], focus: null, markers: [], stride: 0, speed: "", warning: "", banner: null, toasts: [], hints: "",
        blasts: [{ name: "Lance", key: "", selected: true, locked: 0 }, { name: "Shardfall", key: "", selected: false, locked: 0 }, { name: "Sunthread", key: "", selected: false, locked: 0 }, { name: "Seekers", key: "", selected: false, locked: 8 }],
        blastKey: "LB / RB", grace: { value: 24, tier: "Gracious" }, form: "Dark Nebula",
        lesson: { title: "SLINGSHOT", text: "Dip fast into the ergosphere and fly out the far side.", age: 1, life: 12, more: 2, next: "HOLD BACK" }, ...over,
    });
    it("the HUD shows how to do each goal, the lesson, your blasts, form and Grace, all on screen", () => {
        const { ops, p } = fake();
        p.begin(); drawHud(p, view()); p.flush();
        const t = texts(ops);
        for (const s of ["FIELD GUIDE", "SLINGSHOT", "Shardfall", "LEVEL 8", "[LB / RB]", "DARK NEBULA", "GRACIOUS  +24"]) expect(t, s).toContain(s);
        expect(t.some(s => s.includes("Fly fast past the Sump"))).toBe(true);
        expect(t.some(s => s.includes("next tip (2 more)"))).toBe(true);
        for (const o of ops) { expect(o.x).toBeGreaterThanOrEqual(-1); expect(o.y).toBeGreaterThanOrEqual(-1); expect(o.x).toBeLessThanOrEqual(1281); expect(o.y).toBeLessThanOrEqual(721); }
    });
    it("the title lists keyboard and gamepad controls side by side", () => {
        const { ops, p } = fake();
        const controls = Object.values(BINDINGS).map(b => ({ what: b.what, keys: b.keys, pad: b.pad }));
        p.begin(); drawTitle(p, { w: 1280, h: 720, time: 1, canContinue: true, summary: "s", sound: true, device: "pad", controls }); p.flush();
        const t = texts(ops);
        for (const s of ["KEYBOARD & MOUSE", "GAMEPAD", "IN USE", "LT or L3", "SHIFT", "Lightstride (fly fast)", "RIGHT STICK"]) expect(t, s).toContain(s);
        expect(t.some(s => s.includes("[A]"))).toBe(true);
        for (const o of ops) { expect(o.x).toBeGreaterThanOrEqual(0); expect(o.x + (o.w || 0)).toBeLessThanOrEqual(1280); expect(o.y).toBeLessThanOrEqual(712); }
    });
    it("the Codex offers forms and blasts to choose, and shows the gamepad cursor", () => {
        const { ops, p } = fake();
        p.begin();
        drawCodex(p, {
            w: 1280, h: 720, points: 0, rank: "Shroud", level: 9, radius: "1 km", compare: "x", facets: [{ id: "density", name: "Density", text: "t", rank: 1, max: 5 }], abilities: [], factions: [], stats: [],
            forms: [{ id: "dark", name: "Dark Nebula", text: "t", perks: ["a"], color: [0.3, 0.2, 0.2], chosen: false }], formNote: "n",
            blasts: [{ id: "lance", name: "Lance", text: "t", level: 1, unlocked: true, selected: true, color: [1, 1, 1] }, { id: "beam", name: "Sunthread", text: "t", level: 5, unlocked: false, selected: false, color: [1, 1, 1] }],
            grace: { value: -30, tier: "Shadowed" }, cursor: "form:dark",
        });
        p.flush();
        expect(p.buttons.map(b => b.id)).toEqual(["form:dark", "blast:lance"]);
        expect(texts(ops)).toContain("SHADOWED  -30");
        expect(ops.some(o => o.k === "r" && (o as unknown as { sw?: number }).sw === 2)).toBe(true);
    });
});

void (null as unknown as V3);
