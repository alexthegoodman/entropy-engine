// Design intents and the agent loop: the designer sketches what they want (pins, areas, routes),
// the world is checked against it live, the built-in Planner Agent drafts proposals, external
// agents' proposals are normalized, and accepting or rejecting changes on the map edits the world
// with undo.
import { describe, expect, it } from "vitest";
import { PlannerModel } from "../src/apps/game_planner/planner_model";
import { SHATTERED_ISLES_PRESET } from "../src/apps/game_planner/presets";
import {
    createIntent,
    effectiveParams,
    evaluateIntent,
    generateAgentBrief,
    inferIntentFromText,
    intentContext,
    intentPoints,
    openIntents,
    planHealth,
    spotsInIntent,
    travelMinutes,
} from "../src/apps/game_planner/intent_model";
import { draftProposalForIntent, normalizeProposalChanges } from "../src/apps/game_planner/planner_agent";
import { exportMapToSvg, generateGameDesignDoc, proposalGhosts } from "../src/apps/game_planner/agent_pipeline";
import { isPointInsidePolygon } from "../src/apps/game_planner/travel_calculator";
import type { GameWorld, PlanIntent } from "../src/apps/game_planner/planner_types";

const fresh = () => new PlannerModel(SHATTERED_ISLES_PRESET);
const square = (cx: number, cy: number, r: number): [number, number][] => [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]];

/** A box of dry land, found from the terrain, so tests don't depend on where the coast falls. */
function landBox(world: GameWorld, r = 2.5): [number, number][] {
    let best: [number, number] = [0, 0];
    let bestLand = -1;
    const m = new PlannerModel(world);
    for (let x = -10; x <= 10; x += 2.5) {
        for (let y = -10; y <= 10; y += 2.5) {
            const box = square(x, y, r);
            if (world.spots.some((s) => isPointInsidePolygon([s.x, s.y], box))) continue;
            let land = 0;
            for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
                if (m.elevationAt(x - r + (i * r) / 2, y - r + (j * r) / 2, 0) > world.meta.seaLevelM + 10) land++;
            }
            if (land > bestLand) {
                bestLand = land;
                best = [x, y];
            }
        }
    }
    return square(best[0], best[1], r);
}

describe("reading the designer's words", () => {
    it("finds counts, place types and kinds", () => {
        expect(inferIntentFromText("three fishing villages along this coast")).toMatchObject({ kind: "settle", params: { count: 3, spotType: "port" } });
        expect(inferIntentFromText("2 towns")).toMatchObject({ kind: "settle", params: { count: 2, spotType: "town" } });
        expect(inferIntentFromText("haunted woods, danger level 8")).toMatchObject({ kind: "danger", params: { dangerLevel: 8 } });
        expect(inferIntentFromText("should take about 1 hour 30 minutes on horseback")).toMatchObject({ kind: "pacing", params: { targetMinutes: 90, mode: "mount" } });
        expect(inferIntentFromText("connect these with a highway")).toMatchObject({ kind: "connect", params: { pathType: "highway" } });
        expect(inferIntentFromText("a bounty quest in the ruins")).toMatchObject({ kind: "quest", params: { spotType: "ruin" } });
        expect(inferIntentFromText("make it feel lonely").kind).toBeUndefined();
    });
});

