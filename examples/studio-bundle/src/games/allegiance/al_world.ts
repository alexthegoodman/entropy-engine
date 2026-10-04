// The world turns: one call to `advanceDay` runs a campaign day across all of Earth's regions.
//
// Each day, in every region:
// - the party's members do grassroots work (support grows with their density, organization, the
//   Propaganda Minister and the pirate broadcast) and recruit more members from supporters;
// - support spreads between neighboring regions, and fades where nobody keeps it up;
// - the rival factions campaign, harder where you are strong (they react to you);
// - unrest and the regime's suspicion (heat) move, and suspicious regimes crack down;
// - scheduled elections are held in democracies;
// - wars fight a round: the side whose turn it is strikes hard, then the other strikes back,
//   losses proportional to the other side's strength, until one side breaks or peace is made.
//
// Governments change hands three ways, all here: an election (democracies; the party needs the
// most votes), a coup (armed members against the garrison: a gamble, no majority needed, so
// minority rule is possible at the price of unrest) or a war. Once the party governs a region it
// collects taxes, but the Concordat and the rivals send their militaries to take it back, and
// unrest can turn into an insurgency. Govern three quarters of humanity and the planet is yours.

import {
    BLOCS, PARTY, REGIONS, RIVALS, SCHEMES, UNDECIDED, WORLD_POPULATION, blocById, factionById, regionDefById, type GovType,
} from "./al_data";
import {
    type Campaign, type RegionState, type War, addKarma, baseGarrison, neighbors, partyShare, pushNews, shiftSupport,
    strongestRival, topicFit, totalMembers, withRng, karmaTitle, angularDistance, EARTH_RADIUS_KM, normalizeSupport,
} from "./al_state";
import {
    applyLedger, dailyLedger, dailyMembers, gainXp, hasFacility, holder, orgReport, partyQuality, skill,
} from "./al_party";
import type { Rng } from "./al_rng";

/** Real seconds per campaign day while you play (the day also advances when you rest or travel). */
export const DAY_SECONDS = 120;
/** Each enemy soldier you kill in a street battle stands for this many troops of the war. */
export const TROOPS_PER_SOLDIER = 25;
/** Share of the world's population the party must govern to win. */
export const VICTORY_SHARE = 0.75;

const neighborCache = new Map<string, string[]>();
const near = (id: string): string[] => {
    let n = neighborCache.get(id);
    if (!n) { n = neighbors(id, 4); neighborCache.set(id, n); }
    return n;
};

// --- Shares --------------------------------------------------------------------------------------

/** The party's support across the world, weighted by population. */
export function worldSupport(c: Campaign): number {
    return REGIONS.reduce((s, d) => s + partyShare(c.regions[d.id]) * d.pop, 0) / WORLD_POPULATION;
}

/** Share of the world's population living under each faction. */
export function governedShares(c: Campaign): Record<string, number> {
    const out: Record<string, number> = {};
    for (const d of REGIONS) {
        const g = c.regions[d.id].governor;
        out[g] = (out[g] ?? 0) + d.pop / WORLD_POPULATION;
    }
    return out;
}

export const governedShare = (c: Campaign): number => governedShares(c)[PARTY] ?? 0;
export const partyRegions = (c: Campaign): RegionState[] => Object.values(c.regions).filter(r => r.governor === PARTY);

/** "Presence" (members), "Stronghold" (25%+ support), "Governed". */
export function controlLevel(rs: RegionState): "none" | "presence" | "stronghold" | "governed" {
    if (rs.governor === PARTY) return "governed";
    if (partyShare(rs) >= 0.25) return "stronghold";
    if (rs.members > 0 || partyShare(rs) > 0.005) return "presence";
    return "none";
}

const enemyQuality = (rs: RegionState): number => {
    const def = regionDefById(rs.id)!;
    const q = blocById(def.bloc).quality;
    return rs.governor === PARTY ? q * 0.7 : q * (rs.gov === "junta" ? 1.1 : 1);
};

// --- Taking and losing regions -------------------------------------------------------------------

