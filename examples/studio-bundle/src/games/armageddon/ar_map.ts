// Armageddon 2070's four battlefields. Each map is 1,024 m square, generated from a seed and a
// hand-placed layout of 8-12 territories and two headquarters. The point of a map is cover: every
// territory is a site (a port, a village compound, a plant yard, a city block...) built from ruined
// buildings with doors and windows, low walls, sandbags, containers, barriers, wrecks and rubble,
// and the open ground between them gets rocks, craters, hedgerows and wrecks so no approach is a
// bare field. Inside a building there is only floor and its own partitions: anything else the
// generators drop there (barriers, crates, rubble, other walls) is cleared or cut back at the end.
//
// Everything solid is a box (an oriented block), and boxes are rasterized into a 1 m cover grid that
// the simulation reads for movement, line of sight and bullets. A cell holds up to two solid
// spans above its ground: [0, lo] and [gapTop, hi] (dm), so a window is a wall with a gap from the
// sill to the lintel, and a door a gap from the floor. From the cover grid come the navigation
// grids (2 m for infantry, 4 m for vehicles) and, per territory and base, distance fields (Dial's
// algorithm, 8 moves: a straight step costs 2, a diagonal 3 - the units of the WIR path step).

import { Rng, hashString, clamp, type V3 } from "../nebula/nk_math";

export const MAP_SIZE = 1024;
export const HALF = MAP_SIZE / 2;
/** Terrain heights every TERRAIN_STEP m. */
export const TERRAIN_STEP = 4;
export const TN = MAP_SIZE / TERRAIN_STEP + 1;
/** Cover grid: one cell per metre. */
export const CN = MAP_SIZE;
/** Boxes are also bucketed per 8 m so a trace can check the real block where the grid says solid. */
const BUCKET = 8, NB = MAP_SIZE / BUCKET;
/** Infantry navigation: 2 m cells; vehicles: 4 m cells. */
export const NAV_INF = 2, NI = MAP_SIZE / NAV_INF;
export const NAV_VEH = 4, NV = MAP_SIZE / NAV_VEH;
/** Unreached in a distance field. */
export const FAR = 65535;

export type Biome = "coast" | "mountain" | "industrial" | "city";
export type Material = "concrete" | "brick" | "adobe" | "metal" | "container" | "sandbag" | "rock" | "wood" | "glass" | "barrier" | "rubble" | "hesco" | "pipe" | "wreck" | "dome" | "plaster";
/** Ground types written into the terrain's vertex color (the shader paints them). */
export const GROUND = { dirt: 0, grass: 1, rock: 2, sand: 3, road: 4, concrete: 5, snow: 6, glass: 7 } as const;

/** One solid block. Its bottom sits `lift` m above the ground at its center; yaw turns it about +y. */
export interface Box {
    x: number; z: number; y: number;
    hx: number; hz: number; h: number; lift: number; yaw: number;
    mat: Material;
    /** Tint index for containers and paint (0..7), and a per-box seed for the shader. */
    tint: number; seed: number;
    /** Part of a building (walls), cover (low), prop (large standalone), or decoration (no collision). */
    kind: "wall" | "cover" | "prop" | "deco";
    /** Destructible cover keeps hit points (sandbags, barriers, wrecks, deployables). */
    hp?: number;
}

/** A building's footprint: axis-aligned, half sizes hx/hz, from its floor (y) up `h` m. */
export interface Footprint { x: number; z: number; hx: number; hz: number; y: number; h: number }

/** Whether an oriented box overlaps an axis-aligned footprint grown by `m` m (separating axes). */
export function boxInFootprint(b: { x: number; z: number; hx: number; hz: number; yaw: number }, f: Footprint, m = 0): boolean {
    const c = Math.abs(Math.cos(b.yaw)), s = Math.abs(Math.sin(b.yaw)), fx = f.hx + m, fz = f.hz + m;
    const dx = b.x - f.x, dz = b.z - f.z;
    if (Math.abs(dx) >= fx + c * b.hx + s * b.hz || Math.abs(dz) >= fz + s * b.hx + c * b.hz) return false;
    const cs = Math.cos(b.yaw), sn = Math.sin(b.yaw);
    return Math.abs(dx * cs - dz * sn) < b.hx + fx * c + fz * s && Math.abs(dx * sn + dz * cs) < b.hz + fx * s + fz * c;
}

export interface Territory {
    id: string; name: string; x: number; z: number; radius: number;
    /** 1..3: worth more to the strategic WIR and to the ticket drain. */
    value: number;
    site: string;
}
export interface Base {
    team: 0 | 1; x: number; z: number; radius: number;
    /** Where ground vehicles, helicopters and aircraft appear (the base faces `facing`). */
    facing: number;
}
export interface MapDef {
    id: string; name: string; biome: Biome; blurb: string; seed: number;
    territories: { name: string; u: number; v: number; site: string; value?: number; radius?: number }[];
    /** Base positions in [-1, 1] map coordinates. */
    bases: [[number, number], [number, number]];
    sea?: number;
    sun: V3; sky: [number, number, number]; haze: [number, number, number]; fogDensity: number;
}

export const MAPS: MapDef[] = [
    {
        id: "glass-coast", name: "Glass Coast", biome: "coast", seed: 2070,
        blurb: "The Makran shore, where the fusion fire reached the sea. Dunes fused to green glass, a drowned container port, a fishing town of breeze-block ruins.",
        sea: -360,
        territories: [
            { name: "Container Quay", u: -0.6, v: -0.15, site: "port", value: 3, radius: 36 },
            { name: "Dry Dock", u: -0.62, v: 0.32, site: "port", value: 2 },
            { name: "Fish Market", u: -0.25, v: 0.05, site: "town", value: 2 },
            { name: "Mosque Square", u: -0.12, v: -0.42, site: "town", value: 2 },
            { name: "Salt Works", u: 0.18, v: 0.38, site: "industrial", value: 1 },
            { name: "Glass Dunes", u: 0.35, v: -0.05, site: "outpost", value: 1 },
            { name: "Relay Station", u: 0.62, v: -0.38, site: "compound", value: 2 },
            { name: "Desal Plant", u: 0.12, v: -0.12, site: "industrial", value: 3, radius: 34 },
            { name: "Lighthouse", u: -0.48, v: 0.62, site: "outpost", value: 1 },
            { name: "Coast Road Checkpoint", u: 0.55, v: 0.42, site: "checkpoint", value: 1 },
        ],
        bases: [[0.05, -0.88], [0.0, 0.88]],
        sun: [0.5, 0.62, 0.35], sky: [0.66, 0.74, 0.8], haze: [0.78, 0.76, 0.7], fogDensity: 0.0013,
    },
    {
        id: "kush-corridor", name: "Kush Corridor", biome: "mountain", seed: 1999,
        blurb: "A high pass through the Hindu Kush, the last overland road west out of the ash. Walled qalat farms, terraced fields, a ruined bridge over a dry river, pines on the ridges.",
        territories: [
            { name: "Qalat Sarai", u: -0.18, v: -0.5, site: "compound", value: 2 },
            { name: "Terraced Farms", u: 0.22, v: -0.4, site: "village", value: 1 },
            { name: "Broken Bridge", u: 0.0, v: -0.08, site: "checkpoint", value: 3, radius: 32 },
            { name: "Pine Ridge Outpost", u: -0.5, v: 0.05, site: "outpost", value: 2 },
            { name: "Mill Village", u: 0.28, v: 0.12, site: "village", value: 2 },
            { name: "Caravanserai", u: -0.2, v: 0.4, site: "compound", value: 3, radius: 34 },
            { name: "Radar Knoll", u: 0.5, v: 0.45, site: "outpost", value: 1 },
            { name: "Shepherds' Fold", u: -0.48, v: -0.38, site: "village", value: 1 },
            { name: "Tunnel Mouth", u: 0.42, v: -0.12, site: "industrial", value: 1 },
        ],
        bases: [[0.0, -0.88], [0.02, 0.88]],
        sun: [0.4, 0.75, -0.3], sky: [0.55, 0.68, 0.86], haze: [0.75, 0.8, 0.88], fogDensity: 0.0009,
    },
    {
        id: "fusion-plant-seven", name: "Fusion Plant Seven", biome: "industrial", seed: 777,
        blurb: "The plant that powered the abundance of a hundred million people, now the anvil of the war. Reactor domes, cooling towers, pipe racks, a rail yard and endless containers.",
        territories: [
            { name: "Reactor Dome A", u: -0.3, v: 0.0, site: "reactor", value: 3, radius: 38 },
            { name: "Reactor Dome B", u: 0.3, v: 0.02, site: "reactor", value: 3, radius: 38 },
            { name: "Control Block", u: 0.0, v: -0.2, site: "town", value: 2 },
            { name: "Cooling Towers", u: 0.0, v: 0.25, site: "industrial", value: 2 },
            { name: "Rail Yard", u: -0.62, v: -0.35, site: "port", value: 1 },
            { name: "Substation", u: 0.6, v: -0.38, site: "compound", value: 1 },
            { name: "Fuel Depot", u: -0.6, v: 0.38, site: "industrial", value: 1 },
            { name: "Admin Campus", u: 0.6, v: 0.4, site: "town", value: 1 },
            { name: "Pump House", u: -0.25, v: -0.52, site: "compound", value: 1 },
            { name: "Waste Vaults", u: 0.26, v: 0.55, site: "outpost", value: 1 },
            { name: "Transformer Field", u: 0.28, v: -0.55, site: "checkpoint", value: 1 },
        ],
        bases: [[-0.02, -0.88], [0.0, 0.88]],
        sun: [0.55, 0.55, 0.45], sky: [0.62, 0.64, 0.66], haze: [0.68, 0.66, 0.64], fogDensity: 0.0015,
    },
    {
        id: "lhasa-arcology", name: "Lhasa Arcology", biome: "city", seed: 4242,
        blurb: "A terraced arcology city on the Tibetan plateau, built by the Directorate as a monument to plenty. Its streets are a grid of shattered blocks below a monastery on the hill.",
        territories: [
            { name: "Monastery", u: -0.45, v: 0.0, site: "compound", value: 3, radius: 36 },
            { name: "Prayer Wheel Plaza", u: -0.12, v: -0.12, site: "plaza", value: 2 },
            { name: "Market Blocks", u: 0.18, v: -0.25, site: "city", value: 2 },
            { name: "Arcology Spire", u: 0.12, v: 0.12, site: "city", value: 3, radius: 34 },
            { name: "Transit Hub", u: 0.48, v: -0.05, site: "plaza", value: 2 },
            { name: "Residential Terraces", u: -0.4, v: -0.45, site: "city", value: 1 },
            { name: "Hydro Gardens", u: -0.38, v: 0.45, site: "village", value: 1 },
            { name: "Barracks Quarter", u: 0.45, v: 0.42, site: "compound", value: 1 },
            { name: "Old Town", u: -0.1, v: 0.42, site: "town", value: 2 },
            { name: "Cable Car Station", u: 0.62, v: -0.48, site: "outpost", value: 1 },
            { name: "Power Exchange", u: 0.22, v: -0.6, site: "industrial", value: 1 },
            { name: "Stupa Garden", u: -0.68, v: -0.12, site: "outpost", value: 1 },
        ],
        bases: [[0.0, -0.9], [0.0, 0.9]],
        sun: [0.35, 0.8, 0.45], sky: [0.5, 0.65, 0.9], haze: [0.82, 0.85, 0.92], fogDensity: 0.0008,
    },
];

// --- noise ----------------------------------------------------------------------------------

function hash2(x: number, z: number, seed: number): number {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x: number, z: number, seed: number): number {
    const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
    const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    const a = hash2(xi, zi, seed), b = hash2(xi + 1, zi, seed), c = hash2(xi, zi + 1, seed), d = hash2(xi + 1, zi + 1, seed);
    return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}
