// THE ABYSS - Chapter One: First Blood.
//
// A science-fantasy FPS-RPG (docs/THE_ABYSS_STORY.md, docs/THE_ABYSS.md). The surface's drill has
// torn the planet open; Alex, an officer of the surface, goes down into the crack with the first
// expedition and meets the people who live below.
//
// This file wires the game's modules to the engine:
// - ab_world / ab_terrain: the map, its crack and the baked grids; terrain chunks by level of detail;
// - ab_shader / ab_render: the one shader and the engine-facing renderer;
// - ab_models / ab_people / ab_props: Mesha objects packed for the game, the cast, the set dressing;
// - ab_game (with ab_combat, ab_flight, ab_player, ab_cinema, ab_script): the chapter itself;
// - ab_hud / ab_audio: every screen and the AR HUD, and the sound.
// It loads (baking the world, evaluating every Mesha object once, cached on disk), feeds input
// to the game, draws what the game holds every frame, and registers the MCP tools the live test
// drives.

import { HeightGrid, LightMap, SUN_DIR, MAP_HALF, FLOOR_Y, SOURCE, SOURCE_POOL, SHRINE, depthBelowRim, type V3 } from "./ab_world";
import { MaskGrid, CHUNKS, LODS, buildChunk, chooseLods, buildOuterRing, chunkTriangles } from "./ab_terrain";
import { Renderer, DEFAULT_LOOK, placeMatrix, identity, eulerMatrix, frameMatrix, multiply, CACHE_NAMESPACE, type WorldLook, type PointLight, type Mat4 } from "./ab_render";
import { ITEM_FLOATS, PATTERN } from "./ab_shader";
import { skyDome, puff, beam, ribbon, disc, decal, tracer, meshaObject, packEvaluation, cluster, type PackedMesh } from "./ab_models";
import { LOOKS, buildLook, personLods, personLod, lookKey } from "./ab_people";
import { placeProps, solids, propKey, type Prop } from "./ab_props";
import { Game, GameWorld, NO_INPUT, START_PHASES, type GameInput, type GameEvent } from "./ab_game";
import { alive, living, type Actor } from "./ab_combat";
import { aircraftFrame } from "./ab_flight";
import { WEAPONS, ARTIFACTS, artifactValue, eye, type WeaponId } from "./ab_player";
import { SQUAD, PHASES, type Phase } from "./ab_script";
import { drawHud, drawCinema, drawLoading, drawTitle, drawDead, drawInventory, drawComplete, safeEnginePainter, type HudView, type HudMarker, type SafePainter } from "./ab_hud";
import { Sound } from "./ab_audio";
import { type DrawApi } from "../allegiance/al_ui";
import { Controller } from "../allegiance/al_controller";
import { shadowCascades } from "../allegiance/al_sky";
import { particleOpacity, particleGlow } from "../allegiance/al_fx";
import { hashString } from "../allegiance/al_rng";
import { InstanceBatches, meshCacheInstances } from "../../apps/quadplanet/qp_instances";
import { evaluateObject } from "../../apps/mesha/mesha_object";
import { lookupObject } from "../../apps/mesha/library";

const addon = Entropy.AddonAtom.register({
    name: "The Abyss",
    version: "0.1.0",
    description: "Chapter One: First Blood - the first expedition into the crack",
    author: ["Entropy Team", "Claude"],
    capabilities: { graphics: true, ui: true },
});

/** Bumped whenever the world's shape or a generated mesh changes, so caches rebuild. */
const WORLD_VERSION = 3;
const MESH_VERSION = 2;

const renderer = new Renderer();
const grid = new HeightGrid();
const masks = new MaskGrid();
let light: LightMap | null = null;
let terrainItem = "";
let skyItem = "";
const look: WorldLook = { ...DEFAULT_LOOK, sunDir: SUN_DIR };
let lights: PointLight[] = [];
const sound = new Sound();
const controller = new Controller();

type Mode = "loading" | "title" | "play" | "inventory";
let mode: Mode = "loading";
let loadStage = "Surveying the fracture";
let loadProgress = 0;
let realTime = 0;
let fixedStep: number | null = null;
let lastMs = 0;
let frames = 0;
let game: Game | null = null;
let world: GameWorld | null = null;
let props: Prop[] = [];
/** Free camera (tools, captures) overriding the game's. */
let freeCam: { pos: V3; target: V3; fov: number } | null = null;
/** Scale on every level-of-detail distance (graphics setting; tests). */
let detail = 1;
let showTriangles = false;
let lastTriangles = 0;

// --- Terrain ---------------------------------------------------------------------------------------

const chunkMeshes: string[][] = Array.from({ length: LODS }, () => new Array<string>(CHUNKS * CHUNKS).fill(""));
const shownLod = new Int8Array(CHUNKS * CHUNKS).fill(-1);
let terrainTriangles = 0;

function chunkKey(c: number, lod: number): string { return `terrain-v${WORLD_VERSION}-${c}-${lod}`; }

function chunkBounds(ci: number, cj: number): [number, number, number, number] {
    let lo = Infinity, hi = -Infinity;
    const n = 64;
    for (let j = 0; j <= n; j += 4) for (let i = 0; i <= n; i += 4) {
        const h = grid.at(ci * n + i, cj * n + j);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
    }
    const size = (MAP_HALF * 2) / CHUNKS;
    return [-MAP_HALF + (ci + 0.5) * size, (lo + hi) / 2, -MAP_HALF + (cj + 0.5) * size, Math.hypot(size / 2, size / 2, (hi - lo) / 2 + 30)];
}

function ensureChunk(c: number, lod: number): boolean {
    if (chunkMeshes[lod][c]) return true;
    const ci = c % CHUNKS, cj = Math.floor(c / CHUNKS);
    const id = `ab-terrain-${c}-${lod}`;
    const ok = renderer.spawnCached(id, chunkKey(c, lod), () => buildChunk(grid, masks, ci, cj, lod), terrainItem, "ground");
    if (!ok) return false;
    const b = chunkBounds(ci, cj);
    renderer.setBounds(id, [b[0], b[1], b[2]], b[3]);
    renderer.show(id, false);
    chunkMeshes[lod][c] = id;
    return true;
}

function updateTerrain(cam: V3, budget: number): void {
    const want = chooseLods(cam[0], cam[1], cam[2], grid.height(cam[0], cam[2]), detail);
    let built = 0;
    terrainTriangles = 0;
    for (let c = 0; c < CHUNKS * CHUNKS; c++) {
        let lod = want[c];
        if (!chunkMeshes[lod][c]) {
            if (built < budget && ensureChunk(c, lod)) built++;
            else {
                if (shownLod[c] >= 0) lod = shownLod[c];
                else { lod = -1; for (let k = LODS - 1; k >= 0; k--) if (chunkMeshes[k][c]) { lod = k; break; } }
            }
        }
        if (lod < 0) continue;
        if (shownLod[c] !== lod) {
            if (shownLod[c] >= 0) renderer.show(chunkMeshes[shownLod[c]][c], false);
            renderer.show(chunkMeshes[lod][c], true);
            shownLod[c] = lod;
        }
        terrainTriangles += chunkTriangles(lod);
    }
}

// --- Meshes: everything else, cached on disk by key ------------------------------------------------

/** Triangles per cached mesh key (for the budget readout). */
const keyTriangles = new Map<string, number>();
/** Bounding radius per key (model space). */
const keyRadius = new Map<string, number>();

function cache(key: string, make: () => PackedMesh): string {
    if (Entropy.MeshCache.status(CACHE_NAMESPACE, key) !== "ready") {
        const m = make();
        Entropy.MeshCache.put(CACHE_NAMESPACE, key, { vertexData: m.vertexData, indexData: m.indexData, meta: { radius: m.bounds[3], triangles: m.triangles } });
        keyTriangles.set(key, m.triangles);
        keyRadius.set(key, m.bounds[3]);
    } else {
        const meta = Entropy.MeshCache.meta(CACHE_NAMESPACE, key) as { radius?: number; triangles?: number } | null;
        const info = Entropy.MeshCache.info(CACHE_NAMESPACE, key);
        keyTriangles.set(key, info?.triangleCount ?? meta?.triangles ?? 0);
        keyRadius.set(key, meta?.radius ?? 2);
    }
    return key;
}

const allCached = (keys: string[]) => keys.every(k => Entropy.MeshCache.status(CACHE_NAMESPACE, k) === "ready");

/** A prop's three levels (keys), coarser copies at cells scaled to its size. */
const propMeshes = new Map<string, string[]>();
function propLodKeys(p: Prop): string[] {
    const k = propKey(p);
    let keys = propMeshes.get(k);
    if (keys) return keys;
    const base = `prop-v${MESH_VERSION}-${hashString(k).toString(36)}-${k.length}`;
    const names = [0, 1, 2].map(l => `${base}-lod${l}`);
    if (allCached(names)) names.forEach(n => cache(n, () => { throw new Error("cached"); }));
    else {
        const full = meshaObject(p.object, p.values);
        const r = Math.max(0.3, full.bounds[3]);
        const l1 = cluster(full, Math.max(0.02, r * 0.018)), l2 = cluster(full, Math.max(0.05, r * 0.05));
        [full, l1, l2].forEach((m, i) => cache(names[i], () => m));
    }
    propMeshes.set(k, names);
    return names;
}

