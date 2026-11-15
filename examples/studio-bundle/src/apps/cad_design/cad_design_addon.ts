// Contour Design: CAD for designers. Draw curves on a plane, turn them into bodies, and keep
// shaping - with the tools that make forms uneven on purpose always within reach: two-sided
// extrudes, lofts between unlike profiles on tipped planes, strokes that are wider on one side,
// revolves that squash and ripple, deformers that act on part of a body, mirrors that don't match.
//
// The first of four CAD apps on one foundation (apps/cad/*.ts and the entropy-cad kernel behind
// Entropy.Cad). The document is plain JSON; this file is the interaction and the panels.
//
// Layout: the 3D view is the whole window. Over it float a tool bar (top), the history of features
// (left), the selected feature's parameters (right) and a readout strip (bottom).

import { type CadDocument, type DeformFeature, type ExtrudeSide, type Feature, type PlaneSpec, type SketchFeature, type SplineEntity, type V2, History, addEntity, addPoint, addSketch, dependents, emptyDocument, entityPoints, featureLabel, findFeature, findSketch, mergePoints, moveFeature, newFeatureIdentity, pointOf, prunePoints, removeEntities, removeFeature, removePoint, round, setSplineWeight, sketchRefs, sketches, splineWeight } from "../cad/cad_doc";
import { VIEW_MODES, type ViewMode } from "../cad/cad_shader";
import { CadView, HOLO_PALETTE, type Overlay, type SketchDraw } from "../cad/cad_view";
import type { IconName } from "../../icon_names";
import { SAMPLES } from "./design_samples";

const APP = "Contour Design";
const addon = Entropy.Addon.register({
    name: APP,
    version: "0.1.0",
    description: "CAD for designers: sketch curves, raise them into bodies, and break symmetry on purpose",
    author: ["Entropy Team", "Claude"],
    capabilities: { graphics: true, ui: true },
});

const W = Entropy.UI.Widget;
const Icons = Entropy.Icons;
type RGBA = [number, number, number, number];
const ACCENT: RGBA = [...HOLO_PALETTE.accent, 1];
const HOT: RGBA = [...HOLO_PALETTE.hot, 1];
const DIM: RGBA = [0.52, 0.66, 0.74, 1];
const FAINT: RGBA = [0.36, 0.47, 0.54, 1];
const WARN: RGBA = [1, 0.45, 0.35, 1];

const view = new CadView(addon, APP);

// --- State ---------------------------------------------------------------------------------------

let doc: CadDocument = emptyDocument();
/** The feature shown in the parameters panel. */
let selectedId: string | null = null;
/** The sketch being drawn in, if any. */
let editingId: string | null = null;
type Tool = "select" | "line" | "rect" | "circle" | "ellipse" | "arc" | "spline" | "cspline";
let tool: Tool = "select";
let selEntities = new Set<string>();
let selPoints = new Set<string>();
let hover: { point: string | null; entity: string | null } = { point: null, entity: null };
let gridSnap = true;
let showComb = false;
let showSketches = true;
let status = "Welcome.";
let cursor: V2 | null = null;

const history = new History<{ doc: CadDocument; selectedId: string | null; editingId: string | null }>(
    () => ({ doc, selectedId, editingId }),
    s => {
        doc = s.doc;
        selectedId = findFeature(doc, s.selectedId) ? s.selectedId : null;
        editingId = findSketch(doc, s.editingId) ? s.editingId : null;
        draft = null; drag = null;
        selEntities = new Set(); selPoints = new Set();
        touch("full");
    },
);

/** What the next frame has to do: nothing, redraw sketches, or re-evaluate at some quality. */
type Work = "none" | "redraw" | "sketch" | "draft" | "full";
const RANK: Record<Work, number> = { none: 0, redraw: 1, sketch: 2, draft: 3, full: 4 };
let work: Work = "none";
let lastEvalQuick = false;
function touch(w: Work): void { if (RANK[w] > RANK[work]) work = w; }

let pointerHeld = false;
const editing = (): SketchFeature | undefined => findSketch(doc, editingId);
const selected = (): Feature | undefined => findFeature(doc, selectedId);

/** A change made from a panel: one undo step per gesture (a whole slider drag). */
function edit(label: string, change: () => void): void {
    history.begin(label);
    change();
    // While the pointer is down this is a drag: rebuild coarsely, and properly on release.
    touch(pointerHeld ? (editingId ? "sketch" : "draft") : "full");
}

function commit(): void {
    if (history.commit()) save();
}

// --- Persistence ---------------------------------------------------------------------------------

function save(): void {
    try { addon.IO.store.write("session.json", JSON.stringify({ version: 1, doc, mode: view.mode, gridSnap, showSketches })); } catch (e) { status = `Couldn't save: ${(e as Error).message}`; }
}

function load(): boolean {
    try {
        const text = addon.IO.store.read("session.json");
        if (!text) return false;
        const data = JSON.parse(text);
        if (!Array.isArray(data.doc?.features)) return false;
        doc = { version: 1, units: "mm", features: data.doc.features };
        if (VIEW_MODES.some(m => m.id === data.mode)) view.mode = data.mode;
        if (typeof data.gridSnap === "boolean") gridSnap = data.gridSnap;
        if (typeof data.showSketches === "boolean") showSketches = data.showSketches;
        return true;
    } catch { return false; }
}

function openDocument(next: CadDocument, message: string): void {
    history.begin("Open");
    doc = next;
    selectedId = null; editingId = null; draft = null; drag = null;
    selEntities = new Set(); selPoints = new Set();
    view.select(null);
    touch("full");
    commit();
    view.frameSoon();
    pendingView = { yaw: 38, pitch: 22 };
    status = message;
}

// --- Evaluation and drawing ----------------------------------------------------------------------

const issueOf = (id: string): string | undefined => view.evaluation.issues.find(i => i.feature === id)?.message;

function evaluate(quality: Work): void {
    const quick = quality !== "full";
    try {
        view.evaluate(doc, { sketchesOnly: quality === "sketch", draft: quality === "draft" });
    } catch (e) { status = (e as Error).message; }
    lastEvalQuick = quick;
}

function redraw(): void {
    view.setGhost(!!editingId);
    const draws: SketchDraw[] = [];
    for (const s of sketches(doc)) {
        if (s.suppressed) continue;
        const isEditing = s.id === editingId;
        const active = isEditing || (!editingId && s.id === selectedId);
        if (!active && !showSketches) continue;
        const one = isEditing && selEntities.size === 1 ? [...selEntities][0] : null;
        draws.push({
            sketch: s.id, active,
            selectedEntities: isEditing ? selEntities : undefined,
            selectedPoints: isEditing ? selPoints : undefined,
            hoverEntity: isEditing ? hover.entity : null,
            hoverPoint: isEditing ? hover.point : null,
            points: isEditing ? s.points : undefined,
            comb: isEditing && showComb && one ? { entity: one, scale: combScale(s, one) } : null,
        });
    }
    view.drawSketches(draws, overlays());
}

/** Quills about a fifth of the curve's size at its tightest bend. */
function combScale(s: SketchFeature, entityId: string): number {
    const e = view.evaluation.sketches.find(k => k.id === s.id)?.entities.find(x => x.id === entityId);
    if (!e || e.points.length < 6) return 100;
    let [lo, hi]: [V2, V2] = [[Infinity, Infinity], [-Infinity, -Infinity]];
    for (let i = 0; i < e.points.length; i += 2) { lo = [Math.min(lo[0], e.points[i]), Math.min(lo[1], e.points[i + 1])]; hi = [Math.max(hi[0], e.points[i]), Math.max(hi[1], e.points[i + 1])]; }
    const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1]);
    return size * size * 0.12;
}

/** The snap marker under the cursor while drawing. */
function overlays(): Overlay[] {
    const s = editing();
    const sk = s && view.evaluation.sketches.find(k => k.id === s.id);
    if (!s || !sk || !snapMark) return [];
    const at = (x: number, y: number) => [0, 1, 2].map(a => sk.origin[a] + sk.x[a] * x + sk.y[a] * y);
    const r = snapMark.size;
    const [x, y] = snapMark.at;
    const ring = [[x - r, y], [x, y + r], [x + r, y], [x, y - r]];
    return [{ segments: ring.flatMap((p, i) => [...at(p[0], p[1]), ...at(ring[(i + 1) % 4][0], ring[(i + 1) % 4][1])]), color: HOT, width: 1.6 }];
}

// --- Drawing tools -------------------------------------------------------------------------------

interface Snap { at: V2; point: string | null; kind: string }
let snapMark: { at: V2; size: number } | null = null;
let mouse: V2 = [0, 0];

/** A tool part-way through: fixed points so far, the point following the cursor, the entity being made. */
interface Draft { tool: Tool; fixed: string[]; cursor: string | null; entity: string | null; stage: number }
let draft: Draft | null = null;
/** A selection being dragged: the points moving and where they started. */
let drag: { start: V2; points: Array<{ id: string; x: number; y: number }>; moved: boolean } | null = null;

function snapAt(x: number, y: number, skip: string[]): Snap | null {
    const s = editing();
    if (!s) return null;
    const raw = view.sketchPoint(s.id, x, y);
    if (!raw) return null;
    const px = view.pixelSize(s.id, x, y);
    const hit = view.sketchHit(s.id, raw, x, y, 12, skip);
    if (hit.kind !== "none") {
        snapMark = { at: hit.at, size: px * (hit.kind === "point" ? 7 : 5) };
        return { at: hit.at, point: hit.point, kind: hit.kind };
    }
    snapMark = null;
    if (!gridSnap) return { at: raw, point: null, kind: "free" };
    // Half the fine grid: 5 mm at arm's length, finer as you zoom in.
    const step = Math.max(view.gridStep() / 2, 0.001);
    return { at: [Math.round(raw[0] / step) * step, Math.round(raw[1] / step) * step], point: null, kind: "grid" };
}

