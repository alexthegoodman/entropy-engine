// Mission 2's story, played on the Noctis map (te_noctis.ts): what Ray's doing moves it on.
//
//   embark      the Doctor at his rover hands over the scattergun.
//   noctis      three places in any order: shut down the Foundry's printing line (the racks wake),
//               read Gate Four's last session (the sim lens shows which terminal), raise the barge's
//               mast (hold E on the winch while the hull empties). Then the Doctor's line goes dead.
//   silence     back to the camp: the rover overturned, the Doctor gone. His radio picks up a call.
//   signal      the pumphouse on the canal: people in the Error's pods; survivors inside, Hollows at
//   beacons     the doors drawn by three lure beacons. Break them and the Hollows wander off.
//   survivors   Mara, Oduya and Pip. Then the Tithe arrive: Vesper says the Doctor was taken down
//   tithe       the quarry lift. She'll show the way. The lift goes down and the gate shuts above.
//   descend ... the Undercroft: the pit, the cable heart grown into the tunnel door, the metro to the
//   rim         hoist, and up to the Tithe's ledge, where they're waiting. Out to the overlook.
//
// Functions over the Game (te_game.ts calls them for mission 2); they use only its public parts.

import type { Game, RunSave, Enemy } from "./te_game";
import type { UseSpot, V3, Solid } from "./te_level";
import { stageIndex, stageOf, type StageId } from "./te_mission";
import {
    noctisHeight, CAMP, FOUNDRY, GATE, GATE_DARK, RIGHT_TERMINAL, BARGE, WINCH, CRANK, BEACONS, SURVIVORS, QLIFT, HOIST, NEST, OVERLOOK,
    TITHE_AT, TITHE_LIFT, AMBUSH, LEDGE,
} from "./te_noctis";

const LIFTS = { quarry: QLIFT, hoist: HOIST };
const reached = (g: Game, id: StageId) => stageIndex(g.stage) >= stageIndex(id);

export function m2Init(g: Game): void {
    for (const e of g.enemies) if (e.id.startsWith("rack-")) e.dormant = true;
    for (const L of [QLIFT, HOIST]) {
        const y = L === QLIFT ? L.top : L.bottom;
        const floor: Solid = { min: [L.x0 + 0.1, y - 0.3, L.z0 + 0.1], max: [L.x1 - 0.1, y, L.z1 - 0.1] };
        g.cages.set(L.id, { y, floor });
        g.world.dynamic.push(floor);
    }
    // Ray has the biochip from the Relay.
    g.player.biochip = 100;
    syncNpcs(g);
}

/** The three open objectives, done or not (the HUD's list). */
export function m2Tasks(g: Game): { text: string; done: boolean }[] {
    if (g.stage !== "noctis") return [];
    return [
        { text: "Avatar Foundry: shut down the printing line", done: g.flags.has("foundry") },
        { text: "Gate Four: read the gate's last session", done: g.flags.has("gate") },
        { text: "The barge: raise the signal mast", done: g.flags.has("mast") },
    ];
}

export function m2Objective(g: Game): string {
    if (g.stage === "noctis") return `${["foundry", "gate", "mast"].filter(f => g.flags.has(f)).length} of 3  -  the Foundry, Gate Four and the barge, in any order`;
    if (g.stage === "beacons") return `Destroy the lure beacons around the pumphouse  (${beaconsDown(g)} / 3)`;
    if (g.stage === "rim" && g.flags.has("vesper-fled")) return "Get out to the overlook";
    return stageOf(g.stage).objective;
}

const beaconsDown = (g: Game) => g.enemies.filter(e => e.kind === "beacon" && e.state === "destroyed").length;

/** Who's standing where, for this stage. */
function syncNpcs(g: Game): void {
    const p = g.player.pos;
    const want: { id: string; model: string; pos: V3; face?: V3 }[] = [];
    if (!g.flags.has("doctor-gone")) want.push({ id: "doctor", model: "doctor", pos: CAMP.doctor, face: p });
    if (reached(g, "signal") || g.stage === "noctis" || g.stage === "embark") {
        want.push({ id: "mara", model: "survivor", pos: SURVIVORS.mara, face: g.flags.has("beacons") ? p : [SURVIVORS.mara[0], 0, -90] });
        want.push({ id: "oduya", model: "elder", pos: SURVIVORS.oduya, face: SURVIVORS.mara });
        want.push({ id: "pip", model: "pip", pos: SURVIVORS.pip, face: p });
    }
    // The Tithe: at the pumphouse once the survivors have talked, at the lift once Ray's walked off.
    if (g.stage === "tithe" || g.stage === "descend") {
        const atLift = g.flags.has("tithe-at-lift");
        const at = atLift ? TITHE_LIFT : TITHE_AT;
        want.push({ id: "vesper", model: "vesper", pos: at.vesper, face: p });
        want.push({ id: "tithe-1", model: "scavenger", pos: at.scav1, face: p });
        want.push({ id: "tithe-2", model: "scavenger", pos: at.scav2, face: p });
    }
    if (g.stage === "rim" && !g.flags.has("vesper-fled")) want.push({ id: "vesper", model: "vesper", pos: [188, LEDGE.y, -199], face: p });
    // Keep the existing records (the addon holds a character per id) and update them.
    for (let i = g.npcs.length - 1; i >= 0; i--) if (!want.some(w => w.id === g.npcs[i].id)) g.npcs.splice(i, 1);
    for (const w of want) {
        let n = g.npcs.find(x => x.id === w.id);
        if (!n) { n = { id: w.id, model: w.model, pos: [...w.pos], yaw: 0, anim: "idle", talking: false }; g.npcs.push(n); }
        n.pos = [...w.pos];
        if (w.face) { const a = Math.atan2(w.face[0] - n.pos[0], w.face[2] - n.pos[2]); n.yaw = a; }
    }
}

