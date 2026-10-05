// Allegiance's light and weather (al_sky.ts), wind-bent foliage (al_scatter.ts packFoliage) and
// city surfaces (qp_shader.ts surfaceKind, qp_city.ts / qp_buildings.ts packing). The live tier
// is tests/features/allegiance_visuals_live.feature.
import { describe, expect, it } from "vitest";
import { shadowCascades, weatherAt, cloudOffset, windVector, SHADOW_RADII, SHADOW_MAP_SIZE } from "../src/games/allegiance/al_sky";
import { packFoliage, bendAt, sways, FOLIAGE, lawnAround, RoadMask, LAWN_RADIUS, shadowClass, familyOfMesh, foliageKey, foliageSpec, propKey, tileOf, batchKey, scatterMesh, GROUND_TILE, TILE } from "../src/games/allegiance/al_scatter";
import { ALLEGIANCE_SHADER, ALLEGIANCE_INSTANCED_SHADER, PEOPLE_SHADER, MAT_FOLIAGE } from "../src/games/allegiance/al_shader";
import { QUADPLANET_SHADER, surfaceKind, SURFACE, CLOUD_PERIOD, packWorld, WORLD_FLOATS, MAX_PLANETS } from "../src/apps/quadplanet/qp_shader";
import { packHouse } from "../src/apps/quadplanet/qp_city";
import { evaluateObject } from "../src/apps/mesha/mesha_object";
import { lookupObject } from "../src/apps/mesha/library";
import { type Vec3, normalize, add, scale } from "../src/apps/quadplanet/qp_math";

/** clip = M * [p, 1] for a column-major M. */
function apply(m: number[], p: Vec3): [number, number, number] {
    const r = (i: number) => m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i];
    return [r(0), r(1), r(2)];
}

describe("sun-shadow cascades", () => {
    const sun = normalize([0.4, 0.7, -0.3]);
    const eye: Vec3 = [3.2, 1.7, -8.4];
    const forward = normalize([0.2, -0.1, 1]);

    it("covers a sphere around the camera, nearest first, with depth growing away from the sun", () => {
        const c = shadowCascades(eye, forward, sun);
        expect(c.cascades.length).toBe(SHADOW_RADII.length);
        c.cascades.forEach((m, k) => {
            expect(m.length).toBe(16);
            const r = SHADOW_RADII[k];
            expect(c.texel[k]).toBeCloseTo(2 * r / SHADOW_MAP_SIZE, 6);
            // The eye and points around it at up to ~0.35 r land inside, at depths in (0, 1).
            for (const d of [[0, 0, 0], [0.3, 0, 0], [0, -0.3, 0], [0, 0.1, 0.35]] as Vec3[]) {
                const q = apply(m, add(eye, scale(d, r)));
                expect(Math.abs(q[0])).toBeLessThan(1);
                expect(Math.abs(q[1])).toBeLessThan(1);
                expect(q[2]).toBeGreaterThan(0);
                expect(q[2]).toBeLessThan(1);
            }
            // A caster 200 m toward the sun is nearer the light than the ground under it.
            const ground = apply(m, eye), caster = apply(m, add(eye, scale(sun, 200)));
            expect(caster[2]).toBeLessThan(ground[2]);
            expect(caster[0]).toBeCloseTo(ground[0], 5);
            expect(caster[1]).toBeCloseTo(ground[1], 5);
        });
        expect(c.depthRange).toBeGreaterThan(2 * Math.max(...SHADOW_RADII));
    });

    it("moves the cascades only in whole texels, so edges hold still as you walk", () => {
        const a = shadowCascades(eye, forward, sun);
        const b = shadowCascades(add(eye, [0.013, 0, 0.007]), forward, sun);
        a.cascades.forEach((m, k) => {
            // A fixed point's shadow-map position changes by a whole number of texels (or none).
            const p: Vec3 = [10, 0, 5];
            const pa = apply(m, p), pb = apply(b.cascades[k], p);
            const texels = (pb[0] - pa[0]) * SHADOW_MAP_SIZE / 2;
            expect(Math.abs(texels - Math.round(texels))).toBeLessThan(1e-3);
            expect(pb[2]).toBeCloseTo(pa[2], 9);
        });
    });
});

