// Mesha houses on Earth's OpenStreetMap buildings (src/apps/quadplanet/qp_city.ts), without a
// window: the house parameters a placement gets, the vertex packing per level of detail, and the
// streaming (what gets built, what is drawn at which LOD, and the radius the shader hides house
// boxes within) against a fake engine. The Rust side - tiles, placements, the boxes and roads,
// the mesh cache and simplification - is tested with `cargo test --release --lib`.
import { describe, expect, it } from "vitest";
import { type Vec3, add, scale } from "../src/apps/quadplanet/qp_math";
import {
    CityHouses, HOUSE_NAMESPACE, INTERIOR_REGIONS, MAT_CLEAR_GLASS, MAT_FOUNDATION, MAT_GLASS, MAT_PAINT, houseOrigin, houseRule, houseValues,
    packHouse, variantKey, type CityBuilding, type CityEngine,
} from "../src/apps/quadplanet/qp_city";
import { packWorld, WORLD_FLOATS } from "../src/apps/quadplanet/qp_shader";
import { evaluateObject, objectParamRange, resolveParams } from "../src/apps/mesha/mesha_object";
import { lookupObject } from "../src/apps/mesha/library";
import houseDef from "../src/apps/mesha/library/house";

const UP: Vec3 = [0, 1, 0];

function building(key: string, x: number, z: number, over: Partial<CityBuilding> = {}): CityBuilding {
    return {
        key, seed: [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7), kind: "house",
        anchor: [x, 100, z], right: [1, 0, 0], up: UP, forward: [0, 0, 1],
        width: 11, depth: 9, height: 7, minHeight: 0, groundMin: 100, groundMax: 100.4, area: 99, fill: 1, colour: null, lat: 0, lon: 0, distance: 0,
        ...over,
    };
}

/** An engine whose mesh cache finishes a background put one update later, as the real one would. */
function fakeEngine(list: CityBuilding[]) {
    const cache = new Map<string, { triangles: number }>();
    const pending = new Set<string>();
    const meshes = new Map<string, string>();
    const items = new Map<string, Float32Array>();
    let nextItem = 0;
    const log = { evaluations: 0, puts: [] as { key: string; simplify: boolean; triangles: number }[] };
    const engine: CityEngine = {
        buildings: (p, radius, limit) => list
            .map(b => ({ ...b, distance: Math.hypot(b.anchor[0] - p[0], b.anchor[1] - p[1], b.anchor[2] - p[2]) }))
            .filter(b => b.distance <= radius).sort((a, b) => a.distance - b.distance).slice(0, limit),
        status: (ns, key) => (cache.has(`${ns}/${key}`) ? "ready" : pending.has(`${ns}/${key}`) ? "pending" : "missing"),
        put: (ns, key, mesh, options) => {
            const k = `${ns}/${key}`;
            const triangles = mesh.indexData.length / 3;
            log.puts.push({ key, simplify: !!options?.simplify, triangles });
            if (key.endsWith("lod1")) log.evaluations++;
            // Background puts land on the next update; LOD 1 comes out ~20x smaller.
            pending.add(k);
            queueMicrotask(() => {});
            setPendingDone.push(() => { pending.delete(k); cache.set(k, { triangles: options?.simplify ? Math.ceil(triangles / 20) : triangles }); });
        },
        info: (ns, key) => { const c = cache.get(`${ns}/${key}`); return c ? { triangleCount: c.triangles } : null; },
        createMesh: (ns, key, meshId) => { if (!cache.has(`${ns}/${key}`)) return false; meshes.set(meshId, key); return true; },
        clearMesh: id => { meshes.delete(id); },
        createItem: () => `item${nextItem++}`,
        writeItem: (item, data) => { items.set(item, data); },
        destroyItem: item => { items.delete(item); },
        now: () => 0,
    };
    const setPendingDone: (() => void)[] = [];
    const land = () => { for (const f of setPendingDone.splice(0)) f(); };
    return { engine, cache, meshes, items, log, land };
}

