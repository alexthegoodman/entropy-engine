// The Abyss, Chapter Two: Retaliation - headless. The quest engine on its own, Kesh's flight, and
// the whole chapter played through the Game the addon drives: the main quest from the firebase to
// the landing on the rim, every side quest (both ends of the idol's), the patrols, trade, and a
// save restored mid-chapter.

import { describe, it, expect, beforeAll } from "vitest";
import { HeightGrid, FLOOR_Y, MAP_HALF } from "../src/games/abyss/ab_world";
import { Game, GameWorld, NO_INPUT, type GameInput } from "../src/games/abyss/ab_game";
import { QuestBook, type QuestDef, type QuestContext } from "../src/games/abyss/ab_quests";
import { newCreature, stepRidden, stepCreature, takeOff, NO_FLIGHT, STALL } from "../src/games/abyss/ab_creature";
import { PLACES2, DOG_TAGS, QUESTS, PATROLS } from "../src/games/abyss/ab_script2";
import { alive, kill } from "../src/games/abyss/ab_combat";
import { lookupObject } from "../src/apps/mesha/library";
import { evaluateObject, validateDefinition } from "../src/apps/mesha/mesha_object";
import { skywingShoulder } from "../src/apps/mesha/library/skywing";

const DT = 1 / 30;
let grid: HeightGrid;

beforeAll(() => {
    grid = new HeightGrid();
    grid.bake();
}, 300_000);

function newGame(): Game {
    return new Game(new GameWorld(grid));
}

function step(g: Game, frames = 1, input: Partial<GameInput> = {}): void {
    for (let i = 0; i < frames; i++) g.step(DT, { ...NO_INPUT, ...input });
}

/** Plays out (skips) whatever cutscene is on. */
function skipScene(g: Game): void {
    let guard = 0;
    while (g.cinema && guard++ < 5) step(g, 1, { skip: true });
    expect(g.cinema).toBeNull();
}

function goTo(g: Game, x: number, z: number): void {
    g.teleportTo(x, z, g.body.yaw);
    step(g, 1);
}

function interact(g: Game): void { step(g, 1, { interact: true }); }

function talkTo(g: Game, npc: string): void {
    const a = g.ch2!.npc(npc)!;
    expect(a, npc).toBeTruthy();
    g.teleportTo(a.x + 1.5, a.z, Math.atan2(-1.5, 0));
    step(g, 1);
    interact(g);
    step(g, 2);
}

const quest = (g: Game, id: string) => g.ch2!.summary().quests[id];

