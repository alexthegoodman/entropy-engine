/// <reference path="../../addon.d.ts" />
// Game World Detailer: the 3D half of game world design. The Game World Planner lays out a world
// from above (terrain, roads, towns building by building, NPCs and creatures, painted forests and
// fields, quests); the Detailer opens the same world file in 3D, up close, with every planned
// thing standing as a Mesha procedural model, and lets a level designer refine it: choose and shape
// the model of one building or of every inn, vary it, move and turn things on the ground, add
// props, tune what grows where, then export the whole level for an engine or an AI agent to build.
//
// Shared files, both ways:
// - worlds: the Planner's own `worlds/<id>.world.json` (IO.storeOf("game-world-planner")). Edits
//   to planned things (a building moved or turned, a spot, an NPC) are edits to the plan, and the
//   Detailer's own data rides along in `world.detail`. Each app watches the file and takes in the
//   other's saves, merging with its own unsaved edits (world_sync.ts).
// - Mesha: models are Mesha library objects with their parameters, exactly as Mesha stores them;
//   presets saved in Mesha are offered here and presets saved here appear in Mesha
//   (IO.storeOf("Mesha") presets/<objectId>.json).
//
// Performance, from The Abyss and Allegiance: instanced draws of shared cached geometry (one draw
// per model variant and level of detail), levels of detail by vertex clustering, Mesha evaluation
// in a worker isolate, a disk mesh cache, a triangle budget, view-cone culling, near-first
// streaming with per-frame budgets, size snapping so similar buildings share a mesh, and no work
// at all while the camera is still.

import type { GameWorld } from "../game_planner/planner_types";
import { WorldLibrary, type WorldSummary } from "../game_planner/world_store";
import { WorldFileWatcher, cloneWorld, mergeWorlds } from "../game_planner/world_sync";
import { sampleTerrain } from "../game_planner/terrain";
import { normalizeDeg, translateStructure, STRUCTURE_KINDS } from "../game_planner/town_planning";
import { lookupObject } from "../mesha/library";
import { searchLibrary } from "../mesha/mesha_scene";
import { resolveParams, isParamVisible, objectParamRange, materialChoices, type ParamDef, type ParamValues } from "../mesha/mesha_object";
import { MATERIAL_BY_ID } from "../mesha/mesha_materials";
import { vary } from "../mesha/mesha_variation";
import { STUDIO_PRESETS, STUDIO_FLOATS, packStudio } from "../mesha/mesha_shader";
import { sphere } from "../mesha/mesha_primitives";
import { InstanceBatches, meshCacheInstances } from "../quadplanet/qp_instances";
import { detailOf, type DetailProp, type ModelChoice, type WorldDetail, type EntityBinding } from "./detail_types";
import { Ground } from "./detail_ground";
import { buildSceneItems, type SceneItem } from "./detail_scene";
import { scatterTile, type ScatterInstance } from "./detail_scatter";
import { buildGroundTile, riverRibbon, toRender, fromRender, type RenderOrigin, type PackedMesh } from "./detail_mesh";
import { ModelStore, DETAIL_NAMESPACE, type ModelInfo } from "./detail_jobs";
import { DETAIL_SHADER, RECORD_FLOATS } from "./detail_shader";
import { chooseLod, drawDistance, tileResolution, maybeVisible, budgetLods, packRecord, IDENTITY_RECORD, ViewChange, yawOf, yawQuat, type V3 } from "./detail_view";
import { buildPackage, type ExportProgress, type ArchiveEntry } from "./detail_export";
import { FITTED_PARAMS, DEFAULT_SCATTER, choice } from "./detail_models";
import { createSampleWorld } from "./detail_sample";
import type { IconName } from "../../icon_names";

const PLANNER_STORE = "game-world-planner";
const MESHA_STORE = "Mesha";
const SAVED_BY = "game-world-detailer";
const WORKER_SCRIPT = "examples/studio-bundle/dist/game_detailer_worker.js";

const addon = Entropy.Addon.register({
    name: "game-world-detailer",
    version: "0.1.0",
    description: "Game World Detailer: the Game World Planner's worlds in 3D, every planned thing a Mesha model you can choose, shape, vary, move and turn; scatter from painted marks; props; one-click export of models (GLB), scene, heightmaps, materials and lore for any engine or AI agent.",
    author: ["Entropy Team", "Claude"],
    category: "Game Design",
    capabilities: { graphics: true, ui: true },
    sharedStores: [PLANNER_STORE, MESHA_STORE],
});

const W = Entropy.UI.Widget;
const Icons = Entropy.Icons;
type RGBA = [number, number, number, number];
const ACCENT: RGBA = [0.42, 0.8, 0.62, 1];
const DIM: RGBA = [0.66, 0.68, 0.72, 1];
const WARN: RGBA = [0.98, 0.72, 0.42, 1];
const SELECT_HIGHLIGHT = [0.42, 0.95, 0.7, 1];
const HOVER_HIGHLIGHT = [0.42, 0.95, 0.7, 0.35];
const TILE_KM = 0.128;
const VIEW_RADIUS_M = 980;
const SOURCE_ICONS: Record<SceneItem["source"], IconName> = { structure: "house", spot: "flag", placement: "person", prop: "cube" };

// -------------------------------------------------------------------------------------------------
// The open world
// -------------------------------------------------------------------------------------------------

let library: WorldLibrary | null = null;
let watcher: WorldFileWatcher | null = null;
let meshaStore: ReturnType<typeof addon.IO.storeOf> | null = null;
let world: GameWorld | null = null;
let detail: WorldDetail = detailOf({});
/** The world as it is on disk: the base of a three-way merge with the Planner's saves. */
let syncBase: GameWorld | null = null;
let dirty = false;
let saveDueAt = 0;
let lastSavedAt = 0;
let statusMessage = "Open a world planned in the Game World Planner.";
let ground: Ground | null = null;
let items: SceneItem[] = [];
let itemByKey = new Map<string, SceneItem>();
let selectedKey: string | null = null;
let hoverKey: string | null = null;
let worldsCache: WorldSummary[] = [];
let worldsCachedAt = -Infinity;

function toast(message: string, kind: "info" | "success" | "error" = "info"): void {
    try { Entropy.UI.toast?.({ id: "detailer", message, kind, durationMs: kind === "error" ? 0 : 3000 }); } catch { /* no toasts */ }
}

/** The plan without the bulky parts the Detailer never edits: the undo history keeps these. */
function editableSnapshot(): string {
    if (!world) return "";
    const { terrain: _t, overlay: _o, ...rest } = world;
    return JSON.stringify(rest);
}

function restoreSnapshot(text: string): void {
    if (!world) return;
    const back = JSON.parse(text);
    world = { ...back, terrain: world.terrain, overlay: world.overlay } as GameWorld;
    detail = detailOf(world);
    onWorldChanged(true);
}

// --- Undo / redo (one gesture is one step, like Mesha) ---------------------------------------------

const undoStack: { label: string; state: string }[] = [];
const redoStack: { label: string; state: string }[] = [];
let pendingSnapshot: { label: string; state: string } | null = null;
let pointerHeld = false;

function beginEdit(label: string): void {
    if (!pendingSnapshot && world) pendingSnapshot = { label, state: editableSnapshot() };
}

function commitEdit(): void {
    if (!pendingSnapshot) return;
    if (pendingSnapshot.state !== editableSnapshot()) {
        undoStack.push(pendingSnapshot);
        if (undoStack.length > 120) undoStack.shift();
        redoStack.length = 0;
        markDirty();
    }
    pendingSnapshot = null;
}

function undo(): void {
    commitEdit();
    const step = undoStack.pop();
    if (!step) { statusMessage = "Nothing to undo."; return; }
    redoStack.push({ label: step.label, state: editableSnapshot() });
    restoreSnapshot(step.state);
    markDirty();
    statusMessage = `Undid ${step.label.toLowerCase()}.`;
}

function redo(): void {
    const step = redoStack.pop();
    if (!step) { statusMessage = "Nothing to redo."; return; }
    undoStack.push({ label: step.label, state: editableSnapshot() });
    restoreSnapshot(step.state);
    markDirty();
    statusMessage = `Redid ${step.label.toLowerCase()}.`;
}

// --- Saving and syncing with the Planner --------------------------------------------------------

function markDirty(): void {
    dirty = true;
    saveDueAt = Date.now() + 700;
}

function saveSettings(): void {
    try { addon.IO.save({ kind: "detailer-settings", worldId: world?.meta.id, view: currentView() }); } catch { /* no data folder */ }
}

/** Saves the world into the Planner's library, taking in the Planner's own saves first. */
function saveWorld(): boolean {
    if (!library || !world) return false;
    try {
        syncFromDisk(true);
        const savedAt = Date.now();
        library.save(world, savedAt, SAVED_BY);
        syncBase = cloneWorld(world);
        watcher?.noteSaved(savedAt);
        dirty = false;
        lastSavedAt = savedAt;
        saveSettings();
        return true;
    } catch (e) {
        statusMessage = `Couldn't save: ${(e as Error).message}`;
        toast(statusMessage, "error");
        return false;
    }
}

/** The Planner saved this world: take it in (merging with unsaved edits here). */
function syncFromDisk(force = false): void {
    if (!watcher || !world) return;
    const change = watcher.poll(Date.now(), force);
    if (!change || change.world.meta.id !== world.meta.id) return;
    const who = change.savedBy === "game-world-planner" ? "Game World Planner" : "another app";
    if (!dirty || !syncBase) {
        world = change.world;
        statusMessage = `Updated from the ${who}.`;
    } else {
        const { world: merged, report } = mergeWorlds(syncBase, world, change.world);
        world = merged;
        statusMessage = `Merged ${report.incoming} change(s) from the ${who}` + (report.conflicts.length ? `; ${report.conflicts.length} conflict(s) kept yours.` : ".");
    }
    syncBase = cloneWorld(change.world);
    detail = detailOf(world);
    onWorldChanged(true);
    toast(statusMessage);
}

function listWorlds(force = false): WorldSummary[] {
    if (!library) return [];
    if (force || Date.now() - worldsCachedAt > 4000) {
        library.refresh();
        try { worldsCache = library.list(); } catch { worldsCache = []; }
        worldsCachedAt = Date.now();
    }
    return worldsCache;
}

function openWorld(id: string, view?: SavedView): boolean {
    if (!library) return false;
    if (world && dirty) saveWorld();
    const w = library.load(id);
    if (!w) { statusMessage = `No world "${id}" in the Planner's library.`; return false; }
    world = w;
    detail = detailOf(world);
    syncBase = cloneWorld(w);
    dirty = false;
    undoStack.length = 0; redoStack.length = 0;
    if (!watcher) watcher = new WorldFileWatcher(addon.IO.storeOf(PLANNER_STORE), id);
    watcher.watch(id);
    selectedKey = null;
    syncGizmo();
    onWorldChanged(true);
    const start = view ?? defaultView();
    if (start) goTo(start.x, start.y, start.distanceM, start.yawDeg, start.pitchDeg);
    saveSettings();
    statusMessage = `Opened "${w.meta.name}": ${items.length} things to detail.`;
    return true;
}

/** Saves a sample world into the Planner's library and opens it. */
function openSampleWorld(): boolean {
    if (!library) return false;
    const w = createSampleWorld();
    library.save(w, Date.now(), SAVED_BY);
    listWorlds(true);
    return openWorld(w.meta.id);
}

// -------------------------------------------------------------------------------------------------
// The level: ground and placed things
// -------------------------------------------------------------------------------------------------