describe("weather", () => {
    it("is deterministic, within its ranges, and carries over dawn without a jump", () => {
        const a = weatherAt("london", 4, 0.3), b = weatherAt("london", 4, 0.3);
        expect(a).toEqual(b);
        for (let d = 0; d < 40; d++) {
            const w = weatherAt("paris", d, 0.5);
            expect(w.cloudCover).toBeGreaterThanOrEqual(0.1);
            expect(w.cloudCover).toBeLessThanOrEqual(1);
            expect(w.windSpeed).toBeGreaterThan(1);
            expect(w.windSpeed).toBeLessThan(9);
            const end = weatherAt("paris", d, 1), start = weatherAt("paris", d + 1, 0);
            expect(end.cloudCover).toBeCloseTo(start.cloudCover, 9);
            expect(end.windSpeed).toBeCloseTo(start.windSpeed, 9);
            expect(Math.cos(end.windHeading - start.windHeading)).toBeCloseTo(1, 9);
        }
    });

    it("blows along the street frame and wraps the cloud noise offset into its period", () => {
        const v = windVector({ cloudCover: 0.3, windSpeed: 5, windHeading: Math.PI / 2 }, [1, 0, 0], [0, 0, 1]);
        expect(v[0]).toBeCloseTo(0, 9);
        expect(v[2]).toBeCloseTo(5, 9);
        const o = cloudOffset([6_371_000.5, -2_000_123, 17], [-400, 0, 70_000]);
        for (const x of o) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(CLOUD_PERIOD); }
        // The same world point samples the same noise however the render origin moves.
        const origin1: Vec3 = [6_371_000, 0, 0], origin2: Vec3 = [6_371_512, 0, 0];
        const at = (origin: Vec3, worldX: number) => (worldX - origin[0] + cloudOffset(origin, [0, 0, 0])[0]) % CLOUD_PERIOD;
        expect(at(origin1, 6_371_700)).toBeCloseTo(at(origin2, 6_371_700), 6);
    });

    it("packs clouds and wind into the World uniform", () => {
        expect(WORLD_FLOATS).toBe(56);
        const w = packWorld({ sunDir: [0, 1, 0], time: 1, sunColor: [1, 1, 1], exposure: 1, debugLod: false, planets: [],
            weather: { cloudCover: 0.4, cloudOffset: [1, 2, 3], cloudAltitude: 2700, wind: [4, 5, 6] } });
        const base = 16 + MAX_PLANETS * 8;
        expect(Array.from(w.slice(base, base + 8))).toEqual([1, 2, 3, Math.fround(0.4), 4, 5, 6, 2700]);
        expect(Array.from(packWorld({ sunDir: [0, 1, 0], time: 1, sunColor: [1, 1, 1], exposure: 1, debugLod: false, planets: [] }).slice(base))).toEqual(new Array(8).fill(0));
    });
});

