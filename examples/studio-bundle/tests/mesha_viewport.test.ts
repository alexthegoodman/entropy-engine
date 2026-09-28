import { it, expect, vi } from "vitest";

it("keeps meshes resident during move and rotation and restores the gesture with undo", async () => {
    let init: any, update: any, gizmo: any, serial = 0;
    const listeners: Record<string, any> = {}, tools: Record<string, any> = {}, saved = new Map();
    const api: any = {
        generateUUID: () => String(++serial), println: vi.fn(), setGameMode: vi.fn(),
        AddonAtom: { register: () => ({ onInit: (f: any) => init = f, onUpdatePlus: (_: any, f: any) => update = f,
            registerTool: (t: any, run: any) => tools[t.name] = run,
            IO: { store: { read: (p: string) => saved.get(p), write: (p: string, s: string) => saved.set(p, s) } } }) },
        Input: { ...Object.fromEntries(["onMouseDown", "onMouseMove", "onMouseUp", "onKeyDown"].map(n => [n, (f: any) => listeners[n] = f])), isPointerOverUI: () => false },
        Model: { createMesh: vi.fn(), clearMesh: vi.fn() },
        Buffer: { create: () => String(++serial), write: vi.fn() },
        Pipeline: { create: () => "pipeline" }, Lighting: { updateSun: vi.fn() },
        Camera: { getTransform: () => [[2, 2, 2], [0, 0, 0]], setTransform: vi.fn() },
        Controls: { enable: vi.fn() }, Window: { getSize: () => [1500, 1000] },
        UI: { Widget: {}, setTheme: vi.fn(), createWindow: () => "window", keyboardState: () => ({ typing: false }) }, Icons: {},
        Gizmo: { show: (c: any) => { gizmo = c; return "gizmo"; }, hide: vi.fn(), updatePosition: vi.fn(), updateRotation: vi.fn(), getState: () => ({ isActive: true }) },
    };
    vi.stubGlobal("Entropy", api);
    try {
        await import("../src/apps/mesha/mesha_addon");
        init(); update(); update(); update();
        expect(gizmo.mode).toBe("translate_rotate");
        expect(api.Controls.enable.mock.lastCall[1]).toMatchObject({ button: 1, panButton: 2, zoomButton: -1 });
        const original = structuredClone(tools.mesha_state({}).instances[0]);
        api.Model.createMesh.mockClear(); api.Model.clearMesh.mockClear();
        listeners.onMouseDown(0, 600, 400);
        for (let n = 0; n < 20; n++) { gizmo.onTransform([0.01, 0, 0]); update(); }
        const q = [Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)];
        gizmo.onRotate(q); update();
        expect(api.Model.createMesh).not.toHaveBeenCalled();
        expect(api.Model.clearMesh).not.toHaveBeenCalled();
        expect(tools.mesha_state({}).instances[0].position[0]).toBeCloseTo(original.position[0] + 0.2);
        expect(tools.mesha_state({}).instances[0].rotation).toEqual(q);
        expect(api.Buffer.write.mock.lastCall[1].length).toBe(20);
        listeners.onMouseUp(0); update();
        expect(JSON.parse(saved.get("session.json")).scene.instances[0].rotation).toEqual(q);
        api.Model.clearMesh.mockClear();
        tools.mesha_undo({}); update();
        expect(tools.mesha_state({}).instances[0].position).toEqual(original.position);
        expect(api.Model.clearMesh.mock.calls).toHaveLength(1); // only the shadow floor
        listeners.onKeyDown("y", true, false); update();
        expect(tools.mesha_state({}).instances[0].rotation).toEqual(q);
        listeners.onKeyDown("d", true, false); update();
        expect(tools.mesha_state({}).instances[1].rotation).toEqual(q);
    } finally { vi.unstubAllGlobals(); }
});

it("pans camera and target together, then orbits without snapping back", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("../../src/deno/addon_setup.js", "utf8");
    const start = source.indexOf("    Controls: {");
    const end = source.indexOf("    Gizmo: {", start);
    const body = source.slice(start, end).replace(/\/\/[^\n]*$/g, "");
    const events: Record<string, any> = {};
    let tick: any, mouse = [0, 0], pos = [0, 0, 5], target = [0, 0, 0];
    const ops = {
        op_camera_get_transform: () => [pos, target],
        op_camera_set_transform: (p: number[], t: number[]) => { pos = [...p]; target = [...t]; },
        op_input_get_state: () => ({ mousePosition: mouse }),
        op_addon_on_update: (_: any, f: any) => tick = f,
    };
    const api: any = { println: vi.fn(), Input: Object.fromEntries(["onMouseDown", "onMouseUp", "onMouseWheel"].map(n => [n, (f: any) => { events[n] = f; return () => {}; }])) };
    vi.stubGlobal("Entropy", api);
    try {
        api.Controls = new Function("ops", `return ({${body}}).Controls`)(ops);
        api.Controls.enable("orbit", { trigger: "always", button: 1, panButton: 2, zoomButton: -1, panSpeed: 0.01 });
        events.onMouseDown(2, 0, 0); mouse = [25, 15]; tick(); events.onMouseUp(2);
        const focus = [...target];
        expect(Math.hypot(...focus)).toBeGreaterThan(0.1);
        expect(pos.map((v, i) => v - target[i])).toEqual([0, 0, 5]);
        events.onMouseDown(1, 25, 15); mouse = [40, 20]; tick(); events.onMouseUp(1);
        expect(target).toEqual(focus);
        expect(Math.hypot(...pos.map((v, i) => v - target[i]))).toBeCloseTo(5);
        events.onMouseWheel(0, 1);
        expect(target).toEqual(focus);
        expect(Math.hypot(...pos.map((v, i) => v - target[i]))).toBeLessThan(5);
    } finally { vi.unstubAllGlobals(); }
});
