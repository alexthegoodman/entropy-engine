// Mesha: find or describe an ordinary object, pick a highly configurable procedural version of it
// from the library, shape it with meaningful controls (or let Variation explore sensible
// alternatives around it), place several together, and export ordinary geometry.
//
// Layout: the 3D viewport is the whole window; three frosted panels float over it - the Library
// and scene outliner on the left, the selected object's Properties on the right, and a slim
// toolbar at the top. Objects stay procedural: an instance is an object id plus parameter values,
// and geometry is re-evaluated (cached) whenever they change.

import { identity4, type Vec3, type Bounds } from "./mesha_mesh";
import { sphere } from "./mesha_primitives";
import { type ObjectDef, type ParamDef, type ParamValues, type Evaluation, defaultValues, resolveParams, isParamVisible, objectParamRange, materialChoices, ruleViolations } from "./mesha_object";
import { MATERIAL_BY_ID } from "./mesha_materials";
import { lookupObject, LIBRARY } from "./library";
import { type Instance, type BakedInstance, EvaluationCache, bakeInstance, instanceMatrix, instanceRotation, searchLibrary, packVertices, materialTexture } from "./mesha_scene";
import { vary, isLocked } from "./mesha_variation";
import { fuzz, acceptanceText } from "./mesha_verify";
import { contactShadowMap } from "./mesha_raster";
import { MESHA_SHADER, STUDIO_PRESETS, STUDIO_FLOATS, ITEM_FLOATS, packStudio } from "./mesha_shader";
import type { IconName } from "../../icon_names";

const addon = Entropy.AddonAtom.register({
    name: "Mesha",
    version: "0.1.0",
    description: "Procedural objects you shape with meaningful controls, vary, compose and export",
    author: ["Entropy Team", "Claude"],
    capabilities: { graphics: true, ui: true },
});

const W = Entropy.UI.Widget;
const Icons = Entropy.Icons;
const ACCENT: [number, number, number, number] = [0.96, 0.66, 0.38, 1];
const DIM: [number, number, number, number] = [0.66, 0.68, 0.72, 1];
const WARN: [number, number, number, number] = [0.98, 0.72, 0.42, 1];
const CATEGORY_ICONS: Record<string, IconName> = { Furniture: "armchair", Household: "wine", Mechanical: "gear-six", Nature: "mountains", Architecture: "house", Electronics: "lightning" };
const OBJECT_ICONS: Record<string, IconName> = { "furniture.office_chair": "chair", "furniture.table": "table", "household.bottle": "wine", "mechanical.gear": "gear-six", "mechanical.bolt": "nut", "nature.rock": "mountains", "household.mug": "coffee", "architecture.window": "house", "architecture.facade": "house" };

// --- Scene state ---------------------------------------------------------------------------------

interface SceneState {
    instances: Instance[];
    selectedId: string | null;
    /** Locked parameter ids / "group:<id>" per instance. */
    locks: Record<string, string[]>;
}

let scene: SceneState = { instances: [], selectedId: null, locks: {} };
const cache = new EvaluationCache(lookupObject);

interface Live { baked: BakedInstance; meshIds: string[]; itemBuffer: string; bounds: Bounds | null; geometryKey: string }
const live = new Map<string, Live>();
const dirty = new Set<string>();
const transformed = new Set<string>();
let groundDirty = true;
let pipelineId = "";
let studioBuffer = "";
let studioIndex = 0;
let zoomStrength = 1;
let baseZoomSpeed = 0.05;
const GROUND_MESH_ID = Entropy.generateUUID();
const BACKDROP_MESH_ID = Entropy.generateUUID();
let groundItemBuffer = "";

let variationAmount = 0.45;
let variationSeed = 1;
let libraryQuery = "";
let libraryCategory = "All";
let statusMessage = "Pick something from the library to begin.";
let lastVariation: string[] = [];

const selected = (): Instance | undefined => scene.instances.find(i => i.id === scene.selectedId);
const defOf = (i: Instance): ObjectDef => lookupObject(i.objectId)!;
const locksOf = (i: Instance): Set<string> => new Set(scene.locks[i.id] ?? []);

// --- Undo / redo ---------------------------------------------------------------------------------

const undoStack: { label: string; state: string }[] = [];
const redoStack: { label: string; state: string }[] = [];
let pendingSnapshot: { label: string; state: string } | null = null;
let pointerHeld = false;

const snapshot = () => JSON.stringify(scene);

/** Call before changing the scene; one gesture (a slider drag) becomes one undo step. */
function beginEdit(label: string): void {
    if (!pendingSnapshot) pendingSnapshot = { label, state: snapshot() };
}

function commitEdit(): void {
    if (!pendingSnapshot) return;
    if (pendingSnapshot.state !== snapshot()) {
        undoStack.push(pendingSnapshot);
        if (undoStack.length > 200) undoStack.shift();
        redoStack.length = 0;
        saveSession();
    }
    pendingSnapshot = null;
}

function restore(state: string): void {
    const before = new Set(scene.instances.map(i => i.id));
    scene = JSON.parse(state);
    for (const id of before) if (!scene.instances.some(i => i.id === id)) removeLive(id);
    for (const i of scene.instances) dirty.add(i.id);
    groundDirty = true;
    syncGizmo();
}

function undo(): void {
    commitEdit();
    const step = undoStack.pop();
    if (!step) { statusMessage = "Nothing to undo."; return; }
    redoStack.push({ label: step.label, state: snapshot() });
    restore(step.state);
    statusMessage = `Undid ${step.label.toLowerCase()}.`;
    saveSession();
}

function redo(): void {
    const step = redoStack.pop();
    if (!step) { statusMessage = "Nothing to redo."; return; }
    undoStack.push({ label: step.label, state: snapshot() });
    restore(step.state);
    statusMessage = `Redid ${step.label.toLowerCase()}.`;
    saveSession();
}

// --- Persistence ---------------------------------------------------------------------------------

function storeRead(path: string): string | null {
    try { return addon.IO.store.read(path); } catch { return null; }
}
function storeWrite(path: string, text: string): void {
    try { addon.IO.store.write(path, text); } catch (e) { statusMessage = `Couldn't save: ${(e as Error).message}`; }
}

function saveSession(): void {
    storeWrite("session.json", JSON.stringify({ version: 1, scene, variationAmount, zoomStrength, studio: STUDIO_PRESETS[studioIndex].id }));
}

function loadSession(): boolean {
    const text = storeRead("session.json");
    if (!text) return false;
    try {
        const data = JSON.parse(text);
        const instances = (data.scene?.instances ?? []).filter((i: Instance) => lookupObject(i.objectId));
        scene = { instances, selectedId: data.scene?.selectedId ?? null, locks: data.scene?.locks ?? {} };
        if (typeof data.variationAmount === "number") variationAmount = data.variationAmount;
        if (typeof data.zoomStrength === "number" && Number.isFinite(data.zoomStrength)) zoomStrength = Math.max(0.1, Math.min(3, data.zoomStrength));
        const s = STUDIO_PRESETS.findIndex(p => p.id === data.studio);
        if (s >= 0) studioIndex = s;
        for (const i of scene.instances) dirty.add(i.id);
        return scene.instances.length > 0;
    } catch { return false; }
}

