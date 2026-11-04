import { describe, expect, it } from "vitest";
import { PlannerModel } from "../src/apps/game_planner/planner_model";
import {
    BASE_SPEEDS,
    calculateRouteTravelTime,
    calculateTravelTime,
    euclideanDistanceKm,
    formatDuration,
    isPointInsidePolygon,
    pathPolylineLengthKm,
} from "../src/apps/game_planner/travel_calculator";
import {
    PRNG,
    extractContoursFromGrid,
    generateHeightfield,
    generateRivers,
    generateSettlements,
    scatterPointsOfInterest,
    simulateErosion,
} from "../src/apps/game_planner/procedural_tools";
import {
    createCodexEntry,
    filterCodexByCategory,
    generateConceptImagePrompt,
    linkCodexToSpot,
    unlinkCodexFromSpot,
} from "../src/apps/game_planner/codex_model";
import {
    computeAvailableMissions,
    createMission,
    getChronologicalActs,
    linkMissionToPath,
    linkMissionToRegion,
    linkMissionToSpot,
    validateQuestGraph,
} from "../src/apps/game_planner/story_model";
import {
    applyRevisionProposal,
    createSampleAgentProposal,
    diffWorldWithProposal,
    exportMapToSvg,
    exportWorldBibleJson,
    generateAgentPrompts,
    generateGameDesignDoc,
} from "../src/apps/game_planner/agent_pipeline";
import {
    CRIMSON_EXPANSE_PRESET,
    NEO_AETHELGARD_PRESET,
    SHATTERED_ISLES_PRESET,
} from "../src/apps/game_planner/presets";
import type {
    RevisionProposal,
    SpotType,
    WorldPath,
    WorldRegion,
    WorldSpot,
} from "../src/apps/game_planner/planner_types";

