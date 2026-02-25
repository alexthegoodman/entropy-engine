// =============================================================================
// "WHAT IF" TECH SYSTEM — LAYER ENUMS
// =============================================================================
// 10 layers total: 3 Progression layers + 7 Modifier layers
// Progression layers have natural ordering (low → high).
// Modifier layers are lateral — no value is inherently better than another.
// =============================================================================

// --- PROGRESSION LAYERS ------------------------------------------------------
// These have semantic weight and ordering. Higher = more advanced/refined.

// How sophisticated the underlying knowledge is.
// 8 values — enough steps to feel like meaningful progress without being granular
export enum Complexity {
  Crude       = "crude",
  Rough       = "rough",
  Practiced   = "practiced",
  Studied     = "studied",
  Refined     = "refined",
  Advanced    = "advanced",
  Arcane      = "arcane",
  Transcendent = "transcendent",
}

// How well it is actually constructed. Execution vs. knowledge.
// 6 values — quality plateaus feel more natural than knowledge plateaus
export enum BuildQuality {
  Shoddy      = "shoddy",
  Makeshift   = "makeshift",
  Common      = "common",
  Tempered    = "tempered",
  Masterful   = "masterful",
  Perfect     = "perfect",
}

// How accessible and scalable this tech is across your civilization.
// 7 values — accessibility has a lot of meaningful middle ground
export enum Affordability {
  Singular    = "singular",    // One exists. Ever.
  Sacred      = "sacred",      // Held by priests / elites only
  GuildHeld   = "guild-held",  // Specialist knowledge, tradeable
  Rationed    = "rationed",    // State-controlled distribution
  Traded      = "traded",      // Flows through markets
  Widespread  = "widespread",  // Most settlements have it
  Folk        = "folk",        // Everyone knows how to do it
}


// --- MODIFIER LAYERS ---------------------------------------------------------
// These are lateral. No ordering. Pure flavor and identity.
// The naming algorithm picks 2-3 of these to surface in the tech title.

// The elemental or cosmic domain this tech draws from.
// 14 values — the richest layer, drives the most naming variety
export enum Domain {
  Solar       = "solar",
  Lunar       = "lunar",
  Abyssal     = "abyssal",
  Oceanic     = "oceanic",
  Cosmic      = "cosmic",
  Fungal      = "fungal",
  Volcanic    = "volcanic",
  Glacial     = "glacial",
  Subterranean = "subterranean",
  Atmospheric = "atmospheric",
  Verdant     = "verdant",
  Necrotic    = "necrotic",
  Resonant    = "resonant",
  Void        = "void",
}

// The raw material or natural substance at the heart of this tech.
// 12 values — resource variety drives economic identity
export enum Resource {
  Iron        = "iron",
  Bone        = "bone",
  Crystal     = "crystal",
  Spore       = "spore",
  Oil         = "oil",
  Salt        = "salt",
  Silk        = "silk",
  Ember       = "ember",
  Stone       = "stone",
  Root        = "root",
  Venom       = "venom",
  Light       = "light",
}

// The productive process or craft discipline this tech belongs to.
// 10 values — maps to broad economic/cultural sectors
export enum Industry {
  Forge       = "forge",
  Weave       = "weave",
  Harvest     = "harvest",
  Refine      = "refine",
  Channel     = "channel",
  Construct   = "construct",
  Ferment     = "ferment",
  Engrave     = "engrave",
  Cultivate   = "cultivate",
  Transmit    = "transmit",
}

// The scale and reach of the tech's impact.
// 6 values — deliberately small, scale should feel like a spectrum not a taxonomy
export enum Scope {
  Personal    = "personal",
  Settlement  = "settlement",
  Regional    = "regional",
  Civilizational = "civilizational",
  Global      = "global",
  Cosmic      = "cosmic",
}

// The social structure this tech expresses or requires.
// 8 values — society layer gives techs a political texture
export enum Society {
  Communal    = "communal",
  Imperial    = "imperial",
  Nomadic     = "nomadic",
  Monastic    = "monastic",
  Mercantile  = "mercantile",
  Militarist  = "militarist",
  Isolationist = "isolationist",
  Anarchic    = "anarchic",
}