export function fbm(x: number, z: number, seed: number, oct = 4): number {
    let s = 0, a = 0.5, f = 1;
    for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, z * f, seed + i * 31); a *= 0.5; f *= 2; }
    return s;
}
const ridged = (x: number, z: number, seed: number) => 1 - Math.abs(fbm(x, z, seed, 4) * 2 - 1);

// --- the world ------------------------------------------------------------------------------

export interface Foliage { x: number; z: number; y: number; kind: "bush" | "tree" | "pine" | "dead" | "palm" | "reed"; size: number; seed: number }

interface Pad { x: number; z: number; r: number; y: number; feather: number }
interface Road { pts: [number, number][]; width: number }

export class World {
    readonly def: MapDef;
    readonly heights = new Float32Array(TN * TN);
    readonly ground = new Uint8Array(TN * TN);
    /** Paving per terrain vertex for the shader: asphalt toward 1 (soft road edges), concrete pads 0.5. */
    readonly paved = new Float32Array(TN * TN);
    /** Cover grid (dm above the cell's ground): [0, lo] solid, then [gap, hi] solid when gap > 0. */
    readonly lo = new Uint8Array(CN * CN);
    readonly gap = new Uint8Array(CN * CN);
    readonly hi = new Uint8Array(CN * CN);
    /** Concealment (vegetation) per 2 m cell, 0..255: detection drops inside bushes and reeds. */
    readonly conceal = new Uint8Array(NI * NI);
    /** Box index per cover cell + 1 (0: none), for hits on destructible cover. */
    readonly owner = new Int32Array(CN * CN);
    /** Under a roof (blocks air strikes and Hunter Protocol bolts): per 2 m cell. */
    readonly roofed = new Uint8Array(NI * NI);
    /** Cover cells solid because of a tree trunk (not a box). */
    private readonly trunk = new Uint8Array(CN * CN);
    /** Box indices per 8 m bucket (every bucket a box's footprint touches). */
    private readonly buckets: number[][] = Array.from({ length: NB * NB }, () => []);
    private readonly bucketed = new Set<number>();
    boxes: Box[] = [];
    /** Every building's footprint; their own walls, partitions and roofs are in `ownBoxes`. */
    buildings: Footprint[] = [];
    private readonly ownBoxes = new Set<Box>();
    /** Inside a building's footprint, per 2 m cell (by its centre): a quick check for grass. */
    readonly indoors = new Uint8Array(NI * NI);
    foliage: Foliage[] = [];
    territories: Territory[] = [];
    bases: Base[] = [];
    roads: Road[] = [];
    readonly navInf = new Uint8Array(NI * NI);
    readonly navVeh = new Uint8Array(NV * NV);
    private pads: Pad[] = [];
    private flowCache = new Map<string, Uint16Array>();
    readonly sea: number | null;

    constructor(def: MapDef) {
        this.def = def;
        this.sea = def.sea ?? null;
        const rng = new Rng(def.seed);
        this.layout(rng);
        this.buildTerrain();
        this.buildSites(rng);
        this.buildBetween(rng);
        this.buildLanes(new Rng(def.seed * 7 + 3));
        this.clearBuildings();
        this.buildFoliage(rng);
        this.rasterizeAll();
        this.buildNav();
    }

    // --- terrain ----------------------------------------------------------------------------

    private baseHeight(x: number, z: number): number {
        const s = this.def.seed, b = this.def.biome;
        const n = fbm(x / 220, z / 220, s), d = fbm(x / 60, z / 60, s + 7, 3);
        if (b === "coast") {
            const sea = this.def.sea ?? -400;
            const shore = clamp((x - sea) / 160, -1, 1);
            const dune = Math.pow(ridged(x / 70 + 3, z / 90, s + 3), 2) * 7 * clamp((x - sea - 80) / 200);
            return shore * 9 + n * 14 + d * 3 + dune - 2;
        }
        if (b === "mountain") {
            const ax = Math.abs(x + Math.sin(z / 170) * 60);
            const wall = Math.pow(clamp((ax - 150) / 330), 1.6) * 150;
            return wall + n * 26 + ridged(x / 140, z / 140, s + 5) * 18 * clamp((ax - 80) / 200) + d * 4;
        }
        if (b === "industrial") return n * 8 + d * 2;
        // city: a hill under the monastery (west), terraces stepping down east
        const hill = Math.max(0, 1 - Math.hypot(x + 230, z) / 380) * 46;
        const terr = Math.round((hill + n * 6) / 3.2) * 3.2;
        return terr * 0.75 + (hill + n * 6) * 0.25 + d * 1.5;
    }

    private buildTerrain(): void {
        for (let j = 0; j < TN; j++) for (let i = 0; i < TN; i++) {
            const x = i * TERRAIN_STEP - HALF, z = j * TERRAIN_STEP - HALF;
            let h = this.baseHeight(x, z);
            for (const p of this.pads) {
                const d = Math.hypot(x - p.x, z - p.z);
                if (d < p.r + p.feather) { const t = d <= p.r ? 1 : 1 - (d - p.r) / p.feather; const k = t * t * (3 - 2 * t); h = h + (p.y - h) * k; }
            }
            for (const r of this.roads) {
                const dd = roadDistance(r, x, z);
                if (dd.d < r.width * 0.5 + 6) { const k = clamp(1 - (dd.d - r.width * 0.5) / 6); const ry = this.baseHeight(dd.px, dd.pz); h = h + (ry - h) * k * 0.85; }
            }
            this.heights[j * TN + i] = h;
        }
        // Ground types.
        const b = this.def.biome;
        for (let j = 0; j < TN; j++) for (let i = 0; i < TN; i++) {
            const x = i * TERRAIN_STEP - HALF, z = j * TERRAIN_STEP - HALF, k = j * TN + i;
            const slope = this.slope(x, z), n = fbm(x / 40, z / 40, this.def.seed + 11, 3);
            let g: number = GROUND.dirt;
            if (b === "coast") g = this.heights[k] < 1.5 ? GROUND.sand : n > 0.55 ? GROUND.glass : n > 0.42 ? GROUND.sand : GROUND.dirt;
            else if (b === "mountain") g = slope > 0.55 ? GROUND.rock : this.heights[k] > 110 ? GROUND.snow : n > 0.5 ? GROUND.grass : GROUND.dirt;
            else if (b === "industrial") g = n > 0.6 ? GROUND.concrete : n > 0.45 ? GROUND.dirt : GROUND.grass;
            else g = slope > 0.6 ? GROUND.rock : n > 0.55 ? GROUND.grass : GROUND.dirt;
            for (const p of this.pads) if (Math.hypot(x - p.x, z - p.z) < p.r * 0.92 && (b === "industrial" || b === "city")) g = GROUND.concrete;
            let pave = g === GROUND.concrete ? 0.5 : 0;
            for (const r of this.roads) {
                const d = roadDistance(r, x, z).d;
                if (d < r.width * 0.5 + 1) g = GROUND.road;
                pave = Math.max(pave, clamp((r.width * 0.5 + 2.5 - d) / 4));
            }
            this.ground[k] = g;
            this.paved[k] = pave;
        }
    }

    /** Ground height at (x, z), bilinear over the terrain grid. */
    height(x: number, z: number): number {
        const fx = clamp((x + HALF) / TERRAIN_STEP, 0, TN - 1.001), fz = clamp((z + HALF) / TERRAIN_STEP, 0, TN - 1.001);
        const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, k = j * TN + i;
        const a = this.heights[k], b = this.heights[k + 1], c = this.heights[k + TN], d = this.heights[k + TN + 1];
        return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    }
    slope(x: number, z: number): number {
        const e = TERRAIN_STEP;
        return Math.hypot(this.height(x + e, z) - this.height(x - e, z), this.height(x, z + e) - this.height(x, z - e)) / (2 * e);
    }
    normal(x: number, z: number): V3 {
        const e = 1.5, dx = this.height(x + e, z) - this.height(x - e, z), dz = this.height(x, z + e) - this.height(x, z - e);
        const l = Math.hypot(dx, 2 * e, dz);
        return [-dx / l, (2 * e) / l, -dz / l];
    }
    inBounds(x: number, z: number, margin = 0): boolean { return x > -HALF + margin && x < HALF - margin && z > -HALF + margin && z < HALF - margin; }
    /** Below the sea (water) at this point. */
    wet(x: number, z: number): boolean { return this.sea !== null && this.height(x, z) < 0.2; }

    // --- layout -----------------------------------------------------------------------------

