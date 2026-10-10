import { describe, expect, it } from "vitest";
import { type Mesh, type Vec3, bounds, transformMesh } from "../src/apps/mesha/mesha_mesh";
import { evaluateObject, resolveParams, type ParamValues } from "../src/apps/mesha/mesha_object";
import { lookupObject } from "../src/apps/mesha/library";
import { SCENES, lookupScene } from "../src/apps/mesha/scenes";
import { evaluateScene, mergeScene, validateScene, type ScenePlacement } from "../src/apps/mesha/mesha_scene_def";
import { instanceMatrix, type Instance } from "../src/apps/mesha/mesha_scene";
import { vary } from "../src/apps/mesha/mesha_variation";

// Nearest positive ray hit over a flattened triangle list.
function flatten(mesh: Mesh): Float64Array {
    const out: number[] = [];
    for (const p of mesh.parts) for (const i of p.indices) out.push(p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]);
    return Float64Array.from(out);
}
function castRay(tris: Float64Array, o: Vec3, d: Vec3): number {
    let nearest = Infinity;
    for (let i = 0; i < tris.length; i += 9) {
        const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
        const e1x = tris[i + 3] - ax, e1y = tris[i + 4] - ay, e1z = tris[i + 5] - az;
        const e2x = tris[i + 6] - ax, e2y = tris[i + 7] - ay, e2z = tris[i + 8] - az;
        const hx = d[1] * e2z - d[2] * e2y, hy = d[2] * e2x - d[0] * e2z, hz = d[0] * e2y - d[1] * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz;
        if (Math.abs(det) < 1e-12) continue;
        const sx = o[0] - ax, sy = o[1] - ay, sz = o[2] - az;
        const u = (sx * hx + sy * hy + sz * hz) / det;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) / det;
        if (t > 1e-7 && t < nearest) nearest = t;
    }
    return nearest;
}
const ray = (mesh: Mesh, o: Vec3, d: Vec3) => castRay(flatten(mesh), o, d);
const meshOf = (id: string, values: ParamValues = {}) => evaluateObject(lookupObject(id)!, values, lookupObject);
const regionMesh = (mesh: Mesh, region: string): Mesh => ({ parts: mesh.parts.filter(p => p.region === region) });

/** World-space geometry of a scene's placements (optionally only some objects). */
function world(placements: ScenePlacement[], keep: (p: ScenePlacement) => boolean = () => true): Mesh {
    const parts: Mesh["parts"] = [];
    for (const p of placements.filter(keep)) {
        const e = meshOf(p.objectId, p.values);
        parts.push(...transformMesh(e.mesh, instanceMatrix({ id: p.key, objectId: p.objectId, values: p.values, position: p.position, rotationY: p.rotationY, scale: p.scale })).parts);
    }
    return { parts };
}