// The emotional or sensory character of the tech — its "vibe."
// 12 values — wildcard A leans atmospheric/adjectival
export enum Aura {
  Silent      = "silent",
  Burning     = "burning",
  Hollow      = "hollow",
  Strange     = "strange",
  Wet         = "wet",
  Bitter      = "bitter",
  Luminous    = "luminous",
  Hungry      = "hungry",
  Dreaming    = "dreaming",
  Brittle     = "brittle",
  Swollen     = "swollen",
  Ancient     = "ancient",
}

// The outcome or phenomenon the tech produces — its "effect word."
// 12 values — wildcard B leans toward nouns/events, pairs well with any domain
export enum Phenomenon {
  Bloom       = "bloom",
  Surge       = "surge",
  Pact        = "pact",
  Wound       = "wound",
  Echo        = "echo",
  Collapse    = "collapse",
  Drift       = "drift",
  Hum         = "hum",
  Scar        = "scar",
  Tide        = "tide",
  Pulse       = "pulse",
  Veil        = "veil",
}


// =============================================================================
// TECH NODE — the full 10-layer identity of a single technology
// =============================================================================

export interface TechNode {
  id: string

  // Progression layers
  complexity:   Complexity   | null  // null = maxed out (drops from name)
  buildQuality: BuildQuality | null  // null = maxed out (drops from name)
  affordability: Affordability | null // null = maxed out (drops from name)

  // Modifier layers
  domain:     Domain
  resource:   Resource
  industry:   Industry
  scope:      Scope
  society:    Society
  aura:       Aura
  phenomenon: Phenomenon

  // Computed display name (generated by naming algorithm)
  name?: string

  // Prerequisites: IDs of techs that must be researched first
  prerequisites: string[]
}


// =============================================================================
// LAYER METADATA — useful for the naming algorithm and UI
// =============================================================================

export type LayerName =
  | "complexity"
  | "buildQuality"
  | "affordability"
  | "domain"
  | "resource"
  | "industry"
  | "scope"
  | "society"
  | "aura"
  | "phenomenon"

export const PROGRESSION_LAYERS: LayerName[] = [
  "complexity",
  "buildQuality",
  "affordability",
]

export const MODIFIER_LAYERS: LayerName[] = [
  "domain",
  "resource",
  "industry",
  "scope",
  "society",
  "aura",
  "phenomenon",
]

// Rarity weights for the naming algorithm.
// Lower = rarer = more likely to be surfaced in the tech name.
export const DOMAIN_RARITY: Record<Domain, number> = {
  [Domain.Solar]:         0.8,
  [Domain.Lunar]:         0.7,
  [Domain.Oceanic]:       0.7,
  [Domain.Volcanic]:      0.6,
  [Domain.Glacial]:       0.6,
  [Domain.Verdant]:       0.8,
  [Domain.Atmospheric]:   0.5,
  [Domain.Subterranean]:  0.5,
  [Domain.Fungal]:        0.4,
  [Domain.Resonant]:      0.4,
  [Domain.Abyssal]:       0.3,
  [Domain.Necrotic]:      0.3,
  [Domain.Cosmic]:        0.2,
  [Domain.Void]:          0.1,
}

// =============================================================================
// "WHAT IF" UNIT SYSTEM — LAYER ENUMS
// =============================================================================
// 10 layers total: 3 Progression + 7 Modifier (same philosophy as Tech)
// Progression drops from name at max. Modifiers give flavor + identity.
// Units become buildable the moment their prerequisite TechNode is researched.

export enum UnitCategory {
  Worker   = "worker",
  Soldier  = "soldier",
  Tower    = "tower",
  Building = "building",
}

// --- PROGRESSION LAYERS ------------------------------------------------------
export enum TrainingLevel {
  Raw         = "raw",
  Green       = "green",
  Drilled     = "drilled",
  Hardened    = "hardened",
  Veteran     = "veteran",
  Master      = "master",
}

export enum ForgedQuality {
  Brittle      = "brittle",
  Reinforced   = "reinforced",
  Tempered     = "tempered",
  Masterforged = "masterforged",
  Flawless     = "flawless",
  Indestructible = "indestructible",
}

