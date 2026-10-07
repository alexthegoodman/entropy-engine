// Fire and explosions, as particles in the street's local frame (x east, y up, z north).
//
// - An explosion is a flash, a few fireballs that swell and burn out, sparks thrown on arcs,
//   a column of smoke that rises and spreads with the wind, debris (al_destruction.ts pieces), a
//   scorch mark on the ground and usually a fire left burning.
// - A fire burns for a while: flames lick up from it and smoke rises off it. Fires stand on
//   blast craters, in collapsed buildings and on wrecks; they hurt soldiers (and you) who stand
//   in them. Civilians only run from them, as from gunfire (al_street.ts).
//
// Particles are drawn as instanced meshes (allegiance_addon.ts drawFx): a lumpy fireball or flame
// in the fire material and a lumpy puff in the smoke material (al_shader.ts MAT_FIRE/MAT_SMOKE).
// Each fades out by ordered dither (the record's tex_origin.w), so nothing needs blending.
// Everything here is plain data with deterministic steps from its own RNG.

import { makeRng, type Rng } from "./al_rng";

type RGB = [number, number, number];

export type ParticleKind = "fire" | "smoke" | "spark";

export interface Particle {
    kind: ParticleKind;
    x: number; y: number; z: number;
    vx: number; vy: number; vz: number;
    /** Radius now, and how fast it swells (m/s). */
    size: number;
    grow: number;
    life: number;
    age: number;
    /** Turn about up (variety) and its rate. */
    spin: number;
    spinRate: number;
    /** Color (fire: hot to cool; smoke: grey) and fire's brightness. */
    tint: RGB;
    heat: number;
    /** Rises (smoke, flames) or falls (sparks). */
    buoyancy: number;
    /** A tongue of flame (drawn tall and pointed) rather than a ball. */
    flame?: boolean;
}

export interface Fire {
    id: number;
    x: number; y: number; z: number;
    radius: number;
    life: number;
    age: number;
    /** Particles owed (fractional emission). */
    flameDebt: number;
    smokeDebt: number;
    /** The building burning, if any (so a rebuilt ruin's fire can go). */
    key?: string;
}

export interface Scorch { x: number; z: number; radius: number; yaw: number }

export interface FxState {
    particles: Particle[];
    fires: Fire[];
    scorches: Scorch[];
    nextFire: number;
    rng: Rng;
    /** Camera shake (0..1), decaying. */
    shake: number;
    /** Explosions so far (tests, the state tool). */
    explosions: number;
}

export const MAX_PARTICLES = 900;
export const MAX_FIRES = 40;
export const MAX_SCORCHES = 48;

export function newFx(seed = 7): FxState {
    return { particles: [], fires: [], scorches: [], nextFire: 1, rng: makeRng(seed), shake: 0, explosions: 0 };
}

function emit(fx: FxState, p: Particle): void {
    if (fx.particles.length >= MAX_PARTICLES) return;
    fx.particles.push(p);
}

const FIRE_HOT: RGB = [1, 0.82, 0.45];
const FIRE_COOL: RGB = [1, 0.32, 0.08];

/**
 * An explosion of `power` (1: a solar missile) at (x, y, z). `ground` is the terrain height there;
 * an explosion near it scorches it and leaves a fire. `listener` is where you are (shake).
 */
