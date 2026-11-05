// The built-in Planner Agent: turns a design intent into a revision proposal using the world's own
// terrain, so the intent -> proposal -> review loop works without any external model. Settlements
// go where the land suits them and get roads routed over it; danger zones get a region and a lair
// in their most remote high ground; pacing intents get roads (to speed a journey up) or a moved
// endpoint (to stretch it out), checked with the same travel model the map's ruler uses.
//
// Freeform intents need an LLM: the agent says so, and the designer hands the brief to one.
//
// Also here: `normalizeProposalChanges`, which fills in and validates what an external agent sends
// over MCP, so an agent can say `add_spot { name, spotType, x, y }` and get a complete spot.

import type {
    BiomeType,
    CodexCategory,
    GameWorld,
    GenreType,
    Mission,
    PathType,
    PlanIntent,
    RegionType,
    RevisionChange,
    RevisionChangeType,
    RevisionProposal,
    SpotType,
    WorldPath,
    WorldRegion,
    WorldSpot,
} from "./planner_types";
import {
    BIOMES,
    BIOME_COLORS,
    DANGER_COLORS,
    PATH_DEFAULTS,
    PATH_TYPES,
    REGION_TYPES,
    SPOT_COLORS,
    SPOT_TYPES,
    capitalize,
    isMajorSpotType,
} from "./planner_defaults";
import {
    effectiveParams,
    evaluateIntent,
    intentCentroid,
    intentPoints,
    isSettlement,
    pinRadiusKm,
    polygonAreaKm2,
    roadJoining,
    spotsInIntent,
    travelMinutes,
} from "./intent_model";
import { routeOverTerrain } from "./procedural_tools";
import { computeDrainage, gridToWorld, PRNG, sampleSlopeDeg, sampleTerrain } from "./terrain";
import { formatDuration, isPointInsidePolygon, pathPolylineLengthKm } from "./travel_calculator";
import { createMission } from "./story_model";
import { createCodexEntry } from "./codex_model";

export const PLANNER_AGENT_NAME = "Planner Agent";

export interface DraftResult {
    proposal: RevisionProposal | null;
    /** Why there is no proposal, or what the proposal does, in one line. */
    reason: string;
}

// -------------------------------------------------------------------------------------------------
// Names
// -------------------------------------------------------------------------------------------------

const NAME_PARTS: Record<"fantasy" | "scifi" | "cyberpunk" | "postapoc", { a: string[]; b: string[] }> = {
    fantasy: {
        a: ["Ash", "Bram", "Thorn", "Wil", "Elder", "Mist", "Raven", "Stone", "Fern", "Gold", "Hollow", "Briar", "Marrow", "Wren", "Cold", "Sedge"],
        b: ["ford", "wick", "holm", "mere", "stead", "vale", "crest", "by", "brook", "moor", "hythe", "reach", "fell", "wold"],
    },
    scifi: {
        a: ["Kepler", "Rho", "Vesta", "Ares", "Tycho", "Halcyon", "Io", "Cassini", "Nadir", "Zenith", "Orin", "Deimos"],
        b: [" Outpost", " Station", " Dome", " Relay", " Habitat", " Spur", " Array", " Landing", " Yard"],
    },
    cyberpunk: {
        a: ["Neon", "Grid", "Chrome", "Hex", "Static", "Vapor", "Kilo", "Sable", "Glitch", "Night", "Wire", "Ion"],
        b: [" Block", " Spire", " Arcology", " Market", " Stack", " Row", " Commons", " Yard", " Heights"],
    },
    postapoc: {
        a: ["Rust", "Ash", "Cinder", "Dust", "Scrap", "Bone", "Salt", "Ember", "Tin", "Grit"],
        b: ["town", " Hold", " Camp", " Crossing", " Wells", "yard", " Bunker", " Ridge", " Flats"],
    },
};

function partsFor(genre: GenreType) {
    if (genre === "scifi") return NAME_PARTS.scifi;
    if (genre === "cyberpunk") return NAME_PARTS.cyberpunk;
    if (genre === "postapoc") return NAME_PARTS.postapoc;
    return NAME_PARTS.fantasy;
}

const LAIR_NAMES: Record<SpotType, string[]> = {
    dungeon: ["Hollow Deep", "Sunken Vault", "Blackroot Crypt", "Weeping Catacombs", "Drowned Halls"],
    boss: ["Wyrm's Throne", "The Maw", "Ironjaw's Den", "Crown of Thorns", "The Ashen Seat"],
    camp: ["Cutthroat Camp", "Raider Roost", "Wolfpack Hollow", "Smugglers' Rest"],
    ruin: ["Fallen Spire", "Broken Aqueduct", "Old Watch", "Shattered Chapel"],
} as Record<SpotType, string[]>;

