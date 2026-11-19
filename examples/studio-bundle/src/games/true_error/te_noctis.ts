// Mission 2: Noctis. The canyon floor of Noctis Labyrinthus, under the capital's plateau. Open
// ground (a heightfield, te_level.ts Terrain) between canyon walls, with mesas and a dry canal
// cutting it into routes, and a handful of places that mattered before the Last Day:
//
//   the camp          north, at the foot of the spire's freight lift: the Doctor's rover. Ray starts here.
//   the Avatar Foundry east: the bodies were built here. In by the loading bay (watched), up the
//                     rubble through the broken north wall to the catwalk, or crouched through the
//                     culvert in the south wall. The printing line is still running.
//   Gate Four         west: the upload gate's plaza, dark radiation at its heart, cherubs over it.
//                     The front steps, the side stair, or the broken highway whose missing span only
//                     the simulation lens shows.
//   the barge         south: the Patience, crashed across the canal. Its mast's winch is on the quay.
//   the pumphouse     south-west, on the canal: survivors, and the Error's harvest pods in its yard.
//   the quarry        south-east: the Tithe's camp and their lift down to the Undercroft.
//   the Undercroft    under the quarry (y = -44): the pit, the cable heart, the metro tunnel, the hoist.
//   the ledge         the Tithe's lookout cut into the south wall (y = 30), where the hoist comes up.
//
// Coordinates as in te_level.ts: meters, +y up, +x east, +z north (toward the capital).

import { MAT, hash, type Level, type Box, type V3, type Prop, type EnemySpawn, type LevelLight, type Terrain, type Ramp, type DarkZone, type Checkpoint } from "./te_level";

// --- Places ---------------------------------------------------------------------------------------

export const CAMP = { doctor: [-1, 0, 141] as V3, rover: [7, 0, 145] as V3, radio: [-4.5, 0, 143.5] as V3, start: { pos: [-1.5, 0, 149] as V3, yaw: Math.PI } };
export const FOUNDRY = { x0: 104, x1: 148, z0: 26, z1: 58, h: 12, catwalk: 5.2 };
export const PULPIT: V3 = [141, 1.2, 51];
export const LOCKER: V3 = [107, FOUNDRY.catwalk, 55.5];
export const GATE = { center: [-120, 1.2, 50] as V3, x0: -150, x1: -90, z0: 20, z1: 80, top: 1.2, gallery: 7 };
export const GATE_DARK: DarkZone = { id: "gate", center: [-120, 1.2, 50], radius: 8.5 };
/** The gate's three terminals; only one ran its last session (the sim lens's ghost queue leads there). */
export const TERMINALS: { id: string; pos: V3; yaw: number }[] = [
    { id: "term-a", pos: [-125.5, 1.2, 45.5], yaw: -2.25 },
    { id: "term-b", pos: [-114.5, 1.2, 46], yaw: 2.2 },
    { id: "term-c", pos: [-120, 1.2, 58.5], yaw: 0 },
];
export const RIGHT_TERMINAL = "term-b";
export const BARGE: V3 = [18, -6, -60];
export const MAST: V3 = [68, 0, -45];
export const WINCH: V3 = [63.5, 0, -44];
/** Seconds of cranking to raise the mast, and the points that bring the hull's things out. */
export const CRANK = { seconds: 16, waves: [0.3, 0.65] };
export const PUMPHOUSE = { x0: -122, x1: -108, z0: -112, z1: -100, h: 6 };
export const BEACONS: { id: string; pos: V3 }[] = [
    { id: "beacon-w", pos: [-139, 0, -113] },
    { id: "beacon-e", pos: [-99, 0, -121] },
    { id: "beacon-n", pos: [-127, 0, -87] },
];
export const SURVIVORS = { mara: [-117, 0, -105.5] as V3, oduya: [-112, 0, -108] as V3, pip: [-115, 0, -103.8] as V3 };
export const QUARRY = { c: [130, -10, -125] as V3, r: 20 };
/** The lifts: the Tithe's into the Undercroft, and the maintenance hoist up to their ledge. */
export const QLIFT = { id: "quarry", x0: 127, x1: 133, z0: -128, z1: -122, bottom: -44, top: -10 };
export const HOIST = { id: "hoist", x0: 170, x1: 175.6, z0: -186, z1: -180.4, bottom: -44, top: 30 };
export const UNDER_Y = -44;
export const NEST: V3 = [86, UNDER_Y, -157.5];
export const LEDGE = { x0: 150, x1: 192, z0: -202, z1: -178, y: 30 };
export const OVERLOOK: V3 = [156, 30, -180.5];
/** Where the Tithe wait at the pumphouse, and at the quarry lift once they've walked there. */
export const TITHE_AT = { vesper: [-104, 0, -96] as V3, scav1: [-100.5, 0, -94] as V3, scav2: [-101, 0, -99] as V3 };
export const TITHE_LIFT = { vesper: [134.5, -10, -119.5] as V3, scav1: [126, -10, -118] as V3, scav2: [136.5, -10, -126] as V3 };
/** The Tithe's ambush on the ledge when the hoist comes up. */
export const AMBUSH: V3[] = [[166, 30, -190], [178, 30, -196], [183, 30, -185.5], [158, 30, -190], [189, 30, -185]];
/** Where the sim lens shows the gate's old queue, from the plaza steps to the right terminal. */
export const QUEUE: V3[] = [[-120, 1.2, 21], [-117, 1.2, 25], [-115, 1.2, 30], [-113.5, 1.2, 35], [-113, 1.2, 40], [-113.6, 1.2, 44.2]];

// --- The ground ----------------------------------------------------------------------------------

const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const canalZ = (x: number) => -60 + 5 * Math.sin(x * 0.018);
/** Where the canal's banks are gentle enough to walk (x), everywhere else they're too steep. */
const CANAL_RAMPS = [-150, -55, 92, 150];
interface Mesa { c: [number, number]; r: number; h: number; ramp?: [number, number] }
const MESAS: Mesa[] = [
    { c: [-20, 40], r: 24, h: 22, ramp: [0.6, -0.8] },
    { c: [60, -8], r: 15, h: 16, ramp: [0, 1] },
    { c: [-152, -30], r: 12, h: 28 },
    { c: [150, 122], r: 15, h: 24 },
    { c: [-62, 122], r: 10, h: 18 },
    { c: [82, 98], r: 9, h: 12, ramp: [-1, 0] },
];
/** Level pads: the ground under a place flattened to y, blending out over `m` meters. */
const PADS: { x0: number; x1: number; z0: number; z1: number; y: number; m: number }[] = [
    { x0: -30, x1: 30, z0: 118, z1: 170, y: 0, m: 8 },
    { x0: 98, x1: 154, z0: 20, z1: 76, y: 0, m: 6 },
    { x0: -158, x1: -82, z0: 12, z1: 88, y: 0, m: 6 },
    { x0: 54, x1: 82, z0: -50, z1: -38, y: 0, m: 3 },
    { x0: -146, x1: -90, z0: -132, z1: -79, y: 0, m: 5 },
    { x0: -70, x1: -56, z0: 36, z1: 84, y: 0, m: 4 },
    { x0: LEDGE.x0, x1: LEDGE.x1, z0: LEDGE.z0, z1: LEDGE.z1, y: LEDGE.y, m: 3 },
    { x0: 118, x1: 142, z0: -137, z1: -113, y: -10, m: 4 },
];

