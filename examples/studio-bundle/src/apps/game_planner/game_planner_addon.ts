/// <reference path="../../addon.d.ts" />

import { PlannerModel, isSnapped, paletteForGenre } from "./planner_model";
import {
    calculateRouteTravelTime,
    calculateTravelTime,
    euclideanDistanceKm,
    pathPolylineLengthKm,
} from "./travel_calculator";
import {
    generateRivers,
    generateSettlements,
    scatterPointsOfInterest,
} from "./procedural_tools";
import {
    carveRivers,
    erodeTerrain,
    fitTerrainToSpots,
    generateTerrain,
    sampleTerrain,
    terrainStats,
} from "./terrain";
import {
    createCodexEntry,
    filterCodexByCategory,
    generateConceptImagePrompt,
} from "./codex_model";
import {
    computeAvailableMissions,
    createMission,
    getChronologicalActs,
    validateQuestGraph,
} from "./story_model";
import {
    exportMapToSvg,
    exportWorldBibleJson,
    generateAgentPrompts,
    generateGameDesignDoc,
    isProposalPending,
    proposalGhosts,
} from "./agent_pipeline";
import {
    INTENT_KINDS,
    INTENT_KIND_INFO,
    effectiveParams,
    evaluateIntent,
    generateAgentBrief,
    intentContext,
    intentPoints,
    openIntents,
    planHealth,
    spotNear,
} from "./intent_model";
import { PLANNER_AGENT_NAME, draftProposalForIntent, normalizeProposalChanges } from "./planner_agent";
import {
    AREA_MODES,
    BRUSH_MODES,
    LINE_MODES,
    SCULPT_INFO,
    carveCanyon,
    circlePolygon,
    flattenArea,
    gradeAlongPath,
    meanHeightInside,
} from "./terrain_sculpt";
import {
    CODEX_MAP_STYLE,
    MARKS,
    MARK_BY_ID,
    PLACEABLE_CATEGORIES,
    PLACEMENT_BEHAVIORS,
    clearInside,
    codexLayerKey,
    codexMapPresence,
    createPlacement,
    fillPolygon,
    isCodexLayer,
    layerCoverage,
    layerLabel,
    layerStyle,
    nearestSpot,
    placementsInside,
    populationAt,
    regionsAt,
    suggestBiome,
} from "./planning_layers";
import {
    ACTION_INFO,
    OBJECTIVE_ACTIONS,
    analyzeQuest,
    comfortableDanger,
    questStops,
    targetCategoriesFor,
} from "./quest_planning";
import { formatDuration } from "./travel_calculator";
import { BIOMES, PATH_DEFAULTS, PATH_TYPES, SPOT_COLORS, SPOT_TYPES, isMajorSpotType } from "./planner_defaults";
import {
    CRIMSON_EXPANSE_PRESET,
    NEO_AETHELGARD_PRESET,
    SHATTERED_ISLES_PRESET,
} from "./presets";
import type {
    CodexCategory,
    CodexEntry,
    CodexPlacement,
    GameWorld,
    IntentKind,
    IntentShape,
    Mission,
    PlanIntent,
    ObjectiveAction,
    PlacementBehavior,
    QuestObjectiveDetail,
    RegionPlan,
    RegionType,
    RevisionChange,
    RevisionProposal,
    SculptMode,
    SpotType,
    TravelMode,
    TerrainStyle,
    TravelEstimate,
    WorldPath,
    WorldRegion,
    WorldSpot,
} from "./planner_types";
import type { GameMapConfig, IconName, MapGhostConfig, MapIntentConfig, MapMarkerConfig, MapOverlayConfig, MapQuestRouteConfig, SplitConfig } from "../../addon";

// Register Addon
const addon = Entropy.Addon.register({
    name: "game-world-planner",
    version: "1.4.0",
    description: "Game World Planner: sketch design intents on a topographic map and let agents build them - live intent checks, previewed agent proposals you accept or reject on the map, a terrain-aware built-in planner agent and MCP tools for external agents; terrain sculpting (canyons, mountain ranges, road beds, plateaus), painted biome and population plans tied to regions and the codex, quests planned on the map; plus travel times, procedural terrain, codex and story.",
    author: ["Entropy Team", "Google DeepMind"],
    category: "Game Design",
    capabilities: { ui: true, needsViewport: false },
});

const W = Entropy.UI.Widget;
const icon = (name: IconName, text: string) => Entropy.Icons.label(name, text);

// Theme Palette
type RGBA = [number, number, number, number];
const UI = {
    header: [0.06, 0.08, 0.12, 1] as RGBA,
    nav: [0.05, 0.07, 0.10, 1] as RGBA,
    view: [0.04, 0.05, 0.08, 1] as RGBA,
    panel: [0.07, 0.09, 0.14, 1] as RGBA,
    card: [0.09, 0.12, 0.18, 1] as RGBA,
    line: [0.20, 0.25, 0.35, 1] as RGBA,
    dim: [0.55, 0.62, 0.75, 1] as RGBA,
    text: [0.90, 0.94, 0.98, 1] as RGBA,
    emerald: [0.20, 0.83, 0.60, 1] as RGBA,
    cyan: [0.22, 0.74, 0.97, 1] as RGBA,
    amber: [0.98, 0.75, 0.14, 1] as RGBA,
    rose: [0.95, 0.25, 0.35, 1] as RGBA,
    violet: [0.66, 0.33, 0.97, 1] as RGBA,
};

const TERRAIN_STYLES: Array<{ id: TerrainStyle; label: string }> = [
    { id: "relief", label: "Relief" },
    { id: "heatmap", label: "Heatmap" },
    { id: "slope", label: "Slope" },
    { id: "flat", label: "Flat" },
];

const round2 = (v: number) => Math.round(v * 100) / 100;
const fmtKm = (p: [number, number]) => `[${round2(p[0])}, ${round2(p[1])}] km`;

// Global Model State
let model = new PlannerModel();
let statusMessage = "Welcome to Game World Planner. Draw your map or load a preset.";
let codexCategoryFilter: CodexCategory | "all" = "all";
let codexSearchQuery = "";
let codexStyleFilter = "Dark Fantasy";
let questViewMode: "chronological" | "freeform" = "chronological";
let lastTravelEstimate: TravelEstimate | null = null;
let placeSpotType: SpotType = "town";
/** The last thing the Planner Agent said (why it had nothing to propose, or what it proposed). */
let agentNote: { intentId: string; text: string } | null = null;
/** Populate: points of the current press, until it is clearly a drag (paint) rather than a click (place). */
let populateStroke: { points: [number, number][]; painting: boolean } | null = null;
/** The paint stroke in progress changed this many cells. */
let paintStrokeCells = 0;

const SCULPT_MODES: SculptMode[] = [...BRUSH_MODES, ...LINE_MODES, ...AREA_MODES];
const SCULPT_COLORS: Record<SculptMode, RGBA> = {
    raise: [0.98, 0.75, 0.14, 1],
    lower: [0.22, 0.74, 0.97, 1],
    smooth: [0.66, 0.85, 0.95, 1],
    flatten: [0.2, 0.83, 0.6, 1],
    roughen: [0.85, 0.6, 0.4, 1],
    canyon: [0.95, 0.45, 0.3, 1],
    ridge: [0.98, 0.75, 0.14, 1],
    grade: [0.85, 0.75, 0.55, 1],
    plateau: [0.2, 0.83, 0.6, 1],
};
const MISSION_COLORS: Record<string, RGBA> = { main: [0.98, 0.75, 0.14, 1], side: [0.22, 0.74, 0.97, 1], faction: [0.66, 0.33, 0.97, 1] };

const INTENT_SHAPES: Array<{ id: IntentShape; label: string }> = [
    { id: "pin", label: "Pin" },
    { id: "area", label: "Area" },
    { id: "route", label: "Route" },
];
const TRAVEL_MODES: TravelMode[] = ["foot", "mount", "vehicle", "water", "air"];
const INTENT_ICONS: Record<IntentKind, IconName> = {
    settle: "house-line",
    danger: "skull",
    landmark: "flag",
    connect: "path",
    pacing: "clock",
    quest: "sword",
    freeform: "lightbulb",
};

// Procedural Parameters State
let procSeed = model.world.meta.seed;
let procMountainScale = 2600;
let procRuggedness = 0.55;
let procLandBias = 0;
let procResolution = 129;
let procErosionDroplets = 30000;
let procRiverCount = 4;
let procCarveRivers = true;
let procScatterCount = 6;
let procIslandMask = true;
let procFitSpots = true;
let padRadiusKm = 0.5;

function setModel(next: PlannerModel): void {
    const fit = model.fitRequest + 1;
    model = next;
    model.fitRequest = fit;
    procSeed = model.world.meta.seed;
    procIslandMask = model.world.meta.genre === "fantasy";
    lastTravelEstimate = null;
    agentNote = null;
    populateStroke = null;
}

// --- Persistence ---

function saveWorld(): void {
    try {
        addon.IO.save(model.world, { pretty: false });
        model.isDirty = false;
        statusMessage = `Saved "${model.world.meta.name}" to world_plan.json.`;
        Entropy.UI.toast?.({
            id: "planner-save",
            message: `Saved "${model.world.meta.name}".`,
            kind: "success",
            durationMs: 2500,
        });
    } catch (e) {
        statusMessage = `Failed to save: ${e}`;
        Entropy.UI.toast?.({
            id: "planner-save",
            message: `Could not save world: ${e}`,
            kind: "error",
            durationMs: 0,
            actionLabel: "Retry",
            onAction: () => saveWorld(),
        });
    }
}

function loadWorld(): void {
    try {
        const loaded = addon.IO.load() as GameWorld | null;
        if (loaded && loaded.meta && loaded.spots) {
            const hadTerrain = !!loaded.terrain;
            setModel(new PlannerModel(loaded));
            statusMessage = `Loaded "${model.world.meta.name}" (${model.world.spots.length} spots, ${model.world.paths.length} paths).`;
            if (!hadTerrain) saveWorld();
        } else {
            setModel(new PlannerModel(SHATTERED_ISLES_PRESET));
            saveWorld();
        }
    } catch (e) {
        Entropy.println(`Game World Planner: using preset due to load error: ${e}`);
        setModel(new PlannerModel(SHATTERED_ISLES_PRESET));
    }
}

// --- Selection helpers ---

function deleteSelected(): void {
    if (model.selectedChangeId) {
        decideChange(model.selectedChangeId, false);
        return;
    }
    const id = model.selectedId;
    if (!id) return;
    const placement = model.placements.find((p) => p.id === id);
    if (placement) {
        model.deletePlacement(id);
        statusMessage = `Removed ${codexName(placement.codexId)} from the map.`;
        return;
    }
    const intent = model.intents.find((i) => i.id === id);
    if (intent) {
        model.deleteIntent(id);
        statusMessage = `Deleted intent #${intent.number} "${intent.title}".`;
        return;
    }
    const spot = model.world.spots.find((s) => s.id === id);
    const path = model.world.paths.find((p) => p.id === id);
    const region = model.world.regions.find((r) => r.id === id);
    if (spot) {
        model.deleteSpot(id);
        statusMessage = `Deleted spot "${spot.name}".`;
    } else if (path) {
        model.deletePath(id);
        statusMessage = `Deleted path "${path.name}".`;
    } else if (region) {
        model.deleteRegion(id);
        statusMessage = `Deleted region "${region.name}".`;
    }
}

function selectTool(tool: typeof model.activeTool): void {
    if (tool !== "draw_path") model.cancelPendingPath();
    if (tool !== "draw_region") model.cancelPendingRegion();
    if (tool !== "intent") model.cancelPendingIntent();
    if (tool !== "sculpt") model.pendingSculptPoints = [];
    if (tool === "populate" && !model.populateCodexId) model.populateCodexId = placeableCodex()[0]?.id ?? null;
    if (tool === "measure" || model.activeTool === "measure") {
        model.clearMeasurement();
        lastTravelEstimate = null;
    }
    model.activeTool = tool;
    const names: Record<typeof model.activeTool, string> = {
        select: "Select: click to select, drag spots to move them.",
        pan: "Pan: drag to move the view.",
        place_spot: `Add Spot: click the map to place a ${placeSpotType}.`,
        draw_path: "Draw Path: click to add points (they snap to spots), double-click or Enter to finish.",
        draw_region: "Draw Region: click to add vertices, double-click or Enter to close it.",
        measure: "Measure: click a start point, then a destination.",
        intent: intentToolHint(),
        sculpt: sculptHint(),
        paint: `Paint: drag to mark ${layerLabel(model.world, model.paintKey)} - planning marks only, nothing is built.`,
        populate: populateHint(),
    };
    statusMessage = names[tool];
}

function sculptHint(): string {
    const info = SCULPT_INFO[model.sculpt.mode];
    return `Sculpt (${info.label}): ${info.how}`;
}

function populateHint(): string {
    const c = model.world.codex.find((e) => e.id === model.populateCodexId);
    if (!c) return "Populate: add a character or creature to the Codex first, then place or paint it here.";
    return `Populate (${c.name}): click to place ${CODEX_MAP_STYLE[c.category].noun === "enemy" ? "a pack" : "them"}, drag to paint where they roam.`;
}

function codexName(id?: string): string {
    return (id && model.world.codex.find((c) => c.id === id)?.name) || "(missing codex entry)";
}

