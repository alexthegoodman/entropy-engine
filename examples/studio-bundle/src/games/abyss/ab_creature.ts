// Kesh: the skywing Alex finds in Chapter Two (Mesha's creature.skywing), as plain data and pure
// steps. It lies wounded until he calms it and heals it with the river's water; then it rests
// where it is, comes when he whistles (flying to him and landing at his side), and carries him.
//
// Flight is arcade gliding, built to feel good rather than to be aerodynamics:
// - airspeed eases toward a throttle setting (slow, cruise, boost); diving trades height for
//   speed and climbing trades it back, so swooping off a wall carries you far;
// - the look controls (mouse, stick, arrows, the same feel as on foot) steer heading and pitch;
//   it banks into turns by itself;
// - a wingbeat (space) climbs hard, at the cost of stamina; boosting (shift) spends it too, and
//   gliding wins it back;
// - below a stall speed it hovers on beating wings, and close to the ground it can set down;
// - it never flies into the ground: low over rising terrain it pulls up, and the map's edge
//   turns it back.
// Wings beat (`flap` phase, `beat` 0..1 amplitude) and fold (`fold` 0..1) for the renderer.

import type { V3 } from "./ab_world";

export type CreatureMode = "wounded" | "rest" | "fly" | "land" | "ridden";

export interface Creature {
    x: number; y: number; z: number;
    yaw: number; pitch: number; roll: number;
    /** Airspeed (m/s) along the heading, and climb rate. */
    speed: number;
    vy: number;
    mode: CreatureMode;
    grounded: boolean;
    /** Wingbeat phase (radians), amplitude 0..1, and how folded the wings are 0..1. */
    flap: number;
    beat: number;
    fold: number;
    /** 0..1: how far Alex has calmed it. */
    trust: number;
    healed: boolean;
    stamina: number;
    /** Where it is flying to (summoned) and where it lands. */
    goal: V3 | null;
    /** Seconds since it last cried out (the game plays the sound). */
    cryT: number;
    /** Seconds in the air this flight. */
    airT: number;
    /** Throttle setting while ridden: 0 slow, 1 cruise, 2 boost. */
    throttle: number;
}

export const LENGTH = 9;
export const STALL = 9, SLOW = 14, CRUISE = 32, BOOST = 56, MAX_ALT = 520;
/** Height of the saddle above its feet (skywingSeat for LENGTH). */
export const SEAT = 2.5;

export function newCreature(x: number, z: number, y: number, yaw = 0): Creature {
    return {
        x, y, z, yaw, pitch: 0, roll: 0, speed: 0, vy: 0, mode: "wounded", grounded: true,
        flap: 0, beat: 0, fold: 0.85, trust: 0, healed: false, stamina: 1, goal: null, cryT: 0, airT: 0, throttle: 1,
    };
}

export interface FlightInput {
    /** -1..1: slow down / speed up. */
    throttle: number;
    /** Look deltas this frame (radians), as on foot. */
    turnYaw: number;
    turnPitch: number;
    /** A wingbeat (held: beats again as stamina allows). */
    flap: boolean;
    boost: boolean;
    /** Set down (when low enough). */
    land: boolean;
}

export const NO_FLIGHT: FlightInput = { throttle: 0, turnYaw: 0, turnPitch: 0, flap: false, boost: false, land: false };