export function takeRegion(c: Campaign, rs: RegionState, how: "election" | "coup" | "war"): void {
    const def = regionDefById(rs.id)!;
    const previous = rs.governor;
    rs.governor = PARTY;
    rs.war = null;
    rs.ceasefire = 15;
    if (how === "election") {
        rs.gov = "democracy";
        rs.garrison = Math.round(baseGarrison(def, rs.gov) * 0.05);
        shiftSupport(rs, PARTY, 0.05);
        addKarma(c, 4);
    } else {
        rs.gov = "junta";
        rs.unrest = Math.min(1, rs.unrest + (how === "coup" ? 0.25 : 0.35));
        // The old regime's loyalists go underground as insurgents.
        rs.garrison = Math.round(Math.max(rs.garrison * 0.3, baseGarrison(def, "democracy") * (how === "coup" ? 0.25 : 0.1)));
        addKarma(c, how === "coup" ? -8 : -4);
    }
    rs.heat = 0;
    rs.taxRate = 0.15;
    c.stats.regionsTaken++;
    if (how === "election") c.stats.elections++;
    if (how === "coup") c.stats.coups++;
    gainXp(c, 150);
    const verb = how === "election" ? "wins the election in" : how === "coup" ? "seizes power in" : "conquers";
    pushNews(c, `${c.party.name} ${verb} ${def.name}! ${factionById(previous).name} is ousted.`, "good");
}

export function loseRegion(c: Campaign, rs: RegionState, to: string, why: string): void {
    const def = regionDefById(rs.id)!;
    rs.governor = to;
    rs.gov = to === "vanguard" ? "junta" : "technocracy";
    rs.war = null;
    rs.ceasefire = 10;
    rs.members = Math.round(rs.members * 0.6);
    rs.army = 0;
    rs.garrison = baseGarrison(def, rs.gov);
    rs.heat = 0.6;
    shiftSupport(rs, to, 0.08);
    pushNews(c, `${def.name} falls to ${factionById(to).name}: ${why}.`, "bad");
}

// --- Player actions on the strategic level -------------------------------------------------------

export function electionCost(rs: RegionState): number {
    return Math.round((regionDefById(rs.id)?.pop ?? 10) * 120);
}

/** Petitions for a snap election (democracies only): the vote is held in three days. */
export function callElection(c: Campaign, regionId: string): string | null {
    const rs = c.regions[regionId];
    if (!rs) return "No such region.";
    if (rs.governor === PARTY) return "You already govern here.";
    if (rs.gov !== "democracy") return "Only democracies hold elections. Here you need a coup or a war.";
    if (partyShare(rs) < 0.2) return "The party needs at least 20% support to force a vote.";
    if (rs.electionIn <= 3) return "An election is already coming.";
    const cost = electionCost(rs);
    if (c.party.funds < cost) return `The campaign costs CR ${cost.toLocaleString("en-US")}.`;
    c.party.funds -= cost;
    rs.electionIn = 3;
    rs.momentum += 0.3;
    pushNews(c, `Snap election called in ${regionDefById(regionId)!.name}! The vote is in three days.`, "info");
    return null;
}

export function coupChance(c: Campaign, regionId: string): number {
    const rs = c.regions[regionId];
    if (!rs || rs.governor === PARTY) return 0;
    const ratio = rs.army * partyQuality(c, regionId, false) / Math.max(1, rs.garrison * enemyQuality(rs));
    const spy = holder(c, "spymaster");
    const base = 0.1 + Math.min(0.55, ratio * 1.2) + rs.unrest * 0.25 + skill(c, "intrigue") * 0.04 + (spy ? spy.admin * 0.01 : 0) - rs.heat * 0.2
        - (rs.gov === "democracy" ? 0.15 : 0);
    return Math.max(0.02, Math.min(0.92, base));
}

/** A coup: armed members strike at the regime's heart. Immediate; fortune favors the prepared. */
export function attemptCoup(c: Campaign, regionId: string): { ok: boolean; message: string } {
    const rs = c.regions[regionId];
    if (!rs) return { ok: false, message: "No such region." };
    if (rs.governor === PARTY) return { ok: false, message: "You already govern here." };
    if (rs.army < 10) return { ok: false, message: "A coup needs at least 10 armed members in the region." };
    if (rs.war) return { ok: false, message: "There is a war on here already." };
    const p = coupChance(c, regionId);
    const def = regionDefById(regionId)!;
    return withRng(c, r => {
        if (r.next() < p) {
            takeRegion(c, rs, "coup");
            return { ok: true, message: `The coup in ${def.name} succeeds!` };
        }
        const safe = hasFacility(c, "safehouses") ? 0.5 : 1;
        rs.army = Math.round(rs.army * (1 - 0.6 * safe));
        rs.members = Math.round(rs.members * (1 - 0.3 * safe));
        rs.heat = Math.min(1, rs.heat + 0.4);
        addKarma(c, -5);
        pushNews(c, `The coup in ${def.name} fails. Loyalist troops hunt party members.`, "bad");
        return { ok: false, message: `The coup in ${def.name} failed.` };
    });
}

