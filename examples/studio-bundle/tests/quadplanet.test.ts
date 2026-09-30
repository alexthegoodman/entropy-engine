// QuadPlanet's TypeScript tier: the walker/ship/autopilot simulation, Earth travel helpers and the
// render data, without a window. The terrain itself (cube-sphere quadtree, chunk meshes,
// streaming, procedural and Earth heights) is Rust now, tested with
// `cargo test --release --lib QuadPlanet`; here it is a smooth stand-in behind the same
// TerrainBackend the addon points at Entropy.QuadPlanet. The live tier (the real app, keys and
// screenshots) is tests/quadplanet_live.rs driving tests/features/quadplanet_live.feature.
import { describe, expect, it } from "vitest";
import { type Vec3, add, cross, distance, dot, length, normalize, sub, bezier } from "../src/apps/quadplanet/qp_math";
import {
    PLANETS, SUN_DIRECTION, altitudeAboveGround, surfacePoint, setTerrainBackend, maxRelief, latLonToDir, dirToLatLon, morningSunAt,
    findLandmark, isEarth, type PlanetDef, type SurfaceSample, type TerrainBackend,
} from "../src/apps/quadplanet/qp_planet";
import { EARTH_CHUNK_DETAIL, DEFAULT_CHUNK_DETAIL } from "../src/apps/quadplanet/qp_config";
import {
    NO_INPUT, BOARD_DISTANCE, arriveAt, cameraPose, initialState, interact, planAutopilot, readout, startAutopilot, step, upAt, autopilotEase,
} from "../src/apps/quadplanet/qp_sim";
import { packWorld, WORLD_FLOATS, MAX_PLANETS } from "../src/apps/quadplanet/qp_shader";
import { buildShip, buildSky, buildWalkerBody } from "../src/apps/quadplanet/qp_models";
/** Floats per vertex in the engine's layout: position, normal, uv, color. */
const VERTEX_FLOATS = 12;

/**
 * Rolling ground (tens of meters of relief over a few hundred meters) with a polar sea on the
 * planets that have one: enough terrain for walking, jumping, landing and flying.
 */
const RELIEF = 40;
const standIn: TerrainBackend = {
    sample(p: PlanetDef, d: Vec3): SurfaceSample {
        const k = p.radius / 400;
        const terrain = 12 + 10 * Math.sin(d[0] * k) * Math.cos(d[2] * k * 0.8) + 8 * Math.sin(d[1] * k * 1.3);
        const sea = p.hasSea && d[1] < -0.95;
        return sea ? { terrain: -50, surface: 0, sea: true, rock: 0, patch: 0 } : { terrain, surface: terrain, sea: false, rock: 0, patch: 0 };
    },
    normal(p, d, stepSize) {
        const up = normalize(d);
        const t1 = normalize(cross(Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], up));
        const t2 = cross(up, t1);
        const at = (a: number, b: number): Vec3 => {
            const dd = normalize(add(up, add(t1.map(x => x * a / p.radius) as Vec3, t2.map(x => x * b / p.radius) as Vec3)));
            return dd.map(x => x * (p.radius + this.sample(p, dd).surface)) as Vec3;
        };
        const n = normalize(cross(sub(at(stepSize, 0), at(-stepSize, 0)), sub(at(0, stepSize), at(0, -stepSize))));
        return dot(n, up) < 0 ? n.map(x => -x) as Vec3 : n;
    },
    landingSite(p, preferred) {
        const d = normalize(preferred);
        return this.sample(p, d).sea ? [0, 1, 0] : d;
    },
    maxRelief: () => RELIEF,
};
setTerrainBackend(standIn);

const verdant = PLANETS[0];
const EARTH = PLANETS.findIndex(isEarth);
const DT = 1 / 30;
const walkOn = (id: number) => ({ ...NO_INPUT, forward: id === 0 });

