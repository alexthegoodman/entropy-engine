// Level 1: the Central Spire of the capital. Ray wakes in the Secret Doctor's lab on the first
// floor (y = 0); the core stairs climb to the second floor (y = 7), whose hall is drowned by a dark
// zone around a dark-bomb fragment, so the way on is around it along the blown-out east edge and up
// a fallen slab to the atrium (y = 14), where the hypercube floats over its pedestal, open to the sky.
//
// Past the hypercube the mission goes on (te_acts.ts): a snapped sky bridge east to the Relay
// Tower, down its stair shaft, back along a lower bridge to the spire's reactor floor (y = -14), and
// up the service lift in the spire's north-west corner to the atrium again.
//
// Everything solid is an axis-aligned box or a ramp (a slab tilted along z). The same boxes are
// drawn (ARCH pipeline, tiling materials) and collided with; props from Meshy add their own boxes.
// Coordinates: meters, +y up, +x east (the side the Error's blast tore open), +z north.

export type V3 = [number, number, number];

/** ARCH material layers (texture array order, see te_render.ts MATERIALS). */
export const MAT = { concrete: 0, granite: 1, marble: 2, metal: 3, soil: 4, sandstone: 5, wood: 6, brick: 7, asphalt: 8 } as const;

/** `sim`: walkable but unseen, outlined only through the simulation lens (the old world's floor). */
export interface Box { min: V3; max: V3; mat: number; tint: V3; draw: boolean; solid: boolean; uvScale?: number; sim?: boolean }
/** A slab rising along z from (z0, y0) to (z1, y1), x0..x1 wide, `thick` deep. */
export interface Ramp { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number; thick: number; mat: number }

export type ModelName = "workbench" | "upload_pod" | "holo_terminal" | "battery" | "rubble" | "girders" | "pedestal" | "junk" | "boiler" | "carcass" | "tower_a" | "tower_b" | "bridge" | "hovercar" | "dark_emitter" | "roller" | "rifle" | "doctor" | "hacked_bot" | "ray"
    | "archive_rack" | "reactor" | "conduit" | "crawler" | "warden"
    // Mission 2, Noctis.
    | "hollow" | "scavenger" | "vesper" | "survivor" | "elder" | "pip" | "cherub" | "scattergun" | "gravity_launcher"
    | "doctor_buggy" | "crates" | "radio_set" | "assembly_arm" | "body_printer" | "conveyor" | "vat" | "upload_gate"
    | "kiosk" | "statue" | "barge_hull" | "signal_mast" | "lock_gate" | "water_tank" | "harvest_pod" | "lure_beacon"
    | "metro_car" | "cable_nest" | "rock_spire" | "wind_turbine" | "shack";

export interface Prop {
    model: ModelName;
    pos: V3;
    yaw: number;
    /** Target size: the model's largest extent is scaled to this many meters (Meshy props are unit cubes). */
    size: number;
    /** Collision box half extents (x, y, z before yaw; snapped to axis), or none. */
    collide?: V3;
    /** Lowered into the floor this far (rubble piles settle). */
    sink?: number;
    tint?: V3;
    /** How hot it reads through the heat lens (0..1), where it isn't the model's usual. */
    heat?: number;
}

/**
 * Machines (and worse). Mission 2 adds the Hollow (an empty avatar body that only moves while
 * unwatched), the cherub (a flying gate drone that dives), the Tithe's scavengers (human gunners:
 * spared, not Reset), and two that never move: the lure beacon and the cable heart (the nest).
 */
export type EnemyKind = "roller" | "hacked_bot" | "crawler" | "warden" | "hollow" | "cherub" | "scavenger" | "beacon" | "nest";
/** `zone`: the region (regionOf) it guards; it wakes when Ray is there, or close and in sight. */
export interface EnemySpawn { id: string; kind: EnemyKind; pos: V3; yaw: number; patrol: V3[]; zone: string }
export interface Pickup { id: string; pos: V3 }
export interface LevelLight { pos: V3; color: V3; intensity: number; range: number; flicker?: number }
/** `free`: taken whenever reached (the open stretch of Noctis is done in any order); the rest only forward. */
export interface Checkpoint { id: string; pos: V3; yaw: number; radius: number; free?: boolean }
/** A slab that slides up out of the way when opened (blast doors, the lift's gates). */
export interface Door { id: string; min: V3; max: V3; mat: number; tint: V3 }
/** Something E works on: the biochip, the conduits' breakers, the reactor's console, the lift. */
export type UseKind = "biochip" | "conduit" | "console" | "lift"
    // Mission 2: someone to talk to, a radio, a weapon to take, the Foundry's line, the gate's terminals, the mast's winch.
    | "talk" | "radio" | "weapon" | "printer" | "terminal" | "winch";
export interface UseSpot { id: string; kind: UseKind; pos: V3; yaw: number; label: string }
/** A collectible's place (te_items.ts has what it is). */
/** `after`: only there once the mission has reached that stage (te_mission.ts StageId). */
export interface ItemSpot { id: string; pos: V3; yaw: number; after?: string }
export interface DarkZone { id: string; center: V3; radius: number }

export const FLOORS = [0, 7, 14];
export const SLAB = 0.6;
export const HALF = 24;
const CELL = 2;

