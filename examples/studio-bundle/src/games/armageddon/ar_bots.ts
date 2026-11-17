// How Armageddon 2070's bots think: perception and fields here, decisions in the WIR networks.
//
// Every few seconds the strategic network picks each squad's territory; every second the squad
// network picks its mode; every ~0.35 s each soldier fills a 5 x 5 window of local fields around
// its 2 m cell (path distance to its objective, distance to the threat, distance to cover facing the
// threat, distance to its squad anchor or the player's call point, exposure to known enemies,
// walls, friends), runs the senses grid program and its role's brain, and the host carries out the
// decision: step to the chosen neighbour cell or hold, fire, reload, crouch, throw, launch.
// Vehicles do the same on a 4 m grid (tanks, transports, mecha) or a 16 m air grid (helicopters),
// and jets pick attack-run phases. `b.check` compares every decision with its rule.

import { Battle, eyeOf, chestOf, dirOf, driveVehicle, type Soldier, type Squad, type VehicleState, type Team, type Slot } from "./ar_sim";
import { World, HALF, NAV_INF, NAV_VEH, NI, NV, FAR } from "./ar_map";
import { WEAPON, REWARD } from "./ar_data";
import { DIRS, HOLD, MODES, rule, senseRule, hot, type Vals, type Mode } from "./ar_wir";
import { clamp, type V3 } from "../nebula/nk_math";

const INF_THINK = 0.35, VEH_THINK = 0.3, SQUAD_THINK = 1, PLAN_THINK = 4;
/** Seconds a bot needs on a new target before its first shot. */
const REACTION = 0.45;

/** The whole bot pass for one step. */
export function think(b: Battle, dt: number): void {
    const t0 = Date.now();
    for (const team of [0, 1] as Team[]) crewVehicles(b, team);
    for (const sq of b.squads) {
        if (b.time >= sq.planAt) { sq.planAt = b.time + PLAN_THINK; plan(b, sq); }
        if (b.time >= sq.thinkAt) { sq.thinkAt = b.time + SQUAD_THINK; squadThink(b, sq); }
    }
    for (const s of b.soldiers) {
        if (!s.alive || !s.bot) continue;
        if (s.vehicle >= 0) { gunnerStep(b, s); continue; }
        if (b.time >= s.thinkAt) { s.thinkAt = b.time + INF_THINK * (0.85 + 0.3 * b.rng.next()); infantryThink(b, s); }
        infantryAct(b, s, dt);
        if (s.rewards.length && b.rng.next() < dt * 0.25) botReward(b, s);
    }
    for (const v of b.vehicles) {
        if (!v.alive) continue;
        const driver = b.driverOf(v);
        if (!driver || !driver.bot) continue;
        if (b.time >= v.thinkAt) { v.thinkAt = b.time + VEH_THINK; vehicleThink(b, v, driver); }
        vehicleAct(b, v, driver, dt);
    }
    b.wirStats.ms = b.wirStats.ms * 0.95 + (Date.now() - t0) * 0.05;
}

// --- perception -----------------------------------------------------------------------------------

interface Contact { kind: "soldier" | "vehicle"; id: number; pos: V3; d: number; visible: boolean; armor: boolean; air: boolean; at: boolean }

/** What a soldier (or a vehicle crew at `from`) knows: visible enemies, plus spotted ones. */
function contacts(b: Battle, team: Team, from: V3, range: number, self: number, max = 6): Contact[] {
    const out: Contact[] = [];
    const ids: number[] = [];
    const cands: { id: number; d: number }[] = [];
    for (const id of b.near(from[0], from[2], range, ids)) { const o = b.soldiers[id]; if (o.team !== team && o.alive && o.id !== self) cands.push({ id, d: Math.hypot(o.pos[0] - from[0], o.pos[2] - from[2]) }); }
    cands.sort((p, q) => p.d - q.d);
    let checks = 0;
    for (const c of cands) {
        const o = b.soldiers[c.id];
        const spotted = b.spotted[team].has(o.id);
        let visible = false;
        if (c.d <= b.detectRange(o) && checks < max) { checks++; visible = b.sight(from, chestOf(o)); }
        if (!visible && !spotted) continue;
        const w = WEAPON.get(o.loadout.launcher ?? "");
        out.push({ kind: "soldier", id: o.id, pos: o.pos, d: c.d, visible, armor: false, air: false, at: !!w && w.locks !== "air" && o.mag.launcher + o.reserve.launcher > 0 });
        if (out.length >= max) break;
    }
    for (const v of b.vehicles) {
        if (!v.alive || v.team === team) continue;
        const d = Math.hypot(v.pos[0] - from[0], v.pos[2] - from[2]);
        const air = v.def.domain === "Air";
        if (d > (air ? 1400 : Math.max(range, 600))) continue;
        const visible = b.sight(from, [v.pos[0], v.pos[1] + (air ? 0 : 1.6), v.pos[2]]);
        if (!visible && !b.spotted[team].has(-1 - v.id)) continue;
        out.push({ kind: "vehicle", id: v.id, pos: v.pos, d, visible, armor: true, air, at: false });
    }
    return out.sort((p, q) => p.d - q.d);
}

// --- local fields and senses --------------------------------------------------------------------

interface Window {
    obj: (x: number, z: number) => number;
    thr: (x: number, z: number) => number;
    lead: (x: number, z: number) => number;
    cover: (x: number, z: number) => boolean;
    exp: (x: number, z: number) => number;
    wall: (x: number, z: number) => boolean;
    ally: (x: number, z: number) => boolean;
}

/** Fills the 7 sense channels on a 5 x 5 window (cell metres) and runs the senses network. */
function sense(b: Battle, cx: number, cz: number, cell: number, w: Window): { s: Vals; get: (c: number, dy: number, dx: number) => number } {
    const vals: number[][] = Array.from({ length: 7 }, () => new Array(25).fill(0));
    const at = (dy: number, dx: number): [number, number] => [cx + dx * cell, cz + dy * cell];
    const rel = (f: (x: number, z: number) => number, ch: number) => {
        const raw: number[] = [];
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const [x, z] = at(dy, dx); raw.push(w.wall(x, z) ? FAR : f(x, z)); }
        const finite = raw.filter(v => v < FAR);
        const c = raw[12] < FAR ? raw[12] : finite.length ? Math.min(...finite) : 0;
        for (let k = 0; k < 25; k++) vals[ch][k] = raw[k] >= FAR ? 48 : clamp(Math.round(raw[k] - (c - 16)), 0, 48);
    };
    rel(w.obj, 0); rel(w.thr, 1); rel(w.lead, 3);
    // Cover distance: octile distance (2 straight, 3 diagonal) to the nearest cover cell in a 9 x 9 window.
    const cov: [number, number][] = [];
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const [x, z] = at(dy, dx); if (!w.wall(x, z) && w.cover(x, z)) cov.push([dy, dx]); }
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        let best = 48;
        for (const [py, px] of cov) { const a = Math.abs(py - dy), c = Math.abs(px - dx); best = Math.min(best, 2 * (Math.max(a, c) - Math.min(a, c)) + 3 * Math.min(a, c)); }
        vals[2][(dy + 2) * 5 + dx + 2] = best;
    }
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const [x, z] = at(dy, dx), k = (dy + 2) * 5 + dx + 2;
        vals[4][k] = Math.abs(dy) <= 1 && Math.abs(dx) <= 1 ? w.exp(x, z) : 0;
        vals[5][k] = w.wall(x, z) ? 1 : 0;
        vals[6][k] = dy === 0 && dx === 0 ? 0 : w.ally(x, z) ? 1 : 0;
    }
    const get = (c: number, dy: number, dx: number) => vals[c][(dy + 2) * 5 + dx + 2];
    const s = b.wir.senses(get);
    b.wirStats.senses++;
    if (b.check) { const r = senseRule(get); for (const k in r) if (r[k] !== s[k]) { b.wirStats.mismatches++; break; } }
    return { s, get };
}

