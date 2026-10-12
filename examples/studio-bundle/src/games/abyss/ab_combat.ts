// The fighting of Chapter One: the expedition's troopers and the wardens of the kingdom below,
// coil-rifle slugs (hitscan, drawn as tracers) and bolts of the river's light (slow, glowing,
// a little homing, bursting where they land). Plain data and deterministic steps from a seeded
// RNG; the game supplies the terrain and draws the result.
//
// - Troopers follow Alex in a loose wedge, and fight in bursts once a warden shows itself.
// - Blades (glaive wardens) close in, zig-zagging, and strike; casters (staff wardens and adepts)
//   keep their distance and throw bolts. The Warden himself is scripted.
// - Doom: the chapter decides when each trooper may fall (`mortalFrom`, a story phase). Until
//   then wounds leave them at a quarter of their health; after, they die as anyone does - so the
//   expedition is cut down over the battle in the order the story tells, but by real wounds.

import { makeRng, type Rng } from "../allegiance/al_rng";
import type { V3 } from "./ab_world";

/** "neutral": people of below who are no one's enemy (a healer); nobody targets them. */
export type Faction = "surface" | "below" | "neutral";
export type Role = "squad" | "trooper" | "blade" | "caster" | "leader" | "civilian" | "gunner" | "beast";
export type ActorState = "idle" | "follow" | "move" | "fight" | "windup" | "strike" | "cast" | "dead" | "scripted" | "flee";

export interface Actor {
    id: number;
    name: string;
    look: string;
    faction: Faction;
    role: Role;
    x: number; y: number; z: number;
    yaw: number;
    vx: number; vz: number;
    /** Walk cycle phase and swing (radians) for the shader. */
    phase: number;
    swing: number;
    hp: number;
    maxHp: number;
    state: ActorState;
    stateT: number;
    target: number | null;
    targetT: number;
    cooldown: number;
    burst: number;
    goal: [number, number] | null;
    /** Seconds since death (the fall). */
    deadT: number;
    /** Story phase from which this trooper can die (Infinity: never in this chapter). */
    mortal: boolean;
    /** Formation slot (squad): offset right/back from Alex. */
    slot: [number, number];
    /** Arm pose for the shader: 0 none, 1 aim, 2 cast, 3 melee swing. */
    pose: number;
    meleeAngle: number;
    /** Strafe direction and its timer. */
    strafe: number;
    strafeT: number;
    /** Hit flash (seconds left) and the direction it came from. */
    hurtT: number;
    scale: number;
    /** Deaths this chapter caused by Alex (for the end card). */
    killedBy?: "player" | "squad" | "other";
    /** A group the story counts (a quest's hunters, a patrol, an NPC). */
    tag?: string;
    /** Enemy kind and rank (ab_rpg.ts), with the multipliers they bring. */
    kind?: string;
    rank?: string;
    /** Damage dealt and walking pace, as multiples of the role's own. */
    power?: number;
    pace?: number;
    /** A warding shimmer that takes damage before the body does (champions; Alex's lance burns through it). */
    ward?: number;
    /** Riding another actor (the behemoth's rider): placed on it every step while it lives. */
    mount?: number;
    /** Seconds since this one last saw Alex (an unseen enemy takes an ambusher's full blow). */
    sawPlayer?: number;
    /** A trooper holding a post (a downed crew by its wreck) instead of following Alex. */
    post?: [number, number];
    /** Civilians: where they run to (a door), and set once they are inside. */
    shelter?: [number, number];
    inside?: boolean;
}

export interface Shot { from: V3; to: V3; age: number; hit: boolean; faction: Faction }

export interface Bolt {
    id: number;
    pos: V3;
    vel: V3;
    age: number;
    life: number;
    target: number | null;
    /** Aim point for bolts at no actor (an aircraft, a spot). */
    aim: V3 | null;
    damage: number;
    radius: number;
    color: [number, number, number];
    size: number;
    owner: number;
}

export interface Burst { pos: V3; age: number; color: [number, number, number]; size: number }

export interface CombatWorld {
    ground(x: number, z: number): number;
    /** True when nothing (terrain, solid props) blocks the segment a-b. */
    clear(a: V3, b: V3): boolean;
    /** Pushes (x, z) out of solid props; returns the new position. */
    collide(x: number, z: number, r: number): [number, number];
    /** Steepness 0 (flat) .. 1 (vertical). */
    slope(x: number, z: number): number;
    /** True when `p` is inside something solid (a barricade, a wall): bolts burst on it. */
    blocked?(p: V3): boolean;
    /** A place to stand behind cover from `threat`, within `reach` of (x, z) (null: none). */
    coverNear?(x: number, z: number, threat: V3, reach: number): [number, number] | null;
}

export interface PlayerView {
    x: number; y: number; z: number; yaw: number;
    alive: boolean;
    /** 0 standing .. 1 crouched: crouched, Alex shows less of himself and is seen only close. */
    crouch?: number;
    /** Multiplies how close a crouched Alex must come to be noticed (perks). */
    stealth?: number;
    /** The Veil: the light bends round him, only the nearest notice. */
    veiled?: boolean;
    /** Damage dealt to Alex goes through here (armor, the story's own rules). */
    hurt(amount: number, from: V3): void;
}

