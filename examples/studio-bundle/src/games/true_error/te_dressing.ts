// Scenery: the kit of secondary props (assets.json, add_kit.mjs) scattered over both missions, so the
// wide floors read as the leftovers of a city instead of a bare stage. Everything here is
// deterministic (hashed), runs once when a map is built, and only adds props and roads:
//
//   the Spire   office wreckage against the walls and columns, rubble and Martian growth along the
//               blast edge, machine-room clutter on the reactor floor and in the relay.
//   Noctis      the canyon city's old streets (worn asphalt ribbons, te_shader.ts ARCH.road) with
//               their lamps, poles, signs, rails and wrecks; ruins set back along them; junk around
//               every place people live; Martian plants (denser by the canal); a power line; the
//               Undercroft's platform and pit. The scrub between is baked billboard cards (scrubMesh).
//
// Colliding props keep off the routes the mission needs (ROUTES, the test walks), every use spot,
// collectible, cell, checkpoint, door and machine patrol, and leave a passage beside walls.

import { hash, type Level, type Prop, type V3, type Road } from "./te_level";
import { KIT_BOUNDS } from "./te_kit_bounds";

export type KitModel = "street_lamp" | "street_sign" | "road_barrier" | "guard_rail" | "barricade" | "utility_pole" | "billboard" | "transit_shelter" | "vending_machine" | "power_pylon"
    | "trash_pile" | "barrels" | "scrap_sheets" | "concrete_slab" | "pipe_section" | "cable_spool" | "dumpster" | "duct_section" | "office_wreck"
    | "car_wreck" | "truck_wreck" | "engine_block" | "cargo_container"
    | "mars_shrub" | "succulents" | "dead_tree" | "fungus_cluster"
    | "ruined_building" | "ruined_storefront" | "overpass_span"
    | WallModel;
/** The wall kit (add_walls.mjs): hung on walls and columns, or stood against them (dressWalls). */
export type WallModel = "wall_pipes" | "breaker_panel" | "notice_board" | "wall_screens" | "wall_vent" | "caged_lamp" | "chalkboard" | "wall_cables" | "torn_posters"
    | "fire_cabinet" | "ac_unit" | "lockers" | "metal_shelf" | "bookcase" | "radiator";

/**
 * A kit piece: its size range (the model's largest extent, meters), its collision box as half extents
 * per meter of size (x, y, z before yaw; none: walked through), how far away it is still drawn, and
 * whether it casts a shadow. kitBox refines the boxes from the GLBs.
 */
export interface KitPiece { size: [number, number]; box?: V3; cull?: number; shadow?: boolean; sink?: number; wall?: WallMount }
/**
 * How a wall piece goes on a wall: its foot this high over the floor (none: stood on it, and solid),
 * turned round when its model faces -z, how brightly it glows, and how far from another of its kind.
 */
export interface WallMount { at?: [number, number]; flip?: boolean; glow?: number; apart?: number }

export const KIT: Record<KitModel, KitPiece> = {
    street_lamp: { size: [5.5, 7], box: [0.05, 0.5, 0.05], cull: 260 },
    street_sign: { size: [3, 4], box: [0.05, 0.5, 0.05], cull: 160 },
    road_barrier: { size: [2.6, 3.4], box: [0.48, 0.15, 0.14], cull: 180 },
    guard_rail: { size: [5, 7], cull: 200 },
    barricade: { size: [3, 4], box: [0.46, 0.17, 0.2], cull: 160 },
    utility_pole: { size: [8.5, 11], box: [0.04, 0.5, 0.04], cull: 420 },
    billboard: { size: [10, 13], box: [0.08, 0.5, 0.06] },
    transit_shelter: { size: [4, 5], cull: 220 },
    vending_machine: { size: [2.2, 2.5], box: [0.22, 0.5, 0.18], cull: 120 },
    power_pylon: { size: [30, 38], box: [0.06, 0.5, 0.06] },
    trash_pile: { size: [1.6, 3], cull: 80, shadow: false, sink: 0.05 },
    barrels: { size: [1.6, 2.2], box: [0.36, 0.26, 0.36], cull: 130 },
    scrap_sheets: { size: [2, 3.4], box: [0.32, 0.16, 0.32], cull: 130, sink: 0.05 },
    concrete_slab: { size: [2.5, 7], box: [0.34, 0.12, 0.34], cull: 260, sink: 0.1 },
    pipe_section: { size: [3, 9], box: [0.42, 0.14, 0.14], cull: 320, sink: 0.08 },
    cable_spool: { size: [1.4, 2.2], box: [0.36, 0.36, 0.26], cull: 120 },
    dumpster: { size: [2.6, 3.2], box: [0.44, 0.24, 0.3], cull: 160 },
    duct_section: { size: [2.5, 4], box: [0.42, 0.12, 0.18], cull: 120 },
    office_wreck: { size: [1.8, 2.4], box: [0.38, 0.2, 0.3], cull: 100 },
    car_wreck: { size: [4.5, 5.5], box: [0.44, 0.15, 0.2], cull: 320 },
    truck_wreck: { size: [8, 10], box: [0.44, 0.17, 0.17], cull: 420 },
    engine_block: { size: [1.4, 2.2], box: [0.38, 0.28, 0.3], cull: 120 },
    cargo_container: { size: [6, 7], box: [0.5, 0.19, 0.2] },
    mars_shrub: { size: [1, 2.2], cull: 90, shadow: false, sink: 0.05 },
    succulents: { size: [0.8, 1.6], cull: 70, shadow: false, sink: 0.03 },
    dead_tree: { size: [4, 8], box: [0.04, 0.5, 0.04], cull: 320 },
    fungus_cluster: { size: [1, 2.4], cull: 90, shadow: false, sink: 0.03 },
    ruined_building: { size: [24, 30], box: [0.36, 0.5, 0.26] },
    ruined_storefront: { size: [13, 16], box: [0.42, 0.4, 0.3] },
    overpass_span: { size: [26, 32] },
    wall_pipes: { size: [2.2, 3.2], cull: 70, wall: { at: [1.5, 2.1] } },
    breaker_panel: { size: [1.1, 1.5], cull: 50, wall: { at: [0.7, 0.95], apart: 6 } },
    notice_board: { size: [1.3, 1.9], cull: 50, wall: { at: [1.05, 1.3], apart: 4 } },
    wall_screens: { size: [1.4, 1.9], cull: 60, wall: { at: [1.3, 1.55], glow: 0.35, apart: 5 } },
    wall_vent: { size: [0.9, 1.3], cull: 50, wall: { at: [1.9, 2.3], apart: 5 } },
    caged_lamp: { size: [0.45, 0.65], cull: 70, wall: { at: [2, 2.4], glow: 1.2, apart: 7 } },
    chalkboard: { size: [2, 2.8], cull: 50, wall: { at: [0.85, 1], apart: 8 } },
    wall_cables: { size: [2.4, 3.4], cull: 60, wall: { at: [2, 2.5] } },
    torn_posters: { size: [1.4, 2.2], cull: 60, wall: { at: [0.35, 0.9] } },
    fire_cabinet: { size: [1, 1.3], cull: 50, wall: { at: [0.75, 0.95], apart: 9 } },
    ac_unit: { size: [1, 1.4], cull: 80, wall: { at: [1.9, 2.6], apart: 5 } },
    lockers: { size: [1.9, 2.1], box: [0.3, 0.5, 0.2], cull: 70, wall: {} },
    metal_shelf: { size: [1.9, 2.3], box: [0.24, 0.5, 0.1], cull: 60, wall: {} },
    bookcase: { size: [2.1, 2.5], box: [0.22, 0.5, 0.09], cull: 60, wall: {} },
    radiator: { size: [0.9, 1.3], box: [0.45, 0.4, 0.17], cull: 40, wall: { apart: 4 } },
};

export const KIT_MODELS = Object.keys(KIT) as KitModel[];

// --- The routes the missions need (kept clear of anything solid) -----------------------------------

