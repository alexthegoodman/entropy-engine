// QuadPlanet's game state, independent of the engine so it can be unit tested: a walker who
// stands on whichever planet they're on (gravity points at its center), a ship that lifts off,
// flies anywhere and lands, boarding and leaving it, an autopilot that flies a smooth arc to
// another planet and sets down on a sunlit landing site, and the chase camera for each.

import {
    type Vec3, type Frame, add, addScaled, bezier, bezierTangent, clamp, cross, distance, dot, length, lerp,
    anyPerpendicular, makeFrame, normalize, projectOnPlane, rotateAround, scale, smoothstep, sub,
} from "./qp_math";
import {
    type PlanetDef, PLANETS, SUN_DIRECTION, altitudeAboveGround, findLandingSite, maxRelief, sampleSurface,
    surfacePoint, surfaceRadius,
} from "./qp_planet";

export interface Input {
    forward: boolean;
    back: boolean;
    left: boolean;
    right: boolean;
    /** Walk: jump. Ship: climb. */
    up: boolean;
    /** Ship: descend. */
    down: boolean;
    pitchUp: boolean;
    pitchDown: boolean;
    /** Walk: run. Ship: boost. */
    boost: boolean;
}

export const NO_INPUT: Input = { forward: false, back: false, left: false, right: false, up: false, down: false, pitchUp: false, pitchDown: false, boost: false };

export const WALK_SPEED = 5;
export const RUN_SPEED = 11;
export const JUMP_SPEED = 6.5;
export const TURN_RATE = 2.2;
export const BOARD_DISTANCE = 9;
/** The walker's eye/center offsets used by the camera. */
export const WALKER_HEIGHT = 1.8;

export interface Walker {
    planet: number;
    pos: Vec3;
    /** Facing, kept tangent to the ground. */
    forward: Vec3;
    /** Speed along the local up (jumps and falls). */
    verticalSpeed: number;
    grounded: boolean;
    /** Walk-cycle phase, radians. */
    stride: number;
    /** Tangential speed this frame (for the animation and HUD). */
    speed: number;
}

export interface Autopilot {
    target: number;
    p0: Vec3; p1: Vec3; p2: Vec3; p3: Vec3;
    from: number;
    elapsed: number;
    duration: number;
    landDir: Vec3;
}

export interface Ship {
    pos: Vec3;
    frame: Frame;
    vel: Vec3;
    landed: boolean;
    /** The planet the ship is on or nearest to. */
    planet: number;
    /** 0..1 engine glow. */
    thrust: number;
    autopilot: Autopilot | null;
}

export type Mode = "walk" | "ship";

export interface CameraRig {
    /** Orbit offset around the character/ship, radians. */
    yaw: number;
    pitch: number;
    distance: number;
}

export interface GameState {
    mode: Mode;
    walker: Walker;
    ship: Ship;
    rig: CameraRig;
    /** Seconds of simulated time. */
    time: number;
    /** Distance walked on foot, total. */
    walked: number;
    /** Planets set foot on, by id. */
    visited: string[];
    message: string;
}

// --- Setup ---------------------------------------------------------------------------------------

export function nearestPlanet(pos: Vec3, planets: PlanetDef[] = PLANETS): number {
    let best = 0, bestD = Infinity;
    planets.forEach((p, i) => {
        const d = distance(pos, p.center) - p.radius;
        if (d < bestD) { bestD = d; best = i; }
    });
    return best;
}

/** How far (m) a landing site may be from the place you asked for before the ship sets down right
 * at the place instead, flat or not. */
export const NEAR_SITE = 1000;

/**
 * Where the ship sets down for a trip to `dir`: the nearest flat, dry patch if there is one
 * within NEAR_SITE, otherwise `dir` itself (a mountain top gets you the mountain top).
 */
export function siteNear(p: PlanetDef, dir: Vec3): Vec3 {
    const d = normalize(dir);
    const site = findLandingSite(p, d);
    const off = Math.acos(Math.max(-1, Math.min(1, dot(site, d)))) * p.radius;
    return off <= NEAR_SITE || sampleSurface(p, d, true).sea ? site : d;
}