    private layout(rng: Rng): void {
        const d = this.def, S = HALF * 0.98;
        this.bases = d.bases.map(([u, v], t) => ({ team: t as 0 | 1, x: u * S, z: v * S, radius: 46, facing: t === 0 ? 0 : Math.PI }));
        this.territories = d.territories.map((t, i) => ({ id: `T${i + 1}`, name: t.name, x: t.u * S, z: t.v * S, radius: t.radius ?? 28, value: t.value ?? 1, site: t.site }));
        // Pads: flatten each site and base to its natural height there.
        for (const t of this.territories) this.pads.push({ x: t.x, z: t.z, r: t.radius + 6, y: this.baseHeight(t.x, t.z), feather: 26 });
        for (const b of this.bases) this.pads.push({ x: b.x, z: b.z, r: b.radius + 8, y: this.baseHeight(b.x, b.z), feather: 30 });
        // Roads: each base to its two nearest territories, then a spanning tree over territories.
        const nodes = [...this.territories.map(t => [t.x, t.z] as [number, number])];
        const used = new Set<number>([0]);
        const edges: [number, number][] = [];
        while (used.size < nodes.length) {
            let best: [number, number] | null = null, bd = Infinity;
            for (const a of used) for (let b = 0; b < nodes.length; b++) if (!used.has(b)) { const dd = Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]); if (dd < bd) { bd = dd; best = [a, b]; } }
            used.add(best![1]); edges.push(best!);
        }
        for (const [a, b] of edges) this.roads.push(this.road(nodes[a], nodes[b], 7, rng));
        for (const base of this.bases) {
            const near = [...this.territories].sort((p, q) => Math.hypot(p.x - base.x, p.z - base.z) - Math.hypot(q.x - base.x, q.z - base.z)).slice(0, 2);
            for (const t of near) this.roads.push(this.road([base.x, base.z], [t.x, t.z], 8, rng));
        }
    }

    private road(a: [number, number], b: [number, number], width: number, rng: Rng): Road {
        const pts: [number, number][] = [a];
        const n = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 40));
        const nx = -(b[1] - a[1]), nz = b[0] - a[0], nl = Math.hypot(nx, nz) || 1;
        const wob = rng.range(-30, 30);
        for (let i = 1; i < n; i++) {
            const t = i / n, s = Math.sin(t * Math.PI) * wob;
            pts.push([a[0] + (b[0] - a[0]) * t + (nx / nl) * s, a[1] + (b[1] - a[1]) * t + (nz / nl) * s]);
        }
        pts.push(b);
        return { pts, width };
    }

    // --- boxes ------------------------------------------------------------------------------

    private add(b: Omit<Box, "y" | "seed" | "tint"> & { tint?: number; y?: number }): Box {
        const box: Box = { tint: 0, seed: hashString(`${this.boxes.length}`) % 997, ...b, y: b.y ?? this.height(b.x, b.z) } as Box;
        if (box.kind === "cover" && box.hp === undefined && (box.mat === "sandbag" || box.mat === "barrier" || box.mat === "wreck" || box.mat === "hesco" || box.mat === "wood")) box.hp = box.mat === "wood" ? 300 : box.mat === "sandbag" ? 900 : 1600;
        this.boxes.push(box);
        return box;
    }

    /** A wall from (x0, z0) to (x1, z1) with openings: each opening is [t (m along), width, sill, top] (sill 0: door). */
    private wall(x0: number, z0: number, x1: number, z1: number, height: number, thick: number, mat: Material, openings: [number, number, number, number][], y: number, broken = 0, rng?: Rng): void {
        const L = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / L, uz = (z1 - z0) / L, yaw = Math.atan2(ux, uz);
        const seg = (t0: number, t1: number, lift: number, h: number) => {
            if (t1 - t0 < 0.05 || h <= 0.05) return;
            const tc = (t0 + t1) / 2;
            this.add({ x: x0 + ux * tc, z: z0 + uz * tc, y: y + lift, hx: thick / 2, hz: (t1 - t0) / 2, h, lift: 0, yaw, mat, kind: "wall" });
        };
        const ops = [...openings].sort((a, b) => a[0] - b[0]);
        let t = 0;
        for (const [o, w, sill, top] of ops) {
            const a = Math.max(t, o - w / 2), b = Math.min(L, o + w / 2);
            seg(t, a, 0, height);
            if (sill > 0) seg(a, b, 0, sill);
            seg(a, b, top, height - top);
            t = b;
        }
        // Broken walls: chunks of the top missing (silhouettes, and holes to shoot through).
        if (broken > 0 && rng) {
            let s = t;
            while (s < L) {
                const len = Math.min(L - s, rng.range(1.5, 4));
                seg(s, s + len, 0, rng.next() < broken ? height * rng.range(0.35, 0.8) : height);
                s += len;
            }
        } else seg(t, L, 0, height);
    }

    /** A ruined building, axis-aligned at (x, z), w x d metres, `floors` storeys of 3.2 m, roofless unless `roof`. */
    private building(x: number, z: number, w: number, d: number, floors: number, mat: Material, rng: Rng, opts: { roof?: boolean; broken?: number; doors?: number } = {}): void {
        const H = floors * 3.2, t = 0.5, y = this.height(x, z) - 0.1;
        // Two buildings never share ground (their walls would run through each other's rooms).
        const foot: Footprint = { x, z, hx: w / 2, hz: d / 2, y, h: H };
        if (this.buildings.some(f => boxInFootprint({ ...foot, yaw: 0 }, f, 1.5))) return;
        this.buildings.push(foot);
        const own0 = this.boxes.length;
        const sides: [number, number, number, number][] = [[x - w / 2, z - d / 2, x + w / 2, z - d / 2], [x + w / 2, z - d / 2, x + w / 2, z + d / 2], [x + w / 2, z + d / 2, x - w / 2, z + d / 2], [x - w / 2, z + d / 2, x - w / 2, z - d / 2]];
        // At least two doors on different sides (usually opposite), so a building is a way through
        // and not a dead end; some walls also have a breach blown through at floor level.
        const doorSides = new Set<number>();
        const nd = Math.max(2, opts.doors ?? rng.int(2, 3));
        const first = rng.int(0, 3);
        doorSides.add(first);
        if (rng.next() < 0.7) doorSides.add((first + 2) % 4);
        while (doorSides.size < nd) doorSides.add(rng.int(0, 3));
        const breach = opts.broken === 0 ? -1 : rng.next() < 0.4 ? rng.int(0, 3) : -1;
        sides.forEach(([ax, az, bx, bz], s) => {
            const L = Math.hypot(bx - ax, bz - az), ops: [number, number, number, number][] = [];
            const door = doorSides.has(s) ? Math.round(rng.range(2, L - 2) / 2) * 2 : -1;
            if (door > 0) ops.push([door, 2, 0, 2.3]);
            const hole = s === breach && !doorSides.has(s) && L >= 6 ? Math.round(rng.range(2, L - 2) * 2) / 2 : -1;
            if (hole > 0) ops.push([hole, 1.8, 0, rng.range(1.7, 2.2)]);
            for (let p = 2; p < L - 1.5; p += rng.range(2.6, 3.8)) if (Math.abs(p - door) > 2.4 && Math.abs(p - hole) > 2.3) ops.push([p, 1.2, 1.0, 2.1]);
            const broken = opts.broken ?? 0.35;
            if (floors > 1) {
                this.wall(ax, az, bx, bz, 3.2, t, mat, ops, y);
                const up: [number, number, number, number][] = [];
                for (let p = 2; p < L - 1.5; p += 3) up.push([p, 1.2, 1.0, 2.1]);
                this.wall(ax, az, bx, bz, H - 3.2, t, mat, up, y + 3.2, broken, rng);
            } else this.wall(ax, az, bx, bz, H, t, mat, ops, y, broken, rng);
        });
        // Rooms: a partition with a doorway in most buildings, a second one across the bigger ones.
        // Nothing else stands inside: rooms are for moving and seeing through.
        if (w >= 8 && d >= 6) {
            const px = x + rng.range(-w / 6, w / 6);
            this.wall(px, z - d / 2 + t, px, z + d / 2 - t, 3.0, 0.3, "plaster", [[Math.round(rng.range(1.5, d - 2)), 1.6, 0, 2.2]], y);
            if (w > 10 && d > 8) {
                const pz = z + rng.range(-d / 6, d / 6), side = rng.next() < 0.5 ? -1 : 1;
                const xa = side < 0 ? x - w / 2 + t : px + 0.15, xb = side < 0 ? px - 0.15 : x + w / 2 - t;
                if (xb - xa > 3) this.wall(xa, pz, xb, pz, 3.0, 0.3, "plaster", [[(xb - xa) / 2, 1.6, 0, 2.2]], y);
            }
        }
        if (opts.roof) { this.add({ x, z, y: y + H, hx: w / 2, hz: d / 2, h: 0.35, lift: 0, yaw: 0, mat: "concrete", kind: "deco" }); this.markRoof(x, z, w / 2, d / 2); }
        for (let i = own0; i < this.boxes.length; i++) this.ownBoxes.add(this.boxes[i]);
        // Rubble heaped against the outside (clearBuildings drops any that would poke through a wall).
        for (let i = 0; i < rng.int(1, 3); i++) { const a = rng.range(0, Math.PI * 2), r = Math.max(w, d) * 0.5 + rng.range(1.2, 2.5); this.rubble(x + Math.cos(a) * r, z + Math.sin(a) * r, rng); }
    }

    /** Inside (or within `pad` m of) a building's footprint. */
    inBuilding(x: number, z: number, pad = 0): boolean {
        for (const f of this.buildings) if (Math.abs(x - f.x) < f.hx + pad && Math.abs(z - f.z) < f.hz + pad) return true;
        return false;
    }

    /**
     * Keeps buildings clear: every box that is not a building's own (walls, partitions, roof) and
     * touches a building's footprint (or its walls, within 0.4 m) goes. Walls from elsewhere (a
     * compound's perimeter, a garden wall, a lane's low wall) are cut back to the building's outside
     * instead, so a perimeter running into a corner tower now ends at its wall. Boxes wholly above a
     * building (a crane's jib, overhead pipes) stay.
     */
    private clearBuildings(): void {
        const M = 0.4;
        const keep: Box[] = [];
        for (const b of this.boxes) {
            if (this.ownBoxes.has(b)) { keep.push(b); continue; }
            const hits = this.buildings.filter(f => b.y < f.y + f.h + 0.5 && b.y + b.h > f.y && boxInFootprint(b, f, M));
            if (!hits.length) { keep.push(b); continue; }
            if (b.kind !== "wall") continue;
            // The wall's centreline runs along its local z; cut out where it passes through each footprint.
            const ux = Math.sin(b.yaw), uz = Math.cos(b.yaw), cut: [number, number][] = [];
            for (const f of hits) {
                let t0 = -b.hz, t1 = b.hz;
                for (const [p, u, half] of [[b.x - f.x, ux, f.hx], [b.z - f.z, uz, f.hz]]) {
                    const e = half + M + b.hx;
                    if (Math.abs(u) < 1e-9) { if (Math.abs(p) >= e) t1 = t0 - 1; continue; }
                    const a = (-e - p) / u, c = (e - p) / u;
                    t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
                }
                if (t1 > t0) cut.push([t0, t1]);
            }
            cut.sort((p, q) => p[0] - q[0]);
            let t = -b.hz;
            const piece = (a: number, c: number) => { if (c - a > 0.3) keep.push({ ...b, x: b.x + ux * (a + c) / 2, z: b.z + uz * (a + c) / 2, hz: (c - a) / 2 }); };
            for (const [a, c] of cut) { piece(t, a); t = Math.max(t, c); }
            piece(t, b.hz);
        }
        this.boxes = keep;
        for (const f of this.buildings)
            for (let j = Math.ceil((f.z - f.hz + HALF) / NAV_INF - 0.5); (j + 0.5) * NAV_INF - HALF < f.z + f.hz; j++)
                for (let i = Math.ceil((f.x - f.hx + HALF) / NAV_INF - 0.5); (i + 0.5) * NAV_INF - HALF < f.x + f.hx; i++)
                    if (i >= 0 && j >= 0 && i < NI && j < NI) this.indoors[j * NI + i] = 1;
    }

    /** On a building's floor (by the 2 m indoor grid). */
    indoor(x: number, z: number): boolean {
        const i = Math.floor((x + HALF) / NAV_INF), j = Math.floor((z + HALF) / NAV_INF);
        return i >= 0 && j >= 0 && i < NI && j < NI && this.indoors[j * NI + i] === 1;
    }

    private markRoof(x: number, z: number, hx: number, hz: number): void {
        for (let j = Math.floor((z - hz + HALF) / NAV_INF); j <= Math.floor((z + hz + HALF) / NAV_INF); j++)
            for (let i = Math.floor((x - hx + HALF) / NAV_INF); i <= Math.floor((x + hx + HALF) / NAV_INF); i++)
                if (i >= 0 && j >= 0 && i < NI && j < NI) this.roofed[j * NI + i] = 1;
    }

    private rubble(x: number, z: number, rng: Rng): void {
        this.add({ x, z, hx: rng.range(0.8, 1.6), hz: rng.range(0.6, 1.3), h: rng.range(0.7, 1.3), lift: 0, yaw: rng.range(0, 3.14), mat: "rubble", kind: "cover" });
    }
    private sandbags(x: number, z: number, yaw: number, len: number, rng: Rng, high = false): void {
        this.add({ x, z, hx: 0.45, hz: len / 2, h: high ? 1.45 : 1.05 + rng.range(0, 0.15), lift: 0, yaw, mat: "sandbag", kind: "cover" });
    }
    /** An L or U of sandbags: a firing position facing `yaw`. */
    private nest(x: number, z: number, yaw: number, rng: Rng): void {
        const c = Math.cos(yaw), s = Math.sin(yaw);
        this.sandbags(x + Math.sin(yaw) * 1.5, z + Math.cos(yaw) * 1.5, yaw + Math.PI / 2, 4, rng);
        this.sandbags(x + c * 2, z - s * 2, yaw, 3, rng);
        if (rng.next() < 0.5) this.sandbags(x - c * 2, z + s * 2, yaw, 3, rng);
    }
    private container(x: number, z: number, yaw: number, rng: Rng, stack = 1): void {
        for (let k = 0; k < stack; k++) this.add({ x, z, y: this.height(x, z) + k * 2.6, hx: 1.25, hz: 6.1, h: 2.6, lift: 0, yaw: yaw + (k ? rng.range(-0.08, 0.08) : 0), mat: "container", tint: rng.int(0, 7), kind: k ? "prop" : "prop" });
    }
    private barrier(x: number, z: number, yaw: number, n: number): void {
        const ux = Math.sin(yaw + Math.PI / 2), uz = Math.cos(yaw + Math.PI / 2);
        for (let i = 0; i < n; i++) this.add({ x: x + ux * (i - (n - 1) / 2) * 2.1, z: z + uz * (i - (n - 1) / 2) * 2.1, hx: 0.35, hz: 1.0, h: 1.05, lift: 0, yaw: yaw + Math.PI / 2, mat: "barrier", kind: "cover" });
    }
    private wreck(x: number, z: number, yaw: number, rng: Rng): void {
        const big = rng.next() < 0.35;
        this.add({ x, z, hx: big ? 1.7 : 1.0, hz: big ? 4 : 2.3, h: big ? 2.2 : 1.35, lift: 0, yaw, mat: "wreck", tint: rng.int(0, 7), kind: "cover" });
        if (big) this.add({ x: x + Math.sin(yaw) * 0.5, z: z + Math.cos(yaw) * 0.5, y: this.height(x, z) + 2.2, hx: 1.2, hz: 1.5, h: 0.7, lift: 0, yaw: yaw + rng.range(-0.6, 0.6), mat: "wreck", tint: 0, kind: "deco" });
    }
    private rock(x: number, z: number, size: number, rng: Rng): void {
        this.add({ x, z, y: this.height(x, z) - size * 0.25, hx: size * rng.range(0.6, 1.1), hz: size * rng.range(0.5, 1), h: size * rng.range(0.9, 1.4), lift: 0, yaw: rng.range(0, 3.14), mat: "rock", kind: size > 2.5 ? "prop" : "cover" });
    }
    private hesco(x: number, z: number, yaw: number, n: number): void {
        const ux = Math.sin(yaw + Math.PI / 2), uz = Math.cos(yaw + Math.PI / 2);
        for (let i = 0; i < n; i++) this.add({ x: x + ux * (i - (n - 1) / 2) * 1.1, z: z + uz * (i - (n - 1) / 2) * 1.1, hx: 0.55, hz: 0.55, h: 1.4, lift: 0, yaw, mat: "hesco", kind: "cover" });
    }
    private tower(x: number, z: number, rng: Rng): void {
        // A watchtower: four legs, a platform with sandbag parapet up top (deco above head height).
        const y = this.height(x, z);
        for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) this.add({ x: x + a * 1.4, z: z + b * 1.4, y, hx: 0.15, hz: 0.15, h: 6, lift: 0, yaw: 0, mat: "metal", kind: "wall" });
        this.add({ x, z, y: y + 6, hx: 1.8, hz: 1.8, h: 0.3, lift: 0, yaw: 0, mat: "wood", kind: "deco" });
        this.add({ x, z: z + 1.6, y: y + 6.3, hx: 1.8, hz: 0.2, h: 1.0, lift: 0, yaw: 0, mat: "sandbag", kind: "deco" });
        void rng;
    }

    // --- sites ------------------------------------------------------------------------------

    private buildSites(rng: Rng): void {
        const b = this.def.biome;
        const mat: Material = b === "mountain" ? "adobe" : b === "coast" ? "plaster" : b === "industrial" ? "concrete" : "brick";
        for (const t of this.territories) {
            const r = new Rng(this.def.seed * 131 + hashString(t.name));
            switch (t.site) {
                case "port": this.port(t, r); break;
                case "town": case "city": this.town(t, r, mat, t.site === "city"); break;
                case "village": this.village(t, r); break;
                case "compound": this.compound(t, r, b === "mountain" ? "adobe" : mat); break;
                case "industrial": this.industrial(t, r); break;
                case "reactor": this.reactor(t, r); break;
                case "plaza": this.plaza(t, r, mat); break;
                case "checkpoint": this.checkpoint(t, r); break;
                default: this.outpost(t, r); break;
            }
        }
        for (const t of this.territories) this.fillCover(t, new Rng(this.def.seed * 17 + hashString(t.id)));
        for (const base of this.bases) this.headquarters(base, new Rng(this.def.seed + base.team * 97));
        // Craters and wreckage along roads.
        for (const road of this.roads) for (let i = 1; i < road.pts.length - 1; i++) {
            const [x, z] = road.pts[i];
            if (this.nearSite(x, z, 10)) continue;
            if (rng.next() < 0.45) this.wreck(x + rng.range(-4, 4), z + rng.range(-4, 4), rng.range(0, 6.28), rng);
            if (rng.next() < 0.35) this.barrier(x + rng.range(-6, 6), z + rng.range(-6, 6), rng.range(0, 6.28), rng.int(2, 4));
        }
    }

    /**
     * Good gunplay needs cover everywhere: walk a territory on a 5 m lattice and wherever nothing at
     * least 0.9 m tall stands within 6 m, drop a mixed piece of cover (sandbags, a barrier, crates,
     * rubble, a wreck, a low wall). Also guarantees at least four kinds of cover per territory.
     */
    private fillCover(t: Territory, rng: Rng): void {
        const R = t.radius * 1.15;
        const near = this.boxes.filter(b => b.kind !== "deco" && b.h + (b.y - this.height(b.x, b.z)) >= 0.9 && Math.hypot(b.x - t.x, b.z - t.z) < R + 20);
        const covered = (x: number, z: number) => near.some(b => {
            const c = Math.cos(b.yaw), s = Math.sin(b.yaw), px = x - b.x, pz = z - b.z;
            const lx = Math.abs(px * c - pz * s) - b.hx, lz = Math.abs(px * s + pz * c) - b.hz;
            return Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) < 5.5;
        });
        const inside = (x: number, z: number) => near.some(b => { const c = Math.cos(b.yaw), s = Math.sin(b.yaw), px = x - b.x, pz = z - b.z; return Math.abs(px * c - pz * s) < b.hx + 1.5 && Math.abs(px * s + pz * c) < b.hz + 1.5; });
        const kinds: Material[] = ["sandbag", "barrier", "wood", "rubble", "wreck", "brick"];
        let k = rng.int(0, kinds.length - 1);
        const place = (x: number, z: number) => {
            const yaw = Math.atan2(x - t.x, z - t.z) + rng.range(-0.5, 0.5), mat = kinds[k++ % kinds.length];
            if (mat === "sandbag") this.nest(x, z, yaw, rng);
            else if (mat === "barrier") this.barrier(x, z, yaw, 3);
            else if (mat === "wood") { this.add({ x, z, hx: 0.6, hz: 0.6, h: 1.2, lift: 0, yaw, mat: "wood", kind: "cover" }); this.add({ x: x + 1.4, z: z + 0.3, hx: 0.5, hz: 0.5, h: 1.0, lift: 0, yaw: yaw + 0.4, mat: "wood", kind: "cover" }); }
            else if (mat === "rubble") { this.rubble(x, z, rng); this.rubble(x + rng.range(-2, 2), z + rng.range(-2, 2), rng); }
            else if (mat === "wreck") this.wreck(x, z, yaw, rng);
            else this.wall(x - Math.cos(yaw) * 2.5, z + Math.sin(yaw) * 2.5, x + Math.cos(yaw) * 2.5, z - Math.sin(yaw) * 2.5, 1.3, 0.4, "brick", [], this.height(x, z), 0.5, rng);
            near.push(...this.boxes.slice(-3).filter(b => b.kind !== "deco"));
        };
        for (let z = t.z - R; z <= t.z + R; z += 5) for (let x = t.x - R; x <= t.x + R; x += 5) {
            if (Math.hypot(x - t.x, z - t.z) > R || Math.hypot(x - t.x, z - t.z) < 4) continue;
            if (this.wet(x, z) || this.slope(x, z) > 0.5 || covered(x, z) || inside(x, z) || this.inBuilding(x, z, 3)) continue;
            place(x + rng.range(-1, 1), z + rng.range(-1, 1));
        }
        // Variety: at least four kinds of cover here.
        const mats = () => new Set(this.boxes.filter(b => b.kind !== "deco" && Math.hypot(b.x - t.x, b.z - t.z) < t.radius * 1.2).map(b => b.mat)).size;
        for (let guard = 0; guard < 6 && mats() < 4; guard++) { const a = rng.range(0, 6.283), r = t.radius * rng.range(0.4, 0.95); place(t.x + Math.cos(a) * r, t.z + Math.sin(a) * r); }
    }

    private nearSite(x: number, z: number, pad = 0): boolean {
        for (const t of this.territories) if (Math.hypot(x - t.x, z - t.z) < t.radius + pad) return true;
        for (const b of this.bases) if (Math.hypot(x - b.x, z - b.z) < b.radius + pad + 10) return true;
        return false;
    }

    /** Positions on a ring around a site, avoiding the center (where the flag stands). */
    private around(t: { x: number; z: number; radius: number }, rng: Rng, min = 0.3, max = 1): [number, number] {
        const a = rng.range(0, Math.PI * 2), r = t.radius * rng.range(min, max);
        return [t.x + Math.cos(a) * r, t.z + Math.sin(a) * r];
    }

    private port(t: Territory, rng: Rng): void {
        // Rows of stacked containers with alleys, a crane, warehouses, barriers.
        const yaw = rng.next() < 0.5 ? 0 : Math.PI / 2;
        for (let row = -2; row <= 2; row++) for (let col = -1; col <= 1; col++) {
            if (rng.next() < 0.22 || (row === 0 && col === 0)) continue;
            const ox = row * 6.2, oz = col * 15;
            const [x, z] = rot(ox, oz, yaw);
            this.container(t.x + x, t.z + z, yaw + rng.range(-0.05, 0.05), rng, rng.next() < 0.35 ? 2 : 1);
        }
        this.building(t.x + (yaw ? 0 : t.radius * 0.75), t.z + (yaw ? t.radius * 0.75 : 0), 16, 10, 1, "metal", rng, { roof: true, broken: 0.1, doors: 2 });
        for (let i = 0; i < 4; i++) { const [x, z] = this.around(t, rng, 0.5, 1.1); this.barrier(x, z, rng.range(0, 6.28), 3); }
        for (let i = 0; i < 3; i++) { const [x, z] = this.around(t, rng, 0.4, 1); this.nest(x, z, rng.range(0, 6.28), rng); }
        const [cx, cz] = this.around(t, rng, 0.6, 0.9);
        for (const [a, b] of [[-3, -3], [3, -3], [3, 3], [-3, 3]]) this.add({ x: cx + a, z: cz + b, hx: 0.4, hz: 0.4, h: 22, lift: 0, yaw: 0, mat: "metal", kind: "wall" });
        this.add({ x: cx, z: cz, y: this.height(cx, cz) + 22, hx: 2, hz: 18, h: 2, lift: 0, yaw: rng.range(0, 3), mat: "metal", kind: "deco", tint: 2 });
    }

    private town(t: Territory, rng: Rng, mat: Material, city: boolean): void {
        // Blocks on a street grid with a small square in the middle.
        const cell = city ? 18 : 15, n = Math.ceil(t.radius / cell) + (city ? 1 : 0);
        for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
            const x = t.x + a * cell, z = t.z + b * cell;
            if (Math.hypot(a, b) < 0.8) continue;
            if (Math.hypot(x - t.x, z - t.z) > t.radius + cell) continue;
            if (rng.next() < 0.18) { this.rubble(x, z, rng); this.rubble(x + 2, z - 1, rng); continue; }
            const w = Math.round(rng.range(7, cell - 5) / 2) * 2, d = Math.round(rng.range(6, cell - 5) / 2) * 2;
            this.building(x, z, w, d, city ? rng.int(1, 3) : rng.int(1, 2), mat, rng, { roof: rng.next() < 0.3, broken: city ? 0.45 : 0.35 });
        }
        for (let i = 0; i < 5; i++) { const [x, z] = this.around(t, rng, 0.1, 0.5); this.wreck(x, z, rng.range(0, 6.28), rng); }
        for (let i = 0; i < 3; i++) { const [x, z] = this.around(t, rng, 0.15, 0.4); this.nest(x, z, rng.range(0, 6.28), rng); }
        if (city) for (let i = 0; i < 2; i++) { const [x, z] = this.around(t, rng, 0.9, 1.3); this.building(x, z, 12, 12, 5, "concrete", rng, { broken: 0.6 }); }
    }

    private village(t: Territory, rng: Rng): void {
        // Scattered houses with low garden walls, haystack-like rubble, a few trees.
        const mat: Material = this.def.biome === "mountain" ? "adobe" : "plaster";
        for (let i = 0; i < 9; i++) {
            const [x, z] = this.around(t, rng, 0.25, 1.15);
            const w = Math.round(rng.range(6, 10) / 2) * 2, d = Math.round(rng.range(5, 8) / 2) * 2;
            this.building(Math.round(x / 2) * 2, Math.round(z / 2) * 2, w, d, 1, mat, rng, { roof: rng.next() < 0.5, broken: 0.3 });
            // garden wall
            const yaw = rng.range(0, 6.28), gx = x + Math.cos(yaw) * (w / 2 + 4), gz = z + Math.sin(yaw) * (d / 2 + 4);
            this.wall(gx - Math.sin(yaw) * 5, gz + Math.cos(yaw) * 5, gx + Math.sin(yaw) * 5, gz - Math.cos(yaw) * 5, 1.25, 0.5, mat, [[rng.range(2, 8), 1.5, 0, 1.25]], this.height(gx, gz), 0.4, rng);
        }
        for (let i = 0; i < 4; i++) { const [x, z] = this.around(t, rng, 0.2, 0.8); this.rubble(x, z, rng); }
        for (let i = 0; i < 2; i++) { const [x, z] = this.around(t, rng, 0.2, 0.7); this.nest(x, z, rng.range(0, 6.28), rng); }
    }

    private compound(t: Territory, rng: Rng, mat: Material): void {
        // A walled compound (qalat / monastery / relay station): high walls with gates and corner
        // towers, inner buildings around a courtyard.
        const s = t.radius * 0.8, y = this.height(t.x, t.z);
        const gates = [rng.int(0, 3), rng.int(0, 3)];
        const sides: [number, number, number, number][] = [[-s, -s, s, -s], [s, -s, s, s], [s, s, -s, s], [-s, s, -s, -s]];
        sides.forEach(([a, b, c, d], i) => {
            const L = 2 * s, ops: [number, number, number, number][] = [];
            if (gates.includes(i)) ops.push([Math.round(L / 2), 4, 0, 3.0]);
            for (let p = 4; p < L - 3; p += rng.range(5, 8)) if (Math.abs(p - L / 2) > 4) ops.push([p, 0.6, 1.5, 2.0]); // loopholes
            this.wall(t.x + a, t.z + b, t.x + c, t.z + d, 3.8, 0.9, mat, ops, y, 0.25, rng);
        });
        for (const [a, b] of [[-s, -s], [s, -s], [s, s], [-s, s]]) this.building(t.x + a, t.z + b, 6, 6, 2, mat, rng, { roof: true, broken: 0.2, doors: 1 });
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2 + rng.range(-0.3, 0.3), r = s * 0.55;
            this.building(Math.round((t.x + Math.cos(a) * r) / 2) * 2, Math.round((t.z + Math.sin(a) * r) / 2) * 2, Math.round(rng.range(8, 12) / 2) * 2, Math.round(rng.range(6, 9) / 2) * 2, 1, mat, rng, { roof: rng.next() < 0.6, broken: 0.25 });
        }
        for (let i = 0; i < 3; i++) { const [x, z] = this.around(t, rng, 0.05, 0.3); i === 0 ? this.wreck(x, z, rng.range(0, 6), rng) : this.rubble(x, z, rng); }
        // Outside: ditches of sandbags and rocks on the approaches.
        for (let i = 0; i < 4; i++) { const [x, z] = this.around(t, rng, 1.25, 1.6); this.nest(x, z, Math.atan2(x - t.x, z - t.z), rng); }
    }

    private industrial(t: Territory, rng: Rng): void {
        // Tanks, pipe racks, a warehouse, stacked crates.
        for (let i = 0; i < 4; i++) {
            const [x, z] = this.around(t, rng, 0.45, 1.0), r = rng.range(3, 5.5);
            this.add({ x, z, hx: r, hz: r, h: rng.range(6, 11), lift: 0, yaw: 0, mat: "dome", kind: "prop", tint: rng.int(0, 3) });
        }
        for (let i = 0; i < 3; i++) {
            const [x, z] = this.around(t, rng, 0.2, 0.8), yaw = rng.next() < 0.5 ? 0 : Math.PI / 2, L = rng.range(14, 26);
            // A pipe rack: posts you can hide behind, pipes overhead.
            for (let k = -L / 2; k <= L / 2; k += 4) { const [ox, oz] = rot(0, k, yaw); this.add({ x: x + ox, z: z + oz, hx: 0.35, hz: 0.35, h: 4.5, lift: 0, yaw, mat: "metal", kind: "wall" }); }
            const [px, pz] = rot(0, 0, yaw);
            this.add({ x: x + px, z: z + pz, y: this.height(x, z) + 4.5, hx: 0.9, hz: L / 2, h: 1.0, lift: 0, yaw, mat: "pipe", kind: "deco" });
            this.add({ x: x + px + 1.5, z: z + pz, y: this.height(x, z) + 0.2, hx: 0.5, hz: L / 2, h: 0.95, lift: 0, yaw, mat: "pipe", kind: "cover" });
        }
        this.building(t.x + rng.range(-8, 8), t.z + rng.range(-8, 8), 18, 12, 2, "metal", rng, { roof: true, broken: 0.15, doors: 3 });
        for (let i = 0; i < 6; i++) { const [x, z] = this.around(t, rng, 0.2, 1.1); rng.next() < 0.5 ? this.container(x, z, rng.range(0, 6.28), rng) : this.barrier(x, z, rng.range(0, 6.28), 3); }
        for (let i = 0; i < 2; i++) { const [x, z] = this.around(t, rng, 0.3, 0.9); this.nest(x, z, rng.range(0, 6.28), rng); }
    }

    private reactor(t: Territory, rng: Rng): void {
        // A huge dome (blocks everything) ringed by service buildings, hesco lines and containers.
        this.add({ x: t.x, z: t.z, hx: 14, hz: 14, h: 26, lift: 0, yaw: 0, mat: "dome", kind: "prop", tint: 1 });
        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2 + rng.range(-0.2, 0.2), r = t.radius * 0.72;
            const x = t.x + Math.cos(a) * r, z = t.z + Math.sin(a) * r;
            if (i % 2 === 0) this.building(Math.round(x / 2) * 2, Math.round(z / 2) * 2, 10, 8, 1, "concrete", rng, { roof: true, broken: 0.15 });
            else this.hesco(x, z, a, 5);
        }
        for (let i = 0; i < 6; i++) { const [x, z] = this.around(t, rng, 0.62, 1.25); i % 2 ? this.container(x, z, rng.range(0, 6.28), rng) : this.nest(x, z, Math.atan2(x - t.x, z - t.z), rng); }
        for (let i = 0; i < 4; i++) { const [x, z] = this.around(t, rng, 0.6, 1.0); this.barrier(x, z, rng.range(0, 6.28), 4); }
    }

    private plaza(t: Territory, rng: Rng, mat: Material): void {
        // An open square ringed by buildings, with a fountain/statue base, planters and kiosks for cover.
        const n = 10;
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2, r = t.radius * 1.05;
            if (rng.next() < 0.2) continue;
            this.building(Math.round((t.x + Math.cos(a) * r) / 2) * 2, Math.round((t.z + Math.sin(a) * r) / 2) * 2, 10, 8, rng.int(2, 3), mat, rng, { broken: 0.4 });
        }
        this.add({ x: t.x, z: t.z, hx: 3.5, hz: 3.5, h: 1.2, lift: 0, yaw: 0.4, mat: "concrete", kind: "cover" });
        this.add({ x: t.x, z: t.z, hx: 0.8, hz: 0.8, h: 5, lift: 0, yaw: 0.4, mat: "concrete", kind: "prop" });
        for (let i = 0; i < 8; i++) { const [x, z] = this.around(t, rng, 0.3, 0.8); this.add({ x, z, hx: rng.range(0.6, 1.4), hz: rng.range(1.5, 2.5), h: rng.range(0.9, 1.2), lift: 0, yaw: rng.range(0, 3), mat: i % 2 ? "concrete" : "wood", kind: "cover" }); }
        for (let i = 0; i < 4; i++) { const [x, z] = this.around(t, rng, 0.25, 0.7); this.wreck(x, z, rng.range(0, 6.28), rng); }
        // Market kiosks: head-high boxes that break the square's long sightlines.
        for (let i = 0; i < 5; i++) { const [x, z] = this.around(t, rng, 0.3, 0.8); this.add({ x, z, hx: rng.range(1.0, 1.4), hz: rng.range(1.2, 1.8), h: rng.range(2.3, 2.7), lift: 0, yaw: rng.range(0, 3), mat: i % 2 ? "metal" : "wood", kind: "prop" }); }
    }

    private checkpoint(t: Territory, rng: Rng): void {
        // A road checkpoint: barrier chicanes, a guard house, hesco walls, sandbag nests, a tower.
        const yaw = rng.range(0, Math.PI);
        for (let k = -2; k <= 2; k++) { const [x, z] = rot(k % 2 ? 3 : -3, k * 6, yaw); this.barrier(t.x + x, t.z + z, yaw + Math.PI / 2, 3); }
        const [gx, gz] = rot(9, 0, yaw);
        this.building(Math.round((t.x + gx) / 2) * 2, Math.round((t.z + gz) / 2) * 2, 6, 6, 1, "concrete", rng, { roof: true, doors: 2, broken: 0.1 });
        for (const s of [-1, 1]) { const [hx, hz] = rot(s * 14, 0, yaw); this.hesco(t.x + hx, t.z + hz, yaw, 8); }
        for (let i = 0; i < 4; i++) { const [x, z] = this.around(t, rng, 0.4, 1.0); this.nest(x, z, rng.range(0, 6.28), rng); }
        const [tx, tz] = rot(-10, 8, yaw); this.tower(t.x + tx, t.z + tz, rng);
        // Concrete T-walls in pairs and a container: cover to stand behind, not only to crouch behind.
        for (let i = 0; i < 3; i++) {
            const [x, z] = this.around(t, rng, 0.35, 0.85), a = rng.range(0, Math.PI), ux = Math.sin(a), uz = Math.cos(a);
            for (const k of [-0.65, 0.65]) this.add({ x: x + ux * k, z: z + uz * k, hx: 0.3, hz: 0.62, h: 3.2, lift: 0, yaw: a, mat: "barrier", kind: "cover", hp: 2400 });
        }
        { const [x, z] = this.around(t, rng, 0.4, 0.8); this.container(x, z, rng.range(0, 6.28), rng); }
        for (let i = 0; i < 3; i++) { const [x, z] = this.around(t, rng, 0.3, 1.0); this.wreck(x, z, rng.range(0, 6.28), rng); }
    }

    private outpost(t: Territory, rng: Rng): void {
        // A hilltop/dune outpost: a ring of hesco and sandbags, a bunker, rocks, a tower.
        const n = 7;
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2), r = t.radius * 0.7;
            const x = t.x + Math.cos(a) * r, z = t.z + Math.sin(a) * r;
            if (i % 2) this.hesco(x, z, a, 4); else this.nest(x, z, Math.atan2(x - t.x, z - t.z), rng);
        }
        this.building(Math.round(t.x / 2) * 2 + 4, Math.round(t.z / 2) * 2, 8, 6, 1, "concrete", rng, { roof: true, doors: 2, broken: 0.05 });
        this.tower(t.x - 6, t.z - 5, rng);
        // Inside the ring: a second, ruined bunker and sandbag lines across the middle, so the hill
        // is fought over from position to position rather than across an open top.
        const [bx, bz] = this.around(t, rng, 0.35, 0.5);
        this.building(Math.round(bx / 2) * 2, Math.round(bz / 2) * 2, 6, 6, 1, "concrete", rng, { broken: 0.5 });
        for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2 + rng.range(0, 0.8), r = t.radius * rng.range(0.25, 0.5);
            const x = t.x + Math.cos(a) * r, z = t.z + Math.sin(a) * r;
            if (i % 2) this.sandbags(x, z, a, rng.range(3, 5), rng, rng.next() < 0.5);
            else { this.rubble(x, z, rng); this.sandbags(x + Math.cos(a) * 2, z + Math.sin(a) * 2, a + Math.PI / 2, 3, rng); }
        }
        for (let i = 0; i < 8; i++) { const [x, z] = this.around(t, rng, 0.9, 1.6); this.rock(x, z, rng.range(1.2, 3), rng); }
    }

    private headquarters(b: Base, rng: Rng): void {
        // A walled HQ: blast walls with wide gates toward the field, bunkers, helipads (decals).
        const s = b.radius, y = this.height(b.x, b.z), out = b.team === 0 ? 1 : -1;
        const sides: [number, number, number, number][] = [[-s, -s, s, -s], [s, -s, s, s], [s, s, -s, s], [-s, s, -s, -s]];
        sides.forEach(([p, q, r2, w2], i) => {
            const front = (i === 2 && out === 1) || (i === 0 && out === -1);
            const ops: [number, number, number, number][] = front ? [[s * 0.5, 12, 0, 4], [s * 1.5, 12, 0, 4]] : [[s, 8, 0, 4]];
            this.wall(b.x + p, b.z + q, b.x + r2, b.z + w2, 3.6, 1.2, "barrier", ops, y);
        });
        for (let i = 0; i < 4; i++) this.building(b.x + (i % 2 ? 1 : -1) * s * 0.55, b.z + (i < 2 ? -1 : 1) * s * 0.55, 10, 8, 1, "concrete", rng, { roof: true, broken: 0, doors: 2 });
    }

    // --- between sites ---------------------------------------------------------------------

    private buildBetween(rng: Rng): void {
        const b = this.def.biome;
        const count = b === "industrial" ? 420 : b === "city" ? 360 : 380;
        for (let i = 0; i < count; i++) {
            const x = rng.range(-HALF + 20, HALF - 20), z = rng.range(-HALF + 20, HALF - 20);
            if (this.nearSite(x, z, 6) || this.wet(x, z) || this.slope(x, z) > 0.45) continue;
            const roll = rng.next();
            if (b === "city" && roll < 0.35) this.building(Math.round(x / 2) * 2, Math.round(z / 2) * 2, Math.round(rng.range(8, 16) / 2) * 2, Math.round(rng.range(8, 14) / 2) * 2, rng.int(1, 4), rng.next() < 0.5 ? "brick" : "concrete", rng, { broken: 0.55, roof: rng.next() < 0.2 });
            else if (b === "industrial" && roll < 0.3) this.container(x, z, rng.range(0, 6.28), rng, rng.next() < 0.3 ? 2 : 1);
            else if (roll < 0.45) this.rock(x, z, rng.range(1.0, b === "mountain" ? 4.5 : 3), rng);
            else if (roll < 0.6) this.wreck(x, z, rng.range(0, 6.28), rng);
            else if (roll < 0.72) { const yaw = rng.range(0, 6.28); this.wall(x, z, x + Math.sin(yaw) * rng.range(5, 12), z + Math.cos(yaw) * rng.range(5, 12), rng.range(1.1, 2.6), 0.5, b === "mountain" ? "adobe" : "brick", [], this.height(x, z), 0.6, rng); }
            else if (roll < 0.82) this.rubble(x, z, rng);
            else if (roll < 0.9) this.nest(x, z, rng.range(0, 6.28), rng);
            else if (b === "coast") this.add({ x, z, hx: rng.range(1.5, 3), hz: rng.range(1, 2), h: rng.range(1.2, 2.4), lift: 0, yaw: rng.range(0, 3), mat: "glass", kind: "cover" });
            else this.rubble(x, z, rng);
        }
    }

    /**
     * Covered approaches between neighbouring sites, so the ground between territories is a place to
     * move through rather than a killing field. Each site and HQ is linked to its three nearest (HQs
     * to territories only); each link gets a centre lane and, when it is long, a flanking lane
     * bowed out to either side. Along a lane a piece of cover stands every 8-13 m, alternating sides
     * (low walls along the lane to move behind crouched, ruined corners with a window, wrecks, rocks,
     * sandbag nests and the biome's own pieces), and a long link gets a small waystation at its middle
     * to fight over (steep slopes get boulders only). Roads, water and the headquarters stay clear.
     */
    private buildLanes(rng: Rng): void {
        const nodes = [...this.territories.map(t => ({ x: t.x, z: t.z, r: t.radius, base: false })), ...this.bases.map(b => ({ x: b.x, z: b.z, r: b.radius + 6, base: true }))];
        const links = new Set<string>();
        nodes.forEach((a, i) => {
            const near = nodes.map((b, j) => ({ j, d: Math.hypot(a.x - b.x, a.z - b.z) })).filter(q => q.j !== i && !(a.base && nodes[q.j].base)).sort((p, q) => p.d - q.d).slice(0, 3);
            for (const q of near) links.add(`${Math.min(i, q.j)},${Math.max(i, q.j)}`);
        });
        const biome = this.def.biome, mat: Material = biome === "mountain" ? "adobe" : biome === "coast" ? "plaster" : biome === "industrial" ? "concrete" : "brick";
        const placed: [number, number, number][] = [];
        const free = (x: number, z: number, r: number, steep = 0.5) => {
            if (!this.inBounds(x, z, 8) || this.wet(x, z) || this.slope(x, z) > steep || this.inBase(x, z) || this.onRoad(x, z, r * 0.6 + 1) || this.inBuilding(x, z, r)) return false;
            for (const t of this.territories) if (Math.hypot(x - t.x, z - t.z) < t.radius * 0.9) return false;
            for (const [px, pz, pr] of placed) if (Math.hypot(x - px, z - pz) < r + pr) return false;
            for (const b of this.boxes) {
                if (b.kind === "deco") continue;
                const e = Math.max(b.hx, b.hz) + r;
                if (Math.abs(b.x - x) < e && Math.abs(b.z - z) < e && Math.hypot(b.x - x, b.z - z) < e) return false;
            }
            return true;
        };
        // One piece of cover at (x, z), its long side along the lane direction `yaw`.
        const piece = (x: number, z: number, yaw: number): boolean => {
            const roll = rng.next(), c = Math.cos(yaw), sn = Math.sin(yaw), y = this.height(x, z) - 0.05;
            // Steep ground only takes boulders.
            if (this.slope(x, z) > 0.5) {
                if (!free(x, z, 3.5, 0.9)) return false;
                this.rock(x, z, rng.range(1.4, 2.4), rng);
                this.rock(x + rng.range(-2.5, 2.5), z + rng.range(-2.5, 2.5), rng.range(1.0, 1.8), rng);
                placed.push([x, z, 3.5]);
                return true;
            }
            if (roll < 0.24) {
                // A low wall along the lane: move behind it crouched.
                if (!free(x, z, 4)) return false;
                const len = rng.range(4, 7);
                this.wall(x - sn * len / 2, z - c * len / 2, x + sn * len / 2, z + c * len / 2, rng.range(1.15, 1.3), 0.5, biome === "mountain" ? "adobe" : "brick", [], y, 0.3, rng);
                placed.push([x, z, 4]);
            } else if (roll < 0.4) {
                // A ruined corner: two walls head high with a window, cover from two directions.
                if (!free(x, z, 4.5)) return false;
                const h = rng.range(2.3, 3), L = rng.range(4, 6);
                const ax = x - sn * L / 2, az = z - c * L / 2, bx = x + sn * L / 2, bz = z + c * L / 2;
                this.wall(ax, az, bx, bz, h, 0.5, mat, [[L * rng.range(0.35, 0.65), 1.2, 1.0, 2.1]], y, 0.4, rng);
                const k = rng.next() < 0.5 ? 1 : -1, arm = rng.range(3, 4.5);
                this.wall(bx, bz, bx + c * k * arm, bz - sn * k * arm, h, 0.5, mat, [], y, 0.5, rng);
                this.rubble(x + c * k * 1.6, z - sn * k * 1.6, rng);
                placed.push([x, z, 4.5]);
            } else if (roll < 0.52) {
                if (!free(x, z, 4)) return false;
                this.wreck(x, z, yaw + rng.range(-0.4, 0.4), rng);
                placed.push([x, z, 4]);
            } else if (roll < 0.64) {
                if (!free(x, z, 3.5)) return false;
                this.rock(x, z, rng.range(1.3, 2.2), rng);
                this.rock(x + rng.range(-2.5, 2.5), z + rng.range(-2.5, 2.5), rng.range(1.0, 1.6), rng);
                placed.push([x, z, 3.5]);
            } else if (roll < 0.74) {
                if (!free(x, z, 3.5)) return false;
                this.nest(x, z, yaw + (rng.next() < 0.5 ? Math.PI / 2 : -Math.PI / 2), rng);
                placed.push([x, z, 3.5]);
            } else if (roll < 0.82) {
                if (!free(x, z, 3)) return false;
                this.rubble(x, z, rng);
                this.rubble(x + rng.range(-2, 2), z + rng.range(-2, 2), rng);
                placed.push([x, z, 3]);
            } else {
                if (!free(x, z, 4)) return false;
                if (biome === "industrial") { if (rng.next() < 0.5) this.container(x, z, yaw, rng); else this.hesco(x, z, yaw + Math.PI / 2, 4); }
                else if (biome === "city") { if (rng.next() < 0.5) this.barrier(x, z, yaw + Math.PI / 2, 3); else this.sandbags(x, z, yaw, 4, rng); }
                else if (biome === "coast") this.add({ x, z, hx: rng.range(1.2, 2.2), hz: rng.range(1, 1.8), h: rng.range(1.2, 2.2), lift: 0, yaw: rng.range(0, 3), mat: "glass", kind: "cover" });
                else { this.add({ x, z, hx: 0.6, hz: 0.6, h: 1.2, lift: 0, yaw, mat: "wood", kind: "cover" }); this.add({ x: x + 1.4, z: z + 0.3, hx: 0.5, hz: 0.5, h: 1.0, lift: 0, yaw: yaw + 0.4, mat: "wood", kind: "cover" }); }
                placed.push([x, z, 4]);
            }
            return true;
        };
        // A small waystation halfway along a long link: a ruined house, a low wall, a nest.
        const waystation = (x: number, z: number, yaw: number): boolean => {
            if (!free(x, z, 9)) return false;
            const c = Math.cos(yaw), sn = Math.sin(yaw), y = this.height(x, z) - 0.05;
            const hx = Math.round((x + c * 5) / 2) * 2, hz = Math.round((z - sn * 5) / 2) * 2;
            if (biome === "industrial") { this.container(x - c * 5, z + sn * 5, yaw, rng); this.building(hx, hz, 6, 6, 1, "concrete", rng, { roof: true, broken: 0.1 }); }
            else this.building(hx, hz, rng.int(3, 4) * 2, 6, 1, mat, rng, { roof: rng.next() < 0.4, broken: 0.4 });
            this.wall(x - c * 9 - sn * 3, z + sn * 9 - c * 3, x - c * 9 + sn * 3, z + sn * 9 + c * 3, 1.2, 0.5, mat, [], y, 0.3, rng);
            this.nest(x - c * 2 + sn * 6, z + sn * 2 + c * 6, yaw, rng);
            placed.push([x, z, 10]);
            return true;
        };
        for (const key of links) {
            const [i, j] = key.split(",").map(Number), a = nodes[i], b = nodes[j];
            const L = Math.hypot(b.x - a.x, b.z - a.z), ux = (b.x - a.x) / L, uz = (b.z - a.z) / L, nx = -uz, nz = ux;
            const s0 = a.r * 0.85, s1 = L - b.r * 0.85, gap = s1 - s0;
            if (gap < 16) continue;
            for (const bow of gap > 70 ? [0, 1, -1] : [0]) {
                const off = bow * Math.min(45, Math.max(18, gap * 0.22));
                let side = rng.next() < 0.5 ? 1 : -1, station = bow !== 0 || gap <= 110;
                for (let s = s0 + rng.range(2, 6); s < s1; s += rng.range(8, 13)) {
                    const f = (s - s0) / gap, bend = off * 4 * f * (1 - f);
                    // The lane's direction (with the bow's slope) lays the cover's long side along it.
                    const slope = off * 4 * (1 - 2 * f) / gap, yaw = Math.atan2(ux + nx * slope, uz + nz * slope);
                    const cx = a.x + ux * s + nx * bend, cz = a.z + uz * s + nz * bend;
                    if (!station && f > 0.42 && waystation(cx, cz, yaw)) { station = true; continue; }
                    // Beside the lane, or the other side, or out past a road's shoulder when the lane is a road.
                    const d = side * rng.range(2.5, 5);
                    for (const o of [d, -d, d * 2.8, -d * 2.8, 12, -12]) if (piece(cx + nx * o, cz + nz * o, yaw)) break;
                    side = -side;
                }
            }
        }
    }

    private buildFoliage(rng: Rng): void {
        const b = this.def.biome;
        const kinds: Foliage["kind"][] = b === "coast" ? ["palm", "dead", "bush", "reed"] : b === "mountain" ? ["pine", "pine", "bush", "tree"] : b === "industrial" ? ["dead", "bush", "tree"] : ["tree", "bush", "pine", "bush"];
        const n = b === "mountain" ? 2600 : b === "industrial" ? 900 : 1800;
        for (let i = 0; i < n; i++) {
            // Clumps: pick a seed point, then a few around it.
            const cx = rng.range(-HALF + 8, HALF - 8), cz = rng.range(-HALF + 8, HALF - 8);
            const kind = rng.pick(kinds), m = kind === "bush" || kind === "reed" ? rng.int(2, 6) : rng.int(1, 3);
            for (let k = 0; k < m; k++) {
                const x = cx + rng.range(-7, 7), z = cz + rng.range(-7, 7);
                if (!this.inBounds(x, z, 4) || this.wet(x, z) || this.slope(x, z) > 0.8) continue;
                if (this.onRoad(x, z) || this.inBase(x, z) || this.inBuilding(x, z, 1)) continue;
                if (kind !== "bush" && kind !== "reed" && this.nearBox(x, z)) continue;
                const size = kind === "pine" ? rng.range(7, 13) : kind === "tree" ? rng.range(6, 10) : kind === "palm" ? rng.range(7, 11) : kind === "dead" ? rng.range(4, 7) : kind === "reed" ? rng.range(1.2, 2) : rng.range(1.2, 2.2);
                this.foliage.push({ x, z, y: this.height(x, z), kind, size, seed: rng.next() });
            }
        }
        for (const f of this.foliage) {
            const i = Math.floor((f.x + HALF) / NAV_INF), j = Math.floor((f.z + HALF) / NAV_INF);
            const r = f.kind === "bush" || f.kind === "reed" ? 1 : 0;
            for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
                const ii = i + di, jj = j + dj;
                if (ii < 0 || jj < 0 || ii >= NI || jj >= NI) continue;
                const v = f.kind === "bush" ? 170 : f.kind === "reed" ? 140 : 60;
                this.conceal[jj * NI + ii] = Math.max(this.conceal[jj * NI + ii], (di || dj) ? v >> 1 : v);
            }
        }
    }

    private onRoad(x: number, z: number, pad = 1.5): boolean { for (const r of this.roads) if (roadDistance(r, x, z).d < r.width * 0.5 + pad) return true; return false; }
    private inBase(x: number, z: number): boolean { for (const b of this.bases) if (Math.abs(x - b.x) < b.radius + 4 && Math.abs(z - b.z) < b.radius + 4) return true; return false; }
    private nearBox(x: number, z: number): boolean {
        const i = Math.floor(x + HALF), j = Math.floor(z + HALF);
        for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) { const ii = i + di, jj = j + dj; if (ii >= 0 && jj >= 0 && ii < CN && jj < CN && this.lo[jj * CN + ii] > 0) return true; }
        return false;
    }

    // --- rasterizing ---------------------------------------------------------------------------

    private rasterizeAll(): void {
        this.boxes.forEach((b, i) => { if (b.kind !== "deco") this.rasterize(b, i); });
        // Tree trunks are solid (1 cell); dead trees and palms too.
        for (const f of this.foliage) {
            if (f.kind === "bush" || f.kind === "reed") continue;
            const i = Math.floor(f.x + HALF), j = Math.floor(f.z + HALF);
            if (i >= 0 && j >= 0 && i < CN && j < CN) { const k = j * CN + i; this.lo[k] = Math.max(this.lo[k], Math.min(255, Math.round(f.size * 6))); this.trunk[k] = 1; }
        }
    }

    /** Writes a box into the cover grid (cells whose centers are inside it). */
    rasterize(b: Box, index: number): void {
        const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
        const ex = Math.abs(c) * b.hx + Math.abs(s) * b.hz, ez = Math.abs(s) * b.hx + Math.abs(c) * b.hz;
        const i0 = Math.max(0, Math.floor(b.x - ex + HALF)), i1 = Math.min(CN - 1, Math.floor(b.x + ex + HALF));
        const j0 = Math.max(0, Math.floor(b.z - ez + HALF)), j1 = Math.min(CN - 1, Math.floor(b.z + ez + HALF));
        if (!this.bucketed.has(index)) {
            this.bucketed.add(index);
            for (let bj = Math.floor((j0 - 1) / BUCKET); bj <= Math.floor((j1 + 1) / BUCKET); bj++)
                for (let bi = Math.floor((i0 - 1) / BUCKET); bi <= Math.floor((i1 + 1) / BUCKET); bi++)
                    if (bi >= 0 && bj >= 0 && bi < NB && bj < NB) this.buckets[bj * NB + bi].push(index);
        }
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
            const px = i - HALF + 0.5 - b.x, pz = j - HALF + 0.5 - b.z;
            // Box local axes: x' = (c, -s), z' = (s, c) for a yaw about +y (0 faces +z).
            const lx = px * c - pz * s, lz = px * s + pz * c;
            if (Math.abs(lx) > b.hx + 0.25 || Math.abs(lz) > b.hz + 0.25) continue;
            const k = j * CN + i, g = this.height(i - HALF + 0.5, j - HALF + 0.5);
            const bottom = b.y - g, top = bottom + b.h;
            const top10 = Math.max(0, Math.min(255, Math.round(top * 10)));
            if (bottom <= 0.25) {
                if (top10 > this.lo[k]) this.lo[k] = top10;
            } else {
                const bot10 = Math.round(bottom * 10);
                if (bot10 <= this.lo[k]) { if (top10 > this.lo[k]) this.lo[k] = top10; }
                else if (this.gap[k] === 0 || bot10 < this.gap[k]) { this.gap[k] = bot10; if (top10 > this.hi[k]) this.hi[k] = top10; }
                else if (top10 > this.hi[k]) this.hi[k] = top10;
            }
            this.owner[k] = index + 1;
        }
    }

    /** Clears a destroyed box from the cover grid (other boxes in those cells are rewritten). */
    destroy(index: number): void {
        const b = this.boxes[index];
        if (!b) return;
        const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
        const ex = Math.abs(c) * b.hx + Math.abs(s) * b.hz + 1, ez = Math.abs(s) * b.hx + Math.abs(c) * b.hz + 1;
        const cells: number[] = [];
        for (let j = Math.max(0, Math.floor(b.z - ez + HALF)); j <= Math.min(CN - 1, Math.floor(b.z + ez + HALF)); j++)
            for (let i = Math.max(0, Math.floor(b.x - ex + HALF)); i <= Math.min(CN - 1, Math.floor(b.x + ex + HALF)); i++)
                if (this.owner[j * CN + i] === index + 1) { const k = j * CN + i; this.lo[k] = 0; this.gap[k] = 0; this.hi[k] = 0; this.owner[k] = 0; cells.push(k); }
        b.kind = "deco"; b.h = Math.min(b.h, 0.3);
        // Rebuild neighbours that overlapped those cells.
        for (let n = 0; n < this.boxes.length; n++) {
            const o = this.boxes[n];
            if (o.kind === "deco" || Math.abs(o.x - b.x) > 12 || Math.abs(o.z - b.z) > 12) continue;
            this.rasterize(o, n);
        }
        this.refreshNav(b.x, b.z, Math.max(ex, ez) + 2);
    }

    // --- queries ----------------------------------------------------------------------------

    cellIndex(x: number, z: number): number {
        const i = Math.floor(x + HALF), j = Math.floor(z + HALF);
        return i < 0 || j < 0 || i >= CN || j >= CN ? -1 : j * CN + i;
    }

    /** True when a point (world y) is inside something solid. */
    solidAt(x: number, y: number, z: number): boolean {
        const k = this.cellIndex(x, z);
        if (k < 0) return true;
        const h = (y - this.height(x, z)) * 10;
        if (h < 0) return true;
        if (h < this.lo[k]) return true;
        return this.gap[k] > 0 && h >= this.gap[k] && h < this.hi[k];
    }

    /** Height (m above ground) a soldier at this cell can step onto or stands behind: the low span. */
    coverHeight(x: number, z: number): number { const k = this.cellIndex(x, z); return k < 0 ? 99 : this.lo[k] / 10; }

    /**
     * The first solid point on the segment a -> b, as a fraction (1: clear). Steps through the 1 m
     * cover grid (DDA) and checks the ray's height above the ground at each cell boundary and middle.
     * The grid is coarse (boxes are padded a quarter metre into it, so a 1.2 m window keeps at most
     * one open cell), so where it says solid the real blocks in that cell are tested and the ray
     * goes on if it misses them all: shots and sight pass through windows, doors and gaps as drawn.
     */
    trace(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
        const dx = bx - ax, dy = by - ay, dz = bz - az, L = Math.hypot(dx, dz);
        if (L < 1e-6) return this.solidAt(ax, ay, az) ? 0 : 1;
        let i = Math.floor(ax + HALF), j = Math.floor(az + HALF);
        const si = dx > 0 ? 1 : -1, sj = dz > 0 ? 1 : -1;
        const tdx = Math.abs(1 / (dx || 1e-12)), tdz = Math.abs(1 / (dz || 1e-12));
        let tx = dx > 0 ? (i + 1 - (ax + HALF)) * tdx : ((ax + HALF) - i) * tdx;
        let tz = dz > 0 ? (j + 1 - (az + HALF)) * tdz : ((az + HALF) - j) * tdz;
        let t = 0;
        const steps = Math.ceil(Math.abs(dx)) + Math.ceil(Math.abs(dz)) + 2;
        for (let n = 0; n < steps && t <= 1; n++) {
            const tn = Math.min(tx, tz, 1);
            // Sample the ray in this cell at its entry, middle and exit.
            for (const f of [t, (t + tn) / 2, tn]) {
                if (i < 0 || j < 0 || i >= CN || j >= CN) return f;
                const x = ax + dx * f, y = ay + dy * f, z = az + dz * f;
                const k = j * CN + i, h = (y - this.height(x, z)) * 10;
                if (h < 0) return f;
                if (h < this.lo[k] || (this.gap[k] > 0 && h >= this.gap[k] && h < this.hi[k])) {
                    const e = this.exact(ax, ay, az, dx, dy, dz, i, j, t, tn);
                    if (e >= 0) return e;
                    break;
                }
            }
            if (tn >= 1) break;
            t = tn;
            if (tx < tz) { tx += tdx; i += si; } else { tz += tdz; j += sj; }
        }
        return 1;
    }

    /**
     * The first hit, as a fraction of the segment within [t0, t1] (a little slack either side), on
     * the blocks that fill cover cell (i, j), or -1 when the segment slips past them all. Trunks,
     * rocks and domes are not boxes when drawn, so the grid stands for them: their cells always hit.
     */
    private exact(ax: number, ay: number, az: number, dx: number, dy: number, dz: number, i: number, j: number, t0: number, t1: number): number {
        const k = j * CN + i;
        if (this.trunk[k]) return t0;
        const cx = i - HALF + 0.5, cz = j - HALF + 0.5;
        const list = this.buckets[Math.floor(j / BUCKET) * NB + Math.floor(i / BUCKET)];
        let best = Infinity, any = false;
        for (const n of list) {
            const b = this.boxes[n];
            if (b.kind === "deco") continue;
            const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
            // Does the box reach this cell at all (as rasterized)?
            const qx = cx - b.x, qz = cz - b.z;
            if (Math.abs(qx * c - qz * s) > b.hx + 0.25 + 0.71 || Math.abs(qx * s + qz * c) > b.hz + 0.25 + 0.71) continue;
            if (b.mat === "rock" || b.mat === "dome") return t0;
            any = true;
            // Slab test in the box's frame: x' = (c, -s), z' = (s, c), y from b.y to b.y + h.
            const ox = (ax - b.x) * c - (az - b.z) * s, oz = (ax - b.x) * s + (az - b.z) * c, oy = ay - b.y;
            const vx = dx * c - dz * s, vz = dx * s + dz * c, vy = dy;
            let lo = -Infinity, hi = Infinity;
            for (const [o, v, a, z] of [[ox, vx, -b.hx, b.hx], [oy, vy, 0, b.h], [oz, vz, -b.hz, b.hz]]) {
                if (Math.abs(v) < 1e-12) { if (o < a || o > z) { lo = Infinity; break; } continue; }
                let p = (a - o) / v, q = (z - o) / v;
                if (p > q) { const w = p; p = q; q = w; }
                if (p > lo) lo = p;
                if (q < hi) hi = q;
            }
            if (lo > hi || hi < 0) continue;
            const at = Math.max(lo, 0);
            if (at <= t1 + 0.02 / Math.max(1e-6, Math.hypot(dx, dz)) + 1e-6 && at < best) best = at;
        }
        // A solid cell no box claims: the grid stands.
        if (!any) return t0;
        return best === Infinity ? -1 : best;
    }

    /** The box blocking a trace at fraction f, if any (for destructible cover). */
    boxAt(ax: number, az: number, bx: number, bz: number, f: number): number {
        const k = this.cellIndex(ax + (bx - ax) * Math.min(1, f + 0.01), az + (bz - az) * Math.min(1, f + 0.01));
        return k < 0 ? -1 : this.owner[k] - 1;
    }

    concealAt(x: number, z: number): number {
        const i = Math.floor((x + HALF) / NAV_INF), j = Math.floor((z + HALF) / NAV_INF);
        return i < 0 || j < 0 || i >= NI || j >= NI ? 0 : this.conceal[j * NI + i] / 255;
    }
    roofAt(x: number, z: number): boolean {
        const i = Math.floor((x + HALF) / NAV_INF), j = Math.floor((z + HALF) / NAV_INF);
        return i >= 0 && j >= 0 && i < NI && j < NI && this.roofed[j * NI + i] === 1;
    }

    // --- navigation -----------------------------------------------------------------------------

    private buildNav(): void {
        for (let j = 0; j < NI; j++) for (let i = 0; i < NI; i++) this.navInf[j * NI + i] = this.infCell(i, j);
        for (let j = 0; j < NV; j++) for (let i = 0; i < NV; i++) this.navVeh[j * NV + i] = this.vehCell(i, j);
    }
    private refreshNav(x: number, z: number, r: number): void {
        for (let j = Math.floor((z - r + HALF) / NAV_INF); j <= Math.floor((z + r + HALF) / NAV_INF); j++)
            for (let i = Math.floor((x - r + HALF) / NAV_INF); i <= Math.floor((x + r + HALF) / NAV_INF); i++)
                if (i >= 0 && j >= 0 && i < NI && j < NI) this.navInf[j * NI + i] = this.infCell(i, j);
        for (let j = Math.floor((z - r + HALF) / NAV_VEH); j <= Math.floor((z + r + HALF) / NAV_VEH); j++)
            for (let i = Math.floor((x - r + HALF) / NAV_VEH); i <= Math.floor((x + r + HALF) / NAV_VEH); i++)
                if (i >= 0 && j >= 0 && i < NV && j < NV) this.navVeh[j * NV + i] = this.vehCell(i, j);
        this.flowCache.clear();
    }
    /** 1 when an infantry 2 m cell is blocked (anything at least 0.6 m in it, or water, or a cliff). */
    private infCell(i: number, j: number): number {
        const x = i * NAV_INF - HALF + 1, z = j * NAV_INF - HALF + 1;
        if (this.wet(x, z) || this.slope(x, z) > 1.1 || !this.inBounds(x, z, 2)) return 1;
        let open = 0;
        for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) { const k = (j * 2 + dj) * CN + i * 2 + di; if (this.lo[k] < 6) open++; }
        return open >= 2 ? 0 : 1;
    }
    /** 1 when a vehicle 4 m cell is blocked (walls, big props; cover boxes it can push through are not). */
    private vehCell(i: number, j: number): number {
        const x = i * NAV_VEH - HALF + 2, z = j * NAV_VEH - HALF + 2;
        if (this.wet(x, z) || this.slope(x, z) > 0.6 || !this.inBounds(x, z, 6)) return 1;
        let solid = 0;
        for (let dj = 0; dj < 4; dj++) for (let di = 0; di < 4; di++) { const k = (j * 4 + dj) * CN + i * 4 + di; if (this.lo[k] >= 14) solid++; }
        return solid >= 3 ? 1 : 0;
    }
    infBlocked(x: number, z: number): boolean {
        const i = Math.floor((x + HALF) / NAV_INF), j = Math.floor((z + HALF) / NAV_INF);
        return i < 0 || j < 0 || i >= NI || j >= NI || this.navInf[j * NI + i] === 1;
    }
    vehBlocked(x: number, z: number): boolean {
        const i = Math.floor((x + HALF) / NAV_VEH), j = Math.floor((z + HALF) / NAV_VEH);
        return i < 0 || j < 0 || i >= NV || j >= NV || this.navVeh[j * NV + i] === 1;
    }

    /**
     * Distance field to a target (a territory id, "base0"/"base1", or "x,z"), infantry ("inf") or
     * vehicle ("veh") grid, in WIR path units (straight 2, diagonal 3, no corner cutting). Cached.
     */
    flow(target: string, kind: "inf" | "veh" = "inf"): Uint16Array {
        const key = `${kind}:${target}`;
        const hit = this.flowCache.get(key);
        if (hit) return hit;
        let tx: number, tz: number, r: number;
        const t = this.territories.find(q => q.id === target);
        if (t) { tx = t.x; tz = t.z; r = t.radius * 0.5; }
        else if (target.startsWith("base")) { const b = this.bases[Number(target.slice(4))]; tx = b.x; tz = b.z; r = b.radius * 0.6; }
        else { const [a, b] = target.split(",").map(Number); tx = a; tz = b; r = 3; }
        const field = distanceField(kind === "inf" ? this.navInf : this.navVeh, kind === "inf" ? NI : NV, kind === "inf" ? NAV_INF : NAV_VEH, tx, tz, r);
        if (this.flowCache.size > 64) this.flowCache.delete(this.flowCache.keys().next().value!);
        this.flowCache.set(key, field);
        return field;
    }

    /** A field's value at a world point (FAR outside or blocked). */
    static sample(field: Uint16Array, n: number, cell: number, x: number, z: number): number {
        const i = Math.floor((x + HALF) / cell), j = Math.floor((z + HALF) / cell);
        return i < 0 || j < 0 || i >= n || j >= n ? FAR : field[j * n + i];
    }

    /** A spawn point on open ground near (x, z): the nearest unblocked infantry cell in a spiral. */
    openNear(x: number, z: number, spread = 0, rng?: Rng): [number, number] {
        const r0 = rng ? rng.range(0, spread) : 0, a0 = rng ? rng.range(0, 6.283) : 0;
        const sx = x + Math.cos(a0) * r0, sz = z + Math.sin(a0) * r0;
        for (let r = 0; r < 40; r++) for (let k = 0; k < Math.max(1, r * 8); k++) {
            const a = (k / Math.max(1, r * 8)) * Math.PI * 2, px = sx + Math.cos(a) * r * NAV_INF, pz = sz + Math.sin(a) * r * NAV_INF;
            if (!this.infBlocked(px, pz)) return [Math.floor((px + HALF) / NAV_INF) * NAV_INF - HALF + 1, Math.floor((pz + HALF) / NAV_INF) * NAV_INF - HALF + 1];
        }
        return [x, z];
    }
    vehOpenNear(x: number, z: number): [number, number] {
        for (let r = 0; r < 30; r++) for (let k = 0; k < Math.max(1, r * 8); k++) {
            const a = (k / Math.max(1, r * 8)) * Math.PI * 2, px = x + Math.cos(a) * r * NAV_VEH, pz = z + Math.sin(a) * r * NAV_VEH;
            if (!this.vehBlocked(px, pz)) return [Math.floor((px + HALF) / NAV_VEH) * NAV_VEH - HALF + 2, Math.floor((pz + HALF) / NAV_VEH) * NAV_VEH - HALF + 2];
        }
        return [x, z];
    }
}

