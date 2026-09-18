import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { validateScene } from "../src/apps/canvas_surfaces/canvas_scene_format";

// Executable Gherkin subset: unsupported lines and steps fail loudly.
const scenarios: { name: string; steps: string[] }[] = [];
for (const raw of readFileSync(new URL("../../../tests/features/canvas_animation.feature", import.meta.url), "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("Feature:")) continue;
    if (line.startsWith("Scenario:")) { scenarios.push({ name: line.slice(9).trim(), steps: [] }); continue; }
    const step = /^(Given|When|Then|And|But) (.+)$/.exec(line);
    if (!step || !scenarios.length) throw new Error(`Unsupported Gherkin: ${line}`);
    scenarios.at(-1)!.steps.push(step[2]);
}

describe("Canvas animation BDD through production addon callbacks", () => {
    let listeners: Record<string, ((...args: any[]) => void)[]>;
    let buttons: Map<string, () => void>;
    let captions: Map<string, string>;
    let labels: string[];
    let sliders: Map<string, { value: number; onChange: (v: string) => void }>;
    let textures: Map<string, Uint8Array>;
    let meshes: Map<string, any>;
    let buffers: Map<string, Float32Array>;
    let init: () => void;
    let update: (time?: number) => void;
    let render: () => void;
    let api: any;
    let overUI: boolean;
    let savedIndex: any;
    let savedData: Map<string, any>;
    let textInputs: Map<string, (value: string) => void>;
    let colorInput: (value: number[]) => void;
    const emit = (name: string, ...args: any[]) => listeners[name]?.forEach(fn => fn(...args));
    const click = (id: string) => { render(); expect(buttons.has(id)).toBe(true); buttons.get(id)!(); update(); };
    const pixels = () => {
        const mesh = [...meshes.values()].find(m => m.id.startsWith("canvas_surface_"));
        return textures.get(mesh.bindings[0].resource.value.id)!;
    };
    const surfaceMeshes = () => [...meshes.keys()].filter(id => id.startsWith("canvas_surface_"));
    const stroke = () => {
        emit("onMouseDown", 0, -0.6, 1.5);
        emit("onMouseMove", 0.6, 1.5);
        emit("onMouseUp", 0); update();
    };

    beforeEach(async () => {
        vi.resetModules();
        listeners = {}; buttons = new Map(); captions = new Map(); labels = []; sliders = new Map(); textures = new Map(); meshes = new Map(); buffers = new Map(); overUI = false; savedIndex = null; savedData = new Map(); textInputs = new Map();
        let serial = 0;
        const widget = {
            button: (_id: string, c: any) => { buttons.set(c.id, c.onClick); captions.set(c.id, c.text); },
            slider: (_id: string, c: any) => sliders.set(c.id, c),
            label: (_id: string, c: any) => labels.push(c.text), separator: vi.fn(),
            textInput: (_id: string, c: any) => textInputs.set(c.id, c.onChange),
            colorInput: (_id: string, c: any) => { colorInput = c.onChange; },
            horizontal: (id: string, fn: (id: string) => void) => fn(id),
            collapsingHeader: (id: string, _title: string, fn: (id: string) => void) => fn(id),
        };
        api = {
            AddonAtom: { register: () => ({ onInit: (fn: () => void) => { init = fn; }, onUpdatePlus: (_name: string, fn: (time?: number) => void) => { update = fn; }, IO: { save: (data: any) => { savedIndex = structuredClone(data); }, load: () => savedIndex },
                GameState: { save: (key: string, value: any) => savedData.set(key, structuredClone(value)), load: (key: string) => savedData.get(key) ?? null } }) },
            Input: new Proxy({}, { get: (_t, name: string) => name === "isPointerOverUI" ? () => overUI : (fn: (...args: any[]) => void) => { (listeners[name] ??= []).push(fn); return () => {}; } }),
            Texture: { create: (_w: number, _h: number, data: Uint8Array) => { const id = `texture${serial++}`; textures.set(id, data.slice()); return id; }, update: (id: string, data: Uint8Array) => textures.set(id, data.slice()) },
            Buffer: { create: () => `buffer${serial++}`, write: (id: string, data: Float32Array) => buffers.set(id, data.slice()) },
            Model: { createMesh: (c: any) => meshes.set(c.id, c), clearMesh: (id: string) => meshes.delete(id) },
            Mesh: { updateVertices: (id: string, indices: number[], positions: number[]) => { const mesh = meshes.get(id); if (mesh) indices.forEach((index, k) => mesh.vertexData.splice(index * 12, 3, ...positions.slice(k * 3, k * 3 + 3))); } },
            Gizmo: { show: vi.fn(() => "gizmo"), hide: vi.fn(), updatePosition: vi.fn(), updateRotation: vi.fn() },
            Camera: { getTransform: () => [[0, 1.6, 6], [0, 0, -1]], setTransform: vi.fn(), screenToWorldRay: (x: number, y: number) => ({ origin: [x, y, 6], direction: [0, 0, -1] }) },
            Controls: { enable: vi.fn(), disable: vi.fn() },
            UI: { createWindow: (c: any) => { render = () => { buttons.clear(); sliders.clear(); captions.clear(); labels = []; c.onRender(); }; return "tools"; }, Widget: widget },
            Window: { getSize: () => [1400, 900] },
            Pipeline: { create: () => "pipeline" }, Lighting: { updateSun: vi.fn() },
            setGameMode: vi.fn(), println: vi.fn(), generateUUID: () => String(serial++),
        };
        vi.stubGlobal("Entropy", api);
        await import("../src/apps/canvas_surfaces/canvas_surface_addon");
        init(); update(); render();
    });

    let originalPixels: Uint8Array;
    let originalVertices: number[];
    let firstSurfaceId: string;
    const set = (id: string, value: string) => { render(); expect(sliders.has(id), id).toBe(true); sliders.get(id)!.onChange(value); update(); };
    const name = (id: string, value: string) => { render(); expect(textInputs.has(id), id).toBe(true); textInputs.get(id)!(value); update(); };
    const saved = () => savedData.get(savedIndex.scenes[0].key);
    const center = () => {
        const vertices: number[] = meshes.get(firstSurfaceId).vertexData;
        return [0, 1, 2].map(axis => {
            const values = vertices.filter((_, i) => i % 12 === axis);
            return (Math.min(...values) + Math.max(...values)) / 2;
        });
    };
    const selectCaption = (prefix: string, caption: string) => {
        render(); const entry = [...captions].find(([id, text]) => id.startsWith(prefix) && text.replace(/^> /, "") === caption);
        expect(entry, caption).toBeDefined(); click(entry![0]);
    };
    const steps: Record<string, () => void> = {
        "a canvas surface is ready": () => { firstSurfaceId = surfaceMeshes()[0]; originalVertices = [...meshes.get(firstSurfaceId).vertexData]; originalPixels = pixels().slice(); },
        "I draw a stroke": stroke,
        "I remember the artwork": () => { originalPixels = pixels().slice(); },
        "the artwork matches exactly": () => expect(Buffer.from(pixels()).equals(Buffer.from(originalPixels))).toBe(true),
        "the artwork differs": () => expect(Buffer.from(pixels()).equals(Buffer.from(originalPixels))).toBe(false),
        "the surface has its original geometry": () => {
            const vertices: number[] = meshes.get(firstSurfaceId).vertexData;
            expect(vertices.length).toBe(originalVertices.length);
            vertices.forEach((v, i) => expect(v).toBeCloseTo(originalVertices[i], 6));
        },
        "the surface center is at the raised arm position": () => { const c = center(); expect(c[0]).toBeCloseTo(1.5); expect(c[1]).toBeCloseTo(3); expect(c[2]).toBeCloseTo(0); },
        "the surface center has moved two units right": () => { const c = center(); expect(c[0]).toBeCloseTo(2); expect(c[1]).toBeCloseTo(1.5); },
        "the scene has a nested hierarchy": () => {
            const scene = saved(); expect(scene.groups).toHaveLength(2);
            expect(scene.groups[0].parentId).toBe(scene.groups[1].id);
            expect(scene.surfaces[0].parentId).toBe(scene.groups[0].id);
        },
        "the scene preserves stroke identity and the named clip": () => {
            const scene = saved(); expect(scene.version).toBe(3); expect(scene.surfaces[0].id).toBe(firstSurfaceId);
            expect(scene.surfaces[0].strokes).toHaveLength(1);
            expect(scene.clips[0].name).toBe("Smile");
            expect(scene.clips[0].tracks[0].targetId).toBe(scene.surfaces[0].strokes[0].id);
            expect(scene.clips[0].tracks[0].keys.map((k: any) => [k.time, k.value])).toEqual([[0, 0], [1, 1]]);
        },
        "I reload a version two copy": () => {
            const scene = structuredClone(saved()); scene.version = 2; delete scene.groups; delete scene.clips;
            for (const surface of scene.surfaces) {
                for (const key of ["id", "parentId", "frame", "scale", "pivot", "strokes"]) delete surface[key];
                for (const layer of surface.layers) delete layer.basePixelsBase64;
            }
            savedData.set(savedIndex.scenes[0].key, scene); click("load_scene"); firstSurfaceId = surfaceMeshes()[0];
        },
        "I draw a different stroke": () => {
            emit("onMouseDown", 0, -0.6, 2); emit("onMouseMove", 0.6, 2); emit("onMouseUp", 0); update();
        },
        "the surface width is doubled": () => {
            const xs = meshes.get(firstSurfaceId).vertexData.filter((_: number, i: number) => i % 12 === 0);
            expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(6);
        },
        "the example has independent arm and smile tracks": () => {
            const scene = saved(); expect(scene.surfaces).toHaveLength(6); expect(scene.groups).toHaveLength(2);
            const tracks = scene.clips[0].tracks; expect(tracks.map((t: any) => t.channel)).toEqual(["roll", "progress"]);
            const face = scene.surfaces.find((s: any) => s.name === "Face");
            expect(face.strokes).toHaveLength(3); expect(tracks[1].targetId).toBe(face.strokes[2].id);
        },
        "I select the first stroke": () => { render(); const id = [...buttons.keys()].find(id => id.startsWith("stroke_") && !["stroke_name", "stroke_visible", "stroke_progress"].includes(id)); expect(id).toBeDefined(); click(id!); },
        "I select the surface": () => click(`node_${firstSurfaceId}`),
        "I select the inner group": () => selectCaption("node_", "Group: Group 1"),
        "I select the outer group": () => selectCaption("node_", "Group: Group 2"),
        "the cycle is rejected": () => { render(); expect(labels.some(label => label.includes("cannot contain themselves"))).toBe(true); },
        "the scene is still saved": () => { render(); expect(labels).toContain("Untitled scene"); expect(labels).not.toContain("Untitled scene *"); },
        "the preview advances to its end": () => { update(10); update(11); update(12); render(); expect(sliders.get("clip_time")!.value).toBe(2); expect(captions.get("clip_play")).toBe("Play"); },
        "malformed animation and hierarchy are rejected": () => {
            const scene = saved();
            const cycle = structuredClone(scene); cycle.groups[0].parentId = cycle.groups[0].id; expect(() => validateScene(cycle)).toThrow();
            const dangling = structuredClone(scene); dangling.surfaces[0].parentId = "missing"; expect(() => validateScene(dangling)).toThrow();
            const duplicate = structuredClone(scene); duplicate.groups[0].id = duplicate.surfaces[0].id; expect(() => validateScene(duplicate)).toThrow();
            const badKey = structuredClone(scene); badKey.clips[0].tracks[0].keys[0].value = NaN; expect(() => validateScene(badKey)).toThrow();
            const badTarget = structuredClone(scene); badTarget.clips[0].tracks[0].targetId = "missing"; expect(() => validateScene(badTarget)).toThrow();
        },
    };
    for (const scenario of scenarios) it(scenario.name, () => {
        for (const step of scenario.steps) {
            try {
                const quoted = [...step.matchAll(/"([^"\n]*)"/g)].map(match => match[1]);
                if (step.startsWith("I click ") && quoted.length === 1) click(quoted[0]);
                else if (step.startsWith("I set ") && quoted.length === 2) set(quoted[0], quoted[1]);
                else if (step.startsWith("I name ") && quoted.length === 2) name(quoted[0], quoted[1]);
                else if (steps[step]) steps[step]();
                else throw new Error(`No step definition: ${step}`);
            } catch (error) { throw new Error(`Step failed: ${step}`, { cause: error }); }
        }
    });
});