function runBrain(b: Battle, name: string, x: Vals): Vals {
    const out = b.wir.run(name, x);
    b.wirStats.decisions++;
    if (b.check) { const r = rule(b.wir, name, x); for (const k in r) if (Math.abs(r[k] - out[k]) > 1e-6) { b.wirStats.mismatches++; break; } }
    return out;
}

const oneHotIn = (x: Vals, prefix: string, n: number, k: number) => { for (let i = 0; i < n; i++) x[`${prefix}${i}`] = i === k ? 1 : 0; };
const fieldAt = (f: Uint16Array, n: number, cell: number) => (x: number, z: number) => World.sample(f, n, cell, x, z);

// --- strategy -------------------------------------------------------------------------------------

/** The strategic network: which territory each squad goes for. */
function plan(b: Battle, sq: Squad): void {
    const alive = sq.members.map(i => b.soldiers[i]).filter(s => s.alive);
    if (!alive.length) return;
    const c = centroid(alive);
    const x: Vals = {};
    const ts = b.territories.slice(0, 12);
    const assigned = new Map<string, number>();
    for (const o of b.squads) if (o.team === sq.team && o.id !== sq.id && o.objective) assigned.set(o.objective, (assigned.get(o.objective) ?? 0) + 1);
    for (let k = 0; k < 12; k++) {
        const t = ts[k];
        x[`v${k}`] = t ? 1 : 0;
        x[`en${k}`] = t && t.owner === 1 - sq.team ? 1 : 0;
        x[`ne${k}`] = t && t.owner === -1 ? 1 : 0;
        x[`ct${k}`] = t && t.contested ? 1 : 0;
        x[`cur${k}`] = t && t.def.id === sq.objective ? 1 : 0;
        x[`val${k}`] = t ? t.def.value : 1;
        x[`d${k}`] = t ? clamp(Math.round(Math.hypot(t.def.x - c[0], t.def.z - c[1]) / 64), 0, 15) : 15;
        x[`fr${k}`] = t ? clamp(assigned.get(t.def.id) ?? 0, 0, 6) : 0;
        x[`fo${k}`] = t ? clamp(Math.round(t.counts[1 - sq.team] / 8), 0, 6) : 0;
    }
    const out = runBrain(b, "ar_strategic_brain", x);
    b.wirStats.strategic++;
    const k = hot(out, "a", 12);
    if (k >= 0 && ts[k]) sq.objective = ts[k].def.id;
}

function squadThink(b: Battle, sq: Squad): void {
    const all = sq.members.map(i => b.soldiers[i]);
    const alive = all.filter(s => s.alive);
    if (sq.call && sq.call.until < b.time) sq.call = null;
    if (!alive.length || !sq.objective) return;
    const c = centroid(alive);
    const t = b.territories.find(q => q.def.id === sq.objective)!;
    const dobj = Math.hypot(t.def.x - c[0], t.def.z - c[1]);
    // Contact: enemies any member saw in its last look.
    const seen = new Set<number>(); let armor = 0;
    for (const s of alive) if (s.target >= 0 && s.targetKind === "soldier") seen.add(s.target); else if (s.target >= 0 && s.targetKind === "vehicle") armor++;
    sq.contact = seen.size; sq.armorSeen = Math.min(3, armor);
    const spread = Math.max(...alive.map(s => Math.hypot(s.pos[0] - c[0], s.pos[2] - c[1])));
    const mounted = alive.filter(s => s.vehicle >= 0).length * 2 >= alive.length ? 1 : 0;
    const transport = sq.vehicle >= 0 ? b.vehicles[sq.vehicle] : findTransport(b, sq, c, alive.length);
    const farmor = b.vehicles.some(v => v.alive && v.team === sq.team && v.def.armor > 0.8 && Math.hypot(v.pos[0] - c[0], v.pos[2] - c[1]) < 80) ? 1 : 0;
    const me = b.me;
    const x: Vals = {
        alive: alive.length, hp: clamp(Math.round(alive.reduce((s, m) => s + m.hp, 0) / alive.length / 10), 0, 10),
        contact: clamp(seen.size, 0, 8), armor: sq.armorSeen, farmor,
        dobj: clamp(Math.round(dobj / 25), 0, 20),
        ow0: t.owner === 1 - sq.team ? 1 : 0, ow1: t.owner === -1 ? 1 : 0, ow2: t.owner === sq.team ? 1 : 0,
        cont: t.contested ? 1 : 0, supp: clamp(Math.round(alive.reduce((s, m) => s + m.suppression, 0) / alive.length), 0, 4),
        spread: clamp(Math.round(spread / 5), 0, 10), call: sq.call ? 1 : 0,
        veh: transport && transport.alive ? 1 : 0, mounted,
    };
    oneHotIn(x, "c", 7, MODES.indexOf(sq.mode));
    const out = runBrain(b, "ar_squad_brain", x);
    b.wirStats.squad++;
    const m = hot(out, "mode", 7);
    const before = sq.mode;
    if (m >= 0) sq.mode = MODES[m];
    if (sq.mode === "mount" && transport && transport.alive) { sq.vehicle = transport.id; transport.squad = sq.id; }
    else if (before === "mount" && sq.mode !== "mount" && !mounted && sq.vehicle >= 0) { const v = b.vehicles[sq.vehicle]; if (v.squad === sq.id && b.passengers(v) <= 1) v.squad = -1; sq.vehicle = -1; }
    if (sq.mode === "flank" && !sq.flank) {
        // Fireteam B swings wide: 70 m to the side of the line to the objective (the side with fewer friends).
        const dx = t.def.x - c[0], dz = t.def.z - c[1], l = Math.hypot(dx, dz) || 1;
        const side = (sq.id % 2 ? 1 : -1) * 70;
        sq.flank = [Math.round((t.def.x - (dx / l) * 25 + (-dz / l) * side) / 16) * 16, Math.round((t.def.z - (dz / l) * 25 + (dx / l) * side) / 16) * 16];
    } else if (sq.mode !== "flank") sq.flank = null;
    void me;
}

