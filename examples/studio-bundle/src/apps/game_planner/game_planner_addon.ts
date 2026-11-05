/// <reference path="../../addon.d.ts" />

import { PlannerModel, paletteForGenre } from "./planner_model";
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
import { BIOMES, PATH_DEFAULTS, PATH_TYPES, SPOT_COLORS, SPOT_TYPES, isMajorSpotType } from "./planner_defaults";
import {
    CRIMSON_EXPANSE_PRESET,
    NEO_AETHELGARD_PRESET,
    SHATTERED_ISLES_PRESET,
} from "./presets";
import type {
    CodexCategory,
    GameWorld,
    IntentKind,
    IntentShape,
    Mission,
    PlanIntent,
    RegionType,
    RevisionChange,
    RevisionProposal,
    SpotType,
    TravelMode,
    TerrainStyle,
    TravelEstimate,
    WorldPath,
    WorldRegion,
    WorldSpot,
} from "./planner_types";
import type { GameMapConfig, IconName, MapGhostConfig, MapIntentConfig, SplitConfig } from "../../addon";

// Register Addon
const addon = Entropy.Addon.register({
    name: "game-world-planner",
    version: "1.3.0",
    description: "Game World Planner: sketch design intents on a topographic map and let agents build them - live intent checks, previewed agent proposals you accept or reject on the map, a terrain-aware built-in planner agent and MCP tools for external agents; plus travel times, procedural terrain, codex and story.",
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

function setModel(next: PlannerModel): void {
    const fit = model.fitRequest + 1;
    model = next;
    model.fitRequest = fit;
    procSeed = model.world.meta.seed;
    procIslandMask = model.world.meta.genre === "fantasy";
    lastTravelEstimate = null;
    agentNote = null;
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
    };
    statusMessage = names[tool];
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
    if (model.pendingPathPoints.length || model.pendingRegionPoints.length || model.pendingIntentPoints.length) {
        model.cancelPendingPath();
        model.cancelPendingRegion();
        model.cancelPendingIntent();
        statusMessage = "Drawing cancelled.";
    } else if (model.selectedChangeId) {
        model.selectedChangeId = null;
    } else if (model.measurePoints.p1) {
        model.clearMeasurement();
        lastTravelEstimate = null;
        statusMessage = "Ruler cleared.";
    } else if (model.activeTool !== "select") {
        selectTool("select");
    } else {
        model.selectedId = null;
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
                    { id: "procedural", label: icon("mountains", "Terrain & Procedural") },
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
                toggle("btn_toggle_intents", icon("lightbulb", "Intents"), model.showIntents, () => (model.showIntents = !model.showIntents));
                toggle("btn_toggle_proposals", icon("ghost", "Proposals"), model.showProposals, () => (model.showProposals = !model.showProposals));
                toggle("btn_toggle_labels", icon("tag", "Labels"), model.showLabels, () => (model.showLabels = !model.showLabels));
                toggle("btn_toggle_grid", icon("grid-four", "Grid"), model.showGrid, () => (model.showGrid = !model.showGrid));
                toggle("btn_toggle_minimap", icon("map-trifold", "Overview"), model.showMinimap, () => (model.showMinimap = !model.showMinimap));
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
    }
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

    const pending = model.activeTool === "draw_path" ? model.pendingPathPoints : model.activeTool === "draw_region" ? model.pendingRegionPoints : model.activeTool === "intent" ? model.pendingIntentPoints : [];
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
        pendingMode: model.activeTool === "draw_path" ? "path" : model.activeTool === "draw_region" ? "region" : model.activeTool === "intent" ? `intent_${model.intentShape}` : undefined,
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
    if (intent) return renderIntentInspector(panel, intent);
    const spot = selId ? model.world.spots.find((s) => s.id === selId) : undefined;
    const path = selId ? model.world.paths.find((p) => p.id === selId) : undefined;
    const region = selId ? model.world.regions.find((r) => r.id === selId) : undefined;
    if (spot) return renderSpotInspector(panel, spot);
    if (path) return renderPathInspector(panel, path);
    if (region) return renderRegionInspector(panel, region);

    renderPlanBoard(panel);
    W.spacer(panel, 10);
    W.label(panel, {
        text: "Click a spot, path, region or intent to edit it. Tools: V select, H pan, P spot, L path, G region, M measure, I intent. Space-drag or right-drag pans, the wheel zooms, F fits the world, Esc cancels, Delete removes the selection.",
        wrap: true,
        color: UI.dim,
        fontSize: 11,
    });
    W.spacer(panel, 10);

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
        W.label(card, { text: `${model.world.spots.length} spots · ${model.world.paths.length} paths · ${model.world.regions.length} regions`, fontSize: 11, color: UI.dim });
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

    W.numericInput(panel, {
        id: "edit_spot_elevation",
        label: "Elevation (m):",
        value: spot.elevation,
        onChange: (v) => model.updateSpot(spot.id, { elevation: parseFloat(v) || 0 }),
    });
    if (model.world.terrain) {
        const ground = model.elevationAt(spot.x, spot.y);
        const slope = model.slopeAt(spot.x, spot.y);
        const off = spot.elevation - ground;
        W.label(panel, {
            text: `Ground here: ${ground} m, slope ${slope.toFixed(0)}°${Math.abs(off) > 5 ? ` (spot is ${off > 0 ? "+" : ""}${off} m off the ground)` : ""}`,
            fontSize: 11,
            color: Math.abs(off) > 5 ? UI.amber : UI.dim,
        });
        if (Math.abs(off) > 5) {
            W.button(panel, {
                id: "btn_spot_to_ground",
                text: icon("mountains", "Put on the ground"),
                onClick: () => model.updateSpot(spot.id, { elevation: ground }),
            });
        }
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

// =================================================================================================
// TAB 2: CODEX (CHARACTERS, POWERS, WEAPONS, FACTIONS, LORE)
// =================================================================================================

const CODEX_ICONS: Record<CodexCategory, IconName> = {
    character: "user",
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
        { id: "power", label: "Powers" },
        { id: "weapon", label: "Weapons" },
        { id: "faction", label: "Factions" },
        { id: "lore", label: "Lore" },
    ];

    for (const row of [categories.slice(0, 3), categories.slice(3)]) {
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
        W.horizontal(main, () => {
            W.label(main, { text: `${k + 1}. ${s ? s.name : "(missing spot)"}`, fontSize: 11, color: UI.dim });
            W.button(main, {
                id: `btn_remove_objective_${k}`,
                text: icon("x", "Remove"),
                onClick: () => model.updateMission(mission.id, { objectiveSpotIds: mission.objectiveSpotIds.filter((_, i) => i !== k) }),
            });
        });
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
    if (startSpot && objSpots.length > 0 && turnInSpot) {
        const routeWaypoints = [startSpot, ...objSpots, turnInSpot].map((s) => ({ x: s.x, y: s.y, elevation: s.elevation }));
        const routeFoot = calculateRouteTravelTime(routeWaypoints, "foot");
        const routeHorse = calculateRouteTravelTime(routeWaypoints, "mount");
        W.card(main, { id: "card_mission_route", fill: UI.card, padding: 10 }, (card) => {
            W.label(card, { text: "Quest Journey Estimate", bold: true, fontSize: 11, color: UI.amber });
            W.label(card, { text: `${startSpot.name} → ${objSpots.map((s) => s.name).join(" → ")} → ${turnInSpot.name}`, fontSize: 11, color: UI.text, wrap: true });
            W.label(card, { text: `Total distance: ${routeFoot.distanceKm} km`, fontSize: 11, color: UI.text });
            W.label(card, { text: `On foot: ${routeFoot.formattedDuration} · Mounted: ${routeHorse.formattedDuration}`, fontSize: 11, color: UI.dim });
        });
    } else {
        W.label(main, { text: "Set a quest giver and at least one objective to estimate the journey.", fontSize: 11, color: UI.dim });
    }

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

// =================================================================================================
// TAB 4: TERRAIN & PROCEDURAL TOOLS
// =================================================================================================

function requireTerrain() {
    model.ensureTerrain();
    return model.world.terrain!;
}

function renderProceduralView(main: string): void {
    W.label(main, { text: "Terrain & Procedural Tools", bold: true, fontSize: 16, color: UI.emerald });
    W.label(main, {
        text: "Every tool here works on the world's one heightfield: rivers follow its drainage, settlements are scored on it, roads are routed over it, and spots read their elevation from it.",
        color: UI.dim,
        fontSize: 12,
        wrap: true,
    });
    W.separator(main);

    const t = model.world.terrain;
    if (t) {
        const stats = terrainStats(t.data);
        const land = t.data.filter((v) => v > t.seaLevelM).length / t.data.length;
        W.card(main, { id: "card_terrain_stats", fill: UI.card, padding: 10 }, (card) => {
            W.horizontal(card, () => {
                W.label(card, { text: `Current terrain: ${t.cols}x${t.rows} grid · ${Math.round(stats.min)} to ${Math.round(stats.max)} m · ${Math.round(land * 100)}% land`, fontSize: 12, color: UI.text });
                W.spacer(card, 12);
                W.button(card, {
                    id: "btn_view_on_map",
                    text: icon("map-trifold", "View on Map"),
                    onClick: () => {
                        model.activeTab = "map";
                    },
                });
            });
        });
        W.spacer(main, 10);
    }

    // 1. Heightfield
    W.card(main, { id: "card_proc_heightfield", fill: UI.card, padding: 12 }, (card) => {
        W.label(card, { text: "1. Terrain Heightfield", bold: true, fontSize: 13, color: UI.text });
        W.label(card, { text: "Domain-warped fractal landmass with ridged mountain ranges, beaches and continental shelves.", color: UI.dim, fontSize: 11 });
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
        W.label(card, { text: "2. Hydraulic Erosion", bold: true, fontSize: 13, color: UI.text });
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
        W.label(card, { text: "3. Rivers from Drainage", bold: true, fontSize: 13, color: UI.text });
        W.label(card, { text: "Fills pits, routes every cell's water downhill, and traces the biggest catchments from source to sea.", color: UI.dim, fontSize: 11, wrap: true });
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
                if (procCarveRivers && rivers.length) model.world.terrain = carveRivers(terrain, model.world.meta, rivers);
                statusMessage = rivers.length ? `Traced ${rivers.length} rivers to the sea.` : "No catchment was large enough for a river; try more land or more relief.";
            },
        });
    });

    W.spacer(main, 10);

    // 4. Settlements
    W.card(main, { id: "card_proc_towns", fill: UI.card, padding: 12 }, (card) => {
        W.label(card, { text: "4. Settlements & Roads", bold: true, fontSize: 13, color: UI.text });
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
        W.label(card, { text: "5. Wilderness Points of Interest", bold: true, fontSize: 13, color: UI.text });
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
            W.split(
                tabId,
                {
                    id: "planner_body_" + model.activeTab,
                    sideOpen: false,
                    sideWidth: 0,
                    reserveBottom: 26,
                    minHeight: 650,
                    mainPadding: ownScroll ? 0 : 16,
                    // The procedural and agent pages are taller than the window; they scroll here.
                    scrollMain: !ownScroll,
                } as SplitConfig,
                (main: string) => {
                    if (model.activeTab === "map") renderMapView(main);
                    else if (model.activeTab === "codex") renderCodexView(main);
                    else if (model.activeTab === "story") renderStoryView(main);
                    else if (model.activeTab === "procedural") renderProceduralView(main);
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
                world: { ...model.world, terrain: undefined },
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
            canUndo: model.canUndo,
            counts: { spots: model.world.spots.length, paths: model.world.paths.length, regions: model.world.regions.length, codex: model.world.codex.length, missions: model.world.missions.length, intents: model.intents.length, pendingProposals: model.pendingProposals.length },
            spots: model.world.spots.map((s) => ({ id: s.id, name: s.name, spotType: s.spotType, x: s.x, y: s.y, elevation: s.elevation })),
            paths: model.world.paths.map((p) => ({ id: p.id, name: p.name, pathType: p.pathType, points: p.points.length })),
            regions: model.world.regions.map((r) => ({ id: r.id, name: r.name, points: r.points.length })),
            status: statusMessage,
        })
    );
});