describe("the planets", () => {
    it("include Earth at its real size, with real terrain and 20 levels of detail", () => {
        const earth = PLANETS[EARTH];
        expect(earth.name).toBe("Earth");
        expect(earth.radius).toBe(6_371_000);
        expect(earth.terrain).toEqual({ kind: "earth" });
        expect(earth.chunkDetail).toBe(EARTH_CHUNK_DETAIL);
        expect(EARTH_CHUNK_DETAIL.mode === "explicit" && EARTH_CHUNK_DETAIL.verticesPerLevel.length).toBe(20);
        // Leaf chunks as fine as Verdant's: ~19 m, with 64 vertices a side.
        const leaf = 2 / 2 ** 19 * earth.radius * Math.PI / 4;
        expect(leaf).toBeGreaterThan(15);
        expect(leaf).toBeLessThan(25);
        // Far enough out to fit between the small planets' orbits, near enough to see from them.
        for (const p of PLANETS.slice(0, EARTH)) expect(distance(p.center, earth.center) - earth.radius - p.radius).toBeGreaterThan(5_000_000);
    });

    it("keep the procedural planets' detail settings", () => {
        expect(DEFAULT_CHUNK_DETAIL?.mode).toBe("explicit");
        expect(PLANETS.filter(p => !isEarth(p)).every(p => p.chunkDetail === undefined)).toBe(true);
    });
});

describe("geography", () => {
    it("maps latitude and longitude with north up and east to the right", () => {
        for (const [lat, lon] of [[0, 0], [45, 90], [-33.9, 151.2], [27.99, 86.93]]) {
            const back = dirToLatLon(latLonToDir(lat, lon));
            expect(back.lat).toBeCloseTo(lat, 9);
            expect(back.lon).toBeCloseTo(lon, 9);
        }
        expect(latLonToDir(0, 90)[0]).toBeCloseTo(1, 12);
        expect(latLonToDir(90, 0)[1]).toBeCloseTo(1, 12);
    });

    it("puts the morning sun 35 degrees up in the east", () => {
        const d = latLonToDir(46, 7.6);
        const sun = morningSunAt(d);
        expect(dot(sun, d)).toBeCloseTo(Math.sin(35 * Math.PI / 180), 9);
        const east = latLonToDir(46, 7.7);
        expect(dot(sun, sub(east, d))).toBeGreaterThan(0);
    });

    it("knows a few landmarks without a network", () => {
        expect(findLandmark("Matterhorn")?.lat).toBeCloseTo(45.9763, 3);
        expect(findLandmark("mount everest")?.name).toBe("Mount Everest");
        expect(findLandmark("Atlantis")).toBeUndefined();
    });

    it("sets you down on Earth with the ship beside you", () => {
        const s = initialState();
        arriveAt(s, EARTH, latLonToDir(45.9763, 7.6586));
        const earth = PLANETS[EARTH];
        expect(s.walker.planet).toBe(EARTH);
        expect(readout(s).planet).toBe("Earth");
        expect(Math.abs(altitudeAboveGround(earth, s.walker.pos))).toBeLessThan(0.01);
        expect(readout(s).shipDistance).toBeGreaterThan(BOARD_DISTANCE);
        expect(readout(s).shipDistance).toBeLessThan(20);
        const { lat, lon } = dirToLatLon(sub(s.walker.pos, earth.center));
        expect(lat).toBeCloseTo(45.9763, 3);
        expect(lon).toBeCloseTo(7.6586, 3);
        expect(s.visited).toContain("earth");
    });

    it("stands you on the exact spot you asked for, the ship parked close by", () => {
        const s = initialState();
        const peak = latLonToDir(45.9763, 7.6586);
        arriveAt(s, EARTH, peak, PLANETS, true);
        const { lat, lon } = dirToLatLon(sub(s.walker.pos, PLANETS[EARTH].center));
        expect(lat).toBeCloseTo(45.9763, 9);
        expect(lon).toBeCloseTo(7.6586, 9);
        expect(readout(s).shipDistance).toBeGreaterThan(5);
        expect(readout(s).shipDistance).toBeLessThan(40);
    });
});

