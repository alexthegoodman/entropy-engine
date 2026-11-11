// Nebula Kingdom's rules as data: how a nebula grows (37 levels from a moon to a hypergiant),
// its ranks, facets and abilities, the five governments, the creatures, and the twelve regions
// of the six galaxies with their goals. Nothing here touches the engine (tests read it).

import type { V3 } from "./nk_math";

// --- Growth ----------------------------------------------------------------------------------------

/** Luna's radius (km): the size a nebula is born at. */
export const START_RADIUS = 1737.4;
/** A region is built for a nebula 3.3 times wider than the last one's. */
export const REGION_GROWTH = 3.3;
/** Three levels to a region. */
export const LEVEL_GROWTH = Math.cbrt(REGION_GROWTH);
export const MAX_LEVEL = 37;

/** Mass is volume, in units of the newborn nebula's own: radius = START_RADIUS * cbrt(mass). */
export const radiusOfMass = (mass: number): number => START_RADIUS * Math.cbrt(Math.max(mass, 1e-9));
export const massOfRadius = (radius: number): number => (radius / START_RADIUS) ** 3;
export const radiusOfLevel = (level: number): number => START_RADIUS * LEVEL_GROWTH ** (level - 1);
export function levelOfRadius(radius: number): number {
    return Math.max(1, Math.min(MAX_LEVEL, 1 + Math.floor(Math.log(radius / START_RADIUS) / Math.log(LEVEL_GROWTH) + 1e-9)));
}
/** 0..1 through the current level (1 at the last level). */
export function levelProgress(radius: number): number {
    const level = levelOfRadius(radius);
    if (level >= MAX_LEVEL) return 1;
    const a = Math.log(radiusOfLevel(level)), b = Math.log(radiusOfLevel(level + 1));
    return Math.max(0, Math.min(1, (Math.log(radius) - a) / (b - a)));
}
/** The radius a region of `tier` (0..11) is built for. */
export const tierRadius = (tier: number): number => START_RADIUS * REGION_GROWTH ** tier;

/** A rank every three levels: the title the governments address you by. */
export const RANKS = [
    "Wisp", "Veil", "Shroud", "Mantle", "Tempest", "Corona", "Ember-Eater",
    "Starbreaker", "Sovereign Cloud", "Tide-Rider", "Void Regent", "Hollow-Bane", "Nebula Monarch",
] as const;
export const rankOf = (level: number): string => RANKS[Math.min(RANKS.length - 1, Math.floor((level - 1) / 3))];

/** Things to be measured against (radius, km). */
export const YARDSTICKS: readonly [number, string][] = [
    [1737.4, "Luna"], [3389.5, "Mars"], [6371, "Earth"], [24622, "Neptune"], [58232, "Saturn"], [69911, "Jupiter"],
    [107000, "Proxima Centauri"], [695700, "the Sun"], [1.19e6, "Sirius"], [1.64e6, "Vega"], [1.77e7, "Arcturus"],
    [3.07e7, "Aldebaran"], [5.49e7, "Rigel"], [4.73e8, "Antares"], [5.3e8, "Betelgeuse"], [9.9e8, "VY Canis Majoris"],
    [1.19e9, "UY Scuti"], [1.5e9, "Stephenson 2-18"],
];

/** "1.4 x Jupiter": the largest yardstick no wider than `radius` (or the smallest of all). */
export function compare(radius: number): string {
    let best = YARDSTICKS[0];
    for (const y of YARDSTICKS) if (y[0] <= radius * 1.0001) best = y;
    const ratio = radius / best[0];
    if (ratio > 0.97 && ratio < 1.03) return `as wide as ${best[1]}`;
    return `${ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)} x ${best[1]}`;
}

const AU = 1.495978707e8, LIGHT_YEAR = 9.4607e12;
export function formatKm(km: number): string {
    const a = Math.abs(km);
    if (a < 1e6) return `${Math.round(km).toLocaleString("en-US")} km`;
    if (a < 4e7) return `${(km / 1e6).toFixed(2)} million km`;
    if (a < LIGHT_YEAR * 0.05) return `${(km / AU).toFixed(a < AU * 10 ? 2 : 1)} AU`;
    return `${(km / LIGHT_YEAR).toFixed(2)} ly`;
}

// --- Bodies ----------------------------------------------------------------------------------------

/** What a body is drawn and named as. Motes and essence are light, not rock. */
export type BodyKind = "mote" | "essence" | "asteroid" | "moon" | "planet" | "giant" | "star";
/** The look within a kind (the shader's surface). */
export type BodyLook = "rock" | "ice" | "ocean" | "lava" | "desert" | "gas" | "banded" | "whiteDwarf" | "brownDwarf" | "redDwarf" | "yellow" | "white" | "blue" | "orange" | "redGiant" | "light";

/** A body's kind from its size alone: what was a mountain to a Wisp is dust to a Monarch. */
export function kindOfRadius(radius: number): BodyKind {
    if (radius < 420) return "asteroid";
    if (radius < 2800) return "moon";
    if (radius < 16000) return "planet";
    if (radius < 95000) return "giant";
    return "star";
}

export function starLook(radius: number, roll: number): BodyLook {
    if (radius < 150000) return "brownDwarf";
    if (radius < 480000) return "redDwarf";
    if (radius < 1.1e6) return roll < 0.7 ? "yellow" : "orange";
    if (radius < 4e6) return roll < 0.5 ? "white" : "yellow";
    if (radius < 4e7) return roll < 0.55 ? "blue" : "orange";
    return roll < 0.75 ? "redGiant" : "blue";
}

export const KIND_LABEL: Record<BodyKind, string> = {
    mote: "essence mote", essence: "loose essence", asteroid: "asteroid", moon: "moon", planet: "planet", giant: "gas giant", star: "star",
};
export const LOOK_LABEL: Partial<Record<BodyLook, string>> = {
    whiteDwarf: "white dwarf", brownDwarf: "brown dwarf", redDwarf: "red dwarf", yellow: "yellow star", white: "white star",
    blue: "blue giant", orange: "orange giant", redGiant: "red supergiant", ice: "ice world", ocean: "ocean world", lava: "molten world",
    desert: "desert world", rock: "barren world",
};

// --- Governments ------------------------------------------------------------------------------------

export type FactionId = "concord" | "drift" | "ember" | "synod" | "hollow" | "wild";
export type RGB = [number, number, number];

export interface Faction {
    id: FactionId;
    name: string;
    /** What kind of government it is, and what it wants. */
    form: string;
    creed: string;
    /** The colour of its lightwaves. */
    color: RGB;
    /** Where a newborn Wisp stands with it (-100..100). */
    standing: number;
    laws: string[];
    /** Who it is at war with. */
    enemies: FactionId[];
}

export const FACTIONS: Record<FactionId, Faction> = {
    concord: {
        id: "concord", name: "The Luminous Concord", form: "A federation of free clouds and the manta shoals",
        creed: "Every light is owed its own sky.", color: [0.45, 0.95, 0.9], standing: 20,
        laws: ["Worlds that carry life are under the Concord's light: do not feed on them.", "A call for aid is answered by every Warden who hears it."],
        enemies: ["ember", "hollow"],
    },
    drift: {
        id: "drift", name: "The Drift Collective", form: "A nomad market with no capital and no borders",
        creed: "Nothing is owned that cannot be carried.", color: [0.65, 1, 0.45], standing: 0,
        laws: ["There is no law in the Drift but the toll.", "Tribute buys passage; a broken deal buys a bounty."],
        enemies: [],
    },
    ember: {
        id: "ember", name: "The Ember Throne", form: "A forge-empire ruled by the Pyre Regent",
        creed: "Stars are fuel. Clouds are kindling.", color: [1, 0.45, 0.2], standing: -40,
        laws: ["All stars in the Pyre Spiral belong to the Throne.", "Clouds are to be burned on sight."],
        enemies: ["concord", "synod"],
    },
    synod: {
        id: "synod", name: "The Tidal Synod", form: "A theocracy of medusae who sing to the black holes",
        creed: "The Silence at the centre hears all.", color: [0.62, 0.5, 1], standing: -5,
        laws: ["Do not speak across a Singer's shadow.", "What the Silence takes is given, not lost."],
        enemies: ["ember"],
    },
    hollow: {
        id: "hollow", name: "The Hollow Court", form: "The living black holes and the husks that orbit them",
        creed: "All light ends here.", color: [1, 0.3, 0.42], standing: -70,
        laws: ["Every horizon is the King's border.", "Nothing that shines may be sovereign."],
        enemies: ["concord", "drift", "ember"],
    },
    wild: {
        id: "wild", name: "The Ungoverned", form: "Beasts of the dark, answering to hunger alone",
        creed: "", color: [0.85, 0.85, 0.9], standing: 0, laws: [], enemies: [],
    },
};
export const GOVERNMENTS: FactionId[] = ["concord", "drift", "ember", "synod", "hollow"];

