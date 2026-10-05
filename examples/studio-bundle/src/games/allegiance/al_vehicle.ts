import { insideRect, type Rect } from "./al_nav";
import { type PlayerInput } from "./al_player";

export interface ParkedCar { x: number; y: number; z: number; yaw: number }
export interface FlyingCar extends ParkedCar {
    vx: number; vy: number; vz: number;
    piloting: boolean;
    state: "parked" | "hovering" | "flying" | "landing";
    /** 0..1: how far the boost has built up. Holding boost while moving charges it; letting go bleeds it off. */
    boost?: number;
}
export const newCar = (p: ParkedCar): FlyingCar => ({ ...p, vx: 0, vy: 0, vz: 0, piloting: false, state: "parked", boost: 0 });

/** How the car flies: speeds in m/s, the boost's build-up time, the climb rate and the ceiling above terrain. */
export interface CarSpec {
    cruise: number;
    /** Boost speed the moment it engages, and once fully built up. */
    boostStart: number;
    boostMax: number;
    /** Seconds of held boost to reach `boostMax`. */
    boostRamp: number;
    climb: number;
    ceiling: number;
}
export const BASE_CAR: CarSpec = { cruise: 20, boostStart: 35, boostMax: 120, boostRamp: 8, climb: 8, ceiling: 500 };

/** Garage upgrades: each line has three tiers, bought in order. */
export interface CarUpgradeDef { id: CarUpgradeId; name: string; blurb: string; prices: [number, number, number] }
export type CarUpgradeId = "turbine" | "capacitor" | "lift" | "gyro" | "ceiling";
export const CAR_UPGRADES: CarUpgradeDef[] = [
    { id: "turbine", name: "Turbines", blurb: "Top boost speed 120 -> 160 / 200 / 250 m/s.", prices: [1500, 4000, 9000] },
    { id: "capacitor", name: "Boost Capacitors", blurb: "Full boost in 8 -> 6 / 4.5 / 3 seconds.", prices: [1200, 3000, 7000] },
    { id: "gyro", name: "Gyro Rotors", blurb: "Cruise 20 -> 26 / 32 / 40 m/s and a stronger first kick.", prices: [1000, 2500, 6000] },
    { id: "lift", name: "Lift Fans", blurb: "Climb and descend 8 -> 12 / 16 / 22 m/s.", prices: [800, 2000, 5000] },
    { id: "ceiling", name: "Altitude Permit", blurb: "Ceiling 500 -> 1,000 / 1,500 / 2,500 m above the ground.", prices: [600, 1800, 4500] },
];
export const carUpgradeById = (id: string): CarUpgradeDef | undefined => CAR_UPGRADES.find(u => u.id === id);

/** The car's performance with the upgrade tiers bought (0 = stock). */
export function carSpec(upgrades: Partial<Record<CarUpgradeId, number>> = {}): CarSpec {
    const t = (id: CarUpgradeId) => Math.max(0, Math.min(3, Math.floor(upgrades[id] ?? 0)));
    return {
        cruise: [20, 26, 32, 40][t("gyro")],
        boostStart: [35, 42, 50, 60][t("gyro")],
        boostMax: [120, 160, 200, 250][t("turbine")],
        boostRamp: [8, 6, 4.5, 3][t("capacitor")],
        climb: [8, 12, 16, 22][t("lift")],
        ceiling: [500, 1000, 1500, 2500][t("ceiling")],
    };
}

