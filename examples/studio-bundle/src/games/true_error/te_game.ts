// True Error, level 1, as a simulation with no engine calls (tests drive it directly): Ray's
// movement against the level's boxes and ramps (walk, run, crouch, roll, jump), the photon rifle,
// the hacked machines (patrol, alert, fight, knocked out, then Reset or destroyed by the player's
// choice), the dark zones and the biochip, nuclear cells, collectibles, the mission's stages
// (te_mission.ts), checkpoints and saves. The addon (true_error_addon.ts) feeds it input and draws
// what it says.

import { buildLevel, World, openness, regionOf, START, PEDESTAL, GOAL_RADIUS, LIFT, type Level, type V3, type EnemyKind, type Solid, type Prop, type UseSpot, type ItemSpot, type Region } from "./te_level";
import { addActs, LIVE_CONDUIT, WAVE_SPAWNS, WAVE_TIMES, HOLD_SECONDS, WARDEN_DROP } from "./te_acts";
import { stageIndex, stageOf, type StageId } from "./te_mission";

export { LINES } from "./te_mission";

export const PLAYER = { radius: 0.35, height: 1.8, crouchHeight: 1.15, rollHeight: 1.0, step: 0.5, walk: 2.3, run: 5.4, aimWalk: 1.9, crouch: 1.5, jump: 6.2, gravity: 18 };
/** The dodge roll: how long, how fast, when nothing can hit Ray, and the rest before the next. */
export const ROLL = { seconds: 0.62, speed: 6.4, safeFrom: 0.03, safeTo: 0.42, cooldown: 0.3 };
export const RIFLE = { interval: 0.14, cost: 2.4, damage: 15, range: 120, regen: 7 };
export const ENEMY = {
    roller: { hp: 60, speed: 2.6, sight: 20, range: 14, interval: 1.1, damage: 6, spread: 0.06, radius: 0.55, height: 1.1, windup: 0.3 },
    hacked_bot: { hp: 120, speed: 1.6, sight: 24, range: 18, interval: 0.32, damage: 5, spread: 0.08, radius: 0.45, height: 2.1, burst: 4, rest: 1.6, windup: 0.5 },
    crawler: { hp: 45, speed: 4.4, sight: 18, range: 7, interval: 1.9, damage: 16, spread: 0, radius: 0.5, height: 0.95, windup: 0.5, leap: 0.55 },
    warden: { hp: 700, speed: 1.4, sight: 40, range: 20, interval: 2.4, damage: 22, spread: 0.05, radius: 0.95, height: 2.9, windup: 0.9 },
};
/** Seconds a knocked-out machine stays down before it reboots, still hacked (the Warden longer). */
export const STUN_TIME = 10;
export const WARDEN_STUN = 20;
export const RESET_REACH = 2.6;
export const USE_REACH = 2.2;
export const DARK_DAMAGE = 14;
/** The biochip: charge drained per second in the dark (it thinks for you), regrown outside it. */
export const BIOCHIP = { drain: 6.5, regen: 3 };
/** The Warden's cannon: slow orbs, three a volley, bursting where they hit. */
export const ORB = { speed: 9, life: 4, radius: 2.2, damage: 22 };

export interface PlayerInput {
    /** Move in camera space: x right, y forward (-1..1). */
    move: [number, number];
    run: boolean;
    jump: boolean;
    fire: boolean;
    aim: boolean;
    use: boolean;
    /** Crouch wanted (the addon keeps the toggle); Ray stays down where there's no room to stand. */
    crouch: boolean;
    /** Roll (a tap). */
    dodge: boolean;
    /** Camera yaw/pitch (rad): where the crosshair points. */
    yaw: number;
    pitch: number;
    /** Where the crosshair ray hits (from the camera), for the shot's direction. */
    target: V3 | null;
}
export const NO_INPUT: PlayerInput = { move: [0, 0], run: false, jump: false, fire: false, aim: false, use: false, crouch: false, dodge: false, yaw: 0, pitch: 0, target: null };

export type EnemyState = "patrol" | "alert" | "fight" | "stunned" | "restored" | "destroyed";

export interface Enemy {
    id: string;
    kind: EnemyKind;
    pos: V3;
    yaw: number;
    hp: number;
    state: EnemyState;
    stateT: number;
    patrol: V3[];
    leg: number;
    zone: string;
    cooldown: number;
    burst: number;
    hitFlash: number;
    /** 0..1 how fast it is moving (for the walk animation and the roller's roll). */
    moving: number;
    roll: number;
    seen: boolean;
    vel: V3;
    /** Seconds spent winding up the next attack (the glow before a burst, a crawler's crouch). */
    charge: number;
    /** A crawler's pounce in flight, or the Warden's drop through the roof. */
    leap: { from: V3; to: V3; t: number; dur: number; arc: number } | null;
    /** Spawned during play (waves, the Warden's call): not saved. */
    spawned: boolean;
}

export interface Bolt { from: V3; to: V3; age: number; enemy: boolean; hit: boolean }
export interface Orb { pos: V3; vel: V3; age: number }

export type GameEvent =
    | { kind: "shot"; at: V3; enemy: boolean }
    | { kind: "hit"; at: V3; target: string }
    | { kind: "hurt"; amount: number }
    | { kind: "disabled"; id: string; at: V3 }
    | { kind: "reset"; id: string; at: V3 }
    | { kind: "destroyed"; id: string; at: V3 }
    | { kind: "rebooted"; id: string }
    | { kind: "pickup"; id: string }
    | { kind: "line"; id: string }
    | { kind: "checkpoint"; id: string }
    | { kind: "died" }
    | { kind: "respawn" }
    | { kind: "step"; at: V3 }
    | { kind: "goal" }
    | { kind: "charge"; id: string; at: V3 }
    | { kind: "pounce"; id: string; at: V3 }
    | { kind: "roll" }
    | { kind: "orb"; at: V3 }
    | { kind: "burst"; at: V3 }
    | { kind: "stage"; id: StageId; act: number; newAct: boolean }
    | { kind: "dormant" }
    | { kind: "use"; id: string; ok: boolean }
    | { kind: "door"; id: string }
    | { kind: "collect"; id: string }
    | { kind: "wave"; n: number }
    | { kind: "surge" }
    | { kind: "spawn"; id: string; at: V3 };

/** Where the simulation lens shows the old world's light, a trail from the lab to the hypercube. */
export const ECHOES: V3[] = [
    [-13, 0.2, -13], [-13.7, 0.2, -9], [-15, 0.2, -6.5], [-19, 1.6, -3], [-19, 4.6, 3], [-18.5, 7.2, 8.5],
    [-12, 7.2, 9.5], [-4, 7.2, 10], [4, 7.2, 9], [8.5, 7.2, 4], [9.6, 7.2, -4], [9.6, 7.2, -12], [8, 7.2, -20],
    [8, 9.5, -16], [8, 12.4, -11], [6, 14.2, -4], [3, 14.2, -1],
];