/**
 * Puts the walker on planet `index` near direction `preferred`, with the ship parked a short walk
 * ahead (the walk toward it lit from the front). With `exact`, the walker stands at `preferred`
 * itself (unless it is open water) and the ship on the nearest flat ground close by.
 */
export function arriveAt(s: GameState, index: number, preferred: Vec3, planets: PlanetDef[] = PLANETS, exact = false): void {
    const home = planets[index];
    const want = normalize(preferred);
    const dry = (d: Vec3) => home.frozenSea || !sampleSurface(home, d, true).sea;
    let shipDir: Vec3;
    let dir: Vec3;
    if (exact && dry(want)) {
        dir = want;
        shipDir = siteNear(home, want);
        if (dot(shipDir, want) > 1 - 1e-15) {
            // No flat ground nearby: park beside the walker, sunward.
            const toward = normalize(projectOnPlane(SUN_DIRECTION, want));
            shipDir = normalize(addScaled(want, toward, 13 / home.radius));
        }
    } else {
        shipDir = findLandingSite(home, want);
        // The walker starts 13 units from the ship, on the side away from the sun, on dry ground.
        const toward = normalize(projectOnPlane(SUN_DIRECTION, shipDir));
        dir = shipDir;
        for (let k = 0; k < 16; k++) {
            const away = rotateAround(scale(toward, -1), shipDir, k * 0.4);
            const d = normalize(addScaled(shipDir, away, 13 / home.radius));
            if (dry(d)) { dir = d; break; }
        }
    }
    const shipPos = surfacePoint(home, shipDir);
    const walkerPos = surfacePoint(home, dir);
    const walkerForward = normalize(projectOnPlane(sub(shipPos, walkerPos), dir));
    s.mode = "walk";
    s.walker = { planet: index, pos: walkerPos, forward: length(walkerForward) > 0 ? walkerForward : anyPerpendicular(dir), verticalSpeed: 0, grounded: true, stride: 0, speed: 0 };
    s.ship = { pos: shipPos, frame: makeFrame(rotateAround(s.walker.forward, shipDir, 0.9), shipDir), vel: [0, 0, 0], landed: true, planet: index, thrust: 0, autopilot: null };
    s.rig = { yaw: 0.35, pitch: 0.28, distance: 7 };
    if (!s.visited.includes(home.id)) s.visited.push(home.id);
}

/** A sunlit, walkable start on the first planet, with the ship parked a short walk ahead. */
export function initialState(planets: PlanetDef[] = PLANETS): GameState {
    const home = planets[0];
    const s: GameState = {
        mode: "walk",
        walker: { planet: 0, pos: [0, 0, 0], forward: [1, 0, 0], verticalSpeed: 0, grounded: true, stride: 0, speed: 0 },
        ship: { pos: [0, 0, 0], frame: makeFrame([1, 0, 0], [0, 1, 0]), vel: [0, 0, 0], landed: true, planet: 0, thrust: 0, autopilot: null },
        rig: { yaw: 0.35, pitch: 0.28, distance: 7 },
        time: 0,
        walked: 0,
        visited: [],
        message: `Welcome to ${home.name}. Walk to your ship (W) and press E to board.`,
    };
    // Morning light: the sun about 40 degrees up behind the walker's right shoulder.
    arriveAt(s, 0, normalize(add(SUN_DIRECTION, scale(normalize(cross(SUN_DIRECTION, [0, 1, 0])), 0.9))), planets);
    return s;
}

// --- Walking -------------------------------------------------------------------------------------

export function upAt(p: PlanetDef, pos: Vec3): Vec3 {
    return normalize(sub(pos, p.center));
}

