import { describe, it, expect } from "vitest";
import { Game, NO_INPUT, STUN_TIME, PLAYER, ENEMY, type PlayerInput } from "../src/games/true_error/te_game";
import { DARK_ZONE, PEDESTAL, LIFT, type V3 } from "../src/games/true_error/te_level";
import { RELAY_DARK, HOLD_SECONDS } from "../src/games/true_error/te_acts";
import { COLLECTIBLES, COLLECTIBLE } from "../src/games/true_error/te_items";

const DT = 1 / 60;

/** A waypoint, and how to get there: jump at the start of the leg, crouch along it, wait first. */
type Way = V3 | { at: V3; jump?: boolean; crouch?: boolean; walk?: boolean; wait?: number };
const at = (w: Way): V3 => (Array.isArray(w) ? w : w.at);

/** Walks Ray to each waypoint in turn (camera turned toward it); returns where he got stuck, if anywhere. */
function walk(g: Game, path: Way[], maxSeconds = 25): { stuckAt: number; pos: V3 } {
    for (let i = 0; i < path.length; i++) {
        const w = path[i], o = Array.isArray(w) ? {} : w, to = at(w);
        for (let t = 0; t < (o.wait ?? 0); t += DT) g.step(DT, NO_INPUT);
        let t = 0, first = true;
        while (Math.hypot(to[0] - g.player.pos[0], to[2] - g.player.pos[2]) > 0.4) {
            const yaw = Math.atan2(to[0] - g.player.pos[0], to[2] - g.player.pos[2]);
            const input: PlayerInput = { ...NO_INPUT, move: [0, 1], run: !o.crouch && !o.walk, crouch: !!o.crouch, jump: !!o.jump && first, yaw };
            first = false;
            g.step(DT, input);
            t += DT;
            if (t > maxSeconds || !g.player.alive) return { stuckAt: i, pos: g.player.pos };
        }
        // Land before judging the height.
        for (let k = 0; k < 40 && !g.player.grounded; k++) g.step(DT, NO_INPUT);
        if (Math.abs(to[1] - g.player.pos[1]) > 0.6) return { stuckAt: i, pos: g.player.pos };
    }
    return { stuckAt: -1, pos: g.player.pos };
}
const expectWalk = (g: Game, path: Way[]) => {
    const r = walk(g, path);
    expect(r.stuckAt, `stuck before waypoint ${r.stuckAt} ${JSON.stringify(path[r.stuckAt])} at ${r.pos.map(v => v.toFixed(2))} (stage ${g.stage})`).toBe(-1);
};
/** Every machine stands down (the route tests are about the level, not the fights). */
const calm = (g: Game) => { for (const e of g.enemies) if (e.state !== "destroyed") e.state = "restored"; };
const use = (g: Game) => { g.step(DT, { ...NO_INPUT, use: true }); g.step(DT, NO_INPUT); };

const ACT1: V3[] = [
    [-13.7, 0, -11], [-13.7, 0, -6.8], [-19, 0, -6.8], [-19, 7, 7.2], [-15, 7, 9], [-4, 7, 10], [7, 7, 9],
    [8.5, 7, 2], [9.6, 7, -4], [9.6, 7, -12], [8, 7, -23], [8, 7, -21], [8, 14, -7], [6, 14, -4], [2.5, 14, -1.5],
];
const BRIDGE: Way[] = [[8, 14, 0], [26, 14, 0.8], [29.4, 14, 0], { at: [33.5, 14, 0], jump: true }, [38.6, 14, 0], { at: [42, 14, 0], crouch: true },
    [51.4, 14, 0], { at: [55.5, 14, 0], jump: true }, [66, 14, 0], [72.6, 14, -1], { at: [76.4, 14, -0.5], crouch: true }, [80, 14, 0.8], [86, 14, 0.8], [95, 14, 0]];
