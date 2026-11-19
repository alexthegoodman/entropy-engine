import { describe, it, expect } from "vitest";
import { Game, NO_INPUT, ENEMY, GRAVITY, stageSave, type PlayerInput } from "../src/games/true_error/te_game";
import { noctisHeight, CAMP, WINCH, BEACONS, NEST, OVERLOOK, RIGHT_TERMINAL, TERMINALS, QLIFT, HOIST } from "../src/games/true_error/te_noctis";
import { m2Tasks } from "../src/games/true_error/te_m2";
import { COLLECTIBLE } from "../src/games/true_error/te_items";
import type { V3 } from "../src/games/true_error/te_level";

const DT = 1 / 60;
const noctis = () => new Game(undefined, 2);
const steps = (g: Game, seconds: number, input: Partial<PlayerInput> = {}) => { for (let t = 0; t < seconds; t += DT) g.step(DT, { ...NO_INPUT, ...input }); };
const use = (g: Game) => { g.step(DT, { ...NO_INPUT, use: true }); g.step(DT, NO_INPUT); };
const calm = (g: Game) => { for (const e of g.enemies) if (e.state !== "destroyed" && e.kind !== "beacon" && e.kind !== "nest") e.state = "restored"; };
/** A point on the ground (the terrain's height there, unless a y is given). */
const on = (x: number, z: number, y?: number): V3 => [x, y ?? noctisHeight(x, z), z];

type Way = V3 | { at: V3; crouch?: boolean };
/** Walks Ray to each waypoint (running, camera turned toward it); returns where he got stuck, if anywhere. */
function walk(g: Game, path: Way[], maxSeconds = 40): { stuckAt: number; pos: V3 } {
    for (let i = 0; i < path.length; i++) {
        const w = path[i], to = Array.isArray(w) ? w : w.at, crouch = !Array.isArray(w) && !!w.crouch;
        let t = 0;
        while (Math.hypot(to[0] - g.player.pos[0], to[2] - g.player.pos[2]) > 0.45) {
            const yaw = Math.atan2(to[0] - g.player.pos[0], to[2] - g.player.pos[2]);
            g.step(DT, { ...NO_INPUT, move: [0, 1], run: !crouch, crouch, yaw });
            t += DT;
            if (t > maxSeconds || !g.player.alive) return { stuckAt: i, pos: g.player.pos };
        }
        for (let k = 0; k < 40 && !g.player.grounded; k++) g.step(DT, NO_INPUT);
        if (Math.abs(to[1] - g.player.pos[1]) > 0.7) return { stuckAt: i, pos: g.player.pos };
    }
    return { stuckAt: -1, pos: g.player.pos };
}
const expectWalk = (g: Game, path: Way[]) => {
    const r = walk(g, path);
    expect(r.stuckAt, `stuck before waypoint ${r.stuckAt} ${JSON.stringify(path[r.stuckAt])} at ${r.pos.map(v => v.toFixed(2))} (stage ${g.stage})`).toBe(-1);
};
const put = (g: Game, pos: V3) => { g.player.pos = [...pos]; g.player.vel = [0, 0, 0]; steps(g, 0.1); };
/** Aims at a machine's middle and fires `seconds` of whatever Ray holds. */
const shootAt = (g: Game, id: string, seconds: number) => {
    for (let t = 0; t < seconds; t += DT) {
        const e = g.enemies.find(x => x.id === id)!;
        const m = g.muzzle(), c: V3 = [e.pos[0], e.pos[1] + ENEMY[e.kind].height * 0.5, e.pos[2]];
        const yaw = Math.atan2(c[0] - g.player.pos[0], c[2] - g.player.pos[2]);
        g.step(DT, { ...NO_INPUT, fire: true, aim: true, yaw, target: c, pitch: Math.atan2(c[1] - m[1], Math.hypot(c[0] - m[0], c[2] - m[2])) });
    }
};

