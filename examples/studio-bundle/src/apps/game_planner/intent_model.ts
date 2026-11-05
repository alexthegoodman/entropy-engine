// Design intents: the designer sketches *what they want* on the map (a pin, an area, a route) with a
// directive in their own words, and agents build it. Every intent kind except freeform has an
// automatic check, so the set of intents doubles as the world's acceptance tests: the map shows
// which ones the world currently meets, and agents read the unmet ones as their work queue.

import type {
    GameWorld,
    IntentEvaluation,
    IntentKind,
    IntentParams,
    IntentShape,
    PlanIntent,
    SpotType,
    TravelMode,
    WorldMetadata,
    WorldSpot,
} from "./planner_types";
import { calculateTravelTime, formatDuration, isPointInsidePolygon } from "./travel_calculator";
import { sampleSlopeDeg, sampleTerrain } from "./terrain";

export const INTENT_KINDS: IntentKind[] = ["settle", "danger", "landmark", "connect", "pacing", "quest", "freeform"];

export const INTENT_KIND_INFO: Record<IntentKind, { label: string; shapes: IntentShape[]; color: [number, number, number, number]; hint: string }> = {
    settle: { label: "Settle", shapes: ["area"], color: [0.35, 0.85, 0.5, 1], hint: "Places for people to live in this area" },
    danger: { label: "Danger", shapes: ["area"], color: [0.95, 0.3, 0.35, 1], hint: "A hostile zone with a threat level" },
    landmark: { label: "Landmark", shapes: ["pin"], color: [0.7, 0.5, 0.98, 1], hint: "A specific place right here" },
    connect: { label: "Connect", shapes: ["route"], color: [0.98, 0.78, 0.3, 1], hint: "A road joining two places" },
    pacing: { label: "Pacing", shapes: ["route"], color: [0.3, 0.75, 0.98, 1], hint: "How long a journey should take" },
    quest: { label: "Quest", shapes: ["pin", "area"], color: [0.98, 0.55, 0.2, 1], hint: "A quest that plays out here" },
    freeform: { label: "Freeform", shapes: ["pin", "area", "route"], color: [0.85, 0.88, 0.95, 1], hint: "Anything else, for an LLM agent" },
};

/** The kind a fresh intent of this shape gets when the designer hasn't chosen one. */
export function defaultKindForShape(shape: IntentShape): IntentKind {
    return shape === "area" ? "settle" : shape === "route" ? "pacing" : "landmark";
}

const SETTLEMENT_TYPES: SpotType[] = ["capital", "city", "town", "village", "port", "fortress"];
const DANGER_TYPES: SpotType[] = ["dungeon", "boss", "camp", "ruin"];

export function isSettlement(t: SpotType): boolean {
    return SETTLEMENT_TYPES.includes(t);
}

// -------------------------------------------------------------------------------------------------
// Reading the designer's words
// -------------------------------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
    a: 1, an: 1, one: 1, single: 1, two: 2, couple: 2, pair: 2, three: 3, few: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, several: 4, many: 6,
};

const TYPE_WORDS: Array<[RegExp, SpotType]> = [
    [/\bcapitals?\b/, "capital"],
    [/\bcit(y|ies)\b/, "city"],
    [/\btowns?\b/, "town"],
    [/\b(ports?|harbou?rs?|docks?|fishing)\b/, "port"],
    [/\b(villages?|hamlets?|settlements?)\b/, "village"],
    [/\b(forts?|fortress(es)?|castles?|keeps?|garrisons?)\b/, "fortress"],
    [/\b(dungeons?|crypts?|catacombs?|lairs?|vaults?)\b/, "dungeon"],
    [/\b(ruins?|remains)\b/, "ruin"],
    [/\b(shrines?|temples?|altars?|monaster(y|ies))\b/, "shrine"],
    [/\b(camps?|outposts?|encampments?)\b/, "camp"],
    [/\b(mines?|quarr(y|ies))\b/, "mine"],
    [/\b(boss(es)?|dragons?|wyrms?)\b/, "boss"],
    [/\b(landmarks?|monuments?|towers?|statues?)\b/, "landmark"],
];

