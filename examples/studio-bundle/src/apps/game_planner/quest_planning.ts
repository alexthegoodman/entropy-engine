// Richer quest planning, all optional: who gives a quest (not only where), what happens at each
// objective (talk to whom, defeat what, collect how many), the level it is tuned for, rewards and
// faction standing, branching outcomes - and a planning check that reads all of it against the map:
// the journey's real travel time over terrain and roads, time spent at each objective, how
// dangerous the objectives' ground is for the quest's level, whether the enemies and NPCs the
// quest names are actually placed or painted where it needs them, and how it sits in the story.

import type {
    CodexEntry,
    GameWorld,
    Mission,
    ObjectiveAction,
    QuestObjectiveDetail,
    TravelMode,
    WorldSpot,
} from "./planner_types";
import { calculateTravelTime, formatDuration } from "./travel_calculator";
import { dangerAt, placementsOf, populationAt, codexLayerKey, markAt } from "./planning_layers";

export const OBJECTIVE_ACTIONS: ObjectiveAction[] = ["go", "talk", "defeat", "collect", "escort", "defend", "investigate", "deliver", "use"];

export const ACTION_INFO: Record<ObjectiveAction, { label: string; minutes: number; verb: string }> = {
    go: { label: "Go to", minutes: 2, verb: "reach" },
    talk: { label: "Talk to", minutes: 4, verb: "talk to" },
    defeat: { label: "Defeat", minutes: 8, verb: "defeat" },
    collect: { label: "Collect", minutes: 6, verb: "collect" },
    escort: { label: "Escort", minutes: 10, verb: "escort" },
    defend: { label: "Defend", minutes: 10, verb: "defend" },
    investigate: { label: "Investigate", minutes: 7, verb: "investigate" },
    deliver: { label: "Deliver", minutes: 3, verb: "deliver to" },
    use: { label: "Use / activate", minutes: 3, verb: "use" },
};

/** The categories an objective's target is chosen from, by action. */
export function targetCategoriesFor(action: ObjectiveAction): Array<CodexEntry["category"]> {
    switch (action) {
        case "talk":
        case "escort":
        case "deliver":
            return ["character"];
        case "defeat":
            return ["creature", "character", "faction"];
        case "collect":
        case "use":
            return ["weapon", "power", "lore"];
        case "defend":
            return ["character", "faction"];
        case "investigate":
            return ["lore", "creature", "character"];
        default:
            return [];
    }
}

/** Minutes spent at one objective: the designer's estimate, or the action's default (scaled by count for kills and pickups). */
export function objectiveMinutes(d: QuestObjectiveDetail | undefined): number {
    if (!d) return ACTION_INFO.go.minutes;
    if (d.minutes && d.minutes > 0) return d.minutes;
    const base = ACTION_INFO[d.action]?.minutes ?? 3;
    const n = Math.max(1, d.count ?? 1);
    return d.action === "defeat" || d.action === "collect" ? Math.round(base * (0.6 + 0.4 * Math.min(n, 12))) : base;
}

/**
 * The danger level a quest of this level is comfortable in. Levels 1..50 map onto danger 1..10
 * (one danger step per five levels); it is a planning heuristic, not a balance formula.
 */
export function comfortableDanger(level: number): number {
    return Math.max(1, Math.min(10, Math.round(level / 5) + 1));
}

export interface QuestLeg {
    from: string;
    to: string;
    distanceKm: number;
    minutes: number;
    byRoad: boolean;
}

export interface QuestIssue {
    severity: "warn" | "info";
    text: string;
}

export interface QuestAnalysis {
    stops: WorldSpot[];
    legs: QuestLeg[];
    travelMinutes: number;
    activityMinutes: number;
    totalMinutes: number;
    /** Highest danger along the stops (regions, dangerous spots). */
    peakDanger: number;
    /** Missions this one unlocks: those requiring it, and those its outcomes open. */
    unlocks: Mission[];
    /** How many prerequisite steps lie before it (0 = can start right away). */
    chainDepth: number;
    issues: QuestIssue[];
    summary: string;
}

const MODE: TravelMode = "foot";

function chainDepth(world: GameWorld, m: Mission, seen = new Set<string>()): number {
    if (seen.has(m.id)) return 0;
    seen.add(m.id);
    let d = 0;
    for (const pid of m.prerequisiteMissionIds ?? []) {
        const p = world.missions.find((x) => x.id === pid);
        if (p) d = Math.max(d, 1 + chainDepth(world, p, seen));
    }
    return d;
}

