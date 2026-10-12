// What Alex becomes: the RPG layer over the chapters, as data and pure functions.
//
// - Experience and levels: kills, quests, discoveries, potions and upgrades give experience;
//   each level raises his vitals and gives a perk point.
// - Perks in three paths: the soldier he was (Soldier), the one who learns to move unseen
//   (Ghost), and the river in his blood (River).
// - Powers of the river: each one is learned by drinking a potion found out in the world -
//   usually behind something that guards it. Casting spends Resonance, which returns slowly
//   and from river draughts.
// - Cyborg upgrades from the surface: tech caches in the wreckage on the plain above the crack,
//   guarded by the Deep Bore's own security, gone rogue since the blast.
// - Enemy kinds and ranks: who comes at him (wardens, adepts, skirmishers, seers, champions, the
//   Bore's rogue synthetics, a behemoth with its rider), and how hard (initiate, veteran, elite).
// - Loot: what the fallen carry.
//
// The Game (ab_game.ts) holds a Progress and calls in here; nothing here touches the engine.

import type { Rng } from "../allegiance/al_rng";

// --- Experience and levels --------------------------------------------------------------------------

export const MAX_LEVEL = 20;

/** Experience from one level to the next. */
export const xpToNext = (level: number): number => 90 + 55 * level;

export interface Progress {
    xp: number;
    level: number;
    /** Perk points not yet spent. */
    points: number;
    /** Perk ranks taken (id -> rank). */
    perks: Record<string, number>;
    /** Powers learned (by drinking their potion), and the one ready to cast. */
    powers: string[];
    power: string | null;
    /** The river's charge for powers (0..resonanceMax). */
    resonance: number;
    /** Cyborg upgrades installed. */
    upgrades: string[];
    /** Places discovered (ids). */
    discovered: string[];
}

export function newProgress(): Progress {
    return { xp: 0, level: 1, points: 0, perks: {}, powers: [], power: null, resonance: 0, upgrades: [], discovered: [] };
}

/** Adds experience; returns the levels gained (each one a perk point). */
export function addXp(p: Progress, amount: number): number {
    if (p.level >= MAX_LEVEL) return 0;
    p.xp += Math.max(0, Math.round(amount));
    let gained = 0;
    while (p.level < MAX_LEVEL && p.xp >= xpToNext(p.level)) {
        p.xp -= xpToNext(p.level);
        p.level++;
        p.points++;
        gained++;
    }
    if (p.level >= MAX_LEVEL) p.xp = 0;
    return gained;
}

/** Experience for things done (kills come from `killXp`). */
export const XP = { mainQuest: 400, sideQuest: 220, encounter: 260, discovery: 60, potion: 150, upgrade: 150, chapter: 300 } as const;

// --- Perks ----------------------------------------------------------------------------------------------

export type PerkPath = "soldier" | "ghost" | "river";

export interface PerkDef { id: string; name: string; path: PerkPath; max: number; text: string }

export const PERKS: PerkDef[] = [
    { id: "steady", name: "Steady Hands", path: "soldier", max: 3, text: "Shots spread 15% less per rank." },
    { id: "plating", name: "Plate Bond", path: "soldier", max: 3, text: "Plates hold 20 more per rank." },
    { id: "medic", name: "Field Medic", path: "soldier", max: 2, text: "Medgel heals 25 more per rank." },
    { id: "quickhands", name: "Quick Hands", path: "soldier", max: 2, text: "Reloads 15% faster per rank." },
    { id: "softstep", name: "Soft Step", path: "ghost", max: 3, text: "Crouched, you are noticed 20% closer per rank, and move faster." },
    { id: "ambush", name: "Ambusher", path: "ghost", max: 2, text: "50% more damage per rank to enemies who have not seen you." },
    { id: "scavenger", name: "Scavenger", path: "ghost", max: 2, text: "The fallen carry more, and better, per rank." },
    { id: "deepwell", name: "Deep Well", path: "river", max: 3, text: "Resonance holds 25 more per rank." },
    { id: "attune", name: "Attunement", path: "river", max: 2, text: "Powers cost 15% less per rank." },
    { id: "riverblood", name: "Riverblood", path: "river", max: 2, text: "Wounds begin to knit sooner, and faster, per rank." },
];