describe("house parameters from a placement", () => {
    it("matches the house model's size range", () => {
        const rule = houseRule();
        const w = houseDef.params.find(p => p.id === "width")!;
        expect(rule.maxWidth).toBe(objectParamRange(houseDef, w, resolveParams(houseDef, {}))[1]);
        expect(rule.minWidth).toBeGreaterThan(7);
        expect(rule.minWidth).toBeLessThan(rule.maxWidth);
        expect(rule.minDepth).toBe(6);
        expect(rule.maxDepth).toBe(16);
    });

    it("is deterministic, rounds the footprint and takes storeys from the height", () => {
        const a = houseValues({ seed: 12345, width: 11.13, depth: 9.38, height: 7 });
        expect(houseValues({ seed: 12345, width: 11.13, depth: 9.38, height: 7 })).toEqual(a);
        expect(a.width).toBe(11);
        expect(a.depth).toBe(9.5);
        expect(a.storeys).toBe(2);
        expect(a.roofVisible).toBe(true);
        expect(houseValues({ seed: 12345, width: 11, depth: 7, height: 9 }).storeys).toBe(1); // no room for a stair
        expect(houseValues({ seed: 12345, width: 11, depth: 12, height: 11 }).storeys).toBe(3);
        // Near-identical footprints share a mesh; different seeds pick different styles.
        expect(variantKey(houseValues({ seed: 1, width: 11.1, depth: 9.4, height: 7 }))).toBe(variantKey(houseValues({ seed: 1, width: 10.9, depth: 9.6, height: 7.2 })));
        const styles = new Set([0, 1, 2, 3, 4, 5].map(seed => variantKey(houseValues({ seed, width: 11, depth: 9, height: 7 }))));
        expect(styles.size).toBeGreaterThan(3);
    });

    it("stands the floor above the highest ground and reaches the foundation to the lowest", () => {
        const { origin, skirt } = houseOrigin({ anchor: [5, 100, 7], up: UP, groundMin: 100, groundMax: 101.5 }, 0.54);
        expect(origin[1] + 0.54).toBeGreaterThan(101.5);
        expect(origin[1] - skirt).toBeLessThan(100);
        const flat = houseOrigin({ anchor: [0, 10, 0], up: UP, groundMin: 10, groundMax: 10 }, 0.54);
        expect(flat.origin).toEqual([0, 10, 0]);
    });
});

describe("packing a house for the QuadPlanet shader", () => {
    const e = evaluateObject(houseDef, houseValues({ seed: 0, width: 11, depth: 9, height: 7 }), lookupObject);
    const lod0 = packHouse(e, 0);
    const lod1 = packHouse(e, 1);
    const materials = (p: typeof lod0) => {
        const m = new Map<number, number>();
        for (let i = 0; i < p.vertexData.length; i += 12) m.set(Math.floor(p.vertexData[i + 6]), (m.get(Math.floor(p.vertexData[i + 6])) ?? 0) + 1);
        return m;
    };

    it("keeps every triangle at LOD 0 and only the outside at LOD 1", () => {
        expect(lod0.triangles).toBe(e.stats.triangles);
        const interior = e.mesh.parts.filter(p => INTERIOR_REGIONS.has(p.region)).reduce((n, p) => n + p.indices.length / 3, 0);
        expect(interior).toBeGreaterThan(0);
        expect(lod1.triangles).toBe(lod0.triangles - interior);
        for (const p of [lod0, lod1]) {
            expect(p.vertexData.length % 12).toBe(0);
            const n = p.vertexData.length / 12;
            expect(p.indexData.every(i => i < n)).toBe(true);
        }
    });

    it("maps Mesha materials to shader materials", () => {
        const m0 = materials(lod0), m1 = materials(lod1);
        expect(m0.get(MAT_PAINT)).toBeGreaterThan(0);
        expect(m0.get(MAT_FOUNDATION)).toBeGreaterThan(0);
        // Window glass is see-through in a full house (there are rooms behind it), opaque far away.
        expect(m0.get(MAT_CLEAR_GLASS)).toBeGreaterThan(0);
        expect(m1.has(MAT_CLEAR_GLASS)).toBe(false);
        expect(m1.get(MAT_GLASS)).toBeGreaterThan(0);
    });

    it("leaves room in the World uniform for the city", () => {
        const w = packWorld({ sunDir: [0, 1, 0], time: 0, sunColor: [1, 1, 1], exposure: 1, debugLod: false, planets: [], city: { hideRadius: 123, roadDistance: 2500 } });
        expect(w.length).toBe(WORLD_FLOATS);
        expect([...w.slice(44, 46)]).toEqual([123, 2500]);
    });
});