function newWar(attacker: string, defender: string, party: number, enemy: number): War {
    return { attacker, defender, partyStrength: party, enemyStrength: enemy, partyStart: Math.max(1, party), enemyStart: Math.max(1, enemy), days: 0, phase: "offensive", fieldKills: 0, fieldLosses: 0, log: [] };
}

export function declareWar(c: Campaign, regionId: string): string | null {
    const rs = c.regions[regionId];
    if (!rs) return "No such region.";
    if (rs.governor === PARTY) return "You govern this region.";
    if (rs.war) return "Already at war here.";
    if (rs.ceasefire > 0) return `A ceasefire holds for ${rs.ceasefire} more days.`;
    if (rs.army < 10) return "Station at least 10 armed members here before declaring war.";
    rs.war = newWar(PARTY, rs.governor, rs.army, rs.garrison);
    rs.heat = 1;
    c.stats.wars++;
    addKarma(c, rs.gov === "junta" ? -1 : -4);
    if (!c.outlawedDay) outlaw(c);
    pushNews(c, `WAR: ${c.party.name} rises against ${factionById(rs.governor).name} in ${regionDefById(regionId)!.name}!`, "war");
    return null;
}

/** Sues for peace: accepted when the enemy is losing or tired of the war. */
export function proposePeace(c: Campaign, regionId: string): { ok: boolean; message: string } {
    const rs = c.regions[regionId];
    if (!rs?.war) return { ok: false, message: "There is no war here." };
    const mine = rs.army * partyQuality(c, regionId, false);
    const theirs = rs.garrison * enemyQuality(rs);
    const weary = Math.min(0.5, rs.war.days / 40);
    const p = Math.max(0.05, Math.min(0.95, (mine / Math.max(1, theirs)) * 0.6 + weary - (rs.war.attacker === PARTY ? 0.1 : 0)));
    return withRng(c, r => {
        if (r.next() < p) {
            rs.war = null;
            rs.ceasefire = 20;
            pushNews(c, `Ceasefire signed in ${regionDefById(regionId)!.name}.`, "info");
            return { ok: true, message: "Peace is signed. The guns fall silent for now." };
        }
        return { ok: false, message: "Your envoys are sent back. The war goes on." };
    });
}

/** In a party-governed democracy, cancel the vote: you can't lose an election that isn't held. */
export function suspendElections(c: Campaign, regionId: string): string | null {
    const rs = c.regions[regionId];
    if (!rs || rs.governor !== PARTY) return "You don't govern there.";
    if (rs.gov !== "democracy") return "There are no elections to suspend.";
    rs.gov = "junta";
    rs.unrest = Math.min(1, rs.unrest + 0.2);
    addKarma(c, -15);
    pushNews(c, `Elections suspended indefinitely in ${regionDefById(regionId)!.name}.`, "bad");
    return null;
}

export function setTaxRate(c: Campaign, regionId: string, rate: number): void {
    const rs = c.regions[regionId];
    if (rs && rs.governor === PARTY) rs.taxRate = Math.max(0, Math.min(0.6, rate));
}

function outlaw(c: Campaign): void {
    c.outlawedDay = c.day || 1;
    for (const rs of Object.values(c.regions)) if (rs.governor !== PARTY && rs.members > 0) rs.heat = Math.min(1, rs.heat + 0.25);
    pushNews(c, `The Concordat declares ${c.party.name} an enemy of the state. Its militaries mobilize.`, "war");
}

// --- Local results (speeches, pamphlets, recruits in the street) ---------------------------------

export interface SpeechOutcome {
    /** 0..1 quality of the whole speech. */
    score: number;
    /** People in the crowd at the end. */
    crowd: number;
    /** New members from the crowd. */
    joined: number;
    /** A rival's support lost to you (debates). */
    rivalHit?: { faction: string; amount: number };
    karma: number;
}