const TO_VAULT: Way[] = [[103, 14, 10], { at: [107.9, 14, 10], walk: true }, { at: [108, 14, 13.9], walk: true }, { at: [113, 14, 14], walk: true }, [113, 14, 10.2], [116.5, 14, 10.2], [120.6, 14, 11.8]];
const TO_BREAKERS: Way[] = [[116.5, 14, 10.2], [113, 14, 10.2], [113, 14, 14], { at: [108, 14, 14], walk: true }, { at: [107.9, 14, 10], walk: true }, { at: [103, 14, 10], walk: true },
    [94, 14, -6], [92, 14, -8.2], [92, 10.5, -16.4], [96, 10.5, -16.4], [96, 7, -8.2], [96, 7, -5], [102, 7, -6], [102, 7, -10], [117, 7, -13], [119.5, 7, -13], [123, 7, -10.5]];
const DOWN: Way[] = [[119.5, 7, -13], [117, 7, -13], [102, 7, -10], [102, 7, -6], [94, 7, -6], { at: [92, 7, -8.2], wait: 0 }, { at: [92, 3.5, -16.4], wait: 2 }, [96, 3.5, -16.4], [96, 0, -8.2],
    [92, 0, -8.2], [92, -3.5, -16.4], [96, -3.5, -16.4], [96, -7, -8.2], [92, -7, -8.2], [92, -10.5, -16.4], [96, -10.5, -16.4], [96, -14, -8.2], [92, -14, -8.2], [92, -14, -12], [86, -14, -12]];
const LOW: Way[] = [[73, -14, -12.4], [63.6, -14, -12], { at: [60.6, -14, -12], crouch: true }, [43, -14, -12], { at: [38.5, -14, -12], jump: true }, [6, -14, -12], [-4.4, -14, -4]];
const UP_TO_LIFT: Way[] = [[-18, -14, 10], [-21.85, -14, 12], [-21.85, -14, 15.6]];
const HOME: Way[] = [{ at: [-21.85, 14, 12], wait: 2 }, [-12, 14, 4], [2.5, 14, -1.5]];