describe("streaming houses", () => {
    // A street of houses every 20 m along +X, the camera at the first.
    const street = Array.from({ length: 30 }, (_, i) => building(`h${i}`, i * 20, (i % 2) * 15, { seed: i % 2, width: 11 + (i % 3) * 0.1 }));
    const camera: Vec3 = [0, 101.8, 0];

    it("builds nearest first, at most one house per frame, and hides only boxes whose house is drawn", () => {
        const f = fakeEngine(street);
        const city = new CityHouses(f.engine, { lod0Radius: 45, maxLod0: 3, lod1Radius: 300 });
        let hide = city.update(camera, [0, 0, 0], 1, 12);
        expect(f.log.evaluations).toBe(1);
        expect(hide).toBeLessThan(1.8); // nothing drawn yet: every box stays (the nearest is 1.8 m away)
        f.land();
        for (let frame = 0; frame < 10; frame++) { hide = city.update(camera, [0, 0, 0], 1, 12); f.land(); }
        // Two styles alternate and the widths round together: just two meshes for the street.
        expect(f.log.evaluations).toBe(2);
        hide = city.update(camera, [0, 0, 0], 1, 12);
        const s = city.lastStats;
        expect(s.lod0).toBe(3);
        expect(s.lod1).toBe(street.filter(b => Math.hypot(b.anchor[0], b.anchor[2]) < 300).length - 3);
        expect(f.meshes.size).toBe(s.lod0 + s.lod1);
        // Everything within 300 m is drawn; the first house that isn't is the hide radius.
        const firstUndrawn = Math.min(...street.map(b => Math.hypot(b.anchor[0] - camera[0], b.anchor[1] - camera[1], b.anchor[2] - camera[2])).filter(d => d >= 300));
        expect(hide).toBeCloseTo(firstUndrawn, 1);
        // LOD 1 was asked to be simplified; LOD 0 was not.
        expect(f.log.puts.filter(p => p.key.endsWith("lod1")).every(p => p.simplify)).toBe(true);
        expect(f.log.puts.filter(p => p.key.endsWith("lod0")).every(p => !p.simplify)).toBe(true);
        expect(f.log.puts.every(p => p.key.startsWith("architecture.house:"))).toBe(true);
        void HOUSE_NAMESPACE;
    });

    it("never hides a box beyond a house it is still waiting for", () => {
        const f = fakeEngine(street);
        const city = new CityHouses(f.engine, { lod0Radius: 0, maxLod0: 0, lod1Radius: 300 });
        city.update(camera, [0, 0, 0], 1, 12);
        f.land();
        const hide = city.update(camera, [0, 0, 0], 1, 12);
        // One style is ready, the other isn't: the nearest house of the other style bounds it.
        const waiting = street.filter(b => b.seed === 1).map(b => Math.hypot(b.anchor[0] - camera[0], b.anchor[1] - camera[1], b.anchor[2] - camera[2]));
        expect(hide).toBeLessThanOrEqual(Math.min(...waiting));
        // No house is close enough for its full model: the heavy LOD 0 is never written.
        expect(f.log.puts.some(p => p.key.endsWith("lod0"))).toBe(false);
        expect(f.log.puts.length).toBeGreaterThan(0);
    });

    it("swaps LODs as the camera moves and moves houses with the render origin", () => {
        const f = fakeEngine(street);
        const city = new CityHouses(f.engine, { lod0Radius: 45, maxLod0: 3, lod1Radius: 300 });
        for (let frame = 0; frame < 6; frame++) { city.update(camera, [0, 0, 0], 1, Infinity); f.land(); }
        city.update(camera, [0, 0, 0], 1, Infinity);
        expect([...f.meshes.keys()].filter(id => id.startsWith("qp-house:h0:")).map(id => id.slice(-1))).toEqual(["0"]);
        const far: Vec3 = add(camera, [400, 0, 0]);
        city.update(far, [0, 0, 0], 1, Infinity);
        expect([...f.meshes.keys()].some(id => id.startsWith("qp-house:h0:"))).toBe(false); // ~400 m away now: a box
        expect([...f.meshes.keys()].filter(id => id.startsWith("qp-house:h20:")).map(id => id.slice(-1))).toEqual(["0"]);
        // Rebasing the render origin rewrites each drawn house's placement.
        const shown = [...f.items.entries()];
        city.update(far, [100, 0, 0], 1, Infinity);
        const moved = [...f.items.entries()].find(([k]) => k === shown[0][0])!;
        expect(moved[1][12]).toBeCloseTo(shown[0][1][12] - 100, 3);
        // The item matrix carries the house frame, and its tex origin's w the foundation skirt.
        expect([...moved[1].slice(0, 3)]).toEqual([1, 0, 0]);
        expect(moved[1][23]).toBeGreaterThan(0.3);
        expect(scale(UP, 1)).toEqual(UP);
    });

    it("keeps within the triangle budget", () => {
        const f = fakeEngine(street);
        const city = new CityHouses(f.engine, { lod0Radius: 45, maxLod0: 3, lod1Radius: 300, triangleBudget: 50_000 });
        for (let frame = 0; frame < 6; frame++) { city.update(camera, [0, 0, 0], 1, Infinity); f.land(); }
        city.update(camera, [0, 0, 0], 1, Infinity);
        expect(city.lastStats.triangles).toBeLessThanOrEqual(50_000);
        expect(city.lastStats.lod0 + city.lastStats.lod1).toBeGreaterThan(0);
    });
});