/** A name not already on the map, deterministic for a seed. */
export function generatePlaceName(world: GameWorld, rng: PRNG, spotType: SpotType): string {
    const taken = new Set(world.spots.map((s) => s.name.toLowerCase()));
    const pool = LAIR_NAMES[spotType];
    for (let attempt = 0; attempt < 40; attempt++) {
        let name: string;
        if (pool && attempt < 10) {
            name = pool[Math.floor(rng.next() * pool.length)];
        } else {
            const { a, b } = partsFor(world.meta.genre);
            name = a[Math.floor(rng.next() * a.length)] + b[Math.floor(rng.next() * b.length)];
            if (spotType === "port" && world.meta.genre === "fantasy") name += " Harbor";
            if (spotType === "fortress" && world.meta.genre === "fantasy") name += " Keep";
            if (spotType === "mine") name += " Mine";
            if (spotType === "shrine") name = `Shrine of ${name}`;
        }
        if (!taken.has(name.toLowerCase())) return name;
    }
    return `${capitalize(spotType)} ${world.spots.length + 1}`;
}

// -------------------------------------------------------------------------------------------------
// Building blocks
// -------------------------------------------------------------------------------------------------

let uidCounter = 0;
const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(uidCounter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const r2 = (v: number) => Math.round(v * 100) / 100;

export function makeSpot(world: GameWorld, fields: Partial<WorldSpot> & Pick<WorldSpot, "name" | "spotType" | "x" | "y">): Omit<WorldSpot, "id"> {
    const type = SPOT_TYPES.includes(fields.spotType) ? fields.spotType : "landmark";
    const t = world.terrain;
    const x = r2(Number(fields.x));
    const y = r2(Number(fields.y));
    return {
        name: String(fields.name),
        spotType: type,
        x,
        y,
        elevation: fields.elevation !== undefined ? Math.round(Number(fields.elevation)) : t ? Math.round(sampleTerrain(t, world.meta, x, y)) : 100,
        color: fields.color ?? SPOT_COLORS[type],
        icon: fields.icon ?? type,
        tags: Array.isArray(fields.tags) ? fields.tags.map(String) : [type],
        isMajor: fields.isMajor ?? isMajorSpotType(type),
        dangerLevel: fields.dangerLevel ?? (type === "boss" ? 9 : type === "dungeon" ? 7 : type === "camp" ? 4 : 1),
        description: String(fields.description ?? ""),
        loreNotes: String(fields.loreNotes ?? ""),
        ...(fields.conceptPrompt ? { conceptPrompt: String(fields.conceptPrompt) } : {}),
        linkedCodexIds: Array.isArray(fields.linkedCodexIds) ? fields.linkedCodexIds : [],
        linkedMissionIds: Array.isArray(fields.linkedMissionIds) ? fields.linkedMissionIds : [],
    };
}

export function makePath(fields: Partial<WorldPath> & Pick<WorldPath, "name" | "points">): Omit<WorldPath, "id"> {
    const type: PathType = PATH_TYPES.includes(fields.pathType as PathType) ? (fields.pathType as PathType) : "road";
    const d = PATH_DEFAULTS[type];
    return {
        name: String(fields.name),
        pathType: type,
        points: fields.points.map(([x, y]) => [Number(x), Number(y)] as [number, number]),
        width: fields.width ?? d.width,
        color: fields.color ?? d.color,
        isMajor: fields.isMajor ?? d.isMajor,
        flowSpeed: fields.flowSpeed ?? d.flowSpeed,
        surfaceQuality: fields.surfaceQuality ?? d.surfaceQuality,
        description: String(fields.description ?? ""),
    };
}

export function makeRegion(fields: Partial<WorldRegion> & Pick<WorldRegion, "name" | "points">): Omit<WorldRegion, "id"> {
    const regionType: RegionType = REGION_TYPES.includes(fields.regionType as RegionType) ? (fields.regionType as RegionType) : "biome";
    const biome: BiomeType = BIOMES.includes(fields.dominantBiome as BiomeType) ? (fields.dominantBiome as BiomeType) : "plains";
    const colors = regionType === "danger" ? DANGER_COLORS : BIOME_COLORS[biome];
    return {
        name: String(fields.name),
        regionType,
        points: fields.points.map(([x, y]) => [Number(x), Number(y)] as [number, number]),
        fillColor: fields.fillColor ?? colors.fill,
        borderColor: fields.borderColor ?? colors.border,
        isMajor: fields.isMajor ?? true,
        dominantBiome: biome,
        dangerLevel: Math.max(1, Math.min(10, Math.round(Number(fields.dangerLevel ?? 3)))),
        ...(fields.controllingFactionId ? { controllingFactionId: fields.controllingFactionId } : {}),
        description: String(fields.description ?? ""),
    };
}

/** A road over the land between two points (straight, with a midpoint, without terrain). */
function roadBetween(world: GameWorld, a: [number, number], b: [number, number]): [number, number][] {
    const t = world.terrain;
    if (t) return routeOverTerrain(t, world.meta, a, b);
    return [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b];
}

interface Candidate {
    x: number;
    y: number;
    e: number;
    slope: number;
    wet: number;
    coast: boolean;
}

/** Terrain cells inside a polygon (or a fallback lattice without terrain), on land. */
function landCandidates(world: GameWorld, poly: [number, number][]): Candidate[] {
    const t = world.terrain;
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const out: Candidate[] = [];
    if (!t) {
        for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) {
            const x = x0 + ((x1 - x0) * i) / 20;
            const y = y0 + ((y1 - y0) * j) / 20;
            if (isPointInsidePolygon([x, y], poly)) out.push({ x, y, e: 100, slope: 0, wet: 0, coast: false });
        }
        return out;
    }
    const drainage = computeDrainage(t);
    const { cols, rows, data } = t;
    const sea = t.seaLevelM;
    const riverPts = world.paths.filter((p) => p.pathType === "river").flatMap((p) => p.points);
    for (let r = 1; r < rows - 1; r++) {
        for (let c = 1; c < cols - 1; c++) {
            const [x, y] = gridToWorld(t, world.meta, c, r);
            if (x < x0 || x > x1 || y < y0 || y > y1 || !isPointInsidePolygon([x, y], poly)) continue;
            const i = r * cols + c;
            const e = data[i];
            if (e <= sea + 2) continue;
            const coast = data[i - 1] <= sea || data[i + 1] <= sea || data[i - cols] <= sea || data[i + cols] <= sea;
            const nearRiver = riverPts.some(([rx, ry]) => Math.hypot(rx - x, ry - y) < 0.8);
            out.push({ x, y, e, slope: sampleSlopeDeg(t, world.meta, x, y), wet: Math.log1p(drainage.accumulation[i]) + (nearRiver ? 3 : 0), coast });
        }
    }
    return out;
}

