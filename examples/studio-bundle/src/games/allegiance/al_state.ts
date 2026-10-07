// The campaign: everything a save file holds. Plain JSON-able data, so saving is JSON.stringify
// and every rule (al_world.ts, al_party.ts) is a function over it that the tests can drive.

import {
    BLOCS, FACTIONS, FIRST_NAMES, IDEOLOGIES, LAST_NAMES, PARTY, PARTY_COLORS, REGIONS, RIVALS, TOPIC_IDS, UNDECIDED,
    countryOf, registerSettlement, blocById, type GovType, type RGBA, type SkillId, type RegionDef, regionDefById,
} from "./al_data";
import { type Rng, makeRng, range, hashString, clamp01 } from "./al_rng";

export const SAVE_VERSION = 1;
/** The campaign calendar starts on this date; `day` counts from it. */
export const START_DATE = Date.UTC(2100, 2, 1);

export type Role = "none" | "treasurer" | "propaganda" | "spymaster" | "general" | "commissioner" | "chief" | "cell";
export const INNER_CIRCLE: Role[] = ["treasurer", "propaganda", "spymaster", "general"];

/** A named party member: someone you recruited yourself, or a talent the party turned up. */
export interface Member {
    id: number;
    name: string;
    /** Region they live in. */
    region: string;
    charisma: number; // 1..10
    admin: number;    // 1..10
    combat: number;   // 1..10
    loyalty: number;  // 0..100
    role: Role;
    /** The region a chief or cell leader runs, or the bloc a commissioner oversees. */
    post: string | null;
    /** Walks with you on the street (and fights beside you if armed). */
    follower: boolean;
    armed: boolean;
    inPerson: boolean;
    joinedDay: number;
}

export interface War {
    /** Who started it: the party, or a rival faction trying to take a party-held region back. */
    attacker: string;
    defender: string;
    partyStrength: number;
    enemyStrength: number;
    partyStart: number;
    enemyStart: number;
    days: number;
    /** "offensive": the attacker strikes today; "counter": the defender strikes back. */
    phase: "offensive" | "counter";
    /** Losses inflicted on the enemy by you in person (street battles), not yet applied. */
    fieldKills: number;
    fieldLosses: number;
    log: string[];
}

export interface RegionState {
    id: string;
    /** Shares of the population behind each faction (and undecided); sums to 1. */
    support: Record<string, number>;
    governor: string;
    gov: GovType;
    /** 0..1: anger with the government (strikes, riots; helps coups, hurts governors). */
    unrest: number;
    /** 0..1: how much the regime watches the party here (crackdowns). */
    heat: number;
    /** Rank-and-file party members. */
    members: number;
    /** Armed party members stationed here. */
    army: number;
    /** The regime's (or, in a party region, the insurgents') troops. */
    garrison: number;
    taxRate: number;
    /** Days to the next scheduled election (democracies). */
    electionIn: number;
    war: War | null;
    /** Days of ceasefire left after a peace deal. */
    ceasefire: number;
    /** Recent momentum from speeches given here in person (decays daily). */
    momentum: number;
    /**
     * An invasion on the march toward a party region: who, how many, and the day it arrives (at
     * that dawn it meets whatever troops stand there). Gives a day's warning to send help.
     */
    threat?: Threat | null;
}

export interface Threat { attacker: string; force: number; day: number }

/** A military compound: the target for taking a settlement (or, for the founding outpost, your
 * headquarters). Civilians are never the target; the garrison is. */
export interface CompoundState {
    id: string;
    /** The settlement or territory it holds. */
    settlement: string;
    kind: "outpost" | "garrison";
    lat: number;
    lon: number;
    yaw: number;
    /** Buildings in the compound (proportional to the settlement's population). */
    buildings: number;
    /** Defenders left, and the full complement. */
    garrison: number;
    maxGarrison: number;
    captured: boolean;
    /** Moved onto clear ground the first time the street map covered it. */
    sited: boolean;
    /** Its Cobra (al_cobra.ts) has been flown away from the courtyard. */
    cobraTaken?: boolean;
}

