// The expedition's rotorcraft (Mesha's transport.gunship): gunships circling over the crack with
// their searchlights, dropships flying the troops down on scripted paths, hovering over a landing
// zone, and - struck by the river's light - spinning down out of the sky and burning where they
// fall. Pure steps over plain data; the game draws them and spawns the fire.

import { catmull } from "./ab_cinema";
import type { V3 } from "./ab_world";

export type AircraftMode = "orbit" | "path" | "hover" | "crash" | "wreck" | "parked";

export interface PathPoint { t: number; pos: V3 }

export interface Aircraft {
    id: string;
    callsign: string;
    role: "gunship" | "dropship";
    pos: V3;
    vel: V3;
    yaw: number;
    pitch: number;
    roll: number;
    rotor: number;
    rotorSpeed: number;
    mode: AircraftMode;
    orbit?: { center: V3; radius: number; speed: number; phase: number; bob: number; dir: 1 | -1 };
    /** A scripted path in world time; at its end the aircraft hovers (or keeps its last mode). */
    path?: { points: PathPoint[]; start: number; then: "hover" | "orbit" | "parked" };
    hover?: { at: V3; yaw: number };
    crash?: { age: number; spin: number; smoke: number };
    searchlight: boolean;
    /** Where the searchlight points (world). */
    lightTarget: V3 | null;
    hp: number;
    /** Seconds since it fell (wreck). */
    burning: number;
}