describe("True Error level 1", () => {
    it("can be walked from the lab to the hypercube, which is asleep", () => {
        const g = new Game();
        calm(g);
        expectWalk(g, ACT1);
        expect(g.won).toBe(false);
        expect(g.stage).toBe("bridge");
        expect(g.events.some(e => e.kind === "dormant")).toBe(true);
        expect(g.player.pos[1]).toBeGreaterThan(PEDESTAL[1] - 0.2);
        expect(g.checkpoint).toBe("atrium");
    });

    it("can be played through: bridge, relay, breakers, shaft, lower bridge, reactor, lift, hypercube", () => {
        const g = new Game();
        calm(g);
        expectWalk(g, ACT1);
        expectWalk(g, BRIDGE);
        expect(g.stage).toBe("biochip");
        expect(g.checkpoint).toBe("relay-hall");
        expectWalk(g, TO_VAULT);
        expect(g.usable()?.id).toBe("biochip");
        use(g);
        expect(g.player.biochip).toBe(100);
        expect(g.stage).toBe("conduit");
        expectWalk(g, TO_BREAKERS);
        expect(g.player.alive).toBe(true);
        expect(g.player.biochip).toBeLessThan(100);
        expect(g.usable()?.id).toBe("conduit-c");
        use(g);
        expect(g.stage).toBe("descent");
        expectWalk(g, DOWN);
        expect(g.checkpoint).toBe("relay-bottom");
        expectWalk(g, LOW);
        expect(g.stage).toBe("reactor");
        use(g);
        expect(g.stage).toBe("holdout");
        for (let t = 0; t < HOLD_SECONDS + 1; t += DT) { calm(g); g.step(DT, NO_INPUT); }
        expect(g.stage).toBe("lift");
        expect(g.waves).toBe(4);
        expectWalk(g, UP_TO_LIFT);
        use(g);
        expect(g.stage).toBe("ride");
        for (let t = 0; t < 20 && g.stage === "ride"; t += DT) g.step(DT, NO_INPUT);
        expect(g.stage).toBe("warden");
        expect(g.player.pos[1]).toBeCloseTo(LIFT.top, 1);
        const w = g.enemies.find(e => e.kind === "warden")!;
        for (let t = 0; t < 2; t += DT) g.step(DT, NO_INPUT);
        expect(w.leap).toBeNull();
        w.state = "restored";
        g.step(DT, NO_INPUT);
        expect(g.stage).toBe("awaken");
        expectWalk(g, HOME);
        expect(g.won).toBe(true);
        expect(g.deaths).toBe(0);
    });

    it("a fallen girder on the bridge is crouched or rolled under, not walked through", () => {
        const g = new Game();
        calm(g);
        g.player.pos = [38.4, 14, 0];
        expect(walk(g, [[42, 14, 0]], 3).stuckAt).toBe(0);
        expect(g.player.pos[0]).toBeLessThan(40);
        g.player.pos = [37.5, 14, 0]; g.player.vel = [0, 0, 0];
        g.step(DT, { ...NO_INPUT, move: [0, 1], yaw: Math.PI / 2, dodge: true });
        for (let t = 0; t < 1.2; t += DT) g.step(DT, { ...NO_INPUT, move: [0, 1], yaw: Math.PI / 2, crouch: true });
        expect(g.player.pos[0]).toBeGreaterThan(40.7);
        // Under it, Ray can't stand up even if asked to.
        g.player.pos = [40.35, 14, 0];
        g.step(DT, NO_INPUT);
        expect(g.player.crouched).toBe(true);
    });

    it("a roll makes Ray untouchable for its middle", () => {
        const g = new Game();
        g.step(DT, { ...NO_INPUT, dodge: true, yaw: 0 });
        g.step(DT * 6, NO_INPUT);
        expect(g.dodging).toBe(true);
        expect(g.height).toBe(PLAYER.rollHeight);
        for (let t = 0; t < 1; t += DT) g.step(DT, NO_INPUT);
        expect(g.dodging).toBe(false);
        expect(g.player.rollT).toBe(-1);
    });

    it("crouching lowers Ray and slows him", () => {
        const g = new Game();
        for (let t = 0; t < 1; t += DT) g.step(DT, { ...NO_INPUT, move: [0, 1], crouch: true, yaw: Math.PI / 2 });
        expect(g.height).toBe(PLAYER.crouchHeight);
        expect(g.player.speed).toBeLessThan(PLAYER.crouch + 0.1);
    });

    it("the dark zone hurts, and the straight way through the hall is fatal", () => {
        const g = new Game();
        calm(g);
        g.player.pos = [-14, 7, 0];
        const r = walk(g, [[DARK_ZONE.center[0] + 0.5, 7, 0.5], [8, 7, 0]], 30);
        expect(g.said.has("inDark")).toBe(true);
        expect(g.deaths).toBeGreaterThan(0);
        expect(r.stuckAt).toBeGreaterThanOrEqual(0);
    });

    it("the biochip carries Ray through a dark zone, while it lasts", () => {
        const g = new Game();
        calm(g);
        g.stage = "conduit"; g.flags.add("biochip"); g.player.biochip = 100;
        g.player.pos = [RELAY_DARK.center[0], 7, RELAY_DARK.center[2]];
        for (let t = 0; t < 5; t += DT) g.step(DT, NO_INPUT);
        expect(g.player.integrity).toBe(100);
        expect(g.player.biochip).toBeLessThan(100);
        for (let t = 0; t < 20; t += DT) g.step(DT, NO_INPUT);
        expect(g.player.biochip).toBe(0);
        expect(g.player.integrity).toBeLessThan(100);
    });

    it("a dead breaker bites; only the live one restores the conduit", () => {
        const g = new Game();
        calm(g);
        g.stage = "conduit"; g.flags.add("biochip"); g.player.biochip = 100;
        g.player.pos = [123, 7, -16.2];
        expect(g.usable()?.id).toBe("conduit-a");
        use(g);
        expect(g.player.integrity).toBeLessThan(100);
        expect(g.stage).toBe("conduit");
        expect(g.usable()).toBeNull();
        g.player.pos = [123, 7, -10.2];
        use(g);
        expect(g.stage).toBe("descent");
        expect(g.flags.has("open:relay-stairs")).toBe(true);
    });

    it("a crawler winds up, then pounces where Ray stood", () => {
        const g = new Game();
        const c = g.enemies.find(e => e.id === "r-crawler-3")!;
        for (const e of g.enemies) if (e !== c) e.state = "restored";
        g.player.pos = [111, 7, 10.5];
        c.state = "fight"; c.cooldown = 0; c.pos = [111, 7, 5.5];
        let pounced = false;
        for (let t = 0; t < 3 && !pounced; t += DT) { g.step(DT, NO_INPUT); pounced = g.events.some(e => e.kind === "pounce"); }
        expect(pounced).toBe(true);
        for (let t = 0; t < 1; t += DT) g.step(DT, NO_INPUT);
        expect(g.player.integrity).toBe(100 - ENEMY.crawler.damage);
    });

    it("the Warden's shield turns shots from the front, not from behind", () => {
        const g = new Game();
        const w = g.spawn("warden", "warden", [0, 14, -8], "spire2");
        w.leap = null; w.state = "fight"; w.yaw = 0; w.charge = 0;
        expect(g.shielded(w, [0, 0, -1])).toBe(true);
        expect(g.shielded(w, [0, 0, 1])).toBe(false);
        w.charge = 0.3;
        expect(g.shielded(w, [0, 0, -1])).toBe(false);
    });

    it("saves and restores a run: stage, checkpoint, collectibles, machines", () => {
        const g = new Game();
        calm(g);
        expectWalk(g, ACT1);
        g.collect("pocket-watch");
        g.enemies[0].state = "destroyed";
        const s = JSON.parse(JSON.stringify(g.save()));
        const h = new Game();
        h.load(s);
        expect(h.stage).toBe("bridge");
        expect(h.checkpoint).toBe("atrium");
        expect(h.collected.has("pocket-watch")).toBe(true);
        expect(h.enemies[0].state).toBe("destroyed");
        expect(h.player.pos[1]).toBeCloseTo(14, 1);
    });

    it("every collectible in the level is defined, reachable to look at, and on something", () => {
        const g = new Game();
        // Between them, the two missions place every collectible once.
        expect(g.level.items.length + new Game(undefined, 2).level.items.length).toBe(COLLECTIBLES.length);
        for (const it of g.level.items) {
            expect(COLLECTIBLE.has(it.id), it.id).toBe(true);
            const ground = g.world.groundAt(it.pos[0], it.pos[2], 0.05, it.pos[1] + 0.05);
            expect(Math.abs(ground - it.pos[1]), `${it.id} floats or sinks`).toBeLessThan(0.08);
        }
    });

    it("a knocked-out machine can be Reset in reach, or rebooted if left alone", () => {
        const g = new Game();
        const e = g.enemies[0];
        e.state = "stunned"; e.stateT = 0; e.hp = 0;
        g.player.pos = [e.pos[0] + 1.5, e.pos[1], e.pos[2]];
        g.step(DT, { ...NO_INPUT, use: true });
        expect(e.state).toBe("restored");
        expect(g.resets).toBe(1);

        const f = g.enemies[1];
        f.state = "stunned"; f.stateT = 0; f.hp = 0;
        for (let t = 0; t < STUN_TIME + 0.5; t += DT) g.step(DT, NO_INPUT);
        expect(f.state).not.toBe("stunned");
        expect(f.hp).toBeGreaterThan(0);
    });

    it("shooting a knocked-out machine destroys it instead", () => {
        const g = new Game();
        calm(g);
        const e = g.enemies[0];
        e.state = "stunned"; e.stateT = 0; e.hp = 0;
        g.player.pos = [e.pos[0], e.pos[1], e.pos[2] - 5];
        const target: V3 = [e.pos[0], e.pos[1] + 0.5, e.pos[2]];
        for (let i = 0; i < 120 && e.state === "stunned"; i++) g.step(DT, { ...NO_INPUT, fire: true, aim: true, yaw: 0, target });
        expect(e.state).toBe("destroyed");
        expect(g.destroyed).toBe(1);
    });
});