const TOOL_LABEL: Record<Tool, string> = { select: "Select", line: "Line", rect: "Rectangle", circle: "Circle", ellipse: "Ellipse", arc: "Arc", spline: "Spline", cspline: "Control spline" };
const TOOL_HINT: Record<Tool, string> = {
    select: "Click a curve or point; drag to move it. Drop a point on another to join them.",
    line: "Click to place points. Click the last point again (or Esc) to stop; click the first to close.",
    rect: "Click one corner, then the opposite one.",
    circle: "Click the centre, then a point on the circle.",
    ellipse: "Click the centre, then the end of one axis, then the width.",
    arc: "Click the start, the end, then pull the bulge.",
    spline: "Click points for the curve to pass through. Click the last point again to finish, the first to close.",
    cspline: "Click control points that pull the curve. Click the last again to finish, the first to close.",
};

function setTool(next: Tool): void {
    finishDraft();
    tool = next;
    status = TOOL_HINT[next];
    touch("redraw");
}

/** The point to build on: the one snapped to, or a new one there. */
function anchor(s: SketchFeature, snap: Snap): string {
    return snap.point ?? addPoint(s, snap.at[0], snap.at[1]).id;
}

function movePoint(s: SketchFeature, id: string, at: V2): void {
    const p = pointOf(s, id);
    if (p) { p.x = round(at[0]); p.y = round(at[1]); }
}

function startDraft(s: SketchFeature, snap: Snap): void {
    history.begin(TOOL_LABEL[tool]);
    const a = anchor(s, snap);
    const at = snap.at;
    const follow = () => addPoint(s, at[0], at[1]).id;
    switch (tool) {
        case "line": { const c = follow(); draft = { tool, fixed: [a], cursor: c, entity: addEntity(s, { type: "line", a, b: c }).id, stage: 0 }; break; }
        case "arc": { const c = follow(); draft = { tool, fixed: [a], cursor: c, entity: addEntity(s, { type: "line", a, b: c }).id, stage: 0 }; break; }
        case "rect": {
            const [b, c, d] = [follow(), follow(), follow()];
            const ids = [a, b, c, d];
            ids.forEach((p, i) => addEntity(s, { type: "line", a: p, b: ids[(i + 1) % 4] }));
            draft = { tool, fixed: ids, cursor: c, entity: null, stage: 0 };
            break;
        }
        case "circle": draft = { tool, fixed: [a], cursor: null, entity: addEntity(s, { type: "circle", center: a, radius: 0.001 }).id, stage: 0 }; break;
        case "ellipse": draft = { tool, fixed: [a], cursor: null, entity: addEntity(s, { type: "ellipse", center: a, rx: 0.001, ry: 0.001, rotation: 0 }).id, stage: 0 }; break;
        case "spline": case "cspline": {
            const c = follow();
            const e: Omit<SplineEntity, "id"> = { type: "spline", points: [a, c] };
            if (tool === "cspline") e.mode = "control";
            draft = { tool, fixed: [a], cursor: c, entity: addEntity(s, e).id, stage: 0 };
            break;
        }
        default: break;
    }
    touch("sketch");
}

/** The cursor moved while a tool is part-way through. */
function trackDraft(s: SketchFeature, snap: Snap): void {
    const d = draft!;
    const e = s.entities.find(x => x.id === d.entity);
    const origin = pointOf(s, d.fixed[0]);
    if (!origin) return;
    const [dx, dy] = [snap.at[0] - origin.x, snap.at[1] - origin.y];
    switch (d.tool) {
        case "rect":
            movePoint(s, d.fixed[1], [snap.at[0], origin.y]);
            movePoint(s, d.fixed[2], snap.at);
            movePoint(s, d.fixed[3], [origin.x, snap.at[1]]);
            break;
        case "circle": if (e?.type === "circle") e.radius = round(Math.max(0.001, Math.hypot(dx, dy))); break;
        case "ellipse":
            if (e?.type !== "ellipse") break;
            if (d.stage === 0) {
                e.rx = round(Math.max(0.001, Math.hypot(dx, dy)));
                e.rotation = round((Math.atan2(dy, dx) * 180) / Math.PI);
                e.ry = round(e.rx * 0.5);
            } else {
                const t = ((e.rotation ?? 0) * Math.PI) / 180;
                e.ry = round(Math.max(0.001, Math.abs(-Math.sin(t) * dx + Math.cos(t) * dy)));
            }
            break;
        default: if (d.cursor) movePoint(s, d.cursor, snap.at);
    }
    touch("sketch");
}

/** A click while a tool is part-way through. */
function advanceDraft(s: SketchFeature, snap: Snap): void {
    const d = draft!;
    trackDraft(s, snap);
    const last = d.fixed[d.fixed.length - 1];
    switch (d.tool) {
        case "rect": case "circle": draft = null; finished(); return;
        case "ellipse": if (d.stage === 0) { d.stage = 1; return; } draft = null; finished(); return;
        case "arc": {
            if (d.stage === 0) {
                if (snap.point === d.fixed[0]) return;
                // The chord is placed: swap the guide line for an arc whose bulge follows the cursor.
                let b = d.cursor!;
                if (snap.point) { mergePoints(s, b, snap.point); b = snap.point; }
                removeEntities(s, [d.entity!]);
                if (!pointOf(s, b)) b = addPoint(s, snap.at[0], snap.at[1]).id;
                const via = addPoint(s, snap.at[0], snap.at[1]).id;
                draft = { tool: "arc", fixed: [d.fixed[0], b], cursor: via, entity: addEntity(s, { type: "arc", a: d.fixed[0], b, via }).id, stage: 1 };
                touch("sketch");
                return;
            }
            draft = null; finished(); return;
        }
        case "line": {
            if (snap.point === last) { finishDraft(); return; }
            let b = d.cursor!;
            if (snap.point) { mergePoints(s, b, snap.point); b = snap.point; }
            if (b === d.fixed[0] && d.fixed.length > 1) { draft = null; finished(); return; }
            // Each segment is its own undo step.
            commit();
            history.begin("Line");
            const c = addPoint(s, snap.at[0], snap.at[1]).id;
            draft = { tool: "line", fixed: [...d.fixed, b], cursor: c, entity: addEntity(s, { type: "line", a: b, b: c }).id, stage: 0 };
            touch("sketch");
            return;
        }
        case "spline": case "cspline": {
            const e = s.entities.find(x => x.id === d.entity) as SplineEntity | undefined;
            if (!e) { draft = null; return; }
            if (snap.point === last) { finishDraft(); return; }
            if (snap.point === d.fixed[0] && d.fixed.length >= 3) {
                // Back to the start: a closed curve.
                e.points = e.points.filter(p => p !== d.cursor);
                e.closed = true;
                prunePoints(s);
                draft = null; finished(); return;
            }
            let b = d.cursor!;
            if (snap.point && !e.points.includes(snap.point)) {
                e.points = e.points.map(p => (p === b ? snap.point! : p));
                prunePoints(s);
                b = snap.point;
            }
            const c = addPoint(s, snap.at[0], snap.at[1]).id;
            e.points.push(c);
            draft = { ...d, fixed: [...d.fixed, b], cursor: c };
            touch("sketch");
            return;
        }
        default: return;
    }
}

function finished(): void {
    touch("full");
    commit();
    const s = editing();
    const regions = s ? view.evaluation.sketches.find(k => k.id === s.id)?.regions.length ?? 0 : 0;
    status = `${TOOL_LABEL[tool]} placed.${regions ? "" : " Close a shape to make a profile."}`;
}

/** Ends the tool in hand, dropping whatever was still following the cursor. */
function finishDraft(): void {
    const d = draft;
    const s = editing();
    draft = null;
    snapMark = null;
    if (!d || !s) return;
    const e = s.entities.find(x => x.id === d.entity);
    switch (d.tool) {
        case "line": if (d.entity) removeEntities(s, [d.entity]); break;
        case "arc": case "circle": case "ellipse": if (d.entity) removeEntities(s, [d.entity]); break;
        case "rect": removeEntities(s, s.entities.filter(x => entityPoints(x).some(p => d.fixed.includes(p))).map(x => x.id)); break;
        case "spline": case "cspline":
            if (e?.type === "spline") {
                e.points = e.points.filter(p => p !== d.cursor);
                if (e.points.length < 2) removeEntities(s, [e.id]);
            }
            break;
        default: break;
    }
    prunePoints(s);
    touch("full");
    commit();
}

// --- Selection tool ------------------------------------------------------------------------------

function selectAt(s: SketchFeature, at: V2, x: number, y: number, add: boolean): void {
    const hit = view.sketchHit(s.id, at, x, y, 10);
    if (!add) { selEntities = new Set(); selPoints = new Set(); }
    if (hit.kind === "point" && hit.point) {
        selPoints.add(hit.point);
    } else if (hit.entity) {
        if (add && selEntities.has(hit.entity)) selEntities.delete(hit.entity); else selEntities.add(hit.entity);
    }
    const moving = new Set<string>(selPoints);
    for (const id of selEntities) { const e = s.entities.find(q => q.id === id); if (e) for (const p of entityPoints(e)) moving.add(p); }
    drag = moving.size ? { start: at, points: [...moving].map(id => ({ id, ...pick(pointOf(s, id)) })), moved: false } : null;
    touch("redraw");
}
const pick = (p: { x: number; y: number } | undefined) => ({ x: p?.x ?? 0, y: p?.y ?? 0 });