export type StandingTier = "Hunted" | "Hostile" | "Wary" | "Known" | "Favored" | "Allied";
export function standingTier(standing: number): StandingTier {
    if (standing <= -50) return "Hunted";
    if (standing <= -15) return "Hostile";
    if (standing < 0) return "Wary";
    if (standing < 25) return "Known";
    if (standing < 60) return "Favored";
    return "Allied";
}
export const isHostileStanding = (standing: number): boolean => standing <= -15;

// --- Creatures --------------------------------------------------------------------------------------

export type SpeciesId = "skimmer" | "gnawer" | "manta" | "warden" | "quill" | "pyre" | "spire" | "medusa" | "cantor" | "drifter" | "marauder" | "rival" | "thrall" | "leviathan" | "envoy" | "lurker" | "splitter" | "prism" | "wraith";
/** What sets a creature apart from a plain brute: hides until close, splits when broken, turns
 *  single bolts back, or folds space to reach you. */
export type Trait = "ambush" | "split" | "reflect" | "blink";
export type Attack = "none" | "ram" | "bolt" | "sting";
/** prey flees; herd keeps to its own; civil minds its business; predator hunts what is smaller; soldier fights its government's enemies. */
export type Temper = "prey" | "herd" | "civil" | "predator" | "soldier";

export interface Species {
    id: SpeciesId;
    name: string;
    faction: FactionId;
    /** How it is drawn (nebula_addon.ts builds each from spheres, cones and light). */
    shape: "eel" | "crab" | "manta" | "nebula" | "wasp" | "brute" | "spire" | "jelly" | "husk" | "whale" | "envoy" | "urchin" | "blob" | "prism" | "wraith";
    /** Radius in units of the region's own radius. */
    size: number;
    hp: number;
    /** Damage of one hit against something its own size. */
    power: number;
    /** Top speed, in its own radii per second. */
    speed: number;
    /** How far it notices things, in units of the region's radius. */
    sight: number;
    attack: Attack;
    temper: Temper;
    /** Counts as an enemy of the region ("clear the region"). */
    menace: boolean;
    color: RGB;
    lore: string;
    trait?: Trait;
    /** How to beat it, for the Field Guide (with {control} names). */
    tip?: string;
}

export const SPECIES: Record<SpeciesId, Species> = {
    skimmer: { id: "skimmer", name: "Skimmer", faction: "wild", shape: "eel", size: 0.42, hp: 34, power: 9, speed: 5.4, sight: 26, attack: "ram", temper: "predator", menace: true, color: [0.55, 0.9, 1], lore: "Comet-eels that hunt in packs along the ice lanes." },
    gnawer: { id: "gnawer", name: "Gnawer", faction: "wild", shape: "crab", size: 0.7, hp: 80, power: 14, speed: 1.9, sight: 18, attack: "ram", temper: "predator", menace: true, color: [0.75, 0.6, 0.5], lore: "Armoured lithids that chew asteroids and anything slower than they are." },
    manta: { id: "manta", name: "Manta", faction: "concord", shape: "manta", size: 0.85, hp: 60, power: 0, speed: 2.6, sight: 20, attack: "none", temper: "herd", menace: false, color: [0.5, 0.95, 0.85], lore: "Void rays that graze starlight in shoals; citizens of the Concord." },
    warden: { id: "warden", name: "Warden", faction: "concord", shape: "nebula", size: 1.05, hp: 110, power: 12, speed: 3, sight: 30, attack: "bolt", temper: "soldier", menace: false, color: [0.5, 1, 0.92], lore: "Clouds sworn to the Concord's law." },
    quill: { id: "quill", name: "Quill", faction: "ember", shape: "wasp", size: 0.5, hp: 40, power: 8, speed: 4.2, sight: 34, attack: "bolt", temper: "soldier", menace: true, color: [1, 0.55, 0.25], lore: "Pulsar wasps: the Throne's skirmishers, all sting." },
    pyre: { id: "pyre", name: "Forgeborn", faction: "ember", shape: "brute", size: 1.25, hp: 150, power: 20, speed: 2.4, sight: 28, attack: "ram", temper: "soldier", menace: true, color: [1, 0.4, 0.15], lore: "Slag-armoured brutes poured in the forges of the Pyre Spiral." },
    spire: { id: "spire", name: "Forge Spire", faction: "ember", shape: "spire", size: 1.9, hp: 260, power: 13, speed: 0, sight: 46, attack: "bolt", temper: "soldier", menace: true, color: [1, 0.5, 0.2], lore: "A living furnace anchored in orbit, drinking its star." },
    medusa: { id: "medusa", name: "Medusa", faction: "synod", shape: "jelly", size: 0.9, hp: 70, power: 7, speed: 1.7, sight: 22, attack: "sting", temper: "herd", menace: false, color: [0.7, 0.55, 1], lore: "Star-jellies whose bells ring with the tides of black holes." },
    cantor: { id: "cantor", name: "Cantor", faction: "synod", shape: "jelly", size: 1.3, hp: 130, power: 14, speed: 2, sight: 32, attack: "bolt", temper: "soldier", menace: false, color: [0.82, 0.6, 1], lore: "A priest of the Synod: it sings the law and enforces it." },
    drifter: { id: "drifter", name: "Drifter", faction: "drift", shape: "eel", size: 0.75, hp: 55, power: 6, speed: 3.6, sight: 22, attack: "ram", temper: "civil", menace: false, color: [0.7, 1, 0.5], lore: "Traders of the Collective, hauling comet-ice between galaxies." },
    marauder: { id: "marauder", name: "Marauder", faction: "wild", shape: "wasp", size: 0.9, hp: 85, power: 12, speed: 3.6, sight: 32, attack: "ram", temper: "predator", menace: true, color: [0.95, 0.85, 0.35], lore: "Outlaws no government will claim. They fly straight at what they want, and do not look where they are going." },
    rival: { id: "rival", name: "Rival Cloud", faction: "wild", shape: "nebula", size: 1.2, hp: 150, power: 15, speed: 3.1, sight: 36, attack: "bolt", temper: "predator", menace: true, color: [1, 0.5, 0.85], lore: "Another living nebula, growing as you grow - and it would rather grow on you." },
    thrall: { id: "thrall", name: "Thrall", faction: "hollow", shape: "husk", size: 1, hp: 95, power: 16, speed: 3.3, sight: 40, attack: "ram", temper: "soldier", menace: true, color: [1, 0.32, 0.45], lore: "The burnt-out husk of a creature that crossed a horizon and was sent back." },
    leviathan: { id: "leviathan", name: "Leviathan", faction: "wild", shape: "whale", size: 3, hp: 420, power: 26, speed: 1.5, sight: 30, attack: "ram", temper: "herd", menace: false, color: [0.6, 0.75, 1], lore: "Star-whales older than the governments. They do not take sides." },
    envoy: { id: "envoy", name: "Envoy", faction: "concord", shape: "envoy", size: 0.9, hp: 200, power: 0, speed: 0.6, sight: 30, attack: "none", temper: "civil", menace: false, color: [1, 1, 1], lore: "The voice of a government: it speaks edicts and accepts tribute." },
    lurker: { id: "lurker", name: "Lurker", faction: "wild", shape: "urchin", size: 0.65, hp: 60, power: 18, speed: 6.5, sight: 9, attack: "ram", temper: "predator", menace: true, color: [0.55, 0.5, 0.75], trait: "ambush", lore: "Spined ambushers that lie dark among the rubble and strike whatever drifts too close.", tip: "Lurkers hide until you are close. {attune} shows them, and the Pulse {pulse} flushes them out." },
    splitter: { id: "splitter", name: "Splitter", faction: "wild", shape: "blob", size: 0.8, hp: 70, power: 9, speed: 2.4, sight: 22, attack: "ram", temper: "predator", menace: true, color: [0.6, 1, 0.55], trait: "split", lore: "A cell of living plasma. Break it and it becomes two.", tip: "Splitters burst into two smaller ones. Shardfall ({blast} to switch) catches both halves at once." },
    prism: { id: "prism", name: "Glass Sentinel", faction: "ember", shape: "prism", size: 1, hp: 120, power: 11, speed: 1.6, sight: 34, attack: "bolt", temper: "soldier", menace: true, color: [1, 0.75, 0.45], trait: "reflect", lore: "Faceted guardians cut from star-glass: they turn a single bolt straight back at whoever threw it.", tip: "Glass Sentinels turn the Lance and Seekers back at you. Break them with Sunthread or Shardfall ({blast} to switch), the Pulse or Starfire." },
    wraith: { id: "wraith", name: "Hollow Wraith", faction: "hollow", shape: "wraith", size: 0.85, hp: 75, power: 12, speed: 2.8, sight: 44, attack: "sting", temper: "soldier", menace: true, color: [0.95, 0.35, 0.6], trait: "blink", lore: "A shade of the Hollow Court that folds space in short, cruel steps.", tip: "Wraiths fold space to appear beside you, then sting. Keep moving, and Pulse {pulse} them off when they land." },
};