export function explode(fx: FxState, x: number, y: number, z: number, power: number, ground: number, listener: [number, number, number] | null): void {
    const r = fx.rng;
    fx.explosions++;
    const R = 3.2 * Math.sqrt(power);
    // The flash: one big, brief, white-hot ball.
    emit(fx, { kind: "fire", x, y, z, vx: 0, vy: 0, vz: 0, size: R * 0.8, grow: R * 2.5, life: 0.22, age: 0, spin: 0, spinRate: 0, tint: [1, 0.95, 0.8], heat: 3, buoyancy: 0 });
    // Fireballs.
    const balls = Math.round(5 + 3 * power);
    for (let i = 0; i < balls; i++) {
        const a = r.next() * Math.PI * 2, e = r.next() * 0.9, s = (3 + r.next() * 6) * Math.sqrt(power);
        emit(fx, { kind: "fire", x, y, z, vx: Math.cos(a) * Math.cos(e) * s, vy: Math.sin(e) * s + 2, vz: Math.sin(a) * Math.cos(e) * s,
            size: R * (0.3 + r.next() * 0.25), grow: R * (0.8 + r.next() * 0.8), life: 0.55 + r.next() * 0.5, age: 0, spin: r.next() * 6.28, spinRate: (r.next() - 0.5) * 3,
            tint: i % 2 ? FIRE_HOT : FIRE_COOL, heat: 1.6, buoyancy: 4 });
    }
    // Sparks and burning bits on arcs.
    for (let i = 0; i < 10 + 6 * power; i++) {
        const a = r.next() * Math.PI * 2, up = 5 + r.next() * 12, out = 4 + r.next() * 14;
        emit(fx, { kind: "spark", x, y, z, vx: Math.cos(a) * out, vy: up, vz: Math.sin(a) * out, size: 0.07 + r.next() * 0.08, grow: -0.03, life: 0.8 + r.next() * 0.9,
            age: 0, spin: 0, spinRate: 0, tint: FIRE_HOT, heat: 2, buoyancy: -9.8 });
    }
    // Smoke: a dark column that rises and spreads.
    for (let i = 0; i < 8 + 4 * power; i++) {
        const a = r.next() * Math.PI * 2, s = r.next() * 3;
        const g = 0.16 + r.next() * 0.12;
        emit(fx, { kind: "smoke", x: x + Math.cos(a) * s * 0.4, y: y + r.next() * R * 0.6, z: z + Math.sin(a) * s * 0.4, vx: Math.cos(a) * s, vy: 1.5 + r.next() * 3, vz: Math.sin(a) * s,
            size: R * (0.35 + r.next() * 0.3), grow: 0.9 + r.next() * 0.8, life: 3 + r.next() * 3.5, age: -r.next() * 0.25, spin: r.next() * 6.28, spinRate: (r.next() - 0.5) * 0.4,
            tint: [g, g * 0.97, g * 0.95], heat: 0, buoyancy: 1.2 });
    }
    if (y - ground < R * 1.2) {
        fx.scorches.push({ x, z, radius: R * 0.9, yaw: r.next() * 6.28 });
        if (fx.scorches.length > MAX_SCORCHES) fx.scorches.shift();
        if (r.next() < 0.55 + 0.2 * power) ignite(fx, x, ground, z, 0.9 * Math.sqrt(power), 7 + r.next() * 6);
    }
    if (listener) {
        const d = Math.hypot(listener[0] - x, listener[1] - y, listener[2] - z);
        fx.shake = Math.min(1, fx.shake + power * Math.max(0, 1 - d / 120) * 0.8);
    }
}

/** A collapse: a dust cloud rolling out across the building's footprint (as wide as `size`). */
export function dustCloud(fx: FxState, x: number, y: number, z: number, size: number, height: number): void {
    const r = fx.rng;
    const n = Math.min(40, Math.round(10 + size * 0.8));
    for (let i = 0; i < n; i++) {
        const a = r.next() * Math.PI * 2, t = r.next();
        const g = 0.48 + r.next() * 0.12;
        emit(fx, { kind: "smoke", x: x + Math.cos(a) * size * 0.4 * t, y: y + r.next() * Math.min(height, 20) * 0.5, z: z + Math.sin(a) * size * 0.4 * t,
            vx: Math.cos(a) * (2 + r.next() * 4), vy: 0.5 + r.next() * 1.5, vz: Math.sin(a) * (2 + r.next() * 4),
            size: 1.5 + r.next() * 2 + size * 0.06, grow: 1 + r.next() * 1.2, life: 4 + r.next() * 4, age: -t * 0.6, spin: r.next() * 6.28, spinRate: (r.next() - 0.5) * 0.3,
            tint: [g, g * 0.95, g * 0.88], heat: 0, buoyancy: 0.5 });
    }
}

/** A missile's exhaust: a puff of pale smoke and a spark of flame where it is now. */
export function missileTrail(fx: FxState, x: number, y: number, z: number): void {
    const r = fx.rng;
    const g = 0.7 + r.next() * 0.15;
    emit(fx, { kind: "smoke", x, y, z, vx: (r.next() - 0.5) * 0.6, vy: 0.3, vz: (r.next() - 0.5) * 0.6, size: 0.25, grow: 0.9, life: 1.1 + r.next() * 0.6, age: 0,
        spin: r.next() * 6.28, spinRate: 0, tint: [g, g, g * 0.97], heat: 0, buoyancy: 0.2 });
    emit(fx, { kind: "fire", x, y, z, vx: 0, vy: 0, vz: 0, size: 0.32, grow: -0.6, life: 0.18, age: 0, spin: 0, spinRate: 0, tint: FIRE_HOT, heat: 2, buoyancy: 0 });
}

/** Starts a fire (or feeds one already burning on that spot). */
export function ignite(fx: FxState, x: number, y: number, z: number, radius: number, seconds: number, key?: string): Fire {
    for (const f of fx.fires) if (Math.hypot(f.x - x, f.z - z) < Math.max(f.radius, radius) * 0.8) {
        f.radius = Math.min(4, Math.max(f.radius, radius));
        f.life = Math.max(f.life, f.age + seconds);
        return f;
    }
    const f: Fire = { id: fx.nextFire++, x, y, z, radius, life: seconds, age: 0, flameDebt: 0, smokeDebt: 0, key };
    fx.fires.push(f);
    if (fx.fires.length > MAX_FIRES) fx.fires.shift();
    return f;
}

/** How strongly a fire burns now (0..1): it catches, holds, then dies down. */
export const fireStrength = (f: Fire): number => Math.min(1, f.age / 0.6) * Math.min(1, Math.max(0, (f.life - f.age) / 3));

/**
 * Steps everything: particles move (fire and smoke rise and drift with `wind`, local m/s; sparks
 * fall), swell and burn out; fires emit flames and smoke and go out when spent.
 */
