import type {
    BiomeType,
    CodexEntry,
    GameWorld,
    Mission,
    PathType,
    WorldPath,
    WorldRegion,
    WorldSpot,
} from "./planner_types";
import { SHATTERED_ISLES_PRESET } from "./presets";

export class PlannerModel {
    world: GameWorld;
    selectedId: string | null = null;
    activeTab: "map" | "codex" | "story" | "procedural" | "agent" = "map";
    activeTool: "select" | "pan" | "place_spot" | "draw_path" | "draw_region" | "measure" = "select";
    pendingPathPoints: [number, number][] = [];
    pendingRegionPoints: [number, number][] = [];
    measurePoints: { p1?: [number, number]; p2?: [number, number] } = {};
    measureWaypoints: [number, number][] = [];

    // Layer and HUD visibility
    showMinimap = true;
    showGrid = true;
    showContours = true;
    showBiomes = true;

    // Viewport position memory
    viewportCenter: [number, number] = [0, 0];
    viewportZoom = 24.0;

    private undoStack: string[] = [];
    private redoStack: string[] = [];
    private maxHistory = 50;
    isDirty = false;

    constructor(initialWorld?: GameWorld) {
        this.world = initialWorld ? JSON.parse(JSON.stringify(initialWorld)) : JSON.parse(JSON.stringify(SHATTERED_ISLES_PRESET));
    }

    get canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    get canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    snapshot(): void {
        const stateStr = JSON.stringify(this.world);
        this.undoStack.push(stateStr);
        if (this.undoStack.length > this.maxHistory) {
            this.undoStack.shift();
        }
        this.redoStack = [];
        this.isDirty = true;
    }

    undo(): boolean {
        if (this.undoStack.length === 0) return false;
        const currentState = JSON.stringify(this.world);
        this.redoStack.push(currentState);
        const prev = this.undoStack.pop()!;
        this.world = JSON.parse(prev);
        this.isDirty = true;
        return true;
    }

    redo(): boolean {
        if (this.redoStack.length === 0) return false;
        const currentState = JSON.stringify(this.world);
        this.undoStack.push(currentState);
        const next = this.redoStack.pop()!;
        this.world = JSON.parse(next);
        this.isDirty = true;
        return true;
    }

    // --- Spots CRUD ---