export interface CreatureWorld {
    ground(x: number, z: number): number;
    /** Map half size: beyond it, it turns back. */
    half: number;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function forward(c: Pick<Creature, "yaw" | "pitch">): V3 {
    const cp = Math.cos(c.pitch);
    return [Math.sin(c.yaw) * cp, Math.sin(c.pitch), Math.cos(c.yaw) * cp];
}

/** Height above the ground under it. */
export const altitude = (c: Creature, w: CreatureWorld): number => c.y - w.ground(c.x, c.z);

/** Takes off from the ground (it leaps up on a beat of its wings). */
export function takeOff(c: Creature): void {
    if (!c.grounded) return;
    c.grounded = false;
    c.vy = 9;
    c.speed = Math.max(c.speed, STALL + 2);
    c.pitch = 0.25;
    c.airT = 0;
}

/** Wings, fold and cry: what every mode shares. */
function animate(c: Creature, dt: number, beating: number): void {
    c.beat += (beating - c.beat) * Math.min(1, dt * 4);
    const rate = 5.5 + 3 * c.beat;
    c.flap += rate * dt * (0.25 + c.beat);
    const fold = c.grounded ? (c.mode === "wounded" ? 0.9 : 0.75) : 0;
    c.fold += (fold - c.fold) * Math.min(1, dt * 3);
    c.cryT += dt;
}

/** On the ground: settles its feet on the terrain, leans level. */
function stand(c: Creature, dt: number, w: CreatureWorld): void {
    c.y = w.ground(c.x, c.z);
    c.vy = 0;
    c.speed *= Math.max(0, 1 - dt * 4);
    c.pitch += (0 - c.pitch) * Math.min(1, dt * 4);
    c.roll += (0 - c.roll) * Math.min(1, dt * 4);
}

/** One step of the riderless creature: lying wounded, resting, or flying to its goal and landing there. */
export function stepCreature(c: Creature, dt: number, w: CreatureWorld): void {
    if (c.mode === "wounded" || c.mode === "rest") {
        stand(c, dt, w);
        c.grounded = true;
        // Breathing: the wings stir now and then.
        animate(c, dt, c.mode === "wounded" ? 0.05 : 0.08);
        return;
    }
    if (c.mode === "fly" || c.mode === "land") {
        const g = c.goal;
        if (!g) { c.mode = "land"; }
        if (c.grounded && g) takeOff(c);
        const tx = g ? g[0] : c.x, tz = g ? g[2] : c.z;
        const d = Math.hypot(tx - c.x, tz - c.z);
        const ground = w.ground(c.x, c.z);
        // Cruise high and fast toward it, then come in slow and low.
        const want = d > 60 ? CRUISE : Math.max(4, d * 0.45);
        c.speed += (want - c.speed) * Math.min(1, dt * 1.2);
        const wantYaw = d > 1 ? Math.atan2(tx - c.x, tz - c.z) : c.yaw;
        const dy = wrap(wantYaw - c.yaw);
        c.yaw += dy * Math.min(1, dt * 1.8);
        c.roll += (clamp(-dy * 1.2, -0.7, 0.7) - c.roll) * Math.min(1, dt * 3);
        const cruiseY = Math.max(ground, g ? w.ground(tx, tz) : ground) + (d > 120 ? 45 : Math.min(40, d * 0.3));
        const wantVy = clamp((cruiseY - c.y) * 0.8, -14, 12);
        c.vy += (wantVy - c.vy) * Math.min(1, dt * 2);
        c.pitch += (clamp(Math.atan2(c.vy, Math.max(4, c.speed)), -0.6, 0.6) - c.pitch) * Math.min(1, dt * 3);
        const h = Math.min(c.speed, d / Math.max(dt, 1e-3));
        c.x += Math.sin(c.yaw) * h * dt; c.z += Math.cos(c.yaw) * h * dt;
        c.y += c.vy * dt;
        const floor = w.ground(c.x, c.z);
        if (c.y < floor + 0.5) c.y = floor + 0.5;
        c.airT += dt;
        animate(c, dt, c.speed < 16 || c.vy > 2 ? 1 : 0.35);
        if (d < 3 && c.y - floor < 2.5) { c.grounded = true; c.mode = "rest"; c.goal = null; c.speed = 0; c.y = floor; }
        return;
    }
    // Ridden creatures are stepped by stepRidden.
}

/** One step carrying Alex. Returns true when it has set down (the game may let him off). */
export function stepRidden(c: Creature, input: FlightInput, dt: number, w: CreatureWorld): boolean {
    c.mode = "ridden";
    const ground = w.ground(c.x, c.z);
    if (c.grounded) {
        stand(c, dt, w);
        animate(c, dt, 0.1);
        c.stamina = Math.min(1, c.stamina + dt * 0.25);
        // Turning on the spot; any push forward or a wingbeat lifts off.
        c.yaw += input.turnYaw;
        if (input.throttle > 0.3 || input.flap) takeOff(c);
        return false;
    }
    c.airT += dt;
    // Throttle: slow, cruise, boost (boost and wingbeats spend stamina; gliding earns it back).
    const boosting = input.boost && c.stamina > 0.02;
    c.throttle = boosting ? 2 : clamp(c.throttle + input.throttle * dt * 1.6, 0, 1);
    const target = boosting ? BOOST : SLOW + (CRUISE - SLOW) * c.throttle;
    // Steering: the look turns heading and pitch; it banks into the turn.
    c.yaw += input.turnYaw;
    c.pitch = clamp(c.pitch + input.turnPitch, -1.1, 0.9);
    const turnRate = input.turnYaw / Math.max(dt, 1e-3);
    c.roll += (clamp(-turnRate * 0.35, -0.9, 0.9) - c.roll) * Math.min(1, dt * 3);
    // Energy: gravity along the flight path pulls speed down climbing and up diving.
    const sp = Math.sin(c.pitch);
    // Diving, the air holds it back less: a stoop builds speed well past cruise.
    const drag = boosting ? 1.4 : 0.7 * (1 - clamp(-sp, 0, 1) * 0.8);
    c.speed += (target - c.speed) * Math.min(1, dt * drag);
    c.speed -= sp * 9.81 * dt * 0.9;
    c.speed = clamp(c.speed, 0, 75);
    let beating = c.speed < STALL + 4 ? 1 : boosting ? 0.8 : c.pitch > 0.2 ? 0.7 : 0.2;
    // Wingbeat: a hard climb.
    if (input.flap && c.stamina > 0.04) {
        c.vy += 26 * dt;
        c.stamina -= dt * 0.22;
        beating = 1;
    }
    if (boosting) c.stamina -= dt * 0.12;
    if (!input.flap && !boosting) c.stamina = Math.min(1, c.stamina + dt * 0.08);
    c.stamina = Math.max(0, c.stamina);
    // Lift: above the stall it holds its height along the path; below it, the wings hover it and it sinks slowly.
    const pathVy = sp * c.speed;
    if (c.speed >= STALL) c.vy += (pathVy - c.vy) * Math.min(1, dt * 3);
    else c.vy += (Math.max(-3, pathVy) - c.vy) * Math.min(1, dt * 2) - 1.5 * dt;
    c.vy = clamp(c.vy, -45, 30);
    const h = Math.max(c.speed * Math.cos(c.pitch), c.speed < STALL ? c.speed : 0);
    let nx = c.x + Math.sin(c.yaw) * h * dt, nz = c.z + Math.cos(c.yaw) * h * dt;
    // The map's edge turns it back.
    const lim = w.half - 30;
    if (Math.abs(nx) > lim || Math.abs(nz) > lim) {
        c.yaw += wrap(Math.atan2(-c.x, -c.z) - c.yaw) * Math.min(1, dt * 1.5);
        nx = clamp(nx, -lim, lim); nz = clamp(nz, -lim, lim);
    }
    c.x = nx; c.z = nz;
    c.y += c.vy * dt;
    // Never into the ground: it pulls up over rising terrain; looking ahead, it climbs before a wall.
    const look = Math.min(40, c.speed * 0.9);
    const ahead = w.ground(c.x + Math.sin(c.yaw) * look, c.z + Math.cos(c.yaw) * look);
    const floor = Math.max(w.ground(c.x, c.z), ahead - 2);
    // Setting down, it is allowed all the way to the ground.
    const clear = input.land ? 0 : 2;
    if (c.y < floor + clear) {
        c.y += (floor + clear - c.y) * Math.min(1, dt * 6);
        if (c.vy < 0) c.vy *= 0.3;
        if (c.pitch < 0) c.pitch *= 0.85;
    }
    if (c.y > MAX_ALT) { c.y = MAX_ALT; c.vy = Math.min(0, c.vy); }
    animate(c, dt, beating);
    // Setting down: asked, and close above the ground, and slow enough to flare.
    const alt = c.y - w.ground(c.x, c.z);
    if (input.land && alt < 14 && c.airT > 0.5) {
        c.speed *= Math.max(0, 1 - dt * 3);
        c.vy = Math.min(c.vy, -4);
        c.pitch += (0.2 - c.pitch) * Math.min(1, dt * 4);
    }
    if (alt < 1.2 && c.speed < SLOW + 4 && c.airT > 0.5 && (input.land || c.speed < STALL)) {
        c.grounded = true;
        c.y = w.ground(c.x, c.z);
        c.vy = 0; c.speed = 0;
        return true;
    }
    void ground;
    return false;
}

/** Where Alex sits (world) and the creature's frame (right, up, forward), for the camera and the rider. */
export function creatureFrame(c: Creature): { right: V3; up: V3; forward: V3 } {
    const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch), cr = Math.cos(c.roll), sr = Math.sin(c.roll);
    const f: V3 = [sy * cp, sp, cy * cp];
    const r0: V3 = [cy, 0, -sy];
    const u0: V3 = [-sy * sp, cp, -cy * sp];
    return {
        forward: f,
        right: [r0[0] * cr - u0[0] * sr, r0[1] * cr - u0[1] * sr, r0[2] * cr - u0[2] * sr],
        up: [r0[0] * sr + u0[0] * cr, r0[1] * sr + u0[1] * cr, r0[2] * sr + u0[2] * cr],
    };
}

