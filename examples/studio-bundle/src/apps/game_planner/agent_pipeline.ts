import type {
    GameWorld,
    RevisionChange,
    RevisionProposal,
} from "./planner_types";
import { extractTerrainContours } from "./terrain";
import { evaluateIntent, intentPoints } from "./intent_model";
import { codexMapPresence, layerCoverage, layerLabel, placementsInside } from "./planning_layers";
import { analyzeQuest, describeObjective } from "./quest_planning";

const escapeXml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
        const faction = r.controllingFactionId ? codex.find((c) => c.id === r.controllingFactionId) : undefined;
        if (faction) md += `- **Held by:** ${faction.name}\n`;
        md += `- **Description:** ${r.description}\n`;
        const plan = r.plan ?? {};
        const planRows: Array<[string, string | undefined]> = [
            ["Climate", plan.climate],
            ["Flora", plan.flora],
            ["Fauna", plan.fauna],
            ["Resources", plan.resources],
            ["Mood", plan.mood],
            ["Levels", plan.levelMin !== undefined || plan.levelMax !== undefined ? `${plan.levelMin ?? "?"}-${plan.levelMax ?? "?"}` : undefined],
            ["Notes", plan.notes],
        ];
        planRows.filter(([, v]) => v).forEach(([k, v]) => (md += `- **${k}:** ${v}\n`));
        const painted = r.points.length >= 3 ? layerCoverage(world.overlay, meta, r.points).slice(0, 6) : [];
        if (painted.length) md += `- **Painted:** ${painted.map((c) => `${layerLabel(world, c.key)} ${Math.round(c.share * 100)}%`).join(", ")}\n`;
        const placed = r.points.length >= 3 ? placementsInside(world, r.points) : [];
        if (placed.length) md += `- **Population:** ${placed.map((p) => `${codex.find((c) => c.id === p.codexId)?.name ?? "?"} x${p.count} (${p.behavior})`).join(", ")}\n`;
        md += `\n`;
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
    const categories = ["character", "creature", "power", "weapon", "faction", "lore"] as const;
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
                const where = codexMapPresence(world, e);
                const bits = [
                    where.spots.length ? `at ${where.spots.map((s) => s.name).join(", ")}` : "",
                    where.placements.length ? `${where.placements.reduce((n, p) => n + p.count, 0)} placed` : "",
                    where.paintedKm2 ? `painted over ${where.paintedKm2} km²` : "",
                    where.regions.length ? `in ${where.regions.map((r) => r.name).join(", ")}` : "",
                ].filter(Boolean);
                if (bits.length) md += `\n*On the map:* ${bits.join("; ")}\n`;
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
        if (m.hook) md += `- **Hook:** ${m.hook}\n`;
        const name = (id?: string) => codex.find((c) => c.id === id)?.name;
        const giverSpot = spots.find((s) => s.id === m.startSpotId);
        if (m.giverCodexId || giverSpot) md += `- **Given by:** ${[name(m.giverCodexId), giverSpot ? `at ${giverSpot.name}` : ""].filter(Boolean).join(" ")}\n`;
        if (m.levelMin !== undefined || m.levelMax !== undefined) md += `- **Level:** ${m.levelMin ?? "?"}-${m.levelMax ?? "?"}\n`;
        m.objectiveSpotIds.forEach((id, k) => {
            md += `  ${k + 1}. ${describeObjective(world, spots.find((s) => s.id === id), m.objectiveDetails?.[id])}\n`;
        });
        const rewards = [`${m.rewardXp} XP`, ...(m.rewardCodexIds ?? []).map((id) => name(id)).filter(Boolean), ...(m.rewardItems ?? [])];
        md += `- **Reward:** ${rewards.join(", ")}\n`;
        if (m.reputation?.length) md += `- **Standing:** ${m.reputation.map((r) => `${name(r.factionId) ?? "?"} ${r.amount >= 0 ? "+" : ""}${r.amount}`).join(", ")}\n`;
        if (m.prerequisiteMissionIds.length > 0) {
            md += `- **Prerequisites:** ${m.prerequisiteMissionIds.map((id) => missions.find((x) => x.id === id)?.title ?? id).join(", ")}\n`;
        }
        (m.outcomes ?? []).forEach((o) => {
            const opens = o.unlocksMissionIds.map((id) => missions.find((x) => x.id === id)?.title).filter(Boolean);
            md += `- **Outcome - ${o.label}:** ${o.consequence ?? ""}${opens.length ? ` Opens: ${opens.join(", ")}.` : ""}\n`;
        });
        const a = analyzeQuest(world, m);
        if (a.stops.length >= 2) md += `- **Estimate:** ${a.summary}\n`;
        a.issues.filter((i) => i.severity === "warn").forEach((i) => (md += `- ⚠ ${i.text}\n`));
        md += `\n`;
    });

    const intents = (world.intents ?? []).filter((i) => i.status !== "dismissed");
    if (intents.length) {
        md += `## 7. Design Intent\n\n`;
        md += `What the designer asked for on the map, and whether the world delivers it now.\n\n`;
        intents.forEach((i) => {
            const ev = evaluateIntent(world, i);
            const mark = ev.satisfied === null ? "◻" : ev.satisfied ? "✓" : "✗";
            md += `- ${mark} **#${i.number} ${i.title}** (${i.kind}) - ${ev.summary}${i.directive ? `. _${i.directive}_` : ""}\n`;
        });
        md += `\n`;
    }

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
 * Makes one proposed change real. Returns false when it cannot apply (its target is gone, or the
 * thing it adds already exists). References to ids that are neither in the world nor pending in
 * the same proposal are dropped from added missions.
 */