/** Applies a speech given in person to its region; returns the support gained. */
export function applySpeech(c: Campaign, regionId: string, o: SpeechOutcome): number {
    const rs = c.regions[regionId];
    if (!rs) return 0;
    const def = regionDefById(regionId)!;
    const crowdFactor = Math.min(1.5, 0.4 + o.crowd / 30);
    // Big regions take more speeches; speech after speech on the same day returns less.
    const popFactor = Math.max(0.5, Math.min(2, Math.sqrt(40 / def.pop)));
    const fatigue = 1 / (1 + rs.momentum * 2.5);
    const gain = shiftSupport(rs, PARTY, (0.0015 + o.score * 0.008) * crowdFactor * popFactor * fatigue * (1 + skill(c, "oratory") * 0.1));
    if (o.rivalHit) shiftSupport(rs, PARTY, o.rivalHit.amount, o.rivalHit.faction);
    rs.momentum = Math.min(1, rs.momentum + o.score * 0.4);
    rs.members += o.joined;
    // The hat goes round after a good speech.
    const donations = Math.round(o.crowd * o.score * def.wealth * 8);
    c.party.funds += donations;
    rs.heat = Math.min(1, rs.heat + 0.02);
    addKarma(c, o.karma);
    c.stats.speeches++;
    c.stats.bestSpeech = Math.max(c.stats.bestSpeech, Math.round(o.score * 100));
    c.party.peakMembers = Math.max(c.party.peakMembers, totalMembers(c));
    gainXp(c, Math.round(20 + o.score * 60));
    return gain;
}

/** A rival won the crowd (their speech went unanswered, or you lost the debate). */
export function applyRivalSpeech(c: Campaign, regionId: string, faction: string, strength: number): void {
    const rs = c.regions[regionId];
    if (!rs) return;
    shiftSupport(rs, faction, 0.002 + strength * 0.006);
}

export function applyPamphlet(c: Campaign, regionId: string, opinionGain: number, karma: number, rivalHit = 0): void {
    const rs = c.regions[regionId];
    if (!rs) return;
    shiftSupport(rs, PARTY, 0.00015 + opinionGain * 0.0008);
    if (rivalHit > 0) {
        const rival = strongestRival(rs);
        rs.support[rival] = Math.max(0, rs.support[rival] - rivalHit * 0.001);
        rs.support[UNDECIDED] += rivalHit * 0.001;
        normalizeSupport(rs.support);
    }
    addKarma(c, karma);
    c.stats.pamphlets++;
    gainXp(c, 2);
}

/** Street battle results feed the region's war (each soldier stands for TROOPS_PER_SOLDIER). */
export function reportFieldBattle(c: Campaign, regionId: string, kills: number, losses: number): void {
    const rs = c.regions[regionId];
    c.stats.kills += kills;
    gainXp(c, kills * 12);
    if (!rs?.war) return;
    rs.war.fieldKills += kills;
    rs.war.fieldLosses += losses;
}

// --- Travel and death ----------------------------------------------------------------------------

export function travelCost(c: Campaign, fromLat: number, fromLon: number, regionId: string): { km: number; cost: number; days: number } {
    const d = regionDefById(regionId)!;
    const km = angularDistance(fromLat, fromLon, d.lat, d.lon) * EARTH_RADIUS_KM;
    // Governed regions are home turf: the party's own transit is free.
    const ours = c.regions[regionId]?.governor === PARTY;
    return { km, cost: ours ? 0 : Math.round(150 + km * 0.25), days: Math.max(0, Math.ceil(km / 5000)) };
}

/** Takes you to a region's city (the addon then loads the place). Advances the travel days. */
export function travel(c: Campaign, regionId: string): string | null {
    const d = regionDefById(regionId);
    if (!d) return "No such region.";
    const t = travelCost(c, c.player.lat, c.player.lon, regionId);
    if (c.party.funds < t.cost) return `The journey costs CR ${t.cost.toLocaleString("en-US")}.`;
    c.party.funds -= t.cost;
    for (let i = 0; i < t.days; i++) advanceDay(c);
    c.player.lat = d.lat;
    c.player.lon = d.lon;
    return null;
}

export function moveHq(c: Campaign, regionId: string): string | null {
    const rs = c.regions[regionId];
    if (!rs) return "No such region.";
    if (rs.members < 10 && rs.governor !== PARTY) return "Headquarters need at least 10 members in the region.";
    c.party.hq = regionId;
    pushNews(c, `Party headquarters move to ${regionDefById(regionId)!.name}.`, "info");
    return null;
}

/** You fell in the street: your comrades carry you to headquarters at a price. */
export function playerDied(c: Campaign, regionId: string): string {
    c.stats.deaths++;
    const lost = Math.max(0, Math.round(c.party.funds * 0.15));
    c.party.funds -= lost;
    c.player.health = 50;
    c.player.armor = 0;
    const rs = c.regions[regionId];
    if (rs) rs.momentum = 0;
    const msg = `${c.party.leader} was gravely wounded. Comrades smuggled you to safety (CR ${lost.toLocaleString("en-US")} in bribes).`;
    pushNews(c, msg, "bad");
    return msg;
}

// --- The daily tick ------------------------------------------------------------------------------