export function seatPosition(c: Creature): V3 {
    const f = creatureFrame(c);
    return [c.x + f.up[0] * SEAT - f.forward[0] * 0.1, c.y + f.up[1] * SEAT - f.forward[1] * 0.1, c.z + f.up[2] * SEAT - f.forward[2] * 0.1];
}

/** The chase camera behind and above the rider; wider and further back with speed. */
export function chaseCamera(c: Creature, prev: { pos: V3; target: V3 } | null, dt: number, ground: (x: number, z: number) => number): { pos: V3; target: V3; fov: number } {
    const f = forward(c);
    const k = clamp((c.speed - SLOW) / (BOOST - SLOW), 0, 1);
    const back = 13 + k * 7, up = 4.2 + k * 1.2;
    const flat = Math.hypot(f[0], f[2]) || 1;
    const fx = f[0] / flat, fz = f[2] / flat;
    let pos: V3 = [c.x - fx * back, c.y + SEAT + up - f[1] * back * 0.5, c.z - fz * back];
    const floor = ground(pos[0], pos[2]) + 1.5;
    if (pos[1] < floor) pos[1] = floor;
    const target: V3 = [c.x + f[0] * 18, c.y + SEAT + 1.2 + f[1] * 18, c.z + f[2] * 18];
    if (prev) {
        const a = 1 - Math.exp(-dt * 6);
        pos = [prev.pos[0] + (pos[0] - prev.pos[0]) * a, prev.pos[1] + (pos[1] - prev.pos[1]) * a, prev.pos[2] + (pos[2] - prev.pos[2]) * a];
    }
    return { pos, target, fov: 55 + k * 16 };
}
