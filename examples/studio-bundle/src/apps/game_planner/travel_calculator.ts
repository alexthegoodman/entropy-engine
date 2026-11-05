import { sampleTerrain } from "./terrain";
import type {
    BiomeType,
    TerrainGrid,
    WorldMetadata,
    PathType,
    TravelEstimate,
    TravelMode,
    TravelModeEstimate,
    WorldPath,
    WorldRegion,
    WorldSpot,
} from "./planner_types";

// Base travel speeds in km/h
export const BASE_SPEEDS: Record<TravelMode, { label: string; speedKmH: number }> = {
    foot: { label: "On Foot (March)", speedKmH: 4.5 },
    mount: { label: "Mounted (Horse)", speedKmH: 24.0 },
    vehicle: { label: "Carriage / Cart", speedKmH: 15.0 },
    water: { label: "River / Sailing Ship", speedKmH: 18.0 },
    air: { label: "Flying Mount / Airship", speedKmH: 80.0 },
};

// Surface impedance modifiers
export const SURFACE_MODIFIERS: Record<PathType, number> = {
    highway: 0.8,  // paved stone highway is 25% faster
    road: 1.0,     // normal dirt road baseline
    trail: 1.35,   // winding forest trail is slower
    bridge: 0.9,   // quick bridge crossing
    river: 1.0,    // water route
};

// Biome impedance modifiers (when travelling off-road)
export const BIOME_MODIFIERS: Record<BiomeType, number> = {
    plains: 1.25,
    coastal: 1.35,
    savanna: 1.3,
    forest: 1.7,
    taiga: 1.8,
    badlands: 2.1,
    desert: 2.3,
    alpine: 2.7,
    tundra: 2.5,
    jungle: 2.9,
    swamp: 3.3,
    volcanic: 3.0,
};

export function euclideanDistanceKm(
    p1: [number, number] | number,
    p2: [number, number] | number,
    x2?: number,
    y2?: number
): number {
    if (typeof p1 === "number" && typeof p2 === "number" && typeof x2 === "number" && typeof y2 === "number") {
        const dx = x2 - p1;
        const dy = y2 - p2;
        return Math.sqrt(dx * dx + dy * dy);
    }
    const pt1 = p1 as [number, number];
    const pt2 = p2 as [number, number];
    const dx = pt2[0] - pt1[0];
    const dy = pt2[1] - pt1[1];
    return Math.sqrt(dx * dx + dy * dy);
}

export function pathPolylineLengthKm(points: [number, number][]): number {
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
        total += euclideanDistanceKm(points[i], points[i + 1]);
    }
    return total;
}

