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
import { ITEM_FLOATS, WORLD_FLOATS, packWorld } from "../../apps/quadplanet/qp_shader";
import { CityHouses, HOUSE_NAMESPACE, houseRule, type CityBuilding } from "../../apps/quadplanet/qp_city";
import { ALLEGIANCE_SHADER, ALLEGIANCE_INSTANCED_SHADER, PEOPLE_SHADER } from "./al_shader";
import { meshCacheInstances, INSTANCED_BIND_GROUPS, HOUSE_WORKER_SCRIPT } from "../../apps/quadplanet/qp_instances";
import { PeopleMeshes, PEOPLE_NAMESPACE, personLod, budgetLods, DEFAULT_PEOPLE_BUDGET, PERSON_TRIANGLES, type PersonLod, type PeopleBudget } from "./al_people";
import { CrowdBatches, maybeVisible } from "./al_crowd";
import { buildPodium, buildFlag, buildTracer, buildSky, type ModelMesh, type PersonLook } from "./al_models";
import {
    PARTY, PARTY_COLORS, REGIONS, RIVALS, IDEOLOGIES, blocById, regionDefById, weaponById, armorById, pamphletById, factionById,
} from "./al_data";
import { type Campaign, newCampaign, regionAt, partyShare, shiftSupport, pushNews, addKarma, SAVE_VERSION } from "./al_state";
import {
    advanceDay, applySpeech, applyRivalSpeech, applyPamphlet, reportFieldBattle, travel, moveHq, playerDied, callElection, attemptCoup,
    declareWar, proposePeace, suspendElections, setTaxRate, DAY_SECONDS, governedShare, worldSupport,
} from "./al_world";
import {
    appoint, autoOrganize, armMembers, disarm, moveArmy, buyWeapon, buyAmmo, buyArmor, buyPamphlets, buyFacility, raiseSkill,
    startScheme, recruitInPerson, setFollower, followers, skill, maxHealth, hasFacility, orgReport, gainXp, setArmed, regionFighters,
} from "./al_party";
import { startSpeech, stepSpeech, chooseCard, deliver, rebutHeckler, autoplay, bestCard, type SpeechState, type Grade } from "./al_speech";
import {
    type StreetState, type Actor, type StreetContext, newStreet, stepStreet, startCrowd, setCrowdTarget, endCrowd, convertListeners,
    nearestActor, persuade, tryRecruit, recruitChance, givePamphlet, playerShoot, castShot, shiftStreet, resetStreet, spawnSquad,
    listeners, soldiers, endRally, actorById, alive, opinionLabel, takeLoot, spawnOrator,
} from "./al_street";
import { NavGrid, NAV_SIZE, NAV_CELL, makeLocalFrame, toWorld, dirToWorld, buildingToRect, type LocalFrame } from "./al_nav";
import { type PlayerBody, type PlayerInput, NO_PLAYER_INPUT, newBody, stepBody, bodyCamera, EYE } from "./al_player";
import { enginePainter, THEME, type DrawApi } from "./al_ui";
import {
    type GameView, type Mode, type ConsoleTab, type SetupState, type LoadingInfo, type DialogueState, type LandRuns, UiFrame, drawScreen,
    LOADING_TIPS, MAP_LAT_TOP, MAP_LAT_BOTTOM,
} from "./al_screens";
import { makeRng, type Rng } from "./al_rng";

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
let peoplePipelineId = "";
let housePipelineId = "";
let worldBuffer = "";
let skyItem = "";
let terrainId = "";
let stats: QuadPlanetStreamStats | null = null;
let houses: CityHouses | null = null;
let hideRadius = 0;
let renderOrigin: Vec3 = [0, 0, 0];
const REBASE = 2048;
const ROAD_DISTANCE = 2500;