// --- Variants ----------------------------------------------------------------------------------------

/** A twist on an ordinary hunter: more of them appear the deeper into the kingdom you go. */
export type AffixId = "swift" | "armored" | "volatile" | "vampiric";
export const AFFIXES: Record<AffixId, { name: string; text: string; color: RGB }> = {
    swift: { name: "Swift", text: "Half again as fast.", color: [0.5, 0.95, 1] },
    armored: { name: "Armoured", text: "Nearly twice as hard to break, a little slower.", color: [0.75, 0.78, 0.85] },
    volatile: { name: "Volatile", text: "Bursts when it dies: do not finish it at close range.", color: [1, 0.6, 0.15] },
    vampiric: { name: "Vampiric", text: "Heals itself on what it strikes.", color: [1, 0.2, 0.3] },
};
export const AFFIX_IDS = Object.keys(AFFIXES) as AffixId[];
/** The chance a plain hunter in a region of `tier` carries an affix. */
export const affixChance = (tier: number): number => Math.max(0, Math.min(0.3, (tier - 1) * 0.03));

// --- Facets (perks) and abilities --------------------------------------------------------------------

export type FacetId = "density" | "radiance" | "reach" | "current" | "resonance" | "gravity";
export const FACET_MAX = 5;
export const FACETS: Record<FacetId, { name: string; text: string }> = {
    density: { name: "Density", text: "+12% cohesion and 5% less harm taken, each rank." },
    radiance: { name: "Radiance", text: "+14% to the Lance, the Pulse and Starfire, each rank." },
    reach: { name: "Reach", text: "Siphon 20% faster and from 12% farther, each rank." },
    current: { name: "Current", text: "+8% speed, each rank." },
    resonance: { name: "Resonance", text: "+10 charge and 15% faster recharge, each rank." },
    gravity: { name: "Gravity", text: "Motes and essence fall to you from 40% farther, each rank." },
};
export const FACET_IDS = Object.keys(FACETS) as FacetId[];

export type AbilityId = "lance" | "surge" | "attune" | "pulse" | "veil" | "decoy" | "flare";
export interface Ability { id: AbilityId; name: string; key: string; level: number; cost: number; cooldown: number; text: string }
export const ABILITIES: Record<AbilityId, Ability> = {
    lance: { id: "lance", name: "Lance", key: "LMB", level: 1, cost: 4, cooldown: 0.22, text: "A bolt of your own light." },
    surge: { id: "surge", name: "Lightstride", key: "SHIFT", level: 1, cost: 5, cooldown: 0, text: "Ride your own lightwave: the longer you hold it, the faster you go." },
    attune: { id: "attune", name: "Attune", key: "T", level: 1, cost: 0, cooldown: 0, text: "See the invisible lightwaves creatures speak in." },
    pulse: { id: "pulse", name: "Pulse", key: "Q", level: 3, cost: 30, cooldown: 4, text: "A shell of light that strikes and throws back everything near you." },
    veil: { id: "veil", name: "Veil", key: "C", level: 6, cost: 5, cooldown: 1, text: "Go dark: emit nothing, and be hard to see." },
    decoy: { id: "decoy", name: "Shed", key: "F", level: 9, cost: 20, cooldown: 10, text: "Cast off a knot of your own mass. Hunters chase it. So do black holes." },
    flare: { id: "flare", name: "Starfire", key: "R", level: 13, cost: 60, cooldown: 14, text: "Pour out the light of the stars you have eaten." },
};
export const ABILITY_IDS = Object.keys(ABILITIES) as AbilityId[];

// --- Galaxies and regions ---------------------------------------------------------------------------

export interface Galaxy {
    id: string;
    name: string;
    government: FactionId;
    text: string;
    /** Sky: the deep colour, two cloud colours, and how thick the clouds are (0..1). */
    sky: { deep: RGB; a: RGB; b: RGB; clouds: number; stars: number };
}

export const GALAXIES: Galaxy[] = [
    { id: "lantern", name: "The Lantern Reach", government: "concord", text: "A young, bright spiral where the Concord keeps the peace.", sky: { deep: [0.01, 0.03, 0.06], a: [0.1, 0.55, 0.6], b: [0.9, 0.6, 0.25], clouds: 0.55, stars: 1 } },
    { id: "drift", name: "The Drift", government: "drift", text: "A ragged irregular galaxy of comet lanes and toll-eddies.", sky: { deep: [0.015, 0.04, 0.03], a: [0.25, 0.7, 0.3], b: [0.85, 0.75, 0.25], clouds: 0.45, stars: 0.8 } },
    { id: "pyre", name: "The Pyre Spiral", government: "ember", text: "Every star here is claimed by the Ember Throne, and most are burning down.", sky: { deep: [0.06, 0.015, 0.01], a: [0.7, 0.16, 0.05], b: [0.85, 0.5, 0.12], clouds: 0.5, stars: 0.8 } },
    { id: "still", name: "The Still Sea", government: "synod", text: "An old elliptical where black holes sing and the medusae listen.", sky: { deep: [0.02, 0.015, 0.07], a: [0.3, 0.2, 0.9], b: [0.75, 0.35, 0.9], clouds: 0.6, stars: 1.1 } },
    { id: "crownless", name: "The Crownless Expanse", government: "wild", text: "Contested by everyone, ruled by no one. Yet.", sky: { deep: [0.03, 0.03, 0.045], a: [0.75, 0.62, 0.4], b: [0.3, 0.45, 0.95], clouds: 0.35, stars: 1.4 } },
    { id: "hollow", name: "The Hollow", government: "hollow", text: "A galaxy with almost no stars left, and the King who ate them.", sky: { deep: [0.02, 0.005, 0.012], a: [0.6, 0.06, 0.16], b: [0.95, 0.75, 0.7], clouds: 0.5, stars: 0.35 } },
];

/** Positions and sizes in region defs are in units of the region's radius (tierRadius(tier)). */
export interface BodySpec {
    key?: string;
    name?: string;
    count?: number;
    size: number | [number, number];
    at?: V3;
    /** A flat belt around a point or a keyed body. */
    belt?: { around: string | V3; r: [number, number]; thick?: number; tilt?: number };
    /** A ball-shaped field. */
    cloud?: { center: string | V3; radius: number };
    /** Circles `orbit` (a keyed body) at this distance. */
    orbit?: { around: string; r: number; speed?: number };
    kind?: BodyKind;
    look?: BodyLook;
    /** Life lives here: the governing faction forbids feeding on it. */
    inhabited?: boolean;
    rings?: boolean;
}

export interface CreatureSpec {
    key?: string;
    species: SpeciesId;
    count?: number;
    at?: V3;
    near?: string;
    spread?: number;
    faction?: FactionId;
    name?: string;
    /** Scales size, hp and power (a champion or a boss). */
    boss?: number;
    group?: string;
}

export interface HoleSpec {
    key: string;
    name: string;
    at: V3;
    /** Horizon radius. */
    size: number;
    /** Hunts the largest mass near it at this speed (region radii per second); 0 stays put. */
    hunts?: number;
}

export type GoalDef = ({ how?: string }) & (
    | { id: string; type: "absorb"; kind: BodyKind | "any"; count: number; text: string; optional?: boolean }
    | { id: string; type: "mine"; keys?: string[]; kind?: BodyKind; count?: number; text: string; optional?: boolean }
    | { id: string; type: "clear"; group?: string; text: string; optional?: boolean }
    | { id: string; type: "defeat"; key: string; text: string; optional?: boolean }
    | { id: string; type: "defend"; group: string; waves: { species: SpeciesId; count: number; boss?: number }[]; text: string; optional?: boolean }
    | { id: string; type: "feed"; hole: string; count: number; /** More of these keep coming while the goal is open, so it can always be done. */ bait: SpeciesId; text: string; optional?: boolean }
    | { id: string; type: "lure"; hole: string; to: string; after?: string[]; text: string; optional?: boolean }
    | { id: string; type: "sling"; hole: string; text: string; optional?: boolean }
    | { id: string; type: "standing"; factions: number; text: string; optional?: boolean }
    | { id: string; type: "tribute"; faction: FactionId; text: string; optional?: boolean });