/** Bumped when the ground changes: tiles of an older version are rebuilt (nearest first). */
let groundVersion = 0;
let scatterVersion = 0;
/** A building was dragged: re-level the ground once the drag ends. */
let groundStale = false;

function rebuildItems(): void {
    if (!world || !ground) { items = []; itemByKey = new Map(); return; }
    items = buildSceneItems(world, detail, ground);
    itemByKey = new Map(items.map((i) => [i.key, i]));
    if (selectedKey && !itemByKey.has(selectedKey)) {
        // A multi-piece building may have changed shape: keep it selected by its first piece.
        const src = selectedKey.split("#")[0];
        selectedKey = items.find((i) => i.key.startsWith(src))?.key ?? null;
    }
    forceRepack = true;
}

function rebuildGround(): void {
    if (!world) return;
    ground = new Ground(world, detail);
    groundVersion++;
    scatterVersion++;
    scatterTiles.clear();
    rebuildRivers();
}

function onWorldChanged(groundToo: boolean): void {
    if (groundToo || !ground) rebuildGround();
    rebuildItems();
    syncGizmo();
}

// -------------------------------------------------------------------------------------------------
// Rendering
// -------------------------------------------------------------------------------------------------

let pipelineId = "";
let studioBuffer = "";
let identityBuffer = "";
let skyBuffer = "";
const SKY_MESH_ID = "gd-sky";
const studioScratch = new Float32Array(STUDIO_FLOATS);
const skyScratch = new Float32Array(RECORD_FLOATS);
let origin: RenderOrigin = { x: 0, y: 0 };
let lightingIndex = 1;
let clock = 0;

const store = new ModelStore({
    status: (ns, k) => Entropy.MeshCache.status(ns, k),
    put: (ns, k, m, meta) => Entropy.MeshCache.put(ns, k, { vertexData: m.vertexData, indexData: m.indexData, meta }),
    meta: (ns, k) => Entropy.MeshCache.meta(ns, k),
    startJob: (job) => { try { return Entropy.Worker.start(WORKER_SCRIPT, job); } catch { return null; } },
    pollJob: (id) => Entropy.Worker.poll(id),
    now: () => Date.now(),
}, { maxInFlight: 3, minBuildIntervalMs: 120 });

const batches = new InstanceBatches(meshCacheInstances(DETAIL_NAMESPACE, () => pipelineId, () => studioBuffer), RECORD_FLOATS, { prefix: "gd-batch", idleFrames: 300 });

function bindings(storage: string) {
    return [
        { group: 2, binding: 0, resource: { type: "Buffer" as const, value: { id: studioBuffer } } },
        { group: 2, binding: 1, resource: { type: "Buffer" as const, value: { id: storage } } },
    ];
}

function spawnPacked(id: string, m: PackedMesh, storage = identityBuffer): void {
    addon.Model.clearMesh(id);
    addon.Model.createMesh({ id, position: [0, 0, 0], vertexData: Array.from(m.vertexData), indexData: Array.from(m.indexData), pipelineId, bindings: bindings(storage) });
    Entropy.Model.setBounds(id, [m.bounds[0], m.bounds[1], m.bounds[2]], m.bounds[3]);
}

function applyLighting(): void {
    const l = STUDIO_PRESETS[lightingIndex] ?? STUDIO_PRESETS[1];
    // The haze scale: aerial perspective from ~300 m, thick only near the far plane (Mesha frames a chair at 3 m).
    studioScratch.set(packStudio(l, 300));
    Entropy.Lighting.updateSun({ horizonColor: l.skyHorizon, zenithColor: l.skyTop, sunDirection: l.keyDir, sunColor: l.keyColor, sunIntensity: 0.4 });
}

function writeStudio(): void {
    studioScratch[26] = clock;
    Entropy.Buffer.write(studioBuffer, studioScratch);
}

function initRendering(): void {
    pipelineId = Entropy.Pipeline.create({
        name: "GameDetailer",
        layout: "mesh",
        pbr: false,
        vertexShader: DETAIL_SHADER,
        fragmentShader: DETAIL_SHADER,
        extraBindGroups: [{ entries: [
            { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
            { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "StorageReadOnly" },
        ] }],
    });
    studioBuffer = Entropy.Buffer.create({ size: STUDIO_FLOATS * 4, usage: "Uniform" });
    identityBuffer = Entropy.Buffer.create({ size: RECORD_FLOATS * 4, usage: "Storage" });
    Entropy.Buffer.write(identityBuffer, IDENTITY_RECORD);
    skyBuffer = Entropy.Buffer.create({ size: RECORD_FLOATS * 4, usage: "Storage" });
    // The sky: a dome drawn with Mesha's backdrop pattern (7), following the camera.
    const dome = sphere(900, 40, 20).parts[0];
    const v: number[] = [];
    for (let i = 0; i < dome.positions.length / 3; i++) v.push(dome.positions[i * 3], dome.positions[i * 3 + 1], dome.positions[i * 3 + 2], 0, 8, 0, 0, 0, 1, 1, 1, 1);
    const idx: number[] = [];
    for (let t = 0; t < dome.indices.length; t += 3) idx.push(dome.indices[t], dome.indices[t + 2], dome.indices[t + 1]);
    addon.Model.createMesh({ id: SKY_MESH_ID, position: [0, 0, 0], vertexData: v, indexData: idx, pipelineId, bindings: bindings(skyBuffer) });
    try { Entropy.MeshCache.prune(DETAIL_NAMESPACE, 3e9); } catch { /* no cache */ }
    applyLighting();
    writeStudio();
}

// --- Ground tiles ---------------------------------------------------------------------------------

interface Tile { tx: number; ty: number; res: number; version: number; meshId: string; waterId: string | null }
const tiles = new Map<string, Tile>();
let tileSerial = 0;
let riverIds: string[] = [];

function clearGround(): void {
    for (const t of tiles.values()) { addon.Model.clearMesh(t.meshId); if (t.waterId) addon.Model.clearMesh(t.waterId); }
    tiles.clear();
    for (const id of riverIds) addon.Model.clearMesh(id);
    riverIds = [];
}

function rebuildRivers(): void {
    for (const id of riverIds) addon.Model.clearMesh(id);
    riverIds = [];
    if (!ground || !pipelineId) return;
    for (const r of ground.riverRibbons()) {
        const m = riverRibbon(origin, r.points, r.halfWidthKm, r.levels);
        if (!m) continue;
        const id = `gd-river-${tileSerial++}`;
        spawnPacked(id, m);
        riverIds.push(id);
    }
}

/** Builds and drops ground tiles around the camera, nearest first, within `budgetMs`. */
function streamGround(cam: V3, budgetMs: number): number {
    if (!ground || !world) return 0;
    const [cx, cy] = fromRender(origin, cam[0], cam[2]);
    const reach = VIEW_RADIUS_M / 1000;
    const want: Array<{ tx: number; ty: number; dist: number; res: number }> = [];
    for (let tx = Math.floor((cx - reach) / TILE_KM); tx <= Math.floor((cx + reach) / TILE_KM); tx++) {
        for (let ty = Math.floor((cy - reach) / TILE_KM); ty <= Math.floor((cy + reach) / TILE_KM); ty++) {
            const nx = Math.max(tx * TILE_KM, Math.min(cx, (tx + 1) * TILE_KM)), ny = Math.max(ty * TILE_KM, Math.min(cy, (ty + 1) * TILE_KM));
            const dist = Math.hypot(nx - cx, ny - cy) * 1000;
            if (dist > VIEW_RADIUS_M) continue;
            const W2 = world.meta.worldWidthKm / 2, H2 = world.meta.worldHeightKm / 2;
            if ((tx + 1) * TILE_KM < -W2 || tx * TILE_KM > W2 || (ty + 1) * TILE_KM < -H2 || ty * TILE_KM > H2) continue;
            want.push({ tx, ty, dist, res: tileResolution(dist) });
        }
    }
    const wanted = new Set(want.map((w) => `${w.tx},${w.ty}`));
    for (const [k, t] of tiles) {
        if (wanted.has(k)) continue;
        addon.Model.clearMesh(t.meshId);
        if (t.waterId) addon.Model.clearMesh(t.waterId);
        tiles.delete(k);
    }
    want.sort((a, b) => a.dist - b.dist);
    const started = Date.now();
    let built = 0;
    for (const w of want) {
        const k = `${w.tx},${w.ty}`;
        const t = tiles.get(k);
        // Keep a tile whose resolution is within a step of what is wanted (no rebuild churn at ring edges).
        if (t && t.version === groundVersion && (t.res === w.res || (t.res > w.res && t.res <= w.res * 2))) continue;
        if (built > 0 && Date.now() - started > budgetMs) break;
        const m = buildGroundTile(ground, origin, w.tx * TILE_KM, w.ty * TILE_KM, TILE_KM, w.res);
        const meshId = `gd-ground-${tileSerial++}`;
        spawnPacked(meshId, m);
        let waterId: string | null = null;
        if (m.water) { waterId = `gd-water-${tileSerial++}`; spawnPacked(waterId, m.water); }
        if (t) { addon.Model.clearMesh(t.meshId); if (t.waterId) addon.Model.clearMesh(t.waterId); }
        tiles.set(k, { tx: w.tx, ty: w.ty, res: w.res, version: groundVersion, meshId, waterId });
        built++;
    }
    return built;
}

// --- Scatter --------------------------------------------------------------------------------------

const scatterTiles = new Map<string, { version: number; list: ScatterInstance[] }>();

function streamScatter(cam: V3, budgetMs: number): boolean {
    if (!ground || !world) return false;
    const [cx, cy] = fromRender(origin, cam[0], cam[2]);
    const reach = 0.7;
    const started = Date.now();
    let changed = false;
    const order: Array<[number, number, number]> = [];
    for (let tx = Math.floor((cx - reach) / TILE_KM); tx <= Math.floor((cx + reach) / TILE_KM); tx++)
        for (let ty = Math.floor((cy - reach) / TILE_KM); ty <= Math.floor((cy + reach) / TILE_KM); ty++)
            order.push([tx, ty, Math.hypot((tx + 0.5) * TILE_KM - cx, (ty + 0.5) * TILE_KM - cy)]);
    order.sort((a, b) => a[2] - b[2]);
    for (const [tx, ty, d] of order) {
        if (d > reach) continue;
        const k = `${tx},${ty}`;
        const have = scatterTiles.get(k);
        if (have && have.version === scatterVersion) continue;
        if (Date.now() - started > budgetMs) break;
        scatterTiles.set(k, { version: scatterVersion, list: scatterTile(ground, detail, tx, ty, TILE_KM, { density: detail.quality.scatterDensity }) });
        changed = true;
    }
    // Forget tiles far behind.
    if (scatterTiles.size > 600) for (const k of [...scatterTiles.keys()].slice(0, 200)) scatterTiles.delete(k);
    return changed;
}

// --- Instances ------------------------------------------------------------------------------------

const viewChange = new ViewChange(1.5, 0.06, 90);
let forceRepack = true;
let stats = { instances: 0, batches: 0, triangles: 0, culled: 0, pending: 0, tiles: 0 };

interface Drawn { info: ModelInfo; x: number; y: number; z: number; yaw: number; scale: number; distance: number; lod: number; triangles: number[]; highlight: number[] | null; sway: number }

function repack(cam: V3, forward: V3): void {
    if (!world || !ground) return;
    const drawn: Drawn[] = [];
    let culled = 0;
    const lodScale = detail.quality.lodScale;
    const consider = (info: ModelInfo, x: number, y: number, z: number, yaw: number, scale: number, highlight: number[] | null, sway: number): void => {
        if (info.state !== "ready") return;
        const r = info.radius * scale;
        const cx = x + info.center[0] * scale, cy = y + info.center[1] * scale, cz = z + info.center[2] * scale;
        const distance = Math.hypot(cx - cam[0], cy - cam[1], cz - cam[2]);
        if (distance - r > drawDistance(r, lodScale)) { culled++; return; }
        if (!maybeVisible(cam, forward, [cx, cy, cz], r)) { culled++; return; }
        const lod = info.keys.length > 1 ? chooseLod(distance, r, lodScale, info.keys.length) : 0;
        drawn.push({ info, x, y, z, yaw, scale, distance, lod, triangles: info.triangles, highlight, sway });
    };
    const [camX, camY] = fromRender(origin, cam[0], cam[2]);
    for (const it of items) {
        if (it.hidden) continue;
        const [rx, rz] = toRender(origin, it.x, it.y);
        const near = Math.hypot(rx - cam[0], rz - cam[2]);
        if (near > VIEW_RADIUS_M + 200) continue;
        const info = it.builtin ? store.wantBuiltin(it.builtin) : store.want(it.model!.objectId, it.model!.values, near);
        const highlight = it.key === selectedKey || (selectedKey && it.sourceId === itemByKey.get(selectedKey)?.sourceId) ? SELECT_HIGHLIGHT : it.key === hoverKey ? HOVER_HIGHLIGHT : null;
        consider(info, rx, it.elevation, rz, it.yaw, it.scale, highlight, 0);
    }
    for (const t of scatterTiles.values()) {
        for (const s of t.list) {
            if (Math.hypot(s.x - camX, s.y - camY) > 0.75) continue;
            const [rx, rz] = toRender(origin, s.x, s.y);
            const info = store.want(s.model.objectId, s.model.values, Math.hypot(rx - cam[0], rz - cam[2]) + 60);
            consider(info, rx, s.elevation, rz, s.yaw, s.scale, null, 1);
        }
    }
    const triangles = budgetLods(drawn, detail.quality.triangleBudget);
    batches.begin();
    for (const d of drawn) {
        const key = d.info.keys[Math.min(d.lod, d.info.keys.length - 1)];
        const r = d.info.radius * d.scale;
        const slot = batches.add(key, [d.x + d.info.center[0] * d.scale, d.y + d.info.center[1] * d.scale, d.z + d.info.center[2] * d.scale, r]);
        packRecord(slot.data, slot.offset, d.x, d.y, d.z, d.yaw, d.scale, d.highlight, 1, d.sway);
    }
    const s = batches.flush();
    stats = { instances: s.instances, batches: s.drawnBatches, triangles, culled, pending: store.pending, tiles: tiles.size };
    if (Entropy.Profile?.enabled?.()) {
        Entropy.Profile.count("gd instances", s.instances);
        Entropy.Profile.count("gd batches", s.drawnBatches);
    }
}

// -------------------------------------------------------------------------------------------------
// Camera
// -------------------------------------------------------------------------------------------------

interface SavedView { x: number; y: number; yawDeg: number; pitchDeg: number; distanceM: number }
let zoomSpeed = 2;

/** The camera as last set here or by the orbit control (native reads lag a frame and give a direction, not a target). */
let camPos: V3 = [120, 120, 120];
let camTarget: V3 = [0, 0, 0];

function cameraNow(): { pos: V3; target: V3 } {
    const st = (Entropy.Controls as unknown as { _state?: { format: string; position: V3; target: V3 } })._state;
    if (st?.format === "orbit" && st.position && st.target) return { pos: [...st.position] as V3, target: [...st.target] as V3 };
    return { pos: camPos, target: camTarget };
}

/** Puts the camera at `pos` looking at `target`, and the orbit control around `target`. */
function setCamera(pos: V3, target: V3): void {
    camPos = pos; camTarget = target;
    Entropy.Camera.setTransform(pos, target);
    addon.Controls.enable("orbit", { target, trigger: "always", button: 1, panButton: 2, zoomButton: -1, panSpeed: 0.02, zoomSpeed, invertX: true });
    // The control seeded itself from the native camera, which hasn't taken this move yet: seed it here.
    const st = (Entropy.Controls as unknown as { _state?: Record<string, any> })._state;
    if (st) {
        const dx = pos[0] - target[0], dy = pos[1] - target[1], dz = pos[2] - target[2];
        st.position = [...pos];
        st.distance = Math.max(0.001, Math.hypot(dx, dy, dz));
        st.yaw = Math.atan2(dz, dx);
        st.pitch = Math.asin(Math.max(-1, Math.min(1, dy / st.distance)));
    }
}

/** Moves the render origin so the camera works near (0, 0): float precision on big worlds. */
function rebase(x: number, y: number): void {
    if (Math.hypot(x - origin.x, y - origin.y) < 2 && tiles.size) return;
    origin = { x, y };
    clearGround();
    rebuildRivers();
    forceRepack = true;
}

function goTo(x: number, y: number, distanceM = 160, yawDeg = 35, pitchDeg = 32): void {
    if (!ground) return;
    rebase(x, y);
    const [rx, rz] = toRender(origin, x, y);
    const h = ground.heightAt(x, y);
    const yaw = (yawDeg * Math.PI) / 180, pitch = (pitchDeg * Math.PI) / 180;
    const target: V3 = [rx, h + 2, rz];
    const pos: V3 = [rx + Math.sin(yaw) * Math.cos(pitch) * distanceM, h + 2 + Math.sin(pitch) * distanceM, rz + Math.cos(yaw) * Math.cos(pitch) * distanceM];
    zoomSpeed = Math.max(0.5, distanceM / 60);
    setCamera(pos, target);
    forceRepack = true;
}

function currentView(): SavedView | null {
    if (!world) return null;
    const { pos, target } = cameraNow();
    const [x, y] = fromRender(origin, target[0], target[2]);
    const d: V3 = [pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]];
    const dist = Math.hypot(...d) || 1;
    return { x, y, distanceM: dist, yawDeg: (Math.atan2(d[0], d[2]) * 180) / Math.PI, pitchDeg: (Math.asin(d[1] / dist) * 180) / Math.PI };
}

