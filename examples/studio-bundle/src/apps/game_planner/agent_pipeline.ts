import type {
    GameWorld,
    RevisionChange,
    RevisionProposal,
} from "./planner_types";

/**
 * Serializes the complete game world into a structured JSON string (World Bible).
 */
export function exportWorldBibleJson(world: GameWorld): string {
    return JSON.stringify(
        {
            schemaVersion: "1.0.0",
            exportedAt: new Date().toISOString(),
            ...world,
        },
        null,
        2
    );
}

/**
 * Generates a comprehensive, human and agent readable Game Design Document in Markdown.
 */
export function generateGameDesignDoc(world: GameWorld): string {
    const { meta, spots, paths, regions, codex, missions, acts } = world;

    let md = `# Game Design Document: ${meta.name}\n\n`;
    md += `**Genre:** ${meta.genre.toUpperCase()} | **Scale:** ${meta.worldWidthKm} x ${meta.worldHeightKm} km | **Seed:** ${meta.seed}\n\n`;
    md += `## 1. World Setting & Synopsis\n\n${meta.description}\n\n`;

    md += `## 2. Regions & Biomes\n\n`;
    regions.forEach((r, idx) => {
        md += `### 2.${idx + 1} ${r.name} (${r.regionType.toUpperCase()})\n`;
        md += `- **Dominant Biome:** ${r.dominantBiome}\n`;
        md += `- **Danger Level:** ${r.dangerLevel}/10\n`;
        md += `- **Description:** ${r.description}\n\n`;
    });

    md += `## 3. Atlas of Locations (Points of Interest)\n\n`;
    spots.forEach((s, idx) => {
        md += `### 3.${idx + 1} ${s.name} [${s.spotType.toUpperCase()}]\n`;
        md += `- **Coordinates:** [X: ${s.x} km, Y: ${s.y} km] | **Elevation:** ${s.elevation}m\n`;
        md += `- **Tags:** ${s.tags.join(", ") || "none"}\n`;
        md += `- **Description:** ${s.description}\n`;
        md += `- **Lore & Background:** ${s.loreNotes}\n`;
        if (s.conceptPrompt) {
            md += `- **Visual Art Prompt:** \`${s.conceptPrompt}\`\n`;
        }
        md += `\n`;
    });

    md += `## 4. Roads, Rivers & Transit Corridors\n\n`;
    paths.forEach((p, idx) => {
        md += `- **${p.name}** (${p.pathType.toUpperCase()}): ${p.points.length} waypoints, width ${p.width}m. ${p.description || ""}\n`;
    });
    md += `\n`;

    md += `## 5. Codex Database\n\n`;
    const categories = ["character", "power", "weapon", "faction", "lore"] as const;
    categories.forEach((cat) => {
        const entries = codex.filter((c) => c.category === cat);
        if (entries.length > 0) {
            md += `### 5.${cat.toUpperCase()}S\n\n`;
            entries.forEach((e) => {
                md += `#### ${e.name} — *${e.subtitle}*\n`;
                md += `${e.description}\n`;
                const attrs = Object.entries(e.attributes)
                    .map(([k, v]) => `**${k}:** ${v}`)
                    .join(" | ");
                if (attrs) md += `\n*Attributes:* ${attrs}\n`;
                if (e.conceptImagePrompt) md += `\n*Visual Prompt:* \`${e.conceptImagePrompt}\`\n`;
                md += `\n`;
            });
        }
    });

    md += `## 6. Narrative Missions & Story Structure\n\n`;
    if (acts.length > 0) {
        md += `### Chronological Acts\n\n`;
        acts.forEach((act) => {
            md += `#### Act ${act.actNumber}: ${act.title}\n*Theme: ${act.theme}*\n\n`;
            act.chapters.forEach((chap) => {
                md += `- **Chapter ${chap.chapterNumber}: ${chap.title}**\n  ${chap.summary}\n`;
            });
            md += `\n`;
        });
    }

    md += `### Quest List\n\n`;
    missions.forEach((m) => {
        md += `#### Quest: ${m.title} [${m.missionType.toUpperCase()}]\n`;
        md += `${m.description}\n`;
        md += `- **Reward:** ${m.rewardXp} XP\n`;
        if (m.prerequisiteMissionIds.length > 0) {
            md += `- **Prerequisites:** ${m.prerequisiteMissionIds.join(", ")}\n`;
        }
        md += `\n`;
    });

    return md;
}

/**
 * Generates specialized LLM system prompts for agentic game creation.
 */
export function generateAgentPrompts(world: GameWorld): {
    gameMasterPrompt: string;
    levelDesignerPrompt: string;
    npcRoleplayPrompt: string;
} {
    const spotSummary = world.spots.map((s) => `${s.name} (${s.spotType}) at [${s.x}, ${s.y}]km`).join(", ");
    const factionSummary = world.codex.filter((c) => c.category === "faction").map((f) => f.name).join(", ");

    const gameMasterPrompt = `You are the Game Master and Lead Narrative Director for "${world.meta.name}", a ${world.meta.genre} game world.
World Overview: ${world.meta.description}
Key Settlements & POIs: ${spotSummary}
Factions in play: ${factionSummary || "Regional lords and wild creatures"}
Your role is to simulate immersive encounters, balance player travel times across the map, enforce narrative causality, and generate authentic dialogue grounded in this world's geography and codex.`;

    const levelDesignerPrompt = `You are the Lead Technical Level Designer building "${world.meta.name}".
Map Bounds: ${world.meta.worldWidthKm} x ${world.meta.worldHeightKm} kilometers.
Sea level is ${world.meta.seaLevelM}m.
Use the topological elevation data and road networks to place sub-district blocking, bridge spans over rivers, and encounter triggers that adhere to player travel pacing (4.5 km/h walking, 24 km/h mounted).`;

    const npcRoleplayPrompt = `You are roleplaying NPCs within "${world.meta.name}".
Always remain in-character, reference local landmarks (${spotSummary.slice(0, 150)}...), and speak with dialect and knowledge consistent with your faction and regional origin.`;

    return {
        gameMasterPrompt,
        levelDesignerPrompt,
        npcRoleplayPrompt,
    };
}

