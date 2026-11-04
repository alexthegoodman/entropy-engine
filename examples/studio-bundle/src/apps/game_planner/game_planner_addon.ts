/// <reference path="../../addon.d.ts" />

import { PlannerModel } from "./planner_model";
import {
    calculateRouteTravelTime,
    calculateTravelTime,
} from "./travel_calculator";
import {
    extractContoursFromGrid,
    generateHeightfield,
    generateRivers,
    generateSettlements,
    scatterPointsOfInterest,
    simulateErosion,
} from "./procedural_tools";
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
    TravelEstimate,
    WorldPath,
    WorldRegion,
    WorldSpot,
} from "./planner_types";
import type { GameMapConfig, IconName, SplitConfig } from "../../addon";

// Register Addon
const addon = Entropy.Addon.register({
    name: "game-world-planner",
    version: "1.1.0",
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

// Global Model State
let model = new PlannerModel();
let statusMessage = "Welcome to Game World Planner. Draw your map or load a preset.";
let codexCategoryFilter: CodexCategory | "all" = "all";
let codexSearchQuery = "";
let codexStyleFilter = "Dark Fantasy";
let questViewMode: "chronological" | "freeform" = "chronological";
let lastTravelEstimate: TravelEstimate | null = null;
let activeProposal: RevisionProposal | null = null;

// Procedural Parameters State
let procSeed = 48201;
let procMountainScale = 2800;
let procErosionIters = 200;
let procRiverCount = 3;
let procScatterCount = 4;
let procIslandMask = true;

// --- Persistence ---

function saveWorld(): void {
    try {
        addon.IO.save(model.world, { pretty: true });
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
            model = new PlannerModel(loaded);
            statusMessage = `Loaded "${model.world.meta.name}" (${model.world.spots.length} spots, ${model.world.paths.length} paths).`;
        } else {
            model = new PlannerModel(SHATTERED_ISLES_PRESET);
            saveWorld();
        }
    } catch (e) {
        Entropy.println(`Game World Planner: using preset due to load error: ${e}`);
        model = new PlannerModel(SHATTERED_ISLES_PRESET);
    }
}

// --- Header Navigation & Global Actions ---

function renderHeader(tabId: string): void {
    W.bar(
        tabId,
        { id: "planner_header", height: 50, fill: UI.header, border: UI.line, paddingX: 12 },
        // Left zone: Logo, Title, and Tab Navigation
        (left: string) => {
            W.horizontal(left, () => {
                W.label(left, { text: icon("map-trifold", "World Planner"), bold: true, fontSize: 14, color: UI.emerald });
                W.spacer(left, 12);

                const tabs: Array<{ id: typeof model.activeTab; label: string }> = [
                    { id: "map", label: "🗺 Map View" },
                    { id: "codex", label: "📖 Codex" },
                    { id: "story", label: "⚔ Story & Quests" },
                    { id: "procedural", label: "⚡ Procedural Tools" },
                    { id: "agent", label: "🤖 Agent Bible & Diff" },
                ];

                tabs.forEach((t) => {
                    const isSelected = model.activeTab === t.id;
                    W.button(left, {
                        id: `nav_tab_${t.id}`,
                        text: t.label,
                        accent: isSelected ? UI.emerald : undefined,
                        onClick: () => {
                            model.activeTab = t.id;
                        },
                    });
                });
            });
        },
        // Center zone: Workflow Mode (Blocking vs Detailing) & Grid Snap
        (center: string) => {
            W.horizontal(center, () => {
                const blocking = model.world.meta.blockingMode;
                W.button(center, {
                    id: "btn_toggle_blocking",
                    text: blocking ? "Mode: [ BLOCKING ]" : "Mode: [ DETAILING ]",
                    accent: blocking ? UI.amber : UI.emerald,
                    onClick: () => {
                        model.setBlockingMode(!blocking);
                        statusMessage = blocking ? "Switched to Detailing mode (full micro-scatter visible)." : "Switched to Blocking mode (macro-structure only).";
                    },
                });

                W.spacer(center, 8);

                const snaps = [0, 50, 100, 250, 500, 1000];
                const snapLabels = ["Snap: Off", "Snap: 50m", "Snap: 100m", "Snap: 250m", "Snap: 500m", "Snap: 1km"];
                const currentSnapIdx = Math.max(0, snaps.indexOf(model.world.meta.gridSnapM));

                W.dropdown(center, {
                    id: "dropdown_grid_snap",
                    label: "Snap",
                    options: snapLabels,
                    selectedIndex: currentSnapIdx,
                    onChange: (v: string) => {
                        const idx = Number(v);
                        model.setGridSnap(snaps[idx] || 0);
                    },
                });
            });
        },
        // Right zone: Undo, Redo, Save, Presets
        (right: string) => {
            W.horizontal(right, () => {
                W.button(right, {
                    id: "btn_undo",
                    text: "↶ Undo",
                    onClick: () => {
                        if (model.undo()) statusMessage = "Undo action performed.";
                    },
                });

                W.button(right, {
                    id: "btn_redo",
                    text: "↷ Redo",
                    onClick: () => {
                        if (model.redo()) statusMessage = "Redo action performed.";
                    },
                });

                W.spacer(right, 8);

                W.button(right, {
                    id: "btn_save",
                    text: "💾 Save",
                    accent: model.isDirty ? UI.amber : undefined,
                    onClick: () => saveWorld(),
                });

                const presetOptions = [
                    "Preset: Shattered Isles (Fantasy)",
                    "Preset: Neo-Aethelgard (Cyberpunk)",
                    "Preset: Crimson Expanse (Sci-Fi)",
                ];
                let currentPresetIdx = 0;
                if (model.world.meta.id === "world_neo_aethelgard" || model.world.meta.genre === "cyberpunk") {
                    currentPresetIdx = 1;
                } else if (model.world.meta.id === "world_crimson_expanse" || model.world.meta.genre === "scifi") {
                    currentPresetIdx = 2;
                }

                W.dropdown(right, {
                    id: "dropdown_presets",
                    label: "World Presets",
                    options: presetOptions,
                    selectedIndex: currentPresetIdx,
                    onChange: (v: string) => {
                        const idx = Number(v);
                        const chosen = idx === 0 ? SHATTERED_ISLES_PRESET : idx === 1 ? NEO_AETHELGARD_PRESET : CRIMSON_EXPANSE_PRESET;
                        model = new PlannerModel(chosen);
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
            sideWidth: 330,
            minHeight: 650,
            mainPadding: 0,
            sidePadding: 12,
            scrollMain: false,
            scrollSide: true,
        } as SplitConfig,
        // Main: Interactive Map Canvas + Floating Toolbar
        (canvasArea: string) => {
            renderMapCanvasAndToolbar(canvasArea);
        },
        // Side: Properties Inspector
        (inspectorArea: string) => {
            renderInspector(inspectorArea);
        }
    );
}

function renderMapCanvasAndToolbar(canvasArea: string): void {
    // Toolbar strip above canvas
    W.bar(
        canvasArea,
        { id: "map_toolbar", height: 38, fill: UI.nav, border: UI.line, paddingX: 10 },
        // Left zone: Active Map Tools
        (left: string) => {
            W.horizontal(left, () => {
                const tools: Array<{ id: typeof model.activeTool; label: string }> = [
                    { id: "select", label: "↖ Select" },
                    { id: "pan", label: "✋ Pan" },
                    { id: "place_spot", label: "📍 Add Spot" },
                    { id: "draw_path", label: "〰 Draw Path" },
                    { id: "draw_region", label: "⬡ Draw Region" },
                    { id: "measure", label: "📏 Measure" },
                ];

                tools.forEach((t) => {
                    W.button(left, {
                        id: `tool_${t.id}`,
                        text: t.label,
                        accent: model.activeTool === t.id ? UI.cyan : undefined,
                        onClick: () => {
                            model.activeTool = t.id;
                            if (t.id === "measure") {
                                model.clearMeasurement();
                                lastTravelEstimate = null;
                            }
                            statusMessage = `Tool selected: ${t.label}`;
                        },
                    });
                });
            });
        },
        // Center zone: Active Drawing Controls & Status
        (center: string) => {
            if (model.activeTool === "draw_path" && model.pendingPathPoints.length > 0) {
                W.horizontal(center, () => {
                    W.label(center, { text: `Points: ${model.pendingPathPoints.length}`, fontSize: 11, color: UI.cyan, bold: true });
                    W.button(center, {
                        id: "btn_finish_path",
                        text: "✓ Complete Path",
                        accent: UI.emerald,
                        onClick: () => {
                            const newPath = model.finishPendingPath("road");
                            if (newPath) statusMessage = `Path "${newPath.name}" created with ${newPath.points.length} waypoints.`;
                        },
                    });
                    W.button(center, {
                        id: "btn_undo_path_pt",
                        text: "↶ Undo Point",
                        onClick: () => model.undoPendingPathPoint(),
                    });
                    W.button(center, {
                        id: "btn_cancel_path",
                        text: "Cancel",
                        onClick: () => model.cancelPendingPath(),
                    });
                });
            } else if (model.activeTool === "draw_region" && model.pendingRegionPoints.length > 0) {
                W.horizontal(center, () => {
                    W.label(center, { text: `Vertices: ${model.pendingRegionPoints.length}`, fontSize: 11, color: UI.emerald, bold: true });
                    W.button(center, {
                        id: "btn_finish_region",
                        text: "✓ Complete Region",
                        accent: UI.emerald,
                        onClick: () => {
                            const newRegion = model.finishPendingRegion("plains");
                            if (newRegion) statusMessage = `Region "${newRegion.name}" created with ${newRegion.points.length} vertices.`;
                        },
                    });
                    W.button(center, {
                        id: "btn_undo_region_pt",
                        text: "↶ Undo Point",
                        onClick: () => model.undoPendingRegionPoint(),
                    });
                    W.button(center, {
                        id: "btn_cancel_region",
                        text: "Cancel",
                        onClick: () => model.cancelPendingRegion(),
                    });
                });
            } else if (model.activeTool === "measure" && (model.measurePoints.p1 || lastTravelEstimate)) {
                W.horizontal(center, () => {
                    if (lastTravelEstimate) {
                        W.label(center, { text: `📏 ${lastTravelEstimate.distanceKm} km | ${lastTravelEstimate.summaryText}`, fontSize: 11, color: UI.amber });
                    }
                    W.button(center, {
                        id: "btn_clear_measure",
                        text: "Clear Ruler",
                        onClick: () => {
                            model.clearMeasurement();
                            lastTravelEstimate = null;
                            statusMessage = "Ruler cleared.";
                        },
                    });
                });
            }
        },
        // Right zone: Layer Display Toggles
        (right: string) => {
            W.horizontal(right, () => {
                W.button(right, {
                    id: "btn_toggle_minimap",
                    text: model.showMinimap ? "Radar: ON" : "Radar: OFF",
                    accent: model.showMinimap ? UI.cyan : undefined,
                    onClick: () => {
                        model.showMinimap = !model.showMinimap;
                    },
                });
                W.button(right, {
                    id: "btn_toggle_contours",
                    text: model.showContours ? "Contours: ON" : "Contours: OFF",
                    accent: model.showContours ? UI.emerald : undefined,
                    onClick: () => {
                        model.showContours = !model.showContours;
                    },
                });
                W.button(right, {
                    id: "btn_toggle_biomes",
                    text: model.showBiomes ? "Biomes: ON" : "Biomes: OFF",
                    accent: model.showBiomes ? UI.emerald : undefined,
                    onClick: () => {
                        model.showBiomes = !model.showBiomes;
                    },
                });
            });
        }
    );

    // Interactive GameMap Native Widget
    const currentPendingPoints = model.activeTool === "draw_path" && model.pendingPathPoints.length > 0
        ? model.pendingPathPoints
        : model.activeTool === "draw_region" && model.pendingRegionPoints.length > 0
        ? model.pendingRegionPoints
        : undefined;

    const currentPendingMode = model.activeTool === "draw_path"
        ? "path"
        : model.activeTool === "draw_region"
        ? "region"
        : undefined;

    const mapConfig: GameMapConfig = {
        id: "game_world_map",
        worldWidthKm: model.world.meta.worldWidthKm,
        worldHeightKm: model.world.meta.worldHeightKm,
        gridSnapM: model.world.meta.gridSnapM,
        showGrid: model.showGrid,
        showContours: model.showContours,
        showBiomes: model.showBiomes,
        showMinimap: model.showMinimap,
        blockingMode: model.world.meta.blockingMode,
        activeTool: model.activeTool,
        selectedId: model.selectedId || undefined,
        pendingPoints: currentPendingPoints,
        pendingMode: currentPendingMode,
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
        elevationBands: model.world.contours.map((c) => ({
            elevation: c.elevation,
            points: c.points,
            color: c.color,
        })),
        measure: lastTravelEstimate && model.measurePoints.p1 && model.measurePoints.p2
            ? {
                active: true,
                p1: model.measurePoints.p1,
                p2: model.measurePoints.p2,
                distanceKm: lastTravelEstimate.distanceKm,
                travelInfo: lastTravelEstimate.summaryText,
            }
            : undefined,
        onSpotSelect: (id: string) => {
            model.selectedId = id;
            const spot = model.world.spots.find((s) => s.id === id);
            if (spot) {
                statusMessage = `Selected Spot: ${spot.name} (${spot.spotType})`;
            }
        },
        onSpotMove: (id: string, x: number, y: number) => {
            model.moveSpot(id, x, y);
        },
        onPathSelect: (id: string) => {
            model.selectedId = id;
            const path = model.world.paths.find((p) => p.id === id);
            if (path) statusMessage = `Selected Path: ${path.name} (${path.pathType})`;
        },
        onRegionSelect: (id: string) => {
            model.selectedId = id;
            const region = model.world.regions.find((r) => r.id === id);
            if (region) statusMessage = `Selected Region: ${region.name} (${region.dominantBiome})`;
        },
        onMapClick: (x: number, y: number) => {
            const sx = model.snapCoordinate(x);
            const sy = model.snapCoordinate(y);

            if (model.activeTool === "place_spot") {
                const newSpot = model.addSpot({
                    name: `New Location ${model.world.spots.length + 1}`,
                    spotType: "town",
                    x: sx,
                    y: sy,
                    elevation: 120,
                    color: [0.35, 0.8, 0.5, 1.0],
                    icon: "house",
                    tags: ["new"],
                    isMajor: false,
                    description: "A newly marked location awaiting exploration.",
                    loreNotes: "",
                    linkedCodexIds: [],
                    linkedMissionIds: [],
                });
                statusMessage = `Placed "${newSpot.name}" at [${sx}, ${sy}] km.`;
            } else if (model.activeTool === "draw_path") {
                model.appendPendingPathPoint([sx, sy]);
                statusMessage = `Added path point #${model.pendingPathPoints.length} at [${sx}, ${sy}] km.`;
            } else if (model.activeTool === "draw_region") {
                model.appendPendingRegionPoint([sx, sy]);
                statusMessage = `Added region vertex #${model.pendingRegionPoints.length} at [${sx}, ${sy}] km.`;
            } else if (model.activeTool === "measure") {
                if (!model.measurePoints.p1) {
                    model.measurePoints.p1 = [sx, sy];
                    statusMessage = `Measurement origin anchored at [${sx}, ${sy}] km. Click destination.`;
                } else {
                    model.measurePoints.p2 = [sx, sy];
                    lastTravelEstimate = calculateTravelTime(
                        model.measurePoints.p1,
                        model.measurePoints.p2,
                        model.world.paths,
                        model.world.regions
                    );
                    statusMessage = `Distance: ${lastTravelEstimate.distanceKm} km. ${lastTravelEstimate.summaryText}`;
                }
            } else if (model.activeTool === "select") {
                model.selectedId = null;
            }
        },
        onMapDoubleClick: (_x: number, _y: number) => {
            if (model.activeTool === "draw_path" && model.pendingPathPoints.length >= 2) {
                const p = model.finishPendingPath("road");
                if (p) statusMessage = `Completed path "${p.name}".`;
            } else if (model.activeTool === "draw_region" && model.pendingRegionPoints.length >= 3) {
                const r = model.finishPendingRegion("plains");
                if (r) statusMessage = `Completed region "${r.name}".`;
            }
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
    if (!selId) {
        W.label(panel, { text: "No element selected.", color: UI.dim, fontSize: 12 });
        W.spacer(panel, 6);
        W.label(panel, {
            text: "Click on any Spot, Path, or Region on the map to inspect and edit its details. Use the tools above to place new elements.",
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
            W.label(card, { text: `Total Spots: ${model.world.spots.length}`, fontSize: 11, color: UI.dim });
            W.label(card, { text: `Total Paths: ${model.world.paths.length}`, fontSize: 11, color: UI.dim });
            W.label(card, { text: `Total Regions: ${model.world.regions.length}`, fontSize: 11, color: UI.dim });
        });
        return;
    }

    // Check Spot
    const spot = model.world.spots.find((s) => s.id === selId);
    if (spot) {
        renderSpotInspector(panel, spot);
        return;
    }

    // Check Path
    const path = model.world.paths.find((p) => p.id === selId);
    if (path) {
        renderPathInspector(panel, path);
        return;
    }

    // Check Region
    const region = model.world.regions.find((r) => r.id === selId);
    if (region) {
        renderRegionInspector(panel, region);
        return;
    }

    W.label(panel, { text: "Selection not found.", color: UI.dim });
}

function renderSpotInspector(panel: string, spot: WorldSpot): void {
    W.label(panel, { text: `📍 Location: ${spot.name}`, bold: true, fontSize: 13, color: UI.emerald });

    W.textInput(panel, {
        id: "edit_spot_name",
        label: "Name:",
        value: spot.name,
        onChange: (v) => model.updateSpot(spot.id, { name: v }),
    });

    const spotTypes: SpotType[] = [
        "capital", "city", "town", "village", "fortress", "dungeon",
        "ruin", "port", "shrine", "camp", "mine", "boss", "landmark"
    ];
    W.dropdown(panel, {
        id: "edit_spot_type",
        label: "Spot Type",
        options: spotTypes.map((t) => t.toUpperCase()),
        selectedIndex: Math.max(0, spotTypes.indexOf(spot.spotType)),
        onChange: (v: string) => {
            const idx = Number(v);
            if (spotTypes[idx]) {
                model.updateSpot(spot.id, { spotType: spotTypes[idx] });
            }
        },
    });

    W.horizontal(panel, () => {
        W.numericInput(panel, {
            id: "edit_spot_x",
            label: "X (km):",
            value: spot.x,
            onChange: (v) => model.updateSpot(spot.id, { x: parseFloat(v) || 0 }),
        });
        W.numericInput(panel, {
            id: "edit_spot_y",
            label: "Y (km):",
            value: spot.y,
            onChange: (v) => model.updateSpot(spot.id, { y: parseFloat(v) || 0 }),
        });
    });

    W.numericInput(panel, {
        id: "edit_spot_elevation",
        label: "Elevation (meters):",
        value: spot.elevation,
        onChange: (v) => model.updateSpot(spot.id, { elevation: parseFloat(v) || 0 }),
    });

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
        label: "Major Hub (Visible in Macro-Blocking Mode)",
        value: spot.isMajor,
        onChange: (v) => model.updateSpot(spot.id, { isMajor: v }),
    });

    W.textInput(panel, {
        id: "edit_spot_tags",
        label: "Tags (comma separated):",
        value: spot.tags.join(", "),
        onChange: (v) => model.updateSpot(spot.id, { tags: v.split(",").map((s) => s.trim()).filter(Boolean) }),
    });

    W.textInput(panel, {
        id: "edit_spot_desc",
        label: "Description:",
        value: spot.description,
        multiline: true,
        onChange: (v) => model.updateSpot(spot.id, { description: v }),
    });

    W.textInput(panel, {
        id: "edit_spot_lore",
        label: "Lore Notes:",
        value: spot.loreNotes,
        multiline: true,
        onChange: (v) => model.updateSpot(spot.id, { loreNotes: v }),
    });

    W.separator(panel);
    W.label(panel, { text: "AI Concept Art Prompt:", bold: true, fontSize: 11, color: UI.cyan });
    W.textInput(panel, {
        id: "edit_spot_prompt",
        value: spot.conceptPrompt || "",
        multiline: true,
        onChange: (v) => model.updateSpot(spot.id, { conceptPrompt: v }),
    });

    W.button(panel, {
        id: "btn_gen_spot_prompt",
        text: "⚡ Auto-Generate Image Prompt",
        onClick: () => {
            const prompt = `Cinematic concept art of ${spot.name}, ${spot.spotType} at altitude ${spot.elevation}m. ${spot.description}. ${model.world.meta.genre} atmosphere, volumetric sunlight, 8k resolution`;
            model.updateSpot(spot.id, { conceptPrompt: prompt });
        },
    });

    W.spacer(panel, 8);

    // Actions Row
    W.horizontal(panel, () => {
        W.button(panel, {
            id: "btn_duplicate_spot",
            text: "📑 Duplicate",
            onClick: () => {
                const copy = model.duplicateSpot(spot.id);
                if (copy) statusMessage = `Duplicated spot to "${copy.name}".`;
            },
        });

        W.button(panel, {
            id: "btn_measure_from_spot",
            text: "📏 Anchor Ruler",
            onClick: () => {
                model.measurePoints.p1 = [spot.x, spot.y];
                model.activeTool = "measure";
                statusMessage = `Ruler anchored at ${spot.name} [${spot.x}, ${spot.y}] km.`;
            },
        });
    });

    W.spacer(panel, 8);
    W.button(panel, {
        id: "btn_delete_spot",
        text: "🗑 Delete Location",
        accent: UI.rose,
        onClick: () => model.deleteSpot(spot.id),
    });
}

function renderPathInspector(panel: string, path: WorldPath): void {
    W.label(panel, { text: `〰 Path: ${path.name}`, bold: true, fontSize: 13, color: UI.amber });

    W.textInput(panel, {
        id: "edit_path_name",
        label: "Name:",
        value: path.name,
        onChange: (v) => model.updatePath(path.id, { name: v }),
    });

    const pathTypes: PathType[] = ["highway", "road", "trail", "river", "bridge"];
    W.dropdown(panel, {
        id: "edit_path_type",
        label: "Path Type",
        options: pathTypes.map((t) => t.toUpperCase()),
        selectedIndex: Math.max(0, pathTypes.indexOf(path.pathType)),
        onChange: (v: string) => {
            const idx = Number(v);
            if (pathTypes[idx]) {
                model.updatePath(path.id, { pathType: pathTypes[idx] });
            }
        },
    });

    W.slider(panel, {
        id: "edit_path_width",
        label: `Width (${path.width.toFixed(1)}m):`,
        value: path.width,
        min: 1.0,
        max: 12.0,
        onChange: (v) => model.updatePath(path.id, { width: parseFloat(v) || 1.0 }),
    });

    W.checkbox(panel, {
        id: "edit_path_major",
        label: "Major Highway / River (Blocking Mode)",
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
    }

    // Travel Metric for this Path
    const pathWaypoints = path.points.map(([x, y]) => ({ x, y }));
    const travelFoot = calculateRouteTravelTime(pathWaypoints, "foot", path.pathType);
    const travelHorse = calculateRouteTravelTime(pathWaypoints, "mount", path.pathType);

    W.card(panel, { id: "card_path_travel", fill: UI.card, padding: 8 }, (card) => {
        W.label(card, { text: "Route Travel Metrics", bold: true, fontSize: 11, color: UI.emerald });
        W.label(card, { text: `Total Distance: ${travelFoot.distanceKm} km (${path.points.length} waypoints)`, fontSize: 11, color: UI.text });
        W.label(card, { text: `Foot: ${travelFoot.formattedDuration} | Horse: ${travelHorse.formattedDuration}`, fontSize: 11, color: UI.dim });
    });

    W.spacer(panel, 8);
    W.horizontal(panel, () => {
        W.button(panel, {
            id: "btn_duplicate_path",
            text: "📑 Duplicate",
            onClick: () => {
                const copy = model.duplicatePath(path.id);
                if (copy) statusMessage = `Duplicated path to "${copy.name}".`;
            },
        });

        W.button(panel, {
            id: "btn_delete_path",
            text: "🗑 Delete",
            accent: UI.rose,
            onClick: () => model.deletePath(path.id),
        });
    });
}

function renderRegionInspector(panel: string, region: WorldRegion): void {
    W.label(panel, { text: `⬡ Region: ${region.name}`, bold: true, fontSize: 13, color: UI.cyan });

    W.textInput(panel, {
        id: "edit_region_name",
        label: "Name:",
        value: region.name,
        onChange: (v) => model.updateRegion(region.id, { name: v }),
    });

    const regionTypes: RegionType[] = ["kingdom", "province", "biome", "danger", "district"];
    W.dropdown(panel, {
        id: "edit_region_type",
        label: "Region Classification",
        options: regionTypes.map((t) => t.toUpperCase()),
        selectedIndex: Math.max(0, regionTypes.indexOf(region.regionType)),
        onChange: (v: string) => {
            const idx = Number(v);
            if (regionTypes[idx]) {
                model.updateRegion(region.id, { regionType: regionTypes[idx] });
            }
        },
    });

    const biomes: BiomeType[] = [
        "plains", "forest", "jungle", "desert", "tundra", "volcanic",
        "swamp", "alpine", "coastal", "savanna", "taiga", "badlands"
    ];
    W.dropdown(panel, {
        id: "edit_region_biome",
        label: "Dominant Biome",
        options: biomes.map((b) => b.toUpperCase()),
        selectedIndex: Math.max(0, biomes.indexOf(region.dominantBiome)),
        onChange: (v: string) => {
            const idx = Number(v);
            if (biomes[idx]) {
                model.updateRegion(region.id, { dominantBiome: biomes[idx] });
            }
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
        onChange: (v) => model.updateRegion(region.id, { description: v }),
    });

    W.label(panel, { text: `Vertices: ${region.points.length} boundary points`, color: UI.dim, fontSize: 11 });

    W.spacer(panel, 8);
    W.horizontal(panel, () => {
        W.button(panel, {
            id: "btn_duplicate_region",
            text: "📑 Duplicate",
            onClick: () => {
                const copy = model.duplicateRegion(region.id);
                if (copy) statusMessage = `Duplicated region to "${copy.name}".`;
            },
        });

        W.button(panel, {
            id: "btn_delete_region",
            text: "🗑 Delete",
            accent: UI.rose,
            onClick: () => model.deleteRegion(region.id),
        });
    });
}

// =================================================================================================
// TAB 2: CODEX (CHARACTERS, POWERS, WEAPONS, FACTIONS, LORE)
// =================================================================================================

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
        // Main: Selected Codex Detail Editor
        (editorArea: string) => {
            renderCodexDetail(editorArea);
        },
        // Side: Category Filter & Entries List
        (listArea: string) => {
            renderCodexList(listArea);
        }
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

    W.horizontal(side, () => {
        categories.slice(0, 3).forEach((c) => {
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
    W.horizontal(side, () => {
        categories.slice(3).forEach((c) => {
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

    W.separator(side);

    W.button(side, {
        id: "btn_add_codex",
        text: "+ New Codex Entry",
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

    entries.forEach((entry) => {
        const isSelected = model.selectedId === entry.id;
        const iconPrefix = entry.category === "character" ? "👤" : entry.category === "power" ? "⚡" : entry.category === "weapon" ? "⚔" : entry.category === "faction" ? "🛡" : "📜";

        W.button(side, {
            id: `codex_item_${entry.id}`,
            text: `${iconPrefix} ${entry.name}`,
            accent: isSelected ? UI.emerald : undefined,
            onClick: () => {
                model.selectedId = entry.id;
            },
        });
    });
}

function renderCodexDetail(main: string): void {
    const entry = model.world.codex.find((c) => c.id === model.selectedId);
    if (!entry) {
        W.label(main, { text: "Select or create a Codex entry from the left.", color: UI.dim, fontSize: 13 });
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
                    const newAttrs = { ...entry.attributes, [key]: v };
                    model.updateCodexEntry(entry.id, { attributes: newAttrs });
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
            const idx = Number(v);
            if (styles[idx]) codexStyleFilter = styles[idx];
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
            text: `⚡ Generate Prompt (${codexStyleFilter})`,
            accent: UI.cyan,
            onClick: () => {
                const base = generateConceptImagePrompt(entry.name, entry.category, entry.subtitle, entry.description, model.world.meta.genre);
                const styledPrompt = `${base}, rendered in ${codexStyleFilter} aesthetic, masterpiece composition, 8k`;
                model.updateCodexEntry(entry.id, { conceptImagePrompt: styledPrompt });
            },
        });

        W.button(main, {
            id: "btn_copy_prompt",
            text: "📋 Copy Prompt",
            onClick: () => {
                try {
                    Entropy.Clipboard?.writeText(entry.conceptImagePrompt);
                    statusMessage = "Prompt copied to clipboard.";
                } catch {
                    statusMessage = "Prompt ready in text field.";
                }
            },
        });
    });

    W.spacer(main, 16);
    W.horizontal(main, () => {
        W.button(main, {
            id: "btn_duplicate_codex",
            text: "📑 Duplicate Entry",
            onClick: () => {
                const copy = model.duplicateCodexEntry(entry.id);
                if (copy) statusMessage = `Duplicated codex entry "${copy.name}".`;
            },
        });

        W.button(main, {
            id: "btn_delete_codex",
            text: "🗑 Delete Entry",
            accent: UI.rose,
            onClick: () => model.deleteCodexEntry(entry.id),
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
                    text: "📖 Chronological Acts & Chapters",
                    accent: questViewMode === "chronological" ? UI.emerald : undefined,
                    onClick: () => {
                        questViewMode = "chronological";
                    },
                });
                W.button(left, {
                    id: "btn_mode_freeform",
                    text: "🕸 Freeform Quest Web (DAG)",
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
                W.label(right, { text: "✓ Dependency Graph: Valid (No Cycles)", color: UI.emerald, fontSize: 11 });
            } else {
                const cycleStr = validation.cycle ? validation.cycle.join(" -> ") : "Unknown";
                W.label(right, { text: `⚠ Cycle Detected in Quests: ${cycleStr}`, color: UI.rose, bold: true, fontSize: 11 });
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
        // Main: Mission Detail & Route Inspector
        (editorArea: string) => {
            renderMissionDetail(editorArea);
        },
        // Side: Quest List / Acts List
        (listArea: string) => {
            renderQuestList(listArea);
        }
    );
}

function renderQuestList(side: string): void {
    W.label(side, { text: "Quest Log", bold: true, fontSize: 13, color: UI.text });

    W.button(side, {
        id: "btn_add_mission",
        text: "+ New Mission",
        accent: UI.cyan,
        onClick: () => {
            const newM = createMission(
                `Quest: Expedition #${model.world.missions.length + 1}`,
                "Explore the frontier and report back to the capital.",
                "main"
            );
            newM.rewardXp = 1000;
            model.addMission(newM);
            statusMessage = `Created mission "${newM.title}".`;
        },
    });

    W.separator(side);

    if (questViewMode === "chronological") {
        const acts = getChronologicalActs(model.world.acts, model.world.missions);
        acts.forEach((actEntry) => {
            W.label(side, { text: `Act ${actEntry.act.actNumber}: ${actEntry.act.title}`, bold: true, fontSize: 11, color: UI.amber });
            actEntry.chapters.forEach((chapEntry) => {
                W.label(side, { text: `  Ch. ${chapEntry.chapter.chapterNumber}: ${chapEntry.chapter.title}`, color: UI.dim, fontSize: 10 });
                chapEntry.missions.forEach((m: Mission) => {
                    const isSelected = model.selectedId === m.id;
                    W.button(side, {
                        id: `mission_btn_${m.id}`,
                        text: `    ⚔ ${m.title}`,
                        accent: isSelected ? UI.emerald : undefined,
                        onClick: () => {
                            model.selectedId = m.id;
                        },
                    });
                });
            });
        });
    } else {
        // Freeform DAG view grouped by availability
        const available = computeAvailableMissions(model.world.missions, new Set<string>());
        W.label(side, { text: `Available Quests (${available.length}):`, bold: true, fontSize: 11, color: UI.emerald });
        available.forEach((m: Mission) => {
            const isSelected = model.selectedId === m.id;
            W.button(side, {
                id: `dag_avail_${m.id}`,
                text: `● ${m.title}`,
                accent: isSelected ? UI.emerald : undefined,
                onClick: () => {
                    model.selectedId = m.id;
                },
            });
        });

        const locked = model.world.missions.filter((m: Mission) => !available.some((a: Mission) => a.id === m.id));
        if (locked.length > 0) {
            W.spacer(side, 8);
            W.label(side, { text: `Locked Quests (${locked.length}):`, bold: true, fontSize: 11, color: UI.dim });
            locked.forEach((m: Mission) => {
                const isSelected = model.selectedId === m.id;
                W.button(side, {
                    id: `dag_locked_${m.id}`,
                    text: `🔒 ${m.title}`,
                    accent: isSelected ? UI.emerald : undefined,
                    onClick: () => {
                        model.selectedId = m.id;
                    },
                });
            });
        }
    }
}

function renderMissionDetail(main: string): void {
    const mission = model.world.missions.find((m) => m.id === model.selectedId);
    if (!mission) {
        W.label(main, { text: "Select a quest from the left panel to inspect.", color: UI.dim, fontSize: 13 });
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
    W.label(main, { text: "Geographic Quest Routing & Time-to-Travel", bold: true, fontSize: 12, color: UI.cyan });

    const spots = model.world.spots;
    const startSpot = spots.find((s) => s.id === mission.startSpotId);
    const objSpots = spots.filter((s) => mission.objectiveSpotIds.includes(s.id));
    const turnInSpot = spots.find((s) => s.id === mission.turnInSpotId) || startSpot;

    W.label(main, { text: startSpot ? `Quest Giver: 📍 ${startSpot.name} [${startSpot.x}, ${startSpot.y}] km` : "Quest Giver: None assigned", color: UI.text, fontSize: 11 });
    W.label(main, { text: `Objectives (${objSpots.length}): ${objSpots.map((s) => s.name).join(", ") || "None"}`, color: UI.dim, fontSize: 11 });
    W.label(main, { text: turnInSpot ? `Turn-in Location: 📍 ${turnInSpot.name}` : "Turn-in: Same as Quest Giver", color: UI.dim, fontSize: 11 });

    // Compute route distance if waypoints exist
    if (startSpot && objSpots.length > 0) {
        const routeWaypoints = [
            { x: startSpot.x, y: startSpot.y, elevation: startSpot.elevation },
            ...objSpots.map((s) => ({ x: s.x, y: s.y, elevation: s.elevation })),
            { x: turnInSpot!.x, y: turnInSpot!.y, elevation: turnInSpot!.elevation },
        ];
        const routeFoot = calculateRouteTravelTime(routeWaypoints, "foot");
        const routeHorse = calculateRouteTravelTime(routeWaypoints, "mount");

        W.card(main, { id: "card_mission_route", fill: UI.card, padding: 10 }, (card) => {
            W.label(card, { text: "Quest Journey Estimate", bold: true, fontSize: 11, color: UI.amber });
            W.label(card, { text: `Total Circuit Distance: ${routeFoot.distanceKm} km`, fontSize: 11, color: UI.text });
            W.label(card, { text: `Foot Travel: ${routeFoot.formattedDuration} | Mounted Travel: ${routeHorse.formattedDuration}`, fontSize: 11, color: UI.dim });
        });
    }

    W.spacer(main, 8);
    W.horizontal(main, () => {
        W.button(main, {
            id: "btn_link_selected_spot",
            text: "📍 Link Selected Spot as Objective",
            onClick: () => {
                if (model.selectedId && spots.some((s) => s.id === model.selectedId)) {
                    if (!mission.objectiveSpotIds.includes(model.selectedId)) {
                        mission.objectiveSpotIds.push(model.selectedId);
                        model.snapshot();
                        statusMessage = "Linked spot to quest objectives.";
                    }
                } else {
                    statusMessage = "Select a spot on the Map View first.";
                }
            },
        });

        W.button(main, {
            id: "btn_duplicate_mission",
            text: "📑 Duplicate Quest",
            onClick: () => {
                const copy = model.duplicateMission(mission.id);
                if (copy) statusMessage = `Duplicated quest "${copy.title}".`;
            },
        });
    });

    W.spacer(main, 12);
    W.button(main, {
        id: "btn_delete_mission",
        text: "🗑 Delete Quest",
        accent: UI.rose,
        onClick: () => model.deleteMission(mission.id),
    });
}

// =================================================================================================
// TAB 4: PROCEDURAL TOOLS (HEIGHTFIELD, EROSION, RIVERS, TOWNS, SCATTER)
// =================================================================================================

function renderProceduralView(main: string): void {
    W.label(main, { text: "Procedural World Generation Tools", bold: true, fontSize: 16, color: UI.emerald });
    W.label(main, {
        text: "Procedural terrain synthesis, hydraulic erosion modeling, river drainage routing, settlement placement, and wilderness scattering.",
        color: UI.dim,
        fontSize: 12,
    });
    W.separator(main);

    // Global Procedural Controls Card
    W.card(main, { id: "card_proc_globals", fill: UI.card, padding: 12 }, (card) => {
        W.label(card, { text: "Procedural World Parameters", bold: true, fontSize: 12, color: UI.cyan });
        W.horizontal(card, () => {
            W.numericInput(card, {
                id: "input_proc_seed",
                label: "Seed:",
                value: procSeed,
                onChange: (v) => {
                    procSeed = parseInt(v, 10) || 1337;
                    model.world.meta.seed = procSeed;
                },
            });
            W.numericInput(card, {
                id: "input_mountain_scale",
                label: "Max Mountain (meters):",
                value: procMountainScale,
                onChange: (v) => {
                    procMountainScale = parseInt(v, 10) || 2800;
                },
            });
        });
        W.checkbox(card, {
            id: "chk_island_mask",
            label: "Island Boundary Falloff (Surrounded by Ocean)",
            value: procIslandMask,
            onChange: (v) => {
                procIslandMask = v;
            },
        });
    });

    W.spacer(main, 10);

    // 1. Fractal Heightfield Generator
    W.card(main, { id: "card_proc_heightfield", fill: UI.card, padding: 12 }, (card) => {
        W.label(card, { text: "1. Fractal Heightfield & Topological Contours", bold: true, fontSize: 13, color: UI.text });
        W.label(card, { text: "Generates multi-octave Simplex/Perlin elevation contours with continental shelves and mountain ridges.", color: UI.dim, fontSize: 11 });

        W.button(card, {
            id: "btn_generate_heightmap",
            text: "⚡ Generate Terrain Heightfield & Contours",
            accent: UI.emerald,
            onClick: () => {
                const res = generateHeightfield({
                    widthKm: model.world.meta.worldWidthKm,
                    heightKm: model.world.meta.worldHeightKm,
                    resolution: 48,
                    seed: procSeed,
                    octaves: 5,
                    mountainScale: procMountainScale,
                    seaLevelM: model.world.meta.seaLevelM,
                    islandMask: procIslandMask,
                });
                model.snapshot();
                model.world.contours = res.contours;
                statusMessage = `Generated heightfield (${res.minElevationM}m to ${res.maxElevationM}m) with ${res.contours.length} contour bands.`;
            },
        });
    });

    W.spacer(main, 10);

    // 2. Hydraulic Erosion Simulation
    W.card(main, { id: "card_proc_erosion", fill: UI.card, padding: 12 }, (card) => {
        W.label(card, { text: "2. Hydraulic & Thermal Erosion Simulation", bold: true, fontSize: 13, color: UI.text });
        W.label(card, { text: "Simulates rainfall droplet cascades to carve realistic valley gullies and deposit sediment in alluvial basins.", color: UI.dim, fontSize: 11 });

        W.slider(card, {
            id: "slider_erosion_iters",
            label: `Erosion Droplets (${procErosionIters}):`,
            value: procErosionIters,
            min: 50,
            max: 500,
            onChange: (v) => {
                procErosionIters = Math.round(parseFloat(v) || 200);
            },
        });

        W.button(card, {
            id: "btn_simulate_erosion",
            text: "💧 Run Droplet Erosion Simulation",
            accent: UI.cyan,
            onClick: () => {
                const raw = generateHeightfield({
                    widthKm: model.world.meta.worldWidthKm,
                    heightKm: model.world.meta.worldHeightKm,
                    resolution: 36,
                    seed: procSeed,
                    mountainScale: procMountainScale,
                    islandMask: procIslandMask,
                });
                const erodedGrid = simulateErosion(raw.grid, procErosionIters, 0.08);
                model.world.contours = extractContoursFromGrid(erodedGrid, model.world.meta.worldWidthKm, model.world.meta.worldHeightKm);
                model.snapshot();
                statusMessage = `Erosion simulation (${procErosionIters} droplets) applied to terrain contours.`;
            },
        });
    });

    W.spacer(main, 10);

    // 3. Procedural River Formation
    W.card(main, { id: "card_proc_rivers", fill: UI.card, padding: 12 }, (card) => {
        W.label(card, { text: "3. Procedural River Drainage Routing", bold: true, fontSize: 13, color: UI.text });
        W.label(card, { text: "Traces steepest downhill descent from mountain watersheds to sea level, generating natural river paths.", color: UI.dim, fontSize: 11 });

        W.slider(card, {
            id: "slider_river_count",
            label: `River Channels (${procRiverCount}):`,
            value: procRiverCount,
            min: 1,
            max: 6,
            onChange: (v) => {
                procRiverCount = Math.round(parseFloat(v) || 3);
            },
        });

        W.button(card, {
            id: "btn_generate_rivers",
            text: "🌊 Route Rivers to Sea Level",
            accent: UI.cyan,
            onClick: () => {
                const hf = generateHeightfield({
                    widthKm: model.world.meta.worldWidthKm,
                    heightKm: model.world.meta.worldHeightKm,
                    resolution: 40,
                    seed: procSeed,
                    mountainScale: procMountainScale,
                    islandMask: procIslandMask,
                });
                const rivers = generateRivers(model.world.meta, hf.grid, procRiverCount);
                model.snapshot();
                rivers.forEach((r) => model.world.paths.push(r));
                statusMessage = `Carved ${rivers.length} procedural river paths to the coast.`;
            },
        });
    });

    W.spacer(main, 10);

    // 4. Procedural Settlement & Road Formation
    W.card(main, { id: "card_proc_towns", fill: UI.card, padding: 12 }, (card) => {
        W.label(card, { text: "4. Procedural Settlement & Road Network Formation", bold: true, fontSize: 13, color: UI.text });
        W.label(card, { text: "Scores terrain fitness (flatness, river access, harbors) and places capitals, ports, towns, and connecting highways.", color: UI.dim, fontSize: 11 });

        W.button(card, {
            id: "btn_generate_settlements",
            text: "🏰 Synthesize Settlements & Road Highway",
            accent: UI.amber,
            onClick: () => {
                const hf = generateHeightfield({
                    widthKm: model.world.meta.worldWidthKm,
                    heightKm: model.world.meta.worldHeightKm,
                    resolution: 40,
                    seed: procSeed,
                    mountainScale: procMountainScale,
                    islandMask: procIslandMask,
                });
                const { spots, roads } = generateSettlements(model.world.meta, hf.grid, model.world.paths);
                model.snapshot();
                spots.forEach((s) => model.world.spots.push(s));
                roads.forEach((r) => model.world.paths.push(r));
                statusMessage = `Formed ${spots.length} settlements and ${roads.length} connecting highways.`;
            },
        });
    });

    W.spacer(main, 10);

    // 5. Procedural Wilderness Scattering
    W.card(main, { id: "card_proc_scatter", fill: UI.card, padding: 12 }, (card) => {
        W.label(card, { text: "5. Procedural POI Wilderness Scattering", bold: true, fontSize: 13, color: UI.text });
        W.label(card, { text: "Scatters ancient ruins, monster dens, resource mines, and shrines across unexplored wilderness zones.", color: UI.dim, fontSize: 11 });

        W.slider(card, {
            id: "slider_scatter_count",
            label: `POIs to Scatter (${procScatterCount}):`,
            value: procScatterCount,
            min: 2,
            max: 10,
            onChange: (v) => {
                procScatterCount = Math.round(parseFloat(v) || 4);
            },
        });

        W.button(card, {
            id: "btn_scatter_pois",
            text: "❖ Scatter Wilderness POIs",
            accent: UI.emerald,
            onClick: () => {
                const scattered = scatterPointsOfInterest(model.world.meta, model.world.spots, procScatterCount);
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

function renderAgentView(main: string): void {
    W.label(main, { text: "AI Agent Collaboration & Revision Pipeline", bold: true, fontSize: 16, color: UI.cyan });
    W.label(main, {
        text: "Export World Bibles, vector SVG maps, GDD documentation, and review proposed AI cartographer revisions before committing.",
        color: UI.dim,
        fontSize: 12,
    });
    W.separator(main);

    // Export Row
    W.horizontal(main, () => {
        W.button(main, {
            id: "btn_copy_bible_json",
            text: "📋 Copy World Bible (JSON)",
            accent: UI.emerald,
            onClick: () => {
                const json = exportWorldBibleJson(model.world);
                try {
                    Entropy.Clipboard?.writeText(json);
                    statusMessage = "Copied World Bible JSON to clipboard.";
                } catch {
                    statusMessage = `World Bible JSON generated (${json.length} bytes).`;
                }
            },
        });

        W.button(main, {
            id: "btn_copy_gdd_md",
            text: "📄 Copy Game Design Doc (Markdown)",
            accent: UI.cyan,
            onClick: () => {
                const md = generateGameDesignDoc(model.world);
                try {
                    Entropy.Clipboard?.writeText(md);
                    statusMessage = "Copied Game Design Document (Markdown) to clipboard.";
                } catch {
                    statusMessage = `Game Design Document generated (${md.length} characters).`;
                }
            },
        });

        W.button(main, {
            id: "btn_export_svg_map",
            text: "🗺 Export Vector SVG Map",
            accent: UI.amber,
            onClick: () => {
                const svg = exportMapToSvg(model.world, 1400, 1400);
                try {
                    Entropy.Clipboard?.writeText(svg);
                    statusMessage = `Vector SVG Map copied to clipboard (${svg.length} bytes).`;
                } catch {
                    statusMessage = `Vector SVG Map generated (${svg.length} bytes).`;
                }
            },
        });

        W.button(main, {
            id: "btn_simulate_agent_proposal",
            text: "🤖 Simulate Agent Proposal",
            onClick: () => {
                activeProposal = createSampleAgentProposal(model.world);
                statusMessage = `Agent "${activeProposal.agentName}" submitted ${activeProposal.changes.length} proposed world revisions!`;
            },
        });
    });

    W.spacer(main, 12);

    // Revision Diff Inspector
    if (activeProposal) {
        W.card(main, { id: "card_revision_proposal", fill: UI.card, padding: 14 }, (card) => {
            W.horizontal(card, () => {
                W.label(card, { text: `Revision Proposal: ${activeProposal!.agentName}`, bold: true, fontSize: 13, color: UI.amber });
                W.spacer(card, 12);
                W.button(card, {
                    id: "btn_apply_all_changes",
                    text: "✓ Apply All Changes",
                    accent: UI.emerald,
                    onClick: () => {
                        model.snapshot();
                        const res = applyRevisionProposal(
                            model.world,
                            activeProposal!,
                            activeProposal!.changes.map((c) => c.id)
                        );
                        statusMessage = `Committed ${res.appliedCount} changes to world state.`;
                        activeProposal = null;
                    },
                });
                W.button(card, {
                    id: "btn_dismiss_proposal",
                    text: "Dismiss",
                    onClick: () => {
                        activeProposal = null;
                    },
                });
            });

            W.label(card, { text: `Motivation: ${activeProposal!.motivation}`, color: UI.dim, fontSize: 11, wrap: true });
            W.separator(card);

            activeProposal!.changes.forEach((c) => {
                W.horizontal(card, () => {
                    W.label(card, { text: `[${c.changeType.toUpperCase()}] ${c.title}`, bold: true, fontSize: 12, color: UI.text });
                    W.spacer(card, 8);
                    W.label(card, { text: `Status: ${c.status.toUpperCase()}`, color: c.status === "accepted" ? UI.emerald : UI.amber, fontSize: 10 });
                });
                W.label(card, { text: c.summary, color: UI.dim, fontSize: 11, wrap: true });

                W.horizontal(card, () => {
                    W.button(card, {
                        id: `btn_accept_${c.id}`,
                        text: "Accept",
                        accent: c.status === "accepted" ? UI.emerald : undefined,
                        onClick: () => {
                            c.status = "accepted";
                        },
                    });
                    W.button(card, {
                        id: `btn_reject_${c.id}`,
                        text: "Reject",
                        accent: c.status === "rejected" ? UI.rose : undefined,
                        onClick: () => {
                            c.status = "rejected";
                        },
                    });
                });
                W.spacer(card, 6);
            });
        });
    }

    W.spacer(main, 12);

    // AI Agent Prompts Box
    W.card(main, { id: "card_agent_prompts", fill: UI.card, padding: 12 }, (card) => {
        W.label(card, { text: "System Prompts for AI Game Masters & Roleplay Agents", bold: true, fontSize: 12, color: UI.text });
        const prompts = generateAgentPrompts(model.world);

        W.label(card, { text: "1. Game Master & Narrative Director Prompt:", bold: true, fontSize: 11, color: UI.emerald });
        W.textInput(card, { id: "gm_prompt_preview", value: prompts.gameMasterPrompt, multiline: true, onChange: () => {} });

        W.spacer(card, 6);
        W.label(card, { text: "2. Technical Level Designer Prompt:", bold: true, fontSize: 11, color: UI.cyan });
        W.textInput(card, { id: "level_prompt_preview", value: prompts.levelDesignerPrompt, multiline: true, onChange: () => {} });
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

            W.split(
                tabId,
                {
                    id: "planner_body_" + model.activeTab,
                    sideOpen: false,
                    sideWidth: 0,
                    reserveBottom: 26,
                    minHeight: 650,
                    mainPadding: 0,
                    scrollMain: false,
                } as SplitConfig,
                (main: string) => {
                    if (model.activeTab === "map") {
                        renderMapView(main);
                    } else if (model.activeTab === "codex") {
                        renderCodexView(main);
                    } else if (model.activeTab === "story") {
                        renderStoryView(main);
                    } else if (model.activeTab === "procedural") {
                        renderProceduralView(main);
                    } else {
                        renderAgentView(main);
                    }
                }
            );

            renderStatusBar(tabId);
        },
    });

    // Keyboard Shortcuts
    Entropy.Input.onKeyDown((key: string, ctrl: boolean) => {
        if (ctrl && key.toLowerCase() === "s") {
            saveWorld();
        } else if (ctrl && key.toLowerCase() === "z") {
            model.undo();
        } else if (ctrl && key.toLowerCase() === "y") {
            model.redo();
        } else if (key.toLowerCase() === "b" && !ctrl) {
            model.setBlockingMode(!model.world.meta.blockingMode);
        } else if (key.toLowerCase() === "m" && !ctrl) {
            model.activeTool = model.activeTool === "measure" ? "select" : "measure";
        }
    });

    // ---------------------------------------------------------------------------------------------
    // Register MCP Tools for Coding Agents & LLMs
    // ---------------------------------------------------------------------------------------------

    addon.registerTool(
        {
            name: "game_planner_get_world",
            description: "Returns the complete Game World specification (metadata, spots/POIs, paths, regions, codex, and missions) from the Game World Planner app.",
            parameters: { type: "object", properties: {} },
        },
        () => {
            return {
                success: true,
                meta: model.world.meta,
                spotsCount: model.world.spots.length,
                pathsCount: model.world.paths.length,
                regionsCount: model.world.regions.length,
                codexCount: model.world.codex.length,
                missionsCount: model.world.missions.length,
                world: model.world,
            };
        }
    );

    addon.registerTool(
        {
            name: "game_planner_add_poi",
            description: "Adds a new Point of Interest (POI) spot to the Game World map.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Name of the location" },
                    spotType: { type: "string", description: "capital, city, town, village, fortress, dungeon, ruin, port, shrine, camp, mine, boss" },
                    x: { type: "number", description: "World X coordinate in km" },
                    y: { type: "number", description: "World Y coordinate in km" },
                    elevation: { type: "number", description: "Elevation in meters above sea level" },
                    description: { type: "string", description: "Location description and lore" },
                    tags: { type: "array", items: { type: "string" }, description: "Location tags" },
                },
                required: ["name", "spotType", "x", "y"],
            },
        },
        (args: any) => {
            const newSpot = model.addSpot({
                name: String(args.name),
                spotType: args.spotType as SpotType,
                x: Number(args.x),
                y: Number(args.y),
                elevation: Number(args.elevation || 100),
                color: [0.35, 0.8, 0.5, 1.0],
                icon: "house",
                tags: Array.isArray(args.tags) ? args.tags : [args.spotType],
                isMajor: args.spotType === "capital" || args.spotType === "city",
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
            description: "Calculates in-game distance and Time-to-Travel across multiple travel modes (foot, mount, vehicle, boat, air) between two points or spots.",
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
            const est = calculateTravelTime(
                [Number(args.fromX), Number(args.fromY)],
                [Number(args.toX), Number(args.toY)],
                model.world.paths,
                model.world.regions
            );
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
                changes: args.changes,
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
        (args: any) => {
            const w = Number(args.width || 1200);
            const h = Number(args.height || 1200);
            const svg = exportMapToSvg(model.world, w, h);
            return { success: true, svg };
        }
    );

    addon.registerTool(
        {
            name: "game_planner_generate_gdd",
            description: "Generates the complete Game Design Document in Markdown format.",
            parameters: { type: "object", properties: {} },
        },
        () => {
            const gdd = generateGameDesignDoc(model.world);
            return { success: true, markdown: gdd };
        }
    );
});