export const START: { pos: V3; yaw: number } = { pos: [-13.6, 0, -15.6], yaw: Math.PI * 0.5 };
export const DOCTOR_POS: V3 = [-12.6, 0, -18.8];
export const PEDESTAL: V3 = [0, 14, 2];
export const HYPERCUBE_Y = 14 + 4.6;
export const DARK_ZONE: DarkZone = { id: "spire", center: [-1, 7, 0], radius: 6.2 };
/** Where the level is won: the hypercube's reach. */
export const GOAL_RADIUS = 5.2;
export const ROOF_Y = 40;
export const CITY_FLOOR = -260;
/** The spire's reactor floor, where the lower bridge comes in and the lift starts. */
export const LOW_FLOOR = -14;
/** The service lift's shaft (north-west corner, the reactor floor up to the atrium). */
export const LIFT = { x0: -24, x1: -19.7, z0: 13.7, z1: 18.3, bottom: LOW_FLOOR, top: 14 };

/** A small deterministic hash in 0..1. */
export function hash(a: number, b = 0, c = 0): number {
    const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
    return s - Math.floor(s);
}

/**
 * The east edge of a floor's slab at z: everything east of it was blown away by the Error's blast.
 * Jagged, and further west on the higher floors (the blast came from below and out).
 */
export function edgeX(floor: number, z: number): number {
    const wobble = Math.sin(z * 0.37 + floor * 1.7) * 2.2 + Math.sin(z * 1.13 + floor) * 1.1 + (hash(Math.floor(z / CELL), floor) - 0.5) * 2.4;
    if (floor === 0) return 15 + wobble;
    // The second floor keeps a ledge in the south, where the fallen slab lies.
    if (floor === 1) return (z < -5 ? 17 : 13) + wobble * 0.8;
    return (z < -4 ? 15 : 12) + wobble;
}

/** Cells of each floor's slab removed besides the blast (stair wells, the fallen slab's hole). */
function holed(floor: number, cx: number, cz: number): boolean {
    const x = cx + CELL / 2, z = cz + CELL / 2;
    // The well over the core stairs (first to second floor).
    if (floor === 1 && x > -21.5 && x < -16.5 && z > -7 && z < 7) return true;
    // Where the atrium's slab broke away and fell onto the second floor.
    if (floor === 2 && x > 4 && x < 12 && z > -21 && z < -8) return true;
    // The service lift's shaft runs through every floor.
    if (x > LIFT.x0 && x < LIFT.x1 && z > LIFT.z0 && z < LIFT.z1) return true;
    return false;
}

/** The east edge of the reactor floor (y = -14): broken back further than the floors above. */
export function lowEdgeX(z: number): number {
    return 10 + Math.sin(z * 0.31 + 0.6) * 2.4 + (hash(Math.floor(z / CELL), 31) - 0.5) * 1.6;
}

/**
 * Open ground (mission 2): a heightfield under everything else. Walked on wherever nothing higher
 * is, too steep to climb past `maxSlope` (rise per meter), raycast by marching. Ignored by anything
 * well below it (the caverns under Noctis).
 */
export interface Terrain {
    height(x: number, z: number): number;
    /** The ARCH material of a cell, from its height and slope. */
    mat(x: number, z: number, h: number, slope: number): number;
    /** The mesh covers -half..half in x and z, in cells this many meters across. */
    half: number;
    cell: number;
    maxSlope: number;
    /** Left out of the mesh (shafts going down through it); the heightfield still holds there. */
    holes?: { x0: number; x1: number; z0: number; z1: number }[];
}

export interface Level {
    /** Which mission's map (1 the Central Spire, 2 Noctis). */
    mission: number;
    start: { pos: V3; yaw: number };
    /** The part of the map a point is in (enemies guard one; the mission reads it). */
    region: (p: V3) => string;
    /** Sky openness (te_scene bakes it into the architecture; props and characters take it per instance). */
    open: (x: number, y: number, z: number) => number;
    terrain?: Terrain;
    /** Ray can't leave this rectangle (the canyon walls should stop him first). */
    bounds?: { x0: number; x1: number; z0: number; z1: number };
    boxes: Box[];
    ramps: Ramp[];
    props: Prop[];
    enemies: EnemySpawn[];
    pickups: Pickup[];
    lights: LevelLight[];
    checkpoints: Checkpoint[];
    /** Distant city: towers, bridges (drawn, not collided). */
    skyline: Prop[];
    doors: Door[];
    uses: UseSpot[];
    items: ItemSpot[];
    darkZones: DarkZone[];
}