/**
 * Simulates an AI Agent proposing revisions to the world plan.
 */
export function createSampleAgentProposal(world: GameWorld): RevisionProposal {
    const changes: RevisionChange[] = [];

    // Propose a new hidden dungeon
    changes.push({
        id: "prop_change_1",
        changeType: "add_spot",
        targetId: `spot_ai_${Date.now()}_1`,
        title: "Add Sunken Crypt of the Forgotten King",
        summary: "Place a high-tier dungeon ruin in the southern marshlands to reward exploration.",
        after: {
            name: "Sunken Crypt of the Forgotten King",
            spotType: "dungeon",
            x: -4.5,
            y: -6.2,
            elevation: 45,
            color: [0.95, 0.25, 0.35, 1.0],
            icon: "skull",
            tags: ["dungeon", "tier-4", "undead", "legendary-loot"],
            isMajor: false,
            description: "A partially submerged necropolis harboring pre-cataclysm relics and ancient specters.",
            loreNotes: "Sealed by royal decree two centuries ago.",
            conceptPrompt: "Sunken Gothic crypt emerging from murky bayou waters, glowing will-o-wisps, hyperrealistic fantasy concept art",
            linkedCodexIds: [],
            linkedMissionIds: [],
        },
        status: "pending",
    });

    // Propose adding a trade road connection
    if (world.spots.length >= 2) {
        const s1 = world.spots[0];
        const s2 = world.spots[1];
        changes.push({
            id: "prop_change_2",
            changeType: "add_path",
            targetId: `path_ai_${Date.now()}_2`,
            title: `Add Trade Route: ${s1.name} to ${s2.name}`,
            summary: "Create a cobblestone road to reduce travel time between these two major settlements by 35%.",
            after: {
                name: `${s1.name}–${s2.name} Byway`,
                pathType: "road",
                points: [[s1.x, s1.y], [(s1.x + s2.x) * 0.5, (s1.y + s2.y) * 0.5], [s2.x, s2.y]],
                width: 3.8,
                color: [0.8, 0.7, 0.5, 1.0],
                isMajor: true,
                flowSpeed: 0,
                surfaceQuality: 1.0,
                description: "Paved trading road commissioned to expedite commerce.",
            },
            status: "pending",
        });
    }

    return {
        id: `proposal_${Date.now()}`,
        agentName: "Agent-Cartographer-7",
        timestamp: Date.now(),
        motivation: "Optimize travel routes between primary hubs and populate under-utilized wilderness zones with high-risk exploration targets.",
        changes,
    };
}

/**
 * Applies accepted changes from an agent revision proposal into the live world.
 */
export function applyRevisionProposal(
    world: GameWorld,
    proposal: RevisionProposal,
    acceptedChangeIds?: string[]
): { appliedCount: number; rejectedCount: number } {
    let appliedCount = 0;
    let rejectedCount = 0;

    proposal.changes.forEach((change) => {
        const shouldApply = acceptedChangeIds ? acceptedChangeIds.includes(change.id) : change.status === "accepted";

        if (shouldApply) {
            change.status = "accepted";
            appliedCount++;

            if (change.changeType === "add_spot") {
                const newSpot = { ...change.after, id: change.targetId };
                // Ensure no duplicate id
                if (!world.spots.some((s) => s.id === newSpot.id)) {
                    world.spots.push(newSpot);
                }
            } else if (change.changeType === "modify_spot") {
                const idx = world.spots.findIndex((s) => s.id === change.targetId);
                if (idx !== -1) {
                    world.spots[idx] = { ...world.spots[idx], ...change.after };
                }
            } else if (change.changeType === "delete_spot") {
                world.spots = world.spots.filter((s) => s.id !== change.targetId);
            } else if (change.changeType === "add_path") {
                const newPath = { ...change.after, id: change.targetId };
                if (!world.paths.some((p) => p.id === newPath.id)) {
                    world.paths.push(newPath);
                }
            }
        } else {
            change.status = "rejected";
            rejectedCount++;
        }
    });

    return { appliedCount, rejectedCount };
}

export interface ProposalDiffItem {
    changeId: string;
    action: "add" | "modify" | "delete";
    entityType: string;
    title: string;
    summary: string;
}

/**
 * Calculates a structured summary diff between the world and a proposed revision.
 */
export function diffWorldWithProposal(
    _world: GameWorld,
    proposal: RevisionProposal
): ProposalDiffItem[] {
    return proposal.changes.map((c) => {
        let action: "add" | "modify" | "delete" = "modify";
        if (c.changeType.startsWith("add_")) action = "add";
        else if (c.changeType.startsWith("delete_")) action = "delete";

        let entityType = "spot";
        if (c.changeType.includes("path")) entityType = "path";
        else if (c.changeType.includes("region")) entityType = "region";
        else if (c.changeType.includes("codex")) entityType = "codex";
        else if (c.changeType.includes("mission")) entityType = "mission";
        else if (c.changeType.includes("landscape")) entityType = "landscape";

        return {
            changeId: c.id,
            action,
            entityType,
            title: c.title,
            summary: c.summary,
        };
    });
}
