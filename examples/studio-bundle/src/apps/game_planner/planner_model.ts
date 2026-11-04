import type {
    CodexEntry,
    GameWorld,
    Mission,
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
    measurePoints: { p1?: [number, number]; p2?: [number, number] } = {};

    private undoStack: string[] = [];
    private redoStack: string[] = [];
    private maxHistory = 40;
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

    deleteSpot(id: string): boolean {
        const idx = this.world.spots.findIndex((s) => s.id === id);
        if (idx === -1) return false;
        this.snapshot();
        this.world.spots.splice(idx, 1);
        if (this.selectedId === id) this.selectedId = null;

        // Clean up linked references in paths, codex, missions
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

    deletePath(id: string): boolean {
        const idx = this.world.paths.findIndex((p) => p.id === id);
        if (idx === -1) return false;
        this.snapshot();
        this.world.paths.splice(idx, 1);
        if (this.selectedId === id) this.selectedId = null;
        return true;
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

    deleteRegion(id: string): boolean {
        const idx = this.world.regions.findIndex((r) => r.id === id);
        if (idx === -1) return false;
        this.snapshot();
        this.world.regions.splice(idx, 1);
        if (this.selectedId === id) this.selectedId = null;
        return true;
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

    deleteMission(id: string): boolean {
        const idx = this.world.missions.findIndex((m) => m.id === id);
        if (idx === -1) return false;
        this.snapshot();
        this.world.missions.splice(idx, 1);
        if (this.selectedId === id) this.selectedId = null;
        return true;
    }

    // --- Settings & Workflow ---

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