export function buildLevel(): Level {
    const boxes: Box[] = [];
    const add = (min: V3, max: V3, mat: number, tint: V3 = [1, 1, 1], opts: Partial<Box> = {}) =>
        boxes.push({ min, max, mat, tint, draw: true, solid: true, ...opts });

    // --- Slabs: per 2 m cell, cut at the blast edge and the holes. Edge cells crumble lower.
    FLOORS.forEach((y, f) => {
        for (let cz = -HALF; cz < HALF; cz += CELL) for (let cx = -HALF; cx < HALF; cx += CELL) {
            const edge = edgeX(f, cz + CELL / 2);
            if (cx + CELL > edge + 0.5 || holed(f, cx, cz)) continue;
            const ragged = cx + CELL > edge - 1.5;
            const drop = ragged ? 0.08 + hash(cx, cz, f) * 0.25 : 0;
            const marble = f === 2 && Math.hypot(cx + 1 - PEDESTAL[0], cz + 1 - PEDESTAL[2]) < 11;
            const shade = 0.9 + hash(cz, cx, f + 7) * 0.12;
            add([cx, y - SLAB - drop, cz], [cx + CELL, y - drop * 0.5, cz + CELL], marble ? MAT.marble : MAT.concrete, marble ? [0.72, 0.68, 0.64] : [shade * 0.85, shade * 0.82, shade * 0.8]);
        }
    });
    // The roof over the atrium, with the sky showing through a great tear in its east half.
    for (let cz = -HALF; cz < HALF; cz += CELL * 2) for (let cx = -HALF; cx < HALF; cx += CELL * 2) {
        const tear = cx > -4 + Math.sin(cz * 0.3) * 4 || Math.hypot(cx - 2, cz) < 9;
        if (tear) continue;
        add([cx, ROOF_Y - 1, cz], [cx + CELL * 2, ROOF_Y, cz + CELL * 2], MAT.concrete, [0.75, 0.72, 0.7], { solid: false });
    }
    // Below: the tower's lower floors, broken back further the lower they are (seen over the edge).
    // The reactor floor (k = 2, y = -14) is walked on; the lift's shaft goes through the one above.
    for (let k = 1; k <= 6; k++) {
        const y = -7 * k;
        if (y === LOW_FLOOR) {
            for (let cz = -HALF; cz < HALF; cz += CELL) for (let cx = -HALF; cx < HALF; cx += CELL) {
                const edge = lowEdgeX(cz + CELL / 2);
                if (cx + CELL > edge + 0.5) continue;
                const drop = cx + CELL > edge - 1.5 ? 0.08 + hash(cx, cz, 9) * 0.2 : 0;
                const shade = 0.88 + hash(cz, cx, 19) * 0.12;
                add([cx, y - SLAB - drop, cz], [cx + CELL, y - drop * 0.5, cz + CELL], MAT.concrete, [shade * 0.8, shade * 0.78, shade * 0.76]);
            }
            continue;
        }
        for (let cz = -HALF; cz < HALF; cz += CELL * 2) {
            const e = 11 + Math.sin(cz * 0.21 + k) * 4 - k * 0.6 + hash(cz, k) * 3;
            const shaft = k === 1 && cz + CELL * 2 > LIFT.z0 && cz < LIFT.z1;
            add([shaft ? LIFT.x1 : -HALF, y - SLAB, cz], [e, y, cz + CELL * 2], MAT.concrete, [0.8, 0.78, 0.76], { solid: false });
        }
    }
    // The shaft of the tower down to the city: a solid core seen through the fog.
    add([-HALF, CITY_FLOOR, -HALF], [2, -45, HALF], MAT.concrete, [0.6, 0.58, 0.56], { solid: false, uvScale: 0.25 });

    // --- Facade: granite columns on the north, south and west faces, every 4 m, up to the roof;
    // spandrel beams at each floor. The east face is gone except stumps.
    const colTop = (x: number, z: number) => (x > 4 ? 14 + hash(x, z) * 6 : ROOF_Y);
    for (let t = -HALF; t <= HALF; t += 4) {
        for (const [x, z] of [[t, -HALF], [t, HALF], [-HALF, t]] as [number, number][]) {
            if (x > edgeX(0, z) - 1) continue;
            const top = colTop(x, z);
            // Down to the reactor floor where that floor still reaches.
            const foot = x < lowEdgeX(z) - 1 ? LOW_FLOOR - SLAB : -0.6;
            add([x - 0.5, foot, z - 0.5], [x + 0.5, top, z + 0.5], MAT.granite, [0.58, 0.54, 0.5]);
        }
    }
    for (const fy of [...FLOORS, 27, ROOF_Y - 1]) {
        for (const side of [-1, 1]) {
            const z = side * HALF;
            const e = Math.min(edgeX(0, z), fy >= 14 ? 6 : 99);
            add([-HALF, fy - 1.1, z - 0.45], [e, fy - (fy === 0 || fy === 7 || fy === 14 ? 0.55 : 0), z + 0.45], MAT.granite, [0.5, 0.47, 0.44], { solid: fy < 20 });
        }
        add([-HALF - 0.45, fy - 1.1, -HALF], [-HALF + 0.45, fy - (fy === 0 || fy === 7 || fy === 14 ? 0.55 : 0), HALF], MAT.granite, [0.5, 0.47, 0.44], { solid: fy < 20 });
    }
    // Low parapets between the columns stop a walk out of a window; the glass is long gone.
    for (const fy of [LOW_FLOOR, ...FLOORS]) {
        for (const side of [-1, 1]) add([-HALF, fy, side * HALF - 0.2], [Math.min((fy === LOW_FLOOR ? lowEdgeX(side * HALF) : edgeX(0, side * HALF)) - 1, 20), fy + 0.9, side * HALF + 0.2], MAT.metal, [0.45, 0.4, 0.35]);
        add([-HALF - 0.2, fy, -HALF], [-HALF + 0.2, fy + 0.9, HALF], MAT.metal, [0.45, 0.4, 0.35]);
    }

    // --- Interior columns, every 8 m inside, through the floors (broken where the blast reached).
    for (let x = -16; x <= 16; x += 8) for (let z = -16; z <= 16; z += 8) {
        for (let f = 0; f < 2; f++) {
            if (x > edgeX(f, z) - 2 || x > edgeX(f + 1, z) - 2) continue;
            if (f === 1 && Math.hypot(x - PEDESTAL[0], z - PEDESTAL[2]) < 4) continue;
            // Nothing holds up a slab that is gone (the fallen piece lies across that column).
            if (holed(f + 1, x - CELL / 2, z - CELL / 2)) continue;
            add([x - 0.45, FLOORS[f], z - 0.45], [x + 0.45, FLOORS[f + 1] - SLAB, z + 0.45], MAT.concrete, [0.82, 0.8, 0.78]);
        }
        // Atrium: only the ring of columns around its edge rises to the roof.
        if (Math.abs(x) === 16 || Math.abs(z) === 16) if (x < edgeX(2, z) - 2) add([x - 0.55, 14, z - 0.55], [x + 0.55, ROOF_Y - 1, z + 0.55], MAT.granite, [0.56, 0.52, 0.48]);
    }

    // --- First floor: the Secret Doctor's lab (south-west), walls of wood-paneled brick.
    const wall = (x0: number, z0: number, x1: number, z1: number, y0: number, h: number, mat: number = MAT.brick, tint: V3 = [0.62, 0.52, 0.48]) =>
        add([Math.min(x0, x1) - 0.15, y0, Math.min(z0, z1) - 0.15], [Math.max(x0, x1) + 0.15, y0 + h, Math.max(z0, z1) + 0.15], mat, tint);
    wall(-23.6, -10, -15, -10, 0, 3.4);           // lab north wall, west part
    wall(-12.4, -10, -8, -10, 0, 3.4);            // lab north wall, east part (a gap 2.4 m wide: the doorway)
    wall(-8, -23.6, -8, -10, 0, 3.4);             // lab east wall
    add([-23.6, 3.4, -23.6], [-8, 3.6, -10], MAT.wood, [0.6, 0.5, 0.42]);  // lab ceiling (it's a room in a hall)
    add([-15, 2.8, -10.15], [-12.4, 3.4, -9.85], MAT.brick, [0.85, 0.8, 0.75]); // over the door

    // The core: stairs from the first floor up to the second, between two walls, climbing north.
    const stairX0 = -21, stairX1 = -17, stairZ0 = -6, stairZ1 = 6, steps = 28;
    for (let s = 0; s < steps; s++) {
        const z0 = stairZ0 + ((stairZ1 - stairZ0) * s) / steps, z1 = stairZ0 + ((stairZ1 - stairZ0) * (s + 1)) / steps;
        add([stairX0, 0, z0], [stairX1, (7 * (s + 1)) / steps, z1], MAT.concrete, [0.72, 0.7, 0.68]);
    }
    wall(-21.3, -6, -21.3, 8, 0, 7);
    wall(-16.7, -6, -16.7, 8, 0, 7, MAT.concrete, [0.7, 0.68, 0.66]);
    add([-21.3, 7, 6], [-16.7, 7.0001, 8], MAT.concrete, [0.72, 0.7, 0.68], { draw: false }); // landing lip

    // --- Second floor: the stairs come up beside the hall, the straight way east; the dark zone fills
    // it. The way round is the north wing and the blown-out east edge, then south to the fallen slab.
    wall(-16, -6.5, 6, -6.5, 7, 3.6, MAT.concrete, [0.68, 0.66, 0.64]);
    wall(-14, 6.5, 6, 6.5, 7, 3.6, MAT.concrete, [0.68, 0.66, 0.64]);
    // South offices are a dead end: their door is buried (rubble props below), so the walls run on.
    wall(-16.5, -6.5, -16.5, -24, 7, 3.6, MAT.concrete, [0.68, 0.66, 0.64]);

    const ramps: Ramp[] = [
        // The atrium's slab that broke away and fell: from the second floor (south) up to the atrium.
        { x0: 5, x1: 11, z0: -22, z1: -8.2, y0: 7, y1: 14, thick: 0.6, mat: MAT.concrete },
    ];

    // --- Props.
    const props: Prop[] = [
        // The lab.
        { model: "workbench", pos: [-16.4, 0, -18.4], yaw: 0, size: 2.6, collide: [1.25, 0.95, 0.8] },
        { model: "upload_pod", pos: [-22.4, 0, -21.5], yaw: Math.PI * 0.5, size: 2.4, collide: [0.55, 1.2, 0.55] },
        { model: "upload_pod", pos: [-22.4, 0, -18.8], yaw: Math.PI * 0.5, size: 2.4, collide: [0.55, 1.2, 0.55] },
        { model: "upload_pod", pos: [-22.4, 0, -16.1], yaw: Math.PI * 0.5, size: 2.4, collide: [0.55, 1.2, 0.55] },
        { model: "holo_terminal", pos: [-11, 0, -21.8], yaw: Math.PI, size: 1.5, collide: [0.4, 0.75, 0.4] },
        { model: "boiler", pos: [-21.6, 0, -12.2], yaw: Math.PI * 0.5, size: 3.2, collide: [0.9, 1.6, 0.9] },
        { model: "junk", pos: [-10, 0, -12.5], yaw: 0.4, size: 2.2, collide: [0.9, 0.35, 0.9] },
        // First floor hall.
        { model: "rubble", pos: [-2, 0, -12], yaw: 0.6, size: 4, collide: [1.6, 0.5, 1.6], sink: 0.15 },
        { model: "girders", pos: [4, 0, 4], yaw: 1.1, size: 5, collide: [2, 0.55, 1.2] },
        { model: "carcass", pos: [9.5, 0, -6], yaw: -2.2, size: 1.9, collide: [0.6, 0.6, 0.6] },
        { model: "junk", pos: [-6, 0, 10], yaw: 2.1, size: 2.6, collide: [1.1, 0.4, 1.1] },
        { model: "rubble", pos: [10, 0, 14], yaw: 2.5, size: 5, collide: [2, 0.6, 2], sink: 0.2 },
        { model: "hovercar", pos: [13.2, 0.35, -15.5], yaw: 0.35, size: 6.5, collide: [2.8, 1.0, 1.6] },
        // Second floor.
        { model: "dark_emitter", pos: [DARK_ZONE.center[0], 7, DARK_ZONE.center[2]], yaw: 0.3, size: 2.4, collide: [0.9, 0.8, 0.9] },
        { model: "rubble", pos: [-12.5, 7, -12], yaw: 0.2, size: 5, collide: [2.2, 0.7, 2.2], sink: 0.2 },
        { model: "girders", pos: [-3, 7, 14], yaw: 0.3, size: 5, collide: [2, 0.5, 1.4] },
        { model: "junk", pos: [8, 7, 10], yaw: 1.4, size: 2.4, collide: [1, 0.4, 1] },
        { model: "carcass", pos: [4, 7, -11], yaw: 0.8, size: 1.9, collide: [0.6, 0.6, 0.6] },
        { model: "rubble", pos: [12.5, 7, -23], yaw: 1.7, size: 3.4, collide: [1.4, 0.5, 1.4], sink: 0.15 },
        // The atrium.
        { model: "pedestal", pos: [PEDESTAL[0], 14, PEDESTAL[2]], yaw: 0, size: 5.2, collide: [2.3, 1.1, 2.3] },
        { model: "girders", pos: [-9, 14, -8], yaw: 2.4, size: 5.5, collide: [2.2, 0.55, 1.4] },
        { model: "rubble", pos: [-10, 14, 9], yaw: 0.9, size: 4.5, collide: [1.8, 0.6, 1.8], sink: 0.2 },
        { model: "holo_terminal", pos: [-4.5, 14, 6.5], yaw: 2.4, size: 1.5, collide: [0.4, 0.75, 0.4] },
        { model: "holo_terminal", pos: [4.5, 14, 6.5], yaw: -2.4, size: 1.5, collide: [0.4, 0.75, 0.4] },
        { model: "junk", pos: [7, 14, 12], yaw: 0.5, size: 2.4, collide: [1, 0.4, 1] },
        { model: "carcass", pos: [-6, 14, -3], yaw: 1.9, size: 1.9, collide: [0.6, 0.6, 0.6] },
        { model: "boiler", pos: [-14, 14, -14], yaw: 0.8, size: 3.4, collide: [0.95, 1.7, 0.95] },
    ];

    const enemies: EnemySpawn[] = [
        { id: "roller-1", kind: "roller", pos: [2, 0, -8], yaw: Math.PI, zone: "spire0", patrol: [[2, 0, -8], [6, 0, 2], [-4, 0, 6], [-6, 0, -6]] },
        { id: "roller-2", kind: "roller", pos: [-2, 7, 10.5], yaw: 0, zone: "spire1", patrol: [[-2, 7, 10.5], [8, 7, 17], [7, 7, 9], [0, 7, 9]] },
        { id: "bot-1", kind: "hacked_bot", pos: [9.5, 7, -3], yaw: Math.PI, zone: "spire1", patrol: [[9.5, 7, -3], [9.5, 7, 5], [12.5, 7, -14]] },
        { id: "bot-2", kind: "hacked_bot", pos: [-6, 14, -10], yaw: 0, zone: "spire2", patrol: [[-6, 14, -10], [6, 14, -6], [-2, 14, -12]] },
        { id: "roller-3", kind: "roller", pos: [6, 14, 10], yaw: Math.PI, zone: "spire2", patrol: [[6, 14, 10], [-6, 14, 12], [-9, 14, 2], [6, 14, 4]] },
    ];

    const pickups: Pickup[] = [
        { id: "cell-lab", pos: [-11.5, 0, -14] },
        { id: "cell-edge", pos: [8, 0, 8] },
        { id: "cell-stair", pos: [-19, 7, 9.5] },
        { id: "cell-ledge", pos: [8.5, 7, 2] },
        { id: "cell-atrium", pos: [-12, 14, 2] },
    ];

    const lights: LevelLight[] = [
        { pos: [-16.4, 3, -18.4], color: [1, 0.72, 0.42], intensity: 5, range: 12 },
        { pos: [-12, 2.8, -13], color: [1, 0.8, 0.6], intensity: 2.5, range: 9 },
        { pos: [-11, 1.8, -21.8], color: [0.3, 0.85, 1], intensity: 2.2, range: 5, flicker: 0.3 },
        { pos: [-21, 1.6, -12.2], color: [0.4, 1, 0.45], intensity: 1.6, range: 4.5 },
        { pos: [-19, 6, 0], color: [1, 0.2, 0.12], intensity: 2.4, range: 9, flicker: 0.6 },
        { pos: [13, 1.5, -15], color: [1, 0.45, 0.15], intensity: 3.5, range: 8, flicker: 0.8 },
        { pos: [DARK_ZONE.center[0], 8.5, DARK_ZONE.center[2]], color: [0.55, 0.15, 1], intensity: 3, range: 10 },
        { pos: [PEDESTAL[0], HYPERCUBE_Y, PEDESTAL[2]], color: [0.55, 0.8, 1], intensity: 6, range: 22 },
        { pos: [-4.5, 15.6, 6.5], color: [0.3, 0.85, 1], intensity: 1.4, range: 4 },
        { pos: [4.5, 15.6, 6.5], color: [0.3, 0.85, 1], intensity: 1.4, range: 4 },
        { pos: [-14, 15.5, -14], color: [0.4, 1, 0.45], intensity: 1.4, range: 4.5 },
    ];

    const checkpoints: Checkpoint[] = [
        { id: "lab", pos: START.pos, yaw: START.yaw, radius: 3 },
        { id: "second-floor", pos: [-19, 7, 9.5], yaw: Math.PI * 0.5, radius: 3 },
        { id: "fallen-slab", pos: [8, 7, -23], yaw: 0, radius: 3 },
        { id: "atrium", pos: [8, 14, -5], yaw: Math.PI, radius: 3 },
    ];

    // --- The service lift: a shaft of brick from the reactor floor up past the atrium, gated at the
    // bottom and the top (south side); the first and second floors only see its walls.
    const L = LIFT, shaftTop = L.top + 7;
    const gate = (y: number) => [[L.x0, y, L.z0 - 0.15], [L.x0 + 0.9, y + 3.4, L.z0 + 0.15], [L.x1 - 0.9, y, L.z0 - 0.15], [L.x1, y + 3.4, L.z0 + 0.15], [L.x0, y + 3.4, L.z0 - 0.15], [L.x1, y + 7 - SLAB, L.z0 + 0.15]] as V3[];
    for (const y of [L.bottom, -7, 0, 7, L.top]) {
        if (y === L.bottom || y === L.top) { const g = gate(y); for (let i = 0; i < g.length; i += 2) add(g[i], g[i + 1], MAT.brick, [0.6, 0.5, 0.45]); }
        else add([L.x0, y - SLAB, L.z0 - 0.15], [L.x1, y + 7 - SLAB, L.z0 + 0.15], MAT.brick, [0.6, 0.5, 0.45]);
    }
    add([L.x1 - 0.15, L.bottom, L.z0], [L.x1 + 0.15, shaftTop, L.z1], MAT.brick, [0.6, 0.5, 0.45]);
    add([L.x0, L.bottom, L.z1 - 0.15], [L.x1, shaftTop, L.z1 + 0.15], MAT.brick, [0.6, 0.5, 0.45]);
    add([L.x0 - 0.3, L.bottom, L.z0], [L.x0, shaftTop, L.z1], MAT.brick, [0.6, 0.5, 0.45]);
    add([L.x0 - 0.3, shaftTop, L.z0 - 0.15], [L.x1 + 0.15, shaftTop + 0.5, L.z1 + 0.15], MAT.concrete, [0.7, 0.68, 0.66]);
    const doors: Door[] = [
        { id: "lift-bottom", min: [L.x0 + 0.9, L.bottom, L.z0 - 0.1], max: [L.x1 - 0.9, L.bottom + 3.4, L.z0 + 0.1], mat: MAT.metal, tint: [0.55, 0.48, 0.38] },
        { id: "lift-top", min: [L.x0 + 0.9, L.top, L.z0 - 0.1], max: [L.x1 - 0.9, L.top + 3.4, L.z0 + 0.1], mat: MAT.metal, tint: [0.55, 0.48, 0.38] },
    ];

    return { mission: 1, start: START, region: regionOf, open: openness, boxes, ramps, props, enemies, pickups, lights, checkpoints, skyline: buildSkyline(), doors, uses: [], items: [], darkZones: [DARK_ZONE] };
}

