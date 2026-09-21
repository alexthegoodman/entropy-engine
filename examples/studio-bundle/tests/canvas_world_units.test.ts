import { describe, expect, it } from "vitest";
import { LogicSession, logicNode, logicProblems, validateLogic } from "../src/apps/canvas_surfaces/canvas_logic";
import type { LogicGraph, LogicNode } from "../src/apps/canvas_surfaces/canvas_logic";
import { appendRule, compileRule } from "../src/apps/canvas_surfaces/canvas_logic_rules";
import { LIGHTING_PRESETS, LIGHTING_FLOATS, defaultLighting, mergeLighting, packLighting, validateLighting } from "../src/apps/canvas_surfaces/canvas_lighting";
import { PREFAB_IDS, buildPrefab, parseColor } from "../src/apps/canvas_surfaces/canvas_prefabs";
import { cameraRelative, distanceToRect, followCamera, stepPlayer } from "../src/apps/canvas_surfaces/canvas_walk";
import { fillBytes, uniformFill, validateScene } from "../src/apps/canvas_surfaces/canvas_scene_format";

// Pure behaviour of the modules the Canvas Surfaces world tools are built from. The tool-level
// behaviour is in tests/features/canvas_world.feature.

let serial = 0;
const id = () => `n${serial++}`;
const wire = (a: LogicNode, b: LogicNode) => ({ fromNode: a.id, fromPin: "next", toNode: b.id, toPin: "in" });

