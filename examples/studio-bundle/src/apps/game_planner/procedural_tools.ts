// Procedural tools: everything here reads and writes the one world heightfield (`TerrainGrid`,
// see terrain.ts), so the rivers follow the valleys you see, settlements sit on the ground they
// were scored on and roads climb the hills that are actually there.

import type {
    ContourLine,
    SpotType,
    TerrainGrid,
    WorldMetadata,
    WorldPath,
    WorldSpot,
} from "./planner_types";
import {
    PRNG,
    chaikin,
    computeDrainage,
    erodeTerrain,
    extractTerrainContours,
    generateTerrain,
    gridToWorld,
    sampleSlopeDeg,
    sampleTerrain,
    simplifyPolyline,
    terrainCellKm,
    terrainFromRows,
    terrainToRows,
    traceRiverChannels,
    worldToGrid,
} from "./terrain";

export { Noise2D, PRNG } from "./terrain";

type Meta = Pick<WorldMetadata, "worldWidthKm" | "worldHeightKm" | "seaLevelM" | "seed">;

const asTerrain = (grid: number[][] | TerrainGrid, seaLevelM = 0): TerrainGrid =>
    Array.isArray(grid) ? terrainFromRows(grid, seaLevelM) : grid;

const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export interface HeightfieldConfig {
    widthKm: number;
    heightKm: number;
    /** Grid vertices along each axis. */
    resolution: number;
    seed: number;
    /** Kept for older callers; the generator chooses its own octave counts. */
    octaves?: number;
    mountainScale?: number;
    seaLevelM?: number;
    islandMask?: boolean;
    ruggedness?: number;
    landBias?: number;
}

export interface HeightfieldResult {
    terrain: TerrainGrid;
    /** The same elevations as rows ([row][col], meters), row 0 = north. */
    grid: number[][];
    resolution: number;
    minElevationM: number;
    maxElevationM: number;
    contours: ContourLine[];
}

/** Generates a terrain heightfield and its contour lines. */
export function generateHeightfield(config: HeightfieldConfig): HeightfieldResult {
    const terrain = generateTerrain({
        widthKm: config.widthKm,
        heightKm: config.heightKm,
        resolution: config.resolution || 129,
        seed: config.seed,
        mountainScale: config.mountainScale,
        seaLevelM: config.seaLevelM,
        islandMask: config.islandMask,
        ruggedness: config.ruggedness,
        landBias: config.landBias,
    });
    return {
        terrain,
        grid: terrainToRows(terrain),
        resolution: terrain.cols,
        minElevationM: Math.round(terrain.minM),
        maxElevationM: Math.round(terrain.maxM),
        contours: extractTerrainContours(terrain, { worldWidthKm: config.widthKm, worldHeightKm: config.heightKm }),
    };
}

/** Contour polylines (marching squares) of a row-of-rows elevation grid spanning widthKm x heightKm. */
export function extractContoursFromGrid(grid: number[][], widthKm: number, heightKm: number, intervalM?: number): ContourLine[] {
    return extractTerrainContours(terrainFromRows(grid), { worldWidthKm: widthKm, worldHeightKm: heightKm }, intervalM);
}

/**
 * Hydraulic erosion on a row-of-rows grid. `iterations` is a strength: each unit runs 40 droplets
 * (a visible result needs thousands). Use `erodeTerrain` directly for a `TerrainGrid`.
 */
export function simulateErosion(grid: number[][], iterations = 250, rainfallStrength = 0.08): number[][] {
    const t = terrainFromRows(grid);
    const eroded = erodeTerrain(t, { droplets: Math.round(iterations * 40), erodeSpeed: 0.3 + rainfallStrength });
    return terrainToRows(eroded);
}

const RIVER_NAMES = ["Silverflow", "Whispering Run", "Drakerush", "Frostmere", "Serpent's Coil", "Misty Water", "Amberwash", "Greywater", "Thornbrook", "Kingsrill"];

/**
 * Rivers along the terrain's real drainage: the biggest catchments, each traced from its mouth up
 * its main stem. Wider rivers drain more land.
 */