function dragTo(s: SketchFeature, x: number, y: number): void {
    const d = drag!;
    const single = d.points.length === 1 ? d.points[0] : null;
    const snap = snapAt(x, y, d.points.map(p => p.id));
    if (!snap) return;
    const raw = view.sketchPoint(s.id, x, y) ?? snap.at;
    if (!d.moved) {
        if (Math.hypot(raw[0] - d.start[0], raw[1] - d.start[1]) < view.pixelSize(s.id, x, y) * 3) return;
        d.moved = true;
        history.begin("Move");
    }
    if (single) movePoint(s, single.id, snap.at);
    else for (const p of d.points) movePoint(s, p.id, [p.x + raw[0] - d.start[0], p.y + raw[1] - d.start[1]]);
    touch("sketch");
}

function endDrag(s: SketchFeature): void {
    const d = drag;
    drag = null;
    if (!d?.moved) return;
    // A single point dropped on another joins the two.
    if (d.points.length === 1) {
        const p = pointOf(s, d.points[0].id);
        const hit = p && Entropy.Cad.sketchHit(view.session, s.id, p.x, p.y, view.pixelSize(s.id, mouse[0], mouse[1]) * 10, [d.points[0].id]);
        if (hit && hit.kind === "point" && hit.point) {
            mergePoints(s, d.points[0].id, hit.point);
            selPoints = new Set([hit.point]);
            status = "Joined.";
        }
    }
    snapMark = null;
    touch("full");
    commit();
}

function deleteSelection(): void {
    const s = editing();
    if (s) {
        if (!selEntities.size && !selPoints.size) return;
        edit("Delete", () => {
            removeEntities(s, [...selEntities]);
            for (const p of selPoints) removePoint(s, p);
        });
        selEntities = new Set(); selPoints = new Set();
        commit();
        return;
    }
    if (selectedId) removeSelectedFeature();
}

// --- Input ---------------------------------------------------------------------------------------

let downAt: V2 | null = null;

addon.Input.onMouseDown((button, x, y) => {
    mouse = [x, y];
    if (button !== 0) return;
    pointerHeld = true;
    downAt = addon.Input.isPointerOverUI() ? null : [x, y];
    const s = editing();
    if (!downAt || !s) return;
    if (tool === "select") {
        const at = view.sketchPoint(s.id, x, y);
        if (at) selectAt(s, at, x, y, Entropy.Input.isShiftPressed());
        return;
    }
    const snap = snapAt(x, y, draft?.cursor ? [draft.cursor] : draft?.tool === "rect" ? draft.fixed.slice(1) : []);
    if (!snap) return;
    if (draft) advanceDraft(s, snap); else startDraft(s, snap);
});

addon.Input.onMouseMove((x, y) => {
    mouse = [x, y];
    const s = editing();
    if (!s || addon.Input.isPointerOverUI()) return;
    cursor = view.sketchPoint(s.id, x, y);
    if (drag && pointerHeld) { dragTo(s, x, y); return; }
    if (draft) {
        const snap = snapAt(x, y, draft.cursor ? [draft.cursor] : draft.tool === "rect" ? draft.fixed.slice(1) : []);
        if (snap) trackDraft(s, snap);
        return;
    }
    if (!cursor) return;
    if (tool === "select") {
        const hit = view.sketchHit(s.id, cursor, x, y, 10);
        const next = { point: hit.kind === "point" ? hit.point : null, entity: hit.kind === "point" ? null : hit.entity };
        if (next.point !== hover.point || next.entity !== hover.entity) { hover = next; touch("redraw"); }
    } else {
        const before = snapMark;
        snapAt(x, y, []);
        if (before || snapMark) touch("redraw");
    }
});

addon.Input.onMouseUp(button => {
    if (button !== 0) return;
    pointerHeld = false;
    const start = downAt;
    downAt = null;
    const s = editing();
    if (s) { if (drag) endDrag(s); return; }
    if (!start || Math.hypot(mouse[0] - start[0], mouse[1] - start[1]) > 4) return;
    // A click in the model: the body under it, and the feature that made that face.
    const hit = view.pick(mouse[0], mouse[1]);
    if (!hit) { select(null); return; }
    select(findFeature(doc, hit.feature) ? hit.feature : hit.body);
    view.select(hit.body, hit.faceIndex);
});

addon.Input.onKeyDown((key, ctrl, shift) => {
    if (Entropy.UI.keyboardState().typing) return;
    const k = key.toLowerCase();
    if (ctrl && k === "z") { if (shift) redo(); else undo(); return; }
    if (ctrl && k === "y") { redo(); return; }
    if (k === "escape") { if (draft) finishDraft(); else if (tool !== "select") setTool("select"); else if (editingId) editSketch(null); return; }
    if (k === "enter") { if (draft) finishDraft(); return; }
    if (k === "delete" || k === "backspace") { deleteSelection(); return; }
    if (k === "f") { view.frame(bodyOf(selectedId)); return; }
    if (!editingId || ctrl) return;
    const keys: Record<string, Tool> = { v: "select", l: "line", r: "rect", c: "circle", e: "ellipse", a: "arc", s: "spline", b: "cspline" };
    if (keys[k]) setTool(keys[k]);
});

// --- Document operations -------------------------------------------------------------------------

function select(id: string | null): void {
    if (selectedId === id) return;
    selectedId = id;
    view.select(bodyOf(id));
    touch("redraw");
}

/** The body a feature made or works on, if it is on screen. */
function bodyOf(id: string | null): string | null {
    const f = findFeature(doc, id);
    if (!f || f.type === "sketch") return null;
    const bodies = view.evaluation.bodies;
    if (bodies.some(b => b.id === f.id)) return f.id;
    const made = bodies.find(b => b.faces.some(face => face.feature === f.id));
    if (made) return made.id;
    if ("target" in f && f.target) return bodies.some(b => b.id === f.target) ? f.target! : null;
    return bodies.length ? bodies[bodies.length - 1].id : null;
}

function undo(): void {
    const label = history.undo();
    status = label ? `Undid ${label.toLowerCase()}.` : "Nothing to undo.";
    if (label) save();
}
function redo(): void {
    const label = history.redo();
    status = label ? `Redid ${label.toLowerCase()}.` : "Nothing to redo.";
    if (label) save();
}

/** Starts (or, with null, leaves) drawing in a sketch. */
function editSketch(id: string | null): void {
    finishDraft();
    drag = null;
    selEntities = new Set(); selPoints = new Set();
    hover = { point: null, entity: null };
    snapMark = null;
    tool = "select";
    editingId = findSketch(doc, id) ? id : null;
    if (editingId) {
        selectedId = editingId;
        view.select(null);
        // Draw looking at the plane, leaning back a little so depth still reads.
        pendingLook = editingId;
        status = "Drawing. Pick a tool; Esc leaves the sketch.";
    } else {
        status = "Back in the model.";
    }
    touch("full");
}

function newSketch(base: PlaneSpec["base"]): void {
    finishDraft();
    history.begin("New sketch");
    const s = addSketch(doc, { base });
    touch("sketch");
    commit();
    evaluate("sketch");
    editSketch(s.id);
    tool = "spline";
    status = `New sketch on the ${base} plane. ${TOOL_HINT.spline}`;
}

const regionsOf = (id: string): number => view.evaluation.sketches.find(k => k.id === id)?.regions.length ?? 0;
const chainsOf = (id: string): number => view.evaluation.sketches.find(k => k.id === id)?.chains.length ?? 0;
const usedSketches = (): Set<string> => new Set(doc.features.flatMap(sketchRefs));

/** The sketch a new feature should read: the selected one, else the newest unused one with a closed profile. */
function profileSketch(): string | null {
    const s = selected();
    if (s?.type === "sketch" && regionsOf(s.id)) return s.id;
    const used = usedSketches();
    const all = sketches(doc).filter(k => regionsOf(k.id));
    return ([...all].reverse().find(k => !used.has(k.id)) ?? all[all.length - 1])?.id ?? null;
}

function addFeature(feature: Feature, message: string): Feature {
    finishDraft();
    if (editingId) editSketch(null);
    history.begin(`Add ${feature.name}`);
    doc.features.push(feature);
    selectedId = feature.id;
    touch("full");
    commit();
    status = message;
    return feature;
}

const defaultOp = () => (view.evaluation.bodies.length ? "add" : "new") as "add" | "new";
const NEED_PROFILE = "Draw a closed shape in a sketch first (a circle, a closed spline, or lines joined end to end).";

function addExtrude(): void {
    const sketch = profileSketch();
    if (!sketch) { status = NEED_PROFILE; return; }
    addFeature({ ...newFeatureIdentity(doc, "extrude"), type: "extrude", profile: { sketch }, forward: { distance: 30 }, backward: { distance: 0 }, op: defaultOp() }, "Extruded. Each side has its own distance, scale, shift, twist and bulge.");
}

function addRevolve(): void {
    const sketch = profileSketch();
    if (!sketch) { status = NEED_PROFILE; return; }
    // A construction line in the sketch is the natural axis.
    const axis = findSketch(doc, sketch)?.entities.find(e => e.type === "line" && e.construction)?.id;
    addFeature({ ...newFeatureIdentity(doc, "revolve"), type: "revolve", profile: { sketch }, axis: axis ? { entity: axis } : { origin: [0, 0], dir: [0, 1] }, start: 0, end: 360, op: defaultOp() }, axis ? "Revolved about the sketch's construction line." : "Revolved about the sketch's y axis. Draw a construction line to use as the axis instead.");
}