function findTransport(b: Battle, sq: Squad, c: [number, number], need: number): VehicleState | null {
    let best: VehicleState | null = null, bd = 90;
    for (const v of b.vehicles) {
        if (!v.alive || v.team !== sq.team || v.squad >= 0 || v.temporary) continue;
        if (!["V002", "V003", "V004", "V014", "V015", "V009", "V001"].includes(v.def.id)) continue;
        const free = v.seats.filter(x => x < 0).length;
        if (free < Math.min(need, 4)) continue;
        const d = Math.hypot(v.pos[0] - c[0], v.pos[2] - c[1]);
        if (d < bd) { bd = d; best = v; }
    }
    return best;
}

function centroid(ss: Soldier[]): [number, number] {
    let x = 0, z = 0;
    for (const s of ss) { x += s.pos[0]; z += s.pos[2]; }
    return [x / ss.length, z / ss.length];
}

// --- infantry -------------------------------------------------------------------------------------

const BRAIN: Record<string, string> = { leader: "ar_rifle_brain", rifleman: "ar_rifle_brain", medic: "ar_rifle_brain", engineer: "ar_antiarmor_brain", support: "ar_support_brain", marksman: "ar_marksman_brain", recon: "ar_marksman_brain", antiarmor: "ar_antiarmor_brain" };

function infantryThink(b: Battle, s: Soldier): void {
    const sq = b.squads[s.squad];
    const eye = eyeOf(s);
    const hasL = !!s.loadout.launcher && s.mag.launcher + s.reserve.launcher > 0;
    // Aircraft are only a target for AA launchers, or when low and close enough for small arms to matter
    // (otherwise every rifleman on the map would stop and plink at helicopters 1 km away).
    const hasAA = hasL && s.loadout.launcher === "W015";
    const cs = contacts(b, s.team, eye, 420, s.id).filter(c => !c.air || hasAA || c.d < 180);
    const visible = cs.filter(c => c.visible);
    // Anti-armor soldiers with a launcher prefer vehicles.
    const pick = (hasL ? visible.find(c => c.armor && !c.air && c.d < 600) : undefined) ?? visible.find(c => !c.air) ?? visible[0];
    const threat = pick ?? cs[0];
    // A fresh contact takes the full reaction time; switching between targets already in a fight is quicker.
    if (pick && (pick.id !== s.target || pick.kind !== s.targetKind)) s.aimTime = s.target >= 0 ? Math.min(s.aimTime, REACTION) * 0.6 : 0;
    s.target = pick ? pick.id : -1; s.targetKind = pick ? pick.kind : "";
    const t = b.territories.find(q => q.def.id === sq.objective);
    // Objective field: the squad's territory, a flank point for fireteam B, the transport, or home.
    let objKey = t ? t.def.id : `base${s.team}`;
    const idx = sq.members.indexOf(s.id);
    const flankPt = sq.mode === "flank" && sq.flank && idx >= 4 ? sq.flank : null;
    if (sq.mode === "fallback") {
        const home = b.territories.filter(q => q.owner === s.team && q.def.id !== sq.objective).sort((p, q) => Math.hypot(p.def.x - s.pos[0], p.def.z - s.pos[2]) - Math.hypot(q.def.x - s.pos[0], q.def.z - s.pos[2]))[0];
        objKey = home ? home.def.id : `base${s.team}`;
    }
    const transport = sq.mode === "mount" && sq.vehicle >= 0 ? b.vehicles[sq.vehicle] : null;
    let objFn: (x: number, z: number) => number;
    if (transport && transport.alive) {
        const vp = transport.pos;
        objFn = (x, z) => Math.hypot(x - vp[0], z - vp[2]);
        if (Math.hypot(s.pos[0] - vp[0], s.pos[2] - vp[2]) < Math.max(6, transport.def.dims[0] * 0.6) && (transport.landed || transport.def.domain === "Ground")) { if (b.enterVehicle(s, transport)) return; }
    } else if (flankPt) objFn = (x, z) => Math.hypot(x - flankPt[0], z - flankPt[1]);
    else objFn = fieldAt(b.world.flow(objKey, "inf"), NI, NAV_INF);
    // The anchor: the player's call point (path distance), else the squad leader.
    const call = sq.call && Math.hypot(sq.call.x - s.pos[0], sq.call.z - s.pos[2]) < 250 ? sq.call : null;
    const leader = sq.members.map(i => b.soldiers[i]).find(m => m.alive && m.id !== s.id && m.vehicle < 0);
    let leadFn: (x: number, z: number) => number;
    let dl = 0;
    if (call) { const f = b.world.flow(`${Math.round(call.x / 8) * 8},${Math.round(call.z / 8) * 8}`, "inf"); leadFn = fieldAt(f, NI, NAV_INF); dl = Math.min(FAR - 1, leadFn(s.pos[0], s.pos[2])); }
    else if (leader) { const lp = leader.pos; leadFn = (x, z) => Math.hypot(x - lp[0], z - lp[2]); dl = leadFn(s.pos[0], s.pos[2]); }
    else leadFn = () => 0;
    const tp = threat?.pos;
    const threats = visible.slice(0, 2).map(c => (c.kind === "soldier" ? eyeOf(b.soldiers[c.id]) : [c.pos[0], c.pos[1] + 2, c.pos[2]] as V3));
    const world = b.world;
    const cx = Math.floor((s.pos[0] + HALF) / NAV_INF) * NAV_INF - HALF + 1, cz = Math.floor((s.pos[2] + HALF) / NAV_INF) * NAV_INF - HALF + 1;
    const { s: senses } = sense(b, cx, cz, NAV_INF, {
        obj: objFn,
        thr: tp ? (x, z) => Math.hypot(x - tp[0], z - tp[2]) : () => 300,
        lead: leadFn,
        cover: (x, z) => {
            // Cover: something at least 0.9 m tall within 2.5 m toward the threat (or beside it).
            if (tp) { const dx = tp[0] - x, dz = tp[2] - z, l = Math.hypot(dx, dz) || 1; for (const r of [1, 1.8, 2.5]) if (world.coverHeight(x + (dx / l) * r, z + (dz / l) * r) >= 0.9) return true; return false; }
            for (const [ox, oz] of [[1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]]) if (world.coverHeight(x + ox, z + oz) >= 0.9) return true;
            return false;
        },
        exp: (x, z) => { const y = world.height(x, z) + 1.2; for (const e of threats) if (b.sight(e, [x, y, z])) return 1; return 0; },
        wall: (x, z) => world.infBlocked(x, z),
        ally: (x, z) => { const i = Math.floor((x + HALF) / NAV_INF), j = Math.floor((z + HALF) / NAV_INF); return i >= 0 && j >= 0 && i < NI && j < NI && b.occupancy[j * NI + i] > 0; },
    });
    const w = b.weaponOf(s);
    const size = b.magSize(s, s.slot);
    const x: Vals = {
        ...senses,
        hp: clamp(Math.ceil(s.hp / 10), 1, 10),
        ammo: s.mag[s.slot] <= 0 ? 0 : clamp(Math.ceil((s.mag[s.slot] / size) * 6), 1, 6),
        supp: clamp(Math.round(s.suppression), 0, 4),
        call: call ? 1 : 0,
        dt: tp ? clamp(Math.round(Math.hypot(tp[0] - s.pos[0], tp[2] - s.pos[2]) / 5), 0, 40) : 40,
        vis: pick ? 1 : 0, armor: pick?.armor ? 1 : 0,
        dl: clamp(Math.round(dl / 5), 0, 12),
        gren: s.grenades > 0 ? 1 : 0, hasl: hasL ? 1 : 0,
    };
    oneHotIn(x, "o", 9, s.option);
    oneHotIn(x, "m", 7, MODES.indexOf(sq.mode));
    const out = runBrain(b, BRAIN[s.role], x);
    b.wirStats.infantry++;
    const o = hot(out, "o2_", 9);
    s.option = o >= 0 ? o : HOLD;
    if (s.option === HOLD) s.goal = null;
    else { const [dy, dx] = DIRS[s.option]; s.goal = [cx + dx * NAV_INF, cz + dy * NAV_INF]; }
    s.fireWanted = out.fire > 0.5 && !!pick;
    s.crouchWanted = out.crouch > 0.5;
    if (out.reload > 0.5 && !s.fireWanted) b.startReload(s);
    if (out.launch > 0.5 && pick?.armor && hasL) s.slot = "launcher";
    else if (s.slot === "launcher" && (!pick?.armor || !hasL)) s.slot = "primary";
    if (out.grenade > 0.5 && pick && s.grenades > 0 && b.rng.next() < 0.35) {
        const d = Math.hypot(pick.pos[0] - s.pos[0], pick.pos[2] - s.pos[2]);
        b.throwGrenade(s, Math.atan2(pick.pos[0] - s.pos[0], pick.pos[2] - s.pos[2]), Math.atan2(d * 0.35, d) - 0.2, "Fragmentation Grenade");
    }
    // Medics and engineers help on the way.
    if (s.role === "medic" && b.rng.next() < 0.3) { const e = s.equipment.find(q => q.id === "E006" && q.left > 0); const ids: number[] = []; if (e && b.near(s.pos[0], s.pos[2], 3, ids).some(i => b.soldiers[i].team === s.team && b.soldiers[i].hp < 60)) b.useEquipment(s, null); }
    if ((s.role === "engineer" || s.role === "marksman" || s.role === "recon") && sq.mode === "defend" && t && Math.hypot(t.def.x - s.pos[0], t.def.z - s.pos[2]) < t.def.radius && b.rng.next() < 0.05) b.useEquipment(s, null);
    if (s.role === "support" && s.equipment.some(q => q.id === "E008" && q.left > 0) && sq.contact > 0 && b.rng.next() < 0.1) b.useEquipment(s, null);
    void w;
}