/** Nearest land to a point within `radiusKm` (the point itself when it is land). */
function nearestLand(world: GameWorld, p: [number, number], radiusKm: number): [number, number] | null {
    const t = world.terrain;
    if (!t || sampleTerrain(t, world.meta, p[0], p[1]) > t.seaLevelM + 1) return p;
    for (let ring = 1; ring <= 12; ring++) {
        const rr = (radiusKm * ring) / 12;
        for (let k = 0; k < 16; k++) {
            const a = (k / 16) * Math.PI * 2;
            const q: [number, number] = [p[0] + Math.cos(a) * rr, p[1] + Math.sin(a) * rr];
            if (sampleTerrain(t, world.meta, q[0], q[1]) > t.seaLevelM + 1) return q;
        }
    }
    return null;
}

function inWorld(world: GameWorld, p: [number, number]): boolean {
    const hw = world.meta.worldWidthKm * 0.48;
    const hh = world.meta.worldHeightKm * 0.48;
    return Math.abs(p[0]) <= hw && Math.abs(p[1]) <= hh;
}

function change(changeType: RevisionChangeType, title: string, summary: string, after: any, targetId?: string, before?: any): RevisionChange {
    const prefix = changeType.startsWith("add_") ? changeType.slice(4) : "chg";
    return {
        id: uid("chg"),
        changeType,
        targetId: targetId ?? uid(prefix),
        title,
        summary,
        ...(before !== undefined ? { before } : {}),
        after,
        status: "pending",
    };
}

function proposal(intent: PlanIntent, motivation: string, changes: RevisionChange[], agentName: string): RevisionProposal {
    return { id: uid("proposal"), agentName, timestamp: Date.now(), motivation, changes, intentId: intent.id };
}

// -------------------------------------------------------------------------------------------------
// Per-kind drafting
// -------------------------------------------------------------------------------------------------

