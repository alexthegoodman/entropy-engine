import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { validateScene } from "../src/apps/canvas_surfaces/canvas_scene_format";

// Executable Gherkin subset: unsupported lines and steps fail loudly.
const scenarios: { name: string; steps: string[] }[] = [];
for (const raw of ["canvas_animation", "canvas_logic", "canvas_tabs"].flatMap(file => readFileSync(new URL(`../../../tests/features/${file}.feature`, import.meta.url), "utf8").split(/\r?\n/))) {
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
    let tabBar: { id?: string; tabs: { id: string; label: string }[]; selected: string; onSelect: (id: string) => void } | null;
    let api: any;
    let graphWidget: any;
    let windows: (() => void)[];
    let overUI: boolean;
    let savedIndex: any;
    let savedData: Map<string, any>;
    let textInputs: Map<string, (value: string) => void>;
    let colorInput: (value: number[]) => void;
    let treeNodes: any[];
    let treeCallbacks: { onSelect?: (id: string) => void; onToggleExpand?: (id: string) => void; onMark?: (id: string, value: boolean) => void };
    const emit = (name: string, ...args: any[]) => listeners[name]?.forEach(fn => fn(...args));
    // A control on another tab is reached the way a person reaches it: open tabs until it shows.
    const reveal = (present: () => boolean) => {
        render();
        if (present() || !tabBar) return;
        for (const tab of [...tabBar.tabs]) { tabBar!.onSelect(tab.id); render(); if (present()) return; }
    };
    const showTab = (id: string) => { render(); expect(tabBar, "tab bar").not.toBeNull(); tabBar!.onSelect(id); render(); };
    const click = (id: string) => { reveal(() => buttons.has(id)); expect(buttons.has(id), id).toBe(true); buttons.get(id)!(); update(); };
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
        listeners = {}; buttons = new Map(); captions = new Map(); labels = []; sliders = new Map(); textures = new Map(); meshes = new Map(); buffers = new Map(); overUI = false; savedIndex = null; savedData = new Map(); textInputs = new Map(); treeNodes = []; treeCallbacks = {};
        // render itself must be reset too - setupUI() now creates a second window, and without
        // this reset the "only bind the first window's onRender" guard below would keep the
        // PREVIOUS test's stale closure (render is declared outside beforeEach, so it otherwise
        // survives from one test to the next).
        render = undefined as unknown as () => void;
        windows = []; graphWidget = null;
        let serial = 0;
        const widget = {
            button: (_id: string, c: any) => { buttons.set(c.id, c.onClick); captions.set(c.id, c.text); },
            slider: (_id: string, c: any) => sliders.set(c.id, c),
            label: (_id: string, c: any) => labels.push(c.text), separator: vi.fn(),
            textInput: (_id: string, c: any) => textInputs.set(c.id, c.onChange),
            colorInput: (_id: string, c: any) => { colorInput = c.onChange; },
            horizontal: (id: string, fn: (id: string) => void) => fn(id),
            group: (id: string, fn: (id: string) => void) => fn(id),
            collapsingHeader: (id: string, _title: string, fn: (id: string) => void) => fn(id),
            treeView: (_id: string, c: any) => { treeNodes = c.nodes || []; treeCallbacks = c; },
            tabBar: (_id: string, c: any) => { tabBar = c; },
            snarl: (_id: string, c: any) => { graphWidget = c; },
            dropdown: (_id: string, c: any) => textInputs.set(c.id, c.onChange),
            keyframeTimeline: vi.fn(),
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
            // setupUI() now creates a second window for the keyframe timeline - only the first
            // (the main sidebar) is what these tests drive via render()/update().
            UI: { setWindowVisible: vi.fn(), createWindow: (c: any) => { windows.push(c.onRender); render = () => { buttons.clear(); sliders.clear(); captions.clear(); labels = []; treeNodes = []; tabBar = null; windows.forEach(fn => fn()); }; return `window${windows.length}`; }, Widget: widget },
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
    let gameGeometry: any;
    const set = (id: string, value: string) => { reveal(() => sliders.has(id)); expect(sliders.has(id), id).toBe(true); sliders.get(id)!.onChange(value); update(); };
    const name = (id: string, value: string) => { reveal(() => textInputs.has(id)); expect(textInputs.has(id), id).toBe(true); textInputs.get(id)!(value); update(); };
    const saved = () => savedData.get(savedIndex.scenes[0].key);
    const center = () => {
        const vertices: number[] = meshes.get(firstSurfaceId).vertexData;
        return [0, 1, 2].map(axis => {
            const values = vertices.filter((_, i) => i % 12 === axis);
            return (Math.min(...values) + Math.max(...values)) / 2;
        });
    };
    // Node selection lives entirely inside one Widget.treeView call (see
    // buildHierarchyRows/renderAnimationUI), not as individual per-node buttons - so "clicking"
    // a tree row here means finding it by label in the widget's last-rendered `nodes` array and
    // invoking the callback the addon bound to `onSelect`, exactly as a real click would.
    const selectNodeByLabel = (label: string) => {
        showTab("animate"); const node = treeNodes.find(n => n.label === label);
        expect(node, label).toBeDefined(); expect(treeCallbacks.onSelect, label).toBeDefined();
        treeCallbacks.onSelect!(node!.id); update();
    };
    const buttonIds = () => [...buttons.keys()];
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
        "I select the first stroke": () => { showTab("animate"); const id = [...buttons.keys()].find(id => id.startsWith("stroke_") && !["stroke_name", "stroke_visible", "stroke_progress"].includes(id)); expect(id).toBeDefined(); click(id!); },
        "I select the surface": () => {
            showTab("animate"); const node = treeNodes.find(n => n.id === firstSurfaceId);
            expect(node, firstSurfaceId).toBeDefined(); treeCallbacks.onSelect!(firstSurfaceId); update();
        },
        "I select the inner group": () => selectNodeByLabel("Group 1"),
        "I select the outer group": () => selectNodeByLabel("Group 2"),
        "the cycle is rejected": () => { render(); expect(labels.some(label => label.includes("cannot contain themselves"))).toBe(true); },
        "the scene is still saved": () => { render(); expect(labels).toContain("Untitled scene"); expect(labels).not.toContain("Untitled scene *"); },
        "the preview advances to its end": () => { update(10); update(11); update(12); render(); expect(sliders.get("clip_time")!.value).toBe(2); expect(captions.get("clip_play")).toBe("Preview clip"); },
        "I open the playable example": () => { click("playable_example"); click("scene_confirm_discard"); click("save_scene"); gameGeometry = structuredClone([...meshes.values()].filter(m => m.id.startsWith("canvas_surface_")).sort((a, b) => a.id.localeCompare(b.id)).map(m => m.vertexData)); },
        "gameplay has not started": () => { update(10); update(14); render(); expect(captions.get("game_play")).toBe("Play"); expect(labels).not.toContain("Click my face to say hello!"); },
        "the welcome message is shown": () => { render(); expect(captions.get("game_play")).toBe("Stop"); expect(labels).toContain("Click my face to say hello!"); expect(buttons.has("save_scene")).toBe(false); },
        "I click the character face": () => { emit("onMouseDown", 0, 0, 2.65); emit("onMouseUp", 0); update(); },
        "the wave changes the geometry": () => { update(20); update(21); expect([...meshes.values()].filter(m => m.id.startsWith("canvas_surface_")).sort((a, b) => a.id.localeCompare(b.id)).map(m => m.vertexData)).not.toEqual(gameGeometry); render(); expect(labels).toContain("Click my face to say hello!"); },
        "the delayed reply is shown": () => { update(22.1); render(); expect(labels).toContain("Hello, friend! Stop and Play to try again."); },
        "the scene and graph are unchanged": () => { render(); expect([...meshes.values()].filter(m => m.id.startsWith("canvas_surface_")).sort((a, b) => a.id.localeCompare(b.id)).map(m => m.vertexData)).toEqual(gameGeometry); expect(labels).toContain("Drawn character"); expect(labels).not.toContain("Drawn character *"); click("save_scene"); expect(saved().logic.nodes).toHaveLength(7); expect(saved().logic.connections).toHaveLength(5); },
        "I disconnect the wave": () => { render(); graphWidget.onDisconnect(["demo-once", "next", "demo-wave", "in"]); update(); },
        "I reconnect the wave": () => { render(); graphWidget.onConnect(["demo-once", "next", "demo-wave", "in"]); update(); },
        "the disconnected click does nothing": () => { update(20); update(25); render(); expect(labels).toContain("Click my face to say hello!"); },
        "I attempt a graph loop": () => { render(); graphWidget.onConnect(["demo-wave", "next", "demo-once", "in"]); render(); expect(labels.some(l => l.includes("Logic loops"))).toBe(true); expect(graphWidget.graph.connections).toHaveLength(5); },
        "I add a startup message without code": () => {
            click("workspace_logic"); click("logic_add_start"); click("logic_add_message"); name("logic_message", "Made in the editor"); render();
            const [start, message] = graphWidget.graph.nodes;
            graphWidget.onConnect([start.id, "next", message.id, "in"]); update(); click("save_scene");
        },
        "my authored message is shown": () => { render(); expect(labels).toContain("Made in the editor"); },
        "pending actions were cancelled": () => { update(100); render(); expect(captions.get("game_play")).toBe("Play"); expect(labels).not.toContain("Hello, friend! Stop and Play to try again."); },
        "the completed wave does not restart": () => { update(25); update(26); expect(JSON.stringify([...meshes.values()].filter(m => m.id.startsWith("canvas_surface_")).sort((a, b) => a.id.localeCompare(b.id)).map(m => m.vertexData)) === JSON.stringify(gameGeometry)).toBe(true); },
        "the graph has five wires": () => { render(); expect(graphWidget.graph.connections).toHaveLength(5); },
        "I select the click node": () => { render(); graphWidget.onNodeSelected("demo-click"); update(); },
        "Play requests a surface target": () => { render(); expect(captions.get("game_play")).toBe("Play"); expect(labels).toContain("Choose a surface for When surface clicked."); },
        "malformed animation and hierarchy are rejected": () => {
            const scene = saved();
            const cycle = structuredClone(scene); cycle.groups[0].parentId = cycle.groups[0].id; expect(() => validateScene(cycle)).toThrow();
            const dangling = structuredClone(scene); dangling.surfaces[0].parentId = "missing"; expect(() => validateScene(dangling)).toThrow();
            const duplicate = structuredClone(scene); duplicate.groups[0].id = duplicate.surfaces[0].id; expect(() => validateScene(duplicate)).toThrow();
            const badKey = structuredClone(scene); badKey.clips[0].tracks[0].keys[0].value = NaN; expect(() => validateScene(badKey)).toThrow();
            const badTarget = structuredClone(scene); badTarget.clips[0].tracks[0].targetId = "missing"; expect(() => validateScene(badTarget)).toThrow();
        },
    };
    const tabSteps = (step: string, quoted: string[]): boolean => {
        if (step.startsWith("I open the ") && step.endsWith(" tab") && quoted.length === 1) showTab(quoted[0]);
        else if (step.startsWith("the tab bar lists ") && quoted.length === 1) { render(); expect(tabBar!.tabs.map(t => t.label).join(", ")).toBe(quoted[0]); }
        else if (step.startsWith("the ") && step.endsWith(" tab is selected") && quoted.length === 1) { render(); expect(tabBar!.selected).toBe(quoted[0]); }
        else if (step.startsWith("I see the button ") && quoted.length === 1) { render(); expect(buttonIds(), quoted[0]).toContain(quoted[0]); }
        else if (step.startsWith("I do not see the button ") && quoted.length === 1) { render(); expect(buttonIds(), quoted[0]).not.toContain(quoted[0]); }
        else if (step.startsWith("I see the slider ") && quoted.length === 1) { render(); expect([...sliders.keys()], quoted[0]).toContain(quoted[0]); }
        else if (step.startsWith("I see the label ") && quoted.length === 1) { render(); expect(labels, quoted[0]).toContain(quoted[0]); }
        else if (step === "the always visible controls are shown") { render(); for (const id of ["undo", "redo", "mode_draw", "mode_move", "mode_cut", "game_play"]) expect(buttonIds(), id).toContain(id); }
        else if (step.startsWith("I select the tree row ") && quoted.length === 1) selectNodeByLabel(quoted[0]);
        else if (step === "I see no tab bar") { render(); expect(tabBar).toBeNull(); }
        else if (step === "I redraw 5 frames") { for (let i = 0; i < 5; i++) { update(); render(); } }
        else return false;
        return true;
    };
    for (const scenario of scenarios) it(scenario.name, () => {
        for (const step of scenario.steps) {
            try {
                const quoted = [...step.matchAll(/"([^"\n]*)"/g)].map(match => match[1]);
                if (step.startsWith("I click ") && quoted.length === 1) click(quoted[0]);
                else if (step.startsWith("I set ") && quoted.length === 2) set(quoted[0], quoted[1]);
                else if (step.startsWith("I name ") && quoted.length === 2) name(quoted[0], quoted[1]);
                else if (tabSteps(step, quoted)) continue;
                else if (steps[step]) steps[step]();
                else throw new Error(`No step definition: ${step}`);
            } catch (error) { throw new Error(`Step failed: ${step}`, { cause: error }); }
        }
    }, 20000);
});