interface UserPreset { name: string; values: ParamValues }
function userPresets(objectId: string): UserPreset[] {
    try { return JSON.parse(storeRead(`presets/${objectId}.json`) ?? "[]"); } catch { return []; }
}
function saveUserPreset(inst: Instance): string {
    const list = userPresets(inst.objectId);
    const name = `My ${defOf(inst).name.toLowerCase()} ${list.length + 1}`;
    list.push({ name, values: { ...inst.values } });
    storeWrite(`presets/${inst.objectId}.json`, JSON.stringify(list, null, 2));
    return name;
}

// --- Rendering -----------------------------------------------------------------------------------

function removeLive(id: string): void {
    const l = live.get(id);
    if (!l) return;
    for (const m of l.meshIds) Entropy.Model.clearMesh(m);
    live.delete(id);
}

function itemHighlight(id: string): number[] {
    return scene.selectedId === id ? [ACCENT[0], ACCENT[1], ACCENT[2], 0.7] : [0, 0, 0, 0];
}

function rebuildInstance(inst: Instance): void {
    let evaluation: Evaluation;
    try { evaluation = cache.get(inst.objectId, inst.values); } catch (e) {
        statusMessage = `${defOf(inst).name}: ${(e as Error).message}`;
        return;
    }
    const previous = live.get(inst.id);
    const geometryKey = JSON.stringify([inst.objectId, inst.values]);
    if (previous?.geometryKey === geometryKey) { updateTransform(inst); return; }
    const local = bakeInstance({ ...inst, position: [0, 0, 0], rotationY: 0, rotation: undefined, scale: 1 }, evaluation);
    if (previous) for (const m of previous.meshIds) Entropy.Model.clearMesh(m);
    const itemBuffer = previous?.itemBuffer ?? Entropy.Buffer.create({ size: ITEM_FLOATS * 4, usage: "Uniform" });
    Entropy.Buffer.write(itemBuffer, new Float32Array([...itemHighlight(inst.id), ...instanceMatrix(inst)]));
    const meshIds: string[] = [];
    for (const rm of local.meshes) {
        const { vertexData, indexData } = packVertices(rm);
        const id = Entropy.generateUUID();
        Entropy.Model.createMesh({
            id, position: [0, 0, 0], vertexData, indexData, pipelineId,
            bindings: [
                { group: 2, binding: 0, resource: { type: "Buffer", value: { id: studioBuffer } } },
                { group: 2, binding: 1, resource: { type: "Buffer", value: { id: itemBuffer } } },
            ],
        });
        meshIds.push(id);
    }
    live.set(inst.id, { baked: local, meshIds, itemBuffer, bounds: null, geometryKey });
    refreshWorld(inst);
}

/** Upload only 80 bytes during a transform; defer CPU triangles and shadows until release. */
function updateTransform(inst: Instance): void {
    const l = live.get(inst.id);
    if (!l) { dirty.add(inst.id); return; }
    Entropy.Buffer.write(l.itemBuffer, new Float32Array([...itemHighlight(inst.id), ...instanceMatrix(inst)]));
    transformed.add(inst.id);
    groundDirty = true;
}

function refreshWorld(inst: Instance): void {
    const l = live.get(inst.id);
    if (!l) return;
    l.baked = bakeInstance(inst, l.baked.evaluation);
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const m of l.baked.meshes) for (let k = 0; k < m.positions.length; k += 3)
        for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], m.positions[k + a]); max[a] = Math.max(max[a], m.positions[k + a]); }
    l.bounds = Number.isFinite(min[0]) ? { min, max } : null;
}

function refreshHighlights(): void {
    for (const [id, l] of live) Entropy.Buffer.write(l.itemBuffer, new Float32Array(itemHighlight(id)));
}

/** The floor: a disc of vertices whose color carries every object's soft contact shadow. */
function rebuildGround(): void {
    const RES = 140, SIZE = 60;
    const maps = [...live.values()].filter(l => l.bounds).map(l => {
        const mesh = { parts: l.baked.meshes.map(m => ({ region: m.region, positions: m.positions, normals: m.normals, uvs: m.uvs, indices: m.indices })) };
        return contactShadowMap(mesh, l.bounds!, 64);
    });
    const sample = (x: number, z: number) => {
        let s = 0;
        for (const m of maps) {
            const u = (x - m.x0) / m.size, v = (z - m.z0) / m.size;
            if (u < 0 || v < 0 || u >= 1 || v >= 1) continue;
            const i = Math.min(m.res - 1, Math.floor(u * m.res)), j = Math.min(m.res - 1, Math.floor(v * m.res));
            s = Math.max(s, m.values[j * m.res + i]);
        }
        return s;
    };
    const vertexData: number[] = [];
    const indexData: number[] = [];
    for (let j = 0; j <= RES; j++) {
        for (let i = 0; i <= RES; i++) {
            // Denser near the middle, where the shadows are.
            const fx = (i / RES) * 2 - 1, fz = (j / RES) * 2 - 1;
            const x = Math.sign(fx) * fx * fx * SIZE, z = Math.sign(fz) * fz * fz * SIZE;
            const shadow = sample(x, z);
            const glow = Math.exp(-(x * x + z * z) / 30);
            // Normal length 7 marks the floor pattern.
            vertexData.push(x, 0, z, 0, 7, 0, x, z, glow, 0, 0, shadow);
        }
    }
    for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
        const a = j * (RES + 1) + i, b = a + 1, c = a + RES + 1, d = c + 1;
        indexData.push(a, c, b, b, c, d);
    }
    Entropy.Model.clearMesh(GROUND_MESH_ID);
    Entropy.Model.createMesh({
        id: GROUND_MESH_ID, position: [0, 0, 0], vertexData, indexData, pipelineId,
        bindings: [
            { group: 2, binding: 0, resource: { type: "Buffer", value: { id: studioBuffer } } },
            { group: 2, binding: 1, resource: { type: "Buffer", value: { id: groundItemBuffer } } },
        ],
    });
}