describe("logic session: counters, proximity and interaction", () => {
    const graph = (): { g: LogicGraph; effects: string[]; session: LogicSession; near: LogicNode } => {
        const near = { ...logicNode("near", "near", [0, 0]), target: "herb", amount: 1 };
        const add = { ...logicNode("add", "add", [0, 0]), variable: "herbs", amount: 2 };
        const hide = { ...logicNode("hide", "hide", [0, 0]), target: "herb" };
        const say = { ...logicNode("say", "message", [0, 0]), text: "herbs {herbs}" };
        const g: LogicGraph = { nodes: [near, add, hide, say], connections: [wire(near, add), wire(add, hide), wire(hide, say)] };
        const effects: string[] = [];
        const session: LogicSession = new LogicSession(g, n => effects.push(n.kind === "message" ? session.format(n.text) : `${n.kind}:${n.target}`));
        return { g, effects, session, near };
    };
    it("fires near once per entry and re-arms only after the player leaves", () => {
        const { session, effects } = graph();
        session.start();
        let distance: number | null = 5;
        const at = () => distance;
        session.proximity(at);
        expect(effects).toEqual([]);
        distance = 0.5; session.proximity(at); session.proximity(at);
        expect(effects).toEqual(["hide:herb", "herbs 2"]);
        distance = 3; session.proximity(at);
        distance = 0.5; session.proximity(at);
        expect(session.vars.get("herbs")).toBe(4);
    });
    it("never fires for a target that is hidden", () => {
        const { session, effects } = graph();
        session.start();
        session.proximity(() => null);
        expect(effects).toEqual([]);
    });
    it("check passes only on the right side of its limit, in both directions", () => {
        const click = logicNode("click", "click", [0, 0]); click.target = "x";
        const atLeast = { ...logicNode("ge", "check", [0, 0]), variable: "n", amount: 2, op: ">=" as const };
        const below = { ...logicNode("lt", "check", [0, 0]), variable: "n", amount: 2, op: "<" as const };
        const a = { ...logicNode("a", "message", [0, 0]), text: "enough" }, b = { ...logicNode("b", "message", [0, 0]), text: "not yet" };
        const inc = { ...logicNode("inc", "add", [0, 0]), variable: "n", amount: 1 };
        const g: LogicGraph = { nodes: [click, atLeast, below, a, b, inc], connections: [wire(click, atLeast), wire(atLeast, a), wire(click, below), wire(below, b), wire(click, inc)] };
        const seen: string[] = [];
        const s = new LogicSession(g, n => seen.push(n.text));
        s.start();
        s.click("x"); s.click("x"); s.click("x");
        // First click: 0 < 2 says "not yet" (inc runs after both checks were queued). Second: 1 < 2. Third: 2 >= 2.
        expect(seen).toEqual(["not yet", "not yet", "enough"]);
    });
    it("interact lists what is in range nearest first and runs only those", () => {
        const far = { ...logicNode("far", "interact", [0, 0]), target: "far", amount: 2 };
        const close = { ...logicNode("close", "interact", [0, 0]), target: "close", amount: 2, text: "Talk" };
        const m1 = { ...logicNode("m1", "message", [0, 0]), text: "far" }, m2 = { ...logicNode("m2", "message", [0, 0]), text: "close" };
        const seen: string[] = [];
        const s = new LogicSession({ nodes: [far, close, m1, m2], connections: [wire(far, m1), wire(close, m2)] }, n => seen.push(n.text));
        s.start();
        const d = (t: string) => t === "far" ? 9 : 1;
        expect(s.interactables(d).map(i => i.node.text)).toEqual(["Talk"]);
        s.interact(d);
        expect(seen).toEqual(["close"]);
    });
    it("resets counters on stop and prints unknown counters as 0", () => {
        const { session } = graph();
        session.start();
        session.proximity(() => 0);
        expect(session.vars.get("herbs")).toBe(2);
        session.stop();
        expect(session.vars.size).toBe(0);
        expect(session.format("{missing} and {herbs}")).toBe("0 and 0");
    });
    it("click matches a target or any group above it", () => {
        const c = { ...logicNode("c", "click", [0, 0]), target: "house" }, m = { ...logicNode("m", "message", [0, 0]), text: "hi" };
        const seen: string[] = [];
        const s = new LogicSession({ nodes: [c, m], connections: [wire(c, m)] }, n => seen.push(n.text));
        s.start(); s.click(["door", "house"]); s.click("door");
        expect(seen).toEqual(["hi"]);
    });
    it("validates the new fields and reports incomplete nodes", () => {
        const bad = { nodes: [{ ...logicNode("a", "check", [0, 0]), op: "!=" }], connections: [] };
        expect(() => validateLogic(bad)).toThrow("Invalid logic node");
        expect(() => validateLogic({ nodes: [{ ...logicNode("a", "add", [0, 0]), amount: Infinity }], connections: [] })).toThrow();
        const g: LogicGraph = { nodes: [logicNode("h", "hide", [0, 0]), { ...logicNode("a", "add", [0, 0]), variable: " " }, logicNode("n", "near", [0, 0])], connections: [] };
        expect(logicProblems(g, ["s"], [])).toEqual(["Choose a surface for Hide surface.", "Name the counter for Change counter.", "Choose a surface for When player is near."]);
        // A graph saved before counters existed has none of the new fields and is still valid.
        const old: LogicGraph = { nodes: [{ id: "x", kind: "message", position: [0, 0], target: "", text: "hi", seconds: 1 }], connections: [] };
        expect(() => validateLogic(old)).not.toThrow();
    });
    it("rejects events as wire destinations and loops", () => {
        const near = logicNode("near", "near", [0, 0]), say = logicNode("say", "message", [0, 0]);
        expect(() => validateLogic({ nodes: [near, say], connections: [wire(say, near)] })).toThrow("Invalid logic connection");
    });
});