export interface RegionDef {
    id: string;
    name: string;
    galaxy: string;
    tier: number;
    text: string;
    /** What the government here broadcasts when you arrive. */
    edict: string;
    /** Half the region's width. */
    extent: number;
    bodies: BodySpec[];
    creatures: CreatureSpec[];
    holes?: HoleSpec[];
    /** A tear a black hole can be led into (key "rift"). */
    rift?: { at: V3; size: number };
    /** Thralls a hunting hole keeps sending (species, every `every` seconds, up to `cap`). */
    spawner?: { hole: string; species: SpeciesId; every: number; cap: number };
    goals: GoalDef[];
    /** Standing gained with these governments when every goal is done. */
    reward: Partial<Record<FactionId, number>>;
}

const MOTES = (center: string | V3, radius: number, count: number): BodySpec => ({ kind: "mote", look: "light", count, size: [0.05, 0.09], cloud: { center, radius } });

export const REGIONS: RegionDef[] = [
    {
        id: "cradle", name: "Cradle Shoals", galaxy: "lantern", tier: 0, extent: 210,
        text: "The rubble of an unfinished world, where the Concord's newborn clouds learn to feed.",
        edict: "Little Wisp, the shoals are yours. Gather the motes, drink Pell dry, and mind the Gnawers.",
        bodies: [
            { key: "hearth", name: "Hearth", size: 6.2, at: [70, -18, 150], look: "ocean", inhabited: true, rings: true },
            { key: "pell", name: "Pell", size: 1.9, at: [-34, 6, 62], look: "rock" },
            { key: "tam", name: "Tam", size: 2.7, at: [52, 14, 20], look: "ice" },
            { key: "sola", name: "Sola", size: 4.1, at: [-88, -10, 118], look: "desert" },
            MOTES([0, 0, 18], 26, 46),
            MOTES("pell", 16, 18),
            { count: 40, size: [0.14, 0.42], belt: { around: [8, 0, 44], r: [18, 58], thick: 5, tilt: 0.2 } },
            { count: 26, size: [0.18, 0.46], belt: { around: "sola", r: [8, 15], thick: 1.5, tilt: -0.35 } },
            { count: 9, size: [0.75, 1.3], cloud: { center: [-10, 0, 90], radius: 55 } },
        ],
        creatures: [
            { species: "gnawer", count: 4, near: "pell", spread: 14, group: "gnawers" },
            { species: "skimmer", count: 5, at: [44, 8, 48], spread: 10, group: "gnawers" },
            { species: "manta", count: 7, near: "hearth", spread: 16 },
            { key: "envoy", species: "envoy", faction: "concord", name: "Envoy Lumen", at: [10, 6, 34] },
        ],
        goals: [
            { id: "motes", type: "absorb", kind: "mote", count: 20, text: "Gather 20 essence motes" },
            { id: "pell", type: "mine", keys: ["pell"], text: "Mine the moon Pell to nothing" },
            { id: "clear", type: "clear", group: "gnawers", text: "Clear the shoals of Gnawers and Skimmers" },
            { id: "tam", type: "mine", keys: ["tam", "sola"], text: "Mine the worlds Tam and Sola", optional: true },
        ],
        reward: { concord: 15 },
    },
    {
        id: "hearthring", name: "The Hearthring", galaxy: "lantern", tier: 1, extent: 230,
        text: "The Concord's garden worlds, ringed around a dying white dwarf the mantas call the Old Candle.",
        edict: "By the Concord's light: Aurel carries life and is not food. Ember raiders are coming for the shoal. Stand with us.",
        bodies: [
            { key: "candle", name: "the Old Candle", size: 1.25, at: [0, 0, 120], kind: "star", look: "whiteDwarf" },
            { key: "aurel", name: "Aurel", size: 2.4, at: [-58, 4, 96], look: "ocean", inhabited: true },
            { key: "brine", name: "Brine", size: 3.3, at: [66, -12, 150], look: "ice", rings: true },
            { key: "cinder", name: "Cinder", size: 2.9, at: [38, 16, 58], look: "lava" },
            { key: "dun", name: "Dun", size: 3.8, at: [-96, -20, 172], look: "desert" },
            MOTES([0, 0, 24], 30, 40),
            { count: 46, size: [0.15, 0.45], belt: { around: "candle", r: [22, 44], thick: 4, tilt: 0.12 } },
            { count: 10, size: [0.7, 1.25], cloud: { center: [10, 0, 100], radius: 80 } },
        ],
        creatures: [
            { species: "manta", count: 8, near: "aurel", spread: 14, group: "shoal" },
            { species: "warden", count: 2, near: "aurel", spread: 18 },
            { species: "skimmer", count: 6, at: [70, 0, 90], spread: 14, group: "pests" },
            { species: "gnawer", count: 3, near: "cinder", spread: 12, group: "pests" },
            { key: "envoy", species: "envoy", faction: "concord", name: "Envoy Halcyon", near: "aurel", spread: 9 },
            { species: "splitter", count: 2, at: [70, 0, 96], spread: 12, group: "pests" },
        ],
        goals: [
            { id: "defend", type: "defend", group: "shoal", waves: [{ species: "quill", count: 4 }, { species: "quill", count: 5 }, { species: "pyre", count: 2, boss: 1.15 }], text: "Defend the manta shoal from the Ember raid", how: "Ember raiders come in waves to the manta shoal (marked). Fly there and break each wave with {fire} before it reaches the mantas." },
            { id: "mine", type: "mine", keys: ["cinder", "brine"], text: "Mine the barren worlds Cinder and Brine" },
            { id: "candle", type: "mine", keys: ["candle"], text: "Consume the Old Candle - your first star" },
            { id: "pests", type: "clear", group: "pests", text: "Clear the ring of pests", optional: true },
        ],
        reward: { concord: 20, ember: -10 },
    },
    {
        id: "tollgate", name: "Tollgate Eddies", galaxy: "drift", tier: 2, extent: 240,
        text: "The mouth of the Drift, where everyone pays the toll or becomes it.",
        edict: "Drift toll: a twentieth of your mass, cloud, or find another galaxy. The rival called Vash did not pay. We would not weep for Vash.",
        bodies: [
            { key: "gale", name: "Gale", size: 3.6, at: [-40, 10, 110], look: "banded", rings: true },
            { key: "floe", name: "Floe", size: 2.6, at: [60, -8, 70], look: "ice" },
            { key: "murk", name: "Murk", size: 4.4, at: [30, 20, 170], look: "gas" },
            MOTES([0, 0, 30], 34, 36),
            { count: 50, size: [0.15, 0.48], belt: { around: "gale", r: [7, 16], thick: 1.2, tilt: 0.4 } },
            { count: 30, size: [0.2, 0.48], cloud: { center: [20, 0, 90], radius: 70 } },
            { count: 9, size: [0.8, 1.4], cloud: { center: [-20, 0, 120], radius: 85 } },
        ],
        creatures: [
            { species: "drifter", count: 6, at: [10, 0, 60], spread: 20 },
            { key: "envoy", species: "envoy", faction: "drift", name: "Tollkeeper Osk", at: [6, 4, 40] },
            { key: "vash", species: "rival", name: "Vash", boss: 1.35, near: "murk", spread: 14, group: "vash" },
            { species: "marauder", count: 5, near: "floe", spread: 16, group: "outlaws" },
            { species: "skimmer", count: 7, at: [-60, 0, 150], spread: 16, group: "outlaws" },
            { species: "lurker", count: 3, near: "floe", spread: 9, group: "outlaws" },
        ],
        goals: [
            { id: "toll", type: "tribute", faction: "drift", text: "Pay the Tollkeeper's tribute (or don't)", optional: true, how: "Fly close to Tollkeeper Osk and press {tribute} to pay a twentieth of your mass. Or keep it: the Drift only grumbles." },
            { id: "vash", type: "defeat", key: "vash", text: "Defeat the rival cloud Vash" },
            { id: "gale", type: "mine", keys: ["gale", "floe"], text: "Mine the worlds Gale and Floe" },
            { id: "outlaws", type: "clear", group: "outlaws", text: "Clear the eddies of outlaws" },
        ],
        reward: { drift: 20 },
    },
    {
        id: "bazaar", name: "The Comet Bazaar", galaxy: "drift", tier: 3, extent: 260,
        text: "A market strung around a small black hole the traders call the Sump. They throw their rubbish in it. And their rivals.",
        edict: "Bazaar notice: Marauders are fouling the lanes. The Sump is hungry. Draw your own conclusions, cloud.",
        bodies: [
            { key: "bruin", name: "Bruin", size: 2.2, at: [-70, 12, 120], kind: "star", look: "brownDwarf" },
            { key: "opal", name: "Opal", size: 3.2, at: [64, -6, 84], look: "banded", rings: true },
            { key: "tusk", name: "Tusk", size: 4.2, at: [-20, -24, 190], look: "gas" },
            MOTES([0, 0, 30], 34, 36),
            { count: 60, size: [0.14, 0.46], belt: { around: "sump", r: [16, 40], thick: 2.5, tilt: 0.15 } },
            { count: 10, size: [0.8, 1.4], cloud: { center: [10, 0, 110], radius: 90 } },
        ],
        creatures: [
            { species: "drifter", count: 7, at: [40, 0, 50], spread: 20 },
            { key: "envoy", species: "envoy", faction: "drift", name: "Factor Reme", at: [30, 6, 44] },
            { species: "marauder", count: 8, at: [-10, 0, 150], spread: 24, group: "marauders" },
            { species: "skimmer", count: 6, near: "opal", spread: 14, group: "marauders" },
            { species: "leviathan", count: 1, at: [90, 20, 180], name: "Old Rill" },
            { species: "lurker", count: 2, near: "opal", spread: 12, group: "marauders" },
        ],
        holes: [{ key: "sump", name: "the Sump", at: [10, 0, 110], size: 2.4 }],
        goals: [
            { id: "sling", type: "sling", hole: "sump", text: "Slingshot around the Sump without crossing its horizon", how: "Fly fast past the Sump, close enough that the ERGOSPHERE warning shows, and on out the far side. Never touch the black core. Hold {stride} for speed." },
            { id: "feed", type: "feed", hole: "sump", count: 4, bait: "marauder", text: "Trick 4 Marauders into the Sump (keep it between you and them)", how: "Hit a Marauder with {fire} so the pack hunts you, then fly round so the Sump lies between you and them. They chase in a straight line and fall in. Stay outside the warning ring yourself." },
            { id: "bruin", type: "mine", keys: ["bruin", "opal"], text: "Consume the brown dwarf Bruin and the giant Opal" },
            { id: "clear", type: "clear", group: "marauders", text: "Clear the Bazaar of Marauders" },
        ],
        reward: { drift: 25 },
    },
    {
        id: "marches", name: "The Forge Marches", galaxy: "pyre", tier: 4, extent: 270,
        text: "The Ember Throne's border, where Forge Spires hang over red dwarfs and drink them hollow.",
        edict: "THE THRONE SPEAKS: These stars are fuel for the Regent. You are kindling. Burn.",
        bodies: [
            { key: "kiln", name: "Kiln", size: 1.9, at: [-60, 0, 110], kind: "star", look: "redDwarf" },
            { key: "brand", name: "Brand", size: 2.6, at: [70, 14, 150], kind: "star", look: "redDwarf" },
            { key: "ashen", name: "Ashen", size: 3.3, at: [0, -20, 210], kind: "star", look: "orange" },
            MOTES([0, 0, 30], 34, 30),
            { count: 60, size: [0.14, 0.46], cloud: { center: [0, 0, 120], radius: 100 } },
            { count: 12, size: [0.75, 1.3], cloud: { center: [0, 0, 130], radius: 110 } },
        ],
        creatures: [
            { key: "spire1", species: "spire", near: "kiln", spread: 7, group: "spires", name: "Spire of Kiln" },
            { key: "spire2", species: "spire", near: "brand", spread: 8, group: "spires", name: "Spire of Brand" },
            { key: "spire3", species: "spire", near: "ashen", spread: 9, group: "spires", name: "Spire of Ashen" },
            { species: "quill", count: 8, at: [0, 0, 100], spread: 30, group: "legion" },
            { species: "pyre", count: 4, at: [20, 0, 160], spread: 26, group: "legion" },
            { species: "warden", count: 3, at: [-30, 10, 40], spread: 10 },
            { species: "prism", count: 3, at: [-20, 0, 130], spread: 24, group: "legion" },
        ],
        goals: [
            { id: "spires", type: "clear", group: "spires", text: "Break the three Forge Spires" },
            { id: "stars", type: "mine", keys: ["kiln", "brand"], text: "Consume the red dwarfs Kiln and Brand" },
            { id: "legion", type: "clear", group: "legion", text: "Clear the Marches of the Ember legion" },
            { id: "ashen", type: "mine", keys: ["ashen"], text: "Consume the orange star Ashen", optional: true },
        ],
        reward: { concord: 15, ember: -15, synod: 10 },
    },
    {
        id: "cinders", name: "The Throne of Cinders", galaxy: "pyre", tier: 5, extent: 280,
        text: "The Pyre Regent's own sun, and the Regent coiled around it.",
        edict: "I AM THE PYRE REGENT. I have burned ten thousand clouds to light this throne. Come and be the next.",
        bodies: [
            { key: "throne", name: "the Throne Star", size: 3.6, at: [0, 0, 170], kind: "star", look: "yellow" },
            { key: "vassal", name: "Vassal", size: 2.2, at: [-90, 10, 120], kind: "star", look: "orange" },
            { key: "slag", name: "Slag", size: 2.4, at: [84, -14, 110], kind: "star", look: "redDwarf" },
            MOTES([0, 0, 30], 34, 30),
            { count: 60, size: [0.14, 0.46], belt: { around: "throne", r: [12, 30], thick: 3, tilt: 0.25 } },
            { count: 12, size: [0.75, 1.3], cloud: { center: [0, 0, 120], radius: 110 } },
        ],
        creatures: [
            { key: "regent", species: "leviathan", faction: "ember", name: "the Pyre Regent", boss: 1.25, near: "throne", spread: 12, group: "court" },
            { species: "pyre", count: 3, near: "throne", spread: 22, group: "court" },
            { species: "quill", count: 6, at: [0, 0, 90], spread: 30, group: "court" },
            { species: "spire", count: 2, near: "vassal", spread: 9, group: "court" },
            { species: "prism", count: 2, near: "throne", spread: 26, group: "court" },
        ],
        goals: [
            { id: "vassals", type: "mine", keys: ["vassal", "slag"], text: "Consume the vassal stars Vassal and Slag (grow before you face the Regent)" },
            { id: "regent", type: "defeat", key: "regent", text: "Depose the Pyre Regent" },
            { id: "court", type: "clear", group: "court", text: "Clear the Throne of its court" },
            { id: "throne", type: "mine", keys: ["throne"], text: "Consume the Throne Star" },
        ],
        reward: { concord: 20, synod: 15, drift: 10, ember: 25 },
    },
    {
        id: "choir", name: "The Choir Deeps", galaxy: "still", tier: 6, extent: 290,
        text: "Medusae drift here in their thousands, singing to a wandering black hole they call the Cantor.",
        edict: "The Synod sings: the Cantor has strayed from its deep and devours our choirs. It hunts the greatest mass it can feel. Lead it to the Rift, and the Silence will remember you.",
        bodies: [
            { key: "psalm", name: "Psalm", size: 2.8, at: [-80, 10, 100], kind: "star", look: "white" },
            { key: "vesper", name: "Vesper", size: 3.4, at: [86, -10, 150], kind: "star", look: "blue" },
            MOTES([0, 0, 30], 34, 30),
            { count: 60, size: [0.14, 0.46], cloud: { center: [0, 0, 120], radius: 110 } },
            { count: 12, size: [0.75, 1.3], cloud: { center: [0, 0, 130], radius: 110 } },
        ],
        creatures: [
            { species: "medusa", count: 12, at: [-20, 0, 70], spread: 30 },
            { species: "cantor", count: 3, at: [-30, 6, 60], spread: 16 },
            { key: "envoy", species: "envoy", faction: "synod", name: "Mother of Tides", at: [-12, 4, 44] },
            { species: "thrall", count: 7, at: [30, 0, 190], spread: 26, group: "husks" },
            { species: "rival", count: 2, at: [90, 0, 80], spread: 20, group: "husks" },
            { species: "wraith", count: 3, at: [40, 0, 170], spread: 24, group: "husks" },
        ],
        holes: [{ key: "cantor", name: "the Cantor", at: [20, 0, 150], size: 2.2, hunts: 1.15 }],
        rift: { at: [-10, 30, 250], size: 7 },
        goals: [
            { id: "lure", type: "lure", hole: "cantor", to: "rift", text: "Lure the Cantor into the Rift (it follows mass: yours, or what you Shed)", how: "The Cantor drifts toward the biggest mass it feels: you. Let it come, then fly past the Rift (marked) so the Rift is between you and it; it follows you in. {decoy} sheds a knot of mass it will chase instead." },
            { id: "husks", type: "clear", group: "husks", text: "Clear the Deeps of Thralls and rivals" },
            { id: "stars", type: "mine", keys: ["psalm", "vesper"], text: "Consume the stars Psalm and Vesper" },
        ],
        reward: { synod: 30, hollow: -10 },
    },
    {
        id: "drowned", name: "The Drowned Suns", galaxy: "still", tier: 7, extent: 300,
        text: "Two black holes circle a field of blue giants. The Synod calls it a hymn. It is a slow catastrophe.",
        edict: "The Synod warns: Dirge hunts. Knell waits. Should they ever meet, the wave would scour this sea clean. We do not ask you to do this. We only say it.",
        bodies: [
            { key: "azure", name: "Azure", size: 3, at: [-90, 0, 110], kind: "star", look: "blue" },
            { key: "cobalt", name: "Cobalt", size: 3.6, at: [90, 16, 120], kind: "star", look: "blue" },
            { key: "pale", name: "Pale", size: 2.4, at: [0, -30, 60], kind: "star", look: "white" },
            MOTES([0, 0, 30], 34, 30),
            { count: 70, size: [0.14, 0.46], cloud: { center: [0, 0, 130], radius: 120 } },
            { count: 12, size: [0.75, 1.3], cloud: { center: [0, 0, 130], radius: 120 } },
        ],
        creatures: [
            { species: "thrall", count: 12, at: [0, 0, 190], spread: 40, group: "tide" },
            { species: "rival", count: 3, at: [-40, 0, 170], spread: 30, group: "tide" },
            { species: "medusa", count: 8, at: [-50, 10, 50], spread: 20 },
            { species: "leviathan", count: 2, at: [110, 30, 210], spread: 30 },
            { species: "splitter", count: 4, at: [-20, 0, 150], spread: 30, group: "tide" },
            { species: "wraith", count: 2, at: [20, 0, 200], spread: 30, group: "tide" },
        ],
        holes: [
            { key: "dirge", name: "Dirge", at: [-50, 0, 210], size: 2.4, hunts: 1.2 },
            { key: "knell", name: "Knell", at: [60, 0, 230], size: 3.2 },
        ],
        goals: [
            { id: "merge", type: "lure", hole: "dirge", to: "knell", text: "Lead Dirge into Knell and let them merge", how: "Dirge hunts you; Knell stays put. Fly round to the far side of Knell and wait: Dirge comes straight at you, through Knell, and the two become one. Back away from the wave." },
            { id: "tide", type: "clear", group: "tide", text: "Clear the Drowned Suns of the Hollow's tide" },
            { id: "stars", type: "mine", keys: ["azure", "cobalt"], text: "Consume the blue giants Azure and Cobalt" },
        ],
        reward: { synod: 20, concord: 10, hollow: -15 },
    },
    {
        id: "wake", name: "Regent's Wake", galaxy: "crownless", tier: 8, extent: 310,
        text: "With the Regent gone, every rival cloud in five galaxies has come to claim the crown.",
        edict: "TO ALL WHO SHINE: the Expanse has no ruler. The largest cloud left standing may call itself one.",
        bodies: [
            { key: "gilt", name: "Gilt", size: 3.2, at: [-80, 10, 120], kind: "star", look: "orange" },
            { key: "argent", name: "Argent", size: 3.8, at: [80, -10, 160], kind: "star", look: "blue" },
            { key: "regal", name: "Regal", size: 2.6, at: [0, 30, 220], kind: "star", look: "orange" },
            MOTES([0, 0, 30], 34, 30),
            { count: 70, size: [0.14, 0.46], cloud: { center: [0, 0, 130], radius: 120 } },
            { count: 12, size: [0.75, 1.3], cloud: { center: [0, 0, 130], radius: 120 } },
        ],
        creatures: [
            { key: "ysolde", species: "rival", name: "Ysolde the Bright", boss: 1.5, near: "gilt", spread: 16, group: "claimants" },
            { key: "morn", species: "rival", name: "Morn of the Long Dark", boss: 1.7, near: "argent", spread: 16, group: "claimants" },
            { key: "tessaly", species: "rival", name: "Tessaly Twice-Born", boss: 1.4, near: "regal", spread: 16, group: "claimants" },
            { species: "rival", count: 5, at: [0, 0, 150], spread: 60, group: "claimants" },
            { species: "marauder", count: 8, at: [0, 0, 100], spread: 50, group: "claimants" },
            { species: "warden", count: 4, at: [-20, 10, 40], spread: 14 },
            { species: "lurker", count: 4, at: [0, 0, 130], spread: 60, group: "claimants" },
            { species: "splitter", count: 3, at: [40, 0, 180], spread: 40, group: "claimants" },
        ],
        goals: [
            { id: "claimants", type: "clear", group: "claimants", text: "Leave no other claimant standing" },
            { id: "stars", type: "mine", keys: ["gilt", "argent"], text: "Consume the giants Gilt and Argent" },
            { id: "regal", type: "mine", keys: ["regal"], text: "Consume the star Regal", optional: true },
        ],
        reward: { concord: 15, drift: 15, synod: 10 },
    },
    {
        id: "parliament", name: "The Parliament of Lights", galaxy: "crownless", tier: 9, extent: 300,
        text: "Four envoys, four governments, one question: who stands with the cloud that would be Monarch?",
        edict: "The Parliament is convened. Offer tribute, keep the laws, and be Favoured by three of us - and we will fold with you into the Hollow.",
        bodies: [
            { key: "forum", name: "Forum", size: 3.4, at: [0, 0, 150], kind: "star", look: "white" },
            { key: "tithe", name: "Tithe", size: 2.8, at: [-110, 0, 200], kind: "star", look: "orange" },
            { key: "levy", name: "Levy", size: 3, at: [110, 0, 200], kind: "star", look: "blue" },
            MOTES([0, 0, 30], 34, 30),
            { count: 80, size: [0.14, 0.46], belt: { around: "forum", r: [14, 40], thick: 3, tilt: 0.1 } },
            { count: 14, size: [0.75, 1.3], cloud: { center: [0, 0, 150], radius: 130 } },
        ],
        creatures: [
            { key: "envoy-concord", species: "envoy", faction: "concord", name: "Speaker Lumen", at: [-30, 8, 100] },
            { key: "envoy-drift", species: "envoy", faction: "drift", name: "Speaker Osk", at: [30, 8, 100] },
            { key: "envoy-synod", species: "envoy", faction: "synod", name: "Speaker of Tides", at: [-30, -8, 200] },
            { key: "envoy-ember", species: "envoy", faction: "ember", name: "the Regent's Heir", at: [30, -8, 200] },
            { species: "warden", count: 3, at: [-34, 8, 96], spread: 8 },
            { species: "drifter", count: 4, at: [34, 8, 96], spread: 8 },
            { species: "cantor", count: 3, at: [-34, -8, 204], spread: 8 },
            { species: "pyre", count: 3, at: [34, -8, 204], spread: 8 },
            { species: "thrall", count: 12, at: [0, 30, 260], spread: 40, group: "assassins" },
            { species: "wraith", count: 4, at: [0, 20, 240], spread: 30, group: "assassins" },
        ],
        goals: [
            { id: "standing", type: "standing", factions: 3, text: "Be Favoured by three governments (tribute near an envoy)", how: "Fly to each envoy (marked) and press {tribute}: each gift is a twentieth of your mass and +12 standing. Favoured is 25. Don't break their laws." },
            { id: "assassins", type: "clear", group: "assassins", text: "Destroy the Hollow's assassins" },
            { id: "stars", type: "mine", keys: ["tithe", "levy"], text: "Consume the stars Tithe and Levy" },
        ],
        reward: { concord: 10, drift: 10, synod: 10, ember: 10 },
    },
    {
        id: "shallows", name: "The Event Shallows", galaxy: "hollow", tier: 10, extent: 320,
        text: "The outer court of the Hollow: dying supergiants, and horizons between them like reefs.",
        edict: "the hollow court does not speak. it only listens. you are very loud.",
        bodies: [
            { key: "rust", name: "Rust", size: 3.4, at: [-90, 0, 130], kind: "star", look: "redGiant" },
            { key: "garnet", name: "Garnet", size: 4, at: [90, 10, 190], kind: "star", look: "redGiant" },
            MOTES([0, 0, 30], 34, 30),
            { count: 80, size: [0.14, 0.46], cloud: { center: [0, 0, 140], radius: 130 } },
            { count: 14, size: [0.75, 1.3], cloud: { center: [0, 0, 150], radius: 130 } },
        ],
        creatures: [
            { species: "thrall", count: 16, at: [0, 0, 170], spread: 60, group: "court" },
            { key: "seneschal", species: "thrall", name: "the Seneschal", boss: 2.2, at: [0, 10, 240], group: "court" },
            { species: "rival", count: 3, faction: "hollow", at: [40, 0, 120], spread: 30, group: "court" },
            { species: "wraith", count: 4, at: [-20, 0, 200], spread: 40, group: "court" },
        ],
        holes: [
            { key: "reef1", name: "the First Reef", at: [-30, 0, 120], size: 2 },
            { key: "reef2", name: "the Second Reef", at: [40, -10, 200], size: 2.6 },
            { key: "reef3", name: "the Third Reef", at: [-60, 14, 250], size: 1.8, hunts: 0.9 },
        ],
        goals: [
            { id: "seneschal", type: "defeat", key: "seneschal", text: "Destroy the Seneschal of the Hollow Court" },
            { id: "court", type: "clear", group: "court", text: "Clear the Shallows of the outer court" },
            { id: "feed", type: "feed", hole: "reef2", count: 5, bait: "thrall", text: "Send 5 Thralls back across the Second Reef's horizon", how: "Thralls hunt you in straight lines. Fly so the Second Reef lies between you and them, and they fall across its horizon." },
            { id: "stars", type: "mine", keys: ["rust", "garnet"], text: "Consume the red supergiants Rust and Garnet" },
        ],
        reward: { concord: 10, synod: 10, drift: 10 },
    },
    {
        id: "throne", name: "The Quiet Throne", galaxy: "hollow", tier: 11, extent: 340,
        text: "The Hollow King: a living black hole, fed by three anchored hypergiants. It cannot be eaten. It can be starved, and it can be fooled.",
        edict: "...",
        bodies: [
            { key: "anchor1", name: "the First Anchor", size: 3.2, at: [-110, 0, 170], kind: "star", look: "redGiant" },
            { key: "anchor2", name: "the Second Anchor", size: 3.6, at: [110, 0, 170], kind: "star", look: "blue" },
            { key: "anchor3", name: "the Third Anchor", size: 4.2, at: [0, 40, 300], kind: "star", look: "redGiant" },
            MOTES([0, 0, 30], 34, 30),
            { count: 80, size: [0.14, 0.46], cloud: { center: [0, 0, 150], radius: 130 } },
            { count: 14, size: [0.75, 1.3], cloud: { center: [0, 0, 150], radius: 130 } },
        ],
        creatures: [
            { species: "thrall", count: 10, at: [0, 0, 150], spread: 60, group: "husks" },
            { species: "wraith", count: 3, at: [0, 10, 230], spread: 40, group: "husks" },
        ],
        holes: [{ key: "king", name: "the Hollow King", at: [0, 0, 210], size: 5, hunts: 0.8 }],
        rift: { at: [0, -40, 60], size: 12 },
        spawner: { hole: "king", species: "thrall", every: 16, cap: 8 },
        goals: [
            { id: "anchors", type: "mine", keys: ["anchor1", "anchor2", "anchor3"], text: "Consume the three Anchor stars that feed the King" },
            { id: "king", type: "lure", hole: "king", to: "rift", after: ["anchors"], text: "Starved, the King will follow any mass: lead it into the White Rift", how: "With its Anchors gone the Rift opens. The King hunts the biggest mass near it and ignores what you Shed: let it follow you, then pass the White Rift so it lies between you and the King." },
        ],
        reward: { concord: 40, drift: 40, synod: 40, ember: 40 },
    },
];

