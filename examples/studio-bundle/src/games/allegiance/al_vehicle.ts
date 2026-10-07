import { insideRect, type Rect } from "./al_nav";
import { type PlayerInput } from "./al_player";

export interface ParkedCar { x: number; y: number; z: number; yaw: number }
export interface FlyingCar extends ParkedCar {
    vx: number; vy: number; vz: number;
    piloting: boolean;
    state: "parked" | "hovering" | "flying" | "landing";
    /** 0..1: how far the boost has built up. Holding boost while moving charges it; letting go bleeds it off. */
    boost?: number;
    /** Flying itself to you when called (and not being piloted). */
    call?: CarCall | null;
    /** An automatic landing's spot (local x, z): the car glides over it, then comes straight down. */
    landAt?: { x: number; z: number } | null;
}

/** A summons: where to land (a clear spot beside you), and how the trip is going. */
export interface CarCall {
    x: number; z: number; yaw: number;
    phase: "climb" | "cruise" | "descend";
    /** Cruise height (local y): over the rooftops between the car and you. */
    cruiseY: number;
    /** Seconds the descent has been blocked (something overhangs the spot): the caller picks another. */
    stuck?: number;
}

/** Open to the sky over a landing spot: no building (at any height) within the rotors' reach. */
export function openSky(p: ParkedCar, buildings: readonly Rect[]): boolean {
    for (const r of buildings) if (r.key !== "al-player-car" && insideRect(r, p.x, p.z, RADIUS + 0.4)) return false;
    return true;
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

/** A roof must cover this much of its rectangle: a building round a courtyard (or an L) does not
 * have a roof over the whole rectangle, and a car set down there would stand on thin air. */
export const ROOF_FILL = 0.9;

/** Flat roofs a car can set down on: city blocks and compound buildings that fill their rectangle
 * (houses' roofs are pitched; towers and walls are too narrow anyway, and a parked vehicle is not a roof). */
const landsOn = (r: Rect): boolean => r.kind !== "house" && r.kind !== "vehicle" && (r.fill ?? 1) >= ROOF_FILL
    && !r.key.startsWith("al-player-car") && !r.key.startsWith("al-comrade-car");

/**
 * The flat roof under the whole rotor footprint, if there is one: its top (local y). Each footprint
 * point must stand on a roof, and the roofs under them within 0.65 m of each other (one block, or
 * a terrace of equal ones).
 */
export function roofUnder(x: number, z: number, buildings: readonly Rect[]): number | null {
    let lo = Infinity, hi = -Infinity;
    for (const [dx, dz] of FOOTPRINT) {
        let top = -Infinity;
        for (const r of buildings) if (landsOn(r) && insideRect(r, x + dx, z + dz)) top = Math.max(top, r.base + r.height);
        if (top === -Infinity) return null;
        lo = Math.min(lo, top); hi = Math.max(hi, top);
    }
    return hi - lo <= 0.65 ? hi : null;
}

/** Where the car rests at (x, z): the ground, or a flat roof under its whole footprint. */
export function carFloor(x: number, z: number, env: FlightEnvironment): number {
    const ground = carGround(x, z, env.height);
    const roof = roofUnder(x, z, env.buildings);
    return roof !== null ? Math.max(ground, roof + 0.22) : ground;
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
    // On a flat roof: the roof is level (roofUnder) and nothing taller stands in the rotors' way.
    const roof = roofUnder(p.x, p.z, env.buildings);
    if (roof !== null && roof + 0.22 > carGround(p.x, p.z, env.height)) return flightClear({ ...p, y: roof + 0.22 }, env);
    const ground = env.height(p.x, p.z);
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
        if (dx * dx + dz * dz > 12.25) continue;
        if (env.sea(p.x + dx, p.z + dz) || Math.abs(env.height(p.x + dx, p.z + dz) - ground) > 0.65) return false;
    }
    return flightClear({ ...p, y: carGround(p.x, p.z, env.height) }, env);
}
/** Descent speed (m/s) of an automatic landing `above` meters over where it will set down. */
export function landingRate(above: number, spec: CarSpec = BASE_CAR): number {
    return Math.max(1.2, Math.min(Math.max(14, spec.climb * 2), 1.2 + Math.max(0, above) * 0.9));
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
        let tx = landing ? 0 : (Math.cos(c.yaw) * mx + Math.sin(c.yaw) * mz) * speed;
        let tz = landing ? 0 : (-Math.sin(c.yaw) * mx + Math.cos(c.yaw) * mz) * speed;
        // Gliding to the landing spot first (braking to arrive over it), then straight down.
        const spot = landing ? c.landAt : null;
        const off = spot ? Math.hypot(spot.x - c.x, spot.z - c.z) : 0;
        if (spot && off > 0.4) {
            const v = Math.min(Math.max(spec.cruise, 30), Math.sqrt(2 * 6 * off));
            tx = (spot.x - c.x) / off * v; tz = (spot.z - c.z) / off * v;
        }
        // Automatic landing comes down briskly from height (faster than the climb rate) and eases
        // off over the last few meters.
        const above = c.y - carFloor(c.x, c.z, env);
        // While it glides it comes down to 25 m over what lies beneath (rooftops included) and no lower.
        const ty = landing ? (off > 3 ? Math.max(-spec.climb, Math.min(spec.climb, 25 - above)) : -landingRate(above, spec)) : (Number(input.jump) - Number(descend)) * spec.climb;
        const blend = 1 - Math.exp(-(landing ? 6 : 4) * h);
        c.vx += (tx - c.vx) * blend; c.vz += (tz - c.vz) * blend; c.vy += (ty - c.vy) * blend;
        const ground = c.y - above;
        let next = { ...c, x: c.x + c.vx * h, z: c.z + c.vz * h, y: c.y };
        // Grounded cars must take off before moving.
        if (c.y <= ground + 0.1 && ty <= 0) { c.vx = c.vz = 0; next.x = c.x; next.z = c.z; }
        if (flightClear(next, env)) { c.x = next.x; c.z = next.z; }
        else { c.vx = c.vz = 0; if (spot) c.vy = Math.max(c.vy, spec.climb); }
        const floor = carFloor(c.x, c.z, env);
        next = { ...c, y: Math.max(floor, Math.min(floor + spec.ceiling, c.y + c.vy * h)) };
        if (flightClear(next, env)) c.y = next.y; else c.vy = 0;
        if (c.y <= floor + 0.03 && ty <= 0) {
            if (landingClear(c, env)) { c.y = floor; c.vy = 0; c.state = "parked"; c.landAt = null; }
            else { c.y = Math.max(c.y, floor + 1); c.vy = 0; c.state = "hovering"; c.landAt = null; }
        } else if (!landing) c.state = Math.hypot(c.vx, c.vz, c.vy) > 0.2 ? "flying" : "hovering";
    }
}