export enum Availability {
  Unique       = "unique",      // one squad ever
  EliteGuard   = "elite-guard",
  Mercenary    = "mercenary",
  StandingArmy = "standing-army",
  Levied       = "levied",
  Militia      = "militia",
  Ubiquitous   = "ubiquitous",  // everyone fields them
}

// --- MODIFIER LAYERS ---------------------------------------------------------
export enum Heritage {
  Ancestral   = "ancestral",
  Forged      = "forged",
  Summoned    = "summoned",
  Grafted     = "grafted",
  Awakened    = "awakened",
  Engineered  = "engineered",
  Primordial  = "primordial",
  Celestial   = "celestial",
}

export enum Role {
  Scout      = "scout",
  Vanguard   = "vanguard",
  Defender   = "defender",
  Artillery  = "artillery",
  Harvester  = "harvester",
  Engineer   = "engineer",
  Assassin   = "assassin",
  Support    = "support",
}

export enum Biome {  // ties nicely to Domain
  Forest       = "forest",
  Mountain     = "mountain",
  Desert       = "desert",
  Tundra       = "tundra",
  Swamp        = "swamp",
  Volcanic     = "volcanic",
  Oceanic      = "oceanic",
  Subterranean = "subterranean",
  Aerial       = "aerial",
}

export enum Formation {  // extra flavor layer
  Loose   = "loose",
  Phalanx = "phalanx",
  Swarm   = "swarm",
  Wedge   = "wedge",
  Shieldwall = "shieldwall",
  Skirmish = "skirmish",
}

export interface UnitNode {
  id: string
  category: UnitCategory

  // Progression
  trainingLevel: TrainingLevel | null
  forgedQuality: ForgedQuality | null
  availability: Availability | null

  // Modifiers (lateral)
  heritage: Heritage
  role: Role
  biome: Biome
  formation: Formation
  aura: Aura          // reuse from tech for consistency
  phenomenon: Phenomenon
  domain: Domain      // what cosmic force it channels

  name?: string
  prereqTechIds: string[]   // usually 1, can be multiple
  // buildCost?: Partial<Record<BaseResource, number>> // add later
}

// =============================================================================
// TECH GRID — 10 columns × 100 rows
// =============================================================================

export type GridKey = `${number},${number}`;

export class TechGrid {
  readonly width = 10;
  readonly height = 100;
  nodes: TechNode[][]; // nodes[y][x]

  constructor() {
    this.nodes = Array.from({ length: this.height }, () => Array(this.width));
  }

  getNode(x: number, y: number): TechNode | undefined {
    return this.nodes[y]?.[x];
  }

  getKey(x: number, y: number): GridKey {
    return `${x},${y}`;
  }
}

// Column themes → distinct paths (players will feel the difference)
const COLUMN_DOMAIN_BIASES: Domain[][] = [
  [Domain.Solar, Domain.Volcanic, Domain.Atmospheric], // Fire & Sky
  [Domain.Lunar, Domain.Glacial, Domain.Oceanic],      // Ice & Tide
  [Domain.Fungal, Domain.Verdant, Domain.Subterranean],// Growth & Root
  [Domain.Abyssal, Domain.Necrotic],                   // Deep & Death
  [Domain.Cosmic, Domain.Resonant, Domain.Void],       // Stars & Echo
  [Domain.Solar, Domain.Cosmic],                       // Radiant
  [Domain.Fungal, Domain.Necrotic],                    // Blight
  [Domain.Volcanic, Domain.Abyssal],                   // Inferno
  [Domain.Glacial, Domain.Atmospheric],                // Frostwind
  [Domain.Resonant, Domain.Light],                     // Harmony
];

function randomEnum<T>(enumObj: T): T[keyof T] {
  const values = Object.values(enumObj) as T[keyof T][];
  return values[Math.floor(Math.random() * values.length)]!;
}