export function noctisHeight(x: number, z: number): number {
    // Dunes.
    let h = 1.1 * Math.sin(x * 0.031 + 1.3) * Math.sin(z * 0.027) + 0.6 * Math.sin(x * 0.071 + z * 0.05) + 0.35 * Math.sin(x * 0.17) * Math.cos(z * 0.15);
    // The canyon walls, crags and all.
    const W = 172;
    const dx = Math.max(Math.abs(x) - W, 0), dz = Math.max(Math.abs(z) - W, 0);
    const d = Math.hypot(dx, dz) + 5 * Math.sin(x * 0.05 + 0.4) + 4 * Math.sin(z * 0.07 + 1.1) - 4;
    h += 56 * smooth(0, 24, d) + 3 * Math.sin(x * 0.3) * Math.sin(z * 0.27) * smooth(0, 10, d);
    // Mesas: cliffs all round, a long ramp up where one has it.
    for (const m of MESAS) {
        const ox = x - m.c[0], oz = z - m.c[1];
        const e = Math.hypot(ox, oz) - m.r + 2.5 * Math.sin(Math.atan2(oz, ox) * 5 + m.c[0]);
        let top = m.h * (1 - smooth(0, 5, e));
        if (m.ramp) {
            const along = ox * m.ramp[0] + oz * m.ramp[1], across = Math.abs(ox * m.ramp[1] - oz * m.ramp[0]);
            if (along > 0) {
                const ramp = Math.max(0, m.h - Math.max(0, along - m.r + 3) * 0.3) * (1 - smooth(3.5, 6, across));
                top = Math.max(top, ramp);
            }
        }
        h += top;
    }
    // The canal: steep banks except at the ramps.
    const cz = Math.abs(z - canalZ(x));
    let gentle = 0;
    for (const rx of CANAL_RAMPS) gentle = Math.max(gentle, 1 - smooth(3.5, 7, Math.abs(x - rx)));
    const cut = 6 * ((1 - smooth(8, 12, cz)) * (1 - gentle) + (1 - smooth(8, 32, cz)) * gentle);
    h -= cut;
    // The quarry pit, a road down into it from the north-west.
    {
        const ox = x - QUARRY.c[0], oz = z - QUARRY.c[2], dq = Math.hypot(ox, oz);
        const along = (ox * -0.7071 + oz * 0.7071), across = Math.abs(ox * 0.7071 + oz * 0.7071);
        const steep = 1 - smooth(QUARRY.r - 2, QUARRY.r + 2, dq);
        const road = along > 0 ? (1 - smooth(QUARRY.r, QUARRY.r + 32, along)) * (1 - smooth(3, 5.5, across)) : 0;
        h -= 10 * Math.max(steep, road);
    }
    // Pads.
    for (const p of PADS) {
        const ox = Math.max(p.x0 - x, 0, x - p.x1), oz = Math.max(p.z0 - z, 0, z - p.z1);
        const k = smooth(0, p.m, Math.hypot(ox, oz));
        h = p.y + (h - p.y) * k;
    }
    return h;
}

export const NOCTIS_TERRAIN: Terrain = {
    height: noctisHeight,
    mat: (_x, _z, h, slope) => (slope > 0.75 || h > 10 ? MAT.sandstone : MAT.soil),
    half: 300,
    cell: 3,
    maxSlope: 1.05,
    holes: [
        { x0: QLIFT.x0 - 0.3, x1: QLIFT.x1 + 0.3, z0: QLIFT.z0 - 0.3, z1: QLIFT.z1 + 0.3 },
        { x0: HOIST.x0 - 0.3, x1: HOIST.x1 + 0.3, z0: HOIST.z0 - 0.3, z1: HOIST.z1 + 0.3 },
    ],
};

// --- Regions and light -----------------------------------------------------------------------------

export function noctisRegion(p: V3): string {
    const [x, y, z] = p;
    if (y < -20) return x > 104 && x < 156 && z > -168 && z < -136 ? "pit" : x < 104 && z > -166 && z < -140 ? "nest" : z < -165 ? "tunnel" : "undercroft";
    if (y > 20 && z < -170) return "ledge";
    if (x > 96 && x < 156 && z > 18 && z < 74) return "foundry";
    if (x > -162 && x < -80 && z > 10 && z < 90) return "gate";
    if (x > -150 && x < -85 && z > -132 && z < -78) return "pumphouse";
    if (Math.hypot(x - QUARRY.c[0], z - QUARRY.c[2]) < 36) return "quarry";
    if (x > -24 && x < 90 && z > -82 && z < -36) return "barge";
    if (Math.abs(z - canalZ(x)) < 13) return "canal";
    if (z > 115 && Math.abs(x) < 40) return "camp";
    return "flats";
}

const inside = (x: number, z: number, x0: number, x1: number, z0: number, z1: number) => x > x0 && x < x1 && z > z0 && z < z1;

export function noctisOpen(x: number, y: number, z: number): number {
    if (y < -20) {
        // The Undercroft: shut in, but for the lift and the hoist (the sky a long way up).
        if (inside(x, z, QLIFT.x0, QLIFT.x1, QLIFT.z0, QLIFT.z1) || inside(x, z, HOIST.x0, HOIST.x1, HOIST.z0, HOIST.z1)) return 0.12;
        return 0.06;
    }
    const F = FOUNDRY;
    if (inside(x, z, F.x0, F.x1, F.z0, F.z1) && y < F.h) {
        // Under the roof: the loading bay, the broken north wall and the skylights let some in.
        const bay = smooth(10, 0, x - F.x0) * (z > 34 && z < 50 ? 1 : 0.3);
        const north = smooth(8, 0, F.z1 - z) * (x > 112 && x < 132 ? 1 : 0.2);
        return Math.min(0.75, 0.2 + Math.max(bay, north) * 0.4 + (y > 4.5 ? 0.08 : 0));
    }
    const P = PUMPHOUSE;
    if (inside(x, z, P.x0, P.x1, P.z0, P.z1) && y < P.h) return 0.22;
    if (inside(x, z, HOIST.x0 - 0.5, HOIST.x1 + 0.5, HOIST.z0 - 0.5, HOIST.z1 + 0.5)) return 0.15;
    // Outside: the canal and the quarry sit low and shaded.
    const low = Math.max(0, -noctisHeight(x, z)) / 10;
    return Math.max(0.55, 1 - low * 0.35);
}

// --- The map --------------------------------------------------------------------------------------

