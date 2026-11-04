import type {
    Mission,
    MissionType,
    StoryAct,
    StoryChapter,
    WorldPath,
    WorldRegion,
    WorldSpot,
} from "./planner_types";

export function createMission(
    title: string,
    description: string,
    missionType: MissionType = "main",
    startSpotId?: string,
    objectiveSpotIds: string[] = []
): Mission {
    return {
        id: `mission_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        title,
        description,
        missionType,
        startSpotId,
        objectiveSpotIds,
        objectivePathIds: [],
        objectiveRegionIds: [],
        requiredCodexIds: [],
        prerequisiteMissionIds: [],
        rewardXp: 1200,
        rewardItems: [],
        status: "available",
    };
}

export function linkMissionToSpot(mission: Mission, spot: WorldSpot, role: "start" | "objective" | "turnin"): void {
    if (role === "start") {
        mission.startSpotId = spot.id;
    } else if (role === "objective") {
        if (!mission.objectiveSpotIds.includes(spot.id)) {
            mission.objectiveSpotIds.push(spot.id);
        }
    } else if (role === "turnin") {
        mission.turnInSpotId = spot.id;
    }

    if (!spot.linkedMissionIds) {
        spot.linkedMissionIds = [];
    }
    if (!spot.linkedMissionIds.includes(mission.id)) {
        spot.linkedMissionIds.push(mission.id);
    }
}

export function linkMissionToPath(mission: Mission, path: WorldPath): void {
    if (!mission.objectivePathIds.includes(path.id)) {
        mission.objectivePathIds.push(path.id);
    }
}

export function linkMissionToRegion(mission: Mission, region: WorldRegion): void {
    if (!mission.objectiveRegionIds.includes(region.id)) {
        mission.objectiveRegionIds.push(region.id);
    }
}

/**
 * Validates quest DAG dependencies and detects cycles.
 */
export function validateQuestGraph(missions: Mission[]): { valid: boolean; cycle?: string[] } {
    const adj = new Map<string, string[]>();
    missions.forEach((m) => adj.set(m.id, m.prerequisiteMissionIds || []));

    const visited = new Set<string>();
    const recStack = new Set<string>();

    function isCyclic(node: string, path: string[]): string[] | null {
        visited.add(node);
        recStack.add(node);
        path.push(node);

        const neighbors = adj.get(node) || [];
        for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
                const cycle = isCyclic(neighbor, [...path]);
                if (cycle) return cycle;
            } else if (recStack.has(neighbor)) {
                return [...path, neighbor];
            }
        }

        recStack.delete(node);
        return null;
    }

    for (const m of missions) {
        if (!visited.has(m.id)) {
            const cycle = isCyclic(m.id, []);
            if (cycle) return { valid: false, cycle };
        }
    }

    return { valid: true };
}

/**
 * Calculates which missions are currently unlocked based on completed prerequisites.
 */
export function computeAvailableMissions(missions: Mission[], completedMissionIds: Set<string>): Mission[] {
    return missions.filter((m) => {
        if (completedMissionIds.has(m.id)) return false;
        // Check if all prerequisites are fulfilled
        return (m.prerequisiteMissionIds || []).every((prereqId) => completedMissionIds.has(prereqId));
    });
}

/**
 * Formats chronological story progression hierarchy.
 */
export function getChronologicalActs(acts: StoryAct[], missions: Mission[]): Array<{
    act: StoryAct;
    chapters: Array<{ chapter: StoryChapter; missions: Mission[] }>;
}> {
    const missionMap = new Map(missions.map((m) => [m.id, m]));

    return acts.map((act) => ({
        act,
        chapters: act.chapters.map((chap) => ({
            chapter: chap,
            missions: chap.missionIds.map((id) => missionMap.get(id)).filter(Boolean) as Mission[],
        })),
    }));
}