describe("Game World Planner: Core Model & Presets", () => {
    it("loads the Fantasy Shattered Isles preset with complete topologies", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        expect(model.world.meta.name).toBe("The Shattered Isles");
        expect(model.world.meta.genre).toBe("fantasy");
        expect(model.world.spots.length).toBeGreaterThanOrEqual(5);
        expect(model.world.paths.length).toBeGreaterThanOrEqual(2);
        expect(model.world.regions.length).toBeGreaterThanOrEqual(3);
        expect(model.world.codex.length).toBeGreaterThanOrEqual(4);
        expect(model.world.acts.length).toBe(2);
        expect(model.world.missions.length).toBeGreaterThanOrEqual(4);

        // Spot types present
        const spotTypes = new Set(model.world.spots.map((s) => s.spotType));
        expect(spotTypes.has("capital")).toBe(true);
        expect(spotTypes.has("fortress")).toBe(true);
        expect(spotTypes.has("port")).toBe(true);
    });

    it("loads the Sci-Fi Neo-Aethelgard 2142 preset", () => {
        const model = new PlannerModel(NEO_AETHELGARD_PRESET);
        expect(model.world.meta.name).toBe("Neo-Aethelgard 2142");
        expect(model.world.meta.genre).toBe("cyberpunk");
        expect(model.world.spots.length).toBeGreaterThanOrEqual(2);
        expect(model.world.regions.length).toBeGreaterThanOrEqual(2);
        expect(model.world.meta.worldWidthKm).toBe(40.0);
        expect(model.world.meta.worldHeightKm).toBe(40.0);
    });

    it("supports Spot CRUD operations with boundary checks", () => {
        const model = new PlannerModel();
        const initialCount = model.world.spots.length;

        const newSpot = model.addSpot({
            name: "Whispering Hollow",
            x: -4.5,
            y: 6.2,
            elevation: 420,
            spotType: "ruin",
            icon: "ruins",
            color: [0.7, 0.4, 0.9, 1.0],
            tags: ["ancient", "cursed", "loot"],
            isMajor: false,
            description: "Overgrown ruins whispering forgotten chants.",
            linkedCodexIds: [],
            linkedMissionIds: [],
        });

        expect(newSpot.id).toBeDefined();
        expect(model.world.spots.length).toBe(initialCount + 1);

        // Update spot
        model.updateSpot(newSpot.id, {
            name: "Screaming Hollow",
            elevation: 550,
            dangerLevel: 8,
        });

        const updated = model.world.spots.find((s) => s.id === newSpot.id);
        expect(updated).toBeDefined();
        expect(updated!.name).toBe("Screaming Hollow");
        expect(updated!.elevation).toBe(550);
        expect(updated!.dangerLevel).toBe(8);

        // Delete spot
        model.deleteSpot(newSpot.id);
        expect(model.world.spots.find((s) => s.id === newSpot.id)).toBeUndefined();
        expect(model.world.spots.length).toBe(initialCount);
    });

    it("supports Path CRUD operations including waypoint insertions", () => {
        const model = new PlannerModel();
        const initialCount = model.world.paths.length;

        const newPath = model.addPath({
            name: "High Pass Ridge Road",
            pathType: "highway",
            points: [
                [0, 0],
                [10, 15],
                [25, 30],
            ],
            width: 4.5,
            color: [0.9, 0.7, 0.2, 0.9],
            isMajor: true,
        });

        expect(newPath.id).toBeDefined();
        expect(model.world.paths.length).toBe(initialCount + 1);

        // Add waypoint
        model.addPathPoint(newPath.id, [35, 45]);
        const updated = model.world.paths.find((p) => p.id === newPath.id);
        expect(updated!.points.length).toBe(4);
        expect(updated!.points[3]).toEqual([35, 45]);

        // Toggle major (blocking view filter)
        model.updatePath(newPath.id, { isMajor: false });
        expect(model.world.paths.find((p) => p.id === newPath.id)!.isMajor).toBe(false);

        // Delete path
        model.deletePath(newPath.id);
        expect(model.world.paths.length).toBe(initialCount);
    });

    it("supports Region CRUD operations with polygon vertices", () => {
        const model = new PlannerModel();
        const newRegion = model.addRegion({
            name: "Ashen Caldera",
            regionType: "danger",
            points: [
                [-10, -10],
                [10, -10],
                [10, 10],
                [-10, 10],
            ],
            fillColor: [0.9, 0.25, 0.15, 0.35],
            borderColor: [0.95, 0.35, 0.2, 0.8],
            isMajor: true,
            dominantBiome: "volcanic",
            dangerLevel: 9,
            description: "Lava flats with sulfur steam vents.",
        });

        expect(newRegion.id).toBeDefined();
        expect(model.world.regions.find((r) => r.id === newRegion.id)).toBeDefined();

        model.updateRegion(newRegion.id, { dangerLevel: 10 });
        expect(model.world.regions.find((r) => r.id === newRegion.id)!.dangerLevel).toBe(10);

        model.deleteRegion(newRegion.id);
        expect(model.world.regions.find((r) => r.id === newRegion.id)).toBeUndefined();
    });

    it("maintains an Undo/Redo stack and tracks dirty state", () => {
        const model = new PlannerModel();
        expect(model.canUndo).toBe(false);
        expect(model.canRedo).toBe(false);

        const spot = model.addSpot({
            name: "Undo Test Point",
            x: 5,
            y: 5,
            elevation: 100,
            spotType: "camp",
            icon: "tent",
            color: [1, 1, 1, 1],
            tags: [],
            isMajor: false,
            description: "Test camp",
            linkedCodexIds: [],
            linkedMissionIds: [],
        });

        expect(model.canUndo).toBe(true);
        expect(model.isDirty).toBe(true);

        // Undo
        const undone = model.undo();
        expect(undone).toBe(true);
        expect(model.world.spots.find((s) => s.id === spot.id)).toBeUndefined();
        expect(model.canRedo).toBe(true);

        // Redo
        const redone = model.redo();
        expect(redone).toBe(true);
        expect(model.world.spots.find((s) => s.id === spot.id)).toBeDefined();
        expect(model.canRedo).toBe(false);
    });

    it("snaps coordinates accurately based on grid snapping settings", () => {
        const model = new PlannerModel();
        model.setGridSnap(500); // 500 meters = 0.5 km

        // 1.23 km should snap to 1.0 km; 1.35 km should snap to 1.5 km
        const [sx1, sy1] = model.snapCoords(1.23, 1.35);
        expect(sx1).toBe(1.0);
        expect(sy1).toBe(1.5);

        // Snap off (0)
        model.setGridSnap(0);
        const [sx2, sy2] = model.snapCoords(1.234, 5.678);
        expect(sx2).toBe(1.234);
        expect(sy2).toBe(5.678);
    });
});