/** Every step: move toward the chosen cell, face and shoot the target. */
function infantryAct(b: Battle, s: Soldier, dt: number): void {
    const sq = b.squads[s.squad];
    s.stance = s.crouchWanted ? (s.suppression > 3 && !s.goal ? "prone" : "crouch") : "stand";
    const tgt = s.target >= 0 ? (s.targetKind === "vehicle" ? b.vehicles[s.target] : b.soldiers[s.target]) : null;
    if (s.goal) {
        const dx = s.goal[0] - s.pos[0], dz = s.goal[1] - s.pos[2], d = Math.hypot(dx, dz);
        const calm = !tgt && s.suppression < 0.5 && (sq.mode === "advance" || sq.mode === "mount" || sq.mode === "regroup" || sq.mode === "fallback");
        const speed = (s.stance === "crouch" ? 2.6 : calm ? 6.2 : 4.4) * s.stats.speedShare;
        if (d < 0.25) { s.vel[0] = 0; s.vel[2] = 0; s.goal = null; }
        else { s.vel[0] = (dx / d) * Math.min(speed, d / dt); s.vel[2] = (dz / d) * Math.min(speed, d / dt); if (!tgt) s.yaw = turnToward(s.yaw, Math.atan2(dx, dz), dt * 6); }
    } else { s.vel[0] = 0; s.vel[2] = 0; }
    if (!tgt || !tgt.alive) return;
    const aimAt: V3 = s.targetKind === "vehicle" ? [tgt.pos[0], tgt.pos[1] + 1.4, tgt.pos[2]] : chestOf(tgt as Soldier);
    const e = eyeOf(s);
    const dx = aimAt[0] - e[0], dy = aimAt[1] - e[1], dz = aimAt[2] - e[2], horiz = Math.hypot(dx, dz);
    const wantYaw = Math.atan2(dx, dz), wantPitch = Math.atan2(dy, horiz);
    s.yaw = turnToward(s.yaw, wantYaw, dt * 5);
    s.pitch = wantPitch;
    s.aimTime += dt;
    if (!s.fireWanted || Math.abs(angleDiff(s.yaw, wantYaw)) > 0.2) return;
    const w = b.weaponOf(s);
    // Bursts: automatic weapons fire 3-6 rounds, then pause.
    if (w.rpm > 300) { if (s.burst <= 0) { if (b.rng.next() < dt * 2.5) s.burst = 3 + Math.floor(b.rng.next() * 4); else return; } }
    // Human-like aim: a reaction delay on a new target, a bell-shaped error that settles over ~2.5 s,
    // worse when suppressed, moving or far, and tracking lag on a moving target (shots trail it).
    if (s.aimTime < REACTION) return;
    const base = s.role === "marksman" || s.role === "recon" ? 0.22 : s.role === "support" ? 0.75 : 0.5;
    const self = Math.hypot(s.vel[0], s.vel[2]) > 0.8 ? 1.6 : 1;
    const sigmaDeg = base * (1 + 1.5 * Math.max(0, 1 - s.aimTime / 2.5)) * self + s.suppression * 0.4 + horiz / 500;
    const tv = s.targetKind === "vehicle" ? (() => { const v = tgt as VehicleState; return [Math.sin(v.yaw) * v.speed, Math.cos(v.yaw) * v.speed]; })() : [(tgt as Soldier).vel[0], (tgt as Soldier).vel[2]];
    const omega = (dz * tv[0] - dx * tv[1]) / Math.max(1, horiz * horiz);
    const sigma = (sigmaDeg * Math.PI) / 180 + Math.abs(omega) * 0.15;
    const gauss = () => b.rng.range(-1, 1) + b.rng.range(-1, 1) + b.rng.range(-1, 1);
    const fired = b.fire(s, wantYaw - omega * 0.2 + gauss() * sigma, wantPitch + gauss() * sigma * 0.7, true, s.targetKind === "vehicle" ? s.target : -1, s.targetKind);
    if (fired && w.rpm > 300) s.burst--;
}

