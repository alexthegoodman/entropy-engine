// The Game World Detailer's editing camera and Preview World walker, without the engine.
import { describe, expect, it } from "vitest";
import { EditorCamera, orbitPosition, MIN_PITCH, MAX_DISTANCE, type V3 } from "../src/apps/game_detailer/detail_camera";
import { Walker, deadzone, pushOut, inside, WALK_SPEED, SPRINT_SPEED, SWIM_DEPTH, type Blocker, type PreviewInput } from "../src/apps/game_detailer/detail_preview";
import { drawDistance, chooseLod } from "../src/apps/game_detailer/detail_view";
import { buildModelLods, viewportValues } from "../src/apps/game_detailer/detail_mesh";
import { INTERIOR_REGIONS } from "../src/apps/quadplanet/qp_city";
import { lookupObject } from "../src/apps/mesha/library";
import { evaluateObject } from "../src/apps/mesha/mesha_object";

const flat = () => 0;
const settle = (cam: EditorCamera, ground: (x: number, z: number) => number = flat, frames = 120) => { let p = cam.update(1 / 60, ground); for (let i = 0; i < frames; i++) p = cam.update(1 / 60, ground); return p; };

describe("the editor camera", () => {
    it("zooms by a share of the distance, so a notch feels the same at 5 m and at 500 m", () => {
        const near = new EditorCamera({ pivot: [0, 0, 0], yaw: 0, pitch: 0.6, distance: 5 });
        const far = new EditorCamera({ pivot: [0, 0, 0], yaw: 0, pitch: 0.6, distance: 500 });
        near.zoom(1); far.zoom(1);
        expect(near.goal.distance / 5).toBeCloseTo(far.goal.distance / 500, 6);
        expect(far.goal.distance).toBeLessThan(500);
        for (let i = 0; i < 100; i++) far.zoom(-4);
        expect(far.goal.distance).toBe(MAX_DISTANCE);
    });

    it("zooms toward the point under the cursor", () => {
        const cam = new EditorCamera({ pivot: [0, 0, 0], yaw: 0, pitch: 0.6, distance: 200 });
        cam.zoom(3, [100, 0, -50]);
        expect(cam.goal.pivot[0]).toBeGreaterThan(30);
        expect(cam.goal.pivot[2]).toBeLessThan(-10);
        // Zooming out does not drag the view sideways.
        const before = [...cam.goal.pivot];
        cam.zoom(-2, [500, 0, 500]);
        expect(cam.goal.pivot).toEqual(before);
    });

    it("drags the ground at a speed that keeps it under the cursor, near or far", () => {
        for (const distance of [8, 800]) {
            const cam = new EditorCamera({ pivot: [0, 0, 0], yaw: 0, pitch: Math.PI / 2 - 0.01, distance });
            cam.viewportHeight = 1000;
            const mpp = cam.metersPerPixel();
            cam.pan(100, 0);
            // Looking north (yaw 0) straight down: dragging right moves the view west by 100 px of ground.
            expect(cam.goal.pivot[0]).toBeCloseTo(-100 * mpp, 3);
            expect(Math.abs(cam.goal.pivot[2])).toBeLessThan(1e-6);
        }
    });

    it("glides with the keys at a speed that scales with the distance, easing in and out", () => {
        const low = new EditorCamera({ pivot: [0, 0, 0], yaw: 0, pitch: 0.5, distance: 20 });
        const high = new EditorCamera({ pivot: [0, 0, 0], yaw: 0, pitch: 0.5, distance: 400 });
        for (let i = 0; i < 60; i++) { low.drive(1 / 60, 1, 0); high.drive(1 / 60, 1, 0); }
        // Yaw 0 looks north (-Z).
        expect(low.goal.pivot[2]).toBeLessThan(0);
        expect(-high.goal.pivot[2]).toBeGreaterThan(-low.goal.pivot[2] * 10);
        // The first frame is gentle (no jump).
        const c = new EditorCamera({ pivot: [0, 0, 0], yaw: 0, pitch: 0.5, distance: 100 });
        c.drive(1 / 60, 1, 0);
        expect(Math.abs(c.goal.pivot[2])).toBeLessThan(0.5);
        // Letting go stops it within a moment.
        for (let i = 0; i < 60; i++) c.drive(1 / 60, 0, 0);
        const z = c.goal.pivot[2];
        c.drive(1 / 60, 0, 0);
        expect(Math.abs(c.goal.pivot[2] - z)).toBeLessThan(1e-3);
    });

    it("eases to where it is asked to go, and stays above the ground", () => {
        const cam = new EditorCamera({ pivot: [0, 0, 0], yaw: 0, pitch: 0.5, distance: 100 });
        cam.glideTo([300, 0, 0], 40);
        const first = cam.update(1 / 60, flat);
        expect(first.target[0]).toBeGreaterThan(0);
        expect(first.target[0]).toBeLessThan(100);
        const end = settle(cam);
        expect(end.target[0]).toBeCloseTo(300, 0);
        expect(Math.hypot(end.pos[0] - end.target[0], end.pos[1] - end.target[1], end.pos[2] - end.target[2])).toBeCloseTo(40, 0);
        // A hill behind the camera: it rides over it.
        const hill = (x: number, z: number) => (z > 20 ? 80 : 0);
        const c2 = new EditorCamera({ pivot: [0, 0, 0], yaw: 0, pitch: MIN_PITCH, distance: 100 });
        const p = settle(c2, hill);
        expect(p.pos[1]).toBeGreaterThan(80);
    });

    it("orbits around the pivot and puts the camera where goTo's views expect", () => {
        const pos = orbitPosition([0, 0, 0], Math.PI / 2, 0, 10);
        expect(pos[0]).toBeCloseTo(10);
        const cam = new EditorCamera({ pivot: [0, 0, 0], yaw: 0, pitch: 0.5, distance: 50 });
        cam.orbit(200, 0);
        expect(cam.goal.yaw).toBeLessThan(0);
        cam.orbit(0, 100000);
        expect(cam.goal.pitch).toBeLessThan(Math.PI / 2);
    });
});