type P2 = [number, number];
/** Where Ray has to be able to walk (tests/true_error_*.test.ts walks these), per mission. */
const ROUTES: Record<number, V3[][]> = {
    1: [
        [[-13.7, 0, -11], [-13.7, 0, -6.8], [-19, 0, -6.8], [-19, 7, 7.2], [-15, 7, 9], [-4, 7, 10], [7, 7, 9], [8.5, 7, 2], [9.6, 7, -4], [9.6, 7, -12], [8, 7, -23], [8, 7, -21], [8, 14, -7], [6, 14, -4], [2.5, 14, -1.5]],
        [[8, 14, 0], [95, 14, 0]],
        [[103, 14, 10], [107.9, 14, 10], [108, 14, 13.9], [113, 14, 14], [113, 14, 10.2], [116.5, 14, 10.2], [120.6, 14, 11.8]],
        [[103, 14, 10], [94, 14, -6], [92, 14, -8.2]],
        [[96, 7, -8.2], [96, 7, -5], [102, 7, -6], [102, 7, -10], [117, 7, -13], [119.5, 7, -13], [123, 7, -10.5]],
        [[96, 7, -5], [94, 7, -6], [92, 7, -8.2]],
        [[96, -14, -8.2], [92, -14, -8.2], [92, -14, -12], [86, -14, -12], [73, -14, -12.4], [6, -14, -12], [-4.4, -14, -4]],
        [[-4.4, -14, -4], [-18, -14, 10], [-21.85, -14, 12], [-21.85, -14, 15.6]],
        [[-21.85, 14, 12], [-12, 14, 4], [2.5, 14, -1.5]],
        [[-12.6, 0, -18.8], [-13.6, 0, -15.6], [-13.7, 0, -11]],
    ],
    2: [
        [[130, -44, -133], [130, -44, -138], [130, -44, -144.2], [104, -44, -144.2], [101, -44, -153], [94, -44, -153], [86, -44, -160], [86, -44, -168], [100, -44, -170], [173.5, -44, -171], [173.5, -44, -178], [172.8, -44, -183.2]],
        [[166, 30, -182], [157, 30, -181.5], [168, 30, -183], [178, 30, -190]],
        [[-115, 0, -94], [-115, 0, -98], [-115, 0, -103.4]],
        [[104, 0, -98], [116, 0, -110], [126, -10, -121], [130, -10, -125]],
        [[97, 0, 42.4], [106, 0, 42.4], [110, 0, 39.8], [136, 0, 39.8], [136, 0, 48]],
        [[63.5, 0, -44], [70, 0, -36], [56, 0, -30]],
        [[-120, 0, 12], [-120, 1.2, 24], [-113.6, 1.2, 44.2]],
        [[-63, 0, 34], [-63, 7, 76], [-90, 7, 76], [-110, 7, 76]],
    ],
};

/** Noctis's old streets: worn asphalt between the places that mattered, Ray's ways between them. */
export const NOCTIS_ROADS: Road[] = [
    // The spire road: the camp east to the Foundry's loading bay.
    { pts: [[2, 124], [22, 112], [40, 98], [60, 76], [84, 55], [98, 43]], width: 8 },
    // The highway road: the camp west to the broken highway's ramp and Gate Four's east steps.
    { pts: [[-4, 124], [-26, 112], [-46, 98], [-52, 78], [-52, 48], [-62, 32], [-84, 38]], width: 7 },
    // The canal road: off the spire road, south past the mesa to the quay.
    { pts: [[18, 108], [14, 70], [16, 30], [24, 0], [36, -26], [52, -38]], width: 7 },
    // The quarry road: the quay east, over the canal at the east crossing, down into the quarry.
    { pts: [[80, -40], [92, -46], [92, -72], [96, -88], [116, -110]], width: 7 },
    // The barge road: along the canal's north bank west, over the west crossing, to the pumphouse.
    { pts: [[52, -40], [20, -44], [-20, -43], [-55, -47], [-55, -74], [-80, -84], [-104, -92]], width: 7 },
    // The gate road: Gate Four's south steps down the west side, over the far crossing, to the pumphouse.
    { pts: [[-120, 13], [-124, -10], [-130, -40], [-150, -60], [-146, -76], [-128, -90]], width: 7 },
];

/** Points along a road every `step` meters (Catmull-Rom through its points), with its direction. */
export function roadSamples(r: Road, step = 2): { p: P2; d: P2; s: number }[] {
    const out: { p: P2; d: P2; s: number }[] = [];
    const P = r.pts;
    const at = (i: number) => P[Math.max(0, Math.min(P.length - 1, i))];
    let s = 0, last: P2 | null = null;
    for (let i = 0; i < P.length - 1; i++) {
        const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
        const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
        const n = Math.max(1, Math.ceil(len / step));
        for (let k = i === 0 ? 0 : 1; k <= n; k++) {
            const t = k / n, t2 = t * t, t3 = t2 * t;
            const c = (a: number, b: number, c_: number, d: number) => 0.5 * (2 * b + (-a + c_) * t + (2 * a - 5 * b + 4 * c_ - d) * t2 + (-a + 3 * b - 3 * c_ + d) * t3);
            const p: P2 = [c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])];
            if (last) s += Math.hypot(p[0] - last[0], p[1] - last[1]);
            out.push({ p, d: [0, 0], s });
            last = p;
        }
    }
    for (let i = 0; i < out.length; i++) {
        const a = out[Math.max(0, i - 1)].p, b = out[Math.min(out.length - 1, i + 1)].p;
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        out[i].d = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    }
    return out;
}

/** Distance from (x, z) to a polyline of samples (squared), via a coarse grid of their segments. */
class SegmentIndex {
    private grid = new Map<number, [P2, P2, number][]>();
    private static readonly G = 12;
    add(a: P2, b: P2, tag = 0): void {
        const G = SegmentIndex.G;
        for (let gx = Math.floor(Math.min(a[0], b[0]) / G) - 1; gx <= Math.floor(Math.max(a[0], b[0]) / G) + 1; gx++)
            for (let gz = Math.floor(Math.min(a[1], b[1]) / G) - 1; gz <= Math.floor(Math.max(a[1], b[1]) / G) + 1; gz++) {
                const k = gx * 100003 + gz;
                let l = this.grid.get(k);
                if (!l) this.grid.set(k, l = []);
                l.push([a, b, tag]);
            }
    }
    /** Nearest distance within ~12 m (Infinity beyond). */
    dist(x: number, z: number): number {
        const G = SegmentIndex.G;
        const l = this.grid.get(Math.floor(x / G) * 100003 + Math.floor(z / G));
        let best = Infinity;
        if (l) for (const [a, b] of l) best = Math.min(best, segDist(x, z, a, b));
        return best;
    }
}
function segDist(x: number, z: number, a: P2, b: P2): number {
    const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
    return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
}

// --- Placing -------------------------------------------------------------------------------------

interface Aabb { min: V3; max: V3 }
interface Keep { x: number; y: number; z: number; r: number; soft: boolean }

/** Finds floors, keeps clear of everything that matters, and records what it adds. */
class Placer {
    readonly added: Prop[] = [];
    private solids = new Map<number, Aabb[]>();
    private floors = new Map<number, Aabb[]>();
    private keeps: Keep[] = [];
    private routes = new SegmentIndex();
    /** Route corridors with their height (the Spire's floors stack; a route only guards its own). */
    private routeY: { a: V3; b: V3 }[] = [];
    readonly roads = new SegmentIndex();
    private static readonly G = 4;
    private spacing: { x: number; z: number; y: number; r: number }[] = [];