function stepWalker(s: GameState, input: Input, dt: number, planets: PlanetDef[]): void {
    const w = s.walker;
    const p = planets[w.planet];
    let up = upAt(p, w.pos);
    w.forward = normalize(projectOnPlane(w.forward, up));
    const turn = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    if (turn) w.forward = normalize(rotateAround(w.forward, up, -turn * TURN_RATE * dt));
    const move = (input.forward ? 1 : 0) - (input.back ? 0.6 : 0);
    const speed = input.boost ? RUN_SPEED : WALK_SPEED;
    let step = move * speed * dt;
    if (step !== 0) {
        // Seas (unless frozen) stop you at the shore.
        const next = addScaled(w.pos, w.forward, step);
        const nd = upAt(p, next);
        const ns = sampleSurface(p, nd);
        if (ns.sea && !p.frozenSea && ns.terrain < -0.6) step = 0;
    }
    const before = w.pos;
    w.pos = addScaled(w.pos, w.forward, step);
    // Moving along the sphere tilts "up"; carry the facing along with it.
    const newUp = upAt(p, w.pos);
    w.forward = normalize(projectOnPlane(w.forward, newUp));
    up = newUp;

    if (input.up && w.grounded) { w.verticalSpeed = JUMP_SPEED; w.grounded = false; }
    w.verticalSpeed -= p.gravity * dt;
    w.pos = addScaled(w.pos, up, w.verticalSpeed * dt);
    const ground = surfaceRadius(p, up);
    const r = length(sub(w.pos, p.center));
    if (r <= ground) {
        w.pos = addScaled(p.center, up, ground);
        w.verticalSpeed = 0;
        w.grounded = true;
    } else {
        w.grounded = r - ground < 0.05;
    }
    const moved = distance(before, w.pos);
    s.walked += Math.abs(step);
    w.speed = Math.abs(step) / Math.max(dt, 1e-6);
    w.stride = (w.stride + Math.abs(step) * 1.9) % (Math.PI * 2);
    if (moved === 0 && w.grounded) w.stride = w.stride * 0.8;
}

// --- The ship ------------------------------------------------------------------------------------

// The small planets are tens of kilometers across and hundreds apart (qp_planet.ts), so boost is strong:
// kilometers a second in the air, tens of kilometers a second in space.
export const SHIP_THRUST = 90;
export const SHIP_BOOST = 2400;
export const SHIP_CLIMB = 28;
/** Shift multiplies the climb rate too: an atmosphere is kilometers deep. */
export const SHIP_CLIMB_BOOST = 12;
export const SHIP_YAW_RATE = 1.1;
export const SHIP_PITCH_RATE = 0.9;

function stepShip(s: GameState, input: Input, dt: number, planets: PlanetDef[]): void {
    const ship = s.ship;
    if (ship.autopilot) { stepAutopilot(s, dt, planets); return; }
    ship.planet = nearestPlanet(ship.pos, planets);
    const p = planets[ship.planet];
    if (ship.landed) {
        ship.thrust = Math.max(0, ship.thrust - dt);
        if (input.up || input.forward) {
            ship.landed = false;
            ship.vel = scale(ship.frame.up, 8);
            s.message = "Lift-off. W thrusts, Shift boosts, A/D turn, arrows pitch, Space/C climb and sink.";
        } else {
            return;
        }
    }
    let { forward, up } = ship.frame;
    const yaw = (input.left ? 1 : 0) - (input.right ? 1 : 0);
    if (yaw) forward = rotateAround(forward, up, yaw * SHIP_YAW_RATE * dt);
    const pitch = (input.pitchUp ? 1 : 0) - (input.pitchDown ? 1 : 0);
    if (pitch) {
        const right = normalize(cross(forward, up));
        forward = rotateAround(forward, right, pitch * SHIP_PITCH_RATE * dt);
        up = rotateAround(up, right, pitch * SHIP_PITCH_RATE * dt);
    }
    // Flight assist: inside an atmosphere the ship levels itself to the planet's horizon.
    const radial = upAt(p, ship.pos);
    const alt = altitudeAboveGround(p, ship.pos);
    const inAtmosphere = alt < p.atmosphereHeight * 1.5;
    if (inAtmosphere && !pitch) up = normalize(lerp(up, radial, clamp(dt * 1.6, 0, 1)));
    ship.frame = makeFrame(forward, up);

    let accel: Vec3 = [0, 0, 0];
    const fwd = (input.forward ? 1 : 0) - (input.back ? 0.5 : 0);
    const power = input.boost ? SHIP_BOOST : SHIP_THRUST;
    accel = addScaled(accel, ship.frame.forward, fwd * power);
    const climb = (input.up ? 1 : 0) - (input.down ? 1 : 0);
    accel = addScaled(accel, inAtmosphere ? radial : ship.frame.up, climb * SHIP_CLIMB * (input.boost ? SHIP_CLIMB_BOOST : 1));
    ship.vel = addScaled(ship.vel, accel, dt);
    // Hover assist cancels gravity; drag keeps it arcade-controllable.
    const drag = inAtmosphere ? 0.9 : 0.12;
    ship.vel = scale(ship.vel, Math.exp(-drag * dt));
    const maxSpeed = inAtmosphere ? 90 + alt * 0.8 : 40000;
    const sp = length(ship.vel);
    if (sp > maxSpeed) ship.vel = scale(ship.vel, maxSpeed / sp);
    ship.pos = addScaled(ship.pos, ship.vel, dt);
    ship.thrust = clamp(Math.abs(fwd) * (input.boost ? 1 : 0.5) + Math.abs(climb) * 0.3, 0, 1);

    // Ground contact: slow and low sets down; anything else skids along the surface.
    const newAlt = altitudeAboveGround(p, ship.pos);
    if (newAlt < 0.05) {
        const r = upAt(p, ship.pos);
        ship.pos = addScaled(p.center, r, surfaceRadius(p, r) + 0.05);
        const inward = dot(ship.vel, r);
        if (inward < 0) ship.vel = addScaled(ship.vel, r, -inward);
        if (length(ship.vel) < 12 && climb <= 0) land(s, planets);
    }
}