const MODE_WORDS: Array<[RegExp, TravelMode]> = [
    [/\b(horse(back)?|mount(ed)?|ride|riding)\b/, "mount"],
    [/\b(car|vehicle|drive|driving|cart)\b/, "vehicle"],
    [/\b(boat|ship|sail|sailing)\b/, "water"],
    [/\b(fly|flying|air|airship)\b/, "air"],
    [/\b(walk|walking|foot|hike)\b/, "foot"],
];

/**
 * What a directive says, read with simple patterns: "three fishing villages", "dangerous, level 8",
 * "should take about 40 minutes on horseback". Only the things it finds are returned; the
 * designer's explicit params always win over these.
 */
export function inferIntentFromText(text: string): { kind?: IntentKind; params: IntentParams } {
    const t = ` ${text.toLowerCase()} `;
    const params: IntentParams = {};
    let kind: IntentKind | undefined;

    for (const [re, type] of TYPE_WORDS) {
        if (re.test(t)) {
            params.spotType = type;
            break;
        }
    }
    const countMatch = t.match(/\b(\d{1,2}|a|an|one|single|two|couple|pair|three|few|four|five|six|seven|eight|nine|ten|several|many)\s+(?:of\s+)?(?:\w+\s+){0,2}?(?:villages?|towns?|cit(?:y|ies)|settlements?|hamlets?|ports?|forts?|camps?|mines?|shrines?|ruins?|dungeons?|places?|outposts?)\b/);
    if (countMatch) {
        const w = countMatch[1];
        params.count = /\d/.test(w) ? Number(w) : NUMBER_WORDS[w] ?? undefined;
    }
    const level = t.match(/\b(?:level|threat|danger(?:ous)?|tier)\s*(?:level\s*)?(\d{1,2})\b/) || t.match(/\b(\d{1,2})\s*\/\s*10\b/);
    if (level) params.dangerLevel = Math.max(1, Math.min(10, Number(level[1])));

    const hours = t.match(/(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)\b/);
    const minutes = t.match(/(\d+)\s*(?:m|mins?|minutes?)\b/);
    if (hours || minutes) {
        params.targetMinutes = Math.round((hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0));
    }
    for (const [re, mode] of MODE_WORDS) {
        if (re.test(t)) {
            params.mode = mode;
            break;
        }
    }

    if (params.targetMinutes) kind = "pacing";
    else if (/\b(road|connect|link|join|highway|bridge)\b/.test(t)) kind = "connect";
    else if (/\b(quest|mission|story|errand|bounty)\b/.test(t)) kind = "quest";
    else if (/\b(danger(ous)?|hostile|haunted|cursed|monsters?|bandits?|threat|deadly|infested)\b/.test(t)) kind = "danger";
    else if (params.count !== undefined || (params.spotType && isSettlement(params.spotType))) kind = "settle";
    if (/\bhighway\b/.test(t)) params.pathType = "highway";
    else if (/\btrail\b/.test(t)) params.pathType = "trail";
    return { kind, params };
}

/** What an intent of each kind assumes when neither the designer nor the directive says. */
export function defaultParams(kind: IntentKind): IntentParams {
    switch (kind) {
        case "settle": return { count: 3 };
        case "danger": return { dangerLevel: 7 };
        case "pacing": return { targetMinutes: 60, mode: "foot", tolerance: 0.25 };
        case "connect": return { pathType: "road" };
        default: return {};
    }
}

/**
 * The params an intent works to: the kind's defaults, overridden by what its directive says,
 * overridden by what the designer set explicitly.
 */
