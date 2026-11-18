// Armageddon 2070's battle: Conquer on one map, 128 vs 128 (bots, and one player for now).
//
// The rules (docs/ARMAGEDDON_2070.md): kill enemies and take territories. Each team has tickets; a
// death costs one, and every 10 s the team holding fewer territories loses one per territory it is
// behind. Everyone respawns within 5 s, at headquarters, an owned territory or a squad mate. Kills
// without dying earn killstreak rewards; a long time at the bottom of the team leaderboard earns
// underdog rewards. One mecha per side may be on the field at a time.
//
// The simulation is deterministic (seeded) and runs headless: the addon steps it and draws it,
// tests step it to the end of whole battles. Bots think in ar_bots.ts with the WIR networks.

import { BALANCE, WEAPON, ATTACHMENT, AMMO_BY_ID, ARMOR_BY_ID, EQUIP, VEHICLES, VEHICLE, MECHA, MECHA_BY_ID, REWARD, SQUADS, ROLE_LOADOUTS, MECHA_RULE, KILLSTREAKS, UNDERDOG, loadoutStats, falloff, afterArmor, type Loadout, type LoadoutStats, type Role, type Vehicle, type Gun, type RewardId, type Mecha as MechaDef, type Weapon, UGL } from "./ar_data";
import { World, worldFor, HALF, NAV_INF, NI, type Territory } from "./ar_map";
import { Rng, clamp, type V3 } from "../nebula/nk_math";
import { Wir, type Mode } from "./ar_wir";
import { AR_WIR } from "./ar_wir_data";

export type Team = 0 | 1;
export const TEAM_NAMES = ["Meridian Directorate", "Ember Ascendancy"] as const;
export const TEAM_SHORT = ["MERIDIAN", "EMBER"] as const;
export const STEP = 1 / 30;

export type Stance = "stand" | "crouch" | "prone";
export type Slot = "primary" | "sidearm" | "launcher";

export interface Soldier {
    id: number; team: Team; squad: number; role: Role; bot: boolean; name: string;
    pos: V3; vel: V3; yaw: number; pitch: number; stance: Stance;
    hp: number; alive: boolean; respawnAt: number; spawnedAt: number;
    loadout: Loadout; stats: LoadoutStats;
    slot: Slot; mag: Record<Slot, number>; reserve: Record<Slot, number>;
    reloadUntil: number; nextShot: number; bloom: number; aimedSince: number; lastShot: number;
    /** The player's trigger on the previous step (semi-auto weapons fire once per pull), and the guided
     * launcher's lock: the vehicle under the crosshair and since when (-1: none). */
    trigger: boolean; lock: { target: number; since: number };
    grenades: number; equipment: { id: string; left: number }[];
    vehicle: number; seat: number;
    suppression: number; lastHitBy: number; lastHitAt: number; healUntil: number;
    // AI
    option: number; thinkAt: number; goal: [number, number] | null; target: number; targetKind: "soldier" | "vehicle" | ""; aimTime: number; react: number; burst: number;
    fireWanted: boolean; crouchWanted: boolean; seenBy: number;
    // score
    kills: number; deaths: number; score: number; streak: number; best: number; captures: number; vehicleKills: number;
    underdogTime: number; rewards: RewardId[]; earned: Set<RewardId>;
    /** Temporary soldiers (reinforcements, AI pilots) leave at this time; 0 for the roster. */
    expires: number;
}

export interface Squad {
    id: number; team: Team; members: number[]; kind: string;
    mode: Mode; objective: string; thinkAt: number; planAt: number;
    call: { x: number; z: number; until: number } | null;
    vehicle: number;
    /** Flank point for fireteam B while flanking. */
    flank: [number, number] | null;
    contact: number; armorSeen: number;
}

export interface VehicleState {
    id: number; team: Team; def: Vehicle; mecha: MechaDef | null;
    pos: V3; vel: V3; yaw: number; pitch: number; roll: number; speed: number;
    hp: number; alive: boolean; respawnAt: number; deadAt: number;
    seats: number[];
    turretYaw: number; turretPitch: number;
    ammo: number[]; nextShot: number[]; reloadUntil: number[];
    countermeasures: number; empUntil: number; smokeAt: number;
    /** Mecha components (legs, left, right, torso). */
    parts: { legs: number; left: number; right: number; torso: number } | null;
    // AI and flight
    option: number; thinkAt: number; phase: number; band: number; altitude: number;
    goal: [number, number] | null; target: number; targetKind: "soldier" | "vehicle" | "";
    squad: number; lz: [number, number] | null; landed: boolean; waitUntil: number;
    payload: string | null; temporary: number; owner: number; spawn: [number, number, number];
    lockOn: number; lockTime: number; braced: boolean; landing: boolean;
}

export interface Projectile {
    kind: "rocket" | "shell" | "missile" | "grenade" | "bomb" | "bolt" | "mortar";
    pos: V3; vel: V3; owner: number; ownerVehicle: number; team: Team;
    damage: number; vsVehicle: number; splash: number; life: number;
    target: number; targetKind: "soldier" | "vehicle" | ""; guided: boolean; fuse: number; weapon: string; chance: number;
}
export interface Mine { id: number; x: number; z: number; y: number; team: Team; owner: number; av: boolean; until: number }
/** `born`: when it was placed (a supply drop falls for SUPPLY_FALL s and cannot be used until it lands). */
export interface Deployable { id: number; kind: "turret" | "cover" | "crate" | "beacon" | "supply"; team: Team; owner: number; x: number; z: number; y: number; yaw: number; hp: number; until: number; uses: number; nextShot: number; box: number; born: number }
export const SUPPLY_FALL = 3;
export interface Cloud { x: number; z: number; y: number; r: number; until: number; kind: "smoke" | "emp" }
export interface Strike { kind: RewardId; team: Team; owner: number; x: number; z: number; at: number; shots: number; yaw: number; done: boolean }
export interface TerritoryState { def: Territory; owner: Team | -1; progress: number; contested: boolean; counts: [number, number] }

export type BattleEvent =
    | { kind: "shot"; from: V3; to: V3; team: Team; heavy: boolean; shooter: number; weapon?: string; impact?: boolean }
    | { kind: "resupply"; soldier: number }
    | { kind: "hit"; at: V3; vehicle: boolean; target: number }
    /** Damage that landed on an enemy soldier (`by`: who dealt it): the shooter's hit marker. */
    | { kind: "dealt"; by: number; target: number; amount: number }
    | { kind: "explode"; at: V3; radius: number }
    | { kind: "kill"; killer: number; victim: number; weapon: string; head: boolean }
    | { kind: "vehicleKill"; killer: number; vehicle: number }
    | { kind: "capture"; territory: string; team: Team }
    | { kind: "reward"; soldier: number; reward: RewardId; underdog: boolean }
    | { kind: "rewardUsed"; soldier: number; reward: RewardId; x: number; z: number }
    | { kind: "spawn"; soldier: number }
    | { kind: "mecha"; team: Team; vehicle: number }
    | { kind: "airdrop"; team: Team; vehicle: number }
    | { kind: "end"; winner: Team };

export interface PlayerInput {
    /** Movement in the view's frame: x right, z forward (-1..1). */
    move: [number, number];
    yaw: number; pitch: number;
    fire: boolean; aim: boolean; reload: boolean; jump: boolean; sprint: boolean;
    crouch: boolean; prone: boolean;
    use: boolean; slot: Slot | null; grenade: boolean; equipment: boolean;
    /** Squad call to the ground point under the crosshair. */
    call: boolean;
    /** Use the reward at this index of the soldier's rewards (at `point`). */
    reward: number;
    point: V3 | null;
    /** Vehicle controls: throttle and steer (-1..1), lift for aircraft, mouse aim is yaw/pitch. */
    throttle: number; steer: number; lift: number;
}
export const NO_INPUT: PlayerInput = { move: [0, 0], yaw: 0, pitch: 0, fire: false, aim: false, reload: false, jump: false, sprint: false, crouch: false, prone: false, use: false, slot: null, grenade: false, equipment: false, call: false, reward: -1, point: null, throttle: 0, steer: 0, lift: 0 };

export interface BattleOptions {
    map: string; seed?: number; perTeam?: number; player?: boolean; playerTeam?: Team;
    playerLoadout?: Loadout; tickets?: number; vehicles?: boolean; check?: boolean;
}

const FIRST = ["Arun", "Mira", "Kael", "Sora", "Tavi", "Ilya", "Noor", "Dax", "Rhea", "Juno", "Oren", "Lise", "Vik", "Asha", "Bram", "Cyra", "Dima", "Esk", "Fen", "Gale", "Hal", "Isa", "Jett", "Kiri", "Lux", "Maro", "Nix", "Oda", "Pax", "Quill", "Ren", "Sage", "Tamsin", "Ula", "Vale", "Wren", "Xan", "Yara", "Zev", "Ivo"];
const LAST = ["Vance", "Okoro", "Hale", "Ruiz", "Stark", "Moreau", "Kato", "Volkov", "Reyes", "Byrne", "Sato", "Ngata", "Lind", "Varga", "Duarte", "Kaur", "Ahn", "Bakr", "Cole", "Drago"];
const EYE: Record<Stance, number> = { stand: 1.62, crouch: 1.1, prone: 0.38 };
const HEIGHT: Record<Stance, number> = { stand: 1.8, crouch: 1.25, prone: 0.5 };

export function eyeOf(s: Soldier): V3 { return [s.pos[0], s.pos[1] + EYE[s.stance], s.pos[2]]; }
export function chestOf(s: Soldier): V3 { return [s.pos[0], s.pos[1] + HEIGHT[s.stance] * 0.7, s.pos[2]]; }

/** The vehicle roster each team fields on a map. */
export function roster(map: string): string[] {
    const ground = ["V001", "V002", "V002", "V003", "V003", "V004", "V004", "V005", "V005", "V006", "V007", "V008", "V009", "V010"];
    const air = ["V013", "V014", "V014", "V015", "V016", "V017", "V018", "V011", "V012"];
    if (map === "lhasa-arcology") return [...ground.filter(v => v !== "V008"), ...air];
    if (map === "kush-corridor") return [...ground, ...air.filter(v => v !== "V016")];
    return [...ground, ...air];
}

export class Battle {
    readonly world: World;
    readonly rng: Rng;
    readonly wir = new Wir(AR_WIR);
    time = 0;
    soldiers: Soldier[] = [];
    squads: Squad[] = [];
    vehicles: VehicleState[] = [];
    projectiles: Projectile[] = [];
    mines: Mine[] = [];
    deployables: Deployable[] = [];
    clouds: Cloud[] = [];
    strikes: Strike[] = [];
    territories: TerritoryState[] = [];
    tickets: [number, number];
    events: BattleEvent[] = [];
    killfeed: { killer: number; victim: number; weapon: string; head: boolean; at: number }[] = [];
    winner: Team | -1 = -1;
    player = -1;
    perTeam: number;
    mecha: [number, number] = [-1, -1];
    mechaAt: [number, number] = [0, 0];
    airdropAt: [number, number] = [90, 90];
    /** Check every WIR decision against its rule (tests and the live check). */
    check = false;
    wirStats = { decisions: 0, mismatches: 0, senses: 0, infantry: 0, squad: 0, strategic: 0, vehicle: 0, ms: 0 };
    private drainAt = 10;
    private nextId = 1;
    /** Soldiers per 32 m bucket, rebuilt every step. */
    buckets: number[][] = [];
    /** Infantry nav-cell occupancy (soldier count) for the "ally" sense channel. */
    occupancy: Uint8Array;
    /** Spotted enemies per team (ids -> time spotted until), from drones, beacons, recon rewards. */
    spotted: [Map<number, number>, Map<number, number>] = [new Map(), new Map()];
    stats = { shots: 0, hits: 0, kills: 0, vehicleKills: 0, captures: 0, rewardsUsed: 0, underdog: 0, killstreaks: 0, explosions: 0, mines: 0, airdrops: 0, dismounts: 0, mounts: 0 };

    constructor(readonly opts: BattleOptions) {
        this.world = worldFor(opts.map);
        this.rng = new Rng(opts.seed ?? 7);
        this.perTeam = opts.perTeam ?? BALANCE.teamSize;
        this.tickets = [opts.tickets ?? BALANCE.tickets, opts.tickets ?? BALANCE.tickets];
        this.check = !!opts.check;
        this.occupancy = new Uint8Array(NI * NI);
        this.territories = this.world.territories.map(def => ({ def, owner: -1, progress: 0, contested: false, counts: [0, 0] }));
        // Each team starts holding the territory nearest its base.
        for (const t of [0, 1] as Team[]) {
            const b = this.world.bases[t];
            const near = [...this.territories].sort((p, q) => Math.hypot(p.def.x - b.x, p.def.z - b.z) - Math.hypot(q.def.x - b.x, q.def.z - b.z))[0];
            if (near.owner === -1) { near.owner = t; near.progress = t === 0 ? 1 : -1; }
        }
        this.buildTeams();
        if (opts.vehicles !== false) for (const t of [0, 1] as Team[]) roster(opts.map).forEach((id, i) => this.spawnVehicle(t, id, i));
        for (const s of this.soldiers) this.respawn(s, true);
    }