describe("Game World Planner: Time-to-Travel Calculator & Ruler", () => {
    it("calculates accurate Euclidean distance in kilometers", () => {
        const dist = euclideanDistanceKm(0, 0, 3, 4);
        expect(dist).toBe(5.0);

        const dist2 = euclideanDistanceKm(-10, -20, 10, 20);
        expect(dist2).toBeCloseTo(44.721, 2);

        const distTuple = euclideanDistanceKm([0, 0], [3, 4]);
        expect(distTuple).toBe(5.0);
    });

    it("computes travel durations across all 5 modes", () => {
        const start = { id: "s1", name: "Start", x: 0, y: 0, elevation: 100 } as WorldSpot;
        const end = { id: "s2", name: "End", x: 18, y: 0, elevation: 100 } as WorldSpot;

        const estimate = calculateTravelTime(start, end, [], []);
        expect(estimate.directDistanceKm).toBe(18.0);
        expect(estimate.estimates.foot).toBeDefined();
        expect(estimate.estimates.mount).toBeDefined();
        expect(estimate.estimates.vehicle).toBeDefined();
        expect(estimate.estimates.water).toBeDefined();
        expect(estimate.estimates.air).toBeDefined();

        // Speed checks: air is fastest, mount is faster than foot
        expect(estimate.estimates.air.speedKmH).toBeGreaterThan(estimate.estimates.mount.speedKmH);
        expect(estimate.estimates.mount.speedKmH).toBeGreaterThan(estimate.estimates.foot.speedKmH);

        // Formatted strings
        expect(estimate.estimates.foot.formattedTime).toMatch(/\d+[hm]/);
        expect(estimate.summaryText).toContain("Foot:");
        expect(estimate.summaryText).toContain("Horse:");
    });

    it("applies terrain impedance multipliers (road speedup vs swamp penalty)", () => {
        const p1: [number, number] = [0, 0];
        const p2: [number, number] = [10, 0];

        // Road path connecting the two points
        const roadPath: WorldPath = {
            id: "p_road",
            name: "King's Road",
            pathType: "highway",
            points: [[0, 0], [10, 0]],
            width: 5,
            color: [1, 1, 1, 1],
            isMajor: true,
        };

        const onRoadEstimate = calculateTravelTime(p1, p2, [roadPath], []);
        expect(onRoadEstimate.pathFound).toBe(true);
        expect(onRoadEstimate.difficultyMultiplier).toBeLessThan(1.0); // 0.8x for highway

        // Swamp region covering the points
        const swampRegion: WorldRegion = {
            id: "reg_swamp",
            name: "Murk Swamp",
            regionType: "biome",
            points: [[-5, -5], [15, -5], [15, 5], [-5, 5]],
            fillColor: [0.1, 0.4, 0.2, 0.3],
            borderColor: [0.2, 0.5, 0.3, 0.8],
            isMajor: false,
            dominantBiome: "swamp",
            dangerLevel: 5,
            description: "Deep bog",
        };

        const onSwampEstimate = calculateTravelTime(p1, p2, [], [swampRegion]);
        expect(onSwampEstimate.difficultyMultiplier).toBeGreaterThan(1.8);
    });

    it("applies slope and elevation climbing grade penalties", () => {
        const flatStart: WorldSpot = { id: "s1", name: "A", x: 0, y: 0, elevation: 100 } as any;
        const flatEnd: WorldSpot = { id: "s2", name: "B", x: 5, y: 0, elevation: 100 } as any;

        const steepStart: WorldSpot = { id: "s3", name: "C", x: 0, y: 0, elevation: 100 } as any;
        const steepEnd: WorldSpot = { id: "s4", name: "D", x: 5, y: 0, elevation: 1600 } as any; // +1500m climb

        const flatEstimate = calculateTravelTime(flatStart, flatEnd, [], []);
        const steepEstimate = calculateTravelTime(steepStart, steepEnd, [], []);

        // Steep ascent should increase difficultyMultiplier
        expect(steepEstimate.difficultyMultiplier).toBeGreaterThan(flatEstimate.difficultyMultiplier);
    });

    it("calculates multi-waypoint route travel time and formats duration strings", () => {
        const waypoints = [
            { x: 0, y: 0, elevation: 50 },
            { x: 9, y: 12, elevation: 150 }, // 15 km
            { x: 33, y: 12, elevation: 300 }, // +24 km = 39 km total
        ];

        const routeEstimate = calculateRouteTravelTime(waypoints, "mount", "trail");
        expect(routeEstimate.distanceKm).toBeCloseTo(39.0, 1);
        expect(routeEstimate.durationHours).toBeGreaterThan(0);
        expect(routeEstimate.formattedDuration).toBeDefined();

        // Format duration strings
        expect(formatDuration(0.5)).toBe("30m");
        expect(formatDuration(2.75)).toBe("2h 45m");
        expect(formatDuration(30.0)).toBe("1d 6h");
    });
});