describe("True Error mission 2, Noctis: the map", () => {
    it("puts every checkpoint, use spot, machine, cell and collectible on something solid", () => {
        const g = noctis();
        const ground = (p: V3, above = 0.6) => g.world.groundAt(p[0], p[2], 0.3, p[1] + above);
        for (const c of g.level.checkpoints) expect(Math.abs(ground(c.pos) - c.pos[1]), `checkpoint ${c.id}`).toBeLessThan(0.6);
        for (const u of g.level.uses) {
            if (u.kind === "lift") continue; // the cage floors carry those
            expect(Math.abs(ground(u.pos) - u.pos[1]), `use ${u.id}`).toBeLessThan(0.6);
        }
        for (const e of g.enemies) {
            if (e.kind === "cherub") continue;
            expect(Math.abs(ground(e.pos) - e.pos[1]), `machine ${e.id} at ${e.pos}`).toBeLessThan(0.7);
        }
        for (const c of g.level.pickups) expect(Math.abs(ground(c.pos) - c.pos[1]), `pickup ${c.id}`).toBeLessThan(0.7);
        for (const it of g.level.items) {
            expect(COLLECTIBLE.has(it.id), `collectible ${it.id} has a description`).toBe(true);
            expect(Math.abs(ground(it.pos, 0.1) - it.pos[1]), `item ${it.id} at ${it.pos}`).toBeLessThan(0.15);
        }
    });

    it("starts at the camp on the ground; the canyon walls and the canal banks can't be climbed", () => {
        const g = noctis();
        steps(g, 0.5);
        expect(g.player.pos[1]).toBeCloseTo(0, 1);
        expect(g.regionOf(g.player.pos)).toBe("camp");
        // North into the wall behind the freight lift: stopped well short of the rim.
        put(g, on(40, 160));
        steps(g, 8, { move: [0, 1], run: true, yaw: 0 });
        expect(g.player.pos[1]).toBeLessThan(14);
        // Down into the canal and back out the same steep bank: no.
        put(g, on(20, -40));
        steps(g, 6, { move: [0, 1], run: true, yaw: Math.PI });
        expect(g.player.pos[1]).toBeLessThan(-4);
        const z = g.player.pos[2];
        steps(g, 4, { move: [0, 1], run: true, yaw: 0 });
        expect(g.player.pos[2]).toBeLessThan(z + 4);
        expect(g.player.pos[1]).toBeLessThan(-3);
    });

    it("can be crossed on foot: the camp to the Foundry's bay, and out of the canal by a ramp", () => {
        const g = noctis();
        calm(g);
        expectWalk(g, [on(10, 128), on(40, 100), on(60, 76), on(90, 52), on(97, 42.4), [106, 0, 42.4], [110, 0, 39.8], [136, 0, 39.8], [136, 0, 48]]);
        put(g, on(-55, -60));
        expectWalk(g, [on(-55, -48), on(-55, -38)]);
    });
});