function land(s: GameState, planets: PlanetDef[]): void {
    const ship = s.ship;
    ship.planet = nearestPlanet(ship.pos, planets);
    const p = planets[ship.planet];
    const r = upAt(p, ship.pos);
    ship.pos = surfacePoint(p, r);
    ship.frame = makeFrame(ship.frame.forward, r);
    ship.vel = [0, 0, 0];
    ship.landed = true;
    s.message = `Landed on ${p.name}. Press E to step out.`;
}

// --- Autopilot -----------------------------------------------------------------------------------

/** Minimum clearance the autopilot keeps above every planet's highest peaks. */
const CLEARANCE = 3000;

function pathClear(a: Autopilot, planets: PlanetDef[]): boolean {
    for (let k = 1; k < 64; k++) {
        const t = k / 64;
        const q = bezier(a.p0, a.p1, a.p2, a.p3, t);
        for (let i = 0; i < planets.length; i++) {
            const p = planets[i];
            // The start and end legs legitimately sit on a surface.
            if ((i === a.from && t < 0.12) || (i === a.target && t > 0.88)) continue;
            if (distance(q, p.center) < p.radius + maxRelief(p) + CLEARANCE) return false;
        }
    }
    return true;
}

/**
 * Plans a smooth arc from where the ship is to a landing site on `target`: near `site` (a
 * direction from its center) when given, otherwise the sunlit side facing the ship.
 */
export function planAutopilot(s: GameState, target: number, planets: PlanetDef[] = PLANETS, site?: Vec3): Autopilot {
    const ship = s.ship;
    const from = nearestPlanet(ship.pos, planets);
    const B = planets[target];
    const fromDir = normalize(sub(ship.pos, B.center));
    const landDir = site ? siteNear(B, site) : findLandingSite(B, normalize(add(fromDir, scale(SUN_DIRECTION, 1.3))));
    const land = surfacePoint(B, landDir);
    const upA = upAt(planets[from], ship.pos);
    const span = distance(ship.pos, land);
    let h = Math.max(span * 0.3, 12000);
    let plan: Autopilot = { target, from, p0: ship.pos, p1: ship.pos, p2: land, p3: land, elapsed: 0, duration: 0, landDir };
    for (let attempt = 0; attempt < 8; attempt++) {
        plan = {
            ...plan,
            p1: addScaled(ship.pos, upA, h),
            p2: addScaled(land, landDir, h),
            duration: clamp(span / 50000, 8, 15),
        };
        if (pathClear(plan, planets)) break;
        h *= 1.35;
    }
    return plan;
}