function gunnerStep(b: Battle, s: Soldier): void {
    const v = b.vehicles[s.vehicle];
    if (!v || s.seat === 0) return;
    const gi = v.def.guns.findIndex(g => g.seat === s.seat);
    if (gi < 0 || b.rng.next() > 0.3) return;
    const g = v.def.guns[gi];
    const from: V3 = [v.pos[0], v.pos[1] + 2, v.pos[2]];
    const cs = contacts(b, v.team, from, g.range, -1, 3).filter(c => c.visible && c.d < g.range && (!c.armor || g.vsVehicle > 0));
    if (cs[0]) b.vehicleFire(v, gi, [cs[0].pos[0], cs[0].pos[1] + 1, cs[0].pos[2]], s.id, cs[0].id, cs[0].kind);
}

// --- vehicles -------------------------------------------------------------------------------------

/** Idle vehicles at a base get a crew from bots who just spawned there. */
function crewVehicles(b: Battle, team: Team): void {
    if (Math.floor(b.time * 2) === Math.floor((b.time - 1 / 30) * 2)) return;
    for (const v of b.vehicles) {
        if (!v.alive || v.team !== team || v.seats[0] >= 0 || v.temporary) continue;
        const near = v.def.domain === "Air" ? 260 : 120;
        const ids: number[] = [];
        const pilot = b.near(v.pos[0], v.pos[2], near, ids).map(i => b.soldiers[i]).find(s => s.bot && s.team === team && s.alive && s.vehicle < 0 && b.time - s.spawnedAt < 4 && s.squad !== b.me?.squad);
        if (!pilot) continue;
        b.enterVehicle(pilot, v, 0);
        if (v.def.domain === "Air" && v.def.topSpeed > 500) { v.altitude = b.world.height(v.pos[0], v.pos[2]) + 220; }
    }
}

function vehicleThink(b: Battle, v: VehicleState, driver: Soldier): void {
    if (v.def.domain === "Air") { if (v.def.topSpeed > 500) jetThink(b, v); else heliThink(b, v); return; }
    groundThink(b, v, driver);
}

/** The objective for an unassigned combat vehicle: the strategic pick of the nearest friendly squad, else the nearest enemy territory. */
function vehicleObjective(b: Battle, v: VehicleState): string {
    if (v.squad >= 0) return b.squads[v.squad].objective || `base${v.team}`;
    const own = b.squads.filter(q => q.team === v.team && q.objective).map(q => ({ q, d: Math.hypot(b.territories.find(t => t.def.id === q.objective)!.def.x - v.pos[0], b.territories.find(t => t.def.id === q.objective)!.def.z - v.pos[2]) }));
    own.sort((p, q) => p.d - q.d);
    const pickIdx = v.id % Math.max(1, Math.min(3, own.length));
    return own[pickIdx]?.q.objective ?? `base${1 - v.team}`;
}