const toRender = (p: Vec3): Vec3 => sub(p, renderOrigin);
const uniform = (floats: number) => Entropy.Buffer.create({ size: floats * 4, usage: "Uniform" });
let people: PeopleMeshes;
const bindings = (item: string) => [
    { group: 2, binding: 0, resource: { type: "Buffer" as const, value: { id: worldBuffer } } },
    { group: 2, binding: 1, resource: { type: "Buffer" as const, value: { id: item } } },
];
const HIDDEN = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];

function writeItem(item: string, matrix: number[], tint: number[], extra: number[] = [0, 0, 0, 0]): void {
    Entropy.Buffer.write(item, new Float32Array([...matrix, tint[0], tint[1], tint[2], tint[3], extra[0], extra[1], extra[2], extra[3]]));
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

// --- Terrain queries in the local frame ----------------------------------------------------------

const heightCache = new Map<number, number>();
let heightCacheAge = 0;

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

function isSea(x: number, z: number): boolean {
    if (!frame) return false;
    const s = sampleEarth(normalize(toWorld(frame, x, 0, z)));
    return s.sea && s.terrain < -0.5;
}

function surfaceAt(lat: number, lon: number): Vec3 {
    const d = latLonToDir(lat, lon);
    return scale(d, EARTH.radius + sampleEarth(d).surface);
}

// --- Messages ------------------------------------------------------------------------------------

function toast(text: string, kind: "good" | "bad" | "info" = "info"): void {
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
        return c.version === SAVE_VERSION ? c : null;
    } catch {
        return null;
    }
}

// --- Loading a place -----------------------------------------------------------------------------

/** Starts loading the place at lat/lon: terrain, the city, its houses, then the street. */
function startLoading(lat: number, lon: number): void {
    const def = regionAt(lat, lon);
    region = def.id;
    mode = "loading";
    speech = null;
    dialogue = null;
    resetStreet(street);
    nav = null;
    navBuildings = -1;
    heightCache.clear();
    const dir = latLonToDir(lat, lon);
    setSunDirection(morningSunAt(dir));
    const origin = surfaceAt(lat, lon);
    frame = makeLocalFrame(origin);
    renderOrigin = [Math.round(origin[0]), Math.round(origin[1]), Math.round(origin[2])];
    body = newBody(0, 0, 0);
    body.y = heightAt(0, 0);
    focus = toWorld(frame, 0, 2, 0);
    loading.place = `${def.name}, ${def.country}`;
    loading.progress = 0;
    loading.elapsed = 0;
    loading.tip = LOADING_TIPS[Math.floor(Math.random() * LOADING_TIPS.length)];
    loadState = { started: time, peakPending: 1, peakQueued: 1, navBuilt: false, settledFrames: 0 };
    rng = makeRng((campaign?.seed ?? 1) ^ (campaign?.day ?? 0) ^ Math.round(lat * 1000));
    if (houses) houses.clear();
}