/** Which part of the mission a point is in (enemies guard one; the mission reads it too). */
export type Region = string;
export function regionOf(p: V3): Region {
    const [x, y, z] = p;
    if (x > LIFT.x0 && x < LIFT.x1 && z > LIFT.z0 && z < LIFT.z1 && y > LOW_FLOOR - 1) return "lift";
    if (x >= 89.5 && x <= 126.5 && z >= -18.5 && z <= 18.5) {
        if (x < 98 && z < -7 && y < 13) return "shaft";
        if (y >= 13) return "relay14";
        if (y >= 6) return "relay7";
        return "shaft";
    }
    if (y < -8) return x < 13 && Math.abs(x) <= HALF && Math.abs(z) <= HALF ? "reactor" : z > -17 && z < -7 ? "lowbridge" : "void";
    if (x > 16 && y > 10 && Math.abs(z) < 4) return "bridge";
    if (y >= FLOORS[2] - 1) return "spire2";
    if (y >= FLOORS[1] - 1) return "spire1";
    if (y >= -1) return "spire0";
    return "void";
}

/** The ruined capital around the spire: towers on rings out to 1.4 km, a few sky bridges. */
function buildSkyline(): Prop[] {
    const out: Prop[] = [];
    let k = 0;
    for (const [r0, n] of [[160, 9], [330, 14], [620, 20], [1100, 26]] as [number, number][]) {
        for (let i = 0; i < n; i++, k++) {
            const a = (i / n) * Math.PI * 2 + hash(k) * 0.4;
            const r = r0 + hash(k, 1) * r0 * 0.35;
            const x = Math.cos(a) * r, z = Math.sin(a) * r;
            const height = (r0 < 200 ? 240 : 180) + hash(k, 2) * 260;
            out.push({ model: hash(k, 3) > 0.5 ? "tower_a" : "tower_b", pos: [x, CITY_FLOOR, z], yaw: hash(k, 4) * Math.PI * 2, size: height });
        }
    }
    // Sky bridges between the near towers, some snapped (the model already is).
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.3;
        const r = 220 + hash(i, 9) * 80;
        out.push({ model: "bridge", pos: [Math.cos(a) * r, -20 + hash(i, 8) * 70, Math.sin(a) * r], yaw: a + Math.PI / 2, size: 70 });
    }
    return out;
}

