// Armageddon 2070 aim feel (ar_aim.ts): eased mouse motion keeps every count, the right stick eases up but
// stops at once, small stick drift does nothing, and the look slows on a visible enemy (only there).
import { describe, expect, it } from "vitest";
import { MouseEase, StickLook, STICK, frictionWeight, frictionScale, FRICTION } from "../src/games/armageddon/ar_aim";
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
});