function defaultView(): SavedView | null {
    if (!world) return null;
    const site = detail.sites[0];
    if (site) return site;
    // The biggest settlement with buildings, else the first spot.
    const counts = new Map<string, number>();
    for (const s of world.structures ?? []) if (s.spotId) counts.set(s.spotId, (counts.get(s.spotId) ?? 0) + 1);
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    const spot = (best && world.spots.find((s) => s.id === best[0])) || world.spots[0];
    return spot ? { x: spot.x, y: spot.y, distanceM: 220, yawDeg: 35, pitchDeg: 34 } : { x: 0, y: 0, distanceM: 300, yawDeg: 35, pitchDeg: 34 };
}

const held = new Set<string>();

/** WASD slides the view over the ground (Shift: faster), Q/E turn it. */
function moveCamera(dt: number): void {
    if (!held.size || !ground || Entropy.Input.isTypingInUI?.()) return;
    const { pos, target } = cameraNow();
    const dx = target[0] - pos[0], dz = target[2] - pos[2];
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len, fz = dz / len;
    const dist = Math.hypot(pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]);
    const speed = Math.max(8, dist * 0.9) * (held.has("shift") ? 3 : 1) * dt;
    let mx = 0, mz = 0;
    if (held.has("w")) { mx += fx; mz += fz; }
    if (held.has("s")) { mx -= fx; mz -= fz; }
    if (held.has("a")) { mx += fz; mz -= fx; }
    if (held.has("d")) { mx -= fz; mz += fx; }
    let turn = 0;
    if (held.has("q")) turn += dt * 1.2;
    if (held.has("e")) turn -= dt * 1.2;
    if (!mx && !mz && !turn) return;
    const nt: V3 = [target[0] + mx * speed, target[1], target[2] + mz * speed];
    const [kx, ky] = fromRender(origin, nt[0], nt[2]);
    nt[1] = ground.heightAt(kx, ky) + 2;
    let ox = pos[0] - target[0], oz = pos[2] - target[2];
    if (turn) { const c = Math.cos(turn), s = Math.sin(turn); [ox, oz] = [ox * c - oz * s, ox * s + oz * c]; }
    const np: V3 = [nt[0] + ox, nt[1] + (pos[1] - target[1]), nt[2] + oz];
    setCamera(np, nt);
    if (Math.hypot(kx - origin.x, ky - origin.y) > 3) {
        const view = currentView();
        rebase(kx, ky);
        if (view) goTo(view.x, view.y, view.distanceM, view.yawDeg, view.pitchDeg);
    }
}

// -------------------------------------------------------------------------------------------------
// Picking and editing
// -------------------------------------------------------------------------------------------------

const selected = (): SceneItem | undefined => (selectedKey ? itemByKey.get(selectedKey) : undefined);

function pickItem(o: V3, d: V3): SceneItem | null {
    let best: { item: SceneItem; t: number } | null = null;
    for (const it of items) {
        if (it.hidden) continue;
        const info = it.builtin ? store.wantBuiltin(it.builtin) : store.info(it.model!.objectId, it.model!.values);
        const [rx, rz] = toRender(origin, it.x, it.y);
        const r = info?.state === "ready" ? info.radius * it.scale * 0.85 : Math.max(2, Math.max(...(it.footprint ?? [4, 4])) / 2);
        const c: V3 = info?.state === "ready" ? [rx + info.center[0] * it.scale, it.elevation + info.center[1] * it.scale, rz + info.center[2] * it.scale] : [rx, it.elevation + r, rz];
        const ox = o[0] - c[0], oy = o[1] - c[1], oz = o[2] - c[2];
        const b = ox * d[0] + oy * d[1] + oz * d[2];
        const disc = b * b - (ox * ox + oy * oy + oz * oz - r * r);
        if (disc < 0) continue;
        const t = -b - Math.sqrt(disc);
        const tt = t > 0 ? t : -b + Math.sqrt(disc);
        if (tt <= 0) continue;
        // Prefer the smaller of overlapping things a little (a person in front of a house).
        const score = tt + r * 0.15;
        if (!best || score < best.t) best = { item: it, t: score };
    }
    return best?.item ?? null;
}

/** Where a ray meets the ground (world km), or null. */
function pickGround(o: V3, d: V3): [number, number] | null {
    if (!ground) return null;
    let prev = 0;
    for (let t = 1; t < 1500; t += Math.max(1, t * 0.02)) {
        const p: V3 = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
        const [x, y] = fromRender(origin, p[0], p[2]);
        if (p[1] <= ground.heightAt(x, y)) {
            let lo = prev, hi = t;
            for (let k = 0; k < 18; k++) {
                const m = (lo + hi) / 2;
                const q: V3 = [o[0] + d[0] * m, o[1] + d[1] * m, o[2] + d[2] * m];
                const [qx, qy] = fromRender(origin, q[0], q[2]);
                if (q[1] <= ground.heightAt(qx, qy)) hi = m; else lo = m;
            }
            const q: V3 = [o[0] + d[0] * hi, 0, o[2] + d[2] * hi];
            return fromRender(origin, q[0], q[2]);
        }
        prev = t;
    }
    return null;
}

function select(key: string | null): void {
    if (selectedKey === key) return;
    selectedKey = key;
    forceRepack = true;
    if (gizmoId) { Entropy.Gizmo.hide(gizmoId); gizmoId = null; }
    syncGizmo();
}