    // --- setup ------------------------------------------------------------------------------

    private buildTeams(): void {
        const squadsPer = Math.ceil(this.perTeam / BALANCE.squadSize);
        let n = 0;
        for (const team of [0, 1] as Team[]) {
            for (let q = 0; q < squadsPer; q++) {
                // Mostly standard squads, with recon, support and anti-armor squads mixed in.
                const kind = SQUADS[q % 8 === 3 ? 1 : q % 8 === 5 ? 2 : q % 8 === 6 ? 3 : 0];
                const sq: Squad = { id: this.squads.length, team, members: [], kind: kind.id, mode: "advance", objective: "", thinkAt: this.rng.range(0, 1), planAt: this.rng.range(0, 3), call: null, vehicle: -1, flank: null, contact: 0, armorSeen: 0 };
                this.squads.push(sq);
                for (let m = 0; m < BALANCE.squadSize && sq.members.length < BALANCE.squadSize; m++) {
                    if (this.soldiers.filter(s => s.team === team).length >= this.perTeam) break;
                    const role = kind.roles[m];
                    const s = this.makeSoldier(team, sq.id, role, true, `${this.rng.pick(FIRST)} ${this.rng.pick(LAST)}`);
                    sq.members.push(s.id);
                    n++;
                }
            }
        }
        if (this.opts.player !== false) {
            const team = this.opts.playerTeam ?? 0;
            const sq = this.squads.find(q => q.team === team)!;
            const s = this.soldiers[sq.members[0]];
            s.bot = false; s.name = "You"; this.player = s.id;
            if (this.opts.playerLoadout) this.setLoadout(s, this.opts.playerLoadout);
        }
        void n;
    }

    private makeSoldier(team: Team, squad: number, role: Role, bot: boolean, name: string): Soldier {
        const loadout = JSON.parse(JSON.stringify(ROLE_LOADOUTS[role])) as Loadout;
        const s: Soldier = {
            id: this.soldiers.length, team, squad, role, bot, name,
            pos: [0, 0, 0], vel: [0, 0, 0], yaw: team === 0 ? 0 : Math.PI, pitch: 0, stance: "stand",
            hp: BALANCE.soldierHp, alive: false, respawnAt: 0, spawnedAt: 0, loadout, stats: loadoutStats(loadout),
            slot: "primary", mag: { primary: 0, sidearm: 0, launcher: 0 }, reserve: { primary: 0, sidearm: 0, launcher: 0 },
            reloadUntil: 0, nextShot: 0, bloom: 0, aimedSince: 0, lastShot: -10, trigger: false, lock: { target: -1, since: 0 }, grenades: 0, equipment: [],
            vehicle: -1, seat: -1, suppression: 0, lastHitBy: -1, lastHitAt: -10, healUntil: 0,
            option: 8, thinkAt: this.rng.range(0, 0.4), goal: null, target: -1, targetKind: "", aimTime: 0, react: 0, burst: 0, fireWanted: false, crouchWanted: false, seenBy: 0,
            kills: 0, deaths: 0, score: 0, streak: 0, best: 0, captures: 0, vehicleKills: 0, underdogTime: 0, rewards: [], earned: new Set(), expires: 0,
        };
        this.soldiers.push(s);
        this.restock(s);
        return s;
    }

    setLoadout(s: Soldier, l: Loadout): void {
        s.loadout = JSON.parse(JSON.stringify(l)) as Loadout;
        s.stats = loadoutStats(s.loadout);
        this.restock(s);
    }

    /** Full ammunition, grenades and equipment. */
    restock(s: Soldier): void {
        const st = s.stats, p = WEAPON.get(s.loadout.primary)!, sa = WEAPON.get(s.loadout.sidearm)!, la = launcherOf(s);
        s.mag.primary = st.mag; s.reserve.primary = st.mag * p.spare;
        s.mag.sidearm = sa.mag; s.reserve.sidearm = sa.mag * sa.spare;
        s.mag.launcher = la ? la.mag : 0; s.reserve.launcher = la ? la.spare : 0;
        s.grenades = s.loadout.equipment.filter(e => e === "E003").length * (EQUIP.get("E003")!.uses);
        const eq = new Map<string, number>();
        for (const id of s.loadout.equipment) if (id !== "E003") eq.set(id, (eq.get(id) ?? 0) + EQUIP.get(id)!.uses);
        s.equipment = [...eq].map(([id, left]) => ({ id, left }));
    }

    spawnVehicle(team: Team, id: string, index: number, at?: [number, number], payloadDrop = false): VehicleState {
        const def = VEHICLE.get(id)!;
        const b = this.world.bases[team];
        const air = def.domain === "Air";
        const row = Math.floor(index / 5), col = (index % 5) - 2;
        const fwd = team === 0 ? 1 : -1;
        // Aircraft line up on one row behind the base, inside the map (bases sit ~60 m from the edge).
        let x = at ? at[0] : air ? b.x + ((index % 9) - 4) * 18 : b.x + col * 14, z = at ? at[1] : b.z + (air ? -fwd * b.radius * 0.5 : fwd * (b.radius * 0.1 + row * 14) - fwd * 10);
        if (!air) [x, z] = this.world.vehOpenNear(x, z);
        const v: VehicleState = {
            id: this.vehicles.length, team, def, mecha: null,
            pos: [x, this.world.height(x, z) + (payloadDrop ? 140 : 0), z], vel: [0, 0, 0], yaw: team === 0 ? 0 : Math.PI, pitch: 0, roll: 0, speed: 0,
            hp: def.hp, alive: true, respawnAt: 0, deadAt: 0,
            seats: new Array(Math.max(1, def.seats)).fill(-1),
            turretYaw: 0, turretPitch: 0,
            ammo: def.guns.map(g => g.ammo), nextShot: def.guns.map(() => 0), reloadUntil: def.guns.map(() => 0),
            countermeasures: def.countermeasures, empUntil: 0, smokeAt: -99, parts: null,
            option: 8, thinkAt: this.rng.range(0, 0.5), phase: 0, band: 1, altitude: 0,
            goal: null, target: -1, targetKind: "", squad: -1, lz: null, landed: !air || def.topSpeed < 500, waitUntil: 0, payload: null, temporary: 0, owner: -1,
            spawn: [x, 0, z], lockOn: -1, lockTime: 0, braced: false, landing: false,
        };
        if (def.id === "V016" || def.id === "V017" || def.id === "V018") { v.pos[1] = this.world.height(x, z) + 220; v.altitude = v.pos[1]; v.speed = 90; v.landed = false; }
        this.vehicles.push(v);
        return v;
    }

    spawnMecha(team: Team, id: string): VehicleState {
        const m = MECHA_BY_ID.get(id)!;
        const def: Vehicle = { ...VEHICLES[4], id: m.id, name: m.name, seats: 1, seatsLabel: "1", role: m.role, size: "Mecha", hp: m.parts.legs + m.parts.left + m.parts.right + m.parts.torso, armor: m.armor, explosiveArmor: 0.5, topSpeed: m.topSpeed, guns: [m.guns.left, m.guns.right, m.guns.shoulder], dims: [5, 4.5, 11], turn: 0.9, accel: 2.5, respawn: MECHA_RULE.respawn, perTeam: 1, countermeasures: 2, wir: "tank", description: m.description };
        const b = this.world.bases[team];
        const [x, z] = this.world.vehOpenNear(b.x, b.z + (team === 0 ? 1 : -1) * 20);
        const v = this.spawnVehicle(team, "V005", 0, [x, z]);
        v.def = def; v.mecha = m; v.hp = def.hp; v.parts = { ...m.parts }; v.ammo = def.guns.map(g => g.ammo); v.nextShot = [0, 0, 0]; v.reloadUntil = [0, 0, 0];
        this.mecha[team] = v.id;
        this.events.push({ kind: "mecha", team, vehicle: v.id });
        return v;
    }

    // --- queries ----------------------------------------------------------------------------

    get me(): Soldier | null { return this.player >= 0 ? this.soldiers[this.player] : null; }
    teamOf(t: Team): Soldier[] { return this.soldiers.filter(s => s.team === t); }
    holdings(t: Team): number { return this.territories.filter(x => x.owner === t).length; }

