import { Controller } from "./al_controller";
import { newLook, addMouse, stepLook, stepAds, adsFov, pickAssistTarget, assistFriction, assistPull, bendAngle, adsSpread, adsMove, type AssistPick } from "./al_aim";
import { parkBeside, newCar, stepCar, landingClear, landingSpot, roofUnder, carGround, carFloor, carSpec, callCar, stepCall, callEta, openSky, steerAutopilot, autopilotWarp, ROOF_FILL, type FlyingCar, type Autopilot } from "./al_vehicle";
import { useItem, quickHealItem, shopForBuilding, shopStock, buyStock, sellItem, houseLoot, isLooted, takeHouseLoot, SHOP_NAMES, type ShopKind, type LootCache } from "./al_items";
import { compoundsNear, compoundLayout, compoundToLocal, findClearSite, stepCapture, defenderDown, FLAG_REACH, GUARDS_AT_ONCE, type CompoundLayout } from "./al_military";
import { startFoundingMission, updateMission, missionCompound, completeMission } from "./al_mission";
import { houseAtDoor, entryPoint, exitPoint, clampInside, atDoorInside, spotInside, doorSide } from "./al_interior";
import { cameraBasis, calibrate, project, skyMarkers, distanceLabel, miniMapRuns, toMapCell, type CameraBasis, type ScreenMarker, type SkyMarker, type MiniMap } from "./al_markers";
import { FoliageMeshes, cacheProps, scatterAround, lawnAround, RoadMask, roadSegments, scatterMesh, batchKey, meshOfBatch, tileOf, shadowClass, familyOfMesh, propKey, PROPS, SCATTER_NAMESPACE, SHOP_TINT, type ScatterItem, type ShadowClass } from "./al_scatter";
import { InstanceBatches } from "../../apps/quadplanet/qp_instances";
import { housingUnits, trafficCount, trafficPose, TRAFFIC_LIMIT } from "./al_traffic";
import { COBRA_SPEC, COBRA_HULL, COBRA_CELLS, MISSILE_RADIUS, MISSILE_DAMAGE, MISSILE_BUILDING_DAMAGE, newCobraState, chargeCobra, cobraSpot, fireMissile, stepMissiles,
    shiftMissiles, aimPoint, restoreCobras, type CobraState, type Missile, type Impact } from "./al_cobra";
import { CONVOY_SEATS, CONVOY_MAX, convoySize, convoyCar, escortSlot, stepEscort, type ConvoyCar } from "./al_convoy";
import { newFx, explode, dustCloud, ignite, stepFx, particleOpacity, particleGlow, fireDamageAt, shiftFx, clearFx, missileTrail, type FxState } from "./al_fx";
import { Damage, shellPieces, breakApart, rubblePile, debris, stepPieces, pieceAxes, buildingLook, addRuin, rebuildRuins, isMilitary, type Piece } from "./al_destruction";
// ALLEGIANCE - a political conquest game on the full-scale Earth of 2100.
//
// Make speeches, hand out pamphlets, recruit party members, build a chain of command, scheme,
// arm your followers, and take the planet region by region - by election, coup or war - as a
// liberator or a tyrant.
//
// The world is QuadPlanet's real Earth (Entropy.QuadPlanet: SRTM-derived elevation, OpenStreetMap
// buildings and roads, Mesha houses; apps/quadplanet/). On top of it:
// - al_world / al_party / al_state: the strategic campaign (113 regions tiling the planet, the
//   rival factions, money, hierarchy, elections, coups, wars) as plain data;
// - al_street / al_nav: the people around you, walking real streets on A* paths;
// - al_speech: the speech mini-game; al_player: you on foot;
// - al_screens / al_ui: every screen, drawn with Entropy.UI.drawRect/drawText only;
// - al_models / al_shader: animated people injected into QuadPlanet's shader.
// This file wires them to the engine: terrain streaming, the loading screen, rendering, input,
// the day clock, saving, and the MCP tools the live test drives.

import { type Vec3, add, cross, dot, frameMatrix, identity4, makeFrame, normalize, scale, sub, distance, length } from "../../apps/quadplanet/qp_math";
import {
    PLANETS, isEarth, latLonToDir, dirToLatLon, setTerrainBackend, setSunDirection, SUN_DIRECTION, morningSunAt, type PlanetDef,
} from "../../apps/quadplanet/qp_planet";
import { ITEM_FLOATS, WORLD_FLOATS, MAX_PLANETS, packWorld } from "../../apps/quadplanet/qp_shader";
import { createCloudCache, cloudBindings, CLOUD_BIND_ENTRIES, CLOUD_CACHE_BYTES } from "./al_clouds";
import { CityHouses, HOUSE_NAMESPACE, houseRule, houseValues, type CityBuilding } from "../../apps/quadplanet/qp_city";
import { BUILDING_MODEL, BUILDING_NAMESPACE, buildingValues } from "../../apps/quadplanet/qp_buildings";
import { ALLEGIANCE_SHADER, ALLEGIANCE_TERRAIN_SHADER, ALLEGIANCE_INSTANCED_SHADER, PEOPLE_SHADER } from "./al_shader";
import { TERRITORY_FLOATS, TERRITORY_BIND_ENTRIES, territoryBindings, territoryStrength, borderWidth, packTerritories, type TerritorySpot } from "./al_territory";
import { loadMaterials, materialBindings, MATERIAL_BIND_ENTRIES } from "./al_materials";
import { shadowCascades, weatherAt, cloudOffset, windVector, CLOUD_WIND_FACTOR, SHADOW_MAP_SIZE, SHADOW_RADII, type Weather } from "./al_sky";
import { meshCacheInstances, INSTANCED_BIND_GROUPS, HOUSE_WORKER_SCRIPT } from "../../apps/quadplanet/qp_instances";
import { PeopleMeshes, PEOPLE_NAMESPACE, personLod, budgetLods, DEFAULT_PEOPLE_BUDGET, PERSON_TRIANGLES, type PersonLod, type PeopleBudget } from "./al_people";
import { CrowdBatches, maybeVisible } from "./al_crowd";
import { buildFlyingCar, buildCobra, buildPodium, buildFlag, buildTracer, buildSky, buildViewWeapon, type ModelMesh, type PersonLook } from "./al_models";
import {
    PARTY, PARTY_COLORS, REGIONS, RIVALS, IDEOLOGIES, blocById, regionDefById, weaponById, armorById, pamphletById, factionById,
} from "./al_data";
import { campaignRegions, discoverSettlement, restoreSettlements, migrateCampaign, type Campaign, type CompoundState, type RegionState, newCampaign, regionAt, partyShare, shiftSupport, pushNews, addKarma, angularDistance, EARTH_RADIUS_KM, SAVE_VERSION } from "./al_state";
import {
    advanceDay, applySpeech, applyRivalSpeech, applyPamphlet, reportFieldBattle, travel, moveHq, playerDied, callElection, attemptCoup,
    declareWar, proposePeace, suspendElections, setTaxRate, DAY_SECONDS, governedShare, worldSupport, takeRegion, defenseRatio,
} from "./al_world";
import {
    appoint, autoOrganize, armMembers, disarm, moveArmy, buyWeapon, buyAmmo, buyArmor, buyPamphlets, buyFacility, raiseSkill,
    startScheme, recruitInPerson, setFollower, followers, skill, maxHealth, hasFacility, orgReport, gainXp, setArmed, regionFighters,
    dispatchTroops, troopsAvailable,
} from "./al_party";
import { startSpeech, stepSpeech, chooseCard, deliver, rebutHeckler, autoplay, bestCard, type SpeechState, type Grade } from "./al_speech";
import {
    type StreetState, type Actor, type StreetContext, newStreet, stepStreet, startCrowd, setCrowdTarget, endCrowd, convertListeners,
    nearestActor, persuade, tryRecruit, recruitChance, givePamphlet, playerShoot, castShot, shiftStreet, resetStreet, spawnSquad,
    listeners, soldiers, endRally, actorById, alive, opinionLabel, takeLoot, spawnOrator, spawnGuards, guardsOf, blastStreet, burnStreet, alarm,
    orderComrades, CIVILIAN_TARGET,
} from "./al_street";
import { NavGrid, NAV_SIZE, NAV_CELL, makeLocalFrame, toLocal, toWorld, dirToWorld, dirToLocal, buildingToRect, insideRect, type LocalFrame, type Rect } from "./al_nav";
import { type PlayerBody, type PlayerInput, NO_PLAYER_INPUT, newBody, stepBody, bodyCamera, EYE } from "./al_player";
import { enginePainter, THEME, type DrawApi } from "./al_ui";
import {
    type GameView, type Mode, type ConsoleTab, type SetupState, type LoadingInfo, type DialogueState, type LandRuns, UiFrame, drawScreen,
    LOADING_TIPS, MAP_LAT_TOP, MAP_LAT_BOTTOM,
} from "./al_screens";
import { makeRng, hashString, type Rng } from "./al_rng";

const addon = Entropy.AddonAtom.register({
    name: "Allegiance",
    version: "0.1.0",
    description: "Speak, organize and conquer the full-scale Earth of 2100",
    author: ["Entropy Team", "Claude"],
    capabilities: { graphics: true, ui: true },
});

// --- The planet ----------------------------------------------------------------------------------

/** Earth alone, centered at the origin (QuadPlanet's Earth definition otherwise unchanged). */
const EARTH: PlanetDef = { ...PLANETS.find(isEarth)!, center: [0, 0, 0] };
const WORLD_PLANETS = [EARTH];

let pipelineId = "";
let terrainPipelineId = "";
let peoplePipelineId = "";
// The sky (al_sky.ts): sun shadows, the day's weather, how far the clouds have drifted (world
// meters) and the cloud layer's height above sea level.
let shadowsEnabled = true;
/** Cascades drawn (1-4, nearest first) and their resolution: graphics settings (allegiance_config). */
let shadowCascadeCount = SHADOW_RADII.length;
let shadowMapSize = SHADOW_MAP_SIZE;
let shadowsLive = false;
let weather: Weather = { cloudCover: 0.35, windSpeed: 3, windHeading: 0.6 };
let cloudDrift: Vec3 = [0, 0, 0];
let cloudAltitude = 2700;
/** Weather fixed by allegiance_config (tests, captures); null follows the day. */
let weatherHold: Weather | null = null;
let housePipelineId = "";
/** Set dressing that casts only into the nearest cascades (al_scatter.ts shadowClass): the houses'
 * shader and bindings, fewer shadow draws. */
const scatterPipelineIds: Record<ShadowClass, string> = { tall: "", small: "", ground: "" };
/** Material maps that fell back to a checkerboard or neutral value ("set/map"). */
let materialsMissing: string[] = [];
let worldBuffer = "";
let skyItem = "";
let terrainId = "";
let stats: QuadPlanetStreamStats | null = null;
let houses: CityHouses | null = null;
let hideRadius = 0;
/** Mesha city buildings on the map's other (non-house) footprints (qp_buildings.ts). */
let buildings: CityHouses | null = null;
let buildingHideRadius = 0;
let renderOrigin: Vec3 = [0, 0, 0];
const REBASE = 2048;
const ROAD_DISTANCE = 2500;

const toRender = (p: Vec3): Vec3 => sub(p, renderOrigin);
const uniform = (floats: number) => Entropy.Buffer.create({ size: floats * 4, usage: "Uniform" });
let people: PeopleMeshes;
const bindings = (item: string) => [
    { group: 2, binding: 0, resource: { type: "Buffer" as const, value: { id: worldBuffer } } },
    { group: 2, binding: 1, resource: { type: "Buffer" as const, value: { id: item } } },
    ...materialBindings(),
    ...cloudBindings(cloudTexture),
];
let cloudTexture = "";
let cloudCacheEnabled = true;
const sharedMaterialBindings = () => [...materialBindings(), ...cloudBindings(cloudTexture)];
const HIDDEN = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];

/** One Item's floats, reused: Buffer.write copies them out before returning. */
const itemScratch = new Float32Array(ITEM_FLOATS);
const NO_EXTRA = [0, 0, 0, 0];
function writeItem(item: string, matrix: readonly number[], tint: readonly number[], extra: readonly number[] = NO_EXTRA): void {
    const d = itemScratch;
    for (let i = 0; i < 16; i++) d[i] = matrix[i];
    d[16] = tint[0]; d[17] = tint[1]; d[18] = tint[2]; d[19] = tint[3];
    d[20] = extra[0]; d[21] = extra[1]; d[22] = extra[2]; d[23] = extra[3];
    Entropy.Buffer.write(item, d);
}

function spawnMesh(id: string, mesh: ModelMesh, item: string): void {
    Entropy.Model.createMesh({ id, position: [0, 0, 0], vertexData: mesh.vertexData, indexData: mesh.indexData, pipelineId, bindings: bindings(item) });
}

function sampleEarth(d: Vec3) {
    return Entropy.QuadPlanet.sample(terrainId, EARTH.id, d);
}

// --- Game state ----------------------------------------------------------------------------------

let mode: Mode = "title";
let tab: ConsoleTab = "overview";
let campaign: Campaign | null = null;
const setup: SetupState = { party: "", leader: "", ideology: "solidarity", color: 0, spawn: null, focus: null };
const loading: LoadingInfo = { progress: 0, stage: "", lines: [], tip: LOADING_TIPS[0], place: "", elapsed: 0 };
let loadState: { started: number; peakPending: number; peakQueued: number; navBuilt: boolean; settledFrames: number } | null = null;
let speech: SpeechState | null = null;
let dialogue: DialogueState | null = null;
let toasts: { text: string; age: number; kind: "good" | "bad" | "info" }[] = [];
let selectedRegion: string | null = null;
let selectedMember: number | null = null;
let memberPage = 0;
let land: LandRuns | null = null;
let hasSave = false;
let time = 0;
let fixedStep: number | null = null;
let lastMs = 0;
let frameCount = 0;
let pamphletType = "propaganda";

let frame: LocalFrame | null = null;
let nav: NavGrid | null = null;
let navBuildings = -1;
let navTimer = 0;
let region: string | null = null;
let street: StreetState = newStreet();
let body: PlayerBody = newBody();
let rng: Rng = makeRng(1);
let lastCamera: { position: Vec3; target: Vec3; up: Vec3 } | null = null;
let focus: Vec3 = [0, 0, EARTH.radius];

/** Weapon state on the street: rounds in each magazine, the reload, the trigger. */
const mags: Record<string, number> = {};
let reloadLeft = 0;
let fireCooldown = 0;
let triggerHeld = false;
let triggerFresh = false;
let aimHold = 0;
let lookDrag: [number, number] | null = null;
let lookButtonDown = false;
/** Turning (smoothed), aiming down sights, and the soldier aim assist is on (al_aim.ts). */
const aim = newLook();
let adsButton = false;
let assistPick: AssistPick | null = null;
let fovSet = 0;
/** Aim assist strength and look sensitivity (settings, kept with the campaign). */
function controls(): { aimAssist: number; lookSensitivity: number } {
    const k = campaign?.player.controls;
    return { aimAssist: k?.aimAssist ?? 0.5, lookSensitivity: k?.lookSensitivity ?? 1 };
}

// --- Terrain queries in the local frame ----------------------------------------------------------

const heightCache = new Map<number, number>();
let heightCacheAge = 0;
/** Bumped whenever heightCache is emptied: anything placed on the ground re-reads its height. */
let heightGeneration = 0;
let wasWaitingForData = false;
function clearHeights(): void { heightCache.clear(); heightGeneration++; }

/** Ground height (local y) at local (x, z), sampled from the same terrain the chunks are built from. */
function heightAt(x: number, z: number): number {
    if (!frame) return 0;
    const qx = Math.round(x), qz = Math.round(z);
    const key = (qx + 50000) * 100003 + (qz + 50000);
    const hit = heightCache.get(key);
    if (hit !== undefined) return hit;
    const w = toWorld(frame, qx, 0, qz);
    const d = normalize(w);
    const s = sampleEarth(d);
    const p = scale(d, EARTH.radius + s.surface);
    const y = dot(sub(p, frame.origin), frame.up);
    heightCache.set(key, y);
    return y;
}

/** Open water on a 4 m grid, kept with the heights (the nav grid asks thousands of times a build). */
const seaCache = new Map<number, boolean>();
let seaGeneration = -1;
function isSea(x: number, z: number): boolean {
    if (!frame) return false;
    if (seaGeneration !== heightGeneration) { seaCache.clear(); seaGeneration = heightGeneration; }
    const qx = Math.round(x / 4), qz = Math.round(z / 4);
    const key = (qx + 50000) * 100003 + (qz + 50000);
    const hit = seaCache.get(key);
    if (hit !== undefined) return hit;
    const s = sampleEarth(normalize(toWorld(frame, qx * 4, 0, qz * 4)));
    const sea = s.sea && s.terrain < -0.5;
    seaCache.set(key, sea);
    return sea;
}

function surfaceAt(lat: number, lon: number): Vec3 {
    const d = latLonToDir(lat, lon);
    return scale(d, EARTH.radius + sampleEarth(d).surface);
}

// --- Messages ------------------------------------------------------------------------------------

function toast(text: string, kind: "good" | "bad" | "info" = "info"): void {
    // The same news again (several buildings falling at once): one toast, kept up longer.
    const same = toasts.find(t => t.text === text);
    if (same) { same.age = 0; return; }
    toasts.unshift({ text, age: 0, kind });
    if (toasts.length > 5) toasts.length = 5;
}

// --- The world map's land ------------------------------------------------------------------------

function computeLand(): LandRuns {
    const cols = 96, rows = 44;
    const runs: [number, number, number][] = [];
    for (let j = 0; j < rows; j++) {
        const lat = MAP_LAT_TOP - (j + 0.5) / rows * (MAP_LAT_TOP - MAP_LAT_BOTTOM);
        let start = -1;
        for (let i = 0; i <= cols; i++) {
            const lon = -180 + (i + 0.5) / cols * 360;
            const isLand = i < cols && !sampleEarth(latLonToDir(lat, lon)).sea;
            if (isLand && start < 0) start = i;
            if (!isLand && start >= 0) { runs.push([j, start, i - 1]); start = -1; }
        }
    }
    return { cols, rows, runs };
}

// --- Saving --------------------------------------------------------------------------------------

const SAVE_PATH = "campaign.json";

function save(): boolean {
    if (!campaign) return false;
    saveCar();
    try {
        addon.IO.store.write(SAVE_PATH, JSON.stringify(campaign));
        hasSave = true;
        return true;
    } catch (e) {
        Entropy.println(`[allegiance] save failed: ${(e as Error).message}`);
        return false;
    }
}

function loadSave(): Campaign | null {
    try {
        const text = addon.IO.store.read(SAVE_PATH);
        if (!text) return null;
        const c = JSON.parse(text) as Campaign;
        return c.version === SAVE_VERSION ? migrateCampaign(restoreSettlements(c)) : null;
    } catch {
        return null;
    }
}

// --- Loading a place -----------------------------------------------------------------------------

/** Starts loading the place at lat/lon: terrain, the city, its houses, then the street. */
function startLoading(lat: number, lon: number): void {
    const def = regionAt(lat, lon, campaign);
    region = def.id;
    mode = "loading";
    settlementPage = 0;
    speech = null;
    dialogue = null;
    resetStreet(street);
    nav = null;
    navBuildings = -1;
    clearHeights();
    const dir = latLonToDir(lat, lon);
    setSunDirection(morningSunAt(dir));
    const origin = surfaceAt(lat, lon);
    frame = makeLocalFrame(origin);
    renderOrigin = [Math.round(origin[0]), Math.round(origin[1]), Math.round(origin[2])];
    controller.reset(); trafficSampleTime = -Infinity; trafficUnits = 0; trafficRoof = -Infinity;
    playerCar = null;
    convoy = [];
    cobra = null; cobraState = null; missiles = []; pieces = []; ruinRects = []; clearFx(fx); damage.taken.clear();
    blownProps.clear(); scatterBurnReset();
    indoors = null; shopState = null; placedCompounds = []; compoundSig = ""; captureView = null;
    scatterItems = []; scatterDirty = true; skyCache = []; miniMap = null; skyTimer = 99;
    const firstPerson = body.firstPerson;
    body = newBody(0, 0, 0);
    body.firstPerson = firstPerson;
    body.y = heightAt(0, 0);
    focus = toWorld(frame, 0, 2, 0);
    loading.place = `${def.name}, ${def.country}`;
    loading.progress = 0;
    loading.elapsed = 0;
    loading.tip = LOADING_TIPS[Math.floor(Math.random() * LOADING_TIPS.length)];
    loadState = { started: time, peakPending: 1, peakQueued: 1, navBuilt: false, settledFrames: 0 };
    rng = makeRng((campaign?.seed ?? 1) ^ (campaign?.day ?? 0) ^ Math.round(lat * 1000));
    if (houses) houses.clear();
    if (buildings) buildings.clear();
}

function loadingStep(): void {
    if (!loadState || !stats) return;
    loading.elapsed = time - loadState.started;
    const pending = stats.pending + stats.waitingForData;
    loadState.peakPending = Math.max(loadState.peakPending, pending);
    const terrain = pending === 0 ? 1 : Math.max(0, 1 - pending / loadState.peakPending);
    const c = stats.city;
    const city = c && c.wanted > 0 ? Math.min(1, (c.live + c.failed) / c.wanted) : (loading.elapsed > 6 ? 1 : 0);
    const queued = (houses?.lastStats.queued ?? 0) + (buildings?.lastStats.queued ?? 0);
    loadState.peakQueued = Math.max(loadState.peakQueued, queued);
    const house = houses?.busy() || buildings?.busy() ? Math.max(0, 1 - queued / loadState.peakQueued) : 1;
    const peopleReady = people.prepare() && (foliage?.prepare() ?? true);
    const p = 0.4 * terrain + 0.25 * city + 0.2 * house + (peopleReady ? 0.1 : 0) + (loadState.navBuilt ? 0.05 : 0);
    loading.progress = Math.max(loading.progress, Math.min(0.99, p));
    loading.stage = terrain < 1 ? "Surveying the terrain" : city < 1 ? "Mapping the streets" : house < 1 ? "Raising the houses and blocks" : !peopleReady ? "Preparing the people" : "Plotting the routes";
    loading.lines = [
        `Terrain: ${stats.live} chunks${pending ? `, ${pending} streaming${stats.waitingForData ? ` (${stats.waitingForData} awaiting elevation)` : ""}` : ", settled"}`,
        c ? `Streets: ${c.live}/${c.wanted} OpenStreetMap tiles, ${c.buildings.toLocaleString("en-US")} buildings${c.failed ? ` (${c.failed} unavailable)` : ""}` : "Streets: waiting for the map",
        `Houses: ${houses?.lastStats.lod0 ?? 0} full, ${houses?.lastStats.lod1 ?? 0} simplified; city blocks: ${buildings?.lastStats.lod0 ?? 0} full, ${buildings?.lastStats.lod1 ?? 0} simplified${queued ? `, ${queued} to build (cached after the first time)` : ""}`,
        peopleReady ? "People and plants: Mesha humans, trees and their distance LODs cached" : "People and plants: preparing Mesha humans, trees and distance LODs (cached after the first time)",
        loadState.navBuilt ? `Routes: ${nav?.rects.length ?? 0} buildings on the street map` : "Routes: pending",
    ];
    const settled = terrain >= 1 && (city >= 1 || loading.elapsed > 60) && (house >= 1 || loading.elapsed > 80);
    loadState.settledFrames = settled ? loadState.settledFrames + 1 : 0;
    if (peopleReady && ((loadState.settledFrames > 3 && loading.elapsed > 1.2) || loading.elapsed > 150)) finishLoading();
}

function finishLoading(): void {
    clearHeights();
    buildNav(0, 0);
    if (loadState) loadState.navBuilt = true;
    // Stand on a street near the city center.
    const spot = nav?.nearestWalkable(0, 0, 60) ?? [0, 0];
    body.x = spot[0];
    body.z = spot[1];
    body.y = heightAt(body.x, body.z);
    const savedCar = campaign?.player.flyingCar;
    let restoredCar = false;
    if (savedCar && frame) {
        const p = toLocal(frame, surfaceAt(savedCar.lat, savedCar.lon));
        if (Math.hypot(p[0] - body.x, p[2] - body.z) < 1000) {
            playerCar = newCar({ x: p[0], y: carGround(p[0], p[2], heightAt) + Math.max(0, savedCar.altitude ?? 0), z: p[2], yaw: savedCar.yaw });
            restoredCar = true;
        }
    }
    if (!playerCar) {
        const parked = parkBeside(body.x, body.z, (x, z) => nav?.walkable(x, z) ?? !isSea(x, z), heightAt);
        if (parked) {
            [body.x, body.z] = parked.player;
            body.y = heightAt(body.x, body.z);
            body.yaw = parked.car.yaw;
            playerCar = newCar(parked.car);
            const ll = dirToLatLon(toWorld(frame!, playerCar.x, playerCar.y, playerCar.z));
            if (campaign) campaign.player.flyingCar = { lat: ll.lat, lon: ll.lon, yaw: playerCar.yaw };
        }
    }
    if (playerCar && restoredCar && savedCar?.piloting) {
        playerCar.piloting = true;
        playerCar.state = (savedCar.altitude ?? 0) > 0.1 ? "hovering" : "parked";
        body.x = playerCar.x; body.z = playerCar.z; body.y = playerCar.y; body.yaw = playerCar.yaw;
    }
    if (playerCar) addCarObstacle();
    restoreCobra();
    updateExclusions();
    updateCompounds();
    computeScatter();
    if (campaign && !campaign.checkpoint) setCheckpointHere();
    street.player.x = body.x;
    street.player.z = body.z;
    loading.progress = 1;
    loadState = null;
    mode = "play";
    syncStreetPlayerFromCampaign();
    const def = region ? regionDefById(region) : null;
    if (def && campaign) toast(`You arrive in ${def.name}. ${partyShare(campaign.regions[def.id]) < 0.02 ? "Nobody knows your name - yet." : "Comrades are waiting."}`, "info");
}

/** Your Cobra from the save, if it stands near where you arrive (aboard, as you left it). */
function restoreCobra(): void {
    const sc = campaign?.player.cobra;
    if (!sc || !frame) return;
    const p = toLocal(frame, surfaceAt(sc.lat, sc.lon));
    if (Math.hypot(p[0] - body.x, p[2] - body.z) > 3000) return;
    cobra = newCar({ x: p[0], y: carGround(p[0], p[2], heightAt) + Math.max(0, sc.altitude), z: p[2], yaw: sc.yaw });
    cobraState = newCobraState(sc.home, sc.hull);
    if (sc.piloting && !playerCar?.piloting) {
        cobra.piloting = true;
        cobra.state = sc.altitude > 0.1 ? "hovering" : "parked";
        body.x = cobra.x; body.z = cobra.z; body.y = cobra.y; body.yaw = cobra.yaw;
    } else addCobraObstacle();
}

function scatterBurnReset(): void {
    scorchedProps.clear();
    burned = [];
    propShift = [0, 0];
}

/** Rasterizes the buildings and water around local (cx, cz) into a fresh nav grid. */
function buildNav(cx: number, cz: number): void {
    if (!frame) return;
    const g = new NavGrid(cx, cz, NAV_SIZE, NAV_CELL);
    const center = toWorld(frame, cx, 0, cz);
    const list = Entropy.QuadPlanet.buildings(terrainId, center, NAV_SIZE * NAV_CELL * 0.72, { limit: 6000 }) as CityBuilding[];
    buildingByKey = new Map(list.map(b => [b.key, b]));
    const ruins = campaign?.ruins ?? {};
    ruinRects = [];
    for (const b of list) {
        const r = buildingToRect(frame, b);
        // Compounds stand on cleared ground: map buildings inside their walls give way.
        if (inCompound(r.cx, r.cz, 2)) continue;
        if (ruins[r.key] !== undefined) { ruinRects.push(r); continue; }
        g.addRect(r);
    }
    for (const r of compoundRects()) {
        if (ruins[r.key] !== undefined) { ruinRects.push(r); continue; }
        g.addRect(r, 0.3);
    }
    g.markWhere((x, z) => isSea(x, z));
    nav = g;
    if (playerCar) addCarObstacle();
    if (cobra) addCobraObstacle();
    ensureRubble();
    navBuildings = stats?.city?.buildings ?? 0;
    shopsHere = [];
    for (const r of g.rects) {
        const kind = r.kind === "house" || r.key.startsWith("al-") ? null : shopForBuilding(r.key, r.kind ?? "box");
        if (!kind) continue;
        const side = Math.sign(-(r.door[0] - r.cx) * r.uz + (r.door[1] - r.cz) * r.ux) || 1;
        const u = Math.min(r.hw - 1.4, 2.8), v = side * (r.hd + 1.2);
        shopsHere.push({ rect: r, kind, x: r.cx + u * r.ux - v * r.uz, z: r.cz + u * r.uz + v * r.ux });
    }
    computeScatter();
    street.streetPoints = streetPointsFrom(g, scatterRoads);
    urbanTimer = 99;
}

function maintainNav(dt: number): void {
    if (!nav || !frame) return;
    navTimer += dt;
    const far = Math.hypot(body.x - nav.cx, body.z - nav.cz) > NAV_SIZE * NAV_CELL * 0.3;
    const grew = navTimer > 12 && (stats?.city?.buildings ?? 0) !== navBuildings;
    if (!far && !grew) return;
    navTimer = 0;
    // Far from the frame's origin: move the origin to you, so local numbers stay small.
    if (Math.hypot(body.x, body.z) > 2500) {
        const newOrigin = toWorld(frame, body.x, body.y, body.z);
        const carWorld = playerCar ? toWorld(frame, playerCar.x, playerCar.y, playerCar.z) : null;
        const cobraWorld = cobra ? toWorld(frame, cobra.x, cobra.y, cobra.z) : null;
        const dx = body.x, dz = body.z;
        frame = makeLocalFrame(newOrigin);
        if (playerCar && carWorld) [playerCar.x, playerCar.y, playerCar.z] = toLocal(frame, carWorld);
        if (playerCar?.call) { playerCar.call.x -= dx; playerCar.call.z -= dz; }
        if (cobra && cobraWorld) [cobra.x, cobra.y, cobra.z] = toLocal(frame, cobraWorld);
        for (const v of convoy) {
            v.car.x -= dx; v.car.z -= dz;
            if (v.car.call) { v.car.call.x -= dx; v.car.call.z -= dz; }
            if (v.car.landAt) { v.car.landAt.x -= dx; v.car.landAt.z -= dz; }
        }
        if (playerCar?.landAt) { playerCar.landAt.x -= dx; playerCar.landAt.z -= dz; }
        if (cobra?.landAt) { cobra.landAt.x -= dx; cobra.landAt.z -= dz; }
        shiftStreet(street, dx, dz);
        shiftFx(fx, dx, dz);
        shiftMissiles(missiles, dx, dz);
        for (const p of pieces) { p.x -= dx; p.z -= dz; }
        for (const b of burned) { b.x -= dx; b.z -= dz; }
        propShift = [propShift[0] + dx, propShift[1] + dz];
        if (indoors) {
            const r = indoors.rect;
            indoors.rect = { ...r, cx: r.cx - dx, cz: r.cz - dz, door: [r.door[0] - dx, r.door[1] - dz] };
            indoors.floor -= body.y;
        }
        body.x -= dx; body.z -= dz; body.y = indoors ? indoors.floor : 0;
        clearHeights();
    }
    buildNav(body.x, body.z);
}