export function generateTechGrid(): TechGrid {
  const grid = new TechGrid();

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const id = `tech_${x}_${y}`;

      // === Progression layers (strictly tied to depth y) ===
      const complexity = getProgression(Complexity, 8, y, 11);   // 8 steps
      const buildQuality = getProgression(BuildQuality, 6, y, 15); // 6 steps
      const affordability = getProgression(Affordability, 7, y, 13); // 7 steps

      // === Modifiers ===
      const domain = pickBiasedDomain(x);
      const resource = randomEnum(Resource);
      const industry = randomEnum(Industry);
      const scope = randomEnum(Scope);
      const society = randomEnum(Society);
      const aura = randomEnum(Aura);
      const phenomenon = randomEnum(Phenomenon);

      const node: TechNode = {
        id,
        complexity,
        buildQuality,
        affordability,
        domain,
        resource,
        industry,
        scope,
        society,
        aura,
        phenomenon,
        prerequisites: y > 0 ? [`tech_${x}_${y - 1}`] : [], // vertical chain
        // requiredResources added below
      };

      // Optional cross-prereq for extra spice (10% chance)
      if (y > 0 && Math.random() < 0.1) {
        const neighborX = (x + (Math.random() < 0.5 ? -1 : 1) + grid.width) % grid.width;
        node.prerequisites.push(`tech_${neighborX}_${y - 1}`);
      }

      grid.nodes[y][x] = node;
    }
  }

  // One final pass: add requiredResources (separation!)
  addResourcePrerequisites(grid);

  return grid;
}

function getProgression<T>(
  enumObj: T,
  maxLevels: number,
  depth: number,
  stepSize: number
): T[keyof T] | null {
  const level = Math.floor(depth / stepSize);
  if (level >= maxLevels) return null;
  const values = Object.values(enumObj) as T[keyof T][];
  return values[level];
}

function pickBiasedDomain(col: number): Domain {
  const biases = COLUMN_DOMAIN_BIASES[col]!;
  if (Math.random() < 0.65) {
    return biases[Math.floor(Math.random() * biases.length)]!;
  }
  return randomEnum(Domain);
}

// =============================================================================
// RESOURCE SYSTEM — completely separate from Tech/Resource enum
// =============================================================================

export enum BaseResource {
  Timber        = "timber",
  Stone         = "stone",
  IronOre       = "iron-ore",
  CrystalShard  = "crystal-shard",
  BoneMeal      = "bone-meal",
  EmberDust     = "ember-dust",
  SilkThread    = "silk-thread",
  RootSap       = "root-sap",
  VenomGland    = "venom-gland",
  ManaEssence   = "mana-essence",
  SaltCrystal   = "salt-crystal",
  VoidFragment  = "void-fragment",
}

// Add to your existing TechNode interface:
export interface TechNode {
  // ... existing fields
  requiredResources?: BaseResource[];   // ← add this
}

// Simple helper used inside generateTechGrid
function addResourcePrerequisites(grid: TechGrid) {
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const node = grid.nodes[y][x]!;
      node.requiredResources = [];

      // 35% chance a tech wants a resource
      if (Math.random() < 0.35) {
        const res = randomEnum(BaseResource);
        node.requiredResources.push(res);
      }
      // Very rare double requirement (late game)
      if (y > 60 && Math.random() < 0.12) {
        const res2 = randomEnum(BaseResource);
        if (res2 !== node.requiredResources[0]) node.requiredResources.push(res2);
      }
    }
  }
}

export function generateUnits(techGrid: TechGrid): UnitNode[] {
  const units: UnitNode[] = [];
  const allTechIds = techGrid.nodes.flat().map(n => n.id);

  // Generate ~80 units, roughly 8 per column depth
  for (let i = 0; i < 80; i++) {
    const prereqTechId = allTechIds[Math.floor(Math.random() * allTechIds.length)]!;

    const unit: UnitNode = {
      id: `unit_${i}`,
      category: randomEnum(UnitCategory),
      trainingLevel: getProgression(TrainingLevel, 7, Math.random() * 100 | 0, 14),
      forgedQuality: getProgression(ForgedQuality, 6, Math.random() * 100 | 0, 16),
      availability: getProgression(Availability, 7, Math.random() * 100 | 0, 14),
      heritage: randomEnum(Heritage),
      role: randomEnum(Role),
      biome: randomEnum(Biome),
      formation: randomEnum(Formation),
      aura: randomEnum(Aura),
      phenomenon: randomEnum(Phenomenon),
      domain: randomEnum(Domain),
      prereqTechIds: [prereqTechId],
    };
    units.push(unit);
  }
  return units;
}