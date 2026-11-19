// The mission past the hypercube, added to level 1 (te_level.ts buildLevel):
//
//   Act 2  THE SKY BRIDGE   from the atrium's torn east edge (y = 14) to the Relay Tower, snapped
//                           twice (running jumps) and blocked by fallen girders (crouch or roll under).
//   Act 3  THE RELAY TOWER  x 90..126. Its top floor (14) is split by a chasm the simulation lens
//                           shows a way across; the biochip lies in the vault beyond. The archive
//                           below (7) is unlit, and a dark zone fills the corridor to the breaker
//                           room, where one of three conduits is still live (the heat lens shows which).
//   Act 4  THE DESCENT      the relay's switchback stair shaft (unlocked by the conduit) down to -14,
//                           the lower bridge back west, and the spire's reactor floor: start the
//                           reactor and hold the room while it spins up.
//   Act 5  THE RETURN       the service lift (te_level.ts LIFT) back to the atrium and the Warden.
//
// Coordinates as in te_level.ts. Everything here is boxes (drawn and collided), Meshy props and spots.

import { MAT, hash, LOW_FLOOR, LIFT, type Level, type Box, type V3, type Prop, type EnemySpawn, type LevelLight, type DarkZone } from "./te_level";

export const BRIDGE = { y: 14, z: 2.2, x0: 6, x1: 90 };
export const LOW_BRIDGE = { y: LOW_FLOOR, z0: -14.2, z1: -9.8, x0: 4, x1: 90 };
export const RELAY = { x0: 90, x1: 126, z0: -18, z1: 18, top: 35 };
/** The relay's stair shaft (south-west corner): two lanes, a flight each per half floor. */
export const SHAFT = { x0: 90, x1: 98, z0: -18, z1: -7, mid: 94 };
/** The chasm in the relay's top floor; the old world's floor still spans it (sim boxes). */
export const CHASM = { x0: 104, x1: 112, z0: -4, z1: 18 };
export const RELAY_DARK: DarkZone = { id: "relay", center: [109, 7, -13.2], radius: 5.5 };
export const REACTOR: V3 = [-12, LOW_FLOOR, -4];
export const CONSOLE: V3 = [-6.2, LOW_FLOOR, -4];
/** The breaker that still carries current. */
export const LIVE_CONDUIT = "conduit-c";
/** Where the reactor's waves come from: over the broken east edge, off the lower bridge, the north. */
export const WAVE_SPAWNS: { kind: "roller" | "hacked_bot" | "crawler"; pos: V3 }[][] = [
    [{ kind: "crawler", pos: [8, LOW_FLOOR, 6] }, { kind: "crawler", pos: [7, LOW_FLOOR, -18] }, { kind: "roller", pos: [12, LOW_FLOOR, -12] }],
    [{ kind: "roller", pos: [12, LOW_FLOOR, -11] }, { kind: "roller", pos: [9, LOW_FLOOR, 10] }, { kind: "hacked_bot", pos: [6, LOW_FLOOR, 18] }],
    [{ kind: "crawler", pos: [8, LOW_FLOOR, -20] }, { kind: "crawler", pos: [9, LOW_FLOOR, 2] }, { kind: "crawler", pos: [6, LOW_FLOOR, 14] }, { kind: "hacked_bot", pos: [12, LOW_FLOOR, -12] }],
    [{ kind: "hacked_bot", pos: [6, LOW_FLOOR, 18] }, { kind: "hacked_bot", pos: [12, LOW_FLOOR, -11] }, { kind: "roller", pos: [8, LOW_FLOOR, -2] }],
];
/** Seconds into the hold-out each wave arrives, and how long the reactor takes to spin up. */
export const WAVE_TIMES = [0, 18, 38, 56];
export const HOLD_SECONDS = 75;
/** Where the Warden drops in, through the atrium roof's tear. */
export const WARDEN_DROP: V3 = [2, 14, -7];