export function stepFx(fx: FxState, dt: number, wind: [number, number], ground: (x: number, z: number) => number): void {
    const r = fx.rng;
    fx.shake = Math.max(0, fx.shake - dt * 1.8);
    for (const f of fx.fires) {
        f.age += dt;
        const s = fireStrength(f);
        f.flameDebt += dt * (6 + 10 * f.radius) * s;
        f.smokeDebt += dt * (1.2 + 1.6 * f.radius) * s;
        while (f.flameDebt >= 1) {
            f.flameDebt -= 1;
            const a = r.next() * Math.PI * 2, t = Math.sqrt(r.next()) * f.radius;
            emit(fx, { kind: "fire", x: f.x + Math.cos(a) * t, y: f.y + 0.1, z: f.z + Math.sin(a) * t, vx: 0, vy: 1.5 + r.next() * 2, vz: 0,
                size: (0.25 + r.next() * 0.35) * (0.6 + f.radius * 0.4) * (1.2 - t / Math.max(f.radius, 0.1) * 0.5), grow: -0.25, life: 0.45 + r.next() * 0.45, age: 0,
                spin: r.next() * 6.28, spinRate: (r.next() - 0.5) * 4, tint: r.next() < 0.5 ? FIRE_HOT : FIRE_COOL, heat: 1.2, buoyancy: 3.5, flame: true });
        }
        while (f.smokeDebt >= 1) {
            f.smokeDebt -= 1;
            const g = 0.13 + r.next() * 0.1;
            emit(fx, { kind: "smoke", x: f.x + (r.next() - 0.5) * f.radius, y: f.y + 1 + f.radius, z: f.z + (r.next() - 0.5) * f.radius, vx: 0, vy: 2 + r.next() * 1.5, vz: 0,
                size: 0.5 + f.radius * 0.4, grow: 0.7 + r.next() * 0.5, life: 4 + r.next() * 3, age: 0, spin: r.next() * 6.28, spinRate: (r.next() - 0.5) * 0.3,
                tint: [g, g, g * 0.97], heat: 0, buoyancy: 0.6 });
        }
    }
    fx.fires = fx.fires.filter(f => f.age < f.life);
    for (const p of fx.particles) {
        p.age += dt;
        if (p.age < 0) continue;
        if (p.kind === "spark") p.vy -= 9.8 * dt;
        else {
            p.vy += p.buoyancy * dt;
            // Air drag, and the wind takes rising smoke and flame.
            const drag = Math.exp(-(p.kind === "smoke" ? 0.9 : 2.2) * dt);
            p.vx = wind[0] + (p.vx - wind[0]) * drag; p.vz = wind[1] + (p.vz - wind[1]) * drag; p.vy *= Math.exp(-0.6 * dt);
        }
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        p.size = Math.max(0.02, p.size + p.grow * dt);
        p.spin += p.spinRate * dt;
        if (p.kind === "spark") {
            const g = ground(p.x, p.z);
            if (p.y < g) { p.y = g; p.vy = -p.vy * 0.3; p.vx *= 0.5; p.vz *= 0.5; }
        }
    }
    fx.particles = fx.particles.filter(p => p.age < p.life);
}

/** How opaque a particle is now (0..1): faded in quickly, out over its last part. */
export function particleOpacity(p: Particle): number {
    if (p.age < 0) return 0;
    const t = p.age / p.life;
    if (p.kind === "smoke") return Math.min(1, p.age / 0.3) * (1 - t) * 0.85;
    if (p.kind === "spark") return 1 - t * t;
    return 1 - t * t * t;
}

/** Fire color and brightness now: hot and bright at first, darker red as it burns out. */
export function particleGlow(p: Particle): { tint: RGB; heat: number } {
    const t = Math.max(0, Math.min(1, p.age / p.life));
    if (p.kind === "smoke") return { tint: p.tint, heat: 0 };
    const k = 1 - t * 0.7;
    return { tint: [p.tint[0], p.tint[1] * k, p.tint[2] * k * k], heat: p.heat * (1 - t * 0.6) };
}

/** Damage per second for standing at (x, z) (in the fires burning there). */
export function fireDamageAt(fx: FxState, x: number, z: number): number {
    let dps = 0;
    for (const f of fx.fires) {
        const d = Math.hypot(f.x - x, f.z - z);
        if (d < f.radius + 0.6) dps += 18 * fireStrength(f);
    }
    return dps;
}

/** Recenters everything when the local frame moves by (dx, dz). */
export function shiftFx(fx: FxState, dx: number, dz: number): void {
    for (const p of fx.particles) { p.x -= dx; p.z -= dz; }
    for (const f of fx.fires) { f.x -= dx; f.z -= dz; }
    for (const s of fx.scorches) { s.x -= dx; s.z -= dz; }
}

/** Clears everything (travel, a new campaign). */
export function clearFx(fx: FxState): void {
    fx.particles = []; fx.fires = []; fx.scorches = []; fx.shake = 0;
}