// --- Campaign glue -------------------------------------------------------------------------------

function syncStreetPlayerFromCampaign(): void {
    if (!campaign) return;
    street.player.health = campaign.player.health;
    street.player.armor = campaign.player.armor;
    street.player.absorb = armorById(campaign.player.armorId).absorb;
    street.player.dead = false;
}

function here() { return campaign && region ? campaign.regions[region] : null; }

function streetContext(): StreetContext {
    const rs = here();
    const def = region ? regionDefById(region) : null;
    const rivals: Record<string, number> = {};
    for (const id of RIVALS) rivals[id] = rs?.support[id] ?? 0.1;
    const fl = campaign ? followers(campaign).map(m => ({ id: m.id, name: m.name, armed: m.armed, combat: m.combat })) : [];
    // In a war, the region's named soldiers fight beside you too.
    if (campaign && region && rs?.war) for (const m of regionFighters(campaign, region)) fl.push({ id: m.id, name: m.name, armed: true, combat: m.combat });
    return {
        partyShare: rs ? partyShare(rs) : 0,
        rivalShares: rivals,
        atWar: !!rs?.war,
        heat: rs && rs.governor !== PARTY ? rs.heat : 0,
        enemyQuality: def ? blocById(def.bloc).quality : 0.6,
        followers: fl,
        militia: rs?.war ? Math.min(4, Math.floor(rs.army / 25)) : 0,
        playerWeapon: campaign?.player.weapon ?? "fists",
        calm: mode === "loading" || mode === "console" || mode === "title" || mode === "setup" || mode === "shop",
        // No roaming squads right after a respawn, or on top of a compound assault.
        noSquads: respawnGrace > 0 || street.actors.some(a => a.post && a.alerted && alive(a)),
    };
}

function handleStreetEvents(): void {
    const c = campaign;
    if (!c || !region) return;
    const rs = c.regions[region];
    for (const e of street.events) {
        switch (e.kind) {
            case "kill":
                if (e.compound && c.compounds?.[e.compound]) defenderDown(c.compounds[e.compound]);
                if (e.by === "party") reportFieldBattle(c, region, 1, 0);
                break;
            case "follower-died": {
                const m = c.members.find(x => x.id === e.memberId);
                if (m) c.members.splice(c.members.indexOf(m), 1);
                rs.members = Math.max(0, rs.members - 1);
                reportFieldBattle(c, region, 0, 1);
                toast(`${e.name} has fallen.`, "bad");
                pushNews(c, `${e.name} died fighting in ${regionDefById(region)!.name}.`, "bad");
                break;
            }
            case "civilian-killed":
                if (e.byPlayer) {
                    addKarma(c, -8);
                    rs.support[PARTY] = Math.max(0, rs.support[PARTY] - 0.004);
                    rs.heat = Math.min(1, rs.heat + 0.1);
                    toast(`You killed ${e.name}, a civilian. The city will remember.`, "bad");
                }
                break;
            case "rival-speech":
                applyRivalSpeech(c, region, e.faction, Math.min(1, e.crowd / 12));
                toast(`${e.name} of ${factionById(e.faction).name} won over ${e.crowd} listeners.`, "bad");
                break;
            case "squad":
                toast(e.raid ? "The regime sends troops to break up the party!" : `Enemy squad incoming: ${e.count} soldiers!`, "bad");
                break;
            case "squad-defeated":
                toast("Squad defeated!", "good");
                gainXp(c, 40);
                break;
            case "player-hit":
                break;
        }
    }
    c.player.health = street.player.health;
    c.player.armor = street.player.armor;
    // Walk over a fallen soldier to take their weapon (or its ammunition).
    const loot = takeLoot(street, body.x, body.z);
    if (loot) {
        const w = weaponById(loot);
        if (!c.player.weapons.includes(loot)) {
            c.player.weapons.push(loot);
            c.player.ammo[loot] = (c.player.ammo[loot] ?? 0) + w.magazine;
            toast(`Picked up a ${w.name}. (number keys switch weapons)`, "good");
        } else {
            c.player.ammo[loot] = (c.player.ammo[loot] ?? 0) + w.magazine;
            toast(`Took ${w.magazine} rounds for the ${w.name}.`, "info");
        }
    }
    if (street.player.dead) respawn(playerDied(c, region));
}

function newDay(): void {
    if (!campaign) return;
    advanceDay(campaign, region);
    // Rebuilding: the regime's compounds two days on, the city's houses and blocks in a week; and
    // a compound that lost its Cobra gets a new one.
    if (campaign.ruins && rebuildRuins(campaign.ruins, campaign.day)) {
        updateExclusions();
        if (nav) buildNav(nav.cx, nav.cz);
    }
    if (campaign.compounds) restoreCobras(campaign.compounds, cobra ? cobraState?.home ?? null : campaign.player.cobra?.home ?? null);
    if (campaign.news[0]?.day === campaign.day) toast(campaign.news[0].text, campaign.news[0].kind === "good" ? "good" : campaign.news[0].kind === "info" ? "info" : "bad");
    const t = marchingThreat();
    if (t && t.threat.day === campaign.day + 1) toast(`INVASION INCOMING: ${regionDefById(t.id)!.name} at dawn. J sends half your troops.`, "bad");
    if (campaign.outcome) { mode = "outcome"; }
    save();
}

// --- Speeches ------------------------------------------------------------------------------------

function beginSpeech(rival: Actor | null = null): string | null {
    const c = campaign;
    if (!c || !region) return "No campaign.";
    if (driving()) return "Leave your car before giving a speech.";
    if (soldiers(street).some(s => Math.hypot(s.x - body.x, s.z - body.z) < 70)) return "Not with soldiers this close!";
    const nearby = street.actors.filter(a => a.kind === "civilian" && alive(a) && Math.hypot(a.x - body.x, a.z - body.z) < 40).length;
    const r = rng;
    speech = startSpeech({
        region, ideology: c.party.ideology, oratory: skill(c, "oratory"), persuasion: skill(c, "persuasion"),
        crowd: Math.max(4, Math.round(nearby * 0.6)), seed: Math.floor(r.next() * 1e9), heat: here()?.heat ?? 0,
        rival: rival ? { faction: rival.faction ?? "concordat", name: rival.name, skill: rival.charisma } : null,
    });
    startCrowd(street, body.x, body.z, speech.crowd);
    if (rival) endRally(street);
    mode = "speech";
    body.camDistance = 7.5;
    body.pitch = -0.32;
    return null;
}

function finishSpeech(): void {
    const c = campaign;
    const s = speech;
    if (!c || !s || !region) { speech = null; mode = "play"; return; }
    if (s.result) {
        const r = s.result;
        endCrowd(street, r.approval);
        const converted = convertListeners(street, r.joined);
        let named = 0;
        for (const a of converted) {
            if (a.charisma + a.admin + a.combat >= 17 && named < 2) {
                const m = recruitInPerson(c, region, { name: a.name, charisma: a.charisma, admin: a.admin, combat: a.combat });
                a.memberId = m.id;
                named++;
            }
        }
        const rivalHit = r.rival && r.rival.won ? { faction: r.rival.faction, amount: 0.002 + Math.max(0, r.rival.margin) * 0.01 } : undefined;
        const before = partyShare(c.regions[region]);
        applySpeech(c, region, { score: r.score, crowd: r.crowd, joined: Math.max(0, r.joined - named), karma: r.karma, rivalHit });
        if (r.rival && !r.rival.won) applyRivalSpeech(c, region, r.rival.faction, Math.min(1, -r.rival.margin + 0.3));
        const gain = partyShare(c.regions[region]) - before;
        toast(`Speech scored ${Math.round(r.score * 100)}: +${(gain * 100).toFixed(2)}% support, ${r.joined} joined.`, r.score >= 0.6 ? "good" : "info");
    } else {
        endCrowd(street, null);
    }
    speech = null;
    mode = "play";
    body.camDistance = 4.2;
    body.pitch = -0.12;
}

// --- Street interactions -------------------------------------------------------------------------

const REPLIES = {
    hostile: ["Get away from me, agitator.", "I've heard enough of your kind.", "The Concordat keeps us fed. What do you offer?"],
    neutral: ["Politics? I just want to get home.", "Maybe. What's in it for me?", "Everyone promises. Nobody delivers."],
    warm: ["You might be right, you know.", "My brother lost his job to the machines...", "Tell me more about this party."],
    devoted: ["Where do I sign?", "I've been waiting for someone like you.", "Count me in. When do we march?"],
    member: ["Ready when you are, comrade.", "For the party!", "Just say the word."],
};

function replyFor(a: Actor): string {
    const list = a.member ? REPLIES.member : a.opinion >= 0.6 ? REPLIES.devoted : a.opinion >= 0.2 ? REPLIES.warm : a.opinion > -0.3 ? REPLIES.neutral : REPLIES.hostile;
    return list[(a.id + Math.floor(time / 7)) % list.length];
}

function openDialogue(a: Actor): void {
    const c = campaign;
    if (!c) return;
    a.state = a.kind === "orator" ? a.state : "talk";
    a.stateTime = 0;
    dialogue = {
        actorId: a.id, name: a.name, segment: a.segment, opinion: a.opinion, lean: a.kind === "orator" ? a.faction ?? "concordat" : a.lean,
        member: a.member, follower: a.kind === "follower", orator: a.kind === "orator", reply: a.kind === "orator" ? `${factionById(a.faction ?? "concordat").motto} Join us, people of this city!` : replyFor(a),
        recruitChance: recruitChance(a, campaign ? skill(campaign, "persuasion") : 0), memberId: a.memberId,
    };
    mode = "dialogue";
}

function refreshDialogue(a: Actor, reply?: string): void {
    if (!dialogue || !campaign) return;
    dialogue.opinion = a.opinion;
    dialogue.member = a.member;
    dialogue.follower = a.kind === "follower";
    dialogue.memberId = a.memberId;
    dialogue.recruitChance = recruitChance(a, skill(campaign, "persuasion"));
    if (reply) dialogue.reply = reply;
}

function closeDialogue(): void {
    const a = dialogue ? actorById(street, dialogue.actorId) : undefined;
    if (a && a.state === "talk") { a.state = "idle"; a.stateTime = 0; }
    dialogue = null;
    if (mode === "dialogue") mode = "play";
}

function handPamphlet(a: Actor): string {
    const c = campaign;
    if (!c || !region) return "";
    const have = c.player.pamphlets[pamphletType] ?? 0;
    if (have <= 0) return `Out of ${pamphletById(pamphletType).name} pamphlets. Buy more in the Armory (TAB).`;
    const p = pamphletById(pamphletType);
    const delta = givePamphlet(a, p, skill(c, "persuasion"), hasFacility(c, "press"), rng);
    if (delta === null) return a.pamphletCooldown > 0 && a.opinion >= -0.6 ? `${a.name.split(" ")[0]} already has one.` : `${a.name.split(" ")[0]} tears it up in your face.`;
    c.player.pamphlets[pamphletType] = have - 1;
    applyPamphlet(c, region, delta, p.karma, p.rivalHit);
    return `${a.name.split(" ")[0]} takes "${p.name}". (${opinionLabel(a.opinion)})`;
}

function dialogueAction(id: string): void {
    const c = campaign;
    const a = dialogue ? actorById(street, dialogue.actorId) : undefined;
    if (!c || !a || !region || !dialogue) { closeDialogue(); return; }
    switch (id) {
        case "dlg-persuade": {
            if (a.talkCooldown > 0) { refreshDialogue(a, "We already talked. Give me some time to think."); break; }
            const r = persuade(a, skill(c, "persuasion"), rng);
            if (r.ok) shiftSupport(c.regions[region], PARTY, 0.00015 + r.delta * 0.0006);
            refreshDialogue(a, r.ok ? replyFor(a) : "I don't buy it.");
            gainXp(c, r.ok ? 4 : 1);
            break;
        }
        case "dlg-pamphlet": refreshDialogue(a, handPamphlet(a)); break;
        case "dlg-recruit": {
            if (tryRecruit(a, skill(c, "persuasion"), rng)) {
                const m = recruitInPerson(c, region, { name: a.name, charisma: a.charisma, admin: a.admin, combat: a.combat });
                a.memberId = m.id;
                shiftSupport(c.regions[region], PARTY, 0.0004);
                refreshDialogue(a, "I'm in. For the party!");
                toast(`${a.name} joins the party!`, "good");
            } else refreshDialogue(a, "Not today. Maybe not ever.");
            break;
        }
        case "dlg-follow": {
            if (a.memberId === null) break;
            const on = a.kind !== "follower";
            const err = setFollower(c, a.memberId, on);
            if (err) { refreshDialogue(a, err); break; }
            if (on) {
                const m = c.members.find(x => x.id === a.memberId);
                a.kind = "follower"; a.side = "party"; a.state = "follow";
                a.weapon = m?.armed ? (m.combat >= 7 ? "rifle" : "smg") : "fists";
                a.mag = weaponById(a.weapon).magazine;
                a.accuracy = 0.35 + (m?.combat ?? 5) * 0.045;
                refreshDialogue(a, "Lead the way.");
                closeDialogue();
            } else {
                a.kind = "civilian"; a.side = "neutral"; a.state = "idle";
                refreshDialogue(a, "I'll hold the fort here.");
            }
            break;
        }
        case "dlg-debate": closeDialogue(); { const err = beginSpeech(a); if (err) toast(err, "bad"); } break;
        case "dlg-leave": closeDialogue(); break;
    }
}

function interact(): void {
    if (driving() || (!indoors && playerCar && Math.hypot(playerCar.x - body.x, playerCar.z - body.z) < 6) || atStairsTo(playerCar) || cobraInReach()) { useCar(); return; }
    const near = nearbyAction();
    if (near) { near.run(); return; }
    if (indoors) { toast("Walk back to the front door to leave.", "info"); return; }
    const a = nearestActor(street, 3.4, x => x.kind !== "soldier");
    if (!a) { toast("No one close enough to talk to.", "info"); return; }
    openDialogue(a);
}

function quickPamphlet(): void {
    const a = nearestActor(street, 3.4, x => x.kind === "civilian");
    if (!a) { toast("Get closer to someone to hand them a pamphlet.", "info"); return; }
    toast(handPamphlet(a), "info");
}

// --- Weapons -------------------------------------------------------------------------------------

function weaponNow() { return weaponById(campaign?.player.weapon ?? "fists"); }

function magOf(id: string): number {
    const w = weaponById(id);
    if (!Number.isFinite(w.magazine)) return Infinity;
    if (mags[id] === undefined) {
        const reserve = campaign?.player.ammo[id] ?? 0;
        const load = Math.min(w.magazine, reserve);
        mags[id] = load;
        if (campaign) campaign.player.ammo[id] = reserve - load;
    }
    return mags[id];
}

function startReload(): void {
    const c = campaign;
    const w = weaponNow();
    if (!c || !Number.isFinite(w.magazine) || reloadLeft > 0) return;
    if (magOf(w.id) >= w.magazine || (c.player.ammo[w.id] ?? 0) <= 0) return;
    reloadLeft = w.reload;
}

function stepWeapon(dt: number): void {
    const c = campaign;
    if (!c) return;
    const w = weaponNow();
    fireCooldown = Math.max(0, fireCooldown - dt);
    aimHold = controller.held.has("LeftTrigger2") ? 0.2 : Math.max(0, aimHold - dt);
    if (reloadLeft > 0) {
        reloadLeft -= dt;
        if (reloadLeft <= 0) {
            const need = w.magazine - magOf(w.id);
            const take = Math.min(need, c.player.ammo[w.id] ?? 0);
            mags[w.id] += take;
            c.player.ammo[w.id] -= take;
        }
        return;
    }
    const wants = (triggerHeld || controller.held.has("RightTrigger2")) && (w.auto || triggerFresh);
    if (!wants || fireCooldown > 0 || mode !== "play") return;
    triggerFresh = false;
    if (magOf(w.id) <= 0) { startReload(); return; }
    fire(w.id);
}

function fire(weaponId: string, aimDir?: Vec3): void {
    const c = campaign;
    if (!c || !frame) return;
    const w = weaponById(weaponId);
    fireCooldown = 1 / w.rate;
    if (Number.isFinite(w.magazine)) mags[w.id] = magOf(w.id) - 1;
    aimHold = 1.2;
    const cam = bodyCamera(body, heightAt);
    // Aim where the crosshair (the camera's forward) meets something, then shoot there from your eyes.
    const eye: Vec3 = [body.x + Math.sin(body.yaw) * 0.3, body.y + EYE - 0.1, body.z + Math.cos(body.yaw) * 0.3];
    let dir: Vec3;
    const pick = assistPick;
    if (aimDir) dir = aimDir;
    else if (pick && pick.angle <= bendAngle(controls().aimAssist)) {
        // Aim assist: a shot a hair off a soldier goes onto them.
        dir = normalize(sub([pick.target.x, pick.target.y + 1.25, pick.target.z], eye));
    } else {
        const probe = castShot(street, nav, cam.eye, cam.forward, Math.max(60, w.range), null, false);
        dir = normalize(sub(probe.end, eye));
    }
    playerShoot(street, nav, eye, dir, w, skill(c, "marksmanship"), rng, adsSpread(aim.ads));
    // Your shots land between street steps, and the next step starts a fresh event list: handle
    // what they did now, or a fallen defender would never leave its compound's garrison.
    handleStreetEvents();
    street.events.length = 0;
    if (w.id !== "fists" && region) {
        const rs = c.regions[region];
        if (!rs.war && rs.governor !== PARTY) rs.heat = Math.min(1, rs.heat + 0.003);
    }
}

function resolvePlaces(query: string): Array<{ name: string; lat: number; lon: number; kind: string }> {
    const coords = query.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (coords) {
        const lat = Number(coords[1]), lon = Number(coords[2]);
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error("Latitude must be -90..90; longitude -180..180.");
        return [{ name: query.trim(), lat, lon, kind: "village" }];
    }
    if (!query.trim()) return [];
    return Entropy.QuadPlanet.geocode(terrainId, query.trim());
}

const controller = new Controller();
let settlementPage = 0;
let controllerFocus: string | null = null;
let lastMenuAxis = 0;
function menuMove(direction: number): void {
    if (!ui) return;
    if (!ui.handlers.size) drawUi(0, true);
    const ids = [...ui.handlers.keys()].filter(id => !id.startsWith("map-"));
    if (!ids.length) return;
    const current = controllerFocus ? ids.indexOf(controllerFocus) : -1;
    controllerFocus = ids[(Math.max(-1, current) + direction + ids.length) % ids.length];
    ui.p.hover = controllerFocus;
}
function controllerButton(button: string, pressed: boolean): void {
    const fresh = controller.button(button, pressed);
    if (!fresh) return;
    if (mode === "play") {
        if (driving()) {
            if (button === "RightTrigger2") triggerFresh = true;
            if (button === "West") onKey("e");
            else if (button === "DPadDown") onKey("l");
            else if (button === "RightThumb") onKey("v");
            else if (button === "Start") onKey("Tab");
            return;
        }
        const actions: Record<string, string> = { West: "e", East: "r", North: "b", Start: "Tab", Select: "g", DPadUp: "f", DPadDown: "q", RightThumb: "v", DPadLeft: "h", DPadRight: "i" };
        if (actions[button]) onKey(actions[button]);
        if ((button === "RightTrigger" || button === "LeftTrigger") && campaign) {
            const weapons = campaign.player.weapons;
            const delta = button === "RightTrigger" ? 1 : -1;
            campaign.player.weapon = weapons[(weapons.indexOf(campaign.player.weapon) + delta + weapons.length) % weapons.length]; reloadLeft = 0;
        }
        if (button === "RightTrigger2") triggerFresh = true;
    } else if (mode === "speech" && speech) {
        const card = { West: 0, North: 1, East: 2 }[button];
        if (speech.phase === "choose" && card !== undefined) chooseCard(speech, card);
        else if (button === "South") onKey(speech.phase === "done" ? "Enter" : " ");
        else if (speech.phase === "heckle" && button === "West") rebutHeckler(speech, speech.heckler!.key);
    } else if (mode === "console" && (button === "LeftTrigger" || button === "RightTrigger")) {
        const tabs: ConsoleTab[] = ["overview", "organization", "territory", "armory", "skills"];
        tab = tabs[(tabs.indexOf(tab) + (button === "RightTrigger" ? 1 : -1) + tabs.length) % tabs.length];
        controllerFocus = null;
    } else if (button === "East" || button === "Start") {
        if (mode === "console" || mode === "dialogue" || mode === "shop") onKey("Escape");
        else if (mode === "setup") act("title");
    } else if (button.startsWith("DPad")) menuMove(button === "DPadUp" || button === "DPadLeft" ? -1 : 1);
    else if (button === "South" && ui) {
        if (!controllerFocus || !ui.handlers.has(controllerFocus)) menuMove(1);
        if (controllerFocus) ui.handlers.get(controllerFocus)?.();
    }
}

// --- Input ---------------------------------------------------------------------------------------

const key = (k: string) => Entropy.Input.isKeyPressed(k) || Entropy.Input.isKeyPressed(k.toUpperCase());

function readInput(): PlayerInput {
    if (mode !== "play" && mode !== "speech") return NO_PLAYER_INPUT;
    if (mode === "speech") return { ...NO_PLAYER_INPUT, lookX: controller.right[0], turnLeft: key("ArrowLeft"), turnRight: key("ArrowRight") };
    return {
        moveX: controller.left[0], moveY: controller.left[1], lookX: controller.right[0], lookY: controller.right[1],
        forward: key("w"), back: key("s"), left: key("a"), right: key("d"),
        jump: key(" ") || controller.held.has("South"), sprint: Entropy.Input.isShiftPressed() || controller.held.has("LeftThumb"),
        turnLeft: key("ArrowLeft"), turnRight: key("ArrowRight"), lookUp: key("ArrowUp"), lookDown: key("ArrowDown"),
    };
}

/** Walking input: turning is done by stepAim (smoothed, assisted), not by stepBody. */
function footInput(): PlayerInput {
    return { ...readInput(), lookX: 0, lookY: 0, turnLeft: false, turnRight: false, lookUp: false, lookDown: false };
}

/** Wants to aim down sights: middle mouse or Z held, or LT / L2, on foot with a gun drawn. */
function wantsAds(): boolean {
    return mode === "play" && !driving() && !street.player.dead && weaponNow().id !== "fists"
        && (adsButton || key("z") || controller.held.has("LeftTrigger2"));
}

/**
 * Every live frame: raise or lower the sights (narrowing the view), then turn: mouse motion played
 * out, stick and arrow keys eased, slowed over a soldier and drawn onto them (aim assist).
 */
function stepAim(dt: number): void {
    stepAds(aim, wantsAds(), dt);
    const fov = aim.ads > 0.001 ? adsFov(aim) : 0;
    if (Math.abs(fov - fovSet) > 0.05) { Entropy.Camera.setFov(fov); fovSet = fov; }
    const { aimAssist, lookSensitivity } = controls();
    const piloting = !!driving();
    const turning = mode === "play" || mode === "speech";
    // The car turns with the stick itself (stepCar); the mouse still glides.
    const stickX = turning && !piloting ? controller.right[0] + Number(key("ArrowRight")) - Number(key("ArrowLeft")) : 0;
    const stickY = turning && !piloting && mode === "play" ? controller.right[1] + Number(key("ArrowUp")) - Number(key("ArrowDown")) : 0;
    assistPick = null;
    if (mode === "play" && !piloting && frame && aimAssist > 0 && weaponNow().id !== "fists") {
        const cam = bodyCamera(body, heightAt);
        const foes = street.actors.filter(a => a.kind === "soldier" && alive(a)).map(a => ({ id: a.id, x: a.x, y: a.y, z: a.z }));
        assistPick = pickAssistTarget(cam.eye, body.yaw, body.pitch, foes, aimAssist, aim.ads, Math.max(40, weaponNow().range),
            t => !nav || nav.sightClear(body.x, body.z, t.x, t.z));
    }
    const d = stepLook(aim, stickX, stickY, dt, assistFriction(assistPick, aimAssist), lookSensitivity);
    const firing = (triggerHeld || controller.held.has("RightTrigger2")) && fireCooldown > 0;
    const pull = assistPull(assistPick, aimAssist, aim.ads, firing, dt);
    if (!turning) return;
    body.yaw += d.yaw + pull.yaw;
    body.pitch = Math.max(-1.2, Math.min(1.0, body.pitch + d.pitch + pull.pitch));
}

function typeInto(k: string): void {
    const field = setup.focus;
    if (!field) return;
    let v = field === "hometown" ? setup.hometownQuery ?? "" : field === "party" ? setup.party : setup.leader;
    if (k === "Backspace") v = v.slice(0, -1);
    else if (k === "Enter" || k === "Tab" || k === "Escape") { if (field === "hometown" && k === "Enter") act("setup-search"); setup.focus = k === "Tab" && field === "party" ? "leader" : null; return; }
    else if (k.length === 1 && v.length < (field === "hometown" ? 120 : 28) && !/[\x00-\x1f]/.test(k)) v += k;
    else return;
    if (field === "hometown") { setup.hometownQuery = v; setup.hometown = undefined; setup.places = []; } else if (field === "party") setup.party = v; else setup.leader = v;
}

function onKey(k: string): void {
    const lower = k.toLowerCase();
    if (mode === "setup" && setup.focus) { typeInto(k); return; }
    if (mode === "speech" && speech) {
        if (speech.phase === "choose" && ["1", "2", "3"].includes(k)) chooseCard(speech, Number(k) - 1);
        else if (speech.phase === "deliver" && k === " ") deliver(speech);
        else if (speech.phase === "heckle" && lower.length === 1) rebutHeckler(speech, lower);
        else if (speech.phase === "done" && (k === " " || k === "Enter" || k === "Escape")) finishSpeech();
        return;
    }
    if (mode === "dialogue") {
        const d = dialogue;
        if (!d) return;
        if (k === "Escape") { closeDialogue(); return; }
        const order = d.orator ? ["dlg-debate"] : d.member ? ["dlg-follow", "dlg-pamphlet"] : ["dlg-persuade", "dlg-pamphlet", "dlg-recruit"];
        const i = Number(k) - 1;
        if (order[i]) dialogueAction(order[i]);
        return;
    }
    if (mode === "console") {
        if (k === "Tab" || k === "Escape" || lower === "m" || (lower === "i" && tab === "inventory")) mode = "play";
        return;
    }
    if (mode === "shop") {
        if (k === "Escape" || k === "Tab" || lower === "e") closeShop();
        return;
    }
    if (mode === "outcome" || mode === "title" || mode === "setup" || mode === "loading") return;
    // Play.
    if (k === "Tab" || lower === "m" || k === "Escape") { mode = "console"; selectedRegion = region; return; }
    if (lower === "i") { mode = "console"; tab = "inventory"; return; }
    // J: half your troops to the region an invasion is marching on (from the air too).
    if (lower === "j") { const t = marchingThreat(); if (t) dispatch(t.id, 0.5); else toast("No invasion on the march.", "info"); return; }
    if (lower === "h" && campaign) {
        const id = quickHealItem(campaign, street.player.health);
        if (id) useItemNow(id); else toast(street.player.health >= maxHealth(campaign) ? "You are at full health." : "No medkits, stims or rations. Shops sell them; houses hide them.", "info");
        return;
    }
    if (lower === "p") {
        // The autopilot: engage it for the destination set (COMMAND > TERRITORY), or take the controls back.
        if (!autopilot) toast("No destination: pick a place in COMMAND > TERRITORY and press AUTOPILOT.", "info");
        else if (!driving()) toast(`Board your car (or the Cobra) to fly to ${autopilot.name}.`, "info");
        else { autopilotOn = !autopilotOn; flightWarp = 1; toast(autopilotOn ? `Autopilot: ${autopilot.name}, ${Math.round(autopilotKm(autopilot))} km.` : "You have the controls.", "info"); }
        return;
    }
    if (driving()) {
        if (lower === "e") useCar();
        else if (lower === "l") { autopilotOn = false; landCar(); }
        return;
    }
    if (lower === "e") interact();
    else if (lower === "t") orderHold();
    else if (lower === "g") summonCar();
    else if (lower === "f") quickPamphlet();
    else if (lower === "b") { const err = beginSpeech(); if (err) toast(err, "bad"); }
    else if (lower === "r") startReload();
    else if (lower === "v") body.firstPerson = !body.firstPerson;
    else if (lower === "q") {
        const ids = ["truth", "propaganda", "smear"];
        pamphletType = ids[(ids.indexOf(pamphletType) + 1) % ids.length];
    } else if (/^[1-9]$/.test(k) && campaign) {
        const w = campaign.player.weapons[Number(k) - 1];
        if (w) { campaign.player.weapon = w; reloadLeft = 0; }
    }
}

function setupInput(): void {
    Entropy.Input.onGamepadAxis((left, right) => controller.axis(left, right, time));
    Entropy.Input.onGamepadButton(controllerButton);
    Entropy.Input.onKeyDown((k: string) => onKey(k));
    Entropy.Input.onMouseDown((button: number, x: number, y: number) => {
        if (button === 1) { lookButtonDown = true; lookDrag = [x, y]; return; }
        if (button === 2) { adsButton = true; return; }
        const id = ui ? ui.click(x, y) : null;
        if (id) return;
        if (button === 0 && mode === "play" && (!driving() || inCobra())) { triggerHeld = true; triggerFresh = true; }
        else if (mode === "setup") setup.focus = null;
    });
    Entropy.Input.onMouseMove((x: number, y: number) => {
        if (ui) ui.p.hover = ui.p.hit(x, y)?.id ?? null;
        if (lookButtonDown && lookDrag && (mode === "play" || mode === "speech")) {
            const dx = x - lookDrag[0], dy = y - lookDrag[1];
            lookDrag = [x, y];
            // Played out over the next frames (al_aim.ts), so the view glides.
            addMouse(aim, dx, dy, controls().lookSensitivity);
        }
    });
    Entropy.Input.onMouseUp((button: number) => {
        if (button === 1) { lookButtonDown = false; lookDrag = null; }
        else if (button === 2) adsButton = false;
        else triggerHeld = false;
    });
    Entropy.Input.onMouseWheel((_dx: number, dy: number) => {
        if (mode === "play" || mode === "speech") body.camDistance = Math.max(1.8, Math.min(16, body.camDistance * (dy > 0 ? 0.9 : 1.1)));
        if (mode === "console" && tab === "organization") memberPage = Math.max(0, memberPage + (dy > 0 ? -1 : 1));
    });
}

// --- The game view (what the screens read; what their buttons do) --------------------------------