describe("sketching intents", () => {
    it("a pin is one click; an area closes on Enter; a route pins its ends to spots", () => {
        const m = fresh();
        m.intentShape = "pin";
        const pin = m.appendPendingIntentPoint([1, 1])!;
        expect(pin).toMatchObject({ shape: "pin", kind: "landmark", number: 1, status: "open" });
        expect(m.selectedId).toBe(pin.id);

        m.intentShape = "area";
        expect(m.appendPendingIntentPoint([0, 0])).toBeNull();
        m.appendPendingIntentPoint([2, 0]);
        expect(m.finishPendingIntent()).toBeNull(); // two points are not an area
        m.appendPendingIntentPoint([2, 2]);
        const area = m.finishPendingIntent()!;
        expect(area).toMatchObject({ shape: "area", kind: "settle", number: 2, params: {} });
        expect(effectiveParams(area).count).toBe(3); // the kind's default
        // The directive's words beat the default; the designer's explicit setting beats both.
        area.directive = "two farming villages";
        expect(effectiveParams(area).count).toBe(2);
        area.params.count = 5;
        expect(effectiveParams(area).count).toBe(5);

        m.intentShape = "route";
        const oak = m.world.spots.find((s) => s.id === "spot_oakhaven")!;
        const keep = m.world.spots.find((s) => s.id === "spot_iron_gate_keep")!;
        m.appendPendingIntentPoint([oak.x, oak.y]);
        const route = m.appendPendingIntentPoint([keep.x, keep.y])!;
        expect(route).toMatchObject({ shape: "route", kind: "pacing", fromSpotId: oak.id, toSpotId: keep.id, title: "Oakhaven Hamlet → Iron Gate Fortress" });

        // Route ends follow their spots.
        const kx = keep.x;
        m.moveSpot(keep.id, kx + 3, keep.y);
        expect(intentPoints(m.world, route)[1][0]).toBeCloseTo(kx + 3, 3);

        expect(m.undo()).toBe(true); // the move
        expect(m.undo()).toBe(true); // the route
        expect(m.intents.map((i) => i.number)).toEqual([1, 2]);
    });

    it("older saves without intents load with an empty list", () => {
        const w = JSON.parse(JSON.stringify(SHATTERED_ISLES_PRESET));
        delete w.intents;
        expect(new PlannerModel(w).intents).toEqual([]);
    });
});

describe("intents are live checks on the world", () => {
    it("settle counts settlements inside the area", () => {
        const w = fresh().world;
        const around = (s: { x: number; y: number }) => square(s.x, s.y, 1);
        const capital = w.spots.find((s) => s.spotType === "capital")!;
        const i = createIntent(w, "area", around(capital), { kind: "settle", params: { count: 2 } });
        expect(evaluateIntent(w, i)).toMatchObject({ satisfied: false, summary: "1 of 2 settlements", progress: 0.5 });
        i.params.count = 1;
        expect(evaluateIntent(w, i).satisfied).toBe(true);
    });

    it("danger needs a danger region at the level; the preset's Ashen Crags passes at 8", () => {
        const w = fresh().world;
        const crags = w.regions.find((r) => r.id === "reg_ashen_crags")!;
        const i = createIntent(w, "area", crags.points, { kind: "danger", params: { dangerLevel: 8 } });
        expect(evaluateIntent(w, i).satisfied).toBe(true);
        i.params.dangerLevel = 9;
        expect(evaluateIntent(w, i).satisfied).toBe(false);
    });

    it("connect finds a road passing both ends; pacing compares travel time with the target", () => {
        const w = fresh().world;
        const cap = w.spots.find((s) => s.id === "spot_solaris_citadel")!;
        const port = w.spots.find((s) => s.id === "spot_kraken_harbor")!;
        const drake = w.spots.find((s) => s.id === "spot_drake_peak")!;
        const joined = createIntent(w, "route", [[cap.x, cap.y], [port.x, port.y]], { kind: "connect", fromSpotId: cap.id, toSpotId: port.id });
        expect(evaluateIntent(w, joined)).toMatchObject({ satisfied: true });
        const notJoined = createIntent(w, "route", [[port.x, port.y], [drake.x, drake.y]], { kind: "connect", fromSpotId: port.id, toSpotId: drake.id });
        expect(evaluateIntent(w, notJoined).satisfied).toBe(false);

        const now = travelMinutes(w, [cap.x, cap.y], [port.x, port.y], "foot");
        const pace = createIntent(w, "route", [[cap.x, cap.y], [port.x, port.y]], { kind: "pacing", fromSpotId: cap.id, toSpotId: port.id, params: { targetMinutes: now, mode: "foot" } });
        expect(evaluateIntent(w, pace)).toMatchObject({ satisfied: true });
        expect(evaluateIntent(w, pace).summary).toMatch(/on target/);
        pace.params.targetMinutes = now / 3;
        expect(evaluateIntent(w, pace).summary).toMatch(/too long/);
    });

    it("plan health rolls the checks up; freeform waits for the designer", () => {
        const w = fresh().world;
        const crags = w.regions.find((r) => r.id === "reg_ashen_crags")!;
        w.intents = [
            createIntent(w, "area", crags.points, { kind: "danger", params: { dangerLevel: 8 } }),
            { ...createIntent(w, "area", square(0, -9, 1), { kind: "settle", params: { count: 4 } }), number: 2 },
            { ...createIntent(w, "pin", [[0, 0]], { kind: "freeform", directive: "the vibe should be lonely" }), number: 3 },
        ];
        expect(planHealth(w)).toMatchObject({ total: 3, met: 1, unmet: 1, manual: 1 });
        expect(openIntents(w).map((i) => i.number)).toEqual([2, 3]);
    });
});

