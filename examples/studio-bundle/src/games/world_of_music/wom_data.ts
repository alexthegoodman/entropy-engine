// WORLD OF MUSIC - the rules and the content, pure data (no engine calls; tests read it).
//
// Agent Tom comes from the World of Color. The people of the World of Music see no color: they
// see music. So every scene is drawn in black, white and grey, and color is a language only Tom
// (and the player) can read. A color always means one thing:
//
//   RED       the Red Corruption, and nothing else: corrupted creatures, hearts, veins.
//   MAGENTA   food: fruit that Tones eat to grow (and split).
//   AMBER     treasure: relics to sell at a stall for chimes.
//   TEAL      mechanisms: switches, levers, gates, portals, climbable walls.
//   A Tone's own hue (azure, lemon, lime, violet): that Tone and the music it makes.
//   WHITE     the music of the world's own people: silver pulses from their instruments.
//
// Color never "restores" - that is the art direction, not a reward.

import type { V3 } from "../nebula/nk_math";

export type RGB = [number, number, number];

export const PALETTE = {
    red: [0.95, 0.06, 0.09] as RGB,
    redDeep: [0.5, 0.01, 0.03] as RGB,
    fruit: [1.0, 0.12, 0.62] as RGB,
    relic: [1.0, 0.66, 0.08] as RGB,
    mech: [0.05, 0.92, 0.82] as RGB,
    silver: [0.92, 0.95, 1.0] as RGB,
    link: [0.55, 0.85, 1.0] as RGB,
};

/** What a color means, for the Field Guide and the title card. */
export const COLOR_LANGUAGE: { color: RGB; name: string; meaning: string }[] = [
    { color: PALETTE.red, name: "Red", meaning: "The Red Corruption. Only evil is ever red." },
    { color: PALETTE.fruit, name: "Magenta", meaning: "Fruit. Feed it to Tones and they grow, then split in two." },
    { color: PALETTE.relic, name: "Amber", meaning: "Relics. Sell them at Bodhi's stall for chimes." },
    { color: PALETTE.mech, name: "Teal", meaning: "Mechanisms: switches, levers, gates, portals, climbing walls." },
    { color: PALETTE.silver, name: "White light", meaning: "The music of the people here. It is how they see." },
];

// --- Tones ----------------------------------------------------------------------------------

/** What a Tone can do. Species give one or two; the stall sells the rest, per swarm. */
export type TraitId = "brawn" | "blaster" | "claws" | "wings" | "phase" | "heft" | "resonance" | "tempo" | "harmony";

export interface TraitDef { id: TraitId; name: string; text: string; cost: number; max: number }

export const TRAITS: Record<TraitId, TraitDef> = {
    brawn: { id: "brawn", name: "Brawn", text: "Strikes hard up close and breaks crates fast.", cost: 40, max: 1 },
    blaster: { id: "blaster", name: "Blaster", text: "Fires bolts of its own note from ten metres.", cost: 60, max: 1 },
    claws: { id: "claws", name: "Climbing Claws", text: "Scales teal-marked cliffs that nothing else can.", cost: 70, max: 1 },
    wings: { id: "wings", name: "Wings", text: "Flies over water and hops low ledges.", cost: 80, max: 1 },
    phase: { id: "phase", name: "Phase", text: "Slips through teal portals to the paired ring.", cost: 90, max: 1 },
    heft: { id: "heft", name: "Heft", text: "Each Tone weighs two on a switch plate.", cost: 35, max: 1 },
    resonance: { id: "resonance", name: "Resonance", text: "+40% damage per rank.", cost: 45, max: 3 },
    tempo: { id: "tempo", name: "Tempo", text: "+20% speed per rank.", cost: 30, max: 2 },
    harmony: { id: "harmony", name: "Harmony", text: "+50% purifying song per rank.", cost: 40, max: 3 },
};
export const TRAIT_IDS = Object.keys(TRAITS) as TraitId[];

export type SpeciesId = "thrum" | "zing" | "hop" | "lull";