function draftSettle(world: GameWorld, intent: PlanIntent, rng: PRNG, agentName: string): DraftResult {
    const p = effectiveParams(intent);
    const poly = intentPoints(world, intent);
    if (poly.length < 3) return { proposal: null, reason: "A settle intent needs an area." };
    const want = Math.max(1, Math.min(12, p.count ?? 3));
    const existingInside = spotsInIntent(world, intent).filter((s) => (p.spotType && !isSettlement(p.spotType) ? s.spotType === p.spotType : isSettlement(s.spotType))).length;
    const need = want - existingInside;
    if (need <= 0) return { proposal: null, reason: `Already ${existingInside} here - nothing to add.` };
    const cands = landCandidates(world, poly);
    if (!cands.length) return { proposal: null, reason: "No dry land inside this area to build on." };

    const area = polygonAreaKm2(poly);
    const spacing = Math.max(0.5, Math.sqrt(area / want) * 0.55);
    const t = world.terrain;
    const sea = t?.seaLevelM ?? 0;
    const maxLand = Math.max(sea + 1, t?.maxM ?? 1000);
    const wantsCoast = p.spotType === "port";
    const placed: Array<[number, number]> = world.spots.map((s) => [s.x, s.y]);
    const minFromExisting = spacing * 0.7;
    const chosen: Candidate[] = [];
    for (let k = 0; k < need; k++) {
        let best: Candidate | null = null;
        let bestScore = -Infinity;
        for (const c of cands) {
            let near = Infinity;
            for (const [px, py] of placed) near = Math.min(near, Math.hypot(px - c.x, py - c.y));
            const fromNew = chosen.reduce((m, q) => Math.min(m, Math.hypot(q.x - c.x, q.y - c.y)), Infinity);
            if (fromNew < spacing || near < minFromExisting) continue;
            if (wantsCoast && !c.coast) continue;
            const rel = (c.e - sea) / (maxLand - sea);
            const s = 40 - c.slope * 3.5 - Math.abs(rel - 0.08) * 110 + c.wet * 3.5 + (c.coast ? 6 : 0) + Math.min(fromNew, spacing * 2) * 2 + rng.range(-3, 3);
            if (s > bestScore) {
                bestScore = s;
                best = c;
            }
        }
        if (!best) break;
        chosen.push(best);
        placed.push([best.x, best.y]);
    }
    if (!chosen.length) return { proposal: null, reason: "The area is too small or crowded for more places at this spacing." };

    const changes: RevisionChange[] = [];
    const newSpots: Array<{ id: string; x: number; y: number; name: string }> = [];
    chosen.forEach((c, k) => {
        const type: SpotType = p.spotType ?? (want >= 3 && k === 0 && existingInside === 0 ? "town" : "village");
        const name = generatePlaceName({ ...world, spots: [...world.spots, ...newSpots.map((s) => ({ name: s.name } as WorldSpot))] }, rng, type);
        const ground = c.coast ? "on the coast" : c.slope < 4 ? "on level ground" : "on a sheltered slope";
        const spot = makeSpot(world, {
            name,
            spotType: type,
            x: c.x,
            y: c.y,
            tags: [type, "planned", `intent-${intent.number}`],
            description: `A ${type} ${ground}${c.wet > 6 ? " by fresh water" : ""}, sited for intent #${intent.number}${intent.directive ? `: ${intent.directive}` : "."}`,
        });
        const ch = change("add_spot", `Add ${type} ${name}`, `${capitalize(type)} at [${spot.x}, ${spot.y}] km, ${spot.elevation} m, slope ${c.slope.toFixed(0)}°.`, spot);
        changes.push(ch);
        newSpots.push({ id: ch.targetId, x: spot.x, y: spot.y, name });
    });

    // Roads: each new place to its nearest neighbor already on the map (or placed before it).
    const hubs: Array<{ x: number; y: number; name: string }> = world.spots.filter((s) => isSettlement(s.spotType)).map((s) => ({ x: s.x, y: s.y, name: s.name }));
    const reach = Math.min(world.meta.worldWidthKm, world.meta.worldHeightKm) * 0.45;
    for (const s of newSpots) {
        const pool = hubs.length ? hubs : newSpots.filter((o) => o !== s);
        if (!pool.length) {
            hubs.push(s);
            continue;
        }
        const nearest = pool.reduce((a, b) => (Math.hypot(a.x - s.x, a.y - s.y) <= Math.hypot(b.x - s.x, b.y - s.y) ? a : b));
        const d = Math.hypot(nearest.x - s.x, nearest.y - s.y);
        if (d > 0.05 && d <= reach) {
            const pts = roadBetween(world, [nearest.x, nearest.y], [s.x, s.y]);
            const path = makePath({ name: `${s.name} Road`, pathType: "road", points: pts, description: `Road from ${nearest.name} to ${s.name}, routed around steep ground.` });
            changes.push(change("add_path", `Road ${nearest.name} → ${s.name}`, `${pathPolylineLengthKm(pts).toFixed(1)} km road over the land.`, path));
        }
        hubs.push(s);
    }
    const short = chosen.length < need ? ` (only ${chosen.length} of ${need} fit at this spacing)` : "";
    return {
        proposal: proposal(intent, `Intent #${intent.number} asks for ${want} ${p.spotType ?? "settlement"}(s) here; ${existingInside} exist. Sited on dry, gentle, well-watered ground${short}, with roads to the nearest neighbors.`, changes, agentName),
        reason: `${chosen.length} place(s) and ${changes.length - chosen.length} road(s)${short}.`,
    };
}

function draftDanger(world: GameWorld, intent: PlanIntent, rng: PRNG, agentName: string): DraftResult {
    const p = effectiveParams(intent);
    const poly = intentPoints(world, intent);
    if (poly.length < 3) return { proposal: null, reason: "A danger intent needs an area." };
    const level = Math.max(1, Math.min(10, p.dangerLevel ?? 7));
    const c = intentCentroid(world, intent);
    const changes: RevisionChange[] = [];

    const covering = world.regions.find((r) => r.regionType === "danger" && isPointInsidePolygon(c, r.points));
    const biome: BiomeType = p.biome ?? world.regions.find((r) => r.regionType === "biome" && isPointInsidePolygon(c, r.points))?.dominantBiome ?? "badlands";
    const baseName = intent.title && !/^make this area dangerous$/i.test(intent.title) ? intent.title : `The ${capitalize(biome === "swamp" ? "drowned" : biome === "alpine" ? "high" : "blighted")} ${biome === "forest" ? "Wood" : biome === "swamp" ? "Fens" : "Wastes"}`;
    if (covering && covering.dangerLevel < level) {
        changes.push(change("modify_region", `Raise ${covering.name} to threat ${level}`, `From threat ${covering.dangerLevel} to ${level}.`, { dangerLevel: level }, covering.id, { dangerLevel: covering.dangerLevel }));
    } else if (!covering) {
        const region = makeRegion({
            name: baseName,
            regionType: "danger",
            points: poly,
            dominantBiome: biome,
            dangerLevel: level,
            description: intent.directive || `A hostile zone, threat level ${level}.`,
        });
        changes.push(change("add_region", `Mark ${baseName} as dangerous`, `Danger zone, threat ${level}/10, ${polygonAreaKm2(poly).toFixed(1)} km².`, region));
    }

    const hasLair = spotsInIntent(world, intent).some((s) => ["dungeon", "boss", "camp"].includes(s.spotType) && (s.dangerLevel ?? 0) >= level);
    if (!hasLair) {
        const cands = landCandidates(world, poly);
        const settlements = world.spots.filter((s) => isSettlement(s.spotType));
        const t = world.terrain;
        const sea = t?.seaLevelM ?? 0;
        const maxLand = Math.max(sea + 1, t?.maxM ?? 1000);
        let best: Candidate | null = null;
        let bestScore = -Infinity;
        for (const q of cands) {
            const far = settlements.reduce((m, s) => Math.min(m, Math.hypot(s.x - q.x, s.y - q.y)), 25);
            const s = Math.min(far, 25) * 2 + ((q.e - sea) / (maxLand - sea)) * 20 + q.slope * 0.3 + rng.range(0, 1.5);
            if (s > bestScore) {
                bestScore = s;
                best = q;
            }
        }
        if (best) {
            const type: SpotType = p.spotType && ["dungeon", "boss", "camp", "ruin"].includes(p.spotType) ? p.spotType : level >= 9 ? "boss" : level <= 4 ? "camp" : "dungeon";
            const name = generatePlaceName(world, rng, type);
            const spot = makeSpot(world, { name, spotType: type, x: best.x, y: best.y, dangerLevel: level, tags: [type, `threat-${level}`, `intent-${intent.number}`], description: `The heart of the danger: a ${type} in the most remote ground of the zone.` });
            changes.push(change("add_spot", `Add ${type} ${name}`, `Lair at [${spot.x}, ${spot.y}] km, ${spot.elevation} m, threat ${level}.`, spot));
        }
    }
    if (!changes.length) return { proposal: null, reason: "This area is already dangerous enough." };
    return { proposal: proposal(intent, `Intent #${intent.number}: threat ${level} here. A danger zone over the drawn area and a lair in its most remote high ground.`, changes, agentName), reason: `${changes.length} change(s).` };
}

