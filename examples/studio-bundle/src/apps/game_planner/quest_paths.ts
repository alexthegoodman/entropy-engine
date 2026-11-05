// Quest paths: the route a quest sends the player along, drawn on the map with the Quest Path tool.
//
// A quest path always belongs to a quest. Drawing one is the quickest way to make a quest: click
// from the giver's town through the places the player must go, and the quest is created (or an
// existing one is wired up) from the spots the route passes: the first is where the quest is given,
// the others are objectives in order, and a route that comes back to its start is turned in there.
//
// Quest paths are plans, not roads: travel-time tools, road networks and "connect" intents ignore
// them. Roads and rivers are physical and are laid by other means (Sculpt > Road bed with "Lay a
// road", the procedural tools, agent proposals).

import type { GameWorld, Mission, MissionType, QuestPath, TravelMode, WorldSpot } from "./planner_types";
import { createMission } from "./story_model";
import { sampleTerrain } from "./terrain";
import { BASE_SPEEDS, formatDuration, pathPolylineLengthKm } from "./travel_calculator";

export type RGBA = [number, number, number, number];

export const QUEST_PATH_COLORS: Record<MissionType, RGBA> = {
    main: [0.98, 0.75, 0.14, 1],
    side: [0.22, 0.74, 0.97, 1],
    faction: [0.66, 0.33, 0.97, 1],
};

/** How close (km) a route point must be to a spot to count as passing through it. */
const ON_SPOT_KM = 0.05;

export function questPathsOf(world: GameWorld, missionId: string): QuestPath[] {
    return (world.questPaths ?? []).filter((q) => q.missionId === missionId);
}

/** The spot a route point sits on (drawing snaps points onto spots), if any. */
export function spotAtPoint(world: GameWorld, p: [number, number], tolKm = ON_SPOT_KM): WorldSpot | undefined {
    let best: WorldSpot | undefined;
    let bestD = tolKm;
    for (const s of world.spots) {
        const d = Math.hypot(s.x - p[0], s.y - p[1]);
        if (d <= bestD) {
            best = s;
            bestD = d;
        }
    }
    return best;
}

/** The spots a route passes through, in order, without immediate repeats. */
export function routeSpots(world: GameWorld, points: [number, number][]): { spotIds: Array<string | null>; stops: WorldSpot[] } {
    const spotIds = points.map((p) => spotAtPoint(world, p)?.id ?? null);
    const stops: WorldSpot[] = [];
    for (const id of spotIds) {
        if (!id || stops[stops.length - 1]?.id === id) continue;
        const s = world.spots.find((x) => x.id === id);
        if (s) stops.push(s);
    }
    return { spotIds, stops };
}

/** The role each stop plays: the giver first, objectives in order, the turn-in when the route comes back. */
export function rolesFromStops(stops: WorldSpot[], startsAtSpot: boolean): { giver?: WorldSpot; objectives: WorldSpot[]; turnIn?: WorldSpot } {
    if (!stops.length) return { objectives: [] };
    const giver = startsAtSpot ? stops[0] : undefined;
    let rest = startsAtSpot ? stops.slice(1) : stops.slice();
    let turnIn: WorldSpot | undefined;
    if (giver && rest.length && rest[rest.length - 1].id === giver.id) {
        turnIn = giver;
        rest = rest.slice(0, -1);
    }
    const seen = new Set<string>(giver ? [giver.id] : []);
    const objectives = rest.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
    return { giver, objectives, turnIn };
}