export interface SpeciesDef {
    id: SpeciesId; name: string; color: RGB; text: string;
    traits: TraitId[];
    hp: number; speed: number; damage: number;
    /** Scale (MIDI) the Tone sings in as it explores, and its timbre. */
    voice: { notes: number[]; wave: "sine" | "triangle" | "square" | "saw"; chirp: number };
    /** Body shape for the renderer: squat, round, tall, wispy. */
    shape: "squat" | "round" | "tall" | "wisp";
}

export const SPECIES: Record<SpeciesId, SpeciesDef> = {
    thrum: { id: "thrum", name: "Thrum", color: [0.12, 0.45, 1.0], text: "Azure bass-Tones: sturdy, heavy, they hit hard up close.", traits: ["brawn"], hp: 34, speed: 6.2, damage: 7, voice: { notes: [43, 46, 48, 50, 53], wave: "triangle", chirp: 0.6 }, shape: "squat" },
    zing: { id: "zing", name: "Zing", color: [1.0, 0.93, 0.1], text: "Lemon treble-Tones: quick, fragile, born with a blaster.", traits: ["blaster"], hp: 20, speed: 7.4, damage: 4, voice: { notes: [76, 79, 81, 83, 86], wave: "square", chirp: 1.4 }, shape: "round" },
    hop: { id: "hop", name: "Hop", color: [0.42, 1.0, 0.18], text: "Lime alto-Tones with claws: they climb teal cliffs.", traits: ["claws"], hp: 24, speed: 6.8, damage: 4.5, voice: { notes: [64, 67, 69, 71, 74], wave: "sine", chirp: 1.0 }, shape: "tall" },
    lull: { id: "lull", name: "Lull", color: [0.66, 0.3, 1.0], text: "Violet drone-Tones that phase through portals and drift on wings.", traits: ["phase", "wings"], hp: 22, speed: 6.6, damage: 4, voice: { notes: [57, 60, 62, 64, 67], wave: "sine", chirp: 0.4 }, shape: "wisp" },
};
export const SPECIES_IDS = Object.keys(SPECIES) as SpeciesId[];

/** Fruit a Tone eats before it splits into two. */
export const SPLIT_AT = 3;
export const MAX_SWARM = 12;
export const MAX_SWARMS = 8;
/** Seconds a fallen Tone can be revived (walk Tom over it, or send its swarm) before it passes. */
export const REVIVE_WINDOW = 20;
export const REVIVE_TIME = 1.0;
/** Purifying song per Tone per second (before Harmony). */
export const PURIFY_RATE = 1.0;

export interface ToneStats { hp: number; speed: number; damage: number; range: number; purify: number; weight: number; climb: boolean; fly: boolean; phase: boolean; ranged: boolean }

/** A Tone's numbers from its species and its swarm's trait ranks. */
export function toneStats(species: SpeciesId, traits: Partial<Record<TraitId, number>>): ToneStats {
    const s = SPECIES[species];
    const has = (t: TraitId) => (traits[t] ?? 0) > 0 || s.traits.includes(t);
    const ranged = has("blaster");
    return {
        hp: s.hp,
        speed: s.speed * (1 + 0.2 * (traits.tempo ?? 0)),
        damage: s.damage * (1 + 0.4 * (traits.resonance ?? 0)) * (has("brawn") ? 1.5 : 1),
        range: ranged ? 10 : 1.6,
        purify: PURIFY_RATE * (1 + 0.5 * (traits.harmony ?? 0)),
        weight: has("heft") ? 2 : 1,
        climb: has("claws"), fly: has("wings"), phase: has("phase"), ranged,
    };
}

/** Whether a swarm already has a trait (from its species or bought), and its rank. */
export function traitRank(species: SpeciesId, traits: Partial<Record<TraitId, number>>, t: TraitId): number {
    return Math.max(traits[t] ?? 0, SPECIES[species].traits.includes(t) ? 1 : 0);
}

/** Chimes for the next rank of a trait (null when maxed or innate and single-rank). */
export function traitPrice(species: SpeciesId, traits: Partial<Record<TraitId, number>>, t: TraitId): number | null {
    const rank = traitRank(species, traits, t), def = TRAITS[t];
    if (rank >= def.max) return null;
    return Math.round(def.cost * (1 + rank * 0.75));
}