export const perk = (p: Progress, id: string): number => p.perks[id] ?? 0;

export function canTakePerk(p: Progress, id: string): boolean {
    const d = PERKS.find(x => x.id === id);
    return !!d && p.points > 0 && perk(p, id) < d.max;
}

export function takePerk(p: Progress, id: string): boolean {
    if (!canTakePerk(p, id)) return false;
    p.perks[id] = perk(p, id) + 1;
    p.points--;
    return true;
}

/** Derived numbers the game reads every frame. */
export function stats(p: Progress) {
    const up = (id: string) => p.upgrades.includes(id);
    return {
        maxHealth: 100 + (p.level - 1) * 4,
        armorBonus: perk(p, "plating") * 20 + (up("weave") ? 40 : 0),
        spread: Math.pow(0.85, perk(p, "steady")),
        reload: Math.pow(0.85, perk(p, "quickhands")),
        medgel: 55 + perk(p, "medic") * 25,
        /** Multiplies how far a crouched Alex is noticed. */
        stealth: 1 - perk(p, "softstep") * 0.2,
        crouchPace: 1 + perk(p, "softstep") * 0.12,
        ambush: 1 + perk(p, "ambush") * 0.5,
        scavenger: perk(p, "scavenger"),
        resonanceMax: p.powers.length ? 100 + perk(p, "deepwell") * 25 : 0,
        powerCost: Math.pow(0.85, perk(p, "attune")),
        /** Seconds after a hit before wounds knit, and how fast (per second). */
        regenDelay: up("medpump") ? 3 : 7 - perk(p, "riverblood") * 1.5,
        regenRate: (up("medpump") ? 6 : 3) * (1 + perk(p, "riverblood") * 0.5),
        fallDamage: up("dampers") ? 0.5 : 1,
        jump: up("dampers") ? 1.35 : 1,
        sprint: up("reflex") ? 1.2 : 1,
        staminaDrain: up("reflex") ? 0.65 : 1,
        scanRange: up("optics") ? 2 : 1,
        zoom: up("optics") ? 1.35 : 1,
    };
}

// --- Powers of the river ------------------------------------------------------------------------------

export interface PowerDef {
    id: string;
    name: string;
    /** The potion that teaches it, as found in the world. */
    potion: string;
    cost: number;
    cooldown: number;
    text: string;
    /** Its light (bolts, the ward's shimmer, the HUD). */
    color: [number, number, number];
}

export const POWERS: Record<string, PowerDef> = {
    lance: { id: "lance", name: "Lumen Lance", potion: "Draught of the Lance", cost: 22, cooldown: 0.7, text: "A bolt of the river's light, thrown from the hand. Burns through wardens' wards.", color: [0.55, 0.95, 1] },
    ward: { id: "ward", name: "Still Water", potion: "Draught of Still Water", cost: 35, cooldown: 10, text: "A skin of still water: it drinks the next 90 damage, or fades in 8 seconds.", color: [0.45, 0.75, 1] },
    surge: { id: "surge", name: "River Surge", potion: "Draught of the Surge", cost: 55, cooldown: 12, text: "The river answers through you: everything close is thrown back and burned.", color: [0.6, 1, 0.95] },
    veil: { id: "veil", name: "Veil", potion: "Draught of the Veil", cost: 40, cooldown: 20, text: "For twelve seconds the light bends round you: only the nearest notice you.", color: [0.7, 0.6, 1] },
    mend: { id: "mend", name: "Mend", potion: "Draught of Mending", cost: 30, cooldown: 6, text: "The water in your blood knits wounds: 45 vitals over three seconds.", color: [0.5, 1, 0.7] },
};