export function effectiveParams(intent: PlanIntent): IntentParams {
    const inferred = inferIntentFromText(`${intent.title} ${intent.directive}`).params;
    const out: IntentParams = { ...defaultParams(intent.kind), ...inferred };
    for (const [k, v] of Object.entries(intent.params)) {
        if (v !== undefined && v !== null && v !== "") (out as any)[k] = v;
    }
    return out;
}

// -------------------------------------------------------------------------------------------------
// Creating intents
// -------------------------------------------------------------------------------------------------

export function nextIntentNumber(world: GameWorld): number {
    return (world.intents ?? []).reduce((m, i) => Math.max(m, i.number), 0) + 1;
}

const DEFAULT_TITLES: Record<IntentKind, string> = {
    settle: "Settle this area",
    danger: "Make this area dangerous",
    landmark: "A landmark here",
    connect: "Connect these places",
    pacing: "Journey pacing",
    quest: "A quest here",
    freeform: "Design note",
};

export function createIntent(
    world: GameWorld,
    shape: IntentShape,
    points: [number, number][],
    opts: Partial<Pick<PlanIntent, "kind" | "title" | "directive" | "params" | "priority" | "fromSpotId" | "toSpotId">> = {}
): PlanIntent {
    const kind = opts.kind ?? defaultKindForShape(shape);
    // Only what was asked for explicitly; defaults and the directive's words fill in at use.
    const params: IntentParams = { ...(opts.params ?? {}) };
    return {
        id: `intent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        number: nextIntentNumber(world),
        shape,
        kind,
        points: points.map(([x, y]) => [Number(x.toFixed(3)), Number(y.toFixed(3))] as [number, number]),
        ...(opts.fromSpotId ? { fromSpotId: opts.fromSpotId } : {}),
        ...(opts.toSpotId ? { toSpotId: opts.toSpotId } : {}),
        title: opts.title ?? DEFAULT_TITLES[kind],
        directive: opts.directive ?? "",
        params,
        priority: opts.priority ?? "normal",
        status: "open",
        createdAt: Date.now(),
    };
}

/** The spot whose position is within `tolKm` of a point (closest first), for route endpoints. */
export function spotNear(world: GameWorld, p: [number, number], tolKm = 0.05): WorldSpot | undefined {
    let best: WorldSpot | undefined;
    let bestD = tolKm;
    for (const s of world.spots) {
        const d = Math.hypot(s.x - p[0], s.y - p[1]);
        if (d <= bestD) {
            bestD = d;
            best = s;
        }
    }
    return best;
}

/** The intent's points as they stand now: route ends pinned to spots follow those spots. */
export function intentPoints(world: GameWorld, intent: PlanIntent): [number, number][] {
    if (intent.shape !== "route" || intent.points.length < 2) return intent.points;
    const from = intent.fromSpotId ? world.spots.find((s) => s.id === intent.fromSpotId) : undefined;
    const to = intent.toSpotId ? world.spots.find((s) => s.id === intent.toSpotId) : undefined;
    return [from ? [from.x, from.y] : intent.points[0], to ? [to.x, to.y] : intent.points[intent.points.length - 1]];
}

export function intentCentroid(world: GameWorld, intent: PlanIntent): [number, number] {
    const pts = intentPoints(world, intent);
    if (!pts.length) return [0, 0];
    return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
}

export function polygonAreaKm2(pts: [number, number][]): number {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    return Math.abs(a) * 0.5;
}

/** How close (km) a pin's subject has to be to count as "here". */
export function pinRadiusKm(meta: WorldMetadata): number {
    return Math.max(0.6, Math.min(meta.worldWidthKm, meta.worldHeightKm) * 0.04);
}

/** Spots inside an area intent (or near a pin). */
export function spotsInIntent(world: GameWorld, intent: PlanIntent): WorldSpot[] {
    const pts = intentPoints(world, intent);
    if (intent.shape === "area") return world.spots.filter((s) => isPointInsidePolygon([s.x, s.y], pts));
    if (intent.shape === "pin" && pts[0]) {
        const r = pinRadiusKm(world.meta);
        return world.spots.filter((s) => Math.hypot(s.x - pts[0][0], s.y - pts[0][1]) <= r);
    }
    return [];
}

function distToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function distToPolyline(p: [number, number], pts: [number, number][]): number {
    if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
    let d = Infinity;
    for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, distToSegment(p, pts[i], pts[i + 1]));
    return d;
}

/** A road (not a river) that passes within `tolKm` of both points. */
export function roadJoining(world: GameWorld, a: [number, number], b: [number, number], tolKm = 0.6) {
    return world.paths.find((p) => p.pathType !== "river" && p.points.length >= 2 && distToPolyline(a, p.points) <= tolKm && distToPolyline(b, p.points) <= tolKm);
}

/** Minutes to travel between two points by a mode, using the roads that exist. */
export function travelMinutes(world: GameWorld, a: [number, number], b: [number, number], mode: TravelMode = "foot"): number {
    const t = world.terrain;
    const est = calculateTravelTime(a, b, world.paths, world.regions, t ? { terrain: t, meta: world.meta } : undefined);
    const e = est.estimates[mode];
    return e.hours * 60 + e.minutes;
}

// -------------------------------------------------------------------------------------------------
// The live check
// -------------------------------------------------------------------------------------------------

const MODE_WORD: Record<TravelMode, string> = { foot: "on foot", mount: "mounted", vehicle: "by vehicle", water: "by boat", air: "by air" };

export function evaluateIntent(world: GameWorld, intent: PlanIntent): IntentEvaluation {
    const p = effectiveParams(intent);
    const pts = intentPoints(world, intent);
    const done = intent.status === "done";
    switch (intent.kind) {
        case "settle": {
            const want = Math.max(1, p.count ?? 3);
            const matches = (s: WorldSpot) => (p.spotType && !isSettlement(p.spotType) ? s.spotType === p.spotType : isSettlement(s.spotType));
            const have = spotsInIntent(world, intent).filter(matches).length;
            const noun = p.spotType ? `${p.spotType}${want === 1 ? "" : "s"}` : want === 1 ? "settlement" : "settlements";
            return { satisfied: have >= want, summary: `${Math.min(have, 999)} of ${want} ${noun}`, progress: Math.min(1, have / want) };
        }
        case "danger": {
            const level = p.dangerLevel ?? 7;
            const c = intentCentroid(world, intent);
            const region = world.regions.find((r) => r.regionType === "danger" && r.dangerLevel >= level && (isPointInsidePolygon(c, r.points) || pts.some((q) => isPointInsidePolygon(q, r.points))));
            const lair = spotsInIntent(world, intent).find((s) => DANGER_TYPES.includes(s.spotType) && (s.dangerLevel ?? 0) >= level);
            const got = (region ? 1 : 0) + (lair ? 1 : 0);
            const summary = region && lair ? `${region.name} (threat ${region.dangerLevel}) with ${lair.name}` : region ? `${region.name} - no lair inside yet` : lair ? `${lair.name} - zone not marked dangerous` : `nothing at threat ${level} here yet`;
            return { satisfied: !!region, summary, progress: got / 2 };
        }
        case "landmark": {
            const want = p.spotType ?? "landmark";
            const near = spotsInIntent(world, intent);
            const hit = near.find((s) => s.spotType === want) ?? (intent.params.spotType ? undefined : near.find((s) => !isSettlement(s.spotType)));
            return { satisfied: !!hit, summary: hit ? `${hit.name} is here` : `no ${want} here yet`, progress: hit ? 1 : 0 };
        }
        case "connect": {
            if (pts.length < 2) return { satisfied: false, summary: "needs two ends", progress: 0 };
            const road = roadJoining(world, pts[0], pts[1]);
            return { satisfied: !!road, summary: road ? `joined by ${road.name}` : "no road joins them", progress: road ? 1 : 0 };
        }
        case "pacing": {
            if (pts.length < 2) return { satisfied: false, summary: "needs two ends", progress: 0 };
            const mode = p.mode ?? "foot";
            const target = Math.max(1, p.targetMinutes ?? 60);
            const tol = Math.max(0.05, Math.min(0.9, p.tolerance ?? 0.25));
            const now = travelMinutes(world, pts[0], pts[1], mode);
            const ratio = now / target;
            const off = Math.round((ratio - 1) * 100);
            const ok = Math.abs(ratio - 1) <= tol;
            const verdict = ok ? "on target" : off > 0 ? `${off}% too long` : `${-off}% too short`;
            return {
                satisfied: ok,
                summary: `${formatDuration(now / 60)} ${MODE_WORD[mode]} vs ${formatDuration(target / 60)} target - ${verdict}`,
                progress: Math.max(0, 1 - Math.abs(ratio - 1)),
            };
        }
        case "quest": {
            const subjects = new Set(spotsInIntent(world, intent).map((s) => s.id));
            const m = world.missions.find((ms) => ms.objectiveSpotIds.some((id) => subjects.has(id)) || (ms.startSpotId && subjects.has(ms.startSpotId)));
            return { satisfied: !!m, summary: m ? `quest "${m.title}"` : "no quest leads here yet", progress: m ? 1 : 0 };
        }
        case "freeform":
        default:
            return { satisfied: done ? true : null, summary: done ? "marked done" : "checked by hand", progress: done ? 1 : 0 };
    }
}

export interface IntentHealth {
    total: number;
    met: number;
    unmet: number;
    manual: number;
    /** 0..100 */
    score: number;
}

/** How much of the designer's plan the world meets (dismissed intents don't count). */
export function planHealth(world: GameWorld): IntentHealth {
    const live = (world.intents ?? []).filter((i) => i.status !== "dismissed");
    let met = 0;
    let unmet = 0;
    let manual = 0;
    let progress = 0;
    for (const i of live) {
        const e = evaluateIntent(world, i);
        if (e.satisfied === null) manual++;
        else if (e.satisfied) met++;
        else unmet++;
        progress += e.satisfied === null ? 0 : e.satisfied ? 1 : e.progress * 0.8;
    }
    const checked = met + unmet;
    return { total: live.length, met, unmet, manual, score: checked ? Math.round((progress / checked) * 100) : 100 };
}

// -------------------------------------------------------------------------------------------------
// What an agent needs to know
// -------------------------------------------------------------------------------------------------

export interface IntentContext {
    id: string;
    number: number;
    kind: IntentKind;
    shape: IntentShape;
    title: string;
    directive: string;
    priority: PlanIntent["priority"];
    status: PlanIntent["status"];
    params: IntentParams;
    points: [number, number][];
    centroid: [number, number];
    evaluation: IntentEvaluation;
    areaKm2?: number;
    terrain?: { minM: number; maxM: number; meanM: number; landFraction: number; meanSlopeDeg: number };
    spotsInside: Array<{ id: string; name: string; spotType: SpotType; x: number; y: number }>;
    nearestSpots: Array<{ id: string; name: string; spotType: SpotType; distanceKm: number }>;
    endpoints?: Array<{ spotId?: string; name?: string; x: number; y: number }>;
    /** What a proposal answering this intent should contain. */
    acceptance: string;
}

const ACCEPTANCE: Record<IntentKind, (p: IntentParams) => string> = {
    settle: (p) => `At least ${p.count ?? 3} ${p.spotType ?? "settlement"} spot(s) inside the area polygon, on land, sensibly spaced; ideally linked to the road network (add_spot, add_path).`,
    danger: (p) => `A region with regionType "danger" and dangerLevel >= ${p.dangerLevel ?? 7} covering the area, ideally with a dungeon/boss/camp spot inside it (add_region, add_spot).`,
    landmark: (p) => `A ${p.spotType ?? "landmark"} spot within the pin radius (add_spot).`,
    connect: (p) => `A ${p.pathType ?? "road"} path whose polyline passes within 0.6 km of both ends, following the terrain (add_path).`,
    pacing: (p) => `Travel ${p.mode ?? "foot"} between the ends takes ${p.targetMinutes ?? 60} min within ±${Math.round((p.tolerance ?? 0.25) * 100)}%: add or upgrade roads to make it faster, move an endpoint (modify_spot) to make it longer.`,
    quest: () => `A mission whose objective (or start) is a spot here, given and turned in at a nearby settlement (add_mission, optionally add_spot).`,
    freeform: () => `Interpret the directive; any change types. The designer reviews it by hand.`,
};

export function intentContext(world: GameWorld, intent: PlanIntent): IntentContext {
    const pts = intentPoints(world, intent);
    const c = intentCentroid(world, intent);
    const p = effectiveParams(intent);
    const t = world.terrain;
    let terrain: IntentContext["terrain"];
    if (t && intent.shape === "area" && pts.length >= 3) {
        const xs = pts.map((q) => q[0]);
        const ys = pts.map((q) => q[1]);
        const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        let n = 0, land = 0, sum = 0, slope = 0, mn = Infinity, mx = -Infinity;
        for (let i = 0; i <= 12; i++) {
            for (let j = 0; j <= 12; j++) {
                const q: [number, number] = [x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * j) / 12];
                if (!isPointInsidePolygon(q, pts)) continue;
                const e = sampleTerrain(t, world.meta, q[0], q[1]);
                n++;
                sum += e;
                mn = Math.min(mn, e);
                mx = Math.max(mx, e);
                if (e > t.seaLevelM) land++;
                slope += sampleSlopeDeg(t, world.meta, q[0], q[1]);
            }
        }
        if (n) terrain = { minM: Math.round(mn), maxM: Math.round(mx), meanM: Math.round(sum / n), landFraction: Number((land / n).toFixed(2)), meanSlopeDeg: Number((slope / n).toFixed(1)) };
    }
    const nearest = world.spots
        .map((s) => ({ id: s.id, name: s.name, spotType: s.spotType, distanceKm: Number(Math.hypot(s.x - c[0], s.y - c[1]).toFixed(2)) }))
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, 5);
    const endpoints = intent.shape === "route"
        ? pts.map((q, k) => {
            const id = k === 0 ? intent.fromSpotId : intent.toSpotId;
            const s = id ? world.spots.find((sp) => sp.id === id) : undefined;
            return { ...(s ? { spotId: s.id, name: s.name } : {}), x: q[0], y: q[1] };
        })
        : undefined;
    return {
        id: intent.id,
        number: intent.number,
        kind: intent.kind,
        shape: intent.shape,
        title: intent.title,
        directive: intent.directive,
        priority: intent.priority,
        status: intent.status,
        params: p,
        points: pts,
        centroid: [Number(c[0].toFixed(3)), Number(c[1].toFixed(3))],
        evaluation: evaluateIntent(world, intent),
        ...(intent.shape === "area" ? { areaKm2: Number(polygonAreaKm2(pts).toFixed(2)) } : {}),
        ...(terrain ? { terrain } : {}),
        spotsInside: spotsInIntent(world, intent).map((s) => ({ id: s.id, name: s.name, spotType: s.spotType, x: s.x, y: s.y })),
        nearestSpots: nearest,
        ...(endpoints ? { endpoints } : {}),
        acceptance: ACCEPTANCE[intent.kind](p),
    };
}

/** Intents still waiting for work, most important first. */
export function openIntents(world: GameWorld): PlanIntent[] {
    const rank = { high: 0, normal: 1, low: 2 } as const;
    return (world.intents ?? [])
        .filter((i) => i.status !== "dismissed" && i.status !== "done" && evaluateIntent(world, i).satisfied !== true)
        .sort((a, b) => rank[a.priority] - rank[b.priority] || a.number - b.number);
}

/**
 * A Markdown work order for any agent (pasted into a chat, or read over MCP): the world in brief,
 * every unmet intent with its context and acceptance criteria, and how to hand changes back.
 */
export function generateAgentBrief(world: GameWorld): string {
    const open = openIntents(world);
    const health = planHealth(world);
    const { meta } = world;
    let md = `# Agent Brief: ${meta.name}\n\n`;
    md += `${meta.genre} world, ${meta.worldWidthKm} x ${meta.worldHeightKm} km, origin at the center, +y is north, coordinates in km. Sea level ${meta.seaLevelM} m.\n`;
    md += `${world.spots.length} spots, ${world.paths.length} paths, ${world.regions.length} regions, ${world.missions.length} quests. Plan health: ${health.met}/${health.met + health.unmet} checked intents met (${health.score}%).\n\n`;
    md += `The designer sketched these intents on the map. Build what they ask for; the designer reviews every change as a preview on the map before it becomes real.\n\n`;
    if (!open.length) md += `_No open intents: the world meets every intent the designer has drawn._\n\n`;
    open.forEach((intent) => {
        const ctx = intentContext(world, intent);
        md += `## #${intent.number} ${intent.title} (${intent.kind}, ${intent.priority} priority)\n\n`;
        if (intent.directive) md += `> ${intent.directive.replace(/\n/g, "\n> ")}\n\n`;
        md += `- **id:** \`${intent.id}\`\n`;
        md += `- **Now:** ${ctx.evaluation.summary}\n`;
        md += `- **Done when:** ${ctx.acceptance}\n`;
        md += `- **Shape:** ${intent.shape}, points ${JSON.stringify(ctx.points.map((q) => [Number(q[0].toFixed(2)), Number(q[1].toFixed(2))]))}`;
        if (ctx.areaKm2 !== undefined) md += `, ${ctx.areaKm2} km²`;
        md += `\n`;
        if (ctx.terrain) md += `- **Terrain:** ${ctx.terrain.minM} to ${ctx.terrain.maxM} m (mean ${ctx.terrain.meanM} m), ${Math.round(ctx.terrain.landFraction * 100)}% land, mean slope ${ctx.terrain.meanSlopeDeg}°\n`;
        if (ctx.endpoints) md += `- **Ends:** ${ctx.endpoints.map((e) => (e.name ? `${e.name} (\`${e.spotId}\`)` : `[${e.x.toFixed(2)}, ${e.y.toFixed(2)}]`)).join(" → ")}\n`;
        if (ctx.spotsInside.length) md += `- **Already here:** ${ctx.spotsInside.map((s) => `${s.name} (${s.spotType})`).join(", ")}\n`;
        md += `- **Nearby:** ${ctx.nearestSpots.map((s) => `${s.name} ${s.distanceKm} km`).join(", ")}\n`;
        const extra = Object.entries(ctx.params).filter(([, v]) => v !== undefined);
        if (extra.length) md += `- **Params:** ${extra.map(([k, v]) => `${k}=${v}`).join(", ")}\n`;
        md += `\n`;
    });
    md += `## Handing changes back\n\n`;
    md += `Call the MCP tool \`game_planner_propose_revision\` with \`{ agentName, motivation, intentId, changes: [...] }\`. `;
    md += `Each change is \`{ changeType, title, summary, targetId?, after }\` with changeType one of add_spot, modify_spot, delete_spot, add_path, modify_path, delete_path, add_region, modify_region, add_mission, add_codex. `;
    md += `Minimal fields are enough - e.g. add_spot \`after: { name, spotType, x, y, description }\` (elevation, color and icon are filled in from the terrain and type); add_path \`after: { name, pathType, points }\`; add_region \`after: { name, regionType, points, dominantBiome, dangerLevel }\`; modify_spot \`targetId\` + \`after: { x, y }\`. `;
    md += `Use \`game_planner_sample_terrain\` for elevations and \`game_planner_calculate_travel\` for journey times; \`game_planner_list_intents\` returns this brief's data as JSON.\n`;
    return md;
}