// --- the Red Corruption ---------------------------------------------------------------------

export type EnemyId = "smudge" | "thornback" | "spitter";

export interface EnemyDef {
    id: EnemyId; name: string; text: string;
    /** Index of the WIR brain (wom_wir_data: 0 grunt, 1 rusher, 2 sniper). */
    brain: number;
    hp: number; damage: number; speed: number; size: number;
    /** Bolt speed (m/s); 0 for a melee lunge. */
    bolt: number;
}

export const ENEMIES: Record<EnemyId, EnemyDef> = {
    smudge: { id: "smudge", name: "Smudge", text: "A blot of corruption that keeps its distance and spits red. Thinks with the WIR grunt brain: it hides when hurt or empty.", brain: 0, hp: 30, damage: 6, speed: 4.2, size: 0.9, bolt: 14 },
    thornback: { id: "thornback", name: "Thornback", text: "A spined hound of rust. WIR rusher brain: fearless until nearly dead, it closes and bites.", brain: 1, hp: 44, damage: 9, speed: 6.0, size: 1.1, bolt: 0 },
    spitter: { id: "spitter", name: "Spitter", text: "A long-necked turret-thing. WIR sniper brain: it plants itself in cover and lobs from far away.", brain: 2, hp: 26, damage: 10, speed: 3.4, size: 1.0, bolt: 20 },
};

export interface BossDef { id: string; name: string; text: string; size: number; hp: number; anchors: number; slam: number; summon: EnemyId; color: RGB }
export const BOSSES: Record<string, BossDef> = {
    gloomtusk: { id: "gloomtusk", name: "Gloomtusk", text: "A boar the corruption hollowed out and filled with itself. Purify the three anchors that feed it, then strike its heart.", size: 6, hp: 420, anchors: 3, slam: 14, summon: "smudge", color: PALETTE.red },
    maw: { id: "maw", name: "The Red Maw", text: "The corruption's own throat, ten times your height. Silence its four anchors and every swarm you have must sing at its heart.", size: 10, hp: 900, anchors: 4, slam: 22, summon: "thornback", color: PALETTE.red },
};

// --- friends --------------------------------------------------------------------------------

export type NpcKind = "koala" | "owl" | "snake" | "crab" | "tortoise";
export type Instrument = "marimba" | "flute" | "handpan" | "drum" | "kalimba";

export interface NpcDef { kind: NpcKind; name: string; instrument: Instrument; role: "shop" | "jam" | "guide"; lines: string[] }

export const NPCS: Record<string, NpcDef> = {
    bodhi: { kind: "koala", name: "Bodhi", instrument: "marimba", role: "shop", lines: [
        "Oh! You walk like a tune I've never heard. I'm Bodhi. I trade.",
        "Relics hum, you know. Bring me the amber ones and I'll pay in chimes.",
        "Chimes buy your little Tones new tricks. Claws, wings, bigger voices.",
    ] },
    hoolu: { kind: "owl", name: "Hoolu", instrument: "flute", role: "jam", lines: [
        "Hoo. A stranger who plays nothing at all. Let us fix that.",
        "Answer my flute on your Prism Pipe, phrase for phrase.",
        "There. The Gathering Song. Play it and every swarm comes home.",
    ] },
    sisska: { kind: "snake", name: "Sisska", instrument: "handpan", role: "guide", lines: [
        "Ssso the sky-hole spat you out. The rings by the falls are old roads.",
        "Only a Tone that phases can walk a ring. Violet ones, mostly.",
        "Beyond the falls, the Caldera. The Maw sings loudest there.",
    ] },
    clatter: { kind: "crab", name: "Clatter", instrument: "drum", role: "jam", lines: [
        "Tak-tak! Keep time with me, Pipe-player!",
        "Ha! You've got rhythm for a colorless - er, colorful - whatever you are.",
    ] },
    moss: { kind: "tortoise", name: "Elder Moss", instrument: "kalimba", role: "guide", lines: [
        "I have watched the red come for three hundred songs.",
        "It cannot be fought where it is strong. Purify its anchors first.",
        "When the Maw falls, the islands will hear themselves again.",
    ] },
};