describe("the built-in Planner Agent", () => {
    it("settles an area: new places inside it, on dry gentle land, with roads; never edits the world", () => {
        const m = fresh();
        const box = landBox(m.world);
        const intent = m.addIntent("area", box, { kind: "settle", directive: "two farming villages", params: {} });
        const before = JSON.stringify(m.world.spots);
        const { proposal, reason } = draftProposalForIntent(m.world, intent);
        expect(proposal, reason).not.toBeNull();
        expect(JSON.stringify(m.world.spots)).toBe(before);
        const spots = proposal!.changes.filter((c) => c.changeType === "add_spot");
        expect(spots.length).toBe(2);
        for (const c of spots) {
            expect(isPointInsidePolygon([c.after.x, c.after.y], box)).toBe(true);
            expect(c.after.spotType).toBe("village");
            expect(c.after.elevation).toBeGreaterThan(m.world.meta.seaLevelM);
            expect(m.slopeAt(c.after.x, c.after.y)).toBeLessThan(25);
            expect(m.world.spots.some((s) => s.name === c.after.name)).toBe(false);
        }
        expect(proposal!.changes.some((c) => c.changeType === "add_path" && c.after.points.length >= 2)).toBe(true);
        expect(proposal!.intentId).toBe(intent.id);

        // Accepting everything meets the intent, and marks it done.
        m.addProposal(proposal!);
        expect(intent.status).toBe("proposed");
        expect(proposalGhosts(m.world).length).toBe(proposal!.changes.length);
        m.decideProposal(proposal!.id, true);
        expect(evaluateIntent(m.world, intent).satisfied).toBe(true);
        expect(m.intents[0].status).toBe("done");
        expect(proposalGhosts(m.world)).toEqual([]);
        // ... as one undo step.
        m.undo();
        expect(m.world.spots.length).toBe(5);
        expect(m.world.proposals[0].changes.every((c) => c.status === "pending")).toBe(true);
    });

    it("marks a danger zone with a lair in its remote high ground", () => {
        const m = fresh();
        const box = landBox(m.world, 3);
        const intent = m.addIntent("area", box, { kind: "danger", title: "The Hollow Marches", params: { dangerLevel: 9 } });
        const { proposal } = draftProposalForIntent(m.world, intent);
        const region = proposal!.changes.find((c) => c.changeType === "add_region")!;
        expect(region.after).toMatchObject({ name: "The Hollow Marches", regionType: "danger", dangerLevel: 9 });
        const lair = proposal!.changes.find((c) => c.changeType === "add_spot")!;
        expect(lair.after.spotType).toBe("boss");
        expect(isPointInsidePolygon([lair.after.x, lair.after.y], box)).toBe(true);
        m.addProposal(proposal!);
        m.decideProposal(proposal!.id, true);
        expect(evaluateIntent(m.world, intent)).toMatchObject({ satisfied: true, progress: 1 });
    });

    it("connects two places with a road over the terrain", () => {
        const m = fresh();
        const port = m.world.spots.find((s) => s.id === "spot_kraken_harbor")!;
        const drake = m.world.spots.find((s) => s.id === "spot_drake_peak")!;
        const intent = m.addIntent("route", [[port.x, port.y], [drake.x, drake.y]], { kind: "connect", fromSpotId: port.id, toSpotId: drake.id });
        const { proposal } = draftProposalForIntent(m.world, intent);
        const road = proposal!.changes[0];
        expect(road.changeType).toBe("add_path");
        expect(road.after.points.length).toBeGreaterThan(3); // routed, not a straight line
        m.addProposal(proposal!);
        m.decideChange(road.id, true);
        expect(evaluateIntent(m.world, intent).satisfied).toBe(true);
    });

    it("speeds a slow journey up with a road", () => {
        const m = fresh();
        const port = m.world.spots.find((s) => s.id === "spot_kraken_harbor")!;
        const drake = m.world.spots.find((s) => s.id === "spot_drake_peak")!;
        const now = travelMinutes(m.world, [port.x, port.y], [drake.x, drake.y], "foot");
        const intent = m.addIntent("route", [[port.x, port.y], [drake.x, drake.y]], { kind: "pacing", fromSpotId: port.id, toSpotId: drake.id, params: { targetMinutes: Math.round(now * 0.75), mode: "foot", tolerance: 0.2 } });
        expect(evaluateIntent(m.world, intent).satisfied).toBe(false);
        const { proposal, reason } = draftProposalForIntent(m.world, intent);
        expect(proposal, reason).not.toBeNull();
        expect(proposal!.changes[0].changeType).toBe("add_path");
        expect(proposal!.changes[0].after.pathType).toBe("trail"); // a road would overshoot
        m.addProposal(proposal!);
        m.decideProposal(proposal!.id, true);
        expect(travelMinutes(m.world, [port.x, port.y], [drake.x, drake.y], "foot")).toBeLessThan(now);
        expect(evaluateIntent(m.world, intent).satisfied).toBe(true);
    });

    it("stretches a journey that is too short by moving the destination", () => {
        const m = fresh();
        const cap = m.world.spots.find((s) => s.id === "spot_solaris_citadel")!;
        const keep = m.world.spots.find((s) => s.id === "spot_iron_gate_keep")!;
        const now = travelMinutes(m.world, [cap.x, cap.y], [keep.x, keep.y], "foot");
        const intent = m.addIntent("route", [[cap.x, cap.y], [keep.x, keep.y]], { kind: "pacing", fromSpotId: cap.id, toSpotId: keep.id, params: { targetMinutes: Math.round(now * 1.6), mode: "foot" } });
        const { proposal, reason } = draftProposalForIntent(m.world, intent);
        expect(proposal, reason).not.toBeNull();
        const move = proposal!.changes[0];
        expect(move).toMatchObject({ changeType: "modify_spot", targetId: keep.id, before: { x: keep.x, y: keep.y } });
        expect(proposalGhosts({ ...m.world, proposals: [proposal!] })[0]).toMatchObject({ kind: "move", from: [keep.x, keep.y] });
        m.addProposal(proposal!);
        m.decideChange(move.id, true);
        const after = travelMinutes(m.world, [cap.x, cap.y], [m.world.spots.find((s) => s.id === keep.id)!.x, m.world.spots.find((s) => s.id === keep.id)!.y], "foot");
        expect(after).toBeGreaterThan(now);
        expect(Math.abs(after / (now * 1.6) - 1)).toBeLessThan(0.3);
    });

    it("writes a quest given at the nearest settlement, with a new site when the area is empty", () => {
        const m = fresh();
        const box = landBox(m.world);
        const intent = m.addIntent("area", box, { kind: "quest", title: "Ashes of the Old King", directive: "Retrieve the crown from the ruins." });
        const { proposal } = draftProposalForIntent(m.world, intent);
        const site = proposal!.changes.find((c) => c.changeType === "add_spot")!;
        const quest = proposal!.changes.find((c) => c.changeType === "add_mission")!;
        expect(quest.after).toMatchObject({ title: "Ashes of the Old King", description: "Retrieve the crown from the ruins.", objectiveSpotIds: [site.targetId] });
        expect(m.world.spots.find((s) => s.id === quest.after.startSpotId)).toBeTruthy();
        // Accepting the quest but rejecting its site leaves no dangling reference.
        m.addProposal(proposal!);
        m.decideChange(quest.id, true);
        expect(m.world.missions.at(-1)!.objectiveSpotIds).toEqual([site.targetId]);
        m.decideChange(site.id, false);
        expect(m.world.missions.at(-1)!.objectiveSpotIds).toEqual([]);
        expect(m.intents[0].status).toBe("open"); // still unmet
    });

    it("leaves freeform intents to an LLM, and does nothing for intents already met", () => {
        const m = fresh();
        const free = m.addIntent("pin", [[0, 0]], { kind: "freeform", directive: "something eerie" });
        expect(draftProposalForIntent(m.world, free)).toMatchObject({ proposal: null, reason: expect.stringMatching(/LLM agent/) });
        const crags = m.world.regions.find((r) => r.id === "reg_ashen_crags")!;
        const met = m.addIntent("area", crags.points, { kind: "danger", params: { dangerLevel: 5 } });
        expect(draftProposalForIntent(m.world, met)).toMatchObject({ proposal: null, reason: expect.stringMatching(/Already met/) });
    });
});