describe("foliage in the wind", () => {
    it("bends nothing at the root and most at the top, more for taller plants", () => {
        expect(bendAt(0, 10)).toBe(0);
        expect(bendAt(10, 10)).toBeGreaterThan(bendAt(5, 10));
        expect(bendAt(10, 10)).toBeGreaterThan(bendAt(0.5, 0.5));
        expect(bendAt(30, 30)).toBeLessThan(1);
    });

    it("packs a tree as foliage: leaves flagged, trunk not, and the bend in uv.y's fraction", () => {
        const tree = evaluateObject(lookupObject("nature.tree")!, { density: 3 }, lookupObject);
        const packed = packFoliage(tree, true);
        let leaves = 0, wood = 0, maxBend = 0;
        for (let i = 0; i < packed.vertexData.length; i += 12) {
            expect(Math.floor(packed.vertexData[i + 6])).toBe(MAT_FOLIAGE);
            const code = packed.vertexData[i + 7];
            if (code >= 1) leaves++; else wood++;
            maxBend = Math.max(maxBend, code - Math.floor(code));
            // Low on the trunk hardly moves.
            if (packed.vertexData[i + 1] < 0.3) expect(code - Math.floor(code)).toBeLessThan(0.01);
        }
        expect(leaves).toBeGreaterThan(0);
        expect(wood).toBeGreaterThan(0);
        expect(maxBend).toBeGreaterThan(0.1);
        // Without wind it is ordinary paint.
        expect(Math.floor(packFoliage(tree).vertexData[6])).toBe(11);
    });

    it("moves plants only: rocks and furniture stand still", () => {
        const still = FOLIAGE.filter(f => !sways(f)).map(f => f.family);
        expect(still).toContain("rock");
        expect(still).toContain("cafe-table");
        expect(FOLIAGE.filter(sways).map(f => f.family)).toEqual(expect.arrayContaining(["tree-oak", "conifer", "grass", "shrub", "flowers"]));
    });
});

describe("ground cover", () => {
    // A 20 m building square at the origin and a road along z = 30.
    const building = (x: number, z: number) => Math.abs(x) < 10 && Math.abs(z) < 10;
    const roads = new RoadMask([{ ax: -200, az: 30, bx: 200, bz: 30, half: 4 }]);
    const opts = { walkable: (x: number, z: number) => !building(x, z), roads, origin: { lat: 51.5, lon: -0.12 } };

    it("plants open ground near you: lawn mostly, meadow drifts, a few wildflowers; none on roads or against walls", () => {
        const items = lawnAround(0, 0, opts);
        expect(items.length).toBeGreaterThan(300);
        const count = (f: string) => items.filter(i => i.family === f).length;
        expect(count("lawn")).toBeGreaterThan(count("meadow") * 0.5);
        expect(count("poppies") + count("daisies")).toBeGreaterThan(0);
        expect(count("poppies") + count("daisies")).toBeLessThan(items.length * 0.1);
        for (const it of items) {
            expect(Math.hypot(it.x, it.z)).toBeLessThanOrEqual(LAWN_RADIUS);
            for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) expect(building(it.x + dx, it.z + dz)).toBe(false);
            expect(roads.covers(it.x, it.z, 0.5)).toBe(false);
            expect(FOLIAGE.some(f => f.family === it.family && sways(f))).toBe(true);
        }
    });

    it("finds the same grass where it left it, wherever you stand", () => {
        const a = lawnAround(0, 0, opts), b = lawnAround(15, -8, opts);
        const key = (i: { family: string; x: number; z: number }) => `${i.family}@${i.x.toFixed(4)},${i.z.toFixed(4)}`;
        const inB = new Set(b.map(key));
        const near = a.filter(i => Math.hypot(i.x - 15, i.z + 8) < LAWN_RADIUS - 1);
        expect(near.length).toBeGreaterThan(100);
        expect(near.every(i => inB.has(key(i)))).toBe(true);
    });
});