function act(name: string, arg?: unknown): void {
    const c = campaign;
    const err = (e: string | null, ok?: string) => { if (e) toast(e, "bad"); else if (ok) toast(ok, "good"); };
    switch (name) {
        case "setup": mode = "setup"; break;
        case "title": mode = "title"; campaign = null; region = null; resetStreet(street); hideWorld(); break;
        case "continue": {
            const saved = loadSave();
            if (!saved) { toast("No saved campaign.", "bad"); break; }
            campaign = saved;
            startLoading(saved.player.lat, saved.player.lon);
            break;
        }
        case "setup-focus": setup.focus = arg as SetupState["focus"]; break;
        case "setup-ideology": setup.ideology = String(arg); setup.color = Math.max(0, PARTY_COLORS.findIndex(pc => pc.color.join() === IDEOLOGIES.find(i => i.id === arg)!.color.join())); break;
        case "setup-color": setup.color = Number(arg); break;
        case "setup-spawn": setup.hometown = undefined; setup.places = []; setup.spawn = String(arg); break;
        case "setup-random": setup.hometown = undefined; setup.places = []; setup.spawn = REGIONS[Math.floor(Math.random() * REGIONS.length)].id; break;
        case "setup-search": {
            try { setup.places = resolvePlaces(setup.hometownQuery ?? ""); if (!setup.places.length) toast("No places found. Add a region or country to the town name.", "info"); }
            catch (e) { toast((e as Error).message, "bad"); }
            setup.focus = null; break;
        }
        case "setup-place": { const p = setup.places?.[Number(arg)]; if (p) { setup.hometown = p; setup.spawn = null; setup.places = []; } break; }
        case "begin": beginCampaign(); break;
        case "tab": tab = arg as ConsoleTab; break;
        case "close-console": mode = "play"; break;
        case "posture": if (c) c.party.posture = arg as "inside" | "field" | "mixed"; break;
        case "dues": if (c) c.party.duesRate = Math.max(0, Math.min(1, Math.round((c.party.duesRate + Number(arg)) * 100) / 100)); break;
        case "rest": if (c) { newDay(); c.dayClock = 0; toast(`A new day: ${c.day}.`, "info"); } break;
        case "save": toast(save() ? "Campaign saved." : "Couldn't save.", "info"); break;
        case "auto-organize": if (c) { const done = autoOrganize(c); toast(done.length ? `${done.length} appointments made.` : "Nothing to appoint.", done.length ? "good" : "info"); } break;
        case "select-member": selectedMember = Number(arg); break;
        case "member-page": memberPage = Math.max(0, memberPage + Number(arg)); break;
        case "appoint": if (c) { const a = arg as { id: number; role: Parameters<typeof appoint>[2]; post: string | null }; err(appoint(c, a.id, a.role, a.post), "Appointed."); } break;
        case "follower": if (c) { const m = c.members.find(x => x.id === Number(arg)); if (m) err(setFollower(c, m.id, !m.follower)); } break;
        case "armed": if (c) { const m = c.members.find(x => x.id === Number(arg)); if (m) err(setArmed(c, m.id, !m.armed), m.armed ? undefined : `${m.name} joins the armed forces.`); } break;
        case "settlement-page": settlementPage = Math.max(0, settlementPage + Number(arg)); break;
        case "select-region": selectedRegion = String(arg); break;
        case "travel": if (c) { const id = String(arg); const e = travel(c, id); if (e) toast(e, "bad"); else { const d = regionDefById(id)!; startLoading(d.lat, d.lon); } } break;
        case "move-hq": if (c) err(moveHq(c, String(arg)), "Headquarters moved."); break;
        case "election": if (c) err(callElection(c, String(arg)), "Election called!"); break;
        case "coup": if (c) { const r = attemptCoup(c, String(arg)); toast(r.message, r.ok ? "good" : "bad"); if (c.outcome) mode = "outcome"; } break;
        case "war": if (c) err(declareWar(c, String(arg)), "War is declared."); break;
        case "peace": if (c) { const r = proposePeace(c, String(arg)); toast(r.message, r.ok ? "good" : "bad"); } break;
        case "suspend": if (c) err(suspendElections(c, String(arg)), "Elections suspended."); break;
        case "tax": if (c) setTaxRate(c, String(arg), c.regions[String(arg)].taxRate - 0.05); break;
        case "tax-up": if (c) setTaxRate(c, String(arg), c.regions[String(arg)].taxRate + 0.05); break;
        case "arm": if (c) { const rs = c.regions[String(arg)]; const n = Math.max(0, Math.min(rs.members - 1, Math.floor(c.party.funds / 120), Math.max(10, Math.round(rs.members * 0.25)))); err(armMembers(c, String(arg), n), `${n} members armed.`); } break;
        case "disarm": if (c) disarm(c, String(arg), Math.ceil(c.regions[String(arg)].army * 0.25)); break;
        case "march": if (c && region) err(moveArmy(c, region, String(arg), Math.floor(c.regions[region].army / 2)), "The column marches."); break;
        case "scheme": if (c) { const a = arg as { scheme: string; region: string }; err(startScheme(c, a.scheme, a.region), "Scheme underway."); } break;
        case "equip": if (c) { c.player.weapon = String(arg); reloadLeft = 0; } break;
        case "buy-weapon": if (c) err(buyWeapon(c, String(arg)), "Weapon bought."); break;
        case "buy-ammo": if (c) err(buyAmmo(c, String(arg))); break;
        case "buy-armor": if (c) { err(buyArmor(c, String(arg)), "Armor fitted."); syncStreetPlayerFromCampaign(); } break;
        case "buy-pamphlets": if (c) err(buyPamphlets(c, String(arg))); break;
        case "select-pamphlet": pamphletType = String(arg); break;
        case "buy-facility": if (c) err(buyFacility(c, String(arg))); break;
        case "raise-skill": if (c) { err(raiseSkill(c, arg as Parameters<typeof raiseSkill>[1]), "Skill raised."); syncStreetPlayerFromCampaign(); } break;
        case "speech-card": if (speech) chooseCard(speech, Number(arg)); break;
        case "use-item": useItemNow(String(arg)); break;
        case "aim-assist": case "look-sensitivity": if (c) {
            const k = (c.player.controls ??= { aimAssist: 0.5, lookSensitivity: 1 });
            if (name === "aim-assist") k.aimAssist = Math.round(Math.max(0, Math.min(1, k.aimAssist + Number(arg))) * 10) / 10;
            else k.lookSensitivity = Math.round(Math.max(0.3, Math.min(2.5, k.lookSensitivity + Number(arg))) * 10) / 10;
        } break;
        case "shop-close": closeShop(); break;
        case "shop-buy": if (c) { const a = arg as { kind: Parameters<typeof buyStock>[1]["kind"]; id: string }; err(buyStock(c, a), "Bought."); syncStreetPlayerFromCampaign(); } break;
        case "shop-sell": if (c) { const r = sellItem(c, String(arg)); if (typeof r === "string") toast(r, "bad"); else toast(`Sold for CR ${r}.`, "good"); } break;
        case "speech-close": finishSpeech(); break;
        case "dispatch": { const a = arg as { region: string; share: number }; dispatch(a.region, a.share); break; }
        case "threat-send": { const t = marchingThreat(); if (t) dispatch(t.id, Number(arg)); break; }
        case "comrades-hold": orderHold(); break;
        case "autopilot": { const d = regionDefById(String(arg)); if (d) { setAutopilot(d.name, d.lat, d.lon); if (mode === "console") mode = "play"; } break; }
        default:
            if (name.startsWith("dlg-")) dialogueAction(name);
    }
}

function beginCampaign(): void {
    if (!setup.spawn && !setup.hometown) return;
    const def = setup.spawn ? regionDefById(setup.spawn) : null;
    campaign = newCampaign({
        partyName: setup.party, leader: setup.leader, ideology: setup.ideology, color: PARTY_COLORS[setup.color].color, spawn: def?.id, hometown: setup.hometown ?? (def ? { name: def.name, lat: def.lat, lon: def.lon, kind: "city" } : undefined),
        seed: Math.floor(Math.random() * 2 ** 31),
    });
    startFoundingMission(campaign);
    for (const k of Object.keys(mags)) delete mags[k];
    startLoading(campaign.player.lat, campaign.player.lon);
    save();
}

function view(): GameView {
    const c = campaign;
    const w = weaponNow();
    const nearestTalk = mode === "play" ? nearestActor(street, 3.4, x => x.kind !== "soldier") : null;
    let prompt: string | null = null;
    if (nearestTalk) {
        prompt = nearestTalk.kind === "orator"
            ? `[E] CONFRONT ${nearestTalk.name.toUpperCase()}`
            : `[E] TALK TO ${nearestTalk.name.toUpperCase()} - ${nearestTalk.member ? "COMRADE" : opinionLabel(nearestTalk.opinion)}${nearestTalk.kind === "civilian" ? "   [F] PAMPHLET" : ""}`;
    }
    const near = nearbyAction();
    if (near) prompt = near.label;
    if (playerCar?.call && campaign) prompt = `YOUR CAR IS ON ITS WAY: ${Math.round(Math.hypot(playerCar.x - body.x, playerCar.z - body.z))} M, ${Math.ceil(callEta(playerCar, flightEnvironment(), carSpec(campaign.player.carUpgrades)))} S`;
    const flying = driving();
    if (flying) prompt = `${flying === cobra ? "COBRA " : ""}${flying.state.toUpperCase()}   [L] LAND   [E / X / SQUARE] EXIT AFTER LANDING`;
    const rallyActor = street.rally ? actorById(street, street.rally.orator) : undefined;
    return {
        mode, tab, c, setup, loading, speech, dialogue, toasts, region, selectedRegion, selectedMember, memberPage, settlementPage, prompt,
        street: {
            civilians: street.actors.filter(a => a.kind === "civilian" && alive(a)).length,
            listeners: listeners(street).length, soldiers: soldiers(street).length,
            followers: street.actors.filter(a => a.kind === "follower" && alive(a)).length,
            rally: rallyActor ? `${rallyActor.name} (${factionById(street.rally!.faction).short})` : null,
            rallyTime: street.rally?.time ?? 0,
        },
        weapon: { name: w.name, mag: Number.isFinite(w.magazine) ? magOf(w.id) : 0, reserve: c?.player.ammo[w.id] ?? 0, reloading: reloadLeft > 0, magazine: w.magazine },
        pamphlet: pamphletType,
        stamina: Math.round(body.stamina * 50) / 50,
        aim: { ads: Math.round(aim.ads * 10) / 10, locked: !!assistPick, assist: controls().aimAssist },
        armor: c ? Math.round(c.player.armor / Math.max(1, armorById(c.player.armorId).armor || 1) * 50) / 50 : 0,
        land, hasSave, time, firstPerson: body.firstPerson, piloting: !!flying,
        debug: null,
        markers: ui ? screenMarkers(ui.W, ui.H) : [],
        minimap: miniMap,
        capture: captureView,
        car: flying && c ? { boost: flying.boost ?? 0, speed: Math.hypot(flying.vx, flying.vz), altitude: flying.y - carGround(flying.x, flying.z, heightAt),
            ceiling: flying === cobra ? COBRA_SPEC.ceiling : carSpec(c.player.carUpgrades).ceiling,
            cobra: flying === cobra && cobraState ? { hull: cobraState.hull, maxHull: COBRA_HULL, cells: cobraState.cells, maxCells: COBRA_CELLS } : undefined } : null,
        indoors: indoors?.name ?? null,
        shop: shopState,
        autopilot: autopilot ? { name: autopilot.name, km: autopilotKm(autopilot), warp: flightWarp, on: autopilotOn && !!driving() } : null,
        threat: (() => {
            const t = marchingThreat();
            if (!t || !c) return null;
            const rs = c.regions[t.id];
            return { region: t.id, name: regionDefById(t.id)?.name ?? t.id, attacker: factionById(t.threat.attacker).short, force: t.threat.force,
                defenders: rs.army, available: troopsAvailable(c, t.id), ratio: defenseRatio(c, rs, t.threat.force), here: t.id === region };
        })(),
        comrades: {
            following: street.actors.filter(a => a.kind === "follower" && alive(a) && a.aboard == null && !a.hold).length,
            holding: street.actors.filter(a => a.kind === "follower" && alive(a) && !!a.hold).length,
            riding: street.actors.filter(a => a.kind === "follower" && alive(a) && a.aboard != null).length,
            engaged: street.engaged > 0,
        },
        act,
    };
}

// --- Rendering people ----------------------------------------------------------------------------

/** Each person's last level of detail (hysteresis) while within drawing range. */
const personLods = new Map<number, PersonLod>();
let crowd: CrowdBatches | null = null;
/** Scales people's LOD distances (allegiance_config peopleDetail): lower is faster. */
let peopleDetail = 1;
/** Caps drawn people's cost (allegiance_config peopleMaxFull / peopleTriangles). */
let peopleBudget: PeopleBudget = { ...DEFAULT_PEOPLE_BUDGET };
/** People per level of detail last frame (including you), for the state report. */
let lodCounts: [number, number, number] = [0, 0, 0];

function weaponClass(id: string): string {
    if (id === "fists") return "none";
    if (id === "pistol") return "pistol";
    if (id === "rail") return "rail";
    return "rifle";
}

function lookOf(a: Actor): PersonLook {
    return { skin: a.look.skin, hair: a.look.hair, hat: a.look.hat, female: a.look.female, weapon: weaponClass(a.weapon), soldier: a.kind === "soldier", sash: a.kind === "orator" };
}

const PLAYER_LOOK_BASE = { skin: [0.85, 0.66, 0.5] as [number, number, number], hair: [0.12, 0.09, 0.07] as [number, number, number], hat: false, female: false, soldier: false, sash: true };

function makeCrowd(): CrowdBatches {
    return new CrowdBatches({
        createBuffer: bytes => Entropy.Buffer.create({ size: bytes, usage: "Storage" }),
        destroyBuffer: id => Entropy.Buffer.destroy(id),
        writeBuffer: (id, data) => Entropy.Buffer.write(id, data),
        createMesh: (key, meshId, buffer, instances) => Entropy.MeshCache.createMesh(PEOPLE_NAMESPACE, key, { id: meshId, pipelineId: peoplePipelineId, instanceCount: instances, bindings: [
            { group: 2, binding: 0, resource: { type: "Buffer", value: { id: worldBuffer } } },
            { group: 2, binding: 1, resource: { type: "Buffer", value: { id: buffer } } },
            ...cloudBindings(cloudTexture),
        ] }),
        clearMesh: meshId => Entropy.Model.clearMesh(meshId),
        setInstanceCount: (meshId, count) => Entropy.Model.setInstanceCount(meshId, count),
    }, { prefix: "al-crowd", onMissing: key => people.forget(key) });
}

/** Appends one person to their body variant's batch. */
function addPerson(key: string, matrix: number[], tint: readonly number[], extra: readonly number[], skin: readonly number[], hair: readonly number[]): void {
    const { data, offset } = crowd!.add(key);
    data.set(matrix, offset);
    data[offset + 16] = tint[0]; data[offset + 17] = tint[1]; data[offset + 18] = tint[2]; data[offset + 19] = tint[3];
    data[offset + 20] = extra[0]; data[offset + 21] = extra[1]; data[offset + 22] = extra[2]; data[offset + 23] = extra[3];
    data[offset + 24] = skin[0]; data[offset + 25] = skin[1]; data[offset + 26] = skin[2]; data[offset + 27] = 1;
    data[offset + 28] = hair[0]; data[offset + 29] = hair[1]; data[offset + 30] = hair[2]; data[offset + 31] = 1;
}

function personMatrix(x: number, y: number, z: number, heading: number, dead: boolean): number[] {
    const f = frame!;
    const pos = toWorld(f, x, y + (dead ? 0.12 : 0), z);
    const fwd = dirToWorld(f, Math.sin(heading), 0, Math.cos(heading));
    const fr = dead ? makeFrame(f.up, scale(fwd, -1)) : makeFrame(fwd, f.up);
    return frameMatrix(toRender(pos), fr);
}

function drawPeople(): void {
    if (!frame) return;
    crowd ??= makeCrowd();
    crowd.begin();
    if (profileDisable === "people") { crowd.flush(); return; }
    const c = campaign;
    const party = c ? c.party.color : THEME.red;
    const anyEnemy = soldiers(street).length > 0;
    const counts: [number, number, number] = [0, 0, 0];
    const cam = lastCamera;
    const forward = cam ? normalize(sub(cam.target, cam.position)) : null;
    // Who is drawn this frame, nearest first, with the LOD their distance asks for.
    const shown: { a: Actor; distance: number; lod: PersonLod }[] = [];
    for (const a of street.actors) {
        if (a.aboard != null || Math.hypot(a.x - body.x, a.z - body.z) > 160) { personLods.delete(a.id); continue; }
        const center = toWorld(frame, a.x, a.y + 0.9, a.z);
        const actorDistance = cam ? distance(cam.position, center) : Math.hypot(a.x - body.x, a.z - body.z);
        const lod = personLod(actorDistance, personLods.get(a.id), peopleDetail);
        // Off screen: no draw, but the simulation (and the LOD hysteresis) carries on.
        if (cam && forward && !maybeVisible(cam.position, forward, center)) { personLods.set(a.id, lod); counts[lod]++; continue; }
        shown.push({ a, distance: actorDistance, lod });
    }
    // You are drawn in full and count against the budget first.
    const playerVisible = (mode === "play" || mode === "speech" || mode === "dialogue") && !body.firstPerson && !driving();
    shown.sort((x, y) => x.distance - y.distance);
    const budget = { maxFull: Math.max(0, peopleBudget.maxFull - (playerVisible ? 1 : 0)), triangleBudget: Math.max(0, peopleBudget.triangleBudget - (playerVisible ? PERSON_TRIANGLES[0] : 0)) };
    const lods = budgetLods(shown.map(s => s.lod), budget);
    shown.forEach((s, i) => {
        const a = s.a, lod = lods[i];
        personLods.set(a.id, lod);
        counts[lod]++;
        const look = lookOf(a);
        const key = people.ensure(look, lod);
        if (!key) return;
        const dead = a.state === "dead";
        const shirt = a.kind === "soldier" ? a.look.shirt : (a.member || a.kind === "follower") ? [party[0], party[1], party[2]] : a.look.shirt;
        const amp = dead ? 0 : Math.min(0.75, a.speed * 0.22);
        const aiming = !dead && (a.kind === "soldier" || a.kind === "follower") && a.weapon !== "fists" && anyEnemy;
        const phase = (a.stride % 6.2832) + 0.001;
        const listening = a.state === "listen" && !dead;
        // Listeners cheer: arms up with the crowd's fervor during a speech.
        const cheer = listening && speech && speech.phase === "react" && (a.id % 3 === 0);
        addPerson(key, personMatrix(a.x, a.y, a.z, a.heading, dead), [shirt[0], shirt[1], shirt[2], cheer ? 0.9 : amp],
            [a.look.pants[0], a.look.pants[1], a.look.pants[2], aiming || cheer ? -phase - (cheer ? time * 6 : 0) : phase], look.skin, look.hair);
    });
    if (personLods.size > street.actors.length * 2) {
        const ids = new Set(street.actors.map(a => a.id));
        for (const id of [...personLods.keys()]) if (!ids.has(id)) personLods.delete(id);
    }
    // You.
    counts[0]++;
    const look: PersonLook = { ...PLAYER_LOOK_BASE, weapon: weaponClass(c?.player.weapon ?? "fists") };
    const key = people.ensure(look, 0);
    if (key && playerVisible) {
        const amp = Math.min(0.8, body.speed * 0.2);
        const aiming = aimHold > 0 || lookButtonDown || aim.ads > 0.3;
        addPerson(key, personMatrix(body.x, body.y, body.z, body.yaw, false), [party[0], party[1], party[2], amp],
            [0.15, 0.14, 0.14, aiming ? -(body.stride % 6.28) - 0.001 : (body.stride % 6.28) + 0.001], look.skin, look.hair);
    }
    lodCounts = counts;
    crowd.flush();
}

// Props: the podium and party flag during a speech, and tracer rounds.
let podiumItem = "";
let flagItem = "";
const tracerItems: string[] = [];
const TRACERS = 20;

/** Whether each prop mesh is drawn: hidden props draw no instances (no draw call), rather than a
 * collapsed matrix the GPU still processes. */
const propShown = new Map<string, boolean>();

function showProp(meshId: string, shown: boolean): void {
    if (propShown.get(meshId) === shown) return;
    propShown.set(meshId, shown);
    Entropy.Model.setInstanceCount(meshId, shown ? 1 : 0);
}

function setupProps(): void {
    podiumItem = uniform(ITEM_FLOATS);
    flagItem = uniform(ITEM_FLOATS);
    spawnMesh("al-podium", buildPodium(), podiumItem);
    spawnMesh("al-flag", buildFlag(), flagItem);
    writeItem(podiumItem, HIDDEN, [1, 1, 1, 0]);
    writeItem(flagItem, HIDDEN, [1, 1, 1, 0]);
    showProp("al-podium", false);
    showProp("al-flag", false);
    const party = buildTracer([1, 0.85, 0.4]), enemy = buildTracer([1, 0.35, 0.25]);
    for (let i = 0; i < TRACERS; i++) {
        const item = uniform(ITEM_FLOATS);
        tracerItems.push(item);
        spawnMesh(`al-tracer-${i}`, i % 2 ? enemy : party, item);
        writeItem(item, HIDDEN, [1, 1, 1, 0]);
        showProp(`al-tracer-${i}`, false);
    }
}

const trafficItems: string[] = [];
let playerCarItem = "";
let playerCar: FlyingCar | null = null;
const flightEnvironment = () => ({ height: heightAt, sea: isSea, buildings: nav?.rects ?? [] });
function saveCar(): void {
    if (!campaign || !playerCar || !frame) return;
    // A car flying itself to you is saved where it will land.
    const call = playerCar.call;
    if (call) {
        const ll = dirToLatLon(toWorld(frame, call.x, heightAt(call.x, call.z), call.z));
        campaign.player.flyingCar = { lat: ll.lat, lon: ll.lon, yaw: call.yaw, altitude: 0, piloting: false };
        return;
    }
    const ll = dirToLatLon(toWorld(frame, playerCar.x, playerCar.y, playerCar.z));
    campaign.player.flyingCar = { lat: ll.lat, lon: ll.lon, yaw: playerCar.yaw,
        altitude: Math.max(0, playerCar.y - carGround(playerCar.x, playerCar.z, heightAt)), piloting: playerCar.piloting };
}
function useCar(): void {
    if (mode !== "play") return;
    const flying = driving();
    if (!flying) {
        // Board the nearest: your car, or a Cobra (yours or a compound's).
        const cob = cobraInReach();
        const carD = playerCar ? Math.hypot(playerCar.x - body.x, playerCar.z - body.z) : Infinity;
        if (cob && (cob.stairs ? !atStairsTo(playerCar) || carD > 6 : Math.hypot(cob.x - body.x, cob.z - body.z) < carD)) { boardCobra(cob); return; }
    }
    const c = flying ?? playerCar;
    if (!c) return;
    if (c.piloting) {
        if (c.state !== "parked" || !landingClear(c, flightEnvironment())) { toast("Land on clear, level ground or a flat roof before exiting. Press L / D-pad down."); return; }
        let exit: [number, number] | null = null;
        const roof = roofOf(c);
        if (roof) {
            // Up on a roof: down the stairs and out of the building's street door.
            exit = nav?.nearestWalkable(roof.door[0], roof.door[1], 8) ?? null;
        } else for (let i = 0; i < 16; i++) {
            const a = c.yaw + i * Math.PI / 8;
            const reach = c === cobra ? 5.6 : 4.8;
            const x = c.x + Math.sin(a) * reach, z = c.z + Math.cos(a) * reach;
            if (nav?.walkable(x, z) && !isSea(x, z) && Math.abs(heightAt(x, z) - (c.y - 0.22)) < 1) { exit = [x, z]; break; }
        }
        if (!exit) { toast("No safe space to exit here.", "bad"); return; }
        c.piloting = false; c.vx = c.vy = c.vz = 0;
        [body.x, body.z] = exit; body.y = heightAt(body.x, body.z); body.vy = 0; body.grounded = true;
        if (roof) body.yaw = Math.atan2(body.x - roof.cx, body.z - roof.cz);
        buildNav(body.x, body.z);
        toast(roof ? `You leave the ${c === cobra ? "Cobra" : "car"} on the roof and take the stairs down to the street.` : c === cobra ? "You leave the Cobra." : "You leave your car.");
        if (c === cobra) { saveCobra(); return; }
    } else {
        // A car up on a roof is boarded from the building's street door (up the stairs).
        const roof = !c.call ? roofOf(c) : null;
        const atStairs = !!roof && Math.hypot(roof.door[0] - body.x, roof.door[1] - body.z) < 5;
        if (!atStairs && (Math.hypot(c.x - body.x, c.z - body.z) >= 6 || Math.abs(body.y - c.y) > 3)) { toast(c.call ? "Your car is still on its way." : roof ? "Your car is on the roof: use the building's front door." : "Get closer to your car."); return; }
        c.call = null;
        c.piloting = true; body.x = c.x; body.y = c.y; body.z = c.z; body.yaw = c.yaw;
        triggerHeld = triggerFresh = false; lookDrag = null;
        buildNav(c.x, c.z); toast("Space / A / Cross to rise. L / D-pad down to land.");
    }
    saveCar();
}
function landCar(): void {
    const v = driving();
    if (!v) return;
    // Right below if it is clear; otherwise it glides to the nearest clear ground or flat roof.
    const spot = landingSpot(v, flightEnvironment());
    if (!spot) { toast("Nowhere to land near here: find clear, level ground or a flat roof.", "bad"); return; }
    v.landAt = spot;
    v.state = "landing";
}

/** At the street door of the building whose roof a parked vehicle stands on. */
function atStairsTo(v: FlyingCar | null): boolean {
    if (!v || v.piloting || v.call || indoors) return false;
    const roof = roofOf(v);
    return !!roof && Math.hypot(roof.door[0] - body.x, roof.door[1] - body.z) < 5;
}

/** The flat roof a parked vehicle stands on (local), if it is up on one. */
function roofOf(v: FlyingCar): Rect | null {
    if (v.y - carGround(v.x, v.z, heightAt) < 1) return null;
    return nav?.rects.find(r => r.kind !== "vehicle" && r.kind !== "house" && (r.fill ?? 1) >= ROOF_FILL && !r.key.startsWith("al-player-car") && insideRect(r, v.x, v.z) && Math.abs(r.base + r.height + 0.22 - v.y) < 0.8) ?? null;
}

/** Calls your car (G / View-Select): it flies itself over the rooftops and lands beside you. */
function summonCar(quiet = false): void {
    const c = playerCar;
    if (!c || !campaign || !frame) { toast("You have no car here.", "bad"); return; }
    if (c.piloting) return;
    if (indoors) { toast("Step outside to call your car.", "info"); return; }
    const spec = carSpec(campaign.player.carUpgrades);
    // Clear ground beside you, open to the sky (it comes down vertically).
    const spot = parkBeside(body.x, body.z, (x, z) => (nav?.walkable(x, z) ?? !isSea(x, z)) && !isSea(x, z) && !inCompound(x, z, 2), heightAt,
        car => openSky(car, nav?.rects ?? []));
    if (!spot) { toast("No clear ground here for your car to land. Find an open space.", "bad"); return; }
    if (!c.call && Math.hypot(c.x - spot.car.x, c.z - spot.car.z) < 3) { toast("Your car is right here.", "info"); return; }
    // From far away (another part of the map), it arrives from the edge of the street map.
    const far = Math.hypot(c.x - body.x, c.z - body.z);
    if (far > 1200) {
        const k = 600 / far;
        c.x = spot.car.x + (c.x - spot.car.x) * k; c.z = spot.car.z + (c.z - spot.car.z) * k;
        c.y = carGround(c.x, c.z, heightAt) + 60;
    }
    const wasParked = !c.call;
    callCar(c, spot.car, flightEnvironment(), spec);
    if (wasParked && nav) buildNav(nav.cx, nav.cz);
    if (!quiet) toast(`Your car is on its way: ${Math.round(Math.hypot(c.x - body.x, c.z - body.z))} m, about ${Math.ceil(callEta(c, flightEnvironment(), spec))} s.`, "good");
}

/** A called car flies on (every live frame, whatever you are doing). */
function stepCalledCar(dt: number): void {
    const c = playerCar;
    if (!c?.call || c.piloting || !campaign) return;
    // Something overhangs its landing spot (the street map grew): find another.
    if ((c.call.stuck ?? 0) > 1.5) { summonCar(true); if (c.call) c.call.stuck = 0; }
    if (stepCall(c, dt, flightEnvironment(), carSpec(campaign.player.carUpgrades))) {
        addCarObstacle();
        saveCar();
        toast("Your car has landed beside you. E / X / Square to board.", "good");
    }
}

function addCarObstacle(): void {
    if (!nav || !playerCar || playerCar.piloting || playerCar.call) return;
    const p = playerCar;
    nav.addRect({ cx: p.x, cz: p.z, ux: Math.cos(p.yaw), uz: -Math.sin(p.yaw), hw: 2.8, hd: 2.5,
        height: 1.6, base: p.y - 0.22, key: "al-player-car", door: [p.x, p.z] });
}
let trafficVisible = 0;
/** Traffic density and the rooftops it flies over, from a buildings query every 2 s. */
let trafficUnits = 0;
let trafficRoof = -Infinity;
let trafficSampleTime = -Infinity;
function drawTraffic(): void {
    const visible = !!frame && (mode === "play" || mode === "speech" || mode === "dialogue");
    if (visible && playerCar) {
        if (playerCar.state === "parked" && !playerCar.call) playerCar.y = carFloor(playerCar.x, playerCar.z, flightEnvironment());
        writeItem(playerCarItem, personMatrix(playerCar.x, playerCar.y, playerCar.z, playerCar.yaw, false), [1, 1, 1, 0]);
    }
    showProp("al-player-car", visible && !!playerCar);
    if (visible && cobra) {
        if (cobra.state === "parked") cobra.y = carFloor(cobra.x, cobra.z, flightEnvironment());
        writeItem(cobraItem, personMatrix(cobra.x, cobra.y, cobra.z, cobra.yaw, false), [1, 1, 1, 0]);
    }
    showProp("al-cobra", visible && !!cobra);
    for (let i = 0; i < CONVOY_MAX; i++) {
        const v = convoy[i];
        if (visible && v) writeItem(convoyItems[i], personMatrix(v.car.x, v.car.y, v.car.z, v.car.yaw, false), [1, 1, 1, 0]);
        showProp(`al-comrade-car-${i}`, visible && !!v);
    }
    if (visible && time - trafficSampleTime > 2) {
        // Up to 1,500 buildings: reduced to the two numbers traffic needs here, not every frame.
        trafficSampleTime = time;
        const near = Entropy.QuadPlanet.buildings(terrainId, toWorld(frame!, body.x, body.y, body.z), 400, { limit: 1500 });
        trafficUnits = housingUnits(near);
        trafficRoof = near.reduce((h, b) => Math.max(h, toLocal(frame!, b.anchor)[1] + b.height), -Infinity);
    }
    trafficVisible = visible ? trafficCount(trafficUnits) : 0;
    const roof = Math.max(trafficRoof, body.y);
    for (let i = 0; i < TRAFFIC_LIMIT; i++) {
        if (i < trafficVisible) {
            const pose = trafficPose(i, time, body.x, body.z, roof);
            writeItem(trafficItems[i], personMatrix(pose.x, pose.y, pose.z, pose.yaw, false), [1, 1, 1, 0]);
        }
        showProp(`al-car-${i}`, i < trafficVisible);
    }
}


// --- The autopilot (al_vehicle.ts steerAutopilot) ------------------------------------------------

/** Where the autopilot is taking you, whether it is flying now, and the time warp it last ran at. */
let autopilot: Autopilot | null = null;
let autopilotOn = false;
let flightWarp = 1;

/** Sets the autopilot's destination; flying, it takes over at once (on foot, P engages it once aboard). */
function setAutopilot(name: string, lat: number, lon: number): void {
    autopilot = { name, lat, lon };
    autopilotOn = !!driving();
    toast(autopilotOn ? `Autopilot: ${name}. Any control (or P) takes back the controls.` : `Destination set: ${name}. Board your car (or the Cobra) and press P.`, "good");
}