describe("Mesha rust dome", () => {
    const base = 0.3;
    it("stands as many storeys tall as it says", () => {
        for (const storeys of [3, 5, 8]) for (const storeyHeight of [3, 3.6, 4.5]) {
            const e = meshOf("architecture.rust_dome", { storeys, storeyHeight, beacon: false, oculus: 0 });
            const top = e.stats.bounds!.max[1];
            expect(top, JSON.stringify({ storeys, storeyHeight })).toBeGreaterThan(base + storeys * storeyHeight - 0.05);
            expect(top).toBeLessThan(base + storeys * storeyHeight + 0.6);
            expect(e.violations).toEqual([]);
        }
    });
    it("the gate opens into the lobby, and closed blast doors seal it", () => {
        const r = 14;
        const open = meshOf("architecture.rust_dome", { radius: r, doorOpen: 0.6 });
        // From the apron, straight in: past the wall, across the lobby to the lift core.
        const coreR = Math.min(2.2, r * 0.38 * 0.45);
        expect(ray(open.mesh, [0, base + 1.5, r + 4], [0, 0, -1])).toBeCloseTo(r + 4 - coreR, 0);
        const shut = meshOf("architecture.rust_dome", { radius: r, doorOpen: 0 });
        expect(ray(shut.mesh, [0, base + 1.5, r + 4], [0, 0, -1])).toBeLessThan(4.6);
    });
    it("windows are real openings in the drum, with solid piers between them", () => {
        const v = resolveParams(lookupObject("architecture.rust_dome")!, { brokenPanes: 1, boarded: 0, litWindows: 0, decks: false, buttresses: 0, lantern: false });
        const e = meshOf("architecture.rust_dome", v);
        const r = Number(v.radius), sh = Number(v.storeyHeight), wh = Number(v.windowHeight), n = Number(v.windowsPerStorey);
        const sill = (sh - wh) * 0.45, y = base + sh + sill + wh / 2; // second storey, clear of the gate
        const at = (b: number): [Vec3, Vec3] => [[(r + 3) * Math.cos(b * Math.PI / 180), y, (r + 3) * Math.sin(b * Math.PI / 180)], [-Math.cos(b * Math.PI / 180), 0, -Math.sin(b * Math.PI / 180)]];
        for (const k of [3, 7, 12]) {
            const b = 90 + k * 360 / n;
            const [o1, d1] = at(b);
            expect(ray(e.mesh, o1, d1), `window ${k}`).toBeGreaterThan(3 + Number(v.wall) + 1);
            const [o2, d2] = at(b + 180 / n);
            expect(ray(e.mesh, o2, d2), `pier ${k}`).toBeCloseTo(3, 1);
        }
    });
    it("lifting the shell shows the decks, which ring an open atrium", () => {
        const r = 14, x = r * 0.62;
        const shown = meshOf("architecture.rust_dome", { radius: r, missingPanels: 0, beacon: false });
        const lifted = meshOf("architecture.rust_dome", { radius: r, roofVisible: false, beacon: false });
        const tShown = ray(shown.mesh, [x, 40, 0.3], [0, -1, 0]), tLifted = ray(lifted.mesh, [x, 40, 0.3], [0, -1, 0]);
        expect(tLifted).toBeGreaterThan(tShown + 1);
        // Straight down the atrium beside the core: nothing until the ground floor.
        expect(ray(lifted.mesh, [2.5, 40, 3], [0, -1, 0])).toBeCloseTo(40 - base, 1);
    });
});

describe("Mesha wasteland props", () => {
    it("a missing wheel drops its corner of the wreck", () => {
        const lowest = (m: Mesh, sx: number) => { let y = Infinity; for (const p of regionMesh(m, "body").parts) for (let i = 0; i < p.positions.length; i += 3) if (Math.sign(p.positions[i]) === sx && p.positions[i + 2] > 1) y = Math.min(y, p.positions[i + 1]); return y; };
        const whole = meshOf("transport.wreck_car", { missingWheels: 0, roll: 0, sink: 0, flatTyres: false });
        expect(Math.abs(lowest(whole.mesh, 1) - lowest(whole.mesh, -1))).toBeLessThan(0.01);
        const one = meshOf("transport.wreck_car", { missingWheels: 1, roll: 0, sink: 0, flatTyres: false });
        expect(lowest(one.mesh, -1) - lowest(one.mesh, 1)).toBeGreaterThan(0.05);
    });
    it("a container's cut doorway is a real opening into the box", () => {
        const L = 6.06, panels = 5, z = -L / 2 + (Math.floor(panels / 2) + 0.5) * (L / panels);
        const shut = meshOf("transport.container", { cutDoor: false, missingPanels: 0, doorsOpen: 0 });
        const cut = meshOf("transport.container", { cutDoor: true, missingPanels: 0, doorsOpen: 0 });
        expect(ray(shut.mesh, [3, 1.2, z], [-1, 0, 0])).toBeLessThan(2);
        expect(ray(cut.mesh, [3, 1.2, z], [-1, 0, 0])).toBeGreaterThan(4);
    });
    it("a ruin's window openings go right through the wall", () => {
        const v = { length: 9, height: 5, openings: 2, openingWidth: 1.3, ruin: 0, holes: 0, rubble: 0, slab: false, returnWall: 0, rebar: false };
        const e = meshOf("architecture.ruin", v);
        const sill = Math.min(0.9, 5 * 0.25), head = sill + Math.min(1.5, 5 * 0.45);
        for (const k of [0, 1]) expect(ray(e.mesh, [(k + 1) * 9 / 3 - 4.5, (sill + head) / 2, 3], [0, 0, -1])).toBe(Infinity);
        expect(ray(e.mesh, [0.2, (sill + head) / 2, 3], [0, 0, -1])).toBeCloseTo(3 - 0.15, 2);
    });
    it("utility pole wires reach the next pole, span metres along +X", () => {
        for (const span of [12, 22, 35]) {
            const e = meshOf("street.utility_pole", { span, snapped: false, lean: 6 });
            expect(bounds(regionMesh(e.mesh, "wire"))!.max[0]).toBeCloseTo(span, 1);
        }
    });
    it("the ground's road is flat at its top height, and the dirt never dips under the floor", () => {
        const e = meshOf("street.wasteland_ground", { cracks: 0, potholes: 0, markings: false });
        expect(40 - ray(e.mesh, [0.3, 40, 7.3], [0, -1, 0])).toBeCloseTo(0.14, 2);
        expect(e.stats.bounds!.min[1]).toBeGreaterThan(-1e-6);
    });
});