export type MissionStep = "assemble" | "approach" | "assault" | "raise" | "done";
export interface MissionState { id: "founding"; step: MissionStep; compound: string; startedDay: number; raise: number }

export interface ActiveScheme { id: number; scheme: string; region: string; daysLeft: number; chance: number }

export interface NewsItem { day: number; text: string; kind: "good" | "bad" | "info" | "war" }

export interface Ledger { dues: number; taxes: number; donations: number; schemes: number; salaries: number; army: number; facilities: number; admin: number; net: number }

export interface Campaign {
    version: number;
    seed: number;
    rngState: number;
    day: number;
    /** Seconds into the current day (real-time play advances it). */
    dayClock: number;
    party: {
        name: string;
        ideology: string;
        color: RGBA;
        leader: string;
        /** -100 (tyrant) .. +100 (liberator). */
        karma: number;
        funds: number;
        /** Credits per organized member per day. */
        duesRate: number;
        xp: number;
        level: number;
        skillPoints: number;
        skills: Record<SkillId, number>;
        facilities: string[];
        /** Lead from inside (HQ bonuses), from the field (battle bonuses), or both by halves. */
        posture: "inside" | "field" | "mixed";
        hq: string;
        /** Days in a row with funds below zero. */
        brokeDays: number;
        /** The largest membership the party has ever had (for the defeat check). */
        peakMembers: number;
        /** The captured compound that serves as party headquarters (on the sky markers and maps). */
        hqSite?: { lat: number; lon: number; name: string } | null;
    };
    player: {
        health: number;
        armorId: string;
        armor: number;
        weapons: string[];
        weapon: string;
        ammo: Record<string, number>;
        pamphlets: Record<string, number>;
        lat: number;
        lon: number;
        flyingCar?: { lat: number; lon: number; yaw: number; altitude?: number; piloting?: boolean };
        /** The Cobra you commandeered (al_cobra.ts): where it stands, its hull and the compound it came from. */
        cobra?: { home: string; lat: number; lon: number; yaw: number; altitude: number; piloting: boolean; hull: number } | null;
        /** Consumables and salvage (al_items.ts). */
        inventory?: Record<string, number>;
        /** Garage upgrade tiers bought for the flying car (al_vehicle.ts CAR_UPGRADES). */
        carUpgrades?: Partial<Record<"turbine" | "capacitor" | "lift" | "gyro" | "ceiling", number>>;
        /** Aim assist strength (0..1) and look sensitivity (al_aim.ts); defaults 0.5 and 1. */
        controls?: { aimAssist: number; lookSensitivity: number };
    };
    members: Member[];
    nextMemberId: number;
    regions: Record<string, RegionState>;
    /** Discovered settlements persist with their independent support, governments and armies. */
    settlements?: RegionDef[];
    schemes: ActiveScheme[];
    nextSchemeId: number;
    news: NewsItem[];
    ledger: Ledger;
    stats: { speeches: number; bestSpeech: number; pamphlets: number; recruits: number; kills: number; deaths: number; elections: number; coups: number; wars: number; regionsTaken: number };
    /** Days the Concordat has branded the party enemies of the state (0 = not yet). */
    outlawedDay: number;
    outcome: null | { kind: "victory" | "defeat"; title: string; text: string; day: number };
    /** Houses already searched for supplies. */
    looted?: string[];
    /** Military compounds by id (created as settlements come near). */
    compounds?: Record<string, CompoundState>;
    /** Buildings blown down (al_destruction.ts), by building key, with the day they fell. */
    ruins?: Record<string, number>;
    /** The guided opening (al_mission.ts); null once done or for old saves. */
    mission?: MissionState | null;
    /** The last safe place you stood (autosaved): where you come back after falling in battle. */
    checkpoint?: { lat: number; lon: number; day: number } | null;
}