// --- Collision ----------------------------------------------------------------------------------------

export interface Solid { min: V3; max: V3 }

/** A uniform grid over xz of the solid boxes, for ground, wall and ray queries. */
export class World {
    readonly solids: Solid[] = [];
    readonly ramps: Ramp[];
    /** Solids that move (doors): checked on every query, outside the grid. */
    readonly dynamic: Solid[] = [];
    readonly terrain: Terrain | undefined;
    private grid = new Map<number, number[]>();
    private static readonly G = 4;

    constructor(level: Level, propBoxes: Solid[]) {
        this.terrain = level.terrain;
        for (const b of level.boxes) if (b.solid) this.solids.push({ min: b.min, max: b.max });
        this.solids.push(...propBoxes);
        this.ramps = level.ramps;
        this.solids.forEach((s, i) => {
            for (let gx = Math.floor(s.min[0] / World.G); gx <= Math.floor(s.max[0] / World.G); gx++)
                for (let gz = Math.floor(s.min[2] / World.G); gz <= Math.floor(s.max[2] / World.G); gz++) {
                    const key = gx * 100003 + gz;
                    let list = this.grid.get(key);
                    if (!list) this.grid.set(key, list = []);
                    list.push(i);
                }
        });
    }

    private near(x0: number, z0: number, x1: number, z1: number, out: Set<number>): Set<number> {
        out.clear();
        for (let gx = Math.floor(Math.min(x0, x1) / World.G); gx <= Math.floor(Math.max(x0, x1) / World.G); gx++)
            for (let gz = Math.floor(Math.min(z0, z1) / World.G); gz <= Math.floor(Math.max(z0, z1) / World.G); gz++) {
                const list = this.grid.get(gx * 100003 + gz);
                if (list) for (const i of list) out.add(i);
            }
        return out;
    }
    private scratch = new Set<number>();

