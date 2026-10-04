// QuadPlanet: the QuadScape quadtree terrain wrapped around whole planets. Walk on one, climb
// into your ship, fly to another planet and step out onto it - or fly to Earth, whose terrain is
// the real thing, and go to any place on it by name.
//
// Three procedural planets (Verdant, Ember, Glacia) and Earth are streamed around the camera on
// the Rust side (`Entropy.QuadPlanet`, src/heightfield_landscapes/QuadPlanet/): six cube-face
// quadtrees per planet, Earth's heights from SRTM-derived elevation tiles, and on Earth the
// OpenStreetMap buildings and roads around you, with Mesha houses where houses fit (qp_city.ts).
// A single WGSL shader
// lights terrain, water, sky and atmosphere (qp_shader.ts), and qp_sim.ts holds the walker, the
// ship and the autopilot as plain state.
//
// Controls - on foot: W/S walk, A/D turn, Shift run, Space jump, E board the ship when next to it.
// In the ship: W thrust (Shift boost), S brake, A/D yaw, Up/Down arrows pitch, Space climb, C sink,
// E step out once landed, T (or the HUD buttons) autopilot to the next planet.
// Anywhere: drag to orbit the camera, wheel to zoom, L tints chunks by quadtree level.

import { type Vec3, frameMatrix, identity4, makeFrame, normalize, rotateAround, round3, add, scale, cross, dot, distance, sub } from "./qp_math";
import {
    PLANETS, SUN_DIRECTION, planetById, surfacePoint, setTerrainBackend, setSunDirection, isEarth, latLonToDir, dirToLatLon,
    morningSunAt, findLandmark, DEFAULT_CHUNK_DETAIL, type ChunkDetail,
} from "./qp_planet";
import { QUADPLANET_SHADER, QUADPLANET_INSTANCED_SHADER, ITEM_FLOATS, WORLD_FLOATS, packWorld } from "./qp_shader";
import { meshCacheInstances, INSTANCED_BIND_GROUPS, HOUSE_WORKER_SCRIPT } from "./qp_instances";
import { buildShip, buildSky, buildWalkerBody, buildWalkerLeg, HIP_HEIGHT, type ModelMesh } from "./qp_models";
import { CityHouses, HOUSE_NAMESPACE, houseRule, type CityBuilding, type CityOptions } from "./qp_city";
import {
    type GameState, type Input, type CameraPose, NO_INPUT, arriveAt, cameraPose, initialState, interact, nearestPlanet, orbitPose,
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

/** Set in onInit, once the terrain can answer where the ground is. */
let state: GameState = null as unknown as GameState;
let pipelineId = "";
/** Houses: instanced batches (qp_city.ts). */
let housePipelineId = "";
let worldBuffer = "";
let skyItem = "";
let shipItem = "";
let bodyItem = "";
let legItems: [string, string] = ["", ""];
/** The Rust-side planet system (Entropy.QuadPlanet), and what it last reported. */
let terrainId = "";
let stats: QuadPlanetStreamStats | null = null;
let info: QuadPlanetInfo | null = null;
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
/** The OpenStreetMap name of where you are on Earth, and the search box's text. */
let placeName: string | null = null;
let placeQuery = "";
/**
 * World point everything is drawn relative to (see qp_shader.ts, "Coordinates"): kept within
 * REBASE_DISTANCE of the camera, on whole meters so it lies on the chunks' position grid. The
 * terrain chunks are re-placed by the Rust side when it moves.
 */
let renderOrigin: Vec3 = [0, 0, 0];
const REBASE_DISTANCE = 2048;
let frameCount = 0;
/** Mesha houses on Earth's OpenStreetMap buildings (qp_city.ts); null until the terrain exists. */
let houses: CityHouses | null = null;
let hideRadius = 0;
/** Roads are drawn out to this far (the city tiles reach ~3 km). */
const ROAD_DISTANCE = 2500;
/** House meshes kept on disk at most (least recently used go first). */
const HOUSE_CACHE_BYTES = 4e9;

// --- Terrain -------------------------------------------------------------------------------------

/** Terrain queries answered by the same Rust height function the chunks are built from. */
function useEngineTerrain(): void {
    const relief = new Map<string, number>();
    setTerrainBackend({
        sample: (p, d, wait) => Entropy.QuadPlanet.sample(terrainId, p.id, d, { wait }),
        normal: (p, d, stepSize) => Entropy.QuadPlanet.normal(terrainId, p.id, d, stepSize),
        landingSite: (p, preferred) => Entropy.QuadPlanet.findLandingSite(terrainId, p.id, preferred),
        maxRelief: p => {
            let r = relief.get(p.id);
            if (r === undefined) {
                r = refreshInfo().planets.find(q => q.id === p.id)?.maxRelief ?? 0;
                relief.set(p.id, r);
            }
            return r as number;
        },
    });
}

function refreshInfo(): QuadPlanetInfo {
    info = Entropy.QuadPlanet.info(terrainId);
    return info;
}

const planetInfo = (i: number) => (info ?? refreshInfo()).planets[i];

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

function spawn(id: string, mesh: ModelMesh, item: string): void {
    Entropy.Model.createMesh({ id, position: [0, 0, 0], vertexData: mesh.vertexData, indexData: mesh.indexData, pipelineId, bindings: bindings(item) });
}

function writeItem(item: string, matrix: number[], tint: [number, number, number, number], texOrigin: Vec3 = [0, 0, 0]): void {
    Entropy.Buffer.write(item, new Float32Array([...matrix, ...tint, ...texOrigin, 0]));
}

/** A world position as the GPU sees it: relative to the render origin. */
const toRender = (p: Vec3): Vec3 => sub(p, renderOrigin);

/** Moves the render origin to the camera once it strays too far. */
function followWithOrigin(camera: Vec3): void {
    if (distance(camera, renderOrigin) < REBASE_DISTANCE) return;
    renderOrigin = [Math.round(camera[0]), Math.round(camera[1]), Math.round(camera[2])];
}

const HIDDEN = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];