export const regionById = (id: string): RegionDef => {
    const r = REGIONS.find(x => x.id === id);
    if (!r) throw new Error(`No region ${id}`);
    return r;
};
export const galaxyById = (id: string): Galaxy => {
    const g = GALAXIES.find(x => x.id === id);
    if (!g) throw new Error(`No galaxy ${id}`);
    return g;
};

/** A message in a tongue not yet learned: `fluency` 0..1 of its letters come through. */
export function garble(text: string, fluency: number, seed: number): string {
    if (fluency >= 1) return text;
    const glyphs = "~^*:=+<>|/\\";
    let out = "";
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === " " || ch === "." || ch === ",") { out += ch; continue; }
        const h = Math.abs(Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453) % 1;
        out += h < fluency ? ch : glyphs[Math.floor(h * 997) % glyphs.length];
    }
    return out;
}

// --- Blasts: what {fire} throws ---------------------------------------------------------------------

export type BlastId = "lance" | "shard" | "beam" | "seeker";
export interface Blast { id: BlastId; name: string; level: number; cost: number; cooldown: number; text: string; color: RGB }
export const BLASTS: Record<BlastId, Blast> = {
    lance: { id: "lance", name: "Lance", level: 1, cost: 4, cooldown: 0.22, color: [0.9, 0.97, 1], text: "One quick, far-reaching bolt that finds what is under the reticle." },
    shard: { id: "shard", name: "Shardfall", level: 2, cost: 8, cooldown: 0.55, color: [0.6, 1, 0.75], text: "A close spray of seven shards: deadly near, useless far. Shreds packs and Splitters." },
    beam: { id: "beam", name: "Sunthread", level: 5, cost: 18, cooldown: 0, color: [1, 0.85, 0.45], text: "Hold for a continuous ray that burns the first thing it touches. Drinks charge fast; glass cannot turn it." },
    seeker: { id: "seeker", name: "Seekers", level: 8, cost: 12, cooldown: 1, color: [0.85, 0.6, 1], text: "Three slow motes of light that hunt the nearest enemy on their own. Fire and keep flying." },
};
export const BLAST_IDS = Object.keys(BLASTS) as BlastId[];