// --- the levels -----------------------------------------------------------------------------

/** A raised area: a disc (r) or a rectangle (w x d), `h` metres above the island, edged over `edge` metres (small = cliff). */
export interface Plateau {
    x: number; z: number; r?: number; w?: number; d?: number; h: number; edge: number; climb?: boolean;
    /** A ring wall: hollow inside `ri`, open over `gapW` metres of arc at angle `gap` (atan2(dz, dx)). */
    ri?: number; gap?: number; gapW?: number;
}
/** A walkable slope from `from` (low end) to `to` (high end), `w` wide. */
export interface Ramp { from: [number, number]; to: [number, number]; w: number }
export interface GateDef { id: string; x: number; z: number; len: number; angle: number }
export interface SwitchDef { id: string; x: number; z: number; weight: number; gate: string }
export interface LeverDef { id: string; x: number; z: number; gate: string }
export interface PortalDef { id: string; a: [number, number]; b: [number, number] }
export interface CrateDef { x: number; z: number; relics: number; fruit: number; big?: boolean }
export interface TreeDef { x: number; z: number; fruit: number }
export interface DarkDef {
    id: string; name: string; x: number; z: number; r: number;
    enemies: { kind: EnemyId; n: number }[];
    heart: number; relics: number;
    boss?: string;
    /** A wild swarm freed when it is purified. */
    frees?: SpeciesId;
}
export interface NpcPlace { id: string; x: number; z: number; face?: number }

export interface LevelDef {
    id: string; name: string; text: string; seed: number; size: number;
    spawn: [number, number];
    plateaus: Plateau[];
    ramps: Ramp[];
    /** Low areas carved below the island (lagoons, basins): disc, depth. */
    hollows: { x: number; z: number; r: number; depth: number }[];
    gates: GateDef[]; switches: SwitchDef[]; levers: LeverDef[]; portals: PortalDef[];
    crates: CrateDef[]; trees: TreeDef[]; dark: DarkDef[]; npcs: NpcPlace[];
    /** Where the song gate to the next island stands (opens when every heart is purified). */
    exit: [number, number];
    /** Comm-link messages from the World of Color, by trigger. */
    link: { on: string; text: string }[];
    /** Score: tonic MIDI note and mode intervals. */
    key: { tonic: number; mode: number[] };
}