const rot = (x: number, z: number, yaw: number): [number, number] => [x * Math.cos(yaw) + z * Math.sin(yaw), -x * Math.sin(yaw) + z * Math.cos(yaw)];

function roadDistance(r: Road, x: number, z: number): { d: number; px: number; pz: number } {
    let best = Infinity, px = x, pz = z;
    for (let i = 0; i + 1 < r.pts.length; i++) {
        const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
        const vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz;
        const t = l2 ? clamp(((x - ax) * vx + (z - az) * vz) / l2) : 0;
        const d = Math.hypot(x - ax - vx * t, z - az - vz * t);
        if (d < best) { best = d; px = ax + vx * t; pz = az + vz * t; }
    }
    return { d: best, px, pz };
}

/** Dial's algorithm over an 8-move grid: straight 2, diagonal 3, no cutting blocked corners. */
export function distanceField(blocked: Uint8Array, n: number, cell: number, tx: number, tz: number, radius: number): Uint16Array {
    const d = new Uint16Array(n * n).fill(FAR);
    const buckets: number[][] = [];
    const push = (k: number, v: number) => { (buckets[v] ??= []).push(k); };
    const ci = Math.floor((tx + HALF) / cell), cj = Math.floor((tz + HALF) / cell), cr = Math.max(0, Math.ceil(radius / cell));
    for (let j = cj - cr; j <= cj + cr; j++) for (let i = ci - cr; i <= ci + cr; i++) {
        if (i < 0 || j < 0 || i >= n || j >= n || (i - ci) ** 2 + (j - cj) ** 2 > cr * cr + 1) continue;
        const k = j * n + i;
        if (blocked[k]) continue;
        d[k] = 0; push(k, 0);
    }
    if (!buckets[0]) {
        // Target inside something solid: seed from the nearest open cell.
        let best = -1, bd = Infinity;
        for (let j = Math.max(0, cj - 20); j < Math.min(n, cj + 20); j++) for (let i = Math.max(0, ci - 20); i < Math.min(n, ci + 20); i++) if (!blocked[j * n + i]) { const q = (i - ci) ** 2 + (j - cj) ** 2; if (q < bd) { bd = q; best = j * n + i; } }
        if (best < 0) return d;
        d[best] = 0; push(best, 0);
    }
    for (let v = 0; v < buckets.length; v++) {
        const list = buckets[v];
        if (!list) continue;
        for (let q = 0; q < list.length; q++) {
            const k = list[q];
            if (d[k] !== v) continue;
            const i = k % n, j = (k - i) / n;
            for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
                if (!di && !dj) continue;
                const ii = i + di, jj = j + dj;
                if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
                const kk = jj * n + ii;
                if (blocked[kk]) continue;
                if (di && dj && (blocked[j * n + ii] || blocked[jj * n + i])) continue;
                const nv = v + (di && dj ? 3 : 2);
                if (nv < d[kk] && nv < FAR) { d[kk] = nv; push(kk, nv); }
            }
        }
        buckets[v] = undefined as unknown as number[];
    }
    return d;
}

const worlds = new Map<string, World>();
/** Builds a map once and keeps it (maps take about a second to build). */
export function worldFor(id: string): World {
    let w = worlds.get(id);
    if (!w) { const def = MAPS.find(m => m.id === id); if (!def) throw new Error(`No map ${id}`); w = new World(def); worlds.set(id, w); }
    return w;
}
