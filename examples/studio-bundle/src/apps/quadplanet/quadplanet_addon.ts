// QuadPlanet: the QuadScape quadtree terrain wrapped around whole planets. Walk on one, climb
// into your ship, fly to another planet and step out onto it.
//
// Three planets (Verdant, Ember, Glacia) are each six cube-face quadtrees streamed around the
// camera (qp_quadtree.ts), a single WGSL shader lights terrain, water, sky and atmosphere
// (qp_shader.ts), and qp_sim.ts holds the walker, the ship and the autopilot as plain state.
//
// Controls - on foot: W/S walk, A/D turn, Shift run, Space jump, E board the ship when next to it.
// In the ship: W thrust (Shift boost), S brake, A/D yaw, Up/Down arrows pitch, Space climb, C sink,
// E step out once landed, T (or the HUD buttons) autopilot to the next planet.
// Anywhere: drag to orbit the camera, wheel to zoom, L tints chunks by quadtree level.

import { type Vec3, frameMatrix, identity4, makeFrame, normalize, rotateAround, round3, add, scale, cross, dot } from "./qp_math";
import { PLANETS, SUN_DIRECTION, planetById, chunkResolutions, chunkVerticesFor, surfacePoint, type ChunkDetail } from "./qp_planet";
import { PlanetStreamer, maxLevelFor, type ChunkMesh, type ChunkNode } from "./qp_quadtree";
import { QUADPLANET_SHADER, ITEM_FLOATS, WORLD_FLOATS, packWorld } from "./qp_shader";
import { buildShip, buildSky, buildWalkerBody, buildWalkerLeg, HIP_HEIGHT, type ModelMesh } from "./qp_models";
import {
    type GameState, type Input, type CameraPose, NO_INPUT, cameraPose, initialState, interact, nearestPlanet, orbitPose,
    overheadPose, readout, startAutopilot, step, upAt,
} from "./qp_sim";

const addon = Entropy.AddonAtom.register({
    name: "QuadPlanet",
    version: "0.1.0",
    description: "Quadtree planets you can walk on, and a ship to fly between them",
    author: ["Entropy Team", "Claude"],
    capabilities: { graphics: true, ui: true },
});

const W = Entropy.UI.Widget;
const Icons = Entropy.Icons;
const ACCENT: [number, number, number, number] = [0.45, 0.78, 1.0, 1];
const DIM: [number, number, number, number] = [0.68, 0.72, 0.78, 1];
const WARM: [number, number, number, number] = [1.0, 0.72, 0.4, 1];

// --- State ---------------------------------------------------------------------------------------

let state: GameState = initialState();
let pipelineId = "";
let worldBuffer = "";
let terrainItem = "";
let shipItem = "";
let bodyItem = "";
let legItems: [string, string] = ["", ""];
let streamer: PlanetStreamer | null = null;
let debugLod = false;
let debugOutlines = false;
let exposure = 1.0;
/** Seconds per frame when set (a scripted run wants the same result on any machine). */
let fixedStep: number | null = null;
let lastFrameMs = 0;
/**
 * A camera held by the view tool: an orbit shot of `planet` from `distance` radii, or (planet -1)
 * straight down from `distance` above you. Null follows the walker or ship.
 */
let viewOverride: { planet: number; distance: number } | null = null;
let lastCamera: CameraPose | null = null;
let hudWindow = "";
let frameCount = 0;

// --- Engine meshes -------------------------------------------------------------------------------

function uniformBuffer(floats: number): string {
    return Entropy.Buffer.create({ size: floats * 4, usage: "Uniform" });
}

function bindings(item: string) {
    return [
        { group: 2, binding: 0, resource: { type: "Buffer" as const, value: { id: worldBuffer } } },
        { group: 2, binding: 1, resource: { type: "Buffer" as const, value: { id: item } } },
    ];
}

