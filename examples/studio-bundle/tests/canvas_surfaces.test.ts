import { beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasHistory } from "../src/apps/canvas_history";

describe("bounded gesture history", () => {
    it("groups a drag, ignores no-ops, preserves redo until an actual edit, and branches", () => {
        let value = 0;
        const history = new CanvasHistory(() => value, v => { value = v; }, Object.is, () => 0);
        history.begin("drag"); value = 1;
        history.begin("drag"); value = 2; history.commit();
        history.undo(); expect(value).toBe(0);
        history.begin("no-op"); history.commit();
        history.redo(); expect(value).toBe(2);
        history.undo(); history.begin("new stroke"); value = 3; history.commit();
        history.redo(); expect(value).toBe(3);
        history.undo(); expect(value).toBe(0);
    });

    it("cancels an in-progress cut without consuming redo", () => {
        let value = 0;
        const history = new CanvasHistory(() => value, v => { value = v; }, Object.is, () => 0);
        history.begin("stroke"); value = 1; history.commit(); history.undo();
        history.begin("cut"); value = 9; history.cancel();
        expect(value).toBe(0);
        history.redo(); expect(value).toBe(1);
    });

    it("evicts old entries under the byte budget while keeping the latest action", () => {
        let value = 0;
        const history = new CanvasHistory(() => value, v => { value = v; }, Object.is, states => states.length * 4, 16);
        for (let n = 1; n <= 5; n++) { history.begin("edit"); value = n; history.commit(); }
        history.undo(); history.undo(); history.undo();
        expect(value).toBe(3);
    });
});

