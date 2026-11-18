// Armageddon 2070 aim feel (ar_aim.ts): eased mouse motion keeps every count, the right stick eases up but
// stops at once, small stick drift does nothing, the look slows on a visible enemy (only there), and aim
// assist (0-50%) pulls onto one by the setting and never past it. Bots pull the trigger at a human pace.
import { describe, expect, it } from "vitest";
import { MouseEase, StickLook, STICK, frictionWeight, frictionScale, FRICTION, ASSIST, assistPull, nearestTarget, pullMargin } from "../src/games/armageddon/ar_aim";
import { BOT, reactionTime, aimSigmaDeg } from "../src/games/armageddon/ar_bots";
import { Battle, eyeOf, chestOf, type Soldier } from "../src/games/armageddon/ar_sim";
import { BALANCE, loadoutStats } from "../src/games/armageddon/ar_data";
import type { V3 } from "../src/games/nebula/nk_math";

const FRAME = 1 / 144;

describe("Armageddon aim", () => {
    it("eased mouse motion arrives in full, over a few frames", () => {
        for (const dt of [1 / 30, 1 / 60, FRAME, 1 / 240]) {
            const m = new MouseEase();
            let sum = 0;
            const first = m.take(100, -40, dt);
            sum += first[0];
            for (let i = 0; i < 200; i++) sum += m.take(0, 0, dt)[0];
            expect(sum).toBeCloseTo(100, 2);
            expect(first[0]).toBeGreaterThan(25);
        }
    });

    it("eased mouse motion evens out uneven per-frame counts", () => {
        const m = new MouseEase();
        const out: number[] = [];
        for (let i = 0; i < 200; i++) out.push(m.take(i % 2 ? 0 : 6, 0, FRAME)[0]);
        const tail = out.slice(100);
        // Raw counts swing 0..6 every other frame; eased they stay near the 3 per frame average.
        expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(3);
        expect(tail.reduce((a, b) => a + b, 0) / tail.length).toBeCloseTo(3, 1);
    });

    it("the stick ignores drift, eases up, boosts a held rim, and stops at once", () => {
        const s = new StickLook();
        for (let i = 0; i < 60; i++) s.step(0.08, -0.06, FRAME);
        expect(s.vel).toEqual([0, 0]);

        // Full right: under full rate on the first frame, at it within 0.15 s, boosted after half a second.
        const v0 = s.step(1, 0, FRAME)[0];
        expect(v0).toBeGreaterThan(0);
        expect(v0).toBeLessThan(STICK.rate * 0.3);
        for (let t = FRAME; t < 0.15; t += FRAME) s.step(1, 0, FRAME);
        expect(s.vel[0]).toBeGreaterThan(STICK.rate * 0.85);
        for (let t = 0.15; t < 0.6; t += FRAME) s.step(1, 0, FRAME);
        expect(s.vel[0]).toBeGreaterThan(STICK.rate * (STICK.boost - 0.05));

        // Let go: the view keeps turning for only a sliver after release.
        let after = 0;
        for (let i = 0; i < 60; i++) after += s.step(0, 0, FRAME)[0] * FRAME;
        expect(after).toBeLessThan(0.06);
        expect(s.vel[0]).toBe(0);
    });

    it("half stick is fine aim, well under half speed", () => {
        const s = new StickLook();
        for (let i = 0; i < 144; i++) s.step(0.5, 0, FRAME);
        expect(s.vel[0]).toBeGreaterThan(0.1);
        expect(s.vel[0]).toBeLessThan(STICK.rate * 0.3);
    });

    it("the look slows on a visible enemy and only there", () => {
        const eye: V3 = [0, 1.6, 0], fwd: V3 = [0, 0, 1];
        const at = (deg: number, dist: number): V3 => [Math.sin((deg * Math.PI) / 180) * dist, 1.6, Math.cos((deg * Math.PI) / 180) * dist];
        const seen = () => true;
        expect(frictionWeight(eye, fwd, [at(0, 60)], 1, seen)).toBe(1);
        expect(frictionWeight(eye, fwd, [at(0.8, 60)], 1, seen)).toBeGreaterThan(0.3);
        expect(frictionWeight(eye, fwd, [at(4, 60)], 1, seen)).toBe(0);
        expect(frictionWeight(eye, fwd, [at(0, 60)], 1, () => false)).toBe(0);
        expect(frictionWeight(eye, fwd, [at(180, 60)], 1, seen)).toBe(0);
        // Zoomed in, the margin shrinks with the view (the same screen distance).
        expect(frictionWeight(eye, fwd, [at(1.5, 60)], 1, seen)).toBeGreaterThan(0.1);
        expect(frictionWeight(eye, fwd, [at(1.5, 60)], 4, seen)).toBe(0);
        // The best of several targets counts.
        expect(frictionWeight(eye, fwd, [at(30, 20), at(0, 100)], 1, seen)).toBe(1);

        expect(frictionScale(0, true, 1)).toBe(1);
        expect(frictionScale(1, false, 0)).toBeCloseTo(1 - FRICTION.mouse[0]);
        expect(frictionScale(1, true, 1)).toBeCloseTo(1 - FRICTION.pad[1]);
    });

    it("aim assist scales the friction: none at 0%, today's at 25%, more (capped) at 50%", () => {
        expect(frictionScale(1, false, 0, 0)).toBe(1);
        expect(frictionScale(1, false, 1, ASSIST.default)).toBeCloseTo(1 - FRICTION.mouse[1]);
        expect(frictionScale(1, false, 1, ASSIST.max)).toBeCloseTo(1 - 2 * FRICTION.mouse[1]);
        expect(frictionScale(1, true, 1, ASSIST.max)).toBeCloseTo(0.25);
        expect(frictionScale(1, true, 1, 9)).toBeCloseTo(0.25);
    });

    it("aim assist pulls a sweep and a held aim onto a target, by the setting, and never past it", () => {
        const eye: V3 = [0, 1.6, 0], target: V3 = [Math.sin(0.03) * 50, 1.6, Math.cos(0.03) * 50];
        const pull = (assist: number, turned: number, engaged: boolean) => assistPull(eye, 0, 0, target, 1, assist, turned, engaged, FRAME);
        // Off: nothing. Neither turning nor aiming: nothing (it never moves an idle view).
        expect(pull(0, 0.01, true)).toEqual([0, 0]);
        expect(pull(0.25, 0, false)).toEqual([0, 0]);
        // A share of the player's own turn, toward the target (positive yaw here), twice as much at 50%.
        const a = pull(0.25, 0.01, false)[0], b = pull(0.5, 0.01, false)[0];
        expect(a).toBeCloseTo(0.0025, 5);
        expect(b).toBeCloseTo(0.005, 5);
        // Aimed or firing it also tracks: a held view closes on the target over about a second at 25%.
        let yaw = 0;
        for (let i = 0; i < 144; i++) yaw += assistPull(eye, yaw, 0, target, 1, ASSIST.default, 0, true, FRAME)[0];
        expect(yaw).toBeGreaterThan(0.015);
        expect(yaw).toBeLessThan(0.03);
        // A big sweep never carries it past.
        expect(pull(0.5, 1, false)[0]).toBeCloseTo(0.03, 6);
    });

    it("aim assist leaves the height alone on the body and head, and pulls back onto it from above", () => {
        const eye: V3 = [0, 1.6, 0], chest: V3 = [0, 1.3, 40];
        const head = Math.atan2(1.65 - 1.6, 40), over = Math.atan2(3 - 1.6, 40);
        expect(assistPull(eye, 0.01, head, chest, 1, 0.5, 0.01, true, FRAME)[1]).toBe(0);
        expect(assistPull(eye, 0.01, over, chest, 1, 0.5, 0.01, true, FRAME)[1]).toBeLessThan(0);
    });

    it("the pull reaches a little wider with more assist, and only to visible targets", () => {
        const eye: V3 = [0, 1.6, 0], fwd: V3 = [0, 0, 1];
        const off: V3 = [Math.sin((2.2 * Math.PI) / 180) * 60, 1.6, Math.cos((2.2 * Math.PI) / 180) * 60];
        const seen = () => true;
        expect(nearestTarget(eye, fwd, [off], 1, seen, pullMargin(0)).weight).toBe(0);
        expect(nearestTarget(eye, fwd, [off], 1, seen, pullMargin(ASSIST.max)).weight).toBeGreaterThan(0.2);
        expect(nearestTarget(eye, fwd, [off], 1, () => false, pullMargin(ASSIST.max)).at).toBeNull();
    });
});