/** A look's three levels. */
function personKeys(id: string): string[] {
    const names = [0, 1, 2].map(l => lookKey(id, l));
    if (allCached(names)) names.forEach(n => cache(n, () => { throw new Error("cached"); }));
    else {
        const lods = personLods(buildLook(LOOKS.find(l => l.id === id)!));
        lods.forEach((m, i) => cache(names[i], () => m));
    }
    return names;
}

interface AircraftMeshes { hull: string[]; rotor: string; tail: string; mast: V3; tailPivot: V3; radius: number; rotorRadius: number }
const aircraftMeshes: Partial<Record<"gunship" | "dropship", AircraftMeshes>> = {};

function buildAircraftMeshes(role: "gunship" | "dropship"): AircraftMeshes {
    const values: Record<string, string | number | boolean> = role === "gunship" ? {} : { role: "dropship", length: 19, blades: 5, rotorDiameter: 17, bayOpen: true };
    const def = lookupObject("transport.gunship")!;
    const e = evaluateObject(def, values, lookupObject);
    const hull = packEvaluation(e, r => r !== "rotor" && r !== "tailrotor");
    const rotor = packEvaluation(e, r => r === "rotor");
    const tail = packEvaluation(e, r => r === "tailrotor");
    const centroid = (m: PackedMesh): V3 => {
        let x = 0, y = 0, z = 0, n = 0;
        for (let o = 0; o < m.vertexData.length; o += 12) { x += m.vertexData[o]; y += m.vertexData[o + 1]; z += m.vertexData[o + 2]; n++; }
        return [x / n, y / n, z / n];
    };
    const mast = centroid(rotor), tailPivot = centroid(tail);
    const base = `aircraft-v${MESH_VERSION}-${role}`;
    const hullKeys = [hull, cluster(hull, 0.12), cluster(hull, 0.4)].map((m, i) => cache(`${base}-hull-lod${i}`, () => m));
    return {
        hull: hullKeys, rotor: cache(`${base}-rotor`, () => rotor), tail: cache(`${base}-tail`, () => tail), mast, tailPivot,
        radius: hull.bounds[3], rotorRadius: Number(e.params.rotorDiameter) / 2,
    };
}

const FX = {
    fire: "", smoke: "", spark: "", magic: "", tracer: "", beam: "", scorch: "", rotor: "", waterfall: "", sky: "",
};

const pickupMeshes = new Map<string, string>();
function pickupKey(item: string): string {
    let k = pickupMeshes.get(item);
    if (k) return k;
    const make = (): PackedMesh => {
        if (item === "lumen-shard") return meshaObject("nature.crystal_cluster", { count: 3, height: 0.32, base: false, spread: 25 });
        if (item === "river-idol") return meshaObject("household.bottle", { height: 0.32, bodyRadius: 0.06, shoulder: "round", label: false, closure: "cork", glass: "glass.violet" });
        if (item === "bronze-cup") return meshaObject("household.mug", {});
        if (item === "prayer-tablet") return meshaObject("household.book", {});
        if (item === "warden-mask") return meshaObject("household.dish", {});
        if (item === "warden-glaive") return meshaObject("equipment.melee_weapon", { kind: "glaive" });
        if (item === "medgel") return meshaObject("household.bottle", { height: 0.22, bodyRadius: 0.035, label: true, closure: "cap", glass: "glass.green" });
        if (item === "vial") return meshaObject("household.bottle", { height: 0.24, bodyRadius: 0.04, shoulder: "round", label: false, closure: "cork", glass: "glass.clear" });
        return meshaObject("nature.crystal_cluster", { count: 1, height: 0.3, base: false });
    };
    k = cache(`pickup-v${MESH_VERSION}-${item}`, make);
    pickupMeshes.set(item, k);
    return k;
}

/** View models: the weapon in Alex's hands (drawn with one uniform each, at the camera). */
const viewItems: Partial<Record<WeaponId, { mesh: string; item: string }>> = {};

// --- Instanced drawing --------------------------------------------------------------------------------

let solidBatches: InstanceBatches;
let peopleBatches: InstanceBatches;
let fxBatches: InstanceBatches;
const lightBinding = () => [{ group: 2, binding: 2, resource: { type: "Texture" as const, value: { id: renderer.lightTexture } } }];
let frameTriangles = 0;

function addInstance(batches: InstanceBatches, key: string, m: Mat4, tint: readonly number[] = [1, 1, 1, 0], anim: readonly number[] = [0, 0, 0, 0], extra: readonly number[] = [1, 0, 0, 0], sphere?: readonly number[]): void {
    const { data, offset } = batches.add(key, sphere);
    for (let i = 0; i < 16; i++) data[offset + i] = m[i];
    for (let i = 0; i < 4; i++) { data[offset + 16 + i] = tint[i] ?? 0; data[offset + 20 + i] = anim[i] ?? 0; data[offset + 24 + i] = extra[i] ?? 0; }
    frameTriangles += keyTriangles.get(key) ?? 0;
}

// --- Loading -------------------------------------------------------------------------------------------

interface LoadStep { label: string; weight: number; run: () => boolean }
let loadSteps: LoadStep[] = [];
let loadIndex = 0;
let coarseBuilt = 0;
let propQueue: Prop[] = [];
let lookQueue: string[] = [];
let pickupQueue: string[] = [];

function makeLoadSteps(): LoadStep[] {
    return [
        { label: "Surveying the fracture", weight: 3, run: () => grid.bake(fixedStep ? Infinity : 120) },
        { label: "Mapping the riverbed", weight: 1, run: () => masks.bake(fixedStep ? Infinity : 160) },
        {
            label: "Measuring the light", weight: 2, run: () => {
                if (!light) light = new LightMap(grid, SUN_DIR);
                const done = light.bake(fixedStep ? Infinity : 64);
                if (done) renderer.setLightMap(light.data);
                return done;
            },
        },
        {
            label: "Raising the walls", weight: 2, run: () => {
                const end = Math.min(CHUNKS * CHUNKS, coarseBuilt + (fixedStep ? CHUNKS * CHUNKS : 32));
                for (; coarseBuilt < end; coarseBuilt++) ensureChunk(coarseBuilt, LODS - 1);
                if (coarseBuilt < CHUNKS * CHUNKS) return false;
                if (!renderer.has("ab-outer")) {
                    const outer = () => buildOuterRing();
                    renderer.spawnCached("ab-outer", `outer-v${WORLD_VERSION}`, outer, terrainItem, "ground", [0, 0, 0, 20000]);
                }
                return true;
            },
        },
        {
            label: "Placing the expedition", weight: 1, run: () => {
                props = placeProps(1);
                propQueue = [...props];
                world = new GameWorld(grid);
                world.solids = solids(props);
                return true;
            },
        },
        {
            label: "Building the settlement", weight: 3, run: () => {
                const t0 = Date.now();
                while (propQueue.length && (fixedStep || Date.now() - t0 < 40)) propLodKeys(propQueue.shift()!);
                return propQueue.length === 0;
            },
        },
        {
            label: "Readying the rotorcraft", weight: 1, run: () => {
                aircraftMeshes.gunship = buildAircraftMeshes("gunship");
                aircraftMeshes.dropship = buildAircraftMeshes("dropship");
                return true;
            },
        },
        {
            label: "Calling the expedition", weight: 6, run: () => {
                const id = lookQueue.shift();
                if (id) personKeys(id);
                return lookQueue.length === 0;
            },
        },
        {
            label: "Last checks", weight: 1, run: () => {
                FX.fire = cache(`fx-v${MESH_VERSION}-fire`, () => puff(PATTERN.fire, [1, 1, 1]));
                FX.smoke = cache(`fx-v${MESH_VERSION}-smoke`, () => puff(PATTERN.smoke, [1, 1, 1]));
                FX.spark = FX.fire;
                FX.magic = cache(`fx-v${MESH_VERSION}-magic`, () => puff(PATTERN.magic, [1, 1, 1]));
                FX.tracer = cache(`fx-v${MESH_VERSION}-tracer`, () => tracer());
                FX.beam = cache(`fx-v${MESH_VERSION}-beam`, () => beam(14));
                FX.scorch = cache(`fx-v${MESH_VERSION}-scorch`, () => decal());
                FX.rotor = cache(`fx-v${MESH_VERSION}-rotor`, () => disc(PATTERN.rotor, 28));
                FX.waterfall = cache(`fx-v${MESH_VERSION}-waterfall`, () => ribbon(18, 30, 0.1));
                while (pickupQueue.length) pickupKey(pickupQueue.shift()!);
                // The weapons in hand.
                for (const id of Object.keys(WEAPONS) as WeaponId[]) {
                    const spec = WEAPONS[id];
                    const mesh = meshaObject(spec.object, spec.values);
                    const item = renderer.createItem();
                    renderer.spawn(`ab-view-${id}`, mesh, item, "solid");
                    renderer.show(`ab-view-${id}`, false);
                    viewItems[id] = { mesh: `ab-view-${id}`, item };
                }
                game = new Game(world!);
                loadSettings();
                mode = "title";
                Entropy.println(`[abyss] loaded in ${(realTime).toFixed(1)} s`);
                return true;
            },
        },
    ];
}

