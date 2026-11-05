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
    applyRevisionProposal,
    createSampleAgentProposal,
    exportMapToSvg,
    exportWorldBibleJson,
    generateAgentPrompts,
    generateGameDesignDoc,
} from "./agent_pipeline";
import {
    CRIMSON_EXPANSE_PRESET,
    NEO_AETHELGARD_PRESET,
    SHATTERED_ISLES_PRESET,
} from "./presets";
import type {
    BiomeType,
    CodexCategory,
    GameWorld,
    Mission,
    PathType,
    RegionType,
    RevisionProposal,
    SpotType,
    TerrainStyle,
    TravelEstimate,
    WorldPath,
    WorldRegion,
    WorldSpot,
} from "./planner_types";
import type { GameMapConfig, IconName, SplitConfig } from "../../addon";

// Register Addon
const addon = Entropy.Addon.register({
    name: "game-world-planner",
    version: "1.2.0",
    description: "Game World Planner: orthographic topological map editor, time-to-travel calculator, procedural terrain tools, codex, story organizer, and AI agent revision pipeline.",
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

const SPOT_TYPES: SpotType[] = ["capital", "city", "town", "village", "fortress", "dungeon", "ruin", "port", "shrine", "camp", "mine", "boss", "landmark"];
const PATH_TYPES: PathType[] = ["highway", "road", "trail", "river", "bridge"];
const BIOMES: BiomeType[] = ["plains", "forest", "jungle", "desert", "tundra", "volcanic", "swamp", "alpine", "coastal", "savanna", "taiga", "badlands"];
const TERRAIN_STYLES: Array<{ id: TerrainStyle; label: string }> = [
    { id: "relief", label: "Relief" },
    { id: "heatmap", label: "Heatmap" },
    { id: "slope", label: "Slope" },
    { id: "flat", label: "Flat" },
];

const SPOT_COLORS: Record<SpotType, RGBA> = {
    capital: [0.98, 0.75, 0.14, 1],
    city: [0.95, 0.62, 0.25, 1],
    town: [0.35, 0.8, 0.5, 1],
    village: [0.45, 0.75, 0.4, 1],
    fortress: [0.6, 0.65, 0.75, 1],
    dungeon: [0.95, 0.25, 0.35, 1],
    ruin: [0.65, 0.5, 0.85, 1],
    port: [0.22, 0.74, 0.97, 1],
    shrine: [0.7, 0.45, 0.95, 1],
    camp: [0.85, 0.5, 0.2, 1],
    mine: [0.8, 0.5, 0.3, 1],
    boss: [0.9, 0.15, 0.25, 1],
    landmark: [0.9, 0.9, 0.95, 1],
};

const PATH_DEFAULTS: Record<PathType, { color: RGBA; width: number; surfaceQuality: number; flowSpeed: number; isMajor: boolean }> = {
    highway: { color: [0.98, 0.75, 0.14, 1], width: 5, surfaceQuality: 0.8, flowSpeed: 0, isMajor: true },
    road: { color: [0.85, 0.75, 0.55, 1], width: 3.5, surfaceQuality: 1.0, flowSpeed: 0, isMajor: false },
    trail: { color: [0.65, 0.55, 0.4, 1], width: 2, surfaceQuality: 1.35, flowSpeed: 0, isMajor: false },
    river: { color: [0.22, 0.6, 0.92, 1], width: 4.5, surfaceQuality: 1.0, flowSpeed: 1.5, isMajor: true },
    bridge: { color: [0.8, 0.85, 0.9, 1], width: 3.5, surfaceQuality: 0.9, flowSpeed: 0, isMajor: false },
};

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
let activeProposal: RevisionProposal | null = null;
let placeSpotType: SpotType = "town";

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
    activeProposal = null;
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
    const id = model.selectedId;
    if (!id) return;
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
    };
    statusMessage = names[tool];
}