function loadingStep(): void {
    if (!loadState || !stats) return;
    loading.elapsed = time - loadState.started;
    const pending = stats.pending + stats.waitingForData;
    loadState.peakPending = Math.max(loadState.peakPending, pending);
    const terrain = pending === 0 ? 1 : Math.max(0, 1 - pending / loadState.peakPending);
    const c = stats.city;
    const city = c && c.wanted > 0 ? Math.min(1, (c.live + c.failed) / c.wanted) : (loading.elapsed > 6 ? 1 : 0);
    const queued = houses?.lastStats.queued ?? 0;
    loadState.peakQueued = Math.max(loadState.peakQueued, queued);
    const house = houses?.busy() ? Math.max(0, 1 - queued / loadState.peakQueued) : 1;
    const peopleReady = people.prepare();
    const p = 0.4 * terrain + 0.25 * city + 0.2 * house + (peopleReady ? 0.1 : 0) + (loadState.navBuilt ? 0.05 : 0);
    loading.progress = Math.max(loading.progress, Math.min(0.99, p));
    loading.stage = terrain < 1 ? "Surveying the terrain" : city < 1 ? "Mapping the streets" : house < 1 ? "Raising the houses" : !peopleReady ? "Preparing the people" : "Plotting the routes";
    loading.lines = [
        `Terrain: ${stats.live} chunks${pending ? `, ${pending} streaming${stats.waitingForData ? ` (${stats.waitingForData} awaiting elevation)` : ""}` : ", settled"}`,
        c ? `Streets: ${c.live}/${c.wanted} OpenStreetMap tiles, ${c.buildings.toLocaleString("en-US")} buildings${c.failed ? ` (${c.failed} unavailable)` : ""}` : "Streets: waiting for the map",
        `Houses: ${houses?.lastStats.lod0 ?? 0} full, ${houses?.lastStats.lod1 ?? 0} simplified${queued ? `, ${queued} to build (cached after the first time)` : ""}`,
        peopleReady ? "People: Mesha humans and distance LODs cached" : "People: preparing Mesha humans and distance LODs (cached after the first time)",
        loadState.navBuilt ? `Routes: ${nav?.rects.length ?? 0} buildings on the street map` : "Routes: pending",
    ];
    const settled = terrain >= 1 && (city >= 1 || loading.elapsed > 60) && (house >= 1 || loading.elapsed > 80);
    loadState.settledFrames = settled ? loadState.settledFrames + 1 : 0;
    if (peopleReady && ((loadState.settledFrames > 3 && loading.elapsed > 1.2) || loading.elapsed > 150)) finishLoading();
}

function finishLoading(): void {
    heightCache.clear();
    buildNav(0, 0);
    if (loadState) loadState.navBuilt = true;
    // Stand on a street near the city center.
    const spot = nav?.nearestWalkable(0, 0, 60) ?? [0, 0];
    body.x = spot[0];
    body.z = spot[1];
    body.y = heightAt(body.x, body.z);
    street.player.x = body.x;
    street.player.z = body.z;
    loading.progress = 1;
    loadState = null;
    mode = "play";
    syncStreetPlayerFromCampaign();
    const def = region ? regionDefById(region) : null;
    if (def && campaign) toast(`You arrive in ${def.name}. ${partyShare(campaign.regions[def.id]) < 0.02 ? "Nobody knows your name - yet." : "Comrades are waiting."}`, "info");
}

/** Rasterizes the buildings and water around local (cx, cz) into a fresh nav grid. */
function buildNav(cx: number, cz: number): void {
    if (!frame) return;
    const g = new NavGrid(cx, cz, NAV_SIZE, NAV_CELL);
    const center = toWorld(frame, cx, 0, cz);
    const list = Entropy.QuadPlanet.buildings(terrainId, center, NAV_SIZE * NAV_CELL * 0.72, { limit: 6000 }) as CityBuilding[];
    for (const b of list) g.addRect(buildingToRect(frame, b));
    g.markWhere((x, z) => isSea(x, z));
    nav = g;
    navBuildings = stats?.city?.buildings ?? 0;
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
        const dx = body.x, dz = body.z;
        frame = makeLocalFrame(newOrigin);
        shiftStreet(street, dx, dz);
        body.x -= dx; body.z -= dz; body.y = 0;
        heightCache.clear();
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
        calm: mode === "loading" || mode === "console" || mode === "title" || mode === "setup",
    };
}

