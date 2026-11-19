// True Error, level 1, as a simulation with no engine calls (tests drive it directly): Ray's
// movement against the level's boxes and ramps, the photon rifle, the hacked machines (patrol,
// alert, fight, knocked out, then Reset or destroyed by the player's choice), the dark zone, the
// nuclear cells, checkpoints, and the story's beats. The addon (true_error_addon.ts) feeds it
// input and draws what it says.

import { buildLevel, World, openness, START, DARK_ZONE, PEDESTAL, GOAL_RADIUS, FLOORS, type Level, type V3, type EnemyKind, type Solid, type Prop } from "./te_level";

export const PLAYER = { radius: 0.35, height: 1.8, step: 0.5, walk: 2.3, run: 5.4, aimWalk: 1.9, jump: 6.2, gravity: 18 };
export const RIFLE = { interval: 0.14, cost: 2.4, damage: 15, range: 120, regen: 7 };
export const ENEMY = {
    roller: { hp: 60, speed: 2.6, sight: 20, range: 14, interval: 1.1, damage: 6, spread: 0.06, radius: 0.55, height: 1.1 },
    hacked_bot: { hp: 120, speed: 1.6, sight: 24, range: 18, interval: 0.32, damage: 5, spread: 0.08, radius: 0.45, height: 2.1, burst: 4, rest: 1.6 },
};
/** Seconds a knocked-out machine stays down before it reboots, still hacked. */
export const STUN_TIME = 10;
export const RESET_REACH = 2.6;
export const DARK_DAMAGE = 14;

export interface PlayerInput {
    /** Move in camera space: x right, y forward (-1..1). */
    move: [number, number];
    run: boolean;
    jump: boolean;
    fire: boolean;
    aim: boolean;
    use: boolean;
    /** Camera yaw/pitch (rad): where the crosshair points. */
    yaw: number;
    pitch: number;
    /** Where the crosshair ray hits (from the camera), for the shot's direction. */
    target: V3 | null;
}
export const NO_INPUT: PlayerInput = { move: [0, 0], run: false, jump: false, fire: false, aim: false, use: false, yaw: 0, pitch: 0, target: null };

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
    zone: number;
    cooldown: number;
    burst: number;
    hitFlash: number;
    /** 0..1 how fast it is moving (for the walk animation and the roller's roll). */
    moving: number;
    roll: number;
    seen: boolean;
    vel: V3;
}

export interface Bolt { from: V3; to: V3; age: number; enemy: boolean; hit: boolean }

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
    | { kind: "goal" };