export function m2Step(g: Game, dt: number): void {
    const p = g.player.pos;
    const r = g.regionOf(p);
    const near = (q: V3, d: number) => Math.hypot(q[0] - p[0], q[2] - p[2]) < d && Math.abs(q[1] - p[1]) < 6;
    // Lines along the way.
    if (g.stage === "noctis") {
        if (r === "foundry") { g.say("foundry"); g.say("foundryRoutes"); }
        if (p[0] > FOUNDRY.x0 + 1 && p[0] < FOUNDRY.x1 && p[2] > FOUNDRY.z0 && p[2] < FOUNDRY.z1 && p[1] < FOUNDRY.h) g.say("foundryInside");
        if (r === "gate") g.say("gate");
        if (near(GATE_DARK.center, GATE_DARK.radius)) g.say("gateDark");
        if (near(GATE.center, 13)) g.say("gateTerminals");
        if (r === "barge") g.say("barge");
        if (r === "canal") g.say("canal");
        if (near(WINCH, 14)) g.say("mast");
    }
    syncNpcs(g);

    switch (g.stage) {
        case "embark": break; // the Doctor (m2Use)
        case "noctis":
            if (g.flags.has("foundry") && g.flags.has("gate") && g.flags.has("mast")) {
                g.say("allDone");
                g.flags.add("doctor-gone");
                g.setStage("silence");
            }
            break;
        case "silence": if (r === "camp" && near(CAMP.rover, 18)) { g.say("camp"); g.setStage("camp"); } break;
        case "camp": break; // the radio (m2Use)
        case "signal": if (r === "pumphouse") { g.say("pods"); g.say("beaconHint"); g.setStage("beacons"); } break;
        case "beacons":
            if (beaconsDown(g) >= 3) {
                g.flags.add("beacons");
                g.say("beaconsDone");
                g.openDoor("pump-door");
                calmPumphouse(g);
                g.setStage("survivors");
            }
            break;
        case "survivors": break; // Mara (m2Use)
        case "tithe":
            // Once Ray's well away from them, the Tithe have walked on to their lift.
            if (!g.flags.has("tithe-at-lift") && Math.hypot(p[0] - TITHE_AT.vesper[0], p[2] - TITHE_AT.vesper[2]) > 45) g.flags.add("tithe-at-lift");
            if (g.flags.has("tithe-at-lift") && near(TITHE_LIFT.vesper, 14)) g.say("vesperWalk");
            break;
        case "descend": case "ascent": break; // m2Ride
        case "undercroft":
            if (r === "pit") g.say("pit");
            if (r === "nest") { g.say("nest"); g.setStage("nest"); }
            break;
        case "nest": break; // the heart's death (m2Damaged)
        case "tunnel": if (r === "tunnel" && p[0] > 158) g.say("hoist"); break;
        case "rim": {
            const down = g.enemies.filter(e => e.zone === "ledge" && e.kind === "scavenger" && (e.state === "stunned" || e.state === "restored" || e.state === "destroyed")).length;
            if (down >= 3 && !g.flags.has("vesper-fled")) { g.flags.add("vesper-fled"); g.say("rimFight"); }
            if (near(OVERLOOK, 3.5) && !g.won) { g.won = true; g.events.push({ kind: "goal" }); }
            break;
        }
        default: break;
    }
}

/** Once the beacons are gone, the pumphouse's Hollows lose interest and wander off. */
function calmPumphouse(g: Game): void {
    for (let i = g.enemies.length - 1; i >= 0; i--) {
        const e = g.enemies[i];
        if (e.zone !== "pumphouse" || e.kind !== "hollow" || (e.state !== "patrol" && e.state !== "alert" && e.state !== "fight")) continue;
        e.calm = true; e.state = "patrol"; e.stateT = 0; e.charge = 0;
        e.patrol = [[-150, 0, -150 + (i % 4) * 6]]; e.leg = 0; e.zone = "gone";
    }
}

