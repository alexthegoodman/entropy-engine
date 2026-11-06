import type {
    BiomeType,
    CodexEntry,
    CodexPlacement,
    GameWorld,
    IntentKind,
    IntentShape,
    Mission,
    PathType,
    PlanIntent,
    QuestPath,
    RevisionChange,
    StructureKind,
    StructureShape,
    WorldStructure,
    RevisionProposal,
    TerrainGrid,
    TerrainStyle,
    WorldPath,
    WorldRegion,
    WorldSpot,
} from "./planner_types";
import { SHATTERED_ISLES_PRESET } from "./presets";
import { sampleSlopeDeg, sampleTerrain, terrainForWorld } from "./terrain";
import { BIOME_COLORS, PATH_DEFAULTS } from "./planner_defaults";
import { applyRevisionChange, isProposalPending, rejectRevisionChange } from "./agent_pipeline";
import { createIntent, evaluateIntent, spotNear } from "./intent_model";
import { SCULPT_INFO, applyBrushStroke, applyShapeStroke, defaultSculptSettings, type SculptSettings } from "./terrain_sculpt";
import { emptyOverlay, paintStroke, pruneCodexReferences, type PaintOptions } from "./planning_layers";
import { attachRouteToQuest, followSpot, forgetSpot, questFromRoute } from "./quest_paths";
import { STRUCTURE_KINDS, translateStructure } from "./town_planning";

export type PlannerTool = "select" | "pan" | "place_spot" | "quest_path" | "build" | "draw_region" | "measure" | "intent" | "sculpt" | "paint" | "populate";

/** Whether a spot sits on the ground (its elevation follows the terrain). Older saves: yes. */
export const isSnapped = (s: Pick<WorldSpot, "snapToGround">) => s.snapToGround !== false;

/** The map's color theme for a genre: Mars-like worlds are arid, neon cities dark. */
export function paletteForGenre(genre: GameWorld["meta"]["genre"]): "temperate" | "arid" | "frozen" | "neon" {
    switch (genre) {
        case "scifi":
        case "postapoc":
            return "arid";
        case "cyberpunk":
            return "neon";
        default:
            return "temperate";
    }
}

export class PlannerModel {
    world: GameWorld;
    selectedId: string | null = null;
    activeTab: "map" | "codex" | "story" | "agent" | "worlds" = "map";
    activeTool: PlannerTool = "select";
    pendingPathPoints: [number, number][] = [];
    pendingRegionPoints: [number, number][] = [];
    measurePoints: { p1?: [number, number]; p2?: [number, number] } = {};
    measureWaypoints: [number, number][] = [];
    /** What the draw tools make. */
    pendingPathType: PathType = "road";
    pendingRegionBiome: BiomeType = "plains";
    /** The Quest Path tool: the quest a drawn route goes to, or "new" to make a quest from it. */
    pendingQuestId: string = "new";
    /** The Build tool: what a click places. */
    buildKind: StructureKind = "house";
    buildShape: StructureShape = "rect";
    buildWidthM = 10;
    buildDepthM = 8;
    buildRotationDeg = 0;
    /** Turn new buildings to face the nearest street or road. */
    buildAlign = true;
    /** Points of a wall, street or area being clicked out. */
    pendingBuildPoints: [number, number][] = [];
    /** Spot being dragged on the map (one undo step per drag). */
    draggingSpotId: string | null = null;

    // Intent sketching
    intentShape: IntentShape = "area";
    /** "auto" lets the shape (and, later, the directive's words) decide. */
    intentKind: IntentKind | "auto" = "auto";
    pendingIntentPoints: [number, number][] = [];
    /** The proposal change selected on the map (its ghost), for review in the inspector. */
    selectedChangeId: string | null = null;

    // Terrain sculpting
    sculpt: SculptSettings = defaultSculptSettings();
    /** Points of a canyon / range / road bed / plateau being clicked out. */
    pendingSculptPoints: [number, number][] = [];
    /** A brush stroke is in progress (one undo step for the whole drag). */
    private strokeOpen = false;
    /** flatten: the height picked where the stroke started. */
    private strokeTargetM: number | null = null;
    private strokeSeed = 1;

    // Painting planning marks and population
    /** A mark id ("forest") or a codex layer ("codex:<id>"). */
    paintKey = "forest";
    paintRadiusKm = 1.0;
    paintStrength = 0.6;
    paintErase = false;
    /** Painting a surface mark thins the others under it. */
    paintExclusive = true;
    /** Confine painting to this region's outline. */
    paintClipRegionId: string | null = null;
    /** Populate: the codex entry being placed or painted. */
    populateCodexId: string | null = null;
    /** The placement selected on the map. */
    selectedPlacementId: string | null = null;