export interface Player {
    pos: V3;
    vel: V3;
    yaw: number;
    grounded: boolean;
    integrity: number;
    energy: number;
    alive: boolean;
    deadT: number;
    cooldown: number;
    hurtT: number;
    speed: number;
    aiming: boolean;
    firing: number;
    jumpT: number;
    stepPhase: number;
    darkT: number;
    crouched: boolean;
    /** Seconds into a roll, or -1. */
    rollT: number;
    rollDir: V3;
    rollCool: number;
    /** The biochip's charge 0..100, or -1 before Ray has one. */
    biochip: number;
    /** Riding the lift: input ignored, carried. */
    riding: boolean;
}

/** What a save keeps: where in the mission, what's been taken, which machines were dealt with. */
export interface RunSave {
    v: 2;
    stage: StageId;
    checkpoint: string;
    taken: string[];
    collected: string[];
    flags: string[];
    machines: Record<string, "restored" | "destroyed">;
    resets: number;
    destroyed: number;
    deaths: number;
    time: number;
    usedSim: boolean;
}

export class Game {
    readonly level: Level;
    readonly world: World;
    readonly player: Player;
    readonly enemies: Enemy[];
    readonly bolts: Bolt[] = [];
    readonly orbs: Orb[] = [];
    readonly taken = new Set<string>();
    readonly said = new Set<string>();
    readonly events: GameEvent[] = [];
    /** Collectibles kept on this run. */
    readonly collected = new Set<string>();
    /** Mission facts: biochip, conduit, reactor, surge, lift, warden-half, dead:<conduit>... */
    readonly flags = new Set<string>();
    checkpoint = "lab";
    stage: StageId = "climb";
    stageT = 0;
    time = 0;
    resets = 0;
    destroyed = 0;
    won = false;
    deaths = 0;
    /** The player's chosen lens and whether they've used the simulation one. */
    usedSim = false;
    /** The reactor's spin-up (seconds into the hold-out) and the waves sent so far. */
    holdT = 0;
    waves = 0;
    /** The lift cage's floor height. */
    liftY = LIFT.bottom;
    /** How open each door is, 0..1 (te_level.ts Door), and the solid that moves with it. */
    readonly doorOpen = new Map<string, number>();
    private readonly doorSolid = new Map<string, Solid>();
    /** The lift cage's floor, riding with liftY. */
    readonly liftFloor: Solid = { min: [LIFT.x0 + 0.15, LIFT.bottom - 0.3, LIFT.z0 + 0.25], max: [LIFT.x1 - 0.2, LIFT.bottom, LIFT.z1 - 0.2] };
    private rng = 1;

    constructor(propSize: (p: Prop) => V3 = p => p.collide ?? [0, 0, 0]) {
        this.level = buildLevel();
        addActs(this.level);
        this.world = new World(this.level, propBoxes(this.level, propSize));
        for (const d of this.level.doors) {
            const s: Solid = { min: [...d.min], max: [...d.max] };
            this.doorSolid.set(d.id, s);
            this.doorOpen.set(d.id, 0);
            this.world.dynamic.push(s);
        }
        this.world.dynamic.push(this.liftFloor);
        this.player = {
            pos: [...START.pos], vel: [0, 0, 0], yaw: START.yaw, grounded: true, integrity: 100, energy: 100, alive: true, deadT: 0, cooldown: 0, hurtT: 0, speed: 0,
            aiming: false, firing: 0, jumpT: 0, stepPhase: 0, darkT: 0, crouched: false, rollT: -1, rollDir: [0, 0, 1], rollCool: 0, biochip: -1, riding: false,
        };
        this.enemies = this.level.enemies.map(s => this.makeEnemy(s.id, s.kind, s.pos, s.yaw, s.zone, s.patrol));
    }

    private makeEnemy(id: string, kind: EnemyKind, pos: V3, yaw: number, zone: string, patrol: V3[], spawned = false): Enemy {
        return {
            id, kind, pos: [...pos], yaw, hp: ENEMY[kind].hp, state: "patrol", stateT: 0, patrol, leg: 1, zone,
            cooldown: 1 + this.random() * 1.5, burst: 0, hitFlash: 0, moving: 0, roll: 0, seen: false, vel: [0, 0, 0], charge: 0, leap: null, spawned,
        };
    }

    random(): number { this.rng = (this.rng * 16807) % 2147483647; return (this.rng - 1) / 2147483646; }
    say(id: string): void { if (!this.said.has(id)) { this.said.add(id); this.events.push({ kind: "line", id }); } }

    /** Which part of the mission a point is in. */
    regionOf(p: V3): Region { return regionOf(p); }
    get objective(): string {
        if (this.stage === "holdout") return `Hold the reactor room  -  ${Math.round(Math.min(100, (this.holdT / HOLD_SECONDS) * 100))}% power`;
        return stageOf(this.stage).objective;
    }
    get act(): number { return stageOf(this.stage).act; }
    /** Whether the mission has reached `id` (or gone past it). */
    reached(id: StageId): boolean { return stageIndex(this.stage) >= stageIndex(id); }
    /** Ray's current height: standing, crouched or rolling. */
    get height(): number { const p = this.player; return p.rollT >= 0 ? PLAYER.rollHeight : p.crouched ? PLAYER.crouchHeight : PLAYER.height; }
    /** Nothing hits Ray in the middle of a roll. */
    get dodging(): boolean { const t = this.player.rollT; return t >= ROLL.safeFrom && t <= ROLL.safeTo; }
    door(id: string): Solid | undefined { return this.doorSolid.get(id); }

    step(dt: number, input: PlayerInput): void {
        this.time += dt;
        this.stageT += dt;
        this.updatePlayer(dt, input);
        for (const e of this.enemies) this.updateEnemy(e, dt);
        this.updateOrbs(dt);
        this.updateDoors(dt);
        for (const b of this.bolts) b.age += dt;
        for (let i = this.bolts.length - 1; i >= 0; i--) if (this.bolts[i].age > 0.25) this.bolts.splice(i, 1);
        this.mission(dt);
    }

    // --- Ray -----------------------------------------------------------------------------------------

