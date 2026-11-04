// Type definitions for Game World Planner

export type GenreType = "fantasy" | "scifi" | "postapoc" | "cyberpunk" | "steampunk" | "historical";

export type BiomeType =
    | "plains"
    | "forest"
    | "jungle"
    | "desert"
    | "tundra"
    | "volcanic"
    | "swamp"
    | "alpine"
    | "coastal"
    | "savanna"
    | "taiga"
    | "badlands";

export type SpotType =
    | "capital"
    | "city"
    | "town"
    | "village"
    | "fortress"
    | "dungeon"
    | "ruin"
    | "port"
    | "shrine"
    | "camp"
    | "mine"
    | "boss"
    | "landmark";

export type PathType = "highway" | "road" | "trail" | "river" | "bridge";

export type RegionType = "kingdom" | "province" | "biome" | "danger" | "district";

export type TravelMode = "foot" | "mount" | "vehicle" | "water" | "air";

export interface WorldSpot {
    id: string;
    name: string;
    spotType: SpotType;
    x: number; // in world km
    y: number; // in world km
    elevation: number; // in meters above sea level
    color: [number, number, number, number];
    icon: string;
    tags: string[];
    isMajor: boolean; // shown in blocking mode
    dangerLevel?: number; // 1-10 wilderness / dungeon threat level
    description: string;
    loreNotes: string;
    conceptPrompt?: string;
    conceptImageUrl?: string;
    linkedCodexIds: string[];
    linkedMissionIds: string[];
}

export interface WorldPath {
    id: string;
    name: string;
    pathType: PathType;
    points: [number, number][]; // [x, y] in world km
    width: number;
    color: [number, number, number, number];
    isMajor: boolean;
    flowSpeed: number; // > 0 for rivers (flow direction from points[0] to points[n])
    surfaceQuality: number; // 0.8 (highway) to 3.0 (swamp trail)
    description?: string;
}

export interface WorldRegion {
    id: string;
    name: string;
    regionType: RegionType;
    points: [number, number][]; // polygon vertices in world km
    fillColor: [number, number, number, number];
    borderColor: [number, number, number, number];
    isMajor: boolean;
    dominantBiome: BiomeType;
    dangerLevel: number; // 1 to 10
    controllingFactionId?: string;
    description: string;
}

export interface ContourLine {
    elevation: number; // meters
    points: [number, number][]; // world km
    color: [number, number, number, number];
}

export interface TravelModeEstimate {
    mode: TravelMode;
    label: string;
    speedKmH: number;
    hours: number;
    minutes: number;
    formattedTime: string;
}

export interface TravelEstimate {
    distanceKm: number;
    directDistanceKm: number;
    pathFound: boolean;
    difficultyMultiplier: number;
    estimates: Record<TravelMode, TravelModeEstimate>;
    summaryText: string;
}

export type CodexCategory = "character" | "power" | "weapon" | "faction" | "lore";

export interface CodexEntry {
    id: string;
    name: string;
    category: CodexCategory;
    subtitle: string;
    description: string;
    attributes: Record<string, string | number>;
    tags: string[];
    linkedSpotIds: string[];
    linkedMissionIds: string[];
    conceptImagePrompt: string;
    conceptImageUrl?: string;
}

export type StoryMode = "chronological" | "freeform";

export type MissionStatus = "locked" | "available" | "active" | "completed";

export type MissionType = "main" | "side" | "faction";

export interface Mission {
    id: string;
    title: string;
    actId?: string;
    chapterId?: string;
    missionType: MissionType;
    description: string;
    startSpotId?: string;
    objectiveSpotIds: string[];
    objectivePathIds: string[];
    objectiveRegionIds: string[];
    turnInSpotId?: string;
    requiredCodexIds: string[];
    prerequisiteMissionIds: string[];
    rewardXp: number;
    rewardItems: string[];
    status: MissionStatus;
    milestoneName?: string;
}

export interface StoryChapter {
    id: string;
    actId: string;
    chapterNumber: number;
    title: string;
    summary: string;
    missionIds: string[];
}

export interface StoryAct {
    id: string;
    actNumber: number;
    title: string;
    theme: string;
    chapters: StoryChapter[];
}

export interface RevisionChange {
    id: string;
    changeType: "add_spot" | "modify_spot" | "delete_spot" | "add_path" | "add_mission" | "add_codex" | "adjust_landscape";
    targetId: string;
    title: string;
    summary: string;
    before?: any;
    after: any;
    status: "pending" | "accepted" | "rejected";
}

export interface RevisionProposal {
    id: string;
    agentName: string;
    timestamp: number;
    motivation: string;
    changes: RevisionChange[];
}

export interface WorldMetadata {
    id: string;
    name: string;
    genre: GenreType;
    worldWidthKm: number;
    worldHeightKm: number;
    seed: number;
    description: string;
    blockingMode: boolean; // true = blocking layout mode, false = detailing mode
    gridSnapM: number;     // 0 = off, else e.g. 50, 100, 500, 1000
    seaLevelM: number;     // default 0
}

export interface GameWorld {
    meta: WorldMetadata;
    spots: WorldSpot[];
    paths: WorldPath[];
    regions: WorldRegion[];
    contours: ContourLine[];
    codex: CodexEntry[];
    acts: StoryAct[];
    missions: Mission[];
    proposals: RevisionProposal[];
}