    // Story on the map
    /** The quest whose route the map highlights. */
    highlightedQuestId: string | null = null;
    /** Ask the map to center on a place: bump `seq`. */
    focus: { seq: number; center: [number, number]; zoom?: number } = { seq: 0, center: [0, 0] };

    // Layer and HUD visibility
    showMinimap = true;
    showGrid = true;
    showContours = true;
    showBiomes = true;
    showLabels = true;
    showIntents = true;
    showProposals = true;
    showMarks = true;
    showPopulation = true;
    showQuests = true;
    terrainStyle: TerrainStyle = "relief";
    /** Bumped to ask the map to fit the whole world. */
    fitRequest = 0;

    // Viewport position memory
    viewportCenter: [number, number] = [0, 0];
    viewportZoom = 24.0;

    private undoStack: string[] = [];
    private redoStack: string[] = [];
    private maxHistory = 50;
    private lastSnapshotKey: string | null = null;
    private lastSnapshotAt = 0;
    isDirty = false;

    constructor(initialWorld?: GameWorld) {
        this.world = initialWorld ? JSON.parse(JSON.stringify(initialWorld)) : JSON.parse(JSON.stringify(SHATTERED_ISLES_PRESET));
        this.world.intents ??= [];
        this.world.proposals ??= [];
        this.world.questPaths ??= [];
        this.world.structures ??= [];
        this.ensureTerrain();
    }

    get questPaths(): QuestPath[] {
        return (this.world.questPaths ??= []);
    }

    get structures(): WorldStructure[] {
        return (this.world.structures ??= []);
    }

    get intents(): PlanIntent[] {
        return (this.world.intents ??= []);
    }

    get placements(): CodexPlacement[] {
        return (this.world.placements ??= []);
    }

    /**
     * A world without a heightfield (a preset, an older save) gets one generated from its seed and
     * fitted to its spots' elevations; its old hand-drawn contour sketches are dropped, since the
     * map now traces real contours from the terrain.
     */
    ensureTerrain(): void {
        const t = this.world.terrain;
        if (t && t.cols >= 2 && t.rows >= 2 && t.data?.length === t.cols * t.rows) return;
        this.world.terrain = terrainForWorld(this.world.meta, this.world.spots, {}, this.world.paths.filter((p) => p.pathType === "river"));
        this.world.contours = [];
    }

    /**
     * Replaces the heightfield (one undo step) and re-reads the elevation of every spot that snaps
     * to the landscape; spots with an authored elevation keep it.
     */
    setTerrain(terrain: TerrainGrid, resampleSpots = true): void {
        this.snapshot();
        this.world.terrain = terrain;
        this.world.contours = [];
        if (resampleSpots) this.resampleSnappedSpots();
    }

    /** Puts every snapped spot back on the ground. */
    resampleSnappedSpots(): void {
        const t = this.world.terrain;
        if (!t) return;
        for (const s of this.world.spots) {
            if (isSnapped(s)) s.elevation = Math.round(sampleTerrain(t, this.world.meta, s.x, s.y));
        }
    }

    // --- Terrain sculpting ---

    get sculptKind(): "brush" | "line" | "area" {
        return SCULPT_INFO[this.sculpt.mode].kind;
    }

    /**
     * Applies part of a brush stroke. The first call of a stroke takes the undo snapshot (and, for
     * flatten with Snap to Landscape, picks the level under the first point); `done` ends it and puts
     * snapped spots back on the ground.
     */
    sculptBrush(points: [number, number][], done: boolean): void {
        this.ensureTerrain();
        const t = this.world.terrain!;
        if (!this.strokeOpen && points.length) {
            this.snapshot();
            this.strokeOpen = true;
            this.strokeSeed = (this.strokeSeed * 1103515245 + 12345) & 0x7fffffff;
            this.strokeTargetM = this.sculpt.snapToLandscape ? sampleTerrain(t, this.world.meta, points[0][0], points[0][1]) : this.sculpt.targetM;
        }
        if (points.length && this.strokeOpen) {
            this.world.terrain = applyBrushStroke(t, this.world.meta, points, {
                mode: this.sculpt.mode,
                radiusKm: this.sculpt.radiusKm,
                strength: this.sculpt.strength,
                targetM: this.strokeTargetM ?? undefined,
                seed: this.strokeSeed,
            });
            this.world.contours = [];
        }
        if (done) {
            if (this.strokeOpen) this.resampleSnappedSpots();
            this.strokeOpen = false;
            this.strokeTargetM = null;
        }
    }

