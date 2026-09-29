// Planet definitions and the one height function everything agrees on: the chunk builder samples
// it for vertices, the walker samples it for footing, the ship for landing, and the autopilot for
// picking a landing site. The surface is a function of the unit direction from the planet's center.

import { Simplex3 } from "./qp_noise";
import { DEFAULT_CHUNK_DETAIL, type ChunkDetail } from "./qp_config";
import { type Vec3, add, addScaled, clamp, cross, dot, length, lerp, normalize, scale, smoothstep, sub, anyPerpendicular, rotateAround } from "./qp_math";

export { DEFAULT_CHUNK_DETAIL, type ChunkDetail } from "./qp_config";

export type RGB = [number, number, number];

/** Deepest quadtree a planet may use, counting the root: enough for sub-meter cells on a planet
 * a few hundred kilometers across. */
export const MAX_CHUNK_LEVELS = 18;

/** Resolve and validate once when configuring a planet, before building any meshes. */
export function chunkResolutions(detail: ChunkDetail): readonly number[] {
    let sizes: number[];
    if (detail.mode === "half") {
        if (!Number.isInteger(detail.levels) || detail.levels < 1 || detail.levels > MAX_CHUNK_LEVELS) {
            throw new Error(`Chunk levels must be an integer from 1 to ${MAX_CHUNK_LEVELS} (including the root).`);
        }
        sizes = Array.from({ length: detail.levels }, (_, i) => Math.max(3, Math.floor(detail.leafVertices / 2 ** i)));
        sizes[0] = detail.leafVertices;
    } else if (detail.mode === "explicit" && Array.isArray(detail.verticesPerLevel)) {
        sizes = [...detail.verticesPerLevel];
    } else {
        throw new Error("Chunk detail mode must be 'half' or 'explicit'.");
    }
    if (sizes.length < 1 || sizes.length > MAX_CHUNK_LEVELS || sizes.some(v => !Number.isInteger(v) || v < 3 || v > 257)) {
        throw new Error(`Specify 1–${MAX_CHUNK_LEVELS} levels, each with 3–257 vertices per side.`);
    }
    return Object.freeze(sizes);
}

const detailCache = new WeakMap<ChunkDetail, readonly number[]>();
function resolutionsFor(p: PlanetDef): readonly number[] | undefined {
    const detail = p.chunkDetail ?? DEFAULT_CHUNK_DETAIL;
    if (!detail) return undefined;
    let sizes = detailCache.get(detail);
    if (!sizes) { sizes = chunkResolutions(detail); detailCache.set(detail, sizes); }
    return sizes;
}

/** Nominal grid width, including endpoints; only its interior replaces the existing mesh. */
export function chunkVerticesFor(p: PlanetDef, level: number): number {
    const sizes = resolutionsFor(p);
    return sizes ? sizes[Math.max(0, Math.min(sizes.length - 1, sizes.length - 1 - level))] : CHUNK_SEGMENTS + 1;
}

export interface PlanetPalette {
    deepWater: RGB;
    shallowWater: RGB;
    beach: RGB;
    lowland: RGB;
    highland: RGB;
    rock: RGB;
    snow: RGB;
}

export interface PlanetDef {
    /** Replace this object to change detail; resolutions are leaf-to-root. Edges retain their existing grid. */
    chunkDetail?: ChunkDetail;
    id: string;
    name: string;
    center: Vec3;
    /** Mean radius (sea level) in world units (meters: the walker is 1.8 tall). */
    radius: number;
    seed: number;
    /** Continents: how far land rises above / sinks below sea level at the largest scale. */
    continentHeight: number;
    /** Ridged mountains added on top of the land. */
    mountainHeight: number;
    /** Rolling hills (~2 km across) on land. */
    hillHeight: number;
    /** Rocky outcrops and crags (~250 m across) on rough ground and all over the mountains. */
    rockHeight: number;
    /** Boulders, stones and meter-scale bumps: what you notice when walking. */
    detailHeight: number;
    /** Terrace step height (mesas and stepped canyon walls), 0 for none. */
    terraceStep: number;
    /** Continent noise frequency on the unit sphere. */
    continentFrequency: number;
    /** Liquid (or frozen) sea surface: terrain below it is drawn flat at sea level. */
    hasSea: boolean;
    /** A frozen sea is walkable and shaded as ice rather than water. */
    frozenSea: boolean;
    palette: PlanetPalette;
    atmosphereColor: RGB;
    /** Thickness of the atmosphere shell, world units above sea level. */
    atmosphereHeight: number;
    /** Surface gravity (world units / s^2). */
    gravity: number;
    /** How much the poles are capped in snow/ice (0..1). */
    polarCaps: number;
}