function loadStep(): void {
    if (loadIndex >= loadSteps.length) return;
    const step = loadSteps[loadIndex];
    loadStage = step.label;
    if (step.run()) loadIndex++;
    const total = loadSteps.reduce((s, x) => s + x.weight, 0);
    const done = loadSteps.slice(0, loadIndex).reduce((s, x) => s + x.weight, 0);
    let partial = 0;
    if (loadIndex < loadSteps.length) {
        const cur = loadSteps[loadIndex];
        const p = cur.label === "Surveying the fracture" ? grid.progress : cur.label === "Mapping the riverbed" ? masks.progress : cur.label === "Measuring the light" ? (light?.progress ?? 0)
            : cur.label === "Raising the walls" ? coarseBuilt / (CHUNKS * CHUNKS) : cur.label === "Building the settlement" ? 1 - propQueue.length / Math.max(1, props.length)
            : cur.label === "Calling the expedition" ? 1 - lookQueue.length / LOOKS.length : 0;
        partial = p * cur.weight;
    }
    loadProgress = (done + partial) / total;
}

// --- Input ---------------------------------------------------------------------------------------------

const held = new Set<string>();
const pressed = new Set<string>();
let mouseDX = 0, mouseDY = 0;
let lookDrag: [number, number] | null = null;
let fireHeld = false, adsHeld = false;
let skipHeld = 0;
let menuChapters = false;
let invSelected = 0;
let scripted: Partial<GameInput> & { frames?: number } | null = null;

const key = (k: string) => held.has(k) || held.has(k.toLowerCase()) || held.has(k.toUpperCase());

function readInput(): GameInput {
    const L = controller.left, R = controller.right;
    const inp: GameInput = {
        moveX: (key("d") ? 1 : 0) - (key("a") ? 1 : 0) + L[0],
        moveY: (key("w") ? 1 : 0) - (key("s") ? 1 : 0) + L[1],
        sprint: key("Shift") || controller.held.has("LeftThumb"),
        jump: pressed.has(" ") || controller.held.has("South"),
        mouseX: mouseDX, mouseY: mouseDY,
        lookX: (key("ArrowRight") ? 1 : 0) - (key("ArrowLeft") ? 1 : 0) + R[0],
        lookY: (key("ArrowUp") ? 1 : 0) - (key("ArrowDown") ? 1 : 0) + R[1],
        fire: fireHeld || controller.held.has("RightTrigger2") || controller.held.has("RightTrigger"),
        ads: adsHeld || key("z") || controller.held.has("LeftTrigger2") || controller.held.has("LeftTrigger"),
        reload: pressed.has("r") || pressed.has("R") || controller.held.has("East"),
        interact: pressed.has("e") || pressed.has("E") || controller.held.has("West"),
        heal: pressed.has("h") || pressed.has("H"),
        scan: pressed.has("q") || pressed.has("Q"),
        weapon: pressed.has("1") ? 1 : pressed.has("2") ? 2 : pressed.has("3") || pressed.has("f") || pressed.has("F") ? 3 : pressed.has("4") ? 4 : null,
        skip: skipHeld >= 1,
    };
    if (scripted) {
        Object.assign(inp, scripted);
        if (scripted.frames !== undefined && --scripted.frames <= 0) scripted = null;
    }
    // In a cutscene, fire/space/enter held skip it (with a short hold).
    mouseDX = 0; mouseDY = 0;
    return inp;
}

function setupInput(): void {
    Entropy.Input.onKeyDown((k: string) => {
        held.add(k); pressed.add(k);
        if (k === "Tab" || k === "Escape") {
            if (mode === "play" && game && !game.cinema && game.phase !== "complete") { mode = "inventory"; sound.ui(); }
            else if (mode === "inventory") { mode = "play"; sound.ui(); }
            else if (mode === "title" && menuChapters) menuChapters = false;
        }
        if (k === "F3") showTriangles = !showTriangles;
        if (mode === "inventory" && (k === "ArrowDown" || k === "ArrowUp")) invSelected = Math.max(0, invSelected + (k === "ArrowDown" ? 1 : -1));
        if (mode === "title" && (k === "Enter" || k === " ") && !menuChapters) act("begin");
    });
    Entropy.Input.onKeyUp((k: string) => { held.delete(k); held.delete(k.toLowerCase()); held.delete(k.toUpperCase()); });
    Entropy.Input.onMouseDown((button: number, x: number, y: number) => {
        if (button === 1) { lookDrag = [x, y]; return; }
        if (button === 2) { adsHeld = true; return; }
        const hit = painter?.hit(x, y);
        if (hit) { act(hit.id); return; }
        if (button === 0) fireHeld = true;
    });
    Entropy.Input.onMouseMove((x: number, y: number) => {
        if (painter) painter.hover = painter.hit(x, y)?.id ?? null;
        if (lookDrag) { mouseDX += x - lookDrag[0]; mouseDY += y - lookDrag[1]; lookDrag = [x, y]; }
    });
    Entropy.Input.onMouseUp((button: number) => {
        if (button === 1) lookDrag = null;
        else if (button === 2) adsHeld = false;
        else fireHeld = false;
    });
    Entropy.Input.onGamepadAxis((l, r) => controller.axis(l, r, realTime));
    Entropy.Input.onGamepadButton((b, down) => {
        const fresh = controller.button(b, down);
        if (fresh && b === "Start") { if (mode === "play") mode = "inventory"; else if (mode === "inventory") mode = "play"; else if (mode === "title") act("begin"); }
    });
}

function act(id: string): void {
    sound.ui();
    if (!game) return;
    const g = game;
    switch (id) {
        case "begin": newGame("intro"); break;
        case "continue": if (savedCheckpoint) newGame(savedCheckpoint); break;
        case "chapters": menuChapters = true; break;
        case "back": menuChapters = false; break;
        case "assist-down": g.aimAssist = Math.max(0, Math.round((g.aimAssist - 0.1) * 10) / 10); saveSettings(); break;
        case "assist-up": g.aimAssist = Math.min(1, Math.round((g.aimAssist + 0.1) * 10) / 10); saveSettings(); break;
        case "look-down": g.sensitivity = Math.max(0.3, Math.round((g.sensitivity - 0.1) * 10) / 10); saveSettings(); break;
        case "look-up": g.sensitivity = Math.min(2.5, Math.round((g.sensitivity + 0.1) * 10) / 10); saveSettings(); break;
        case "resume": mode = "play"; break;
        case "to-title": mode = "title"; menuChapters = false; resetGame(); break;
        case "replay": newGame("intro"); break;
        default:
            if (id.startsWith("moment-")) newGame(id.slice(7) as Phase);
            if (id.startsWith("artifact-")) invSelected = Number(id.slice(9));
    }
}

// --- Saving (the checkpoint phase and the settings) ------------------------------------------------------

let savedCheckpoint: Phase | null = null;
const SAVE_PATH = "progress.json";

function loadSettings(): void {
    try {
        const text = addon.IO.store.read(SAVE_PATH);
        const d = (text ? JSON.parse(text) : null) as { checkpoint?: Phase; aimAssist?: number; sensitivity?: number } | null;
        if (d?.checkpoint && PHASES.includes(d.checkpoint)) savedCheckpoint = d.checkpoint;
        if (game && typeof d?.aimAssist === "number") game.aimAssist = d.aimAssist;
        if (game && typeof d?.sensitivity === "number") game.sensitivity = d.sensitivity;
    } catch { /* no save yet */ }
}
function saveSettings(): void {
    try { addon.IO.store.write(SAVE_PATH, JSON.stringify({ checkpoint: savedCheckpoint, aimAssist: game?.aimAssist ?? 0.5, sensitivity: game?.sensitivity ?? 1 })); } catch { /* no data folder */ }
}

function resetGame(): void {
    if (!world) return;
    const keep = game ? { a: game.aimAssist, s: game.sensitivity } : null;
    // Wrecks are solids added during play; start from the props' own.
    world.solids = solids(props);
    game = new Game(world);
    if (keep) { game.aimAssist = keep.a; game.sensitivity = keep.s; }
}

function newGame(phase: Phase): void {
    resetGame();
    game!.start(phase);
    mode = "play";
    hud.bootStart = phase === "intro" ? -1 : game!.time;
    hud.toasts = [];
}

// --- HUD state ------------------------------------------------------------------------------------------