/** Drinks a power's potion: learns it (and fills Resonance). Returns false if already known. */
export function learnPower(p: Progress, id: string): boolean {
    if (!POWERS[id] || p.powers.includes(id)) return false;
    p.powers.push(id);
    p.power = id;
    p.resonance = stats(p).resonanceMax;
    return true;
}

/** The next learned power (cycling). */
export function cyclePower(p: Progress): string | null {
    if (!p.powers.length) return (p.power = null);
    const i = p.powers.indexOf(p.power ?? "");
    p.power = p.powers[(i + 1) % p.powers.length];
    return p.power;
}

export const powerCost = (p: Progress, id: string): number => Math.round(POWERS[id].cost * stats(p).powerCost);

/** Resonance back per second (the river in the blood). */
export const RESONANCE_REGEN = 2.2;

// --- Cyborg upgrades -----------------------------------------------------------------------------------

export interface UpgradeDef { id: string; name: string; text: string }

export const UPGRADES: Record<string, UpgradeDef> = {
    dampers: { id: "dampers", name: "Kinetic Dampers", text: "Falls hurt half as much; you jump a third higher." },
    optics: { id: "optics", name: "Optic Overlay II", text: "Scans reach twice as far; aiming down sights zooms deeper." },
    weave: { id: "weave", name: "Dermal Weave", text: "A mesh under the skin: plates hold 40 more." },
    reflex: { id: "reflex", name: "Reflex Booster", text: "Sprint 20% faster, on a third less breath." },
    medpump: { id: "medpump", name: "Subdermal Medpump", text: "Wounds begin to knit after 3 seconds, twice as fast." },
};

export function installUpgrade(p: Progress, id: string): boolean {
    if (!UPGRADES[id] || p.upgrades.includes(id)) return false;
    p.upgrades.push(id);
    return true;
}

// --- Enemy kinds and ranks ------------------------------------------------------------------------------

export type Rank = "initiate" | "veteran" | "elite";

export const RANKS: Record<Rank, { label: string; hp: number; power: number; accuracy: number; xp: number; color: [number, number, number, number] }> = {
    initiate: { label: "", hp: 1, power: 1, accuracy: 1, xp: 1, color: [1, 0.25, 0.2, 1] },
    veteran: { label: "VETERAN", hp: 1.5, power: 1.25, accuracy: 1.15, xp: 1.6, color: [1, 0.55, 0.15, 1] },
    elite: { label: "ELITE", hp: 2.3, power: 1.6, accuracy: 1.35, xp: 2.6, color: [1, 0.85, 0.2, 1] },
};

export type EnemyKind = "warden" | "adept" | "staff" | "skirmisher" | "seer" | "champion" | "synthetic" | "behemoth";

export interface EnemyDef {
    kind: EnemyKind;
    name: string;
    look: string;
    /** The combat role it fights as (ab_combat.ts). */
    role: "blade" | "caster" | "gunner" | "beast";
    hp: number;
    /** Damage multiplier and walking pace multiplier over its role's own. */
    power: number;
    pace: number;
    scale: number;
    xp: number;
    /** What its loot is drawn from. */
    loot: "warden" | "champion" | "synthetic" | "behemoth";
}