describe("rules compile to valid graphs", () => {
    const base = { when: { type: "interact" as const, target: "elder", distance: 2, prompt: "Talk" }, conditions: [{ counter: "herbs", atLeast: 3 }], then: [{ do: "message" as const, text: "ok" }, { do: "hide" as const, target: "gate" }], otherwise: [{ do: "message" as const, text: "no" }] };
    it("builds trigger, checks, once and both branches", () => {
        const g = compileRule({ ...base, once: true }, id, 0);
        expect(g.nodes.map(n => n.kind)).toEqual(["interact", "check", "once", "message", "hide", "check", "message"]);
        expect(g.nodes.find(n => n.kind === "interact")).toMatchObject({ target: "elder", amount: 2, text: "Talk" });
        const checks = g.nodes.filter(n => n.kind === "check");
        expect(checks.map(c => c.op)).toEqual([">=", "<"]);
        expect(() => validateLogic(g)).not.toThrow();
    });
    it("stacks rules on new rows without overlapping", () => {
        let g: LogicGraph = { nodes: [], connections: [] };
        g = appendRule(g, base, id); g = appendRule(g, base, id);
        const rows = new Set(g.nodes.filter(n => n.kind === "interact").map(n => n.position[1]));
        expect(rows.size).toBe(2);
    });
    it("refuses an otherwise without exactly one condition and a trigger without a target", () => {
        expect(() => compileRule({ ...base, conditions: [] }, id, 0)).toThrow("exactly one condition");
        expect(() => compileRule({ when: { type: "near" }, then: [] }, id, 0)).toThrow("needs a target");
    });
    it("leaves the graph untouched when the result is invalid", () => {
        const g: LogicGraph = { nodes: Array.from({ length: 127 }, (_, i) => logicNode(`f${i}`, "wait", [0, i])), connections: [] };
        expect(() => appendRule(g, base, id)).toThrow();
        expect(g.nodes).toHaveLength(127);
    });
});

describe("walking", () => {
    const wall = { minX: 2, maxX: 2.2, minZ: -50, maxZ: 50 };
    it("slides along a wall instead of stopping", () => {
        let pos: [number, number] = [0, 0];
        for (let i = 0; i < 60; i++) pos = stepPlayer(pos, [1, 1], 1 / 30, [wall], 40).pos;
        expect(pos[0]).toBeLessThan(2 - 0.35 + 1e-6);
        expect(pos[1]).toBeGreaterThan(3);
    });
    it("cannot tunnel through a thin wall on a very slow frame", () => {
        expect(stepPlayer([1.5, 0], [1, 0], 0.5, [wall], 40).pos[0]).toBeLessThan(2 - 0.35 + 1e-6);
    });
    it("lets a player who starts inside a solid walk out of it", () => {
        const rock = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
        let pos: [number, number] = [0, 0];
        for (let i = 0; i < 90; i++) pos = stepPlayer(pos, [1, 0], 1 / 30, [rock], 40).pos;
        expect(pos[0]).toBeGreaterThan(3);
        // Once out, the rock blocks again.
        expect(stepPlayer([1.5, 0], [-1, 0], 0.5, [rock], 40).pos[0]).toBeGreaterThanOrEqual(1.35 - 1e-6);
    });
    it("stays inside the bounds and reports no movement when fully blocked", () => {
        expect(stepPlayer([9.9, 0], [1, 0], 1, [], 10).pos[0]).toBe(10);
        expect(stepPlayer([10, 0], [1, 0], 1, [], 10).moved).toBe(false);
    });
    it("moves at the same speed in every direction", () => {
        const a = stepPlayer([0, 0], [1, 0], 1, [], 100).pos, b = stepPlayer([0, 0], [1, 1], 1, [], 100).pos;
        expect(Math.hypot(...a)).toBeCloseTo(Math.hypot(...b), 6);
    });
    it("measures distance to a rectangle from its nearest edge, 0 inside", () => {
        expect(distanceToRect(0, 0, { minX: 3, maxX: 5, minZ: -1, maxZ: 1 })).toBe(3);
        expect(distanceToRect(4, 0, { minX: 3, maxX: 5, minZ: -1, maxZ: 1 })).toBe(0);
    });
    it("turns W into away from the camera and D into its right", () => {
        const [fx, fz] = cameraRelative([0, 1], 0), [rx, rz] = cameraRelative([1, 0], 0);
        expect(fx).toBeCloseTo(0); expect(fz).toBeCloseTo(-1); expect(rx).toBeCloseTo(1); expect(rz).toBeCloseTo(0);
        const turned = cameraRelative([0, 1], Math.PI / 2);
        expect(turned[0]).toBeCloseTo(-1);
    });
    it("places the camera behind the player at the chosen yaw", () => {
        const view = followCamera([2, 1, 3], 0, 0.5, 10);
        expect(view.position[0]).toBeCloseTo(2); expect(view.position[2]).toBeGreaterThan(3); expect(view.position[1]).toBeGreaterThan(1);
    });
});