let painter: SafePainter | null = null;
const hud = { toasts: [] as { text: string; age: number }[], hit: 0, kill: false, objectiveText: "", objectiveAge: 0, bootStart: -1, timer: 0, lastPhase: "" as string };

// --- The frame ----------------------------------------------------------------------------------------------

function cameraNow(): { pos: V3; target: V3; fov: number } {
    if (freeCam) return freeCam;
    if (mode === "loading" || mode === "title" || !game) {
        // A slow orbit high over the crack.
        const a = realTime * 0.025 + 2.4;
        return { pos: [Math.cos(a) * 1700, 520, Math.sin(a) * 1500 - 100], target: [0, -350, 0], fov: 48 };
    }
    return { pos: game.camera.pos, target: game.camera.target, fov: game.camera.fov };
}

function frame(dt: number): void {
    realTime += dt;
    frames++;
    controller.expire(realTime);
    sound.setTime(realTime);
    if (mode === "loading") {
        const t0 = Date.now();
        do loadStep(); while (mode === "loading" && (fixedStep !== null ? loadIndex < loadSteps.length : Date.now() - t0 < 25));
    }
    const input = mode === "play" ? readInput() : (readInput(), NO_INPUT);
    if (game && mode === "play") {
        // Skipping a cutscene takes holding fire, space or enter for half a second.
        if (game.cinema) skipHeld = key(" ") || key("Enter") || fireHeld || controller.held.has("South") ? skipHeld + dt * 2 : 0;
        else skipHeld = 0;
        game.step(dt, { ...input, skip: input.skip || (scripted?.skip ?? false) });
        handleEvents(game.events);
        if (game.phase === "complete") mode = "play";
        if (game.checkpoint && savedCheckpoint !== game.checkpoint.phase) { savedCheckpoint = game.checkpoint.phase; saveSettings(); }
    } else if (game && mode === "title") {
        game.step(dt, NO_INPUT);
    }
    pressed.clear();
    draw(dt);
}

function handleEvents(events: GameEvent[]): void {
    const g = game!;
    const ear = g.camera.pos;
    for (const e of events) {
        switch (e.kind) {
            case "shot": sound.rifle(e.player, e.from, ear); break;
            case "cast": sound.cast(e.at, ear); break;
            case "burst": sound.burst(e.at, ear, e.size); break;
            case "explosion": sound.explosion(e.at, ear, e.power); look.flash = Math.max(look.flash, 0.25 * Math.max(0, 1 - Math.hypot(e.at[0] - ear[0], e.at[2] - ear[2]) / 600)); break;
            case "hitmarker": hud.hit = 0.25; hud.kill = e.kill; sound.hit(e.kill); break;
            case "hurt": sound.hurt(); break;
            case "pickup": hud.toasts.push({ text: e.text, age: 0 }); sound.pickup(); break;
            case "toast": hud.toasts.push({ text: e.text, age: 0 }); break;
            case "music": sound.cue(e.cue); break;
            case "melee": sound.melee(); break;
            case "reload": sound.reload(); break;
            case "scan": sound.scan(); break;
            case "surge": sound.surge(); look.flash = 1; look.flashHue = 1; break;
            case "phase": if (e.phase === "ledge") hud.bootStart = g.time; break;
            case "shout": hud.toasts.push({ text: `"${e.text}"  -  ${e.translation}`, age: 0 }); break;
            case "death": break;
        }
    }
}

function draw(dt: number): void {
    const cam = cameraNow();
    const [w, h] = Entropy.Window.getSize();
    Entropy.Camera.setTransform(cam.pos, cam.target, [0, 1, 0]);
    Entropy.Camera.setFov(cam.fov);
    renderer.writeItem(skyItem, placeMatrix(cam.pos[0], cam.pos[1], cam.pos[2], 0, 40000), [1, 1, 1, 0], [0, 0, 0, 0], [1, 2, 0, 0]);
    if (mode !== "loading" || loadIndex > 3) updateTerrain(cam.pos, fixedStep ? Infinity : mode === "loading" ? 2 : 5);
    frameTriangles = 0;
    lights = [];
    if (solidBatches && mode !== "loading") {
        solidBatches.begin(); peopleBatches.begin(); fxBatches.begin();
        drawProps(cam.pos, cam.target);
        if (game) {
            drawPeople(cam.pos);
            drawAircraft(cam.pos);
            drawFx(cam.pos);
            drawPickups(cam.pos);
        }
        drawSource();
        solidBatches.flush(); peopleBatches.flush(); fxBatches.flush();
    }
    drawViewModel(cam);
    updateLook(dt, cam);
    updateShadows(cam);
    renderer.writeWorld(look, game?.time ?? realTime, [w, h], pickLights(cam.pos));
    lastTriangles = frameTriangles + terrainTriangles + renderer.trianglesOf("ab-outer");
    hud.timer += dt;
    const interval = mode === "loading" ? 0.1 : game?.cinema ? 1 / 30 : 1 / 30;
    if (hud.timer >= interval || fixedStep) { drawUi(hud.timer, w, h, cam); hud.timer = 0; }
    if (game) sound.step(dt, realTime, cam.pos, nearestRotor(cam.pos), depthBelowRim(cam.pos[1]));
}

// --- Drawing the world -------------------------------------------------------------------------------------

function drawProps(cam: V3, target: V3): void {
    const fwd = norm3([target[0] - cam[0], target[1] - cam[1], target[2] - cam[2]]);
    const reach = { near: 160, mid: 1000, far: 1e9 };
    for (const p of props) {
        const keys = propMeshes.get(propKey(p));
        if (!keys) continue;
        const y = grid.height(p.x, p.z) + (p.lift ?? 0);
        const dx = p.x - cam[0], dy = y - cam[1], dz = p.z - cam[2];
        const d = Math.hypot(dx, dy, dz);
        if (d > reach[p.reach] * detail) continue;
        const r = (keyRadius.get(keys[0]) ?? 2) * p.scale;
        // Behind the camera (beyond its own size): not drawn.
        if (d > r * 2 + 8 && (dx * fwd[0] + dy * fwd[1] + dz * fwd[2]) < -r) continue;
        const rel = d / Math.max(0.5, r) / detail;
        const lod = rel < 22 ? 0 : rel < 70 ? 1 : 2;
        addInstance(solidBatches, keys[lod], placeMatrix(p.x, y, p.z, p.yaw, p.scale), [1, 1, 1, 0], [0, 0, 0, 0], [1, 0, 0, 0], [p.x, y + r * 0.5, p.z, r * 1.2]);
    }
}