const idle: PreviewInput = { move: [0, 0], lookYaw: 0, lookPitch: 0, sprint: false, jump: false };
const run = (w: Walker, input: Partial<PreviewInput>, seconds: number, ground: (x: number, z: number) => number = flat, blockers: Blocker[] = [], sea = -100) => {
    for (let t = 0; t < seconds; t += 1 / 60) w.step(1 / 60, { ...idle, ...input }, ground, sea, blockers);
};

describe("Preview World's walker", () => {
    it("walks where the camera looks, faster when sprinting, and turns the body that way", () => {
        const w = new Walker(0, 0, 0, 0);
        run(w, { move: [0, 1] }, 1);
        expect(w.z).toBeLessThan(-WALK_SPEED * 0.7);
        expect(Math.abs(w.x)).toBeLessThan(1e-6);
        // Facing north (-Z): heading pi.
        expect(Math.abs(Math.cos(w.bodyYaw) + 1)).toBeLessThan(0.05);
        const s = new Walker(0, 0, 0, 0);
        run(s, { move: [0, 1], sprint: true }, 1);
        expect(-s.z).toBeGreaterThan(-w.z * (SPRINT_SPEED / WALK_SPEED) * 0.8);
        // Strafing right while looking north goes east.
        const r = new Walker(0, 0, 0, 0);
        run(r, { move: [1, 0] }, 1);
        expect(r.x).toBeGreaterThan(3);
    });

    it("follows the ground up and down, jumps and lands", () => {
        const slope = (x: number) => x * 0.2;
        const w = new Walker(0, 0, 0, -Math.PI / 2); // looking east
        run(w, { move: [0, 1] }, 2, slope);
        expect(w.x).toBeGreaterThan(5);
        expect(w.y).toBeCloseTo(slope(w.x), 1);
        expect(w.onGround).toBe(true);
        const j = new Walker(0, 0, 0, 0);
        j.step(1 / 60, { ...idle, jump: true }, flat, -100, []);
        let top = 0;
        for (let i = 0; i < 30; i++) { j.step(1 / 60, idle, flat, -100, []); top = Math.max(top, j.y); }
        expect(top).toBeGreaterThan(0.5);
        run(j, {}, 2);
        expect(j.y).toBe(0);
        expect(j.onGround).toBe(true);
    });

    it("is stopped by buildings but steps onto low things like a dock", () => {
        const house: Blocker = { x: 0, z: -10, yaw: 0.4, hw: 4, hd: 3, top: 8, name: "House" };
        const w = new Walker(0, 0, 0, 0);
        run(w, { move: [0, 1] }, 5, flat, [house]);
        expect(inside(w.x, w.z, 0.3, house)).toBe(false);
        expect(w.touching?.name).toBe("House");
        const dock: Blocker = { x: 0, z: -10, yaw: 0, hw: 2, hd: 6, top: 0.3 };
        const d = new Walker(0, 0, 0, 0);
        run(d, { move: [0, 1] }, 3, flat, [dock]);
        expect(d.z).toBeLessThan(-6);
        expect(d.y).toBeCloseTo(0.3, 5);
    });

    it("pushes a circle out of turned boxes and circles", () => {
        const box: Blocker = { x: 5, z: 5, yaw: Math.PI / 4, hw: 2, hd: 1, top: 5 };
        for (const [x, z] of [[5, 5], [6, 5.5], [4.2, 4.6]] as const) {
            const p = pushOut(x, z, 0.35, box);
            expect(p).not.toBeNull();
            expect(inside(p![0], p![1], 0.34, box)).toBe(false);
        }
        expect(pushOut(20, 20, 0.35, box)).toBeNull();
        const tree: Blocker = { x: 0, z: 0, yaw: 0, hw: 0, hd: 0, r: 0.4, top: 20 };
        const p = pushOut(0.1, 0, 0.35, tree)!;
        expect(Math.hypot(p[0], p[1])).toBeCloseTo(0.75);
    });

    it("swims in deep water instead of sinking", () => {
        const deep = () => -10;
        const w = new Walker(0, 0, 0, 0);
        run(w, { move: [0, 1] }, 3, deep, [], 0);
        expect(w.swimming).toBe(true);
        expect(w.y).toBeCloseTo(-SWIM_DEPTH, 5);
    });

    it("puts the third-person camera behind and above, never under the ground, and first person at the eyes", () => {
        const w = new Walker(0, 0, 0, 0);
        const c = w.camera(1 / 60, flat);
        expect(c.pos[2]).toBeGreaterThan(2); // behind: south of a walker looking north
        expect(c.pos[1]).toBeGreaterThan(1);
        w.lookPitch = 1.2; // looking up: the camera dips but stays above the ground
        for (let i = 0; i < 60; i++) w.camera(1 / 60, flat);
        expect(w.camera(1 / 60, flat).pos[1]).toBeGreaterThanOrEqual(0.4 - 1e-6);
        w.toggleView();
        const f = w.camera(1 / 60, flat);
        expect(f.pos).toEqual([0, 1.62, 0]);
    });

    it("ignores a resting stick and rescales past the dead zone", () => {
        expect(deadzone([0.1, -0.1])).toEqual([0, 0]);
        const [x, y] = deadzone([0, 1]);
        expect(x).toBe(0);
        expect(y).toBeCloseTo(1);
        expect(deadzone([0, 0.5])[1]).toBeLessThan(0.5);
    });
});