export const ENEMIES: Record<EnemyKind, EnemyDef> = {
    warden: { kind: "warden", name: "Warden", look: "warden-m", role: "blade", hp: 90, power: 1, pace: 1, scale: 1, xp: 30, loot: "warden" },
    staff: { kind: "staff", name: "Warden", look: "warden-f", role: "caster", hp: 70, power: 1, pace: 1, scale: 1, xp: 32, loot: "warden" },
    adept: { kind: "adept", name: "Adept", look: "adept", role: "caster", hp: 70, power: 1.15, pace: 1, scale: 1, xp: 38, loot: "warden" },
    skirmisher: { kind: "skirmisher", name: "Skirmisher", look: "skirmisher", role: "blade", hp: 55, power: 0.75, pace: 1.35, scale: 0.97, xp: 28, loot: "warden" },
    seer: { kind: "seer", name: "Seer", look: "seer", role: "caster", hp: 85, power: 0.8, pace: 0.9, scale: 1, xp: 60, loot: "warden" },
    champion: { kind: "champion", name: "Warden Champion", look: "champion", role: "blade", hp: 420, power: 1.6, pace: 0.85, scale: 1.12, xp: 220, loot: "champion" },
    synthetic: { kind: "synthetic", name: "Bore Sentinel", look: "rogue", role: "gunner", hp: 120, power: 1, pace: 0.9, scale: 1.02, xp: 45, loot: "synthetic" },
    behemoth: { kind: "behemoth", name: "Ashen Behemoth", look: "behemoth", role: "beast", hp: 1600, power: 1, pace: 1, scale: 3.1, xp: 650, loot: "behemoth" },
};

/** The enemy kind a look plays as (for older spawns that name only a look). */
export function kindOfLook(look: string): EnemyKind {
    for (const d of Object.values(ENEMIES)) if (d.look === look) return d.kind;
    return look === "warden-f" ? "staff" : "warden";
}

/** Experience for a kill. */
export const killXp = (kind: EnemyKind, rank: Rank = "initiate"): number => Math.round(ENEMIES[kind].xp * RANKS[rank].xp);

/**
 * A rank for a spawn: deeper into the chapter and further from the firebase the wardens are more
 * often veterans, now and then elite. `danger` is 0 (safe ground) .. 1 (the far floor, a guarded place).
 */
export function rollRank(rng: Rng, danger: number, playerLevel = 1): Rank {
    const t = Math.max(0, Math.min(1, danger)) * 0.7 + Math.min(1, (playerLevel - 1) / 12) * 0.3;
    const r = rng.next();
    if (r < t * 0.18) return "elite";
    if (r < t * 0.6) return "veteran";
    return "initiate";
}

// --- Loot -------------------------------------------------------------------------------------------------

/** Things the fallen carry, beyond the artifacts of ab_player.ts. */
export const LOOT_ITEMS: Record<string, { name: string; kind: "artifact" | "medgel" | "draught" | "slugs" | "credits"; value?: number }> = {
    medgel: { name: "Medgel", kind: "medgel" },
    draught: { name: "River draught", kind: "draught" },
    slugs: { name: "Coil slugs x32", kind: "slugs" },
    chit: { name: "Credit chit", kind: "credits", value: 60 },
};

/**
 * What a fallen enemy carries (item ids: ARTIFACTS of ab_player.ts or LOOT_ITEMS). Every one has
 * something; better ranks and the scavenger perk carry more and rarer.
 */
export function rollLoot(rng: Rng, table: EnemyDef["loot"], rank: Rank, scavenger = 0): string[] {
    const out: string[] = [];
    const more = (rank === "elite" ? 2 : rank === "veteran" ? 1 : 0) + scavenger;
    const chance = (p: number) => rng.next() < Math.min(0.95, p * (1 + more * 0.35));
    if (table === "behemoth") return ["behemoth-tusk", "draught", "draught", "medgel", ...(chance(0.5) ? ["warden-mask"] : [])];
    if (table === "synthetic") {
        out.push(chance(0.7) ? "slugs" : "chit");
        if (chance(0.35)) out.push("power-cell");
        if (chance(0.15)) out.push("medgel");
        if (chance(0.08)) out.push("bore-core");
        return out;
    }
    if (table === "champion") {
        out.push("warden-sigil", "draught");
        out.push(chance(0.5) ? "warden-mask" : "prayer-tablet");
        if (chance(0.5)) out.push("medgel");
        return out;
    }
    // Wardens: beads always; a draught of the river often; now and then something rarer.
    out.push("lumen-bead");
    if (chance(0.3)) out.push("draught");
    if (chance(0.16)) out.push("medgel");
    if (chance(0.1)) out.push("warden-sigil");
    if (chance(0.025)) out.push("warden-mask");
    return out;
}