function handleStreetEvents(): void {
    const c = campaign;
    if (!c || !region) return;
    const rs = c.regions[region];
    for (const e of street.events) {
        switch (e.kind) {
            case "kill":
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
    if (street.player.dead) {
        const msg = playerDied(c, region);
        toast(msg, "bad");
        resetStreet(street);
        const spot = nav?.nearestWalkable(nav.cx, nav.cz, 60) ?? [0, 0];
        body.x = spot[0]; body.z = spot[1]; body.y = heightAt(body.x, body.z);
        street.player.x = body.x; street.player.z = body.z;
        syncStreetPlayerFromCampaign();
        if (mode === "speech" || mode === "dialogue") { speech = null; dialogue = null; mode = "play"; }
    }
}

function newDay(): void {
    if (!campaign) return;
    advanceDay(campaign, region);
    if (campaign.news[0]?.day === campaign.day) toast(campaign.news[0].text, campaign.news[0].kind === "good" ? "good" : campaign.news[0].kind === "info" ? "info" : "bad");
    if (campaign.outcome) { mode = "outcome"; }
    save();
}

// --- Speeches ------------------------------------------------------------------------------------

function beginSpeech(rival: Actor | null = null): string | null {
    const c = campaign;
    if (!c || !region) return "No campaign.";
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
    aimHold = Math.max(0, aimHold - dt);
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
    const wants = triggerHeld && (w.auto || triggerFresh);
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
    if (aimDir) dir = aimDir;
    else {
        const probe = castShot(street, nav, cam.eye, cam.forward, Math.max(60, w.range), null, false);
        dir = normalize(sub(probe.end, eye));
    }
    playerShoot(street, nav, eye, dir, w, skill(c, "marksmanship"), rng);
    if (w.id !== "fists" && region) {
        const rs = c.regions[region];
        if (!rs.war && rs.governor !== PARTY) rs.heat = Math.min(1, rs.heat + 0.003);
    }
}

// --- Input ---------------------------------------------------------------------------------------

const key = (k: string) => Entropy.Input.isKeyPressed(k) || Entropy.Input.isKeyPressed(k.toUpperCase());

function readInput(): PlayerInput {
    if (mode !== "play" && mode !== "speech") return NO_PLAYER_INPUT;
    if (mode === "speech") return { ...NO_PLAYER_INPUT, turnLeft: key("ArrowLeft"), turnRight: key("ArrowRight") };
    return {
        forward: key("w"), back: key("s"), left: key("a"), right: key("d"),
        jump: key(" "), sprint: Entropy.Input.isShiftPressed(),
        turnLeft: key("ArrowLeft"), turnRight: key("ArrowRight"), lookUp: key("ArrowUp"), lookDown: key("ArrowDown"),
    };
}

function typeInto(k: string): void {
    const field = setup.focus;
    if (!field) return;
    let v = field === "party" ? setup.party : setup.leader;
    if (k === "Backspace") v = v.slice(0, -1);
    else if (k === "Enter" || k === "Tab" || k === "Escape") { setup.focus = k === "Tab" && field === "party" ? "leader" : null; return; }
    else if (k.length === 1 && v.length < 28 && /[\w \-'.!&]/.test(k)) v += k;
    else return;
    if (field === "party") setup.party = v; else setup.leader = v;
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
        if (k === "Tab" || k === "Escape" || lower === "m") mode = "play";
        return;
    }
    if (mode === "outcome" || mode === "title" || mode === "setup" || mode === "loading") return;
    // Play.
    if (k === "Tab" || lower === "m" || k === "Escape") { mode = "console"; selectedRegion = region; return; }
    if (lower === "e") interact();
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
    Entropy.Input.onKeyDown((k: string) => onKey(k));
    Entropy.Input.onMouseDown((button: number, x: number, y: number) => {
        if (button === 1) { lookButtonDown = true; lookDrag = [x, y]; return; }
        const id = ui ? ui.click(x, y) : null;
        if (id) return;
        if (mode === "play") { triggerHeld = true; triggerFresh = true; }
        else if (mode === "setup") setup.focus = null;
    });
    Entropy.Input.onMouseMove((x: number, y: number) => {
        if (ui) ui.p.hover = ui.p.hit(x, y)?.id ?? null;
        if (lookButtonDown && lookDrag && (mode === "play" || mode === "speech")) {
            const dx = x - lookDrag[0], dy = y - lookDrag[1];
            lookDrag = [x, y];
            body.yaw += dx * 0.005;
            body.pitch = Math.max(-1.2, Math.min(1.0, body.pitch - dy * 0.004));
        }
    });
    Entropy.Input.onMouseUp((button: number) => {
        if (button === 1) { lookButtonDown = false; lookDrag = null; }
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
        case "setup-focus": setup.focus = arg as "party" | "leader"; break;
        case "setup-ideology": setup.ideology = String(arg); setup.color = Math.max(0, PARTY_COLORS.findIndex(pc => pc.color.join() === IDEOLOGIES.find(i => i.id === arg)!.color.join())); break;
        case "setup-color": setup.color = Number(arg); break;
        case "setup-spawn": setup.spawn = String(arg); break;
        case "setup-random": setup.spawn = REGIONS[Math.floor(Math.random() * REGIONS.length)].id; break;
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
        case "speech-close": finishSpeech(); break;
        default:
            if (name.startsWith("dlg-")) dialogueAction(name);
    }
}

function beginCampaign(): void {
    if (!setup.spawn) return;
    const def = regionDefById(setup.spawn)!;
    campaign = newCampaign({
        partyName: setup.party, leader: setup.leader, ideology: setup.ideology, color: PARTY_COLORS[setup.color].color, spawn: def.id,
        seed: Math.floor(Math.random() * 2 ** 31),
    });
    for (const k of Object.keys(mags)) delete mags[k];
    startLoading(def.lat, def.lon);
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
    const rallyActor = street.rally ? actorById(street, street.rally.orator) : undefined;
    return {
        mode, tab, c, setup, loading, speech, dialogue, toasts, region, selectedRegion, selectedMember, memberPage, prompt,
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
        armor: c ? Math.round(c.player.armor / Math.max(1, armorById(c.player.armorId).armor || 1) * 50) / 50 : 0,
        land, hasSave, time, firstPerson: body.firstPerson,
        debug: null,
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
    const c = campaign;
    const party = c ? c.party.color : THEME.red;
    const anyEnemy = soldiers(street).length > 0;
    const counts: [number, number, number] = [0, 0, 0];
    const cam = lastCamera;
    const forward = cam ? normalize(sub(cam.target, cam.position)) : null;
    // Who is drawn this frame, nearest first, with the LOD their distance asks for.
    const shown: { a: Actor; distance: number; lod: PersonLod }[] = [];
    for (const a of street.actors) {
        if (Math.hypot(a.x - body.x, a.z - body.z) > 160) { personLods.delete(a.id); continue; }
        const center = toWorld(frame, a.x, a.y + 0.9, a.z);
        const actorDistance = cam ? distance(cam.position, center) : Math.hypot(a.x - body.x, a.z - body.z);
        const lod = personLod(actorDistance, personLods.get(a.id), peopleDetail);
        // Off screen: no draw, but the simulation (and the LOD hysteresis) carries on.
        if (cam && forward && !maybeVisible(cam.position, forward, center)) { personLods.set(a.id, lod); counts[lod]++; continue; }
        shown.push({ a, distance: actorDistance, lod });
    }
    // You are drawn in full and count against the budget first.
    const playerVisible = (mode === "play" || mode === "speech" || mode === "dialogue") && !body.firstPerson;
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
        const aiming = aimHold > 0 || lookButtonDown;
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
    const cam = bodyCamera(body, heightAt, mode === "speech" ? 2.7 : 0);
    if (mode === "speech") return { position: toWorld(frame, ...cam.eye), target: toWorld(frame, body.x, body.y + 1.5, body.z), up: frame.up };
    return { position: toWorld(frame, ...cam.eye), target: toWorld(frame, ...cam.target), up: frame.up };
}

function updateSun(): void {
    if (!frame || !campaign || mode === "title" || mode === "setup") return;
    const t = Math.max(0, Math.min(1, campaign.dayClock / DAY_SECONDS));
    const el = (18 + 48 * Math.sin(Math.PI * t)) * Math.PI / 180;
    const horiz = normalize(add(scale(frame.east, Math.cos(Math.PI * t)), scale(frame.north, -0.45 * Math.sin(Math.PI * t))));
    setSunDirection(normalize(add(scale(frame.up, Math.sin(el)), scale(horiz, Math.cos(el)))));
}

function writeWorld(): void {
    Entropy.Buffer.write(worldBuffer, packWorld({
        sunDir: SUN_DIRECTION, time, sunColor: [1.0, 0.96, 0.9], exposure: 1.05, debugLod: false, debugOutlines: false,
        planets: WORLD_PLANETS.map(p => ({ center: toRender(p.center), radius: p.radius, atmosphere: p.atmosphereColor, atmosphereHeight: p.atmosphereHeight })),
        city: { hideRadius, roadDistance: ROAD_DISTANCE },
    }));
}

function stream(maxBuilds: number, maxMs: number): void {
    stats = Entropy.QuadPlanet.update(terrainId, focus, { renderOrigin, maxBuilds, maxMs });
}

function updateHouses(buildMs: number): void {
    if (!houses) return;
    const c = stats?.city;
    if (!c || !frame || mode === "title" || mode === "setup") {
        if (hideRadius > 0) houses.clear();
        hideRadius = 0;
        return;
    }
    const cam = lastCamera?.position ?? focus;
    hideRadius = houses.update(cam, renderOrigin, c.live * 1_000_003 + c.buildings, buildMs);
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
    ui.p.begin();
    drawScreen(view(), ui);
    ui.p.flush();
}

// --- MCP tools (and the live test) ---------------------------------------------------------------

type Args = Record<string, unknown>;
const r2 = (v: number) => Math.round(v * 100) / 100;

function snapshot() {
    const c = campaign;
    const rs = here();
    return {
        mode, tab, frames: frameCount, time: r2(time),
        loading: { progress: r2(loading.progress), stage: loading.stage, lines: loading.lines, elapsed: r2(loading.elapsed) },
        region: region ? { id: region, name: regionDefById(region)?.name, governor: rs?.governor, partyShare: rs ? Math.round(partyShare(rs) * 10000) / 10000 : 0, members: rs?.members, army: rs?.army, garrison: rs?.garrison, war: !!rs?.war, heat: rs ? r2(rs.heat) : 0 } : null,
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
        people: { generated: people?.generated ?? 0, cache: Entropy.MeshCache.stats(PEOPLE_NAMESPACE),
            lod0: lodCounts[0], lod1: lodCounts[1], lod2: lodCounts[2], detail: peopleDetail, budget: peopleBudget,
            batches: crowd?.lastStats ?? null },
        ui: { ops: ui?.p.opCount() ?? 0, submits: ui?.p.submits ?? 0, buttons: ui?.p.buttons.map(b => b.id).slice(0, 80) ?? [] },
        toasts: toasts.map(t => t.text),
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
        description: "Starts a new campaign and loads its spawn point. spawn is a region id (e.g. 'levittown' is not one - use 'new-york', 'london', 'lagos').",
        parameters: { type: "object", properties: { party: { type: "string" }, leader: { type: "string" }, ideology: { type: "string" }, color: { type: "integer" }, spawn: { type: "string" }, seed: { type: "integer" }, lat: { type: "number" }, lon: { type: "number" } }, required: ["spawn"] },
        run: a => {
            const def = regionDefById(String(a.spawn));
            if (!def) throw new Error(`Unknown region ${a.spawn}`);
            campaign = newCampaign({
                partyName: typeof a.party === "string" ? a.party : "People's Front", leader: typeof a.leader === "string" ? a.leader : undefined,
                ideology: typeof a.ideology === "string" ? a.ideology : "solidarity", color: PARTY_COLORS[typeof a.color === "number" ? a.color : 0].color,
                spawn: def.id, seed: typeof a.seed === "number" ? a.seed : 2100, lat: typeof a.lat === "number" ? a.lat : undefined, lon: typeof a.lon === "number" ? a.lon : undefined,
            });
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
        description: "fixedStep: seconds per frame (reproducible runs), or null for real time. peopleDetail: scales people's level-of-detail distances (1 default; 0.3-0.5 for slower machines). peopleMaxFull / peopleTriangles: at most this many full-detail people and this many person triangles per frame (defaults 6 and 3,000,000).",
        parameters: { type: "object", properties: { fixedStep: { type: ["number", "null"] }, peopleDetail: { type: "number" }, peopleMaxFull: { type: "integer" }, peopleTriangles: { type: "number" } } },
        run: a => {
            if ("fixedStep" in a) fixedStep = typeof a.fixedStep === "number" && a.fixedStep > 0 ? Math.min(0.1, a.fixedStep) : null;
            if (typeof a.peopleDetail === "number" && a.peopleDetail > 0) peopleDetail = Math.min(4, a.peopleDetail);
            if (typeof a.peopleMaxFull === "number" && a.peopleMaxFull >= 0) peopleBudget = { ...peopleBudget, maxFull: Math.floor(a.peopleMaxFull) };
            if (typeof a.peopleTriangles === "number" && a.peopleTriangles >= 0) peopleBudget = { ...peopleBudget, triangleBudget: a.peopleTriangles };
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
        description: "Street and campaign actions: talk (nearest), pamphlet, persuade, recruit, follow, leave; walk {dx,dz}; face {yaw,pitch}; shoot; squad (spawn soldiers); rest; days {days}; funds {amount}; organize; arm {count}; war; coup; election; travel {region}; equip {weapon}; buy {weapon}; save; load; view {distance, firstPerson}.",
        parameters: { type: "object", properties: {
            action: { type: "string" }, dx: { type: "number" }, dz: { type: "number" }, yaw: { type: "number" }, pitch: { type: "number" }, days: { type: "integer" },
            amount: { type: "number" }, count: { type: "integer" }, region: { type: "string" }, weapon: { type: "string" }, distance: { type: "number" }, firstPerson: { type: "boolean" },
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
                    for (const d of [...REGIONS].sort((x, y) => y.pop - x.pop)) {
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
                case "face": if (typeof a.yaw === "number") body.yaw = a.yaw; if (typeof a.pitch === "number") body.pitch = a.pitch; break;
                case "shoot": fire(c?.player.weapon ?? "pistol"); break;
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
                case "equip": if (c && typeof a.weapon === "string") c.player.weapon = a.weapon; break;
                case "buy": act("buy-weapon", a.weapon); break;
                case "save": out.saved = save(); break;
                case "load": act("continue"); break;
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

addon.onInit(() => {
    pipelineId = Entropy.Pipeline.create({
        name: "Allegiance",
        layout: "mesh",
        pbr: false,
        vertexShader: ALLEGIANCE_SHADER,
        fragmentShader: ALLEGIANCE_SHADER,
        extraBindGroups: [{ entries: [
            { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
            { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
        ] }],
    });
    worldBuffer = uniform(WORLD_FLOATS);
    // Houses: instanced batches of Items, one draw per house mesh (qp_city.ts, qp_instances.ts).
    housePipelineId = Entropy.Pipeline.create({
        name: "Allegiance Houses", layout: "mesh", pbr: false,
        vertexShader: ALLEGIANCE_INSTANCED_SHADER, fragmentShader: ALLEGIANCE_INSTANCED_SHADER,
        extraBindGroups: INSTANCED_BIND_GROUPS,
    });
    peoplePipelineId = Entropy.Pipeline.create({
        name: "Allegiance People", layout: "mesh", pbr: false,
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
        id: "allegiance-earth", planets: WORLD_PLANETS, pipelineId, worldBufferId: worldBuffer,
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
        instances: meshCacheInstances(HOUSE_NAMESPACE, () => housePipelineId, () => worldBuffer),
        // Mesha evaluations run in a worker isolate (Entropy.Worker); without the bundle they fail
        // and CityHouses evaluates here instead.
        generateInBackground: job => { try { return Entropy.Worker.start(HOUSE_WORKER_SCRIPT, job); } catch { return null; } },
        pollBackground: id => Entropy.Worker.poll(id).status,
        now: () => Date.now(),
    // 1 m size steps: similar footprints share one house mesh (and one instanced draw).
    }, { lod0Radius: 40, maxLod0: 4, lod1Radius: 260, minBuildIntervalMs: 250, sizeStep: 1 });
    spawnMesh("al-sky", buildSky(), skyItem);
    setupProps();
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
    const now = Date.now();
    const real = lastMs ? Math.min(0.1, Math.max(0, (now - lastMs) / 1000)) : 1 / 60;
    lastMs = now;
    const dt = fixedStep ?? real;
    time += dt;
    frameCount++;
    for (const t of toasts) t.age += dt;
    toasts = toasts.filter(t => t.age < 5);

    const live = mode === "play" || mode === "speech" || mode === "dialogue";
    if (live && frame) {
        stepBody(body, readInput(), dt, nav, heightAt, mode === "speech" ? 0 : 1);
        street.player.x = body.x; street.player.z = body.z; street.player.y = body.y; street.player.heading = body.yaw;
        street.player.moving = body.speed > 0.5;
        stepWeapon(dt);
        // Out of a fight, wounds slowly heal (faster with Toughness).
        if (campaign && !soldiers(street).length && street.player.health < maxHealth(campaign)) {
            street.player.health = Math.min(maxHealth(campaign), street.player.health + (0.6 + skill(campaign, "toughness") * 0.3) * dt);
        }
        timed("    al street sim", () => stepStreet(street, nav, streetContext(), dt, rng, heightAt));
        handleStreetEvents();
        if (speech) { stepSpeech(speech, dt); setCrowdTarget(street, speech.crowd); }
        if (dialogue) {
            const a = actorById(street, dialogue.actorId);
            if (!a || !alive(a) || Math.hypot(a.x - body.x, a.z - body.z) > 6) closeDialogue();
        }
        timed("    al nav", () => maintainNav(dt));
        if (campaign) {
            campaign.dayClock += dt;
            if (campaign.dayClock >= DAY_SECONDS) { campaign.dayClock -= DAY_SECONDS; newDay(); }
            const pos = toWorld(frame, body.x, body.y, body.z);
            const ll = dirToLatLon(pos);
            campaign.player.lat = ll.lat;
            campaign.player.lon = ll.lon;
            const now2 = regionAt(ll.lat, ll.lon).id;
            if (now2 !== region) { region = now2; toast(`Entering ${regionDefById(now2)!.name}.`, "info"); }
        }
    }
    if (frameCount % 30 === 0) updateSun();
    heightCacheAge += dt;
    if (heightCacheAge > (stats && stats.waitingForData > 0 ? 2 : 15)) { heightCacheAge = 0; heightCache.clear(); }

    const pose = cameraForMode(dt);
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
    const loadingNow = mode === "loading";
    const orbit = mode === "title" || mode === "setup";
    // A fixed-step run streams everything it wants every frame, so it looks the same on any machine.
    timed("    al terrain stream", () => {
        if (fixedStep) stream(Infinity, Infinity);
        else stream(loadingNow || orbit ? 40 : 10, loadingNow || orbit ? 30 : 12);
    });
    timed("    al houses", () => updateHouses(fixedStep ? Infinity : loadingNow ? 30 : 10));
    writeWorld();
    if (loadingNow) loadingStep();
    timed("    al ui", () => drawUi(dt));
    void length;
});