describe("Game World Planner: Procedural Generation & Simulation", () => {
    it("provides deterministic pseudo-random sequences with Mulberry32 PRNG", () => {
        const prng1 = new PRNG(1337);
        const prng2 = new PRNG(1337);

        const seq1 = [prng1.next(), prng1.next(), prng1.next()];
        const seq2 = [prng2.next(), prng2.next(), prng2.next()];
        expect(seq1).toEqual(seq2);

        expect(prng1.range(-10, 10)).toBeGreaterThanOrEqual(-10);
        expect(prng1.range(-10, 10)).toBeLessThanOrEqual(10);
        expect(prng1.int(1, 6)).toBeGreaterThanOrEqual(1);
        expect(prng1.int(1, 6)).toBeLessThanOrEqual(6);
        expect(["a", "b", "c"]).toContain(prng1.pick(["a", "b", "c"]));
    });

    it("generates 2D fractal heightfield with elevation contours and island masking", () => {
        const result = generateHeightfield({
            widthKm: 80,
            heightKm: 80,
            resolution: 32,
            seed: 42,
            mountainScale: 2500,
            octaves: 4,
            islandMask: true,
        });

        expect(result.grid.length).toBe(32);
        expect(result.grid[0].length).toBe(32);
        expect(result.resolution).toBe(32);
        expect(result.minElevationM).toBeLessThan(result.maxElevationM);
        expect(result.contours.length).toBeGreaterThan(0);

        // Island mask ensures outer borders are near or below sea level
        const corner = result.grid[0][0];
        expect(corner).toBeLessThanOrEqual(100);
    });

    it("extracts elevation contour bands from a terrain grid", () => {
        const grid = [
            [0, 150, 450, 750],
            [150, 300, 600, 900],
            [450, 600, 750, 1200],
            [750, 900, 1200, 1500],
        ];

        const contours = extractContoursFromGrid(grid, 40, 40);
        expect(Array.isArray(contours)).toBe(true);
        for (const c of contours) {
            expect(c.elevation).toBeGreaterThanOrEqual(0);
            expect(c.points.length).toBeGreaterThan(0);
            expect(c.color.length).toBe(4);
        }
    });

    it("simulates hydraulic droplet erosion across heightfield cells", () => {
        const raw = generateHeightfield({
            widthKm: 40,
            heightKm: 40,
            resolution: 24,
            seed: 99,
        });

        const eroded = simulateErosion(raw.grid, 150, 0.1);
        expect(eroded.length).toBe(24);
        expect(eroded[0].length).toBe(24);

        // Some cells will have changed due to erosion carving and sediment deposition
        let diffCount = 0;
        for (let r = 0; r < 24; r++) {
            for (let c = 0; c < 24; c++) {
                if (Math.abs(eroded[r][c] - raw.grid[r][c]) > 0.01) {
                    diffCount++;
                }
            }
        }
        expect(diffCount).toBeGreaterThan(0);
    });

    it("generates natural river drainage networks flowing downhill", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const hf = generateHeightfield({
            widthKm: 30,
            heightKm: 30,
            resolution: 32,
            seed: 123,
            islandMask: true,
        });

        const rivers = generateRivers(model.world.meta, hf.grid, 3);
        expect(rivers.length).toBeGreaterThanOrEqual(1);

        for (const river of rivers) {
            expect(river.pathType).toBe("river");
            expect(river.points.length).toBeGreaterThanOrEqual(2);
            expect(river.isMajor).toBe(true);
        }
    });

    it("procedurally places settlement hierarchies (capitals, cities, towns, villages)", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const hf = generateHeightfield({
            widthKm: 30,
            heightKm: 30,
            resolution: 24,
            seed: 555,
        });

        const settlements = generateSettlements(model.world.meta, hf.grid);
        expect(settlements.spots.length).toBeGreaterThanOrEqual(3);
        expect(settlements.roads.length).toBeGreaterThanOrEqual(1);

        const types = settlements.spots.map((s) => s.spotType);
        expect(types).toContain("capital");
        expect(types).toContain("town");
    });

    it("scatters points of interest with spacing and danger variance", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const pois = scatterPointsOfInterest(model.world.meta, model.world.spots, 6);
        expect(pois.length).toBe(6);

        for (const p of pois) {
            expect(p.spotType).toMatch(/ruin|shrine|dungeon|camp|mine|boss|landmark/);
            expect(p.dangerLevel).toBeGreaterThanOrEqual(1);
            expect(p.dangerLevel).toBeLessThanOrEqual(10);
            expect(p.tags.length).toBeGreaterThan(0);
        }
    });
});