    /** Height of a ramp's top at (x, z), or -Infinity off it. */
    rampTop(r: Ramp, x: number, z: number): number {
        if (x < r.x0 || x > r.x1 || z < Math.min(r.z0, r.z1) || z > Math.max(r.z0, r.z1)) return -Infinity;
        return r.y0 + ((z - r.z0) / (r.z1 - r.z0)) * (r.y1 - r.y0);
    }

    /** The highest walkable top under a disc at (x, z) of radius r that is no higher than `maxY`. */
    groundAt(x: number, z: number, r: number, maxY: number): number {
        let best = -Infinity;
        for (const i of this.near(x - r, z - r, x + r, z + r, this.scratch)) {
            const s = this.solids[i];
            if (x + r * 0.5 < s.min[0] || x - r * 0.5 > s.max[0] || z + r * 0.5 < s.min[2] || z - r * 0.5 > s.max[2]) continue;
            if (s.max[1] <= maxY && s.max[1] > best) best = s.max[1];
        }
        for (const s of this.dynamic) {
            if (x + r * 0.5 < s.min[0] || x - r * 0.5 > s.max[0] || z + r * 0.5 < s.min[2] || z - r * 0.5 > s.max[2]) continue;
            if (s.max[1] <= maxY && s.max[1] > best) best = s.max[1];
        }
        for (const rp of this.ramps) {
            const t = this.rampTop(rp, x, z);
            if (t <= maxY + 0.05 && t > best) best = t;
        }
        if (this.terrain) {
            const t = this.terrain.height(x, z);
            if (t <= maxY + 0.05 && t > best) best = t;
        }
        return best;
    }