describe("Armageddon bot trigger pace", () => {
    it("a bot needs a human-scale moment before its first shot: more turned away, further off, slower sights", () => {
        const ahead = reactionTime(0, 40, 0.3, 0.5, false);
        expect(ahead).toBeGreaterThan(0.9);
        expect(ahead).toBeLessThan(1.4);
        expect(reactionTime(Math.PI, 40, 0.3, 0.5, false)).toBeCloseTo(ahead + BOT.turn, 6);
        expect(reactionTime(0, 200, 0.3, 0.5, false)).toBeGreaterThan(ahead + 0.5);
        expect(reactionTime(0, 40, 0.45, 0.5, false)).toBeCloseTo(ahead + 0.15, 6);
        // Already in a fight, the next target comes quicker, but never instantly.
        expect(reactionTime(0, 40, 0.3, 0, true)).toBeGreaterThan(0.5);
        expect(reactionTime(0, 40, 0.3, 0.5, true)).toBeLessThan(ahead);
    });

    it("the first shots go wide and settle over a few seconds", () => {
        expect(aimSigmaDeg(0.7, 0, false, 0, 0)).toBeCloseTo(0.7 * (1 + BOT.open), 6);
        expect(aimSigmaDeg(0.7, BOT.settle / 2, false, 0, 0)).toBeCloseTo(0.7 * (1 + BOT.open / 2), 6);
        expect(aimSigmaDeg(0.7, 10, false, 0, 0)).toBeCloseTo(0.7, 6);
        expect(aimSigmaDeg(0.7, 10, true, 2, 100)).toBeCloseTo(0.7 * 1.6 + 0.8 + 0.2, 6);
    });

    it("bot rounds hit the human player softer than they hit another bot", () => {
        const b = new Battle({ map: "glass-coast", perTeam: 8, seed: 5, vehicles: false });
        const me = b.me!;
        const shooter = b.soldiers.find(s => s.team !== me.team)!, other = b.soldiers.find(s => s.team === me.team && s.bot)!;
        const hitBy = (o: Soldier) => {
            const [x, z] = b.world.openNear(0, 0);
            for (const s of b.soldiers) s.alive = false;
            for (const s of [shooter, o]) { s.alive = true; s.hp = 100; s.stance = "stand"; s.vel = [0, 0, 0]; s.loadout.armor = {}; s.stats = loadoutStats(s.loadout); }
            shooter.pos = [x, b.world.height(x, z), z];
            o.pos = [x, b.world.height(x, z), z + 2];
            (b as unknown as { rebuildBuckets(): void }).rebuildBuckets();
            shooter.mag.primary = 30; shooter.slot = "primary"; shooter.bloom = 0; shooter.nextShot = 0; shooter.reloadUntil = 0;
            const e = eyeOf(shooter), c = chestOf(o);
            const d = Math.hypot(c[0] - e[0], c[2] - e[2]);
            expect(b.fire(shooter, Math.atan2(c[0] - e[0], c[2] - e[2]), Math.atan2(c[1] - e[1], d), true)).toBe(true);
            return 100 - o.hp;
        };
        const toBot = hitBy(other), toMe = hitBy(me);
        expect(toBot).toBeGreaterThan(0);
        expect(toMe / toBot).toBeCloseTo(BALANCE.botVsPlayer, 2);
    });
});