describe("Game World Planner: Codex & Lore Engine", () => {
    it("creates, filters, and manages Codex entries across categories", () => {
        const character = createCodexEntry(
            "Archmage Varis",
            "character",
            "Grand Scholar of the Astral Spire",
            "Varis unlocked the secrets of leyline convergence.",
            "fantasy"
        );

        const weapon = createCodexEntry(
            "Sunreaver Greatsword",
            "weapon",
            "Forged in solar flares",
            "A legendary greatsword burning with celestial flame.",
            "fantasy"
        );

        const faction = createCodexEntry(
            "Order of the Eclipse",
            "faction",
            "Shadow devotees guarding the veil",
            "Guards of ancient forbidden relics.",
            "fantasy"
        );

        const codex = [character, weapon, faction];

        const characters = filterCodexByCategory(codex, "character");
        expect(characters.length).toBe(1);
        expect(characters[0].name).toBe("Archmage Varis");

        const weapons = filterCodexByCategory(codex, "weapon");
        expect(weapons.length).toBe(1);
        expect(weapons[0].name).toBe("Sunreaver Greatsword");
    });

    it("supports bidirectional linking between Codex entries and Map Spots", () => {
        const entry = createCodexEntry(
            "High Justiciar Valerius",
            "character",
            "Lord of the Sun Citadel",
            "Supreme commander of the Solaris Guard.",
            "fantasy"
        );
        const spot: WorldSpot = {
            id: "spot_solaris_citadel",
            name: "Solaris Citadel",
            spotType: "capital",
            x: 0,
            y: 5,
            elevation: 320,
            color: [1, 0.8, 0.2, 1],
            icon: "castle",
            tags: ["capital"],
            isMajor: true,
            description: "Capital of the realm",
            linkedCodexIds: [],
            linkedMissionIds: [],
        };

        linkCodexToSpot(entry, spot);
        expect(entry.linkedSpotIds).toContain(spot.id);
        expect(spot.linkedCodexIds).toContain(entry.id);

        unlinkCodexFromSpot(entry, spot);
        expect(entry.linkedSpotIds).not.toContain(spot.id);
        expect(spot.linkedCodexIds).not.toContain(entry.id);
    });

    it("generates vivid AI image prompts based on category, genre, and attributes", () => {
        const promptFantasy = generateConceptImagePrompt(
            "Valkyrie of the Iron Cloud",
            "character",
            "Aerial commander clad in runic armor",
            "High-ranking aerial officer guarding the mountain aerie.",
            "fantasy"
        );
        expect(promptFantasy).toContain("Valkyrie of the Iron Cloud");
        expect(promptFantasy).toContain("high fantasy concept art");

        const promptSciFi = generateConceptImagePrompt(
            "Nexus Core Reactor",
            "lore",
            "Sub-orbital antimatter reactor",
            "Generates primary power for the neo-metropolis.",
            "cyberpunk"
        );
        expect(promptSciFi).toContain("cyberpunk 2077");
        expect(promptSciFi).toContain("neon glare");
    });
});