// --- Autopilot -----------------------------------------------------------------------------------

/** A destination anywhere on Earth for the autopilot. */
export interface Autopilot { name: string; lat: number; lon: number }

/** Within this many meters of the destination the autopilot hands over to an automatic landing. */
export const AUTOPILOT_ARRIVE = 250;
/** Time runs up to this many times faster on a long leg high over the country (the campaign clock too). */
export const AUTOPILOT_WARP = 12;

/** How high the autopilot cruises over what lies beneath: clear of towers, under the ceiling. */
export const autopilotAltitude = (spec: CarSpec): number => Math.max(150, Math.min(spec.ceiling - 25, 300));

/** Time warp for a leg with `km` to go at `above` meters: none near the ends or low down, the full warp on a long leg. */
export function autopilotWarp(km: number, above: number, spec: CarSpec): number {
    if (above < autopilotAltitude(spec) * 0.8) return 1;
    return Math.max(1, Math.min(AUTOPILOT_WARP, (km - 4) / 3));
}

/**
 * One frame of the autopilot: the controls it holds (climb first, then forward with boost on a
 * long leg, holding its cruise height) and the heading it turns toward. `tx, tz` is the
 * destination in the local frame, `km` the great-circle distance to it.
 */
export function steerAutopilot(c: FlyingCar, tx: number, tz: number, km: number, env: FlightEnvironment, spec: CarSpec = BASE_CAR): { input: PlayerInput; descend: boolean; yaw: number; arrived: boolean } {
    const above = c.y - carFloor(c.x, c.z, env);
    const cruise = autopilotAltitude(spec);
    const bearing = Math.atan2(tx - c.x, tz - c.z);
    let d = bearing - c.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const arrived = km * 1000 < AUTOPILOT_ARRIVE;
    const input: PlayerInput = {
        moveX: 0, moveY: 0, lookX: 0, lookY: 0,
        // Up over the rooftops before setting off; along only roughly facing the destination.
        forward: !arrived && above > Math.min(60, cruise * 0.5) && Math.abs(d) < 0.6,
        back: false, left: false, right: false,
        jump: above < cruise - 10, sprint: km > 3,
        turnLeft: false, turnRight: false, lookUp: false, lookDown: false,
    };
    return { input, descend: above > cruise + 20, yaw: c.yaw + Math.max(-0.05, Math.min(0.05, d)), arrived };
}