    /**
     * A move from (ox, oz) to (x, z) by feet at `feet`, stopped (or slid along one axis) where the
     * ground rises too steeply: canyon walls, mesa flanks, the canal's banks. Underground it's no wall.
     */
    terrainWall(ox: number, oz: number, x: number, z: number, feet: number): [number, number] {
        const T = this.terrain;
        if (!T) return [x, z];
        const ho = T.height(ox, oz);
        if (feet < ho - 1.5) return [x, z];
        const ok = (nx: number, nz: number) => {
            const rise = T.height(nx, nz) - Math.max(feet, ho), d = Math.hypot(nx - ox, nz - oz);
            return rise <= 0.04 || rise <= d * T.maxSlope;
        };
        if (ok(x, z)) return [x, z];
        if (ok(x, oz)) return [x, oz];
        if (ok(ox, z)) return [ox, z];
        return [ox, oz];
    }

    /**
     * Pushes a vertical cylinder (feet y, height h, radius r) out of every box it overlaps whose
     * top is above `stepY` (lower ones are stepped onto). Returns the corrected x, z.
     */
    pushOut(x: number, z: number, y: number, h: number, r: number, stepY: number): [number, number] {
        for (let pass = 0; pass < 2; pass++) {
            const list = [...this.near(x - r, z - r, x + r, z + r, this.scratch)].map(i => this.solids[i]);
            for (const s of [...list, ...this.dynamic]) {
                if (s.max[1] <= stepY || s.min[1] >= y + h) continue;
                const cx = Math.max(s.min[0], Math.min(x, s.max[0])), cz = Math.max(s.min[2], Math.min(z, s.max[2]));
                const dx = x - cx, dz = z - cz, d = Math.hypot(dx, dz);
                if (d >= r) continue;
                if (d > 1e-5) { x = cx + (dx / d) * r; z = cz + (dz / d) * r; }
                else {
                    // Inside the box: out the nearest side.
                    const opts = [[s.min[0] - r - x, 0], [s.max[0] + r - x, 0], [0, s.min[2] - r - z], [0, s.max[2] + r - z]];
                    opts.sort((a, b) => Math.abs(a[0] + a[1]) - Math.abs(b[0] + b[1]));
                    x += opts[0][0]; z += opts[0][1];
                }
            }
        }
        return [x, z];
    }

    /** Whether anything solid overlaps a vertical cylinder from y0 to y1 (room to stand up). */
    blocked(x: number, z: number, r: number, y0: number, y1: number): boolean {
        for (const i of this.near(x - r, z - r, x + r, z + r, this.scratch)) {
            const s = this.solids[i];
            if (s.max[1] <= y0 || s.min[1] >= y1) continue;
            const cx = Math.max(s.min[0], Math.min(x, s.max[0])), cz = Math.max(s.min[2], Math.min(z, s.max[2]));
            if (Math.hypot(x - cx, z - cz) < r * 0.9) return true;
        }
        return false;
    }