export const LEVELS: LevelDef[] = [
    {
        id: "cove", name: "Landfall Cove", seed: 11, size: 220,
        text: "A warm beach, a jungle behind it, and a red stain spreading through the trees.",
        spawn: [0, 78],
        plateaus: [
            { x: 12, z: -38, w: 60, d: 34, h: 6, edge: 1.2 },
            { x: 64, z: -2, r: 14, h: 10, edge: 1.0, climb: true },
            { x: -46, z: -40, r: 24, ri: 18, h: 9, edge: 1.0, gap: Math.PI / 2, gapW: 8 },
        ],
        ramps: [{ from: [12, -8], to: [12, -23], w: 8 }],
        hollows: [{ x: 48, z: 52, r: 18, depth: 2.4 }],
        gates: [
            { id: "ridge", x: 12, z: -20.5, len: 12, angle: 0 },
            { id: "basin", x: -46, z: -19, len: 12, angle: 0 },
        ],
        switches: [
            { id: "sw-west", x: 2, z: -3, weight: 3, gate: "ridge" },
            { id: "sw-east", x: 22, z: -3, weight: 3, gate: "ridge" },
        ],
        levers: [{ id: "spire", x: 64, z: -2, gate: "basin" }],
        portals: [],
        crates: [
            { x: 14, z: 70, relics: 2, fruit: 0 }, { x: -18, z: 66, relics: 1, fruit: 1 }, { x: 30, z: 74, relics: 3, fruit: 0, big: true },
            { x: -46, z: 40, relics: 2, fruit: 1 }, { x: 22, z: -40, relics: 4, fruit: 0, big: true }, { x: -12, z: -2, relics: 2, fruit: 2 },
            { x: 72, z: 30, relics: 3, fruit: 0 }, { x: -52, z: -48, relics: 4, fruit: 1, big: true }, { x: 66, z: -4, relics: 6, fruit: 0 },
        ],
        trees: [
            { x: -10, z: 50, fruit: 4 }, { x: 18, z: 44, fruit: 4 }, { x: -32, z: 58, fruit: 3 }, { x: 40, z: 22, fruit: 4 },
            { x: -62, z: 12, fruit: 3 }, { x: 8, z: -46, fruit: 4 }, { x: -40, z: -30, fruit: 3 }, { x: 82, z: 18, fruit: 3 },
        ],
        dark: [
            { id: "grove", name: "The Smudged Grove", x: -42, z: 22, r: 20, enemies: [{ kind: "smudge", n: 4 }], heart: 60, relics: 6 },
            { id: "ridge", name: "Hollow Ridge", x: 18, z: -42, r: 20, enemies: [{ kind: "smudge", n: 3 }, { kind: "thornback", n: 2 }], heart: 90, relics: 8, frees: "lull" },
            { id: "basin", name: "Gloomtusk's Wallow", x: -46, z: -42, r: 17, enemies: [{ kind: "smudge", n: 2 }], heart: 140, relics: 14, boss: "gloomtusk" },
        ],
        npcs: [{ id: "bodhi", x: 14, z: 60, face: Math.PI }, { id: "hoolu", x: 46, z: 32, face: -2.4 }],
        exit: [-4, 24],
        link: [
            { on: "start", text: "Tom, this is the Link. We have you. The wormhole closed behind you - it was always one-way. Find the source of those signals." },
            { on: "firstDark", text: "That red reads on every one of our instruments. Whatever it is, it is eating their music." },
            { on: "firstSplit", text: "Your Tones are multiplying. Keep them fed and they will keep you alive." },
            { on: "boss", text: "Massive signal in that basin, Tom. It is feeding off those anchors. Cut them first." },
            { on: "complete", text: "The cove is singing again. The signal is stronger to the north. Go through the song gate." },
        ],
        key: { tonic: 62, mode: [0, 2, 4, 7, 9] },
    },
    {
        id: "falls", name: "Canopy Falls", seed: 23, size: 220,
        text: "Terraces of cloud-forest and a river that falls a long way. Old teal rings stand in the spray.",
        spawn: [0, 80],
        plateaus: [
            { x: -50, z: 0, w: 50, d: 60, h: 8, edge: 1.0, climb: true },
            { x: 50, z: -20, r: 26, h: 7, edge: 1.0 },
            { x: 0, z: -70, w: 130, d: 40, h: 12, edge: 1.0, climb: true },
            { x: 0, z: 30, r: 16, h: 2, edge: 8 },
            { x: 84, z: -44, r: 11, ri: 7, h: 6, edge: 0.8 },
        ],
        ramps: [{ from: [50, 17], to: [50, 4], w: 8 }, { from: [-50, -33], to: [-50, -52], w: 8 }],
        hollows: [{ x: 0, z: -20, r: 20, depth: 3 }, { x: 0, z: -2, r: 12, depth: 3 }],
        gates: [{ id: "terrace", x: 50, z: 6.5, len: 12, angle: 0 }, { id: "summit", x: -50, z: -49.5, len: 12, angle: 0 }],
        switches: [{ id: "sw-ring", x: 84, z: -46, weight: 3, gate: "summit" }],
        levers: [{ id: "cliff", x: -50, z: 6, gate: "terrace" }],
        portals: [{ id: "ring", a: [30, 50], b: [84, -42] }],
        crates: [
            { x: -12, z: 68, relics: 2, fruit: 1 }, { x: 20, z: 60, relics: 3, fruit: 0 }, { x: -60, z: 10, relics: 5, fruit: 0, big: true },
            { x: 60, z: -30, relics: 4, fruit: 1 }, { x: -30, z: -70, relics: 4, fruit: 2, big: true }, { x: 36, z: -76, relics: 5, fruit: 0 },
        ],
        trees: [
            { x: -20, z: 50, fruit: 4 }, { x: 22, z: 52, fruit: 4 }, { x: -70, z: 40, fruit: 3 }, { x: 70, z: 36, fruit: 4 },
            { x: -40, z: -14, fruit: 4 }, { x: 40, z: -10, fruit: 3 }, { x: 0, z: -80, fruit: 4 },
        ],
        dark: [
            { id: "spray", name: "The Spray Stain", x: 20, z: 30, r: 18, enemies: [{ kind: "smudge", n: 3 }, { kind: "spitter", n: 1 }], heart: 80, relics: 8 },
            { id: "terrace", name: "Rusted Terrace", x: 50, z: -22, r: 20, enemies: [{ kind: "thornback", n: 2 }, { kind: "spitter", n: 2 }], heart: 110, relics: 10 },
            { id: "summit", name: "The Weeping Summit", x: 0, z: -72, r: 26, enemies: [{ kind: "smudge", n: 3 }, { kind: "thornback", n: 2 }, { kind: "spitter", n: 2 }], heart: 160, relics: 16 },
        ],
        npcs: [{ id: "sisska", x: 10, z: 64, face: Math.PI }, { id: "bodhi", x: -14, z: 76, face: Math.PI }, { id: "clatter", x: 30, z: 72, face: -2.8 }],
        exit: [-40, -76],
        link: [
            { on: "start", text: "We traced the signals, Tom. Three of them, and one is under that summit." },
            { on: "portal", text: "Those rings read like folded space. Your violet Tones resonate with them." },
            { on: "complete", text: "One signal left. It is coming from inside a volcano. Of course it is." },
        ],
        key: { tonic: 57, mode: [0, 3, 5, 7, 10] },
    },
    {
        id: "caldera", name: "The Red Caldera", seed: 37, size: 220,
        text: "A drowned volcano whose rim is the last island. The Red Maw sings at the bottom.",
        spawn: [0, 84],
        plateaus: [
            { x: 0, z: -30, r: 70, ri: 46, h: 8, edge: 1.4, gap: Math.PI / 2, gapW: 11 },
            { x: -70, z: 40, r: 14, h: 9, edge: 1.0, climb: true },
        ],
        ramps: [],
        hollows: [{ x: 0, z: -30, r: 40, depth: 1.0 }],
        gates: [{ id: "rim", x: 0, z: 28, len: 14, angle: 0 }],
        switches: [{ id: "sw-a", x: -12, z: 46, weight: 4, gate: "rim" }, { id: "sw-b", x: 12, z: 46, weight: 4, gate: "rim" }],
        levers: [],
        portals: [{ id: "spire", a: [-50, 60], b: [-70, 40] }],
        crates: [
            { x: 20, z: 76, relics: 3, fruit: 1 }, { x: -24, z: 72, relics: 3, fruit: 1 }, { x: -70, z: 44, relics: 10, fruit: 3, big: true },
            { x: 30, z: -20, relics: 4, fruit: 2 }, { x: -30, z: -40, relics: 4, fruit: 2 },
        ],
        trees: [
            { x: -30, z: 80, fruit: 4 }, { x: 30, z: 84, fruit: 4 }, { x: 44, z: 64, fruit: 3 }, { x: -46, z: 64, fruit: 3 },
            { x: 20, z: -56, fruit: 4 }, { x: -24, z: -10, fruit: 4 },
        ],
        dark: [
            { id: "rimward", name: "The Scorched Rim", x: 62, z: 52, r: 16, enemies: [{ kind: "thornback", n: 2 }, { kind: "spitter", n: 2 }], heart: 100, relics: 10 },
            { id: "maw", name: "The Throat", x: 0, z: -32, r: 34, enemies: [{ kind: "smudge", n: 3 }, { kind: "thornback", n: 2 }, { kind: "spitter", n: 2 }], heart: 260, relics: 30, boss: "maw" },
        ],
        npcs: [{ id: "moss", x: -10, z: 76, face: Math.PI }, { id: "bodhi", x: 16, z: 70, face: Math.PI }],
        exit: [0, 70],
        link: [
            { on: "start", text: "This is the source, Tom. Every signal we ever caught came from under that rim." },
            { on: "boss", text: "Tom - that thing is broadcasting on all 1,001 dimensions at once. Silence it." },
            { on: "complete", text: "Tom. The Red Corruption is gone. Listen: we have built a way through. We are coming to get you." },
        ],
        key: { tonic: 53, mode: [0, 2, 3, 7, 8] },
    },
];

