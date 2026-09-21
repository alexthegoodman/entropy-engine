import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const level = JSON.parse(readFileSync(new URL("../levels/mossbridge.json", import.meta.url), "utf8")) as { calls: { tool: string; args: Record<string, unknown> }[]; playtests: Record<string, Record<string, unknown>[]> };
import { CANVAS_TOOLS, CANVAS_TOOL_NAMES } from "../src/apps/canvas_surfaces/canvas_tool_schemas";

// Executable Gherkin subset, same rules as canvas_animation_bdd: an unknown line or step fails loudly.
const scenarios: { name: string; steps: string[] }[] = [];
for (const raw of readFileSync(new URL("../../../tests/features/canvas_world.feature", import.meta.url), "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("Feature:")) continue;
    if (line.startsWith("Scenario:")) { scenarios.push({ name: line.slice(9).trim(), steps: [] }); continue; }
    const step = /^(Given|When|Then|And|But) (.+)$/.exec(line);
    if (!step || !scenarios.length) throw new Error(`Unsupported Gherkin: ${line}`);
    scenarios.at(-1)!.steps.push(step[2]);
}

type Result = Record<string, any>;

describe("Canvas Surfaces MCP world building through the production addon", () => {
    let tools: Map<string, { definition: any; callback: (args: any) => Result }>;
    let init: () => void;
    let update: (time?: number) => void;
    let textures: Map<string, Uint8Array>;
    let meshes: Map<string, any>;
    let buffers: Map<string, Float32Array>;
    let savedIndex: any;
    let savedData: Map<string, any>;
    let listeners: Record<string, ((...args: any[]) => void)[]>;
    let keys: Set<string>;
    let setTransform: ReturnType<typeof vi.fn>;
    let clock: number;
    let last: Result;
    let before: Result;
    const emit = (name: string, ...args: any[]) => listeners[name]?.forEach(fn => fn(...args));
    const frame = () => { clock += 1 / 30; update(clock); };

    const call = (name: string, args: Record<string, unknown> = {}): Result => {
        const tool = tools.get(name);
        expect(tool, `tool ${name}`).toBeDefined();
        last = tool!.callback(structuredClone(args));
        frame();
        return last;
    };
    const ok = (name: string, args: Record<string, unknown> = {}): Result => {
        const result = call(name, args);
        expect(result.success, `${name} ${JSON.stringify(args)}: ${result.error}`).toBe(true);
        return result;
    };
    const scene = (): Result => tools.get("canvas_get_scene")!.callback({});
    const surfaceNamed = (name: string): Result => { const s = scene().surfaces.find((s: Result) => s.name === name); expect(s, `surface ${name}`).toBeDefined(); return s; };
    const pixels = (name: string): Uint8Array => {
        const mesh = meshes.get(surfaceNamed(name).id);
        expect(mesh, `mesh for ${name}`).toBeDefined();
        return textures.get(mesh.bindings[0].resource.value.id)!;
    };
    const pixel = (px: Uint8Array, x: number, y: number): number[] => [...px.slice((y * 768 + x) * 4, (y * 768 + x) * 4 + 4)];
    const lightingBuffer = (): Float32Array => [...buffers.values()].find(b => b.length === 56)!;
    const lampsLit = (): number => [0, 1, 2, 3].filter(i => lightingBuffer()[24 + 16 + i * 4 + 3] > 0).length;
    const field = (object: Result, path: string): unknown => path.split(".").reduce((v: any, k) => v?.[k], object);
    const groupNamed = (name: string): Result => scene().groups.find((g: Result) => g.name === name);
    const surfacesOf = (group: string): Result[] => scene().surfaces.filter((s: Result) => s.parent === group);

    const emptyScene = () => ok("canvas_new_scene", { confirmDiscard: true });
    const village = () => {
        emptyScene();
        ok("canvas_set_lighting", { preset: "day" });
        ok("canvas_add_prefab", { prefab: "ground", position: [0, 0], name: "Ground", params: { width: 60, depth: 60 } });
        ok("canvas_add_prefab", { prefab: "human", position: [0, 0], name: "Hero", params: { shirtColor: [200, 60, 60] } });
        ok("canvas_set_world", { player: "Hero" });
        for (const [name, x, z] of [["Herb A", 5, 0], ["Herb B", 8, -3], ["Herb C", -2, 6]] as const) {
            ok("canvas_add_prefab", { prefab: "pickup", position: [x, z], name });
            ok("canvas_add_collectible", { target: name, counter: "herbs", message: "Herb collected: {herbs} of 3." });
        }
        ok("canvas_add_prefab", { prefab: "human", position: [-6, 0], name: "Elder", params: { shirtColor: [120, 80, 160] } });
        ok("canvas_add_prefab", { prefab: "gate", position: [0, -8], name: "Gate" });
        ok("canvas_add_prefab", { prefab: "house", position: [10, 8], name: "Cottage" });
        ok("canvas_add_rule", {
            when: { type: "interact", target: "Elder", distance: 2, prompt: "Talk" }, once: true,
            conditions: [{ counter: "herbs", atLeast: 3 }],
            then: [{ do: "message", text: "Thank you! The gate is open." }, { do: "hide", target: "Gate" }],
            otherwise: [{ do: "message", text: "You have {herbs} of 3 herbs." }],
        });
    };
    const questSteps = [
        { walkTo: "Elder" }, { interact: true },
        { walkTo: "Herb A" }, { walkTo: "Herb B" }, { walkTo: "Herb C" },
        { walkTo: "Elder" }, { interact: true },
        { expect: { counters: { herbs: 3 }, message: "gate is open", shown: { Gate: false } } },
    ];
    const snapshot = () => { const s = scene(); return JSON.stringify([s.surfaces, s.groups, s.world.player]); };
    const holdKey = (key: string, seconds: number) => { keys.add(key); for (let i = 0; i < Math.round(seconds * 30); i++) frame(); keys.delete(key); };
    const savedScene = () => savedData.get(savedIndex.scenes[0].key);
    const plural = (n: string) => Number(n);

    const steps: [RegExp, (...m: string[]) => void][] = [
        [/^an empty scene$/, emptyScene],
        [/^the village quest world$/, village],
        [/^the Mossbridge level built from its script$/, () => { for (const { tool, args } of level.calls) ok(tool, args); }],
        [/^the level fits the budget$/, () => { const stats = tools.get("canvas_world_stats")!.callback({}); expect([stats.surfaces, stats.groups, stats.logicNodes, stats.logicWires, stats.clips], JSON.stringify(stats)).toEqual([70, 32, 60, 47, 1]); expect(stats.estimatedSaveMB, JSON.stringify(stats)).toBeLessThan(6); expect(stats.estimatedMemoryMB, JSON.stringify(stats)).toBeLessThan(400); }],
        [/^I playtest the Mossbridge quest$/, () => { before = { snapshot: snapshot() }; call("canvas_playtest", { steps: level.playtests.quest }); }],
        [/^I playtest the Mossbridge "([a-z_]+)" check$/, name => { expect(level.playtests[name], name).toBeDefined(); before = { snapshot: snapshot() }; call("canvas_playtest", { steps: level.playtests[name] }); }],
        [/^I place every prefab$/, () => {
            const ids: string[] = tools.get("canvas_list_prefabs")!.callback({}).prefabs.map((p: Result) => p.id);
            ids.forEach((id, i) => ok("canvas_add_prefab", { prefab: id, position: [i * 6, 0], ...(id === "pickup" ? { params: { shape: "coin" } } : {}) }));
        }],
        [/^I call "([a-z_]+)"(?: with (.+))?$/, (name, json) => { call(name, json ? JSON.parse(json) : {}); }],
        [/^the call succeeds$/, () => expect(last.success, last.error).toBe(true)],
        [/^the call fails mentioning "(.+)"$/, text => { expect(last.success, JSON.stringify(last)).toBe(false); expect(last.error).toContain(text); }],
        [/^the result field "(.+)" equals (.+)$/, (path, json) => expect(field(last, path)).toEqual(JSON.parse(json))],
        [/^the result lists (\d+) prefabs$/, n => expect(last.prefabs).toHaveLength(plural(n))],
        [/^the scene has (\d+) surfaces? and (\d+) groups?$/, (s, g) => { const sc = scene(); expect([sc.surfaces.length, sc.groups.length]).toEqual([plural(s), plural(g)]); }],
        [/^every tool in the schema file is registered with a handler$/, () => { expect([...tools.keys()].sort()).toEqual([...CANVAS_TOOL_NAMES].sort()); }],
        [/^every tool has a description that says what it returns or does$/, () => { for (const [name, tool] of tools) { expect(tool.definition.description.length, name).toBeGreaterThan(40); expect(tool.definition.parameters.type, name).toBe("object"); } }],
        [/^every required argument is declared as a property$/, () => { for (const name of CANVAS_TOOL_NAMES) { const p = CANVAS_TOOLS[name].parameters; for (const key of p.required ?? []) expect(Object.keys(p.properties), `${name}.${key}`).toContain(key); } }],
        [/^no tool text contains a long dash$/, () => { expect(JSON.stringify([...tools.values()].map(t => t.definition))).not.toMatch(/[–—]/); }],
        [/^"(.+)" is solid and "(.+)" is not$/, (a, b) => { expect(surfaceNamed(a).solid).toBe(true); expect(surfaceNamed(b).solid).toBe(false); }],
        [/^"(.+)" has a triangular cut$/, name => { const px = pixel(pixels(name), 0, 0); const inside = pixel(pixels(name), 384, 700); expect(px[3]).toBeLessThan(128); expect(inside[3]).toBe(255); }],
        [/^every surface of "(.+)" is one flat colour$/, group => {
            const parts = surfacesOf(scene().groups.find((g: Result) => g.name === group)!.name);
            expect(parts.length).toBeGreaterThan(0);
            for (const part of parts) { const px = pixels(part.name); expect(pixel(px, 384, 600).slice(0, 3), part.name).toEqual(pixel(px, 380, 700).slice(0, 3)); }
        }],
        [/^a group named "(.+)" exists$/, name => expect(groupNamed(name), name).toBeDefined()],
        [/^"(.+)" is painted with (\d+) (\d+) (\d+)$/, (name, r, g, b) => expect(pixel(pixels(name), 300, 300).slice(0, 3)).toEqual([Number(r), Number(g), Number(b)])],
        [/^"(.+)" is at (\S+) (\S+) (\S+) and is solid$/, (name, x, y, z) => { const s = surfaceNamed(name); expect(s.position).toEqual([Number(x), Number(y), Number(z)]); expect(s.solid).toBe(true); }],
        [/^I draw a stroke on "(.+)"$/, () => { emit("onMouseDown", 0, -0.6, 1.5); emit("onMouseMove", 0.6, 1.5); emit("onMouseUp", 0); frame(); expect(scene().surfaces[0].strokes).toBeGreaterThan(0); }],
        [/^the lighting buffer holds the night ambient colour$/, () => { const b = lightingBuffer(); expect([b[0], b[1], b[2]].map(n => Math.round(n * 100) / 100)).toEqual([0.1, 0.12, 0.2]); }],
        [/^the lighting buffer holds (\d+) lit lamps?$/, n => expect(lampsLit()).toBe(plural(n))],
        [/^the logic has no problems$/, () => { const logic = tools.get("canvas_get_logic")!.callback({}); expect(logic.problems, JSON.stringify(logic.problems)).toEqual([]); }],
        [/^I playtest the quest$/, () => { before = { snapshot: snapshot() }; call("canvas_playtest", { steps: questSteps }); }],
        [/^the playtest passed$/, () => { expect(last.success, last.error).toBe(true); expect(last.passed, JSON.stringify(last.failures)).toBe(true); }],
        [/^the playtest failed mentioning "(.+)"$/, text => { expect(last.success, last.error).toBe(true); expect(last.passed).toBe(false); expect(last.failures.join(" | ")).toContain(text); }],
        [/^the messages include "(.+)"$/, text => expect(last.messages).toContain(text)],
        [/^the counter "(.+)" is (\d+)$/, (name, n) => expect(last.counters[name]).toBe(plural(n))],
        [/^the playtest left the scene exactly as it was$/, () => { if (!before) before = { snapshot: snapshot() }; expect(snapshot()).toBe(before.snapshot); }],
        [/^the play state says walking$/, () => { const s = tools.get("canvas_get_play_state")!.callback({}); expect(s.playing).toBe(true); expect(s.walking).toBe(true); }],
        [/^the play state says not playing$/, () => expect(tools.get("canvas_get_play_state")!.callback({}).playing).toBe(false)],
        [/^the play state counter "(.+)" is (\d+)$/, (name, n) => expect(tools.get("canvas_get_play_state")!.callback({}).counters[name]).toBe(plural(n))],
        [/^I hold the key "(.)" for (\d+) seconds?$/, (key, seconds) => holdKey(key, Number(seconds))],
        [/^the editing grid is hidden$/, () => expect(meshes.has("canvas_surfaces_ground_grid")).toBe(false)],
        [/^the editing grid is back$/, () => expect(meshes.has("canvas_surfaces_ground_grid")).toBe(true)],
        [/^the player has moved right of the start$/, () => expect(groupNamed("Hero").position[0]).toBeGreaterThan(3)],
        [/^the camera follows the player$/, () => { const [, target] = setTransform.mock.calls.at(-1)!; expect(target[0]).toBeCloseTo(groupNamed("Hero").position[0], 1); }],
        [/^the player is back at the start$/, () => expect(groupNamed("Hero").position).toEqual([0, 0, 0])],
        [/^"(.+)" is hidden$/, name => expect(surfacesOf(name).every(s => !s.visible), name).toBe(true)],
        [/^"(.+)" is shown$/, name => expect(surfacesOf(name).every(s => s.visible), name).toBe(true)],
        [/^the saved scene stores flat surfaces as colours, not pixels$/, () => {
            const layers = savedScene().surfaces.flatMap((s: Result) => s.layers);
            expect(layers.length).toBeGreaterThan(10);
            expect(layers.every((l: Result) => Array.isArray(l.pixelsFill) && l.pixelsBase64 === undefined)).toBe(true);
        }],
        [/^the saved scene is under (\d+) megabytes$/, n => expect(JSON.stringify(savedScene()).length).toBeLessThan(Number(n) * 1024 * 1024)],
        [/^the scene has the village again$/, () => { const s = scene(); expect([s.surfaces.length, s.groups.length]).toEqual([19, 8]); expect(s.logic.nodes).toBeGreaterThan(10); }],
        [/^the player is "(.+)"$/, name => expect(scene().world.player.name).toBe(name)],
        [/^the lighting is the day preset$/, () => expect(scene().world.lighting.sunIntensity).toBeCloseTo(0.95, 5)],
        [/^the estimated save size is under (\d+) megabytes$/, n => expect(last.estimatedSaveMB).toBeLessThan(Number(n))],
    ];

    beforeEach(async () => {
        vi.resetModules();
        tools = new Map(); textures = new Map(); meshes = new Map(); buffers = new Map(); listeners = {}; keys = new Set();
        savedIndex = null; savedData = new Map(); clock = 0; last = {}; before = undefined as unknown as Result;
        setTransform = vi.fn();
        let serial = 0;
        const windows: (() => void)[] = [];
        const noop = () => {};
        const widget = new Proxy({}, { get: (_t, name: string) => name === "horizontal" || name === "group" ? (id: string, fn: (id: string) => void) => fn(id) : name === "collapsingHeader" ? (id: string, _t: string, fn: (id: string) => void) => fn(id) : noop });
        vi.stubGlobal("Entropy", {
            AddonAtom: { register: () => ({
                registerTool: (definition: any, callback: (args: any) => Result) => { tools.set(definition.name, { definition, callback }); },
                onInit: (fn: () => void) => { init = fn; }, onUpdatePlus: (_name: string, fn: (time?: number) => void) => { update = fn; },
                IO: { save: (data: any) => { savedIndex = structuredClone(data); }, load: () => savedIndex },
                GameState: { save: (key: string, value: any) => savedData.set(key, structuredClone(value)), load: (key: string) => savedData.get(key) ?? null },
            }) },
            Input: new Proxy({}, { get: (_t, name: string) => name === "isPointerOverUI" ? () => false : name === "isKeyPressed" ? (key: string) => keys.has(key) : (fn: (...args: any[]) => void) => { (listeners[name] ??= []).push(fn); return () => {}; } }),
            Texture: { create: (_w: number, _h: number, data: Uint8Array) => { const id = `texture${serial++}`; textures.set(id, data.slice()); return id; }, update: (id: string, data: Uint8Array) => textures.set(id, data.slice()) },
            Buffer: { create: () => `buffer${serial++}`, write: (id: string, data: Float32Array) => buffers.set(id, data.slice()) },
            Model: { createMesh: (c: any) => meshes.set(c.id, c), clearMesh: (id: string) => meshes.delete(id) },
            Mesh: { updateVertices: noop },
            Gizmo: { show: vi.fn(() => "gizmo"), hide: vi.fn(), updatePosition: vi.fn(), updateRotation: vi.fn() },
            Camera: { getTransform: () => [[0, 1.6, 6], [0, 0, -1]], setTransform, screenToWorldRay: (x: number, y: number) => ({ origin: [x, y, 6], direction: [0, 0, -1] }) },
            Controls: { enable: vi.fn(), disable: vi.fn() },
            UI: { setWindowVisible: vi.fn(), createWindow: (c: any) => { windows.push(c.onRender); return `window${windows.length}`; }, Widget: widget },
            Window: { getSize: () => [1400, 900] },
            Pipeline: { create: () => "pipeline" }, Lighting: { updateSun: vi.fn() },
            setGameMode: vi.fn(), println: vi.fn(), generateUUID: () => String(serial++),
        });
        await import("../src/apps/canvas_surfaces/canvas_surface_addon");
        init(); update(0);
    });

    for (const { name, steps: lines } of scenarios) {
        it(name, () => {
            for (const line of lines) {
                const match = steps.map(([re, fn]) => [re.exec(line), fn] as const).find(([m]) => m);
                if (!match) throw new Error(`No step definition: ${line}`);
                try { match[1](...(match[0]!.slice(1))); } catch (error) { throw new Error(`Step failed: ${line}`, { cause: error }); }
            }
        }, 60000);
    }
});
