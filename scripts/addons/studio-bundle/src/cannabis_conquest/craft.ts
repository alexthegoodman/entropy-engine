/**
 * ~CANNABIS CONQUEST~
 * Start from a farm, build your city, and then build your nation! All in the name of the great bud. 
 * Face off against your competitors and conquer the world!
 * Tags: civilization, 4k, cannabis
 */

// pick your character at the start
export enum CharacterType {
    HomeGrower = "Home Grower",
    Geneticist = "Geneticist",
    Harvester = "Harvester"
}

// add units as you earn money
export enum UnitType {
    // buildings
    Greenhouse = "Greenhouse",
    LightFactory = "Light Factory",
    // live units
    Missile = "Missile",
    Electrician = "Electrician",
    Medic = "Medic"
}

// upgrade units as you earn money, up to 7 levels each
export enum UpgradeType {
    PipeCleaners = "Pipe Cleaners",
    BluntBoosters = "Blunt Boosters",
    NuclearHotBox = "Nuclear Hot Box",
    BongWaterCooler = "Bong Water Cooler",
    DabTorchthrower = "Dab Torchthrower",
    Percolator = "Fiberglass Percolator"
}

export interface EntityInfo {
    // meta info
    id: string;
    name: string;
    tags: string[];
    description: string;
}

export interface NationState extends EntityInfo {
    character: CharacterType;
    stats: NationStats;
}

export interface UnitEntity extends EntityInfo {
    unit: UnitType;
    stats: UnitStats;
}

export interface Technology extends EntityInfo {
    // rewards
    statDelta?: NationStats;
    bonusUnitId?: string;
}

export interface NationStats {
    science?: number;
    curiosity?: number;
    creativity?: number;
    money?: number;
    // etc
}

export interface UnitStats {
    health: number;
    rank: number;
    attachedUpgrades: UnitUpgrade[];
    attack: {
        damageRange: [number, number];
    };
    defense: {
        resistance: number;
    };
    travel: {
        maxDistance: number;
    }
}

export interface UnitUpgrade extends EntityInfo {
    type: UpgradeType;
    level: number;
    statDelta: UnitStats;
}

export interface UnitStats {
    health: number;
    damage: number;
    resistance: number;
    maxDistance: number;
    // etc
}