function norm3(v: V3): V3 { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

/** People drawn this frame by level (for the budget: few at full detail). */
function drawPeople(cam: V3): void {
    const g = game!;
    const list: { a: Actor | null; x: number; y: number; z: number; yaw: number; look: string; d: number }[] = [];
    for (const a of g.combat.actors) list.push({ a, x: a.x, y: a.y, z: a.z, yaw: a.yaw, look: a.look, d: Math.hypot(a.x - cam[0], a.y - cam[1], a.z - cam[2]) });
    // Alex himself, seen from outside in cutscenes.
    if (g.cinema || g.phase === "complete") list.push({ a: null, x: g.body.x, y: g.body.y, z: g.body.z, yaw: g.body.yaw, look: "trooper-m", d: Math.hypot(g.body.x - cam[0], g.body.y - cam[1], g.body.z - cam[2]) });
    list.sort((p, q) => p.d - q.d);
    let full = 0, mid = 0;
    for (const it of list) {
        if (it.d > 900 * detail) continue;
        let lod = personLod(it.d, detail);
        if (lod === 0 && full >= 4) lod = 1;
        if (lod === 1 && mid >= 14) lod = 2;
        if (lod === 0) full++; else if (lod === 1) mid++;
        const a = it.a;
        let m: Mat4;
        let anim: number[] = [0, 0, 0, 1], extra: number[] = [1, 0, 0, 0];
        if (a && !alive(a)) {
            // Falling back onto the ground.
            const k = Math.min(1, a.deadT / 0.7);
            m = eulerMatrix([a.x, a.y + 0.05 * k, a.z], a.yaw, k * k * 1.48, 0, a.scale);
            anim = [a.phase, 0, 0, 1];
        } else {
            m = placeMatrix(it.x, it.y, it.z, it.yaw, a?.scale ?? 1);
            if (a) { anim = [a.phase, a.swing, a.pose, 1]; extra = [1, 0, a.hurtT > 0 ? 2 : 0, a.meleeAngle]; }
            else anim = [0, 0, 0, 1];
        }
        const tint = a && a.hurtT > 0 ? [1, 0.4, 0.3, 0] : [1, 1, 1, 0];
        addInstance(peopleBatches, lookKey(it.look, lod), m, tint, anim, extra, [it.x, it.y + 1, it.z, 1.4]);
    }
}

function drawAircraft(cam: V3): void {
    const g = game!;
    for (const a of g.aircraft) {
        const meshes = aircraftMeshes[a.role];
        if (!meshes) continue;
        const d = Math.hypot(a.pos[0] - cam[0], a.pos[1] - cam[1], a.pos[2] - cam[2]);
        if (d > 6000) continue;
        const m = eulerMatrix(a.pos, a.yaw, a.pitch, a.roll);
        const rel = d / meshes.radius / detail;
        const lod = rel < 25 ? 0 : rel < 90 ? 1 : 2;
        const wreck = a.mode === "wreck";
        const tint = wreck ? [0.22, 0.2, 0.19, 0] : [1, 1, 1, 0];
        const sphere = [a.pos[0], a.pos[1], a.pos[2], meshes.radius * 1.5];
        addInstance(solidBatches, meshes.hull[lod], m, tint, [0, 0, 0, 0], [1, 0, 0, 0], sphere);
        if (!wreck) {
            // Main rotor: spun about the mast; a faint disc of blur once it is up to speed.
            const [mx, my, mz] = meshes.mast;
            const spin = multiply(multiply(placeMatrix(mx, my, mz, a.rotor), placeMatrix(0, 0, 0)), placeMatrix(-mx, -my, -mz));
            addInstance(solidBatches, meshes.rotor, multiply(m, spin), [1, 1, 1, 0], [0, 0, 0, 0], [1, 0, 0, 0], sphere);
            const [tx, ty, tz] = meshes.tailPivot;
            const c = Math.cos(a.rotor * 2.3), s = Math.sin(a.rotor * 2.3);
            const rx: Mat4 = [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
            const tailSpin = multiply(multiply(placeMatrix(tx, ty, tz), rx), placeMatrix(-tx, -ty, -tz));
            addInstance(solidBatches, meshes.tail, multiply(m, tailSpin), [1, 1, 1, 0], [0, 0, 0, 0], [1, 0, 0, 0], sphere);
            if (a.rotorSpeed > 12 && d < 1500) {
                const r = meshes.rotorRadius;
                addInstance(fxBatches, FX.rotor, multiply(m, placeMatrix(mx, my + 0.08, mz, 0, r)), [1, 1, 1, 0], [0, 0, 0, 0], [1, 0, 0, 0], sphere);
            }
        }
        // The searchlight: a beam from the nose to where it points, and its spot on the ground.
        if (a.searchlight && a.lightTarget && !wreck) {
            const f = aircraftFrame(a);
            const L = meshes.radius;
            const lamp: V3 = [a.pos[0] + f.forward[0] * L * 0.75 - f.up[0] * 0.3, a.pos[1] + f.forward[1] * L * 0.75 + 0.6, a.pos[2] + f.forward[2] * L * 0.75];
            const t = a.lightTarget;
            const dir: V3 = [t[0] - lamp[0], t[1] - lamp[1], t[2] - lamp[2]];
            const len = Math.min(700, Math.hypot(...dir));
            const fwd = norm3(dir);
            let right = norm3(cross3(fwd, [0, 1, 0]));
            if (!Number.isFinite(right[0])) right = [1, 0, 0];
            const up = cross3(right, fwd);
            const rad = len * 0.07;
            addInstance(fxBatches, FX.beam, frameMatrix(lamp, right, up, fwd, rad, rad, len), [1, 0.95, 0.85, 0.9], [0, 0, 0, 0], [1, 0, 0, 0]);
            lights.push({ pos: [lamp[0] + fwd[0] * len * 0.98, lamp[1] + fwd[1] * len * 0.98 + 3, lamp[2] + fwd[2] * len * 0.98], radius: 60, color: [1, 0.95, 0.85], intensity: 2.2 });
        }
    }
}

function cross3(a: V3, b: V3): V3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

function drawFx(cam: V3): void {
    const g = game!;
    // Fire, smoke and sparks (Allegiance's particles).
    for (const p of g.fx.particles) {
        const op = particleOpacity(p);
        if (op <= 0.01) continue;
        const d = Math.hypot(p.x - cam[0], p.y - cam[1], p.z - cam[2]);
        if (d > 1800) continue;
        const s = p.size;
        if (p.kind === "smoke") {
            addInstance(fxBatches, FX.smoke, placeMatrix(p.x, p.y, p.z, p.spin, s), [p.tint[0], p.tint[1], p.tint[2], 0], [0, 0, 0, 0], [op, 0, 0, 0]);
        } else {
            const gl = particleGlow(p);
            const m = p.flame ? multiply(placeMatrix(p.x, p.y - s * 0.3, p.z, p.spin), [s, 0, 0, 0, 0, s * 2.4, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]) : placeMatrix(p.x, p.y, p.z, p.spin, s);
            addInstance(fxBatches, FX.fire, m, [gl.tint[0], gl.tint[1], gl.tint[2], gl.heat], [0, 0, 0, 0], [op, 0, 0, p.spin]);
        }
    }
    for (const f of g.fx.fires) lights.push({ pos: [f.x, f.y + 1.5, f.z], radius: 18 + f.radius * 8, color: [1, 0.55, 0.22], intensity: 2.4 });
    for (const s of g.fx.scorches) addInstance(fxBatches, FX.scorch, placeMatrix(s.x, grid.height(s.x, s.z), s.z, s.yaw, s.radius), [1, 1, 1, 0], [0, 0, 0, 0], [1, 0, 0, 0]);
    // The river's light: bolts in flight, their bursts.
    for (const b of g.combat.bolts) {
        addInstance(fxBatches, FX.magic, placeMatrix(b.pos[0], b.pos[1], b.pos[2], b.age * 7, b.size), [b.color[0], b.color[1], b.color[2], 1.2], [0, 0, 0, 0], [1, 2, 0, 0]);
        const sp = Math.hypot(...b.vel) || 1;
        for (let k = 1; k <= 3; k++) {
            const back = k * b.size * 1.6;
            addInstance(fxBatches, FX.magic, placeMatrix(b.pos[0] - b.vel[0] / sp * back, b.pos[1] - b.vel[1] / sp * back, b.pos[2] - b.vel[2] / sp * back, k, b.size * (1 - k * 0.22)), [b.color[0], b.color[1], b.color[2], 0.6], [0, 0, 0, 0], [0.8 - k * 0.2, 2, 0, 0]);
        }
        lights.push({ pos: b.pos, radius: 16 + b.size * 20, color: b.color, intensity: 3 });
    }
    for (const b of g.combat.bursts) {
        const t = b.age / 0.9;
        addInstance(fxBatches, FX.magic, placeMatrix(b.pos[0], b.pos[1], b.pos[2], t * 3, b.size * (0.4 + t)), [b.color[0], b.color[1], b.color[2], 2 * (1 - t)], [0, 0, 0, 0], [Math.max(0, 1 - t * 1.1), 2, 0, 0]);
        lights.push({ pos: b.pos, radius: 12 + b.size * 6, color: b.color, intensity: 4 * (1 - t) });
    }
    // Tracers and muzzle flashes.
    for (const s of g.combat.shots) {
        const dir: V3 = [s.to[0] - s.from[0], s.to[1] - s.from[1], s.to[2] - s.from[2]];
        const len = Math.hypot(...dir);
        if (len < 0.5) continue;
        const fwd = norm3(dir);
        let right = norm3(cross3(fwd, [0, 1, 0]));
        if (!Number.isFinite(right[0])) right = [1, 0, 0];
        const up = cross3(right, fwd);
        // A short streak flying along the shot.
        const t = Math.min(1, s.age / 0.12);
        const seg = Math.min(len, 14);
        const start: V3 = [s.from[0] + fwd[0] * (len - seg) * t, s.from[1] + fwd[1] * (len - seg) * t, s.from[2] + fwd[2] * (len - seg) * t];
        addInstance(fxBatches, FX.tracer, frameMatrix(start, right, up, fwd, 0.05, 0.05, seg), [0.55, 0.92, 1, 1], [0, 0, 0, 0], [1, 2, 0, 0]);
        if (s.age < 0.05) {
            addInstance(fxBatches, FX.fire, placeMatrix(s.from[0], s.from[1], s.from[2], s.age * 30, 0.18), [0.6, 0.9, 1, 2.5], [0, 0, 0, 0], [1, 2, 0, 0]);
            lights.push({ pos: s.from, radius: 9, color: [0.6, 0.9, 1], intensity: 3 });
        }
    }
    // The surge: a sphere of the river's light swelling out from Alex.
    const surgeT = typeof g.flags.surgeT === "number" ? g.time - g.flags.surgeT : 99;
    if (surgeT < 1.6) {
        const k = surgeT / 1.6;
        const at: V3 = [g.body.x, g.body.y + 1, g.body.z];
        addInstance(fxBatches, FX.magic, placeMatrix(at[0], at[1], at[2], surgeT, 1 + k * 30), [0.55, 0.95, 1, 3 * (1 - k)], [0, 0, 0, 0], [Math.max(0, 1 - k) * 0.85, 2, 0, 0]);
        lights.push({ pos: at, radius: 80, color: [0.6, 0.95, 1], intensity: 8 * (1 - k) });
    }
    // The shrine's basin still glows (it dims when the battle starts).
    const shrineGlow = ["ambush", "fallback", "evac", "laststand", "ending", "complete"].includes(g.phase) ? 0.6 : 1.4;
    lights.push({ pos: [SHRINE[0], grid.height(SHRINE[0], SHRINE[1]) + 2.5, SHRINE[1]], radius: 30, color: [0.45, 0.9, 1], intensity: shrineGlow });
}

function drawPickups(cam: V3): void {
    const g = game!;
    for (const p of g.pickups) {
        if (p.taken || p.kind === "supply") continue;
        const k = pickupMeshes.get(p.item);
        if (!k) continue;
        const d = Math.hypot(p.x - cam[0], p.y - cam[1], p.z - cam[2]);
        if (d > 120) continue;
        const bob = Math.sin(g.time * 2 + p.id) * 0.06;
        const m = placeMatrix(p.x, p.y + 0.25 + bob, p.z, g.time * 0.8 + p.id, p.kind === "weapon" ? 0.7 : 1.4);
        addInstance(solidBatches, k, m, [0.5, 0.95, 1, 0], [0, 0, 0, 0], [1, 0, 1.2, 0], [p.x, p.y, p.z, 2]);
        if (d < 40) lights.push({ pos: [p.x, p.y + 0.6, p.z], radius: 4, color: [0.5, 0.95, 1], intensity: 1.2 });
    }
    // The emptied vial, lying where it fell (the ending).
    if (g.vialPos && g.flags.drank) {
        const k = pickupMeshes.get("vial");
        if (k) addInstance(solidBatches, k, multiply(placeMatrix(g.vialPos[0], g.vialPos[1] + 0.03, g.vialPos[2], 0.7), eulerMatrix([0, 0, 0], 0, 0, Math.PI / 2, 1.2)), [1, 1, 1, 0], [0, 0, 0, 0], [1, 0, 0.4, 0]);
    }
}

/** The Source: the sacred waterfall in the east wall, flickering through its colors as it dies. */
function sourceState(t: number): { color: [number, number, number]; intensity: number } {
    const palette: [number, number, number][] = [[0.45, 0.9, 1], [0.75, 0.55, 1], [1, 0.82, 0.45], [0.45, 1, 0.75]];
    const u = (t * 0.07) % palette.length;
    const i = Math.floor(u), f = u - i;
    const a = palette[i], b = palette[(i + 1) % palette.length];
    const c: [number, number, number] = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    // A dying heartbeat: mostly dim, a pulse now and then, a flicker.
    const beat = Math.pow(Math.max(0, Math.sin(t * 0.9)), 8);
    const flicker = 0.85 + 0.15 * Math.sin(t * 13.1) * Math.sin(t * 7.7);
    return { color: c, intensity: (0.35 + 0.65 * beat) * flicker };
}

function drawSource(): void {
    const t = game?.time ?? realTime;
    const s = sourceState(t);
    look.sourceColor = s.color;
    look.sourceIntensity = 0.55 * s.intensity;
    look.sourcePos = [SOURCE[0] - 40, FLOOR_Y + 60, SOURCE[2]];
    look.sourceReach = 520;
    // The fall: a ribbon from the gash in the wall down to the pool.
    const top = SOURCE[1], bottom = grid.height(SOURCE_POOL[0], SOURCE_POOL[1]);
    const m = frameMatrix([SOURCE[0] - 12, top, SOURCE[2]], [0, 0, 1], [0, 1, 0], [-1, 0, 0], 46, top - bottom, 30);
    addInstance(fxBatches, FX.waterfall, m, [1, 1, 1, 0], [0, 0, 0, 0], [1, 0, 0, 0], [SOURCE[0], (top + bottom) / 2, SOURCE[2], (top - bottom) * 0.6]);
    lights.push({ pos: [SOURCE_POOL[0], bottom + 6, SOURCE_POOL[1]], radius: 140, color: s.color, intensity: 2.5 * s.intensity });
}

function drawViewModel(cam: { pos: V3; target: V3; fov: number }): void {
    const g = game;
    const show = !!g && mode === "play" && !g.cinema && g.alive && g.phase !== "complete" && !freeCam;
    for (const id of Object.keys(viewItems) as WeaponId[]) renderer.show(viewItems[id]!.mesh, show && g!.inv.current === id);
    if (!show || !g) return;
    const v = viewItems[g.inv.current];
    if (!v) return;
    const f = norm3([cam.target[0] - cam.pos[0], cam.target[1] - cam.pos[1], cam.target[2] - cam.pos[2]]);
    let r = norm3(cross3(f, [0, 1, 0]));
    if (!Number.isFinite(r[0])) r = [1, 0, 0];
    const u = cross3(r, f);
    const spec = WEAPONS[g.inv.current];
    const ads = g.look.ads * g.look.ads * (3 - 2 * g.look.ads);
    const bob = Math.sin(g.body.stride * 1.9) * 0.012 * Math.min(1, g.body.speed / 4);
    const kick = g.ws.kick * 0.04;
    const reload = g.ws.reloading > 0 ? Math.sin(Math.min(1, g.ws.reloading / (spec.reload ?? 1)) * Math.PI) * 0.18 : 0;
    let m: Mat4;
    if (spec.kind === "gun") {
        // Right of center and low at the hip; on the sight line down the sights.
        const side = 0.2 * (1 - ads), down = -0.21 * (1 - ads) - 0.085 * ads, ahead = 0.34 - kick;
        const p: V3 = [cam.pos[0] + r[0] * side + u[0] * (down + bob - reload) + f[0] * ahead, cam.pos[1] + r[1] * side + u[1] * (down + bob - reload) + f[1] * ahead, cam.pos[2] + r[2] * side + u[2] * (down + bob - reload) + f[2] * ahead];
        // The rifle's +X is its right: the camera's right is r; its +Z the barrel: forward.
        m = frameMatrix(p, r, u, f, 0.85, 0.85, 0.85);
    } else {
        // A blade held up at the right, swinging across when it strikes.
        const swing = g.ws.swing >= 0 ? Math.min(1, g.ws.swing / spec.interval) : -1;
        const a = swing < 0 ? 0.5 : 0.5 - Math.sin(swing * Math.PI) * 1.9;
        const p: V3 = [cam.pos[0] + r[0] * 0.25 + u[0] * (-0.3 + bob) + f[0] * 0.45, cam.pos[1] + r[1] * 0.25 + u[1] * (-0.3 + bob) + f[1] * 0.45, cam.pos[2] + r[2] * 0.25 + u[2] * (-0.3 + bob) + f[2] * 0.45];
        // Blade up (+Y) leaning forward, rolled across by the swing.
        const ca = Math.cos(a), sa = Math.sin(a);
        const up: V3 = [u[0] * ca + f[0] * sa * 0.6 - r[0] * sa * 0.5, u[1] * ca + f[1] * sa * 0.6 - r[1] * sa * 0.5, u[2] * ca + f[2] * sa * 0.6 - r[2] * sa * 0.5];
        const upn = norm3(up);
        const rr = norm3(cross3(upn, f));
        const ff = cross3(rr, upn);
        const s = g.inv.current === "warden-glaive" ? 0.55 : 0.9;
        m = frameMatrix(p, rr, upn, ff, s, s, s);
    }
    renderer.writeItem(v.item, m, [1, 1, 1, 0], [0, 0, 0, 0], [1, 1, 0, 0]);
}

function nearestRotor(cam: V3): number {
    let best = Infinity;
    for (const a of game?.aircraft ?? []) if (a.mode !== "wreck" && a.mode !== "parked") best = Math.min(best, Math.hypot(a.pos[0] - cam[0], a.pos[1] - cam[1], a.pos[2] - cam[2]));
    return best;
}

function pickLights(cam: V3): PointLight[] {
    // Static lamps near the camera: the ledge's, crystals of the deep.
    const scored = lights.map(l => ({ l, s: l.intensity * l.radius / (1 + Math.hypot(l.pos[0] - cam[0], l.pos[1] - cam[1], l.pos[2] - cam[2])) }));
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 16).map(x => x.l);
}

function updateLook(dt: number, cam: { pos: V3; target: V3; fov: number }): void {
    look.flash = Math.max(0, look.flash - dt * 1.6);
    if (look.flash <= 0) look.flashHue = 0;
    const f = game?.cinema?.frame;
    look.fade = game?.black ? 1 : (f?.fade ?? 0);
    if (game && !game.alive) look.fade = Math.min(0.6, game.deadT * 0.3);
    look.saturation = f?.grade.saturation ?? (game && !game.alive ? 0.2 : 1);
    look.contrast = f?.grade.contrast ?? 1.05;
    look.exposure = 0.85 * (f?.grade.exposure ?? 1);
    look.vignette = game?.cinema ? 0.45 : 0.3;
    // How sunlit the air at the camera is (from the baked shadows).
    look.cameraSun = light && light.done ? (light.inShadow(cam.pos[0], cam.pos[1], cam.pos[2]) ? 0 : 1) : 1;
}

let shadowsOn = true;
function updateShadows(cam: { pos: V3; target: V3 }): void {
    if (!shadowsOn) { Entropy.Lighting.setSunShadows({ cascades: [] }); return; }
    const f = norm3([cam.target[0] - cam.pos[0], cam.target[1] - cam.pos[1], cam.target[2] - cam.pos[2]]);
    const s = shadowCascades(cam.pos, f, SUN_DIR, [14, 50, 170], 2048);
    Entropy.Lighting.setSunShadows({ cascades: s.cascades, texel: s.texel, depthRange: s.depthRange, strength: 0.85, mapSize: 2048 });
}

// --- The UI ------------------------------------------------------------------------------------------------

function drawUi(dt: number, w: number, h: number, cam: { pos: V3; target: V3; fov: number }): void {
    if (!painter) return;
    const p = painter;
    p.begin();
    for (const t of hud.toasts) t.age += dt;
    hud.toasts = hud.toasts.filter(t => t.age < 4.5);
    hud.hit = Math.max(0, hud.hit - dt);
    if (mode === "loading") drawLoading(p, w, h, loadStage, loadProgress, realTime);
    else if (mode === "title" && game) drawTitle(p, { w, h, time: realTime, hasCheckpoint: !!savedCheckpoint && savedCheckpoint !== "intro", checkpointLabel: (savedCheckpoint ?? "").toUpperCase(), aimAssist: game.aimAssist, sensitivity: game.sensitivity, chapterMenu: menuChapters });
    else if (game) {
        const g = game;
        if (g.phase === "complete") {
            const sq = g.squad();
            drawComplete(p, { w, h, time: realTime, seconds: g.stats.finished - g.stats.started, kills: g.stats.kills, accuracy: g.stats.shots ? g.stats.hits / g.stats.shots : 0, artifacts: g.inv.artifacts.length, value: artifactValue(g.inv), squadAlive: sq.filter(a => alive(a)).length, squadTotal: sq.length });
        } else if (g.cinema) {
            const f = g.cinema.frame;
            drawCinema(p, {
                w, h, time: g.time, letterbox: f?.letterbox ?? true, black: g.black,
                cards: f?.cards ?? [],
                radio: (f?.subtitles ?? []).map(s => ({ speaker: s.speaker, text: s.text, channel: s.channel ?? "voice", age: s.age })),
                skip: skipHeld,
            });
        } else {
            drawHud(p, hudView(w, h, cam));
            if (!g.alive) drawDead(p, w, h, g.deadT);
            if (mode === "inventory") drawInventory(p, inventoryView(w, h));
        }
    }
    p.flush();
}

function hudView(w: number, h: number, cam: { pos: V3; target: V3; fov: number }): HudView {
    const g = game!;
    const obj = g.currentObjective();
    const objText = obj ? `${obj.title}|${obj.text}` : "";
    if (objText !== hud.objectiveText) { hud.objectiveText = objText; hud.objectiveAge = 0; } else hud.objectiveAge += 1 / 30;
    const b = g.body;
    const markers: HudMarker[] = [];
    const scanning = g.time - g.scanT < 7;
    const e = eye(b);
    for (const a of g.combat.actors) {
        if (!alive(a)) continue;
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (a.faction === "below") {
            if (d > 160) continue;
            const visible = d < 130 && world!.clear(e.pos, [a.x, a.y + 1.3, a.z]);
            if (!visible && !scanning && a.role !== "leader") continue;
            markers.push({ kind: a.role === "leader" ? "leader" : "hostile", pos: [a.x, a.y, a.z], label: a.role === "leader" ? "THE WARDEN" : a.role === "caster" ? "ADEPT" : "WARDEN", dist: d, visible, hp: a.hp / a.maxHp, assist: g.assist?.id === a.id });
        } else markers.push({ kind: "squad", pos: [a.x, a.y, a.z], label: (SQUAD.find(s => s.name === a.name)?.callsign ?? a.name).toUpperCase(), dist: d, visible: true, hurt: a.hp < a.maxHp * 0.5 });
    }
    for (const pk of g.pickups) {
        if (pk.taken || pk.kind === "supply") continue;
        const d = Math.hypot(pk.x - b.x, pk.z - b.z);
        if (d < 22 || (scanning && d < 140)) markers.push({ kind: "pickup", pos: [pk.x, pk.y + 0.4, pk.z], label: pk.label, dist: d, visible: true });
    }
    for (const a of g.aircraft) if (a.mode !== "parked" && a.mode !== "wreck") markers.push({ kind: "aircraft", pos: a.pos, label: a.callsign, dist: Math.hypot(a.pos[0] - b.x, a.pos[1] - b.y, a.pos[2] - b.z), visible: true });
    let dist: number | null = null, bearing: number | null = null;
    if (obj?.marker) {
        const [ox, oz] = obj.marker;
        dist = Math.hypot(ox - b.x, oz - b.z);
        bearing = Math.atan2(ox - b.x, oz - b.z);
        markers.push({ kind: "objective", pos: [ox, grid.height(ox, oz) + 3, oz], label: obj.text, dist, visible: true });
    }
    const spec = WEAPONS[g.inv.current];
    const it = g.interactable;
    const prompt = it ? ("id" in it ? (it.kind === "vial" ? "[E]  DRINK" : `[E]  ${it.kind === "artifact" ? "COLLECT" : "TAKE"}  ${it.label}`) : `[E]  ${it.label.toUpperCase()}`) : null;
    const hostiles = living(g.combat, "below").filter(a => a.role !== "leader").length;
    return {
        w, h, time: g.time, cam: { pos: cam.pos, target: cam.target, fov: cam.fov, w, h },
        heading: b.yaw,
        objective: obj ? { title: obj.title, text: obj.text, dist, bearing, age: hud.objectiveAge } : null,
        squad: g.squad().map(a => ({ name: SQUAD.find(s => s.name === a.name)?.callsign ?? a.name, hp: a.hp / a.maxHp, alive: alive(a), hurt: a.hurtT > 0 })),
        health: g.health, maxHealth: g.maxHealth, armor: g.inv.armor, armorMax: g.inv.armorMax, stamina: b.stamina,
        depth: depthBelowRim(b.y),
        weapon: {
            name: spec.name, kind: spec.kind, mag: g.inv.mags[g.inv.current] ?? 0, magMax: spec.mag ?? 1, reserve: g.inv.reserve[g.inv.current] ?? 0, reloading: g.ws.reloading,
            slot: g.inv.weapons.indexOf(g.inv.current), slots: g.inv.weapons.map(id => ({ "coil-rifle": "RIFLE", "arc-pistol": "SIDEARM", "monoblade": "BLADE", "warden-glaive": "GLAIVE" } as Record<WeaponId, string>)[id]),
        },
        crosshair: { spread: (spec.spread ?? 0.01) * (1 + Math.min(1, b.speed / 6) * 1.5), assist: !!g.assist, hit: hud.hit, kill: hud.kill, ads: g.look.ads },
        markers,
        radio: g.onAir().map(l => ({ speaker: l.speaker, text: l.text, channel: l.channel ?? "radio", age: g.time - l.at })),
        hurtDirs: g.hurtDir,
        prompt,
        toasts: hud.toasts,
        scanAge: g.time - g.scanT,
        bootAge: hud.bootStart >= 0 ? g.time - hud.bootStart : 99,
        hostiles: ["ambush", "fallback", "evac", "laststand"].includes(g.phase) ? hostiles : 0,
        medgel: g.inv.medgel,
        critical: !!g.flags.critical && !g.flags.drank,
        dead: g.alive ? null : g.deadT,
        phaseTitle: obj?.title ?? null,
        triangles: showTriangles ? lastTriangles : null,
    };
}

function inventoryView(w: number, h: number) {
    const g = game!;
    return {
        w, h,
        weapons: g.inv.weapons.map(id => ({ name: WEAPONS[id].name, description: WEAPONS[id].description, current: g.inv.current === id })),
        armor: g.inv.armorName, armorValue: g.inv.armor, medgel: g.inv.medgel,
        artifacts: g.inv.artifacts.map(id => ({ name: ARTIFACTS[id].name, value: ARTIFACTS[id].value, note: ARTIFACTS[id].note })),
        selected: Math.min(invSelected, Math.max(0, g.inv.artifacts.length - 1)),
        total: artifactValue(g.inv),
        objective: g.currentObjective()?.text ?? null,
    };
}

// --- Lifecycle ------------------------------------------------------------------------------------------

addon.onInit(() => {
    renderer.init();
    terrainItem = renderer.createItem();
    renderer.writeItem(terrainItem, identity());
    skyItem = renderer.createItem();
    renderer.spawn("ab-sky", skyDome(), skyItem, "fx");
    solidBatches = new InstanceBatches(meshCacheInstances(CACHE_NAMESPACE, () => renderer.pipelines.instanced, () => renderer.worldBuffer, lightBinding), ITEM_FLOATS, { prefix: "ab-solid", idleFrames: 240 });
    peopleBatches = new InstanceBatches(meshCacheInstances(CACHE_NAMESPACE, () => renderer.pipelines.people, () => renderer.worldBuffer, lightBinding), ITEM_FLOATS, { prefix: "ab-people", idleFrames: 240 });
    fxBatches = new InstanceBatches(meshCacheInstances(CACHE_NAMESPACE, () => renderer.pipelines.instancedFx, () => renderer.worldBuffer, lightBinding), ITEM_FLOATS, { prefix: "ab-fx", idleFrames: 240 });
    loadSteps = makeLoadSteps();
    lookQueue = LOOKS.map(l => l.id);
    pickupQueue = [...Object.keys(ARTIFACTS), "warden-glaive", "medgel", "vial"];
    Entropy.setGameMode(false);
    Entropy.Lighting.updateSun({ horizonColor: [0, 0, 0], zenithColor: [0, 0, 0], sunDirection: SUN_DIR, sunColor: [1, 0.9, 0.8], sunIntensity: 0.2 });
    painter = safeEnginePainter(addon.UI as unknown as DrawApi);
    painter.onRefused = what => Entropy.println(`[abyss] refused a broken UI shape: ${what} (mode ${mode}, phase ${game?.phase})`);
    setupInput();
    registerTools();
    Entropy.println("[abyss] initialized");
});

addon.onUpdatePlus("Global", () => {
    if (!renderer.worldBuffer) return;
    const now = Date.now();
    const real = lastMs ? Math.min(0.1, Math.max(0, (now - lastMs) / 1000)) : 1 / 60;
    lastMs = now;
    const dt = fixedStep ?? real;
    frame(dt);
});

// --- MCP tools (and the live test) -------------------------------------------------------------------------

type Args = Record<string, unknown>;
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const vec = (v: unknown, d: V3): V3 => (Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number") ? [v[0], v[1], v[2]] : d);

function snapshot() {
    const g = game;
    return {
        mode, frames, realTime: Math.round(realTime * 100) / 100,
        loading: { stage: loadStage, progress: Math.round(loadProgress * 100) / 100, step: loadIndex, steps: loadSteps.length },
        camera: cameraNow(),
        triangles: { total: lastTriangles, terrain: terrainTriangles, instances: frameTriangles },
        batches: solidBatches ? { solid: solidBatches.lastStats, people: peopleBatches.lastStats, fx: fxBatches.lastStats } : null,
        props: props.length,
        sound: sound.played,
        game: g ? g.summary() : null,
    };
}

/** Advances the game (and draws) n frames at a fixed step: for tools that need the world to move. */
function advance(n: number, input: Partial<GameInput> = {}): void {
    for (let i = 0; i < n; i++) {
        scripted = { ...input, frames: 1 };
        frame(fixedStep ?? 1 / 30);
    }
}

function registerTools(): void {
    const tools: { name: string; description: string; parameters: object; run: (a: Args) => object }[] = [
        { name: "abyss_state", description: "The game's state: mode, loading, camera, triangles drawn, and the chapter (phase, objective, Alex, squad, wardens, aircraft, radio).", parameters: { type: "object", properties: {} }, run: () => snapshot() },
        {
            name: "abyss_config", description: "Test and graphics settings: fixedStep (seconds per frame, null for real time), debug (1 terrain masks), detail (LOD distance scale), shadows (bool), triangles (show the count), look (world look overrides), aimAssist, sound (bool).",
            parameters: { type: "object", properties: { fixedStep: { type: "number" }, debug: { type: "number" }, detail: { type: "number" }, shadows: { type: "boolean" }, triangles: { type: "boolean" }, aimAssist: { type: "number" }, sound: { type: "boolean" } } },
            run: a => {
                if ("fixedStep" in a) fixedStep = a.fixedStep === null ? null : num(a.fixedStep, 1 / 30);
                if ("debug" in a) look.debug = num(a.debug, 0);
                if ("detail" in a) detail = Math.max(0.25, Math.min(3, num(a.detail, 1)));
                if ("shadows" in a) shadowsOn = !!a.shadows;
                if ("triangles" in a) showTriangles = !!a.triangles;
                if ("sound" in a) sound.enabled = !!a.sound;
                if (game && "aimAssist" in a) game.aimAssist = num(a.aimAssist, 0.5);
                if (a.look && typeof a.look === "object") Object.assign(look, a.look);
                return snapshot();
            },
        },
        {
            name: "abyss_settle", description: "Finishes loading now (bakes the world and builds every mesh; the first run builds the people, a few seconds each).",
            parameters: { type: "object", properties: {} },
            run: () => { const was = fixedStep; fixedStep = 1 / 30; let guard = 0; while (mode === "loading" && guard++ < 100000) loadStep(); fixedStep = was; return snapshot(); },
        },
        {
            name: "abyss_start", description: "Starts the chapter at a phase: intro, ledge, descent, floor, ambush, fallback, evac, laststand, ending.",
            parameters: { type: "object", properties: { phase: { type: "string" } } },
            run: a => {
                const phase = String(a.phase ?? "intro") as Phase;
                if (!START_PHASES.includes(phase)) throw new Error(`No phase ${phase}`);
                freeCam = null;
                newGame(phase);
                return snapshot();
            },
        },
        {
            name: "abyss_cinema", description: "Plays the current cutscene forward to time t (seconds from its start) and holds there, or skips it (skip: true).",
            parameters: { type: "object", properties: { t: { type: "number" }, skip: { type: "boolean" } } },
            run: a => {
                const g = game;
                if (!g?.cinema) throw new Error("No cutscene playing");
                if (a.skip) { advance(1, { skip: true }); return snapshot(); }
                const target = num(a.t, 0);
                let guard = 0;
                while (g.cinema && g.cinema.t < target - 1e-6 && guard++ < 20000) { g.step(Math.min(1 / 30, target - g.cinema.t), NO_INPUT); handleEvents(g.events); }
                draw(0);
                return snapshot();
            },
        },
        {
            name: "abyss_camera", description: "A free camera at position looking at target (fov degrees); {release: true} gives the camera back to the game.",
            parameters: { type: "object", properties: { position: { type: "array" }, target: { type: "array" }, fov: { type: "number" }, release: { type: "boolean" } } },
            run: a => {
                if (a.release) freeCam = null;
                else freeCam = { pos: vec(a.position, cameraNow().pos), target: vec(a.target, cameraNow().target), fov: num(a.fov, 45) };
                if (grid.done) updateTerrain(cameraNow().pos, Infinity);
                draw(0);
                return snapshot();
            },
        },
        {
            name: "abyss_act", description: "Plays Alex: action move (forward/strafe for frames), look (yaw/pitch radians), fire (frames), interact, teleport (x, z, yaw), heal, scan, weapon (1-4), drink, ads (frames), wait (frames), face (x, z: turn toward a point).",
            parameters: { type: "object", properties: { action: { type: "string" } } },
            run: a => {
                const g = game;
                if (!g) throw new Error("Not loaded");
                const frames = Math.max(1, Math.round(num(a.frames, 1)));
                switch (String(a.action)) {
                    case "move": advance(frames, { moveY: num(a.forward, 1), moveX: num(a.strafe, 0), sprint: !!a.sprint }); break;
                    case "look": g.body.yaw = num(a.yaw, g.body.yaw); g.body.pitch = num(a.pitch, g.body.pitch); advance(1); break;
                    case "face": { const x = num(a.x, 0), z = num(a.z, 0); g.body.yaw = Math.atan2(x - g.body.x, z - g.body.z); g.body.pitch = num(a.pitch, -0.05); advance(1); break; }
                    case "fire": advance(frames, { fire: true, ads: !!a.ads }); break;
                    case "ads": advance(frames, { ads: true }); break;
                    case "interact": advance(1, { interact: true }); break;
                    case "heal": advance(1, { heal: true }); break;
                    case "scan": advance(1, { scan: true }); break;
                    case "weapon": advance(1, { weapon: num(a.slot, 1) }); break;
                    case "teleport": {
                        const x = num(a.x, g.body.x), z = num(a.z, g.body.z);
                        g.body.x = x; g.body.z = z; g.body.y = grid.height(x, z); g.body.vy = 0;
                        if ("yaw" in a) g.body.yaw = num(a.yaw, g.body.yaw);
                        g.trail = [];
                        advance(1);
                        break;
                    }
                    case "drink": g.drink(); advance(1); break;
                    case "wait": advance(frames); break;
                    case "inventory": mode = mode === "inventory" ? "play" : "inventory"; advance(1); break;
                    default: throw new Error(`Unknown action ${String(a.action)}`);
                }
                return snapshot();
            },
        },
    ];
    for (const t of tools) {
        addon.registerTool({ name: t.name, description: t.description, parameters: t.parameters }, (args: Args) => {
            try { return { success: true, ...t.run(args && typeof args === "object" ? args : {}) }; }
            catch (error) { return { success: false, error: (error as Error).message }; }
        });
    }
}