// --- Forms: the kind of nebula you become ---------------------------------------------------------

/** The level a nebula is wide enough to choose its form at. */
export const FORM_LEVEL = 7;
export type FormId = "emission" | "reflection" | "dark" | "planetary";
export interface Form { id: FormId; name: string; text: string; perks: string[]; palette: { core: RGB; mid: RGB; edge: RGB } }
export const FORMS: Record<FormId, Form> = {
    emission: {
        id: "emission", name: "Emission Nebula", text: "Hot gas lit from within: you burn.",
        perks: ["+20% damage from every blast", "Starfire recharges 30% sooner", "Siphoning a star fills your charge"],
        palette: { core: [1, 0.92, 0.85], mid: [1, 0.3, 0.42], edge: [0.85, 0.12, 0.35] },
    },
    reflection: {
        id: "reflection", name: "Reflection Nebula", text: "Cold dust that throws back the light of others.",
        perks: ["+15% cohesion", "A quarter of the bolts that strike you are turned back on whoever threw them"],
        palette: { core: [0.88, 0.95, 1], mid: [0.3, 0.55, 1], edge: [0.2, 0.3, 0.85] },
    },
    dark: {
        id: "dark", name: "Dark Nebula", text: "A cloud so thick it swallows light.",
        perks: ["The Veil costs less than half as much, and siphoning does not lift it", "Hunters see you from 20% less far", "Shed recharges twice as fast"],
        palette: { core: [0.75, 0.62, 0.55], mid: [0.32, 0.18, 0.22], edge: [0.14, 0.08, 0.16] },
    },
    planetary: {
        id: "planetary", name: "Planetary Nebula", text: "The bright shell of a dying star's breath.",
        perks: ["The Pulse reaches 40% farther and knits 10 cohesion", "Motes and essence fall to you from 50% farther"],
        palette: { core: [0.85, 1, 0.95], mid: [0.2, 0.95, 0.75], edge: [0.15, 0.55, 0.95] },
    },
};
export const FORM_IDS = Object.keys(FORMS) as FormId[];