function draftLandmark(world: GameWorld, intent: PlanIntent, rng: PRNG, agentName: string): DraftResult {
    const p = effectiveParams(intent);
    const pin = intentPoints(world, intent)[0];
    if (!pin) return { proposal: null, reason: "A landmark intent needs a pin." };
    const at = nearestLand(world, pin, pinRadiusKm(world.meta));
    if (!at) return { proposal: null, reason: "The pin is in open water with no land nearby." };
    const type = p.spotType ?? "landmark";
    const custom = intent.title && !/^a landmark here$/i.test(intent.title);
    const name = custom ? intent.title : generatePlaceName(world, rng, type);
    const spot = makeSpot(world, { name, spotType: type, x: at[0], y: at[1], tags: [type, `intent-${intent.number}`], description: intent.directive || `A ${type} marked by the designer.` });
    const moved = Math.hypot(at[0] - pin[0], at[1] - pin[1]) > 0.01 ? " (nudged onto the nearest land)" : "";
    return {
        proposal: proposal(intent, `Intent #${intent.number}: a ${type} at the pin${moved}.`, [change("add_spot", `Add ${type} ${name}`, `At [${spot.x}, ${spot.y}] km, ${spot.elevation} m${moved}.`, spot)], agentName),
        reason: `1 ${type}${moved}.`,
    };
}

function endpointNames(world: GameWorld, intent: PlanIntent): [string, string] {
    const n = (id?: string, k = 0) => (id ? world.spots.find((s) => s.id === id)?.name : undefined) ?? (k === 0 ? "the start" : "the destination");
    return [n(intent.fromSpotId, 0), n(intent.toSpotId, 1)];
}

function draftConnect(world: GameWorld, intent: PlanIntent, agentName: string): DraftResult {
    const p = effectiveParams(intent);
    const pts = intentPoints(world, intent);
    if (pts.length < 2) return { proposal: null, reason: "A connect intent needs two ends." };
    const existing = roadJoining(world, pts[0], pts[1]);
    if (existing) return { proposal: null, reason: `${existing.name} already joins them.` };
    const [a, b] = endpointNames(world, intent);
    const type = p.pathType ?? "road";
    const route = roadBetween(world, pts[0], pts[1]);
    const path = makePath({ name: `${a.replace(/^the /, "")}–${b.replace(/^the /, "")} ${type === "highway" ? "Highway" : type === "trail" ? "Trail" : "Road"}`, pathType: type, points: route, description: `Joins ${a} and ${b}, graded around steep ground and water.` });
    return {
        proposal: proposal(intent, `Intent #${intent.number}: join ${a} and ${b}. Routed over the terrain with A* (steep grades and water cost more).`, [change("add_path", `${capitalize(type)} ${a} → ${b}`, `${pathPolylineLengthKm(route).toFixed(1)} km ${type}.`, path)], agentName),
        reason: `1 ${type}, ${pathPolylineLengthKm(route).toFixed(1)} km.`,
    };
}