export function startAutopilot(s: GameState, target: number, planets: PlanetDef[] = PLANETS, site?: Vec3): Autopilot | null {
    if (s.mode !== "ship") { s.message = "Board the ship first (E next to it)."; return null; }
    const here = nearestPlanet(s.ship.pos, planets);
    if (here === target && s.ship.landed && !site) { s.message = `Already on ${planets[target].name}.`; return null; }
    const plan = planAutopilot(s, target, planets, site);
    s.ship.autopilot = plan;
    s.ship.landed = false;
    s.message = `Autopilot: flying to ${planets[target].name} (${Math.round(distance(plan.p0, plan.p3) / 1000)} km).`;
    return plan;
}

/** Eased progress along the path: gentle lift-off, fast cruise, slow final descent. */
export function autopilotEase(t: number): number {
    const x = clamp(t, 0, 1);
    return x * x * x * (x * (x * 6 - 15) + 10);
}

function stepAutopilot(s: GameState, dt: number, planets: PlanetDef[]): void {
    const ship = s.ship;
    const a = ship.autopilot!;
    a.elapsed += dt;
    const t = clamp(a.elapsed / a.duration, 0, 1);
    const e = autopilotEase(t);
    const prev = ship.pos;
    ship.pos = bezier(a.p0, a.p1, a.p2, a.p3, e);
    ship.vel = scale(sub(ship.pos, prev), 1 / Math.max(dt, 1e-6));
    const A = planets[a.from], B = planets[a.target];
    const up = normalize(lerp(upAt(A, ship.pos), upAt(B, ship.pos), smoothstep(0.35, 0.75, e)));
    const tangent = bezierTangent(a.p0, a.p1, a.p2, a.p3, e);
    const flat = projectOnPlane(tangent, up);
    const forward = length(flat) > 1e-3 * length(tangent) ? flat : ship.frame.forward;
    ship.frame = makeFrame(lerp(ship.frame.forward, normalize(forward), clamp(dt * 3, 0, 1)), up);
    ship.thrust = clamp(length(ship.vel) / 20000, 0.2, 1);
    ship.planet = nearestPlanet(ship.pos, planets);
    if (t >= 1) {
        ship.autopilot = null;
        ship.pos = a.p3;
        land(s, planets);
        s.message = `Autopilot landed on ${B.name}. Press E to step out.`;
    }
}

// --- Boarding ------------------------------------------------------------------------------------

/** E: board when next to the ship, step out when landed (or hovering just above the ground). */
export function interact(s: GameState, planets: PlanetDef[] = PLANETS): string {
    const ship = s.ship;
    if (s.mode === "walk") {
        const d = distance(s.walker.pos, ship.pos);
        if (d > BOARD_DISTANCE) { s.message = `The ship is ${Math.round(d)} m away - get within ${BOARD_DISTANCE} m.`; return "too-far"; }
        s.mode = "ship";
        s.rig = { yaw: 0, pitch: 0.22, distance: 24 };
        s.message = ship.landed ? "Aboard. Space or W to lift off; T flies the autopilot to the next planet." : "Aboard.";
        return "boarded";
    }
    if (ship.autopilot) { s.message = "Wait for the autopilot to land."; return "busy"; }
    const p = planets[nearestPlanet(ship.pos, planets)];
    if (!ship.landed && altitudeAboveGround(p, ship.pos) > 4) { s.message = "Land first (sink with C)."; return "airborne"; }
    if (!ship.landed) land(s, planets);
    // Step out beside the ship, facing the way it faces.
    const planet = ship.planet;
    const side = addScaled(ship.pos, ship.frame.right, 4.5);
    const dir = upAt(planets[planet], side);
    s.walker = {
        planet, pos: surfacePoint(planets[planet], dir), forward: normalize(projectOnPlane(ship.frame.forward, dir)),
        verticalSpeed: 0, grounded: true, stride: 0, speed: 0,
    };
    s.mode = "walk";
    s.rig = { yaw: 0.35, pitch: 0.28, distance: 7 };
    const id = planets[planet].id;
    if (!s.visited.includes(id)) s.visited.push(id);
    s.message = `You step out onto ${planets[planet].name}.`;
    return "exited";
}

// --- Step ----------------------------------------------------------------------------------------

export function step(s: GameState, input: Input, dt: number, planets: PlanetDef[] = PLANETS): void {
    s.time += dt;
    if (s.mode === "walk") stepWalker(s, input, dt, planets);
    else stepShip(s, input, dt, planets);
    // A parked ship stays glued to its planet while the walker is away.
    if (s.mode === "walk") s.ship.thrust = Math.max(0, s.ship.thrust - dt);
}