const bindingOf = (id: string): EntityBinding => (detail.bindings[id] ??= {});
const structureOf = (id: string) => world?.structures?.find((s) => s.id === id);

/** The planned thing's own position (km): what a move edits. */
function anchorOf(it: SceneItem): { x: number; y: number; yawDeg: number } | null {
    if (!world) return null;
    if (it.source === "structure") { const s = structureOf(it.sourceId); return s ? { x: s.x, y: s.y, yawDeg: s.rotationDeg + (detail.bindings[s.id]?.yawDeg ?? 0) } : null; }
    if (it.source === "spot") { const s = world.spots.find((x) => x.id === it.sourceId); return s ? { x: s.x, y: s.y, yawDeg: detail.bindings[s.id]?.yawDeg ?? 0 } : null; }
    if (it.source === "placement") { const p = world.placements?.find((x) => x.id === it.sourceId); return p ? { x: p.x, y: p.y, yawDeg: detail.bindings[p.id]?.yawDeg ?? 0 } : null; }
    const p = detail.props.find((x) => x.id === it.sourceId);
    return p ? { x: p.x, y: p.y, yawDeg: p.yawDeg } : null;
}

/** Moves the selected thing by meters (east, up, south) - in the plan, for planned things. */
function moveSelected(dx: number, dy: number, dz: number, label = "Move"): void {
    const it = selected();
    if (!it || !world) return;
    beginEdit(label);
    const dxKm = dx / 1000, dyKm = -dz / 1000;
    const r4 = (v: number) => Math.round(v * 1e5) / 1e5;
    if (it.source === "structure") {
        const s = structureOf(it.sourceId);
        if (s) { Object.assign(s, translateStructure(s, dxKm, dyKm)); groundStale = true; }
    } else if (it.source === "spot") {
        const s = world.spots.find((x) => x.id === it.sourceId);
        if (s) {
            s.x = r4(s.x + dxKm); s.y = r4(s.y + dyKm);
            if (s.snapToGround !== false && world.terrain) s.elevation = Math.round(sampleTerrain(world.terrain, world.meta, s.x, s.y));
            else s.elevation += dy;
        }
    } else if (it.source === "placement") {
        const p = world.placements?.find((x) => x.id === it.sourceId);
        if (p) { p.x = r4(p.x + dxKm); p.y = r4(p.y + dyKm); }
    } else {
        const p = detail.props.find((x) => x.id === it.sourceId);
        if (p) { p.x = r4(p.x + dxKm); p.y = r4(p.y + dyKm); p.lift = Math.max(-5, (p.lift || 0) + dy); }
    }
    rebuildItems();
    syncGizmo();
}

/** Turns the selected thing to a heading (radians). */
function turnSelected(yaw: number, label = "Turn"): void {
    const it = selected();
    if (!it || !world) return;
    beginEdit(label);
    const deg = normalizeDeg((yaw * 180) / Math.PI);
    if (it.source === "structure") {
        const s = structureOf(it.sourceId);
        if (s) { s.rotationDeg = normalizeDeg(deg - (detail.bindings[s.id]?.yawDeg ?? 0)); groundStale = true; }
    } else if (it.source === "prop") {
        const p = detail.props.find((x) => x.id === it.sourceId);
        if (p) p.yawDeg = deg;
    } else bindingOf(it.sourceId).yawDeg = deg;
    rebuildItems();
}

let gizmoId: string | null = null;
let gizmoWasActive = false;

function gizmoAnchor(it: SceneItem): V3 {
    const a = anchorOf(it);
    const [rx, rz] = toRender(origin, a?.x ?? it.x, a?.y ?? it.y);
    return [rx, it.elevation, rz];
}

function syncGizmo(): void {
    const it = selected();
    if (!it) { if (gizmoId) { Entropy.Gizmo.hide(gizmoId); gizmoId = null; } return; }
    const pos = gizmoAnchor(it);
    const yaw = ((anchorOf(it)?.yawDeg ?? 0) * Math.PI) / 180;
    if (gizmoId) { Entropy.Gizmo.updatePosition(gizmoId, pos); Entropy.Gizmo.updateRotation(gizmoId, yawQuat(yaw)); return; }
    gizmoId = Entropy.Gizmo.show({
        position: pos, mode: "translate_rotate", rotation: yawQuat(yaw), space: "world",
        onTransform: (delta) => { gizmoWasActive = true; moveSelected(delta[0], delta[1], delta[2]); },
        onRotate: (q) => { gizmoWasActive = true; turnSelected(yawOf(q)); syncGizmo(); },
        onComplete: () => commitEdit(),
    });
}

// --- Models: choose, shape, vary ------------------------------------------------------------------

type Scope = "this" | "kind";
let editScope: Scope = "this";
let variationAmount = 0.4;
let variationSeed = 1;
let modelQuery = "";

/** The key in `detail.models` for the selected thing's whole kind, and its label. */
function kindKeyOf(it: SceneItem): { key: string; label: string } | null {
    if (!world) return null;
    if (it.source === "structure") { const s = structureOf(it.sourceId); return s ? { key: `structure:${s.kind}`, label: `every ${STRUCTURE_KINDS[s.kind]?.label.toLowerCase() ?? s.kind}` } : null; }
    if (it.source === "spot") { const s = world.spots.find((x) => x.id === it.sourceId); return s ? { key: `spot:${s.spotType}`, label: `every ${s.spotType}` } : null; }
    if (it.source === "placement") { const p = world.placements?.find((x) => x.id === it.sourceId); const c = world.codex.find((x) => x.id === p?.codexId); return c ? { key: `codex:${c.id}`, label: `every ${c.name}` } : null; }
    return null;
}

/** The model the selected thing's edits change (this one's, or its kind's), made if needed. */
function editableModel(it: SceneItem, scope: Scope): ModelChoice | null {
    if (it.source === "prop") {
        const p = detail.props.find((x) => x.id === it.sourceId);
        return p ? { objectId: p.objectId, values: p.values } : null;
    }
    if (!it.model) return null;
    if (scope === "kind") {
        const k = kindKeyOf(it);
        if (!k) return null;
        return (detail.models[k.key] ??= { objectId: it.model.objectId, values: stripFitted(it.model) });
    }
    const b = bindingOf(it.sourceId);
    return (b.model ??= { objectId: it.model.objectId, values: stripFitted(it.model) });
}

/** A model's values without what the footprint sets (those follow the plan). */
function stripFitted(m: ModelChoice): ParamValues {
    const out = { ...m.values };
    for (const k of FITTED_PARAMS[m.objectId] ?? []) delete out[k];
    return out;
}

function setModel(it: SceneItem, next: ModelChoice, scope: Scope): void {
    beginEdit("Change model");
    if (it.source === "prop") {
        const p = detail.props.find((x) => x.id === it.sourceId);
        if (p) { p.objectId = next.objectId; p.values = { ...next.values }; }
    } else if (scope === "kind") {
        const k = kindKeyOf(it);
        if (k) detail.models[k.key] = { ...next, values: { ...next.values } };
    } else bindingOf(it.sourceId).model = { ...next, values: { ...next.values } };
    commitEdit();
    rebuildItems();
}

function setParam(it: SceneItem, id: string, value: number | boolean | string): void {
    beginEdit("Shape");
    const m = editableModel(it, editScope);
    if (!m) return;
    const def = lookupObject(m.objectId);
    m.values = def ? resolveParams(def, { ...m.values, [id]: value }) : { ...m.values, [id]: value };
    for (const k of FITTED_PARAMS[m.objectId] ?? []) delete m.values[k];
    if (it.source === "prop") { const p = detail.props.find((x) => x.id === it.sourceId); if (p) p.values = m.values; }
    rebuildItems();
}

function varySelected(): string[] {
    const it = selected();
    if (!it) return [];
    const m = editableModel(it, editScope);
    const def = m && lookupObject(m.objectId);
    if (!m || !def) return [];
    beginEdit("Variation");
    const r = vary(def, m.values, { amount: variationAmount, seed: variationSeed++, locked: FITTED_PARAMS[m.objectId] ?? [] });
    m.values = r.values;
    for (const k of FITTED_PARAMS[m.objectId] ?? []) delete m.values[k];
    if (it.source === "prop") { const p = detail.props.find((x) => x.id === it.sourceId); if (p) p.values = m.values; }
    commitEdit();
    rebuildItems();
    statusMessage = r.changed.length ? `Variation changed ${r.changed.length} control(s).` : "Variation found nothing to change.";
    return r.changed;
}

/** Shipped presets and the ones saved in Mesha (shared). */
function presetsFor(objectId: string): Array<{ name: string; values: ParamValues; mine: boolean }> {
    const def = lookupObject(objectId);
    const shipped = (def?.presets ?? []).map((p) => ({ name: p.name, values: p.values, mine: false }));
    let mine: Array<{ name: string; values: ParamValues }> = [];
    try { mine = JSON.parse(meshaStore?.read(`presets/${objectId}.json`) ?? "[]"); } catch { mine = []; }
    return [...shipped, ...mine.map((p) => ({ ...p, mine: true }))];
}

/** Saves the selected model as a Mesha preset (it shows up in Mesha's preset list too). */
function savePreset(it: SceneItem): string | null {
    const m = editableModel(it, editScope);
    if (!m || !meshaStore) return null;
    const def = lookupObject(m.objectId);
    let list: Array<{ name: string; values: ParamValues }> = [];
    try { list = JSON.parse(meshaStore.read(`presets/${m.objectId}.json`) ?? "[]"); } catch { list = []; }
    const name = `${world?.meta.name ?? "Level"} ${def?.name.toLowerCase() ?? "model"} ${list.length + 1}`;
    list.push({ name, values: { ...m.values } });
    meshaStore.write(`presets/${m.objectId}.json`, JSON.stringify(list, null, 2));
    return name;
}

// --- Props ----------------------------------------------------------------------------------------

let placeObjectId: string | null = null;

function addProp(objectId: string, x: number, y: number, values: ParamValues = {}): DetailProp {
    beginEdit("Add prop");
    const def = lookupObject(objectId);
    const anchor = world?.spots.slice().sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
    const p: DetailProp = { id: `prop_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`, objectId, values: def ? resolveParams(def, values) : values, x, y, lift: 0, yawDeg: 0, scale: 1, ...(anchor && Math.hypot(anchor.x - x, anchor.y - y) < 1.5 ? { anchorId: anchor.id } : {}) };
    detail.props.push(p);
    commitEdit();
    rebuildItems();
    select(`prop:${p.id}`);
    return p;
}

function removeSelected(): void {
    const it = selected();
    if (!it) return;
    beginEdit(it.source === "prop" ? "Delete prop" : "Hide");
    if (it.source === "prop") detail.props = detail.props.filter((p) => p.id !== it.sourceId);
    else bindingOf(it.sourceId).hidden = true;
    commitEdit();
    select(null);
    rebuildItems();
    statusMessage = it.source === "prop" ? "Prop deleted." : `${it.name} hidden in 3D (it stays in the plan; show it again from the outliner).`;
}

function duplicateSelected(): void {
    const it = selected();
    if (!it || it.source !== "prop") return;
    const p = detail.props.find((x) => x.id === it.sourceId);
    if (p) { const c = addProp(p.objectId, p.x + 0.003, p.y, p.values); c.yawDeg = p.yawDeg; c.scale = p.scale; c.lift = p.lift; rebuildItems(); }
}

// -------------------------------------------------------------------------------------------------
// Export
// -------------------------------------------------------------------------------------------------

let exportJob: { gen: Generator<ExportProgress, ArchiveEntry[], void>; progress: ExportProgress; path?: string } | null = null;