export interface CombatState {
    actors: Actor[];
    shots: Shot[];
    bolts: Bolt[];
    bursts: Burst[];
    rng: Rng;
    nextId: number;
    nextBolt: number;
    /** Things that happened this step (deaths, hits, casts) for sound and the HUD. */
    events: CombatEvent[];
    /** The surface side holds fire until shot at or ordered (the stand-off before the battle). */
    holdFire: boolean;
    /** The wardens hold back (cutscenes, the stand-off, after the surge). */
    wardensPassive: boolean;
    /** Seconds the wardens stay alert (Alex fired, was seen): while it runs, crouching hides nothing. */
    alert: number;
}

export type CombatEvent =
    | { kind: "death"; actor: Actor; by: "player" | "squad" | "other" }
    | { kind: "hit"; actor: Actor; amount: number }
    | { kind: "shot"; from: V3; to: V3; faction: Faction; actor: number }
    | { kind: "cast"; actor: Actor; at: V3 }
    | { kind: "burst"; pos: V3; size: number }
    | { kind: "playerHit"; amount: number; from: V3 }
    | { kind: "melee"; actor: Actor }
    /** A behemoth's fire breath this step: from its mouth along `dir`. */
    | { kind: "breath"; actor: Actor; from: V3; dir: V3 }
    | { kind: "stomp"; actor: Actor }
    /** A seer's healing light on an ally. */
    | { kind: "heal"; actor: Actor; target: Actor };

export function newCombat(seed = 13): CombatState {
    return { actors: [], shots: [], bolts: [], bursts: [], rng: makeRng(seed), nextId: 1, nextBolt: 1, events: [], holdFire: true, wardensPassive: true, alert: 0 };
}

export const ROLE_HP: Record<Role, number> = { squad: 100, trooper: 100, blade: 90, caster: 70, leader: 600, civilian: 100, gunner: 120, beast: 1600 };

export function spawn(c: CombatState, a: Partial<Actor> & Pick<Actor, "name" | "look" | "faction" | "role" | "x" | "z">, ground: (x: number, z: number) => number): Actor {
    const actor: Actor = {
        id: c.nextId++, y: ground(a.x, a.z), yaw: 0, vx: 0, vz: 0, phase: 0, swing: 0,
        hp: ROLE_HP[a.role], maxHp: ROLE_HP[a.role], state: a.faction === "surface" ? "follow" : "idle", stateT: 0, target: null, targetT: 0,
        cooldown: 0, burst: 0, goal: null, deadT: 0, mortal: a.faction === "below", slot: [0, 6], pose: 0, meleeAngle: 0, strafe: 1, strafeT: 0, hurtT: 0, scale: 1,
        ...a,
    } as Actor;
    c.actors.push(actor);
    return actor;
}

export const alive = (a: Actor): boolean => a.state !== "dead";
export const living = (c: CombatState, f?: Faction): Actor[] => c.actors.filter(a => alive(a) && (!f || a.faction === f));
export const actorById = (c: CombatState, id: number | null): Actor | undefined => (id === null ? undefined : c.actors.find(a => a.id === id));

/** Chest height of an actor (aim point). */
export const chest = (a: Actor): V3 => [a.x, a.y + 1.3 * a.scale, a.z];

/** Where enemies aim at Alex: his chest, lower when he crouches. */
export const playerChest = (p: PlayerView): V3 => [p.x, p.y + 1.3 - 0.55 * (p.crouch ?? 0), p.z];

/**
 * How far away a warden notices Alex. Crouched and unheard he is seen only close (sneaking past
 * a patrol is possible); standing, or once they are alert, at the full range.
 */
export function noticeRange(c: CombatState, a: Actor, p: PlayerView, range: number): number {
    const crouch = p.crouch ?? 0;
    if (p.veiled) return Math.min(range, 10);
    if (c.alert > 0 || a.target === -1) return range;
    // Behind a warden's back he has to come closer still.
    const facing = Math.cos(Math.atan2(p.x - a.x, p.z - a.z) - a.yaw);
    const sneak = (24 + 26 * Math.max(0, facing)) * (p.stealth ?? 1);
    return range + (sneak - range) * crouch;
}

const dist2 = (ax: number, az: number, bx: number, bz: number) => (ax - bx) ** 2 + (az - bz) ** 2;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Damages an actor; returns true if it died. Doom: troopers not yet mortal hold at a quarter. */
export function damage(c: CombatState, a: Actor, amount: number, by: "player" | "squad" | "other", pierce = false): boolean {
    if (!alive(a)) return false;
    if (a.ward && a.ward > 0) {
        // The ward drinks the blow (the river's own light burns through it twice as fast).
        const take = Math.min(a.ward, amount * (pierce ? 2 : 1));
        a.ward -= take;
        amount -= take / (pierce ? 2 : 1);
        if (amount <= 0.01) { a.hurtT = 0.12; c.events.push({ kind: "hit", actor: a, amount: 0 }); return false; }
    }
    a.hp -= amount;
    a.hurtT = 0.25;
    c.events.push({ kind: "hit", actor: a, amount });
    if (!a.mortal && a.hp < a.maxHp * 0.25) a.hp = a.maxHp * 0.25;
    if (a.role === "leader" && a.hp < a.maxHp * 0.5) a.hp = a.maxHp * 0.5;
    if (a.hp <= 0) {
        a.hp = 0;
        a.state = "dead";
        a.deadT = 0;
        a.killedBy = by;
        a.pose = 0;
        c.events.push({ kind: "death", actor: a, by });
        return true;
    }
    return false;
}