function draftPacing(world: GameWorld, intent: PlanIntent, agentName: string): DraftResult {
    const p = effectiveParams(intent);
    const pts = intentPoints(world, intent);
    if (pts.length < 2) return { proposal: null, reason: "A pacing intent needs two ends." };
    const mode = p.mode ?? "foot";
    const target = Math.max(1, p.targetMinutes ?? 60);
    const tol = Math.max(0.05, Math.min(0.9, p.tolerance ?? 0.25));
    const now = travelMinutes(world, pts[0], pts[1], mode);
    const fits = (m: number) => Math.abs(m / target - 1) <= tol;
    if (fits(now)) return { proposal: null, reason: `Already on target (${formatDuration(now / 60)}).` };
    const [a, b] = endpointNames(world, intent);
    const how = { foot: "on foot", mount: "mounted", vehicle: "by vehicle", water: "by boat", air: "by air" }[mode];

    if (now > target && mode !== "air") {
        // Too long: build a way between the two ends, of whichever class (trail, road, highway)
        // lands nearest the target - a highway can overshoot as badly as nothing at all.
        const route = roadBetween(world, pts[0], pts[1]);
        const trials = (["trail", "road", "highway"] as PathType[]).map((type) => {
            const trial = makePath({ name: "trial", pathType: type, points: route });
            return { type, minutes: travelMinutes({ ...world, paths: [...world.paths, { ...trial, id: "trial" }] }, pts[0], pts[1], mode) };
        });
        const fitting = trials.filter((t) => fits(t.minutes));
        const pick = fitting.length ? fitting[0] : trials.reduce((a, b) => (Math.abs(a.minutes - target) <= Math.abs(b.minutes - target) ? a : b));
        if (Math.abs(pick.minutes - target) < Math.abs(now - target)) {
            const noun = pick.type === "highway" ? "Highway" : pick.type === "trail" ? "Trail" : "Road";
            const path = makePath({ name: `${a.replace(/^the /, "")}–${b.replace(/^the /, "")} ${noun}`, pathType: pick.type, points: route, description: `Built to bring the journey from ${a} to ${b} near ${formatDuration(target / 60)}.` });
            const gap = fits(pick.minutes) ? "" : pick.minutes > target ? ` - still long; move the ends closer or travel mounted` : ` - a little quick; a longer route would slow it`;
            return {
                proposal: proposal(intent, `Intent #${intent.number}: ${a} → ${b} should take ${formatDuration(target / 60)} ${how}; it takes ${formatDuration(now / 60)}. A ${pick.type} brings it to ${formatDuration(pick.minutes / 60)}${gap}.`, [change("add_path", `${capitalize(pick.type)} ${a} → ${b}`, `${formatDuration(now / 60)} → ${formatDuration(pick.minutes / 60)} ${how}.`, path)], agentName),
                reason: `${formatDuration(now / 60)} → ${formatDuration(pick.minutes / 60)}.`,
            };
        }
    }

    // Otherwise move the destination along the line until the journey takes the target time.
    const toId = intent.toSpotId;
    const spot = toId ? world.spots.find((s) => s.id === toId) : undefined;
    if (!spot) return { proposal: null, reason: `${now > target ? "Too long" : "Too short"} (${formatDuration(now / 60)}), and the destination is not a spot that can be moved.` };
    const from = pts[0];
    const d0 = Math.hypot(spot.x - from[0], spot.y - from[1]);
    if (d0 < 0.01) return { proposal: null, reason: "The two ends are the same place." };
    const dir: [number, number] = [(spot.x - from[0]) / d0, (spot.y - from[1]) / d0];
    let factor = target / Math.max(1, now);
    let best: { p: [number, number]; minutes: number } | null = null;
    for (let iter = 0; iter < 6; iter++) {
        const raw: [number, number] = [from[0] + dir[0] * d0 * factor, from[1] + dir[1] * d0 * factor];
        const land = nearestLand(world, raw, Math.max(0.5, d0 * 0.15));
        if (!land || !inWorld(world, land)) {
            factor = 1 + (factor - 1) * 0.6;
            continue;
        }
        const moved = { ...world, spots: world.spots.map((s) => (s.id === spot.id ? { ...s, x: land[0], y: land[1] } : s)) };
        const minutes = travelMinutes(moved, from, land, mode);
        if (!best || Math.abs(minutes - target) < Math.abs(best.minutes - target)) best = { p: land, minutes };
        if (fits(minutes)) break;
        factor *= target / Math.max(1, minutes);
    }
    if (!best || Math.abs(best.minutes - target) >= Math.abs(now - target)) return { proposal: null, reason: `Could not find land that brings the journey nearer ${formatDuration(target / 60)}.` };
    const nx = r2(best.p[0]);
    const ny = r2(best.p[1]);
    const elevation = world.terrain ? Math.round(sampleTerrain(world.terrain, world.meta, nx, ny)) : spot.elevation;
    const moveKm = Math.hypot(nx - spot.x, ny - spot.y);
    return {
        proposal: proposal(
            intent,
            `Intent #${intent.number}: ${a} → ${b} should take ${formatDuration(target / 60)} ${how}; it takes ${formatDuration(now / 60)}. Moving ${spot.name} ${moveKm.toFixed(1)} km ${now < target ? "further away" : "closer"} makes it ${formatDuration(best.minutes / 60)}.`,
            [change("modify_spot", `Move ${spot.name}`, `${moveKm.toFixed(1)} km ${now < target ? "further" : "closer"}: ${formatDuration(now / 60)} → ${formatDuration(best.minutes / 60)} ${how}.`, { x: nx, y: ny, elevation }, spot.id, { x: spot.x, y: spot.y, elevation: spot.elevation })],
            agentName
        ),
        reason: `${formatDuration(now / 60)} → ${formatDuration(best.minutes / 60)}.`,
    };
}

