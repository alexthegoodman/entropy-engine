import { describe, it, expect } from "vitest";
import { Game, NO_INPUT, STUN_TIME, type PlayerInput } from "../src/games/true_error/te_game";
import { DARK_ZONE, PEDESTAL, type V3 } from "../src/games/true_error/te_level";

const DT = 1 / 60;

/** Walks Ray to each waypoint in turn (running, camera turned toward it); returns where he got stuck, if anywhere. */
function walk(g: Game, path: V3[], maxSeconds = 25): { stuckAt: number; pos: V3 } {
    for (let i = 0; i < path.length; i++) {
        const w = path[i];
        let t = 0;
        while (Math.hypot(w[0] - g.player.pos[0], w[2] - g.player.pos[2]) > 0.5) {
            const yaw = Math.atan2(w[0] - g.player.pos[0], w[2] - g.player.pos[2]);
            const input: PlayerInput = { ...NO_INPUT, move: [0, 1], run: true, yaw };
            g.step(DT, input);
            t += DT;
            if (t > maxSeconds || !g.player.alive) return { stuckAt: i, pos: g.player.pos };
        }
        if (Math.abs(w[1] - g.player.pos[1]) > 0.6) return { stuckAt: i, pos: g.player.pos };
    }
    return { stuckAt: -1, pos: g.player.pos };
}

const ROUTE: V3[] = [
    [-13.7, 0, -11], [-13.7, 0, -6.8], [-19, 0, -6.8], [-19, 7, 7.2], [-15, 7, 9], [-4, 7, 10], [7, 7, 9],
    [8.5, 7, 2], [9.6, 7, -4], [9.6, 7, -12], [8, 7, -23], [8, 7, -21], [8, 14, -7], [6, 14, -4], [2.5, 14, -1.5],
];

describe("True Error level 1", () => {
    it("can be walked from the lab to the hypercube (enemies out of the way)", () => {
        const g = new Game();
        for (const e of g.enemies) e.state = "restored";
        const r = walk(g, ROUTE);
        expect(r.stuckAt, `stuck before waypoint ${r.stuckAt} ${JSON.stringify(ROUTE[r.stuckAt])} at ${r.pos.map(v => v.toFixed(2))}`).toBe(-1);
        expect(g.won).toBe(true);
        expect(g.player.pos[1]).toBeGreaterThan(PEDESTAL[1] - 0.2);
        expect(g.checkpoint).toBe("atrium");
    });

    it("the dark zone hurts, and the straight way through the hall is fatal", () => {
        const g = new Game();
        for (const e of g.enemies) e.state = "restored";
        g.player.pos = [-14, 7, 0];
        const r = walk(g, [[DARK_ZONE.center[0] + 0.5, 7, 0.5], [8, 7, 0]], 30);
        expect(g.said.has("inDark")).toBe(true);
        expect(g.deaths).toBeGreaterThan(0);
        expect(r.stuckAt).toBeGreaterThanOrEqual(0);
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
        for (const e of g.enemies) e.state = "restored";
        const e = g.enemies[0];
        e.state = "stunned"; e.stateT = 0; e.hp = 0;
        g.player.pos = [e.pos[0], e.pos[1], e.pos[2] - 5];
        const target: V3 = [e.pos[0], e.pos[1] + 0.5, e.pos[2]];
        for (let i = 0; i < 120 && e.state === "stunned"; i++) g.step(DT, { ...NO_INPUT, fire: true, aim: true, yaw: 0, target });
        expect(e.state).toBe("destroyed");
        expect(g.destroyed).toBe(1);
    });
});