export function generateRivers(meta: Meta, grid: number[][] | TerrainGrid, riverCount = 3): WorldPath[] {
    const t = asTerrain(grid, meta.seaLevelM);
    const channels = traceRiverChannels(t, meta, riverCount);
    const maxDischarge = Math.max(1, ...channels.map((c) => c.discharge));
    const rng = new PRNG((meta.seed | 0) + 333);
    const offset = rng.int(0, RIVER_NAMES.length - 1);
    return channels.map((ch, i) => {
        const size = Math.sqrt(ch.discharge / maxDischarge);
        return {
            id: uid("river"),
            name: RIVER_NAMES[(offset + i) % RIVER_NAMES.length],
            pathType: "river" as const,
            points: ch.points,
            width: Number((2.5 + size * 4.5).toFixed(1)),
            color: [0.22, 0.6, 0.92, 1.0] as [number, number, number, number],
            isMajor: true,
            flowSpeed: Number((0.8 + size * 1.6).toFixed(1)),
            surfaceQuality: 1.0,
            description: `Drains about ${Math.round(ch.discharge * terrainCellKm(t, meta).dx * terrainCellKm(t, meta).dy)} km² of land on its way to the sea.`,
        };
    });
}

// -------------------------------------------------------------------------------------------------
// Road routing (A* over the heightfield)
// -------------------------------------------------------------------------------------------------

/**
 * A road between two points that follows the land: steep slopes cost more, water is avoided,
 * existing roads (`preferred`) are cheaper so networks share trunks. Returns km points, smoothed.
 */
export function routeOverTerrain(
    t: TerrainGrid,
    meta: Pick<WorldMetadata, "worldWidthKm" | "worldHeightKm">,
    from: [number, number],
    to: [number, number],
    preferred: Set<number> = new Set()
): [number, number][] {
    const { cols, rows, data } = t;
    const { dx, dy } = terrainCellKm(t, meta);
    const clampCell = (p: [number, number]) => {
        const [gc, gr] = worldToGrid(t, meta, p[0], p[1]);
        return Math.min(rows - 1, Math.max(0, Math.round(gr))) * cols + Math.min(cols - 1, Math.max(0, Math.round(gc)));
    };
    const start = clampCell(from);
    const goal = clampCell(to);
    const gr = Math.floor(goal / cols);
    const gc = goal - gr * cols;
    const g = new Float64Array(cols * rows).fill(Infinity);
    const came = new Int32Array(cols * rows).fill(-1);
    const closed = new Uint8Array(cols * rows);
    // Small binary heap keyed on f = g + h.
    const heapK: number[] = [];
    const heapV: number[] = [];
    const push = (k: number, v: number) => {
        heapK.push(k); heapV.push(v);
        let i = heapK.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (heapK[p] <= heapK[i]) break;
            [heapK[p], heapK[i]] = [heapK[i], heapK[p]];
            [heapV[p], heapV[i]] = [heapV[i], heapV[p]];
            i = p;
        }
    };
    const pop = () => {
        const top = heapV[0];
        const lk = heapK.pop()!, lv = heapV.pop()!;
        if (heapK.length) {
            heapK[0] = lk; heapV[0] = lv;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < heapK.length && heapK[l] < heapK[m]) m = l;
                if (r < heapK.length && heapK[r] < heapK[m]) m = r;
                if (m === i) break;
                [heapK[m], heapK[i]] = [heapK[i], heapK[m]];
                [heapV[m], heapV[i]] = [heapV[i], heapV[m]];
                i = m;
            }
        }
        return top;
    };
    const h = (i: number) => {
        const r = Math.floor(i / cols), c = i - r * cols;
        return Math.hypot((c - gc) * dx, (r - gr) * dy) * 0.9;
    };
    g[start] = 0;
    push(h(start), start);
    const nbrs: Array<[number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
    while (heapK.length) {
        const i = pop();
        if (closed[i]) continue;
        closed[i] = 1;
        if (i === goal) break;
        const r = Math.floor(i / cols), c = i - r * cols;
        for (const [dr, dc] of nbrs) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
            const j = nr * cols + nc;
            if (closed[j]) continue;
            const distKm = Math.hypot(dr * dy, dc * dx);
            const rise = Math.abs(data[j] - data[i]) / (distKm * 1000); // grade
            let cost = distKm * (1 + rise * 28 + (rise > 0.25 ? 40 : 0));
            if (data[j] <= t.seaLevelM) cost += distKm * 60; // bridges and fords only when they must
            if (preferred.has(j)) cost *= 0.45;
            const ng = g[i] + cost;
            if (ng < g[j]) {
                g[j] = ng;
                came[j] = i;
                push(ng + h(j), j);
            }
        }
    }
    const cells: number[] = [];
    for (let cur = goal; cur >= 0; cur = came[cur]) {
        cells.push(cur);
        if (cur === start) break;
    }
    cells.reverse();
    cells.forEach((cell) => preferred.add(cell));
    const pts: [number, number][] = cells.map((i) => gridToWorld(t, meta, i % cols, Math.floor(i / cols)));
    pts[0] = [from[0], from[1]];
    pts[pts.length - 1] = [to[0], to[1]];
    return chaikin(simplifyPolyline(pts, dx * 0.4), 2).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
}