/** Where a mission sits in the chronological story: [act number, chapter number], or null. */
export function storyPosition(world: GameWorld, missionId: string): [number, number] | null {
    for (const act of world.acts) {
        for (const ch of act.chapters) {
            if (ch.missionIds.includes(missionId)) return [act.actNumber, ch.chapterNumber];
        }
    }
    return null;
}

/** The mission's stops in order: giver, objectives, turn-in (back to the giver when none). */
export function questStops(world: GameWorld, m: Mission): WorldSpot[] {
    const byId = (id?: string) => (id ? world.spots.find((s) => s.id === id) : undefined);
    const giver = byId(m.startSpotId);
    const objectives = m.objectiveSpotIds.map((id) => byId(id)).filter((s): s is WorldSpot => !!s);
    const turnIn = byId(m.turnInSpotId) ?? giver;
    return [giver, ...objectives, turnIn].filter((s): s is WorldSpot => !!s);
}

function codexName(world: GameWorld, id?: string): string {
    return (id && world.codex.find((c) => c.id === id)?.name) || "(missing codex entry)";
}

/** Whether a codex entry is on the map near a place: placed within `km`, painted there, or linked to a spot nearby. */
function presentNear(world: GameWorld, codexId: string, x: number, y: number, km: number): boolean {
    if (placementsOf(world, codexId).some((p) => Math.hypot(p.x - x, p.y - y) <= km)) return true;
    // Painted presence anywhere within the radius (sampled on a small ring).
    for (const [dx, dy] of [[0, 0], [km * 0.5, 0], [-km * 0.5, 0], [0, km * 0.5], [0, -km * 0.5]]) {
        if (markAt(world.overlay, world.meta, codexLayerKey(codexId), x + dx, y + dy) > 0.05) return true;
    }
    return world.spots.some((s) => Math.hypot(s.x - x, s.y - y) <= km && s.linkedCodexIds?.includes(codexId));
}