function grassroots(c: Campaign, rs: RegionState, popMillions: number, propagandaBoost: number, radio: boolean, r: Rng): void {
    if (rs.members <= 0 && partyShare(rs) <= 0) return;
    const density = rs.members / (popMillions * 1e6);
    let gain = Math.min(0.01, 0.0022 * Math.sqrt(density / 1e-5)) * propagandaBoost;
    gain += rs.momentum * 0.004;
    if (radio && rs.members > 0) gain += 0.002;
    if (rs.governor === PARTY) gain += 0.002;
    // Brutal parties grow through fear in some places and revulsion in others.
    gain *= 1 + c.party.karma / 400;
    if (gain > 0) shiftSupport(rs, PARTY, gain * (0.7 + 0.6 * r.next()));
    // Supporters join; members recruit their friends.
    const share = partyShare(rs);
    const cap = share * popMillions * 1e6 * 0.03;
    const growth = rs.members * 0.012 * Math.min(1, share * 6) + (share > 0.02 ? share * popMillions * 1e6 * 0.000004 : 0);
    if (rs.members < cap) rs.members = Math.min(cap, rs.members + growth);
    rs.members = Math.round(rs.members);
    // Support with no one to keep it up fades.
    if (rs.members < 5 && rs.governor !== PARTY) rs.support[PARTY] *= 0.985;
    rs.momentum *= 0.8;
}

function rivalsCampaign(c: Campaign, rs: RegionState, r: Rng): void {
    const def = regionDefById(rs.id)!;
    const party = partyShare(rs);
    for (const id of RIVALS) {
        const f = factionById(id);
        let push = f.drive * topicFit(def, id) * (0.4 + 0.8 * r.next());
        push *= 1 + 2.5 * party;            // they fight you where you are strong
        if (rs.governor === id) push *= 1.3; // incumbency
        if (c.outlawedDay && id === "concordat") push *= 1.3;
        shiftSupport(rs, id, push * 0.5);
    }
    // The rivals' attacks on the party: the stronger you are here, the harder they hit.
    const attack = RIVALS.reduce((s, id) => s + factionById(id).drive, 0) * party * 0.35 * (0.5 + r.next());
    if (rs.governor !== PARTY) shiftSupport(rs, strongestRival(rs), attack, PARTY);
    // A little of everyone's support drifts back to undecided each day (people forget).
    for (const k of Object.keys(rs.support)) if (k !== UNDECIDED && (k !== PARTY || rs.governor !== PARTY)) {
        const t = rs.support[k] * 0.004;
        rs.support[k] -= t;
        rs.support[UNDECIDED] += t;
    }
    normalizeSupport(rs.support);
}

const CRACKDOWN: Record<GovType, number> = { democracy: 0.03, technocracy: 0.08, oligarchy: 0.1, junta: 0.15 };

function heatAndCrackdowns(c: Campaign, rs: RegionState, r: Rng): void {
    const def = regionDefById(rs.id)!;
    if (rs.governor === PARTY) { rs.heat = 0; return; }
    const spy = holder(c, "spymaster");
    rs.heat += partyShare(rs) * 0.03 + (c.party.karma < -30 ? 0.01 : 0) + (c.outlawedDay ? 0.012 : 0) + (rs.army > 0 ? 0.01 : 0);
    rs.heat -= 0.012 + (spy ? spy.admin * 0.002 : 0);
    rs.heat = Math.max(0, Math.min(1, rs.heat));
    if (rs.members <= 0 && rs.army <= 0) return;
    if (r.next() < rs.heat * CRACKDOWN[rs.gov]) {
        const safe = hasFacility(c, "safehouses") ? 0.5 : 1;
        const frac = (0.12 + 0.2 * r.next()) * safe;
        const lostM = Math.round(rs.members * frac);
        const lostA = Math.round(rs.army * frac * 0.6);
        rs.members -= lostM;
        rs.army -= lostA;
        for (const m of [...c.members]) {
            if (m.region === rs.id && !m.follower && m.role !== "commissioner" && r.next() < 0.12 * safe) {
                c.members.splice(c.members.indexOf(m), 1);
                pushNews(c, `${m.name} was arrested in ${def.name}.`, "bad");
            }
        }
        rs.heat *= 0.4;
        pushNews(c, `Crackdown in ${def.name}: ${lostM.toLocaleString("en-US")} members arrested${lostA ? `, ${lostA} fighters lost` : ""}.`, "bad");
    }
}