// -------------------------------------------------------------------------------------------------
// Settlements
// -------------------------------------------------------------------------------------------------

interface SettlementDef {
    name: string;
    type: SpotType;
    icon: string;
    isMajor: boolean;
    color: [number, number, number, number];
    /** Where this kind of place wants to be. */
    site: "lowland" | "coast" | "high" | "mountain" | "peak" | "remote";
}

const SETTLEMENTS: SettlementDef[] = [
    { name: "Crown Citadel", type: "capital", icon: "crown", isMajor: true, color: [0.98, 0.75, 0.14, 1.0], site: "lowland" },
    { name: "High Haven Port", type: "port", icon: "anchor", isMajor: true, color: [0.22, 0.74, 0.97, 1.0], site: "coast" },
    { name: "Stonehold", type: "fortress", icon: "shield", isMajor: true, color: [0.6, 0.65, 0.75, 1.0], site: "high" },
    { name: "Riverbend", type: "town", icon: "house", isMajor: false, color: [0.35, 0.8, 0.5, 1.0], site: "lowland" },
    { name: "Oakhaven", type: "village", icon: "tree", isMajor: false, color: [0.45, 0.75, 0.4, 1.0], site: "lowland" },
    { name: "Deepmine Outpost", type: "mine", icon: "pickaxe", isMajor: false, color: [0.8, 0.5, 0.3, 1.0], site: "mountain" },
    { name: "Sunspire Shrine", type: "shrine", icon: "sun", isMajor: false, color: [0.7, 0.45, 0.95, 1.0], site: "peak" },
    { name: "Forgotten Barrow", type: "dungeon", icon: "skull", isMajor: false, color: [0.95, 0.25, 0.35, 1.0], site: "remote" },
];

/**
 * Places a settlement hierarchy where each kind of place belongs on this terrain - the capital on
 * flat, well-watered lowland, the port on the coast, the fortress on high ground, the mine in the
 * mountains - then joins them with roads routed over the land (a highway between the major hubs,
 * local roads from each town to its nearest neighbor on the network).
 */