/** Fills fields newer than a save (older campaigns load with empty inventories, no mission). */
export function migrateCampaign(c: Campaign): Campaign {
    c.player.inventory ??= {};
    c.player.carUpgrades ??= {};
    c.looted ??= [];
    c.compounds ??= {};
    c.ruins ??= {};
    c.player.cobra ??= null;
    c.mission ??= null;
    c.checkpoint ??= null;
    c.party.hqSite ??= null;
    return c;
}

/** Founding comrades who walk with you from the first minute. */
export const FOUNDING_COMRADES = 5;

export interface NewCampaignOptions {
    seed?: number;
    partyName?: string;
    leader?: string;
    ideology?: string;
    color?: RGBA;
    /** Region id to start in. */
    spawn?: string;
    /** Exact start point (defaults to the spawn region's city). */
    hometown?: { name: string; lat: number; lon: number; kind?: string };
    lat?: number;
    lon?: number;
}

export const ZERO_LEDGER: Ledger = { dues: 0, taxes: 0, donations: 0, schemes: 0, salaries: 0, army: 0, facilities: 0, admin: 0, net: 0 };

/** Normalizes a support record to sum to 1. */
export function normalizeSupport(s: Record<string, number>): void {
    let total = 0;
    for (const k of Object.keys(s)) { s[k] = Math.max(0, s[k]); total += s[k]; }
    if (total <= 0) { s[UNDECIDED] = 1; return; }
    for (const k of Object.keys(s)) s[k] /= total;
}

/** How well a faction's message fits a region (0..1). */
export function topicFit(def: RegionDef, faction: string): number {
    const f = FACTIONS.find(x => x.id === faction);
    if (!f || !f.topics.length) return 0.5;
    const b = blocById(def.bloc);
    return f.topics.reduce((s, t) => s + b.topics[t], 0) / f.topics.length;
}

const GARRISON_FACTOR: Record<GovType, number> = { democracy: 0.8, technocracy: 1.0, junta: 1.6, oligarchy: 1.2 };

/** The regime's standing troops in a region. */
export function baseGarrison(def: RegionDef, gov: GovType): number {
    return Math.round(def.pop * blocById(def.bloc).militaryPerMillion * GARRISON_FACTOR[gov]);
}

function initialRegion(def: RegionDef, rng: Rng): RegionState {
    const gov: GovType = def.gov ?? blocById(def.bloc).gov;
    const support: Record<string, number> = { [PARTY]: 0, [UNDECIDED]: 0 };
    for (const r of RIVALS) support[r] = 0.05 + topicFit(def, r) * range(rng, 0.05, 0.22);
    const governor = countryOf(def).ruler;
    support[governor] += range(rng, 0.18, 0.3);
    support[UNDECIDED] = range(rng, 0.25, 0.4);
    normalizeSupport(support);
    return {
        id: def.id, support, governor, gov,
        unrest: range(rng, 0.05, 0.3) + (def.wealth < 0.5 ? 0.1 : 0),
        heat: 0, members: 0, army: 0,
        garrison: baseGarrison(def, gov),
        taxRate: 0.15,
        electionIn: Math.floor(range(rng, 12, 60)),
        war: null, ceasefire: 0, momentum: 0,
    };
}

/** Great-circle angle (radians) between two lat/lon points in degrees. */
export function angularDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const r = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const EARTH_RADIUS_KM = 6371;

/** The region a point on Earth belongs to: the one whose city is nearest. */
export function regionAt(lat: number, lon: number, c?: Campaign | null): RegionDef {
    let local: RegionDef | undefined, localDistance = Infinity;
    for (const d of c?.settlements ?? []) {
        const km = angularDistance(lat, lon, d.lat, d.lon) * EARTH_RADIUS_KM;
        if (km <= (d.radiusKm ?? 2) && km < localDistance) { local = d; localDistance = km; }
    }
    if (local) return local;
    let best = REGIONS[0], bestD = Infinity;
    for (const r of REGIONS) {
        const d = angularDistance(lat, lon, r.lat, r.lon);
        if (d < bestD) { bestD = d; best = r; }
    }
    return best;
}

