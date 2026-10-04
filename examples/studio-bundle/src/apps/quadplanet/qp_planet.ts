// Planet definitions, and the terrain queries the simulation needs (footing, landing sites).
//
// The terrain itself - the height function, the six cube-face quadtrees per planet, chunk meshes
// and streaming - lives on the Rust side (src/heightfield_landscapes/QuadPlanet/, exposed as
// `Entropy.QuadPlanet`). The planet definitions here are sent to it once; the query functions
// below go through a `TerrainBackend`, which the addon points at `Entropy.QuadPlanet` so the
// walker's feet meet exactly the ground that is drawn. Tests plug in their own backend.

import { type Vec3, add, addScaled, cross, dot, length, normalize, scale, sub } from "./qp_math";
import { EARTH_CHUNK_DETAIL, type ChunkDetail } from "./qp_config";

export { DEFAULT_CHUNK_DETAIL, type ChunkDetail } from "./qp_config";

export type RGB = [number, number, number];

export interface PlanetPalette {
    deepWater: RGB;
    shallowWater: RGB;
    beach: RGB;
    lowland: RGB;
    highland: RGB;
    rock: RGB;
    snow: RGB;
}

/**
 * Where a planet's heights come from: seeded noise, or Earth's real elevation (SRTM-derived
 * elevation tiles with ocean bathymetry, streamed and cached; see elevation.rs).
 */
export type TerrainSource =
    | { kind: "procedural" }
    | {
        kind: "earth";
        /** Finest tile zoom: 13 (default) is ~19 m pixels, SRTM's own resolution; 15 at most. */
        maxZoom?: number;
        /** Only the built-in whole-world tile: continents and oceans, no network. */
        offline?: boolean;
        /** A Terrarium `{z}/{x}/{y}` tile URL (default: the AWS Terrain Tiles bucket). */
        tileUrl?: string;
        /** A directory of SRTM .hgt files (N27E086.hgt...) used wherever it has one. */
        srtmDir?: string;
    };

export interface PlanetDef {
    /** Vertex counts per level, leaf to root. Edges retain their existing grid. */
    chunkDetail?: ChunkDetail;
    terrain?: TerrainSource;
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
// the sea, so a mountain really is a thousand times your height. The three procedural planets are
// small by real standards (Verdant is 100 km in radius) so you can fly between them in seconds;
// Earth is the real thing, 6,371 km in radius and some 20,000 km out, hanging in Verdant's sky.
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
    {
        // Earth's heights are the real elevation data and nothing else (none of the noise
        // parameters raise its ground), so OpenStreetMap buildings and roads sit right on it.
        // Its frame: +Y is the north pole, latitude 0 / longitude 0 faces +Z, east is +X.
        id: "earth", name: "Earth", center: [-18_000_000, 2_000_000, 9_000_000], radius: 6_371_000, seed: 1969,
        continentHeight: 1000, mountainHeight: 5000, hillHeight: 0, rockHeight: 10, detailHeight: 0.9, terraceStep: 0, continentFrequency: 1,
        hasSea: true, frozenSea: false,
        palette: {
            deepWater: [0.01, 0.05, 0.16], shallowWater: [0.04, 0.25, 0.37], beach: [0.8, 0.74, 0.56],
            lowland: [0.29, 0.44, 0.19], highland: [0.47, 0.44, 0.31], rock: [0.48, 0.45, 0.42], snow: [0.95, 0.96, 0.98],
        },
        atmosphereColor: [0.4, 0.62, 1.0], atmosphereHeight: 60_000, gravity: 9.81, polarCaps: 0,
        terrain: { kind: "earth" },
        chunkDetail: EARTH_CHUNK_DETAIL,
    },
];

/** Where the sun is (a unit vector toward it). Changed by `setSunDirection`, e.g. when you travel
 * to a place on Earth that is in the night. */
export let SUN_DIRECTION: Vec3 = normalize([0.55, 0.42, 0.72]);

export function setSunDirection(dir: Vec3): void {
    SUN_DIRECTION = normalize(dir);
}

export function planetById(id: string): PlanetDef | undefined {
    const key = id.toLowerCase();
    return PLANETS.find(p => p.id === key || p.name.toLowerCase() === key);
}

export const isEarth = (p: PlanetDef): boolean => p.terrain?.kind === "earth";

// --- Terrain queries -----------------------------------------------------------------------------

export interface SurfaceSample {
    /** Terrain height above the mean radius (can be negative under the sea). */
    terrain: number;
    /** Where you stand / what is drawn: max(terrain, 0) on a planet with a sea. */
    surface: number;
    /** True where the drawn surface is sea (water or ice), not land. */
    sea: boolean;
    /** 0..1: how much of this spot is rocky outcrop. */
    rock: number;
    /** -1..1: slow patchiness. */
    patch: number;
}