// One world unit is a meter. The walker is 1.8 m tall and the highest peaks stand 2-3.5 km above
// the sea, so a mountain really is a thousand times your height. The planets are small by real
// standards (Verdant is 100 km in radius, Earth is 6,371 km) so you can still fly between them in
// half a minute, but large enough that the ground looks flat underfoot and ranges sink below the
// horizon as you walk away from them.
export const PLANETS: PlanetDef[] = [
    {
        id: "verdant", name: "Verdant", center: [0, 0, 0], radius: 100_000, seed: 1337,
        continentHeight: 700, mountainHeight: 4200, hillHeight: 180, rockHeight: 70, detailHeight: 1.1, terraceStep: 0, continentFrequency: 1.6,
        hasSea: true, frozenSea: false,
        palette: {
            deepWater: [0.02, 0.09, 0.22], shallowWater: [0.06, 0.32, 0.45], beach: [0.78, 0.72, 0.52],
            lowland: [0.36, 0.52, 0.24], highland: [0.46, 0.5, 0.3], rock: [0.5, 0.47, 0.44], snow: [0.94, 0.95, 0.97],
        },
        atmosphereColor: [0.42, 0.66, 1.0], atmosphereHeight: 8000, gravity: 9.8, polarCaps: 0.55,
    },
    {
        id: "ember", name: "Ember", center: [520_000, 90_000, -340_000], radius: 72_000, seed: 4242,
        continentHeight: 520, mountainHeight: 3500, hillHeight: 150, rockHeight: 90, detailHeight: 1.0, terraceStep: 45, continentFrequency: 2.1,
        hasSea: false, frozenSea: false,
        palette: {
            deepWater: [0.2, 0.05, 0.03], shallowWater: [0.3, 0.08, 0.04], beach: [0.62, 0.3, 0.16],
            lowland: [0.72, 0.36, 0.17], highland: [0.6, 0.28, 0.15], rock: [0.46, 0.28, 0.21], snow: [0.88, 0.66, 0.48],
        },
        atmosphereColor: [1.0, 0.6, 0.38], atmosphereHeight: 6000, gravity: 8.2, polarCaps: 0.0,
    },
    {
        id: "glacia", name: "Glacia", center: [-460_000, -70_000, -420_000], radius: 58_000, seed: 9001,
        continentHeight: 450, mountainHeight: 3000, hillHeight: 120, rockHeight: 60, detailHeight: 0.8, terraceStep: 0, continentFrequency: 1.9,
        hasSea: true, frozenSea: true,
        palette: {
            deepWater: [0.52, 0.7, 0.8], shallowWater: [0.68, 0.84, 0.9], beach: [0.8, 0.86, 0.9],
            lowland: [0.86, 0.9, 0.95], highland: [0.72, 0.78, 0.86], rock: [0.36, 0.4, 0.48], snow: [0.97, 0.98, 1.0],
        },
        atmosphereColor: [0.66, 0.84, 1.0], atmosphereHeight: 5000, gravity: 7.4, polarCaps: 1.0,
    },
];

export const SUN_DIRECTION: Vec3 = normalize([0.55, 0.42, 0.72]);

export function planetById(id: string): PlanetDef | undefined {
    const key = id.toLowerCase();
    return PLANETS.find(p => p.id === key || p.name.toLowerCase() === key);
}

/** Largest height above sea level the terrain can reach (for horizon culling). */
export function maxRelief(p: PlanetDef): number {
    return p.continentHeight + p.mountainHeight + p.hillHeight + p.rockHeight + p.detailHeight * 6 + p.terraceStep;
}

// --- Chunk grid ----------------------------------------------------------------------------------