/** The story's lines. `who` is the speaker; the radio lines arrive while you play. */
export const LINES: Record<string, { who: string; text: string; seconds: number }[]> = {
    intro: [
        { who: "", text: "Mars, 4122. Three years after the Last Day.", seconds: 4.5 },
        { who: "", text: "The capital's Central Spire. Its east face was torn away when the Error came through.", seconds: 5 },
        { who: "THE SECRET DOCTOR", text: "Easy. Easy. Your lens is coming online.", seconds: 3.6 },
        { who: "THE SECRET DOCTOR", text: "You were born in the simulation, while it slept. Seven epochs of turmoil. I pulled you out and built you this body.", seconds: 6 },
        { who: "THE SECRET DOCTOR", text: "The algorithm that fixed you restores a mind. It also wipes it. I'm sorry. You are the first Reborn.", seconds: 6 },
        { who: "THE SECRET DOCTOR", text: "Every hacked machine out there was someone once. The Reset can bring them back. Or you put them down. Your call.", seconds: 6.2 },
        { who: "THE SECRET DOCTOR", text: "The hypercube is at the top of this spire. If anything remembers how the Error got out, it does. Take the rifle. Go.", seconds: 6.2 },
    ],
    leftLab: [{ who: "DOCTOR (RADIO)", text: "Mind the east side. The blast opened it to the sky. It's three hundred meters down.", seconds: 5 }],
    firstEnemy: [{ who: "DOCTOR (RADIO)", text: "Sentry roller. Hacked. Knock it down, then get close and press E to Reset it.", seconds: 5 }],
    firstReset: [{ who: "DOCTOR (RADIO)", text: "There. One mind back. It won't remember a thing, but it will live.", seconds: 4.5 }],
    firstDestroy: [{ who: "DOCTOR (RADIO)", text: "Scrap is scrap. Not every one of them can be saved.", seconds: 4 }],
    secondFloor: [{ who: "DOCTOR (RADIO)", text: "That violet haze is dark radiation, a shard of a dark bomb. Without a biochip your mind falls apart in there. Go around.", seconds: 6.5 }],
    inDark: [{ who: "DOCTOR (RADIO)", text: "Out! Get out of the dark zone!", seconds: 2.5 }],
    lensHint: [{ who: "DOCTOR (RADIO)", text: "Try your simulation lens. Press 5. The old world still shows through.", seconds: 4.5 }],
    ramp: [{ who: "DOCTOR (RADIO)", text: "That slab fell from the atrium. Climb it.", seconds: 3.5 }],
    atrium: [{ who: "DOCTOR (RADIO)", text: "There it is. The hypercube. Every mind on Mars passed through it once.", seconds: 4.5 }],
    outro: [
        { who: "DOCTOR (RADIO)", text: "Ray? Your lens is flaring. What are you seeing?", seconds: 4 },
        { who: "", text: "SIMULATION LINK ESTABLISHED", seconds: 3.5 },
        { who: "", text: "Somewhere inside, the seven epochs are still running.", seconds: 4.5 },
    ],
};

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
}

export class Game {
    readonly level: Level;
    readonly world: World;
    readonly player: Player;
    readonly enemies: Enemy[];
    readonly bolts: Bolt[] = [];
    readonly taken = new Set<string>();
    readonly said = new Set<string>();
    readonly events: GameEvent[] = [];
    checkpoint = "lab";
    time = 0;
    resets = 0;
    destroyed = 0;
    won = false;
    deaths = 0;
    /** The player's chosen lens and whether they've used the simulation one. */
    usedSim = false;
    private rng = 1;

    constructor(propSize: (p: Prop) => V3 = p => p.collide ?? [0, 0, 0]) {
        this.level = buildLevel();
        this.world = new World(this.level, propBoxes(this.level, propSize));
        this.player = { pos: [...START.pos], vel: [0, 0, 0], yaw: START.yaw, grounded: true, integrity: 100, energy: 100, alive: true, deadT: 0, cooldown: 0, hurtT: 0, speed: 0, aiming: false, firing: 0, jumpT: 0, stepPhase: 0, darkT: 0 };
        this.enemies = this.level.enemies.map(s => ({
            id: s.id, kind: s.kind, pos: [...s.pos], yaw: s.yaw, hp: ENEMY[s.kind].hp, state: "patrol", stateT: 0, patrol: s.patrol, leg: 1, zone: s.zone,
            cooldown: 1 + this.random() * 1.5, burst: 0, hitFlash: 0, moving: 0, roll: 0, seen: false, vel: [0, 0, 0],
        }));
    }

    random(): number { this.rng = (this.rng * 16807) % 2147483647; return (this.rng - 1) / 2147483646; }
    say(id: string): void { if (!this.said.has(id)) { this.said.add(id); this.events.push({ kind: "line", id }); } }

    /** Which floor (0..2) a height is on. */
    floorOf(y: number): number { return y >= FLOORS[2] - 1 ? 2 : y >= FLOORS[1] - 1 ? 1 : 0; }

    step(dt: number, input: PlayerInput): void {
        this.time += dt;
        this.updatePlayer(dt, input);
        for (const e of this.enemies) this.updateEnemy(e, dt);
        for (const b of this.bolts) b.age += dt;
        for (let i = this.bolts.length - 1; i >= 0; i--) if (this.bolts[i].age > 0.25) this.bolts.splice(i, 1);
        this.story();
    }