function exportSites(): Array<{ name: string; x: number; y: number }> {
    if (detail.sites.length) return detail.sites.map((s) => ({ name: s.name, x: s.x, y: s.y }));
    const v = currentView();
    return v ? [{ name: "View", x: v.x, y: v.y }] : [];
}

function startExport(path?: string): void {
    if (!world || !ground) return;
    exportJob = { gen: buildPackage(world, detail, ground, { sites: exportSites(), siteRadiusKm: 0.5 }), progress: { done: 0, total: 1, label: "Starting" }, path };
    statusMessage = "Exporting...";
}

function finishExport(entries: ArchiveEntry[], path?: string): ReturnType<typeof addon.IO.saveArchive> {
    const name = `${(world?.meta.name ?? "level").replace(/[^A-Za-z0-9_-]+/g, "_")}_level.zip`;
    const r = addon.IO.saveArchive(entries, name, path ? { path } : undefined);
    statusMessage = r.success ? `Exported ${entries.length} files (${(r.bytes / 1048576).toFixed(1)} MB) to ${r.path}` : `Export: ${r.error}`;
    toast(statusMessage, r.success ? "success" : "error");
    return r;
}

/** Runs the export a little each frame (models take time to evaluate). */
function pumpExport(budgetMs: number): void {
    if (!exportJob) return;
    const started = Date.now();
    while (Date.now() - started < budgetMs) {
        const n = exportJob.gen.next();
        if (n.done) { const job = exportJob; exportJob = null; finishExport(n.value, job.path); return; }
        exportJob.progress = n.value;
    }
    statusMessage = `Exporting: ${exportJob.progress.label} (${exportJob.progress.done}/${exportJob.progress.total})`;
}

// -------------------------------------------------------------------------------------------------
// UI
// -------------------------------------------------------------------------------------------------

let leftWindow = "", rightWindow = "", toolbarWindow = "";
let siteQuery = "";
let leftTab = 0;

function renderToolbar(): void {
    const id = toolbarWindow;
    W.horizontal(id, () => {
        W.label(id, { text: Icons.label("cube", "Game World Detailer"), bold: true, fontSize: 16, color: ACCENT });
        W.spacer(id, 8);
        const worlds = listWorlds();
        if (worlds.length) {
            const idx = Math.max(0, worlds.findIndex((w) => w.id === world?.meta.id));
            W.dropdown(id, { id: "gd-world", label: "World", options: worlds.map((w) => w.name), selectedIndex: idx, onChange: (v) => { const w = worlds[Number(v)]; if (w && w.id !== world?.meta.id) openWorld(w.id); } });
        }
        W.button(id, { id: "gd-undo", text: Icons.get("arrow-counter-clockwise"), tooltip: "Undo", shortcut: "Ctrl+Z", disabled: !undoStack.length, onClick: undo, frame: false });
        W.button(id, { id: "gd-redo", text: Icons.get("arrow-clockwise"), tooltip: "Redo", shortcut: "Ctrl+Y", disabled: !redoStack.length, onClick: redo, frame: false });
        W.label(id, { text: Icons.label(dirty ? "floppy-disk" : "cloud-check", dirty ? "Saving..." : "Saved with the Planner"), color: dirty ? WARN : DIM });
        W.spacer(id, 8);
        W.segmented(id, { id: "gd-light", options: STUDIO_PRESETS.map((p) => p.label), selectedIndex: lightingIndex, compact: true, accent: ACCENT, onChange: (v) => { lightingIndex = Number(v); detail.lighting = { preset: STUDIO_PRESETS[lightingIndex].id }; applyLighting(); markDirty(); } });
        W.spacer(id, 8);
        W.button(id, { id: "gd-export", text: Icons.label("export", exportJob ? "Exporting..." : "Export level"), accent: ACCENT, disabled: !!exportJob || !world, tooltip: "A zip of every model (GLB), the scene (JSON), heightmaps, materials and lore, for any engine or an AI agent", onClick: () => startExport() });
    });
    const s = stats;
    W.label(id, { text: `${s.instances.toLocaleString()} drawn in ${s.batches} draws · ${(s.triangles / 1e6).toFixed(2)} M triangles · ${s.tiles} ground tiles${s.pending ? ` · building ${s.pending} model(s)` : ""} · ${statusMessage}`, color: DIM, wrap: false });
}

function renderLeft(): void {
    const id = leftWindow;
    if (!world) {
        W.label(id, { text: "No world open", bold: true, fontSize: 15 });
        W.label(id, { text: library ? "Plan a world in the Game World Planner; it shows up here." : "This app has no data folder: it can't reach the Planner's worlds.", color: DIM, wrap: true });
        for (const w of listWorlds()) W.button(id, { id: `gd-open-${w.id}`, text: Icons.label("map-trifold", w.name), onClick: () => openWorld(w.id) });
        if (library) W.button(id, { id: "gd-sample", text: Icons.label("sparkle", "Create a sample world"), accent: ACCENT, tooltip: "The Shattered Isles with a laid-out capital and village, woods and fields, saved to the Planner's library", onClick: () => { openSampleWorld(); } });
        return;
    }
    W.segmented(id, { id: "gd-left-tab", options: ["Go to", "Nearby", "World"], selectedIndex: leftTab, onChange: (v) => { leftTab = Number(v); } });
    if (leftTab === 0) renderGoTo(id);
    else if (leftTab === 1) renderOutliner(id);
    else renderWorldPanel(id);
}

function renderGoTo(id: string): void {
    W.textInput(id, { id: "gd-site-search", label: Icons.get("magnifying-glass"), value: siteQuery, onChange: (v) => { siteQuery = v; } });
    if (detail.sites.length) {
        W.label(id, { text: "Sites", bold: true });
        for (const s of detail.sites) {
            W.horizontal(id, () => {
                W.button(id, { id: `gd-site-${s.id}`, text: Icons.label("map-pin", s.name), onClick: () => goTo(s.x, s.y, s.distanceM, s.yawDeg, s.pitchDeg) });
                W.button(id, { id: `gd-site-del-${s.id}`, text: Icons.get("trash"), frame: false, tooltip: "Forget this site", onClick: () => { beginEdit("Forget site"); detail.sites = detail.sites.filter((x) => x.id !== s.id); commitEdit(); } });
            });
        }
    }
    W.button(id, { id: "gd-site-add", text: Icons.label("plus", "Save this view as a site"), tooltip: "Sites are bookmarks; the export writes 2 m heightmaps and scatter around each", onClick: () => {
        const v = currentView();
        if (!v || !world) return;
        beginEdit("Add site");
        const near = world.spots.slice().sort((a, b) => Math.hypot(a.x - v.x, a.y - v.y) - Math.hypot(b.x - v.x, b.y - v.y))[0];
        detail.sites.push({ id: `site_${Date.now().toString(36)}`, name: near ? `Near ${near.name}` : `Site ${detail.sites.length + 1}`, ...v, ...(near ? { anchorId: near.id } : {}) });
        commitEdit();
    } });
    W.separator(id);
    W.label(id, { text: "Places in the plan", bold: true });
    const q = siteQuery.toLowerCase();
    const counts = new Map<string, number>();
    for (const s of world!.structures ?? []) if (s.spotId) counts.set(s.spotId, (counts.get(s.spotId) ?? 0) + 1);
    const spots = world!.spots.filter((s) => !q || s.name.toLowerCase().includes(q)).sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.name.localeCompare(b.name));
    for (const s of spots.slice(0, 60)) {
        const n = counts.get(s.id) ?? 0;
        W.button(id, { id: `gd-goto-${s.id}`, text: Icons.label(n ? "house" : "flag", `${s.name} · ${s.spotType}${n ? ` · ${n} buildings` : ""}`), onClick: () => goTo(s.x, s.y, n > 20 ? 260 : 140) });
    }
}

function renderOutliner(id: string): void {
    const v = currentView();
    if (!v) return;
    const near = items.map((i) => ({ i, d: Math.hypot(i.x - v.x, i.y - v.y) })).filter((e) => e.d < 0.4).sort((a, b) => a.d - b.d).slice(0, 120);
    const seen = new Set<string>();
    W.label(id, { text: `${near.length} things within 400 m`, color: DIM });
    W.treeView(id, {
        id: "gd-outliner",
        nodes: near.filter(({ i }) => { const k = i.key.split("#")[0]; if (seen.has(k)) return false; seen.add(k); return true; }).map(({ i, d }) => ({
            id: i.key, label: `${i.hidden ? "(hidden) " : ""}${i.name}`, depth: 0, selected: selected()?.sourceId === i.sourceId,
            icon: Icons.get(SOURCE_ICONS[i.source]), detail: `${Math.round(d * 1000)} m · ${i.model?.objectId.split(".").pop() ?? i.builtin?.kind ?? ""}`,
        })),
        onSelect: (key) => {
            const it = itemByKey.get(key);
            if (it?.hidden) { beginEdit("Show"); bindingOf(it.sourceId).hidden = false; commitEdit(); rebuildItems(); }
            select(key);
        },
    });
    W.separator(id);
    W.label(id, { text: "Add a prop", bold: true });
    W.label(id, { text: placeObjectId ? `Click the ground to place: ${lookupObject(placeObjectId)?.name}. Esc stops.` : "Pick an object, then click the ground.", color: DIM, wrap: true });
    W.textInput(id, { id: "gd-prop-search", label: Icons.get("magnifying-glass"), value: modelQuery, onChange: (q) => { modelQuery = q; } });
    for (const def of searchLibrary(modelQuery).slice(0, 14)) {
        W.button(id, { id: `gd-place-${def.id}`, text: Icons.label("plus", `${def.name} · ${def.category}`), selected: placeObjectId === def.id, onClick: () => { placeObjectId = placeObjectId === def.id ? null : def.id; } });
    }
}