describe("Mesha procedural scenes", () => {
    const def = lookupScene("scene.road_to_the_dome")!;
    it("are plain JSON with no definition problems", () => {
        for (const s of SCENES) {
            expect(JSON.parse(JSON.stringify(s))).toEqual(s);
            expect(validateScene(s, lookupObject)).toEqual([]);
        }
    });
    it("place only library objects, with valid values, inside the level, at the default and every preset", () => {
        for (const values of [{}, ...(def.presets ?? []).map(p => p.values)]) {
            const s = evaluateScene(def, values, lookupObject);
            expect(s.violations, JSON.stringify(values)).toEqual([]);
            expect(s.placements.length).toBeGreaterThan(30);
            expect(new Set(s.placements.map(p => p.key)).size).toBe(s.placements.length);
            const W = Number(s.params.width), L = Number(s.params.length);
            for (const p of s.placements) {
                const object = lookupObject(p.objectId)!;
                expect(object.component).toBeFalsy();
                expect(resolveParams(object, p.values)).toEqual(p.values);
                expect(Math.abs(p.position[0]), p.key).toBeLessThanOrEqual(W / 2 + 0.5);
                expect(Math.abs(p.position[2]), p.key).toBeLessThanOrEqual(L / 2 + 0.5);
            }
            expect(["ashen", "toxic", "night"]).toContain(s.lighting);
        }
    });
    it("is deterministic per seed, and a new seed rearranges it", () => {
        const a = evaluateScene(def, {}, lookupObject), b = evaluateScene(def, {}, lookupObject), c = evaluateScene(def, { seed: 7 }, lookupObject);
        expect(b).toEqual(a);
        const cars = (s: typeof a) => s.placements.filter(p => p.key.startsWith("wrecks:")).map(p => p.position);
        expect(cars(c)).not.toEqual(cars(a));
    });
    it("ends at a dome as many storeys tall as the scene asks, its gate facing the road", () => {
        for (const domeStoreys of [3, 5, 8]) {
            const s = evaluateScene(def, { domeStoreys }, lookupObject);
            const dome = s.placements.find(p => p.key === "dome")!;
            expect(dome.values.storeys).toBe(domeStoreys);
            expect(dome.rotationY).toBe(0);
            expect(dome.position[2]).toBeLessThan(-Number(s.params.length) / 4);
        }
    });
    it("decay reaches every piece: wheels, glass, panels, the road", () => {
        const at = (decay: number) => evaluateScene(def, { decay }, lookupObject).placements;
        const sum = (ps: ScenePlacement[], prefix: string, k: string) => ps.filter(p => p.key.startsWith(prefix)).reduce((n, p) => n + Number(p.values[k]), 0);
        expect(sum(at(0), "wrecks:", "missingWheels")).toBe(0);
        expect(sum(at(1), "wrecks:", "missingWheels")).toBeGreaterThan(4);
        expect(sum(at(1), "wrecks:", "brokenGlass")).toBeGreaterThan(sum(at(0), "wrecks:", "brokenGlass"));
        expect(sum(at(1), "ground", "potholes")).toBeGreaterThan(sum(at(0), "ground", "potholes"));
        expect(sum(at(1), "dome", "brokenPanes")).toBeGreaterThan(sum(at(0), "dome", "brokenPanes"));
    });
    it("nothing grows on the road or the plaza, and the outpost stands clear of it", () => {
        for (const values of [{}, { outpostSide: "right", seed: 9 }, { width: 46, length: 72, seed: 3 }]) {
            const s = evaluateScene(def, values, lookupObject);
            const verge = Number(s.params.roadWidth) / 2 + 2;
            for (const p of s.placements.filter(p => /^(trees|dryGrass|rocks):/.test(p.key))) expect(Math.abs(p.position[0]), p.key).toBeGreaterThan(verge);
            const depot = s.placements.find(p => p.key === "depot");
            if (depot) expect(Math.abs(depot.position[0]) - 6.6).toBeGreaterThan(verge);
        }
    });
    it("the checkpoint blocks the road but for one gap you can walk through", () => {
        const s = evaluateScene(def, {}, lookupObject);
        const cpZ = Number(s.params.length) / 2 - 20, gapX = Number(s.params.roadWidth) / 2 - 1.8;
        const blockers = world(s.placements, p => p.key !== "ground");
        expect(castRay(flatten(blockers), [gapX, 1.2, cpZ + 8], [0, 0, -1])).toBeGreaterThan(12);
        expect(castRay(flatten(blockers), [gapX - 4.5, 1.2, cpZ + 8], [0, 0, -1])).toBeLessThan(9);
    });
    it("regenerating keeps hand edits and objects the user added", () => {
        let n = 0;
        const newId = () => `i${n++}`;
        const first = mergeScene([], def.id, evaluateScene(def, {}, lookupObject).placements, lookupObject, newId);
        const mine: Instance = { id: "mine", objectId: "furniture.chair", values: {}, position: [1, 0, 1], rotationY: 0, scale: 1 };
        const car = first.instances.find(i => i.source?.key === "wrecks:0")!;
        const edited: Instance = { ...car, values: { ...car.values, bodyFinish: "paint.navy" }, position: [3, 0.14, 0], source: { ...car.source!, overrides: ["bodyFinish"], placed: true } };
        const before = [mine, ...first.instances.map(i => (i.id === car.id ? edited : i))];
        const next = evaluateScene(def, { decay: 1, cars: 4 }, lookupObject);
        const merged = mergeScene(before, def.id, next.placements, lookupObject, newId);
        const after = merged.instances.find(i => i.id === car.id)!;
        expect(after.values.bodyFinish).toBe("paint.navy");
        expect(after.position).toEqual([3, 0.14, 0]);
        expect(after.values.brokenGlass).toBe(next.placements.find(p => p.key === "wrecks:0")!.values.brokenGlass);
        expect(merged.instances.some(i => i.id === "mine")).toBe(true);
        expect(merged.removed.length).toBe(first.instances.filter(i => /^wrecks:[4-9]/.test(i.source!.key) || /^wrecks:1\d/.test(i.source!.key)).length);
        expect(merged.instances.length).toBe(next.placements.length + 1);
    });
    it("Variation finds another sensible scene and keeps locked settings", () => {
        const base = resolveParams(def, {});
        for (let seed = 1; seed < 6; seed++) {
            const r = vary(def, base, { amount: 0.8, seed, locked: ["domeStoreys", "group:level"] });
            expect(r.values.domeStoreys).toBe(base.domeStoreys);
            expect(r.values.length).toBe(base.length);
            expect(evaluateScene(def, r.values, lookupObject).placements.length).toBeGreaterThan(20);
        }
    });
});