    /** Carves, raises, grades or levels along the clicked-out points (one undo step). */
    sculptShape(points: [number, number][] = this.pendingSculptPoints): boolean {
        const need = this.sculptKind === "area" ? 3 : 2;
        if (points.length < need) return false;
        this.ensureTerrain();
        this.snapshot();
        this.strokeSeed = (this.strokeSeed * 1103515245 + 12345) & 0x7fffffff;
        this.world.terrain = applyShapeStroke(this.world.terrain!, this.world.meta, points, this.sculpt, this.strokeSeed);
        this.world.contours = [];
        this.resampleSnappedSpots();
        this.pendingSculptPoints = [];
        // Physical roads and rivers are laid with the ground they need: a graded bed, a canyon floor.
        this.lastLaidPath = null;
        const lay: PathType | null = this.sculpt.mode === "grade" && this.sculpt.layRoad !== "none" ? this.sculpt.layRoad : this.sculpt.mode === "canyon" && this.sculpt.layRiver ? "river" : null;
        if (lay) {
            const d = PATH_DEFAULTS[lay];
            const n = this.world.paths.filter((p) => p.pathType === lay).length + 1;
            const path: WorldPath = {
                id: `path_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                name: `${lay[0].toUpperCase()}${lay.slice(1)} ${n}`,
                pathType: lay,
                points: points.map((p) => [p[0], p[1]] as [number, number]),
                width: d.width,
                color: d.color,
                isMajor: d.isMajor,
                flowSpeed: d.flowSpeed,
                surfaceQuality: d.surfaceQuality,
                description: lay === "river" ? "Runs along a carved canyon floor." : `Laid on a graded bed (max ${this.sculpt.gradeMaxPercent}% grade).`,
            };
            this.world.paths.push(path);
            this.lastLaidPath = path;
        }
        return true;
    }

    /** The road or river the last road-bed or canyon stroke laid, if any. */
    lastLaidPath: WorldPath | null = null;

    // --- Planning marks & population ---

    ensureOverlay() {
        const m = this.world.meta;
        const o = this.world.overlay;
        if (!o || !o.cols || !o.rows || !o.layers) this.world.overlay = emptyOverlay(m.worldWidthKm, m.worldHeightKm);
        return this.world.overlay!;
    }

    /** Paints a layer along a stroke; the first call of a stroke takes the undo snapshot. */
    paint(key: string, points: [number, number][], done: boolean, opts: Partial<PaintOptions> = {}): number {
        let changed = 0;
        if (points.length) {
            if (!this.strokeOpen) {
                this.snapshot();
                this.strokeOpen = true;
            }
            const clip = this.paintClipRegionId ? this.world.regions.find((r) => r.id === this.paintClipRegionId)?.points : undefined;
            changed = paintStroke(this.ensureOverlay(), this.world.meta, key, points, {
                radiusKm: this.paintRadiusKm,
                strength: this.paintStrength,
                erase: this.paintErase,
                clip,
                exclusive: this.paintExclusive,
                ...opts,
            });
        }
        if (done) this.strokeOpen = false;
        return changed;
    }

    /** Runs an edit to the overlay as one undo step. */
    editOverlay<T>(fn: (o: NonNullable<GameWorld["overlay"]>) => T): T {
        this.snapshot();
        return fn(this.ensureOverlay());
    }

    addPlacement(p: CodexPlacement): CodexPlacement {
        this.snapshot();
        this.placements.push(p);
        this.selectedPlacementId = p.id;
        this.selectedId = p.id;
        return p;
    }

    updatePlacement(id: string, updates: Partial<CodexPlacement>): boolean {
        const p = this.placements.find((x) => x.id === id);
        if (!p) return false;
        this.snapshot(`placement:${id}:${Object.keys(updates).sort().join(",")}`);
        Object.assign(p, updates);
        return true;
    }

    deletePlacement(id: string): boolean {
        const idx = this.placements.findIndex((x) => x.id === id);
        if (idx === -1) return false;
        this.snapshot();
        this.placements.splice(idx, 1);
        if (this.selectedPlacementId === id) this.selectedPlacementId = null;
        if (this.selectedId === id) this.selectedId = null;
        return true;
    }

    /** Links a codex entry and a spot both ways (or unlinks them). */
    linkCodexSpot(codexId: string, spotId: string, link = true): boolean {
        const c = this.world.codex.find((x) => x.id === codexId);
        const s = this.world.spots.find((x) => x.id === spotId);
        if (!c || !s) return false;
        this.snapshot();
        c.linkedSpotIds ??= [];
        s.linkedCodexIds ??= [];
        c.linkedSpotIds = c.linkedSpotIds.filter((x) => x !== spotId);
        s.linkedCodexIds = s.linkedCodexIds.filter((x) => x !== codexId);
        if (link) {
            c.linkedSpotIds.push(spotId);
            s.linkedCodexIds.push(codexId);
        }
        return true;
    }

    /** Centers the map on a place (and zooms in, if asked). */
    focusOn(x: number, y: number, zoom?: number): void {
        this.focus = { seq: this.focus.seq + 1, center: [x, y], zoom };
    }

    /** Ground elevation (meters) at a world position, or `fallback` without terrain. */
    elevationAt(x: number, y: number, fallback = 100): number {
        const t = this.world.terrain;
        return t ? Math.round(sampleTerrain(t, this.world.meta, x, y)) : fallback;
    }

    slopeAt(x: number, y: number): number {
        const t = this.world.terrain;
        return t ? sampleSlopeDeg(t, this.world.meta, x, y) : 0;
    }

    get canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    get canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    /**
     * Pushes an undo step. With a `coalesceKey`, repeated calls with the same key within 1.5 s
     * (typing into one field, dragging one slider) share a single step.
     */
    snapshot(coalesceKey?: string): void {
        const now = Date.now();
        if (coalesceKey && coalesceKey === this.lastSnapshotKey && now - this.lastSnapshotAt < 1500) {
            this.lastSnapshotAt = now;
            this.isDirty = true;
            return;
        }
        this.lastSnapshotKey = coalesceKey ?? null;
        this.lastSnapshotAt = now;
        const stateStr = JSON.stringify(this.world);
        this.undoStack.push(stateStr);
        if (this.undoStack.length > this.maxHistory) {
            this.undoStack.shift();
        }
        this.redoStack = [];
        this.isDirty = true;
    }

    /**
     * Takes in the world as another app (the Game World Detailer) left it on disk, or a merge of
     * that with this app's unsaved edits. One undo step, so it can be taken back; the selection
     * is dropped if what it pointed at is gone.
     */
    adoptWorld(next: GameWorld, dirty: boolean): void {
        this.undoStack.push(JSON.stringify(this.world));
        if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
        this.redoStack = [];
        this.lastSnapshotKey = null;
        this.world = JSON.parse(JSON.stringify(next));
        this.world.intents ??= [];
        this.world.proposals ??= [];
        this.world.questPaths ??= [];
        this.world.structures ??= [];
        this.ensureTerrain();
        const ids = new Set<string>([
            ...this.world.spots.map((x) => x.id), ...this.world.paths.map((x) => x.id), ...this.world.regions.map((x) => x.id),
            ...this.structures.map((x) => x.id), ...(this.world.placements ?? []).map((x) => x.id), ...this.questPaths.map((x) => x.id),
            ...this.intents.map((x) => x.id), ...this.world.codex.map((x) => x.id), ...this.world.missions.map((x) => x.id),
        ]);
        if (this.selectedId && !ids.has(this.selectedId)) this.selectedId = null;
        if (this.selectedPlacementId && !ids.has(this.selectedPlacementId)) this.selectedPlacementId = null;
        this.isDirty = dirty;
    }

    undo(): boolean {
        if (this.undoStack.length === 0) return false;
        const currentState = JSON.stringify(this.world);
        this.redoStack.push(currentState);
        const prev = this.undoStack.pop()!;
        this.world = JSON.parse(prev);
        this.world.intents ??= [];
        this.world.questPaths ??= [];
        this.world.structures ??= [];
        this.lastSnapshotKey = null;
        this.isDirty = true;
        return true;
    }

    redo(): boolean {
        if (this.redoStack.length === 0) return false;
        const currentState = JSON.stringify(this.world);
        this.undoStack.push(currentState);
        const next = this.redoStack.pop()!;
        this.world = JSON.parse(next);
        this.world.intents ??= [];
        this.world.questPaths ??= [];
        this.world.structures ??= [];
        this.lastSnapshotKey = null;
        this.isDirty = true;
        return true;
    }

    // --- Spots CRUD ---

    addSpot(spot: Omit<WorldSpot, "id"> & { id?: string }): WorldSpot {
        this.snapshot();
        const id = spot.id || `spot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const newSpot: WorldSpot = { snapToGround: true, ...spot, id };
        this.world.spots.push(newSpot);
        this.selectedId = id;
        return newSpot;
    }

    updateSpot(id: string, updates: Partial<WorldSpot>): boolean {
        const idx = this.world.spots.findIndex((s) => s.id === id);
        if (idx === -1) return false;
        this.snapshot(`spot:${id}:${Object.keys(updates).sort().join(",")}`);
        const moved = updates.x !== undefined || updates.y !== undefined;
        const before = this.world.spots[idx];
        this.world.spots[idx] = { ...before, ...updates };
        if (moved) {
            const after = this.world.spots[idx];
            followSpot(this.world, id, after.x, after.y);
            const dx = after.x - before.x, dy = after.y - before.y;
            if (dx || dy) for (const st of this.structures) if (st.spotId === id) Object.assign(st, translateStructure(st, dx, dy));
        }
        // A snapped spot stays on the ground: moving it (or switching the snap on) re-reads the
        // ground; an explicit elevation switches the snap off.
        const s = this.world.spots[idx];
        if (updates.elevation !== undefined && updates.snapToGround === undefined) s.snapToGround = false;
        if ((moved || updates.snapToGround === true) && updates.elevation === undefined && this.world.terrain && isSnapped(s)) {
            s.elevation = this.elevationAt(s.x, s.y, s.elevation);
        }
        return true;
    }

    /**
     * Moves a spot (snapped) and sets its elevation from the terrain. During a map drag
     * (`draggingSpotId` set to this spot) the whole drag is one undo step.
     */
    moveSpot(id: string, xKm: number, yKm: number): boolean {
        const spot = this.world.spots.find((s) => s.id === id);
        if (!spot) return false;
        this.snapshot(this.draggingSpotId === id ? `drag:${id}` : undefined);
        const [ox, oy] = [spot.x, spot.y];
        spot.x = this.snapCoordinate(xKm);
        spot.y = this.snapCoordinate(yKm);
        if (isSnapped(spot)) spot.elevation = this.elevationAt(spot.x, spot.y, spot.elevation);
        // Quest routes that pass through the spot, and the town planned around it, come along.
        followSpot(this.world, id, spot.x, spot.y);
        const dx = spot.x - ox, dy = spot.y - oy;
        if (dx || dy) {
            for (const st of this.structures) if (st.spotId === id) Object.assign(st, translateStructure(st, dx, dy));
        }
        return true;
    }

    /** Ends a spot drag: the next move starts a new undo step. */
    endSpotDrag(): void {
        this.draggingSpotId = null;
        this.lastSnapshotKey = null;
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
        forgetSpot(this.world, id);
        for (const st of this.structures) if (st.spotId === id) delete st.spotId;
        this.world.missions.forEach((m) => {
            if (m.startSpotId === id) delete m.startSpotId;
            if (m.turnInSpotId === id) delete m.turnInSpotId;
            m.objectiveSpotIds = m.objectiveSpotIds.filter((sid) => sid !== id);
            if (m.objectiveDetails) delete m.objectiveDetails[id];
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
        this.snapshot(`path:${id}:${Object.keys(updates).sort().join(",")}`);
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

    finishPendingPath(pathType: PathType = this.pendingPathType, name?: string): WorldPath | null {
        if (this.pendingPathPoints.length < 2) return null;
        const colors: Record<PathType, [number, number, number, number]> = {
            highway: [0.98, 0.75, 0.14, 1.0],
            road: [0.8, 0.7, 0.5, 1.0],
            trail: [0.65, 0.55, 0.4, 1.0],
            river: [0.22, 0.74, 0.97, 1.0],
            bridge: [0.8, 0.85, 0.9, 1.0],
        };
        const newPath = this.addPath({
            name: name || `${pathType[0].toUpperCase()}${pathType.slice(1)} ${this.world.paths.filter((p) => p.pathType === pathType).length + 1}`,
            pathType,
            points: [...this.pendingPathPoints],
            width: pathType === "highway" ? 5.0 : pathType === "river" ? 4.5 : pathType === "trail" ? 2.0 : 3.5,
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
        this.snapshot(`region:${id}:${Object.keys(updates).sort().join(",")}`);
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

    finishPendingRegion(biomeType: BiomeType = this.pendingRegionBiome, name?: string): WorldRegion | null {
        if (this.pendingRegionPoints.length < 3) return null;
        const colors = BIOME_COLORS[biomeType] || BIOME_COLORS.plains;

        const newRegion = this.addRegion({
            name: name || `${biomeType[0].toUpperCase()}${biomeType.slice(1)} Region ${this.world.regions.length + 1}`,
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
        this.snapshot(`codex:${id}:${Object.keys(updates).sort().join(",")}`);
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
        // Its placements and painted presence go with it; links to it are dropped.
        pruneCodexReferences(this.world);
        for (const s of this.world.spots) s.linkedCodexIds = (s.linkedCodexIds ?? []).filter((x) => x !== id);
        for (const r of this.world.regions) if (r.controllingFactionId === id) delete r.controllingFactionId;
        for (const m of this.world.missions) {
            if (m.giverCodexId === id) delete m.giverCodexId;
            m.requiredCodexIds = (m.requiredCodexIds ?? []).filter((x) => x !== id);
            if (m.rewardCodexIds) m.rewardCodexIds = m.rewardCodexIds.filter((x) => x !== id);
            if (m.reputation) m.reputation = m.reputation.filter((r) => r.factionId !== id);
            for (const d of Object.values(m.objectiveDetails ?? {})) if (d.targetCodexId === id) delete d.targetCodexId;
        }
        for (const st of this.structures) if (st.occupantCodexIds) st.occupantCodexIds = st.occupantCodexIds.filter((x) => x !== id);
        if (this.populateCodexId === id) this.populateCodexId = null;
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
        this.snapshot(`mission:${id}:${Object.keys(updates).sort().join(",")}`);
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
        for (const m of this.world.missions) {
            m.prerequisiteMissionIds = m.prerequisiteMissionIds.filter((x) => x !== id);
            for (const o of m.outcomes ?? []) o.unlocksMissionIds = o.unlocksMissionIds.filter((x) => x !== id);
        }
        for (const act of this.world.acts) for (const ch of act.chapters) ch.missionIds = ch.missionIds.filter((x) => x !== id);
        if (this.highlightedQuestId === id) this.highlightedQuestId = null;
        // A quest's routes go with it.
        this.world.questPaths = this.questPaths.filter((q) => q.missionId !== id);
        if (this.pendingQuestId === id) this.pendingQuestId = "new";
        return true;
    }

    // --- Quest paths ---

    /**
     * Finishes the route being drawn: makes a new quest from it (pendingQuestId "new"), or wires it
     * into the chosen quest. One undo step. Returns the route, its quest and what was linked.
     */
    finishPendingQuestPath(): { questPath: QuestPath; mission: Mission; created: boolean; linked: string[] } | null {
        if (this.pendingPathPoints.length < 2) return null;
        const points = this.pendingPathPoints.map((p) => [p[0], p[1]] as [number, number]);
        const existing = this.pendingQuestId !== "new" ? this.world.missions.find((m) => m.id === this.pendingQuestId) : undefined;
        this.snapshot();
        let result: { questPath: QuestPath; mission: Mission; created: boolean; linked: string[] };
        if (existing) {
            const { questPath, linked } = attachRouteToQuest(this.world, existing, points);
            this.questPaths.push(questPath);
            result = { questPath, mission: existing, created: false, linked };
        } else {
            const { mission, questPath } = questFromRoute(this.world, points);
            this.world.missions.push(mission);
            this.questPaths.push(questPath);
            // The places on the route know the quest.
            for (const sid of [mission.startSpotId, ...mission.objectiveSpotIds, mission.turnInSpotId]) {
                const spot = sid ? this.world.spots.find((s) => s.id === sid) : undefined;
                if (spot && !spot.linkedMissionIds.includes(mission.id)) spot.linkedMissionIds.push(mission.id);
            }
            this.pendingQuestId = mission.id;
            result = { questPath, mission, created: true, linked: [] };
        }
        this.pendingPathPoints = [];
        this.selectedId = result.questPath.id;
        this.highlightedQuestId = result.mission.id;
        return result;
    }

    updateQuestPath(id: string, updates: Partial<QuestPath>): boolean {
        const q = this.questPaths.find((x) => x.id === id);
        if (!q) return false;
        this.snapshot(`qpath:${id}:${Object.keys(updates).sort().join(",")}`);
        Object.assign(q, updates);
        return true;
    }

    deleteQuestPath(id: string): boolean {
        const n = this.questPaths.length;
        if (!this.questPaths.some((q) => q.id === id)) return false;
        this.snapshot();
        this.world.questPaths = this.questPaths.filter((q) => q.id !== id);
        if (this.selectedId === id) this.selectedId = null;
        return this.questPaths.length < n;
    }

    // --- Town planning ---

    /** Sets what the Build tool places, with that kind's default shape and size. */
    setBuildKind(kind: StructureKind): void {
        const info = STRUCTURE_KINDS[kind] ?? STRUCTURE_KINDS.house;
        this.buildKind = kind;
        this.buildShape = info.shape;
        this.buildWidthM = info.shape === "wall" || info.shape === "street" ? info.lineWidthM ?? 4 : info.widthM;
        this.buildDepthM = info.depthM;
        this.pendingBuildPoints = [];
    }

    addStructures(list: WorldStructure[], select = true): WorldStructure[] {
        if (!list.length) return [];
        this.snapshot();
        this.structures.push(...list);
        if (select) this.selectedId = list[list.length - 1].id;
        return list;
    }

    updateStructure(id: string, updates: Partial<WorldStructure>): boolean {
        const s = this.structures.find((x) => x.id === id);
        if (!s) return false;
        this.snapshot(`structure:${id}:${Object.keys(updates).sort().join(",")}`);
        Object.assign(s, updates);
        return true;
    }

    /** Moves a structure so its anchor lands at (x, y). */
    moveStructure(id: string, x: number, y: number): boolean {
        const s = this.structures.find((q) => q.id === id);
        if (!s) return false;
        this.snapshot();
        Object.assign(s, translateStructure(s, this.snapCoordinate(x) - s.x, this.snapCoordinate(y) - s.y));
        return true;
    }

    duplicateStructure(id: string): WorldStructure | null {
        const s = this.structures.find((q) => q.id === id);
        if (!s) return null;
        const copy: WorldStructure = { ...JSON.parse(JSON.stringify(s)), id: `bld_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}` };
        Object.assign(copy, translateStructure(copy, Math.max(s.widthM, 6) * 1.3 / 1000, 0));
        this.addStructures([copy]);
        return copy;
    }

    deleteStructure(id: string): boolean {
        if (!this.structures.some((s) => s.id === id)) return false;
        this.snapshot();
        this.world.structures = this.structures.filter((s) => s.id !== id);
        if (this.selectedId === id) this.selectedId = null;
        return true;
    }

    /** Removes everything planned for a settlement (one undo step); returns how many. */
    clearTown(spotId: string): number {
        const n = this.structures.filter((s) => s.spotId === spotId).length;
        if (!n) return 0;
        this.snapshot();
        this.world.structures = this.structures.filter((s) => s.spotId !== spotId);
        return n;
    }

    // --- Design intents ---

    addIntent(shape: IntentShape, points: [number, number][], opts: Parameters<typeof createIntent>[3] = {}): PlanIntent {
        this.snapshot();
        const intent = createIntent(this.world, shape, points, opts);
        this.intents.push(intent);
        this.selectedId = intent.id;
        this.selectedChangeId = null;
        return intent;
    }

    updateIntent(id: string, updates: Partial<PlanIntent>): boolean {
        const intent = this.intents.find((i) => i.id === id);
        if (!intent) return false;
        this.snapshot(`intent:${id}:${Object.keys(updates).sort().join(",")}`);
        Object.assign(intent, updates);
        return true;
    }

    deleteIntent(id: string): boolean {
        const idx = this.intents.findIndex((i) => i.id === id);
        if (idx === -1) return false;
        this.snapshot();
        this.intents.splice(idx, 1);
        // Its pending proposals go with it.
        this.world.proposals = this.world.proposals.filter((p) => p.intentId !== id || !isProposalPending(p));
        if (this.selectedId === id) this.selectedId = null;
        return true;
    }

    /**
     * Adds a point to the intent being sketched. A pin is finished by its one point, a route by its
     * second; route ends on (or right next to) a spot are pinned to it. Returns the intent when the
     * click finished one.
     */
    appendPendingIntentPoint(pt: [number, number]): PlanIntent | null {
        const kind = this.intentKind === "auto" ? undefined : this.intentKind;
        if (this.intentShape === "pin") {
            return this.addIntent("pin", [pt], { kind });
        }
        this.pendingIntentPoints.push(pt);
        if (this.intentShape === "route" && this.pendingIntentPoints.length >= 2) {
            const [a, b] = this.pendingIntentPoints;
            this.pendingIntentPoints = [];
            if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-3) return null;
            const from = spotNear(this.world, a);
            const to = spotNear(this.world, b);
            return this.addIntent("route", [a, b], { kind, fromSpotId: from?.id, toSpotId: to?.id, ...(from && to ? { title: `${from.name} → ${to.name}` } : {}) });
        }
        return null;
    }

    /** Closes the area being sketched (3+ points). */
    finishPendingIntent(): PlanIntent | null {
        if (this.intentShape !== "area" || this.pendingIntentPoints.length < 3) return null;
        const pts = [...this.pendingIntentPoints];
        this.pendingIntentPoints = [];
        return this.addIntent("area", pts, { kind: this.intentKind === "auto" ? undefined : this.intentKind });
    }

    cancelPendingIntent(): void {
        this.pendingIntentPoints = [];
    }

    // --- Proposal inbox ---

    findChange(changeId: string): { proposal: RevisionProposal; change: RevisionChange } | null {
        for (const proposal of this.world.proposals) {
            const change = proposal.changes.find((c) => c.id === changeId);
            if (change) return { proposal, change };
        }
        return null;
    }

    get pendingProposals(): RevisionProposal[] {
        return this.world.proposals.filter(isProposalPending);
    }

    /** Files an agent's proposal for review; its intent shows as "proposed". */
    addProposal(proposal: RevisionProposal): RevisionProposal {
        this.snapshot();
        this.world.proposals.push(proposal);
        // Keep the history short: finished proposals beyond the last 30 are dropped.
        const done = this.world.proposals.filter((p) => !isProposalPending(p));
        if (done.length > 30) {
            const drop = new Set(done.slice(0, done.length - 30).map((p) => p.id));
            this.world.proposals = this.world.proposals.filter((p) => !drop.has(p.id));
        }
        const intent = proposal.intentId ? this.intents.find((i) => i.id === proposal.intentId) : undefined;
        if (intent && intent.status !== "dismissed") intent.status = "proposed";
        return proposal;
    }

    /** Accepts (applies) or rejects one change; one undo step each. */
    decideChange(changeId: string, accept: boolean): boolean {
        const found = this.findChange(changeId);
        if (!found || found.change.status !== "pending") return false;
        this.snapshot();
        // The snapshot cloned nothing in place, so the found objects are still live.
        if (accept) {
            if (!applyRevisionChange(this.world, found.change, found.proposal)) {
                found.change.status = "rejected";
            } else {
                found.change.status = "accepted";
            }
        } else {
            rejectRevisionChange(this.world, found.change);
        }
        if (this.selectedChangeId === changeId) this.selectedChangeId = null;
        this.settleProposal(found.proposal);
        return true;
    }

    /** Accepts or rejects every pending change of a proposal, as one undo step. */
    decideProposal(proposalId: string, accept: boolean): number {
        const proposal = this.world.proposals.find((p) => p.id === proposalId);
        if (!proposal) return 0;
        const pending = proposal.changes.filter((c) => c.status === "pending");
        if (!pending.length) return 0;
        this.snapshot();
        let n = 0;
        for (const c of pending) {
            if (accept) {
                const ok = applyRevisionChange(this.world, c, proposal);
                c.status = ok ? "accepted" : "rejected";
                if (ok) n++;
            } else {
                rejectRevisionChange(this.world, c);
                n++;
            }
        }
        if (this.selectedChangeId && proposal.changes.some((c) => c.id === this.selectedChangeId)) this.selectedChangeId = null;
        this.settleProposal(proposal);
        return n;
    }

    /** When a proposal has no pending changes left, its intent is done if the world now meets it. */
    private settleProposal(proposal: RevisionProposal): void {
        if (isProposalPending(proposal)) return;
        const intent = proposal.intentId ? this.intents.find((i) => i.id === proposal.intentId) : undefined;
        if (!intent || intent.status === "dismissed") return;
        if (this.world.proposals.some((p) => p.intentId === intent.id && isProposalPending(p))) return;
        const accepted = proposal.changes.some((c) => c.status === "accepted");
        const ev = evaluateIntent(this.world, intent);
        intent.status = ev.satisfied === true || (ev.satisfied === null && accepted) ? "done" : "open";
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