    /** Soldiers within r of (x, z) (from the 32 m buckets). */
    near(x: number, z: number, r: number, out: number[] = []): number[] {
        out.length = 0;
        const B = 32, n = 32;
        const i0 = Math.max(0, Math.floor((x - r + HALF) / B)), i1 = Math.min(n - 1, Math.floor((x + r + HALF) / B));
        const j0 = Math.max(0, Math.floor((z - r + HALF) / B)), j1 = Math.min(n - 1, Math.floor((z + r + HALF) / B));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
            const b = this.buckets[j * n + i];
            if (!b) continue;
            for (const id of b) { const s = this.soldiers[id]; if (Math.hypot(s.pos[0] - x, s.pos[2] - z) <= r) out.push(id); }
        }
        return out;
    }

    private rebuildBuckets(): void {
        const n = 32;
        if (this.buckets.length !== n * n) this.buckets = Array.from({ length: n * n }, () => []);
        for (const b of this.buckets) b.length = 0;
        this.occupancy.fill(0);
        for (const s of this.soldiers) {
            if (!s.alive || s.vehicle >= 0) continue;
            const i = clamp(Math.floor((s.pos[0] + HALF) / 32), 0, n - 1), j = clamp(Math.floor((s.pos[2] + HALF) / 32), 0, n - 1);
            this.buckets[j * n + i].push(s.id);
            const ci = Math.floor((s.pos[0] + HALF) / NAV_INF), cj = Math.floor((s.pos[2] + HALF) / NAV_INF);
            if (ci >= 0 && cj >= 0 && ci < NI && cj < NI && this.occupancy[cj * NI + ci] < 255) this.occupancy[cj * NI + ci]++;
        }
    }

    /** How far away an enemy can see this soldier now. */
    detectRange(s: Soldier, thermal = false): number {
        if (s.vehicle >= 0) { const v = this.vehicles[s.vehicle]; return v.def.domain === "Air" ? 1500 : 650; }
        const st = s.stats;
        const stance = s.stance === "stand" ? 1 : s.stance === "crouch" ? 0.72 : 0.42;
        const moving = Math.hypot(s.vel[0], s.vel[2]) > 0.6 ? 1.15 : 0.82;
        const conceal = 1 - 0.6 * this.world.concealAt(s.pos[0], s.pos[2]);
        let r = BALANCE.sightRange * (thermal ? st.thermal : st.visual) * stance * moving * conceal;
        if (this.time - s.lastShot < 1.5) r = Math.max(r, 320 * st.muzzle);
        return r;
    }

    /** Line of sight between two points (cover grid, then smoke unless thermal). */
    sight(a: V3, b: V3, thermal = false): boolean {
        if (this.world.trace(a[0], a[1], a[2], b[0], b[1], b[2]) < 0.999) return false;
        if (!thermal) for (const c of this.clouds) if (c.kind === "smoke" && segPointDist(a, b, [c.x, c.y, c.z]) < c.r) return false;
        return true;
    }

    /** Can `a` see `b` (range, signature, then line of sight)? */
    sees(a: Soldier, b: Soldier): boolean {
        if (!b.alive || !a.alive) return false;
        const d = Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]);
        if (d > this.detectRange(b)) return false;
        const target = b.vehicle >= 0 ? this.vehicles[b.vehicle].pos : chestOf(b);
        return this.sight(eyeOf(a), [target[0], target[1] + (b.vehicle >= 0 ? 1.5 : 0.2), target[2]]);
    }

    // --- the step ---------------------------------------------------------------------------

    step(dt: number, input: PlayerInput = NO_INPUT, think: (b: Battle, dt: number) => void = () => {}): void {
        if (this.winner !== -1) return;
        this.time += dt;
        this.rebuildBuckets();
        const me = this.me;
        if (me) this.playerStep(me, input, dt);
        think(this, dt);
        for (const s of this.soldiers) this.soldierStep(s, dt);
        for (const v of this.vehicles) this.vehicleStep(v, dt);
        this.projectileStep(dt);
        this.mineStep();
        this.deployableStep(dt);
        this.strikeStep();
        this.clouds = this.clouds.filter(c => c.until > this.time);
        for (const m of this.spotted) for (const [id, until] of m) if (until < this.time) m.delete(id);
        this.captureStep(dt);
        this.ticketStep();
        this.leaderboardStep(dt);
        this.mechaStep();
        this.airdropStep();
        if (this.killfeed.length > 8) this.killfeed.splice(0, this.killfeed.length - 8);
    }

    private soldierStep(s: Soldier, dt: number): void {
        if (!s.alive) {
            if (this.time >= s.respawnAt && s.bot && !s.expires) this.respawn(s);
            return;
        }
        if (s.expires && this.time > s.expires) { if (s.vehicle >= 0) this.exitVehicle(s); s.alive = false; s.respawnAt = Infinity; return; }
        s.suppression = Math.max(0, s.suppression - dt * 0.9);
        s.bloom = Math.max(0, s.bloom - dt * 3);
        if (s.healUntil > this.time) s.hp = Math.min(BALANCE.soldierHp, s.hp + dt * 20);
        else if (this.time - s.lastHitAt > 8 && s.hp < BALANCE.soldierHp) s.hp = Math.min(BALANCE.soldierHp, s.hp + dt * 4);
        if (s.vehicle >= 0) {
            const v = this.vehicles[s.vehicle];
            if (!v || !v.alive) { this.exitVehicle(s); return; }
            s.pos = [v.pos[0], v.pos[1] + 1, v.pos[2]];
            return;
        }
        if (s.reloadUntil > 0 && this.time >= s.reloadUntil) this.finishReload(s);
        // Movement (bots set vel in ar_bots; the player in playerStep): collide with the nav grid
        // and the cover grid, follow the ground.
        const nx = s.pos[0] + s.vel[0] * dt, nz = s.pos[2] + s.vel[2] * dt;
        // Bots plan on the 2 m nav grid and collide with it; the player collides with the 1 m cover grid.
        const ok = s.bot ? (x: number, z: number) => !this.world.infBlocked(x, z) : (x: number, z: number) => !this.world.infBlocked(x, z) && this.world.coverHeight(x, z) < 0.6;
        if (ok(nx, nz)) { s.pos[0] = nx; s.pos[2] = nz; }
        else if (ok(nx, s.pos[2])) s.pos[0] = nx;
        else if (ok(s.pos[0], nz)) s.pos[2] = nz;
        const g = this.world.height(s.pos[0], s.pos[2]);
        if (s.pos[1] > g + 0.05) { s.vel[1] -= 9.8 * dt; s.pos[1] = Math.max(g, s.pos[1] + s.vel[1] * dt); }
        else { s.pos[1] = g; s.vel[1] = 0; }
        if (this.world.wet(s.pos[0], s.pos[2])) this.damageSoldier(s, 30 * dt, "explosive", -1, "drowned", "torso");
    }

    respawn(s: Soldier, first = false, where?: string): void {
        if (!first && this.tickets[s.team] <= 0) return;
        s.alive = true; s.hp = BALANCE.soldierHp; s.vehicle = -1; s.seat = -1; s.stance = "stand"; s.suppression = 0;
        s.spawnedAt = this.time; s.reloadUntil = 0; s.option = 8; s.goal = null; s.target = -1; s.slot = "primary";
        this.restock(s);
        let x: number, z: number;
        const sq = this.squads[s.squad];
        const spot = where ?? this.spawnChoice(s);
        if (spot.startsWith("T")) { const t = this.territories.find(q => q.def.id === spot)!; [x, z] = this.world.openNear(t.def.x, t.def.z, t.def.radius * 0.6, this.rng); }
        else if (spot.startsWith("S")) { const mate = this.soldiers[Number(spot.slice(1))]; [x, z] = this.world.openNear(mate.pos[0], mate.pos[2], 4, this.rng); }
        else { const b = this.world.bases[s.team]; [x, z] = this.world.openNear(b.x, b.z, b.radius * 0.7, this.rng); }
        s.pos = [x, this.world.height(x, z), z];
        s.vel = [0, 0, 0];
        s.yaw = s.team === 0 ? 0 : Math.PI;
        void sq;
        this.events.push({ kind: "spawn", soldier: s.id });
    }

    /** Where a bot respawns: the owned territory nearest its squad's objective, else a squad mate out of contact, else HQ. */
    spawnChoice(s: Soldier): string {
        const sq = this.squads[s.squad];
        const obj = this.territories.find(t => t.def.id === sq.objective);
        const owned = this.territories.filter(t => t.owner === s.team && !t.contested);
        if (obj && owned.length) {
            const best = owned.sort((a, b) => Math.hypot(a.def.x - obj.def.x, a.def.z - obj.def.z) - Math.hypot(b.def.x - obj.def.x, b.def.z - obj.def.z))[0];
            if (this.rng.next() < 0.75) return best.def.id;
        }
        const mate = sq.members.map(i => this.soldiers[i]).find(m => m.alive && m.id !== s.id && m.vehicle < 0 && this.time - m.lastHitAt > 6 && m.suppression < 0.5);
        if (mate && this.rng.next() < 0.5) return `S${mate.id}`;
        return "HQ";
    }

    /** Spawn points the player may pick: HQ, owned territories, alive squad mates. */
    spawnOptions(s: Soldier): { id: string; label: string; x: number; z: number }[] {
        const out = [{ id: "HQ", label: "Headquarters", x: this.world.bases[s.team].x, z: this.world.bases[s.team].z }];
        for (const t of this.territories) if (t.owner === s.team) out.push({ id: t.def.id, label: t.def.name + (t.contested ? " (contested)" : ""), x: t.def.x, z: t.def.z });
        for (const i of this.squads[s.squad].members) { const m = this.soldiers[i]; if (m.id !== s.id && m.alive && m.vehicle < 0) out.push({ id: `S${m.id}`, label: `Squad: ${m.name}`, x: m.pos[0], z: m.pos[2] }); }
        return out;
    }

    // --- weapons ----------------------------------------------------------------------------

    weaponOf(s: Soldier): Weapon { return s.slot === "primary" ? WEAPON.get(s.loadout.primary)! : s.slot === "sidearm" ? WEAPON.get(s.loadout.sidearm)! : launcherOf(s) ?? WEAPON.get(s.loadout.primary)!; }

    startReload(s: Soldier): void {
        const w = this.weaponOf(s);
        if (s.reloadUntil > 0 || s.reserve[s.slot] <= 0 || s.mag[s.slot] >= this.magSize(s, s.slot)) return;
        s.reloadUntil = this.time + w.reload * (s.slot === "primary" ? Math.max(0.8, s.stats.aimTime / 0.3) * 0.5 + 0.5 : 1);
    }
    private finishReload(s: Soldier): void {
        const size = this.magSize(s, s.slot), need = size - s.mag[s.slot], got = Math.min(need, s.reserve[s.slot]);
        s.mag[s.slot] += got; s.reserve[s.slot] -= got; s.reloadUntil = 0;
    }
    magSize(s: Soldier, slot: Slot): number { return slot === "primary" ? s.stats.mag : slot === "sidearm" ? WEAPON.get(s.loadout.sidearm)!.mag : launcherOf(s)?.mag ?? 0; }

    /** Whether a soldier is short of anything a crate gives: ammunition, launcher rounds, grenades, health. */
    needsSupply(o: Soldier, health = false): boolean {
        const p = WEAPON.get(o.loadout.primary)!, sa = WEAPON.get(o.loadout.sidearm)!, la = launcherOf(o);
        const grenades = o.loadout.equipment.filter(e => e === "E003").length * EQUIP.get("E003")!.uses;
        return o.mag.primary + o.reserve.primary < o.stats.mag * (p.spare + 1) || o.mag.sidearm + o.reserve.sidearm < sa.mag * (sa.spare + 1)
            || (!!la && o.mag.launcher + o.reserve.launcher < la.mag * (la.spare + 1)) || o.grenades < grenades || (health && o.hp < BALANCE.soldierHp - 1);
    }

    /** A friendly supply drop or ammo crate within `r` m, landed and with uses left, or null. */
    supplyNear(o: Soldier, r: number): Deployable | null {
        return this.deployables.find(d => (d.kind === "crate" || d.kind === "supply") && d.team === o.team && d.uses > 0 && this.time - d.born >= (d.kind === "supply" ? SUPPLY_FALL : 0) && Math.hypot(d.x - o.pos[0], d.z - o.pos[2]) < r) ?? null;
    }

    /** Takes from a crate: everything back to full (a supply drop also heals). */
    resupply(o: Soldier, d: Deployable): void {
        const slot = o.slot;
        this.restock(o);
        o.slot = slot; o.reloadUntil = 0;
        if (d.kind === "supply") o.hp = BALANCE.soldierHp;
        d.uses--;
        if (d.owner !== o.id) this.soldiers[d.owner].score += 10;
        if (!o.bot) this.events.push({ kind: "resupply", soldier: o.id });
    }

    /** The friendly vehicle whose hull is within 3 m of the soldier (nearest first). With `anyFull`, full
     * vehicles count too (the player takes a bot's seat). */
    vehicleNear(s: Soldier, anyFull = false): VehicleState | null {
        let best: VehicleState | null = null, bd = Infinity;
        for (const v of this.vehicles) {
            if (!v.alive || v.team !== s.team || v.seats.length === 0) continue;
            if (!anyFull && !v.seats.includes(-1)) continue;
            const [L, W] = v.def.dims;
            const dx = s.pos[0] - v.pos[0], dz = s.pos[2] - v.pos[2], c = Math.cos(v.yaw), sn = Math.sin(v.yaw);
            const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
            const out = Math.hypot(Math.max(0, Math.abs(lx) - W / 2), Math.max(0, Math.abs(lz) - L / 2));
            const d = out + (v.def.domain === "Air" ? Math.max(0, v.pos[1] - s.pos[1] - 4) : 0);
            if (d < 3 && d < bd) { bd = d; best = v; }
        }
        return best;
    }

    /** Fires the soldier's current weapon along (yaw, pitch); returns false when it could not. */
    fire(s: Soldier, yaw: number, pitch: number, aimed: boolean, target = -1, targetKind: "soldier" | "vehicle" | "" = ""): boolean {
        if (!s.alive || s.vehicle >= 0 || this.time < s.nextShot || s.reloadUntil > 0) return false;
        const w = this.weaponOf(s);
        if (s.mag[s.slot] <= 0) { this.startReload(s); return false; }
        // The HMG and AMR fire unbraced too, with three times the spread and twice the kick.
        const wild = w.heavy && !s.stats.heavyOk && s.stance === "stand";
        s.mag[s.slot]--;
        s.nextShot = this.time + 60 / w.rpm;
        s.lastShot = this.time;
        this.stats.shots++;
        const eye = eyeOf(s);
        if (w.speed > 0) {
            // Launchers: a projectile (guided ones home on a locked target).
            const d = dirOf(yaw, pitch);
            const muzzle: V3 = [eye[0] + d[0] * 0.8, eye[1] + d[1] * 0.8, eye[2] + d[2] * 0.8];
            this.projectiles.push({ kind: w.id === UGL.id ? "mortar" : w.locks === "air" ? "missile" : "rocket", pos: muzzle, vel: [d[0] * w.speed, d[1] * w.speed, d[2] * w.speed], owner: s.id, ownerVehicle: -1, team: s.team, damage: w.damage, vsVehicle: w.vsVehicle, splash: w.splash, life: w.range / w.speed + 1, target, targetKind, guided: w.lock > 0 && target >= 0, fuse: 0, weapon: w.name, chance: 1 });
            this.events.push({ kind: "shot", from: muzzle, to: [muzzle[0] + d[0] * 6, muzzle[1] + d[1] * 6, muzzle[2] + d[2] * 6], team: s.team, heavy: true, shooter: s.id, weapon: w.id });
            if (s.slot === "launcher" && w.id === "W013" && s.mag.launcher <= 0 && s.reserve.launcher <= 0) s.slot = "primary";
            else if (!s.bot && s.mag[s.slot] <= 0) this.startReload(s);
            return true;
        }
        const st = s.stats;
        const moving = Math.hypot(s.vel[0], s.vel[2]) > 0.8 ? 1.6 : 1;
        const base = s.slot === "primary" ? (aimed ? st.spread : w.hip) : aimed ? w.aim : w.hip;
        const stance = s.stance === "prone" ? 0.6 : s.stance === "crouch" ? 0.8 : 1;
        const spreadDeg = (base + s.bloom) * moving * stance * (1 + s.suppression * 0.25) * (wild ? 3 : 1);
        const recoil = (s.slot === "primary" ? st.recoil : w.recoil) * (s.stance !== "stand" && s.loadout.attachments.Underbarrel === "A014" ? 0.55 : 1) * (wild ? 2 : 1);
        s.bloom = Math.min(4, s.bloom + recoil * 0.35);
        const range = (s.slot === "primary" ? st.range : w.range);
        const ammo = AMMO_BY_ID.get(s.loadout.ammo)!;
        for (let p = 0; p < w.pellets; p++) {
            const r = (spreadDeg * Math.PI) / 180;
            const a = this.rng.range(0, Math.PI * 2), m = Math.sqrt(this.rng.next()) * r;
            const d = dirOf(yaw + Math.cos(a) * m, pitch + Math.sin(a) * m);
            this.bullet(s, eye, d, range, w, ammo.id);
        }
        // The player reloads on their own when the magazine runs dry.
        if (!s.bot && s.mag[s.slot] <= 0) this.startReload(s);
        return true;
    }

    /** One hitscan round: world, then soldiers and vehicles along the ray; suppresses near misses. */
    private bullet(s: Soldier, from: V3, d: V3, range: number, w: Weapon, ammoId: string): void {
        const L = Math.min(range * 2, 1600);
        const to: V3 = [from[0] + d[0] * L, from[1] + d[1] * L, from[2] + d[2] * L];
        let f = this.world.trace(from[0], from[1], from[2], to[0], to[1], to[2]);
        // EMR-70 slugs pierce thin cover once.
        if (w.id === "W016" && f < 1) { const f2 = this.world.trace(from[0] + d[0] * (f * L + 0.6), from[1] + d[1] * (f * L + 0.6), from[2] + d[2] * (f * L + 0.6), to[0], to[1], to[2]); f = f + (0.6 / L) + f2 * (1 - f - 0.6 / L); }
        let best = f * L, hit: { kind: "soldier" | "vehicle"; id: number; loc: "head" | "torso" | "arms" | "legs" } | null = null;
        const seg = best;
        // Soldiers: walk buckets along the ray.
        const cand: number[] = [];
        const steps = Math.ceil(seg / 24) + 1;
        const seen = new Set<number>();
        for (let k = 0; k <= steps; k++) {
            const t = Math.min(seg, k * 24);
            for (const id of this.near(from[0] + d[0] * t, from[2] + d[2] * t, 26, cand)) {
                if (seen.has(id)) continue;
                seen.add(id);
                const o = this.soldiers[id];
                if (o.id === s.id || !o.alive) continue;
                const h = HEIGHT[o.stance];
                const c: V3 = [o.pos[0], o.pos[1] + h / 2, o.pos[2]];
                const tc = (c[0] - from[0]) * d[0] + (c[1] - from[1]) * d[1] + (c[2] - from[2]) * d[2];
                if (tc < 0 || tc > best) continue;
                const px = from[0] + d[0] * tc, py = from[1] + d[1] * tc, pz = from[2] + d[2] * tc;
                const horiz = Math.hypot(px - o.pos[0], pz - o.pos[2]), rel = py - o.pos[1];
                if (o.team !== s.team && horiz < 2.5 && rel > -1 && rel < h + 1.5) o.suppression = Math.min(4, o.suppression + (w.id === "W006" || w.id === "W007" ? 0.35 : 0.22));
                const rad = o.stance === "prone" ? 0.55 : 0.33;
                if (horiz < rad && rel >= 0 && rel <= h) {
                    const loc = rel > h - 0.28 ? "head" : rel < h * 0.45 ? "legs" : horiz > rad * 0.6 ? "arms" : "torso";
                    best = tc; hit = { kind: "soldier", id: o.id, loc };
                }
            }
        }
        for (const v of this.vehicles) {
            if (!v.alive) continue;
            const t = rayVehicle(from, d, v);
            if (t > 0 && t < best && !(v.seats.includes(s.id))) { best = t; hit = { kind: "vehicle", id: v.id, loc: "torso" }; }
        }
        const end: V3 = [from[0] + d[0] * best, from[1] + d[1] * best, from[2] + d[2] * best];
        this.events.push({ kind: "shot", from, to: end, team: s.team, heavy: w.damage >= 45, shooter: s.id, weapon: w.id, impact: !hit && f < 1 });
        const ammo = AMMO_BY_ID.get(ammoId)!;
        if (hit?.kind === "soldier") {
            const o = this.soldiers[hit.id];
            const loc = hit.loc;
            const prot = loc === "head" ? o.stats.head : loc === "arms" ? o.stats.arms : loc === "legs" ? o.stats.legs : o.stats.torso;
            const mult = loc === "head" ? (w.id === "W008" || w.id === "W010" ? 2.5 : BALANCE.head.mult) : loc === "arms" ? BALANCE.arms.mult : loc === "legs" ? BALANCE.legs.mult : 1;
            const dmg = afterArmor(falloff(w, best), prot, ammo) * mult * (s.bot && !o.bot ? BALANCE.botVsPlayer : 1);
            if (o.team !== s.team) { this.stats.hits++; this.damageSoldier(o, dmg, "ballistic", s.id, w.name, loc); }
            this.events.push({ kind: "hit", at: end, vehicle: false, target: o.id });
        } else if (hit?.kind === "vehicle") {
            const v = this.vehicles[hit.id];
            const raw = w.vsVehicle || falloff(w, best);
            const dmg = w.vsVehicle ? w.vsVehicle * (1 - v.def.armor * 0.5) : raw * (1 - v.def.armor) * (ammo.penetration > 0.5 ? 1.6 : 1);
            if (v.team !== s.team) this.damageVehicle(v, dmg, s.id, w.name, end);
            if (w.id === "W016") v.empUntil = Math.max(v.empUntil, this.time + 1.5);
            this.events.push({ kind: "hit", at: end, vehicle: true, target: v.id });
        } else if (f < 1) {
            const bi = this.world.boxAt(from[0], from[2], to[0], to[2], f);
            if (bi >= 0) this.damageBox(bi, falloff(w, best) * (w.vsVehicle ? 3 : 0.25));
        }
    }

    damageBox(index: number, amount: number): void {
        const b = this.world.boxes[index];
        if (!b || b.hp === undefined || b.kind === "deco") return;
        b.hp -= amount;
        if (b.hp <= 0) { this.world.destroy(index); this.events.push({ kind: "explode", at: [b.x, b.y + 0.5, b.z], radius: 1.5 }); }
    }

    // --- damage -----------------------------------------------------------------------------

    damageSoldier(o: Soldier, amount: number, kind: "ballistic" | "explosive", by: number, weapon: string, loc: string): void {
        if (!o.alive || amount <= 0) return;
        if (kind === "explosive") amount *= 1 - o.stats.explosive;
        o.hp -= amount;
        if (by >= 0 && this.soldiers[by] && this.soldiers[by].team !== o.team) this.events.push({ kind: "dealt", by, target: o.id, amount });
        o.lastHitBy = by; o.lastHitAt = this.time;
        o.suppression = Math.min(4, o.suppression + 0.8);
        if (o.hp <= 0) this.kill(o, by, weapon, loc === "head");
    }

    kill(o: Soldier, by: number, weapon: string, head = false): void {
        if (!o.alive) return;
        o.alive = false; o.hp = 0; o.deaths++; o.streak = 0;
        o.respawnAt = this.time + BALANCE.respawn;
        if (o.vehicle >= 0) this.exitVehicle(o);
        if (!o.expires) this.tickets[o.team] = Math.max(0, this.tickets[o.team] - 1);
        this.stats.kills++;
        const k = by >= 0 ? this.soldiers[by] : null;
        if (k && k.team !== o.team) {
            k.kills++; k.score += head ? 130 : 100; k.streak++; k.best = Math.max(k.best, k.streak);
            this.streakRewards(k);
            // Assists: squad mates of the killer near the victim.
            for (const i of this.squads[k.squad].members) { const m = this.soldiers[i]; if (m.id !== k.id && m.alive && Math.hypot(m.pos[0] - o.pos[0], m.pos[2] - o.pos[2]) < 60) m.score += 20; }
        }
        this.killfeed.push({ killer: by, victim: o.id, weapon, head, at: this.time });
        this.events.push({ kind: "kill", killer: by, victim: o.id, weapon, head });
    }

    damageVehicle(v: VehicleState, amount: number, by: number, weapon: string, at: V3 | null = null): void {
        if (!v.alive || amount <= 0) return;
        if (v.parts && at) {
            // Mecha: damage lands on the component nearest the hit.
            const rel = at[1] - v.pos[1];
            const side = Math.sin(v.yaw) * (at[2] - v.pos[2]) - Math.cos(v.yaw) * (at[0] - v.pos[0]);
            const part = rel < 4.5 ? "legs" : Math.abs(side) > 1.6 && rel < 8.5 ? (side > 0 ? "left" : "right") : "torso";
            const braced = v.braced ? 0.5 : 1;
            v.parts[part] = Math.max(0, v.parts[part] - amount * braced);
            v.hp = v.parts.legs + v.parts.left + v.parts.right + v.parts.torso;
            if (v.parts.torso <= 0) v.hp = 0;
        } else v.hp -= amount;
        if (v.hp <= 0) {
            v.alive = false; v.hp = 0; v.deadAt = this.time;
            v.respawnAt = this.time + v.def.respawn;
            this.events.push({ kind: "explode", at: [...v.pos], radius: 6 });
            const k = by >= 0 ? this.soldiers[by] : null;
            if (k && k.team !== v.team) { k.score += 200 + Math.round(v.def.hp / 20); k.vehicleKills++; k.streak++; k.best = Math.max(k.best, k.streak); this.streakRewards(k); this.stats.vehicleKills++; }
            this.events.push({ kind: "vehicleKill", killer: by, vehicle: v.id });
            for (const id of v.seats) if (id >= 0) { const s = this.soldiers[id]; this.exitVehicle(s); this.kill(s, by, weapon); }
            if (v.mecha) this.mecha[v.team] = -1, (this.mechaAt[v.team] = this.time + MECHA_RULE.respawn);
        }
    }

    /** Splash damage: soldiers (unless a wall is between), vehicles, destructible cover. */
    explode(at: V3, radius: number, damage: number, vsVehicle: number, by: number, team: Team, weapon: string): void {
        this.stats.explosions++;
        this.events.push({ kind: "explode", at, radius });
        const ids: number[] = [];
        for (const id of this.near(at[0], at[2], radius, ids)) {
            const o = this.soldiers[id];
            if (o.team === team && o.id !== by) continue;
            const c = chestOf(o), d = Math.hypot(c[0] - at[0], c[1] - at[1], c[2] - at[2]);
            if (d > radius) continue;
            if (this.world.trace(at[0], at[1] + 0.3, at[2], c[0], c[1], c[2]) < 0.97) continue;
            this.damageSoldier(o, damage * (1 - d / radius) ** 0.7 * 1.2, "explosive", by, weapon, "torso");
            o.suppression = 4;
        }
        for (const v of this.vehicles) {
            if (!v.alive || v.team === team) continue;
            const d = Math.hypot(v.pos[0] - at[0], v.pos[1] + 1 - at[1], v.pos[2] - at[2]) - Math.max(v.def.dims[0], v.def.dims[1]) * 0.3;
            if (d > radius) continue;
            this.damageVehicle(v, vsVehicle * clamp(1 - d / radius, 0.2, 1) * (1 - v.def.explosiveArmor), by, weapon, at);
        }
        const i0 = Math.floor(at[0] - radius + HALF), i1 = Math.floor(at[0] + radius + HALF), j0 = Math.floor(at[2] - radius + HALF), j1 = Math.floor(at[2] + radius + HALF);
        const hitBoxes = new Set<number>();
        for (let j = j0; j <= j1; j += 1) for (let i = i0; i <= i1; i += 1) { const k = this.world.cellIndex(i - HALF, j - HALF); if (k >= 0 && this.world.owner[k]) hitBoxes.add(this.world.owner[k] - 1); }
        for (const b of hitBoxes) this.damageBox(b, vsVehicle * 0.5 + damage);
    }

    // --- vehicles ---------------------------------------------------------------------------

    enterVehicle(s: Soldier, v: VehicleState, seat = -1): boolean {
        if (!v.alive || v.team !== s.team || s.vehicle >= 0) return false;
        const free = seat >= 0 ? (v.seats[seat] === -1 ? seat : -1) : v.seats.indexOf(-1);
        if (free < 0) return false;
        v.seats[free] = s.id; s.vehicle = v.id; s.seat = free; s.vel = [0, 0, 0];
        this.stats.mounts++;
        return true;
    }

    exitVehicle(s: Soldier): void {
        if (s.vehicle < 0) return;
        const v = this.vehicles[s.vehicle];
        if (v) {
            const i = v.seats.indexOf(s.id);
            if (i >= 0) v.seats[i] = -1;
            const side = (s.seat % 2 ? 1 : -1) * (v.def.dims[1] / 2 + 1.2);
            let x = v.pos[0] + Math.cos(v.yaw) * side, z = v.pos[2] - Math.sin(v.yaw) * side;
            [x, z] = this.world.openNear(x, z);
            const g = this.world.height(x, z);
            s.pos = [x, Math.max(g, v.def.domain === "Air" && !v.landed ? v.pos[1] : g), z];
            this.stats.dismounts++;
        }
        s.vehicle = -1; s.seat = -1;
    }

    driverOf(v: VehicleState): Soldier | null { const id = v.seats[0]; return id >= 0 ? this.soldiers[id] : null; }
    passengers(v: VehicleState): number { return v.seats.filter(x => x >= 0).length; }

    /** Fires a vehicle gun at a world point (aim already chosen); guided munitions take the target. */
    vehicleFire(v: VehicleState, gi: number, aimAt: V3, by: number, target = -1, targetKind: "soldier" | "vehicle" | "" = ""): boolean {
        const g: Gun | undefined = v.def.guns[gi];
        if (!g || !v.alive || this.time < v.nextShot[gi] || this.time < v.reloadUntil[gi] || v.empUntil > this.time) return false;
        if (v.ammo[gi] <= 0) { if (g.reload > 0) { v.reloadUntil[gi] = this.time + g.reload; v.ammo[gi] = g.ammo; } return false; }
        if (v.parts && ((gi === 0 && v.parts.left <= 0) || (gi === 1 && v.parts.right <= 0) || (gi === 2 && v.parts.torso < v.mecha!.parts.torso * 0.25))) return false;
        v.ammo[gi]--;
        v.nextShot[gi] = this.time + 60 / g.rpm;
        const from: V3 = [v.pos[0], v.pos[1] + (v.def.domain === "Air" ? -0.5 : v.mecha ? 8 : v.def.dims[2] * 0.8), v.pos[2]];
        const dx = aimAt[0] - from[0], dy = aimAt[1] - from[1], dz = aimAt[2] - from[2], L = Math.hypot(dx, dy, dz) || 1;
        const shooter = by >= 0 ? this.soldiers[by] : null;
        if (g.indirect) {
            // Shells arc onto the point with some scatter.
            const sx = aimAt[0] + this.rng.range(-8, 8), sz = aimAt[2] + this.rng.range(-8, 8);
            const T = 2 + L / 300;
            this.projectiles.push({ kind: "mortar", pos: [...from], vel: [(sx - from[0]) / T, (this.world.height(sx, sz) - from[1]) / T + 4.9 * T, (sz - from[2]) / T], owner: by, ownerVehicle: v.id, team: v.team, damage: g.damage, vsVehicle: g.vsVehicle, splash: g.splash, life: T + 2, target: -1, targetKind: "", guided: false, fuse: 0, weapon: g.name, chance: 1 });
            return true;
        }
        if (g.dropped) {
            this.projectiles.push({ kind: "bomb", pos: [...from], vel: [Math.sin(v.yaw) * v.speed * 0.8, -5, Math.cos(v.yaw) * v.speed * 0.8], owner: by, ownerVehicle: v.id, team: v.team, damage: g.damage, vsVehicle: g.vsVehicle, splash: g.splash, life: 12, target: -1, targetKind: "", guided: false, fuse: 0, weapon: g.name, chance: 1 });
            return true;
        }
        const d: V3 = [dx / L, dy / L, dz / L];
        if (g.speed > 0) {
            this.projectiles.push({ kind: g.locks ? "missile" : g.splash > 4 ? "shell" : "rocket", pos: [from[0] + d[0] * 4, from[1] + d[1] * 4, from[2] + d[2] * 4], vel: [d[0] * g.speed, d[1] * g.speed, d[2] * g.speed], owner: by, ownerVehicle: v.id, team: v.team, damage: g.damage, vsVehicle: g.vsVehicle, splash: Math.max(1.5, g.splash), life: g.range / g.speed + 1, target, targetKind, guided: !!g.locks && target >= 0, fuse: 0, weapon: g.name, chance: 1 });
            this.events.push({ kind: "shot", from, to: [from[0] + d[0] * 12, from[1] + d[1] * 12, from[2] + d[2] * 12], team: v.team, heavy: true, shooter: by });
            return true;
        }
        // Guns: hitscan with a little spread, splash for cannons.
        const spread = 0.004 + (shooter && shooter.bot ? 0.01 : 0);
        const dd: V3 = [d[0] + this.rng.range(-spread, spread), d[1] + this.rng.range(-spread, spread), d[2] + this.rng.range(-spread, spread)];
        const R = g.range * 1.3;
        const to: V3 = [from[0] + dd[0] * R, from[1] + dd[1] * R, from[2] + dd[2] * R];
        const f = this.world.trace(from[0], from[1], from[2], to[0], to[1], to[2]);
        let best = f * R, hitS = -1, hitV = -1;
        const ids: number[] = [];
        for (let t = 0; t <= best; t += 20) for (const id of this.near(from[0] + dd[0] * t, from[2] + dd[2] * t, 22, ids)) {
            const o = this.soldiers[id];
            if (o.team === v.team || !o.alive) continue;
            const tc = (o.pos[0] - from[0]) * dd[0] + (o.pos[1] + 1 - from[1]) * dd[1] + (o.pos[2] - from[2]) * dd[2];
            if (tc < 0 || tc > best) continue;
            const px = from[0] + dd[0] * tc, py = from[1] + dd[1] * tc, pz = from[2] + dd[2] * tc;
            const hz = Math.hypot(px - o.pos[0], pz - o.pos[2]);
            if (hz < 2.5) o.suppression = Math.min(4, o.suppression + 0.4);
            if (hz < 0.45 + g.splash * 0.15 && py > o.pos[1] - 0.2 && py < o.pos[1] + HEIGHT[o.stance] + 0.2) { best = tc; hitS = id; hitV = -1; }
        }
        for (const o of this.vehicles) {
            if (!o.alive || o.id === v.id || o.team === v.team) continue;
            const t = rayVehicle(from, dd, o);
            if (t > 0 && t < best) { best = t; hitV = o.id; hitS = -1; }
        }
        const end: V3 = [from[0] + dd[0] * best, from[1] + dd[1] * best, from[2] + dd[2] * best];
        this.events.push({ kind: "shot", from, to: end, team: v.team, heavy: true, shooter: by });
        if (hitS >= 0) this.damageSoldier(this.soldiers[hitS], g.damage, "ballistic", by, g.name, "torso");
        if (hitV >= 0) { const o = this.vehicles[hitV]; this.damageVehicle(o, (g.vsVehicle || g.damage) * (1 - o.def.armor * (g.vsVehicle ? 0.4 : 1)), by, g.name, end); }
        if (g.splash > 0 && (hitS >= 0 || hitV >= 0 || f < 1)) this.explode(end, g.splash, g.damage * 0.6, 0, by, v.team, g.name);
        else if (f < 1) { const bi = this.world.boxAt(from[0], from[2], to[0], to[2], f); if (bi >= 0) this.damageBox(bi, g.damage); }
        return true;
    }

    private vehicleStep(v: VehicleState, dt: number): void {
        if (!v.alive) {
            if (v.temporary) return;
            if (this.time >= v.respawnAt && !v.mecha) {
                // Respawn at its base slot (aircraft too).
                const idx = this.vehicles.filter(o => o.team === v.team && !o.mecha && o.id < v.id).length;
                const fresh = this.spawnVehicle(v.team, v.def.id, idx);
                this.vehicles.pop();
                Object.assign(v, { ...fresh, id: v.id });
            }
            return;
        }
        if (v.temporary && this.time > v.temporary) { for (const id of v.seats) if (id >= 0) this.exitVehicle(this.soldiers[id]); v.alive = false; v.hp = 0; return; }
        const air = v.def.domain === "Air";
        const g = this.world.height(v.pos[0], v.pos[2]);
        if (v.empUntil > this.time) { v.speed *= 0.9; if (air && (v.def.id === "V011" || v.def.id === "V012")) v.pos[1] -= 8 * dt; }
        const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
        const nx = v.pos[0] + fx * v.speed * dt, nz = v.pos[2] + fz * v.speed * dt;
        if (air) {
            // At the edge, keep flying but turn back toward the middle of the map (never pin in place).
            if (this.world.inBounds(nx, nz, 10) || Math.hypot(nx, nz) < Math.hypot(v.pos[0], v.pos[2])) { v.pos[0] = nx; v.pos[2] = nz; }
            if (!v.landed && !this.world.inBounds(v.pos[0], v.pos[2], 30)) {
                let d = (Math.atan2(-v.pos[0], -v.pos[2]) - v.yaw) % (Math.PI * 2);
                if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2;
                v.yaw += clamp(d, -v.def.turn * dt, v.def.turn * dt);
                v.speed = Math.max(v.speed, 8);
            }
            const ground = this.world.height(v.pos[0], v.pos[2]);
            if (v.landed) v.pos[1] = ground + 0.1;
            else v.pos[1] = Math.max(ground + 2, v.pos[1] + (v.altitude - v.pos[1]) * Math.min(1, dt * 0.8));
            if (v.pos[1] <= ground + 2.5 && v.speed > 30 && !v.landed) this.damageVehicle(v, 9999, -1, "crash");
        } else {
            const blocked = this.world.vehBlocked(nx, nz) || this.vehicleAt(nx, nz, v) >= 0;
            if (!blocked) { v.pos[0] = nx; v.pos[2] = nz; }
            else v.speed *= -0.2;
            v.pos[1] = g;
            // Heavy vehicles crush light cover and run soldiers over.
            if (Math.abs(v.speed) > 3) {
                const k = this.world.cellIndex(v.pos[0] + fx * v.def.dims[0] * 0.5, v.pos[2] + fz * v.def.dims[0] * 0.5);
                if (k >= 0 && this.world.owner[k]) { const bi = this.world.owner[k] - 1, b = this.world.boxes[bi]; if (b.hp !== undefined && (v.def.size === "Heavy" || v.def.size === "Mecha" || b.mat !== "hesco")) this.damageBox(bi, 400 * dt * Math.abs(v.speed)); }
                const ids: number[] = [];
                for (const id of this.near(v.pos[0], v.pos[2], v.def.dims[0] * 0.5, ids)) { const o = this.soldiers[id]; if (o.team !== v.team && o.vehicle < 0) this.damageSoldier(o, 150, "explosive", this.driverOf(v)?.id ?? -1, "roadkill", "torso"); }
            }
            const n = this.world.normal(v.pos[0], v.pos[2]);
            v.pitch = Math.asin(clamp(n[0] * fx + n[2] * fz, -1, 1)) * -1;
            v.roll = Math.asin(clamp(n[0] * fz - n[2] * fx, -1, 1));
            // Field repair and resupply from support vehicles.
            if (v.def.id === "V010") for (const o of this.vehicles) if (o.alive && o.team === v.team && o.id !== v.id && Math.hypot(o.pos[0] - v.pos[0], o.pos[2] - v.pos[2]) < 12) o.hp = Math.min(o.def.hp, o.hp + 60 * dt);
            if (v.def.id === "V009" && Math.floor(this.time) !== Math.floor(this.time - dt)) { const ids: number[] = []; for (const id of this.near(v.pos[0], v.pos[2], 15, ids)) { const o = this.soldiers[id]; if (o.team === v.team) { o.reserve.primary = Math.max(o.reserve.primary, o.stats.mag * 3); o.grenades = Math.max(o.grenades, 1); } } }
        }
    }

    vehicleAt(x: number, z: number, self: VehicleState): number {
        for (const o of this.vehicles) {
            if (!o.alive || o.id === self.id || o.def.domain === "Air") continue;
            if (Math.hypot(o.pos[0] - x, o.pos[2] - z) < (o.def.dims[0] + self.def.dims[0]) * 0.35) return o.id;
        }
        return -1;
    }

    // --- projectiles, mines, deployables, strikes ------------------------------------------------

    private projectileStep(dt: number): void {
        const keep: Projectile[] = [];
        for (const p of this.projectiles) {
            p.life -= dt;
            if (p.guided && p.target >= 0) {
                const tgt = p.targetKind === "vehicle" ? this.vehicles[p.target] : this.soldiers[p.target];
                if (tgt && tgt.alive) {
                    // Flares spoil air locks once in a while.
                    const tv = p.targetKind === "vehicle" ? (tgt as VehicleState) : null;
                    if (tv && tv.def.domain === "Air" && tv.smokeAt > this.time - 1.5 && this.rng.next() < dt * 2) p.guided = false;
                    else {
                        const tp = tgt.pos, sp = Math.hypot(...p.vel);
                        const want = norm3([tp[0] - p.pos[0], tp[1] + 1 - p.pos[1], tp[2] - p.pos[2]]);
                        const cur = norm3(p.vel), k = Math.min(1, dt * 4);
                        const nd = norm3([cur[0] + (want[0] - cur[0]) * k, cur[1] + (want[1] - cur[1]) * k, cur[2] + (want[2] - cur[2]) * k]);
                        p.vel = [nd[0] * sp, nd[1] * sp, nd[2] * sp];
                    }
                }
            }
            if (p.kind === "grenade" || p.kind === "bomb" || p.kind === "mortar") p.vel[1] -= 9.8 * dt;
            const to: V3 = [p.pos[0] + p.vel[0] * dt, p.pos[1] + p.vel[1] * dt, p.pos[2] + p.vel[2] * dt];
            if (p.kind === "bolt") {
                // Hunter Protocol bolts: resolved on arrival.
                if (p.life <= 0) this.resolveBolt(p); else { p.pos = to; keep.push(p); }
                continue;
            }
            let f = this.world.trace(p.pos[0], p.pos[1], p.pos[2], to[0], to[1], to[2]);
            if (p.kind === "grenade") {
                if (f < 1) { p.vel = [p.vel[0] * -0.3, Math.abs(p.vel[1]) * 0.3, p.vel[2] * -0.3]; }
                else p.pos = to;
                p.fuse -= dt;
                if (p.fuse <= 0) {
                    if (p.weapon === "Smoke Grenade") this.clouds.push({ x: p.pos[0], y: p.pos[1] + 2, z: p.pos[2], r: 8, until: this.time + 18, kind: "smoke" });
                    else if (p.weapon === "EMP Grenade") this.emp(p.pos, 10, 6);
                    else this.explode(p.pos, p.splash, p.damage, 60, p.owner, p.team, p.weapon);
                    continue;
                }
                keep.push(p); continue;
            }
            // Direct hits on vehicles and soldiers.
            const seg = Math.hypot(to[0] - p.pos[0], to[1] - p.pos[1], to[2] - p.pos[2]);
            const d = norm3([to[0] - p.pos[0], to[1] - p.pos[1], to[2] - p.pos[2]]);
            let hitAt = f < 1 ? f * seg : Infinity;
            for (const v of this.vehicles) {
                if (!v.alive || v.team === p.team || v.id === p.ownerVehicle) continue;
                const t = rayVehicle(p.pos, d, v);
                if (t >= 0 && t <= seg && t < hitAt) { hitAt = t; f = t / seg; }
            }
            const ids: number[] = [];
            for (const id of this.near(to[0], to[2], 3, ids)) { const o = this.soldiers[id]; if (o.team !== p.team && Math.abs(o.pos[1] + 1 - to[1]) < 1.5) { hitAt = Math.min(hitAt, seg * 0.99); f = Math.min(f, 0.99); } }
            if (hitAt <= seg || p.life <= 0 || to[1] < this.world.height(to[0], to[2])) {
                const at: V3 = Number.isFinite(hitAt) ? [p.pos[0] + d[0] * hitAt, p.pos[1] + d[1] * hitAt, p.pos[2] + d[2] * hitAt] : to;
                this.explode(at, p.splash, p.damage, p.vsVehicle, p.owner, p.team, p.weapon);
                continue;
            }
            p.pos = to;
            keep.push(p);
        }
        this.projectiles = keep;
    }

    emp(at: V3, radius: number, seconds: number): void {
        this.clouds.push({ x: at[0], y: at[1], z: at[2], r: radius, until: this.time + 1, kind: "emp" });
        for (const v of this.vehicles) if (v.alive && Math.hypot(v.pos[0] - at[0], v.pos[2] - at[2]) < radius + v.def.dims[0] / 2) v.empUntil = this.time + seconds;
        for (const d of this.deployables) if (Math.hypot(d.x - at[0], d.z - at[2]) < radius && d.kind === "turret") d.nextShot = this.time + seconds;
    }

    private mineStep(): void {
        if (Math.floor(this.time * 10) === Math.floor((this.time - STEP) * 10)) return;
        const keep: Mine[] = [];
        for (const m of this.mines) {
            if (m.until < this.time) continue;
            let boom = false;
            if (m.av) { for (const v of this.vehicles) if (v.alive && v.team !== m.team && v.def.domain === "Ground" && Math.hypot(v.pos[0] - m.x, v.pos[2] - m.z) < 2.8) { boom = true; this.damageVehicle(v, 1800 * (1 - v.def.explosiveArmor * 0.4), m.owner, "AV mine"); } }
            else { const ids: number[] = []; for (const id of this.near(m.x, m.z, 1.4, ids)) { const o = this.soldiers[id]; if (o.team !== m.team && o.stance !== "prone") boom = true; } }
            if (boom) { this.stats.mines++; this.explode([m.x, m.y + 0.3, m.z], 4, m.av ? 60 : 110, 0, m.owner, m.team, m.av ? "AV mine" : "AP mine"); continue; }
            keep.push(m);
        }
        this.mines = keep;
    }

    placeMine(s: Soldier, x: number, z: number, av: boolean, life = 240): void {
        this.mines.push({ id: this.nextId++, x, z, y: this.world.height(x, z), team: s.team, owner: s.id, av, until: this.time + life });
    }

    private deployableStep(dt: number): void {
        for (const d of this.deployables) {
            if (d.until < this.time || d.hp <= 0) continue;
            if (d.kind === "turret" && this.time >= d.nextShot) {
                const ids: number[] = [];
                let best = -1, bd = Infinity;
                for (const id of this.near(d.x, d.z, 120, ids)) { const o = this.soldiers[id]; if (o.team === d.team || !o.alive) continue; const dd = Math.hypot(o.pos[0] - d.x, o.pos[2] - d.z); if (dd < bd && this.sight([d.x, d.y + 1.2, d.z], chestOf(o))) { bd = dd; best = id; } }
                d.nextShot = this.time + 0.12;
                if (best >= 0) {
                    const o = this.soldiers[best];
                    const c = chestOf(o);
                    d.yaw = Math.atan2(c[0] - d.x, c[2] - d.z);
                    const hit = this.rng.next() < clamp(0.55 - bd / 400, 0.1, 0.55);
                    this.events.push({ kind: "shot", from: [d.x, d.y + 1.2, d.z], to: hit ? c : [c[0] + this.rng.range(-2, 2), c[1] + this.rng.range(-1, 1), c[2] + this.rng.range(-2, 2)], team: d.team, heavy: false, shooter: d.owner });
                    if (hit) this.damageSoldier(o, 26, "ballistic", d.owner, "Turret", "torso");
                    o.suppression = Math.min(4, o.suppression + 0.3);
                }
            }
            // Crates hand out to anyone near who is short of anything (a drop only once it has landed). The old
            // rule only looked at the primary's reserve, so a spent launcher or grenades never restocked.
            if ((d.kind === "crate" || d.kind === "supply") && d.uses > 0 && this.time - d.born >= (d.kind === "supply" ? SUPPLY_FALL : 0) && Math.floor(this.time) !== Math.floor(this.time - dt)) {
                const ids: number[] = [];
                for (const id of this.near(d.x, d.z, d.kind === "supply" ? 8 : 6, ids)) {
                    const o = this.soldiers[id];
                    if (o.team !== d.team || d.uses <= 0 || !o.alive || o.vehicle >= 0) continue;
                    if (this.needsSupply(o, d.kind === "supply" && o.hp < 70)) this.resupply(o, d);
                }
            }
            if (d.kind === "beacon") { const ids: number[] = []; for (const id of this.near(d.x, d.z, 45, ids)) { const o = this.soldiers[id]; if (o.team !== d.team) this.spotted[d.team].set(o.id, this.time + 1); } }
        }
        this.deployables = this.deployables.filter(d => {
            if (d.until >= this.time && d.hp > 0) return true;
            if (d.box >= 0) this.world.destroy(d.box);
            return false;
        });
    }

    deploy(s: Soldier, kind: Deployable["kind"], x: number, z: number, hp: number, life: number, uses = 0): Deployable {
        const y = this.world.height(x, z);
        const d: Deployable = { id: this.nextId++, kind, team: s.team, owner: s.id, x, z, y, yaw: s.yaw, hp, until: this.time + life, uses, nextShot: this.time + 1, box: -1, born: this.time };
        if (kind === "cover") {
            const box = { x, z, y, hx: 0.3, hz: 1.3, h: 1.2, lift: 0, yaw: s.yaw + Math.PI / 2, mat: "barrier" as const, tint: 0, seed: 1, kind: "cover" as const, hp };
            this.world.boxes.push(box);
            d.box = this.world.boxes.length - 1;
            this.world.rasterize(box, d.box);
        }
        this.deployables.push(d);
        return d;
    }

    private strikeStep(): void {
        for (const st of this.strikes) {
            if (st.done || this.time < st.at) continue;
            if (st.kind === "R004") {
                // Artillery: 10 shells over 6 s.
                if (st.shots > 0 && this.rng.next() < 0.3) {
                    st.shots--;
                    const a = this.rng.range(0, Math.PI * 2), r = Math.sqrt(this.rng.next()) * 25;
                    const x = st.x + Math.cos(a) * r, z = st.z + Math.sin(a) * r;
                    this.explode([x, this.world.height(x, z) + 0.3, z], 12, 220, 700, st.owner, st.team, "Artillery Strike");
                }
                if (st.shots <= 0) st.done = true;
            } else if (st.kind === "R006") {
                for (let i = 0; i < 4; i++) { const x = st.x + Math.sin(st.yaw) * (i - 1.5) * 18, z = st.z + Math.cos(st.yaw) * (i - 1.5) * 18; this.explode([x, this.world.height(x, z) + 0.3, z], 14, 300, 1500, st.owner, st.team, "Tactical Airstrike"); }
                st.done = true;
            } else if (st.kind === "R007") {
                this.hunterProtocol(st);
                st.done = true;
            }
        }
        this.strikes = this.strikes.filter(s => !s.done);
    }

    /** Hunter Protocol: up to 16 targets in the field, each neutralized with 80% (halved under a roof, in smoke or in a thermal cloak; AA within 150 m shoots bolts down). */
    private hunterProtocol(st: Strike): void {
        const r = REWARD.get("R007")!;
        const ids: number[] = [];
        const targets: { kind: "soldier" | "vehicle"; id: number; d: number }[] = [];
        for (const id of this.near(st.x, st.z, r.radius, ids)) { const o = this.soldiers[id]; if (o.team !== st.team && o.alive && o.vehicle < 0) targets.push({ kind: "soldier", id, d: Math.hypot(o.pos[0] - st.x, o.pos[2] - st.z) }); }
        for (const v of this.vehicles) if (v.alive && v.team !== st.team && Math.hypot(v.pos[0] - st.x, v.pos[2] - st.z) < r.radius) targets.push({ kind: "vehicle", id: v.id, d: Math.hypot(v.pos[0] - st.x, v.pos[2] - st.z) });
        targets.sort((a, b) => a.d - b.d);
        let intercept = this.vehicles.filter(v => v.alive && v.team !== st.team && v.def.id === "V007" && Math.hypot(v.pos[0] - st.x, v.pos[2] - st.z) < 150).length * 2;
        for (const t of targets.slice(0, r.count)) {
            const tgt = t.kind === "vehicle" ? this.vehicles[t.id].pos : this.soldiers[t.id].pos;
            const from: V3 = [st.x, this.world.height(st.x, st.z) + 180, st.z];
            const T = 1.2 + this.rng.next() * 0.6;
            let chance = r.chance;
            if (t.kind === "soldier") {
                const o = this.soldiers[t.id];
                if (this.world.roofAt(o.pos[0], o.pos[2]) || this.clouds.some(c => c.kind === "smoke" && Math.hypot(c.x - o.pos[0], c.z - o.pos[2]) < c.r) || o.loadout.armor.Utility === "AR010") chance *= 0.5;
            }
            if (intercept > 0) { intercept--; chance = 0; }
            this.projectiles.push({ kind: "bolt", pos: from, vel: [(tgt[0] - from[0]) / T, (tgt[1] - from[1]) / T, (tgt[2] - from[2]) / T], owner: st.owner, ownerVehicle: -1, team: st.team, damage: 9999, vsVehicle: 9999, splash: 0, life: T, target: t.id, targetKind: t.kind, guided: false, fuse: 0, weapon: "Hunter Protocol", chance });
        }
    }

    private resolveBolt(p: Projectile): void {
        const ok = this.rng.next() < p.chance;
        const at: V3 = [...p.pos];
        this.events.push({ kind: "explode", at, radius: 2 });
        if (!ok) return;
        if (p.targetKind === "vehicle") this.damageVehicle(this.vehicles[p.target], 1e6, p.owner, "Hunter Protocol");
        else this.kill(this.soldiers[p.target], p.owner, "Hunter Protocol");
    }

    // --- rewards ------------------------------------------------------------------------------

    private streakRewards(k: Soldier): void {
        for (const r of KILLSTREAKS) if (k.streak === r.requirement && !k.rewards.includes(r.id)) {
            k.rewards.push(r.id); this.stats.killstreaks++;
            this.events.push({ kind: "reward", soldier: k.id, reward: r.id, underdog: false });
        }
    }

    /** Underdog: time in the bottom quarter of the team leaderboard earns a reward (a rotating deck). */
    private leaderboardStep(dt: number): void {
        if (Math.floor(this.time) === Math.floor(this.time - dt) || this.time < 30) return;
        for (const team of [0, 1] as Team[]) {
            const board = this.soldiers.filter(s => s.team === team).sort((a, b) => a.score - b.score);
            // The bottom quarter: below the 25th-percentile score (at a score of 0, only those also dying more than killing).
            const q = board[Math.max(0, Math.floor(board.length * BALANCE.underdogShare) - 1)]?.score ?? 0;
            const bottom = new Set(board.filter(s => s.expires === 0 && (s.score < q || (s.score <= q && s.deaths >= s.kills + 2))).map(s => s.id));
            for (const s of board) {
                if (!bottom.has(s.id)) { s.underdogTime = Math.max(0, s.underdogTime - 0.5); continue; }
                s.underdogTime += 1;
                if (s.underdogTime >= BALANCE.underdogSeconds && s.rewards.filter(r => r.startsWith("R1")).length < 2) {
                    s.underdogTime = 0;
                    let r = UNDERDOG[(s.id * 7 + Math.floor(this.time / 37)) % UNDERDOG.length].id;
                    // One reinforcement squad per team at a time.
                    if (r === "R103" && this.soldiers.some(o => o.team === team && o.expires > this.time)) r = "R101";
                    s.rewards.push(r); this.stats.underdog++;
                    this.events.push({ kind: "reward", soldier: s.id, reward: r, underdog: true });
                }
            }
        }
    }

    /** Uses a reward at a point. Returns a reason when it cannot. */
    useReward(s: Soldier, index: number, point: V3 | null): string {
        const id = s.rewards[index];
        if (!id || !s.alive) return "no reward";
        const r = REWARD.get(id)!;
        const p: V3 = point ?? [s.pos[0] + Math.sin(s.yaw) * 30, 0, s.pos[2] + Math.cos(s.yaw) * 30];
        const x = p[0], z = p[2];
        switch (id) {
            case "R001": for (const o of this.soldiers) if (o.team !== s.team && o.alive && Math.hypot(o.pos[0] - s.pos[0], o.pos[2] - s.pos[2]) < r.radius && o.loadout.armor.Utility !== "AR010") this.spotted[s.team].set(o.id, this.time + r.duration); break;
            case "R002": {
                // The drop lands at the crosshair, never more than 120 m out, on open ground.
                const dx = x - s.pos[0], dz = z - s.pos[2], d = Math.hypot(dx, dz), k = d > 120 ? 120 / d : 1;
                const [px, pz] = this.world.openNear(s.pos[0] + dx * k, s.pos[2] + dz * k);
                this.deploy(s, "supply", px, pz, 300, 120, 3 * 8);
                break;
            }
            case "R003": this.temporaryAircraft(s, "V012", r.duration); break;
            case "R004": this.strikes.push({ kind: id, team: s.team, owner: s.id, x, z, at: this.time + 3, shots: r.count, yaw: s.yaw, done: false }); break;
            case "R005": this.temporaryAircraft(s, "V013", r.duration); break;
            case "R006": {
                if (!this.sight(eyeOf(s), [x, this.world.height(x, z) + 1, z])) return "the line must be in sight";
                this.strikes.push({ kind: id, team: s.team, owner: s.id, x, z, at: this.time + 2, shots: 4, yaw: s.yaw, done: false });
                break;
            }
            case "R007": this.strikes.push({ kind: id, team: s.team, owner: s.id, x, z, at: this.time + 2, shots: 16, yaw: 0, done: false }); break;
            case "R101": {
                // Mine Kit: 16 mines in one go, an arc across the aim point (12 AP, then 4 AV in the middle).
                const yaw = Math.atan2(x - s.pos[0], z - s.pos[2]);
                for (let i = 0; i < 16; i++) {
                    const t = (i / 15 - 0.5) * 1.6, rr = 9 + (i % 2) * 2.5;
                    const mx = x + Math.sin(yaw + Math.PI / 2) * t * 12 - Math.sin(yaw) * (rr - 9), mz = z + Math.cos(yaw + Math.PI / 2) * t * 12 - Math.cos(yaw) * (rr - 9);
                    const [ox, oz] = this.world.openNear(mx, mz);
                    this.placeMine(s, ox, oz, i >= 6 && i < 10, r.duration);
                }
                break;
            }
            case "R102": this.restock(s); break;
            case "R103": this.reinforcements(s, r.count, r.duration); break;
            case "R104": { const v = this.vehicles.find(o => o.alive && o.team === s.team && Math.hypot(o.pos[0] - s.pos[0], o.pos[2] - s.pos[2]) < 8); if (!v) return "no vehicle near"; v.hp = Math.min(v.def.hp, v.hp + 1500); break; }
            case "R105": this.deploy(s, "turret", x, z, 600, r.duration); break;
            case "R106": s.loadout.launcher = "W013"; s.mag.launcher = 1; s.reserve.launcher = 2; s.equipment.push({ id: "E002", left: 2 }); break;
            case "R107": for (const o of this.soldiers) if (o.team !== s.team && o.alive && Math.hypot(o.pos[0] - s.pos[0], o.pos[2] - s.pos[2]) < r.radius && o.loadout.armor.Utility !== "AR010") this.spotted[s.team].set(o.id, this.time + r.duration); break;
            case "R108": this.emp([x, this.world.height(x, z), z], r.radius, r.duration); break;
            case "R109": { const v = this.temporaryAircraft(s, "V014", 90); v.lz = [x, z]; break; }
        }
        s.rewards.splice(index, 1);
        this.stats.rewardsUsed++;
        this.events.push({ kind: "rewardUsed", soldier: s.id, reward: id, x, z });
        return "";
    }

    private temporaryAircraft(s: Soldier, id: string, seconds: number): VehicleState {
        const b = this.world.bases[s.team];
        let v = this.spawnVehicle(s.team, id, 0, [b.x, b.z]);
        // Reuse the slot of a finished temporary aircraft (ids are indices).
        const slot = this.vehicles.findIndex(o => o.temporary && !o.alive && o.id !== v.id);
        if (slot >= 0) { this.vehicles.pop(); Object.assign(this.vehicles[slot], { ...v, id: slot }); v = this.vehicles[slot]; }
        v.pos[1] = this.world.height(b.x, b.z) + 60; v.landed = false; v.altitude = v.pos[1];
        v.temporary = this.time + seconds; v.owner = s.id; v.squad = s.squad;
        // An AI pilot (not on the roster).
        const pilot = this.makeSoldier(s.team, s.squad, "rifleman", true, "AI pilot");
        pilot.alive = true; pilot.respawnAt = Infinity; pilot.expires = this.time + seconds + 1;
        this.enterVehicle(pilot, v, 0);
        return v;
    }

    private reinforcements(s: Soldier, n: number, seconds: number): void {
        const sq: Squad = { id: this.squads.length, team: s.team, members: [], kind: "S001", mode: "regroup", objective: this.squads[s.squad].objective, thinkAt: this.time, planAt: this.time + 2, call: { x: s.pos[0], z: s.pos[2], until: this.time + seconds }, vehicle: -1, flank: null, contact: 0, armorSeen: 0 };
        this.squads.push(sq);
        for (let i = 0; i < n; i++) {
            const m = this.makeSoldier(s.team, sq.id, SQUADS[0].roles[i], true, `Reinforcement ${i + 1}`);
            sq.members.push(m.id);
            this.respawn(m, true, `S${s.id}`);
            m.respawnAt = Infinity; m.expires = this.time + seconds;
        }
    }

    // --- territories, tickets, mecha, airdrops -------------------------------------------------

    private captureStep(dt: number): void {
        for (const t of this.territories) {
            const counts: [number, number] = [0, 0];
            const ids: number[] = [];
            for (const id of this.near(t.def.x, t.def.z, t.def.radius, ids)) { const s = this.soldiers[id]; counts[s.team]++; }
            for (const v of this.vehicles) if (v.alive && v.def.domain === "Ground" && Math.hypot(v.pos[0] - t.def.x, v.pos[2] - t.def.z) < t.def.radius) { const n = this.passengers(v); if (n) counts[v.team] += n; }
            t.counts = counts;
            t.contested = counts[0] > 0 && counts[1] > 0;
            const diff = counts[0] - counts[1];
            if (diff === 0) continue;
            const rate = (Math.sqrt(Math.abs(diff)) / BALANCE.capture) * dt * Math.sign(diff);
            const before = t.owner;
            // Progress runs from -1 (Ember) to +1 (Meridian); an owner keeps it until it crosses 0.
            t.progress = clamp(t.progress + rate, -1, 1);
            if (t.progress >= 1 && t.owner !== 0) t.owner = 0;
            else if (t.progress <= -1 && t.owner !== 1) t.owner = 1;
            else if ((t.owner === 0 && t.progress <= 0) || (t.owner === 1 && t.progress >= 0)) t.owner = -1;
            if (t.owner !== before && t.owner !== -1) {
                this.stats.captures++;
                this.events.push({ kind: "capture", territory: t.def.id, team: t.owner });
                for (const id of ids) { const s = this.soldiers[id]; if (s.team === t.owner) { s.score += 150; s.captures++; s.streak++; s.best = Math.max(s.best, s.streak); this.streakRewards(s); } }
            }
        }
    }

    private ticketStep(): void {
        if (this.time >= this.drainAt) {
            this.drainAt += 10;
            const h0 = this.holdings(0), h1 = this.holdings(1);
            if (h0 > h1) this.tickets[1] = Math.max(0, this.tickets[1] - (h0 - h1) * BALANCE.drain);
            if (h1 > h0) this.tickets[0] = Math.max(0, this.tickets[0] - (h1 - h0) * BALANCE.drain);
        }
        const out = ([0, 1] as Team[]).filter(t => this.tickets[t] <= 0 && !this.soldiers.some(s => s.team === t && s.alive));
        const none = ([0, 1] as Team[]).find(t => this.tickets[t] <= 0 && this.holdings(t) === 0);
        if (out.length || none !== undefined) {
            const loser = out[0] ?? none!;
            this.winner = (1 - loser) as Team;
            this.events.push({ kind: "end", winner: this.winner });
        }
    }

    /** One mecha per side: it unlocks while a team holds half the territories or trails by MECHA_RULE.behindBy tickets. */
    private mechaStep(): void {
        if (Math.floor(this.time * 2) === Math.floor((this.time - STEP) * 2)) return;
        for (const t of [0, 1] as Team[]) {
            if (this.mecha[t] >= 0 || this.time < this.mechaAt[t] || this.time < 60) continue;
            const half = this.holdings(t) >= Math.ceil(this.territories.length * MECHA_RULE.territoriesToUnlock);
            const behind = this.tickets[1 - t] - this.tickets[t] >= MECHA_RULE.behindBy;
            if (!half && !behind) continue;
            this.spawnMecha(t, MECHA[(Math.floor(this.time / 60) + t) % MECHA.length].id);
        }
    }

    /** The heavy transport aircraft brings a tank to the front when a team has lost its armor. */
    private airdropStep(): void {
        for (const t of [0, 1] as Team[]) {
            if (this.time < this.airdropAt[t]) continue;
            this.airdropAt[t] = this.time + 75;
            const tanks = this.vehicles.filter(v => v.team === t && v.alive && (v.def.id === "V005" || v.def.id === "V006")).length;
            if (tanks >= 2) continue;
            const front = this.territories.filter(x => x.owner === t).sort((a, b) => Math.hypot(a.def.x - this.world.bases[1 - t].x, a.def.z - this.world.bases[1 - t].z) - Math.hypot(b.def.x - this.world.bases[1 - t].x, b.def.z - this.world.bases[1 - t].z))[0];
            if (!front) continue;
            const plane = this.vehicles.find(v => v.team === t && v.def.id === "V018" && v.alive);
            if (!plane) continue;
            plane.payload = "V005"; plane.goal = [front.def.x, front.def.z]; plane.phase = 1;
        }
    }

    /** The transport aircraft releases its payload: a tank under parachutes. */
    airdrop(plane: VehicleState): void {
        if (!plane.payload) return;
        const [x, z] = this.world.vehOpenNear(plane.pos[0], plane.pos[2]);
        const v = this.spawnVehicle(plane.team, plane.payload, 0, [x, z], true);
        v.altitude = 0; v.landed = false; v.temporary = 0;
        v.pos[1] = plane.pos[1] - 6;
        plane.payload = null;
        this.stats.airdrops++;
        this.events.push({ kind: "airdrop", team: plane.team, vehicle: v.id });
    }

    // --- the player ---------------------------------------------------------------------------

    private playerStep(s: Soldier, inp: PlayerInput, dt: number): void {
        if (!s.alive) return;
        s.yaw = inp.yaw; s.pitch = inp.pitch;
        if (inp.use) {
            const crate = s.vehicle < 0 ? this.supplyNear(s, 4) : null;
            if (s.vehicle >= 0) this.exitVehicle(s);
            else if (crate && this.needsSupply(s, crate.kind === "supply")) this.resupply(s, crate);
            else {
                // Any friendly hull within 3 m (the old test measured from the vehicle's centre, so the
                // player had to stand almost inside a long vehicle). A full vehicle makes room: its last
                // bot passenger gets out.
                const v = this.vehicleNear(s, true);
                if (v) {
                    if (!v.seats.includes(-1)) {
                        const out = [...v.seats].reverse().find(id => id >= 0 && this.soldiers[id].bot);
                        if (out !== undefined) this.exitVehicle(this.soldiers[out]);
                    }
                    // The player takes the driver's seat when it is free, else the first free seat.
                    const freeSeat = v.seats.findIndex((x, i) => i > 0 && x === -1);
                    if (v.seats[0] >= 0 && this.soldiers[v.seats[0]].bot && freeSeat > 0) { const bot = this.soldiers[v.seats[0]]; v.seats[0] = -1; v.seats[freeSeat] = bot.id; bot.seat = freeSeat; }
                    this.enterVehicle(s, v);
                }
            }
        }
        if (inp.reward >= 0) this.useReward(s, inp.reward, inp.point);
        if (inp.call && inp.point) {
            const sq = this.squads[s.squad];
            sq.call = { x: inp.point[0], z: inp.point[2], until: this.time + 30 };
            sq.thinkAt = this.time;
        }
        if (s.vehicle >= 0) { this.playerDrive(s, inp, dt); return; }
        if (inp.slot && inp.slot !== s.slot && (inp.slot !== "launcher" || launcherOf(s))) { s.slot = inp.slot; s.reloadUntil = 0; s.nextShot = this.time + 0.4; s.lock.target = -1; }
        s.stance = inp.prone ? "prone" : inp.crouch ? "crouch" : "stand";
        const speedBase = s.stance === "prone" ? BALANCE.prone : s.stance === "crouch" ? BALANCE.crouch : inp.sprint && !inp.aim ? BALANCE.sprint : inp.aim ? BALANCE.walk * 1.2 : BALANCE.run;
        const sp = speedBase * s.stats.speedShare;
        const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw), rx = -Math.cos(s.yaw), rz = Math.sin(s.yaw);
        let mx = fx * inp.move[1] + rx * inp.move[0], mz = fz * inp.move[1] + rz * inp.move[0];
        const ml = Math.hypot(mx, mz); if (ml > 1) { mx /= ml; mz /= ml; }
        s.vel[0] = mx * sp; s.vel[2] = mz * sp;
        if (inp.jump && s.pos[1] <= this.world.height(s.pos[0], s.pos[2]) + 0.05 && s.stance === "stand") { s.vel[1] = 4.2; s.pos[1] += 0.05; }
        if (inp.aim) { if (!s.aimedSince) s.aimedSince = this.time; } else s.aimedSince = 0;
        if (inp.reload) this.startReload(s);
        const w = this.weaponOf(s);
        // Guided launchers lock a vehicle held under the crosshair for `w.lock` seconds; only a full lock guides.
        if (w.lock > 0) {
            const t = this.lockTarget(s, w.locks as "ground" | "air");
            if (t !== s.lock.target) s.lock = { target: t, since: this.time };
        } else s.lock.target = -1;
        const locked = s.lock.target >= 0 && this.time - s.lock.since >= w.lock ? s.lock.target : -1;
        // Automatic weapons fire while the trigger is held; everything else once per pull. (Rate is the
        // weapon's own nextShot: the old extra `60 / rpm since the last shot of any weapon` test locked a
        // launcher out for 6-60 s after a rifle burst.)
        if (inp.fire && (w.action === "auto" || !s.trigger)) {
            const aimed = inp.aim && this.time - s.aimedSince >= s.stats.aimTime * (s.slot === "primary" ? 1 : 0.6);
            this.fire(s, s.yaw, s.pitch, aimed, locked, locked >= 0 ? "vehicle" : "");
        }
        s.trigger = inp.fire;
        if (inp.grenade && s.grenades > 0) this.throwGrenade(s, s.yaw, s.pitch, "Fragmentation Grenade");
        if (inp.equipment) this.useEquipment(s, inp.point);
    }

    /** The enemy vehicle closest to the crosshair within the lock cone (guided launchers). */
    lockTarget(s: Soldier, kind: "ground" | "air"): number {
        const d = dirOf(s.yaw, s.pitch), e = eyeOf(s), range = (launcherOf(s)?.range ?? 600) * 1.25;
        let best = -1, bd = 0.97;
        for (const v of this.vehicles) {
            if (!v.alive || v.team === s.team || (v.def.domain === "Air") !== (kind === "air")) continue;
            if (Math.hypot(v.pos[0] - e[0], v.pos[1] - e[1], v.pos[2] - e[2]) > range) continue;
            const to = norm3([v.pos[0] - e[0], v.pos[1] + 1 - e[1], v.pos[2] - e[2]]);
            const c = to[0] * d[0] + to[1] * d[1] + to[2] * d[2];
            if (c > bd) { bd = c; best = v.id; }
        }
        return best;
    }

    throwGrenade(s: Soldier, yaw: number, pitch: number, kind: string): void {
        if (kind === "Fragmentation Grenade") { if (s.grenades <= 0) return; s.grenades--; }
        const d = dirOf(yaw, pitch + 0.25), e = eyeOf(s), eq = EQUIP.get(kind === "Smoke Grenade" ? "E004" : kind === "EMP Grenade" ? "E005" : "E003")!;
        this.projectiles.push({ kind: "grenade", pos: [e[0] + d[0] * 0.5, e[1], e[2] + d[2] * 0.5], vel: [d[0] * 17, d[1] * 17 + 2, d[2] * 17], owner: s.id, ownerVehicle: -1, team: s.team, damage: eq.effect, vsVehicle: 60, splash: eq.radius, life: 8, target: -1, targetKind: "", guided: false, fuse: kind === "Fragmentation Grenade" ? eq.duration : 1.8, weapon: kind, chance: 1 });
    }

    /** Uses the first piece of equipment that has uses left (mines, crates, cover, turret, beacon, medkit, smoke). */
    useEquipment(s: Soldier, point: V3 | null): void {
        const e = s.equipment.find(q => q.left > 0);
        if (!e) return;
        const def = EQUIP.get(e.id)!;
        const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
        const [x, z] = point && Math.hypot(point[0] - s.pos[0], point[2] - s.pos[2]) < 6 ? [point[0], point[2]] : [s.pos[0] + fx * 2, s.pos[2] + fz * 2];
        e.left--;
        switch (e.id) {
            case "E001": this.placeMine(s, x, z, false, def.duration); break;
            case "E002": this.placeMine(s, x, z, true, def.duration); break;
            case "E004": case "E005": this.throwGrenade(s, s.yaw, s.pitch, def.name); break;
            case "E006": { const ids: number[] = []; const mate = this.near(s.pos[0], s.pos[2], 3, ids).map(i => this.soldiers[i]).filter(o => o.team === s.team && o.hp < 100).sort((a, b) => a.hp - b.hp)[0] ?? s; mate.healUntil = this.time + 3; if (mate !== s) s.score += 25; break; }
            case "E007": { const v = this.vehicles.find(o => o.alive && o.team === s.team && Math.hypot(o.pos[0] - s.pos[0], o.pos[2] - s.pos[2]) < 6); if (v) { v.hp = Math.min(v.def.hp, v.hp + 180); s.score += 20; } else { const m = this.mines.findIndex(q => q.team !== s.team && Math.hypot(q.x - s.pos[0], q.z - s.pos[2]) < 4); if (m >= 0) { this.mines.splice(m, 1); s.score += 30; } } e.left++; break; }
            case "E008": this.deploy(s, "crate", x, z, def.hp, def.duration, def.effect); break;
            case "E009": this.deploy(s, "cover", x, z, def.hp, def.duration); break;
            case "E010": this.deploy(s, "turret", x, z, def.hp, def.duration); break;
            case "E011": this.deploy(s, "beacon", x, z, def.hp, def.duration); break;
        }
    }

    private playerDrive(s: Soldier, inp: PlayerInput, dt: number): void {
        const v = this.vehicles[s.vehicle];
        if (!v) return;
        if (s.seat === 0) {
            driveVehicle(this, v, inp.throttle, inp.steer, inp.lift, dt);
            v.turretYaw = inp.yaw; v.turretPitch = inp.pitch;
        }
        if (inp.fire) {
            const gi = v.def.guns.findIndex(g => g.seat === s.seat || (s.seat === 0 && g.seat === 0));
            const gun = gi >= 0 ? gi : 0;
            const from = v.pos, d = dirOf(inp.yaw, inp.pitch);
            const aim: V3 = inp.point ?? [from[0] + d[0] * 400, from[1] + d[1] * 400, from[2] + d[2] * 400];
            const g = v.def.guns[gun];
            const lock = g?.locks ? this.vehicles.filter(o => o.alive && o.team !== v.team && (o.def.domain === "Air") === (g.locks === "air")).sort((a, b) => Math.hypot(a.pos[0] - aim[0], a.pos[2] - aim[2]) - Math.hypot(b.pos[0] - aim[0], b.pos[2] - aim[2]))[0] : undefined;
            this.vehicleFire(v, gun, aim, s.id, lock?.id ?? -1, lock ? "vehicle" : "");
        }
        if (inp.equipment && v.countermeasures > 0 && this.time - v.smokeAt > 8) { v.countermeasures--; v.smokeAt = this.time; if (v.def.domain === "Ground") this.clouds.push({ x: v.pos[0], y: v.pos[1] + 2, z: v.pos[2], r: 10, until: this.time + 15, kind: "smoke" }); }
        if (v.def.domain === "Air" && v.payload && inp.grenade) this.airdrop(v);
    }

    // --- summaries ----------------------------------------------------------------------------

    leaderboard(t: Team): Soldier[] { return this.soldiers.filter(s => s.team === t && !s.expires).sort((a, b) => b.score - a.score || b.kills - a.kills); }
}