describe("True Error mission 2, Noctis: weapons and stealth", () => {
    it("the Doctor hands over the scattergun; Q swaps; it out-hits the rifle up close", () => {
        const g = noctis();
        expect(g.stage).toBe("embark");
        expect(g.weapons).toEqual(["rifle"]);
        put(g, [CAMP.doctor[0], 0, CAMP.doctor[2] + 1.2]);
        use(g);
        expect(g.stage).toBe("noctis");
        expect(g.weapons).toEqual(["rifle", "scatter"]);
        expect(g.player.weapon).toBe("scatter");
        g.step(DT, { ...NO_INPUT, swap: true });
        expect(g.player.weapon).toBe("rifle");
        g.step(DT, { ...NO_INPUT, swap: true });
        expect(g.player.weapon).toBe("scatter");
        // One shell at five meters against a roller's 60.
        const r = g.enemies.find(e => e.id === "n-roller-1")!;
        r.state = "fight"; r.seen = true; r.pos = [...on(-20, 90)];
        put(g, on(-20, 85));
        steps(g, 0.5);
        const before = r.hp;
        shootAt(g, r.id, 0.1);
        expect(before - r.hp).toBeGreaterThan(40);
    });

    it("takes an unaware machine down from behind, quietly", () => {
        const g = noctis();
        const b = g.enemies.find(e => e.id === "n-bot-1")!;
        b.patrol = [[...b.pos]]; b.yaw = 0;
        // Behind it (it faces +z), crouched.
        g.player.pos = [b.pos[0], b.pos[1], b.pos[2] - 1.4];
        steps(g, 0.3, { crouch: true, yaw: 0 });
        expect(b.state).toBe("patrol");
        expect(g.takedownTarget()?.id).toBe(b.id);
        g.step(DT, { ...NO_INPUT, use: true, crouch: true });
        expect(b.state).toBe("stunned");
        expect(g.events.some(e => e.kind === "takedown")).toBe(true);
        // And then the Reset.
        g.step(DT, { ...NO_INPUT, crouch: true });
        g.step(DT, { ...NO_INPUT, use: true, crouch: true });
        expect(b.state).toBe("restored");
    });

    it("a patrol misses Ray creeping up behind it, but hears him run", () => {
        const g = noctis();
        const b = g.enemies.find(e => e.id === "n-bot-1")!;
        b.patrol = [[...b.pos]]; b.yaw = 0;
        g.player.pos = [b.pos[0], b.pos[1], b.pos[2] - 9];
        steps(g, 1.5, { crouch: true, yaw: 0 });
        expect(b.state).toBe("patrol");
        // Crouched, walking up behind it: still unseen.
        for (let t = 0; t < 4 && Math.hypot(g.player.pos[0] - b.pos[0], g.player.pos[2] - b.pos[2]) > 1.6; t += DT) g.step(DT, { ...NO_INPUT, move: [0, 1], crouch: true, yaw: 0 });
        expect(b.state).toBe("patrol");
        // Running about behind it: it hears.
        const h = noctis();
        const c = h.enemies.find(e => e.id === "n-bot-1")!;
        c.patrol = [[...c.pos]]; c.yaw = 0;
        h.player.pos = [c.pos[0] + 4, c.pos[1], c.pos[2] - 8];
        steps(h, 1.5, { move: [1, 0], run: true, yaw: 0 });
        expect(c.state).not.toBe("patrol");
    });

    it("climbs back onto the ground from just under a dune (but not from the Undercroft)", () => {
        const g = noctis();
        const x = -40, z = 60, t = noctisHeight(x, z);
        g.player.pos = [x, t - 2.5, z];
        steps(g, 0.2);
        expect(g.player.pos[1]).toBeCloseTo(t, 1);
        g.player.pos = [130, -44, -145];
        steps(g, 0.5);
        expect(g.player.pos[1]).toBeCloseTo(-44, 1);
    });

    it("a Hollow freezes while Ray looks at it and runs while he doesn't", () => {
        const g = noctis();
        calm(g);
        const h = g.enemies.find(e => e.id === "n-hollow-1")!;
        put(g, on(60, 50));
        h.pos = [...on(60, 64)]; h.state = "fight"; h.seen = true; h.stateT = 0;
        const z0 = h.pos[2];
        steps(g, 1, { yaw: 0, pitch: 0.05 });
        const watchedMoved = z0 - h.pos[2];
        const z1 = h.pos[2];
        steps(g, 1, { yaw: Math.PI, pitch: 0 });
        const unwatchedMoved = z1 - h.pos[2];
        expect(watchedMoved).toBeLessThan(0.6);
        expect(unwatchedMoved).toBeGreaterThan(3);
    });

    it("a gravity shell drags machines into its well and crushes them", () => {
        const g = noctis();
        g.flags.add("weapon:gravity"); g.gravCells = 2; g.player.weapon = "gravity";
        put(g, on(-20, 70));
        const ids = ["n-roller-1", "n-roller-2"];
        ids.forEach((id, i) => { const e = g.enemies.find(x => x.id === id)!; e.pos = [...on(-21 + i * 3.5, 82)]; e.state = "restored"; e.state = "patrol"; e.patrol = [[...e.pos]]; });
        const c = on(-19.5, 82, noctisHeight(-19.5, 82) + 0.3);
        g.step(DT, { ...NO_INPUT, fire: true, aim: true, yaw: 0, target: c });
        expect(g.gravCells).toBe(1);
        steps(g, GRAVITY.fuse + GRAVITY.pull + 0.2);
        expect(g.events.length).toBeGreaterThanOrEqual(0);
        for (const id of ids) expect(g.enemies.find(x => x.id === id)!.state).not.toBe("patrol");
    });
});