export function applyRevisionChange(world: GameWorld, change: RevisionChange, proposal?: RevisionProposal): boolean {
    const after = change.after ?? {};
    const id = change.targetId;
    switch (change.changeType) {
        case "add_spot":
            if (world.spots.some((s) => s.id === id)) return false;
            world.spots.push({ ...after, id });
            return true;
        case "modify_spot": {
            const s = world.spots.find((x) => x.id === id);
            if (!s) return false;
            Object.assign(s, after, { id });
            return true;
        }
        case "delete_spot": {
            const n = world.spots.length;
            world.spots = world.spots.filter((s) => s.id !== id);
            world.missions.forEach((m) => {
                if (m.startSpotId === id) delete m.startSpotId;
                if (m.turnInSpotId === id) delete m.turnInSpotId;
                m.objectiveSpotIds = m.objectiveSpotIds.filter((x) => x !== id);
            });
            world.codex.forEach((c) => (c.linkedSpotIds = c.linkedSpotIds.filter((x) => x !== id)));
            return world.spots.length < n;
        }
        case "add_path":
            if (world.paths.some((p) => p.id === id)) return false;
            world.paths.push({ ...after, id });
            return true;
        case "modify_path": {
            const p = world.paths.find((x) => x.id === id);
            if (!p) return false;
            Object.assign(p, after, { id });
            return true;
        }
        case "delete_path": {
            const n = world.paths.length;
            world.paths = world.paths.filter((p) => p.id !== id);
            world.missions.forEach((m) => (m.objectivePathIds = m.objectivePathIds.filter((x) => x !== id)));
            return world.paths.length < n;
        }
        case "add_region":
            if (world.regions.some((r) => r.id === id)) return false;
            world.regions.push({ ...after, id });
            return true;
        case "modify_region": {
            const r = world.regions.find((x) => x.id === id);
            if (!r) return false;
            Object.assign(r, after, { id });
            return true;
        }
        case "add_mission": {
            if (world.missions.some((m) => m.id === id)) return false;
            const pendingIds = new Set((proposal?.changes ?? []).filter((c) => c.status === "pending" && c.id !== change.id).map((c) => c.targetId));
            const known = (sid?: string) => !!sid && (world.spots.some((s) => s.id === sid) || pendingIds.has(sid));
            const m = { objectivePathIds: [], objectiveRegionIds: [], requiredCodexIds: [], prerequisiteMissionIds: [], rewardItems: [], rewardXp: 1000, status: "available", missionType: "side", description: "", ...after, id } as any;
            m.objectiveSpotIds = (m.objectiveSpotIds ?? []).filter(known);
            if (m.startSpotId && !known(m.startSpotId)) delete m.startSpotId;
            if (m.turnInSpotId && !known(m.turnInSpotId)) delete m.turnInSpotId;
            world.missions.push(m);
            for (const sid of [m.startSpotId, ...m.objectiveSpotIds, m.turnInSpotId]) {
                const s = world.spots.find((x) => x.id === sid);
                if (s && !s.linkedMissionIds.includes(id)) s.linkedMissionIds.push(id);
            }
            return true;
        }
        case "add_codex":
            if (world.codex.some((c) => c.id === id)) return false;
            world.codex.push({ linkedSpotIds: [], linkedMissionIds: [], tags: [], attributes: {}, subtitle: "", description: "", conceptImagePrompt: "", ...after, id });
            return true;
        default:
            return false;
    }
}

