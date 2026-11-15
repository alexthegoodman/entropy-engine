// The CAD viewport, shared by every CAD app: it owns a kernel session, keeps the engine's meshes
// in step with the evaluated document (bodies, their edges, sketches, grids), runs the camera, and
// answers "what is under the pointer" - on a body, or on a sketch plane.
//
// The app owns the document and the interaction; this owns everything drawn in 3D.

import { claimView, orbitView, seedOrbit } from "../shared_view";
import type { CadDocument } from "./cad_doc";
import { CAD_LINE_SHADER, CAD_SURFACE_SHADER, ITEM_FLOATS, ITEM_KIND, SCENE_FLOATS, packItem, packScene, type ViewMode } from "./cad_shader";

type V3 = [number, number, number];
type Addon = ReturnType<typeof Entropy.Addon.register>;
type Bindings = NonNullable<CadSpawnConfig["bindings"]>;

/** World units per document unit (millimetres): a 100 mm part is one world unit across. */
export const UNIT = 0.01;

export interface CadPalette {
    accent: [number, number, number];
    /** Selection and anything being edited. */
    hot: [number, number, number];
    body: [number, number, number];
    line: [number, number, number];
    dim: [number, number, number];
}

/** Cyan light with amber for what you are touching: the instrument-panel palette (linear colours). */
export const HOLO_PALETTE: CadPalette = {
    accent: [0.25, 0.86, 1.0],
    hot: [1.0, 0.66, 0.2],
    body: [0.075, 0.095, 0.115],
    line: [0.55, 0.93, 1.0],
    dim: [0.3, 0.48, 0.58],
};

/** How the app wants one sketch drawn this frame. */
export interface SketchDraw {
    sketch: string;
    /** The sketch being edited: bright, with points, filled regions and its own grid. */
    active: boolean;
    selectedEntities?: ReadonlySet<string>;
    selectedPoints?: ReadonlySet<string>;
    hoverEntity?: string | null;
    hoverPoint?: string | null;
    /** Entity to show a curvature comb on, and how long its quills are (document units x radius). */
    comb?: { entity: string; scale: number } | null;
    /** Sketch points to draw (id and position), when active. */
    points?: Array<{ id: string; x: number; y: number }>;
}

/** Extra lines in document space: a rubber band, a snap marker, an axis. */
export interface Overlay { segments: number[]; color: [number, number, number, number]; width?: number; dashed?: boolean }

interface LiveBody { key: string; mode: ViewMode; ghost: boolean; meshId: string; edgesId: string | null; item: string }

export class CadView {
    readonly session: string;
    evaluation: CadEvaluation = { ms: 0, built: 0, issues: [], bodies: [], sketches: [] };
    mode: ViewMode = "solid";
    palette: CadPalette = HOLO_PALETTE;
    showEdges = true;
    /** Bodies as faint light, so a sketch drawn inside or behind them stays visible. */
    ghost = false;

    private surface = "";
    private glass = "";
    private lines = "";
    private scene = "";
    private lineItem = "";
    private fillItem = "";
    private floorItem = "";
    private planeItem = "";
    private bodies = new Map<string, LiveBody>();
    private sketchMeshes: string[] = [];
    private planeMesh: string | null = null;
    private planeFor: string | null = null;
    private selected: { body: string | null; face: number } = { body: null, face: -1 };
    private started = Date.now();
    private focus = 3;
    private lastView: { pos: V3; target: V3 } = { pos: [2.6, 1.9, 3.2], target: [0, 0.3, 0] };
    private settle = 0;
    private pendingFrame = 0;
    private frameSelection: string | null = null;

    constructor(private addon: Addon, private app: string) {
        this.session = Entropy.Cad.open();
    }