export function generateSettlements(
    meta: Meta,
    grid: number[][] | TerrainGrid,
    rivers: WorldPath[] = [],
    existingSpots: Array<Pick<WorldSpot, "x" | "y">> = []
): { spots: WorldSpot[]; roads: WorldPath[] } {
    const t = asTerrain(grid, meta.seaLevelM);
    const { cols, rows, data } = t;
    const sea = t.seaLevelM;
    const maxLand = Math.max(sea + 1, t.maxM);
    const rng = new PRNG((meta.seed | 0) + 777);
    const drainage = computeDrainage(t);
    const riverPts = rivers.filter((r) => r.pathType === "river").flatMap((r) => r.points);

    const nearSea = new Uint8Array(cols * rows);
    for (let r = 1; r < rows - 1; r++) {
        for (let c = 1; c < cols - 1; c++) {
            const i = r * cols + c;
            if (data[i] <= sea) continue;
            if (data[i - 1] <= sea || data[i + 1] <= sea || data[i - cols] <= sea || data[i + cols] <= sea) nearSea[i] = 1;
        }
    }
    const placed: Array<[number, number]> = existingSpots.map((s) => [s.x, s.y]);
    const minSpacing = Math.max(2.5, Math.min(meta.worldWidthKm, meta.worldHeightKm) / 9);

    const score = (def: SettlementDef, i: number): number => {
        const e = data[i];
        if (e <= sea + 2) return -Infinity;
        const r = Math.floor(i / cols), c = i - r * cols;
        if (r < 2 || c < 2 || r > rows - 3 || c > cols - 3) return -Infinity;
        const [x, y] = gridToWorld(t, meta, c, r);
        for (const [px, py] of placed) if (Math.hypot(px - x, py - y) < minSpacing) return -Infinity;
        const slope = sampleSlopeDeg(t, meta, x, y);
        const rel = (e - sea) / (maxLand - sea);
        const wet = Math.log1p(drainage.accumulation[i]) + (riverPts.some(([rx, ry]) => Math.hypot(rx - x, ry - y) < 1.2) ? 3 : 0);
        switch (def.site) {
            case "lowland": return 40 - slope * 4 - Math.abs(rel - 0.08) * 120 + wet * 4;
            case "coast": return nearSea[i] ? 60 - slope * 4 - rel * 80 : -Infinity;
            case "high": return rel * 80 - slope * 1.5 + (rel > 0.75 ? -60 : 0);
            case "mountain": return rel > 0.35 ? rel * 60 + slope * 1.5 : -Infinity;
            case "peak": return rel * 120;
            case "remote": {
                let nearest = Infinity;
                for (const [px, py] of placed) nearest = Math.min(nearest, Math.hypot(px - x, py - y));
                return Math.min(nearest, 20) * 3 + rel * 20;
            }
        }
    };

    const spots: WorldSpot[] = [];
    for (const def of SETTLEMENTS) {
        let best = -1;
        let bestScore = -Infinity;
        for (let i = 0; i < data.length; i++) {
            const s = score(def, i);
            if (s === -Infinity) continue;
            const jittered = s + rng.range(-6, 6);
            if (jittered > bestScore) {
                bestScore = jittered;
                best = i;
            }
        }
        if (best < 0) continue;
        const [x, y] = gridToWorld(t, meta, best % cols, Math.floor(best / cols)).map((v) => Math.round(v * 100) / 100) as [number, number];
        placed.push([x, y]);
        spots.push({
            id: uid("spot"),
            name: def.name,
            spotType: def.type,
            x,
            y,
            elevation: Math.round(sampleTerrain(t, meta, x, y)),
            color: def.color,
            icon: def.icon,
            tags: [def.type, def.isMajor ? "major-hub" : "local-point", "generated"],
            isMajor: def.isMajor,
            dangerLevel: def.type === "dungeon" ? 7 : def.type === "mine" ? 4 : 1,
            description: `A ${def.type} sited on ${def.site === "coast" ? "a sheltered stretch of coast" : def.site === "lowland" ? "flat, well-watered lowland" : def.site === "remote" ? "the far wilds" : "high ground"}.`,
            loreNotes: "",
            conceptPrompt: `Landscape concept art of ${def.name}, a ${def.type}, cinematic lighting, 8k`,
            linkedCodexIds: [],
            linkedMissionIds: [],
        });
    }

    const roads: WorldPath[] = [];
    const network = new Set<number>();
    const majors = spots.filter((s) => s.isMajor);
    const ordered: WorldSpot[] = [];
    if (majors.length) {
        // Nearest-neighbor chain from the capital: a highway that visits every major hub once.
        const remaining = [...majors];
        ordered.push(remaining.shift()!);
        while (remaining.length) {
            const last = ordered[ordered.length - 1];
            remaining.sort((a, b) => Math.hypot(a.x - last.x, a.y - last.y) - Math.hypot(b.x - last.x, b.y - last.y));
            ordered.push(remaining.shift()!);
        }
    }
    if (ordered.length >= 2) {
        const pts: [number, number][] = [];
        for (let i = 0; i < ordered.length - 1; i++) {
            const leg = routeOverTerrain(t, meta, [ordered[i].x, ordered[i].y], [ordered[i + 1].x, ordered[i + 1].y], network);
            pts.push(...(i === 0 ? leg : leg.slice(1)));
        }
        roads.push({
            id: uid("road"),
            name: "The King's Highway",
            pathType: "highway",
            points: pts,
            width: 5.0,
            color: [0.98, 0.75, 0.14, 1.0],
            isMajor: true,
            flowSpeed: 0,
            surfaceQuality: 0.8,
            description: `Paved highway joining ${ordered.map((s) => s.name).join(", ")}, graded around the steepest ground.`,
        });
    }
    const connected: WorldSpot[] = ordered.length ? [...ordered] : spots.slice(0, 1);
    for (const s of spots) {
        if (connected.includes(s) || s.spotType === "dungeon") continue;
        const nearest = connected.reduce((a, b) => (Math.hypot(a.x - s.x, a.y - s.y) < Math.hypot(b.x - s.x, b.y - s.y) ? a : b));
        const pts = routeOverTerrain(t, meta, [nearest.x, nearest.y], [s.x, s.y], network);
        const isTrail = s.spotType === "mine" || s.spotType === "shrine";
        roads.push({
            id: uid("road"),
            name: `${s.name} ${isTrail ? "Trail" : "Road"}`,
            pathType: isTrail ? "trail" : "road",
            points: pts,
            width: isTrail ? 2.0 : 3.5,
            color: isTrail ? [0.65, 0.55, 0.4, 1.0] : [0.85, 0.75, 0.55, 1.0],
            isMajor: false,
            flowSpeed: 0,
            surfaceQuality: isTrail ? 1.35 : 1.0,
            description: `${isTrail ? "A switchback trail" : "A packed-earth road"} from ${nearest.name} to ${s.name}.`,
        });
        connected.push(s);
    }
    return { spots, roads };
}