/** Kinematic driving for any vehicle: throttle/steer for ground, plus lift for aircraft. */
export function driveVehicle(b: Battle, v: VehicleState, throttle: number, steer: number, lift: number, dt: number): void {
    if (v.empUntil > b.time) return;
    const top = (v.def.topSpeed / 3.6) * (v.def.domain === "Air" ? (v.def.topSpeed > 500 ? 0.12 : 0.5) : 1) * (v.parts ? 0.4 + 0.6 * clamp(v.parts.legs / v.mecha!.parts.legs) : 1);
    const want = throttle * top * (throttle < 0 ? 0.4 : 1);
    v.speed += clamp(want - v.speed, -v.def.accel * dt * 2, v.def.accel * dt);
    v.yaw += steer * v.def.turn * dt * (v.def.domain === "Air" ? 1 : clamp(Math.abs(v.speed) / 3, 0.35, 1)) * (v.speed < -0.1 ? -1 : 1);
    if (v.def.domain === "Air") {
        const ground = b.world.height(v.pos[0], v.pos[2]);
        if (v.def.topSpeed > 500) { v.altitude = clamp((v.altitude || v.pos[1]) + lift * 40 * dt, ground + 60, ground + 500); v.speed = Math.max(v.speed, top * 0.45); v.landed = false; }
        else {
            if (lift > 0.1) v.landed = false;
            v.altitude = clamp((v.altitude || v.pos[1]) + lift * 12 * dt, ground, ground + 300);
            if (lift < -0.1 && v.altitude <= ground + 1.5 && b.world.slope(v.pos[0], v.pos[2]) < 0.3) { v.landed = true; v.speed = 0; }
        }
    }
}