function groundThink(b: Battle, v: VehicleState, driver: Soldier): void {
    const from: V3 = [v.pos[0], v.pos[1] + 2.5, v.pos[2]];
    const cs = contacts(b, v.team, from, 650, -1, 8);
    const vis = cs.filter(c => c.visible);
    const counts = { tanks: vis.filter(c => c.armor && !c.air).length, at: vis.filter(c => c.at && c.d < 300).length, inf: vis.filter(c => !c.armor).length, air: vis.filter(c => c.air).length };
    const near = cs[0];
    const tp = near?.pos;
    const objKey = vehicleObjective(b, v);
    const t = b.territories.find(q => q.def.id === objKey);
    const sq = v.squad >= 0 ? b.squads[v.squad] : null;
    const members = sq ? sq.members.map(i => b.soldiers[i]).filter(m => m.alive) : [];
    const outside = members.filter(m => m.vehicle !== v.id);
    const pax = v.seats.slice(1).filter(id => id >= 0 && members.some(m => m.id === id)).length;
    const transport = v.def.wir === "apc";
    const c = outside.length ? centroid(outside) : null;
    const world = b.world;
    const objF = world.flow(objKey, "veh");
    const cx = Math.floor((v.pos[0] + HALF) / NAV_VEH) * NAV_VEH - HALF + 2, cz = Math.floor((v.pos[2] + HALF) / NAV_VEH) * NAV_VEH - HALF + 2;
    const supportSq = !transport ? b.squads.find(q => q.team === v.team && q.objective === objKey && q.members.some(i => b.soldiers[i].alive && Math.hypot(b.soldiers[i].pos[0] - v.pos[0], b.soldiers[i].pos[2] - v.pos[2]) < 150)) : null;
    const sc = supportSq ? centroid(supportSq.members.map(i => b.soldiers[i]).filter(m => m.alive)) : c;
    const half = (x: number) => x / 2; // metres to 4 m-grid field units
    const { s: senses } = sense(b, cx, cz, NAV_VEH, {
        obj: transport && pax === 0 && outside.length && c ? (x, z) => half(Math.hypot(x - c[0], z - c[1])) : fieldAt(objF, NV, NAV_VEH),
        thr: tp ? (x, z) => half(Math.hypot(x - tp[0], z - tp[2])) : () => 150,
        lead: sc ? (x, z) => half(Math.hypot(x - sc[0], z - sc[1])) : () => 0,
        cover: (x, z) => { if (!tp) return false; const dx = tp[0] - x, dz = tp[2] - z, l = Math.hypot(dx, dz) || 1; for (const r of [3, 5, 7]) if (world.coverHeight(x + (dx / l) * r, z + (dz / l) * r) >= 1.4) return true; return false; },
        exp: (x, z) => { for (const c2 of vis.slice(0, 2)) if (b.sight([c2.pos[0], c2.pos[1] + 1.6, c2.pos[2]], [x, world.height(x, z) + 2, z])) return 1; return 0; },
        wall: (x, z) => world.vehBlocked(x, z),
        ally: (x, z) => b.vehicles.some(o => o.alive && o.id !== v.id && o.def.domain === "Ground" && Math.abs(o.pos[0] - x) < 3 && Math.abs(o.pos[2] - z) < 3),
    });
    const tdist = tp ? clamp(Math.round(Math.hypot(tp[0] - v.pos[0], tp[2] - v.pos[2]) / 25), 0, 40) : 40;
    const hp = clamp(Math.ceil((v.hp / v.def.hp) * 10), 1, 10);
    const x: Vals = { ...senses, hp, tdist, vis: vis.length ? 1 : 0, tanks: clamp(counts.tanks, 0, 3), at: clamp(counts.at, 0, 3), inf: clamp(counts.inf, 0, 8) };
    oneHotIn(x, "o", 9, v.option);
    let name: string;
    let out: Vals;
    if (v.mecha) {
        name = `ar_mecha_${v.mecha.id === "M001" ? "titan" : v.mecha.id === "M002" ? "wraith" : "bastion"}`;
        const p = v.parts!, m = v.mecha.parts;
        const q = (a: number, full: number) => (a <= 0 ? 0 : clamp(Math.ceil((a / full) * 4), 1, 4));
        Object.assign(x, { legs: q(p.legs, m.legs), larm: q(p.left, m.left), rarm: q(p.right, m.right), torso: Math.max(1, q(p.torso, m.torso)), air: clamp(counts.air, 0, 2) });
        out = runBrain(b, name, x);
        const wp = hot(out, "wpn", 4);
        v.braced = out.brace > 0.5;
        if (out.fire > 0.5 && wp >= 0 && wp < 3) { const tg = vis.find(c2 => wp === 2 ? true : c2.armor) ?? vis[0]; if (tg) { v.turretYaw = Math.atan2(tg.pos[0] - v.pos[0], tg.pos[2] - v.pos[2]); b.vehicleFire(v, wp, [tg.pos[0], tg.pos[1] + 1, tg.pos[2]], driver.id, tg.id, tg.kind); } }
    } else if (v.def.wir === "tank") {
        name = `ar_tank_${v.def.id === "V006" ? "destroyer" : v.def.id === "V007" ? "antiair" : v.def.id === "V008" ? "artillery" : "mbt"}`;
        const own = t && t.owner === v.team;
        Object.assign(x, { loaded: b.time >= v.nextShot[0] && v.ammo[0] > 0 ? 1 : 0, smoke: v.countermeasures > 0 ? 1 : 0, air: clamp(counts.air, 0, 2), g0: !own && !supportSq ? 1 : 0, g1: !own && supportSq ? 1 : 0, g2: own && t?.contested ? 1 : 0, dl: sc ? clamp(Math.round(Math.hypot(sc[0] - v.pos[0], sc[1] - v.pos[2]) / 25), 0, 12) : 0 });
        if (x.g0 + x.g1 + x.g2 === 0) x.g0 = 1;
        out = runBrain(b, name, x);
        const tg = hot(out, "tgt", 5);
        const cls = (c2: (typeof vis)[number]) => (tg === 0 ? c2.armor && !c2.air : tg === 1 ? c2.at : tg === 2 ? !c2.armor : tg === 3 ? c2.air : false);
        const target = vis.find(cls);
        v.target = target ? target.id : -1; v.targetKind = target ? target.kind : "";
        if (target) {
            const aim: V3 = [target.pos[0], target.pos[1] + (target.air ? 0 : 1.2), target.pos[2]];
            v.turretYaw = Math.atan2(aim[0] - v.pos[0], aim[2] - v.pos[2]);
            if (out.fire > 0.5) b.vehicleFire(v, v.def.id === "V007" && target.air && target.d > 900 ? 1 : 0, aim, driver.id, target.id, target.kind);
            if (out.coax > 0.5 && v.def.guns[1]) { const inf = vis.find(c2 => !c2.armor); if (inf) b.vehicleFire(v, 1, [inf.pos[0], inf.pos[1] + 1, inf.pos[2]], driver.id); }
        } else if (v.def.id === "V008" && t && t.owner !== v.team) {
            // Artillery shells the objective when it cannot see anything.
            if (b.rng.next() < 0.2) b.vehicleFire(v, 0, [t.def.x, b.world.height(t.def.x, t.def.z), t.def.z], driver.id);
        }
        if (out.smoke2 > 0.5 && v.countermeasures > 0 && b.time - v.smokeAt > 10) { v.countermeasures--; v.smokeAt = b.time; b.clouds.push({ x: v.pos[0], y: v.pos[1] + 2, z: v.pos[2], r: 10, until: b.time + 15, kind: "smoke" }); }
    } else {
        name = `ar_apc_${v.def.id === "V004" ? "ifv" : v.def.id === "V003" ? "apc" : "light"}`;
        const dobj = t ? Math.hypot(t.def.x - v.pos[0], t.def.z - v.pos[2]) : 0;
        Object.assign(x, { pax: clamp(pax, 0, 6), wait: clamp(sq && sq.mode === "mount" ? outside.length : 0, 0, 6), near: outside.some(m => Math.hypot(m.pos[0] - v.pos[0], m.pos[2] - v.pos[2]) < 15) ? 1 : 0, dobj: clamp(Math.round(dobj / 25), 0, 20), atgm: v.def.guns[1]?.locks && v.ammo[1] > 0 ? 1 : 0, smoke: v.countermeasures > 0 ? 1 : 0 });
        out = runBrain(b, name, x);
        if (out.dismount > 0.5) { for (const id of v.seats.slice(1)) if (id >= 0 && members.some(m => m.id === id)) b.exitVehicle(b.soldiers[id]); if (sq) { sq.mode = "advance"; sq.vehicle = -1; } v.squad = -1; }
        const target = vis[0];
        if (target) {
            v.turretYaw = Math.atan2(target.pos[0] - v.pos[0], target.pos[2] - v.pos[2]);
            if (out.fire > 0.5 && v.def.guns[0] && (!target.armor || v.def.guns[0].vsVehicle > 0)) b.vehicleFire(v, 0, [target.pos[0], target.pos[1] + 1, target.pos[2]], driver.id, target.id, target.kind);
            if (out.atgm2 > 0.5) { const tank = vis.find(c2 => c2.armor && !c2.air); if (tank) b.vehicleFire(v, 1, [tank.pos[0], tank.pos[1] + 1, tank.pos[2]], driver.id, tank.id, "vehicle"); }
        }
        if (out.smoke2 > 0.5 && v.countermeasures > 0 && b.time - v.smokeAt > 10) { v.countermeasures--; v.smokeAt = b.time; b.clouds.push({ x: v.pos[0], y: v.pos[1] + 2, z: v.pos[2], r: 10, until: b.time + 15, kind: "smoke" }); }
    }
    b.wirStats.vehicle++;
    const o = hot(out, "o2_", 9);
    v.option = o >= 0 ? o : HOLD;
    if (v.option === HOLD) v.goal = null;
    else { const [dy, dx] = DIRS[v.option]; v.goal = [cx + dx * NAV_VEH * 2, cz + dy * NAV_VEH * 2]; }
    // Bail out of a burning vehicle.
    if (v.hp < v.def.hp * 0.12 && !v.mecha) for (const id of [...v.seats]) if (id >= 0 && b.soldiers[id].bot) b.exitVehicle(b.soldiers[id]);
}