function renderWorldPanel(id: string): void {
    const w = world!;
    W.label(id, { text: w.meta.name, bold: true, fontSize: 15 });
    W.label(id, { text: `${w.meta.genre} · ${w.meta.worldWidthKm} x ${w.meta.worldHeightKm} km · ${items.length} placed things · ${detail.props.length} props`, color: DIM, wrap: true });
    W.collapsingHeader(id, "Viewport quality", () => {
        W.slider(id, { id: "gd-q-density", label: "Scatter shown", value: detail.quality.scatterDensity, min: 0, max: 1, decimals: 2, tooltip: "Share of each scatter layer drawn here (the export always has all of it)", onChange: (v) => { detail.quality.scatterDensity = Number(v); scatterVersion++; markDirty(); } });
        W.slider(id, { id: "gd-q-lod", label: "Detail distance", value: detail.quality.lodScale, min: 0.3, max: 2.5, decimals: 2, onChange: (v) => { detail.quality.lodScale = Number(v); forceRepack = true; markDirty(); } });
        W.slider(id, { id: "gd-q-budget", label: "Triangle budget (M)", value: detail.quality.triangleBudget / 1e6, min: 0.5, max: 30, decimals: 1, onChange: (v) => { detail.quality.triangleBudget = Number(v) * 1e6; forceRepack = true; markDirty(); } });
    }, "gd-quality", false);
    W.collapsingHeader(id, "Scatter (painted marks)", () => {
        const painted = Object.keys(w.overlay?.layers ?? {}).filter((k) => !k.startsWith("codex:"));
        if (!painted.length) W.label(id, { text: "Nothing painted yet: paint forest, meadow, rock... with the Planner's Paint tool (N).", color: DIM, wrap: true });
        for (const k of painted) {
            const layer = detail.scatter[k] ?? DEFAULT_SCATTER[k];
            if (!layer) continue;
            W.horizontal(id, () => {
                W.checkbox(id, { id: `gd-sc-on-${k}`, label: k, value: layer.enabled, onChange: (v) => { beginEdit("Scatter"); const l = (detail.scatter[k] ??= JSON.parse(JSON.stringify(layer))); l.enabled = !!v; commitEdit(); scatterVersion++; } });
            });
            W.slider(id, { id: `gd-sc-n-${k}`, label: "per hectare", value: layer.perHectare, min: 0, max: 400, decimals: 0, onChange: (v) => { beginEdit("Scatter"); const l = (detail.scatter[k] ??= JSON.parse(JSON.stringify(layer))); l.perHectare = Number(v); scatterVersion++; } });
            W.label(id, { text: layer.items.map((i) => `${i.objectId.split(".").pop()} ×${i.weight}`).join(", "), color: DIM, wrap: true });
        }
    }, "gd-scatter", false);
    W.collapsingHeader(id, "Models by kind", () => {
        const keys = Object.keys(detail.models);
        if (!keys.length) W.label(id, { text: "Every kind uses its genre's default. Select a building and choose 'Every ...' to change a whole kind.", color: DIM, wrap: true });
        for (const k of keys) {
            W.horizontal(id, () => {
                W.label(id, { text: `${k}: ${lookupObject(detail.models[k].objectId)?.name ?? detail.models[k].objectId}` });
                W.button(id, { id: `gd-kind-reset-${k}`, text: Icons.get("arrow-counter-clockwise"), frame: false, tooltip: "Back to the default", onClick: () => { beginEdit("Reset kind"); delete detail.models[k]; commitEdit(); rebuildItems(); } });
            });
        }
    }, "gd-kinds", false);
}

function paramControl(id: string, it: SceneItem, def: ReturnType<typeof lookupObject> & object, p: ParamDef, values: ParamValues, fitted: Set<string>): void {
    const cid = `gd-p-${p.id}`;
    const v = values[p.id] ?? p.default;
    if (fitted.has(p.id)) { W.label(id, { text: `${p.label}: ${typeof v === "number" ? v.toFixed(1) : v}${p.unit ? ` ${p.unit}` : ""} · from the plan`, color: DIM }); return; }
    switch (p.type) {
        case "bool": W.checkbox(id, { id: cid, label: p.label, value: !!v, onChange: (x) => setParam(it, p.id, !!x) }); break;
        case "enum": {
            const options = p.optionLabels ?? p.options ?? [];
            W.dropdown(id, { id: cid, label: p.label, options, selectedIndex: Math.max(0, (p.options ?? []).indexOf(String(v))), onChange: (x) => setParam(it, p.id, (p.options ?? [])[Number(x)]) });
            break;
        }
        case "material": {
            const choices = materialChoices(p);
            W.dropdown(id, { id: cid, label: p.label, options: choices.map((c) => MATERIAL_BY_ID.get(c)?.label ?? c), selectedIndex: Math.max(0, choices.indexOf(String(v))), onChange: (x) => setParam(it, p.id, choices[Number(x)]) });
            break;
        }
        case "seed":
            W.horizontal(id, () => {
                W.label(id, { text: `${p.label} ${v}`, monospace: true });
                W.button(id, { id: `${cid}-roll`, text: Icons.get("dice-five"), tooltip: "New seed", onClick: () => setParam(it, p.id, Math.floor(Math.random() * 99999)) });
            });
            break;
        default: {
            const [lo, hi] = objectParamRange(def, p, values);
            W.slider(id, { id: cid, label: p.label, value: Number(v), min: lo, max: hi, unit: p.unit, decimals: p.decimals ?? (p.type === "int" ? 0 : 2), step: p.type === "int" ? 1 : p.step, tooltip: p.description, onChange: (x) => setParam(it, p.id, p.type === "int" ? Math.round(Number(x)) : Number(x)) });
        }
    }
}

function renderRight(): void {
    const id = rightWindow;
    const it = selected();
    if (!it || !world) {
        W.label(id, { text: "Inspector", bold: true, fontSize: 15 });
        W.label(id, { text: "Click a building, a landmark, an NPC or a prop to detail it.", color: DIM, wrap: true });
        W.spacer(id, 6);
        for (const tip of ["Right-drag orbits, middle-drag pans, the wheel zooms; WASD slides over the ground, Q/E turn.", "Moving or turning a planned thing moves it in the plan: the Planner shows it there.", "Del hides a planned thing (or deletes a prop); Ctrl+D duplicates a prop; F frames the selection.", "Export level writes a zip for any engine or an AI agent."]) W.label(id, { text: `· ${tip}`, color: DIM, wrap: true });
        return;
    }
    const kind = kindKeyOf(it);
    W.horizontal(id, () => {
        W.label(id, { text: Icons.get(SOURCE_ICONS[it.source]), fontSize: 20, color: ACCENT });
        W.vertical(id, () => {
            W.label(id, { text: it.name, bold: true, fontSize: 15 });
            const sub = it.source === "structure" ? `${structureOf(it.sourceId)?.kind} · planned building` : it.source === "spot" ? "landmark at a planned spot" : it.source === "placement" ? "placed from the codex" : "prop (Detailer only)";
            W.label(id, { text: sub, color: DIM });
        });
    });
    const a = anchorOf(it);
    if (a) W.label(id, { text: `At ${a.x.toFixed(3)}, ${a.y.toFixed(3)} km · facing ${Math.round(a.yawDeg)}°`, color: DIM, monospace: true });
    W.horizontal(id, () => {
        W.button(id, { id: "gd-frame", text: Icons.label("arrows-out-cardinal", "Frame"), shortcut: "F", onClick: () => frameSelected() });
        W.button(id, { id: "gd-hide", text: Icons.label(it.source === "prop" ? "trash" : "eye-slash", it.source === "prop" ? "Delete" : "Hide"), shortcut: "Del", onClick: removeSelected });
        if (it.source === "prop") W.button(id, { id: "gd-dup", text: Icons.label("copy", "Duplicate"), shortcut: "Ctrl+D", onClick: duplicateSelected });
    });
    if (it.builtin) {
        W.label(id, { text: `Drawn as a simple ${it.builtin.kind}. Choose a model below to use a Mesha object instead.`, color: DIM, wrap: true });
    }
    W.separator(id);
    // Which model, for this one or the whole kind.
    if (kind) W.segmented(id, { id: "gd-scope", label: "Edit", options: ["This one", kind.label], selectedIndex: editScope === "this" ? 0 : 1, compact: true, onChange: (v) => { editScope = Number(v) === 0 ? "this" : "kind"; } });
    else editScope = "this";
    const model = it.source === "prop" ? editableModel(it, "this") : it.model;
    const def = model ? lookupObject(model.objectId) : undefined;
    W.label(id, { text: def ? `${def.name} (${def.category})${it.origin === "default" ? " · genre default" : it.origin === "kind" ? " · this kind's model" : ""}` : "No model", bold: true });
    const objects = searchLibrary(modelQuery);
    W.textInput(id, { id: "gd-model-search", label: Icons.get("magnifying-glass"), value: modelQuery, onChange: (q) => { modelQuery = q; } });
    W.dropdown(id, { id: "gd-model", label: "Model", options: ["Choose a Mesha object...", ...objects.map((d) => `${d.name} · ${d.category}`)], selectedIndex: 0, onChange: (v) => { const d = objects[Number(v) - 1]; if (d) setModel(it, choice(d.id), editScope); } });
    if (!def || !model) return;
    const presets = presetsFor(def.id);
    W.horizontal(id, () => {
        W.dropdown(id, { id: "gd-preset", label: "Preset", options: ["Choose...", ...presets.map((p) => `${p.name}${p.mine ? " (yours)" : ""}`)], selectedIndex: 0, onChange: (v) => { const p = presets[Number(v) - 1]; if (p) setModel(it, { objectId: def.id, values: { ...p.values }, presetName: p.name }, editScope); } });
        W.button(id, { id: "gd-save-preset", text: Icons.get("floppy-disk"), tooltip: "Save as a Mesha preset (it appears in Mesha too)", disabled: !meshaStore, onClick: () => { const n = savePreset(it); statusMessage = n ? `Saved preset "${n}" (shared with Mesha).` : "Couldn't save the preset."; } });
    });
    W.card(id, { id: "gd-vary-card", padding: 8, radius: 10 }, () => {
        W.horizontal(id, () => {
            W.button(id, { id: "gd-vary", text: Icons.label("shuffle", "Variation"), accent: ACCENT, shortcut: "V", onClick: () => { varySelected(); } });
            W.button(id, { id: "gd-defaults", text: Icons.label("arrow-counter-clockwise", "Defaults"), onClick: () => setModel(it, choice(def.id), editScope) });
        });
        W.slider(id, { id: "gd-vary-amount", label: "Amount", value: variationAmount, min: 0, max: 1, decimals: 2, onChange: (v) => { variationAmount = Number(v); } });
    });
    const fitted = new Set(it.source === "prop" ? [] : FITTED_PARAMS[def.id] ?? []);
    const values = model.values;
    const visible = (p: ParamDef) => isParamVisible(def, p, values);
    const featured = (def.featured ?? []).map((f) => def.params.find((p) => p.id === f)).filter((p): p is ParamDef => !!p && visible(p));
    for (const p of featured) paramControl(id, it, def, p, values, fitted);
    for (const g of def.groups) {
        const params = def.params.filter((p) => p.group === g.id && visible(p) && !featured.includes(p));
        if (!params.length) continue;
        W.collapsingHeader(id, g.label, () => { for (const p of params) paramControl(id, it, def, p, values, fitted); }, `gd-group-${g.id}`, false);
    }
    W.collapsingHeader(id, "Placement", () => {
        const b = it.source === "prop" ? null : bindingOf(it.sourceId);
        const p = it.source === "prop" ? detail.props.find((x) => x.id === it.sourceId) : null;
        W.slider(id, { id: "gd-turn", label: "Facing", value: a?.yawDeg ?? 0, min: 0, max: 360, unit: "°", decimals: 0, onChange: (v) => turnSelected((Number(v) * Math.PI) / 180) });
        W.slider(id, { id: "gd-scale", label: "Scale", value: p?.scale ?? b?.scale ?? 1, min: 0.25, max: 4, decimals: 2, onChange: (v) => { beginEdit("Scale"); if (p) p.scale = Number(v); else if (b) b.scale = Number(v); rebuildItems(); } });
        W.slider(id, { id: "gd-lift", label: "Lift", value: p?.lift ?? b?.offset?.[1] ?? 0, min: -3, max: 10, unit: "m", decimals: 2, onChange: (v) => { beginEdit("Lift"); if (p) p.lift = Number(v); else if (b) b.offset = [b.offset?.[0] ?? 0, Number(v), b.offset?.[2] ?? 0]; rebuildItems(); } });
        if (b) W.textInput(id, { id: "gd-notes", label: "Notes", value: b.notes ?? "", onChange: (v) => { beginEdit("Notes"); b.notes = v; } });
    }, "gd-placement", false);
}

function frameSelected(): void {
    const it = selected();
    if (!it) return;
    const info = it.builtin ? store.wantBuiltin(it.builtin) : store.info(it.model!.objectId, it.model!.values);
    const r = info?.state === "ready" ? info.radius * it.scale : 10;
    const v = currentView();
    goTo(it.x, it.y, Math.max(6, r * 3.2), v?.yawDeg ?? 35, Math.max(15, Math.min(60, v?.pitchDeg ?? 28)));
}