/**
 * Where an automatic landing should set down: right below if it is clear, otherwise the nearest
 * clear spot (ground or flat roof) within `reach` meters, searched in rings. Null: nowhere near.
 */
export function landingSpot(c: ParkedCar, env: FlightEnvironment, reach = 90): { x: number; z: number } | null {
    if (landingClear(c, env)) return { x: c.x, z: c.z };
    for (let ring = 1; ring * 4 <= reach; ring++) {
        const count = ring * 8;
        for (let i = 0; i < count; i++) {
            const a = (i + 0.5 * (ring % 2)) / count * Math.PI * 2;
            const x = c.x + Math.sin(a) * ring * 4, z = c.z + Math.cos(a) * ring * 4;
            if (landingClear({ x, y: c.y, z, yaw: c.yaw }, env)) return { x, z };
        }
    }
    return null;
}

/** Find room for the multicopter's rotor footprint and a player standing beside it. */
export function parkBeside(x: number, z: number, walkable: (x: number, z: number) => boolean,
    height: (x: number, z: number) => number, open: (car: ParkedCar) => boolean = () => true): { player: [number, number]; car: ParkedCar } | null {
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
                const car = { x: cx, y: ground + 0.22, z: cz, yaw };
                if (clear && open(car)) return { player: [px, pz], car };
            }
        }
    }
    return null;
}

// --- Calling the car -----------------------------------------------------------------------------

/** Clearance over terrain, and over rooftops on the way, while the car flies itself to you. */
export const CALL_CLEARANCE = 25;
export const CALL_ROOF_CLEARANCE = 8;
/** Deceleration the autopilot plans its arrival with (m/s^2). */
const CALL_BRAKE = 5;

/** Distance from (px, pz) to the segment (ax, az)-(bx, bz). */
function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
    return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** How high the car cruises from where it is to (tx, tz): over the terrain at both ends and every roof near the line. */
export function callAltitude(c: ParkedCar, tx: number, tz: number, env: FlightEnvironment, spec: CarSpec = BASE_CAR): number {
    const ground = Math.max(carGround(c.x, c.z, env.height), carGround(tx, tz, env.height));
    // A short hop stays low; a long trip clears the terrain by CALL_CLEARANCE.
    const clearance = Math.min(CALL_CLEARANCE, 10 + Math.hypot(tx - c.x, tz - c.z) * 0.1);
    let top = ground + clearance;
    const steps = Math.min(40, Math.ceil(Math.hypot(tx - c.x, tz - c.z) / 25));
    for (let i = 1; i < steps; i++) {
        const t = i / steps;
        top = Math.max(top, carGround(c.x + (tx - c.x) * t, c.z + (tz - c.z) * t, env.height) + clearance);
    }
    // Roofs the rotors would cross on the straight line there (sampled every few meters).
    const len = Math.hypot(tx - c.x, tz - c.z), n = Math.max(1, Math.ceil(len / 3));
    for (const r of env.buildings) {
        if (r.key === "al-player-car") continue;
        if (segmentDistance(r.cx, r.cz, c.x, c.z, tx, tz) > Math.hypot(r.hw, r.hd) + RADIUS + 2) continue;
        for (let i = 0; i <= n; i++) {
            const t = i / n;
            if (insideRect(r, c.x + (tx - c.x) * t, c.z + (tz - c.z) * t, RADIUS + 1)) { top = Math.max(top, r.base + r.height + CALL_ROOF_CLEARANCE); break; }
        }
    }
    return Math.min(top, ground + spec.ceiling);
}