    constructor(readonly level: Level) {
        for (const b of level.boxes) if (b.solid) this.index(b);
        for (const p of level.props) if (p.collide) this.index(propBox(p));
        for (const u of level.uses) this.keep(u.pos, 2.6, false);
        for (const i of level.items) this.keep(i.pos, 1.6, false);
        for (const c of level.pickups) this.keep(c.pos, 1.6, false);
        for (const c of level.checkpoints) this.keep(c.pos, c.radius + 1.5, true);
        for (const d of level.doors) this.keep([(d.min[0] + d.max[0]) / 2, d.min[1], (d.min[2] + d.max[2]) / 2], 3.5, true);
        for (const e of level.enemies) {
            this.keep(e.pos, 2.2, true);
            for (let i = 0; i < e.patrol.length; i++) this.route(e.patrol[i], e.patrol[(i + 1) % e.patrol.length]);
        }
        for (const path of ROUTES[level.mission] ?? []) for (let i = 0; i + 1 < path.length; i++) this.route(path[i], path[i + 1]);
        for (const r of level.roads ?? []) {
            const s = roadSamples(r, 4);
            for (let i = 0; i + 1 < s.length; i++) this.roads.add(s[i].p, s[i + 1].p);
        }
    }

    private index(b: Aabb): void {
        const G = Placer.G;
        // Wide, thin, flat-topped solids are floors too (slabs, plazas, decks).
        const floor = b.max[0] - b.min[0] > 0.9 && b.max[2] - b.min[2] > 0.9;
        for (let gx = Math.floor(b.min[0] / G); gx <= Math.floor(b.max[0] / G); gx++)
            for (let gz = Math.floor(b.min[2] / G); gz <= Math.floor(b.max[2] / G); gz++) {
                const k = gx * 100003 + gz;
                let l = this.solids.get(k);
                if (!l) this.solids.set(k, l = []);
                l.push(b);
                if (floor) { let f = this.floors.get(k); if (!f) this.floors.set(k, f = []); f.push(b); }
            }
    }
    keep(p: V3, r: number, soft: boolean): void { this.keeps.push({ x: p[0], y: p[1], z: p[2], r, soft }); }
    route(a: V3, b: V3): void { this.routes.add([a[0], a[2]], [b[0], b[2]], this.routeY.length); this.routeY.push({ a, b }); }

    /** The floor under (x, z) near height y: a solid's top, else the terrain. Null if there's none. */
    ground(x: number, z: number, y?: number): number | null {
        const G = Placer.G;
        let best = -Infinity;
        const l = this.floors.get(Math.floor(x / G) * 100003 + Math.floor(z / G));
        const T = this.level.terrain;
        const th = T ? T.height(x, z) : -Infinity;
        const lo = y !== undefined ? y - 0.45 : th - 0.3, hi = y !== undefined ? y + 0.35 : th + 2.5;
        if (l) for (const b of l) {
            if (x < b.min[0] || x > b.max[0] || z < b.min[2] || z > b.max[2]) continue;
            if (b.max[1] >= lo && b.max[1] <= hi) best = Math.max(best, b.max[1]);
        }
        if (best > -Infinity) return best;
        if (T && (y === undefined || Math.abs(th - y) < 0.5)) return th;
        return null;
    }

    /** Every floor top (solids, the terrain) under (x, z) between lo and hi. */
    floorsAt(x: number, z: number, lo: number, hi: number): number[] {
        const out: number[] = [];
        const l = this.floors.get(Math.floor(x / Placer.G) * 100003 + Math.floor(z / Placer.G));
        if (l) for (const b of l) if (x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2] && b.max[1] >= lo && b.max[1] <= hi && !out.some(y => Math.abs(y - b.max[1]) < 0.3)) out.push(b.max[1]);
        const T = this.level.terrain;
        if (T) { const h = T.height(x, z); if (h >= lo && h <= hi && !out.some(y => Math.abs(y - h) < 0.3)) out.push(h); }
        return out;
    }

    /** Takes up a box (something hung on a wall: not solid in the game, but nothing else goes there). */
    block(min: V3, max: V3): void { this.index({ min, max }); }

    /** Whether the box is clear of every solid. */
    clear(min: V3, max: V3): boolean {
        const G = Placer.G;
        for (let gx = Math.floor(min[0] / G); gx <= Math.floor(max[0] / G); gx++)
            for (let gz = Math.floor(min[2] / G); gz <= Math.floor(max[2] / G); gz++) {
                const l = this.solids.get(gx * 100003 + gz);
                if (l) for (const b of l) if (min[0] < b.max[0] && max[0] > b.min[0] && min[1] < b.max[1] && max[1] > b.min[1] && min[2] < b.max[2] && max[2] > b.min[2]) return false;
            }
        return true;
    }

    /**
     * Whether a prop of radius r at p stays off the spots, routes and patrols (soft ones only bind
     * solids, and not what stands flat against a wall).
     */
    allowed(p: V3, r: number, solid: boolean, onWall = false): boolean {
        for (const k of this.keeps) {
            if ((!solid || onWall) && k.soft) continue;
            if (Math.abs(k.y - p[1]) < 4 && Math.hypot(k.x - p[0], k.z - p[2]) < k.r + r) return false;
        }
        if (solid && this.routes.dist(p[0], p[2]) < r + 1.9) {
            // A route on another floor doesn't count: check the nearest segments' heights.
            for (const { a, b } of this.routeY) {
                if (segDist(p[0], p[2], [a[0], a[2]], [b[0], b[2]]) >= r + 1.9) continue;
                if (p[1] > Math.min(a[1], b[1]) - 2.5 && p[1] < Math.max(a[1], b[1]) + 2.5) return false;
            }
        }
        return true;
    }

    /** Keeps props of a kind apart (and anything from sitting inside another). */
    spaced(p: V3, r: number): boolean {
        for (const s of this.spacing) if (Math.abs(s.y - p[1]) < 3 && Math.hypot(s.x - p[0], s.z - p[2]) < s.r + r) return false;
        return true;
    }

    /**
     * Places a kit piece at (x, z) on the floor near y (or the terrain), if it fits: on level ground
     * (settled to its lowest corner), clear of solids if it collides, off every route and spot.
     */
    put(model: KitModel, x: number, z: number, yaw: number, size: number, o: { y?: number; tilt?: [number, number]; gap?: number; noCollide?: boolean; maxSlope?: number; tint?: V3 } = {}): Prop | null {
        const k = KIT[model];
        const box = o.noCollide ? undefined : kitBox(model);
        const fx = box ? box[0] * size : size * 0.2, fz = box ? box[2] * size : size * 0.2;
        const r = Math.max(fx, fz);
        const y0 = this.ground(x, z, o.y);
        if (y0 === null) return null;
        // Level enough: the footprint's corners (the prop sinks to the lowest).
        const c = Math.cos(yaw), s = Math.sin(yaw);
        let lo = y0, hi = y0;
        for (const [ax, az] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0]]) {
            const px = x + c * ax * fx + s * az * fz, pz = z - s * ax * fx + c * az * fz;
            const g = this.ground(px, pz, o.y);
            if (g === null) return null;
            lo = Math.min(lo, g); hi = Math.max(hi, g);
        }
        if (hi - lo > (o.maxSlope ?? Math.max(0.35, size * 0.12))) return null;
        const pos: V3 = [x, lo, z];
        if (!this.spaced(pos, (o.gap ?? 0.6) + r * 0.8)) return null;
        if (!this.allowed(pos, r, !!box)) return null;
        let collide: V3 | undefined;
        if (box) {
            // Boxes stay axis-aligned (te_game.ts propBoxes snaps to quarter turns): off a quarter
            // turn, a long piece keeps only its core.
            const q = Math.abs(((yaw / (Math.PI / 2)) % 1 + 1.5) % 1 - 0.5);
            const hx = box[0] * size, hy = box[1] * size, hz = box[2] * size;
            collide = q > 0.15 ? [Math.min(hx, hz), hy, Math.min(hx, hz)] : [hx, hy, hz];
            const quarter = Math.round(yaw / (Math.PI / 2)) % 2 !== 0;
            const ex = quarter ? collide[2] : collide[0], ez = quarter ? collide[0] : collide[2];
            const min: V3 = [x - ex, lo + 0.08, z - ez], max: V3 = [x + ex, lo + collide[1] * 2, z + ez];
            if (!this.clear(min, max)) return null;
            this.index({ min, max });
        }
        const p: Prop = { model, pos, yaw, size, collide, sink: k.sink, tilt: o.tilt, cull: k.cull, noShadow: k.shadow === false, tint: o.tint, kit: true };
        this.added.push(p);
        this.spacing.push({ x, z, y: lo, r: r * 0.8 });
        return p;
    }

    /** Whether something solid stands within d of (x, y, z), at least h tall: a wall or column to lean on. */
    against(x: number, y: number, z: number, d: number, h = 1.4): [number, number] | null {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as P2[]) {
            const px = x + dx * d, pz = z + dz * d;
            if (!this.clear([px - 0.1, y + 0.3, pz - 0.1], [px + 0.1, y + h, pz + 0.1])) return [dx, dz];
        }
        return null;
    }
}