describe("Canvas Surfaces workflow using the real addon callbacks", () => {
    let listeners: Record<string, ((...args: any[]) => void)[]>;
    let buttons: Map<string, () => void>;
    let sliders: Map<string, { value: number; onChange: (v: string) => void }>;
    let textures: Map<string, Uint8Array>;
    let meshes: Map<string, any>;
    let buffers: Map<string, Float32Array>;
    let init: () => void;
    let update: () => void;
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
        listeners = {}; buttons = new Map(); sliders = new Map(); textures = new Map(); meshes = new Map(); buffers = new Map(); overUI = false; savedIndex = null; savedData = new Map(); textInputs = new Map();
        let serial = 0;
        const widget = {
            button: (_id: string, c: any) => buttons.set(c.id, c.onClick),
            slider: (_id: string, c: any) => sliders.set(c.id, c),
            label: vi.fn(), separator: vi.fn(),
            textInput: (_id: string, c: any) => textInputs.set(c.id, c.onChange),
            colorInput: (_id: string, c: any) => { colorInput = c.onChange; },
            horizontal: (id: string, fn: (id: string) => void) => fn(id),
            collapsingHeader: (id: string, _title: string, fn: (id: string) => void) => fn(id),
        };
        api = {
            AddonAtom: { register: () => ({ onInit: (fn: () => void) => { init = fn; }, onUpdatePlus: (_name: string, fn: () => void) => { update = fn; }, IO: { save: (data: any) => { savedIndex = structuredClone(data); }, load: () => savedIndex },
                GameState: { save: (key: string, value: any) => savedData.set(key, structuredClone(value)), load: (key: string) => savedData.get(key) ?? null } }) },
            Input: new Proxy({}, { get: (_t, name: string) => name === "isPointerOverUI" ? () => overUI : (fn: (...args: any[]) => void) => { (listeners[name] ??= []).push(fn); return () => {}; } }),
            Texture: { create: (_w: number, _h: number, data: Uint8Array) => { const id = `texture${serial++}`; textures.set(id, data.slice()); return id; }, update: (id: string, data: Uint8Array) => textures.set(id, data.slice()) },
            Buffer: { create: () => `buffer${serial++}`, write: (id: string, data: Float32Array) => buffers.set(id, data.slice()) },
            Model: { createMesh: (c: any) => meshes.set(c.id, c), clearMesh: (id: string) => meshes.delete(id) },
            Mesh: { updateVertices: vi.fn() },
            Gizmo: { show: vi.fn(() => "gizmo"), hide: vi.fn(), updatePosition: vi.fn(), updateRotation: vi.fn() },
            Camera: { getTransform: () => [[0, 1.6, 6], [0, 0, -1]], setTransform: vi.fn(), screenToWorldRay: (x: number, y: number) => ({ origin: [x, y, 6], direction: [0, 0, -1] }) },
            Controls: { enable: vi.fn(), disable: vi.fn() },
            UI: { createWindow: (c: any) => { render = c.onRender; return "tools"; }, Widget: widget },
            Window: { getSize: () => [1400, 900] },
            Pipeline: { create: () => "pipeline" }, Lighting: { updateSun: vi.fn() },
            setGameMode: vi.fn(), println: vi.fn(), generateUUID: () => String(serial++),
        };
        vi.stubGlobal("Entropy", api);
        await import("../src/apps/canvas_surface_addon");
        init(); update(); render();
    });

    it("restores exact stroke pixels through undo/redo and deletion", () => {
        const blank = pixels().slice(); stroke();
        const painted = pixels().slice(); expect(Buffer.from(painted).equals(Buffer.from(blank))).toBe(false);
        click("undo"); expect(Buffer.from(pixels()).equals(Buffer.from(blank))).toBe(true);
        click("redo"); expect(Buffer.from(pixels()).equals(Buffer.from(painted))).toBe(true);
        const id = surfaceMeshes()[0]; click(`layer_delete_${id}`);
        expect(surfaceMeshes()).toHaveLength(0);
        click("undo"); expect(surfaceMeshes()).toEqual([id]); expect(Buffer.from(pixels()).equals(Buffer.from(painted))).toBe(true);
        click("undo"); expect(Buffer.from(pixels()).equals(Buffer.from(blank))).toBe(true);
    });

    it("makes a slider drag one undo and restores rotation and bend", () => {
        click("mode_move");
        overUI = true; emit("onMouseDown", 0, 0, 0);
        render(); sliders.get("pos_x_slider")!.onChange("1"); update();
        sliders.get("pos_x_slider")!.onChange("2"); update();
        emit("onMouseUp", 0); update();
        click("undo"); render(); expect(sliders.get("pos_x_slider")!.value).toBe(0);
        click("redo"); render(); expect(sliders.get("pos_x_slider")!.value).toBe(2);
        sliders.get("yaw_slider")!.onChange("0.7"); update();
        sliders.get("bend_slider")!.onChange("0.4"); update();
        click("undo"); render(); expect(sliders.get("bend_slider")!.value).toBe(0);
        click("undo"); render(); expect(sliders.get("yaw_slider")!.value).toBe(0);
    });

    it("undoes cut alpha and cancels cut guides without leaving marks", () => {
        const blank = pixels().slice(); click("mode_cut");
        emit("onMouseDown", 0, -0.5, 1);
        emit("onMouseMove", 0.5, 1); emit("onMouseMove", 0, 2);
        emit("onMouseUp", 0); update();
        expect(pixels().some((v, i) => i % 4 === 3 && v === 0)).toBe(true);
        click("undo"); expect(Buffer.from(pixels()).equals(Buffer.from(blank))).toBe(true);
        emit("onMouseDown", 0, -0.5, 1); emit("onMouseMove", 0.5, 1);
        click("cancel_cut"); emit("onMouseUp", 0); update();
        expect(Buffer.from(pixels()).equals(Buffer.from(blank))).toBe(true);
    });

    it("renders hover feedback without touching artwork and clears it over UI", () => {
        const blank = pixels().slice();
        emit("onMouseMove", 0, 1.5); update();
        expect([...buffers.values()].some(b => b[6] === 1)).toBe(true);
        expect(Buffer.from(pixels()).equals(Buffer.from(blank))).toBe(true);
        overUI = true; update();
        expect([...buffers.values()].every(b => b[6] === 0)).toBe(true);
        click("undo"); expect(Buffer.from(pixels()).equals(Buffer.from(blank))).toBe(true);
    });

    it("cancels a cut with Escape while the pointer is still held", () => {
        const blank = pixels().slice(); click("mode_cut");
        emit("onMouseDown", 0, -0.5, 1); emit("onMouseMove", 0.5, 1);
        emit("onKeyDown", "Escape", false, false, false);
        emit("onMouseUp", 0); update();
        expect(Buffer.from(pixels()).equals(Buffer.from(blank))).toBe(true);
    });

    it("does not bridge a stroke across a missed surface region", () => {
        const blank = pixels().slice();
        emit("onMouseDown", 0, -0.8, 1.5);
        emit("onMouseMove", 5, 1.5); // outside the plane
        emit("onMouseMove", 0.8, 1.5);
        emit("onMouseUp", 0); update();
        const center = (384 * 768 + 384) * 4;
        expect(pixels().slice(center, center + 4)).toEqual(blank.slice(center, center + 4));
        expect(Buffer.from(pixels()).equals(Buffer.from(blank))).toBe(false);
    });

    it("records a pressure/tilt pen gesture once despite compatibility mouse events", () => {
        const blank = pixels().slice();
        emit("onStylusDown", { x: -0.6, y: 1.5, pressure: 0.2, tiltX: 20, tiltY: 10 });
        emit("onMouseDown", 0, -0.6, 1.5);
        emit("onStylusMove", { x: 0.6, y: 1.5, pressure: 0.9, tiltX: 30, tiltY: 10 });
        emit("onStylusUp", { x: 0.6, y: 1.5 }); emit("onMouseUp", 0); update();
        expect(Buffer.from(pixels()).equals(Buffer.from(blank))).toBe(false);
        click("undo"); expect(Buffer.from(pixels()).equals(Buffer.from(blank))).toBe(true);
        click("redo"); expect(Buffer.from(pixels()).equals(Buffer.from(blank))).toBe(false);
    });

    it("hides the selected gizmo and restores visibility with undo", () => {
        click("mode_move"); const id = surfaceMeshes()[0];
        api.Gizmo.show.mockClear(); click(`layer_toggle_${id}`);
        expect(api.Gizmo.show).not.toHaveBeenCalled(); expect(surfaceMeshes()).toHaveLength(0);
        click("undo"); expect(surfaceMeshes()).toEqual([id]);
        expect(api.Gizmo.show).toHaveBeenCalledOnce();
    });

    it("preserves two named scenes and their layer pixels across save/load", () => {
        textInputs.get("scene_name")!("First sketch"); stroke(); click("save_scene");
        const first = pixels().slice(); const firstId = savedIndex.scenes[0].id;
        click("new_scene");
        colorInput([0.9, 0.1, 0.2, 1]); stroke();
        textInputs.get("scene_name")!("Second sketch"); click("save_scene");
        const second = pixels().slice(); const secondId = savedIndex.scenes[1].id;
        expect(savedIndex.scenes).toHaveLength(2);
        click(`scene_select_${firstId}`); click("load_scene");
        expect(Buffer.from(pixels()).equals(Buffer.from(first))).toBe(true);
        click(`scene_select_${secondId}`); click("load_scene");
        expect(Buffer.from(pixels()).equals(Buffer.from(second))).toBe(true);
        // A normal undo after saving must keep the current scene identity.
        click("undo"); click("save_scene");
        expect(savedIndex.scenes).toHaveLength(2);
    });

    it("requires a decision before switching away from unsaved artwork", () => {
        textInputs.get("scene_name")!("Saved scene"); click("save_scene");
        stroke(); const painted = pixels().slice();
        click("new_scene"); click("scene_confirm_cancel");
        expect(Buffer.from(pixels()).equals(Buffer.from(painted))).toBe(true);
        click("new_scene"); click("scene_confirm_save");
        expect(Buffer.from(pixels()).equals(Buffer.from(painted))).toBe(false);
        click(`scene_select_${savedIndex.scenes[0].id}`); click("load_scene"); click("scene_confirm_discard");
        expect(Buffer.from(pixels()).equals(Buffer.from(painted))).toBe(true);
    });

    it("erases only the active layer and undo restores the upper paint", () => {
        colorInput([1, 0, 0, 1]); stroke(); const lower = pixels().slice();
        click("paint_add_color"); colorInput([0, 0, 1, 1]); stroke(); const upper = pixels().slice();
        expect(Buffer.from(lower).equals(Buffer.from(upper))).toBe(false);
        click("brush_btn_3"); stroke();
        const center = (384 * 768 + 384) * 4;
        expect(pixels()[center]).toBeGreaterThan(pixels()[center + 2]);
        click("undo"); expect(Buffer.from(pixels()).equals(Buffer.from(upper))).toBe(true);
    });

    it("honors layer locking, visibility, opacity and ordering with undo", () => {
        colorInput([1, 0, 0, 1]); stroke();
        click("paint_add_color"); colorInput([0, 0, 1, 1]); stroke(); const painted = pixels().slice();
        render(); const ids = [...buttons.keys()].filter(id => id.startsWith("paint_lock_"));
        const top = ids.at(-1)!;
        click(top); stroke(); expect(Buffer.from(pixels()).equals(Buffer.from(painted))).toBe(true);
        click(top.replace("paint_lock_", "paint_visible_")); expect(Buffer.from(pixels()).equals(Buffer.from(painted))).toBe(false);
        click("undo"); expect(Buffer.from(pixels()).equals(Buffer.from(painted))).toBe(true);
        render(); sliders.get("paint_layer_opacity")!.onChange("0.2"); update();
        expect(Buffer.from(pixels()).equals(Buffer.from(painted))).toBe(false);
        click("undo"); expect(Buffer.from(pixels()).equals(Buffer.from(painted))).toBe(true);
    });

    it("uses a disposable practice pad without changing the scene or undo history", () => {
        stroke(); const artwork = pixels().slice();
        click("practice_toggle"); colorInput([0, 1, 0, 1]); stroke();
        click("practice_toggle");
        expect(Buffer.from(pixels()).equals(Buffer.from(artwork))).toBe(true);
        click("undo"); expect(Buffer.from(pixels()).equals(Buffer.from(artwork))).toBe(false);
    });

    it("finishes the stabilization tail and keeps it inside one undo action", () => {
        sliders.get("tuning_stabilization")!.onChange("1");
        stroke();
        // Endpoint at x=0.6 => u=0.7; it must be painted after release, despite the trailing pen.
        const endpoint = (384 * 768 + Math.floor(0.7 * 768)) * 4;
        expect(pixels()[endpoint]).toBeLessThan(100);
        click("undo"); expect(pixels()[endpoint]).toBe(250);
    });

    it("aligns and restores the previous view, delaying orbit until the camera is applied", () => {
        api.Camera.setTransform.mockClear(); api.Controls.enable.mockClear();
        click("align_surface");
        const [position, target] = api.Camera.setTransform.mock.calls[0];
        expect(target).toEqual([0, 1.5, 0]); expect(position[2]).toBeGreaterThan(0);
        expect(api.Controls.enable).not.toHaveBeenCalled();
        update(); update(); expect(api.Controls.enable).toHaveBeenCalledOnce();
        click("return_view");
        const [restoredPosition, restoredTarget] = api.Camera.setTransform.mock.calls.at(-1);
        expect(restoredPosition).toEqual([0, 1.6, 6]);
        // Preserve the actual view direction even if it no longer points at the orbit target.
        expect(restoredTarget[0]).toBe(0); expect(restoredTarget[1]).toBe(1.6);
        expect(restoredTarget[2]).toBeLessThan(0);
    });
});