/** Speed the car aims for while boosting with `boost` (0..1) built up: eases in, then climbs to the top. */
export function boostSpeed(spec: CarSpec, boost: number): number {
    const b = Math.max(0, Math.min(1, boost));
    return spec.boostStart + (spec.boostMax - spec.boostStart) * b * b * (3 - 2 * b);
}
export interface FlightEnvironment {
    height(x: number, z: number): number;
    sea(x: number, z: number): boolean;
    buildings: Rect[];
}
const RADIUS = 3;
const FOOTPRINT = [[0, 0], [-3, 0], [3, 0], [0, -3], [0, 3], [-2, -2], [2, -2], [-2, 2], [2, 2]];
export function carGround(x: number, z: number, height: FlightEnvironment["height"]): number {
    return Math.max(...FOOTPRINT.map(([dx, dz]) => height(x + dx, z + dz))) + 0.22;
}
/** Full rotor clearance, including terrain at the outer corners. Water is flyable. */
export function flightClear(p: ParkedCar, env: FlightEnvironment): boolean {
    for (const r of env.buildings) if (r.key !== "al-player-car" && insideRect(r, p.x, p.z, RADIUS)
        && p.y - 0.2 < r.base + r.height && p.y + 1.6 > r.base) return false;
    for (const [dx, dz] of FOOTPRINT)
        if (p.y < env.height(p.x + dx, p.z + dz) + 0.2 - 0.01) return false;
    return true;
}
export function landingClear(p: ParkedCar, env: FlightEnvironment): boolean {
    const ground = env.height(p.x, p.z);
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
        if (dx * dx + dz * dz > 12.25) continue;
        if (env.sea(p.x + dx, p.z + dz) || Math.abs(env.height(p.x + dx, p.z + dz) - ground) > 0.65) return false;
    }
    return flightClear({ ...p, y: carGround(p.x, p.z, env.height) }, env);
}
/** Autostabilized multicopter: releasing the controls brakes to a stationary hover. */
export function stepCar(c: FlyingCar, input: PlayerInput, descend: boolean, dt: number, env: FlightEnvironment, spec: CarSpec = BASE_CAR): void {
    if (!c.piloting) return;
    // Substeps prevent crossing thin walls on a slow frame.
    const steps = Math.max(1, Math.ceil(Math.min(dt, 0.25) / 0.02));
    const h = Math.min(dt, 0.25) / steps;
    for (let i = 0; i < steps; i++) {
        c.yaw += ((input.lookX ?? 0) + Number(input.turnRight) - Number(input.turnLeft)) * h * 1.6;
        let mx = (input.moveX ?? 0) + Number(input.right) - Number(input.left);
        let mz = (input.moveY ?? 0) + Number(input.forward) - Number(input.back);
        const n = Math.max(1, Math.hypot(mx, mz)); mx /= n; mz /= n;
        const landing = c.state === "landing";
        const moving = Math.hypot(mx, mz) > 0.1 && !landing;
        // Boost builds up the longer it is held (long-distance travel), and bleeds off quickly.
        c.boost = input.sprint && moving ? Math.min(1, (c.boost ?? 0) + h / spec.boostRamp) : Math.max(0, (c.boost ?? 0) - h * 0.8);
        const speed = input.sprint && moving ? boostSpeed(spec, c.boost) : spec.cruise;
        const tx = landing ? 0 : (Math.cos(c.yaw) * mx + Math.sin(c.yaw) * mz) * speed;
        const tz = landing ? 0 : (-Math.sin(c.yaw) * mx + Math.cos(c.yaw) * mz) * speed;
        const ty = landing ? -3 : (Number(input.jump) - Number(descend)) * spec.climb;
        const blend = 1 - Math.exp(-4 * h);
        c.vx += (tx - c.vx) * blend; c.vz += (tz - c.vz) * blend; c.vy += (ty - c.vy) * blend;
        const ground = carGround(c.x, c.z, env.height);
        let next = { ...c, x: c.x + c.vx * h, z: c.z + c.vz * h, y: c.y };
        // Grounded cars must take off before moving.
        if (c.y <= ground + 0.1 && ty <= 0) { c.vx = c.vz = 0; next.x = c.x; next.z = c.z; }
        if (flightClear(next, env)) { c.x = next.x; c.z = next.z; } else c.vx = c.vz = 0;
        const floor = carGround(c.x, c.z, env.height);
        next = { ...c, y: Math.max(floor, Math.min(floor + spec.ceiling, c.y + c.vy * h)) };
        if (flightClear(next, env)) c.y = next.y; else c.vy = 0;
        if (c.y <= floor + 0.03 && ty <= 0) {
            if (landingClear(c, env)) { c.y = floor; c.vy = 0; c.state = "parked"; }
            else { c.y = Math.max(c.y, floor + 1); c.vy = 0; c.state = "hovering"; }
        } else if (!landing) c.state = Math.hypot(c.vx, c.vz, c.vy) > 0.2 ? "flying" : "hovering";
    }
}

/** Find room for the multicopter's rotor footprint and a player standing beside it. */
export function parkBeside(x: number, z: number, walkable: (x: number, z: number) => boolean,
    height: (x: number, z: number) => number): { player: [number, number]; car: ParkedCar } | null {
    for (let ring = 0; ring <= 15; ring++) {
        const count = ring ? ring * 8 : 1;
        for (let i = 0; i < count; i++) {
            const angle = i * Math.PI * 2 / count;
            const px = x + Math.cos(angle) * ring * 2, pz = z + Math.sin(angle) * ring * 2;
            if (!walkable(px, pz)) continue;
            for (let side = 0; side < 8; side++) {
                const yaw = side * Math.PI / 4;
                const cx = px + Math.sin(yaw) * 4.8, cz = pz + Math.cos(yaw) * 4.8;
                const ground = height(cx, cz);
                let clear = Number.isFinite(ground);
                for (let dx = -3; dx <= 3 && clear; dx++) for (let dz = -3; dz <= 3 && clear; dz++) {
                    if (dx * dx + dz * dz > 12.25) continue;
                    clear = walkable(cx + dx, cz + dz) && Math.abs(height(cx + dx, cz + dz) - ground) < 0.65;
                }
                if (clear) return { player: [px, pz], car: { x: cx, y: ground + 0.22, z: cz, yaw } };
            }
        }
    }
    return null;
}