function unrest(c: Campaign, rs: RegionState): void {
    const def = regionDefById(rs.id)!;
    let target = 0.15 + (def.wealth < 0.5 ? 0.15 : 0);
    if (rs.governor === PARTY) {
        target += rs.taxRate * 0.9 - 0.12 + (1 - partyShare(rs)) * 0.25;
        if (c.party.karma < -30) target += 0.1;
        if (rs.gov === "junta") target += 0.05;
    } else {
        target += (1 - (rs.support[rs.governor] ?? 0)) * 0.2 + partyShare(rs) * 0.15;
    }
    if (rs.war) target += 0.25;
    rs.unrest += (Math.max(0, Math.min(1, target)) - rs.unrest) * 0.08;
}

function elections(c: Campaign, rs: RegionState, r: Rng): void {
    if (rs.gov !== "democracy" || rs.war) return;
    rs.electionIn--;
    if (rs.electionIn > 0) return;
    rs.electionIn = 60;
    const def = regionDefById(rs.id)!;
    const decided = Object.entries(rs.support).filter(([k]) => k !== UNDECIDED);
    const total = decided.reduce((s, [, v]) => s + v, 0) || 1;
    let winner = rs.governor, best = -1;
    const results: [string, number][] = [];
    for (const [k, v] of decided) {
        let vote = v / total + (r.next() - 0.5) * 0.04;
        if (k === PARTY) vote += rs.momentum * 0.05 + Math.min(0.03, rs.members / (def.pop * 1e6) * 50);
        if (k === rs.governor) vote += 0.02;
        results.push([k, vote]);
        if (vote > best) { best = vote; winner = k; }
    }
    const pct = Math.round((results.find(x => x[0] === PARTY)?.[1] ?? 0) * 100);
    if (winner === PARTY && rs.governor !== PARTY) takeRegion(c, rs, "election");
    else if (winner !== PARTY && rs.governor === PARTY) loseRegion(c, rs, winner, `voted out (${pct}% for the party)`);
    else if (winner !== rs.governor) {
        rs.governor = winner;
        pushNews(c, `${factionById(winner).name} wins the election in ${def.name}. The party took ${pct}%.`, "info");
    } else if (rs.members > 0 || partyShare(rs) > 0.02) {
        pushNews(c, `${factionById(winner).name} holds ${def.name} in the election. The party took ${pct}%.`, winner === PARTY ? "good" : "info");
    }
}

function stepWar(c: Campaign, rs: RegionState, r: Rng, playerRegion: string | null): void {
    const w = rs.war!;
    const def = regionDefById(rs.id)!;
    w.days++;
    // Street battles fought in person count first.
    if (w.fieldKills || w.fieldLosses) {
        rs.garrison = Math.max(0, rs.garrison - w.fieldKills * TROOPS_PER_SOLDIER);
        rs.army = Math.max(0, rs.army - w.fieldLosses * Math.round(TROOPS_PER_SOLDIER / 2));
        w.fieldKills = 0;
        w.fieldLosses = 0;
    }
    const partyAttacks = (w.attacker === PARTY) === (w.phase === "offensive");
    const qP = partyQuality(c, rs.id, playerRegion === rs.id) * (partyAttacks ? 1.3 : 0.7);
    const qE = enemyQuality(rs) * (partyAttacks ? 0.7 : 1.3);
    const k = 0.06;
    const lossE = Math.min(rs.garrison, Math.round(k * rs.army * qP * (0.8 + 0.4 * r.next())));
    const lossP = Math.min(rs.army, Math.round(k * rs.garrison * qE * (0.8 + 0.4 * r.next())));
    rs.garrison -= lossE;
    rs.army -= lossP;
    // The regime calls up reserves from the rest of its bloc.
    const bloc = def.bloc;
    const blocRegions = REGIONS.filter(d => d.bloc === bloc);
    const loyal = blocRegions.filter(d => c.regions[d.id].governor !== PARTY).length / blocRegions.length;
    if (w.attacker === PARTY) rs.garrison += Math.round(baseGarrison(def, rs.gov) * 0.012 * loyal);
    w.partyStrength = rs.army;
    w.enemyStrength = rs.garrison;
    const who = w.phase === "offensive" ? (w.attacker === PARTY ? "Party offensive" : "Enemy offensive") : (w.attacker === PARTY ? "Enemy counterattack" : "Party counterattack");
    w.log.unshift(`Day ${w.days}: ${who}. Party -${lossP}, enemy -${lossE}.`);
    if (w.log.length > 8) w.log.length = 8;
    w.phase = w.phase === "offensive" ? "counter" : "offensive";
    const enemyBroken = rs.garrison <= Math.max(20, w.enemyStart * 0.1);
    const partyBroken = rs.army <= Math.max(3, w.partyStart * 0.08);
    if (enemyBroken) {
        if (w.attacker === PARTY) takeRegion(c, rs, "war");
        else {
            rs.war = null;
            rs.ceasefire = 20;
            rs.garrison = Math.round(rs.garrison * 0.5);
            gainXp(c, 80);
            pushNews(c, `The party holds ${def.name}! The ${factionById(w.attacker).name} assault is broken.`, "good");
        }
    } else if (partyBroken) {
        if (w.attacker === PARTY) {
            rs.war = null;
            rs.ceasefire = 10;
            rs.members = Math.round(rs.members * 0.85);
            rs.heat = 1;
            pushNews(c, `The uprising in ${def.name} is crushed.`, "bad");
        } else {
            loseRegion(c, rs, w.attacker, "overrun by its army");
        }
    }
}