// --- Grace and Ruin --------------------------------------------------------------------------------

/** Where your deeds have left you, from -100 (Ruin) to 100 (Grace). */
export function alignmentTier(a: number): string {
    if (a >= 60) return "Radiant";
    if (a >= 20) return "Gracious";
    if (a > -20) return "Unshaped";
    if (a > -60) return "Shadowed";
    return "Ruinous";
}
/** What Grace and Ruin give: cohesion knits faster with Grace, blasts bite harder with Ruin. */
export const graceKnit = (a: number): number => 1 + Math.max(0, a) / 100 * 0.8;
export const ruinDamage = (a: number): number => 1 + Math.max(0, -a) / 100 * 0.25;

// --- Controls: the names a lesson uses, for whichever device you hold -------------------------------

export type Device = "keys" | "pad";
export const BINDINGS: Record<string, { keys: string; pad: string; what: string }> = {
    steer: { keys: "MOUSE / ARROWS", pad: "RIGHT STICK", what: "Steer" },
    move: { keys: "W A S D", pad: "LEFT STICK", what: "Fly and strafe" },
    rise: { keys: "SPACE", pad: "A", what: "Rise" },
    sink: { keys: "CTRL", pad: "B", what: "Sink" },
    stride: { keys: "SHIFT", pad: "LT or L3", what: "Lightstride (fly fast)" },
    fire: { keys: "LEFT MOUSE", pad: "RT", what: "Fire your blast" },
    blast: { keys: "1-4 or WHEEL", pad: "LB / RB", what: "Change blast" },
    siphon: { keys: "E", pad: "X", what: "Siphon a world or star" },
    pulse: { keys: "Q", pad: "R3", what: "Pulse" },
    flare: { keys: "R", pad: "Y", what: "Starfire" },
    attune: { keys: "T", pad: "D-PAD UP", what: "Attune (see lightwaves)" },
    veil: { keys: "C", pad: "D-PAD DOWN", what: "Veil" },
    decoy: { keys: "F", pad: "D-PAD LEFT", what: "Shed" },
    tribute: { keys: "G", pad: "D-PAD RIGHT", what: "Tribute / spare" },
    chart: { keys: "M", pad: "START", what: "Star Chart (fold)" },
    codex: { keys: "TAB", pad: "BACK", what: "Codex (facets, form)" },
    guide: { keys: "H", pad: "HOLD BACK", what: "Field Guide (next tip)" },
};
/** The key or button for a control, as a lesson shows it. */
export const bindingOf = (id: string, device: Device): string => BINDINGS[id] ? BINDINGS[id][device] : id.toUpperCase();
/** Replaces {control} in a lesson with its key or button, and {name}-style values from `vars`. */
export function controlText(text: string, device: Device, vars: Record<string, string> = {}): string {
    return text.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? vars[k] : BINDINGS[k] ? `[${BINDINGS[k][device]}]` : `{${k}}`));
}