function draftQuest(world: GameWorld, intent: PlanIntent, rng: PRNG, agentName: string): DraftResult {
    const p = effectiveParams(intent);
    const c = intentCentroid(world, intent);
    const changes: RevisionChange[] = [];
    const inside = spotsInIntent(world, intent);
    let objective: { id: string; name: string; x: number; y: number; danger: number } | undefined;
    const subject = inside.find((s) => !isSettlement(s.spotType)) ?? inside[0];
    if (subject) {
        objective = { id: subject.id, name: subject.name, x: subject.x, y: subject.y, danger: subject.dangerLevel ?? 3 };
    } else {
        let at: [number, number] | null = c;
        if (intent.shape === "area") {
            const cands = landCandidates(world, intentPoints(world, intent));
            const pick = cands.length ? cands[Math.floor(rng.next() * cands.length)] : null;
            at = pick ? [pick.x, pick.y] : null;
        } else {
            at = nearestLand(world, c, pinRadiusKm(world.meta));
        }
        if (!at) return { proposal: null, reason: "Nowhere on land here for the quest to happen." };
        const type: SpotType = p.spotType && !isSettlement(p.spotType) ? p.spotType : "ruin";
        const name = generatePlaceName(world, rng, type);
        const spot = makeSpot(world, { name, spotType: type, x: at[0], y: at[1], tags: [type, "quest-site", `intent-${intent.number}`], description: `Where the quest for intent #${intent.number} plays out.` });
        const ch = change("add_spot", `Add quest site ${name}`, `${capitalize(type)} at [${spot.x}, ${spot.y}] km.`, spot);
        changes.push(ch);
        objective = { id: ch.targetId, name, x: spot.x, y: spot.y, danger: spot.dangerLevel ?? 3 };
    }
    const giver = world.spots.filter((s) => isSettlement(s.spotType) && s.id !== objective!.id).sort((a, b) => Math.hypot(a.x - c[0], a.y - c[1]) - Math.hypot(b.x - c[0], b.y - c[1]))[0];
    const custom = intent.title && !/^a quest here$/i.test(intent.title);
    const title = custom ? intent.title : `The Secret of ${objective.name}`;
    const dist = giver ? Math.hypot(giver.x - objective.x, giver.y - objective.y) : 0;
    const mission: Omit<Mission, "id"> = {
        ...createMission(title, intent.directive || `Travel from ${giver?.name ?? "town"} to ${objective.name} and learn what waits there.`, "side", giver?.id, [objective.id]),
        ...(giver ? { turnInSpotId: giver.id } : {}),
        rewardXp: Math.round((400 + objective.danger * 150 + dist * 40) / 50) * 50,
    };
    delete (mission as any).id;
    changes.push(change("add_mission", `Quest: ${title}`, `${giver ? `Given at ${giver.name}, ` : ""}objective ${objective.name}${giver ? `, ${dist.toFixed(1)} km away` : ""}; ${mission.rewardXp} XP.`, mission));
    return { proposal: proposal(intent, `Intent #${intent.number}: a quest here. ${giver ? `The nearest settlement, ${giver.name}, gives it.` : ""}`, changes, agentName), reason: `${changes.length} change(s).` };
}

/**
 * The built-in agent's answer to an intent: a proposal, or why there isn't one. Never edits the
 * world; the designer accepts or rejects each change.
 */
export function draftProposalForIntent(world: GameWorld, intent: PlanIntent, agentName = PLANNER_AGENT_NAME): DraftResult {
    const ev = evaluateIntent(world, intent);
    if (ev.satisfied === true && intent.kind !== "freeform") return { proposal: null, reason: `Already met: ${ev.summary}.` };
    const rng = new PRNG((world.meta.seed | 0) * 31 + intent.number * 977 + world.spots.length * 7);
    switch (intent.kind) {
        case "settle": return draftSettle(world, intent, rng, agentName);
        case "danger": return draftDanger(world, intent, rng, agentName);
        case "landmark": return draftLandmark(world, intent, rng, agentName);
        case "connect": return draftConnect(world, intent, agentName);
        case "pacing": return draftPacing(world, intent, agentName);
        case "quest": return draftQuest(world, intent, rng, agentName);
        default: return { proposal: null, reason: "Freeform intents need an LLM agent: copy the Agent Brief, or let an MCP agent pick it up." };
    }
}

// -------------------------------------------------------------------------------------------------
// Normalizing what external agents send
// -------------------------------------------------------------------------------------------------

const CHANGE_TYPES: RevisionChangeType[] = ["add_spot", "modify_spot", "delete_spot", "add_path", "modify_path", "delete_path", "add_region", "modify_region", "add_mission", "add_codex"];
const CODEX_CATEGORIES: CodexCategory[] = ["character", "creature", "power", "weapon", "faction", "lore"];

const isPoint = (p: any) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]));

/**
 * Fills in and checks the changes an agent sent: unknown change types and changes missing what
 * they need are dropped (and reported), the rest come back complete, with `before` recorded for
 * modifications and deletions so the designer sees what would change.
 */