/** Sends the car (parked, unpiloted) to land at `at`: it climbs over the rooftops, flies there and settles. */
export function callCar(c: FlyingCar, at: ParkedCar, env: FlightEnvironment, spec: CarSpec = BASE_CAR): void {
    c.piloting = false;
    c.call = { x: at.x, z: at.z, yaw: at.yaw, phase: "climb", cruiseY: callAltitude(c, at.x, at.z, env, spec) };
    c.state = "flying";
}

/** Seconds until a called car lands (a rough estimate for the HUD). */
export function callEta(c: FlyingCar, env: FlightEnvironment, spec: CarSpec = BASE_CAR): number {
    if (!c.call) return 0;
    const d = Math.hypot(c.call.x - c.x, c.call.z - c.z);
    const climb = c.call.phase === "climb" ? Math.max(0, c.call.cruiseY - c.y) / spec.climb : 0;
    const descend = Math.max(0, (c.call.phase === "descend" ? c.y : c.call.cruiseY) - carGround(c.call.x, c.call.z, env.height)) / (spec.climb * 0.6);
    return climb + d / Math.min(callSpeed(spec), Math.max(spec.cruise, d / 3)) + descend;
}

const callSpeed = (spec: CarSpec) => Math.max(spec.cruise, spec.boostMax * 0.5);

/**
 * One step of a called car flying itself to you. Returns true on the step it lands (the call is
 * then over and the car parked).
 */
export function stepCall(c: FlyingCar, dt: number, env: FlightEnvironment, spec: CarSpec = BASE_CAR): boolean {
    const call = c.call;
    if (!call || c.piloting) return false;
    const steps = Math.max(1, Math.ceil(Math.min(dt, 0.25) / 0.02));
    const h = Math.min(dt, 0.25) / steps;
    for (let i = 0; i < steps; i++) {
        const floor = carGround(c.x, c.z, env.height);
        const dx = call.x - c.x, dz = call.z - c.z, d = Math.hypot(dx, dz);
        let tx = 0, tz = 0, ty = 0;
        if (call.phase === "climb") {
            ty = spec.climb * 1.25;
            if (c.y >= call.cruiseY - 0.5) call.phase = "cruise";
        } else if (call.phase === "cruise") {
            // Fly at the cruise height, braking to arrive over the landing spot.
            const v = Math.min(callSpeed(spec), Math.sqrt(2 * CALL_BRAKE * d));
            if (d > 1e-3) { tx = dx / d * v; tz = dz / d * v; c.yaw = turnToward(c.yaw, Math.atan2(dx, dz), h * 2); }
            ty = Math.max(-spec.climb, Math.min(spec.climb, (Math.max(call.cruiseY, floor + 6) - c.y) * 1.5));
            if (d < 0.6 && Math.hypot(c.vx, c.vz) < 1.5) call.phase = "descend";
        } else {
            tx = dx * 2; tz = dz * 2;
            c.yaw = turnToward(c.yaw, call.yaw, h * 1.5);
            // Down briskly, slowing for the last few meters.
            ty = -Math.min(spec.climb * 1.5, 1.5 + (c.y - floor) * 0.9);
        }
        const blend = 1 - Math.exp(-4 * h);
        c.vx += (tx - c.vx) * blend; c.vz += (tz - c.vz) * blend; c.vy += (ty - c.vy) * blend;
        const next = { ...c, x: c.x + c.vx * h, z: c.z + c.vz * h };
        if (flightClear(next, env)) { c.x = next.x; c.z = next.z; }
        else { c.vx = c.vz = 0; call.cruiseY = Math.min(c.y + 10, carGround(c.x, c.z, env.height) + spec.ceiling); call.phase = "climb"; }
        const f2 = carGround(c.x, c.z, env.height);
        const ny = Math.max(f2, Math.min(f2 + spec.ceiling, c.y + c.vy * h));
        if (flightClear({ ...c, y: ny }, env)) { c.y = ny; if (call.phase === "descend") call.stuck = 0; }
        else { c.vy = 0; if (call.phase === "descend") call.stuck = (call.stuck ?? 0) + h; }
        if (call.phase === "descend" && c.y <= f2 + 0.03) {
            c.y = f2; c.vx = c.vy = c.vz = 0; c.state = "parked"; c.call = null;
            return true;
        }
        c.state = "flying";
    }
    return false;
}

function turnToward(h: number, target: number, rate: number): number {
    let d = target - h;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return h + Math.max(-rate, Math.min(rate, d));
}