function heliThink(b: Battle, v: VehicleState): void {
    const AIR = 16;
    const air = v.def.id === "V013" ? "attack" : v.def.id === "V011" || v.def.id === "V012" ? "drone" : "transport";
    const sq = v.squad >= 0 ? b.squads[v.squad] : null;
    const members = sq ? sq.members.map(i => b.soldiers[i]).filter(m => m.alive) : [];
    const pax = v.seats.slice(1).filter(id => id >= 0).length;
    const outside = members.filter(m => m.vehicle !== v.id);
    const base = b.world.bases[v.team];
    // Mission: attack (gunships, drones), transport (a squad aboard: to its LZ), extract (pick up / go home).
    let mission = air === "transport" ? (pax > 0 && (!outside.length || b.time > v.waitUntil + 25) ? 1 : 2) : 0;
    let goal: [number, number];
    const t = sq ? b.territories.find(q => q.def.id === sq.objective) : null;
    if (mission === 1 && t) {
        if (!v.lz) { const dx = base.x - t.def.x, dz = base.z - t.def.z, l = Math.hypot(dx, dz) || 1; const [lx, lz] = b.world.openNear(t.def.x + (dx / l) * 90 + b.rng.range(-30, 30), t.def.z + (dz / l) * 90 + b.rng.range(-30, 30)); v.lz = [lx, lz]; }
        goal = v.lz;
    } else if (mission === 2) goal = sq && outside.length ? (() => { const c = centroid(outside); return [c[0], c[1]] as [number, number]; })() : v.lz ?? [base.x, base.z];
    else {
        const front = b.territories.filter(q => q.contested || q.owner !== v.team).sort((p, q) => Math.hypot(p.def.x - v.pos[0], p.def.z - v.pos[2]) - Math.hypot(q.def.x - v.pos[0], q.def.z - v.pos[2]))[0];
        goal = front ? [front.def.x, front.def.z] : [0, 0];
        if (v.temporary && v.owner >= 0) { const o = b.soldiers[v.owner]; goal = [o.pos[0], o.pos[2]]; mission = 0; }
    }
    v.goal = goal;
    const from: V3 = [v.pos[0], v.pos[1] - 1, v.pos[2]];
    const cs = contacts(b, v.team, from, 600, -1, 6);
    const vis = cs.filter(c => c.visible);
    const aa = b.vehicles.filter(o => o.alive && o.team !== v.team && (o.def.id === "V007") && Math.hypot(o.pos[0] - v.pos[0], o.pos[2] - v.pos[2]) < 1400).map(o => o.pos);
    for (const s of b.soldiers) if (s.alive && s.team !== v.team && s.loadout.launcher === "W015" && Math.hypot(s.pos[0] - v.pos[0], s.pos[2] - v.pos[2]) < 900) aa.push(s.pos);
    const lockOn = b.projectiles.some(p => p.guided && p.targetKind === "vehicle" && p.target === v.id);
    const unit = (m: number) => m / (AIR / 2);
    const nearestAA = (x: number, z: number) => aa.reduce((m, p) => Math.min(m, Math.hypot(p[0] - x, p[2] - z)), 2000);
    const cx = Math.floor((v.pos[0] + HALF) / AIR) * AIR - HALF + AIR / 2, cz = Math.floor((v.pos[2] + HALF) / AIR) * AIR - HALF + AIR / 2;
    const { s: senses } = sense(b, cx, cz, AIR, {
        obj: (x, z) => unit(Math.hypot(x - goal[0], z - goal[1])),
        thr: vis[0] ? (x, z) => unit(Math.hypot(x - vis[0].pos[0], z - vis[0].pos[2])) : () => 100,
        lead: () => 0,
        cover: (x, z) => nearestAA(x, z) > 900,
        exp: (x, z) => (nearestAA(x, z) < 800 ? 1 : 0),
        wall: (x, z) => !b.world.inBounds(x, z, 20),
        ally: (x, z) => b.vehicles.some(o => o.alive && o.id !== v.id && o.def.domain === "Air" && Math.abs(o.pos[0] - x) < AIR / 2 && Math.abs(o.pos[2] - z) < AIR / 2),
    });
    const dgoal = Math.hypot(goal[0] - v.pos[0], goal[1] - v.pos[2]);
    const tg = vis[0];
    const x: Vals = {
        ...senses, hp: clamp(Math.ceil((v.hp / v.def.hp) * 10), 1, 10), pax: clamp(pax, 0, 8), aa: clamp(aa.filter(p => Math.hypot(p[0] - v.pos[0], p[2] - v.pos[2]) < 900).length, 0, 3),
        lock: lockOn ? 1 : 0, flares: v.countermeasures > 0 ? 1 : 0, dobj: clamp(Math.round(dgoal / 40), 0, 20),
        lz: b.world.slope(v.pos[0], v.pos[2]) < 0.25 && !b.world.infBlocked(v.pos[0], v.pos[2]) ? 1 : 0,
        tg: clamp(vis.length, 0, 8), tdist: tg ? clamp(Math.round(tg.d / 25), 0, 40) : 40, vis: tg ? 1 : 0,
    };
    for (let k = 0; k < 8; k++) x[`r${k}`] = b.rng.next() < 0.25 ? 1 : 0;
    oneHotIn(x, "o", 9, v.option);
    oneHotIn(x, "a", 3, v.band);
    oneHotIn(x, "q", 3, mission);
    const out = runBrain(b, `ar_heli_${air}`, x);
    b.wirStats.vehicle++;
    const o = hot(out, "o2_", 9);
    v.option = o >= 0 ? o : HOLD;
    const band = hot(out, "alt", 3);
    if (band >= 0) v.band = band;
    if (v.option !== HOLD) { const [dy, dx] = DIRS[v.option]; v.goal = [v.pos[0] + dx * AIR * 3, v.pos[2] + dy * AIR * 3]; }
    else v.goal = null;
    if (out.flare > 0.5) { v.countermeasures--; v.smokeAt = b.time; }
    if (out.fire > 0.5 && tg) { const gi = v.def.guns.findIndex(g => (tg.armor ? g.vsVehicle > 200 : g.vsVehicle < 400)); b.vehicleFire(v, gi >= 0 ? gi : 0, [tg.pos[0], tg.pos[1] + 1, tg.pos[2]], b.driverOf(v)?.id ?? -1, tg.id, tg.kind); }
    if (air === "drone") for (const c of cs) if (c.kind === "soldier" && c.d < 70) b.spotted[v.team].set(c.id, b.time + 2);
    // Landing and loading.
    const ground = b.world.height(v.pos[0], v.pos[2]);
    // A transport with no squad and nobody aboard waits on the ground at its base, not hovering over it.
    const idle = air === "transport" && !sq && pax === 0 && !v.temporary && Math.hypot(base.x - v.pos[0], base.z - v.pos[2]) < 90;
    v.landing = (out.land > 0.5 || idle) && air === "transport";
    if (v.landing) {
        v.speed = 0;
        if (v.pos[1] < ground + 1.5) {
            v.landed = true;
            if (mission === 1) { for (const id of v.seats.slice(1)) if (id >= 0) b.exitVehicle(b.soldiers[id]); if (sq) { sq.mode = "advance"; sq.vehicle = -1; } v.squad = -1; v.lz = null; v.waitUntil = b.time + 4; }
        }
    } else if (v.landed && !idle && b.time > v.waitUntil && (mission !== 2 || !outside.length || dgoal > 60)) { v.landed = false; }
}