function addLoft(): void {
    const used = usedSketches();
    let picks = sketches(doc).filter(k => regionsOf(k.id) && !used.has(k.id));
    if (picks.length < 2) picks = sketches(doc).filter(k => regionsOf(k.id));
    if (picks.length < 2) { status = "A loft joins two or more sketches, each with a closed shape, on different planes."; return; }
    addFeature({ ...newFeatureIdentity(doc, "loft"), type: "loft", sections: picks.map(k => ({ profile: { sketch: k.id } })), op: defaultOp() }, `Lofted through ${picks.length} sketches. They need not match or be parallel.`);
}

function addSweep(): void {
    const used = usedSketches();
    const profile = profileSketch();
    const paths = sketches(doc).filter(k => k.id !== profile && (chainsOf(k.id) || regionsOf(k.id)));
    const path = (paths.find(k => chainsOf(k.id) && !used.has(k.id)) ?? paths.find(k => chainsOf(k.id)) ?? paths[0])?.id;
    if (!profile || !path) { status = "A sweep needs a closed shape in one sketch and a curve to follow in another."; return; }
    addFeature({ ...newFeatureIdentity(doc, "sweep"), type: "sweep", profile: { sketch: profile }, path: { sketch: path }, op: defaultOp() }, "Swept. Scale and twist change the profile along the path.");
}

function addDeform(kind: DeformFeature["kind"]): void {
    if (!view.evaluation.bodies.length) { status = "Make a body first: deformers reshape one."; return; }
    const label = { twist: "Twist", bend: "Bend", taper: "Taper", shear: "Shear" }[kind];
    const start: Partial<DeformFeature> = kind === "twist" ? { angle: 45 } : kind === "bend" ? { angle: 30, toward: "x" } : kind === "taper" ? { scale: [0.6, 1] } : { shift: [20, 0] };
    addFeature({ ...newFeatureIdentity(doc, "deform", label), type: "deform", kind, axis: "y", from: 0, to: 1, ...start, target: bodyOf(selectedId) ?? undefined } as DeformFeature, `${label} added. From and To choose which part of the body it acts on.`);
}

function addMirror(): void {
    if (!view.evaluation.bodies.length) { status = "Make a body first: a mirror reflects one."; return; }
    addFeature({ ...newFeatureIdentity(doc, "mirror"), type: "mirror", plane: { base: "side" }, scale: [1, 1, 1], shift: [0, 0, 0], merge: true, target: bodyOf(selectedId) ?? undefined }, "Mirrored. Scale and shift apply to the reflected half only, so the two sides need not match.");
}

function removeSelectedFeature(): void {
    const f = selected();
    if (!f) return;
    history.begin(`Delete ${f.name}`);
    const gone = removeFeature(doc, f.id);
    if (editingId && gone.includes(editingId)) editingId = null;
    selectedId = null;
    view.select(null);
    touch("full");
    commit();
    status = gone.length > 1 ? `Deleted ${f.name} and ${gone.length - 1} that depended on it.` : `Deleted ${f.name}.`;
}

function exportModel(format: "stl" | "obj", path?: string) {
    const target = path ?? `contour-export.${format}`;
    const r = Entropy.Cad.export(view.session, format, target);
    status = r.success ? `Exported ${view.evaluation.bodies.length} bod${view.evaluation.bodies.length === 1 ? "y" : "ies"} to ${r.path}.` : `Export failed: ${r.error}`;
    return r;
}

// --- Panels --------------------------------------------------------------------------------------

let toolbarWindow = "";
let historyWindow = "";
let paramsWindow = "";
let readoutWindow = "";

const FEATURE_ICON: Record<Feature["type"], IconName> = { sketch: "pencil-simple", extrude: "arrow-fat-lines-up", revolve: "arrows-clockwise", loft: "stack", sweep: "path", deform: "tornado", mirror: "flip-horizontal" };
const TOOL_ICON: Record<Tool, IconName> = { select: "cursor", line: "line-segment", rect: "rectangle", circle: "circle", ellipse: "circle-dashed", arc: "angle", spline: "bezier-curve", cspline: "vector-three" };

const heading = (id: string, text: string) => W.label(id, { text: text.toUpperCase(), color: ACCENT, monospace: true, fontSize: 11 });
const note = (id: string, text: string, color: RGBA = DIM) => W.label(id, { text, color, wrap: true });

function toolButton(id: string, key: string, icon: IconName, text: string, tooltip: string, onClick: () => void, extra: { selected?: boolean; shortcut?: string; accent?: RGBA } = {}): void {
    W.button(id, { id: key, text: Icons.label(icon, text), tooltip, onClick, ...extra });
}

function renderToolbar(): void {
    const id = toolbarWindow;
    const s = editing();
    W.horizontal(id, () => {
        W.label(id, { text: "CONTOUR", bold: true, color: ACCENT, monospace: true, fontSize: 15 });
        W.label(id, { text: s ? `// SKETCH · ${s.name.toUpperCase()}` : "// DESIGN", color: s ? HOT : FAINT, monospace: true, fontSize: 12 });
        W.spacer(id, 10);
        if (s) {
            for (const t of Object.keys(TOOL_LABEL) as Tool[]) {
                const shortcut = { select: "V", line: "L", rect: "R", circle: "C", ellipse: "E", arc: "A", spline: "S", cspline: "B" }[t];
                toolButton(id, `cad-tool-${t}`, TOOL_ICON[t], TOOL_LABEL[t], TOOL_HINT[t], () => setTool(t), { selected: tool === t, shortcut });
            }
            W.spacer(id, 10);
            toolButton(id, "cad-finish-sketch", "check", "Done", "Leave the sketch and return to the model", () => editSketch(null), { accent: HOT, shortcut: "Esc" });
        } else {
            toolButton(id, "cad-sketch-top", "pencil-simple", "Sketch", "Start drawing on the ground plane (pick Front or Side in its parameters)", () => newSketch("top"), { accent: ACCENT });
            toolButton(id, "cad-extrude", FEATURE_ICON.extrude, "Extrude", "Raise a closed shape into a body, either way from its plane", addExtrude);
            toolButton(id, "cad-revolve", FEATURE_ICON.revolve, "Revolve", "Turn a shape about an axis: rings, vessels, coils", addRevolve);
            toolButton(id, "cad-loft", FEATURE_ICON.loft, "Loft", "Skin smoothly through several sketches", addLoft);
            toolButton(id, "cad-sweep", FEATURE_ICON.sweep, "Sweep", "Carry a shape along a curve", addSweep);
            W.spacer(id, 10);
            toolButton(id, "cad-twist", "tornado", "Twist", "Turn part of a body about an axis", () => addDeform("twist"));
            toolButton(id, "cad-bend", "angle", "Bend", "Curl part of a body", () => addDeform("bend"));
            toolButton(id, "cad-taper", "funnel-simple", "Taper", "Narrow a body along an axis, each cross direction on its own", () => addDeform("taper"));
            toolButton(id, "cad-shear", "arrows-out-line-vertical", "Shear", "Slide one end of a body sideways", () => addDeform("shear"));
            toolButton(id, "cad-mirror", FEATURE_ICON.mirror, "Mirror", "Reflect a body; the reflection can be scaled and shifted", addMirror);
        }
    });
    W.horizontal(id, () => {
        W.button(id, { id: "cad-undo", text: Icons.get("arrow-u-up-left"), tooltip: "Undo", shortcut: "Ctrl+Z", onClick: undo, disabled: !history.depth.undo });
        W.button(id, { id: "cad-redo", text: Icons.get("arrow-u-up-right"), tooltip: "Redo", shortcut: "Ctrl+Shift+Z", onClick: redo, disabled: !history.depth.redo });
        W.segmented(id, { id: "cad-view-mode", label: "View", options: VIEW_MODES.map(m => m.label), selectedIndex: VIEW_MODES.findIndex(m => m.id === view.mode), compact: true, accent: ACCENT, onChange: i => setMode(VIEW_MODES[Number(i)].id) });
        W.button(id, { id: "cad-frame", text: Icons.label("corners-out", "Frame"), tooltip: "Fit the model (or the selected body) in view", shortcut: "F", onClick: () => view.frame(bodyOf(selectedId)) });
        W.checkbox(id, { id: "cad-show-sketches", label: "Sketches", value: showSketches, tooltip: "Show sketches that are not selected", onChange: v => { showSketches = v; touch("redraw"); save(); } });
        if (s) {
            W.checkbox(id, { id: "cad-grid-snap", label: "Snap to grid", value: gridSnap, onChange: v => { gridSnap = v; save(); } });
            W.checkbox(id, { id: "cad-comb", label: "Curvature comb", value: showComb, tooltip: "Quills on the selected curve, as long as it is tightly bent there: an even comb is a fair curve", onChange: v => { showComb = v; touch("redraw"); } });
        } else {
            W.dropdown(id, { id: "cad-sample", label: "Open", options: ["Sample...", ...SAMPLES.map(x => x.name)], selectedIndex: 0, onChange: i => { const x = SAMPLES[Number(i) - 1]; if (x) openDocument(x.build(), `${x.name}: ${x.description}.`); } });
            W.button(id, { id: "cad-export-stl", text: Icons.label("export", "STL"), tooltip: "Write every body as binary STL", onClick: () => exportModel("stl") });
            W.button(id, { id: "cad-export-obj", text: Icons.label("export", "OBJ"), tooltip: "Write every body as OBJ with smooth normals and named faces", onClick: () => exportModel("obj") });
        }
    });
}

