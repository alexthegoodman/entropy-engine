/**
 * ~CANNABIS CONQUEST~
 * Start from a farm, build your city, and then build your nation! All in the name of the great bud.
 * Face off against your competitors and conquer the world!
 * Tags: civilization, 4k, cannabis
 */

// ---- Enums ----

export enum CharacterType {
    HomeGrower = "Home Grower",
    Geneticist = "Geneticist",
    Harvester = "Harvester"
}

export enum UnitType {
    // buildings
    Greenhouse = "Greenhouse",
    LightFactory = "Light Factory",
    DispensaryHQ = "Dispensary HQ",
    WaterTower = "Water Tower",
    CompostVault = "Compost Vault",
    // live units
    Missile = "Missile",
    Electrician = "Electrician",
    Medic = "Medic",
    Scout = "Scout",
    Transporter = "Transporter",
    DeliveryDriver = "Delivery Driver",
    BudTender = "Bud Tender"
}

export enum UpgradeType {
    PipeCleaners = "Pipe Cleaners",
    BluntBoosters = "Blunt Boosters",
    NuclearHotBox = "Nuclear Hot Box",
    BongWaterCooler = "Bong Water Cooler",
    DabTorchthrower = "Dab Torchthrower",
    Percolator = "Fiberglass Percolator",
    TerpeneShield = "Terpene Shield",
    CannabisCamo = "Cannabis Camo",
    RosinRocket = "Rosin Rocket"
}

export enum StrainType {
    Indica = "Indica",
    Sativa = "Sativa",
    Hybrid = "Hybrid",
    Autoflower = "Autoflower",
    CBD = "CBD"
}

export enum BiomeType {
    Desert = "Desert",
    Jungle = "Jungle",
    Tundra = "Tundra",
    Coastal = "Coastal",
    Plains = "Plains"
}

export enum DiplomacyStatus {
    Allied = "Allied",
    Neutral = "Neutral",
    ColdWar = "Cold War",
    AtWar = "At War",
    TradePartner = "Trade Partner"
}

export enum ResourceType {
    Seeds = "Seeds",
    Fertilizer = "Fertilizer",
    Water = "Water",
    Energy = "Energy",
    Concentrate = "Concentrate",
    RawBud = "Raw Bud"
}

export enum EventType {
    NaturalDisaster = "Natural Disaster",
    Raid = "Raid",
    Boom = "Boom",
    Epidemic = "Epidemic",
    BlackMarketSurge = "Black Market Surge",
    RegulatoryChange = "Regulatory Change"
}

// ---- Base Interfaces ----

export interface EntityInfo {
    id: string;
    name: string;
    tags: string[];
    description: string;
    // when the entity was added to the game world
    createdAt: number;
}

// ---- Nation ----

export interface NationState extends EntityInfo {
    character: CharacterType;
    biome: BiomeType;
    stats: NationStats;
    resources: ResourceInventory;
    territory: Territory;
    diplomacy: DiplomacyEntry[];
    activeTechnologies: string[];         // Technology ids
    activeEvents: WorldEvent[];
    units: UnitEntity[];
}

export interface NationStats {
    science?: number;
    curiosity?: number;
    creativity?: number;
    money?: number;
    reputation?: number;                  // affects diplomacy and trade
    enforcement?: number;                 // resistance to raids and regulatory events
    horticulture?: number;                // affects yield and strain quality
}

export interface Territory {
    tiles: MapTile[];
    capitalTileId: string;
    totalArea: number;
}

export interface MapTile {
    id: string;
    biome: BiomeType;
    coordinates: [number, number];
    controlled: boolean;
    fertility: number;                    // 0-100, affects greenhouse output
    structures: string[];                 // UnitEntity ids built on this tile
}

export interface DiplomacyEntry {
    nationId: string;
    status: DiplomacyStatus;
    treatySince?: number;                 // timestamp
    tradeRoutes?: TradeRoute[];
}

export interface TradeRoute {
    id: string;
    resourceType: ResourceType;
    amountPerTurn: number;
    active: boolean;
}

// ---- Resources ----

export interface ResourceInventory {
    [key: string]: number; // key = ResourceType
}

// ---- Units ----

export interface UnitEntity extends EntityInfo {
    unit: UnitType;
    ownedByNationId: string;
    position?: [number, number];          // live units have a position on the map
    stats: UnitStats;
    isBuilding: boolean;
}

export interface UnitStats {
    health: number;
    maxHealth: number;
    rank: number;
    experience: number;                   // earn xp to increase rank
    attachedUpgrades: UnitUpgrade[];
    attack: {
        damageRange: [number, number];
        aoeRadius?: number;               // area-of-effect for missiles, etc.
        attackSpeed: number;              // attacks per turn
    };
    defense: {
        resistance: number;
        evasion?: number;                 // chance to dodge an attack
    };
    travel: {
        maxDistance: number;
        terrainModifiers?: Partial<Record<BiomeType, number>>; // speed multipliers per biome
    };
    production?: {
        resourceType: ResourceType;
        amountPerTurn: number;
    };                                    // only for building-type units
}

export interface UnitUpgrade extends EntityInfo {
    type: UpgradeType;
    level: number;                        // 1-7
    maxLevel: 7;
    statDelta: Partial<UnitStats>;
    cost: ResourceInventory;
}

// ---- Technology ----

export interface Technology extends EntityInfo {
    prerequisites: string[];              // Technology ids required to unlock
    researchCost: Partial<NationStats>; // how much it takes to research it
    rewards: TechnologyRewards;
}

export interface TechnologyRewards {
    statDelta?: Partial<NationStats>;
    unlocksUnitTypes?: UnitType[];
    unlocksUpgradeTypes?: UpgradeType[];
    resourceBonus?: ResourceInventory;
}

// ---- Strains ----

export interface Strain extends EntityInfo {
    type: StrainType;
    thcContent: number;                   // percentage
    cbdContent: number;
    yield: number;                        // base units of RawBud per harvest
    growthTurns: number;                  // turns to mature
    statBonuses?: Partial<NationStats>;   // some strains buff certain nation stats
    biomeAffinities?: Partial<Record<BiomeType, number>>; // yield multipliers per biome
}

// ---- Characters ----

export interface CharacterDefinition extends EntityInfo {
    type: CharacterType;
    startingStats: Partial<NationStats>;
    startingResources: ResourceInventory;
    startingUnits: UnitType[];
    passives: CharacterPassive[];
}

export interface CharacterPassive {
    id: string;
    name: string;
    description: string;
    statModifiers?: Partial<NationStats>;
    productionModifiers?: Partial<Record<ResourceType, number>>;
}

// ---- World Events ----

export interface WorldEvent extends EntityInfo {
    type: EventType;
    duration: number;                     // turns the event lasts
    turnsRemaining: number;
    affectedTileIds?: string[];
    statDelta?: Partial<NationStats>;
    resourceDelta?: ResourceInventory;
}