describe("Mesha app: procedural scenes", () => {
    it("builds a scene from the library, shows its controls, keeps hand edits through regeneration, and undoes", async () => {
        const { vi } = await import("vitest");
        let init: any, update: any, serial = 0;
        const tools: Record<string, any> = {}, saved = new Map(), windows: Record<string, any> = {};
        const widgets: Record<string, any> = {};
        // Every widget is a recorder; containers run their contents.
        const W = new Proxy({}, { get: (_, name: string) => (...args: any[]) => {
            const config = args[1];
            if (config && typeof config === "object" && config.id) widgets[config.id] = config;
            if (["horizontal", "vertical"].includes(name)) args[1]();
            if (name === "card") args[2]();
            if (name === "collapsingHeader") args[2]();
        } });
        const api: any = {
            generateUUID: () => `u${++serial}`, println: () => {}, setGameMode: () => {},
            Addon: { register: () => ({ onInit: (f: any) => init = f, onUpdate: (f: any) => update = f, registerTool: (t: any, run: any) => tools[t.name] = run,
                Model: api.Model, Input: api.Input, Controls: api.Controls, UI: { createTab: () => "tab" },
                IO: { store: { read: (p: string) => saved.get(p), write: (p: string, s: string) => saved.set(p, s) } } }) },
            Input: { ...Object.fromEntries(["onMouseDown", "onMouseMove", "onMouseUp", "onKeyDown"].map(n => [n, () => {}])), isPointerOverUI: () => false },
            Model: { createMesh: () => {}, clearMesh: () => {} }, Buffer: { create: () => `b${++serial}`, write: () => {} },
            Pipeline: { create: () => "p" }, Lighting: { updateSun: () => {} },
            Camera: { getTransform: () => [[2, 2, 2], [0, 0, 0]], setTransform: () => {} }, Controls: { enable: () => {} }, Window: { getSize: () => [1500, 1000] },
            UI: { Widget: W, setTheme: () => {}, createWindow: (c: any) => { windows[c.title] = c.onRender; return c.title; }, keyboardState: () => ({ typing: false }) },
            Icons: { label: () => "", get: () => "" },
            Gizmo: { show: () => "g", hide: () => {}, updatePosition: () => {}, updateRotation: () => {}, getState: () => ({ isActive: false }) },
        };
        vi.stubGlobal("Entropy", api);
        vi.resetModules();
        try {
            await import("../src/apps/mesha/mesha_addon");
            init(); update();
            // The library lists the scene; Build places it.
            windows.Library();
            expect(widgets["mesha-build-scene.road_to_the_dome"]).toBeTruthy();
            widgets["mesha-build-scene.road_to_the_dome"].onClick();
            update(); update(); update();
            let state = tools.mesha_state({});
            expect(state.generator.sceneId).toBe("scene.road_to_the_dome");
            expect(state.instances.length).toBeGreaterThan(30);
            expect(state.lighting).toBe("ashen");
            expect(state.instances.some((i: any) => i.objectId === "architecture.rust_dome" && i.values.storeys === 5)).toBe(true);
            // Nothing selected: the properties panel is the scene's.
            windows.Properties();
            expect(widgets["mesha-s-decay"]).toBeTruthy();
            expect(widgets["mesha-scene-vary"]).toBeTruthy();
            // Edit one wreck by hand, then change the scene: the edit survives, the rest follow.
            const wreck = state.instances.find((i: any) => i.objectId === "transport.wreck_car");
            expect(tools.mesha_set({ instanceId: wreck.id, values: { bodyFinish: "paint.navy" } }).success).toBe(true);
            const r = tools.mesha_scene({ values: { decay: 1, domeStoreys: 7 } });
            expect(r.success).toBe(true);
            update();
            state = tools.mesha_state({});
            const after = state.instances.find((i: any) => i.id === wreck.id);
            expect(after.values.bodyFinish).toBe("paint.navy");
            expect(state.instances.find((i: any) => i.objectId === "architecture.rust_dome").values.storeys).toBe(7);
            // A scene slider regenerates when released.
            windows.Properties();
            widgets["mesha-s-cars"].onChange(2);
            update();
            expect(tools.mesha_state({}).instances.filter((i: any) => i.objectId === "transport.wreck_car").length).toBe(2 + 1); // and the first overturned wreck
            tools.mesha_undo({}); update();
            expect(tools.mesha_state({}).instances.filter((i: any) => i.objectId === "transport.wreck_car").length).toBe(state.instances.filter((i: any) => i.objectId === "transport.wreck_car").length);
            expect(tools.mesha_scenes({}).scenes.map((s: any) => s.id)).toContain("scene.road_to_the_dome");
            expect(JSON.parse(saved.get("session.json")).scene.generator.values.domeStoreys).toBe(7);
        } finally { vi.unstubAllGlobals(); }
    }, 120_000);
});