function setMode(mode: ViewMode): void {
    view.setMode(mode);
    status = VIEW_MODES.find(m => m.id === mode)!.hint + ".";
    save();
}

function renderHistory(): void {
    const id = historyWindow;
    heading(id, "History");
    if (!doc.features.length) note(id, "Nothing yet. Press Sketch and draw a closed curve, or open a sample.");
    W.treeView(id, {
        id: "cad-history",
        nodes: doc.features.map(f => ({
            id: f.id, label: f.name, depth: f.type === "sketch" ? 0 : 0, selected: f.id === selectedId,
            icon: Icons.get(issueOf(f.id) ? "warning" : FEATURE_ICON[f.type]),
            detail: f.suppressed ? "off" : issueOf(f.id) ? "!" : f.id === editingId ? "drawing" : "",
        })),
        onSelect: fid => { if (editingId && fid !== editingId) editSketch(null); select(fid); },
    });
    const f = selected();
    if (f) {
        W.horizontal(id, () => {
            W.button(id, { id: "cad-move-up", text: Icons.get("arrow-fat-lines-up"), tooltip: "Earlier in the history", onClick: () => edit("Reorder", () => { if (!moveFeature(doc, f.id, -1)) status = "It can't go ahead of something it depends on."; }) });
            W.button(id, { id: "cad-suppress", text: Icons.label("eye", f.suppressed ? "Enable" : "Suppress"), tooltip: "Skip this feature without deleting it", onClick: () => edit("Suppress", () => { if (f.suppressed) delete f.suppressed; else f.suppressed = true; }) });
            W.button(id, { id: "cad-delete", text: Icons.label("trash", "Delete"), shortcut: "Del", onClick: removeSelectedFeature });
        });
    }
    W.separator(id);
    heading(id, "Bodies");
    const bodies = view.evaluation.bodies;
    if (!bodies.length) note(id, "No bodies yet.", FAINT);
    for (const b of bodies) {
        const size = [0, 1, 2].map(a => b.max[a] - b.min[a]);
        W.label(id, { text: b.name || b.id, bold: true });
        W.label(id, { text: `${size.map(v => v.toFixed(1)).join(" × ")} mm`, color: DIM, monospace: true });
        W.label(id, { text: `${(b.volume / 1000).toFixed(2)} cm³ · ${(b.area / 100).toFixed(1)} cm²`, color: DIM, monospace: true });
        W.label(id, { text: `${b.triangles.toLocaleString()} tris · ${b.faces.length} faces`, color: FAINT, monospace: true });
    }
}