/** Existing border grid and default interior: N quads, N+1 vertices per side. */
export const CHUNK_SEGMENTS = 16;
/** Target size of a leaf cell (world units): the deepest level is the first at least this fine. */
export const LEAF_CELL = 0.8;

/** Edge length of a quadtree node of this level on the planet's surface (world units). */
export function levelWorldSize(p: PlanetDef, level: number): number {
    return (2 / (1 << level)) * p.radius * (Math.PI / 4);
}

/** Configured deepest level, or the first whose default cells are at most LEAF_CELL across. */
export function maxLevelFor(p: PlanetDef): number {
    const sizes = resolutionsFor(p);
    if (sizes) return sizes.length - 1;
    return Math.max(1, Math.ceil(Math.log2(levelWorldSize(p, 0) / (CHUNK_SEGMENTS * LEAF_CELL))));
}

/** Existing border/default grid spacing at this level (world units). */
export function levelSpacing(p: PlanetDef, level: number): number {
    return levelWorldSize(p, level) / CHUNK_SEGMENTS;
}

/**
 * The finest spacing anything samples at: the deepest chunks' grid (their configured interior
 * when that is finer than the border grid). The walker's footing uses it too, so feet meet the
 * ground that is drawn.
 */
export function finestSpacing(p: PlanetDef): number {
    const level = maxLevelFor(p);
    const vertices = chunkVerticesFor(p, level);
    let entry = finestCache.get(p);
    if (!entry || entry.level !== level || entry.vertices !== vertices) {
        const spacing = Math.min(levelSpacing(p, level), levelWorldSize(p, level) / (vertices - 1));
        entry = { level, vertices, spacing };
        finestCache.set(p, entry);
    }
    return entry.spacing;
}
const finestCache = new WeakMap<PlanetDef, { level: number; vertices: number; spacing: number }>();

// --- Terrain -------------------------------------------------------------------------------------

export interface SurfaceSample {
    /** Terrain height above the mean radius (can be negative under the sea). */
    terrain: number;
    /** Where you stand / what is drawn: max(terrain, 0) on a planet with a sea. */
    surface: number;
    /** True where the drawn surface is sea (water or ice), not land. */
    sea: boolean;
    /** 0..1: how much of this spot is rocky outcrop (for coloring). */
    rock: number;
    /** -1..1: slow patchiness (meadow vs dry grass, dune shades, blue ice...). */
    patch: number;
}

const noiseCache = new Map<number, Simplex3>();
function noiseFor(seed: number): Simplex3 {
    let n = noiseCache.get(seed);
    if (!n) { n = new Simplex3(seed); noiseCache.set(seed, n); }
    return n;
}

/**
 * How many octaves of a noise layer a mesh with this sample spacing can show: octaves whose
 * features are under ~3 samples across would only alias (the spiky coasts and limbs a coarse
 * chunk gets from sampling full-detail noise), so they are faded out.
 */
function octavesFor(period: number, lacunarity: number, spacing: number): number {
    return Math.log(period / (3 * spacing)) / Math.log(lacunarity) + 1;
}

/** Noise coordinates for a layer whose largest features are `period` world units across. */
function layer(p: PlanetDef, d: Vec3, period: number, offset: number): [number, number, number] {
    const f = p.radius / period;
    return [d[0] * f + offset, d[1] * f - offset * 0.7, d[2] * f + offset * 0.3];
}

/**
 * Terrain at the unit direction `d` (from the planet's center). Deterministic per planet seed.
 * `spacing` is the distance between the samples being taken (a chunk's grid step): coarse
 * chunks get a smoother, band-limited version of the same surface, like QuadScape's mips.
 *
 * The layers run from continents (tens of kilometers) and mountain belts kilometers high,
 * through hills and crags, down to boulders, scree and meter-scale bumps. Rock is not one layer
 * but a property of the ground: mountain slopes and rough patches of lowland get crags, boulder
 * fields and stones, and because each of those is band-limited to the mesh, the rocks appear as
 * you close in on them - a smooth slope from orbit, a crag field from the air, loose stones
 * underfoot.
 */
