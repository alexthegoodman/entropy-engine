// The Abyss: the world of Chapter One, as plain functions and baked grids.
//
// The map is 3.2 km square (x east, z north, y up, meters; the rim of the crack is near y = 0).
// The crack the Deep Bore tore open covers about half of it: a jagged superellipse 2.9 km long
// and 1.8 km wide, nearly straight down to a cavern floor 540 m below. The walls fall in terraces
// (vertical faces between narrow ledges, the strata of the planet's crust); scree banks against
// their feet. On the floor run the dry bed of the sacred river from the Source - a waterfall in
// the east wall - and the ruins of the first settlement the expedition finds.
//
// Gameplay landmarks, in order of the chapter:
// - the forward base on the south rim, where the gunships stage;
// - Ledge Kilo, a broad shelf 238 m down the south wall where Alex's dropship sets down;
// - the rockslide: a ramp of fallen wall running east along the wall from the ledge to the floor;
// - the settlement and its shrine by the riverbed, and the evacuation landing zone.
//
// `heightRaw` is the analytic ground. Everything else (rendered terrain, walking, shadows) reads
// the baked HeightGrid, so what you see is what you walk on.

export const MAP_HALF = 1600;
/** Cells across the baked height grid (3.125 m each). */
export const GRID = 1024;
export const CELL = (2 * MAP_HALF) / GRID;
export const RIM_Y = 0;
export const FLOOR_Y = -540;
export const LEDGE_Y = -238;

/** The crack's outline: a superellipse with half axes A (east-west) and B (north-south). */
export const CRACK_A = 1340;
export const CRACK_B = 900;
export const CRACK_P = 2.4;

export type V2 = [number, number];
export type V3 = [number, number, number];

// --- Noise -------------------------------------------------------------------------------------