describe("the quest book", () => {
    const defs: QuestDef[] = [
        {
            id: "q", title: "Q", kind: "side", giver: "a", offeredAt: null, summary: "", reward: { credits: 10, text: "" },
            stages: [
                { id: "s1", text: "go", marker: [0, 0], trigger: { kind: "reach", at: [100, 0], radius: 5 } },
                { id: "s2", text: "kill", marker: null, trigger: { kind: "kill", tag: "x", count: 2 }, enter: ["spawn"] },
                { id: "s3", text: "pick", marker: null, trigger: { kind: "choice", id: "c" }, done: ["after"] },
            ],
        },
        { id: "later", title: "L", kind: "side", giver: null, offeredAt: null, summary: "", requires: ["quest:q"], reward: { text: "" }, stages: [{ id: "a", text: "", marker: null, trigger: { kind: "flag", flag: "f" } }] },
    ];
    const ctx = (over: Partial<QuestContext> = {}): QuestContext => ({ pos: [0, 0, 0], flying: false, ground: 0, talked: null, interacted: null, chose: null, counters: {}, flags: {}, ...over });

    it("offers, starts, and walks stages on their triggers; kills count from the stage's start", () => {
        const b = new QuestBook(defs);
        expect(b.unlock({}).map(e => e.kind)).toEqual(["offered"]);
        expect(b.status("later")).toBe("locked");
        b.start("q", { counters: {} });
        expect(b.stage("q")!.id).toBe("s1");
        expect(b.step(ctx({ pos: [50, 0, 0] })).filter(e => e.kind === "stage")).toEqual([]);
        const evs = b.step(ctx({ pos: [101, 0, 0], counters: { "kill:x": 5 } }));
        expect(evs.some(e => e.kind === "action" && e.name === "spawn")).toBe(true);
        expect(b.stage("q")!.id).toBe("s2");
        // Five kills before the stage began don't count.
        b.step(ctx({ counters: { "kill:x": 6 } }));
        expect(b.progress("q", { "kill:x": 6 })).toEqual([1, 2]);
        b.step(ctx({ counters: { "kill:x": 7 } }));
        expect(b.stage("q")!.id).toBe("s3");
        const done = b.step(ctx({ chose: { id: "c", option: 1 } }));
        expect(done.map(e => e.kind)).toEqual(["action", "completed", "offered"]);
        expect(b.state("q").outcome).toBe("c:1");
        expect(b.status("later")).toBe("available");
        const saved = JSON.parse(JSON.stringify(b.save()));
        const c = new QuestBook(defs);
        c.load(saved);
        expect(c.status("q")).toBe("done");
        expect(c.status("later")).toBe("available");
    });

    it("tracks the main quest first and cycles through the active ones", () => {
        const b = new QuestBook(QUESTS);
        b.unlock({});
        b.start("tags", { counters: {} });
        expect(b.tracked).toBe("tags");
        b.start("beast", { counters: {} });
        expect(b.tracked).toBe("beast");
        expect(b.focus()!.quest.id).toBe("beast");
        expect(b.cycleTracked()).toBe("tags");
    });
});

describe("Kesh, the skywing", () => {
    it("is a ready Mesha object whose wings split off at the shoulders", () => {
        const def = lookupObject("creature.skywing")!;
        expect(validateDefinition(def, lookupObject)).toEqual([]);
        for (const values of [{}, { wounded: true }, { saddle: true }]) {
            const e = evaluateObject(def, values, lookupObject);
            const regions = new Set(e.mesh.parts.map(p => p.region));
            for (const r of ["hide", "wingL", "wingR", "wingBoneL", "wingBoneR", "glow", "eye"]) expect(regions.has(r), r).toBe(true);
            expect(e.stats.triangles).toBeLessThan(16000);
            // The left wing is all on +X, the right all on -X, beyond the shoulder.
            const [sx] = skywingShoulder(9);
            for (const p of e.mesh.parts) {
                if (p.region !== "wingL" && p.region !== "wingR") continue;
                for (let i = 0; i < p.positions.length; i += 3) expect(p.positions[i] * (p.region === "wingL" ? 1 : -1)).toBeGreaterThan(sx * 0.5);
            }
        }
    });

    it("flies: climbs, dives faster, beats its wings, never goes into the ground, sets down when asked", () => {
        const world = { ground: (x: number, z: number) => grid.height(x, z), half: MAP_HALF };
        const [x, z] = PLACES2.hollow;
        const k = newCreature(x, z, world.ground(x, z));
        k.mode = "rest"; k.healed = true;
        expect(stepRidden(k, { ...NO_FLIGHT, throttle: 1 }, DT, world)).toBe(false);
        expect(k.grounded).toBe(false);
        // Climb out: nose up, wingbeats.
        for (let i = 0; i < 30 * 8; i++) stepRidden(k, { ...NO_FLIGHT, throttle: 1, turnPitch: i < 10 ? 0.04 : 0, flap: true }, DT, world);
        expect(k.y - world.ground(k.x, k.z)).toBeGreaterThan(40);
        expect(k.stamina).toBeLessThan(1);
        // Dive: speed builds past cruise.
        k.pitch = -0.7;
        let maxSpeed = 0, minClear = Infinity;
        for (let i = 0; i < 30 * 8; i++) {
            stepRidden(k, { ...NO_FLIGHT, throttle: 1 }, DT, world);
            maxSpeed = Math.max(maxSpeed, k.speed);
            minClear = Math.min(minClear, k.y - world.ground(k.x, k.z));
        }
        expect(maxSpeed).toBeGreaterThan(40);
        expect(minClear).toBeGreaterThan(-0.01);
        // Level off low and slow, and set down.
        k.pitch = 0; k.speed = STALL + 2; k.y = world.ground(k.x, k.z) + 6;
        let landed = false;
        for (let i = 0; i < 30 * 10 && !landed; i++) landed = stepRidden(k, { ...NO_FLIGHT, land: true }, DT, world);
        expect(landed).toBe(true);
        expect(k.grounded).toBe(true);
    });

    it("comes when called: flies to the goal and lands there", () => {
        const world = { ground: (x: number, z: number) => grid.height(x, z), half: MAP_HALF };
        const [x, z] = PLACES2.hollow;
        const k = newCreature(x, z, world.ground(x, z));
        k.mode = "fly"; k.healed = true;
        const [gx, gz] = PLACES2.firebase;
        k.goal = [gx, world.ground(gx, gz), gz];
        takeOff(k);
        let t = 0;
        while (k.mode === "fly" && t < 120) { stepCreature(k, DT, world); t += DT; }
        expect(k.mode).toBe("rest");
        expect(Math.hypot(k.x - gx, k.z - gz)).toBeLessThan(4);
        expect(t).toBeLessThan(90);
    });
});