export function buildNoctis(): Level {
    const boxes: Box[] = [], ramps: Ramp[] = [], props: Prop[] = [], enemies: EnemySpawn[] = [], lights: LevelLight[] = [];
    const checkpoints: Checkpoint[] = [];
    const level: Level = {
        mission: 2, start: CAMP.start, region: noctisRegion, open: noctisOpen, terrain: NOCTIS_TERRAIN,
        bounds: { x0: -200, x1: 200, z0: -205, z1: 200 },
        boxes, ramps, props, enemies, pickups: [], lights, checkpoints, skyline: buildPlateau(), doors: [], uses: [], items: [], darkZones: [GATE_DARK],
    };
    const { pickups, uses, items, doors } = level;
    const add = (min: V3, max: V3, mat: number, tint: V3 = [1, 1, 1], opts: Partial<Box> = {}) => boxes.push({ min, max, mat, tint, draw: true, solid: true, ...opts });
    const enemy = (id: string, kind: EnemySpawn["kind"], pos: V3, zone: string, patrol: V3[] = [pos], yaw = 0) => enemies.push({ id, kind, pos, yaw, zone, patrol });
    const light = (pos: V3, color: V3, intensity: number, range: number, flicker?: number) => lights.push({ pos, color, intensity, range, flicker } as LevelLight);
    const prop = (p: Prop) => props.push(p);
    const ground = (x: number, z: number) => noctisHeight(x, z);
    const at = (x: number, z: number, dy = 0): V3 => [x, ground(x, z) + dy, z];
    const table = (x: number, y: number, z: number, hx = 0.7, hz = 0.4) => {
        add([x - hx, y + 0.8, z - hz], [x + hx, y + 0.86, z + hz], MAT.wood, [0.55, 0.42, 0.32], { solid: false });
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) add([x + sx * (hx - 0.08) - 0.04, y, z + sz * (hz - 0.08) - 0.04], [x + sx * (hx - 0.08) + 0.04, y + 0.8, z + sz * (hz - 0.08) + 0.04], MAT.metal, [0.35, 0.32, 0.3], { solid: false });
        boxes.push({ min: [x - hx, y, z - hz], max: [x + hx, y + 0.86, z + hz], mat: MAT.wood, tint: [1, 1, 1], draw: false, solid: true });
        return y + 0.86;
    };
    const wall = (x0: number, z0: number, x1: number, z1: number, y0: number, h: number, mat: number = MAT.brick, tint: V3 = [0.62, 0.52, 0.48], t = 0.3) =>
        add([Math.min(x0, x1) - t, y0, Math.min(z0, z1) - t], [Math.max(x0, x1) + t, y0 + h, Math.max(z0, z1) + t], mat, tint);
    const rust: V3 = [0.5, 0.36, 0.28], stone: V3 = [0.7, 0.66, 0.6], conc: V3 = [0.62, 0.6, 0.58];

    // --- The camp, at the foot of the spire's freight lift.
    {
        // The freight lift's tower up the north wall: iron legs, a cage at the bottom, cables.
        const fx = 0, fz = 171;
        for (const [sx, sz] of [[-4, -3], [4, -3], [-4, 3], [4, 3]]) add([fx + sx - 0.5, -1, fz + sz - 0.5], [fx + sx + 0.5, 70, fz + sz + 0.5], MAT.metal, rust);
        for (let y = 6; y < 70; y += 5) {
            add([fx - 4.5, y, fz - 3.4], [fx + 4.5, y + 0.6, fz - 2.6], MAT.metal, rust, { solid: false });
            add([fx - 4.5, y, fz + 2.6], [fx + 4.5, y + 0.6, fz + 3.4], MAT.metal, rust, { solid: false });
            add([fx - 4.4, y, fz - 3], [fx - 3.6, y + 0.6, fz + 3], MAT.metal, rust, { solid: false });
            add([fx + 3.6, y, fz - 3], [fx + 4.4, y + 0.6, fz + 3], MAT.metal, rust, { solid: false });
        }
        add([fx - 4, 4, fz + 3.2], [fx + 4, 70, fz + 3.5], MAT.metal, [0.36, 0.3, 0.26], { solid: false });
        for (const x of [-1.2, 1.2]) add([fx + x - 0.06, 3.6, fz - 0.06], [fx + x + 0.06, 70, fz + 0.06], MAT.metal, [0.3, 0.28, 0.26], { solid: false });
        add([fx - 3.4, 0, fz - 2.4], [fx + 3.4, 0.3, fz + 2.4], MAT.metal, [0.5, 0.45, 0.38]);
        add([fx - 3.4, 3.4, fz - 2.4], [fx + 3.4, 3.6, fz + 2.4], MAT.metal, [0.45, 0.4, 0.35], { solid: false });
        prop({ model: "doctor_buggy", pos: CAMP.rover, yaw: 0.5, size: 5.2, collide: [2.4, 1.1, 1.4] });
        prop({ model: "radio_set", pos: CAMP.radio, yaw: 0.2, size: 2.2, collide: [1, 0.5, 0.75] });
        prop({ model: "crates", pos: [-8, 0, 147], yaw: 0.3, size: 2, collide: [0.8, 0.95, 0.8] });
        prop({ model: "crates", pos: [12, 0, 152], yaw: 1.2, size: 2.2, collide: [0.9, 1.05, 0.9] });
        prop({ model: "junk", pos: [-12, 0, 156], yaw: 2.1, size: 2.6, collide: [1.1, 0.4, 1.1] });
        uses.push({ id: "doctor", kind: "talk", pos: [CAMP.doctor[0], 0, CAMP.doctor[2] + 0.9], yaw: 0, label: "TALK TO THE DOCTOR" });
        uses.push({ id: "radio", kind: "radio", pos: [CAMP.radio[0] + 0.3, 0, CAMP.radio[2] + 1.1], yaw: Math.PI, label: "LISTEN ON THE DOCTOR'S RADIO" });
        items.push({ id: "field-map", pos: [9, table(9, 0, 139), 139], yaw: 0.4 });
        items.push({ id: "doctor-monocle", pos: [16, 0.02, 134], yaw: 1.1, after: "camp" });
        light([CAMP.rover[0], 2.6, CAMP.rover[2]], [1, 0.7, 0.4], 2.6, 10);
        light([CAMP.radio[0], 1.6, CAMP.radio[2]], [1, 0.55, 0.25], 1.4, 5, 0.3);
        checkpoints.push({ id: "camp", pos: CAMP.start.pos, yaw: CAMP.start.yaw, radius: 4, free: true });
    }

    // --- The Avatar Foundry.
    {
        const F = FOUNDRY, Y = 0;
        const brick: V3 = [0.42, 0.32, 0.28];
        // Walls with their openings: the loading bay (west), the broken stretch (north), the culvert (south).
        wall(F.x0, F.z0, F.x0, 36, Y, F.h, MAT.brick, brick);
        wall(F.x0, 48, F.x0, F.z1, Y, F.h, MAT.brick, brick);
        add([F.x0 - 0.3, 7.5, 36], [F.x0 + 0.3, F.h, 48], MAT.brick, brick);
        wall(F.x1, F.z0, F.x1, F.z1, Y, F.h, MAT.brick, brick);
        wall(F.x0, F.z1, 116, F.z1, Y, F.h, MAT.brick, brick);
        wall(128, F.z1, F.x1, F.z1, Y, F.h, MAT.brick, brick);
        wall(116, F.z1, 128, F.z1, Y, 2.6, MAT.brick, brick);
        add([116, 9.5, F.z1 - 0.3], [121, F.h, F.z1 + 0.3], MAT.brick, brick);
        add([124.5, 10.4, F.z1 - 0.3], [128, F.h, F.z1 + 0.3], MAT.brick, brick);
        wall(F.x0, F.z0, 130, F.z0, Y, F.h, MAT.brick, brick);
        wall(133.2, F.z0, F.x1, F.z0, Y, F.h, MAT.brick, brick);
        add([129.7, 1.35, F.z0 - 0.3], [133.5, F.h, F.z0 + 0.3], MAT.brick, brick);
        // Floor slab and roof (holes for skylights).
        add([F.x0, -0.6, F.z0], [F.x1, 0, F.z1], MAT.concrete, [0.55, 0.53, 0.5]);
        for (let x = F.x0; x < F.x1; x += 4) for (let z = F.z0; z < F.z1; z += 4) {
            const sky = (Math.floor((x - F.x0) / 4) % 3 === 1 && Math.floor((z - F.z0) / 4) % 3 === 1) || (x >= 116 && x < 128 && z >= 50);
            if (!sky) add([x, F.h, z], [x + 4, F.h + 0.5, z + 4], MAT.metal, [0.42, 0.38, 0.34], { solid: false });
        }
        for (let x = F.x0 + 6; x < F.x1; x += 8) add([x - 0.25, F.h - 1.1, F.z0], [x + 0.25, F.h - 0.1, F.z1], MAT.metal, rust, { solid: false });
        // Outside the north wall: the rubble heap up to the gap, onto the catwalk.
        ramps.push({ x0: 118, x1: 126, z0: F.z1 + 0.3, z1: F.z1 + 15, y0: F.catwalk, y1: 0, thick: 1.2, mat: MAT.concrete });
        prop({ model: "rubble", pos: [116, 0, 66], yaw: 0.8, size: 5, collide: [2, 0.6, 2], sink: 0.3 });
        prop({ model: "girders", pos: [130, 0, 68], yaw: 2.2, size: 6, collide: [2.4, 0.55, 1.4] });
        // The catwalk along the north wall inside, the foreman's office on it (west end), stairs down at the east.
        const cw = F.catwalk;
        add([F.x0, cw - 0.3, 52], [136, cw, F.z1], MAT.metal, [0.46, 0.42, 0.36]);
        add([F.x0, cw, 51.8], [116, cw + 1.05, 52.1], MAT.metal, [0.42, 0.38, 0.33]);
        add([128, cw, 51.8], [136, cw + 1.05, 52.1], MAT.metal, [0.42, 0.38, 0.33]);
        for (let x = F.x0 + 4; x < 136; x += 8) add([x - 0.15, 0, 51.9], [x + 0.15, cw - 0.3, 52.2], MAT.metal, rust);
        wall(F.x0, 52, 111, 52, cw, 3, MAT.wood, [0.5, 0.4, 0.3], 0.1);
        add([110.9, cw, 52], [111.2, cw + 3, 54], MAT.wood, [0.5, 0.4, 0.3]);
        add([110.9, cw + 2.2, 54], [111.2, cw + 3, 56], MAT.wood, [0.5, 0.4, 0.3]);
        add([110.9, cw, 56], [111.2, cw + 3, F.z1], MAT.wood, [0.5, 0.4, 0.3]);
        add([F.x0, cw + 3, 52], [111.2, cw + 3.2, F.z1], MAT.wood, [0.5, 0.4, 0.3], { solid: false });
        for (let s = 0; s < 14; s++) add([136 + s * 0.8, 0, 52], [136 + (s + 1) * 0.8, cw * (1 - s / 14), F.z1], MAT.metal, [0.46, 0.42, 0.36]);
        uses.push({ id: "locker", kind: "weapon", pos: [LOCKER[0] + 1, cw, LOCKER[2]], yaw: -Math.PI / 2, label: "TAKE THE GRAVITY LAUNCHER" });
        items.push({ id: "work-order", pos: [108.5, table(108.5, cw, 53.2), 53.2], yaw: 0.5 });
        // The line: conveyors west to east, arms either side, the printer at the end, vats on the south wall.
        for (const x of [113, 120.5, 128]) prop({ model: "conveyor", pos: [x, Y, 42], yaw: 0, size: 7, collide: [3.5, 0.55, 0.7] });
        for (const [x, z, yaw] of [[116, 46.5, Math.PI], [124, 37.5, 0], [131, 46.5, Math.PI], [109.5, 37.5, 0.3]] as number[][]) prop({ model: "assembly_arm", pos: [x, Y, z], yaw, size: 4.4, collide: [0.8, 1.6, 0.8] });
        prop({ model: "body_printer", pos: [141, Y, 41.5], yaw: Math.PI / 2, size: 7, collide: [3.4, 2, 2] });
        for (const x of [112, 121, 138]) prop({ model: "vat", pos: [x, Y, 29.4], yaw: hash(x) * 6, size: 3.2, collide: [1.5, 1.4, 1.5] });
        // The pulpit over the line's end: a platform with steps, its terminal.
        add([138, 0, 49], [145, 1.2, 53], MAT.metal, [0.46, 0.42, 0.36]);
        add([136.2, 0, 49], [137.1, 0.4, 51], MAT.metal, [0.46, 0.42, 0.36]);
        add([137.1, 0, 49], [138, 0.8, 51], MAT.metal, [0.46, 0.42, 0.36]);
        prop({ model: "holo_terminal", pos: [PULPIT[0], 1.2, 52.2], yaw: Math.PI, size: 1.5, collide: [0.4, 0.75, 0.4] });
        uses.push({ id: "printer", kind: "printer", pos: [PULPIT[0], 1.2, PULPIT[2]], yaw: 0, label: "SHUT DOWN THE PRINTING LINE" });
        // Hanging racks along the south: shells on hooks, and some of them are awake.
        add([110, 4.2, 32.6], [142, 4.5, 33], MAT.metal, rust, { solid: false });
        for (let x = 111; x <= 141; x += 6) add([x - 0.12, 0, 32.6], [x + 0.12, 4.2, 33], MAT.metal, rust);
        ["rack-1", "rack-2", "rack-3", "rack-4", "rack-5", "rack-6"].forEach((id, i) => enemy(id, "hollow", [113 + i * 5, Y, 33.6], "foundry", [[113 + i * 5, Y, 33.6]], 0));
        prop({ model: "crates", pos: [108, Y, 30], yaw: 0.4, size: 2.2, collide: [0.9, 1.05, 0.9] });
        prop({ model: "crates", pos: [133, Y, 47.5], yaw: 1.4, size: 2, collide: [0.8, 0.95, 0.8] });
        prop({ model: "junk", pos: [96, 0, 33], yaw: 0.3, size: 2.6, collide: [1.1, 0.4, 1.1] });
        prop({ model: "crates", pos: [97, 0, 47], yaw: 0.1, size: 2.4, collide: [1, 1.1, 1] });
        prop({ model: "carcass", pos: [99, 0, 40], yaw: -1.4, size: 1.9, collide: [0.6, 0.6, 0.6] });
        items.push({ id: "avatar-mask", pos: [134.5, 0, 30.5], yaw: 2.2 });
        enemy("f-hollow-1", "hollow", [98, 0, 44], "foundry", [[98, 0, 44], [98, 0, 30], [92, 0, 52]], -Math.PI / 2);
        enemy("f-hollow-2", "hollow", [118, 0, 70], "foundry", [[118, 0, 70], [140, 0, 66], [110, 0, 64]]);
        enemy("f-bot-1", "hacked_bot", [101, 0, 40], "foundry", [[101, 0, 40], [101, 0, 49], [94, 0, 42]], -Math.PI / 2);
        enemy("f-hollow-3", "hollow", [125, 0, 45], "foundry", [[125, 0, 45], [138, 0, 38], [112, 0, 38]]);
        enemy("f-hollow-4", "hollow", [133, 0, 54], "foundry", [[133, 0, 54], [110, 0, 48]]);
        enemy("f-roller-1", "roller", [128, 0, 30], "foundry", [[128, 0, 30], [140, 0, 36], [116, 0, 36]]);
        pickups.push({ id: "cell-foundry", pos: [146, 0, 28] }, { id: "grav-foundry", pos: [105, 5.2, 57] });
        light([125, 9, 42], [1, 0.62, 0.3], 3.5, 18);
        light([141, 3, 41.5], [1, 0.75, 0.4], 2.8, 9, 0.2);
        light([PULPIT[0], 2.8, PULPIT[2]], [0.3, 0.85, 1], 1.6, 5);
        light([107.5, 7.4, 55], [1, 0.7, 0.45], 1.6, 6);
        light([126, 3, 31], [1, 0.25, 0.15], 1.8, 10, 0.6);
        checkpoints.push({ id: "foundry", pos: [94, 0, 41], yaw: Math.PI / 2, radius: 4, free: true });
    }

    // --- Gate Four: a stone plaza around the upload gate, a gallery on its north side.
    {
        const G = GATE, T = G.top;
        add([G.x0, -0.6, G.z0], [G.x1, T, G.z1], MAT.sandstone, stone);
        // Steps: south (the queue's way in) and east.
        for (let s = 0; s < 3; s++) {
            add([-132, 0, G.z0 - 1.5 * (3 - s)], [-108, (T * (s + 1)) / 3.4, G.z0 - 1.5 * (2 - s)], MAT.sandstone, stone);
            add([G.x1 + 1.2 * (2 - s), 0, 34], [G.x1 + 1.2 * (3 - s), (T * (s + 1)) / 3.4, 46], MAT.sandstone, stone);
        }
        // The colonnade, broken in places, and its architrave where it still stands.
        for (let t = 0; t <= 60; t += 6) for (const [x, z] of [[G.x0 + t, G.z0 + 0.8], [G.x0 + t, G.z1 - 0.8], [G.x0 + 0.8, G.z0 + t], [G.x1 - 0.8, G.z0 + t]] as [number, number][]) {
            if (Math.abs(x + 120) < 13 && z < G.z0 + 2) continue;
            if (x > G.x1 - 2 && z > 33 && z < 47) continue;
            const top = hash(x, z, 5) > 0.72 ? 2 + hash(x, z) * 4 : 10;
            add([x - 0.6, T, z - 0.6], [x + 0.6, T + top, z + 0.6], MAT.granite, [0.66, 0.62, 0.56]);
        }
        for (const [x0, x1, z] of [[G.x0, -126, G.z0 + 0.8], [-96, G.x1, G.z0 + 0.8], [G.x0, G.x1, G.z1 - 0.8]] as number[][]) add([x0, T + 10, z - 0.9], [x1, T + 11.2, z + 0.9], MAT.granite, [0.62, 0.58, 0.52], { solid: false });
        // The gallery: a walkway along the north side at 7 m, stairs up at its east end.
        const gy = G.gallery;
        add([G.x0, gy - 0.4, 72], [G.x1, gy, G.z1 - 1.5], MAT.sandstone, stone);
        add([G.x0, gy, 71.8], [-110.5, gy + 1.05, 72.2], MAT.metal, [0.42, 0.38, 0.33]);
        add([-105.5, gy, 71.8], [G.x1, gy + 1.05, 72.2], MAT.metal, [0.42, 0.38, 0.33]);
        for (let x = G.x0 + 4; x < G.x1; x += 8) add([x - 0.3, T, 71.8], [x + 0.3, gy - 0.4, 72.4], MAT.granite, [0.6, 0.56, 0.5]);
        for (let s = 0; s < 12; s++) add([-110, T, 59.8 + s], [-106, T + ((gy - T) * (s + 1)) / 12, 71.8], MAT.sandstone, stone);
        // The broken highway from the east: a ramp up from the flats, a deck west, and a gap that
        // only the old world's span (the simulation lens) crosses to the gallery.
        ramps.push({ x0: -66, x1: -60, z0: 38, z1: 74, y0: 0, y1: gy, thick: 0.8, mat: MAT.asphalt });
        add([-80, gy - 0.8, 74], [-60, gy, 80], MAT.asphalt, [0.6, 0.58, 0.56]);
        add([-80, gy, 79.7], [-60, gy + 1, 80], MAT.metal, [0.42, 0.38, 0.33]);
        for (const x of [-77, -68]) add([x - 0.8, -1, 76], [x + 0.8, gy - 0.8, 78], MAT.concrete, conc);
        boxes.push({ min: [-90.2, gy - 0.25, 75.6], max: [-79.8, gy, 77.8], mat: MAT.marble, tint: [1, 1, 1], draw: false, solid: true, sim: true });
        // The gate, its plinth, the three terminals in the dark at its heart.
        prop({ model: "upload_gate", pos: G.center, yaw: Math.PI / 2, size: 15, collide: [7.2, 1, 3.8] });
        for (const t of TERMINALS) {
            prop({ model: "holo_terminal", pos: t.pos, yaw: t.yaw, size: 1.5, collide: [0.4, 0.75, 0.4] });
            uses.push({ id: t.id, kind: "terminal", pos: [t.pos[0] + Math.sin(t.yaw) * 0.9, t.pos[1], t.pos[2] + Math.cos(t.yaw) * 0.9], yaw: t.yaw, label: "READ THE GATE'S LAST SESSION" });
            light([t.pos[0], T + 1.6, t.pos[2]], [0.3, 0.85, 1], 1.2, 4, 0.4);
        }
        for (const [x, z, yaw] of [[-134, 30, 0.4], [-106, 30, -0.4], [-142, 60, 1.6], [-98, 60, -1.6]] as number[][]) prop({ model: "kiosk", pos: [x, T, z], yaw, size: 3.2, collide: [0.9, 1.5, 0.9] });
        prop({ model: "statue", pos: [-120, T, 27], yaw: 0, size: 6, collide: [1.4, 3, 1.4] });
        prop({ model: "rubble", pos: [-146, T, 36], yaw: 0.6, size: 4.5, collide: [1.8, 0.6, 1.8], sink: 0.2 });
        prop({ model: "rubble", pos: [-97, T, 74], yaw: 2.6, size: 3.6, collide: [1.5, 0.5, 1.5], sink: 0.15 });
        prop({ model: "upload_pod", pos: [-140, T, 48], yaw: Math.PI / 2, size: 2.4, collide: [0.55, 1.2, 0.55] });
        prop({ model: "upload_pod", pos: [-140, T, 52], yaw: Math.PI / 2, size: 2.4, collide: [0.55, 1.2, 0.55] });
        prop({ model: "upload_pod", pos: [-100, T, 48], yaw: -Math.PI / 2, size: 2.4, collide: [0.55, 1.2, 0.55] });
        items.push({ id: "queue-token", pos: [-104.2, T, 31.6], yaw: 0.2 });
        items.push({ id: "hymn-cylinder", pos: [-145, gy, 76], yaw: 1.3 });
        items.push({ id: "visitor-ribbon", pos: [-124, T, 62], yaw: 2.5 });
        for (let i = 0; i < 5; i++) {
            const a = (i / 5) * Math.PI * 2;
            enemy(`cherub-${i + 1}`, "cherub", [-120 + Math.cos(a) * 12, 6, 50 + Math.sin(a) * 12], "gate", [[-120 + Math.cos(a) * 12, 6, 50 + Math.sin(a) * 12], [-120 + Math.cos(a + 1.2) * 14, 6, 50 + Math.sin(a + 1.2) * 14]]);
        }
        enemy("g-hollow-1", "hollow", [-132, T, 32], "gate", [[-132, T, 32]], 2.6);
        enemy("g-hollow-2", "hollow", [-100, T, 62], "gate", [[-100, T, 62], [-98, T, 54]], -2);
        enemy("g-bot-1", "hacked_bot", [-130, gy, 76], "gate", [[-130, gy, 76], [-110, gy, 76]], Math.PI);
        pickups.push({ id: "cell-gate", pos: [-147, T, 24] }, { id: "grav-gate", pos: [-92.5, T, 77] });
        light([-120, 8, 50], [0.55, 0.15, 1], 3, 14);
        light([-120, T + 3, 27], [1, 0.7, 0.45], 1.6, 8);
        checkpoints.push({ id: "gate", pos: [-120, 0, 12], yaw: 0, radius: 4, free: true });
        checkpoints.push({ id: "highway", pos: [-63, 0, 34], yaw: 0, radius: 3, free: true });
    }

    // --- The barge across the canal, the mast's quay on the north bank.
    {
        prop({ model: "barge_hull", pos: at(BARGE[0], BARGE[2], -0.5), yaw: 0.06, size: 62, collide: [28, 5, 7] });
        prop({ model: "signal_mast", pos: MAST, yaw: 0, size: 20 });
        add([MAST[0] - 1.6, 0, MAST[2] - 1.6], [MAST[0] + 1.6, 1.4, MAST[2] + 1.6], MAT.metal, rust);
        uses.push({ id: "winch", kind: "winch", pos: WINCH, yaw: Math.PI / 2, label: "HOLD TO CRANK THE MAST UP" });
        add([WINCH[0] - 0.5, 0, WINCH[2] - 0.7], [WINCH[0] + 0.5, 1, WINCH[2] + 0.7], MAT.metal, [0.62, 0.5, 0.32]);
        // The quay: a stone lip over the canal, bollards, crates to hide behind.
        add([54, -6.5, -50.6], [82, 0, -49.8], MAT.sandstone, stone);
        for (const x of [57, 63, 69, 75, 80]) add([x - 0.3, 0, -50.2], [x + 0.3, 0.7, -49.6], MAT.metal, [0.3, 0.28, 0.26]);
        prop({ model: "crates", pos: [58, 0, -41.5], yaw: 0.2, size: 2.2, collide: [0.9, 1.05, 0.9] });
        prop({ model: "crates", pos: [76, 0, -42], yaw: 1.1, size: 2, collide: [0.8, 0.95, 0.8] });
        prop({ model: "water_tank", pos: [84, 0, -34], yaw: 0.4, size: 11, collide: [2, 5.5, 2] });
        prop({ model: "lock_gate", pos: at(-36, canalZ(-36) + 0.5), yaw: Math.PI / 2, size: 15 });
        prop({ model: "lock_gate", pos: at(118, canalZ(118)), yaw: Math.PI / 2 + 0.1, size: 15 });
        prop({ model: "girders", pos: at(-20, canalZ(-20)), yaw: 0.4, size: 6, collide: [2.4, 0.55, 1.4] });
        prop({ model: "junk", pos: at(40, canalZ(40) + 6), yaw: 1.7, size: 2.8, collide: [1.2, 0.4, 1.2] });
        items.push({ id: "captains-log", pos: at(-10, canalZ(-10) - 5), yaw: 0.9 });
        items.push({ id: "meltwater-flask", pos: [80.5, table(80.5, 0, -45.5), -45.5], yaw: 0.3 });
        enemy("c-crawler-1", "crawler", at(0, canalZ(0) + 5), "barge", [at(0, canalZ(0) + 5), at(-14, canalZ(-14) + 5)]);
        enemy("c-crawler-2", "crawler", at(40, canalZ(40) - 5), "barge", [at(40, canalZ(40) - 5), at(52, canalZ(52) - 4)]);
        enemy("c-crawler-3", "crawler", at(-70, canalZ(-70)), "canal", [at(-70, canalZ(-70)), at(-100, canalZ(-100))]);
        enemy("q-bot-1", "hacked_bot", [72, 0, -41], "barge", [[72, 0, -41], [60, 0, -40]], -Math.PI / 2);
        enemy("q-roller-1", "roller", [66, 0, -32], "barge", [[66, 0, -32], [80, 0, -28], [56, 0, -30]]);
        enemy("c-crawler-4", "crawler", at(100, canalZ(100)), "canal", [at(100, canalZ(100)), at(130, canalZ(130))]);
        pickups.push({ id: "cell-quay", pos: [55, 0, -39] }, { id: "grav-canal", pos: at(10, canalZ(10) + 7) });
        light([BARGE[0] - 20, 0, -60], [1, 0.45, 0.2], 2.8, 14, 0.7);
        light([MAST[0], 3, MAST[2]], [1, 0.7, 0.4], 2, 8);
        checkpoints.push({ id: "quay", pos: [70, 0, -36], yaw: Math.PI, radius: 4, free: true });
    }

    // --- The pumphouse: brick, barricaded; the Error's pods in its yard; the lure beacons around it.
    {
        const P = PUMPHOUSE, Y = 0, brick: V3 = [0.46, 0.33, 0.28];
        wall(P.x0, P.z0, P.x1, P.z0, Y, P.h, MAT.brick, brick);
        wall(P.x0, P.z0, P.x0, P.z1, Y, P.h, MAT.brick, brick);
        wall(P.x1, P.z0, P.x1, P.z1, Y, P.h, MAT.brick, brick);
        wall(P.x0, P.z1, -116.6, P.z1, Y, P.h, MAT.brick, brick);
        wall(-113.4, P.z1, P.x1, P.z1, Y, P.h, MAT.brick, brick);
        add([-116.6, 3.2, P.z1 - 0.3], [-113.4, P.h, P.z1 + 0.3], MAT.brick, brick);
        add([P.x0 - 0.5, P.h, P.z0 - 0.5], [P.x1 + 0.5, P.h + 0.4, P.z1 + 0.5], MAT.concrete, [0.5, 0.48, 0.46], { solid: false });
        add([P.x0, -0.6, P.z0], [P.x1, 0, P.z1], MAT.concrete, conc);
        doors.push({ id: "pump-door", min: [-116.5, Y, P.z1 - 0.12], max: [-113.5, Y + 3.2, P.z1 + 0.12], mat: MAT.wood, tint: [0.5, 0.38, 0.28] });
        prop({ model: "boiler", pos: [-110.5, Y, -110], yaw: 0, size: 3.2, collide: [0.9, 1.6, 0.9] });
        prop({ model: "crates", pos: [-120.2, Y, -110.2], yaw: 0.2, size: 1.8, collide: [0.7, 0.85, 0.7] });
        items.push({ id: "ration-tin", pos: [-119.8, table(-119.8, Y, -103), -103], yaw: 0.6 });
        uses.push({ id: "mara", kind: "talk", pos: [SURVIVORS.mara[0], 0, SURVIVORS.mara[2] + 1], yaw: 0, label: "TALK TO THE SURVIVORS" });
        // The yard: rows of harvest pods, people asleep in them.
        for (let i = 0; i < 8; i++) {
            const x = -137 + (i % 4) * 4.2, z = -96 + Math.floor(i / 4) * 4.5;
            prop({ model: "harvest_pod", pos: [x, 0, z], yaw: Math.PI + (hash(i, 7) - 0.5) * 0.4, size: 2.6, collide: [0.45, 1.3, 0.45] });
        }
        for (const b of BEACONS) enemy(b.id, "beacon", b.pos, "pumphouse", [b.pos]);
        const H: [string, V3, V3[]][] = [
            ["p-hollow-1", [-118, 0, -95], [[-118, 0, -95], [-108, 0, -96]]], ["p-hollow-2", [-104, 0, -104], [[-104, 0, -104], [-104, 0, -112]]],
            ["p-hollow-3", [-126, 0, -114], [[-126, 0, -114], [-112, 0, -116]]], ["p-hollow-4", [-128, 0, -104], [[-128, 0, -104]]],
            ["p-hollow-5", [-112, 0, -92], [[-112, 0, -92], [-124, 0, -90]]], ["p-hollow-6", [-100, 0, -110], [[-100, 0, -110]]],
        ];
        for (const [id, pos, patrol] of H) enemy(id, "hollow", pos, "pumphouse", patrol);
        enemy("p-crawler-1", "crawler", [-135, 0, -122], "pumphouse", [[-135, 0, -122], [-110, 0, -125]]);
        items.push({ id: "brass-crown", pos: [-140.5, 0, -100], yaw: 0.8 });
        pickups.push({ id: "cell-pump", pos: [-92, 0, -88] }, { id: "grav-pump", pos: [-143, 0, -84] });
        for (const b of BEACONS) light([b.pos[0], 3.4, b.pos[2]], [1, 0.12, 0.08], 2.4, 9, 0.5);
        light([-115, 4.6, -106], [1, 0.65, 0.35], 2, 9);
        checkpoints.push({ id: "pumphouse", pos: [-100, 0, -84], yaw: Math.PI * 0.8, radius: 4 });
    }

    // --- The quarry and the Tithe's camp around it; their lift.
    {
        const Q = QUARRY;
        for (const [x, z, yaw] of [[108, -88, 0.6], [156, -100, -0.5], [100, -146, 2.2], [158, -146, -2.4]] as number[][]) prop({ model: "shack", pos: at(x, z), yaw, size: 6, collide: [2.7, 2.2, 2.6] });
        prop({ model: "crates", pos: at(116, -92), yaw: 0.6, size: 2.2, collide: [0.9, 1.05, 0.9] });
        prop({ model: "junk", pos: at(150, -112), yaw: 1.3, size: 2.6, collide: [1.1, 0.4, 1.1] });
        prop({ model: "wind_turbine", pos: at(162, -122), yaw: 1.1, size: 22, collide: [1, 11, 1] });
        const L = QLIFT;
        for (const [x, z] of [[L.x0, L.z0], [L.x1, L.z0], [L.x0, L.z1], [L.x1, L.z1]] as [number, number][]) add([x - 0.25, L.bottom, z - 0.25], [x + 0.25, L.top + 9, z + 0.25], MAT.metal, rust);
        add([L.x0 - 0.3, L.top + 9, L.z0 - 0.3], [L.x1 + 0.3, L.top + 9.6, L.z1 + 0.3], MAT.metal, rust, { solid: false });
        // The shaft below the quarry floor: walls all round, open south at the bottom.
        add([L.x0 - 0.3, L.bottom, L.z1], [L.x1 + 0.3, L.top - 0.2, L.z1 + 0.3], MAT.concrete, conc);
        add([L.x0 - 0.3, L.bottom, L.z0 - 0.3], [L.x0, L.top - 0.2, L.z1], MAT.concrete, conc);
        add([L.x1, L.bottom, L.z0 - 0.3], [L.x1 + 0.3, L.top - 0.2, L.z1], MAT.concrete, conc);
        add([L.x0 - 0.3, L.bottom + 3.4, L.z0 - 0.3], [L.x1 + 0.3, L.top - 0.2, L.z0], MAT.concrete, conc);
        uses.push({ id: "quarry-lift", kind: "lift", pos: [(L.x0 + L.x1) / 2, L.top, (L.z0 + L.z1) / 2], yaw: 0, label: "RIDE THE LIFT DOWN" });
        items.push({ id: "tithe-ledger", pos: [112, table(112, ground(112, -90), -90), -90], yaw: 0.9 });
        light([Q.c[0] + 4, -10 + 4, Q.c[2] + 4], [1, 0.6, 0.3], 2.4, 12);
        checkpoints.push({ id: "quarry", pos: [114, -10, -110], yaw: -Math.PI * 0.75, radius: 4 });
    }

    // --- The Undercroft (y = -44): the lift's foot, the pit, the cable heart, the metro, the hoist.
    {
        const Y = UNDER_Y, dark: V3 = [0.42, 0.4, 0.38], iron: V3 = [0.34, 0.3, 0.28];
        const room = (x0: number, z0: number, x1: number, z1: number, h: number, openings: { side: "n" | "s" | "e" | "w"; a: number; b: number; h?: number }[] = [], hole?: { x0: number; x1: number; z0: number; z1: number }) => {
            add([x0, Y - 0.6, z0], [x1, Y, z1], MAT.concrete, dark);
            const lid = (a: V3, b: V3) => { if (b[0] - a[0] > 0.01 && b[2] - a[2] > 0.01) add(a, b, MAT.concrete, dark); };
            if (!hole) lid([x0, Y + h, z0], [x1, Y + h + 0.6, z1]);
            else {
                lid([x0, Y + h, z0], [hole.x0, Y + h + 0.6, z1]); lid([hole.x1, Y + h, z0], [x1, Y + h + 0.6, z1]);
                lid([hole.x0, Y + h, z0], [hole.x1, Y + h + 0.6, hole.z0]); lid([hole.x0, Y + h, hole.z1], [hole.x1, Y + h + 0.6, z1]);
            }
            const side = (s: "n" | "s" | "e" | "w") => {
                const ops = openings.filter(o => o.side === s).sort((p, q) => p.a - q.a);
                const horiz = s === "n" || s === "s";
                const lo = horiz ? x0 : z0, hi = horiz ? x1 : z1;
                let cur = lo;
                const piece = (a: number, b: number, y0: number, y1: number) => {
                    if (b - a < 0.01) return;
                    if (s === "n") add([a, Y + y0, z1 - 0.3], [b, Y + y1, z1 + 0.3], MAT.concrete, dark);
                    if (s === "s") add([a, Y + y0, z0 - 0.3], [b, Y + y1, z0 + 0.3], MAT.concrete, dark);
                    if (s === "e") add([x1 - 0.3, Y + y0, a], [x1 + 0.3, Y + y1, b], MAT.concrete, dark);
                    if (s === "w") add([x0 - 0.3, Y + y0, a], [x0 + 0.3, Y + y1, b], MAT.concrete, dark);
                };
                for (const o of ops) { piece(cur, o.a, 0, h); piece(o.a, o.b, o.h ?? 3.4, h); cur = o.b; }
                piece(cur, hi, 0, h);
            };
            for (const s of ["n", "s", "e", "w"] as const) side(s);
        };
        // The lift's foot, the corridor south, the pit hall.
        room(122, -134, 138, -118, 6, [{ side: "s", a: 128, b: 132 }], { x0: QLIFT.x0 - 0.3, x1: QLIFT.x1 + 0.3, z0: QLIFT.z0 - 0.3, z1: QLIFT.z1 + 0.3 });
        room(127, -142, 133, -134, 4, [{ side: "n", a: 128, b: 132 }, { side: "s", a: 128, b: 132 }]);
        room(100, -164, 154, -142, 12, [{ side: "n", a: 128, b: 132 }, { side: "w", a: -160, b: -148, h: 5 }]);
        // The nest's chamber, west of the pit, the tunnel door in its south wall.
        room(76, -164, 100, -142, 8, [{ side: "e", a: -160, b: -148, h: 5 }, { side: "s", a: 82, b: 90, h: 4.4 }]);
        doors.push({ id: "tunnel-door", min: [82, Y, -164.2], max: [90, Y + 4.4, -163.8], mat: MAT.metal, tint: [0.45, 0.36, 0.28] });
        // The metro: a platform and the tunnel running east to the hoist.
        room(40, -188, 178, -164, 7, [{ side: "n", a: 82, b: 90, h: 4.4 }], { x0: HOIST.x0 - 0.3, x1: HOIST.x1 + 0.3, z0: HOIST.z0 - 0.3, z1: HOIST.z1 + 0.3 });
        for (let x = 44; x < 176; x += 8) add([x - 0.4, Y, -176.4], [x + 0.4, Y + 7, -175.6], MAT.concrete, [0.36, 0.34, 0.32]);
        add([40, Y, -184.2], [178, Y + 0.12, -183.8], MAT.metal, iron, { solid: false });
        add([40, Y, -179.2], [178, Y + 0.12, -178.8], MAT.metal, iron, { solid: false });
        prop({ model: "metro_car", pos: [66, Y, -181.5], yaw: Math.PI / 2, size: 17, collide: [8.3, 2.2, 1.9] });
        prop({ model: "metro_car", pos: [124, Y, -181.5], yaw: Math.PI / 2 + 0.03, size: 17, collide: [8.3, 2.2, 1.9] });
        // The pit: pods in rows, black cable bundles along the floor, a few still lit.
        for (let r = 0; r < 3; r++) for (let i = 0; i < 6; i++) {
            const x = 106 + i * 7.5, z = -147 - r * 7;
            prop({ model: "harvest_pod", pos: [x, Y, z], yaw: Math.PI + (hash(i, r) - 0.5) * 0.3, size: 2.6, collide: [0.45, 1.3, 0.45] });
        }
        for (const z of [-150.5, -157.5]) add([102, Y, z - 0.4], [152, Y + 0.35, z + 0.4], MAT.asphalt, [0.12, 0.1, 0.1]);
        // The heart's husk stays solid after it dies (te_game.ts draws it from its machine record).
        boxes.push({ min: [NEST[0] - 2, Y, NEST[2] - 2], max: [NEST[0] + 2, Y + 5, NEST[2] + 1.6], mat: MAT.asphalt, tint: [1, 1, 1], draw: false, solid: true });
        enemy("nest", "nest", NEST, "nest", [NEST]);
        ["u-hollow-1", "u-hollow-2", "u-hollow-3", "u-hollow-4"].forEach((id, i) => enemy(id, "hollow", [109 + i * 11, Y, -154], "pit", [[109 + i * 11, Y, -154], [109 + i * 11, Y, -161]]));
        enemy("u-crawler-1", "crawler", [140, Y, -157.5], "pit", [[140, Y, -157.5], [112, Y, -157.5]]);
        enemy("t-crawler-1", "crawler", [96, Y, -172], "tunnel", [[96, Y, -172], [80, Y, -170]]);
        enemy("t-crawler-2", "crawler", [140, Y, -170], "tunnel", [[140, Y, -170], [152, Y, -168]]);
        enemy("t-bot-1", "hacked_bot", [160, Y, -170], "tunnel", [[160, Y, -170], [150, Y, -169]], -Math.PI / 2);
        enemy("t-hollow-1", "hollow", [110, Y, -169], "tunnel", [[110, Y, -169], [100, Y, -186]]);
        items.push({ id: "metro-token", pos: [72, Y, -167], yaw: 0.4 });
        pickups.push({ id: "cell-pit", pos: [151, Y, -144] }, { id: "grav-pit", pos: [102, Y, -144] }, { id: "grav-tunnel", pos: [120, Y, -166.5] }, { id: "cell-tunnel", pos: [166, Y, -166] });
        light([130, Y + 4.5, -126], [1, 0.55, 0.3], 1.8, 9, 0.4);
        light([115, Y + 6, -152], [1, 0.12, 0.1], 2.4, 16, 0.3);
        light([140, Y + 6, -158], [1, 0.12, 0.1], 2.4, 16, 0.5);
        light([NEST[0], Y + 3.5, NEST[2] + 1.5], [1, 0.1, 0.08], 3.2, 12);
        light([86, Y + 5, -170], [0.9, 0.7, 0.4], 1.4, 10, 0.6);
        light([150, Y + 5, -170], [0.9, 0.7, 0.4], 1.2, 10, 0.8);
        light([HOIST.x0 + 2.8, Y + 3.2, HOIST.z1 + 1], [1, 0.6, 0.3], 1.8, 7);
        checkpoints.push({ id: "undercroft", pos: [130, Y, -137], yaw: Math.PI, radius: 3 });
        checkpoints.push({ id: "platform", pos: [86, Y, -168], yaw: Math.PI / 2, radius: 3 });
        // The hoist: a cage in a brick shaft from the tunnel's east end up through the rock to the ledge.
        const H = HOIST;
        add([H.x0 - 0.3, Y, H.z0 - 0.3], [H.x1 + 0.3, H.top - 0.2, H.z0], MAT.brick, [0.5, 0.4, 0.36]);
        add([H.x1, Y, H.z0 - 0.3], [H.x1 + 0.3, H.top - 0.2, H.z1 + 0.3], MAT.brick, [0.5, 0.4, 0.36]);
        add([H.x0 - 0.3, Y, H.z0], [H.x0, H.top - 0.2, H.z1], MAT.brick, [0.5, 0.4, 0.36]);
        add([H.x0, Y + 3.4, H.z1], [H.x1, H.top - 0.2, H.z1 + 0.3], MAT.brick, [0.5, 0.4, 0.36]);
        uses.push({ id: "hoist", kind: "lift", pos: [(H.x0 + H.x1) / 2, H.bottom, (H.z0 + H.z1) / 2], yaw: 0, label: "RIDE THE HOIST UP" });
    }

    // --- The ledge (y = 30): the Tithe's lookout, the hoist's head, the overlook.
    {
        const L = LEDGE, Y = L.y, H = HOIST;
        add([L.x0, Y, L.z1 - 0.3], [L.x1, Y + 1.1, L.z1 + 0.3], MAT.metal, [0.42, 0.38, 0.33]);
        add([L.x0 - 0.3, Y, L.z0], [L.x0 + 0.3, Y + 1.1, L.z1], MAT.metal, [0.42, 0.38, 0.33]);
        // The hoist's head frame.
        for (const [x, z] of [[H.x0, H.z0], [H.x1, H.z0], [H.x0, H.z1], [H.x1, H.z1]] as [number, number][]) add([x - 0.2, Y, z - 0.2], [x + 0.2, Y + 7, z + 0.2], MAT.metal, rust);
        add([H.x0 - 0.3, Y + 7, H.z0 - 0.3], [H.x1 + 0.3, Y + 7.5, H.z1 + 0.3], MAT.metal, rust, { solid: false });
        add([H.x0 - 0.3, Y - 3, H.z0 - 0.3], [H.x1 + 0.3, Y, H.z0], MAT.brick, [0.5, 0.4, 0.36]);
        add([H.x1, Y - 3, H.z0], [H.x1 + 0.3, Y, H.z1 + 0.3], MAT.brick, [0.5, 0.4, 0.36]);
        add([H.x0 - 0.3, Y - 3, H.z0], [H.x0, Y, H.z1], MAT.brick, [0.5, 0.4, 0.36]);
        add([H.x0, Y - 3, H.z1], [H.x1, Y, H.z1 + 0.3], MAT.brick, [0.5, 0.4, 0.36]);
        prop({ model: "shack", pos: [163, Y, -196], yaw: 0.2, size: 6, collide: [2.7, 2.2, 2.6] });
        prop({ model: "shack", pos: [186, Y, -192], yaw: -1.4, size: 6, collide: [2.7, 2.2, 2.6] });
        for (const [x, z, yaw] of [[172, -192, 0.3], [160, -186, 1.2], [180, -184, 0.7], [167, -198, 0.1]] as number[][]) prop({ model: "crates", pos: [x, Y, z], yaw, size: 2, collide: [0.8, 0.95, 0.8] });
        prop({ model: "radio_set", pos: [184, Y, -199], yaw: Math.PI, size: 1.6, collide: [0.7, 0.45, 0.45] });
        light([170, Y + 3, -192], [1, 0.6, 0.3], 2.4, 12, 0.4);
        light([OVERLOOK[0], Y + 2, OVERLOOK[2] - 1], [1, 0.7, 0.4], 1.2, 6);
        checkpoints.push({ id: "ledge", pos: [168, Y, -183], yaw: Math.PI / 2, radius: 3 });
    }

    // --- The flats between: rock spires, dead turbines, the odd wreck; cover for every route.
    const rocks: [number, number, number][] = [[-40, 100, 12], [36, 104, 15], [-90, 10, 10], [10, -20, 13], [90, 10, 11], [-60, -30, 14], [-100, -150, 16], [40, -110, 12], [165, 40, 18], [-170, 100, 17], [-30, -120, 11], [100, -60, 9], [-150, 150, 15], [60, 150, 13]];
    rocks.forEach(([x, z, s], i) => prop({ model: "rock_spire", pos: at(x, z, -0.3), yaw: hash(i, 2) * 6, size: s, collide: [s * 0.17, s * 0.5, s * 0.16] }));
    for (const [x, z] of [[-70, 150], [70, 160], [-110, 110], [120, 150], [0, -140], [-170, -140]] as number[][]) prop({ model: "wind_turbine", pos: at(x, z), yaw: hash(x, z) * 6, size: 24, collide: [1, 12, 1] });
    for (const [x, z, yaw] of [[-30, 90, 1.2], [44, 60, -0.4], [-80, -20, 2.4], [20, 20, 0.9], [-130, 120, 0.2]] as number[][]) prop({ model: "hovercar", pos: at(x, z, 0.2), yaw, size: 6.5, collide: [2.8, 1.0, 1.6] });
    for (const [x, z] of [[-48, 76], [28, 74], [-70, -6], [110, -20], [-20, -100], [-160, 60]] as number[][]) prop({ model: "crates", pos: at(x, z), yaw: hash(z, x) * 3, size: 2.2, collide: [0.9, 1.05, 0.9] });
    prop({ model: "carcass", pos: at(-34, 118), yaw: 0.8, size: 1.9, collide: [0.6, 0.6, 0.6] });
    prop({ model: "carcass", pos: at(70, 20), yaw: 2.4, size: 1.9, collide: [0.6, 0.6, 0.6] });
    enemy("n-roller-1", "roller", at(-20, 90), "flats", [at(-20, 90), at(-50, 80), at(-30, 108)]);
    enemy("n-bot-1", "hacked_bot", at(30, 10), "flats", [at(30, 10), at(40, -18), at(16, 20)], 0);
    enemy("n-crawler-1", "crawler", at(-90, -40), "flats", [at(-90, -40), at(-70, -30)]);
    enemy("n-crawler-2", "crawler", at(110, -80), "flats", [at(110, -80), at(90, -70)]);
    enemy("n-roller-2", "roller", at(-85, 100), "flats", [at(-85, 100), at(-100, 80)]);
    enemy("n-hollow-1", "hollow", at(64, 76), "flats", [at(64, 76), at(80, 70)]);
    pickups.push({ id: "cell-flats-n", pos: at(-44, 110) }, { id: "cell-flats-c", pos: at(12, -24) }, { id: "cell-flats-w", pos: at(-88, 14) }, { id: "grav-flats", pos: at(88, 6) });
    items.push({ id: "dust-goggles", pos: at(-48.5, 77.5), yaw: 2.2 });
    items.push({ id: "turbine-plate", pos: at(-67, 147), yaw: 0.6 });

    // The order checkpoints are reached in, past the open stretch (te_game.ts moves only forward,
    // except through the free ones).
    const order = ["camp", "foundry", "gate", "highway", "quay", "pumphouse", "quarry", "undercroft", "platform", "ledge"];
    checkpoints.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    return level;
}