// -------------------------------------------------------------------------------------------------
// Wilderness points of interest
// -------------------------------------------------------------------------------------------------

const POI_TEMPLATES: Array<{ name: string; type: SpotType; icon: string; color: [number, number, number, number]; high: boolean }> = [
    { name: "Sunken Monolith", type: "ruin", icon: "spark", color: [0.65, 0.5, 0.85, 1.0], high: false },
    { name: "Wyrm's Crag", type: "boss", icon: "sword", color: [0.95, 0.25, 0.35, 1.0], high: true },
    { name: "Crystal Hollow", type: "mine", icon: "gem", color: [0.35, 0.85, 0.95, 1.0], high: true },
    { name: "Bandit Encampment", type: "camp", icon: "tent", color: [0.85, 0.5, 0.2, 1.0], high: false },
    { name: "Weeping Shrine", type: "shrine", icon: "sun", color: [0.7, 0.45, 0.95, 1.0], high: true },
    { name: "Hollow Crypt", type: "dungeon", icon: "skull", color: [0.9, 0.3, 0.4, 1.0], high: false },
];

/**
 * Scatters ruins, lairs, mines and camps through the wilderness: on land when there is terrain,
 * away from existing spots, danger rising with remoteness and altitude.
 */
export function scatterPointsOfInterest(
    meta: Meta,
    existingSpots: WorldSpot[],
    scatterCount = 4,
    terrain?: TerrainGrid
): WorldSpot[] {
    const rng = new PRNG((meta.seed | 0) + 999 + existingSpots.length * 13);
    const halfW = meta.worldWidthKm * 0.46;
    const halfH = meta.worldHeightKm * 0.46;
    const placed: Array<[number, number]> = existingSpots.map((s) => [s.x, s.y]);
    const spacing = Math.max(1.5, Math.min(meta.worldWidthKm, meta.worldHeightKm) / 14);
    const newSpots: WorldSpot[] = [];
    for (let i = 0; i < scatterCount; i++) {
        const tpl = POI_TEMPLATES[i % POI_TEMPLATES.length];
        let best: [number, number] | null = null;
        let bestScore = -Infinity;
        for (let attempt = 0; attempt < 60; attempt++) {
            const x = rng.range(-halfW, halfW);
            const y = rng.range(-halfH, halfH);
            const elev = terrain ? sampleTerrain(terrain, meta, x, y) : 300;
            if (terrain && elev <= terrain.seaLevelM + 3) continue;
            let nearest = Infinity;
            for (const [px, py] of placed) nearest = Math.min(nearest, Math.hypot(px - x, py - y));
            if (nearest < spacing) continue;
            const rel = terrain ? (elev - terrain.seaLevelM) / Math.max(1, terrain.maxM - terrain.seaLevelM) : 0.3;
            const s = Math.min(nearest, 12) + (tpl.high ? rel * 10 : (1 - rel) * 5) + rng.range(0, 2);
            if (s > bestScore) {
                bestScore = s;
                best = [x, y];
            }
        }
        if (!best) best = [rng.range(-halfW, halfW), rng.range(-halfH, halfH)];
        const [x, y] = [Math.round(best[0] * 100) / 100, Math.round(best[1] * 100) / 100];
        placed.push([x, y]);
        const elevation = terrain ? Math.round(sampleTerrain(terrain, meta, x, y)) : Math.round(rng.range(150, 950));
        let nearest = Infinity;
        for (const s of existingSpots) nearest = Math.min(nearest, Math.hypot(s.x - x, s.y - y));
        const dangerLevel = Math.max(1, Math.min(10, Math.round(2 + Math.min(nearest, 15) / 3 + (tpl.type === "boss" ? 3 : 0) + rng.range(-1, 1))));
        newSpots.push({
            id: uid("poi"),
            name: `${tpl.name}${i >= POI_TEMPLATES.length ? ` ${Math.floor(i / POI_TEMPLATES.length) + 1}` : ""}`,
            spotType: tpl.type,
            x,
            y,
            elevation,
            color: tpl.color,
            icon: tpl.icon,
            tags: ["scattered", tpl.type],
            isMajor: false,
            dangerLevel,
            description: `An isolated ${tpl.type} in the wilderness.`,
            loreNotes: "Awaiting exploration.",
            linkedCodexIds: [],
            linkedMissionIds: [],
        });
    }
    return newSpots;
}