/** The `n` regions nearest to region `id` (its neighbors: support spreads between them). */
export function neighbors(id: string, n = 4, c?: Campaign): string[] {
    const me = regionDefById(id);
    if (!me) return [];
    return (c ? campaignRegions(c) : REGIONS).filter(r => r.id !== id)
        .map(r => ({ id: r.id, d: angularDistance(me.lat, me.lon, r.lat, r.lon) }))
        .sort((a, b) => a.d - b.d).slice(0, n).map(x => x.id);
}

export function newCampaign(opts: NewCampaignOptions = {}): Campaign {
    const seed = opts.seed ?? (hashString(`${opts.partyName ?? "party"}:${opts.spawn ?? ""}`) ^ 0x5eed);
    const rng = makeRng(seed);
    const ideology = IDEOLOGIES.find(i => i.id === opts.ideology) ?? IDEOLOGIES[0];
    const regions: Record<string, RegionState> = {};
    for (const def of REGIONS) regions[def.id] = initialRegion(def, rng);
    const requested = regionDefById(opts.spawn ?? "");
    const spawn = opts.hometown ? regionAt(opts.hometown.lat, opts.hometown.lon) : (requested?.parent ? regionDefById(requested.parent)! : requested ?? REGIONS[0]);
    const home = regions[spawn.id];
    // You arrive with a handful of believers and a little awareness at home.
    home.members = FOUNDING_COMRADES;
    home.support[PARTY] = 0.01;
    normalizeSupport(home.support);
    const c: Campaign = {
        version: SAVE_VERSION,
        seed,
        rngState: rng.state(),
        day: 0,
        dayClock: 0,
        party: {
            name: (opts.partyName ?? "").trim() || "People's Front",
            ideology: ideology.id,
            color: opts.color ?? ideology.color ?? PARTY_COLORS[0].color,
            leader: (opts.leader ?? "").trim() || "The Speaker",
            karma: 0,
            funds: 5000,
            duesRate: 0.1,
            xp: 0,
            level: 1,
            skillPoints: 1,
            skills: { oratory: 0, persuasion: 0, leadership: 0, marksmanship: 0, toughness: 0, intrigue: 0 },
            facilities: [],
            posture: "mixed",
            hq: spawn.id,
            brokeDays: 0,
            peakMembers: FOUNDING_COMRADES,
            hqSite: null,
        },
        player: {
            health: 100,
            armorId: "none",
            armor: 0,
            weapons: ["fists", "pistol"],
            weapon: "pistol",
            ammo: { pistol: 48 },
            pamphlets: { truth: 20, propaganda: 20, smear: 0 },
            lat: opts.lat ?? spawn.lat,
            lon: opts.lon ?? spawn.lon,
            inventory: { medkit: 2, ration: 3 },
            carUpgrades: {},
        },
        members: [],
        nextMemberId: 1,
        regions, settlements: [],
        schemes: [],
        nextSchemeId: 1,
        news: [],
        ledger: { ...ZERO_LEDGER },
        stats: { speeches: 0, bestSpeech: 0, pamphlets: 0, recruits: 0, kills: 0, deaths: 0, elections: 0, coups: 0, wars: 0, regionsTaken: 0 },
        outlawedDay: 0,
        outcome: null,
        looted: [],
        compounds: {},
        mission: null,
        checkpoint: null,
    };
    const homePlace = opts.hometown ?? (requested?.parent ? requested : undefined) ?? (!opts.spawn && opts.lat !== undefined && opts.lon !== undefined
        ? { name: `${opts.lat.toFixed(4)}, ${opts.lon.toFixed(4)}`, lat: opts.lat, lon: opts.lon, kind: "village" } : null);
    if (homePlace) {
        const d = discoverSettlement(c, homePlace);
        home.members = 0; home.support[PARTY] = 0; normalizeSupport(home.support);
        c.regions[d.id].members = FOUNDING_COMRADES; shiftSupport(c.regions[d.id], PARTY, 0.01);
        c.party.hq = d.id; c.player.lat = d.lat; c.player.lon = d.lon;
    }
    // Five founding comrades: they walk (and fight) beside you from the start, and fill your first posts later.
    for (let k = 0; k < FOUNDING_COMRADES; k++) {
        const m = addTalent(c, c.party.hq, rng, false);
        m.follower = true; m.armed = true; m.inPerson = true; m.loyalty = Math.max(m.loyalty, 75);
    }
    c.checkpoint = { lat: c.player.lat, lon: c.player.lon, day: 0 };
    c.rngState = rng.state();
    pushNews(c, `${c.party.name} is founded in ${regionDefById(c.party.hq)!.name}. ${ideology.slogan}`, "good");
    return c;
}