export function addActs(level: Level): void {
    const { boxes, props, enemies, pickups, lights, checkpoints, uses, items, doors, darkZones } = level;
    const add = (min: V3, max: V3, mat: number, tint: V3 = [1, 1, 1], opts: Partial<Box> = {}) =>
        boxes.push({ min, max, mat, tint, draw: true, solid: true, ...opts });
    /** A table: a wooden top 0.85 up on four iron legs (one solid box). */
    const table = (x: number, y: number, z: number, hx = 0.7, hz = 0.4) => {
        add([x - hx, y + 0.8, z - hz], [x + hx, y + 0.86, z + hz], MAT.wood, [0.55, 0.42, 0.32], { solid: false });
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) add([x + sx * (hx - 0.08) - 0.04, y, z + sz * (hz - 0.08) - 0.04], [x + sx * (hx - 0.08) + 0.04, y + 0.8, z + sz * (hz - 0.08) + 0.04], MAT.metal, [0.35, 0.32, 0.3], { solid: false });
        boxes.push({ min: [x - hx, y, z - hz], max: [x + hx, y + 0.86, z + hz], mat: MAT.wood, tint: [1, 1, 1], draw: false, solid: true });
        return y + 0.86;
    };
    const crate = (x0: number, z0: number, x1: number, z1: number, y: number, h: number, mat: number = MAT.wood, tint: V3 = [0.62, 0.5, 0.38]) => { add([x0, y, z0], [x1, y + h, z1], mat, tint); return y + h; };
    const enemy = (id: string, kind: EnemySpawn["kind"], pos: V3, zone: string, patrol: V3[] = [pos], yaw = 0) => enemies.push({ id, kind, pos, yaw, zone, patrol });
    const light = (pos: V3, color: V3, intensity: number, range: number, flicker?: number) => lights.push({ pos, color, intensity, range, flicker } as LevelLight);
    const prop = (p: Prop) => props.push(p);
    const rust: V3 = [0.5, 0.36, 0.28], steel: V3 = [0.5, 0.48, 0.46], granite: V3 = [0.55, 0.51, 0.47];

    // --- Act 1 additions in the spire: collectibles on tables, and crates.
    items.push({ id: "pocket-watch", pos: [-18.5, table(-18.5, 0, -12.4), -12.4], yaw: 0.4 });
    items.push({ id: "earth-photo", pos: [-9.6, table(-9.6, 0, -16, 0.4, 0.7), -16.2], yaw: -Math.PI / 2 });
    items.push({ id: "toy-rover", pos: [8.2, 0, -8.2], yaw: 2.2 });
    items.push({ id: "music-box", pos: [-10, table(-10, 7, 12), 12], yaw: 0.2 });
    items.push({ id: "seed-vial", pos: [11, crate(10.5, -10, 11.5, -9, 7, 0.8, MAT.metal, steel), -9.5], yaw: 0 });
    items.push({ id: "upload-ticket", pos: [-9.5, table(-9.5, 14, 2), 2.1], yaw: 1.2 });

    // --- The reactor floor (y = -14): the reactor, its console, cover, the lift's landing.
    const Y = LOW_FLOOR;
    prop({ model: "reactor", pos: REACTOR, yaw: 0.3, size: 6, collide: [2.4, 2.4, 2.4] });
    prop({ model: "holo_terminal", pos: CONSOLE, yaw: -Math.PI / 2, size: 1.5, collide: [0.4, 0.75, 0.4] });
    prop({ model: "boiler", pos: [-20, Y, -6], yaw: 1.2, size: 3.4, collide: [0.95, 1.7, 0.95] });
    prop({ model: "boiler", pos: [-20, Y, -1.5], yaw: 0.4, size: 3.4, collide: [0.95, 1.7, 0.95] });
    prop({ model: "junk", pos: [3, Y, 12], yaw: 0.9, size: 2.6, collide: [1.1, 0.4, 1.1] });
    prop({ model: "rubble", pos: [4, Y, -20], yaw: 2.2, size: 4.5, collide: [1.8, 0.6, 1.8], sink: 0.2 });
    prop({ model: "carcass", pos: [-3, Y, 16], yaw: 2.6, size: 1.9, collide: [0.6, 0.6, 0.6] });
    for (const [x0, z0, x1, z1, h] of [[-1.5, -11, 0.5, -10, 1.2], [1.5, 1, 2.5, 3.5, 1.1], [-4, 8, -1.5, 9, 1.2], [3, -4.5, 4, -2.5, 1.0], [-9, 6, -7, 7, 1.3], [-2, -18, 0, -17, 1.1]] as number[][]) crate(x0, z0, x1, z1, Y, h, MAT.metal, steel);
    items.push({ id: "engineer-mug", pos: [-6.4, table(-6.4, Y, -6.6), -6.6], yaw: 0.6 });
    items.push({ id: "fusion-key", pos: [-17.6, table(-17.6, Y, 3), 3], yaw: 2.1 });
    items.push({ id: "family-holo", pos: [-20, table(-20, Y, -20), -20], yaw: 0.8 });
    uses.push({ id: "console", kind: "console", pos: [CONSOLE[0] + 0.9, Y, CONSOLE[2]], yaw: -Math.PI / 2, label: "START THE REACTOR" });
    uses.push({ id: "lift", kind: "lift", pos: [(LIFT.x0 + LIFT.x1) / 2, Y, (LIFT.z0 + LIFT.z1) / 2 + 0.4], yaw: 0, label: "SEND THE LIFT UP" });
    enemy("rf-bot-1", "hacked_bot", [-2, Y, 6], "reactor", [[-2, Y, 6], [4, Y, -6], [-6, Y, -12]], Math.PI);
    enemy("rf-roller-1", "roller", [2, Y, -14], "reactor", [[2, Y, -14], [-8, Y, -14], [-8, Y, 10], [2, Y, 10]]);
    pickups.push({ id: "cell-reactor-n", pos: [-14, Y, 10] }, { id: "cell-reactor-s", pos: [-4, Y, -16] });
    light([REACTOR[0], Y + 3.2, REACTOR[2]], [0.4, 0.7, 1], 3.5, 12);
    light([CONSOLE[0] + 0.6, Y + 1.8, CONSOLE[2]], [0.3, 0.85, 1], 1.6, 5);
    light([-21.8, Y + 3, 13], [1, 0.62, 0.3], 2.2, 7);
    light([0, Y + 4.5, 10], [1, 0.45, 0.2], 2.6, 10, 0.7);
    light([-10, Y + 4.5, -16], [1, 0.55, 0.3], 2, 9);
    checkpoints.push({ id: "reactor", pos: [7, Y, -12], yaw: -Math.PI / 2, radius: 3.5 });

    // --- Act 2: the sky bridge. Deck, rails (broken in places), the truss, girders to get under.
    const B = BRIDGE, by = B.y;
    const decks: [number, number][] = [[B.x0, 30], [32.2, 52], [54.4, B.x1]];
    for (const [x0, x1] of decks) {
        add([x0, by - 0.6, -B.z], [x1, by, B.z], MAT.asphalt, [0.62, 0.6, 0.58]);
        add([x0, by - 1.6, -1.6], [x1, by - 0.6, -1.2], MAT.metal, rust, { solid: false });
        add([x0, by - 1.6, 1.2], [x1, by - 0.6, 1.6], MAT.metal, rust, { solid: false });
        add([x0, by + 4.4, -B.z - 0.3], [x1, by + 4.7, -B.z - 0.1], MAT.metal, rust, { solid: false });
        add([x0, by + 4.4, B.z + 0.1], [x1, by + 4.7, B.z + 0.3], MAT.metal, rust, { solid: false });
        for (let x = Math.ceil(x0 / 6) * 6; x < x1; x += 6) for (const s of [-1, 1]) add([x - 0.12, by, s * (B.z + 0.2) - 0.12], [x + 0.12, by + 4.6, s * (B.z + 0.2) + 0.12], MAT.metal, rust);
    }
    const rails: [number, number, number][] = [[1, 6, 17], [1, 21, 30], [1, 32.2, 44], [1, 46, 52], [1, 54.4, 66], [1, 70, 89.9],
        [-1, 6, 24], [-1, 26, 30], [-1, 32.2, 52], [-1, 54.4, 60], [-1, 63, 89.9]];
    for (const [s, x0, x1] of rails) add([x0, by, s * B.z - 0.12], [x1, by + 1.05, s * B.z + 0.12], MAT.metal, [0.42, 0.38, 0.33]);
    // Fallen girders across the deck: too low to stand under, too high to jump.
    add([40, by + 1.25, -B.z - 0.4], [40.7, by + 1.85, B.z + 0.4], MAT.metal, rust);
    add([74, by + 1.3, -B.z - 0.4], [75.2, by + 2.3, B.z + 0.4], MAT.metal, [0.46, 0.34, 0.26]);
    for (const [x0, z0, x1, z1, h] of [[47, 0.6, 48.2, 1.8, 0.9], [57, 0.4, 58.4, 1.6, 1.2], [61.5, -1.8, 62.7, -0.6, 1.0], [68, -0.2, 69.6, 1.5, 1.3], [82, -1.6, 83.4, -0.3, 1.1]] as number[][]) crate(x0, z0, x1, z1, by, h);
    const bench = crate(49, -2.0, 50.6, -1.5, by, 0.45, MAT.metal, steel);
    items.push({ id: "commuter-pass", pos: [49.8, bench, -1.75], yaw: 0.3 });
    items.push({ id: "courier-drone", pos: [82.7, by + 1.1, -0.95], yaw: 1.9 });
    prop({ model: "junk", pos: [27, by, -1], yaw: 1.1, size: 2, collide: [0.8, 0.3, 0.8] });
    prop({ model: "carcass", pos: [64.5, by, 1.3], yaw: -1.6, size: 1.8, collide: [0.55, 0.55, 0.55] });
    enemy("b-roller-1", "roller", [22, by, 0], "bridge", [[22, by, 0], [12, by, -1], [28, by, 1]]);
    enemy("b-roller-2", "roller", [60, by, 0], "bridge", [[60, by, 0], [72, by, -1], [56, by, 1]]);
    enemy("b-bot-1", "hacked_bot", [80, by, 0], "bridge", [[80, by, 0], [86, by, 0.5], [77, by, -0.5]], -Math.PI / 2);
    enemy("b-crawler-1", "crawler", [86, by, -1], "bridge", [[86, by, -1], [70, by, 0.5]], -Math.PI / 2);
    pickups.push({ id: "cell-bridge", pos: [36, by, 0.4] }, { id: "cell-bridge-far", pos: [86, by, 1.5] });
    checkpoints.push({ id: "bridge-far", pos: [76.5, by, 0], yaw: Math.PI / 2, radius: 3 });

    // --- Act 3: the Relay Tower.
    const R = RELAY, S = SHAFT, C = CHASM;
    // Below its archive floor the tower is a solid core (the shaft is cut out of it).
    add([S.x1, -45, R.z0], [R.x1, 6.4, R.z1], MAT.concrete, [0.62, 0.6, 0.58], { uvScale: 0.5 });
    add([R.x0, -45, S.z1], [S.x1, 6.4, R.z1], MAT.concrete, [0.62, 0.6, 0.58], { uvScale: 0.5 });
    add([R.x0, -45, R.z0], [S.x1, LOW_FLOOR - 0.6, S.z1], MAT.concrete, [0.62, 0.6, 0.58], { uvScale: 0.5 });
    // Floors: the vault floor (14) with its chasm, the archive (7), the floors above drawn only.
    for (const fy of [7, 14, 21, 28]) for (let cz = R.z0; cz < R.z1; cz += 2) for (let cx = R.x0; cx < R.x1; cx += 2) {
        const x = cx + 1, z = cz + 1;
        if (fy <= 14 && x < S.x1 && z < S.z1) continue;
        if (fy === 14 && x > C.x0 && x < C.x1 && z > C.z0 && z < C.z1) continue;
        const shade = 0.86 + hash(cx, cz, fy) * 0.12;
        add([cx, fy - 0.6, cz], [cx + 2, fy, cz + 2], fy === 14 && x > 112 && z > 6 ? MAT.marble : MAT.concrete, [shade * 0.82, shade * 0.8, shade * 0.78], { solid: fy <= 14 });
    }
    add([R.x0 - 0.4, R.top - 0.6, R.z0 - 0.4], [R.x1 + 0.4, R.top, R.z1 + 0.4], MAT.concrete, [0.7, 0.68, 0.66], { solid: false });
    // Facade: granite columns every 4 m, spandrels at each floor, parapets on the two walked floors.
    for (let t = 0; t <= 36; t += 4) {
        for (const [x, z] of [[R.x0 + t, R.z0], [R.x0 + t, R.z1], [R.x0, R.z0 + t], [R.x1, R.z0 + t]] as [number, number][]) {
            if (x === R.x0 && Math.abs(z) < B.z + 1) continue; // the bridge's landing
            const top = R.top - (hash(x, z, 3) > 0.7 ? 3 + hash(x, z) * 5 : 0);
            add([x - 0.5, 6.4, z - 0.5], [x + 0.5, top, z + 0.5], MAT.granite, granite);
        }
    }
    for (const fy of [7, 14, 21, 28, R.top]) {
        add([R.x0 - 0.45, fy - 1.1, R.z0 - 0.45], [R.x1 + 0.45, fy - 0.55, R.z0 + 0.45], MAT.granite, [0.5, 0.47, 0.44], { solid: false });
        add([R.x0 - 0.45, fy - 1.1, R.z1 - 0.45], [R.x1 + 0.45, fy - 0.55, R.z1 + 0.45], MAT.granite, [0.5, 0.47, 0.44], { solid: false });
        add([R.x0 - 0.45, fy - 1.1, R.z0], [R.x0 + 0.45, fy - 0.55, R.z1], MAT.granite, [0.5, 0.47, 0.44], { solid: false });
        add([R.x1 - 0.45, fy - 1.1, R.z0], [R.x1 + 0.45, fy - 0.55, R.z1], MAT.granite, [0.5, 0.47, 0.44], { solid: false });
    }
    for (const fy of [7, 14]) {
        const rail = (min: V3, max: V3) => add(min, max, MAT.metal, [0.45, 0.4, 0.35]);
        rail([R.x0, fy, R.z1 - 0.2], [R.x1, fy + 1.15, R.z1 + 0.2]);
        rail([fy === 14 ? R.x0 : S.x1, fy, R.z0 - 0.2], [R.x1, fy + 1.15, R.z0 + 0.2]);
        rail([R.x1 - 0.2, fy, R.z0], [R.x1 + 0.2, fy + 1.15, R.z1]);
        // The west face, open at the bridge's landing on the vault floor.
        if (fy === 14) { rail([R.x0 - 0.2, fy, R.z0], [R.x0 + 0.2, fy + 1.15, -B.z]); rail([R.x0 - 0.2, fy, B.z], [R.x0 + 0.2, fy + 1.15, R.z1]); }
        else rail([R.x0 - 0.2, fy, S.z1], [R.x0 + 0.2, fy + 1.15, R.z1]);
    }
    // The stair shaft: walls, a landing at each floor and halfway, a flight in each lane.
    const shaftWall = (min: V3, max: V3) => add(min, max, MAT.concrete, [0.6, 0.58, 0.56], { uvScale: 0.8 });
    shaftWall([S.x1 - 0.15, LOW_FLOOR, S.z0], [S.x1 + 0.15, 21, S.z1]);
    shaftWall([S.x0, LOW_FLOOR, S.z0 - 0.3], [S.x1, 14, S.z0]);
    shaftWall([S.x0 - 0.3, LOW_FLOOR + 2.8, S.z0], [S.x0, 14, S.z1]);
    shaftWall([S.x0 - 0.3, LOW_FLOOR, S.z0], [S.x0, LOW_FLOOR + 2.8, -13.4]);
    shaftWall([S.x0 - 0.3, LOW_FLOOR, -10.6], [S.x0, LOW_FLOOR + 2.8, S.z1]);
    for (const [y0, y1, open] of [[LOW_FLOOR, 7, false], [7, 9.8, true], [9.8, 13.4, false], [14, 16.8, true], [16.8, 21, false]] as [number, number, boolean][]) {
        if (open) { shaftWall([S.x0, y0, S.z1 - 0.15], [S.x0 + 1, y1, S.z1 + 0.15]); shaftWall([S.x1 - 1, y0, S.z1 - 0.15], [S.x1, y1, S.z1 + 0.15]); }
        else shaftWall([S.x0, y0, S.z1 - 0.15], [S.x1, y1, S.z1 + 0.15]);
    }
    const flight = (xa: number, xb: number, zHigh: number, zLow: number, yHigh: number, yLow: number) => {
        const n = 14;
        for (let i = 0; i < n; i++) {
            const za = zHigh + ((zLow - zHigh) * i) / n, zb = zHigh + ((zLow - zHigh) * (i + 1)) / n;
            add([xa, yLow - 0.3, Math.min(za, zb)], [xb, yHigh - ((yHigh - yLow) * (i + 1)) / n, Math.max(za, zb)], MAT.concrete, [0.7, 0.68, 0.66]);
        }
    };
    add([S.x0, 13.6, -9.2], [S.x1, 14, S.z1], MAT.concrete, [0.72, 0.7, 0.68]);
    for (const top of [14, 7, 0, -7]) {
        flight(S.x0 + 0.2, S.mid - 0.15, -9.2, -15.4, top, top - 3.5);
        add([S.x0 + 0.2, top - 3.9, S.z0 + 0.2], [S.x1 - 0.2, top - 3.5, -15.4], MAT.concrete, [0.72, 0.7, 0.68]);
        flight(S.mid + 0.15, S.x1 - 0.2, -15.4, -9.2, top - 3.5, top - 7);
        add([S.mid - 0.15, top - 7, -15.4], [S.mid + 0.15, top, -9.2], MAT.concrete, [0.66, 0.64, 0.62]);
        if (top - 7 > LOW_FLOOR) add([S.x0, top - 7.4, -9.2], [S.x1, top - 7, S.z1], MAT.concrete, [0.72, 0.7, 0.68]);
        light([S.mid, top + 2.4, -8.2], [1, 0.18, 0.1], 1.8, 7, 0.5);
    }
    add([S.x0, LOW_FLOOR - 0.6, S.z0], [S.x1, LOW_FLOOR, S.z1], MAT.concrete, [0.72, 0.7, 0.68]);
    light([S.mid, LOW_FLOOR + 2.4, -12], [1, 0.18, 0.1], 1.8, 7, 0.5);
    // The blast door on the archive floor's landing, shut until a conduit is live again.
    doors.push({ id: "relay-stairs", min: [S.x0 + 0.2, 7, -9.5], max: [S.mid - 0.15, 10.2, -9.25], mat: MAT.metal, tint: [0.5, 0.4, 0.3] });
    items.push({ id: "spray-can", pos: [91, 0, -8.2], yaw: 0.7 });
    items.push({ id: "dog-tag", pos: [97, -7, -8.1], yaw: 2.4 });
    enemy("s-crawler-1", "crawler", [92, 0, -8], "shaft", [[92, 0, -8], [96, 0, -8]], Math.PI);
    enemy("s-crawler-2", "crawler", [96, -7, -8], "shaft", [[96, -7, -8], [92, -7, -8]], Math.PI);
    pickups.push({ id: "cell-shaft", pos: [92.5, -7, -8.2] });
    checkpoints.push({ id: "relay-hall", pos: [94, 14, 2], yaw: Math.PI / 2, radius: 3 });

    // The vault floor (14): the entry hall west of the chasm, archive racks and the vault beyond it.
    const F = 14;
    shaftWall([C.x0 - 0.15, F, R.z0], [C.x0 + 0.15, F + 6.4, C.z0]);
    // The old floor across the chasm: three beams, seen only through the simulation lens.
    for (const [x0, z0, x1, z1] of [[C.x0 - 0.4, 9.6, 108.4, 10.4], [107.6, 10, 108.4, 14.4], [108, 13.6, C.x1 + 0.4, 14.4]] as number[][]) {
        boxes.push({ min: [x0, F - 0.25, z0], max: [x1, F, z1], mat: MAT.marble, tint: [1, 1, 1], draw: false, solid: true, sim: true });
    }
    // The vault: walls west and south, its door facing the chasm.
    const vault = (min: V3, max: V3) => add(min, max, MAT.marble, [0.6, 0.58, 0.56]);
    vault([113.85, F, 6], [114.15, F + 6.4, 9]);
    vault([113.85, F, 11.5], [114.15, F + 6.4, R.z1]);
    vault([113.85, F, 5.85], [R.x1, F + 6.4, 6.15]);
    vault([113.85, F + 3, 9], [114.15, F + 6.4, 11.5]);
    add([121.4, F, 12.4], [122.6, F + 1.05, 13.6], MAT.marble, [0.7, 0.68, 0.66]);
    uses.push({ id: "biochip", kind: "biochip", pos: [122, F + 1.05, 13], yaw: Math.PI, label: "TAKE THE BIOCHIP" });
    items.push({ id: "vault-ledger", pos: [117.4, table(117.4, F, 16.6), 16.6], yaw: 0.2 });
    for (const z of [-15, -10.5, -6, -1.5]) for (const x of [117, 122]) prop({ model: "archive_rack", pos: [x, F, z], yaw: Math.PI / 2, size: 2.9, collide: [1.3, 1.45, 0.5] });
    for (const z of [9, 14]) prop({ model: "archive_rack", pos: [125, F, z], yaw: -Math.PI / 2, size: 2.9, collide: [1.3, 1.45, 0.5] });
    prop({ model: "holo_terminal", pos: [100, F, 3], yaw: -Math.PI / 2, size: 1.5, collide: [0.4, 0.75, 0.4] });
    prop({ model: "upload_pod", pos: [91, F, 12], yaw: Math.PI / 2, size: 2.4, collide: [0.55, 1.2, 0.55] });
    prop({ model: "upload_pod", pos: [91, F, 15], yaw: Math.PI / 2, size: 2.4, collide: [0.55, 1.2, 0.55] });
    prop({ model: "rubble", pos: [102, F, -12], yaw: 0.4, size: 4, collide: [1.6, 0.5, 1.6], sink: 0.15 });
    prop({ model: "junk", pos: [124, F, -16], yaw: 2.6, size: 2.2, collide: [0.9, 0.35, 0.9] });
    items.push({ id: "archivist-badge", pos: [95, table(95, F, 8), 8], yaw: 0.9 });
    items.push({ id: "chess-knight", pos: [101, table(101, F, 15), 15], yaw: 2.5 });
    items.push({ id: "memory-spindle", pos: [124.4, table(124.4, F, -8.2, 0.4, 0.7), -8.2], yaw: 0 });
    items.push({ id: "child-drawing", pos: [113, crate(112.6, -1, 113.6, 0, F, 0.7), -0.5], yaw: -Math.PI / 2 });
    enemy("r-roller-1", "roller", [96, F, 6], "relay14", [[96, F, 6], [101, F, 14], [99, F, -2]]);
    enemy("r-bot-1", "hacked_bot", [101, F, 12], "relay14", [[101, F, 12], [96, F, -3], [101, F, -14]], -Math.PI / 2);
    enemy("r-crawler-1", "crawler", [119.5, F, -8], "relay14", [[119.5, F, -8], [119.5, F, 3], [113, F, -4]]);
    enemy("r-crawler-2", "crawler", [124, F, 2], "relay14", [[124, F, 2], [124, F, -12]]);
    enemy("r-bot-2", "hacked_bot", [119.5, F, -16.5], "relay14", [[119.5, F, -16.5], [113, F, -16], [119.5, F, 3]], 0);
    pickups.push({ id: "cell-relay-hall", pos: [92, F, -4] }, { id: "cell-relay-east", pos: [125, F, 4.5] });
    light([96, F + 2.6, 4], [1, 0.72, 0.45], 3, 11);
    light([100.6, F + 1.6, 3], [0.3, 0.85, 1], 1.8, 5, 0.3);
    light([120, F + 2.6, 12], [0.4, 1, 0.5], 2.2, 8);
    light([118, F + 2.6, -8], [0.3, 0.8, 1], 1.4, 8, 0.4);
    light([108, F + 0.4, 12], [0.3, 0.8, 1], 0.6, 6);
    checkpoints.push({ id: "vault-walk", pos: [113, F, 3], yaw: 0, radius: 2.2 });

    // The archive floor (7): unlit; the corridor south runs through a dark zone to the breaker room.
    const A = 7;
    const inner = (min: V3, max: V3) => add(min, max, MAT.concrete, [0.55, 0.53, 0.51], { uvScale: 0.8 });
    inner([S.x1, A, -8.15], [100, A + 6.4, -7.85]);
    inner([104, A, -8.15], [118, A + 6.4, -7.85]);
    inner([117.85, A, R.z0], [118.15, A + 6.4, -14]);
    inner([117.85, A, -12], [118.15, A + 6.4, -7.85]);
    inner([117.85, A + 2.9, -14], [118.15, A + 6.4, -12]);
    darkZones.push(RELAY_DARK);
    prop({ model: "dark_emitter", pos: RELAY_DARK.center, yaw: 1.3, size: 2.4, collide: [0.9, 0.8, 0.9] });
    for (const [id, z] of [["conduit-a", -16.2], ["conduit-b", -13], ["conduit-c", -9.8]] as [string, number][]) {
        prop({ model: "conduit", pos: [125.2, A, z], yaw: -Math.PI / 2, size: 1.9, collide: [0.45, 0.95, 0.6], heat: id === LIVE_CONDUIT ? 1 : 0.04 });
        uses.push({ id, kind: "conduit", pos: [124.2, A, z], yaw: -Math.PI / 2, label: "PULL THE BREAKER" });
    }
    for (const z of [3, 8, 13]) for (const x of [108, 115, 121]) prop({ model: "archive_rack", pos: [x, A, z], yaw: Math.PI / 2, size: 2.9, collide: [1.3, 1.45, 0.5] });
    prop({ model: "rubble", pos: [107, A, 0], yaw: 1.4, size: 4.5, collide: [1.8, 0.6, 1.8], sink: 0.2 });
    prop({ model: "girders", pos: [110, A, 15.5], yaw: 0.2, size: 5, collide: [2, 0.5, 1.4] });
    prop({ model: "carcass", pos: [101, A, -16], yaw: 0.6, size: 1.9, collide: [0.6, 0.6, 0.6] });
    items.push({ id: "night-lamp", pos: [96, table(96, A, 12), 12], yaw: 1.6 });
    items.push({ id: "broken-lens", pos: [113.5, A, -1.5], yaw: 0.4 });
    items.push({ id: "tuning-fork", pos: [122, table(122, A, 16.4), 16.4], yaw: 2.9 });
    items.push({ id: "linesman-glove", pos: [121, table(121, A, -17), -17], yaw: 0.3 });
    enemy("r-crawler-3", "crawler", [111, A, 5.5], "relay7", [[111, A, 5.5], [118, A, 10.5], [103, A, 10.5]]);
    enemy("r-crawler-4", "crawler", [118, A, 16], "relay7", [[118, A, 16], [104, A, 16]]);
    enemy("r-bot-3", "hacked_bot", [121.5, A, -12], "relay7", [[121.5, A, -12], [121.5, A, -16], [121.5, A, -9]], -Math.PI / 2);
    pickups.push({ id: "cell-archive", pos: [95, A, 15] }, { id: "cell-breakers", pos: [119.6, A, -9.5] });
    light([123, A + 2.4, -13], [1, 0.2, 0.1], 1.6, 7, 0.8);
    light([RELAY_DARK.center[0], A + 1.5, RELAY_DARK.center[2]], [0.55, 0.15, 1], 3, 9);
    light([94, A + 2.6, -5], [1, 0.6, 0.3], 1.2, 5, 0.4);
    checkpoints.push({ id: "archive", pos: [94, A, -5], yaw: Math.PI / 2, radius: 2.5 });

    // --- Act 4: the lower bridge, from the shaft's foot back west to the reactor floor.
    const LB = LOW_BRIDGE, ly = LB.y;
    for (const [x0, x1] of [[LB.x0, 40], [42.3, LB.x1]] as [number, number][]) {
        add([x0, ly - 0.6, LB.z0], [x1, ly, LB.z1], MAT.concrete, [0.6, 0.58, 0.56]);
        add([x0, ly - 1.4, -13.2], [x1, ly - 0.6, -10.8], MAT.metal, rust, { solid: false });
    }
    for (const [z, x0, x1] of [[LB.z0, 12, 30], [LB.z0, 33, 40], [LB.z0, 42.3, 89.9], [LB.z1, 12, 40], [LB.z1, 42.3, 57], [LB.z1, 60, 89.9]] as number[][]) add([x0, ly, z - 0.12], [x1, ly + 1.05, z + 0.12], MAT.metal, [0.42, 0.38, 0.33]);
    for (const x of [25, 55, 80]) add([x - 1.2, -200, -13.2], [x + 1.2, ly - 0.6, -10.8], MAT.concrete, [0.55, 0.53, 0.5], { solid: false, uvScale: 0.4 });
    // A gantry fallen across it: under, not over.
    add([62, ly + 1.25, LB.z0 - 0.4], [62.8, ly + 1.9, LB.z1 + 0.4], MAT.metal, rust);
    for (const [x0, z0, x1, z1, h] of [[20, -13.6, 21.4, -12.4, 1.1], [33.5, -11.2, 34.8, -10.1, 1.2], [50, -13.8, 51.4, -12.6, 1.0], [70, -11.4, 71.6, -10.2, 1.2]] as number[][]) crate(x0, z0, x1, z1, ly, h, MAT.metal, steel);
    items.push({ id: "postcard-phobos", pos: [34.15, ly + 1.2, -10.65], yaw: 0.9 });
    items.push({ id: "commendation", pos: [72.5, ly, -10.5], yaw: 1.2 });
    enemy("lb-crawler-1", "crawler", [80, ly, -12], "lowbridge", [[80, ly, -12], [66, ly, -12]], -Math.PI / 2);
    enemy("lb-roller-1", "roller", [56, ly, -12], "lowbridge", [[56, ly, -12], [46, ly, -11], [58, ly, -13]]);
    enemy("lb-roller-2", "roller", [32, ly, -12], "lowbridge", [[32, ly, -12], [22, ly, -12]]);
    enemy("lb-bot-1", "hacked_bot", [16, ly, -12], "lowbridge", [[16, ly, -12], [26, ly, -12]], Math.PI / 2);
    pickups.push({ id: "cell-low-bridge", pos: [46, ly, -12] });
    checkpoints.push({ id: "relay-bottom", pos: [93, ly, -12], yaw: -Math.PI / 2, radius: 2.5 });
    checkpoints.push({ id: "lift-top", pos: [-21.8, 14, 11.6], yaw: Math.PI, radius: 2.5 });

    // Checkpoints are reached in this order (the game only moves forward through them).
    const order = ["lab", "second-floor", "fallen-slab", "atrium", "bridge-far", "relay-hall", "vault-walk", "archive", "relay-bottom", "reactor", "lift-top"];
    checkpoints.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/** Every point the old world's floor spans the chasm (sim lens outlines). */
export function simBoxes(level: Level): Box[] { return level.boxes.filter(b => b.sim); }