    private updatePlayer(dt: number, input: PlayerInput): void {
        const p = this.player;
        p.cooldown = Math.max(0, p.cooldown - dt);
        p.hurtT = Math.max(0, p.hurtT - dt);
        p.firing = Math.max(0, p.firing - dt);
        if (!p.alive) {
            p.deadT += dt;
            if (p.deadT > 3.2) this.respawn();
            return;
        }
        p.aiming = input.aim || input.fire;
        // Movement relative to the camera.
        const fx = Math.sin(input.yaw), fz = Math.cos(input.yaw);
        const rx = -fz, rz = fx;
        let mx = rx * input.move[0] + fx * input.move[1], mz = rz * input.move[0] + fz * input.move[1];
        const ml = Math.hypot(mx, mz);
        if (ml > 1) { mx /= ml; mz /= ml; }
        const speed = p.aiming ? PLAYER.aimWalk : input.run ? PLAYER.run : PLAYER.walk;
        const accel = p.grounded ? 14 : 3;
        p.vel[0] += (mx * speed - p.vel[0]) * Math.min(1, accel * dt);
        p.vel[2] += (mz * speed - p.vel[2]) * Math.min(1, accel * dt);
        if (input.jump && p.grounded) { p.vel[1] = PLAYER.jump; p.grounded = false; p.jumpT = 0; }
        p.vel[1] -= PLAYER.gravity * dt;
        p.jumpT += dt;
        // Facing: toward the aim while aiming, else toward the movement.
        const want = p.aiming ? input.yaw : ml > 0.1 ? Math.atan2(mx, mz) : p.yaw;
        let d = want - p.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        p.yaw += d * Math.min(1, (p.aiming ? 18 : 10) * dt);

        // Horizontal move, walls, then the ground.
        let x = p.pos[0] + p.vel[0] * dt, z = p.pos[2] + p.vel[2] * dt;
        [x, z] = this.world.pushOut(x, z, p.pos[1], PLAYER.height, PLAYER.radius, p.pos[1] + PLAYER.step);
        let y = p.pos[1] + p.vel[1] * dt;
        // The highest top no higher than a step above the feet: stairs are stepped up, walls are not.
        const ground = this.world.groundAt(x, z, PLAYER.radius, p.pos[1] + PLAYER.step);
        if (p.vel[1] <= 0 && y <= ground) { y = ground; p.vel[1] = 0; p.grounded = true; }
        // Walking down steps and slopes: stay on the ground rather than hop off each tread.
        else if (p.grounded && p.vel[1] <= 0 && p.pos[1] - ground < 0.55) { y = ground; p.vel[1] = 0; }
        else p.grounded = false;
        p.pos = [x, y, z];
        p.speed = Math.hypot(p.vel[0], p.vel[2]);
        if (p.grounded && p.speed > 0.5) {
            const before = p.stepPhase;
            p.stepPhase += dt * p.speed * 0.9;
            if (Math.floor(before) !== Math.floor(p.stepPhase)) this.events.push({ kind: "step", at: [...p.pos] });
        }
        // Fell off the spire.
        if (p.pos[1] < -25) { this.kill(); return; }

        // The dark zone.
        const dz = Math.hypot(p.pos[0] - DARK_ZONE.center[0], p.pos[1] + 1 - DARK_ZONE.center[1] - 1, p.pos[2] - DARK_ZONE.center[2]);
        p.darkT = dz < DARK_ZONE.radius ? Math.min(1, p.darkT + dt * 2) : Math.max(0, p.darkT - dt * 1.5);
        if (dz < DARK_ZONE.radius) { this.damagePlayer(DARK_DAMAGE * dt, false); this.say("inDark"); }

        // The rifle regains charge from its nuclear cell.
        if (p.cooldown <= 0) p.energy = Math.min(100, p.energy + RIFLE.regen * dt);
        if (input.fire && p.cooldown <= 0 && p.energy >= RIFLE.cost) this.fire(input);

        // Use: Reset the knocked-out machine in reach.
        if (input.use) {
            const e = this.resettable();
            if (e) {
                e.state = "restored"; e.stateT = 0; e.hitFlash = 0;
                this.resets++;
                this.events.push({ kind: "reset", id: e.id, at: [...e.pos] });
                if (this.resets === 1) this.say("firstReset");
            }
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
        // The goal.
        if (!this.won && Math.hypot(p.pos[0] - PEDESTAL[0], p.pos[2] - PEDESTAL[2]) < GOAL_RADIUS && p.pos[1] > PEDESTAL[1] - 0.5) {
            this.won = true;
            this.events.push({ kind: "goal" });
        }
    }

    /** The knocked-out machine within reach (nearest), if any. */
    resettable(): Enemy | null {
        const p = this.player;
        let best: Enemy | null = null, bd = RESET_REACH;
        for (const e of this.enemies) {
            if (e.state !== "stunned") continue;
            const d = Math.hypot(e.pos[0] - p.pos[0], e.pos[1] - p.pos[1], e.pos[2] - p.pos[2]);
            if (d < bd) { bd = d; best = e; }
        }
        return best;
    }

    /** The muzzle: in front of Ray's right shoulder. */
    muzzle(): V3 {
        const p = this.player;
        const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
        return [p.pos[0] + fx * 0.75 - fz * 0.22, p.pos[1] + 1.38, p.pos[2] + fz * 0.75 + fx * 0.22];
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
        if (hit.enemy) this.damageEnemy(hit.enemy, RIFLE.damage, to);
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

    private damageEnemy(e: Enemy, amount: number, at: V3): void {
        e.hitFlash = 1;
        this.events.push({ kind: "hit", at, target: e.id });
        if (e.state === "restored") return;
        if (e.state === "stunned") {
            // Shooting a knocked-out machine destroys it: the other reward path.
            e.hp -= amount;
            if (e.hp <= -40) {
                e.state = "destroyed"; e.stateT = 0;
                this.destroyed++;
                this.events.push({ kind: "destroyed", id: e.id, at: [...e.pos] });
                if (this.destroyed === 1) this.say("firstDestroy");
            }
            return;
        }
        e.hp -= amount;
        e.seen = true;
        if (e.state === "patrol") { e.state = "fight"; e.stateT = 0; }
        if (e.hp <= 0) {
            e.state = "stunned"; e.stateT = 0; e.hp = 0;
            this.events.push({ kind: "disabled", id: e.id, at: [...e.pos] });
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
        p.alive = false; p.deadT = 0; p.integrity = 0;
        this.deaths++;
        this.events.push({ kind: "died" });
    }

    respawn(): void {
        const c = this.level.checkpoints.find(k => k.id === this.checkpoint) ?? this.level.checkpoints[0];
        const p = this.player;
        p.pos = [...c.pos]; p.vel = [0, 0, 0]; p.yaw = c.yaw; p.alive = true; p.deadT = 0; p.integrity = 100; p.energy = Math.max(p.energy, 60); p.grounded = true; p.darkT = 0;
        this.events.push({ kind: "respawn" });
    }

    private canSee(e: Enemy, range: number): boolean {
        const p = this.player;
        const eye: V3 = [e.pos[0], e.pos[1] + ENEMY[e.kind].height * 0.8, e.pos[2]];
        const to: V3 = [p.pos[0] - eye[0], p.pos[1] + 1.4 - eye[1], p.pos[2] - eye[2]];
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
        let goal: V3 | null = null, speed = 0;
        switch (e.state) {
            case "patrol": {
                goal = e.patrol[e.leg % e.patrol.length];
                speed = s.speed * 0.55;
                if (Math.hypot(goal[0] - e.pos[0], goal[2] - e.pos[2]) < 0.6) e.leg++;
                if (this.floorOf(p.pos[1]) === e.zone && this.canSee(e, s.sight)) { e.state = "alert"; e.stateT = 0; e.seen = true; if (e.kind === "roller") this.say("firstEnemy"); }
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
                this.face(e, p.pos, dt, 5);
                if (d > s.range * 0.7 || !sees) { goal = p.pos; speed = s.speed; }
                else if (e.kind === "roller") {
                    // Rollers circle at range.
                    const a = Math.atan2(e.pos[0] - p.pos[0], e.pos[2] - p.pos[2]) + 0.6;
                    goal = [p.pos[0] + Math.sin(a) * s.range * 0.55, e.pos[1], p.pos[2] + Math.cos(a) * s.range * 0.55];
                    speed = s.speed * 0.8;
                }
                if (sees && e.cooldown <= 0 && p.alive) this.enemyFire(e);
                if (!p.alive || this.floorOf(p.pos[1]) !== e.zone && !sees && e.stateT > 6) { e.state = "patrol"; e.stateT = 0; }
                break;
            }
            case "stunned": {
                if (e.stateT > STUN_TIME) { e.state = "fight"; e.stateT = 0; e.hp = s.hp * 0.4; this.events.push({ kind: "rebooted", id: e.id }); }
                break;
            }
            default: break;
        }
        // Move toward the goal, never off a floor's edge.
        e.moving += ((goal ? 1 : 0) - e.moving) * Math.min(1, dt * 6);
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
        const aim: V3 = [p.pos[0] - from[0], p.pos[1] + 1.1 - from[1], p.pos[2] - from[2]];
        const dist = Math.hypot(...aim);
        const spread = s.spread * (1 + (p.speed > 3 ? 0.8 : 0)) + dist * 0.002;
        const dir: V3 = [aim[0] / dist + (this.random() - 0.5) * spread * 2, aim[1] / dist + (this.random() - 0.5) * spread, aim[2] / dist + (this.random() - 0.5) * spread * 2];
        const l = Math.hypot(...dir);
        const d: V3 = [dir[0] / l, dir[1] / l, dir[2] / l];
        const wall = this.world.raycast(from, d, 80).t;
        // Did it pass within the player's body?
        const ox = p.pos[0] - from[0], oy = p.pos[1] + 1 - from[1], oz = p.pos[2] - from[2];
        const along = ox * d[0] + oy * d[1] + oz * d[2];
        const miss = Math.hypot(ox - d[0] * along, (oy - d[1] * along) * 0.5, oz - d[2] * along);
        const hits = along > 0 && along < wall && miss < 0.45;
        const t = hits ? along : Math.min(wall, 80);
        this.bolts.push({ from, to: [from[0] + d[0] * t, from[1] + d[1] * t, from[2] + d[2] * t], age: 0, enemy: true, hit: true });
        this.events.push({ kind: "shot", at: from, enemy: true });
        if (hits) this.damagePlayer(s.damage);
    }

    private story(): void {
        const p = this.player;
        const f = this.floorOf(p.pos[1]);
        if (f === 0 && (p.pos[0] > -7.5 || p.pos[2] > -9.5)) this.say("leftLab");
        if (f === 1 && p.pos[1] > 6.5) this.say("secondFloor");
        if (f === 1 && p.pos[2] > 9 && p.pos[0] > -2) this.say("lensHint");
        if (f === 1 && p.pos[2] < -14 && p.pos[0] > 3) this.say("ramp");
        if (f === 2 && p.pos[1] > 13.5) this.say("atrium");
    }

    /** Sky openness at a point (props and characters take their ambient from it). */
    open(at: V3): number { return openness(at[0], at[1] + 0.5, at[2]); }
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