    /** Creates pipelines, the room and the floor. Call once from onInit. */
    init(): void {
        const groups = [{ entries: [
            { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
            { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
        ] }] as Parameters<typeof Entropy.Pipeline.create>[0]["extraBindGroups"];
        const make = (name: string, shader: string, extra: object) => Entropy.Pipeline.create({ name, layout: "mesh", pbr: false, vertexShader: shader, fragmentShader: shader, extraBindGroups: groups, ...extra });
        this.surface = make(`${this.app}Surface`, CAD_SURFACE_SHADER, {});
        this.glass = make(`${this.app}Glass`, CAD_SURFACE_SHADER, { transparent: true, doubleSided: true });
        this.lines = make(`${this.app}Lines`, CAD_LINE_SHADER, { transparent: true, doubleSided: true });
        this.scene = Entropy.Buffer.create({ size: SCENE_FLOATS * 4, usage: "Uniform" });
        const item = (data: Float32Array) => { const id = Entropy.Buffer.create({ size: ITEM_FLOATS * 4, usage: "Uniform" }); Entropy.Buffer.write(id, data); return id; };
        this.lineItem = item(packItem({ kind: 0, tint: [1, 1, 1] }));
        this.fillItem = item(packItem({ kind: ITEM_KIND.fill, tint: [1, 1, 1] }));
        this.floorItem = item(packItem({ kind: ITEM_KIND.grid, tint: this.palette.dim, step: 10, reach: 1500 }));
        this.planeItem = item(packItem({ kind: ITEM_KIND.grid, tint: this.palette.line, step: 10, reach: 400 }));
        this.writeScene();
        this.createRoom();
        this.takeView();
    }

    private bind(itemBuffer: string): Bindings {
        return [
            { group: 2, binding: 0, resource: { type: "Buffer", value: { id: this.scene } } },
            { group: 2, binding: 1, resource: { type: "Buffer", value: { id: itemBuffer } } },
        ] as Bindings;
    }

    private writeScene(): void {
        const [w, h] = Entropy.Window.getSize();
        Entropy.Buffer.write(this.scene, packScene({
            viewport: [w, h], time: (Date.now() - this.started) / 1000, unit: UNIT, mode: this.mode,
            focus: this.focus, accent: this.palette.accent, keyDir: [0.45, 0.8, 0.4],
        }));
    }

    /** The dark dome everything sits in, and the ground grid. */
    private createRoom(): void {
        const vertexData: number[] = [];
        const indexData: number[] = [];
        const [segs, rings, radius] = [32, 16, 420];
        for (let j = 0; j <= rings; j++) {
            const v = (j / rings) * Math.PI;
            for (let i = 0; i <= segs; i++) {
                const u = (i / segs) * Math.PI * 2;
                vertexData.push(Math.sin(v) * Math.cos(u) * radius, Math.cos(v) * radius, Math.sin(v) * Math.sin(u) * radius, 0, 1, 0, 0, 0, 1, 1, 1, 1);
            }
        }
        for (let j = 0; j < rings; j++) for (let i = 0; i < segs; i++) {
            const a = j * (segs + 1) + i, b = a + 1, c = a + segs + 1, d = c + 1;
            // Wound to be seen from inside.
            indexData.push(a, c, b, b, c, d);
        }
        const backdrop = Entropy.Buffer.create({ size: ITEM_FLOATS * 4, usage: "Uniform" });
        Entropy.Buffer.write(backdrop, packItem({ kind: ITEM_KIND.backdrop, tint: this.palette.dim }));
        this.addon.Model.createMesh({ id: Entropy.generateUUID(), position: [0, 0, 0], vertexData, indexData, pipelineId: this.surface, bindings: this.bind(backdrop) });
        // The ground: the Top plane, whose sketch coordinates are (x, -z).
        const r = 4000;
        this.addon.Model.createMesh({
            id: Entropy.generateUUID(), position: [0, 0, 0], pipelineId: this.glass, bindings: this.bind(this.floorItem),
            vertexData: [[-r, -r], [r, -r], [r, r], [-r, r]].flatMap(([x, z]) => [x, 0, z, 0, 1, 0, x, -z, 1, 1, 1, 1]),
            indexData: [0, 2, 1, 0, 3, 2],
        });
    }

    // --- Evaluation and bodies -------------------------------------------------------------------

    /** Evaluates the document and updates the bodies on screen. Sketches are drawn by `drawSketches`. */
    evaluate(doc: CadDocument, options: { draft?: boolean; sketchesOnly?: boolean } = {}): CadEvaluation {
        this.evaluation = Entropy.Cad.evaluate(this.session, doc, options);
        this.syncBodies();
        return this.evaluation;
    }

    private dropBody(id: string): void {
        const b = this.bodies.get(id);
        if (!b) return;
        this.addon.Model.clearMesh(b.meshId);
        if (b.edgesId) this.addon.Model.clearMesh(b.edgesId);
        Entropy.Buffer.destroy(b.item);
        this.bodies.delete(id);
    }

    private bodyItem(id: string): Float32Array {
        const picked = this.selected.body === id;
        return packItem({ kind: ITEM_KIND.body, tint: this.palette.body, glow: picked ? 1 : 0, face: picked ? this.selected.face : -1, ghost: this.ghost });
    }

    private syncBodies(): void {
        const live = new Set(this.evaluation.bodies.map(b => b.id));
        for (const id of [...this.bodies.keys()]) if (!live.has(id)) this.dropBody(id);
        for (const body of this.evaluation.bodies) {
            const have = this.bodies.get(body.id);
            if (have && have.key === body.key && have.mode === this.mode && have.ghost === this.ghost && !!have.edgesId === this.showEdges) continue;
            this.dropBody(body.id);
            const item = Entropy.Buffer.create({ size: ITEM_FLOATS * 4, usage: "Uniform" });
            Entropy.Buffer.write(item, this.bodyItem(body.id));
            const meshId = Entropy.generateUUID();
            this.addon.Cad.spawnBody(this.session, body.id, { id: meshId, pipelineId: this.mode === "holo" || this.ghost ? this.glass : this.surface, bindings: this.bind(item) });
            let edgesId: string | null = null;
            if (this.showEdges) {
                edgesId = Entropy.generateUUID();
                const strong = !this.ghost && (this.mode === "holo" || this.mode === "solid");
                const color: [number, number, number, number] = this.mode === "zebra" && !this.ghost ? [0.02, 0.03, 0.04, 0.9] : [...this.palette.line, strong ? 0.85 : this.ghost ? 0.3 : 0.5];
                const spawned = this.addon.Cad.spawnLines({
                    id: edgesId, pipelineId: this.lines, bindings: this.bind(this.lineItem),
                    batches: [{ segments: Entropy.Cad.segments(this.session, { kind: "bodyEdges", body: body.id }), color, width: 1.4 }],
                });
                if (!spawned) edgesId = null;
            }
            this.bodies.set(body.id, { key: body.key, mode: this.mode, ghost: this.ghost, meshId, edgesId, item });
        }
    }

    setMode(mode: ViewMode): void {
        if (this.mode === mode) return;
        this.mode = mode;
        this.writeScene();
        this.syncBodies();
    }

    setGhost(ghost: boolean): void {
        if (this.ghost === ghost) return;
        this.ghost = ghost;
        this.syncBodies();
    }

    setEdges(show: boolean): void {
        if (this.showEdges === show) return;
        this.showEdges = show;
        // Bodies without edges yet (or with unwanted ones) are respawned by the key check.
        for (const b of this.bodies.values()) if (!show && b.edgesId) { this.addon.Model.clearMesh(b.edgesId); b.edgesId = null; }
        if (show) { for (const id of [...this.bodies.keys()]) this.dropBody(id); this.syncBodies(); }
    }

    /** Lights up a body (and optionally one of its faces). */
    select(body: string | null, face = -1): void {
        if (this.selected.body === body && this.selected.face === face) return;
        const before = this.selected.body;
        this.selected = { body, face };
        for (const id of new Set([before, body])) {
            const b = id ? this.bodies.get(id) : undefined;
            if (b && id) Entropy.Buffer.write(b.item, this.bodyItem(id));
        }
    }

    // --- Sketches --------------------------------------------------------------------------------

    private clearSketchMeshes(): void {
        for (const id of this.sketchMeshes) this.addon.Model.clearMesh(id);
        this.sketchMeshes = [];
    }

    /**
     * Redraws every sketch (and any overlay lines) from the current evaluation. Call when the
     * evaluation, the selection or the hover changed; it is a few thousand vertices.
     */
    drawSketches(draws: SketchDraw[], overlays: Overlay[] = []): void {
        this.clearSketchMeshes();
        const { accent, hot, line, dim } = this.palette;
        const batches: Parameters<typeof Entropy.Cad.spawnLines>[0]["batches"] = [];
        let activeId: string | null = null;
        for (const d of draws) {
            const sk = this.evaluation.sketches.find(s => s.id === d.sketch);
            if (!sk) continue;
            const at = (x: number, y: number): V3 => [sk.origin[0] + sk.x[0] * x + sk.y[0] * y, sk.origin[1] + sk.x[1] * x + sk.y[1] * y, sk.origin[2] + sk.x[2] * x + sk.y[2] * y];
            if (!d.active) {
                batches.push({ segments: Entropy.Cad.segments(this.session, { kind: "sketch", sketch: d.sketch, construction: false }), color: [...dim, 0.75], width: 1.2 });
                batches.push({ segments: Entropy.Cad.segments(this.session, { kind: "sketch", sketch: d.sketch, construction: true }), color: [...dim, 0.4], width: 1, dashed: true });
                continue;
            }
            activeId = d.sketch;
            // Closed regions first, as a wash under the curves.
            const fillId = Entropy.generateUUID();
            if (this.addon.Cad.spawnRegions(this.session, d.sketch, { id: fillId, pipelineId: this.glass, bindings: this.bind(this.fillItem), color: [...accent, 0.16] })) this.sketchMeshes.push(fillId);
            for (const e of sk.entities) {
                const selected = d.selectedEntities?.has(e.id), hover = d.hoverEntity === e.id;
                const color: [number, number, number, number] = selected ? [...hot, 1] : hover ? [1, 1, 1, 1] : e.construction ? [...dim, 0.8] : [...line, 1];
                batches.push({ segments: Entropy.Cad.segments(this.session, { kind: "sketch", sketch: d.sketch, entity: e.id }), color, width: selected || hover ? 2.6 : 1.9, dashed: e.construction });
            }
            if (d.comb) {
                try { batches.push({ segments: Entropy.Cad.segments(this.session, { kind: "comb", sketch: d.sketch, entity: d.comb.entity, scale: d.comb.scale, quills: 120 }), color: [...hot, 0.55], width: 1 }); } catch { /* the entity was just deleted */ }
            }
            // Points: zero-length segments, which the line shader draws as squares.
            const dots = (pts: Array<{ x: number; y: number }>, color: [number, number, number, number], width: number) => {
                if (pts.length) batches.push({ segments: pts.flatMap(p => { const w = at(p.x, p.y); return [...w, ...w]; }), color, width });
            };
            const pts = d.points ?? [];
            dots(pts.filter(p => !d.selectedPoints?.has(p.id) && d.hoverPoint !== p.id), [...line, 1], 5);
            dots(pts.filter(p => d.hoverPoint === p.id && !d.selectedPoints?.has(p.id)), [1, 1, 1, 1], 8);
            dots(pts.filter(p => d.selectedPoints?.has(p.id)), [...hot, 1], 8);
        }
        for (const o of overlays) batches.push({ segments: o.segments, color: o.color, width: o.width ?? 1.5, dashed: o.dashed });
        const id = Entropy.generateUUID();
        if (this.addon.Cad.spawnLines({ id, pipelineId: this.lines, bindings: this.bind(this.lineItem), batches })) this.sketchMeshes.push(id);
        this.showPlane(activeId);
    }

    /** The active sketch's own grid, lying on its plane. */
    private showPlane(sketchId: string | null): void {
        const sk = sketchId ? this.evaluation.sketches.find(s => s.id === sketchId) : undefined;
        const signature = sk ? JSON.stringify([sk.id, sk.origin, sk.x, sk.y]) : null;
        if (signature === this.planeFor) return;
        if (this.planeMesh) { this.addon.Model.clearMesh(this.planeMesh); this.planeMesh = null; }
        this.planeFor = signature;
        // The floor steps back while a sketch has the stage.
        Entropy.Buffer.write(this.floorItem, packItem({ kind: ITEM_KIND.grid, tint: this.palette.dim, step: this.gridStep(), reach: 1500, opacity: sk ? 0.3 : 1 }));
        if (!sk) return;
        const r = 5000;
        this.planeMesh = Entropy.generateUUID();
        this.addon.Model.createMesh({
            id: this.planeMesh, position: [0, 0, 0], pipelineId: this.glass, bindings: this.bind(this.planeItem),
            vertexData: [[-r, -r], [r, -r], [r, r], [-r, r]].flatMap(([x, y]) => [
                sk.origin[0] + sk.x[0] * x + sk.y[0] * y, sk.origin[1] + sk.x[1] * x + sk.y[1] * y, sk.origin[2] + sk.x[2] * x + sk.y[2] * y,
                ...sk.normal, x, y, 1, 1, 1, 1,
            ]),
            indexData: [0, 1, 2, 0, 2, 3],
        });
    }

    /** Fine grid spacing in document units for the current zoom: 1, 10, 100... */
    gridStep(): number {
        return Math.pow(10, Math.max(0, Math.round(Math.log10(Math.max(this.focus / UNIT, 1) / 25))));
    }

    // --- Camera ----------------------------------------------------------------------------------

    private enableOrbit(target: V3, pos?: V3): void {
        this.addon.Controls.enable("orbit", { target, trigger: "always", button: 1, panButton: 2, zoomButton: -1, panSpeed: 0.005, zoomSpeed: Math.max(0.15, this.focus * 0.08), invertX: true });
        if (pos) seedOrbit(pos, target);
    }

    /** Puts this app's camera, control and sky back (after another app in the suite had the 3D view). */
    private takeView(): void {
        const { pos, target } = this.lastView;
        Entropy.Camera.setTransform(pos, target);
        this.enableOrbit(target, pos);
        Entropy.Lighting.updateSun({ horizonColor: [0.03, 0.045, 0.06], zenithColor: [0.01, 0.014, 0.02], sunDirection: [0.45, 0.8, 0.4], sunColor: [0.8, 0.9, 1], sunIntensity: 0.3 });
        Entropy.setGameMode(false);
        this.settle = 2;
    }

    /** World-space bounds of everything (or one body), or null if there is nothing. */
    private bounds(body: string | null): { min: V3; max: V3 } | null {
        const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
        const add = (p: number[]) => { for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a] * UNIT); max[a] = Math.max(max[a], p[a] * UNIT); } };
        for (const b of this.evaluation.bodies) if (!body || b.id === body) { add(b.min); add(b.max); }
        if (!body) for (const s of this.evaluation.sketches) for (const e of s.entities) for (let i = 0; i < e.points.length; i += 2) {
            const [x, y] = [e.points[i], e.points[i + 1]];
            add([s.origin[0] + s.x[0] * x + s.y[0] * y, s.origin[1] + s.x[1] * x + s.y[1] * y, s.origin[2] + s.x[2] * x + s.y[2] * y]);
        }
        return Number.isFinite(min[0]) ? { min, max } : null;
    }

    /** Frames everything (or one body) on the next frame or two, once new meshes exist. */
    frameSoon(body: string | null = null): void { this.pendingFrame = 2; this.frameSelection = body; }

    /** Frames everything (or one body), keeping the current viewing direction unless one is given (degrees). */
    frame(body: string | null = null, yaw?: number, pitch?: number): void {
        const b = this.bounds(body) ?? this.bounds(null) ?? { min: [-0.5, 0, -0.5] as V3, max: [0.5, 0.5, 0.5] as V3 };
        const c: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
        const r = Math.max(0.05, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2);
        let dir: V3;
        if (yaw !== undefined || pitch !== undefined) {
            const [y, p] = [((yaw ?? 35) * Math.PI) / 180, ((pitch ?? 24) * Math.PI) / 180];
            dir = [Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p)];
        } else {
            const [pos, target] = this.settle > 0 ? [this.lastView.pos, this.lastView.target] : Entropy.Camera.getTransform();
            const d: V3 = [pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]];
            const len = Math.hypot(...d) || 1;
            dir = [d[0] / len, d[1] / len, d[2] / len];
        }
        // The side panels cover part of the view: leave room.
        this.lookFrom(c, dir, r * 2.9 + 0.2);
    }

    private lookFrom(target: V3, dir: V3, distance: number, up?: V3): void {
        const pos: V3 = [target[0] + dir[0] * distance, target[1] + dir[1] * distance, target[2] + dir[2] * distance];
        this.focus = distance;
        Entropy.Camera.setTransform(pos, target, up);
        this.enableOrbit(target, pos);
        this.lastView = { pos, target };
        this.settle = 2;
        this.writeScene();
    }

    /** Looks straight down a sketch's normal, the way it will be drawn on. `tip` leans back a little (degrees). */
    lookAtSketch(sketchId: string, tip = 0): void {
        const sk = this.evaluation.sketches.find(s => s.id === sketchId);
        if (!sk) return;
        let [lo, hi]: [[number, number], [number, number]] = [[Infinity, Infinity], [-Infinity, -Infinity]];
        for (const e of sk.entities) for (let i = 0; i < e.points.length; i += 2) {
            lo = [Math.min(lo[0], e.points[i]), Math.min(lo[1], e.points[i + 1])];
            hi = [Math.max(hi[0], e.points[i]), Math.max(hi[1], e.points[i + 1])];
        }
        if (!Number.isFinite(lo[0])) { lo = [-60, -60]; hi = [60, 60]; }
        const [cx, cy] = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
        const center: V3 = [0, 1, 2].map(a => (sk.origin[a] + sk.x[a] * cx + sk.y[a] * cy) * UNIT) as V3;
        const radius = Math.max(0.3, Math.hypot(hi[0] - lo[0], hi[1] - lo[1]) * UNIT * 0.5);
        const t = (tip * Math.PI) / 180;
        // Lean back about the sketch's x axis: toward its -y.
        const dir: V3 = [0, 1, 2].map(a => sk.normal[a] * Math.cos(t) - sk.y[a] * Math.sin(t)) as V3;
        // A view exactly along the world's up axis needs the sketch's y as "up".
        this.lookFrom(center, dir, radius * 3.2 + 0.3, Math.abs(dir[1]) > 0.99 ? [sk.y[0], sk.y[1], sk.y[2]] : undefined);
    }

    /** Call every frame from onUpdate. */
    tick(): void {
        claimView(this.app, () => this.takeView());
        if (this.pendingFrame > 0 && --this.pendingFrame === 0) this.frame(this.frameSelection);
        const view = orbitView(this.app);
        if (view) this.lastView = view;
        if (this.settle > 0) this.settle--;
        else {
            const [pos, target] = Entropy.Camera.getTransform();
            const focus = Math.hypot(pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]);
            if (Number.isFinite(focus) && focus > 0 && Math.abs(focus - this.focus) > this.focus * 0.04) {
                const stepBefore = this.gridStep();
                this.focus = focus;
                if (this.gridStep() !== stepBefore) this.writeGrids();
            }
        }
        // The scene carries the clock (holo scan lines) and the window size (line widths).
        this.writeScene();
    }

    private writeGrids(): void {
        const step = this.gridStep();
        Entropy.Buffer.write(this.floorItem, packItem({ kind: ITEM_KIND.grid, tint: this.palette.dim, step, reach: step * 150, opacity: this.planeFor ? 0.3 : 1 }));
        Entropy.Buffer.write(this.planeItem, packItem({ kind: ITEM_KIND.grid, tint: this.palette.line, step, reach: step * 40 }));
    }

    // --- Pointer ---------------------------------------------------------------------------------

    private ray(x: number, y: number): { origin: V3; direction: V3 } {
        const r = Entropy.Camera.screenToWorldRay(x, y);
        return { origin: [r.origin[0] / UNIT, r.origin[1] / UNIT, r.origin[2] / UNIT], direction: [r.direction[0], r.direction[1], r.direction[2]] };
    }

    /** The body surface under a screen point. */
    pick(x: number, y: number): CadPick | null {
        const r = this.ray(x, y);
        return Entropy.Cad.pick(this.session, r.origin, r.direction);
    }

    /** A screen point in a sketch's own coordinates. */
    sketchPoint(sketchId: string, x: number, y: number): [number, number] | null {
        const r = this.ray(x, y);
        return Entropy.Cad.sketchPoint(this.session, sketchId, r.origin, r.direction);
    }

    /** How many document units one pixel covers on a sketch plane, near a screen point. */
    pixelSize(sketchId: string, x: number, y: number): number {
        const [a, b] = [this.sketchPoint(sketchId, x, y), this.sketchPoint(sketchId, x + 16, y)];
        if (!a || !b) return this.focus / UNIT / 900;
        return Math.max(1e-6, Math.hypot(b[0] - a[0], b[1] - a[1]) / 16);
    }

    /** What is near a sketch position (see Entropy.Cad.sketchHit), within `pixels` on screen. */
    sketchHit(sketchId: string, at: [number, number], x: number, y: number, pixels = 9, skip: string[] = []): CadSketchHit {
        return Entropy.Cad.sketchHit(this.session, sketchId, at[0], at[1], this.pixelSize(sketchId, x, y) * pixels, skip);
    }

    /** Tears down the session and everything drawn (the app is closing). */
    dispose(): void {
        this.clearSketchMeshes();
        for (const id of [...this.bodies.keys()]) this.dropBody(id);
        if (this.planeMesh) this.addon.Model.clearMesh(this.planeMesh);
        Entropy.Cad.close(this.session);
    }
}