    private updatePlayer(dt: number, input: PlayerInput): void {
        const p = this.player;
        p.cooldown = Math.max(0, p.cooldown - dt);
        p.hurtT = Math.max(0, p.hurtT - dt);
        p.firing = Math.max(0, p.firing - dt);
        p.rollCool = Math.max(0, p.rollCool - dt);
        if (!p.alive) {
            p.deadT += dt;
            if (p.deadT > 3.2) this.respawn();
            return;
        }
        if (p.riding) { this.ride(dt); return; }
        const rolling = p.rollT >= 0;
        p.aiming = !rolling && (input.aim || input.fire);
        // Movement relative to the camera.
        const fx = Math.sin(input.yaw), fz = Math.cos(input.yaw);
        const rx = -fz, rz = fx;
        let mx = rx * input.move[0] + fx * input.move[1], mz = rz * input.move[0] + fz * input.move[1];
        const ml = Math.hypot(mx, mz);
        if (ml > 1) { mx /= ml; mz /= ml; }

        // Crouch: wanted, or kept down by a low ceiling. Running or jumping stands Ray up if there's room.
        const roomToStand = !this.world.blocked(p.pos[0], p.pos[2], PLAYER.radius, p.pos[1] + PLAYER.crouchHeight - 0.05, p.pos[1] + PLAYER.height);
        if (!rolling) p.crouched = (input.crouch && !input.run && !input.jump) || !roomToStand;

        // Roll: a burst along the stick (backward with none), safe for its middle, ending crouched if wanted.
        if (input.dodge && !rolling && p.grounded && p.rollCool <= 0) {
            const dir: V3 = ml > 0.2 ? [mx / Math.hypot(mx, mz), 0, mz / Math.hypot(mx, mz)] : [-fx, 0, -fz];
            p.rollT = 0; p.rollDir = dir; p.yaw = Math.atan2(dir[0], dir[2]);
            this.events.push({ kind: "roll" });
        }
        if (p.rollT >= 0) {
            p.rollT += dt;
            const k = 1 - (p.rollT / ROLL.seconds) * 0.45;
            p.vel[0] = p.rollDir[0] * ROLL.speed * k; p.vel[2] = p.rollDir[2] * ROLL.speed * k;
            if (p.rollT >= ROLL.seconds) {
                p.rollT = -1; p.rollCool = ROLL.cooldown;
                p.crouched = input.crouch || !roomToStand;
            }
        } else {
            const speed = p.crouched ? (p.aiming ? PLAYER.crouch * 0.85 : PLAYER.crouch) : p.aiming ? PLAYER.aimWalk : input.run ? PLAYER.run : PLAYER.walk;
            const accel = p.grounded ? 14 : 3;
            p.vel[0] += (mx * speed - p.vel[0]) * Math.min(1, accel * dt);
            p.vel[2] += (mz * speed - p.vel[2]) * Math.min(1, accel * dt);
            if (input.jump && p.grounded && !p.crouched) { p.vel[1] = PLAYER.jump; p.grounded = false; p.jumpT = 0; }
            // Facing: toward the aim while aiming, else toward the movement.
            const want = p.aiming ? input.yaw : ml > 0.1 ? Math.atan2(mx, mz) : p.yaw;
            let d = want - p.yaw;
            d = Math.atan2(Math.sin(d), Math.cos(d));
            p.yaw += d * Math.min(1, (p.aiming ? 18 : 10) * dt);
        }
        p.vel[1] -= PLAYER.gravity * dt;
        p.jumpT += dt;

        // Horizontal move, walls, then the ground.
        let x = p.pos[0] + p.vel[0] * dt, z = p.pos[2] + p.vel[2] * dt;
        [x, z] = this.world.pushOut(x, z, p.pos[1], this.height, PLAYER.radius, p.pos[1] + PLAYER.step);
        let y = p.pos[1] + p.vel[1] * dt;
        // The highest top no higher than a step above the feet: stairs are stepped up, walls are not.
        const ground = this.world.groundAt(x, z, PLAYER.radius, p.pos[1] + PLAYER.step);
        if (p.vel[1] <= 0 && y <= ground) { y = ground; p.vel[1] = 0; p.grounded = true; }
        // Walking down steps and slopes: stay on the ground rather than hop off each tread.
        else if (p.grounded && p.vel[1] <= 0 && p.pos[1] - ground < 0.55) { y = ground; p.vel[1] = 0; }
        else p.grounded = false;
        p.pos = [x, y, z];
        p.speed = Math.hypot(p.vel[0], p.vel[2]);
        if (p.grounded && p.speed > 0.5 && p.rollT < 0) {
            const before = p.stepPhase;
            p.stepPhase += dt * p.speed * (p.crouched ? 1.2 : 0.9);
            if (Math.floor(before) !== Math.floor(p.stepPhase)) this.events.push({ kind: "step", at: [...p.pos] });
        }
        // Fell off: the city is a long way down (and before the descent, the floors below are out of bounds).
        if (p.pos[1] < this.killY()) { this.kill(); return; }

        // Dark zones: the biochip thinks through them while it lasts.
        let inDark = false;
        for (const z of this.level.darkZones) {
            if (Math.hypot(p.pos[0] - z.center[0], p.pos[1] - z.center[1], p.pos[2] - z.center[2]) < z.radius) inDark = true;
        }
        const shielded = inDark && p.biochip > 0;
        p.darkT = inDark ? Math.min(shielded ? 0.35 : 1, p.darkT + dt * 2) : Math.max(0, p.darkT - dt * 1.5);
        if (inDark) {
            if (shielded) { p.biochip = Math.max(0, p.biochip - BIOCHIP.drain * dt); if (regionOf(p.pos) === "relay7") this.say("darkCorridor"); }
            else { this.damagePlayer(DARK_DAMAGE * dt, false); this.say("inDark"); }
        } else if (p.biochip >= 0) p.biochip = Math.min(100, p.biochip + BIOCHIP.regen * dt);

        // The rifle regains charge from its nuclear cell.
        if (p.cooldown <= 0) p.energy = Math.min(100, p.energy + RIFLE.regen * dt);
        if (input.fire && !rolling && p.cooldown <= 0 && p.energy >= RIFLE.cost) this.fire(input);

        // Use: Reset the knocked-out machine in reach, else work the thing in reach.
        if (input.use) {
            const e = this.resettable();
            if (e) this.reset(e);
            else { const u = this.usable(); if (u) this.use(u); }
        }
        // Nuclear cells.
        for (const c of this.level.pickups) {
            if (this.taken.has(c.id)) continue;
            if (Math.hypot(c.pos[0] - p.pos[0], c.pos[1] - p.pos[1], c.pos[2] - p.pos[2]) < 1.3) {
                this.taken.add(c.id);
                p.integrity = Math.min(100, p.integrity + 35);
                p.energy = Math.min(100, p.energy + 60);
                this.events.push({ kind: "pickup", id: c.id });
            }
        }
        // Checkpoints.
        for (const c of this.level.checkpoints) {
            if (c.id === this.checkpoint) continue;
            const order = this.level.checkpoints.findIndex(k => k.id === c.id), now = this.level.checkpoints.findIndex(k => k.id === this.checkpoint);
            if (order > now && Math.hypot(c.pos[0] - p.pos[0], c.pos[1] - p.pos[1], c.pos[2] - p.pos[2]) < c.radius) {
                this.checkpoint = c.id;
                this.events.push({ kind: "checkpoint", id: c.id });
            }
        }
        // The hypercube: asleep the first time Ray reaches it, the end of the mission once it wakes.
        if (Math.hypot(p.pos[0] - PEDESTAL[0], p.pos[2] - PEDESTAL[2]) < GOAL_RADIUS && p.pos[1] > PEDESTAL[1] - 0.5) {
            if (this.stage === "hypercube") { this.events.push({ kind: "dormant" }); this.setStage("bridge"); }
            else if (this.stage === "awaken" && !this.won) { this.won = true; this.events.push({ kind: "goal" }); }
        }
    }

    /** Falling below this kills (the floors below are out of bounds until the mission goes down there). */
    killY(): number {
        if (this.reached("ride")) return 9;
        if (this.reached("descent")) return -32;
        return -6;
    }

    /** The knocked-out machine within reach (nearest), if any. */
    resettable(): Enemy | null {
        const p = this.player;
        let best: Enemy | null = null, bd = RESET_REACH;
        for (const e of this.enemies) {
            if (e.state !== "stunned") continue;
            const d = Math.hypot(e.pos[0] - p.pos[0], e.pos[1] - p.pos[1], e.pos[2] - p.pos[2]);
            if (d < bd + (e.kind === "warden" ? 1 : 0)) { bd = d; best = e; }
        }
        return best;
    }