function spawn(id: string, mesh: ModelMesh | ChunkMesh, item: string): void {
    Entropy.Model.createMesh({ id, position: [0, 0, 0], vertexData: mesh.vertexData, indexData: mesh.indexData, pipelineId, bindings: bindings(item) });
}

function writeItem(item: string, matrix: number[], tint: [number, number, number, number]): void {
    Entropy.Buffer.write(item, new Float32Array([...matrix, ...tint]));
}

const HIDDEN = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];

function updateModels(): void {
    const ship = state.ship;
    writeItem(shipItem, frameMatrix(ship.pos, ship.frame), [1, 1, 1, ship.thrust]);
    if (state.mode === "walk") {
        const w = state.walker;
        const up = upAt(PLANETS[w.planet], w.pos);
        const frame = makeFrame(w.forward, up);
        writeItem(bodyItem, frameMatrix(w.pos, frame), [1, 1, 1, 0]);
        const swing = Math.sin(w.stride) * Math.min(1, w.speed / 5) * 0.6;
        [-1, 1].forEach((side, k) => {
            const hip = add(add(w.pos, scale(up, HIP_HEIGHT)), scale(frame.right, side * 0.16));
            const a = swing * side;
            const legFrame = makeFrame(rotateAround(frame.forward, frame.right, a), rotateAround(frame.up, frame.right, a));
            writeItem(legItems[k], frameMatrix(hip, legFrame), [1, 1, 1, 0]);
        });
    } else {
        for (const item of [bodyItem, ...legItems]) writeItem(item, HIDDEN, [1, 1, 1, 0]);
    }
}

function writeWorld(): void {
    Entropy.Buffer.write(worldBuffer, packWorld({
        sunDir: SUN_DIRECTION,
        time: state.time,
        sunColor: [1.0, 0.96, 0.9],
        exposure,
        debugLod,
        debugOutlines,
        planets: PLANETS.map(p => ({ center: p.center, radius: p.radius, atmosphere: p.atmosphereColor, atmosphereHeight: p.atmosphereHeight })),
    }));
}

// --- Input ---------------------------------------------------------------------------------------

const key = (k: string) => Entropy.Input.isKeyPressed(k) || Entropy.Input.isKeyPressed(k.toUpperCase());

function readInput(): Input {
    if (Entropy.Input.isTypingInUI()) return NO_INPUT;
    const walking = state.mode === "walk";
    return {
        forward: key("w") || (walking && key("ArrowUp")),
        back: key("s") || (walking && key("ArrowDown")),
        left: key("a") || key("ArrowLeft"),
        right: key("d") || key("ArrowRight"),
        up: key(" "),
        down: key("c"),
        pitchUp: !walking && key("ArrowDown"),
        pitchDown: !walking && key("ArrowUp"),
        boost: Entropy.Input.isShiftPressed(),
    };
}

/** The planet after the one the ship is nearest to (T's target). */
function nextPlanet(): number {
    return (nearestPlanet(state.ship.pos) + 1) % PLANETS.length;
}

let dragFrom: [number, number] | null = null;

function setupInput(): void {
    Entropy.Input.onKeyDown((k: string) => {
        if (Entropy.Input.isTypingInUI()) return;
        const lower = k.toLowerCase();
        if (lower === "e") interact(state);
        else if (lower === "t") startAutopilot(state, nextPlanet());
        else if (lower === "l") debugLod = !debugLod;
        else if (lower === "o") debugOutlines = !debugOutlines;
        else if (lower === "v") viewOverride = viewOverride ? null : { planet: nearestPlanet(lastCamera?.position ?? state.walker.pos), distance: 3.2 };
    });
    Entropy.Input.onMouseDown((_button: number, x: number, y: number) => {
        dragFrom = Entropy.Input.isPointerOverUI() ? null : [x, y];
    });
    Entropy.Input.onMouseMove((x: number, y: number) => {
        if (!dragFrom) return;
        const dx = x - dragFrom[0], dy = y - dragFrom[1];
        dragFrom = [x, y];
        state.rig.yaw -= dx * 0.006;
        state.rig.pitch = Math.max(-0.35, Math.min(1.35, state.rig.pitch + dy * 0.005));
    });
    Entropy.Input.onMouseUp(() => { dragFrom = null; });
    Entropy.Input.onMouseWheel((_dx: number, dy: number) => {
        if (Entropy.Input.isPointerOverUI()) return;
        const [lo, hi] = state.mode === "walk" ? [3, 40] : [10, 160];
        state.rig.distance = Math.max(lo, Math.min(hi, state.rig.distance * (dy > 0 ? 0.9 : 1.1)));
    });
}