function setupUI(): void {
    const [sw, sh] = Entropy.Window.getSize();
    const tabId = addon.UI.createTab({ title: "Game World Detailer", transparent: true, onRender: () => {} });
    const make = (config: Parameters<typeof Entropy.UI.createWindow>[0]) => Entropy.UI.createWindow({ ...config, ownerTabId: tabId });
    Entropy.UI.setTheme({
        background: [0.07, 0.08, 0.085, 0.72], surface: [0.13, 0.145, 0.15, 0.9], surfaceHover: [0.19, 0.21, 0.22, 1],
        border: [1, 1, 1, 0.07], text: [0.93, 0.94, 0.94, 1], accent: ACCENT, cornerRadius: 7, windowCornerRadius: 14, itemSpacing: 7, buttonPadding: [10, 5],
    });
    leftWindow = make({ title: "Level", width: 330, height: sh - 120, x: 16, y: 104, glass: true, onRender: renderLeft });
    rightWindow = make({ title: "Inspector", width: 390, height: sh - 120, x: sw - 406, y: 104, glass: true, onRender: renderRight });
    toolbarWindow = make({ title: "Detailer", width: Math.min(1400, sw - 32), height: 84, x: 16, y: 12, decorations: false, glass: true, onRender: renderToolbar });
}

// -------------------------------------------------------------------------------------------------
// Input
// -------------------------------------------------------------------------------------------------

let downAt: [number, number] | null = null;
let mouse: [number, number] = [0, 0];
let lastHoverAt = 0;

addon.Input.onMouseDown((button, x, y) => {
    mouse = [x, y];
    if (button !== 0) return;
    pointerHeld = true;
    gizmoWasActive = false;
    downAt = addon.Input.isPointerOverUI() ? null : [x, y];
});
addon.Input.onMouseMove((x, y) => { mouse = [x, y]; });
addon.Input.onMouseUp((button) => {
    if (button !== 0) return;
    pointerHeld = false;
    const start = downAt;
    downAt = null;
    if (!start || gizmoWasActive || !world) return;
    if (Math.hypot(mouse[0] - start[0], mouse[1] - start[1]) > 4) return;
    const ray = Entropy.Camera.screenToWorldRay(mouse[0], mouse[1]);
    if (placeObjectId) {
        const g = pickGround(ray.origin, ray.direction);
        if (g) addProp(placeObjectId, g[0], g[1]);
        return;
    }
    const hit = pickItem(ray.origin, ray.direction);
    select(hit?.key ?? null);
});

addon.Input.onKeyDown((key, ctrl, shift) => {
    if (Entropy.Input.isTypingInUI?.()) return;
    const k = key.toLowerCase();
    if (ctrl && k === "z") { if (shift) redo(); else undo(); return; }
    if (ctrl && k === "y") { redo(); return; }
    if (ctrl && k === "s") { if (saveWorld()) toast("Saved.", "success"); return; }
    if (ctrl && k === "d") { duplicateSelected(); return; }
    if (k === "escape") { placeObjectId = null; select(null); return; }
    if (k === "f") { frameSelected(); return; }
    if (k === "v" && selected()) { varySelected(); return; }
    if (k === "delete" || k === "backspace") { removeSelected(); return; }
    if (["w", "a", "s", "d", "q", "e"].includes(k)) held.add(k);
    if (shift) held.add("shift");
});
addon.Input.onKeyUp((key) => {
    const k = key.toLowerCase();
    held.delete(k);
    if (k === "shift" || k === "shiftleft" || k === "shiftright") held.delete("shift");
});

// -------------------------------------------------------------------------------------------------
// MCP tools
// -------------------------------------------------------------------------------------------------

type Args = Record<string, any>;

function itemSummary(i: SceneItem) {
    const info = i.builtin ? store.wantBuiltin(i.builtin) : i.model ? store.info(i.model.objectId, i.model.values) : undefined;
    return { key: i.key, name: i.name, source: i.source, sourceId: i.sourceId, model: i.model ? { objectId: i.model.objectId, values: i.model.values } : null, builtin: i.builtin ?? null, positionKm: [i.x, i.y], elevationM: i.elevation, yawDeg: Math.round((i.yaw * 180) / Math.PI), scale: i.scale, hidden: i.hidden, origin: i.origin, ready: info?.state ?? "unknown", radiusM: info?.state === "ready" ? info.radius * i.scale : null };
}

function targetItem(a: Args): SceneItem {
    let it: SceneItem | undefined;
    if (a.nearest) {
        // The nearest thing to the view's center of a source ("structure") and, for buildings, a kind ("house").
        const v = currentView();
        const want = a.nearest as { source?: string; kind?: string; objectId?: string };
        const ok = (i: SceneItem) => !i.hidden && (!want.source || i.source === want.source) && (!want.kind || structureOf(i.sourceId)?.kind === want.kind) && (!want.objectId || i.model?.objectId === want.objectId);
        it = items.filter(ok).sort((p, q) => Math.hypot(p.x - (v?.x ?? 0), p.y - (v?.y ?? 0)) - Math.hypot(q.x - (v?.x ?? 0), q.y - (v?.y ?? 0)))[0];
        if (!it) throw new Error(`Nothing like ${JSON.stringify(want)} in this world`);
        return it;
    }
    if (a.key) it = itemByKey.get(String(a.key));
    else if (a.sourceId) it = items.find((i) => i.sourceId === a.sourceId);
    else it = selected();
    if (!it) throw new Error(a.key || a.sourceId ? `Nothing with ${a.key ? `key ${a.key}` : `id ${a.sourceId}`}` : "Nothing is selected");
    return it;
}