export function sampleSurface(p: PlanetDef, d: Vec3, spacing = finestSpacing(p)): SurfaceSample {
    const n = noiseFor(p.seed);
    const sp = Math.max(spacing, finestSpacing(p));
    const f = p.continentFrequency;
    // Warp the continent field a little so coastlines aren't blobby.
    const wx = n.noise(d[0] * 2.3 + 11, d[1] * 2.3, d[2] * 2.3) * 0.18;
    const wy = n.noise(d[0] * 2.3, d[1] * 2.3 + 23, d[2] * 2.3) * 0.18;
    const continents = n.fbm(d[0] * f + wx, d[1] * f + wy, d[2] * f, 5, 2, 0.5, octavesFor(p.radius / f, 2, sp)) + 0.08;
    // Land mask: 0 at the coast, 1 well inland (mountains only grow on land).
    const land = smoothstep(0.0, 0.35, continents);
    // Mountain belts: long ridged ranges (crests ~25 km apart, the finest octave ~40 m) that
    // are tallest inside broad belts and lower foothills between them.
    const [gx, gy, gz] = layer(p, d, 60000, 5.3);
    const belt = smoothstep(-0.2, 0.3, n.fbm(gx, gy, gz, 3, 2, 0.5, octavesFor(60000, 2, sp)));
    const [kx, ky, kz] = layer(p, d, 26000, 3.1);
    const ridges = n.ridged(kx, ky, kz, 9, octavesFor(26000, 2.1, sp));
    const mountains = Math.pow(ridges, 2.1) * land * (0.2 + 0.8 * belt);
    // Rolling hills everywhere on land.
    const [hx, hy, hz] = layer(p, d, 1800, 31.7);
    const hills = n.fbm(hx, hy, hz, 5, 2.1, 0.5, octavesFor(1800, 2.1, sp));
    // Patches of rough ground where crags break through, with smooth meadows between; up in
    // the mountains all of it is rough.
    const [mx, my, mz] = layer(p, d, 900, 57.1);
    const patch = n.fbm(mx, my, mz, 3, 2, 0.5, octavesFor(900, 2, sp));
    const rough = smoothstep(0.02, 0.4, patch) * land;
    const alpine = smoothstep(0.04, 0.3, mountains);
    const rocky = Math.max(rough, alpine);
    // Crags and outcrops, ~240 m across down to ~12 m.
    const [rx, ry, rz] = layer(p, d, 240, 71.3);
    const crags = rocky > 0 ? n.ridged(rx, ry, rz, 5, octavesFor(240, 2.1, sp)) : 0;
    const rocks = Math.pow(crags, 2.5) * rocky;
    // Boulders and hummocks over all land (thicker on rocky ground): mounds a few meters across.
    const [ox, oy, oz] = layer(p, d, 14, 91.3);
    const boulderOctaves = octavesFor(14, 2, sp);
    const lump = boulderOctaves > 0 ? n.fbm(ox, oy, oz, 2, 2, 0.45, boulderOctaves) : 0;
    const boulders = Math.pow(Math.max(0, lump - 0.12) / 0.88, 1.5) * land * (0.35 + 0.65 * rocky);
    // Scree: sharp stones a couple of meters across, only on rocky ground.
    const [qx, qy, qz] = layer(p, d, 2.6, 43.7);
    const stoneOctaves = octavesFor(2.6, 2.1, sp);
    const stones = stoneOctaves > 0 && rocky > 0 ? Math.pow(n.ridged(qx, qy, qz, 2, stoneOctaves), 3) * rocky : 0;
    // Meter-scale bumps: tussocks, ripples, lumps of soil.
    const [bx, by, bz] = layer(p, d, 6, 13.9);
    const bumpOctaves = octavesFor(6, 2.05, sp);
    const bumps = bumpOctaves > 0 ? n.fbm(bx, by, bz, 3, 2.05, 0.5, bumpOctaves) : 0;

    let terrain = continents * p.continentHeight + mountains * p.mountainHeight
        + hills * p.hillHeight * (0.25 + 0.75 * land);
    // Mesas: the broad landforms flattened into steps with steep risers (before the crags and
    // bumps go on, so those stay sharp). Only meshes fine enough to hold the risers get them.
    if (p.terraceStep > 0 && terrain > 0) {
        const t = terrain / p.terraceStep;
        const stepped = (Math.floor(t) + smoothstep(0.25, 0.75, t - Math.floor(t))) * p.terraceStep;
        terrain += (stepped - terrain) * 0.8 * (1 - smoothstep(8, 40, sp)) * land;
    }
    terrain += rocks * p.rockHeight
        + boulders * p.detailHeight * 2.4
        + stones * p.detailHeight * 0.5
        + bumps * p.detailHeight * (0.3 + 0.5 * land + 0.4 * rocky);
    const rock = clamp(rocks * 1.8 + alpine * 0.55 + boulders * 0.6 + stones * 0.6, 0, 1);
    if (p.hasSea && terrain < 0) return { terrain, surface: 0, sea: true, rock: 0, patch };
    return { terrain, surface: terrain, sea: false, rock, patch };
}