export function formatDuration(totalHours: number): string {
    const totalMinutes = Math.round(totalHours * 60);
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;

    if (days > 0) {
        return `${days}d ${hours}h`;
    }
    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

/**
 * Calculates in-game Time-to-Travel between two world coordinates or spots.
 * Supports road path discovery, surface bonuses, and multi-modal speed estimates.
 */
/** Climb, descent and water along the straight line from `a` to `b`, sampled every 100 m. */
export function terrainProfile(
    terrain: TerrainGrid,
    meta: Pick<WorldMetadata, "worldWidthKm" | "worldHeightKm">,
    a: [number, number],
    b: [number, number]
): { climbM: number; descentM: number; waterKm: number; startM: number; endM: number } {
    const dist = euclideanDistanceKm(a, b);
    const n = Math.max(1, Math.ceil(dist / 0.1));
    let climb = 0, descent = 0, water = 0;
    let prev = sampleTerrain(terrain, meta, a[0], a[1]);
    const start = prev;
    for (let i = 1; i <= n; i++) {
        const f = i / n;
        const e = sampleTerrain(terrain, meta, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
        if (e > prev) climb += e - prev;
        else descent += prev - e;
        if (e <= terrain.seaLevelM) water += dist / n;
        prev = e;
    }
    return { climbM: Math.round(climb), descentM: Math.round(descent), waterKm: Number(water.toFixed(2)), startM: Math.round(start), endM: Math.round(prev) };
}

export function calculateTravelTime(
    from: [number, number] | WorldSpot,
    to: [number, number] | WorldSpot,
    paths: WorldPath[] = [],
    regions: WorldRegion[] = [],
    terrainCtx?: { terrain: TerrainGrid; meta: Pick<WorldMetadata, "worldWidthKm" | "worldHeightKm"> }
): TravelEstimate {
    const p1: [number, number] = Array.isArray(from) ? from : [from.x, from.y];
    const p2: [number, number] = Array.isArray(to) ? to : [to.x, to.y];

    const directDistKm = euclideanDistanceKm(p1, p2);

    // Check if there is an existing path that closely connects p1 and p2
    let bestPathDistKm = directDistKm;
    let pathFound = false;
    let pathSurfaceBonus = 1.0;

    for (const path of paths) {
        if (path.points.length < 2) continue;
        const start = path.points[0];
        const end = path.points[path.points.length - 1];

        // Check forward and reverse connection within tolerance (1.5 km)
        const dStart1 = euclideanDistanceKm(p1, start);
        const dEnd2 = euclideanDistanceKm(p2, end);
        const dStart2 = euclideanDistanceKm(p1, end);
        const dEnd1 = euclideanDistanceKm(p2, start);

        if ((dStart1 < 1.5 && dEnd2 < 1.5) || (dStart2 < 1.5 && dEnd1 < 1.5)) {
            const roadLen = pathPolylineLengthKm(path.points);
            bestPathDistKm = roadLen + Math.min(dStart1 + dEnd2, dStart2 + dEnd1);
            pathFound = true;
            pathSurfaceBonus = SURFACE_MODIFIERS[path.pathType] ?? 1.0;
            break;
        }
    }

    // Determine regional terrain difficulty multiplier if traveling off-road
    let terrainMult = 1.4; // default open terrain off-road
    if (pathFound) {
        terrainMult = pathSurfaceBonus;
    } else {
        // Average region biome difficulty between p1 and p2 midpoint
        const mid: [number, number] = [(p1[0] + p2[0]) * 0.5, (p1[1] + p2[1]) * 0.5];
        for (const reg of regions) {
            if (isPointInsidePolygon(mid, reg.points)) {
                terrainMult = BIOME_MODIFIERS[reg.dominantBiome] ?? 1.5;
                break;
            }
        }
    }

    // Climbing: with terrain, the real ups and downs along the way (off-road); otherwise the
    // difference between the two spots' elevations.
    let profile: ReturnType<typeof terrainProfile> | undefined;
    if (terrainCtx) {
        profile = terrainProfile(terrainCtx.terrain, terrainCtx.meta, p1, p2);
        if (!pathFound) terrainMult += (profile.climbM / 1000) * 0.6 + (profile.descentM / 1000) * 0.2;
    } else {
        let elevationDeltaM = 0;
        if (!Array.isArray(from) && !Array.isArray(to)) {
            elevationDeltaM = Math.abs(from.elevation - to.elevation);
        }
        if (elevationDeltaM > 200) {
            terrainMult += (elevationDeltaM / 1000) * 0.35; // +35% per 1000 m climb
        }
    }

    const effectiveDistKm = (pathFound ? bestPathDistKm : directDistKm) * terrainMult;

    const estimates: Record<TravelMode, TravelModeEstimate> = {} as any;

    (Object.keys(BASE_SPEEDS) as TravelMode[]).forEach((mode) => {
        const info = BASE_SPEEDS[mode];
        // Air ignores terrain surface multiplier; water requires water paths or is penalized
        let speed = info.speedKmH;
        let actualDist = directDistKm;

        if (mode === "air") {
            actualDist = directDistKm; // air travels straight line
        } else if (mode === "water") {
            actualDist = pathFound ? bestPathDistKm : directDistKm * 1.6;
        } else {
            actualDist = effectiveDistKm;
        }

        const totalHours = actualDist / speed;
        const hours = Math.floor(totalHours);
        const minutes = Math.round((totalHours - hours) * 60);
        const formattedTime = formatDuration(totalHours);

        estimates[mode] = {
            mode,
            label: info.label,
            speedKmH: speed,
            hours,
            minutes,
            formattedTime,
        };
    });

    const crossesWater = !!profile && profile.waterKm > 0.05 && !pathFound;
    const summaryText = `Foot: ${estimates.foot.formattedTime} | Horse: ${estimates.mount.formattedTime} | Air: ${estimates.air.formattedTime}${crossesWater ? ` | crosses ${profile!.waterKm} km of water` : ""}`;

    return {
        distanceKm: Number(effectiveDistKm.toFixed(2)),
        directDistanceKm: Number(directDistKm.toFixed(2)),
        pathFound,
        difficultyMultiplier: Number(terrainMult.toFixed(2)),
        estimates,
        summaryText,
        ...(profile ? { climbM: profile.climbM, descentM: profile.descentM, waterKm: profile.waterKm } : {}),
    };
}

export function isPointInsidePolygon(point: [number, number], polygon: [number, number][]): boolean {
    if (polygon.length < 3) return false;
    let inside = false;
    const [x, y] = point;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i];
        const [xj, yj] = polygon[j];
        const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

/**
 * Calculates travel metrics across a multi-waypoint path.
 */
export function calculateRouteTravelTime(
    waypoints: Array<{ x: number; y: number; elevation?: number; elevationM?: number }>,
    mode: TravelMode = "foot",
    surfaceType: PathType = "road"
): { distanceKm: number; durationHours: number; formattedDuration: string } {
    let totalDist = 0;
    let totalHours = 0;
    const speed = BASE_SPEEDS[mode]?.speedKmH ?? 4.5;
    const modifier = SURFACE_MODIFIERS[surfaceType] ?? 1.0;

    for (let i = 0; i < waypoints.length - 1; i++) {
        const w1 = waypoints[i];
        const w2 = waypoints[i + 1];
        const dist = euclideanDistanceKm([w1.x, w1.y], [w2.x, w2.y]);
        totalDist += dist;

        const elev1 = w1.elevation ?? w1.elevationM ?? 0;
        const elev2 = w2.elevation ?? w2.elevationM ?? 0;
        const elevDelta = Math.abs(elev1 - elev2);
        let slopeFactor = 1.0;
        if (elevDelta > 100) {
            slopeFactor += (elevDelta / 1000) * 0.35;
        }

        totalHours += (dist * modifier * slopeFactor) / speed;
    }

    return {
        distanceKm: Number(totalDist.toFixed(2)),
        durationHours: Number(totalHours.toFixed(2)),
        formattedDuration: formatDuration(totalHours),
    };
}