const TOOLS: { name: string; description: string; parameters: object; run: (a: Args) => unknown }[] = [
    {
        name: "game_detailer_worlds", description: "The Planner's world library (shared with the Game World Planner). action: list | open { worldId } | sample (save a sample world with a laid-out capital and open it).",
        parameters: { type: "object", properties: { action: { type: "string" }, worldId: { type: "string" } } },
        run: (a) => {
            if (a.action === "open") { if (!openWorld(String(a.worldId))) throw new Error(statusMessage); }
            if (a.action === "sample") { if (!openSampleWorld()) throw new Error("No data folder"); }
            return { open: world ? { id: world.meta.id, name: world.meta.name } : null, worlds: listWorlds(true).map((w) => ({ id: w.id, name: w.name, structures: w.structures })) };
        },
    },
    {
        name: "game_detailer_state", description: "The open world in 3D: counts, the selection, stats (drawn instances, draws, triangles, models still building), the camera view and sites.",
        parameters: { type: "object", properties: {} },
        run: () => ({ world: world ? { id: world.meta.id, name: world.meta.name, genre: world.meta.genre } : null, dirty, items: items.length, props: detail.props.length, selected: selected() ? itemSummary(selected()!) : null, stats, view: currentView(), sites: detail.sites, lighting: STUDIO_PRESETS[lightingIndex].id, modelsBuilt: store.built }),
    },
    {
        name: "game_detailer_items", description: "Placed things (buildings, landmarks, NPCs/creatures, props) near a point (x, y km; default: the view) within radiusKm (default 0.3), optionally filtered by source.",
        parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, radiusKm: { type: "number" }, source: { type: "string" }, limit: { type: "number" } } },
        run: (a) => {
            const v = currentView();
            const x = a.x ?? v?.x ?? 0, y = a.y ?? v?.y ?? 0, r = a.radiusKm ?? 0.3;
            const list = items.filter((i) => (!a.source || i.source === a.source) && Math.hypot(i.x - x, i.y - y) <= r).sort((p, q) => Math.hypot(p.x - x, p.y - y) - Math.hypot(q.x - x, q.y - y));
            return { items: list.slice(0, a.limit ?? 60).map(itemSummary), total: list.length };
        },
    },
    {
        name: "game_detailer_view", description: "Move the camera: to a spot (spotId or spotName), an item (key/sourceId), or a point (x, y km), with distanceM, yawDeg, pitchDeg; lighting: daylight|warm|night|studio|ashen|toxic.",
        parameters: { type: "object", properties: { spotId: { type: "string" }, spotName: { type: "string" }, key: { type: "string" }, sourceId: { type: "string" }, x: { type: "number" }, y: { type: "number" }, distanceM: { type: "number" }, yawDeg: { type: "number" }, pitchDeg: { type: "number" }, lighting: { type: "string" }, offsetM: { type: "array", items: { type: "number" }, description: "[east, north] meters from where the view would look" }, nearest: { type: "object" } } },
        run: (a) => {
            if (!world) throw new Error("No world is open");
            if (a.lighting) { const i = STUDIO_PRESETS.findIndex((p) => p.id === a.lighting); if (i < 0) throw new Error(`lighting: ${STUDIO_PRESETS.map((p) => p.id).join(", ")}`); lightingIndex = i; detail.lighting = { preset: a.lighting }; applyLighting(); }
            const v = currentView();
            let x = a.x ?? v?.x ?? 0, y = a.y ?? v?.y ?? 0;
            const spot = a.spotId ? world.spots.find((s) => s.id === a.spotId) : a.spotName ? world.spots.find((s) => s.name.toLowerCase() === String(a.spotName).toLowerCase()) : undefined;
            if ((a.spotId || a.spotName) && !spot) throw new Error("No such spot");
            if (spot) { x = spot.x; y = spot.y; }
            if (a.key || a.sourceId || a.nearest) { const it = targetItem(a); x = it.x; y = it.y; }
            if (Array.isArray(a.offsetM)) { x += Number(a.offsetM[0]) / 1000; y += Number(a.offsetM[1]) / 1000; }
            goTo(x, y, a.distanceM ?? v?.distanceM ?? 160, a.yawDeg ?? v?.yawDeg ?? 35, a.pitchDeg ?? v?.pitchDeg ?? 30);
            return { view: currentView(), lighting: STUDIO_PRESETS[lightingIndex].id };
        },
    },
    {
        name: "game_detailer_select", description: "Select a placed thing by key, sourceId, or nearest { source, kind, objectId } to the view (key null clears).",
        parameters: { type: "object", properties: { key: { type: ["string", "null"] }, sourceId: { type: "string" }, nearest: { type: "object", description: "{ source?, kind?, objectId? }: the nearest such thing to the view" } } },
        run: (a) => { if (a.key === null) select(null); else { select(targetItem(a).key); syncGizmo(); } return { selected: selected() ? itemSummary(selected()!) : null }; },
    },
    {
        name: "game_detailer_set_model", description: "Choose the Mesha model (objectId, optional values / preset name) for one thing (scope 'this', default) or its whole kind (scope 'kind': every inn, every ruin, every <codex entry>), or a kind directly by kindKey ('structure:inn', 'spot:ruin', 'codex:<id>', 'category:creature').",
        parameters: { type: "object", properties: { key: { type: "string" }, sourceId: { type: "string" }, scope: { type: "string" }, kindKey: { type: "string" }, objectId: { type: "string" }, values: { type: "object" }, preset: { type: "string" } }, required: ["objectId"] },
        run: (a) => {
            const def = lookupObject(String(a.objectId));
            if (!def) throw new Error(`No Mesha object ${a.objectId} (see mesha_library)`);
            const preset = a.preset ? presetsFor(def.id).find((p) => p.name === a.preset) : undefined;
            if (a.preset && !preset) throw new Error(`No preset "${a.preset}"`);
            const next: ModelChoice = { objectId: def.id, values: resolveParams(def, { ...(preset?.values ?? {}), ...(a.values ?? {}) }), ...(preset ? { presetName: preset.name } : {}) };
            if (a.kindKey) { beginEdit("Change model"); detail.models[String(a.kindKey)] = next; commitEdit(); rebuildItems(); return { kindKey: a.kindKey, model: next }; }
            const it = targetItem(a);
            setModel(it, next, a.scope === "kind" ? "kind" : "this");
            return { item: itemSummary(itemByKey.get(it.key) ?? it) };
        },
    },
    {
        name: "game_detailer_set_params", description: "Set Mesha parameters on a thing's model (scope 'this' or 'kind'). Footprint-sized parameters (width, depth, radius) follow the plan and are ignored.",
        parameters: { type: "object", properties: { key: { type: "string" }, sourceId: { type: "string" }, scope: { type: "string" }, values: { type: "object" } }, required: ["values"] },
        run: (a) => {
            const it = targetItem(a);
            const prev = editScope;
            editScope = a.scope === "kind" ? "kind" : "this";
            try { for (const [k, v] of Object.entries(a.values ?? {})) setParam(it, k, v as any); commitEdit(); } finally { editScope = prev; }
            return { item: itemSummary(itemByKey.get(it.key) ?? it) };
        },
    },
    {
        name: "game_detailer_vary", description: "Variation: another sensible design for a thing's model (scope 'this' or 'kind'), amount 0..1.",
        parameters: { type: "object", properties: { key: { type: "string" }, sourceId: { type: "string" }, scope: { type: "string" }, amount: { type: "number" }, seed: { type: "number" } } },
        run: (a) => {
            select(targetItem(a).key);
            const prev = editScope;
            editScope = a.scope === "kind" ? "kind" : "this";
            if (typeof a.amount === "number") variationAmount = Math.max(0, Math.min(1, a.amount));
            if (typeof a.seed === "number") variationSeed = a.seed;
            try { return { changed: varySelected(), item: itemSummary(selected()!) }; } finally { editScope = prev; }
        },
    },
    {
        name: "game_detailer_move", description: "Move (dxM east, dzM south, dyM up) and/or turn (yawDeg, absolute) a thing. Planned things move in the plan (the Planner sees it); props move in the detail.",
        parameters: { type: "object", properties: { key: { type: "string" }, sourceId: { type: "string" }, dxM: { type: "number" }, dyM: { type: "number" }, dzM: { type: "number" }, yawDeg: { type: "number" } } },
        run: (a) => {
            select(targetItem(a).key);
            if (a.dxM || a.dyM || a.dzM) moveSelected(a.dxM ?? 0, a.dyM ?? 0, a.dzM ?? 0);
            if (typeof a.yawDeg === "number") turnSelected((a.yawDeg * Math.PI) / 180);
            commitEdit();
            if (groundStale) { groundStale = false; onWorldChanged(true); }
            return { item: itemSummary(selected()!) };
        },
    },
    {
        name: "game_detailer_hide", description: "Hide (hidden: true) or show a planned thing in 3D; it stays in the plan.",
        parameters: { type: "object", properties: { key: { type: "string" }, sourceId: { type: "string" }, hidden: { type: "boolean" } }, required: ["hidden"] },
        run: (a) => { const it = targetItem(a); beginEdit(a.hidden ? "Hide" : "Show"); bindingOf(it.sourceId).hidden = !!a.hidden; commitEdit(); rebuildItems(); return { hidden: !!a.hidden }; },
    },
    {
        name: "game_detailer_add_prop", description: "Add a prop (a Mesha object the plan doesn't have) at x, y km (default: the view's center), with values, yawDeg, scale, lift (m).",
        parameters: { type: "object", properties: { objectId: { type: "string" }, x: { type: "number" }, y: { type: "number" }, values: { type: "object" }, yawDeg: { type: "number" }, scale: { type: "number" }, lift: { type: "number" }, name: { type: "string" } }, required: ["objectId"] },
        run: (a) => {
            if (!lookupObject(String(a.objectId))) throw new Error(`No Mesha object ${a.objectId}`);
            const v = currentView();
            const p = addProp(String(a.objectId), a.x ?? v?.x ?? 0, a.y ?? v?.y ?? 0, a.values ?? {});
            if (typeof a.yawDeg === "number") p.yawDeg = a.yawDeg;
            if (typeof a.scale === "number") p.scale = a.scale;
            if (typeof a.lift === "number") p.lift = a.lift;
            if (a.name) p.name = String(a.name);
            rebuildItems();
            markDirty();
            return { prop: p, item: itemSummary(itemByKey.get(`prop:${p.id}`)!) };
        },
    },
    {
        name: "game_detailer_remove_prop", description: "Delete a prop by its id.",
        parameters: { type: "object", properties: { propId: { type: "string" } }, required: ["propId"] },
        run: (a) => { beginEdit("Delete prop"); const n = detail.props.length; detail.props = detail.props.filter((p) => p.id !== a.propId); commitEdit(); rebuildItems(); return { removed: n !== detail.props.length }; },
    },
    {
        name: "game_detailer_scatter", description: "Read or change a painted mark's scatter: mark (forest, meadow, rock...), enabled, perHectare, items [{ objectId, values, weight, minScale, maxScale, variants }]. Viewport density with density 0..1.",
        parameters: { type: "object", properties: { mark: { type: "string" }, enabled: { type: "boolean" }, perHectare: { type: "number" }, items: { type: "array" }, density: { type: "number" } } },
        run: (a) => {
            if (typeof a.density === "number") detail.quality.scatterDensity = Math.max(0, Math.min(1, a.density));
            if (a.mark) {
                const base = detail.scatter[a.mark] ?? DEFAULT_SCATTER[a.mark] ?? { enabled: true, perHectare: 50, items: [] };
                beginEdit("Scatter");
                const l = (detail.scatter[a.mark] = JSON.parse(JSON.stringify(base)));
                if (typeof a.enabled === "boolean") l.enabled = a.enabled;
                if (typeof a.perHectare === "number") l.perHectare = Math.max(0, a.perHectare);
                if (Array.isArray(a.items)) l.items = a.items.map((i: any) => ({ objectId: String(i.objectId), values: i.values ?? {}, weight: i.weight ?? 1, minScale: i.minScale ?? 0.8, maxScale: i.maxScale ?? 1.2, variants: i.variants ?? 3 }));
                commitEdit();
            }
            scatterVersion++;
            markDirty();
            return { scatter: detail.scatter, defaults: Object.keys(DEFAULT_SCATTER), density: detail.quality.scatterDensity };
        },
    },
    {
        name: "game_detailer_site", description: "Save the current view as a site (name), or remove one (removeId). Sites are bookmarks; the export writes 2 m heightmaps and scatter around each.",
        parameters: { type: "object", properties: { name: { type: "string" }, removeId: { type: "string" } } },
        run: (a) => {
            beginEdit("Sites");
            if (a.removeId) detail.sites = detail.sites.filter((s) => s.id !== a.removeId);
            else { const v = currentView(); if (v) detail.sites.push({ id: `site_${Date.now().toString(36)}`, name: String(a.name ?? `Site ${detail.sites.length + 1}`), ...v }); }
            commitEdit();
            return { sites: detail.sites };
        },
    },
    {
        name: "game_detailer_export", description: "Export the level package (zip): models as GLB, scene.json, heightmaps (world + 2 m per site), masks, materials, lore. With `path` (ending .zip) it writes there without a dialog and runs to completion now.",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        run: (a) => {
            if (!world || !ground) throw new Error("No world is open");
            const gen = buildPackage(world, detail, ground, { sites: exportSites(), siteRadiusKm: 0.5 });
            let n = gen.next();
            while (!n.done) n = gen.next();
            const entries = n.value;
            const r = finishExport(entries, a.path ? String(a.path) : undefined);
            return { ...r, files: entries.map((e) => e.name) };
        },
    },
    {
        name: "game_detailer_save", description: "Save now (the Detailer also saves on its own shortly after every edit), into the Planner's world file.",
        parameters: { type: "object", properties: {} },
        run: () => ({ saved: saveWorld(), savedAt: lastSavedAt }),
    },
    {
        name: "game_detailer_undo", description: "Undo (or redo with redo: true).",
        parameters: { type: "object", properties: { redo: { type: "boolean" } } },
        run: (a) => { if (a.redo) redo(); else undo(); return { message: statusMessage }; },
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

// -------------------------------------------------------------------------------------------------
// Lifecycle
// -------------------------------------------------------------------------------------------------

let lastFrame = 0;

addon.onInit(() => {
    initRendering();
    Entropy.setGameMode(false); // the gizmo renders only outside game mode
    try { library = new WorldLibrary(addon.IO.storeOf(PLANNER_STORE)); } catch (e) { library = null; statusMessage = `No data folder: ${(e as Error).message}`; }
    try { meshaStore = addon.IO.storeOf(MESHA_STORE); } catch { meshaStore = null; }
    setupUI();
    registerTools();
    let settings: any = null;
    try { settings = addon.IO.load(); } catch { settings = null; }
    const worlds = listWorlds(true);
    const id = settings?.worldId && worlds.some((w) => w.id === settings.worldId) ? settings.worldId : worlds[0]?.id;
    if (id) openWorld(id, settings?.worldId === id ? settings.view ?? undefined : undefined);
    const preset = STUDIO_PRESETS.findIndex((p) => p.id === detail.lighting.preset);
    if (preset >= 0) { lightingIndex = preset; applyLighting(); }
    Entropy.println("[game-detailer] initialized");
});

addon.onUpdate(() => {
    const now = Date.now();
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 1 / 60;
    lastFrame = now;
    clock += dt;
    if (!world) return;
    if (gizmoId && pointerHeld) { const s = Entropy.Gizmo.getState(gizmoId); if (s?.isActive) gizmoWasActive = true; }
    moveCamera(dt);
    syncFromDisk();
    const { pos, target } = cameraNow();
    const cam: V3 = [pos[0], pos[1], pos[2]];
    const f: V3 = [target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]];
    const fl = Math.hypot(...f) || 1;
    const forward: V3 = [f[0] / fl, f[1] / fl, f[2] / fl];
    // The sky follows the camera; time drives the water and the breeze.
    packRecord(skyScratch, 0, cam[0], cam[1], cam[2], 0, 1, null, 0, 0);
    Entropy.Buffer.write(skyBuffer, skyScratch);
    writeStudio();
    // A drag that moved a building: level the ground under it once it is let go.
    if (groundStale && !pointerHeld) { groundStale = false; onWorldChanged(true); }
    if (!pointerHeld) commitEdit();
    const busy = !!exportJob;
    streamGround(cam, busy ? 2 : 8);
    const scatterChanged = streamScatter(cam, busy ? 1 : 4);
    if (store.pump() > 0 || scatterChanged) forceRepack = true;
    if (viewChange.due(cam, forward, now, forceRepack)) { forceRepack = false; repack(cam, forward); }
    pumpExport(30);
    if (dirty && now >= saveDueAt && !pointerHeld) { saveWorld(); }
    // Hover highlight, a few times a second.
    if (now - lastHoverAt > 150 && !pointerHeld && !addon.Input.isPointerOverUI()) {
        lastHoverAt = now;
        const ray = Entropy.Camera.screenToWorldRay(mouse[0], mouse[1]);
        const h = pickItem(ray.origin, ray.direction)?.key ?? null;
        if (h !== hoverKey) { hoverKey = h; forceRepack = true; }
    }
});

addon.onCleanup?.(() => {
    if (dirty) saveWorld();
    batches.clear();
    clearGround();
});
