import type {
    ContourLine,
    SpotType,
    WorldMetadata,
    WorldPath,
    WorldSpot,
} from "./planner_types";

// Seedable PRNG (Mulberry32)
export class PRNG {
    private s: number;

    constructor(seed = 1337) {
        this.s = seed | 0;
    }

    next(): number {
        let t = (this.s += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    range(min: number, max: number): number {
        return min + this.next() * (max - min);
    }

    int(min: number, max: number): number {
        return Math.floor(this.range(min, max + 1));
    }

    pick<T>(arr: T[]): T {
        return arr[this.int(0, arr.length - 1)];
    }
}

// 2D Perlin / Value Noise Generator
export class Noise2D {
    private p: number[] = [];

    constructor(seed = 42) {
        const rng = new PRNG(seed);
        const perm: number[] = [];
        for (let i = 0; i < 256; i++) perm.push(i);
        // Shuffle
        for (let i = 255; i > 0; i--) {
            const j = rng.int(0, i);
            [perm[i], perm[j]] = [perm[j], perm[i]];
        }
        this.p = [...perm, ...perm];
    }

    private fade(t: number): number {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }

    private lerp(t: number, a: number, b: number): number {
        return a + t * (b - a);
    }

    private grad(hash: number, x: number, y: number): number {
        const h = hash & 3;
        const u = h < 2 ? x : y;
        const v = h < 2 ? y : x;
        return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    }

    noise(x: number, y: number): number {
        const X = Math.floor(x) & 255;
        const Y = Math.floor(y) & 255;
        const xf = x - Math.floor(x);
        const yf = y - Math.floor(y);

        const u = this.fade(xf);
        const v = this.fade(yf);

        const aa = this.p[this.p[X] + Y];
        const ab = this.p[this.p[X] + Y + 1];
        const ba = this.p[this.p[X + 1] + Y];
        const bb = this.p[this.p[X + 1] + Y + 1];

        const x1 = this.lerp(u, this.grad(aa, xf, yf), this.grad(ba, xf - 1, yf));
        const x2 = this.lerp(u, this.grad(ab, xf, yf - 1), this.grad(bb, xf - 1, yf - 1));

        return this.lerp(v, x1, x2);
    }

    fractal(x: number, y: number, octaves = 4, persistence = 0.5, lacunarity = 2.0): number {
        let total = 0;
        let frequency = 1;
        let amplitude = 1;
        let maxValue = 0;

        for (let i = 0; i < octaves; i++) {
            total += this.noise(x * frequency, y * frequency) * amplitude;
            maxValue += amplitude;
            amplitude *= persistence;
            frequency *= lacunarity;
        }

        return total / maxValue;
    }
}

export interface HeightfieldConfig {
    widthKm: number;
    heightKm: number;
    resolution: number; // grid cells across
    seed: number;
    octaves?: number;
    mountainScale?: number;
    seaLevelM?: number;
    islandMask?: boolean;
}

export interface HeightfieldResult {
    grid: number[][]; // [row][col] in meters
    resolution: number;
    minElevationM: number;
    maxElevationM: number;
    contours: ContourLine[];
}

/**
 * Generates procedural heightfield elevations and contour lines.
 */
export function generateHeightfield(config: HeightfieldConfig): HeightfieldResult {
    const res = config.resolution || 48;
    const noise = new Noise2D(config.seed);
    const mountainNoise = new Noise2D(config.seed + 101);
    const octaves = config.octaves || 5;
    const maxM = config.mountainScale || 2600;
    const seaLevel = config.seaLevelM || 0;
    const isIsland = config.islandMask !== false;

    const grid: number[][] = [];
    let minElev = Infinity;
    let maxElev = -Infinity;

    for (let r = 0; r < res; r++) {
        const row: number[] = [];
        const normY = (r / (res - 1)) * 2 - 1; // -1 to +1

        for (let c = 0; c < res; c++) {
            const normX = (c / (res - 1)) * 2 - 1; // -1 to +1

            // Base continental elevation noise
            const n1 = noise.fractal(normX * 1.5, normY * 1.5, octaves, 0.52, 2.1);
            // Sharp ridge noise for mountains
            const n2 = Math.abs(mountainNoise.fractal(normX * 3.0, normY * 3.0, 3, 0.45, 2.0));

            let heightNorm = (n1 + 1.0) * 0.5; // 0 to 1
            // Blend mountain ridges on high elevation
            if (heightNorm > 0.45) {
                heightNorm += n2 * 0.55 * (heightNorm - 0.45);
            }

            // Radial island falloff mask towards edges if island mode enabled
            if (isIsland) {
                const distFromCenter = Math.sqrt(normX * normX + normY * normY);
                const mask = Math.max(0, 1 - Math.pow(distFromCenter / 1.15, 2.2));
                heightNorm *= mask;
            }

            const elevM = Math.round(seaLevel + (heightNorm - 0.28) * maxM);
            row.push(elevM);

            if (elevM < minElev) minElev = elevM;
            if (elevM > maxElev) maxElev = elevM;
        }
        grid.push(row);
    }

    const contours = extractContoursFromGrid(grid, config.widthKm, config.heightKm);

    return {
        grid,
        resolution: res,
        minElevationM: minElev,
        maxElevationM: maxElev,
        contours,
    };
}

/**
 * Extracts elevation contour lines from an elevation grid.
 */
export function extractContoursFromGrid(
    grid: number[][],
    widthKm: number,
    heightKm: number
): ContourLine[] {
    const res = grid.length;
    let minElev = Infinity;
    let maxElev = -Infinity;
    for (let r = 0; r < res; r++) {
        for (let c = 0; c < res; c++) {
            const v = grid[r][c];
            if (v < minElev) minElev = v;
            if (v > maxElev) maxElev = v;
        }
    }

    const contourIntervalM = 300;
    const contours: ContourLine[] = [];
    const halfW = widthKm * 0.5;
    const halfH = heightKm * 0.5;

    for (let targetElev = Math.max(100, Math.ceil(minElev / contourIntervalM) * contourIntervalM); targetElev <= maxElev; targetElev += contourIntervalM) {
        // Marching segments along grid
        const points: [number, number][] = [];
        const stepX = widthKm / (res - 1);
        const stepY = heightKm / (res - 1);

        for (let r = 0; r < res - 1; r += 2) {
            for (let c = 0; c < res - 1; c += 2) {
                const e = grid[r][c];
                if (Math.abs(e - targetElev) < contourIntervalM * 0.55) {
                    const wx = -halfW + c * stepX;
                    const wy = halfH - r * stepY;
                    points.push([Number(wx.toFixed(2)), Number(wy.toFixed(2))]);
                }
            }
        }

        if (points.length >= 3) {
            // Altitude color from green to gold to grey/white
            const norm = (targetElev - 100) / (maxElev - 100 || 1);
            let color: [number, number, number, number] = [0.3, 0.7, 0.4, 0.4];
            if (norm > 0.7) {
                color = [0.85, 0.9, 0.95, 0.65]; // snowy white
            } else if (norm > 0.45) {
                color = [0.65, 0.6, 0.55, 0.5]; // rocky grey
            } else if (norm > 0.25) {
                color = [0.75, 0.7, 0.4, 0.45]; // highland gold
            }

            contours.push({
                elevation: targetElev,
                points,
                color,
            });
        }
    }

    return contours;
}

/**
 * Simulates hydraulic and thermal erosion on the heightfield.
 */
export function simulateErosion(
    grid: number[][],
    iterations = 250,
    rainfallStrength = 0.08
): number[][] {
    const rows = grid.length;
    const cols = grid[0].length;
    // Clone grid
    const out = grid.map((r) => [...r]);

    const rng = new PRNG(8821);

    for (let iter = 0; iter < iterations; iter++) {
        // Random droplet drop position
        let r = rng.int(2, rows - 3);
        let c = rng.int(2, cols - 3);
        let sediment = 0;

        for (let step = 0; step < 16; step++) {
            const currentElev = out[r][c];

            // Find lowest neighbor
            let lowestR = r;
            let lowestC = c;
            let lowestElev = currentElev;

            const neighbors = [
                [-1, 0], [1, 0], [0, -1], [0, 1],
                [-1, -1], [-1, 1], [1, -1], [1, 1],
            ];

            for (const [dr, dc] of neighbors) {
                const nr = r + dr;
                const nc = c + dc;
                if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
                    if (out[nr][nc] < lowestElev) {
                        lowestElev = out[nr][nc];
                        lowestR = nr;
                        lowestC = nc;
                    }
                }
            }

            const delta = currentElev - lowestElev;
            if (delta <= 0) {
                // Deposit sediment in local pit/basin
                out[r][c] += Math.round(sediment * 0.7);
                break;
            }

            // Erode portion of slope
            const eroded = Math.min(delta * 0.45, Math.round(rainfallStrength * 40));
            out[r][c] -= Math.round(eroded);
            sediment += eroded;

            r = lowestR;
            c = lowestC;
        }
    }

    return out;
}

/**
 * Procedurally generates natural river paths routing from high peaks to the sea.
 */
export function generateRivers(
    meta: WorldMetadata,
    grid: number[][],
    riverCount = 3
): WorldPath[] {
    const rows = grid.length;
    const cols = grid[0].length;
    const halfW = meta.worldWidthKm * 0.5;
    const halfH = meta.worldHeightKm * 0.5;
    const stepX = meta.worldWidthKm / (cols - 1);
    const stepY = meta.worldHeightKm / (rows - 1);

    const rivers: WorldPath[] = [];
    const rng = new PRNG(meta.seed + 333);

    for (let i = 0; i < riverCount; i++) {
        // Find a high elevation starting point (mountain ridge)
        let bestR = rng.int(5, rows - 6);
        let bestC = rng.int(5, cols - 6);
        let maxElev = -9999;

        for (let attempt = 0; attempt < 12; attempt++) {
            const tr = rng.int(5, rows - 6);
            const tc = rng.int(5, cols - 6);
            if (grid[tr][tc] > maxElev) {
                maxElev = grid[tr][tc];
                bestR = tr;
                bestC = tc;
            }
        }

        const riverPoints: [number, number][] = [];
        let r = bestR;
        let c = bestC;
        const visited = new Set<string>();

        for (let step = 0; step < 40; step++) {
            const key = `${r},${c}`;
            if (visited.has(key)) break;
            visited.add(key);

            const wx = Number((-halfW + c * stepX).toFixed(2));
            const wy = Number((halfH - r * stepY).toFixed(2));
            riverPoints.push([wx, wy]);

            // Reached sea level or boundary
            if (grid[r][c] <= meta.seaLevelM + 50 || r <= 1 || r >= rows - 2 || c <= 1 || c >= cols - 2) {
                break;
            }

            // Flow to lowest neighbor
            let lowestR = r;
            let lowestC = c;
            let lowestElev = grid[r][c];

            const neighbors = [
                [-1, 0], [1, 0], [0, -1], [0, 1],
                [-1, -1], [-1, 1], [1, -1], [1, 1],
            ];

            for (const [dr, dc] of neighbors) {
                const nr = r + dr;
                const nc = c + dc;
                if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
                    if (grid[nr][nc] < lowestElev) {
                        lowestElev = grid[nr][nc];
                        lowestR = nr;
                        lowestC = nc;
                    }
                }
            }

            if (lowestR === r && lowestC === c) {
                // Dig through minor local minimum toward nearest edge
                const dr = r > rows / 2 ? 1 : -1;
                const dc = c > cols / 2 ? 1 : -1;
                r = Math.max(1, Math.min(rows - 2, r + dr));
                c = Math.max(1, Math.min(cols - 2, c + dc));
            } else {
                r = lowestR;
                c = lowestC;
            }
        }

        if (riverPoints.length >= 4) {
            const riverNames = ["Silverflow", "Whispering Run", "Drakerush", "Frostmere River", "Serpent's Coil", "Misty Water"];
            rivers.push({
                id: `river_${i + 1}`,
                name: riverNames[i % riverNames.length],
                pathType: "river",
                points: riverPoints,
                width: 4.5,
                color: [0.22, 0.74, 0.97, 1.0],
                isMajor: true,
                flowSpeed: 1.8,
                surfaceQuality: 1.0,
                description: "A wide, fast-flowing river carved through the valleys to the ocean.",
            });
        }
    }