describe("external agents", () => {
    it("minimal changes come back complete; bad ones are reported, not applied", () => {
        const m = fresh();
        const { changes, errors } = normalizeProposalChanges(m.world, [
            { changeType: "add_spot", after: { name: "Gull Rock", spotType: "landmark", x: 3, y: 1 } },
            { changeType: "add_path", after: { name: "Cliff Path", pathType: "trail", points: [[3, 1], [4, 2]] } },
            { changeType: "add_region", after: { name: "Mire", regionType: "danger", points: [[0, 0], [1, 0], [1, 1]], dangerLevel: 6 } },
            { changeType: "modify_spot", targetId: "spot_oakhaven", after: { x: -6, y: -2 } },
            { changeType: "add_codex", after: { name: "The Tide Witch", category: "character" } },
            { changeType: "teleport_spot", after: {} },
            { changeType: "add_spot", after: { name: "Nowhere" } },
            { changeType: "delete_spot", targetId: "spot_missing" },
        ]);
        expect(changes.map((c) => c.changeType)).toEqual(["add_spot", "add_path", "add_region", "modify_spot", "add_codex"]);
        expect(errors).toHaveLength(3);
        expect(changes[0].after).toMatchObject({ elevation: m.elevationAt(3, 1), color: expect.any(Array), linkedCodexIds: [], isMajor: false });
        expect(changes[1].after).toMatchObject({ surfaceQuality: 1.35, width: 2 });
        expect(changes[2].after.fillColor[0]).toBeGreaterThan(0.8); // danger red
        expect(changes[3].before).toMatchObject({ x: -6.5, y: -1.5 });
        expect(changes[3].after.elevation).toBe(m.elevationAt(-6, -2));
        expect(changes[4].after.attributes).toBeTruthy();

        m.addProposal({ id: "p1", agentName: "Claude", timestamp: 1, motivation: "test", changes });
        expect(m.decideProposal("p1", true)).toBe(5);
        expect(m.world.spots.find((s) => s.name === "Gull Rock")).toBeTruthy();
        expect(m.world.spots.find((s) => s.id === "spot_oakhaven")).toMatchObject({ x: -6, y: -2 });
        expect(m.world.codex.find((c) => c.name === "The Tide Witch")).toBeTruthy();
    });

    it("the brief and the context tell an agent what to build and how to hand it back", () => {
        const m = fresh();
        const box = landBox(m.world);
        const intent = m.addIntent("area", box, { kind: "settle", title: "Farmland", directive: "Two quiet farming villages", params: { count: 2 } });
        const ctx = intentContext(m.world, intent);
        expect(ctx).toMatchObject({ id: intent.id, kind: "settle", evaluation: { satisfied: false } });
        expect(ctx.terrain!.landFraction).toBeGreaterThan(0);
        expect(ctx.acceptance).toMatch(/2 village/);
        expect(ctx.nearestSpots).toHaveLength(5);
        const brief = generateAgentBrief(m.world);
        expect(brief).toContain("#1 Farmland");
        expect(brief).toContain("> Two quiet farming villages");
        expect(brief).toContain(intent.id);
        expect(brief).toContain("game_planner_propose_revision");
        // The GDD records the intent and whether it is met; the SVG map draws it.
        expect(generateGameDesignDoc(m.world)).toMatch(/Design Intent[\s\S]*✗ \*\*#1 Farmland\*\*/);
        expect(exportMapToSvg(m.world)).toContain("#1 Farmland ✗");
    });

    it("deleting an intent drops its pending proposals", () => {
        const m = fresh();
        const intent = m.addIntent("pin", [[1, 1]], { kind: "landmark" }) as PlanIntent;
        const { proposal } = draftProposalForIntent(m.world, intent);
        m.addProposal(proposal!);
        expect(m.pendingProposals).toHaveLength(1);
        m.deleteIntent(intent.id);
        expect(m.pendingProposals).toHaveLength(0);
        expect(spotsInIntent(m.world, intent)).toEqual([]);
    });
});