const autopilotKm = (a: Autopilot): number => campaign ? angularDistance(campaign.player.lat, campaign.player.lon, a.lat, a.lon) * EARTH_RADIUS_KM : 0;

/** You touched the controls: the autopilot lets go. */
function manualFlight(input: PlayerInput, descend: boolean): boolean {
    return input.forward || input.back || input.left || input.right || input.jump || descend
        || Math.hypot(input.moveX ?? 0, input.moveY ?? 0) > 0.3;
}

/**
 * One frame of flight with the autopilot holding the controls: climb, turn, cruise (time running
 * faster on a long leg), and on arrival an automatic landing near the destination.
 */
function flyAutopilot(v: FlyingCar, dt: number, spec: ReturnType<typeof carSpec>): void {
    const a = autopilot!;
    const env = flightEnvironment();
    const p = toLocal(frame!, surfaceAt(a.lat, a.lon));
    const km = autopilotKm(a);
    const st = steerAutopilot(v, p[0], p[2], km, env, spec);
    if (st.arrived) {
        autopilotOn = false; autopilot = null; flightWarp = 1;
        const spot = landingSpot({ x: p[0], y: v.y, z: p[2], yaw: v.yaw }, env, 160) ?? landingSpot(v, env);
        if (spot) { v.landAt = spot; v.state = "landing"; toast(`Over ${a.name}. Landing.`, "good"); }
        else toast(`Over ${a.name}. Nowhere clear to land: take the controls.`, "info");
        return;
    }
    body.yaw = v.yaw = st.yaw;
    flightWarp = autopilotWarp(km, v.y - carFloor(v.x, v.z, env), spec);
    for (let left = dt * flightWarp; left > 1e-6; left -= 0.2) stepCar(v, st.input, st.descend, Math.min(0.2, left), env, spec);
    // The campaign's clock runs with the warp (the street does not: nobody is on it up here).
    if (campaign && flightWarp > 1) campaign.dayClock += dt * (flightWarp - 1);
}

// --- The Cobra, explosions and destruction (al_cobra.ts, al_fx.ts, al_destruction.ts) -----------

/** The Cobra you took (null until you take one), its hull, cells and pods. */
let cobra: FlyingCar | null = null;
let cobraState: CobraState | null = null;
let cobraItem = "";
let missiles: Missile[] = [];
let nextMissile = 1;
const fx: FxState = newFx(11);
/** Broken building pieces and debris (al_destruction.ts), in the street's local frame. */
let pieces: Piece[] = [];
const damage = new Damage();
/** Ruined buildings on the street map: left out of the nav grid, drawn as their rubble. */
let ruinRects: Rect[] = [];
/** Street props blown away and plants scorched (keyed by where they stand), ground cover burned off. */
const blownProps = new Set<string>();
const scorchedProps = new Set<string>();
let burned: { x: number; z: number; r: number }[] = [];
/** Local-frame moves since the street map was laid out (prop keys stay put across rebases). */
let propShift: [number, number] = [0, 0];
let fxBatches: InstanceBatches | null = null;
/** Seconds until the street map is rebuilt after buildings fell (a few fall together). */
let navRebuild = 0;
const PIECE_LIMIT = 3000;
const COBRA_RANGE = 400;

/** The vehicle you are flying, if any. */
function driving(): FlyingCar | null { return playerCar?.piloting ? playerCar : cobra?.piloting ? cobra : null; }
const inCobra = (): boolean => !!cobra?.piloting;

function saveCobra(): void {
    if (!campaign || !frame || !cobra || !cobraState) return;
    const ll = dirToLatLon(toWorld(frame, cobra.x, cobra.y, cobra.z));
    campaign.player.cobra = { home: cobraState.home, lat: ll.lat, lon: ll.lon, yaw: cobra.yaw,
        altitude: Math.max(0, cobra.y - carGround(cobra.x, cobra.z, heightAt)), piloting: cobra.piloting, hull: cobraState.hull };
}

/** Your Cobra, parked: in the street map like your car. */
function addCobraObstacle(): void {
    if (!nav || !cobra || cobra.piloting) return;
    const p = cobra;
    nav.addRect({ cx: p.x, cz: p.z, ux: Math.cos(p.yaw), uz: -Math.sin(p.yaw), hw: 2.6, hd: 3.4,
        height: 2.6, base: p.y - 0.22, key: "al-cobra", door: [p.x, p.z], kind: "vehicle" });
}

/** Where a compound's own Cobra stands (local), facing its gate. */
function compoundCobraAt(p: PlacedCompound): [number, number] {
    const [u, v] = cobraSpot(p.layout);
    return compoundToLocal(p.cx, p.cz, p.cs.yaw, u, v);
}
function compoundCobraRect(p: PlacedCompound): Rect {
    const [x, z] = compoundCobraAt(p);
    const h = p.cs.yaw;
    return { cx: x, cz: z, ux: Math.cos(h), uz: -Math.sin(h), hw: 2.6, hd: 3.4, height: 2.6, base: heightAt(x, z) - 0.1,
        key: `al-cobra-${p.cs.id}`, door: [x, z], kind: "vehicle" };
}

/** The parked Cobra within reach: yours, or a compound's. */
function cobraInReach(reach = 6.5): { own: boolean; p: PlacedCompound | null; x: number; z: number; stairs?: boolean } | null {
    if (indoors) return null;
    let best: { own: boolean; p: PlacedCompound | null; x: number; z: number; stairs?: boolean } | null = null, bestD = reach;
    if (cobra && !cobra.piloting) {
        const d = Math.hypot(cobra.x - body.x, cobra.z - body.z);
        if (d < bestD && Math.abs(body.y - cobra.y) < 3) { bestD = d; best = { own: true, p: null, x: cobra.x, z: cobra.z }; }
        else if (atStairsTo(cobra)) { bestD = 0; best = { own: true, p: null, x: cobra.x, z: cobra.z, stairs: true }; }
    }
    for (const p of placedCompounds) {
        if (p.cs.cobraTaken) continue;
        const [x, z] = compoundCobraAt(p);
        const d = Math.hypot(x - body.x, z - body.z);
        if (d < bestD) { bestD = d; best = { own: false, p, x, z }; }
    }
    return best;
}

/** Climbs into a Cobra: yours, or a compound's (the garrison sees you take it). */
function boardCobra(at: NonNullable<ReturnType<typeof cobraInReach>>): void {
    if (!campaign) return;
    if (at.p) {
        // The one you leave behind goes back to its compound by morning (restoreCobras).
        const [x, z] = compoundCobraAt(at.p);
        at.p.cs.cobraTaken = true;
        cobra = newCar({ x, y: carGround(x, z, heightAt), z, yaw: at.p.cs.yaw });
        cobraState = newCobraState(at.p.cs.id);
        if (!at.p.cs.captured) alarm(street, x, z);
        toast("You take the Cobra! Solar missiles: LMB / RT at the crosshair.", "good");
    }
    const c = cobra!;
    c.piloting = true; body.x = c.x; body.y = c.y; body.z = c.z; body.yaw = c.yaw;
    triggerHeld = triggerFresh = false; lookDrag = null;
    buildNav(c.x, c.z);
    if (!at.p) toast("Space / A / Cross to rise. L / D-pad down to land.");
    scatterDirty = true;
    saveCobra();
}

/** How high the sun stands (its elevation's sine) by the day clock, as updateSun places it. */
function sunUp(): number {
    if (!campaign) return 0.5;
    const t = Math.max(0, Math.min(1, campaign.dayClock / DAY_SECONDS));
    return Math.sin((18 + 48 * Math.sin(Math.PI * t)) * Math.PI / 180);
}

/** What the crosshair is on: the point (local), and a soldier near the line, whom the missile tracks. */
function cobraTarget(): { point: Vec3; id: number | null } {
    const cam = lastCamera!;
    const eye = toLocal(frame!, cam.position);
    const dir = normalize(dirToLocal(frame!, sub(cam.target, cam.position)));
    const point = aimPoint(eye, dir, COBRA_RANGE, heightAt, nav?.rects ?? []);
    const reach = Math.hypot(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]) + 6;
    let id: number | null = null, best = 0.05;
    for (const a of soldiers(street)) {
        const v: Vec3 = [a.x - eye[0], a.y + 1 - eye[1], a.z - eye[2]];
        const d = Math.hypot(v[0], v[1], v[2]);
        if (d > reach || d < 1) continue;
        const ang = Math.acos(Math.max(-1, Math.min(1, dot(v, dir) / d)));
        if (ang < best) { best = ang; id = a.id; }
    }
    return { point, id };
}

/** Every live frame aboard the Cobra: the cells charge in the sun; the trigger fires missiles. */
function stepCobra(dt: number): void {
    if (!cobra || !cobraState || !frame || !campaign) return;
    chargeCobra(cobraState, dt, sunUp(), weather.cloudCover);
    const wants = (triggerHeld || controller.held.has("RightTrigger2")) && mode === "play" && !!lastCamera;
    if (!wants || cobraState.cooldown > 0) return;
    if (cobraState.cells < 1) {
        if (triggerFresh) toast("The solar cells are charging.", "info");
        triggerFresh = false;
        return;
    }
    triggerFresh = false;
    const t = cobraTarget();
    launch(t.point, t.id);
}

function launch(point: Vec3, id: number | null): Missile | null {
    if (!cobra || !cobraState || !campaign) return null;
    const m = fireMissile(cobra, cobraState, point, id, nextMissile++);
    if (!m) return null;
    missiles.push(m);
    if (region) {
        const rs = campaign.regions[region];
        if (!rs.war && rs.governor !== PARTY) rs.heat = Math.min(1, rs.heat + 0.006);
    }
    return m;
}

/** Missiles fly on (whoever fired them, wherever you are on the street). */
function stepMissilesNow(dt: number): Impact[] {
    if (!missiles.length) return [];
    for (const m of missiles) {
        const v = Math.hypot(m.vx, m.vy, m.vz) || 1;
        missileTrail(fx, m.x - m.vx / v * 0.9, m.y - m.vy / v * 0.9, m.z - m.vz / v * 0.9);
    }
    const hits = stepMissiles(missiles, dt, { height: heightAt, rects: nav?.rects ?? [],
        soldiers: soldiers(street).map(a => ({ id: a.id, x: a.x, y: a.y, z: a.z })) });
    for (const h of hits) detonate(h.x, h.y, h.z, 1, h);
    return hits;
}

/**
 * An explosion of `power` (1: a missile): fire and smoke, debris and a scorch mark; soldiers in the
 * blast are hurt (you too, on foot); buildings take damage and those that fail break apart; props
 * nearby are blown away and plants scorched.
 */
function detonate(x: number, y: number, z: number, power: number, impact?: Impact): { fell: number; killed: number } {
    if (!frame) return { fell: 0, killed: 0 };
    explode(fx, x, y, z, power, heightAt(x, z), [body.x, body.y + 1.6, body.z]);
    pieces.push(...debris(x, y, z, Math.round(6 + 4 * power), fx.rng));
    const radius = MISSILE_RADIUS * Math.sqrt(power);
    const killed = blastStreet(street, x, y, z, radius, MISSILE_DAMAGE * power, "party", !driving());
    handleStreetEvents();
    street.events.length = 0;
    let fell = 0;
    if (nav) {
        const res = damage.apply({ x, y, z, radius, damage: MISSILE_BUILDING_DAMAGE * power }, nav.rects);
        // A building hit hard enough catches fire where it was hit.
        for (const h of res.hurt) if (h.share > 0.3 && impact?.key === h.rect.key) ignite(fx, x, y, z, 0.6 + h.share, 25 + 40 * h.share, h.rect.key);
        for (const r of res.fell) collapse(r, x, y, z);
        fell = res.fell.length;
    }
    blowProps(x, z, radius);
    trimPieces();
    return { fell, killed };
}

/** A building breaks apart: its model goes, and a shell of its pieces comes down in its place. */
function collapse(r: Rect, bx: number, by: number, bz: number): void {
    const c = campaign;
    if (c) addRuin((c.ruins ??= {}), r.key, c.day);
    const look = buildingLook(r, buildingByKey.get(r.key)?.colour ?? null);
    const shell = shellPieces(r, look, fx.rng);
    breakApart(shell, bx, Math.max(by, r.base + 1), bz, 16, fx.rng);
    pieces.push(...shell);
    dustCloud(fx, r.cx, r.base, r.cz, Math.max(r.hw, r.hd) * 2, r.height);
    const fires = Math.min(4, 1 + Math.floor(r.hw * r.hd / 60));
    for (let i = 0; i < fires; i++) {
        const u = (fx.rng.next() - 0.5) * r.hw * 1.4, v = (fx.rng.next() - 0.5) * r.hd * 1.4;
        const x = r.cx + r.ux * u - r.uz * v, z = r.cz + r.uz * u + r.ux * v;
        ignite(fx, x, heightAt(x, z), z, 1.2 + fx.rng.next() * 1.3, 60 + fx.rng.next() * 60, r.key);
    }
    fx.shake = Math.min(1, fx.shake + 0.6 * Math.max(0, 1 - Math.hypot(r.cx - body.x, r.cz - body.z) / 160));
    if (indoors && indoors.rect.key === r.key) leaveHouse();
    updateExclusions();
    navRebuild = navRebuild > 0 ? navRebuild : 0.2;
    scatterDirty = true;
    if (!c) return;
    if (isMilitary(r)) toast("A compound building comes down.", "good");
    else {
        // The city counts the cost (nobody is inside: the people fled the shooting).
        addKarma(c, -1);
        if (region) { const rs = c.regions[region]; rs.support[PARTY] = Math.max(0, rs.support[PARTY] - 0.001); }
        toast("A building comes down. The city counts the cost.", "bad");
    }
}

/** Keeps the pieces in check: spent debris first, then the oldest rubble beyond the limit. */
function trimPieces(): void {
    if (pieces.length <= PIECE_LIMIT) return;
    const excess = pieces.length - PIECE_LIMIT;
    let debrisLeft = pieces.filter(p => p.life !== undefined).length;
    let drop = excess;
    pieces = pieces.filter(p => { if (drop > 0 && p.life !== undefined && debrisLeft-- > 0) { drop--; return false; } return true; });
    if (drop > 0) pieces.splice(0, drop);
}

/** Buildings no longer drawn: every ruin's model (their boxes fold away with the rest). */
function updateExclusions(): void {
    const keys = new Set(Object.keys(campaign?.ruins ?? {}));
    houses?.setExcluded(keys);
    buildings?.setExcluded(keys);
}

/** Ruins on the street map without pieces (come back to): their settled rubble. */
function ensureRubble(): void {
    const ruins = campaign?.ruins ?? {};
    // Rebuilt ruins' pieces go, and far-off ones.
    pieces = pieces.filter(p => (p.life !== undefined || ruins[p.key] !== undefined) && Math.hypot(p.x - body.x, p.z - body.z) < 900);
    const have = new Set(pieces.map(p => p.key));
    for (const r of ruinRects) {
        if (have.has(r.key)) continue;
        pieces.push(...rubblePile(r, buildingLook(r, buildingByKey.get(r.key)?.colour ?? null), heightAt));
    }
    trimPieces();
}

const propSpot = (it: ScatterItem): string => `${it.family}@${(it.x + propShift[0]).toFixed(1)},${(it.z + propShift[1]).toFixed(1)}`;
/** Props a blast knocks flat: everything planted that isn't a plant or a compound's. */
const unbreakable = new Set(["beacon", "flag", "cobra", "loot"]);
const isPlantFamily = (family: string): boolean => !PROPS[family];

function blowProps(x: number, z: number, radius: number): void {
    let changed = false;
    for (const it of scatterItems) {
        const d = Math.hypot(it.x - x, it.z - z);
        if (d > radius) continue;
        const k = propSpot(it);
        if (isPlantFamily(it.family)) {
            if (d < radius * 0.9 && !scorchedProps.has(k)) { scorchedProps.add(k); changed = true; }
        } else if (!unbreakable.has(it.family) && !it.family.startsWith("mil-") && !blownProps.has(k)) {
            blownProps.add(k);
            pieces.push(...debris(it.x, heightAt(it.x, it.z) + 0.4, it.z, 4, fx.rng, "concrete", [0.5, 0.42, 0.34]));
            changed = true;
        }
    }
    burned.push({ x, z, r: radius * 0.75 });
    if (burned.length > 64) burned.shift();
    lawnAt = [Infinity, Infinity];
    if (changed) applyPropDamage();
    scatterDirty = true;
}

/** Blown props are gone and scorched plants charred (again, after the set dressing is replanted). */
function applyPropDamage(): void {
    if (!blownProps.size && !scorchedProps.size) return;
    scatterItems = scatterItems.filter(it => !blownProps.has(propSpot(it)));
    for (const it of scatterItems) {
        if (!scorchedProps.has(propSpot(it)) || it.tint[0] < 0.3) continue;
        it.tint = [0.22, 0.19, 0.16];
        scatterPlaced.delete(it);
    }
}

/** The Cobra's hull failed: it explodes, its wreck burns, and if you were aboard you are thrown clear. */
function wreckCobra(): void {
    if (!cobra || !campaign) return;
    const { x, y, z } = cobra;
    const aboard = cobra.piloting;
    cobra = null; cobraState = null;
    street.player.hull = undefined;
    campaign.player.cobra = null;
    explode(fx, x, y + 1, z, 2.5, heightAt(x, z), [body.x, body.y + 1.6, body.z]);
    pieces.push(...debris(x, y + 1, z, 18, fx.rng, "metal", [0.3, 0.34, 0.28]));
    ignite(fx, x, heightAt(x, z), z, 2, 45);
    blastStreet(street, x, y + 1, z, 10, 120, "party", false);
    handleStreetEvents();
    street.events.length = 0;
    if (aboard) {
        const spot = nav?.nearestWalkable(x + 4, z + 4, 30) ?? [x + 4, z + 4];
        body.x = spot[0]; body.z = spot[1]; body.y = heightAt(body.x, body.z); body.vy = 0; body.grounded = true;
        street.player.x = body.x; street.player.z = body.z; street.player.y = body.y;
        street.player.health = Math.max(1, street.player.health - 35);
        campaign.player.health = street.player.health;
        buildNav(body.x, body.z);
    }
    toast(aboard ? "The Cobra is wrecked! You are thrown clear." : "Your Cobra has been destroyed.", "bad");
    save();
}

/** Particles, pieces, scorch marks and missiles: one instanced draw per mesh. */
function drawFx(): void {
    if (!fxBatches) return;
    fxBatches.begin();
    const visible = !!frame && (mode === "play" || mode === "speech" || mode === "dialogue" || mode === "shop");
    if (visible) {
        const f = frame!, o = renderOrigin, E = f.east, U = f.up, N = f.north;
        // A record from local axes (three columns), sizes, tint and tex_origin. The third column is
        // negated: the local frame (east, up, north) is left-handed in world space.
        const put = (mesh: string, x: number, y: number, z: number, ax: readonly number[], sx: number, sy: number, sz: number,
            t0: number, t1: number, t2: number, t3: number, e0: number, e3: number) => {
            const { data, offset: q } = fxBatches!.add(propKey(mesh));
            for (let k = 0; k < 3; k++) {
                data[q + k] = (E[k] * ax[0] + U[k] * ax[1] + N[k] * ax[2]) * sx;
                data[q + 4 + k] = (E[k] * ax[3] + U[k] * ax[4] + N[k] * ax[5]) * sy;
                data[q + 8 + k] = -(E[k] * ax[6] + U[k] * ax[7] + N[k] * ax[8]) * sz;
                data[q + 12 + k] = f.origin[k] + E[k] * x + U[k] * y + N[k] * z - o[k];
            }
            data[q + 3] = 0; data[q + 7] = 0; data[q + 11] = 0; data[q + 15] = 1;
            data[q + 16] = t0; data[q + 17] = t1; data[q + 18] = t2; data[q + 19] = t3;
            data[q + 20] = e0; data[q + 21] = 0; data[q + 22] = 0; data[q + 23] = e3;
        };
        const spin = (a: number) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 1, 0, s, 0, c]; };
        for (const p of pieces) {
            if (Math.abs(p.x - body.x) > 700 || Math.abs(p.z - body.z) > 700) continue;
            const sink = p.life !== undefined ? Math.max(0, p.age - (p.life - 1)) * 0.6 : 0;
            put(`chunk-${p.surface}`, p.x, p.y - sink, p.z, pieceAxes(p), p.w, p.h, p.d, p.tint[0], p.tint[1], p.tint[2], 0, 0, -1);
        }
        for (const p of fx.particles) {
            const op = particleOpacity(p);
            if (op <= 0.02) continue;
            const ax = spin(p.spin);
            if (p.kind === "smoke") { put("fx-smoke", p.x, p.y, p.z, ax, p.size, p.size, p.size, p.tint[0], p.tint[1], p.tint[2], 0, 0, op); continue; }
            const g = particleGlow(p);
            if (p.kind === "spark") put("fx-spark", p.x, p.y, p.z, ax, p.size, p.size, p.size, g.tint[0], g.tint[1], g.tint[2], g.heat, p.spin, op);
            else if (p.flame) put("fx-flame", p.x, p.y - p.size * 0.3, p.z, ax, p.size, p.size * 2.4, p.size, g.tint[0], g.tint[1], g.tint[2], g.heat, p.spin, op);
            else put("fx-fire", p.x, p.y, p.z, ax, p.size, p.size, p.size, g.tint[0], g.tint[1], g.tint[2], g.heat, p.spin, op);
        }
        for (const sc of fx.scorches) put("fx-scorch", sc.x, heightAt(sc.x, sc.z), sc.z, spin(sc.yaw), sc.radius, 1, sc.radius, 1, 1, 1, 0, 0, 0);
        for (const m of missiles) {
            // Model -z along its flight: columns right, up, forward (a right-handed set in local axes).
            const v = Math.hypot(m.vx, m.vy, m.vz) || 1;
            const fw: Vec3 = [m.vx / v, m.vy / v, m.vz / v];
            let rt = cross([0, 1, 0], fw);
            if (length(rt) < 1e-4) rt = [1, 0, 0];
            rt = normalize(rt);
            const up2 = cross(fw, rt);
            put("fx-missile", m.x, m.y, m.z, [...rt, ...up2, ...fw], 1, 1, 1, 1, 1, 1, 1.2, 0, 0);
        }
    }
    fxBatches.flush();
}

// --- Comrades: their cars (al_convoy.ts), orders, and where townspeople walk ---------------------

let convoy: ConvoyCar[] = [];
const convoyItems: string[] = [];

/** Comrades who go where you go: followers on foot or riding, not told to hold a spot. */
const crew = (): Actor[] => street.actors.filter(a => a.kind === "follower" && alive(a) && !a.hold);

/**
 * Every live frame: with you in the air, your comrades ride in their own cars in formation; with you
 * down (parked, or out of the car), the cars set down beside you and the comrades climb out.
 */
function stepConvoy(dt: number): void {
    if (!frame || !campaign) return;
    const lead = driving();
    const env = flightEnvironment();
    const spec = carSpec(campaign.player.carUpgrades);
    const above = lead ? lead.y - carFloor(lead.x, lead.z, env) : 0;
    const phase = !lead || lead.state === "parked" ? "land" : above > 2.5 ? "fly" : "wait";
    if (phase === "fly") {
        const people = crew();
        // Cars enough for everyone: new ones stand where the comrades are, and lift off with them.
        while (convoy.length < convoySize(people.length)) {
            const free = people.filter(a => a.aboard == null);
            const at: [number, number] = free.length ? [free.reduce((s, a) => s + a.x, 0) / free.length, free.reduce((s, a) => s + a.z, 0) / free.length] : [lead!.x, lead!.z];
            const spot = nav?.nearestWalkable(at[0], at[1], 10) ?? at;
            convoy.push(convoyCar(spot[0], spot[1], lead!.yaw, env));
        }
        for (const v of convoy) v.riders = v.riders.filter(id => people.some(a => a.id === id && a.aboard != null));
        for (const a of people) {
            if (a.aboard != null) continue;
            const i = convoy.findIndex(v => v.riders.length < CONVOY_SEATS);
            if (i < 0) break;
            convoy[i].riders.push(a.id);
            a.aboard = i; a.path = []; a.state = "follow";
        }
        convoy.forEach((v, i) => { v.car.call = null; for (let left = dt * flightWarp; left > 1e-6; left -= 0.2) stepEscort(v.car, i, lead!, Math.min(0.2, left), env, spec); });
    } else if (phase === "land") {
        const anchor = lead ?? { x: body.x, z: body.z, yaw: body.yaw };
        convoy.forEach((v, i) => {
            const c = v.car;
            if (c.state === "parked" && !c.call) { disembark(v); return; }
            if (!c.call) {
                // A clear spot near its place in the formation, open to the sky, clear of the others.
                const [sx, sz] = escortSlot(i, anchor);
                const taken = (x: number, z: number) => (!!playerCar && Math.hypot(x - playerCar.x, z - playerCar.z) < 7)
                    || (!!cobra && Math.hypot(x - cobra.x, z - cobra.z) < 8)
                    || convoy.some((o, j) => j !== i && Math.hypot(x - (o.car.call?.x ?? o.car.x), z - (o.car.call?.z ?? o.car.z)) < 7);
                const spot = parkBeside(sx, sz, (x, z) => (nav?.walkable(x, z) ?? !isSea(x, z)) && !isSea(x, z), heightAt,
                    car => openSky(car, nav?.rects ?? []) && !taken(car.x, car.z));
                if (!spot) { c.x = sx; c.z = sz; c.y = carGround(sx, sz, heightAt); c.vx = c.vy = c.vz = 0; c.state = "parked"; disembark(v); return; }
                callCar(c, spot.car, env, spec);
            }
            if (stepCall(c, dt, env, spec)) disembark(v);
        });
        // Empty cars left far behind are gone (they flew home).
        convoy = convoy.filter(v => v.riders.length || v.car.state !== "parked" || Math.hypot(v.car.x - body.x, v.car.z - body.z) < 1500);
    } else {
        // Taking off or hovering low: escorts already up keep station.
        convoy.forEach((v, i) => { if (v.car.state !== "parked" && !v.car.call) stepEscort(v.car, i, lead!, dt, env, spec); });
    }
    // Riders go where their car goes (so they climb out where it lands).
    for (const v of convoy) for (const id of v.riders) {
        const a = actorById(street, id);
        if (a) { a.x = v.car.x; a.z = v.car.z; a.y = v.car.y; }
    }
}

/** A landed car's riders climb out around it and fall in behind you. */
function disembark(v: ConvoyCar): void {
    v.riders.forEach((id, k) => {
        const a = actorById(street, id);
        if (!a) return;
        const ang = v.car.yaw + Math.PI / 2 + k * Math.PI / 2;
        const x = v.car.x + Math.sin(ang) * 4.2, z = v.car.z + Math.cos(ang) * 4.2;
        const p = nav?.nearestWalkable(x, z, 6) ?? [x, z];
        a.aboard = null; a.x = p[0]; a.z = p[1]; a.y = heightAt(p[0], p[1]); a.path = []; a.state = "follow";
    });
    v.riders = [];
}

/** Everyone out at once, where you are (respawn, travel). */
function clearConvoy(): void {
    for (const a of street.actors) if (a.aboard != null) { a.aboard = null; a.x = body.x + 2; a.z = body.z - 3; a.path = []; }
    convoy = [];
}

/**
 * T: comrades on foot hold the spot under the crosshair (or where you stand), or, holding already,
 * fall in behind you again.
 */
function orderHold(): void {
    if (!frame) return;
    const onFoot = street.actors.filter(a => a.kind === "follower" && alive(a) && a.aboard == null);
    if (!onFoot.length) { toast("No comrades with you.", "info"); return; }
    if (onFoot.some(a => a.hold)) { orderComrades(street, null); toast(`${onFoot.length} comrade${onFoot.length === 1 ? "" : "s"} fall in behind you.`, "good"); return; }
    let at: [number, number] = [body.x, body.z];
    if (lastCamera) {
        const eye = toLocal(frame, lastCamera.position);
        const p = aimPoint(eye, normalize(dirToLocal(frame, sub(lastCamera.target, lastCamera.position))), 80, heightAt, nav?.rects ?? []);
        at = nav?.nearestWalkable(p[0], p[2], 8) ?? [p[0], p[2]];
    }
    const n = orderComrades(street, at);
    toast(`${n} comrade${n === 1 ? "" : "s"} hold ${Math.round(Math.hypot(at[0] - body.x, at[1] - body.z))} m away. T again to call them back.`, "good");
}

/**
 * Where townspeople walk: every building's door, and the pavements along the streets near
 * buildings (both edges, every 12 m). Open country has none.
 */
function streetPointsFrom(g: NavGrid, roads: RoadMask | undefined): [number, number][] {
    const out: [number, number][] = [];
    const cell = 50, doors = new Set<number>();
    const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
    for (const r of g.rects) {
        if (r.key.startsWith("al-") || r.kind === "military" || r.kind === "vehicle") continue;
        if (!g.walkable(r.door[0], r.door[1])) continue;
        out.push([r.door[0], r.door[1]]);
        doors.add(key(Math.floor(r.door[0] / cell), Math.floor(r.door[1] / cell)));
    }
    const nearDoor = (x: number, z: number) => {
        const i = Math.floor(x / cell), j = Math.floor(z / cell);
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (doors.has(key(i + di, j + dj))) return true;
        return false;
    };
    for (const sg of roads?.list ?? []) {
        const dx = sg.bx - sg.ax, dz = sg.bz - sg.az, len = Math.hypot(dx, dz);
        if (len < 1) continue;
        const nx = -dz / len, nz = dx / len, off = sg.half + 1.6;
        for (let t = 0; t <= len; t += 12) {
            const cx = sg.ax + dx / len * t, cz = sg.az + dz / len * t;
            if (!nearDoor(cx, cz)) continue;
            for (const side of [-1, 1]) {
                const x = cx + nx * off * side, z = cz + nz * off * side;
                if (g.walkable(x, z)) out.push([x, z]);
            }
        }
    }
    return out;
}

let urbanTimer = 99;
/** How many townspeople the streets around you carry: a third of the street points within 130 m. */
function stepUrban(dt: number): void {
    urbanTimer += dt;
    if (urbanTimer < 2) return;
    urbanTimer = 0;
    const pts = street.streetPoints;
    if (!pts) { street.urbanCap = Infinity; return; }
    let n = 0;
    for (const [x, z] of pts) if ((x - body.x) ** 2 + (z - body.z) ** 2 < 130 * 130) n++;
    street.urbanCap = Math.min(CIVILIAN_TARGET, Math.round(n / 3));
}

// --- Invasions on the march, and sending troops --------------------------------------------------

/** The invasion marching on a party region (the soonest), if any. */
function marchingThreat(): { id: string; threat: NonNullable<RegionState["threat"]> } | null {
    const c = campaign;
    if (!c) return null;
    let best: { id: string; threat: NonNullable<RegionState["threat"]> } | null = null;
    for (const rs of Object.values(c.regions)) {
        if (!rs.threat || rs.governor !== PARTY) continue;
        if (!best || rs.threat.day < best.threat.day) best = { id: rs.id, threat: rs.threat };
    }
    return best;
}