/** A slider bound to a number in the document. */
function num(label: string, value: number, min: number, max: number, set: (v: number) => void, o: { unit?: string; decimals?: number; tip?: string; key?: string } = {}): void {
    const f = selected();
    W.slider(paramsWindow, {
        id: `cad-p-${o.key ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, label, value, min, max, unit: o.unit, decimals: o.decimals ?? (max - min <= 4 ? 2 : 1), tooltip: o.tip,
        onChange: v => edit(`Change ${label.toLowerCase()}${f ? ` of ${f.name}` : ""}`, () => set(round(Number(v)))),
    });
}

function choice<T extends string>(label: string, options: readonly T[], names: string[], value: T, set: (v: T) => void, key?: string): void {
    W.segmented(paramsWindow, { id: `cad-p-${key ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, label, options: names, selectedIndex: Math.max(0, options.indexOf(value)), compact: true, accent: ACCENT, onChange: i => edit(`Change ${label.toLowerCase()}`, () => set(options[Number(i)])) });
}

function toggle(label: string, value: boolean, set: (v: boolean) => void, tip?: string, key?: string): void {
    W.checkbox(paramsWindow, { id: `cad-p-${key ?? label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, label, value, tooltip: tip, onChange: v => edit(`Change ${label.toLowerCase()}`, () => set(v)) });
}

function opChoice(f: Extract<Feature, { op: string }>): void {
    choice("Result", ["new", "add", "cut", "intersect"] as const, ["New body", "Join", "Cut", "Intersect"], f.op, v => { f.op = v; });
}

function planeControls(plane: PlaneSpec, prefix: string): void {
    choice("Plane", ["top", "front", "side"] as const, ["Top", "Front", "Side"], plane.base, v => { plane.base = v; }, `${prefix}-plane`);
    num("Offset", plane.offset ?? 0, -300, 300, v => { plane.offset = v; }, { unit: "mm", key: `${prefix}-offset`, tip: "Distance along the plane's normal" });
    num("Tilt X", plane.tiltX ?? 0, -90, 90, v => { plane.tiltX = v; }, { unit: "°", decimals: 0, key: `${prefix}-tiltx`, tip: "Tip the plane about its own x axis" });
    num("Tilt Y", plane.tiltY ?? 0, -90, 90, v => { plane.tiltY = v; }, { unit: "°", decimals: 0, key: `${prefix}-tilty`, tip: "Tip the plane about its own y axis" });
    num("Spin", plane.spin ?? 0, -180, 180, v => { plane.spin = v; }, { unit: "°", decimals: 0, key: `${prefix}-spin` });
}

function sideControls(title: string, side: ExtrudeSide, key: string): void {
    const id = paramsWindow;
    W.collapsingHeader(id, title, () => {
        num("Distance", side.distance, 0, 300, v => { side.distance = v; }, { unit: "mm", key: `${key}-distance` });
        num("Scale X", side.scale?.[0] ?? 1, 0.05, 3, v => { side.scale = [v, side.scale?.[1] ?? 1]; }, { key: `${key}-scale-x`, tip: "Width of the far end relative to the profile" });
        num("Scale Y", side.scale?.[1] ?? 1, 0.05, 3, v => { side.scale = [side.scale?.[0] ?? 1, v]; }, { key: `${key}-scale-y` });
        num("Shift X", side.shift?.[0] ?? 0, -150, 150, v => { side.shift = [v, side.shift?.[1] ?? 0]; }, { unit: "mm", key: `${key}-shift-x`, tip: "Slide the far end sideways: a leaning extrude" });
        num("Shift Y", side.shift?.[1] ?? 0, -150, 150, v => { side.shift = [side.shift?.[0] ?? 0, v]; }, { unit: "mm", key: `${key}-shift-y` });
        num("Twist", side.twist ?? 0, -360, 360, v => { side.twist = v; }, { unit: "°", decimals: 0, key: `${key}-twist` });
        num("Bulge", side.bulge ?? 0, -0.9, 1.5, v => { side.bulge = v; }, { key: `${key}-bulge`, tip: "Swell (or pinch) the walls mid-way" });
    }, `cad-group-${key}`, side.distance > 0);
}

function sketchPicker(label: string, value: string, set: (id: string) => void, key: string, filter: (id: string) => boolean = () => true): void {
    const all = sketches(doc).filter(s => filter(s.id) || s.id === value);
    W.dropdown(paramsWindow, { id: `cad-p-${key}`, label, options: all.map(s => s.name), selectedIndex: Math.max(0, all.findIndex(s => s.id === value)), onChange: i => { const s = all[Number(i)]; if (s) edit(`Change ${label.toLowerCase()}`, () => set(s.id)); } });
}

function targetPicker(f: { target?: string }): void {
    const bodies = view.evaluation.bodies;
    if (bodies.length < 2) return;
    const options = ["Latest body", ...bodies.map(b => b.name || b.id)];
    W.dropdown(paramsWindow, { id: "cad-p-target", label: "Body", options, selectedIndex: Math.max(0, bodies.findIndex(b => b.id === f.target) + 1), onChange: i => edit("Change body", () => { const b = bodies[Number(i) - 1]; if (b) f.target = b.id; else delete f.target; }) });
}

function renderEntityParams(s: SketchFeature): void {
    const id = paramsWindow;
    const e = selEntities.size === 1 ? s.entities.find(x => x.id === [...selEntities][0]) : undefined;
    const p = selPoints.size === 1 ? pointOf(s, [...selPoints][0]) : undefined;
    if (p) {
        heading(id, "Point");
        num("X", p.x, p.x - 100, p.x + 100, v => { p.x = v; }, { unit: "mm", key: "point-x" });
        num("Y", p.y, p.y - 100, p.y + 100, v => { p.y = v; }, { unit: "mm", key: "point-y" });
        // A point on a spline carries that spline's weight for it.
        for (const sp of s.entities) {
            if (sp.type !== "spline") continue;
            const at = sp.points.indexOf(p.id);
            if (at < 0) continue;
            const through = sp.mode !== "control";
            num(through ? "Tension" : "Pull", splineWeight(sp, at), 0.1, through ? 3 : 8, v => setSplineWeight(sp, at, v), { key: "point-weight", tip: through ? "How wide the curve swings through this point: makes one side fuller without adding points" : "How hard this control point pulls the curve toward itself" });
        }
    }
    if (!e) {
        if (!p) note(id, selEntities.size > 1 ? `${selEntities.size} curves selected. Drag to move them, Del to delete.` : "Select a curve or a point to edit it.", FAINT);
        return;
    }
    heading(id, { line: "Line", arc: "Arc", circle: "Circle", ellipse: "Ellipse", spline: "Spline" }[e.type]);
    if (e.type === "circle") num("Radius", e.radius, 0.1, 300, v => { e.radius = v; }, { unit: "mm" });
    if (e.type === "ellipse") {
        num("Radius X", e.rx, 0.1, 300, v => { e.rx = v; }, { unit: "mm" });
        num("Radius Y", e.ry, 0.1, 300, v => { e.ry = v; }, { unit: "mm" });
        num("Turn", e.rotation ?? 0, -180, 180, v => { e.rotation = v; }, { unit: "°", decimals: 0 });
    }
    if (e.type === "spline") {
        choice("Kind", ["through", "control"] as const, ["Through points", "Control points"], e.mode ?? "through", v => { if (v === "control") e.mode = "control"; else delete e.mode; });
        toggle("Closed", !!e.closed, v => { if (v && e.points.length >= 3) e.closed = true; else delete e.closed; });
    }
    toggle("Construction", !!e.construction, v => { if (v) e.construction = true; else delete e.construction; }, "A guide (an axis, a centre line): drawn dashed, never part of a profile");
    if (e.type !== "circle" && e.type !== "ellipse" || e.stroke) {
        toggle("Stroke", !!e.stroke, v => { if (v) e.stroke = { left: 4, right: 4, start: 1, middle: 1, end: 1, round: true }; else delete e.stroke; }, "Give the curve a body: an outline around it, as wide as you like on each side");
        const k = e.stroke;
        if (k) {
            num("Left", k.left, 0, 80, v => { k.left = v; }, { unit: "mm", key: "stroke-left", tip: "Half width to the left of the direction of travel" });
            num("Right", k.right, 0, 80, v => { k.right = v; }, { unit: "mm", key: "stroke-right" });
            num("Start", k.start, 0, 2, v => { k.start = v; }, { key: "stroke-start", tip: "Width scale at the start of the curve (0 comes to a point)" });
            num("Middle", k.middle, 0, 2, v => { k.middle = v; }, { key: "stroke-middle" });
            num("End", k.end, 0, 2, v => { k.end = v; }, { key: "stroke-end" });
            toggle("Round ends", k.round, v => { k.round = v; }, undefined, "stroke-round");
        }
    }
}

function renderParams(): void {
    const id = paramsWindow;
    const f = selected();
    if (!f) {
        heading(id, "Parameters");
        note(id, "Select a feature in the history, or click a body.");
        W.spacer(id, 6);
        heading(id, "Controls");
        for (const tip of ["Right-drag orbits, middle-drag pans, the wheel zooms.", "F frames the model or the selected body.", "A sketch is curves on a plane; closed shapes become profiles.", "Every feature keeps its parameters: select it and change them any time."]) note(id, `· ${tip}`, FAINT);
        return;
    }
    W.horizontal(id, () => {
        W.label(id, { text: Icons.get(FEATURE_ICON[f.type]), fontSize: 20, color: ACCENT });
        W.vertical(id, () => {
            W.label(id, { text: f.name, bold: true, fontSize: 15 });
            W.label(id, { text: `${featureLabel(f.type).toUpperCase()} · ${f.id}`, color: FAINT, monospace: true, fontSize: 11 });
        });
    });
    const issue = issueOf(f.id);
    if (issue) note(id, `${Icons.get("warning")} ${issue.charAt(0).toUpperCase()}${issue.slice(1)}.`, WARN);
    switch (f.type) {
        case "sketch": {
            const k = view.evaluation.sketches.find(x => x.id === f.id);
            if (editingId === f.id) { renderEntityParams(f); W.separator(id); }
            else W.button(id, { id: "cad-edit-sketch", text: Icons.label("pencil-simple", "Draw in this sketch"), accent: ACCENT, onClick: () => editSketch(f.id) });
            note(id, k ? `${f.entities.length} curve${f.entities.length === 1 ? "" : "s"} · ${k.regions.length} closed profile${k.regions.length === 1 ? "" : "s"} · ${k.chains.length} open path${k.chains.length === 1 ? "" : "s"}` : "", DIM);
            W.collapsingHeader(id, "Plane", () => planeControls(f.plane, "sketch"), "cad-group-plane", editingId !== f.id);
            break;
        }
        case "extrude":
            sketchPicker("Profile", f.profile.sketch, v => { f.profile = { sketch: v }; }, "profile", sid => regionsOf(sid) > 0);
            opChoice(f);
            sideControls("Forward", f.forward, "forward");
            sideControls("Backward", f.backward, "backward");
            break;
        case "revolve": {
            sketchPicker("Profile", f.profile.sketch, v => { f.profile = { sketch: v }; delete f.axis.entity; }, "profile", sid => regionsOf(sid) > 0);
            opChoice(f);
            const lines = (findSketch(doc, f.profile.sketch)?.entities ?? []).filter(e => e.type === "line");
            const options = ["Sketch Y axis", "Sketch X axis", ...lines.map(e => `Line ${e.id}${e.construction ? " (construction)" : ""}`)];
            const current = f.axis.entity ? 2 + lines.findIndex(e => e.id === f.axis.entity) : (f.axis.dir?.[0] ?? 0) !== 0 ? 1 : 0;
            W.dropdown(id, { id: "cad-p-axis", label: "Axis", options, selectedIndex: Math.max(0, current), onChange: i => edit("Change axis", () => { const n = Number(i); f.axis = n === 0 ? { origin: [0, 0], dir: [0, 1] } : n === 1 ? { origin: [0, 0], dir: [1, 0] } : { entity: lines[n - 2].id }; }) });
            num("Start", f.start, -360, 360, v => { f.start = v; }, { unit: "°", decimals: 0 });
            num("End", f.end, -360, 1440, v => { f.end = v; }, { unit: "°", decimals: 0, tip: "More than 360 with Pitch makes a coil" });
            W.collapsingHeader(id, "Out of round", () => {
                num("Squash", f.squash ?? 1, 0.2, 2, v => { f.squash = v; }, { tip: "Flatten the turning circle into an ellipse" });
                num("Lobes", f.lobes ?? 0, 0, 12, v => { f.lobes = Math.round(v); }, { decimals: 0, tip: "Ripples around the turn" });
                num("Lobe depth", f.lobeDepth ?? 0, 0, 0.5, v => { f.lobeDepth = v; });
                num("Pitch", f.pitch ?? 0, -100, 100, v => { f.pitch = v; }, { unit: "mm", tip: "Travel along the axis per turn: springs and threads" });
                num("Grow", f.grow ?? 1, 0.2, 4, v => { f.grow = v; }, { tip: "Radius multiplier reached at the end: shells" });
            }, "cad-group-round", true);
            break;
        }
        case "loft":
            opChoice(f);
            toggle("Ruled", !!f.ruled, v => { f.ruled = v; }, "Straight skin between sections instead of a smooth one through them");
            toggle("Closed", !!f.closed, v => { f.closed = v; }, "Join the last section back to the first");
            f.sections.forEach((sec, i) => {
                W.collapsingHeader(id, `Section ${i + 1} · ${findSketch(doc, sec.profile.sketch)?.name ?? "?"}`, () => {
                    sketchPicker("Sketch", sec.profile.sketch, v => { sec.profile = { sketch: v }; }, `section-${i}`, sid => regionsOf(sid) > 0);
                    num("Spin", sec.spin ?? 0, -180, 180, v => { sec.spin = v; }, { unit: "°", decimals: 0, key: `section-${i}-spin`, tip: "Turn where the skin's seam meets this section: twists the loft" });
                    const sk = findSketch(doc, sec.profile.sketch);
                    if (sk) planeControls(sk.plane, `section-${i}`);
                    if (f.sections.length > 2) W.button(id, { id: `cad-p-section-${i}-remove`, text: Icons.label("x", "Leave out"), onClick: () => edit("Remove section", () => { f.sections.splice(i, 1); }) });
                }, `cad-group-section-${i}`, false);
            });
            break;
        case "sweep":
            sketchPicker("Profile", f.profile.sketch, v => { f.profile = { sketch: v }; }, "profile", sid => regionsOf(sid) > 0);
            sketchPicker("Path", f.path.sketch, v => { f.path = { sketch: v }; }, "path", sid => sid !== f.profile.sketch);
            opChoice(f);
            num("Twist", f.twist ?? 0, -720, 720, v => { f.twist = v; }, { unit: "°", decimals: 0 });
            num("End scale", f.scaleEnd ?? 1, 0.05, 4, v => { f.scaleEnd = v; }, { tip: "Profile size at the end of the path" });
            num("Middle scale", f.scaleMid ?? (1 + (f.scaleEnd ?? 1)) / 2, 0.05, 4, v => { f.scaleMid = v; }, { tip: "Profile size half way: a swelling or a waist" });
            break;
        case "deform":
            targetPicker(f);
            choice("Kind", ["twist", "bend", "taper", "shear"] as const, ["Twist", "Bend", "Taper", "Shear"], f.kind, v => { f.kind = v; });
            choice("Axis", ["x", "y", "z"] as const, ["X", "Y", "Z"], f.axis, v => { f.axis = v; });
            num("From", f.from, 0, 1, v => { f.from = v; }, { tip: "Where along the body the effect starts (0 one end, 1 the other)" });
            num("To", f.to, 0, 1, v => { f.to = v; }, { tip: "Where it reaches full strength. Below From, it runs the other way" });
            if (f.kind === "twist" || f.kind === "bend") num("Angle", f.angle ?? 0, -360, 360, v => { f.angle = v; }, { unit: "°", decimals: 0 });
            if (f.kind === "bend") choice("Toward", ["x", "y", "z"] as const, ["X", "Y", "Z"], f.toward ?? "x", v => { f.toward = v; });
            if (f.kind === "taper") {
                num("Scale A", f.scale?.[0] ?? 1, 0.02, 3, v => { f.scale = [v, f.scale?.[1] ?? 1]; }, { tip: "Cross-section scale at the far end, first cross axis" });
                num("Scale B", f.scale?.[1] ?? 1, 0.02, 3, v => { f.scale = [f.scale?.[0] ?? 1, v]; }, { tip: "Second cross axis: taper one direction and not the other" });
            }
            if (f.kind === "shear") {
                num("Shift A", f.shift?.[0] ?? 0, -200, 200, v => { f.shift = [v, f.shift?.[1] ?? 0]; }, { unit: "mm" });
                num("Shift B", f.shift?.[1] ?? 0, -200, 200, v => { f.shift = [f.shift?.[0] ?? 0, v]; }, { unit: "mm" });
            }
            toggle("Ease in and out", !!f.smooth, v => { f.smooth = v; });
            break;
        case "mirror": {
            targetPicker(f);
            planeControls(f.plane, "mirror");
            toggle("Fuse halves", f.merge !== false, v => { f.merge = v; }, "Off: the reflection becomes a body of its own");
            W.collapsingHeader(id, "Break the symmetry", () => {
                const sc = f.scale ?? [1, 1, 1], sh = f.shift ?? [0, 0, 0];
                note(id, "Applied to the reflected half only, in the mirror plane's axes (the third points away from it).", FAINT);
                ["Scale along", "Scale across", "Scale away"].forEach((label, a) => num(label, sc[a], 0.2, 3, v => { const n = [...sc] as [number, number, number]; n[a] = v; f.scale = n; }));
                ["Shift along", "Shift across", "Shift away"].forEach((label, a) => num(label, sh[a], -150, 150, v => { const n = [...sh] as [number, number, number]; n[a] = v; f.shift = n; }, { unit: "mm" }));
            }, "cad-group-asym", true);
            break;
        }
    }
    const needs = dependents(doc, f.id);
    if (needs.length) note(id, `Used by ${needs.map(d => d.name).join(", ")}.`, FAINT);
}

function renderReadout(): void {
    const id = readoutWindow;
    const issues = view.evaluation.issues;
    W.horizontal(id, () => {
        if (editingId && cursor) W.label(id, { text: `X ${cursor[0].toFixed(1).padStart(7)}  Y ${cursor[1].toFixed(1).padStart(7)}  GRID ${(view.gridStep() / 2).toString()} mm`, monospace: true, color: ACCENT, fontSize: 12 });
        else W.label(id, { text: `${doc.features.length} FEATURES · ${view.evaluation.bodies.length} BOD${view.evaluation.bodies.length === 1 ? "Y" : "IES"} · ${view.evaluation.ms.toFixed(0)} MS`, monospace: true, color: FAINT, fontSize: 12 });
        W.label(id, { text: issues.length ? `${issues.length} ISSUE${issues.length === 1 ? "" : "S"}` : "NOMINAL", monospace: true, color: issues.length ? WARN : ACCENT, fontSize: 12 });
        W.label(id, { text: status, color: DIM });
    });
}

function setupUI(): void {
    const [sw, sh] = Entropy.Window.getSize();
    const tabId = addon.UI.createTab({ title: "Contour", transparent: true, onRender: () => {} });
    const make = (config: Parameters<typeof Entropy.UI.createWindow>[0]) => Entropy.UI.createWindow({ ...config, ownerTabId: tabId });
    // Instrument-panel glass: near-black blue, hairline borders, square corners, cyan light.
    Entropy.UI.setTheme({
        background: [0.02, 0.035, 0.05, 0.78],
        surface: [0.085, 0.15, 0.19, 0.95],
        surfaceHover: [0.1, 0.2, 0.26, 1],
        border: [0.25, 0.86, 1, 0.22],
        text: [0.86, 0.95, 1, 1],
        accent: ACCENT,
        cornerRadius: 2,
        windowCornerRadius: 3,
        itemSpacing: 6,
        buttonPadding: [9, 5],
    });
    const barW = Math.min(sw - 32, 1500);
    toolbarWindow = make({ title: "Contour", width: barW, height: 92, x: Math.round((sw - barW) / 2), y: 12, decorations: false, glass: true, onRender: renderToolbar });
    historyWindow = make({ title: "History", width: 270, height: sh - 190, x: 16, y: 116, glass: true, onRender: renderHistory });
    paramsWindow = make({ title: "Parameters", width: 350, height: sh - 190, x: sw - 366, y: 116, glass: true, onRender: renderParams });
    readoutWindow = make({ title: "Readout", width: barW, height: 44, x: Math.round((sw - barW) / 2), y: sh - 60, decorations: false, glass: true, onRender: renderReadout });
}

// --- MCP tools -----------------------------------------------------------------------------------

type Args = Record<string, any>;

function summary() {
    const e = view.evaluation;
    return {
        features: doc.features.map(f => ({ id: f.id, name: f.name, type: f.type, suppressed: !!f.suppressed, issue: issueOf(f.id) ?? null })),
        bodies: e.bodies.map(b => ({ id: b.id, name: b.name, triangles: b.triangles, volume: b.volume, area: b.area, min: b.min, max: b.max, centroid: b.centroid, faces: b.faces.length })),
        sketches: e.sketches.map(s => ({ id: s.id, curves: s.entities.length, regions: s.regions.map(r => ({ key: r.key, area: r.area, holes: r.holes })), chains: s.chains })),
        issues: e.issues, selected: selectedId, editing: editingId, tool, mode: view.mode, undo: history.depth.undo, redo: history.depth.redo, ms: e.ms,
    };
}

/** Runs a change as one committed step and evaluates right away, so the reply describes the result. */
function act<T>(label: string, change: () => T): T {
    finishDraft();
    history.begin(label);
    const out = change();
    evaluate("full");
    work = "redraw";
    commit();
    return out;
}

interface ShapeSpec { type: string; [key: string]: any }

/** Draws tool-friendly shapes into a sketch; returns the ids of the entities made. */
function drawShapes(s: SketchFeature, shapes: ShapeSpec[]): string[] {
    const made: string[] = [];
    const pt = (v: any): string => {
        if (!Array.isArray(v) || v.length < 2 || !v.every((n: any) => Number.isFinite(n))) throw new Error("points are [x, y] pairs of numbers");
        // Shapes drawn through a tool join up where they share a position.
        const [x, y] = [round(v[0]), round(v[1])];
        return (s.points.find(p => p.x === x && p.y === y) ?? addPoint(s, x, y)).id;
    };
    const flags = (shape: ShapeSpec) => ({ ...(shape.construction ? { construction: true } : {}), ...(shape.stroke ? { stroke: { left: 1, right: 1, start: 1, middle: 1, end: 1, round: true, ...shape.stroke } } : {}) });
    for (const shape of shapes) {
        switch (shape.type) {
            case "line": made.push(addEntity(s, { type: "line", a: pt(shape.from), b: pt(shape.to), ...flags(shape) }).id); break;
            case "polyline": {
                const ids: string[] = (shape.points as any[]).map(pt);
                const n = shape.closed ? ids.length : ids.length - 1;
                for (let i = 0; i < n; i++) made.push(addEntity(s, { type: "line", a: ids[i], b: ids[(i + 1) % ids.length], ...flags(shape) }).id);
                break;
            }
            case "rectangle": {
                const [a, b] = [shape.from, shape.to];
                const ids = [pt(a), pt([b[0], a[1]]), pt(b), pt([a[0], b[1]])];
                ids.forEach((p, i) => made.push(addEntity(s, { type: "line", a: p, b: ids[(i + 1) % 4] }).id));
                break;
            }
            case "arc": made.push(addEntity(s, { type: "arc", a: pt(shape.from), b: pt(shape.to), via: pt(shape.via), ...flags(shape) }).id); break;
            case "circle": made.push(addEntity(s, { type: "circle", center: pt(shape.center), radius: Number(shape.radius), ...flags(shape) }).id); break;
            case "ellipse": made.push(addEntity(s, { type: "ellipse", center: pt(shape.center), rx: Number(shape.rx), ry: Number(shape.ry), rotation: Number(shape.rotation ?? 0), ...flags(shape) }).id); break;
            case "spline": {
                const e: Omit<SplineEntity, "id"> = { type: "spline", points: (shape.points as any[]).map(pt), ...flags(shape) };
                if (shape.closed) e.closed = true;
                if (shape.mode === "control") e.mode = "control";
                if (Array.isArray(shape.weights)) e.weights = shape.weights.map(Number);
                made.push(addEntity(s, e).id);
                break;
            }
            default: throw new Error(`Unknown shape "${shape.type}": use line, polyline, rectangle, arc, circle, ellipse or spline`);
        }
    }
    return made;
}

/** Merges `values` into a feature: nested objects (forward, plane, profile...) one level deep. */
function patch(target: Record<string, any>, values: Record<string, any>): void {
    for (const [k, v] of Object.entries(values)) {
        if (k === "id" || k === "type") throw new Error(`${k} can't be changed`);
        if (v === null) delete target[k];
        else if (v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object" && !Array.isArray(target[k])) target[k] = { ...target[k], ...v };
        else target[k] = v;
    }
}

const SHAPES_DOC = "shapes: [{type:'spline', points:[[x,y]...], closed?, mode?:'through'|'control', weights?}, {type:'circle', center, radius}, {type:'ellipse', center, rx, ry, rotation?}, {type:'rectangle', from, to}, {type:'polyline', points, closed?}, {type:'line', from, to}, {type:'arc', from, to, via}]; any may add construction:true or stroke:{left,right,start,middle,end,round}. Shapes sharing a position are joined.";

const TOOLS: { name: string; description: string; parameters: object; run: (a: Args) => unknown }[] = [
    { name: "cad_state", description: "The document's features, the bodies they evaluate to (size, volume, area), sketch regions, and any issues.", parameters: { type: "object", properties: {} }, run: () => summary() },
    { name: "cad_document", description: "The whole document as JSON (the format Entropy.Cad evaluates), or one feature with `id`.", parameters: { type: "object", properties: { id: { type: "string" } } }, run: a => (a.id ? { feature: findFeature(doc, String(a.id)) ?? null } : { document: doc }) },
    {
        name: "cad_new", description: `Start a new document: empty, or a sample (${SAMPLES.map(s => s.id).join(", ")}).`,
        parameters: { type: "object", properties: { sample: { type: "string" } } },
        run: a => {
            const s = SAMPLES.find(x => x.id === (a.sample ?? "empty"));
            if (!s) throw new Error(`No sample "${a.sample}": ${SAMPLES.map(x => x.id).join(", ")}`);
            openDocument(s.build(), `${s.name}: ${s.description}.`);
            evaluate("full"); work = "redraw";
            return summary();
        },
    },
    {
        name: "cad_sketch", description: `Add a sketch (or draw more into an existing one with \`id\`). plane: {base:'top'|'front'|'side', offset?, tiltX?, tiltY?, spin?}. ${SHAPES_DOC}`,
        parameters: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, plane: { type: "object" }, shapes: { type: "array", items: { type: "object" } } } },
        run: a => act("Sketch", () => {
            let s = a.id ? findSketch(doc, String(a.id)) : undefined;
            if (a.id && !s) throw new Error(`No sketch ${a.id}`);
            if (!s) s = addSketch(doc, { base: "top", ...(a.plane ?? {}) });
            else if (a.plane) s.plane = { ...s.plane, ...a.plane };
            if (a.name) s.name = String(a.name);
            const entities = drawShapes(s, Array.isArray(a.shapes) ? a.shapes : []);
            selectedId = s.id;
            return { id: s.id, entities };
        }),
    },
    {
        name: "cad_feature", description: "Add a feature. feature: {type:'extrude', profile:{sketch}, forward:{distance, scale?, shift?, twist?, bulge?}, backward:{...}, op} | {type:'revolve', profile, axis:{entity}|{origin,dir}, start, end, squash?, lobes?, lobeDepth?, pitch?, grow?, op} | {type:'loft', sections:[{profile:{sketch}, spin?}], ruled?, closed?, op} | {type:'sweep', profile, path:{sketch}, twist?, scaleEnd?, scaleMid?, op} | {type:'deform', kind:'twist'|'bend'|'taper'|'shear', axis, from, to, angle?, toward?, scale?, shift?, smooth?, target?} | {type:'mirror', plane, scale?, shift?, merge?, target?}. op: new | add | cut | intersect.",
        parameters: { type: "object", properties: { feature: { type: "object" }, name: { type: "string" } }, required: ["feature"] },
        run: a => act("Add feature", () => {
            const spec = a.feature ?? {};
            if (!["extrude", "revolve", "loft", "sweep", "deform", "mirror"].includes(spec.type)) throw new Error("feature.type must be extrude, revolve, loft, sweep, deform or mirror (use cad_sketch for sketches)");
            const base = ({
                extrude: { forward: { distance: 30 }, backward: { distance: 0 }, op: defaultOp() }, revolve: { axis: {}, start: 0, end: 360, op: defaultOp() },
                loft: { sections: [], op: defaultOp() }, sweep: { op: defaultOp() }, deform: { kind: "twist", axis: "y", from: 0, to: 1 }, mirror: { plane: { base: "side" } },
            } as Record<string, Record<string, any>>)[spec.type as string];
            const identity = newFeatureIdentity(doc, spec.type, spec.type === "deform" && spec.kind ? String(spec.kind).replace(/^./, c => c.toUpperCase()) : undefined);
            const f = { ...base, ...spec, ...identity, ...(a.name ? { name: String(a.name) } : {}) } as Feature;
            doc.features.push(f);
            selectedId = f.id;
            return { id: f.id };
        }),
    },
    {
        name: "cad_update", description: "Change a feature's parameters: `values` is merged in (nested objects such as forward, plane or axis one level deep; null removes a key).",
        parameters: { type: "object", properties: { id: { type: "string" }, values: { type: "object" } }, required: ["id", "values"] },
        run: a => act("Update", () => {
            const f = findFeature(doc, String(a.id));
            if (!f) throw new Error(`No feature ${a.id}`);
            patch(f as unknown as Record<string, any>, a.values ?? {});
            return { feature: f };
        }),
    },
    {
        name: "cad_remove", description: "Delete a feature and everything that depends on it.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        run: a => act("Delete", () => {
            if (!findFeature(doc, String(a.id))) throw new Error(`No feature ${a.id}`);
            const removed = removeFeature(doc, String(a.id));
            if (selectedId && removed.includes(selectedId)) selectedId = null;
            if (editingId && removed.includes(editingId)) editingId = null;
            return { removed };
        }),
    },
    { name: "cad_select", description: "Select a feature (null clears).", parameters: { type: "object", properties: { id: { type: ["string", "null"] } }, required: ["id"] }, run: a => { if (a.id && !findFeature(doc, String(a.id))) throw new Error(`No feature ${a.id}`); if (editingId && a.id !== editingId) editSketch(null); select(a.id ?? null); return { selected: selectedId }; } },
    {
        name: "cad_edit_sketch", description: "Enter a sketch to draw in it (optionally with a tool: select, line, rect, circle, ellipse, arc, spline, cspline), or leave with id null.",
        parameters: { type: "object", properties: { id: { type: ["string", "null"] }, tool: { type: "string" }, select: { type: "array", items: { type: "string" } }, comb: { type: "boolean" } }, required: ["id"] },
        run: a => {
            if (a.id && !findSketch(doc, String(a.id))) throw new Error(`No sketch ${a.id}`);
            editSketch(a.id ?? null);
            if (a.tool) { if (!(a.tool in TOOL_LABEL)) throw new Error(`No tool ${a.tool}`); setTool(a.tool as Tool); }
            if (Array.isArray(a.select)) selEntities = new Set(a.select.map(String));
            if (typeof a.comb === "boolean") showComb = a.comb;
            evaluate("full"); work = "redraw";
            return { editing: editingId, tool };
        },
    },
    {
        name: "cad_view", description: `Look at the model: mode (${VIEW_MODES.map(m => m.id).join(", ")}), yaw and pitch in degrees, optionally framing one body (by feature id) or looking square at a sketch.`,
        parameters: { type: "object", properties: { mode: { type: "string" }, yaw: { type: "number" }, pitch: { type: "number" }, body: { type: "string" }, sketch: { type: "string" }, sketches: { type: "boolean" } } },
        run: a => {
            if (a.mode) { if (!VIEW_MODES.some(m => m.id === a.mode)) throw new Error(`Modes: ${VIEW_MODES.map(m => m.id).join(", ")}`); setMode(a.mode); }
            if (typeof a.sketches === "boolean") { showSketches = a.sketches; touch("redraw"); }
            if (a.sketch) pendingLook = String(a.sketch);
            else if (a.yaw !== undefined || a.pitch !== undefined || a.body) pendingView = { yaw: a.yaw ?? 38, pitch: a.pitch ?? 22, body: a.body ? bodyOf(String(a.body)) : null };
            return { mode: view.mode };
        },
    },
    { name: "cad_undo", description: "Undo the last change (or redo with redo: true).", parameters: { type: "object", properties: { redo: { type: "boolean" } } }, run: a => { if (a.redo) redo(); else undo(); evaluate("full"); work = "redraw"; return { message: status, ...summary() }; } },
    { name: "cad_export", description: "Write every body to a file: format stl (binary) or obj.", parameters: { type: "object", properties: { format: { type: "string" }, path: { type: "string" } }, required: ["format", "path"] }, run: a => { if (a.format !== "stl" && a.format !== "obj") throw new Error("format is stl or obj"); return exportModel(a.format, String(a.path)); } },
];