describe("Game World Planner: Story Acts & Quest DAG", () => {
    it("organizes chapters and missions chronologically into Acts", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const acts = model.world.acts;
        const missions = model.world.missions;

        const chronological = getChronologicalActs(acts, missions);
        expect(chronological.length).toBe(acts.length);
        expect(chronological[0].act.title).toBe(acts[0].title);
        expect(chronological[0].chapters.length).toBeGreaterThan(0);
        expect(chronological[0].chapters[0].missions.length).toBeGreaterThan(0);
    });

    it("links missions to spots, paths, and regions", () => {
        const mission = createMission("The Smuggler's Secret", "Meet contact at Port Kraken");
        const spot: WorldSpot = { id: "spot_port_kraken", name: "Port Kraken" } as any;
        const path: WorldPath = { id: "path_coastal_highway", name: "Coastal Highway" } as any;
        const region: WorldRegion = { id: "reg_south_coast", name: "South Coast" } as any;

        linkMissionToSpot(mission, spot, "start");
        expect(mission.startSpotId).toBe(spot.id);

        linkMissionToSpot(mission, spot, "objective");
        expect(mission.objectiveSpotIds).toContain(spot.id);

        linkMissionToPath(mission, path);
        expect(mission.objectivePathIds).toContain(path.id);

        linkMissionToRegion(mission, region);
        expect(mission.objectiveRegionIds).toContain(region.id);
    });

    it("validates a healthy acyclic Quest DAG graph and computes available missions", () => {
        const m1 = createMission("Quest A", "Intro quest", "main");
        const m2 = createMission("Quest B", "Depends on A", "main");
        m2.prerequisiteMissionIds = [m1.id];
        const m3 = createMission("Quest C", "Depends on B", "main");
        m3.prerequisiteMissionIds = [m2.id];

        const validation = validateQuestGraph([m1, m2, m3]);
        expect(validation.valid).toBe(true);
        expect(validation.cycle).toBeUndefined();

        // Initially only m1 is available
        const initialAvailable = computeAvailableMissions([m1, m2, m3], new Set());
        expect(initialAvailable.map((m) => m.id)).toEqual([m1.id]);

        // After completing m1, m2 becomes available
        const afterM1 = computeAvailableMissions([m1, m2, m3], new Set([m1.id]));
        expect(afterM1.map((m) => m.id)).toEqual([m2.id]);
    });

    it("detects cycle dependencies in quest web", () => {
        const m1 = createMission("Quest Alpha", "A", "main");
        const m2 = createMission("Quest Beta", "B", "main");
        const m3 = createMission("Quest Gamma", "C", "main");

        // Cycle: A -> B -> C -> A
        m1.prerequisiteMissionIds = [m3.id];
        m2.prerequisiteMissionIds = [m1.id];
        m3.prerequisiteMissionIds = [m2.id];

        const cyclicValidation = validateQuestGraph([m1, m2, m3]);
        expect(cyclicValidation.valid).toBe(false);
        expect(cyclicValidation.cycle).toBeDefined();
        expect(cyclicValidation.cycle!.length).toBeGreaterThan(0);
    });
});