    private reset(e: Enemy): void {
        e.state = "restored"; e.stateT = 0; e.hitFlash = 0;
        this.resets++;
        this.events.push({ kind: "reset", id: e.id, at: [...e.pos] });
        if (this.resets === 1) this.say("firstReset");
        if (e.kind === "warden") this.say("wardenReset");
    }

    /** Whether a spot can be worked now (the mission decides). */
    usableNow(u: UseSpot): boolean {
        switch (u.kind) {
            case "biochip": return !this.flags.has("biochip");
            case "conduit": return this.reached("biochip") && !this.flags.has("conduit") && !this.flags.has(`dead:${u.id}`);
            case "console": return this.stage === "reactor";
            case "lift": return this.stage === "lift";
        }
    }
    /** The spot within reach that can be worked, if any. */
    usable(): UseSpot | null {
        const p = this.player;
        let best: UseSpot | null = null, bd = USE_REACH;
        for (const u of this.level.uses) {
            if (!this.usableNow(u)) continue;
            const d = Math.hypot(u.pos[0] - p.pos[0], u.pos[2] - p.pos[2]);
            if (d < bd && Math.abs(u.pos[1] - p.pos[1]) < 1.6) { bd = d; best = u; }
        }
        return best;
    }
    private use(u: UseSpot): void {
        const p = this.player;
        switch (u.kind) {
            case "biochip":
                this.flags.add("biochip"); p.biochip = 100;
                this.events.push({ kind: "use", id: u.id, ok: true });
                break;
            case "conduit":
                if (u.id === LIVE_CONDUIT) {
                    this.flags.add("conduit");
                    this.events.push({ kind: "use", id: u.id, ok: true });
                } else {
                    this.flags.add(`dead:${u.id}`);
                    this.events.push({ kind: "use", id: u.id, ok: false });
                    this.events.push({ kind: "burst", at: [u.pos[0] + 0.8, u.pos[1] + 1.3, u.pos[2]] });
                    this.damagePlayer(12);
                    this.say("deadLine");
                }
                break;
            case "console":
                this.flags.add("reactor");
                this.events.push({ kind: "use", id: u.id, ok: true });
                break;
            case "lift":
                this.flags.add("lift");
                this.events.push({ kind: "use", id: u.id, ok: true });
                break;
        }
    }