/** Kills outright (the story's own deaths: a gunship's fall, a warden's lance). */
export function kill(c: CombatState, a: Actor, by: "player" | "squad" | "other" = "other"): void {
    a.mortal = true;
    damage(c, a, a.hp + 1, by);
}

/** Nearest living enemy of `a` it can see (or Alex, for wardens), within range. */
function pickTarget(c: CombatState, a: Actor, p: PlayerView, w: CombatWorld, range: number): { id: number; pos: V3 } | null {
    let best: { id: number; pos: V3 } | null = null;
    let bestD = range * range;
    const eye: V3 = [a.x, a.y + 1.6, a.z];
    const consider = (id: number, pos: V3, bias: number) => {
        const d = dist2(a.x, a.z, pos[0], pos[2]) * bias;
        if (d >= bestD) return;
        if (!w.clear(eye, pos)) return;
        bestD = d; best = { id, pos };
    };
    // Nobody hunts the neutral - but the Bore's rogue sentinels shoot whatever moves, pilgrims too.
    for (const o of c.actors) if (alive(o) && o.faction !== a.faction && (o.faction !== "neutral" || (a.role === "gunner" && o.role === "civilian" && !o.inside))) consider(o.id, chest(o), 1 + c.rng.next() * 0.3);
    if (a.faction === "below" && p.alive) {
        const pc = playerChest(p);
        const reach = noticeRange(c, a, p, range);
        if (dist2(a.x, a.z, p.x, p.z) < reach * reach) consider(-1, pc, 0.75);
    }
    return best;
}

function targetPos(c: CombatState, id: number | null, p: PlayerView): V3 | null {
    if (id === -1) return p.alive ? playerChest(p) : null;
    const t = actorById(c, id);
    return t && alive(t) ? chest(t) : null;
}

/** Walks `a` toward (gx, gz) at `speed`, around solid props, never up a cliff. */
function walk(a: Actor, gx: number, gz: number, speed: number, dt: number, w: CombatWorld): number {
    const dx = gx - a.x, dz = gz - a.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.3) { a.vx *= 0.8; a.vz *= 0.8; return d; }
    const s = Math.min(speed, d / Math.max(dt, 1e-3));
    const tx = dx / d * s, tz = dz / d * s;
    a.vx += (tx - a.vx) * Math.min(1, dt * 6);
    a.vz += (tz - a.vz) * Math.min(1, dt * 6);
    let nx = a.x + a.vx * dt, nz = a.z + a.vz * dt;
    [nx, nz] = w.collide(nx, nz, 0.4);
    const rise = w.ground(nx, nz) - a.y;
    const step = Math.hypot(nx - a.x, nz - a.z);
    // Neither up a cliff nor off one.
    if (rise > Math.max(0.6, step * 1.4) || rise < -Math.max(1.2, step * 2.2)) { a.vx *= -0.3; a.vz *= -0.3; return d; }
    a.x = nx; a.z = nz;
    a.yaw += wrap(Math.atan2(a.vx, a.vz) - a.yaw) * Math.min(1, dt * 8);
    return d;
}

function face(a: Actor, pos: V3, dt: number): void {
    a.yaw += wrap(Math.atan2(pos[0] - a.x, pos[2] - a.z) - a.yaw) * Math.min(1, dt * 10);
}

/** Fires a slug from `a` at `aim` with the given chance to hit what it aims at. */
function fireSlug(c: CombatState, a: Actor, aim: V3, targetId: number | null, hitChance: number, dmg: number, p: PlayerView, w: CombatWorld): void {
    const from: V3 = [a.x + Math.sin(a.yaw + 0.3) * 0.35, a.y + 1.45 * a.scale, a.z + Math.cos(a.yaw + 0.3) * 0.35];
    const hit = c.rng.next() < hitChance;
    let to: V3 = aim;
    if (!hit) {
        const miss = 0.6 + c.rng.next() * 1.6;
        const ang = c.rng.next() * Math.PI * 2;
        to = [aim[0] + Math.cos(ang) * miss, aim[1] + Math.sin(ang) * miss * 0.6, aim[2] + Math.sin(ang * 1.7) * miss];
        // Carry on past to the ground.
        const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
        const l = Math.hypot(dx, dy, dz);
        to = [from[0] + dx / l * Math.max(l * 1.6, 20), from[1] + dy / l * Math.max(l * 1.6, 20), from[2] + dz / l * Math.max(l * 1.6, 20)];
        const g = w.ground(to[0], to[2]);
        if (to[1] < g) to[1] = g;
    }
    c.shots.push({ from, to, age: 0, hit, faction: a.faction });
    c.events.push({ kind: "shot", from, to, faction: a.faction, actor: a.id });
    if (!hit) return;
    if (targetId === -1) p.hurt(dmg, from);
    else { const t = actorById(c, targetId); if (t) damage(c, t, dmg, a.faction === "surface" ? "squad" : "other"); }
}