/** Sends `share` of the party's troops from everywhere else to `to`: to take it (war) or hold it. */
function dispatch(to: string, share: number): void {
    const c = campaign;
    if (!c) return;
    const def = regionDefById(to);
    const rs = c.regions[to];
    if (!def || !rs) return;
    const res = dispatchTroops(c, to, share);
    if (!res.moved) { toast("No troops to send. Arm members in COMMAND > TERRITORY.", "bad"); return; }
    const sent = `${fmtTroops(res.moved)} troops from ${res.from} region${res.from === 1 ? "" : "s"}`;
    if (rs.governor === PARTY) {
        const t = rs.threat;
        toast(t ? `${sent} march to ${def.name}: they meet the ${factionById(t.attacker).short} column at dawn (${Math.round(defenseRatio(c, rs, t.force) * 100)}% of what it takes to turn it back).`
            : `${sent} dig in at ${def.name}.`, "good");
    } else if (!rs.war && rs.army >= 10) {
        const err = declareWar(c, to);
        toast(err ? `${sent} reach ${def.name}. ${err}` : `${sent} march on ${def.name}. War is declared!`, err ? "info" : "good");
    } else toast(`${sent} reach ${def.name}${rs.war ? " and join the war" : ""}.`, "good");
}

const fmtTroops = (n: number) => n.toLocaleString("en-US");

let podiumAt: { x: number; z: number; yaw: number } | null = null;

function drawProps(): void {
    if (!frame) return;
    const color = campaign?.party.color ?? THEME.red;
    if (mode === "speech" && speech) {
        if (!podiumAt) podiumAt = { x: body.x, z: body.z, yaw: body.yaw };
        const fx = Math.sin(podiumAt.yaw), fz = Math.cos(podiumAt.yaw);
        writeItem(podiumItem, personMatrix(podiumAt.x + fx * 0.75, heightAt(podiumAt.x + fx * 0.75, podiumAt.z + fz * 0.75), podiumAt.z + fz * 0.75, podiumAt.yaw, false), [color[0], color[1], color[2], 0]);
        const sx = podiumAt.x - Math.cos(podiumAt.yaw) * 2.2, sz = podiumAt.z + Math.sin(podiumAt.yaw) * 2.2;
        writeItem(flagItem, personMatrix(sx, heightAt(sx, sz), sz, podiumAt.yaw + Math.PI / 2, false), [color[0], color[1], color[2], 0]);
        showProp("al-podium", true);
        showProp("al-flag", true);
    } else {
        podiumAt = null;
        showProp("al-podium", false);
        showProp("al-flag", false);
    }
    // Tracers: party rounds on even slots, enemy rounds on odd ones.
    let even = 0, odd = 1;
    for (const s of street.shots) {
        const slot = s.side === "party" ? even : odd;
        if (slot >= TRACERS) continue;
        if (s.side === "party") even += 2; else odd += 2;
        const a = toWorld(frame, s.ax, s.ay, s.az), b = toWorld(frame, s.bx, s.by, s.bz);
        const len = distance(a, b);
        if (len < 0.1) continue;
        const f = normalize(sub(b, a));
        const helper: Vec3 = Math.abs(dot(f, frame.up)) > 0.95 ? frame.east : frame.up;
        const r = normalize(cross(f, helper));
        const u = cross(r, f);
        const w = 0.025;
        const p = toRender(a);
        writeItem(tracerItems[slot], [r[0] * w, r[1] * w, r[2] * w, 0, u[0] * w, u[1] * w, u[2] * w, 0, -f[0] * len, -f[1] * len, -f[2] * len, 0, p[0], p[1], p[2], 1], [1, 1, 1, 1.5]);
        showProp(`al-tracer-${slot}`, true);
    }
    for (let i = even; i < TRACERS; i += 2) showProp(`al-tracer-${i}`, false);
    for (let i = odd; i < TRACERS; i += 2) showProp(`al-tracer-${i}`, false);
}

function hideWorld(): void {
    crowd?.clear();
    personLods.clear();
    lodCounts = [0, 0, 0];
}

// --- Camera, sun and world uniform ---------------------------------------------------------------

let titleAngle = 0;

function cameraForMode(dt: number): { position: Vec3; target: Vec3; up: Vec3 } {
    if (mode === "title" || mode === "setup" || !frame) {
        // Earth from orbit, turning slowly.
        titleAngle += dt * 0.02;
        const dir = normalize([Math.sin(titleAngle), 0.35, Math.cos(titleAngle)]);
        setSunDirection(normalize(add(dir, [0.4, 0.3, 0])));
        return { position: scale(dir, EARTH.radius * 2.7), target: [0, 0, 0], up: [0, 1, 0] };
    }
    if (mode === "loading") {
        // Over the destination, looking across the city as it streams in.
        const yaw = (time * 0.05) % (Math.PI * 2);
        const eye = toWorld(frame, Math.sin(yaw) * -40, heightAt(0, 0) + 25, Math.cos(yaw) * -40);
        return { position: eye, target: toWorld(frame, 0, heightAt(0, 0) + 2, 0), up: frame.up };
    }
    // A speech is filmed from the crowd's side, looking back at the speaker and the podium.
    // First person on foot; the flying car and speeches are always filmed from outside.
    const cam = bodyCamera(driving() ? { ...body, firstPerson: false, camDistance: inCobra() ? 15 : 12 } : mode === "speech" ? { ...body, firstPerson: false } : body, heightAt, mode === "speech" ? 2.7 : 0);
    if (mode === "speech") return { position: toWorld(frame, ...cam.eye), target: toWorld(frame, body.x, body.y + 1.5, body.z), up: frame.up };
    return { position: toWorld(frame, ...cam.eye), target: toWorld(frame, ...cam.target), up: frame.up };
}

function updateSun(): void {
    if (!frame || !campaign || mode === "title" || mode === "setup") return;
    const t = Math.max(0, Math.min(1, campaign.dayClock / DAY_SECONDS));
    const el = (18 + 48 * Math.sin(Math.PI * t)) * Math.PI / 180;
    const horiz = normalize(add(scale(frame.east, Math.cos(Math.PI * t)), scale(frame.north, -0.45 * Math.sin(Math.PI * t))));
    setSunDirection(normalize(add(scale(frame.up, Math.sin(el)), scale(horiz, Math.cos(el)))));
    weather = weatherHold ?? weatherAt(region ?? "street", campaign.day, t);
    cloudAltitude = Math.max(0, sampleEarth(normalize(focus)).surface) + 2700;
}

/** The sun's color: warmer and weaker the lower it stands. */
function sunColor(): [number, number, number] {
    if (!frame) return [1.0, 0.96, 0.9];
    const k = Math.max(0, Math.min(1, (dot(SUN_DIRECTION, frame.up) - 0.25) / 0.5));
    const e = k * k * (3 - 2 * k);
    return [1.0, 0.8 + 0.17 * e, 0.62 + 0.3 * e];
}

/** This frame's sun-shadow cascades around the camera (none off the street or with the sun down). */
/** What was last sent: map size, depth range, then each cascade's texel and matrix. */
let shadowSent: number[] = [];
const SHADOW_REFRESH = [1, 1, 2, 4];
function updateShadows(): void {
    const on = shadowsEnabled && !!frame && !!lastCamera && mode !== "title" && mode !== "setup" && mode !== "loading"
        && dot(SUN_DIRECTION, frame.up) > 0.04;
    if (!on) {
        if (shadowsLive) { Entropy.Lighting.setSunShadows({ cascades: [] }); shadowsLive = false; shadowSent = []; }
        return;
    }
    const cam = lastCamera!;
    const c = shadowCascades(toRender(cam.position), normalize(sub(cam.target, cam.position)), SUN_DIRECTION, SHADOW_RADII.slice(0, shadowCascadeCount), shadowMapSize);
    // Texel-snapped cascades hold still while the view barely moves: nothing to send then.
    const sent = [shadowMapSize, c.depthRange, ...c.texel, ...c.cascades.flat()];
    if (shadowsLive && sent.length === shadowSent.length && sent.every((v, i) => v === shadowSent[i])) return;
    shadowSent = sent;
    // The two far cascades (140 and 520 m: buildings, trees; no people) refresh every 2nd and
    // 4th frame while they hold still: their swaying crowns move a fraction of a texel meanwhile.
    Entropy.Lighting.setSunShadows({ ...c, strength: 1, mapSize: shadowMapSize, refresh: SHADOW_REFRESH });
    shadowsLive = true;
}

function writeWorld(): void {
    const world = packWorld({
        sunDir: SUN_DIRECTION, time, sunColor: sunColor(), exposure: 1.05, debugLod: false, debugOutlines: false,
        planets: WORLD_PLANETS.map(p => ({ center: toRender(p.center), radius: p.radius, atmosphere: p.atmosphereColor, atmosphereHeight: p.atmosphereHeight })),
        city: { hideRadius, roadDistance: ROAD_DISTANCE, buildingHideRadius },
        weather: frame && mode !== "title" && mode !== "setup" ? {
            cloudCover: weather.cloudCover, cloudOffset: cloudOffset(renderOrigin, cloudDrift), cloudAltitude,
            wind: windVector(weather, frame.east, frame.north),
        } : undefined,
    });
    // Reserved sun_color.w carries a profiler-only shader disable selector; normal rendering is 0.
    world[7] = PROFILE_SHADER_DISABLE[profileDisable] ?? 0;
    world[15 + MAX_PLANETS * 8] = cloudCacheEnabled ? 1 : 0;
    Entropy.Buffer.write(worldBuffer, world);
    updateShadows();
}

function stream(maxBuilds: number, maxMs: number): void {
    stats = Entropy.QuadPlanet.update(terrainId, focus, { renderOrigin, maxBuilds, maxMs });
}

/**
 * Level-of-detail limits for the Mesha houses and city blocks (qp_city.ts CityOptions), on foot and
 * in the air. Full houses (rooms and all, ~150k triangles) only for the nearest two or three.
 */
const HOUSE_LOD = { lod0Radius: 35, maxLod0: 3, lod1Radius: 220, triangleBudget: 1_500_000 };
const HOUSE_LOD_AIR = { lod0Radius: 0, maxLod0: 0, lod1Radius: 220, triangleBudget: 1_200_000 };
const BUILDING_LOD = { lod0Radius: 70, maxLod0: 24, lod1Radius: 500, triangleBudget: 2_500_000 };
const BUILDING_LOD_AIR = { lod0Radius: 0, maxLod0: 0, lod1Radius: 500, triangleBudget: 2_000_000 };
type LodLimits = typeof HOUSE_LOD;
/** On-foot limits set by allegiance_config (houseLod / buildingLod); null: the defaults above. */
let houseLod: LodLimits | null = null;
let buildingLod: LodLimits | null = null;

function updateHouses(buildMs: number): void {
    if (!houses) return;
    const c = stats?.city;
    if (!c || !frame || mode === "title" || mode === "setup") {
        if (hideRadius > 0) houses.clear();
        if (buildingHideRadius > 0) buildings?.clear();
        hideRadius = buildingHideRadius = 0;
        return;
    }
    const cam = lastCamera?.position ?? focus;
    // In a flying car (or the Cobra) every house and block is its simplified exterior, however close:
    // from the air nobody sees into the rooms, and full models are 10-30 times the triangles.
    const air = !!driving();
    houses.configure(air ? HOUSE_LOD_AIR : houseLod ?? HOUSE_LOD);
    buildings?.configure(air ? BUILDING_LOD_AIR : buildingLod ?? BUILDING_LOD);
    hideRadius = houses.update(cam, renderOrigin, c.live * 1_000_003 + c.buildings, buildMs);
    if (buildings) buildingHideRadius = buildings.update(cam, renderOrigin, c.live * 1_000_003 + c.buildings, buildMs);
}

// --- UI ------------------------------------------------------------------------------------------

let ui: UiFrame | null = null;
let uiTimer = 0;

function drawUi(dt: number, force = false): void {
    if (!ui) return;
    uiTimer += dt;
    // The HUD changes slowly; the speech's timing bar needs to be smooth.
    const interval = mode === "speech" ? 1 / 30 : mode === "play" || mode === "dialogue" ? 0.1 : 1 / 20;
    if (!force && uiTimer < interval) return;
    uiTimer = 0;
    const [W, H] = Entropy.Window.getSize();
    ui.W = W; ui.H = H;
    ui.handlers.clear();
    if (controllerFocus) ui.p.hover = controllerFocus;
    ui.p.begin();
    drawScreen(view(), ui);
    ui.p.flush();
}

// --- Military compounds --------------------------------------------------------------------------

/** A compound near you, laid out in the local frame: its structures as nav rectangles and its flag. */
interface PlacedCompound { cs: CompoundState; layout: CompoundLayout; cx: number; cz: number; rects: Rect[]; flag: [number, number]; posts: [number, number][] }
let placedCompounds: PlacedCompound[] = [];
let compoundTimer = 0;
let compoundSig = "";
const captureProgress = new Map<string, { raise: number }>();
let captureView: { name: string; defenders: number; raise: number; state: string } | null = null;

function localOf(lat: number, lon: number): [number, number] {
    const p = toLocal(frame!, surfaceAt(lat, lon));
    return [p[0], p[2]];
}

function compoundName(cs: CompoundState): string {
    const town = regionDefById(cs.settlement)?.name ?? "the town";
    return cs.kind === "outpost" ? `the ${town} outpost` : `${town} garrison`;
}

function placeCompound(cs: CompoundState): PlacedCompound {
    const [cx, cz] = localOf(cs.lat, cs.lon);
    const layout = compoundLayout(cs);
    const rects: Rect[] = layout.structures.map((st, i) => {
        const [x, z] = compoundToLocal(cx, cz, cs.yaw, st.x, st.z);
        const h = st.yaw + cs.yaw;
        const ux = Math.cos(h), uz = -Math.sin(h), fx = Math.sin(h), fz = Math.cos(h);
        return { cx: x, cz: z, ux, uz, hw: st.w / 2, hd: st.d / 2, height: st.h, base: heightAt(x, z) - 0.3, key: `al-mil-${cs.id}-${i}`,
            door: [x + fx * (st.d / 2 + 1.6), z + fz * (st.d / 2 + 1.6)], kind: "military" };
    });
    const flag = compoundToLocal(cx, cz, cs.yaw, layout.flag[0], layout.flag[1]);
    const posts = layout.posts.map(([x, z]) => compoundToLocal(cx, cz, cs.yaw, x, z));
    return { cs, layout, cx, cz, rects, flag, posts };
}

/** Rectangles of the compounds standing near you (added to the street map). */
const compoundRects = (): Rect[] => placedCompounds.flatMap(p => p.cs.cobraTaken ? p.rects : [...p.rects, compoundCobraRect(p)]);

/** Inside (or right next to) a compound's walls. */
function inCompound(x: number, z: number, pad = 6): PlacedCompound | null {
    for (const p of placedCompounds) if (Math.hypot(x - p.cx, z - p.cz) < p.layout.radius + pad) return p;
    return null;
}

function nearbySettlements(lat: number, lon: number, km: number) {
    return campaignRegions(campaign!).filter(d => angularDistance(lat, lon, d.lat, d.lon) * EARTH_RADIUS_KM < km);
}

/** Once a second: makes compounds near you, moves new ones onto clear ground, lays them out. */
function updateCompounds(): void {
    const c = campaign;
    if (!c || !frame || !nav) return;
    const near = compoundsNear(c, c.player.lat, c.player.lon, 1.5, nearbySettlements(c.player.lat, c.player.lon, 8));
    let moved = false;
    const half = NAV_SIZE * NAV_CELL / 2;
    for (const cs of near) {
        if (cs.sited) continue;
        const [x, z] = localOf(cs.lat, cs.lon);
        const radius = compoundLayout(cs).radius + 4;
        if (Math.abs(x - nav.cx) > half - radius - 30 || Math.abs(z - nav.cz) > half - radius - 30) continue;
        // Clear of buildings, water and other compounds; stay off the spawn point and your car.
        const others = placedCompounds.filter(p => p.cs.id !== cs.id);
        const site = findClearSite((px, pz) => nav!.walkable(px, pz) && !isSea(px, pz) && !others.some(p => Math.hypot(px - p.cx, pz - p.cz) < p.layout.radius + radius)
            && Math.hypot(px - body.x, pz - body.z) > 8 && (!playerCar || Math.hypot(px - playerCar.x, pz - playerCar.z) > 8), x, z, radius, 220);
        if (site) {
            const ll = dirToLatLon(toWorld(frame, site[0], heightAt(site[0], site[1]), site[1]));
            cs.lat = ll.lat; cs.lon = ll.lon;
        }
        cs.sited = true;
        moved = true;
    }
    placedCompounds = near.filter(cs => cs.sited).map(placeCompound).filter(p => Math.hypot(p.cx - body.x, p.cz - body.z) < 700);
    const sig = placedCompounds.map(p => `${p.cs.id}:${p.cx.toFixed(0)},${p.cz.toFixed(0)}`).join("|");
    if (moved || sig !== compoundSig) { compoundSig = sig; buildNav(nav.cx, nav.cz); }
}

/** Every frame: garrisons at their posts, the assault and the flag. */
function stepCompounds(dt: number): void {
    const c = campaign;
    captureView = null;
    if (!c || !frame) return;
    let nearest: PlacedCompound | null = null, nearestD = Infinity;
    for (const p of placedCompounds) {
        const d = Math.hypot(p.cx - body.x, p.cz - body.z);
        if (p.cs.captured) continue;
        if (d < 170 && mode === "play" || d < 170 && mode === "dialogue") {
            // Keep a few defenders out at once; more come out as they fall.
            const alive = guardsOf(street, p.cs.id).length;
            const want = Math.min(GUARDS_AT_ONCE, p.cs.garrison);
            if (alive < want) {
                const free = p.posts.filter(([x, z]) => Math.hypot(x - body.x, z - body.z) > 18 && (nav?.walkable(x, z) ?? true));
                const at: [number, number][] = [];
                for (let k = 0; k < want - alive && free.length; k++) at.push(free[(alive + k + Math.floor(time)) % free.length]);
                spawnGuards(street, streetContext(), rng, p.cs.id, at, p.cs.kind === "outpost");
            }
        }
        if (d < nearestD) { nearestD = d; nearest = p; }
    }
    if (!nearest || nearestD > nearest.layout.radius + 60) return;
    const cs = nearest.cs;
    const progress = captureProgress.get(cs.id) ?? { raise: 0 };
    captureProgress.set(cs.id, progress);
    const atFlag = !driving() && Math.hypot(body.x - nearest.flag[0], body.z - nearest.flag[1]) < FLAG_REACH;
    const state = stepCapture(cs, progress, atFlag, dt);
    captureView = { name: compoundName(cs), defenders: cs.garrison, raise: progress.raise / 6, state };
    if (state === "captured") compoundCaptured(cs);
}

function compoundCaptured(cs: CompoundState): void {
    const c = campaign!;
    captureView = null;
    if (c.mission && c.mission.compound === cs.id && c.mission.step !== "done") toast(completeMission(c), "good");
    else {
        const rs = c.regions[cs.settlement];
        if (rs && rs.governor !== PARTY) {
            takeRegion(c, rs, "war");
            toast(`Your flag flies over ${compoundName(cs)}. ${regionDefById(cs.settlement)?.name ?? "The town"} is yours!`, "good");
        } else toast(`Your flag flies over ${compoundName(cs)}.`, "good");
    }
    setCheckpointHere();
    save();
}

// --- Houses, shops and the quartermaster ---------------------------------------------------------

let indoors: { rect: Rect; floor: number; loot: LootCache | null; name: string } | null = null;
let shopState: { kind: ShopKind | "hq"; name: string } | null = null;
/** Buildings of the current street map by key (house floors are worked out from them). */
let buildingByKey = new Map<string, CityBuilding>();
/** Shops on the current street map: the spot at their door where you walk in. */
let shopsHere: { rect: Rect; kind: ShopKind; x: number; z: number }[] = [];

function houseFloor(r: Rect): number {
    const b = buildingByKey.get(r.key);
    if (!b || !frame) return heightAt(r.cx, r.cz) + 0.5;
    const plinth = Number(houseValues(b, 1).plinth ?? 0.5);
    const y0 = Math.max(b.groundMin, b.groundMax - plinth + 0.05);
    return toLocal(frame, add(b.anchor, scale(b.up, y0 - b.groundMin + plinth)))[1];
}

/** The house the `house` tool action last put you at the door of. */
let toolHouse: Rect | null = null;

function enterHouse(r: Rect): void {
    const at = entryPoint(r);
    const loot = houseLoot(r.key);
    indoors = { rect: r, floor: houseFloor(r), loot, name: "a house" };
    body.x = at.x; body.z = at.z; body.y = indoors.floor; body.yaw = at.yaw; body.vy = 0;
    toast(loot && campaign && !isLooted(campaign, r.key) ? "You slip inside. Someone left supplies here - look around." : "You slip inside. Nothing much here.", "info");
}

function leaveHouse(): void {
    if (!indoors) return;
    const out = exitPoint(indoors.rect);
    indoors = null;
    body.x = out.x; body.z = out.z; body.y = heightAt(out.x, out.z); body.yaw = out.yaw; body.vy = 0;
}

/**
 * Mesha furniture in a house you go into (deterministic in the house): a round table for two just
 * inside the front door (the entrance is open floor whatever the rooms beyond), chairs facing
 * across it, a lamp on it, and a potted plant by the door.
 */
function interiorItems(r: Rect, floor: number): ScatterItem[] {
    const h = hashString(`interior:${r.key}`);
    const at = entryPoint(r);
    const fx = Math.sin(at.yaw), fz = Math.cos(at.yaw), rx = Math.cos(at.yaw), rz = -Math.sin(at.yaw);
    const s = h % 2 ? 1 : -1;
    // Ahead and a little to one side of where you come in.
    const tx = at.x + fx * 1.9 + rx * s * 0.9, tz = at.z + fz * 1.9 + rz * s * 0.9;
    const item = (family: string, x: number, z: number, yaw: number, y = floor, scale = 1): ScatterItem => ({ family, x, z, yaw, scale, tint: [1, 1, 1], y });
    const out: ScatterItem[] = [item("dining-table", tx, tz, at.yaw)];
    for (const k of [-1, 1]) {
        const px = tx + rx * k * 0.75, pz = tz + rz * k * 0.75;
        out.push(item("dining-chair", px, pz, Math.atan2(tx - px, tz - pz)));
    }
    out.push(item("table-lamp", tx + fx * 0.15, tz + fz * 0.15, at.yaw, floor + 0.74));
    out.push(item("potted-plant", at.x - rx * s * 0.9 - fx * 0.3, at.z - rz * s * 0.9 - fz * 0.3, h % 6, floor, 1.3));
    return out;
}

function lootSpot(): [number, number] | null {
    if (!indoors?.loot || !campaign || isLooted(campaign, indoors.loot.key)) return null;
    return spotInside(indoors.rect, indoors.loot.u, indoors.loot.v);
}

function searchLoot(): void {
    const c = campaign;
    if (!c || !indoors?.loot) return;
    const got = takeHouseLoot(c, indoors.loot);
    toast(got ? `You take: ${got}.` : "Already searched.", got ? "good" : "info");
}

function shopAt(x: number, z: number, reach = 2.8): { kind: ShopKind; rect: Rect } | null {
    for (const s of shopsHere) if (Math.hypot(s.x - x, s.z - z) < reach || Math.hypot(s.rect.door[0] - x, s.rect.door[1] - z) < reach) return s;
    return null;
}

function quartermasterNear(): boolean {
    const hq = campaign?.party.hqSite;
    if (!hq) return false;
    const p = placedCompounds.find(pc => pc.cs.captured && pc.cs.kind === "outpost");
    return !!p && Math.hypot(body.x - p.flag[0], body.z - p.flag[1]) < 7;
}

function openShop(kind: ShopKind | "hq"): void {
    shopState = { kind, name: kind === "hq" ? "Party HQ Quartermaster" : SHOP_NAMES[kind] };
    mode = "shop";
}

function closeShop(): void {
    shopState = null;
    if (mode === "shop") mode = "play";
}

function useItemNow(id: string): void {
    const c = campaign;
    if (!c) return;
    const t = { health: street.player.health, armor: street.player.armor, stamina: body.stamina };
    const msg = useItem(c, id, t);
    street.player.health = c.player.health = t.health;
    street.player.armor = c.player.armor = t.armor;
    body.stamina = t.stamina;
    toast(msg.startsWith("!") ? msg.slice(1) : msg, msg.startsWith("!") ? "bad" : "good");
}

/** What E does here, for the prompt and the key: the nearest thing you can use. */
function nearbyAction(): { label: string; run: () => void } | null {
    if (mode !== "play") return null;
    if (driving()) return null;
    const cob = cobraInReach();
    if (cob) return { label: cob.own ? (cob.stairs ? "[E / X / SQUARE] UP THE STAIRS TO YOUR COBRA" : "[E / X / SQUARE] BOARD YOUR COBRA") : "[E / X / SQUARE] TAKE THE COBRA (FLYING TANK)", run: useCar };
    if (playerCar && Math.hypot(playerCar.x - body.x, playerCar.z - body.z) < 6 && !indoors) return { label: "[E / X / SQUARE] ENTER YOUR FLYING CAR", run: useCar };
    if (atStairsTo(playerCar)) return { label: "[E / X / SQUARE] UP THE STAIRS TO YOUR CAR ON THE ROOF", run: useCar };
    if (indoors) {
        const loot = lootSpot();
        if (loot && Math.hypot(loot[0] - body.x, loot[1] - body.z) < 1.9) return { label: "[E] SEARCH THE FOOTLOCKER", run: searchLoot };
        if (atDoorInside(indoors.rect, body.x, body.z)) return { label: "[E] LEAVE THE HOUSE", run: leaveHouse };
        return null;
    }
    if (quartermasterNear()) return { label: "[E] PARTY HQ QUARTERMASTER", run: () => openShop("hq") };
    const person = nearestActor(street, 3.4, x => x.kind !== "soldier");
    const pd = person ? Math.hypot(person.x - body.x, person.z - body.z) : Infinity;
    const shop = shopAt(body.x, body.z);
    if (shop && pd > 1.6) return { label: `[E] ENTER THE ${SHOP_NAMES[shop.kind].toUpperCase()}`, run: () => openShop(shop.kind) };
    const house = nav ? houseAtDoor(nav.rects, body.x, body.z) : null;
    if (house && pd > 1.6) return { label: "[E] ENTER THE HOUSE", run: () => enterHouse(house) };
    return null;
}

// --- Checkpoints, autosave and coming back from a fall -------------------------------------------

let checkpointTimer = 0;
let autosaveTimer = 0;
let respawnGrace = 0;
let lastAutosave = -1;

function safeHere(): boolean {
    if (!campaign || street.player.dead || driving() || !body.grounded || street.player.health < 30) return false;
    return !soldiers(street).some(s => (s.alerted || !s.post) && Math.hypot(s.x - body.x, s.z - body.z) < 90);
}

function setCheckpointHere(): void {
    if (!campaign || !frame) return;
    const ll = dirToLatLon(toWorld(frame, body.x, body.y, body.z));
    campaign.checkpoint = { lat: ll.lat, lon: ll.lon, day: campaign.day };
}

function stepCheckpoints(dt: number): void {
    checkpointTimer += dt; autosaveTimer += dt;
    respawnGrace = Math.max(0, respawnGrace - dt);
    if (checkpointTimer >= 4 && !indoors && safeHere()) { checkpointTimer = 0; setCheckpointHere(); }
    if (autosaveTimer >= 45 && mode === "play" && safeHere()) { autosaveTimer = 0; if (save()) lastAutosave = time; }
}

/** You fell: back on your feet at the last safe spot (or HQ), the fight broken off, the game saved. */
function respawn(message: string): void {
    const c = campaign;
    if (!c || !frame) return;
    indoors = null; shopState = null;
    if (playerCar?.piloting) { playerCar.piloting = false; playerCar.vx = playerCar.vy = playerCar.vz = 0; playerCar.y = carGround(playerCar.x, playerCar.z, heightAt); playerCar.state = "parked"; addCarObstacle(); }
    if (cobra?.piloting) { cobra.piloting = false; cobra.vx = cobra.vy = cobra.vz = 0; cobra.y = carGround(cobra.x, cobra.z, heightAt); cobra.state = "parked"; street.player.hull = undefined; addCobraObstacle(); saveCobra(); }
    clearConvoy();
    let spot: [number, number] | null = null;
    const cp = c.checkpoint;
    if (cp) {
        const [x, z] = localOf(cp.lat, cp.lon);
        if (Math.hypot(x - body.x, z - body.z) < 2000) spot = nav?.nearestWalkable(x, z, 40) ?? [x, z];
    }
    spot ??= nav?.nearestWalkable(nav.cx, nav.cz, 60) ?? [body.x, body.z];
    body.x = spot[0]; body.z = spot[1]; body.y = heightAt(body.x, body.z); body.vy = 0;
    // Roaming squads lose you; compound guards go back to their posts.
    street.actors = street.actors.filter(a => !(a.kind === "soldier" && !a.post && alive(a)));
    street.squadAlive = 0;
    for (const a of street.actors) if (a.post) { a.alerted = false; a.path = []; a.target = null; }
    street.player.x = body.x; street.player.z = body.z;
    resetStreetPlayer();
    street.player.shield = 4;
    respawnGrace = 25;
    if (mode === "speech" || mode === "dialogue" || mode === "shop") { speech = null; dialogue = null; mode = "play"; }
    toast(message, "bad");
    toast("You regroup at your last safe position. The game is saved.", "info");
    save();
}

function resetStreetPlayer(): void {
    syncStreetPlayerFromCampaign();
    street.player.dead = false;
}

// --- Set dressing: foliage, props, compounds, the HQ beacon --------------------------------------

let foliage: FoliageMeshes | null = null;
let scatterItems: ScatterItem[] = [];
let scatterBatches: InstanceBatches | null = null;
let scatterAt: [number, number] = [Infinity, Infinity];
let scatterTimer = 0;
let scatterDirty = true;
// Ground cover near you (al_scatter.ts lawnAround), replanted when you have moved a few meters.
let lawnItems: ScatterItem[] = [];
let lawnAt: [number, number] = [Infinity, Infinity];

function frameLatLon(): { lat: number; lon: number } {
    return dirToLatLon(normalize(frame!.origin));
}

let roadsInScatter = 0;
let scatterRoads: RoadMask | undefined;
function computeScatter(): void {
    if (!frame || !nav) { scatterItems = []; return; }
    const ll = frameLatLon();
    const half = NAV_SIZE * NAV_CELL / 2 - 12;
    const g = nav;
    // OpenStreetMap roads around the street map: nothing is planted on them.
    let roads: RoadMask | undefined;
    try {
        const lines = Entropy.QuadPlanet.roads(terrainId, ll.lat, ll.lon, half * 1.5);
        const f = frame;
        roads = new RoadMask(roadSegments(lines, (lat, lon) => { const p = toLocal(f, scale(latLonToDir(lat, lon), EARTH.radius)); return [p[0], p[2]]; }));
    } catch { roads = undefined; }
    roadsInScatter = roads?.segments ?? 0;
    scatterRoads = roads;
    lawnAt = [Infinity, Infinity];
    scatterItems = scatterAround(g.rects, {
        roads,
        walkable: (x, z) => g.walkable(x, z),
        reserved: (x, z) => !!inCompound(x, z, 8) || (!!playerCar && Math.hypot(x - playerCar.x, z - playerCar.z) < 5),
        tropical: Math.abs(ll.lat) < 23.5,
        shopOf: r => shopForBuilding(r.key, r.kind ?? "box"),
        origin: ll, area: { x: g.cx, z: g.cz, half },
    });
    applyPropDamage();
    scatterDirty = true;
}