/** The Concordat and the rivals send their militaries to take party regions back; unrest breeds insurgents. */
function counterOffensives(c: Campaign, r: Rng): void {
    const ours = partyRegions(c);
    if (!ours.length) return;
    const share = governedShare(c);
    for (const rs of ours) {
        if (rs.war || rs.ceasefire > 0) continue;
        const def = regionDefById(rs.id)!;
        // Insurgents grow with unrest.
        rs.garrison += Math.round(baseGarrison(def, "democracy") * 0.01 * Math.max(0, rs.unrest - 0.3));
        const insurgency = rs.unrest > 0.75 && rs.garrison > rs.army * 0.5;
        // Invasions are rare while the party is small and grow with its share of the world; their
        // size depends on how much of the region's bloc is still loyal to the old order.
        const blocRegions = REGIONS.filter(d => d.bloc === def.bloc);
        const loyal = blocRegions.filter(d => c.regions[d.id].governor !== PARTY).length / blocRegions.length;
        const invasion = loyal > 0 && r.next() < 0.004 + Math.max(0, share - 0.05) * 0.06;
        if (insurgency || invasion) {
            const attacker = strongestRival(rs);
            const force = insurgency ? rs.garrison : rs.garrison + Math.round(baseGarrison(def, "technocracy") * (0.15 + share * 0.8) * loyal);
            rs.garrison = force;
            // A popular government's people take up arms to defend it; minority rule gets no one.
            const volunteers = Math.round(Math.min(rs.members * 0.04, partyShare(rs) > 0.4 ? partyShare(rs) * def.pop * 1e6 * 0.0001 : 0));
            if (volunteers > 0) {
                rs.army += volunteers;
                rs.members -= volunteers;
                pushNews(c, `${volunteers.toLocaleString("en-US")} citizens of ${def.name} volunteer to defend the party's government.`, "good");
            }
            rs.war = newWar(attacker, PARTY, rs.army, force);
            c.stats.wars++;
            pushNews(c, insurgency
                ? `INSURGENCY in ${def.name}: ${factionById(attacker).name} loyalists take up arms against party rule!`
                : `INVASION: ${factionById(attacker).name} forces march on party-held ${def.name}!`, "war");
        }
    }
}

function resolveSchemes(c: Campaign, r: Rng): void {
    for (const s of [...c.schemes]) {
        s.daysLeft--;
        if (s.daysLeft > 0) continue;
        c.schemes.splice(c.schemes.indexOf(s), 1);
        const def = SCHEMES.find(x => x.id === s.scheme);
        const rs = c.regions[s.region];
        if (!def || !rs) continue;
        const where = regionDefById(s.region)!.name;
        if (r.next() < s.chance) {
            addKarma(c, def.karma);
            switch (def.effect) {
                case "support": shiftSupport(rs, PARTY, def.amount); break;
                case "rival-down": {
                    const rival = strongestRival(rs);
                    const t = Math.min(rs.support[rival], def.amount);
                    rs.support[rival] -= t;
                    rs.support[UNDECIDED] += t * 0.6;
                    rs.support[PARTY] += t * 0.4;
                    normalizeSupport(rs.support);
                    break;
                }
                case "funds": c.party.funds += def.amount; c.ledger.schemes += def.amount; break;
                case "members": rs.members += Math.round(def.amount * (regionDefById(s.region)!.pop * 1e6) * Math.max(0.05, partyShare(rs))); break;
                case "security-down": rs.garrison = Math.round(rs.garrison * (1 - def.amount)); break;
                case "unrest": rs.unrest = Math.min(1, rs.unrest + def.amount); break;
            }
            gainXp(c, 25);
            pushNews(c, `Scheme succeeded in ${where}: ${def.name}.`, "good");
        } else {
            rs.heat = Math.min(1, rs.heat + 0.25);
            const safe = hasFacility(c, "safehouses") ? 0.5 : 1;
            rs.members = Math.round(rs.members * (1 - 0.08 * safe));
            addKarma(c, def.karma / 2);
            pushNews(c, `Scheme exposed in ${where}: ${def.name} fails, and the press has the story.`, "bad");
        }
    }
}