/** Answers terrain questions; the addon uses `Entropy.QuadPlanet`, tests their own. */
export interface TerrainBackend {
    /** The finest (walkable) ground along direction `d`. `wait` blocks the calling thread until
     * missing elevation data loads - only for one-off tooling/test queries, never per-frame code. */
    sample(p: PlanetDef, d: Vec3, wait?: boolean): SurfaceSample;
    normal(p: PlanetDef, d: Vec3, step: number): Vec3;
    landingSite(p: PlanetDef, preferred: Vec3): Vec3;
    /** Largest height above sea level the terrain can reach. */
    maxRelief(p: PlanetDef): number;
}

let backend: TerrainBackend | null = null;

export function setTerrainBackend(b: TerrainBackend): void { backend = b; }

function terrain(): TerrainBackend {
    if (!backend) throw new Error("QuadPlanet: no terrain backend (setTerrainBackend) yet");
    return backend;
}

/** Terrain at the unit direction `d` (from the planet's center). */
export function sampleSurface(p: PlanetDef, d: Vec3, wait = false): SurfaceSample {
    return terrain().sample(p, d, wait);
}

/** Distance from the planet's center to the drawn surface along the unit direction `d`. */
export function surfaceRadius(p: PlanetDef, d: Vec3): number {
    return p.radius + sampleSurface(p, d).surface;
}

/** World-space point on the surface along direction `dir`, from whatever elevation is loaded now
 * (never waits on the network: coarser data stands in until the real tiles stream in). */
export function surfacePoint(p: PlanetDef, dir: Vec3): Vec3 {
    const d = normalize(dir);
    return addScaled(p.center, d, p.radius + sampleSurface(p, d).surface);
}

/** Height of `pos` above the ground directly beneath it. */
export function altitudeAboveGround(p: PlanetDef, pos: Vec3): number {
    const rel = sub(pos, p.center);
    return length(rel) - surfaceRadius(p, normalize(rel));
}

export function surfaceNormal(p: PlanetDef, d: Vec3, step = 0.8): Vec3 {
    return terrain().normal(p, d, step);
}

/** A flat, dry spot near `preferred` big enough for the ship. */
export function findLandingSite(p: PlanetDef, preferred: Vec3): Vec3 {
    return terrain().landingSite(p, preferred);
}

export function maxRelief(p: PlanetDef): number {
    return terrain().maxRelief(p);
}

// --- Geography (Earth) ---------------------------------------------------------------------------

/** Unit direction (planet frame) of a latitude/longitude in degrees. Same convention as Rust. */
export function latLonToDir(lat: number, lon: number): Vec3 {
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
}

export function dirToLatLon(d: Vec3): { lat: number; lon: number } {
    const n = normalize(d);
    return { lat: Math.asin(Math.max(-1, Math.min(1, n[1]))) * 180 / Math.PI, lon: Math.atan2(n[0], n[2]) * 180 / Math.PI };
}

/** Where the sun sits for mid-morning at a direction: ~35 degrees up in the east. */
export function morningSunAt(d: Vec3): Vec3 {
    const up = normalize(d);
    let east = normalize(cross([0, 1, 0], up));
    if (length(east) < 1e-6 || Math.abs(dot(up, [0, 1, 0])) > 0.999) east = [1, 0, 0];
    return normalize(add(scale(up, Math.sin(35 * Math.PI / 180)), scale(east, Math.cos(35 * Math.PI / 180))));
}

/** A few places to go without a network connection (anything else is looked up on OSM). */
export const LANDMARKS: { name: string; lat: number; lon: number; aliases: string[] }[] = [
    { name: "Mount Everest", lat: 27.9881, lon: 86.925, aliases: ["everest", "chomolungma", "sagarmatha"] },
    { name: "K2", lat: 35.8825, lon: 76.5133, aliases: ["k2"] },
    { name: "The Matterhorn", lat: 45.9763, lon: 7.6586, aliases: ["matterhorn", "cervino"] },
    { name: "Mont Blanc", lat: 45.8326, lon: 6.8652, aliases: ["mont blanc", "monte bianco"] },
    { name: "Grand Canyon (South Rim)", lat: 36.0572, lon: -112.1393, aliases: ["grand canyon"] },
    { name: "Half Dome, Yosemite", lat: 37.7459, lon: -119.5332, aliases: ["half dome", "yosemite"] },
    { name: "Mount Fuji", lat: 35.3606, lon: 138.7274, aliases: ["fuji", "fujisan"] },
    { name: "Kilimanjaro", lat: -3.0674, lon: 37.3556, aliases: ["kilimanjaro"] },
    { name: "Denali", lat: 63.0692, lon: -151.007, aliases: ["denali", "mckinley"] },
    { name: "Aconcagua", lat: -32.6532, lon: -70.0109, aliases: ["aconcagua"] },
    { name: "Table Mountain", lat: -33.9628, lon: 18.4098, aliases: ["table mountain", "cape town"] },
    { name: "Uluru", lat: -25.3444, lon: 131.0369, aliases: ["uluru", "ayers rock"] },
    { name: "Mauna Kea", lat: 19.8207, lon: -155.4681, aliases: ["mauna kea", "hawaii"] },
];

export function findLandmark(query: string) {
    const q = query.trim().toLowerCase();
    return LANDMARKS.find(l => l.name.toLowerCase() === q || l.aliases.some(a => q === a || q.includes(a)));
}