describe("lighting", () => {
    it("packs every preset into the buffer layout the shader reads", () => {
        for (const [name, preset] of Object.entries(LIGHTING_PRESETS)) {
            const packed = packLighting(preset);
            expect(packed.length, name).toBe(LIGHTING_FLOATS);
            expect(Math.hypot(packed[4], packed[5], packed[6]), name).toBeCloseTo(1, 5);
            expect(packed[11]).toBeCloseTo(preset.sunIntensity, 5);
        }
    });
    it("the editor preset reproduces the original two lamps", () => {
        const packed = packLighting(defaultLighting());
        expect([...packed.slice(24, 28)]).toEqual([4, 5, 3, 1]);
        expect([...packed.slice(40, 44)].map(n => Math.round(n * 100) / 100)).toEqual([1, 0.96, 0.88, 1.1]);
        expect(packed[3 + 40 + 4]).toBeCloseTo(0.7, 5);
        expect(packed[20 + 3]).toBe(0);
    });
    it("merges overrides without touching the base and rejects bad values by field name", () => {
        const base = defaultLighting();
        const next = mergeLighting(base, { sunIntensity: 2, lamps: [{ position: [1, 2, 3] }] });
        expect(base.sunIntensity).toBe(0);
        expect(next.lamps).toEqual([{ position: [1, 2, 3], color: [1, 0.85, 0.6], intensity: 1, reach: 1 }]);
        expect(() => mergeLighting(base, { ambient: [0, 0] })).toThrow("ambient");
        expect(() => mergeLighting(base, { fogDensity: 3 })).toThrow("fogDensity");
        expect(() => mergeLighting(base, { sunDirection: [0, 0, 0] })).toThrow("must not be zero");
        expect(() => validateLighting(null)).toThrow();
    });
});

describe("prefabs", () => {
    it("every prefab builds valid parts a scene file will accept", () => {
        for (const prefab of PREFAB_IDS) {
            const { parts, footprint } = buildPrefab(prefab, {});
            expect(parts.length, prefab).toBeGreaterThan(0);
            expect(footprint, prefab).toBeGreaterThan(0);
            for (const p of parts) {
                for (const n of [p.halfW ?? 1, p.halfH ?? 1, p.halfD ?? 1, p.radius ?? 1]) expect(n, `${prefab} ${p.name}`).toBeGreaterThanOrEqual(0.01);
                expect(p.position.every(Number.isFinite), `${prefab} ${p.name}`).toBe(true);
                expect(p.color.every(c => c >= 0 && c <= 255)).toBe(true);
            }
        }
    });
    it("a house has a roof that meets at the ridge, a gable at each end and a door on the front", () => {
        const { parts } = buildPrefab("house", { width: 6, depth: 4, wallHeight: 3, roofHeight: 2 });
        const roofR = parts.find(p => p.name === "Roof R")!, roofL = parts.find(p => p.name === "Roof L")!;
        expect(roofR.position[0]).toBeCloseTo(-roofL.position[0], 6);
        expect(roofR.roll).toBeCloseTo(-roofL.roll!, 6);
        // The slab's upper end sits at the ridge (x = 0) at wall height plus roof height, give or take its thickness.
        const along = [Math.cos(roofR.roll!), Math.sin(roofR.roll!)], half = roofR.halfW!;
        const topEnd = [roofR.position[0] - along[0] * half, roofR.position[1] - along[1] * half];
        expect(Math.abs(topEnd[0])).toBeLessThan(0.2);
        expect(topEnd[1]).toBeGreaterThan(4.9); expect(topEnd[1]).toBeLessThan(5.3);
        expect(parts.filter(p => p.mask === "gable")).toHaveLength(2);
        expect(parts.find(p => p.name === "Door")!.position[2]).toBeGreaterThan(2);
    });
    it("takes parameters, rejects bad ones and names the valid prefabs", () => {
        expect(buildPrefab("tree", { height: 6 }).parts[0].halfH).toBeGreaterThan(buildPrefab("tree", {}).parts[0].halfH!);
        expect(() => buildPrefab("tree", { height: -1 })).toThrow("height must be a number");
        expect(() => buildPrefab("castle")).toThrow("Available: house");
        expect(() => buildPrefab("pickup", { shape: "cone" })).toThrow("shape must be");
    });
    it("parses colours from arrays and hex", () => {
        expect(parseColor("#ff8000", [0, 0, 0])).toEqual([255, 128, 0]);
        expect(parseColor([1.4, 2, 3], [0, 0, 0])).toEqual([1, 2, 3]);
        expect(parseColor(undefined, [9, 9, 9])).toEqual([9, 9, 9]);
        expect(() => parseColor([300, 0, 0], [0, 0, 0])).toThrow("must be [r, g, b]");
        expect(() => parseColor("red", [0, 0, 0])).toThrow();
    });
});