describe("Chapter One, unchanged", () => {
    it("still opens, lands on Ledge Kilo with its squad, and knows nothing of Chapter Two", () => {
        const g = newGame();
        g.start("intro");
        expect(g.chapter).toBe(1);
        expect(g.cinema?.scene.id).toBe("opening");
        skipScene(g);
        expect(g.phase).toBe("ledge");
        expect(g.squad().length).toBe(8);
        expect(g.currentObjective()!.text).toBe("Rally on Sgt. Okafor");
        step(g, 30, { moveY: 1 });
        expect(g.ch2).toBeNull();
    });
});

describe("Chapter Two, played through", () => {
    it("opens on the firebase and plays the main quest from Voss to the landing on the rim", () => {
        const g = newGame();
        g.start("open");
        expect(g.chapter).toBe(2);
        expect(g.phase).toBe("aftermath");
        expect(g.cinema?.scene.id).toBe("aftermath");
        skipScene(g);
        expect(g.phase).toBe("open");
        expect(g.currentObjective()!.text).toBe("Report to Major Voss");
        // Side quests are offered from the start: the main quest is not a gate.
        expect(g.ch2!.givers().map(x => x.id).sort()).toEqual(["brask", "dace", "maelis"]);

        talkTo(g, "voss");
        expect(quest(g, "beast").stage).toBe("recorder");
        const rec = g.pickups.find(p => p.item === "recorder")!;
        goTo(g, rec.x + 1, rec.z);
        interact(g);
        step(g, 2);
        expect(quest(g, "beast").stage).toBe("trail");
        expect(g.ch2!.trail().length).toBeGreaterThan(5);

        goTo(g, PLACES2.hollow[0], PLACES2.hollow[1] - 30);
        step(g, 2);
        expect(g.cinema?.scene.id).toBe("hollow");
        skipScene(g);
        expect(quest(g, "beast").stage).toBe("defend");
        const hunters = g.combat.actors.filter(a => a.tag === "hunters");
        expect(hunters.length).toBe(4);
        for (const h of hunters) kill(g.combat, h, "player");
        step(g, 2);
        expect(quest(g, "beast").stage).toBe("calm");

        // Calming: rushing in (sprinting) makes it flinch; slow reaches out three times calm it.
        const k = g.ch2!.kesh;
        expect(k.mode).toBe("wounded");
        g.teleportTo(k.x + 5, k.z, Math.atan2(-5, 0));
        step(g, 1);
        g.body.speed = 7;
        g.ch2!.interact("creature-calm");
        expect(k.trust).toBe(0);
        for (let i = 0; i < 3; i++) { step(g, 1); interact(g); }
        step(g, 2);
        expect(g.flags.calmed).toBe(true);
        expect(quest(g, "beast").stage).toBe("water");

        // The Source's pool, far east.
        goTo(g, PLACES2.sourceFill[0] + 3, PLACES2.sourceFill[1]);
        interact(g);
        step(g, 2);
        expect(g.flags.riverWater).toBe(true);
        expect(quest(g, "beast").stage).toBe("heal");

        g.teleportTo(k.x + 5, k.z, Math.atan2(-5, 0));
        step(g, 1);
        interact(g);
        step(g, 1);
        expect(g.cinema?.scene.id).toBe("skybound");
        skipScene(g);
        expect(k.healed).toBe(true);
        expect(quest(g, "beast").stage).toBe("mount");

        g.teleportTo(k.x + 4, k.z, Math.atan2(-4, 0));
        step(g, 1);
        interact(g);
        step(g, 2);
        expect(g.ch2!.mounted).toBe(true);
        expect(quest(g, "beast").stage).toBe("rim");

        // Fly: up out of the crack, then to the forward base, and set down there.
        let t = 0;
        const [bx, bz] = PLACES2.fob;
        while (quest(g, "beast").stage !== "fob" && t < 120) {
            k.yaw = Math.atan2(bx - k.x, bz - k.z);
            k.pitch = Math.min(k.pitch, 0.5);
            step(g, 1, { moveY: 1, jumpHeld: true, mouseY: k.pitch < 0.5 ? -4 : 0 });
            t += DT;
        }
        expect(quest(g, "beast").stage).toBe("fob");
        expect(g.body.y).toBeGreaterThan(25);
        while (Math.hypot(k.x - bx, k.z - bz) > 60 && t < 300) {
            k.yaw = Math.atan2(bx - k.x, bz - k.z);
            k.pitch = Math.max(-0.2, Math.min(0.2, (g.world.ground(k.x, k.z) + 30 - k.y) * 0.02));
            step(g, 1, { moveY: 1 });
            t += DT;
        }
        // Come in low and slow, set down.
        let guard = 0;
        while (!k.grounded && guard++ < 30 * 30) {
            k.speed = Math.min(k.speed, 12);
            k.pitch = -0.25;
            step(g, 1, { interact: guard % 10 === 0, moveY: -1 });
        }
        expect(k.grounded).toBe(true);
        step(g, 3);
        expect(g.cinema?.scene.id).toBe("firstlight");
        skipScene(g);
        expect(quest(g, "beast").status).toBe("done");
        expect(g.flags.chapterDone).toBe(true);
        // The world stays open: Alex climbs down and can whistle Kesh to him anywhere.
        interact(g);
        step(g, 1);
        expect(g.ch2!.mounted).toBe(false);
        g.teleportTo(PLACES2.fob[0] + 200, PLACES2.fob[1], 0);
        step(g, 1, { call: true });
        expect(k.mode).toBe("fly");
        let tt = 0;
        while (k.mode === "fly" && tt < 60) { step(g, 1); tt += DT; }
        expect(k.mode).toBe("rest");
        expect(Math.hypot(k.x - g.body.x, k.z - g.body.z)).toBeLessThan(12);
    }, 120_000);

    it("plays every side quest in any order, without the main quest", () => {
        const g = newGame();
        g.start("open");
        skipScene(g);
        const credits0 = g.inv.credits;

        // Names in the Dust: six tags where Kilo-Two fell, hung at the memorial.
        talkTo(g, "brask");
        expect(quest(g, "tags").status).toBe("active");
        expect(g.pickups.filter(p => p.item === "dogtag").length).toBe(6);
        for (const t of DOG_TAGS) { goTo(g, t.at[0] + 0.5, t.at[1]); interact(g); }
        step(g, 2);
        expect(g.ch2!.counters.dogtag).toBe(6);
        expect(quest(g, "tags").stage).toBe("memorial");
        goTo(g, PLACES2.memorial[0] + 1, PLACES2.memorial[1]);
        interact(g);
        step(g, 2);
        expect(quest(g, "tags").status).toBe("done");
        expect(g.inv.weapons).toContain("okafor-carbine");

        // Seven Is Down: the wreck, Pell, the wardens who come at night, home.
        talkTo(g, "dace");
        expect(quest(g, "seven").status).toBe("active");
        goTo(g, PLACES2.wreck7[0] + 4, PLACES2.wreck7[1] + 4);
        step(g, 2);
        expect(g.ch2!.npc("pell")).toBeTruthy();
        talkTo(g, "pell");
        expect(quest(g, "seven").stage).toBe("defend");
        const wave = g.combat.actors.filter(a => a.tag === "seven");
        expect(wave.length).toBe(4);
        for (const w of wave) kill(g.combat, w, "player");
        step(g, 2);
        talkTo(g, "pell");
        expect(quest(g, "seven").stage).toBe("home");
        expect(Math.hypot(g.ch2!.npc("pell")!.x - PLACES2.pellHome[0], g.ch2!.npc("pell")!.z - PLACES2.pellHome[1])).toBeLessThan(1);
        talkTo(g, "pell");
        expect(quest(g, "seven").status).toBe("done");
        expect(g.inv.armorMax).toBe(150);

        // Salvage Rights (Dace's second offer), then trade the rest.
        talkTo(g, "dace");
        expect(quest(g, "shards").status).toBe("active");
        for (const p of g.pickups.filter(p => p.item === "lumen-shard" && !p.taken).slice(0, 5)) { goTo(g, p.x + 0.5, p.z); interact(g); }
        step(g, 2);
        expect(quest(g, "shards").stage).toBe("deliver");
        talkTo(g, "dace");
        expect(quest(g, "shards").status).toBe("done");
        expect(g.inv.artifacts.filter(a => a === "lumen-shard").length).toBe(0);
        // Dace with nothing to offer opens the trade.
        g.ch2!.wantTrade = false;
        talkTo(g, "dace");
        expect(g.ch2!.wantTrade).toBe(true);
        g.inv.artifacts.push("bronze-cup", "warden-mask");
        const sold = g.ch2!.sellAll();
        expect(sold).toBe(220 + 650);
        expect(g.ch2!.buy("medgel")).toBe(true);
        expect(g.ch2!.buy("saddle")).toBe(false);
        expect(g.inv.credits).toBeGreaterThan(credits0);

        // The relay needs wings: not offered yet.
        expect(quest(g, "relay").status).toBe("locked");
        expect(quest(g, "beast").stage).toBe("report");
    }, 120_000);

    it("the river idol ends two ways: returned (river water, her word for the creature) or sold", () => {
        for (const give of [true, false]) {
            const g = newGame();
            g.start("open");
            skipScene(g);
            talkTo(g, "maelis");
            expect(quest(g, "idol").stage).toBe("crate");
            goTo(g, PLACES2.crate[0] + 1, PLACES2.crate[1]);
            interact(g);
            step(g, 2);
            expect(quest(g, "idol").stage).toBe("decide");
            expect(g.inv.artifacts).toContain("river-idol");
            // Selling everything else at Dace's does not sell the idol.
            g.ch2!.sellAll();
            expect(g.inv.artifacts).toContain("river-idol");
            talkTo(g, give ? "maelis" : "dace");
            expect(g.ch2!.choice).toBeTruthy();
            step(g, 1, { choice: 1 });
            step(g, 2);
            expect(quest(g, "idol").status).toBe("done");
            expect(g.inv.artifacts).not.toContain("river-idol");
            if (give) {
                expect(g.flags.riverWater).toBe(true);
                expect(g.ch2!.npc("maelis")).toBeTruthy();
            } else {
                expect(g.inv.credits).toBeGreaterThanOrEqual(900);
                expect(g.ch2!.npc("maelis")).toBeUndefined();
            }
        }
    }, 120_000);

    it("Last Transmission opens once Kesh can fly, and its core lies where only wings reach", () => {
        const g = newGame();
        g.start("skybound");
        expect(quest(g, "beast").stage).toBe("mount");
        expect(quest(g, "relay").status).toBe("locked");
        const k = g.ch2!.kesh;
        g.teleportTo(k.x + 4, k.z, 0);
        step(g, 1);
        interact(g);
        step(g, 2);
        k.y = 60; k.grounded = false; k.speed = 20;
        step(g, 2);
        expect(quest(g, "beast").stage).toBe("fob");
        expect(quest(g, "relay").status).toBe("available");
        g.ch2!.dismount();
        // BRASK-7 offers one job at a time: the tags first, then the relay.
        talkTo(g, "brask");
        expect(quest(g, "tags").status).toBe("active");
        talkTo(g, "brask");
        expect(quest(g, "relay").status).toBe("active");
        const core = g.pickups.find(p => p.item === "relay")!;
        expect(core.y).toBeGreaterThan(FLOOR_Y + 250);
        g.teleportTo(core.x + 0.5, core.z, 0);
        step(g, 1);
        interact(g);
        step(g, 2);
        talkTo(g, "brask");
        expect(quest(g, "relay").status).toBe("done");
        expect(g.flags.scanBoost).toBe(true);
    }, 120_000);

    it("roaming wardens patrol the wild floor, never the firebase, and fight", () => {
        const g = newGame();
        g.start("roam");
        expect(g.flags.chapterDone).toBe(true);
        step(g, 5);
        expect(g.combat.actors.filter(a => a.tag === "patrol").length).toBe(0);
        const z = PATROLS.find(p => p.id === "westhollow")!;
        goTo(g, z.at[0] - 120, z.at[1]);
        step(g, 2);
        const patrol = g.combat.actors.filter(a => a.tag === "patrol" && alive(a));
        expect(patrol.length).toBe(z.n);
        // Far away again: they go home.
        goTo(g, PLACES2.firebase[0], PLACES2.firebase[1]);
        step(g, 2);
        expect(g.combat.actors.filter(a => a.tag === "patrol" && alive(a)).length).toBe(0);
    }, 120_000);

    it("saves and restores mid-chapter", () => {
        const g = newGame();
        g.start("open");
        skipScene(g);
        talkTo(g, "voss");
        talkTo(g, "brask");
        const t = DOG_TAGS[0];
        goTo(g, t.at[0] + 0.5, t.at[1]);
        interact(g);
        step(g, 2);
        g.inv.credits = 777;
        const save = JSON.parse(JSON.stringify(g.ch2!.save()));

        const h = newGame();
        h.start("open");
        skipScene(h);
        h.ch2!.load(save);
        step(h, 2);
        expect(quest(h, "beast").stage).toBe("recorder");
        expect(quest(h, "tags").stage).toBe("collect");
        expect(h.ch2!.counters.dogtag).toBe(1);
        expect(h.inv.credits).toBe(777);
        // The taken tag is not laid out again; the other five are.
        expect(h.pickups.filter(p => p.item === "dogtag" && !p.taken).length).toBe(5);
        expect(h.pickups.filter(p => p.item === "recorder").length).toBe(1);
    }, 120_000);

    it("dies and wakes at the firebase", () => {
        const g = newGame();
        g.start("roam");
        goTo(g, 600, -150);
        g.hurt(999, [600, -540, -150]);
        expect(g.alive).toBe(false);
        step(g, 30 * 4);
        expect(g.alive).toBe(true);
        expect(Math.hypot(g.body.x - PLACES2.spawn[0], g.body.z - PLACES2.spawn[1])).toBeLessThan(2);
    }, 60_000);
});