/**
 * Rejecting an added spot also drops it from missions accepted earlier from the same proposal.
 */
export function rejectRevisionChange(world: GameWorld, change: RevisionChange): void {
    change.status = "rejected";
    if (change.changeType === "add_spot") {
        const id = change.targetId;
        world.missions.forEach((m) => {
            if (m.startSpotId === id) delete m.startSpotId;
            if (m.turnInSpotId === id) delete m.turnInSpotId;
            m.objectiveSpotIds = m.objectiveSpotIds.filter((x) => x !== id);
        });
    }
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
            applyRevisionChange(world, change, proposal);
            change.status = "accepted";
            appliedCount++;
        } else {
            rejectRevisionChange(world, change);
            rejectedCount++;
        }
    });

    return { appliedCount, rejectedCount };
}

/** A proposal still waiting on the designer (some change neither accepted nor rejected). */
export function isProposalPending(p: RevisionProposal): boolean {
    return p.changes.some((c) => c.status === "pending");
}

/** What the map draws for a pending change: a translucent preview of what it would make. */
export interface ProposalGhost {
    id: string;
    proposalId: string;
    kind: "spot" | "path" | "region" | "move" | "remove";
    points: [number, number][];
    label: string;
    spotType?: string;
    pathType?: string;
    /** For a move: where it is now. */
    from?: [number, number];
}