export function analyzeQuest(world: GameWorld, m: Mission): QuestAnalysis {
    const stops = questStops(world, m);
    const t = world.terrain;
    const legs: QuestLeg[] = [];
    for (let i = 0; i < stops.length - 1; i++) {
        const a = stops[i];
        const b = stops[i + 1];
        if (a.id === b.id) continue;
        const est = calculateTravelTime(a, b, world.paths, world.regions, t ? { terrain: t, meta: world.meta } : undefined);
        const e = est.estimates[MODE];
        legs.push({ from: a.name, to: b.name, distanceKm: est.directDistanceKm, minutes: e.hours * 60 + e.minutes, byRoad: est.pathFound });
    }
    const travelMinutes = legs.reduce((s, l) => s + l.minutes, 0);
    const details = m.objectiveDetails ?? {};
    const activityMinutes = m.objectiveSpotIds.reduce((s, id) => s + (details[id]?.optional ? 0 : objectiveMinutes(details[id])), 0) + (m.startSpotId ? 2 : 0);
    const issues: QuestIssue[] = [];

    // Danger for the quest's level.
    let peakDanger = 0;
    const level = m.levelMax ?? m.levelMin;
    for (const id of m.objectiveSpotIds) {
        const s = world.spots.find((x) => x.id === id);
        if (!s) continue;
        const d = dangerAt(world, s.x, s.y);
        peakDanger = Math.max(peakDanger, d);
        if (level !== undefined && d > comfortableDanger(level) + 2) {
            issues.push({ severity: "warn", text: `${s.name} is danger ${d}, steep for a level ${level} quest (comfortable: ~${comfortableDanger(level)}).` });
        }
    }
    if (level !== undefined && m.levelMin !== undefined && m.levelMax !== undefined && m.levelMin > m.levelMax) {
        issues.push({ severity: "warn", text: `Level range is backwards (${m.levelMin}-${m.levelMax}).` });
    }

    // Who the quest names, and whether they are on the map where it needs them.
    const giverSpot = world.spots.find((s) => s.id === m.startSpotId);
    if (m.giverCodexId) {
        const name = codexName(world, m.giverCodexId);
        if (giverSpot && !presentNear(world, m.giverCodexId, giverSpot.x, giverSpot.y, 0.8)) {
            issues.push({ severity: "info", text: `${name} gives the quest at ${giverSpot.name}, but isn't placed there yet (Populate tool, or link them to the spot).` });
        }
        if (!giverSpot) issues.push({ severity: "info", text: `${name} gives the quest - set where (the quest giver spot).` });
    }
    for (const id of m.objectiveSpotIds) {
        const s = world.spots.find((x) => x.id === id);
        const d = details[id];
        if (!s || !d?.targetCodexId) continue;
        const name = codexName(world, d.targetCodexId);
        if (!presentNear(world, d.targetCodexId, s.x, s.y, 1.0)) {
            const verb = ACTION_INFO[d.action]?.verb ?? "find";
            issues.push({ severity: "warn", text: `The player must ${verb} ${name} at ${s.name}, but ${name} isn't placed or painted near it.` });
        }
        if (d.action === "defeat") {
            const others = populationAt(world, s.x, s.y, 1.0).filter((p) => p.codex.category === "creature" && p.codex.id !== d.targetCodexId);
            if (others.length) issues.push({ severity: "info", text: `${s.name} is also home to ${others.map((o) => o.codex.name).join(", ")}.` });
        }
    }
    for (const rid of m.requiredCodexIds ?? []) {
        const c = world.codex.find((x) => x.id === rid);
        if (!c) issues.push({ severity: "warn", text: "Requires a codex entry that no longer exists." });
    }

    // Enemies along the way: painted creature layers sampled along each leg.
    if (world.overlay && stops.length >= 2) {
        const seen = new Map<string, number>();
        for (let i = 0; i < stops.length - 1; i++) {
            const a = stops[i];
            const b = stops[i + 1];
            for (let k = 1; k < 10; k++) {
                const x = a.x + ((b.x - a.x) * k) / 10;
                const y = a.y + ((b.y - a.y) * k) / 10;
                for (const p of populationAt(world, x, y, 0.3)) {
                    if (p.codex.category === "creature") seen.set(p.codex.name, Math.max(seen.get(p.codex.name) ?? 0, p.painted || 1));
                }
            }
        }
        if (seen.size) issues.push({ severity: "info", text: `On the way: ${[...seen.keys()].join(", ")}.` });
    }

    // How it sits in the story.
    const pos = storyPosition(world, m.id);
    for (const pid of m.prerequisiteMissionIds ?? []) {
        const p = world.missions.find((x) => x.id === pid);
        if (!p) {
            issues.push({ severity: "warn", text: "A prerequisite quest no longer exists." });
            continue;
        }
        const pp = storyPosition(world, pid);
        if (pos && pp && (pp[0] > pos[0] || (pp[0] === pos[0] && pp[1] > pos[1]))) {
            issues.push({ severity: "warn", text: `Requires "${p.title}", which comes later in the story (Act ${pp[0]} Ch. ${pp[1]}).` });
        }
        const pl = p.levelMin ?? p.levelMax;
        const ml = m.levelMin ?? m.levelMax;
        if (pl !== undefined && ml !== undefined && pl > ml) {
            issues.push({ severity: "info", text: `Requires "${p.title}" (level ${pl}+), but is itself tuned for level ${ml}.` });
        }
    }
    const unlocks = world.missions.filter(
        (x) => x.id !== m.id && (x.prerequisiteMissionIds?.includes(m.id) || (m.outcomes ?? []).some((o) => o.unlocksMissionIds.includes(x.id)))
    );
    for (const o of m.outcomes ?? []) {
        if (!o.label.trim()) issues.push({ severity: "info", text: "An outcome has no label." });
    }
    if (legs.length && legs.every((l) => !l.byRoad) && travelMinutes > 90) {
        issues.push({ severity: "info", text: `The whole ${formatDuration(travelMinutes / 60)} journey is cross-country - no road helps.` });
    }

    const totalMinutes = travelMinutes + activityMinutes;
    const summary = stops.length >= 2
        ? `${formatDuration(totalMinutes / 60)} on foot (${formatDuration(travelMinutes / 60)} travel + ${formatDuration(activityMinutes / 60)} at objectives)`
        : "Set a quest giver and an objective to estimate it.";
    return { stops, legs, travelMinutes, activityMinutes, totalMinutes, peakDanger, unlocks, chainDepth: chainDepth(world, m), issues, summary };
}

/** One-line description of an objective, for lists and the design doc. */
export function describeObjective(world: GameWorld, spot: WorldSpot | undefined, d: QuestObjectiveDetail | undefined): string {
    const where = spot ? spot.name : "(missing spot)";
    if (!d) return `Go to ${where}`;
    const label = ACTION_INFO[d.action]?.label ?? "Go to";
    const target = d.targetCodexId ? codexName(world, d.targetCodexId) : "";
    const count = d.count && d.count > 1 ? `${d.count} ` : "";
    const what = target ? `${label} ${count}${target} at ${where}` : d.action === "go" ? `Go to ${where}` : `${label} at ${where}`;
    return `${what}${d.optional ? " (optional)" : ""}${d.note ? ` - ${d.note}` : ""}`;
}