function hash2(ix: number, iz: number, seed: number): number {
    let h = (Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

/** Smooth value noise in 0..1. */
export function vnoise(x: number, z: number, seed = 0): number {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
    const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
    const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
    return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/** Fractal noise in roughly -1..1. */
export function fbm(x: number, z: number, octaves = 4, seed = 0): number {
    let sum = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < octaves; o++) {
        sum += (vnoise(x, z, seed + o * 17) * 2 - 1) * amp;
        norm += amp;
        x = x * 2.03 + 17.1; z = z * 2.03 - 9.7;
        amp *= 0.5;
    }
    return sum / norm;
}

/** Ridged fractal noise in 0..1: sharp crests (scree, rubble). */
export function ridged(x: number, z: number, octaves = 3, seed = 0): number {
    let sum = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < octaves; o++) {
        const n = 1 - Math.abs(vnoise(x, z, seed + o * 31) * 2 - 1);
        sum += n * n * amp;
        norm += amp;
        x = x * 2.1 + 5.3; z = z * 2.1 + 1.9;
        amp *= 0.5;
    }
    return sum / norm;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const smoothstep = (a: number, b: number, v: number): number => {
    const t = clamp((v - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// --- Landmarks ----------------------------------------------------------------------------------

/** The forward operating base on the south rim (surface). */
export const FOB: V2 = [-640, -1180];
/** Ledge Kilo: the shelf on the south wall (its center). */
export const LEDGE: V2 = [-640, -770];
/** The rockslide ramp: from the east end of the ledge down to the floor, along the south wall. */
export const RAMP_TOP_X = -470;
export const RAMP_FOOT_X = 140;
/** The settlement on the cavern floor, its shrine by the riverbed, the evacuation landing zone. */
export const SETTLEMENT: V2 = [300, -430];
export const SHRINE: V2 = [318, -476];
export const EVAC_LZ: V2 = [-40, -540];
/** The Source: the sacred waterfall in the east wall, and its pool on the floor. */
export const SOURCE: V3 = [1405, -150, 70];
export const SOURCE_POOL: V2 = [1340, 70];

/** The riverbed from the Source pool west across the floor (meandering, mostly dry now). */
export const RIVER: readonly V2[] = [
    [1350, 70], [1200, 20], [960, -110], [720, -290], [500, -410], [330, -470], [140, -400],
    [-140, -280], [-450, -210], [-760, -130], [-1060, -50], [-1380, -10],
];

/** Blast craters on the surface around the rim: x, z, radius, depth. */
export const CRATERS: readonly [number, number, number, number][] = [
    [-1150, -1250, 70, 9], [200, -1260, 95, 12], [900, -1150, 60, 7], [-300, 1180, 110, 14], [700, 1260, 80, 10],
    [-1350, 1050, 55, 6], [1380, -1050, 75, 9],
];

// --- The crack ----------------------------------------------------------------------------------

/** How far the outline is pushed out (fraction of the radius) in direction (cx, cz): big lobes, notches and spikes. */
function jag(cx: number, cz: number): number {
    const lobes = fbm(cx * 1.4 + 3, cz * 1.4 - 2, 3, 101) * 0.15;
    const notches = fbm(cx * 5 + 11, cz * 5 + 7, 3, 202) * 0.06;
    // A fracture's zigzag: a triangle wave round the outline, its phase wandering.
    const a = Math.atan2(cz, cx) / (Math.PI * 2);
    const ph = a * 34 + fbm(cx * 3, cz * 3, 2, 404) * 1.6;
    const zig = (Math.abs(ph - Math.floor(ph) - 0.5) * 2 - 0.5) * 0.035;
    const spikes = (ridged(cx * 22, cz * 22, 2, 303) - 0.35) * 0.008;
    return lobes + notches + zig + spikes;
}

/** The rift bends: its center line wanders north and south along x. */
export const riftBend = (x: number): number => 70 * Math.sin(x / 470 + 0.6) + 28 * Math.sin(x / 160 + 2.1);

/**
 * Signed distance (m, approximate) from the crack's rim: negative inside the crack. Returns the
 * outline direction too (unit, normalized space) for anything placed along the rim.
 */
export function crackSD(x: number, z0: number): number {
    const z = z0 - riftBend(x);
    const nx = Math.abs(x) / CRACK_A, nz = Math.abs(z) / CRACK_B;
    const rho = Math.pow(Math.pow(nx, CRACK_P) + Math.pow(nz, CRACK_P), 1 / CRACK_P);
    const len = Math.hypot(x / CRACK_A, z / CRACK_B) || 1;
    const cx = x / CRACK_A / len, cz = z / CRACK_B / len;
    const edge = 1 + jag(cx, cz);
    // Meters per unit of rho along this direction (the radius there).
    const radius = Math.hypot(CRACK_A * cx, CRACK_B * cz);
    return (rho - edge) * radius;
}

// --- Height ---------------------------------------------------------------------------------------

function polylineDistance(x: number, z: number, line: readonly V2[]): { d: number; t: number } {
    let best = Infinity, bestT = 0, acc = 0, total = 0;
    for (let i = 0; i + 1 < line.length; i++) total += Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
    for (let i = 0; i + 1 < line.length; i++) {
        const [ax, az] = line[i], [bx, bz] = line[i + 1];
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
        const s = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
        const d = Math.hypot(x - ax - dx * s, z - az - dz * s);
        const seg = Math.sqrt(l2);
        if (d < best) { best = d; bestT = (acc + seg * s) / total; }
        acc += seg;
    }
    return { d: best, t: bestT };
}

/** Distance to the riverbed's center line (m) and how far along it from the Source (0..1). */
export function riverDistance(x: number, z: number): { d: number; t: number } {
    return polylineDistance(x, z, RIVER);
}

/** The scorched surface plain: gentle relief, the blast lip around the rim, craters, the base pad. */
export function surfaceHeight(x: number, z: number, d: number): number {
    let h = 7 * fbm(x / 420, z / 420, 4, 11) + 2.5 * fbm(x / 95, z / 95, 3, 12);
    // Ejecta thrown up around the rim.
    const out = Math.max(0, d);
    h += (9 + 6 * fbm(x / 160, z / 160, 2, 13)) * Math.exp(-out / 85) * smoothstep(-30, 10, d);
    // Hills rise toward the map edge (and beyond it, see outerHeight).
    const edge = Math.max(Math.abs(x), Math.abs(z));
    h += smoothstep(1250, 1650, edge) * (30 + 25 * fbm(x / 300, z / 300, 2, 14));
    for (const [cx, cz, r, depth] of CRATERS) {
        const q = Math.hypot(x - cx, z - cz) / r;
        if (q < 1.6) h += -depth * Math.max(0, 1 - q * q) + depth * 0.35 * Math.exp(-((q - 1.05) ** 2) * 18);
    }
    // The forward base stands on a leveled pad.
    const pad = Math.hypot(x - FOB[0], z - FOB[1]);
    h = lerp(h, 2, 1 - smoothstep(150, 230, pad));
    return h;
}

/** The cavern floor: rubble, the riverbed, the leveled settlement, scree against the walls. */
export function floorHeight(x: number, z: number, inside: number): number {
    let h = FLOOR_Y + 6 * fbm(x / 210, z / 210, 3, 21) + 3.5 * (ridged(x / 45, z / 45, 3, 22) - 0.45);
    // The settlement's terraces are leveled ground.
    const s = Math.hypot(x - SETTLEMENT[0], z - SETTLEMENT[1]);
    h = lerp(h, FLOOR_Y + 1.5 + 1.2 * fbm(x / 120, z / 120, 2, 23), 1 - smoothstep(170, 260, s));
    // So is the evacuation landing zone.
    const lz = Math.hypot(x - EVAC_LZ[0], z - EVAC_LZ[1]);
    h = lerp(h, FLOOR_Y + 1, 1 - smoothstep(45, 90, lz));
    // The riverbed: a channel with soft banks, deeper toward the Source.
    const river = riverDistance(x, z);
    const width = 16 + 12 * (1 - river.t);
    h -= (3.5 + 3 * (1 - river.t)) * (1 - smoothstep(width * 0.5, width * 1.5, river.d));
    // The Source's pool.
    const pool = Math.hypot(x - SOURCE_POOL[0], z - SOURCE_POOL[1]);
    h -= 9 * (1 - smoothstep(30, 95, pool));
    // Scree banked against the walls (talus), steepest where it meets them.
    const talus = Math.max(0, 1 - inside / 300);
    h += talus * talus * (70 + 45 * fbm(x / 140, z / 140, 2, 24)) * (0.8 + 0.4 * ridged(x / 60, z / 60, 2, 25));
    return h;
}

/** Terrace staircase on 0..1: flat treads and steep risers, so a cliff falls in strata. */
function terraces(t: number, steps: number): number {
    const f = t * steps;
    const i = Math.floor(f), r = f - i;
    const riser = smoothstep(0.18, 0.78, r);
    return Math.min(1, (i + riser) / steps);
}

/** The ramp's top height at x (it falls from the ledge to the floor). */
export function rampHeightAt(x: number): number {
    const t = clamp((x - RAMP_TOP_X) / (RAMP_FOOT_X - RAMP_TOP_X), 0, 1);
    // Steeper in the middle, easing onto the ledge and the floor.
    const s = t * t * (3 - 2 * t) * 0.55 + t * 0.45;
    return lerp(LEDGE_Y - 2, FLOOR_Y + 4, s);
}

/** How far in from the rim (m) the ramp's center runs at x. */
export const rampCenter = (x: number): number => 128 + 18 * Math.sin(x / 95) + 10 * Math.sin(x / 41 + 1);

/** The analytic ground height at (x, z). */
export function heightRaw(x: number, z: number): number {
    const d = crackSD(x, z);
    const surf = surfaceHeight(x, z, d);
    if (d >= 0) return surf;
    const inside = -d;
    const floor = floorHeight(x, z, inside);
    // The wall: spurs (wide, stepped buttresses) and gullies (sheer faces) alternate along the rim
    // every 150-300 m; the strata's ledges wander up and down.
    const along = Math.atan2(z / CRACK_B, x / CRACK_A);
    const ca = Math.cos(along), sa = Math.sin(along);
    const spur = smoothstep(0.25, 0.85, vnoise(ca * 13 + 1.3, sa * 13 - 0.7, 34) * 0.7 + vnoise(ca * 31, sa * 31, 36) * 0.3);
    let wallW = 70 + 170 * spur + 25 * fbm(x / 70, z / 70, 2, 32);
    // Along Ledge Kilo and the rockslide the wall falls sheer, so no buttress buries the way down.
    if (z < 0) {
        const zone = smoothstep(LEDGE[0] - 300, LEDGE[0] - 220, x) * (1 - smoothstep(RAMP_FOOT_X + 60, RAMP_FOOT_X + 160, x));
        wallW = lerp(wallW, Math.min(wallW, 85), zone);
    }
    const steps = 5 + Math.round(4 * vnoise(ca * 6 + 9, sa * 6 + 2, 33));
    const jitter = 0.045 * fbm(x / 38, z / 38, 2, 35);
    const t = clamp(inside / Math.max(30, wallW) + jitter, 0, 1);
    // The lip rounds over before the first riser.
    const drop = terraces(Math.pow(t, 0.85), steps) * 0.94 + smoothstep(0, 1, t) * 0.06;
    let h = lerp(surf, Math.max(floor, surf - 700), drop);
    // Below the wall the floor (scree banks rise against the wall's foot).
    h = Math.max(h, floor);
    if (z < 0) {
        // Ledge Kilo: a broad shelf partway down the south wall.
        // Its plan is a rounded lobe out from the wall: deepest in the middle, tapering into the
        // wall at both ends, every edge a cliff down to the floor.
        const lx = (x - LEDGE[0]) / 230;
        if (Math.abs(lx) < 1.25 && inside > 25) {
            const shelf = LEDGE_Y + 1.2 * fbm(x / 30, z / 30, 2, 41) + 0.8 * smoothstep(120, 40, inside);
            const outerEdge = 40 + 185 * Math.sqrt(Math.max(0, 1 - lx * lx)) + 18 * fbm(x / 70, 3, 2, 42);
            const top = inside < outerEdge ? shelf : shelf - (inside - outerEdge) * 3.2;
            h = Math.max(h, top);
        }
        // The rockslide: a ramp of fallen wall from the ledge east to the floor.
        if (x > RAMP_TOP_X - 60 && x < RAMP_FOOT_X + 140) {
            const c = rampCenter(x);
            const half = 34 + 8 * fbm(x / 50, 1, 2, 43);
            const off = Math.max(0, Math.abs(inside - c) - half);
            const fade = smoothstep(RAMP_TOP_X - 60, RAMP_TOP_X, x) * (1 - smoothstep(RAMP_FOOT_X + 40, RAMP_FOOT_X + 140, x));
            const lumps = 1.6 * (ridged(x / 14, inside / 14, 2, 44) - 0.4);
            const ramp = rampHeightAt(x) + lumps - off * 0.95;
            if (fade > 0) h = Math.max(h, lerp(floor, ramp, fade));
        }
    }
    return h;
}

/** Ground beyond the map (to the horizon): plains rising into ridges. */
export function outerHeight(x: number, z: number): number {
    const edge = Math.max(Math.abs(x), Math.abs(z));
    const base = 7 * fbm(x / 420, z / 420, 4, 11) + smoothstep(1250, 1650, edge) * (30 + 25 * fbm(x / 300, z / 300, 2, 14));
    const ridges = smoothstep(1800, 6000, edge) * (260 * ridged(x / 2200, z / 2200, 4, 51) + 120 * fbm(x / 900, z / 900, 3, 52));
    return base + ridges;
}

// --- Masks (vertex colors for the terrain shader) ---------------------------------------------------

export interface GroundMask {
    /** Blast scorch 0..1 (rim, craters). */
    scorch: number;
    /** Riverbed wetness / glow 0..1. */
    river: number;
    /** Paved: the settlement's flagstones, the base's pad 0..1. */
    paved: number;
}

export function groundMask(x: number, z: number): GroundMask {
    const d = crackSD(x, z);
    // Only the lip and the plain around it: the walls below were opened by the blast, not burned.
    let scorch = smoothstep(260, 0, d) * (1 - smoothstep(0, 70, -d)) * (0.65 + 0.35 * fbm(x / 70, z / 70, 3, 61));
    for (const [cx, cz, r] of CRATERS) scorch = Math.max(scorch, 1 - smoothstep(r * 0.6, r * 1.9, Math.hypot(x - cx, z - cz)));
    let river = 0, paved = 0;
    if (d < 0) {
        const rv = riverDistance(x, z);
        river = 1 - smoothstep(8, 26 + 12 * (1 - rv.t), rv.d);
        river = Math.max(river, 1 - smoothstep(50, 100, Math.hypot(x - SOURCE_POOL[0], z - SOURCE_POOL[1])));
        const s = Math.hypot(x - SETTLEMENT[0], z - SETTLEMENT[1]);
        // Flagstone streets radiating from the shrine, and its plaza.
        const ang = Math.atan2(z - SHRINE[1], x - SHRINE[0]);
        const spoke = Math.abs(Math.sin(ang * 3)) * Math.hypot(x - SHRINE[0], z - SHRINE[1]);
        paved = Math.max(1 - smoothstep(24, 34, Math.hypot(x - SHRINE[0], z - SHRINE[1])), (1 - smoothstep(3, 5.5, spoke)) * (1 - smoothstep(150, 200, s)));
    } else {
        paved = 1 - smoothstep(110, 135, Math.hypot(x - FOB[0], z - FOB[1]));
        scorch *= 1 - paved;
    }
    return { scorch, river, paved };
}

// --- The baked grid ---------------------------------------------------------------------------------

/**
 * The ground baked at CELL spacing over the map. Bilinear `height` is the ground everything walks
 * on and the terrain mesh's vertices. Built in rows so a loading screen can spread the work.
 */
export class HeightGrid {
    readonly n = GRID + 1;
    readonly h = new Float32Array((GRID + 1) * (GRID + 1));
    private row = 0;
    constructor(private sample: (x: number, z: number) => number = heightRaw) {}
    get done(): boolean { return this.row >= this.n; }
    get progress(): number { return this.row / this.n; }
    /** Bakes up to `rows` more rows; returns true when the grid is complete. */
    bake(rows = Infinity): boolean {
        const end = Math.min(this.n, this.row + rows);
        for (let j = this.row; j < end; j++) {
            const z = -MAP_HALF + j * CELL;
            for (let i = 0; i < this.n; i++) this.h[j * this.n + i] = this.sample(-MAP_HALF + i * CELL, z);
        }
        this.row = end;
        return this.done;
    }
    /** Height at grid vertex (i, j), clamped to the grid. */
    at(i: number, j: number): number {
        i = i < 0 ? 0 : i > GRID ? GRID : i;
        j = j < 0 ? 0 : j > GRID ? GRID : j;
        return this.h[j * this.n + i];
    }
    /** Ground height at (x, z): the terrain mesh's own surface (each cell split along the same diagonal). */
    height(x: number, z: number): number {
        if (Math.abs(x) > MAP_HALF || Math.abs(z) > MAP_HALF) return outerHeight(x, z);
        const gx = (x + MAP_HALF) / CELL, gz = (z + MAP_HALF) / CELL;
        const i = Math.min(GRID - 1, Math.floor(gx)), j = Math.min(GRID - 1, Math.floor(gz));
        const fx = gx - i, fz = gz - j;
        const a = this.at(i, j), b = this.at(i + 1, j), c = this.at(i, j + 1), d = this.at(i + 1, j + 1);
        // Triangles (a, c, b) and (b, c, d): the diagonal runs from b to c.
        if (fx + fz <= 1) return a + (b - a) * fx + (c - a) * fz;
        return d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
    }
    /** Unit normal at (x, z) by central differences. */
    normal(x: number, z: number, e = CELL): V3 {
        const dx = this.height(x + e, z) - this.height(x - e, z);
        const dz = this.height(x, z + e) - this.height(x, z - e);
        const nx = -dx, ny = 2 * e, nz = -dz;
        const l = Math.hypot(nx, ny, nz);
        return [nx / l, ny / l, nz / l];
    }
    /** Slope (0 flat .. 1 vertical) at (x, z). */
    slope(x: number, z: number): number {
        return 1 - this.normal(x, z)[1];
    }
}

// --- Baked sun shadows and sky light ----------------------------------------------------------------

/** Texels across the light map (each covers MAP_HALF * 2 / LIGHT_RES meters). */
export const LIGHT_RES = 512;
/** Range of heights the light map encodes (shadow tops, ground). */
export const LIGHT_MIN_Y = -720;
/** Sky visibility is computed on this coarser grid and interpolated. */
export const SKY_RES = 128;
export const LIGHT_RANGE_Y = 1024;

/**
 * The light map, RGBA8 per texel:
 * - R, G: the height of the terrain's shadow volume above (x, z) (16 bits, LIGHT_MIN_Y .. +LIGHT_RANGE_Y):
 *   anything lower is in the shadow of the crack's walls;
 * - B: how much of the sky the ground there sees (0..1), the walls taking the rest;
 * - A: the ground height (8 bits, coarse), so things above the ground see more sky.
 * Built in rows (bake) like the HeightGrid.
 */
export class LightMap {
    readonly data = new Uint8Array(LIGHT_RES * LIGHT_RES * 4);
    readonly shadowTop = new Float32Array(LIGHT_RES * LIGHT_RES);
    readonly sky = new Float32Array(LIGHT_RES * LIGHT_RES);
    private row = 0;
    constructor(private grid: HeightGrid, readonly sun: V3) {}
    get done(): boolean { return this.row >= LIGHT_RES; }
    get progress(): number { return this.row / LIGHT_RES; }
    static texel(i: number): number { return -MAP_HALF + ((i + 0.5) / LIGHT_RES) * MAP_HALF * 2; }
    /** Sky share on a coarse grid (smooth anyway), filled before the first row. */
    private skyCoarse: Float32Array | null = null;
    private gridMax = 0;
    private skyAt(cx: number, cz: number): number {
        const g = this.grid, dirs = 10;
        const ground = g.height(cx, cz);
        let open = 0;
        for (let k = 0; k < dirs; k++) {
            const a = (k / dirs) * Math.PI * 2 + 0.3;
            const ux = Math.cos(a), uz = Math.sin(a);
            let maxSin = 0;
            for (let r = 12; r < 1400; r *= 1.45) {
                const rise = g.height(cx + ux * r, cz + uz * r) - ground;
                if (rise > 0) maxSin = Math.max(maxSin, rise / Math.hypot(rise, r));
            }
            open += 1 - maxSin;
        }
        return open / dirs;
    }
    private skyLerp(x: number, z: number): number {
        const c = this.skyCoarse!, n = SKY_RES;
        const gx = clamp(((x + MAP_HALF) / (MAP_HALF * 2)) * n - 0.5, 0, n - 1.001), gz = clamp(((z + MAP_HALF) / (MAP_HALF * 2)) * n - 0.5, 0, n - 1.001);
        const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
        const a = c[j * n + i], b = c[j * n + i + 1], d = c[(j + 1) * n + i], e = c[(j + 1) * n + i + 1];
        return (a * (1 - fx) + b * fx) * (1 - fz) + (d * (1 - fx) + e * fx) * fz;
    }
    bake(rows = Infinity): boolean {
        const g = this.grid;
        if (!this.skyCoarse) {
            this.skyCoarse = new Float32Array(SKY_RES * SKY_RES);
            for (let j = 0; j < SKY_RES; j++) for (let i = 0; i < SKY_RES; i++) {
                const x = -MAP_HALF + ((i + 0.5) / SKY_RES) * MAP_HALF * 2, z = -MAP_HALF + ((j + 0.5) / SKY_RES) * MAP_HALF * 2;
                this.skyCoarse[j * SKY_RES + i] = this.skyAt(x, z);
            }
            let m = -Infinity;
            for (const v of g.h) if (v > m) m = v;
            this.gridMax = m;
            return false;
        }
        const [sx, sy, sz] = this.sun;
        const horiz = Math.hypot(sx, sz) || 1;
        const dx = sx / horiz, dz = sz / horiz, tanEl = sy / horiz;
        const end = Math.min(LIGHT_RES, this.row + rows);
        for (let j = this.row; j < end; j++) {
            const z = LightMap.texel(j);
            for (let i = 0; i < LIGHT_RES; i++) {
                const x = LightMap.texel(i);
                const ground = g.height(x, z);
                // Sun: the highest the terrain's shadow reaches above this column. Steps grow with
                // distance; nothing beyond where the highest ground's shadow falls below can matter.
                let top = -Infinity;
                for (let s = CELL * 3; ; s += CELL * 2 * (1 + s / 250)) {
                    if (this.gridMax - s * tanEl < top || s > 4000) break;
                    const hy = g.height(x + dx * s, z + dz * s) - s * tanEl;
                    if (hy > top) top = hy;
                }
                const skyShare = this.skyLerp(x, z);
                const t = j * LIGHT_RES + i;
                this.shadowTop[t] = top;
                this.sky[t] = skyShare;
                const enc = Math.round(clamp((top - LIGHT_MIN_Y) / LIGHT_RANGE_Y, 0, 1) * 65535);
                this.data[t * 4] = enc >> 8;
                this.data[t * 4 + 1] = enc & 255;
                this.data[t * 4 + 2] = Math.round(clamp(skyShare, 0, 1) * 255);
                this.data[t * 4 + 3] = Math.round(clamp((ground - LIGHT_MIN_Y) / LIGHT_RANGE_Y, 0, 1) * 255);
            }
        }
        this.row = end;
        return this.done;
    }
    /** Whether (x, y, z) is in the walls' shadow (nearest texel; for gameplay and tests). */
    inShadow(x: number, y: number, z: number): boolean {
        const i = clamp(Math.floor(((x + MAP_HALF) / (MAP_HALF * 2)) * LIGHT_RES), 0, LIGHT_RES - 1);
        const j = clamp(Math.floor(((z + MAP_HALF) / (MAP_HALF * 2)) * LIGHT_RES), 0, LIGHT_RES - 1);
        return y < this.shadowTop[j * LIGHT_RES + i];
    }
}

/**
 * The sun: low over the north-northeast through the haze of the blast (unit, toward the sun). Low
 * enough that the north wall's shadow covers most of the floor: the deep stays dark but for its
 * own lights, while the sun strikes the south wall, Ledge Kilo and the rockslide.
 */
export const SUN_DIR: V3 = (() => {
    const el = (23 * Math.PI) / 180, az = (24 * Math.PI) / 180; // azimuth from north toward east
    return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
})();

/** Depth below the rim at (x, y, z) - what the HUD's depth gauge reads. */
export const depthBelowRim = (y: number): number => Math.max(0, RIM_Y - y);

/** Where a point is: on the surface, on a wall, on the floor. */
export function zoneAt(x: number, z: number, y: number): "surface" | "wall" | "floor" {
    if (crackSD(x, z) >= 0) return "surface";
    return y < FLOOR_Y + 60 ? "floor" : "wall";
}