/** Compounds' buildings, walls, flags and props, and the HQ beacon. */
function compoundItems(): ScatterItem[] {
    const out: ScatterItem[] = [];
    const c = campaign;
    const party = c?.party.color ?? THEME.red;
    for (const p of placedCompounds) {
        p.layout.structures.forEach((st, i) => {
            const r = p.rects[i];
            if (c?.ruins?.[r.key] !== undefined) return;
            out.push({ family: `mil-${st.kind}`, x: r.cx, z: r.cz, yaw: st.yaw + p.cs.yaw, scale: p.cs.kind === "outpost" && st.kind !== "wall" && st.kind !== "tower" ? 0.7 : 1,
                sx: st.kind === "wall" ? st.w : undefined, tint: [1, 1, 1] });
        });
        if (!p.cs.cobraTaken) {
            const [x, z] = compoundCobraAt(p);
            out.push({ family: "cobra", x, z, yaw: p.cs.yaw, scale: 1, tint: [1, 1, 1] });
        }
        const flagColor = p.cs.captured ? party : factionById("concordat").color;
        out.push({ family: "flag", x: p.flag[0], z: p.flag[1], yaw: p.cs.yaw, scale: 1.4, tint: [flagColor[0], flagColor[1], flagColor[2]] });
        // Sandbags and barriers at the gate, crates in the yard.
        const gate = compoundToLocal(p.cx, p.cz, p.cs.yaw, 0, p.layout.radius + 3);
        for (const s of [-1, 1]) {
            const [x, z] = compoundToLocal(p.cx, p.cz, p.cs.yaw, s * 4.5, p.layout.radius + 2.5);
            out.push({ family: "sandbags", x, z, yaw: p.cs.yaw, scale: 1, tint: [1, 1, 1] });
        }
        out.push({ family: "barrier", x: gate[0], z: gate[1], yaw: p.cs.yaw, scale: 1, tint: [1, 1, 1] });
        for (const [u, v] of [[-6, -5], [7, -3], [5, 6]]) {
            const [x, z] = compoundToLocal(p.cx, p.cz, p.cs.yaw, u, v);
            out.push({ family: "crates", x, z, yaw: p.cs.yaw + u, scale: 1, tint: [1, 1, 1] });
        }
        // The HQ's light beam rises from its headquarters building's roof, and is only drawn from a
        // distance (close up it would fill the view).
        if (p.cs.captured && p.cs.kind === "outpost" && c?.party.hqSite && Math.hypot(p.rects[0].cx - body.x, p.rects[0].cz - body.z) > 45)
            out.push({ family: "beacon", x: p.rects[0].cx, z: p.rects[0].cz, yaw: 0, scale: 1, tint: [party[0], party[1], party[2]], glow: 1, y: heightAt(p.rects[0].cx, p.rects[0].cz) + 5 });
    }
    // The house you are in: its furniture, and its supplies.
    if (indoors) out.push(...interiorItems(indoors.rect, indoors.floor));
    const loot = lootSpot();
    if (loot && indoors) out.push({ family: "loot", x: loot[0], z: loot[1], yaw: body.yaw, scale: 1, tint: [1, 1, 1], y: indoors.floor });
    return out;
}

const SCATTER_RADIUS: Record<string, number> = { cobra: 5, "mil-hq": 10, "mil-barracks": 11, "mil-depot": 9, "mil-hangar": 11, "mil-tower": 6, "mil-wall": 4, beacon: 160, flag: 6 };

/**
 * An item's record as far as it never changes: its rotation and scale, tint, sway phase, where it
 * stands (world, so a rebase only moves the translation) and its bounding sphere. Computed once
 * per item, frame and ground height (it was a dozen small arrays per item per repack).
 */
interface ScatterPlaced {
    frame: LocalFrame;
    heights: number;
    record: Float32Array;
    world: Vec3;
    /** Bounding sphere center (world) and radius. */
    center: Vec3;
    radius: number;
    /** The last mesh drawn and its batch key. */
    mesh: string;
    batch: string;
}
const scatterPlaced = new WeakMap<ScatterItem, ScatterPlaced>();
const scatterSphere = [0, 0, 0, 0];
let scatterOrigin: Vec3 = [NaN, NaN, NaN];
let scatterHeights = -1;

function placeScatter(it: ScatterItem, f: LocalFrame): ScatterPlaced {
    const known = scatterPlaced.get(it);
    if (known && known.frame === f && (it.y !== undefined || known.heights === heightGeneration)) return known;
    const y = it.y ?? heightAt(it.x, it.z);
    const world = toWorld(f, it.x, y, it.z);
    const fr = makeFrame(dirToWorld(f, Math.sin(it.yaw), 0, Math.cos(it.yaw)), f.up);
    const m = frameMatrix([0, 0, 0], fr);
    const sx = it.scale * (it.sx ?? 1), s = it.scale;
    const radius = (SCATTER_RADIUS[it.family] ?? (it.family.startsWith("tree") || it.family === "conifer" || it.family === "palm" ? 11 : 3)) * Math.max(s, sx / 2);
    const record = new Float32Array(ITEM_FLOATS);
    for (let k = 0; k < 3; k++) { record[k] = m[k] * sx; record[4 + k] = m[4 + k] * s; record[8 + k] = m[8 + k] * s; }
    record[15] = 1;
    record[16] = it.tint[0]; record[17] = it.tint[1]; record[18] = it.tint[2]; record[19] = it.glow ?? 0;
    // Where it stands on the street (wrapped): the phase of its sway in the wind (al_shader.ts).
    record[20] = it.x - 1024 * Math.floor(it.x / 1024); record[22] = it.z - 1024 * Math.floor(it.z / 1024);
    const placed: ScatterPlaced = { frame: f, heights: heightGeneration, record, world, center: add(world, scale(f.up, radius * 0.5)), radius,
        mesh: known?.mesh ?? "", batch: known?.batch ?? "" };
    scatterPlaced.set(it, placed);
    return placed;
}

function drawScatter(dt: number): void {
    if (!scatterBatches) return;
    const visible = profileDisable !== "scatter" && !!frame && (mode === "play" || mode === "speech" || mode === "dialogue" || mode === "shop");
    scatterTimer += dt;
    const moved = Math.hypot(body.x - scatterAt[0], body.z - scatterAt[1]);
    if (!visible) {
        if (scatterAt[0] !== Infinity) { scatterBatches.begin(); scatterBatches.flush(); scatterAt = [Infinity, Infinity]; }
        return;
    }
    const rebased = renderOrigin.some((v, i) => v !== scatterOrigin[i]);
    // Repacking is cheap now (cached placements) and an unchanged batch is not uploaded again, so
    // the once-a-second refresh (compounds, interiors, the beacon) costs a compare.
    if (!scatterDirty && !rebased && scatterHeights === heightGeneration && moved < 4 && scatterTimer < 1) return;
    scatterDirty = false; scatterTimer = 0; scatterAt = [body.x, body.z];
    scatterOrigin = renderOrigin; scatterHeights = heightGeneration;
    if (nav && Math.hypot(body.x - lawnAt[0], body.z - lawnAt[1]) > 10) {
        const g = nav;
        lawnAt = [body.x, body.z];
        lawnItems = lawnAround(body.x, body.z, {
            walkable: (x, z) => g.walkable(x, z), roads: scatterRoads,
            reserved: (x, z) => !!inCompound(x, z, 4) || (!!playerCar && Math.hypot(x - playerCar.x, z - playerCar.z) < 4)
                || (!!cobra && Math.hypot(x - cobra.x, z - cobra.z) < 5) || burned.some(b => Math.hypot(x - b.x, z - b.z) < b.r),
            origin: frameLatLon(),
        });
    }
    scatterBatches.begin();
    const f = frame!;
    const o = renderOrigin;
    const pack = (items: readonly ScatterItem[]) => {
        for (const it of items) {
            const dx = it.x - body.x, dz = it.z - body.z;
            const mesh = scatterMesh(it.family, Math.sqrt(dx * dx + dz * dz));
            if (!mesh) continue;
            const p = placeScatter(it, f);
            if (p.mesh !== mesh) { p.mesh = mesh; p.batch = batchKey(mesh, it.x, it.z, tileOf(it.family)); }
            scatterSphere[0] = p.center[0] - o[0]; scatterSphere[1] = p.center[1] - o[1]; scatterSphere[2] = p.center[2] - o[2]; scatterSphere[3] = p.radius;
            const { data, offset } = scatterBatches!.add(p.batch, scatterSphere);
            data.set(p.record, offset);
            data[offset + 12] = p.world[0] - o[0]; data[offset + 13] = p.world[1] - o[1]; data[offset + 14] = p.world[2] - o[2];
        }
    };
    pack(scatterItems);
    pack(lawnItems);
    pack(compoundItems());
    scatterBatches.flush();
}

// --- The territory overlay (al_territory.ts) -----------------------------------------------------

let territoryBuffer = "";
let territoryTimer = 99;
let territoryOrigin: Vec3 = [NaN, NaN, NaN];
/** Strength last written (0: off), and how many places it showed. */
let territoryShown = 0;
let territoryPlaces = 0;
/** Each place's center on the ground (world), sampled once. */
const territoryPoints = new Map<string, Vec3>();

/** While flying high, the ground is washed in its governors' colors (rewritten at most once a second, or on a rebase). */
function updateTerritories(dt: number): void {
    const c = campaign;
    const v = driving();
    const alt = c && frame && v && (mode === "play" || mode === "dialogue") ? v.y - carGround(v.x, v.z, heightAt) : 0;
    const k = territoryStrength(alt);
    territoryTimer += dt;
    if (k <= 0 || !c) {
        if (territoryShown > 0) { Entropy.Buffer.write(territoryBuffer, packTerritories([], 0, 0)); territoryShown = 0; territoryPlaces = 0; }
        return;
    }
    const rebased = renderOrigin.some((x, i) => x !== territoryOrigin[i]);
    if (!rebased && territoryTimer < 1 && Math.abs(k - territoryShown) < 0.03) return;
    territoryTimer = 0; territoryOrigin = renderOrigin; territoryShown = k;
    const { lat, lon } = c.player;
    const km = (d: { lat: number; lon: number }) => angularDistance(lat, lon, d.lat, d.lon) * EARTH_RADIUS_KM;
    const towns = (c.settlements ?? []).map(d => ({ d, km: km(d) })).filter(o => o.km < 160).sort((a, b) => a.km - b.km).slice(0, 48);
    const anchors = REGIONS.map(d => ({ d, km: km(d) })).sort((a, b) => a.km - b.km).slice(0, 12);
    const spot = (d: { id: string; lat: number; lon: number }, radius: number): TerritorySpot => {
        let p = territoryPoints.get(d.id);
        if (!p) {
            const dir = latLonToDir(d.lat, d.lon);
            p = scale(dir, EARTH.radius + Math.max(0, sampleEarth(dir).surface));
            territoryPoints.set(d.id, p);
        }
        const gov = c.regions[d.id]?.governor ?? "concordat";
        const col = gov === PARTY ? c.party.color : factionById(gov).color;
        return { at: toRender(p), radius, color: [col[0], col[1], col[2]], party: gov === PARTY };
    };
    const spots = [...towns.map(o => spot(o.d, (o.d.radiusKm ?? 2) * 1000)), ...anchors.map(o => spot(o.d, 0))];
    territoryPlaces = spots.length;
    Entropy.Buffer.write(territoryBuffer, packTerritories(spots, k, borderWidth(alt)));
}

// --- Sky markers and the mini map ----------------------------------------------------------------

let skyCache: SkyMarker[] = [];
const skyPoints = new Map<string, Vec3>();
let skyTimer = 99;
let tangents = { tanX: 0.414 * 16 / 9, tanY: 0.414 };
let tangentTimer = 99;
let miniMap: MiniMap | null = null;
let miniTimer = 99;

function updateSky(dt: number): void {
    const c = campaign;
    skyTimer += dt;
    if (!c || !frame || skyTimer < 1) return;
    skyTimer = 0;
    const m = c.mission && c.mission.step !== "done" ? c.mission.compound : null;
    skyCache = skyMarkers(c, c.player.lat, c.player.lon, { rangeKm: driving() ? 90 : 45, max: 10, compoundKm: 5, missionCompound: m });
    for (const s of skyCache) {
        const key = `${s.id}:${s.lat.toFixed(5)},${s.lon.toFixed(5)}`;
        if (!skyPoints.has(key)) {
            const d = latLonToDir(s.lat, s.lon);
            skyPoints.set(key, scale(d, EARTH.radius + Math.max(0, sampleEarth(d).surface) + s.lift));
            if (skyPoints.size > 400) skyPoints.clear();
        }
    }
}

function screenMarkers(W: number, H: number): ScreenMarker[] {
    if (!lastCamera || !(mode === "play" || mode === "dialogue") || !frame) return [];
    const basis: CameraBasis = cameraBasis(lastCamera.position, lastCamera.target, lastCamera.up, tangents.tanX, tangents.tanY);
    tangentTimer += 1;
    if (tangentTimer > 20) {
        tangentTimer = 0;
        try {
            const rr = Entropy.Camera.screenToWorldRay(W, H / 2).direction, rt = Entropy.Camera.screenToWorldRay(W / 2, 0).direction;
            tangents = calibrate(basis, normalize(rr), normalize(rt));
            basis.tanX = tangents.tanX; basis.tanY = tangents.tanY;
        } catch { /* the default field of view stands */ }
    }
    const out: ScreenMarker[] = [];
    for (const s of skyCache) {
        const p = skyPoints.get(`${s.id}:${s.lat.toFixed(5)},${s.lon.toFixed(5)}`);
        if (!p) continue;
        // Right on top of it: the mini map and the compound itself say enough.
        if (s.km < 0.08) continue;
        const pr = project(basis, p, W, H, 40);
        out.push({ id: s.id, kind: s.kind, label: s.label, distance: distanceLabel(s.km), x: pr.x, y: pr.y, color: s.color, onScreen: pr.onScreen });
    }
    // Shops nearby: a marker over each (in its awning's color) where it is in view; the nearest few
    // on foot, more from the air.
    const f = frame;
    const flying = !!driving();
    const shops = shopsHere.map(sh => ({ sh, d: Math.hypot(sh.x - body.x, sh.z - body.z) }))
        .filter(o => o.d > 6 && o.d < (flying ? 700 : 260)).sort((a, b) => a.d - b.d).slice(0, flying ? 8 : 5);
    for (const { sh, d } of shops) {
        const r = sh.rect;
        const p = toWorld(f, sh.x, Math.max(heightAt(sh.x, sh.z) + 6, r.base + r.height + 4), sh.z);
        const pr = project(basis, p, W, H, 40);
        if (!pr.onScreen) continue;
        const t = SHOP_TINT[sh.kind];
        out.push({ id: `shop-${r.key}`, kind: "shop", label: SHOP_NAMES[sh.kind].toUpperCase(), distance: distanceLabel(d / 1000), x: pr.x, y: pr.y, color: [t[0] * 1.3, t[1] * 1.3, t[2] * 1.3, 1], onScreen: true });
    }
    return out;
}

function updateMiniMap(dt: number): void {
    miniTimer += dt;
    if (miniTimer < 0.3) return;
    miniTimer = 0;
    const c = campaign;
    if (!c || !nav || !frame || !(mode === "play" || mode === "dialogue" || mode === "shop")) { miniMap = null; return; }
    const g = nav;
    const cells = 44, cellMeters = driving() ? 12 : 6;
    const what = (x: number, z: number) => {
        const [i, j] = g.cellOf(x, z);
        return g.inBounds(i, j) ? g.blocked[j * g.size + i] : 0;
    };
    const m: MiniMap = { cells, cellMeters, runs: miniMapRuns(what, body.x, body.z, cells, cellMeters), dots: [], heading: body.yaw };
    const dot = (x: number, z: number, color: [number, number, number, number], size: number, kind: string, clamp = false) => {
        const p = toMapCell(m, body.x, body.z, x, z, clamp);
        if (p) m.dots.push({ ...p, color, size, kind });
    };
    // Shops in their awning's color, ringed in gold.
    for (const s of shopsHere) {
        const t = SHOP_TINT[s.kind];
        dot(s.x, s.z, THEME.gold, 10, "shop-ring");
        dot(s.x, s.z, [t[0] * 1.3, t[1] * 1.3, t[2] * 1.3, 1], 7, "shop");
    }
    for (const a of street.actors) {
        if (!alive(a)) continue;
        if (a.kind === "soldier" && (a.alerted || !a.post)) dot(a.x, a.z, [0.95, 0.2, 0.15, 1], 5, "enemy");
        else if (a.kind === "follower") dot(a.x, a.z, c.party.color, 5, "comrade");
    }
    if (playerCar && !playerCar.piloting) dot(playerCar.x, playerCar.z, [0.3, 0.7, 1, 1], 8, "car", true);
    for (const p of placedCompounds) {
        const mission = c.mission && c.mission.step !== "done" && c.mission.compound === p.cs.id;
        dot(p.flag[0], p.flag[1], p.cs.captured ? c.party.color : mission ? [0.96, 0.78, 0.25, 1] : [0.9, 0.18, 0.15, 1], 11, p.cs.captured ? "hq" : "compound", true);
    }
    for (const s of skyCache) {
        if (s.kind !== "mission" && s.kind !== "hq") continue;
        if (placedCompounds.some(p => p.cs.id === s.id || (s.kind === "hq" && p.cs.captured))) continue;
        const [x, z] = localOf(s.lat, s.lon);
        dot(x, z, s.color, 9, s.kind, true);
    }
    miniMap = m;
}

// --- First-person view model ---------------------------------------------------------------------

const VIEW_KINDS = ["none", "pistol", "rifle", "rail"];
const viewItems: Record<string, string> = {};

function setupViewModels(): void {
    for (const k of VIEW_KINDS) {
        viewItems[k] = uniform(ITEM_FLOATS);
        spawnMesh(`al-view-${k}`, buildViewWeapon(k), viewItems[k]);
        writeItem(viewItems[k], HIDDEN, [1, 1, 1, 0]);
        showProp(`al-view-${k}`, false);
    }
}

function drawViewModel(): void {
    const show = !!frame && !!lastCamera && mode === "play" && body.firstPerson && !driving();
    const kind = weaponClass(campaign?.player.weapon ?? "fists");
    for (const k of VIEW_KINDS) showProp(`al-view-${k}`, show && k === kind);
    if (!show) return;
    const cam = lastCamera!;
    const f = normalize(sub(cam.target, cam.position));
    const r = normalize(cross(f, cam.up));
    const u = cross(r, f);
    // A little bob as you walk, and the kick of the last shot.
    const bob = Math.sin(body.stride * 1.1) * 0.012 * Math.min(1, body.speed / 4);
    const kick = fireCooldown > 0 ? 0.03 * Math.min(1, fireCooldown * 6) : 0;
    // Down the sights: the gun comes up to the eye, its sights on the crosshair.
    const t = aim.ads * aim.ads * (3 - 2 * aim.ads);
    const p = add(toRender(cam.position), add(add(scale(u, bob * (1 - t) + 0.18 * t), scale(r, -0.24 * t)), scale(f, -kick * (1 - 0.6 * t))));
    writeItem(viewItems[kind], [r[0], r[1], r[2], 0, u[0], u[1], u[2], 0, -f[0], -f[1], -f[2], 0, p[0], p[1], p[2], 1], [1, 1, 1, 0]);
}

// --- MCP tools (and the live test) ---------------------------------------------------------------

type Args = Record<string, unknown>;
const r2 = (v: number) => Math.round(v * 100) / 100;

function snapshot() {
    const c = campaign;
    const rs = here();
    return {
        mode, tab, frames: frameCount, time: r2(time),
        profile: profiling ? { disable: profileDisable, experiment: profileExperiment, freeze: profileFreeze } : null,
        materials: { missing: materialsMissing },
        sky: {
            cloudCache: cloudCacheEnabled, cloudCacheBytes: CLOUD_CACHE_BYTES,
            shadows: shadowsLive, cascades: shadowsLive ? shadowCascadeCount : 0, shadowMap: shadowMapSize,
            sunElevation: frame ? r2(Math.asin(Math.max(-1, Math.min(1, dot(SUN_DIRECTION, frame.up)))) * 180 / Math.PI) : null,
            cloudCover: r2(weather.cloudCover), windSpeed: r2(weather.windSpeed), cloudAltitude: Math.round(cloudAltitude),
        },
        loading: { progress: r2(loading.progress), stage: loading.stage, lines: loading.lines, elapsed: r2(loading.elapsed) },
        region: region ? { id: region, name: regionDefById(region)?.name, country: regionDefById(region)?.country, population: Math.round((regionDefById(region)?.pop ?? 0) * 1e6), kind: regionDefById(region)?.kind ?? "territory", governor: rs?.governor, partyShare: rs ? Math.round(partyShare(rs) * 10000) / 10000 : 0, members: rs?.members, army: rs?.army, garrison: rs?.garrison, war: !!rs?.war, heat: rs ? r2(rs.heat) : 0 } : null,
        campaign: c ? {
            party: c.party.name, leader: c.party.leader, ideology: c.party.ideology, day: c.day, dayClock: r2(c.dayClock), funds: Math.round(c.party.funds), karma: r2(c.party.karma),
            members: Object.values(c.regions).reduce((s, x) => s + x.members, 0), named: c.members.length, followers: followers(c).length,
            worldSupport: Math.round(worldSupport(c) * 1e5) / 1e5, governed: Math.round(governedShare(c) * 1e4) / 1e4,
            health: Math.round(c.player.health), maxHealth: maxHealth(c), weapon: c.player.weapon, pamphlets: c.player.pamphlets, level: c.party.level, skillPoints: c.party.skillPoints,
            stats: c.stats, outcome: c.outcome, orgWarnings: orgReport(c).warnings.length, news: c.news.slice(0, 3).map(n => n.text),
        } : null,
        player: frame ? { x: r2(body.x), y: r2(body.y), z: r2(body.z), yaw: r2(body.yaw), lat: dirToLatLon(toWorld(frame, body.x, body.y, body.z)).lat, lon: dirToLatLon(toWorld(frame, body.x, body.y, body.z)).lon, firstPerson: body.firstPerson } : null,
        street: {
            actors: street.actors.length,
            civilians: street.actors.filter(a => a.kind === "civilian" && alive(a)).length,
            walking: street.actors.filter(a => a.state === "walk" && a.speed > 0.3).length,
            withPaths: street.actors.filter(a => a.path.length > 0).length,
            listeners: listeners(street).length, soldiers: soldiers(street).length,
            followers: street.actors.filter(a => a.kind === "follower" && alive(a)).length,
            members: street.actors.filter(a => a.member && alive(a)).length,
            rally: street.rally ? { faction: street.rally.faction, time: r2(street.rally.time) } : null,
            nearest: (() => { const a = nearestActor(street, 6); return a ? { id: a.id, name: a.name, kind: a.kind, opinion: r2(a.opinion), distance: r2(Math.hypot(a.x - body.x, a.z - body.z)) } : null; })(),
        },
        nav: nav ? { buildings: nav.rects.length, blockedShare: r2(nav.blocked.reduce((s, v) => s + (v ? 1 : 0), 0) / nav.blocked.length), center: [r2(nav.cx), r2(nav.cz)] } : null,
        speech: speech ? { phase: speech.phase, beat: speech.beat, crowd: speech.crowd, fervor: r2(speech.fervor), hand: speech.hand.map(h => h.id), rival: speech.rival?.name ?? null, result: speech.result } : null,
        dialogue: dialogue ? { name: dialogue.name, opinion: r2(dialogue.opinion), reply: dialogue.reply, member: dialogue.member } : null,
        terrain: stats ? { live: stats.live, pending: stats.pending, waitingForData: stats.waitingForData, triangles: stats.triangles, city: stats.city ?? null } : null,
        houses: houses?.lastStats ?? null,
        buildings: buildings?.lastStats ?? null,
        people: { generated: people?.generated ?? 0, cache: Entropy.MeshCache.stats(PEOPLE_NAMESPACE),
            lod0: lodCounts[0], lod1: lodCounts[1], lod2: lodCounts[2], detail: peopleDetail, budget: peopleBudget,
            batches: crowd?.lastStats ?? null },
        ui: { ops: ui?.p.opCount() ?? 0, submits: ui?.p.submits ?? 0, buttons: ui?.p.buttons.map(b => b.id).slice(0, 80) ?? [] },
        toasts: toasts.map(t => t.text),
        traffic: { count: trafficVisible, limit: TRAFFIC_LIMIT },
        aim: { ads: r2(aim.ads), fov: r2(fovSet), assist: controls().aimAssist, locked: assistPick ? { id: assistPick.target.id, angle: Math.round(assistPick.angle * 1e4) / 1e4 } : null, yaw: r2(body.yaw), pitch: r2(body.pitch) },
        cobra: cobra && cobraState ? { x: r2(cobra.x), y: r2(cobra.y), z: r2(cobra.z), state: cobra.state, piloting: cobra.piloting, home: cobraState.home,
            hull: Math.round(cobraState.hull), cells: r2(cobraState.cells), altitude: r2(cobra.y - carGround(cobra.x, cobra.z, heightAt)), distance: r2(Math.hypot(cobra.x - body.x, cobra.z - body.z)) } : null,
        parkedCobras: placedCompounds.filter(p => !p.cs.cobraTaken).map(p => { const [x, z] = compoundCobraAt(p); return { compound: p.cs.id, distance: r2(Math.hypot(x - body.x, z - body.z)) }; }),
        fx: { missiles: missiles.length, particles: fx.particles.length, fires: fx.fires.length, scorches: fx.scorches.length, explosions: fx.explosions,
            pieces: pieces.length, falling: pieces.filter(q => !q.asleep).length, ruins: Object.keys(c?.ruins ?? {}).length, ruinsHere: ruinRects.length,
            blownProps: blownProps.size, scorchedPlants: scorchedProps.size, shake: r2(fx.shake), batches: fxBatches?.lastStats ?? null },
        flyingCar: playerCar ? { ...playerCar, altitude: r2(playerCar.y - carGround(playerCar.x, playerCar.z, heightAt)), distance: r2(Math.hypot(playerCar.x - body.x, playerCar.z - body.z)) } : null,
        settlements: c?.settlements?.map(d => ({ id: d.id, name: d.name, country: d.country, parent: d.parent, governor: c.regions[d.id].governor })) ?? [],
        mission: c?.mission ? { ...c.mission, distance: Math.round(missionCompound(c) ? angularDistance(c.player.lat, c.player.lon, missionCompound(c)!.lat, missionCompound(c)!.lon) * EARTH_RADIUS_KM * 1000 : -1) } : null,
        hqSite: c?.party.hqSite ?? null,
        compounds: placedCompounds.map(p => ({ id: p.cs.id, kind: p.cs.kind, settlement: p.cs.settlement, buildings: p.cs.buildings, garrison: p.cs.garrison, maxGarrison: p.cs.maxGarrison,
            captured: p.cs.captured, guards: guardsOf(street, p.cs.id).length, distance: r2(Math.hypot(p.cx - body.x, p.cz - body.z)), flagDistance: r2(Math.hypot(p.flag[0] - body.x, p.flag[1] - body.z)) })),
        capture: captureView,
        inventory: c?.player.inventory ?? {},
        carUpgrades: c?.player.carUpgrades ?? {},
        checkpoint: c?.checkpoint ?? null,
        lastAutosave: lastAutosave >= 0 ? r2(time - lastAutosave) : null,
        indoors: indoors ? { key: indoors.rect.key, floor: r2(indoors.floor), loot: !!lootSpot(), atDoor: atDoorInside(indoors.rect, body.x, body.z) } : null,
        shop: shopState ? { ...shopState, stock: c ? shopStock(c, shopState.kind).length : 0 } : null,
        shopsNearby: shopsHere.length,
        prompt: nearbyAction()?.label ?? null,
        markers: skyCache.map(m => ({ id: m.id, kind: m.kind, label: m.label, km: Math.round(m.km * 100) / 100 })),
        territory: { strength: r2(territoryShown), places: territoryPlaces },
        autopilot: autopilot ? { ...autopilot, on: autopilotOn, km: r2(autopilotKm(autopilot)), warp: r2(flightWarp) } : null,
        comrades: {
            engaged: r2(street.engaged),
            list: street.actors.filter(a => a.kind === "follower" && alive(a)).map(a => ({ id: a.id, name: a.name, aboard: a.aboard ?? null, hold: a.hold ? a.hold.map(r2) : null,
                distance: r2(Math.hypot(a.x - body.x, a.z - body.z)), state: a.state, target: a.aimAt ?? null })),
            cars: convoy.map(v => ({ x: r2(v.car.x), y: r2(v.car.y), z: r2(v.car.z), state: v.car.state, calling: !!v.car.call, riders: v.riders.length,
                altitude: r2(v.car.y - carGround(v.car.x, v.car.z, heightAt)), distance: r2(Math.hypot(v.car.x - body.x, v.car.z - body.z)) })),
        },
        covers: street.covers,
        screenMarkers: ui ? screenMarkers(ui.W, ui.H).reduce((acc, m) => { acc[m.kind] = (acc[m.kind] ?? 0) + 1; return acc; }, {} as Record<string, number>) : {},
        soldiersDetail: soldiers(street).slice(0, 12).map(a => ({ id: a.id, x: r2(a.x), z: r2(a.z), cover: !!a.cover && (a.coverTime ?? 0) > 0, approach: a.approach == null ? null : r2(a.approach), alerted: a.alerted ?? true })),
        threats: Object.values(c?.regions ?? {}).filter(rs => rs.threat).map(rs => ({ region: rs.id, ...rs.threat!, army: rs.army })),
        urban: { points: street.streetPoints?.length ?? null, cap: Number.isFinite(street.urbanCap) ? street.urbanCap : null },
        miniMap: miniMap ? { runs: miniMap.runs.length, dots: miniMap.dots.length, cellMeters: miniMap.cellMeters } : null,
        scatter: { items: scatterItems.length, groundCover: lawnItems.length, groundCoverNear: lawnItems.filter(i => Math.hypot(i.x - body.x, i.z - body.z) < 20).length, lawnAt: lawnAt.map(r2), roadSegments: roadsInScatter, foliageGenerated: foliage?.generated ?? 0, batches: scatterBatches?.lastStats ?? null,
            families: Object.entries(scatterItems.reduce((acc, it) => { acc[it.family] = (acc[it.family] ?? 0) + 1; return acc; }, {} as Record<string, number>)) },
        fixedStep,
    };
}

/** Runs the loading screen to completion (streams, builds houses, builds the street map). */
function settle(timeoutMs: number) {
    const start = Date.now();
    if (mode !== "loading") {
        // Not loading a place: just stream until the terrain around the camera is complete.
        while (Date.now() - start < timeoutMs) {
            stream(Infinity, Infinity);
            if (stats && stats.pending === 0 && stats.waitingForData === 0) break;
            const wait = Date.now() + 15;
            while (Date.now() < wait) { /* elevation tiles download on Rust threads */ }
        }
        writeWorld();
        return { settled: !!stats && stats.pending === 0, ms: Date.now() - start };
    }
    while (mode === "loading" && Date.now() - start < timeoutMs) {
        const wait = Date.now() + 15;
        while (Date.now() < wait) { /* tiles download and houses simplify on Rust threads */ }
        stream(Infinity, Infinity);
        updateHouses(Infinity);
        time += 0.05;
        loadingStep();
    }
    if (mode === "loading") return { settled: false, ms: Date.now() - start };
    // Let the street come alive for a moment.
    for (let i = 0; i < 40; i++) stepStreet(street, nav, streetContext(), 0.1, rng, heightAt);
    return { settled: mode !== "loading", ms: Date.now() - start };
}