export const levelById = (id: string): LevelDef => LEVELS.find(l => l.id === id) ?? LEVELS[0];

// --- story ----------------------------------------------------------------------------------

export const INTRO: string[] = [
    "The Link joins 1,001 dimensions. For a year it carried a signal no one could read.",
    "In the World of Color they decided it was music - and that it was a cry for help.",
    "They sent one agent through a wormhole that only opens one way. Agent Tom.",
    "Three swarms came with him. Three Tones each: small, obedient, and every one a color.",
    "Here, no one sees color. They see music. And something red is eating it.",
];

export const ENDING: string[] = [
    "The Maw's last note goes out like a candle. The red drains from the veins of the island.",
    "Everywhere, the people of the World of Music hear themselves again.",
    "LINK: \"Tom. We built a way through from our side. Stay where you are. We are coming to get you.\"",
];

// --- the Prism Pipe (the music mini-game) ---------------------------------------------------

/** The pipe's five notes: keys 1-5 (or the pad's face buttons), each with a hue. */
export const PIPE_NOTES: { key: string; pad: string; degree: number; color: RGB }[] = [
    { key: "1", pad: "South", degree: 0, color: [0.12, 0.45, 1.0] },
    { key: "2", pad: "East", degree: 1, color: [0.42, 1.0, 0.18] },
    { key: "3", pad: "West", degree: 2, color: [1.0, 0.93, 0.1] },
    { key: "4", pad: "North", degree: 3, color: [0.66, 0.3, 1.0] },
    { key: "5", pad: "RightTrigger", degree: 4, color: [1.0, 1.0, 1.0] },
];

