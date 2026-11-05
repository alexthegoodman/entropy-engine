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
    /**
     * Snap to landscape: the spot sits on the ground, so its elevation follows the terrain when the
     * spot moves or the terrain is sculpted. Off for a sky citadel or a tower top whose elevation is
     * authored. Older saves have no flag; they are treated as snapped.
     */
    snapToGround?: boolean;
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
    /** A faction codex entry that holds this region. */
    controllingFactionId?: string;
    description: string;
    /** The region's biome and regional plan (all optional). */
    plan?: RegionPlan;
}

/** What a region is meant to feel and play like: notes for art, audio and encounter design. */
export interface RegionPlan {
    climate?: string;
    flora?: string;
    fauna?: string;
    resources?: string;
    /** Mood, light, weather, music. */
    mood?: string;
    /** The level range the region is balanced for. */
    levelMin?: number;
    levelMax?: number;
    notes?: string;
}

// -------------------------------------------------------------------------------------------------
// Planning marks: painted, not built. A brush marks where forest, farmland, snow, enemies or NPCs
// should be; the map draws the marks as symbols, and regions report what was painted inside them.
// -------------------------------------------------------------------------------------------------

export type MarkGlyph = "tree" | "grass" | "dot" | "hatch" | "rock" | "snow" | "wave" | "cross" | "diamond" | "square" | "skull" | "person" | "flag";

/**
 * A coarse grid of painted densities (0..1) over the whole world, one array per layer. Cells are
 * centered: cell (c, r) covers x in [-W/2 + c*W/cols, -W/2 + (c+1)*W/cols], row 0 along the north
 * edge. Layer keys are a mark id ("forest") or "codex:<entryId>" for painted enemies, NPCs and
 * factions.
 */
export interface PlanningOverlay {
    cols: number;
    rows: number;
    layers: Record<string, number[]>;
}

export type PlacementBehavior = "static" | "wander" | "patrol" | "guard" | "ambush" | "spawner" | "vendor" | "quest_giver";

/** A codex entry put on the map at one place: a named NPC, a camp of enemies, a faction outpost. */
export interface CodexPlacement {
    id: string;
    codexId: string;
    x: number;
    y: number;
    /** How many (an enemy pack, a garrison); 1 for a named character. */
    count: number;
    behavior: PlacementBehavior;
    levelMin?: number;
    levelMax?: number;
    notes: string;
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

/** character = NPCs and named people; creature = enemies and wildlife (the bestiary). */
export type CodexCategory = "character" | "creature" | "power" | "weapon" | "faction" | "lore";

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

    // --- Optional planning detail: none of it is required; the analysis uses what is there. ---
    /** Who gives the quest (a character codex entry), not only where. */
    giverCodexId?: string;
    /** Why the player should care, in one or two lines. */
    hook?: string;
    /** The level range the quest is tuned for. */
    levelMin?: number;
    levelMax?: number;
    /** What happens at each objective spot, keyed by spot id. */
    objectiveDetails?: Record<string, QuestObjectiveDetail>;
    /** Codex items, powers or weapons the quest grants. */
    rewardCodexIds?: string[];
    /** Standing gained or lost with factions. */
    reputation?: Array<{ factionId: string; amount: number }>;
    /** Endings or choices, each unlocking its own follow-ups. */
    outcomes?: QuestOutcome[];
}

export type ObjectiveAction = "go" | "talk" | "defeat" | "collect" | "escort" | "defend" | "investigate" | "deliver" | "use";

export interface QuestObjectiveDetail {
    action: ObjectiveAction;
    /** The NPC to talk to, the creature to defeat, the item to collect... */
    targetCodexId?: string;
    count?: number;
    optional?: boolean;
    /** Designer estimate of time spent there; defaults by action. */
    minutes?: number;
    note?: string;
}

export interface QuestOutcome {
    id: string;
    label: string;
    /** Quests this ending opens up (in addition to those listing this quest as a prerequisite). */
    unlocksMissionIds: string[];
    consequence?: string;
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

/** How the Sculpt tool shapes the ground. Brushes are dragged; lines and areas are clicked out. */
export type SculptMode =
    | "raise"
    | "lower"
    | "smooth"
    | "flatten"
    | "roughen"
    | "canyon"
    | "ridge"
    | "grade"
    | "plateau";

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
    /** Painted planning marks: biomes, foliage, enemies, NPCs (older saves have none). */
    overlay?: PlanningOverlay;
    /** Codex entries placed on the map: NPCs, enemy camps, faction outposts. */
    placements?: CodexPlacement[];
}