export function m2Usable(g: Game, u: UseSpot): boolean {
    switch (u.kind) {
        case "talk": return u.id === "doctor" ? g.stage === "embark" : g.stage === "survivors";
        case "radio": return g.stage === "camp";
        case "weapon": return !g.flags.has("weapon:gravity");
        case "printer": return !g.flags.has("foundry");
        case "terminal": return !g.flags.has("gate") && !g.flags.has(`wrong:${u.id}`);
        case "winch": return !g.flags.has("mast");
        case "lift": return u.id === "quarry-lift" ? g.stage === "tithe" : g.stage === "tunnel";
        default: return false;
    }
}

/** Works a spot (a tap of E), or turns the winch for `dt` seconds (E held). */
export function m2Use(g: Game, u: UseSpot, dt: number): void {
    const ok = () => g.events.push({ kind: "use", id: u.id, ok: true });
    switch (u.kind) {
        case "talk":
            if (u.id === "doctor") {
                g.say("embark");
                g.flags.add("weapon:scatter");
                g.player.weapon = "scatter";
                g.events.push({ kind: "weapon", weapon: "scatter" });
                g.setStage("noctis");
            } else {
                g.say("survivors"); g.say("tithe");
                g.setStage("tithe");
            }
            ok();
            break;
        case "radio": g.say("radio"); g.setStage("signal"); ok(); break;
        case "weapon":
            g.flags.add("weapon:gravity");
            g.gravCells = Math.max(g.gravCells, 3);
            g.player.weapon = "gravity";
            g.events.push({ kind: "weapon", weapon: "gravity" });
            g.say("launcher");
            ok();
            break;
        case "printer":
            g.flags.add("foundry");
            ok();
            g.say("printerOff"); g.say("foundryEcho");
            // The line knew: the racks wake.
            for (const e of g.enemies) if (e.dormant) { e.dormant = false; e.state = "alert"; e.stateT = 0; e.seen = true; g.events.push({ kind: "wake", id: e.id, at: [...e.pos] }); }
            g.events.push({ kind: "objective", id: "foundry" });
            break;
        case "terminal":
            if (u.id === RIGHT_TERMINAL) {
                g.flags.add("gate"); ok();
                g.say("gateLog");
                g.events.push({ kind: "objective", id: "gate" });
            } else {
                g.flags.add(`wrong:${u.id}`);
                g.events.push({ kind: "use", id: u.id, ok: false });
                g.say("wrongTerminal");
                for (let i = 0; i < 3; i++) {
                    const a = g.random() * Math.PI * 2;
                    g.spawn(`alarm-cherub-${u.id}-${i}`, "cherub", [GATE.center[0] + Math.cos(a) * 14, 7, GATE.center[2] + Math.sin(a) * 14], "gate");
                }
            }
            break;
        case "winch": {
            if (dt <= 0) break;
            const was = g.crank;
            g.crank = Math.min(1, g.crank + dt / CRANK.seconds);
            if (Math.floor(was * 20) !== Math.floor(g.crank * 20)) g.events.push({ kind: "use", id: "winch", ok: true });
            CRANK.waves.forEach((k, n) => {
                if (was < k && g.crank >= k) {
                    // Out of the hull: crawlers along the canal floor, Hollows over the far bank.
                    const out: [string, Enemy["kind"], number, number][] = n === 0
                        ? [["crawler", "crawler", BARGE[0] + 20, -54], ["crawler", "crawler", BARGE[0] + 30, -56], ["hollow", "hollow", 86, -30]]
                        : [["crawler", "crawler", BARGE[0] + 26, -52], ["hollow", "hollow", 50, -30], ["hollow", "hollow", 88, -38], ["roller", "roller", 80, -24]];
                    out.forEach(([name, kind, x, z], i) => g.spawn(`mast${n}-${name}-${i}`, kind, [x, noctisHeight(x, z), z], "barge"));
                    g.events.push({ kind: "wave", n });
                }
            });
            if (was < 0.5 && g.crank >= 0.5) g.say("mastHalf");
            if (g.crank >= 1) { g.flags.add("mast"); g.say("mastUp"); g.events.push({ kind: "objective", id: "mast" }); }
            break;
        }
        case "lift": {
            const L = u.id === "quarry-lift" ? QLIFT : HOIST;
            g.rideLift = L.id;
            const pl = g.player;
            pl.riding = true; pl.crouched = false; pl.rollT = -1;
            pl.pos = [(L.x0 + L.x1) / 2, g.cages.get(L.id)!.y, (L.z0 + L.z1) / 2];
            ok();
            if (L === QLIFT) { g.say("trap"); g.setStage("descend"); }
            else { g.say("ascent"); g.setStage("ascent"); }
            break;
        }
        default: break;
    }
}