    addSpot(spot: Omit<WorldSpot, "id"> & { id?: string }): WorldSpot {
        this.snapshot();
        const id = spot.id || `spot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const newSpot: WorldSpot = { ...spot, id };
        this.world.spots.push(newSpot);
        this.selectedId = id;
        return newSpot;
    }

    updateSpot(id: string, updates: Partial<WorldSpot>): boolean {
        const idx = this.world.spots.findIndex((s) => s.id === id);
        if (idx === -1) return false;
        this.snapshot();
        this.world.spots[idx] = { ...this.world.spots[idx], ...updates };
        return true;
    }

    moveSpot(id: string, xKm: number, yKm: number): boolean {
        const spot = this.world.spots.find((s) => s.id === id);
        if (!spot) return false;
        this.snapshot();
        spot.x = this.snapCoordinate(xKm);
        spot.y = this.snapCoordinate(yKm);
        return true;
    }

    duplicateSpot(id: string): WorldSpot | null {
        const original = this.world.spots.find((s) => s.id === id);
        if (!original) return null;
        this.snapshot();
        const copy: WorldSpot = {
            ...JSON.parse(JSON.stringify(original)),
            id: `spot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: `${original.name} (Copy)`,
            x: Number((original.x + 0.5).toFixed(2)),
            y: Number((original.y - 0.5).toFixed(2)),
        };
        this.world.spots.push(copy);
        this.selectedId = copy.id;
        return copy;
    }

    deleteSpot(id: string): boolean {
        const idx = this.world.spots.findIndex((s) => s.id === id);
        if (idx === -1) return false;
        this.snapshot();
        this.world.spots.splice(idx, 1);
        if (this.selectedId === id) this.selectedId = null;

        // Clean up linked references in codex and missions
        this.world.codex.forEach((c) => {
            c.linkedSpotIds = c.linkedSpotIds.filter((sid) => sid !== id);
        });
        this.world.missions.forEach((m) => {
            if (m.startSpotId === id) delete m.startSpotId;
            if (m.turnInSpotId === id) delete m.turnInSpotId;
            m.objectiveSpotIds = m.objectiveSpotIds.filter((sid) => sid !== id);
        });

        return true;
    }

    // --- Paths CRUD ---

    addPath(path: Omit<WorldPath, "id"> & { id?: string }): WorldPath {
        this.snapshot();
        const id = path.id || `path_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const newPath: WorldPath = { ...path, id };
        this.world.paths.push(newPath);
        this.selectedId = id;
        return newPath;
    }

    updatePath(id: string, updates: Partial<WorldPath>): boolean {
        const idx = this.world.paths.findIndex((p) => p.id === id);
        if (idx === -1) return false;
        this.snapshot();
        this.world.paths[idx] = { ...this.world.paths[idx], ...updates };
        return true;
    }

    addPathPoint(id: string, point: [number, number]): boolean {
        const path = this.world.paths.find((p) => p.id === id);
        if (!path) return false;
        this.snapshot();
        path.points.push(point);
        return true;
    }

    duplicatePath(id: string): WorldPath | null {
        const original = this.world.paths.find((p) => p.id === id);
        if (!original) return null;
        this.snapshot();
        const copy: WorldPath = {
            ...JSON.parse(JSON.stringify(original)),
            id: `path_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: `${original.name} (Copy)`,
            points: original.points.map(([x, y]) => [Number((x + 0.3).toFixed(2)), Number((y - 0.3).toFixed(2))]),
        };
        this.world.paths.push(copy);
        this.selectedId = copy.id;
        return copy;
    }

    deletePath(id: string): boolean {
        const idx = this.world.paths.findIndex((p) => p.id === id);
        if (idx === -1) return false;
        this.snapshot();
        this.world.paths.splice(idx, 1);
        if (this.selectedId === id) this.selectedId = null;
        return true;
    }

    // --- Pending Path Creation ---

    appendPendingPathPoint(pt: [number, number]): void {
        this.pendingPathPoints.push(pt);
    }

    undoPendingPathPoint(): void {
        this.pendingPathPoints.pop();
    }

    finishPendingPath(pathType: PathType = "road", name?: string): WorldPath | null {
        if (this.pendingPathPoints.length < 2) return null;
        const colors: Record<PathType, [number, number, number, number]> = {
            highway: [0.98, 0.75, 0.14, 1.0],
            road: [0.8, 0.7, 0.5, 1.0],
            trail: [0.65, 0.55, 0.4, 1.0],
            river: [0.22, 0.74, 0.97, 1.0],
            bridge: [0.8, 0.85, 0.9, 1.0],
        };
        const newPath = this.addPath({
            name: name || `Path ${this.world.paths.length + 1}`,
            pathType,
            points: [...this.pendingPathPoints],
            width: pathType === "highway" ? 5.0 : pathType === "river" ? 4.5 : 3.5,
            color: colors[pathType] || [0.8, 0.7, 0.5, 1.0],
            isMajor: pathType === "highway" || pathType === "river",
            flowSpeed: pathType === "river" ? 1.5 : 0,
            surfaceQuality: pathType === "highway" ? 0.8 : pathType === "trail" ? 1.35 : 1.0,
            description: `A newly mapped ${pathType} connecting waypoints across the region.`,
        });
        this.pendingPathPoints = [];
        this.activeTool = "select";
        return newPath;
    }

    cancelPendingPath(): void {
        this.pendingPathPoints = [];
    }

    // --- Regions CRUD ---

    addRegion(region: Omit<WorldRegion, "id"> & { id?: string }): WorldRegion {
        this.snapshot();
        const id = region.id || `region_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const newRegion: WorldRegion = { ...region, id };
        this.world.regions.push(newRegion);
        this.selectedId = id;
        return newRegion;
    }

    updateRegion(id: string, updates: Partial<WorldRegion>): boolean {
        const idx = this.world.regions.findIndex((r) => r.id === id);
        if (idx === -1) return false;
        this.snapshot();
        this.world.regions[idx] = { ...this.world.regions[idx], ...updates };
        return true;
    }

    duplicateRegion(id: string): WorldRegion | null {
        const original = this.world.regions.find((r) => r.id === id);
        if (!original) return null;
        this.snapshot();
        const copy: WorldRegion = {
            ...JSON.parse(JSON.stringify(original)),
            id: `region_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: `${original.name} (Copy)`,
            points: original.points.map(([x, y]) => [Number((x + 0.5).toFixed(2)), Number((y - 0.5).toFixed(2))]),
        };
        this.world.regions.push(copy);
        this.selectedId = copy.id;
        return copy;
    }

    deleteRegion(id: string): boolean {
        const idx = this.world.regions.findIndex((r) => r.id === id);
        if (idx === -1) return false;
        this.snapshot();
        this.world.regions.splice(idx, 1);
        if (this.selectedId === id) this.selectedId = null;
        return true;
    }

    // --- Pending Region Creation ---

    appendPendingRegionPoint(pt: [number, number]): void {
        this.pendingRegionPoints.push(pt);
    }

    undoPendingRegionPoint(): void {
        this.pendingRegionPoints.pop();
    }

    finishPendingRegion(biomeType: BiomeType = "plains", name?: string): WorldRegion | null {
        if (this.pendingRegionPoints.length < 3) return null;
        const biomeColors: Record<BiomeType, { fill: [number, number, number, number]; border: [number, number, number, number] }> = {
            plains: { fill: [0.2, 0.7, 0.35, 0.22], border: [0.3, 0.85, 0.45, 0.85] },
            forest: { fill: [0.15, 0.55, 0.25, 0.25], border: [0.2, 0.7, 0.35, 0.85] },
            jungle: { fill: [0.1, 0.65, 0.4, 0.28], border: [0.15, 0.85, 0.5, 0.9] },
            desert: { fill: [0.85, 0.75, 0.35, 0.25], border: [0.95, 0.85, 0.45, 0.85] },
            tundra: { fill: [0.6, 0.75, 0.85, 0.25], border: [0.75, 0.88, 0.98, 0.85] },
            volcanic: { fill: [0.75, 0.25, 0.15, 0.28], border: [0.95, 0.35, 0.2, 0.9] },
            swamp: { fill: [0.3, 0.45, 0.25, 0.3], border: [0.4, 0.6, 0.35, 0.85] },
            alpine: { fill: [0.65, 0.7, 0.8, 0.25], border: [0.8, 0.85, 0.95, 0.85] },
            coastal: { fill: [0.2, 0.65, 0.75, 0.22], border: [0.3, 0.8, 0.9, 0.85] },
            savanna: { fill: [0.75, 0.65, 0.25, 0.22], border: [0.88, 0.78, 0.35, 0.85] },
            taiga: { fill: [0.2, 0.45, 0.4, 0.25], border: [0.25, 0.6, 0.55, 0.85] },
            badlands: { fill: [0.7, 0.4, 0.25, 0.25], border: [0.85, 0.5, 0.35, 0.85] },
        };
        const colors = biomeColors[biomeType] || biomeColors.plains;

        const newRegion = this.addRegion({
            name: name || `Region ${this.world.regions.length + 1}`,
            regionType: "biome",
            points: [...this.pendingRegionPoints],
            fillColor: colors.fill,
            borderColor: colors.border,
            isMajor: true,
            dominantBiome: biomeType,
            dangerLevel: 3,
            description: `A delineated territory characterized by ${biomeType} terrain and local ecosystems.`,
        });
        this.pendingRegionPoints = [];
        this.activeTool = "select";
        return newRegion;
    }

    cancelPendingRegion(): void {
        this.pendingRegionPoints = [];
    }

    // --- Codex CRUD ---

    addCodexEntry(entry: Omit<CodexEntry, "id"> & { id?: string }): CodexEntry {
        this.snapshot();
        const id = entry.id || `codex_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const newEntry: CodexEntry = { ...entry, id };
        this.world.codex.push(newEntry);
        this.selectedId = id;
        return newEntry;
    }

    updateCodexEntry(id: string, updates: Partial<CodexEntry>): boolean {
        const idx = this.world.codex.findIndex((c) => c.id === id);
        if (idx === -1) return false;
        this.snapshot();
        this.world.codex[idx] = { ...this.world.codex[idx], ...updates };
        return true;
    }

    duplicateCodexEntry(id: string): CodexEntry | null {
        const original = this.world.codex.find((c) => c.id === id);
        if (!original) return null;
        this.snapshot();
        const copy: CodexEntry = {
            ...JSON.parse(JSON.stringify(original)),
            id: `codex_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: `${original.name} (Copy)`,
        };
        this.world.codex.push(copy);
        this.selectedId = copy.id;
        return copy;
    }

    deleteCodexEntry(id: string): boolean {
        const idx = this.world.codex.findIndex((c) => c.id === id);
        if (idx === -1) return false;
        this.snapshot();
        this.world.codex.splice(idx, 1);
        if (this.selectedId === id) this.selectedId = null;
        return true;
    }

    // --- Missions CRUD ---

    addMission(mission: Omit<Mission, "id"> & { id?: string }): Mission {
        this.snapshot();
        const id = mission.id || `mission_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const newMission: Mission = { ...mission, id };
        this.world.missions.push(newMission);
        this.selectedId = id;
        return newMission;
    }

    updateMission(id: string, updates: Partial<Mission>): boolean {
        const idx = this.world.missions.findIndex((m) => m.id === id);
        if (idx === -1) return false;
        this.snapshot();
        this.world.missions[idx] = { ...this.world.missions[idx], ...updates };
        return true;
    }

    duplicateMission(id: string): Mission | null {
        const original = this.world.missions.find((m) => m.id === id);
        if (!original) return null;
        this.snapshot();
        const copy: Mission = {
            ...JSON.parse(JSON.stringify(original)),
            id: `mission_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            title: `${original.title} (Copy)`,
        };
        this.world.missions.push(copy);
        this.selectedId = copy.id;
        return copy;
    }

    deleteMission(id: string): boolean {
        const idx = this.world.missions.findIndex((m) => m.id === id);
        if (idx === -1) return false;
        this.snapshot();
        this.world.missions.splice(idx, 1);
        if (this.selectedId === id) this.selectedId = null;
        return true;
    }

    // --- Settings & Measurement ---

    clearMeasurement(): void {
        this.measurePoints = {};
        this.measureWaypoints = [];
    }

    setBlockingMode(blocking: boolean): void {
        this.world.meta.blockingMode = blocking;
        this.isDirty = true;
    }

    setGridSnap(snapMeters: number): void {
        this.world.meta.gridSnapM = snapMeters;
        this.isDirty = true;
    }

    snapCoordinate(valKm: number): number {
        if (this.world.meta.gridSnapM <= 0) return valKm;
        const snapKm = this.world.meta.gridSnapM / 1000;
        return Number(((Math.round(valKm / snapKm) * snapKm)).toFixed(4));
    }

    snapCoords(xKm: number, yKm: number): [number, number] {
        return [this.snapCoordinate(xKm), this.snapCoordinate(yKm)];
    }
}