// --- Camera --------------------------------------------------------------------------------------

export interface CameraPose { position: Vec3; target: Vec3; up: Vec3 }

/** The chase camera for the current mode, kept above the ground. */
export function cameraPose(s: GameState, planets: PlanetDef[] = PLANETS): CameraPose {
    let focus: Vec3, frame: Frame, lift: number;
    if (s.mode === "walk") {
        const w = s.walker;
        const up = upAt(planets[w.planet], w.pos);
        frame = makeFrame(w.forward, up);
        focus = addScaled(w.pos, up, 1.45);
        lift = 0.9;
    } else {
        frame = s.ship.frame;
        focus = addScaled(s.ship.pos, frame.up, 2.2);
        lift = 3;
    }
    const back = rotateAround(scale(frame.forward, -1), frame.up, s.rig.yaw);
    const right = normalize(cross(back, frame.up));
    const dir = normalize(rotateAround(back, right, -s.rig.pitch));
    let position = addScaled(addScaled(focus, dir, s.rig.distance), frame.up, lift * 0.3);
    const target = addScaled(focus, frame.forward, s.mode === "walk" ? 1.5 : 6);
    // Never below the ground (hills behind the walker would swallow the camera).
    const pi = nearestPlanet(position, planets);
    const p = planets[pi];
    const minAlt = 0.8;
    const alt = altitudeAboveGround(p, position);
    if (alt < minAlt) position = addScaled(position, upAt(p, position), minAlt - alt);
    const up = s.mode === "walk" ? upAt(planets[s.walker.planet], s.walker.pos) : frame.up;
    return { position, target, up };
}

/**
 * Straight down on the walker (or ship) from `height` above it, facing its way: the view that
 * shows the quadtree's rings of detail tightening around you.
 */
export function overheadPose(s: GameState, height: number, planets: PlanetDef[] = PLANETS): CameraPose {
    const onFoot = s.mode === "walk";
    const pos = onFoot ? s.walker.pos : s.ship.pos;
    const p = planets[onFoot ? s.walker.planet : nearestPlanet(pos, planets)];
    const up = upAt(p, pos);
    const forward = onFoot ? s.walker.forward : s.ship.frame.forward;
    return { position: addScaled(pos, up, height), target: pos, up: normalize(projectOnPlane(forward, up)) };
}

/** A viewpoint far enough out to see the whole of planet `i`, lit by the sun. */
export function orbitPose(i: number, planets: PlanetDef[] = PLANETS, distanceFactor = 3.2): CameraPose {
    const p = planets[i];
    const side = normalize(cross(SUN_DIRECTION, [0, 1, 0]));
    const dir = normalize(add(scale(SUN_DIRECTION, 1), scale(side, 0.7)));
    return { position: addScaled(p.center, dir, p.radius * distanceFactor), target: p.center, up: [0, 1, 0] };
}

// --- Readouts ------------------------------------------------------------------------------------

export interface Readout {
    mode: Mode;
    planet: string;
    altitude: number;
    speed: number;
    grounded: boolean;
    landed: boolean;
    shipDistance: number;
    autopilot: null | { target: string; progress: number };
}

export function readout(s: GameState, planets: PlanetDef[] = PLANETS): Readout {
    const inShip = s.mode === "ship";
    const pos = inShip ? s.ship.pos : s.walker.pos;
    const pi = inShip ? nearestPlanet(pos, planets) : s.walker.planet;
    const p = planets[pi];
    return {
        mode: s.mode,
        planet: p.name,
        altitude: altitudeAboveGround(p, pos),
        speed: inShip ? length(s.ship.vel) : s.walker.speed,
        grounded: inShip ? s.ship.landed : s.walker.grounded,
        landed: s.ship.landed,
        shipDistance: distance(s.walker.pos, s.ship.pos),
        autopilot: s.ship.autopilot ? { target: planets[s.ship.autopilot.target].name, progress: clamp(s.ship.autopilot.elapsed / s.ship.autopilot.duration, 0, 1) } : null,
    };
}