export function newQuestPathId(): string {
    return `qpath_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** A new quest made from a drawn route, and the route itself. Pure: the caller adds both. */
export function questFromRoute(world: GameWorld, points: [number, number][], missionType: MissionType = "side"): { mission: Mission; questPath: QuestPath } {
    const { spotIds, stops } = routeSpots(world, points);
    const { giver, objectives, turnIn } = rolesFromStops(stops, !!spotIds[0]);
    const dest = objectives[objectives.length - 1];
    const n = world.missions.length + 1;
    const title = dest ? (giver ? `From ${giver.name} to ${dest.name}` : `Journey to ${dest.name}`) : giver ? `A Quest from ${giver.name}` : `New Quest ${n}`;
    const km = pathPolylineLengthKm(points);
    const through = objectives.length > 1 ? ` by way of ${objectives.slice(0, -1).map((s) => s.name).join(", ")}` : "";
    const description = dest
        ? `Drawn on the map: ${giver ? `from ${giver.name} ` : ""}to ${dest.name}${through} (${km.toFixed(1)} km).`
        : `Drawn on the map (${km.toFixed(1)} km)${giver ? ` from ${giver.name}` : ""}. End the route on a spot (or add objectives in the Story tab) to give it a destination.`;
    const mission = createMission(title, description, missionType, giver?.id, objectives.map((s) => s.id));
    if (turnIn) mission.turnInSpotId = turnIn.id;
    const questPath: QuestPath = { id: newQuestPathId(), missionId: mission.id, name: `${title} route`, points: points.map((p) => [p[0], p[1]]), spotIds };
    return { mission, questPath };
}

/**
 * Wires a drawn route into an existing quest: a giver if it has none, the route's other stops as
 * objectives it does not have yet, a turn-in when the route returns. Mutates `mission`; returns
 * the route and what was linked, for the status line.
 */
export function attachRouteToQuest(world: GameWorld, mission: Mission, points: [number, number][]): { questPath: QuestPath; linked: string[] } {
    const { spotIds, stops } = routeSpots(world, points);
    const { giver, objectives, turnIn } = rolesFromStops(stops, !!spotIds[0]);
    const linked: string[] = [];
    if (giver && !mission.startSpotId) {
        mission.startSpotId = giver.id;
        linked.push(`given at ${giver.name}`);
    }
    for (const s of objectives) {
        if (s.id === mission.startSpotId || mission.objectiveSpotIds.includes(s.id)) continue;
        mission.objectiveSpotIds.push(s.id);
        linked.push(`objective ${s.name}`);
    }
    if (turnIn && !mission.turnInSpotId) {
        mission.turnInSpotId = turnIn.id;
        linked.push(`turned in at ${turnIn.name}`);
    }
    const k = questPathsOf(world, mission.id).length + 1;
    const questPath: QuestPath = { id: newQuestPathId(), missionId: mission.id, name: k > 1 ? `${mission.title} route ${k}` : `${mission.title} route`, points: points.map((p) => [p[0], p[1]]), spotIds };
    return { questPath, linked };
}

/** Points that sat on a spot follow it when it moves. */
export function followSpot(world: GameWorld, spotId: string, x: number, y: number): void {
    for (const q of world.questPaths ?? []) {
        q.spotIds?.forEach((id, i) => {
            if (id === spotId && q.points[i]) q.points[i] = [x, y];
        });
    }
}

/** A deleted spot no longer anchors any route point (the points stay where they are). */
export function forgetSpot(world: GameWorld, spotId: string): void {
    for (const q of world.questPaths ?? []) q.spotIds = q.spotIds?.map((id) => (id === spotId ? null : id));
}

export interface QuestPathTravel {
    distanceKm: number;
    climbM: number;
    descentM: number;
    /** Kilometers of the route that lie under water. */
    waterKm: number;
    /** Kilometers that follow a road, highway or bridge. */
    roadKm: number;
    hours: number;
    formatted: string;
}

/**
 * Travel time along the drawn route itself (not the shortest way), by Naismith's rule: the ground
 * is sampled every ~100 m; distance at the mode's pace (a quarter slower off-road), plus an hour per
 * 600 m climbed on foot (mounts climb at most twice as fast; flyers ignore the ground). Water
 * crossed on land modes is waded or swum at 2 km/h.
 */
export function questPathTravel(world: GameWorld, points: [number, number][], mode: TravelMode = "foot"): QuestPathTravel {
    const t = world.terrain;
    const roads = world.paths.filter((p) => p.pathType !== "river" && p.points.length >= 2);
    const sea = world.meta.seaLevelM;
    const elev = (x: number, y: number) => (t ? sampleTerrain(t, world.meta, x, y) : 100);
    const nearRoad = (x: number, y: number) => roads.some((r) => distToPolyline([x, y], r.points) <= 0.08);
    const modeFactor = (BASE_SPEEDS[mode]?.speedKmH ?? 4.5) / BASE_SPEEDS.foot.speedKmH;
    let dist = 0, climb = 0, descent = 0, water = 0, road = 0, hours = 0;
    for (let i = 0; i < points.length - 1; i++) {
        const [ax, ay] = points[i];
        const [bx, by] = points[i + 1];
        const len = Math.hypot(bx - ax, by - ay);
        const n = Math.max(1, Math.ceil(len / 0.1));
        let prev = elev(ax, ay);
        for (let k = 1; k <= n; k++) {
            const f = k / n;
            const x = ax + (bx - ax) * f;
            const y = ay + (by - ay) * f;
            const e = elev(x, y);
            const step = len / n;
            const dh = e - prev;
            prev = e;
            dist += step;
            if (dh > 0) climb += dh;
            else descent -= dh;
            if (e <= sea && mode !== "air" && mode !== "water") {
                water += step;
                hours += step / 2.0; // swimming or wading: slow
                continue;
            }
            const onRoad = nearRoad(x, y);
            if (onRoad) road += step;
            const surface = mode === "air" ? 1 : onRoad ? 1 : 0.75;
            hours += step / (BASE_SPEEDS.foot.speedKmH * modeFactor * surface);
            if (mode !== "air" && dh > 0) hours += dh / 600 / Math.min(2, modeFactor);
        }
    }
    return {
        distanceKm: Math.round(dist * 100) / 100,
        climbM: Math.round(climb),
        descentM: Math.round(descent),
        waterKm: Math.round(water * 100) / 100,
        roadKm: Math.round(road * 100) / 100,
        hours,
        formatted: formatDuration(hours),
    };
}

function distToPolyline(p: [number, number], pts: [number, number][]): number {
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[i + 1];
        const dx = bx - ax, dy = by - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(p[0] - (ax + dx * t), p[1] - (ay + dy * t)));
    }
    return best;
}