function propBox(p: Prop): Aabb {
    const h = p.collide!;
    const quarter = Math.round(p.yaw / (Math.PI / 2)) % 2 !== 0;
    const hx = quarter ? h[2] : h[0], hz = quarter ? h[0] : h[2];
    return { min: [p.pos[0] - hx, p.pos[1] - (p.sink ?? 0), p.pos[2] - hz], max: [p.pos[0] + hx, p.pos[1] + h[1] * 2 - (p.sink ?? 0), p.pos[2] + hz] };
}

/** A deterministic stream of numbers in 0..1. */
function stream(seed: number): () => number {
    let i = 0;
    return () => hash(seed, i++ * 1.618, seed * 0.37 + i * 0.011);
}
const pick = <T>(r: () => number, a: readonly T[]): T => a[Math.min(a.length - 1, Math.floor(r() * a.length))];
const between = (r: () => number, [a, b]: [number, number]) => a + (b - a) * r();

// --- The Spire ----------------------------------------------------------------------------------------

function dressSpire(P: Placer): void {
    const r = stream(11);
    const L = P.level;
    // The floors: the tower's three, the reactor floor, the relay's.
    const floors: { y: number; x0: number; x1: number; z0: number; z1: number; kind: "office" | "machine" }[] = [
        { y: 0, x0: -23.5, x1: 22, z0: -23.5, z1: 23.5, kind: "office" },
        { y: 7, x0: -23.5, x1: 22, z0: -23.5, z1: 23.5, kind: "office" },
        { y: 14, x0: -23.5, x1: 22, z0: -23.5, z1: 23.5, kind: "office" },
        { y: -14, x0: -23.5, x1: 14, z0: -23.5, z1: 23.5, kind: "machine" },
        { y: 14, x0: 90.5, x1: 125.5, z0: -17.5, z1: 17.5, kind: "office" },
        { y: 7, x0: 90.5, x1: 125.5, z0: -17.5, z1: 17.5, kind: "machine" },
    ];
    for (const f of floors) {
        const cells: P2[] = [];
        for (let x = f.x0; x <= f.x1; x += 1.1) for (let z = f.z0; z <= f.z1; z += 1.1) cells.push([x + (hash(x, z, 3) - 0.5) * 0.6, z + (hash(z, x, 5) - 0.5) * 0.6]);
        cells.sort((a, b) => hash(a[0], a[1], f.y) - hash(b[0], b[1], f.y));
        for (const [x, z] of cells) {
            const g = P.ground(x, z, f.y);
            if (g === null || Math.abs(g - f.y) > 0.3) continue;
            const open = L.open(x, f.y + 1, z);
            // At the blast edge: no floor a few meters on, lots of sky.
            const edge = P.ground(x + 3, z, f.y) === null || P.ground(x + 2, z + 2, f.y) === null || P.ground(x + 2, z - 2, f.y) === null;
            const wall = P.against(x, f.y, z, 1.2);
            const u = r();
            if (edge && open > 0.55) {
                if (u < 0.1) P.put(pick(r, ["concrete_slab", "concrete_slab", "scrap_sheets"] as const), x, z, r() * 6.28, between(r, [2.2, 3.6]), { y: f.y, tilt: [(r() - 0.5) * 0.2, (r() - 0.5) * 0.2] });
                else if (u < 0.15) P.put(pick(r, ["succulents", "fungus_cluster", "mars_shrub"] as const), x, z, r() * 6.28, between(r, [0.7, 1.4]), { y: f.y });
                continue;
            }
            if (wall) {
                const yaw = Math.atan2(-wall[0], -wall[1]) + (r() - 0.5) * 0.3;
                // Leave a passage: nothing solid within 2.2 m out from the wall.
                const ox = x - wall[0] * 2.2, oz = z - wall[1] * 2.2;
                if (!P.clear([ox - 0.6, f.y + 0.3, oz - 0.6], [ox + 0.6, f.y + 1.8, oz + 0.6])) continue;
                if (u < 0.1) {
                    const m = f.kind === "office" ? pick(r, ["office_wreck", "office_wreck", "office_wreck", "vending_machine", "duct_section", "scrap_sheets", "cable_spool", "barrels"] as const)
                        : pick(r, ["barrels", "cable_spool", "pipe_section", "engine_block", "scrap_sheets", "duct_section"] as const);
                    const size = m === "pipe_section" ? between(r, [2.6, 3.4]) : between(r, KIT[m].size);
                    P.put(m, x - wall[0] * 0.2, z - wall[1] * 0.2, yaw, size, { y: f.y });
                } else if (u < 0.13) P.put("trash_pile", x, z, r() * 6.28, between(r, [1.2, 2]), { y: f.y, gap: 2.5 });
                continue;
            }
            // Out on the floor: what fell from the ceiling, and litter.
            if (u < 0.008) P.put(pick(r, ["duct_section", "concrete_slab", "scrap_sheets"] as const), x, z, r() * 6.28, between(r, [2, 3.2]), { y: f.y, tilt: [(r() - 0.5) * 0.3, (r() - 0.5) * 0.3] });
            else if (u < 0.014) P.put("trash_pile", x, z, r() * 6.28, between(r, [1.2, 2]), { y: f.y });
        }
    }
}

// --- Walls: hung on them and stood against them, both missions -----------------------------------------

/** What goes on a wall, by the room in front of it. */
const WALL_MIX: Record<"lab" | "office" | "machine" | "outside", WallModel[]> = {
    lab: ["bookcase", "bookcase", "chalkboard", "metal_shelf", "notice_board", "wall_screens", "caged_lamp", "wall_pipes", "breaker_panel", "radiator"],
    office: ["lockers", "metal_shelf", "notice_board", "torn_posters", "torn_posters", "fire_cabinet", "wall_screens", "breaker_panel", "radiator", "caged_lamp", "wall_vent", "wall_cables"],
    machine: ["wall_pipes", "wall_pipes", "breaker_panel", "wall_cables", "wall_vent", "caged_lamp", "lockers", "metal_shelf", "fire_cabinet", "torn_posters"],
    outside: ["torn_posters", "torn_posters", "ac_unit", "wall_pipes", "wall_cables", "breaker_panel", "wall_vent", "caged_lamp"],
};
type WallRoom = keyof typeof WALL_MIX;
/** How often a stretch of wall gets something (the Doctor's lab is full; outside, a lot is bare). */
const WALL_DENSITY: Record<WallRoom, number> = { lab: 0.95, office: 0.62, machine: 0.62, outside: 0.55 };
/** The passage kept in front of what stands against a wall (the lab is small and Ray knows it). */
const WALL_PASSAGE: Record<WallRoom, number> = { lab: 1.3, office: 2.2, machine: 2.2, outside: 2.2 };
/** Outside, on buildings' faces: bigger posters and runs, and higher up, the units and lamps of the floors above. */
const OUTSIDE_SCALE: Partial<Record<WallModel, number>> = { torn_posters: 1.7, wall_pipes: 1.3, wall_cables: 1.3 };
const UPPER: WallModel[] = ["ac_unit", "ac_unit", "wall_vent", "caged_lamp", "wall_cables", "wall_pipes", "torn_posters"];