export function normalizeProposalChanges(world: GameWorld, raw: any[]): { changes: RevisionChange[]; errors: string[] } {
    const changes: RevisionChange[] = [];
    const errors: string[] = [];
    (Array.isArray(raw) ? raw : []).forEach((c: any, i: number) => {
        const where = `change ${i + 1}`;
        if (!c || typeof c !== "object") return errors.push(`${where}: not an object`);
        const type = c.changeType as RevisionChangeType;
        if (!CHANGE_TYPES.includes(type)) return errors.push(`${where}: unknown changeType "${c.changeType}" (use ${CHANGE_TYPES.join(", ")})`);
        const after = c.after && typeof c.after === "object" ? c.after : {};
        const base = { id: String(c.id || uid("chg")), changeType: type, status: "pending" as const };
        const title = (fallback: string) => String(c.title || fallback);
        const summary = String(c.summary || "");
        const findTarget = <T extends { id: string }>(list: T[], noun: string): T | undefined => {
            const target = list.find((e) => e.id === c.targetId);
            if (!target) errors.push(`${where}: no ${noun} with id "${c.targetId}"`);
            return target;
        };
        switch (type) {
            case "add_spot": {
                if (!after.name || !Number.isFinite(Number(after.x)) || !Number.isFinite(Number(after.y))) return errors.push(`${where}: add_spot needs after.name, after.x and after.y`);
                const spot = makeSpot(world, after);
                return changes.push({ ...base, targetId: String(c.targetId || uid("spot")), title: title(`Add ${spot.spotType} ${spot.name}`), summary: summary || `At [${spot.x}, ${spot.y}] km.`, after: spot });
            }
            case "add_path": {
                const pts = Array.isArray(after.points) ? after.points.filter(isPoint) : [];
                if (!after.name || pts.length < 2) return errors.push(`${where}: add_path needs after.name and at least two after.points`);
                const path = makePath({ ...after, points: pts });
                return changes.push({ ...base, targetId: String(c.targetId || uid("path")), title: title(`Add ${path.pathType} ${path.name}`), summary: summary || `${pathPolylineLengthKm(path.points).toFixed(1)} km.`, after: path });
            }
            case "add_region": {
                const pts = Array.isArray(after.points) ? after.points.filter(isPoint) : [];
                if (!after.name || pts.length < 3) return errors.push(`${where}: add_region needs after.name and at least three after.points`);
                const region = makeRegion({ ...after, points: pts });
                return changes.push({ ...base, targetId: String(c.targetId || uid("region")), title: title(`Add region ${region.name}`), summary: summary || `${region.regionType}, ${polygonAreaKm2(region.points).toFixed(1)} km².`, after: region });
            }
            case "add_mission": {
                if (!after.title) return errors.push(`${where}: add_mission needs after.title`);
                const m: any = { ...createMission(String(after.title), String(after.description || ""), after.missionType || "side", after.startSpotId, Array.isArray(after.objectiveSpotIds) ? after.objectiveSpotIds : []), ...after };
                delete m.id;
                return changes.push({ ...base, targetId: String(c.targetId || uid("mission")), title: title(`Quest: ${m.title}`), summary, after: m });
            }
            case "add_codex": {
                if (!after.name) return errors.push(`${where}: add_codex needs after.name`);
                const cat: CodexCategory = CODEX_CATEGORIES.includes(after.category) ? after.category : "lore";
                const entry: any = { ...createCodexEntry(String(after.name), cat, String(after.subtitle || ""), String(after.description || ""), world.meta.genre), ...after, category: cat };
                delete entry.id;
                return changes.push({ ...base, targetId: String(c.targetId || uid("codex")), title: title(`Codex: ${entry.name}`), summary, after: entry });
            }
            case "modify_spot":
            case "delete_spot": {
                const s = findTarget(world.spots, "spot");
                if (!s) return;
                if (type === "delete_spot") return changes.push({ ...base, targetId: s.id, title: title(`Remove ${s.name}`), summary, before: s, after: null });
                const upd: any = { ...after };
                if ((upd.x !== undefined || upd.y !== undefined) && upd.elevation === undefined && world.terrain) upd.elevation = Math.round(sampleTerrain(world.terrain, world.meta, Number(upd.x ?? s.x), Number(upd.y ?? s.y)));
                const before = Object.fromEntries(Object.keys(upd).map((k) => [k, (s as any)[k]]));
                return changes.push({ ...base, targetId: s.id, title: title(`Edit ${s.name}`), summary, before, after: upd });
            }
            case "modify_path":
            case "delete_path": {
                const p = findTarget(world.paths, "path");
                if (!p) return;
                if (type === "delete_path") return changes.push({ ...base, targetId: p.id, title: title(`Remove ${p.name}`), summary, before: p, after: null });
                const before = Object.fromEntries(Object.keys(after).map((k) => [k, (p as any)[k]]));
                return changes.push({ ...base, targetId: p.id, title: title(`Edit ${p.name}`), summary, before, after });
            }
            case "modify_region": {
                const r = findTarget(world.regions, "region");
                if (!r) return;
                const before = Object.fromEntries(Object.keys(after).map((k) => [k, (r as any)[k]]));
                return changes.push({ ...base, targetId: r.id, title: title(`Edit ${r.name}`), summary, before, after });
            }
        }
    });
    return { changes, errors };
}