    /** Distance along the ray to the first box or ramp it hits, or Infinity (dir unit length). */
    raycast(o: V3, d: V3, maxT: number): { t: number; normal: V3 } {
        let best = maxT, normal: V3 = [0, 1, 0];
        const ex = o[0] + d[0] * maxT, ez = o[2] + d[2] * maxT;
        const candidates = maxT < 80 ? this.near(o[0], o[2], ex, ez, this.scratch) : null;
        const test = (s: Solid) => {
            let t0 = 0, t1 = best, axis = -1, sign = 1;
            for (let a = 0; a < 3; a++) {
                if (Math.abs(d[a]) < 1e-9) { if (o[a] < s.min[a] || o[a] > s.max[a]) return; continue; }
                let ta = (s.min[a] - o[a]) / d[a], tb = (s.max[a] - o[a]) / d[a];
                let sg = -1;
                if (ta > tb) { [ta, tb] = [tb, ta]; sg = 1; }
                if (ta > t0) { t0 = ta; axis = a; sign = sg; }
                if (tb < t1) t1 = tb;
                if (t0 > t1) return;
            }
            if (axis >= 0 && t0 < best) { best = t0; normal = [0, 0, 0]; normal[axis] = sign; }
        };
        if (candidates) for (const i of candidates) test(this.solids[i]);
        else for (const s of this.solids) test(s);
        for (const s of this.dynamic) test(s);
        // Ramps: step along the ray (they're few and long).
        for (const r of this.ramps) {
            const steps = Math.ceil(best / 0.25);
            for (let k = 1; k <= steps; k++) {
                const t = (k / steps) * best;
                const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t;
                const top = this.rampTop(r, x, z);
                if (y <= top && y >= top - r.thick - 0.3) {
                    best = t;
                    const slope = (r.y1 - r.y0) / (r.z1 - r.z0);
                    const l = Math.hypot(1, slope);
                    normal = [0, 1 / l, -slope / l];
                    break;
                }
            }
        }
        if (this.terrain) {
            const hit = this.marchTerrain(o, d, best);
            if (hit) { best = hit.t; normal = hit.normal; }
        }
        return best < maxT ? { t: best, normal } : { t: Infinity, normal };
    }

    /** The first point along a ray under the terrain (from above it), refined by bisection. */
    private marchTerrain(o: V3, d: V3, maxT: number): { t: number; normal: V3 } | null {
        const T = this.terrain!;
        const above = (t: number) => o[1] + d[1] * t - T.height(o[0] + d[0] * t, o[2] + d[2] * t);
        let gap = above(0);
        if (gap < 0) return null;
        let t = 0;
        while (t < maxT) {
            const step = Math.max(0.35, Math.min(10, gap * 0.4));
            const next = Math.min(maxT, t + step);
            const g = above(next);
            if (g < 0) {
                let a = t, b = next;
                for (let i = 0; i < 8; i++) { const m = (a + b) / 2; if (above(m) < 0) b = m; else a = m; }
                const x = o[0] + d[0] * b, z = o[2] + d[2] * b, e = 0.5;
                const nx = T.height(x - e, z) - T.height(x + e, z), nz = T.height(x, z - e) - T.height(x, z + e);
                const l = Math.hypot(nx, 2 * e, nz);
                return { t: b, normal: [nx / l, (2 * e) / l, nz / l] };
            }
            if (next >= maxT) break;
            t = next; gap = g;
            // Going up and already well clear: nothing to hit (the walls top out at ~70 m).
            if (d[1] > 0.2 && gap > 80) break;
        }
        return null;
    }
}

/**
 * How open to the sky a point is (0 deep inside, 1 outside): ambient light baked into the
 * architecture's vertices and given to props per instance.
 */
export function openness(x: number, y: number, z: number): number {
    // The Relay Tower: a lit entry floor, a dark archive below, a darker shaft.
    if (x > 89.6 && x < 126.4 && Math.abs(z) < 18.4) {
        const facade = Math.min(x - 90, 126 - x, 18 - Math.abs(z));
        if (x < 98 && z < -7 && y < 13.5) return 0.08;
        if (y >= 13.5) return Math.min(1, 0.22 + smooth(4, 0.3, facade) * 0.4);
        return 0.07 + smooth(3, 0.3, facade) * 0.12;
    }
    if (y < -1) {
        // The reactor floor: open toward its broken east edge, the lift shaft closed in.
        if (y > LOW_FLOOR - 2 && x < lowEdgeX(z) + 0.5 && Math.abs(z) < HALF + 0.5 && x > -HALF - 0.5) {
            if (x > LIFT.x0 && x < LIFT.x1 && z > LIFT.z0 && z < LIFT.z1) return 0.1;
            const e = lowEdgeX(z);
            return Math.max(0.06, Math.min(1, 0.12 + smooth(e - 8, e + 1, x) * 0.7 + smooth(4, 0.5, Math.min(HALF - Math.abs(z), x + HALF)) * 0.2));
        }
        return 0.7;
    }
    if (x > LIFT.x0 && x < LIFT.x1 && z > LIFT.z0 && z < LIFT.z1) return 0.1;
    const f = y >= 13.5 ? 2 : y >= 6.5 ? 1 : 0;
    if (f === 2) {
        // The atrium: open under the roof's tear, high walls of windows.
        const tear = x > -4 + Math.sin(z * 0.3) * 4 || Math.hypot(x - 2, z) < 9;
        return Math.min(1, (tear ? 0.75 : 0.45) + smooth(edgeX(2, z) - 6, edgeX(2, z) + 2, x) * 0.3);
    }
    const above = f + 1;
    const edge = Math.min(edgeX(above, z), edgeX(f, z));
    let o = 0.16 + smooth(edge - 7, edge + 1, x) * 0.7;
    const facade = Math.min(HALF - Math.abs(z), x + HALF);
    o += smooth(4, 0.5, facade) * 0.25;
    // The lab is a closed room.
    if (f === 0 && x < -8 && z < -10) o *= 0.55;
    return Math.max(0.05, Math.min(1, o));
}

function smooth(a: number, b: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}