/** Half extents (x, y, z) of a kit model at a size: the GLB's bounds (te_kit_bounds.ts holds 0.8 of them). */
function extents(model: KitModel, size: number): V3 {
    const b = KIT_BOUNDS[model] ?? [0.4, 0.4, 0.4];
    return [b[0] / 0.8 * size, b[1] / 0.8 * size, b[2] / 0.8 * size];
}

/**
 * Walks every face of every tall wall and column, on each floor in front of it, and hangs or stands
 * the wall kit along it: pieces from the room's mix with gaps between (a bare stretch now and then),
 * only where the whole piece fits on the face, clear of everything, over floor. Hung pieces don't
 * collide; stood ones do and keep a passage in front.
 */
function dressWalls(P: Placer, room: (x: number, y: number, z: number) => WallRoom | null): void {
    const L = P.level;
    const placed = new Map<WallModel, V3[]>();
    // What's drawn on a face without being solid (pilasters, plinths, blacked-out windows) is in the way too.
    const deco = L.boxes.filter(b => b.draw && !b.solid);
    const hits = (l: Aabb[], min: V3, max: V3) => l.some(d => min[0] < d.max[0] && max[0] > d.min[0] && min[1] < d.max[1] && max[1] > d.min[1] && min[2] < d.max[2] && max[2] > d.min[2]);
    for (const [bi, b] of L.boxes.entries()) {
        if (!b.solid || !b.draw || b.max[1] - b.min[1] < 2.6) continue;
        for (const [ax, side] of [[0, 1], [0, -1], [2, 1], [2, -1]] as [0 | 2, number][]) {
            const ta = ax === 0 ? 2 : 0;
            const plane = side > 0 ? b.max[ax] : b.min[ax];
            const t0 = b.min[ta], t1 = b.max[ta];
            if (t1 - t0 < 0.5) continue;
            // Facing out of the face (models face +z at yaw 0).
            const yaw = Math.atan2(ax === 0 ? side : 0, ax === 2 ? side : 0);
            // A point d out from the face, t along it.
            const at = (t: number, d: number): P2 => ax === 0 ? [plane + side * d, t] : [t, plane + side * d];
            const [mx, mz] = at((t0 + t1) / 2, 0.6);
            const f0 = at(t0, 0), f1 = at(t1, 1.2);
            const near = deco.filter(d => d !== b && hits([d], [Math.min(f0[0], f1[0]), b.min[1], Math.min(f0[1], f1[1])], [Math.max(f0[0], f1[0]), b.max[1], Math.max(f0[1], f1[1])]));
            for (const fy of P.floorsAt(mx, mz, b.min[1] - 0.4, b.max[1] - 2.6)) {
                const kind = room(mx, fy, mz);
                if (!kind) continue;
                const r = stream(bi * 7.31 + ax * 3 + side + fy * 0.13);
                let c = t0 + 0.15 + r() * 0.8;
                // A piece at c along the face (lift meters up a storey), if the whole of it fits and no
                // other of its kind is close: its width, or 0.
                const fit = (m: WallModel, lift = 0): number => {
                    const k = KIT[m], w = k.wall!;
                    if (lift && !w.at) return 0;
                    const size = between(r, k.size) * (kind === "outside" ? OUTSIDE_SCALE[m] ?? 1 : 1);
                    const [hx, hy, hz] = extents(m, size);
                    const width = hx * 2;
                    if (c + width > t1 - 0.1) return 0;
                    const tm = c + hx;
                    const foot = fy + lift + (w.at ? between(r, w.at) : 0);
                    const [cx, cz] = at(tm, 0);
                    if (w.apart && (placed.get(m) ?? []).some(q => Math.abs(q[1] - foot) < 2 && Math.hypot(q[0] - cx, q[2] - cz) < w.apart!)) return 0;
                    // Clear where the piece goes (just off the face)...
                    const n0 = at(c, 0.03), n1 = at(c + width, hz * 2 + 0.08);
                    const min: V3 = [Math.min(n0[0], n1[0]), foot + 0.02, Math.min(n0[1], n1[1])], max: V3 = [Math.max(n0[0], n1[0]), foot + hy * 2, Math.max(n0[1], n1[1])];
                    // ...room to see it from (not a crack between a wall and a column)...
                    const e0 = at(c + 0.1, 1), e1 = at(c + width - 0.1, 1.1);
                    const see0: V3 = [Math.min(e0[0], e1[0]), fy + 0.4, Math.min(e0[1], e1[1])], see1: V3 = [Math.max(e0[0], e1[0]), fy + 1.8, Math.max(e0[1], e1[1])];
                    // ...and this floor under both ends.
                    const g0 = at(c + 0.1, 0.4), g1 = at(c + width - 0.1, 0.4);
                    const floored = [g0, g1].every(([gx, gz]) => { const g = P.ground(gx, gz, fy); return g !== null && Math.abs(g - fy) < 0.2; });
                    if (!floored || !P.clear(min, max) || !P.clear(see0, see1)) return 0;
                    // Nothing drawn over it, out to where it'd be seen past.
                    const o1 = at(c + width, 1);
                    if (near.length && hits(near, [Math.min(n0[0], o1[0]), min[1], Math.min(n0[1], o1[1])], [Math.max(n0[0], o1[0]), max[1], Math.max(n0[1], o1[1])])) return 0;
                    const [px, pz] = at(tm, hz + 0.02);
                    const pos: V3 = [px, foot, pz];
                    const solid = !w.at;
                    let collide: V3 | undefined;
                    if (solid) {
                        // Leave a passage: nothing solid close in front of it.
                        const [ox, oz] = at(tm, hz * 2 + WALL_PASSAGE[kind]);
                        if (!P.allowed(pos, Math.max(hx, hz), true, true) || !P.clear([ox - 0.6, fy + 0.3, oz - 0.6], [ox + 0.6, fy + 1.8, oz + 0.6])) return 0;
                        const kb = kitBox(m)!;
                        collide = [kb[0] * size, kb[1] * size, kb[2] * size];
                    } else if (!P.allowed(pos, 0.3, false)) return 0;
                    P.block(min, max);
                    P.added.push({ model: m, pos, yaw: yaw + (w.flip ? Math.PI : 0), size, collide, cull: k.cull, noShadow: !solid, ground: fy, glow: w.glow, kit: true });
                    if (!placed.has(m)) placed.set(m, []);
                    placed.get(m)!.push([cx, foot, cz]);
                    return width;
                };
                while (c < t1 - 0.4) {
                    if (r() > WALL_DENSITY[kind]) { c += 1 + r() * 2.5; continue; }
                    // A few tries at each spot (a bookcase won't fit where a lamp will).
                    let width = 0;
                    for (let i = 0; i < 4 && !width; i++) width = fit(pick(r, WALL_MIX[kind]));
                    c += width ? width + 0.25 + r() * 1.6 : 0.6;
                }
                // Tall outside faces: a band higher up, a storey (or two) over the street.
                if (kind === "outside") for (let lift = 4; lift + 3 < b.max[1] - fy; lift += 4.5) {
                    c = t0 + 0.4 + r() * 2;
                    while (c < t1 - 0.4) {
                        if (r() > 0.3) { c += 2 + r() * 4; continue; }
                        const width = fit(pick(r, UPPER), lift);
                        c += width ? width + 1 + r() * 4 : 1;
                    }
                }
            }
        }
    }
}

/** The Spire's rooms: the Doctor's lab, the machine floors (the reactor's, the relay's lower), and offices. */
function spireRoom(x: number, y: number, z: number): WallRoom | null {
    if (y > 20 || y < -15) return null;
    if (Math.abs(y) < 0.5 && x < -7.5 && z < -9.5) return "lab";
    if (Math.abs(y + 14) < 0.5 || (x > 80 && Math.abs(y - 7) < 0.5)) return "machine";
    return "office";
}

