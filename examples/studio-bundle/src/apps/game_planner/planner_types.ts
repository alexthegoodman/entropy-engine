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

/**
 * The world's heightfield: `cols` x `rows` elevations in meters, row-major. Row 0 runs along the
 * north edge (y = +H/2), column 0 along the west edge (x = -W/2); vertices span the whole world.
 */
export interface TerrainGrid {
    cols: number;
    rows: number;
    data: number[];
    seaLevelM: number;
    minM: number;
    maxM: number;
}

/** How the map paints the terrain. */
export type TerrainStyle = "relief" | "heatmap" | "slope" | "flat";

export interface TravelModeEstimate {
    mode: TravelMode;
    label: string;
    speedKmH: number;
    hours: number;
    minutes: number;
    formattedTime: string;
}

export interface TravelEstimate {
    /** Effort-weighted distance: the route (or straight line) times terrain difficulty. */
    distanceKm: number;
    /** Straight-line distance. */
    directDistanceKm: number;
    /** Along the straight line, when the world has terrain. */
    climbM?: number;
    descentM?: number;
    waterKm?: number;
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

export type RevisionChangeType =
    | "add_spot"
    | "modify_spot"
    | "delete_spot"
    | "add_path"
    | "modify_path"
    | "delete_path"
    | "add_region"
    | "modify_region"
    | "add_mission"
    | "add_codex"
    | "adjust_landscape";

export interface RevisionChange {
    id: string;
    changeType: RevisionChangeType;
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
    /** The intent this proposal answers, when an agent worked from one. */
    intentId?: string;
}

// -------------------------------------------------------------------------------------------------
// Design intents: what the designer wants, sketched on the map, for agents to build
// -------------------------------------------------------------------------------------------------

/** How an intent is drawn: a pin at one place, an area outline, or a route between two places. */
export type IntentShape = "pin" | "area" | "route";

/**
 * What an intent asks for. Each kind (except freeform) has an automatic check, so an intent is
 * also an acceptance test the world either passes or fails.
 * - settle: "N settlements in this area" (area)
 * - danger: "this area is dangerous, threat level N" (area)
 * - landmark: "a place of this type here" (pin)
 * - connect: "these two places are joined by a road" (route)
 * - pacing: "getting from A to B takes about N minutes by mode" (route)
 * - quest: "a quest happens here" (pin or area)
 * - freeform: anything else, for an LLM agent to interpret (any shape; checked by hand)
 */
export type IntentKind = "settle" | "danger" | "landmark" | "connect" | "pacing" | "quest" | "freeform";

export type IntentStatus = "open" | "claimed" | "proposed" | "done" | "dismissed";

export interface IntentParams {
    /** settle: how many places. */
    count?: number;
    /** settle / landmark / quest: what kind of spot. */
    spotType?: SpotType;
    /** danger: threat level 1-10. */
    dangerLevel?: number;
    /** pacing: target travel time. */
    targetMinutes?: number;
    /** pacing: how the player travels (default foot). */
    mode?: TravelMode;
    /** pacing: allowed deviation from the target, 0..1 (default 0.25). */
    tolerance?: number;
    /** connect: road kind to build (default road). */
    pathType?: PathType;
    /** danger / settle: biome the area should read as. */
    biome?: BiomeType;
}

export interface PlanIntent {
    id: string;
    /** Shown on the map badge ("#3"); stable for the intent's life. */
    number: number;
    shape: IntentShape;
    kind: IntentKind;
    /** pin: [p]; area: polygon; route: [from, to]. World km. */
    points: [number, number][];
    /** route: endpoints pinned to spots follow them when they move. */
    fromSpotId?: string;
    toSpotId?: string;
    title: string;
    /** The designer's words: what they want, for agents to read. */
    directive: string;
    params: IntentParams;
    priority: "low" | "normal" | "high";
    status: IntentStatus;
    claimedBy?: string;
    createdAt: number;
}

/** The live check of an intent against the world. */
export interface IntentEvaluation {
    /** null when nothing can be checked automatically (freeform). */
    satisfied: boolean | null;
    /** One line for the map and inspector: "2 of 3 settlements". */
    summary: string;
    /** 0..1, how close the world is to meeting it. */
    progress: number;
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
    /** Hand-drawn or legacy contour lines; when `terrain` exists the map traces its own from it. */
    contours: ContourLine[];
    terrain?: TerrainGrid;
    codex: CodexEntry[];
    acts: StoryAct[];
    missions: Mission[];
    proposals: RevisionProposal[];
    /** Design intents sketched on the map (older saves have none). */
    intents?: PlanIntent[];
}
