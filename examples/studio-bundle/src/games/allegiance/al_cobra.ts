// The Cobra: the regime's flying tank. One stands in the courtyard of every military compound
// (al_military.ts). Walk up and take it: it flies like your car (al_vehicle.ts stepCar) but heavier
// and slower, behind an armored hull, and it fires solar missiles from the pods on its flanks.
//
// Solar missiles: the panels on its back charge cells (8 rounds); each missile spends one. They
// charge fastest under a high sun and a clear sky, slowly at dawn, dusk and under cloud. A missile
// flies at the point under the crosshair (or tracks the soldier there), and explodes on the
// ground, a building, a soldier or at the end of its flight (al_fx.ts explode, al_destruction.ts).
//
// Enemy fire hits the hull rather than you while you are aboard (al_street.ts player.hull). When
// the hull fails, the Cobra explodes, you are thrown clear (hurt) and its wreck burns.
//
// Plain data and pure steps, like the car.

import { type CarSpec, type FlyingCar } from "./al_vehicle";
import { type Rect, segmentHitsRect } from "./al_nav";
import { type CompoundLayout } from "./al_military";

/** Flight: heavier than the car - slower cruise and boost, a lower ceiling. */
export const COBRA_SPEC: CarSpec = { cruise: 16, boostStart: 28, boostMax: 70, boostRamp: 6, climb: 7, ceiling: 350 };
export const COBRA_HULL = 600;
/** Solar cells: missiles held when fully charged. */
export const COBRA_CELLS = 8;
/** Seconds between missiles (the pods alternate). */
export const COBRA_FIRE_INTERVAL = 0.35;
export const MISSILE_SPEED = 95;
export const MISSILE_LAUNCH_SPEED = 35;
export const MISSILE_LIFE = 4;
/** Explosion: blast radius (m), damage at its heart (soldiers; buildings take BUILDING_DAMAGE). */
export const MISSILE_RADIUS = 8;
export const MISSILE_DAMAGE = 180;
export const MISSILE_BUILDING_DAMAGE = 260;

export interface CobraState {
    /** The compound it came from. */
    home: string;
    hull: number;
    /** Charged cells (fractional while charging). */
    cells: number;
    /** Seconds until the next missile may fire, and which pod fires next. */
    cooldown: number;
    pod: 0 | 1;
}

export const newCobraState = (home: string, hull = COBRA_HULL): CobraState => ({ home, hull, cells: COBRA_CELLS, cooldown: 0, pod: 0 });

/**
 * Cells charged per second: `sunUp` is the sun's elevation sine (negative: night), `cloud` the
 * cloud cover (0..1). About one a second at noon under a clear sky, a fifth of that at dusk.
 */
export function solarRate(sunUp: number, cloud: number): number {
    const sun = Math.max(0, Math.min(1, sunUp));
    return 0.12 + 0.9 * sun * (1 - 0.6 * Math.max(0, Math.min(1, cloud)));
}

export function chargeCobra(s: CobraState, dt: number, sunUp: number, cloud: number): void {
    s.cooldown = Math.max(0, s.cooldown - dt);
    s.cells = Math.min(COBRA_CELLS, s.cells + solarRate(sunUp, cloud) * dt);
}

/** Where a compound keeps its Cobra (compound space): in the courtyard behind the flag. */
export function cobraSpot(layout: CompoundLayout): [number, number] {
    return [0, -layout.radius * 0.4];
}

// --- Missiles ------------------------------------------------------------------------------------

export interface Missile {
    id: number;
    x: number; y: number; z: number;
    vx: number; vy: number; vz: number;
    /** Where it was aimed, and the soldier it tracks (null: the point). */
    tx: number; ty: number; tz: number;
    target: number | null;
    age: number;
    /** Over its point: no more steering. */
    arrived?: boolean;
}