/** Noctis: the buildings' outsides; under a roof (the pumphouse, the Foundry, the Undercroft), machine rooms. */
function noctisRoom(P: Placer): (x: number, y: number, z: number) => WallRoom | null {
    return (x, y, z) => P.clear([x - 0.2, y + 3.2, z - 0.2], [x + 0.2, y + 40, z + 0.2]) ? "outside" : "machine";
}

// --- Noctis -----------------------------------------------------------------------------------------

/** Places where people live or lived: junk heaps round them, in their own mixes. */
const NOCTIS_YARDS: { c: P2; r: number; y?: number; n: number; mix: KitModel[]; inside?: boolean }[] = [
    { c: [2, 146], r: 20, n: 16, mix: ["barrels", "cable_spool", "engine_block", "scrap_sheets", "trash_pile", "barricade", "cargo_container"] },
    { c: [94, 30], r: 14, n: 10, mix: ["cargo_container", "barrels", "dumpster", "pipe_section", "cable_spool", "engine_block"] },
    { c: [152, 44], r: 10, n: 7, mix: ["barrels", "dumpster", "pipe_section", "scrap_sheets", "trash_pile"] },
    { c: [126, 68], r: 12, n: 8, mix: ["concrete_slab", "concrete_slab", "pipe_section", "scrap_sheets", "trash_pile"] },
    { c: [68, -36], r: 16, n: 12, mix: ["cargo_container", "cargo_container", "barrels", "cable_spool", "pipe_section", "trash_pile"] },
    { c: [-115, -106], r: 28, n: 16, mix: ["barricade", "barricade", "dumpster", "barrels", "scrap_sheets", "trash_pile", "car_wreck"] },
    { c: [130, -108], r: 30, n: 20, mix: ["barrels", "scrap_sheets", "engine_block", "cargo_container", "car_wreck", "trash_pile", "cable_spool", "barricade"] },
    { c: [-120, 50], r: 30, n: 14, mix: ["concrete_slab", "street_lamp", "vending_machine", "trash_pile", "scrap_sheets"], inside: true },
    { c: [172, -190], r: 22, y: 30, n: 12, mix: ["barrels", "scrap_sheets", "barricade", "trash_pile", "engine_block", "cable_spool"] },
];