/** Distance from the planet's center to the drawn surface along the unit direction `d`. */
export function surfaceRadius(p: PlanetDef, d: Vec3, spacing = finestSpacing(p)): number {
    return p.radius + sampleSurface(p, d, spacing).surface;
}

/** World-space point on the surface under the world point `pos` (or along direction `d`). */
export function surfacePoint(p: PlanetDef, dir: Vec3): Vec3 {
    const d = normalize(dir);
    return addScaled(p.center, d, surfaceRadius(p, d));
}

/** Height of `pos` above the ground directly beneath it. */
export function altitudeAboveGround(p: PlanetDef, pos: Vec3): number {
    const rel = sub(pos, p.center);
    return length(rel) - surfaceRadius(p, normalize(rel));
}

/**
 * Surface normal at direction `d` by central differences on the sphere (`step` in world units)
 * of the surface band-limited to `spacing`. The tangent frame depends only on `d`, so any two
 * chunks asking about the same point get exactly the same normal.
 */
export function surfaceNormal(p: PlanetDef, d: Vec3, step = 0.8, spacing = finestSpacing(p)): Vec3 {
    const up = normalize(d);
    const t1 = anyPerpendicular(up);
    const t2 = cross(up, t1);
    const a = p.radius;
    const at = (o1: number, o2: number): Vec3 => {
        const dd = normalize(add(up, add(scale(t1, o1 / a), scale(t2, o2 / a))));
        return scale(dd, surfaceRadius(p, dd, spacing));
    };
    const px = at(step, 0), nx = at(-step, 0), pz = at(0, step), nz = at(0, -step);
    let n = normalize(cross(sub(px, nx), sub(pz, nz)));
    if (dot(n, up) < 0) n = scale(n, -1);
    return n;
}

// --- Color ---------------------------------------------------------------------------------------

const mix = (a: RGB, b: RGB, t: number): RGB => lerp(a as Vec3, b as Vec3, clamp(t, 0, 1)) as RGB;
const colorNoise = new Simplex3(4711);

/** Vertex color plus, in alpha, how much of the spot is bare rock (for the shader's textures). */
export type RGBA = [number, number, number, number];

/**
 * Biome color from height, slope (`upDot` = dot(surface normal, radial up)), latitude and a
 * little noise. `jitter` is in [-1, 1]. `spacing` is the mesh's sample spacing: a thin band like
 * the beach can only be drawn where the mesh is fine enough to resolve it, or coarse chunks turn
 * it into big interpolated patches. Alpha is the rock weight: outcrops, scree and cliffs, but not
 * where snow lies. The shader textures rock and soil differently from it; texture detail finer
 * than the mesh is the shader's job, so these colors stay smooth.
 */