// --- HUD -----------------------------------------------------------------------------------------

const fmt = (n: number, digits = 0) => n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });

function renderHud(): void {
    const id = hudWindow;
    const r = readout(state);
    const stats = streamer?.stats;
    W.horizontal(id, () => {
        W.label(id, { text: Icons.label("planet", "QuadPlanet"), bold: true, fontSize: 16, color: ACCENT });
        W.spacer(id, 8);
        W.label(id, { text: r.mode === "walk" ? Icons.label("person-simple-walk", "On foot") : Icons.label("rocket", r.autopilot ? "Autopilot" : r.landed ? "Ship, landed" : "Flying"), color: WARM });
    });
    W.label(id, { text: `${Icons.get("globe-hemisphere-west")} ${r.planet}`, bold: true });
    W.label(id, { text: `Altitude ${fmt(Math.max(0, r.altitude), 1)} u   Speed ${fmt(r.speed, 1)} u/s`, monospace: true, color: DIM });
    if (r.autopilot) W.label(id, { text: `${Icons.get("navigation-arrow")} To ${r.autopilot.target}: ${fmt(r.autopilot.progress * 100)}%`, monospace: true, color: ACCENT });
    if (state.mode === "walk" && r.shipDistance < 60) W.label(id, { text: `Ship ${fmt(r.shipDistance, 1)} u away`, color: DIM, monospace: true });
    W.label(id, { text: state.message, wrap: true });
    if (state.mode === "ship" && !state.ship.autopilot) {
        W.horizontal(id, () => {
            PLANETS.forEach((p, i) => {
                if (i === nearestPlanet(state.ship.pos) && state.ship.landed) return;
                W.button(id, { id: `qp-fly-${p.id}`, text: Icons.label("rocket-launch", `Fly to ${p.name}`), onClick: () => { startAutopilot(state, i); } });
            });
        });
    }
    W.separator(id);
    W.horizontal(id, () => {
        W.checkbox(id, { id: "qp-lod-debug", label: "Color by level (L)", value: debugLod, onChange: v => { debugLod = !!v; } });
        W.checkbox(id, { id: "qp-outlines", label: "Outline chunks (O)", value: debugOutlines, onChange: v => { debugOutlines = !!v; } });
    });
    if (stats) {
        const deep = PLANETS.map((p, i) => `${p.name} ${stats.perPlanet[i]} @L${stats.deepest[i]}/${maxLevelFor(p)}`).join("  ");
        W.label(id, { text: `${Icons.get("stack")} ${stats.live} chunks (${stats.stitched} stitched), ${fmt(stats.triangles / 1000)}k tris${stats.pending ? `, ${stats.pending} streaming` : ""}`, monospace: true, color: DIM });
        W.label(id, { text: deep, monospace: true, color: DIM });
    }
    W.label(id, { text: state.mode === "walk" ? "W/S walk  A/D turn  Shift run  Space jump  E board" : "W thrust  Shift boost  A/D yaw  arrows pitch  Space/C climb/sink  E exit  T autopilot", color: DIM, wrap: true });
}