describe("city surfaces", () => {
    it("names a surface for each kind of Mesha building material", () => {
        expect(surfaceKind("masonry.brick")).toBe(SURFACE.brick);
        expect(surfaceKind("masonry.stucco")).toBe(SURFACE.render);
        expect(surfaceKind("paint.sage")).toBe(SURFACE.render);
        expect(surfaceKind("masonry.concrete")).toBe(SURFACE.concrete);
        expect(surfaceKind("masonry.darkConcrete")).toBe(SURFACE.concrete);
        expect(surfaceKind("stone.sandstone")).toBe(SURFACE.stone);
        expect(surfaceKind("roofing.slate")).toBe(SURFACE.tiles);
        expect(surfaceKind("roofing.seam")).toBe(SURFACE.metal);
        expect(surfaceKind("wood.oak")).toBe(SURFACE.wood);
        expect(surfaceKind("glass.clear")).toBe(SURFACE.plain);
        expect(surfaceKind(undefined)).toBe(SURFACE.plain);
    });

    it("packs a house's walls and roof with their surfaces", () => {
        const house = evaluateObject(lookupObject("architecture.house")!, {}, lookupObject);
        const packed = packHouse(house, 1);
        const kinds = new Set<number>();
        for (let i = 0; i < packed.vertexData.length; i += 12) if (Math.floor(packed.vertexData[i + 6]) === 11) kinds.add(Math.floor(packed.vertexData[i + 7]));
        expect([...kinds].some(k => k !== SURFACE.plain)).toBe(true);
    });
});

describe("shaders", () => {
    it("casts with vs_shadow and receives in group 3 in every Allegiance pipeline; QuadPlanet alone has neither", () => {
        for (const s of [ALLEGIANCE_SHADER, ALLEGIANCE_INSTANCED_SHADER, PEOPLE_SHADER]) {
            expect(s).toContain("fn vs_shadow(");
            expect(s).toContain("@group(3) @binding(0) var shadow_maps: texture_depth_2d_array;");
            expect(s).toContain("fn foliage_sway(");
            expect(s.match(/fn sun_visibility\(/g)!.length).toBe(1);
        }
        expect(ALLEGIANCE_INSTANCED_SHADER).toContain("load_instance(in.instance);\n    out.instance = in.instance;");
        expect(QUADPLANET_SHADER).not.toContain("@group(3)");
        expect(QUADPLANET_SHADER).not.toContain("vs_shadow");
        expect(QUADPLANET_SHADER).toContain("fn sky_clouds(");
        expect(QUADPLANET_SHADER).toContain("fn city_surface(");
    });
});

describe("set dressing costs", () => {
    it("casts ground cover into the nearest cascade, small things into two, trees into all", () => {
        for (const f of ["lawn", "meadow", "poppies", "daisies", "grass", "flowers"]) expect(shadowClass(f)).toBe("ground");
        for (const f of ["shrub", "fern", "rock", "bench", "lamp", "bin", "cafe-chair", "kiosk"]) expect(shadowClass(f)).toBe("small");
        for (const f of ["tree-oak", "conifer", "palm", "mil-hq", "beacon", "flag"]) expect(shadowClass(f)).toBe("tall");
        // Every scatter mesh key leads back to its family (the pipeline is chosen by it).
        for (const spec of FOLIAGE) for (const l of [0, 1, 2] as const) expect(familyOfMesh(foliageKey(spec, l))).toBe(spec.family);
        expect(familyOfMesh(propKey("bench"))).toBe("bench");
        expect(familyOfMesh("something else")).toBeNull();
    });

    it("tiles ground cover finer for culling, and keys meshes without rebuilding strings", () => {
        expect(tileOf("lawn")).toBe(GROUND_TILE);
        expect(tileOf("tree-oak")).toBe(TILE);
        expect(batchKey("m", 40, 10, GROUND_TILE)).not.toBe(batchKey("m", 70, 10, GROUND_TILE));
        expect(batchKey("m", 40, 10)).toBe(batchKey("m", 70, 10));
        // The same string object every time (memoized), equal to the one built from the values.
        const oak = foliageSpec("tree-oak")!;
        expect(scatterMesh("tree-oak", 5)).toBe(foliageKey(oak, 0));
        const values = Object.keys(oak.values).sort().map(k => `${k}=${oak.values[k]}`).join(",");
        expect(foliageKey(oak, 2)).toBe(`allegiance-foliage:3|nature.tree|${values}|lod2`);
    });
});