/** The weapon in a soldier's launcher slot: the carried launcher, else the primary's underbarrel grenade launcher, else none. */
export function launcherOf(s: Soldier): Weapon | null {
    if (s.loadout.launcher) return WEAPON.get(s.loadout.launcher) ?? null;
    return s.loadout.attachments.Underbarrel === UGL.id ? UGL : null;
}

export function dirOf(yaw: number, pitch: number): V3 { return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]; }
function norm3(a: V3): V3 { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function segPointDist(a: V3, b: V3, p: V3): number {
    const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    const t = l2 ? clamp(((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2) : 0;
    return Math.hypot(a[0] + ab[0] * t - p[0], a[1] + ab[1] * t - p[1], a[2] + ab[2] * t - p[2]);
}

/** Ray against a vehicle's oriented box: the distance along the (unit) ray, or -1. */
export function rayVehicle(o: V3, d: V3, v: VehicleState): number {
    const [L, W, H] = v.def.dims;
    const hx = W / 2, hz = L / 2, base = v.mecha ? 0 : v.def.domain === "Air" ? -H / 2 : 0, top = v.mecha ? 11 : v.def.domain === "Air" ? H / 2 : H;
    const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
    const px = o[0] - v.pos[0], pz = o[2] - v.pos[2], py = o[1] - v.pos[1];
    const lx = px * c - pz * s, lz = px * s + pz * c, dx = d[0] * c - d[2] * s, dz = d[0] * s + d[2] * c;
    let t0 = -Infinity, t1 = Infinity;
    for (const [p, q, lo, hi] of [[lx, dx, -hx, hx], [py, d[1], base, top], [lz, dz, -hz, hz]] as [number, number, number, number][]) {
        if (Math.abs(q) < 1e-9) { if (p < lo || p > hi) return -1; continue; }
        let a = (lo - p) / q, b = (hi - p) / q;
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b);
        if (t0 > t1) return -1;
    }
    return t0 >= 0 ? t0 : t1 >= 0 ? 0 : -1;
}

export { ARMOR_BY_ID, ATTACHMENT };