function setupUI(): void {
    Entropy.UI.setTheme({
        background: [0.05, 0.07, 0.1, 0.62],
        surface: [0.12, 0.15, 0.2, 0.85],
        surfaceHover: [0.18, 0.22, 0.28, 1],
        border: [1, 1, 1, 0.08],
        text: [0.93, 0.95, 0.97, 1],
        accent: ACCENT,
        cornerRadius: 7,
        windowCornerRadius: 12,
        itemSpacing: 6,
        buttonPadding: [10, 5],
    });
    hudWindow = Entropy.UI.createWindow({ title: "QuadPlanet", width: 470, height: 290, x: 16, y: 16, decorations: false, glass: true, onRender: renderHud });
}

// --- Tools (MCP, and the live BDD run) -----------------------------------------------------------

type Args = Record<string, unknown>;

function snapshot() {
    const r = readout(state);
    const stats = streamer?.stats;
    return {
        mode: r.mode,
        planet: r.planet,
        altitude: Math.round(r.altitude * 100) / 100,
        speed: Math.round(r.speed * 100) / 100,
        grounded: r.grounded,
        shipLanded: r.landed,
        shipPlanet: PLANETS[nearestPlanet(state.ship.pos)].name,
        shipDistance: Math.round(r.shipDistance * 100) / 100,
        autopilot: r.autopilot,
        walked: Math.round(state.walked * 100) / 100,
        visited: state.visited,
        time: Math.round(state.time * 1000) / 1000,
        frames: frameCount,
        message: state.message,
        walker: { position: round3(state.walker.pos), planet: PLANETS[state.walker.planet].name },
        ship: { position: round3(state.ship.pos) },
        camera: lastCamera ? { position: round3(lastCamera.position), target: round3(lastCamera.target), up: round3(lastCamera.up, 3) } : null,
        chunks: stats ? {
            live: stats.live, pending: stats.pending, hidden: stats.hidden, triangles: stats.triangles,
            built: stats.built, destroyed: stats.destroyed, stitched: stats.stitched, balanced: stats.balanced,
            planets: PLANETS.map((p, i) => ({ name: p.name, chunks: stats.perPlanet[i], deepestLevel: stats.deepest[i], maxLevel: maxLevelFor(p),
                verticesPerLevel: Array.from({ length: maxLevelFor(p) + 1 }, (_, j) => chunkVerticesFor(p, maxLevelFor(p) - j)) })),
        } : null,
        debugLod,
        debugOutlines,
        fixedStep,
    };
}

function planetIndex(value: unknown): number {
    const p = typeof value === "string" ? planetById(value) : undefined;
    if (!p) throw new Error(`Unknown planet ${JSON.stringify(value)}; try ${PLANETS.map(q => q.name).join(", ")}`);
    return PLANETS.indexOf(p);
}