export function proposalGhosts(world: GameWorld): ProposalGhost[] {
    const out: ProposalGhost[] = [];
    for (const p of world.proposals) {
        for (const c of p.changes) {
            if (c.status !== "pending") continue;
            const a = c.after ?? {};
            const base = { id: c.id, proposalId: p.id, label: c.title };
            switch (c.changeType) {
                case "add_spot":
                    if (Number.isFinite(a.x) && Number.isFinite(a.y)) out.push({ ...base, kind: "spot", points: [[a.x, a.y]], label: a.name ?? c.title, spotType: a.spotType });
                    break;
                case "modify_spot": {
                    const s = world.spots.find((x) => x.id === c.targetId);
                    if (s && (a.x !== undefined || a.y !== undefined)) out.push({ ...base, kind: "move", points: [[a.x ?? s.x, a.y ?? s.y]], from: [s.x, s.y], label: s.name, spotType: s.spotType });
                    break;
                }
                case "delete_spot": {
                    const s = world.spots.find((x) => x.id === c.targetId);
                    if (s) out.push({ ...base, kind: "remove", points: [[s.x, s.y]], label: s.name, spotType: s.spotType });
                    break;
                }
                case "add_path":
                case "modify_path": {
                    const pts = a.points ?? world.paths.find((x) => x.id === c.targetId)?.points;
                    if (Array.isArray(pts) && pts.length >= 2) out.push({ ...base, kind: "path", points: pts, pathType: a.pathType ?? world.paths.find((x) => x.id === c.targetId)?.pathType ?? "road" });
                    break;
                }
                case "delete_path": {
                    const path = world.paths.find((x) => x.id === c.targetId);
                    if (path) out.push({ ...base, kind: "remove", points: path.points, pathType: path.pathType });
                    break;
                }
                case "add_region":
                case "modify_region": {
                    const pts = a.points ?? world.regions.find((x) => x.id === c.targetId)?.points;
                    if (Array.isArray(pts) && pts.length >= 3) out.push({ ...base, kind: "region", points: pts });
                    break;
                }
                default:
                    break;
            }
        }
    }
    return out;
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

/**
 * Exports a standalone, beautiful Vector SVG map of the game world.
 */
export function exportMapToSvg(world: GameWorld, width = 1200, height = 1200): string {
    const { meta, spots, paths, regions } = world;
    // Contours traced from the heightfield when the world has one (hand-drawn lines otherwise).
    const contours = world.terrain ? extractTerrainContours(world.terrain, meta) : world.contours;
    const halfW = meta.worldWidthKm * 0.5;
    const halfH = meta.worldHeightKm * 0.5;

    const toSvgX = (wx: number) => (((wx + halfW) / meta.worldWidthKm) * (width - 80) + 40).toFixed(1);
    const toSvgY = (wy: number) => (((halfH - wy) / meta.worldHeightKm) * (height - 80) + 40).toFixed(1);

    let svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="background:#0b0e14;font-family:'Segoe UI',sans-serif;">\n`;
    svg += `  <defs>\n`;
    svg += `    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3" result="glow"/><feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge></filter>\n`;
    svg += `  </defs>\n\n`;

    // 1. Grid
    svg += `  <!-- Grid Lines -->\n  <g stroke="rgba(255,255,255,0.06)" stroke-width="1">\n`;
    const gridStep = meta.worldWidthKm > 40 ? 10 : 5;
    for (let x = -halfW; x <= halfW; x += gridStep) {
        svg += `    <line x1="${toSvgX(x)}" y1="40" x2="${toSvgX(x)}" y2="${height - 40}" />\n`;
        svg += `    <text x="${toSvgX(x)}" y="32" fill="#718096" font-size="9" text-anchor="middle">${x}km</text>\n`;
    }
    for (let y = -halfH; y <= halfH; y += gridStep) {
        svg += `    <line x1="40" y1="${toSvgY(y)}" x2="${width - 40}" y2="${toSvgY(y)}" />\n`;
        svg += `    <text x="32" y="${toSvgY(y)}" fill="#718096" font-size="9" text-anchor="end" alignment-baseline="middle">${y}km</text>\n`;
    }
    svg += `  </g>\n\n`;

    // 2. Contours
    svg += `  <!-- Elevation Contours -->\n  <g fill="none" stroke-width="1.2">\n`;
    contours.forEach((c) => {
        if (c.points.length >= 2) {
            const pts = c.points.map(([x, y]) => `${toSvgX(x)},${toSvgY(y)}`).join(" ");
            const rgba = `rgba(${Math.round(c.color[0] * 255)},${Math.round(c.color[1] * 255)},${Math.round(c.color[2] * 255)},${(c.color[3] * 0.8).toFixed(2)})`;
            svg += `    <polyline points="${pts}" stroke="${rgba}" />\n`;
        }
    });
    svg += `  </g>\n\n`;

    // 3. Regions / Biomes
    svg += `  <!-- Regions & Biomes -->\n  <g>\n`;
    regions.forEach((r) => {
        if (r.points.length >= 3) {
            const pts = r.points.map(([x, y]) => `${toSvgX(x)},${toSvgY(y)}`).join(" ");
            const fillRgba = `rgba(${Math.round(r.fillColor[0] * 255)},${Math.round(r.fillColor[1] * 255)},${Math.round(r.fillColor[2] * 255)},0.28)`;
            const borderRgba = `rgba(${Math.round(r.borderColor[0] * 255)},${Math.round(r.borderColor[1] * 255)},${Math.round(r.borderColor[2] * 255)},0.85)`;
            svg += `    <polygon points="${pts}" fill="${fillRgba}" stroke="${borderRgba}" stroke-width="2" />\n`;

            const cx = r.points.reduce((acc, p) => acc + p[0], 0) / r.points.length;
            const cy = r.points.reduce((acc, p) => acc + p[1], 0) / r.points.length;
            svg += `    <text x="${toSvgX(cx)}" y="${toSvgY(cy)}" fill="#e2e8f0" font-size="12" font-weight="bold" text-anchor="middle">${r.name}</text>\n`;
        }
    });
    svg += `  </g>\n\n`;

    // 4. Paths & Rivers
    svg += `  <!-- Paths, Roads & Rivers -->\n  <g fill="none">\n`;
    paths.forEach((p) => {
        if (p.points.length >= 2) {
            const pts = p.points.map(([x, y]) => `${toSvgX(x)},${toSvgY(y)}`).join(" ");
            const strokeCol = p.pathType === "river" ? "#38bdf8" : p.pathType === "highway" ? "#fbbf24" : "#cbd5e1";
            const strokeW = p.pathType === "highway" ? 4.5 : p.pathType === "river" ? 3.5 : 2.5;
            svg += `    <polyline points="${pts}" stroke="${strokeCol}" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" />\n`;
        }
    });
    svg += `  </g>\n\n`;

    // 5. Spots / POIs
    svg += `  <!-- Spots & POIs -->\n  <g>\n`;
    spots.forEach((s) => {
        const sx = toSvgX(s.x);
        const sy = toSvgY(s.y);
        const col = s.isMajor ? "#fbbf24" : "#34d399";
        const radius = s.spotType === "capital" ? 9 : s.isMajor ? 7 : 5;
        svg += `    <circle cx="${sx}" cy="${sy}" r="${radius + 3}" fill="#0f141e" />\n`;
        svg += `    <circle cx="${sx}" cy="${sy}" r="${radius}" fill="${col}" filter="url(#glow)" />\n`;
        svg += `    <text x="${sx}" y="${Number(sy) + radius + 13}" fill="#f8fafc" font-size="10" font-weight="600" text-anchor="middle">${s.name}</text>\n`;
    });
    svg += `  </g>\n\n`;

    // 6. Design intents: dashed, numbered, green when the world meets them.
    const intents = (world.intents ?? []).filter((i) => i.status !== "dismissed");
    if (intents.length) {
        svg += `  <!-- Design Intents -->\n  <g fill="none" stroke-width="2" stroke-dasharray="9 5" font-size="11" font-weight="600">\n`;
        intents.forEach((i) => {
            const ev = evaluateIntent(world, i);
            const col = ev.satisfied === true ? "#34d399" : ev.satisfied === false ? "#fbbf24" : "#cbd5e1";
            const pts = intentPoints(world, i);
            const label = `#${i.number} ${escapeXml(i.title)}${ev.satisfied === true ? " ✓" : ev.satisfied === false ? " ✗" : ""}`;
            if (i.shape === "area" && pts.length >= 3) {
                svg += `    <polygon points="${pts.map(([x, y]) => `${toSvgX(x)},${toSvgY(y)}`).join(" ")}" stroke="${col}" fill="${col}" fill-opacity="0.08" />\n`;
                const top = pts.reduce((a, b) => (b[1] > a[1] ? b : a));
                svg += `    <text x="${toSvgX(top[0])}" y="${Number(toSvgY(top[1])) - 8}" fill="${col}" stroke="none" text-anchor="middle">${label}</text>\n`;
            } else if (i.shape === "route" && pts.length >= 2) {
                svg += `    <line x1="${toSvgX(pts[0][0])}" y1="${toSvgY(pts[0][1])}" x2="${toSvgX(pts[1][0])}" y2="${toSvgY(pts[1][1])}" stroke="${col}" />\n`;
                svg += `    <text x="${toSvgX((pts[0][0] + pts[1][0]) / 2)}" y="${Number(toSvgY((pts[0][1] + pts[1][1]) / 2)) - 8}" fill="${col}" stroke="none" text-anchor="middle">${label}</text>\n`;
            } else if (pts[0]) {
                svg += `    <circle cx="${toSvgX(pts[0][0])}" cy="${toSvgY(pts[0][1])}" r="9" stroke="${col}" />\n`;
                svg += `    <text x="${Number(toSvgX(pts[0][0])) + 13}" y="${Number(toSvgY(pts[0][1])) + 4}" fill="${col}" stroke="none">${label}</text>\n`;
            }
        });
        svg += `  </g>\n\n`;
    }

    // 7. Header Badge Card
    svg += `  <!-- Title Card -->\n`;
    svg += `  <rect x="50" y="50" width="320" height="70" rx="6" fill="rgba(15,20,30,0.85)" stroke="#334155" stroke-width="1.5" />\n`;
    svg += `  <text x="66" y="78" fill="#38bdf8" font-size="16" font-weight="bold">${meta.name}</text>\n`;
    svg += `  <text x="66" y="98" fill="#94a3b8" font-size="11">${meta.genre.toUpperCase()} WORLD PLANNER | Scale: ${meta.worldWidthKm} x ${meta.worldHeightKm} km</text>\n`;

    svg += `</svg>\n`;
    return svg;
}