export function newAircraft(id: string, callsign: string, role: Aircraft["role"], pos: V3, yaw = 0): Aircraft {
    return {
        id, callsign, role, pos: [...pos] as V3, vel: [0, 0, 0], yaw, pitch: 0, roll: 0, rotor: (id.length * 1.7) % 6.28, rotorSpeed: 32,
        mode: "hover", hover: { at: [...pos] as V3, yaw }, searchlight: role === "gunship", lightTarget: null, hp: 100, burning: 0,
    };
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export interface FlightEvent { kind: "crashed"; aircraft: Aircraft; at: V3 }

/** Position on a path at world time `time` (clamped to the path). */
export function pathPosition(points: PathPoint[], time: number): V3 {
    if (points.length === 1 || time <= points[0].t) return [...points[0].pos] as V3;
    const last = points[points.length - 1];
    if (time >= last.t) return [...last.pos] as V3;
    let i = 0;
    while (i < points.length - 2 && time > points[i + 1].t) i++;
    const p = (j: number) => points[Math.max(0, Math.min(points.length - 1, j))].pos;
    const u = (time - points[i].t) / Math.max(1e-6, points[i + 1].t - points[i].t);
    return catmull(p(i - 1), p(i), p(i + 1), p(i + 2), u);
}

/**
 * One step. `ground(x, z)` is the terrain height. Orbits and paths set the position directly and
 * derive heading, pitch (nose down to speed up) and bank (into turns) from the motion.
 */
export function stepAircraft(a: Aircraft, dt: number, time: number, ground: (x: number, z: number) => number): FlightEvent | null {
    a.rotor += a.rotorSpeed * dt;
    if (a.mode === "parked") { a.rotorSpeed = Math.max(0, a.rotorSpeed - dt * 6); return null; }
    if (a.mode === "wreck") { a.burning += dt; a.rotorSpeed = 0; return null; }
    a.rotorSpeed += (32 - a.rotorSpeed) * Math.min(1, dt * 0.8);
    const prev: V3 = [...a.pos] as V3;
    const prevVel: V3 = [...a.vel] as V3;
    let wantYaw = a.yaw;
    if (a.mode === "crash") {
        const c = a.crash ??= { age: 0, spin: 0.6, smoke: 0 };
        c.age += dt;
        c.spin = Math.min(5.5, c.spin + dt * 2.2);
        a.yaw += c.spin * dt;
        a.vel[1] -= 9.81 * dt * 0.75;
        a.vel[0] *= 1 - dt * 0.25; a.vel[2] *= 1 - dt * 0.25;
        a.pos = [a.pos[0] + a.vel[0] * dt, a.pos[1] + a.vel[1] * dt, a.pos[2] + a.vel[2] * dt];
        a.roll = Math.sin(c.age * 3.1) * 0.5 + 0.3;
        a.pitch = -0.25 - Math.min(0.5, c.age * 0.12);
        const g = ground(a.pos[0], a.pos[2]);
        if (a.pos[1] <= g + 1.2) {
            a.pos[1] = g + 0.8;
            a.mode = "wreck";
            a.vel = [0, 0, 0];
            a.roll = 0.35; a.pitch = -0.12;
            return { kind: "crashed", aircraft: a, at: [...a.pos] as V3 };
        }
        return null;
    }
    if (a.mode === "orbit" && a.orbit) {
        const o = a.orbit;
        o.phase += o.dir * (o.speed / o.radius) * dt;
        a.pos = [o.center[0] + Math.cos(o.phase) * o.radius, o.center[1] + Math.sin(time * 0.37 + o.phase * 2) * o.bob, o.center[2] + Math.sin(o.phase) * o.radius];
    } else if (a.mode === "path" && a.path) {
        const pts = a.path.points;
        a.pos = pathPosition(pts, time);
        if (time >= pts[pts.length - 1].t) {
            if (a.path.then === "hover") { a.mode = "hover"; a.hover = { at: [...a.pos] as V3, yaw: a.yaw }; }
            else if (a.path.then === "parked") { a.mode = "parked"; a.vel = [0, 0, 0]; a.pitch = 0; a.roll = 0; }
            else a.mode = "orbit";
        }
    } else if (a.mode === "hover" && a.hover) {
        // Critically damped approach to the hover point.
        const h = a.hover;
        const k = 1.6;
        for (let i = 0; i < 3; i++) {
            const acc = (h.at[i] - a.pos[i]) * k * k - a.vel[i] * 2 * k;
            a.vel[i] += acc * dt;
        }
        a.pos = [a.pos[0] + a.vel[0] * dt, a.pos[1] + a.vel[1] * dt + Math.sin(time * 1.3) * 0.15 * dt, a.pos[2] + a.vel[2] * dt];
        wantYaw = h.yaw;
    }
    if (a.mode !== "hover") a.vel = [(a.pos[0] - prev[0]) / Math.max(dt, 1e-6), (a.pos[1] - prev[1]) / Math.max(dt, 1e-6), (a.pos[2] - prev[2]) / Math.max(dt, 1e-6)];
    const speed = Math.hypot(a.vel[0], a.vel[2]);
    if (speed > 1.5 && a.mode !== "hover") wantYaw = Math.atan2(a.vel[0], a.vel[2]);
    const dy = wrap(wantYaw - a.yaw);
    a.yaw += dy * Math.min(1, dt * 1.8);
    // Bank into the turn (yaw grows turning toward +X, the model's +X side goes down); nose down
    // with speed and acceleration.
    const turnRate = dy * 1.8;
    a.roll += (Math.max(-0.45, Math.min(0.45, turnRate * Math.min(1, speed / 25) * 0.9)) - a.roll) * Math.min(1, dt * 2);
    const fwdAcc = ((a.vel[0] - prevVel[0]) * Math.sin(a.yaw) + (a.vel[2] - prevVel[2]) * Math.cos(a.yaw)) / Math.max(dt, 1e-6);
    const wantPitch = -Math.min(0.28, speed * 0.006) - Math.max(-0.15, Math.min(0.15, fwdAcc * 0.02));
    a.pitch += (wantPitch - a.pitch) * Math.min(1, dt * 1.5);
    return null;
}

/** Struck: it spins down from where it is, still moving the way it was. */
export function shootDown(a: Aircraft): void {
    if (a.mode === "crash" || a.mode === "wreck") return;
    a.mode = "crash";
    a.crash = { age: 0, spin: 0.8, smoke: 0 };
    a.hp = 0;
    a.searchlight = false;
    a.vel = [a.vel[0] * 0.8, Math.min(a.vel[1], 2), a.vel[2] * 0.8];
}

/** Sends it along a path starting now. */
export function fly(a: Aircraft, points: PathPoint[], then: "hover" | "orbit" | "parked" = "hover"): void {
    a.mode = "path";
    a.path = { points, start: points[0]?.t ?? 0, then };
}

export function orbit(a: Aircraft, center: V3, radius: number, speed: number, phase: number, dir: 1 | -1 = 1, bob = 6): void {
    a.mode = "orbit";
    a.orbit = { center, radius, speed, phase, bob, dir };
}

/** The aircraft's frame: right, up, forward (+Z model forward), from yaw, pitch and roll. */
export function aircraftFrame(a: Aircraft): { right: V3; up: V3; forward: V3 } {
    const cy = Math.cos(a.yaw), sy = Math.sin(a.yaw), cp = Math.cos(a.pitch), sp = Math.sin(a.pitch), cr = Math.cos(a.roll), sr = Math.sin(a.roll);
    const forward: V3 = [sy * cp, sp, cy * cp];
    const r0: V3 = [cy, 0, -sy];
    const u0: V3 = [-sy * sp, cp, -cy * sp];
    const right: V3 = [r0[0] * cr - u0[0] * sr, r0[1] * cr - u0[1] * sr, r0[2] * cr - u0[2] * sr];
    const up: V3 = [r0[0] * sr + u0[0] * cr, r0[1] * sr + u0[1] * cr, r0[2] * sr + u0[2] * cr];
    return { right, up, forward };
}