describe("Game World Planner: Agent Collaboration Pipeline & Diff Engine", () => {
    it("exports clean World Bible JSON with metadata and schema versioning", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const json = exportWorldBibleJson(model.world);
        expect(json).toBeDefined();

        const parsed = JSON.parse(json);
        expect(parsed.schemaVersion).toBe("1.0.0");
        expect(parsed.exportedAt).toBeDefined();
        expect(parsed.meta.name).toBe("The Shattered Isles");
        expect(parsed.spots.length).toBe(model.world.spots.length);
        expect(parsed.paths.length).toBe(model.world.paths.length);
        expect(parsed.codex.length).toBe(model.world.codex.length);
    });

    it("generates structured Game Design Document (GDD) Markdown", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const gdd = generateGameDesignDoc(model.world);

        expect(gdd).toContain("# Game Design Document:");
        expect(gdd).toContain("## 1. World Setting & Synopsis");
        expect(gdd).toContain("## 2. Regions & Biomes");
        expect(gdd).toContain("## 3. Atlas of Locations (Points of Interest)");
        expect(gdd).toContain("## 4. Roads, Rivers & Transit Corridors");
        expect(gdd).toContain("## 5. Codex Database");
        expect(gdd).toContain("## 6. Narrative Missions & Story Structure");
    });

    it("generates specialized LLM agent system prompts", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const prompts = generateAgentPrompts(model.world);

        expect(prompts.gameMasterPrompt).toContain("Game Master");
        expect(prompts.gameMasterPrompt).toContain("The Shattered Isles");

        expect(prompts.levelDesignerPrompt).toContain("Level Designer");
        expect(prompts.levelDesignerPrompt).toContain("topological");

        expect(prompts.npcRoleplayPrompt).toContain("roleplaying NPCs");
    });

    it("produces sample agent revision proposals and calculates diffs", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const proposal = createSampleAgentProposal(model.world);

        expect(proposal.id).toBeDefined();
        expect(proposal.agentName).toBeDefined();
        expect(proposal.motivation).toBeDefined();
        expect(proposal.changes.length).toBeGreaterThan(0);

        const diffSummary = diffWorldWithProposal(model.world, proposal);
        expect(diffSummary.length).toBe(proposal.changes.length);
        expect(diffSummary[0].action).toMatch(/add|modify|delete/);
        expect(diffSummary[0].title).toBeDefined();
    });

    it("applies revision proposals cleanly with selective apply and atomic commit", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const initialSpotsCount = model.world.spots.length;

        const proposal: RevisionProposal = {
            id: "rev_test_1",
            agentName: "Agent-LevelArchitect",
            timestamp: Date.now(),
            motivation: "Expand Eastern Frontier Outposts",
            changes: [
                {
                    id: "change_1",
                    changeType: "add_spot",
                    targetId: "spot_eastern_garrison",
                    title: "Add Fortress Aegis",
                    summary: "Border garrison",
                    after: {
                        name: "Fortress Aegis",
                        x: 12.0,
                        y: 14.5,
                        elevation: 380,
                        spotType: "fortress",
                        icon: "fortress",
                        color: [0.3, 0.6, 0.9, 1.0],
                        tags: ["frontier", "military"],
                        isMajor: true,
                        description: "High fortress",
                        linkedCodexIds: [],
                        linkedMissionIds: [],
                    },
                    status: "accepted",
                },
                {
                    id: "change_2",
                    changeType: "modify_spot",
                    targetId: model.world.spots[0].id,
                    title: "Fortify Capital",
                    summary: "Upgrade defenses",
                    after: {
                        name: `${model.world.spots[0].name} (Reinforced)`,
                    },
                    status: "accepted",
                },
            ],
        };

        const result = applyRevisionProposal(model.world, proposal, ["change_1", "change_2"]);
        expect(result.appliedCount).toBe(2);
        expect(result.rejectedCount).toBe(0);
        expect(model.world.spots.length).toBe(initialSpotsCount + 1);

        const addedSpot = model.world.spots.find((s) => s.id === "spot_eastern_garrison");
        expect(addedSpot).toBeDefined();
        expect(addedSpot!.name).toBe("Fortress Aegis");

        const modifiedSpot = model.world.spots.find((s) => s.id === model.world.spots[0].id);
        expect(modifiedSpot!.name).toContain("(Reinforced)");
    });

    it("loads and validates the Sci-Fi Crimson Expanse preset", () => {
        const model = new PlannerModel(CRIMSON_EXPANSE_PRESET);
        expect(model.world.meta.name).toBe("The Crimson Expanse: Ares-IV");
        expect(model.world.meta.genre).toBe("scifi");
        expect(model.world.spots.length).toBeGreaterThanOrEqual(5);
        expect(model.world.regions.length).toBeGreaterThanOrEqual(3);
        expect(model.world.paths.length).toBeGreaterThanOrEqual(2);
        expect(model.world.codex.length).toBeGreaterThanOrEqual(3);
        expect(model.world.missions.length).toBeGreaterThanOrEqual(2);
        expect(model.world.meta.worldWidthKm).toBe(40.0);
    });

    it("generates clean standalone Vector SVG maps", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const svg = exportMapToSvg(model.world, 1000, 1000);

        expect(svg).toContain("<svg");
        expect(svg).toContain("</svg>");
        expect(svg).toContain("viewBox=\"0 0 1000 1000\"");
        expect(svg).toContain(model.world.meta.name);
        expect(svg).toContain("polyline");
        expect(svg).toContain("polygon");
        expect(svg).toContain("circle");
    });

    it("manages interactive path drawing lifecycle", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const initPaths = model.world.paths.length;

        model.activeTool = "draw_path";
        model.appendPendingPathPoint([0, 0]);
        model.appendPendingPathPoint([2, 4]);
        model.appendPendingPathPoint([5, 8]);
        expect(model.pendingPathPoints.length).toBe(3);

        model.undoPendingPathPoint();
        expect(model.pendingPathPoints.length).toBe(2);

        const createdPath = model.finishPendingPath("highway", "Royal Northern Expressway");
        expect(createdPath).toBeDefined();
        expect(createdPath!.name).toBe("Royal Northern Expressway");
        expect(createdPath!.pathType).toBe("highway");
        expect(createdPath!.points.length).toBe(2);
        expect(model.world.paths.length).toBe(initPaths + 1);
        expect(model.pendingPathPoints.length).toBe(0);
        expect(model.activeTool).toBe("select");
    });

    it("manages interactive region drawing lifecycle", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        const initRegions = model.world.regions.length;

        model.activeTool = "draw_region";
        model.appendPendingRegionPoint([-5, -5]);
        model.appendPendingRegionPoint([5, -5]);
        model.appendPendingRegionPoint([5, 5]);
        model.appendPendingRegionPoint([-5, 5]);
        expect(model.pendingRegionPoints.length).toBe(4);

        const createdRegion = model.finishPendingRegion("forest", "Verdant Reach");
        expect(createdRegion).toBeDefined();
        expect(createdRegion!.name).toBe("Verdant Reach");
        expect(createdRegion!.dominantBiome).toBe("forest");
        expect(createdRegion!.points.length).toBe(4);
        expect(model.world.regions.length).toBe(initRegions + 1);
        expect(model.pendingRegionPoints.length).toBe(0);
        expect(model.activeTool).toBe("select");
    });

    it("supports spot dragging with grid snapping", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);
        model.setGridSnap(100); // 100m = 0.1km snap

        const targetSpot = model.world.spots[0];
        const originalX = targetSpot.x;
        const originalY = targetSpot.y;

        const res = model.moveSpot(targetSpot.id, 5.1234, 8.7891);
        expect(res).toBe(true);

        const updated = model.world.spots.find((s) => s.id === targetSpot.id)!;
        expect(updated.x).toBe(5.1);
        expect(updated.y).toBe(8.8);

        // Can undo the move
        expect(model.undo()).toBe(true);
        const reverted = model.world.spots.find((s) => s.id === targetSpot.id)!;
        expect(reverted.x).toBe(originalX);
        expect(reverted.y).toBe(originalY);
    });

    it("supports duplicating entities (spots, paths, regions, codex, missions)", () => {
        const model = new PlannerModel(SHATTERED_ISLES_PRESET);

        // Spot duplicate
        const dupSpot = model.duplicateSpot(model.world.spots[0].id);
        expect(dupSpot).toBeDefined();
        expect(dupSpot!.name).toContain("(Copy)");
        expect(dupSpot!.id).not.toBe(model.world.spots[0].id);

        // Path duplicate
        const dupPath = model.duplicatePath(model.world.paths[0].id);
        expect(dupPath).toBeDefined();
        expect(dupPath!.name).toContain("(Copy)");

        // Region duplicate
        const dupRegion = model.duplicateRegion(model.world.regions[0].id);
        expect(dupRegion).toBeDefined();
        expect(dupRegion!.name).toContain("(Copy)");

        // Codex duplicate
        const dupCodex = model.duplicateCodexEntry(model.world.codex[0].id);
        expect(dupCodex).toBeDefined();
        expect(dupCodex!.name).toContain("(Copy)");

        // Mission duplicate
        const dupMission = model.duplicateMission(model.world.missions[0].id);
        expect(dupMission).toBeDefined();
        expect(dupMission!.title).toContain("(Copy)");
    });
});