function finishDrawing(): boolean {
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
    if (model.pendingPathPoints.length || model.pendingRegionPoints.length) {
        model.cancelPendingPath();
        model.cancelPendingRegion();
        statusMessage = "Drawing cancelled.";
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
                    { id: "agent", label: icon("robot", "Agent Bible & Diff") },
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
            const counts = `${model.world.spots.length} Spots | ${model.world.paths.length} Paths | ${model.world.regions.length} Regions | ${model.world.codex.length} Codex | ${model.world.missions.length} Quests`;
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
        undefined
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
        const isMajor = placeSpotType === "capital" || placeSpotType === "city" || placeSpotType === "fortress" || placeSpotType === "port";
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
    } else if (model.activeTool === "select") {
        model.selectedId = null;
    }
}

function renderMapCanvasAndToolbar(canvasArea: string): void {
    renderMapToolbar(canvasArea);

    const pending = model.activeTool === "draw_path" ? model.pendingPathPoints : model.activeTool === "draw_region" ? model.pendingRegionPoints : [];
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
        pendingMode: model.activeTool === "draw_path" ? "path" : model.activeTool === "draw_region" ? "region" : undefined,
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
            const path = model.world.paths.find((p) => p.id === id);
            if (path) statusMessage = `Selected ${path.pathType} "${path.name}".`;
        },
        onRegionSelect: (id: string) => {
            model.selectedId = id;
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
    const spot = selId ? model.world.spots.find((s) => s.id === selId) : undefined;
    const path = selId ? model.world.paths.find((p) => p.id === selId) : undefined;
    const region = selId ? model.world.regions.find((r) => r.id === selId) : undefined;
    if (spot) return renderSpotInspector(panel, spot);
    if (path) return renderPathInspector(panel, path);
    if (region) return renderRegionInspector(panel, region);

    W.label(panel, { text: "No map element selected.", color: UI.dim, fontSize: 12 });
    W.spacer(panel, 6);
    W.label(panel, {
        text: "Click a spot, path or region to edit it. Tools: V select, H pan, P spot, L path, G region, M measure. Space-drag or right-drag pans, the wheel zooms, F fits the world, Esc cancels, Delete removes the selection.",
        wrap: true,
        color: UI.dim,
        fontSize: 11,
    });
    W.spacer(panel, 12);

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
    W.label(main, { text: "AI Agent Collaboration & Revision Pipeline", bold: true, fontSize: 16, color: UI.cyan });
    W.label(main, {
        text: "Export World Bibles, vector SVG maps, GDD documentation, and review proposed AI cartographer revisions before committing.",
        color: UI.dim,
        fontSize: 12,
    });
    W.separator(main);

    W.horizontal(main, () => {
        W.button(main, { id: "btn_copy_bible_json", text: icon("clipboard-text", "Copy World Bible (JSON)"), accent: UI.emerald, onClick: () => copyText(exportWorldBibleJson(model.world), "the World Bible JSON") });
        W.button(main, { id: "btn_copy_gdd_md", text: icon("file-text", "Copy Game Design Doc (Markdown)"), accent: UI.cyan, onClick: () => copyText(generateGameDesignDoc(model.world), "the Game Design Document") });
        W.button(main, { id: "btn_export_svg_map", text: icon("file-svg", "Copy Vector SVG Map"), accent: UI.amber, onClick: () => copyText(exportMapToSvg(model.world, 1400, 1400), "the SVG map") });
        W.button(main, {
            id: "btn_simulate_agent_proposal",
            text: icon("robot", "Simulate Agent Proposal"),
            onClick: () => {
                activeProposal = createSampleAgentProposal(model.world);
                statusMessage = `Agent "${activeProposal.agentName}" submitted ${activeProposal.changes.length} proposed world revisions.`;
            },
        });
    });

    W.spacer(main, 12);

    if (activeProposal) {
        const proposal = activeProposal;
        const accepted = proposal.changes.filter((c) => c.status === "accepted");
        W.card(main, { id: "card_revision_proposal", fill: UI.card, padding: 14 }, (card) => {
            W.horizontal(card, () => {
                W.label(card, { text: `Revision Proposal: ${proposal.agentName}`, bold: true, fontSize: 13, color: UI.amber });
                W.spacer(card, 12);
                W.button(card, {
                    id: "btn_apply_accepted_changes",
                    text: icon("check", `Apply Accepted (${accepted.length})`),
                    accent: accepted.length ? UI.emerald : undefined,
                    onClick: () => {
                        if (!accepted.length) {
                            statusMessage = "Accept at least one change first, or use Apply All.";
                            return;
                        }
                        model.snapshot();
                        const res = applyRevisionProposal(model.world, proposal, accepted.map((c) => c.id));
                        statusMessage = `Committed ${res.appliedCount} accepted changes to the world.`;
                        activeProposal = null;
                    },
                });
                W.button(card, {
                    id: "btn_apply_all_changes",
                    text: icon("check", "Apply All"),
                    onClick: () => {
                        model.snapshot();
                        const res = applyRevisionProposal(model.world, proposal, proposal.changes.filter((c) => c.status !== "rejected").map((c) => c.id));
                        statusMessage = `Committed ${res.appliedCount} changes to the world (rejected ones skipped).`;
                        activeProposal = null;
                    },
                });
                W.button(card, {
                    id: "btn_dismiss_proposal",
                    text: icon("x", "Dismiss"),
                    onClick: () => {
                        activeProposal = null;
                    },
                });
            });

            W.label(card, { text: `Motivation: ${proposal.motivation}`, color: UI.dim, fontSize: 11, wrap: true });
            W.separator(card);

            proposal.changes.forEach((c) => {
                W.horizontal(card, () => {
                    W.label(card, { text: `[${c.changeType.toUpperCase()}] ${c.title}`, bold: true, fontSize: 12, color: UI.text });
                    W.spacer(card, 8);
                    W.label(card, { text: c.status.toUpperCase(), color: c.status === "accepted" ? UI.emerald : c.status === "rejected" ? UI.rose : UI.amber, fontSize: 10 });
                });
                W.label(card, { text: c.summary, color: UI.dim, fontSize: 11, wrap: true });
                W.horizontal(card, () => {
                    W.button(card, { id: `btn_accept_${c.id}`, text: "Accept", accent: c.status === "accepted" ? UI.emerald : undefined, onClick: () => { c.status = "accepted"; } });
                    W.button(card, { id: `btn_reject_${c.id}`, text: "Reject", accent: c.status === "rejected" ? UI.rose : undefined, onClick: () => { c.status = "rejected"; } });
                });
                W.spacer(card, 6);
            });
        });
    }

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
            name: "game_planner_propose_revision",
            description: "Submits an AI Agent revision proposal to the Game World Planner for user review.",
            parameters: {
                type: "object",
                properties: {
                    agentName: { type: "string" },
                    motivation: { type: "string" },
                    changes: { type: "array", items: { type: "object" } },
                },
                required: ["agentName", "motivation", "changes"],
            },
        },
        (args: any) => {
            activeProposal = {
                id: `proposal_${Date.now()}`,
                agentName: String(args.agentName),
                timestamp: Date.now(),
                motivation: String(args.motivation),
                changes: (Array.isArray(args.changes) ? args.changes : []).map((c: any, i: number) => ({ id: c.id || `change_${i + 1}`, status: "pending", ...c })),
            };
            statusMessage = `Received revision proposal from ${activeProposal.agentName}`;
            return { success: true, proposalId: activeProposal.id };
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
            travel: lastTravelEstimate ? { distanceKm: lastTravelEstimate.directDistanceKm, effortKm: lastTravelEstimate.distanceKm, climbM: lastTravelEstimate.climbM, summary: lastTravelEstimate.summaryText } : null,
            terrainStyle: model.terrainStyle,
            canUndo: model.canUndo,
            counts: { spots: model.world.spots.length, paths: model.world.paths.length, regions: model.world.regions.length, codex: model.world.codex.length, missions: model.world.missions.length },
            spots: model.world.spots.map((s) => ({ id: s.id, name: s.name, spotType: s.spotType, x: s.x, y: s.y, elevation: s.elevation })),
            paths: model.world.paths.map((p) => ({ id: p.id, name: p.name, pathType: p.pathType, points: p.points.length })),
            regions: model.world.regions.map((r) => ({ id: r.id, name: r.name, points: r.points.length })),
            status: statusMessage,
        })
    );
});