/** A big inverted-looking dome drawn with the backdrop pattern; it hides the engine's own sky. */
function createBackdrop(): void {
    const e = sphere(90, 48, 24);
    const part = e.parts[0];
    const vertexData: number[] = [];
    for (let v = 0; v < part.positions.length / 3; v++) {
        // Normal length 8 marks the backdrop pattern; its direction doesn't matter.
        vertexData.push(part.positions[v * 3], part.positions[v * 3 + 1], part.positions[v * 3 + 2], 0, 8, 0, 0, 0, 1, 1, 1, 1);
    }
    // Reverse the winding so the inside faces the camera.
    const indexData: number[] = [];
    for (let t = 0; t < part.indices.length; t += 3) indexData.push(part.indices[t], part.indices[t + 2], part.indices[t + 1]);
    Entropy.Model.createMesh({
        id: BACKDROP_MESH_ID, position: [0, 0, 0], vertexData, indexData, pipelineId,
        bindings: [
            { group: 2, binding: 0, resource: { type: "Buffer", value: { id: studioBuffer } } },
            { group: 2, binding: 1, resource: { type: "Buffer", value: { id: groundItemBuffer } } },
        ],
    });
}

let studioFocus = 3;

function applyStudio(): void {
    const l = STUDIO_PRESETS[studioIndex];
    Entropy.Buffer.write(studioBuffer, packStudio(l, studioFocus));
    Entropy.Lighting.updateSun({ horizonColor: l.skyHorizon, zenithColor: l.skyTop, sunDirection: l.keyDir, sunColor: l.keyColor, sunIntensity: 0.4 });
}

// --- Camera --------------------------------------------------------------------------------------

let orbitTarget: Vec3 = [0, 0.45, 0];

function enableOrbit(target: Vec3): void {
    Entropy.Controls.enable("orbit", { target, trigger: "always", button: 1, panButton: 2, zoomButton: -1, panSpeed: 0.005, zoomSpeed: baseZoomSpeed * zoomStrength, invertX: true });
}

function sceneBounds(onlySelected: boolean): Bounds | null {
    const ls = onlySelected && scene.selectedId ? [live.get(scene.selectedId)].filter(Boolean) as Live[] : [...live.values()];
    let b: Bounds | null = null;
    for (const l of ls) {
        if (!l.bounds) continue;
        b = b ? { min: [Math.min(b.min[0], l.bounds.min[0]), Math.min(b.min[1], l.bounds.min[1]), Math.min(b.min[2], l.bounds.min[2])], max: [Math.max(b.max[0], l.bounds.max[0]), Math.max(b.max[1], l.bounds.max[1]), Math.max(b.max[2], l.bounds.max[2])] } : { min: [...l.bounds.min], max: [...l.bounds.max] };
    }
    return b;
}

/** Frames the selection (or everything) from a flattering three-quarter view. */
function frame(onlySelected = true): void {
    const b = sceneBounds(onlySelected) ?? sceneBounds(false);
    if (!b) return;
    const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const r = Math.max(0.05, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2);
    const [pos, target] = Entropy.Camera.getTransform();
    let dir: Vec3 = [pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]];
    const len = Math.hypot(...dir) || 1;
    dir = [dir[0] / len, dir[1] / len, dir[2] / len];
    if (dir[1] < 0.15) dir = [dir[0], 0.35, dir[2]];
    // Wide things (a facade) need more room: the side panels cover part of the view.
    const wide = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) > 2 * (b.max[1] - b.min[1]) ? 1.25 : 1;
    const d = r * (onlySelected ? 2.9 : 2.3) * wide + 0.2;
    orbitTarget = c;
    Entropy.Camera.setTransform([c[0] + dir[0] * d, c[1] + dir[1] * d, c[2] + dir[2] * d], c);
    baseZoomSpeed = Math.max(0.2, r);
    enableOrbit(c);
}

// --- Picking & moving ----------------------------------------------------------------------------

function rayHit(origin: Vec3, dir: Vec3): { id: string; t: number } | null {
    let best: { id: string; t: number } | null = null;
    for (const [id, l] of live) {
        const b = l.bounds;
        if (!b) continue;
        // Slab test first.
        let t0 = 0, t1 = Infinity;
        for (let a = 0; a < 3; a++) {
            const inv = 1 / (dir[a] || 1e-12);
            let ta = (b.min[a] - origin[a]) * inv, tb = (b.max[a] - origin[a]) * inv;
            if (ta > tb) [ta, tb] = [tb, ta];
            t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        }
        if (t0 > t1 || (best && t0 > best.t)) continue;
        for (const m of l.baked.meshes) {
            const P = m.positions, I = m.indices;
            for (let t = 0; t < I.length; t += 3) {
                const a = I[t] * 3, bb = I[t + 1] * 3, c = I[t + 2] * 3;
                const e1x = P[bb] - P[a], e1y = P[bb + 1] - P[a + 1], e1z = P[bb + 2] - P[a + 2];
                const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
                const px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
                const det = e1x * px + e1y * py + e1z * pz;
                if (Math.abs(det) < 1e-12) continue;
                const inv = 1 / det;
                const sx = origin[0] - P[a], sy = origin[1] - P[a + 1], sz = origin[2] - P[a + 2];
                const u = (sx * px + sy * py + sz * pz) * inv;
                if (u < 0 || u > 1) continue;
                const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
                const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
                if (v < 0 || u + v > 1) continue;
                const hit = (e2x * qx + e2y * qy + e2z * qz) * inv;
                if (hit > 1e-5 && (!best || hit < best.t)) best = { id, t: hit };
            }
        }
    }
    return best;
}

let gizmoId: string | null = null;
let gizmoWasActive = false;

function syncGizmo(): void {
    const inst = selected();
    if (!inst) {
        if (gizmoId) { Entropy.Gizmo.hide(gizmoId); gizmoId = null; }
        return;
    }
    if (gizmoId) { Entropy.Gizmo.updatePosition(gizmoId, inst.position); Entropy.Gizmo.updateRotation(gizmoId, instanceRotation(inst)); return; }
    gizmoId = Entropy.Gizmo.show({
        position: inst.position,
        mode: "translate_rotate",
        rotation: instanceRotation(inst),
        space: "world",
        onTransform: delta => {
            const i = selected();
            if (!i) return;
            beginEdit("Move");
            // Objects stand on the floor: drags slide them across it.
            i.position = [i.position[0] + delta[0], Math.max(0, i.position[1] + delta[1]), i.position[2] + delta[2]];
            gizmoWasActive = true;
            updateTransform(i);
            syncGizmo();
        },
        onRotate: rotation => {
            const i = selected();
            if (!i) return;
            beginEdit("Rotate");
            i.rotation = rotation;
            gizmoWasActive = true;
            updateTransform(i);
            syncGizmo();
        },
        onComplete: () => commitEdit(),
    });
}

function select(id: string | null): void {
    if (scene.selectedId === id) return;
    scene.selectedId = id;
    refreshHighlights();
    if (gizmoId) { Entropy.Gizmo.hide(gizmoId); gizmoId = null; }
    syncGizmo();
    lastVariation = [];
}

let downAt: [number, number] | null = null;
let mouse: [number, number] = [0, 0];