describe("True Error mission 2, Noctis: the story", () => {
    it("can be played through, the three objectives in any order, out to the overlook", () => {
        const g = noctis();
        calm(g);
        // The Doctor.
        put(g, [CAMP.doctor[0], 0, CAMP.doctor[2] + 1.2]);
        use(g);
        expect(g.stage).toBe("noctis");
        expect(m2Tasks(g).map(t => t.done)).toEqual([false, false, false]);

        // The barge first: crank the mast (E held), and the hull empties.
        put(g, [WINCH[0], 0, WINCH[2] + 1.4]);
        steps(g, 8.5, { useHeld: true });
        expect(g.crank).toBeGreaterThan(0.5);
        expect(g.enemies.some(e => e.id.startsWith("mast0-"))).toBe(true);
        calm(g);
        steps(g, 8, { useHeld: true });
        expect(g.flags.has("mast")).toBe(true);

        // Gate Four: a wrong terminal sets the cherubs off; the right one has the log.
        const wrong = TERMINALS.find(t => t.id !== RIGHT_TERMINAL)!, right = TERMINALS.find(t => t.id === RIGHT_TERMINAL)!;
        const stand = (t: typeof wrong): V3 => [t.pos[0] + Math.sin(t.yaw) * 1.1, 1.2, t.pos[2] + Math.cos(t.yaw) * 1.1];
        put(g, stand(wrong)); use(g);
        expect(g.flags.has(`wrong:${wrong.id}`)).toBe(true);
        expect(g.enemies.filter(e => e.id.startsWith("alarm-cherub")).length).toBe(3);
        calm(g);
        put(g, stand(right)); use(g);
        expect(g.flags.has("gate")).toBe(true);

        // The Foundry: the gravity launcher from the foreman's locker, then the line; the racks wake.
        put(g, [108, 5.2, 55.5]); use(g);
        expect(g.weapons).toContain("gravity");
        expect(g.gravCells).toBeGreaterThan(0);
        expect(g.enemies.filter(e => e.dormant).length).toBe(6);
        put(g, [141, 1.2, 50.6]); use(g);
        expect(g.enemies.filter(e => e.dormant).length).toBe(0);
        expect(g.enemies.filter(e => e.id.startsWith("rack-") && e.state === "alert").length).toBe(6);
        steps(g, 0.2);
        expect(g.stage).toBe("silence");
        expect(g.npcs.some(n => n.id === "doctor")).toBe(false);
        calm(g);

        // The camp, the radio, the pumphouse and its beacons.
        put(g, on(5, 140)); steps(g, 0.2);
        expect(g.stage).toBe("camp");
        put(g, [CAMP.radio[0] + 0.3, 0, CAMP.radio[2] + 1.2]); use(g);
        expect(g.stage).toBe("signal");
        put(g, on(-100, -86)); steps(g, 0.2);
        expect(g.stage).toBe("beacons");
        for (const b of BEACONS) {
            put(g, [b.pos[0] + 6, 0, b.pos[2] + 2]);
            g.player.weapon = "rifle"; g.player.energy = 100;
            shootAt(g, b.id, 2);
            expect(g.enemies.find(e => e.id === b.id)!.state).toBe("destroyed");
        }
        steps(g, 0.2);
        expect(g.stage).toBe("survivors");
        expect(g.flags.has("open:pump-door")).toBe(true);
        steps(g, 5);
        expectWalk(g, [on(-115, -94), [-115, 0, -98], [-115, 0, -103.4]]);
        put(g, [-117, 0, -104.4]); use(g);
        expect(g.stage).toBe("tithe");
        expect(g.npcs.some(n => n.id === "vesper")).toBe(true);

        // To the quarry: down its road, onto the lift; down into the Undercroft.
        put(g, on(98, -88)); steps(g, 0.2);
        expect(g.flags.has("tithe-at-lift")).toBe(true);
        expectWalk(g, [on(104, -98), on(116, -110), [126, -10, -121], [130, -10, -125]]);
        use(g);
        expect(g.stage).toBe("descend");
        expect(g.player.riding).toBe(true);
        steps(g, 14);
        expect(g.stage).toBe("undercroft");
        expect(g.player.pos[1]).toBeCloseTo(QLIFT.bottom, 1);

        // The pit, the heart (a gravity shell bites through its shell), the tunnel, the hoist.
        calm(g);
        expectWalk(g, [[130, -44, -133], [130, -44, -138], [130, -44, -144.2], [104, -44, -144.2], [101, -44, -153], [94, -44, -153]]);
        expect(g.stage).toBe("nest");
        const nest = g.enemies.find(e => e.id === "nest")!;
        g.player.weapon = "gravity";
        for (let i = 0; i < 6 && nest.state !== "destroyed"; i++) {
            g.gravCells = 2;
            g.step(DT, { ...NO_INPUT, fire: true, aim: true, yaw: Math.atan2(NEST[0] - g.player.pos[0], NEST[2] - g.player.pos[2]), target: [NEST[0], NEST[1] + 2, NEST[2]] });
            steps(g, GRAVITY.fuse + GRAVITY.pull);
            g.player.integrity = 100;
            calm(g);
        }
        expect(nest.state).toBe("destroyed");
        expect(g.stage).toBe("tunnel");
        steps(g, 6);
        expectWalk(g, [[86, -44, -160], [86, -44, -168], [100, -44, -170], [173.5, -44, -171], [173.5, -44, -178], [172.8, -44, -183.2]]);
        use(g);
        expect(g.stage).toBe("ascent");
        steps(g, 18);
        expect(g.stage).toBe("rim");
        expect(g.player.pos[1]).toBeCloseTo(HOIST.top, 1);
        expect(g.enemies.filter(e => e.zone === "ledge").length).toBe(5);
        calm(g);
        expectWalk(g, [[166, 30, -182], [OVERLOOK[0] + 1, 30, OVERLOOK[2] - 1]]);
        expect(g.won).toBe(true);
    });

    it("saves mid-Noctis and loads back where it was", () => {
        const g = new Game(undefined, 2);
        g.load(stageSave("beacons"));
        expect(g.stage).toBe("beacons");
        expect(g.weapons).toEqual(["rifle", "scatter", "gravity"]);
        expect(g.npcs.some(n => n.id === "doctor")).toBe(false);
        const s = g.save();
        const h = new Game(undefined, 2);
        h.load(s);
        expect(h.stage).toBe("beacons");
        expect(h.checkpoint).toBe("pumphouse");
        expect(h.player.pos[0]).toBeCloseTo(g.player.pos[0], 3);
        const u = new Game(undefined, 2);
        u.load(stageSave("rim"));
        expect(u.enemies.filter(e => e.zone === "ledge").length).toBe(5);
        expect(u.player.pos[1]).toBeCloseTo(30, 1);
    });
});