describe("walking", () => {
    it("starts on dry ground a short walk from the parked ship, in daylight", () => {
        const s = initialState();
        const r = readout(s);
        expect(r.mode).toBe("walk");
        expect(r.grounded).toBe(true);
        expect(r.shipDistance).toBeGreaterThan(BOARD_DISTANCE);
        expect(r.shipDistance).toBeLessThan(20);
        expect(dot(upAt(verdant, s.walker.pos), SUN_DIRECTION)).toBeGreaterThan(0.3);
    });

    it("follows the curved ground and gets you to the ship", () => {
        const s = initialState();
        const before = s.walker.pos;
        for (let i = 0; i < 40; i++) step(s, walkOn(0), DT);
        expect(s.walked).toBeCloseTo(40 * DT * 5, 5);
        expect(distance(before, s.walker.pos)).toBeGreaterThan(5);
        expect(Math.abs(altitudeAboveGround(verdant, s.walker.pos))).toBeLessThan(0.05);
        expect(readout(s).shipDistance).toBeLessThan(BOARD_DISTANCE);
    });

    it("jumps and lands again, pulled toward the planet's center", () => {
        const s = initialState();
        step(s, { ...NO_INPUT, up: true }, DT);
        let peak = 0;
        for (let i = 0; i < 60; i++) {
            step(s, NO_INPUT, DT);
            peak = Math.max(peak, altitudeAboveGround(verdant, s.walker.pos));
        }
        expect(peak).toBeGreaterThan(1);
        expect(s.walker.grounded).toBe(true);
    });

    it("works upside down: on the far side, up is away from the center", () => {
        const s = initialState();
        const south: Vec3 = normalize([0.3, -0.8, 0.2]);
        s.walker.pos = surfacePoint(verdant, south);
        s.walker.forward = normalize(cross(south, [1, 0, 0]));
        for (let i = 0; i < 30; i++) step(s, walkOn(0), DT);
        expect(Math.abs(altitudeAboveGround(verdant, s.walker.pos))).toBeLessThan(0.05);
        const pose = cameraPose(s);
        expect(dot(pose.up, upAt(verdant, s.walker.pos))).toBeCloseTo(1, 6);
        expect(altitudeAboveGround(verdant, pose.position)).toBeGreaterThan(0.5);
    });
});