function jetThink(b: Battle, v: VehicleState): void {
    const kind = v.def.id === "V016" ? "fighter" : v.def.id === "V017" ? "attack" : "transport";
    const enemyAir = b.vehicles.filter(o => o.alive && o.team !== v.team && o.def.domain === "Air" && Math.hypot(o.pos[0] - v.pos[0], o.pos[2] - v.pos[2]) < 1500);
    const aa = b.vehicles.filter(o => o.alive && o.team !== v.team && o.def.id === "V007" && Math.hypot(o.pos[0] - v.pos[0], o.pos[2] - v.pos[2]) < 1600).length;
    // Ground target: the enemy vehicle nearest the most contested territory; for transports, the drop zone.
    let target: [number, number, number] | null = null;
    if (kind === "attack") {
        const front = b.territories.filter(q => q.contested || q.owner === 1 - v.team)[0];
        const cand = b.vehicles.filter(o => o.alive && o.team !== v.team && o.def.domain === "Ground").sort((p, q) => (front ? Math.hypot(p.pos[0] - front.def.x, p.pos[2] - front.def.z) - Math.hypot(q.pos[0] - front.def.x, q.pos[2] - front.def.z) : 0))[0];
        if (cand) target = cand.pos;
        else if (front) target = [front.def.x, b.world.height(front.def.x, front.def.z), front.def.z];
    } else if (kind === "fighter" && enemyAir[0]) target = enemyAir[0].pos;
    else if (kind === "transport" && v.payload && v.goal) target = [v.goal[0], 0, v.goal[1]];
    const ground = b.world.height(v.pos[0], v.pos[2]);
    const tdist = target ? Math.hypot(target[0] - v.pos[0], target[2] - v.pos[2]) : 2000;
    const ammo = v.def.guns.length ? clamp(Math.ceil((v.ammo.reduce((s, a) => s + a, 0) / v.def.guns.reduce((s, g) => s + g.ammo, 0)) * 6), 0, 6) : 0;
    const x: Vals = {
        hp: clamp(Math.ceil((v.hp / v.def.hp) * 10), 1, 10), ammo, tg: target && kind !== "fighter" ? 1 : 0, air: clamp(enemyAir.length, 0, 3), aa: clamp(aa, 0, 3),
        lock: b.projectiles.some(p => p.guided && p.target === v.id && p.targetKind === "vehicle") ? 1 : 0, tdist: clamp(Math.round(tdist / 100), 0, 20),
        alt: clamp(Math.round((v.pos[1] - ground) / 50), 0, 6), flares: v.countermeasures > 0 ? 1 : 0, payload: v.payload ? 1 : 0, dz: v.payload && tdist < 80 ? 1 : 0,
    };
    oneHotIn(x, "p", 5, v.phase);
    const out = runBrain(b, `ar_jet_${kind}`, x);
    b.wirStats.vehicle++;
    const ph = hot(out, "phase", 5);
    if (ph >= 0) v.phase = ph;
    const base = b.world.bases[v.team];
    if (v.phase === 1 && target) { v.goal = [target[0], target[2]]; v.altitude = ground + (kind === "transport" ? 160 : 90); }
    else if (v.phase === 2) { v.altitude = ground + 260; }
    else if (v.phase === 3) { v.yaw += 0.5; v.altitude = ground + 140; }
    else if (v.phase === 4) { v.goal = [base.x, base.z]; v.altitude = ground + 220; if (Math.hypot(base.x - v.pos[0], base.z - v.pos[2]) < 200) { v.ammo = v.def.guns.map(g => g.ammo); v.countermeasures = v.def.countermeasures; v.phase = 0; } }
    else { const r = 280, a = b.time * 0.08 + v.id; v.goal = [base.x * 0.4 + Math.cos(a) * r, base.z * 0.4 + Math.sin(a) * r]; v.altitude = ground + 240; }
    if (out.flare > 0.5) { v.countermeasures--; v.smokeAt = b.time; }
    if (out.fire > 0.5 && target) {
        const tgv = kind === "fighter" ? enemyAir[0] : null;
        b.vehicleFire(v, kind === "fighter" && tgv && tdist > 600 ? 1 : kind === "attack" && tdist > 500 ? 2 : 0, [target[0], target[1] + 1, target[2]], b.driverOf(v)?.id ?? -1, tgv ? tgv.id : -1, tgv ? "vehicle" : "");
    }
    if (out.drop > 0.5) { if (v.payload) b.airdrop(v); else if (kind === "attack") b.vehicleFire(v, 1, [v.pos[0], 0, v.pos[2]], b.driverOf(v)?.id ?? -1); }
}

/** Every step: steer toward the vehicle's goal. */
function vehicleAct(b: Battle, v: VehicleState, driver: Soldier, dt: number): void {
    if (v.def.domain === "Air") {
        const fast = v.def.topSpeed > 500;
        if (!fast && v.landed) { v.speed = 0; return; }
        const ground = b.world.height(v.pos[0], v.pos[2]);
        if (!fast) v.altitude = v.landing ? ground : ground + [22, 60, 140][v.band];
        if (!v.goal) {
            // Holding: transports hover in place; gunships and drones circle slowly (a ~30 m orbit) so
            // they stay hard to hit and never sit frozen in the sky.
            if (fast || v.landing || v.def.wir !== "heli" || v.seats.length > 2) { v.speed *= 0.95; return; }
            v.speed += clamp(9 - v.speed, -v.def.accel * dt, v.def.accel * dt);
            v.yaw += (v.id % 2 ? 0.3 : -0.3) * dt;
            return;
        }
        const want = Math.atan2(v.goal[0] - v.pos[0], v.goal[1] - v.pos[2]);
        const d = angleDiff(v.yaw, want);
        driveVehicle(b, v, 1, clamp(d * 2, -1, 1), 0, dt);
        if (fast) v.speed = Math.max(v.speed, (v.def.topSpeed / 3.6) * 0.12);
        return;
    }
    if (!v.goal) { driveVehicle(b, v, 0, 0, 0, dt); v.speed *= 0.9; return; }
    const want = Math.atan2(v.goal[0] - v.pos[0], v.goal[1] - v.pos[2]);
    const d = angleDiff(v.yaw, want);
    const back = Math.abs(d) > 2.4 && b.vehicles[v.id].target >= 0;
    driveVehicle(b, v, back ? -0.6 : Math.abs(d) > 1.2 ? 0.25 : 0.85, clamp((back ? -angleDiff(v.yaw + Math.PI, want) : d) * 1.5, -1, 1), 0, dt);
    void driver;
}

// --- rewards ----------------------------------------------------------------------------------------

function botReward(b: Battle, s: Soldier): void {
    const id = s.rewards[0];
    const r = REWARD.get(id)!;
    const tgt = s.target >= 0 ? (s.targetKind === "vehicle" ? b.vehicles[s.target] : b.soldiers[s.target]) : null;
    const strike = ["R004", "R006", "R007", "R108"].includes(id);
    if (strike && !tgt) return;
    const sq = b.squads[s.squad];
    const t = b.territories.find(q => q.def.id === sq.objective);
    const point: V3 = strike && tgt ? [...tgt.pos] : id === "R101" && t ? [t.def.x, 0, t.def.z] : [s.pos[0] + Math.sin(s.yaw) * 8, 0, s.pos[2] + Math.cos(s.yaw) * 8];
    if (strike && Math.hypot(point[0] - s.pos[0], point[2] - s.pos[2]) < (r.radius ?? 20) * 0.8) return; // never on itself
    if (b.useReward(s, 0, point)) s.rewards.push(s.rewards.shift()!);
}

// --- helpers ----------------------------------------------------------------------------------------

export function angleDiff(a: number, b: number): number { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }
function turnToward(a: number, b: number, step: number): number { const d = angleDiff(a, b); return a + clamp(d, -step, step); }
export type { Slot, Mode };
void dirOf;