function updateModels(): void {
    const ship = state.ship;
    writeItem(shipItem, frameMatrix(toRender(ship.pos), ship.frame), [1, 1, 1, ship.thrust]);
    if (state.mode === "walk") {
        const w = state.walker;
        const up = upAt(PLANETS[w.planet], w.pos);
        const frame = makeFrame(w.forward, up);
        writeItem(bodyItem, frameMatrix(toRender(w.pos), frame), [1, 1, 1, 0]);
        const swing = Math.sin(w.stride) * Math.min(1, w.speed / 5) * 0.6;
        [-1, 1].forEach((side, k) => {
            const hip = add(add(w.pos, scale(up, HIP_HEIGHT)), scale(frame.right, side * 0.16));
            const a = swing * side;
            const legFrame = makeFrame(rotateAround(frame.forward, frame.right, a), rotateAround(frame.up, frame.right, a));
            writeItem(legItems[k], frameMatrix(toRender(hip), legFrame), [1, 1, 1, 0]);
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
        planets: PLANETS.map(p => ({ center: toRender(p.center), radius: p.radius, atmosphere: p.atmosphereColor, atmosphereHeight: p.atmosphereHeight })),
        city: { hideRadius, roadDistance: ROAD_DISTANCE },
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

// --- Travel on Earth ----------------------------------------------------------------------------

const EARTH = PLANETS.findIndex(isEarth);

/** Where you are, as a planet index and a position. */
function whereAmI(): { planet: number; pos: Vec3 } {
    return state.mode === "walk" ? { planet: state.walker.planet, pos: state.walker.pos } : { planet: nearestPlanet(state.ship.pos), pos: state.ship.pos };
}

/** Latitude/longitude (and the OSM place name, once looked up) when you are at Earth. */
function geo() {
    const here = whereAmI();
    if (here.planet !== EARTH) return null;
    const d = sub(here.pos, PLANETS[EARTH].center);
    const { lat, lon } = dirToLatLon(d);
    // Height of the ground here above sea level (real elevation plus the fine rock and soil).
    const ground = Entropy.QuadPlanet.sample(terrainId, PLANETS[EARTH].id, normalize(d)).terrain;
    return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, elevation: Math.round(ground * 10) / 10, place: placeName };
}

/** A place name, landmark or "lat, lon" to coordinates: offline landmarks first, then OSM. */
function resolvePlace(query: string): { name: string; lat: number; lon: number } {
    const coords = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (coords) return { name: `${coords[1]}, ${coords[2]}`, lat: Number(coords[1]), lon: Number(coords[2]) };
    const landmark = findLandmark(query);
    if (landmark) return landmark;
    const hits = Entropy.QuadPlanet.geocode(terrainId, query);
    if (!hits.length) throw new Error(`No place called ${JSON.stringify(query)} on OpenStreetMap.`);
    return hits[0];
}

/**
 * Takes you to a place on Earth: aboard the ship, the autopilot flies there; on foot (or with
 * `teleport`), you are set down there with the ship parked beside you. The sun is moved to
 * mid-morning over it unless `keepSun`, so a place on the night side isn't dark.
 */
function goTo(target: { name: string; lat: number; lon: number }, teleport: boolean, keepSun = false) {
    if (EARTH < 0) throw new Error("There is no Earth in this system.");
    if (!(Math.abs(target.lat) <= 90) || !(Math.abs(target.lon) <= 180)) throw new Error("Latitude must be within ±90 and longitude within ±180.");
    const dir = latLonToDir(target.lat, target.lon);
    if (!keepSun) {
        setSunDirection(morningSunAt(dir));
        Entropy.Lighting.updateSun({ horizonColor: [0, 0, 0], zenithColor: [0, 0, 0], sunDirection: SUN_DIRECTION, sunColor: [1, 0.96, 0.9], sunIntensity: 0.2 });
    }
    placeName = null;
    if (!teleport && state.mode === "ship") {
        const plan = startAutopilot(state, EARTH, PLANETS, dir);
        if (!plan) throw new Error(state.message);
        state.message = `Autopilot: flying to ${target.name}.`;
        return { mode: "fly", duration: Math.round(plan.duration * 100) / 100 };
    }
    arriveAt(state, EARTH, dir, PLANETS, true);
    viewOverride = null;
    state.message = `You are at ${target.name}. The ship is parked a short walk away.`;
    return { mode: "teleport" };
}

// --- HUD -----------------------------------------------------------------------------------------

const fmt = (n: number, digits = 0) => n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
/** Meters, switching to kilometers once they get large. */
const meters = (n: number, unit = "m") => Math.abs(n) < 10000 ? `${fmt(n, 1)} ${unit}` : `${fmt(n / 1000, 1)} k${unit}`;
const degrees = (v: number, pos: string, neg: string) => `${fmt(Math.abs(v), 4)}°${v >= 0 ? pos : neg}`;

function renderHud(): void {
    const id = hudWindow;
    const r = readout(state);
    W.horizontal(id, () => {
        W.label(id, { text: Icons.label("planet", "QuadPlanet"), bold: true, fontSize: 16, color: ACCENT });
        W.spacer(id, 8);
        W.label(id, { text: r.mode === "walk" ? Icons.label("person-simple-walk", "On foot") : Icons.label("rocket", r.autopilot ? "Autopilot" : r.landed ? "Ship, landed" : "Flying"), color: WARM });
    });
    W.label(id, { text: `${Icons.get("globe-hemisphere-west")} ${r.planet}`, bold: true });
    const g = geo();
    if (g) {
        W.label(id, { text: `${Icons.get("map-pin")} ${degrees(g.lat, "N", "S")} ${degrees(g.lon, "E", "W")}  ${meters(g.elevation)} above sea level`, monospace: true, color: ACCENT });
        if (g.place) W.label(id, { text: g.place, wrap: true, color: DIM });
    }
    W.label(id, { text: `Altitude ${meters(Math.max(0, r.altitude))}   Speed ${meters(r.speed, "m/s")}`, monospace: true, color: DIM });
    if (r.autopilot) W.label(id, { text: `${Icons.get("navigation-arrow")} To ${r.autopilot.target}: ${fmt(r.autopilot.progress * 100)}%`, monospace: true, color: ACCENT });
    if (state.mode === "walk" && r.shipDistance < 60) W.label(id, { text: `Ship ${fmt(r.shipDistance, 1)} m away`, color: DIM, monospace: true });
    W.label(id, { text: state.message, wrap: true });
    if (state.mode === "ship" && !state.ship.autopilot) {
        W.horizontal(id, () => {
            PLANETS.forEach((p, i) => {
                if (i === nearestPlanet(state.ship.pos) && state.ship.landed) return;
                W.button(id, { id: `qp-fly-${p.id}`, text: Icons.label("rocket-launch", `Fly to ${p.name}`), onClick: () => { startAutopilot(state, i); } });
            });
        });
    }
    if (EARTH >= 0) {
        W.horizontal(id, () => {
            W.textInput(id, { id: "qp-place", label: "Earth", value: placeQuery, width: 250, onChange: v => { placeQuery = v; } });
            W.button(id, { id: "qp-go", text: Icons.label("magnifying-glass", state.mode === "ship" ? "Fly there" : "Go"), onClick: () => {
                try { goTo(resolvePlace(placeQuery), false); } catch (e) { state.message = (e as Error).message; }
            } });
        });
    }
    W.separator(id);
    W.horizontal(id, () => {
        W.checkbox(id, { id: "qp-lod-debug", label: "Color by level (L)", value: debugLod, onChange: v => { debugLod = !!v; } });
        W.checkbox(id, { id: "qp-outlines", label: "Outline chunks (O)", value: debugOutlines, onChange: v => { debugOutlines = !!v; } });
    });
    if (stats?.city && geo()) {
        const c = stats.city, h = houses?.lastStats;
        const making = h && h.queued ? `, ${h.queued} to build` : "";
        W.label(id, { text: `${Icons.get("buildings")} ${fmt(c.buildings)} buildings, ${fmt(c.houses)} houses (${h ? `${h.lod0} full, ${h.lod1} far` : "0"}${making})${c.pending ? `, ${c.pending} tiles loading` : ""}`, monospace: true, color: DIM, wrap: true });
    }
    if (stats) {
        const deep = PLANETS.map((p, i) => `${p.name} ${stats!.perPlanet[i]} @L${stats!.deepest[i]}/${planetInfo(i).maxLevel}`).join("  ");
        const streaming = stats.pending ? `, ${stats.pending} streaming${stats.waitingForData ? ` (${stats.waitingForData} awaiting elevation)` : ""}` : "";
        W.label(id, { text: `${Icons.get("stack")} ${stats.live} chunks (${stats.stitched} stitched), ${fmt(stats.triangles / 1000)}k tris${streaming}`, monospace: true, color: DIM });
        W.label(id, { text: deep, monospace: true, color: DIM, wrap: true });
    }
    W.label(id, { text: state.mode === "walk" ? "W/S walk  A/D turn  Shift run  Space jump  E board" : "W thrust  Shift boost  A/D yaw  arrows pitch  Space/C climb/sink  E exit  T autopilot", color: DIM, wrap: true });
    if (g) W.label(id, { text: "Elevation: Terrain Tiles (SRTM, GMTED, ETOPO1). Map data © OpenStreetMap contributors (OpenFreeMap).", color: DIM, wrap: true, fontSize: 11 });
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
    hudWindow = Entropy.UI.createWindow({ title: "QuadPlanet", width: 470, height: 360, x: 16, y: 16, decorations: false, glass: true, onRender: renderHud });
}

// --- Tools (MCP, and the live BDD run) -----------------------------------------------------------

type Args = Record<string, unknown>;

function snapshot() {
    const r = readout(state);
    refreshInfo();
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
        geo: geo(),
        walked: Math.round(state.walked * 100) / 100,
        visited: state.visited,
        time: Math.round(state.time * 1000) / 1000,
        frames: frameCount,
        message: state.message,
        walker: { position: round3(state.walker.pos), planet: PLANETS[state.walker.planet].name },
        ship: { position: round3(state.ship.pos) },
        camera: lastCamera ? { position: round3(lastCamera.position), target: round3(lastCamera.target), up: round3(lastCamera.up, 3) } : null,
        sun: round3(SUN_DIRECTION, 4),
        chunks: stats ? {
            live: stats.live, pending: stats.pending, waitingForData: stats.waitingForData, hidden: stats.hidden, triangles: stats.triangles,
            built: stats.built, destroyed: stats.destroyed, stitched: stats.stitched, balanced: stats.balanced, splitFactor: Math.round(stats.splitFactor * 1000) / 1000,
            planets: PLANETS.map((p, i) => ({
                name: p.name, chunks: stats!.perPlanet[i], deepestLevel: stats!.deepest[i], maxLevel: planetInfo(i).maxLevel,
                verticesPerLevel: planetInfo(i).verticesPerLevel, ...(planetInfo(i).elevation ? { elevation: planetInfo(i).elevation } : {}),
            })),
        } : null,
        city: stats?.city ? { ...stats.city, houses: houses?.lastStats ?? null, options: houses?.options ?? null } : null,
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

/** Puts the walker and a landed ship back on the (re-streamed) ground. */
function reground(): void {
    if (state.walker.grounded) {
        const p = PLANETS[state.walker.planet];
        state.walker.pos = surfacePoint(p, upAt(p, state.walker.pos));
    }
    if (state.ship.landed) {
        const p = PLANETS[state.ship.planet];
        state.ship.pos = surfacePoint(p, upAt(p, state.ship.pos));
    }
}

/** True while the city around you (tiles, then house meshes) is still being made. */
function cityBusy(s: QuadPlanetStreamStats): boolean {
    const c = s.city;
    if (!c || !geo()) return false;
    return c.pending > 0 || c.live + c.failed < c.wanted || (houses?.busy() ?? false);
}

/** Streams around the current focus until nothing is pending (elevation tiles, the city and its houses included). */
function settle(timeoutMs: number) {
    const started = Date.now();
    let s = streamOnce(Infinity, Infinity);
    updateHouses(Infinity);
    while ((s.pending > 0 || s.waitingForData > 0 || cityBusy(s)) && Date.now() - started < timeoutMs) {
        const wait = Date.now() + 20;
        while (Date.now() < wait) { /* tiles download, and house LODs simplify, on Rust threads meanwhile */ }
        s = streamOnce(Infinity, Infinity);
        updateHouses(Infinity);
    }
    writeWorld();
    return { settled: s.pending === 0 && !cityBusy(s), ms: Date.now() - started };
}

const TOOLS: { name: string; description: string; parameters: object; run: (a: Args) => object }[] = [
    {
        name: "quadplanet_state",
        description: "Where the walker and ship are: mode (walk/ship), planet, altitude, speed, autopilot progress, latitude/longitude and place name on Earth, and the terrain streamer's chunk counts per planet.",
        parameters: { type: "object", properties: {} },
        run: () => snapshot(),
    },
    {
        name: "quadplanet_planets",
        description: "The planets: name, center, radius, terrain (procedural or earth), deepest quadtree level, gravity.",
        parameters: { type: "object", properties: {} },
        run: () => ({ planets: PLANETS.map((p, i) => ({ id: p.id, name: p.name, center: p.center, radius: p.radius, terrain: planetInfo(i).terrain, maxLevel: planetInfo(i).maxLevel, gravity: p.gravity, sea: p.hasSea ? (p.frozenSea ? "ice" : "water") : "none" })) }),
    },
    {
        name: "quadplanet_config",
        description: "Configure timing, debug display, exposure, chunk interiors and level of detail. chunkDetail: {mode:'half',leafVertices:64,levels:8} or {mode:'explicit',verticesPerLevel:[64,32,16,8]}. Lists run leaf to root; borders keep the existing grid and stitching. planet optionally limits the change to one planet; null chunkDetail restores defaults. triangleBudget caps triangles drawn across all planets (default 2,000,000).",
        parameters: { type: "object", properties: {
            fixedStep: { type: ["number", "null"] }, debugLod: { type: "boolean" }, debugOutlines: { type: "boolean" }, exposure: { type: "number" },
            planet: { type: "string" },
            chunkDetail: { type: ["object", "null"], properties: {
                mode: { type: "string", enum: ["half", "explicit"] },
                leafVertices: { type: "integer", minimum: 3, maximum: 257 },
                levels: { type: "integer", minimum: 1, maximum: 21 },
                verticesPerLevel: { type: "array", minItems: 1, maxItems: 21, items: { type: "integer", minimum: 3, maximum: 257 } },
            } },
            splitFactor: { type: "number" }, triangleBudget: { type: "number" },
        } },
        run: a => {
            if ("chunkDetail" in a) {
                const value = a.chunkDetail;
                if (value !== null && (typeof value !== "object" || Array.isArray(value))) throw new Error("chunkDetail must be an object or null.");
                const planet = a.planet === undefined ? undefined : PLANETS[planetIndex(a.planet)].id;
                // Validated on the Rust side before anything changes.
                Entropy.QuadPlanet.configure(terrainId, { planet, chunkDetail: value as ChunkDetail | null });
                const targets = planet === undefined ? PLANETS : [PLANETS[planetIndex(planet)]];
                for (const p of targets) p.chunkDetail = value === null ? undefined : value as ChunkDetail;
                refreshInfo();
                reground();
            }
            if (typeof a.splitFactor === "number" || typeof a.triangleBudget === "number") {
                Entropy.QuadPlanet.configure(terrainId, {
                    ...(typeof a.splitFactor === "number" ? { splitFactor: a.splitFactor } : {}),
                    ...(typeof a.triangleBudget === "number" ? { triangleBudget: a.triangleBudget } : {}),
                });
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
        parameters: { type: "object", properties: { target: { type: "string", description: "Planet name: Verdant, Ember, Glacia or Earth" } }, required: ["target"] },
        run: a => {
            const plan = startAutopilot(state, planetIndex(a.target));
            if (!plan) throw new Error(state.message);
            return { duration: Math.round(plan.duration * 100) / 100, distance: Math.round(Math.hypot(plan.p3[0] - plan.p0[0], plan.p3[1] - plan.p0[1], plan.p3[2] - plan.p0[2])), ...snapshot() };
        },
    },
    {
        name: "quadplanet_goto",
        description: "Go to a real place on Earth: a name looked up on OpenStreetMap (\"Matterhorn\", \"Grand Canyon\", \"Reykjavik\"), or lat/lon in degrees. Aboard the ship the autopilot flies there; on foot, or with mode 'teleport', you are set down there with the ship beside you. The sun moves to mid-morning over the place unless keepSun.",
        parameters: { type: "object", properties: {
            place: { type: "string" }, lat: { type: "number" }, lon: { type: "number" },
            mode: { type: "string", enum: ["fly", "teleport"] }, keepSun: { type: "boolean" },
        } },
        run: a => {
            const target = typeof a.place === "string" && a.place.trim()
                ? resolvePlace(a.place)
                : typeof a.lat === "number" && typeof a.lon === "number" ? { name: `${a.lat}, ${a.lon}`, lat: a.lat, lon: a.lon } : null;
            if (!target) throw new Error("Give a place name, or lat and lon.");
            const result = goTo(target, a.mode === "teleport" || (a.mode !== "fly" && state.mode === "walk"), a.keepSun === true);
            return { target, ...result, ...snapshot() };
        },
    },
    {
        name: "quadplanet_settle",
        description: "Streams terrain until everything wanted around the camera is built, waiting for elevation tiles to download (up to timeoutMs, default 60000). For reproducible captures.",
        parameters: { type: "object", properties: { timeoutMs: { type: "number" } } },
        run: a => ({ ...settle(typeof a.timeoutMs === "number" ? a.timeoutMs : 60000), ...snapshot() }),
    },
    {
        name: "quadplanet_city",
        description: "Earth's OpenStreetMap city around you: tiles, buildings, houses drawn as Mesha models (full with interiors near you, simplified farther out), the house mesh cache. Optionally set lod0Radius / maxLod0 (full houses), lod1Radius (simplified houses), triangleBudget, or clearHouseCache to rebuild every house mesh. nearest lists the closest buildings.",
        parameters: { type: "object", properties: {
            lod0Radius: { type: "number" }, maxLod0: { type: "integer" }, lod1Radius: { type: "number" }, triangleBudget: { type: "number" },
            clearHouseCache: { type: "boolean" }, nearest: { type: "integer", description: "How many of the nearest buildings to list (default 5)" },
        } },
        run: a => {
            if (!houses) throw new Error("The terrain isn't ready.");
            const opts: Partial<CityOptions> = {};
            for (const k of ["lod0Radius", "maxLod0", "lod1Radius", "triangleBudget"] as const) if (typeof a[k] === "number") opts[k] = Math.max(0, a[k] as number);
            Object.assign(houses.options, opts);
            if (a.clearHouseCache === true) { houses.clear(); Entropy.MeshCache.clear(HOUSE_NAMESPACE); houses = makeHouses(houses.options); }
            const pos = lastCamera?.position ?? state.walker.pos;
            const nearest = Entropy.QuadPlanet.buildings(terrainId, pos, 2000, { limit: typeof a.nearest === "number" ? a.nearest : 5 })
                .map(b => ({ key: b.key, kind: b.kind, distance: Math.round(b.distance * 10) / 10, width: Math.round(b.width * 10) / 10, depth: Math.round(b.depth * 10) / 10, height: b.height, lat: Math.round(b.lat * 1e6) / 1e6, lon: Math.round(b.lon * 1e6) / 1e6 }));
            return { info: refreshInfo().city, houses: houses.lastStats, options: houses.options, meshCache: Entropy.MeshCache.stats(HOUSE_NAMESPACE), nearest, ...snapshot() };
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

/** What the camera looks at this frame; the terrain streams around it. */
let focus: Vec3 = [0, 0, 0];

function streamOnce(maxBuilds: number, maxMs: number): QuadPlanetStreamStats {
    stats = Entropy.QuadPlanet.update(terrainId, focus, { renderOrigin, maxBuilds, maxMs });
    return stats;
}

/** The houses, drawn through Entropy: instanced batches of mesh-cache meshes, one draw per house mesh. */
function makeHouses(options?: Partial<CityOptions>): CityHouses {
    return new CityHouses({
        buildings: (position, radius, limit) => Entropy.QuadPlanet.buildings(terrainId, position, radius, { kind: "house", limit }) as CityBuilding[],
        status: (ns, key) => Entropy.MeshCache.status(ns, key),
        put: (ns, key, mesh, options) => Entropy.MeshCache.put(ns, key, mesh, options),
        info: (ns, key) => Entropy.MeshCache.info(ns, key),
        instances: meshCacheInstances(HOUSE_NAMESPACE, () => housePipelineId, () => worldBuffer),
        // Mesha evaluations run in a worker isolate (Entropy.Worker); without the bundle they fail
        // and CityHouses evaluates here instead.
        generateInBackground: job => { try { return Entropy.Worker.start(HOUSE_WORKER_SCRIPT, job); } catch { return null; } },
        pollBackground: id => Entropy.Worker.poll(id).status,
        now: () => Date.now(),
    }, options);
}

/** Houses around the camera on Earth, building at most `buildMs` of new house meshes. */
function updateHouses(buildMs: number): void {
    if (!houses) return;
    const c = stats?.city;
    if (!c || !geo()) {
        if (hideRadius > 0 || houses.lastStats.lod0 + houses.lastStats.lod1 > 0) houses.clear();
        hideRadius = 0;
        return;
    }
    const camera = lastCamera?.position ?? focus;
    hideRadius = houses.update(camera, renderOrigin, c.live * 1_000_003 + c.buildings, buildMs);
}

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
    housePipelineId = Entropy.Pipeline.create({
        name: "QuadPlanet Houses", layout: "mesh", pbr: false,
        vertexShader: QUADPLANET_INSTANCED_SHADER, fragmentShader: QUADPLANET_INSTANCED_SHADER,
        extraBindGroups: INSTANCED_BIND_GROUPS,
    });
    skyItem = uniformBuffer(ITEM_FLOATS);
    shipItem = uniformBuffer(ITEM_FLOATS);
    bodyItem = uniformBuffer(ITEM_FLOATS);
    legItems = [uniformBuffer(ITEM_FLOATS), uniformBuffer(ITEM_FLOATS)];
    writeItem(skyItem, identity4(), [1, 1, 1, 0]);

    // The terrain: every planet's quadtrees, streamed and meshed on the Rust side into our
    // pipeline, each chunk bound to the world uniform and a uniform of its own.
    terrainId = Entropy.QuadPlanet.create({
        id: "quadplanet", planets: PLANETS, defaultChunkDetail: DEFAULT_CHUNK_DETAIL, pipelineId, worldBufferId: worldBuffer,
        // Earth's OpenStreetMap buildings: those our house model fits come back as houses.
        city: { house: houseRule() },
    });
    useEngineTerrain();
    try { Entropy.MeshCache.prune(HOUSE_NAMESPACE, HOUSE_CACHE_BYTES); } catch (e) { Entropy.println(`[quadplanet] house cache: ${(e as Error).message}`); }
    houses = makeHouses();
    refreshInfo();
    state = initialState();
    writeWorld();

    spawn("qp-sky", buildSky(), skyItem);
    spawn("qp-ship", buildShip(), shipItem);
    spawn("qp-walker", buildWalkerBody(), bodyItem);
    const leg = buildWalkerLeg();
    spawn("qp-leg-left", leg, legItems[0]);
    spawn("qp-leg-right", leg, legItems[1]);
    updateModels();

    Entropy.setGameMode(false);
    Entropy.Lighting.updateSun({ horizonColor: [0, 0, 0], zenithColor: [0, 0, 0], sunDirection: SUN_DIRECTION, sunColor: [1, 0.96, 0.9], sunIntensity: 0.2 });
    setupUI();
    setupInput();
    registerTools();
    Entropy.println("[quadplanet] initialized");
});

addon.onUpdatePlus("Global", () => {
    if (!terrainId) return;
    const now = Date.now();
    const real = lastFrameMs ? Math.min(0.1, Math.max(0, (now - lastFrameMs) / 1000)) : 1 / 60;
    lastFrameMs = now;
    const dt = fixedStep ?? real;
    frameCount++;

    step(state, readInput(), dt);

    let pose = cameraPose(state);
    if (viewOverride) pose = viewOverride.planet < 0 ? overheadPose(state, viewOverride.distance) : orbitPose(viewOverride.planet, PLANETS, viewOverride.distance);
    // Keep the view direction off the up axis (look_at can't use a parallel up).
    const look = normalize([pose.target[0] - pose.position[0], pose.target[1] - pose.position[1], pose.target[2] - pose.position[2]] as Vec3);
    let up = pose.up;
    if (Math.abs(dot(look, up)) > 0.98) up = normalize(cross(cross(look, up), look));
    // Everything this frame is placed relative to the same origin: chunks, models, planets and
    // the camera (the engine applies a camera set here to this same frame).
    followWithOrigin(pose.position);
    Entropy.Camera.setTransform(toRender(pose.position), toRender(pose.target), up);
    lastCamera = { ...pose, up };

    updateModels();
    // Stream around the camera (what is being looked at), a bounded amount per frame - except in
    // the overhead view, which is there to show the detail centered on you. A fixed-step run
    // wants the same frames on any machine, so it streams everything it wants every frame
    // instead of whatever fits in the time budget.
    focus = viewOverride && viewOverride.planet < 0 ? (state.mode === "walk" ? state.walker.pos : state.ship.pos) : pose.position;
    if (fixedStep) streamOnce(Infinity, Infinity);
    else streamOnce(10, 12);
    // Houses (after the city has streamed, so they see its newest tiles; before the World
    // uniform, which carries the radius their boxes hide within).
    updateHouses(fixedStep ? Infinity : 12);
    writeWorld();

    // On Earth, name the place you're at (OpenStreetMap, looked up in the background).
    if (frameCount % 30 === 0) {
        const g = geo();
        if (g) placeName = Entropy.QuadPlanet.placeName(terrainId, g.lat, g.lon) ?? placeName;
        // Elevation download counts for the tools.
        if (frameCount % 120 === 0) refreshInfo();
    }
});
