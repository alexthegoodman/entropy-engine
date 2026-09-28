import { it, expect, vi } from "vitest";

it("keeps meshes resident during move and rotation and restores the gesture with undo", async () => {
    let init: any, update: any, gizmo: any, serial = 0;
    let renderToolbar: any, zoomKnob: any;
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
        UI: { Widget: {
            horizontal: (_: any, f: any) => f(), label: vi.fn(), spacer: vi.fn(), button: vi.fn(), segmented: vi.fn(),
            knob: (_: any, config: any) => zoomKnob = config,
        }, setTheme: vi.fn(), createWindow: (config: any) => { if (config.title === "Mesha") renderToolbar = config.onRender; return "window"; }, keyboardState: () => ({ typing: false }) }, Icons: { label: () => "", get: () => "" },
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

        // Adjusting sensitivity uses the current panned focus and never moves the camera.
        const speed = api.Controls.enable.mock.lastCall[1].zoomSpeed;
        api.Camera.getTransform = () => [[8, 4, 9], [6, 2, 7]];
        api.Camera.setTransform.mockClear();
        renderToolbar();
        expect(zoomKnob).toMatchObject({ id: "mesha-zoom-strength", value: 1, min: 0.1, max: 3, defaultValue: 1 });
        zoomKnob.onChange(2);
        expect(api.Controls.enable.mock.lastCall[1]).toMatchObject({ target: [6, 2, 7], zoomSpeed: speed * 2 });
        expect(api.Camera.setTransform).not.toHaveBeenCalled();
        expect(JSON.parse(saved.get("session.json")).zoomStrength).toBe(2);
        listeners.onKeyDown("f", false, false);
        renderToolbar();
        expect(zoomKnob.value).toBe(2);
        // A fresh addon instance restores the preference from disk.
        vi.resetModules();
        await import("../src/apps/mesha/mesha_addon");
        init();
        renderToolbar();
        expect(zoomKnob.value).toBe(2);
    } finally { vi.unstubAllGlobals(); }
});

it("pans camera and target together, then orbits without snapping back", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("../../src/deno/addon_setup.js", "utf8");
    const start = source.indexOf("    Controls: {");
    const end = source.indexOf("    Gizmo: {", start);
    const body = source.slice(start, end).replace(/\/\/[^\n]*$/g, "");
    const events: Record<string, any> = {};
    let tick: any, mouse = [0, 0], pos = [0, 0, 5], target = [0, 0, 0], overUI = false;
    let cameraSnapshot: number[][] | undefined;
    const ops = {
        op_camera_get_transform: () => cameraSnapshot ?? [pos, target],
        op_camera_set_transform: (p: number[], t: number[]) => { pos = [...p]; target = [...t]; },
        op_input_get_state: () => ({ mousePosition: mouse }),
        op_addon_on_update: (_: any, f: any) => tick = f,
    };
    const api: any = { println: vi.fn(), Input: Object.fromEntries(["onMouseDown", "onMouseUp", "onMouseWheel"].map(n => [n, (f: any) => { events[n] = f; return () => {}; }])) };
    api.Input.isPointerOverUI = () => overUI;
    vi.stubGlobal("Entropy", api);
    try {
        api.Controls = new Function("ops", `return ({${body}}).Controls`)(ops);
        api.Controls.enable("orbit", { trigger: "always", button: 1, panButton: 2, zoomButton: -1, panSpeed: 0.01 });
        events.onMouseDown(2, 0, 0);
        for (let n = 1; n <= 12; n++) {
            // Native camera reads lag writes: the frame snapshot is captured before
            // applying the preceding frame's queued camera transform.
            const previous = [pos, target];
            mouse = [25 * n, 15 * n]; tick();
            cameraSnapshot = previous;
            expect(target[0]).toBeCloseTo(-0.25 * n);
            expect(target[1]).toBeCloseTo(0.15 * n);
            expect(target[2]).toBeCloseTo(0);
            pos.forEach((v, i) => expect(v - target[i]).toBeCloseTo([0, 0, 5][i]));
        }
        events.onMouseUp(2);
        cameraSnapshot = undefined;
        const focus = [...target];
        expect(Math.hypot(...focus)).toBeGreaterThan(0.1);
        expect(pos.map((v, i) => v - target[i])).toEqual([0, 0, 5]);
        events.onMouseDown(1, 25, 15); mouse = [40, 20]; tick(); events.onMouseUp(1);
        expect(target).toEqual(focus);
        expect(Math.hypot(...pos.map((v, i) => v - target[i]))).toBeCloseTo(5);
        // GUI scrolling must leave both position and focus untouched, in either direction.
        const beforeWheel = [...pos];
        overUI = true;
        for (const delta of [1, -1, 0.25, -0.25, 100]) events.onMouseWheel(0, delta);
        expect(pos).toEqual(beforeWheel);
        expect(target).toEqual(focus);
        overUI = false;
        events.onMouseWheel(0, 1);
        expect(target).toEqual(focus);
        expect(Math.hypot(...pos.map((v, i) => v - target[i]))).toBeLessThan(5);
        // Doubling sensitivity doubles the distance travelled for the same wheel delta.
        const distanceAfter = Math.hypot(...pos.map((v, i) => v - target[i]));
        pos = beforeWheel;
        api.Controls.enable("orbit", { target: focus, zoomSpeed: 0.1 });
        events.onMouseWheel(0, 1);
        expect(5 - Math.hypot(...pos.map((v, i) => v - target[i]))).toBeCloseTo(2 * (5 - distanceAfter));
    } finally { vi.unstubAllGlobals(); }
});