function registerTools(): void {
    for (const t of TOOLS) {
        addon.registerTool({ name: t.name, description: t.description, parameters: t.parameters }, (args: Args) => {
            try {
                return { success: true, ...(t.run(args && typeof args === "object" ? args : {}) as object) };
            } catch (error) {
                history.cancel();
                touch("full");
                return { success: false, error: (error as Error).message };
            }
        });
    }
}

// --- Lifecycle -----------------------------------------------------------------------------------

/** Camera moves wait a frame or two for new meshes to exist. */
let pendingView: { yaw: number; pitch: number; body?: string | null } | null = null;
let pendingLook: string | null = null;
let settleFrames = 0;

addon.onInit(() => {
    const restored = load();
    view.init();
    setupUI();
    registerTools();
    if (!restored) doc = SAMPLES[0].build();
    evaluate("full");
    redraw();
    history.clear();
    pendingView = { yaw: 38, pitch: 22 };
    settleFrames = 2;
    status = restored ? "Welcome back." : `${SAMPLES[0].name}: ${SAMPLES[0].description}. Select a feature to change it.`;
    Entropy.println("[contour-design] initialized");
});

addon.onUpdate(() => {
    view.tick();
    // A drag that rebuilt coarsely has ended: rebuild properly.
    if (!pointerHeld && !draft && !drag && lastEvalQuick && work === "none") work = "full";
    if (work !== "none") {
        const w = work;
        work = "none";
        if (w !== "redraw") evaluate(w);
        redraw();
    }
    if (!pointerHeld && !draft && !drag) commit();
    if (settleFrames > 0) { settleFrames--; return; }
    if (pendingLook) { view.lookAtSketch(pendingLook, 18); pendingLook = null; pendingView = null; }
    if (pendingView) { view.frame(pendingView.body ?? null, pendingView.yaw, pendingView.pitch); pendingView = null; }
});

addon.onCleanup(() => view.dispose());