    /** The collectible Ray is looking at, near enough to pick up (from the camera's eye and look direction). */
    lookItem(eye: V3, dir: V3): ItemSpot | null {
        const p = this.player;
        let best: ItemSpot | null = null, bs = 0.965;
        for (const it of this.level.items) {
            if (this.collected.has(it.id)) continue;
            const c: V3 = [it.pos[0], it.pos[1] + 0.06, it.pos[2]];
            if (Math.hypot(c[0] - p.pos[0], c[2] - p.pos[2]) > 2.6 || Math.abs(c[1] - p.pos[1] - 0.8) > 1.6) continue;
            const d: V3 = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]], l = Math.hypot(...d);
            const cos = (d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2]) / l;
            if (cos <= bs) continue;
            if (this.world.raycast(eye, [d[0] / l, d[1] / l, d[2] / l], l).t < l - 0.25) continue;
            bs = cos; best = it;
        }
        return best;
    }
    collect(id: string): void {
        if (this.collected.has(id)) return;
        this.collected.add(id);
        this.events.push({ kind: "collect", id });
        if (this.collected.size === 1) this.say("firstItem");
    }

    /** The muzzle: in front of Ray's right shoulder (lower when crouched). */
    muzzle(): V3 {
        const p = this.player;
        const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
        return [p.pos[0] + fx * 0.75 - fz * 0.22, p.pos[1] + this.height * 0.77, p.pos[2] + fz * 0.75 + fx * 0.22];
    }

    private fire(input: PlayerInput): void {
        const p = this.player;
        p.cooldown = RIFLE.interval;
        p.energy -= RIFLE.cost;
        p.firing = 0.25;
        const from = this.muzzle();
        let dir: V3;
        if (input.target) {
            dir = [input.target[0] - from[0], input.target[1] - from[1], input.target[2] - from[2]];
        } else {
            dir = [Math.sin(input.yaw) * Math.cos(input.pitch), Math.sin(input.pitch), Math.cos(input.yaw) * Math.cos(input.pitch)];
        }
        const l = Math.hypot(...dir) || 1;
        dir = [dir[0] / l, dir[1] / l, dir[2] / l];
        const hit = this.trace(from, dir, RIFLE.range, null);
        const to: V3 = [from[0] + dir[0] * hit.t, from[1] + dir[1] * hit.t, from[2] + dir[2] * hit.t];
        this.bolts.push({ from, to, age: 0, enemy: false, hit: hit.t < RIFLE.range });
        this.events.push({ kind: "shot", at: from, enemy: false });
        if (hit.enemy) this.damageEnemy(hit.enemy, RIFLE.damage, to, dir);
        else if (hit.t < RIFLE.range) this.events.push({ kind: "hit", at: to, target: "world" });
    }

    /** Distance to the first wall or machine on a ray (skipping `skip`). */
    trace(o: V3, d: V3, maxT: number, skip: Enemy | null): { t: number; enemy: Enemy | null } {
        let t = this.world.raycast(o, d, maxT).t;
        let enemy: Enemy | null = null;
        for (const e of this.enemies) {
            if (e === skip || e.state === "destroyed") continue;
            const s = ENEMY[e.kind];
            // A capsule as a sphere stack: test the segment's closest approach to the body's axis.
            const cy0 = e.pos[1] + s.radius * 0.6, cy1 = e.pos[1] + s.height - s.radius * 0.6;
            for (const cy of [cy0, (cy0 + cy1) / 2, cy1]) {
                const ox = e.pos[0] - o[0], oy = cy - o[1], oz = e.pos[2] - o[2];
                const along = ox * d[0] + oy * d[1] + oz * d[2];
                if (along < 0 || along > t) continue;
                const px = ox - d[0] * along, py = oy - d[1] * along, pz = oz - d[2] * along;
                if (px * px + py * py + pz * pz < s.radius * s.radius * 1.2) { t = along; enemy = e; }
            }
        }
        return { t, enemy };
    }

    /** Whether a shot travelling along `dir` meets the Warden's shield (its front, unless it's charging). */
    shielded(e: Enemy, dir: V3): boolean {
        if (e.kind !== "warden" || e.state !== "fight" && e.state !== "alert" || e.charge > 0) return false;
        const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
        const l = Math.hypot(dir[0], dir[2]) || 1;
        return -(dir[0] * fx + dir[2] * fz) / l > Math.cos(1);
    }

    private damageEnemy(e: Enemy, amount: number, at: V3, dir: V3 = [0, 0, 1]): void {
        if (this.shielded(e, dir)) { this.events.push({ kind: "hit", at, target: "shield" }); amount *= 0.12; }
        else { e.hitFlash = 1; this.events.push({ kind: "hit", at, target: e.id }); }
        if (e.state === "restored") return;
        if (e.state === "stunned") {
            // Shooting a knocked-out machine destroys it: the other reward path.
            e.hp -= amount;
            if (e.hp <= (e.kind === "warden" ? -120 : -40)) {
                e.state = "destroyed"; e.stateT = 0;
                this.destroyed++;
                this.events.push({ kind: "destroyed", id: e.id, at: [...e.pos] });
                if (this.destroyed === 1) this.say("firstDestroy");
                if (e.kind === "warden") this.say("wardenDestroyed");
            }
            return;
        }
        e.hp -= amount;
        e.seen = true;
        if (e.state === "patrol") { e.state = "fight"; e.stateT = 0; }
        if (e.kind === "warden" && e.hp < ENEMY.warden.hp * 0.5 && !this.flags.has("warden-half")) {
            this.flags.add("warden-half");
            this.say("wardenHalf");
            for (const [i, pos] of ([[12, 14, 8], [11, 14, -8]] as V3[]).entries()) this.spawn(`warden-roller-${i}`, "roller", pos, "spire2");
        }
        if (e.hp <= 0) {
            e.state = "stunned"; e.stateT = 0; e.hp = 0; e.charge = 0; e.leap = null;
            this.events.push({ kind: "disabled", id: e.id, at: [...e.pos] });
            if (e.kind === "warden") this.say("wardenDown");
        }
    }

    damagePlayer(amount: number, flash = true): void {
        const p = this.player;
        if (!p.alive || this.won) return;
        p.integrity -= amount;
        if (flash) { p.hurtT = 0.35; this.events.push({ kind: "hurt", amount }); }
        if (p.integrity <= 0) this.kill();
    }

    private kill(): void {
        const p = this.player;
        if (!p.alive) return;
        p.alive = false; p.deadT = 0; p.integrity = 0; p.rollT = -1;
        this.deaths++;
        this.events.push({ kind: "died" });
    }

    respawn(): void {
        const c = this.level.checkpoints.find(k => k.id === this.checkpoint) ?? this.level.checkpoints[0];
        const p = this.player;
        p.pos = [...c.pos]; p.vel = [0, 0, 0]; p.yaw = c.yaw; p.alive = true; p.deadT = 0; p.integrity = 100; p.energy = Math.max(p.energy, 60); p.grounded = true; p.darkT = 0;
        p.rollT = -1; p.crouched = false;
        if (p.biochip >= 0) p.biochip = 100;
        // A lost hold-out starts over: the reactor drops back to idle and the waves go.
        if (this.stage === "holdout") {
            for (let i = this.enemies.length - 1; i >= 0; i--) if (this.enemies[i].spawned && this.enemies[i].zone === "reactor") this.enemies.splice(i, 1);
            this.flags.delete("reactor");
            this.holdT = 0; this.waves = 0;
            this.setStage("reactor");
            this.said.delete("holdFailed"); this.say("holdFailed");
        }
        this.events.push({ kind: "respawn" });
    }

    // --- The machines --------------------------------------------------------------------------------

    /** Adds a machine during play (the reactor's waves, the Warden and its call), already hunting. */
    spawn(id: string, kind: EnemyKind, pos: V3, zone: string): Enemy {
        const e = this.makeEnemy(id, kind, pos, 0, zone, [pos], true);
        e.state = "alert"; e.seen = true; e.cooldown = 0.8 + this.random();
        const p = this.player.pos;
        e.yaw = Math.atan2(p[0] - pos[0], p[2] - pos[2]);
        this.enemies.push(e);
        this.events.push({ kind: "spawn", id, at: [...pos] });
        return e;
    }

    /** The point of Ray an enemy aims at and looks for (lower when crouched). */
    private chest(): V3 { const p = this.player; return [p.pos[0], p.pos[1] + this.height * 0.6, p.pos[2]]; }

    private canSee(e: Enemy, range: number): boolean {
        const p = this.player;
        const eye: V3 = [e.pos[0], e.pos[1] + ENEMY[e.kind].height * 0.8, e.pos[2]];
        const c = this.chest();
        const to: V3 = [c[0] - eye[0], c[1] + this.height * 0.2 - eye[1], c[2] - eye[2]];
        const d = Math.hypot(...to);
        if (d > range || !p.alive) return false;
        return this.world.raycast(eye, [to[0] / d, to[1] / d, to[2] / d], d).t >= d - 0.3;
    }

    private updateEnemy(e: Enemy, dt: number): void {
        const s = ENEMY[e.kind];
        e.stateT += dt;
        e.hitFlash = Math.max(0, e.hitFlash - dt * 5);
        e.cooldown -= dt;
        const p = this.player;
        if (e.leap) { this.updateLeap(e, dt); return; }
        let goal: V3 | null = null, speed = 0;
        // Crouched and still, Ray is harder to spot.
        const sightK = p.crouched && p.speed < 1 ? 0.65 : 1;
        switch (e.state) {
            case "patrol": {
                goal = e.patrol[e.leg % e.patrol.length];
                speed = s.speed * 0.55;
                if (Math.hypot(goal[0] - e.pos[0], goal[2] - e.pos[2]) < 0.6) e.leg++;
                const near = Math.hypot(p.pos[0] - e.pos[0], p.pos[1] - e.pos[1], p.pos[2] - e.pos[2]) < 14;
                if ((regionOf(p.pos) === e.zone || near) && this.canSee(e, s.sight * sightK)) {
                    e.state = "alert"; e.stateT = 0; e.seen = true;
                    if (e.kind === "roller") this.say("firstEnemy");
                }
                break;
            }
            case "alert": {
                // A beat to turn and acquire.
                this.face(e, p.pos, dt, 6);
                if (e.stateT > 0.6) { e.state = "fight"; e.stateT = 0; e.cooldown = Math.min(e.cooldown, 0.4); }
                break;
            }
            case "fight": {
                const d = Math.hypot(p.pos[0] - e.pos[0], p.pos[2] - e.pos[2]);
                const sees = this.canSee(e, s.sight * 1.3);
                this.face(e, p.pos, dt, e.kind === "warden" ? 2.5 : e.kind === "crawler" ? 8 : 5);
                if (e.kind === "crawler") {
                    // Run in, crouch (the tell), then pounce at where Ray stood.
                    if (e.charge > 0 || (sees && d < s.range && e.cooldown <= 0 && p.alive)) {
                        if (e.charge === 0) this.events.push({ kind: "charge", id: e.id, at: [...e.pos] });
                        e.charge += dt;
                        if (e.charge >= ENEMY.crawler.windup) this.pounce(e);
                    } else if (d > 1.6) { goal = p.pos; speed = s.speed; }
                } else {
                    if (d > s.range * 0.7 || !sees) { goal = p.pos; speed = s.speed; }
                    else if (e.kind === "roller") {
                        // Rollers circle at range.
                        const a = Math.atan2(e.pos[0] - p.pos[0], e.pos[2] - p.pos[2]) + 0.6;
                        goal = [p.pos[0] + Math.sin(a) * s.range * 0.55, e.pos[1], p.pos[2] + Math.cos(a) * s.range * 0.55];
                        speed = s.speed * 0.8;
                    } else if (e.kind === "warden" && d < 9) {
                        // Too close: it backs off to cannon range, turning its shield to Ray.
                        const a = Math.atan2(e.pos[0] - p.pos[0], e.pos[2] - p.pos[2]);
                        goal = [p.pos[0] + Math.sin(a) * 12, e.pos[1], p.pos[2] + Math.cos(a) * 12];
                        speed = s.speed * 0.8;
                    }
                    // Wind up (the glow every machine shows before it fires), then shoot.
                    if (e.charge > 0 || (sees && e.cooldown <= 0 && p.alive)) {
                        const fresh = e.kind === "hacked_bot" ? e.burst === 0 : true;
                        if (fresh && e.charge < s.windup) {
                            if (e.charge === 0) { this.events.push({ kind: "charge", id: e.id, at: this.enemyMuzzle(e) }); this.say("firstCharge"); }
                            e.charge += dt;
                            if (e.kind === "warden") speed = 0;
                        } else {
                            e.charge = 0;
                            if (e.kind === "warden") this.volley(e); else this.enemyFire(e);
                        }
                    }
                }
                if (!p.alive || regionOf(p.pos) !== e.zone && !sees && e.stateT > 6 && e.kind !== "warden") { e.state = "patrol"; e.stateT = 0; e.charge = 0; }
                break;
            }
            case "stunned": {
                if (e.stateT > (e.kind === "warden" ? WARDEN_STUN : STUN_TIME)) { e.state = "fight"; e.stateT = 0; e.hp = s.hp * 0.4; this.events.push({ kind: "rebooted", id: e.id }); }
                break;
            }
            default: break;
        }
        // Move toward the goal, never off a floor's edge.
        e.moving += ((goal && speed > 0 ? 1 : 0) - e.moving) * Math.min(1, dt * 6);
        if (goal && speed > 0) {
            const dx = goal[0] - e.pos[0], dz = goal[2] - e.pos[2], dl = Math.hypot(dx, dz);
            if (dl > 0.2) {
                if (e.state === "patrol") this.face(e, goal, dt, 4);
                const vx = (dx / dl) * speed, vz = (dz / dl) * speed;
                let nx = e.pos[0] + vx * dt, nz = e.pos[2] + vz * dt;
                [nx, nz] = this.world.pushOut(nx, nz, e.pos[1], s.height, s.radius, e.pos[1] + 0.35);
                const g = this.world.groundAt(nx, nz, s.radius, e.pos[1] + 0.35);
                if (g > e.pos[1] - 0.4) { e.pos = [nx, g, nz]; e.roll += (Math.hypot(vx, vz) * dt) / 0.5; }
                else if (e.state === "patrol") e.leg++;
            }
        }
    }

    /** A crawler leaps at where Ray is (a little past), unless there's no floor to land on. */
    private pounce(e: Enemy): void {
        const p = this.player;
        e.charge = 0; e.cooldown = ENEMY.crawler.interval;
        const dx = p.pos[0] - e.pos[0], dz = p.pos[2] - e.pos[2], dl = Math.hypot(dx, dz) || 1;
        const reach = Math.min(dl + 0.8, ENEMY.crawler.range + 1);
        const to: V3 = [e.pos[0] + (dx / dl) * reach, e.pos[1], e.pos[2] + (dz / dl) * reach];
        const g = this.world.groundAt(to[0], to[2], 0.3, Math.max(e.pos[1], p.pos[1]) + 0.6);
        if (!(g > Math.min(e.pos[1], p.pos[1]) - 1.2)) return;
        to[1] = g;
        e.leap = { from: [...e.pos], to, t: 0, dur: ENEMY.crawler.leap, arc: 1.1 };
        this.events.push({ kind: "pounce", id: e.id, at: [...e.pos] });
    }

    private updateLeap(e: Enemy, dt: number): void {
        const L = e.leap!;
        L.t += dt;
        const k = Math.min(1, L.t / L.dur);
        e.pos = [L.from[0] + (L.to[0] - L.from[0]) * k, L.from[1] + (L.to[1] - L.from[1]) * k + Math.sin(k * Math.PI) * L.arc, L.from[2] + (L.to[2] - L.from[2]) * k];
        e.moving = 1;
        if (k < 1) return;
        e.leap = null;
        if (e.kind === "warden") { this.events.push({ kind: "burst", at: [...e.pos] }); e.state = "alert"; e.stateT = 0; this.say("warden"); return; }
        // Landing: whatever is right there gets the claws (unless it's mid-roll).
        const p = this.player;
        const d = Math.hypot(p.pos[0] - e.pos[0], p.pos[1] - e.pos[1], p.pos[2] - e.pos[2]);
        if (d < 1.5 && p.alive && !this.dodging) {
            this.damagePlayer(ENEMY.crawler.damage);
            const l = Math.hypot(p.pos[0] - e.pos[0], p.pos[2] - e.pos[2]) || 1;
            p.vel[0] += ((p.pos[0] - e.pos[0]) / l) * 4; p.vel[2] += ((p.pos[2] - e.pos[2]) / l) * 4;
        }
    }

    private face(e: Enemy, at: V3, dt: number, rate: number): void {
        const want = Math.atan2(at[0] - e.pos[0], at[2] - e.pos[2]);
        let d = want - e.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        e.yaw += d * Math.min(1, rate * dt);
    }

    /** Where an enemy's shots leave from. */
    enemyMuzzle(e: Enemy): V3 {
        const fx = Math.sin(e.yaw), fz = Math.cos(e.yaw);
        if (e.kind === "roller") return [e.pos[0] + fx * 0.6, e.pos[1] + 0.55, e.pos[2] + fz * 0.6];
        if (e.kind === "crawler") return [e.pos[0] + fx * 0.7, e.pos[1] + 0.6, e.pos[2] + fz * 0.7];
        if (e.kind === "warden") return [e.pos[0] + fx * 1.0 - fz * 0.75, e.pos[1] + 1.9, e.pos[2] + fz * 1.0 + fx * 0.75];
        return [e.pos[0] + fx * 0.35, e.pos[1] + 1.95, e.pos[2] + fz * 0.35];
    }

    private enemyFire(e: Enemy): void {
        const s = ENEMY[e.kind];
        if (e.kind === "hacked_bot") {
            const b = s as typeof ENEMY.hacked_bot;
            e.burst++;
            e.cooldown = e.burst >= b.burst ? b.rest : b.interval;
            if (e.burst >= b.burst) e.burst = 0;
        } else e.cooldown = s.interval + this.random() * 0.4;
        const p = this.player;
        const from = this.enemyMuzzle(e);
        const c = this.chest();
        const aim: V3 = [c[0] - from[0], c[1] - from[1], c[2] - from[2]];
        const dist = Math.hypot(...aim);
        const spread = s.spread * (1 + (p.speed > 3 ? 0.8 : 0)) * (p.crouched ? 1.3 : 1) + dist * 0.002;
        const dir: V3 = [aim[0] / dist + (this.random() - 0.5) * spread * 2, aim[1] / dist + (this.random() - 0.5) * spread, aim[2] / dist + (this.random() - 0.5) * spread * 2];
        const l = Math.hypot(...dir);
        const d: V3 = [dir[0] / l, dir[1] / l, dir[2] / l];
        const wall = this.world.raycast(from, d, 80).t;
        // Did it pass within the player's body (a capsule as tall as Ray is now)?
        const h = this.height;
        const ox = p.pos[0] - from[0], oy = p.pos[1] + h * 0.55 - from[1], oz = p.pos[2] - from[2];
        const along = ox * d[0] + oy * d[1] + oz * d[2];
        const miss = Math.hypot(ox - d[0] * along, (oy - d[1] * along) * (0.9 / h), oz - d[2] * along);
        const hits = along > 0 && along < wall && miss < 0.45 && !this.dodging;
        const t = hits ? along : Math.min(wall, 80);
        this.bolts.push({ from, to: [from[0] + d[0] * t, from[1] + d[1] * t, from[2] + d[2] * t], age: 0, enemy: true, hit: true });
        this.events.push({ kind: "shot", at: from, enemy: true });
        if (hits) this.damagePlayer(s.damage);
    }

    /** The Warden's cannon: three slow orbs, fanned, at where Ray is heading. */
    private volley(e: Enemy): void {
        e.cooldown = ENEMY.warden.interval + this.random() * 0.6;
        const p = this.player;
        const from = this.enemyMuzzle(e);
        const c = this.chest();
        const lead: V3 = [c[0] + p.vel[0] * 0.5, c[1], c[2] + p.vel[2] * 0.5];
        const base = Math.atan2(lead[0] - from[0], lead[2] - from[2]);
        const flat = Math.hypot(lead[0] - from[0], lead[2] - from[2]);
        const pitch = Math.atan2(lead[1] - from[1], flat);
        for (const off of [-0.16, 0, 0.16]) {
            const a = base + off;
            this.orbs.push({ pos: [...from], vel: [Math.sin(a) * Math.cos(pitch) * ORB.speed, Math.sin(pitch) * ORB.speed, Math.cos(a) * Math.cos(pitch) * ORB.speed], age: 0 });
        }
        this.events.push({ kind: "shot", at: from, enemy: true });
    }

    private updateOrbs(dt: number): void {
        const p = this.player, c = this.chest();
        for (let i = this.orbs.length - 1; i >= 0; i--) {
            const o = this.orbs[i];
            o.age += dt;
            const step = Math.hypot(...o.vel) * dt;
            const dir: V3 = [o.vel[0] / ORB.speed, o.vel[1] / ORB.speed, o.vel[2] / ORB.speed];
            const wall = this.world.raycast(o.pos, dir, step).t;
            o.pos = [o.pos[0] + o.vel[0] * dt, o.pos[1] + o.vel[1] * dt, o.pos[2] + o.vel[2] * dt];
            const near = Math.hypot(o.pos[0] - c[0], o.pos[1] - c[1], o.pos[2] - c[2]) < 0.75 && !this.dodging;
            if (Number.isFinite(wall) || near || o.age > ORB.life) {
                this.orbs.splice(i, 1);
                this.events.push({ kind: "orb", at: [...o.pos] });
                const d = Math.hypot(o.pos[0] - c[0], o.pos[1] - c[1], o.pos[2] - c[2]);
                if (d < ORB.radius && !this.dodging && p.alive) this.damagePlayer(ORB.damage * (1 - (d / ORB.radius) * 0.6));
            }
        }
    }

    // --- Doors, the lift and the mission -------------------------------------------------------------------

    openDoor(id: string): void { if (!this.flags.has(`open:${id}`)) { this.flags.add(`open:${id}`); this.events.push({ kind: "door", id }); } }

    private updateDoors(dt: number): void {
        for (const d of this.level.doors) {
            const want = this.flags.has(`open:${d.id}`) ? 1 : 0;
            let k = this.doorOpen.get(d.id) ?? 0;
            k += Math.sign(want - k) * Math.min(Math.abs(want - k), dt * 0.7);
            this.doorOpen.set(d.id, k);
            // Slides up into the wall above it.
            const s = this.doorSolid.get(d.id)!, lift = (d.max[1] - d.min[1]) * k * 0.98;
            s.min[1] = d.min[1] + lift; s.max[1] = d.max[1] + lift;
        }
    }

    private ride(dt: number): void {
        const p = this.player;
        this.liftY = Math.min(LIFT.top, this.liftY + dt * 2.2);
        this.liftFloor.min[1] = this.liftY - 0.3; this.liftFloor.max[1] = this.liftY;
        p.pos = [p.pos[0], this.liftY, p.pos[2]];
        p.vel = [0, 0, 0]; p.speed = 0; p.grounded = true; p.aiming = false;
        if (this.liftY >= LIFT.top) {
            p.riding = false;
            this.openDoor("lift-top");
            const w = this.spawn("warden", "warden", [WARDEN_DROP[0], WARDEN_DROP[1] + 22, WARDEN_DROP[2]], "spire2");
            w.leap = { from: [...w.pos], to: [...WARDEN_DROP], t: 0, dur: 1.1, arc: 0 };
            this.setStage("warden");
        }
    }

    setStage(id: StageId): void {
        if (this.stage === id) return;
        const newAct = stageOf(id).act !== stageOf(this.stage).act;
        this.stage = id; this.stageT = 0;
        this.events.push({ kind: "stage", id, act: stageOf(id).act, newAct });
    }

    /** The story's beats and the mission's stages: what Ray has done moves it on. */
    private mission(dt: number): void {
        const p = this.player;
        const r = regionOf(p.pos);
        // Lines along the way.
        if (r === "spire0" && (p.pos[0] > -7.5 || p.pos[2] > -9.5)) this.say("leftLab");
        if (r === "spire1") this.say("secondFloor");
        if (r === "spire1" && p.pos[2] > 9 && p.pos[0] > -2) this.say("lensHint");
        if (r === "spire1" && p.pos[2] < -14 && p.pos[0] > 3) this.say("ramp");
        if (r === "spire2" && !this.reached("bridge")) this.say("atrium");
        if (r === "bridge") this.say("bridge");
        if (r === "bridge" && p.pos[0] > 34) this.say("girder");
        if (r === "relay14") this.say("relay");
        if (r === "relay14" && p.pos[0] > 101 && p.pos[0] < 104) this.say("chasm");
        if (r === "relay14" && p.pos[0] > 104 && p.pos[0] < 112) this.say("simPath");
        if (r === "relay14" && p.pos[0] > 114 && p.pos[2] > 6) this.say("vault");
        if (r === "relay7" && this.reached("conduit")) this.say("archive");
        if (r === "relay7" && p.pos[0] > 118 && p.pos[2] < -8) this.say("breakers");
        if (r === "shaft" && p.pos[1] < 5) this.say("shaft");
        if (r === "lowbridge") this.say("lowBridge");

        switch (this.stage) {
            case "climb": if (r === "spire1" || r === "spire2") this.setStage("dark"); break;
            case "dark": if (r === "spire2") this.setStage("hypercube"); break;
            case "hypercube": break; // reaching it (updatePlayer) opens the rest of the mission
            case "bridge": if (r === "relay14") this.setStage("biochip"); break;
            case "biochip": if (this.flags.has("biochip")) { this.say("gotBiochip"); this.setStage("conduit"); } break;
            case "conduit": if (this.flags.has("conduit")) { this.say("conduitDone"); this.openDoor("relay-stairs"); this.setStage("descent"); } break;
            case "descent": if (r === "lowbridge" || r === "reactor") this.setStage("crossing"); break;
            case "crossing": if (r === "reactor") { this.say("reactorFloor"); this.setStage("reactor"); } break;
            case "reactor": if (this.flags.has("reactor")) { this.said.delete("reactorStart"); this.say("reactorStart"); this.holdT = 0; this.waves = 0; this.setStage("holdout"); } break;
            case "holdout": {
                this.holdT += dt;
                while (this.waves < WAVE_TIMES.length && this.holdT >= WAVE_TIMES[this.waves]) {
                    const n = this.waves++;
                    WAVE_SPAWNS[n].forEach((w, i) => this.spawn(`wave${n}-${i}-${Math.round(this.time * 10)}`, w.kind, w.pos, "reactor"));
                    this.events.push({ kind: "wave", n });
                    if (n === 2) this.say("holdHalf");
                }
                if (this.holdT >= HOLD_SECONDS) {
                    // The surge: every hacked machine on the spire's grid drops where it stands.
                    for (const e of this.enemies) if ((e.state === "fight" || e.state === "alert" || e.state === "patrol") && e.zone === "reactor") { e.state = "stunned"; e.stateT = -20; e.hp = 0; e.charge = 0; e.leap = null; this.events.push({ kind: "disabled", id: e.id, at: [...e.pos] }); }
                    this.flags.add("surge");
                    this.events.push({ kind: "surge" });
                    this.say("holdDone");
                    this.openDoor("lift-bottom");
                    this.setStage("lift");
                }
                break;
            }
            case "lift":
                if (this.flags.has("lift")) {
                    this.say("ride");
                    p.riding = true; p.crouched = false; p.rollT = -1;
                    p.pos = [(LIFT.x0 + LIFT.x1) / 2, this.liftY, (LIFT.z0 + LIFT.z1) / 2 + 0.3];
                    this.setStage("ride");
                }
                break;
            case "ride": break; // ride() moves on when the lift arrives
            case "warden": {
                const w = this.enemies.find(e => e.kind === "warden");
                if (w && (w.state === "restored" || w.state === "destroyed")) { this.say("awaken"); this.setStage("awaken"); }
                break;
            }
            case "awaken": break;
        }
    }

    /** Sky openness at a point (props and characters take their ambient from it). */
    open(at: V3): number { return openness(at[0], at[1] + 0.5, at[2]); }

    // --- Saves -----------------------------------------------------------------------------------------

    save(): RunSave {
        const machines: RunSave["machines"] = {};
        for (const e of this.enemies) if (!e.spawned && (e.state === "restored" || e.state === "destroyed")) machines[e.id] = e.state;
        const w = this.enemies.find(e => e.kind === "warden");
        if (w && (w.state === "restored" || w.state === "destroyed")) machines.warden = w.state;
        // A hold-out or a ride in progress is saved from before it started.
        const stage: StageId = this.stage === "holdout" ? "reactor" : this.stage === "ride" ? "lift" : this.stage;
        const flags = [...this.flags].filter(f => !(stage === "reactor" && f === "reactor") && !(stage === "lift" && f === "lift"));
        return {
            v: 2, stage, checkpoint: this.checkpoint, taken: [...this.taken], collected: [...this.collected], flags, machines,
            resets: this.resets, destroyed: this.destroyed, deaths: this.deaths, time: this.time, usedSim: this.usedSim,
        };
    }

    /** Restores a saved run: Ray at its checkpoint, doors as they were, dealt-with machines as they were. */
    load(s: RunSave): void {
        if (!s || s.v !== 2 || stageIndex(s.stage) < 0) return;
        this.stage = s.stage; this.stageT = 0;
        if (this.level.checkpoints.some(c => c.id === s.checkpoint)) this.checkpoint = s.checkpoint;
        for (const id of s.taken ?? []) this.taken.add(id);
        for (const id of s.collected ?? []) this.collected.add(id);
        for (const f of s.flags ?? []) this.flags.add(f);
        for (const e of this.enemies) { const st = s.machines?.[e.id]; if (st) { e.state = st; e.stateT = 99; if (st === "restored") e.hp = 0; } }
        this.resets = s.resets ?? 0; this.destroyed = s.destroyed ?? 0; this.deaths = s.deaths ?? 0; this.time = s.time ?? 0; this.usedSim = !!s.usedSim;
        if (this.flags.has("biochip")) this.player.biochip = 100;
        for (const d of this.level.doors) if (this.flags.has(`open:${d.id}`)) this.doorOpen.set(d.id, 1);
        this.updateDoors(0);
        // A saved hypercube visit means its lines were heard.
        if (this.reached("bridge")) for (const id of ["leftLab", "secondFloor", "lensHint", "ramp", "atrium", "firstEnemy"]) this.said.add(id);
        // Past the lift, the lift is up and the Warden is where it was left.
        if (this.reached("warden")) {
            this.liftY = LIFT.top;
            this.liftFloor.min[1] = LIFT.top - 0.3; this.liftFloor.max[1] = LIFT.top;
            const st = s.machines?.warden;
            const w = this.spawn("warden", "warden", WARDEN_DROP, "spire2");
            w.spawned = true;
            if (st) { w.state = st; w.stateT = 99; } else { w.state = "patrol"; }
        }
        this.said.add("intro");
        this.respawn();
        this.events.length = 0;
    }
}