describe("the ship", () => {
    function boarded() {
        const s = initialState();
        for (let i = 0; i < 40; i++) step(s, walkOn(0), DT);
        expect(interact(s)).toBe("boarded");
        return s;
    }

    it("can't be boarded from across the field", () => {
        const s = initialState();
        expect(interact(s)).toBe("too-far");
        expect(s.mode).toBe("walk");
    });

    it("lifts off, flies, and sets down again", () => {
        const s = boarded();
        for (let i = 0; i < 45; i++) step(s, { ...NO_INPUT, up: true }, DT);
        expect(readout(s).altitude).toBeGreaterThan(15);
        expect(s.ship.landed).toBe(false);
        expect(interact(s)).toBe("airborne");
        for (let i = 0; i < 600 && !s.ship.landed; i++) step(s, { ...NO_INPUT, down: true }, DT);
        expect(s.ship.landed).toBe(true);
        expect(interact(s)).toBe("exited");
        expect(s.mode).toBe("walk");
    });

    it("autopilots to every other planet, Earth included, on a path clear of all of them", () => {
        for (let target = 1; target < PLANETS.length; target++) {
            const s = boarded();
            const plan = planAutopilot(s, target);
            for (let k = 1; k < 100; k++) {
                const t = k / 100;
                const q = bezier(plan.p0, plan.p1, plan.p2, plan.p3, t);
                PLANETS.forEach((p, i) => {
                    if ((i === 0 && t < 0.12) || (i === target && t > 0.88)) return;
                    expect(distance(q, p.center)).toBeGreaterThan(p.radius + maxRelief(p));
                });
            }
            expect(startAutopilot(s, target)).not.toBeNull();
            let frames = 0;
            while (s.ship.autopilot && frames++ < 2000) step(s, NO_INPUT, DT);
            const r = readout(s);
            expect(r.planet).toBe(PLANETS[target].name);
            expect(r.landed).toBe(true);
            expect(Math.abs(r.altitude)).toBeLessThan(0.01);
            expect(dot(upAt(PLANETS[target], s.ship.pos), SUN_DIRECTION)).toBeGreaterThan(0);
            expect(interact(s)).toBe("exited");
            expect(s.visited).toContain(PLANETS[target].id);
        }
    });

    it("flies the autopilot to a chosen place on Earth", () => {
        const s = boarded();
        const site = latLonToDir(36.0572, -112.1393);
        expect(startAutopilot(s, EARTH, PLANETS, site)).not.toBeNull();
        let frames = 0;
        while (s.ship.autopilot && frames++ < 2000) step(s, NO_INPUT, DT);
        const { lat, lon } = dirToLatLon(sub(s.ship.pos, PLANETS[EARTH].center));
        expect(readout(s).planet).toBe("Earth");
        expect(lat).toBeCloseTo(36.0572, 3);
        expect(lon).toBeCloseTo(-112.1393, 3);
    });

    it("eases in and out", () => {
        expect(autopilotEase(0)).toBe(0);
        expect(autopilotEase(1)).toBe(1);
        expect(autopilotEase(0.5)).toBeCloseTo(0.5, 9);
        expect(autopilotEase(0.05)).toBeLessThan(0.01);
    });
});

describe("rendering data", () => {
    it("packs the world uniform in the shader's layout, room for every planet", () => {
        expect(PLANETS.length).toBeLessThanOrEqual(MAX_PLANETS);
        const w = packWorld({ sunDir: [0, 1, 0], time: 2, sunColor: [1, 1, 1], exposure: 1, debugLod: true, planets: PLANETS.map(p => ({ center: p.center, radius: p.radius, atmosphere: p.atmosphereColor, atmosphereHeight: p.atmosphereHeight })) });
        expect(w.length).toBe(WORLD_FLOATS);
        expect([...w.slice(8, 12)]).toEqual([1, 1, PLANETS.length, 0]);
        expect(w[12 + 4 + 3]).toBe(PLANETS[1].radius);
        expect(w[12 + MAX_PLANETS * 4 + 3]).toBe(PLANETS[0].atmosphereHeight);
        expect(w[12 + MAX_PLANETS * 4 + EARTH * 4 + 3]).toBe(PLANETS[EARTH].atmosphereHeight);
    });

    it("builds closed, outward-facing models and an inward-facing sky", () => {
        for (const model of [buildShip(), buildWalkerBody()]) {
            expect(model.vertexData.length % VERTEX_FLOATS).toBe(0);
            expect(Math.max(...model.indexData)).toBeLessThan(model.vertexData.length / VERTEX_FLOATS);
        }
        const sky = buildSky();
        const vert = (i: number): Vec3 => [sky.vertexData[i * VERTEX_FLOATS], sky.vertexData[i * VERTEX_FLOATS + 1], sky.vertexData[i * VERTEX_FLOATS + 2]];
        let inward = 0, total = 0;
        for (let t = 0; t < sky.indexData.length; t += 3) {
            const [a, b, c] = [0, 1, 2].map(k => vert(sky.indexData[t + k]));
            const n = cross(sub(b, a), sub(c, a));
            if (length(n) < 1e-9) continue;
            total++;
            if (dot(n, a) < 0) inward++;
        }
        expect(inward).toBe(total);
    });
});