describe("scene fills", () => {
    it("recognises a flat canvas and rebuilds it byte for byte", () => {
        const flat = fillBytes([10, 20, 30, 255]);
        expect(uniformFill(flat)).toEqual([10, 20, 30, 255]);
        expect(Buffer.from(fillBytes([10, 20, 30, 255])).equals(Buffer.from(flat))).toBe(true);
        const painted = flat.slice(); painted[4 * 1000 + 2] = 99;
        expect(uniformFill(painted)).toBeNull();
        expect(uniformFill(new Uint8Array(3))).toBeNull();
    });
    it("handles a canvas that does not start on a 4-byte boundary", () => {
        const backing = new Uint8Array(4 * 16 + 1);
        for (let i = 1; i < backing.length; i += 4) backing.set([5, 6, 7, 8], i);
        expect(uniformFill(backing.subarray(1))).toEqual([5, 6, 7, 8]);
        backing[20] = 0;
        expect(uniformFill(backing.subarray(1))).toBeNull();
    });
    it("validates fills, solid and world, and rejects malformed ones", () => {
        const surface = (extra: object = {}) => ({ name: "s", kind: "box", position: [0, 0, 0], yaw: 0, pitch: 0, roll: 0, halfW: 0.05, halfH: 0.05, halfD: 0.05, radius: 1, bend: 0, bendAxis: "y", visible: true, cutMaskFill: 255, activeLayerId: "l", layers: [{ id: "l", name: "Ink", visible: true, locked: false, opacity: 1, pixelsFill: [1, 2, 3, 255] }], ...extra });
        const scene = (s: object, world?: object) => ({ version: 2, surfaces: [s], ...(world ? { world } : {}) });
        expect(() => validateScene(scene(surface({ solid: true })))).not.toThrow();
        expect(() => validateScene(scene(surface({ solid: "yes" })))).toThrow("Invalid surface geometry");
        expect(() => validateScene(scene(surface({ layers: [{ id: "l", name: "Ink", visible: true, locked: false, opacity: 1, pixelsFill: [1, 2, 3, 999] }] })))).toThrow("Invalid scene image data");
        expect(() => validateScene(scene(surface({ cutMaskFill: -1 })))).toThrow("Invalid scene image data");
        expect(() => validateScene(scene(surface(), { player: null, bounds: 40, lighting: defaultLighting() }))).not.toThrow();
        expect(() => validateScene(scene(surface(), { player: 4, bounds: 40, lighting: defaultLighting() }))).toThrow("Invalid world");
        expect(() => validateScene(scene(surface(), { player: null, bounds: 40, lighting: { ambient: [9, 9, 9] } }))).toThrow("ambient");
    });
    it("stores a hundred unpainted surfaces in a fraction of a megabyte", () => {
        const layer = (i: number) => ({ id: `l${i}`, name: "Ink", visible: true, locked: false, opacity: 1, pixelsFill: [10, 20, 30, 255] });
        const scene = { version: 2, surfaces: Array.from({ length: 100 }, (_, i) => ({ name: `s${i}`, kind: "plane", position: [0, 0, 0], yaw: 0, pitch: 0, roll: 0, halfW: 1, halfH: 1, halfD: 1, radius: 1, bend: 0, bendAxis: "y", visible: true, cutMaskFill: 255, activeLayerId: `l${i}`, layers: [layer(i)] })) };
        expect(() => validateScene(scene)).not.toThrow();
        expect(JSON.stringify(scene).length).toBeLessThan(60_000);
    });
});