/** Phrases a jam partner plays (pipe note indices); each must be echoed back. */
export const JAM_PHRASES: Record<string, number[][]> = {
    hoolu: [[0, 2, 4], [4, 3, 2, 0], [0, 2, 1, 3, 4]],
    clatter: [[0, 0, 4], [2, 2, 1, 1], [0, 4, 0, 4, 2]],
};

export const SONGS = {
    gathering: { name: "Gathering Song", notes: [0, 2, 4], text: "Every swarm comes home and heals a little." },
};

// --- the input map --------------------------------------------------------------------------

export type Device = "keys" | "pad";
export const BINDINGS: Record<string, { what: string; keys: string; pad: string }> = {
    move: { what: "Walk", keys: "W A S D", pad: "Left stick" },
    camera: { what: "Turn the camera", keys: "Q / E  -  wheel zooms", pad: "Right stick" },
    jump: { what: "Jump", keys: "Space", pad: "A" },
    direct: { what: "Direct the selected swarm", keys: "Left click", pad: "RT (aim with right stick held LT)" },
    recall: { what: "Recall the selected swarm", keys: "Right click", pad: "LB" },
    select: { what: "Choose a swarm", keys: "Tab / 1-8", pad: "D-pad left / right" },
    gather: { what: "Gathering Song (all swarms home)", keys: "G", pad: "Y" },
    pipe: { what: "Prism Pipe (near a player)", keys: "F, then 1-5", pad: "X, then face buttons" },
    talk: { what: "Talk / trade", keys: "R", pad: "B" },
    stall: { what: "Bodhi's stall", keys: "B (near Bodhi)", pad: "Back (near Bodhi)" },
};

export const tierName = (n: number): string => ["", "I", "II", "III"][n] ?? String(n);
export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const v3 = (x: number, y: number, z: number): V3 => [x, y, z];