Entropy.Input.onMouseDown((button, x, y) => {
    mouse = [x, y];
    if (button !== 0) return;
    pointerHeld = true;
    downAt = Entropy.Input.isPointerOverUI() ? null : [x, y];
    gizmoWasActive = false;
});
Entropy.Input.onMouseMove((x, y) => { mouse = [x, y]; });
Entropy.Input.onMouseUp(button => {
    if (button !== 0) return;
    pointerHeld = false;
    const start = downAt;
    downAt = null;
    if (!start || gizmoWasActive) return;
    if (Math.hypot(mouse[0] - start[0], mouse[1] - start[1]) > 4) return;
    const ray = Entropy.Camera.screenToWorldRay(mouse[0], mouse[1]);
    const hit = rayHit(ray.origin, ray.direction);
    beginEdit("Select");
    select(hit ? hit.id : null);
    commitEdit();
});

Entropy.Input.onKeyDown((key, ctrl, shift) => {
    if (Entropy.UI.keyboardState().typing) return;
    const k = key.toLowerCase();
    if (ctrl && k === "z") { if (shift) redo(); else undo(); return; }
    if (ctrl && k === "y") { redo(); return; }
    if (ctrl && k === "d") { duplicateSelected(); return; }
    if (k === "v") { runVariation(); return; }
    if (k === "f") { frame(true); return; }
    if (k === "delete" || k === "backspace") { removeSelected(); return; }
});

// --- Scene operations ----------------------------------------------------------------------------

/** Somewhere on the floor not already taken, next to what's there. */
function freeSpot(def: ObjectDef, values: ParamValues): Vec3 {
    if (!live.size) return [0, 0, 0];
    const e = cache.get(def.id, resolveParams(def, values));
    const size = e.stats.bounds ? Math.max(e.stats.bounds.max[0] - e.stats.bounds.min[0], e.stats.bounds.max[2] - e.stats.bounds.min[2]) : 0.5;
    const all = sceneBounds(false)!;
    return [all.max[0] + size / 2 + 0.25, 0, (all.min[2] + all.max[2]) / 2];
}

function addObject(objectId: string, values: ParamValues = {}, position?: Vec3): Instance {
    const def = lookupObject(objectId);
    if (!def || def.component) throw new Error(`No object "${objectId}" in the library`);
    beginEdit(`Add ${def.name}`);
    const inst: Instance = {
        id: Entropy.generateUUID(), objectId, values: resolveParams(def, values),
        position: position ?? freeSpot(def, values), rotationY: 0, scale: 1,
        name: uniqueName(def.name),
    };
    scene.instances.push(inst);
    scene.locks[inst.id] = [];
    dirty.add(inst.id);
    groundDirty = true;
    select(inst.id);
    commitEdit();
    pendingFrame = 2; pendingFrameAll = false;
    statusMessage = `Added ${inst.name}. Drag its sliders, or press Variation.`;
    return inst;
}

