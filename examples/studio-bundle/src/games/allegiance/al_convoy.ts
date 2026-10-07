// Comrades' own flying cars. When you take off with comrades on foot, they climb into cars of their
// own (four to a car, at most three cars) and fly with you in formation: two off your rear
// quarters, one behind. When you set down they land beside you on the autopilot that brings your
// car when called (al_vehicle.ts callCar), and climb out to follow you again. Comrades told to hold
// a spot stay behind.
//
// This module is the flying; the addon decides who rides, draws the cars and carries the riders.

import { BASE_CAR, carFloor, flightClear, newCar, type CarSpec, type FlightEnvironment, type FlyingCar } from "./al_vehicle";

export const CONVOY_SEATS = 4;
export const CONVOY_MAX = 3;

export interface ConvoyCar {
    car: FlyingCar;
    /** Street actor ids riding in it. */
    riders: number[];
}

/** Cars needed to carry `comrades`. */
export const convoySize = (comrades: number): number => Math.min(CONVOY_MAX, Math.ceil(Math.max(0, comrades) / CONVOY_SEATS));

/** Where escort `i` flies relative to the leader: [right, back] in meters (two off its rear quarters, then one behind). */
export function escortOffset(i: number): [number, number] {
    if (i === 0) return [-9, 11];
    if (i === 1) return [9, 11];
    return [0, 22 + (i - 2) * 10];
}

/** Escort `i`'s spot (local x, z) behind a leader at (x, z) facing `yaw`. */
export function escortSlot(i: number, leader: { x: number; z: number; yaw: number }): [number, number] {
    const [right, back] = escortOffset(i);
    const fx = Math.sin(leader.yaw), fz = Math.cos(leader.yaw);
    return [leader.x - fx * back + fz * right, leader.z - fz * back - fx * right];
}

/** A new convoy car standing at (x, z), facing `yaw`. */
export function convoyCar(x: number, z: number, yaw: number, env: FlightEnvironment): ConvoyCar {
    const car = newCar({ x, y: carFloor(x, z, env), z, yaw });
    return { car, riders: [] };
}

function turnToward(h: number, target: number, rate: number): number {
    let d = target - h;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return h + Math.max(-rate, Math.min(rate, d));
}

/**
 * One step of escort `i` flying in formation on `leader`: it closes on its slot (faster than the
 * leader, so it catches up), holds the leader's height (never lower than a few meters over what is
 * beneath), and climbs over anything in its way.
 */
export function stepEscort(c: FlyingCar, i: number, leader: FlyingCar, dt: number, env: FlightEnvironment, spec: CarSpec = BASE_CAR): void {
    const steps = Math.max(1, Math.ceil(Math.min(dt, 0.25) / 0.02));
    const h = Math.min(dt, 0.25) / steps;
    const leadSpeed = Math.hypot(leader.vx, leader.vz);
    for (let k = 0; k < steps; k++) {
        const [sx, sz] = escortSlot(i, leader);
        const dx = sx - c.x, dz = sz - c.z, d = Math.hypot(dx, dz);
        // Match the leader's velocity, plus a pull toward the slot.
        const maxSpeed = Math.max(spec.cruise, leadSpeed) + 25;
        let tx = leader.vx + dx * 1.2, tz = leader.vz + dz * 1.2;
        const ts = Math.hypot(tx, tz);
        if (ts > maxSpeed) { tx *= maxSpeed / ts; tz *= maxSpeed / ts; }
        const floor = carFloor(c.x, c.z, env);
        const wantY = Math.max(leader.y + (i === 2 ? 3 : 1.5), floor + 4);
        const ty = Math.max(-spec.climb * 2, Math.min(spec.climb * 2, (wantY - c.y) * 1.5));
        const blend = 1 - Math.exp(-3 * h);
        c.vx += (tx - c.vx) * blend; c.vz += (tz - c.vz) * blend; c.vy += (ty - c.vy) * blend;
        const next = { ...c, x: c.x + c.vx * h, z: c.z + c.vz * h };
        if (flightClear(next, env)) { c.x = next.x; c.z = next.z; }
        else { c.vx *= 0.2; c.vz *= 0.2; c.vy = Math.max(c.vy, spec.climb * 1.5); }
        const f2 = carFloor(c.x, c.z, env);
        const ny = Math.max(f2, c.y + c.vy * h);
        if (flightClear({ ...c, y: ny }, env)) c.y = ny; else c.vy = Math.max(0, c.vy);
        c.yaw = turnToward(c.yaw, d > 25 ? Math.atan2(dx, dz) : leader.yaw, h * 2.5);
        c.state = "flying";
    }
}