/**
 * A save that starts the mission at `stage` (from its usual checkpoint, with everything before it
 * done): the test tools jump around with it.
 */
export function stageSave(stage: StageId): RunSave {
    const at: Partial<Record<StageId, string>> = {
        climb: "lab", dark: "second-floor", hypercube: "atrium", bridge: "atrium", biochip: "relay-hall", conduit: "vault-walk", descent: "archive",
        crossing: "relay-bottom", reactor: "reactor", holdout: "reactor", lift: "reactor", ride: "reactor", warden: "lift-top", awaken: "lift-top",
    };
    const i = stageIndex(stage), flags: string[] = [];
    if (i > stageIndex("biochip")) flags.push("biochip");
    if (i > stageIndex("conduit")) flags.push("conduit", "open:relay-stairs");
    if (i > stageIndex("holdout")) flags.push("surge", "open:lift-bottom");
    if (i > stageIndex("ride")) flags.push("lift", "open:lift-top");
    const s: StageId = stage === "holdout" ? "reactor" : stage === "ride" ? "lift" : stage;
    return { v: 2, stage: s, checkpoint: at[stage] ?? "lab", taken: [], collected: [], flags, machines: {}, resets: 0, destroyed: 0, deaths: 0, time: 0, usedSim: false };
}

/** Props' collision boxes, turned with them (to the nearest quarter turn: boxes stay axis-aligned). */
export function propBoxes(level: Level, size: (p: Prop) => V3 = p => p.collide ?? [0, 0, 0]): Solid[] {
    const out: Solid[] = [];
    for (const p of level.props) {
        if (!p.collide) continue;
        const h = size(p);
        const quarter = Math.round(p.yaw / (Math.PI / 2)) % 2 !== 0;
        const hx = quarter ? h[2] : h[0], hz = quarter ? h[0] : h[2];
        out.push({ min: [p.pos[0] - hx, p.pos[1] - (p.sink ?? 0), p.pos[2] - hz], max: [p.pos[0] + hx, p.pos[1] + h[1] * 2 - (p.sink ?? 0), p.pos[2] + hz] });
    }
    return out;
}