const TOOLS: { name: string; description: string; parameters: object; run: (a: Args) => object }[] = [
    {
        name: "quadplanet_state",
        description: "Where the walker and ship are: mode (walk/ship), planet, altitude, speed, autopilot progress, and the terrain streamer's chunk counts per planet.",
        parameters: { type: "object", properties: {} },
        run: () => snapshot(),
    },
    {
        name: "quadplanet_planets",
        description: "The planets: name, center, radius, deepest quadtree level, gravity.",
        parameters: { type: "object", properties: {} },
        run: () => ({ planets: PLANETS.map(p => ({ id: p.id, name: p.name, center: p.center, radius: p.radius, maxLevel: maxLevelFor(p), gravity: p.gravity, sea: p.hasSea ? (p.frozenSea ? "ice" : "water") : "none" })) }),
    },
    {
        name: "quadplanet_config",
        description: "Configure timing, debug display, exposure and chunk interiors. chunkDetail: {mode:'half',leafVertices:64,levels:8} or {mode:'explicit',verticesPerLevel:[64,32,16,8]}. Lists run leaf to root; borders keep the existing grid and stitching. planet optionally limits the change to one planet; null chunkDetail restores defaults.",
        parameters: { type: "object", properties: {
            fixedStep: { type: ["number", "null"] }, debugLod: { type: "boolean" }, debugOutlines: { type: "boolean" }, exposure: { type: "number" },
            planet: { type: "string" },
            chunkDetail: { type: ["object", "null"], properties: {
                mode: { type: "string", enum: ["half", "explicit"] },
                leafVertices: { type: "integer", minimum: 3, maximum: 257 },
                levels: { type: "integer", minimum: 1, maximum: 13 },
                verticesPerLevel: { type: "array", minItems: 1, maxItems: 13, items: { type: "integer", minimum: 3, maximum: 257 } },
            } },
        } },
        run: a => {
            if ("chunkDetail" in a) {
                const targets = a.planet === undefined ? PLANETS : [PLANETS[planetIndex(a.planet)]];
                const value = a.chunkDetail;
                if (value !== null && (typeof value !== "object" || Array.isArray(value))) throw new Error("chunkDetail must be an object or null.");
                // Resolve before changing any state; copy the list so callers cannot mutate it later.
                const detail: ChunkDetail | undefined = value === null ? undefined : { mode: "explicit", verticesPerLevel: chunkResolutions(value as ChunkDetail) };
                for (const p of targets) p.chunkDetail = detail;
                streamer?.clear();
                if (state.walker.grounded) {
                    const p = PLANETS[state.walker.planet];
                    state.walker.pos = surfacePoint(p, upAt(p, state.walker.pos));
                }
                if (state.ship.landed) {
                    const p = PLANETS[state.ship.planet];
                    state.ship.pos = surfacePoint(p, upAt(p, state.ship.pos));
                }
            }
            if ("fixedStep" in a) fixedStep = typeof a.fixedStep === "number" && a.fixedStep > 0 ? Math.min(0.1, a.fixedStep) : null;
            if (typeof a.debugLod === "boolean") debugLod = a.debugLod;
            if (typeof a.debugOutlines === "boolean") debugOutlines = a.debugOutlines;
            if (typeof a.exposure === "number") exposure = Math.max(0.2, Math.min(3, a.exposure));
            return snapshot();
        },
    },
    {
        name: "quadplanet_interact",
        description: "Same as pressing E: board the ship when within reach of it, or step out once it has landed.",
        parameters: { type: "object", properties: {} },
        run: () => ({ result: interact(state), ...snapshot() }),
    },
    {
        name: "quadplanet_autopilot",
        description: "Fly the ship (you must be aboard) to a sunlit landing site on another planet.",
        parameters: { type: "object", properties: { target: { type: "string", description: "Planet name: Verdant, Ember or Glacia" } }, required: ["target"] },
        run: a => {
            const plan = startAutopilot(state, planetIndex(a.target));
            if (!plan) throw new Error(state.message);
            return { duration: Math.round(plan.duration * 100) / 100, distance: Math.round(Math.hypot(plan.p3[0] - plan.p0[0], plan.p3[1] - plan.p0[1], plan.p3[2] - plan.p0[2])), ...snapshot() };
        },
    },
    {
        name: "quadplanet_view",
        description: "mode 'orbit' holds the camera out in space looking at a planet (whole-planet LOD shots); 'overhead' looks straight down on you from `height` (the rings of detail around you); 'follow' returns to the chase camera.",
        parameters: { type: "object", properties: { mode: { type: "string", enum: ["orbit", "overhead", "follow"] }, planet: { type: "string" }, distance: { type: "number", description: "In planet radii (default 3.2)" }, height: { type: "number", description: "Overhead height (default 120)" }, yaw: { type: "number" }, pitch: { type: "number" }, zoom: { type: "number" } } },
        run: a => {
            if (a.mode === "orbit") viewOverride = { planet: a.planet ? planetIndex(a.planet) : nearestPlanet(lastCamera?.position ?? state.walker.pos), distance: typeof a.distance === "number" ? a.distance : 3.2 };
            else if (a.mode === "overhead") viewOverride = { planet: -1, distance: typeof a.height === "number" ? a.height : 120 };
            else if (a.mode === "follow") viewOverride = null;
            if (typeof a.yaw === "number") state.rig.yaw = a.yaw;
            if (typeof a.pitch === "number") state.rig.pitch = a.pitch;
            if (typeof a.zoom === "number") state.rig.distance = a.zoom;
            return snapshot();
        },
    },
];