function checkOutcome(c: Campaign): void {
    if (c.outcome) return;
    const share = governedShare(c);
    if (share >= VICTORY_SHARE) {
        const title = karmaTitle(c.party.karma);
        const text = c.party.karma >= 25
            ? `${c.party.leader} stands before a free planet. The people chose you, and the century of the Concordat is over.`
            : c.party.karma <= -25
                ? `${c.party.leader} rules Earth with an iron hand. Every screen carries your face; every voice speaks your name, or none at all.`
                : `${c.party.leader} holds Earth by persuasion and by force in equal measure. History will argue about you for a thousand years.`;
        c.outcome = { kind: "victory", title: `PLANETARY ${title}`, text, day: c.day };
        pushNews(c, `${c.party.name} now governs ${Math.round(share * 100)}% of humanity. EARTH IS OURS.`, "good");
        return;
    }
    const members = Object.values(c.regions).reduce((s, rs) => s + rs.members + rs.army, 0);
    if (c.party.brokeDays >= 21) c.outcome = { kind: "defeat", title: "BANKRUPT", text: "Three weeks without pay. The comrades drift away, the printing presses are sold, and the party is a footnote.", day: c.day };
    else if (c.party.peakMembers >= 50 && members <= 0 && c.members.length === 0) c.outcome = { kind: "defeat", title: "CRUSHED", text: "Every last member arrested, dead or fled. The Concordat's sensors watch an empty square.", day: c.day };
}

/** One campaign day. `playerRegion` is where you are (your presence matters in its wars). */
export function advanceDay(c: Campaign, playerRegion: string | null = null): void {
    if (c.outcome) return;
    c.day++;
    applyLedger(c, dailyLedger(c));
    const prop = holder(c, "propaganda");
    const report = orgReport(c);
    const radio = hasFacility(c, "radio");
    withRng(c, r => {
        for (const def of REGIONS) {
            const rs = c.regions[def.id];
            const ro = report.regions[def.id];
            const organized = ro && ro.members > 0 ? ro.organized / ro.members : 1;
            const boost = (0.5 + 0.5 * organized) * (1 + (prop ? prop.charisma / 20 : 0));
            grassroots(c, rs, def.pop, boost, radio, r);
            rivalsCampaign(c, rs, r);
            unrest(c, rs);
            heatAndCrackdowns(c, rs, r);
            elections(c, rs, r);
            if (rs.war) stepWar(c, rs, r, playerRegion);
            else {
                if (rs.ceasefire > 0) rs.ceasefire--;
                // A regime at peace rebuilds its garrison.
                if (rs.governor !== PARTY) {
                    const base = baseGarrison(def, rs.gov);
                    if (rs.garrison < base) rs.garrison = Math.min(base, rs.garrison + Math.ceil(base * 0.02));
                }
            }
        }
        // Support spreads to neighbors from strongholds.
        for (const def of REGIONS) {
            const share = partyShare(c.regions[def.id]);
            if (share < 0.15) continue;
            for (const n of near(def.id)) shiftSupport(c.regions[n], PARTY, (share - 0.1) * 0.012);
        }
        // The bandwagon: once the party governs much of humanity, sympathetic regions come over peacefully.
        const gov = governedShare(c);
        if (gov >= 0.3) {
            for (const def of REGIONS) {
                const rs = c.regions[def.id];
                if (rs.governor === PARTY || rs.war || partyShare(rs) < 0.45) continue;
                if (r.next() < 0.02 + (gov - 0.3) * 0.1) {
                    takeRegion(c, rs, "election");
                    pushNews(c, `${def.name} joins the party's government without a shot fired.`, "good");
                }
            }
        }
        counterOffensives(c, r);
        resolveSchemes(c, r);
    });
    dailyMembers(c);
    if (!c.outlawedDay && (worldSupport(c) > 0.04 || partyRegions(c).length > 0)) outlaw(c);
    c.party.peakMembers = Math.max(c.party.peakMembers, totalMembers(c));
    checkOutcome(c);
}

export { BLOCS };