/** Throws a bolt of the river's light from `a` toward a target (an actor, Alex, or a point). */
export function castBolt(c: CombatState, a: Actor, target: number | null, aim: V3, opts: Partial<Pick<Bolt, "damage" | "radius" | "size" | "color" | "life">> & { speed?: number } = {}): Bolt {
    const hand: V3 = [a.x + Math.sin(a.yaw - 0.4) * 0.4, a.y + 2.0 * a.scale, a.z + Math.cos(a.yaw - 0.4) * 0.4];
    const dx = aim[0] - hand[0], dy = aim[1] - hand[1], dz = aim[2] - hand[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    const speed = opts.speed ?? 30;
    const b: Bolt = {
        id: c.nextBolt++, pos: hand, vel: [dx / l * speed, dy / l * speed + 1.5, dz / l * speed], age: 0, life: opts.life ?? 4,
        target, aim: target === null ? aim : null, damage: opts.damage ?? 22, radius: opts.radius ?? 2.2,
        color: opts.color ?? [0.45, 0.9, 1], size: opts.size ?? 0.35, owner: a.id,
    };
    c.bolts.push(b);
    c.events.push({ kind: "cast", actor: a, at: aim });
    return b;
}

export interface StepOptions {
    /** Alex's own squad orders: hold here (null: follow). */
    hold: [number, number] | null;
    /** Accuracy multiplier for wardens (difficulty). */
    wardenAccuracy: number;
}

/** One step of every actor, shot and bolt. */
export function stepCombat(c: CombatState, dt: number, p: PlayerView, w: CombatWorld, opts: StepOptions = { hold: null, wardenAccuracy: 1 }): void {
    c.events = [];
    const rng = c.rng;
    c.alert = Math.max(0, c.alert - dt);
    for (const s of c.shots) s.age += dt;
    c.shots = c.shots.filter(s => s.age < 0.12);
    for (const b of c.bursts) b.age += dt;
    c.bursts = c.bursts.filter(b => b.age < 0.9);

    const hostilesVisible = living(c, "below").length > 0;
    for (const a of c.actors) {
        a.hurtT = Math.max(0, a.hurtT - dt);
        if (!alive(a)) { a.deadT += dt; a.swing *= 0.9; continue; }
        a.stateT += dt;
        a.cooldown = Math.max(0, a.cooldown - dt);
        a.targetT -= dt;
        const prevX = a.x, prevZ = a.z;
        if (a.state === "scripted") {
            // The story moves it (goal), nothing else.
            if (a.goal) walk(a, a.goal[0], a.goal[1], 1.8, dt, w);
        } else if (a.role === "civilian") stepCivilian(a, dt, w);
        else if (a.faction === "neutral") { a.vx = 0; a.vz = 0; }
        else if (a.faction === "surface") stepTrooper(c, a, dt, p, w, opts, hostilesVisible);
        else if (a.role === "beast") stepBeast(c, a, dt, p, w, opts);
        else stepWarden(c, a, dt, p, w, opts);
        a.y += (w.ground(a.x, a.z) - a.y) * Math.min(1, dt * 12);
        a.sawPlayer = a.target === -1 ? 0 : (a.sawPlayer ?? 99) + dt;
        if (a.mount !== undefined) {
            const m = actorById(c, a.mount);
            if (m && alive(m)) {
                // In the howdah on its back, facing where it faces (turning to throw).
                const seat = beastSeat(m);
                a.x = seat[0]; a.y = seat[1]; a.z = seat[2];
                a.vx = 0; a.vz = 0;
            } else a.mount = undefined;
        }
        // Walk cycle from how far it moved.
        const moved = Math.hypot(a.x - prevX, a.z - prevZ);
        const speed = moved / Math.max(dt, 1e-6);
        a.phase += moved * 2.4;
        a.swing += ((speed > 0.3 ? Math.min(0.55, 0.18 + speed * 0.07) : 0) - a.swing) * Math.min(1, dt * 6);
    }

    // Bolts: fly, home a little, burst on what they hit.
    for (const b of c.bolts) {
        b.age += dt;
        const tp = b.target !== null ? targetPos(c, b.target, p) : b.aim;
        if (tp) {
            const sp = Math.hypot(b.vel[0], b.vel[1], b.vel[2]);
            const dx = tp[0] - b.pos[0], dy = tp[1] - b.pos[1], dz = tp[2] - b.pos[2];
            const l = Math.hypot(dx, dy, dz) || 1;
            const turn = Math.min(1, dt * 1.6);
            b.vel = [b.vel[0] + (dx / l * sp - b.vel[0]) * turn, b.vel[1] + (dy / l * sp - b.vel[1]) * turn, b.vel[2] + (dz / l * sp - b.vel[2]) * turn];
        }
        b.pos = [b.pos[0] + b.vel[0] * dt, b.pos[1] + b.vel[1] * dt, b.pos[2] + b.vel[2] * dt];
        let hit = b.age > b.life || b.pos[1] <= w.ground(b.pos[0], b.pos[2]) + 0.1 || !!w.blocked?.(b.pos);
        if (!hit && tp && Math.hypot(tp[0] - b.pos[0], tp[1] - b.pos[1], tp[2] - b.pos[2]) < 0.9) hit = true;
        if (!hit) {
            for (const o of c.actors) if (alive(o) && o.faction === "surface" && Math.hypot(o.x - b.pos[0], o.z - b.pos[2]) < 0.6 && b.pos[1] > o.y && b.pos[1] < o.y + 1.9) { hit = true; break; }
            if (p.alive && Math.hypot(p.x - b.pos[0], p.z - b.pos[2]) < 0.6 && b.pos[1] > p.y && b.pos[1] < p.y + 1.9) hit = true;
        }
        if (hit) {
            b.life = -1;
            c.bursts.push({ pos: [...b.pos] as V3, age: 0, color: b.color, size: b.size * 4 });
            c.events.push({ kind: "burst", pos: [...b.pos] as V3, size: b.size });
            for (const o of c.actors) {
                if (!alive(o) || o.faction !== "surface") continue;
                const d = Math.hypot(o.x - b.pos[0], o.y + 1 - b.pos[1], o.z - b.pos[2]);
                if (d < b.radius) damage(c, o, b.damage * (1 - d / b.radius * 0.6), "other");
            }
            if (p.alive) {
                const d = Math.hypot(p.x - b.pos[0], p.y + 1 - b.pos[1], p.z - b.pos[2]);
                if (d < b.radius) p.hurt(b.damage * (1 - d / b.radius * 0.6), b.pos);
            }
        }
    }
    c.bolts = c.bolts.filter(b => b.life >= 0);
    void rng;
}

function stepTrooper(c: CombatState, a: Actor, dt: number, p: PlayerView, w: CombatWorld, opts: StepOptions, hostiles: boolean): void {
    const rng = c.rng;
    // Choose (and keep for a while) a target.
    if (!c.holdFire && hostiles && (a.targetT <= 0 || !targetPos(c, a.target, p))) {
        const t = pickTarget(c, a, p, w, 110);
        a.target = t ? t.id : null;
        a.targetT = 2.5 + rng.next() * 3;
    }
    if (c.holdFire) a.target = null;
    const tp = a.target !== null ? targetPos(c, a.target, p) : null;
    // Where to stand: the place the game gives it on Alex's trail (or, without one, its formation
    // slot behind him), the hold point when ordered there, spread out in a fight.
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
    let gx = p.x + rx * a.slot[0] - fx * a.slot[1], gz = p.z + rz * a.slot[0] - fz * a.slot[1];
    if (a.goal) { gx = a.goal[0]; gz = a.goal[1]; }
    if (a.post) { gx = a.post[0]; gz = a.post[1]; }
    if (opts.hold && !a.post) { gx = opts.hold[0] + a.slot[0] * 0.8; gz = opts.hold[1] + a.slot[1] * 0.5; }
    if (tp) {
        a.strafeT -= dt;
        if (a.strafeT <= 0) { a.strafe = rng.next() < 0.5 ? -1 : 1; a.strafeT = 1.5 + rng.next() * 2.5; }
        gx += Math.cos(a.yaw) * a.strafe * 3; gz -= Math.sin(a.yaw) * a.strafe * 3;
    }
    const far = Math.hypot(gx - a.x, gz - a.z);
    const run = far > 9 ? 6.2 : far > 2.5 ? 3.6 : 1.6;
    if (far > 1.2) walk(a, gx, gz, run, dt, w);
    else { a.vx *= 0.85; a.vz *= 0.85; }
    if (!tp) {
        a.pose = c.holdFire && hostiles ? 1 : 0;
        if (c.holdFire && hostiles) {
            // Weapons up at the nearest warden, holding fire.
            let near: Actor | null = null, nd = 1e9;
            for (const o of c.actors) if (alive(o) && o.faction === "below") { const d = dist2(a.x, a.z, o.x, o.z); if (d < nd) { nd = d; near = o; } }
            if (near) face(a, chest(near), dt);
        } else if (far < 1.2) face(a, [a.x + fx, a.y, a.z + fz], dt);
        a.state = "follow";
        return;
    }
    a.state = "fight";
    a.pose = 1;
    face(a, tp, dt);
    if (a.cooldown > 0) return;
    if (a.burst <= 0) { a.burst = 3 + Math.floor(rng.next() * 4); }
    const d = Math.hypot(tp[0] - a.x, tp[2] - a.z);
    const chance = Math.max(0.08, Math.min(0.55, 0.6 - d / 180));
    fireSlug(c, a, tp, a.target, chance, 18, p, w);
    a.burst--;
    a.cooldown = a.burst > 0 ? 0.11 : 0.7 + rng.next() * 0.9;
}

/** A civilian runs for its door; once there it is inside (the game stops drawing it). */
function stepCivilian(a: Actor, dt: number, w: CombatWorld): void {
    if (a.inside || !a.shelter) { a.vx = 0; a.vz = 0; return; }
    if (walk(a, a.shelter[0], a.shelter[1], 5.4 * (a.pace ?? 1), dt, w) < 1.2) a.inside = true;
}

/** Where a behemoth's rider sits (in the howdah). */
export function beastSeat(m: Actor): V3 {
    const back = -0.35 * m.scale;
    return [m.x + Math.sin(m.yaw) * back, m.y + 1.62 * m.scale, m.z + Math.cos(m.yaw) * back];
}

/** Where a behemoth's mouth is (its fire comes from here). */
export function beastMouth(m: Actor): V3 {
    const ahead = 1.55 * m.scale;
    return [m.x + Math.sin(m.yaw) * ahead, m.y + 0.95 * m.scale, m.z + Math.cos(m.yaw) * ahead];
}

/**
 * The behemoth: slow and huge. It closes on its target and breathes fire down a cone for a few
 * seconds, then rests its throat; anyone underfoot is stomped.
 */
function stepBeast(c: CombatState, a: Actor, dt: number, p: PlayerView, w: CombatWorld, opts: StepOptions): void {
    const rng = c.rng;
    if (c.wardensPassive) { a.vx *= 0.8; a.vz *= 0.8; a.pose = 0; return; }
    if (a.targetT <= 0 || !targetPos(c, a.target, p)) {
        const t = pickTarget(c, a, p, w, 120);
        a.target = t ? t.id : null;
        a.targetT = 5 + rng.next() * 3;
    }
    const tp = targetPos(c, a.target, p);
    const power = (a.power ?? 1) * opts.wardenAccuracy;
    if (!tp) {
        if (a.goal) { if (walk(a, a.goal[0], a.goal[1], 2.0, dt, w) < 3) a.goal = null; }
        a.pose = 0;
        return;
    }
    const d = Math.hypot(tp[0] - a.x, tp[2] - a.z);
    if (a.state === "cast") {
        // Breathing: the head sweeps a little across its target; the fire goes where it looks.
        face(a, tp, dt * 0.35);
        const mouth = beastMouth(a);
        const yaw = a.yaw + Math.sin(a.stateT * 2.2) * 0.12;
        const dir: V3 = [Math.sin(yaw) * 0.96, -0.28, Math.cos(yaw) * 0.96];
        c.events.push({ kind: "breath", actor: a, from: mouth, dir });
        const burn = (x: number, y: number, z: number): number => {
            const vx = x - mouth[0], vz = z - mouth[2];
            const along = vx * dir[0] + vz * dir[2];
            if (along < 0 || along > 19) return 0;
            const across = Math.abs(vx * dir[2] - vz * dir[0]);
            return across < 1.2 + along * 0.32 && y < mouth[1] + 2 ? 1 : 0;
        };
        if (p.alive && burn(p.x, p.y + 1, p.z) && w.clear(mouth, [p.x, p.y + 1, p.z])) p.hurt(28 * power * dt, mouth);
        for (const o of c.actors) if (alive(o) && o.faction === "surface" && burn(o.x, o.y + 1, o.z)) damage(c, o, 28 * power * dt, "other");
        if (a.stateT > 2.6) { a.state = "move"; a.stateT = 0; a.cooldown = 4 + rng.next() * 2; }
        return;
    }
    if (a.state === "strike") {
        if (a.stateT > 1.1) { a.state = "move"; a.stateT = 0; }
        return;
    }
    // Underfoot: a stomp that throws everyone near down.
    if (d < 5.5 && a.cooldown <= 1) {
        a.state = "strike"; a.stateT = 0; a.cooldown = 3.5;
        c.events.push({ kind: "stomp", actor: a });
        if (p.alive && Math.hypot(p.x - a.x, p.z - a.z) < 6.5) p.hurt(38 * power, [a.x, a.y + 1, a.z]);
        for (const o of c.actors) if (alive(o) && o.faction === "surface" && Math.hypot(o.x - a.x, o.z - a.z) < 6.5) damage(c, o, 38 * power, "other");
        return;
    }
    if (d < 16 && a.cooldown <= 0 && w.clear(beastMouth(a), tp)) { a.state = "cast"; a.stateT = 0; a.vx = 0; a.vz = 0; return; }
    a.state = "move";
    a.pose = 0;
    if (d > 9) walk(a, tp[0], tp[2], 2.4 * (a.pace ?? 1), dt, w);
    else { a.vx *= 0.9; a.vz *= 0.9; face(a, tp, dt * 0.5); }
}

function stepWarden(c: CombatState, a: Actor, dt: number, p: PlayerView, w: CombatWorld, opts: StepOptions): void {
    const rng = c.rng;
    if (c.wardensPassive || a.role === "leader") {
        a.pose = 0;
        if (a.goal) { if (walk(a, a.goal[0], a.goal[1], 2.5, dt, w) < 0.5) a.goal = null; }
        else { a.vx *= 0.8; a.vz *= 0.8; }
        if (p.alive) face(a, [p.x, p.y, p.z], dt * 0.4);
        return;
    }
    if (a.state === "flee") {
        if (a.goal) walk(a, a.goal[0], a.goal[1], 6, dt, w);
        a.pose = 0;
        return;
    }
    if (a.targetT <= 0 || !targetPos(c, a.target, p)) {
        const t = pickTarget(c, a, p, w, 140);
        a.target = t ? t.id : null;
        a.targetT = 4 + rng.next() * 4;
    }
    const tp = targetPos(c, a.target, p);
    if (!tp) {
        // Nothing in sight: hunt - toward Alex, or the goal the story gave.
        a.pose = 0;
        const gx = a.goal ? a.goal[0] : p.x, gz = a.goal ? a.goal[1] : p.z;
        if (walk(a, gx, gz, a.role === "blade" ? 4.2 : 3.2, dt, w) < 2) a.goal = null;
        return;
    }
    const d = Math.hypot(tp[0] - a.x, tp[2] - a.z);
    if (a.role === "blade") {
        if (a.state === "windup") {
            a.pose = 3; a.meleeAngle = 2.6; face(a, tp, dt);
            if (a.stateT > 0.5) {
                a.state = "strike"; a.stateT = 0;
                c.events.push({ kind: "melee", actor: a });
                if (d < 2.8 * a.scale) {
                    const dmg = 30 * opts.wardenAccuracy * (a.power ?? 1);
                    if (a.target === -1) p.hurt(dmg, [a.x, a.y + 1.4, a.z]);
                    else { const t = actorById(c, a.target); if (t) damage(c, t, dmg, "other"); }
                }
            }
            return;
        }
        if (a.state === "strike") {
            a.pose = 3; a.meleeAngle = Math.max(0.2, 2.6 - a.stateT * 9);
            if (a.stateT > 0.6) { a.state = "move"; a.stateT = 0; a.cooldown = 0.6; }
            return;
        }
        a.pose = 0;
        if (d < 2.3 * a.scale && a.cooldown <= 0) { a.state = "windup"; a.stateT = 0; a.vx = 0; a.vz = 0; return; }
        // Zig-zag in.
        a.strafeT -= dt;
        if (a.strafeT <= 0) { a.strafe = -a.strafe; a.strafeT = 0.8 + rng.next() * 1.2; }
        const ux = (tp[0] - a.x) / Math.max(d, 1e-3), uz = (tp[2] - a.z) / Math.max(d, 1e-3);
        const side = d > 8 ? 3.5 * a.strafe : 0;
        walk(a, tp[0] - ux * 1.6 + uz * side, tp[2] - uz * 1.6 - ux * side, 5.6 * (a.pace ?? 1), dt, w);
        a.state = "move";
        return;
    }
    if (a.role === "gunner") { stepGunner(c, a, dt, p, w, opts, tp, d); return; }
    // Seers mend their own: every few seconds the most hurt ally near them is healed.
    if (a.kind === "seer" && a.cooldown <= 0.5 && a.state !== "cast") {
        let worst: Actor | null = null;
        for (const o of c.actors) if (o !== a && alive(o) && o.faction === a.faction && o.hp < o.maxHp * 0.8 && Math.hypot(o.x - a.x, o.z - a.z) < 18 && (!worst || o.hp / o.maxHp < worst.hp / worst.maxHp)) worst = o;
        if (worst) {
            worst.hp = Math.min(worst.maxHp, worst.hp + 40);
            c.events.push({ kind: "heal", actor: a, target: worst });
            a.cooldown = 5;
            a.pose = 2;
            return;
        }
    }
    // Casters keep their distance and throw.
    if (a.state === "cast") {
        a.pose = 2; face(a, tp, dt);
        if (a.stateT > 0.85) {
            const lead: V3 = [tp[0] + (rng.next() - 0.5) * 2.2 / opts.wardenAccuracy, tp[1], tp[2] + (rng.next() - 0.5) * 2.2 / opts.wardenAccuracy];
            const pw = a.power ?? 1;
            castBolt(c, a, rng.next() < 0.55 * opts.wardenAccuracy ? a.target : null, lead, a.look === "adept" ? { color: [1, 0.78, 0.35], damage: 26 * pw } : a.kind === "seer" ? { color: [0.6, 1, 0.75], damage: 18 * pw, speed: 24 } : { damage: 22 * pw });
            a.state = "move"; a.stateT = 0; a.cooldown = 2.2 + rng.next() * 1.8;
        }
        return;
    }
    a.pose = 0;
    a.strafeT -= dt;
    if (a.strafeT <= 0) { a.strafe = rng.next() < 0.5 ? -1 : 1; a.strafeT = 1.4 + rng.next() * 2; }
    const ux = (tp[0] - a.x) / Math.max(d, 1e-3), uz = (tp[2] - a.z) / Math.max(d, 1e-3);
    let gx = a.x + uz * a.strafe * 3, gz = a.z - ux * a.strafe * 3;
    if (d < 16) { gx -= ux * 6; gz -= uz * 6; }
    if (d > 48) { gx += ux * 6; gz += uz * 6; }
    // Cover: a caster with a barricade near steps in behind it and throws over the top.
    if (w.coverNear && d > 12) {
        // (A new look round every few seconds, not every frame.)
        if (a.stateT > 6 || (!a.goal && a.stateT > 1.5)) { a.goal = w.coverNear(a.x, a.z, tp, 16); a.stateT = 0; }
        if (a.goal) { gx = a.goal[0]; gz = a.goal[1]; }
    }
    walk(a, gx, gz, 3.4 * (a.pace ?? 1), dt, w);
    face(a, tp, dt);
    if (a.cooldown <= 0 && d < 70 && w.clear([a.x, a.y + 1.8, a.z], tp)) { a.state = "cast"; a.stateT = 0; }
}

/**
 * The Deep Bore's rogue synthetics: they keep their distance like casters (behind cover when they
 * find it) and fire coil-slug bursts, but only with a clear line.
 */
function stepGunner(c: CombatState, a: Actor, dt: number, p: PlayerView, w: CombatWorld, opts: StepOptions, tp: V3, d: number): void {
    const rng = c.rng;
    const ux = (tp[0] - a.x) / Math.max(d, 1e-3), uz = (tp[2] - a.z) / Math.max(d, 1e-3);
    a.strafeT -= dt;
    if (a.strafeT <= 0) { a.strafe = rng.next() < 0.5 ? -1 : 1; a.strafeT = 1.6 + rng.next() * 2; }
    let gx = a.x + uz * a.strafe * 3, gz = a.z - ux * a.strafe * 3;
    if (d < 14) { gx -= ux * 5; gz -= uz * 5; }
    if (d > 60) { gx += ux * 6; gz += uz * 6; }
    if (w.coverNear && d > 12) {
        if (a.stateT > 6 || (!a.goal && a.stateT > 1.5)) { a.goal = w.coverNear(a.x, a.z, tp, 14); a.stateT = 0; }
        if (a.goal) { gx = a.goal[0]; gz = a.goal[1]; }
    }
    walk(a, gx, gz, 3.2 * (a.pace ?? 1), dt, w);
    face(a, tp, dt);
    a.pose = 1;
    if (a.cooldown > 0) return;
    const eye: V3 = [a.x, a.y + 1.5 * a.scale, a.z];
    if (!w.clear(eye, tp)) { a.cooldown = 0.4; return; }
    if (a.burst <= 0) a.burst = 3 + Math.floor(rng.next() * 3);
    const chance = Math.max(0.06, Math.min(0.5, 0.55 - d / 160)) * opts.wardenAccuracy;
    fireSlug(c, a, tp, a.target, chance, 14 * (a.power ?? 1), p, w);
    a.burst--;
    a.cooldown = a.burst > 0 ? 0.12 : 1.1 + rng.next() * 1.0;
}

/** The player's slug: the first actor along the ray (capsules) before the terrain. */
export function rayHitActor(c: CombatState, from: V3, dir: V3, range: number, faction: Faction, terrainT: number): { actor: Actor; t: number } | null {
    let best: { actor: Actor; t: number } | null = null;
    for (const a of c.actors) {
        if (!alive(a) || a.faction !== faction) continue;
        // Closest approach of the ray to the actor's vertical axis, within its height.
        const ox = a.x - from[0], oz = a.z - from[2];
        const h2 = dir[0] * dir[0] + dir[2] * dir[2];
        let t = h2 > 1e-8 ? (ox * dir[0] + oz * dir[2]) / h2 : 0;
        if (t < 0 || t > range || t > terrainT) continue;
        const px = from[0] + dir[0] * t - a.x, pz = from[2] + dir[2] * t - a.z;
        const r = 0.42 * a.scale;
        if (px * px + pz * pz > r * r) continue;
        const y = from[1] + dir[1] * t;
        if (y < a.y - 0.05 || y > a.y + 1.85 * a.scale) continue;
        if (!best || t < best.t) best = { actor: a, t };
    }
    return best;
}

/** Wardens hit by a swing in front of Alex. */
export function meleeHits(c: CombatState, x: number, z: number, yaw: number, reach: number, arc: number): Actor[] {
    return c.actors.filter(a => {
        if (!alive(a) || a.faction !== "below") return false;
        const d = Math.hypot(a.x - x, a.z - z);
        if (d > reach + 0.4) return false;
        const ang = Math.abs(wrap(Math.atan2(a.x - x, a.z - z) - yaw));
        return ang < arc;
    });
}

/** Throws every warden near `at` back and sets them fleeing to `away` (the surge). */
export function surge(c: CombatState, at: V3, radius: number, away: [number, number]): number {
    let n = 0;
    for (const a of c.actors) {
        if (!alive(a) || a.faction !== "below") continue;
        const d = Math.hypot(a.x - at[0], a.z - at[2]);
        if (d < radius * 0.35 && a.role !== "leader") { kill(c, a, "player"); n++; continue; }
        a.state = "flee"; a.goal = [away[0] + (c.rng.next() - 0.5) * 60, away[1] + (c.rng.next() - 0.5) * 40]; a.stateT = 0;
        if (d < radius) { const k = (1 - d / radius) * 6; a.x += (a.x - at[0]) / Math.max(d, 1) * k; a.z += (a.z - at[2]) / Math.max(d, 1) * k; }
    }
    c.bolts = [];
    c.wardensPassive = false;
    return n;
}