describe("what the viewport draws", () => {
    it("draws a person and a shrub in front of the camera from far off, grass only nearer", () => {
        expect(drawDistance(0.9)).toBeGreaterThan(220);
        expect(drawDistance(0.5)).toBeGreaterThan(120);
        expect(drawDistance(0.2)).toBeGreaterThanOrEqual(70);
        expect(drawDistance(0.2)).toBeLessThan(drawDistance(0.9));
        expect(drawDistance(8)).toBe(1700);
        expect(chooseLod(5, 1)).toBe(0);
    });

    it("never builds a building's interior", () => {
        const def = lookupObject("architecture.house")!;
        const e = evaluateObject(def, {}, lookupObject);
        expect(e.mesh.parts.some((p) => INTERIOR_REGIONS.has(p.region))).toBe(true);
        const built = buildModelLods("architecture.house", {}, 1);
        const full = e.mesh.parts.reduce((n, p) => n + p.indices.length / 3, 0);
        expect(built.lods[0].triangles).toBeLessThan(full);
    });

    it("builds people with painted clothes and hair: no strands, no draped cloth, a fraction of the triangles", () => {
        expect(viewportValues("people.human", { quality: "final" }).quality).toBe("game");
        expect(viewportValues("nature.tree", { height: 9 })).toEqual({ height: 9 });
        const def = lookupObject("people.human")!;
        const game = evaluateObject(def, { quality: "game" }, lookupObject);
        const regions = new Set(game.mesh.parts.map((p) => p.region));
        expect(regions.has("hair")).toBe(false);
        expect(regions.has("lashes")).toBe(false);
        for (const r of ["top", "bottom", "shoes", "hairCap", "skin"]) expect(regions.has(r), r).toBe(true);
        const draft = evaluateObject(def, { quality: "draft" }, lookupObject);
        expect(game.stats.triangles).toBeLessThan(draft.stats.triangles / 3);
        // Bald and barefoot in nothing: skin only (plus the face's own regions).
        const bare = evaluateObject(def, { quality: "game", hairStyle: "none", top: "none", bottom: "none", shoes: "none" }, lookupObject);
        const bareRegions = new Set(bare.mesh.parts.map((p) => p.region));
        for (const r of ["top", "bottom", "shoes", "hairCap"]) expect(bareRegions.has(r), r).toBe(false);
    }, 60000);
});