/** Codex entries that can go on the map, enemies and NPCs first. */
function placeableCodex(): CodexEntry[] {
    const rank = (c: CodexEntry) => PLACEABLE_CATEGORIES.indexOf(c.category);
    return model.world.codex.filter((c) => rank(c) >= 0).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function codexOptionLabel(c: CodexEntry): string {
    return `${c.name} (${CODEX_MAP_STYLE[c.category]?.noun ?? c.category})`;
}

/** Applies the clicked-out canyon / range / road bed / plateau. */
function finishSculptShape(): boolean {
    const n = model.pendingSculptPoints.length;
    const label = SCULPT_INFO[model.sculpt.mode].label;
    if (!model.sculptShape()) return false;
    const t = model.world.terrain!;
    statusMessage = `${label} applied along ${n} points. Terrain now ${Math.round(t.minM)} to ${Math.round(t.maxM)} m; snapped spots re-read their ground.`;
    return true;
}

/** Brush strokes from the map: sculpt, paint, or populate (click = place, drag = paint). */
function handleBrushStroke(points: [number, number][], done: boolean): void {
    if (model.activeTool === "sculpt") {
        model.sculptBrush(points, done);
        if (done) statusMessage = `${SCULPT_INFO[model.sculpt.mode].label}: stroke applied (one undo step).`;
        return;
    }
    if (model.activeTool === "paint") {
        paintStrokeCells += model.paint(model.paintKey, points, done);
        if (done) {
            statusMessage = `${model.paintErase ? "Erased" : "Painted"} ${layerLabel(model.world, model.paintKey)} (${paintStrokeCells} cells)${model.paintClipRegionId ? " inside the region" : ""}.`;
            paintStrokeCells = 0;
        }
        return;
    }
    if (model.activeTool !== "populate") return;
    const codex = model.world.codex.find((c) => c.id === model.populateCodexId);
    if (!codex) {
        if (done) statusMessage = populateHint();
        return;
    }
    const key = codexLayerKey(codex.id);
    populateStroke ??= { points: [], painting: false };
    const st = populateStroke;
    if (st.painting) {
        model.paint(key, points, false, { exclusive: false });
    } else {
        st.points.push(...points);
        const [x0, y0] = st.points[0] ?? [0, 0];
        const spread = Math.max(0, ...st.points.map(([x, y]) => Math.hypot(x - x0, y - y0)));
        if (spread > Math.max(0.25, model.paintRadiusKm * 0.4)) {
            st.painting = true;
            model.paint(key, st.points, false, { exclusive: false });
        }
    }
    if (!done) return;
    if (st.painting) {
        model.paint(key, [], true);
        statusMessage = `Painted where ${codex.name} ${codex.category === "creature" ? "roams" : "can be found"}.`;
    } else if (st.points.length) {
        const [x, y] = st.points[0];
        const p = model.addPlacement(createPlacement(codex, model.snapCoordinate(x), model.snapCoordinate(y)));
        const near = nearestSpot(model.world, p.x, p.y, 1.0);
        statusMessage = `Placed ${codex.name}${p.count > 1 ? ` x${p.count}` : ""} at ${fmtKm([p.x, p.y])}${near ? `, by ${near.name}` : ""}. Edit it in the inspector.`;
    }
    populateStroke = null;
}

function intentToolHint(): string {
    const kind = model.intentKind === "auto" ? "" : ` (${INTENT_KIND_INFO[model.intentKind].label})`;
    if (model.intentShape === "pin") return `Intent${kind}: click the place you have in mind - an agent builds it.`;
    if (model.intentShape === "route") return `Intent${kind}: click where a journey starts, then where it ends (snaps to spots).`;
    return `Intent${kind}: outline the area you have in mind; Enter or double-click closes it.`;
}

function announceIntent(intent: PlanIntent): void {
    const ev = evaluateIntent(model.world, intent);
    statusMessage = `Intent #${intent.number} (${intent.kind}) sketched - ${ev.summary}. Describe it in the inspector, then let an agent draft it.`;
}

function finishDrawing(): boolean {
    if (model.activeTool === "sculpt" && model.sculptKind !== "brush") return finishSculptShape();
    if (model.activeTool === "intent" && model.intentShape === "area" && model.pendingIntentPoints.length >= 3) {
        const intent = model.finishPendingIntent();
        if (intent) announceIntent(intent);
        return true;
    }
    if (model.activeTool === "draw_path" && model.pendingPathPoints.length >= 2) {
        const p = model.finishPendingPath();
        if (p) statusMessage = `Created ${p.pathType} "${p.name}" (${round2(pathPolylineLengthKm(p.points))} km, ${p.points.length} points).`;
        return true;
    }
    if (model.activeTool === "draw_region" && model.pendingRegionPoints.length >= 3) {
        const r = model.finishPendingRegion();
        if (r) statusMessage = `Created region "${r.name}" with ${r.points.length} vertices.`;
        return true;
    }
    return false;
}

function cancelAction(): void {
    if (model.pendingPathPoints.length || model.pendingRegionPoints.length || model.pendingIntentPoints.length || model.pendingSculptPoints.length) {
        model.cancelPendingPath();
        model.cancelPendingRegion();
        model.cancelPendingIntent();
        model.pendingSculptPoints = [];
        statusMessage = "Drawing cancelled.";
    } else if (model.selectedChangeId) {
        model.selectedChangeId = null;
    } else if (model.measurePoints.p1) {
        model.clearMeasurement();
        lastTravelEstimate = null;
        statusMessage = "Ruler cleared.";
    } else if (model.activeTool !== "select") {
        selectTool("select");
    } else if (model.highlightedQuestId && !model.selectedId) {
        model.highlightedQuestId = null;
    } else {
        model.selectedId = null;
        model.selectedPlacementId = null;
    }
}

// --- Header Navigation & Global Actions ---

function renderHeader(tabId: string): void {
    W.bar(
        tabId,
        { id: "planner_header", height: 50, fill: UI.header, border: UI.line, paddingX: 12 },
        (left: string) => {
            W.horizontal(left, () => {
                W.label(left, { text: icon("map-trifold", "World Planner"), bold: true, fontSize: 14, color: UI.emerald });
                W.spacer(left, 12);

                const tabs: Array<{ id: typeof model.activeTab; label: string }> = [
                    { id: "map", label: icon("map-trifold", "Map") },
                    { id: "codex", label: icon("book-open", "Codex") },
                    { id: "story", label: icon("sword", "Story & Quests") },
                    { id: "agent", label: icon("robot", model.pendingProposals.length ? `Agents (${model.pendingProposals.length})` : "Agents") },
                ];

                tabs.forEach((t) => {
                    W.button(left, {
                        id: `nav_tab_${t.id}`,
                        text: t.label,
                        accent: model.activeTab === t.id ? UI.emerald : undefined,
                        onClick: () => {
                            model.activeTab = t.id;
                        },
                    });
                });
            });
        },
        (center: string) => {
            W.horizontal(center, () => {
                const blocking = model.world.meta.blockingMode;
                W.button(center, {
                    id: "btn_toggle_blocking",
                    text: blocking ? icon("stack", "Blocking") : icon("faders-horizontal", "Detailing"),
                    tooltip: "Blocking shows only major spots, paths and regions (B)",
                    accent: blocking ? UI.amber : UI.emerald,
                    onClick: () => {
                        model.setBlockingMode(!blocking);
                        statusMessage = blocking ? "Switched to Detailing mode (full micro-scatter visible)." : "Switched to Blocking mode (macro-structure only).";
                    },
                });

                W.spacer(center, 8);

                const snaps = [0, 50, 100, 250, 500, 1000];
                const snapLabels = ["Off", "50 m", "100 m", "250 m", "500 m", "1 km"];
                W.dropdown(center, {
                    id: "dropdown_grid_snap",
                    label: "Snap",
                    options: snapLabels,
                    selectedIndex: Math.max(0, snaps.indexOf(model.world.meta.gridSnapM)),
                    onChange: (v: string) => {
                        model.setGridSnap(snaps[Number(v)] || 0);
                    },
                });
            });
        },
        (right: string) => {
            W.horizontal(right, () => {
                W.button(right, {
                    id: "btn_undo",
                    text: icon("arrow-counter-clockwise", "Undo"),
                    tooltip: "Ctrl+Z",
                    onClick: () => {
                        if (model.undo()) statusMessage = "Undo action performed.";
                    },
                });
                W.button(right, {
                    id: "btn_redo",
                    text: icon("arrow-clockwise", "Redo"),
                    tooltip: "Ctrl+Y",
                    onClick: () => {
                        if (model.redo()) statusMessage = "Redo action performed.";
                    },
                });
                W.spacer(right, 8);
                W.button(right, {
                    id: "btn_save",
                    text: icon("floppy-disk", model.isDirty ? "Save *" : "Save"),
                    tooltip: "Ctrl+S",
                    accent: model.isDirty ? UI.amber : undefined,
                    onClick: () => saveWorld(),
                });

                const presets = [SHATTERED_ISLES_PRESET, NEO_AETHELGARD_PRESET, CRIMSON_EXPANSE_PRESET];
                const presetOptions = ["Shattered Isles (Fantasy)", "Neo-Aethelgard (Cyberpunk)", "Crimson Expanse (Sci-Fi)"];
                const currentPresetIdx = Math.max(0, presets.findIndex((p) => p.meta.id === model.world.meta.id));
                W.dropdown(right, {
                    id: "dropdown_presets",
                    label: "Preset",
                    options: presetOptions,
                    selectedIndex: currentPresetIdx,
                    onChange: (v: string) => {
                        setModel(new PlannerModel(presets[Number(v)] || SHATTERED_ISLES_PRESET));
                        saveWorld();
                        statusMessage = `Switched to ${model.world.meta.name}.`;
                    },
                });
            });
        }
    );
}

// --- Status Bar ---

function renderStatusBar(tabId: string): void {
    W.bar(
        tabId,
        { id: "planner_status_bar", height: 26, fill: UI.nav, border: UI.line, borderTop: true, paddingX: 12 },
        (left: string) => {
            W.label(left, { text: statusMessage, fontSize: 11, color: UI.dim });
        },
        undefined,
        (right: string) => {
            const counts = `${model.world.spots.length} Spots | ${model.world.paths.length} Paths | ${model.world.regions.length} Regions | ${model.world.codex.length} Codex | ${model.world.missions.length} Quests | ${model.intents.length} Intents`;
            W.label(right, { text: counts, fontSize: 11, color: UI.emerald });
        }
    );
}

// =================================================================================================
// TAB 1: MAP VIEWPORT & PROPERTY INSPECTOR
// =================================================================================================

function renderMapView(main: string): void {
    W.split(
        main,
        {
            id: "map_split_view",
            sideOpen: true,
            sideWidth: 340,
            minHeight: 650,
            mainPadding: 0,
            sidePadding: 12,
            scrollMain: false,
            scrollSide: true,
        } as SplitConfig,
        (canvasArea: string) => {
            renderMapCanvasAndToolbar(canvasArea);
        },
        (inspectorArea: string) => {
            renderInspector(inspectorArea);
        }
    );
}

function renderMapToolbar(canvasArea: string): void {
    W.bar(
        canvasArea,
        { id: "map_toolbar", height: 38, fill: UI.nav, border: UI.line, paddingX: 10 },
        (left: string) => {
            W.horizontal(left, () => {
                const tools: Array<{ id: typeof model.activeTool; label: string; key: string }> = [
                    { id: "select", label: icon("cursor", "Select"), key: "V" },
                    { id: "pan", label: icon("hand", "Pan"), key: "H" },
                    { id: "place_spot", label: icon("map-pin-plus", "Spot"), key: "P" },
                    { id: "draw_path", label: icon("path", "Path"), key: "L" },
                    { id: "draw_region", label: icon("polygon", "Region"), key: "G" },
                    { id: "measure", label: icon("ruler", "Measure"), key: "M" },
                    { id: "intent", label: icon("lightbulb", "Intent"), key: "I" },
                    { id: "sculpt", label: icon("shovel", "Sculpt"), key: "E" },
                    { id: "paint", label: icon("paint-brush", "Paint"), key: "N" },
                    { id: "populate", label: icon("users", "Populate"), key: "U" },
                ];
                tools.forEach((t) => {
                    W.button(left, {
                        id: `tool_${t.id}`,
                        text: t.label,
                        tooltip: `Shortcut: ${t.key}`,
                        accent: model.activeTool === t.id ? UI.cyan : undefined,
                        onClick: () => selectTool(t.id),
                    });
                });
            });
        },
        (center: string) => {
            W.horizontal(center, () => {
                if (model.activeTool === "place_spot") {
                    W.dropdown(center, {
                        id: "dropdown_place_spot_type",
                        label: "Type",
                        options: SPOT_TYPES.map((t) => t[0].toUpperCase() + t.slice(1)),
                        selectedIndex: Math.max(0, SPOT_TYPES.indexOf(placeSpotType)),
                        onChange: (v: string) => {
                            placeSpotType = SPOT_TYPES[Number(v)] || "town";
                        },
                    });
                } else if (model.activeTool === "draw_path") {
                    W.dropdown(center, {
                        id: "dropdown_pending_path_type",
                        label: "Type",
                        options: PATH_TYPES.map((t) => t[0].toUpperCase() + t.slice(1)),
                        selectedIndex: Math.max(0, PATH_TYPES.indexOf(model.pendingPathType)),
                        onChange: (v: string) => {
                            model.pendingPathType = PATH_TYPES[Number(v)] || "road";
                        },
                    });
                    if (model.pendingPathPoints.length > 0) {
                        W.label(center, { text: `${model.pendingPathPoints.length} pts · ${round2(pathPolylineLengthKm(model.pendingPathPoints))} km`, fontSize: 11, color: UI.cyan, bold: true });
                        W.button(center, { id: "btn_finish_path", text: icon("check", "Finish"), tooltip: "Enter", accent: UI.emerald, onClick: () => finishDrawing() });
                        W.button(center, { id: "btn_undo_path_pt", text: icon("arrow-counter-clockwise", "Point"), onClick: () => model.undoPendingPathPoint() });
                        W.button(center, { id: "btn_cancel_path", text: icon("x", "Cancel"), tooltip: "Esc", onClick: () => model.cancelPendingPath() });
                    }
                } else if (model.activeTool === "draw_region") {
                    W.dropdown(center, {
                        id: "dropdown_pending_region_biome",
                        label: "Biome",
                        options: BIOMES.map((b) => b[0].toUpperCase() + b.slice(1)),
                        selectedIndex: Math.max(0, BIOMES.indexOf(model.pendingRegionBiome)),
                        onChange: (v: string) => {
                            model.pendingRegionBiome = BIOMES[Number(v)] || "plains";
                        },
                    });
                    if (model.pendingRegionPoints.length > 0) {
                        W.label(center, { text: `${model.pendingRegionPoints.length} vertices`, fontSize: 11, color: UI.emerald, bold: true });
                        W.button(center, { id: "btn_finish_region", text: icon("check", "Close"), tooltip: "Enter", accent: UI.emerald, onClick: () => finishDrawing() });
                        W.button(center, { id: "btn_undo_region_pt", text: icon("arrow-counter-clockwise", "Point"), onClick: () => model.undoPendingRegionPoint() });
                        W.button(center, { id: "btn_cancel_region", text: icon("x", "Cancel"), tooltip: "Esc", onClick: () => model.cancelPendingRegion() });
                    }
                } else if (model.activeTool === "intent") {
                    W.segmented(center, {
                        id: "seg_intent_shape",
                        options: INTENT_SHAPES.map((x) => x.label),
                        selectedIndex: Math.max(0, INTENT_SHAPES.findIndex((x) => x.id === model.intentShape)),
                        compact: true,
                        accent: UI.amber,
                        onChange: (v: string) => {
                            model.intentShape = INTENT_SHAPES[Number(v)]?.id || "area";
                            model.cancelPendingIntent();
                            if (model.intentKind !== "auto" && !INTENT_KIND_INFO[model.intentKind].shapes.includes(model.intentShape)) model.intentKind = "auto";
                            statusMessage = intentToolHint();
                        },
                    });
                    const kinds = INTENT_KINDS.filter((k) => INTENT_KIND_INFO[k].shapes.includes(model.intentShape));
                    W.dropdown(center, {
                        id: "dropdown_intent_kind",
                        label: "Kind",
                        options: ["Auto", ...kinds.map((k) => INTENT_KIND_INFO[k].label)],
                        selectedIndex: model.intentKind === "auto" ? 0 : Math.max(0, kinds.indexOf(model.intentKind) + 1),
                        onChange: (v: string) => {
                            const i = Number(v);
                            model.intentKind = i === 0 ? "auto" : kinds[i - 1] || "auto";
                            statusMessage = intentToolHint();
                        },
                    });
                    if (model.pendingIntentPoints.length > 0) {
                        W.label(center, { text: `${model.pendingIntentPoints.length} pts`, fontSize: 11, color: UI.amber, bold: true });
                        if (model.intentShape === "area") W.button(center, { id: "btn_finish_intent", text: icon("check", "Close"), tooltip: "Enter", accent: UI.emerald, onClick: () => finishDrawing() });
                        W.button(center, { id: "btn_cancel_intent", text: icon("x", "Cancel"), tooltip: "Esc", onClick: () => model.cancelPendingIntent() });
                    }
                } else if (model.activeTool === "sculpt") {
                    W.dropdown(center, {
                        id: "dropdown_sculpt_mode",
                        label: "Mode",
                        options: SCULPT_MODES.map((m) => SCULPT_INFO[m].label),
                        selectedIndex: Math.max(0, SCULPT_MODES.indexOf(model.sculpt.mode)),
                        onChange: (v: string) => {
                            model.sculpt.mode = SCULPT_MODES[Number(v)] || "raise";
                            model.pendingSculptPoints = [];
                            statusMessage = sculptHint();
                        },
                    });
                    if (model.pendingSculptPoints.length > 0) {
                        W.label(center, { text: `${model.pendingSculptPoints.length} pts`, fontSize: 11, color: UI.amber, bold: true });
                        W.button(center, { id: "btn_apply_sculpt", text: icon("check", "Apply"), tooltip: "Enter", accent: UI.emerald, onClick: () => finishSculptShape() });
                        W.button(center, { id: "btn_cancel_sculpt", text: icon("x", "Cancel"), tooltip: "Esc", onClick: () => (model.pendingSculptPoints = []) });
                    }
                } else if (model.activeTool === "paint") {
                    const keys = paintKeys();
                    W.dropdown(center, {
                        id: "dropdown_paint_mark",
                        label: "Mark",
                        options: keys.map((k) => layerLabel(model.world, k)),
                        selectedIndex: Math.max(0, keys.indexOf(model.paintKey)),
                        onChange: (v: string) => {
                            model.paintKey = keys[Number(v)] || "forest";
                            statusMessage = `Painting ${layerLabel(model.world, model.paintKey)}.`;
                        },
                    });
                    W.button(center, { id: "btn_paint_erase", text: icon("eraser", "Erase"), accent: model.paintErase ? UI.rose : undefined, onClick: () => (model.paintErase = !model.paintErase) });
                } else if (model.activeTool === "populate") {
                    const entries = placeableCodex();
                    W.dropdown(center, {
                        id: "dropdown_populate_codex",
                        label: "Who",
                        options: entries.length ? entries.map(codexOptionLabel) : ["(no characters or creatures yet)"],
                        selectedIndex: Math.max(0, entries.findIndex((c) => c.id === model.populateCodexId)),
                        onChange: (v: string) => {
                            model.populateCodexId = entries[Number(v)]?.id ?? null;
                            statusMessage = populateHint();
                        },
                    });
                    W.button(center, { id: "btn_populate_erase", text: icon("eraser", "Erase paint"), accent: model.paintErase ? UI.rose : undefined, onClick: () => (model.paintErase = !model.paintErase) });
                } else if (model.activeTool === "measure" && (model.measurePoints.p1 || lastTravelEstimate)) {
                    if (lastTravelEstimate) {
                        W.label(center, { text: `${lastTravelEstimate.directDistanceKm} km · ${lastTravelEstimate.summaryText}`, fontSize: 11, color: UI.amber });
                    }
                    W.button(center, {
                        id: "btn_clear_measure",
                        text: icon("x", "Clear"),
                        onClick: () => {
                            model.clearMeasurement();
                            lastTravelEstimate = null;
                            statusMessage = "Ruler cleared.";
                        },
                    });
                }
            });
        },
        (right: string) => {
            W.horizontal(right, () => {
                const h = planHealth(model.world);
                if (h.total) {
                    const checked = h.met + h.unmet;
                    W.label(right, {
                        text: icon(h.unmet ? "target" : "check-circle", `Plan ${h.met}/${checked} met${h.manual ? ` · ${h.manual} by hand` : ""}`),
                        fontSize: 11,
                        bold: true,
                        color: h.unmet ? UI.amber : UI.emerald,
                    });
                }
                const pending = model.pendingProposals.length;
                if (pending) {
                    W.button(right, {
                        id: "btn_review_proposals",
                        text: icon("robot", `${pending} to review`),
                        tooltip: "Open the agent inbox",
                        accent: UI.violet,
                        onClick: () => (model.activeTab = "agent"),
                    });
                } else if (h.unmet) {
                    W.button(right, {
                        id: "btn_draft_all_map",
                        text: icon("robot", "Draft open intents"),
                        tooltip: `Let the ${PLANNER_AGENT_NAME} propose changes for every unmet intent`,
                        accent: UI.cyan,
                        onClick: () => draftAllOpen(),
                    });
                }
            });
        }
    );

    // Second row: terrain style and layers.
    W.bar(
        canvasArea,
        { id: "map_layers_bar", height: 34, fill: UI.panel, border: UI.line, paddingX: 10 },
        (left: string) => {
            W.horizontal(left, () => {
                W.segmented(left, {
                    id: "seg_terrain_style",
                    label: "Terrain",
                    options: TERRAIN_STYLES.map((s) => s.label),
                    selectedIndex: Math.max(0, TERRAIN_STYLES.findIndex((s) => s.id === model.terrainStyle)),
                    compact: true,
                    accent: UI.emerald,
                    onChange: (v: string) => {
                        model.terrainStyle = TERRAIN_STYLES[Number(v)]?.id || "relief";
                        statusMessage = `Terrain shown as ${model.terrainStyle}.`;
                    },
                });
            });
        },
        undefined,
        (right: string) => {
            W.horizontal(right, () => {
                const toggle = (id: string, label: string, on: boolean, flip: () => void) =>
                    W.button(right, { id, text: label, accent: on ? UI.emerald : undefined, onClick: flip });
                toggle("btn_toggle_contours", icon("mountains", "Contours"), model.showContours, () => (model.showContours = !model.showContours));
                toggle("btn_toggle_biomes", icon("polygon", "Regions"), model.showBiomes, () => (model.showBiomes = !model.showBiomes));
                toggle("btn_toggle_marks", icon("tree", "Marks"), model.showMarks, () => (model.showMarks = !model.showMarks));
                toggle("btn_toggle_population", icon("users", "Population"), model.showPopulation, () => (model.showPopulation = !model.showPopulation));
                toggle("btn_toggle_quests", icon("sword", "Quests"), model.showQuests, () => (model.showQuests = !model.showQuests));
                toggle("btn_toggle_intents", icon("lightbulb", "Intents"), model.showIntents, () => (model.showIntents = !model.showIntents));
                toggle("btn_toggle_proposals", icon("ghost", "Proposals"), model.showProposals, () => (model.showProposals = !model.showProposals));
                toggle("btn_toggle_labels", icon("tag", "Labels"), model.showLabels, () => (model.showLabels = !model.showLabels));
                toggle("btn_toggle_grid", icon("grid-four", "Grid"), model.showGrid, () => (model.showGrid = !model.showGrid));
                toggle("btn_toggle_minimap", icon("map-trifold", "Overview"), model.showMinimap, () => (model.showMinimap = !model.showMinimap));
                W.button(right, {
                    id: "btn_world_panel",
                    text: icon("mountains", "World"),
                    tooltip: "Clear the selection: the sidebar shows the plan, terrain and procedural tools",
                    accent: !model.selectedId ? UI.cyan : undefined,
                    onClick: () => {
                        model.selectedId = null;
                        model.selectedChangeId = null;
                        model.selectedPlacementId = null;
                    },
                });
                W.button(right, {
                    id: "btn_fit_world",
                    text: icon("corners-out", "Fit"),
                    tooltip: "F",
                    onClick: () => {
                        model.fitRequest++;
                    },
                });
            });
        }
    );
}

function travelBetween(a: [number, number], b: [number, number]): TravelEstimate {
    const t = model.world.terrain;
    return calculateTravelTime(a, b, model.world.paths, model.world.regions, t ? { terrain: t, meta: model.world.meta } : undefined);
}

function handleMapClick(x: number, y: number): void {
    const pt: [number, number] = [Number(x.toFixed(4)), Number(y.toFixed(4))];
    const [sx, sy] = pt;
    if (model.activeTool === "place_spot") {
        const n = model.world.spots.filter((s) => s.spotType === placeSpotType).length + 1;
        const isMajor = isMajorSpotType(placeSpotType);
        const newSpot = model.addSpot({
            name: `New ${placeSpotType[0].toUpperCase()}${placeSpotType.slice(1)} ${n}`,
            spotType: placeSpotType,
            x: sx,
            y: sy,
            elevation: model.elevationAt(sx, sy, 120),
            color: SPOT_COLORS[placeSpotType],
            icon: placeSpotType,
            tags: [placeSpotType],
            isMajor,
            dangerLevel: placeSpotType === "dungeon" || placeSpotType === "boss" ? 7 : 1,
            description: "A newly marked location awaiting exploration.",
            loreNotes: "",
            linkedCodexIds: [],
            linkedMissionIds: [],
        });
        const elev = newSpot.elevation;
        statusMessage = elev <= model.world.meta.seaLevelM
            ? `Placed "${newSpot.name}" at ${fmtKm(pt)} - note: that is ${model.world.meta.seaLevelM - elev} m under water.`
            : `Placed "${newSpot.name}" at ${fmtKm(pt)}, ${elev} m above sea level.`;
    } else if (model.activeTool === "draw_path") {
        model.appendPendingPathPoint(pt);
        statusMessage = `Path point #${model.pendingPathPoints.length} at ${fmtKm(pt)} - ${round2(pathPolylineLengthKm(model.pendingPathPoints))} km so far.`;
    } else if (model.activeTool === "draw_region") {
        model.appendPendingRegionPoint(pt);
        statusMessage = `Region vertex #${model.pendingRegionPoints.length} at ${fmtKm(pt)}.`;
    } else if (model.activeTool === "measure") {
        if (!model.measurePoints.p1 || model.measurePoints.p2) {
            // First click, or a new measurement after a finished one.
            model.measurePoints = { p1: pt };
            lastTravelEstimate = null;
            statusMessage = `Measuring from ${fmtKm(pt)} - click the destination.`;
        } else {
            model.measurePoints.p2 = pt;
            lastTravelEstimate = travelBetween(model.measurePoints.p1, pt);
            const est = lastTravelEstimate;
            const climb = est.climbM !== undefined ? ` · climb +${est.climbM} m / -${est.descentM} m` : "";
            statusMessage = `Distance: ${est.directDistanceKm} km${climb}${est.pathFound ? " (by road)" : ""}. ${est.summaryText}`;
        }
    } else if (model.activeTool === "sculpt") {
        if (model.sculptKind === "brush") return;
        model.pendingSculptPoints.push(pt);
        statusMessage = `${SCULPT_INFO[model.sculpt.mode].label} point #${model.pendingSculptPoints.length} - Enter or double-click to apply.`;
    } else if (model.activeTool === "intent") {
        const intent = model.appendPendingIntentPoint(pt);
        if (intent) {
            announceIntent(intent);
        } else if (model.intentShape === "route") {
            const s = spotNear(model.world, pt);
            statusMessage = `Journey starts at ${s ? s.name : fmtKm(pt)} - click where it ends.`;
        } else {
            statusMessage = `Intent area vertex #${model.pendingIntentPoints.length} - Enter or double-click to close.`;
        }
    } else if (model.activeTool === "select") {
        model.selectedId = null;
        model.selectedChangeId = null;
        model.selectedPlacementId = null;
    }
}

/** Mark ids, then the codex layers already painted. */
function paintKeys(): string[] {
    const painted = Object.keys(model.world.overlay?.layers ?? {}).filter(isCodexLayer);
    const keys = [...MARKS.map((m) => m.id), ...painted];
    if (!keys.includes(model.paintKey)) keys.push(model.paintKey);
    return keys;
}

/** The painted overlay as the map draws it. */
function mapOverlay(): MapOverlayConfig | undefined {
    const o = model.world.overlay;
    if (!o || !Object.keys(o.layers).length) return undefined;
    return {
        cols: o.cols,
        rows: o.rows,
        layers: Object.entries(o.layers).map(([key, data]) => {
            const st = layerStyle(model.world, key);
            return { key, label: layerLabel(model.world, key), color: st.color, glyph: st.glyph, data };
        }),
    };
}

function placementDetail(p: CodexPlacement): string {
    const c = model.world.codex.find((e) => e.id === p.codexId);
    const noun = c ? CODEX_MAP_STYLE[c.category].noun : "entry";
    const lv = p.levelMin !== undefined || p.levelMax !== undefined ? ` · lv ${p.levelMin ?? "?"}-${p.levelMax ?? "?"}` : "";
    return `${noun}${p.count > 1 ? ` x${p.count}` : ""} · ${p.behavior.replace("_", " ")}${lv}${p.notes ? ` · ${p.notes.slice(0, 40)}` : ""}`;
}

function mapMarkers(): MapMarkerConfig[] {
    return model.placements.map((p) => {
        const c = model.world.codex.find((e) => e.id === p.codexId);
        const st = CODEX_MAP_STYLE[c?.category ?? "lore"];
        return { id: p.id, label: c?.name ?? "?", detail: placementDetail(p), x: p.x, y: p.y, color: st.color, glyph: st.glyph, count: p.count };
    });
}

function mapQuestRoutes(): MapQuestRouteConfig[] {
    return model.world.missions
        .filter((m) => model.showQuests || m.id === model.highlightedQuestId)
        .map((m) => ({ m, stops: questStops(model.world, m) }))
        .filter(({ stops }) => stops.length >= 2)
        .map(({ m, stops }) => ({
            id: m.id,
            title: m.title,
            points: stops.map((s) => [s.x, s.y] as [number, number]),
            color: MISSION_COLORS[m.missionType] ?? UI.amber,
            highlighted: m.id === model.highlightedQuestId,
        }));
}

/** The brush ring for the active tool, if it has one. */
function mapBrush(): GameMapConfig["brush"] {
    if (model.activeTool === "sculpt") {
        const kind = model.sculptKind;
        const s = model.sculpt;
        const radius = kind === "brush" ? s.radiusKm : s.mode === "canyon" ? s.canyonWidthKm / 2 : s.mode === "ridge" ? s.ridgeWidthKm / 2 : s.mode === "grade" ? s.gradeWidthKm / 2 + Math.max(0.15, s.gradeWidthKm) : s.featherKm;
        return { radiusKm: radius, color: SCULPT_COLORS[s.mode], paint: kind === "brush" };
    }
    if (model.activeTool === "paint") return { radiusKm: model.paintRadiusKm, color: model.paintErase ? UI.rose : layerStyle(model.world, model.paintKey).color, paint: true };
    if (model.activeTool === "populate") {
        const c = model.world.codex.find((e) => e.id === model.populateCodexId);
        return { radiusKm: model.paintRadiusKm, color: model.paintErase ? UI.rose : CODEX_MAP_STYLE[c?.category ?? "creature"].color, paint: true };
    }
    return undefined;
}

/** Shows a quest's journey on the map. */
function showQuestOnMap(m: Mission): void {
    model.activeTab = "map";
    model.highlightedQuestId = m.id;
    model.selectedId = null;
    const stops = questStops(model.world, m);
    if (stops.length) {
        const xs = stops.map((s) => s.x);
        const ys = stops.map((s) => s.y);
        const span = Math.max(1.5, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        model.focusOn((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, Math.max(8, Math.min(120, 700 / span)));
    }
    statusMessage = `Showing "${m.title}" on the map: ${analyzeQuest(model.world, m).summary}. Esc hides it.`;
}

// --- The agent loop: draft, review, decide ---

/** An intent named by an agent, by `intentId` or by its `#number`. */
function findIntentArg(args: any): PlanIntent | undefined {
    if (args?.intentId) return model.intents.find((i) => i.id === args.intentId);
    if (args?.intentNumber !== undefined) return model.intents.find((i) => i.number === Number(args.intentNumber));
    return undefined;
}

/** Runs the built-in Planner Agent on one intent and files its proposal for review. */
function draftIntent(intent: PlanIntent): RevisionProposal | null {
    const { proposal, reason } = draftProposalForIntent(model.world, intent);
    agentNote = { intentId: intent.id, text: reason };
    if (!proposal) {
        statusMessage = `${PLANNER_AGENT_NAME} on #${intent.number}: ${reason}`;
        return null;
    }
    // A new draft replaces the agent's earlier, still-pending one for this intent.
    const stale = model.world.proposals.filter((p) => p.intentId === intent.id && p.agentName === PLANNER_AGENT_NAME && isProposalPending(p));
    stale.forEach((p) => model.decideProposal(p.id, false));
    model.addProposal(proposal);
    statusMessage = `${PLANNER_AGENT_NAME} proposed ${proposal.changes.length} change(s) for #${intent.number}: ${reason} Review them on the map (violet).`;
    return proposal;
}

function draftAllOpen(): void {
    const open = openIntents(model.world).filter((i) => i.kind !== "freeform" && !model.pendingProposals.some((p) => p.intentId === i.id));
    let drafted = 0;
    let changes = 0;
    for (const intent of open) {
        const p = draftIntent(intent);
        if (p) {
            drafted++;
            changes += p.changes.length;
        }
    }
    statusMessage = open.length
        ? `${PLANNER_AGENT_NAME} drafted ${drafted} of ${open.length} open intent(s): ${changes} change(s) to review.`
        : "No open intents to draft (freeform intents and ones already in review are left alone).";
}

function decideChange(changeId: string, accept: boolean): void {
    const found = model.findChange(changeId);
    if (!found) return;
    model.decideChange(changeId, accept);
    const left = found.proposal.changes.filter((c) => c.status === "pending").length;
    statusMessage = `${accept ? (found.change.status === "accepted" ? "Accepted" : "Could not apply") : "Rejected"} "${found.change.title}"${left ? ` - ${left} more in this proposal` : ""}.`;
    if (!left) {
        const intent = found.proposal.intentId ? model.intents.find((i) => i.id === found.proposal.intentId) : undefined;
        if (intent) statusMessage += ` Intent #${intent.number}: ${evaluateIntent(model.world, intent).summary}.`;
    }
}

function decideProposal(proposal: RevisionProposal, accept: boolean): void {
    const n = model.decideProposal(proposal.id, accept);
    const intent = proposal.intentId ? model.intents.find((i) => i.id === proposal.intentId) : undefined;
    statusMessage = `${accept ? "Accepted" : "Rejected"} ${n} change(s) from ${proposal.agentName}.${intent ? ` Intent #${intent.number}: ${evaluateIntent(model.world, intent).summary}.` : ""}`;
}

/** The intents as the map draws them, with their live checks. */
function mapIntents(): MapIntentConfig[] {
    return model.intents
        .filter((i) => i.status !== "dismissed")
        .map((i) => {
            const ev = evaluateIntent(model.world, i);
            return {
                id: i.id,
                number: i.number,
                shape: i.shape,
                kind: i.kind,
                points: intentPoints(model.world, i),
                title: i.title,
                summary: ev.summary,
                status: i.status,
                satisfied: ev.satisfied,
                color: INTENT_KIND_INFO[i.kind].color,
            };
        });
}

function renderMapCanvasAndToolbar(canvasArea: string): void {
    renderMapToolbar(canvasArea);

    const pending = model.activeTool === "draw_path" ? model.pendingPathPoints : model.activeTool === "draw_region" ? model.pendingRegionPoints : model.activeTool === "intent" ? model.pendingIntentPoints : model.activeTool === "sculpt" ? model.pendingSculptPoints : [];
    const t = model.world.terrain;
    const measuring = model.activeTool === "measure";

    const mapConfig: GameMapConfig = {
        id: "game_world_map",
        worldWidthKm: model.world.meta.worldWidthKm,
        worldHeightKm: model.world.meta.worldHeightKm,
        gridSnapM: model.world.meta.gridSnapM,
        showGrid: model.showGrid,
        showContours: model.showContours,
        showBiomes: model.showBiomes,
        showMinimap: model.showMinimap,
        showLabels: model.showLabels,
        blockingMode: model.world.meta.blockingMode,
        activeTool: model.activeTool,
        selectedId: model.selectedId || undefined,
        pendingPoints: pending.length ? pending : undefined,
        pendingMode: model.activeTool === "draw_path" ? "path" : model.activeTool === "draw_region" ? "region" : model.activeTool === "intent" ? `intent_${model.intentShape}` : model.activeTool === "sculpt" ? `sculpt_${model.sculptKind}` : undefined,
        overlay: mapOverlay(),
        markers: mapMarkers(),
        questRoutes: mapQuestRoutes(),
        showMarks: model.showMarks,
        showPopulation: model.showPopulation,
        showQuests: true,
        brush: mapBrush(),
        focusRequest: model.focus.seq,
        focusCenter: model.focus.center,
        focusZoom: model.focus.zoom,
        onBrushStroke: (points: [number, number][], done: boolean) => handleBrushStroke(points, done),
        onMarkerSelect: (id: string) => {
            model.selectedId = id;
            model.selectedPlacementId = id;
            model.selectedChangeId = null;
            const p = model.placements.find((x) => x.id === id);
            if (p) statusMessage = `Selected ${codexName(p.codexId)} (${placementDetail(p)}) - drag to move.`;
        },
        onMarkerMove: (id: string, x: number, y: number) => {
            model.updatePlacement(id, { x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) });
            const p = model.placements.find((q) => q.id === id);
            if (p) statusMessage = `Moved ${codexName(p.codexId)} to ${fmtKm([p.x, p.y])}.`;
        },
        intents: mapIntents(),
        ghosts: proposalGhosts(model.world) as MapGhostConfig[],
        showIntents: model.showIntents,
        showProposals: model.showProposals,
        selectedChangeId: model.selectedChangeId || undefined,
        onIntentSelect: (id: string) => {
            model.selectedId = id;
            model.selectedChangeId = null;
            const intent = model.intents.find((i) => i.id === id);
            if (intent) statusMessage = `Intent #${intent.number} "${intent.title}" - ${evaluateIntent(model.world, intent).summary}.`;
        },
        onGhostSelect: (id: string) => {
            const found = model.findChange(id);
            if (!found) return;
            model.selectedChangeId = id;
            if (found.proposal.intentId) model.selectedId = found.proposal.intentId;
            statusMessage = `Proposed by ${found.proposal.agentName}: ${found.change.title}. Accept (A) or reject (R) it in the inspector.`;
        },
        terrain: t ? { cols: t.cols, rows: t.rows, data: t.data, seaLevelM: t.seaLevelM } : undefined,
        terrainStyle: model.terrainStyle,
        terrainPalette: paletteForGenre(model.world.meta.genre),
        fitRequest: model.fitRequest,
        measureAnchor: measuring && model.measurePoints.p1 && !model.measurePoints.p2 ? model.measurePoints.p1 : undefined,
        spots: model.world.spots.map((s) => ({
            id: s.id,
            name: s.name,
            spotType: s.spotType,
            x: s.x,
            y: s.y,
            elevation: s.elevation,
            color: s.color,
            icon: s.icon,
            tags: s.tags,
            isMajor: s.isMajor,
        })),
        paths: model.world.paths.map((p) => ({
            id: p.id,
            name: p.name,
            pathType: p.pathType,
            points: p.points,
            width: p.width,
            color: p.color,
            isMajor: p.isMajor,
            flowSpeed: p.flowSpeed,
        })),
        regions: model.world.regions.map((r) => ({
            id: r.id,
            name: r.name,
            regionType: r.regionType,
            points: r.points,
            fillColor: r.fillColor,
            borderColor: r.borderColor,
            isMajor: r.isMajor,
        })),
        elevationBands: t ? [] : model.world.contours.map((c) => ({ elevation: c.elevation, points: c.points, color: c.color })),
        measure: lastTravelEstimate && model.measurePoints.p1 && model.measurePoints.p2
            ? {
                active: true,
                p1: model.measurePoints.p1,
                p2: model.measurePoints.p2,
                distanceKm: lastTravelEstimate.directDistanceKm,
                travelInfo: lastTravelEstimate.summaryText,
            }
            : undefined,
        onSpotSelect: (id: string) => {
            model.selectedId = id;
            model.selectedChangeId = null;
            const spot = model.world.spots.find((s) => s.id === id);
            if (spot) statusMessage = `Selected ${spot.spotType} "${spot.name}" - drag to move it.`;
        },
        onSpotMove: (id: string, x: number, y: number) => {
            model.draggingSpotId = id;
            model.moveSpot(id, x, y);
        },
        onSpotDragEnd: (id: string) => {
            model.endSpotDrag();
            const spot = model.world.spots.find((s) => s.id === id);
            if (spot) statusMessage = `Moved "${spot.name}" to ${fmtKm([spot.x, spot.y])}, ${spot.elevation} m.`;
        },
        onPathSelect: (id: string) => {
            model.selectedId = id;
            model.selectedChangeId = null;
            const path = model.world.paths.find((p) => p.id === id);
            if (path) statusMessage = `Selected ${path.pathType} "${path.name}".`;
        },
        onRegionSelect: (id: string) => {
            model.selectedId = id;
            model.selectedChangeId = null;
            const region = model.world.regions.find((r) => r.id === id);
            if (region) statusMessage = `Selected region "${region.name}" (${region.dominantBiome}).`;
        },
        onMapClick: (x: number, y: number) => handleMapClick(x, y),
        onMapDoubleClick: () => {
            finishDrawing();
        },
        onViewport: (cx: number, cy: number, zoom: number) => {
            model.viewportCenter = [cx, cy];
            model.viewportZoom = zoom;
        },
    };

    W.gameMap(canvasArea, mapConfig);
}

// --- Inspector Panel ---

function renderInspector(panel: string): void {
    W.label(panel, { text: "Properties Inspector", bold: true, fontSize: 13, color: UI.text });
    W.separator(panel);

    const selId = model.selectedId;
    const intent = selId ? model.intents.find((i) => i.id === selId) : undefined;
    if (model.selectedChangeId && !intent) {
        const found = model.findChange(model.selectedChangeId);
        if (found) return renderChangeReview(panel, found.proposal, found.change);
    }
    // The painting and sculpting tools keep their settings on top, whatever is selected.
    if (["sculpt", "paint", "populate"].includes(model.activeTool)) {
        if (model.activeTool === "sculpt") renderSculptPanel(panel);
        else if (model.activeTool === "paint") renderPaintPanel(panel);
        else renderPopulatePanel(panel);
        W.spacer(panel, 8);
    }
    if (intent) return renderIntentInspector(panel, intent);
    const placement = selId ? model.placements.find((p) => p.id === selId) : undefined;
    const spot = selId ? model.world.spots.find((s) => s.id === selId) : undefined;
    const path = selId ? model.world.paths.find((p) => p.id === selId) : undefined;
    const region = selId ? model.world.regions.find((r) => r.id === selId) : undefined;
    if (placement) return renderPlacementInspector(panel, placement);
    if (spot) return renderSpotInspector(panel, spot);
    if (path) return renderPathInspector(panel, path);
    if (region) return renderRegionInspector(panel, region);
    renderWorldPanel(panel);
}

/** Nothing selected: the active tool's settings, the plan, terrain & procedural tools, the world. */
function renderWorldPanel(panel: string): void {
    const quest = model.highlightedQuestId ? model.world.missions.find((m) => m.id === model.highlightedQuestId) : undefined;
    if (quest) {
        renderQuestMapCard(panel, quest);
        W.spacer(panel, 8);
    }

    renderPlanBoard(panel);
    W.spacer(panel, 8);
    W.label(panel, {
        text: "Tools: V select, H pan, P spot, L path, G region, M measure, I intent, E sculpt, N paint, U populate. [ ] resize the brush. Space-drag or right-drag pans, the wheel zooms, F fits, Esc cancels, Delete removes.",
        wrap: true,
        color: UI.dim,
        fontSize: 10.5,
    });
    W.spacer(panel, 6);
    W.collapsingHeader(panel, icon("mountains", "Terrain & Procedural"), (sec) => renderTerrainTools(sec), "sec_terrain_tools", true);
    W.collapsingHeader(panel, icon("tree", "Planning marks & population"), (sec) => renderMarksSummary(sec), "sec_marks_summary", false);
    W.spacer(panel, 6);
    W.card(panel, { id: "card_quick_stats", fill: UI.card, padding: 10 }, (card) => {
        W.label(card, { text: "World Summary", bold: true, fontSize: 11, color: UI.emerald });
        W.label(card, { text: `Name: ${model.world.meta.name}`, fontSize: 11, color: UI.text });
        W.label(card, { text: `Genre: ${model.world.meta.genre.toUpperCase()}`, fontSize: 11, color: UI.dim });
        W.label(card, { text: `Dimensions: ${model.world.meta.worldWidthKm} x ${model.world.meta.worldHeightKm} km`, fontSize: 11, color: UI.dim });
        const t = model.world.terrain;
        if (t) {
            const land = t.data.filter((v) => v > t.seaLevelM).length / t.data.length;
            W.label(card, { text: `Terrain: ${t.cols}x${t.rows} grid, ${Math.round(t.minM)} to ${Math.round(t.maxM)} m, ${Math.round(land * 100)}% land`, fontSize: 11, color: UI.dim });
        }
        W.label(card, { text: `${model.world.spots.length} spots · ${model.world.paths.length} paths · ${model.world.regions.length} regions · ${model.placements.length} placed`, fontSize: 11, color: UI.dim });
    });
}

function renderSculptPanel(panel: string): void {
    const s = model.sculpt;
    const info = SCULPT_INFO[s.mode];
    W.card(panel, { id: "card_sculpt", fill: UI.card, padding: 10 }, (card) => {
        W.label(card, { text: icon("shovel", `Sculpt: ${info.label}`), bold: true, fontSize: 12, color: UI.amber });
        W.label(card, { text: info.how, wrap: true, fontSize: 10.5, color: UI.dim });
        const modeRow = (modes: SculptMode[], key: string) =>
            W.horizontal(card, () => {
                modes.forEach((m) =>
                    W.button(card, {
                        id: `btn_sculpt_${m}`,
                        text: SCULPT_INFO[m].label,
                        accent: s.mode === m ? UI.amber : undefined,
                        onClick: () => {
                            s.mode = m;
                            model.pendingSculptPoints = [];
                            statusMessage = sculptHint();
                        },
                    })
                );
                void key;
            });
        modeRow(BRUSH_MODES.slice(0, 3), "brush1");
        modeRow(BRUSH_MODES.slice(3), "brush2");
        modeRow(LINE_MODES.slice(0, 2), "line1");
        modeRow([...LINE_MODES.slice(2), ...AREA_MODES], "line2");
        W.spacer(card, 4);
        if (info.kind === "brush") {
            W.slider(card, { id: "slider_sculpt_radius", label: `Brush radius (${s.radiusKm.toFixed(2)} km):`, value: s.radiusKm, min: 0.1, max: 6, onChange: (v) => (s.radiusKm = parseFloat(v) || 1) });
            W.slider(card, { id: "slider_sculpt_strength", label: `Strength (${Math.round(s.strength * 100)}%):`, value: s.strength, min: 0.05, max: 1, onChange: (v) => (s.strength = parseFloat(v) || 0.5) });
        }
        if (s.mode === "flatten" || s.mode === "plateau") {
            W.checkbox(card, {
                id: "chk_sculpt_snap",
                label: s.mode === "flatten" ? "Snap to landscape: level to the ground where the stroke starts" : "Snap to landscape: level to the mean ground inside",
                value: s.snapToLandscape,
                onChange: (v) => (s.snapToLandscape = v),
            });
            if (!s.snapToLandscape) W.numericInput(card, { id: "input_sculpt_target", label: "Level to (m):", value: s.targetM, onChange: (v) => (s.targetM = parseFloat(v) || 0) });
        }
        if (s.mode === "canyon") {
            W.slider(card, { id: "slider_canyon_width", label: `Rim to rim (${s.canyonWidthKm.toFixed(1)} km):`, value: s.canyonWidthKm, min: 0.2, max: 8, onChange: (v) => (s.canyonWidthKm = parseFloat(v) || 1.4) });
            W.slider(card, { id: "slider_canyon_depth", label: `Depth (${Math.round(s.canyonDepthM)} m):`, value: s.canyonDepthM, min: 20, max: 1500, onChange: (v) => (s.canyonDepthM = parseFloat(v) || 260) });
            W.slider(card, { id: "slider_canyon_steep", label: `Wall steepness (${Math.round(s.canyonSteepness * 100)}%):`, value: s.canyonSteepness, min: 0, max: 1, onChange: (v) => (s.canyonSteepness = parseFloat(v) || 0) });
        }
        if (s.mode === "ridge") {
            W.slider(card, { id: "slider_ridge_width", label: `Range width (${s.ridgeWidthKm.toFixed(1)} km):`, value: s.ridgeWidthKm, min: 0.5, max: 15, onChange: (v) => (s.ridgeWidthKm = parseFloat(v) || 4) });
            W.slider(card, { id: "slider_ridge_height", label: `Peak height added (${Math.round(s.ridgeHeightM)} m):`, value: s.ridgeHeightM, min: 50, max: 4000, onChange: (v) => (s.ridgeHeightM = parseFloat(v) || 1400) });
            W.slider(card, { id: "slider_ridge_rough", label: `Peaks & spurs (${Math.round(s.ridgeRoughness * 100)}%):`, value: s.ridgeRoughness, min: 0, max: 1, onChange: (v) => (s.ridgeRoughness = parseFloat(v) || 0) });
        }
        if (s.mode === "grade") {
            W.slider(card, { id: "slider_grade_width", label: `Bed width (${Math.round(s.gradeWidthKm * 1000)} m):`, value: s.gradeWidthKm, min: 0.02, max: 1, onChange: (v) => (s.gradeWidthKm = parseFloat(v) || 0.12) });
            W.slider(card, { id: "slider_grade_max", label: `Steepest grade (${s.gradeMaxPercent.toFixed(0)}%):`, value: s.gradeMaxPercent, min: 1, max: 25, onChange: (v) => (s.gradeMaxPercent = parseFloat(v) || 8) });
            W.label(card, { text: "Tip: select a road and use \"Grade terrain along it\" to grade an existing path.", wrap: true, fontSize: 10, color: UI.dim });
        }
        if (s.mode === "plateau") {
            W.slider(card, { id: "slider_plateau_feather", label: `Edge slope (${s.featherKm.toFixed(2)} km):`, value: s.featherKm, min: 0.05, max: 3, onChange: (v) => (s.featherKm = parseFloat(v) || 0.4) });
        }
        if (info.kind !== "brush") {
            W.label(card, { text: model.pendingSculptPoints.length ? `${model.pendingSculptPoints.length} point(s) - Enter applies.` : "Click on the map to start.", fontSize: 10.5, color: UI.amber });
        }
        const snappedOff = model.world.spots.filter((x) => !isSnapped(x)).length;
        W.label(card, { text: `Spots that snap to the landscape follow the edit${snappedOff ? `; ${snappedOff} with an authored elevation keep theirs` : ""}. Every stroke is one undo step.`, wrap: true, fontSize: 10, color: UI.dim });
    });
}

function renderPaintPanel(panel: string): void {
    W.card(panel, { id: "card_paint", fill: UI.card, padding: 10 }, (card) => {
        W.label(card, { text: icon("paint-brush", "Paint planning marks"), bold: true, fontSize: 12, color: UI.emerald });
        W.label(card, { text: "Marks plan what grows or lies where - they are drawn as symbols, never built. Regions read what is painted inside them.", wrap: true, fontSize: 10.5, color: UI.dim });
        for (let i = 0; i < MARKS.length; i += 3) {
            W.horizontal(card, () => {
                MARKS.slice(i, i + 3).forEach((m) =>
                    W.button(card, {
                        id: `btn_mark_${m.id}`,
                        text: m.label,
                        tooltip: m.hint,
                        accent: model.paintKey === m.id ? m.color : undefined,
                        onClick: () => {
                            model.paintKey = m.id;
                            model.paintErase = false;
                        },
                    })
                );
            });
        }
        renderBrushControls(card);
        W.checkbox(card, { id: "chk_paint_exclusive", label: "Replace other surface marks under the brush", value: model.paintExclusive, onChange: (v) => (model.paintExclusive = v) });
    });
}

function renderBrushControls(card: string): void {
    W.slider(card, { id: "slider_paint_radius", label: `Brush radius (${model.paintRadiusKm.toFixed(2)} km):`, value: model.paintRadiusKm, min: 0.1, max: 6, onChange: (v) => (model.paintRadiusKm = parseFloat(v) || 1) });
    W.slider(card, { id: "slider_paint_strength", label: `Strength (${Math.round(model.paintStrength * 100)}%):`, value: model.paintStrength, min: 0.05, max: 1, onChange: (v) => (model.paintStrength = parseFloat(v) || 0.6) });
    W.checkbox(card, { id: "chk_paint_erase", label: "Erase", value: model.paintErase, onChange: (v) => (model.paintErase = v) });
    const regions = model.world.regions.filter((r) => r.points.length >= 3);
    W.dropdown(card, {
        id: "dropdown_paint_clip",
        label: "Only inside",
        options: ["(anywhere)", ...regions.map((r) => r.name)],
        selectedIndex: model.paintClipRegionId ? Math.max(0, regions.findIndex((r) => r.id === model.paintClipRegionId) + 1) : 0,
        onChange: (v: string) => (model.paintClipRegionId = regions[Number(v) - 1]?.id ?? null),
    });
}

function renderPopulatePanel(panel: string): void {
    const c = model.world.codex.find((e) => e.id === model.populateCodexId);
    W.card(panel, { id: "card_populate", fill: UI.card, padding: 10 }, (card) => {
        W.label(card, { text: icon("users", "Populate from the Codex"), bold: true, fontSize: 12, color: UI.rose });
        W.label(card, { text: "Click to place a codex entry (a named NPC, a pack of enemies, an outpost); drag to paint where it roams or can be found. Quests check their targets against this.", wrap: true, fontSize: 10.5, color: UI.dim });
        const entries = placeableCodex();
        if (!entries.length) {
            W.label(card, { text: "The Codex has no characters or creatures yet.", fontSize: 11, color: UI.amber });
        }
        entries.slice(0, 18).forEach((e) =>
            W.button(card, {
                id: `btn_populate_${e.id}`,
                text: icon(CODEX_ICONS[e.category], `${e.name} · ${CODEX_MAP_STYLE[e.category].noun}`),
                accent: model.populateCodexId === e.id ? CODEX_MAP_STYLE[e.category].color : undefined,
                onClick: () => {
                    model.populateCodexId = e.id;
                    statusMessage = populateHint();
                },
            })
        );
        W.button(card, {
            id: "btn_new_creature",
            text: icon("plus", "New creature"),
            onClick: () => {
                const e = createCodexEntry("New Creature", "creature", "Wild beast", "A creature of the wilds.", model.world.meta.genre);
                model.addCodexEntry(e);
                model.selectedId = null;
                model.populateCodexId = e.id;
                statusMessage = `Created "${e.name}" in the Codex - name it there; place or paint it here.`;
            },
        });
        renderBrushControls(card);
        if (c) {
            const where = codexMapPresence(model.world, c);
            W.label(card, { text: `${c.name}: ${where.placements.length} placement(s), painted over ${where.paintedKm2} km²${where.regions.length ? ` · in ${where.regions.map((r) => r.name).join(", ")}` : ""}`, wrap: true, fontSize: 10.5, color: UI.dim });
        }
    });
}

function renderMarksSummary(sec: string): void {
    const cov = layerCoverage(model.world.overlay, model.world.meta);
    if (!cov.length && !model.placements.length) {
        W.label(sec, { text: "Nothing painted or placed yet. Use Paint (N) for biomes and surface marks, Populate (U) for enemies and NPCs from the Codex.", wrap: true, fontSize: 10.5, color: UI.dim });
        return;
    }
    cov.forEach((c) => W.label(sec, { text: `${layerLabel(model.world, c.key)}: ${c.areaKm2} km² (${Math.round(c.share * 100)}% of the world)`, fontSize: 10.5, color: UI.text }));
    if (model.placements.length) {
        W.spacer(sec, 4);
        W.label(sec, { text: `${model.placements.length} placement(s):`, fontSize: 10.5, color: UI.dim });
        model.placements.slice(0, 30).forEach((p) =>
            W.button(sec, {
                id: `btn_goto_place_${p.id}`,
                text: `${codexName(p.codexId)} · ${placementDetail(p)}`,
                onClick: () => {
                    model.selectedId = p.id;
                    model.selectedPlacementId = p.id;
                    model.focusOn(p.x, p.y);
                },
            })
        );
    }
}

/** A codex entry placed on the map. */
function renderPlacementInspector(panel: string, p: CodexPlacement): void {
    const c = model.world.codex.find((e) => e.id === p.codexId);
    const st = CODEX_MAP_STYLE[c?.category ?? "lore"];
    W.label(panel, { text: icon(CODEX_ICONS[c?.category ?? "lore"], c?.name ?? "(missing codex entry)"), bold: true, fontSize: 13, color: st.color });
    if (c) W.label(panel, { text: `${c.subtitle} · ${st.noun}`, fontSize: 11, color: UI.dim, wrap: true });
    const entries = placeableCodex();
    W.dropdown(panel, {
        id: "edit_place_codex",
        label: "Codex entry",
        options: entries.map(codexOptionLabel),
        selectedIndex: Math.max(0, entries.findIndex((e) => e.id === p.codexId)),
        onChange: (v: string) => {
            const e = entries[Number(v)];
            if (e) model.updatePlacement(p.id, { codexId: e.id });
        },
    });
    W.horizontal(panel, () => {
        W.numericInput(panel, { id: "edit_place_x", label: "X (km):", value: p.x, speed: 0.05, onChange: (v) => model.updatePlacement(p.id, { x: parseFloat(v) || 0 }) });
        W.numericInput(panel, { id: "edit_place_y", label: "Y (km):", value: p.y, speed: 0.05, onChange: (v) => model.updatePlacement(p.id, { y: parseFloat(v) || 0 }) });
    });
    W.numericInput(panel, { id: "edit_place_count", label: "How many:", value: p.count, min: 1, onChange: (v) => model.updatePlacement(p.id, { count: Math.max(1, Math.round(parseFloat(v) || 1)) }) });
    W.dropdown(panel, {
        id: "edit_place_behavior",
        label: "Behavior",
        options: PLACEMENT_BEHAVIORS.map((b) => b.replace("_", " ")),
        selectedIndex: Math.max(0, PLACEMENT_BEHAVIORS.indexOf(p.behavior)),
        onChange: (v: string) => model.updatePlacement(p.id, { behavior: (PLACEMENT_BEHAVIORS[Number(v)] || "static") as PlacementBehavior }),
    });
    W.horizontal(panel, () => {
        W.numericInput(panel, { id: "edit_place_lvmin", label: "Level from:", value: p.levelMin ?? 0, min: 0, onChange: (v) => model.updatePlacement(p.id, { levelMin: parseInt(v, 10) || undefined }) });
        W.numericInput(panel, { id: "edit_place_lvmax", label: "to:", value: p.levelMax ?? 0, min: 0, onChange: (v) => model.updatePlacement(p.id, { levelMax: parseInt(v, 10) || undefined }) });
    });
    W.textInput(panel, { id: "edit_place_notes", label: "Notes (schedule, loot, dialogue...):", value: p.notes, multiline: true, height: 60, onChange: (v) => model.updatePlacement(p.id, { notes: v }) });

    W.card(panel, { id: "card_place_context", fill: UI.card, padding: 8 }, (card) => {
        W.label(card, { text: "Where it is", bold: true, fontSize: 11, color: UI.emerald });
        const near = nearestSpot(model.world, p.x, p.y, 2.0);
        if (near) W.label(card, { text: `Near ${near.name} (${(Math.hypot(near.x - p.x, near.y - p.y) * 1000).toFixed(0)} m)`, fontSize: 11, color: UI.text });
        const regs = regionsAt(model.world, p.x, p.y);
        if (regs.length) W.label(card, { text: `In ${regs.map((r) => `${r.name} (danger ${r.dangerLevel})`).join(", ")}`, fontSize: 11, color: UI.dim, wrap: true });
        W.label(card, { text: `Ground: ${model.elevationAt(p.x, p.y)} m`, fontSize: 11, color: UI.dim });
        const quests = c ? codexMapPresence(model.world, c).missions : [];
        quests.forEach((mid) => {
            const m = model.world.missions.find((x) => x.id === mid);
            if (m) W.button(card, { id: `btn_place_quest_${m.id}`, text: icon("sword", m.title), onClick: () => openQuest(m.id) });
        });
    });
    W.spacer(panel, 6);
    W.horizontal(panel, () => {
        if (c) W.button(panel, { id: "btn_place_open_codex", text: icon("book-open", "Open in Codex"), onClick: () => openCodex(c.id) });
        W.button(panel, { id: "btn_delete_placement", text: icon("trash", "Remove"), accent: UI.rose, onClick: () => deleteSelected() });
    });
}

function openCodex(id: string): void {
    model.activeTab = "codex";
    model.selectedId = id;
}

function openQuest(id: string): void {
    model.activeTab = "story";
    model.selectedId = id;
}

/** The quest whose journey the map shows, with its planning check. */
function renderQuestMapCard(panel: string, m: Mission): void {
    const a = analyzeQuest(model.world, m);
    W.card(panel, { id: "card_quest_on_map", fill: UI.card, padding: 10 }, (card) => {
        W.label(card, { text: icon("sword", m.title), bold: true, fontSize: 12, color: MISSION_COLORS[m.missionType] ?? UI.amber });
        W.label(card, { text: a.summary, wrap: true, fontSize: 10.5, color: UI.text });
        a.stops.forEach((s, k) => W.label(card, { text: `${k === 0 ? "!" : k === a.stops.length - 1 ? "?" : String(k)}  ${s.name}`, fontSize: 10.5, color: UI.dim }));
        a.issues.slice(0, 5).forEach((i) => W.label(card, { text: `${i.severity === "warn" ? "⚠" : "·"} ${i.text}`, wrap: true, fontSize: 10, color: i.severity === "warn" ? UI.amber : UI.dim }));
        W.horizontal(card, () => {
            W.button(card, { id: "btn_quest_open_story", text: icon("book-open", "Open quest"), onClick: () => openQuest(m.id) });
            W.button(card, { id: "btn_quest_hide", text: icon("x", "Hide"), onClick: () => (model.highlightedQuestId = null) });
        });
    });
}

// --- Intents: the plan board, the intent inspector, change review ---

function statusColor(ev: { satisfied: boolean | null }): RGBA {
    return ev.satisfied === true ? UI.emerald : ev.satisfied === false ? UI.amber : UI.dim;
}

function statusGlyph(ev: { satisfied: boolean | null }): IconName {
    return ev.satisfied === true ? "check-circle" : ev.satisfied === false ? "x-circle" : "circle-dashed";
}

/** Every intent at a glance, with its check; the starting point when nothing is selected. */
function renderPlanBoard(panel: string): void {
    const live = model.intents.filter((i) => i.status !== "dismissed");
    const h = planHealth(model.world);
    W.card(panel, { id: "card_plan_board", fill: UI.card, padding: 10 }, (card) => {
        W.horizontal(card, () => {
            W.label(card, { text: icon("lightbulb", "Plan Board"), bold: true, fontSize: 12, color: UI.amber });
            if (h.total) W.label(card, { text: `${h.score}%`, bold: true, fontSize: 12, color: h.unmet ? UI.amber : UI.emerald });
        });
        if (!live.length) {
            W.label(card, {
                text: "Sketch what you want with the Intent tool (I): pin a landmark, outline an area to settle or make dangerous, draw a route and say how long the journey should take. Agents build it; you review every change on the map.",
                wrap: true,
                fontSize: 11,
                color: UI.dim,
            });
            W.button(card, { id: "btn_start_intent", text: icon("lightbulb", "Sketch an intent"), accent: UI.amber, onClick: () => selectTool("intent") });
            return;
        }
        W.label(card, { text: `${h.met} met · ${h.unmet} unmet${h.manual ? ` · ${h.manual} checked by hand` : ""} · ${model.pendingProposals.length} proposal(s) to review`, fontSize: 10.5, color: UI.dim });
        W.spacer(card, 4);
        live.sort((a, b) => a.number - b.number).forEach((i) => {
            const ev = evaluateIntent(model.world, i);
            const review = i.status === "proposed" ? " · review" : i.status === "claimed" ? ` · ${i.claimedBy ?? "agent"} working` : "";
            W.button(card, {
                id: `board_intent_${i.id}`,
                text: icon(statusGlyph(ev), `#${i.number} ${i.title}`),
                tooltip: `${INTENT_KIND_INFO[i.kind].label}: ${ev.summary}${review}`,
                accent: model.selectedId === i.id ? UI.cyan : undefined,
                onClick: () => {
                    model.selectedId = i.id;
                    model.selectedChangeId = null;
                },
            });
            W.label(card, { text: `   ${ev.summary}${review}`, fontSize: 10, color: statusColor(ev) });
        });
        W.spacer(card, 4);
        W.horizontal(card, () => {
            W.button(card, { id: "btn_draft_all_board", text: icon("robot", "Draft open intents"), accent: UI.cyan, onClick: () => draftAllOpen() });
            W.button(card, { id: "btn_copy_brief_board", text: icon("clipboard-text", "Copy brief"), tooltip: "A Markdown work order for any agent", onClick: () => copyText(generateAgentBrief(model.world), "the Agent Brief") });
        });
    });
}

/** Review controls are keyed by position (proposal n, change k) so tests and scripts can reach them. */
function renderProposalChanges(panel: string, proposal: RevisionProposal): void {
    const pending = proposal.changes.filter((c) => c.status === "pending");
    const n = model.world.proposals.indexOf(proposal);
    W.card(panel, { id: `card_prop_${n}`, fill: UI.card, padding: 10 }, (card) => {
        W.label(card, { text: icon("robot", `${proposal.agentName} proposes ${proposal.changes.length} change${proposal.changes.length === 1 ? "" : "s"}`), bold: true, fontSize: 12, color: UI.violet });
        W.label(card, { text: proposal.motivation, wrap: true, fontSize: 10.5, color: UI.dim });
        if (pending.length > 1) {
            W.horizontal(card, () => {
                W.button(card, { id: `btn_accept_all_${n}`, text: icon("check", "Accept all"), accent: UI.emerald, onClick: () => decideProposal(proposal, true) });
                W.button(card, { id: `btn_reject_all_${n}`, text: icon("x", "Reject all"), onClick: () => decideProposal(proposal, false) });
            });
        } else if (pending.length === 1) {
            // One change: its own Accept/Reject below say it all; keep the ids for scripts.
            W.horizontal(card, () => {
                W.button(card, { id: `btn_accept_all_${n}`, text: icon("check", "Accept"), accent: UI.emerald, onClick: () => decideProposal(proposal, true) });
                W.button(card, { id: `btn_reject_all_${n}`, text: icon("x", "Reject"), onClick: () => decideProposal(proposal, false) });
            });
        }
        W.separator(card);
        proposal.changes.forEach((c, k) => renderChangeRow(card, c, `${n}_${k}`));
    });
}

function renderChangeRow(card: string, c: RevisionChange, key: string): void {
    const selected = model.selectedChangeId === c.id;
    const col = c.status === "accepted" ? UI.emerald : c.status === "rejected" ? UI.rose : selected ? UI.cyan : UI.text;
    const mark = c.status === "accepted" ? "check" : c.status === "rejected" ? "x" : "ghost";
    W.label(card, { text: icon(mark as IconName, c.title), bold: true, fontSize: 11, color: col });
    if (c.summary) W.label(card, { text: c.summary, wrap: true, fontSize: 10, color: UI.dim });
    if (c.status === "pending" && (model.findChange(c.id)?.proposal.changes.filter((x) => x.status === "pending").length ?? 0) > 1) {
        W.horizontal(card, () => {
            W.button(card, { id: `btn_accept_${key}`, text: icon("check", "Accept"), tooltip: "A", accent: UI.emerald, onClick: () => decideChange(c.id, true) });
            W.button(card, { id: `btn_reject_${key}`, text: icon("x", "Reject"), tooltip: "R", onClick: () => decideChange(c.id, false) });
            W.button(card, {
                id: `btn_focus_${key}`,
                text: icon("crosshair", ""),
                tooltip: "Highlight it on the map",
                accent: selected ? UI.cyan : undefined,
                onClick: () => (model.selectedChangeId = selected ? null : c.id),
            });
        });
    }
    W.spacer(card, 4);
}

/** A single proposed change picked on the map (one not tied to an intent). */
function renderChangeReview(panel: string, proposal: RevisionProposal, change: RevisionChange): void {
    W.label(panel, { text: icon("ghost", "Proposed change"), bold: true, fontSize: 13, color: UI.violet });
    W.spacer(panel, 4);
    renderProposalChanges(panel, proposal);
    W.button(panel, { id: "btn_back_to_board", text: icon("arrow-counter-clockwise", "Back to the plan"), onClick: () => (model.selectedChangeId = null) });
    void change;
}

function renderIntentInspector(panel: string, intent: PlanIntent): void {
    const info = INTENT_KIND_INFO[intent.kind];
    const ev = evaluateIntent(model.world, intent);
    const p = effectiveParams(intent);
    W.label(panel, { text: icon(INTENT_ICONS[intent.kind], `Intent #${intent.number}`), bold: true, fontSize: 13, color: UI.amber });
    W.label(panel, { text: icon(statusGlyph(ev), ev.satisfied === true ? "Met" : ev.satisfied === false ? "Not met yet" : "Checked by hand"), bold: true, fontSize: 12, color: statusColor(ev) });
    W.label(panel, { text: ev.summary, fontSize: 11.5, color: statusColor(ev), wrap: true });
    W.spacer(panel, 4);

    W.textInput(panel, { id: "edit_intent_title", label: "Title:", value: intent.title, onChange: (v) => model.updateIntent(intent.id, { title: v }) });
    W.label(panel, { text: "What you want, in your words (agents read this):", fontSize: 11, color: UI.dim });
    W.textInput(panel, { id: "edit_intent_directive", value: intent.directive, multiline: true, height: 74, onChange: (v) => model.updateIntent(intent.id, { directive: v }) });
    if (!intent.directive) {
        const example = intent.kind === "settle" ? "three quiet fishing villages along this coast" : intent.kind === "danger" ? "haunted woods, danger level 8" : intent.kind === "pacing" ? "should take about 40 minutes on horseback" : intent.kind === "quest" ? "a bounty hunt in the ruins" : intent.kind === "connect" ? "join these with a trail" : "describe what should be here";
        W.label(panel, { text: `e.g. "${example}" - counts, place types, threat levels and travel times are read from it.`, wrap: true, fontSize: 10, color: UI.dim });
    }

    const kinds = INTENT_KINDS.filter((k) => INTENT_KIND_INFO[k].shapes.includes(intent.shape));
    W.dropdown(panel, {
        id: "edit_intent_kind",
        label: "Kind",
        options: kinds.map((k) => INTENT_KIND_INFO[k].label),
        selectedIndex: Math.max(0, kinds.indexOf(intent.kind)),
        onChange: (v: string) => {
            const k = kinds[Number(v)];
            if (k) model.updateIntent(intent.id, { kind: k });
        },
    });
    W.label(panel, { text: info.hint, fontSize: 10.5, color: UI.dim });

    // The kind's parameters (showing what the directive implies until set explicitly).
    const setParam = (key: string, value: unknown) => model.updateIntent(intent.id, { params: { ...intent.params, [key]: value } });
    const spotTypeDropdown = (label: string) =>
        W.dropdown(panel, {
            id: "edit_intent_spot_type",
            label,
            options: ["Any", ...SPOT_TYPES.map((t) => t[0].toUpperCase() + t.slice(1))],
            selectedIndex: p.spotType ? SPOT_TYPES.indexOf(p.spotType) + 1 : 0,
            onChange: (v: string) => setParam("spotType", Number(v) === 0 ? undefined : SPOT_TYPES[Number(v) - 1]),
        });
    if (intent.kind === "settle") {
        W.slider(panel, { id: "edit_intent_count", label: `How many (${p.count ?? 3}):`, value: p.count ?? 3, min: 1, max: 12, onChange: (v) => setParam("count", Math.round(parseFloat(v) || 1)) });
        spotTypeDropdown("Place type");
    } else if (intent.kind === "danger") {
        W.slider(panel, { id: "edit_intent_danger", label: `Threat level (${p.dangerLevel ?? 7}/10):`, value: p.dangerLevel ?? 7, min: 1, max: 10, onChange: (v) => setParam("dangerLevel", Math.round(parseFloat(v) || 1)) });
    } else if (intent.kind === "landmark" || intent.kind === "quest") {
        spotTypeDropdown(intent.kind === "quest" ? "Quest site type" : "Landmark type");
    } else if (intent.kind === "connect") {
        W.dropdown(panel, {
            id: "edit_intent_path_type",
            label: "Build a",
            options: ["Trail", "Road", "Highway"],
            selectedIndex: ["trail", "road", "highway"].indexOf(p.pathType ?? "road"),
            onChange: (v: string) => setParam("pathType", (["trail", "road", "highway"] as const)[Number(v)] ?? "road"),
        });
    } else if (intent.kind === "pacing") {
        W.numericInput(panel, { id: "edit_intent_minutes", label: "Target (minutes):", value: p.targetMinutes ?? 60, step: 5, onChange: (v) => setParam("targetMinutes", Math.max(1, Math.round(parseFloat(v) || 1))) });
        W.dropdown(panel, {
            id: "edit_intent_mode",
            label: "Travelling",
            options: ["On foot", "Mounted", "By vehicle", "By boat", "By air"],
            selectedIndex: Math.max(0, TRAVEL_MODES.indexOf(p.mode ?? "foot")),
            onChange: (v: string) => setParam("mode", TRAVEL_MODES[Number(v)] ?? "foot"),
        });
        W.slider(panel, { id: "edit_intent_tolerance", label: `Tolerance (±${Math.round((p.tolerance ?? 0.25) * 100)}%):`, value: Math.round((p.tolerance ?? 0.25) * 100), min: 5, max: 60, onChange: (v) => setParam("tolerance", Math.round(parseFloat(v) || 25) / 100) });
    }
    if (intent.shape === "route") {
        const pts = intentPoints(model.world, intent);
        const name = (id?: string, k = 0) => (id && model.world.spots.find((s) => s.id === id)?.name) || fmtKm(pts[k]);
        W.label(panel, { text: `From ${name(intent.fromSpotId, 0)} to ${name(intent.toSpotId, 1)}`, fontSize: 11, color: UI.dim, wrap: true });
    }

    W.dropdown(panel, {
        id: "edit_intent_priority",
        label: "Priority",
        options: ["Low", "Normal", "High"],
        selectedIndex: ["low", "normal", "high"].indexOf(intent.priority),
        onChange: (v: string) => model.updateIntent(intent.id, { priority: (["low", "normal", "high"] as const)[Number(v)] ?? "normal" }),
    });

    W.separator(panel);
    W.label(panel, { text: icon("robot", "Agents"), bold: true, fontSize: 12, color: UI.cyan });
    W.button(panel, {
        id: "btn_draft_intent",
        text: icon("robot", intent.kind === "freeform" ? "Needs an LLM agent" : "Draft with Planner Agent"),
        accent: intent.kind === "freeform" ? undefined : UI.cyan,
        tooltip: intent.kind === "freeform" ? "Copy the context into an LLM agent, or let an MCP agent pick it up" : "Propose changes for this intent from the terrain",
        onClick: () => draftIntent(intent),
    });
    W.button(panel, {
        id: "btn_copy_intent_brief",
        text: icon("clipboard-text", "Copy context for an agent"),
        tooltip: "This intent as JSON: terrain, nearby places, acceptance criteria",
        onClick: () => copyText(JSON.stringify(intentContext(model.world, intent), null, 2), `intent #${intent.number}'s context`),
    });
    if (agentNote && agentNote.intentId === intent.id) W.label(panel, { text: agentNote.text, wrap: true, fontSize: 10.5, color: UI.dim });
    if (intent.claimedBy && intent.status === "claimed") W.label(panel, { text: `${intent.claimedBy} is working on this.`, fontSize: 10.5, color: UI.violet });

    const proposals = model.world.proposals.filter((pr) => pr.intentId === intent.id);
    const pending = proposals.filter(isProposalPending);
    pending.forEach((pr) => renderProposalChanges(panel, pr));
    const done = proposals.length - pending.length;
    if (done) W.label(panel, { text: `${done} earlier proposal(s) decided.`, fontSize: 10, color: UI.dim });

    W.separator(panel);
    W.horizontal(panel, () => {
        if (intent.status !== "done" && ev.satisfied !== true) {
            W.button(panel, { id: "btn_intent_done", text: icon("check", "Mark done"), onClick: () => model.updateIntent(intent.id, { status: "done" }) });
        } else if (intent.status === "done") {
            W.button(panel, { id: "btn_intent_reopen", text: icon("arrow-counter-clockwise", "Reopen"), onClick: () => model.updateIntent(intent.id, { status: "open" }) });
        }
        W.button(panel, {
            id: "btn_delete_intent",
            text: icon("trash", "Delete"),
            accent: UI.rose,
            onClick: () => {
                model.deleteIntent(intent.id);
                statusMessage = `Deleted intent #${intent.number}.`;
            },
        });
        W.button(panel, { id: "btn_intent_back", text: icon("x", "Close"), onClick: () => (model.selectedId = null) });
    });
}

function renderSpotInspector(panel: string, spot: WorldSpot): void {
    W.label(panel, { text: icon("map-pin-plus", spot.name), bold: true, fontSize: 13, color: UI.emerald });

    W.textInput(panel, {
        id: "edit_spot_name",
        label: "Name:",
        value: spot.name,
        onChange: (v) => model.updateSpot(spot.id, { name: v }),
    });

    W.dropdown(panel, {
        id: "edit_spot_type",
        label: "Spot Type",
        options: SPOT_TYPES.map((t) => t.toUpperCase()),
        selectedIndex: Math.max(0, SPOT_TYPES.indexOf(spot.spotType)),
        onChange: (v: string) => {
            const t = SPOT_TYPES[Number(v)];
            if (t) model.updateSpot(spot.id, { spotType: t, color: SPOT_COLORS[t] });
        },
    });

    W.horizontal(panel, () => {
        W.numericInput(panel, {
            id: "edit_spot_x",
            label: "X (km):",
            value: spot.x,
            step: 0.05,
            onChange: (v) => model.updateSpot(spot.id, { x: parseFloat(v) || 0 }),
        });
        W.numericInput(panel, {
            id: "edit_spot_y",
            label: "Y (km):",
            value: spot.y,
            step: 0.05,
            onChange: (v) => model.updateSpot(spot.id, { y: parseFloat(v) || 0 }),
        });
    });

    const snapped = isSnapped(spot);
    W.checkbox(panel, {
        id: "edit_spot_snap",
        label: "Snap to landscape (elevation follows the ground)",
        value: snapped,
        onChange: (v) => {
            model.updateSpot(spot.id, { snapToGround: v });
            statusMessage = v ? `"${spot.name}" sits on the ground now and follows terrain edits.` : `"${spot.name}" keeps its own elevation (a tower top, a sky citadel...).`;
        },
    });
    if (snapped) {
        W.label(panel, { text: `Elevation: ${spot.elevation} m (on the ground)`, fontSize: 11, color: UI.text });
    } else {
        W.numericInput(panel, {
            id: "edit_spot_elevation",
            label: "Elevation (m):",
            value: spot.elevation,
            onChange: (v) => model.updateSpot(spot.id, { elevation: parseFloat(v) || 0, snapToGround: false }),
        });
    }
    if (model.world.terrain) {
        const ground = model.elevationAt(spot.x, spot.y);
        const slope = model.slopeAt(spot.x, spot.y);
        const off = spot.elevation - ground;
        W.label(panel, {
            text: `Ground here: ${ground} m, slope ${slope.toFixed(0)}°${Math.abs(off) > 5 ? ` (spot is ${off > 0 ? "+" : ""}${off} m off the ground)` : ""}`,
            fontSize: 11,
            color: Math.abs(off) > 5 ? UI.amber : slope > 12 ? UI.amber : UI.dim,
        });
        if (Math.abs(off) > 5) {
            W.button(panel, {
                id: "btn_spot_to_ground",
                text: icon("mountains", "Put on the ground"),
                onClick: () => model.updateSpot(spot.id, { elevation: ground, snapToGround: true }),
            });
        }
        // A flat footprint for the settlement or building.
        W.horizontal(panel, () => {
            W.slider(panel, { id: "slider_pad_radius", label: `Pad (${Math.round(padRadiusKm * 1000)} m):`, value: padRadiusKm, min: 0.05, max: 3, onChange: (v) => (padRadiusKm = parseFloat(v) || 0.5) });
            W.button(panel, {
                id: "btn_spot_pad",
                text: icon("selection", "Level ground here"),
                tooltip: "Flatten a building pad around the spot (its own elevation, or the mean ground when snapped)",
                onClick: () => {
                    const t = model.world.terrain!;
                    const pad = circlePolygon(spot.x, spot.y, padRadiusKm);
                    const level = snapped ? meanHeightInside(t, model.world.meta, pad) ?? ground : spot.elevation;
                    model.setTerrain(flattenArea(t, model.world.meta, pad, { targetM: level, featherKm: Math.max(0.15, padRadiusKm * 0.8) }));
                    statusMessage = `Levelled a ${Math.round(padRadiusKm * 2000)} m pad at ${Math.round(level)} m for "${spot.name}".`;
                },
            });
        });
    }

    W.slider(panel, {
        id: "edit_spot_danger",
        label: `Danger Level (${spot.dangerLevel || 1}/10):`,
        value: spot.dangerLevel || 1,
        min: 1,
        max: 10,
        onChange: (v) => model.updateSpot(spot.id, { dangerLevel: Math.round(parseFloat(v) || 1) }),
    });

    W.checkbox(panel, {
        id: "edit_spot_major",
        label: "Major hub (shown in Blocking mode)",
        value: spot.isMajor,
        onChange: (v) => model.updateSpot(spot.id, { isMajor: v }),
    });

    W.textInput(panel, {
        id: "edit_spot_tags",
        label: "Tags:",
        value: spot.tags.join(", "),
        onChange: (v) => model.updateSpot(spot.id, { tags: v.split(",").map((s) => s.trim()).filter(Boolean) }),
    });

    W.textInput(panel, {
        id: "edit_spot_desc",
        label: "Description:",
        value: spot.description,
        multiline: true,
        height: 80,
        onChange: (v) => model.updateSpot(spot.id, { description: v }),
    });

    W.textInput(panel, {
        id: "edit_spot_lore",
        label: "Lore Notes:",
        value: spot.loreNotes,
        multiline: true,
        height: 80,
        onChange: (v) => model.updateSpot(spot.id, { loreNotes: v }),
    });

    W.separator(panel);
    W.label(panel, { text: "AI Concept Art Prompt:", bold: true, fontSize: 11, color: UI.cyan });
    W.textInput(panel, {
        id: "edit_spot_prompt",
        value: spot.conceptPrompt || "",
        multiline: true,
        height: 80,
        onChange: (v) => model.updateSpot(spot.id, { conceptPrompt: v }),
    });

    W.button(panel, {
        id: "btn_gen_spot_prompt",
        text: icon("magic-wand", "Generate Image Prompt"),
        onClick: () => {
            const prompt = `Cinematic concept art of ${spot.name}, a ${spot.spotType} at ${spot.elevation} m altitude. ${spot.description} ${model.world.meta.genre} atmosphere, volumetric sunlight, 8k resolution`;
            model.updateSpot(spot.id, { conceptPrompt: prompt });
        },
    });

    renderSpotStory(panel, spot);

    W.spacer(panel, 8);
    W.horizontal(panel, () => {
        W.button(panel, {
            id: "btn_duplicate_spot",
            text: icon("copy", "Duplicate"),
            onClick: () => {
                const copy = model.duplicateSpot(spot.id);
                if (copy) {
                    copy.elevation = model.elevationAt(copy.x, copy.y, copy.elevation);
                    statusMessage = `Duplicated spot to "${copy.name}".`;
                }
            },
        });
        W.button(panel, {
            id: "btn_measure_from_spot",
            text: icon("ruler", "Measure from here"),
            onClick: () => {
                model.activeTool = "measure";
                model.measurePoints = { p1: [spot.x, spot.y] };
                lastTravelEstimate = null;
                statusMessage = `Measuring from ${spot.name} - click the destination.`;
            },
        });
    });

    W.spacer(panel, 8);
    W.button(panel, {
        id: "btn_delete_spot",
        text: icon("trash", "Delete Location"),
        tooltip: "Delete",
        accent: UI.rose,
        onClick: () => deleteSelected(),
    });
}

/** The codex, quests and population tied to a spot. */
function renderSpotStory(panel: string, spot: WorldSpot): void {
    W.separator(panel);
    W.label(panel, { text: icon("book-open", "Story & Codex here"), bold: true, fontSize: 12, color: UI.cyan });
    const linked = (spot.linkedCodexIds ?? []).map((id) => model.world.codex.find((c) => c.id === id)).filter((c): c is CodexEntry => !!c);
    linked.forEach((c) =>
        W.horizontal(panel, () => {
            W.button(panel, { id: `btn_spot_codex_${c.id}`, text: icon(CODEX_ICONS[c.category], c.name), onClick: () => openCodex(c.id) });
            W.button(panel, { id: `btn_spot_unlink_${c.id}`, text: icon("x", ""), tooltip: "Unlink", onClick: () => model.linkCodexSpot(c.id, spot.id, false) });
        })
    );
    const linkable = model.world.codex.filter((c) => !linked.includes(c));
    if (linkable.length) {
        W.dropdown(panel, {
            id: "add_spot_codex",
            label: "Link codex",
            options: ["Choose an entry...", ...linkable.map((c) => `${c.name} (${c.category})`)],
            selectedIndex: 0,
            onChange: (v: string) => {
                const c = linkable[Number(v) - 1];
                if (c) {
                    model.linkCodexSpot(c.id, spot.id, true);
                    statusMessage = `Linked "${c.name}" to "${spot.name}".`;
                }
            },
        });
    }
    const roles = model.world.missions
        .map((m) => {
            const r: string[] = [];
            if (m.startSpotId === spot.id) r.push("given here");
            if (m.objectiveSpotIds.includes(spot.id)) r.push("objective");
            if (m.turnInSpotId === spot.id) r.push("turned in here");
            return { m, r };
        })
        .filter((x) => x.r.length);
    if (roles.length) {
        W.label(panel, { text: "Quests:", fontSize: 11, color: UI.dim });
        roles.forEach(({ m, r }) =>
            W.horizontal(panel, () => {
                W.button(panel, { id: `btn_spot_quest_${m.id}`, text: icon("sword", `${m.title} · ${r.join(", ")}`), onClick: () => openQuest(m.id) });
                W.button(panel, { id: `btn_spot_quest_map_${m.id}`, text: icon("path", ""), tooltip: "Show its journey on the map", accent: model.highlightedQuestId === m.id ? UI.amber : undefined, onClick: () => (model.highlightedQuestId = model.highlightedQuestId === m.id ? null : m.id) });
            })
        );
    }
    const who = populationAt(model.world, spot.x, spot.y, 0.8);
    if (who.length) {
        W.label(panel, { text: `Who's here: ${who.map((w) => `${w.codex.name}${w.count > 1 ? ` x${w.count}` : ""}${w.painted ? " (roams)" : ""}`).join(", ")}`, wrap: true, fontSize: 11, color: UI.dim });
    }
    W.button(panel, {
        id: "btn_spot_populate",
        text: icon("users", "Place someone here"),
        onClick: () => {
            selectTool("populate");
            model.selectedId = null;
        },
    });
}

function renderPathInspector(panel: string, path: WorldPath): void {
    W.label(panel, { text: icon("path", path.name), bold: true, fontSize: 13, color: UI.amber });

    W.textInput(panel, {
        id: "edit_path_name",
        label: "Name:",
        value: path.name,
        onChange: (v) => model.updatePath(path.id, { name: v }),
    });

    W.dropdown(panel, {
        id: "edit_path_type",
        label: "Path Type",
        options: PATH_TYPES.map((t) => t.toUpperCase()),
        selectedIndex: Math.max(0, PATH_TYPES.indexOf(path.pathType)),
        onChange: (v: string) => {
            const t = PATH_TYPES[Number(v)];
            if (t) {
                const d = PATH_DEFAULTS[t];
                model.updatePath(path.id, { pathType: t, color: d.color, surfaceQuality: d.surfaceQuality, flowSpeed: t === "river" ? path.flowSpeed || d.flowSpeed : 0 });
            }
        },
    });

    W.slider(panel, {
        id: "edit_path_width",
        label: `Width (${path.width.toFixed(1)}):`,
        value: path.width,
        min: 1.0,
        max: 12.0,
        onChange: (v) => model.updatePath(path.id, { width: parseFloat(v) || 1.0 }),
    });

    W.checkbox(panel, {
        id: "edit_path_major",
        label: "Major route (shown in Blocking mode)",
        value: path.isMajor,
        onChange: (v) => model.updatePath(path.id, { isMajor: v }),
    });

    if (path.pathType === "river") {
        W.slider(panel, {
            id: "edit_path_flow",
            label: `Flow Speed (${path.flowSpeed.toFixed(1)} m/s):`,
            value: path.flowSpeed,
            min: 0,
            max: 5,
            onChange: (v) => model.updatePath(path.id, { flowSpeed: parseFloat(v) || 0 }),
        });
        W.button(panel, {
            id: "btn_reverse_river",
            text: icon("arrow-clockwise", "Reverse flow direction"),
            onClick: () => model.updatePath(path.id, { points: [...path.points].reverse() }),
        });
    }

    // Route metrics over the actual terrain.
    const t = model.world.terrain;
    const waypoints = path.points.map(([x, y]) => (t ? { x, y, elevation: sampleTerrain(t, model.world.meta, x, y) } : { x, y }));
    const travelFoot = calculateRouteTravelTime(waypoints, "foot", path.pathType);
    const travelHorse = calculateRouteTravelTime(waypoints, "mount", path.pathType);

    W.card(panel, { id: "card_path_travel", fill: UI.card, padding: 8 }, (card) => {
        W.label(card, { text: "Route Metrics", bold: true, fontSize: 11, color: UI.emerald });
        W.label(card, { text: `Length: ${round2(pathPolylineLengthKm(path.points))} km (${path.points.length} points)`, fontSize: 11, color: UI.text });
        if (t) {
            // Sample the profile every ~100 m.
            let climb = 0, descent = 0, lo = Infinity, hi = -Infinity, steepest = 0;
            let prev: number | null = null;
            for (let i = 0; i < path.points.length - 1; i++) {
                const [ax, ay] = path.points[i];
                const [bx, by] = path.points[i + 1];
                const n = Math.max(1, Math.ceil(euclideanDistanceKm([ax, ay], [bx, by]) / 0.1));
                const stepKm = euclideanDistanceKm([ax, ay], [bx, by]) / n;
                for (let k = 0; k <= n; k++) {
                    const e = sampleTerrain(t, model.world.meta, ax + (bx - ax) * (k / n), ay + (by - ay) * (k / n));
                    lo = Math.min(lo, e);
                    hi = Math.max(hi, e);
                    if (prev !== null && k > 0) {
                        const d = e - prev;
                        if (d > 0) climb += d; else descent -= d;
                        steepest = Math.max(steepest, Math.abs(d) / (stepKm * 1000));
                    }
                    prev = e;
                }
            }
            W.label(card, { text: `Elevation: ${Math.round(lo)} to ${Math.round(hi)} m · climb +${Math.round(climb)} m / -${Math.round(descent)} m`, fontSize: 11, color: UI.dim });
            W.label(card, { text: `Steepest grade: ${(steepest * 100).toFixed(0)}%`, fontSize: 11, color: steepest > 0.15 && path.pathType !== "river" ? UI.amber : UI.dim });
        }
        W.label(card, { text: `Foot: ${travelFoot.formattedDuration} · Horse: ${travelHorse.formattedDuration}`, fontSize: 11, color: UI.dim });
    });

    if (t && path.points.length >= 2) {
        W.horizontal(panel, () => {
            if (path.pathType !== "river") {
                W.button(panel, {
                    id: "btn_path_grade",
                    text: icon("road-horizon", "Grade terrain along it"),
                    tooltip: `Cut and fill an even bed (max ${model.sculpt.gradeMaxPercent}% grade) under the ${path.pathType}`,
                    onClick: () => {
                        const widthKm = Math.max(0.03, path.width * 0.012);
                        model.setTerrain(gradeAlongPath(t, model.world.meta, path.points, { widthKm, maxGrade: model.sculpt.gradeMaxPercent / 100 }));
                        statusMessage = `Graded a ${Math.round(widthKm * 1000)} m bed under "${path.name}" (max ${model.sculpt.gradeMaxPercent}% grade).`;
                    },
                });
            }
            W.button(panel, {
                id: "btn_path_canyon",
                text: icon("mountains", path.pathType === "river" ? "Carve a canyon for it" : "Sink it into a cutting"),
                tooltip: `Canyon settings from the Sculpt tool: ${model.sculpt.canyonWidthKm} km wide, ${model.sculpt.canyonDepthM} m deep`,
                onClick: () => {
                    const river = path.pathType === "river";
                    model.setTerrain(carveCanyon(t, model.world.meta, path.points, {
                        widthKm: river ? model.sculpt.canyonWidthKm : Math.max(0.1, path.width * 0.03),
                        depthM: river ? model.sculpt.canyonDepthM : 25,
                        steepness: model.sculpt.canyonSteepness,
                        downhill: river,
                    }));
                    statusMessage = `Carved along "${path.name}".`;
                },
            });
        });
    }

    W.spacer(panel, 8);
    W.horizontal(panel, () => {
        W.button(panel, {
            id: "btn_duplicate_path",
            text: icon("copy", "Duplicate"),
            onClick: () => {
                const copy = model.duplicatePath(path.id);
                if (copy) statusMessage = `Duplicated path to "${copy.name}".`;
            },
        });
        W.button(panel, {
            id: "btn_delete_path",
            text: icon("trash", "Delete"),
            accent: UI.rose,
            onClick: () => deleteSelected(),
        });
    });
}

function polygonAreaKm2(pts: [number, number][]): number {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const [x1, y1] = pts[i];
        const [x2, y2] = pts[(i + 1) % pts.length];
        a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
}

function renderRegionInspector(panel: string, region: WorldRegion): void {
    W.label(panel, { text: icon("polygon", region.name), bold: true, fontSize: 13, color: UI.cyan });

    W.textInput(panel, {
        id: "edit_region_name",
        label: "Name:",
        value: region.name,
        onChange: (v) => model.updateRegion(region.id, { name: v }),
    });

    const regionTypes: RegionType[] = ["kingdom", "province", "biome", "danger", "district"];
    W.dropdown(panel, {
        id: "edit_region_type",
        label: "Classification",
        options: regionTypes.map((t) => t.toUpperCase()),
        selectedIndex: Math.max(0, regionTypes.indexOf(region.regionType)),
        onChange: (v: string) => {
            const t = regionTypes[Number(v)];
            if (t) model.updateRegion(region.id, { regionType: t });
        },
    });

    W.dropdown(panel, {
        id: "edit_region_biome",
        label: "Dominant Biome",
        options: BIOMES.map((b) => b.toUpperCase()),
        selectedIndex: Math.max(0, BIOMES.indexOf(region.dominantBiome)),
        onChange: (v: string) => {
            const b = BIOMES[Number(v)];
            if (b) model.updateRegion(region.id, { dominantBiome: b });
        },
    });

    W.slider(panel, {
        id: "edit_region_danger",
        label: `Danger Level (${region.dangerLevel}/10):`,
        value: region.dangerLevel,
        min: 1,
        max: 10,
        onChange: (v) => model.updateRegion(region.id, { dangerLevel: Math.round(parseFloat(v) || 1) }),
    });

    W.textInput(panel, {
        id: "edit_region_desc",
        label: "Description:",
        value: region.description,
        multiline: true,
        height: 90,
        onChange: (v) => model.updateRegion(region.id, { description: v }),
    });

    const factions = model.world.codex.filter((c) => c.category === "faction");
    W.dropdown(panel, {
        id: "edit_region_faction",
        label: "Held by",
        options: ["(no faction)", ...factions.map((f) => f.name)],
        selectedIndex: region.controllingFactionId ? Math.max(0, factions.findIndex((f) => f.id === region.controllingFactionId) + 1) : 0,
        onChange: (v: string) => model.updateRegion(region.id, { controllingFactionId: factions[Number(v) - 1]?.id }),
    });

    renderRegionPlan(panel, region);

    W.card(panel, { id: "card_region_stats", fill: UI.card, padding: 8 }, (card) => {
        W.label(card, { text: "Region Metrics", bold: true, fontSize: 11, color: UI.emerald });
        W.label(card, { text: `Area: ${polygonAreaKm2(region.points).toFixed(1)} km² · ${region.points.length} vertices`, fontSize: 11, color: UI.text });
        const t = model.world.terrain;
        if (t && region.points.length >= 3) {
            // Sample the ground inside the outline.
            const xs = region.points.map((p) => p[0]);
            const ys = region.points.map((p) => p[1]);
            const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
            const inside = (x: number, y: number) => {
                let c = false;
                for (let i = 0, j = region.points.length - 1; i < region.points.length; j = i++) {
                    const [xi, yi] = region.points[i];
                    const [xj, yj] = region.points[j];
                    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
                }
                return c;
            };
            let n = 0, sum = 0, lo = Infinity, hi = -Infinity, water = 0;
            for (let i = 0; i <= 24; i++) {
                for (let j = 0; j <= 24; j++) {
                    const x = x0 + ((x1 - x0) * i) / 24;
                    const y = y0 + ((y1 - y0) * j) / 24;
                    if (!inside(x, y)) continue;
                    const e = sampleTerrain(t, model.world.meta, x, y);
                    n++;
                    sum += e;
                    lo = Math.min(lo, e);
                    hi = Math.max(hi, e);
                    if (e <= t.seaLevelM) water++;
                }
            }
            if (n > 0) {
                W.label(card, { text: `Elevation: ${Math.round(lo)} to ${Math.round(hi)} m (mean ${Math.round(sum / n)} m)`, fontSize: 11, color: UI.dim });
                if (water > 0) W.label(card, { text: `${Math.round((water / n) * 100)}% of it is under water`, fontSize: 11, color: UI.dim });
            }
        }
    });

    renderRegionMarks(panel, region);

    W.spacer(panel, 8);
    W.horizontal(panel, () => {
        W.button(panel, {
            id: "btn_duplicate_region",
            text: icon("copy", "Duplicate"),
            onClick: () => {
                const copy = model.duplicateRegion(region.id);
                if (copy) statusMessage = `Duplicated region to "${copy.name}".`;
            },
        });
        W.button(panel, {
            id: "btn_delete_region",
            text: icon("trash", "Delete"),
            accent: UI.rose,
            onClick: () => deleteSelected(),
        });
    });
}

/** The region's biome and regional plan: optional notes for art, audio and encounters. */
function renderRegionPlan(panel: string, region: WorldRegion): void {
    W.collapsingHeader(
        panel,
        icon("leaf", "Biome & regional plan"),
        (sec) => {
            const plan = region.plan ?? {};
            const set = (k: keyof RegionPlan, v: string | number | undefined) => {
                const current = model.world.regions.find((r) => r.id === region.id)?.plan ?? {};
                model.updateRegion(region.id, { plan: { ...current, [k]: v === "" ? undefined : v } });
            };
            const field = (k: keyof RegionPlan, label: string, hint: string) =>
                W.textInput(sec, { id: `edit_region_plan_${k}`, label: plan[k] ? label : `${label} (${hint})`, value: String(plan[k] ?? ""), onChange: (v) => set(k, v) });
            field("climate", "Climate:", "temperate, arid, monsoon, permafrost...");
            field("flora", "Flora:", "what grows here");
            field("fauna", "Fauna:", "wildlife, beasts");
            field("resources", "Resources:", "ore, timber, herbs...");
            field("mood", "Mood / light / music:", "misty dawns, low strings");
            W.horizontal(sec, () => {
                W.numericInput(sec, { id: "edit_region_plan_lvmin", label: "Levels from:", value: plan.levelMin ?? 0, min: 0, onChange: (v) => set("levelMin", parseInt(v, 10) || undefined) });
                W.numericInput(sec, { id: "edit_region_plan_lvmax", label: "to:", value: plan.levelMax ?? 0, min: 0, onChange: (v) => set("levelMax", parseInt(v, 10) || undefined) });
            });
            W.textInput(sec, { id: "edit_region_plan_notes", label: "Notes:", value: plan.notes ?? "", multiline: true, height: 60, onChange: (v) => set("notes", v) });
        },
        `sec_region_plan_${region.id}`,
        true
    );
}

/** What is painted and placed inside a region, and tools to paint it. */
function renderRegionMarks(panel: string, region: WorldRegion): void {
    if (region.points.length < 3) return;
    W.card(panel, { id: "card_region_marks", fill: UI.card, padding: 8 }, (card) => {
        W.label(card, { text: icon("tree", "Painted & populated"), bold: true, fontSize: 11, color: UI.emerald });
        const cov = layerCoverage(model.world.overlay, model.world.meta, region.points);
        if (!cov.length) W.label(card, { text: "Nothing painted inside yet.", fontSize: 10.5, color: UI.dim });
        cov.slice(0, 8).forEach((c) => W.label(card, { text: `${layerLabel(model.world, c.key)}: ${Math.round(c.share * 100)}% (${c.areaKm2} km²)`, fontSize: 10.5, color: isCodexLayer(c.key) ? UI.rose : UI.text }));
        const sug = suggestBiome(model.world.overlay, model.world.meta, region.points);
        if (sug && sug.biome !== region.dominantBiome) {
            W.button(card, {
                id: "btn_region_apply_biome",
                text: icon("leaf", `Paint says ${sug.biome} (${Math.round(sug.share * 100)}% ${sug.mark.label.toLowerCase()}) - use it`),
                onClick: () => model.updateRegion(region.id, { dominantBiome: sug.biome }),
            });
        }
        const placed = placementsInside(model.world, region.points);
        if (placed.length) {
            W.label(card, { text: `Placed: ${placed.map((p) => `${codexName(p.codexId)}${p.count > 1 ? ` x${p.count}` : ""}`).join(", ")}`, wrap: true, fontSize: 10.5, color: UI.dim });
        }
        const quests = model.world.missions.filter((m) =>
            m.objectiveRegionIds?.includes(region.id) ||
            [m.startSpotId, m.turnInSpotId, ...m.objectiveSpotIds].some((id) => {
                const s = model.world.spots.find((x) => x.id === id);
                return s && regionsAt(model.world, s.x, s.y).some((r) => r.id === region.id);
            })
        );
        quests.forEach((m) => W.button(card, { id: `btn_region_quest_${m.id}`, text: icon("sword", m.title), onClick: () => openQuest(m.id) }));
        const mark = MARK_BY_ID[model.paintKey] ? model.paintKey : "forest";
        W.horizontal(card, () => {
            W.button(card, {
                id: "btn_region_fill_mark",
                text: icon("paint-brush", `Fill with ${MARK_BY_ID[mark].label}`),
                onClick: () => {
                    const n = model.editOverlay((o) => fillPolygon(o, model.world.meta, mark, region.points, 1));
                    statusMessage = `Filled "${region.name}" with ${MARK_BY_ID[mark].label} (${n} cells).`;
                },
            });
            W.button(card, {
                id: "btn_region_clear_marks",
                text: icon("eraser", "Clear"),
                onClick: () => {
                    const n = model.editOverlay((o) => clearInside(o, model.world.meta, region.points));
                    statusMessage = `Cleared ${n} painted cells in "${region.name}".`;
                },
            });
        });
        W.button(card, {
            id: "btn_region_paint_inside",
            text: icon("paint-brush", "Paint inside this region"),
            tooltip: "The Paint tool, confined to this outline",
            onClick: () => {
                model.paintClipRegionId = region.id;
                selectTool("paint");
                model.selectedId = null;
            },
        });
    });
}

// =================================================================================================
// TAB 2: CODEX (CHARACTERS, POWERS, WEAPONS, FACTIONS, LORE)
// =================================================================================================

const CODEX_ICONS: Record<CodexCategory, IconName> = {
    character: "user",
    creature: "paw-print",
    power: "lightning",
    weapon: "sword",
    faction: "shield-star",
    lore: "scroll",
};

function renderCodexView(main: string): void {
    W.split(
        main,
        {
            id: "codex_split_view",
            sideOpen: true,
            sideWidth: 320,
            minHeight: 650,
            mainPadding: 16,
            sidePadding: 12,
            scrollMain: true,
            scrollSide: true,
        } as SplitConfig,
        (editorArea: string) => renderCodexDetail(editorArea),
        (listArea: string) => renderCodexList(listArea)
    );
}

function renderCodexList(side: string): void {
    W.label(side, { text: "Codex & Lore Archives", bold: true, fontSize: 13, color: UI.text });

    W.textInput(side, {
        id: "codex_search",
        label: "Search:",
        value: codexSearchQuery,
        onChange: (v) => {
            codexSearchQuery = v;
        },
    });

    const categories: Array<{ id: CodexCategory | "all"; label: string }> = [
        { id: "all", label: "All" },
        { id: "character", label: "Characters" },
        { id: "creature", label: "Bestiary" },
        { id: "power", label: "Powers" },
        { id: "weapon", label: "Weapons" },
        { id: "faction", label: "Factions" },
        { id: "lore", label: "Lore" },
    ];

    for (const row of [categories.slice(0, 4), categories.slice(4)]) {
        W.horizontal(side, () => {
            row.forEach((c) => {
                W.button(side, {
                    id: `cat_btn_${c.id}`,
                    text: c.label,
                    accent: codexCategoryFilter === c.id ? UI.emerald : undefined,
                    onClick: () => {
                        codexCategoryFilter = c.id;
                    },
                });
            });
        });
    }

    W.separator(side);

    W.button(side, {
        id: "btn_add_codex",
        text: icon("plus", "New Codex Entry"),
        accent: UI.cyan,
        onClick: () => {
            const cat: CodexCategory = codexCategoryFilter === "all" ? "character" : codexCategoryFilter;
            const newEntry = createCodexEntry("New Entry", cat, "Archetype / Title", "Entry description...", model.world.meta.genre);
            model.addCodexEntry(newEntry);
            statusMessage = `Created codex entry "${newEntry.name}".`;
        },
    });

    W.spacer(side, 8);

    let entries = filterCodexByCategory(model.world.codex, codexCategoryFilter);
    if (codexSearchQuery.trim()) {
        const q = codexSearchQuery.toLowerCase();
        entries = entries.filter((e) => e.name.toLowerCase().includes(q) || e.subtitle.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
    }
    if (entries.length === 0) {
        W.label(side, { text: "No entries match.", color: UI.dim, fontSize: 11 });
    }

    entries.forEach((entry) => {
        W.button(side, {
            id: `codex_item_${entry.id}`,
            text: icon(CODEX_ICONS[entry.category] || "scroll", entry.name),
            accent: model.selectedId === entry.id ? UI.emerald : undefined,
            onClick: () => {
                model.selectedId = entry.id;
            },
        });
    });
}

function renderCodexDetail(main: string): void {
    const entry = model.world.codex.find((c) => c.id === model.selectedId);
    if (!entry) {
        W.label(main, { text: "Select or create a Codex entry from the list on the right.", color: UI.dim, fontSize: 13 });
        return;
    }

    W.horizontal(main, () => {
        W.label(main, { text: entry.name, bold: true, fontSize: 16, color: UI.text });
        W.spacer(main, 8);
        W.label(main, { text: `[ ${entry.category.toUpperCase()} ]`, color: UI.emerald, fontSize: 12 });
    });

    W.textInput(main, {
        id: "edit_codex_name",
        label: "Name:",
        value: entry.name,
        onChange: (v) => model.updateCodexEntry(entry.id, { name: v }),
    });

    W.textInput(main, {
        id: "edit_codex_subtitle",
        label: "Subtitle / Archetype / Epithet:",
        value: entry.subtitle,
        onChange: (v) => model.updateCodexEntry(entry.id, { subtitle: v }),
    });

    W.textInput(main, {
        id: "edit_codex_desc",
        label: "Description & Background Lore:",
        value: entry.description,
        multiline: true,
        onChange: (v) => model.updateCodexEntry(entry.id, { description: v }),
    });

    W.separator(main);
    W.label(main, { text: "Attributes & Stat Block", bold: true, fontSize: 12, color: UI.text });

    Object.entries(entry.attributes).forEach(([key, val]) => {
        W.horizontal(main, () => {
            W.label(main, { text: `${key}:`, bold: true, fontSize: 11, color: UI.dim });
            W.textInput(main, {
                id: `edit_attr_${entry.id}_${key}`,
                value: String(val),
                onChange: (v) => {
                    // Read the entry fresh: the one captured above is replaced by every edit.
                    const current = model.world.codex.find((c) => c.id === entry.id);
                    if (current) model.updateCodexEntry(entry.id, { attributes: { ...current.attributes, [key]: v } });
                },
            });
        });
    });

    renderCodexOnMap(main, entry);

    W.separator(main);
    W.label(main, { text: "AI Concept Art Generator", bold: true, fontSize: 12, color: UI.cyan });

    const styles = ["Dark Fantasy", "Studio Ghibli", "Cyberpunk Unreal 5", "Moebius Sci-Fi", "Antique Parchment"];
    W.dropdown(main, {
        id: "dropdown_codex_style",
        label: "Visual Art Style Preset",
        options: styles,
        selectedIndex: Math.max(0, styles.indexOf(codexStyleFilter)),
        onChange: (v: string) => {
            const s = styles[Number(v)];
            if (s) codexStyleFilter = s;
        },
    });

    W.textInput(main, {
        id: "edit_codex_prompt",
        label: "Prompt (for Midjourney / Stable Diffusion / Yumon Paint):",
        value: entry.conceptImagePrompt,
        multiline: true,
        onChange: (v) => model.updateCodexEntry(entry.id, { conceptImagePrompt: v }),
    });

    W.horizontal(main, () => {
        W.button(main, {
            id: "btn_regen_codex_prompt",
            text: icon("magic-wand", `Generate Prompt (${codexStyleFilter})`),
            accent: UI.cyan,
            onClick: () => {
                const base = generateConceptImagePrompt(entry.name, entry.category, entry.subtitle, entry.description, model.world.meta.genre);
                model.updateCodexEntry(entry.id, { conceptImagePrompt: `${base}, rendered in ${codexStyleFilter} aesthetic, masterpiece composition, 8k` });
                statusMessage = "Generated a new concept art prompt.";
            },
        });

        W.button(main, {
            id: "btn_copy_prompt",
            text: icon("copy", "Copy Prompt"),
            onClick: () => {
                const ok = Entropy.Clipboard?.writeText(entry.conceptImagePrompt);
                statusMessage = ok === false ? "Could not reach the clipboard; the prompt is in the field above." : "Prompt copied to clipboard.";
            },
        });
    });

    W.spacer(main, 16);
    W.horizontal(main, () => {
        W.button(main, {
            id: "btn_duplicate_codex",
            text: icon("copy", "Duplicate Entry"),
            onClick: () => {
                const copy = model.duplicateCodexEntry(entry.id);
                if (copy) statusMessage = `Duplicated codex entry "${copy.name}".`;
            },
        });

        W.button(main, {
            id: "btn_delete_codex",
            text: icon("trash", "Delete Entry"),
            accent: UI.rose,
            onClick: () => {
                model.deleteCodexEntry(entry.id);
                statusMessage = `Deleted codex entry "${entry.name}".`;
            },
        });
    });
}

/** Where a codex entry is on the map, and the ways to put it there. */
function renderCodexOnMap(main: string, entry: CodexEntry): void {
    W.separator(main);
    W.label(main, { text: icon("map-trifold", "On the map"), bold: true, fontSize: 12, color: UI.emerald });
    const where = codexMapPresence(model.world, entry);
    const placeable = PLACEABLE_CATEGORIES.includes(entry.category);
    W.card(main, { id: "card_codex_map", fill: UI.card, padding: 10 }, (card) => {
        W.label(card, {
            text: `${where.spots.length} linked spot(s) · ${where.placements.length} placement(s) (${where.placements.reduce((n, p) => n + p.count, 0)} total) · painted over ${where.paintedKm2} km² · ${where.missions.length} quest(s)`,
            fontSize: 11,
            color: UI.text,
            wrap: true,
        });
        if (where.regions.length) W.label(card, { text: `Found in: ${where.regions.map((r) => r.name).join(", ")}`, fontSize: 11, color: UI.dim, wrap: true });
        where.spots.forEach((s) =>
            W.horizontal(card, () => {
                W.button(card, { id: `btn_codex_spot_${s.id}`, text: icon("map-pin", s.name), onClick: () => showOnMap(s.id, s.x, s.y) });
                W.button(card, { id: `btn_codex_unlink_${s.id}`, text: icon("x", ""), tooltip: "Unlink", onClick: () => model.linkCodexSpot(entry.id, s.id, false) });
            })
        );
        const linkable = model.world.spots.filter((s) => !where.spots.includes(s));
        if (linkable.length) {
            W.dropdown(card, {
                id: "add_codex_spot",
                label: "Link to spot",
                options: ["Choose a spot...", ...linkable.map((s) => `${s.name} (${s.spotType})`)],
                selectedIndex: 0,
                onChange: (v: string) => {
                    const s = linkable[Number(v) - 1];
                    if (s) {
                        model.linkCodexSpot(entry.id, s.id, true);
                        statusMessage = `Linked "${entry.name}" to "${s.name}".`;
                    }
                },
            });
        }
        where.placements.slice(0, 12).forEach((p) => W.button(card, { id: `btn_codex_place_${p.id}`, text: icon(CODEX_ICONS[entry.category], `${placementDetail(p)} at ${fmtKm([p.x, p.y])}`), onClick: () => showOnMap(p.id, p.x, p.y) }));
        where.missions.forEach((mid) => {
            const m = model.world.missions.find((x) => x.id === mid);
            if (m) W.button(card, { id: `btn_codex_quest_${m.id}`, text: icon("sword", m.title), onClick: () => openQuest(m.id) });
        });
        if (placeable) {
            W.horizontal(card, () => {
                W.button(card, {
                    id: "btn_codex_place",
                    text: icon("map-pin", "Place on map"),
                    accent: UI.cyan,
                    onClick: () => {
                        model.activeTab = "map";
                        model.selectedId = null;
                        model.populateCodexId = entry.id;
                        selectTool("populate");
                    },
                });
                W.button(card, {
                    id: "btn_codex_paint",
                    text: icon("paint-brush", "Paint where it roams"),
                    onClick: () => {
                        model.activeTab = "map";
                        model.selectedId = null;
                        model.populateCodexId = entry.id;
                        selectTool("populate");
                        statusMessage = `Drag on the map to paint where ${entry.name} ${entry.category === "creature" ? "roams" : "can be found"}.`;
                    },
                });
            });
        }
    });
}

function showOnMap(id: string, x: number, y: number): void {
    model.activeTab = "map";
    model.selectedId = id;
    if (model.placements.some((p) => p.id === id)) model.selectedPlacementId = id;
    model.focusOn(x, y);
}

// =================================================================================================
// TAB 3: STORY & QUEST ORGANIZER
// =================================================================================================

function renderStoryView(main: string): void {
    W.bar(
        main,
        { id: "story_toolbar", height: 38, fill: UI.nav, border: UI.line, paddingX: 12 },
        (left: string) => {
            W.horizontal(left, () => {
                W.button(left, {
                    id: "btn_mode_chrono",
                    text: icon("book-open", "Chronological Acts & Chapters"),
                    accent: questViewMode === "chronological" ? UI.emerald : undefined,
                    onClick: () => {
                        questViewMode = "chronological";
                    },
                });
                W.button(left, {
                    id: "btn_mode_freeform",
                    text: icon("link", "Freeform Quest Web"),
                    accent: questViewMode === "freeform" ? UI.cyan : undefined,
                    onClick: () => {
                        questViewMode = "freeform";
                    },
                });
            });
        },
        undefined,
        (right: string) => {
            const validation = validateQuestGraph(model.world.missions);
            if (validation.valid) {
                W.label(right, { text: icon("check", "Quest dependencies: valid, no cycles"), color: UI.emerald, fontSize: 11 });
            } else {
                const cycleStr = validation.cycle ? validation.cycle.join(" -> ") : "Unknown";
                W.label(right, { text: `Cycle in quest dependencies: ${cycleStr}`, color: UI.rose, bold: true, fontSize: 11 });
            }
        }
    );

    W.split(
        main,
        {
            id: "story_split_view",
            sideOpen: true,
            sideWidth: 320,
            minHeight: 650,
            mainPadding: 16,
            sidePadding: 12,
            scrollMain: true,
            scrollSide: true,
        } as SplitConfig,
        (editorArea: string) => renderMissionDetail(editorArea),
        (listArea: string) => renderQuestList(listArea)
    );
}

function renderQuestList(side: string): void {
    W.label(side, { text: "Quest Log", bold: true, fontSize: 13, color: UI.text });

    W.button(side, {
        id: "btn_add_mission",
        text: icon("plus", "New Mission"),
        accent: UI.cyan,
        onClick: () => {
            const newM = createMission(`Quest: Expedition #${model.world.missions.length + 1}`, "Explore the frontier and report back to the capital.", "main");
            newM.rewardXp = 1000;
            model.addMission(newM);
            statusMessage = `Created mission "${newM.title}".`;
        },
    });

    W.separator(side);

    const missionButton = (id: string, m: Mission, text: string) =>
        W.button(side, {
            id,
            text,
            accent: model.selectedId === m.id ? UI.emerald : undefined,
            onClick: () => {
                model.selectedId = m.id;
            },
        });

    if (questViewMode === "chronological") {
        const acts = getChronologicalActs(model.world.acts, model.world.missions);
        acts.forEach((actEntry) => {
            W.label(side, { text: `Act ${actEntry.act.actNumber}: ${actEntry.act.title}`, bold: true, fontSize: 11, color: UI.amber });
            actEntry.chapters.forEach((chapEntry) => {
                W.label(side, { text: `  Ch. ${chapEntry.chapter.chapterNumber}: ${chapEntry.chapter.title}`, color: UI.dim, fontSize: 10 });
                chapEntry.missions.forEach((m: Mission) => missionButton(`mission_btn_${m.id}`, m, icon("sword", m.title)));
            });
        });
        const placed = new Set(acts.flatMap((a) => a.chapters.flatMap((c) => c.missions.map((m) => m.id))));
        const loose = model.world.missions.filter((m) => !placed.has(m.id));
        if (loose.length) {
            W.label(side, { text: "Not in a chapter", bold: true, fontSize: 11, color: UI.dim });
            loose.forEach((m) => missionButton(`mission_btn_${m.id}`, m, icon("sword", m.title)));
        }
    } else {
        const available = computeAvailableMissions(model.world.missions, new Set<string>());
        W.label(side, { text: `Available Quests (${available.length}):`, bold: true, fontSize: 11, color: UI.emerald });
        available.forEach((m: Mission) => missionButton(`dag_avail_${m.id}`, m, icon("flag", m.title)));
        const locked = model.world.missions.filter((m: Mission) => !available.some((a: Mission) => a.id === m.id));
        if (locked.length > 0) {
            W.spacer(side, 8);
            W.label(side, { text: `Locked Quests (${locked.length}):`, bold: true, fontSize: 11, color: UI.dim });
            locked.forEach((m: Mission) => missionButton(`dag_locked_${m.id}`, m, icon("link-break", m.title)));
        }
    }
}

function renderMissionDetail(main: string): void {
    const mission = model.world.missions.find((m) => m.id === model.selectedId);
    if (!mission) {
        W.label(main, { text: "Select a quest from the list on the right to inspect it.", color: UI.dim, fontSize: 13 });
        return;
    }

    W.horizontal(main, () => {
        W.label(main, { text: mission.title, bold: true, fontSize: 16, color: UI.text });
        W.spacer(main, 8);
        W.label(main, { text: `[ ${mission.missionType.toUpperCase()} QUEST ]`, color: UI.emerald, fontSize: 12 });
    });

    W.textInput(main, {
        id: "edit_mission_title",
        label: "Title:",
        value: mission.title,
        onChange: (v) => model.updateMission(mission.id, { title: v }),
    });

    W.textInput(main, {
        id: "edit_mission_desc",
        label: "Description & Objectives:",
        value: mission.description,
        multiline: true,
        onChange: (v) => model.updateMission(mission.id, { description: v }),
    });

    W.numericInput(main, {
        id: "edit_mission_xp",
        label: "Reward XP:",
        value: mission.rewardXp,
        onChange: (v) => model.updateMission(mission.id, { rewardXp: parseInt(v, 10) || 0 }),
    });

    W.separator(main);
    W.label(main, { text: "Quest Locations & Time-to-Travel", bold: true, fontSize: 12, color: UI.cyan });

    const spots = model.world.spots;
    const spotOptions = ["(none)", ...spots.map((s) => `${s.name} (${s.spotType})`)];
    const idxOf = (id?: string) => (id ? spots.findIndex((s) => s.id === id) + 1 : 0);

    W.dropdown(main, {
        id: "edit_mission_giver",
        label: "Quest giver",
        options: spotOptions,
        selectedIndex: idxOf(mission.startSpotId),
        onChange: (v: string) => model.updateMission(mission.id, { startSpotId: spots[Number(v) - 1]?.id }),
    });
    W.dropdown(main, {
        id: "edit_mission_turnin",
        label: "Turn-in (none = back to the giver)",
        options: spotOptions,
        selectedIndex: idxOf(mission.turnInSpotId),
        onChange: (v: string) => model.updateMission(mission.id, { turnInSpotId: spots[Number(v) - 1]?.id }),
    });

    W.label(main, { text: `Objectives (${mission.objectiveSpotIds.length}):`, fontSize: 11, color: UI.text, bold: true });
    mission.objectiveSpotIds.forEach((sid, k) => {
        const s = spots.find((sp) => sp.id === sid);
        const d = mission.objectiveDetails?.[sid];
        const setDetail = (u: Partial<QuestObjectiveDetail>) => {
            const cur = model.world.missions.find((m) => m.id === mission.id);
            if (!cur) return;
            const prev = cur.objectiveDetails?.[sid] ?? { action: "go" as ObjectiveAction };
            model.updateMission(mission.id, { objectiveDetails: { ...(cur.objectiveDetails ?? {}), [sid]: { ...prev, ...u } } });
        };
        W.horizontal(main, () => {
            W.label(main, { text: `${k + 1}. ${s ? s.name : "(missing spot)"}`, fontSize: 11, color: UI.text, bold: true });
            W.dropdown(main, {
                id: `edit_obj_action_${k}`,
                label: "",
                options: OBJECTIVE_ACTIONS.map((a) => ACTION_INFO[a].label),
                selectedIndex: Math.max(0, OBJECTIVE_ACTIONS.indexOf(d?.action ?? "go")),
                onChange: (v: string) => setDetail({ action: OBJECTIVE_ACTIONS[Number(v)] || "go" }),
            });
            const cats = targetCategoriesFor(d?.action ?? "go");
            if (cats.length) {
                const targets = model.world.codex.filter((c) => cats.includes(c.category));
                W.dropdown(main, {
                    id: `edit_obj_target_${k}`,
                    label: "",
                    options: ["(whom / what)", ...targets.map((c) => c.name)],
                    selectedIndex: d?.targetCodexId ? Math.max(0, targets.findIndex((c) => c.id === d.targetCodexId) + 1) : 0,
                    onChange: (v: string) => setDetail({ targetCodexId: targets[Number(v) - 1]?.id }),
                });
            }
            if (d && (d.action === "defeat" || d.action === "collect")) {
                W.numericInput(main, { id: `edit_obj_count_${k}`, label: "x", value: d.count ?? 1, min: 1, onChange: (v) => setDetail({ count: Math.max(1, parseInt(v, 10) || 1) }) });
            }
            W.checkbox(main, { id: `edit_obj_optional_${k}`, label: "optional", value: !!d?.optional, onChange: (v) => setDetail({ optional: v }) });
            W.button(main, {
                id: `btn_remove_objective_${k}`,
                text: icon("x", "Remove"),
                onClick: () => {
                    const details = { ...(mission.objectiveDetails ?? {}) };
                    delete details[sid];
                    model.updateMission(mission.id, { objectiveSpotIds: mission.objectiveSpotIds.filter((_, i) => i !== k), objectiveDetails: details });
                },
            });
        });
        if (d && d.action !== "go") {
            W.horizontal(main, () => {
                W.textInput(main, { id: `edit_obj_note_${k}`, label: "     Note:", value: d.note ?? "", onChange: (v) => setDetail({ note: v }) });
                W.numericInput(main, { id: `edit_obj_minutes_${k}`, label: "Minutes there:", value: d.minutes ?? 0, min: 0, tooltip: "0 = estimate from the action", onChange: (v) => setDetail({ minutes: parseFloat(v) || undefined }) });
            });
        }
    });
    const addable = spots.filter((s) => !mission.objectiveSpotIds.includes(s.id));
    if (addable.length) {
        W.dropdown(main, {
            id: "add_mission_objective",
            label: "Add objective",
            options: ["Choose a spot...", ...addable.map((s) => `${s.name} (${s.spotType})`)],
            selectedIndex: 0,
            onChange: (v: string) => {
                const s = addable[Number(v) - 1];
                if (s) {
                    model.updateMission(mission.id, { objectiveSpotIds: [...mission.objectiveSpotIds, s.id] });
                    statusMessage = `Added "${s.name}" as an objective.`;
                }
            },
        });
    }

    const startSpot = spots.find((s) => s.id === mission.startSpotId);
    const objSpots = mission.objectiveSpotIds.map((id) => spots.find((s) => s.id === id)).filter((s): s is WorldSpot => !!s);
    const turnInSpot = spots.find((s) => s.id === mission.turnInSpotId) || startSpot;
    const analysis = analyzeQuest(model.world, mission);
    if (startSpot && objSpots.length > 0 && turnInSpot) {
        const routeWaypoints = [startSpot, ...objSpots, turnInSpot].map((s) => ({ x: s.x, y: s.y, elevation: s.elevation }));
        const routeFoot = calculateRouteTravelTime(routeWaypoints, "foot");
        const routeHorse = calculateRouteTravelTime(routeWaypoints, "mount");
        W.card(main, { id: "card_mission_route", fill: UI.card, padding: 10 }, (card) => {
            W.horizontal(card, () => {
                W.label(card, { text: "Quest Journey Estimate", bold: true, fontSize: 11, color: UI.amber });
                W.button(card, { id: "btn_mission_show_map", text: icon("map-trifold", "Show on map"), accent: UI.amber, onClick: () => showQuestOnMap(mission) });
            });
            W.label(card, { text: `${startSpot.name} → ${objSpots.map((s) => s.name).join(" → ")} → ${turnInSpot.name}`, fontSize: 11, color: UI.text, wrap: true });
            W.label(card, { text: `Total distance: ${routeFoot.distanceKm} km`, fontSize: 11, color: UI.text });
            W.label(card, { text: `Straight line - on foot: ${routeFoot.formattedDuration} · Mounted: ${routeHorse.formattedDuration}`, fontSize: 11, color: UI.dim });
            W.label(card, { text: `Over the terrain and roads: ${analysis.summary}`, fontSize: 11, color: UI.text, wrap: true });
            analysis.legs.forEach((l) => W.label(card, { text: `   ${l.from} → ${l.to}: ${l.distanceKm} km, ${formatDuration(l.minutes / 60)}${l.byRoad ? " by road" : " cross-country"}`, fontSize: 10.5, color: UI.dim }));
        });
    } else {
        W.label(main, { text: "Set a quest giver and at least one objective to estimate the journey.", fontSize: 11, color: UI.dim });
    }

    renderQuestPlanning(main, mission, analysis);

    W.separator(main);
    W.label(main, { text: "Prerequisite quests", bold: true, fontSize: 12, color: UI.cyan });
    mission.prerequisiteMissionIds.forEach((pid, k) => {
        const m = model.world.missions.find((x) => x.id === pid);
        W.horizontal(main, () => {
            W.label(main, { text: m ? m.title : "(missing quest)", fontSize: 11, color: UI.dim });
            W.button(main, {
                id: `btn_remove_prereq_${k}`,
                text: icon("x", "Remove"),
                onClick: () => model.updateMission(mission.id, { prerequisiteMissionIds: mission.prerequisiteMissionIds.filter((_, i) => i !== k) }),
            });
        });
    });
    const prereqCandidates = model.world.missions.filter((m) => m.id !== mission.id && !mission.prerequisiteMissionIds.includes(m.id));
    if (prereqCandidates.length) {
        W.dropdown(main, {
            id: "add_mission_prereq",
            label: "Requires",
            options: ["Choose a quest...", ...prereqCandidates.map((m) => m.title)],
            selectedIndex: 0,
            onChange: (v: string) => {
                const m = prereqCandidates[Number(v) - 1];
                if (m) model.updateMission(mission.id, { prerequisiteMissionIds: [...mission.prerequisiteMissionIds, m.id] });
            },
        });
    }

    W.spacer(main, 12);
    W.horizontal(main, () => {
        W.button(main, {
            id: "btn_duplicate_mission",
            text: icon("copy", "Duplicate Quest"),
            onClick: () => {
                const copy = model.duplicateMission(mission.id);
                if (copy) statusMessage = `Duplicated quest "${copy.title}".`;
            },
        });
        W.button(main, {
            id: "btn_delete_mission",
            text: icon("trash", "Delete Quest"),
            accent: UI.rose,
            onClick: () => model.deleteMission(mission.id),
        });
    });
}

/** Optional planning detail and the planning check, for a quest. */
function renderQuestPlanning(main: string, mission: Mission, analysis: ReturnType<typeof analyzeQuest>): void {
    const fresh = () => model.world.missions.find((m) => m.id === mission.id) ?? mission;
    W.collapsingHeader(
        main,
        icon("sliders", "Planning details (optional)"),
        (sec) => {
            const chars = model.world.codex.filter((c) => c.category === "character");
            W.dropdown(sec, {
                id: "edit_mission_giver_codex",
                label: "Given by (character)",
                options: ["(nobody in particular)", ...chars.map((c) => c.name)],
                selectedIndex: mission.giverCodexId ? Math.max(0, chars.findIndex((c) => c.id === mission.giverCodexId) + 1) : 0,
                onChange: (v: string) => model.updateMission(mission.id, { giverCodexId: chars[Number(v) - 1]?.id }),
            });
            W.textInput(sec, { id: "edit_mission_hook", label: "Hook (why the player cares):", value: mission.hook ?? "", onChange: (v) => model.updateMission(mission.id, { hook: v || undefined }) });
            W.horizontal(sec, () => {
                W.numericInput(sec, { id: "edit_mission_lvmin", label: "Level from:", value: mission.levelMin ?? 0, min: 0, onChange: (v) => model.updateMission(mission.id, { levelMin: parseInt(v, 10) || undefined }) });
                W.numericInput(sec, { id: "edit_mission_lvmax", label: "to:", value: mission.levelMax ?? 0, min: 0, onChange: (v) => model.updateMission(mission.id, { levelMax: parseInt(v, 10) || undefined }) });
            });

            // Rewards from the codex.
            const rewards = mission.rewardCodexIds ?? [];
            rewards.forEach((id, k) =>
                W.horizontal(sec, () => {
                    W.label(sec, { text: `Reward: ${codexName(id)}`, fontSize: 11, color: UI.dim });
                    W.button(sec, { id: `btn_remove_reward_${k}`, text: icon("x", ""), onClick: () => model.updateMission(mission.id, { rewardCodexIds: rewards.filter((_, i) => i !== k) }) });
                })
            );
            const rewardable = model.world.codex.filter((c) => ["weapon", "power", "lore"].includes(c.category) && !rewards.includes(c.id));
            if (rewardable.length) {
                W.dropdown(sec, {
                    id: "add_mission_reward",
                    label: "Grants",
                    options: ["Choose an item or power...", ...rewardable.map((c) => `${c.name} (${c.category})`)],
                    selectedIndex: 0,
                    onChange: (v: string) => {
                        const c = rewardable[Number(v) - 1];
                        if (c) model.updateMission(mission.id, { rewardCodexIds: [...rewards, c.id] });
                    },
                });
            }

            // Faction standing.
            const rep = mission.reputation ?? [];
            rep.forEach((r, k) =>
                W.horizontal(sec, () => {
                    W.label(sec, { text: `Standing with ${codexName(r.factionId)}:`, fontSize: 11, color: UI.dim });
                    W.numericInput(sec, {
                        id: `edit_rep_${k}`,
                        label: "",
                        value: r.amount,
                        onChange: (v) => model.updateMission(mission.id, { reputation: (fresh().reputation ?? []).map((x, i) => (i === k ? { ...x, amount: parseInt(v, 10) || 0 } : x)) }),
                    });
                    W.button(sec, { id: `btn_remove_rep_${k}`, text: icon("x", ""), onClick: () => model.updateMission(mission.id, { reputation: rep.filter((_, i) => i !== k) }) });
                })
            );
            const factions = model.world.codex.filter((c) => c.category === "faction" && !rep.some((r) => r.factionId === c.id));
            if (factions.length) {
                W.dropdown(sec, {
                    id: "add_mission_rep",
                    label: "Affects standing with",
                    options: ["Choose a faction...", ...factions.map((f) => f.name)],
                    selectedIndex: 0,
                    onChange: (v: string) => {
                        const f = factions[Number(v) - 1];
                        if (f) model.updateMission(mission.id, { reputation: [...rep, { factionId: f.id, amount: 10 }] });
                    },
                });
            }

            // Outcomes and what they open.
            W.label(sec, { text: "Outcomes / choices:", fontSize: 11, color: UI.text, bold: true });
            const outcomes = mission.outcomes ?? [];
            outcomes.forEach((o, k) => {
                const setO = (u: Partial<typeof o>) => model.updateMission(mission.id, { outcomes: (fresh().outcomes ?? []).map((x, i) => (i === k ? { ...x, ...u } : x)) });
                W.horizontal(sec, () => {
                    W.textInput(sec, { id: `edit_outcome_label_${k}`, label: `${k + 1}.`, value: o.label, onChange: (v) => setO({ label: v }) });
                    W.button(sec, { id: `btn_remove_outcome_${k}`, text: icon("x", ""), onClick: () => model.updateMission(mission.id, { outcomes: outcomes.filter((_, i) => i !== k) }) });
                });
                W.textInput(sec, { id: `edit_outcome_consequence_${k}`, label: "     Consequence:", value: o.consequence ?? "", onChange: (v) => setO({ consequence: v || undefined }) });
                o.unlocksMissionIds.forEach((mid, j) =>
                    W.horizontal(sec, () => {
                        W.label(sec, { text: `     Opens: ${model.world.missions.find((m) => m.id === mid)?.title ?? "(missing quest)"}`, fontSize: 10.5, color: UI.dim });
                        W.button(sec, { id: `btn_remove_unlock_${k}_${j}`, text: icon("x", ""), onClick: () => setO({ unlocksMissionIds: o.unlocksMissionIds.filter((_, i) => i !== j) }) });
                    })
                );
                const openable = model.world.missions.filter((m) => m.id !== mission.id && !o.unlocksMissionIds.includes(m.id));
                if (openable.length) {
                    W.dropdown(sec, {
                        id: `add_outcome_unlock_${k}`,
                        label: "     Opens",
                        options: ["Choose a quest...", ...openable.map((m) => m.title)],
                        selectedIndex: 0,
                        onChange: (v: string) => {
                            const m = openable[Number(v) - 1];
                            if (m) setO({ unlocksMissionIds: [...o.unlocksMissionIds, m.id] });
                        },
                    });
                }
            });
            W.button(sec, {
                id: "btn_add_outcome",
                text: icon("plus", "Add an outcome"),
                onClick: () => model.updateMission(mission.id, { outcomes: [...outcomes, { id: `outcome_${Date.now()}_${outcomes.length}`, label: outcomes.length ? "Alternative ending" : "Success", unlocksMissionIds: [] }] }),
            });
        },
        "sec_mission_planning",
        false
    );

    W.card(main, { id: "card_mission_check", fill: UI.card, padding: 10 }, (card) => {
        W.label(card, { text: icon("list-checks", "Planning check"), bold: true, fontSize: 11, color: UI.cyan });
        const lv = mission.levelMax ?? mission.levelMin;
        const bits = [
            analysis.stops.length >= 2 ? analysis.summary : "",
            analysis.peakDanger ? `objective danger up to ${analysis.peakDanger}${lv !== undefined ? ` (comfortable for level ${lv}: ~${comfortableDanger(lv)})` : ""}` : "",
            analysis.chainDepth ? `${analysis.chainDepth} quest(s) deep in its chain` : "can be started right away",
            analysis.unlocks.length ? `unlocks ${analysis.unlocks.map((m) => m.title).join(", ")}` : "",
        ].filter(Boolean);
        W.label(card, { text: bits.join(" · "), wrap: true, fontSize: 10.5, color: UI.text });
        if (!analysis.issues.length) W.label(card, { text: icon("check", "Nothing to flag."), fontSize: 10.5, color: UI.emerald });
        analysis.issues.forEach((i) => W.label(card, { text: `${i.severity === "warn" ? "⚠" : "·"} ${i.text}`, wrap: true, fontSize: 10.5, color: i.severity === "warn" ? UI.amber : UI.dim }));
    });
}

// =================================================================================================
// TERRAIN & PROCEDURAL TOOLS (the map sidebar, when nothing is selected)
// =================================================================================================

function requireTerrain() {
    model.ensureTerrain();
    return model.world.terrain!;
}

function renderTerrainTools(main: string): void {
    W.label(main, {
        text: "Every tool works on the world's one heightfield: rivers follow its drainage, settlements are scored on it, roads are routed over it, snapped spots read their elevation from it. Hand edits: the Sculpt tool (E).",
        color: UI.dim,
        fontSize: 10.5,
        wrap: true,
    });

    const t = model.world.terrain;
    if (t) {
        const stats = terrainStats(t.data);
        const land = t.data.filter((v) => v > t.seaLevelM).length / t.data.length;
        W.label(main, { text: `${t.cols}x${t.rows} grid · ${Math.round(stats.min)} to ${Math.round(stats.max)} m · ${Math.round(land * 100)}% land`, fontSize: 11, color: UI.text });
        W.button(main, { id: "btn_open_sculpt", text: icon("shovel", "Sculpt by hand (E)"), accent: model.activeTool === "sculpt" ? UI.amber : undefined, onClick: () => selectTool("sculpt") });
        W.spacer(main, 6);
    }

    // 1. Heightfield
    W.card(main, { id: "card_proc_heightfield", fill: UI.card, padding: 12 }, (card) => {
        W.label(card, { text: "1. Terrain Heightfield", bold: true, fontSize: 12, color: UI.text });
        W.label(card, { text: "Domain-warped fractal landmass with ridged mountain ranges, beaches and continental shelves.", color: UI.dim, fontSize: 10.5, wrap: true });
        W.horizontal(card, () => {
            W.numericInput(card, {
                id: "input_proc_seed",
                label: "Seed:",
                value: procSeed,
                onChange: (v) => {
                    procSeed = parseInt(v, 10) || 1337;
                },
            });
            W.button(card, {
                id: "btn_random_seed",
                text: icon("shuffle", "Random"),
                onClick: () => {
                    procSeed = Math.floor(Math.random() * 99999) + 1;
                },
            });
        });
        W.horizontal(card, () => {
            W.numericInput(card, {
                id: "input_mountain_scale",
                label: "Highest peak (m):",
                value: procMountainScale,
                onChange: (v) => {
                    procMountainScale = Math.max(100, parseInt(v, 10) || 2600);
                },
            });
        });
        W.slider(card, {
            id: "slider_ruggedness",
            label: `Mountain ranges (${Math.round(procRuggedness * 100)}%):`,
            value: procRuggedness,
            min: 0,
            max: 1,
            onChange: (v) => {
                procRuggedness = parseFloat(v) || 0;
            },
        });
        W.slider(card, {
            id: "slider_land_bias",
            label: `Land vs. sea (${procLandBias >= 0 ? "+" : ""}${procLandBias.toFixed(2)}):`,
            value: procLandBias,
            min: -0.4,
            max: 0.4,
            onChange: (v) => {
                procLandBias = parseFloat(v) || 0;
            },
        });
        const resolutions = [65, 129, 193];
        W.dropdown(card, {
            id: "dropdown_resolution",
            label: "Grid resolution",
            options: resolutions.map((r) => `${r} x ${r}  (${(model.world.meta.worldWidthKm / (r - 1) * 1000).toFixed(0)} m cells)`),
            selectedIndex: Math.max(0, resolutions.indexOf(procResolution)),
            onChange: (v: string) => {
                procResolution = resolutions[Number(v)] || 129;
            },
        });
        W.checkbox(card, {
            id: "chk_island_mask",
            label: "Island: surround the land with ocean",
            value: procIslandMask,
            onChange: (v) => {
                procIslandMask = v;
            },
        });
        W.checkbox(card, {
            id: "chk_fit_spots",
            label: "Keep existing spots' elevations (shape the ground to them)",
            value: procFitSpots,
            onChange: (v) => {
                procFitSpots = v;
            },
        });

        W.button(card, {
            id: "btn_generate_heightmap",
            text: icon("mountains", "Generate Terrain"),
            accent: UI.emerald,
            onClick: () => {
                const meta = model.world.meta;
                let terrain = generateTerrain({
                    widthKm: meta.worldWidthKm,
                    heightKm: meta.worldHeightKm,
                    resolution: procResolution,
                    seed: procSeed,
                    mountainScale: procMountainScale,
                    seaLevelM: meta.seaLevelM,
                    islandMask: procIslandMask,
                    ruggedness: procRuggedness,
                    landBias: procLandBias,
                });
                if (procFitSpots) terrain = fitTerrainToSpots(terrain, meta, model.world.spots);
                model.setTerrain(terrain, !procFitSpots);
                model.world.meta.seed = procSeed;
                statusMessage = `Generated terrain (${Math.round(terrain.minM)} to ${Math.round(terrain.maxM)} m) from seed ${procSeed}.`;
            },
        });
    });

    W.spacer(main, 10);

    // 2. Erosion
    W.card(main, { id: "card_proc_erosion", fill: UI.card, padding: 12 }, (card) => {
        W.label(card, { text: "2. Hydraulic Erosion", bold: true, fontSize: 12, color: UI.text });
        W.label(card, { text: "Rain droplets run downhill, cutting gullies where they speed up and laying sediment where they slow down. Run it more than once for older, softer land.", color: UI.dim, fontSize: 11, wrap: true });
        W.slider(card, {
            id: "slider_erosion_iters",
            label: `Droplets (${Math.round(procErosionDroplets / 1000)}k):`,
            value: procErosionDroplets,
            min: 5000,
            max: 120000,
            onChange: (v) => {
                procErosionDroplets = Math.round(parseFloat(v) || 30000);
            },
        });
        W.button(card, {
            id: "btn_simulate_erosion",
            text: icon("drop", "Erode Terrain"),
            accent: UI.cyan,
            onClick: () => {
                const before = requireTerrain();
                let eroded = erodeTerrain(before, { droplets: procErosionDroplets, seed: procSeed + model.world.paths.length });
                if (procFitSpots) eroded = fitTerrainToSpots(eroded, model.world.meta, model.world.spots, 2.0, 2);
                model.setTerrain(eroded, !procFitSpots);
                statusMessage = `Eroded the terrain with ${Math.round(procErosionDroplets / 1000)}k droplets.`;
            },
        });
    });

    W.spacer(main, 10);

    // 3. Rivers
    W.card(main, { id: "card_proc_rivers", fill: UI.card, padding: 12 }, (card) => {
        W.label(card, { text: "3. Rivers from Drainage", bold: true, fontSize: 12, color: UI.text });
        W.label(card, { text: "Fills pits, routes every cell's water downhill, and traces the biggest catchments from source to sea.", color: UI.dim, fontSize: 10.5, wrap: true });
        W.slider(card, {
            id: "slider_river_count",
            label: `Rivers (${procRiverCount}):`,
            value: procRiverCount,
            min: 1,
            max: 10,
            onChange: (v) => {
                procRiverCount = Math.round(parseFloat(v) || 3);
            },
        });
        W.checkbox(card, {
            id: "chk_carve_rivers",
            label: "Carve river valleys into the terrain",
            value: procCarveRivers,
            onChange: (v) => {
                procCarveRivers = v;
            },
        });
        W.button(card, {
            id: "btn_generate_rivers",
            text: icon("waves", "Trace Rivers"),
            accent: UI.cyan,
            onClick: () => {
                const terrain = requireTerrain();
                const rivers = generateRivers(model.world.meta, terrain, procRiverCount);
                model.snapshot();
                // Replace rivers traced earlier, keep hand-drawn ones.
                model.world.paths = model.world.paths.filter((p) => !(p.pathType === "river" && p.id.startsWith("river_")));
                rivers.forEach((r) => model.world.paths.push(r));
                if (procCarveRivers && rivers.length) {
                    model.world.terrain = carveRivers(terrain, model.world.meta, rivers);
                    model.resampleSnappedSpots();
                }
                statusMessage = rivers.length ? `Traced ${rivers.length} rivers to the sea.` : "No catchment was large enough for a river; try more land or more relief.";
            },
        });
    });

    W.spacer(main, 10);

    // 4. Settlements
    W.card(main, { id: "card_proc_towns", fill: UI.card, padding: 12 }, (card) => {
        W.label(card, { text: "4. Settlements & Roads", bold: true, fontSize: 12, color: UI.text });
        W.label(card, { text: "Places a capital on flat, watered lowland, a port on the coast, a fortress on high ground, mines in the mountains; roads are routed around steep ground and water.", color: UI.dim, fontSize: 11, wrap: true });
        W.button(card, {
            id: "btn_generate_settlements",
            text: icon("buildings", "Place Settlements & Roads"),
            accent: UI.amber,
            onClick: () => {
                const terrain = requireTerrain();
                const { spots, roads } = generateSettlements(model.world.meta, terrain, model.world.paths, model.world.spots);
                model.snapshot();
                spots.forEach((s) => model.world.spots.push(s));
                roads.forEach((r) => model.world.paths.push(r));
                statusMessage = `Placed ${spots.length} settlements joined by ${roads.length} roads.`;
            },
        });
    });

    W.spacer(main, 10);

    // 5. Scatter
    W.card(main, { id: "card_proc_scatter", fill: UI.card, padding: 12 }, (card) => {
        W.label(card, { text: "5. Wilderness Points of Interest", bold: true, fontSize: 12, color: UI.text });
        W.label(card, { text: "Ruins, lairs, mines, shrines and camps on open land, away from existing spots; danger grows with remoteness.", color: UI.dim, fontSize: 11, wrap: true });
        W.slider(card, {
            id: "slider_scatter_count",
            label: `Points of interest (${procScatterCount}):`,
            value: procScatterCount,
            min: 1,
            max: 20,
            onChange: (v) => {
                procScatterCount = Math.round(parseFloat(v) || 4);
            },
        });
        W.button(card, {
            id: "btn_scatter_pois",
            text: icon("sparkle", "Scatter Points of Interest"),
            accent: UI.emerald,
            onClick: () => {
                const scattered = scatterPointsOfInterest(model.world.meta, model.world.spots, procScatterCount, requireTerrain());
                model.snapshot();
                scattered.forEach((s) => model.world.spots.push(s));
                statusMessage = `Scattered ${scattered.length} wilderness locations.`;
            },
        });
    });
}

// =================================================================================================
// TAB 5: AGENT COLLABORATION, BIBLE EXPORT & REVISION DIFF REVIEW
// =================================================================================================

function copyText(text: string, what: string): void {
    const ok = Entropy.Clipboard?.writeText(text);
    statusMessage = ok === false ? `${what} generated (${text.length} characters), but the clipboard was unavailable.` : `Copied ${what} to the clipboard (${text.length} characters).`;
}

function renderAgentView(main: string): void {
    W.label(main, { text: "Agents: your intents in, proposals out", bold: true, fontSize: 16, color: UI.cyan });
    W.label(main, {
        text: "You sketch what you want on the map; agents propose the changes that build it; nothing touches the world until you accept it. The built-in Planner Agent works from the terrain. External agents (Claude Code or any MCP client) read the same queue with game_planner_list_intents and answer with game_planner_propose_revision - or paste the Agent Brief into any chat.",
        wrap: true,
        color: UI.dim,
        fontSize: 12,
    });
    W.separator(main);

    const h = planHealth(model.world);
    const open = openIntents(model.world);
    const pending = model.pendingProposals;
    W.horizontal(main, () => {
        W.label(main, { text: icon(h.unmet ? "target" : "check-circle", `Plan health ${h.score}%`), bold: true, fontSize: 13, color: h.unmet ? UI.amber : UI.emerald });
        W.label(main, { text: `${h.met} met · ${h.unmet} unmet · ${h.manual} by hand · ${pending.length} proposal(s) waiting`, fontSize: 12, color: UI.dim });
    });
    W.spacer(main, 6);
    W.horizontal(main, () => {
        W.button(main, { id: "btn_draft_all", text: icon("robot", `Draft open intents (${open.filter((i) => i.kind !== "freeform").length})`), accent: UI.cyan, onClick: () => draftAllOpen() });
        W.button(main, { id: "btn_copy_agent_brief", text: icon("clipboard-text", "Copy Agent Brief (Markdown)"), accent: UI.amber, onClick: () => copyText(generateAgentBrief(model.world), "the Agent Brief") });
        W.button(main, { id: "btn_to_map_intent", text: icon("lightbulb", "Sketch an intent"), onClick: () => { model.activeTab = "map"; selectTool("intent"); } });
    });
    W.spacer(main, 12);

    // Inbox: every proposal still waiting on a decision.
    W.label(main, { text: icon("ghost", `Inbox (${pending.length})`), bold: true, fontSize: 13, color: UI.violet });
    if (!pending.length) {
        W.label(main, { text: "Nothing to review. Draft an intent, or wait for an external agent's proposal.", fontSize: 11, color: UI.dim });
    }
    pending.forEach((pr) => {
        const intent = pr.intentId ? model.intents.find((i) => i.id === pr.intentId) : undefined;
        if (intent) W.label(main, { text: icon(INTENT_ICONS[intent.kind], `For intent #${intent.number} ${intent.title}`), fontSize: 11, color: UI.amber });
        renderProposalChanges(main, pr);
        W.spacer(main, 6);
    });
    W.spacer(main, 10);

    // Queue: what is still asked of agents.
    W.label(main, { text: icon("list-checks", `Open intents (${open.length})`), bold: true, fontSize: 13, color: UI.amber });
    if (!open.length) W.label(main, { text: model.intents.length ? "Every intent is met." : "No intents yet - sketch some on the map with the Intent tool (I).", fontSize: 11, color: UI.dim });
    open.forEach((i) => {
        const ev = evaluateIntent(model.world, i);
        W.card(main, { id: `card_open_${i.id}`, fill: UI.card, padding: 8 }, (card) => {
            W.horizontal(card, () => {
                W.label(card, { text: icon(INTENT_ICONS[i.kind], `#${i.number} ${i.title}`), bold: true, fontSize: 12, color: UI.text });
                W.label(card, { text: `${INTENT_KIND_INFO[i.kind].label} · ${i.priority}${i.status === "claimed" ? ` · claimed by ${i.claimedBy}` : i.status === "proposed" ? " · in review" : ""}`, fontSize: 10.5, color: UI.dim });
            });
            if (i.directive) W.label(card, { text: `"${i.directive}"`, wrap: true, fontSize: 11, color: UI.dim });
            W.label(card, { text: icon(statusGlyph(ev), ev.summary), fontSize: 11, color: statusColor(ev) });
            W.horizontal(card, () => {
                if (i.kind !== "freeform") W.button(card, { id: `btn_draft_${i.id}`, text: icon("robot", "Draft"), onClick: () => draftIntent(i) });
                W.button(card, { id: `btn_show_${i.id}`, text: icon("map-trifold", "Show on map"), onClick: () => { model.activeTab = "map"; model.selectedId = i.id; model.selectedChangeId = null; } });
                W.button(card, { id: `btn_brief_${i.id}`, text: icon("copy", "Copy context"), onClick: () => copyText(JSON.stringify(intentContext(model.world, i), null, 2), `intent #${i.number}'s context`) });
            });
            if (agentNote && agentNote.intentId === i.id) W.label(card, { text: agentNote.text, wrap: true, fontSize: 10.5, color: UI.dim });
        });
        W.spacer(main, 4);
    });
    W.spacer(main, 12);

    W.label(main, { text: icon("export", "Exports"), bold: true, fontSize: 13, color: UI.text });
    W.horizontal(main, () => {
        W.button(main, { id: "btn_copy_bible_json", text: icon("clipboard-text", "Copy World Bible (JSON)"), accent: UI.emerald, onClick: () => copyText(exportWorldBibleJson(model.world), "the World Bible JSON") });
        W.button(main, { id: "btn_copy_gdd_md", text: icon("file-text", "Copy Game Design Doc (Markdown)"), accent: UI.cyan, onClick: () => copyText(generateGameDesignDoc(model.world), "the Game Design Document") });
        W.button(main, { id: "btn_export_svg_map", text: icon("file-svg", "Copy Vector SVG Map"), accent: UI.amber, onClick: () => copyText(exportMapToSvg(model.world, 1400, 1400), "the SVG map") });
    });
    W.spacer(main, 12);

    W.card(main, { id: "card_agent_prompts", fill: UI.card, padding: 12 }, (card) => {
        W.label(card, { text: "System Prompts for AI Game Masters & Roleplay Agents", bold: true, fontSize: 12, color: UI.text });
        const prompts = generateAgentPrompts(model.world);
        W.horizontal(card, () => {
            W.label(card, { text: "1. Game Master & Narrative Director Prompt:", bold: true, fontSize: 11, color: UI.emerald });
            W.button(card, { id: "btn_copy_gm_prompt", text: icon("copy", "Copy"), onClick: () => copyText(prompts.gameMasterPrompt, "the Game Master prompt") });
        });
        W.textInput(card, { id: "gm_prompt_preview", value: prompts.gameMasterPrompt, multiline: true, height: 160, onChange: () => {} });
        W.spacer(card, 6);
        W.horizontal(card, () => {
            W.label(card, { text: "2. Technical Level Designer Prompt:", bold: true, fontSize: 11, color: UI.cyan });
            W.button(card, { id: "btn_copy_level_prompt", text: icon("copy", "Copy"), onClick: () => copyText(prompts.levelDesignerPrompt, "the Level Designer prompt") });
        });
        W.textInput(card, { id: "level_prompt_preview", value: prompts.levelDesignerPrompt, multiline: true, height: 160, onChange: () => {} });
    });
}

// =================================================================================================
// ADDON INITIALIZATION & MCP BRIDGE
// =================================================================================================

addon.onInit(() => {
    loadWorld();

    const tabId = addon.UI.createTab({
        title: icon("map-trifold", "Game World Planner"),
        scroll: false,
        onRender: () => {
            renderHeader(tabId);

            const ownScroll = model.activeTab === "map" || model.activeTab === "codex" || model.activeTab === "story";
            if ((model.activeTab as string) === "procedural") model.activeTab = "map";
            W.split(
                tabId,
                {
                    id: "planner_body_" + model.activeTab,
                    sideOpen: false,
                    sideWidth: 0,
                    reserveBottom: 26,
                    minHeight: 650,
                    mainPadding: ownScroll ? 0 : 16,
                    // The agent page is taller than the window; it scrolls here.
                    scrollMain: !ownScroll,
                } as SplitConfig,
                (main: string) => {
                    if (model.activeTab === "map") renderMapView(main);
                    else if (model.activeTab === "codex") renderCodexView(main);
                    else if (model.activeTab === "story") renderStoryView(main);
                    else renderAgentView(main);
                }
            );

            renderStatusBar(tabId);
        },
    });

    // Keyboard shortcuts (plain keys never reach here while a text field has focus).
    Entropy.Input.onKeyDown((key: string, ctrl: boolean) => {
        const k = key.toLowerCase();
        if (ctrl) {
            if (k === "s") saveWorld();
            else if (k === "z") model.undo();
            else if (k === "y") model.redo();
            return;
        }
        if (k === "b") {
            model.setBlockingMode(!model.world.meta.blockingMode);
            return;
        }
        if (model.activeTab !== "map") return;
        if (k === "escape") cancelAction();
        else if (k === "enter") finishDrawing();
        else if (k === "delete" || k === "backspace") deleteSelected();
        else if (k === "v") selectTool("select");
        else if (k === "h") selectTool("pan");
        else if (k === "p") selectTool("place_spot");
        else if (k === "l") selectTool("draw_path");
        else if (k === "g") selectTool("draw_region");
        else if (k === "m") selectTool(model.activeTool === "measure" ? "select" : "measure");
        else if (k === "i") selectTool(model.activeTool === "intent" ? "select" : "intent");
        else if (k === "e") selectTool(model.activeTool === "sculpt" ? "select" : "sculpt");
        else if (k === "n") selectTool(model.activeTool === "paint" ? "select" : "paint");
        else if (k === "u") selectTool(model.activeTool === "populate" ? "select" : "populate");
        else if (k === "[" || k === "]") {
            const f = k === "]" ? 1.25 : 0.8;
            if (model.activeTool === "sculpt") model.sculpt.radiusKm = Math.min(6, Math.max(0.1, model.sculpt.radiusKm * f));
            else model.paintRadiusKm = Math.min(6, Math.max(0.1, model.paintRadiusKm * f));
        }
        else if ((k === "a" || k === "r") && model.selectedChangeId) decideChange(model.selectedChangeId, k === "a");
        else if (k === "f") model.fitRequest++;
        else if (k === "t") {
            const i = TERRAIN_STYLES.findIndex((s) => s.id === model.terrainStyle);
            model.terrainStyle = TERRAIN_STYLES[(i + 1) % TERRAIN_STYLES.length].id;
        }
    });

    // ---------------------------------------------------------------------------------------------
    // MCP tools for coding agents & LLMs
    // ---------------------------------------------------------------------------------------------

    addon.registerTool(
        {
            name: "game_planner_get_world",
            description: "Returns the Game World specification (metadata, spots/POIs, paths, regions, codex, missions) from the Game World Planner. The heightfield is summarized; use game_planner_sample_terrain for elevations.",
            parameters: { type: "object", properties: {} },
        },
        () => {
            const t = model.world.terrain;
            return {
                success: true,
                meta: model.world.meta,
                spotsCount: model.world.spots.length,
                pathsCount: model.world.paths.length,
                regionsCount: model.world.regions.length,
                codexCount: model.world.codex.length,
                missionsCount: model.world.missions.length,
                terrain: t ? { cols: t.cols, rows: t.rows, minM: t.minM, maxM: t.maxM, seaLevelM: t.seaLevelM } : null,
                marks: layerCoverage(model.world.overlay, model.world.meta).map((c) => ({ key: c.key, label: layerLabel(model.world, c.key), areaKm2: c.areaKm2 })),
                world: { ...model.world, terrain: undefined, overlay: undefined },
            };
        }
    );

    addon.registerTool(
        {
            name: "game_planner_sample_terrain",
            description: "Ground elevation (meters) and slope (degrees) at world positions in km.",
            parameters: {
                type: "object",
                properties: {
                    points: { type: "array", items: { type: "array", items: { type: "number" } }, description: "[[x, y], ...] in km" },
                },
                required: ["points"],
            },
        },
        (args: any) => {
            const pts: Array<[number, number]> = Array.isArray(args.points) ? args.points : [];
            return {
                success: true,
                samples: pts.map(([x, y]) => ({ x, y, elevationM: model.elevationAt(Number(x), Number(y), 0), slopeDeg: Number(model.slopeAt(Number(x), Number(y)).toFixed(1)) })),
            };
        }
    );

    addon.registerTool(
        {
            name: "game_planner_sculpt_terrain",
            description: "Edits the terrain. Line modes follow `points` (a polyline, km): canyon (carve; widthKm, depthM, steepness 0..1 - the floor runs downhill from the first point), ridge (a mountain range; widthKm, heightM, roughness 0..1), grade (a road bed; widthKm, maxGradePercent). Area mode: plateau (level the polygon; targetM or the mean ground, featherKm). Brush modes dab along the points: raise, lower, smooth, flatten (targetM), roughen (radiusKm, strength 0..1). One undo step; spots that snap to the landscape follow.",
            parameters: {
                type: "object",
                properties: {
                    mode: { type: "string" },
                    points: { type: "array", items: { type: "array", items: { type: "number" } } },
                    widthKm: { type: "number" },
                    depthM: { type: "number" },
                    heightM: { type: "number" },
                    steepness: { type: "number" },
                    roughness: { type: "number" },
                    maxGradePercent: { type: "number" },
                    targetM: { type: "number" },
                    featherKm: { type: "number" },
                    radiusKm: { type: "number" },
                    strength: { type: "number" },
                },
                required: ["mode", "points"],
            },
        },
        (args: any) => {
            const mode = String(args.mode) as SculptMode;
            if (!SCULPT_MODES.includes(mode)) return { success: false, error: `Unknown mode "${args.mode}". Use one of ${SCULPT_MODES.join(", ")}.` };
            const pts: [number, number][] = (Array.isArray(args.points) ? args.points : []).filter((q: any) => Array.isArray(q) && q.length >= 2).map((q: any) => [Number(q[0]), Number(q[1])]);
            const saved = { ...model.sculpt };
            const s = model.sculpt;
            s.mode = mode;
            const num = (v: any, d: number) => (v === undefined || v === null || isNaN(Number(v)) ? d : Number(v));
            s.canyonWidthKm = num(args.widthKm, s.canyonWidthKm);
            s.canyonDepthM = num(args.depthM, s.canyonDepthM);
            s.canyonSteepness = num(args.steepness, s.canyonSteepness);
            s.ridgeWidthKm = num(args.widthKm, s.ridgeWidthKm);
            s.ridgeHeightM = num(args.heightM, s.ridgeHeightM);
            s.ridgeRoughness = num(args.roughness, s.ridgeRoughness);
            s.gradeWidthKm = num(args.widthKm, s.gradeWidthKm);
            s.gradeMaxPercent = num(args.maxGradePercent, s.gradeMaxPercent);
            s.featherKm = num(args.featherKm, s.featherKm);
            s.radiusKm = num(args.radiusKm, s.radiusKm);
            s.strength = num(args.strength, s.strength);
            if (args.targetM !== undefined) {
                s.targetM = Number(args.targetM);
                s.snapToLandscape = false;
            }
            let ok = true;
            if (SCULPT_INFO[mode].kind === "brush") {
                if (!pts.length) ok = false;
                else {
                    model.sculptBrush(pts, false);
                    model.sculptBrush([], true);
                }
            } else {
                ok = model.sculptShape(pts);
            }
            model.sculpt = { ...saved };
            if (!ok) return { success: false, error: `${mode} needs ${SCULPT_INFO[mode].kind === "area" ? "3+" : SCULPT_INFO[mode].kind === "line" ? "2+" : "1+"} points.` };
            const t = model.world.terrain!;
            statusMessage = `An agent sculpted the terrain (${SCULPT_INFO[mode].label}).`;
            return { success: true, terrain: { minM: t.minM, maxM: t.maxM }, samples: pts.slice(0, 20).map(([x, y]) => ({ x, y, elevationM: model.elevationAt(x, y, 0) })) };
        }
    );

    addon.registerTool(
        {
            name: "game_planner_paint_marks",
            description: `Paints planning marks (not built content) along a stroke of points, or fills a polygon with fill: true. mark: one of ${MARKS.map((m) => m.id).join(", ")}; or codexId to paint where a codex entry (enemy, NPC, faction) roams. radiusKm (default 1), strength 0..1, erase.`,
            parameters: {
                type: "object",
                properties: {
                    mark: { type: "string" },
                    codexId: { type: "string" },
                    points: { type: "array", items: { type: "array", items: { type: "number" } } },
                    radiusKm: { type: "number" },
                    strength: { type: "number" },
                    erase: { type: "boolean" },
                    fill: { type: "boolean" },
                },
                required: ["points"],
            },
        },
        (args: any) => {
            const key = args.codexId ? codexLayerKey(String(args.codexId)) : String(args.mark || "");
            if (args.codexId && !model.world.codex.some((c) => c.id === args.codexId)) return { success: false, error: `No codex entry "${args.codexId}".` };
            if (!args.codexId && !MARK_BY_ID[key]) return { success: false, error: `Unknown mark "${args.mark}". Use one of ${MARKS.map((m) => m.id).join(", ")}, or a codexId.` };
            const pts: [number, number][] = (Array.isArray(args.points) ? args.points : []).filter((q: any) => Array.isArray(q) && q.length >= 2).map((q: any) => [Number(q[0]), Number(q[1])]);
            let cells = 0;
            if (args.fill) {
                if (pts.length < 3) return { success: false, error: "fill needs a polygon of 3+ points." };
                cells = model.editOverlay((o) => fillPolygon(o, model.world.meta, key, pts, args.erase ? 0 : Math.min(1, Math.max(0.05, Number(args.strength ?? 1)))));
            } else {
                cells = model.paint(key, pts, true, { radiusKm: Number(args.radiusKm ?? 1), strength: Number(args.strength ?? 0.7), erase: !!args.erase, clip: undefined, exclusive: false });
            }
            return { success: true, cellsChanged: cells, coverage: layerCoverage(model.world.overlay, model.world.meta).find((c) => c.key === key) ?? null };
        }
    );

    addon.registerTool(
        {
            name: "game_planner_place_codex",
            description: "Places a codex entry on the map at one spot: a named NPC, a pack of enemies, a faction outpost. count, behavior (static, wander, patrol, guard, ambush, spawner, vendor, quest_giver), levelMin, levelMax, notes.",
            parameters: {
                type: "object",
                properties: {
                    codexId: { type: "string" },
                    x: { type: "number" },
                    y: { type: "number" },
                    count: { type: "number" },
                    behavior: { type: "string" },
                    levelMin: { type: "number" },
                    levelMax: { type: "number" },
                    notes: { type: "string" },
                },
                required: ["codexId", "x", "y"],
            },
        },
        (args: any) => {
            const c = model.world.codex.find((e) => e.id === args.codexId);
            if (!c) return { success: false, error: `No codex entry "${args.codexId}".` };
            const opts: Partial<CodexPlacement> = {};
            if (args.count !== undefined) opts.count = Math.max(1, Math.round(Number(args.count)));
            if (PLACEMENT_BEHAVIORS.includes(args.behavior)) opts.behavior = args.behavior;
            if (args.levelMin !== undefined) opts.levelMin = Number(args.levelMin);
            if (args.levelMax !== undefined) opts.levelMax = Number(args.levelMax);
            if (args.notes) opts.notes = String(args.notes);
            const p = model.addPlacement(createPlacement(c, Number(args.x), Number(args.y), opts));
            return { success: true, placement: p };
        }
    );

    addon.registerTool(
        {
            name: "game_planner_quest_plan",
            description: "Reads (and optionally updates) a quest's planning detail, then returns its planning check: journey over terrain and roads, time at objectives, danger vs level, whether named enemies/NPCs are placed where needed, story order. update may set giverCodexId, hook, levelMin, levelMax, objectiveDetails ({ [spotId]: { action, targetCodexId, count, optional, minutes, note } }, merged), rewardCodexIds, reputation, outcomes.",
            parameters: {
                type: "object",
                properties: { missionId: { type: "string" }, update: { type: "object" } },
                required: ["missionId"],
            },
        },
        (args: any) => {
            const m = model.world.missions.find((x) => x.id === args.missionId);
            if (!m) return { success: false, error: `No quest "${args.missionId}".` };
            const u = args.update && typeof args.update === "object" ? args.update : null;
            if (u) {
                const allowed = ["giverCodexId", "hook", "levelMin", "levelMax", "rewardCodexIds", "reputation", "outcomes"];
                const patch: Partial<Mission> = {};
                for (const k of allowed) if (k in u) (patch as any)[k] = u[k];
                if (u.objectiveDetails && typeof u.objectiveDetails === "object") {
                    const merged: Record<string, QuestObjectiveDetail> = { ...(m.objectiveDetails ?? {}) };
                    for (const [sid, d] of Object.entries(u.objectiveDetails as Record<string, any>)) {
                        const action = OBJECTIVE_ACTIONS.includes(d?.action) ? d.action : merged[sid]?.action ?? "go";
                        merged[sid] = { ...(merged[sid] ?? {}), ...d, action };
                    }
                    patch.objectiveDetails = merged;
                }
                model.updateMission(m.id, patch);
            }
            const fresh = model.world.missions.find((x) => x.id === m.id)!;
            const a = analyzeQuest(model.world, fresh);
            return {
                success: true,
                mission: fresh,
                analysis: { summary: a.summary, travelMinutes: a.travelMinutes, activityMinutes: a.activityMinutes, totalMinutes: a.totalMinutes, peakDanger: a.peakDanger, chainDepth: a.chainDepth, unlocks: a.unlocks.map((x) => x.id), legs: a.legs, issues: a.issues },
            };
        }
    );

    addon.registerTool(
        {
            name: "game_planner_add_poi",
            description: "Adds a new Point of Interest (POI) spot to the Game World map. Elevation defaults to the ground there.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Name of the location" },
                    spotType: { type: "string", description: "capital, city, town, village, fortress, dungeon, ruin, port, shrine, camp, mine, boss, landmark" },
                    x: { type: "number", description: "World X coordinate in km" },
                    y: { type: "number", description: "World Y coordinate in km" },
                    elevation: { type: "number", description: "Elevation in meters above sea level (default: the terrain)" },
                    description: { type: "string", description: "Location description and lore" },
                    tags: { type: "array", items: { type: "string" }, description: "Location tags" },
                },
                required: ["name", "spotType", "x", "y"],
            },
        },
        (args: any) => {
            const type = (SPOT_TYPES.includes(args.spotType) ? args.spotType : "landmark") as SpotType;
            const x = Number(args.x);
            const y = Number(args.y);
            const newSpot = model.addSpot({
                name: String(args.name),
                spotType: type,
                x,
                y,
                elevation: args.elevation !== undefined ? Number(args.elevation) : model.elevationAt(x, y, 100),
                color: SPOT_COLORS[type],
                icon: type,
                tags: Array.isArray(args.tags) ? args.tags : [type],
                isMajor: type === "capital" || type === "city",
                description: String(args.description || ""),
                loreNotes: "",
                linkedCodexIds: [],
                linkedMissionIds: [],
            });
            saveWorld();
            return { success: true, spot: newSpot };
        }
    );

    addon.registerTool(
        {
            name: "game_planner_calculate_travel",
            description: "Calculates in-game distance and Time-to-Travel across multiple travel modes (foot, mount, vehicle, boat, air) between two points.",
            parameters: {
                type: "object",
                properties: {
                    fromX: { type: "number" },
                    fromY: { type: "number" },
                    toX: { type: "number" },
                    toY: { type: "number" },
                },
                required: ["fromX", "fromY", "toX", "toY"],
            },
        },
        (args: any) => {
            const est = travelBetween([Number(args.fromX), Number(args.fromY)], [Number(args.toX), Number(args.toY)]);
            return { success: true, estimate: est };
        }
    );

    addon.registerTool(
        {
            name: "game_planner_list_intents",
            description: "The designer's design intents - what they sketched on the map and want built - with spatial context (terrain, spots inside and nearby, route ends), whether the world meets each one now, and its acceptance criteria. Unmet intents are your work queue; answer one with game_planner_propose_revision. Also returns the same as a Markdown brief.",
            parameters: {
                type: "object",
                properties: {
                    includeMet: { type: "boolean", description: "Also list intents the world already meets (default false)" },
                },
            },
        },
        (args: any) => {
            const list = args?.includeMet ? model.intents.filter((i) => i.status !== "dismissed") : openIntents(model.world);
            return {
                success: true,
                world: { name: model.world.meta.name, genre: model.world.meta.genre, widthKm: model.world.meta.worldWidthKm, heightKm: model.world.meta.worldHeightKm, seaLevelM: model.world.meta.seaLevelM },
                health: planHealth(model.world),
                intents: list.map((i) => intentContext(model.world, i)),
                brief: generateAgentBrief(model.world),
            };
        }
    );

    addon.registerTool(
        {
            name: "game_planner_claim_intent",
            description: "Marks an intent as being worked on by you, so the designer (and other agents) can see who has it. Call before drafting a proposal for it.",
            parameters: {
                type: "object",
                properties: { intentId: { type: "string" }, intentNumber: { type: "number", description: "Or the intent's #number" }, agentName: { type: "string" } },
                required: ["agentName"],
            },
        },
        (args: any) => {
            const intent = findIntentArg(args);
            if (!intent) return { success: false, error: `No intent "${args.intentId ?? args.intentNumber}". Call game_planner_list_intents.` };
            model.updateIntent(intent.id, { status: "claimed", claimedBy: String(args.agentName || "agent") });
            statusMessage = `${intent.claimedBy} claimed intent #${intent.number} "${intent.title}".`;
            return { success: true, intent: intentContext(model.world, intent) };
        }
    );

    addon.registerTool(
        {
            name: "game_planner_create_intent",
            description: "Sketches a design intent on the map, as the designer would with the Intent tool (useful when the designer describes a goal in chat). shape: pin [[x,y]], area (polygon, 3+ points) or route [[x1,y1],[x2,y2]] (ends on spots are pinned to them). kind: settle, danger, landmark, connect, pacing, quest, freeform (default from the shape and the directive's words).",
            parameters: {
                type: "object",
                properties: {
                    shape: { type: "string" },
                    points: { type: "array", items: { type: "array", items: { type: "number" } } },
                    kind: { type: "string" },
                    title: { type: "string" },
                    directive: { type: "string", description: "What the designer wants, in their words" },
                    params: { type: "object", description: "count, spotType, dangerLevel, targetMinutes, mode, tolerance, pathType, biome" },
                    priority: { type: "string" },
                },
                required: ["shape", "points"],
            },
        },
        (args: any) => {
            const shape = (["pin", "area", "route"].includes(args.shape) ? args.shape : "pin") as IntentShape;
            const pts: [number, number][] = (Array.isArray(args.points) ? args.points : []).filter((q: any) => Array.isArray(q) && q.length >= 2).map((q: any) => [Number(q[0]), Number(q[1])]);
            const need = shape === "area" ? 3 : shape === "route" ? 2 : 1;
            if (pts.length < need) return { success: false, error: `A ${shape} needs at least ${need} point(s).` };
            const kind = INTENT_KINDS.includes(args.kind) && INTENT_KIND_INFO[args.kind as IntentKind].shapes.includes(shape) ? (args.kind as IntentKind) : undefined;
            const from = shape === "route" ? spotNear(model.world, pts[0], 0.3) : undefined;
            const to = shape === "route" ? spotNear(model.world, pts[pts.length - 1], 0.3) : undefined;
            const intent = model.addIntent(shape, shape === "route" ? [pts[0], pts[pts.length - 1]] : pts, {
                kind,
                ...(args.title ? { title: String(args.title) } : from && to ? { title: `${from.name} → ${to.name}` } : {}),
                directive: String(args.directive || ""),
                params: args.params && typeof args.params === "object" ? args.params : {},
                priority: ["low", "normal", "high"].includes(args.priority) ? args.priority : "normal",
                fromSpotId: from?.id,
                toSpotId: to?.id,
            });
            announceIntent(intent);
            return { success: true, intent: intentContext(model.world, intent) };
        }
    );

    addon.registerTool(
        {
            name: "game_planner_propose_revision",
            description: "Submits changes for the designer to review: they appear on the map as violet previews and the designer accepts or rejects each one. Pass intentId when answering an intent. Each change: { changeType: add_spot | modify_spot | delete_spot | add_path | modify_path | delete_path | add_region | modify_region | add_mission | add_codex, title?, summary?, targetId? (required to modify/delete), after: {...} }. Minimal fields are filled in (add_spot { name, spotType, x, y } gets elevation from the terrain, color, icon). Invalid changes are returned in errors and not filed.",
            parameters: {
                type: "object",
                properties: {
                    agentName: { type: "string" },
                    motivation: { type: "string" },
                    intentId: { type: "string" },
                    intentNumber: { type: "number", description: "Or the intent's #number" },
                    changes: { type: "array", items: { type: "object" } },
                },
                required: ["agentName", "motivation", "changes"],
            },
        },
        (args: any) => {
            const intent = findIntentArg(args);
            if ((args.intentId || args.intentNumber) && !intent) return { success: false, error: `No intent "${args.intentId ?? args.intentNumber}". Call game_planner_list_intents.` };
            const { changes, errors } = normalizeProposalChanges(model.world, args.changes);
            if (!changes.length) return { success: false, errors: errors.length ? errors : ["No changes."] };
            const proposal = model.addProposal({
                id: `proposal_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                agentName: String(args.agentName || "Agent"),
                timestamp: Date.now(),
                motivation: String(args.motivation || ""),
                changes,
                ...(intent ? { intentId: intent.id } : {}),
            });
            statusMessage = `${proposal.agentName} proposed ${changes.length} change(s)${intent ? ` for intent #${intent.number}` : ""} - review them on the map.`;
            Entropy.UI.toast?.({ id: "planner-proposal", message: statusMessage, kind: "info", durationMs: 4000 });
            return { success: true, proposalId: proposal.id, filed: changes.map((c) => ({ id: c.id, changeType: c.changeType, title: c.title, targetId: c.targetId })), errors };
        }
    );

    addon.registerTool(
        {
            name: "game_planner_proposal_status",
            description: "What the designer decided about your proposals: each change's status (pending, accepted, rejected), and the intent's check now.",
            parameters: { type: "object", properties: { proposalId: { type: "string" } } },
        },
        (args: any) => {
            const list = args?.proposalId ? model.world.proposals.filter((p) => p.id === args.proposalId) : model.world.proposals;
            return {
                success: true,
                proposals: list.map((p) => {
                    const intent = p.intentId ? model.intents.find((i) => i.id === p.intentId) : undefined;
                    return {
                        id: p.id,
                        agentName: p.agentName,
                        intentId: p.intentId,
                        changes: p.changes.map((c) => ({ id: c.id, changeType: c.changeType, title: c.title, status: c.status })),
                        intent: intent ? { number: intent.number, status: intent.status, evaluation: evaluateIntent(model.world, intent) } : undefined,
                    };
                }),
            };
        }
    );

    addon.registerTool(
        {
            name: "game_planner_export_svg",
            description: "Generates and returns the complete Game World Map as a vector SVG string.",
            parameters: {
                type: "object",
                properties: {
                    width: { type: "number", description: "SVG output width (default 1200)" },
                    height: { type: "number", description: "SVG output height (default 1200)" },
                },
            },
        },
        (args: any) => ({ success: true, svg: exportMapToSvg(model.world, Number(args.width || 1200), Number(args.height || 1200)) })
    );

    addon.registerTool(
        {
            name: "game_planner_generate_gdd",
            description: "Generates the complete Game Design Document in Markdown format.",
            parameters: { type: "object", properties: {} },
        },
        () => ({ success: true, markdown: generateGameDesignDoc(model.world) })
    );

    // A read-only view of the planner's UI state, for tests and agents driving the app.
    addon.registerTool(
        {
            name: "game_planner_state",
            description: "The planner's current UI state: tab, tool, selection, pending drawing points, measurement, terrain style.",
            parameters: { type: "object", properties: {} },
        },
        () => ({
            success: true,
            activeTab: model.activeTab,
            activeTool: model.activeTool,
            selectedId: model.selectedId,
            pendingPathPoints: model.pendingPathPoints,
            pendingRegionPoints: model.pendingRegionPoints,
            measurePoints: model.measurePoints,
            selectedChangeId: model.selectedChangeId,
            pendingIntentPoints: model.pendingIntentPoints,
            health: planHealth(model.world),
            intents: model.intents.map((i) => ({ id: i.id, number: i.number, kind: i.kind, shape: i.shape, title: i.title, status: i.status, evaluation: evaluateIntent(model.world, i) })),
            proposals: model.world.proposals.map((p) => ({ id: p.id, agentName: p.agentName, intentId: p.intentId, changes: p.changes.map((c) => ({ id: c.id, changeType: c.changeType, status: c.status, targetId: c.targetId })) })),
            travel: lastTravelEstimate ? { distanceKm: lastTravelEstimate.directDistanceKm, effortKm: lastTravelEstimate.distanceKm, climbM: lastTravelEstimate.climbM, summary: lastTravelEstimate.summaryText } : null,
            terrainStyle: model.terrainStyle,
            sculptMode: model.sculpt.mode,
            pendingSculptPoints: model.pendingSculptPoints,
            paintKey: model.paintKey,
            populateCodexId: model.populateCodexId,
            highlightedQuestId: model.highlightedQuestId,
            marks: layerCoverage(model.world.overlay, model.world.meta).map((c) => ({ key: c.key, areaKm2: c.areaKm2 })),
            placements: model.placements.map((p) => ({ id: p.id, codexId: p.codexId, x: p.x, y: p.y, count: p.count, behavior: p.behavior })),
            terrainRange: model.world.terrain ? [model.world.terrain.minM, model.world.terrain.maxM] : null,
            canUndo: model.canUndo,
            counts: { spots: model.world.spots.length, paths: model.world.paths.length, regions: model.world.regions.length, codex: model.world.codex.length, missions: model.world.missions.length, intents: model.intents.length, pendingProposals: model.pendingProposals.length, placements: model.placements.length },
            spots: model.world.spots.map((s) => ({ id: s.id, name: s.name, spotType: s.spotType, x: s.x, y: s.y, elevation: s.elevation, snapToGround: isSnapped(s), ground: model.elevationAt(s.x, s.y, 0) })),
            paths: model.world.paths.map((p) => ({ id: p.id, name: p.name, pathType: p.pathType, points: p.points.length })),
            regions: model.world.regions.map((r) => ({ id: r.id, name: r.name, points: r.points.length })),
            status: statusMessage,
        })
    );
});