function placeCamera(): void {
    const pose = cameraForMode(0);
    if (distance(pose.position, renderOrigin) > REBASE) renderOrigin = [Math.round(pose.position[0]), Math.round(pose.position[1]), Math.round(pose.position[2])];
    Entropy.Camera.setTransform(toRender(pose.position), toRender(pose.target), pose.up);
    lastCamera = pose;
}

const TOOLS: { name: string; description: string; parameters: object; run: (a: Args) => object }[] = [
    {
        name: "allegiance_state",
        description: "The game's state: mode, loading progress, region, campaign summary, player, street (civilians, listeners, soldiers, followers), nav grid, speech, terrain and UI.",
        parameters: { type: "object", properties: {} },
        run: () => snapshot(),
    },
    {
        name: "allegiance_new",
        description: "Starts a new campaign and loads its spawn point. Give a hometown place name, exact lat/lon with a hometown label, or a legacy territory spawn id.",
        parameters: { type: "object", properties: { hometown: { type: "string" }, party: { type: "string" }, leader: { type: "string" }, ideology: { type: "string" }, color: { type: "integer" }, spawn: { type: "string" }, seed: { type: "integer" }, lat: { type: "number" }, lon: { type: "number" }, mission: { type: "boolean" } } },
        run: a => {
            const def = regionDefById(String(a.spawn));
            const hometown = typeof a.hometown === "string" ? (typeof a.lat === "number" && typeof a.lon === "number"
                ? { name: a.hometown, lat: a.lat, lon: a.lon, kind: "village" } : resolvePlaces(a.hometown)[0]) : undefined;
            if (!def && !hometown) throw new Error("Give a known territory or a hometown name/coordinates.");
            campaign = newCampaign({
                partyName: typeof a.party === "string" ? a.party : "People's Front", leader: typeof a.leader === "string" ? a.leader : undefined,
                ideology: typeof a.ideology === "string" ? a.ideology : "solidarity", color: PARTY_COLORS[typeof a.color === "number" ? a.color : 0].color,
                spawn: def?.id, hometown, seed: typeof a.seed === "number" ? a.seed : 2100, lat: typeof a.lat === "number" ? a.lat : undefined, lon: typeof a.lon === "number" ? a.lon : undefined,
            });
            if (a.mission !== false) startFoundingMission(campaign);
            startLoading(campaign.player.lat, campaign.player.lon);
            return snapshot();
        },
    },
    {
        name: "allegiance_settle",
        description: "Runs the loading screen until the place is ready (terrain, elevation downloads, OpenStreetMap tiles, houses, the street map), up to timeoutMs (default 120000).",
        parameters: { type: "object", properties: { timeoutMs: { type: "number" } } },
        run: a => ({ ...settle(typeof a.timeoutMs === "number" ? a.timeoutMs : 120000), ...snapshot() }),
    },
    {
        name: "allegiance_config",
        description: "fixedStep: seconds per frame (reproducible runs), or null for real time. peopleDetail: scales people's level-of-detail distances (1 default; 0.3-0.5 for slower machines). peopleMaxFull / peopleTriangles: at most this many full-detail people and this many person triangles per frame (defaults 6 and 3,000,000). shadows: sun shadows on or off; shadowCascades 1-4 (default 4) and shadowMap (resolution, default 2048) trade their reach and sharpness for speed. weather: { cloudCover 0..1, windSpeed m/s, windHeading radians } holds the weather (null: follow the day again); dayClock sets the time of day (seconds into the day). houseLod / buildingLod: { lod0Radius, maxLod0, lod1Radius, triangleBudget } on foot for the Mesha houses and city blocks (null: the defaults); in the air both are always exterior-only.",
        parameters: { type: "object", properties: { fixedStep: { type: ["number", "null"] }, peopleDetail: { type: "number" }, peopleMaxFull: { type: "integer" }, peopleTriangles: { type: "number" }, shadows: { type: "boolean" }, shadowCascades: { type: "integer" }, shadowMap: { type: "integer" }, weather: { type: ["object", "null"] }, dayClock: { type: "number" }, houseLod: { type: ["object", "null"] }, buildingLod: { type: ["object", "null"] }, profileDisable: { type: "string", enum: ["none", "people", "scatter", "street", "terrainStream", "houses", "sky", "cloudShadows", "skyClouds", "materials", "atmosphere", "stars"], description: "Profiler-only single-subsystem disable; none restores normal play. Houses and terrainStream retain existing draws." }, profileExperiment: { type: "number", description: "Profiler-only experiment ID recorded per frame." }, profileCloudCache: { type: "boolean", description: "Profiler-only switch between cached and reference procedural cloud noise." }, profileFreeze: { type: "boolean", description: "Profiler-only pause of simulation time, retaining production streaming budgets for identical-scene comparisons." } } },
        run: a => {
            // Diagnostic switches only: never persisted and only available with the profiler on.
            if ("profileDisable" in a || "profileExperiment" in a || "profileFreeze" in a || "profileCloudCache" in a) {
                if (!profiling) throw new Error("Diagnostic switches require ENTROPY_FRAME_PROFILE=1.");
                if ("profileDisable" in a) {
                    if (!["none", "people", "scatter", "street", "terrainStream", "houses", "sky", ...Object.keys(PROFILE_SHADER_DISABLE)].includes(String(a.profileDisable))) throw new Error("Unknown profileDisable subsystem.");
                    profileDisable = String(a.profileDisable);
                    Entropy.Model.setInstanceCount("al-sky", profileDisable === "sky" ? 0 : 1);
                }
                if (typeof a.profileExperiment === "number") profileExperiment = a.profileExperiment;
                if (typeof a.profileFreeze === "boolean") profileFreeze = a.profileFreeze;
                if (typeof a.profileCloudCache === "boolean") cloudCacheEnabled = a.profileCloudCache;
            }
            if (typeof a.shadows === "boolean") shadowsEnabled = a.shadows;
            if (typeof a.shadowCascades === "number") shadowCascadeCount = Math.max(1, Math.min(SHADOW_RADII.length, Math.floor(a.shadowCascades)));
            if (typeof a.shadowMap === "number") shadowMapSize = Math.max(256, Math.min(4096, Math.floor(a.shadowMap)));
            if (typeof a.dayClock === "number" && campaign) { campaign.dayClock = Math.max(0, Math.min(DAY_SECONDS, a.dayClock)); updateSun(); }
            if (a.weather === null) weatherHold = null;
            else if (a.weather && typeof a.weather === "object") {
                const w = a.weather as Partial<Weather>;
                weather = weatherHold = { cloudCover: w.cloudCover ?? weather.cloudCover, windSpeed: w.windSpeed ?? weather.windSpeed, windHeading: w.windHeading ?? weather.windHeading };
            }
            if ("fixedStep" in a) fixedStep = typeof a.fixedStep === "number" && a.fixedStep > 0 ? Math.min(0.1, a.fixedStep) : null;
            if (typeof a.peopleDetail === "number" && a.peopleDetail > 0) peopleDetail = Math.min(4, a.peopleDetail);
            if (typeof a.peopleMaxFull === "number" && a.peopleMaxFull >= 0) peopleBudget = { ...peopleBudget, maxFull: Math.floor(a.peopleMaxFull) };
            if (typeof a.peopleTriangles === "number" && a.peopleTriangles >= 0) peopleBudget = { ...peopleBudget, triangleBudget: a.peopleTriangles };
            const lod = (v: unknown, base: LodLimits): LodLimits | null => v && typeof v === "object" ? { ...base, ...(v as Partial<LodLimits>) } : null;
            if ("houseLod" in a) houseLod = lod(a.houseLod, HOUSE_LOD);
            if ("buildingLod" in a) buildingLod = lod(a.buildingLod, BUILDING_LOD);
            return snapshot();
        },
    },
    {
        name: "allegiance_ui",
        description: "Opens a screen: mode title|setup|play|console|outcome; tab overview|organization|territory|armory|skills; region and member to select; setupSpawn to pick in the setup screen.",
        parameters: { type: "object", properties: { mode: { type: "string" }, tab: { type: "string" }, region: { type: "string" }, member: { type: "integer" }, setupSpawn: { type: "string" }, party: { type: "string" }, leader: { type: "string" } } },
        run: a => {
            if (typeof a.mode === "string") mode = a.mode as Mode;
            if (typeof a.tab === "string") tab = a.tab as ConsoleTab;
            if (typeof a.region === "string") selectedRegion = a.region;
            if (typeof a.member === "number") selectedMember = a.member;
            if (typeof a.setupSpawn === "string") setup.spawn = a.setupSpawn;
            if (typeof a.party === "string") setup.party = a.party;
            if (typeof a.leader === "string") setup.leader = a.leader;
            drawUi(0, true);
            return snapshot();
        },
    },
    {
        name: "allegiance_click",
        description: "Clicks the UI at screen coordinates, or the button with the given id (as listed in allegiance_state ui.buttons).",
        parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, id: { type: "string" } } },
        run: a => {
            drawUi(0, true);
            if (!ui) throw new Error("No UI.");
            let clicked: string | null = null;
            if (typeof a.id === "string") {
                const b = ui.p.buttons.find(x => x.id === a.id);
                if (!b) throw new Error(`No button ${a.id}; have ${ui.p.buttons.map(x => x.id).join(", ")}`);
                clicked = ui.click(b.x + b.w / 2, b.y + b.h / 2);
            } else clicked = ui.click(Number(a.x), Number(a.y));
            drawUi(0, true);
            return { clicked, ...snapshot() };
        },
    },
    {
        name: "allegiance_controller",
        description: "Drive semantic Xbox/DualShock input: button and pressed, or left/right stick vectors (positive Y up).",
        parameters: { type: "object", properties: { button: { type: "string" }, pressed: { type: "boolean" }, left: { type: "array", items: { type: "number" } }, right: { type: "array", items: { type: "number" } } } },
        run: a => {
            if (typeof a.button === "string") controllerButton(a.button, a.pressed !== false);
            if (Array.isArray(a.left) || Array.isArray(a.right)) controller.axis((a.left as [number, number]) ?? [0, 0], (a.right as [number, number]) ?? [0, 0], time);
            drawUi(0, true); return snapshot();
        },
    },
    {
        name: "allegiance_key",
        description: "Sends a key press to the game, as if typed (e.g. 'b' start a speech, '1' pick a card, ' ' deliver, 'e' talk, 'Tab' command console).",
        parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
        run: a => { onKey(String(a.key)); drawUi(0, true); return snapshot(); },
    },
    {
        name: "allegiance_speech",
        description: "Drives a speech: action start | choose (index) | deliver (perfect timing unless grade given) | rebut | auto (play it out at `grade`) | close.",
        parameters: { type: "object", properties: { action: { type: "string" }, index: { type: "integer" }, grade: { type: "string" } }, required: ["action"] },
        run: a => {
            const action = String(a.action);
            if (action === "start") { const e = beginSpeech(); if (e) throw new Error(e); }
            else if (!speech) throw new Error("No speech underway.");
            else if (action === "choose") chooseCard(speech, typeof a.index === "number" ? a.index : bestCard(speech));
            else if (action === "deliver") { speech.marker = speech.sweet; deliver(speech); }
            else if (action === "rebut") { if (speech.heckler) rebutHeckler(speech, speech.heckler.key); }
            else if (action === "auto") autoplay(speech, bestCard, (typeof a.grade === "string" ? a.grade : "good") as Grade);
            else if (action === "close") finishSpeech();
            drawUi(0, true);
            return snapshot();
        },
    },
    {
        name: "allegiance_act",
        description: "Street and campaign actions: car (enter/exit nearby car); land (autoland); use {item} / heal; house {loot} (stand at a house door), enter (E), loot, leave-house; shop {kind} (walk into the nearest shop: general|gunsmith|garage|hq), shop-buy {kind, item}, shop-sell {item}, shop-close; compound {region?, distance?} (stand outside the mission's or nearest compound), storm (debug: defenders defeated), flag (stand at the flag), die, checkpoint, to-car; talk (nearest), pamphlet, persuade, recruit, follow, leave; walk {dx,dz}; face {yaw,pitch}; shoot; squad (spawn soldiers); rest; days {days}; funds {amount}; organize; arm {count}; war; coup; election; travel {region}; equip {weapon}; buy {weapon}; save; load; view {distance, firstPerson}.",
        parameters: { type: "object", properties: {
            action: { type: "string" }, dx: { type: "number" }, dz: { type: "number" }, yaw: { type: "number" }, pitch: { type: "number" }, days: { type: "integer" },
            amount: { type: "number" }, count: { type: "integer" }, region: { type: "string" }, weapon: { type: "string" }, distance: { type: "number" }, firstPerson: { type: "boolean" },
            item: { type: "string" }, kind: { type: "string" }, loot: { type: "boolean" },
        }, required: ["action"] },
        run: a => {
            const c = campaign;
            const action = String(a.action);
            const where = typeof a.region === "string" ? a.region : region ?? "";
            const out: Record<string, unknown> = {};
            switch (action) {
                case "talk": interact(); break;
                case "pamphlet": quickPamphlet(); break;
                case "persuade": dialogueAction("dlg-persuade"); break;
                case "recruit": dialogueAction("dlg-recruit"); break;
                case "follow": dialogueAction("dlg-follow"); break;
                case "leave": closeDialogue(); break;
                case "walk": {
                    const steps = 30;
                    for (let i = 0; i < steps; i++) {
                        const tx = body.x + Number(a.dx ?? 0) / steps, tz = body.z + Number(a.dz ?? 0) / steps;
                        const p = nav ? nav.collide(tx, tz, 0.38) : [tx, tz];
                        body.x = p[0]; body.z = p[1];
                    }
                    body.y = heightAt(body.x, body.z);
                    street.player.x = body.x; street.player.z = body.z;
                    break;
                }
                case "approach": {
                    // Stand in front of the nearest civilian (or orator), facing them.
                    const want = typeof a.weapon === "string" ? a.weapon : "civilian";
                    const target = street.actors.filter(x => alive(x) && x.kind === want).sort((p, q) => Math.hypot(p.x - body.x, p.z - body.z) - Math.hypot(q.x - body.x, q.z - body.z))[0];
                    if (!target) throw new Error(`No ${want} nearby.`);
                    target.state = "idle"; target.stateTime = -20; target.path = []; target.speed = 0;
                    body.x = target.x - Math.sin(target.heading + Math.PI) * -1.6;
                    body.z = target.z - Math.cos(target.heading + Math.PI) * -1.6;
                    body.yaw = Math.atan2(target.x - body.x, target.z - body.z);
                    target.heading = body.yaw + Math.PI;
                    body.y = heightAt(body.x, body.z);
                    street.player.x = body.x; street.player.z = body.z; street.player.heading = body.yaw;
                    out.target = target.name;
                    break;
                }
                case "govern": if (c) {
                    // Debug: the party takes the most populous regions up to `amount` of humanity.
                    let share = governedShare(c);
                    for (const d of campaignRegions(c).sort((x, y) => y.pop - x.pop)) {
                        if (share >= (typeof a.amount === "number" ? a.amount : 0.8)) break;
                        if (c.regions[d.id].governor === PARTY) continue;
                        c.regions[d.id].governor = PARTY;
                        share = governedShare(c);
                    }
                    advanceDay(c, region);
                    if (c.outcome) mode = "outcome";
                } break;
                case "followers": if (c) {
                    // The best fighters walk with you (armed if the treasury allows).
                    const n = typeof a.count === "number" ? a.count : 2;
                    for (const m of [...c.members].filter(x => x.role === "none" && !x.follower).sort((x, y) => y.combat - x.combat).slice(0, n)) setFollower(c, m.id, true);
                    out.followers = followers(c).map(m => m.name);
                } break;
                case "face-enemy": {
                    const foe = soldiers(street).sort((p, q) => Math.hypot(p.x - body.x, p.z - body.z) - Math.hypot(q.x - body.x, q.z - body.z))[0];
                    if (foe) { body.yaw = Math.atan2(foe.x - body.x, foe.z - body.z); street.player.heading = body.yaw; out.enemyDistance = r2(Math.hypot(foe.x - body.x, foe.z - body.z)); }
                } break;
                case "face": {
                    if (typeof a.yaw === "number") body.yaw = a.yaw;
                    // sunSide: turn so the sun stands this many radians to your right (0: ahead, pi: behind).
                    if (typeof a.sunSide === "number" && frame) body.yaw = Math.atan2(dot(SUN_DIRECTION, frame.east), dot(SUN_DIRECTION, frame.north)) - a.sunSide;
                    if (typeof a.turn === "number") body.yaw += a.turn;
                    if (typeof a.pitch === "number") body.pitch = a.pitch;
                } break;
                case "shoot": fire(c?.player.weapon ?? "pistol"); break;
                case "shoot-guard": {
                    // Real shots (the same path as the trigger) at the nearest compound defender, aimed at
                    // their chest: checks that each fallen defender leaves its garrison for good.
                    const guards = street.actors.filter(x => x.compound && alive(x)).sort((x, y) => Math.hypot(x.x - body.x, x.z - body.z) - Math.hypot(y.x - body.x, y.z - body.z));
                    const g0 = guards[0];
                    if (!g0 || !g0.compound || !c) throw new Error("No defender in sight.");
                    const cs = c.compounds![g0.compound];
                    // Take a firing position a dozen meters from them with a clear line (inside the walls).
                    let spot: [number, number] | null = null;
                    for (const rr of [12, 8, 16, 5]) {
                        for (let k = 0; k < 24 && !spot; k++) {
                            const ang = k / 24 * Math.PI * 2, x = g0.x + Math.sin(ang) * rr, z = g0.z + Math.cos(ang) * rr;
                            if (nav && (!nav.walkable(x, z) || !nav.lineClear(x, z, g0.x, g0.z))) continue;
                            spot = [x, z];
                        }
                        if (spot) break;
                    }
                    if (spot) { body.x = spot[0]; body.z = spot[1]; body.y = heightAt(spot[0], spot[1]); street.player.x = body.x; street.player.z = body.z; }
                    out.from = spot; out.guardAt = [r2(g0.x), r2(g0.z)];
                    const before = cs.garrison;
                    let kills = 0;
                    for (let k = 0; k < (typeof a.shots === "number" ? a.shots : 6); k++) {
                        const g = street.actors.filter(x => x.compound === cs.id && alive(x)).sort((x, y) => Math.hypot(x.x - body.x, x.z - body.z) - Math.hypot(y.x - body.x, y.z - body.z))[0];
                        if (!g) break;
                        body.yaw = Math.atan2(g.x - body.x, g.z - body.z);
                        const eye: Vec3 = [body.x + Math.sin(body.yaw) * 0.3, body.y + EYE - 0.1, body.z + Math.cos(body.yaw) * 0.3];
                        const wasAlive = alive(g);
                        const before = g.health;
                        fire(c.player.weapon, normalize(sub([g.x, g.y + 1.2, g.z], eye)));
                        ((out.hits ??= []) as number[]).push(r2(before - g.health));
                        if (wasAlive && !alive(g)) kills++;
                    }
                    out.kills = kills; out.garrisonBefore = before; out.garrison = cs.garrison; out.guardsStanding = guardsOf(street, cs.id).length;
                } break;
                case "ads": adsButton = a.on !== false; break;
                case "face-guard": {
                    // Face the nearest soldier, `offset` radians to the side (to watch aim assist pull you on).
                    const g = street.actors.filter(x => x.kind === "soldier" && alive(x)).sort((x, y) => Math.hypot(x.x - body.x, x.z - body.z) - Math.hypot(y.x - body.x, y.z - body.z))[0];
                    if (!g) throw new Error("No soldier nearby.");
                    const off = typeof a.offset === "number" ? a.offset : 0;
                    body.yaw = Math.atan2(g.x - body.x, g.z - body.z) + off;
                    body.pitch = Math.atan2(g.y + 1.25 - (body.y + EYE), Math.hypot(g.x - body.x, g.z - body.z));
                    out.guard = g.id; out.distance = r2(Math.hypot(g.x - body.x, g.z - body.z)); out.yaw = body.yaw;
                } break;
                case "view-building": {
                    // Stand in the street before the nearest city building (a Mesha city block), looking at its front.
                    if (indoors) leaveHouse();
                    const near = (nav?.rects ?? []).filter(r => r.kind !== "house" && !r.key.startsWith("al-") && r.hw > 5 && r.height > 9
                            && !!buildingByKey.get(r.key) && buildingValues(buildingByKey.get(r.key)!, 2) !== null)
                        .sort((p, q) => Math.hypot(p.cx - body.x, p.cz - body.z) - Math.hypot(q.cx - body.x, q.cz - body.z));
                    let placed = false;
                    for (const r of near.slice(0, 150)) {
                        if (placed) break;
                        const side = doorSide(r);
                        const fx = -r.uz * side, fz = r.ux * side;
                        const kerb: [number, number] = [r.cx + fx * (r.hd + 3), r.cz + fz * (r.hd + 3)];
                        for (const dist of typeof a.distance === "number" ? [a.distance] : [24, 18, 32, 13]) {
                            const back = dist + r.hd;
                            const x = r.cx + fx * back, z = r.cz + fz * back;
                            if (nav && (!nav.walkable(x, z) || !nav.sightClear(x, z, kerb[0], kerb[1]))) continue;
                            body.x = x; body.z = z; body.y = heightAt(x, z);
                            body.yaw = Math.atan2(r.cx - x, r.cz - z) + (typeof a.turn === "number" ? a.turn : 0.3);
                            body.pitch = 0.2;
                            street.player.x = body.x; street.player.z = body.z;
                            out.building = r.key; out.height = r.height; out.distance = dist; placed = true;
                            const b = buildingByKey.get(r.key);
                            out.values = b ? buildingValues(b as CityBuilding, 2) : null;
                            break;
                        }
                    }
                    if (!placed) throw new Error("No city building with open ground in front of it nearby.");
                } break;
                case "view-furniture": {
                    // Inside a house: stand back from its dining table, looking at it.
                    if (!indoors) throw new Error("Not inside a house.");
                    const t = interiorItems(indoors.rect, indoors.floor)[0];
                    const dx = body.x - t.x, dz = body.z - t.z, d = Math.hypot(dx, dz) || 1;
                    body.x = t.x + dx / d * 2.4; body.z = t.z + dz / d * 2.4;
                    body.yaw = Math.atan2(t.x - body.x, t.z - body.z); body.pitch = -0.35;
                } break;
                case "call-car": summonCar(); out.car = playerCar ? { call: playerCar.call ?? null, distance: r2(Math.hypot(playerCar.x - body.x, playerCar.z - body.z)) } : null; break;
                case "rally": spawnOrator(street, nav, streetContext(), rng); out.rally = street.rally; break;
                case "squad": out.spawned = spawnSquad(street, nav, streetContext(), rng, typeof a.count === "number" ? a.count : 4, false); break;
                case "rest": act("rest"); break;
                case "days": if (c) for (let i = 0; i < (typeof a.days === "number" ? a.days : 1); i++) advanceDay(c, region); if (c?.outcome) mode = "outcome"; break;
                case "funds": if (c) c.party.funds += typeof a.amount === "number" ? a.amount : 10000; break;
                case "organize": act("auto-organize"); break;
                case "arm": if (c) { const e = armMembers(c, where, typeof a.count === "number" ? a.count : 10); if (e) throw new Error(e); } break;
                case "war": act("war", where); break;
                case "coup": act("coup", where); break;
                case "election": act("election", where); break;
                case "travel": act("travel", where); break;
                case "equip": if (c && typeof a.weapon === "string") {
                    c.player.weapon = a.weapon;
                    if (!c.player.weapons.includes(a.weapon)) c.player.weapons.push(a.weapon);
                    const w = weaponById(a.weapon);
                    if (Number.isFinite(w.magazine) && (c.player.ammo[w.id] ?? 0) <= 0) c.player.ammo[w.id] = w.magazine * 3;
                } break;
                case "buy": act("buy-weapon", a.weapon); break;
                case "save": out.saved = save(); break;
                case "load": act("continue"); break;
                case "car": useCar(); break;
                case "land": landCar(); break;
                case "use": useItemNow(String(a.item ?? "medkit")); break;
                case "heal": onKey("h"); break;
                case "house": {
                    // Stand at the front door of the nearest house you can enter.
                    if (indoors) leaveHouse();
                    const homes = (nav?.rects ?? []).filter(r => r.kind === "house" && r.hw > 1.8 && r.hd > 1.8)
                        .sort((p, q) => Math.hypot(p.door[0] - body.x, p.door[1] - body.z) - Math.hypot(q.door[0] - body.x, q.door[1] - body.z));
                    const r = typeof a.loot === "boolean" && a.loot && c ? homes.find(h => { const l = houseLoot(h.key); return l && !isLooted(c, h.key); }) : homes[0];
                    if (!r) throw new Error("No house to enter nearby.");
                    body.x = r.door[0]; body.z = r.door[1]; body.y = heightAt(body.x, body.z);
                    body.yaw = Math.atan2(r.cx - body.x, r.cz - body.z);
                    street.player.x = body.x; street.player.z = body.z;
                    out.house = r.key;
                    toolHouse = r;
                } break;
                case "enter": {
                    // The house at this door, even with a shop kiosk or someone to talk to closer by.
                    const chosen = toolHouse; toolHouse = null;
                    const house = indoors ? null : chosen ?? (nav ? houseAtDoor(nav.rects, body.x, body.z) : null);
                    if (house) enterHouse(house); else interact();
                    out.entered = indoors?.rect.key ?? null;
                } break;
                case "loot": {
                    const spot = lootSpot();
                    if (!spot) throw new Error(indoors ? "Nothing left to search here." : "Not inside a house.");
                    body.x = spot[0]; body.z = spot[1] - 1.2; interact();
                } break;
                case "leave-house": {
                    if (!indoors) throw new Error("Not inside a house.");
                    leaveHouse();
                } break;
                case "shop": {
                    // Walk into the nearest shop (of `kind` if given).
                    const want = typeof a.kind === "string" ? a.kind : null;
                    if (want === "hq") { openShop("hq"); break; }
                    const s2 = shopsHere.filter(x => !want || x.kind === want).sort((p, q) => Math.hypot(p.x - body.x, p.z - body.z) - Math.hypot(q.x - body.x, q.z - body.z))[0];
                    if (!s2) throw new Error(`No ${want ?? ""} shop nearby.`);
                    body.x = s2.x; body.z = s2.z; body.y = heightAt(body.x, body.z);
                    street.player.x = body.x; street.player.z = body.z;
                    interact();
                    out.shopKind = s2.kind;
                } break;
                case "shop-buy": if (c) { const e = buyStock(c, { kind: String(a.kind) as Parameters<typeof buyStock>[1]["kind"], id: String(a.item ?? a.weapon) }); if (e) throw new Error(e); } break;
                case "shop-sell": act("shop-sell", String(a.item)); break;
                case "shop-close": closeShop(); break;
                case "compound": {
                    if (indoors) leaveHouse();
                    // Stand outside the gate of the mission's (or the nearest) compound, facing it.
                    updateCompounds();
                    const want = c?.mission && c.mission.step !== "done" ? c.mission.compound : null;
                    let p = placedCompounds.find(x => x.cs.id === (typeof a.region === "string" ? `mil-${a.region}` : want)) ?? placedCompounds.find(x => !x.cs.captured);
                    if (!p && c) {
                        // Too far to be on the street map: walk there first (teleport), then lay it out.
                        const cs = want ? c.compounds?.[want] : null;
                        if (!cs) throw new Error("No compound nearby.");
                        const [x, z] = localOf(cs.lat, cs.lon);
                        body.x = x; body.z = z + 80; body.y = heightAt(body.x, body.z);
                        street.player.x = body.x; street.player.z = body.z;
                        buildNav(body.x, body.z); updateCompounds();
                        p = placedCompounds.find(q => q.cs.id === cs.id);
                    }
                    if (!p) throw new Error("No compound nearby.");
                    const back = typeof a.distance === "number" ? a.distance : p.layout.radius + 30;
                    const [gx, gz] = compoundToLocal(p.cx, p.cz, p.cs.yaw, 0, back);
                    const spot = nav?.nearestWalkable(gx, gz, 20) ?? [gx, gz];
                    body.x = spot[0]; body.z = spot[1]; body.y = heightAt(body.x, body.z);
                    body.yaw = Math.atan2(p.cx - body.x, p.cz - body.z);
                    street.player.x = body.x; street.player.z = body.z; street.player.heading = body.yaw;
                    out.compound = p.cs.id;
                } break;
                case "view-wall": {
                    // Stand a couple of meters outside the nearest compound's nearest wall, looking at
                    // it a little obliquely (the material maps' parallax shows best at an angle).
                    updateCompounds();
                    const p = [...placedCompounds].sort((x, y) => Math.hypot(x.cx - body.x, x.cz - body.z) - Math.hypot(y.cx - body.x, y.cz - body.z))[0];
                    if (!p) throw new Error("No compound nearby.");
                    let wall: Rect | null = null;
                    p.layout.structures.forEach((st, i) => {
                        const r = p.rects[i];
                        if (st.kind === "wall" && (!wall || Math.hypot(r.cx - body.x, r.cz - body.z) < Math.hypot(wall.cx - body.x, wall.cz - body.z))) wall = r;
                    });
                    if (!wall) throw new Error("No wall there.");
                    const w: Rect = wall;
                    const nx = -w.uz, nz = w.ux;
                    const out1 = Math.sign((w.cx - p.cx) * nx + (w.cz - p.cz) * nz) || 1;
                    const dist = typeof a.distance === "number" ? a.distance : 2.6;
                    body.x = w.cx + nx * out1 * (w.hd + dist) + w.ux * 1.5; body.z = w.cz + nz * out1 * (w.hd + dist) + w.uz * 1.5;
                    body.y = heightAt(body.x, body.z);
                    body.yaw = Math.atan2(w.cx - body.x, w.cz - body.z);
                    body.pitch = -0.08;
                    street.player.x = body.x; street.player.z = body.z; street.player.heading = body.yaw;
                    out.compound = p.cs.id;
                } break;
                case "storm": {
                    // Debug: defeat the defenders of the nearest compound (as if you had fought them).
                    const p = placedCompounds.filter(x => !x.cs.captured).sort((x, y) => Math.hypot(x.cx - body.x, x.cz - body.z) - Math.hypot(y.cx - body.x, y.cz - body.z))[0];
                    if (!p) throw new Error("No compound nearby.");
                    for (const g of guardsOf(street, p.cs.id)) { g.health = 0; g.state = "dead"; }
                    p.cs.garrison = 0;
                    out.compound = p.cs.id;
                } break;
                case "flag": {
                    const p = placedCompounds.filter(x => !x.cs.captured).sort((x, y) => Math.hypot(x.cx - body.x, x.cz - body.z) - Math.hypot(y.cx - body.x, y.cz - body.z))[0] ?? placedCompounds[0];
                    if (!p) throw new Error("No compound nearby.");
                    body.x = p.flag[0] + 1; body.z = p.flag[1] + 1; body.y = heightAt(body.x, body.z);
                    street.player.x = body.x; street.player.z = body.z;
                } break;
                case "die": if (c && region) { street.player.health = 0; street.player.dead = true; c.player.health = 0; respawn(playerDied(c, region)); } break;
                case "checkpoint": setCheckpointHere(); out.checkpoint = c?.checkpoint; break;
                case "to-car": {
                    // Stand beside your parked car (rebuilding the street map there).
                    if (!playerCar) throw new Error("No car.");
                    if (indoors) leaveHouse();
                    const spot = nav?.nearestWalkable(playerCar.x + Math.cos(playerCar.yaw) * 4.6, playerCar.z - Math.sin(playerCar.yaw) * 4.6, 6) ?? [playerCar.x + 4.6, playerCar.z];
                    body.x = spot[0]; body.z = spot[1]; body.y = heightAt(body.x, body.z);
                    body.yaw = Math.atan2(playerCar.x - body.x, playerCar.z - body.z);
                    street.player.x = body.x; street.player.z = body.z;
                    if (nav && Math.hypot(body.x - nav.cx, body.z - nav.cz) > 100) buildNav(body.x, body.z);
                } break;
                case "to-cobra": {
                    // Stand beside the nearest parked Cobra (a compound's, or yours), facing it.
                    if (indoors) leaveHouse();
                    updateCompounds();
                    let at: [number, number] | null = cobra && !cobra.piloting ? [cobra.x, cobra.z] : null;
                    let yaw = cobra?.yaw ?? 0;
                    if (!at) {
                        const p = [...placedCompounds].filter(q => !q.cs.cobraTaken).sort((x, y) => Math.hypot(x.cx - body.x, x.cz - body.z) - Math.hypot(y.cx - body.x, y.cz - body.z))[0];
                        if (!p) throw new Error("No Cobra nearby.");
                        at = compoundCobraAt(p); yaw = p.cs.yaw;
                    }
                    const spot = nav?.nearestWalkable(at[0] + Math.cos(yaw) * 4.4, at[1] - Math.sin(yaw) * 4.4, 6) ?? [at[0] + 4.4, at[1]];
                    body.x = spot[0]; body.z = spot[1]; body.y = heightAt(body.x, body.z);
                    body.yaw = Math.atan2(at[0] - body.x, at[1] - body.z);
                    street.player.x = body.x; street.player.z = body.z;
                    out.cobraAt = [r2(at[0]), r2(at[1])];
                } break;
                case "board-cobra": {
                    const cob = cobraInReach();
                    if (!cob) throw new Error("No Cobra within reach.");
                    boardCobra(cob);
                } break;
                case "cobra-fire": {
                    // Real missiles from the pods (the trigger's path, aimed for the tool): at the nearest
                    // standing compound building, map building, or soldier ("structure" | "building" | "soldier").
                    if (!inCobra() || !cobra || !cobraState) throw new Error("Not aboard a Cobra.");
                    const what = typeof a.at === "string" ? a.at : "structure";
                    let target: Vec3 | null = null, id: number | null = null;
                    if (what === "soldier") {
                        const s0 = soldiers(street).sort((x, y) => Math.hypot(x.x - body.x, x.z - body.z) - Math.hypot(y.x - body.x, y.z - body.z))[0];
                        if (!s0) throw new Error("No soldier in sight.");
                        target = [s0.x, s0.y + 1, s0.z]; id = s0.id;
                    } else {
                        const rs2 = (nav?.rects ?? []).filter(r => what === "structure" ? r.kind === "military" && r.height > 3 : r.kind === "house" || r.kind === "box")
                            .sort((x, y) => Math.hypot(x.cx - body.x, x.cz - body.z) - Math.hypot(y.cx - body.x, y.cz - body.z));
                        const r0 = typeof a.key === "string" ? nav?.rects.find(r => r.key === a.key) : rs2[0];
                        if (!r0) throw new Error("Nothing to fire at.");
                        target = [r0.cx, r0.base + Math.min(r0.height * 0.5, 4), r0.cz];
                        out.targetKey = r0.key;
                    }
                    const n = typeof a.count === "number" ? a.count : 1;
                    let fired = 0;
                    const before = { fell: Object.keys(c?.ruins ?? {}).length, explosions: fx.explosions };
                    for (let k = 0; k < n; k++) {
                        cobraState.cooldown = 0;
                        if (cobraState.cells < 1) cobraState.cells = 1;
                        if (launch(target, id)) fired++;
                        // Let it fly: fixed small steps until it strikes.
                        for (let t = 0; t < 400 && missiles.length; t++) {
                            stepMissilesNow(1 / 60);
                            stepFx(fx, 1 / 60, [0, 0], heightAt);
                            pieces = stepPieces(pieces, 1 / 60, heightAt);
                        }
                    }
                    if (navRebuild > 0 && nav) { navRebuild = 0; buildNav(nav.cx, nav.cz); }
                    out.fired = fired;
                    out.exploded = fx.explosions - before.explosions;
                    out.collapsed = Object.keys(c?.ruins ?? {}).length - before.fell;
                } break;
                case "aim-at": {
                    // Turn (on foot or flying) to look at the nearest building of a kind or a key, from `pitch`.
                    const what = typeof a.at === "string" ? a.at : "structure";
                    const r0 = typeof a.key === "string" ? [...(nav?.rects ?? []), ...ruinRects].find(r => r.key === a.key)
                        : (nav?.rects ?? []).filter(r => what === "structure" ? r.kind === "military" && r.height > 3 : r.kind === "house" || r.kind === "box")
                            .sort((x, y) => Math.hypot(x.cx - body.x, x.cz - body.z) - Math.hypot(y.cx - body.x, y.cz - body.z))[0];
                    if (!r0) throw new Error("Nothing to look at.");
                    body.yaw = Math.atan2(r0.cx - body.x, r0.cz - body.z);
                    if (typeof a.pitch === "number") body.pitch = a.pitch;
                    const fl = driving();
                    if (fl) fl.yaw = body.yaw;
                    out.key = r0.key; out.distance = r2(Math.hypot(r0.cx - body.x, r0.cz - body.z));
                } break;
                case "detonate": {
                    // An explosion of `power` at a building (`key`), or `ahead` meters in front of you.
                    let x = body.x, y = body.y + 1, z = body.z;
                    if (typeof a.key === "string") {
                        const r0 = nav?.rects.find(r => r.key === a.key);
                        if (!r0) throw new Error("No such building on the street map.");
                        x = r0.cx; y = r0.base + Math.min(3, r0.height / 2); z = r0.cz;
                    } else {
                        const ahead = typeof a.ahead === "number" ? a.ahead : 12;
                        x += Math.sin(body.yaw) * ahead; z += Math.cos(body.yaw) * ahead; y = heightAt(x, z) + 0.5;
                    }
                    const res = detonate(x, y, z, typeof a.power === "number" ? a.power : 1);
                    if (navRebuild > 0 && nav) { navRebuild = 0; buildNav(nav.cx, nav.cz); }
                    out.fell = res.fell; out.killed = res.killed; out.at = [r2(x), r2(y), r2(z)];
                } break;
                case "fx-run": {
                    // Plays the effects on for `seconds` (fixed steps, nothing else moves): pieces settle, fires burn.
                    const secs = typeof a.seconds === "number" ? a.seconds : 1;
                    for (let t = 0; t < secs * 60; t++) {
                        stepMissilesNow(1 / 60);
                        stepFx(fx, 1 / 60, [0, 0], heightAt);
                        pieces = stepPieces(pieces, 1 / 60, heightAt);
                    }
                } break;
                case "altitude": {
                    // Debug: the vehicle you fly jumps to `meters` over the ground (comrades' cars keep formation).
                    const v = driving();
                    if (!v) throw new Error("Not flying.");
                    v.y = carGround(v.x, v.z, heightAt) + (typeof a.meters === "number" ? a.meters : 300);
                    v.vx = v.vy = v.vz = 0; v.state = "hovering"; body.y = v.y;
                    convoy.forEach((cv, i) => { const [sx, sz] = escortSlot(i, v); cv.car.x = sx; cv.car.z = sz; cv.car.y = v.y + 1.5; cv.car.state = "flying"; cv.car.call = null; });
                    out.altitude = r2(v.y - carGround(v.x, v.z, heightAt));
                } break;
                case "over-roof": {
                    // Debug: hover `above` meters over the nearest flat roof a car can land on (facing it).
                    const v = driving();
                    if (!v) throw new Error("Not flying.");
                    const env = flightEnvironment();
                    const roofs = (nav?.rects ?? []).filter(r => r.kind === "box" && r.hw > 5 && r.hd > 5 && roofUnder(r.cx, r.cz, env.buildings) !== null)
                        .sort((p, q) => Math.hypot(p.cx - body.x, p.cz - body.z) - Math.hypot(q.cx - body.x, q.cz - body.z));
                    const r0 = roofs[0];
                    if (!r0) throw new Error("No flat roof nearby.");
                    v.x = r0.cx; v.z = r0.cz; v.y = r0.base + r0.height + (typeof a.above === "number" ? a.above : 30);
                    v.vx = v.vy = v.vz = 0; v.state = "hovering";
                    body.x = v.x; body.z = v.z; body.y = v.y;
                    convoy.forEach((cv, i) => { const [sx, sz] = escortSlot(i, v); cv.car.x = sx; cv.car.z = sz; cv.car.y = v.y + 1.5; cv.car.state = "flying"; cv.car.call = null; });
                    out.roof = { key: r0.key, fill: r0.fill ?? null, top: r2(r0.base + r0.height), ground: r2(heightAt(r0.cx, r0.cz)), door: r0.door.map(r2) };
                } break;
                case "autopilot": {
                    // A destination: a region or settlement (`region`), or `lat`/`lon`; engaged at once when flying.
                    if (typeof a.lat === "number" && typeof a.lon === "number") setAutopilot(typeof a.weapon === "string" ? a.weapon : "the waypoint", a.lat, a.lon);
                    else { const d = regionDefById(where); if (!d) throw new Error("No such place."); setAutopilot(d.name, d.lat, d.lon); }
                    out.autopilot = autopilot;
                } break;
                case "face-shop": {
                    // Debug: turn to the nearest shop more than 15 m off (its sky marker in view).
                    const sh = shopsHere.filter(x => Math.hypot(x.x - body.x, x.z - body.z) > 15).sort((p, q) => Math.hypot(p.x - body.x, p.z - body.z) - Math.hypot(q.x - body.x, q.z - body.z))[0];
                    if (!sh) throw new Error("No shop nearby.");
                    body.yaw = Math.atan2(sh.x - body.x, sh.z - body.z); body.pitch = 0.05;
                    out.shop = { kind: sh.kind, distance: r2(Math.hypot(sh.x - body.x, sh.z - body.z)) };
                } break;
                case "threaten": if (c) {
                    // Debug: an invasion marching on a party region (`region`, or the first one held), arriving at dawn.
                    const id = typeof a.region === "string" ? a.region : Object.values(c.regions).find(rs => rs.governor === PARTY && rs.id !== region)?.id;
                    if (!id || c.regions[id].governor !== PARTY) throw new Error("No party region to threaten.");
                    c.regions[id].threat = { attacker: "vanguard", force: typeof a.count === "number" ? a.count : 2000, day: c.day + 1 };
                    out.threatened = id;
                } break;
                case "troops": if (c) {
                    // Debug: `count` armed members stationed in `region` (or here).
                    c.regions[where].army = typeof a.count === "number" ? a.count : 1000;
                    out.troops = { region: where, army: c.regions[where].army };
                } break;
                case "cobra-hull": if (cobraState) { cobraState.hull = typeof a.hull === "number" ? a.hull : cobraState.hull; if (cobraState.hull <= 0) wreckCobra(); } break;
                case "view": if (typeof a.distance === "number") body.camDistance = a.distance; if (typeof a.firstPerson === "boolean") body.firstPerson = a.firstPerson; if (typeof a.pitch === "number") body.pitch = a.pitch; if (typeof a.yaw === "number") body.yaw = a.yaw; break;
                default: throw new Error(`Unknown action ${action}`);
            }
            placeCamera();
            drawUi(0, true);
            return { ...out, ...snapshot() };
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

type GamePipelineConfig = Parameters<typeof Entropy.Pipeline.create>[0];
function createGamePipeline(config: GamePipelineConfig): string {
    const shared = { ...config, extraBindGroups: config.extraBindGroups!.map((group, i) => i === 0
        ? { entries: [...group.entries, ...CLOUD_BIND_ENTRIES] } : group) };
    return Entropy.Pipeline.create(shared);
}

addon.onInit(() => {
    cloudTexture = createCloudCache();
    pipelineId = createGamePipeline({
        name: "Allegiance",
        layout: "mesh",
        pbr: false,
        sunShadows: true,
        vertexShader: ALLEGIANCE_SHADER,
        fragmentShader: ALLEGIANCE_SHADER,
        extraBindGroups: [{ entries: [
            { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
            { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
            ...MATERIAL_BIND_ENTRIES,
        ] }],
    });
    // The terrain (with its roads and distant building boxes) receives sun shadows but casts none:
    // its own relief is shaded by its normals, and its vertices would cost the cascades the most.
    terrainPipelineId = createGamePipeline({
        name: "Allegiance Terrain", layout: "mesh", pbr: false, sunShadows: true, shadowCaster: false,
        vertexShader: ALLEGIANCE_TERRAIN_SHADER, fragmentShader: ALLEGIANCE_TERRAIN_SHADER,
        extraBindGroups: [{ entries: [
            { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
            { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
            ...MATERIAL_BIND_ENTRIES,
            // The territory overlay seen from the air (al_territory.ts).
            ...TERRITORY_BIND_ENTRIES,
        ] }],
    });
    territoryBuffer = uniform(TERRITORY_FLOATS);
    Entropy.Buffer.write(territoryBuffer, packTerritories([], 0, 0));
    worldBuffer = uniform(WORLD_FLOATS);
    // Houses: instanced batches of Items, one draw per house mesh (qp_city.ts, qp_instances.ts).
    housePipelineId = createGamePipeline({
        name: "Allegiance Houses", layout: "mesh", pbr: false, sunShadows: true,
        vertexShader: ALLEGIANCE_INSTANCED_SHADER, fragmentShader: ALLEGIANCE_INSTANCED_SHADER,
        // Group 2: the world, the records, then the material maps (al_materials.ts).
        extraBindGroups: [{ entries: [...INSTANCED_BIND_GROUPS[0].entries, ...MATERIAL_BIND_ENTRIES] }],
    });
    // Small props and understory cast into the two nearest cascades (52 m), ground cover into the
    // nearest (12 m): beyond, their shadows are a texel or two, and hundreds of grass patches drawn
    // into every cascade cost more than all the trees.
    for (const [cls, cascades] of [["small", 2], ["ground", 1]] as const) {
        scatterPipelineIds[cls] = createGamePipeline({
            name: `Allegiance Scatter ${cls}`, layout: "mesh", pbr: false, sunShadows: true, shadowCascades: cascades,
            vertexShader: ALLEGIANCE_INSTANCED_SHADER, fragmentShader: ALLEGIANCE_INSTANCED_SHADER,
            extraBindGroups: [{ entries: [...INSTANCED_BIND_GROUPS[0].entries, ...MATERIAL_BIND_ENTRIES] }],
        });
    }
    scatterPipelineIds.tall = housePipelineId;
    // The maps every mesh of that pipeline binds; missing files load as checkerboards.
    try {
        const m = loadMaterials(c => Entropy.Texture.loadArray(c));
        materialsMissing = m.missing.map(x => `${x.set}/${x.map}`);
        if (materialsMissing.length) Entropy.println(`[allegiance] material maps missing (checkerboard): ${materialsMissing.join(", ")}`);
    } catch (e) { Entropy.println(`[allegiance] material maps: ${(e as Error).message}`); }
    peoplePipelineId = createGamePipeline({
        // People cast into the two nearest cascades (52 m): further out their shadows are a texel.
        name: "Allegiance People", layout: "mesh", pbr: false, sunShadows: true, shadowCascades: 2,
        vertexShader: PEOPLE_SHADER, fragmentShader: PEOPLE_SHADER,
        // binding 1: every instance's PersonRecord (al_crowd.ts), read by instance index.
        extraBindGroups: [{ entries: [
            { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
            { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "StorageReadOnly" },
        ] }],
    });
    people = new PeopleMeshes(Entropy.MeshCache);
    skyItem = uniform(ITEM_FLOATS);
    writeItem(skyItem, identity4(), [1, 1, 1, 0]);
    terrainId = Entropy.QuadPlanet.create({
        id: "allegiance-earth", planets: WORLD_PLANETS, pipelineId: terrainPipelineId, worldBufferId: worldBuffer,
        extraBindings: [...sharedMaterialBindings(), ...territoryBindings(territoryBuffer)],
        city: { house: houseRule() },
    });
    setTerrainBackend({
        sample: (p, d, wait) => Entropy.QuadPlanet.sample(terrainId, p.id, d, { wait }),
        normal: (p, d, s) => Entropy.QuadPlanet.normal(terrainId, p.id, d, s),
        landingSite: (p, preferred) => Entropy.QuadPlanet.findLandingSite(terrainId, p.id, preferred),
        maxRelief: () => 8849,
    });
    try { Entropy.MeshCache.prune(HOUSE_NAMESPACE, 4e9); } catch (e) { Entropy.println(`[allegiance] house cache: ${(e as Error).message}`); }
    houses = new CityHouses({
        buildings: (position, radius, limit) => Entropy.QuadPlanet.buildings(terrainId, position, radius, { kind: "house", limit }) as CityBuilding[],
        status: (ns, k) => Entropy.MeshCache.status(ns, k),
        put: (ns, k, mesh, options) => Entropy.MeshCache.put(ns, k, mesh, options),
        info: (ns, k) => Entropy.MeshCache.info(ns, k),
        instances: meshCacheInstances(HOUSE_NAMESPACE, () => housePipelineId, () => worldBuffer, sharedMaterialBindings),
        // Mesha evaluations run in a worker isolate (Entropy.Worker); without the bundle they fail
        // and CityHouses evaluates here instead.
        generateInBackground: job => { try { return Entropy.Worker.start(HOUSE_WORKER_SCRIPT, job); } catch { return null; } },
        pollBackground: id => Entropy.Worker.poll(id).status,
        now: () => Date.now(),
    // 1 m size steps: similar footprints share one house mesh (and one instanced draw).
    // Chosen again every 1.5 m (at most every 100 ms in a fast car), not every frame you move.
    }, { ...HOUSE_LOD, minBuildIntervalMs: 250, sizeStep: 1, reselectDistance: 1.5, reselectMs: 100 });
    // Every other building on the map: Mesha city blocks (evaluated here, 5-80 ms each, cached).
    try { Entropy.MeshCache.prune(BUILDING_NAMESPACE, 2e9); } catch (e) { Entropy.println(`[allegiance] building cache: ${(e as Error).message}`); }
    buildings = new CityHouses({
        buildings: (position, radius, limit) => Entropy.QuadPlanet.buildings(terrainId, position, radius, { kind: "box", limit }) as CityBuilding[],
        status: (ns, k) => Entropy.MeshCache.status(ns, k),
        put: (ns, k, mesh, options) => Entropy.MeshCache.put(ns, k, mesh, options),
        info: (ns, k) => Entropy.MeshCache.info(ns, k),
        instances: meshCacheInstances(BUILDING_NAMESPACE, () => housePipelineId, () => worldBuffer, sharedMaterialBindings),
        now: () => Date.now(),
    // 2 m size steps (the model stretches to the real footprint): streets of similar blocks share meshes.
    }, { ...BUILDING_LOD, minBuildIntervalMs: 120, sizeStep: 2, reselectDistance: 2, reselectMs: 100 }, BUILDING_MODEL);
    spawnMesh("al-sky", buildSky(), skyItem);
    setupProps();
    setupViewModels();
    foliage = new FoliageMeshes(Entropy.MeshCache);
    try { cacheProps(Entropy.MeshCache); } catch (e) { Entropy.println(`[allegiance] prop cache: ${(e as Error).message}`); }
    const scatterEngines = Object.fromEntries((["tall", "small", "ground"] as ShadowClass[])
        .map(cls => [cls, meshCacheInstances(SCATTER_NAMESPACE, () => scatterPipelineIds[cls], () => worldBuffer, sharedMaterialBindings)])) as Record<ShadowClass, ReturnType<typeof meshCacheInstances>>;
    scatterBatches = new InstanceBatches({ ...scatterEngines.tall, createMesh: (key, meshId, buffer, n) => {
        const mesh = meshOfBatch(key);
        return scatterEngines[shadowClass(familyOfMesh(mesh) ?? "")].createMesh(mesh, meshId, buffer, n);
    } }, ITEM_FLOATS, { prefix: "al-scatter", idleFrames: 120 });
    fxBatches = new InstanceBatches(scatterEngines.small, ITEM_FLOATS, { prefix: "al-fx", idleFrames: 240 });
    cobraItem = uniform(ITEM_FLOATS);
    spawnMesh("al-cobra", buildCobra(), cobraItem); showProp("al-cobra", false);
    const flyingCar = buildFlyingCar();
    playerCarItem = uniform(ITEM_FLOATS);
    spawnMesh("al-player-car", flyingCar, playerCarItem); showProp("al-player-car", false);
    for (let i = 0; i < CONVOY_MAX; i++) {
        const item = uniform(ITEM_FLOATS); convoyItems.push(item);
        spawnMesh(`al-comrade-car-${i}`, flyingCar, item); showProp(`al-comrade-car-${i}`, false);
    }
    for (let i = 0; i < TRAFFIC_LIMIT; i++) {
        const item = uniform(ITEM_FLOATS); trafficItems.push(item);
        spawnMesh(`al-car-${i}`, flyingCar, item); showProp(`al-car-${i}`, false);
    }
    land = computeLand();
    hasSave = !!loadSave();
    writeWorld();
    Entropy.setGameMode(false);
    Entropy.Lighting.updateSun({ horizonColor: [0, 0, 0], zenithColor: [0, 0, 0], sunDirection: SUN_DIRECTION, sunColor: [1, 0.96, 0.9], sunIntensity: 0.2 });
    ui = new UiFrame(enginePainter(addon.UI as unknown as DrawApi), 1600, 900);
    setupInput();
    registerTools();
    try { profiling = Entropy.Profile.enabled(); } catch { profiling = false; }
    Entropy.println("[allegiance] initialized");
});

// Per-phase timing into the native frame profiler (ENTROPY_FRAME_PROFILE=1); free when it is off.
let profiling = false;
// One disabled subsystem per experiment. "houses" / "terrainStream" stop updates, retaining draws.
let profileDisable = "none";
let profileExperiment = 0;
let profileFreeze = false;
const PROFILE_SHADER_DISABLE: Record<string, number> = { cloudShadows: 1, skyClouds: 2, materials: 3, atmosphere: 4, stars: 5 };
const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
function timed<T>(phase: string, f: () => T): T {
    if (!profiling) return f();
    const t0 = clock();
    const r = f();
    Entropy.Profile.record(phase, clock() - t0);
    return r;
}

addon.onUpdatePlus("Global", () => {
    if (!terrainId) return;
    if (profiling) Entropy.Profile.count("#al experiment", profileExperiment);
    const now = Date.now();
    const real = lastMs ? Math.min(0.1, Math.max(0, (now - lastMs) / 1000)) : 1 / 60;
    lastMs = now;
    const dt = profileFreeze ? 0 : fixedStep ?? real;
    time += dt;
    frameCount++;
    controller.expire(time);
    if (mode !== "play" && mode !== "speech" && Math.abs(controller.left[1]) > 0.55 && time - lastMenuAxis > 0.22) {
        menuMove(controller.left[1] > 0 ? -1 : 1); lastMenuAxis = time;
    }
    for (const t of toasts) t.age += dt;
    toasts = toasts.filter(t => t.age < 5);

    const live = mode === "play" || mode === "speech" || mode === "dialogue";
    if (live && frame) {
        stepAim(dt);
        const flying = driving();
        if (flying) {
            const input = readInput();
            const descend = key("Control") || key("c") || controller.held.has("East");
            const spec = flying === cobra ? COBRA_SPEC : carSpec(campaign?.player.carUpgrades);
            if (autopilotOn && autopilot && manualFlight(input, descend)) { autopilotOn = false; flightWarp = 1; toast("You have the controls. P resumes the autopilot.", "info"); }
            if (autopilotOn && autopilot && flying.state !== "landing") flyAutopilot(flying, dt, spec);
            else {
                flightWarp = 1;
                flying.yaw = body.yaw;
                stepCar(flying, input, descend, dt, flightEnvironment(), spec);
            }
            body.x = flying.x; body.y = flying.y; body.z = flying.z; body.yaw = flying.yaw;
            body.pitch = Math.max(-1.25, Math.min(1.05, body.pitch + ((input.lookY ?? 0) + Number(input.lookUp) - Number(input.lookDown)) * dt * 1.4));
            body.speed = Math.hypot(flying.vx, flying.vz);
            if (flying === cobra) saveCobra(); else saveCar();
        } else if (indoors) {
            flightWarp = 1;
            // Inside a house: its floor underfoot, its outer walls around you.
            const floor = indoors.floor;
            stepBody(body, footInput(), dt, null, () => floor, adsMove(aim.ads));
            [body.x, body.z] = clampInside(indoors.rect, body.x, body.z, 0.3);
        } else stepBody(body, footInput(), dt, nav, heightAt, mode === "speech" ? 0 : adsMove(aim.ads));
        street.player.x = body.x; street.player.z = body.z; street.player.y = body.y; street.player.heading = body.yaw;
        street.player.moving = body.speed > 0.5;
        if (!driving()) stepWeapon(dt);
        else if (inCobra()) stepCobra(dt);
        stepCalledCar(dt);
        stepConvoy(dt);
        stepUrban(dt);
        // Out of a fight, wounds slowly heal (faster with Toughness).
        if (campaign && !soldiers(street).length && street.player.health < maxHealth(campaign)) {
            street.player.health = Math.min(maxHealth(campaign), street.player.health + (0.6 + skill(campaign, "toughness") * 0.3) * dt);
        }
        // Aboard the Cobra its hull takes the hits (al_street.ts damagePlayer).
        street.player.hull = inCobra() && cobraState ? cobraState.hull : undefined;
        if (profileDisable !== "street") timed("    al street sim", () => stepStreet(street, nav, streetContext(), dt, rng, heightAt));
        timed("    al fx", () => {
            stepMissilesNow(dt);
            const w = windVector(weather, frame!.east, frame!.north);
            stepFx(fx, dt, [dot(w, frame!.east), dot(w, frame!.north)], heightAt);
            pieces = stepPieces(pieces, dt, heightAt);
            if (fx.fires.length) burnStreet(street, (x, z) => fireDamageAt(fx, x, z), dt, !driving());
        });
        handleStreetEvents();
        if (inCobra() && cobraState) {
            cobraState.hull = street.player.hull ?? cobraState.hull;
            if (cobraState.hull <= 0) wreckCobra();
        }
        if (navRebuild > 0 && (navRebuild -= dt) <= 0 && nav) buildNav(nav.cx, nav.cz);
        if (speech) { stepSpeech(speech, dt); setCrowdTarget(street, speech.crowd); }
        if (dialogue) {
            const a = actorById(street, dialogue.actorId);
            if (!a || !alive(a) || Math.hypot(a.x - body.x, a.z - body.z) > 6) closeDialogue();
        }
        timed("    al nav", () => maintainNav(dt));
        compoundTimer += dt;
        if (compoundTimer >= 1) {
            compoundTimer = 0;
            timed("    al compounds", updateCompounds);
            if (campaign) { const msg = updateMission(campaign); if (msg) toast(msg, "good"); }
        }
        stepCompounds(dt);
        stepCheckpoints(dt);
        if (campaign) {
            campaign.dayClock += dt;
            if (campaign.dayClock >= DAY_SECONDS) { campaign.dayClock -= DAY_SECONDS; newDay(); }
            const pos = toWorld(frame, body.x, body.y, body.z);
            const ll = dirToLatLon(pos);
            campaign.player.lat = ll.lat;
            campaign.player.lon = ll.lon;
            const now2 = regionAt(ll.lat, ll.lon, campaign).id;
            if (now2 !== region) { region = now2; toast(`Entering ${regionDefById(now2)!.name}.`, "info"); }
        }
    }
    if (frameCount % 30 === 0) updateSun();
    // Cached ground heights are refreshed while elevation data is arriving and once when the last
    // of it lands; with nothing arriving they are final (refreshing them on a timer re-sampled
    // every planted thing, a hitch every 15 s). A minute's refresh stays as a backstop.
    heightCacheAge += dt;
    const waiting = (stats?.waitingForData ?? 0) > 0;
    if (heightCacheAge > (waiting ? 2 : 60) || (wasWaitingForData && !waiting)) { heightCacheAge = 0; clearHeights(); }
    wasWaitingForData = waiting;

    const pose = cameraForMode(dt);
    // Explosions shake the camera.
    if (fx.shake > 0.01 && frame && (mode === "play" || mode === "dialogue")) {
        const k = fx.shake * fx.shake * 0.35;
        pose.position = add(pose.position, add(scale(frame.up, Math.sin(time * 53) * k), scale(frame.east, Math.sin(time * 41 + 1) * k)));
    }
    const look = normalize(sub(pose.target, pose.position));
    let up = pose.up;
    if (Math.abs(dot(look, up)) > 0.98) up = normalize(cross(cross(look, up), look));
    if (distance(pose.position, renderOrigin) > REBASE) renderOrigin = [Math.round(pose.position[0]), Math.round(pose.position[1]), Math.round(pose.position[2])];
    Entropy.Camera.setTransform(toRender(pose.position), toRender(pose.target), up);
    lastCamera = { ...pose, up };
    focus = mode === "title" || mode === "setup" ? pose.position : (frame ? toWorld(frame, body.x, body.y + 1.6, body.z) : pose.position);

    if (frame && mode !== "title" && mode !== "setup" && mode !== "loading") timed("    al people", drawPeople);
    else hideWorld();
    drawProps();
    drawTraffic();
    timed("    al scatter", () => drawScatter(dt));
    timed("    al fx draw", drawFx);
    drawViewModel();
    updateSky(dt);
    if (frame) cloudDrift = add(cloudDrift, scale(windVector(weather, frame.east, frame.north), CLOUD_WIND_FACTOR * dt));
    updateMiniMap(dt);
    updateTerritories(dt);
    const loadingNow = mode === "loading";
    const orbit = mode === "title" || mode === "setup";
    // A fixed-step run streams everything it wants every frame, so it looks the same on any machine.
    timed("    al terrain stream", () => {
        if (profileDisable === "terrainStream") return;
        if (fixedStep) stream(Infinity, Infinity);
        else stream(loadingNow || orbit ? 40 : 10, loadingNow || orbit ? 30 : 12);
    });
    if (campaign && frameCount % 30 === 0) for (const place of stats?.settlements ?? []) discoverSettlement(campaign, place);
    if (profileDisable !== "houses") timed("    al houses", () => updateHouses(fixedStep ? Infinity : loadingNow ? 30 : 10));
    writeWorld();
    if (loadingNow) loadingStep();
    timed("    al ui", () => drawUi(dt));
    void length;
});