/** The capital on the plateau to the north, the spire among it; a few towers out east and west. */
function buildPlateau(): Prop[] {
    const out: Prop[] = [];
    const rim = 54;
    out.push({ model: "tower_b", pos: [0, rim, 330], yaw: 0.6, size: 470 });
    let k = 0;
    for (const [r0, n] of [[380, 7], [620, 9], [1000, 10]] as [number, number][]) {
        for (let i = 0; i < n; i++, k++) {
            const a = Math.PI * 0.18 + (i / (n - 1)) * Math.PI * 0.64 + (hash(k, 7) - 0.5) * 0.12;
            const r = r0 + hash(k, 1) * r0 * 0.3;
            out.push({ model: hash(k, 3) > 0.5 ? "tower_a" : "tower_b", pos: [Math.cos(a) * r, rim, Math.sin(a) * r], yaw: hash(k, 4) * 6, size: 160 + hash(k, 2) * 240 });
        }
    }
    for (const [x, z] of [[-700, -200], [760, -320], [-900, 300]] as [number, number][]) out.push({ model: "tower_a", pos: [x, rim, z], yaw: hash(x) * 6, size: 200 });
    return out;
}

/** The far plateau beyond the terrain mesh: a square frame of ground at the rim's height. */
export const PLATEAU_Y = 55;