/** The pods on the Cobra's flanks (model space: +x right, +y up, -z forward). */
const PODS: [number, number, number][] = [[-1.95, 1.05, -0.9], [1.95, 1.05, -0.9]];

/** A pod's position in the local frame. */
export function podPosition(c: Pick<FlyingCar, "x" | "y" | "z" | "yaw">, pod: 0 | 1): [number, number, number] {
    const [mx, my, mz] = PODS[pod];
    // Right is (cos yaw, -sin yaw); forward (model -z) is (sin yaw, cos yaw).
    const rx = Math.cos(c.yaw), rz = -Math.sin(c.yaw), fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
    return [c.x + rx * mx - fx * mz, c.y + my, c.z + rz * mx - fz * mz];
}

/** Fires one missile at (tx, ty, tz) if a cell is charged and the pods are ready. */
export function fireMissile(c: Pick<FlyingCar, "x" | "y" | "z" | "yaw" | "vx" | "vy" | "vz">, s: CobraState, target: [number, number, number], targetId: number | null, id: number): Missile | null {
    if (s.cooldown > 0 || s.cells < 1) return null;
    s.cells -= 1;
    s.cooldown = COBRA_FIRE_INTERVAL;
    const [x, y, z] = podPosition(c, s.pod);
    s.pod = s.pod ? 0 : 1;
    const dx = target[0] - x, dy = target[1] - y, dz = target[2] - z, d = Math.hypot(dx, dy, dz) || 1;
    return { id, x, y, z, vx: c.vx + dx / d * MISSILE_LAUNCH_SPEED, vy: c.vy + dy / d * MISSILE_LAUNCH_SPEED, vz: c.vz + dz / d * MISSILE_LAUNCH_SPEED,
        tx: target[0], ty: target[1], tz: target[2], target: targetId, age: 0 };
}

export interface MissileWorld {
    height(x: number, z: number): number;
    rects: readonly Rect[];
    /** Soldiers (alive) that a missile can strike, and the one it tracks. */
    soldiers: readonly { id: number; x: number; y: number; z: number }[];
}

export interface Impact { x: number; y: number; z: number; kind: "ground" | "building" | "soldier" | "air"; key?: string; soldier?: number }

/** Steps the missiles; returns those that struck (removed from `ms`). */
export function stepMissiles(ms: Missile[], dt: number, w: MissileWorld): Impact[] {
    const hits: Impact[] = [];
    const steps = Math.max(1, Math.ceil(dt / 0.01));
    const h = dt / steps;
    for (let i = ms.length - 1; i >= 0; i--) {
        const m = ms[i];
        let impact: Impact | null = null;
        for (let k = 0; k < steps && !impact; k++) {
            m.age += h;
            const tracked = m.target !== null ? w.soldiers.find(s => s.id === m.target) : undefined;
            if (tracked) { m.tx = tracked.x; m.ty = tracked.y + 1; m.tz = tracked.z; }
            // Accelerates to cruise speed and steers toward the target (a firm turn, not a snap). Once
            // over its point it flies straight on into whatever is there (a wall, the ground).
            const dx = m.tx - m.x, dy = m.ty - m.y, dz = m.tz - m.z, d = Math.hypot(dx, dy, dz) || 1;
            if (!tracked && d < 3) m.arrived = true;
            const speed = Math.min(MISSILE_SPEED, Math.hypot(m.vx, m.vy, m.vz) + 140 * h);
            const turn = m.arrived ? 0 : 1 - Math.exp(-6 * h);
            let vx = m.vx + (dx / d * speed - m.vx) * turn, vy = m.vy + (dy / d * speed - m.vy) * turn, vz = m.vz + (dz / d * speed - m.vz) * turn;
            const n = Math.hypot(vx, vy, vz) || 1;
            vx = vx / n * speed; vy = vy / n * speed; vz = vz / n * speed;
            m.vx = vx; m.vy = vy; m.vz = vz;
            const ax = m.x, az = m.z;
            m.x += vx * h; m.y += vy * h; m.z += vz * h;
            // Soldiers: within a meter and a half of the body.
            for (const s of w.soldiers) {
                if (Math.hypot(s.x - m.x, s.z - m.z) < 1.5 && m.y > s.y - 0.3 && m.y < s.y + 2.2) { impact = { x: m.x, y: m.y, z: m.z, kind: "soldier", soldier: s.id }; break; }
            }
            if (impact) break;
            for (const r of w.rects) {
                if (Math.abs(r.cx - m.x) > r.hw + r.hd + 4 || Math.abs(r.cz - m.z) > r.hw + r.hd + 4) continue;
                if (m.y > r.base + r.height || m.y < r.base - 1) continue;
                const t = segmentHitsRect(r, ax, az, m.x, m.z);
                if (t !== null) {
                    impact = { x: ax + (m.x - ax) * t, y: m.y, z: az + (m.z - az) * t, kind: "building", key: r.key };
                    break;
                }
            }
            if (impact) break;
            const g = w.height(m.x, m.z);
            if (m.y <= g + 0.2) impact = { x: m.x, y: g + 0.3, z: m.z, kind: "ground" };
            else if (m.age >= MISSILE_LIFE) impact = { x: m.x, y: m.y, z: m.z, kind: "air" };
        }
        if (impact) { hits.push(impact); ms.splice(i, 1); }
    }
    return hits;
}