function dressNoctis(P: Placer): void {
    const L = P.level;
    const T = L.terrain!;
    const r = stream(23);
    const sites = (x: number, z: number, m = 0) =>
        (x > 98 - m && x < 154 + m && z > 20 - m && z < 76 + m) || (x > -158 - m && x < -82 + m && z > 12 - m && z < 88 + m) ||
        (x > -122 - m && x < -108 + m && z > -112 - m && z < -100 + m) || Math.hypot(x - 130, z + 125) < 23 + m || (x > -12 - m && x < 50 + m && z > -70 - m && z < -50 + m);
    const level = (x: number, z: number) => T.height(x, z) < 8 && T.height(x, z) > -12;

    // The streets: their furniture, wrecks and litter, ruins set back along them.
    (L.roads ?? []).forEach((road, ri) => {
        const S = roadSamples(road, 1);
        const half = road.width / 2;
        const side = (s: (typeof S)[number], off: number): P2 => [s.p[0] - s.d[1] * off, s.p[1] + s.d[0] * off];
        const yawAlong = (s: (typeof S)[number]) => Math.atan2(s.d[0], s.d[1]);
        let nextLamp = 8 + ri * 5, nextPole = 20, nextJunk = 6, nextWreck = 30 + ri * 9, nextRail = 40, nextRuin = 18 + ri * 11, nextBoard = 70 + ri * 23;
        const ruin = (s: (typeof S)[number]) => {
            // A building set back from the street, its front to it (either side, a few setbacks).
            const big = r() < 0.45, m: KitModel = big ? "ruined_building" : "ruined_storefront";
            const size = between(r, KIT[m].size), first = r() < 0.5 ? -1 : 1;
            for (let k = 0; k < 6; k++) {
                const sd = k % 2 ? -first : first;
                const [x, z] = side(s, sd * (half + size * (big ? 0.42 : 0.4) + 3 + Math.floor(k / 2) * 5));
                if (!level(x, z) || sites(x, z, 8) || P.roads.dist(x, z) < half + 2) continue;
                if (!P.put(m, x, z, yawAlong(s) + (sd > 0 ? Math.PI / 2 : -Math.PI / 2) + (r() - 0.5) * 0.15, size, { maxSlope: size * 0.25, gap: 4 })) continue;
                // Rubble at its feet.
                for (let j = 0; j < 4; j++) {
                    const a = r() * 6.28, d = size * (0.35 + r() * 0.25);
                    P.put(r() < 0.6 ? "concrete_slab" : "scrap_sheets", x + Math.cos(a) * d, z + Math.sin(a) * d, r() * 6.28, between(r, [2.4, 4.5]), { tilt: [(r() - 0.5) * 0.25, (r() - 0.5) * 0.25] });
                }
                nextRuin = s.s + 38 + r() * 30;
                return;
            }
            nextRuin = s.s + 4;
        };
        const board = (s: (typeof S)[number]) => {
            const sd = r() < 0.5 ? -1 : 1;
            const m: KitModel = r() < 0.6 ? "billboard" : "transit_shelter";
            const [x, z] = m === "transit_shelter" ? side(s, sd * (half + 2.6)) : side(s, sd * (half + 9 + r() * 5));
            if (!sites(x, z) && P.put(m, x, z, yawAlong(s) + (sd > 0 ? -Math.PI / 2 : Math.PI / 2) + (m === "billboard" ? (r() - 0.5) * 0.6 : 0), between(r, KIT[m].size), { maxSlope: 1.6 })) nextBoard = s.s + 110 + r() * 70;
            else nextBoard = s.s + 8;
        };
        // Two passes: the big pieces set back from the street first, then the street's own furniture.
        for (const phase of [0, 1]) for (const s of S) {
            const lr = Math.floor(s.s / 26) % 2 ? 1 : -1;
            if (phase === 0) {
                if (s.s >= nextRuin) ruin(s);
                if (s.s >= nextBoard) board(s);
                continue;
            }
            if (s.s >= nextLamp) {
                const [x, z] = side(s, lr * (half + 0.8));
                const fallen = r() < 0.18;
                if (P.put("street_lamp", x, z, yawAlong(s) + (lr > 0 ? 0 : Math.PI), between(r, KIT.street_lamp.size), fallen ? { tilt: [1.45 * (r() < 0.5 ? 1 : -1), 0], noCollide: true, maxSlope: 1 } : { tilt: [(r() - 0.5) * 0.25, (r() - 0.5) * 0.25] }))
                    nextLamp = s.s + 22 + r() * 10;
            }
            if (ri < 3 && s.s >= nextPole) {
                const [x, z] = side(s, -lr * (half + 2.5));
                if (P.put("utility_pole", x, z, yawAlong(s), between(r, KIT.utility_pole.size), { tilt: [(r() - 0.5) * 0.3, (r() - 0.5) * 0.2] })) nextPole = s.s + 36 + r() * 8;
            }
            if (s.s >= nextJunk) {
                const u = r(), [x, z] = side(s, (r() < 0.5 ? -1 : 1) * (half - 0.5 + r() * 2.5));
                const m: KitModel = u < 0.45 ? "trash_pile" : u < 0.6 ? "road_barrier" : u < 0.72 ? "concrete_slab" : u < 0.82 ? "street_sign" : u < 0.9 ? "barrels" : "scrap_sheets";
                const size = m === "concrete_slab" ? between(r, [2, 3.5]) : between(r, KIT[m].size);
                const tilt: [number, number] | undefined = m === "street_sign" ? [(r() - 0.5) * 0.5, (r() - 0.5) * 0.4] : undefined;
                if (P.put(m, x, z, yawAlong(s) + (r() - 0.5) * 1.2, size, { tilt })) nextJunk = s.s + 9 + r() * 12;
                else nextJunk = s.s + 2;
            }
            if (s.s >= nextWreck) {
                const m: KitModel = r() < 0.75 ? "car_wreck" : "truck_wreck";
                const [x, z] = side(s, (r() < 0.5 ? -1 : 1) * (half + (m === "truck_wreck" ? 3.5 : 1.8)));
                if (P.put(m, x, z, yawAlong(s) + Math.PI / 2 + (r() - 0.5) * 0.9, between(r, KIT[m].size), { maxSlope: m === "truck_wreck" ? 1.6 : 0.9 })) nextWreck = s.s + 55 + r() * 40;
                else nextWreck = s.s + 4;
            }
            if (s.s >= nextRail) {
                // A run of bent guard rail along one side.
                const n = 2 + Math.floor(r() * 3), sd = r() < 0.5 ? -1 : 1;
                for (let k = 0; k < n; k++) {
                    const t = S[Math.min(S.length - 1, Math.round(s.s + k * 6.2) - Math.round(S[0].s))];
                    if (!t) break;
                    const [x, z] = side(t, sd * (half + 0.6));
                    P.put("guard_rail", x, z, yawAlong(t) + Math.PI / 2 + (r() - 0.5) * 0.12, between(r, [5.8, 6.4]), { tilt: [(r() - 0.5) * 0.12, (r() - 0.5) * 0.15], maxSlope: 0.9 });
                }
                nextRail = s.s + 70 + r() * 50;
            }
        }
        // A sign at each end.
        for (const s of [S[0], S[S.length - 1]]) {
            const [x, z] = side(s, half + 1.4);
            P.put("street_sign", x, z, yawAlong(s), between(r, KIT.street_sign.size), { tilt: [(r() - 0.5) * 0.3, (r() - 0.5) * 0.3] });
        }
    });

    // More blocks between the streets: ruins within a block or two of a road, fronts toward it.
    const along = (L.roads ?? []).flatMap(rd => roadSamples(rd, 4).map(s => s.p));
    for (let gx = -165; gx <= 165; gx += 24) for (let gz = -165; gz <= 165; gz += 24) {
        const x = gx + (r() - 0.5) * 14, z = gz + (r() - 0.5) * 14;
        let best = Infinity, near: P2 = [x, z];
        for (const p of along) { const d = Math.hypot(p[0] - x, p[1] - z); if (d < best) { best = d; near = p; } }
        if (best < 16 || best > 46 || !level(x, z) || sites(x, z, 10)) continue;
        const big = r() < 0.5, m: KitModel = big ? "ruined_building" : "ruined_storefront", size = between(r, KIT[m].size);
        const yaw = Math.atan2(near[0] - x, near[1] - z) + (r() - 0.5) * 0.3;
        if (P.put(m, x, z, yaw, size, { maxSlope: size * 0.25, gap: 3 })) for (let j = 0; j < 3; j++) {
            const a = r() * 6.28, d = size * (0.38 + r() * 0.25);
            P.put(r() < 0.6 ? "concrete_slab" : "pipe_section", x + Math.cos(a) * d, z + Math.sin(a) * d, r() * 6.28, between(r, [2.4, 5]), { tilt: [(r() - 0.5) * 0.25, (r() - 0.5) * 0.25] });
        }
    }

    // The yards.
    for (const y of NOCTIS_YARDS) {
        let placed = 0;
        for (let tries = 0; tries < y.n * 14 && placed < y.n; tries++) {
            const a = r() * 6.28, d = Math.sqrt(r()) * y.r;
            const x = y.c[0] + Math.cos(a) * d, z = y.c[1] + Math.sin(a) * d;
            if (y.y === undefined && !y.inside && sites(x, z, 1)) continue;
            const m = pick(r, y.mix);
            const size = m === "concrete_slab" ? between(r, [2.4, 4.5]) : m === "pipe_section" ? between(r, [3.5, 6]) : between(r, KIT[m].size);
            if (P.put(m, x, z, r() * 6.28, size, { y: y.y, maxSlope: m === "cargo_container" ? 1.8 : undefined })) placed++;
        }
    }
    // Stacked containers on the quay.
    for (const [x, z, yaw] of [[60, -46, 0.05], [76, -46.4, -0.04]] as number[][]) {
        const c = P.put("cargo_container", x, z, yaw, 6.6);
        if (c) L.props.push({ ...c, pos: [c.pos[0] + 0.3, c.pos[1] + 6.6 * 0.38, c.pos[2] + 0.1], yaw: yaw + 0.08, collide: undefined, kit: true });
    }

    // Rubble fields and pipes in the open, between the streets.
    for (let i = 0; i < 260; i++) {
        const x = (r() - 0.5) * 330, z = (r() - 0.5) * 330;
        if (!level(x, z) || sites(x, z, 4) || P.roads.dist(x, z) < 6) continue;
        const u = r();
        const m: KitModel = u < 0.35 ? "concrete_slab" : u < 0.55 ? "pipe_section" : u < 0.7 ? "scrap_sheets" : u < 0.85 ? "trash_pile" : u < 0.93 ? "engine_block" : "car_wreck";
        const size = m === "concrete_slab" ? between(r, [3, 7]) : m === "pipe_section" ? between(r, [4, 9]) : between(r, KIT[m].size);
        P.put(m, x, z, r() * 6.28, size, { tilt: m === "concrete_slab" ? [(r() - 0.5) * 0.3, (r() - 0.5) * 0.3] : undefined, maxSlope: 1 });
    }

    // Overpass spans: what's left of the elevated road over the canal flats.
    for (const [x, z, yaw] of [[-30, -18, 0.3], [62, 22, -0.5], [-92, -52, 1.2]] as number[][]) P.put("overpass_span", x, z, yaw, between(r, KIT.overpass_span.size), { maxSlope: 7, gap: 4 });

    // The power line across the north flats, and one down the east side.
    for (const [a, b] of [[[-168, 150], [-10, 98]], [[30, 160], [168, 20]]] as [P2, P2][]) {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.round(len / 52);
        const yaw = Math.atan2(b[0] - a[0], b[1] - a[1]) + Math.PI / 2;
        for (let i = 0; i <= n; i++) {
            const t = i / n, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
            for (const j of [0, 6, -6, 12]) if (P.put("power_pylon", x + j * 0.7, z + j * 0.7, yaw + (r() - 0.5) * 0.1, between(r, KIT.power_pylon.size), { maxSlope: 2.5, tilt: [(r() - 0.5) * 0.12, (r() - 0.5) * 0.12] })) break;
        }
    }

    // Martian plants: everywhere sparse, thick by the canal and under the mesas.
    for (let i = 0; i < 2400; i++) {
        const x = (r() - 0.5) * 340, z = (r() - 0.5) * 340;
        const h = T.height(x, z);
        if (h > 10 || h < -7 || sites(x, z, 2) || P.roads.dist(x, z) < 4.5) continue;
        const wet = Math.max(0, 1 - Math.abs(z - (-60 + 5 * Math.sin(x * 0.018))) / 24);
        if (r() > 0.12 + wet * 0.5) continue;
        const u = r();
        const m: KitModel = u < 0.45 ? "mars_shrub" : u < 0.72 ? "succulents" : u < 0.94 ? "fungus_cluster" : "dead_tree";
        P.put(m, x, z, r() * 6.28, between(r, KIT[m].size), { gap: 0.2, maxSlope: m === "dead_tree" ? 0.8 : 0.6 });
    }

    // The Undercroft: the platform and the pit, left as the last crews left them.
    const U = -44;
    const cells: P2[] = [];
    for (let x = 41; x < 177; x += 1.3) for (let z = -187; z < -119; z += 1.3) cells.push([x, z]);
    cells.sort((a, b) => hash(a[0], a[1], 77) - hash(b[0], b[1], 77));
    for (const [x, z] of cells) {
        if (P.ground(x, z, U) === null) continue;
        const wall = P.against(x, U, z, 1.1, 2);
        const u = r();
        if (wall && u < 0.08) {
            const ox = x - wall[0] * 2.2, oz = z - wall[1] * 2.2;
            if (!P.clear([ox - 0.6, U + 0.3, oz - 0.6], [ox + 0.6, U + 1.8, oz + 0.6])) continue;
            const m = pick(r, ["barrels", "cable_spool", "pipe_section", "duct_section", "vending_machine", "scrap_sheets", "engine_block"] as const);
            const yaw = Math.atan2(-wall[0], -wall[1]);
            P.put(m, x, z, yaw, m === "pipe_section" ? between(r, [2.6, 3.4]) : between(r, KIT[m].size), { y: U });
        } else if (u < 0.012) P.put("trash_pile", x, z, r() * 6.28, between(r, [1.2, 2]), { y: U });
    }
}