// --- Small shared helpers ------------------------------------------------------------------------

/** Runs `fn` with the campaign's RNG and stores its state afterwards. */
export function withRng<T>(c: Campaign, fn: (r: Rng) => T): T {
    // makeRng(state) continues the sequence exactly where it left off.
    const r = makeRng(c.rngState);
    const out = fn(r);
    c.rngState = r.state();
    return out;
}

export function pushNews(c: Campaign, text: string, kind: NewsItem["kind"] = "info"): void {
    c.news.unshift({ day: c.day, text, kind });
    if (c.news.length > 60) c.news.length = 60;
}

export function memberName(r: Rng): string {
    return `${FIRST_NAMES[Math.floor(r.next() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(r.next() * LAST_NAMES.length)]}`;
}

/** Adds a named member the party turned up (not met in person). */
export function addTalent(c: Campaign, region: string, r: Rng, announce = true): Member {
    const stat = () => 1 + Math.floor(r.next() * 6 + r.next() * 4);
    const m: Member = {
        id: c.nextMemberId++, name: memberName(r), region,
        charisma: stat(), admin: stat(), combat: stat(),
        loyalty: 55 + Math.floor(r.next() * 30),
        role: "none", post: null, follower: false, armed: false, inPerson: false, joinedDay: c.day,
    };
    c.members.push(m);
    if (announce) pushNews(c, `New talent: ${m.name} (${regionDefById(region)?.name ?? region}) joins the party.`, "info");
    return m;
}

