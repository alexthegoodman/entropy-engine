import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { parseGlb } from "../src/games/true_error/te_glb";
import { Skeleton, Animator, skinVertices } from "../src/games/true_error/te_skin";

const GAME = "assets/true_error/game";
const has = (name: string) => existsSync(`${GAME}/${name}.glb`);

describe("True Error GLB + skinning", () => {
    it.skipIf(!has("ray"))("Ray parses with his skin and named clips", () => {
        const m = parseGlb(new Uint8Array(readFileSync(`${GAME}/ray.glb`)));
        expect(m.skin?.joints.length).toBe(24);
        expect(m.clips.map(c => c.name)).toEqual(["walk", "run", "idle", "combat_idle", "walk_shoot", "walk_back_shoot", "jump", "hit", "death"]);
        expect(m.indices.length % 3).toBe(0);
        expect(m.joints!.length).toBe((m.positions.length / 3) * 4);
    });

    it.skipIf(!has("ray"))("idle keeps Ray standing on his bind-pose floor, about 1.7 m tall, over the origin", () => {
        const m = parseGlb(new Uint8Array(readFileSync(`${GAME}/ray.glb`)));
        const sk = new Skeleton(m);
        const anim = new Animator(sk);
        anim.play("idle");
        anim.update(0.5);
        const v = skinVertices(m, sk, new Float32Array((m.positions.length / 3) * 12));
        let lo = Infinity, hi = -Infinity, cx = 0;
        for (let i = 0; i < v.length; i += 12) { lo = Math.min(lo, v[i + 1]); hi = Math.max(hi, v[i + 1]); cx += v[i]; }
        cx /= v.length / 12;
        // Meshy's rig of an uploaded model is not floored at y = 0: the game lifts it by -min.y.
        expect(Math.abs(lo - m.min[1])).toBeLessThan(0.15);
        expect(hi - lo).toBeGreaterThan(1.5);
        expect(hi - lo).toBeLessThan(2.1);
        expect(Math.abs(cx)).toBeLessThan(0.3);
        for (let i = 0; i < v.length; i++) expect(Number.isFinite(v[i])).toBe(true);
    });

    it.skipIf(!has("ray"))("walking moves the feet but the hips stay over the origin (root lock)", () => {
        const m = parseGlb(new Uint8Array(readFileSync(`${GAME}/ray.glb`)));
        const sk = new Skeleton(m);
        const anim = new Animator(sk);
        anim.play("walk");
        const hips = sk.node("Hips"), foot = sk.node("LeftFoot");
        const rest = m.nodes[hips].t, scale = 0.01;
        const feet: number[] = [];
        for (let k = 0; k < 10; k++) {
            anim.update(0.1);
            const [hx, , hz] = sk.position(hips);
            expect(Math.hypot(hx - rest[0] * scale, hz - rest[2] * scale)).toBeLessThan(0.01);
            feet.push(sk.position(foot)[2]);
        }
        expect(Math.max(...feet) - Math.min(...feet)).toBeGreaterThan(0.2);
    });

    it.skipIf(!has("rubble"))("a static Meshy prop is a unit-sized textured mesh", () => {
        const m = parseGlb(new Uint8Array(readFileSync(`${GAME}/rubble.glb`)));
        expect(m.skin).toBeNull();
        const size = Math.max(m.max[0] - m.min[0], m.max[1] - m.min[1], m.max[2] - m.min[2]);
        expect(size).toBeGreaterThan(0.9);
        expect(size).toBeLessThan(1.1);
        expect(m.uvs.length / 2).toBe(m.positions.length / 3);
    });
});