/** Adds the kit to a map (its roads first, for Noctis). Called once, as the map is built. */
export function dressLevel(level: Level): void {
    if (level.mission === 2) level.roads = NOCTIS_ROADS;
    const P = new Placer(level);
    // The Spire's walls first: what stands on its floors keeps off them.
    // (Noctis's streets and ruins go first: the city's layout matters more than what's on its walls.)
    if (level.mission === 2) { dressNoctis(P); dressWalls(P, noctisRoom(P)); }
    else { dressWalls(P, spireRoom); dressSpire(P); }
    level.props.push(...P.added);
}

/**
 * Collision boxes: the solid kit pieces' measured bounds (te_kit_bounds.ts, from the GLBs); the poles,
 * signs and trees keep KIT's thin core, since their bounds are mostly air.
 */
const THIN = new Set<KitModel>(["street_lamp", "street_sign", "utility_pole", "billboard", "power_pylon", "dead_tree"]);
export function kitBox(model: KitModel): V3 | undefined {
    const k = KIT[model];
    if (!k.box) return undefined;
    const b = KIT_BOUNDS[model];
    return b && !THIN.has(model) ? b : k.box;
}

// --- Geometry: roads and scrub ---------------------------------------------------------------------

export interface MeshData { vertexData: Float32Array; indexData: Uint32Array }

/**
 * A road as a ribbon over the terrain: 2 m slices, five vertices across (it follows the ground), a
 * ragged margin past each edge the shader eats away. uv: x across (-1..1 is the asphalt, the margin
 * runs to +-1.35), y meters along. The vertex alpha packs the sky openness (te_scene.ts), rgb a tint.
 */
export function roadMesh(road: Road, height: (x: number, z: number) => number, open: (x: number, y: number, z: number) => number, seed: number): MeshData {
    const v: number[] = [], idx: number[] = [];
    const S = roadSamples(road, 2);
    const half = road.width / 2, M = 1.35, cols = [-M, -0.6, 0, 0.6, M];
    const shade = 0.9 + hash(seed) * 0.1;
    for (const s of S) {
        const nx = -s.d[1], nz = s.d[0];
        for (const c of cols) {
            const x = s.p[0] + nx * c * half, z = s.p[1] + nz * c * half;
            const y = height(x, z) + 0.07;
            // The normal from the heightfield (a road lies on the ground, it isn't graded).
            const e = 1, hx = height(x - e, z) - height(x + e, z), hz = height(x, z - e) - height(x, z + e);
            const l = Math.hypot(hx, 2 * e, hz);
            v.push(x, y, z, hx / l, (2 * e) / l, hz / l, c, s.s + seed * 37, shade, shade * 0.98, shade * 0.96, Math.min(0.99, open(x, y + 0.5, z) * 0.99));
        }
    }
    const n = cols.length;
    for (let i = 0; i + 1 < S.length; i++) for (let j = 0; j + 1 < n; j++) {
        const a = i * n + j, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, c, d, a, d, b);
    }
    return { vertexData: new Float32Array(v), indexData: new Uint32Array(idx) };
}

/**
 * Scrub: tufts of dry Martian grass and creeper, each three crossed quads (ARCH.scrub draws the blades
 * and cuts them out). Only on gentle open ground, off the roads, away from anything built; thicker by
 * the canal. uv: x across a card 0..1, y up it 0..1; rgb a per-tuft tint; alpha the openness.
 */
export function scrubMesh(level: Level, x0: number, z0: number, size: number): MeshData {
    const T = level.terrain!;
    const v: number[] = [], idx: number[] = [];
    const roads = new SegmentIndex();
    for (const r of level.roads ?? []) { const s = roadSamples(r, 4); for (let i = 0; i + 1 < s.length; i++) roads.add(s[i].p, s[i + 1].p); }
    const built = level.boxes.filter(b => b.solid && b.max[1] - b.min[1] > 0.2 && b.max[0] > x0 - 2 && b.min[0] < x0 + size + 2 && b.max[2] > z0 - 2 && b.min[2] < z0 + size + 2);
    const half = (level.roads ?? [])[0]?.width ?? 7;
    const step = 1.6;
    for (let gx = x0; gx < x0 + size; gx += step) for (let gz = z0; gz < z0 + size; gz += step) {
        const x = gx + hash(gx, gz, 1) * step, z = gz + hash(gz, gx, 2) * step;
        const h = T.height(x, z);
        if (h > 12 || h < -8) continue;
        const wet = Math.max(0, 1 - Math.abs(z - (-60 + 5 * Math.sin(x * 0.018))) / 22);
        // Patches: a low-frequency field decides where scrub grows at all.
        const field = 0.5 + 0.5 * Math.sin(x * 0.043 + Math.sin(z * 0.031) * 2) * Math.sin(z * 0.051 + 1.3);
        if (hash(x, z, 9) > field * 0.55 + wet * 0.45) continue;
        const e = 1.2, slope = Math.max(Math.abs(T.height(x + e, z) - T.height(x - e, z)), Math.abs(T.height(x, z + e) - T.height(x, z - e))) / (2 * e);
        if (slope > 0.45) continue;
        if (roads.dist(x, z) < half / 2 + 0.6) continue;
        if (built.some(b => x > b.min[0] - 0.4 && x < b.max[0] + 0.4 && z > b.min[2] - 0.4 && z < b.max[2] + 0.4 && b.max[1] > h - 0.5)) continue;
        if (T.holes?.some(o => x > o.x0 - 1 && x < o.x1 + 1 && z > o.z0 - 1 && z < o.z1 + 1)) continue;
        const s = 0.25 + hash(x, z, 4) * 0.45 + wet * 0.25, w = s * (0.9 + hash(z, x, 6) * 0.6);
        const o = Math.min(0.99, level.open(x, h + 0.5, z) * 0.99);
        const t = hash(x, z, 7);
        const tint = [0.75 + t * 0.35, 0.7 + hash(x, z, 8) * 0.25, 0.65 + wet * 0.2];
        const a0 = hash(x, z, 5) * Math.PI;
        for (let k = 0; k < 3; k++) {
            const a = a0 + (k * Math.PI) / 3, cx = Math.cos(a) * w * 0.5, cz = Math.sin(a) * w * 0.5;
            const nx = -Math.sin(a), nz = Math.cos(a);
            const base = v.length / 12;
            const lean = (hash(x, z, 10 + k) - 0.5) * 0.25 * s;
            const corners: [number, number, number, number][] = [[-1, 0, 0, 0], [1, 0, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]];
            for (const [sx, up, u, vv] of corners) {
                const px = x + cx * sx + lean * up, pz = z + cz * sx + lean * up * 0.5, py = T.height(x + cx * sx, z + cz * sx) - 0.04 + up * s;
                // The normal leans up: lit like a soft clump, not a flat card.
                const ny = 0.75, l = Math.hypot(nx * 0.5, ny, nz * 0.5);
                v.push(px, py, pz, (nx * 0.5) / l, ny / l, (nz * 0.5) / l, u, vv, tint[0], tint[1], tint[2], o);
            }
            idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
    }
    return { vertexData: new Float32Array(v), indexData: new Uint32Array(idx) };
}