/** The date of campaign day `day`, as "14 MAR 2100". */
export function dateLabel(day: number): string {
    const d = new Date(START_DATE + day * 86400000);
    const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export const totalMembers = (c: Campaign): number => Object.values(c.regions).reduce((s, r) => s + r.members, 0);

export function karmaTitle(k: number): string {
    if (k >= 60) return "LIBERATOR";
    if (k >= 25) return "CHAMPION";
    if (k > -25) return "PRAGMATIST";
    if (k > -60) return "STRONGMAN";
    return "TYRANT";
}

export function addKarma(c: Campaign, amount: number): void {
    c.party.karma = Math.max(-100, Math.min(100, c.party.karma + amount));
}

/** Moves `amount` of a region's population to `to`: from the undecided first, then from everyone else. */
export function shiftSupport(rs: RegionState, to: string, amount: number, from?: string): number {
    if (amount <= 0) return 0;
    const s = rs.support;
    if (s[to] === undefined) s[to] = 0;
    let need = Math.min(amount, 1 - s[to]);
    const moved = need;
    const take = (k: string, max: number) => {
        const t = Math.min(max, s[k] ?? 0);
        s[k] = (s[k] ?? 0) - t;
        need -= t;
    };
    if (from) take(from, need);
    else {
        take(UNDECIDED, need * 0.6);
        const others = Object.keys(s).filter(k => k !== to && (s[k] ?? 0) > 0);
        const pool = others.reduce((a, k) => a + s[k], 0);
        if (pool > 0) {
            const want = need;
            for (const k of others) take(k, want * (s[k] / pool));
        }
    }
    const done = moved - Math.max(0, need);
    s[to] += done;
    normalizeSupport(s);
    return done;
}

export const partyShare = (rs: RegionState): number => rs.support[PARTY] ?? 0;

/** The strongest faction in a region other than `except`. */
export function strongestRival(rs: RegionState, except = PARTY): string {
    let best = "concordat", bestV = -1;
    for (const k of RIVALS) {
        if (k === except) continue;
        if ((rs.support[k] ?? 0) > bestV) { bestV = rs.support[k]; best = k; }
    }
    return best;
}

export { BLOCS, TOPIC_IDS, clamp01 };

/** Regional population is a fixed budget, partitioned as settlements are discovered. */
export function campaignRegions(c: Campaign): RegionDef[] {
    const locals = c.settlements ?? [];
    const used = new Map<string, number>();
    for (const d of locals) used.set(d.parent!, (used.get(d.parent!) ?? 0) + d.pop);
    return [...REGIONS.map(d => ({ ...d, pop: Math.max(0.000001, d.pop - (used.get(d.id) ?? 0)) })), ...locals];
}

export function restoreSettlements(c: Campaign): Campaign {
    c.settlements ??= [];
    for (const d of c.settlements) registerSettlement(d);
    return c;
}

const discoveryIndex = new WeakMap<Campaign, Map<string, RegionDef>>();

export function discoverSettlement(c: Campaign, place: { name: string; kind?: string; lat: number; lon: number }): RegionDef {
    if (!place.name.trim() || !Number.isFinite(place.lat) || !Number.isFinite(place.lon) || Math.abs(place.lat) > 90 || Math.abs(place.lon) > 180)
        throw new Error("Give a place name and valid latitude/longitude.");
    // Tile and geocoder coordinates can differ slightly. Reuse a same-name nearby place.
    const name = place.name.split(",")[0].trim();
    const key = `${name.toLowerCase()}:${place.lat.toFixed(3)}:${place.lon.toFixed(3)}`;
    let index = discoveryIndex.get(c);
    if (!index) { index = new Map(); discoveryIndex.set(c, index); }
    const cached = index.get(key);
    if (cached) return cached;
    const existing = (c.settlements ?? []).find(d => d.name.toLocaleLowerCase() === name.toLocaleLowerCase()
        && angularDistance(d.lat, d.lon, place.lat, place.lon) * EARTH_RADIUS_KM < 5);
    if (existing) { index.set(key, existing); return existing; }
    const parent = regionAt(place.lat, place.lon);
    const kind = (place.kind ?? "village").split("/").pop()!;
    const people: Record<string, number> = { city: 100000, town: 15000, village: 2000, hamlet: 250, isolated_dwelling: 25 };
    const reserved = (c.settlements ?? []).filter(d => d.parent === parent.id).reduce((n, d) => n + d.pop, 0);
    const pop = Math.min((people[kind] ?? 2000) / 1e6, Math.max(0.000001, parent.pop - reserved) * 0.01);
    const id = `place-${hashString(`${name.toLowerCase()}:${place.lat.toFixed(3)}:${place.lon.toFixed(3)}`).toString(16)}`;
    const def: RegionDef = { ...parent, id, name, lat: place.lat, lon: place.lon, pop, parent: parent.id, kind,
        radiusKm: kind === "city" ? 8 : kind === "town" ? 4 : kind === "village" ? 2 : 0.75 };
    (c.settlements ??= []).push(def); registerSettlement(def);
    const state = initialRegion(def, makeRng(hashString(`${c.seed}:${id}`)));
    // Taking the hinterland never silently conquers undiscovered towns. Each begins under its 2100 country.
    c.regions[id] = state; index.set(key, def);
    return def;
}