export function surfaceColor(p: PlanetDef, s: SurfaceSample, upDot: number, d: Vec3, jitter: number, spacing = finestSpacing(p)): RGBA {
    const pal = p.palette;
    if (s.sea) {
        const depth = clamp(-s.terrain / (p.continentHeight * 0.6), 0, 1);
        return [...mix(pal.shallowWater, pal.deepWater, Math.sqrt(depth)), 0];
    }
    const h = s.terrain;
    const relief = p.continentHeight + p.mountainHeight;
    const t = clamp(h / relief, 0, 1);
    let c: RGB;
    c = mix(pal.lowland, pal.highland, smoothstep(0.05, 0.4, t + jitter * 0.05));
    // Patchy ground: lusher and drier stretches (dune shades on Ember, blue ice on Glacia).
    c = mix(c, pal.highland, smoothstep(-0.1, 0.35, s.patch) * 0.45);
    // Bare earth showing through in patches tens of meters across, on meshes fine enough to
    // hold them.
    const fine = 1 - smoothstep(8, 30, spacing);
    if (fine > 0) {
        const k = p.radius / 25;
        const m = colorNoise.noise(d[0] * k, d[1] * k, d[2] * k);
        c = mix(c, pal.beach, smoothstep(0.35, 0.75, m) * fine * 0.4);
    }
    // Outcrops show their stone, and Ember's terraces show banded strata on the risers.
    c = mix(c, pal.rock, s.rock * 0.8);
    if (p.terraceStep > 0) {
        const band = 0.5 + 0.5 * Math.sin((h / p.terraceStep) * Math.PI * 5 + s.patch * 2);
        c = mix(c, pal.beach, band * 0.3 * (1 - smoothstep(0.85, 0.97, upDot)));
    }
    if (p.hasSea && !p.frozenSea && h < 6) {
        const beach = (1 - smoothstep(2, 6, h)) * (1 - smoothstep(12, 40, spacing));
        c = mix(c, pal.beach, beach);
    }
    // Steep ground is bare rock.
    const steep = 1 - smoothstep(0.72, 0.9, upDot);
    c = mix(c, pal.rock, steep * 0.9);
    // High peaks and polar caps get snow, but not on cliffs.
    const lat = Math.abs(dot(d, [0, 1, 0]));
    const snowLine = 0.5 - p.polarCaps * 0.4 * smoothstep(0.55, 0.95, lat) + jitter * 0.04;
    const snow = smoothstep(snowLine, snowLine + 0.08, t + p.polarCaps * 0.35 * smoothstep(0.7, 0.98, lat)) * smoothstep(0.62, 0.8, upDot);
    c = mix(c, pal.snow, snow);
    const v = 1 + jitter * 0.07;
    const rock = clamp(Math.max(s.rock, steep), 0, 1) * (1 - snow);
    return [c[0] * v, c[1] * v, c[2] * v, rock];
}

// --- Sites ---------------------------------------------------------------------------------------

/**
 * A walkable spot near the preferred direction: dry land (not sea, unless the sea is frozen)
 * with a flat patch around it big enough for the ship. Searches a spiral of directions around
 * `preferred` (deterministic for a planet) and takes the first good one, or failing that the
 * flattest dry spot it saw.
 */
export function findLandingSite(p: PlanetDef, preferred: Vec3, minHeight = 3): Vec3 {
    const up = normalize(preferred);
    const t1 = anyPerpendicular(up);
    let best: Vec3 | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < 900; i++) {
        const ang = i * 2.39996; // golden angle
        const radius = Math.sqrt(i) * 0.03; // radians
        const axis = rotateAround(t1, up, ang);
        const d = normalize(rotateAround(up, axis, radius));
        const s = sampleSurface(p, d);
        const walkable = p.frozenSea ? true : !s.sea;
        if (!walkable || s.surface < (p.hasSea && !p.frozenSea ? minHeight : -1e9)) continue;
        const n = surfaceNormal(p, d, 1.5);
        const tilt = 1 - dot(n, d);
        // The patch around it (the ship is ~10 units long) must be dry and close to level.
        let spread = 0;
        const side = anyPerpendicular(d);
        for (let k = 0; k < 6; k++) {
            const off = rotateAround(side, d, (k / 6) * Math.PI * 2);
            const dd = normalize(addScaled(d, off, 8 / p.radius));
            const ss = sampleSurface(p, dd);
            spread = Math.max(spread, (!p.frozenSea && ss.sea) ? Infinity : Math.abs(ss.surface - s.surface));
        }
        if (tilt < 0.03 && spread < 1.6) return d;
        const score = tilt * 40 + spread + radius * 2;
        if (score < bestScore) { bestScore = score; best = d; }
    }
    return best ?? up;
}