describe("house streaming costs", () => {
    const street = Array.from({ length: 12 }, (_, i) => building(`c${i}`, i * 20, 0, { seed: i % 2, width: 11 }));
    const camera: Vec3 = [0, 101.8, 0];

    it("does no work for a still camera once its street is finished", () => {
        const f = fakeEngine(street);
        let calls = 0, status = 0;
        const engine: CityEngine = { ...f.engine, buildings: (...a) => { calls++; return f.engine.buildings(...a); }, status: (...a) => { status++; return f.engine.status(...a); } };
        const city = new CityHouses(engine, { lod0Radius: 45, maxLod0: 3, lod1Radius: 300 });
        for (let frame = 0; frame < 12; frame++) { city.update(camera, [0, 0, 0], 1, 12); f.land(); }
        const before = { calls, status, meshes: f.meshes.size, stats: city.lastStats };
        expect(city.busy()).toBe(false);
        for (let frame = 0; frame < 5; frame++) city.update(camera, [0, 0, 0], 1, 12);
        expect({ calls, status, meshes: f.meshes.size, stats: city.lastStats }).toEqual(before);
        expect(city.lastStats).toBe(before.stats);
        // Moving, a rebase or new city data still update.
        city.update([0, 101.8, 2], [0, 0, 0], 1, 12);
        expect(city.lastStats).not.toBe(before.stats);
        const moved = city.lastStats;
        city.update([0, 101.8, 2], [10, 0, 0], 1, 12);
        expect(city.lastStats).not.toBe(moved);
    });

    it("spaces Mesha evaluations by minBuildIntervalMs", () => {
        const f = fakeEngine(street.map((b, i) => ({ ...b, seed: i, width: 8 + i * 0.5 })));
        let now = 0;
        const city = new CityHouses({ ...f.engine, now: () => now }, { lod0Radius: 0, maxLod0: 0, lod1Radius: 300, minBuildIntervalMs: 250 });
        for (let frame = 0; frame < 10; frame++) { city.update(camera, [0, 0, 0], 1, 12); now += 16; }
        // 160 ms of frames: the first evaluation, then none until 250 ms have passed.
        expect(f.log.evaluations).toBe(1);
        for (let frame = 0; frame < 10; frame++) { city.update(camera, [0, 0, 0], 1, 12); now += 16; }
        expect(f.log.evaluations).toBe(2);
    });
});