    return rivers;
}

/**
 * Procedurally places settlements (Capital, Cities, Towns, Villages) based on geography.
 */
export function generateSettlements(
    meta: WorldMetadata,
    grid: number[][],
    rivers: WorldPath[] = []
): { spots: WorldSpot[]; roads: WorldPath[] } {
    const rows = grid.length;
    const cols = grid[0].length;
    const halfW = meta.worldWidthKm * 0.5;
    const halfH = meta.worldHeightKm * 0.5;
    const stepX = meta.worldWidthKm / (cols - 1);
    const stepY = meta.worldHeightKm / (rows - 1);

    const rng = new PRNG(meta.seed + 777);
    const spots: WorldSpot[] = [];

    // Helper to evaluate geographic desirability (flat terrain + river proximity)
    const scoreCell = (r: number, c: number): number => {
        const elev = grid[r][c];
        if (elev < meta.seaLevelM + 10 || elev > 1800) return -100; // avoid underwater and jagged peaks

        // Flatness check (elevation variance around cell)
        let variance = 0;
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                variance += Math.abs(grid[r + dr][c + dc] - elev);
            }
        }
        let score = 100 - variance * 0.25;

        // Proximity to river bonus
        const wx = -halfW + c * stepX;
        const wy = halfH - r * stepY;
        for (const river of rivers) {
            for (const pt of river.points) {
                const dist = Math.sqrt(Math.pow(wx - pt[0], 2) + Math.pow(wy - pt[1], 2));
                if (dist < 2.5) {
                    score += 45; // fresh water access
                    break;
                }
            }
        }

        return score;
    };

    const settlementDefs: Array<{ name: string; type: SpotType; icon: string; isMajor: boolean; color: [number, number, number, number] }> = [
        { name: "Crown Citadel", type: "capital", icon: "crown", isMajor: true, color: [0.98, 0.75, 0.14, 1.0] },
        { name: "High Haven Port", type: "port", icon: "anchor", isMajor: true, color: [0.22, 0.74, 0.97, 1.0] },
        { name: "Stonehold Stronghold", type: "fortress", icon: "shield", isMajor: true, color: [0.6, 0.65, 0.75, 1.0] },
        { name: "Riverbend Town", type: "town", icon: "house", isMajor: false, color: [0.35, 0.8, 0.5, 1.0] },
        { name: "Oakhaven Village", type: "village", icon: "tree", isMajor: false, color: [0.45, 0.75, 0.4, 1.0] },
        { name: "Deepmine Outpost", type: "mine", icon: "pickaxe", isMajor: false, color: [0.8, 0.5, 0.3, 1.0] },
        { name: "Sunspire Shrine", type: "shrine", icon: "sun", isMajor: false, color: [0.7, 0.45, 0.95, 1.0] },
        { name: "Forgotten Barrow", type: "dungeon", icon: "skull", isMajor: false, color: [0.95, 0.25, 0.35, 1.0] },
    ];

    const placedCoords: [number, number][] = [];

    for (let i = 0; i < settlementDefs.length; i++) {
        const def = settlementDefs[i];
        let bestR = 5;
        let bestC = 5;
        let bestScore = -9999;

        // Sample candidate positions
        for (let attempt = 0; attempt < 25; attempt++) {
            const r = rng.int(4, rows - 5);
            const c = rng.int(4, cols - 5);
            const wx = -halfW + c * stepX;
            const wy = halfH - r * stepY;

            // Enforce minimum distance from already placed settlements
            let tooClose = false;
            for (const pc of placedCoords) {
                const dist = Math.sqrt(Math.pow(wx - pc[0], 2) + Math.pow(wy - pc[1], 2));
                if (dist < 4.0) {
                    tooClose = true;
                    break;
                }
            }
            if (tooClose) continue;

            const score = scoreCell(r, c) + rng.range(-15, 15);
            if (score > bestScore) {
                bestScore = score;
                bestR = r;
                bestC = c;
            }
        }

        const wx = Number((-halfW + bestC * stepX).toFixed(2));
        const wy = Number((halfH - bestR * stepY).toFixed(2));
        placedCoords.push([wx, wy]);

        spots.push({
            id: `spot_${i + 1}`,
            name: def.name,
            spotType: def.type,
            x: wx,
            y: wy,
            elevation: grid[bestR][bestC],
            color: def.color,
            icon: def.icon,
            tags: [def.type, def.isMajor ? "major-hub" : "local-point"],
            isMajor: def.isMajor,
            description: `A vital ${def.type} strategically established on natural terrain.`,
            loreNotes: "Documented in realm chronicles.",
            conceptPrompt: `High fantasy landscape concept art of ${def.name}, ${def.type} overlooking hills, cinematic lighting, 8k resolution`,
            linkedCodexIds: [],
            linkedMissionIds: [],
        });
    }

    // Connect settlements with primary highway and regional roads
    const roads: WorldPath[] = [];
    if (spots.length >= 3) {
        // Highway connecting major hubs (Capital to Port to Fortress)
        const majorSpots = spots.filter((s) => s.isMajor);
        if (majorSpots.length >= 2) {
            const highwayPts: [number, number][] = majorSpots.map((s) => [s.x, s.y]);
            roads.push({
                id: "road_highway_1",
                name: "The King's Royal Highway",
                pathType: "highway",
                points: highwayPts,
                width: 5.0,
                color: [0.98, 0.75, 0.14, 1.0],
                isMajor: true,
                flowSpeed: 0,
                surfaceQuality: 0.8,
                description: "Paved stone highway connecting major administrative capitals and ports.",
            });
        }

        // Secondary trade route connecting remaining towns
        const minorSpots = spots.filter((s) => !s.isMajor);
        if (minorSpots.length >= 2) {
            const tradeRoutePts: [number, number][] = [
                [spots[0].x, spots[0].y],
                [minorSpots[0].x, minorSpots[0].y],
                [minorSpots[1].x, minorSpots[1].y],
            ];
            roads.push({
                id: "road_trade_1",
                name: "Eastern Merchant Track",
                pathType: "road",
                points: tradeRoutePts,
                width: 3.5,
                color: [0.75, 0.65, 0.5, 1.0],
                isMajor: false,
                flowSpeed: 0,
                surfaceQuality: 1.0,
                description: "Cobblestone and packed-earth road frequented by traveling merchants.",
            });
        }
    }

    return { spots, roads };
}