/** Carried by a lift: the quarry's down into the Undercroft, the hoist up to the Tithe's ledge. */
export function m2Ride(g: Game, dt: number): void {
    const id = g.rideLift;
    const p = g.player;
    if (!id) { p.riding = false; return; }
    const L = LIFTS[id as keyof typeof LIFTS], cage = g.cages.get(id)!;
    const down = L === QLIFT;
    cage.y = down ? Math.max(L.bottom, cage.y - dt * 3) : Math.min(L.top, cage.y + dt * 4.6);
    cage.floor.min[1] = cage.y - 0.3; cage.floor.max[1] = cage.y;
    p.pos = [p.pos[0], cage.y, p.pos[2]];
    p.vel = [0, 0, 0]; p.speed = 0; p.grounded = true; p.aiming = false;
    if (cage.y !== (down ? L.bottom : L.top)) return;
    p.riding = false; g.rideLift = null;
    if (down) { g.say("undercroft"); g.setStage("undercroft"); }
    else { ambush(g); g.setStage("rim"); }
}

/** The Tithe at the top of the hoist. */
function ambush(g: Game): void {
    AMBUSH.forEach((pos, i) => { if (!g.enemies.some(e => e.id === `rim-scav-${i}`)) g.spawn(`rim-scav-${i}`, "scavenger", pos, "ledge"); });
}

/** A machine knocked down, spared or broken (beacons and the heart only break). */
export function m2Damaged(g: Game, e: Enemy): void {
    if (e.kind === "beacon" && e.state === "destroyed") g.events.push({ kind: "toast", text: `BEACON DOWN  ${beaconsDown(g)} / 3` });
    if (e.kind === "nest" && e.state === "destroyed") {
        g.openDoor("tunnel-door");
        // Its brood dies with it.
        for (const k of g.enemies) if (k.spawned && k.zone === "nest" && k.state !== "destroyed") { k.state = "stunned"; k.stateT = -10; k.hp = 0; k.charge = 0; }
        g.say("nestDown");
        if (g.stage === "nest" || g.stage === "undercroft") g.setStage("tunnel");
    }
}

/** After a load: the lifts where the story left them, the pumphouse quiet if it was, the ambush if it's on. */
export function m2Load(g: Game): void {
    if (reached(g, "undercroft")) setCage(g, "quarry", QLIFT.bottom);
    if (reached(g, "rim")) { setCage(g, "hoist", HOIST.top); ambush(g); }
    if (g.flags.has("beacons")) for (let i = g.enemies.length - 1; i >= 0; i--) if (g.enemies[i].zone === "pumphouse" && g.enemies[i].kind === "hollow") g.enemies.splice(i, 1);
    if (g.flags.has("foundry")) for (const e of g.enemies) e.dormant = false;
    if (g.flags.has("weapon:scatter")) g.player.weapon = "scatter";
    for (const id of ["intro2", "embark"]) if (reached(g, "noctis")) g.said.add(id);
    syncNpcs(g);
}
function setCage(g: Game, id: string, y: number): void {
    const c = g.cages.get(id)!;
    c.y = y; c.floor.min[1] = y - 0.3; c.floor.max[1] = y;
}

/** A save that starts Noctis at `stage`, with everything before it done (the test tools use it). */
export function m2StageSave(stage: StageId): RunSave {
    const at: Partial<Record<StageId, string>> = {
        embark: "camp", noctis: "camp", silence: "quay", camp: "camp", signal: "camp", beacons: "pumphouse", survivors: "pumphouse", tithe: "pumphouse",
        descend: "pumphouse", undercroft: "undercroft", nest: "undercroft", tunnel: "platform", ascent: "platform", rim: "ledge",
    };
    const i = stageIndex(stage), flags: string[] = [], machines: RunSave["machines"] = {};
    const past = (id: StageId) => i > stageIndex(id);
    if (past("embark")) flags.push("weapon:scatter");
    if (past("noctis")) flags.push("foundry", "gate", "mast", "weapon:gravity", "doctor-gone");
    if (past("beacons")) { flags.push("beacons", "open:pump-door"); for (const b of BEACONS) machines[b.id] = "destroyed"; }
    if (past("tithe")) flags.push("tithe-at-lift");
    if (past("nest")) { flags.push("open:tunnel-door"); machines.nest = "destroyed"; }
    const s: StageId = stage === "descend" ? "tithe" : stage === "ascent" ? "tunnel" : stage;
    return { v: 2, stage: s, checkpoint: at[stage] ?? "camp", taken: [], collected: [], flags, machines, resets: 0, destroyed: 0, deaths: 0, time: 0, usedSim: false, cells: past("noctis") ? 4 : 0, crank: past("noctis") ? 1 : 0 };
}

export { NEST };