// --- The Field Guide --------------------------------------------------------------------------------

export interface Lesson { title: string; text: string }
/** Every new thing the game asks of you, explained the first time you meet it. */
export const LESSONS: Record<string, Lesson> = {
    fly: { title: "FLYING", text: "{steer} to turn, {move} to fly. {rise} and {sink} to climb and dive. Hold {stride} to Lightstride: the longer you hold it, the faster you go." },
    feed: { title: "FEEDING", text: "You grow by eating. Fly into motes and any rubble less than half your size; motes drift to you from close by." },
    siphon: { title: "SIPHONING", text: "Worlds too big to swallow are drunk. Come close, put the reticle on one, and hold {siphon}. The reticle says when you are in reach." },
    combat: { title: "FIGHTING", text: "Red names are hostile. {fire} throws your blast at whatever is under the reticle; it costs charge, which refills on its own. Cohesion is your life." },
    blasts: { title: "BLASTS", text: "You know more than one blast now: {blast} to choose. Each suits a different foe - the Codex {codex} says which." },
    "blast:shard": { title: "SHARDFALL", text: "A close spray of seven shards. Get near, then {fire}: it shreds packs and Splitters, but is useless at range." },
    "blast:beam": { title: "SUNTHREAD", text: "Hold {fire} for a continuous ray that burns the first thing it touches. It drinks charge fast, and glass cannot turn it back." },
    "blast:seeker": { title: "SEEKERS", text: "{fire} looses three motes that hunt the nearest enemy on their own. Good when foes are fast, or behind you." },
    "ability:pulse": { title: "THE PULSE", text: "{pulse} throws a shell of light: it strikes and throws back everything hostile near you, and blows away incoming bolts." },
    "ability:veil": { title: "THE VEIL", text: "{veil} goes dark: hunters see you from a quarter as far. It drinks charge, and acting (firing, siphoning, striding) lifts it." },
    "ability:decoy": { title: "SHED", text: "{decoy} casts off a knot of your own mass behind you. Hunters chase it, and wandering black holes prefer it to you." },
    "ability:flare": { title: "STARFIRE", text: "{flare} pours out the light of the stars you have eaten in a long burning cone ahead of you. Aim, then press it." },
    "goal:absorb": { title: "GATHERING", text: "Motes are the bright specks of light. Fly through them; they fall to you from close by." },
    "goal:mine": { title: "MINING A WORLD", text: "Fly to the marked world, aim at it and hold {siphon} until nothing is left. Bigger worlds take longer; grow first if one is slow." },
    "goal:clear": { title: "CLEARING A REGION", text: "Destroy every creature of the group: the nearest is marked. Use {fire}, and {pulse} when they swarm you." },
    "goal:defeat": { title: "A CHAMPION", text: "A named foe, much stronger than its kind. Wear it down from range; when it yields you will have a choice to make." },
    "goal:defend": { title: "DEFENDING", text: "Raiders come in waves for the creatures you protect. Meet each wave (marked RAIDERS) before it arrives, and break it." },
    "goal:feed": { title: "TRICKING HUNTERS", text: "Hunters fly straight at you and never look where they are going. Get them chasing you, then keep the black hole between you and them: they fall in." },
    "goal:lure": { title: "LEADING A BLACK HOLE", text: "A wandering hole drifts toward the biggest mass it feels. Let it see you, then fly so its destination lies between you and it, and keep ahead." },
    "goal:sling": { title: "SLINGSHOT", text: "Dip fast into a black hole's ergosphere - the ring where the warning shows - and fly out the far side. It flings you on, faster. Never touch the core." },
    "goal:standing": { title: "STANDING", text: "Governments judge you by tribute, by the laws you keep and by whom you kill. Press {tribute} beside an envoy to give a twentieth of your mass." },
    "goal:tribute": { title: "TRIBUTE", text: "Fly close to an envoy and press {tribute} to give a twentieth of your mass for their favour." },
    facets: { title: "FACET POINTS", text: "Every level gives you a facet point. Open the Codex {codex} and spend it on Density, Radiance, Reach and more." },
    hole: { title: "BLACK HOLES", text: "A black hole cannot be eaten. Its pull grows steeply as you near, and its horizon tears a third of you away. No lightwave crosses its shadow." },
    star: { title: "STARS FLARE", text: "A star throws flares while you siphon it. When FLARE flashes on screen, hold {stride} to ride through it unhurt." },
    law: { title: "LIVING WORLDS", text: "Worlds that 'carry life' are under a government's law. Feeding on one is a crime, and a deed of Ruin: its soldiers will hunt you." },
    lightwaves: { title: "LIGHTWAVES", text: "Creatures speak in light; what reaches you is shown at the right. {attune} lets you see the waves. Foreign tongues come clear as you listen." },
    fold: { title: "FOLDING", text: "This region is yours. Open the Star Chart {chart} and choose the next region to fold there - in a moment, in any galaxy." },
    forms: { title: "CHOOSE YOUR FORM", text: "You are wide enough to choose what kind of nebula you are: Emission, Reflection, Dark or Planetary. Open the Codex {codex} to choose." },
    yield: { title: "MERCY OR HUNGER", text: "{name} yields. Press {tribute} near it to spare it (Grace) - or strike it again to devour it (Ruin). Either way the fight is won." },
    deeds: { title: "GRACE AND RUIN", text: "What you do shapes what you become. Mercy, tribute and defending the weak bring Grace; crimes and devouring bring Ruin. Your light shows which." },
    dispersed: { title: "COHESION", text: "Cohesion only knits while you are fed and unhurt for a few seconds. Keep eating, keep moving, and Pulse what crowds you." },
    affix: { title: "VARIANTS", text: "Some hunters are Swift, Armoured, Volatile or Vampiric: the first word of the name says which. Never finish a Volatile one up close." },
    "species:lurker": { title: "LURKERS", text: "Lurkers hide until you are close. {attune} shows them, and the Pulse {pulse} flushes them out." },
    "species:splitter": { title: "SPLITTERS", text: "Splitters burst into two smaller ones when broken. Shardfall ({blast} to switch) catches both halves at once." },
    "species:prism": { title: "GLASS SENTINELS", text: "Glass turns the Lance and Seekers straight back at you. Use Sunthread or Shardfall ({blast}), the Pulse, or Starfire." },
    "species:wraith": { title: "HOLLOW WRAITHS", text: "Wraiths fold space to appear beside you, then sting. Keep moving, and Pulse {pulse} them away when they land." },
};

/** How to do a goal of each type, shown beneath it (a goal's own `how` comes first). */
export const GOAL_HOW: Record<string, string> = {
    absorb: "Fly through the bright motes; they drift to you from close by.",
    mine: "Fly to the marked world, aim at it and hold {siphon} until it is gone.",
    clear: "Hunt them down with {fire}; the nearest is marked. {pulse} when they crowd you.",
    defeat: "Wear the marked champion down with {fire}. When it yields: {tribute} to spare, or strike to devour.",
    defend: "Meet each raiding wave (marked) and break it before it reaches the shoal.",
    feed: "Get them chasing you, then keep the black hole between you and them.",
    lure: "Let the hole follow you, and keep its destination between you and it.",
    sling: "Fly fast into the ergosphere warning ring and out the far side; never the core.",
    standing: "Fly to the envoys and press {tribute}; keep their laws.",
    tribute: "Fly close to the envoy and press {tribute}.",
};