function registerTools(): void {
    for (const t of TOOLS) {
        addon.registerTool({ name: t.name, description: t.description, parameters: t.parameters }, (args: Args) => {
            try {
                return { success: true, ...t.run(args && typeof args === "object" ? args : {}) };
            } catch (error) {
                return { success: false, error: (error as Error).message };
            }
        });
    }
}

// --- Lifecycle -----------------------------------------------------------------------------------

addon.onInit(() => {
    pipelineId = Entropy.Pipeline.create({
        name: "QuadPlanet",
        layout: "mesh",
        pbr: false,
        vertexShader: QUADPLANET_SHADER,
        fragmentShader: QUADPLANET_SHADER,
        extraBindGroups: [{ entries: [
            { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
            { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
        ] }],
    });
    worldBuffer = uniformBuffer(WORLD_FLOATS);
    terrainItem = uniformBuffer(ITEM_FLOATS);
    shipItem = uniformBuffer(ITEM_FLOATS);
    bodyItem = uniformBuffer(ITEM_FLOATS);
    legItems = [uniformBuffer(ITEM_FLOATS), uniformBuffer(ITEM_FLOATS)];
    writeItem(terrainItem, identity4(), [1, 1, 1, 0]);
    writeWorld();

    spawn("qp-sky", buildSky(), terrainItem);
    spawn("qp-ship", buildShip(), shipItem);
    spawn("qp-walker", buildWalkerBody(), bodyItem);
    const leg = buildWalkerLeg();
    spawn("qp-leg-left", leg, legItems[0]);
    spawn("qp-leg-right", leg, legItems[1]);
    updateModels();

    streamer = new PlanetStreamer(PLANETS, {
        create: (id: string, _node: ChunkNode, mesh: ChunkMesh) => spawn(id, mesh, terrainItem),
        destroy: (id: string) => Entropy.Model.clearMesh(id),
    });

    Entropy.setGameMode(false);
    Entropy.Lighting.updateSun({ horizonColor: [0, 0, 0], zenithColor: [0, 0, 0], sunDirection: SUN_DIRECTION, sunColor: [1, 0.96, 0.9], sunIntensity: 0.2 });
    setupUI();
    setupInput();
    registerTools();
    Entropy.println("[quadplanet] initialized");
});

addon.onUpdatePlus("Global", () => {
    if (!streamer) return;
    const now = Date.now();
    const real = lastFrameMs ? Math.min(0.1, Math.max(0, (now - lastFrameMs) / 1000)) : 1 / 60;
    lastFrameMs = now;
    const dt = fixedStep ?? real;
    frameCount++;

    step(state, readInput(), dt);
    updateModels();

    let pose = cameraPose(state);
    if (viewOverride) pose = viewOverride.planet < 0 ? overheadPose(state, viewOverride.distance) : orbitPose(viewOverride.planet, PLANETS, viewOverride.distance);
    // Keep the view direction off the up axis (look_at can't use a parallel up).
    const look = normalize([pose.target[0] - pose.position[0], pose.target[1] - pose.position[1], pose.target[2] - pose.position[2]] as Vec3);
    let up = pose.up;
    if (Math.abs(dot(look, up)) > 0.98) up = normalize(cross(cross(look, up), look));
    Entropy.Camera.setTransform(pose.position, pose.target, up);
    lastCamera = { ...pose, up };

    writeWorld();
    // Stream around the camera (what is being looked at), a bounded amount per frame - except in
    // the overhead view, which is there to show the detail centered on you.
    const focus = viewOverride && viewOverride.planet < 0 ? (state.mode === "walk" ? state.walker.pos : state.ship.pos) : pose.position;
    streamer.update(focus, 10, 12);
});