/** Recenters missiles when the local frame moves by (dx, dz). */
export function shiftMissiles(ms: Missile[], dx: number, dz: number): void {
    for (const m of ms) { m.x -= dx; m.z -= dz; m.tx -= dx; m.tz -= dz; }
}

/**
 * Where the crosshair points: marches the camera ray (local) to the ground or the first building
 * (rects) within `range`, returning the point (the far end when it meets nothing).
 */
export function aimPoint(eye: [number, number, number], dir: [number, number, number], range: number, height: (x: number, z: number) => number, rects: readonly Rect[]): [number, number, number] {
    let best = range;
    const ex = eye[0] + dir[0] * range, ez = eye[2] + dir[2] * range;
    for (const r of rects) {
        if (r.key.startsWith("al-cobra") || r.key === "al-player-car") continue;
        const reach = range + r.hw + r.hd;
        if (Math.abs(r.cx - eye[0]) > reach || Math.abs(r.cz - eye[2]) > reach) continue;
        const t = segmentHitsRect(r, eye[0], eye[2], ex, ez);
        if (t === null) continue;
        const along = t * range, y = eye[1] + dir[1] * along;
        if (along < best && y < r.base + r.height && y > r.base - 1) best = along;
    }
    // The ground, marched in 2 m steps then refined.
    let prev = 0;
    for (let t = 2; t <= best; t += 2) {
        const x = eye[0] + dir[0] * t, y = eye[1] + dir[1] * t, z = eye[2] + dir[2] * t;
        if (y <= height(x, z)) {
            let lo = prev, hi = t;
            for (let k = 0; k < 6; k++) {
                const mid = (lo + hi) / 2;
                if (eye[1] + dir[1] * mid <= height(eye[0] + dir[0] * mid, eye[2] + dir[2] * mid)) hi = mid; else lo = mid;
            }
            best = hi;
            break;
        }
        prev = t;
    }
    return [eye[0] + dir[0] * best, eye[1] + dir[1] * best, eye[2] + dir[2] * best];
}

/**
 * At dawn: a compound whose Cobra was taken and lost (wrecked, or swapped for another) gets a new
 * one; the one you are keeping stays yours.
 */
export function restoreCobras(compounds: Record<string, { cobraTaken?: boolean }>, keeping: string | null): number {
    let n = 0;
    for (const [id, cs] of Object.entries(compounds)) if (cs.cobraTaken && id !== keeping) { cs.cobraTaken = false; n++; }
    return n;
}