function uniqueName(base: string): string {
    const taken = new Set(scene.instances.map(i => i.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

function removeSelected(): void {
    const inst = selected();
    if (!inst) return;
    beginEdit(`Delete ${inst.name}`);
    scene.instances = scene.instances.filter(i => i.id !== inst.id);
    delete scene.locks[inst.id];
    removeLive(inst.id);
    select(null);
    groundDirty = true;
    commitEdit();
    statusMessage = `Deleted ${inst.name}.`;
}

function duplicateSelected(): void {
    const inst = selected();
    if (!inst) return;
    const def = defOf(inst);
    const copy = addObject(inst.objectId, { ...inst.values }, freeSpot(def, inst.values));
    copy.rotation = inst.rotation ? [...inst.rotation] : undefined; copy.rotationY = inst.rotationY; copy.scale = inst.scale;
    scene.locks[copy.id] = [...(scene.locks[inst.id] ?? [])];
    dirty.add(copy.id);
}

function setParam(inst: Instance, id: string, value: number | boolean | string): void {
    const def = defOf(inst);
    beginEdit(`Change ${def.params.find(p => p.id === id)?.label ?? id}`);
    inst.values = resolveParams(def, { ...inst.values, [id]: value });
    dirty.add(inst.id);
    groundDirty = true;
    lastVariation = [];
}

function runVariation(): void {
    const inst = selected();
    if (!inst) { statusMessage = "Select an object to vary."; return; }
    const def = defOf(inst);
    beginEdit("Variation");
    const result = vary(def, inst.values, { amount: variationAmount, locked: locksOf(inst), seed: (variationSeed++ * 7919) ^ inst.id.length });
    inst.values = result.values;
    lastVariation = result.changed;
    dirty.add(inst.id);
    groundDirty = true;
    commitEdit();
    statusMessage = result.violations.length
        ? `Closest sensible variation: ${result.violations[0]}`
        : `Variation changed ${result.changed.length} setting${result.changed.length === 1 ? "" : "s"}.`;
}

function toggleLock(inst: Instance, key: string): void {
    beginEdit("Lock");
    const locks = locksOf(inst);
    if (locks.has(key)) locks.delete(key); else locks.add(key);
    scene.locks[inst.id] = [...locks];
    commitEdit();
}

function applyPreset(inst: Instance, values: ParamValues, name: string): void {
    const def = defOf(inst);
    beginEdit(`Preset ${name}`);
    inst.values = resolveParams(def, { ...defaultValues(def), ...values, seed: inst.values.seed });
    dirty.add(inst.id);
    groundDirty = true;
    commitEdit();
    statusMessage = `Applied "${name}".`;
}

function exportScene(path?: string): { success: boolean; path: string | null; error: string | null; meshes: number; triangles: number } {
    const meshes = [...live.entries()].flatMap(([id, l]) => {
        const inst = scene.instances.find(i => i.id === id);
        return l.baked.meshes.map(m => ({
            name: `${(inst?.name ?? "object").replace(/[^A-Za-z0-9_-]/g, "_")}_${m.region}`,
            positions: m.positions, normals: m.normals, uvs: m.uvs, indices: m.indices,
            textureRgba: materialTexture(m.material), textureWidth: 4, textureHeight: 4,
        }));
    });
    if (!meshes.length) return { success: false, path: null, error: "Nothing to export yet.", meshes: 0, triangles: 0 };
    const triangles = meshes.reduce((n, m) => n + m.indices.length / 3, 0);
    const result = Entropy.Model.exportGlb(meshes, "mesha-scene.glb", path ? { path } : undefined);
    statusMessage = result.success ? `Exported ${meshes.length} meshes (${triangles.toLocaleString()} triangles) to ${result.path}` : `Export: ${result.error}`;
    return { ...result, meshes: meshes.length, triangles };
}

// --- UI ------------------------------------------------------------------------------------------

let libraryWindow = "", propsWindow = "", toolbarWindow = "";
let verifyReport: string | null = null;

function renderToolbar(): void {
    const id = toolbarWindow;
    W.horizontal(id, () => {
        W.label(id, { text: Icons.label("shapes", "Mesha"), bold: true, fontSize: 16, color: ACCENT });
        W.spacer(id, 10);
        W.button(id, { id: "mesha-undo", text: Icons.get("arrow-counter-clockwise"), tooltip: "Undo", shortcut: "Ctrl+Z", disabled: !undoStack.length, onClick: undo, frame: false });
        W.button(id, { id: "mesha-redo", text: Icons.get("arrow-clockwise"), tooltip: "Redo", shortcut: "Ctrl+Shift+Z", disabled: !redoStack.length, onClick: redo, frame: false });
        W.spacer(id, 6);
        W.button(id, { id: "mesha-frame", text: Icons.label("arrows-out-cardinal", "Frame"), tooltip: "Frame the selection", shortcut: "F", onClick: () => frame(true), frame: false });
        W.segmented(id, {
            id: "mesha-studio", options: STUDIO_PRESETS.map(p => p.label), selectedIndex: studioIndex, compact: true, accent: ACCENT,
            onChange: v => { studioIndex = Number(v); applyStudio(); saveSession(); },
        });
        W.spacer(id, 6);
        W.button(id, { id: "mesha-export", text: Icons.label("export", "Export GLB"), accent: ACCENT, tooltip: "Every object as ordinary meshes, one per material", onClick: () => exportScene() });
        W.spacer(id, 12);
        W.knob(id, {
            id: "mesha-zoom-strength", label: "Zoom", value: zoomStrength, min: 0.1, max: 3, size: "small",
            defaultValue: 1, unit: "x", step: 0.1, decimals: 1,
            onChange: v => {
                zoomStrength = Math.max(0.1, Math.min(3, Number(v)));
                // Use the camera's current target so adjusting after a pan preserves the view.
                enableOrbit(Entropy.Camera.getTransform()[1]);
                saveSession();
            },
        });
    });
}

function renderLibrary(): void {
    const id = libraryWindow;
    W.label(id, { text: "Add object", bold: true, fontSize: 15 });
    W.textInput(id, { id: "mesha-search", label: Icons.get("magnifying-glass"), value: libraryQuery, onChange: v => { libraryQuery = v; } });
    const categories = ["All", ...new Set(searchLibrary("").map(d => d.category))];
    W.segmented(id, { id: "mesha-category", options: categories.map(c => (c === "All" ? "All" : Icons.get(CATEGORY_ICONS[c] ?? "cube"))), selectedIndex: Math.max(0, categories.indexOf(libraryCategory)), compact: true, onChange: v => { libraryCategory = categories[Number(v)]; } });
    W.label(id, { text: libraryCategory === "All" ? "Every category" : libraryCategory, color: DIM });
    const results = searchLibrary(libraryQuery, libraryCategory === "All" ? undefined : libraryCategory);
    if (!results.length) W.label(id, { text: `Nothing called "${libraryQuery}" yet.`, color: DIM, wrap: true });
    for (const def of results) {
        W.card(id, { id: `mesha-card-${def.id}`, padding: 8, radius: 10 }, () => {
            W.horizontal(id, () => {
                W.label(id, { text: Icons.get(OBJECT_ICONS[def.id] ?? CATEGORY_ICONS[def.category] ?? "cube"), fontSize: 22, color: ACCENT });
                W.vertical(id, () => {
                    W.label(id, { text: def.name, bold: true });
                    W.label(id, { text: `${def.category} · ${def.params.length} controls`, color: DIM });
                });
            });
            if (def.description) W.label(id, { text: def.description, color: DIM, wrap: true });
            W.button(id, { id: `mesha-add-${def.id}`, text: Icons.label("plus", "Add"), onClick: () => addObject(def.id), minWidth: 80 });
        });
    }
    W.spacer(id, 8);
    W.separator(id);
    W.label(id, { text: "Scene", bold: true, fontSize: 15 });
    if (!scene.instances.length) W.label(id, { text: "Empty. Add an object above.", color: DIM });
    W.treeView(id, {
        id: "mesha-outliner",
        nodes: scene.instances.map(i => ({ id: i.id, label: i.name ?? defOf(i).name, depth: 0, selected: i.id === scene.selectedId, icon: Icons.get(OBJECT_ICONS[i.objectId] ?? "cube"), detail: `${(live.get(i.id)?.baked.evaluation.stats.triangles ?? 0).toLocaleString()} tris` })),
        onSelect: sid => { beginEdit("Select"); select(sid); commitEdit(); },
    });
    if (selected()) {
        W.horizontal(id, () => {
            W.button(id, { id: "mesha-duplicate", text: Icons.label("copy", "Duplicate"), shortcut: "Ctrl+D", onClick: duplicateSelected });
            W.button(id, { id: "mesha-delete", text: Icons.label("trash", "Delete"), shortcut: "Del", onClick: removeSelected });
        });
    }
}

function lockButton(inst: Instance, key: string, label: string): void {
    const locked = locksOf(inst).has(key);
    W.button(propsWindow, { id: `mesha-lock-${key}`, text: Icons.get(locked ? "lock-simple" : "lock-simple-open"), frame: false, selected: locked, color: locked ? ACCENT : DIM, tooltip: locked ? `${label} is locked: Variation leaves it alone` : `Lock ${label} so Variation leaves it alone` , onClick: () => toggleLock(inst, key) });
}

function paramControl(inst: Instance, def: ObjectDef, p: ParamDef): void {
    const id = propsWindow;
    const v = inst.values[p.id];
    const cid = `mesha-p-${p.id}`;
    const changed = lastVariation.includes(p.id);
    W.horizontal(id, () => {
        lockButton(inst, p.id, p.label);
        const label = changed ? `${p.label} •` : p.label;
        switch (p.type) {
            case "bool":
                W.checkbox(id, { id: cid, label, value: !!v, onChange: x => setParam(inst, p.id, x) });
                break;
            case "enum": {
                const options = p.optionLabels ?? p.options ?? [];
                const idx = Math.max(0, (p.options ?? []).indexOf(String(v)));
                if (options.length <= 3) W.segmented(id, { id: cid, label, options, selectedIndex: idx, compact: true, onChange: x => setParam(inst, p.id, (p.options ?? [])[Number(x)]) });
                else W.dropdown(id, { id: cid, label, options, selectedIndex: idx, onChange: x => setParam(inst, p.id, (p.options ?? [])[Number(x)]) });
                break;
            }
            case "material": {
                const choices = materialChoices(p);
                W.dropdown(id, { id: cid, label, options: choices.map(c => MATERIAL_BY_ID.get(c)?.label ?? c), selectedIndex: Math.max(0, choices.indexOf(String(v))), onChange: x => setParam(inst, p.id, choices[Number(x)]) });
                break;
            }
            case "seed":
                W.label(id, { text: `${label} ${v}`, monospace: true });
                W.button(id, { id: `${cid}-reroll`, text: Icons.get("dice-five"), tooltip: "New seed: same design, different details", onClick: () => setParam(inst, p.id, Math.floor(Math.random() * 99999)) });
                break;
            default: {
                const [lo, hi] = objectParamRange(def, p, inst.values);
                W.slider(id, {
                    id: cid, label, value: Number(v), min: lo, max: hi, unit: p.unit, decimals: p.decimals ?? (p.type === "int" ? 0 : hi - lo < 0.2 ? 3 : 2),
                    step: p.type === "int" ? 1 : p.step, defaultValue: Number(p.default), tooltip: p.description,
                    onChange: x => setParam(inst, p.id, p.type === "int" ? Math.round(Number(x)) : Number(x)),
                });
            }
        }
    });
}

function renderProperties(): void {
    const id = propsWindow;
    const inst = selected();
    if (!inst) {
        W.label(id, { text: "Properties", bold: true, fontSize: 15 });
        W.label(id, { text: "Select an object in the viewport or the scene list to shape it.", color: DIM, wrap: true });
        W.spacer(id, 8);
        W.label(id, { text: "Tips", bold: true });
        for (const tip of ["Right-drag orbits, middle-drag pans, scroll zooms.", "V varies the selection, F frames it.", "Lock a control to keep it while you vary the rest."]) W.label(id, { text: `· ${tip}`, color: DIM, wrap: true });
        return;
    }
    const def = defOf(inst);
    const e = live.get(inst.id)?.baked.evaluation;
    W.horizontal(id, () => {
        W.label(id, { text: Icons.get(OBJECT_ICONS[def.id] ?? "cube"), fontSize: 20, color: ACCENT });
        W.vertical(id, () => {
            W.label(id, { text: inst.name ?? def.name, bold: true, fontSize: 15 });
            W.label(id, { text: e ? `${e.stats.triangles.toLocaleString()} triangles · ${e.stats.ms.toFixed(0)} ms` : "", color: DIM, monospace: true });
        });
    });

    // Variation: the headline action.
    W.card(id, { id: "mesha-variation-card", padding: 10, radius: 10 }, () => {
        W.horizontal(id, () => {
            W.button(id, { id: "mesha-vary", text: Icons.label("shuffle", "Variation"), accent: ACCENT, shortcut: "V", tooltip: "Another sensible version, keeping locked controls", onClick: runVariation, minWidth: 120 });
            W.button(id, { id: "mesha-reset", text: Icons.label("arrow-counter-clockwise", "Defaults"), onClick: () => applyPreset(inst, {}, "Defaults") });
        });
        W.slider(id, { id: "mesha-variation-amount", label: "Amount", value: variationAmount, min: 0, max: 1, decimals: 2, tooltip: "From tiny nudges to radically different designs", onChange: v => { variationAmount = Number(v); } });
        const locked = [...locksOf(inst)].length;
        W.label(id, { text: locked ? `${locked} locked · everything else varies` : "Nothing locked · everything varies", color: DIM });
    });

    const violations = ruleViolations(def, inst.values);
    for (const v of violations) W.label(id, { text: `${Icons.get("lightning")} ${v}`, color: WARN, wrap: true });

    // Presets: shipped and saved.
    const presets = [...(def.presets ?? []), ...userPresets(def.id)];
    W.horizontal(id, () => {
        W.dropdown(id, { id: "mesha-preset", label: "Preset", options: ["Choose...", ...presets.map(p => p.name)], selectedIndex: 0, onChange: x => { const p = presets[Number(x) - 1]; if (p) applyPreset(inst, p.values, p.name); } });
        W.button(id, { id: "mesha-save-preset", text: Icons.get("floppy-disk"), tooltip: "Save these settings as a preset", onClick: () => { statusMessage = `Saved "${saveUserPreset(inst)}".`; } });
    });

    // The most useful controls first, then every group.
    const visible = (p: ParamDef) => isParamVisible(def, p, inst.values);
    const featured = (def.featured ?? []).map(fid => def.params.find(p => p.id === fid)!).filter(p => p && visible(p));
    if (featured.length) {
        W.separator(id);
        for (const p of featured) paramControl(inst, def, p);
    }
    for (const g of def.groups) {
        const params = def.params.filter(p => p.group === g.id && visible(p) && !featured.includes(p));
        if (!params.length) continue;
        W.collapsingHeader(id, g.label, () => {
            W.horizontal(id, () => {
                lockButton(inst, `group:${g.id}`, `every ${g.label.toLowerCase()} control`);
                W.label(id, { text: isLocked({ group: g.id } as ParamDef, locksOf(inst)) ? "Group locked" : "Lock group", color: DIM });
            });
            for (const p of params) paramControl(inst, def, p);
        }, `mesha-group-${g.id}`, false);
    }

    W.collapsingHeader(id, "Placement", () => {
        const set = (f: (i: Instance) => void) => { beginEdit("Move"); f(inst); dirty.add(inst.id); groundDirty = true; syncGizmo(); };
        W.slider(id, { id: "mesha-pos-x", label: "X", value: inst.position[0], min: -8, max: 8, unit: "m", decimals: 2, onChange: v => set(i => { i.position = [Number(v), i.position[1], i.position[2]]; }) });
        W.slider(id, { id: "mesha-pos-z", label: "Z", value: inst.position[2], min: -8, max: 8, unit: "m", decimals: 2, onChange: v => set(i => { i.position = [i.position[0], i.position[1], Number(v)]; }) });
        W.slider(id, { id: "mesha-pos-y", label: "Lift", value: inst.position[1], min: 0, max: 3, unit: "m", decimals: 3, onChange: v => set(i => { i.position = [i.position[0], Number(v), i.position[2]]; }) });
        W.slider(id, { id: "mesha-rot", label: "Turn", value: inst.rotationY, min: -180, max: 180, unit: "°", decimals: 0, onChange: v => set(i => { i.rotationY = Number(v); i.rotation = undefined; }) });
        W.slider(id, { id: "mesha-scale", label: "Scale", value: inst.scale, min: 0.1, max: 4, decimals: 2, onChange: v => set(i => { i.scale = Number(v); }) });
    }, "mesha-group-placement", false);

    W.collapsingHeader(id, "Check this generator", () => {
        W.label(id, { text: "Tests every control at its extremes, every option, combinations and random designs.", color: DIM, wrap: true });
        W.button(id, { id: "mesha-verify", text: Icons.label("sparkle", "Run checks"), onClick: () => { verifyReport = acceptanceText(fuzz(def, lookupObject, { pairs: 12, random: 20 })); } });
        if (verifyReport) W.label(id, { text: verifyReport, monospace: true, wrap: true });
    }, "mesha-group-verify", false);

    W.spacer(id, 6);
    W.label(id, { text: statusMessage, color: DIM, wrap: true });
}

function setupUI(): void {
    const [sw, sh] = Entropy.Window.getSize();
    Entropy.UI.setTheme({
        background: [0.075, 0.08, 0.09, 0.72],
        surface: [0.14, 0.145, 0.16, 0.9],
        surfaceHover: [0.2, 0.205, 0.225, 1],
        border: [1, 1, 1, 0.07],
        text: [0.93, 0.93, 0.94, 1],
        accent: ACCENT,
        cornerRadius: 7,
        windowCornerRadius: 14,
        itemSpacing: 7,
        buttonPadding: [10, 5],
    });
    libraryWindow = Entropy.UI.createWindow({ title: "Library", width: 300, height: sh - 96, x: 16, y: 80, glass: true, onRender: renderLibrary });
    propsWindow = Entropy.UI.createWindow({ title: "Properties", width: 380, height: sh - 96, x: sw - 396, y: 80, glass: true, onRender: renderProperties });
    toolbarWindow = Entropy.UI.createWindow({ title: "Mesha", width: 820, height: 96, x: Math.round((sw - 820) / 2), y: 14, decorations: false, glass: true, onRender: renderToolbar });
}

// --- MCP tools -----------------------------------------------------------------------------------

type Args = Record<string, any>;

function instanceSummary(i: Instance) {
    // The evaluation for the current values (cached, so the next frame's rebuild reuses it), not
    // the last-rendered mesh, which a change made this frame hasn't rebuilt yet.
    let triangles: number | null = null;
    try { triangles = cache.get(i.objectId, i.values).stats.triangles; } catch { /* reported by rebuild */ }
    return { id: i.id, name: i.name, objectId: i.objectId, values: i.values, position: i.position, rotationY: i.rotationY, rotation: i.rotation, scale: i.scale, locks: scene.locks[i.id] ?? [], triangles, violations: ruleViolations(defOf(i), i.values) };
}

function target(args: Args): Instance {
    const inst = args.instanceId ? scene.instances.find(i => i.id === args.instanceId) : selected();
    if (!inst) throw new Error(args.instanceId ? `No instance ${args.instanceId}` : "Nothing is selected");
    return inst;
}

const TOOLS: { name: string; description: string; parameters: object; run: (a: Args) => unknown }[] = [
    {
        name: "mesha_library", description: "Search Mesha's procedural object library (empty query lists everything).",
        parameters: { type: "object", properties: { query: { type: "string" } } },
        run: a => ({ objects: searchLibrary(String(a.query ?? "")).map(d => ({ id: d.id, name: d.name, category: d.category, description: d.description, parameters: d.params.map(p => p.id), presets: (d.presets ?? []).map(p => p.name) })) }),
    },
    {
        name: "mesha_describe", description: "Parameters (ranges, groups, visibility), rules, regions and presets of one library object.",
        parameters: { type: "object", properties: { objectId: { type: "string" } }, required: ["objectId"] },
        run: a => { const d = lookupObject(String(a.objectId)); if (!d) throw new Error(`No object ${a.objectId}`); return { definition: d }; },
    },
    {
        name: "mesha_add", description: "Add a library object to the scene (and select it).",
        parameters: { type: "object", properties: { objectId: { type: "string" }, values: { type: "object" }, preset: { type: "string" }, position: { type: "array", items: { type: "number" } } }, required: ["objectId"] },
        run: a => {
            const def = lookupObject(String(a.objectId));
            const preset = a.preset ? def?.presets?.find(p => p.name === a.preset) : undefined;
            if (a.preset && !preset) throw new Error(`No preset "${a.preset}"`);
            return { instance: instanceSummary(addObject(String(a.objectId), { ...(preset?.values ?? {}), ...(a.values ?? {}) }, a.position)) };
        },
    },
    {
        name: "mesha_select", description: "Select an instance by id (null clears).",
        parameters: { type: "object", properties: { instanceId: { type: ["string", "null"] } }, required: ["instanceId"] },
        run: a => { beginEdit("Select"); select(a.instanceId ?? null); commitEdit(); return { selected: scene.selectedId }; },
    },
    {
        name: "mesha_set", description: "Set parameter values on the selected (or given) instance; values are clamped to their ranges.",
        parameters: { type: "object", properties: { instanceId: { type: "string" }, values: { type: "object" } }, required: ["values"] },
        run: a => {
            const inst = target(a), def = defOf(inst);
            const unknown = Object.keys(a.values ?? {}).filter(k => !def.params.some(p => p.id === k));
            if (unknown.length) throw new Error(`Unknown parameter(s): ${unknown.join(", ")}`);
            beginEdit("Set"); inst.values = resolveParams(def, { ...inst.values, ...a.values }); dirty.add(inst.id); groundDirty = true; commitEdit();
            return { instance: instanceSummary(inst) };
        },
    },
    {
        name: "mesha_lock", description: "Lock or unlock parameters (ids) or groups (\"group:<id>\") so Variation leaves them alone.",
        parameters: { type: "object", properties: { instanceId: { type: "string" }, keys: { type: "array", items: { type: "string" } }, locked: { type: "boolean" } }, required: ["keys", "locked"] },
        run: a => {
            const inst = target(a), locks = locksOf(inst);
            beginEdit("Lock");
            for (const k of a.keys as string[]) { if (a.locked) locks.add(k); else locks.delete(k); }
            scene.locks[inst.id] = [...locks]; commitEdit();
            return { locks: scene.locks[inst.id] };
        },
    },
    {
        name: "mesha_vary", description: "Variation: another sensible design for the selected instance, respecting locks and rules. amount 0..1.",
        parameters: { type: "object", properties: { amount: { type: "number" }, seed: { type: "number" } } },
        run: a => {
            if (typeof a.amount === "number") variationAmount = Math.max(0, Math.min(1, a.amount));
            if (typeof a.seed === "number") variationSeed = a.seed;
            runVariation();
            const inst = target({});
            return { instance: instanceSummary(inst), changed: lastVariation };
        },
    },
    {
        name: "mesha_place", description: "Move, turn (degrees) or scale the selected (or given) instance.",
        parameters: { type: "object", properties: { instanceId: { type: "string" }, position: { type: "array", items: { type: "number" } }, rotationY: { type: "number" }, scale: { type: "number" } } },
        run: a => {
            const inst = target(a);
            beginEdit("Move");
            if (Array.isArray(a.position)) inst.position = [Number(a.position[0]), Math.max(0, Number(a.position[1])), Number(a.position[2])];
            if (typeof a.rotationY === "number") { inst.rotationY = a.rotationY; inst.rotation = undefined; }
            if (typeof a.scale === "number") inst.scale = Math.max(0.01, a.scale);
            dirty.add(inst.id); groundDirty = true; commitEdit(); syncGizmo();
            return { instance: instanceSummary(inst) };
        },
    },
    {
        name: "mesha_remove", description: "Delete the selected (or given) instance.",
        parameters: { type: "object", properties: { instanceId: { type: "string" } } },
        run: a => { const inst = target(a); select(inst.id); removeSelected(); return { remaining: scene.instances.length }; },
    },
    {
        name: "mesha_undo", description: "Undo (or redo with redo: true) the last scene change.",
        parameters: { type: "object", properties: { redo: { type: "boolean" } } },
        run: a => { if (a.redo) redo(); else undo(); return { instances: scene.instances.map(instanceSummary), message: statusMessage }; },
    },
    {
        name: "mesha_view", description: "Frame the selection (or everything with all: true) from yaw/pitch degrees, and/or pick the studio lighting: studio, daylight, warm, night (lighting alone keeps the camera).",
        parameters: { type: "object", properties: { all: { type: "boolean" }, lighting: { type: "string" }, yaw: { type: "number" }, pitch: { type: "number" } } },
        run: a => {
            if (a.lighting) { const i = STUDIO_PRESETS.findIndex(p => p.id === a.lighting); if (i < 0) throw new Error(`Lighting: ${STUDIO_PRESETS.map(p => p.id).join(", ")}`); studioIndex = i; applyStudio(); }
            if (typeof a.yaw === "number" || typeof a.pitch === "number") {
                const yaw = ((a.yaw ?? 35) * Math.PI) / 180, pitch = ((a.pitch ?? 22) * Math.PI) / 180;
                const [, t] = Entropy.Camera.getTransform();
                Entropy.Camera.setTransform([t[0] + Math.sin(yaw) * Math.cos(pitch), t[1] + Math.sin(pitch), t[2] + Math.cos(yaw) * Math.cos(pitch)], t);
            }
            // Lighting alone leaves the camera where it is; anything else frames.
            if (!a.lighting || a.all !== undefined || typeof a.yaw === "number" || typeof a.pitch === "number") { pendingFrame = 2; pendingFrameAll = !!a.all; }
            return { lighting: STUDIO_PRESETS[studioIndex].id };
        },
    },
    {
        name: "mesha_state", description: "The scene: instances with their values, locks, triangle counts and rule warnings.",
        parameters: { type: "object", properties: {} },
        run: () => ({ selected: scene.selectedId, instances: scene.instances.map(instanceSummary), undo: undoStack.length, redo: redoStack.length, lighting: STUDIO_PRESETS[studioIndex].id }),
    },
    {
        name: "mesha_verify", description: "Fuzz a library object's parameters and report whether it is ready (geometry checks over extremes, options, pairs and random designs).",
        parameters: { type: "object", properties: { objectId: { type: "string" } } },
        run: a => {
            const ids = a.objectId ? [String(a.objectId)] : LIBRARY.map(d => d.id);
            return { reports: ids.map(id => { const d = lookupObject(id); if (!d) throw new Error(`No object ${id}`); const r = fuzz(d, lookupObject, { pairs: 12, random: 20 }); return { id, ready: r.ready, summary: acceptanceText(r), failures: r.failures.map(f => ({ label: f.label, issues: f.issues })) }; }) };
        },
    },
    {
        name: "mesha_export", description: "Export every object as a GLB (one mesh per object material). With `path` (ending .glb) it writes there without a dialog.",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        run: a => exportScene(a.path ? String(a.path) : undefined),
    },
];

function registerTools(): void {
    for (const t of TOOLS) {
        addon.registerTool({ name: t.name, description: t.description, parameters: t.parameters }, (args: Args) => {
            try {
                const result = t.run(args && typeof args === "object" ? args : {});
                return { success: true, ...(result as object) };
            } catch (error) {
                pendingSnapshot = null;
                return { success: false, error: (error as Error).message };
            }
        });
    }
}

// --- Lifecycle -----------------------------------------------------------------------------------

/** Frames to wait before framing (a new mesh needs a frame to exist). */
let pendingFrame = 0;
let pendingFrameAll = false;

addon.onInit(() => {
    pipelineId = Entropy.Pipeline.create({
        name: "MeshaStudio",
        layout: "mesh",
        pbr: false,
        vertexShader: MESHA_SHADER,
        fragmentShader: MESHA_SHADER,
        extraBindGroups: [{ entries: [
            { binding: 0, visibility: ["Fragment"], resourceType: "Uniform" },
            { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
        ] }],
    });
    studioBuffer = Entropy.Buffer.create({ size: STUDIO_FLOATS * 4, usage: "Uniform" });
    groundItemBuffer = Entropy.Buffer.create({ size: ITEM_FLOATS * 4, usage: "Uniform" });
    Entropy.Buffer.write(groundItemBuffer, new Float32Array([0, 0, 0, 0, ...identity4()]));
    createBackdrop();
    Entropy.setGameMode(false); // the gizmo renders only outside game mode
    const restored = loadSession();
    applyStudio();
    Entropy.Camera.setTransform([1.7, 1.25, 2.3], orbitTarget);
    enableOrbit(orbitTarget);
    setupUI();
    registerTools();
    if (restored) { statusMessage = "Welcome back."; pendingFrame = 3; pendingFrameAll = true; syncGizmo(); }
    else addObject("furniture.office_chair");
    // A fresh session should start with an empty undo history.
    undoStack.length = 0;
    Entropy.println("[mesha] initialized");
});

addon.onUpdatePlus("Global", () => {
    if (gizmoId && pointerHeld) {
        const s = Entropy.Gizmo.getState(gizmoId);
        if (s?.isActive) gizmoWasActive = true;
    }
    for (const id of dirty) {
        const inst = scene.instances.find(i => i.id === id);
        if (inst) rebuildInstance(inst);
    }
    if (dirty.size) { dirty.clear(); syncGizmo(); }
    if (!pointerHeld && transformed.size) {
        for (const id of transformed) {
            const inst = scene.instances.find(i => i.id === id);
            if (inst) refreshWorld(inst);
        }
        transformed.clear();
    }
    if (groundDirty && !(pointerHeld && (gizmoWasActive || transformed.size))) { rebuildGround(); groundDirty = false; }
    if (pendingFrame > 0 && --pendingFrame === 0) { frame(!pendingFrameAll); pendingFrameAll = false; }
    if (!pointerHeld) commitEdit();
    // Haze and the floor's fade follow the camera's focus distance (orbiting, zooming, framing).
    const [camPos, camTarget] = Entropy.Camera.getTransform();
    const focus = Math.hypot(camPos[0] - camTarget[0], camPos[1] - camTarget[1], camPos[2] - camTarget[2]);
    if (Number.isFinite(focus) && Math.abs(focus - studioFocus) > studioFocus * 0.05) { studioFocus = focus; applyStudio(); }
});