/**
 * Scatters thematic points of interest (ruins, monster dens, resource nodes).
 */
export function scatterPointsOfInterest(
    meta: WorldMetadata,
    existingSpots: WorldSpot[],
    scatterCount = 4
): WorldSpot[] {
    const rng = new PRNG(meta.seed + 999);
    const halfW = meta.worldWidthKm * 0.45;
    const halfH = meta.worldHeightKm * 0.45;

    const templates = [
        { name: "Sunken Monolith", type: "ruin" as SpotType, icon: "spark", color: [0.65, 0.5, 0.85, 1.0] as [number, number, number, number] },
        { name: "Wyrm's Crag", type: "boss" as SpotType, icon: "sword", color: [0.95, 0.25, 0.35, 1.0] as [number, number, number, number] },
        { name: "Crystal Hollow", type: "mine" as SpotType, icon: "gem", color: [0.35, 0.85, 0.95, 1.0] as [number, number, number, number] },
        { name: "Bandit Encampment", type: "camp" as SpotType, icon: "tent", color: [0.85, 0.5, 0.2, 1.0] as [number, number, number, number] },
    ];

    const newSpots: WorldSpot[] = [];

    for (let i = 0; i < scatterCount; i++) {
        const t = templates[i % templates.length];
        const x = Number(rng.range(-halfW, halfW).toFixed(2));
        const y = Number(rng.range(-halfH, halfH).toFixed(2));

        newSpots.push({
            id: `scatter_${existingSpots.length + i + 1}`,
            name: `${t.name} #${i + 1}`,
            spotType: t.type,
            x,
            y,
            elevation: Math.round(rng.range(150, 950)),
            color: t.color,
            icon: t.icon,
            tags: ["scattered", t.type],
            isMajor: false,
            dangerLevel: rng.int(1, 10),
            description: `An isolated ${t.type} scattered throughout the wilderness.`,
            loreNotes: "Awaiting exploration.",
            linkedCodexIds: [],
            linkedMissionIds: [],
        });
    }

    return newSpots;
}
